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
const bring = require('../src/behaviours/bring')
const { resetLlmBudget, LLM_MODEL } = require('../src/brain')

// NOTE (6ci5.1 merged): 'bring me obsidian' in prod routes to the block
// ladder before any item rung, so the obsidian tests below prove the
// resolve->validate->attempt->morph mechanism through a directly built
// item order (the same shape a recipe step for another target takes), not
// the chat path — the chat path for obsidian itself is covered by
// bring-obsidian.test.js. The mine leg they run is the real 6ci5.1 ladder,
// not a fixture.

function pos(x, y, z) {
  const p = { x, y, z, distanceTo: (q) => Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z), clone() { return pos(p.x, p.y, p.z) } }
  return p
}

const ITEMS = {
  atlantium: 1, obsidian: 2, bucket: 3, water_bucket: 4, diamond_pickaxe: 5,
}

function mockBot(items = [], cells = null) {
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
    blockAt: (p) => {
      if (!cells || !p) return null
      const n = cells[`${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`]
      return n ? { name: n, position: pos(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)) } : null
    },
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

const RECIPE_OBSIDIAN = JSON.stringify({
  materials: [],
  steps: [{ do: 'fill', item: 'water_bucket' }, { do: 'mine', item: 'obsidian' }],
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

  it('obsidian queue runs the real mine leg with the real fill check', async () => {
    answerFor = RECIPE_OBSIDIAN
    const bot = mockBot([{ name: 'bucket', count: 1 }, { name: 'diamond_pickaxe', count: 1 }])
    const ctx = {}
    const o = { kind: 'item', name: 'obsidian', names: ['obsidian'], want: 1, by: 'P' }
    ctx.bring = o
    bringitem.enterCraftOrRefuse(bot, ctx, o)
    await flush()
    assert.equal(o.phase, 'fill', 'first step morphs through the real fill rung')
    assert.equal(o.drop, 'water_bucket')
    assert.ok(bot.lines.some((l) => l === 'recipe for obsidian 1/2: filling a bucket for you'), `step announced: ${bot.lines}`)
    // The fill lands; the return branch would drive recipeNext — call it
    // directly like the branch does.
    bot._items.push({ name: 'water_bucket', count: 1 })
    bringitem.recipeNext(bot, ctx, o)
    assert.equal(o.kind, 'block', 'mine step morphs onto the 6ci5.1 block order')
    assert.equal(o.phase, 'find')
    assert.equal(o.name, 'obsidian')
    assert.equal(o.drop, 'obsidian')
    assert.equal(ctx.bring, o, 'order stays open for the ladder')
    assert.ok(bot.lines.some((l) => l === 'recipe for obsidian 2/2: mining obsidian'), `mine announced: ${bot.lines}`)
    assert.ok(logs.some((l) => /outcome=attempt/.test(l) && /fill water_bucket,mine obsidian/.test(l)), `attempt logged: ${logs}`)
  })

  it('mine validates the obsidian name and the diamond tier', () => {
    assert.equal(bringitem.recipeCaps.mine(mockBot([{ name: 'diamond_pickaxe', count: 1 }]), {}, 'obsidian'), 'ok')
    assert.match(bringitem.recipeCaps.mine(mockBot([]), {}, 'obsidian').impossible, /diamond pickaxe/)
    assert.match(bringitem.recipeCaps.mine(mockBot([{ name: 'diamond_pickaxe', count: 1 }]), {}, 'atlantium').impossible, /no mine leg/)
  })

  it('smelt step that digs its ore resumes into the furnace', () => {
    // Queue [smelt iron_ingot]: an earlier craft left o.names behind, the
    // ore sub fills, and the resume must reach smeltRung — not refuse.
    const bot = mockBot([{ name: 'stone_pickaxe', count: 1 }])
    const ctx = {}
    const step = { do: 'smelt', item: 'iron_ingot' }
    const o = { kind: 'item', name: 'iron_ingot', names: ['X'], want: 3, by: 'P' }
    ctx.bring = o
    o.recipe = { target: 'iron_ingot', pending: false, at: Date.now(), original: 'ORIG', i: 0, queue: [step], executing: true, done: false, active: null, want: 3 }
    bringitem.recipeNext(bot, ctx, o)
    assert.deepEqual(o.names, ['iron_ingot'], 'smelt step owns the names')
    assert.ok(o.subFor, 'raw short digs the ore first')
    assert.equal(o.phase, 'find')
    // The dig lands: raw in the pack, resume like the pickup branch does.
    bot._items.push({ name: 'raw_iron', count: 2 })
    bringitem.resumeSub(bot, ctx, o)
    assert.equal(ctx.bring, o, 'no refusal after the dig')
    assert.equal(o.phase, 'smelt', 'resume reaches the furnace rung')
    assert.equal(o.smelt && o.smelt.output, 'iron_ingot')
  })

  it('gate off: a refused unknown leaves paused, lead and bring untouched', () => {
    delete process.env.BOT_LLM_ORDERS
    const bot = mockBot()
    const ticker = tickerFor(bot)
    const ctx = bot._tickerCtx
    const prior = { kind: 'block', name: 'iron_ore' }
    ctx.bring = prior
    ctx.paused = true
    ctx.lead = { kind: 'lead' }
    handleChat(bot, ticker, 'P', 'bring me atlantium')
    assert.deepEqual(bot.lines, ["can't get atlantium: no recipe, no source"])
    assert.equal(ctx.bring, prior, 'running order kept')
    assert.equal(ctx.paused, true, 'park kept')
    assert.deepEqual(ctx.lead, { kind: 'lead' }, 'lead kept')
    assert.equal(calls.length, 0)
  })

  it('queue end delivers instead of re-running the last rung', () => {
    const bot = mockBot([{ name: 'water_bucket', count: 1 }])
    const ctx = {}
    const step = { do: 'fill', item: 'water_bucket' }
    const o = { kind: 'item', name: 'water_bucket', names: ['water_bucket'], want: 1, by: 'P' }
    ctx.bring = o
    // The fill step just completed (return branch): the queue is spent.
    o.recipe = { target: 'water_bucket', pending: false, at: Date.now(), original: 'ORIG', i: 1, queue: [step], executing: true, done: false, active: step, want: 1 }
    bringitem.recipeNext(bot, ctx, o)
    assert.equal(o.phase, 'return', 'exhausted queue gives instead of stalling')
    assert.equal(o.drop, 'water_bucket')
    assert.equal(ctx.bring, o, 'order stays open for the return walk')
  })

  it('a recipe whose last step misses the target refuses naming it', async () => {
    answerFor = JSON.stringify({ materials: [], steps: [{ do: 'craft', item: 'torch' }] })
    const bot = mockBot()
    const res = await llmOrders.planRecipe(bot, {}, 'atlantium', { caps: { held: () => false, craft: () => 'ok' } })
    assert.equal(res.fail, 'mismatch')
    assert.match(res.reason, /torch.*atlantium/)
    const ctx = {}
    const o = { kind: 'item', name: 'atlantium', names: ['atlantium'], want: 1, by: 'P' }
    ctx.bring = o
    o.recipe = { target: 'atlantium', pending: false, at: Date.now(), original: 'ORIG', i: 0, queue: null, executing: false, done: false }
    bringitem.abortRecipe(bot, ctx, o, res)
    assert.equal(ctx.bring, null)
    assert.ok(bot.lines.some((l) => l === "can't get atlantium: recipe makes torch, not atlantium"), `names the mismatch: ${bot.lines}`)
  })

  it('smelt validates the dig tier, not just the name', () => {
    assert.match(bringitem.recipeCaps.smelt(mockBot([]), {}, 'iron_ingot').impossible, /stone pickaxe/)
    assert.equal(bringitem.recipeCaps.smelt(mockBot([{ name: 'raw_iron', count: 2 }]), {}, 'iron_ingot'), 'ok')
    assert.match(bringitem.recipeCaps.smelt(mockBot([]), {}, 'brick').impossible, /clay/)
    assert.match(bringitem.recipeCaps.smelt(mockBot([]), {}, 'dirt').impossible, /smeltable/)
  })

  it('craft inputs funded by earlier steps validate, unfunded abort', async () => {
    const caps = {
      held: () => false,
      gather: () => 'ok',
      craft: (b, c, item, made) => ((made.get('oak_log') || 0) >= 1 && item === 'oak_planks' ? 'ok' : { impossible: 'need oak_log' }),
    }
    answerFor = JSON.stringify({
      materials: [],
      steps: [{ do: 'gather', item: 'oak_log' }, { do: 'craft', item: 'oak_planks' }],
    })
    const funded = await llmOrders.planRecipe(mockBot(), {}, 'oak_planks', { caps })
    assert.equal(funded.fail, undefined, JSON.stringify(funded))
    assert.deepEqual(funded.queue, [{ do: 'gather', item: 'oak_log' }, { do: 'craft', item: 'oak_planks' }])
    answerFor = JSON.stringify({ materials: [], steps: [{ do: 'craft', item: 'torch' }] })
    const bare = await llmOrders.planRecipe(mockBot(), {}, 'torch', { caps })
    assert.equal(bare.fail, 'impossible')
  })

  it('wide answers refuse without a model call', () => {
    const many = ['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7']
    assert.equal(llmOrders.checkRecipeShape({ materials: many, steps: [] }).error, 'bad recipe')
  })

  it('stop before the first call cancels without a model call', async () => {
    const bot = mockBot()
    const res = await llmOrders.planRecipe(bot, {}, 'u0', { caps: { held: () => false }, alive: () => false })
    assert.equal(res.fail, 'cancelled')
    assert.equal(calls.length, 0)
  })

  it('two smelt steps each smelt once: snapshot gate plus per-step budget', () => {
    const bot = mockBot([{ name: 'stone_pickaxe', count: 1 }, { name: 'raw_iron', count: 1 }])
    const ctx = {}
    const step = { do: 'smelt', item: 'iron_ingot' }
    const o = { kind: 'item', name: 'iron_ingot', names: ['X'], want: 3, by: 'P', smeltRuns: 5 }
    ctx.bring = o
    o.recipe = { target: 'iron_ingot', pending: false, at: Date.now(), original: 'ORIG', i: 0, queue: [step, step], executing: true, done: false, active: null, activeHave: 0, want: 3 }
    // Step 1 morphs with a reset furnace budget and the step's names.
    bringitem.recipeNext(bot, ctx, o)
    assert.equal(o.smeltRuns, 0, 'each validated step gets its own furnace budget')
    assert.deepEqual(o.names, ['iron_ingot'])
    assert.equal(o.phase, 'smelt', 'raw held: straight to the furnace')
    // The furnace lands one ingot and eats the raw; the gate sees growth.
    o.smeltRuns = 1
    bot._items.splice(bot._items.findIndex((i) => i.name === 'raw_iron'), 1)
    bot._items.push({ name: 'iron_ingot', count: 1 })
    bringitem.enterCraftOrRefuse(bot, ctx, o)
    assert.equal(o.recipe.i, 2, 'growth past the snapshot advances')
    // Step 2 finds no raw, digs the ore, and must NOT advance on step 1's
    // ingot when the sub resumes — its furnace has not run yet.
    assert.equal(o.smeltRuns, 0, 'budget resets every step')
    assert.ok(o.subFor, 'raw short digs the ore first')
    assert.equal(o.phase, 'find')
    bot._items.push({ name: 'raw_iron', count: 1 })
    bringitem.resumeSub(bot, ctx, o)
    assert.equal(ctx.bring, o, 'no refusal after the dig')
    assert.equal(o.recipe.i, 2, 'no growth, no advance')
    assert.equal(o.phase, 'smelt', 'resume reaches the furnace rung')
    // The second furnace lands ingot two; the queue runs out and delivers.
    bot._items.push({ name: 'iron_ingot', count: 1 })
    bringitem.enterCraftOrRefuse(bot, ctx, o)
    assert.equal(o.phase, 'return', 'exhausted queue delivers')
    assert.ok(bot.lines.some((l) => l === 'only 2 iron_ingot, coming'), `partial give: ${bot.lines}`)
  })

  it('obsidian consent stays with explicit orders, never with recipes', () => {
    assert.equal(bring.obsidianConsented(null, null), true)
    assert.equal(bring.obsidianConsented(null, { name: 'obsidian' }), true)
    assert.equal(bring.obsidianConsented({}, { name: 'obsidian', recipe: { target: 'obsidian' } }), true)
    assert.equal(bring.obsidianConsented({}, { name: 'obsidian', recipe: { target: 'enchanting_table' } }), false)
    assert.equal(bring.obsidianConsented({ bring: { name: 'obsidian', recipe: { target: 'enchanting_table' } } }), false)
    assert.equal(bring.obsidianConsented({ bring: { name: 'obsidian', recipe: { target: 'obsidian' } } }), true)
  })

  it('bringDeny withholds the lift for a recipe-driven order', () => {
    const cells = { '2,64,0': 'obsidian', '3,64,0': 'nether_portal' }
    const bot = mockBot([], cells)
    const blk = { name: 'obsidian', position: pos(2, 64, 0) }
    const lifted = bring.bringDeny(bot, blk, {}, 'obsidian')
    const withheld = bring.bringDeny(bot, blk, { bring: { name: 'obsidian', recipe: { target: 'enchanting_table' } } }, 'obsidian')
    const never = bring.bringDeny(bot, blk, {}, 'coal')
    assert.equal(lifted, 'protected', 'control: a lit frame is protected even with consent')
    assert.equal(withheld, never, 'no lift: reads exactly like an unconsented order')
  })
})
