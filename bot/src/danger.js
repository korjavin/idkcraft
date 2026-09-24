'use strict'

// Danger memory (idkcraft-mnx): gave-up/call_player spots that explore and
// gather must not lead back into. Separate from the resource finds store:
// these are avoidances, never targets. Distance is xz-only (pits are
// vertical; the bot's level never matches the mark exactly). Bounded + TTL,
// never throws.

const MAX_SPOTS = 64
const TTL_MS = 2 * 60 * 60 * 1000 // a filled pit goes stale within a session
const AVOID_RADIUS = 6 // pit + body + approach margin

function store(ctx) {
  if (!ctx) return null
  if (!ctx.danger) ctx.danger = { spots: [] }
  if (!Array.isArray(ctx.danger.spots)) ctx.danger.spots = []
  return ctx.danger
}

// Mark {x, y, z} dangerous now. A re-mark refreshes. Returns spot count.
function mark(ctx, p, now) {
  const mem = store(ctx)
  if (!mem || !p || typeof p.x !== 'number' || typeof p.z !== 'number') return 0
  const t = typeof now === 'number' ? now : Date.now()
  prune(ctx, t)
  const y = typeof p.y === 'number' ? p.y : 0
  const i = mem.spots.findIndex((s) => Math.hypot(s.x - p.x, s.z - p.z) < 1 && Math.abs(s.y - y) < 2)
  if (i >= 0) mem.spots.splice(i, 1)
  mem.spots.push({ x: p.x, y, z: p.z, at: t })
  while (mem.spots.length > MAX_SPOTS) mem.spots.shift()
  return mem.spots.length
}

// True when (x, z) lies within radius of a live mark.
function near(ctx, p, radius, now) {
  const mem = ctx && ctx.danger
  if (!mem || !Array.isArray(mem.spots) || mem.spots.length === 0) return false
  if (!p || typeof p.x !== 'number' || typeof p.z !== 'number') return false
  const r = typeof radius === 'number' ? radius : AVOID_RADIUS
  const t = typeof now === 'number' ? now : Date.now()
  for (const s of mem.spots) {
    if (t - s.at > TTL_MS) continue
    if (Math.hypot(s.x - p.x, s.z - p.z) <= r) return true
  }
  return false
}

function prune(ctx, now) {
  const mem = ctx && ctx.danger
  if (!mem || !Array.isArray(mem.spots)) return 0
  const t = typeof now === 'number' ? now : Date.now()
  const before = mem.spots.length
  mem.spots = mem.spots.filter((s) => t - s.at <= TTL_MS)
  return before - mem.spots.length
}

function count(ctx) {
  const mem = ctx && ctx.danger
  return mem && Array.isArray(mem.spots) ? mem.spots.length : 0
}

function clear(ctx) {
  if (ctx && ctx.danger && Array.isArray(ctx.danger.spots)) ctx.danger.spots.length = 0
}

module.exports = { mark, near, prune, count, clear, MAX_SPOTS, TTL_MS, AVOID_RADIUS }
