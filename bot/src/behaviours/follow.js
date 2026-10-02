'use strict'

const { goals } = require('mineflayer-pathfinder')
const stuck = require('../stuck')

const FOLLOW_RANGE = 3
const SEARCH_TIMEOUT_MS = 6000

// Follow with spaced re-issue: no A* teardown every tick while stationary.
// Re-issues GoalFollow after a terminal path status (noPath/timeout/empty
// success) or 6 s without path_update. Follow never gives up on the player
// (5vv): wedges belong to stuck.js (fast entry off the follow key).
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

  // A fresh 'stuck' reset while the executor still moves is a passing
  // knock (a walking player re-anchors GoalFollow faster than the 3.5 s
  // window): replan to their current position. The seen-marker resyncs down
  // with the central streak (it drops on displacement, body-1).
  if (isMoving) {
    const resets = stuck.verdict(ctx).resets
    if (resets < (ctx.followSeenStuck || 0)) ctx.followSeenStuck = resets
    if (resets > (ctx.followSeenStuck || 0)) {
      ctx.followSeenStuck = resets
      bot.pathfinder.setGoal(new goals.GoalFollow(target, FOLLOW_RANGE), true)
    }
    ctx.followIssuedAt = now
    return
  }

  // Goal satisfied: resting within follow range of the player's current position
  // is not a stall. Evaluates floored block coordinates against current target pos.
  const node = bp && (typeof bp.floored === 'function' ? bp.floored() : { x: Math.floor(bp.x), y: Math.floor(bp.y), z: Math.floor(bp.z) })
  const satisfied = node && target.position ? new goals.GoalFollow(target, FOLLOW_RANGE).isEnd(node) : false
  if (satisfied) return

  const status = ctx.lastPathStatus || 'none'
  const isTerminal = status === 'noPath' || status === 'timeout' || (status === 'success' && !isMoving)
  const timedOut = (now - (ctx.followIssuedAt || 0)) >= SEARCH_TIMEOUT_MS

  if (!isTerminal && !timedOut) return

  // Stale plan, no movement: re-issue to the player's current position.
  bot.pathfinder.setGoal(new goals.GoalFollow(target, FOLLOW_RANGE), true)
  ctx.followIssuedAt = now
}

module.exports = follow
