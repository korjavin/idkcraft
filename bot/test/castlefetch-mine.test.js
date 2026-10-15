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
})
