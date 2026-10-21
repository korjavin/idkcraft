'use strict'

// LLM activity chooser (idkcraft-qxql.10): at a nothing-useful FSM pick the
// bot asks the model for 1-3 steps of useful work. Fake fetch only.

const { describe, it, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const { handleChat, createTicker } = require('../src/index')
const llmOrders = require('../src/llm-orders')
const { resetLlmBudget, LLM_MODEL } = require('../src/brain')

function pos(x, y, z) {
  const p = { x, y, z, distanceTo: (q) => Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z), clone() { return pos(p.x, p.y, p.z) } }
  return p
}

function mockBot(items = []) {
  const lines = []
  const itemsByName = { torch: { id: 1 }, coal: { id: 2 }, stick: { id: 3 } }
  const bot = {
    lines,
    username: 'IdkBot',
    entities: {},
    health: 20,
    food: 20,
    entity: { position: pos(0, 64, 0), onGround: true },
    registry: { blocksByName: {}, itemsByName },
    players: { P: { username: 'P', entity: { position: pos(1, 64, 0) } } },
    pathfinder: { goal: null, setGoal: (g) => { bot.pathfinder.goal = g }, isMoving: () => false },
    inventory: { items: () => items },
    toss: async () => {},
    chat(line) { lines.push(String(line)) },
  }
  return bot
}

function tickerFor(bot) {
  return createTicker({ bot, brain: { decide: async () => ({ action: 'idle', sprint: false, source: 'stub' }) }, tickMs: 10, idleTickMs: 10 })
}

const flush = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r)) }

let calls
let answer
let saved
let origFetch
let origLog
let logs
beforeEach(() => {
  saved = { on: process.env.BOT_LLM_ORDERS, key: process.env.ANTHROPIC_API_KEY, choose: process.env.LLM_CHOOSE, min: process.env.LLM_CHOOSE_MIN_MS }
  process.env.ANTHROPIC_API_KEY = 'test-key'
  delete process.env.LLM_CHOOSE
  delete process.env.LLM_CHOOSE_MIN_MS
  resetLlmBudget()
  calls = []
  answer = '{"plan":[],"need":"test"}'
  logs = []
  origFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    calls.push(JSON.parse(init.body))
    return {
      ok: true,
      json: async () => ({ id: 'msg_x', type: 'message', role: 'assistant', model: LLM_MODEL, content: [{ type: 'text', text: answer }], stop_reason: 'end_turn', usage: { input_tokens: 900, output_tokens: 40 } }),
    }
  }
  origLog = console.log
  console.log = (m) => { logs.push(String(m)) }
})
afterEach(() => {
  globalThis.fetch = origFetch
  console.log = origLog
  resetLlmBudget()
  for (const [k, v] of [['BOT_LLM_ORDERS', saved.on], ['ANTHROPIC_API_KEY', saved.key], ['LLM_CHOOSE', saved.choose], ['LLM_CHOOSE_MIN_MS', saved.min]]) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
})

function ctxWith(work = true) {
  const bot = mockBot()
  const ticker = tickerFor(bot)
  const ctx = bot._tickerCtx
  ctx.work = work
  return { bot, ctx, ticker }
}

describe('chooser flag', () => {
  it('on with key, off with LLM_CHOOSE=0 or no key', () => {
    assert.equal(llmOrders.chooseEnabled(), true)
    process.env.LLM_CHOOSE = '0'
    assert.equal(llmOrders.chooseEnabled(), false)
    delete process.env.LLM_CHOOSE
    delete process.env.ANTHROPIC_API_KEY
    assert.equal(llmOrders.chooseEnabled(), false)
  })
})

describe('chooser validatePlan', () => {
  it('keeps why/need, caps plan at 3, rejects order steps', () => {
    const works = ['light', 'gather']
    const ok = llmOrders.validatePlan({ plan: [{ step: 'light' }, { step: 'gather' }], why: 'house is dark', need: 'torches' }, works, { maxSteps: 3, allowOrders: false })
    assert.ok(ok.steps && ok.steps.length === 2)
    assert.equal(ok.why, 'house is dark')
    assert.equal(ok.need, 'torches')
    const tooLong = llmOrders.validatePlan({ plan: [{ step: 'light' }, { step: 'light' }, { step: 'light' }, { step: 'light' }] }, works, { maxSteps: 3, allowOrders: false })
    assert.match(tooLong.error, /plan too long/)
    for (const id of ['bring', 'find', 'flat', 'share']) {
      const r = llmOrders.validatePlan({ plan: [{ step: id }] }, works, { maxSteps: 3, allowOrders: false })
      assert.match(r.error, /no step/, id)
    }
    const empty = llmOrders.validatePlan({ plan: [], need: 'a dig skill' }, works, { maxSteps: 3, allowOrders: false })
    assert.equal(empty.empty, true)
    assert.equal(empty.need, 'a dig skill')
  })
  it('normal orders still allow order steps and up to 6', () => {
    const r = llmOrders.validatePlan({ plan: [{ step: 'bring', item: 'torch', count: 8 }] }, ['light'])
    assert.ok(r.steps)
  })
})

describe('chooser trigger', () => {
  it('fires on idle daytime with no order, never twice inside the window, never with llmAsk', () => {
    const { ctx } = ctxWith(true)
    const facts = { time: 'day', castle: 'none' }
    assert.equal(llmOrders.shouldChoose('idle', ctx, facts, 1000000), true)
    ctx.llmChooseAt = 1000000
    ctx.llmChooseWait = 300000
    assert.equal(llmOrders.shouldChoose('idle', ctx, facts, 1000000 + 1000), false)
    assert.equal(llmOrders.shouldChoose('idle', ctx, facts, 1000000 + 300000), true)
    ctx.llmChooseAt = 0
    ctx.llmAsk = { text: 'x', at: 1 }
    assert.equal(llmOrders.shouldChoose('idle', ctx, facts, 1000000), false)
    ctx.llmAsk = null
    ctx.llmOrder = { text: 'choose work: no-order', steps: [{ step: 'light' }], i: 0 }
    assert.equal(llmOrders.shouldChoose('idle', ctx, facts, 1000000), false)
  })
  it('fires on a house pick with a castle order, never on gohome/shelter', () => {
    const { ctx } = ctxWith(true)
    ctx.castle = { site: { x: 10, y: 64, z: 10 } }
    const castleFacts = { time: 'day', castle: 'stone-none' }
    const homeFacts = { time: 'day', castle: 'none' }
    assert.equal(llmOrders.shouldChoose('craft', ctx, castleFacts, 2000000), true)
    assert.equal(llmOrders.shouldChoose('craft', ctx, homeFacts, 2000000), false)
    assert.equal(llmOrders.shouldChoose('gohome', ctx, castleFacts, 2000000), false)
    assert.equal(llmOrders.shouldChoose('shelter', ctx, castleFacts, 2000000), false)
    assert.equal(llmOrders.shouldChoose('stay', ctx, { time: 'day', castle: 'none' }, 2000000), true)
    assert.equal(llmOrders.shouldChoose('stay', ctx, { time: 'night', castle: 'none' }, 2000000), false)
    assert.equal(llmOrders.shouldChoose('rest', ctx, { time: 'day', castle: 'none' }, 2000000), true)
    assert.equal(llmOrders.shouldChoose('rest', ctx, { time: 'night', castle: 'none' }, 2000000), false)
    assert.equal(llmOrders.shouldChoose('explore', ctx, homeFacts, 2000000), true)
    assert.equal(llmOrders.shouldChoose('gear', ctx, homeFacts, 2000000), false)
    assert.equal(llmOrders.shouldChoose('forage', ctx, homeFacts, 2000000), false)
  })
  it('never fires paused or out of work mode', () => {
    const { ctx } = ctxWith(true)
    const facts = { time: 'day', castle: 'none' }
    ctx.paused = true
    assert.equal(llmOrders.shouldChoose('idle', ctx, facts, 3000000), false)
    ctx.paused = false
    ctx.work = false
    assert.equal(llmOrders.shouldChoose('idle', ctx, facts, 3000000), false)
  })
})

describe('chooser ask', () => {
  it('installs a self plan, chats only with a roster player online', async () => {
    const { bot, ctx } = ctxWith(true)
    answer = '{"plan":[{"step":"light","done":"house lit"}],"why":"dark house","need":""}'
    const fired = llmOrders.ask(bot, ctx, { text: 'choose work: no-order', by: 'self', ticker: null, feed: null, fallback: null, explicit: false, choose: { regime: 'no-order', trigger: 'idle' } })
    assert.ok(fired)
    await flush()
    assert.ok(ctx.llmOrder)
    assert.equal(ctx.llmOrder.by, 'self')
    assert.ok(logs.some((l) => l.startsWith('llm choose regime=no-order trigger=idle outcome=ok plan=light')), JSON.stringify(logs))
    assert.ok(bot.lines.includes('plan: light'), 'roster player P online: chats')
  })
  it('logs only with nobody online', async () => {
    const { bot, ctx } = ctxWith(true)
    bot.players = {}
    answer = '{"plan":[{"step":"light"}],"why":"dark","need":""}'
    llmOrders.ask(bot, ctx, { text: 'choose work: no-order', by: 'self', ticker: null, feed: null, fallback: null, explicit: false, choose: { regime: 'no-order', trigger: 'idle' } })
    await flush()
    assert.ok(ctx.llmOrder)
    assert.deepEqual(bot.lines, [], 'no chat with nobody online')
    assert.ok(logs.some((l) => l.startsWith('llm choose regime=no-order')), JSON.stringify(logs))
  })
  it('empty plan is a fallback: no plan, FSM pick stands', async () => {
    const { bot, ctx } = ctxWith(true)
    answer = '{"plan":[],"need":"a quarry skill"}'
    llmOrders.ask(bot, ctx, { text: 'choose work: no-order', by: 'self', ticker: null, feed: null, fallback: null, explicit: false, choose: { regime: 'no-order', trigger: 'idle' } })
    await flush()
    assert.ok(!ctx.llmOrder)
    assert.ok(logs.some((l) => l.includes('outcome=empty') && l.includes('need="a quarry skill"')), JSON.stringify(logs))
  })
  it('stop cancels a chooser plan and go work does not immediate re-ask', async () => {
    const { bot, ctx, ticker } = ctxWith(true)
    answer = '{"plan":[{"step":"light"}],"why":"dark","need":""}'
    llmOrders.ask(bot, ctx, { text: 'choose work: no-order', by: 'self', ticker: null, feed: null, fallback: null, explicit: false, choose: { regime: 'no-order', trigger: 'idle' } })
    await flush()
    assert.ok(ctx.llmOrder)
    handleChat(bot, ticker, 'P', 'stop')
    assert.equal(ctx.llmOrder, null)
    // go work right after: work resumes unpaused, but the rate limit (just
    // called) blocks an immediate re-ask
    handleChat(bot, ticker, 'P', 'go work')
    ctx.paused = false
    ctx.work = true
    const facts = { time: 'day', castle: 'none' }
    assert.equal(llmOrders.shouldChoose('idle', ctx, facts), false)
  })
})
