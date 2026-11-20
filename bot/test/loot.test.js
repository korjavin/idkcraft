'use strict'
const test = require('node:test')
const assert = require('node:assert')
const { Vec3 } = require('vec3')
const loot = require('../src/loot')

function mkBot() {
  const goals = []
  const sheep = { id: 1, name: 'sheep', position: new Vec3(10, 64, 10) }
  return {
    goals,
    entity: { position: new Vec3(8, 64, 10) },
    entities: { 1: sheep },
    pathfinder: { setGoal: (g) => goals.push(g) },
    sheep,
  }
}

test('kill -> walks onto each drop, logs picked/left, then releases the body', () => {
  const bot = mkBot()
  const ctx = {}
  loot.noteSwing(bot, bot.sheep)
  assert.strictEqual(loot.tick(bot, ctx, false), false) // still alive
  delete bot.entities[1]
  bot.entities[2] = { id: 2, name: 'item', position: new Vec3(10.3, 64, 10.6) }
  bot.entities[3] = { id: 3, name: 'item', position: new Vec3(11.2, 64, 9.4) }
  bot.entities[4] = { id: 4, name: 'item', position: new Vec3(40, 64, 40) } // far: not ours
  assert.strictEqual(loot.tick(bot, ctx, false), true)
  assert.strictEqual(bot.goals.length, 1)
  delete bot.entities[2]
  assert.strictEqual(loot.tick(bot, ctx, false), true)
  assert.strictEqual(bot.goals.length, 2)
  delete bot.entities[3]
  const logs = []
  const orig = console.log
  console.log = (l) => logs.push(l)
  try { assert.strictEqual(loot.tick(bot, ctx, false), false) } finally { console.log = orig }
  assert.deepStrictEqual(logs, ['loot picked n=2 left=0 free=-1'])
  assert.strictEqual(ctx.loot, null)
})

test('danger ends the pickup at once', () => {
  const bot = mkBot()
  const ctx = {}
  loot.noteSwing(bot, bot.sheep)
  delete bot.entities[1]
  bot.entities[2] = { id: 2, name: 'item', position: new Vec3(10, 64, 10) }
  const orig = console.log
  const logs = []
  console.log = (l) => logs.push(l)
  try { assert.strictEqual(loot.tick(bot, ctx, true), false) } finally { console.log = orig }
  assert.deepStrictEqual(logs, ['loot picked n=0 left=1 free=-1'])
})

test('full pack at the drop: a junk stack is tossed, then the drop is picked', async () => {
  const bot = mkBot()
  const ctx = {}
  const pack = Array.from({ length: 36 }, (_, i) => ({ name: i === 0 ? 'leaf_litter' : 'cobblestone', count: 1, type: i }))
  bot.inventory = { items: () => pack.slice(), slots: [] }
  bot.tossStack = async (s) => { pack.splice(pack.indexOf(s), 1) }
  bot.look = async () => {}
  loot.noteSwing(bot, bot.sheep)
  delete bot.entities[1]
  bot.entities[2] = { id: 2, name: 'item', position: new Vec3(8.2, 64, 10.1) }
  const orig = console.log
  const logs = []
  console.log = (l) => logs.push(l)
  try {
    assert.strictEqual(loot.tick(bot, ctx, false), true)
    for (let i = 0; i < 50 && pack.length === 36; i++) await new Promise((r) => setImmediate(r))
    assert.strictEqual(pack.length, 35, 'one stack tossed')
    assert.ok(!pack.some((s) => s.name === 'leaf_litter'), 'junk went first')
    delete bot.entities[2] // the server picks it up into the freed slot
    pack.push({ name: 'porkchop', count: 1 })
    assert.strictEqual(loot.tick(bot, ctx, false), false)
  } finally { console.log = orig }
  assert.ok(logs.includes('loot picked n=1 left=0 free=0'), logs.join('\n'))
})

test('goal reached but the drop sits 2 blocks away: walks onto it again', () => {
  const bot = mkBot()
  const ctx = {}
  loot.noteSwing(bot, bot.sheep)
  delete bot.entities[1]
  bot.entities[2] = { id: 2, name: 'item', position: new Vec3(10.5, 63.2, 10.5) }
  assert.strictEqual(loot.tick(bot, ctx, false), true)
  assert.strictEqual(bot.goals.length, 1)
  assert.strictEqual(loot.tick(bot, ctx, false), true)
  assert.strictEqual(bot.goals.length, 1, 'no re-issue inside the grace')
  ctx.loot.goalAt -= 2500 // "reached" beside it, 2 blocks off
  assert.strictEqual(loot.tick(bot, ctx, false), true)
  assert.strictEqual(bot.goals.length, 2)
  const g = bot.goals[1]
  assert.deepStrictEqual([g.x, g.y, g.z], [10, 63, 10])
})
