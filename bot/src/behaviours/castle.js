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

const ITEM = {
  stone: (n) => n === 'cobblestone' || n === 'stone',
  planks: (n) => n.endsWith('_planks'),
  door: (n) => n.endsWith('_door') && n !== 'iron_door', // iron needs redstone
  torch: (n) => n === 'torch',
}

function findItem(bot, kind) {
  const want = ITEM[kind]
  if (!want) return null
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

// Next cell to work in plan order, or why there is none.
function pick(bot, ctx, st, cells, key, now) {
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
    for (let i = full ? 0 : (ctx.castleCursor | 0); i < cells.length; i++) {
      const c = cells[i]
      if (clearing(c) && complete) continue
      if (done(bot, c)) continue
      if (first < 0) first = i
      const b = st.blocked[bkey(i)]
      if (b && b.until > now) { waiting = waiting || c; continue }
      if (!clearing(c) && c.dy > gateDy) { waiting = waiting || c; break }
      ctx.castleCursor = first
      return { idx: i }
    }
    ctx.castleCursor = first < 0 ? cells.length : first
    if (first < 0 && !full) { full = true; continue } // confirm "all done" from 0
    return { idx: -1, waiting }
  }
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
function sidestep(bot, ctx, st, c, now) {
  const so = ctx.castleSelfOcc && ctx.castleSelfOcc.idx === c.idx ? ctx.castleSelfOcc : { idx: c.idx, n: 0 }
  so.n++
  ctx.castleSelfOcc = so
  if (so.n > flat.SELF_OCC_LIMIT) { blockCell(ctx, st, c, 'occupied', now); return }
  const bp = bodyPos(bot)
  const s = SIDESTEPS[so.n % SIDESTEPS.length]
  try { if (bp) bot.pathfinder.setGoal(new goals.GoalNear(bp.x + s[0], bp.y, bp.z + s[1], 1)) } catch (_) { /* retry next tick */ }
}

// Out of reach after the approach ended: re-approach; only a stand that
// stops getting closer strikes (build revmux 01 major: long walks cross
// idle ticks between A* segments).
function far(ctx, st, c, dist, now) {
  const f = ctx.castleFar
  const closer = f && f.idx === c.idx && dist < f.dist - build.CELL_PROGRESS
  ctx.castleFar = { idx: c.idx, dist }
  ctx.castleGoalIdx = -1
  if (!closer) strike(ctx, st, c, 'unreachable', now)
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
  if (ctx.castleGoalIdx !== c.idx) {
    ctx.castleGoalIdx = c.idx
    try { bot.pathfinder.setGoal(new goals.GoalPlaceBlock(p, bot.world, { range: build.PLACE_RANGE })) } catch (_) { /* retry next tick */ }
    return
  }
  let moving = false
  try { moving = bot.pathfinder.isMoving() } catch (_) { /* treat as arrived */ }
  if (moving) return
  if (flat.cellOccupiedSelf(bot, c.x, c.y, c.z)) { sidestep(bot, ctx, st, c, now); return }
  if (flat.cellOccupiedByPlayer(bot, c.x, c.y, c.z)) { strike(ctx, st, c, 'occupied', now); return }
  const bp = bodyPos(bot)
  if (bp) {
    const d = Math.hypot(bp.x - (c.x + 0.5), (bp.y + 1.6) - (c.y + 0.5), bp.z - (c.z + 0.5))
    if (d > build.PLACE_REACH) { far(ctx, st, c, d, now); return }
  }
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
      if (occ && build.isReplaceable(occ)) {
        let b = null
        try { b = bot.blockAt(p) } catch (_) { b = null }
        const deny = b && denyReason(bot, b, ctx)
        if (deny) logDeny(b, deny)
        else {
          try {
            await bot.dig(b)
            await bot.equip(item, 'hand')
            await bot.placeBlock(ref.ref, ref.face)
            ctx.castleFails = null
            return
          } catch (_) { /* counts as a refusal */ }
        }
      }
      if (live(ctx, token)) strike(ctx, st, c, occ || 'refused', Date.now())
    }
  })
}

// Planned air/dig cell holding something: natural terrain or flora only
// (flat allowlist + build REPLACEABLE), never under anyone's feet, and
// the shared denyReason gates (trap, gravity, submerged, protected).
function digCell(bot, ctx, st, c, now) {
  const name = nameAt(bot, c)
  if (flat.isLiquidName(name)) { blockCell(ctx, st, c, 'liquid', now); return }
  if (!flat.isDiggable(name) && !build.isReplaceable(name)) { blockCell(ctx, st, c, `kept-${name}`, now); return }
  if (ctx.castleGoalIdx !== c.idx) {
    ctx.castleGoalIdx = c.idx
    try { bot.pathfinder.setGoal(new goals.GoalNear(c.x, c.y, c.z, DIG_APPROACH)) } catch (_) { /* retry next tick */ }
    return
  }
  let moving = false
  try { moving = bot.pathfinder.isMoving() } catch (_) { /* treat as arrived */ }
  if (moving) return
  if (flat.threatenedByPlayer(bot, c.x, c.y, c.z)) { strike(ctx, st, c, 'occupied', now); return }
  if (flat.threatenedSelf(bot, c.x, c.y, c.z)) { sidestep(bot, ctx, st, c, now); return }
  const bp = bodyPos(bot)
  if (bp) {
    const d = Math.hypot(bp.x - (c.x + 0.5), (bp.y + 1.6) - (c.y + 0.5), bp.z - (c.z + 0.5))
    if (d > flat.REACH_DIG) { far(ctx, st, c, d, now); return }
  }
  let b = null
  try { b = bot.blockAt(new Vec3(c.x, c.y, c.z)) } catch (_) { b = null }
  const deny = b ? denyReason(bot, b, ctx) : 'unreadable'
  if (deny) {
    if (b) logDeny(b, deny)
    strike(ctx, st, c, deny, now)
    return
  }
  flight(ctx, 'digInFlight', c, async (token) => {
    try {
      await bot.dig(b)
      if (live(ctx, token)) ctx.castleFails = null
    } catch (_) {
      if (live(ctx, token) && !done(bot, c)) strike(ctx, st, c, 'dig-refused', Date.now())
    }
  })
}

// Castle guard for the pathfinder (every executor): laid castle blocks are
// never break candidates. Reads ctx.castle live, so a site change or a
// cleared order needs no re-key; re-installed when Movements is replaced.
function guardCastle(bot, ctx) {
  try {
    const mov = bot && bot.pathfinder && bot.pathfinder.movements
    if (!ctx || !ctx.castle || !mov || !Array.isArray(mov.exclusionAreasBreak)) return
    if (ctx.castleGuardMov === mov && mov.exclusionAreasBreak.includes(ctx.castleGuardFn)) return
    const prev = ctx.castleGuardMov
    if (prev && Array.isArray(prev.exclusionAreasBreak)) {
      prev.exclusionAreasBreak = prev.exclusionAreasBreak.filter((f) => f !== ctx.castleGuardFn)
    }
    const fn = (block) => {
      try {
        return ctx.castle && block && blueprint.protects(ctx.castle, block.position, block.name) ? 100 : 0
      } catch (_) { return 0 }
    }
    mov.exclusionAreasBreak.push(fn)
    ctx.castleGuardFn = fn
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
  if (item) placeCell(bot, ctx, st, c, item, now)
  else digCell(bot, ctx, st, c, now)
}

module.exports = castle
module.exports.guardCastle = guardCastle
module.exports.backoffMs = backoffMs
module.exports.STRIKES = STRIKES
module.exports.FULL_RESCAN_MS = FULL_RESCAN_MS
