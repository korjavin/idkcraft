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
// Climb-first depth (idkcraft-vmzq.50): solid above within this many
// blocks means deep cover — an XZ leg from there dives caves (run8: the
// walk back descended to y11 water and drowned). The leg goals up
// instead (see the walk phase); the surface walk only plans from open
// sky. Water and air pass (swimming out is walking, breath owns it);
// unloaded reads surfaced — fail open to the old walk.
const CLIMB_HEADROOM = 8
function climbNeeded(bot, bp) {
  try {
    if (!bot || typeof bot.blockAt !== 'function') return false
    const p = bp || bodyPos(bot)
    if (!p || typeof p.x !== 'number') return false
    const x = Math.floor(p.x)
    const z = Math.floor(p.z)
    for (let y = Math.floor(p.y) + 1; y <= Math.floor(p.y) + CLIMB_HEADROOM; y++) {
      let b = null
      try {
        b = bot.blockAt(new Vec3(x, y, z))
      } catch (_) {
        return false
      }
      if (!b) return false
      const n = b.name
      if (n === 'air' || n === 'cave_air' || n === 'water' || n === 'bubble_column') continue
      return true
    }
    return false
  } catch (_) {
    return false
  }
}

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
  // Work-step mode (idkcraft-vmzq.50): the goal arbiter's return-to-site
  // leg reuses this walk with step-local state — no owner order is armed
  // (an order would preempt work and switch the goal kind). The order
  // path below is untouched; step mode ends done/failed, never holds.
  const stepMode = !order && !!ctx && ctx.step === 'gocastle' && ctx.stepStatus === 'running'
  const od = order || (stepMode ? (ctx.gosite || (ctx.gosite = { phase: 'walk', stalls: 0, fails: 0, lastPos: null, said: false })) : null)
  if (!od) return
  const st = (order && (order.castle || (ctx && ctx.castle))) || (stepMode ? ctx.castle : null)
  if (!st || !st.site) {
    if (order) ctx.gocastle = null
    else {
      ctx.stepStatus = 'failed:gocastle-no-site'
      ctx.gosite = null
    }
    return
  }
  let ent
  try { ent = entrance(st) } catch (_) { ent = null }
  if (!ent) {
    if (order) ctx.gocastle = null
    else {
      ctx.stepStatus = 'failed:gocastle-no-site'
      ctx.gosite = null
    }
    return
  }
  const bp = bodyPos(bot)
  if (!bp) return

  if (od.phase === 'hold') {
    if (!atEntrance(bp, ent)) {
      // Died or teleported away with the order standing: walk back to the entrance.
      od.phase = 'walk'
      od.stalls = 0
      od.fails = 0
      od.lastPos = null
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
    if (order) {
      od.phase = 'hold'
      ctx.stepStatus = 'done'
      holdStill(bot, ctx)
      if (!od.said) {
        od.said = true
        try { bot.chat('at the castle') } catch (_) { /* chat best-effort */ }
      }
    } else {
      // Step mode: arrival ends the leg — decide() re-picks the castle
      // work (the step-change chat announces it, no arrival line here).
      ctx.stepStatus = 'done'
      ctx.gosite = null
      holdStill(bot, ctx)
    }
    return
  }

  // Climb-first (vmzq.50, step mode only): from deep cover goal up, never
  // an XZ leg — a walkable exit climbs, a sealed pocket noPaths and
  // stuck→recover digs up. The order walk keeps its shape.
  if (stepMode && climbNeeded(bot, bp)) {
    const tx = Math.floor(bp.x)
    const ty = Math.floor(bp.y) + CLIMB_HEADROOM
    const tz = Math.floor(bp.z)
    setGoal(bot, ctx, `gocastle-up:${tx},${ty},${tz}`, new goals.GoalNear(bp.x, ty, bp.z, 2))
    ctx.stepStatus = 'running'
    // 3D progress resets: a dig-up climbs without closing XZ in, and
    // must not burn the give-up budget the order legs share.
    const last = od.lastPos
    if (!last || Math.abs(bp.x - last.x) + Math.abs(bp.y - last.y) + Math.abs(bp.z - last.z) > MOVE_TOLERANCE) {
      od.stalls = 0
      od.lastPos = { x: bp.x, y: bp.y, z: bp.z }
      return
    }
    if (++od.stalls < STALL_TICKS) return
    od.stalls = 0
    od.fails = (od.fails || 0) + 1
    let idle = true
    try { idle = !bot.pathfinder.isMoving() } catch (_) { /* retry */ }
    if (idle) ctx.lastGoalKey = ''
    if (od.fails >= MAX_REISSUES) {
      od.phase = 'failed'
      ctx.stepStatus = 'failed:cannot-reach-castle'
      ctx.gosite = null
      holdStill(bot, ctx)
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

  const last = od.lastPos
  if (!last || Math.hypot(bp.x - last.x, bp.z - last.z) > MOVE_TOLERANCE) {
    od.stalls = 0
    od.lastPos = { x: bp.x, y: bp.y, z: bp.z }
  } else if (++od.stalls >= STALL_TICKS) {
    od.stalls = 0
    od.fails = (od.fails || 0) + 1
    let idle = true
    try { idle = !bot.pathfinder.isMoving() } catch (_) { /* retry */ }
    if (idle) ctx.lastGoalKey = ''
    if (od.fails >= MAX_REISSUES) {
      od.phase = 'failed'
      ctx.stepStatus = 'failed:cannot-reach-castle'
      if (order) {
        ctx.gocastle = null
        holdStill(bot, ctx)
        try { bot.chat('cannot reach the castle') } catch (_) { /* chat best-effort */ }
      } else {
        ctx.gosite = null
        holdStill(bot, ctx)
      }
      return
    }
  }

  setGoal(bot, ctx, loaded ? 'gocastle-walk' : 'gocastle-far', goal)
}

module.exports = gocastle
module.exports.climbNeeded = climbNeeded
module.exports.CLIMB_HEADROOM = CLIMB_HEADROOM
