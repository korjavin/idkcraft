'use strict'

const { goals } = require('mineflayer-pathfinder')

// Roam: stroll within a few blocks of a standing player. The brain only
// picks roam when the player is close and still with no hostile near, so
// this just wanders the 16-block ore scan across new chunks while looking
// alive. Ranked last: any fight/follow answer owns the body instead.
//
// ponytail: random point, no reachability check — the pathfinder just fails
// and the next tick picks another. One function, same shape as follow.js.
const ROAM_RADIUS = 6
const HAND_BACK_DIST = 6

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
  // walk back into the same trap. No stuck fact from roam, ever.
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
