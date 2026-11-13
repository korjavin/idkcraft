'use strict'
// owner 2026-11-13 nights: a bedless castle fetch takes one bed from the chest it opened.
const { it } = require('node:test')
const assert = require('node:assert/strict')
const stockpile = require('../src/behaviours/stockpile')
const { drawChest } = require('../src/behaviours/castlefetch')

it('bedless draw takes one bed, a bed carrier takes none', async () => {
  const inv = []
  const bot = { inventory: { items: () => inv }, registry: { itemsByName: {} } }
  const calls = []
  const orig = stockpile.withdrawAnyFromChest
  stockpile.withdrawAnyFromChest = async (b, c, names, want) => {
    calls.push([names.join(','), want])
    return { got: names[0].endsWith('_bed') ? want : 0, name: names[0], counts: { cobblestone: 5, red_bed: 2 } }
  }
  try {
    const ctx = { castle: { status: 'fetching stone' } }
    await drawChest(bot, ctx, { kind: 'stone', short: 5 }, { x: 0, y: 64, z: 0 }, 5)
    assert.deepEqual(calls.at(-1), ['red_bed', 1])
    calls.length = 0
    inv.push({ name: 'white_bed', count: 1 })
    await drawChest(bot, ctx, { kind: 'stone', short: 5 }, { x: 0, y: 64, z: 0 }, 5)
    assert.ok(!calls.some((c) => c[0].includes('_bed')))
  } finally { stockpile.withdrawAnyFromChest = orig }
})
