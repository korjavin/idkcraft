'use strict'

const { goals } = require('mineflayer-pathfinder')
const recover = require('./recover')

const FOLLOW_RANGE = 3
const SEARCH_TIMEOUT_MS = 6000
const FOLLOW_SPRINT_DIST = 8 // far pursuit: walking (4.3 b/s) bleeds ~1.4 b/s against a runner (5.6 b/s)
const FOLLOW_SPRINT_LOOKAHEAD = 6 // blocks covered in one sprint tick: every node inside must be level
const MOVE_TOLERANCE = 0.5
const PLACE_ERROR_STALLS = 3 // consecutive place_error resets with no displacement count as a stall (same counter gather.js uses)

// Block name at a feet/head/next cell for the wedge line (b50): the prod
// trap showed position alone never names the relief. Positions must stay
// Vec3: real blockAt calls pos.floored() and throws on plain {x,y,z}.
// Guarded: mocks and unloaded cells read '?'.
function blockNameAt(bot, p) {
  try {
    const b = p && typeof p.floored === 'function' && bot.blockAt && bot.blockAt(p)
    return (b && b.name) || '?'
  } catch (_) { return '?' }
}

function formatPos(p) {
  if (!p) return 'unknown'
  const fx = typeof p.x === 'number' ? (Number.isInteger(p.x) ? p.x : p.x.toFixed(1)) : '0'
  const fy = typeof p.y === 'number' ? (Number.isInteger(p.y) ? p.y : p.y.toFixed(1)) : '0'
  const fz = typeof p.z === 'number' ? (Number.isInteger(p.z) ? p.z : p.z.toFixed(1)) : '0'
  return `${fx},${fy},${fz}`
}

// Follow behaviour with spaced re-issue and a stuck detector:
// Avoids tearing down running A* search every tick while stationary.
// Re-issues GoalFollow after a terminal path status (noPath/timeout/empty
// success) or after 6 s without path_update — follow never gives up on the
// player (5vv owner decision): no stuck fact, no recover menu, no
// call_player on a stale plan. The recover menu opens only for a real
// wedge: the executor reports moving while 'stuck'/place_error resets
// pile up with no displacement.
function follow(bot, ctx, target, state) {
  if (!target) return
  const key = `follow:${target.username || target.id}`
  const now = Date.now()
  const bp = bot.entity && bot.entity.position

  if (key !== ctx.lastGoalKey) {
    ctx.lastPathNodes = null
    bot.pathfinder.setGoal(new goals.GoalFollow(target, FOLLOW_RANGE), true)
    if (!ctx.recoverLatch || ctx.recoverLatch.key !== key) ctx.recoverLatch = null
    const prevKey = ctx.lastGoalKey
    ctx.lastGoalKey = key
    ctx.followIssuedAt = now
    if (key !== ctx.followIssuedKey || prevKey === '' || prevKey === 'idle') {
      // A new pursuit (another target, or an explicit fresh order after
      // stop/work): fresh wedge budget. Retaking the SAME target after a
      // fight/bring tick stole the body (68p) only re-issues the stolen
      // goal — stuckResets, seen-stuck, placeErrors and lastPos survive, so the
      // reset happens on displacement or a new goal, never on a key flip.
      ctx.followIssuedKey = key
      ctx.followSeenStuck = 0
      ctx.followLastPos = bp ? bp.clone() : null
      ctx.stuckResets = 0
      ctx.placeErrors = 0
    }
    return
  }
  // Flat-pursuit sprint (5vv): sprint only when far and every plan node
  // within one sprint tick is level with the feet; a +1 anywhere in the
  // window kills it before the sprint-jump can wedge against the step face
  // (3nt.24, revmux 5vv round 1: the head alone is stale and too narrow).
  // Planning rides the same movements object, so the window also holds
  // parkour off — a maxD=4 plan would strand the next sprint-off tick.
  // runTick restores both defaults on every tick follow does not own.
  try {
    const mov = ctx && ctx.movements
    if (mov && typeof mov.allowSprinting === 'boolean') {
      const d = typeof state?.distance_to_player === 'number'
        ? state.distance_to_player
        : (bp && target.position ? bp.distanceTo(target.position) : null)
      const nodes = ctx.lastPathNodes
      const flat = !!(bp && Array.isArray(nodes) && nodes.length > 0 && nodes.every((n) => {
        if (!n || typeof n.y !== 'number') return false
        if (typeof n.x === 'number' && typeof n.z === 'number' &&
          Math.hypot(n.x - bp.x, n.z - bp.z) > FOLLOW_SPRINT_LOOKAHEAD) return true
        return Math.floor(n.y) === Math.floor(bp.y)
      }))
      const sprint = d !== null && d > FOLLOW_SPRINT_DIST && flat
      mov.allowSprinting = sprint
      if (typeof mov.allowParkour === 'boolean') mov.allowParkour = !sprint
    }
  } catch (_) { /* sprint best-effort */ }

  const isMoving = bot.pathfinder && typeof bot.pathfinder.isMoving === 'function' ? bot.pathfinder.isMoving() : false

  if (ctx.followLastPos && bp) {
    if (bp.distanceTo(ctx.followLastPos) > MOVE_TOLERANCE) {
      ctx.followSeenStuck = 0
      ctx.stuckResets = 0
      ctx.placeErrors = 0
      ctx.followLastPos = bp.clone()
    }
  } else if (bp) {
    ctx.followLastPos = bp.clone()
  }

  // Wedged executor: the pathfinder keeps reporting isMoving() while its
  // own 3.5 s 'stuck' reset replans the identical move, so the terminal
  // stall counter below never advances. Two 'stuck' resets with no
  // displacement since the last progress count as a stall even while moving.
  // A place_error streak (2oe: 60 resets with no wedge in prod) counts the
  // same way — the ticker already counts them in ctx.placeErrors.
  // Recovery is the usual sidestep: issuing GoalNear empties the stale
  // executor path (resetPath) and plans 2 blocks sideways + one-tick jump.
  // (No setGoal(null) first: it only repeats that same resetPath, reaches no
  // fullStop, and emits a spurious path_reset; stop() is worse — its latch
  // would swallow the GoalNear issued in the same tick.)
  // Known limit: 'stuck' fires only after 3.5 s without any path reset, and a
  // walking player re-anchors GoalFollow (goal_moved) faster than that, so
  // this branch cannot fire while the followed player keeps moving — the bot
  // un-wedges once they stand still (~7 s). A displacement-only trigger is
  // future work; it needs live tuning against the while-moving protection
  // window, not a new constant picked blind.
  if (isMoving) {
    if ((ctx.stuckResets || 0) >= 2 || (ctx.placeErrors || 0) >= PLACE_ERROR_STALLS) {
      const dist = typeof state?.distance_to_player === 'number'
        ? state.distance_to_player.toFixed(1)
        : (bp && target.position ? bp.distanceTo(target.position).toFixed(1) : 'none')
      const feetP = bp && typeof bp.floored === 'function' ? bp.floored() : null
      const headP = feetP && typeof feetP.offset === 'function' ? feetP.offset(0, 1, 0) : null
      const next = ctx.lastPathNext
      const nextStr = next ? `${next.x},${next.y},${next.z}:${blockNameAt(bot, next)}` : '?:?'
      const gp = target.position ? { x: target.position.x, y: target.position.y, z: target.position.z } : null
      if (recover.setStuck(ctx, 'follow', gp, `follow:${target.username || target.id}`)) console.log(`stuck reason=wedge pos=${formatPos(bp)} dist=${dist} feet=${blockNameAt(bot, feetP)} head=${blockNameAt(bot, headP)} next=${nextStr}`)
      ctx.followSeenStuck = 0
      ctx.stuckResets = 0
      ctx.placeErrors = 0
      ctx.followIssuedAt = now
      return
    }
    // A fresh 'stuck' reset while the executor still moves is a passing
    // knock, not a wedge (a walking player re-anchors GoalFollow faster
    // than the 3.5 s window): just replan to their current position.
    if ((ctx.stuckResets || 0) > (ctx.followSeenStuck || 0)) {
      ctx.followSeenStuck = ctx.stuckResets || 0
      bot.pathfinder.setGoal(new goals.GoalFollow(target, FOLLOW_RANGE), true)
      ctx.followIssuedAt = now
      return
    }
    ctx.followIssuedAt = now
    return
  }

  // Goal satisfied: resting within follow range of the player's current position
  // is not a stall. Evaluates floored block coordinates against current target pos.
  const node = bp && (typeof bp.floored === 'function' ? bp.floored() : { x: Math.floor(bp.x), y: Math.floor(bp.y), z: Math.floor(bp.z) })
  const satisfied = node && target.position ? new goals.GoalFollow(target, FOLLOW_RANGE).isEnd(node) : false
  if (satisfied) {
    return
  }

  const status = ctx.lastPathStatus || 'none'
  const isTerminal = status === 'noPath' || status === 'timeout' || (status === 'success' && !isMoving)
  const timedOut = (now - (ctx.followIssuedAt || 0)) >= SEARCH_TIMEOUT_MS

  if (!isTerminal && !timedOut) {
    return
  }

  // Stale plan, no movement: re-issue GoalFollow to the player's
  // current position. Follow never raises stuck here — the recover menu
  // (and call_player at its end) is reserved for the real wedge above.
  bot.pathfinder.setGoal(new goals.GoalFollow(target, FOLLOW_RANGE), true)
  ctx.followIssuedAt = now
}

module.exports = follow
