'use strict'

const { describe, it, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const { createTicker, handleChat, parseAutonomous, autonomousEffective } = require('../src/index')
const { hybridBrain } = require('../src/brain')
const { AUTONOMOUS_EXPLORE_RADIUS } = require('../src/goal')
const metrics = require('../src/metrics')

function pos(x, y, z) {
  const p = {
    x, y, z,
    distanceTo: (q) => Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z),
    clone() { return pos(p.x, p.y, p.z) },
    floored() { return pos(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)) },
    offset(ox, oy, oz) { return pos(p.x + ox, p.y + oy, p.z + oz) },
  }
  return p
}

function mockBot() {
  const lines = []
  const bot = {
    lines,
    username: 'IdkBot',
    players: {},
    entities: {},
    health: 20,
    food: 20,
    quitCalls: 0,
    entity: { position: pos(0, 64, 0), onGround: true },
    spawnPoint: pos(0, 64, 0),
    registry: { blocksByName: {}, itemsByName: {} },
    inventory: { items: () => [] },
    pathfinder: { goal: null, setGoal(goal) { bot.pathfinder.goal = goal }, stop() {}, isMoving: () => false, setMovements() {} },
    setControlState() {},
    clearControlStates() {},
    quit() { bot.quitCalls++ },
    chat(line) { lines.push(String(line)) },
    blockAt: () => null,
    blockAtCursor: () => null,
  }
  return bot
}

function mockBrain(decision) {
  return {
    calls: 0,
    async decide() {
      this.calls++
      return decision || { action: 'idle', sprint: false, source: 'fake' }
    },
  }
}

let savedEnv = null
beforeEach(() => {
  savedEnv = { ...process.env }
  delete process.env.BOT_AUTONOMOUS
  delete process.env.BRAIN_URL
  delete process.env.TYPESAFE_API_KEY
})
afterEach(() => {
  process.env = savedEnv
})

describe('autonomous mode', () => {
  it('stays on an empty server past the grace, logging at most every 10 min', async () => {
    const bot = mockBot()
    bot.players = { Steve: { username: 'Steve', entity: { position: pos(1, 64, 0) } } }
    let t = 0
    const brain = mockBrain()
    const ticker = createTicker({ bot, brain, tickMs: 10, idleTickMs: 10, leaveAfterMs: 60, onLeave: () => bot.quit('nobody online'), now: () => t })
    const logs = []
    const origLog = console.log
    console.log = (m) => logs.push(String(m))
    try {
      handleChat(bot, ticker, 'Steve', 'autonomous on')
      assert.ok(bot.lines.join(' ').includes('autonomous on'), `lines: ${bot.lines}`)
      bot.players = {} // Steve leaves
      const tick = async () => { await ticker.tick(); t += 10 }
      for (let i = 0; i < 20; i++) await tick() // 200 ms >> 60 ms grace
      assert.equal(bot.quitCalls, 0, 'no leave while autonomous')
      const stays = logs.filter((l) => l.includes('nobody online, staying (autonomous)'))
      assert.equal(stays.length, 1, `one staying line, got ${stays.length}`)
    } finally {
      console.log = origLog
    }
  })

  it('off (default) keeps the old leave', async () => {
    const bot = mockBot()
    let t = 0
    const ticker = createTicker({ bot, brain: mockBrain(), tickMs: 10, idleTickMs: 10, leaveAfterMs: 60, onLeave: () => bot.quit('nobody online'), now: () => t })
    for (let i = 0; i < 8; i++) { await ticker.tick(); t += 10 }
    assert.equal(bot.quitCalls, 1, 'leaves without autonomous')
  })

  it('work ticks keep calling the brain with nobody online', async () => {
    const bot = mockBot()
    bot.players = { Steve: { username: 'Steve', entity: { position: pos(1, 64, 0) } } }
    const brain = mockBrain()
    const ticker = createTicker({ bot, brain, tickMs: 10, idleTickMs: 10, leaveAfterMs: 0 })
    handleChat(bot, ticker, 'Steve', 'autonomous on')
    ticker.work()
    bot.players = {}
    for (let i = 0; i < 5; i++) await ticker.tick()
    assert.ok(brain.calls > 0, `brain called ${brain.calls} times while alone`)
  })

  it('model follow is infeasible without players', async () => {
    const remote = {
      name: 'fake',
      async decide() { return { action: 'follow', sprint: false, source: 'fake' } },
    }
    const brain = hybridBrain(remote)
    const hardNoPlayer = { hostile_distance: 4, bot_health: 5 }
    const r1 = await brain.decide(hardNoPlayer)
    assert.notEqual(r1.action, 'follow', `no follow without players, got ${r1.action}`)
    const hardWithPlayer = { hostile_distance: 4, bot_health: 5, distance_to_player: 12 }
    const r2 = await brain.decide(hardWithPlayer)
    assert.equal(r2.action, 'follow', 'follow allowed with players')
  })

  it('jev without players becomes laya, restored on join when manual', async () => {
    process.env.BRAIN_URL = 'http://laya:8000/v1/systemone'
    process.env.TYPESAFE_API_KEY = 'k'
    const bot = mockBot()
    bot.players = { Steve: { username: 'Steve', entity: { position: pos(1, 64, 0) } } }
    const ticker = createTicker({ bot, brain: mockBrain(), tickMs: 10, idleTickMs: 10, leaveAfterMs: 0, brainEngine: 'jev' })
    handleChat(bot, ticker, 'Steve', 'brain jev')
    handleChat(bot, ticker, 'Steve', 'autonomous on')
    assert.ok(bot.lines.join(' ').includes('laya'), `on-reply names laya: ${bot.lines}`)
    bot.players = {}
    for (let i = 0; i < 3; i++) await ticker.tick()
    assert.equal(ticker.getBrainEngine(), 'laya', 'downgraded without players')
    bot.players = { Steve: { username: 'Steve', entity: { position: pos(1, 64, 0) } } }
    await ticker.tick()
    assert.equal(ticker.getBrainEngine(), 'jev', 'restored on join')
  })

  it('metric tracks the toggle', () => {
    const bot = mockBot()
    bot.players = { Steve: { username: 'Steve', entity: { position: pos(1, 64, 0) } } }
    const ticker = createTicker({ bot, brain: mockBrain(), tickMs: 10, idleTickMs: 10 })
    const gauge = () => metrics.client.register.getSingleMetric('idkcraft_bot_autonomous').hashMap[''].value
    handleChat(bot, ticker, 'Steve', 'autonomous on')
    assert.equal(gauge(), 1)
    handleChat(bot, ticker, 'Steve', 'autonomous off')
    assert.equal(gauge(), 0)
  })

  it('exposes the alone-explore radius for atl.1', () => {
    assert.equal(AUTONOMOUS_EXPLORE_RADIUS, 256)
  })

  it('jev-configured BRAIN_URL downgrades to off, never a paid laya', async () => {
    process.env.BRAIN_URL = 'https://api.typesafe.ai/v1/systemone'
    process.env.TYPESAFE_API_KEY = 'k'
    const bot = mockBot()
    bot.players = { Steve: { username: 'Steve', entity: { position: pos(1, 64, 0) } } }
    const ticker = createTicker({ bot, brain: mockBrain(), tickMs: 10, idleTickMs: 10, leaveAfterMs: 0, brainEngine: 'jev' })
    handleChat(bot, ticker, 'Steve', 'brain jev')
    handleChat(bot, ticker, 'Steve', 'autonomous on')
    assert.ok(bot.lines.join(' ').includes('off without players'), `on-reply names off: ${bot.lines}`)
    bot.players = {}
    for (let i = 0; i < 3; i++) await ticker.tick()
    assert.equal(ticker.getBrainEngine(), 'off', 'paid URL never runs alone')
  })

  it('chat toggle outlives the ticker via the effective flag', () => {
    assert.equal(parseAutonomous({}), false)
    assert.equal(parseAutonomous({ BOT_AUTONOMOUS: '1' }), true)
    assert.equal(parseAutonomous({ BOT_AUTONOMOUS: 'TRUE' }), true)
    assert.equal(parseAutonomous({ BOT_AUTONOMOUS: 'yes' }), true)
    assert.equal(parseAutonomous({ BOT_AUTONOMOUS: '0' }), false)
    const bot = mockBot()
    bot.players = { Steve: { username: 'Steve', entity: { position: pos(1, 64, 0) } } }
    const ticker = createTicker({ bot, brain: mockBrain(), tickMs: 10, idleTickMs: 10 })
    handleChat(bot, ticker, 'Steve', 'autonomous on')
    assert.equal(autonomousEffective({}), true, 'chat on wins over empty env')
    handleChat(bot, ticker, 'Steve', 'autonomous off')
    assert.equal(autonomousEffective({ BOT_AUTONOMOUS: '1' }), false, 'chat off wins over env')
    handleChat(bot, ticker, 'Steve', 'autonomous on')
    assert.equal(autonomousEffective({ BOT_AUTONOMOUS: '1' }), true)
  })

  it('far-from-spawn restart on an empty server walks home, then works', async () => {
    const bot = mockBot()
    bot.entity.position = pos(100, 64, 0)
    bot.spawnPoint = pos(0, 64, 0)
    const ticker = createTicker({ bot, brain: mockBrain(), tickMs: 10, idleTickMs: 10, leaveAfterMs: 0, autonomous: true })
    const c = bot._tickerCtx
    c.unseenTicks = 10 // spawn pre-arm: far, unseen, no work yet
    for (let i = 0; i < 3; i++) await ticker.tick()
    assert.ok((c.unseenTicks || 0) >= 10, `counter accrues alone, got ${c.unseenTicks}`)
    assert.ok(bot.pathfinder.goal, 'homing walk issued')
  })
})
