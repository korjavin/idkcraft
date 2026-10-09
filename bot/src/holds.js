'use strict'

// Gather retry policy, moved verbatim out of goal.js (idkcraft-oqul.4).
// A leaf: gather.js reads it without loading the arbiter.

const { failReason } = require('./step')

// atl.4 relocation radius: a failure holds while the body stays within
// REFAIL_DIST of the failure point (failHolds in goal.js reads it too).
const REFAIL_DIST = 32

// Shared gather-failure hold (idkcraft-gyw): the behaviour latch and the
// menu gate above read one rule. A failed gather holds while the log count
// stands AND the body stays within REFAIL_DIST of the failure point;
// relocation past it releases for a fresh try at new ground (nearer trees,
// other wood). Same distance rule as failHolds, one place. An unknown
// failure point (legacy ctx, missing body) holds: the atl.4 livelock guard
// stays for everything that never recorded where it failed.
function gatherFailedHolds(g, logs, bot) {
  try {
    if (!g || failReason(g.final) === null) return false
    if (g.atLogs !== logs) return false
    const fp = g.failPos
    if (!fp || typeof fp.x !== 'number') return true
    const bp = bot && bot.entity && bot.entity.position
    if (!bp || typeof bp.x !== 'number') return true
    return Math.hypot(bp.x - fp.x, bp.z - fp.z) <= REFAIL_DIST
  } catch (_) {
    return false
  }
}

module.exports = { REFAIL_DIST, gatherFailedHolds }
