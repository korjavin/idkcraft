'use strict'

// Generic material resolver (owner: solve the class, not per material).
// acquire(bot, ctx, item, n) is one tick: the pack holds n -> 'done'; a
// recipe runs -> craftany; a recipe short of an input -> recurse on that
// input; no recipe -> the world source minecraft-data names (a block that
// drops it, mined in one batch for the whole remaining need; or a mob from
// the small MOB table, hunted by a self bring order). Chests stay the
// caller's first rung (castlefetch chestTick). Smelting is not run here:
// a smelt gap acquires its raw input (sand, ore, a log), then fails
// 'smelt-<item>' (castlefetch's pane/torch ticks own the furnace). sources() is the same tree as pure data: explore's
// expedition and resources.scan read it (src/sources.js).

const { Vec3 } = require('vec3')
const { goals } = require('mineflayer-pathfinder')
const S = require('../sources')
const unreachable = require('../unreachable')

const MINE_RADIUS = 64
const DIG_REACH = 4.5
const WALK_WAITS = 15 // walk ticks without closing in before the source is unreachable
const CLUSTER_R = 3 // a blacklisted cell takes its tree/vein with it
const AREA_FAILS = 3 // unreachable sources in a row before the area is left
const AREA_R = 48 // the left area: beyond the nearest few sources

function have(bot, item) {
  let n = 0
  try { for (const it of bot.inventory.items()) if (it && it.name === item) n += it.count || 0 } catch (_) { /* empty */ }
  return n
}

function room(bot) {
  try { return 64 * bot.inventory.emptySlotCount() } catch (_) { return 64 }
}

// Nearest source cell of these blocks not blacklisted: loaded world first
// pass, remembered finds too. Null when none.
function nearestSource(bot, ctx, blocks, p) {
  const cand = []
  try {
    const ids = blocks.map((n) => bot.registry.blocksByName[n]).filter(Boolean).map((b) => b.id)
    if (ids.length && typeof bot.findBlocks === 'function') cand.push(...(bot.findBlocks({ matching: ids, maxDistance: MINE_RADIUS, count: 64 }) || []))
  } catch (_) { /* no world */ }
  try { for (const it of ctx.resources.items.values()) if (it && blocks.includes(it.name)) cand.push(it) } catch (_) { /* no memory */ }
  let best = null, bd = Infinity
  for (const c of cand) {
    if (unreachable.near(ctx, c)) continue
    try { if (ctx.castle && require('../castle').protects(ctx.castle, c, c.name || blocks[0])) continue } catch (_) { /* unguarded */ }
    const d = Math.hypot(c.x - p.x, c.y - p.y, c.z - p.z)
    if (d < bd) { bd = d; best = { x: c.x, y: c.y, z: c.z } }
  }
  return best
}

// Walk-and-dig fallback after a pathless mine. True while it owns the tick.
function handTick(bot, ctx, a, item, blocks) {
  const p = bot.entity && bot.entity.position
  if (!p) return false
  let h = a.hand
  if (!h) {
    const t = nearestSource(bot, ctx, blocks, p)
    if (!t) return false
    h = a.hand = { t, best: Infinity, waits: 0 }
    console.log(`acquire ${item}: walk-and-dig ${t.x},${t.y},${t.z}`)
  }
  const { t } = h
  let b = null
  try { b = bot.blockAt(new Vec3(t.x, t.y, t.z)) } catch (_) { b = null }
  if (b && !blocks.includes(b.name)) { a.hand = null; return true } // gone (dug or stale find): pick the next
  const d = Math.hypot(t.x + 0.5 - p.x, t.y + 0.5 - (p.y + 1.6), t.z + 0.5 - p.z)
  if (b && d <= DIG_REACH) {
    a.mining = true
    Promise.resolve().then(() => bot.dig(b, true))
      .then(() => { a.fails = 0; a.mineFail = null; a.expedition = null }) // a source worked: the mine runs from here again
      .catch(() => { giveUp(bot, ctx, a, item) })
      .finally(() => { a.mining = false; a.hand = null })
    return true
  }
  if (d < h.best - 1) { h.best = d; h.waits = 0 } else h.waits++
  if (h.waits > WALK_WAITS || (h.waits > 2 && ctx.lastPathStatus === 'noPath')) { giveUp(bot, ctx, a, item); return true }
  try {
    if (h.goal == null || bot.pathfinder.goal !== h.goal) bot.pathfinder.setGoal(h.goal = d > 32 ? new goals.GoalNearXZ(t.x, t.z, 2) : new goals.GoalNear(t.x, t.y, t.z, 2))
  } catch (_) { /* next tick retries */ }
  return true
}

// Blacklist the cell's cluster; K in a row blacklist the whole area so the
// expedition walks out of it.
function giveUp(bot, ctx, a, item) {
  const t = a.hand && a.hand.t
  a.hand = null
  if (!t) return
  unreachable.mark(ctx, t, CLUSTER_R)
  a.fails = (a.fails | 0) + 1
  console.log(`acquire ${item}: unreachable ${t.x},${t.y},${t.z} (${a.fails}/${AREA_FAILS})`)
  if (a.fails < AREA_FAILS) return
  a.fails = 0
  const p = bot.entity && bot.entity.position
  if (p) unreachable.mark(ctx, p, AREA_R)
  console.log(`acquire ${item}: ${AREA_FAILS} unreachable sources here, leaving the area`)
}

// One tick toward n of item in the pack: 'done' | 'running' | 'failed:<why>'.
// alts: interchangeable variants (sources.family) that count and craft as
// the item — birch planks serve an oak_planks need, any log a log gap.
function acquire(bot, ctx, item, n, path = [], alts = [item]) {
  const a = ctx.acquire || (ctx.acquire = {})
  if (a.mining || (a.hunt && ctx.bring === a.hunt)) return 'running'
  if (!alts.includes(item)) alts = [item, ...alts]
  // Planks under a wood-named parent (oak_fence, birch_door) never pool:
  // 3 oak + 3 birch is not 4 of one wood, so count the best single wood.
  const one = path.length > 0 && alts.every((i) => i.endsWith('_planks')) && !require('./craftany').poolsPlanks(bot, path[path.length - 1])
  const held = one ? Math.max(0, ...alts.map((i) => have(bot, i))) : alts.reduce((t, i) => t + have(bot, i), 0)
  if (held >= n) return 'done'
  if (path.length > S.DEPTH) return `failed:deep-${item}`
  const reg = S.regOf(bot)
  const craftany = require('./craftany')
  let plan = null
  const gaps = []
  for (const i of alts) {
    const want = one ? n : have(bot, i) + n - held
    const p = craftany.planCraft(bot, ctx, [i], want)
    // No table and none placeable (split woods, mats eaten): the table is
    // the gap — acquire one into the pack, craftany then places it.
    if (p.fail === 'no-table' && have(bot, 'crafting_table') === 0 && !path.includes('crafting_table') && item !== 'crafting_table') {
      const r = acquire(bot, ctx, 'crafting_table', 1, [...path, item])
      return r === 'done' ? 'running' : r
    }
    if (p.ok || p.fail === 'no-table') {
      const r = craftany(bot, ctx, i, want)
      return r === 'running' || r.done ? 'running' : `failed:craft-${i}`
    }
    if (i === item) plan = p
    const m = p.fail === 'missing' && p.missing && p.missing[0]
    if (m && !gaps.includes(m.name)) gaps.push(m.name)
  }
  let g = plan && plan.fail === 'missing' && plan.missing && plan.missing[0]
  // A gap with no source near (coal, no ore in range) yields to another
  // recipe variant's gap a furnace makes (charcoal from any log): torches
  // without coal go the log -> charcoal way instead of a coal expedition.
  if (g && !S.smelt(g.name) && Array.isArray(plan.gaps)) {
    const alt = plan.gaps.map((m) => m && m[0]).find((m) => m && m.name !== g.name && S.smelt(m.name))
    const p = bot.entity && bot.entity.position
    // A failed mine of the gap (ore in range but pathless, prod 2026-11-16
    // bot3: explore hunted coal for torches) yields the same way.
    const dead = a.mineFail && a.mineFail.item === g.name
    if (alt && p && (dead || !nearestSource(bot, ctx, [...S.sources(bot, g.name).blocks], p))) { g = alt; gaps.length = 0; gaps.push(alt.name) }
  }
  // A gap whose recipe eats this item back (coal <- coal_block <- coal) is
  // a storage loop: the item comes from the world instead.
  const up = [...path, item]
  if (g && !S.inputsOf(reg, g.name).some((i) => up.includes(i))) {
    const r = acquire(bot, ctx, g.name, g.need, up, gaps)
    return r === 'done' ? 'running' : r
  }
  const sm = S.smelt(item)
  if (sm) {
    // The furnace legs (castlefetch pane/torch, bring smelt) own the burn;
    // acquire brings the raw input so they have something to smelt.
    const raw = sm.raw || 'oak_log'
    if (up.includes(raw)) return `failed:smelt-${item}`
    const r = acquire(bot, ctx, raw, n, up, sm.raw ? [raw] : S.family(raw))
    return r === 'done' ? `failed:smelt-${item}` : r
  }
  const blocks = [...new Set(alts.flatMap((i) => [...S.sources(bot, i).blocks]))]
  const short = n - held
  if (blocks.length) {
    a.blocks = blocks // resources.scan remembers these while the need lives
    if (typeof bot.mine !== 'function') return `failed:no-mine-${item}`
    const count = Math.min(short, room(bot))
    // A full pack sheds junk first (never the items this chain is after),
    // then mines; only a pack with no junk fails to the stockpile bank.
    if (count <= 0) return require('./stockpile').tossJunk(bot, ctx, [...path, ...alts]) ? 'running' : 'failed:pack-full'
    if (a.mineFail && a.mineFail.item === item) {
      // The mine found no path (prod 2026-11-15 bot3: the same pathless
      // birch x133/h): walk to and hand-dig the nearest source not
      // blacklisted (loaded or remembered), blacklisting each one the walk
      // cannot reach; a hand dig re-arms the mine from the new spot.
      if (handTick(bot, ctx, a, item, blocks)) return 'running'
      // Nothing left here: the explore ray expedition (to 400, driven by the
      // castle need) walks out until resources.scan remembers a new one.
      // Explore's own done/failed is not this leg's.
      if (a.expedition !== item) console.log(`acquire ${item}: no reachable source, expedition`)
      a.expedition = item
      const st = ctx.stepStatus
      try { require('./explore')(bot, ctx) } catch (_) { /* next tick retries */ }
      ctx.stepStatus = st
      return 'running'
    }
    a.mining = true
    console.log(`acquire ${item}: mining ${count} from ${blocks.slice(0, 4).join(',')}`)
    bot.mine(blocks, count, { radius: MINE_RADIUS, forbid: (p) => unreachable.near(ctx, p) })
      .catch((e) => { a.mineFail = { item, at: Date.now() }; console.log(`acquire ${item}: ${e && e.message}`) })
      .finally(() => { a.mining = false })
    return 'running'
  }
  if (S.mobsOf(item).includes('sheep')) { // the hunt bring runs (toWoolHunt)
    if (ctx.bring) return 'running' // a foreign order owns the body first
    if (a.hunted === item) { a.hunted = null; return `failed:no-${item}` } // one hunt per need, its result read above
    const bring = require('./bring')
    const o = bring.toWoolHunt(bot, { kind: 'item', name: 'wool', names: [item], want: n, by: null, drop: null, have: 0 }, ctx)
    if (!o) return `failed:no-${item}`
    o.self = 'castle'
    a.hunt = ctx.bring = o
    a.hunted = item
    return 'running'
  }
  return `failed:no-source-${item}`
}

module.exports = { acquire }
