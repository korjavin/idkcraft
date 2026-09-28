'use strict'

// light: torch the house and yard by day (bead rw4.13).
//
// Mobs camped the door two nights running (a creeper dragged the bot out of
// the house, a skeleton shot it inside). Lit ground spawns nothing, so a
// ring of torches around the house buys quiet nights.
//
// One behaviour tick does one thing: craft a torch batch (coal/charcoal +
// sticks in the 2x2 grid, no table) or place one torch. Placement mirrors
// the build shape: GoalPlaceBlock approach, reach check against a stale
// goal after preemption, the shared ctx.placeInFlight flight, replaceable
// clear, skip after 3 refusals. Day only: walking the yard at night is the
// danger being fixed. done when every planned spot burns or is skipped,
// with the placed count on the `torches placed N` line.
//
// Torch economy: fuel is coal + charcoal with COAL_RESERVE kept back —
// never spend the last coal (a furnace load stays for whoever burns
// next). Sticks come from sticks, planks, then logs (equip toolOp order).

const Vec3 = require('vec3')
const { goals } = require('mineflayer-pathfinder')
const craftMod = require('./craft')
const buildMod = require('./build')
const { denyReason, logDeny } = require('./util')
const { countItems } = require('../perception')
const metrics = require('../metrics')

const COAL_RESERVE = 4 // fuel floor: smelting's share, never torched
const PLACE_RANGE = 4
const PLACE_REACH = 5
const REFUSALS_TO_SKIP = 3
const STILL_TICKS = 10 // no-progress watchdog: moving but stationary this long re-paths
const STILL_RADIUS = 1 // anchor radius: leaving it (XZ) reads as progress
const CRAFT_TIMEOUT_MS = 30000

// Spot plan: offsets from home.site (ground level unless dy). Door-front
// first (the mob door), then a ring around the 4x4 shell, then the roof,
// then the interior: the dark 2x2 under the roof spawns mobs inside the
// house (live assay night2, filed as idkcraft-nhb). dy 3 is the air above
// the dy-2 roof surface — placeable from the ground next to the house
// (reach 4.3). The interior needs no entry: it stages from the door-front
// ground in place reach (3.2), so no home.js door phases are touched.
// (5,1) is deliberately NOT on the plan:
// plan: atl.14 adopts the stockpile chest at table+1 east, and the skip
// rule below guards it (and the table, and the doorway) anyway. The dark
// 2x2 interior is NOT covered: lighting it needs going inside (door
// phases live in home.js) — follow-up bead, not this step.
const LIGHT_SPOTS = [
  { dx: 1, dz: -2 },
  { dx: -2, dz: -2 }, { dx: 4, dz: -2 },
  { dx: -2, dz: 1 }, { dx: 5, dz: -1 },
  { dx: -2, dz: 4 }, { dx: 4, dz: 4 },
  { dx: 1, dz: 5 },
  // Roof staging: a GoalPlaceBlock aimed 3 above the feet makes the
  // pathfinder dig itself into a hole (live assay: stuck at -62
  // forever), so the approach walks to plain ground in place reach
  // (3.7) and the place flow runs from there.
  { dx: 1, dy: 3, dz: 1, stage: { dx: 0, dz: -1 } },
  // Interior: the torch goes through the doorway from the staged ground
  // (no entry, no door phases). The door cell itself is never taken.
  { dx: 2, dz: 2, stage: { dx: 1, dz: -1 } },
]

function spotAbs(home, spot) {
  return new Vec3(home.site.x + spot.dx, home.site.y + (spot.dy || 0), home.site.z + spot.dz)
}

// A spot the plan must never take: the workbench cell, the stockpile
// chest cell (atl.14 ctx.home.chest contract), or the doorway walk
// column gohome/stay legs step through.
function spotSkipped(home, spot) {
  for (const key of ['table', 'chest']) {
    const c = home && home[key]
    if (c && typeof c.x === 'number' && typeof c.z === 'number' &&
      Math.floor(c.x) === home.site.x + spot.dx && Math.floor(c.z) === home.site.z + spot.dz) return true
  }
  if (spot.dx === 1 && (spot.dz === 0 || spot.dz === -1)) return true
  return false
}

function blockNameAt(bot, p) {
  try {
    const b = bot.blockAt(p)
    return b && typeof b.name === 'string' ? b.name : null
  } catch (_) {
    return null
  }
}

// A spot burns when a full-bright torch stands on it: floor or wall torch
// (light 14). Redstone/soul torches do not count — too dim to hold the
// ring — and neither do lanterns the bot never places.
function spotLit(bot, home, spot) {
  const name = blockNameAt(bot, spotAbs(home, spot))
  return name === 'torch' || name === 'wall_torch'
}

function countUnlit(bot, home, skipped) {
  if (!home || !home.site) return 0
  const skip = new Set(Array.isArray(skipped) ? skipped : [])
  let n = 0
  for (let i = 0; i < LIGHT_SPOTS.length; i++) {
    if (skip.has(i) || spotSkipped(home, LIGHT_SPOTS[i])) continue
    try {
      if (!spotLit(bot, home, LIGHT_SPOTS[i])) n++
    } catch (_) {
      n++ // unscannable reads as dark: the place flow skips what it cannot take
    }
  }
  return n
}

function nextSpotIdx(bot, home, skipped) {
  const skip = new Set(Array.isArray(skipped) ? skipped : [])
  for (let i = 0; i < LIGHT_SPOTS.length; i++) {
    if (skip.has(i) || spotSkipped(home, LIGHT_SPOTS[i])) continue
    try {
      if (!spotLit(bot, home, LIGHT_SPOTS[i])) return i
    } catch (_) {
      return i
    }
  }
  return -1
}

function findItem(bot, pred) {
  try {
    const items = bot.inventory.items()
    if (Array.isArray(items)) {
      for (const item of items) {
        if (item && typeof item.name === 'string' && pred(item.name)) return item
      }
    }
  } catch (_) { /* no inventory: no item */ }
  return null
}

function fail(ctx, reason) {
  ctx.stepStatus = reason
}

// One torch op, equip toolOp order: torches from fuel+sticks, else sticks
// from planks, else planks from logs. Fuel below the reserve fails — the
// step yields and forage may bring coal (goal.js feasible mirrors this).
function torchOp(bot) {
  const fuel = countItems(bot, (n) => n === 'coal' || n === 'charcoal')
  if (fuel - COAL_RESERVE <= 0) return { fail: 'failed:no-fuel' }
  const sticks = countItems(bot, (n) => n === 'stick')
  if (sticks > 0) {
    const found = craftMod.recipes(bot, 'torch', null)
    if (found.length > 0) return { item: 'torch', recipe: found[0], count: 1, table: null }
    return { fail: 'failed:no-torch-recipe' }
  }
  const planks = craftMod.sortedWoods(craftMod.tally(bot, '_planks'))
  if (planks.length > 0 && planks[0][1] >= 2) {
    const found = craftMod.recipes(bot, 'stick', null)
    if (found.length > 0) return { item: 'stick', recipe: found[0], count: 1, table: null }
    return { fail: 'failed:no-stick-recipe' }
  }
  const logs = craftMod.tally(bot, '_log')
  if (logs.size > 0) {
    const [wood] = craftMod.sortedWoods(logs)[0]
    const found = craftMod.recipes(bot, `${wood}_planks`, null)
    if (found.length > 0) return { item: `${wood}_planks`, recipe: found[0], count: 1, table: null }
    return { fail: 'failed:no-planks-recipe' }
  }
  return { fail: 'failed:no-sticks' }
}

// Async craft flight, equip craftOne shape: exactly-once settlement on a
// deadline (a hung window fails loudly, never freezes the menu with the
// flag stuck). decide() holds the step while the flag flies.
function craftTick(bot, ctx) {
  const op = torchOp(bot)
  if (!op || op.fail) {
    fail(ctx, (op && op.fail) || 'failed:no-op')
    return
  }
  if (typeof bot.craft !== 'function') {
    fail(ctx, 'failed:no-craft')
    return
  }
  ctx.lightCraftInFlight = true
  let settled = false
  const finish = (fn) => {
    if (settled) return
    settled = true
    ctx.lightCraftInFlight = false
    if (typeof fn === 'function') fn()
  }
  const run = async () => {
    try {
      await craftMod.safeCraft(bot, op.recipe, op.count, op.table)
    } catch (err) {
      finish(() => fail(ctx, 'failed:craft-torch'))
      return
    }
    finish()
    metrics.light.inc({ op: 'crafted' })
  }
  const timeout = new Promise((_, reject) => {
    const t = setTimeout(() => reject(new Error('craft-timeout')), CRAFT_TIMEOUT_MS)
    if (t && typeof t.unref === 'function') t.unref()
  })
  void Promise.race([run(), timeout]).catch(() => {
    finish(() => fail(ctx, 'failed:craft-timeout'))
  })
}

// Exactly-once completion line per lighting run (module scope: the
// place flight, the done branch and the skip path below can all observe
// the closed ring).
function completionLine(ctx) {
  if (!ctx || ctx.lightLineDone) return
  ctx.lightLineDone = true
  console.log(`torches placed ${ctx.lightPlaced || 0}`)
}

function skipSpot(bot, home, ctx, idx, p, why) {
  if (!Array.isArray(ctx.lightSkip)) ctx.lightSkip = []
  if (!ctx.lightSkip.includes(idx)) ctx.lightSkip.push(idx)
  ctx.lightFails = 0
  ctx.lightFarTicks = 0
  ctx.lightStillTicks = 0
  ctx.lightStillAnchor = null
  console.log(`light skip ${p.x} ${p.y} ${p.z} after 3 refusals (${why})`)
  // A run whose last open spot closes by skipping must still log: the
  // unlit flip re-decides away before any done tick (revmux 01 minor).
  try {
    if (nextSpotIdx(bot, home, ctx.lightSkip) === -1) completionLine(ctx)
  } catch (_) { /* logging best-effort */ }
}

// One torch placement, build.js place shape: (re)approach the spot, then
// place from reach with the shared placeInFlight flight.
function placeTick(bot, ctx, home, idx) {
  const spot = LIGHT_SPOTS[idx]
  const p = spotAbs(home, spot)
  let moving = false
  try { moving = bot.pathfinder.isMoving() } catch (_) { /* treat as arrived */ }
  // Any walking breaks the far-idle streak (round-2 minor) — read before
  // the set branch, so a walk already running when the goal (re)sets
  // counts as progress too. Only N CONSECUTIVE far-idle ticks give up.
  // A walk that makes no progress (nhb live assay: corner squeeze loops
  // stuck/success forever) re-paths after STILL_TICKS on the far budget.
  if (moving) {
    // Progress is measured from an XZ anchor, not tick to tick: jump
    // arcs (y bobbing) and node oscillation must not read as progress,
    // and y is excluded for the same reason (revmux 01 minors).
    let progressed = false
    try {
      const bp = bot.entity && bot.entity.position
      const a = ctx.lightStillAnchor
      if (!bp || typeof bp.x !== 'number') progressed = true // unverifiable: not still
      else if (!a || a.idx !== idx) {
        ctx.lightStillAnchor = { idx, x: bp.x, z: bp.z }
        ctx.lightStillTicks = 0
        progressed = true
      } else if (Math.hypot(bp.x - a.x, bp.z - a.z) > STILL_RADIUS) {
        ctx.lightStillAnchor = { idx, x: bp.x, z: bp.z }
        ctx.lightStillTicks = 0
        progressed = true
      }
    } catch (_) { progressed = true }
    if (!progressed) {
      if (ctx.lightFailIdx !== idx) {
        ctx.lightFailIdx = idx
        ctx.lightFarTicks = 0
      }
      ctx.lightStillTicks = (ctx.lightStillTicks || 0) + 1
      if (ctx.lightStillTicks >= STILL_TICKS) {
        ctx.lightStillTicks = 0
        ctx.lightFarTicks = (ctx.lightFarTicks || 0) + 1
        if (ctx.lightFarTicks >= REFUSALS_TO_SKIP) {
          skipSpot(bot, home, ctx, idx, p, 'stalled')
          return
        }
        ctx.lightGoalIdx = -1
        return
      }
    } else {
      ctx.lightStillTicks = 0
      ctx.lightFarTicks = 0
    }
  }
  if (ctx.lightGoalIdx !== idx) {
    ctx.lightGoalIdx = idx
    try {
      if (spot.stage) {
        const g = new Vec3(home.site.x + spot.stage.dx, home.site.y, home.site.z + spot.stage.dz)
        bot.pathfinder.setGoal(new goals.GoalNear(g.x, g.y, g.z, 1))
      } else {
        bot.pathfinder.setGoal(new goals.GoalPlaceBlock(p, bot.world, { range: PLACE_RANGE }))
      }
    } catch (_) { /* retry next tick */ }
    return
  }
  if (moving) return
  // Stale goal after a preemption carried the body away: re-approach.
  // Counted on its own streak (unlike the build.js twin): an unreachable
  // spot (noPath, partial path, walled-in stage) would otherwise alternate
  // setGoal and reset for the whole day with no give-up (revmux 01
  // minor). A dedicated counter, not lightFails: a preemption resume is
  // one far-idle tick and the walk back resets the streak, so only
  // genuinely unwalkable spots burn (revmux 02 minor). Residual: a path
  // computation slower than 3 ticks on a flat yard reads as unwalkable.
  try {
    const bp = bot.entity && bot.entity.position
    if (bp && typeof bp.x === 'number' && Math.hypot(bp.x - p.x, bp.y - p.y, bp.z - p.z) > PLACE_REACH) {
      if (ctx.lightFailIdx !== idx) {
        ctx.lightFailIdx = idx
        ctx.lightFarTicks = 0
      }
      ctx.lightFarTicks = (ctx.lightFarTicks || 0) + 1
      ctx.lightStillTicks = 0
      ctx.lightStillAnchor = null
      if (ctx.lightFarTicks >= REFUSALS_TO_SKIP) {
        skipSpot(bot, home, ctx, idx, p, 'unreachable')
        return
      }
      ctx.lightGoalIdx = -1
      return
    }
  } catch (_) { /* unverifiable: attempt anyway */ }
  if (spotLit(bot, home, spot)) return // lagged double-place guard
  const item = findItem(bot, (n) => n === 'torch')
  if (!item) {
    fail(ctx, 'failed:no-torches')
    return
  }
  if (ctx.lightFailIdx !== idx) {
    ctx.lightFailIdx = idx
    ctx.lightFails = 0
  }
  const ref = buildMod.findRef(bot, p)
  if (!ref) {
    ctx.lightFails = (ctx.lightFails || 0) + 1
    if (ctx.lightFails >= REFUSALS_TO_SKIP) skipSpot(bot, home, ctx, idx, p, 'no-ref')
    else ctx.lightGoalIdx = -1
    return
  }
  ctx.placeInFlight = true
  const fails = () => ctx.lightFails || 0
  // The last torch flips unlit to none, which flips the goal text and
  // re-decides AWAY (light infeasible) before any tick can report done —
  // so the completion line fires here, on the landing that closes the
  // ring. Log-only: never write stepStatus from a flight the menu may
  // have already handed to another step.
  const landed = () => {
    ctx.lightFails = 0
    ctx.lightFarTicks = 0
    ctx.lightStillTicks = 0
    ctx.lightStillAnchor = null
    ctx.lightPlaced = (ctx.lightPlaced || 0) + 1
    metrics.light.inc({ op: 'placed' })
    try {
      if (nextSpotIdx(bot, home, ctx.lightSkip) === -1) completionLine(ctx)
    } catch (_) { /* logging best-effort */ }
  }
  ;(async () => {
    try {
      await bot.equip(item, 'hand')
      await bot.placeBlock(ref.ref, ref.face)
      landed()
    } catch (err) {
      ctx.lightFails = fails() + 1
      const occupier = blockNameAt(bot, p)
      if (occupier === 'torch' || occupier === 'wall_torch') {
        ctx.lightFails = 0 // landed while we walked: the torch stands
      } else if (occupier != null && occupier !== 'air' && buildMod.isReplaceable(occupier)) {
        let cell = null
        try { cell = bot.blockAt(p) } catch (_) { cell = null }
        const clearDeny = cell && denyReason(bot, cell, ctx)
        if (clearDeny) {
          logDeny(cell, clearDeny) // idkcraft-drq: never clear foreign torches to light
        } else {
          try {
            await bot.dig(cell || bot.blockAt(p))
            await bot.equip(item, 'hand')
            await bot.placeBlock(ref.ref, ref.face)
            landed()
          } catch (_) {
            ctx.lightFails = fails() + 1
          }
        }
      }
      if (fails() >= REFUSALS_TO_SKIP) skipSpot(bot, home, ctx, idx, p, occupier || 'refused')
    } finally {
      ctx.placeInFlight = false
    }
  })().catch(() => { ctx.placeInFlight = false })
}

function light(bot, ctx) {
  if (ctx.lightCraftInFlight || ctx.placeInFlight) return
  const home = ctx && ctx.home
  if (!home || !home.site) {
    fail(ctx, 'failed:no-home')
    return
  }
  // The GoalPlaceBlock approach paths with canDig and eats house corners
  // (build.js cww lesson) — and the build guard may never have been
  // installed when the house was adopted, not built. Idempotent.
  buildMod.guardOwnWalls(bot, ctx)
  // Skip state is site-relative (revmux 01 major/minor): a 'build here'
  // or adopt that moves the home must not inherit the old site's skips.
  // Keyed like buildGuardKey so no index.js hunk is needed.
  const siteKey = `${home.site.x},${home.site.y},${home.site.z}`
  if (ctx.lightSkipKey !== siteKey) {
    ctx.lightSkipKey = siteKey
    ctx.lightSkip = []
    ctx.lightFails = 0
    ctx.lightFarTicks = 0
    ctx.lightStillTicks = 0
    ctx.lightStillAnchor = null
    ctx.lightFailIdx = -1
    ctx.lightGoalIdx = -1
    ctx.lightPlaced = 0
    ctx.lightLineDone = false
  }
  if (!Array.isArray(ctx.lightSkip)) ctx.lightSkip = []
  const idx = nextSpotIdx(bot, home, ctx.lightSkip)
  if (idx === -1) {
    ctx.stepStatus = 'done'
    try {
      completionLine(ctx)
    } catch (_) { /* logging best-effort */ }
    return
  }
  ctx.lightLineDone = false // work remains: the next close logs again
  const torches = countItems(bot, (n) => n === 'torch')
  if (torches <= 0) {
    craftTick(bot, ctx)
    return
  }
  placeTick(bot, ctx, home, idx)
}

module.exports = light
module.exports.COAL_RESERVE = COAL_RESERVE
module.exports.LIGHT_SPOTS = LIGHT_SPOTS
module.exports.countUnlit = countUnlit
module.exports.nextSpotIdx = nextSpotIdx
module.exports.spotLit = spotLit
module.exports.torchOp = torchOp
