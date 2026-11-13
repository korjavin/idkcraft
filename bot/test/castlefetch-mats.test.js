'use strict'

// Owner 2026-11-13: far known chests feed the castle (full load), and a
// stone leg sweeps stone drops off the site before digging.

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const fetch = require('../src/behaviours/castlefetch')

const SITE = { x: 100, y: 64, z: 200 }
const mkBot = (extra = {}) => ({
  username: 'IdkBot',
  entity: { position: { x: SITE.x, y: 64, z: SITE.z } },
  inventory: { items: () => [], emptySlotCount: () => 36 },
  spawnPoint: { x: 0, y: 64, z: 0 },
  registry: { blocksByName: { chest: { id: 54 } }, itemsByName: {} },
  findBlocks: () => [],
  pathfinder: { setGoal () {}, goal: null },
  ...extra,
})
const castle = () => ({ site: { ...SITE }, rot: 0, blueprintVersion: 1, phase: 'body', blocked: {}, parked: false })
const at = (p) => p && [p.at.x, p.at.y, p.at.z]

describe('castlefetch far chests', () => {
  it('a remembered stone chest 600 off is picked (far) when none is near', () => {
    const c = { x: SITE.x + 600, y: 64, z: SITE.z, contents: { cobblestone: 900 }, at: Date.now() }
    const p = fetch.pickChest(mkBot(), { castle: castle(), chests: [c] }, {}, 'stone')
    assert.deepEqual(at(p), [c.x, c.y, c.z])
    assert.equal(p.far, true)
  })

  it('a near chest still wins over a far one; past 1000 is never picked', () => {
    const nearC = { x: SITE.x + 10, y: 64, z: SITE.z, contents: { cobblestone: 10 }, at: Date.now() }
    const farC = { x: SITE.x + 600, y: 64, z: SITE.z, contents: { cobblestone: 900 }, at: Date.now() }
    assert.deepEqual(at(fetch.pickChest(mkBot(), { castle: castle(), chests: [farC, nearC] }, {}, 'stone')), [nearC.x, 64, nearC.z])
    const tooFar = { ...farC, x: SITE.x + 1500 }
    assert.equal(fetch.pickChest(mkBot(), { castle: castle(), chests: [tooFar] }, {}, 'stone'), null)
  })

  it('a far trip draws a full load: castle remainder capped by pack room', () => {
    const ctx = { castle: castle(), castleWord: { kind: 'planks', left: 3700 } }
    assert.equal(fetch.farLoad(mkBot(), ctx, 'planks', 10), (36 - 2) * 64)
    const small = { castle: castle(), castleWord: { kind: 'planks', left: 5 } }
    assert.ok(fetch.farLoad(mkBot(), small, 'planks', 10) < 100)
  })
})

describe('castlefetch site sweep', () => {
  const drop = (id, x, z, name) => ({ id, position: { x, y: 64, z }, getDroppedItem: () => ({ name }) })
  it('walks to the nearest stone drop on the site, skips dirt and far drops', () => {
    let goal = null
    const bot = mkBot({
      entities: { 1: drop(1, SITE.x + 9, SITE.z, 'cobblestone'), 2: drop(2, SITE.x + 2, SITE.z, 'dirt'), 3: drop(3, SITE.x - 300, SITE.z, 'cobblestone') },
      pathfinder: { setGoal (g) { goal = g }, goal: null },
    })
    const ctx = { castle: castle() }
    assert.equal(fetch.sweepTick(bot, ctx, {}), true)
    assert.equal(ctx.lastGoalKey, 'castlefetch-sweep:1')
    assert.ok(goal)
  })

  it('no drops: the sweep ends and the leg digs', () => {
    const f = {}
    assert.equal(fetch.sweepTick(mkBot({ entities: {} }), { castle: castle() }, f), false)
    assert.equal(f.sweepDone, true)
  })
})
