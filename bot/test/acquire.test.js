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
  it('no source in reach: runs the explore expedition (running), then mines a remembered far find', () => {
    const calls = []
    const b = mk([], { mine: (names, n, o) => { calls.push(o.radius); return new Promise(() => {}) }, entity: { position: { x: 0, y: 64, z: 0 } } })
    const ctx = { acquire: { mineFail: { item: 'sand', at: Date.now() } }, resources: { items: new Map() }, stepStatus: 'running' }
    assert.strictEqual(tick.acquire(b, ctx, 'sand', 4), 'running')
    assert.ok(ctx.explore, 'the explore tick ran')
    assert.strictEqual(ctx.acquire.expedition, 'sand')
    assert.strictEqual(ctx.stepStatus, 'running', 'explore status stays its own')
    assert.strictEqual(calls.length, 0)
    ctx.resources.items.set('k', { x: 300, y: 64, z: 0, name: 'sand' })
    assert.strictEqual(tick.acquire(b, ctx, 'sand', 4), 'running')
    assert.deepStrictEqual(calls, [316])
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
