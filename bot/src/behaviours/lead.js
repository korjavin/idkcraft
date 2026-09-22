'use strict'

const { goals } = require('mineflayer-pathfinder')

// Lead: walk the player to the ore named by 'find me <block>'.
//
// Explicit player ORDER (like 'stop'), not a brain choice: the ticker keeps
// ctx.lead = { name, pos } and dispatches here instead of the brain's action
// while set, except fight which still preempts. One function, same shape as
// follow.js — no classes.
const ARRIVE_DIST = 2
const WAIT_DIST = 12
const RESUME_DIST = 8
// Give-up budget (stationary ticks): the pathfinder reports noPath/timeout
// via path_update, which surfaces here as "same goal, never moving". Retry
// spaced wider than a search allowance so a slow search is not torn down,
// then abandon so a walled-off vein never pins the tick.
const GIVE_UP_TICKS = 10
const RETRY_EVERY_TICKS = 6

// Wait budget (ticks at BRAIN_TICK_MS, ~120 s at the 1 s default): a player
// who never comes back within RESUME_DIST must not pin the order forever.
const WAIT_BUDGET_TICKS = 120
const PROGRESS_INTERVAL_MS = 10_000

function dist(a, b) {
  if (a && typeof a.distanceTo === 'function') return a.distanceTo(b)
  if (b && typeof b.distanceTo === 'function') return b.distanceTo(a)
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)
}

function playerDist(bot, target, state) {
  if (state && typeof state.distance_to_player === 'number') return state.distance_to_player
  const bp = bot.entity && bot.entity.position
  if (bp && target && target.position) return dist(bp, target.position)
  return null
}

// Same guard as the ticker's stopOnce: stop() only halts a live path, and
// setGoal(null) cancels a stationary live goal without latching stopPathing
// (which would swallow the resume goal).
function holdGoal(bot, ctx) {
  if (ctx.lastGoalKey !== 'idle') {
    if (bot.pathfinder.isMoving()) bot.pathfinder.stop()
    else if (bot.pathfinder.goal) bot.pathfinder.setGoal(null)
    ctx.lastGoalKey = 'idle'
  }
}

// Arrival is measured the same way the goal is: GoalNear.isEnd tests integer
// block coordinates, and the pathfinder checks the floored entity position —
// a float comparison would miss by up to ~0.7 blocks (entity stands at the
// block centre) and report 'cannot reach' from 2.5 blocks away.
function arrived(bp, pos) {
  const dx = Math.floor(bp.x) - pos.x
  const dy = Math.floor(bp.y) - pos.y
  const dz = Math.floor(bp.z) - pos.z
  return dx * dx + dy * dy + dz * dz <= ARRIVE_DIST * ARRIVE_DIST
}

function blocksLeft(bp, pos) {
  return Math.round(dist(bp, pos))
}

function finish(bot, ctx, message) {
  bot.chat(`${message}; following you again`)
  ctx.lead = null
  ctx.leadStuck = 0
}

function lead(bot, ctx, target, state) {
  const order = ctx.lead
  if (!order || !order.pos) return
  const bp = bot.entity && bot.entity.position
  if (!bp) return
  if (arrived(bp, order.pos)) {
    finish(bot, ctx, `here: ${order.name} at ${order.pos.x} ${order.pos.y} ${order.pos.z}`)
    return
  }
  const dp = playerDist(bot, target, state)
  if (order.waiting) {
    if (dp != null && dp <= RESUME_DIST) {
      order.waiting = false
      order.waitTicks = 0
      ctx.leadStuck = 0
      order.lastProgressAt = Date.now()
      bot.chat(`going on, ${blocksLeft(bp, order.pos)} blocks left`)
    } else {
      order.waitTicks = (order.waitTicks || 0) + 1
      if (order.waitTicks > WAIT_BUDGET_TICKS) {
        finish(bot, ctx, `giving up on ${order.name}`)
        holdGoal(bot, ctx)
        return
      }
      holdGoal(bot, ctx)
      ctx.leadStuck = 0
      return
    }
  } else if (dp != null && dp > WAIT_DIST) {
    order.waiting = true
    order.waitTicks = 1
    order.lastProgressAt = Date.now()
    bot.chat(`waiting for you, come to me (${Math.round(dp)} blocks)`)
    holdGoal(bot, ctx)
    ctx.leadStuck = 0
    return
  }
  const now = Date.now()
  if (!Number.isFinite(order.lastProgressAt)) order.lastProgressAt = now
  if (blocksLeft(bp, order.pos) > ARRIVE_DIST && now - order.lastProgressAt >= PROGRESS_INTERVAL_MS) {
    bot.chat(`${order.name}: ${blocksLeft(bp, order.pos)} blocks left`)
    order.lastProgressAt = now
  }
  const key = `lead:${order.pos.x},${order.pos.y},${order.pos.z}`
  if (key !== ctx.lastGoalKey) {
    bot.pathfinder.setGoal(new goals.GoalNear(order.pos.x, order.pos.y, order.pos.z, ARRIVE_DIST), false)
    ctx.lastGoalKey = key
    ctx.leadStuck = 0
    return
  }
  if (bot.pathfinder.isMoving()) {
    ctx.leadStuck = 0
    return
  }
  ctx.leadStuck = (ctx.leadStuck || 0) + 1
  if (ctx.leadStuck > GIVE_UP_TICKS) {
    finish(bot, ctx, `cannot reach ${order.name} at ${order.pos.x} ${order.pos.y} ${order.pos.z}`)
    holdGoal(bot, ctx)
    return
  }
  if (ctx.leadStuck % RETRY_EVERY_TICKS === 0) {
    bot.pathfinder.setGoal(new goals.GoalNear(order.pos.x, order.pos.y, order.pos.z, ARRIVE_DIST), false)
  }
}

module.exports = lead
module.exports.ARRIVE_DIST = ARRIVE_DIST
module.exports.WAIT_DIST = WAIT_DIST
module.exports.RESUME_DIST = RESUME_DIST
module.exports.GIVE_UP_TICKS = GIVE_UP_TICKS
module.exports.RETRY_EVERY_TICKS = RETRY_EVERY_TICKS
module.exports.WAIT_BUDGET_TICKS = WAIT_BUDGET_TICKS
module.exports.PROGRESS_INTERVAL_MS = PROGRESS_INTERVAL_MS
