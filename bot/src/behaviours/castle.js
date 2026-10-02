'use strict'

// castle: lay the castle blueprint (src/castle.js) cell by cell
// (idkcraft-g0z.2, design revision 2026-10-02).
//
// Input: ctx.castle = { site:{x,y,z}, rot, phase?, blocked? } — set by the
// order (g0z.3); tests set it directly. Progress is read from the WORLD in
// plan order (like build.js nextCellIdx), so only the site, rotation and
// the blocked map persist and a restart resumes for free.
//
// One tick = at most one async flight (ctx.placeInFlight / ctx.digInFlight,
// the seams build/flat/beds share). Castle-only executor: build.js keeps
// its own skip/refusal semantics; we reuse only its pure geometry
// (findRef, isReplaceable, PLACE_RANGE/PLACE_REACH, the cell budgets).
//
// No permanent skips: a cell that refuses three times (or blows its tick
// budget, or hangs a flight) is BLOCKED with bounded exponential backoff
// in ctx.castle.blocked["<blueprintVersion>:<idx>"] = {tries, until}, and
// a blocked structural cell stops progress above its layer — it is
// reported, never built past. Planned air/dig cells are enforced only
// before phase 'complete': afterwards the bot never clears what the owner
// puts inside. Laid castle blocks are protected for every executor
// (util.protectedReason + guardCastle below).

const Vec3 = require('vec3')
const { goals } = require('mineflayer-pathfinder')
const blueprint = require('../castle')
const build = require('./build')
const flat = require('./flat')
const { denyReason, logDeny, NATURAL_SOLID, castleProtects } = require('./util')

const STRIKES = 3
const BACKOFF_BASE_MS = 30000
const BACKOFF_MAX_MS = 600000
// ponytail: the scan resumes from a cursor (the first undone cell); a full
// rescan from 0 every 30 s repairs cells mobs/players broke below it.
const FULL_RESCAN_MS = 30000
const DIG_APPROACH = 2 // GoalNear range: stops inside REACH_DIG (flat round-2 lesson)
const SIDESTEPS = [[1, 0], [0, 1], [-1, 0], [0, -1]]
const AIR = new Set(['air', 'cave_air', 'void_air'])

const ITEM = {
  stone: (n) => n === 'cobblestone' || n === 'stone',
  planks: (n) => n.endsWith('_planks'),
  door: (n) => n.endsWith('_door') && n !== 'iron_door', // iron needs redstone
  torch: (n) => n === 'torch',
  fence: (n) => n.endsWith('_fence') && n !== 'nether_brick_fence', // g0z.4 sourcing; g0z.11 plans it
  frame: (n) => n.endsWith('_log'), // v2 Fachwerk beams (castle.matches)
  chest: (n) => n === 'chest', // v2 storeroom chest
}

// Project-material reservation (g0z.3 design): the castle never lays the
// bot's scaffold/tool stone (equip's SCAFFOLD_LOW mark — below it equip
// would dig the same blocks back) nor the last planks a stick craft needs.
// Deferred require: equip loads inside the craft->goal chain.
function reserveOf(kind) {
  if (kind === 'stone') {
    try { return require('./equip').SCAFFOLD_LOW } catch (_) { return 16 }
  }
  return kind === 'planks' ? 2 : 0
}

// Items of the kind above the reserve (what the castle may spend).
function held(bot, kind) {
  const want = ITEM[kind]
  if (!want) return 0
  let n = 0
  try {
    for (const it of bot.inventory.items() || []) {
      if (it && typeof it.name === 'string' && want(it.name)) n += typeof it.count === 'number' ? it.count : 1
    }
  } catch (_) { /* no inventory: none */ }
  return n
}
function usable(bot, kind) {
  return Math.max(0, held(bot, kind) - reserveOf(kind))
}

// Birch first (g0z.4: the Fachwerk infill prefers light wood), else any.
function findItem(bot, kind) {
  const want = ITEM[kind]
  if (!want || usable(bot, kind) <= 0) return null
  let any = null
  try {
    for (const it of bot.inventory.items() || []) {
      if (!it || typeof it.name !== 'string' || !want(it.name)) continue
      if (it.name.startsWith('birch_')) return it
      any = any || it
    }
  } catch (_) { /* no inventory: no item */ }
  return any
}

// Prep fill (g0z.16): castle stone above the reserve, else dirt (the cut
// spoil of a grass hill).
function fillItem(bot) {
  const s = findItem(bot, 'stone')
  if (s) return s
  try { return (bot.inventory.items() || []).find((it) => it && it.name === 'dirt') || null } catch (_) { return null }
}

function nameAt(bot, c) {
  try {
    const b = bot.blockAt(new Vec3(c.x, c.y, c.z))
    return b && typeof b.name === 'string' ? b.name : null
  } catch (_) { return null }
}

// Entrance apron stance (blueprint ENTRANCE) in world coords for the site.
function entrance(st) {
  const bp = blueprint.blueprintOf(st.blueprintVersion)
  const e = blueprint.rotatePlan([{ ...bp.ENTRANCE, kind: 'air' }], st.rot | 0, bp.version)[0]
  return { x: st.site.x + e.dx, y: st.site.y + e.dy, z: st.site.z + e.dz }
}

function done(bot, c) {
  if (c.prep) return prepDone(bot, c)
  return blueprint.matches(c.kind, nameAt(bot, c))
}
function clearing(c) { return !blueprint.isPlaceTarget(c.kind) }
function ver(st) { return blueprint.blueprintOf(st && st.blueprintVersion).version }
function bkey(st, idx) { return `${ver(st)}:${idx}` }
function backoffMs(tries) { return Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** (tries - 1)) }

function bodyPos(bot) {
  const p = bot.entity && bot.entity.position
  return p && typeof p.x === 'number' ? p : null
}

function blockCell(ctx, st, c, why, now) {
  const k = bkey(st, c.idx)
  const e = st.blocked[k] || { tries: 0, until: 0 }
  e.tries++
  e.until = now + backoffMs(e.tries)
  e.why = String(why)
  st.blocked[k] = e
  ctx.castleFails = null
  ctx.castleCell = null
  ctx.castleFar = null
  ctx.castleGoalIdx = -1
  console.log(`castle blocked ${c.x} ${c.y} ${c.z} ${c.kind} (${why}) try ${e.tries}, retry in ${Math.round(backoffMs(e.tries) / 1000)}s`)
}

function strike(ctx, st, c, why, now) {
  const f = ctx.castleFails && ctx.castleFails.idx === c.idx ? ctx.castleFails : { idx: c.idx, n: 0 }
  f.n++
  ctx.castleFails = f
  if (f.n >= STRIKES) blockCell(ctx, st, c, why, now)
}

// Work order = plan order with the door deferred past every other place
// cell (revmux 01): A* never opens doors (canOpenDoors=false) and the laid
// door is break-vetoed, so the doorway stays an open passage while the bot
// still needs the interior. Then the keep-clear cells, the moat digs (v2,
// g0z.6: the bridge deck is an ordinary place cell, so it exists before
// any dig) and the fence ring last. Indices stay plan indices (blocked keys).
// Torches (g0z.17) go after every other place cell, before the door: no
// cell leans on a torch, and a torch-none word (no coal for the craft)
// must never hold the stone and planks behind it.
const RANK = { torch: 0.5, door: 1, air: 2, dig: 3, fence: 4 }
function rank(c) { return RANK[c.kind] || 0 }
// Interior work (g0z.6): an undone cell ranked before the moat. While one
// is left — blocked, gated or not — no moat cell is dug, so the bot never
// has to cross a dug moat to finish the castle; later repairs cross the
// bridge, which is laid before any dig.
function interior(c) { return rank(c) < RANK.dig }
let orderCache = null
function workOrder(cells, key) {
  if (orderCache && orderCache.key === key) return orderCache.order
  const order = cells.map((c) => c.idx).sort((a, b) => rank(cells[a]) - rank(cells[b]) || a - b)
  orderCache = { key, order }
  return order
}

// Torchless (g0z.17): with no torch on hand a torch cell steps aside —
// the moat and fence go on — and the door waits with it (A* never opens
// it, the torches still need the way in). Neither counts as interior work.
// Only when nothing else is workable does the torch cell come back, so the
// word reads torch-none and castlefetch retries.
function torchOwed(bot, c, owed) {
  if (c.kind === 'torch') return usable(bot, 'torch') <= 0
  return c.kind === 'door' && !!owed
}

// Next cell to work in work order, or why there is none.
function pick(bot, ctx, st, cells, key, now) {
  const order = workOrder(cells, key)
  const complete = st.phase === 'complete'
  // Structural gate: an actively blocked place cell stops everything above
  // its layer. Done or stale-version entries drop here.
  let gateDy = Infinity
  for (const k of Object.keys(st.blocked)) {
    const [v, i] = k.split(':')
    const c = cells[Number(i)]
    // Off-plan entries (prep, litter) live until they expire (g0z.14).
    if (Number(v) !== ver(st) || (c ? done(bot, c) : st.blocked[k].until <= now)) { delete st.blocked[k]; continue }
    if (c && st.blocked[k].until > now && !clearing(c)) gateDy = Math.min(gateDy, c.dy)
  }
  let full = ctx.castleScanKey !== key || now - (ctx.castleScanAt || 0) >= FULL_RESCAN_MS
  for (;;) {
    if (full) { ctx.castleScanKey = key; ctx.castleScanAt = now }
    let first = -1
    let waiting = null
    let inside = false
    let owed = null
    for (let i = full ? 0 : (ctx.castleCursor | 0); i < order.length; i++) {
      const c = cells[order[i]]
      if (clearing(c) && complete) continue
      if (done(bot, c)) continue
      if (first < 0) first = i
      if (torchOwed(bot, c, owed)) { owed = owed || c; continue }
      if (c.kind === 'dig' && inside) { waiting = waiting || c; continue }
      if (interior(c)) inside = true
      const b = st.blocked[bkey(st, c.idx)]
      if (b && b.until > now) { waiting = waiting || c; continue }
      if (!clearing(c) && c.dy > gateDy) { waiting = waiting || c; break }
      ctx.castleCursor = first
      return { idx: c.idx }
    }
    ctx.castleCursor = first < 0 ? order.length : first
    if (first < 0 && !full) { full = true; continue } // confirm "all done" from 0
    if (owed) return { idx: owed.idx }
    return { idx: -1, waiting }
  }
}

// Read-only twin of pick() for the work arbiter (g0z.3): the next cell the
// executor would work now, or why there is none — same work order, layer
// gate and backoff, no cursor/scan/blocked-map writes. Full scan from 0.
// ponytail: O(plan) blockAt per decide; cache per tick if g0z.11's ~2000
// cells ever show in the tick timer.
function peek(bot, st, now, ctx) {
  if (st.phase === 'prep') {
    const list = prepTargets(bot, ctx, st, now)
    const bl = st.blocked || {}
    return { cell: list.find((c) => !done(bot, c) && !(bl[bkey(st, c.idx)] && bl[bkey(st, c.idx)].until > now)) || null, waiting: null, cells: list }
  }
  const { cells, key } = blueprint.absPlan(st.site, st.rot, st.blueprintVersion)
  const blocked = st.blocked && typeof st.blocked === 'object' ? st.blocked : {}
  const complete = st.phase === 'complete'
  let gateDy = Infinity
  for (const k of Object.keys(blocked)) {
    const [v, i] = k.split(':')
    const c = cells[Number(i)]
    if (Number(v) !== ver(st) || !c || !blocked[k] || done(bot, c)) continue
    if (blocked[k].until > now && !clearing(c)) gateDy = Math.min(gateDy, c.dy)
  }
  let waiting = null
  let inside = false
  let owed = null
  for (const idx of workOrder(cells, key)) {
    const c = cells[idx]
    if (clearing(c) && complete) continue
    if (done(bot, c)) continue
    if (torchOwed(bot, c, owed)) { owed = owed || c; continue }
    if (c.kind === 'dig' && inside) { waiting = waiting || c; continue }
    if (interior(c)) inside = true
    const b = blocked[bkey(st, c.idx)]
    if (b && b.until > now) { waiting = waiting || c; continue }
    if (!clearing(c) && c.dy > gateDy) return { cell: null, waiting: waiting || c, cells }
    return { cell: c, waiting: null, cells }
  }
  return { cell: owed, waiting: owed ? null : waiting, cells }
}

// Site prep (g0z.5, phase 'prep'): the order-time check (siteCheck) vouches
// for the ground; before the plan starts the castle chops trees standing in
// the footprint volume, then levels the footprint to site.y-1 (g0z.16):
// cuts every solid block at or above site.y (top-down, spoil kept as castle
// material) and fills holes up to site.y-1 (bottom-up, stone, else dirt).
// Plan cells below site.y (the moat) are the plan's, never filled; a block
// that already matches its plan cell stays. Best effort: a target that
// refuses is blocked like any cell and the body phase starts without it —
// the body executor still clears what its own cells hit.
const MAX_DIP = 2 // ground may sit this far off site.y-1 (owner 2026-10-02)
const SCAN_DOWN = 8 // holes are read this deep for the refusal's worst offset
// Built things: someone's house, not terrain (the site check refuses them).
const FOREIGN = /(planks|_door$|_bed$|fence|glass|crafting_table|chest|furnace|brick|wool|stairs|_slab$|_sign$|barrel|ladder|torch|(?<!moss_)carpet|concrete|bookshelf|_wall$)/

function isLogName(n) { return typeof n === 'string' && (n.endsWith('_log') || n.endsWith('_stem')) && !n.startsWith('stripped_') }
function isTreeBlock(n) { return isLogName(n) || (typeof n === 'string' && n.endsWith('_leaves')) }
// Pass-through for the ground scan: air, flora, trees (leaves stay, logs chop).
function passes(n) { return AIR.has(n) || build.isReplaceable(n) || isTreeBlock(n) }

// Top-down column read over the site volume: first ground block, or what
// disqualifies the column. Unloaded reads are 'unknown' (never a refusal).
function scanColumn(bot, x, z, sy) {
  const logs = []
  for (let y = sy + SITE_TOP; y >= sy - 1 - SCAN_DOWN; y--) {
    const name = nameAt(bot, { x, y, z })
    if (name == null) return { unknown: true }
    if (FOREIGN.test(name)) return { foreign: name, y }
    if (flat.isLiquidName(name)) return { liquid: name, y }
    // Collision-free blocks (any flora, double-tall flowers included) are
    // not ground; mineflayer reads water as empty too, hence liquid first.
    let soft = false
    try { soft = bot.blockAt(new Vec3(x, y, z)).boundingBox === 'empty' } catch (_) { soft = false }
    if (passes(name) || soft) {
      if (isLogName(name)) logs.unshift(y)
      continue
    }
    return { top: y, logs }
  }
  return { top: sy - 2 - SCAN_DOWN, logs }
}

// Order-time check: null when the footprint is acceptable, else the reason.
// Water/lava/foreign builds refuse at the first one; uneven ground counts
// every column past MAX_DIP and names the worst offset (g0z.16).
function siteCheck(bot, site, rot, version) {
  const { w, d } = blueprint.siteDimensions(rot | 0, version)
  let n = 0
  let worst = null
  for (let dx = 0; dx < w; dx++) {
    for (let dz = 0; dz < d; dz++) {
      const x = site.x + dx
      const z = site.z + dz
      const r = scanColumn(bot, x, z, site.y)
      if (r.unknown) continue
      if (r.liquid) return `there is ${r.liquid} at ${x} ${r.y} ${z}`
      if (r.foreign) return `somebody built there (${r.foreign} at ${x} ${r.y} ${z})`
      const off = r.top - (site.y - 1)
      if (Math.abs(off) <= MAX_DIP) continue
      n++
      if (!worst || Math.abs(off) > Math.abs(worst.off)) worst = { off, x, z }
    }
  }
  if (!n) return null
  const by = worst.off <= -(1 + SCAN_DOWN) ? `${1 + SCAN_DOWN}+` : String(Math.abs(worst.off)) // the scan floor
  return `the ground is too uneven: ${n} spots are more than ${MAX_DIP} blocks off level, worst ${by} ${worst.off > 0 ? 'up' : 'down'} at ${worst.x} ${worst.z} (I level up to ${MAX_DIP})`
}

function prepDone(bot, c) {
  const n = nameAt(bot, c)
  if (c.prep === 'log') return !isLogName(n)
  if (c.prep === 'cut') return n != null && (AIR.has(n) || build.isReplaceable(n))
  return n != null && !AIR.has(n) && !build.isReplaceable(n) && !flat.isLiquidName(n)
}

// Undone prep targets: logs bottom-up, cuts top-down (their spoil feeds the
// fills), then fills bottom-up; cached 30 s on ctx (a full-volume scan per
// decide is too much once the site grows).
// ponytail: full site volume; a tall tree's upper logs sit out of reach and
// block after three strikes — add a pillar-free skip if prod shows churn.
function prepTargets(bot, ctx, st, now) {
  const key = `${st.site.x},${st.site.y},${st.site.z},${st.rot | 0}`
  const c0 = ctx && ctx.castlePrep
  if (c0 && c0.key === key && now - c0.at < FULL_RESCAN_MS && !c0.unknown) {
    const live = c0.list.filter((c) => !done(bot, c))
    if (live.length || c0.list.length === 0) return live // a list that filtered to empty is rescanned once
  }
  const { w, d } = blueprint.siteDimensions(st.rot | 0, st.blueprintVersion)
  const { x: sx, y: sy, z: sz } = st.site
  const idx = (x, y, z) => 1000000 + ((x - sx) * d + (z - sz)) * 40 + (y - sy + 4)
  const at = blueprint.absPlan(st.site, st.rot, st.blueprintVersion).at
  const logs = []
  const cuts = []
  const fills = []
  let unknown = 0
  for (let dx = 0; dx < w; dx++) {
    for (let dz = 0; dz < d; dz++) {
      const x = sx + dx
      const z = sz + dz
      const r = scanColumn(bot, x, z, sy)
      if (r.unknown) unknown++
      if (r.unknown || r.liquid || r.foreign) continue
      for (const y of r.logs) logs.push({ x, y, z, kind: 'air', prep: 'log', idx: idx(x, y, z) })
      // Past ±MAX_DIP the order refused it: a later change is not ours to level.
      if (Math.abs(r.top - (sy - 1)) > MAX_DIP) continue
      for (let y = r.top; y >= sy; y--) {
        const c = { x, y, z, kind: 'air', prep: 'cut', idx: idx(x, y, z) }
        const p = at.get(`${x},${y},${z}`)
        if (prepDone(bot, c) || (p && blueprint.matches(p.kind, nameAt(bot, c)))) continue
        cuts.push(c)
      }
      for (let y = r.top + 1; y <= sy - 1; y++) {
        if (!at.has(`${x},${y},${z}`)) fills.push({ x, y, z, kind: 'stone', prep: 'fill', idx: idx(x, y, z) })
      }
    }
  }
  const list = logs.sort((a, b) => a.y - b.y)
    .concat(cuts.sort((a, b) => b.y - a.y), fills.sort((a, b) => a.y - b.y))
  // unknown (g0z.15): unloaded columns — no cache, and prep stays open.
  if (ctx) ctx.castlePrep = { key, at: now, list, unknown }
  return list
}

// Own litter (g0z.14): before 'complete', every off-plan block in the site
// box (dy 0..SITE_TOP) that is our scaffold — cobblestone by name (digCell's
// restart rule) or a placedByBot ground block — clears like a keep-clear
// cell, bottom-up. Best effort like prep: a refusing one blocks and the
// castle completes without it. Cached 30 s (a full-box scan).
// ponytail: a pillar top out of reach blocks after three strikes; the reach
// invariant keeps tall pillars off the site.
function litterTargets(bot, ctx, st, now) {
  const key = `${st.site.x},${st.site.y},${st.site.z},${st.rot | 0}`
  const c0 = ctx.castleLitter
  if (c0 && c0.key === key && now - c0.at < FULL_RESCAN_MS) return c0.list.filter((c) => !done(bot, c))
  const { w, d } = blueprint.siteDimensions(st.rot | 0, st.blueprintVersion)
  const at = blueprint.absPlan(st.site, st.rot, st.blueprintVersion).at
  const placed = ctx.placedByBot instanceof Set ? ctx.placedByBot : new Set()
  const list = []
  for (let dy = 0; dy <= SITE_TOP; dy++) {
    for (let dx = 0; dx < w; dx++) {
      for (let dz = 0; dz < d; dz++) {
        const x = st.site.x + dx
        const y = st.site.y + dy
        const z = st.site.z + dz
        const k = `${x},${y},${z}`
        if (at.has(k)) continue
        const n = nameAt(bot, { x, y, z })
        if (n === 'cobblestone' || (placed.has(k) && NATURAL_SOLID.has(n))) {
          list.push({ x, y, z, kind: 'air', dy, idx: 2000000 + (dx * d + dz) * 40 + dy })
        }
      }
    }
  }
  ctx.castleLitter = { key, at: now, list }
  return list
}

// Batch gate (build precedent): a castle leg starts with BATCH of the next
// kind on hand, or the whole remainder of that kind when less is left.
const BATCH = 16
// Per-kind batch (g0z.12): frame logs come from gather, which stops at
// goal.NEED_LOGS (14) — a 16 batch would read frame-some forever with the
// fetch already at its target. A test pins it to NEED_LOGS.
const BATCH_OF = { frame: 14 }
function batchOf(kind) { return BATCH_OF[kind] || BATCH }

// The castle word for the goal facts text (g0z.3): 'none' | 'parked' |
// 'done' | 'finish' | 'blocked' | 'clear' (next cell is a keep-clear dig, no
// material) | '<kind>-<none|some|batch>' (the next cell's material on
// hand, above the reserve). Restock, stop/go, completion and a demand-kind
// change all move the word, so holds keyed on the text release on them.
function stockWord(bot, kind, left) {
  const have = usable(bot, kind)
  if (have <= 0) return `${kind}-none`
  return have >= Math.min(batchOf(kind), left) ? `${kind}-batch` : `${kind}-some`
}

// 'finish' (revmux 01): every cell matches but the executor has not yet
// run its completion branch (phase, chat, keep-clear release) — one more
// castle tick does that, then the word reads 'done'.
// Unloaded site (revmux 01): null blocks read as undone, so a fresh peek
// would call a far complete castle unfinished and yank the bot back. Far
// away the word is the last one read on site (stock re-read for a material
// word); a complete castle reads done; never seen this session -> the
// first plan cell's kind (walk back and build).
function menuFact(bot, ctx, now = Date.now()) {
  const st = ctx && ctx.castle
  if (!st || !st.site || typeof st.site.x !== 'number') return 'none'
  if (st.parked) return 'parked'
  try {
    // Loaded = all four footprint corners read (revmux 02): the v1 site
    // spans at most 2x2 chunks; the v2 site (31x27) up to 3x3, whose middle
    // chunks lie inside the corners' hull — the loaded area is convex.
    let loaded = false
    try {
      const { w, d } = blueprint.siteDimensions(st.rot | 0, st.blueprintVersion)
      loaded = [[0, 0], [w - 1, 0], [0, d - 1], [w - 1, d - 1]].every(([dx, dz]) => !!bot.blockAt(new Vec3(st.site.x + dx, st.site.y, st.site.z + dz)))
    } catch (_) { loaded = false }
    if (!loaded) {
      if (st.phase === 'complete') return 'done'
      const last = ctx.castleWord
      if (last && last.kind) return stockWord(bot, last.kind, last.left)
      if (last && last.word) return last.word
      const { cells, key } = blueprint.absPlan(st.site, st.rot, st.blueprintVersion)
      return stockWord(bot, cells[workOrder(cells, key)[0]].kind, BATCH)
    }
    let r = peek(bot, st, now, ctx)
    // Prep with nothing left to prep (g0z.15): the next castle tick starts
    // the body, so the word is the body's — never 'finish' at 0/240.
    if (st.phase === 'prep' && !r.cell && !r.waiting) r = peek(bot, { ...st, phase: 'body' }, now, ctx)
    let word = null
    if (!r.cell) word = r.waiting ? 'blocked' : st.phase === 'complete' ? 'done' : 'finish'
    // A prep fill takes any filler on hand, no batch (g0z.16): works now.
    else if (clearing(r.cell) || (r.cell.prep === 'fill' && fillItem(bot))) word = 'clear'
    if (word) {
      ctx.castleWord = { word }
      return word
    }
    const kind = r.cell.kind
    let left = 0
    if (kind === 'planks') {
      // Infill run (g0z.15): planks up to the next Fachwerk beam only, so
      // the planks fetch never crafts the held frame logs away.
      const { cells, key } = blueprint.absPlan(st.site, st.rot, st.blueprintVersion)
      const order = workOrder(cells, key)
      for (let i = order.indexOf(r.cell.idx); i >= 0 && i < order.length; i++) {
        const o = cells[order[i]]
        if (done(bot, o)) continue
        if (o.kind === 'frame') break
        if (o.kind === kind) left++
      }
    } else {
      for (const o of r.cells) {
        if (o.kind === kind && !done(bot, o)) left++
      }
    }
    ctx.castleWord = { kind, left }
    return stockWord(bot, kind, left)
  } catch (_) {
    return 'none'
  }
}

// Owner-facing progress (chat 'castle'): laid/total per material kind,
// read live from the world (blocked never counts as done).
function progressByKind(bot, st) {
  const out = {}
  for (const c of blueprint.absPlan(st.site, st.rot, st.blueprintVersion).cells) {
    if (clearing(c)) continue
    const e = out[c.kind] || (out[c.kind] = { done: 0, total: 0 })
    e.total++
    if (done(bot, c)) e.done++
  }
  return out
}

function progress(bot, st, cells, ctx) {
  let n = 0
  let total = 0
  for (const c of cells) {
    if (clearing(c)) continue
    total++
    if (done(bot, c)) n++
  }
  st.progress = { done: n, total }
  if (ctx.castleProgressLog !== n) {
    ctx.castleProgressLog = n
    console.log(`castle ${n}/${total}`)
  }
}

// Per-cell budget (build ipn.10 lesson): ticks on one cell without
// displacement past CELL_PROGRESS, or the hard cap, block it.
function overBudget(bot, ctx, idx) {
  const bp = bodyPos(bot)
  const cc = ctx.castleCell
  if (!cc || cc.idx !== idx) {
    ctx.castleCell = { idx, ticks: 0, stall: 0, anchor: bp ? { x: bp.x, y: bp.y, z: bp.z } : null }
    return null
  }
  cc.ticks++
  const a = cc.anchor
  if (bp && a && Math.hypot(bp.x - a.x, bp.y - a.y, bp.z - a.z) > build.CELL_PROGRESS) {
    cc.stall = 0
    cc.anchor = { x: bp.x, y: bp.y, z: bp.z }
  } else cc.stall++
  if (cc.ticks >= build.CELL_HARD_CAP) return 'cell-hard-cap'
  if (cc.stall >= build.CELL_TICK_BUDGET) return 'cell-budget'
  return null
}

// Self-occupancy (flat SELF_OCC_LIMIT): standing in our own target steps
// aside; a body that cannot get out blocks the cell instead of orbiting.
function sidestep(bot, ctx, st, c, now, why = 'occupied') {
  const so = ctx.castleSelfOcc && ctx.castleSelfOcc.idx === c.idx ? ctx.castleSelfOcc : { idx: c.idx, n: 0 }
  so.n++
  ctx.castleSelfOcc = so
  if (so.n > flat.SELF_OCC_LIMIT) { blockCell(ctx, st, c, why, now); return }
  const bp = bodyPos(bot)
  const s = SIDESTEPS[so.n % SIDESTEPS.length]
  // GoalBlock, not GoalNear(.., 1): a range-1 goal one step away is already
  // satisfied where we stand, so the pathfinder never moves (rig).
  try {
    if (bp) {
      ctx.castleGoal = new goals.GoalBlock(Math.floor(bp.x) + s[0], Math.floor(bp.y), Math.floor(bp.z) + s[1])
      bot.pathfinder.setGoal(ctx.castleGoal)
    }
  } catch (_) { /* retry next tick */ }
}

// Out of reach after the approach ended: re-approach; only a stand that
// stops getting closer counts, on its own streak that proven reach resets
// (build buildFarFails: long walks cross idle ticks between A* segments,
// and preemptions with returns in between must never add up).
function far(bot, ctx, st, c, reach, now) {
  const bp = bodyPos(bot)
  if (!bp) return false
  const dist = Math.hypot(bp.x - (c.x + 0.5), (bp.y + 1.6) - (c.y + 0.5), bp.z - (c.z + 0.5))
  if (dist <= reach) {
    if (ctx.castleFar && ctx.castleFar.idx === c.idx) ctx.castleFar.n = 0
    return false
  }
  const f = ctx.castleFar && ctx.castleFar.idx === c.idx ? ctx.castleFar : { idx: c.idx, dist: Infinity, n: 0 }
  if (dist < f.dist - build.CELL_PROGRESS) f.n = 0
  else f.n++
  f.dist = dist
  ctx.castleFar = f
  ctx.castleGoalIdx = -1
  if (f.n >= STRIKES) blockCell(ctx, st, c, 'unreachable', now)
  return true
}

// (Re)issue the approach for this cell: a new cell, or a borrower (fight,
// lead, a reflex) replaced our goal while the cell stayed the same.
function approach(bot, ctx, c, make) {
  let foreign = false
  try { foreign = bot.pathfinder.goal != null && bot.pathfinder.goal !== ctx.castleGoal } catch (_) { foreign = false }
  if (ctx.castleGoalIdx === c.idx && !foreign) return false
  ctx.castleGoalIdx = c.idx
  try {
    ctx.castleGoal = make()
    bot.pathfinder.setGoal(ctx.castleGoal)
  } catch (_) { /* retry next tick */ }
  return true
}

function flight(ctx, kind, c, run) {
  const token = {}
  ctx[kind] = true
  ctx.castleFlight = { token, kind, idx: c.idx, cell: c, since: Date.now() }
  ;(async () => {
    try { await run(token) } finally {
      if (ctx.castleFlight && ctx.castleFlight.token === token) {
        ctx[kind] = false
        ctx.castleFlight = null
      }
    }
  })().catch(() => { /* settled in finally */ })
}

function live(ctx, token) { return ctx.castleFlight && ctx.castleFlight.token === token }

function placeCell(bot, ctx, st, c, item, now) {
  const p = new Vec3(c.x, c.y, c.z)
  // The door is placed from the entrance apron, so the bot ends OUTSIDE
  // the closed tower instead of sealing itself in.
  const ent = c.kind === 'door' ? entrance(st) : null
  if (approach(bot, ctx, c, () => ent
    ? new goals.GoalBlock(ent.x, ent.y, ent.z)
    : new goals.GoalPlaceBlock(p, bot.world, { range: build.PLACE_RANGE }))) return
  let moving = false
  try { moving = bot.pathfinder.isMoving() } catch (_) { /* treat as arrived */ }
  if (moving) return
  if (ent) {
    // Door only from the apron itself (revmux 02): reach alone would let a
    // body inside the ground floor close the tower on itself. y rounds, not
    // floors: on a soul sand/mud/path apron the feet sit ~0.1 low (revmux 03).
    const bp = bodyPos(bot)
    if (!bp || Math.floor(bp.x) !== ent.x || Math.floor(bp.z) !== ent.z || Math.round(bp.y) !== ent.y) {
      ctx.castleGoalIdx = -1
      strike(ctx, st, c, 'off-apron', now)
      return
    }
  }
  if (flat.cellOccupiedSelf(bot, c.x, c.y, c.z)) { sidestep(bot, ctx, st, c, now); return }
  if (flat.cellOccupiedByPlayer(bot, c.x, c.y, c.z)) { strike(ctx, st, c, 'occupied', now); return }
  if (far(bot, ctx, st, c, build.PLACE_REACH, now)) return
  let ref = null
  if (c.kind === 'door') {
    try {
      const below = bot.blockAt(new Vec3(c.x, c.y - 1, c.z))
      if (below && below.position && below.boundingBox !== 'empty') ref = { ref: below, face: new Vec3(0, 1, 0) }
    } catch (_) { ref = null }
  } else {
    ref = build.findRef(bot, p)
  }
  if (!ref) {
    ctx.castleGoalIdx = -1
    strike(ctx, st, c, 'no-ref', now)
    return
  }
  flight(ctx, 'placeInFlight', c, async (token) => {
    try {
      await bot.equip(item, 'hand')
      await bot.placeBlock(ref.ref, ref.face)
      if (live(ctx, token)) ctx.castleFails = null
    } catch (_) {
      if (!live(ctx, token)) return
      const occ = nameAt(bot, c)
      if (occ != null && done(bot, c)) { ctx.castleFails = null; return } // landed anyway (a prep fill: any filler)
      strike(ctx, st, c, occ || 'refused', Date.now()) // an occupant clears via digCell next tick
    }
  })
}

// Air/dig cell holding something, or a place cell holding a wrong
// occupant (grass, dirt, our own scaffold — revmux 01): natural terrain,
// flora or our own placements only (flat allowlist + build REPLACEABLE +
// ctx.placedByBot), never under anyone's feet, and
// the shared denyReason gates (trap, gravity, submerged, protected).
function digCell(bot, ctx, st, c, now) {
  const name = nameAt(bot, c)
  if (flat.isLiquidName(name)) { blockCell(ctx, st, c, 'liquid', now); return }
  // Our own placements count too: the executor's scaffolding (cobblestone
  // pillared into a landing cell on the rig) must clear like terrain.
  // placedByBot is session-only, so cobblestone (Movements' scaffold item)
  // in a castle cell clears by name too: after a restart the leftover
  // pillar would otherwise gate every layer above it forever.
  let ours = name === 'cobblestone'
  try { ours = ours || (ctx.placedByBot instanceof Set && ctx.placedByBot.has(`${c.x},${c.y},${c.z}`)) } catch (_) { /* name rule stands */ }
  // Air/dig cells (moat, keep-clear, prep logs) take any natural block —
  // ores and every NATURAL_SOLID (idkcraft-g0z.13: an ore in a moat cell
  // was kept forever and the castle never completed). flat's allowlist
  // stays narrow for its own shaving; place-cell occupants keep it (g0z.2).
  const natural = flat.isDiggable(name) || build.isReplaceable(name) || isTreeBlock(name) ||
    (clearing(c) && typeof name === 'string' && (NATURAL_SOLID.has(name) || name.endsWith('_ore')))
  if (!ours && !natural) { blockCell(ctx, st, c, `kept-${name}`, now); return }
  // The doorway clears from the apron like the door places (rig: scaffold
  // in the doorway, dug from the inner stair step = walled below-feet).
  const ent = c.kind === 'door' ? entrance(st) : null
  if (approach(bot, ctx, c, () => ent
    ? new goals.GoalBlock(ent.x, ent.y, ent.z)
    : new goals.GoalNear(c.x, c.y, c.z, DIG_APPROACH))) return
  let moving = false
  try { moving = bot.pathfinder.isMoving() } catch (_) { /* treat as arrived */ }
  if (moving) return
  // Self first: bot.players lists the bot too, so the player test alone
  // would strike our own stance on the cell (rig: standing on own scaffold).
  if (flat.threatenedSelf(bot, c.x, c.y, c.z)) { sidestep(bot, ctx, st, c, now); return }
  if (flat.threatenedByPlayer(bot, c.x, c.y, c.z)) { strike(ctx, st, c, 'occupied', now); return }
  if (far(bot, ctx, st, c, flat.REACH_DIG, now)) return
  let b = null
  try { b = bot.blockAt(new Vec3(c.x, c.y, c.z)) } catch (_) { b = null }
  // Ours (above) passes the type rules like placedByBot does; the trap,
  // gravity, submerged and castle-block rules still apply.
  const k = `${c.x},${c.y},${c.z}`
  const dctx = ours ? { ...ctx, placedByBot: new Set([k]) } : ctx
  const deny = b ? denyReason(bot, b, dctx) : 'unreadable'
  if (deny) {
    if (b) logDeny(b, deny)
    // Stance rules (trap, gravity) change with the stance: step elsewhere,
    // since the approach goal is already satisfied where we stand (rig).
    if (deny === 'below-feet' || deny === 'gravity') sidestep(bot, ctx, st, c, now, deny)
    else strike(ctx, st, c, deny, now)
    return
  }
  flight(ctx, 'digInFlight', c, async (token) => {
    try {
      // Harvest tool first (flat digFlight): stone by hand drops nothing,
      // and the spoil is kept — cobble counts for the castle (g0z.6).
      let tool = null
      try { tool = typeof bot.pathfinder.bestHarvestTool === 'function' ? bot.pathfinder.bestHarvestTool(b) : null } catch (_) { tool = null }
      if (tool) await bot.equip(tool, 'hand')
      await bot.dig(b)
      if (live(ctx, token)) {
        ctx.castleFails = null
        if (spoilWalk(st, c)) ctx.castlePickup = { x: c.x, y: c.y, z: c.z, ticks: 0 }
      }
    } catch (_) {
      if (live(ctx, token) && nameAt(bot, c) !== 'air') strike(ctx, st, c, 'dig-refused', Date.now())
    }
  })
}

// Spoil pickup (g0z.6, flat's shave-pickup pattern): after a moat dig, walk
// onto the drop so it lands in the inventory. A drop 2+ above the feet
// would need a tower, one out of dig reach is stale (the bot left between
// ticks) — both left. True while the walk owns the tick.
// ponytail: the drop is assumed at the dug cell (moat digs: it is); a drop
// that rolled away stays as litter after PICKUP_TICKS.
const PICKUP_TICKS = 6
// Moat digs only, and never a cell under a planned block (revmux 01 core-1):
// the dug cell itself is then the standable node GoalNear(.., 1) needs. A
// bridge column under the deck has none (A* would dig one), and a place
// cell's occupant dig would walk the body into the cell it lays next.
function spoilWalk(st, c) {
  if (c.kind !== 'dig' && c.prep !== 'cut') return false // prep cut spoil is castle stone/filler too (g0z.16)
  const above = blueprint.absPlan(st.site, st.rot, st.blueprintVersion).at.get(`${c.x},${c.y + 1},${c.z}`)
  return !(above && blueprint.isPlaceTarget(above.kind))
}
function pickup(bot, ctx) {
  const p = ctx.castlePickup
  const bp = bodyPos(bot)
  const far = bp && Math.hypot(bp.x - p.x - 0.5, bp.z - p.z - 0.5) > flat.REACH_DIG
  if (!bp || far || p.y - Math.floor(bp.y) >= 2 || ++p.ticks > PICKUP_TICKS) { ctx.castlePickup = null; return false }
  if (p.ticks === 1) {
    try {
      ctx.castleGoal = new goals.GoalNear(p.x, p.y, p.z, 1)
      ctx.castleGoalIdx = -1
      bot.pathfinder.setGoal(ctx.castleGoal)
    } catch (_) { ctx.castlePickup = null; return false }
    return true
  }
  let moving = false
  try { moving = bot.pathfinder.isMoving() } catch (_) { /* treat as arrived */ }
  if (!moving) ctx.castlePickup = null
  return moving
}

// Castle guard for the pathfinder (every executor): laid castle blocks are
// never break candidates, and scaffolding anywhere on the site costs +100
// per block (rig: A* pillared in the interior and the doorway instead of
// taking the stairs — litter, and a scaffolded doorway sealed the tower;
// the epic's reach invariant exists so the bot never pillars). Reads
// ctx.castle live, so a site change or a cleared order needs no re-key;
// re-installed when Movements is replaced. ponytail: the place term is a
// cost (the lib has no place veto); a site whose stance needs a pillar
// still pillars, the reach invariant keeps that off the plan.
const SITE_TOP = 16 // crenellation dy 13 + headroom
function guardCastle(bot, ctx) {
  try {
    const mov = bot && bot.pathfinder && bot.pathfinder.movements
    if (!ctx || !ctx.castle || !mov || !Array.isArray(mov.exclusionAreasBreak) || !Array.isArray(mov.exclusionAreasPlace)) return
    if (ctx.castleGuardMov === mov && mov.exclusionAreasBreak.includes(ctx.castleGuardFn) &&
      mov.exclusionAreasPlace.includes(ctx.castlePlaceFn)) return
    for (const m of new Set([ctx.castleGuardMov, mov])) {
      if (m && Array.isArray(m.exclusionAreasBreak)) m.exclusionAreasBreak = m.exclusionAreasBreak.filter((f) => f !== ctx.castleGuardFn)
      if (m && Array.isArray(m.exclusionAreasPlace)) m.exclusionAreasPlace = m.exclusionAreasPlace.filter((f) => f !== ctx.castlePlaceFn)
    }
    const fn = (block) => {
      try {
        return ctx.castle && block && castleProtects(ctx.castle, block.position, block.name) ? 100 : 0
      } catch (_) { return 0 }
    }
    const placeFn = (block) => {
      try {
        const st = ctx.castle
        const q = block && block.position
        if (!st || !st.site || !q) return 0
        const { w, d } = blueprint.siteDimensions(st.rot | 0, st.blueprintVersion)
        const dx = q.x - st.site.x
        const dy = q.y - st.site.y
        const dz = q.z - st.site.z
        return dx >= 0 && dx < w && dz >= 0 && dz < d && dy >= 0 && dy <= SITE_TOP ? 100 : 0
      } catch (_) { return 0 }
    }
    mov.exclusionAreasBreak.push(fn)
    mov.exclusionAreasPlace.push(placeFn)
    ctx.castleGuardFn = fn
    ctx.castlePlaceFn = placeFn
    ctx.castleGuardMov = mov
  } catch (_) { /* best-effort: util.protectedReason still guards digs */ }
}

// One tick on one cell (plan or prep): material check, budget, then place
// into an open cell or dig a wrong occupant.
function work(bot, ctx, st, c, now, status) {
  let item = null
  if (!clearing(c)) {
    item = c.prep === 'fill' ? fillItem(bot) : findItem(bot, c.kind)
    if (!item) {
      // Material sourcing is g0z.4: report before walking anywhere.
      st.status = `need ${c.kind}`
      ctx.stepStatus = `failed:no-${c.kind}`
      return
    }
  }
  st.status = status
  const over = overBudget(bot, ctx, c.idx)
  if (over) { blockCell(ctx, st, c, over, now); return }
  const occ = nameAt(bot, c)
  const open = occ == null || AIR.has(occ) || occ === 'water'
  if (item && open) placeCell(bot, ctx, st, c, item, now)
  else digCell(bot, ctx, st, c, now)
}

function castle(bot, ctx) {
  const st = ctx.castle
  if (!st || !st.site || typeof st.site.x !== 'number') return
  if (!st.blocked || typeof st.blocked !== 'object') st.blocked = {}
  const now = Date.now()
  const fl = ctx.castleFlight
  if (fl && now - fl.since > build.FLIGHT_TIMEOUT_MS) {
    // Hung own flight: release the seam and strike the cell; a late
    // settlement is ignored through the token.
    ctx[fl.kind] = false
    ctx.castleFlight = null
    const c = fl.cell || blueprint.absPlan(st.site, st.rot, st.blueprintVersion).cells[fl.idx]
    if (c) strike(ctx, st, c, 'flight-hang', now)
  }
  if (ctx.placeInFlight || ctx.digInFlight) return
  guardCastle(bot, ctx)
  if (ctx.castlePickup && pickup(bot, ctx)) return
  if (st.phase === 'prep') {
    const list = prepTargets(bot, ctx, st, now)
    const c = list.find((o) => !done(bot, o) && !(st.blocked[bkey(st, o.idx)] && st.blocked[bkey(st, o.idx)].until > now))
    if (c) {
      if (!ctx.castlePrepSaid) {
        ctx.castlePrepSaid = true
        const n = (p) => list.filter((o) => o.prep === p).length
        try { bot.chat(`preparing the castle site: ${n('log')} logs to chop, ${n('cut')} blocks to cut, ${n('fill')} holes to fill`) } catch (_) { /* chat best-effort */ }
      }
      work(bot, ctx, st, c, now, 'preparing the site')
      return
    }
    // An unloaded column is not a prepared one (g0z.15): work the body this
    // tick (the walk loads the site) without skipping prep for good.
    if (!(ctx.castlePrep && ctx.castlePrep.unknown)) {
      st.phase = 'body'
      if (ctx.castlePrepSaid) {
        ctx.castlePrepSaid = false
        try { bot.chat('castle site ready, starting to build') } catch (_) { /* chat best-effort */ }
      }
    }
  }
  const { cells, key } = blueprint.absPlan(st.site, st.rot, st.blueprintVersion)
  const fullBefore = ctx.castleScanAt
  const r = pick(bot, ctx, st, cells, key, now)
  if (ctx.castleScanAt !== fullBefore) progress(bot, st, cells, ctx)
  if (r.idx < 0) {
    if (r.waiting) {
      const w = r.waiting
      st.status = `blocked at ${w.x} ${w.y} ${w.z} (${w.kind})`
      ctx.stepStatus = 'failed:blocked'
      return
    }
    if (st.phase !== 'complete') {
      const lit = litterTargets(bot, ctx, st, now).find((o) => !(st.blocked[bkey(st, o.idx)] && st.blocked[bkey(st, o.idx)].until > now))
      if (lit) { work(bot, ctx, st, lit, now, 'clearing scaffold'); return }
    }
    st.status = 'complete'
    ctx.stepStatus = 'done'
    if (st.phase !== 'complete') {
      st.phase = 'complete'
      try { bot.chat(`castle done at ${st.site.x} ${st.site.y} ${st.site.z}`) } catch (_) { /* chat best-effort */ }
    }
    return
  }
  work(bot, ctx, st, cells[r.idx], now, 'building')
}

module.exports = castle
module.exports.guardCastle = guardCastle
module.exports.backoffMs = backoffMs
module.exports.STRIKES = STRIKES
module.exports.FULL_RESCAN_MS = FULL_RESCAN_MS
// Castle material for the stockpile reserve. With the castle state, only
// the kinds its plan uses (g0z.12: a v1 castle never hoards logs/chests).
module.exports.isMaterial = (name, st) => typeof name === 'string' && Object.entries(ITEM).some(([kind, want]) =>
  want(name) && (!st || kind in blueprint.billOfMaterials(blueprint.blueprintOf(st.blueprintVersion).PLAN)))
module.exports.menuFact = menuFact
module.exports.rank = rank
module.exports.siteCheck = siteCheck
module.exports.progressByKind = progressByKind
module.exports.usable = usable
module.exports.findItem = findItem
module.exports.held = held
module.exports.reserveOf = reserveOf
module.exports.BATCH = BATCH
module.exports.BATCH_OF = BATCH_OF
module.exports.batchOf = batchOf
