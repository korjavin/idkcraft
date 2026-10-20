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
const { SCAFFOLD_LOW } = require('../budget') // oqul.11: was a deferred equip.js read
const build = require('./build')
const flat = require('./flat')
const { denyReason, logDeny, NATURAL_SOLID, castleProtects, castleClears, RELOCATE, isInteractRef, yardDigBan, isOwnPlaced } = require('./util')
const { stepFailed, stepGen, failReason } = require('../step')
const worker = require('../worker')

const STRIKES = 3
const BACKOFF_BASE_MS = 30000
const BACKOFF_MAX_MS = 600000
// ponytail: the scan resumes from a cursor (the first undone cell); a full
// rescan from 0 every 30 s repairs cells mobs/players broke below it.
const FULL_RESCAN_MS = 30000
const CASTLE_AWAY_MS = 5 * 60 * 1000 // idkcraft-akze: no scan for this long = the bot was away (unloaded); the high-water re-baselines on return instead of logging the away knock as regress
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
  stairs: (n) => n.endsWith('_stairs'), // v3 steps (g0z.47): one material, cobble stairs
  pane: (n) => blueprint.matches('pane', n), // g0z.31 decor: window panes (chest-supplied)
  banner: (n) => blueprint.matches('banner', n), // g0z.32 decor: gate banners (chest-only, never crafted)
  bookshelf: (n) => blueprint.matches('bookshelf', n), // g0z.49 decor: attic shelves (chest books, crafted)
  enchanting_table: (n) => blueprint.matches('enchanting_table', n), // g0z.49 decor: attic table (chest-only, never crafted)
  blast_furnace: (n) => blueprint.matches('blast_furnace', n), // g0z.50 decor: kitchen blast furnace (chest, else crafted)
  gate: (n) => blueprint.matches('gate', n), // g0z.46 decor: the fence-ring gate (chest, else crafted from wood)
}

// Project-material reservation (g0z.3 design): the castle never lays the
// bot's scaffold/tool stone (equip's SCAFFOLD_LOW mark — below it equip
// would dig the same blocks back) nor the last planks a stick craft needs.
// Walk buffer (idkcraft-vmzq.31, revmux 02 core-1): the stone reserve is
// one shelter pillar over the equip trigger — past the dirt shield (dirt
// at zero) the walks spend the buffer before the kit reads empty, and
// below-16 equip refills. SCAFFOLD_LOW comes from budget.js (oqul.11)
// (SHELTER_RESERVE below is module-local, read at call
// time, so the forward reference is safe).
function reserveOf(kind) {
  if (kind === 'stone') {
    try { return SCAFFOLD_LOW + SHELTER_RESERVE } catch (_) { return 24 }
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

// Item -> material kind (g0z.45: the stockpile's generic decor keep): the
// first ITEM matcher that takes the name, or null.
function kindOf(name) {
  if (typeof name !== 'string') return null
  for (const kind of Object.keys(ITEM)) {
    try { if (ITEM[kind](name)) return kind } catch (_) { /* next */ }
  }
  return null
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

// Block state sibling of nameAt (g0z.47 stairs): name plus the facing/half
// the stair verification needs. Null when the cell is unreadable.
function stateAt(bot, c) {
  try {
    const b = bot.blockAt(new Vec3(c.x, c.y, c.z))
    if (!b || typeof b.name !== 'string') return null
    let props = null
    try { props = typeof b.getProperties === 'function' ? b.getProperties() : null } catch (_) { props = null }
    return { name: b.name, facing: props && props.facing, half: props && props.half }
  } catch (_) { return null }
}

// Entrance apron stance (blueprint ENTRANCE) in world coords for the site.
function entrance(st) {
  const bp = blueprint.blueprintOf(st.blueprintVersion)
  const e = blueprint.rotatePlan([{ ...bp.ENTRANCE, kind: 'air' }], st.rot | 0, bp.version)[0]
  return { x: st.site.x + e.dx, y: st.site.y + e.dy, z: st.site.z + e.dz }
}

// Door sill (idkcraft-lqgo, the house z591 rule): on the v2 body the block
// under the gate door is never natural ground. groundCell guards that dirt
// from the v1 pathfinder only — Baritone break bans are names (body.js
// castle guard), and a v2 mining leg broke it from below: the door popped.
// Off-plan (the PLAN stays frozen), idx SILL_IDX: a natural sill (laid rock
// excepted, build.SILL_KEEP — it is banned too) or a hole is swapped for
// planks, which v2 hard-bans; the door pops once and is re-laid. It goes
// ahead of the picked plan cell once planks are on hand, the door is next
// or the castle is complete (sillFirst), so a fresh build never fetches
// planks ahead of its stone. Per-cell path only (never the builder batch).
const SILL_IDX = 4000000
function sillOf(st) {
  const bp = blueprint.blueprintOf(st.blueprintVersion)
  const d = blueprint.rotatePlan([{ ...bp.DOOR, kind: 'door' }], st.rot | 0, bp.version)[0]
  return { x: st.site.x + d.dx, y: st.site.y + d.dy - 1, z: st.site.z + d.dz, kind: 'planks', dy: d.dy - 1, idx: SILL_IDX, sill: true }
}
function sillFirst(bot, ctx, st, next, now) {
  if (process.env.BOT_BODY !== 'baritone' || st.phase === 'prep') return null
  const c = sillOf(st)
  const n = nameAt(bot, c)
  if (n == null || done(bot, c)) return null // unreadable: never owed off site
  const b = (st.blocked || {})[bkey(st, c.idx)]
  if (b && (b.retired || b.until > now)) return null
  return st.phase === 'complete' || !next || next.kind === 'door' || usable(bot, 'planks', ctx) > 0 ? c : null
}

function done(bot, c) {
  if (c.prep) return prepDone(bot, c)
  if (c.sill) {
    const n = nameAt(bot, c)
    return n != null && !AIR.has(n) && n !== 'water' && !build.isReplaceable(n) && !(NATURAL_SOLID.has(n) && !build.SILL_KEEP.has(n))
  }
  if (c.kind === 'stairs' && c.face) {
    const st = stateAt(bot, c)
    if (!st || !blueprint.matches('stairs', st.name)) return false
    return st.facing === blueprint.faceName(c.face) && st.half === 'bottom'
  }
  return blueprint.matches(c.kind, nameAt(bot, c))
}
function clearing(c) { return !blueprint.isPlaceTarget(c.kind) }
// Gauge cells (vmzq.55): place cells plus the moat 'dig' cells, so the
// task clock sees digging. Keep-clear 'air' cells stay out (they start
// done; counting them only inflates).
function gauged(c) { return !clearing(c) || c.kind === 'dig' }
function ver(st) { return blueprint.blueprintOf(st && st.blueprintVersion).version }
function bkey(st, idx) { return `${ver(st)}:${idx}` }
function backoffMs(tries) { return Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** (tries - 1)) }
// Bounded retry (vmzq.27 revmux 01): after this many blocks the hole
// retires — still listed by holesOf, never picked or waited on — so a
// permanent hole (protected log, kept chest) finishes as a reported gap
// instead of holding the moat and 'complete' forever. ~35 min of rare
// retries first (backoffs 30s..600s), covering a play session in which the
// owner might clear the cell. Rebuild (cancel + build) un-retires.
// Bounded retry (vmzq.27 revmux 01): after this many blocks the hole
// (see blockCell) retires.
const MAX_HOLE_TRIES = 8
// Builder refusals (idkcraft-synq, revmux 01 core-3): a 'build-miss' block
// means Baritone refused the cell in STRIKES consecutive batches with
// material on hand on the layer it was laying (strikeMisses). There is
// nothing a retry would heal that three refusals did not already test, so
// the cell retires on its first block — one build-miss line ever, still
// reported by holesOf/sayHoles; a rebuild (cancel + build) un-retires.
// 'build-miss-wide' is the batch-wide wedge fallback (revmux 03): not
// cell-specific, so it rides the ordinary 8-try ladder instead.
const BUILD_MISS_TRIES = 1
// A strike set bigger than this is a batch-wide wedge, not cell-specific
// evidence (revmux 03 core-1) — a wedged body refuses every cell alike.
const STRIKE_WIDE_CAP = 8

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
  // hole — still reported, never picked or waited on again. Builder
  // refusals retire faster (idkcraft-synq BUILD_MISS_TRIES above).
  if (e.tries >= (why === 'build-miss' ? BUILD_MISS_TRIES : MAX_HOLE_TRIES)) e.retired = true
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

// Nearest-first (neuc.57): the plan pairs opposite walls ([x,7],[x,19]),
// so plan order alone shuttles the bot across the castle per block. From
// the work-order cell at order[i], scan the rest of its run — same y, same
// rank, the next NEAR_WINDOW undone cells — and take the workable cell
// nearest the body. Workable = what pick() would take (no active/retired
// hole, torch on hand) plus, for a place cell, its material on hand (an
// unheld kind never pulls a fetch leg ahead of held work; none held keeps
// the plan cell, so the word is unchanged) and a laid neighbour to click
// (lay()'s support rule, read from the world). A run never crosses a y or
// rank change, so storey order (reach invariant), door deferral and the
// moat/fence ranks stand. Sticky: the last pick (keepIdx) keeps winning
// while it stays workable in the run, so the target never flaps mid-walk.
// Cells the body occupies never win (c0 stays the fallback).
// ponytail: up to ~7 blockAt per window cell per pick; shrink the window
// if it shows in the tick timer.
const NEAR_WINDOW = 64
const NEIGH6 = [[0, -1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0]]
function supported(bot, c) {
  return NEIGH6.some(([a, b, d]) => {
    try {
      const k = bot.blockAt(new Vec3(c.x + a, c.y + b, c.z + d))
      return !!k && !AIR.has(k.name) && k.boundingBox !== 'empty'
    } catch (_) { return false }
  })
}
function nearest(bot, ctx, st, cells, order, i, now) {
  const c0 = cells[order[i]]
  const p = bodyPos(bot)
  const keepIdx = ctx && ctx.castleNearIdx
  if (!p || c0.idx === keepIdx) return c0
  const blocked = st.blocked || {}
  const held = (c) => clearing(c) || usable(bot, c.kind, ctx) > 0
  const d2 = (c) => (c.x + 0.5 - p.x) ** 2 + (c.y + 0.5 - p.y) ** 2 + (c.z + 0.5 - p.z) ** 2
  let best = held(c0) ? c0 : null
  let bd = best ? d2(c0) : Infinity
  for (let j = i + 1, seen = 0; j < order.length && seen < NEAR_WINDOW; j++) {
    const c = cells[order[j]]
    if (c.y !== c0.y || rank(c) !== rank(c0)) break
    if (done(bot, c)) continue
    seen++
    const b = blocked[bkey(st, c.idx)]
    if (b && (b.retired || b.until > now)) continue
    if (torchOwed(bot, c, null) || !held(c)) continue
    // The cell the body stands in is the nearest by construction, and
    // every lay into it starts with a sidestep (revmux 01).
    if (flat.cellOccupiedSelf(bot, c.x, c.y, c.z)) continue
    if (!clearing(c) && !supported(bot, c)) continue
    if (c.idx === keepIdx) return c
    const d = d2(c)
    if (d < bd) { best = c; bd = d }
  }
  return best || c0
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
    const c = cells[Number(i)] || decorOf(st, Number(i)) || bandOf(st, Number(i)) || (Number(i) === SILL_IDX ? sillOf(st) : null)
    // Off-plan entries (prep, box litter) live until they expire (g0z.14);
    // decor entries (g0z.31) live until laid, so a bad pane cell retires;
    // band entries (g0z.44) live until swept, so refusals escalate to
    // retired instead of re-chasing every 30 s.
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
      // The stairs relay (g0z.48) converts place cells only: a complete
      // castle's decor sits on plan air cells (glazed panes), and the moat
      // is dug — re-clearing them would strike 44 protected panes.
      if (clearing(c) && (complete || st.upgrade)) continue
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
      const n = nearest(bot, ctx, st, cells, order, i, now)
      ctx.castleNearIdx = n.idx
      return { idx: n.idx }
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
  const r = peekPlan(bot, st, now, ctx)
  const s = sillFirst(bot, ctx, st, r.cell, now)
  return s ? { cell: s, waiting: null, cells: r.cells } : r
}
function peekPlan(bot, st, now, ctx) {
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
  const order = workOrder(cells, key)
  for (let i = 0; i < order.length; i++) {
    const c = cells[order[i]]
    // Same relay skip as pick(): the arbiter's word never reads 'clear'
    // for a glazed window mid-upgrade.
    if (clearing(c) && (complete || st.upgrade)) continue
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
    return { cell: nearest(bot, ctx, st, cells, order, i, now), waiting: null, cells }
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
// Band sweep (g0z.44) grown to the apron (g0z.61): after 'complete' the
// scan covers the site box grown by blueprint.CASTLE_APRON in x/z, dy
// -NIGHT_BAND_BELOW..SITE_TOP — the box interior (towers to windows) and
// the pillars/bridges V2, swarm helpers and respawns left around it.
// Sliced (litterSlice): the fence band first, then one x-strip of the grown
// box per call, so no tick reads the whole ~78k cells. Litter (isLitter)
// carries a scaffold name AND is own-placed in the yard ring above the
// floor, or scaffold by shape whoever placed it (owner Q1 2026-10-18).
// Panes sit on plan air cells, so the plan skip covers them; laid decor
// skips by a decor match (own scaffold in an OPEN decor cell still clears —
// it is in the decor's way). The idx strides over the grown box, unique
// across it, on its own base: band blocked entries live until swept (pick,
// below), so refusals escalate to retired instead of re-chasing every 30 s
// — box-litter entries still prune on expiry, so the two modes must not
// share idx space. The base moved from g0z.44's 2100000 with the strides:
// a persisted old entry prunes instead of decoding to another cell.
const LITTER_BAND_BASE = 2200000
const LITTER_BELOW = blueprint.NIGHT_BAND_BELOW
// Scaffold names (body.js scafoldingBlocks = dirt + castle.STONE_ITEMS;
// recover/flat pillars dirt/cobble): never grass, snow, beds, chests, doors.
const SCAFFOLD_MATS = new Set([...flat.PILLAR_MATS, ...blueprint.STONE_ITEMS])
const LITTER_PLAYER_R = 8
function blockAtXYZ(bot, x, y, z) {
  try { return bot.blockAt(new Vec3(x, y, z)) } catch (_) { return null }
}
// Bot scaffold by shape (g0z.61): a scaffold-name block that is a lone 1x1
// column cell (flat.lonePillar) or a 1-wide bridge cell (nothing solid
// below, at most one solid horizontal neighbour). Above the floor the
// castle's own plan/decor cells do not count as neighbours (a tower against
// a wall or window). Never a plan cell or laid decor. Natural ground has
// solid below and neighbours; a player's wall or path on the ground has
// solid below or 2+ neighbours. ponytail: shape decides — a player's lone
// dirt/cobble post or 1-wide sky bridge within the apron gets dug (owner
// Q1); upgrade = a persisted swarm-shared placedByBot.
function scaffoldShape(bot, ctx, b, st = ctx && ctx.castle) {
  try {
    if (!b || !b.position || !SCAFFOLD_MATS.has(b.name) || !st || !st.site) return false
    const x = Math.floor(b.position.x), y = Math.floor(b.position.y), z = Math.floor(b.position.z)
    const at = blueprint.absPlan(st.site, st.rot, st.blueprintVersion).at
    const dt = blueprint.decorPlan(st.site, st.rot, st.blueprintVersion).at
    const k = `${x},${y},${z}`
    if (at.has(k)) return false
    const dc = dt.get(k)
    if (dc && blueprint.matches(dc.kind, b.name)) return false
    const kk = (n) => `${Math.floor(n.position.x)},${Math.floor(n.position.y)},${Math.floor(n.position.z)}`
    const ignore = y >= st.site.y ? (n) => !!n.position && (at.has(kk(n)) || dt.has(kk(n))) : null
    if (flat.lonePillar(bot, ctx, x, y, z, ignore)) {
      // Free-standing: every cell above it in the column is lone scaffold
      // too (revmux 01: a doorway jamb is lone at its own height but
      // carries the lintel).
      for (let yy = y + 1; yy <= y + 24; yy++) {
        const a = blockAtXYZ(bot, x, yy, z)
        if (!a) return false
        if (!flat.isSolidCell(a)) return true
        if (!SCAFFOLD_MATS.has(a.name) || !flat.lonePillar(bot, ctx, x, yy, z, ignore)) return false
      }
      return false
    }
    const below = blockAtXYZ(bot, x, y - 1, z)
    if (!below || flat.isSolidCell(below)) return false
    // At most one solid neighbour (revmux 01: an "axis free" rule matched
    // the block over a doorway in a player's 1-thick wall and ate the wall
    // upward). A longer bridge erodes from its ends, one cell per pass.
    let solid = 0
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const n = blockAtXYZ(bot, x + dx, y, z + dz)
      if (!n || (flat.isSolidCell(n) && !isOwnPlaced(ctx, n) && !(ignore && ignore(n)))) solid++
    }
    return solid <= 1
  } catch (_) { return false }
}
// One cell's verdict on a complete castle. The scan and the read-time
// re-check share it (g0z.53: a block a player swapped inside the cache
// window is judged again, never dug on the old verdict).
function isLitter(bot, ctx, st, x, y, z, w, d) {
  const b = blockAtXYZ(bot, x, y, z)
  const n = b && b.name
  if (!SCAFFOLD_MATS.has(n)) return false
  // A filled plan 'dig' cell (revmux 01: a walker's moat bridge lands at
  // dy -1, in the dug moat) is litter: the complete castle dug it, nothing
  // natural refills it, and the relay skips dig cells after complete.
  const pc = blueprint.absPlan(st.site, st.rot, st.blueprintVersion).at.get(`${x},${y},${z}`)
  if (pc) return pc.kind === 'dig'
  const ring = y >= st.site.y && x >= st.site.x - 1 && x <= st.site.x + w && z >= st.site.z - 1 && z <= st.site.z + d
  if (ring && isOwnPlaced(ctx, b)) {
    const k = `${x},${y},${z}`
    if (blueprint.absPlan(st.site, st.rot, st.blueprintVersion).at.has(k)) return false
    const dc = blueprint.decorPlan(st.site, st.rot, st.blueprintVersion).at.get(k)
    return !(dc && blueprint.matches(dc.kind, n))
  }
  return scaffoldShape(bot, ctx, b, st)
}
function litterCell(st, d, x, y, z) {
  const R = blueprint.CASTLE_APRON
  const dx = x - st.site.x, dy = y - st.site.y, dz = z - st.site.z
  return { x, y, z, kind: 'air', dy, idx: LITTER_BAND_BASE + ((dx + R) * (d + 2 * R) + (dz + R)) * 40 + dy + LITTER_BELOW }
}
// Slice s: 0 = the fence band, s >= 1 = the x-strip site.x - R + s - 1 of
// the grown box, top-down (a pillar sweeps from its top, so its lower
// cells stay lone).
function litterSlice(bot, ctx, st, s, w, d) {
  const out = []
  if (s === 0) {
    for (const c of blueprint.fenceBandCells(st)) {
      if (isLitter(bot, ctx, st, c.x, c.y, c.z, w, d)) out.push(litterCell(st, d, c.x, c.y, c.z))
    }
    return out
  }
  const R = blueprint.CASTLE_APRON
  const x0 = st.site.x, x1 = x0 + w - 1, z0 = st.site.z, z1 = z0 + d - 1
  const x = x0 - R + s - 1
  const nearX = x >= x0 - 1 && x <= x1 + 1
  for (let z = z0 - R; z <= z1 + R; z++) {
    // Slice 0's cells (fenceBandCells: within 1 of the ring line, dy 0..3).
    const inBand = nearX && z >= z0 - 1 && z <= z1 + 1 && (x <= x0 + 1 || x >= x1 - 1 || z <= z0 + 1 || z >= z1 - 1)
    for (let dy = SITE_TOP; dy >= -LITTER_BELOW; dy--) {
      if (inBand && dy >= 0 && dy <= 3) continue
      const y = st.site.y + dy
      if (isLitter(bot, ctx, st, x, y, z, w, d)) out.push(litterCell(st, d, x, y, z))
    }
  }
  return out
}
function litterTargets(bot, ctx, st, now) {
  const complete = st.phase === 'complete'
  const key = `${st.site.x},${st.site.y},${st.site.z},${st.rot | 0},v${ver(st)},${complete ? 'apron' : 'box'}`
  const { w, d } = blueprint.siteDimensions(st.rot | 0, st.blueprintVersion)
  if (complete) {
    // One slice per call; the previous pass's list stands in for the
    // slices this pass has not reached yet. A finished pass waits
    // FULL_RESCAN_MS before the next one starts.
    const last = w + 2 * blueprint.CASTLE_APRON
    let c = ctx.castleLitter
    if (!c || c.key !== key || !Array.isArray(c.acc)) c = ctx.castleLitter = { key, at: now, list: [], acc: [], next: 0 }
    if (c.next > last && now - c.at >= FULL_RESCAN_MS) { c.at = now; c.next = 0; c.acc = [] }
    // Slices run until one workable cell is pending (or the pass ends): an
    // empty first strip must not word the menu past the sweep into a long
    // castlefetch leg (rig CASTLE_LITTER: 0/30 swept).
    // ponytail: worst case one whole pass (w + 2R strips) in a call, at most
    // once per FULL_RESCAN_MS; a time budget if that ever shows in tick time.
    const pendingOf = () => (c.next > last ? c.list : c.acc.concat(c.list.filter((o) => o.slice >= c.next)))
      .filter((o) => isLitter(bot, ctx, st, o.x, o.y, o.z, w, d))
    let pending = pendingOf()
    while (c.next <= last) {
      for (const o of litterSlice(bot, ctx, st, c.next, w, d)) { o.slice = c.next; c.acc.push(o) }
      c.next++
      if (c.next > last) { c.list = c.acc; c.acc = [] }
      pending = pendingOf()
      if (nextLitter(st, pending, now, bot)) break
    }
    return pending
  }
  const c0 = ctx.castleLitter
  if (c0 && c0.key === key && now - c0.at < FULL_RESCAN_MS) return c0.list.filter((c) => !done(bot, c))
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
        // The stairs relay (g0z.48, revmux 02): the box holds a lived-in
        // castle, not a construction site — cobblestone sweeps only when
        // the bot placed it this session (trackPlaced), never the owner's.
        const ownCobble = n === 'cobblestone' && (!st.upgrade || placed.has(k))
        if (ownCobble || (placed.has(k) && NATURAL_SOLID.has(n))) {
          list.push({ x, y, z, kind: 'air', dy, idx: 2000000 + (dx * d + dz) * 40 + dy })
        }
      }
    }
  }
  ctx.castleLitter = { key, at: now, list }
  return list
}

// Next workable litter cell (not backing off, never retired, no player —
// worker.players, bots excluded — within LITTER_PLAYER_R: g0z.61, retried
// next call, no strike): the menu and the tail share it. Retired band cells
// stay listed by litterTargets (the status line reports them) but are never
// re-worded or re-worked.
function nextLitter(st, list, now, bot = null) {
  const bl = st.blocked || {}
  let near = []
  try {
    // bot2's peer (BOT_PEER_USERNAME = IdkBot) is a bot too; worker.js:98
    // drops it only on swarm helpers (revmux 01 minor).
    const peer = process.env.BOT_PEER_USERNAME
    near = Object.entries(worker.players(bot)).filter(([n]) => !peer || n !== peer)
      .map(([, p]) => p && p.entity && p.entity.position).filter(Boolean)
  } catch (_) { near = [] }
  const r2 = LITTER_PLAYER_R * LITTER_PLAYER_R
  return list.find((o) => {
    const b = bl[bkey(st, o.idx)]
    if (b && (b.retired || b.until > now)) return false
    return !near.some((p) => (p.x - o.x - 0.5) ** 2 + (p.y - o.y - 0.5) ** 2 + (p.z - o.z - 0.5) ** 2 < r2)
  })
}

// A band idx back to its cell (the litterCell formula inverted), or null.
// Only the range checks can fail: dy = t mod 40 and the strides divide by
// construction.
function bandOf(st, idx) {
  if (!(idx >= LITTER_BAND_BASE && idx < blueprint.DECOR_BASE)) return null
  const { w, d } = blueprint.siteDimensions(st.rot | 0, st.blueprintVersion)
  const R = blueprint.CASTLE_APRON
  const t = idx - LITTER_BAND_BASE
  const dy = (t % 40) - LITTER_BELOW
  const q = (t - (t % 40)) / 40
  const dz = (q % (d + 2 * R)) - R
  const dx = (q - (dz + R)) / (d + 2 * R) - R
  if (dy > SITE_TOP || dx >= w + R || dz >= d + R) return null
  return { x: st.site.x + dx, y: st.site.y + dy, z: st.site.z + dz, kind: 'air', dy, idx }
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
// pane (g0z.31, revmux 01): any pane is a batch, like torch — the source
// was the chest only, so a sub-batch remainder could never grow and would
// never be laid; castlefetch runs on pane-none only (chest, then the
// sand ladder, g0z.38). banner (g0z.32): same. bookshelf and
// enchanting_table (g0z.49): same — chest-supplied attic decor.
// blast_furnace (g0z.50): same — one kitchen cell.
const BATCH_OF = { frame: 14, torch: 1, pane: 1, banner: 1, bookshelf: 1, enchanting_table: 1, blast_furnace: 1 }
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
// Loaded = all four footprint corners read (revmux 02): the v1 site
// spans at most 2x2 chunks; the v2 site (31x27) up to 3x3, whose middle
// chunks lie inside the corners' hull — the loaded area is convex.
function siteLoaded(bot, st) {
  try {
    const { w, d } = blueprint.siteDimensions(st.rot | 0, st.blueprintVersion)
    return [[0, 0], [w - 1, 0], [0, d - 1], [w - 1, d - 1]].every(([dx, dz]) => !!bot.blockAt(new Vec3(st.site.x + dx, st.site.y, st.site.z + dz)))
  } catch (_) { return false }
}

// Castle tidy (g0z.62): a complete castle off the loaded map read 'done'
// forever, so nothing walked the owner back to see its damage (prod: 94
// cells missing, 1 castle step in 3 h). st.visitedAt stamps every tick
// the site is loaded with the bot within TIDY_VISIT_DIST of its centre;
// past CASTLE_TIDY_MS (default 1 h, 0 = off) the far word is 'tidy' and
// gocastle walks back. On site the real words (relay/sweep/decor/'done')
// take over, so the trip ends by itself. TIDY_VISIT_DIST = goal.js
// GOSITE_DIST (a require would cycle): the visit stamps exactly where the
// return walk's displacement ends — no band where the walk stops short of
// a visit and the bot ping-pongs at the load edge.
const TIDY_VISIT_DIST = 64
// ponytail: a flat 10-min cap on the walk back (230 blocks walk in ~2);
// make it distance-scaled if a castle ever sits a far-leg away.
const TIDY_TRIP_MS = 10 * 60 * 1000
function tidyMs() {
  const raw = process.env.CASTLE_TIDY_MS
  const v = raw ? Number(raw) : NaN
  return Number.isFinite(v) && v >= 0 ? v : 3600000
}
function tidyDue(st, now = Date.now()) {
  const ms = tidyMs()
  if (!st || !st.site || st.phase !== 'complete' || st.parked || !(ms > 0)) return false
  return now - (typeof st.visitedAt === 'number' ? st.visitedAt : 0) > ms
}
function nearSite(bot, st) {
  try {
    const bp = bot && bot.entity && bot.entity.position
    if (!bp || typeof bp.x !== 'number') return false
    const { w, d } = blueprint.siteDimensions(st.rot | 0, st.blueprintVersion)
    return Math.hypot(bp.x - (st.site.x + w / 2), bp.z - (st.site.z + d / 2)) <= TIDY_VISIT_DIST
  } catch (_) { return false }
}
function noteVisit(bot, ctx, st, now) {
  if (!nearSite(bot, st)) return
  st.visitedAt = now
  ctx.tidyLegMs = 0
}

// Dry decor kinds (g0z.49): every castlefetch leg that comes up dry adds
// its kind (noteDry), so the decor word below skips every dry kind at
// once — with five decor kinds now, one mark per kind. A leg that got
// stock clears the set (castlefetch.finish); when every open kind is dry
// the word retries the first and restarts the cycle. A legacy
// single-kind string still reads as a one-kind set.
function dryKinds(ctx) {
  const v = ctx && ctx.castleFetchDry
  if (v instanceof Set) return v
  return new Set(typeof v === 'string' && v ? [v] : [])
}
function noteDry(ctx, kind) {
  if (!ctx || typeof kind !== 'string' || !kind) return
  const s = dryKinds(ctx)
  s.add(kind)
  ctx.castleFetchDry = s
}

function menuFact(bot, ctx, now = Date.now()) {
  const st = ctx && ctx.castle
  if (!st || !st.site || typeof st.site.x !== 'number') return 'none'
  if (st.parked) { ctx.tidyLegMs = 0; return 'parked' }
  // Tidy bound (g0z.62 revmux 01/02): the watchdog never watches a
  // complete castle, so a failed trip leg — or TIDY_TRIP_MS of leg time
  // without arriving (a walk that moves but never closes in) — counts as
  // the visit: one try per CASTLE_TIDY_MS, never a day of re-walks to an
  // unreachable site. Leg time only (ticks capped at 5 s), so a night
  // between legs does not eat the trip. Read here (decide's first facts
  // read), so this very tick already says 'done'.
  // The owed-repair trip (latched in the loaded branch below) rides the same bound, and an off-site
  // fetch leg for it gets one try: a failure drops the latch (the next tidy
  // visit re-reads the castle), never a fetch retried every hold.
  const owed = st.phase === 'complete' && !!(ctx.castleWord && ctx.castleWord.repair)
  if (tidyDue(st, now) || owed) {
    const leg = ctx.step === 'gocastle' || ctx.step === 'castle'
    const failed = failReason(ctx.stepStatus) !== null
    if (leg) ctx.tidyLegMs = (ctx.tidyLegMs || 0) + Math.max(0, Math.min(now - (ctx.tidyTickAt || now), 5000))
    if ((leg && failed) || ctx.tidyLegMs > TIDY_TRIP_MS) {
      st.visitedAt = now
      ctx.tidyLegMs = 0
      if (owed) ctx.castleWord = null
    } else if (owed && failed && ctx.step === 'castlefetch' && !nearSite(bot, st)) {
      ctx.castleWord = null
      ctx.tidyFetchSpent = st.visitedAt || 0 // this window's one off-site try
    }
  } else ctx.tidyLegMs = 0 // a fresh trip clock for every due window (stop/forget/new castle)
  ctx.tidyTickAt = now
  // Spent try: away from a complete castle the far word holds even while its
  // chunks stay loaded (a house in view range), so the loaded branch cannot
  // re-latch the same repair and re-run the failed fetch; a visit (a new
  // visitedAt) opens the next window.
  if (st.phase === 'complete' && ctx.tidyFetchSpent === (st.visitedAt || 0) && !nearSite(bot, st)) return tidyDue(st, now) ? 'tidy' : 'done'
  try {
    if (!siteLoaded(bot, st)) {
      if (st.phase === 'complete') {
        const last = ctx.castleWord
        if (last && last.repair) return stockWord(bot, last.kind, last.left) // owed repair (g0z.62): fetch it here, carry it back
        return tidyDue(st, now) ? 'tidy' : 'done'
      }
      const last = ctx.castleWord
      if (last && last.kind) return stockWord(bot, last.kind, last.left)
      if (last && last.word) return last.word
      const { cells, key } = blueprint.absPlan(st.site, st.rot, st.blueprintVersion)
      return stockWord(bot, cells[workOrder(cells, key)[0]].kind, BATCH)
    }
    noteVisit(bot, ctx, st, now)
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
          for (const c of cells) if (gauged(c)) total++
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
      if (st.phase === 'complete') {
        // Decor (g0z.31): on site, open decor cells ask for their kind; the
        // castle stays 'complete' (off site it reads 'done', above). A held
        // kind words first (g0z.32), else the first open kind no leg found
        // dry (g0z.49: the whole dry set is skipped, so an empty pane
        // stock never locks the chest banners — or the attic shelves —
        // out, and dry legs never ping-pong past the fence row).
        // Band sweep (g0z.44): between the two — held decor still wins, but
        // a dry decor word never hides workable band litter (and litter
        // never hides decor).
        const open = decorOpen(bot, st, now)
        const heldCell = open.find((c) => usable(bot, c.kind, ctx) > 0)
        if (heldCell) {
          const kind = heldCell.kind
          const left = open.filter((c) => c.kind === kind).length
          ctx.castleWord = { kind, left }
          return stockWord(bot, kind, left)
        }
        if (nextLitter(st, litterTargets(bot, ctx, st, now), now, bot)) {
          ctx.castleWord = { word: 'clear' }
          return 'clear'
        }
        if (open.length > 0) {
          const dry = dryKinds(ctx)
          const kinds = [...new Set(open.map((c) => c.kind))]
          let kind = kinds.find((k) => !dry.has(k))
          if (!kind) {
            // Every open kind dry: retry the first and restart the cycle,
            // so each kind is retried once per cycle, never starved.
            kind = kinds[0]
            if (ctx) ctx.castleFetchDry = null
          }
          const left = open.filter((c) => c.kind === kind).length
          ctx.castleWord = { kind, left }
          return stockWord(bot, kind, left)
        }
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
    let left = r.cell.sill ? 1 : 0 // the off-plan sill is in no work order (lqgo revmux 01)
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
    // A complete castle's open plan cell is a repair (g0z.62): latched, so
    // off site the owed kind stays the word — castlefetch funds it at home
    // (the home furnace, a tidy visit's torches) and the castle step walks
    // it back. Decor and sweep words never latch.
    ctx.castleWord = st.phase === 'complete' ? { kind, left, repair: true } : { kind, left }
    return stockWord(bot, kind, left)
  } catch (_) {
    return 'none'
  }
}

// Owner-facing progress (chat 'castle'): laid/total per material kind
// (moat = dug/total of the 'dig' cells),
// read live from the world (blocked never counts as done).
function progressByKind(bot, st) {
  const out = {}
  for (const c of blueprint.absPlan(st.site, st.rot, st.blueprintVersion).cells) {
    if (!gauged(c)) continue
    const k = c.kind === 'dig' ? 'moat' : c.kind
    const e = out[k] || (out[k] = { done: 0, total: 0 })
    e.total++
    if (done(bot, c)) e.done++
  }
  return out
}

function progress(bot, st, cells, ctx) {
  let n = 0
  let total = 0
  // A dig cell counts once dug, refilled or not (revmux 01 minor): a
  // bridge-refill -> re-dig loop must not read as growth to the clock.
  // ponytail: per-session high-water, a restart re-reads the world.
  const sig = `${st.site.x},${st.site.y},${st.site.z}:${st.rot | 0}:${ver(st)}`
  if (!ctx.castleDug || ctx.castleDug.sig !== sig) ctx.castleDug = { sig, idx: new Set(), high: 0, was: new Set() }
  const lost = []
  const now = new Set()
  for (const c of cells) {
    if (!gauged(c)) continue
    total++
    if (c.kind === 'dig') {
      if (done(bot, c)) ctx.castleDug.idx.add(c.idx)
      if (ctx.castleDug.idx.has(c.idx)) n++
    } else if (done(bot, c)) { n++; now.add(c.idx) } else if (ctx.castleDug.was.has(c.idx)) lost.push(c)
  }
  st.progress = { done: n, total }
  // uh28: a drop below the high-water mark names the cells that were laid
  // last scan and are not now, once per drop.
  // idkcraft-akze: after an away gap (no scan for a while — the bot was off
  // site and unloaded) the high-water re-baselines instead of logging. The
  // repair seed knocks 22 original cells while the bot is at the start
  // house; the world took unlaid work, not damage under our watch. A drop
  // between consecutive loaded scans (the bot present, ~FULL_RESCAN_MS
  // apart) still names the lost cells.
  const cd = ctx.castleDug
  cd.was = now
  let gapAway = false
  try {
    const nowMs = Date.now()
    if (typeof cd.lastScan === 'number' && nowMs - cd.lastScan > CASTLE_AWAY_MS) {
      cd.high = n // re-baseline: no regress line for the away knock
      gapAway = true
    }
    cd.lastScan = nowMs
  } catch (_) { /* clock best-effort: the gap check stands down */ }
  if (n >= cd.high) cd.high = n
  else if (!gapAway && lost.length) console.log(`castle regress ${n} missing=${lost.slice(0, 10).map((c) => `${c.kind}@${c.x},${c.y},${c.z}`).join(' ')}`)
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

// A borrower (fight, lead, a reflex) replaced the castle step's goal while
// its cell stayed the same. Shared by approach() and the break guard;
// fails closed (borrowed) for the guard, open for the approach latch.
function borrowedGoal(bot, ctx) {
  try { return bot.pathfinder.goal != null && bot.pathfinder.goal !== ctx.castleGoal } catch (_) { return true }
}

// (Re)issue the approach for this cell: a new cell, or a borrower (fight,
// lead, a reflex) replaced our goal while the cell stayed the same.
function approach(bot, ctx, c, make) {
  const foreign = borrowedGoal(bot, ctx)
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

// Faced placement (g0z.50: the kitchen blast furnace; the g0z.47 stairs
// reuse it): the server faces the block away from the placer's look, so
// look at the cell first and place with the look frozen (the beds
// look-then-_placeBlockWithOptions shape). Non-forced (revmux 01): a
// forced look returns with the rotation still unsent, and the frozen
// place would land on the stale yaw — the awaited look resolves once
// the physics tick has sent the rotation.
async function placeFaced(bot, ref, c) {
  if (typeof bot.lookAt === 'function') await bot.lookAt(new Vec3(c.x + 0.5, c.y + 0.5, c.z + 0.5))
  if (typeof bot._placeBlockWithOptions === 'function') return bot._placeBlockWithOptions(ref.ref, ref.face, { forceLook: 'ignore' })
  return bot.placeBlock(ref.ref, ref.face)
}

// Stair placement (g0z.47): the server faces the stair along the placer's
// horizontal look and halves it by the clicked face/cursor, so look along
// the plan face first (mineflayer yaw convention, non-forced like
// placeFaced) and place with the look frozen, the cursor low (half
// 'bottom'). findRef already excluded the top ref for stairs.
async function placeStairs(bot, ref, c) {
  const yaw = Math.atan2(-c.face.dx, -c.face.dz)
  if (typeof bot.look === 'function') await bot.look(yaw, 0)
  if (typeof bot._placeBlockWithOptions === 'function') {
    return bot._placeBlockWithOptions(ref.ref, ref.face, { forceLook: 'ignore', half: 'bottom', swingArm: 'right' })
  }
  return bot.placeBlock(ref.ref, ref.face)
}

function placeCell(bot, ctx, st, c, item, now) {
  const p = new Vec3(c.x, c.y, c.z)
  // The door is placed from the entrance apron, so the bot ends OUTSIDE
  // the closed tower instead of sealing itself in. Gate banners (g0z.32)
  // hang on the gate's outer face: placed from the apron too. The blast
  // furnace (g0z.50) places from its stance north of the cell, looking
  // south-into-kitchen, so its front faces into the room.
  const ent = c.kind === 'door' || c.kind === 'banner' ? entrance(st) : c.kind === 'blast_furnace' ? c.stance || null : null
  if (approach(bot, ctx, c, () => ent
    ? new goals.GoalBlock(ent.x, ent.y, ent.z)
    // Decor (g0z.31): 10 of 44 v2 windows hide every neighbour face from
    // the walkable stances behind a stair step; the server checks the click
    // distance only, so a pane approach drops LOS (far() still gates reach).
    : new goals.GoalPlaceBlock(p, bot.world, { range: build.PLACE_RANGE, LOS: !(c.idx >= blueprint.DECOR_BASE) }))) return
  let moving = false
  try { moving = bot.pathfinder.isMoving() } catch (_) { /* treat as arrived */ }
  if (moving) return
  if (ent) {
    // Door only from the apron itself (revmux 02): reach alone would let a
    // body inside the ground floor close the tower on itself. The blast
    // stance (g0z.50) is exact for the same reason: the facing comes from
    // the stance. y rounds, not floors: on a soul sand/mud/path apron the
    // feet sit ~0.1 low (revmux 03).
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
  } else if (c.wall) {
    // Wall banner (g0z.32): click the wall block's outward face — findRef
    // could pick the window pane beside it and hang the banner sideways.
    try {
      const w = bot.blockAt(new Vec3(c.wall.x, c.wall.y, c.wall.z))
      if (w && w.position && w.boundingBox !== 'empty') ref = { ref: w, face: new Vec3(c.x - c.wall.x, c.y - c.wall.y, c.z - c.wall.z) }
    } catch (_) { ref = null }
  } else {
    ref = build.findRef(bot, p, c.kind === 'stairs' ? { excludeTop: true } : undefined)
  }
  if (!ref) {
    ctx.castleGoalIdx = -1
    strike(ctx, st, c, 'no-ref', now)
    return
  }
  flight(ctx, 'placeInFlight', c, async (token) => {
    try {
      await bot.equip(item, 'hand')
      if (c.kind === 'blast_furnace' && c.stance) await placeFaced(bot, ref, c)
      else if ((c.kind === 'stairs' || c.kind === 'gate') && c.face) await placeStairs(bot, ref, c) // g0z.46: a gate faces the look too
      else await bot.placeBlock(ref.ref, ref.face)
      if (live(ctx, token)) {
        // A stair that lands facing wrong is not done: strike it now so a
        // placement bug blocks after STRIKES instead of digging/relaying
        // forever (the dig-then-place path relays it next tick).
        if (c.kind === 'stairs' && c.face && !done(bot, c)) strike(ctx, st, c, 'wrong-facing', Date.now())
        else ctx.castleFails = null
      }
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
// After REDIG_MAX digs every further refill blocks again (one dig per
// retry). pick() prunes the entry once the retry dig lands, so the try
// count lives here and is carried into the entry: the MAX_HOLE_TRIES-th
// refill retires the cell (revmux 01). Session-only; rebuild resets it.
const REDIG_MAX = 3
function digCell(bot, ctx, st, c, now) {
  const name = nameAt(bot, c)
  const rk = c.kind === 'dig' ? bkey(st, c.idx) : null
  const r = rk && ctx.castleRedig ? ctx.castleRedig[rk] : null
  if (r && !AIR.has(name) && r.digs >= REDIG_MAX + r.blocks) {
    r.blocks++
    const e = st.blocked[rk] || (st.blocked[rk] = { tries: 0, until: 0 })
    e.tries = Math.max(e.tries, r.blocks - 1)
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
  // Apron litter (g0z.61) was judged ours by litterTargets (own or shape);
  // beds, castle cells and the trap rules still refuse in denyReason.
  let ours = name === 'cobblestone' || (c.idx >= LITTER_BAND_BASE && c.idx < blueprint.DECOR_BASE)
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
  // The sill's natural ground is groundCell (castleProtects): only this dig
  // may swap it (lqgo).
  const clear = c.sill ? { ...ctx, castleClear: true, castleSill: true } : { ...ctx, castleClear: true }
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
        // Stairs relay (g0z.47): digging a mis-faced stair keeps the
        // wrong-facing strikes, so a placement bug blocks after STRIKES
        // instead of digging/relaying forever. Any other dig resets.
        const relay = c.kind === 'stairs' && c.face && blueprint.matches('stairs', name)
        if (!relay) ctx.castleFails = null
        if (rk) {
          ctx.castleRedig = ctx.castleRedig || {}
          const n = ctx.castleRedig[rk] || (ctx.castleRedig[rk] = { digs: 0, blocks: 0 })
          n.digs++
        }
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
    // g0z.63: a castleless bot (swarm, V2) installs too — the apron of every
    // known castle (memory.refreshKnownCastles) vetoes its scaffolding.
    const known = ctx && (ctx.castle || (Array.isArray(ctx.knownCastles) && ctx.knownCastles.length))
    if (!known || !mov ||!Array.isArray(mov.exclusionAreasBreak) || !Array.isArray(mov.exclusionAreasPlace)) return
    if (ctx.castleGuardMov === mov && mov.exclusionAreasBreak.includes(ctx.castleGuardFn) &&
      mov.exclusionAreasPlace.includes(ctx.castlePlaceFn)) return
    for (const m of new Set([ctx.castleGuardMov, mov])) {
      if (m && Array.isArray(m.exclusionAreasBreak)) m.exclusionAreasBreak = m.exclusionAreasBreak.filter((f) => f !== ctx.castleGuardFn)
      if (m && Array.isArray(m.exclusionAreasPlace)) m.exclusionAreasPlace = m.exclusionAreasPlace.filter((f) => f !== ctx.castlePlaceFn)
    }
    const fn = (block) => {
      try {
        if (!ctx.castle || !block) return 0
        if (castleProtects(ctx.castle, block.position, block.name)) return 100
        // The castle step's own walks (g0z.44 revmux 01 body-2, 02 core-1):
        // prep cuts and cell approaches dig as before — but not a borrower
        // (fight, lead, a reflex), whose A* stays out of the yard like
        // every other executor's.
        if (ctx.step === 'castle' && !borrowedGoal(bot, ctx)) return 0
        return yardDigBan(ctx.castle, block.position, block.name) ? 100 : 0
      } catch (_) { return 0 }
    }
    const placeFn = (block) => {
      try {
        const st = ctx.castle
        const q = block && block.position
        if (!q) return 0
        if (blueprint.inCastleApron(ctx, q)) return 100 // g0z.63: any known castle's apron
        if (!st || !st.site) return 0
        const { w, d } = blueprint.siteDimensions(st.rot | 0, st.blueprintVersion)
        const dx = q.x - st.site.x
        const dy = q.y - st.site.y
        const dz = q.z - st.site.z
        // Fence ring (g0z.44): the fence sits on the box edge, so the cell
        // just outside it took scaffolding at cost 0 — a foothold over the
        // fence. The yard ring (the box grown by 1) vetoes too.
        if (!(dx >= 0 && dx < w && dz >= 0 && dz < d)) return blueprint.yardRing(st, q) ? 100 : 0
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

// Builder batch (idkcraft-neuc.54): on the Baritone body (bot.buildCells
// present) the plain-cube place kinds (stone/planks/frame/fence/torch) go
// to BuilderProcess in one call per batch. Stairs and doors keep the faced
// per-cell path (placeStairs/placeFaced), dig/air/prep/decor cells keep
// theirs — they never enter the schematic. The complete-phase repair is
// this same re-issue: pick() still surfaces missing place cells one by one
// after 'complete', and the first eligible one re-issues the schematic for
// all of them, so sfmk's "repair on return" needs no cadence code.
const CASTLE_BUILDER_KINDS = new Set(['stone', 'planks', 'frame', 'torch'])
const CASTLE_BUILDER_BATCH = 256
// Fences stay on the per-cell path (core-6): Baritone compares full block
// state, and a connected fence ring never matches the default schematic
// state — the builder would break/re-lay (or refuse) it forever. Plain
// cubes only here, like the bead's RISKS ask.
// Per-cell names (idkcraft-cu1a): the mod's starvation is exact-name, so
// one name for the whole batch (the FIRST stack — prod: andesite x3 ahead
// of the owner's cobble x512) starved after 3 cells with 500 on hand.
// Each name gets at most its count, biggest stack first, and the kind's
// total stops at usable() so the reserve is never batched.
function heldStacks(bot, kind, budget, ctx) {
  const want = ITEM[kind]
  const by = {}
  try {
    for (const it of bot.inventory.items() || []) {
      if (it && typeof it.name === 'string' && it.count > 0 && want && want(it.name)) by[it.name] = (by[it.name] | 0) + it.count
    }
    // The owner's relocated stacks (vmzq.40) never get names.
    for (const it of (ctx && ctx.castleCarry && ctx.castleCarry.items) || []) {
      if (by[it.name]) by[it.name] = Math.max(0, by[it.name] - it.count)
    }
  } catch (_) { /* no inventory: no item */ }
  const q = Object.entries(by).map(([name, left]) => ({ name, left })).sort((a, b) => b.left - a.left)
  return { q, budget }
}
function takeName(h) {
  while (h.q.length && h.q[0].left <= 0) h.q.shift()
  if (h.budget <= 0 || !h.q.length) return null
  h.budget--
  h.q[0].left--
  return h.q[0].name
}
function castleBuilderCells(bot, ctx, st) {
  try {
    if (!st || !st.site || st.phase === 'prep') return null
    const { cells, at } = blueprint.absPlan(st.site, st.rot | 0, st.blueprintVersion)
    const blocked = st.blocked || {}
    const now = Date.now()
    const held = {}
    const batched = new Set()
    const out = []
    // Bottom-up (idkcraft-synq): plan order interleaves tower tops ahead
    // of their stand floors (dy14 stone idx~1039 before dy2 walls idx~1193
    // and dy8-11 planks floors idx~1460+), so a plan-ordered batch asks
    // Baritone for cells whose floor is still unlaid — and possibly unheld,
    // hence never in the same batch. The layers skip, the same cells miss
    // every pass (build-miss), and the 90 s watchdog stalls the whole
    // batch. Select lowest-first, like the tower's own lay order.
    const order = cells.map((c, i) => i).sort((a, b) => (cells[a].y - cells[b].y) || (a - b))
    for (const i of order) {
      const c = cells[i]
      if (out.length >= CASTLE_BUILDER_BATCH) break
      if (!CASTLE_BUILDER_KINDS.has(c.kind) || c.prep) continue
      if (done(bot, c)) continue
      const b = blocked[bkey(st, c.idx)]
      if (b && (b.retired || b.until > now)) continue
      // Stand-floor gate (idkcraft-synq): a cell whose plan cell below is
      // an unlaid place target that is NOT itself in this batch (unheld
      // kind, or blocked/backing off) stays out — batching it can only end
      // in a skipped layer and a strike. It falls through to the per-cell
      // path, which names the missing floor (failed:no-<kind> fetch word)
      // instead of wedging the builder; once the floor lays, the cell
      // batches. Below-supports are only ever stone/planks/frame (never
      // door/stairs), so no deferral deadlock.
      const below = at.get(`${c.x},${c.y - 1},${c.z}`)
      if (below && blueprint.isPlaceTarget(below.kind) && !done(bot, below) && !batched.has(below.idx)) continue
      // Held kinds only: an unheld kind falls through to work()'s material
      // path (failed:no-<kind>) so castlefetch fetches it as today.
      if (held[c.kind] === undefined) held[c.kind] = heldStacks(bot, c.kind, usable(bot, c.kind, ctx), ctx)
      const block = takeName(held[c.kind])
      if (!block) continue
      batched.add(c.idx)
      out.push({ x: c.x, y: c.y, z: c.z, kind: c.kind, idx: c.idx, block })
    }
    if (out.length === 0) return null
    return { origin: { x: st.site.x, y: st.site.y, z: st.site.z }, cells: out }
  } catch (_) {
    return null
  }
}
// Same-block rule for the schematic (core-8): the quarry yields granite /
// diorite / andesite as often as cobble, and usable(stone) counts them —
// a cobblestone cell with only deepslate on hand is starved, not wedged.
function castleSame(want, have) {
  if (want === have) return true
  if (typeof want !== 'string' || typeof have !== 'string') return false
  if (blueprint.isStone(want) && blueprint.isStone(have)) return true
  for (const suffix of ['_planks', '_fence', '_log']) {
    if (want.endsWith(suffix) && have.endsWith(suffix)) return true
  }
  return false
}
function castleBuilderBatch(bot, ctx, st, c) {
  if (ctx.castleBuildFlight) return true
  if (!c || clearing(c) || c.prep || c.sill || !CASTLE_BUILDER_KINDS.has(c.kind)) return false
  const batch = castleBuilderCells(bot, ctx, st)
  if (!batch) return false
  ctx.castleBuildFlight = true
  const gen = stepGen(ctx) // stale batches must not fail a newer step (core-5)
  const forbid = [...new Set(batch.cells.map((o) => o.block))]
  const name = `castle@${st.site.x},${st.site.z}`
  const flightCells = batch.cells
  // Fire line (r185): batch composition the stall watchdog cannot see —
  // the next failed:build-stall reads back what this batch held.
  try {
    const kinds = {}
    for (const o of flightCells) kinds[o.kind] = (kinds[o.kind] | 0) + 1
    const first = flightCells[0]
    console.log(`castle builder ${name}: ${flightCells.length} cells (${Object.entries(kinds).map(([k, n]) => `${k}x${n}`).join(',')}) first=${first.x},${first.y},${first.z}`)
  } catch (_) { /* fire line best-effort */ }
  const settleFail = (reason) => {
    ctx.castleBuildFlight = false
    if (gen === stepGen(ctx)) st.status = reason
    stepFailed(ctx, reason, gen)
  }
  // Strike-back (core-3, round-2 core-1): still-missing cells with
  // material on hand were attempted and refused. Counted PER CELL in
  // st.batchStrikes — the shared strike() keeps one counter for the last
  // idx only, so two refused cells would reset each other forever. At
  // STRIKES the cell enters the usual backoff/retire machinery instead of
  // re-batching forever. Starved misses fetch, never strike.
  // Synq core-1 (revmux 02/03): strike only the layer Baritone was on.
  // The builder lays bottom-up inside the batch, so the lowest unfinished
  // batch layer is the one it attempted; higher layers — even with their
  // floors long laid — are collateral of the stall and must not burn the
  // one-shot build-miss ladder. Starved kinds never strike. A batch-wide
  // wedge (more than a handful striking at once — a wedged body or a cold
  // cache refuses every cell alike) is not cell-specific evidence either:
  // it falls back to the ordinary backoff ladder under a distinct why, so
  // a transient cannot permanently retire a whole course, while a truly
  // dead layer still retires through it.
  const strikeMisses = () => {
    try {
      if (!st.batchStrikes || typeof st.batchStrikes !== 'object') st.batchStrikes = {}
      const now = Date.now()
      let lowY = Infinity
      for (const o of flightCells) {
        if (done(bot, o)) { delete st.batchStrikes[bkey(st, o.idx)]; continue }
        if (o.y < lowY) lowY = o.y
      }
      const set = []
      for (const o of flightCells) {
        if (done(bot, o)) continue
        if (o.y !== lowY) continue
        if (usable(bot, o.kind, ctx) <= 0) continue
        set.push(o)
      }
      if (set.length > STRIKE_WIDE_CAP) {
        for (const o of set) {
          delete st.batchStrikes[bkey(st, o.idx)]
          blockCell(ctx, st, o, 'build-miss-wide', now)
        }
        return
      }
      for (const o of set) {
        const k = bkey(st, o.idx)
        const n = (st.batchStrikes[k] = (st.batchStrikes[k] | 0) + 1)
        if (n >= STRIKES) {
          delete st.batchStrikes[k]
          blockCell(ctx, st, o, 'build-miss', now)
        }
      }
    } catch (_) { /* strike-back best-effort */ }
  }
  try {
    bot.buildCells(name, batch.origin, flightCells.map((o) => ({
      dx: o.x - st.site.x, dy: o.y - st.site.y, dz: o.z - st.site.z, block: o.block,
    })), { forbid, isSame: castleSame }).then(
      (res) => {
        ctx.castleBuildFlight = false
        // Placed growth resets suspicion (revmux 03 core-1): strikes count
        // CONSECUTIVE no-progress refusals — a batch that laid anything
        // proves the builder is reaching its layer, so old strikes drop
        // and only this batch's misses strike below.
        if (res && typeof res.placed === 'number' && res.placed > 0 &&
          st.batchStrikes && typeof st.batchStrikes === 'object') {
          for (const k of Object.keys(st.batchStrikes)) delete st.batchStrikes[k]
        }
        // A starved resolve fetches more material and retries the whole
        // batch — it never strikes (round-2 core-2): the misses were not
        // attempted, and a stale preemption must not poison live cells.
        // Only a fresh-gen watchdog stall (attempted, refused) strikes.
        if (gen !== stepGen(ctx)) return
        // Missing kinds re-read from the world: whatever is still not
        // done names the fetch word, like work()'s material path.
        let miss = null
        try {
          miss = flightCells.find((o) => !done(bot, o))
        } catch (_) {
          miss = flightCells[0] || null
        }
        // Starved with the kind still usable (cu1a): the named stacks ran
        // out but other variants remain — re-batch next tick with fresh
        // names; only an empty kind is the fetch word. A final that left
        // cells missing with their exact name still held was refused, not
        // starved: strike them so they back off instead of re-firing.
        if (miss && usable(bot, miss.kind, ctx) > 0) {
          const named = new Set()
          try { for (const it of bot.inventory.items() || []) if (it && it.count > 0) named.add(it.name) } catch (_) { /* none */ }
          if (flightCells.some((o) => !done(bot, o) && named.has(o.block))) strikeMisses()
          return
        }
        if (miss) settleFail(`no-${miss.kind}`)
      },
      (err) => {
        // Preempted (round-3 core-2): the step keeps running and re-batches;
        // never a strike nor a fetch word for material the pack holds.
        if (err && err.message === 'build-preempted') {
          ctx.castleBuildFlight = false
          return
        }
        if (err && err.message === 'build-stall' && gen === stepGen(ctx)) {
          // Growth reset (codex P2 on PR #631): the watchdog fires 90 s
          // after the LAST placement, so a rejected batch may still have
          // laid cells. Strikes count consecutive no-progress refusals —
          // any cell this batch placed clears the stale suspicion before
          // this batch's misses strike below.
          if (flightCells.some((o) => { try { return done(bot, o) } catch (_) { return false } }) &&
            st.batchStrikes && typeof st.batchStrikes === 'object') {
            for (const k of Object.keys(st.batchStrikes)) delete st.batchStrikes[k]
          }
          strikeMisses()
        }
        settleFail(err && err.message === 'build-stall' ? 'build-stall' : 'build-failed')
      },
    )
  } catch (_) {
    ctx.castleBuildFlight = false
    return false
  }
  return true
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
  // v2 builder (neuc.54): plain-cube place cells batch through
  // BuilderProcess; everything else keeps the per-cell path below.
  if (typeof bot.buildCells === 'function' && castleBuilderBatch(bot, ctx, st, c)) return
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

// Decor cells (g0z.31) workable now: undone, open (air — an owner's block
// in a window is his choice, never dug), not backing off or retired.
function decorOf(st, idx) {
  if (!(idx >= blueprint.DECOR_BASE)) return null
  return blueprint.decorPlan(st.site, st.rot, st.blueprintVersion).cells[idx - blueprint.DECOR_BASE] || null
}
function decorOpen(bot, st, now) {
  const bl = st.blocked || {}
  return blueprint.decorPlan(st.site, st.rot, st.blueprintVersion).cells.filter((c) => {
    const b = bl[bkey(st, c.idx)]
    return AIR.has(nameAt(bot, c)) && !(b && (b.retired || b.until > now))
  })
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
  if (ctx.placeInFlight || ctx.digInFlight || ctx.castleBuildFlight) return
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
  const sill = sillFirst(bot, ctx, st, r.idx < 0 ? null : cells[r.idx], now)
  if (sill) { work(bot, ctx, st, sill, now, 'laying the door sill'); return }
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
    // Litter (g0z.14 box scan, g0z.44 band scan on a complete castle):
    // the sweep runs before decor.
    const lit = nextLitter(st, litterTargets(bot, ctx, st, now), now, bot)
    if (lit) { work(bot, ctx, st, lit, now, 'clearing scaffold'); return }
    // Decor (g0z.31): a complete castle lays its panes (g0z.32: and
    // banners) through the same placeCell; phase stays 'complete'
    // (residence/stockpile read it). First open cell whose kind is held.
    if (st.phase === 'complete') {
      const dc = decorOpen(bot, st, now).find((c) => usable(bot, c.kind, ctx) > 0)
      if (dc) { work(bot, ctx, st, dc, now, 'decorating'); return }
    }
    // Holes stay on the status past completion (sayHoles set it above),
    // so 'castle' keeps reporting the gaps, not just 'complete'.
    if (!holes.length) st.status = 'complete'
    ctx.stepStatus = 'done'
    if (st.phase !== 'complete') {
      st.phase = 'complete'
      delete st.upgrade // the relay (g0z.48) ends where the build does
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
module.exports.BUILD_MISS_TRIES = BUILD_MISS_TRIES
module.exports.STRIKE_WIDE_CAP = STRIKE_WIDE_CAP
module.exports.guardCastle = guardCastle
module.exports.backoffMs = backoffMs
module.exports.STRIKES = STRIKES
module.exports.FULL_RESCAN_MS = FULL_RESCAN_MS
// Castle material for the stockpile reserve. With the castle state, only
// the kinds its plan uses (g0z.12: a v1 castle never hoards logs/chests).
module.exports.isMaterial = (name, st) => typeof name === 'string' && Object.entries(ITEM).some(([kind, want]) =>
  want(name) && (!st || kind in blueprint.billOfMaterials(blueprint.blueprintOf(st.blueprintVersion).PLAN) ||
    (blueprint.DECOR[blueprint.blueprintOf(st.blueprintVersion).version] || []).some((c) => c.kind === kind)))
module.exports.siteLoaded = siteLoaded
module.exports.menuFact = menuFact
module.exports.litterTargets = litterTargets
module.exports.scaffoldShape = scaffoldShape
module.exports.LITTER_BAND_BASE = LITTER_BAND_BASE
module.exports.litterCell = litterCell
module.exports.bandOf = bandOf
module.exports.decorOpen = decorOpen
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
module.exports.progress = progress
module.exports.usable = usable
module.exports.kindOf = kindOf
module.exports.noteDry = noteDry
module.exports.placeFaced = placeFaced // g0z.50: the g0z.47 stairs reuse the faced placement
module.exports.placeStairs = placeStairs
module.exports.done = done
module.exports.castleBuilderCells = castleBuilderCells
module.exports.castleBuilderBatch = castleBuilderBatch
module.exports.CASTLE_BUILDER_KINDS = CASTLE_BUILDER_KINDS
module.exports.stateAt = stateAt
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
module.exports.tidyDue = tidyDue
module.exports.nearSite = nearSite
module.exports.tidyMs = tidyMs
module.exports.siteDist = siteDist
// Task executive (vmzq.2): prep remaining for the stall clock (cached 30 s).
module.exports.prepTargets = prepTargets
// Site storage (vmzq.39): stockpile reuses the stow ring and the door path.
module.exports.stowSpot = stowSpot
module.exports.onDoorPath = onDoorPath
