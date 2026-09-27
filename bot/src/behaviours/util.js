'use strict'

// Shared behaviour helpers (idkcraft-08i): byte-identical say/clearGoal
// lived in six behaviour files, botPos in three (plus a home.js variant
// without the try). One copy, so a latch fix lands everywhere at once.
// Pure leaf: requires nothing, so no import cycles.

function say(bot, line) {
  try { bot.chat(line) } catch (_) { /* chat best-effort, like goal.js */ }
}

// Drop a live pathfinder goal like stopOnce, but without stop(): its latch
// would swallow the next setGoal issued on the same tick (gather pattern).
function clearGoal(bot, ctx) {
  try {
    if (bot.pathfinder && bot.pathfinder.goal && typeof bot.pathfinder.setGoal === 'function') {
      bot.pathfinder.setGoal(null)
    }
  } catch (_) { /* body best-effort */ }
  ctx.lastGoalKey = ''
}

function botPos(bot) {
  try {
    const p = bot && bot.entity && bot.entity.position
    if (p && typeof p.x === 'number') return p
  } catch (_) { /* no position */ }
  return null
}

module.exports = { say, clearGoal, botPos }
