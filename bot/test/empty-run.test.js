'use strict'
const test = require('node:test')
const assert = require('node:assert')
const { emptyRun } = require('../src/goal')

test('a step done on its first tick twice in a row turns failed:idle', () => {
  const ctx = {}
  // pick tick: applyChoice zeroes the counter after decide's increment
  emptyRun(ctx, null, null, false); ctx.stepDecides = 0
  assert.strictEqual(emptyRun(ctx, 'castlefetch', 'done', true), 'done')
  ctx.stepDecides = 0 // re-picked
  assert.strictEqual(emptyRun(ctx, 'castlefetch', 'done', true), 'failed:idle')
  assert.strictEqual(ctx.stepStatus, 'failed:idle')
})

test('a step that ran several ticks before done is not empty', () => {
  const ctx = { stepDecides: 0 }
  emptyRun(ctx, 'castlefetch', 'running', false)
  assert.strictEqual(emptyRun(ctx, 'castlefetch', 'done', true), 'done')
  ctx.stepDecides = 0
  assert.strictEqual(emptyRun(ctx, 'castlefetch', 'done', true), 'done') // first empty run only
  ctx.stepDecides = 0
  assert.strictEqual(emptyRun(ctx, 'gather', 'done', true), 'done') // another step restarts the count
})

test('self-advancing steps and failures never convert', () => {
  const ctx = { stepDecides: 0 }
  assert.strictEqual(emptyRun(ctx, 'stay', 'done', true), 'done'); ctx.stepDecides = 0
  assert.strictEqual(emptyRun(ctx, 'stay', 'done', true), 'done'); ctx.stepDecides = 0
  assert.strictEqual(emptyRun(ctx, 'castle', 'failed:x', true), 'failed:x')
})
