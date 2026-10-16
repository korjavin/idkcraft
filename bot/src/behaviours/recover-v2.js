'use strict'

// v2 recover escape (idkcraft-neuc.52): on a Baritone body
// (BOT_BODY=baritone) the mineflayer ladder in recover.js misfires rung by
// rung (neuc.30/.31/.34/.48/.49), while Baritone itself breaks and places
// while pathing. A v2 episode therefore issues ONE native goal — the
// nearest sky-open standable cell — instead of running the ladder. v1
// (BOT_BODY unset) never reaches here: escape() returns false and the
// ladder runs byte-identical.
//
// Wiring (recover.js owns the episode; this file only picks cells):
//   - decide() calls escape() at episode entry; true opens the episode.
//   - recover.run() drives run() for the escape action with helpers
//     injected (logRecover/release/recoverFacts/callPlayerFeasible) —
//     this file keeps no require edge back into recover.js (the require
//     graph is acyclic) and is not a menu rung (ORDER/MENU parity).
//   - BEHAVIOURS.escape (behaviours/index.js) routes dispatch to
//     recover.run like every other primitive.
// STALL budget stays the bridge's 10 s: a hung goal surfaces as noPath
// there and run() advances the candidate here. Bridge code untouched.

const { Vec3 } = require('vec3')
const { goals } = require('mineflayer-pathfinder')
const metrics = require('../metrics')
const danger = require('../danger')
const bodyLease = require('../body')
const { botPos, issueGoal } = require('./util')

const RADIUS = 8 // cell search radius around the feet, per the bead
const SKY_CLEAR = 14 // air cells needed above the head for open sky
const COLUMN_SCAN = 12 // liquid scan above the head: never tunnel into water
const MAX_TRIES = 3 // candidates per episode, then the old call_player rung
const ANCHOR_DIST = 3 // moved this far from the wedge: a new situation, done
const ARRIVE_DIST = 1 // within this of the target cell centre: arrived…
const ARRIVE_MOVED = 0.5 // …but only past this displacement from the wedge anchor (an adjacent first candidate reads exactly 1.0 at issue, before Baritone moves)
const MAX_TICKS = 180 // backstop when no verdict ever lands (~1 Hz ticks): try the next candidate instead of holding forever (v1 rungs cap at 8-40)
const ESCAPE_KEY = 'recover-escape' // lastGoalKey of the live escape goal

function isV2() {
  try { return process.env.BOT_BODY === 'baritone' } catch (_) { return false }
}

// Local solid/liquid reads (same semantics as recover.js, no import edge
// back into it: recover.js requires this file at top level).
function solid(b) {
  if (!b) return false
  if (typeof b.boundingBox === 'string') return b.boundingBox !== 'empty'
  const n = typeof b.name === 'string' ? b.name : ''
  return n !== '' && !n.endsWith('air') && n !== 'water' && n !== 'lava'
}

function liquidName(n) {
  return typeof n === 'string' && /water|lava|bubble_column|kelp|seagrass/.test(n)
}

function cell(bot, x, y, z) {
  try { return bot && bot.blockAt ? bot.blockAt(new Vec3(x, y, z)) : null } catch (_) { return null }
}

// Standable = solid below, 2 air above, no liquid at feet/head. Nulls read
// as unstandable (never pick a blind cell).
function standableAt(bot, x, y, z) {
  const below = cell(bot, x, y - 1, z)
  const feet = cell(bot, x, y, z)
  const head = cell(bot, x, y + 1, z)
  if (!below || !feet || !head) return false
  if (!solid(below) || solid(feet) || solid(head)) return false
  if (liquidName(feet.name) || liquidName(head.name)) return false
  return true
}

// True when the column above the head is clear air up to SKY_CLEAR.
// Unreadable or solid reads closed (a cave ceiling, a canopy, unloaded).
function skyOpenAbove(bot, x, y, z) {
  for (let dy = 2; dy < 2 + SKY_CLEAR; dy++) {
    const b = cell(bot, x, y + dy, z)
    if (!b || solid(b)) return false
  }
  return true
}

// True when the column above the head crosses liquid or unreadable cells:
// digging toward that target could open water/lava (or a blind shaft).
function columnLiquid(bot, x, y, z) {
  for (let dy = 2; dy < 2 + COLUMN_SCAN; dy++) {
    const b = cell(bot, x, y + dy, z)
    if (!b || liquidName(b.name)) return true
  }
  return false
}

// Nearest-first candidates: sky-open standable cells within RADIUS, feet
// column excluded (the bridge answers an in-column goal with silence),
// danger discs excluded, liquid columns excluded. At/above the feet sorts
// first; a cave fallback (nearest standable, still 2 air) applies when no
// column sees sky. Returns [{x,y,z}] feet cells, best first.
function pickCandidates(bot, ctx, bp) {
  const fx = Math.floor(bp.x)
  const fy = Math.floor(bp.y)
  const fz = Math.floor(bp.z)
  const out = []
  for (let dx = -RADIUS; dx <= RADIUS; dx++) {
    for (let dz = -RADIUS; dz <= RADIUS; dz++) {
      if (dx === 0 && dz === 0) continue // own column: silence, per the bead
      if (Math.hypot(dx, dz) > RADIUS) continue
      for (let dy = -3; dy <= 4; dy++) {
        const x = fx + dx
        const y = fy + dy
        const z = fz + dz
        if (!standableAt(bot, x, y, z)) continue
        try {
          if (danger.covers(ctx, { x, z })) continue
        } catch (_) { /* danger best-effort */ }
        if (columnLiquid(bot, x, y, z)) continue
        out.push({
          x, y, z,
          sky: skyOpenAbove(bot, x, y, z),
          above: y >= fy,
          d: Math.hypot(bp.x - (x + 0.5), bp.y - y, bp.z - (z + 0.5)),
        })
      }
    }
  }
  if (out.length === 0) return []
  const sky = out.filter((c) => c.sky)
  const pool = sky.length > 0 ? sky : out
  pool.sort((a, b) => ((b.above ? 1 : 0) - (a.above ? 1 : 0)) || (a.d - b.d))
  return pool.slice(0, 6).map(({ x, y, z }) => ({ x, y, z }))
}

function issueTarget(bot, ctx, st, t) {
  const g = new goals.GoalNear(t.x, t.y, t.z, 0)
  st.goal = g
  st.key = ESCAPE_KEY
  // No tick reset here: a liveness re-issue of the SAME candidate must not
  // restart its budget (a repeated steal would hold one cell forever).
  // escape() and nextOrPage() zero the budget with each NEW candidate.
  issueGoal(bot, ctx, g, ESCAPE_KEY, true)
  try { ctx.lastPathStatus = 'none' } catch (_) { /* fresh verdict for the new goal */ }
}

// Episode entry, called from decide() right after dropGoal. Fills the
// already-created ctx.recovery (metrics/routes already counted there),
// issues the first goal and returns true; false runs the old ladder.
// With no candidate the episode still opens (st.noCandidate) and run()
// pages-or-gives-up at once — v2 never falls back to the ladder, only
// its last rung survives. deps carries { logRecover } (no back-require).
function escape(bot, ctx, facts, deps) {
  if (!isV2()) return false
  let bp = null
  try { bp = botPos(bot) } catch (_) { return false }
  if (!bp) return false
  const rec = ctx && ctx.recovery
  if (!rec) return false
  let cands = null
  try { cands = pickCandidates(bot, ctx, bp) } catch (_) { return false }
  rec.action = 'escape'
  rec.source = 'fsm'
  rec.model = null
  rec.status = 'running'
  rec.attempts = (rec.attempts || 0) + 1
  // The lease refresh applies the escape movements (canDig +
  // allow1by1towers) BEFORE the goal goes out: the bridge pushes
  // allowBreak/allowPlace on setGoal, so issuing first would send the
  // previous owner's flags. Same owner: refresh-only, no cleanup.
  try { bodyLease.claimBody(bot, ctx, 'recover', { escape: true }) } catch (_) { /* lease best-effort */ }
  if (!cands || cands.length === 0) {
    rec.st = { candidates: [], idx: 0, target: null, anchor: { x: bp.x, y: bp.y, z: bp.z }, noCandidate: true, ticks: 0 }
    try { metrics.recover.inc({ action: 'escape', source: 'fsm', outcome: 'chosen' }) } catch (_) { /* metric best-effort */ }
    try {
      if (deps && typeof deps.logRecover === 'function') deps.logRecover(bot, ctx, 'escape', 'fsm', 'chosen', facts)
    } catch (_) { /* log best-effort */ }
    try { console.log(`recover v2 escape -> none (no sky cell) pos=${fmtShort(bp)}`) } catch (_) { /* log best-effort */ }
    return true
  }
  const t = cands[0]
  rec.st = { candidates: cands, idx: 0, target: t, anchor: { x: bp.x, y: bp.y, z: bp.z }, ticks: 0 }
  try { issueTarget(bot, ctx, rec.st, t) } catch (_) { /* run() re-issues below */ }
  try { metrics.recover.inc({ action: 'escape', source: 'fsm', outcome: 'chosen' }) } catch (_) { /* metric best-effort */ }
  try {
    if (deps && typeof deps.logRecover === 'function') deps.logRecover(bot, ctx, 'escape', 'fsm', 'chosen', facts)
  } catch (_) { /* log best-effort */ }
  try { console.log(`recover v2 escape -> ${t.x} ${t.y} ${t.z} sky cands=${cands.length} pos=${fmtShort(bp)}`) } catch (_) { /* log best-effort */ }
  try {
    let marked = false
    try { marked = danger.near(ctx, bp) } catch (_) { marked = false }
    if (!marked) bot.chat('stuck, trying escape (fsm)')
  } catch (_) { /* chat best-effort */ }
  return true
}

function fmtShort(p) {
  if (!p) return 'unknown'
  const f = (n) => (typeof n === 'number' ? (Number.isInteger(n) ? n : n.toFixed(1)) : '0')
  return `${f(p.x)},${f(p.y)},${f(p.z)}`
}

// Candidates spent: the old ladder's last rung only — page when anyone can
// hear it (same feasibility as RECOVER_MENU.call_player), else gave-up.
// Helpers come in deps from recover.js (no back-require).
function nextOrPage(bot, ctx, deps) {
  const rec = ctx.recovery
  const st = rec.st
  st.idx += 1
  if (st.idx < st.candidates.length && st.idx < MAX_TRIES) {
    const t = st.candidates[st.idx]
    st.target = t
    st.ticks = 0
    try { issueTarget(bot, ctx, st, t) } catch (_) { /* retried by the liveness check below */ }
    try { console.log(`recover v2 escape -> ${t.x} ${t.y} ${t.z} retry idx=${st.idx}`) } catch (_) { /* log best-effort */ }
    return 'running'
  }
  const d = deps || {}
  let facts = null
  try { facts = typeof d.recoverFacts === 'function' ? d.recoverFacts(bot, ctx, null, null) : null } catch (_) { facts = null }
  let page = false
  try { page = !!(facts && typeof d.callPlayerFeasible === 'function' && d.callPlayerFeasible(facts, ctx)) } catch (_) { page = false }
  if (page) {
    rec.action = 'call_player'
    rec.source = 'fsm'
    rec.model = null
    rec.status = 'running'
    rec.st = null
    rec.attempts = (rec.attempts || 0) + 1
    try { metrics.recover.inc({ action: 'call_player', source: 'fsm', outcome: 'chosen' }) } catch (_) { /* metric best-effort */ }
    try { if (typeof d.logRecover === 'function') d.logRecover(bot, ctx, 'call_player', 'fsm', 'chosen', facts) } catch (_) { /* log best-effort */ }
    return 'running'
  }
  try { if (typeof d.release === 'function') d.release(bot, ctx, 'gave-up') } catch (_) { /* release best-effort */ }
  return 'gave-up'
}

// Per-tick driver, dispatched from recover.run for the escape action.
// Total: only 'running' | 'done' | 'gave-up' — internal failures degrade
// to the next candidate, never to the v1 ladder.
function run(bot, ctx, deps) {
  try {
    const rec = ctx && ctx.recovery
    const st = rec && rec.st
    if (!rec || !st) return 'running' // released mid-flight: the next tick routes away
    if (st.noCandidate || !st.target) return nextOrPage(bot, ctx, deps)
    let bp = null
    try { bp = botPos(bot) } catch (_) { bp = null }
    if (!bp) return 'running' // transient read: wait a tick, the budget below bounds it
    // Every tick counts toward the candidate budget — including re-issue
    // ticks — so a repeated steal advances instead of holding one cell.
    st.ticks = (st.ticks | 0) + 1
    // A stolen or parked goal (fight, pause, breath) is re-issued, not
    // waited on: its verdicts belong to the other owner. Untracked st
    // (hand-built in tests) skips this and stays verdict-driven.
    if (st.key && (ctx.lastGoalKey !== st.key || !bot.pathfinder || bot.pathfinder.goal !== st.goal)) {
      try { issueTarget(bot, ctx, st, st.target) } catch (_) { /* budget already advanced above */ }
      if (st.ticks > MAX_TICKS) return nextOrPage(bot, ctx, deps)
      return 'running'
    }
    const t = st.target
    const a = st.anchor
    const moved = a ? Math.hypot(bp.x - a.x, bp.y - a.y, bp.z - a.z) : 0
    if (Math.hypot(bp.x - (t.x + 0.5), bp.y - t.y, bp.z - (t.z + 0.5)) <= ARRIVE_DIST && moved > ARRIVE_MOVED) return 'done'
    if (a && moved > ANCHOR_DIST) return 'done'
    const status = ctx.lastPathStatus
    if (status === 'success') return 'done'
    if (status === 'noPath' || status === 'timeout') return nextOrPage(bot, ctx, deps)
    if (st.ticks > MAX_TICKS) return nextOrPage(bot, ctx, deps)
    return 'running'
  } catch (_) {
    try { return nextOrPage(bot, ctx, deps) } catch (_) { return 'running' }
  }
}

module.exports = { isV2, escape, run, pickCandidates, RADIUS, MAX_TRIES, MAX_TICKS, ANCHOR_DIST, ESCAPE_KEY }
