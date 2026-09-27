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
// Surplus batch gate (craft NEED_LOGS precedent): banking preempts forage,
// so a single dug block must not flip it — the leg would shrink to one
// block per round trip home. The menu sees surplus only past a full batch.
const SURPLUS_BATCH = 16
// Park re-probe radius: an expired full park re-arms only near home, so a
// probably-still-full chest never costs a cross-map trip (revmux 02-review).
const REPROBE_RADIUS = 32
// A full chest parks the step, but only for this long: the owner empties
// the chest by hand (no ctx write), so the park must expire and re-probe
// instead of holding until a bring fetch or a restart (revmux 01-review).
const CHEST_FULL_RETRY_MS = 10 * 60 * 1000
// Container/place interaction reach: isMoving()==false is not arrival (no
// path reads the same), so window ops double-check the body is close
// instead of eating mineflayer's 20 s windowOpen timeout (revmux 01-review).
const INTERACT_REACH = 4
// Place reach: GoalPlaceBlock(range 4) ends on head-to-face-centre <= 4,
// so the gate must accept every valid end node (02-review geometry).
const PLACE_REACH = 4.5

function nearPos(bot, p, reach) {
  // Measured to the block CENTRE: GoalPlaceBlock ends on head-to-face
  // distance, and feet-to-corner over-measures by ~1 on +x/+z approaches,
  // failing 'far' on a valid end node (revmux 02-review).
  try {
    const bp = bot && bot.entity && bot.entity.position
    if (!bp || typeof bp.x !== 'number') return false
    return Math.hypot(bp.x - (p.x + 0.5), bp.y - (p.y + 0.5), bp.z - (p.z + 0.5)) <= reach
  } catch (_) {
    return false
  }
}

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
// the cell, solid ground below. { x, y, z, adopt }, 'unknown' when no
// candidate is decidable (chunks dark: walk in, don't fail), else null.
function chestSpotFor(bot, ctx) {
  const site = ctx && ctx.home && ctx.home.site
  if (!site || typeof site.x !== 'number') return null
  let sawUnknown = false
  for (const s of CHEST_SPOTS) {
    const x = site.x + s.dx
    const y = site.y + s.dy
    const z = site.z + s.dz
    const at = blockNameAt(bot, x, y, z)
    if (at === null) { sawUnknown = true; continue }
    if (at !== 'air' && at !== 'chest') continue
    const below = blockNameAt(bot, x, y - 1, z)
    if (below === null) { sawUnknown = true; continue }
    if (below === 'air') continue
    return { x, y, z, adopt: at === 'chest' }
  }
  return sawUnknown ? 'unknown' : null
}

// What the no-chest branch can do: 'adopt' a standing chest on sight,
// 'place' one when the pack holds a chest item or 8 same-wood planks,
// 'none' otherwise. The menu gates on this so an unready bot never
// preempts a forage leg to fail at once (revmux 02-review).
function chestTodo(bot, ctx, maxPlanks) {
  try {
    const site = ctx && ctx.home && ctx.home.site
    if (site && typeof site.x === 'number') {
      for (const s of CHEST_SPOTS) {
        if (blockNameAt(bot, site.x + s.dx, site.y + s.dy, site.z + s.dz) === 'chest') return 'adopt'
      }
    }
    if (countItems(bot, (n) => n === 'chest') > 0) return 'place'
    if ((maxPlanks || 0) >= 8) return 'place'
  } catch (_) { /* undecidable: none */ }
  return 'none'
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

// Open the adopted chest, run fn(window), always close.
// { status: 'ok', value } | 'gone' | 'unknown' | 'error'.
// Unknown (blockAt null: unloaded chunk) is NOT gone — the caller walks
// closer and retries instead of dropping the adoption. An open throw on a
// LOADED chest (blocked lid, cat, lag) is an error, never unknown: the
// caller fails loud so failHolds parks the step (revmux 02-review).
async function withChest(bot, ctx, fn) {
  const c = ctx && ctx.home && ctx.home.chest
  if (!c || typeof bot.openChest !== 'function') return { status: 'gone' }
  let block = null
  let unknown = false
  try {
    block = bot.blockAt(new Vec3(c.x, c.y, c.z))
    if (!block) unknown = true
  } catch (_) { unknown = true }
  if (!block) return { status: unknown ? 'unknown' : 'gone' }
  if (block.name !== 'chest') return { status: 'gone' }
  try {
    const window = await bot.openChest(block)
    try {
      return { status: 'ok', value: await fn(window) }
    } finally {
      try { window.close() } catch (_) { /* close best-effort */ }
    }
  } catch (_) {
    return { status: 'error' }
  }
}

// Withdraw up to count of name from the adopted chest. { got } — 0 when the
// chest is gone, empty of name, or the inventory is full.
async function withdrawFromChest(bot, ctx, name, count) {
  try {
    const res = await withChest(bot, ctx, async (window) => {
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
    return { got: res && res.status === 'ok' ? res.value : 0 }
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
      if (!Array.isArray(stacks)) return { got: 0, name: null, status: 'ok' }
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
    return res && res.status === 'ok' ? res.value : { got: 0, name: null }
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
    if (spot === 'unknown') {
      // Home chunk dark (returning from a far leg): walk in so the scan
      // can decide. Failing here would preempt every leg to fail at once.
      const site = home.site
      const key = `stockpile-site:${site.x},${site.y},${site.z}`
      if (key !== ctx.lastGoalKey) {
        try {
          bot.pathfinder.setGoal(new goals.GoalNear(site.x + 2, site.y, site.z + 2, 3), false)
        } catch (_) { /* retry next tick */ }
        ctx.lastGoalKey = key
        return
      }
      let moving = false
      try { moving = bot.pathfinder.isMoving() } catch (_) { /* treat as arrived */ }
      if (moving) return
      if (!nearPos(bot, { x: site.x + 2, y: site.y, z: site.z + 2 }, REPROBE_RADIUS)) {
        fail(ctx, 'far') // issued, standing, still far: no path home
        return
      }
      return // arrived but the scan is still dark: retry next tick
    }
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
  if (at === null) {
    // Chunk unknown (bot far from home): walk in so it loads. Never
    // unadopt on unknown — that deletes a good claim from 200 blocks out.
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
    if (!nearPos(bot, c, INTERACT_REACH)) {
      fail(ctx, 'far') // issued, standing, still far: no path
      return
    }
    return // arrived but the chunk is still dark: retry next tick
  }
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
  if (!nearPos(bot, c, INTERACT_REACH)) {
    // No path reads as !moving too: fail instead of eating the 20 s
    // windowOpen timeout on an out-of-range open (revmux 01-review).
    fail(ctx, 'far')
    return
  }

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
      if (!res || res.status === 'gone') {
        home.chest = null // vanished mid-step: re-place, same step
        ctx.stepStatus = 'running'
        ctx.lastGoalKey = null
        return
      }
      if (res.status === 'unknown') {
        // Chunk unloaded mid-open: walk back in, keep the claim.
        ctx.stepStatus = 'running'
        ctx.lastGoalKey = null
        return
      }
      if (res.status === 'error') {
        fail(ctx, 'deposit') // lid blocked or open timed out: hold, retry later
        return
      }
      if (banked > 0) {
        ctx.chestFull = false
        say(bot, `stockpiled ${names.join(', ')}`)
      }
      if (before > 0 && banked === 0) {
        // Nothing moved with surplus on hand: the chest is full. Done, not
        // failed — failing would hold and spam; the stamped flag parks the
        // step until the retry window expires or a bring fetch re-arms it.
        ctx.chestFull = true
        ctx.chestFullAt = Date.now()
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
    if (!tableBlock) {
      fail(ctx, 'no-chest')
      return
    }
    const found = craftMod ? craftMod.recipes(bot, 'chest', tableBlock) : []
    if (found.length === 0) { // no ingredients for the recipe
      fail(ctx, 'no-chest')
      return
    }
    // The table craft opens a window: walk into reach first (craft.js door
    // rule). Crafting from across the map eats the 20 s windowOpen timeout
    // and — with the error swallowed — livelocks the step (revmux 01-review).
    const reach = (craftMod && craftMod.TABLE_REACH) || INTERACT_REACH
    if (!nearPos(bot, tablePos, reach)) {
      const key = `stockpile-table:${tablePos.x},${tablePos.y},${tablePos.z}`
      if (key !== ctx.lastGoalKey) {
        try {
          bot.pathfinder.setGoal(new goals.GoalNear(tablePos.x, tablePos.y, tablePos.z, 2), false)
        } catch (_) { /* retry next tick */ }
        ctx.lastGoalKey = key
        return
      }
      let moving = false
      try { moving = bot.pathfinder.isMoving() } catch (_) { /* treat as arrived */ }
      if (moving) return
      fail(ctx, 'far') // issued, standing, still far: no path to the table
      return
    }
    ctx.stockpileInFlight = true
    void (async () => {
      try {
        await craftMod.safeCraft(bot, found[0], 1, tableBlock)
      } catch (_) {
        ctx.stockpileInFlight = false
        fail(ctx, 'craft') // loud: failHolds parks until the situation moves
        return
      }
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
  if (!nearPos(bot, p, PLACE_REACH)) {
    fail(ctx, 'far') // issued, standing, still far: no path to the spot
    return
  }

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
module.exports.CHEST_FULL_RETRY_MS = CHEST_FULL_RETRY_MS
module.exports.INTERACT_REACH = INTERACT_REACH
module.exports.PLACE_REACH = PLACE_REACH
module.exports.SURPLUS_BATCH = SURPLUS_BATCH
module.exports.REPROBE_RADIUS = REPROBE_RADIUS
module.exports.chestTodo = chestTodo
