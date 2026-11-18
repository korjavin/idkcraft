'use strict'
// failed:idle (a step found nothing workable): yields for IDLE_RETRY_MS
// whatever facts drift, released early only by the step's own word.
const { it } = require('node:test')
const assert = require('node:assert/strict')
const { failHolds } = require('../src/goal')
const { IDLE_RETRY_MS } = require('../src/budget')

const rec = (at) => ({ castle: { status: 'failed:idle', text: 'time=day logs=few castle=clear', pos: { x: 0, y: 0, z: 0 }, at } })
const bot = { entity: { position: { x: 500, y: 64, z: 500 } } } // far from the failure: a text hold would release

it('idle castle holds across unrelated drift and relocation', () => {
  const ctx = { stepFail: rec(Date.now()) }
  assert.equal(failHolds(ctx, 'castle', 'time=dusk logs=many castle=clear', bot), true)
})
it('a new castle word releases the idle hold at once', () => {
  const ctx = { stepFail: rec(Date.now()) }
  assert.equal(failHolds(ctx, 'castle', 'time=day logs=few castle=stone-batch', bot), false)
})
it('the idle hold expires after IDLE_RETRY_MS', () => {
  const ctx = { stepFail: rec(Date.now() - IDLE_RETRY_MS - 1) }
  assert.equal(failHolds(ctx, 'castle', 'time=day logs=few castle=clear', bot), false)
})
