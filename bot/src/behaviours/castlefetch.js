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
const FETCH = { stone: 64, planks: 32, door: 1, torch: 16, fence: 16, frame: castleMod.BATCH_OF.frame, chest: 1 }
// One craft op per call; the next tick re-checks the target.
const CRAFT_COUNT = { planks: 4, door: 1, torch: 4, fence: 3, chest: 1 }
const DIG_RADIUS = 32
const FIND_COUNT = 4096
const STONE_BELOW = 2 // target y window around the site's ground (no shafts, no pillars)
const STONE_ABOVE = 3
const DIG_REACH = 4
const PICKUP_REACH = 2 // drops land where the block stood (equip lesson)
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
// them needs longer trenches or a second row, not a new search.
const QUARRY_GAP = 3 // trench start outside the footprint (v2: past the fence)
const QUARRY_DEPTH = 6
const QUARRY_LEN = 40
const QUARRY_W = 2
const QUARRY_TOP = 3 // a hill is cut up to site.y + this
const QUARRY_TRIES = 3 // digs on one quarry cell before it is skipped
const QUARRY_NOGAIN = 4 * QUARRY_W * 3 // stone digs (~4 columns) with no cobble picked up
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

// What the chest yields for a kind, finished items first; planks also
// take logs (converted by the craft source next tick).
function chestNames(bot, kind) {
  if (kind === 'stone') return [['cobblestone', 'stone']]
  if (kind === 'planks') return [itemNames(bot, (n) => n.endsWith('_planks')), itemNames(bot, (n) => n.endsWith('_log'))]
  if (kind === 'door') return [itemNames(bot, isDoor)]
  if (kind === 'fence') return [itemNames(bot, isFence)]
  if (kind === 'torch') return [['torch']]
  if (kind === 'frame') return [itemNames(bot, (n) => n.endsWith('_log'))]
  if (kind === 'chest') return [['chest']]
  return []
}

function craftNames(bot, kind) {
  if (kind === 'planks') return itemNames(bot, (n) => n.endsWith('_planks'))
  if (kind === 'door') return itemNames(bot, isDoor)
  if (kind === 'fence') return itemNames(bot, isFence)
  if (kind === 'torch') return ['torch']
  if (kind === 'chest') return ['chest'] // 8 planks at a table (craftany crafts planks from logs)
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
  if (sf && typeof sf.at === 'number' && Date.now() - sf.at <= require('../goal').CASTLEFETCH_RETRY_MS) return null
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
  return countItems(bot, (n) => n === 'cobblestone')
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
function walkTo(bot, ctx, key, p, range) {
  let ours = false
  try { ours = !!ctx.castleFetchGoal && bot.pathfinder.goal === ctx.castleFetchGoal } catch (_) { ours = false }
  if (ctx.lastGoalKey === key && ours) return
  try {
    ctx.castleFetchGoal = new goals.GoalNear(p.x, p.y, p.z, range)
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
function flight(ctx, run, ms, onFail) {
  ctx.castleFetchInFlight = true
  const timeout = new Promise((_, reject) => {
    const tm = setTimeout(() => reject(new Error('timeout')), ms)
    if (tm && typeof tm.unref === 'function') tm.unref()
  })
  Promise.race([run(), timeout]).catch(() => { if (onFail) onFail() }).finally(() => { ctx.castleFetchInFlight = false })
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
  flight(ctx, async () => {
    let need = d.short
    for (const names of chestNames(bot, d.kind)) {
      if (need <= 0 || names.length === 0) break
      // Planks' second list is logs: one log is four planks.
      const logs = d.kind === 'planks' && names.some((n) => n.endsWith('_log'))
      const r = await stockpileMod.withdrawAnyFromChest(bot, ctx, names, logs ? Math.ceil(need / 4) : need, at)
      need -= (r && r.got ? r.got : 0) * (logs ? 4 : 1)
    }
  }, CHEST_TIMEOUT_MS)
  return true
}

// Source 2: craft from the pack. Returns true while it owns the tick.
function craftTick(bot, ctx, f, d) {
  const names = craftNames(bot, d.kind)
  if (names.length === 0 || f.craftOut) return false
  if (d.kind === 'torch' && countItems(bot, (n) => n === 'coal' || n === 'charcoal') <= require('./light').COAL_RESERVE) return false // smelting's coal floor
  let r = null
  try { r = deps.craftItem(bot, ctx, names, CRAFT_COUNT[d.kind] || 1) } catch (_) { r = { done: false } }
  if (r === 'running') return true
  if (r && r.done) return true // re-check the target next tick
  f.craftOut = true // the pack cannot fund it: fall through to the world
  return false
}

// Exposed stone only (revmux 01): air above, or air on a side — surface
// rock, cliffs, walk-in cave mouths, within a few blocks of the feet level. Buried stone would make the walk dig a shaft
// down to it. findBlocks collects every stone of the sections it visits,
// so a wide count costs one sort, not a wider scan; the exposure filter
// is two-ish blockAt per candidate. Nearest first, never the site, a
// danger spot, or our own feet column.
const EXPOSE = [[0, 1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]]
const AIRISH = new Set(['air', 'cave_air'])
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
    if (f.skip.has(k) || onSite(ctx.castle, p) || danger.near(ctx, p) || inTrench(ctx.castle, p)) continue
    if (p.x === fx && p.z === fz && p.y < fy) continue
    // Near the ground level only (revmux 02/03): a cave wall far
    // below is 'exposed' too and the canDig walk would shaft down to it; a
    // cliff face far above means pillaring. Anchored on the site (or the
    // far candidate), never the live feet — a pick made from inside our
    // own quarry pit would ratchet the window down a layer per pick.
    if (p.y < gy - STONE_BELOW || p.y > gy + STONE_ABOVE) continue
    const d = Math.hypot(p.x - bp.x, p.y - bp.y, p.z - bp.z)
    if (best && d >= best.d) continue
    const open = EXPOSE.some(([x, y, z]) => {
      try { const n = bot.blockAt(new Vec3(p.x + x, p.y + y, p.z + z)); return !!n && AIRISH.has(n.name) } catch (_) { return false }
    })
    if (!open) continue
    const b = stoneAt(p)
    if (!b || !canBreak(bot, b, ctx)) continue
    best = { x: p.x, y: p.y, z: p.z, k, d, waits: 0 }
  }
  return best
}

function siteCenter(st) {
  const { w, d } = blueprint.siteDimensions(st.rot | 0, st.blueprintVersion)
  return { x: st.site.x + Math.floor(w / 2), y: st.site.y, z: st.site.z + Math.floor(d / 2) }
}

// Trench side s (0..3): origin column just outside the footprint near a
// corner (the entrance sits mid-side, never in front of it), the outward
// direction and the width axis.
function quarrySide(st, s) {
  const { w, d } = blueprint.siteDimensions(st.rot | 0, st.blueprintVersion)
  const { x: sx, z: sz } = st.site
  const g = QUARRY_GAP + 1
  if (s === 0) return { x: sx - g, z: sz + 2, dx: -1, dz: 0, lx: 0, lz: 1 }
  if (s === 1) return { x: sx + w - 1 + g, z: sz + d - 2 - QUARRY_W, dx: 1, dz: 0, lx: 0, lz: 1 }
  if (s === 2) return { x: sx + w - 2 - QUARRY_W, z: sz - g, dx: 0, dz: -1, lx: 1, lz: 0 }
  return { x: sx + 2, z: sz + d - 1 + g, dx: 0, dz: 1, lx: 1, lz: 0 }
}

function trenchFloor(st, i) {
  return st.site.y - 1 - Math.min(i, QUARRY_DEPTH - 1)
}

// A trench cell or the block a trench stance stands on (revmux 01): the
// exposed-stone pick must never undermine our own staircase.
function inTrench(st, p) {
  for (let s = 0; s < 4; s++) {
    const o = quarrySide(st, s)
    const i = (p.x - o.x) * o.dx + (p.z - o.z) * o.dz
    const l = (p.x - o.x) * o.lx + (p.z - o.z) * o.lz
    if (i >= 0 && i < QUARRY_LEN && l >= 0 && l < QUARRY_W && p.y >= trenchFloor(st, i) - 1 && p.y <= st.site.y + QUARRY_TOP) return true
  }
  return false
}

// The next trench cell to dig: the first solid cell in dig order on the
// first live side. A side dies for this leg on liquid at or by a cell, a
// hole under the floor or a protected place (house apron, castle) — the
// next side takes over; a protected block type (a path) is stepped
// around. Stance rules are checked at dig time (they depend on where we
// stand). Recomputed from the world every pick and per leg (revmux 01: no
// session latch) — a restart or a retry resumes the same trench.
function pickQuarry(bot, ctx, f) {
  const st = ctx.castle
  const q = f.quarry || (f.quarry = { dead: [] })
  const at = (x, y, z) => { try { return bot.blockAt(new Vec3(x, y, z)) } catch (_) { return null } }
  const wet = (b) => !!b && LIQUID.has(b.name)
  const open = (b) => !!b && (AIRISH.has(b.name) || b.boundingBox === 'empty') && !wet(b)
  for (let s = 0; s < 4; s++) {
    if (q.dead.includes(s)) continue
    const o = quarrySide(st, s)
    let dead = false
    for (let i = 0; i < QUARRY_LEN && !dead; i++) {
      const floor = trenchFloor(st, i)
      for (let l = 0; l < QUARRY_W && !dead; l++) {
        const below = at(o.x + o.dx * i + o.lx * l, floor - 1, o.z + o.dz * i + o.lz * l)
        if (!below || open(below) || wet(below)) dead = true
      }
      for (let y = st.site.y + QUARRY_TOP; y >= floor && !dead; y--) {
        for (let l = 0; l < QUARRY_W && !dead; l++) {
          const x = o.x + o.dx * i + o.lx * l
          const z = o.z + o.dz * i + o.lz * l
          const k = `${x},${y},${z}`
          const b = at(x, y, z)
          if (!b || wet(b)) { dead = true; break }
          if (open(b) || f.skip.has(k)) continue
          if (EXPOSE.concat([[0, -1, 0]]).some(([ex, ey, ez]) => wet(at(x + ex, y + ey, z + ez)))) { dead = true; break }
          if (protectedReason(bot, b, ctx)) {
            // Where (house apron, castle) kills the side; what (a path,
            // a ruin block) is stepped around.
            if (protectedReason(bot, { name: 'dirt', position: b.position }, ctx)) { dead = true; break }
            f.skip.add(k)
            continue
          }
          return { x, y, z, k, d: 0, waits: 0, quarry: true, tries: 0 }
        }
      }
    }
    q.dead.push(s) // dug out or unusable
    try { console.log(`castlefetch quarry side ${s} ${dead ? 'unusable' : 'dug out'}`) } catch (_) { /* log best-effort */ }
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
      if (!s || (s.name !== 'cobblestone' && s.name !== 'dirt')) continue
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
  if (!bp) return
  if (!hasPickaxe(bot)) { finish(bot, ctx, 'done'); return } // equip rearms first
  if (!roomForDrop(bot, ctx)) { finish(bot, ctx, 'failed:castlefetch-pack-full'); return }
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
    // (revmux 02), and its own target walks have their own patience.
    if (far > DIG_RADIUS && !f.quarry) {
      // The castle chest is looked up again on arrival, once per leg
      // (revmux 01: a far leg's body-centred lookup found none).
      if (f.chestRelook == null) f.chestRelook = true
      walkTo(bot, ctx, `castlefetch-site:${c.x},${c.z}`, c, DIG_RADIUS / 2)
      if (stalled(f.siteWalk || (f.siteWalk = {}), far, APPROACH_WAITS)) finish(bot, ctx, 'failed:castlefetch-unreachable')
      return
    }
    f.siteWalk = null
    if (f.chestRelook) {
      f.chestRelook = false
      f.chestDone = false
      f.chest = null
      f.chestWalk = null
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
    }
    if (!t) { finish(bot, ctx, 'failed:castlefetch-no-stone'); return }
    f.target = t
  }
  const b = targetAt(t)
  const dist = Math.hypot(bp.x - (t.x + 0.5), bp.y - (t.y + 0.5), bp.z - (t.z + 0.5))
  // A trench cell is dug from dig reach (the next stance steps over the
  // drops); surface stone from pickup reach.
  if (dist > (t.quarry ? DIG_REACH : PICKUP_REACH + 0.5)) {
    const range = dist > DIG_REACH ? 2 : 1
    walkTo(bot, ctx, `castlefetch-dig:${t.k}:${range}`, t, range)
    if (stalled(t, dist, APPROACH_WAITS)) {
      skip.add(t.k)
      f.target = null
      if (++f.skips >= SKIPS_TO_FAIL) finish(bot, ctx, 'failed:castlefetch-unreachable')
    }
    return
  }
  // Stance rules (below-feet trap, gravity, submerged, protection) at dig
  // time, not only at pick: the walk may end on or above the target.
  const deny = denyReason(bot, b, ctx)
  if (deny) {
    logDeny(b, deny)
    skip.add(t.k)
    f.target = null
    return
  }
  if (t.quarry) {
    // Trench drops are collected a stance later, so no cobble-gain strike;
    // a cell that survives its digs is skipped instead.
    if (++t.tries > QUARRY_TRIES) { skip.add(t.k); f.target = null; return }
    // Drops never reaching the pack (revmux 01): a trench's worth of stone
    // dug with no cobble gained ends the leg instead of digging all day.
    const have = cobble(bot)
    if (f.qCobble == null || have > f.qCobble) { f.qCobble = have; f.qNoGain = 0 } else if (b.name === 'stone' && ++f.qNoGain > QUARRY_NOGAIN) { finish(bot, ctx, 'failed:castlefetch-dig-stall'); return }
  } else {
    const have = cobble(bot)
    if (f.lastCobble != null && have <= f.lastCobble) {
      if (++f.noGain >= NOGAIN_STRIKES) { finish(bot, ctx, 'failed:castlefetch-dig-stall'); return }
    } else f.noGain = 0
    f.lastCobble = have
  }
  flight(ctx, async () => {
    // Trench dirt by hand (rig: the pick wore out on the sod before the
    // batch was in); rock with the pickaxe.
    if (ROCK.test(b.name)) {
      const pick = (bot.inventory.items() || []).find((i) => i && typeof i.name === 'string' && i.name.endsWith('_pickaxe'))
      if (pick) await bot.equip(pick, 'hand')
    } else if (bot.heldItem && /_pickaxe$/.test(bot.heldItem.name)) await bot.unequip('hand')
    await bot.dig(b)
  }, DIG_TIMEOUT_MS, () => {
    // A refused/hung dig skips the block; the no-gain strike counts it.
    skip.add(t.k)
    if (f.target === t) f.target = null
  })
}

function castlefetch(bot, ctx, target, state) {
  if (ctx.castleFetchInFlight) return
  const st = ctx.castle
  if (!st || !st.site || typeof st.site.x !== 'number') { finish(bot, ctx, 'done'); return }
  const d = demand(bot, ctx)
  if (!d || d.short <= 0) { finish(bot, ctx, 'done'); return }
  let f = ctx.castleFetch
  if (!f || f.kind !== d.kind) {
    f = ctx.castleFetch = { kind: d.kind, chestWaits: 0, skips: 0, noGain: 0 }
    try { console.log(`castlefetch ${d.kind}: need ${d.short} more`) } catch (_) { /* log best-effort */ }
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
    if (countItems(bot, (n) => n.endsWith('_log')) >= require('../goal').NEED_LOGS) {
      finish(bot, ctx, `failed:castlefetch-craft-${d.kind}`)
      return
    }
    deps.gather(bot, ctx, target, state)
    if (typeof ctx.stepStatus === 'string' && ctx.stepStatus !== 'running') ctx.castleFetch = null
    return
  }
  finish(bot, ctx, `failed:castlefetch-no-${d.kind}`) // torch without coal
}

module.exports = castlefetch
module.exports.digTick = digTick
module.exports.demand = demand
module.exports.roomForDrop = roomForDrop
module.exports.castleChest = castleChest
module.exports.onSite = onSite
module.exports.deps = deps
module.exports.FETCH = FETCH
