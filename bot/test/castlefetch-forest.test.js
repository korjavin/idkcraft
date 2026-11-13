'use strict'
// owner 2026-11-13 forest: a wood-starved castle fetch takes saplings from the chest it opened.
const { it } = require('node:test')
const assert = require('node:assert/strict')
const stockpile = require('../src/behaviours/stockpile')
const { drawChest } = require('../src/behaviours/castlefetch')

it('wood-starved draw also takes saplings up to the keep', async () => {
  const inv = [{ name: 'oak_sapling', count: 2 }]
  const bot = { inventory: { items: () => inv }, registry: { itemsByName: {} } }
  const calls = []
  const orig = stockpile.withdrawAnyFromChest
  stockpile.withdrawAnyFromChest = async (b, c, names, want) => {
    calls.push([names.join(','), want])
    return { got: names[0].endsWith('_sapling') ? want : 0, name: names[0], counts: { cobblestone: 5, birch_sapling: 19 } }
  }
  try {
    const ctx = { castle: { status: 'no wood within 64 — drop logs in the castle chest' } }
    await drawChest(bot, ctx, { kind: 'stone', short: 5 }, { x: 0, y: 64, z: 0 }, 5)
    assert.deepEqual(calls.at(-1), ['birch_sapling', stockpile.SAPLING_KEEP - 2])
    calls.length = 0
    await drawChest(bot, { castle: { status: 'fetching stone' } }, { kind: 'stone', short: 5 }, { x: 0, y: 64, z: 0 }, 5)
    assert.ok(!calls.some((c) => c[0].includes('sapling')))
  } finally { stockpile.withdrawAnyFromChest = orig }
})
