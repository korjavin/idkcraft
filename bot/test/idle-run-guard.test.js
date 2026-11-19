'use strict'
const test = require('node:test')
const assert = require('node:assert')
const { idleRunGuard, IDLE_RUN_MS } = require('../src/step')

function rig() {
  const bot = { entity: { position: { x: 0, y: 64, z: 0 } }, pathfinder: { goal: null, isMoving: () => false } }
  const ctx = { work: true, step: 'explore', stepStatus: 'running' }
  return { bot, ctx }
}

test('a goalless motionless running step fails no-target after IDLE_RUN_MS', () => {
  const { bot, ctx } = rig()
  assert.equal(idleRunGuard(bot, ctx, 0), false)
  assert.equal(idleRunGuard(bot, ctx, IDLE_RUN_MS - 1), false)
  assert.equal(idleRunGuard(bot, ctx, IDLE_RUN_MS), true)
  assert.equal(ctx.stepStatus, 'failed:no-target')
})

test('a goal, motion, an own wait reason or an exempt step keep the step running', () => {
  for (const tweak of [
    (b) => { b.bot.pathfinder.goal = {} },
    (b) => { b.ctx.idleWhy = 'furnace' },
    (b) => { b.ctx.step = 'rest' },
    (b, t) => { b.bot.entity.position = { x: t / 1000, y: 64, z: 0 } }
  ]) {
    const b = rig()
    for (let t = 0; t <= IDLE_RUN_MS * 2; t += 1000) { tweak(b, t); idleRunGuard(b.bot, b.ctx, t) }
    assert.equal(b.ctx.stepStatus, 'running')
  }
})
