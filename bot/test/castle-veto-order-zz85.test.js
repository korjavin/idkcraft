'use strict'

// zz85: an explicit owner order outranks the castle-first veto for its own
// step only. Autonomous picks (FSM, stall planner, chooser) never lift it,
// and the veto returns the moment the order ends.

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const { castleFirst } = require('../src/vetoes')

// Active castle (vetoes.castleFirst reads explore.castleActive off ctx).
function activeCastleCtx(extra = {}) {
  return {
    castle: { site: { x: 0, y: 64, z: 0 }, parked: false, phase: 'build' },
    ...extra,
  }
}

describe('zz85 explicit order lifts castleFirst for its own step', () => {
  it('vetoes reforest with an active castle and no order', () => {
    assert.equal(castleFirst(activeCastleCtx(), 'reforest'), true)
  })

  it('explicit order on reforest lifts the veto', () => {
    const ctx = activeCastleCtx({
      llmOrder: { explicit: true, steps: [{ step: 'reforest', count: 10 }], i: 0 },
    })
    assert.equal(castleFirst(ctx, 'reforest'), false)
  })

  it('explicit order on another step keeps the veto for reforest', () => {
    const ctx = activeCastleCtx({
      llmOrder: { explicit: true, steps: [{ step: 'build' }], i: 0 },
    })
    assert.equal(castleFirst(ctx, 'reforest'), true)
    assert.equal(castleFirst(ctx, 'build'), false)
  })

  it('non-explicit (chooser) order keeps the veto', () => {
    const ctx = activeCastleCtx({
      llmOrder: { explicit: false, steps: [{ step: 'reforest' }], i: 0 },
    })
    assert.equal(castleFirst(ctx, 'reforest'), true)
  })

  it('veto returns when the order ends', () => {
    const ctx = activeCastleCtx({
      llmOrder: { explicit: true, steps: [{ step: 'reforest' }], i: 0 },
    })
    assert.equal(castleFirst(ctx, 'reforest'), false)
    ctx.llmOrder = null
    assert.equal(castleFirst(ctx, 'reforest'), true)
  })

  it('no-step form still reads bare castle-active', () => {
    assert.equal(castleFirst(activeCastleCtx()), true)
    assert.equal(castleFirst({}), false)
  })
})

describe('zz85 installPlan marks player-issued orders', () => {
  const { installPlan } = require('../src/llm-orders')
  const fakeBot = () => ({ chat() {} })
  const install = (req) => {
    const ctx = {}
    const ok = installPlan(fakeBot(), ctx, req, [{ step: 'reforest', count: 10 }], () => {})
    assert.equal(ok, true)
    return ctx.llmOrder
  }

  it('bare player order (explicit unset) is player-issued', () => {
    const o = install({ text: 'reforest 10', by: 'IdkTester', ticker: null, feed: null })
    assert.equal(o.explicit, true)
    assert.equal(castleFirst(activeCastleCtx({ llmOrder: { ...o, steps: [{ step: 'reforest' }], i: 0 } }), 'reforest'), false)
  })

  it('chooser (by self) stays non-explicit', () => {
    const o = install({ text: 'choose work: no-order', by: 'self', ticker: null, feed: null, explicit: false })
    assert.equal(o.explicit, false)
  })
})
