'use strict'

// Danger memory (idkcraft-mnx): gave-up/call_player spots that explore and
// gather must not lead back into, and gohome/forage route around (rw4.12). Separate from the resource finds store:
// these are avoidances, never targets. Distance is xz-only (pits are
// vertical; the bot's level never matches the mark exactly). Bounded + TTL,
// never throws.

const MAX_SPOTS = 64
const TTL_MS = 2 * 60 * 60 * 1000 // a filled pit goes stale within a session
const AVOID_RADIUS = 6 // pit + body + approach margin
const WATER_RADIUS = 32 // a water death bans the swim around it, not one cell
const MAX_RADIUS = 64 // widest mark: an ocean monument

function store(ctx) {
  if (!ctx) return null
  if (!ctx.danger) ctx.danger = { spots: [] }
  if (!Array.isArray(ctx.danger.spots)) ctx.danger.spots = []
  return ctx.danger
}

// Sanitized mark radius: finite clamps into [1, MAX_RADIUS], anything else
// reads as the default (never stored — default marks keep the old shape).
function radOf(r) {
  if (typeof r !== 'number' || !Number.isFinite(r)) return AVOID_RADIUS
  return Math.min(Math.max(r, 1), MAX_RADIUS)
}

// Effective radius of one stored spot: its own wide mark, else the default.
function spotRadius(s) {
  const r = s && typeof s.r === 'number' && Number.isFinite(s.r) ? s.r : AVOID_RADIUS
  return r > 0 ? r : AVOID_RADIUS
}

// Mark {x, y, z} dangerous now. A re-mark refreshes. radius is optional
// (9kd: water deaths ban a wide disc); default marks keep the old shape.
// Returns spot count.
function mark(ctx, p, now, radius) {
  const mem = store(ctx)
  if (!mem || !p || typeof p.x !== 'number' || typeof p.z !== 'number') return 0
  const t = typeof now === 'number' ? now : Date.now()
  prune(ctx, t)
  const y = typeof p.y === 'number' ? p.y : 0
  const i = mem.spots.findIndex((s) => Math.hypot(s.x - p.x, s.z - p.z) < 1 && Math.abs(s.y - y) < 2)
  if (i >= 0) mem.spots.splice(i, 1)
  const spot = { x: p.x, y, z: p.z, at: t }
  const r = radOf(radius)
  if (r !== AVOID_RADIUS) spot.r = r
  mem.spots.push(spot)
  while (mem.spots.length > MAX_SPOTS) mem.spots.shift()
  return mem.spots.length
}

// True when (x, z) lies within radius of a live mark. An explicit radius
// covers every mark uniformly; without one each mark uses its own width
// (9kd: a water-death disc bans ring picks 32 out, pit marks still 6).
function near(ctx, p, radius, now) {
  const mem = ctx && ctx.danger
  if (!mem || !Array.isArray(mem.spots) || mem.spots.length === 0) return false
  if (!p || typeof p.x !== 'number' || typeof p.z !== 'number') return false
  const r = typeof radius === 'number' ? radius : null
  const t = typeof now === 'number' ? now : Date.now()
  for (const s of mem.spots) {
    if (t - s.at > TTL_MS) continue
    if (Math.hypot(s.x - p.x, s.z - p.z) <= (r === null ? spotRadius(s) : r)) return true
  }
  return false
}

// Live marks as fresh {x, y, z} points for planning (rw4.12 detour).
// Copies: callers cannot corrupt the memory. Wide marks ride .r (default
// marks keep the old shape). Never throws.
function spots(ctx, now) {
  try {
    const mem = ctx && ctx.danger
    if (!mem || !Array.isArray(mem.spots)) return []
    const t = typeof now === 'number' ? now : Date.now()
    const out = []
    for (const s of mem.spots) {
      if (!s || typeof s.x !== 'number' || typeof s.z !== 'number') continue
      if (t - s.at > TTL_MS) continue
      const c = { x: s.x, y: typeof s.y === 'number' ? s.y : 0, z: s.z }
      const r = spotRadius(s)
      if (r !== AVOID_RADIUS) c.r = r
      out.push(c)
    }
    return out
  } catch (_) { return [] }
}

// Death in water (9kd): guardians are not in the hostile snapshot, so a
// monument kill reads as nearest=none and nothing was ever marked — the
// sheep search walked the same cell again 3 hours later. Any water death
// marks the wide disc: even a zombie-chased drowning means dangerous
// water, and the TTL bounds the ban. True when marked, never throws.
function markWaterDeath(bot, ctx, now) {
  try {
    const pos = bot && bot.entity && bot.entity.position
    if (!pos || typeof pos.x !== 'number' || !ctx) return false
    let name = null
    try {
      const b = bot.blockAt && bot.blockAt(pos)
      name = b && b.name
    } catch (_) { name = null }
    if (name !== 'water') return false
    mark(ctx, pos, now, WATER_RADIUS)
    return true
  } catch (_) { return false }
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

module.exports = { mark, near, spots, prune, count, clear, markWaterDeath, spotRadius, MAX_SPOTS, TTL_MS, AVOID_RADIUS, WATER_RADIUS, MAX_RADIUS }
