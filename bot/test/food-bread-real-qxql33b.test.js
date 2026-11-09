'use strict'

// idkcraft-qxql33b: prod V2b (RCON) carried 4 logs, 0 planks, 0 table,
// 86 wheat at health 2.33 / food 15. Real craftany + food recovery: log ->
// 4 planks -> table -> placed -> 3 wheat -> bread, spending at most 1 log.
// Stubs: tablespot.tableFor (placement) and gear.runOp (applies the recipe).
const { it } = require('node:test')
const assert = require('node:assert/strict')
const Vec3 = require('vec3')

const TABLE_POS = new Vec3(1, 64, 0)
let placed = false
let tableCalls = 0
const tablespot = require('../src/behaviours/tablespot')
tablespot.tableFor = (bot) => {
  tableCalls++
  const i = bot._inv.find((x) => x.name === 'crafting_table')
  if (!i || i.count < 1) return Promise.reject(new Error('no table item'))
  i.count--
  placed = true
  return Promise.resolve({ block: bot.blockAt(TABLE_POS), pos: TABLE_POS })
}
const gear = require('../src/behaviours/gear')
const ops = []
gear.runOp = (bot, ctx, op) => {
  ops.push(op.item)
  for (const d of op.recipe.delta) {
    const name = bot._names[d.id]
    let i = bot._inv.find((x) => x.name === name)
    if (!i) { i = { name, count: 0 }; bot._inv.push(i) }
    i.count += d.count
    assert.ok(i.count >= 0, `${name} went negative`)
  }
  bot._inv = bot._inv.filter((x) => x.count > 0)
}
require('../src/behaviours/explore').castleActive = () => true
require('../src/behaviours/bring').pickChest = () => null
require('../src/behaviours/forage').foodTarget = () => null
const fr = require('../src/behaviours/food-recovery')

function mkBot() {
  const ids = { oak_log: 1, oak_planks: 2, crafting_table: 3, wheat: 4, bread: 5 }
  const R = {
    2: [{ delta: [{ id: 1, count: -1 }, { id: 2, count: 4 }], result: { id: 2, count: 4 }, requiresTable: false }],
    3: [{ delta: [{ id: 2, count: -4 }, { id: 3, count: 1 }], result: { id: 3, count: 1 }, requiresTable: false }],
    5: [{ delta: [{ id: 4, count: -3 }, { id: 5, count: 1 }], result: { id: 5, count: 1 }, requiresTable: true }],
  }
  const bot = {
    username: 'IdkBotV2b', health: 2.333332, food: 15,
    _names: Object.fromEntries(Object.entries(ids).map(([n, i]) => [i, n])),
    _inv: [{ name: 'oak_log', count: 4 }, { name: 'wheat', count: 86 }],
    entity: { position: new Vec3(0, 64, 0), onGround: true },
    registry: { blocksByName: {}, itemsByName: Object.fromEntries(Object.entries(ids).map(([n, id]) => [n, { id, name: n }])) },
    recipesAll: (id) => R[id] || [],
    recipesFor: (id) => R[id] || [],
    blockAt: (p) => (placed && p && p.x === TABLE_POS.x && p.y === TABLE_POS.y && p.z === TABLE_POS.z ? { name: 'crafting_table', position: TABLE_POS } : null),
    findBlocks: () => [],
    pathfinder: { setGoal() {}, isMoving: () => false },
  }
  bot.inventory = { items: () => bot._inv }
  return bot
}

it('prod V2b inventory: 4 logs, no planks/table, 86 wheat -> bread, <=1 log spent', async () => {
  process.env.BOT_BODY = 'baritone'
  const bot = mkBot()
  const ctx = { work: true, step: 'foodRecovery' }
  const facts = { time: 'day', health: bot.health }
  assert.equal(fr.available(bot, ctx, facts), true)
  const logs = []; const log = console.log; console.log = (l) => logs.push(String(l))
  try {
    for (let i = 0; i < 40 && ctx.stepStatus !== 'done'; i++) {
      fr.run(bot, ctx)
      await new Promise((r) => setImmediate(r))
    }
  } finally { console.log = log }
  const n = (name) => (bot._inv.find((x) => x.name === name) || { count: 0 }).count
  assert.ok(logs.some((l) => /food recovery source=bread table=placed why=crafted/.test(l)), logs.join('\n'))
  assert.equal(n('bread'), 1)
  assert.equal(n('wheat'), 83)
  assert.ok(n('oak_log') >= 3, `logs left ${n('oak_log')}`)
  assert.equal(tableCalls, 1)
  assert.deepEqual(ops, ['oak_planks', 'crafting_table', 'bread'])
  assert.ok(!ctx.foodRecoveryRetryAt)
})
