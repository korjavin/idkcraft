'use strict'

// castle-park: the same-day castlefetch park state (idkcraft-dlpo). A leaf:
// requires only budget, so both the decor selector
// (src/behaviours/castle.js) and the fetch legs
// (src/behaviours/castlefetch.js, re-exported for goal.js recordOutcome)
// can share it without closing a require cycle (oqul.14 precedent:
// shared helpers move into leaves; structure-deps counts lazy requires
// the same as top-level ones).
//
// A castlefetch kind that fails CASTLEFETCH_PARK_FAILS times on the same
// UTC calendar date parks for the date (counts, not time). Unparks next
// date (swept on read) or on a bank deposit / a done leg of that kind.
// Only complete-castle non-main kinds are ever counted (goal.js
// recordOutcome gates that); unstamped failures never park.

// Same-day park key: the UTC calendar date. Counts and parks key on this,
// so a new date unparks by construction. Deliberately not the MC day:
// 24000 ticks at 20 TPS is ~20 real minutes, so an MC-day key would unpark
// ~72x per real day and a 24h replay would open hundreds of legs per kind
// (revmux 01-review core-1).
function parkDay() {
  try {
    return `date:${new Date(Date.now()).toISOString().slice(0, 10)}`
  } catch (_) {
    return 'date:unknown'
  }
}

function parkLimit() {
  try {
    const n = require('./budget').CASTLEFETCH_PARK_FAILS
    if (typeof n === 'number' && n >= 1) return n
  } catch (_) { /* default below */ }
  return 3
}

// Drop parked/count entries from a previous date (unpark: next day).
// Keeps the time-based hold fields (at/kind/kinds) untouched.
function sweepParked(ctx) {
  try {
    const sf = ctx && ctx.stepFail && ctx.stepFail.castlefetch
    if (!sf || typeof sf !== 'object') return
    const today = parkDay()
    let changed = false
    if (sf.parked && typeof sf.parked === 'object') {
      for (const k of Object.keys(sf.parked)) {
        if (sf.parked[k] !== today) { delete sf.parked[k]; changed = true }
      }
      if (Object.keys(sf.parked).length === 0) delete sf.parked
      else if (changed) { /* keep today's parks */ }
    }
    if (sf.counts && typeof sf.counts === 'object') {
      for (const k of Object.keys(sf.counts)) {
        const e = sf.counts[k]
        if (!e || typeof e !== 'object' || e.day !== today) { delete sf.counts[k]; changed = true }
      }
      if (Object.keys(sf.counts).length === 0) delete sf.counts
    }
    if (changed) {
      try {
        if (Object.keys(sf).length === 0) delete ctx.stepFail.castlefetch
        else if (typeof sf.at !== 'number' && !sf.kinds && !sf.kind && !sf.parked && !sf.counts) delete ctx.stepFail.castlefetch
      } catch (_) { /* record best-effort */ }
    }
  } catch (_) { /* sweep best-effort */ }
}

// True while KIND is same-day parked: N fails on the same date park the
// kind, whatever the retry clock says.
function isParked(ctx, kind) {
  try {
    if (!kind) return false
    sweepParked(ctx)
    const sf = ctx && ctx.stepFail && ctx.stepFail.castlefetch
    const p = sf && sf.parked
    return !!(p && typeof p === 'object' && p[kind] === parkDay())
  } catch (_) {
    return false
  }
}

// Count one same-day failure for KIND; park at the limit with a parked
// line. Returns true when this call newly parked the kind. Unstamped
// (kindless) failures are uncountable and never park. Only called for a
// complete castle (goal.js recordOutcome): build-phase fails keep
// retrying on the 5-min hold, never park for the date
// (revmux 01-review core-3); main materials (stone/planks/stairs) likewise
// (revmux 02-after-fix core-2).
function noteFail(ctx, kind) {
  try {
    if (!ctx || typeof kind !== 'string' || !kind) return false
    sweepParked(ctx)
    if (isParked(ctx, kind)) return false
    if (!ctx.stepFail || typeof ctx.stepFail !== 'object') ctx.stepFail = {}
    const sf = ctx.stepFail.castlefetch || (ctx.stepFail.castlefetch = {})
    const today = parkDay()
    if (!sf.counts || typeof sf.counts !== 'object') sf.counts = {}
    const e = (sf.counts[kind] && typeof sf.counts[kind] === 'object' && sf.counts[kind].day === today)
      ? sf.counts[kind]
      : (sf.counts[kind] = { day: today, n: 0 })
    e.n = (e.n | 0) + 1
    const limit = parkLimit()
    if (e.n >= limit) {
      if (!sf.parked || typeof sf.parked !== 'object') sf.parked = {}
      if (sf.parked[kind] !== today) {
        sf.parked[kind] = today
        try { console.log(`castlefetch ${kind}: parked for the day after ${e.n} fails (${today})`) } catch (_) { /* log best-effort */ }
        return true
      }
    }
    return false
  } catch (_) {
    return false
  }
}

// A leg that got stock retires the kind's park (obtainable again).
function unparkKind(ctx, kind, why) {
  try {
    const sf = ctx && ctx.stepFail && ctx.stepFail.castlefetch
    if (!sf || typeof sf !== 'object' || typeof kind !== 'string' || !kind) return false
    const wasParked = !!(sf.parked && typeof sf.parked === 'object' && sf.parked[kind])
    let out = wasParked
    if (sf.parked && typeof sf.parked === 'object' && sf.parked[kind]) delete sf.parked[kind]
    if (sf.counts && typeof sf.counts === 'object' && sf.counts[kind]) { delete sf.counts[kind]; out = true }
    if (sf.parked && typeof sf.parked === 'object' && Object.keys(sf.parked).length === 0) delete sf.parked
    if (sf.counts && typeof sf.counts === 'object' && Object.keys(sf.counts).length === 0) delete sf.counts
    if (out) {
      // The unpark line fires only for a real park; a retired bare count
      // stays silent.
      if (wasParked) {
        try { console.log(`castlefetch ${kind}: unparked (${why || 'stock'})`) } catch (_) { /* log best-effort */ }
      }
      if (Object.keys(sf).length === 0) delete ctx.stepFail.castlefetch
    }
    return out
  } catch (_) {
    return false
  }
}

// A bank deposit may have restocked the chests (owner or the bot's own
// banking trip): every parked kind gets a fresh look.
function unparkAll(ctx, why) {
  try {
    const sf = ctx && ctx.stepFail && ctx.stepFail.castlefetch
    if (!sf || typeof sf !== 'object') return false
    const parked = (sf.parked && typeof sf.parked === 'object') ? sf.parked : {}
    const counts = (sf.counts && typeof sf.counts === 'object') ? sf.counts : {}
    const kinds = new Set([...Object.keys(parked), ...Object.keys(counts)])
    if (kinds.size === 0) return false
    const wasParked = Object.keys(parked).length > 0
    delete sf.parked
    delete sf.counts
    // The unpark line fires only for a real park; retired bare counts stay
    // silent.
    if (wasParked) {
      try { console.log(`castlefetch: unparked after ${why || 'bank deposit'} (${[...kinds].join(',')})`) } catch (_) { /* log best-effort */ }
    }
    if (Object.keys(sf).length === 0) delete ctx.stepFail.castlefetch
    return true
  } catch (_) {
    return false
  }
}

module.exports = { parkDay, sweepParked, isParked, noteFail, unparkKind, unparkAll }
