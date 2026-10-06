'use strict'

// Stall-point planner (idkcraft-vmzq.5): brain.plan() posts the
// goal/situation/history object state to JEV and reads choice +
// probabilities + confidence. Laya never gets this call.

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const { stubBrain, jevBrain, makeBrain, hybridBrain, planner, JEV_ENDPOINT, JEV_MODEL, PLAN_TIMEOUT_MS } = require('../src/brain')
const metrics = require('../src/metrics')

assert.equal(PLAN_TIMEOUT_MS, 20000, 'plan has its own 20 s deadline, off the tick path')
assert.equal(JEV_MODEL, 'jev-latest')

const LAYA_URL = 'http://laya:8000/v1/systemone'
const STATE = { goal: 'build castle', progress: '8/1722', blocked_on: 'step=castlefetch running', recent: ['equip:craft-stall'], since_min: 45, facts: 'time=day logs=few planks=few' }
const CRITERIA = { equip: 'sword is no: craft tools', forage: 'known is near: dig it' }

function cannedFetch(choice, extra = {}) {
  return async () => ({
    ok: true,
    json: async () => ({ answers: { action: { type: 'choice', choice, confidence: 0.73, probabilities: { [choice]: 0.7 }, ...extra } } }),
  })
}

async function jevOutcome(outcome) {
  const text = await metrics.client.register.metrics()
  const m = text.match(new RegExp(`idkcraft_bot_brain_requests_total\\{source="jev",outcome="${outcome}"\\} ([0-9.e+]+)`))
  return m ? Number(m[1]) : 0
}

describe('brain plan() (vmzq.5)', () => {
  it('posts the object state to JEV and returns choice + confidence + probabilities', async () => {
    const seen = {}
    const rec = async (url, opts) => {
      seen.url = url
      seen.body = JSON.parse(opts.body)
      seen.auth = opts.headers.Authorization
      return cannedFetch('equip')()
    }
    const b = jevBrain('k', rec, 1000, JEV_ENDPOINT)
    const r = await b.plan({ state: STATE, instructions: 'Pick the next step', criteria: CRITERIA })
    assert.deepEqual(r, { step: 'equip', confidence: 0.73, probabilities: { equip: 0.7 }, source: 'jev' })
    assert.equal(seen.url, JEV_ENDPOINT)
    assert.equal(seen.body.model, JEV_MODEL)
    assert.deepEqual(seen.body.state, STATE, 'object state rides the wire as an object')
    assert.deepEqual(seen.body.questions.action, { type: 'choice', instructions: 'Pick the next step', criteria: CRITERIA })
    assert.equal(seen.auth, 'Bearer k')
  })

  it('a laya brain with a key still plans via JEV, never laya', async () => {
    const seen = {}
    const rec = async (url, opts) => {
      seen.url = url
      return cannedFetch('forage')()
    }
    const b = jevBrain('k', rec, 1000, LAYA_URL)
    assert.equal(typeof b.plan, 'function', 'keyed laya brain has plan()')
    const r = await b.plan({ state: STATE, instructions: 'Pick', criteria: CRITERIA })
    assert.equal(r.step, 'forage')
    assert.equal(seen.url, JEV_ENDPOINT, 'plan posts to JEV, not the tick URL')
  })

  it('hybrid forwards plan() when the remote has it', async () => {
    const h = hybridBrain(jevBrain('k', cannedFetch('equip'), 1000, LAYA_URL))
    assert.equal(typeof h.plan, 'function')
    const r = await h.plan({ state: STATE, instructions: 'Pick', criteria: CRITERIA })
    assert.equal(r.step, 'equip')
  })

  it('no key means no plan(): stub, keyless jev and keyless hybrid', () => {
    assert.equal(stubBrain.plan, undefined)
    assert.equal(jevBrain(undefined, cannedFetch('equip')).plan, undefined)
    assert.equal(jevBrain('', cannedFetch('equip')).plan, undefined)
    assert.equal(hybridBrain(jevBrain(undefined, cannedFetch('equip'))).plan, undefined)
    assert.equal(makeBrain({}).plan, undefined, 'key-absent bot runs the stub with no plan')
    assert.equal(makeBrain({ BRAIN_URL: LAYA_URL }).plan, undefined, 'keyless laya hybrid has no plan')
  })

  it('a choice outside the menu throws invalid and counts it', async () => {
    const before = await jevOutcome('invalid')
    const b = jevBrain('k', cannedFetch('frobnicate'), 1000, JEV_ENDPOINT)
    await assert.rejects(b.plan({ state: STATE, instructions: 'Pick', criteria: CRITERIA }), /jev missing plan answer/)
    assert.equal(await jevOutcome('invalid'), before + 1)
  })

  it('a missing answer throws invalid', async () => {
    const empty = async () => ({ ok: true, json: async () => ({ answers: {} }) })
    const b = jevBrain('k', empty, 1000, JEV_ENDPOINT)
    await assert.rejects(b.plan({ state: STATE, instructions: 'Pick', criteria: CRITERIA }), /jev missing plan answer/)
  })

  it('http errors and timeouts throw with their outcome counted', async () => {
    const httpBefore = await jevOutcome('http')
    const bad = async () => ({ ok: false, status: 500 })
    await assert.rejects(
      jevBrain('k', bad, 1000, JEV_ENDPOINT).plan({ state: STATE, instructions: 'Pick', criteria: CRITERIA }),
      /jev http 500/,
    )
    assert.equal(await jevOutcome('http'), httpBefore + 1)
    const timeoutBefore = await jevOutcome('timeout')
    const slow = async () => { throw new DOMException('brain timeout', 'TimeoutError') }
    await assert.rejects(
      jevBrain('k', slow, 1000, JEV_ENDPOINT).plan({ state: STATE, instructions: 'Pick', criteria: CRITERIA }),
      (err) => err && err.name === 'TimeoutError',
    )
    assert.equal(await jevOutcome('timeout'), timeoutBefore + 1)
  })

  it('a stalled plan aborts within its deadline', async () => {
    const hanging = (url, opts) => new Promise((resolve, reject) => {
      opts.signal.addEventListener('abort', () => reject(opts.signal.reason))
    })
    const t0 = Date.now()
    await assert.rejects(
      planner('k', hanging, 30).plan({ state: STATE, instructions: 'Pick', criteria: CRITERIA }),
      (err) => err && err.name === 'TimeoutError',
    )
    assert.ok(Date.now() - t0 < 5000, 'aborted promptly')
  })

  it('a single option answers directly without a call', async () => {
    let calls = 0
    const rec = async (...a) => { calls++; return cannedFetch('equip')(...a) }
    const r = await jevBrain('k', rec, 1000, JEV_ENDPOINT).plan({ state: STATE, instructions: 'Pick', criteria: { equip: 'x' } })
    assert.deepEqual(r, { step: 'equip', confidence: 1, probabilities: { equip: 1 }, source: 'single' })
    assert.equal(calls, 0, 'no model call for one option')
  })

  it('an empty menu throws without a call', async () => {
    let calls = 0
    const rec = async (...a) => { calls++; return cannedFetch('equip')(...a) }
    await assert.rejects(
      jevBrain('k', rec, 1000, JEV_ENDPOINT).plan({ state: STATE, instructions: 'Pick', criteria: {} }),
      /jev missing plan answer/,
    )
    assert.equal(calls, 0)
  })

  it('planner() alone builds a plan-only object (off-downgrade seam)', async () => {
    const p = planner('k', cannedFetch('gather'))
    assert.deepEqual(Object.keys(p), ['plan'])
    const r = await p.plan({ state: STATE, instructions: 'Pick', criteria: { gather: 'x', rest: 'y' } })
    assert.equal(r.step, 'gather')
  })
})
