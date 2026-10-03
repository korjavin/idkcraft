'use strict'

// 'go castle' order behaviour (idkcraft-3qia): walk to the castle entrance
// apron and hold there until countermanded (follow me / go work / stop / come home).
const Vec3 = require('vec3')
const { goals } = require('mineflayer-pathfinder')
const { entrance } = require('./castle')
const body = require('../body')

const MOVE_TOLERANCE = 0.5
const STALL_TICKS = 10
const MAX_REISSUES = 3

function bodyPos(bot) {
  const p = bot && bot.entity && bot.entity.position
  return p && typeof p.x === 'number' ? p : null
}

function atEntrance(bp, ent) {
  return Math.hypot(bp.x - (ent.x + 0.5), bp.z - (ent.z + 0.5)) <= 1.5 && Math.abs(bp.y - ent.y) <= 1.5
}

function holdStill(bot, ctx) {
  if (ctx.lastGoalKey !== 'stay') {
    try {
      if (bot.pathfinder && bot.pathfinder.isMoving()) bot.pathfinder.stop()
      else if (bot.pathfinder && bot.pathfinder.goal) bot.pathfinder.setGoal(null)
      if (typeof bot.clearControlStates === 'function') bot.clearControlStates()
    } catch (_) { /* body best-effort */ }
    ctx.lastGoalKey = 'stay'
  }
}

function setGoal(bot, ctx, key, goal) {
  if (ctx.lastGoalKey === key) return
  try {
    bot.pathfinder.setGoal(goal, false)
    ctx.lastGoalKey = key
    ctx.lastPathNodes = null
  } catch (_) { /* retry next tick */ }
}

function gocastle(bot, ctx, target, state) {
  const order = ctx && ctx.gocastle
  if (!order) return
  const st = order.castle || (ctx && ctx.castle)
  if (!st || !st.site) {
    ctx.gocastle = null
    return
  }
  let ent
  try { ent = entrance(st) } catch (_) { ent = null }
  if (!ent) {
    ctx.gocastle = null
    return
  }
  const bp = bodyPos(bot)
  if (!bp) return

  if (order.phase === 'hold') {
    if (!atEntrance(bp, ent)) {
      // Died or teleported away with the order standing: walk back to the entrance.
      order.phase = 'walk'
      order.stalls = 0
      order.fails = 0
      order.lastPos = null
      ctx.lastGoalKey = ''
      ctx.stepStatus = 'running'
      return
    }
    holdStill(bot, ctx)
    return
  }

  // Walk phase
  try { body.claimBody(bot, ctx, (ctx.body && ctx.body.owner) || 'gocastle', { walk: true }) } catch (_) { /* lease best-effort */ }
  try { ctx.shelterLeg = ent } catch (_) { /* lease stash best-effort */ }

  if (atEntrance(bp, ent)) {
    order.phase = 'hold'
    ctx.stepStatus = 'done'
    holdStill(bot, ctx)
    if (!order.said) {
      order.said = true
      try { bot.chat('at the castle') } catch (_) { /* chat best-effort */ }
    }
    return
  }

  let loaded = false
  try {
    loaded = !!(bot.blockAt && bot.blockAt(new Vec3(ent.x, ent.y, ent.z)))
  } catch (_) { loaded = false }

  const goal = loaded
    ? new goals.GoalNear(ent.x, ent.y, ent.z, 1)
    : new goals.GoalNearXZ(ent.x, ent.z, 1)

  const last = order.lastPos
  if (!last || Math.hypot(bp.x - last.x, bp.z - last.z) > MOVE_TOLERANCE) {
    order.stalls = 0
    order.lastPos = { x: bp.x, y: bp.y, z: bp.z }
  } else if (++order.stalls >= STALL_TICKS) {
    order.stalls = 0
    order.fails = (order.fails || 0) + 1
    let idle = true
    try { idle = !bot.pathfinder.isMoving() } catch (_) { /* retry */ }
    if (idle) ctx.lastGoalKey = ''
    if (order.fails >= MAX_REISSUES) {
      order.phase = 'failed'
      ctx.stepStatus = 'failed:cannot-reach-castle'
      ctx.gocastle = null
      holdStill(bot, ctx)
      try { bot.chat('cannot reach the castle') } catch (_) { /* chat best-effort */ }
      return
    }
  }

  setGoal(bot, ctx, loaded ? 'gocastle-walk' : 'gocastle-far', goal)
}

module.exports = gocastle
