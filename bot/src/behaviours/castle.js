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
const { denyReason, logDeny } = require('./util')

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
function usable(bot, kind) {
  const want = ITEM[kind]
  if (!want) return 0
  let n = 0
  try {
    for (const it of bot.inventory.items() || []) {
      if (it && typeof it.name === 'string' && want(it.name)) n += typeof it.count === 'number' ? it.count : 1
    }
  } catch (_) { /* no inventory: none */ }
  return Math.max(0, n - reserveOf(kind))
}

function findItem(bot, kind) {
  const want = ITEM[kind]
  if (!want || usable(bot, kind) <= 0) return null
  try {
    for (const it of bot.inventory.items() || []) {
      if (it && typeof it.name === 'string' && want(it.name)) return it
    }
  } catch (_) { /* no inventory: no item */ }
  return null
}

function nameAt(bot, c) {
  try {
    const b = bot.blockAt(new Vec3(c.x, c.y, c.z))
    return b && typeof b.name === 'string' ? b.name : null
  } catch (_) { return null }
}

// Entrance apron stance (blueprint ENTRANCE) in world coords for the site.
function entrance(st) {
  const e = blueprint.rotatePlan([{ ...blueprint.ENTRANCE, kind: 'air' }], st.rot | 0)[0]
  return { x: st.site.x + e.dx, y: st.site.y + e.dy, z: st.site.z + e.dz }
}

function done(bot, c) { return blueprint.matches(c.kind, nameAt(bot, c)) }
function clearing(c) { return !blueprint.isPlaceTarget(c.kind) }
function bkey(idx) { return `${blueprint.BLUEPRINT_VERSION}:${idx}` }
function backoffMs(tries) { return Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** (tries - 1)) }

function bodyPos(bot) {
  const p = bot.entity && bot.entity.position
  return p && typeof p.x === 'number' ? p : null
}

function blockCell(ctx, st, c, why, now) {
  const k = bkey(c.idx)
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
// still needs the interior. Indices stay plan indices (blocked keys).
let orderCache = null
function workOrder(cells, key) {
  if (orderCache && orderCache.key === key) return orderCache.order
  const rank = (c) => (clearing(c) ? 2 : c.kind === 'door' ? 1 : 0)
  const order = cells.map((c) => c.idx).sort((a, b) => rank(cells[a]) - rank(cells[b]) || a - b)
  orderCache = { key, order }
  return order
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
    if (Number(v) !== blueprint.BLUEPRINT_VERSION || !c || done(bot, c)) { delete st.blocked[k]; continue }
    if (st.blocked[k].until > now && !clearing(c)) gateDy = Math.min(gateDy, c.dy)
  }
  let full = ctx.castleScanKey !== key || now - (ctx.castleScanAt || 0) >= FULL_RESCAN_MS
  for (;;) {
    if (full) { ctx.castleScanKey = key; ctx.castleScanAt = now }
    let first = -1
    let waiting = null
    for (let i = full ? 0 : (ctx.castleCursor | 0); i < order.length; i++) {
      const c = cells[order[i]]
      if (clearing(c) && complete) continue
      if (done(bot, c)) continue
      if (first < 0) first = i
      const b = st.blocked[bkey(c.idx)]
      if (b && b.until > now) { waiting = waiting || c; continue }
      if (!clearing(c) && c.dy > gateDy) { waiting = waiting || c; break }
      ctx.castleCursor = first
      return { idx: c.idx }
    }
    ctx.castleCursor = first < 0 ? order.length : first
    if (first < 0 && !full) { full = true; continue } // confirm "all done" from 0
    return { idx: -1, waiting }
  }
}

// Read-only twin of pick() for the work arbiter (g0z.3): the next cell the
// executor would work now, or why there is none — same work order, layer
// gate and backoff, no cursor/scan/blocked-map writes. Full scan from 0.
// ponytail: O(plan) blockAt per decide; cache per tick if g0z.11's ~2000
// cells ever show in the tick timer.
function peek(bot, st, now) {
  const { cells, key } = blueprint.absPlan(st.site, st.rot)
  const blocked = st.blocked && typeof st.blocked === 'object' ? st.blocked : {}
  const complete = st.phase === 'complete'
  let gateDy = Infinity
  for (const k of Object.keys(blocked)) {
    const [v, i] = k.split(':')
    const c = cells[Number(i)]
    if (Number(v) !== blueprint.BLUEPRINT_VERSION || !c || !blocked[k] || done(bot, c)) continue
    if (blocked[k].until > now && !clearing(c)) gateDy = Math.min(gateDy, c.dy)
  }
  let waiting = null
  for (const idx of workOrder(cells, key)) {
    const c = cells[idx]
    if (clearing(c) && complete) continue
    if (done(bot, c)) continue
    const b = blocked[bkey(c.idx)]
    if (b && b.until > now) { waiting = waiting || c; continue }
    if (!clearing(c) && c.dy > gateDy) return { cell: null, waiting: waiting || c, cells }
    return { cell: c, waiting: null, cells }
  }
  return { cell: null, waiting, cells }
}

// Batch gate (build precedent): a castle leg starts with BATCH of the next
// kind on hand, or the whole remainder of that kind when less is left.
const BATCH = 16

// The castle word for the goal facts text (g0z.3): 'none' | 'parked' |
// 'done' | 'blocked' | 'clear' (next cell is a keep-clear dig, no
// material) | '<kind>-<none|some|batch>' (the next cell's material on
// hand, above the reserve). Restock, stop/go, completion and a demand-kind
// change all move the word, so holds keyed on the text release on them.
function menuFact(bot, ctx, now = Date.now()) {
  const st = ctx && ctx.castle
  if (!st || !st.site || typeof st.site.x !== 'number') return 'none'
  if (st.parked) return 'parked'
  try {
    const r = peek(bot, st, now)
    if (!r.cell) return r.waiting ? 'blocked' : 'done'
    const c = r.cell
    if (clearing(c)) return 'clear'
    const have = usable(bot, c.kind)
    if (have <= 0) return `${c.kind}-none`
    if (have >= BATCH) return `${c.kind}-batch`
    let left = 0
    for (const o of r.cells) {
      if (o.kind === c.kind && !done(bot, o)) left++
    }
    return have >= left ? `${c.kind}-batch` : `${c.kind}-some`
  } catch (_) {
    return 'none'
  }
}

// Owner-facing progress (chat 'castle'): laid/total per material kind,
// read live from the world (blocked never counts as done).
function progressByKind(bot, st) {
  const out = {}
  for (const c of blueprint.absPlan(st.site, st.rot).cells) {
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
  ctx.castleFlight = { token, kind, idx: c.idx, since: Date.now() }
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
      if (blueprint.matches(c.kind, occ)) { ctx.castleFails = null; return } // landed anyway
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
  if (!ours && !flat.isDiggable(name) && !build.isReplaceable(name)) { blockCell(ctx, st, c, `kept-${name}`, now); return }
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
      await bot.dig(b)
      if (live(ctx, token)) ctx.castleFails = null
    } catch (_) {
      if (live(ctx, token) && nameAt(bot, c) !== 'air') strike(ctx, st, c, 'dig-refused', Date.now())
    }
  })
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
        return ctx.castle && block && blueprint.protects(ctx.castle, block.position, block.name) ? 100 : 0
      } catch (_) { return 0 }
    }
    const placeFn = (block) => {
      try {
        const st = ctx.castle
        const q = block && block.position
        if (!st || !st.site || !q) return 0
        const { w, d } = blueprint.siteDimensions(st.rot | 0)
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
    const c = blueprint.absPlan(st.site, st.rot).cells[fl.idx]
    if (c) strike(ctx, st, c, 'flight-hang', now)
  }
  if (ctx.placeInFlight || ctx.digInFlight) return
  guardCastle(bot, ctx)
  const { cells, key } = blueprint.absPlan(st.site, st.rot)
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
    st.status = 'complete'
    ctx.stepStatus = 'done'
    if (st.phase !== 'complete') {
      st.phase = 'complete'
      try { bot.chat(`castle done at ${st.site.x} ${st.site.y} ${st.site.z}`) } catch (_) { /* chat best-effort */ }
    }
    return
  }
  const c = cells[r.idx]
  let item = null
  if (!clearing(c)) {
    item = findItem(bot, c.kind)
    if (!item) {
      // Material sourcing is g0z.4: report before walking anywhere.
      st.status = `need ${c.kind}`
      ctx.stepStatus = `failed:no-${c.kind}`
      return
    }
  }
  st.status = 'building'
  const over = overBudget(bot, ctx, c.idx)
  if (over) { blockCell(ctx, st, c, over, now); return }
  const occ = nameAt(bot, c)
  const open = occ == null || AIR.has(occ) || occ === 'water'
  if (item && open) placeCell(bot, ctx, st, c, item, now)
  else digCell(bot, ctx, st, c, now)
}

module.exports = castle
module.exports.guardCastle = guardCastle
module.exports.backoffMs = backoffMs
module.exports.STRIKES = STRIKES
module.exports.FULL_RESCAN_MS = FULL_RESCAN_MS
module.exports.isMaterial = (name) => typeof name === 'string' && Object.values(ITEM).some((want) => want(name))
module.exports.menuFact = menuFact
module.exports.progressByKind = progressByKind
module.exports.usable = usable
module.exports.BATCH = BATCH
