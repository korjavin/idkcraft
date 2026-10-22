'use strict'

// Reforest step (idkcraft-6p4l beat + idkcraft-lc55 plant): beat nearby
// leaves and bank the dropped saplings during idle time, then plant the
// banked saplings at random vetted spots. Picked by the goal FSM between
// forage and explore (STEP_ORDER) when nothing better is feasible: the
// gather path below stays untouched (v1 frozen — foliage was never its
// target).
//
// Phase machine, same shape as gather.js: find (live registry scan) ->
// walk (GoalNear + displacement stalls) -> dig -> pickup (proximity
// vacuum), capped by leaf count or wall time — never an infinite beat
// loop — then the plant tail (lc55): plant-pick (random vetted spot
// within ~30) -> plant-walk (GoalNear + displacement stalls) ->
// plant-place (equip + placeBlock, one flight), capped by planting count
// — never an endless phase. Completion goes through step.js only, with
// one prod line per step: reforest leaves=<n> saplings=+<k> fail=<reason|->
// planted=<p>, plus one reforest plant <sapling> at <x,y,z> per planting.

const { goals } = require('mineflayer-pathfinder')
const { Vec3 } = require('vec3')
const bring = require('./bringbase') //oqul.14: progressed() displacement check lives in the leaf
const { stepDone, stepFailed } = require('../step') // oqul.6: status writes go through step.js
const { say, clearGoal, issueGoal, botPos, denyReason, protectedReason, inHouseFootprint } = require('./util')
const { countItems } = require('../perception')

const REFOREST_RADIUS = 32 // bead: feasible iff *_leaves within ~32 blocks
const REFOREST_MAX_LEAVES = 8 // beaten-leaf cap per step, then done
const REFOREST_MAX_MS = 180000 // wall-time cap per step (3 min), then done
const WALK_STALL_TICKS = 10 // no-displacement walk ticks before a leaf is struck
const PICKUP_TICKS = 4 // settle ticks on the dug column while drops vacuum in
const UNREACHABLE_STRIKES = 3 // struck leaves before failed:unreachable
const WALK_RANGE = 4 // walk goal range: a 3D sphere, so feet-level leaves satisfy it without climbing
const PICKUP_RANGE = 1 // pickup goal range on the dug column (XZ only: drops fall to the ground)
const PICKUP_CLOSE = 1.2 // column-centre distance that vacuums the drops (item pickup is ~1.4)
const LOW_DY = 4 // canopy guard (revmux 01 core-1/02): leaves more than 4 above the feet need a tower, not an idle beat
const PLANT_RADIUS = 30 // bead: random plant spots within ~30 blocks of the body
const PLANT_MAX = 8 // plantings per step, then done — never an endless phase
const PLANT_PICK_TRIES = 16 // random candidates vetted per pick before giving up
const PLANT_FAIL_MAX = 8 // walk/place failures before the tail ends with what it planted
const PLANT_REACH = 4.5 // place reach: arrival stops the walk, like canDigBlock for digs
const PLANT_UP = 8 // surface scan above the feet for a random (x,z) ...
const PLANT_DOWN = 24 // ... and below: top-down takes the surface first, so hilltops and rims plant, never cave floors
// Deterministic feasibility probe (core-2): fixed offsets, not random
// samples, so the menu does not flicker between ticks.
const PLANT_PROBE = [[10, 0], [-10, 0], [0, 10], [0, -10], [14, 14], [14, -14], [-14, 14], [-14, -14], [22, 7], [-22, 7], [7, 22], [7, -22]]

// Plantable soil (lc55): gather's SAPLING_SOIL minus the cells the shared
// guard refuses anyway (moss_block, farmland read 'protected' — a mossy or
// tilled cell is someone's garden until proven otherwise). Local copy, not
// a gather require: gather's chain (stuck/bring/resources/scout) must not
// load into every reforest tick.
const PLANT_SOIL = new Set(['dirt', 'grass_block', 'coarse_dirt', 'rooted_dirt', 'podzol', 'mycelium', 'mud'])

function isLeafName(name) {
  return typeof name === 'string' && name.endsWith('_leaves')
}

function isSaplingName(name) {
  return typeof name === 'string' && (name.endsWith('_sapling') || name === 'mangrove_propagule')
}

// Registry leaf names, like logNames in gather.js (v1 path untouched —
// this is the new behaviour's own matcher).
function leafNames(bot) {
  try {
    const byName = (bot && bot.registry && bot.registry.blocksByName) || {}
    return Object.keys(byName).filter(isLeafName)
  } catch (_) {
    return []
  }
}

function leafIds(bot) {
  try {
    const byName = (bot && bot.registry && bot.registry.blocksByName) || {}
    const ids = []
    for (const name of Object.keys(byName)) {
      if (!isLeafName(name)) continue
      const entry = byName[name]
      if (entry && typeof entry.id === 'number' && !ids.includes(entry.id)) ids.push(entry.id)
    }
    return ids
  } catch (_) {
    return []
  }
}

function countSaplings(bot) {
  try {
    return countItems(bot, isSaplingName)
  } catch (_) {
    return 0
  }
}

function keyOf(p) {
  return `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`
}

function cellNameAt(bot, x, y, z) {
  try {
    const b = bot.blockAt && bot.blockAt(new Vec3(Math.floor(x), Math.floor(y), Math.floor(z)))
    return b && b.name
  } catch (_) { return null }
}

// First plantable pack sapling (lc55): like gather's findSapling, a lone
// dark oak never grows (2x2 only) — planting it wastes the item.
function firstSapling(bot) {
  try {
    const items = bot.inventory && typeof bot.inventory.items === 'function' ? bot.inventory.items() : null
    if (!Array.isArray(items)) return null
    return items.find((it) => it && isSaplingName(it.name) && it.name !== 'dark_oak_sapling') || null
  } catch (_) { return null }
}

// Veto predicate for one plant cell (x,y,z: the AIR cell taking the
// sapling). Fail-safe toward NOT planting: every doubt rejects — the
// house footprint (box + apron), the castle footprint, danger memory,
// the shared dig guard on the soil (a tree must never root in чужі
// builds), wrong soil, missing air or headroom. Pure reads, no writes,
// so goal.js and the tests share it.
function plantSpotOk(bot, ctx, x, y, z) {
  try {
    const bp = botPos(bot)
    if (!bp) return false
    if (typeof bot.blockAt !== 'function') return false
    if (Math.hypot(x - bp.x, z - bp.z) > PLANT_RADIUS) return false
    if (cellNameAt(bot, x, y, z) !== 'air') return false
    if (cellNameAt(bot, x, y + 1, z) !== 'air') return false
    // Never the cells the body stands in: the server refuses a block into
    // its own hitbox, so the veto saves the walk.
    if (Math.floor(bp.x) === x && Math.floor(bp.z) === z &&
      (y === Math.floor(bp.y) || y === Math.floor(bp.y) + 1)) return false
    const soil = cellNameAt(bot, x, y - 1, z)
    if (!PLANT_SOIL.has(soil)) return false
    const spot = { x, y, z }
    try {
      if (inHouseFootprint(ctx && ctx.home, spot)) return false
    } catch (_) { return false }
    try {
      // Every known castle (core-3): the own one plus the read-only peer
      // records bot2 lives beside (ctx.knownCastles) — footprint and yard
      // ring alike, so no courtyard or fence line takes a sapling.
      const castleMod = require('../castle')
      if (castleMod.anyCastle(ctx, (c) => castleMod.inFootprint(c, spot) || castleMod.yardRing(c, spot))) return false
    } catch (_) { return false }
    try {
      if (require('../danger').near(ctx, spot)) return false
    } catch (_) { return false }
    try {
      const soilBlock = bot.blockAt(new Vec3(x, y - 1, z))
      if (protectedReason(bot, soilBlock, ctx)) return false
    } catch (_) { return false }
    return true
  } catch (_) { return false }
}

// Surface scan of one (x,z) column: the first vetted spot top-down, or
// null. Stops at the first non-air, non-leaf cell (core-4): below the
// surface is ground, not spots — a stone cap over a dirt pocket reads as
// a rejected column, never a cave planting. Tried cells are skipped, not
// fatal, so one dead row does not lose the column.
function surfaceSpotAt(bot, ctx, x, z, tried) {
  try {
    const bp = botPos(bot)
    if (!bp) return null
    const y0 = Math.floor(bp.y)
    for (let y = y0 + PLANT_UP; y >= y0 - PLANT_DOWN; y--) {
      if (tried && typeof tried.has === 'function' && tried.has(`${x},${y},${z}`)) continue
      const name = cellNameAt(bot, x, y, z)
      if (name !== 'air' && !isLeafName(name)) break
      if (plantSpotOk(bot, ctx, x, y, z)) return { x, y, z }
    }
  } catch (_) { /* no spot */ }
  return null
}

// Random vetted spot within the disc around the body, or null. Bounded
// tries; tried (walk/place-failed cells) never re-issue. rnd defaults to
// Math.random and is injectable for the unit pins.
function pickPlantSpot(bot, ctx, tried, rnd) {
  const rand = typeof rnd === 'function' ? rnd : Math.random
  try {
    const bp = botPos(bot)
    if (!bp) return null
    for (let t = 0; t < PLANT_PICK_TRIES; t++) {
      const a = rand() * Math.PI * 2
      const rr = PLANT_RADIUS * Math.sqrt(rand())
      const spot = surfaceSpotAt(bot, ctx, Math.floor(bp.x + Math.cos(a) * rr), Math.floor(bp.z + Math.sin(a) * rr), tried)
      if (spot) return spot
    }
  } catch (_) { /* no spot */ }
  return null
}

// Planting feasibility (core-2): a plantable sapling in the pack and a
// vetted spot on the deterministic probe columns — so banked saplings
// plant even where no leaves stand. Fixed offsets keep the menu stable
// across ticks; the tail still samples the full disc.
function plantFeasible(bot, ctx) {
  try {
    if (!firstSapling(bot)) return false
    const bp = botPos(bot)
    if (!bp) return false
    const x0 = Math.floor(bp.x)
    const z0 = Math.floor(bp.z)
    for (const [dx, dz] of PLANT_PROBE) {
      if (surfaceSpotAt(bot, ctx, x0 + dx, z0 + dz, null)) return true
    }
  } catch (_) { /* infeasible */ }
  return false
}

// The tail's give-up verdict: a step that planted — or beat leaves —
// keeps done (the work happened); one that did neither keeps the leaf
// verdict it came with, so empty steps read exactly as before.
function plantEndReason(r) {
  if ((r.planted || 0) > 0) return null
  if ((r.leaves || 0) > 0) return null
  return r.streak > 0 ? 'unreachable' : 'no-leaves'
}

// The beat ends (empty scan, leaf cap, wall cap, unreachable strikes)
// with saplings banked: plant them instead of ending the step (core-1).
// Returns true when the tail takes over, false when the step should
// finish as before. Stamps the tail's own time budget once.
function enterPlantTail(bot, r) {
  try {
    if ((r.planted || 0) >= PLANT_MAX || (r.plantFails || 0) >= PLANT_FAIL_MAX) return false
    if (countSaplings(bot) <= 0) return false
  } catch (_) { return false }
  if (!r.plantStartedAt) {
    try {
      r.plantStartedAt = Date.now()
    } catch (_) { /* stamp best-effort */ }
  }
  r.spot = null
  r.phase = 'plant-pick'
  return true
}

// Skip without planting: a property of the spot (unreachable, refused),
// not of the trip — the tries ride the fail budget, never the leaf
// strikes, so a bad patch cannot fail reachable ground.
function plantSkip(ctx, r, s) {
  try {
    if (!r.triedPlant) r.triedPlant = new Set()
    if (s && typeof s.x === 'number') r.triedPlant.add(`${s.x},${s.y},${s.z}`)
  } catch (_) { /* skip best-effort */ }
  r.plantFails = (r.plantFails || 0) + 1
  r.spot = null
  r.plantKey = null
  r.phase = 'plant-pick'
}

// Nearest live leaves within radius, honouring a trip skip set. Pure
// scan, no ctx writes — goal.js feasible() shares it. Sorted by 3D
// distance (revmux 01 core-1): a horizontal sort puts an overhead canopy
// leaf first and the walk then towers for it. Placed leaves never leave
// the scan (revmux 02 core-1): the persistent refusal rides
// `useExtraInfo`, so a hedge cannot crowd natural leaves past the count
// cap — findBlocks matchers that ignore it keep the per-candidate guard.
function leavesNear(bot, radius, skip) {
  let notPlaced = null
  try {
    notPlaced = (b) => {
      if (!b || typeof b.name !== 'string' || !isLeafName(b.name)) return false
      const props = typeof b.getProperties === 'function' && b.getProperties()
      return !(props && props.persistent === true)
    }
  } catch (_) {
    notPlaced = null
  }
  try {
    const ids = leafIds(bot)
    if (ids.length === 0) return []
    if (typeof bot.findBlocks !== 'function') return []
    const opts = { matching: ids, maxDistance: radius, count: 16 }
    if (notPlaced) opts.useExtraInfo = notPlaced
    const found = bot.findBlocks(opts) || []
    const bp = botPos(bot)
    const open = found.filter((p) => !(skip && typeof skip.has === 'function' && skip.has(keyOf(p))))
    open.sort((a, b) => {
      try {
        if (!bp) return 0
        return Math.hypot(a.x - bp.x, a.y - bp.y, a.z - bp.z) -
          Math.hypot(b.x - bp.x, b.y - bp.y, b.z - bp.z)
      } catch (_) {
        return 0
      }
    })
    return open
  } catch (_) {
    return []
  }
}

// Beatable leaves (revmux 02 core-3): feet-level, natural cells the walk
// can reach without towering. Single source for the find pick and the
// feasibility gate, so no-leaves means the same set both places.
function beatablesNear(bot, radius, skip) {
  try {
    const bp = botPos(bot)
    if (!bp) return []
    return leavesNear(bot, radius, skip).filter((p) => Math.abs(p.y - bp.y) <= LOW_DY)
  } catch (_) {
    return []
  }
}

// Player-placed leaves (revmux 01 core-2): natural leaves decay
// (persistent=false), placed ones do not — hedges and roofs near home
// must never become idle-beat targets.
function isPersistentLeaf(bot, p) {
  try {
    const b = bot.blockAt && bot.blockAt(asVec3(p))
    const props = b && typeof b.getProperties === 'function' && b.getProperties()
    return !!(props && props.persistent === true)
  } catch (_) {
    return false
  }
}

// Feasibility predicate (bead acceptance pin): day, no active castle
// order (a castle would lose body time — qxql.2), pack room for the
// pickups, and a beatable leaf in reach (the same set the find pick
// takes, so the menu never promises what the step cannot do) — or, with
// no leaves around, banked saplings and a vetted plant spot (the tail
// picks up what the menu promises).
// Unscannable bots read infeasible so the menu never changes for them.
function reforestFeasible(facts, bot, ctx) {
  try {
    if (!facts || facts.time !== 'day') return false
    try {
      if (require('./explore').castleActive(ctx)) return false
    } catch (_) {
      return false
    }
    try {
      if (require('./stockpile').packFull(bot, ctx)) return false
    } catch (_) {
      return false
    }
    if (beatablesNear(bot, REFOREST_RADIUS, null).length > 0) return true
    // Banked saplings plant even where no leaves stand (core-2): the step
    // is picked for the tail when a vetted spot exists.
    try {
      return plantFeasible(bot, ctx)
    } catch (_) {
      return false
    }
  } catch (_) {
    return false
  }
}

function asVec3(p) {
  if (!p || typeof p.floored === 'function') return p
  return new Vec3(p.x, p.y, p.z)
}

function finish(bot, ctx, r, reason) {
  const leaves = (r && r.leaves) || 0
  const planted = (r && r.planted) || 0
  // saplings=+k banks the step's beats even when the tail plants them the
  // same step (body-3): without the add-back a bank-3-plant-3 step would
  // read +0.
  let gain = 0
  try {
    gain = Math.max(0, countSaplings(bot) - ((r && r.saplings0) || 0) + planted)
  } catch (_) {
    gain = 0
  }
  try {
    clearGoal(bot, ctx)
  } catch (_) { /* goal best-effort */ }
  try {
    ctx.reforest = null
  } catch (_) { /* state best-effort */ }
  try {
    console.log(`reforest leaves=${leaves} saplings=+${gain} fail=${reason || '-'} planted=${planted}`)
  } catch (_) { /* log best-effort */ }
  if (!reason) stepDone(ctx)
  else stepFailed(ctx, reason)
}

function strike(ctx, r, p) {
  try {
    if (!r.skip) r.skip = new Set()
    if (p && typeof p.x === 'number') r.skip.add(keyOf(p))
  } catch (_) { /* skip best-effort */ }
  r.streak = (r.streak || 0) + 1
  r.pos = null
  r.phase = 'find'
}

// Skip without a strike: a property of the cell (placed, denied), not of
// the trip — beating the strike budget for it would fail reachable ground.
function skipNoStrike(ctx, r, p) {
  try {
    if (!r.skip) r.skip = new Set()
    if (p && typeof p.x === 'number') r.skip.add(keyOf(p))
  } catch (_) { /* skip best-effort */ }
  r.pos = null
  r.phase = 'find'
}

function reforest(bot, ctx, target, state) {
  try {
    if (ctx && ctx.stepStatus && ctx.stepStatus !== 'running') return
  } catch (_) { /* status unreadable: run */ }
  if (!ctx.reforest) {
    let saplings0 = 0
    try {
      saplings0 = countSaplings(bot)
    } catch (_) {
      saplings0 = 0
    }
    ctx.reforest = { phase: 'find', pos: null, block: null, skip: new Set(), streak: 0, stalls: 0, lastPos: null, leaves: 0, saplings0, startedAt: Date.now(), pickupTicks: 0, planted: 0, plantFails: 0, triedPlant: new Set(), plantInFlight: false, spot: null, plantKey: null, plantStalls: 0, plantLast: null, plantStartedAt: null }
  }
  const r = ctx.reforest
  const bp = botPos(bot)
  if (!bp) return
  // Caps: a beaten-leaf count or a wall-time bound ends the beat — never
  // an infinite beat loop — while the plant tail runs on its own count
  // and time budget (core-1): a dense forest beats its 8 leaves and then
  // plants, instead of finishing with planted=0.
  const planting = r.phase === 'plant-pick' || r.phase === 'plant-walk' || r.phase === 'plant-place'
  try {
    if (planting) {
      if ((r.planted || 0) >= PLANT_MAX || (r.plantFails || 0) >= PLANT_FAIL_MAX ||
        (r.plantStartedAt && Date.now() - r.plantStartedAt >= REFOREST_MAX_MS)) {
        finish(bot, ctx, r, plantEndReason(r))
        return
      }
    } else if (r.leaves >= REFOREST_MAX_LEAVES || Date.now() - r.startedAt >= REFOREST_MAX_MS) {
      if (!enterPlantTail(bot, r)) {
        finish(bot, ctx, r, null)
        return
      }
      return
    }
  } catch (_) { /* cap unreadable: run */ }
  // A full pack banks through stockpile/deliver instead of scattering
  // drops (task.js preempts the same way for gather/forage).
  try {
    if (require('./stockpile').packFull(bot, ctx)) {
      finish(bot, ctx, r, 'pack-full')
      return
    }
  } catch (_) { /* room unreadable: run */ }
  const grounded = !bot.entity || bot.entity.onGround !== false

  if (r.phase === 'find') {
    let found = []
    try {
      found = beatablesNear(bot, REFOREST_RADIUS, r.skip)
    } catch (_) {
      found = []
    }
    // First beater wins; a useExtraInfo-blind scan can still surface a
    // placed cell, which is skipped trip-scoped, never struck.
    let pick = null
    for (const p of found) {
      if (isPersistentLeaf(bot, p)) {
        skipNoStrike(ctx, r, p)
        continue
      }
      pick = p
      break
    }
    if (!pick) {
      // Nothing beatable (no low natural leaves): the plant tail (lc55)
      // when saplings are banked — never tower, never an endless phase.
      if (!enterPlantTail(bot, r)) {
        finish(bot, ctx, r, r.streak > 0 ? 'unreachable' : 'no-leaves')
        return
      }
      return
    }
    r.pos = asVec3(pick)
    try {
      const b = bot.blockAt && bot.blockAt(r.pos)
      r.block = b && isLeafName(b.name) ? b : null
    } catch (_) {
      r.block = null
    }
    r.phase = 'walk'
    r.stalls = 0
    r.lastPos = { x: bp.x, y: bp.y, z: bp.z }
    return
  }

  if (r.phase === 'walk') {
    if (!r.pos) {
      r.phase = 'find'
      return
    }
    const key = `reforest:${Math.floor(r.pos.x)},${Math.floor(r.pos.y)},${Math.floor(r.pos.z)}`
    if (key !== ctx.lastGoalKey) {
      issueGoal(bot, ctx, new goals.GoalNear(r.pos.x, r.pos.y, r.pos.z, WALK_RANGE), key, false)
      try {
        ctx.lastPathStatus = 'none'
      } catch (_) { /* verdict best-effort */ }
      r.stalls = 0
      r.lastPos = { x: bp.x, y: bp.y, z: bp.z }
      return
    }
    let verdict = null
    try {
      verdict = ctx.lastPathStatus
    } catch (_) {
      verdict = null
    }
    if (verdict === 'noPath') {
      try {
        ctx.lastPathStatus = 'none'
      } catch (_) { /* verdict best-effort */ }
      strike(ctx, r, r.pos)
      if (r.streak >= UNREACHABLE_STRIKES) {
        say(bot, 'cannot reach the leaves')
        // Banked saplings still plant (core-1): the tail keeps the
        // unreachable verdict when it plants nothing.
        if (!enterPlantTail(bot, r)) finish(bot, ctx, r, 'unreachable')
      }
      return
    }
    let progressed = false
    try {
      progressed = bring.progressed(bp, r.lastPos, grounded)
    } catch (_) {
      progressed = false
    }
    if (progressed) {
      r.stalls = 0
      r.lastPos = { x: bp.x, y: bp.y, z: bp.z }
    } else if (++r.stalls >= WALK_STALL_TICKS) {
      strike(ctx, r, r.pos)
      if (r.streak >= UNREACHABLE_STRIKES) {
        say(bot, 'cannot reach the leaves')
        // Banked saplings still plant (core-1): the tail keeps the
        // unreachable verdict when it plants nothing.
        if (!enterPlantTail(bot, r)) finish(bot, ctx, r, 'unreachable')
      }
      return
    }
    let block = null
    try {
      block = bot.blockAt && bot.blockAt(r.pos)
    } catch (_) {
      block = null
    }
    if (!block || !isLeafName(block.name)) {
      // Chopped by decay or a stale read-back: rescan, no strike.
      r.pos = null
      r.phase = 'find'
      return
    }
    if (isPersistentLeaf(bot, r.pos)) {
      // Placed after the scan (or a hedge the scan could not tell): skip
      // trip-scoped, never struck.
      skipNoStrike(ctx, r, r.pos)
      return
    }
    let diggable = true
    try {
      diggable = typeof bot.canDigBlock === 'function' ? bot.canDigBlock(block) : true
    } catch (_) {
      diggable = false
    }
    // In reach already: stop the walk and dig (revmux 01 core-1) — waiting
    // for the executor to settle first would pillar under a canopy leaf.
    if (diggable) {
      try {
        clearGoal(bot, ctx)
      } catch (_) { /* goal best-effort */ }
      r.phase = 'dig'
      r.block = block
    }
    return
  }

  if (r.phase === 'dig') {
    // Exactly one dig at a time: while it is in flight, wait (gather's
    // rule — digging every tick breaks the executor and the count).
    if (ctx.digInFlight) return
    if (typeof bot.dig !== 'function') {
      strike(ctx, r, r.pos)
      if (r.streak >= UNREACHABLE_STRIKES && !enterPlantTail(bot, r)) finish(bot, ctx, r, 'unreachable')
      return
    }
    let block = r.block
    try {
      const live = bot.blockAt && r.pos && bot.blockAt(r.pos)
      if (live && isLeafName(live.name)) block = live
    } catch (_) { /* re-read best-effort */ }
    if (!block || !isLeafName(block.name)) {
      r.pos = null
      r.phase = 'find'
      return
    }
    let deny = null
    try {
      deny = denyReason(bot, block, ctx)
    } catch (_) {
      deny = null
    }
    if (deny) {
      // A denied leaf (e.g. protected ground) is skipped trip-scoped,
      // like gather's trap denials — no strike for a property of the cell.
      strike(ctx, r, r.pos)
      r.streak = Math.max(0, (r.streak || 1) - 1)
      return
    }
    ctx.digInFlight = true
    const run = async () => {
      try {
        await bot.dig(block)
      } catch (_) { /* gone or interrupted: count anyway */ }
      ctx.digInFlight = false
      try {
        r.leaves = (r.leaves || 0) + 1
        r.pickupTicks = 0
        r.phase = 'pickup'
      } catch (_) { /* state best-effort */ }
    }
    void run()
    return
  }

  if (r.phase === 'pickup') {
    // The dug cell's drops fall to the ground and vacuum in by proximity —
    // walk onto the dug column (XZ only, never the empty canopy cell
    // above), then take the next leaf. The inventory count at finish is
    // the truth. The give-up tick bound keeps a scattered drop from
    // holding the step, like forage's replan.
    const key = `reforest-pickup:${Math.floor(r.pos.x)},${Math.floor(r.pos.y)},${Math.floor(r.pos.z)}`
    if (key !== ctx.lastGoalKey) {
      issueGoal(bot, ctx, new goals.GoalNearXZ(r.pos.x, r.pos.z, PICKUP_RANGE), key, false)
      r.pickupTicks = 0
      return
    }
    r.pickupTicks = (r.pickupTicks || 0) + 1
    let d = null
    try {
      d = Math.hypot(bp.x - (Math.floor(r.pos.x) + 0.5), bp.z - (Math.floor(r.pos.z) + 0.5))
    } catch (_) {
      d = null
    }
    if ((d !== null && d <= PICKUP_CLOSE) || r.pickupTicks >= PICKUP_TICKS) {
      r.pos = null
      r.phase = 'find'
    }
    return
  }

  if (r.phase === 'plant-pick') {
    // One vetted random spot, or the tail ends with what it planted.
    if ((r.planted || 0) >= PLANT_MAX || (r.plantFails || 0) >= PLANT_FAIL_MAX) {
      finish(bot, ctx, r, plantEndReason(r))
      return
    }
    if (!firstSapling(bot)) {
      finish(bot, ctx, r, plantEndReason(r))
      return
    }
    const spot = pickPlantSpot(bot, ctx, r.triedPlant)
    if (!spot) {
      finish(bot, ctx, r, plantEndReason(r))
      return
    }
    r.spot = spot
    r.phase = 'plant-walk'
    r.plantStalls = 0
    r.plantLast = { x: bp.x, y: bp.y, z: bp.z }
    return
  }

  if (r.phase === 'plant-walk') {
    if (!r.spot) {
      r.phase = 'plant-pick'
      return
    }
    if (!firstSapling(bot)) {
      finish(bot, ctx, r, plantEndReason(r))
      return
    }
    const s = r.spot
    const key = `reforest-plant:${Math.floor(s.x)},${Math.floor(s.y)},${Math.floor(s.z)}`
    if (key !== ctx.lastGoalKey) {
      issueGoal(bot, ctx, new goals.GoalNear(s.x, s.y, s.z, WALK_RANGE), key, false)
      try {
        ctx.lastPathStatus = 'none'
      } catch (_) { /* verdict best-effort */ }
      r.plantStalls = 0
      r.plantLast = { x: bp.x, y: bp.y, z: bp.z }
      return
    }
    let verdict = null
    try {
      verdict = ctx.lastPathStatus
    } catch (_) {
      verdict = null
    }
    if (verdict === 'noPath') {
      try {
        ctx.lastPathStatus = 'none'
      } catch (_) { /* verdict best-effort */ }
      plantSkip(ctx, r, s)
      return
    }
    let progressed = false
    try {
      progressed = bring.progressed(bp, r.plantLast, grounded)
    } catch (_) {
      progressed = false
    }
    if (progressed) {
      r.plantStalls = 0
      r.plantLast = { x: bp.x, y: bp.y, z: bp.z }
    } else if (++r.plantStalls >= WALK_STALL_TICKS) {
      plantSkip(ctx, r, s)
      return
    }
    // Arrival stops the walk while the soil is in place reach (the leaf
    // walk's canDigBlock gate): the goal stays issued under the place, so
    // the flight below can pin body ownership on its key.
    let pd = null
    try {
      pd = Math.hypot(bp.x - (s.x + 0.5), bp.y - (s.y + 0.5), bp.z - (s.z + 0.5))
    } catch (_) {
      pd = null
    }
    if (pd !== null && pd <= PLANT_REACH) {
      r.phase = 'plant-place'
      r.plantKey = key
    }
    return
  }

  if (r.phase === 'plant-place') {
    // Exactly one placement in flight at a time, like the leaf dig — and
    // one placement GLOBALLY (the shared seam every placer honours).
    if (r.plantInFlight) return
    if (ctx && ctx.placeInFlight) return
    const s = r.spot
    const key = r.plantKey
    if (!s || !key || (ctx && ctx.lastGoalKey) !== key) {
      // Body changed hands after arrival (fight took it): drop the spot,
      // never a fighter's sword for a sapling.
      plantSkip(ctx, r, s)
      return
    }
    const sapling = firstSapling(bot)
    if (!sapling) {
      finish(bot, ctx, r, plantEndReason(r))
      return
    }
    if (!plantSpotOk(bot, ctx, s.x, s.y, s.z)) {
      plantSkip(ctx, r, s)
      return
    }
    let soilRef = null
    try {
      soilRef = bot.blockAt && bot.blockAt(new Vec3(s.x, s.y - 1, s.z))
    } catch (_) {
      soilRef = null
    }
    if (!soilRef || !soilRef.position) {
      plantSkip(ctx, r, s)
      return
    }
    if (typeof bot.equip !== 'function' || typeof bot.placeBlock !== 'function') {
      plantSkip(ctx, r, s)
      return
    }
    r.plantInFlight = true
    ctx.placeInFlight = true
    const had = r.planted || 0
    const run = async () => {
      try {
        await bot.equip(sapling, 'hand')
        // The world and the body can change hands across the equip await
        // (gather's replant rule): re-pin ownership and the open vetted
        // spot before placing. bot.placeBlock itself rides the shared
        // feetClear wrapper (util.js installPlaceTiming).
        if ((ctx && ctx.lastGoalKey) !== key) return
        if (!plantSpotOk(bot, ctx, s.x, s.y, s.z)) return
        await bot.placeBlock(soilRef, new Vec3(0, 1, 0))
        // Honest accounting: the cell must read back as the sapling, or
        // the attempt counts as a refusal, never a planting.
        let landed = null
        try {
          landed = bot.blockAt && bot.blockAt(new Vec3(s.x, s.y, s.z))
        } catch (_) { landed = null }
        if (!landed || landed.name !== sapling.name) return
        r.planted = (r.planted || 0) + 1
        try {
          console.log(`reforest plant ${sapling.name} at ${s.x},${s.y},${s.z}`)
        } catch (_) { /* log best-effort */ }
      } catch (_) { /* one attempt: the spot stays bare */ }
      finally {
        if ((r.planted || 0) === had) r.plantFails = (r.plantFails || 0) + 1
        else if (r.triedPlant) {
          try {
            r.triedPlant.add(`${s.x},${s.y},${s.z}`)
          } catch (_) { /* skip best-effort */ }
        }
        r.plantInFlight = false
        ctx.placeInFlight = false
        r.spot = null
        r.plantKey = null
        r.phase = 'plant-pick'
      }
    }
    void run()
    return
  }

  // Unknown phase (restored legacy state): rescan.
  r.phase = 'find'
}

module.exports = reforest
module.exports.leafNames = leafNames
module.exports.leafIds = leafIds
module.exports.isLeafName = isLeafName
module.exports.isPersistentLeaf = isPersistentLeaf
module.exports.isSaplingName = isSaplingName
module.exports.countSaplings = countSaplings
module.exports.leavesNear = leavesNear
module.exports.beatablesNear = beatablesNear
module.exports.reforestFeasible = reforestFeasible
module.exports.REFOREST_RADIUS = REFOREST_RADIUS
module.exports.REFOREST_MAX_LEAVES = REFOREST_MAX_LEAVES
module.exports.REFOREST_MAX_MS = REFOREST_MAX_MS
module.exports.WALK_STALL_TICKS = WALK_STALL_TICKS
module.exports.PICKUP_TICKS = PICKUP_TICKS
module.exports.UNREACHABLE_STRIKES = UNREACHABLE_STRIKES
module.exports.WALK_RANGE = WALK_RANGE
module.exports.PICKUP_RANGE = PICKUP_RANGE
module.exports.LOW_DY = LOW_DY
module.exports.firstSapling = firstSapling
module.exports.plantSpotOk = plantSpotOk
module.exports.surfaceSpotAt = surfaceSpotAt
module.exports.pickPlantSpot = pickPlantSpot
module.exports.plantFeasible = plantFeasible
module.exports.PLANT_RADIUS = PLANT_RADIUS
module.exports.PLANT_MAX = PLANT_MAX
module.exports.PLANT_PICK_TRIES = PLANT_PICK_TRIES
module.exports.PLANT_FAIL_MAX = PLANT_FAIL_MAX
module.exports.PLANT_REACH = PLANT_REACH
