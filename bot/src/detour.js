'use strict'

// Detour waypoints (idkcraft-rw4.12): gohome and forage route around live
// danger marks instead of walking a marked pit straight. Pure geometry:
// via() returns one waypoint past the first mark intersecting the leg, or
// null for go-direct (no marks, feet/target inside a mark, the segment
// misses every disc, both sides marked). The waypoint hangs the mark's own
// radius + MARGIN off the mark centre, perpendicular to the leg, on the shorter
// side, floored to whole cells: GoalNear aims at the floored cell, so
// arrival must measure from it too (revmux 01). Never throws.

const danger = require('./danger')

const MARGIN = 2 // body + approach past the avoid disc

function num(n) {
  return typeof n === 'number' && Number.isFinite(n)
}

function via(ctx, from, to, now) {
  try {
    if (!from || !to || !num(from.x) || !num(from.z) || !num(to.x) || !num(to.z)) return null
    const dx = to.x - from.x
    const dz = to.z - from.z
    const len = Math.hypot(dx, dz)
    if (!(len > 0)) return null
    const spots = danger.spots(ctx, now)
    if (!spots || spots.length === 0) return null
    const rad = (s) => danger.spotRadius(s)
    const close = (p) => spots.some((s) => Math.hypot(s.x - p.x, s.z - p.z) <= rad(s))
    // Feet inside: recover owns the pit. Target inside: the leg's own
    // stall/strike owns the cell. Either way no waypoint helps.
    if (close(from) || close(to)) return null
    // First disc the leg pierces, walking from->to.
    let hit = null
    let hitT = Infinity
    for (const s of spots) {
      const t = ((s.x - from.x) * dx + (s.z - from.z) * dz) / (len * len)
      if (t < 0 || t > 1) continue
      const px = from.x + dx * t
      const pz = from.z + dz * t
      if (Math.hypot(s.x - px, s.z - pz) > rad(s)) continue
      if (t < hitT) { hitT = t; hit = s }
    }
    if (!hit) return null
    const off = rad(hit) + MARGIN // 9kd: wide water-death discs route around the whole swim
    const nx = -dz / len
    const nz = dx / len
    const y = num(from.y) ? from.y : 64
    const cands = [
      { x: Math.floor(hit.x + nx * off), y, z: Math.floor(hit.z + nz * off) },
      { x: Math.floor(hit.x - nx * off), y, z: Math.floor(hit.z - nz * off) },
    ]
    const free = cands.filter((c) => !close(c))
    if (free.length === 0) return null
    // Shorter total walk wins; ties keep the +normal side.
    let best = free[0]
    let bestLen = Infinity
    for (const c of free) {
      const L = Math.hypot(c.x - from.x, c.z - from.z) + Math.hypot(to.x - c.x, to.z - c.z)
      if (L < bestLen) { bestLen = L; best = c }
    }
    return best
  } catch (_) { return null }
}

module.exports = { via, MARGIN }
