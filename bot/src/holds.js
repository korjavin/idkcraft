'use strict'

// Gather retry policy, moved verbatim out of goal.js (idkcraft-oqul.4).
// A leaf: gather.js reads it without loading the arbiter.

const { failReason } = require('./step')

// atl.4 relocation radius: a failure holds while the body stays within
// REFAIL_DIST of the failure point (failHolds in goal.js reads it too).
const REFAIL_DIST = 32

// Daylight rule for the far walk-out guard (idkcraft-p9lx): a >64-block
// leg needs most of the day. Lives here, not in gather.js, so the hold
// below and the commit guard read one rule with no import cycle (a static
// cycle detector pins holds<->gather).
// Last sixth of the day reads as near-dusk: dusk opens at 12000, night
// past 13000.
const LATE_DAY_TICKS = 10000
function farStartOk(bot) {
  try {
    const t = bot && bot.time && bot.time.timeOfDay
    if (typeof t !== 'number' || !(t >= 0)) return true // no clock: allow
    return t < LATE_DAY_TICKS
  } catch (_) { return true }
}

// Shared gather-failure hold (idkcraft-gyw): the behaviour latch and the
// menu gate above read one rule. A failed gather holds while the log count
// stands AND the body stays within REFAIL_DIST of the failure point;
// relocation past it releases for a fresh try at new ground (nearer trees,
// other wood). Same distance rule as failHolds, one place. An unknown
// failure point (legacy ctx, missing body) holds: the atl.4 livelock guard
// stays for everything that never recorded where it failed.
// A dusk refusal (p9lx) holds for the night, not until relocation —
// daylight re-releases the step from the same spot.
function gatherFailedHolds(g, logs, bot) {
  try {
    if (!g || failReason(g.final) === null) return false
    if (g.final === 'failed:dusk' && g.atLogs === logs && farStartOk(bot)) return false
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

// Site-scoped hold (idkcraft-klh2): a fetch hold parks the failed SITE, not
// the kind — true while the body is still at the failure point (or the site
// or the body is unreadable: fail-safe, the atl.4 precedent). Relocation
// past REFAIL_DIST releases the kind, so the next same-kind strategy runs
// at the new site while the failed one stays parked.
function siteStands(pos, bot) {
  try {
    if (!pos || typeof pos.x !== 'number') return true
    const bp = bot && bot.entity && bot.entity.position
    if (!bp || typeof bp.x !== 'number') return true
    return Math.hypot(bp.x - pos.x, bp.z - pos.z) <= REFAIL_DIST
  } catch (_) {
    return true
  }
}

module.exports = { REFAIL_DIST, gatherFailedHolds, farStartOk, LATE_DAY_TICKS, siteStands }
