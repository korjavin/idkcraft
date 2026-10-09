'use strict'
// Park / castle-first / home-leg vetoes, moved verbatim out of goal.js
// (idkcraft-oqul.11): forage and stockpile read them without loading the
// arbiter. goal.js re-exports the same names. The behaviour reads stay
// deferred (explore/castlefetch load inside the behaviour chain).

// Task park (idkcraft-vmzq.3, supersedes g0z.24): ANY parked task — owner
// castle stop or the L2 episode — vetoes the built-home explore. The veto
// is a property of the parked task, never of a castle word (g0z.24's
// design is rejected: it would strand a tool-less bot). Forage stays as
// side work (owner Q2) but only near finds: the pickers in forage.js skip
// cells past PARK_FORAGE_RADIUS of home/castle while parked, so a parked
// bot cannot chain to a 300-block remembered diamond. 64 is the epic's
// own bound (stage-2: ends at home/site, not >64 away).
const PARK_FORAGE_RADIUS = 64
// Castle-first veto (idkcraft-vmzq.19): while an unfinished, unparked
// castle stands, the house-side steps (beds, build) yield — run3 picked
// equip then beds over a feasible castle, walked 500 blocks to the house,
// and never laid a cell. Equip is only outranked (STEP_ORDER), never
// vetoed: the castle chain needs its kit. Parked/complete releases (the
// L2 park's side work IS house work). Deferred require (the beds
// precedent — goal.js loads inside the behaviour chain).
// (.22) a house-<step> unlock lifts the veto for that step only — never
// wholesale (peer Q3). Pass the step name; omitted keeps the veto.
function castleFirst(ctx, step = null) {
  try {
    if (step) {
      try {
        const { goalUnlock } = require('./goal-unlock')
        if (goalUnlock(ctx, 'houseStep') === step) return false
      } catch (_) { /* no unlock */ }
    }
    return !!require('./behaviours/explore').castleActive(ctx)
  } catch (_) {
    return false
  }
}
// Home-leg leash (vmzq.19 R2, major 2): the home-anchored steps (light,
// stockpile, gear) with an active castle run only near home — past the
// task radius the legs cross the map, and laya (which the castle-rule
// below only skips for a runnable castle) would pick them over the
// chain's gather/craft/equip. Unreadable position reads near (fail open,
// the nightFarFromHome rule).
// (.22) same per-step unlock seam as castleFirst (houseStep is build or
// beds, so light/stockpile/gear never lift — they stay vetoed by shape).
function homeLegVetoed(bot, ctx, step = null) {
  try {
    if (step) {
      try {
        const { goalUnlock } = require('./goal-unlock')
        if (goalUnlock(ctx, 'houseStep') === step) return false
      } catch (_) { /* no unlock */ }
    }
    if (!castleFirst(ctx)) return false
    const h = ctx && ctx.home && ctx.home.site
    const bp = bot && bot.entity && bot.entity.position
    if (!h || typeof h.x !== 'number' || !bp || typeof bp.x !== 'number') return false
    return Math.hypot(bp.x - h.x, bp.z - h.z) > require('./behaviours/explore').TASK_SEARCH_RADIUS
  } catch (_) {
    return false
  }
}
// Pack-full pierce (vmzq.19 R3, round-2 major A): stockpile is the only
// pack drain. The dig has no room exactly when castlefetch's own
// roomForDrop says so (36 stacks with no cobble/dirt room, or the
// chestless reserve corner) — then the banking trip is the unblock, not
// drift. Deferred require (the demand precedent in castleFetchGo).
function packFull(bot, ctx) {
  try {
    return !require('./behaviours/castlefetch').roomForDrop(bot, ctx)
  } catch (_) {
    return false
  }
}
function taskParked(ctx) {
  try {
    if (ctx && ctx.castle && ctx.castle.parked) return true
  } catch (_) { /* unparked */ }
  try {
    if (ctx && ctx.home && ctx.home.parked) return true
  } catch (_) { /* unparked */ }
  return false
}

module.exports = { PARK_FORAGE_RADIUS, castleFirst, homeLegVetoed, packFull, taskParked }
