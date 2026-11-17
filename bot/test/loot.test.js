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
  assert.deepStrictEqual(logs, ['loot picked n=2 left=0'])
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
  assert.deepStrictEqual(logs, ['loot picked n=0 left=1'])
})
