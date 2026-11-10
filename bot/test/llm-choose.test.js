'use strict'

// LLM activity chooser (idkcraft-qxql.10): at a nothing-useful FSM pick the
// bot asks the model for 1-3 steps of useful work. Fake fetch only.

const { describe, it, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const { handleChat, createTicker } = require('../src/index')
const llmOrders = require('../src/llm-orders')
const goal = require('../src/goal')
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
    answer = '{"plan":[{"step":"gather","done":"wood held"}],"why":"empty kit","need":""}'
    const fired = llmOrders.ask(bot, ctx, { text: 'choose work: no-order', by: 'self', ticker: null, feed: null, fallback: null, explicit: false, choose: { regime: 'no-order', trigger: 'idle' } })
    assert.ok(fired)
    await flush()
    assert.ok(ctx.llmOrder)
    assert.equal(ctx.llmOrder.by, 'self')
    assert.ok(logs.some((l) => l.startsWith('llm choose regime=no-order trigger=idle outcome=ok plan=gather')), JSON.stringify(logs))
    assert.ok(bot.lines.includes('plan: gather'), 'roster player P online: chats')
  })
  it('logs only with nobody online', async () => {
    const { bot, ctx } = ctxWith(true)
    bot.players = {}
    answer = '{"plan":[{"step":"gather"}],"why":"empty kit","need":""}'
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
  it('http error logs the reason in err (bv9x: prod attribution)', async () => {
    const { bot, ctx } = ctxWith(true)
    globalThis.fetch = async () => ({ ok: false, status: 401 })
    llmOrders.ask(bot, ctx, { text: 'choose work: no-order', by: 'self', ticker: null, feed: null, fallback: null, explicit: false, choose: { regime: 'no-order', trigger: 'idle' } })
    await flush()
    assert.ok(!ctx.llmOrder, 'no plan on error: FSM pick stands')
    const line = logs.find((l) => l.startsWith('llm choose regime=no-order'))
    assert.ok(line, JSON.stringify(logs))
    assert.ok(line.includes('outcome=error'), line)
    assert.ok(line.includes('tokens=0/0'), line)
    assert.ok(line.includes('err="llm http 401"'), line)
  })
  it('stop cancels a chooser plan and go work does not immediate re-ask', async () => {
    const { bot, ctx, ticker } = ctxWith(true)
    answer = '{"plan":[{"step":"gather"}],"why":"empty kit","need":""}'
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

function choose(bot, ctx) {
  return llmOrders.ask(bot, ctx, { text: 'choose work: no-order', by: 'self', explicit: false, choose: { regime: 'no-order', trigger: 'idle' } })
}

// Loaded fake world, real goalFacts and MENU predicates. A v1 home owes
// no bedroom beds; its torch ring is lit and there is no chest to adopt.
function finishedHome() {
  const world = ctxWith(true)
  world.bot.time = { timeOfDay: 6000 }
  const light = require('../src/behaviours/light')
  world.bot.blockAt = () => ({ name: 'air' })
  world.bot.findBlocks = () => []
  world.ctx.home = { site: pos(0, 64, 0), built: true, v: 1 }
  const spots = light.spotsFor(world.ctx.home).map((spot) => pos(spot.dx, 64 + (spot.dy || 0), spot.dz))
  world.bot.blockAt = (p) => ({ name: spots.some((s) => s.x === p.x && s.y === p.y && s.z === p.z) ? 'torch' : p.y < 64 ? 'dirt' : 'air' })
  return world
}

describe('chooser shared startability contract', () => {
  for (const step of ['beds', 'stockpile', 'gear', 'light']) {
    it(`rejects a known-infeasible ${step} before installing or pinning`, async () => {
      const { bot, ctx } = finishedHome()
      const facts = goal.goalFacts(bot, ctx)
      assert.equal(facts.beds, 'both')
      assert.equal(facts.gear, 'done')
      assert.equal(facts.unlit, 0)
      assert.equal(facts.chestTodo, 'none')
      assert.equal(goal.MENU[step].feasible(facts, bot, ctx), false)
      answer = JSON.stringify({ plan: [{ step }] })
      await choose(bot, ctx)
      assert.ok(!ctx.llmOrder, 'impossible answer is never admitted')
      for (let i = 0; i < 5; i++) llmOrders.tick(bot, ctx)
      assert.ok(!ctx.taskPlanStep, 'no futile pin/re-pin')
      assert.equal(calls.length, 1)
      const prompt = calls[0].messages[0].content
      assert.match(prompt, /beds=both/)
      assert.match(prompt, /gear=done/)
      assert.match(prompt, /unlit=none/)
      assert.match(prompt, /chest=no/)
      assert.match(prompt, /chestTodo=none/)
      assert.match(prompt, new RegExp(`${step}: .*can begin now with count=1: no`))
      assert.ok(logs.some((l) => l.includes('outcome=invalid') && l.includes(`cannot start ${step}`)))
      assert.ok(!logs.some((l) => l.includes('outcome=ok')))
      assert.equal(llmOrders.shouldChoose('idle', ctx, facts), false, 'normal pacing survives rejection')
      assert.equal(ctx.llmChooseWait, llmOrders.chooseMinMs() * 2, 'failed-plan backoff survives rejection')
    })
  }

  it('backs repeated semantic rejections off to the existing 30-minute cap', async () => {
    const { bot, ctx } = finishedHome()
    answer = '{"plan":[{"step":"beds"}]}'
    for (const wait of [600000, 1200000, 1800000, 1800000]) {
      await choose(bot, ctx)
      assert.equal(ctx.llmChooseWait, wait)
      assert.equal(llmOrders.shouldChoose('idle', ctx, goal.goalFacts(bot, ctx), ctx.llmChooseAt + wait - 1), false)
      assert.equal(llmOrders.shouldChoose('idle', ctx, goal.goalFacts(bot, ctx), ctx.llmChooseAt + wait), true)
      assert.ok(!ctx.llmOrder)
    }
    assert.equal(calls.length, 4, 'one call per ask, no synthesized retry')
  })

  it('rejects impossible answers during a sticky daytime stay instead of treating it as night', async () => {
    const { bot, ctx } = finishedHome()
    ctx.step = 'stay'
    ctx.stepStatus = 'running'
    ctx.stay = { phase: 'hold' }
    assert.equal(llmOrders.shouldChoose('stay', ctx, goal.goalFacts(bot, ctx)), true)
    answer = '{"plan":[{"step":"beds"}]}'
    await choose(bot, ctx)
    assert.ok(!ctx.llmOrder)
    assert.ok(!ctx.taskPlanStep)
    assert.ok(logs.some((l) => l.includes('outcome=invalid')))
  })

  it('starts a feasible prerequisite through the real pin path without filtering its infeasible tail', async () => {
    const { bot, ctx } = ctxWith(true)
    assert.equal(goal.MENU.craft.feasible(goal.goalFacts(bot, ctx), bot, ctx), false)
    answer = '{"plan":[{"step":"gather"},{"step":"craft"}]}'
    await choose(bot, ctx)
    assert.deepEqual(ctx.llmOrder.steps.map((s) => s.step), ['gather', 'craft'])
    llmOrders.tick(bot, ctx)
    assert.equal(ctx.taskPlanStep, 'gather')
    await goal.decide(bot, ctx)
    assert.equal(ctx.step, 'gather', 'shared arbiter applies the plan pin')
    assert.equal(ctx.stepPick.source, 'task-plan')
    // The gather prerequisite supplies the batch that makes craft possible.
    bot.inventory.items = () => [{ name: 'oak_log', count: 14 }]
    assert.equal(goal.MENU.craft.feasible(goal.goalFacts(bot, ctx), bot, ctx), true)
  })

  it('normalizes empty-kit build before admission and installs that same expansion', async () => {
    const { bot, ctx } = ctxWith(true)
    assert.equal(goal.MENU.build.feasible(goal.goalFacts(bot, ctx), bot, ctx), false)
    answer = '{"plan":[{"step":"build"}]}'
    await choose(bot, ctx)
    assert.deepEqual(ctx.llmOrder.steps.map((s) => s.step), ['gather', 'craft', 'equip', 'build'])
    llmOrders.tick(bot, ctx)
    await goal.decide(bot, ctx)
    assert.equal(ctx.step, 'gather')
  })

  it('admits pin-only bank without changing live pins or ownership while evaluating the catalog', async () => {
    const { bot, ctx } = ctxWith(true)
    bot.inventory.items = () => [{ name: 'cobblestone', count: 100 }]
    bot.registry.blocksByName.chest = { id: 7 }
    bot.blockAt = () => ({ name: 'chest' })
    bot.findBlocks = () => [pos(0, 64, 0)]
    ctx.castle = { site: pos(0, 64, 0), phase: 'complete' }
    const before = { pin: ctx.taskPlanStep, args: ctx.taskPlanArgs, order: ctx.llmOrder, step: ctx.step }
    const catalog = llmOrders.chooseStepList(bot, ctx)
    assert.match(catalog, /bank: .*can begin now with count=1: yes/)
    assert.deepEqual({ pin: ctx.taskPlanStep, args: ctx.taskPlanArgs, order: ctx.llmOrder, step: ctx.step }, before)
    assert.equal(goal.MENU.bank.feasible(goal.goalFacts(bot, ctx), bot, ctx), false, 'without candidate overlay bank needs a pin')
    answer = '{"plan":[{"step":"bank"}]}'
    await choose(bot, ctx)
    assert.ok(ctx.llmOrder)
    llmOrders.tick(bot, ctx)
    await goal.decide(bot, ctx)
    assert.equal(ctx.step, 'bank')
  })

  it('revalidates world changes during the async call', async () => {
    const { bot, ctx } = ctxWith(true)
    let reply
    const fetch = globalThis.fetch
    globalThis.fetch = async (...args) => { await new Promise((r) => { reply = r }); return fetch(...args) }
    answer = '{"plan":[{"step":"gather"}]}'
    const pending = choose(bot, ctx)
    assert.equal(goal.MENU.gather.feasible(goal.goalFacts(bot, ctx), bot, ctx), true)
    ctx.home = { built: true, v: 1 }
    reply()
    await pending
    assert.ok(!ctx.llmOrder)
    assert.ok(logs.some((l) => l.includes('outcome=invalid')))
  })

  it('ends boundedly without pinning if facts change between admission and start', async () => {
    const { bot, ctx } = ctxWith(true)
    answer = '{"plan":[{"step":"gather"}]}'
    await choose(bot, ctx)
    assert.ok(ctx.llmOrder)
    ctx.home = { built: true, v: 1 }
    llmOrders.tick(bot, ctx)
    assert.equal(ctx.llmOrder, null)
    assert.ok(!ctx.taskPlanStep)
    assert.equal(calls.length, 1)
    assert.ok(!logs.some((l) => l.includes('result=done')))
    assert.equal(ctx.llmChooseWait, llmOrders.chooseMinMs() * 2)
  })

  it('defers an answer arriving at night, then rechecks before the daylight pin', async () => {
    const { bot, ctx } = ctxWith(true)
    let reply
    const fetch = globalThis.fetch
    globalThis.fetch = async (...args) => { await new Promise((r) => { reply = r }); return fetch(...args) }
    answer = '{"plan":[{"step":"gather"}]}'
    const pending = choose(bot, ctx)
    bot.time = { timeOfDay: 18000 }
    ctx.step = 'shelter'
    ctx.stepStatus = 'running'
    reply()
    await pending
    assert.ok(ctx.llmOrder, 'night is a defer, not semantic rejection')
    llmOrders.tick(bot, ctx)
    assert.ok(!ctx.taskPlanStep)
    assert.equal(ctx.llmOrder.cur, null)
    bot.time.timeOfDay = 6000
    ctx.step = 'rest'
    llmOrders.tick(bot, ctx)
    assert.equal(ctx.taskPlanStep, 'gather')
    assert.equal(calls.length, 1)
  })

  it('keeps the three-miss backstop when a predicate changes after pinning', async () => {
    const { bot, ctx } = ctxWith(true)
    answer = '{"plan":[{"step":"gather"}]}'
    await choose(bot, ctx)
    llmOrders.tick(bot, ctx)
    assert.equal(ctx.taskPlanStep, 'gather')
    ctx.home = { built: true, v: 1 }
    for (let i = 0; i < 3; i++) {
      ctx.taskPlanStep = null // final arbiter refused the now-stale pin
      llmOrders.tick(bot, ctx)
    }
    assert.equal(ctx.llmOrder, null)
    assert.ok(!ctx.taskPlanStep)
  })

  for (const command of ['stop', 'follow me', 'do light']) {
    it(`drops the delayed answer after owner ${command}`, async () => {
      const { bot, ctx, ticker } = ctxWith(true)
      let reply
      const fetch = globalThis.fetch
      globalThis.fetch = async (...args) => { await new Promise((r) => { reply = r }); return fetch(...args) }
      answer = '{"plan":[{"step":"gather"}]}'
      const pending = choose(bot, ctx)
      handleChat(bot, ticker, 'P', command)
      const replacement = ctx.llmOrder
      reply()
      await pending
      assert.equal(ctx.llmOrder, replacement)
      assert.ok(!logs.some((l) => l.startsWith('llm choose') && l.includes('outcome=ok')))
    })
  }

  it('explicit player plans retain their refusal/pin semantics', async () => {
    const { bot, ctx } = finishedHome()
    process.env.BOT_LLM_ORDERS = '1'
    answer = '{"plan":[{"step":"beds"}]}'
    await llmOrders.ask(bot, ctx, { text: 'make beds', by: 'P', explicit: true })
    assert.ok(ctx.llmOrder)
    llmOrders.tick(bot, ctx)
    assert.equal(ctx.taskPlanStep, 'beds', 'explicit order admission remains shape-only')
  })

  it('keeps an empty startable menu on the ordinary fallback/cooldown', async () => {
    const { bot, ctx } = finishedHome()
    ctx.home.parked = true
    // A remembered tree: not wood-starved, so the park still vetoes explore.
    ctx.resources = { items: new Map([['t', { name: 'oak_log', x: 5000, y: 64, z: 5000 }]]) }
    const catalog = llmOrders.chooseStepList(bot, ctx)
    assert.ok(!catalog.includes('count=1: yes'), catalog)
    answer = '{"plan":[]}'
    await choose(bot, ctx)
    assert.ok(!ctx.llmOrder)
    for (let i = 0; i < 10; i++) {
      llmOrders.tick(bot, ctx)
      assert.equal(llmOrders.shouldChoose('idle', ctx, goal.goalFacts(bot, ctx)), false)
    }
    assert.equal(calls.length, 1)
    assert.ok(!ctx.taskPlanStep)
  })

  it('evaluates an injected promoted skill with its candidate count, preserving enable/ban gates', async (t) => {
    const fs = require('node:fs')
    const os = require('node:os')
    const path = require('node:path')
    const skills = require('../src/skills')
    const { BEHAVIOURS } = require('../src/behaviours')
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chooser-skill-'))
    const previous = process.env.BOT_SKILLS
    t.after(() => {
      fs.rmSync(dir, { recursive: true, force: true })
      if (previous === undefined) delete process.env.BOT_SKILLS
      else process.env.BOT_SKILLS = previous
    })
    fs.writeFileSync(path.join(dir, 'chooser_fixture.js'), '/* skill {"name":"chooser_fixture","description":"ordered count fixture","kind":"step","body":"any"} */\nfunction feasible(facts) { return facts.pinned === "chooser_fixture" && facts.pinCount === 3 }\nfunction run() { return "failed:fixture" }\n')
    process.env.BOT_SKILLS = '1'
    skills.load({ BOT_SKILLS: '1' }, { force: true, promotedDir: dir })
    const { bot, ctx } = ctxWith(true)
    const order = { explicit: true, steps: [{ step: 'light' }], i: 0 }
    const args = { step: 'light', count: 8, by: 'P' }
    ctx.llmOrder = order
    ctx.taskPlanStep = 'light'
    ctx.taskPlanArgs = args
    const ownedStep = ctx.step
    const catalog = llmOrders.chooseStepList(bot, ctx)
    assert.match(catalog, /chooser_fixture: .*count=1: no/)
    assert.equal(ctx.llmOrder, order)
    assert.equal(ctx.taskPlanArgs, args)
    assert.equal(ctx.taskPlanStep, 'light')
    assert.equal(ctx.step, ownedStep)
    assert.equal(order.explicit, true)
    ctx.llmOrder = null
    ctx.taskPlanStep = null
    ctx.taskPlanArgs = null
    answer = '{"plan":[{"step":"chooser_fixture","count":3}]}'
    await choose(bot, ctx)
    assert.ok(ctx.llmOrder, 'candidate overlay supplies count=3')
    llmOrders.tick(bot, ctx)
    await goal.decide(bot, ctx)
    assert.equal(ctx.step, 'chooser_fixture')
    assert.equal(ctx.taskPlanArgs.count, 3)
    llmOrders.cancel(ctx)
    process.env.BOT_SKILLS = '0'
    assert.ok(!llmOrders.workSteps().includes('chooser_fixture'))
    process.env.BOT_SKILLS = '1'
    await choose(bot, ctx)
    process.env.BOT_SKILLS = '0'
    llmOrders.tick(bot, ctx)
    assert.ok(!ctx.llmOrder, 'disabling a skill before start prevents a pin')
    assert.ok(!ctx.taskPlanStep)
    process.env.BOT_SKILLS = '1'
    for (let i = 0; i < skills.BAN_FAILS; i++) {
      ctx.stepGen = (ctx.stepGen || 0) + 1
      BEHAVIOURS.chooser_fixture(bot, ctx)
    }
    assert.equal(goal.MENU.chooser_fixture.feasible({ pinned: 'chooser_fixture', pinCount: 3 }), false)
    await choose(bot, ctx)
    assert.ok(!ctx.llmOrder, 'banned registered skill is never admitted')
  })
})
