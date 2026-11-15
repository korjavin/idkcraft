'use strict'
const { describe, it } = require('node:test')
const assert = require('node:assert')
const acq = require('../src/sources')
const tick = require('../src/behaviours/acquire')

const bot = { registry: acq.DEFAULT_REG }

describe('acquire sources: recipe tree, block drops, mobs', () => {
  it('recurses a recipe down to raw: stairs -> planks -> logs', () => {
    assert.ok(acq.inputsOf(acq.DEFAULT_REG, 'oak_stairs').includes('oak_planks'))
    assert.deepStrictEqual([...acq.sources(bot, 'oak_stairs').blocks], ['oak_log'])
  })
  it('finds the block that drops an item: cobblestone from stone, sand from sand', () => {
    assert.ok(acq.sources(bot, 'cobblestone').blocks.has('stone'))
    assert.deepStrictEqual([...acq.sources(bot, 'sand').blocks], ['sand'])
  })
  it('a storage loop falls through to the ore: coal from coal_ore, not coal_block', () => {
    const b = acq.sources(bot, 'coal').blocks
    assert.ok(b.has('coal_ore') && !b.has('coal_block'))
  })
  it('a furnace output sources its input: glass pane -> sand', () => {
    assert.deepStrictEqual([...acq.kindSources('pane')], ['sand'])
  })
  it('wool comes from sheep, not a laid wool block', () => {
    const s = acq.sources(bot, 'white_wool')
    assert.deepStrictEqual([...s.mobs], ['sheep'])
    assert.strictEqual(s.blocks.size, 0)
  })
  it('stone has no castle-kind source (its own quarry path)', () => {
    assert.strictEqual(acq.kindSources('stone').size, 0)
  })
})

describe('acquire tick', () => {
  const mk = (items, extra) => ({ registry: acq.DEFAULT_REG, inventory: { items: () => items, emptySlotCount: () => 10 }, recipesAll: () => [], ...extra })
  it('done when the pack holds the need', () => {
    assert.strictEqual(tick.acquire(mk([{ name: 'sand', count: 5 }]), {}, 'sand', 4), 'done')
  })
  it('mines a raw gap in one batch for the whole remainder', () => {
    const calls = []
    const b = mk([{ name: 'sand', count: 1 }], { mine: (names, n) => { calls.push([names, n]); return new Promise(() => {}) } })
    const ctx = {}
    assert.strictEqual(tick.acquire(b, ctx, 'sand', 40), 'running')
    assert.deepStrictEqual(calls, [[['sand'], 39]])
    assert.deepStrictEqual(ctx.acquire.blocks, ['sand'])
    assert.strictEqual(tick.acquire(b, ctx, 'sand', 40), 'running', 'in flight')
    assert.strictEqual(calls.length, 1)
  })
  it('no source in reach: runs the explore expedition (running), then walks to a remembered far find', () => {
    const goalsSet = []
    const b = mk([], { mine: () => new Promise(() => {}), entity: { position: { x: 0, y: 64, z: 0 } }, blockAt: () => null, pathfinder: { setGoal: (g) => goalsSet.push(g) } })
    const ctx = { acquire: { mineFail: { item: 'sand', at: Date.now() } }, resources: { items: new Map() }, stepStatus: 'running' }
    assert.strictEqual(tick.acquire(b, ctx, 'sand', 4), 'running')
    assert.ok(ctx.explore, 'the explore tick ran')
    assert.strictEqual(ctx.acquire.expedition, 'sand')
    assert.strictEqual(ctx.stepStatus, 'running', 'explore status stays its own')
    ctx.resources.items.set('k', { x: 300, y: 64, z: 0, name: 'sand' })
    assert.strictEqual(tick.acquire(b, ctx, 'sand', 4), 'running')
    assert.deepStrictEqual(ctx.acquire.hand.t, { x: 300, y: 64, z: 0 })
    assert.strictEqual(goalsSet.length, 1)
  })
  it('fails honestly with no mine on the body', () => {
    assert.strictEqual(tick.acquire(mk([]), {}, 'sand', 4), 'failed:no-mine-sand')
  })
})

describe('acquire review fixes', () => {
  it('the concrete castle item keeps every variant of the same recipe shape: birch_door -> oak_log too, no iron ore', () => {
    const ctx = { castleWord: { kind: 'door' }, castleNeed: { kind: 'door', item: 'birch_door' } }
    const b = acq.needSources(ctx)
    assert.ok(b.has('birch_log') && b.has('oak_log'), 'any wood variant serves a birch door need')
    assert.ok(!b.has('iron_ore'), 'iron_door is another recipe shape')
    ctx.castleNeed.kind = 'fence' // stale need for another kind: the alias again
    assert.ok(acq.needSources(ctx).has('iron_ore'))
  })
  it('need finds have their own cap and never evict other finds', () => {
    const res = require('../src/resources')
    const ctx = {}
    res.noteSpots(ctx, [{ x: 0, y: 10, z: 0, name: 'diamond_ore' }], 1)
    const many = []
    for (let i = 1; i <= 300; i++) many.push({ x: i, y: 60, z: 0, name: 'sand', need: true })
    res.noteSpots(ctx, many, 2)
    assert.ok(ctx.resources.items.has('0,10,0'), 'the ore survives')
    assert.strictEqual(ctx.resources.items.size, 1 + res.NEED_MAX)
    assert.ok(ctx.resources.items.has('300,60,0'), 'newest need find kept')
  })
})

describe('every castle kind resolves to an acquire path (owner: the class, not one material)', () => {
  const castle = require('../src/castle')
  const cf = require('../src/behaviours/castlefetch')
  const kinds = new Set()
  for (const v of [1, 2, 3]) {
    for (const c of castle.blueprintOf(v).PLAN) kinds.add(c.kind)
    for (const c of castle.DECOR[v] || []) kinds.add(c.kind)
  }
  const empty = { registry: acq.DEFAULT_REG, inventory: { items: () => [] } }
  for (const kind of [...kinds].filter(castle.isPlaceTarget)) {
    it(`${kind}: an item the kind lays, with a world source`, () => {
      const item = cf.acquireItem(empty, kind)
      assert.ok(item, `no acquire item for ${kind}`)
      assert.ok(castle.matches(kind, item), `${item} is not ${kind}`)
      const s = acq.sources(empty, item)
      assert.ok(s.blocks.size + s.mobs.size > 0, `${item} has no world source`)
      assert.ok(acq.kindItem(kind), `kindItem derives none for ${kind}`)
    })
  }
})

describe('acquire: variants and smelting', () => {
  const mk = (items, extra) => ({ registry: acq.DEFAULT_REG, inventory: { items: () => items, emptySlotCount: () => 10 }, recipesAll: () => [], ...extra })
  it('family keeps the recipe shape: any log-made planks, never iron for oak', () => {
    assert.ok(acq.family('oak_planks').includes('birch_planks'))
    assert.ok(acq.family('oak_log').includes('dark_oak_log'))
    assert.ok(!acq.family('oak_door').includes('iron_door'))
    assert.deepStrictEqual(acq.family('iron_ingot'), ['iron_ingot'])
  })
  it('a variant on hand counts toward the need', () => {
    assert.strictEqual(tick.acquire(mk([{ name: 'birch_planks', count: 8 }]), {}, 'oak_planks', 8, [], acq.family('oak_planks')), 'done')
  })
  it('a crafted need with no wood mines any log variant', () => {
    const calls = []
    const b = mk([], { mine: (names) => { calls.push(names); return new Promise(() => {}) } })
    assert.strictEqual(tick.acquire(b, {}, 'oak_planks', 8, [], acq.family('oak_planks')), 'running')
    assert.ok(calls[0].includes('oak_log') && calls[0].includes('birch_log') && calls[0].includes('spruce_log'))
  })
  it('a smelted gap mines its raw input, then hands the furnace leg the burn', () => {
    const calls = []
    const b = mk([], { mine: (names) => { calls.push(names); return new Promise(() => {}) } })
    assert.strictEqual(tick.acquire(b, {}, 'glass', 6), 'running')
    assert.deepStrictEqual(calls, [['sand']])
    assert.strictEqual(tick.acquire(mk([{ name: 'sand', count: 6 }]), {}, 'glass', 6), 'failed:smelt-glass')
  })
})

describe('no source in reach: expedition everywhere', () => {
  const explore = require('../src/behaviours/explore')
  it('a gather that ended no-trees opens the wood expedition until a log is remembered', () => {
    const ctx = { gather: { farEmpty: true }, resources: { items: new Map() } }
    assert.strictEqual(explore.expedition(ctx), true)
    ctx.resources.items.set('k', { x: 300, y: 64, z: 0, name: 'birch_log' })
    assert.strictEqual(explore.expedition(ctx), false)
    assert.strictEqual(explore.expedition({ gather: {}, resources: { items: new Map() } }), false)
  })
})

describe('acquire: unreachable sources (prod 2026-11-15 bot3 pathless birch loop)', () => {
  const unreachable = require('../src/unreachable')
  const logs = [{ x: 5, y: 64, z: 0 }, { x: 20, y: 64, z: 0 }, { x: 30, y: 64, z: 0 }, { x: 40, y: 64, z: 0 }]
  const mkb = (dug) => {
    const pos = { x: 0, y: 64, z: 0 }
    return {
      registry: acq.DEFAULT_REG,
      inventory: { items: () => [], emptySlotCount: () => 10 },
      recipesAll: () => [],
      mine: () => Promise.reject(new Error('mine-noPath')),
      entity: { position: pos },
      findBlocks: () => logs.map((l) => ({ ...l })),
      blockAt: (v) => ({ name: 'birch_log', position: v }),
      dig: async (b) => { dug.push(b.position.x) },
      pathfinder: { setGoal() {} },
    }
  }
  const settle = () => new Promise((r) => setImmediate(r))
  it('a pathless nearest log is blacklisted and the next one is dug', async () => {
    const dug = []
    const b = mkb(dug)
    const ctx = { resources: { items: new Map() } }
    tick.acquire(b, ctx, 'birch_log', 4, [], ['birch_log'])
    await settle()
    assert.ok(ctx.acquire.mineFail, 'mine-noPath recorded')
    tick.acquire(b, ctx, 'birch_log', 4, [], ['birch_log'])
    assert.strictEqual(ctx.acquire.hand.t.x, 5)
    for (let i = 0; i < 20; i++) tick.acquire(b, ctx, 'birch_log', 4, [], ['birch_log']) // never closer
    assert.ok(unreachable.near(ctx, { x: 5, z: 0 }), 'first log blacklisted')
    assert.strictEqual(ctx.acquire.hand.t.x, 20, 'next candidate')
    b.entity.position.x = 18 // walked in reach
    tick.acquire(b, ctx, 'birch_log', 4, [], ['birch_log'])
    await settle(); await settle()
    assert.deepStrictEqual(dug, [20])
    assert.strictEqual(ctx.acquire.mineFail, null, 'the mine re-arms from here')
  })
  it('every nearby source unreachable: the area is left on the expedition, and gather skips it', () => {
    const b = mkb([])
    const ctx = { acquire: { mineFail: { item: 'birch_log', at: Date.now() } }, resources: { items: new Map() }, stepStatus: 'running' }
    for (let i = 0; i < 80 && !ctx.acquire.expedition; i++) tick.acquire(b, ctx, 'birch_log', 4, [], ['birch_log'])
    assert.strictEqual(ctx.acquire.expedition, 'birch_log')
    assert.ok(ctx.explore, 'explore ran')
    for (const l of logs) assert.ok(unreachable.near(ctx, l))
    // gather reads the same list (its banned())
    assert.match(require('fs').readFileSync(require('path').join(__dirname, '../src/behaviours/gather.js'), 'utf8'), /unreachable'\)\.near\(ctx, p\)/)
  })
  it('blacklist entries expire', () => {
    const ctx = {}
    unreachable.mark(ctx, { x: 0, z: 0 }, 3, 0)
    assert.ok(unreachable.near(ctx, { x: 2, z: 0 }, 1))
    assert.ok(!unreachable.near(ctx, { x: 2, z: 0 }, unreachable.TTL_MS + 1))
  })
})
