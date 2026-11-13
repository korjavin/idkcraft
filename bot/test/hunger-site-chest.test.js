'use strict'
// owner 2026-11-13 hunger: chests it opens top up pack food; food chest search prefers the castle site, no >100-block trips.
const { it } = require('node:test')
const assert = require('node:assert/strict')
const stockpile = require('../src/behaviours/stockpile')
const { drawChest } = require('../src/behaviours/castlefetch')
const bring = require('../src/behaviours/bring')

it('a castle draw also tops pack food up to FOOD_KEEP', async () => {
  const inv = [{ name: 'bread', count: 3 }]
  const bot = { inventory: { items: () => inv }, registry: { itemsByName: {} } }
  const calls = []
  const orig = stockpile.withdrawAnyFromChest
  stockpile.withdrawAnyFromChest = async (b, c, names, want) => {
    calls.push([names.join(','), want])
    return { got: 0, name: names[0], counts: { cobblestone: 5, cooked_beef: 127 } }
  }
  try {
    await drawChest(bot, { castle: { status: 'fetching stone' } }, { kind: 'stone', short: 5 }, { x: 0, y: 64, z: 0 }, 5)
    assert.deepEqual(calls.at(-1), ['cooked_beef', stockpile.FOOD_KEEP - 3])
    inv[0].count = stockpile.FOOD_KEEP
    calls.length = 0
    await drawChest(bot, { castle: { status: 'fetching stone' } }, { kind: 'stone', short: 5 }, { x: 0, y: 64, z: 0 }, 5)
    assert.ok(!calls.some((c) => c[0].includes('beef')))
  } finally { stockpile.withdrawAnyFromChest = orig }
})

it('food pickChest skips far chests when the castle site has one, and prefers the site chest', () => {
  const bot = { entity: { position: { x: 0, y: 64, z: 0 } } }
  const near = { x: 20, y: 64, z: 0 }
  const far = { x: 250, y: 64, z: 0 }
  const site = { x: 90, y: 64, z: 0 }
  const o = () => ({ wants: (n) => n === 'bread', chestSeen: [], maxChestDistance: 400 })
  let ctx = { castle: { site }, chests: [{ ...far }] }
  assert.deepEqual(bring.pickChest(bot, ctx, o()).pos, far)
  ctx = { castle: { site }, chests: [{ ...near }, { x: 92, y: 64, z: 0 }, { ...far }] }
  assert.deepEqual(bring.pickChest(bot, ctx, o()).pos, { x: 92, y: 64, z: 0 })
})
