'use strict'
const test = require('node:test')
const assert = require('node:assert')
const goal = require('../src/goal')
const { IDLE_RETRY_MS } = require('../src/budget')

// Prod bot5: farmbuild running, a facts word flips, light re-offered after
// failed:no-effect-bookshelf, fails again; the farm never progressed.
test('no-effect failure holds across a facts-text flip, backoff doubles on repeat', () => {
  const bot = { entity: { position: { x: 0, y: 64, z: 0 } } }
  const ctx = { goalText: 'a' }
  goal.recordOutcome(bot, ctx, {}, 'light', 'failed:no-effect-bookshelf', true, 'text-a')
  assert.strictEqual(goal.failHolds(ctx, 'light', 'text-b', bot), true, 'unrelated text change must not release')
  ctx.stepFail.light.at -= IDLE_RETRY_MS + 1
  assert.strictEqual(goal.failHolds(ctx, 'light', 'text-b', bot), false, 'released after the window')
  goal.recordOutcome(bot, ctx, {}, 'light', 'failed:no-effect-bookshelf', true, 'text-b')
  assert.strictEqual(ctx.stepFail.light.n, 2)
  ctx.stepFail.light.at -= IDLE_RETRY_MS + 1
  assert.strictEqual(goal.failHolds(ctx, 'light', 'text-c', bot), true, 'second same-reason fail holds twice as long')
})
