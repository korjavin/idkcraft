'use strict'

// Generic material resolver (owner: solve the class, not per material).
// acquire(bot, ctx, item, n) is one tick: the pack holds n -> 'done'; a
// recipe runs -> craftany; a recipe short of an input -> recurse on that
// input; no recipe -> the world source minecraft-data names (a block that
// drops it, mined in one batch for the whole remaining need; or a mob from
// the small MOB table, hunted by a self bring order). Chests stay the
// caller's first rung (castlefetch chestTick). Smelting is not run here:
// a smelt-only gap fails 'smelt-<item>' (castlefetch's pane/torch ticks own
// the furnace). sources() is the same tree as pure data: explore's
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

// One tick toward n of item in the pack: 'done' | 'running' | 'failed:<why>'.
function acquire(bot, ctx, item, n, path = []) {
  const a = ctx.acquire || (ctx.acquire = {})
  if (a.mining || (a.hunt && ctx.bring === a.hunt)) return 'running'
  if (have(bot, item) >= n) return 'done'
  if (path.length > S.DEPTH) return `failed:deep-${item}`
  const reg = S.regOf(bot)
  const craftany = require('./craftany')
  const plan = craftany.planCraft(bot, ctx, [item], n)
  if (plan.ok || plan.fail === 'no-table') {
    const r = craftany(bot, ctx, item, n)
    return r === 'running' || r.done ? 'running' : `failed:craft-${item}`
  }
  const g = plan.fail === 'missing' && plan.missing && plan.missing[0]
  // A gap whose recipe eats this item back (coal <- coal_block <- coal) is
  // a storage loop: the item comes from the world instead.
  const up = [...path, item]
  if (g && !S.inputsOf(reg, g.name).some((i) => up.includes(i))) {
    const r = acquire(bot, ctx, g.name, g.need, up)
    return r === 'done' ? 'running' : r
  }
  if (S.smelt(item)) return `failed:smelt-${item}` // its source (sand, ore) is not the item
  const blocks = [...S.sources(bot, item).blocks]
  const short = n - have(bot, item)
  if (blocks.length) {
    a.blocks = blocks // resources.scan remembers these while the need lives
    if (typeof bot.mine !== 'function') return `failed:no-mine-${item}`
    const count = Math.min(short, room(bot))
    if (count <= 0) return 'failed:pack-full'
    if (a.mineFail && a.mineFail.item === item && Date.now() - a.mineFail.at < 60000) return `failed:no-${item}`
    a.mining = true
    console.log(`acquire ${item}: mining ${count} from ${blocks.slice(0, 4).join(',')}`)
    bot.mine(blocks, count, { radius: MINE_RADIUS })
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
