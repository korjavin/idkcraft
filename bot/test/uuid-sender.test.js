'use strict'

// Sender UUID resolution (idkcraft-8gf): Java 'X' and Bedrock '.X' online
// together share the chat name, so the message-event sender UUID wins;
// name resolution stays the fallback.

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const { createTicker, handleChat } = require('../src/index')
const { resolvePlayer } = require('../src/perception')

const U1 = '11111111-2222-3333-4444-555555555555'
const U2 = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'

function pos(x, y, z) {
  return { x, y, z, distanceTo: (q) => Math.hypot(x - q.x, y - q.y, z - q.z), clone() { return pos(x, y, z) } }
}

function chatBot() {
  return {
    username: 'IdkBot',
    players: {
      X: { username: 'X', uuid: U1, entity: { id: 1, position: pos(2, 64, 0) } },
      '.X': { username: '.X', uuid: U2, entity: { id: 2, position: pos(3, 64, 0) } },
    },
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

describe("sender UUID (idkcraft-8gf)", () => {
  it("chat name 'X' + sender uuid of '.X' resolves to '.X'", async () => {
    const bot = chatBot()
    const ticker = createTicker({ bot, brain: mockBrain(), tickMs: 10, idleTickMs: 10 })
    handleChat(bot, ticker, 'X', 'follow me', U2)
    assert.ok(bot.chats.some((m) => m.includes('Following .X')), `chats: ${bot.chats}`)
    const r = await ticker.tick()
    assert.equal(r.decision.action, 'follow')
  })

  it('unknown uuid falls back to the name chain', () => {
    const bot = chatBot()
    const ticker = createTicker({ bot, brain: mockBrain(), tickMs: 10, idleTickMs: 10 })
    handleChat(bot, ticker, 'X', 'follow me', 'ffffffff-ffff-ffff-ffff-ffffffffffff')
    assert.ok(bot.chats.some((m) => m.includes('Following X') && !m.includes('.X')))
  })

  it('uuid matching ignores dashes and case', () => {
    assert.equal(resolvePlayer(chatBot(), 'X', U2.replace(/-/g, '').toUpperCase()), '.X')
    assert.equal(resolvePlayer(chatBot(), 'X', U1), 'X')
  })

  it('no uuid keeps the old name behavior', () => {
    assert.equal(resolvePlayer(chatBot(), 'X'), 'X')
    assert.equal(resolvePlayer(chatBot(), 'Nobody', null), 'Nobody')
  })
})
