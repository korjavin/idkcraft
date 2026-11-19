'use strict'
const test = require('node:test')
const assert = require('node:assert')
const unreachable = require('../src/unreachable')
const { noteNoPath } = require('../src/nopath-log')

function rig() {
  class GoalNear { constructor() { this.x = 1; this.y = 64; this.z = 2 } }
  const goal = new GoalNear()
  const bot = { pathfinder: { goal, setGoal(g) { this.goal = g } } }
  const ctx = { work: true, step: 'farm', stepStatus: 'running', lastPathStatus: 'noPath' }
  return { bot, ctx, goal }
}

test('noPath on two ticks fails the step and marks the target', () => {
  const { bot, ctx, goal } = rig()
  assert.strictEqual(unreachable.tick(bot, ctx, 0), false)
  assert.strictEqual(unreachable.tick(bot, ctx, 1000), true)
  assert.strictEqual(ctx.stepStatus, 'failed:unreachable')
  assert.strictEqual(bot.pathfinder.goal, null)
  assert.ok(unreachable.near(ctx, { x: 1.5, z: 2.5 }, 2000))
  // marked target: the next noPath fails on its first tick
  ctx.stepStatus = 'running'
  bot.pathfinder.goal = goal
  assert.strictEqual(unreachable.tick(bot, ctx, 3000), true)
})

test('a verdict cleared by the behaviour resets the count', () => {
  const { bot, ctx } = rig()
  unreachable.tick(bot, ctx, 0)
  ctx.lastPathStatus = 'none'
  unreachable.tick(bot, ctx, 1000)
  ctx.lastPathStatus = 'noPath'
  assert.strictEqual(unreachable.tick(bot, ctx, 2000), false)
  assert.strictEqual(ctx.stepStatus, 'running')
})

test('castle keeps its step and goal; the cell is only marked', () => {
  const { bot, ctx, goal } = rig()
  ctx.step = 'castle'
  for (let t = 0; t < 5; t++) assert.strictEqual(unreachable.tick(bot, ctx, t * 1000), false)
  assert.strictEqual(ctx.stepStatus, 'running')
  assert.strictEqual(bot.pathfinder.goal, goal)
  assert.ok(unreachable.near(ctx, { x: 1.5, z: 2.5 }, 6000))
  assert.strictEqual(ctx.unreachable.length, 1)
})

test('no work step: nothing fails', () => {
  const { bot, ctx } = rig()
  ctx.work = false
  unreachable.tick(bot, ctx, 0)
  assert.strictEqual(unreachable.tick(bot, ctx, 1000), false)
})

test('nopath log names the GoalPlaceBlock cell', () => {
  class GoalPlaceBlock { constructor() { this.pos = { x: 5.5, y: 70, z: -3 } } }
  const bot = { entity: { position: { x: 0, y: 70, z: 0 } }, pathfinder: { goal: new GoalPlaceBlock() }, blockAt: () => ({ name: 'air' }), inventory: { items: () => [] } }
  const out = noteNoPath(bot, {}, 1e9)
  assert.match(out, /goal=GoalPlaceBlock 5,70,-3 dist=6/)
})

test('a live Baritone mine marker is never failed as unreachable (mine owns its ends)', () => {
  const { bot, ctx } = rig()
  const marker = { mine: true }
  bot.pathfinder.goal = marker
  for (let t = 0; t < 5000; t += 1000) assert.strictEqual(unreachable.tick(bot, ctx, t), false)
  assert.strictEqual(bot.pathfinder.goal, marker)
  assert.strictEqual(ctx.stepStatus, 'running')
})
