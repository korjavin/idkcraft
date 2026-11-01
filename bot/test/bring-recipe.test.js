'use strict'

// LLM acquisition-recipe fallback (idkcraft-6ci5.2): the refusal branch asks
// the model once per level for a ladder-runnable recipe, validates every
// step before starting, recurses for unknown materials to depth 5, and
// attempts a validated recipe instead of instant-refusing. Fake fetch only
// (the llm-orders.test.js Messages-API shape); drop-capability probes stay
// live except where a test patches recipeCaps (restored after).

const { describe, it, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const { handleChat, createTicker } = require('../src/index')
const llmOrders = require('../src/llm-orders')
const bringitem = require('../src/behaviours/bringitem')
const { resetLlmBudget, LLM_MODEL } = require('../src/brain')

function pos(x, y, z) {
  const p = { x, y, z, distanceTo: (q) => Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z), clone() { return pos(p.x, p.y, p.z) } }
  return p
}

const ITEMS = {
  atlantium: 1, obsidian: 2, bucket: 3, water_bucket: 4, diamond_pickaxe: 5,
}

function mockBot(items = []) {
  const lines = []
  const itemsByName = {}
  for (const [name, id] of Object.entries(ITEMS)) itemsByName[name] = { id }
  const bot = {
    lines,
    username: 'IdkBot',
    entities: {},
    health: 20,
    food: 20,
    entity: { position: pos(0, 64, 0), onGround: true },
    registry: { blocksByName: {}, itemsByName },
    players: { P: { username: 'P', entity: { position: pos(1, 64, 0) } } },
    pathfinder: { goal: null, setGoal: () => {}, isMoving: () => false },
    _items: items,
    inventory: { items: () => bot._items },
    findBlocks: () => [],
    blockAt: () => null,
    toss: async () => {},
    chat(line) { lines.push(String(line)) },
  }
  return bot
}

function tickerFor(bot) {
  return createTicker({ bot, brain: { decide: async () => ({ action: 'idle', sprint: false, source: 'stub' }) }, tickMs: 10, idleTickMs: 10 })
}

const flush = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)) }

function msg(text, usage) {
  return {
    ok: true,
    json: async () => ({
      id: 'msg_x', type: 'message', role: 'assistant', model: LLM_MODEL,
      content: [{ type: 'text', text }],
      stop_reason: 'end_turn', usage: usage || { input_tokens: 10, output_tokens: 10 },
    }),
  }
}

let saved
let calls
let answerFor
let logs
let origFetch
let origLog
let origCaps
beforeEach(() => {
  saved = { on: process.env.BOT_LLM_ORDERS, key: process.env.ANTHROPIC_API_KEY }
  process.env.BOT_LLM_ORDERS = '1'
  process.env.ANTHROPIC_API_KEY = 'test-key'
  resetLlmBudget()
  calls = []
  answerFor = null
  logs = []
  origFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body)
    const text = body.messages[0].content
    const m = /bring me ([a-z0-9_]+)/.exec(text)
    calls.push(m ? m[1] : '?')
    return msg(typeof answerFor === 'function' ? answerFor(m ? m[1] : '?') : answerFor)
  }
  origLog = console.log
  console.log = (line) => { logs.push(String(line)) }
  origCaps = { ...bringitem.recipeCaps }
  bringitem.setRecipeSource({
    plan: (bot, ctx, target, opts) => llmOrders.planRecipe(bot, ctx, target, opts),
    timeoutMs: llmOrders.RECIPE_TIMEOUT_MS,
    enabled: () => llmOrders.enabled(),
  })
})
afterEach(() => {
  globalThis.fetch = origFetch
  console.log = origLog
  Object.assign(bringitem.recipeCaps, origCaps)
  bringitem.setRecipeSource(null)
  resetLlmBudget()
  for (const [k, v] of [['BOT_LLM_ORDERS', saved.on], ['ANTHROPIC_API_KEY', saved.key]]) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
})

const RECIPE_FILL_MINE = JSON.stringify({
  materials: [],
  steps: [{ do: 'fill', item: 'water_bucket' }, { do: 'mine', item: 'atlantium' }],
})

describe('recipe fallback: refusal sites', () => {
  it('chat-time: asks the model instead of instant-refuse, then aborts naming the impossible step', async () => {
    answerFor = RECIPE_FILL_MINE
    const bot = mockBot([{ name: 'bucket', count: 1 }])
    const ticker = tickerFor(bot)
    handleChat(bot, ticker, 'P', 'bring me atlantium')
    assert.equal(bot.lines[0], 'no recipe for atlantium — asking how to get it…')
    const ctx = bot._tickerCtx
    assert.ok(ctx.bring && ctx.bring.phase === 'recipe')
    await flush()
    assert.equal(calls.length, 1, 'exactly one model call for the refusal')
    assert.equal(calls[0], 'atlantium')
    assert.equal(ctx.bring, null, 'aborted, no lingering order')
    assert.ok(bot.lines.some((l) => l === "can't get atlantium: recipe needs mine atlantium (no mine leg)"), `abort names the step: ${bot.lines}`)
    assert.ok(!bot.lines.some((l) => /no recipe, no source/.test(l)), 'original refusal replaced')
    assert.ok(!bot.lines.some((l) => /^recipe for /.test(l)), 'validate-before-start: the valid fill step never ran')
  })

  it('tick-time: a chest-exhausted order falls back, then aborts naming the step', async () => {
    answerFor = RECIPE_FILL_MINE
    const bot = mockBot([{ name: 'bucket', count: 1 }])
    const ctx = {}
    const o = { kind: 'item', name: 'atlantium', names: ['atlantium'], want: 1, by: 'P' }
    ctx.bring = o
    bringitem.enterCraftOrRefuse(bot, ctx, o)
    assert.ok(bot.lines.some((l) => l === 'no recipe for atlantium — asking how to get it…'))
    assert.equal(o.phase, 'recipe')
    await flush()
    assert.equal(calls.length, 1)
    assert.equal(ctx.bring, null)
    assert.ok(bot.lines.some((l) => l === "can't get atlantium: recipe needs mine atlantium (no mine leg)"), `abort names the step: ${bot.lines}`)
  })

  it('flag off: the instant refusal stands and no model call fires', () => {
    delete process.env.BOT_LLM_ORDERS
    const bot = mockBot()
    const ticker = tickerFor(bot)
    handleChat(bot, ticker, 'P', 'bring me atlantium')
    assert.deepEqual(bot.lines, ["can't get atlantium: no recipe, no source"])
    assert.equal(calls.length, 0)
    assert.ok(!bot._tickerCtx.bring)
  })

  it('garbage model answer degrades to the original refusal', async () => {
    answerFor = 'lorem ipsum, no braces here'
    const bot = mockBot()
    const ctx = {}
    const o = { kind: 'item', name: 'atlantium', names: ['atlantium'], want: 1, by: 'P' }
    ctx.bring = o
    bringitem.enterCraftOrRefuse(bot, ctx, o)
    await flush()
    assert.equal(calls.length, 1)
    assert.equal(ctx.bring, null)
    assert.ok(bot.lines.includes("can't get atlantium: no recipe, no source"), `degrades cleanly: ${bot.lines}`)
  })
})

describe('recipe resolve: recursion', () => {
  it('unknown materials recurse to depth 5 and refuse with the logged chain', async () => {
    answerFor = (t) => {
      const n = Number(t.slice(1))
      return JSON.stringify({ materials: [`u${n + 1}`], steps: [] })
    }
    const bot = mockBot()
    const res = await llmOrders.planRecipe(bot, {}, 'u0', { caps: { held: () => false } })
    assert.equal(res.fail, 'depth')
    assert.deepEqual(res.chain, ['u0', 'u1', 'u2', 'u3', 'u4', 'u5'])
    assert.equal(calls.length, 5, 'u0..u4 each cost one call; u5 refuses without a call')
    assert.deepEqual(calls, ['u0', 'u1', 'u2', 'u3', 'u4'])
    assert.ok(logs.some((l) => l.includes('chain=u0>u1>u2>u3>u4>u5')), `chain logged: ${logs}`)
  })

  it('a material cycle refuses without another call', async () => {
    answerFor = JSON.stringify({ materials: ['loopo'], steps: [] })
    const bot = mockBot()
    const res = await llmOrders.planRecipe(bot, {}, 'loopo', { caps: { held: () => false } })
    assert.equal(res.fail, 'cycle')
    assert.deepEqual(res.chain, ['loopo', 'loopo'])
    assert.equal(calls.length, 1)
  })
})

describe('recipe execution', () => {
  it('a validated obsidian recipe attempts instead of instant-refusing', async () => {
    answerFor = JSON.stringify({
      materials: [],
      steps: [
        { do: 'craft', item: 'diamond_pickaxe' },
        { do: 'fill', item: 'water_bucket' },
        { do: 'mine', item: 'obsidian' },
      ],
    })
    for (const k of Object.keys(bringitem.recipeCaps)) bringitem.recipeCaps[k] = () => 'ok'
    bringitem.recipeCaps.held = () => true
    const bot = mockBot([{ name: 'bucket', count: 1 }])
    const ctx = {}
    const o = { kind: 'item', name: 'obsidian', names: ['obsidian'], want: 1, by: 'P' }
    ctx.bring = o
    bringitem.enterCraftOrRefuse(bot, ctx, o)
    await flush()
    assert.equal(calls.length, 1)
    assert.equal(ctx.bring, o, 'order stays open on the recipe')
    assert.equal(o.phase, 'craft', 'first validated step morphs the order')
    assert.equal(o.craftTarget, 'diamond_pickaxe')
    assert.ok(bot.lines.some((l) => l === 'recipe for obsidian 1/3: making diamond_pickaxe'), `attempt announced: ${bot.lines}`)
    assert.ok(!bot.lines.some((l) => /no recipe, no source/.test(l)), 'no instant refusal')
    assert.ok(logs.some((l) => /outcome=attempt/.test(l) && /craft diamond_pickaxe/.test(l)), `attempt logged: ${logs}`)
  })

  it('stop mid-recipe drops the late answer silently', async () => {
    let release = null
    globalThis.fetch = () => new Promise((r) => { release = r })
    const bot = mockBot()
    const ctx = {}
    const o = { kind: 'item', name: 'atlantium', names: ['atlantium'], want: 1, by: 'P' }
    ctx.bring = o
    bringitem.enterCraftOrRefuse(bot, ctx, o)
    assert.ok(bot.lines.some((l) => l === 'no recipe for atlantium — asking how to get it…'))
    ctx.bring = null // stop clears the order while the model call is in flight
    release(msg(RECIPE_FILL_MINE))
    await flush()
    assert.deepEqual(bot.lines, ['no recipe for atlantium — asking how to get it…'], 'late answer chats nothing')
    assert.equal(ctx.bring, null)
  })

  it('recipe wait times out to the original refusal', () => {
    const bot = mockBot()
    const ctx = {}
    const o = { kind: 'item', name: 'atlantium', names: ['atlantium'], want: 1, by: 'P' }
    ctx.bring = o
    o.phase = 'recipe'
    o.recipe = { target: 'atlantium', pending: true, at: Date.now() - 30000, original: "can't get atlantium: no recipe, no source", i: 0, queue: null, executing: false, done: false }
    bringitem.recipeTick(bot, ctx, o)
    assert.equal(ctx.bring, null)
    assert.deepEqual(bot.lines, ["can't get atlantium: no recipe, no source"])
  })
})
