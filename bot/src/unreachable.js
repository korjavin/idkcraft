'use strict'

// Shared short-lived blacklist of world sources a step could not reach
// (prod 2026-11-15 bot3: acquire mined the same pathless birch 133x/h).
// acquire marks a block's cluster or a whole worked-out area; gather,
// explore's source count and acquire's own picks skip them until TTL.
// XZ discs: a tree or ore vein is a column, the area is a circle.

const { stepFailed, isFinished } = require('./step')

const TTL_MS = 10 * 60 * 1000
const MAX = 128

function mark(ctx, p, r, now = Date.now()) {
  if (!ctx || !p) return
  const l = Array.isArray(ctx.unreachable) ? ctx.unreachable : (ctx.unreachable = [])
  l.push({ x: p.x, z: p.z, r, at: now })
  if (l.length > MAX) l.shift()
}

function near(ctx, p, now = Date.now()) {
  const l = ctx && ctx.unreachable
  if (!Array.isArray(l) || !p) return false
  return l.some((s) => now - s.at <= TTL_MS && Math.hypot(p.x - s.x, p.z - s.z) <= s.r)
}

// One shared noPath reaction (owner 2026-11-18: bots stood with why=nopath
// hundreds of ticks an hour until each behaviour's own timeout). A work
// step whose pathfinder goal answers noPath GRACE_TICKS ticks in a row
// (behaviours that re-target on noPath clear the verdict within a tick)
// ends failed:unreachable at once so the arbiter picks other work, and the
// goal cell is marked here so gather/explore/acquire pick another target.
// A marked cell fails on its first noPath. Called once per tick by index.js.
const GRACE_TICKS = 2
// Steps with their own per-target unreachable ladder (castle: far, dig-/step-approach, retire).
const OWN_LADDER = new Set(['castle'])
function goalCell(g) {
  const p = g && g.pos && Number.isFinite(g.pos.x) ? g.pos : g
  return p && Number.isFinite(p.x) && Number.isFinite(p.z) ? { x: Math.floor(p.x) + 0.5, z: Math.floor(p.z) + 0.5 } : null
}
function tick(bot, ctx, now = Date.now()) {
  const g = bot.pathfinder && bot.pathfinder.goal
  const w = ctx.noPathWatch || (ctx.noPathWatch = { goal: null, n: 0 })
  if (!g || ctx.lastPathStatus !== 'noPath') { w.goal = null; w.n = 0; return false }
  if (w.goal !== g) { w.goal = g; w.n = 0 }
  w.n++
  if (!ctx.work || !ctx.step || isFinished(ctx.stepStatus)) return false
  const cell = goalCell(g)
  if (OWN_LADDER.has(ctx.step)) {
    // own per-target ladder keeps the step: mark the cell once per goal only
    if (w.n === GRACE_TICKS && cell) mark(ctx, cell, 1, now)
    return false
  }
  if (w.n < GRACE_TICKS && !(cell && near(ctx, cell, now))) return false
  if (cell) mark(ctx, cell, 1, now)
  w.goal = null
  w.n = 0
  try { bot.pathfinder.setGoal(null) } catch (_) { /* best-effort */ }
  stepFailed(ctx, 'unreachable')
  try { console.log(`path unreachable step=${ctx.step} goal=${(g.constructor && g.constructor.name) || 'goal'} ${cell ? `${Math.floor(cell.x)},${Math.floor(cell.z)}` : '?'}`) } catch (_) { /* log best-effort */ }
  return true
}

module.exports = { mark, near, tick, TTL_MS, GRACE_TICKS, OWN_LADDER }
