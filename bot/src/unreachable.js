'use strict'

// Shared short-lived blacklist of world sources a step could not reach
// (prod 2026-11-15 bot3: acquire mined the same pathless birch 133x/h).
// acquire marks a block's cluster or a whole worked-out area; gather,
// explore's source count and acquire's own picks skip them until TTL.
// XZ discs: a tree or ore vein is a column, the area is a circle.

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

module.exports = { mark, near, TTL_MS }
