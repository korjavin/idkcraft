'use strict'

const { goals } = require('mineflayer-pathfinder')

// ponytail: one function, no base class or activate/deactivate hooks —
// same shape as follow.js. One swing per tick (1/s); a 600 ms swing timer
// would need a deactivate hook, which we deliberately do not have.
function fight(bot, ctx, target, state) {
  const hostile = state && state.hostile
  if (!hostile || hostile.isValid === false) {
    if (ctx.lastGoalKey !== 'idle') bot.pathfinder.stop()
    ctx.lastGoalKey = 'idle'
    return
  }
  const key = `fight:${hostile.id}`
  if (key !== ctx.lastGoalKey || !bot.pathfinder.isMoving()) {
    bot.pathfinder.setGoal(new goals.GoalFollow(hostile, 2), true)
    ctx.lastGoalKey = key
    equipSword(bot)
  }
  if (bot.entity.position.distanceTo(hostile.position) <= 3) {
    bot.lookAt(hostile.position.offset(0, hostile.height * 0.8, 0), true)
    bot.attack(hostile)
  }
}

// ponytail: first sword in inventory wins (no attackDamage ranking) —
// an op can /give IdkBot iron_sword; fists are fine for the demo.
function equipSword(bot) {
  if (!bot.inventory || typeof bot.inventory.items !== 'function') return
  const sword = bot.inventory.items().find((i) => i && typeof i.name === 'string' && i.name.endsWith('_sword'))
  if (!sword || typeof bot.equip !== 'function') return
  try {
    const r = bot.equip(sword, 'hand')
    if (r && typeof r.catch === 'function') r.catch(() => {})
  } catch {
    // best-effort: fists are fine.
  }
}

module.exports = fight
