'use strict'

// stockpile: the home chest (idkcraft-atl.14). While the owner is away the
// bot banks its surplus in a chest by the house instead of hauling it to a
// player: adopt-or-place the chest at table+1 east, then deposit everything
// the body still needs on hand (tools, light fuel, food, pillar reserve).
//
// Chest contract (shared with rw4.13 torches): ctx.home.chest is a plain
// { x, y, z } like ctx.home.table, claimed only once the chest block is
// really there. Placement scans CHEST_SPOTS in order — table+1 east first,
// then the neighbouring cells — for solid ground below and air at the cell.
// Adopt-on-sight: a chest an earlier run left at a candidate spot is
// adopted, never rebuilt.

const { goals } = require('mineflayer-pathfinder')
const { Vec3 } = require('vec3')
const { countItems } = require('../perception')

// Candidate chest cells, site-relative (table is BLUEPRINT[0] at (4,0,1),
// so (5,0,1) is table+1 east). All sit beside the east wall, clear of the
// door walk cell (1,0,-1) and the interior.
const CHEST_SPOTS = [
  { dx: 5, dy: 0, dz: 1 },
  { dx: 4, dy: 0, dz: 0 },
  { dx: 4, dy: 0, dz: 2 },
  { dx: 5, dy: 0, dz: 0 },
  { dx: 5, dy: 0, dz: 2 },
  { dx: 6, dy: 0, dz: 1 },
]

// Never banked: worn/carried kit (same shape as bring share keeps), the
// light fuel rw4.13 counts from the inventory (torch, coal, charcoal and
// the sticks they craft from), plus a food and scaffold reserve below.
const TOOL_KEEP = /_(pickaxe|axe|shovel|hoe|sword|helmet|chestplate|leggings|boots)$/
const EXACT_KEEP = new Set([
  'shears', 'flint_and_steel', 'bow', 'crossbow', 'trident', 'arrow', 'shield',
  'torch', 'coal', 'charcoal', 'stick',
])
const FOOD_KEEP = 10
const SCAFFOLD_KEEP = 32

function edibles() {
  try {
    const set = require('../index').EDIBLE_FOODS
    if (set && typeof set.has === 'function') return set
  } catch (_) { /* index not loaded (unit tests): fall back below */ }
  return new Set(['bread', 'apple', 'carrot', 'cooked_beef', 'cooked_porkchop', 'cooked_chicken'])
}

function isKeep(name) {
  if (typeof name !== 'string') return true
  if (EXACT_KEEP.has(name)) return true
  return TOOL_KEEP.test(name)
}

function invItems(bot) {
  try {
    const items = bot && bot.inventory && typeof bot.inventory.items === 'function' ? bot.inventory.items() : []
    return Array.isArray(items) ? items : []
  } catch (_) {
    return []
  }
}

// Inventory -> deposit list in inventory order, keeps skipped. Food keeps
// the first FOOD_KEEP edibles (the eat reflex feeds from the inventory),
// dirt+cobble keep the first SCAFFOLD_KEEP (the pillar reserve share keeps).
function depositPlan(bot) {
  const list = invItems(bot)
  const edible = edibles()
  let keepFood = FOOD_KEEP
  let keepScaffold = SCAFFOLD_KEEP
  const plan = []
  for (const i of list) {
    if (!i || typeof i.name !== 'string') continue
    if (isKeep(i.name)) continue
    let n = typeof i.count === 'number' ? i.count : 1
    if (n <= 0) continue
    if (edible.has(i.name)) {
      const k = Math.min(keepFood, n)
      keepFood -= k
      n -= k
    } else if (i.name === 'dirt' || i.name === 'cobblestone') {
      const k = Math.min(keepScaffold, n)
      keepScaffold -= k
      n -= k
    }
    if (n > 0) plan.push({ name: i.name, count: n })
  }
  return plan
}

function surplusCount(bot) {
  let n = 0
  for (const p of depositPlan(bot)) n += p.count
  return n
}

function blockNameAt(bot, x, y, z) {
  try {
    const b = bot && typeof bot.blockAt === 'function' ? bot.blockAt(new Vec3(x, y, z)) : null
    return (b && b.name) || null
  } catch (_) {
    return null
  }
}

// First candidate that can hold the chest: air (or a chest to adopt) at
// the cell, solid ground below. { x, y, z, adopt } or null.
function chestSpotFor(bot, ctx) {
  const site = ctx && ctx.home && ctx.home.site
  if (!site || typeof site.x !== 'number') return null
  for (const s of CHEST_SPOTS) {
    const x = site.x + s.dx
    const y = site.y + s.dy
    const z = site.z + s.dz
    const at = blockNameAt(bot, x, y, z)
    if (at !== 'air' && at !== 'chest' && at !== null) continue
    const below = blockNameAt(bot, x, y - 1, z)
    if (below === null || below === 'air') continue
    return { x, y, z, adopt: at === 'chest' }
  }
  return null
}

function say(bot, line) {
  try { bot.chat(line) } catch (_) { /* chat best-effort */ }
}

function fail(ctx, reason) {
  ctx.stepStatus = `failed:${reason}`
}

// Claim the chest coords only once the chest block is really there (same
// placed-station contract as the table: a ghost claim would walk bring to
// an empty cell).
function adopted(ctx, spot) {
  ctx.home.chest = { x: spot.x, y: spot.y, z: spot.z }
}

// Open the adopted chest, run fn(window), always close. Null window when
// the chest is gone or unreachable — the caller unadopts and re-places.
async function withChest(bot, ctx, fn) {
  const c = ctx && ctx.home && ctx.home.chest
  if (!c || typeof bot.openChest !== 'function') return null
  let block = null
  try {
    block = bot.blockAt(new Vec3(c.x, c.y, c.z))
  } catch (_) { block = null }
  if (!block || block.name !== 'chest') return null
  const window = await bot.openChest(block)
  try {
    return await fn(window)
  } finally {
    try { window.close() } catch (_) { /* close best-effort */ }
  }
}

// Withdraw up to count of name from the adopted chest. { got } — 0 when the
// chest is gone, empty of name, or the inventory is full.
async function withdrawFromChest(bot, ctx, name, count) {
  try {
    const got = await withChest(bot, ctx, async (window) => {
      const stacks = typeof window.containerItems === 'function' ? window.containerItems() : []
      let want = count
      let got = 0
      if (Array.isArray(stacks)) {
        for (const s of stacks) {
          if (want <= 0) break
          if (!s || s.name !== name) continue
          const take = Math.min(typeof s.count === 'number' ? s.count : 1, want)
          if (take <= 0) continue
          await window.withdraw(s.type, s.metadata, take)
          want -= take
          got += take
        }
      }
      return got
    })
    return { got: got == null ? 0 : got }
  } catch (_) {
    return { got: 0 }
  }
}

// Withdraw up to count of the first edible in the adopted chest.
// { got, name } — name null when nothing edible came out.
async function withdrawEdible(bot, ctx, count) {
  const edible = edibles()
  try {
    const res = await withChest(bot, ctx, async (window) => {
      const stacks = typeof window.containerItems === 'function' ? window.containerItems() : []
      if (!Array.isArray(stacks)) return { got: 0, name: null }
      const first = stacks.find((s) => s && typeof s.name === 'string' && edible.has(s.name))
      if (!first) return { got: 0, name: null }
      let want = count
      let got = 0
      for (const s of stacks) {
        if (want <= 0) break
        if (!s || s.name !== first.name) continue
        const take = Math.min(typeof s.count === 'number' ? s.count : 1, want)
        if (take <= 0) continue
        await window.withdraw(s.type, s.metadata, take)
        want -= take
        got += take
      }
      return { got, name: first.name }
    })
    return res == null ? { got: 0, name: null } : res
  } catch (_) {
    return { got: 0, name: null }
  }
}

function stockpile(bot, ctx, target, state) {
  if (!ctx) return
  if (ctx.stockpileInFlight) return // exactly one window op at a time (craft.js rule)
  const bp = bot && bot.entity && bot.entity.position
  if (!bp) return
  const home = ctx.home
  if (!home || !home.site) {
    fail(ctx, 'no-home')
    return
  }

  // Adopt-on-sight: a chest an earlier run left at a candidate spot is
  // claimed, never rebuilt. A ghost claim (mined chest) unadopts.
  if (!home.chest) {
    let spot = null
    try {
      spot = chestSpotFor(bot, ctx)
    } catch (_) { spot = null }
    if (spot && spot.adopt) {
      adopted(ctx, spot)
    } else if (spot) {
      placeChest(bot, ctx, spot, bp)
      return
    } else {
      fail(ctx, 'no-spot')
      return
    }
  }

  const c = home.chest
  let at = null
  try {
    at = blockNameAt(bot, c.x, c.y, c.z)
  } catch (_) { at = null }
  if (at !== 'chest') {
    home.chest = null // mined or never there: re-place, same step
    ctx.stepStatus = 'running'
    stockpile(bot, ctx, target, state)
    return
  }

  const plan = depositPlan(bot)
  if (plan.length === 0) {
    ctx.stepStatus = 'done'
    return
  }

  const key = `stockpile:${c.x},${c.y},${c.z}`
  if (key !== ctx.lastGoalKey) {
    try {
      bot.pathfinder.setGoal(new goals.GoalNear(c.x, c.y, c.z, 2), false)
    } catch (_) { /* retry next tick */ }
    ctx.lastGoalKey = key
    return
  }
  let moving = false
  try { moving = bot.pathfinder.isMoving() } catch (_) { /* treat as arrived */ }
  if (moving) return

  ctx.stockpileInFlight = true
  void (async () => {
    try {
      const before = surplusCount(bot)
      const names = []
      let banked = 0
      const res = await withChest(bot, ctx, async (window) => {
        for (const p of depositPlan(bot)) {
          const entry = bot.registry && bot.registry.itemsByName && bot.registry.itemsByName[p.name]
          const type = entry && typeof entry.id === 'number' ? entry.id : null
          if (type == null) continue
          try {
            await window.deposit(type, null, p.count)
            banked += p.count
            names.push(`${p.count} ${p.name}`)
          } catch (_) { /* chest full or stack unmovable: stop at the rest */ }
        }
        return true
      })
      ctx.stockpileInFlight = false
      if (res == null) {
        home.chest = null // vanished mid-step: re-place, same step
        ctx.stepStatus = 'running'
        ctx.lastGoalKey = null
        return
      }
      if (banked > 0) {
        ctx.chestFull = false
        say(bot, `stockpiled ${names.join(', ')}`)
      }
      if (before > 0 && banked === 0) {
        // Nothing moved with surplus on hand: the chest is full. Done, not
        // failed — failing would hold and spam; the flag parks the step
        // until a bring fetch makes room (chestFull cleared there).
        ctx.chestFull = true
        say(bot, 'the home chest is full')
      }
      ctx.stepStatus = 'done'
    } catch (_) {
      ctx.stockpileInFlight = false
      fail(ctx, 'deposit')
    }
  })()
}

// Ensure a chest item (craft one at the placed table when needed) and place
// it at the spot. One in-flight op; ticks re-enter until adopted.
function placeChest(bot, ctx, spot, bp) {
  const have = countItems(bot, (n) => n === 'chest')
  if (have <= 0) {
    // Deferred require: stockpile loads during goal's load (goal requires
    // this module), while craft destructures NEED_LOGS off goal at load —
    // a top-level require here would hand craft a half-loaded goal.
    let craftMod = null
    try { craftMod = require('./craft') } catch (_) { craftMod = null }
    const tablePos = (ctx.home && ctx.home.table) || (ctx && ctx.claimedTable)
    let tableBlock = null
    if (tablePos && craftMod) {
      try {
        const b = bot.blockAt && bot.blockAt(new Vec3(tablePos.x, tablePos.y, tablePos.z))
        if (b && b.name === 'crafting_table') tableBlock = b
      } catch (_) { tableBlock = null }
    }
    const found = craftMod ? craftMod.recipes(bot, 'chest', tableBlock) : []
    if (found.length === 0 || !tableBlock) {
      fail(ctx, 'no-chest')
      return
    }
    ctx.stockpileInFlight = true
    void (async () => {
      try {
        await craftMod.safeCraft(bot, found[0], 1, tableBlock)
      } catch (_) { /* menu re-checks readiness next decide */ }
      ctx.stockpileInFlight = false
    })()
    return
  }

  const p = new Vec3(spot.x, spot.y, spot.z)
  const gkey = `stockpile-place:${spot.x},${spot.y},${spot.z}`
  if (ctx.lastGoalKey !== gkey) {
    try {
      bot.pathfinder.setGoal(new goals.GoalPlaceBlock(p, bot.world, { range: 4 }), false)
    } catch (_) { /* retry next tick */ }
    ctx.lastGoalKey = gkey
    return
  }
  let moving = false
  try { moving = bot.pathfinder.isMoving() } catch (_) { /* treat as arrived */ }
  if (moving) return

  ctx.stockpileInFlight = true
  void (async () => {
    try {
      const below = bot.blockAt(new Vec3(spot.x, spot.y - 1, spot.z))
      if (!below || !below.name || below.name === 'air') {
        ctx.stockpileInFlight = false
        fail(ctx, 'no-ground')
        return
      }
      const items = bot.inventory.items()
      const item = Array.isArray(items) ? items.find((i) => i && i.name === 'chest') : null
      if (!item) {
        ctx.stockpileInFlight = false
        fail(ctx, 'no-chest')
        return
      }
      if (typeof bot.equip === 'function') await bot.equip(item, 'hand')
      await bot.placeBlock(below, new Vec3(0, 1, 0))
      const landed = blockNameAt(bot, spot.x, spot.y, spot.z)
      ctx.stockpileInFlight = false
      if (landed === 'chest') {
        adopted(ctx, spot)
        ctx.lastGoalKey = null
        say(bot, 'placed the home chest')
      } else {
        fail(ctx, 'place')
      }
    } catch (_) {
      ctx.stockpileInFlight = false
      fail(ctx, 'place')
    }
  })()
}

module.exports = stockpile
module.exports.depositPlan = depositPlan
module.exports.surplusCount = surplusCount
module.exports.chestSpotFor = chestSpotFor
module.exports.withdrawFromChest = withdrawFromChest
module.exports.withdrawEdible = withdrawEdible
module.exports.CHEST_SPOTS = CHEST_SPOTS
module.exports.FOOD_KEEP = FOOD_KEEP
module.exports.SCAFFOLD_KEEP = SCAFFOLD_KEEP
