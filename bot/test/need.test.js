'use strict'

// Need targets (owner 2026-11-18): bot3 mined coal into a chest for hours.
// A resource pick needs stock (pack + every known chest) below its target.

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const forage = require('../src/behaviours/forage')
const resources = require('../src/resources')
const { needOf, needMet } = require('../src/cheststock')

function mockBot(inv) {
  const p = { x: 0, y: 64, z: 0 }
  return {
    entity: { position: p },
    entities: {},
    registry: { blocksByName: {}, itemsByName: {} },
    inventory: { items: () => inv },
    blockAt: () => ({ name: 'stone' }),
  }
}

function coalCtx(chestCoal, peerCoal = 0) {
  const ctx = {
    chests: [{ x: 9, y: 64, z: 9, contents: { coal: chestCoal, cobblestone: 5 }, at: Date.now() }],
    peerChests: [{ x: 9, y: 64, z: 9, contents: { coal: 999 } }, { x: 50, y: 64, z: 0, contents: { charcoal: peerCoal } }],
  }
  resources.noteSpots(ctx, [{ x: 5, y: 60, z: 0, name: 'coal_ore' }], 1000)
  return ctx
}

describe('need targets', () => {
  it('counts the pack plus every known chest, own and peer, once per chest', () => {
    const bot = mockBot([{ name: 'coal', count: 3 }])
    assert.deepEqual(needOf(bot, coalCtx(10, 4), 'coal'), { item: 'coal', have: 17, want: 32, met: false })
    assert.equal(needOf(bot, {}, 'dirt'), null)
  })

  it('coal mining stops once the stock target is met', () => {
    const bot = mockBot([{ name: 'stone_pickaxe', count: 1 }, { name: 'coal', count: 2 }])
    assert.equal(forage.planForage(bot, coalCtx(10)).name, 'coal_ore')
    // 2 packed + 20 chest + 10 peer charcoal = 32: met, nothing to mine
    assert.equal(forage.planForage(bot, coalCtx(20, 10)), null)
  })

  it('no forage pick (so no stockpile run) when stock is above target', () => {
    const bot = mockBot([{ name: 'stone_pickaxe', count: 1 }])
    assert.equal(needMet(bot, coalCtx(500), 'coal'), true)
    assert.equal(forage.planForage(bot, coalCtx(500)), null)
  })

  it('farm waits while the wheat stock is met', () => {
    const farm = require('../src/behaviours/farm')
    const bot = mockBot([{ name: 'wheat', count: 40 }])
    assert.equal(farm.farmFeasible({ time: 'day' }, bot, {}), false)
  })
})
