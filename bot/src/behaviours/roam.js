'use strict'

const { goals } = require('mineflayer-pathfinder')
const recover = require('./recover')

// Roam: stroll within a few blocks of a standing player. The brain only
// picks roam when the player is close and still with no hostile near, so
// this just wanders the 16-block ore scan across new chunks while looking
// alive. Ranked last: any fight/follow answer owns the body instead.
//
// ponytail: random point, no reachability check — the pathfinder just fails
// and the next tick picks another. One function, same shape as follow.js.
const ROAM_RADIUS = 6
const HAND_BACK_DIST = 6

function formatPos(p) {
  if (!p) return 'unknown'
  const fx = typeof p.x === 'number' ? (Number.isInteger(p.x) ? p.x : p.x.toFixed(1)) : '0'
  const fy = typeof p.y === 'number' ? (Number.isInteger(p.y) ? p.y : p.y.toFixed(1)) : '0'
  const fz = typeof p.z === 'number' ? (Number.isInteger(p.z) ? p.z : p.z.toFixed(1)) : '0'
  return `${fx},${fy},${fz}`
}

function roam(bot, ctx, target, state) {
  if (!target || !target.position) return
  // A running recover episode owns the body — never fight it with a fresh
  // stroll goal (the ticker routes episode ticks to recover anyway; this
  // guards direct calls too).
  if (ctx && ctx.recovery) return
  const pp = target.position
  const bp = bot.entity && bot.entity.position
  if (!bp) return
  const distToPlayer = Math.hypot(bp.x - pp.x, bp.y - pp.y, bp.z - pp.z)
  if (distToPlayer > HAND_BACK_DIST) {
    // Beyond the envelope: walk back toward the player instead of standing
    // still. The ticker reuses a cached decision while the rounded state key
    // is unchanged, so "set no goal and wait for follow" wedges the bot when
    // a stroll comes to rest just past 6 blocks — motion changes the key and
    // the brain re-evaluates on the next tick. Same guard as follow.js.
    const backKey = `roam-back:${target.username || target.id}`
    // Wedge detector (q0h): the long walk back (rest pulls to the site this
    // way) raises with the walk target as the goal — without it only the
    // goal-less ticker backstop fires and the menu climbs blind. Same
    // moving + stuck-resets + no-displacement rule as follow.js; the stroll
    // branch below keeps its p4s no-recover contract.
    if (typeof bp.distanceTo === 'function' && ctx.roamLastPos) {
      if (bp.distanceTo(ctx.roamLastPos) > 0.5) ctx.stuckResets = 0
    }
    if (typeof bp.clone === 'function') ctx.roamLastPos = bp.clone()
    let movingBack = false
    try { movingBack = !!(bot.pathfinder && typeof bot.pathfinder.isMoving === 'function' && bot.pathfinder.isMoving()) } catch (_) { /* stationary default */ }
    recover.clearStaleRoamLatch(ctx, bot)
    if (movingBack && (ctx.stuckResets || 0) >= 2 && !recover.restGaveUpHolds(ctx, bot)) {
      const gp = { x: pp.x, y: pp.y, z: pp.z }
      if (recover.setStuck(ctx, 'roam', gp, backKey)) console.log(`stuck reason=wedge pos=${formatPos(bp)} dist=${distToPlayer.toFixed(1)} goal=${formatPos(gp)}`)
      ctx.stuckResets = 0
      return
    }
    if (backKey !== ctx.lastGoalKey || !bot.pathfinder.isMoving()) {
      bot.pathfinder.setGoal(new goals.GoalFollow(target, 3), true)
      ctx.roamGoal = null // walking back to the player: no point target
      ctx.lastGoalKey = backKey
    }
    return
  }
  // Progress zeroes the wedge counter: only consecutive stuck resets with
  // no displacement count (same rule as follow.js).
  if (typeof bp.distanceTo === 'function' && ctx.roamLastPos) {
    if (bp.distanceTo(ctx.roamLastPos) > 0.5) ctx.stuckResets = 0
  }
  if (typeof bp.clone === 'function') ctx.roamLastPos = bp.clone()
  // Already strolling: keep walking until the pathfinder stops. A wedged
  // executor (isMoving with piling stuck resets and no displacement) just
  // takes another point below — p4s: handing the body to recover here turned
  // every 3.5 s pathfinder stop into 10-20 s of sidestep/dig/call menus that
  // walk back into the same trap. No stuck fact from the stroll, ever.
  if (bot.pathfinder.isMoving() && (ctx.stuckResets || 0) < 2) return
  ctx.stuckResets = 0
  const angle = Math.random() * Math.PI * 2
  const r = Math.random() * ROAM_RADIUS
  const x = pp.x + Math.cos(angle) * r
  const z = pp.z + Math.sin(angle) * r
  bot.pathfinder.setGoal(new goals.GoalNear(x, pp.y, z, 1), false)
  ctx.roamGoal = { x, y: pp.y, z }
  ctx.lastGoalKey = `roam:${Math.round(x)},${Math.round(pp.y)},${Math.round(z)}`
}

module.exports = roam
