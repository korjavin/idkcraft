// idkcraft-neuc.53: castlefetch stone leg on v2 — one bot.mine call for
// the batch shortfall and no bot.dig; a mine-stall keeps the
// failed:castlefetch-dig-stall reason. Run: `cd bot && npm test`.
'use strict'

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')

const castlefetch = require('../src/behaviours/castlefetch')

function mockBot({ items = [], mineImpl = null, digImpl = null } = {}) {
  const calls = { mine: [], dig: [] }
  const bot = {
    calls,
    _items: items,
    entity: { position: { x: 10, y: 64, z: 10 }, onGround: true },
    inventory: { items: () => bot._items },
    blockAt: () => null,
    findBlocks: () => [],
    pathfinder: {},
    chat: () => {},
  }
  if (mineImpl) bot.mine = mineImpl(bot, calls)
  bot.dig = digImpl || (async (block) => { calls.dig.push(block) })
  return bot
}

function stoneCtx() {
  return {
    stepStatus: 'running',
    lastGoalKey: '',
    castleFetchInFlight: false,
    castle: { site: { x: 0, y: 64, z: 0 }, rot: 0, blueprintVersion: 1 },
    castleFetch: { kind: 'stone', chestWaits: 0, skips: 0, noGain: 0, t0: Date.now(), blocks0: 0 },
  }
}

async function flush() {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve))
}

describe('castlefetch v2 mine branch (idkcraft-neuc.53)', () => {
  it('one bot.mine call for the shortfall, no bot.dig, done on resolve', async () => {
    const bot = mockBot({
      items: [{ name: 'stone_pickaxe', count: 1 }],
      mineImpl: (b, calls) => async (names, count, opts) => { calls.mine.push({ names, count, opts }) },
    })
    const ctx = stoneCtx()
    const d = { kind: 'stone', word: 'batch', short: 8 }
    castlefetch.digTick(bot, ctx, ctx.castleFetch, d)
    assert.equal(bot.calls.mine.length, 1, 'exactly one mine call')
    assert.deepEqual(bot.calls.mine[0].names, ['stone', 'cobblestone'])
    assert.equal(bot.calls.mine[0].count, 8)
    assert.equal(bot.calls.mine[0].opts.radius, 32, 'the pickStone search radius')
    assert.equal(typeof bot.calls.mine[0].opts.forbid, 'function')
    assert.equal(bot.calls.dig.length, 0, 'no single digs on the mine path')
    await flush()
    assert.equal(ctx.castleFetchInFlight, false)
    assert.equal(ctx.stepStatus, 'done')
  })

  it('a mine-stall keeps the dig-stall reason string', async () => {
    const bot = mockBot({
      items: [{ name: 'stone_pickaxe', count: 1 }],
      mineImpl: () => async () => { throw new Error('mine-stall') },
    })
    const ctx = stoneCtx()
    castlefetch.digTick(bot, ctx, ctx.castleFetch, { kind: 'stone', word: 'batch', short: 8 })
    await flush()
    await flush()
    assert.equal(bot.calls.dig.length, 0)
    assert.equal(ctx.stepStatus, 'failed:castlefetch-dig-stall')
  })

  it('a mine-noPath ends the leg no-stone', async () => {
    const bot = mockBot({
      items: [{ name: 'stone_pickaxe', count: 1 }],
      mineImpl: () => async () => { throw new Error('mine-noPath') },
    })
    const ctx = stoneCtx()
    castlefetch.digTick(bot, ctx, ctx.castleFetch, { kind: 'stone', word: 'batch', short: 8 })
    await flush()
    await flush()
    assert.equal(ctx.stepStatus, 'failed:castlefetch-no-stone')
  })

  it('a mine-stopped ends the leg unreachable (externally superseded)', async () => {
    const bot = mockBot({
      items: [{ name: 'stone_pickaxe', count: 1 }],
      mineImpl: () => async () => { throw new Error('mine-stopped') },
    })
    const ctx = stoneCtx()
    castlefetch.digTick(bot, ctx, ctx.castleFetch, { kind: 'stone', word: 'batch', short: 8 })
    await flush()
    await flush()
    assert.equal(ctx.stepStatus, 'failed:castlefetch-unreachable')
  })

  it('a batch leg mines at most one BATCH', async () => {
    const bot = mockBot({
      items: [{ name: 'stone_pickaxe', count: 1 }],
      mineImpl: (b, calls) => async (names, count, opts) => { calls.mine.push({ names, count, opts }) },
    })
    const ctx = stoneCtx()
    castlefetch.digTick(bot, ctx, ctx.castleFetch, { kind: 'stone', word: 'batch', short: 88 })
    assert.equal(bot.calls.mine.length, 1)
    assert.equal(bot.calls.mine[0].count, 16, 'capped at castle BATCH')
    await flush()
  })

  it('the mine carries the site guard box', async () => {
    const bot = mockBot({
      items: [{ name: 'stone_pickaxe', count: 1 }],
      mineImpl: (b, calls) => async (names, count, opts) => { calls.mine.push({ names, count, opts }) },
    })
    const ctx = stoneCtx()
    castlefetch.digTick(bot, ctx, ctx.castleFetch, { kind: 'stone', word: 'batch', short: 8 })
    const guard = bot.calls.mine[0].opts.guard
    assert.deepEqual(guard, castlefetch.siteGuardBox(ctx.castle))
    assert.equal(guard.x0, -1)
    assert.equal(guard.y0, 61)
    assert.equal(guard.z0, -1)
    assert.equal(guard.y1, 80)
    assert.ok(guard.x1 > guard.x0 && guard.z1 > guard.z0, 'a real footprint, not a point')
    await flush()
  })

  it('a late settle never finishes a step that is gone', async () => {
    let release
    const bot = mockBot({
      items: [{ name: 'stone_pickaxe', count: 1 }],
      mineImpl: (b, calls) => () => new Promise((resolve) => { calls.mine.push({}); release = resolve }),
    })
    const ctx = stoneCtx()
    castlefetch.digTick(bot, ctx, ctx.castleFetch, { kind: 'stone', word: 'batch', short: 8 })
    assert.equal(bot.calls.mine.length, 1)
    ctx.step = 'shelter' // the arbiter moved on while the mine was live
    ctx.stepGen = (ctx.stepGen | 0) + 1
    release({ have: 8 })
    await flush()
    await flush()
    assert.equal(ctx.stepStatus, 'running', 'no stale done written onto the shelter step')
    assert.equal(ctx.castleFetchInFlight, false, 'the flag still clears')
  })

  it('a pack that fills mid-mine cancels the mine and banks', async () => {
    const castleMod = require('../src/behaviours/castle')
    const origMenuFact = castleMod.menuFact
    castleMod.menuFact = () => 'stone-batch'
    try {
      const items = []
      for (let i = 0; i < 33; i++) items.push({ name: 'leaf_litter', count: 64 })
      items.push({ name: 'stone_pickaxe', count: 1 })
      let rejectMine
      const calls = { mine: [], cancelled: [] }
      const bot = {
        calls,
        _items: items,
        entity: { position: { x: 10, y: 64, z: 10 }, onGround: true },
        inventory: { items: () => bot._items },
        blockAt: () => null,
        findBlocks: () => [],
        pathfinder: {},
        chat: () => {},
        dig: async () => { throw new Error('must not dig on the mine path') },
        mine: async () => new Promise((_, reject) => { calls.mine.push({}); rejectMine = reject }),
        cancelMine: (err) => { calls.cancelled.push(err && err.message); rejectMine(err) },
      }
      const ctx = stoneCtx()
      ctx.castleFetch.chestDone = true
      castlefetch(bot, ctx, null, {})
      assert.equal(calls.mine.length, 1, 'the mine starts with room')
      for (let i = 0; i < 3; i++) bot._items.push({ name: 'gravel', count: 64 }) // pack fills mid-mine
      castlefetch(bot, ctx, null, {})
      await flush()
      await flush()
      assert.deepEqual(calls.cancelled, ['mine-stopped'])
      assert.equal(ctx.stepStatus, 'failed:castlefetch-pack-full')
    } finally { castleMod.menuFact = origMenuFact }
  })
})
