'use strict'

const Vec3 = require('vec3')

// Farm blueprint (idkcraft-qphv.1): a house-style plan (behaviours/build.js
// cells {dx,dy,dz,kind}, LAY ORDER) laid by the house builder on a
// home of kind 'farm'. One 27x9 strip, origin = SW corner at ground level:
//   x 0..6   barn: 7x6, walls 2 high, flat roof, door (3,0,0), chest inside
//            at (5,0,4); the free interior holds hay bales later;
//   x 8..16  pen: 9x9 fence ring at ground level, gate at (12,0,0) (.3 keeps animals);
//   x 18..26 field: 9x9 farmland at dy -1 around one water cell (22,-1,4).
// 'clear' cells dig natural ground (bumps, the water pit) and are no work in
// the progress count; 'farmland' is tilled with a hoe, 'water' poured from a bucket.
// Site (qphv: prod bot5 failed no-site 49 times on a flat-only rule): the
// cheapest footprint within RADIUS, graded by prep cells (castle prep
// pattern: cut above grade, fill below) laid before the barn.

const { PLAN, W, D, DOOR, GATE, WATER, BARN, PEN, FIELD, inField, protects, inFieldAt } = require('./farm-plan')

// shortcut: logs/leaves are no prep cut (build 'clear' digs natural ground only),
// so tree columns only cost a penalty; add a log cut if prod picks wooded sites.
const TREE_COST = 20 // per column
const WATER_COST = 10 // per column, on top of the fill down to the bed
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
function footprintCost(col, ox, oz) {
  const cs = []
  for (let dx = 0; dx < W; dx++) {
    for (let dz = 0; dz < D; dz++) {
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
      else if (inField(c.dx, c.dz) && !SOIL.has(c.top)) { cut++; fill++ }
    }
    if (!best || cut + fill < best.cut + best.fill) best = { y, cut, fill }
  }
  return { ...best, cost: best.cut + best.fill + pen, cs }
}

// Prep cells (plan-relative): cuts top-down (their spoil feeds the fills),
// then fills bottom-up — 'soil' (dirt) under the field so it tills,
// 'ground' (any cheap block) elsewhere. Every field column gets a dy -1
// soil cell unless it already stands on soil: stone or sand is swapped for dirt.
function prepCells(cs, y0) {
  const cuts = []
  const fills = []
  for (const c of cs) {
    const g = c.gy - y0
    const field = inField(c.dx, c.dz)
    for (let dy = g - 1; dy >= 0; dy--) cuts.push({ dx: c.dx, dy, dz: c.dz, kind: 'clear', phase: 'prep' })
    for (let dy = Math.min(g, 0); dy <= (field ? -2 : -1); dy++) fills.push({ dx: c.dx, dy, dz: c.dz, kind: field ? 'soil' : 'ground', phase: 'prep' })
    const pit = c.dx === WATER.dx && c.dz === WATER.dz // the plan digs it for the water
    if (field && !pit && (g !== 0 || !SOIL.has(c.top))) fills.push({ dx: c.dx, dy: -1, dz: c.dz, kind: 'soil', phase: 'prep' })
  }
  cuts.sort((a, b) => b.dy - a.dy)
  fills.sort((a, b) => a.dy - b.dy)
  return [...cuts, ...fills]
}

// Overlap with a box {x0,z0,x1,z1} grown by pad.
function overlaps(ox, oz, box, pad) {
  return !(ox + W - 1 < box.x0 - pad || ox > box.x1 + pad || oz + D - 1 < box.z0 - pad || oz > box.z1 + pad)
}

const RADIUS = 38
const MAX_RADIUS = RADIUS * 3
const STEP = 3
// Cheapest site within RADIUS of `around` (ties: nearer), clear of the
// `avoid` boxes; nothing on loaded ground fits -> the ring widens by RADIUS
// up to MAX_RADIUS. Returns { site: {x,y,z,cost,cut,fill,prep} | null, tried,
// reason, why: {unloaded,built,castle,lava,deep}, walk: {x,z} | null } — walk
// = the nearest unloaded column (qphv: bot5's bridge body read the radius
// unloaded); the caller walks there so the chunk loads, then re-picks.
function pickSite(bot, around, avoid = []) {
  if (!around || typeof around.x !== 'number' || typeof around.z !== 'number') return { site: null, tried: 0, reason: 'no-anchor' }
  const cy = typeof around.y === 'number' ? Math.floor(around.y) : 64
  const cols = new Map()
  const col = (x, z) => {
    const k = `${x},${z}`
    if (!cols.has(k)) cols.set(k, column(bot, x, z, cy + 8))
    return cols.get(k)
  }
  const bx = Math.floor(around.x - W / 2)
  const bz = Math.floor(around.z - D / 2)
  const why = { unloaded: 0, built: 0, castle: 0, lava: 0, deep: 0 }
  let best = null
  let walk = null
  let tried = 0
  for (let r = RADIUS, r0 = -1; r <= MAX_RADIUS && !best && !walk; r0 = r, r += RADIUS) {
    for (let ox = bx - r; ox <= bx + r; ox += STEP) {
      for (let oz = bz - r; oz <= bz + r; oz += STEP) {
        const d = Math.hypot(ox - bx, oz - bz)
        if (d > r || d <= r0) continue
        if (avoid.some((b) => overlaps(ox, oz, b, 3))) { why.castle++; continue }
        tried++
        const f = footprintCost(col, ox, oz)
        if (f.bad) {
          why[f.bad]++
          if (f.bad === 'unloaded' && (!walk || d < walk.d)) walk = { x: f.x, z: f.z, d }
        } else if (!best || f.cost < best.f.cost || (f.cost === best.f.cost && d < best.d)) best = { ox, oz, d, f }
      }
    }
  }
  if (!best) {
    const reason = tried ? Object.keys(why).filter((k) => why[k] && k !== 'castle').join('-') : 'castle-house'
    return { site: null, tried, reason, why, walk: walk && { x: walk.x, z: walk.z } }
  }
  const { f } = best
  return { site: { x: best.ox, y: f.y, z: best.oz, cost: f.cost, cut: f.cut, fill: f.fill, prep: prepCells(f.cs, f.y) }, tried, why }
}

function siteFor(bot, around, avoid) { return pickSite(bot, around, avoid).site }

// The farm's plan on its site: prep cells first, then the static PLAN.
const PLANS = new WeakMap()
function planFor(fb) {
  const prep = fb && fb.site && fb.site.prep
  if (!Array.isArray(prep) || !prep.length) return PLAN
  if (!PLANS.has(prep)) PLANS.set(prep, [...prep, ...PLAN])
  return PLANS.get(prep)
}

module.exports = { protects, inFieldAt, PLAN, W, D, DOOR, GATE, WATER, BARN, PEN, FIELD, siteFor, pickSite, planFor, footprintCost }
