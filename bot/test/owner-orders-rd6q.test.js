'use strict'

// idkcraft-rd6q: OWNER_USERNAME gate + explicit reforest order.
const { describe, it, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const { createTicker, handleChat } = require('../src/index')
const llmOrders = require('../src/llm-orders')
const { nextStepGen } = require('../src/step')

function pos(x, y, z) {
  const p = {
    x, y, z,
    distanceTo: (q) => Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z),
    clone() { return pos(p.x, p.y, p.z) },
  }
  return p
}

function mockBot() {
  return {
    username: 'IdkBot',
    players: {},
    entities: {},
    health: 20,
    food: 20,
    entity: { position: pos(0, 64, 0) },
    spawnPoint: pos(0, 64, 0),
    chats: [],
    chat(m) { this.chats.push(String(m)) },
    pathfinder: { setGoal() {}, stop() {}, isMoving: () => false, setMovements() {} },
    setControlState() {},
    clearControlStates() {},
  }
}

// A bot that can see one beatable leaf cluster (daytime).
function leafyBot() {
  const bot = mockBot()
  bot.time = { timeOfDay: 6000 }
  bot.registry = { blocksByName: { oak_leaves: { id: 1 } } }
  bot.findBlocks = () => [{ x: 2, y: 64, z: 0 }]
  return bot
}

function mockBrain() {
  return { async decide() { return { action: 'follow', sprint: false, source: 'stub' } } }
}

function livePlayer(name) {
  return { username: name, entity: { id: 7, position: pos(2, 64, 0) } }
}

let prevOwner
beforeEach(() => { prevOwner = process.env.OWNER_USERNAME })
afterEach(() => {
  if (prevOwner === undefined) delete process.env.OWNER_USERNAME
  else process.env.OWNER_USERNAME = prevOwner
})

describe('owner-only orders (idkcraft-rd6q)', () => {
  it('non-owner order ignored, owner obeyed', () => {
    process.env.OWNER_USERNAME = 'LoptiFriend'
    const bot = mockBot()
    bot.players = { LoptiFriend: livePlayer('LoptiFriend'), Griefer: livePlayer('Griefer') }
    const ticker = createTicker({ bot, brain: mockBrain(), tickMs: 10, idleTickMs: 10 })
    handleChat(bot, ticker, 'Griefer', 'follow me')
    assert.deepEqual(bot.chats, [])
    assert.equal(ticker.getFollowName(), '')
    handleChat(bot, ticker, 'LoptiFriend', 'follow me')
    assert.ok(bot.chats.some((m) => m.includes('Following LoptiFriend')), `chats: ${bot.chats}`)
    assert.equal(ticker.getFollowName(), 'LoptiFriend')
  })

  it('non-owner addressed order ignored, owner addressed order obeyed', () => {
    process.env.OWNER_USERNAME = 'LoptiFriend'
    const bot = mockBot()
    bot.players = { LoptiFriend: livePlayer('LoptiFriend'), Griefer: livePlayer('Griefer') }
    const ticker = createTicker({ bot, brain: mockBrain(), tickMs: 10, idleTickMs: 10 })
    handleChat(bot, ticker, 'LoptiFriend', 'follow me')
    assert.equal(ticker.getFollowName(), 'LoptiFriend')
    bot.chats = []
    handleChat(bot, ticker, 'Griefer', 'IdkBot: stop')
    assert.deepEqual(bot.chats, [])
    assert.equal(ticker.getFollowName(), 'LoptiFriend')
    handleChat(bot, ticker, 'LoptiFriend', 'IdkBot: stop')
    assert.equal(ticker.getFollowName(), '')
  })

  it('Bedrock .Name matches the owner (case-insensitive, dot-strip)', () => {
    process.env.OWNER_USERNAME = 'LoptiFriend'
    const bot = mockBot()
    bot.players = { '.LoptiFriend': livePlayer('.LoptiFriend') }
    const ticker = createTicker({ bot, brain: mockBrain(), tickMs: 10, idleTickMs: 10 })
    handleChat(bot, ticker, 'loptifriend', 'follow me')
    assert.ok(bot.chats.some((m) => m.includes('Following .LoptiFriend')), `chats: ${bot.chats}`)
    assert.equal(ticker.getFollowName(), '.LoptiFriend')
  })

  it('unset env = everyone obeyed; empty env = everyone obeyed', () => {
    delete process.env.OWNER_USERNAME
    const bot = mockBot()
    bot.players = { Griefer: livePlayer('Griefer') }
    const ticker = createTicker({ bot, brain: mockBrain(), tickMs: 10, idleTickMs: 10 })
    handleChat(bot, ticker, 'Griefer', 'follow me')
    assert.ok(bot.chats.some((m) => m.includes('Following Griefer')), `chats: ${bot.chats}`)
    process.env.OWNER_USERNAME = ''
    const bot2 = mockBot()
    bot2.players = { Griefer: livePlayer('Griefer') }
    const ticker2 = createTicker({ bot: bot2, brain: mockBrain(), tickMs: 10, idleTickMs: 10 })
    handleChat(bot2, ticker2, 'Griefer', 'follow me')
    assert.ok(bot2.chats.some((m) => m.includes('Following Griefer')), `chats: ${bot2.chats}`)
  })

  it('non-owner reforest ignored (no plan, no chat)', () => {
    process.env.OWNER_USERNAME = 'LoptiFriend'
    const bot = leafyBot()
    bot.players = { LoptiFriend: livePlayer('LoptiFriend'), Griefer: livePlayer('Griefer') }
    const ticker = createTicker({ bot, brain: mockBrain(), tickMs: 10, idleTickMs: 10 })
    handleChat(bot, ticker, 'Griefer', 'reforest 3')
    assert.deepEqual(bot.chats, [])
    assert.ok(bot._tickerCtx.llmOrder == null)
  })
})

describe('explicit reforest order (idkcraft-rd6q)', () => {
  it('no leaves and no saplings: honest line, no plan installed', () => {
    process.env.OWNER_USERNAME = 'LoptiFriend'
    const bot = mockBot()
    bot.players = { LoptiFriend: livePlayer('LoptiFriend') }
    const ticker = createTicker({ bot, brain: mockBrain(), tickMs: 10, idleTickMs: 10 })
    handleChat(bot, ticker, 'LoptiFriend', 'reforest 3')
    assert.ok(bot.chats.some((m) => m.includes('no leaves nearby and no saplings to plant')), `chats: ${bot.chats}`)
    assert.ok(bot._tickerCtx.llmOrder == null)
  })

  it('reforest N installs a counted plan; one done cycle decrements; owner stop cancels', () => {
    process.env.OWNER_USERNAME = 'LoptiFriend'
    const bot = leafyBot()
    bot.players = { LoptiFriend: livePlayer('LoptiFriend') }
    const ticker = createTicker({ bot, brain: mockBrain(), tickMs: 10, idleTickMs: 10 })
    const ctx = bot._tickerCtx
    handleChat(bot, ticker, 'LoptiFriend', 'reforest 3')
    assert.ok(bot.chats.some((m) => m.includes('reforesting x3')), `chats: ${bot.chats}`)
    assert.ok(ctx.llmOrder, 'plan should be installed')
    assert.equal(ctx.llmOrder.steps[0].step, 'reforest')
    assert.equal(ctx.llmOrder.steps[0].count, 3)
    assert.equal(ctx.llmOrder.explicit, true)
    // First executive tick pins the work step (no model call anywhere).
    llmOrders.tick(bot, ctx)
    assert.equal(ctx.taskPlanStep, 'reforest')
    // One finished cycle re-pins with the decremented count (counter semantics).
    nextStepGen(ctx)
    ctx.step = 'reforest'
    ctx.stepStatus = 'done'
    llmOrders.tick(bot, ctx)
    assert.equal(ctx.llmOrder.steps[0].count, 2)
    assert.ok(ctx.llmOrder, 'plan should still be running after 1 of 3')
    // Generic cancel-branch interplay: the owner stop ends the plan.
    handleChat(bot, ticker, 'LoptiFriend', 'stop')
    assert.ok(ctx.llmOrder == null)
  })

  it('bare reforest installs a single run', () => {
    process.env.OWNER_USERNAME = 'LoptiFriend'
    const bot = leafyBot()
    bot.players = { LoptiFriend: livePlayer('LoptiFriend') }
    const ticker = createTicker({ bot, brain: mockBrain(), tickMs: 10, idleTickMs: 10 })
    handleChat(bot, ticker, 'LoptiFriend', 'reforest')
    assert.ok(bot.chats.some((m) => m.includes('reforesting')), `chats: ${bot.chats}`)
    const o = bot._tickerCtx.llmOrder
    assert.ok(o, 'plan should be installed')
    assert.equal(o.steps[0].step, 'reforest')
    assert.equal(o.steps[0].count, undefined)
  })

  it('out-of-range count refuses with the try line', () => {
    process.env.OWNER_USERNAME = 'LoptiFriend'
    const bot = leafyBot()
    bot.players = { LoptiFriend: livePlayer('LoptiFriend') }
    const ticker = createTicker({ bot, brain: mockBrain(), tickMs: 10, idleTickMs: 10 })
    handleChat(bot, ticker, 'LoptiFriend', 'reforest 999')
    assert.ok(bot.chats.some((m) => m.includes('try: reforest 10')), `chats: ${bot.chats}`)
    assert.ok(bot._tickerCtx.llmOrder == null)
  })
})
