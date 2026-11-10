'use strict'

// idkcraft-y7lp.3: castlefetch draws castle kinds from ANY remembered chest
// whose snapshot holds the kind (nearest in radius), after home/site/castle;
// a short or unreachable chest is dry-marked (CHEST_DRY_MS) so a stale
// snapshot never loops, and fetchStockOf counts the snapshots.

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const fetch = require('../src/behaviours/castlefetch')
const { fetchStockOf, REMEMBERED_RADIUS, REMEMBERED_DRY_MS } = require('../src/cheststock')

const SITE = { x: 100, y: 64, z: 200 }
const bot = {
  username: 'IdkBot',
  entity: { position: { x: SITE.x, y: 64, z: SITE.z } },
  inventory: { items: () => [] },
  spawnPoint: { x: 0, y: 64, z: 0 },
  registry: { blocksByName: { chest: { id: 54 } }, itemsByName: {} },
  findBlocks: () => [],
}
const castle = () => ({ site: { ...SITE }, rot: 0, blueprintVersion: 1, phase: 'body', blocked: {}, parked: false })
const near = { x: SITE.x + 5, y: 64, z: SITE.z, contents: { dirt: 64 }, at: Date.now() }
const stone = { x: SITE.x + 12, y: 64, z: SITE.z, contents: { cobblestone: 40 }, at: Date.now() }
const keyOf = (c) => `${c.x},${c.y},${c.z}`
const at = (p) => p && [p.at.x, p.at.y, p.at.z]

describe('castlefetch any chest (y7lp.3)', () => {
  it('picks the nearest remembered chest whose snapshot holds stone', () => {
    const p = fetch.pickChest(bot, { castle: castle(), chests: [near, stone] }, {}, 'stone')
    assert.deepEqual(at(p), [stone.x, stone.y, stone.z])
  })

  it('live read short -> dry mark, next pick falls through (quarry)', () => {
    const ctx = { castle: castle(), chests: [near, stone] }
    fetch.markChestDry(ctx, 'stone', keyOf(stone)) // chestTick: left > 0 after the live draw
    assert.equal(fetch.pickChest(bot, ctx, {}, 'stone'), null)
  })

  it('unreachable -> all-kinds dry mark, no re-pick on a fresh leg', () => {
    const ctx = { castle: castle(), chests: [stone] }
    fetch.markTimeoutChest(ctx, 'stone', keyOf(stone))
    assert.equal(fetch.pickChest(bot, ctx, {}, 'stone'), null)
    assert.equal(fetch.pickChest(bot, ctx, {}, 'stone'), null)
  })

  it('a stale snapshot without the kind expires: a restocked chest is picked again (review 01 core-2)', () => {
    const old = { ...near, at: Date.now() - fetch.CHEST_DRY_MS - 1 }
    const p = fetch.pickChest(bot, { castle: castle(), chests: [old] }, {}, 'stone')
    assert.deepEqual(at(p), [old.x, old.y, old.z])
    assert.equal(fetch.pickChest(bot, { castle: castle(), chests: [near] }, {}, 'stone'), null)
  })

  it('home/site chests still come first', () => {
    const site = { x: SITE.x + 20, y: 64, z: SITE.z }
    const ctx = { castle: { ...castle(), siteChest: site }, chests: [stone] }
    assert.deepEqual(at(fetch.pickChest(bot, ctx, {}, 'stone')), [site.x, site.y, site.z])
  })

  it('fetchStockOf counts remembered snapshots, not the site chest twice', () => {
    const site = { x: 1, y: 2, z: 3 }
    const ctx = { castle: { siteChest: site }, chestLast: { site: { contents: { cobblestone: 5 } } }, chests: [{ ...site, contents: { cobblestone: 5 } }, stone] }
    assert.equal(fetchStockOf(ctx, ['cobblestone'], bot, 'stone'), 45)
  })

  it('coverage equals what pickChest picks: far or dry -> 0 and no pick (quarry); near fresh -> both', () => {
    const far = { x: SITE.x + 200, y: 64, z: SITE.z, contents: { cobblestone: 64 }, at: Date.now() }
    const cases = [
      [{ castle: castle(), chests: [far] }, false],
      [{ castle: castle(), chests: [stone], castleChestDry: { [`stone@${keyOf(stone)}`]: Date.now() } }, false],
      [{ castle: castle(), chests: [stone] }, true],
    ]
    for (const [ctx, ok] of cases) {
      assert.equal(fetchStockOf(ctx, ['cobblestone'], bot, 'stone') > 0, ok)
      assert.equal(!!fetch.pickChest(bot, ctx, {}, 'stone'), ok)
    }
    assert.equal(REMEMBERED_RADIUS, require('../src/behaviours/stockpile').NEARBY_CHEST_RADIUS)
    assert.equal(REMEMBERED_DRY_MS, fetch.CHEST_DRY_MS)
    assert.equal(fetchStockOf({ castle: castle(), chests: [stone] }, ['cobblestone']), 0, 'no body: no claim')
  })
})
