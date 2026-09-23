'use strict'

// Wedge diagnostics (idkcraft-b50): the follow wedge line names the relief
// (feet/head/next blocks) so the next prod trap names its edge.

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const { createTicker } = require('../src/index')
const follow = require('../src/behaviours/follow')

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

const BLOCKS = {
  '-41,64,-208': 'water', '-41,65,-208': 'air', '-39,64,-207': 'dirt',
}

function wedgedBot() {
  const bot = {
    username: 'IdkBot',
    players: {},
    entities: {},
    entity: { position: pos(-40.4, 64.4, -207.7) },
    _moving: true, // executor reports moving while the body stands still
    controls: {},
    setControlState: (name, value) => { bot.controls[name] = value },
    calls: { setGoal: 0 },
    pathfinder: {
      setGoal: () => { bot.calls.setGoal++ },
      isMoving: () => bot._moving,
    },
    blockAt: (p) => {
      // Real blockAt calls pos.floored(): plain objects must throw here so
      // the suite catches a Vec3 regression instead of masking it.
      if (!p || typeof p.floored !== 'function') throw new Error('pos.floored is not a function')
      const f = p.floored()
      const n = BLOCKS[`${f.x},${f.y},${f.z}`]
      return n ? { name: n } : null
    },
  }
  return bot
}

describe('follow wedge line (idkcraft-b50)', () => {
  it('names feet/head/next blocks on the wedge line', () => {
    const bot = wedgedBot()
    const target = { username: 'P', id: 7, position: pos(-20, 64, -207) }
    const ctx = {
      lastGoalKey: 'follow:P', stuckResets: 2, followLastPos: pos(-40.4, 64.4, -207.7),
      lastPathNext: pos(-39, 64, -207), // setPathNext stores a Vec3 clone, never a plain object
    }
    const logs = []
    const origLog = console.log
    console.log = (m) => logs.push(String(m))
    try {
      follow(bot, ctx, target, { distance_to_player: 20 })
    } finally {
      console.log = origLog
    }
    assert.equal(logs.length, 1)
    assert.match(logs[0], /^stuck reason=wedge pos=/)
    assert.ok(logs[0].includes('feet=water'), logs[0])
    assert.ok(logs[0].includes('head=air'), logs[0])
    assert.ok(logs[0].includes('next=-39,64,-207:dirt'), logs[0])
  })

  it('unreadable cells read ? instead of throwing', () => {
    const bot = wedgedBot()
    bot.blockAt = () => { throw new Error('unloaded') }
    const target = { username: 'P', id: 7, position: pos(-20, 64, -207) }
    const ctx = { lastGoalKey: 'follow:P', stuckResets: 2, followLastPos: pos(-40.4, 64.4, -207.7) }
    const logs = []
    const origLog = console.log
    console.log = (m) => logs.push(String(m))
    try {
      follow(bot, ctx, target, { distance_to_player: 20 })
    } finally {
      console.log = origLog
    }
    assert.equal(logs.length, 1)
    assert.ok(logs[0].includes('feet=?'), logs[0])
    assert.ok(logs[0].includes('next=?:?'), logs[0])
  })

  it('setPathNext stores the plan head for the wedge line', () => {
    const bot = {
      username: 'IdkBot', players: {}, entities: {}, health: 20, food: 20,
      entity: { position: pos(0, 64, 0) }, spawnPoint: pos(0, 64, 0),
      chat() {}, attack() {}, lookAt() {},
      pathfinder: { setGoal() {}, stop() {}, isMoving: () => false, setMovements() {} },
      setControlState() {}, clearControlStates() {},
      inventory: { items: () => [] }, equip: async () => {},
    }
    const ticker = createTicker({
      bot, brain: { decide: async () => ({ action: 'idle', sprint: false, source: 'stub' }) },
      tickMs: 10, idleTickMs: 10,
    })
    // Prod passes a pathfinder Move (a Vec3): the stored head must stay
    // blockAt-safe, i.e. carry floored, or the wedge line reads next=...:?
    ticker.setPathNext(pos(9, 62, 0))
    const stored = bot._tickerCtx.lastPathNext
    assert.equal(typeof stored.floored, 'function')
    assert.deepEqual({ x: stored.x, y: stored.y, z: stored.z }, { x: 9, y: 62, z: 0 })
    ticker.setPathNext(null)
    assert.equal(bot._tickerCtx.lastPathNext, null)
  })
})
