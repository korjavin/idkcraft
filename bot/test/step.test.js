'use strict'

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const step = require('../src/step')

describe('step protocol (oqul.6)', () => {
  it('writes the same strings as before', () => {
    const ctx = {}
    step.stepDone(ctx)
    assert.equal(ctx.stepStatus, 'done')
    step.stepFailed(ctx, 'craft-oak_planks')
    assert.equal(ctx.stepStatus, 'failed:craft-oak_planks')
  })

  it('parses the failure reason', () => {
    assert.equal(step.failReason('failed:no-site'), 'no-site')
    assert.equal(step.failReason('failed:'), '')
    for (const s of ['done', 'running', null, undefined, 42, 'flat']) assert.equal(step.failReason(s), null)
  })

  it('isFinished is done or any failure', () => {
    assert.equal(step.isFinished('done'), true)
    assert.equal(step.isFinished('failed:x'), true)
    assert.equal(step.isFinished('running'), false)
    assert.equal(step.isFinished(null), false)
  })
})
