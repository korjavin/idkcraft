'use strict'

// Upkeep throughput (prod bot3: 33 oks in 784 castle ticks): cells in reach of
// the stand go before a latched far target, and a rate line counts the ticks.

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const { Vec3 } = require('vec3')
const castle = require('../src/behaviours/castle')

const SITE = { x: 100, y: 64, z: 200 }
const st3 = () => ({ site: { ...SITE }, rot: 0, blueprintVersion: 3, phase: 'complete', blocked: {} })
const cell = (dx, dy, dz, i) => ({ x: SITE.x + dx, y: SITE.y + dy, z: SITE.z + dz, kind: 'air', idx: castle.LITTER_BOX_BASE + i })

describe('castle upkeep spatial batch', () => {
  it('nextLitter takes a cell in reach before the latched far target', () => {
    const far = cell(20, 0, 20, 1), here = cell(1, 0, 1, 2)
    const bot = { entity: { position: new Vec3(SITE.x + 1.5, SITE.y, SITE.z + 2.5) } }
    const ctx = { castleGoalIdx: far.idx }
    assert.equal(castle.nextLitter(st3(), [far, here], 1000, bot, ctx).idx, here.idx)
    bot.entity.position = new Vec3(SITE.x + 10, SITE.y, SITE.z + 10)
    assert.equal(castle.nextLitter(st3(), [far, here], 1000, bot, ctx).idx, far.idx, 'out of reach: the latch holds')
  })
  it('pickUpkeep prefers the kind in reach over a latched one out of reach', () => {
    const lit = cell(1, 0, 1, 2)
    const fill = { x: SITE.x + 20, y: SITE.y - 1, z: SITE.z + 20, kind: 'stone', prep: 'fill', idx: 2600000 }
    const bot = { entity: { position: new Vec3(SITE.x + 1.5, SITE.y, SITE.z + 2.5) } }
    assert.equal(castle.pickUpkeep(bot, { castleUpkeep: fill }, lit, fill), lit)
  })
  it('upkeepLog counts oks and fails into the rate line', () => {
    const ctx = {}
    const st = st3()
    castle.upkeepLog(ctx, st, cell(1, 0, 1, 2), 'ok')
    castle.upkeepLog(ctx, st, cell(1, 0, 2, 3), 'fail:unreachable')
    assert.equal(ctx.castleUpkeepRate.ok, 1)
    assert.equal(ctx.castleUpkeepRate.fail, 1)
  })
})
