'use strict'

// The castle stand-down is bounded by continuous work time, with long gaps
// paused by goal's clock. An unreadable inventory fails open as before.
const LOW_HP_GATE_MS = 5 * 60 * 1000
const LOW_HP_GAP_MS = 60 * 1000

// Hungry or hurt (food recovery uses the same line); hpOnly = threat travel.
function needsFood(facts, hpOnly) {
  return !!(facts && (facts.health < 6 || (!hpOnly && facts.food < 6)))
}

function lowHpNoFood(bot, facts, hpOnly, ctx) {
  try {
    // Hunger opens it too (prod 2026-11-12 bot5: food 0, health held at 10 —
    // Easy starvation stops at 10, so health < 6 never came and the castle
    // rule kept it building on an empty stomach).
    if (!needsFood(facts, hpOnly)) return false
    const items = bot && bot.inventory && typeof bot.inventory.items === 'function' ? bot.inventory.items() : null
    if (!Array.isArray(items)) return false
    return !require('./reflexes').mealFor(bot, ctx || {}, items)
  } catch (_) { return false }
}

function lowHpGated(bot, facts, ctx, hpOnly) {
  if (!lowHpNoFood(bot, facts, hpOnly, ctx)) return false
  try {
    const since = ctx && typeof ctx.lowHpGateSince === 'number' ? ctx.lowHpGateSince : null
    if (since == null) return true
    return Date.now() - since <= LOW_HP_GATE_MS
  } catch (_) { return true }
}

module.exports = { LOW_HP_GATE_MS, LOW_HP_GAP_MS, needsFood, lowHpNoFood, lowHpGated }
