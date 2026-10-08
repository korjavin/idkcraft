'use strict'

// Retreat chain (idkcraft-1tj): alone at low health with a hostile on the
// bot, laya's follow is vetoed (no player to follow) and the FSM idles —
// the bot stood in the pit and died (gat: 48 deaths). Three primitives form
// the model menu, picked through a yes/no ask chain (laya is reliable on 2
// options only): run away, pillar 2-3 blocks, walk home. Each has an honest
// feasible gate; the code routes WHEN (veto + low-health-hostile), the
// model picks WHAT — no pick order is hardcoded beyond the question order.
//
// Wiring (index.js, work block): after a vetoed brain decision
// (source fsm-noplayer, reason low-health-hostile), chooseRetreat replaces
// goal.decide for that tick. 0ay also routes taking-fire ticks (any hp,
// unreachable hostile, fresh hurt) here; those key a separate askedKey
// bucket and ask under a taking-fire premise. A hit dispatches a
// registered BEHAVIOURS action (retreat / pillar / gohome); a miss falls
// through to goal.decide, i.e. the old behaviour. Nothing here touches the
// goal menu, its text, or the normal (players online) flow: noplayer is
// implied by the veto, and the under-fire leg gates it explicitly.

const { goals } = require('mineflayer-pathfinder')
const { isFightTarget, HOSTILE_NAMES } = require('../perception')
const { botPos } = require('./util')
const recover = require('./recover')

// Question order = owner list (1tj notes). Feasibility, not priority:
// the model answers each question, the code never skips one for it.
const RETREAT_ORDER = ['retreat', 'pillar', 'gohome']
const RETREAT_INSTRUCTIONS = 'The bot is losing a fight alone. Answer yes (take it) or no (skip it)'
// 0ay premise for healthy callers (taking fire from an unreachable
// hostile): the low-hp wording above is validated for 1tj and stays
// byte-identical on that path — this variant only serves the new leg.
const RETREAT_INSTRUCTIONS_UNDER_FIRE = 'The bot takes fire from an unreachable hostile alone. Answer yes (take it) or no (skip it)'
const RETREAT_CRITERIA = {
  retreat: 'run: a hostile is close and a side is open — run away from the hostile',
  pillar: 'climb: scaffold blocks on hand and headroom free — pillar 2-3 blocks up, out of reach',
  gohome: 'hide: the home is built and close enough to walk to — go home and inside',
  no: 'skip this option and consider the next one',
}
const RETREAT_VERBS = {
  retreat: 'running from the hostile',
  pillar: 'pillaring up',
  gohome: 'heading home',
}
const FLEE_RANGE = 6
const FLEE_DIST = 6
const FLEE_DONE_DIST = 8
// Hysteresis (idkcraft-vmzq.49): the veto flickers — a hostile at the
// 8-block edge, hp at 6 — and every off tick re-picked castle into the
// same zombie (run8 15:52, died with one 1.1 blocks away). Each retreat
// dispatch latches the leg past the last hostile sighting; while the
// latch stands the leg re-issues without re-asking, in chooseRetreat
// and in goal.decide alike. 5 ticks at the 1 s reflex rate. A failed
// leg clears it (re-ask pillar/gohome, never hold a dead leg).
const RETREAT_HOLD_MS = 5000
function latchRetreat(ctx, action, now = Date.now()) {
  try {
    if (ctx && typeof action === 'string') ctx.retreatLatch = { action, until: now + RETREAT_HOLD_MS }
  } catch (_) { /* latch best-effort */ }
}
function latchedAction(ctx, now = Date.now()) {
  try {
    const l = ctx && ctx.retreatLatch
    if (l && typeof l.action === 'string' && typeof l.until === 'number' && now < l.until) return l.action
  } catch (_) { /* unlatchable */ }
  return null
}
function retreatLatched(ctx, now = Date.now()) {
  return latchedAction(ctx, now) !== null
}
// Release bands (vmzq.49): the Schmitt twin of the veto — engage is
// hp<6 with a hostile fact (fight target within 8), release needs hp>=8
// AND no hostile within 10. The margins cover regen flicker at 6 and
// radius flicker at 8 (the run8 15:52 flip); a truly clear tick (hp
// full, nothing near) releases at once instead of draining the latch,
// so the 1tj release property stands. Fail closed (hold): a blind tick
// keeps fleeing, and the latch TTL bounds it.
const RETREAT_RELEASE_HP = 8
const RETREAT_RELEASE_DIST = 10
function retreatClear(bot, state) {
  try {
    const hp = state && typeof state.bot_health === 'number' ? state.bot_health : NaN
    if (!(hp >= RETREAT_RELEASE_HP)) return false
    const bp = bot && bot.entity && bot.entity.position
    if (!bp || typeof bp.x !== 'number') return false
    const entities = (bot && bot.entities && typeof bot.entities === 'object') ? Object.values(bot.entities) : null
    if (!Array.isArray(entities)) return false
    for (const e of entities) {
      if (!e || e.type === 'player' || !e.position) continue
      if (!HOSTILE_NAMES.has(e.name || '')) continue
      if (e.isValid === false) continue
      let d = null
      try { d = bp.distanceTo(e.position) } catch (_) { continue }
      if (typeof d === 'number' && d <= RETREAT_RELEASE_DIST) return false
    }
    return true
  } catch (_) {
    return false
  }
}
// "Close enough to walk to": beyond this a low-health walk through mobs is
// a death march, and pillar/flee (when feasible) dominate anyway.
const HOME_WALK_RANGE = 96

function facts(bot, ctx) {
  return recover.recoverFacts(bot, ctx, null, null)
}

function hostileDist(state) {
  const d = state && state.hostile_distance
  return typeof d === 'number' ? d : null
}

// Honest gates (1tj notes): room to run, scaffold + headroom, home built
// and close. recoverFacts is the single source for the world half, shared
// with the stuck prims.
function feasibleRetreat(bot, ctx, state) {
  let f = null
  try { f = facts(bot, ctx) } catch (_) { return [] }
  if (!f) return []
  const out = []
  const hd = hostileDist(state)
  if (hd !== null && hd <= FLEE_RANGE && (f.walls || 0) < 4) out.push('retreat')
  if ((f.scaffold || 0) > 0 && !f.headBlocked) out.push('pillar')
  const home = ctx && ctx.home
  if (home && home.built && home.site && typeof home.site.x === 'number') {
    let d = null
    try {
      const bp = bot.entity && bot.entity.position
      d = Math.hypot(bp.x - home.site.x, bp.y - home.site.y, bp.z - home.site.z)
    } catch (_) { d = null }
    if (d !== null && d <= HOME_WALK_RANGE) out.push('gohome')
  }
  return RETREAT_ORDER.filter((n) => out.includes(n))
}

function nearestHostile(bot, bp) {
  let best = null
  let bestD = Infinity
  let entities = []
  try { entities = Object.values((bot && bot.entities) || {}) } catch (_) { return null }
  for (const e of entities) {
    if (!e || !e.position || e.isValid === false) continue
    let ok = false
    try { ok = isFightTarget(e, bp, null) } catch (_) { ok = false }
    if (!ok) continue
    let d = Infinity
    try { d = bp.distanceTo(e.position) } catch (_) { continue }
    if (typeof d !== 'number') continue
    if (d < bestD) { bestD = d; best = e }
  }
  return best
}

// One-prim pillar episode (recover.decide shape), shared by the chain pick
// below and the goal shelter step (ipn.12): the driver (pillar wrapper /
// shelter) owns rec.status, and a later stuck flow adopts the episode
// coherently instead of meeting foreign state.
function beginPillar(ctx, source, model) {
  ctx.recovery = {
    action: 'pillar_up', source, model, status: 'running', st: null,
    attempts: 1, fails: 0, repeats: 0, last: null, calledPlayer: false,
    endEpisode: true, lastDy: null, placeError: (ctx.placeErrors || 0) > 0,
  }
}

function pick(bot, ctx, action, source, model) {
  ctx.retreat = { action, source, model }
  ctx.retreatFailed = null
  // Hysteresis latches low-hp picks only (vmzq.49): the healthy
  // under-fire leg (0ay) keys off fresh hurt, never a hold — latching
  // it would flee stale fire for the whole TTL.
  try {
    const hp = bot && typeof bot.health === 'number' ? bot.health : NaN
    if (Number.isNaN(hp) || hp < 6) latchRetreat(ctx, action)
  } catch (_) { /* unlatchable */ }
  ctx.stepStatus = 'running'
  if (action === 'pillar') beginPillar(ctx, source, model)
  try { bot.chat(`retreating: ${RETREAT_VERBS[action]} (${source})`) } catch (_) { /* chat best-effort */ }
  return { action, source, model }
}

// Yes/no chain over the feasible options in owner order. Returns the pick
// { action, source, model } or null (caller keeps the veto-fsm decision).
// Asks at most once per situation: an all-declined chain stamps
// retreatAskedKey, and an ongoing pick (step still running) holds without
// re-asking — model calls cost, and every answer already stands.
async function chooseRetreat(brain, bot, ctx, state, now = Date.now()) {
  // A just-ended pick that failed excludes itself from the next menu: the
  // verdict is already on stepStatus (set by the behaviour), so stamp it
  // before the hold check (which needs 'running', never reached here).
  const prev = ctx && ctx.retreat
  if (prev && prev.action && ctx && typeof ctx.stepStatus === 'string' && ctx.stepStatus.indexOf('failed') === 0) {
    ctx.retreatFailed = prev.action
    ctx.retreat = null
    ctx.retreatLatch = null // vmzq.49: a failed leg re-asks, never holds
  }
  if (ctx && ctx.retreat && ctx.retreat.action && ctx.stepStatus === 'running') {
    // Low-hp only (vmzq.49, the pick gate above): a healed leg drains.
    const runHp = state && typeof state.bot_health === 'number' ? state.bot_health : NaN
    if (Number.isNaN(runHp) || runHp < 6) latchRetreat(ctx, ctx.retreat.action, now) // danger persists: hold past this sighting
    return { action: ctx.retreat.action, source: ctx.retreat.source || 'retreat', model: ctx.retreat.model || null }
  }
  // Alone-only: with a player online the normal flow (and laya's follow)
  // owns the body — the veto that calls us already implies this, belt and
  // suspenders for direct callers.
  if (state && typeof state.distance_to_player === 'number') {
    if (ctx) ctx.retreat = null
    if (ctx) ctx.retreatLatch = null
    return null
  }
  // Hysteresis (vmzq.49): a latched leg re-issues without re-asking, past
  // veto flicker. A live hostile fact refreshes the latch (keep fleeing
  // until it is gone); without one the latch drains. The hold is the
  // answer, so the decline stamp clears — expiry re-asks fresh instead
  // of inheriting a stale decline into the castle flip.
  const held = latchedAction(ctx, now)
  if (held) {
    // Low-hp only (vmzq.49, the pick gate above): a healed sighting
    // drains instead of refreshing the hold.
    const holdHp = state && typeof state.bot_health === 'number' ? state.bot_health : NaN
    if (hostileDist(state) !== null && (Number.isNaN(holdHp) || holdHp < 6)) latchRetreat(ctx, held, now)
    try { if (ctx) ctx.retreatAskedKey = null } catch (_) { /* stamp best-effort */ }
    return { action: held, source: 'retreat-hold', model: null }
  }
  const names = feasibleRetreat(bot, ctx, state)
  if (names.length === 0) {
    if (ctx) ctx.retreat = null
    return null
  }
  // A just-failed option is out of the MODEL menu while an alternative
  // stands (4jr: the model repeated pillar_up to MAX_FAILS). With a single
  // option there is nothing else to ask.
  const failed = ctx && ctx.retreatFailed
  const askNames = (failed && names.length > 1) ? names.filter((n) => n !== failed) : names
  if (askNames.length === 1) return pick(bot, ctx, askNames[0], 'only-option', null)
  const model = (brain && (brain.source || brain.name || 'model')) || 'model'
  if (!brain || typeof brain.ask !== 'function') return pick(bot, ctx, askNames[0], 'fsm', null)
  const hd = hostileDist(state)
  const hp = state && typeof state.bot_health === 'number' ? Math.round(state.bot_health) : '?'
  const n = state && typeof state.nearby_hostiles === 'number' ? state.nearby_hostiles : '?'
  // Branch and bucket on RAW health: isHard gates the veto leg on raw
  // bot_health < 6, but hp above is Math.round'ed for display — at 5.5-5.99
  // the rounded value reads 6 and would take the healthy premise/bucket on
  // a genuine low-hp ask (revmux 0ay round 2).
  const rawHp = state && typeof state.bot_health === 'number' ? state.bot_health : NaN
  const lowHp = Number.isNaN(rawHp) || rawHp < 6
  const text = `${lowHp ? 'low health' : 'taking fire'} (${hp}/20), nearest hostile ${hd === null ? '?' : hd} blocks away, ${n} hostiles near, alone`
  // 0ay: a healthy decline keys its own bucket — without it a high-hp
  // 'no' would stamp '3-5' and permanently silence a later low-hp ask.
  const hpB = Number.isNaN(rawHp) ? '?' : rawHp < 3 ? '0-2' : rawHp < 6 ? '3-5' : '6-20'
  const instructions = lowHp ? RETREAT_INSTRUCTIONS : RETREAT_INSTRUCTIONS_UNDER_FIRE
  const hdB = hd === null ? '?' : hd <= 2 ? 'adj' : hd <= FLEE_RANGE ? 'near' : 'far'
  const key = `${hpB}:${hdB}:${askNames.join('+')}`
  if (ctx && ctx.retreatAskedKey === key) return null // declined already, situation unchanged
  let heard = false // any model response (even an invalid label) means it is alive
  for (const opt of askNames) {
    const criteria = { [opt]: RETREAT_CRITERIA[opt], no: RETREAT_CRITERIA.no }
    let label = null
    try {
      label = await brain.ask({ state: text, instructions, criteria, situation: text })
      heard = true
    } catch (_) { label = null }
    if (label === opt) return pick(bot, ctx, opt, model, model)
    if (label !== 'no') {
      try { console.error(`brain disagree source=${model} model=${label} fsm=none reason=retreat facts=${text}`) } catch (_) { /* log best-effort */ }
    }
    // 'no' (or an invalid label): next question.
  }
  if (!heard) return pick(bot, ctx, askNames[0], 'fsm-fallback', null)
  if (ctx) ctx.retreatAskedKey = key
  if (ctx) ctx.retreat = null
  return null
}

// BEHAVIOURS entry: run from the hostile, same away-goal math as the
// creeper fleeReflex. Done when nothing chases (far or gone); the stuck
// watch downstream owns a blocked run.
function retreat(bot, ctx) {
  const bp = bot.entity && bot.entity.position
  if (!bp) {
    ctx.stepStatus = 'failed:retreat-no-pos'
    ctx.retreatFailed = 'retreat'
    return
  }
  const hostile = nearestHostile(bot, bp)
  let d = null
  try { d = hostile ? bp.distanceTo(hostile.position) : null } catch (_) { d = null }
  if (!hostile || d === null || d > FLEE_DONE_DIST) {
    ctx.stepStatus = 'done'
    return
  }
  let dx = bp.x - hostile.position.x
  let dz = bp.z - hostile.position.z
  if (dx === 0 && dz === 0) dx = 1
  const len = Math.hypot(dx, dz) || 1
  const nx = bp.x + (dx / len) * FLEE_DIST
  const nz = bp.z + (dz / len) * FLEE_DIST
  const key = `retreat:${hostile.id}`
  // No path for our own away goal: fail loudly so the chain offers pillar /
  // gohome instead of holding a run that stands still. Scoped to our key:
  // lastPathStatus is shared with every other behaviour's goals.
  if (key === ctx.lastGoalKey && ctx.lastPathStatus === 'noPath') {
    ctx.stepStatus = 'failed:retreat-no-path'
    ctx.retreatFailed = 'retreat'
    return
  }
  let moving = false
  try { moving = !!(bot.pathfinder && typeof bot.pathfinder.isMoving === 'function' && bot.pathfinder.isMoving()) } catch (_) { /* stationary default */ }
  if (key !== ctx.lastGoalKey || !moving) {
    try {
      bot.pathfinder.setGoal(new goals.GoalNear(nx, bp.y, nz, 1), false)
      ctx.lastGoalKey = key
    } catch (_) { /* goal best-effort */ }
  }
  ctx.stepStatus = 'running'
}

// BEHAVIOURS entry: the recover pillar_up prim on a retreat episode (set by
// pick), with its status mirrored to the step so done/failure re-decides.
// The shared 'pillar_up' entry stays the stuck flow's (no stepStatus there).
// A terminal prim status is mirrored, never re-driven: recover.run would
// restart the prim and overwrite the verdict with a fresh 'running'.
function pillar(bot, ctx) {
  const before = ctx && ctx.recovery && ctx.recovery.status
  if (before === 'running' || before === 'starting' || before == null) {
    recover.run(bot, ctx)
  }
  const st = ctx.recovery && ctx.recovery.status
  if (st === 'done') {
    ctx.stepStatus = 'done'
    // Placement works again: clear the pillar streak (vmzq.47).
    try { recover.noteRecoverDone(ctx, botPos(bot), 'pillar_up') } catch (_) { /* bans best-effort */ }
  } else if (typeof st === 'string' && st !== 'running' && st !== 'starting') {
    ctx.stepStatus = `failed:pillar-${st.replace(/^failed:/, '')}`
    ctx.retreatFailed = 'pillar'
    // A refused retreat pillar bans the recover pillar here too (vmzq.47):
    // the same server says no to the same feet cell one tick later.
    if (st === 'failed:place-error') {
      try { recover.noteRecoverFail(ctx, botPos(bot), 'pillar_up', st) } catch (_) { /* bans best-effort */ }
    }
  } else {
    return // still running: the live episode keeps owning ctx.recovery
  }
  // Terminal verdict copied: release the episode. While ctx.recovery stands,
  // the stuck detectors stay off and a later stuck episode would release
  // instantly off this stale record (revmux 1tj round-1). Only our episode:
  // if a stuck flow adopted the prim meanwhile it cleared ctx.retreat first.
  if (ctx && ctx.retreat) ctx.recovery = null
}

module.exports = { RETREAT_ORDER, RETREAT_INSTRUCTIONS, RETREAT_CRITERIA, HOME_WALK_RANGE, RETREAT_HOLD_MS, RETREAT_RELEASE_HP, RETREAT_RELEASE_DIST, feasibleRetreat, chooseRetreat, retreat, pillar, beginPillar, latchRetreat, latchedAction, retreatLatched, retreatClear }
