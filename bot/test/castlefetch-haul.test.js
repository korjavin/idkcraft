'use strict'
// owner 2026-11-13 haul: a v2 chest visit also fills stone and planks to the keep; v1 does not.
const { it } = require('node:test')
const assert = require('node:assert/strict')
const stockpile = require('../src/behaviours/stockpile')
const castlefetch = require('../src/behaviours/castlefetch')

it('v2 draw tops stone and planks up to the keep; v1 does not', async () => {
  const bot = { inventory: { items: () => [] }, registry: { itemsByName: {} } }
  const calls = []
  const orig = stockpile.withdrawAnyFromChest
  const body = process.env.BOT_BODY
  stockpile.withdrawAnyFromChest = async (b, c, names, want) => {
    calls.push([names.join(','), want])
    return { got: 0, name: names[0], counts: { cobblestone: 500, oak_planks: 100 } }
  }
  try {
    const ctx = { castle: { status: 'fetching stairs' } }
    process.env.BOT_BODY = 'baritone'
    await castlefetch.drawChest(bot, ctx, { kind: 'torch', short: 16 }, { x: 0, y: 64, z: 0 }, 16)
    await castlefetch.drawChest(bot, ctx, { kind: 'stone', short: 16 }, { x: 0, y: 64, z: 0 }, 16)
    assert.ok(calls.some((c) => c[0] === 'cobblestone' && c[1] === castlefetch.LOAD.stone + require('../src/behaviours/castle').reserveOf('stone')), JSON.stringify(calls))
    assert.ok(calls.some((c) => c[0] === 'oak_planks' && c[1] === 64), JSON.stringify(calls))
    assert.equal(castlefetch.LOAD.stone + require('../src/behaviours/castle').reserveOf('stone'), stockpile.STONE_KEEP, 'the haul never exceeds the bank-back keep')
    calls.length = 0
    delete process.env.BOT_BODY
    await castlefetch.drawChest(bot, ctx, { kind: 'stone', short: 16 }, { x: 0, y: 64, z: 0 }, 16)
    assert.ok(!calls.some((c) => c[0] === 'oak_planks'), JSON.stringify(calls))
  } finally {
    stockpile.withdrawAnyFromChest = orig
    if (body === undefined) delete process.env.BOT_BODY; else process.env.BOT_BODY = body
  }
})
