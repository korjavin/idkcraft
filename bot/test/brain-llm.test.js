'use strict'

// LLM stall-point planner (idkcraft-vhlb.2): the plan() contract answered
// by the Anthropic Messages API over plain fetch. Stubbed fetch only — no
// real API call in CI.

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const { stubBrain, jevBrain, makeBrain, hybridBrain, llmPlanner, llmAsk, LLM_ASK_SYSTEM, menuAskEnabled, withPlanner, plannerChoice, plannerName, LLM_ENDPOINT, LLM_MODEL, resetLlmBudget, thinkingForModel, llmModelConfig } = require('../src/brain')
const metrics = require('../src/metrics')

const STATE = { goal: 'build castle', progress: '8/1722', blocked_on: 'step=castlefetch running', facts: 'time=day' }
const CRITERIA = { castlefetch: 'stone is near: fetch it', gather: 'logs are few: chop', park: 'nothing helps: park' }
const REQ = { state: STATE, instructions: 'Pick the next step', criteria: CRITERIA }

// Shape of a real Messages API response (content blocks + usage), per
// https://docs.claude.com/en/api/messages (response: content[], usage.input_tokens/output_tokens).
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
    assert.deepEqual(seen.body.thinking, { type: 'disabled' }, 'default haiku disables thinking')
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

  it('http 400 with message includes error details in message', async () => {
    const before = await llmOutcome('http')
    const limited = async () => ({
      ok: false,
      status: 400,
      text: async () => JSON.stringify({ error: { message: 'invalid request format' } }),
    })
    await assert.rejects(llmPlanner('k', limited).plan(REQ), /llm http 400: invalid request format/)
    assert.equal(await llmOutcome('http'), before + 1)
  })

  it('thinkingForModel selects disabled for standard models and omits for always-on models', () => {
    assert.deepEqual(thinkingForModel('claude-haiku-5-5'), { type: 'disabled' })
    assert.deepEqual(thinkingForModel('claude-3-5-haiku-20241022'), { type: 'disabled' })
    assert.equal(thinkingForModel('claude-opus-5-5'), undefined)
    assert.equal(thinkingForModel('claude-sonnet-5-5'), undefined)
    assert.equal(thinkingForModel('claude-fable-1'), undefined)
    assert.equal(thinkingForModel('mythos-beta'), undefined)

    assert.deepEqual(llmModelConfig('claude-haiku-5-5', 300), { max_tokens: 300, thinking: { type: 'disabled' } })
    assert.deepEqual(llmModelConfig('claude-opus-5-5', 300), { max_tokens: 2000, output_config: { effort: 'low' } })
    assert.deepEqual(llmModelConfig('claude-sonnet-5-5', 500), { max_tokens: 2000, output_config: { effort: 'low' } })
  })

  it('retries without thinking field when API rejects with thinking error 400', async () => {
    const bodies = []
    const fetchFn = async (url, opts) => {
      const body = JSON.parse(opts.body)
      bodies.push(body)
      if (bodies.length === 1 && body.thinking) {
        return {
          ok: false,
          status: 400,
          text: async () => JSON.stringify({ error: { message: 'To turn thinking off on this model, send "thinking": {"type": "between_tools"} instead of {"type": "disabled"}' } }),
        }
      }
      return {
        ok: true,
        json: async () => ({
          id: 'msg_retry',
          type: 'message',
          role: 'assistant',
          content: [{ type: 'text', text: '{"choice":"gather","reason":"retried without thinking"}' }],
          usage: { input_tokens: 100, output_tokens: 20 },
        }),
      }
    }
    const p = llmPlanner('k', fetchFn)
    const r = await p.plan(REQ)
    assert.equal(r.step, 'gather')
    assert.equal(bodies.length, 2, 'called twice: initial then retry')
    assert.deepEqual(bodies[0].thinking, { type: 'disabled' })
    assert.equal(bodies[1].thinking, undefined, 'retry omitted thinking')
    assert.deepEqual(bodies[1].output_config, { effort: 'low' })
    assert.equal(bodies[1].max_tokens, 2000)
  })

  it('parses text block correctly when preceded by thinking block', async () => {
    const fetchFn = async () => ({
      ok: true,
      json: async () => ({
        id: 'msg_think',
        type: 'message',
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'Let me analyze the state...' },
          { type: 'text', text: '{"choice":"park","reason":"scaffold high"}' },
        ],
        usage: { input_tokens: 150, output_tokens: 50 },
      }),
    })
    const p = llmPlanner('k', fetchFn)
    const r = await p.plan(REQ)
    assert.equal(r.step, 'park')
    assert.equal(r.reason, 'scaffold high')
  })

  it('throws max_tokens error when reply has only thinking block and stop_reason max_tokens', async () => {
    const textBefore = await metrics.client.register.metrics()
    const mBefore = textBefore.match(/idkcraft_bot_llm_calls_total\{use="planner",outcome="max_tokens"\} ([0-9.e+]+)/)
    const before = mBefore ? Number(mBefore[1]) : 0
    const fetchFn = async () => ({
      ok: true,
      json: async () => ({
        id: 'msg_exhausted',
        type: 'message',
        role: 'assistant',
        stop_reason: 'max_tokens',
        content: [
          { type: 'thinking', thinking: 'Deep thinking that exhausted the token budget before finishing...' },
        ],
        usage: { input_tokens: 150, output_tokens: 300 },
      }),
    })
    const p = llmPlanner('k', fetchFn)
    await assert.rejects(p.plan(REQ), /llm max_tokens \(thinking exhausted budget\)/)
    const textAfter = await metrics.client.register.metrics()
    const mAfter = textAfter.match(/idkcraft_bot_llm_calls_total\{use="planner",outcome="max_tokens"\} ([0-9.e+]+)/)
    const after = mAfter ? Number(mAfter[1]) : 0
    assert.equal(after, before + 1)
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

describe('llm menu ask (82zl)', () => {
  const ASK = { state: 'time=day home=built', instructions: 'Pick the next step', criteria: { gather: 'logs are few: chop', craft: 'planks are few: craft' } }

  it('valid answer returns the label on the ask wire', async () => {
    const seen = {}
    const before = await llmOutcome('ok')
    const label = await llmAsk('sk-test', messagesFetch('{"choice": "gather", "reason": "no logs."}', seen)).ask(ASK)
    assert.equal(label, 'gather')
    assert.equal(seen.url, LLM_ENDPOINT)
    assert.equal(seen.opts.headers['x-api-key'], 'sk-test')
    assert.match(seen.body.messages[0].content, /gather: logs are few: chop/, 'options as id: criterion')
    assert.equal(seen.body.system, LLM_ASK_SYSTEM, 'menus get the neutral prompt, not the stall-planner one')
    assert.ok(!/stall/i.test(LLM_ASK_SYSTEM), 'neutral prompt never says stalled')
    assert.equal(await llmOutcome('ok'), before + 1)
  })

  it('single option answers without a call', async () => {
    let calls = 0
    const label = await llmAsk('k', async () => { calls++ }).ask({ ...ASK, criteria: { gather: 'x' } })
    assert.equal(label, 'gather')
    assert.equal(calls, 0)
  })

  it('off-menu choice throws the invalid outcome', async () => {
    const before = await llmOutcome('invalid')
    await assert.rejects(llmAsk('k', messagesFetch('{"choice":"rest","reason":"tired"}')).ask(ASK), /llm missing ask answer/)
    assert.equal(await llmOutcome('invalid'), before + 1)
  })

  it('budget exhaustion skips the fetch with the budget outcome', async () => {
    // One ask costs 630 tokens (600 in + 30 out): the second is skipped.
    const saved = process.env.LLM_TOKENS_PER_HOUR
    process.env.LLM_TOKENS_PER_HOUR = '630'
    resetLlmBudget()
    let calls = 0
    const fetch = messagesFetch('{"choice": "gather", "reason": "no logs."}')
    const counting = async (...a) => { calls++; return fetch(...a) }
    try {
      assert.equal(await llmAsk('k', counting).ask(ASK), 'gather')
      await assert.rejects(llmAsk('k', counting).ask(ASK), /llm budget exhausted/)
      assert.equal(calls, 1, 'the skipped call never reaches fetch')
    } finally {
      resetLlmBudget()
      if (saved === undefined) delete process.env.LLM_TOKENS_PER_HOUR
      else process.env.LLM_TOKENS_PER_HOUR = saved
    }
  })

  it('makeBrain with the anthropic key stays stub-FSM without the switch (default off)', () => {
    const b = makeBrain({ ANTHROPIC_API_KEY: 'a' })
    assert.equal(b.source, undefined)
    assert.equal(b.ask, undefined, 'no shared ask: retreat/recover/bring keep the FSM')
    assert.equal(b.menuAsk, undefined, 'no classifier ask either')
    assert.equal(b.decide, stubBrain.decide, 'no combat tick ask (vhlb.5 stands)')
    assert.equal(plannerName(b), 'llm', 'the stall planner still rides the key')
  })

  it('makeBrain with the switch on wires menuAsk (not ask) for the llm seam', () => {
    const b = makeBrain({ ANTHROPIC_API_KEY: 'a', BOT_MENU_ASK: '1' })
    assert.equal(b.source, 'llm')
    assert.equal(typeof b.menuAsk, 'function', 'chooseStep consults this')
    assert.equal(b.ask, undefined, 'shared ask stays off: retreat/recover/bring keep the FSM')
    assert.equal(b.decide, stubBrain.decide, 'no combat tick ask (vhlb.5 stands)')
    assert.equal(plannerName(b), 'llm')
  })

  it('menu ask skips past half the token window so plan/orders keep headroom', async () => {
    // One ask costs 630 tokens (600 in + 30 out) against a 1260 cap: the
    // first spends exactly half, the second skips before any fetch, and a
    // stall-planner call still goes through on the remaining headroom.
    const saved = process.env.LLM_TOKENS_PER_HOUR
    process.env.LLM_TOKENS_PER_HOUR = '1260'
    resetLlmBudget()
    let askCalls = 0
    const askFetch = messagesFetch('{"choice": "gather", "reason": "no logs."}')
    const askCounting = async (...a) => { askCalls++; return askFetch(...a) }
    let planCalls = 0
    const planFetch = messagesFetch('{"choice": "gather", "reason": "stalled."}')
    const planCounting = async (...a) => { planCalls++; return planFetch(...a) }
    try {
      assert.equal(await llmAsk('k', askCounting).ask(ASK), 'gather')
      await assert.rejects(llmAsk('k', askCounting).ask(ASK), /llm budget exhausted \(menu ask headroom\)/)
      assert.equal(askCalls, 1, 'the skipped menu ask never reaches fetch')
      const r = await llmPlanner('k', planCounting).plan(REQ)
      assert.equal(r.step, 'gather', 'the planner still answers on its headroom')
      assert.equal(planCalls, 1)
    } finally {
      resetLlmBudget()
      if (saved === undefined) delete process.env.LLM_TOKENS_PER_HOUR
      else process.env.LLM_TOKENS_PER_HOUR = saved
    }
  })

  it('menuAskEnabled accepts the BOT_AUTONOMOUS spellings, rejects the rest', () => {
    for (const v of ['1', 'true', 'yes']) assert.equal(menuAskEnabled({ BOT_MENU_ASK: v }), true, v)
    for (const env of [{}, { BOT_MENU_ASK: '' }, { BOT_MENU_ASK: '0' }, { BOT_MENU_ASK: 'on' }]) assert.equal(menuAskEnabled(env), false, JSON.stringify(env))
  })
})
