'use strict'

// Brain switch command (idkcraft-d75): 'brain laya' | 'brain jev' |
// 'brain off' | 'brain'. Each switch changes the source of the next hard
// decision; jev without a key and strangers change nothing.

const { describe, it, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const { createTicker, handleChat } = require('../src/index')
const { stubBrain } = require('../src/brain')

function pos(x, y, z) {
  const p = {
    x, y, z,
    distanceTo: (q) => Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z),
    clone() { return pos(p.x, p.y, p.z) },
  }
  return p
}

function hardBot() {
  const bot = {
    username: 'IdkBot',
    players: { Owner: { username: 'Owner', entity: { id: 7, position: pos(10, 64, 0) } } },
    entities: {},
    health: 5, // H1 low-health-hostile needs health < 6 plus a hostile fact
    food: 20,
    entity: { position: pos(0, 64, 0) },
    spawnPoint: pos(0, 64, 0),
    chats: [],
    chat(m) { this.chats.push(String(m)) },
    attackCalls: 0,
    attack() { this.attackCalls++ },
    lookAt() {},
    pathfinder: {
      goal: null,
      setGoal(g) { this.goal = g },
      stop() {},
      isMoving: () => false,
      setMovements() {},
    },
    setControlState() {},
    clearControlStates() {},
    _items: [],
    inventory: null,
    equip: async () => {},
  }
  const zp = pos(5, 64, 0)
  bot.entities = { 1: { id: 1, name: 'zombie', type: 'mob', position: zp, height: 1.95 } }
  bot.inventory = { items: () => bot._items }
  return bot
}

function cannedFetch(choice) {
  return async () => ({
    ok: true,
    json: async () => ({ answers: { action: { type: 'choice', choice } } }),
  })
}

describe("brain switch (idkcraft-d75)", () => {
  let savedEnv
  let savedFetch
  beforeEach(() => {
    savedEnv = { BRAIN_URL: process.env.BRAIN_URL, TYPESAFE_API_KEY: process.env.TYPESAFE_API_KEY }
    process.env.BRAIN_URL = 'http://laya:8000/v1/systemone'
    process.env.TYPESAFE_API_KEY = 'test-key'
    savedFetch = globalThis.fetch
    globalThis.fetch = cannedFetch('follow')
  })
  afterEach(() => {
    if (savedEnv.BRAIN_URL === undefined) delete process.env.BRAIN_URL
    else process.env.BRAIN_URL = savedEnv.BRAIN_URL
    if (savedEnv.TYPESAFE_API_KEY === undefined) delete process.env.TYPESAFE_API_KEY
    else process.env.TYPESAFE_API_KEY = savedEnv.TYPESAFE_API_KEY
    globalThis.fetch = savedFetch
  })

  function followedTicker(bot) {
    return createTicker({ bot, brain: stubBrain, tickMs: 10, idleTickMs: 10, followName: 'Owner', brainEngine: 'off' })
  }

  it("each switch changes the source of the next hard decision", async () => {
    const bot = hardBot()
    const ticker = followedTicker(bot)
    // The ticker dedups identical states, so move the player a step before
    // each tick; the H1 hard state (zombie at 5, health 5) holds throughout.
    let x = 10
    const step = async () => { bot.players.Owner.entity.position = pos(x++, 64, 0); return (await ticker.tick()).decision.source }
    assert.equal(await step(), 'stub')
    handleChat(bot, ticker, 'Owner', 'brain laya')
    assert.ok(bot.chats.some((m) => m === 'brain: laya'), `chats: ${bot.chats}`)
    assert.equal(await step(), 'laya')
    handleChat(bot, ticker, 'Owner', 'brain jev')
    assert.ok(bot.chats.some((m) => m === 'brain: jev'))
    assert.equal(await step(), 'jev')
    handleChat(bot, ticker, 'Owner', 'brain off')
    assert.ok(bot.chats.some((m) => m === 'brain: off'))
    assert.equal(await step(), 'stub')
  })

  it("'brain' reports the current engine", () => {
    const bot = hardBot()
    const ticker = followedTicker(bot)
    handleChat(bot, ticker, 'Owner', 'brain')
    assert.deepEqual(bot.chats, ['brain: off'])
    handleChat(bot, ticker, 'Owner', 'brain laya')
    handleChat(bot, ticker, 'Owner', 'brain')
    assert.deepEqual(bot.chats, ['brain: off', 'brain: laya', 'brain: laya'])
  })

  it("'brain jev' without a key changes nothing", async () => {
    delete process.env.TYPESAFE_API_KEY
    const bot = hardBot()
    const ticker = followedTicker(bot)
    handleChat(bot, ticker, 'Owner', 'brain jev')
    assert.deepEqual(bot.chats, ['jev: no api key'])
    assert.equal(ticker.getBrainEngine(), 'off')
    assert.equal((await ticker.tick()).decision.source, 'stub')
  })

  it("work mode with nobody followed: any roster player may switch", async () => {
    const bot = hardBot()
    const ticker = createTicker({ bot, brain: stubBrain, tickMs: 10, idleTickMs: 10, brainEngine: 'off' })
    handleChat(bot, ticker, 'Owner', 'brain jev')
    assert.deepEqual(bot.chats, ['brain: jev'])
    assert.equal(ticker.getBrainEngine(), 'jev')
  })

  it("work mode: unknown names still cannot switch", () => {
    const bot = hardBot()
    const ticker = createTicker({ bot, brain: stubBrain, tickMs: 10, idleTickMs: 10, brainEngine: 'off' })
    handleChat(bot, ticker, 'Ghost', 'brain jev')
    assert.deepEqual(bot.chats, [])
    assert.equal(ticker.getBrainEngine(), 'off')
  })

  it("setBrain refreshes ctx.brain: after 'brain jev' chooseStep asks jev", async () => {
    // rw4.6+d75 link: setBrain updated only the decide closure, so goal
    // chooseStep (ctx.brain) kept asking the old brain. Deleting the
    // ctx.brain refresh fails this test (source falls back to goal-fsm).
    const { chooseStep } = require('../src/goal')
    // jev must answer a valid step name for source=jev — the suite-wide
    // canned 'follow' is a combat answer, not a step, so re-can here.
    globalThis.fetch = cannedFetch('gather')
    const bot = hardBot()
    const ticker = followedTicker(bot)
    handleChat(bot, ticker, 'Owner', 'brain jev')
    assert.equal(ticker.getBrainEngine(), 'jev')
    const facts = { time: 'day', logs: 0, planks: 0, maxPlanks: 0, table: 0, door: 0, home: 'none', tablePlaced: false, inside: 'no', health: 20, food: 20 }
    const r = await chooseStep(bot._tickerCtx.brain, facts, ['gather', 'rest'])
    assert.equal(r.step, 'gather')
    assert.equal(r.source, 'jev')
  })

  it("'brain laya' with a JEV BRAIN_URL runs free, never jev", async () => {
    // dxl round 2: 'brain laya' built its client from BRAIN_URL verbatim,
    // so on a JEV-configured deployment the engine said 'laya' while the
    // client billed JEV — and autonomous mode never downgraded it.
    process.env.BRAIN_URL = 'https://api.typesafe.ai/v1/systemone'
    const bot = hardBot()
    const ticker = followedTicker(bot)
    handleChat(bot, ticker, 'Owner', 'brain laya')
    assert.equal(ticker.getBrainEngine(), 'laya')
    bot.players.Owner.entity.position = pos(11, 64, 0)
    assert.equal((await ticker.tick()).decision.source, 'laya')
  })

  it("a stranger cannot switch the brain", async () => {
    const bot = hardBot()
    bot.players.Stranger = { username: 'Stranger', entity: { id: 9, position: pos(12, 64, 0) } }
    const ticker = followedTicker(bot)
    handleChat(bot, ticker, 'Stranger', 'brain laya')
    assert.deepEqual(bot.chats, [])
    assert.equal(ticker.getBrainEngine(), 'off')
    assert.equal((await ticker.tick()).decision.source, 'stub')
  })
})
