'use strict'

const Vec3 = require('vec3')
const roam = require('./roam')

// rest: stroll around the home site (world spawn until bead .4 sets one).
// Pseudo-target: roam only reads target.position (username/id just tag goal
// keys), and a static point never trips GoalFollow.hasChanged, so the bot
// strolls out and walks back without replanning churn. The position must be
// a real Vec3 — GoalFollow.hasChanged calls position.floored(), which plain
// home-site coords lack (live crash); a Vec3 re-wraps losslessly.
function rest(bot, ctx, target, state) {
  // Player near (the ticker hands the nearest visible player as target):
  // stroll near them, never wander back to the site trap while the owner
  // stands next to the bot (p4s). Roam reuses follow at >6 blocks and picks
  // new points past the executor wedge — no new logic here.
  if (target && target.position) {
    roam(bot, ctx, target, state)
    return
  }
  const site = (ctx.home && ctx.home.site) || (bot && bot.spawnPoint)
  if (!site) return
  const p = site && typeof site.floored === 'function' ? site : new Vec3(site.x, site.y, site.z)
  roam(bot, ctx, { position: p }, state)
}

module.exports = rest
