'use strict'

const { goals } = require('mineflayer-pathfinder')
const recoverMenu = require('./recover')

// Lead: walk the player to the ore named by 'find me <block>'.
//
// Explicit player ORDER (like 'stop'), not a brain choice: the ticker keeps
// ctx.lead = { name, pos } and dispatches here instead of the brain's action
// while set, except fight which still preempts. One function, same shape as
// follow.js — no classes.
const ARRIVE_DIST = 2
const WAIT_DIST = 12
const RESUME_DIST = 8
// Give-up budget (stationary ticks): count entity displacement because the
// pathfinder can stay isMoving() during a partial path or a timed-out search.
// One sidestep/jump gets a second attempt before abandoning the order.
const GIVE_UP_TICKS = 10
const WORK_STALL_TICKS = GIVE_UP_TICKS * 6
const RETRY_EVERY_TICKS = 6
const MOVE_TOLERANCE = 0.5

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

function snapshot(pos) {
  return typeof pos.clone === 'function' ? pos.clone() : { x: pos.x, y: pos.y, z: pos.z }
}

function savePosition(order, bp, grounded) {
  order.lastPos = snapshot(bp)
  if (grounded) order.lastGroundY = bp.y
}

function madeProgress(order, bp, grounded) {
  if (!order.lastPos) {
    savePosition(order, bp, grounded)
    return false
  }
  if (grounded && !Number.isFinite(order.lastGroundY)) order.lastGroundY = bp.y
  const dx = bp.x - order.lastPos.x
  const dz = bp.z - order.lastPos.z
  const dy = grounded ? bp.y - order.lastGroundY : 0
  if (Math.hypot(dx, dy, dz) <= MOVE_TOLERANCE) return false
  savePosition(order, bp, grounded)
  return true
}

function finish(bot, ctx, message) {
  bot.chat(`${message}; following you again`)
  ctx.lead = null
  ctx.leadStuck = 0
}

function recover(bot, ctx, order, bp, now) {
  if (order.nudged) {
    // A recover episode already ran for this order and the bot still makes
    // no progress: second strike, give up like before.
    finish(bot, ctx, `cannot reach ${order.name} at ${order.pos.x} ${order.pos.y} ${order.pos.z}`)
    holdGoal(bot, ctx)
    return
  }
  // Detector only (ef3): raise the stuck fact, the recover menu picks the
  // escape. order.nudged is set by the episode release, so a still-stuck
  // order gives up on the next stall instead of looping episodes.
  if (ctx.recovery) return // episode running: wait for the menu
  const gp = order.pos ? { x: order.pos.x, y: order.pos.y, z: order.pos.z } : null
  const gk = order.pos ? `lead:${order.pos.x},${order.pos.y},${order.pos.z}` : 'lead'
  if (recoverMenu.setStuck(ctx, 'lead', gp, gk)) {
    console.log(`stuck reason=nudge pos=${Math.round(bp.x)},${Math.round(bp.y)},${Math.round(bp.z)}`)
  }
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
      order.stuckTicks = 0
      if (bot.entity.onGround !== false) savePosition(order, bp, true)
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
      order.stuckTicks = 0
      return
    }
  } else if (dp != null && dp > WAIT_DIST) {
    order.waiting = true
    order.waitTicks = 1
    order.stuckTicks = 0
    if (bot.entity.onGround !== false) savePosition(order, bp, true)
    order.lastProgressAt = Date.now()
    bot.chat(`waiting for you, come to me (${Math.round(dp)} blocks)`)
    holdGoal(bot, ctx)
    ctx.leadStuck = 0
    return
  }
  const key = `lead:${order.pos.x},${order.pos.y},${order.pos.z}`
  if (key !== ctx.lastGoalKey) {
    bot.pathfinder.setGoal(new goals.GoalNear(order.pos.x, order.pos.y, order.pos.z, ARRIVE_DIST), false)
    ctx.lastGoalKey = key
    order.stuckTicks = 0
    order.workTicks = 0
    if (bot.entity.onGround !== false) savePosition(order, bp, true)
    // NOTE: nudged is NOT reset here — the recover release sets it, and a
    // re-issue right after the episode must not grant fresh strikes.
    return
  }
  const now = Date.now()
  const working = (typeof bot.pathfinder.isMining === 'function' && bot.pathfinder.isMining()) ||
    (typeof bot.pathfinder.isBuilding === 'function' && bot.pathfinder.isBuilding())
  // Ignore vertical movement during jumps, but count horizontal movement so
  // swimming or jumping toward the goal is still progress.
  const airborne = bot.entity.onGround === false
  const moved = madeProgress(order, bp, !airborne)
  if (moved) {
    order.stuckTicks = 0
    order.workTicks = 0
    // Fresh strikes only on real gain toward the goal (ef3): walking back
    // to the wedge point is displacement, not progress, so nudged stays and
    // the second strike still gives up instead of looping episodes.
    if (order.nudged && order.nudgedAt != null && blocksLeft(bp, order.pos) < order.nudgedAt) order.nudged = false
    if (!working && blocksLeft(bp, order.pos) > ARRIVE_DIST && now - (order.lastProgressAt || 0) >= PROGRESS_INTERVAL_MS) {
      bot.chat(`${order.name}: ${blocksLeft(bp, order.pos)} blocks left`)
      order.lastProgressAt = now
    }
    return
  }
  if (working) {
    order.workTicks = (order.workTicks || 0) + 1
    if (order.workTicks > WORK_STALL_TICKS) recover(bot, ctx, order, bp, now)
    return
  }
  order.stuckTicks = (order.stuckTicks || 0) + 1
  if (order.stuckTicks > GIVE_UP_TICKS) {
    recover(bot, ctx, order, bp, now)
    return
  }
  if (order.stuckTicks % RETRY_EVERY_TICKS === 0 && !bot.pathfinder.isMoving()) {
    bot.pathfinder.setGoal(new goals.GoalNear(order.pos.x, order.pos.y, order.pos.z, ARRIVE_DIST), false)
  }
}

module.exports = lead
module.exports.ARRIVE_DIST = ARRIVE_DIST
module.exports.WAIT_DIST = WAIT_DIST
module.exports.RESUME_DIST = RESUME_DIST
module.exports.GIVE_UP_TICKS = GIVE_UP_TICKS
module.exports.WORK_STALL_TICKS = WORK_STALL_TICKS
module.exports.RETRY_EVERY_TICKS = RETRY_EVERY_TICKS
module.exports.WAIT_BUDGET_TICKS = WAIT_BUDGET_TICKS
module.exports.PROGRESS_INTERVAL_MS = PROGRESS_INTERVAL_MS
