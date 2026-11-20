'use strict'

const Vec3 = require('vec3')

// shortcut: logs/leaves are no prep cut (build 'clear' digs natural ground only),
// so tree columns only cost a penalty; add a log cut if prod picks wooded sites.
const TREE_COST = 20 // per column
const WATER_COST = 500 // per column: any dry site wins (owner 2026-11-19: bot2 built its farm over water and stalled filling it)
const SOIL = new Set(['grass_block', 'dirt'])
const WET = new Set(['water', 'bubble_column', 'seagrass', 'tall_seagrass', 'kelp', 'kelp_plant'])

// Column survey: gy = the first free y over natural ground, reading through
// flora, leaves, logs (tree) and water (its depth is fill). { bad } = why it
// is unusable: unloaded, built (a player block), lava, deep (no ground in 32).
function column(bot, x, z, topY) {
  const { BUILT_GROUND } = require('./site')
  const { CLEAR_FLORA } = require('./behaviours/util')
  let tree = false
  let water = false
  for (let y = topY; y > topY - 32; y--) {
    let b = null
    try { b = bot.blockAt(new Vec3(x, y, z)) } catch (_) { return { bad: 'unloaded' } }
    if (!b || !b.name) return { bad: 'unloaded' }
    const n = b.name
    if (n === 'air' || n === 'cave_air' || CLEAR_FLORA.has(n)) continue
    if (/(_leaves|_log|_wood)$/.test(n)) { tree = true; continue }
    if (WET.has(n)) { water = true; continue }
    if (n === 'lava') return { bad: 'lava' }
    if (BUILT_GROUND.test(n)) return { bad: 'built' }
    return { gy: y + 1, top: n, tree, water }
  }
  return { bad: 'deep' }
}

// Prep cost of the footprint at (ox, oz) at its cheapest grade y: blocks to
// cut above plus blocks to fill below, a field top that is no soil (swapped
// for dirt: one cut, one fill), tree and water penalties. { bad, x, z } =
// the first unusable column.
function footprintCost(col, ox, oz, { w, d, needsSoil }) {
  const cs = []
  for (let dx = 0; dx < w; dx++) {
    for (let dz = 0; dz < d; dz++) {
      const c = col(ox + dx, oz + dz)
      if (!c || c.bad) return { bad: (c && c.bad) || 'unloaded', x: ox + dx, z: oz + dz }
      cs.push({ dx, dz, ...c })
    }
  }
  let pen = 0
  for (const c of cs) pen += (c.tree ? TREE_COST : 0) + (c.water ? WATER_COST : 0)
  const ys = cs.map((c) => c.gy)
  let best = null
  for (let y = Math.min(...ys); y <= Math.max(...ys); y++) {
    let cut = 0
    let fill = 0
    for (const c of cs) {
      if (c.gy > y) cut += c.gy - y
      else if (c.gy < y) fill += y - c.gy
      else if (needsSoil(c.dx, c.dz) && !SOIL.has(c.top)) { cut++; fill++ }
    }
    if (!best || cut + fill < best.cut + best.fill) best = { y, cut, fill }
  }
  return { ...best, cost: best.cut + best.fill + pen, wet: cs.some((c) => c.water), cs }
}

// Prep cells (plan-relative): cuts top-down (their spoil feeds the fills),
// then fills bottom-up — 'soil' (dirt) under the field so it tills,
// 'ground' (any cheap block) elsewhere. Every field column gets a dy -1
// soil cell unless it already stands on soil: stone or sand is swapped for dirt.
function prepCells(cs, y0, { needsSoil, omitSoil }) {
  const cuts = []
  const fills = []
  for (const c of cs) {
    const g = c.gy - y0
    const field = needsSoil(c.dx, c.dz)
    for (let dy = g - 1; dy >= 0; dy--) cuts.push({ dx: c.dx, dy, dz: c.dz, kind: 'clear', phase: 'prep' })
    for (let dy = Math.min(g, 0); dy <= (field ? -2 : -1); dy++) fills.push({ dx: c.dx, dy, dz: c.dz, kind: field ? 'soil' : 'ground', phase: 'prep' })
    const pit = omitSoil(c.dx, c.dz)
    if (field && !pit && (g !== 0 || !SOIL.has(c.top))) fills.push({ dx: c.dx, dy: -1, dz: c.dz, kind: 'soil', phase: 'prep' })
  }
  cuts.sort((a, b) => b.dy - a.dy)
  fills.sort((a, b) => a.dy - b.dy)
  return [...cuts, ...fills]
}

// Overlap with a box {x0,z0,x1,z1} grown by pad.
function overlaps(ox, oz, box, pad, w, d) {
  return !(ox + w - 1 < box.x0 - pad || ox > box.x1 + pad || oz + d - 1 < box.z0 - pad || oz > box.z1 + pad)
}

const RADIUS = 38
const STEP = 3
// Grade footprints in widening rings around the anchor, excluding avoid boxes. Returns { site: {x,y,z,cost,cut,fill,prep} | null, tried,
// reason, why: {unloaded,built,castle,lava,deep}, walk: {x,z} | null } — walk
// = the nearest unloaded column (qphv: bot5's bridge body read the radius
// unloaded); the caller walks there so the chunk loads, then re-picks.
// skipWalk: chunk keys "cx,cz" the caller could not reach — not walk targets.
const noSoil = () => false
function pickSite(bot, around, {
  w, d, needsSoil = noSoil, omitSoil = noSoil, radius = RADIUS, maxRadius = radius * 3,
  step = STEP, avoid = [], skipWalk = null, accept = null,
}) {
  if (![w, d, radius, maxRadius, step].every((n) => Number.isInteger(n) && n > 0)) {
    throw new TypeError('invalid footprint or search dimensions')
  }
  const footprint = { w, d, needsSoil, omitSoil }
  if (!around || typeof around.x !== 'number' || typeof around.z !== 'number') return { site: null, tried: 0, reason: 'no-anchor' }
  const cy = typeof around.y === 'number' ? Math.floor(around.y) : 64
  const cols = new Map()
  const col = (x, z) => {
    const k = `${x},${z}`
    if (!cols.has(k)) cols.set(k, column(bot, x, z, cy + 8))
    return cols.get(k)
  }
  const bx = Math.floor(around.x - w / 2)
  const bz = Math.floor(around.z - d / 2)
  const why = { unloaded: 0, built: 0, castle: 0, lava: 0, deep: 0 }
  let best = null
  let walk = null
  let tried = 0
  const costAt = (x, z) => {
    const f = footprintCost(col, x, z, footprint)
    return f.bad || !accept || accept(f) ? f : { bad: 'terrain' }
  }
  // exact (an owner's spot): the footprint centred on it first, off the STEP grid
  if (around.exact && !avoid.some((b) => overlaps(bx, bz, b, 3, w, d))) {
    tried++
    const f = costAt(bx, bz)
    if (!f.bad) best = { ox: bx, oz: bz, d: 0, f }
  }
  for (let r = radius, r0 = -1; r <= maxRadius && (!best || (best.f.wet && !around.exact)) && !walk; r0 = r, r += radius) {
    for (let ox = bx - r; ox <= bx + r; ox += step) {
      for (let oz = bz - r; oz <= bz + r; oz += step) {
        const distance = Math.hypot(ox - bx, oz - bz)
        if (distance > r || distance <= r0) continue
        if (avoid.some((b) => overlaps(ox, oz, b, 3, w, d))) { why.castle++; continue }
        tried++
        const f = costAt(ox, oz)
        if (f.bad) {
          why[f.bad] = (why[f.bad] || 0) + 1
          if (f.bad === 'unloaded' && (!walk || distance < walk.d) && !(skipWalk && skipWalk.has(`${f.x >> 4},${f.z >> 4}`))) walk = { x: f.x, z: f.z, d: distance }
        } else if (!best || (around.exact ? distance < best.d : f.cost < best.f.cost || (f.cost === best.f.cost && distance < best.d))) best = { ox, oz, d: distance, f } // exact: nearest valid spot to the owner's
      }
    }
  }
  if (!best) {
    const reason = tried ? Object.keys(why).filter((k) => why[k] && k !== 'castle').join('-') : 'castle-house'
    return { site: null, tried, reason, why, walk: walk && { x: walk.x, z: walk.z } }
  }
  const { f } = best
  return { site: { x: best.ox, y: f.y, z: best.oz, cost: f.cost, cut: f.cut, fill: f.fill, prep: prepCells(f.cs, f.y, footprint) }, tried, why }
}

module.exports = { column, footprintCost, pickSite, prepCells }
