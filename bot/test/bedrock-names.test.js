'use strict'

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const { createTicker, handleChat } = require('../src/index')
const { findTarget, resolvePlayer } = require('../src/perception')

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

function mockBrain() {
  return { async decide() { return { action: 'follow', sprint: false, source: 'stub' } } }
}

describe("Bedrock Floodgate '.' prefix (idkcraft-8b5)", () => {
  it("chat 'Steve' + roster '.Steve' -> 'Following .Steve' and findTarget finds him", async () => {
    const bot = mockBot()
    bot.players = { '.Steve': { username: '.Steve', entity: { id: 7, position: pos(2, 64, 0) } } }
    const ticker = createTicker({ bot, brain: mockBrain(), tickMs: 10, idleTickMs: 10 })
    handleChat(bot, ticker, 'Steve', 'follow me')
    assert.ok(bot.chats.some((m) => m.includes('Following .Steve')), `chats: ${bot.chats}`)
    const target = findTarget(bot, 'Steve')
    assert.ok(target, 'findTarget should resolve the dot-prefixed roster key')
    const r = await ticker.tick()
    assert.equal(r.decision.action, 'follow')
  })

  it('Java names are unchanged', () => {
    const bot = mockBot()
    bot.players = { Steve: { username: 'Steve', entity: { id: 7, position: pos(2, 64, 0) } } }
    const ticker = createTicker({ bot, brain: mockBrain(), tickMs: 10, idleTickMs: 10 })
    handleChat(bot, ticker, 'Steve', 'follow me')
    assert.ok(bot.chats.some((m) => m.includes('Following Steve')))
    assert.ok(findTarget(bot, 'Steve'))
  })

  it('unseen hint uses the real roster name', () => {
    const bot = mockBot()
    bot.players = { '.Steve': { username: '.Steve', entity: null } }
    const ticker = createTicker({ bot, brain: mockBrain(), tickMs: 10, idleTickMs: 10 })
    handleChat(bot, ticker, 'Steve', 'follow me')
    assert.ok(bot.chats.some((m) => m.includes("I can't see you")))
    assert.ok(bot.chats.some((m) => m.includes('/tp IdkBot .Steve')), `chats: ${bot.chats}`)
  })

  it('resolvePlayer: exact, dot-prefix, case-insensitive, unknown passthrough', () => {
    const bot = mockBot()
    bot.players = { '.Steve': { username: '.Steve' }, Alex: { username: 'Alex' } }
    assert.equal(resolvePlayer(bot, '.Steve'), '.Steve')
    assert.equal(resolvePlayer(bot, 'Steve'), '.Steve')
    assert.equal(resolvePlayer(bot, 'steve'), '.Steve')
    assert.equal(resolvePlayer(bot, 'Alex'), 'Alex')
    assert.equal(resolvePlayer(bot, 'alex'), 'Alex')
    assert.equal(resolvePlayer(bot, 'Nobody'), 'Nobody')
    assert.equal(resolvePlayer(bot, ''), '')
  })
})
