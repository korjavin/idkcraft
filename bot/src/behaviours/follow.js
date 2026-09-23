'use strict'

const { goals } = require('mineflayer-pathfinder')
const recover = require('./recover')

const FOLLOW_RANGE = 3
const SEARCH_TIMEOUT_MS = 6000
const MAX_STALLS = 2
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
// Re-issues GoalFollow only after a terminal path status (noPath/timeout/empty success)
// or after 6 s without path_update. After 2 terminal results from the same spot,
// raises the stuck fact (ef3) and the recover menu picks the escape.
function follow(bot, ctx, target, state) {
  if (!target) return
  const key = `follow:${target.username || target.id}`
  const now = Date.now()
  const bp = bot.entity && bot.entity.position

  if (key !== ctx.lastGoalKey) {
    bot.pathfinder.setGoal(new goals.GoalFollow(target, FOLLOW_RANGE), true)
    if (!ctx.recoverLatch || ctx.recoverLatch.key !== key) ctx.recoverLatch = null
    const prevKey = ctx.lastGoalKey
    ctx.lastGoalKey = key
    ctx.followIssuedAt = now
    if (key !== ctx.followIssuedKey || prevKey === '' || prevKey === 'idle') {
      // A new pursuit (another target, or an explicit fresh order after
      // stop/work): fresh stall budget. Retaking the SAME target after a
      // fight/bring tick stole the body (68p) only re-issues the stolen
      // goal — stalls, stuckResets, placeErrors and lastPos survive, so the
      // reset happens on displacement or a new goal, never on a key flip.
      ctx.followIssuedKey = key
      ctx.followStalls = 0
      ctx.followLastPos = bp ? bp.clone() : null
      ctx.stuckResets = 0
      ctx.placeErrors = 0
    }
    return
  }

  const isMoving = bot.pathfinder && typeof bot.pathfinder.isMoving === 'function' ? bot.pathfinder.isMoving() : false

  if (ctx.followLastPos && bp) {
    if (bp.distanceTo(ctx.followLastPos) > MOVE_TOLERANCE) {
      ctx.followStalls = 0
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
      ctx.followStalls = 0
      ctx.stuckResets = 0
      ctx.placeErrors = 0
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
    ctx.followStalls = 0
    return
  }

  const status = ctx.lastPathStatus || 'none'
  const isTerminal = status === 'noPath' || status === 'timeout' || (status === 'success' && !isMoving)
  const timedOut = (now - (ctx.followIssuedAt || 0)) >= SEARCH_TIMEOUT_MS

  if (!isTerminal && !timedOut) {
    return
  }

  const reason = isTerminal ? status : 'timeout'
  ctx.followStalls = (ctx.followStalls || 0) + 1

  if (ctx.followStalls >= MAX_STALLS) {
    const dist = typeof state?.distance_to_player === 'number'
      ? state.distance_to_player.toFixed(1)
      : (bp && target.position ? bp.distanceTo(target.position).toFixed(1) : 'none')
    const gp = target.position ? { x: target.position.x, y: target.position.y, z: target.position.z } : null
    if (recover.setStuck(ctx, 'follow', gp, `follow:${target.username || target.id}`)) console.log(`stuck reason=${reason} pos=${formatPos(bp)} dist=${dist}`)
    ctx.followStalls = 0
    ctx.followIssuedAt = now
  } else {
    bot.pathfinder.setGoal(new goals.GoalFollow(target, FOLLOW_RANGE), true)
    ctx.followIssuedAt = now
  }
}

module.exports = follow
