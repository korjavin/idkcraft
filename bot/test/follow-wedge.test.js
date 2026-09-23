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

describe('follow place_error streak (idkcraft-2oe)', () => {
  // Ticker-capable mock with a stationary body: createTicker owns the
  // counters (setPathReset), follow() is driven per tick like the ticker
  // drives it, so the test fails until follow counts placeErrors itself.
  function stillBot() {
    const bot = {
      username: 'IdkBot', players: {}, entities: {}, health: 20, food: 20,
      entity: { position: pos(0, 64, 0) },
      _moving: false,
      chat() {}, attack() {}, lookAt() {},
      pathfinder: {
        setGoal() {},
        stop() {},
        isMoving: () => bot._moving,
        setMovements() {},
      },
      setControlState() {}, clearControlStates: () => {},
      inventory: { items: () => [] }, equip: async () => {},
    }
    return bot
  }

  it('three place_error with no displacement raise the same wedge', () => {
    const bot = stillBot()
    const ticker = createTicker({
      bot, brain: { decide: async () => ({ action: 'idle', sprint: false, source: 'stub' }) },
      tickMs: 10, idleTickMs: 10,
    })
    const ctx = bot._tickerCtx
    const target = { username: 'P', id: 7, position: pos(20, 64, 0) }
    const logs = []
    const origLog = console.log
    console.log = (m) => logs.push(String(m))
    try {
      follow(bot, ctx, target, { distance_to_player: 20 }) // issues GoalFollow
      for (let i = 0; i < 3; i++) {
        ticker.setPathReset('place_error')
        bot._moving = (i % 2 === 0) // prod blink: moving true/false
        follow(bot, ctx, target, { distance_to_player: 20 })
      }
    } finally {
      console.log = origLog
    }
    const wedge = logs.filter((l) => l.includes('stuck reason=wedge'))
    assert.equal(wedge.length, 1)
    assert.match(wedge[0], /^stuck reason=wedge pos=0,64,0 dist=20\.0 /)
    assert.deepEqual(ctx.stuck, { by: 'follow', goal: { x: 20, y: 64, z: 0 }, key: 'follow:P' })
  })

  it('a fight tick stealing the body does not reset the stall count', () => {
    // 68p at follow scale: MAX_STALLS is 2, so the fight must steal every
    // 2nd tick to prove the reset (every 3rd still leaves two consecutive
    // follow ticks, which fire even today). Same mechanism as the gather
    // acceptance (fight every 3rd vs STALL_TICKS 10).
    const bot = stillBot()
    const ctx = { lastGoalKey: '', lastPathStatus: 'noPath' }
    const target = { username: 'P', id: 7, position: pos(20, 64, 0) }
    const logs = []
    const origLog = console.log
    console.log = (m) => logs.push(String(m))
    let firedAt = -1
    try {
      for (let i = 0; i < 9; i++) {
        if (i % 2 === 1) ctx.lastGoalKey = 'fight:9' // fight owned this tick
        follow(bot, ctx, target, { distance_to_player: 20 })
        if (ctx.stuck) { firedAt = i; break }
      }
    } finally {
      console.log = origLog
    }
    assert.equal(firedAt, 4)
    assert.equal(logs.filter((l) => l.includes('stuck reason=')).length, 1)
    assert.equal(ctx.stuck.by, 'follow')
  })
})
