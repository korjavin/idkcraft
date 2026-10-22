'use strict'

// Reforest-1 step (idkcraft-6p4l): beat nearby leaves and bank the dropped
// saplings during idle time. Picked by the goal FSM between forage and
// explore (STEP_ORDER) when nothing better is feasible: the gather path
// below stays untouched (v1 frozen — foliage was never its target).
//
// Phase machine, same shape as gather.js: find (live registry scan) ->
// walk (GoalNear + displacement stalls) -> dig -> pickup (proximity
// vacuum), capped by leaf count or wall time — never an infinite beat
// loop. Planting is the follow-up bead (lc55), NOT this one: no
// placeBlock here. Completion goes through step.js only, with one prod
// line per step: reforest leaves=<n> saplings=+<k> fail=<reason|->.

const { goals } = require('mineflayer-pathfinder')
const { Vec3 } = require('vec3')
const bring = require('./bringbase') //oqul.14: progressed() displacement check lives in the leaf
const { stepDone, stepFailed } = require('../step') // oqul.6: status writes go through step.js
const { say, clearGoal, issueGoal, botPos, denyReason } = require('./util')
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
// takes, so the menu never promises what the step cannot do).
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
    return beatablesNear(bot, REFOREST_RADIUS, null).length > 0
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
  let gain = 0
  try {
    gain = Math.max(0, countSaplings(bot) - ((r && r.saplings0) || 0))
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
    console.log(`reforest leaves=${leaves} saplings=+${gain} fail=${reason || '-'}`)
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
    ctx.reforest = { phase: 'find', pos: null, block: null, skip: new Set(), streak: 0, stalls: 0, lastPos: null, leaves: 0, saplings0, startedAt: Date.now(), pickupTicks: 0 }
  }
  const r = ctx.reforest
  const bp = botPos(bot)
  if (!bp) return
  // Caps: a beaten-leaf count or a wall-time bound ends the phase with
  // done — never an infinite beat loop.
  try {
    if (r.leaves >= REFOREST_MAX_LEAVES || Date.now() - r.startedAt >= REFOREST_MAX_MS) {
      finish(bot, ctx, r, null)
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
      // Nothing beatable (no low natural leaves): fail, never tower.
      finish(bot, ctx, r, r.streak > 0 ? 'unreachable' : 'no-leaves')
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
        finish(bot, ctx, r, 'unreachable')
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
        finish(bot, ctx, r, 'unreachable')
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
      if (r.streak >= UNREACHABLE_STRIKES) finish(bot, ctx, r, 'unreachable')
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
