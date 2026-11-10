'use strict'

// idkcraft-y7lp: bots may use ANY chest — every open snapshots it into the
// ctx.chests registry (persisted), gather draws logs from the nearest
// remembered chest whose snapshot holds logs, gone chests drop out.

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const gather = require('../src/behaviours/gather')
const packroom = require('../src/behaviours/packroom')
const { chestSpotsOf } = require('../src/memory')

const pos = (x, y, z) => ({ x, y, z })
function makeBot(chests = {}) {
  return {
    entity: { position: pos(0, 64, 0) },
    inventory: { items: () => [] },
    registry: { itemsByName: { oak_log: {} } },
    blockAt: (p) => ({ name: chests[`${p.x},${p.y},${p.z}`] ? 'chest' : 'dirt', position: p }),
    openChest: async (b) => ({ containerItems: () => chests[`${b.position.x},${b.position.y},${b.position.z}`], close() {} }),
    pathfinder: { setGoal() {}, stop() {} },
  }
}

describe('any chest (y7lp)', () => {
  it('records a snapshot on an arbitrary chest', async () => {
    const ctx = {}
    const r = await packroom.withChest(makeBot({ '5,64,7': [{ name: 'oak_log', count: 3 }, { name: 'oak_log', count: 2 }] }), ctx, async () => 1, pos(5, 64, 7))
    assert.equal(r.status, 'ok')
    assert.equal(ctx.chests.length, 1)
    assert.deepEqual(ctx.chests[0].contents, { oak_log: 5 })
    assert.ok(ctx.chests[0].at > 0)
  })

  it('persists snapshots and loads old x,y,z-only files', () => {
    const back = chestSpotsOf(JSON.parse(JSON.stringify([{ x: 1, y: 2, z: 3, contents: { oak_log: 4, bad: 'x' }, at: 99 }, { x: 4, y: 5, z: 6 }])))
    assert.deepEqual(back, [{ x: 1, y: 2, z: 3, contents: { oak_log: 4 }, at: 99 }, { x: 4, y: 5, z: 6 }])
  })

  it('picks the nearest chest with logs over a nearer one without', () => {
    const ctx = { chests: [{ x: 3, y: 64, z: 0, contents: { cobblestone: 64 }, at: 1 }, { x: 9, y: 64, z: 0, contents: { oak_log: 20 }, at: 1 }, { x: 20, y: 64, z: 0, contents: { birch_log: 5 }, at: 1 }] }
    const g = {}
    assert.equal(gather.chestLogsTick(makeBot(), ctx, g, 0, pos(0, 64, 0)), true)
    assert.equal(g.chestLogs.k, '9,64,0')
  })

  it('skips a dry chest', () => {
    const ctx = { chests: [{ x: 9, y: 64, z: 0, contents: { oak_log: 20 }, at: 1 }], chestLogsDry: { '9,64,0': Date.now() } }
    const g = {}
    assert.equal(gather.chestLogsTick(makeBot(), ctx, g, 0, pos(0, 64, 0)), false)
    assert.equal(g.chestLogs, undefined)
  })

  it('drops a chest that is gone', async () => {
    const ctx = { chests: [{ x: 9, y: 64, z: 0 }, { x: 1, y: 64, z: 0 }] }
    const r = await packroom.withChest(makeBot({}), ctx, async () => 1, pos(9, 64, 0))
    assert.equal(r.status, 'gone')
    assert.deepEqual(ctx.chests, [{ x: 1, y: 64, z: 0 }])
  })

  it('an unreachable chest goes dry, no loop', () => {
    const ctx = { chests: [{ x: 9, y: 64, z: 0, contents: { oak_log: 20 }, at: 1 }] }
    const g = {}
    const bot = makeBot()
    let busy = true
    for (let i = 0; i < 100 && busy; i++) busy = gather.chestLogsTick(bot, ctx, g, 0, pos(0, 64, 0))
    assert.equal(busy, false)
    assert.ok(ctx.chestLogsDry['9,64,0'] > 0)
    assert.equal(gather.chestLogsTick(bot, ctx, g, 0, pos(0, 64, 0)), false)
  })
})
