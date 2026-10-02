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
const { canBreak, clearGoal, denyReason, logDeny } = require('./util')

// Stack-ish targets per kind (bead: ~64 cobble, ~16 logs' worth). Each is
// >= castle BATCH (door: its remainder is 1), so a fetch picked on a
// none/some word always has work: the word and the target never disagree.
const FETCH = { stone: 64, planks: 32, door: 1, torch: 16, fence: 16 }
// One craft op per call; the next tick re-checks the target.
const CRAFT_COUNT = { planks: 4, door: 1, torch: 4, fence: 3 }
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
  return []
}

function craftNames(bot, kind) {
  if (kind === 'planks') return itemNames(bot, (n) => n.endsWith('_planks'))
  if (kind === 'door') return itemNames(bot, isDoor)
  if (kind === 'fence') return itemNames(bot, isFence)
  if (kind === 'torch') return ['torch']
  return []
}

// The castle's open demand for a kind: { kind, short } where short is how
// many more usable items the batch needs. Null when the castle word is not
// a material word (none/parked/done/clear/blocked). Shared by the goal
// gate and the behaviour, so the two never disagree.
function demand(bot, ctx) {
  let w = 'none'
  try { w = castleMod.menuFact(bot, ctx) } catch (_) { return null }
  const m = /^([a-z]+)-(none|some|batch)$/.exec(w)
  if (!m || !(m[1] in FETCH)) return null
  const kind = m[1]
  const cw = ctx && ctx.castleWord
  const left = cw && cw.kind === kind && typeof cw.left === 'number' ? cw.left : castleMod.BATCH
  const target = Math.min(FETCH[kind], left)
  // Raw items: below the reserve the reserve refills first (never laid).
  return { kind, word: m[2], short: Math.max(0, target + castleMod.reserveOf(kind) - castleMod.held(bot, kind)) }
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
      const logs = names.some((n) => n.endsWith('_log'))
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
  try { found = (e && bot.findBlocks({ matching: e.id, maxDistance: DIG_RADIUS, count: FIND_COUNT })) || [] } catch (_) { found = [] }
  const fx = Math.floor(bp.x)
  const fy = Math.floor(bp.y) // own feet column only
  const fz = Math.floor(bp.z)
  let best = null
  for (const p of found) {
    const k = `${p.x},${p.y},${p.z}`
    if (f.skip.has(k) || onSite(ctx.castle, p) || danger.near(ctx, p)) continue
    if (p.x === fx && p.z === fz && p.y < fy) continue
    // Near the castle's ground level only (revmux 02/03): a cave wall far
    // below is 'exposed' too and the canDig walk would shaft down to it; a
    // cliff face far above means pillaring. Anchored on the site, never the
    // live feet — a pick made from inside our own quarry pit would ratchet
    // the window down a layer per pick.
    const gy = ctx.castle.site.y
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

// Source 3a: dig stone near the bot (equip digTick shape: walk into
// pickup reach, pickaxe in hand, one dig at a time with a deadline).
function digTick(bot, ctx, f) {
  const bp = bodyPos(bot)
  if (!bp) return
  if (!hasPickaxe(bot)) { finish(bot, ctx, 'done'); return } // equip rearms first
  const st = ctx.castle
  const skip = f.skip || (f.skip = new Set())
  const stoneAt = (q) => {
    try { const b = bot.blockAt(new Vec3(q.x, q.y, q.z)); return b && b.name === 'stone' ? b : null } catch (_) { return null }
  }
  let t = f.target
  if (t && !stoneAt(t)) t = f.target = null // dug (or gone): pick the next
  if (!t) {
    t = pickStone(bot, ctx, f, bp, stoneAt)
    if (!t) { finish(bot, ctx, 'failed:castlefetch-no-stone'); return }
    f.target = t
  }
  const b = stoneAt(t)
  const dist = Math.hypot(bp.x - (t.x + 0.5), bp.y - (t.y + 0.5), bp.z - (t.z + 0.5))
  if (dist > PICKUP_REACH + 0.5) {
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
  const have = cobble(bot)
  if (f.lastCobble != null && have <= f.lastCobble) {
    if (++f.noGain >= NOGAIN_STRIKES) { finish(bot, ctx, 'failed:castlefetch-dig-stall'); return }
  } else f.noGain = 0
  f.lastCobble = have
  flight(ctx, async () => {
    const pick = (bot.inventory.items() || []).find((i) => i && typeof i.name === 'string' && i.name.endsWith('_pickaxe'))
    if (pick) await bot.equip(pick, 'hand')
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
  if (d.kind === 'planks' || d.kind === 'door' || d.kind === 'fence') {
    // Logs from the world: gather chops a load and ends the leg itself
    // ('done' at NEED_LOGS, or its own failure); the next pick crafts.
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
module.exports.demand = demand
module.exports.castleChest = castleChest
module.exports.onSite = onSite
module.exports.deps = deps
module.exports.FETCH = FETCH
