'use strict'

// Goal unlock seam (idkcraft-vmzq.22): ONE helper every veto site reads.
// A watchdog commitment window (ctx.goal.commit, task.js) may carry an
// unlock = { radius?, houseStep?, candidate? } that lifts a "never go far"
// bound for the window only. The window end snaps bounds back on the next
// leg; a leg already past the bound finishes (castlefetch quarry precedent).
//
// HARD, never unlockable (owner 2026-10-07):
// - never drop items (roomForDrop, stockpile)
// - never break protected blocks (castle protected cells, Movements blocksCantBreak)
// - fight/flee/eat/breath reflexes, stuck recovery, the night rule
// - the 256 outer disk (AUTONOMOUS_EXPLORE_RADIUS: chunk bloat is a host cost)
// - an OWNER park (castle stop / stop): an unlock never undoes an explicit
//   stop; only the automatic stall park releases.
// Costs name distance, remaining daylight, food/kit; an incomplete return
// is reported honestly (the night rule shelters, it does not certify a way home).

const OUTER_DISK = 256

function clampRadius(r) {
  const n = typeof r === 'number' ? r : parseInt(r, 10)
  if (!Number.isFinite(n) || n <= 0) return null
  return Math.min(Math.floor(n), OUTER_DISK)
}

// Read one unlock key from the live window. Returns the value (radius
// already clamped to the outer disk), or null when no live window carries it.
// Window liveness is identity + time; callers pass `now` on the same clock
// they tick (taskTick passes its fake-clock `now`, behaviours pass Date.now
// via the default). A missing/expired window reads as no unlock — the
// default bound path stays byte-identical.
function goalUnlock(ctx, key, now = Date.now()) {
  try {
    const g = ctx && ctx.goal
    const c = g && g.commit
    if (!c || !g || c.goalId !== g.id || c.generation !== g.generation) return null
    if (typeof c.until !== 'number' || now >= c.until) return null
    const u = c.unlock
    if (!u || typeof u !== 'object') return null
    if (key === 'radius') {
      if (u.radius === undefined || u.radius === null) return null
      return clampRadius(u.radius)
    }
    if (key === 'houseStep') {
      return typeof u.houseStep === 'string' && u.houseStep ? u.houseStep : null
    }
    if (key === 'candidate') {
      const cd = u.candidate
      if (!cd || typeof cd.x !== 'number' || typeof cd.z !== 'number') return null
      return cd
    }
    return null
  } catch (_) {
    return null
  }
}

module.exports = { goalUnlock, clampRadius, OUTER_DISK }
