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

describe('built home draws a kit from a non-home chest only when starved (y7lp review)', () => {
  function drawBot(chests, items) {
    const bot = makeBot(chests)
    bot.entity.position = pos(1, 64, 0)
    bot.inventory.items = () => items
    bot.openChest = async (b) => {
      const k = `${b.position.x},${b.position.y},${b.position.z}`
      bot.opens.push(k)
      const stacks = chests[k]
      return {
        containerItems: () => stacks.filter((s) => s.count > 0).map((s) => ({ ...s, type: s.name, metadata: null })),
        withdraw: async (type, meta, n) => {
          stacks.find((s) => s.name === type).count -= n
          const it = items.find((i) => i.name === type)
          if (it) it.count += n
          else items.push({ name: type, count: n })
        },
        close() {},
      }
    }
    bot.registry.blocksByName = { oak_log: { id: 17 } }
    bot.opens = []
    return bot
  }
  const settle = () => new Promise((r) => setTimeout(r, 5))

  it('draws at most 3 logs once, never from the home chest, no repeat', async () => {
    const chests = { '0,64,1': [{ name: 'oak_log', count: 30 }], '2,64,0': [{ name: 'oak_log', count: 30 }] }
    const items = []
    const bot = drawBot(chests, items)
    const ctx = {
      home: { site: pos(0, 64, 0), built: true, chest: pos(0, 64, 1) },
      chests: [{ x: 0, y: 64, z: 1, contents: { oak_log: 30 }, at: 1 }, { x: 2, y: 64, z: 0, contents: { oak_log: 30 }, at: 1 }],
    }
    const logsOf = () => items.filter((i) => i.name === 'oak_log').reduce((a, i) => a + i.count, 0)
    const g = {}
    assert.equal(gather.chestLogsTick(bot, ctx, g, 0, bot.entity.position), true)
    await settle()
    assert.deepEqual([bot.opens, logsOf()], [["2,64,0"], 3])
    assert.deepEqual(bot.opens, ['2,64,0'])
    // later ticks/attempts: carrying logs -> not starved -> no draw
    for (const gg of [g, {}, {}]) assert.equal(gather.chestLogsTick(bot, ctx, gg, logsOf(), bot.entity.position), false)
    await settle()
    assert.deepEqual(bot.opens, ['2,64,0'])
  })

  it('a built home with only the home chest draws nothing', () => {
    const bot = drawBot({ '0,64,1': [{ name: 'oak_log', count: 30 }] }, [])
    const ctx = { home: { site: pos(0, 64, 0), built: true, chest: pos(0, 64, 1) }, chests: [{ x: 0, y: 64, z: 1, contents: { oak_log: 30 }, at: 1 }] }
    assert.equal(gather.chestLogsTick(bot, ctx, {}, 0, bot.entity.position), false)
  })

  it('9+ planks is not starved: no draw', () => {
    const bot = drawBot({ '2,64,0': [{ name: 'oak_log', count: 30 }] }, [{ name: 'oak_planks', count: 9 }])
    const ctx = { home: { site: pos(0, 64, 0), built: true, chest: pos(0, 64, 1) }, chests: [{ x: 2, y: 64, z: 0, contents: { oak_log: 30 }, at: 1 }] }
    assert.equal(gather.chestLogsTick(bot, ctx, {}, 0, bot.entity.position), false)
  })
})
