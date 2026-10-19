'use strict'

// LLM orders (idkcraft-vf8e.6): BOT_LLM_ORDERS=1 sends an unparsed player
// line (or an unknown bring name, or `plan <order>`) to ONE Messages-API call;
// the JSON plan runs over whitelisted steps — chat orders re-fed through
// handleChat, MENU work steps pinned via ctx.taskPlanStep. Flag off: chat is
// unchanged and no fetch happens. Fake fetch only (Messages API shape).

const { describe, it, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const { handleChat, createTicker } = require('../src/index')
const llmOrders = require('../src/llm-orders')
const bringbase = require('../src/behaviours/bringbase')
const { resetLlmBudget, LLM_MODEL } = require('../src/brain')

function pos(x, y, z) {
  const p = { x, y, z, distanceTo: (q) => Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z), clone() { return pos(p.x, p.y, p.z) } }
  return p
}

// Fake of the mineflayer Bot surface (github.com/PrismarineJS/mineflayer docs/api.md)
// that llm-orders/chat touch: bot.username, bot.entities, bot.health, bot.food,
// bot.entity.position/onGround, bot.registry.blocksByName/itemsByName (minecraft-data),
// bot.players[name].entity, bot.inventory.items(), bot.toss(), bot.chat(); plus
// bot.pathfinder.goal/setGoal()/isMoving() from mineflayer-pathfinder. No events are
// emitted — chat is driven by calling handleChat directly, like the 'chat' event handler.
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
beforeEach(() => {
  saved = { on: process.env.BOT_LLM_ORDERS, key: process.env.ANTHROPIC_API_KEY }
  process.env.BOT_LLM_ORDERS = '1'
  process.env.ANTHROPIC_API_KEY = 'test-key'
  resetLlmBudget()
  calls = []
  answer = '{"plan":[]}'
  origFetch = globalThis.fetch
  // Fake of the Anthropic Messages API (docs.anthropic.com/en/api/messages):
  // brain.llmCall POSTs https://api.anthropic.com/v1/messages with headers
  // x-api-key, anthropic-version: 2023-06-01 and content-type: application/json,
  // JSON body {model, max_tokens, system, messages}. The reply mirrors the real
  // 200 response: {id, type:'message', role:'assistant', model,
  // content:[{type:'text', text}], stop_reason, usage:{input_tokens, output_tokens}}.
  globalThis.fetch = async (url, init) => {
    calls.push(JSON.parse(init.body))
    return {
      ok: true,
      json: async () => ({ id: 'msg_x', type: 'message', role: 'assistant', model: LLM_MODEL, content: [{ type: 'text', text: answer }], stop_reason: 'end_turn', usage: { input_tokens: 900, output_tokens: 40 } }),
    }
  }
  origLog = console.log
  console.log = () => {}
})
afterEach(() => {
  globalThis.fetch = origFetch
  console.log = origLog
  resetLlmBudget()
  for (const [k, v] of [['BOT_LLM_ORDERS', saved.on], ['ANTHROPIC_API_KEY', saved.key]]) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
})

describe('llm orders: flag off', () => {
  it('unparsed and unknown-bring lines behave as before, no model call', async () => {
    delete process.env.BOT_LLM_ORDERS
    const bot = mockBot()
    const ticker = tickerFor(bot)
    handleChat(bot, ticker, 'P', 'get me a bucket of water')
    handleChat(bot, ticker, 'P', 'plan light up the house')
    handleChat(bot, ticker, 'P', 'bring me 8 torches')
    await flush()
    assert.deepEqual(bot.lines, ['unknown item: 8_torches'])
    assert.equal(calls.length, 0)
    assert.ok(!bot._tickerCtx.llmOrder && !bot._tickerCtx.llmAsk)
  })
  it('no API key = off', () => {
    delete process.env.ANTHROPIC_API_KEY
    assert.equal(llmOrders.enabled(), false)
  })
})

describe('llm orders: plan validation', () => {
  const works = ['light', 'gear']
  it('whitelist: an unknown step refuses the whole plan', () => {
    assert.match(llmOrders.validatePlan({ plan: [{ step: 'light' }, { step: 'nuke' }] }, works).error, /no step "nuke"/)
  })
  it('items are registry ids, counts 1..64', () => {
    assert.deepEqual(llmOrders.validatePlan({ plan: [{ step: 'bring', item: 'Water Bucket', count: 2, done: 'two  buckets' }] }, works).steps,
      [{ step: 'bring', item: 'water_bucket', count: 2, done: 'two buckets' }])
    assert.ok(llmOrders.validatePlan({ plan: [{ step: 'bring', item: 'a;b' }] }, works).error)
    assert.ok(llmOrders.validatePlan({ plan: [{ step: 'bring', item: 'torch', count: 500 }] }, works).error)
    // codex: bring clamps to WANT_MAX (16) — 32 refuses, never delivers 16 and says done
    assert.match(llmOrders.validatePlan({ plan: [{ step: 'bring', item: 'torch', count: 32 }] }, works).error, /bring count 32/)
    assert.equal(llmOrders.validatePlan({ plan: [{ step: 'bring', item: 'torch', count: 16 }] }, works).steps[0].count, 16)
    assert.equal(llmOrders.validatePlan({ plan: [{ step: 'flat', count: 32 }] }, works).steps[0].count, 32)
    assert.ok(llmOrders.validatePlan({ plan: [{ step: 'bring' }] }, works).error)
  })
  it('empty plan and junk', () => {
    assert.equal(llmOrders.validatePlan({ plan: [] }, works).empty, true)
    assert.ok(llmOrders.validatePlan(null, works).error)
    assert.ok(llmOrders.validatePlan({ plan: Array(7).fill({ step: 'light' }) }, works).error)
  })
  it('the prompt lists order steps and registered work steps only', () => {
    const list = llmOrders.stepList()
    assert.match(list, /^bring\(item, count\): /m)
    assert.match(list, /^light: places torches/m)
    assert.doesNotMatch(list, /^(stay|gohome|shelter|rest|deliver):/m)
  })
})

describe('llm orders: flag on', () => {
  it('an unparsed line plans, the order step is re-fed as chat, done when the order ends', async () => {
    const bot = mockBot([{ name: 'torch', count: 8 }])
    const ticker = tickerFor(bot)
    const ctx = bot._tickerCtx
    answer = 'ok {"plan":[{"step":"bring","item":"torch","count":8,"done":"8 torches handed over"}]}'
    handleChat(bot, ticker, 'P', 'give me eight torches please')
    await flush()
    assert.equal(calls.length, 1)
    assert.match(calls[0].messages[0].content, /give me eight torches please/)
    assert.ok(bot.lines.includes('plan: bring torch 8'), String(bot.lines))
    llmOrders.tick(bot, ctx)
    assert.equal(ctx.bring && ctx.bring.kind, 'item', 'bring order opened through the chat path')
    assert.match(llmOrders.statusLine(ctx), /^plan 1\/1: bring torch 8 \(done when 8 torches handed over\)/)
    llmOrders.tick(bot, ctx)
    assert.ok(ctx.llmOrder, 'waits while the order runs')
    bringbase.done(bot, ctx)
    llmOrders.tick(bot, ctx)
    llmOrders.tick(bot, ctx)
    assert.equal(ctx.llmOrder, null)
    assert.ok(bot.lines.includes('done: give me eight torches please'), String(bot.lines))
  })

  it('an order step that fails or is cancelled stops the plan, never counts as done', async () => {
    for (const [endIt, why] of [[(bot, ctx) => bringbase.refuse(bot, ctx, 'could not find torch'), 'refused'], [(bot, ctx) => { ctx.bring = null }, 'cancelled']]) {
      const bot = mockBot([{ name: 'torch', count: 8 }])
      const ticker = tickerFor(bot)
      const ctx = bot._tickerCtx
      answer = '{"plan":[{"step":"bring","item":"torch","count":8},{"step":"light"}]}'
      handleChat(bot, ticker, 'P', 'torches then light the house')
      await flush()
      llmOrders.tick(bot, ctx)
      assert.ok(ctx.bring)
      endIt(bot, ctx)
      llmOrders.tick(bot, ctx)
      assert.equal(ctx.llmOrder, null, why)
      assert.ok(bot.lines.includes(`plan stopped at bring torch 8: ${why}`), String(bot.lines))
      assert.notEqual(ctx.taskPlanStep, 'light')
    }
  })

  it('a night step owns the body: the pin is held and withdrawn, re-pinned after', async () => {
    const bot = mockBot()
    const ticker = tickerFor(bot)
    const ctx = bot._tickerCtx
    answer = '{"plan":[{"step":"light"}]}'
    handleChat(bot, ticker, 'P', 'light up the house')
    await flush()
    const goal = require('../src/goal')
    const origFacts = goal.goalFacts
    goal.goalFacts = (b, c) => ({ ...origFacts(b, c), time: 'night' })
    try {
      ctx.inShelter = true
      llmOrders.tick(bot, ctx)
      assert.ok(!ctx.taskPlanStep, 'no pin while sheltering at night')
      assert.equal(ctx.llmOrder.cur, null)
      llmOrders.tick(bot, ctx, Date.now() + llmOrders.STEP_MS + 1000)
      assert.ok(bot.lines.includes('plan stopped at light: timeout'), 'the unpinned wait is bounded too')
    } finally {
      goal.goalFacts = origFacts
    }
    ctx.inShelter = false
    answer = '{"plan":[{"step":"light"}]}'
    handleChat(bot, ticker, 'P', 'light up the house')
    await flush()
    llmOrders.tick(bot, ctx)
    assert.equal(ctx.taskPlanStep, 'light')
    ctx.taskPlanStep = null
    ctx.step = 'light'
    ctx.stepStatus = 'running'
    ctx.stepGen = (ctx.stepGen | 0) + 1
    llmOrders.tick(bot, ctx)
    ctx.step = 'gohome' // dusk: the night step took the body
    ctx.stepGen++
    llmOrders.tick(bot, ctx)
    for (let i = 0; i < 5; i++) llmOrders.tick(bot, ctx, Date.now() + llmOrders.STEP_MS + 1000)
    assert.ok(ctx.llmOrder, 'held: no miss, no timeout')
    assert.equal(ctx.taskPlanStep, null, 'no pin over the night step')
    ctx.stepStatus = 'done'
    llmOrders.tick(bot, ctx)
    assert.equal(ctx.taskPlanStep, 'light', 're-pinned once the night step ended')
  })

  it('a find step is done only when its lead arrives; a lead that gives up stops the plan', async () => {
    const leadMod = require('../src/behaviours/lead')
    for (const arrive of [true, false]) {
      const bot = mockBot()
      const ticker = tickerFor(bot)
      const c = bot._tickerCtx
      answer = '{"plan":[{"step":"find","item":"iron_ore"}]}'
      handleChat(bot, ticker, 'P', 'where is iron')
      await flush()
      // The fed find line leads (stands in for findNearest on the mock world).
      c.llmOrder.feed = () => {
        c.lead = arrive
          ? { name: 'iron_ore', pos: { x: 0, y: 64, z: 0 }, by: 'P' }
          : { name: 'iron_ore', pos: { x: 40, y: 64, z: 0 }, by: 'P', waiting: true, waitTicks: leadMod.WAIT_BUDGET_TICKS }
      }
      llmOrders.tick(bot, c)
      assert.ok(c.llmOrder && c.llmOrder.cur, String(bot.lines))
      leadMod(bot, c, null, {})
      assert.equal(c.lead, null)
      llmOrders.tick(bot, c)
      llmOrders.tick(bot, c)
      assert.equal(c.llmOrder, null)
      assert.ok(bot.lines.includes(arrive ? 'done: where is iron' : 'plan stopped at find iron_ore: refused'), String(bot.lines))
    }
  })

  it('the arbiter re-deciding away re-pins while the step is feasible; a ran step that left the menu is done', async () => {
    const goal = require('../src/goal')
    const orig = goal.MENU.light.feasible
    let feasible = true
    goal.MENU.light.feasible = () => feasible
    try {
      const bot = mockBot()
      const ticker = tickerFor(bot)
      const ctx = bot._tickerCtx
      answer = '{"plan":[{"step":"light"}]}'
      handleChat(bot, ticker, 'P', 'light up the house')
      await flush()
      llmOrders.tick(bot, ctx)
      const flicker = () => {
        ctx.taskPlanStep = null
        ctx.step = 'light'
        ctx.stepStatus = 'running'
        ctx.stepGen = (ctx.stepGen | 0) + 1
        llmOrders.tick(bot, ctx)
        ctx.step = 'gather' // a text move: decide() picked another MENU step
        ctx.stepGen++
        llmOrders.tick(bot, ctx)
      }
      for (let i = 0; i < 6; i++) flicker()
      assert.ok(ctx.llmOrder, 'a flicker never kills a live step')
      assert.equal(ctx.taskPlanStep, 'light')
      feasible = false // rig LIGHT-HOUSE: torches placed, unlit none, light left the menu
      flicker()
      llmOrders.tick(bot, ctx)
      assert.equal(ctx.llmOrder, null)
      assert.ok(bot.lines.includes('done: light up the house'), String(bot.lines))
    } finally {
      goal.MENU.light.feasible = orig
    }
  })

  it('a timed-out order step drops its bring; a replaced plan drops the old one', async () => {
    const bot = mockBot([{ name: 'torch', count: 8 }])
    const ticker = tickerFor(bot)
    const ctx = bot._tickerCtx
    answer = '{"plan":[{"step":"bring","item":"torch","count":8}]}'
    handleChat(bot, ticker, 'P', 'torches please')
    await flush()
    llmOrders.tick(bot, ctx)
    assert.ok(ctx.bring)
    llmOrders.tick(bot, ctx, Date.now() + llmOrders.STEP_MS + 1000)
    assert.equal(ctx.llmOrder, null)
    assert.equal(ctx.bring, null, 'timeout released the bring')
    handleChat(bot, ticker, 'P', 'torches again')
    await flush()
    llmOrders.tick(bot, ctx)
    assert.ok(ctx.bring)
    answer = '{"plan":[{"step":"light"}]}'
    handleChat(bot, ticker, 'P', 'actually light the house')
    await flush()
    assert.equal(ctx.bring, null, 'replacement released the old bring')
    assert.equal(ctx.llmOrder.steps[0].step, 'light')
  })

  it('a daytime come-home hold does not block a work step (codex P2)', async () => {
    const bot = mockBot()
    const ticker = tickerFor(bot)
    const ctx = bot._tickerCtx
    const goal = require('../src/goal')
    const origFacts = goal.goalFacts
    goal.goalFacts = (b, c) => ({ ...origFacts(b, c), time: 'day' })
    try {
      answer = '{"plan":[{"step":"light"}]}'
      handleChat(bot, ticker, 'P', 'light up the house')
      await flush()
      ctx.inShelter = true // arriveMeet's daytime hold
      ctx.work = false
      ctx.step = 'stay' // stale: no goal arbiter outside work mode
      ctx.stepStatus = 'running'
      llmOrders.tick(bot, ctx)
      assert.equal(ctx.taskPlanStep, 'light')
    } finally {
      goal.goalFacts = origFacts
    }
  })

  it('a refused fed order is not accepted on an unrelated running bring (codex P2)', async () => {
    const bot = mockBot([{ name: 'torch', count: 8 }])
    const ticker = tickerFor(bot)
    const ctx = bot._tickerCtx
    handleChat(bot, ticker, 'P', 'bring me torch 8') // the owner's own bring
    const own = ctx.bring
    assert.ok(own)
    answer = '{"plan":[{"step":"bring","item":"zzz_thing","count":1}]}'
    handleChat(bot, ticker, 'P', 'plan get me the thing')
    await flush()
    llmOrders.tick(bot, ctx)
    assert.equal(ctx.llmOrder, null)
    assert.ok(bot.lines.includes('plan stopped at bring zzz_thing 1: refused'), String(bot.lines))
    assert.equal(ctx.bring, own, 'the unrelated bring keeps running')
  })

  it('cancel withdraws an unconsumed work pin (codex P2)', async () => {
    const bot = mockBot()
    const ticker = tickerFor(bot)
    const ctx = bot._tickerCtx
    answer = '{"plan":[{"step":"light"}]}'
    handleChat(bot, ticker, 'P', 'light up the house')
    await flush()
    llmOrders.tick(bot, ctx)
    assert.equal(ctx.taskPlanStep, 'light')
    handleChat(bot, ticker, 'P', 'find me iron')
    assert.equal(ctx.llmOrder, null)
    assert.ok(!ctx.taskPlanStep)
  })

  it('another owner order cancels the plan; status and chatter do not', async () => {
    const bot = mockBot()
    const ticker = tickerFor(bot)
    answer = '{"plan":[{"step":"light"}]}'
    handleChat(bot, ticker, 'P', 'light up the house')
    await flush()
    handleChat(bot, ticker, 'P', 'status')
    assert.ok(bot._tickerCtx.llmOrder)
    handleChat(bot, ticker, 'P', 'come home')
    assert.equal(bot._tickerCtx.llmOrder, null)
  })

  it('a peer bot line never reaches the model', async () => {
    const prev = process.env.BOT2_USERNAME
    process.env.BOT2_USERNAME = 'IdkBot2'
    try {
      const bot = mockBot()
      bot.players.IdkBot2 = { username: 'IdkBot2', entity: { position: pos(2, 64, 0) } }
      handleChat(bot, tickerFor(bot), 'IdkBot2', 'nothing within 48, widening the search')
      await flush()
      assert.equal(calls.length, 0)
    } finally {
      if (prev === undefined) delete process.env.BOT2_USERNAME
      else process.env.BOT2_USERNAME = prev
    }
  })

  it('a failed plan on chatter stays silent', async () => {
    const bot = mockBot()
    answer = 'not json'
    handleChat(bot, tickerFor(bot), 'P', 'what a day')
    await flush()
    assert.equal(calls.length, 1)
    assert.deepEqual(bot.lines, [])
  })

  it('a work step is pinned through taskPlanStep and advances on done', async () => {
    const bot = mockBot()
    const ticker = tickerFor(bot)
    const ctx = bot._tickerCtx
    answer = '{"plan":[{"step":"light","done":"house lit"}]}'
    handleChat(bot, ticker, 'P', 'light up the house')
    await flush()
    llmOrders.tick(bot, ctx)
    assert.equal(ctx.work, true, 'work mode on for the pinned step')
    assert.equal(ctx.taskPlanStep, 'light')
    ctx.taskPlanStep = null // decide() consumed it and picked the step
    ctx.step = 'light'
    ctx.stepStatus = 'running'
    ctx.stepGen = (ctx.stepGen | 0) + 1
    llmOrders.tick(bot, ctx)
    assert.ok(ctx.llmOrder)
    ctx.stepStatus = 'done'
    llmOrders.tick(bot, ctx)
    llmOrders.tick(bot, ctx)
    assert.equal(ctx.llmOrder, null)
    assert.ok(bot.lines.includes('done: light up the house'))
  })

  it('a pin the arbiter never takes ends the plan honestly', async () => {
    const bot = mockBot()
    const ticker = tickerFor(bot)
    const ctx = bot._tickerCtx
    answer = '{"plan":[{"step":"light"}]}'
    handleChat(bot, ticker, 'P', 'light up the house')
    await flush()
    for (let i = 0; i < 5; i++) {
      llmOrders.tick(bot, ctx)
      ctx.taskPlanStep = null // consumed, step infeasible: the menu picked something else
    }
    assert.equal(ctx.llmOrder, null)
    assert.ok(bot.lines.includes('plan stopped at light: not possible now'), String(bot.lines))
  })

  it('chatter answered with an empty plan stays silent', async () => {
    const bot = mockBot()
    handleChat(bot, tickerFor(bot), 'P', 'lol nice')
    await flush()
    assert.equal(calls.length, 1)
    assert.deepEqual(bot.lines, [])
    assert.ok(!bot._tickerCtx.llmOrder)
  })

  it('a step outside the whitelist refuses with a try: line', async () => {
    const bot = mockBot()
    answer = '{"plan":[{"step":"op_me"}]}'
    handleChat(bot, tickerFor(bot), 'P', 'plan make me op')
    await flush()
    assert.deepEqual(bot.lines, ['I can\'t plan that (no step "op_me") — try: help'])
  })

  it('an unknown bring name asks the model; no plan chats the FSM refusal', async () => {
    const bot = mockBot()
    handleChat(bot, tickerFor(bot), 'P', 'bring me 8 torches')
    assert.deepEqual(bot.lines, [], 'refusal held while the model answers')
    await flush()
    assert.equal(calls.length, 1)
    assert.deepEqual(bot.lines, ['unknown item: 8_torches'])
  })

  it('the plan\'s own refused line is not sent back to the model', async () => {
    const bot = mockBot()
    const ticker = tickerFor(bot)
    answer = '{"plan":[{"step":"bring","item":"zzz_thing","count":1}]}'
    handleChat(bot, ticker, 'P', 'bring me the thing')
    await flush()
    llmOrders.tick(bot, bot._tickerCtx)
    await flush()
    assert.equal(calls.length, 1)
    assert.ok(bot.lines.includes('unknown item: zzz_thing'), String(bot.lines))
    assert.ok(bot.lines.includes('plan stopped at bring zzz_thing 1: refused'), String(bot.lines))
    assert.equal(bot._tickerCtx.llmOrder, null)
  })

  it('stop cancels the plan', async () => {
    const bot = mockBot()
    const ticker = tickerFor(bot)
    answer = '{"plan":[{"step":"light"}]}'
    handleChat(bot, ticker, 'P', 'light up the house')
    await flush()
    assert.ok(bot._tickerCtx.llmOrder)
    handleChat(bot, ticker, 'P', 'stop')
    assert.equal(bot._tickerCtx.llmOrder, null)
  })

  it('plan <order> forces the model on a line the FSM parses', async () => {
    const bot = mockBot()
    answer = '{"plan":[{"step":"bring","item":"iron_ore","count":10}]}'
    handleChat(bot, tickerFor(bot), 'P', 'plan bring me iron_ore 10')
    await flush()
    assert.match(calls[0].messages[0].content, /"bring me iron_ore 10"/)
    assert.ok(bot.lines.includes('plan: bring iron_ore 10'))
  })

  it('a non-roster speaker never reaches the model', async () => {
    const bot = mockBot()
    handleChat(bot, tickerFor(bot), 'Stranger', 'get me a bucket of water')
    await flush()
    assert.equal(calls.length, 0)
  })
})
