'use strict'

// LLM stall-point planner (idkcraft-vhlb.2): the plan() contract answered
// by the Anthropic Messages API over plain fetch. Stubbed fetch only — no
// real API call in CI.

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const { stubBrain, jevBrain, makeBrain, hybridBrain, llmPlanner, withPlanner, plannerChoice, plannerName, LLM_ENDPOINT, LLM_MODEL } = require('../src/brain')
const metrics = require('../src/metrics')

const STATE = { goal: 'build castle', progress: '8/1722', blocked_on: 'step=castlefetch running', facts: 'time=day' }
const CRITERIA = { castlefetch: 'stone is near: fetch it', gather: 'logs are few: chop', park: 'nothing helps: park' }
const REQ = { state: STATE, instructions: 'Pick the next step', criteria: CRITERIA }

// Shape of a real Messages API response (content blocks + usage).
function messagesFetch(text, seen = {}) {
  return async (url, opts) => {
    seen.url = url
    seen.opts = opts
    seen.body = JSON.parse(opts.body)
    return {
      ok: true,
      json: async () => ({
        id: 'msg_x', type: 'message', role: 'assistant', model: LLM_MODEL,
        content: [{ type: 'text', text }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 600, output_tokens: 30 },
      }),
    }
  }
}

async function llmOutcome(outcome) {
  const text = await metrics.client.register.metrics()
  const m = text.match(new RegExp(`idkcraft_bot_brain_requests_total\\{source="llm",outcome="${outcome}"\\} ([0-9.e+]+)`))
  return m ? Number(m[1]) : 0
}

describe('llm planner (vhlb.2)', () => {
  it('valid answer: choice + reason, null confidence, key + model on the wire', async () => {
    assert.equal(LLM_MODEL, 'claude-haiku-5-5')
    const seen = {}
    const before = await llmOutcome('ok')
    const p = llmPlanner('sk-test', messagesFetch('{"choice": "gather", "reason": "no logs left for scaffolding."}', seen))
    const r = await p.plan(REQ)
    assert.deepEqual(r, { step: 'gather', confidence: null, probabilities: null, source: 'llm', reason: 'no logs left for scaffolding.' })
    assert.equal(seen.url, LLM_ENDPOINT)
    assert.equal(seen.opts.headers['x-api-key'], 'sk-test')
    assert.equal(seen.opts.headers['anthropic-version'], '2023-06-01')
    assert.equal(seen.body.model, 'claude-haiku-5-5')
    assert.match(seen.body.messages[0].content, /"progress":"8\/1722"/, 'state rides as JSON')
    assert.match(seen.body.messages[0].content, /gather: logs are few: chop/, 'options as id: criterion')
    assert.equal(await llmOutcome('ok'), before + 1)
  })

  it('tolerates a fenced JSON answer and honours LLM_MODEL', async () => {
    const seen = {}
    const b = withPlanner(stubBrain, { ANTHROPIC_API_KEY: 'k', LLM_MODEL: 'claude-x' }, messagesFetch('```json\n{"choice":"park","reason":"r"}\n```', seen))
    assert.equal((await b.plan(REQ)).step, 'park')
    assert.equal(seen.body.model, 'claude-x')
  })

  it('invalid id throws the invalid outcome', async () => {
    const before = await llmOutcome('invalid')
    await assert.rejects(llmPlanner('k', messagesFetch('{"choice":"rest","reason":"tired"}')).plan(REQ), /llm missing plan answer/)
    await assert.rejects(llmPlanner('k', messagesFetch('I think gather')).plan(REQ), /llm missing plan answer/)
    assert.equal(await llmOutcome('invalid'), before + 2)
  })

  it('http 429 throws the http outcome', async () => {
    const before = await llmOutcome('http')
    const limited = async () => ({ ok: false, status: 429 })
    await assert.rejects(llmPlanner('k', limited).plan(REQ), /llm http 429/)
    assert.equal(await llmOutcome('http'), before + 1)
  })

  it('timeout aborts within the deadline with the timeout outcome', async () => {
    const before = await llmOutcome('timeout')
    const hanging = (url, opts) => new Promise((resolve, reject) => {
      opts.signal.addEventListener('abort', () => reject(opts.signal.reason))
    })
    const t0 = Date.now()
    await assert.rejects(llmPlanner('k', hanging, 30).plan(REQ), (err) => err && err.name === 'TimeoutError')
    assert.ok(Date.now() - t0 < 5000)
    assert.equal(await llmOutcome('timeout'), before + 1)
  })

  it('single option answers without a call', async () => {
    let calls = 0
    const r = await llmPlanner('k', async () => { calls++ }).plan({ ...REQ, criteria: { gather: 'x' } })
    assert.equal(r.step, 'gather')
    assert.equal(calls, 0)
  })

  it('key absent: brains are untouched (prod today)', () => {
    assert.equal(plannerChoice({}), 'jev')
    assert.equal(plannerChoice({ PLANNER: 'llm' }), 'jev', 'llm without its key falls back')
    assert.equal(withPlanner(stubBrain, {}), stubBrain)
    assert.equal(makeBrain({}).plan, undefined)
    assert.equal(plannerName(makeBrain({})), 'none')
    assert.equal(plannerName(makeBrain({ TYPESAFE_API_KEY: 'j' })), 'jev')
  })

  it('selection: default llm with its key, PLANNER=jev keeps the JEV planner', () => {
    assert.equal(plannerChoice({ ANTHROPIC_API_KEY: 'a' }), 'llm')
    const llm = makeBrain({ ANTHROPIC_API_KEY: 'a' })
    assert.equal(typeof llm.plan, 'function', 'stub brain gains plan()')
    assert.equal(plannerName(llm), 'llm')
    assert.equal(llm.decide, stubBrain.decide, 'tick path unchanged')
    assert.equal(plannerName(makeBrain({ ANTHROPIC_API_KEY: 'a', BRAIN_URL: 'http://laya:8000/v1/systemone' })), 'llm')
    const jev = makeBrain({ ANTHROPIC_API_KEY: 'a', TYPESAFE_API_KEY: 'j', PLANNER: 'jev' })
    assert.equal(plannerName(jev), 'jev')
    assert.equal(plannerName(withPlanner(hybridBrain(jevBrain('j')), { ANTHROPIC_API_KEY: 'a' })), 'llm', 'llm overrides the keyed JEV plan')
  })
})
