'use strict'

// The castle stand-down is bounded by continuous work time, with long gaps
// paused by goal's clock. An unreadable inventory fails open as before.
const LOW_HP_GATE_MS = 5 * 60 * 1000
const LOW_HP_GAP_MS = 60 * 1000

function lowHpNoFood(bot, facts) {
  try {
    if (!(facts && facts.health < 6)) return false
    const items = bot && bot.inventory && typeof bot.inventory.items === 'function' ? bot.inventory.items() : null
    if (!Array.isArray(items)) return false
    return !require('./reflexes').pickEdible(items)
  } catch (_) { return false }
}

function lowHpGated(bot, facts, ctx) {
  if (!lowHpNoFood(bot, facts)) return false
  try {
    const since = ctx && typeof ctx.lowHpGateSince === 'number' ? ctx.lowHpGateSince : null
    if (since == null) return true
    return Date.now() - since <= LOW_HP_GATE_MS
  } catch (_) { return true }
}

module.exports = { LOW_HP_GATE_MS, LOW_HP_GAP_MS, lowHpNoFood, lowHpGated }
