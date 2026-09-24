'use strict'

// Resource memory (idkcraft-atl.1): the shared find store for the forage
// step. explore.js fills it from arrival scans (ores + trees via scout's
// exported resolvers — scout.js itself is untouched for amb); forage
// (atl.2) reads it. Dumb by design: position, type, time; forage
// re-validates on arrival. Bounded (oldest out), never throws.

const scout = require('./behaviours/scout')

const MAX_ITEMS = 256
const SCAN_RADIUS = 48 // same reach as gather's FIND_RADIUS
const SCAN_COUNT = 64

function keyOf(p) {
  return `${p.x},${p.y},${p.z}`
}

function store(ctx) {
  if (!ctx) return null
  if (!ctx.resources) ctx.resources = { items: new Map() }
  if (!(ctx.resources.items instanceof Map)) ctx.resources.items = new Map()
  return ctx.resources
}

// Spots: [{ x, y, z, name }], now ms. Returns the count newly added
// (re-notes refresh the timestamp, oldest-out past the cap).
function noteSpots(ctx, spots, now) {
  const mem = store(ctx)
  if (!mem || !Array.isArray(spots)) return 0
  const t = typeof now === 'number' ? now : Date.now()
  let added = 0
  for (const s of spots) {
    if (!s || typeof s.x !== 'number' || typeof s.name !== 'string') continue
    const k = keyOf(s)
    if (mem.items.has(k)) mem.items.delete(k)
    else added++
    mem.items.set(k, { x: s.x, y: s.y, z: s.z, name: s.name, at: t })
  }
  while (mem.items.size > MAX_ITEMS) {
    mem.items.delete(mem.items.keys().next().value)
  }
  return added
}

// Nearest stored find to (x, y, z), optionally restricted to exact type
// names. exclude(item) skips entries (atl.5: gather's skip set — nearest
// alone returns one point, so one skipped memory point would hide the rest).
// Null when empty or nothing matches.
function nearest(ctx, p, kinds, exclude) {
  const mem = ctx && ctx.resources
  if (!mem || !(mem.items instanceof Map) || mem.items.size === 0) return null
  const want = Array.isArray(kinds) && kinds.length > 0 ? new Set(kinds) : null
  const skip = typeof exclude === 'function' ? exclude : null
  let best = null
  let bestD = Infinity
  for (const item of mem.items.values()) {
    if (want && !want.has(item.name)) continue
    if (skip && skip(item)) continue
    const d = Math.hypot(item.x - p.x, item.y - p.y, item.z - p.z)
    if (d < bestD) {
      bestD = d
      best = item
    }
  }
  return best
}

function count(ctx) {
  const mem = ctx && ctx.resources
  return mem && mem.items instanceof Map ? mem.items.size : 0
}

function clear(ctx) {
  if (ctx && ctx.resources && ctx.resources.items instanceof Map) ctx.resources.items.clear()
}

// Drop one cell (mined out or picked clean): true when something was there.
function forget(ctx, x, y, z) {
  const mem = ctx && ctx.resources
  if (!mem || !(mem.items instanceof Map)) return false
  return mem.items.delete(x + ',' + y + ',' + z)
}

// Arrival scan: ores + trees around the bot into memory. Returns
// { added, total }. Best-effort like every other perception seam.
function scan(bot, ctx, opts) {
  const o = opts || {}
  const radius = typeof o.radius === 'number' ? o.radius : SCAN_RADIUS
  const maxCount = typeof o.count === 'number' ? o.count : SCAN_COUNT
  const now = typeof o.now === 'number' ? o.now : Date.now()
  let ids = []
  try {
    ids = ids.concat(scout.resolveFindIds(bot, 'ore') || [])
    ids = ids.concat(scout.resolveFindIds(bot, 'logs') || [])
  } catch (_) {
    return { added: 0, total: count(ctx) }
  }
  if (ids.length === 0) return { added: 0, total: count(ctx) }
  let found = []
  try {
    found = (bot.findBlocks({ matching: ids, maxDistance: radius, count: maxCount }) || [])
  } catch (_) {
    return { added: 0, total: count(ctx) }
  }
  const spots = []
  for (const p of found) {
    let name = null
    try {
      const b = bot.blockAt && bot.blockAt(p)
      name = b && b.name
    } catch (_) {
      name = null
    }
    if (!name) continue
    spots.push({ x: p.x, y: p.y, z: p.z, name })
  }
  const added = noteSpots(ctx, spots, now)
  return { added, total: count(ctx) }
}

module.exports = { noteSpots, nearest, count, clear, forget, scan, MAX_ITEMS, SCAN_RADIUS }
