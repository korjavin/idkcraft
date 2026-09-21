'use strict'

const { goals } = require('mineflayer-pathfinder')

// ponytail: one function, no base class or activate/deactivate hooks —
// fight/scout will each add one sibling module plus a one-line registration.
function follow(bot, ctx, target) {
  const key = `follow:${target.username || target.id}`
  // Re-issue while standing still: the first path can fail on an empty
  // (not yet loaded) world, and a dynamic goal only re-paths when the
  // target moves — so retry until the bot is actually moving.
  if (key !== ctx.lastGoalKey || !bot.pathfinder.isMoving()) {
    bot.pathfinder.setGoal(new goals.GoalFollow(target, 3), true)
    ctx.lastGoalKey = key
  }
}

module.exports = follow
