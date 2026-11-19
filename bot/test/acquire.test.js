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
  it('mixed planks under a wood-named parent never pool: 3 oak + 3 birch is short of 4 for oak_fence', () => {
    const items = [{ name: 'oak_planks', count: 3 }, { name: 'birch_planks', count: 3 }]
    const alts = ['oak_planks', 'birch_planks']
    assert.notStrictEqual(tick.acquire(mk(items), {}, 'oak_planks', 4, ['oak_fence'], alts), 'done')
    assert.strictEqual(tick.acquire(mk(items), {}, 'oak_planks', 6, ['chest'], alts), 'done', 'a #planks parent pools')
  })
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
  it('full pack: tosses junk (not the wanted sand, not tools) then mines; no junk fails pack-full', async () => {
    const items = [{ name: 'gravel', type: 1, count: 64 }, { name: 'sand', type: 2, count: 1 }, { name: 'iron_pickaxe', type: 3, count: 1 }]
    const tossed = []
    let free = 0
    const b = mk(items, { inventory: { items: () => items, emptySlotCount: () => free }, castle: undefined, toss: (type, m, n) => { tossed.push(type); items.splice(items.findIndex((i) => i.type === type), 1); free = 1; return Promise.resolve() }, mine: () => new Promise(() => {}) })
    const ctx = { castle: {} }
    assert.strictEqual(tick.acquire(b, ctx, 'sand', 40), 'running')
    for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r))
    assert.deepStrictEqual(tossed, [1])
    assert.strictEqual(tick.acquire(b, ctx, 'sand', 40), 'running')
    assert.ok(ctx.acquire.mining)
    free = 0
    ctx.acquire = null
    assert.strictEqual(tick.acquire(b, {}, 'sand', 40), 'failed:pack-full')
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
  it('a smelted gap mines its raw input, then burns it through furnace.js itself', () => {
    const calls = []
    const b = mk([], { mine: (names) => { calls.push(names); return new Promise(() => {}) } })
    assert.strictEqual(tick.acquire(b, {}, 'glass', 6), 'running')
    assert.deepStrictEqual(calls, [['sand']])
    const orig = tick.deps.driveFurnace
    const jobs = []
    let out = null
    tick.deps.driveFurnace = (_b, c) => { jobs.push(c.furnaceJob); return out }
    try {
      const inv = [{ name: 'sand', count: 6 }, { name: 'furnace', count: 1 }, { name: 'coal', count: 1 }]
      const ctx = {}
      assert.strictEqual(tick.acquire(mk(inv), ctx, 'glass', 6), 'running')
      assert.deepStrictEqual(jobs[0], { input: 'sand', output: 'glass', count: 6 })
      // the sand sits in the furnace now: the started burn keeps the tick, no mine
      const m = []
      assert.strictEqual(tick.acquire(mk([], { mine: (x) => { m.push(x); return new Promise(() => {}) } }), ctx, 'glass', 6), 'running')
      assert.deepStrictEqual(m, [])
      assert.strictEqual(jobs.length, 2)
      out = 'done'
      assert.strictEqual(tick.acquire(mk(inv), ctx, 'glass', 6), 'running')
      assert.strictEqual(tick.acquire(mk([{ name: 'glass', count: 6 }]), ctx, 'glass', 6), 'done')
      out = 'failed:no-home'
      assert.strictEqual(tick.acquire(mk(inv), {}, 'glass', 6), 'failed:smelt-glass-no-home')
    } finally { tick.deps.driveFurnace = orig }
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
  it('an outside mine-stopped is no source failure: the next tick re-arms the mine, not walk-and-dig', async () => {
    const b = mkb([])
    let calls = 0
    b.mine = () => { calls++; return Promise.reject(new Error('mine-stopped')) }
    const ctx = { resources: { items: new Map() } }
    tick.acquire(b, ctx, 'birch_log', 4, [], ['birch_log'])
    await settle()
    assert.ok(!ctx.acquire.mineFail, 'no mineFail on a stop')
    tick.acquire(b, ctx, 'birch_log', 4, [], ['birch_log'])
    assert.strictEqual(calls, 2)
    assert.ok(!ctx.acquire.hand, 'no walk-and-dig')
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

describe('construction material recovery', () => {
  const names = ['oak_log', 'oak_planks', 'stick', 'oak_fence', 'crafting_table']
  const ids = Object.fromEntries(names.map((name, i) => [name, i + 1]))
  const recipe = (out, ingredients, count, requiresTable = false) => ({
    delta: Object.entries(ingredients).map(([name, n]) => ({ id: ids[name], count: -n })),
    result: { id: ids[out], count },
    requiresTable,
  })
  const recipes = {
    oak_planks: recipe('oak_planks', { oak_log: 1 }, 4),
    oak_fence: recipe('oak_fence', { oak_planks: 4, stick: 2 }, 3, true),
    crafting_table: recipe('crafting_table', { oak_planks: 4 }, 1),
  }
  const settle = () => new Promise((resolve) => setImmediate(resolve))

  function fixture(t, pack) {
    const Vec3 = require('vec3')
    const gear = require('../src/behaviours/gear')
    const blocks = new Map([['100,64,0', 'crafting_table']])
    const crafts = []
    const mines = []
    const bot = {
      entity: { position: new Vec3(0.5, 64, 0.5) },
      registry: { itemsByName: Object.fromEntries(names.map((name) => [name, { id: ids[name] }])) },
      inventory: { items: () => Object.entries(pack).filter(([, count]) => count > 0).map(([name, count]) => ({ name, count })) },
      recipesAll(id) { return [recipes[names[id - 1]]].filter(Boolean) },
      recipesFor(id) { return this.recipesAll(id).filter((r) => r.delta.every((d) => pack[names[d.id - 1]] >= -d.count)) },
      blockAt(p) {
        const name = blocks.get(`${p.x},${p.y},${p.z}`) || (p.y < 64 ? 'dirt' : 'air')
        return { name, position: p, boundingBox: name === 'air' ? 'empty' : 'block' }
      },
      pathfinder: { setGoal(goal) { this.goal = goal } },
      async placeBlock(ref, face) {
        const p = ref.position.plus(face)
        blocks.set(`${p.x},${p.y},${p.z}`, 'crafting_table')
        pack.crafting_table--
      },
      async mine(blockNames, n) {
        mines.push({ blockNames, n })
        pack.oak_log = (pack.oak_log || 0) + n
      },
    }
    t.mock.method(gear, 'runOp', (_bot, _ctx, op, onDone) => {
      crafts.push(op)
      for (const d of op.recipe.delta) pack[names[d.id - 1]] += d.count
      pack[op.item] = (pack[op.item] || 0) + op.recipe.result.count
      if (onDone) onDone()
    })
    return { bot, blocks, crafts, mines }
  }

  it('replaces an unreachable table, mines the extra wood, then makes a fence', async (t) => {
    const pack = { oak_planks: 4, stick: 2 }
    const { bot, blocks, crafts, mines } = fixture(t, pack)
    blocks.set('20,64,0', 'crafting_table')
    const ctx = {
      stepStatus: 'running',
      home: { table: { x: 100, y: 64, z: 0 } },
      claimedTable: { x: 20, y: 64, z: 0 },
    }
    for (let i = 0; i < 50 && !pack.oak_fence; i++) {
      assert.equal(tick.buildMaterial(bot, ctx, 'oak_fence', 1, ['oak_fence']), 'running')
      await settle()
    }
    assert.equal(pack.oak_fence, 3)
    assert.deepEqual(crafts.map((op) => op.item), ['crafting_table', 'oak_planks', 'oak_fence'])
    assert.ok(crafts.at(-1).table.position.x < 10)
    assert.deepEqual(mines, [{ blockNames: ['oak_log'], n: 1 }])
    assert.equal(ctx.stepStatus, 'running')
  })

  it('crafts an affordable plank batch without mining the full deficit first', (t) => {
    const pack = { oak_log: 1 }
    const { bot, mines } = fixture(t, pack)
    assert.equal(tick.buildMaterial(bot, {}, 'oak_planks', 64, ['oak_planks']), 'running')
    assert.equal(pack.oak_planks, 4)
    assert.deepEqual(mines, [])
  })

  it('a loaded house sources its next missing item from a newly discovered chest', async (t) => {
    const build = require('../src/behaviours/build')
    const { MENU } = require('../src/goal')
    const Vec3 = require('vec3')
    const pack = {}
    const { bot, blocks, crafts } = fixture(t, pack)
    const chest = new Vec3(-2, 64, 0)
    blocks.set('-2,64,0', 'chest')
    bot.registry.blocksByName = { chest: { id: 100 } }
    bot.findBlocks = ({ matching }) => matching.includes(100) ? [chest] : []
    bot.openChest = async () => ({
      containerItems: () => [{ name: 'crafting_table', type: ids.crafting_table, count: 1 }],
      withdraw: async () => { pack.crafting_table = 1 },
      close: async () => {},
    })
    const ctx = { step: 'build', stepStatus: 'running', home: { site: { x: 0, y: 64, z: 0 } } }
    assert.equal(MENU.build.feasible({ time: 'day', planks: 0, table: 0, door: 0 }, bot, ctx), true)
    build(bot, ctx)
    await settle()
    assert.equal(pack.crafting_table, 1)
    assert.equal(ctx.stepStatus, 'running')
    assert.deepEqual(crafts, [])
  })
})
