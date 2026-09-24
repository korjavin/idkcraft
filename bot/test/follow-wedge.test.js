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

  it('stale plans re-issue to the player, never raise stuck (idkcraft-5vv)', () => {
    // Owner decision: follow never gives up. A stale noPath/timeout plan
    // is re-issued to the player's current position; the recover menu
    // opens only for a real wedge (moving executor, no displacement).
    const bot = stillBot()
    bot.lastGoal = null
    const seen = []
    const origSet = bot.pathfinder.setGoal
    bot.pathfinder.setGoal = (g) => { seen.push(g && g.constructor && g.constructor.name); return origSet(g) }
    const ctx = { lastGoalKey: '', lastPathStatus: 'noPath' }
    const target = { username: 'P', id: 7, position: pos(20, 64, 0) }
    const logs = []
    const origLog = console.log
    console.log = (m) => logs.push(String(m))
    try {
      for (let i = 0; i < 9; i++) {
        if (i % 2 === 1) ctx.lastGoalKey = 'fight:9' // fight owned this tick
        follow(bot, ctx, target, { distance_to_player: 20 })
        if (ctx.stuck) break
      }
    } finally {
      console.log = origLog
    }
    assert.equal(ctx.stuck, undefined)
    assert.equal(logs.filter((l) => l.includes('stuck reason=')).length, 0)
    assert.ok(seen.length >= 4, `re-issued ${seen.length}x`)
    assert.ok(seen.every((n) => n === 'GoalFollow'), seen.join(','))
  })
})
describe('follow sprint on flat pursuit (idkcraft-5vv)', () => {
  function sprintBot() {
    const bot = wedgedBot()
    bot.entity.position = pos(0, 64.4, 0)
    return bot
  }
  function sprintCtx(nodes) {
    return {
      lastGoalKey: 'follow:P', followLastPos: pos(0, 64.4, 0),
      movements: { allowSprinting: false, allowParkour: true },
      lastPathNodes: nodes,
    }
  }
  const N = (x, y, z) => pos(x, y, z)
  const target = { username: 'P', id: 7, position: pos(12, 64, 0) }
  it('dist 12 with level nodes in the window sprints, parkour off', () => {
    const bot = sprintBot()
    const ctx = sprintCtx([N(3, 64, 0), N(6, 64, 0)])
    follow(bot, ctx, target, { distance_to_player: 12 })
    assert.equal(ctx.movements.allowSprinting, true)
    assert.equal(ctx.movements.allowParkour, false)
  })
  it('a +1 node inside the window kills the sprint', () => {
    const bot = sprintBot()
    const ctx = sprintCtx([N(3, 64, 0), N(5, 65, 0)]) // step inside the 6-block window
    follow(bot, ctx, target, { distance_to_player: 12 })
    assert.equal(ctx.movements.allowSprinting, false)
    assert.equal(ctx.movements.allowParkour, true)
  })
  it('a +1 beyond the window is ignored', () => {
    const bot = sprintBot()
    const ctx = sprintCtx([N(3, 64, 0), N(10, 65, 0)]) // unreachable this tick
    follow(bot, ctx, target, { distance_to_player: 12 })
    assert.equal(ctx.movements.allowSprinting, true)
  })
  it('no plan nodes yet means no sprint', () => {
    const bot = sprintBot()
    const ctx = sprintCtx(null)
    follow(bot, ctx, target, { distance_to_player: 12 })
    assert.equal(ctx.movements.allowSprinting, false)
  })
  it('close pursuit never sprints', () => {
    const bot = sprintBot()
    const ctx = sprintCtx([N(3, 64, 0)])
    follow(bot, ctx, { username: 'P', id: 7, position: pos(5, 64, 0) }, { distance_to_player: 5 })
    assert.equal(ctx.movements.allowSprinting, false)
  })
  it('a new pursuit clears the previous goal nodes', () => {
    const bot = sprintBot()
    const ctx = sprintCtx([N(3, 64, 0)])
    ctx.lastGoalKey = 'follow:Q' // different key: fresh setGoal below
    follow(bot, ctx, target, { distance_to_player: 12 })
    assert.equal(ctx.lastPathNodes, null)
    assert.equal(ctx.movements.allowSprinting, false)
  })
})
describe('follow never gives up (idkcraft-5vv)', () => {
  const { goals } = require('mineflayer-pathfinder')
  function planBot() {
    const bot = wedgedBot()
    bot._moving = false
    bot.entity.position = pos(0, 64, 0)
    bot.lastGoal = null
    const origSet = bot.pathfinder.setGoal
    bot.pathfinder.setGoal = (g) => { bot.lastGoal = g; return origSet(g) }
    return bot
  }
  function quiet(fn) {
    const logs = []
    const origLog = console.log
    console.log = (m) => logs.push(String(m))
    try { fn() } finally { console.log = origLog }
    return logs
  }
  const target = { username: 'P', id: 7, position: pos(20, 64, 0) }
  it('a stale noPath plan re-issues GoalFollow, never a stuck fact', () => {
    const bot = planBot()
    const ctx = { lastGoalKey: 'follow:P', followLastPos: pos(0, 64, 0), lastPathStatus: 'noPath', followIssuedAt: Date.now() - 7000 }
    const logs = quiet(() => follow(bot, ctx, target, { distance_to_player: 20 }))
    assert.equal(bot.calls.setGoal, 1)
    assert.ok(bot.lastGoal instanceof goals.GoalFollow)
    assert.equal(ctx.stuck, undefined)
    assert.equal(logs.filter((l) => l.includes('stuck reason=')).length, 0)
  })
  it('a fresh stuck reset while moving replans, only the wedge opens the menu', () => {
    const bot = wedgedBot()
    bot.entity.position = pos(0, 64.4, 0)
    const ctx = {
      lastGoalKey: 'follow:P', stuckResets: 1, followSeenStuck: 0,
      followLastPos: pos(0, 64.4, 0),
    }
    const logs = quiet(() => follow(bot, ctx, target, { distance_to_player: 20 }))
    assert.equal(bot.calls.setGoal, 1)
    assert.equal(ctx.stuck, undefined)
    assert.equal(logs.filter((l) => l.includes('stuck reason=')).length, 0)
    assert.equal(ctx.followSeenStuck, 1)
  })
})
