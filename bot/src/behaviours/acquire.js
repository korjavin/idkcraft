'use strict'

// Generic material resolver (owner: solve the class, not per material).
// acquire(bot, ctx, item, n) is one tick: the pack holds n -> 'done'; a
// recipe runs -> craftany; a recipe short of an input -> recurse on that
// input; no recipe -> the world source minecraft-data names (a block that
// drops it, mined in one batch for the whole remaining need; or a mob from
// the small MOB table, hunted by a self bring order). Chests stay the
// caller's first rung (castlefetch chestTick). A smelt gap acquires its raw
// input (sand, ore, a log), then burns it through furnace.js (smeltTick). sources() is the same tree as pure data: explore's
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
    try { if (ctx.farmBuild && require('../farm-blueprint').protects(ctx.farmBuild, c, c.name || blocks[0])) continue } catch (_) { /* unguarded */ }
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

// 'mine rate item=X mined=N/min travel=D': once a minute while a mine runs
// and once at its end, so prod mining efficiency is measurable.
function mineRate(bot, a, end) {
  const r = a.rate
  if (!r) return
  const now = Date.now()
  if (!end && now - r.at < 60000) return
  r.at = now
  const mined = r.alts.reduce((t, i) => t + have(bot, i), 0) - r.have0
  const min = Math.max(now - r.t0, 1000) / 60000
  const p = bot.entity && bot.entity.position
  const travel = p && r.p0 ? Math.round(Math.hypot(p.x - r.p0.x, p.y - r.p0.y, p.z - r.p0.z)) : 0
  console.log(`mine rate item=${r.item} mined=${(mined / min).toFixed(1)}/min total=${mined} travel=${travel}${end ? ' end' : ''}`)
  if (end) a.rate = null
}

// One tick toward n of item in the pack: 'done' | 'running' | 'failed:<why>'.
// alts: interchangeable variants (sources.family) that count and craft as
// the item — birch planks serve an oak_planks need, any log a log gap.
function acquire(bot, ctx, item, n, path = [], alts = [item], construction = false) {
  const a = ctx.acquire || (ctx.acquire = {})
  if (a.mining) { mineRate(bot, a, false); return 'running' }
  if (construction && (ctx.gearInFlight || ctx.craftany?.tableP || a.buildChestBusy)) return 'running'
  if (a.hunt && ctx.bring === a.hunt) return 'running'
  if (!alts.includes(item)) alts = [item, ...alts]
  // Planks under a wood-named parent (oak_fence, birch_door) never pool:
  // 3 oak + 3 birch is not 4 of one wood, so count the best single wood.
  const one = path.length > 0 && alts.every((i) => i.endsWith('_planks')) && !require('./craftany').poolsPlanks(bot, path[path.length - 1])
  const held = one ? Math.max(0, ...alts.map((i) => have(bot, i))) : alts.reduce((t, i) => t + have(bot, i), 0)
  if (held >= n) return 'done'
  if (path.length > S.DEPTH) return `failed:deep-${item}`
  if (construction && typeof bot.openChest === 'function') {
    const chest = fromChest(bot, ctx, alts, n, { construction, singleVariant: one })
    if (chest !== 'none') return chest
  }
  const reg = S.regOf(bot)
  const craftany = require('./craftany')
  let plan = null
  let tableBlocked = false
  const gaps = []
  const options = { recoverTable: construction }
  for (const i of alts) {
    const want = construction ? n - (one ? have(bot, i) : held)
      : one ? n : have(bot, i) + n - held
    const p = craftany.planCraft(bot, ctx, [i], want, options)
    if (construction) {
      if (p.ok) return craftBuildMaterial(craftany, bot, ctx, i, want)
      if (p.fail === 'no-table' || p.makeTable) tableBlocked = true
    }
    // No table and none placeable (split woods, mats eaten): the table is
    // the gap — acquire one into the pack, craftany then places it.
    if (!construction && p.fail === 'no-table' && have(bot, 'crafting_table') === 0 && !path.includes('crafting_table') && item !== 'crafting_table') {
      const r = acquire(bot, ctx, 'crafting_table', 1, [...path, item])
      return r === 'done' ? 'running' : r
    }
    if (!construction && (p.ok || p.fail === 'no-table')) {
      const r = craftany(bot, ctx, i, want)
      return r === 'running' || r.done ? 'running' : `failed:craft-${i}`
    }
    if (i === item) plan = p
    const m = p.fail === 'missing' && p.missing && p.missing[0]
    if (m && !gaps.includes(m.name)) gaps.push(m.name)
  }
  if (construction && path.length === 0 && n - held > 1) {
    // A full batch may need more wood even when the next cell can be built.
    for (const i of alts) {
      const p = craftany.planCraft(bot, ctx, [i], 1, options)
      if (p.ok) return craftBuildMaterial(craftany, bot, ctx, i, 1)
      if (p.fail === 'no-table' || p.makeTable) tableBlocked = true
    }
  }
  if (tableBlocked && item !== 'crafting_table' && !path.includes('crafting_table') && have(bot, 'crafting_table') === 0) {
    const r = acquire(bot, ctx, 'crafting_table', 1, [...path, item], ['crafting_table'], construction)
    return r === 'done' ? 'running' : r
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
    const r = acquire(bot, ctx, g.name, g.need, up, gaps, construction)
    return r === 'done' ? 'running' : r
  }
  if (FILL[item]) return fillTick(bot, ctx, a, item, up)
  const sm = S.smelt(item)
  if (sm) {
    const raw = sm.raw || 'oak_log'
    if (up.includes(raw)) return `failed:smelt-${item}`
    const raws = sm.raw ? [raw] : S.family(raw)
    // A started burn owns the tick: the raw input sits in the furnace now.
    const r = a.smelt && a.smelt.item === item && a.smelt.started ? 'done' : acquire(bot, ctx, raw, n - held, up, raws)
    return r === 'done' ? smeltTick(bot, ctx, a, item, n - held, raws, up) : r
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
    const p0 = bot.entity && bot.entity.position
    a.rate = { item, alts, t0: Date.now(), at: Date.now(), have0: held, p0: p0 ? { x: p0.x, y: p0.y, z: p0.z } : null }
    console.log(`acquire ${item}: mining ${count} from ${blocks.slice(0, 4).join(',')}`)
    bot.mine(blocks, count, { radius: MINE_RADIUS, forbid: (p) => unreachable.near(ctx, p) })
      .catch((e) => {
        // An outside stop (fight, owner stop, step change) is no failure of
        // the source: the next tick re-arms the mine, not a walk-and-dig.
        if (!(e && e.message === 'mine-stopped')) a.mineFail = { item, at: Date.now() }
        console.log(`acquire ${item}: ${e && e.message}`)
      })
      .finally(() => { mineRate(bot, a, true); a.mining = false })
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

function craftBuildMaterial(craftany, bot, ctx, item, count) {
  const r = craftany(bot, ctx, item, count, { recoverTable: true })
  return r === 'running' || r.done ? 'running' : `failed:craft-${item}`
}

function buildMaterial(bot, ctx, item, n, alts) {
  return acquire(bot, ctx, item, n, [], alts, true)
}

const BUILD_ITEM = {
  soil: 'dirt', ground: 'dirt', fill: 'oak_planks', planks: 'oak_planks',
  fence: 'oak_fence', gate: 'oak_fence_gate', door: 'oak_door', chest: 'chest',
  table: 'crafting_table', farmland: 'wooden_hoe', water: 'water_bucket',
}

function acquireCellMaterial(bot, ctx, home, cell) {
  const { wantItem, FILLERS, blueprintFor, cellDone } = require('./build')
  const item = BUILD_ITEM[cell.kind]
  const want = wantItem(cell)
  const alts = cell.kind === 'ground' ? [...FILLERS] : S.family(item).filter(want)
  let n = 1
  if (cell.kind !== 'farmland' && cell.kind !== 'water') {
    n = Math.max(1, Math.min(64, blueprintFor(home).filter((c) => c.kind === cell.kind && !cellDone(bot, home, c)).length))
  }
  return buildMaterial(bot, ctx, item, n, alts)
}

// Filled buckets (qphv.2): no recipe, no drop — an empty bucket (acquired
// like any item: pack, craft from iron, ...) used on the nearest still
// source (castle/farm water excluded by nearestSource) or a cow.
const FILL = { water_bucket: { block: 'water' }, lava_bucket: { block: 'lava' }, milk_bucket: { mobs: ['cow', 'mooshroom'] } }
const FILL_SETTLE_MS = 600

function fillTick(bot, ctx, a, item, up) {
  if (a.filling) return 'running'
  if (have(bot, 'bucket') <= 0) {
    if (up.includes('bucket')) return `failed:no-source-${item}`
    const r = acquire(bot, ctx, 'bucket', 1, up)
    return r === 'done' ? 'running' : r
  }
  const p = bot.entity && bot.entity.position
  if (!p) return 'running'
  const spec = FILL[item]
  let t = null
  let ent = null
  if (spec.block) {
    t = a.fill && a.fill.item === item ? a.fill.t : nearestSource(bot, ctx, [spec.block], p)
    if (!t) return `failed:no-source-${item}`
    let b = null
    try { b = bot.blockAt(new Vec3(t.x, t.y, t.z)) } catch (_) { b = null }
    const props = b && typeof b.getProperties === 'function' ? b.getProperties() : {}
    if (b && (b.name !== spec.block || Number(props.level || 0) !== 0)) { unreachable.mark(ctx, t, 0.5); a.fill = null; return 'running' } // flowing or gone: next source
  } else {
    try { ent = bot.nearestEntity((e) => e && spec.mobs.includes(e.name) && !unreachable.near(ctx, e.position)) } catch (_) { ent = null }
    if (!ent) return `failed:no-source-${item}`
    t = { x: Math.floor(ent.position.x), y: Math.floor(ent.position.y), z: Math.floor(ent.position.z) }
  }
  const f = a.fill && a.fill.item === item ? a.fill : (a.fill = { item, t, best: Infinity, waits: 0 })
  f.t = t
  const d = Math.hypot(t.x + 0.5 - p.x, t.y + 0.5 - (p.y + 1.6), t.z + 0.5 - p.z)
  if (d <= DIG_REACH - 0.5) {
    const before = have(bot, item)
    a.filling = true
    ;(async () => {
      await bot.equip(bot.inventory.items().find((i) => i.name === 'bucket'), 'hand')
      if (ent) await bot.activateEntity(ent)
      else { await bot.lookAt(new Vec3(t.x + 0.5, t.y + 0.5, t.z + 0.5), true); await bot.activateItem() }
      await new Promise((r) => setTimeout(r, FILL_SETTLE_MS))
    })().catch(() => {}).finally(() => {
      a.filling = false
      a.fill = null
      if (have(bot, item) > before) console.log(`acquire ${item}: filled at ${t.x},${t.y},${t.z}`)
      else unreachable.mark(ctx, t, 0.5) // a missed use: the next source
    })
    return 'running'
  }
  if (d < f.best - 1) { f.best = d; f.waits = 0 } else f.waits++
  if (f.waits > WALK_WAITS) { unreachable.mark(ctx, t, CLUSTER_R); a.fill = null; return 'running' }
  try { if (f.goal == null || bot.pathfinder.goal !== f.goal) bot.pathfinder.setGoal(f.goal = new goals.GoalNear(t.x, t.y, t.z, 2)) } catch (_) { /* next tick retries */ }
  return 'running'
}

// Chest rung (qphv.2, chests are a shared store): the castle's chest-first
// order for any caller — up to n of names from the nearest chest that may
// hold one (bring.pickChest: home, then remembered sightings incl. peers', a fresh read without it skipped).
// 'done' (pack holds n) | 'running' | 'none' (no chest left to try: the
// caller goes on to acquire). One open per chest per need.
const CHEST_REACH = 3.5
const BUILD_CHEST_RADIUS = 64
const BUILD_CHEST_RETRY_MS = 60000
function fromChest(bot, ctx, names, n, { construction = false, singleVariant = false } = {}) {
  const counts = names.map((i) => have(bot, i))
  const held = singleVariant ? Math.max(0, ...counts) : counts.reduce((t, v) => t + v, 0)
  if (held >= n) return 'done'
  const a = ctx.acquire || (ctx.acquire = {})
  const key = names.join(',')
  let c
  if (construction) {
    // Keep each ingredient's chest search while its parent is replanned.
    const searches = a.buildChests || (a.buildChests = new Map())
    c = searches.get(key)
    if (!c || (!c.pos && Date.now() - c.at >= BUILD_CHEST_RETRY_MS)) {
      c = { seen: [], pos: null, at: Date.now() }
      searches.set(key, c)
      if (!a.buildChestScanAt || c.at - a.buildChestScanAt >= BUILD_CHEST_RETRY_MS) {
        require('./chestsearch').scanWide(bot, ctx, BUILD_CHEST_RADIUS)
        a.buildChestScanAt = c.at
      }
    }
  } else {
    if (!a.chest || a.chest.key !== key) a.chest = { key, seen: [], pos: null }
    c = a.chest
  }
  if (c.busy) return 'running'
  const stock = require('./stockpile')
  if (!c.pos) {
    const pick = require('./bring').pickChest(bot, ctx, {
      wants: (x) => names.includes(x), chestSeen: c.seen,
      maxChestDistance: construction ? BUILD_CHEST_RADIUS : undefined,
    })
    if (!pick) return 'none'
    c.pos = pick.pos
    c.best = Infinity
    c.waits = 0
  }
  const p = bot.entity && bot.entity.position
  if (!p) return 'running'
  const at = c.pos
  const k = stock.chestKeyOf(at)
  const d = Math.hypot(at.x + 0.5 - p.x, at.y + 0.5 - p.y, at.z + 0.5 - p.z)
  if (d > CHEST_REACH) {
    if (d < c.best - 0.5) { c.best = d; c.waits = 0 } else c.waits++
    if (c.waits > WALK_WAITS) { stock.markChestFailed(ctx, at); c.seen.push(k); c.pos = null; return 'running' }
    try { if (c.goal == null || bot.pathfinder.goal !== c.goal) bot.pathfinder.setGoal(c.goal = new goals.GoalNear(at.x, at.y, at.z, 2)) } catch (_) { /* next tick retries */ }
    return 'running'
  }
  c.busy = true
  if (construction) a.buildChestBusy = true
  c.goal = null
  stock.withdrawAnyFromChest(bot, ctx, names, n - held, at)
    .then((r) => { if (r && r.got) console.log(`acquire ${names[0]}: drew ${r.got} from the chest at ${k}`) })
    .catch(() => {})
    .finally(() => {
      c.busy = false
      if (construction) a.buildChestBusy = false
      c.seen.push(k)
      c.pos = null
    })
  return 'running'
}

// Seam for unit tests: one furnace.js tick through gear's driveLeg wrapper
// (the building block the castlefetch and bring smelt legs drive).
const deps = { driveFurnace: (bot, ctx) => require('./gear').driveFurnace(bot, ctx, require('./furnace')) }

// The burn (raw input already in the pack): a furnace (the home's claimed
// or adopted one, else one crafted here; furnace.js places it), fuel
// (coal/charcoal, else planks: logs become planks via craftany), then
// furnace.js loads, waits and takes the output tick by tick. Every tick
// hands back to the brain, so fight/flee preempt between ticks.
function smeltTick(bot, ctx, a, item, want, raws, up) {
  const fur = require('./furnace')
  const spot = fur.furnaceReady(bot, ctx)
  const s = a.smelt && a.smelt.item === item ? a.smelt : (a.smelt = { item, started: false })
  if (!s.started) {
    const r = smeltPrep(bot, ctx, fur, spot, want, up)
    if (r) return r
  }
  const input = raws.reduce((b, i) => (have(bot, i) > have(bot, b) ? i : b), raws[0])
  const fr = ctx.furnace
  let out = null
  if (s.started && fr && fr.settled && fr.result && fr.job && fr.job.output === item) {
    out = fr.result // the window cycle settles async, after driveFurnace returned
    fr.result = null
  } else {
    if (!s.started) {
      if (fr && fr.settled) fr.result = null // a stale outcome never ends the new run
      const fuel = have(bot, 'coal') ? 'coal' : have(bot, 'charcoal') ? 'charcoal' : 'planks'
      console.log(`acquire ${item}: smelt n=${want} fuel=${fuel} furnace=${spot ? `${spot.x},${spot.y},${spot.z}` : 'new'}`)
    }
    s.started = true
    ctx.furnaceJob = { input, output: item, count: want }
    try { out = deps.driveFurnace(bot, ctx) } catch (_) { out = 'failed:leg-threw' }
  }
  if (!out) return 'running'
  ctx.furnaceJob = null
  a.smelt = null
  console.log(`acquire ${item}: smelt ${out}`)
  // done: the next tick counts the pack (a short run smelts again)
  return out === 'done' ? 'running' : `failed:smelt-${item}-${out.replace(/^failed:/, '')}`
}

// Before a burn: a furnace and the fuel for want items. A tick result while
// one is still being acquired, else null.
function smeltPrep(bot, ctx, fur, spot, want, up) {
  if (!spot && have(bot, 'furnace') === 0) {
    const r = acquire(bot, ctx, 'furnace', 1, up)
    return r === 'done' ? 'running' : r
  }
  const coal = have(bot, 'coal') + have(bot, 'charcoal')
  if (coal * fur.ORE_PER_FUEL < want) {
    const planks = S.family('oak_planks')
    const need = Math.ceil((want - coal * fur.ORE_PER_FUEL) / fur.ORE_PER_PLANK)
    if (Math.max(0, ...planks.map((i) => have(bot, i))) < need) {
      const r = acquire(bot, ctx, 'oak_planks', need, up, planks)
      return r === 'done' ? 'running' : r
    }
  }
  return null
}

module.exports = { acquire, buildMaterial, acquireCellMaterial, fromChest, FILL, deps }
