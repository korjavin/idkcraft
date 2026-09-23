'use strict'

const roam = require('./roam')

// rest: stroll around the home site (world spawn until bead .4 sets one).
// Pseudo-target: roam only reads target.position (username/id just tag goal
// keys), and a static point never trips GoalFollow.hasChanged, so the bot
// strolls out and walks back without replanning churn.
function rest(bot, ctx, target, state) {
  const site = (ctx.home && ctx.home.site) || (bot && bot.spawnPoint)
  if (!site) return
  roam(bot, ctx, { position: site }, state)
}

module.exports = rest
