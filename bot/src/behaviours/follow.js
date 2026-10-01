'use strict'

const { goals } = require('mineflayer-pathfinder')
const stuck = require('../stuck')

const FOLLOW_RANGE = 3
const SEARCH_TIMEOUT_MS = 6000

// Follow behaviour with spaced re-issue and no stuck detector of its own:
// Avoids tearing down running A* search every tick while stationary.
// Re-issues GoalFollow after a terminal path status (noPath/timeout/empty
// success) or after 6 s without path_update — follow never gives up on the
// player (5vv owner decision): no stuck fact, no recover menu, no
// call_player on a stale plan. Wedges belong to the single detector in
// stuck.js (fast entry off the follow key); the only reset follow reads is
// the replan knock below, via stuck.verdict().
function follow(bot, ctx, target, state) {
  ctx.followRan = true // lease stash: movementsFor sprints only on a fresh follow key (body.js)
  if (!target) return
  const key = `follow:${target.username || target.id}`
  const now = Date.now()
  const bp = bot.entity && bot.entity.position

  if (key !== ctx.lastGoalKey) {
    ctx.lastPathNodes = null
    bot.pathfinder.setGoal(new goals.GoalFollow(target, FOLLOW_RANGE), true)
    ctx.lastGoalKey = key
    ctx.followIssuedAt = now
    ctx.followSeenStuck = 0
    return
  }
  // Flat-pursuit sprint (5vv) lives in body.js movementsFor now: the
  // post-dispatch refresh re-evaluates the same gate with fresh keys.
  const isMoving = bot.pathfinder && typeof bot.pathfinder.isMoving === 'function' ? bot.pathfinder.isMoving() : false

  // Wedged executor: the pathfinder keeps reporting isMoving() while its
  // own 3.5 s 'stuck' reset replans the identical move. The wedge itself is
  // the central detector's (stuck.js fast entry raises by=follow off two
  // resets with no displacement); a single fresh reset while the executor
  // still moves is a passing knock, not a wedge (a walking player
  // re-anchors GoalFollow faster than the 3.5 s window): just replan to
  // their current position.
  if (isMoving) {
    // Seen-marker (body-1): the streak is the central detector's and drops
    // on displacement — resync down with it, or the replan knock fires once
    // per pursuit and every later knock escalates to the menu instead.
    const resets = stuck.verdict(ctx).resets
    if (resets < (ctx.followSeenStuck || 0)) ctx.followSeenStuck = resets
    if (resets > (ctx.followSeenStuck || 0)) {
      ctx.followSeenStuck = resets
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
  // (and call_player at its end) is reserved for the real wedge the
  // central detector owns.
  bot.pathfinder.setGoal(new goals.GoalFollow(target, FOLLOW_RANGE), true)
  ctx.followIssuedAt = now
}

module.exports = follow
