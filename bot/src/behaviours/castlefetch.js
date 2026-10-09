'use strict'

// castlefetch: source the next castle batch (idkcraft-g0z.4, design
// revision 2026-10-02). The castle step only runs with material on hand
// (g0z.3 menuFact word); this step fetches it, in source order:
//   1. the castle chest — a chest the owner placed on the castle site
//      (withdraw what he dropped there; never deposit castle stock in it);
//   2. inventory conversions through craftany (logs -> planks, planks ->
//      sticks -> fence, door, coal + stick -> torch);
//   3. the world — stone dug with the pickaxe (drop: cobblestone), logs
//      through the gather behaviour (planks/door/fence all start at logs).
// Batch, not per cell: a fetch runs until the kind's FETCH target (or the
// castle's whole remainder of it) is usable above the castle reserve, so
// the bot never shuttles per block. Nothing reachable fails the step: the
// goal hold parks it (bounded retry, goal.js CASTLEFETCH_RETRY_MS) so an
// owner restock resumes. A missing pickaxe ends the leg 'done' and equip
// (which only replaces an ABSENT pick) rearms before the next stone leg.

const Vec3 = require('vec3')
const { goals } = require('mineflayer-pathfinder')
const blueprint = require('../castle')
const castleMod = require('./castle')
const stockpileMod = require('./stockpile')
const danger = require('../danger')
const { countItems } = require('../perception')
const { canBreak, clearGoal, denyReason, logDeny, protectedReason } = require('./util')

// Stack-ish targets per kind (bead: ~64 cobble, ~16 logs' worth). Each is
// >= castle BATCH (door: its remainder is 1), so a fetch picked on a
// none/some word always has work: the word and the target never disagree.
// frame (g0z.12): one gather load — gather stops at NEED_LOGS, so a bigger
// target could never be met from the world (castle BATCH_OF.frame matches).
// pane (g0z.31): CHEST-ONLY — panes, else glass crafted 6 -> 16; no sand
// hunt, no smelt: an empty chest fails the leg into the retry hold.
// banner (g0z.32, g0z.35): chest first, then self-sourced (owner
// 2026-10-09) — 6 wool + 1 stick per banner, the wool through a self bring
// order (bannerTick), but only once the beds stand (beds first).
const FETCH = { stone: 64, planks: 32, door: 1, torch: 16, fence: 16, frame: castleMod.BATCH_OF.frame, chest: 1, pane: 16, banner: 2 }
// Batch yield (idkcraft-vmzq.20): a fetch leg hands a layable batch to the
// castle after this long instead of running to its full target. Five
// minutes ≈ one stone batch at the measured quarry rate, and bounds the
// castle<->castlefetch switch rate from below no matter how the words flap.
const LEG_MAX_MS = 5 * 60 * 1000
// One craft op per call; the next tick re-checks the target.
const CRAFT_COUNT = { planks: 4, door: 1, torch: 4, fence: 3, chest: 1, pane: 16, banner: 1 }
const BANNER_WOOL = 6 // one colour per banner (table recipe)
const DIG_RADIUS = 32
const FIND_COUNT = 4096
const STONE_BELOW = 2 // target y window around the site's ground (no shafts, no pillars)
const STONE_ABOVE = 3
const DIG_REACH = 4
const PICKUP_REACH = 2 // drops land where the block stood (equip lesson)
const EYE = 1.62 // eye over feet: trench reach is measured from it
const AIR_WAITS = 3 // ticks a dig waits for the feet to land
const APPROACH_WAITS = 30 // ticks walking to one target before it is skipped
const SKIPS_TO_FAIL = 3 // skipped targets before the leg fails unreachable
const NOGAIN_STRIKES = 5 // digs without the cobble count growing
const DIG_TIMEOUT_MS = 10000
const CHEST_REACH = stockpileMod.INTERACT_REACH
const CHEST_WAITS = 30 // ticks without closing in on the chest
const CHEST_TIMEOUT_MS = 15000
const SITE_TOP = 16
// Quarry (g0z.15, owner 2026-10-02): no exposed stone by the site -> an
// open trench next to it, a staircase down QUARRY_DEPTH below the site's
// ground, then level, QUARRY_W wide, cut top-down (dirt included).
// ponytail: four straight trenches (one per side) of QUARRY_LEN columns,
// ~6 stone per column -> roughly 1000 cobble; a v2 castle that exhausts
// them digs the second ring, not a new search.
// Second ring (idkcraft-vmzq.31): prod run6 trenched all four ring-0 sides
// into water and caves within ~4-12 columns (snapshot probe at the castle
// site: a lake, an aquifer, a cave mouth, a ravine edge) and the quarry
// never recovered — stone came only from the slower far fetch. Ring 1
// re-trenches each edge from its opposite lateral end once ring 0 is dead
// or dug; deeper is wetter on that ground (water below the staircase), so
// the next ring, not the next depth. Flat sides 0..7 (4..7 are ring 1).
const QUARRY_RINGS = 2
const QUARRY_GAP = 3 // trench start outside the footprint (v2: past the fence)
const QUARRY_DEPTH = 6
const QUARRY_LEN = 40
const QUARRY_W = 2
const QUARRY_TOP = 3 // a hill is cut up to site.y + this
const QUARRY_ADAPT = 8 // a trench starts at real ground up to this far below site level (dips, pad edges)
const QUARRY_TRIES = 3 // digs on one quarry cell before it is skipped
const QUARRY_NOGAIN = 4 * QUARRY_W * 3 // stone digs (~4 columns) with no cobble picked up
// Quarry-down pit (idkcraft-vmzq.46): prod run7 starved with all 8 trench
// sides dead (holes/water along the 40-column lines) and no exposed stone.
// The fallback digs a stepped pit at a dry spot near the site instead of a
// long line: a staircase PIT_DEPTH down (walkable out by construction — 1
// per column under the trench stance rule — on undug ground, which the
// spot layout and the dug-ground skip guarantee), then a PIT_ROOM room at
// the bottom, cut top-down through the dirt cap into stone. Spots ring the
// footprint at PIT_GAPS, nearest first, each probed dry before the first
// dig; liquid or a hole mid-pit abandons the spot and the next takes over.
const PIT_GAPS = [4, 6, 8, 10, 12]
const PIT_DEPTH = 8
const PIT_ROOM = 8
const PIT_LEN = PIT_DEPTH + PIT_ROOM
const PIT_MAX = 64 // persisted pit frames cap (memory.js sanitizes the same)
const LIQUID = new Set(['water', 'lava', 'bubble_column'])
// Pickaxe blocks a trench meets; anything else is dug bare-handed.
const ROCK = /stone|_ore$|granite|diorite|andesite|deepslate|tuff|calcite|basalt/

// Seams for unit tests (craftany and gather need a real recipe registry /
// a world); production reads the real modules lazily (gather -> goal cycle).
const deps = {
  craftItem: (...a) => require('./craftany')(...a),
  gather: (...a) => require('./gather')(...a),
}

function birchFirst(names) {
  return names.sort((a, b) => (b.startsWith('birch_') ? 1 : 0) - (a.startsWith('birch_') ? 1 : 0) || a.localeCompare(b))
}

function itemNames(bot, test) {
  const by = (bot && bot.registry && bot.registry.itemsByName) || {}
  return birchFirst(Object.keys(by).filter(test))
}

const isDoor = (n) => n.endsWith('_door') && n !== 'iron_door'
const isFence = (n) => n.endsWith('_fence') && n !== 'nether_brick_fence'
const isBanner = (n) => n.endsWith('_banner') && !n.endsWith('_wall_banner')

// What the chest yields for a kind, finished items first; planks also
// take logs (converted by the craft source next tick).
function chestNames(bot, kind) {
  if (kind === 'stone') return [[...blueprint.STONE_ITEMS]]
  if (kind === 'planks') return [itemNames(bot, (n) => n.endsWith('_planks')), itemNames(bot, (n) => n.endsWith('_log'))]
  if (kind === 'door') return [itemNames(bot, isDoor)]
  if (kind === 'fence') return [itemNames(bot, isFence)]
  if (kind === 'torch') return [['torch']]
  if (kind === 'frame') return [itemNames(bot, (n) => n.endsWith('_log'))]
  if (kind === 'chest') return [['chest']]
  if (kind === 'pane') return [itemNames(bot, (n) => blueprint.matches('pane', n)), ['glass']]
  if (kind === 'banner') return [itemNames(bot, (n) => blueprint.matches('banner', n)), itemNames(bot, (n) => n.endsWith('_wool'))]
  return []
}

function craftNames(bot, kind) {
  if (kind === 'planks') return itemNames(bot, (n) => n.endsWith('_planks'))
  if (kind === 'door') return itemNames(bot, isDoor)
  if (kind === 'fence') return itemNames(bot, isFence)
  if (kind === 'torch') return ['torch']
  if (kind === 'chest') return ['chest'] // 8 planks at a table (craftany crafts planks from logs)
  if (kind === 'pane') return ['glass_pane'] // 6 glass -> 16 at a table
  if (kind === 'banner') return itemNames(bot, isBanner) // 6 wool of one colour + 1 stick at a table
  return []
}

// The castle's open demand for a kind: { kind, short } where short is how
// many more usable items the batch needs. Null when the castle word is not
// a material word (none/parked/done/clear, or blocked with no gated kind). Shared by the goal
// gate and the behaviour, so the two never disagree.
function demand(bot, ctx) {
  // Bounded fetch hold (g0z.15): a failed leg rests CASTLEFETCH_RETRY_MS no
  // matter how the facts text moves — known=near/none flips released the
  // text-keyed goal hold every few seconds (g0z.12 rig churn).
  const sf = ctx && ctx.stepFail && ctx.stepFail.castlefetch
  if (sf && typeof sf.at === 'number' && Date.now() - sf.at <= require('../budget').CASTLEFETCH_RETRY_MS) return null
  let w = 'none'
  try { w = castleMod.menuFact(bot, ctx) } catch (_) { return null }
  let kind = null
  let word = null
  // Blocked (g0z.23): the gated kind (menuFact keeps it on castleWord)
  // still wants its batch while the build stands.
  if (w === 'blocked') {
    kind = ctx && ctx.castleWord && ctx.castleWord.kind
    if (!kind || !(kind in FETCH)) return null
    word = 'blocked'
  } else {
    const m = /^([a-z]+)-(none|some|batch)$/.exec(w)
    if (!m || !(m[1] in FETCH)) return null
    kind = m[1]
    word = m[2]
  }
  const cw = ctx && ctx.castleWord
  const left = cw && cw.kind === kind && typeof cw.left === 'number' ? cw.left : castleMod.BATCH
  const target = Math.min(FETCH[kind], left)
  // Raw items: below the reserve the reserve refills first (never laid).
  return { kind, word, short: Math.max(0, target + castleMod.reserveOf(kind) - castleMod.held(bot, kind)) }
}

function bodyPos(bot) {
  const p = bot && bot.entity && bot.entity.position
  return p && typeof p.x === 'number' ? p : null
}

function hasPickaxe(bot) {
  return countItems(bot, (n) => n.endsWith('_pickaxe')) > 0
}

function cobble(bot) {
  return countItems(bot, blueprint.isStone) // vmzq.38: a granite dig is a gain
}

// Per-leg time split (idkcraft-vmzq.20 nudge2): every digTick lands in
// exactly one bucket — dig (a dig issued this tick), walk (a walk
// issued), other (admin/terminal/craft ticks) — so the rig can see where
// the quarry's ticks go. Lazily initialised: unit fakes pass a bare {}.
function spend(f, bucket) {
  try {
    const s = f.spend || (f.spend = { dig: 0, walk: 0, other: 0 })
    if (s && typeof s[bucket] === 'number') s[bucket]++
  } catch (_) { /* counters best-effort */ }
}

// Quarry output on hand (null when unreadable): the leg-over line diffs
// it against the leg-start count, so dig-ticks-per-block is measurable.
function blocksOnHand(bot) {
  try {
    return countItems(bot, (n) => blueprint.isStone(n) || n === 'dirt')
  } catch (_) { return null }
}

// Site box with a one-block margin, foundation layers included: never dig
// the castle's own ground or walls for its stone.
function onSite(st, p, margin = 1, below = 3) {
  const { w, d } = blueprint.siteDimensions(st.rot | 0, st.blueprintVersion)
  const dx = Math.floor(p.x) - st.site.x
  const dy = Math.floor(p.y) - st.site.y
  const dz = Math.floor(p.z) - st.site.z
  return dx >= -margin && dx < w + margin && dz >= -margin && dz < d + margin && dy >= -below && dy <= SITE_TOP
}

// The castle chest: a chest standing on the castle site.
// ponytail: any chest in the footprint; g0z.11's storeroom 'chest' cell is
// one of those, so it needs no second lookup.
function castleChest(bot, st) {
  try {
    const e = bot.registry && bot.registry.blocksByName && bot.registry.blocksByName.chest
    if (!e || typeof bot.findBlocks !== 'function') return null
    const hits = bot.findBlocks({ matching: e.id, maxDistance: 64, count: 16 }) || []
    const p = hits.find((q) => q && onSite(st, q, 0, 0))
    return p ? new Vec3(p.x, p.y, p.z) : null
  } catch (_) { return null }
}

function finish(bot, ctx, status) {
  const f = ctx.castleFetch
  if (status === 'done') ctx.castleFetchDry = null // a leg that got stock retires the dry mark
  if (f && f.spend) {
    let delta = '?'
    try {
      const now = blocksOnHand(bot)
      delta = (typeof f.blocks0 === 'number' && typeof now === 'number')
        ? ((now - f.blocks0 >= 0 ? '+' : '') + (now - f.blocks0))
        : String(now)
    } catch (_) { /* delta best-effort */ }
    let wall = '?'
    try { wall = (typeof f.t0 === 'number' ? Math.round((Date.now() - f.t0) / 1000) + 's' : '?') } catch (_) { /* wall best-effort */ }
    try { console.log(`castlefetch ${f.kind || '?'}: leg over (${status}) ticks dig=${f.spend.dig | 0} walk=${f.spend.walk | 0} other=${f.spend.other | 0} starts=${f.starts | 0} dug=${f.dug | 0} blocks=${delta} wall=${wall}`) } catch (_) { /* log best-effort */ }
  }
  if (status !== 'done') {
    try { console.log(`castlefetch ${status}`) } catch (_) { /* log best-effort */ }
  }
  ctx.stepStatus = status
  ctx.castleFetch = null
  clearGoal(bot, ctx)
}

// (Re)issue the walk: a new key, or our goal was replaced/cleared (another
// step ran in between and left lastGoalKey alone — rig: a second chest leg
// after the light step never walked).
// xz: a far walk ignores y (vmzq.35, the castle far walk's vmzq.29 fix): a
// y-aware goal into unloaded chunks 500 off climbs from a cave and wedges.
function walkTo(bot, ctx, key, p, range, xz = false) {
  let ours = false
  try { ours = !!ctx.castleFetchGoal && bot.pathfinder.goal === ctx.castleFetchGoal } catch (_) { ours = false }
  if (ctx.lastGoalKey === key && ours) return
  try {
    ctx.castleFetchGoal = xz ? new goals.GoalNearXZ(p.x, p.z, range) : new goals.GoalNear(p.x, p.y, p.z, range)
    bot.pathfinder.setGoal(ctx.castleFetchGoal)
  } catch (_) { /* retry next tick */ }
  ctx.lastGoalKey = key
}

// Walk patience that only counts ticks without closing in (a far target
// stays walkable while the bot approaches). True once spent.
function stalled(w, dist, limit) {
  if (dist < (w.best == null ? Infinity : w.best) - 1) { w.best = dist; w.waits = 0 }
  return ++w.waits > limit
}

// One async op at a time under ctx.castleFetchInFlight, with a deadline:
// a hung window or dig must never wedge the flag (the step would read
// feasible and never move). Settles quietly; the sync tick decides.
function flight(ctx, run, ms, onFail, onOk) {
  ctx.castleFetchInFlight = true
  const timeout = new Promise((_, reject) => {
    const tm = setTimeout(() => reject(new Error('timeout')), ms)
    if (tm && typeof tm.unref === 'function') tm.unref()
  })
  Promise.race([run(), timeout]).then(() => { try { if (onOk) onOk() } catch (_) { /* ok-hook best-effort */ } }).catch(() => { if (onFail) onFail() }).finally(() => { ctx.castleFetchInFlight = false })
}

function near(bot, p, reach) {
  const bp = bodyPos(bot)
  return !!bp && Math.hypot(bp.x - (p.x + 0.5), bp.y - (p.y + 0.5), bp.z - (p.z + 0.5)) <= reach
}

// Source 1: the castle chest. Returns true while it owns the tick.
function chestTick(bot, ctx, f, d) {
  if (f.chestDone) return false
  // Reserved slot (g0z.26 R2): drawing from the owner's chest into a
  // reserved pack would fill the bootstrap slot — skip the source this leg
  // (the stock stays in the chest, nothing is lost).
  try {
    const stockpile = require('./stockpile')
    if (stockpile && typeof stockpile.slotReserved === 'function' && stockpile.slotReserved(bot, ctx)) {
      f.chestDone = true
      return false
    }
  } catch (_) { /* reserve unreadable: draw as before */ }
  const at = f.chest || (f.chest = castleChest(bot, ctx.castle))
  if (!at) { f.chestDone = true; return false }
  if (!near(bot, at, CHEST_REACH)) {
    walkTo(bot, ctx, `castlefetch-chest:${at.x},${at.y},${at.z}`, at, 2)
    // Stalled walk only (a far chest stays walkable while the bot closes in).
    const bp = bodyPos(bot)
    const dd = bp ? Math.hypot(bp.x - at.x, bp.y - at.y, bp.z - at.z) : Infinity
    if (stalled(f.chestWalk || (f.chestWalk = {}), dd, CHEST_WAITS)) f.chestDone = true // unreachable: next source
    return true
  }
  f.chestDone = true // one withdraw per leg: an empty chest falls through
  ctx.castleFetchFlight = 'chest' // time-split label: in-flight ticks bucket below
  flight(ctx, async () => {
    let need = d.short
    for (const names of chestNames(bot, d.kind)) {
      if (need <= 0 || names.length === 0) break
      // Planks' second list is logs: one log is four planks; panes' is
      // glass: six glass are sixteen panes (one craft).
      const logs = d.kind === 'planks' && names.some((n) => n.endsWith('_log'))
      const glass = d.kind === 'pane' && names[0] === 'glass'
      // Banners' is wool (g0z.35): six per banner, only once the beds stand.
      const wool = d.kind === 'banner' && names[0].endsWith('_wool')
      if (wool && !bannerSelf(bot, ctx)) break
      const r = await stockpileMod.withdrawAnyFromChest(bot, ctx, names, logs ? Math.ceil(need / 4) : glass ? 6 * Math.ceil(need / 16) : wool ? BANNER_WOOL * Math.ceil(need) : need, at)
      need -= (r && r.got ? r.got : 0) * (logs ? 4 : glass ? 16 / 6 : wool ? 1 / BANNER_WOOL : 1)
    }
  }, CHEST_TIMEOUT_MS)
  return true
}

// Source 2: craft from the pack. Returns true while it owns the tick.
function craftTick(bot, ctx, f, d) {
  const names = craftNames(bot, d.kind)
  if (names.length === 0 || f.craftOut) return false
  if (d.kind === 'banner' && !bannerSelf(bot, ctx)) return false // beds first: the wool is theirs
  if (d.kind === 'torch' && countItems(bot, (n) => n === 'coal' || n === 'charcoal') <= require('./light').COAL_RESERVE) return false // smelting's coal floor
  let r = null
  try { r = deps.craftItem(bot, ctx, names, CRAFT_COUNT[d.kind] || 1) } catch (_) { r = { done: false } }
  if (r === 'running') return true
  if (r && r.done) return true // re-check the target next tick
  f.craftOut = true // the pack cannot fund it: fall through to the world
  return false
}

// Beds first (g0z.35): the banner self-source (hunt, chest wool, craft)
// runs only when the residence owes no bed — STEP_ORDER ranks castlefetch
// above beds, so the gate lives here, not in the arbiter.
function bannerSelf(bot, ctx) {
  try { return require('./beds').bedsFact(bot, ctx && ctx.home) === 'both' } catch (_) { return false }
}

// Self-source seam (g0z.35, owner 2026-10-09: the castle chest is only the
// first source). A leg opens a self bring order (the beds woolTick shape):
// bring's ticker runs it over every goal step, caps the search to the
// anchor, cancels at dusk and keeps the goods in the pack. The leg keeps
// the order on f.hunt and returns while ctx.bring is set (castleFetchGo
// stays true on the short demand, so the arbiter keeps the step); once
// ctx.bring is null again selfOrderBack reads it back.
function selfOrder(ctx, f, o) {
  o.self = 'castle'
  f.hunt = o
  ctx.bring = o
}

// null when no order was opened; else { exhausted } (refuseExhausted's
// searchLegs: the whole budget searched, timed out, or capped).
function selfOrderBack(f) {
  const o = f.hunt
  if (!o) return null
  f.hunt = null
  let exhausted = false
  try {
    const s = o.searchLegs || {}
    const budget = (require('./bring').SEARCH_BUDGET || {}).legs || 24
    exhausted = (s.legs || 0) >= budget || !!s.timedOut || !!s.capped
  } catch (_) { /* unreadable order: not exhausted */ }
  return { exhausted }
}

// Banner world source (g0z.35): wool through a self hunt, then craftTick.
// One sheep latch for every wool hunt in the bot (beds' noWool, 9qt0).
// ponytail: no reopen counter — the 5-min failed-leg hold is the bounded retry.
function bannerTick(bot, ctx, f, d) {
  if (ctx.bring) return // the ticker runs the hunt (ours or foreign)
  const bedsMod = require('./beds')
  const dry = (why) => { ctx.castleFetchDry = 'banner'; finish(bot, ctx, `failed:castlefetch-${why}`) }
  const top = require('./wool').topWoolColor(bot)
  const held = top ? top.count : 0
  const back = selfOrderBack(f)
  if (back) {
    if (back.exhausted) bedsMod.noteNoWool(ctx.beds && typeof ctx.beds === 'object' ? ctx.beds : (ctx.beds = {}))
    if (held >= BANNER_WOOL) { f.craftOut = false; return } // craft next tick
    dry('no-wool') // short, cancelled (dusk) or refused
    return
  }
  if (held >= BANNER_WOOL) { dry('craft-banner'); return } // wool on hand, craft failed (table, reach): never a second hunt
  const t = bot && bot.time && bot.time.timeOfDay
  if (typeof t === 'number' && t >= 12000) { dry('no-wool'); return } // day-only: bring would cancel at once
  if (bedsMod.sheepLatched(ctx, bot)) { dry('no-wool'); return }
  const bringMod = require('./bring')
  const want = Math.max(1, BANNER_WOOL * Math.ceil(d.short) - held) // tops up the top colour (did.3)
  const base = { kind: 'item', name: 'wool', names: bedsMod.WOOL16.slice(), want, by: null, drop: null, have: 0 }
  let o = null
  try {
    o = countItems(bot, (n) => n.endsWith('_wool')) > 0 ? bringMod.toWoolHunt(bot, base) : { ...base, phase: bringMod.openPhase(ctx), announced: false }
  } catch (_) { o = null }
  if (!o) { dry('no-wool'); return }
  try { console.log(`castlefetch banner: hunting ${want} wool`) } catch (_) { /* log best-effort */ }
  selfOrder(ctx, f, o)
}

// Exposed stone only (revmux 01): air above, or air on a side — surface
// rock, cliffs, walk-in cave mouths, within a few blocks of the feet level. Buried stone would make the walk dig a shaft
// down to it. findBlocks collects every stone of the sections it visits,
// so a wide count costs one sort, not a wider scan; the exposure filter
// is two-ish blockAt per candidate. Nearest first, never the site, a
// danger spot, or our own feet column.
const EXPOSE = [[0, 1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]]
const AIRISH = new Set(['air', 'cave_air'])
// Shared stone acceptance (R2 core-2): the ground window, exposure,
// danger and break checks in one predicate so pickStone and the
// watchdog's live scan accept the same blocks. gy is the ground anchor
// (the site y, or the latched far candidate's y inside a far leg). at
// resolves the block (pickStone's stoneAt); default is bot.blockAt.
function acceptStone(bot, ctx, p, gy, at) {
  try {
    if (!bot || !p || typeof p.x !== 'number' || typeof p.y !== 'number' || typeof p.z !== 'number') return false
    if (typeof gy !== 'number') return false
    if (p.y < gy - STONE_BELOW || p.y > gy + STONE_ABOVE) return false
    const open = EXPOSE.some(([x, y, z]) => {
      try { const n = bot.blockAt(new Vec3(p.x + x, p.y + y, p.z + z)); return !!n && AIRISH.has(n.name) } catch (_) { return false }
    })
    if (!open) return false
    try { if (danger.near(ctx, p)) return false } catch (_) { return false }
    let b = null
    try {
      b = typeof at === 'function' ? at(p) : bot.blockAt(new Vec3(p.x, p.y, p.z))
    } catch (_) { b = null }
    if (!b) return false
    try { if (!canBreak(bot, b, ctx)) return false } catch (_) { return false }
    return true
  } catch (_) {
    return false
  }
}
function pickStone(bot, ctx, f, bp, stoneAt) {
  const e = bot.registry && bot.registry.blocksByName && bot.registry.blocksByName.stone
  let found = []
  // Around the SITE (g0z.15): the window below is the site's, so a search
  // around a far body found nothing ever (prod: 14 instant no-stone).
  // (.22) a castlefetch-far unlock searches around the known candidate
  // instead (the live exposed stone the table validated), anchored on the
  // candidate's ground — latched onto the leg, so re-picks after each dug
  // block keep searching the candidate ground until the leg ends.
  let c = siteCenter(ctx.castle)
  let gy = ctx.castle.site.y
  let cand = null
  try {
    const { goalUnlock } = require('../goal-unlock')
    cand = goalUnlock(ctx, 'candidate')
  } catch (_) { cand = null }
  if (cand && typeof cand.x === 'number' && typeof cand.z === 'number') {
    f.farCandidate = { x: cand.x, y: cand.y, z: cand.z }
  } else if (f.farCandidate && typeof f.farCandidate.x === 'number') {
    cand = f.farCandidate
  } else {
    cand = null
  }
  if (cand) {
    c = { x: cand.x, y: typeof cand.y === 'number' ? cand.y : gy, z: cand.z }
    if (typeof cand.y === 'number') gy = cand.y
  }
  try { found = (e && bot.findBlocks({ point: new Vec3(c.x, c.y, c.z), matching: e.id, maxDistance: DIG_RADIUS, count: FIND_COUNT })) || [] } catch (_) { found = [] }
  const fx = Math.floor(bp.x)
  const fy = Math.floor(bp.y) // own feet column only
  const fz = Math.floor(bp.z)
  let best = null
  for (const p of found) {
    const k = `${p.x},${p.y},${p.z}`
    if (f.skip.has(k) || onSite(ctx.castle, p) || inTrench(ctx.castle, p)) continue
    if (p.x === fx && p.z === fz && p.y < fy) continue
    const d = Math.hypot(p.x - bp.x, p.y - bp.y, p.z - bp.z)
    if (best && d >= best.d) continue
    // Ground window + exposure + danger + break (R2 core-2): the shared
    // predicate, so the watchdog's live scan accepts the same blocks.
    // Anchored on the site (or the far candidate), never the live feet —
    // a pick made from inside our own quarry pit would ratchet the
    // window down a layer per pick.
    if (!acceptStone(bot, ctx, p, gy, stoneAt)) continue
    best = { x: p.x, y: p.y, z: p.z, k, d, waits: 0 }
  }
  return best
}

function siteCenter(st) {
  const { w, d } = blueprint.siteDimensions(st.rot | 0, st.blueprintVersion)
  return { x: st.site.x + Math.floor(w / 2), y: st.site.y, z: st.site.z + Math.floor(d / 2) }
}

// Trench side s (0..3) on ring (0..1, vmzq.31): origin column just
// outside the footprint near a corner (the entrance sits mid-side, never
// in front of it), the outward direction and the width axis. Ring 1 works
// the same edge from its opposite lateral end — fresh ground at the same
// outward gap (shifting the origin outward would re-dig the ring-0 line:
// the trench runs outward, so the lines would overlap 36 of 40 columns).
function quarrySide(st, s, ring = 0) {
  const { w, d } = blueprint.siteDimensions(st.rot | 0, st.blueprintVersion)
  const { x: sx, z: sz } = st.site
  const g = QUARRY_GAP + 1
  const r1 = (ring | 0) === 1
  if (s === 0) return { x: sx - g, z: r1 ? sz + d - 2 - QUARRY_W : sz + 2, dx: -1, dz: 0, lx: 0, lz: 1 }
  if (s === 1) return { x: sx + w - 1 + g, z: r1 ? sz + 2 : sz + d - 2 - QUARRY_W, dx: 1, dz: 0, lx: 0, lz: 1 }
  if (s === 2) return { x: r1 ? sx + 2 : sx + w - 2 - QUARRY_W, z: sz - g, dx: 0, dz: -1, lx: 1, lz: 0 }
  return { x: r1 ? sx + w - 2 - QUARRY_W : sx + 2, z: sz + d - 1 + g, dx: 0, dz: 1, lx: 1, lz: 0 }
}

function stairFloor(base, i, depth) {
  return base - 1 - Math.min(i, depth - 1)
}

function trenchFloor(st, i, base) {
  return (base == null ? st.site.y : base) - 1 - Math.min(i, QUARRY_DEPTH - 1)
}

function pitFloor(base, i) {
  return stairFloor(base, i, PIT_DEPTH)
}

// A trench cell or the block a trench stance stands on (revmux 01): the
// exposed-stone pick must never undermine our own staircase. The band runs
// QUARRY_ADAPT below the unadapted floor: an adapted trench digs there.
// Both rings (vmzq.31): the opposite-end staircase is ours too.
function inTrench(st, p) {
  for (let ring = 0; ring < QUARRY_RINGS; ring++) {
  for (let s = 0; s < 4; s++) {
    const o = quarrySide(st, s, ring)
    const i = (p.x - o.x) * o.dx + (p.z - o.z) * o.dz
    const l = (p.x - o.x) * o.lx + (p.z - o.z) * o.lz
    if (i >= 0 && i < QUARRY_LEN && l >= 0 && l < QUARRY_W && p.y >= trenchFloor(st, i) - 1 - QUARRY_ADAPT && p.y <= st.site.y + QUARRY_TOP) return true
  }
  }
  // Latched pit frames (vmzq.46) are ours too — scan-dead ones included,
  // their dug cells stay ours (probe-dead spots latch nothing).
  try {
    const pits = Array.isArray(st.quarryPits) ? st.quarryPits : []
    for (const e of pits) {
      if (!e || !Number.isInteger(e.base) || typeof e.x !== 'number' || typeof e.z !== 'number') continue
      const dx = e.dx | 0
      const dz = e.dz | 0
      const lx = Number.isInteger(e.lx) ? e.lx : (dx === 0 ? 1 : 0)
      const lz = Number.isInteger(e.lz) ? e.lz : (dz === 0 ? 1 : 0)
      const i = (p.x - e.x) * dx + (p.z - e.z) * dz
      const l = (p.x - e.x) * lx + (p.z - e.z) * lz
      if (i >= 0 && i < PIT_LEN && l >= 0 && l < QUARRY_W && p.y >= pitFloor(e.base, i) - 1 - QUARRY_ADAPT && p.y <= st.site.y + QUARRY_TOP) return true
    }
  } catch (_) { /* pits best-effort */ }
  return false
}

// The staircase cell scan for the quarry-down pits (vmzq.46): columns run
// outward from o over len, the floor stepping down 1 per column to depth
// below base, cut top-down (dirt included). The ring trenches intentionally
// keep master's inline scan verbatim (normal-pad parity by construction);
// only pits call this helper. Returns { cell } for the next cell to dig
// (the trench {quarry, stance} shape — stance is the previous column's
// floor, same lane, so the bot walks down the staircase and every dug cell
// sits within pickup reach of a stance), { dead, why } when liquid, a hole
// or a protected place kills the line mid-way, or { dead: false } when it
// is dug out. A protected block type (a path, a ruin block) is stepped
// around, never dug.
function scanStairCells(bot, ctx, f, o, len, depth, base) {
  const at = (x, y, z) => { try { return bot.blockAt(new Vec3(x, y, z)) } catch (_) { return null } }
  const wet = (b) => !!b && LIQUID.has(b.name)
  const open = (b) => !!b && (AIRISH.has(b.name) || b.boundingBox === 'empty') && !wet(b)
  for (let i = 0; i < len; i++) {
    const floor = stairFloor(base, i, depth)
    for (let l = 0; l < QUARRY_W; l++) {
      const cx = o.x + o.dx * i + o.lx * l
      const cz = o.z + o.dz * i + o.lz * l
      const below = at(cx, floor - 1, cz)
      if (!below || open(below) || wet(below)) {
        return { dead: true, why: `${below ? (wet(below) ? 'water' : 'hole') : 'void'} under column ${i} floor at ${cx} ${floor - 1} ${cz}` }
      }
    }
    for (let y = base + QUARRY_TOP; y >= floor; y--) {
      for (let l = 0; l < QUARRY_W; l++) {
        const x = o.x + o.dx * i + o.lx * l
        const z = o.z + o.dz * i + o.lz * l
        const k = `${x},${y},${z}`
        const b = at(x, y, z)
        if (!b || wet(b)) return { dead: true, why: `${b ? 'wet' : 'void'} at ${k}` }
        if (open(b) || f.skip.has(k)) continue
        if (EXPOSE.concat([[0, -1, 0]]).some(([ex, ey, ez]) => wet(at(x + ex, y + ey, z + ez)))) {
          return { dead: true, why: `liquid by ${k}` }
        }
        if (protectedReason(bot, b, ctx)) {
          // Where (house apron, castle) kills the line; what (a path,
          // a ruin block) is stepped around.
          if (protectedReason(bot, { name: 'dirt', position: b.position }, ctx)) {
            return { dead: true, why: `protected place at ${k}` }
          }
          f.skip.add(k)
          continue
        }
        // Stance (idkcraft-vmzq.25): the previous column's floor, same
        // lane, reached by walking down the staircase. A walk to the cell
        // itself (ground level, the bot deep in the trench) pillared up
        // out of the trench and the quarry re-dug the pillar (rig: 161
        // digs for 115 cells). Column i's drops rest on its floor, the
        // stance the next column is dug from. A cell out of eye reach
        // from its stance (a hill top or a leaf over a deep column) stays
        // standing: walking up to it pillared the same way (rig). A stance
        // that is not open body room (a stepped-around path, a skipped
        // cell, column 0's outside cell) is never walked into (revmux 01:
        // range 0 would dig it): that cell walks to itself as before.
        let stance = { x: o.x + o.dx * (i - 1) + o.lx * l, y: i === 0 ? base : stairFloor(base, i - 1, depth), z: o.z + o.dz * (i - 1) + o.lz * l }
        if (!open(at(stance.x, stance.y, stance.z)) || !open(at(stance.x, stance.y + 1, stance.z))) stance = null
        else if (Math.hypot(stance.x - x, stance.y + EYE - (y + 0.5), stance.z - z) > DIG_REACH + 0.5) { f.skip.add(k); continue }
        return { cell: { x, y, z, k, d: 0, waits: 0, quarry: true, tries: 0, stance } }
      }
    }
  }
  return { dead: false, why: '' } // dug out
}

// Pit spots (vmzq.46): mid-side laterals (between the ring-0/ring-1 trench
// lanes) plus diagonal-corner origins, at every PIT_GAPS distance outside
// the footprint, nearest first. Every spot band stays OFF the 8 trench
// lanes (revmux 01 major: the first layout sat all 40 spots on the dead
// lanes' columns and re-dug them deeper instead of finding dry ground).
// The room runs outward like a trench; the stairs bottom out PIT_DEPTH
// down within PIT_DEPTH of the origin, so the pit digs down in place.
function pitSpots(st) {
  const { w, d } = blueprint.siteDimensions(st.rot | 0, st.blueprintVersion)
  const { x: sx, z: sz } = st.site
  const midX = sx + Math.floor((w - QUARRY_W) / 2) // N/S sides run along z
  const midZ = sz + Math.floor((d - QUARRY_W) / 2) // W/E sides run along x
  // The gate side never pits (revmux 02 major): a mid-side pit straight out
  // from the door digs up the approach. Entrance faces -z/+x/+z/-x for rot
  // 0/1/2/3 (the rotatePlan convention); corners stay (off the axis).
  const gate = [[0, -1], [1, 0], [0, 1], [-1, 0]][((st.rot | 0) % 4 + 4) % 4]
  const spots = []
  for (const g of PIT_GAPS) {
    for (const m of [
      { x: sx - g, z: midZ, dx: -1, dz: 0, lx: 0, lz: 1 }, // west mid-side
      { x: sx + w - 1 + g, z: midZ, dx: 1, dz: 0, lx: 0, lz: 1 }, // east mid-side
      { x: midX, z: sz - g, dx: 0, dz: -1, lx: 1, lz: 0 }, // north mid-side
      { x: midX, z: sz + d - 1 + g, dx: 0, dz: 1, lx: 1, lz: 0 }, // south mid-side
    ]) {
      if (m.dx === gate[0] && m.dz === gate[1]) continue
      spots.push(m)
    }
    spots.push(
      { x: sx - g, z: sz - g, dx: -1, dz: 0, lx: 0, lz: 1 }, // NW corner, run west
      { x: sx + w - 1 + g, z: sz - g, dx: 1, dz: 0, lx: 0, lz: 1 }, // NE corner, run east
      { x: sx - g, z: sz + d - 1 + g, dx: -1, dz: 0, lx: 0, lz: 1 }, // SW corner, run west
      { x: sx + w - 1 + g, z: sz + d - 1 + g, dx: 1, dz: 0, lx: 0, lz: 1 }, // SE corner, run east
    )
  }
  return spots
}

function pitKey(o) {
  return `${o.x},${o.z},${o.dx},${o.dz}`
}

// The next pit cell to dig (vmzq.46): the first live frame in spot order —
// a latched frame resumes, a fresh spot is probed (the trench probe: real
// ground, solid under, dry head) and latched. A spot whose scan finds
// liquid, a hole or a protected place is abandoned for the leg and
// persisted dead on the castle (its ground truth does not change);
// probe-dead spots stay unlatched and re-probe next leg (trench semantics —
// their ground was never dug, so no frame can walk). Dug-out pits re-scan
// cheap and are never persisted dead: a leg that could not walk to its
// cells reads dug out without being empty. Fresh spots never probe our own
// dug ground (revmux 01 major: a probe on a dug trench/pit floor latches
// low and the seam step out is 2 high) — the spot layout already avoids
// the trench lanes; the inTrench skip covers earlier pits' bands.
function pickPit(bot, ctx, f) {
  const st = ctx.castle
  const p = f.pit || (f.pit = { dead: [] })
  const at = (x, y, z) => { try { return bot.blockAt(new Vec3(x, y, z)) } catch (_) { return null } }
  const wet = (b) => !!b && LIQUID.has(b.name)
  const open = (b) => !!b && (AIRISH.has(b.name) || b.boundingBox === 'empty') && !wet(b)
  let stored = null
  try {
    stored = Array.isArray(st.quarryPits) ? st.quarryPits : (st.quarryPits = [])
  } catch (_) { stored = [] }
  const byKey = new Map()
  for (const e of stored) {
    if (e && typeof e.x === 'number' && typeof e.z === 'number') byKey.set(`${e.x},${e.z},${e.dx},${e.dz}`, e)
  }
  for (const o of pitSpots(st)) {
    const key = pitKey(o)
    if (p.dead.includes(key)) continue
    const entry = byKey.get(key)
    if (entry && entry.dead) continue // a drowned/holed pit stays abandoned
    // Outside the footprint and the door path (both lie inside it).
    if (blueprint.inFootprint(st, { x: o.x, y: st.site.y, z: o.z })) continue
    if (blueprint.inFootprint(st, { x: o.x + o.dx * (PIT_LEN - 1), y: st.site.y, z: o.z + o.dz * (PIT_LEN - 1) })) continue
    let frame = entry && Number.isInteger(entry.base) ? entry : null
    if (!frame) {
      if (inTrench(st, { x: o.x, y: st.site.y, z: o.z }) ||
          inTrench(st, { x: o.x + o.dx * (PIT_LEN - 1), y: st.site.y, z: o.z + o.dz * (PIT_LEN - 1) })) {
        p.dead.push(key)
        try { console.log(`castlefetch pit spot ${o.x} ${o.z} skipped (dug ground)`) } catch (_) { /* log best-eff */ }
        continue
      }
      let why = null
      let whyAt = null
      let liquid = false
      let g = null
      for (let y = st.site.y + QUARRY_TOP; y >= st.site.y - QUARRY_ADAPT; y--) {
        const b = at(o.x, y, o.z)
        if (!b) { why = 'void'; whyAt = [o.x, y, o.z]; break }
        if (wet(b)) { liquid = true; continue }
        if (!open(b)) { g = y; break }
      }
      if (!why && g == null) { why = liquid ? 'wet' : 'hole'; whyAt = [o.x, st.site.y, o.z] }
      if (!why) {
        const under = at(o.x, g - 1, o.z)
        const head = at(o.x, g + 1, o.z)
        if (!under || open(under)) { why = 'hole'; whyAt = [o.x, g - 1, o.z] }
        else if (wet(under) || wet(head)) { why = 'wet'; whyAt = [o.x, g, o.z] }
      }
      if (why) {
        p.dead.push(key)
        try { console.log(`castlefetch pit spot ${o.x} ${o.z} unusable (${why} at ${whyAt[0]} ${whyAt[1]} ${whyAt[2]})`) } catch (_) { /* log best-eff */ }
        continue
      }
      frame = { x: o.x, z: o.z, dx: o.dx, dz: o.dz, lx: o.lx, lz: o.lz, base: g + 1, dead: false }
      if (stored.length < PIT_MAX) {
        try { stored.push(frame) } catch (_) { /* latch best-effort */ }
        byKey.set(key, frame)
      }
      try { console.log(`castlefetch pit live at ${o.x} ${frame.base} ${o.z}`) } catch (_) { /* log best-eff */ }
    }
    const r = scanStairCells(bot, ctx, f, o, PIT_LEN, PIT_DEPTH, frame.base)
    if (r.cell) {
      r.cell.pit = true
      return r.cell
    }
    p.dead.push(key)
    if (r.dead) {
      try { frame.dead = true } catch (_) { /* latch best-effort */ }
    }
    try { console.log(`castlefetch pit at ${o.x} ${frame.base} ${o.z} ${r.dead ? `abandoned (${r.why})` : 'dug out'}`) } catch (_) { /* log best-eff */ }
  }
  return null
}

// The next trench cell to dig: the first solid cell in dig order on the
// first live side. A side dies for this leg on liquid at or by a cell, a
// hole under the floor or a protected place (house apron, castle) — the
// next side takes over; a protected block type (a path) is stepped
// around. Stance rules are checked at dig time (they depend on where we
// stand). Recomputed from the world every pick and per leg (revmux 01: no
// session latch) — a restart or a retry resumes the same trench.
// Flat sides 0..7 across QUARRY_RINGS (vmzq.31): ring 1 (4..7) is only
// reached when every ring-0 side is dead or dug, nearest stone first.
function pickQuarry(bot, ctx, f) {
  const st = ctx.castle
  const q = f.quarry || (f.quarry = { dead: [], level: [null, null, null, null, null, null, null, null], said: [] })
  const at = (x, y, z) => { try { return bot.blockAt(new Vec3(x, y, z)) } catch (_) { return null } }
  const wet = (b) => !!b && LIQUID.has(b.name)
  const open = (b) => !!b && (AIRISH.has(b.name) || b.boundingBox === 'empty') && !wet(b)
  for (let rs = 0; rs < QUARRY_RINGS * 4; rs++) {
    if (q.dead.includes(rs)) continue
    const ring = rs >> 2
    const s = rs & 3
    const tag = ring === 0 ? `side ${s}` : `side ${s} ring 1`
    const o = quarrySide(st, s, ring)
    // Adaptive start (idkcraft-vmzq.20): the ring assumes flat ground at
    // site level, but a pad edge or a dip hangs the origin in air — rig
    // cycle 7 died all four sides this way and failed no-stone twice.
    // Scan down for real ground and start the staircase there; liquid in
    // the working band, or no ground in range, still kills the side.
    let base = null
    let why = null
    let whyAt = null
    let probed = false
    if (Array.isArray(st.quarryBase) && Number.isInteger(st.quarryBase[rs])) {
      base = st.quarryBase[rs] // latched: resume the same frame, no re-probe
    } else {
      probed = true
      let liquid = false
      let g = null
      for (let y = st.site.y + QUARRY_TOP; y >= st.site.y - QUARRY_ADAPT; y--) {
        const b = at(o.x, y, o.z)
        if (!b) { why = 'void'; whyAt = [o.x, y, o.z]; break }
        if (wet(b)) { liquid = true; continue }
        if (!open(b)) { g = y; break }
      }
      if (!why && g == null) { why = liquid ? 'wet' : 'hole'; whyAt = [o.x, st.site.y, o.z] }
      if (!why) {
        const under = at(o.x, g - 1, o.z)
        const head = at(o.x, g + 1, o.z)
        if (!under || open(under)) { why = 'hole'; whyAt = [o.x, g - 1, o.z] }
        else if (wet(under) || wet(head)) { why = 'wet'; whyAt = [o.x, g, o.z] }
        else base = g + 1
      }
    }
    if (why) {
      q.dead.push(rs)
      try { console.log(`castlefetch quarry ${tag} unusable (${why} at ${whyAt[0]} ${whyAt[1]} ${whyAt[2]})`) } catch (_) { /* log best-eff */ }
      continue
    }
    // Latched, never re-probed: our own dug floors read as ground, so a
    // fresh probe every leg would walk the staircase down one level per
    // leg and eat the stance floors (castle-fetch trench regression). The
    // latch rides the persisted castle (memory.js), so a restart resumes
    // the same frame; a side that dies stays unlatched and re-probes next
    // leg (a transient void revives). Pre-latch trenches (dug before this
    // change) shift one level on first probe, then hold.
    if (probed) {
      // Grows a pre-ring latch (4 entries) to 8 in place (vmzq.31): ring-0
      // frames keep their indices, ring 1 latches at 4..7.
      if (!Array.isArray(st.quarryBase)) {
        try { st.quarryBase = [null, null, null, null, null, null, null, null] } catch (_) { /* latch best-effort */ }
      } else {
        try { while (st.quarryBase.length < QUARRY_RINGS * 4) st.quarryBase.push(null) } catch (_) { /* grow best-effort */ }
      }
      if (Array.isArray(st.quarryBase) && st.quarryBase.length >= QUARRY_RINGS * 4) st.quarryBase[rs] = base
    }
    if (!Array.isArray(q.level)) q.level = [null, null, null, null, null, null, null, null]
    q.level[rs] = base
    if (probed && Array.isArray(q.said) && !q.said.includes(rs)) {
      q.said.push(rs)
      try { console.log(`castlefetch quarry ${tag} live (level ${base})`) } catch (_) { /* log best-eff */ }
    }
    let dead = false
    let deadWhy = ''
    for (let i = 0; i < QUARRY_LEN && !dead; i++) {
      const floor = trenchFloor(st, i, base)
      for (let l = 0; l < QUARRY_W && !dead; l++) {
        const below = at(o.x + o.dx * i + o.lx * l, floor - 1, o.z + o.dz * i + o.lz * l)
        if (!below || open(below) || wet(below)) { dead = true; deadWhy = `${below ? (wet(below) ? 'water' : 'hole') : 'void'} under column ${i} floor at ${o.x + o.dx * i + o.lx * l} ${floor - 1} ${o.z + o.dz * i + o.lz * l}` }
      }
      for (let y = base + QUARRY_TOP; y >= floor && !dead; y--) {
        for (let l = 0; l < QUARRY_W && !dead; l++) {
          const x = o.x + o.dx * i + o.lx * l
          const z = o.z + o.dz * i + o.lz * l
          const k = `${x},${y},${z}`
          const b = at(x, y, z)
          if (!b || wet(b)) { dead = true; deadWhy = `${b ? 'wet' : 'void'} at ${k}`; break }
          if (open(b) || f.skip.has(k)) continue
          if (EXPOSE.concat([[0, -1, 0]]).some(([ex, ey, ez]) => wet(at(x + ex, y + ey, z + ez)))) { dead = true; deadWhy = `liquid by ${k}`; break }
          if (protectedReason(bot, b, ctx)) {
            // Where (house apron, castle) kills the side; what (a path,
            // a ruin block) is stepped around.
            if (protectedReason(bot, { name: 'dirt', position: b.position }, ctx)) { dead = true; deadWhy = `protected place at ${k}`; break }
            f.skip.add(k)
            continue
          }
          // Stance (idkcraft-vmzq.25): the previous column's floor, same
          // lane, reached by walking down the staircase. A walk to the cell
          // itself (ground level, the bot deep in the trench) pillared up
          // out of the trench and the quarry re-dug the pillar (rig: 161
          // digs for 115 cells). Column i's drops rest on its floor, the
          // stance the next column is dug from. A cell out of eye reach
          // from its stance (a hill top or a leaf over a deep column) stays
          // standing: walking up to it pillared the same way (rig). A stance
          // that is not open body room (a stepped-around path, a skipped
          // cell, column 0's outside cell) is never walked into (revmux 01:
          // range 0 would dig it): that cell walks to itself as before.
          let stance = { x: o.x + o.dx * (i - 1) + o.lx * l, y: i === 0 ? base : trenchFloor(st, i - 1, base), z: o.z + o.dz * (i - 1) + o.lz * l }
          if (!open(at(stance.x, stance.y, stance.z)) || !open(at(stance.x, stance.y + 1, stance.z))) stance = null
          else if (Math.hypot(stance.x - x, stance.y + EYE - (y + 0.5), stance.z - z) > DIG_REACH + 0.5) { f.skip.add(k); continue }
          return { x, y, z, k, d: 0, waits: 0, quarry: true, tries: 0, stance }
        }
      }
    }
    q.dead.push(rs) // dug out or unusable mid-trench
    try { console.log(`castlefetch quarry ${tag} ${dead ? `unusable (mid-trench: ${deadWhy})` : 'dug out'}`) } catch (_) { /* log best-eff */ }
  }
  return null
}

// Source 3a: dig stone near the bot (equip digTick shape: walk into
// pickup reach, pickaxe in hand, one dig at a time with a deadline).
// Pack-full yield (g0z.26): digging into a full pack drops the cobble on
// the ground and counts no-gain strikes — fail fast instead, so the hold
// parks the leg while the stockpile step banks the surplus. An empty slot
// or room on a cobble/dirt stack reads as room; an unreadable inventory
// digs as before. R2 (revmux 01 major): with no adopted chest and nobody
// online the reserve binds one slot earlier — the last slot is the
// bootstrap chest craft's room, and a 36/36 chestless pack has no drain.
function roomForDrop(bot, ctx) {
  try {
    const stockpile = require('./stockpile')
    if (stockpile && typeof stockpile.slotReserved === 'function' && stockpile.slotReserved(bot, ctx)) return false
  } catch (_) { /* reserve unreadable: the room check below decides */ }
  try {
    const items = (bot && bot.inventory && typeof bot.inventory.items === 'function' && bot.inventory.items()) || []
    if (!Array.isArray(items)) return true
    if (items.length < 36) return true
    for (const s of items) {
      if (!s || (!blueprint.isStone(s.name) && s.name !== 'dirt')) continue
      const cap = s && typeof s.stackSize === 'number' && s.stackSize > 0 ? s.stackSize : 64
      if ((typeof s.count === 'number' ? s.count : 1) < cap) return true
    }
  } catch (_) {
    return true
  }
  return false
}
function digTick(bot, ctx, f) {
  const bp = bodyPos(bot)
  if (!bp) { spend(f, 'other'); return }
  if (!hasPickaxe(bot)) { spend(f, 'other'); finish(bot, ctx, 'done'); return } // equip rearms first
  if (!roomForDrop(bot, ctx)) { spend(f, 'other'); finish(bot, ctx, 'failed:castlefetch-pack-full'); return }
  // Mid-leg pick upgrade (idkcraft-vmzq.20): the first fetch digs on a
  // wooden pick (~1.4x slower on stone) and no equip step ever interjects
  // while castle legs are feasible, so upgrade in place once the pack
  // funds it (craftany chains sticks + a table as needed). One attempt
  // per leg: a short pack stays short for a stone leg.
  if (!f.pickUpLogged) {
    let due = false
    try { due = require('./equip').stoneUpgradeDue(bot) } catch (_) { due = false }
    if (due && !f.pickUpArmed) {
      f.pickUpArmed = true
      try { console.log('castlefetch stone: pick upgrade started (wood->stone)') } catch (_) { /* log best-effort */ }
    }
    if (due) {
      let r = null
      try { r = deps.craftItem(bot, ctx, ['stone_pickaxe'], 1) } catch (_) { r = { done: false } }
      if (r === 'running') { spend(f, 'other'); return } // crafting across ticks; the landing is seen below
      f.pickUpLogged = true
      try { console.log(`castlefetch stone: pick upgrade ${r && r.done ? 'done' : 'failed'}, digging on`) } catch (_) { /* log best-effort */ }
      if (r && r.done) { spend(f, 'other'); return }
    } else if (f.pickUpArmed) {
      // The craft landed between ticks (async): due flips false on the
      // stone pick before any call returns terminal, so the started line
      // would dangle without this (rig: stone in hand, no line).
      let stone = false
      try { stone = countItems(bot, (n) => n === 'stone_pickaxe') > 0 } catch (_) { stone = false }
      if (stone) {
        f.pickUpLogged = true
        try { console.log('castlefetch stone: pick upgrade done, digging on') } catch (_) { /* log best-effort */ }
      }
    }
  }
  const st = ctx.castle
  const skip = f.skip || (f.skip = new Set())
  const stoneAt = (q) => {
    try { const b = bot.blockAt(new Vec3(q.x, q.y, q.z)); return b && b.name === 'stone' ? b : null } catch (_) { return null }
  }
  // Quarry cells are any solid block (the trench digs its dirt too).
  const targetAt = (q) => {
    if (!q.quarry) return stoneAt(q)
    try { const b = bot.blockAt(new Vec3(q.x, q.y, q.z)); return b && !AIRISH.has(b.name) && b.boundingBox !== 'empty' && !LIQUID.has(b.name) ? b : null } catch (_) { return null }
  }
  let t = f.target
  if (t && !targetAt(t)) t = f.target = null // dug (or gone): pick the next
  if (!t) {
    // Far from the castle: walk there first, the stone is searched there.
    // (.22) a castlefetch-far unlock walks to the known candidate instead
    // (the fetcher walks to the candidate). The candidate latches onto the
    // leg (finding 9, the f.quarry precedent): a window that expires — or
    // a first stone that lands — mid-walk must not turn the bot around; a
    // leg already past the bound finishes. finish() drops the latch with
    // the leg (fetch failed, pack full, nothing left).
    let c = siteCenter(st)
    let farCand = null
    try {
      const { goalUnlock } = require('../goal-unlock')
      farCand = goalUnlock(ctx, 'candidate')
    } catch (_) { farCand = null }
    if (farCand && typeof farCand.x === 'number' && typeof farCand.z === 'number') {
      f.farCandidate = { x: farCand.x, y: farCand.y, z: farCand.z }
      c = f.farCandidate
    } else if (f.farCandidate && typeof f.farCandidate.x === 'number' && typeof f.farCandidate.z === 'number') {
      c = f.farCandidate
    }
    const far = Math.hypot(bp.x - (c.x + 0.5), bp.z - (c.z + 0.5))
    // A leg already quarrying stays out: the trench runs past DIG_RADIUS
    // (revmux 02), and its own target walks have their own patience. Pit
    // rooms run out the same way (vmzq.46).
    if (far > DIG_RADIUS && !f.quarry && !f.pit) {
      // The castle chest is looked up again on arrival, once per leg
      // (revmux 01: a far leg's body-centred lookup found none).
      if (f.chestRelook == null) f.chestRelook = true
      walkTo(bot, ctx, `castlefetch-site:${c.x},${c.z}`, c, DIG_RADIUS / 2, far > 2 * DIG_RADIUS)
      if (stalled(f.siteWalk || (f.siteWalk = {}), far, APPROACH_WAITS)) finish(bot, ctx, 'failed:castlefetch-unreachable')
      spend(f, 'walk')
      return
    }
    f.siteWalk = null
    if (f.chestRelook) {
      f.chestRelook = false
      f.chestDone = false
      f.chest = null
      f.chestWalk = null
      spend(f, 'other')
      return // the chest source goes first next tick
    }
    t = pickStone(bot, ctx, f, bp, stoneAt)
    if (!t) {
      // A far leg whose candidate ground is dry ends here (finding 9): no
      // stone left around the candidate finishes the leg — starting the
      // site trench instead would walk the bot back to the dead ground the
      // window was bought to escape. An already-running trench keeps going.
      const farLatched = !!(f.farCandidate && typeof f.farCandidate.x === 'number')
      if (farLatched && !f.quarry) { finish(bot, ctx, 'failed:castlefetch-no-stone'); return }
      // No exposed stone by the site: quarry it, and ask the owner once
      // per site per session (owner 2026-10-02: the chest is the shortcut).
      const key = `${st.site.x},${st.site.y},${st.site.z}`
      if (ctx.castleStoneAsked !== key) {
        ctx.castleStoneAsked = key
        try { bot.chat(`no stone near the castle at ${st.site.x} ${st.site.z}: quarrying it; drop cobblestone into a chest on the castle site to speed it up`) } catch (_) { /* chat best-effort */ }
      }
      t = pickQuarry(bot, ctx, f)
      // vmzq.46 STARVED GATE: pickQuarry null means every side died or dug
      // out this leg (and no exposed stone was found above) — quarry down
      // instead. On a live pad pickQuarry always returns, so this never
      // runs and the trench path stays master-identical by construction.
      if (!t) t = pickPit(bot, ctx, f)
    }
    if (!t) { spend(f, 'other'); finish(bot, ctx, 'failed:castlefetch-no-stone'); return }
    f.target = t
  }
  const b = targetAt(t)
  const dist = Math.hypot(bp.x - (t.x + 0.5), bp.y - (t.y + 0.5), bp.z - (t.z + 0.5))
  // Every cell is dug from pickup reach — trench cells included. The old
  // trench exception (dig from 4, "the next stance steps over the drops")
  // never collected: the stance advances along the trench while the drops
  // stay behind, and ~2/3 of dug blocks never reached the pack (rig: 368
  // issues banked +113). Linger-by-construction: a stance within 2.5 of
  // every dug cell sits on the drops through the dig. A trench cell with a
  // stance (vmzq.25) is dug from the stance instead: eye reach, no climb.
  const s = t.stance
  const sd = s ? Math.hypot(bp.x - (s.x + 0.5), bp.y - s.y, bp.z - (s.z + 0.5)) : 0
  const reach = s
    ? sd <= 2 && Math.hypot(bp.x - (t.x + 0.5), bp.y + EYE - (t.y + 0.5), bp.z - (t.z + 0.5)) <= DIG_REACH + 0.5
    : dist <= PICKUP_REACH + 0.5
  if (!reach) {
    // The stance cell itself (range 0): a near-goal admits the cell one
    // lower, i.e. digging the floor's support (rig: side 3 went dead
    // mid-trench on range 1, carried the run on range 0).
    const range = s ? 0 : dist > DIG_REACH ? 2 : 1
    if (s) walkTo(bot, ctx, `castlefetch-stance:${s.x},${s.y},${s.z}`, s, range)
    else walkTo(bot, ctx, `castlefetch-dig:${t.k}:${range}`, t, range)
    if (stalled(t, s ? sd : dist, APPROACH_WAITS)) {
      skip.add(t.k)
      f.target = null
      if (++f.skips >= SKIPS_TO_FAIL) finish(bot, ctx, 'failed:castlefetch-unreachable')
    }
    spend(f, 'walk')
    return
  }
  // Stance rules (below-feet trap, gravity, submerged, protection) at dig
  // time, not only at pick: the walk may end on or above the target.
  const deny = denyReason(bot, b, ctx)
  if (deny) {
    logDeny(b, deny)
    skip.add(t.k)
    f.target = null
    spend(f, 'other')
    return
  }
  // Airborne digs take 5x (mineflayer digTime; rig: the first dig after
  // each stance walk ran 3.75 s on 0.75 s dirt): let the feet land first,
  // a bounded wait so a body that never reads grounded still digs.
  if (bot.entity && bot.entity.onGround === false && (t.air = (t.air | 0) + 1) <= AIR_WAITS) { spend(f, 'other'); return }
  if (t.quarry) {
    // Drops land at the digging stance (pickup reach), so no
    // cobble-gain strike; a cell that survives its digs is skipped instead.
    if (++t.tries > QUARRY_TRIES) {
      spend(f, 'other')
      try { console.log(`castlefetch stone: cell refused ${QUARRY_TRIES}x at ${t.x} ${t.y} ${t.z}, skipping`) } catch (_) { /* log best-effort */ }
      skip.add(t.k); f.target = null; return
    }
    // Drops never reaching the pack (revmux 01): a trench's worth of stone
    // dug with no cobble gained ends the leg instead of digging all day.
    const have = cobble(bot)
    if (f.qCobble == null || have > f.qCobble) { f.qCobble = have; f.qNoGain = 0 } else if (b.name === 'stone' && ++f.qNoGain > QUARRY_NOGAIN) { spend(f, 'other'); finish(bot, ctx, 'failed:castlefetch-dig-stall'); return }
  } else {
    const have = cobble(bot)
    if (f.lastCobble != null && have <= f.lastCobble) {
      if (++f.noGain >= NOGAIN_STRIKES) { spend(f, 'other'); finish(bot, ctx, 'failed:castlefetch-dig-stall'); return }
    } else f.noGain = 0
    f.lastCobble = have
  }
  spend(f, 'dig')
  try { f.starts = (f.starts | 0) + 1 } catch (_) { /* counter best-effort */ }
  ctx.castleFetchFlight = 'dig' // in-flight ticks keep bucketing as dig below
  flight(ctx, async () => {
    // Trench dirt by hand (rig: the pick wore out on the sod before the
    // batch was in); rock with the pickaxe.
    if (ROCK.test(b.name)) {
      const pick = (bot.inventory.items() || []).find((i) => i && typeof i.name === 'string' && i.name.endsWith('_pickaxe'))
      if (pick) await bot.equip(pick, 'hand')
    } else if (bot.heldItem && /_pickaxe$/.test(bot.heldItem.name)) await bot.unequip('hand')
    await bot.dig(b, true) // instant look, as the pathfinder's own digs: a smooth turn added ~0.25 s per dig
  }, DIG_TIMEOUT_MS, () => {
    // A hung dig skips the block (no retry this leg); the no-gain strike
    // counts it. Loud: a 10 s hang per cell is the rig's prime suspect
    // for the quarry's missing ticks (cycle 11: ~350 standing ticks).
    try { console.log(`castlefetch stone: dig timed out at ${t.x} ${t.y} ${t.z}, skipping`) } catch (_) { /* log best-effort */ }
    skip.add(t.k)
    if (f.target === t) f.target = null
  }, () => { try { f.dug = (f.dug | 0) + 1 } catch (_) { /* counter best-effort */ } })
}

function castlefetch(bot, ctx, target, state) {
  // A dig (or chest op) spans ticks: the issue tick bucketed above, the
  // continuation ticks here, so dig reads as duration, not starts.
  if (ctx.castleFetchInFlight) {
    if (ctx.castleFetch) spend(ctx.castleFetch, ctx.castleFetchFlight === 'dig' ? 'dig' : 'other')
    return
  }
  const st = ctx.castle
  if (!st || !st.site || typeof st.site.x !== 'number') { finish(bot, ctx, 'done'); return }
  const d = demand(bot, ctx)
  if (!d || d.short <= 0) { finish(bot, ctx, 'done'); return }
  let f = ctx.castleFetch
  if (!f || f.kind !== d.kind) {
    f = ctx.castleFetch = { kind: d.kind, chestWaits: 0, skips: 0, noGain: 0, t0: Date.now(), blocks0: blocksOnHand(bot) }
    try { console.log(`castlefetch ${d.kind}: need ${d.short} more`) } catch (_) { /* log best-effort */ }
  }
  // Batch yield (idkcraft-vmzq.20): a leg that reached a layable batch but
  // not its full target hands over after LEG_MAX_MS, so the castle lays
  // the partial instead of starving behind an 80-cobble fetch (rig: the
  // first fetch never finished in 15 min, 0 laid). 'done', never failed:
  // no hold parks the re-pick after the castle drains. Below a batch the
  // leg keeps fetching — yielding to a castle that cannot lay would flip
  // straight back. 'some'/'none'/'blocked' never yield by construction.
  if (d.word === 'batch' && typeof f.t0 === 'number' && Date.now() - f.t0 > LEG_MAX_MS) {
    try { console.log(`castlefetch ${d.kind}: batch ready, yielding`) } catch (_) { /* log best-effort */ }
    finish(bot, ctx, 'done')
    return
  }
  st.status = `fetching ${d.kind}`
  if (chestTick(bot, ctx, f, d)) return
  if (craftTick(bot, ctx, f, d)) return
  if (d.kind === 'stone') { digTick(bot, ctx, f); return }
  if (d.kind === 'planks' || d.kind === 'door' || d.kind === 'fence' || d.kind === 'chest' || d.kind === 'frame') {
    // Logs from the world: gather chops a load and ends the leg itself
    // ('done' at NEED_LOGS, or its own failure); the next pick crafts
    // (frame: the logs are the material, the next tick reads the target).
    // A full load already on hand means the craft failed for another
    // reason (table, reach): chopping more would finish 'done' at once
    // and re-pick forever (revmux 01) — fail so the hold parks it.
    if (countItems(bot, (n) => n.endsWith('_log')) >= require('../budget').NEED_LOGS) {
      finish(bot, ctx, `failed:castlefetch-craft-${d.kind}`)
      return
    }
    deps.gather(bot, ctx, target, state)
    if (typeof ctx.stepStatus === 'string' && ctx.stepStatus !== 'running') ctx.castleFetch = null
    return
  }
  if (d.kind === 'banner' && bannerSelf(bot, ctx)) { bannerTick(bot, ctx, f, d); return }
  ctx.castleFetchDry = d.kind // the decor word tries the next open kind (castle menuFact)
  finish(bot, ctx, `failed:castlefetch-no-${d.kind}`) // torch without coal, pane/banner without chest stock
}

module.exports = castlefetch
module.exports.LEG_MAX_MS = LEG_MAX_MS
module.exports.QUARRY_ADAPT = QUARRY_ADAPT
module.exports.quarrySide = quarrySide
module.exports.QUARRY_RINGS = QUARRY_RINGS
module.exports.pickQuarry = pickQuarry
module.exports.pickStone = pickStone
module.exports.pickPit = pickPit
module.exports.pitSpots = pitSpots
module.exports.inTrench = inTrench
module.exports.PIT_LEN = PIT_LEN
module.exports.PIT_DEPTH = PIT_DEPTH
module.exports.PIT_ROOM = PIT_ROOM
module.exports.digTick = digTick
module.exports.demand = demand
module.exports.roomForDrop = roomForDrop
module.exports.castleChest = castleChest
module.exports.onSite = onSite
module.exports.deps = deps
module.exports.FETCH = FETCH
module.exports.selfOrder = selfOrder
module.exports.selfOrderBack = selfOrderBack
module.exports.acceptStone = acceptStone
module.exports.FIND_COUNT = FIND_COUNT
module.exports.STONE_BELOW = STONE_BELOW
module.exports.STONE_ABOVE = STONE_ABOVE
