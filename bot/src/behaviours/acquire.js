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

const S = require('../sources')

const MINE_RADIUS = 64

function have(bot, item) {
  let n = 0
  try { for (const it of bot.inventory.items()) if (it && it.name === item) n += it.count || 0 } catch (_) { /* empty */ }
  return n
}

function room(bot) {
  try { return 64 * bot.inventory.emptySlotCount() } catch (_) { return 64 }
}

// Distance to the nearest remembered find of these blocks, null when none.
function nearestFind(bot, ctx, blocks) {
  const p = bot.entity && bot.entity.position
  let best = null
  try {
    for (const it of ctx.resources.items.values()) {
      if (!it || !blocks.includes(it.name)) continue
      const d = p ? Math.hypot(it.x - p.x, it.z - p.z) : 0
      if (best === null || d < best) best = d
    }
  } catch (_) { /* no memory */ }
  return best
}

// One tick toward n of item in the pack: 'done' | 'running' | 'failed:<why>'.
// alts: interchangeable variants (sources.family) that count and craft as
// the item — birch planks serve an oak_planks need, any log a log gap.
function acquire(bot, ctx, item, n, path = [], alts = [item]) {
  const a = ctx.acquire || (ctx.acquire = {})
  if (a.mining || (a.hunt && ctx.bring === a.hunt)) return 'running'
  if (!alts.includes(item)) alts = [item, ...alts]
  const held = alts.reduce((t, i) => t + have(bot, i), 0)
  if (held >= n) return 'done'
  if (path.length > S.DEPTH) return `failed:deep-${item}`
  const reg = S.regOf(bot)
  const craftany = require('./craftany')
  let plan = null
  const gaps = []
  for (const i of alts) {
    const want = have(bot, i) + n - held
    const p = craftany.planCraft(bot, ctx, [i], want)
    if (p.ok || p.fail === 'no-table') {
      const r = craftany(bot, ctx, i, want)
      return r === 'running' || r.done ? 'running' : `failed:craft-${i}`
    }
    if (i === item) plan = p
    const m = p.fail === 'missing' && p.missing && p.missing[0]
    if (m && !gaps.includes(m.name)) gaps.push(m.name)
  }
  const g = plan && plan.fail === 'missing' && plan.missing && plan.missing[0]
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
    if (count <= 0) return 'failed:pack-full'
    let radius = MINE_RADIUS
    if (a.mineFail && a.mineFail.item === item) {
      // No source in reach: the explore ray expedition (to 400, driven by the
      // castle need) walks out until resources.scan remembers one, then the
      // mine reaches for it. Explore's own done/failed is not this leg's.
      const d = nearestFind(bot, ctx, blocks)
      if (d === null) {
        if (a.expedition !== item) console.log(`acquire ${item}: no source within ${MINE_RADIUS}, expedition`)
        a.expedition = item
        const st = ctx.stepStatus
        try { require('./explore')(bot, ctx) } catch (_) { /* next tick retries */ }
        ctx.stepStatus = st
        return 'running'
      }
      radius = Math.max(MINE_RADIUS, Math.ceil(d) + 16)
      a.mineFail = null
      a.expedition = null
    }
    a.mining = true
    console.log(`acquire ${item}: mining ${count} from ${blocks.slice(0, 4).join(',')}`)
    bot.mine(blocks, count, { radius })
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
