'use strict'

const { goals } = require('mineflayer-pathfinder')
const { NEED_LOGS } = require('../goal')
const { countItems } = require('../perception')

// craft: logs -> planks -> crafting table -> door, one op per tick, async
// with ctx.craftInFlight (same shape as eatInFlight). Registered in
// BEHAVIOURS under 'craft' so the goal arbiter can pick it. Reports via
// ctx.stepStatus. Uses the built-in bot.recipesFor/bot.craft (2x2 grid
// without a table, 3x3 at a placed table block).
// Priority matches feasible(craft) in goal.js exactly: logs>0 crafts even
// a single log (planks are never wasted — the budget needs them all);
// table only when missing everywhere; door only at a placed table.
// A placed table appears only via ctx.home.table (the build step places
// it): a table sitting in the inventory does not unlock the door.
const TABLE_REACH = 4

function tally(bot, suffix) {
  const m = new Map()
  let items = []
  try { items = (bot.inventory && typeof bot.inventory.items === 'function' && bot.inventory.items()) || [] } catch (_) { return m }
  for (const i of items) {
    if (!i || typeof i.name !== 'string' || !i.name.endsWith(suffix)) continue
    const wood = i.name.slice(0, -suffix.length)
    m.set(wood, (m.get(wood) || 0) + (typeof i.count === 'number' ? i.count : 1))
  }
  return m
}

function sortedWoods(m) {
  return [...m.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
}

function itemId(bot, name) {
  const entry = bot.registry && bot.registry.itemsByName && bot.registry.itemsByName[name]
  return entry && typeof entry.id === 'number' ? entry.id : null
}

function recipes(bot, name, table) {
  const id = itemId(bot, name)
  if (id == null || typeof bot.recipesFor !== 'function') return []
  try {
    return bot.recipesFor(id, null, 1, table || null) || []
  } catch (_) {
    return []
  }
}

function dist3(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)
}

function totals(bot) {
  return { logs: countItems(bot, (n) => n.endsWith('_log')), planks: countItems(bot, (n) => n.endsWith('_planks')) }
}

function fail(ctx, item, err) {
  ctx.stepStatus = `failed:craft-${item}`
  try {
    console.error(`craft failed item=${item} error=${err && err.message ? err.message : err}`)
  } catch (_) { /* logging best-effort */ }
}

// gxk: the 2x2 grid hangs bot.craft once an ingredient strands in it.
// mineflayer waits for updateSlot:0 after every click on slots 0..4, but the
// server only sends slot 0 when the result changes — a second log placed
// while planks are already shown stays silent, the op times out after 20 s,
// and the log strands in the grid, invisible to inventory.items() (slots
// 9..44 only). Every later 2x2 craft times out the same way while logs churn
// 14->13 per attempt, looping gather<->craft forever.
const GRID_2X2 = [1, 2, 3, 4]

// Consecutive updateSlot-timeout streak per bot: a repeated silence means the
// model and the server disagree beyond a strandable grid, so the second one
// in a row asks for a full resync. Any success resets the streak.
const gridTimeouts = new WeakMap()

function isSlotTimeout(err) {
  const msg = err && err.message ? String(err.message) : String(err)
  return msg.includes('did not fire within timeout')
}

// Return stranded 2x2 ingredients (and the cursor stack) to the inventory.
// Best-effort per slot and silent-safe: a clearing click whose result is
// unchanged stays silent server-side exactly like the craft click did, so its
// timeout is swallowed — the click itself still applied and the ingredient
// moved. No-ops on slot-less mocks (unit tests without a window model).
// A healthy click answers in a server round-trip; a silent one (result
// unchanged) would eat the full 20 s mineflayer wait. Moving on after 2 s is
// correct — the click was sent and applied at once, only the event is
// missing — and bounds a 4-slot clear to ~8 s, inside equip's 30 s deadline.
const CLEAR_CLICK_BUDGET_MS = 2000

async function budgetedClick(bot, slot) {
  let timer = null
  const budget = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('clear-budget')), CLEAR_CLICK_BUDGET_MS)
    if (timer && typeof timer.unref === 'function') timer.unref()
  })
  try {
    await Promise.race([bot.clickWindow(slot, 0, 1), budget])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function clearGrid(bot) {
  const win = bot && bot.inventory
  if (!win || !Array.isArray(win.slots)) return
  try {
    if (win.selectedItem && typeof bot.putSelectedItemRange === 'function') {
      const start = typeof win.inventoryStart === 'number' ? win.inventoryStart : 9
      const end = typeof win.inventoryEnd === 'number' ? win.inventoryEnd : 45
      await bot.putSelectedItemRange(start, end, win, null)
    }
  } catch (_) { /* cursor homeless: the craft below fails loudly instead */ }
  if (typeof bot.clickWindow !== 'function') return
  for (const slot of GRID_2X2) {
    let item = null
    try { item = win.slots[slot] } catch (_) { item = null }
    if (!item) continue
    try {
      await budgetedClick(bot, slot) // shift-click: grid -> inventory
    } catch (_) { /* silent server (result unchanged): the move still applied */ }
  }
}

// Shared 2x2-safe wrapper (craft.js and equip.js): clear the grid before the
// op and again after any error, so a stranded ingredient returns to items()
// instead of churning the log count; on a repeated slot timeout close the
// bare inventory window so the server resyncs the model. Table (3x3) crafts
// pass through untouched — mineflayer closes the table window on error itself.
// Same-name ingredients the pre-clear is about to return: grid slots 1..4
// plus the cursor stack. Sizes the planks batch so a dirty grid converts
// fully inside one step. Slot-less mocks read 0.
function strandedCount(bot, name) {
  let n = 0
  try {
    const win = bot && bot.inventory
    if (win && Array.isArray(win.slots)) {
      for (const s of GRID_2X2) {
        const it = win.slots[s]
        if (it && it.name === name) n += typeof it.count === 'number' ? it.count : 1
      }
      const cur = win.selectedItem
      if (cur && cur.name === name) n += typeof cur.count === 'number' ? cur.count : 1
    }
  } catch (_) { /* unreadable window: no bonus */ }
  return n
}

async function safeCraft(bot, recipe, count, table) {
  if (!table) await clearGrid(bot)
  try {
    await bot.craft(recipe, count, table)
  } catch (err) {
    if (!table) {
      await clearGrid(bot)
      if (isSlotTimeout(err)) {
        const n = (gridTimeouts.get(bot) || 0) + 1
        gridTimeouts.set(bot, n)
        if (n >= 2 && !bot.currentWindow && typeof bot.closeWindow === 'function') {
          try { await bot.closeWindow(bot.inventory) } catch (_) { /* resync best-effort */ }
        }
      }
    }
    throw err
  }
  if (!table) gridTimeouts.set(bot, 0)
}

function craft(bot, ctx, target, state) {
  if (ctx.craftInFlight) return // exactly one op at a time (mutation: a craft every tick overlaps windows)
  const bp = bot.entity && bot.entity.position
  if (!bp) return
  const logs = tally(bot, '_log')
  const planks = tally(bot, '_planks')
  // The equip step's placed station doubles (atl.6): without it a placed
  // table the menu knows (tablePlaced) still reads as no station here, and
  // the table branch below rebuilds one from planks every cycle. Verified
  // once: a ghost claim (mined table) reads as no station, so the table
  // branch rebuilds instead of the door branch walking to nothing forever.
  const tablePos = (ctx.home && ctx.home.table) || (ctx && ctx.claimedTable)
  let tableBlock = null
  if (tablePos) {
    try { tableBlock = bot.blockAt && bot.blockAt(tablePos) } catch (_) { tableBlock = null }
    if (!tableBlock || tableBlock.name !== 'crafting_table') tableBlock = null
  }
  let op = null
  for (const [wood, n] of sortedWoods(logs)) {
    const name = `${wood}_planks`
    const found = recipes(bot, name, null)
    if (found.length > 0) { op = { item: name, recipe: found[0], count: n + strandedCount(bot, `${wood}_log`), table: null }; break } // batch = visible stack + stranded (run() still calls bot.craft with count=1)
  }
  if (!op) {
    const tableCount = countItems(bot, (n) => n === 'crafting_table')
    if (tableCount === 0 && !tableBlock) {
      for (const [wood, n] of sortedWoods(planks)) {
        if (n < 4) break
        const found = recipes(bot, 'crafting_table', null)
        if (found.length > 0) { op = { item: 'crafting_table', recipe: found[0], count: 1, table: null }; break }
      }
    }
  }
  if (!op) {
    const doorCount = countItems(bot, (n) => n.endsWith('_door'))
    if (doorCount === 0 && tableBlock) {
      if (dist3(bp, tablePos) <= TABLE_REACH) {
        for (const [wood, n] of sortedWoods(planks)) {
          if (n < 6) break
          const name = `${wood}_door`
          const found = recipes(bot, name, tableBlock)
          if (found.length > 0) { op = { item: name, recipe: found[0], count: 1, table: tableBlock }; break }
        }
      } else {
        const key = `craft-table:${tablePos.x},${tablePos.y},${tablePos.z}`
        if (key !== ctx.lastGoalKey) {
          bot.pathfinder.setGoal(new goals.GoalNear(tablePos.x, tablePos.y, tablePos.z, 3), false)
          ctx.lastGoalKey = key
        }
        return // walk into reach, then craft on a later tick
      }
    }
  }
  if (!op) {
    let total = 0
    let first = null
    for (const [wood, n] of sortedWoods(logs)) {
      total += n
      if (!first) first = wood
    }
    if (total >= NEED_LOGS && first) {
      fail(ctx, `${first}_planks`, new Error('no planks recipe for this wood'))
      return
    }
    ctx.stepStatus = 'done'
    return
  }
  if (typeof bot.craft !== 'function') {
    fail(ctx, op.item, new Error('bot.craft missing'))
    return
  }
  ctx.craftInFlight = true
  const run = async () => {
    try {
      // Batch at step level, one log per call: a single bot.craft(count=n)
      // dies on the first silent click and strands the rest, while one op per
      // log re-decides to gather at 13 logs. craftInFlight holds the step for
      // the whole batch (goal.js), so mid-batch churn never re-decides.
      for (let i = 0; i < op.count; i++) {
        await safeCraft(bot, op.recipe, 1, op.table)
      }
    } catch (err) {
      ctx.craftInFlight = false
      fail(ctx, op.item, err)
      return
    }
    ctx.craftInFlight = false
    const t = totals(bot)
    const made = op.count * ((op.recipe.result && op.recipe.result.count) || 1)
    try { bot.chat(`crafted ${made} ${op.item} (planks ${t.planks}, logs ${t.logs})`) } catch (_) { /* chat best-effort */ }
  }
  void run()
}

module.exports = craft
// Shared crafting primitives for the equip step (atl.6): recipe lookup and
// the table reach. Same dual-export shape as fight.equipGear.
module.exports.itemId = itemId
module.exports.recipes = recipes
module.exports.tally = tally
module.exports.sortedWoods = sortedWoods
module.exports.TABLE_REACH = TABLE_REACH
module.exports.safeCraft = safeCraft
