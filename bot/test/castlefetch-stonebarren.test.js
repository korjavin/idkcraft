'use strict'

// Owner 2026-11-14: a stone leg with empty-chest memory walks to no chest.
const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const fetch = require('../src/behaviours/castlefetch')

const SITE = { x: 100, y: 64, z: 200 }
const bot = () => ({
  username: 'IdkBot',
  entity: { position: { x: SITE.x - 4, y: 64, z: SITE.z - 4 } },
  inventory: { items: () => [] },
  spawnPoint: { x: 0, y: 64, z: 0 },
  registry: { blocksByName: { chest: { id: 54 } } },
  findBlocks: () => [],
})
const ctxOf = () => ({
  castle: { site: { ...SITE }, rot: 0, blueprintVersion: 1, phase: 'body', blocked: {}, parked: false },
  chests: [{ x: SITE.x - 10, y: 64, z: SITE.z - 10 }],
})

describe('stone barren chests: legs go straight to mining', () => {
  it('two fruitless stone draws skip chests; a good draw or other kinds unaffected', () => {
    const ctx = ctxOf()
    assert.ok(fetch.pickChest(bot(), ctx, {}, 'stone'), 'no memory: chest picked')
    fetch.noteStoneChest(ctx, 'stone', false)
    assert.ok(fetch.pickChest(bot(), ctx, {}, 'stone'), 'one miss: still tries')
    fetch.noteStoneChest(ctx, 'stone', false)
    assert.equal(fetch.pickChest(bot(), ctx, {}, 'stone'), null, 'barren: no chest walk')
    assert.ok(fetch.pickChest(bot(), ctx, {}, 'planks'), 'other kinds still draw')
    ctx.castleStoneBarren.at -= 31 * 60 * 1000
    assert.ok(fetch.pickChest(bot(), ctx, {}, 'stone'), 'expired after 30 min')
    fetch.noteStoneChest(ctx, 'stone', true)
    assert.equal(ctx.castleStoneBarren.n, 0, 'a draw resets the count')
  })
})
