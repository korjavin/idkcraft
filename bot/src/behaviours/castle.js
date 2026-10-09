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
// Skip-and-continue (idkcraft-vmzq.27): a cell that refuses three times
// (or blows its tick budget, or hangs a flight) is BLOCKED with bounded
// exponential backoff in ctx.castle.blocked["<blueprintVersion>:<idx>"] =
// {tries, until}, and the build goes on past it — the rest lays at the
// normal rate while the hole waits out its backoff, then retries. Holes
// are reported in one chat line (sayHoles); retries are rare (BACKOFF_MAX_MS)
// and bounded (MAX_HOLE_TRIES, then the hole retires: still reported, no
// longer waited on, so the moat digs and the castle completes). Planned
// air/dig cells are enforced only before phase 'complete': afterwards the
// bot never clears what the owner puts inside. Laid castle blocks are
// protected for every executor (util.protectedReason + guardCastle below).

const Vec3 = require('vec3')
const { goals } = require('mineflayer-pathfinder')
const blueprint = require('../castle')
const build = require('./build')
const flat = require('./flat')
const { denyReason, logDeny, NATURAL_SOLID, castleProtects, castleClears, RELOCATE, isInteractRef } = require('./util')

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
  stone: blueprint.isStone, // vmzq.38: the one castle-stone set (variants too)
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
// Walk buffer (idkcraft-vmzq.31, revmux 02 core-1): the stone reserve is
// one shelter pillar over the equip trigger — past the dirt shield (dirt
// at zero) the walks spend the buffer before the kit reads empty, and
// below-16 equip refills. Deferred require: equip loads inside the
// craft->goal chain (SHELTER_RESERVE below is module-local, read at call
// time, so the forward reference is safe).
function reserveOf(kind) {
  if (kind === 'stone') {
    try { return require('./equip').SCAFFOLD_LOW + SHELTER_RESERVE } catch (_) { return 24 }
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
// Relocated box contents (vmzq.40) are the owner's, not castle material:
// with ctx, the carried stacks never count as usable.
function carried(ctx, kind) {
  const want = ITEM[kind]
  let n = 0
  for (const it of (ctx && ctx.castleCarry && ctx.castleCarry.items) || []) if (want(it.name)) n += it.count
  return n
}
function usable(bot, kind, ctx) {
  return Math.max(0, held(bot, kind) - reserveOf(kind) - carried(ctx, kind))
}

// Birch first (g0z.4: the Fachwerk infill prefers light wood), else any.
function findItem(bot, kind, ctx) {
  const want = ITEM[kind]
  if (!want || usable(bot, kind, ctx) <= 0) return null
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

// Night-shelter dirt floor (idkcraft-vmzq.31): the castle never spends the
// last SHELTER_RESERVE dirt. Dirt is the shield for the cobble store:
// body.js keeps cobble walk-proof while any dirt is held, so the cobble
// (the laying reserve plus the night pillar fuel) survives the walks, and
// fetch-leg spoil refills the dirt the walks do spend (below-16 equip
// refills it too; at zero dirt past the topsoil the buffer above is what
// stands between the walks and an empty kit). Prod
// run6 laid to the stone reserve, pillared the rest away walking, and the
// night shelter pillar failed with an empty kit. Counting cobble toward
// the floor would not hold it: cobble at the reserve reads as savings
// while the dirt drains to zero, and zero dirt unlocks cobble walking
// (revmux 01 core-1) — so the floor counts dirt only. Shelter and recover
// spend the floor freely.
const SHELTER_RESERVE = 8
function dirtOnHand(bot) {
  let n = 0
  try {
    for (const it of bot.inventory.items() || []) {
      if (it && it.name === 'dirt') n += typeof it.count === 'number' ? it.count : 1
    }
  } catch (_) { /* no inventory: none */ }
  return n
}

// Prep fill (g0z.16): castle stone above the reserve, else dirt (the cut
// spoil of a grass hill) — but never the dirt floor above.
function fillItem(bot, ctx) {
  const s = findItem(bot, 'stone', ctx)
  if (s) return s
  if (dirtOnHand(bot) <= SHELTER_RESERVE) return null
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
// Bounded retry (vmzq.27 revmux 01): after this many blocks the hole
// retires — still listed by holesOf, never picked or waited on — so a
// permanent hole (protected log, kept chest) finishes as a reported gap
// instead of holding the moat and 'complete' forever. ~35 min of rare
// retries first (backoffs 30s..600s), covering a play session in which the
// owner might clear the cell. Rebuild (cancel + build) un-retires.
const MAX_HOLE_TRIES = 8

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
  // Bounded retry (revmux 01): the MAX_HOLE_TRIES-th block retires the
  // hole — still reported, never picked or waited on again.
  if (e.tries >= MAX_HOLE_TRIES) e.retired = true
  st.blocked[k] = e
  ctx.castleFails = null
  ctx.castleCell = null
  ctx.castleFar = null
  ctx.castleSelfOcc = null // each retry gets fresh stances (vmzq.53 revmux 01)
  ctx.castleGoalIdx = -1
  console.log(`castle blocked ${c.x} ${c.y} ${c.z} ${c.kind} (${why}) try ${e.tries}${e.retired ? ', retired' : `, retry in ${Math.round(backoffMs(e.tries) / 1000)}s`}`)
}

function strike(ctx, st, c, why, now) {
  const f = ctx.castleFails && ctx.castleFails.idx === c.idx ? ctx.castleFails : { idx: c.idx, n: 0 }
  f.n++
  ctx.castleFails = f
  if (f.n >= STRIKES) blockCell(ctx, st, c, why, now)
}

// Open holes (vmzq.27): on-plan cells with a blocked entry that haven't
// landed yet — active backoffs, expired ones awaiting their retry, and
// retired ones alike, so the set is stable across a retry gap and a
// retired hole stays reported after 'complete'. Off-plan entries (prep,
// litter) are best-effort and never listed. First-try no-ref stays
// unlisted (revmux 01): out-of-order attempts fail it transiently and heal
// on the first retry; a no-ref that survives to try 2 is listed.
function holesOf(bot, st, cells) {
  const out = []
  const bl = (st && st.blocked) || {}
  for (const k of Object.keys(bl)) {
    const [v, i] = k.split(':')
    if (Number(v) !== ver(st)) continue
    const c = cells[Number(i)]
    const e = bl[k]
    if (!c || !e || done(bot, c)) continue
    if (e.why === 'no-ref' && (e.tries || 0) < 2) continue
    out.push({ x: c.x, y: c.y, z: c.z, kind: c.kind, why: String(e.why || '?'), until: e.until, retired: !!e.retired })
  }
  return out.sort((a, b) => a.x - b.x || a.y - b.y || a.z - b.z)
}

// Holes announcement (vmzq.27, g0z.23 core-1 shape): the status line (the
// 'castle' command shows it) and ONE chat line listing every hole. Called
// from castle() after every pick — while building past holes and while
// waiting on them — and from menuFact's waiting branch (decide() drops the
// castle step on the flip, so the executor's branch never runs in prod);
// the shared latch dedupes across both. Only a new cell (or a newly
// retired one) re-chats: a retry gap, a resolve and a why-change between
// retries all stay silent (revmux 01), the latch syncing either way.
// False when no open hole.
function sayHoles(bot, ctx, st, holes, now) {
  if (!holes.length) { ctx.castleBlockedSaid = null; return false }
  const toks = holes.map((h) => `${h.x},${h.y},${h.z}${h.retired ? 'R' : ''}`)
  const desc = (h) => `${h.x} ${h.y} ${h.z} (${h.kind}: ${h.why}${h.retired ? ', retired' : ''})`
  st.status = `holes: ${holes.map(desc).join(', ')}`
  const said = new Set(String(ctx.castleBlockedSaid || '').split('|').filter(Boolean))
  const fresh = toks.filter((t) => !said.has(t))
  ctx.castleBlockedSaid = toks.join('|')
  if (!fresh.length) return true
  const live = holes.filter((h) => !h.retired)
  const tail = live.length
    ? `, retry in ${Math.max(0, Math.round((Math.min(...live.map((h) => (typeof h.until === 'number' ? h.until : now))) - now) / 1000))}s`
    : ', no retries left'
  let line = holes.length === 1 ? `castle: 1 hole at ${desc(holes[0])}${tail}` : `castle: ${holes.length} holes: ${holes.map(desc).join(', ')}${tail}`
  const kept = [...new Set(holes.map((h) => /^kept-(.+)$/.exec(h.why)).filter(Boolean).map((m) => m[1]))]
  if (kept.length === 1 && holes.length === 1) line += ` — remove the ${kept[0]} there or say castle stop`
  else if (kept.length) line += ' — remove those blocks or say castle stop'
  try { bot.chat(line) } catch (_) { /* chat best-effort */ }
  return true
}

// Work order = plan order with the door deferred past every other place
// cell (revmux 01): the laid door is break-vetoed, so the doorway stays an
// open passage while the bot still needs the interior (A* opens wooden
// doors since idkcraft-6xno, but an unlaid doorway still beats a toggle per
// trip). Then the keep-clear cells, the moat digs (v2, g0z.6: the bridge
// deck is an ordinary place cell, so it exists before any dig) and the
// fence ring last. Indices stay plan indices (blocked keys).
// Torches (g0z.17) go after every other place cell, before the door: no
// cell leans on a torch, and a torch-none word (no coal for the craft)
// must never hold the stone and planks behind it.
const RANK = { torch: 0.5, door: 1, air: 2, dig: 3, fence: 4 }
function rank(c) { return RANK[c.kind] || 0 }
// Interior work (g0z.6): an undone cell ranked before the moat. While one
// is left, no moat cell is dug, so the bot never has to cross a dug moat
// to finish the castle; later repairs cross the bridge, which is laid
// before any dig. Blocked holes never feed `inside` (revmux 01) — active
// or retired, the moat digs while they wait — and work order still
// sequences real interior work first.
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
  // Prune landed cells and stale-version entries. Blocked-active cells are
  // skipped below (vmzq.27 skip-and-continue) — no layer gate: the rest
  // lays while holes wait out their backoff.
  for (const k of Object.keys(st.blocked)) {
    const [v, i] = k.split(':')
    const c = cells[Number(i)]
    // Off-plan entries (prep, litter) live until they expire (g0z.14).
    if (Number(v) !== ver(st) || (c ? done(bot, c) : st.blocked[k].until <= now)) { delete st.blocked[k]; continue }
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
      if (torchOwed(bot, c, owed)) {
        const bo = st.blocked[bkey(st, c.idx)]
        if (!bo || !bo.retired) owed = owed || c
        continue
      }
      // Holes never feed `inside` (revmux 01): retired cells pass through
      // silently, active ones wait — either way the moat digs past them.
      const b = st.blocked[bkey(st, c.idx)]
      if (b && b.retired) continue
      if (b && b.until > now) { waiting = waiting || c; continue }
      if (c.kind === 'dig' && inside) { waiting = waiting || c; continue }
      if (interior(c)) inside = true
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
// executor would work now, or why there is none — same work order, skip
// and backoff, no cursor/scan/blocked-map writes. Full scan from 0.
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
  let waiting = null
  let inside = false
  let owed = null
  for (const idx of workOrder(cells, key)) {
    const c = cells[idx]
    if (clearing(c) && complete) continue
    if (done(bot, c)) continue
    if (torchOwed(bot, c, owed)) {
      const bo = blocked[bkey(st, c.idx)]
      if (!bo || !bo.retired) owed = owed || c
      continue
    }
    const b = blocked[bkey(st, c.idx)]
    if (b && b.retired) continue
    if (b && b.until > now) { waiting = waiting || c; continue }
    if (c.kind === 'dig' && inside) { waiting = waiting || c; continue }
    if (interior(c)) inside = true
    return { cell: c, waiting: null, cells }
  }
  return { cell: owed, waiting: owed ? null : waiting, cells }
}

// Site prep (g0z.5, phase 'prep'): the order-time check (siteCheck) vouches
// for the ground; before the plan starts the castle chops trees standing in
// the footprint volume, then levels the footprint to site.y-1 (g0z.16):
// cuts every solid block at or above site.y (top-down, spoil kept as castle
// material) and fills holes up to site.y-1 (bottom-up, stone, else dirt).
// Plan cells below site.y (the moat) are the plan's, never filled — except
// in a wet ring column (g0z.20), where the fill replaces the water and the
// moat digs it out again. A block that already matches its plan cell stays.
// Best effort: a target that refuses is blocked like any cell and the body
// phase starts without it — the body executor still clears what its own
// cells hit.
// Thresholds (owner 2026-10-03, g0z.20): the core (walls, towers, hall) may
// sit ±MAX_DIP off level, the ring around it (apron, moat, fence) anything
// the scan reads, all of it within EARTH_BUDGET blocks cut + filled; water
// in the core refuses, up to RING_WATER wet ring columns are filled.
const MAX_DIP = 4
const SCAN_DOWN = 8 // holes are read this deep for the refusal's worst offset
const RING_DIP = SCAN_DOWN // the scan floor (a deeper hole reads 9+, refused)
const EARTH_BUDGET = 400
const RING_WATER = 6
// Built things: someone's house, not terrain (the site check refuses them).
const FOREIGN = /(planks|_door$|_bed$|fence|glass|crafting_table|chest|furnace|brick|wool|stairs|_slab$|_sign$|barrel|ladder|torch|(?<!moss_)carpet|concrete|bookshelf|_wall$)/

function isLogName(n) { return typeof n === 'string' && (n.endsWith('_log') || n.endsWith('_stem')) && !n.startsWith('stripped_') }
function isTreeBlock(n) { return isLogName(n) || (typeof n === 'string' && n.endsWith('_leaves')) }
// Pass-through for the ground scan: air, flora, trees (leaves stay, logs chop).
function passes(n) { return AIR.has(n) || build.isReplaceable(n) || isTreeBlock(n) }

// Top-down column read over the site volume: first ground block, or what
// disqualifies the column. Unloaded reads are 'unknown'. Water below the
// level is read through to its bed (g0z.20: {top, water: y}, the fill's
// to replace); lava, bubble columns and water at or above site.y refuse.
function scanColumn(bot, x, z, sy) {
  const logs = []
  let water = null
  for (let y = sy + SITE_TOP; y >= sy - 1 - SCAN_DOWN; y--) {
    const name = nameAt(bot, { x, y, z })
    if (name == null) return { unknown: true }
    if (FOREIGN.test(name)) return { foreign: name, y }
    if (flat.isLiquidName(name)) {
      if (name !== 'water' || y >= sy) return { liquid: name, y }
      if (water == null) water = y
      continue
    }
    // Collision-free blocks (any flora, double-tall flowers included) are
    // not ground; mineflayer reads water as empty too, hence liquid first.
    let soft = false
    try { soft = bot.blockAt(new Vec3(x, y, z)).boundingBox === 'empty' } catch (_) { soft = false }
    if (passes(name) || soft) {
      if (isLogName(name)) logs.unshift(y)
      continue
    }
    return water == null ? { top: y, logs } : { top: y, logs, water }
  }
  const top = sy - 2 - SCAN_DOWN
  return water == null ? { top, logs } : { top, logs, water }
}

// Core columns (g0z.20): under a planned cell at or above the floor, the
// fence excepted — walls, towers, the hall. The rest is the ring.
let coreCache = null
function coreOf(rot, version) {
  const bp = blueprint.blueprintOf(version)
  const key = `${rot | 0},${bp.version}`
  if (coreCache && coreCache.key === key) return coreCache.set
  const set = new Set()
  for (const c of blueprint.rotatePlan(bp.PLAN, rot | 0, bp.version)) {
    if (c.dy >= 0 && c.kind !== 'fence') set.add(`${c.dx},${c.dz}`)
  }
  coreCache = { key, set }
  return set
}

// Order-time check (g0z.20): the level is the median ground top over the
// core (site.y is only the scan hint — the speaker's feet), then every
// column is judged at that level. Returns {y, bad: null} (y = the level
// to build on, median+1) or {y, bad: reason, why: water|built|uneven|
// unloaded}; {pause: true} when opts.scan ran out of budget (the search
// resumes it). opts.strict: an unloaded column refuses (the search);
// without it it passes (the speaker stands there, the walk loads it).
function siteEval(bot, site, rot, version, opts = {}) {
  const { w, d } = blueprint.siteDimensions(rot | 0, version)
  const core = coreOf(rot, version)
  const scan = opts.scan || ((x, z, sy) => scanColumn(bot, x, z, sy))
  const tops = []
  for (const k of core) {
    const [dx, dz] = k.split(',').map(Number)
    const r = scan(site.x + dx, site.z + dz, site.y)
    if (!r) return { pause: true }
    if (typeof r.top === 'number') tops.push(r.top)
  }
  tops.sort((a, b) => a - b)
  const sy = tops.length ? tops[tops.length >> 1] + 1 : site.y
  let n = 0
  let moved = 0
  let worst = null
  let over = null
  let wet = 0
  let firstWet = null
  for (let dx = 0; dx < w; dx++) {
    for (let dz = 0; dz < d; dz++) {
      const x = site.x + dx
      const z = site.z + dz
      const r = scan(x, z, sy)
      if (!r) return { pause: true }
      if (r.unknown) {
        if (opts.strict) return { y: sy, bad: `I can't see the ground at ${x} ${z} yet`, why: 'unloaded' }
        continue
      }
      if (r.liquid) return { y: sy, bad: `there is ${r.liquid} at ${x} ${r.y} ${z}`, why: 'water' }
      if (r.foreign) return { y: sy, bad: `somebody built there (${r.foreign} at ${x} ${r.y} ${z})`, why: 'built' }
      const inCore = core.has(`${dx},${dz}`)
      if (r.water != null) {
        if (inCore) return { y: sy, bad: `there is water at ${x} ${r.water} ${z}`, why: 'water' }
        wet++
        firstWet = firstWet || { x, y: r.water, z }
      }
      const off = r.top - (sy - 1)
      moved += Math.abs(off)
      if (!worst || Math.abs(off) > Math.abs(worst.off)) worst = { off, x, z }
      if (Math.abs(off) > (inCore ? MAX_DIP : RING_DIP)) {
        n++
        if (!over || Math.abs(off) > Math.abs(over.off)) over = { off, x, z } // the refusal names an offender
      }
      // The search needs the verdict, not the tally: stop reading here.
      if (opts.strict && (n || moved > EARTH_BUDGET)) return { y: sy, bad: 'the ground is too uneven', why: 'uneven' }
    }
  }
  if (wet > RING_WATER) {
    return { y: sy, bad: `there is water in ${wet} spots around it, first at ${firstWet.x} ${firstWet.y} ${firstWet.z} (I fill up to ${RING_WATER})`, why: 'water' }
  }
  if (!n && moved <= EARTH_BUDGET) return { y: sy, bad: null }
  const p = n ? over : worst
  const by = p.off <= -(1 + SCAN_DOWN) ? `${1 + SCAN_DOWN}+` : String(Math.abs(p.off)) // the scan floor
  const at = `worst ${by} ${p.off > 0 ? 'up' : 'down'} at ${p.x} ${p.z}`
  if (n) return { y: sy, bad: `the ground is too uneven: ${n} spots are more than ${MAX_DIP} blocks off level, ${at} (I level up to ${MAX_DIP} under the castle)`, why: 'uneven' }
  return { y: sy, bad: `the ground is too uneven: levelling it moves ${moved} blocks, ${at} (I move up to ${EARTH_BUDGET})`, why: 'uneven' }
}

// Reason or null (tests, the legacy seam); an order builds on siteEval's y.
function siteCheck(bot, site, rot, version) {
  return siteEval(bot, site, rot, version).bad
}

// Gate toward the speaker (castleSite's mapping): rot for a castle lying
// along (lx, lz) from them — 0 gate north, 1 east, 2 south, 3 west.
function facing(lx, lz) {
  return Math.abs(lx) > Math.abs(lz) ? (lx > 0 ? 3 : 1) : (lz > 0 ? 0 : 2)
}

// Site search (g0z.19): candidates on a SEARCH_STEP grid within
// SEARCH_RADIUS of the speaker, nearest first, the gate toward them; the
// first that siteEval passes (strict: loaded chunks only) and `reject`
// (the house) lets through wins. A tick reads at most `budget` new
// columns; reads are cached per (x, z, level), so a candidate that ran out
// resumes for free next tick. ponytail: one rotation per spot; try all 4
// if prod shows castles refused between hills.
const SEARCH_RADIUS = 48
const SEARCH_STEP = 4
const SEARCH_SCANS = 300 // new columns per tick, ~25 blockAt each
function startSiteSearch(from, version, reject) {
  const cands = []
  for (let ox = -SEARCH_RADIUS; ox <= SEARCH_RADIUS; ox += SEARCH_STEP) {
    for (let oz = -SEARCH_RADIUS; oz <= SEARCH_RADIUS; oz += SEARCH_STEP) {
      if (Math.hypot(ox, oz) <= SEARCH_RADIUS) cands.push([ox, oz])
    }
  }
  cands.sort((a, b) => Math.hypot(a[0], a[1]) - Math.hypot(b[0], b[1]))
  return {
    from: { x: Math.floor(from.x), y: Math.floor(from.y), z: Math.floor(from.z) },
    version, reject, cands, i: 0, cache: new Map(), why: {}, lastScans: 0,
  }
}

// One tick of the search: {done: false}, {done: true, site, rot}, or
// {done: true, site: null, why, n, of} — the most common refusal.
function stepSiteSearch(bot, cur, budget = SEARCH_SCANS) {
  let left = budget
  const scan = (x, z, sy) => {
    const k = `${x},${z},${sy}`
    let r = cur.cache.get(k)
    if (r) return r
    if (left <= 0) return null
    left--
    r = scanColumn(bot, x, z, sy)
    cur.cache.set(k, r)
    return r
  }
  try {
    while (cur.i < cur.cands.length) {
      const [ox, oz] = cur.cands[cur.i]
      const rot = facing(ox, oz)
      const { w, d } = blueprint.siteDimensions(rot, cur.version)
      const site = { x: cur.from.x + ox - (w >> 1), y: cur.from.y, z: cur.from.z + oz - (d >> 1) }
      const r = cur.reject && cur.reject(site, rot) ? { why: 'house' } : siteEval(bot, site, rot, cur.version, { scan, strict: true })
      if (r.pause) return { done: false }
      cur.i++
      if (!r.why) return { done: true, site: { ...site, y: r.y }, rot }
      cur.why[r.why] = (cur.why[r.why] || 0) + 1
    }
  } finally {
    cur.lastScans = budget - left
  }
  let why = null
  for (const k of Object.keys(cur.why)) if (!why || cur.why[k] > cur.why[why]) why = k
  return { done: true, site: null, why, n: why ? cur.why[why] : 0, of: cur.cands.length }
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
  const core = coreOf(st.rot, st.blueprintVersion)
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
      // Past its cap the order refused it: a later change is not ours to level.
      if (Math.abs(r.top - (sy - 1)) > (core.has(`${dx},${dz}`) ? MAX_DIP : RING_DIP)) continue
      for (let y = r.top; y >= sy; y--) {
        const c = { x, y, z, kind: 'air', prep: 'cut', idx: idx(x, y, z) }
        const p = at.get(`${x},${y},${z}`)
        if (prepDone(bot, c) || (p && blueprint.matches(p.kind, nameAt(bot, c)))) continue
        cuts.push(c)
      }
      for (let y = r.top + 1; y <= sy - 1; y++) {
        const p = at.get(`${x},${y},${z}`)
        if (!p || (r.water != null && p.kind === 'dig')) fills.push({ x, y, z, kind: 'stone', prep: 'fill', idx: idx(x, y, z) })
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
// torch (g0z.17, revmux 02): any torch is a batch — torches lay last, and a
// torch-some word with no coal would hold the moat, fence and door; the
// castle lays what it holds and the 0-torch cells step aside (torchOwed).
const BATCH_OF = { frame: 14, torch: 1 }
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

// Loaded = all four footprint corners read (revmux 02): the v1 site
// spans at most 2x2 chunks; the v2 site (31x27) up to 3x3, whose middle
// chunks lie inside the corners' hull — the loaded area is convex.
function siteLoaded(bot, st) {
  try {
    if (!st || !st.site || typeof st.site.x !== 'number') return false
    const { w, d } = blueprint.siteDimensions(st.rot | 0, st.blueprintVersion)
    return [[0, 0], [w - 1, 0], [0, d - 1], [w - 1, d - 1]].every(([dx, dz]) => !!bot.blockAt(new Vec3(st.site.x + dx, st.site.y, st.site.z + dz)))
  } catch (_) { return false }
}

// 'finish' (revmux 01): every cell matches but the executor has not yet
// run its completion branch (phase, chat, keep-clear release) — one more
// castle tick does that, then the word reads 'done'.
// Unloaded site (revmux 01): null blocks read as undone, so a fresh peek
// would call a far complete castle unfinished and yank the bot back. Far
// away the word is the last one read on site (stock re-read for a material
// word); a complete castle reads done; never seen this session -> the
// first plan cell's kind (walk back and build).
// Loaded = all four footprint corners read (revmux 02): the v1 site
// spans at most 2x2 chunks; the v2 site (31x27) up to 3x3, whose middle
// chunks lie inside the corners' hull — the loaded area is convex.
function siteLoaded(bot, st) {
  try {
    const { w, d } = blueprint.siteDimensions(st.rot | 0, st.blueprintVersion)
    return [[0, 0], [w - 1, 0], [0, d - 1], [w - 1, d - 1]].every(([dx, dz]) => !!bot.blockAt(new Vec3(st.site.x + dx, st.site.y, st.site.z + dz)))
  } catch (_) { return false }
}

function menuFact(bot, ctx, now = Date.now()) {
  const st = ctx && ctx.castle
  if (!st || !st.site || typeof st.site.x !== 'number') return 'none'
  if (st.parked) return 'parked'
  try {
    if (!siteLoaded(bot, st)) {
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
    // Task progress (vmzq.2): refresh st.progress while loaded so the stall
    // clock sees growth even when the castle step never runs (fight/shelter
    // ticks never reach the work block). Throttled to FULL_RESCAN_MS — no
    // 1722-cell scan per tick; off-site the last value stands. Prep reads
    // 0/total (the body has not started); prep itself is tracked separately.
    try {
      if (st.phase === 'prep') {
        if (!st.progress) {
          const { cells } = blueprint.absPlan(st.site, st.rot, st.blueprintVersion)
          let total = 0
          for (const c of cells) if (!clearing(c)) total++
          st.progress = { done: 0, total }
        }
      } else if (now - (ctx.castleMenuProgressAt || 0) >= FULL_RESCAN_MS) {
        ctx.castleMenuProgressAt = now
        progress(bot, st, r.cells, ctx)
      }
    } catch (_) { /* progress best-effort */ }
    let word = null
    if (!r.cell) {
      // Blocked (g0z.23): the waiting kind and its remainder stay on the
      // word, so a far site reads stock (walk back) and castlefetch
      // quarries the waiting kind while the build stands. On site the word
      // stays 'blocked'. Announced here (core-1): decide() drops the
      // castle step on the flip, so castle()'s waiting branch never runs
      // in prod.
      if (r.waiting) {
        // core-3: only a material kind latches — a blocked keep-clear
        // ('air') or moat ('dig') cell keeps { word: 'blocked' }, so a far
        // site reads 'blocked', never a meaningless 'air-none'.
        const kind = ITEM[r.waiting.kind] ? r.waiting.kind : null
        if (kind) {
          let left = 0
          // Infill run (g0z.15), like the material branch: planks up to the
          // next Fachwerk beam only, not the whole remainder.
          if (kind === 'planks') {
            // Same cells+key peek just used (absPlan key shape): a cache hit.
            const order = workOrder(r.cells, `${st.site.x},${st.site.y},${st.site.z},${st.rot | 0},v${ver(st)}`)
            for (let i = order.indexOf(r.waiting.idx); i >= 0 && i < order.length; i++) {
              const o = r.cells[order[i]]
              if (done(bot, o)) continue
              if (o.kind === 'frame') break
              if (o.kind === kind) left++
            }
          } else {
            for (const o of r.cells) {
              if (o.kind === kind && !done(bot, o)) left++
            }
          }
          ctx.castleWord = { word: 'blocked', kind, left }
        } else {
          ctx.castleWord = { word: 'blocked' }
        }
        sayHoles(bot, ctx, st, holesOf(bot, st, r.cells), now)
        return 'blocked'
      }
      word = st.phase === 'complete' ? 'done' : 'finish'
    }
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

// Standable stances off the cell's column (vmzq.53): feet + head air on a
// solid, dry floor, within 2 columns and 1 level of the body, nearest
// first. On a dug moat row the blind 4-way rotation only offered holes
// and walls, so the body never left the cell it stood on.
function sidestepStances(bot, c, bp) {
  const fx = Math.floor(bp.x), fy = Math.floor(bp.y), fz = Math.floor(bp.z)
  const out = []
  for (let dx = -2; dx <= 2; dx++) {
    for (let dz = -2; dz <= 2; dz++) {
      const x = fx + dx, z = fz + dz
      if ((dx === 0 && dz === 0) || (x === c.x && z === c.z)) continue
      for (const dy of [0, -1, 1]) {
        const y = fy + dy
        if (!AIR.has(nameAt(bot, { x, y, z })) || !AIR.has(nameAt(bot, { x, y: y + 1, z }))) continue
        let below = null
        try { below = bot.blockAt(new Vec3(x, y - 1, z)) } catch (_) { below = null }
        if (!below || below.boundingBox !== 'block' || flat.isLiquidName(below.name)) continue
        out.push({ x, y, z, d: dx * dx + dz * dz + Math.abs(dy) * 0.5 })
      }
    }
  }
  return out.sort((a, b) => a.d - b.d)
}

// Self-occupancy (flat SELF_OCC_LIMIT): standing in our own target steps
// aside; a body that cannot get out blocks the cell instead of orbiting,
// as 'self-stance' (vmzq.53: it logged as a player 'occupied').
function sidestep(bot, ctx, st, c, now, why = 'self-stance') {
  const so = ctx.castleSelfOcc && ctx.castleSelfOcc.idx === c.idx ? ctx.castleSelfOcc : { idx: c.idx, n: 0 }
  so.n++
  ctx.castleSelfOcc = so
  const bp = bodyPos(bot)
  if (so.n > flat.SELF_OCC_LIMIT) {
    if (bp) console.log(`castle ${why} at ${c.x} ${c.y} ${c.z}: body ${bp.x.toFixed(1)} ${bp.y.toFixed(1)} ${bp.z.toFixed(1)}`)
    blockCell(ctx, st, c, why, now)
    return
  }
  // GoalBlock, not GoalNear(.., 1): a range-1 goal one step away is already
  // satisfied where we stand, so the pathfinder never moves (rig).
  try {
    if (bp) {
      // Retries rotate through the stances; none readable keeps the blind step.
      const ok = sidestepStances(bot, c, bp)
      const s = SIDESTEPS[so.n % SIDESTEPS.length]
      const t = ok.length ? ok[(so.n - 1) % ok.length] : { x: Math.floor(bp.x) + s[0], y: Math.floor(bp.y), z: Math.floor(bp.z) + s[1] }
      ctx.castleGoal = new goals.GoalBlock(t.x, t.y, t.z)
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
// Re-dig guard (vmzq.54): a plan dig cell that keeps coming back (our
// scaffold, a player) blocks with the usual backoff instead of looping —
// each dig succeeds and the body moves, so no strike or budget fires.
// Session-only counts; blockCell's MAX_HOLE_TRIES retire bounds it.
const REDIG_MAX = 3
function digCell(bot, ctx, st, c, now) {
  const name = nameAt(bot, c)
  const rk = c.kind === 'dig' ? bkey(st, c.idx) : null
  if (rk && !AIR.has(name) && ctx.castleRedig && (ctx.castleRedig[rk] || 0) >= REDIG_MAX) {
    delete ctx.castleRedig[rk]
    blockCell(ctx, st, c, 'refilled', now)
    return
  }
  if (flat.isLiquidName(name)) { blockCell(ctx, st, c, 'liquid', now); return }
  // Our own placements count too: the executor's scaffolding (cobblestone
  // pillared into a landing cell on the rig) must clear like terrain.
  // placedByBot is session-only, so cobblestone (Movements' scaffold item)
  // in a castle cell clears by name too: after a restart the leftover
  // pillar's key is gone, and without the name rule it would read as a
  // foreign build and block its cell.
  let ours = name === 'cobblestone'
  try { ours = ours || (ctx.placedByBot instanceof Set && ctx.placedByBot.has(`${c.x},${c.y},${c.z}`)) } catch (_) { /* name rule stands */ }
  // Air/dig cells (moat, keep-clear, prep logs) take any natural block —
  // ores and every NATURAL_SOLID (idkcraft-g0z.13: an ore in a moat cell
  // was kept forever and the castle never completed). flat's allowlist
  // stays narrow for its own shaving; place-cell occupants keep it (g0z.2).
  const natural = flat.isDiggable(name) || build.isReplaceable(name) || isTreeBlock(name) ||
    (clearing(c) && typeof name === 'string' && (NATURAL_SOLID.has(name) || name.endsWith('_ore')))
  // Unreadable (an unloaded chunk while far) is not a foreign build: it
  // falls through to the approach below, which loads the cell, and a cell
  // that never reads strikes 'unreadable' instead (g0z.22).
  // The footprint is ours (vmzq.40): a foreign blocker clears for the
  // castle step (util.castleClears), a box relocates with its contents.
  const clear = { ...ctx, castleClear: true }
  if (name != null && RELOCATE.test(name) && castleClears({ ...ctx, castleClear: 'emptied' }, c, name)) { relocate(bot, ctx, st, c, name, now); return }
  const footprintOnly = name != null && !ours && !natural
  if (footprintOnly && !castleClears(clear, c, name)) { blockCell(ctx, st, c, `kept-${name}`, now); return }
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
  const dctx = ours ? { ...clear, placedByBot: new Set([k]) } : clear
  const deny = b ? denyReason(bot, b, dctx) : 'unreadable'
  if (deny) {
    if (b) logDeny(b, deny)
    // Stance rules (trap, gravity) change with the stance: step elsewhere,
    // since the approach goal is already satisfied where we stand (rig).
    if (deny === 'below-feet' || deny === 'gravity') sidestep(bot, ctx, st, c, now, deny)
    else strike(ctx, st, c, deny, now)
    return
  }
  // Harvest tool first (flat digFlight): stone by hand drops nothing,
  // and the spoil is kept — cobble counts for the castle (g0z.6).
  const tool = harvestTool(bot, b)
  // Someone's block (vmzq.40) is never destroyed by hand: it waits for the tool.
  if (footprintOnly && !canHarvest(b, tool)) { blockCell(ctx, st, c, `no-tool-${name}`, now); return }
  flight(ctx, 'digInFlight', c, async (token) => {
    try {
      if (tool) await bot.equip(tool, 'hand')
      await bot.dig(b)
      if (live(ctx, token)) {
        ctx.castleFails = null
        if (rk) { ctx.castleRedig = ctx.castleRedig || {}; ctx.castleRedig[rk] = (ctx.castleRedig[rk] || 0) + 1 }
        if (spoilWalk(st, c)) ctx.castlePickup = { x: c.x, y: c.y, z: c.z, ticks: 0 }
      }
    } catch (_) {
      if (live(ctx, token) && nameAt(bot, c) !== 'air') strike(ctx, st, c, 'dig-refused', Date.now())
    }
  })
}

// pathfinder.bestHarvestTool returns any pack item (lowest dig time), so
// the harvest check reads the block's own tool list (revmux 01).
function harvestTool(bot, b) {
  try { return typeof bot.pathfinder.bestHarvestTool === 'function' ? bot.pathfinder.bestHarvestTool(b) : null } catch (_) { return null }
}
function canHarvest(b, tool) {
  return !b.harvestTools || !!(tool && b.harvestTools[tool.type])
}

// Relocate (idkcraft-vmzq.40, owner rule: never lose items): a chest or
// barrel in a castle cell moves out. One flight empties it into
// the pack (all or nothing — what does not fit goes back and the cell stays
// a kept-<name> hole), digs it and walks onto the drop; stow() then places
// it outside the footprint and the door path and puts the contents back.
// ctx.castleCarry keeps the carried stacks out of castle material (usable).
// ponytail: carry is in-memory — a restart mid-move leaves the contents in
// the pack (kept, not lost, just no longer put back).
function relocate(bot, ctx, st, c, name, now) {
  if (ctx.castleCarry) { blockCell(ctx, st, c, 'carrying', now); return } // one box at a time
  if (approach(bot, ctx, c, () => new goals.GoalNear(c.x, c.y, c.z, DIG_APPROACH))) return
  let moving = false
  try { moving = bot.pathfinder.isMoving() } catch (_) { /* treat as arrived */ }
  if (moving) return
  if (flat.threatenedSelf(bot, c.x, c.y, c.z)) { sidestep(bot, ctx, st, c, now); return }
  if (flat.threatenedByPlayer(bot, c.x, c.y, c.z)) { strike(ctx, st, c, 'occupied', now); return }
  if (far(bot, ctx, st, c, flat.REACH_DIG, now)) return
  let b = null
  try { b = bot.blockAt(new Vec3(c.x, c.y, c.z)) } catch (_) { b = null }
  const deny = b ? denyReason(bot, b, { ...ctx, castleClear: 'emptied' }) : 'unreadable'
  if (deny) {
    if (b) logDeny(b, deny)
    if (deny === 'below-feet' || deny === 'gravity') sidestep(bot, ctx, st, c, now, deny)
    else strike(ctx, st, c, deny, now)
    return
  }
  const tool = harvestTool(bot, b)
  if (!canHarvest(b, tool)) { blockCell(ctx, st, c, `no-tool-${name}`, now); return }
  flight(ctx, 'digInFlight', c, async (token) => {
    let win = null
    let carry = null
    try {
      win = await bot.openContainer(b)
      carry = { name, items: [], noBox: 0 }
      ctx.castleCarry = carry
      for (const it of win.containerItems()) {
        await win.withdraw(it.type, it.metadata, it.count)
        carry.items.push({ name: it.name, type: it.type, count: it.count })
      }
      if (win.containerItems().length) throw new Error('pack full')
      // A slot for the dug box itself, or it lies on the ground (revmux 01).
      const inv = bot.inventory
      if (typeof inv.emptySlotCount === 'function' && inv.emptySlotCount() < 1 &&
        !inv.items().some((it) => it.name === name && it.count < 64)) throw new Error('no slot for the box')
      win.close()
      win = null
      if (tool) await bot.equip(tool, 'hand')
      await bot.dig(b)
      carry.items.push({ name, count: 1, box: true })
      console.log(`castle relocate ${c.x} ${c.y} ${c.z} ${name}: carrying ${carry.items.length - 1} stacks`)
      if (live(ctx, token)) {
        ctx.castleFails = null
        ctx.castlePickup = { x: c.x, y: c.y, z: c.z, ticks: 0 }
      }
    } catch (_) {
      // Not dug: everything goes back into the box it came from.
      try {
        if (carry && carry.items.length) {
          if (!win) win = await bot.openContainer(b)
          while (carry.items.length) {
            const it = carry.items[carry.items.length - 1]
            await win.deposit(it.type, null, it.count)
            carry.items.pop()
          }
        }
      } catch (_) { /* what did not go back stays carried, stow puts it down */ }
      if (carry && !carry.items.length && ctx.castleCarry === carry) ctx.castleCarry = null
      if (live(ctx, token)) blockCell(ctx, st, c, `kept-${name}`, Date.now())
    } finally {
      try { if (win) win.close() } catch (_) { /* closed */ }
    }
  })
}

// Door path (vmzq.40): the entrance's way out to the nearest site edge
// and 4 beyond, 2 to either side. Storage never sits on it (vmzq.39).
function onDoorPath(st, x, z) {
  try {
    const { w, d } = blueprint.siteDimensions(st.rot | 0, st.blueprintVersion)
    const { x: sx, z: sz } = st.site
    const ent = entrance(st)
    const [reach, ox, oz] = [[ent.x - sx + 1, -1, 0], [sx + w - ent.x, 1, 0], [ent.z - sz + 1, 0, -1], [sz + d - ent.z, 0, 1]]
      .sort((a, b) => a[0] - b[0])[0]
    const along = (x - ent.x) * ox + (z - ent.z) * oz
    const lat = ox ? Math.abs(z - ent.z) : Math.abs(x - ent.x)
    return along >= 0 && along <= reach + 4 && lat <= 2
  } catch (_) {
    return false
  }
}
// Stow spot (vmzq.40): the nearest standable air cell 2..5 out of the site
// box, off the door path. Air above too: a chest lid needs it.
function stowSpot(bot, st, bad) {
  const bp = bodyPos(bot)
  if (!bp) return null
  const { w, d } = blueprint.siteDimensions(st.rot | 0, st.blueprintVersion)
  const { x: sx, y: sy, z: sz } = st.site
  const onPath = (x, z) => onDoorPath(st, x, z)
  const y0 = Math.max(Math.floor(bp.y), sy)
  let best = null
  for (let r = 2; r <= 5; r++) {
    for (let x = sx - r; x <= sx + w - 1 + r; x++) {
      for (let z = sz - r; z <= sz + d - 1 + r; z++) {
        if (x > sx - r && x < sx + w - 1 + r && z > sz - r && z < sz + d - 1 + r) continue // ring r only
        if (onPath(x, z)) continue
        for (let y = y0 - 2; y <= y0 + 2; y++) {
          if (!AIR.has(nameAt(bot, { x, y, z })) || !AIR.has(nameAt(bot, { x, y: y + 1, z }))) continue
          let below = null
          try { below = bot.blockAt(new Vec3(x, y - 1, z)) } catch (_) { below = null }
          // An interactive support opens its GUI on the place click (vmzq.27).
          if (!below || below.boundingBox !== 'block' || flat.isLiquidName(below.name) || isInteractRef(below.name)) continue
          if (bad && bad.has(`${x},${y},${z}`)) continue
          const dist = Math.hypot(x + 0.5 - bp.x, y - bp.y, z + 0.5 - bp.z)
          if (!best || dist < best.dist) best = { x, y, z, dist }
        }
      }
    }
    if (best) return { x: best.x, y: best.y, z: best.z }
  }
  return null
}

// Put the carried box down (vmzq.40): owns the tick while it walks/places.
// When it cannot (the drop was never picked up, no spot, 9 failed puts)
// the carry ends: the contents stay in the pack — kept, not put back —
// and are ordinary pack items from then on (a stuck reserve would stall
// the castle on material it holds, revmux 01).
const STOW_FAILS = 3
function stow(bot, ctx, st, now) {
  const cr = ctx.castleCarry
  const giveUp = (why) => {
    if (ctx.castleCarry === cr) ctx.castleCarry = null
    try { bot.chat(`castle: ${why} the ${cr.name}, keeping its contents in my pack`) } catch (_) { /* chat best-effort */ }
  }
  let box = null
  try {
    const inv = bot.inventory.items() || []
    box = inv.find((it) => it && it.name === cr.name) || inv.find((it) => it && RELOCATE.test(it.name))
  } catch (_) { box = null }
  // pickup() ran first and is over; the server's pickup may lag a tick or two.
  // A box already standing at the spot (placed, deposit failed) still counts.
  const placed = cr.at && RELOCATE.test(nameAt(bot, cr.at) || '')
  if (!box && !placed) { if (++cr.noBox > STOW_FAILS) giveUp('lost the drop of'); return false }
  if (!cr.bad) cr.bad = new Set()
  if (!cr.at) cr.at = stowSpot(bot, st, cr.bad)
  if (!cr.at) { giveUp('no spot outside for'); return false }
  const c = { idx: 'stow', kind: 'stow', ...cr.at }
  const p = new Vec3(c.x, c.y, c.z)
  if (approach(bot, ctx, c, () => new goals.GoalPlaceBlock(p, bot.world, { range: build.PLACE_RANGE }))) return true
  let moving = false
  try { moving = bot.pathfinder.isMoving() } catch (_) { /* treat as arrived */ }
  if (moving) return true
  const fail = () => {
    cr.fails = (cr.fails || 0) + 1
    ctx.castleGoalIdx = -1
    if (cr.fails % STOW_FAILS === 0 && cr.at) { cr.bad.add(`${cr.at.x},${cr.at.y},${cr.at.z}`); cr.at = null } // try another spot
    if (cr.fails >= STOW_FAILS * 3) giveUp('could not put down')
  }
  const bp = bodyPos(bot)
  if (!bp || Math.hypot(bp.x - (c.x + 0.5), (bp.y + 1.6) - (c.y + 0.5), bp.z - (c.z + 0.5)) > build.PLACE_REACH) { fail(); return true }
  flight(ctx, 'placeInFlight', c, async () => {
    let win = null
    try {
      if (!RELOCATE.test(nameAt(bot, c) || '')) {
        const below = bot.blockAt(new Vec3(c.x, c.y - 1, c.z))
        await bot.equip(box, 'hand')
        await bot.placeBlock(below, new Vec3(0, 1, 0))
      }
      win = await bot.openContainer(bot.blockAt(p))
      for (const it of cr.items.slice()) {
        if (it.box) continue
        // What the pack still holds of it: a stack spent meanwhile must not
        // block the rest on every retry.
        let have = 0
        for (const s of bot.inventory.items() || []) if (s && s.type === it.type) have += s.count
        if (Math.min(have, it.count) > 0) await win.deposit(it.type, null, Math.min(have, it.count))
        cr.items.splice(cr.items.indexOf(it), 1)
      }
      if (ctx.castleCarry === cr) ctx.castleCarry = null
      try { bot.chat(`castle: moved the ${cr.name} out of the castle to ${c.x} ${c.y} ${c.z}, contents kept`) } catch (_) { /* chat best-effort */ }
    } catch (_) {
      fail()
    } finally {
      try { if (win) win.close() } catch (_) { /* closed */ }
    }
  })
  return true
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
// Far walk (vmzq.17): work() failed no-<kind> on the empty kit before
// approach(), so a step 500 blocks off never walked to the site. Past this
// range a material-short cell walks to itself (running, never failed); on
// site it fails and castlefetch fetches.
const SITE_WALK_DIST = 32
// XZ distance from the body to the site footprint (0 on it), null unknown.
// Also the task clock's far-walk progress signal (vmzq.35).
function siteDist(bot, st) {
  const bp = bodyPos(bot)
  if (!bp || !st || !st.site) return null
  const { w, d } = blueprint.siteDimensions(st.rot | 0, st.blueprintVersion)
  return Math.hypot(Math.max(st.site.x - bp.x, 0, bp.x - (st.site.x + w)), Math.max(st.site.z - bp.z, 0, bp.z - (st.site.z + d)))
}
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
        if (!(dx >= 0 && dx < w && dz >= 0 && dz < d)) return 0
        if (dy >= 0 && dy <= SITE_TOP) return 100
        // Moat pits (vmzq.54): dig cells sit below the site level, so the
        // band above missed them and A* towered dirt back into the pit it
        // climbed out of (prod livelock 1613/1722). 100 vetoes the tower
        // (getMoveUp drops cost > 100); a step place is a cost only.
        const c = blueprint.absPlan(st.site, st.rot, st.blueprintVersion).at.get(`${q.x},${q.y},${q.z}`)
        return c && c.kind === 'dig' ? 100 : 0
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
  // Far walk (vmzq.17): material sourcing is g0z.4, but a far step walks
  // to the cell (running) instead of failing at once — prod run2 failed
  // 500 blocks off and never approached. On site a short kit fails and
  // castlefetch fetches. Unloaded goals ignore y: with stone in hand too
  // (vmzq.29) — a GoalPlaceBlock into unloaded chunks 500 blocks off
  // climbed toward castle height from y 36 and wedged.
  try {
    // Measured to the footprint, not the cell (revmux 01): on site a
    // cross-corner cell (~41 off on v2) never flips to the XZ walk.
    const sd = siteDist(bot, st)
    if (sd != null && sd > SITE_WALK_DIST) {
      st.status = 'walking to the site'
      // Re-issue after a clear (revmux 01 core-1): approach() only
      // re-arms on a new idx or a foreign goal — a goal cleared to
      // null (recover, night break) would otherwise strand the step
      // running with the bot standing still.
      try { if (bot.pathfinder.goal == null && !bot.pathfinder.isMoving()) ctx.castleGoalIdx = -1 } catch (_) { /* latch best-effort */ }
      // Own latch key: inside the range placeCell/digCell re-arm their
      // own goal for the same cell instead of inheriting the XZ walk.
      approach(bot, ctx, { idx: `far:${c.idx}` }, () => new goals.GoalNearXZ(c.x, c.z, 8))
      return
    }
  } catch (_) { /* walk best-effort: fall through to the cell */ }
  let item = null
  if (!clearing(c)) {
    item = c.prep === 'fill' ? fillItem(bot, ctx) : findItem(bot, c.kind, ctx)
    if (!item) {
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

// A searched site (g0z.19) is announced again once the body stands on it.
function arrive(bot, st) {
  const bp = bodyPos(bot)
  const { w, d } = blueprint.siteDimensions(st.rot | 0, st.blueprintVersion)
  if (!bp || Math.hypot(bp.x - (st.site.x + w / 2), bp.z - (st.site.z + d / 2)) > Math.max(w, d) / 2) return
  st.announce = false
  const n = blueprint.blueprintOf(st.blueprintVersion).PLAN.filter((c) => blueprint.isPlaceTarget(c.kind)).length
  try { bot.chat(`building the castle here at ${st.site.x} ${st.site.y} ${st.site.z} (~${n} blocks)`) } catch (_) { /* chat best-effort */ }
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
  if (st.announce) arrive(bot, st)
  if (ctx.castlePickup && pickup(bot, ctx)) return
  if (ctx.castleCarry && stow(bot, ctx, st, now)) return
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
  // Holes ride along on every pick (vmzq.27): building past them or waiting
  // on them, one shared line (sayHoles) that re-chats only on a new hole.
  const holes = holesOf(bot, st, cells)
  sayHoles(bot, ctx, st, holes, now)
  // Unloaded site (vmzq.29): null blocks read as undone, so a far respawn
  // read 0/1722 and the walk back counted as fresh progress. Off-site the
  // last value stands (as in menuFact).
  if (ctx.castleScanAt !== fullBefore && siteLoaded(bot, st)) progress(bot, st, cells, ctx)
  if (r.idx < 0) {
    if (r.waiting) {
      // Every remaining cell is waiting out a backoff (or owed): the holes
      // line above says which; the step fails so the body does side work
      // until a retry comes due. A waiting dig with no hole is held by
      // interior work (never by a backoff), so it keeps its own status.
      if (!holes.length) st.status = `waiting on ${r.waiting.x} ${r.waiting.y} ${r.waiting.z} (${r.waiting.kind})`
      ctx.stepStatus = 'failed:blocked'
      return
    }
    if (st.phase !== 'complete') {
      const lit = litterTargets(bot, ctx, st, now).find((o) => !(st.blocked[bkey(st, o.idx)] && st.blocked[bkey(st, o.idx)].until > now))
      if (lit) { work(bot, ctx, st, lit, now, 'clearing scaffold'); return }
    }
    // Holes stay on the status past completion (sayHoles set it above),
    // so 'castle' keeps reporting the gaps, not just 'complete'.
    if (!holes.length) st.status = 'complete'
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
module.exports.holesOf = holesOf
module.exports.sayHoles = sayHoles
module.exports.MAX_HOLE_TRIES = MAX_HOLE_TRIES
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
module.exports.siteEval = siteEval
module.exports.facing = facing
module.exports.startSiteSearch = startSiteSearch
module.exports.stepSiteSearch = stepSiteSearch
module.exports.SEARCH_RADIUS = SEARCH_RADIUS
module.exports.SEARCH_SCANS = SEARCH_SCANS
module.exports.EARTH_BUDGET = EARTH_BUDGET
module.exports.progressByKind = progressByKind
module.exports.usable = usable
module.exports.findItem = findItem
module.exports.fillItem = fillItem
module.exports.dirtOnHand = dirtOnHand
module.exports.SHELTER_RESERVE = SHELTER_RESERVE
module.exports.held = held
module.exports.reserveOf = reserveOf
module.exports.BATCH = BATCH
module.exports.BATCH_OF = BATCH_OF
module.exports.batchOf = batchOf
module.exports.entrance = entrance
module.exports.SITE_WALK_DIST = SITE_WALK_DIST
module.exports.siteLoaded = siteLoaded
module.exports.siteDist = siteDist
// Task executive (vmzq.2): prep remaining for the stall clock (cached 30 s).
module.exports.prepTargets = prepTargets
// Site storage (vmzq.39): stockpile reuses the stow ring and the door path.
module.exports.stowSpot = stowSpot
module.exports.onDoorPath = onDoorPath
