'use strict'
const test = require('node:test')
const assert = require('node:assert')
const Vec3 = require('vec3')
const { reclaimTable, seenTable } = require('../src/behaviours/tablespot')

function fakeBot(blocks) {
  const dug = []
  return {
    dug,
    entity: { position: new Vec3(0.5, 64, 0.5) },
    inventory: { items: () => [] },
    registry: { blocksByName: { crafting_table: { id: 7 } } },
    findBlocks: () => Object.keys(blocks).filter((k) => blocks[k] === 'crafting_table').map((k) => { const [x, y, z] = k.split(',').map(Number); return new Vec3(x, y, z) }),
    blockAt: (p) => ({ name: blocks[`${p.x},${p.y},${p.z}`] || 'air', position: p }),
    dig: async (b) => { dug.push(b.position) },
  }
}

test('seenTable finds the nearest standing table', () => {
  const bot = fakeBot({ '5,64,0': 'crafting_table', '2,64,0': 'crafting_table' })
  const p = seenTable(bot, bot.entity.position)
  assert.deepStrictEqual([p.x, p.y, p.z], [2, 64, 0])
})

test('reclaimTable digs an idle roadside table, not a busy one', async () => {
  const bot = fakeBot({ '1,64,0': 'crafting_table' })
  const ctx = { roadsideTable: { x: 1, y: 64, z: 0, used: 1000 }, claimedTable: new Vec3(1, 64, 0) }
  assert.strictEqual(reclaimTable(bot, ctx, 5000), false) // used 4 s ago
  ctx.equipInFlight = true
  assert.strictEqual(reclaimTable(bot, ctx, 20000), false)
  ctx.equipInFlight = false
  assert.strictEqual(reclaimTable(bot, ctx, 20000), true)
  await new Promise((r) => setImmediate(r))
  assert.strictEqual(bot.dug.length, 1)
  assert.strictEqual(ctx.claimedTable, undefined)
  bot.inventory.items = () => [{ name: 'crafting_table' }]
  reclaimTable(bot, ctx, 21000)
  assert.strictEqual(ctx.roadsideTable, null)
})
