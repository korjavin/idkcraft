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

// Codex review #757 (2): the gate must agree with craftany's own planner.
it('2 oak + 2 birch planks: craftany cannot fund a table, so bread is not offered', () => {
  process.env.BOT_BODY = 'baritone'
  placed = false
  const bot = mkBot()
  bot.registry.itemsByName.birch_planks = { id: 6, name: 'birch_planks' }
  bot._names[6] = 'birch_planks'
  bot._inv = [{ name: 'oak_planks', count: 2 }, { name: 'birch_planks', count: 2 }, { name: 'wheat', count: 86 }]
  const ctx = { work: true, step: 'foodRecovery' }
  const craftany = require('../src/behaviours/craftany')
  assert.equal(craftany.planCraft(bot, ctx, ['bread'], 1).ok, false, 'craftany refuses')
  assert.equal(fr.available(bot, ctx, { time: 'day', health: bot.health }), false, 'gate agrees')
})

// Codex review #757 (1): a failed bread leg must not block chest/forage.
it('bread failure falls through to chest/forage in the same episode, no shared cooldown', () => {
  process.env.BOT_BODY = 'baritone'
  placed = false
  const bring = require('../src/behaviours/bring')
  const forage = require('../src/behaviours/forage')
  const bot = mkBot()
  const ctx = { work: true, step: 'foodRecovery' }
  const facts = { time: 'day', health: bot.health }
  const saved = tablespot.tableFor
  tablespot.tableFor = () => Promise.reject(new Error('no legal spot'))
  forage.foodTarget = () => ({ name: 'sheep', want: 1 })
  const logs = []; const log = console.log; console.log = (l) => logs.push(String(l))
  try {
    fr.run(bot, ctx)
    ctx.foodRecovery.bread.at -= 121000 // deadline passes
    fr.run(bot, ctx)
  } finally { console.log = log; tablespot.tableFor = saved; forage.foodTarget = () => null }
  assert.ok(logs.some((l) => /source=bread table=none why="timeout"/.test(l)), logs.join('\n'))
  assert.notEqual(ctx.foodRecovery.phase, 'bread', 'moved on to chest/forage')
  assert.equal(ctx.foodRecovery.valid, true)
  assert.ok(!ctx.foodRecoveryRetryAt, 'no episode cooldown from a bread failure')
  // a new episode inside the bread cooldown still offers chest/forage, not bread
  forage.foodTarget = () => ({ name: 'sheep', want: 1 })
  try {
    ctx.foodRecovery.valid = false
    assert.equal(fr.available(bot, ctx, facts), true)
    fr.run(bot, ctx)
    assert.notEqual(ctx.foodRecovery.phase, 'bread')
  } finally { forage.foodTarget = () => null; bring.pickChest = () => null }
})

it('stripped log only: craftany has no table variant for it, so bread is not offered', () => {
  process.env.BOT_BODY = 'baritone'
  placed = false
  const bot = mkBot()
  bot.registry.itemsByName.stripped_oak_log = { id: 7, name: 'stripped_oak_log' }
  bot._names[7] = 'stripped_oak_log'
  bot._inv = [{ name: 'stripped_oak_log', count: 4 }, { name: 'wheat', count: 86 }]
  const ctx = { work: true, step: 'foodRecovery' }
  assert.equal(require('../src/behaviours/craftany').planCraft(bot, ctx, ['bread'], 1).ok, false)
  assert.equal(fr.available(bot, ctx, { time: 'day', health: bot.health }), false)
})

it('bread latch outlasts RETRY_MS: covers the 5-min low-HP episode', () => {
  const ctx = { foodBreadRetryAt: 0 }
  const { LOW_HP_GATE_MS } = require('../src/health-gate')
  assert.ok(LOW_HP_GATE_MS >= fr.RETRY_MS)
  process.env.BOT_BODY = 'baritone'
  placed = false
  const bot = mkBot()
  Object.assign(ctx, { work: true, step: 'foodRecovery' })
  const saved = tablespot.tableFor
  tablespot.tableFor = () => Promise.reject(new Error('refused'))
  const log = console.log; console.log = () => {}
  try { fr.run(bot, ctx); ctx.foodRecovery.bread.at -= 121000; fr.run(bot, ctx) } finally { console.log = log; tablespot.tableFor = saved }
  assert.ok(ctx.foodBreadRetryAt - Date.now() > fr.RETRY_MS + 1000)
  ctx.foodRecovery.valid = false
  const realNow = Date.now; Date.now = () => realNow() + fr.RETRY_MS + 5000
  try { assert.equal(fr.available(bot, ctx, { time: 'day', health: bot.health }), false, 'bread still latched after RETRY_MS') } finally { Date.now = realNow }
})
