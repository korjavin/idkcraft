'use strict'

const { goals } = require('mineflayer-pathfinder')
const Vec3 = require('vec3')
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
    // ref'd on purpose: cleared in finally below; unref'd it never fires on Node 22
    // when the click is the only thing pending (CI hang, 6x7.5)
    timer = setTimeout(() => reject(new Error('clear-budget')), CLEAR_CLICK_BUDGET_MS)
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

// xg9: consecutive window ops must stay a server tick apart. Fired
// back-to-back (0-8 ms), clicks desync mineflayer's inventory model from
// Paper: a later click waits on updateSlot:0 the server never sends that
// way, the op eats the 20 s timeout, and items strand server-side while
// the model marches on (assayed: unpaced 64-log batch broke at op27 with
// a phantom button + vanishing logs; paced 60 ms went 64/64 exact). A
// vanilla client can never click sub-tick either. Applies to table crafts
// too — the gear epic will batch those. Cost: ~60 ms per op.
const WINDOW_OP_GAP_MS = 60
const lastWindowOp = new WeakMap()

async function paceWindowOp(bot) {
  let prev = 0
  try { prev = lastWindowOp.get(bot) || 0 } catch (_) { prev = 0 }
  const wait = WINDOW_OP_GAP_MS - (Date.now() - prev)
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait))
}

// ph7: the phantom table craft. mineflayer picks the FIRST inventory stack
// of each ingredient whatever its size; when it is smaller than the op's
// placement count the cursor runs dry mid-op, a placement goes out on an
// empty server cursor (or the mid-op re-pickup races the pipelined
// placements), the grid never completes, the result grab takes nothing — and
// the op still resolves, because the updateSlot:0 waits are satisfied by
// echo/resync traffic, never by the click's own effect. Assayed live on
// Paper 26.1.2: 28/28 single-pickup door ops landed, 2/2 partial-first-stack
// ops phantomed (server grid missing one plank, mats unspent, no product),
// and the retry lands on a fresh full stack. ensureStacks consolidates each
// ingredient into its first-picked stack before delegating: with the whole
// need in one stack the cursor cannot run dry and the first op lands.
// Fail-open by design: anything unexpected skips consolidation and bot.craft
// behaves exactly as before.
const CONSOLIDATE_ROUNDS = 2
// ponytail: _syncWindow answers in ~1 RTT (the mismatch resync is the
// server's immediate reply); 3 s is the give-up for a dead link, after which
// the op runs unverified exactly as before.
const CONSOLIDATE_SYNC_MS = 3000
// ponytail: fallback when bot._syncWindow is missing (old mineflayer): read
// the model after trailing resyncs had time to land (~RTT; 250 ms covers
// LAN + spikes — raise if phantoms recur on high-RTT links).
const CONSOLIDATE_SETTLE_MS = 250

// Placements per distinct ingredient, mirroring mineflayer's clickShape +
// nextIngredientsClick exactly: shaped cells with id !== -1 plus every
// shapeless entry (a recipe may carry both — clickShape falls through),
// times the op count (iterations re-pick the same first stack).
function placementsFor(recipe, count) {
  const needs = new Map()
  const add = (id, metadata) => {
    if (typeof id !== 'number' || id === -1) return
    const key = `${id}\0${metadata == null ? '' : metadata}`
    const cur = needs.get(key)
    if (cur) cur.need += 1
    else needs.set(key, { id, metadata: metadata == null ? null : metadata, need: 1 })
  }
  try {
    if (recipe && Array.isArray(recipe.inShape)) {
      for (const row of recipe.inShape) {
        if (!Array.isArray(row)) continue
        for (const cell of row) {
          if (cell && typeof cell === 'object') add(cell.id, cell.metadata)
        }
      }
    }
    if (recipe && Array.isArray(recipe.ingredients)) {
      for (const ing of recipe.ingredients) {
        if (ing && typeof ing === 'object') add(ing.id, ing.metadata)
      }
    }
  } catch (_) { return new Map() }
  let n = 1
  try { n = parseInt(count ?? 1, 10) } catch (_) { n = 1 }
  if (!Number.isFinite(n) || n < 0) n = 1
  if (n !== 1) {
    for (const v of needs.values()) v.need *= n
  }
  return needs
}

function firstStack(win, id, metadata) {
  try {
    return win.findInventoryItem(id, metadata) || null
  } catch (_) { return null }
}

// Model truth after our clicks: the _syncWindow resync is queued behind them
// (TCP order) and overwrites any stale trailing packet, so the re-read below
// sees post-click state. Event-driven, no wall clock; the timeout only
// bounds a dead link. Falls back to a settle wait without _syncWindow.
async function syncInventory(bot) {
  const win = bot.inventory
  if (win && typeof bot._syncWindow === 'function') {
    let timer = null
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('consolidate-sync-timeout')), CONSOLIDATE_SYNC_MS) // ref'd, cleared in finally (see budgetedClick)
    })
    try {
      await Promise.race([bot._syncWindow(win), timeout])
    } finally {
      if (timer) clearTimeout(timer)
    }
    return
  }
  await new Promise((resolve) => setTimeout(resolve, CONSOLIDATE_SETTLE_MS))
}

// Merge later same-item stacks into the first-picked slot until it covers
// need. Vanilla left-click merges CURSOR->SLOT, so each donor cycle picks up
// a later stack, dumps it into the first slot, and puts any leftover back
// where the donor was (empty now) — the cursor ends every cycle empty, so no
// click can go out on an empty server cursor here (the failure mode this
// fixes). Slot clicks on the bare inventory carry no mineflayer waits, so the
// whole sequence runs atomically w.r.t. server packets and the slot list
// stays valid throughout; the post-round sync re-reads truth. Caps at one
// full stack (callers craft count=1, need <= 9); anything more stays short
// and crafts unverified, as before.
async function consolidateOne(bot, win, id, metadata, need) {
  if (win.selectedItem) return // foreign cursor: bail, the verify decides
  const start = typeof win.inventoryStart === 'number' ? win.inventoryStart : 9
  const end = typeof win.inventoryEnd === 'number' ? win.inventoryEnd : 45
  let stacks = []
  try {
    stacks = win.findItemsRange(start, end, id, metadata) || []
  } catch (_) { return }
  if (stacks.length === 0) return
  const slot = stacks[0].slot
  const at = () => {
    const o = win.slots[slot]
    return o && typeof o.count === 'number' ? o.count : 0
  }
  const first = win.slots[slot]
  const cap = first && typeof first.stackSize === 'number' ? first.stackSize : 64
  for (let i = 1; i < stacks.length; i++) {
    const have = at()
    if (have >= need || have >= cap) break
    await bot.clickWindow(stacks[i].slot, 0, 0) // pick up donor
    if (!win.selectedItem) break // didn't take: stop, the verify decides
    await bot.clickWindow(slot, 0, 0) // dump into first
    if (win.selectedItem) await bot.clickWindow(stacks[i].slot, 0, 0) // leftover back
  }
}

async function ensureStacks(bot, recipe, count) {
  const win = bot && bot.inventory
  if (!win || !Array.isArray(win.slots)) return
  if (bot.currentWindow) return // clicks would land in the open window, not the inventory
  if (typeof bot.clickWindow !== 'function') return
  if (typeof win.findInventoryItem !== 'function' || typeof win.findItemsRange !== 'function') return
  if (win.selectedItem) return // foreign cursor: don't touch
  let needs = null
  try {
    needs = placementsFor(recipe, count)
  } catch (_) { return }
  if (!needs || needs.size === 0) return
  const covered = () => {
    for (const v of needs.values()) {
      const f = firstStack(win, v.id, v.metadata)
      const n = f && typeof f.count === 'number' ? f.count : 0
      if (n < v.need) return false
    }
    return true
  }
  if (covered()) return // fast path: zero clicks, zero waits
  for (let round = 0; round < CONSOLIDATE_ROUNDS; round++) {
    for (const v of needs.values()) {
      try {
        await consolidateOne(bot, win, v.id, v.metadata, v.need)
      } catch (_) { /* this ingredient stays fragmented */ }
    }
    try { await syncInventory(bot) } catch (_) { /* unverified: the re-read below decides */ }
    if (covered()) return
  }
  try { console.error('craft consolidate short: first stack below need, crafting anyway') } catch (_) { /* logging best-effort */ }
}

async function safeCraft(bot, recipe, count, table) {
  await paceWindowOp(bot)
  if (!table) await clearGrid(bot)
  await ensureStacks(bot, recipe, count)
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
  } finally {
    try { lastWindowOp.set(bot, Date.now()) } catch (_) { /* pacing best-effort */ }
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
  // First verified-standing of home.table / claimedTable (h9z): reads are
  // Vec3-normalised (a plain claim throws inside prismarine-world, prod:
  // 20 extra tables in 12 h) and a ghost home claim (mined table) must not
  // shadow the equip step's standing roadside table (rig: the door branch
  // below never fired while the table branch rebuilt).
  let tableBlock = null
  let tablePos = null
  for (const cand of [(ctx.home && ctx.home.table), (ctx && ctx.claimedTable)]) {
    if (!cand || typeof cand.x !== 'number') continue
    let b = null
    try { b = bot.blockAt && bot.blockAt(new Vec3(cand.x, cand.y, cand.z)) } catch (_) { b = null }
    if (b && b.name === 'crafting_table') { tableBlock = b; tablePos = cand; break }
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
    // The planks batch sizes from the model at selection; a ghost grid entry
    // (counted, then wiped by a server correction) would over-count. Stop at
    // exhaustion instead of failing the fully converted load as missing
    // ingredient (revmux round-2). Single ops (table/door) loop once.
    const batchWood = op.item.endsWith('_planks') ? op.item.slice(0, -'_planks'.length) : null
    let done = 0
    try {
      // Batch at step level, one log per call: a single bot.craft(count=n)
      // dies on the first silent click and strands the rest, while one op per
      // log re-decides to gather at 13 logs. craftInFlight holds the step for
      // the whole batch (goal.js), so mid-batch churn never re-decides.
      for (let i = 0; i < op.count; i++) {
        if (i > 0 && batchWood && (tally(bot, '_log').get(batchWood) || 0) === 0) break
        await safeCraft(bot, op.recipe, 1, op.table)
        done++
      }
    } catch (err) {
      ctx.craftInFlight = false
      fail(ctx, op.item, err)
      return
    }
    ctx.craftInFlight = false
    const t = totals(bot)
    const made = done * ((op.recipe.result && op.recipe.result.count) || 1)
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
module.exports.WINDOW_OP_GAP_MS = WINDOW_OP_GAP_MS
