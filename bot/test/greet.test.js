'use strict'

// Greeting gesture (idkcraft-v92): crouch twice on a far -> near arrival,
// 60 s per-player cooldown, sneak always released. Fake clock, no timers.

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const { createGreeter, GREET_FAR, GREET_NEAR, COOLDOWN_MS } = require('../src/greet')
const { createTicker, handleDeath } = require('../src/index')

function pos(x, y, z) {
  const p = {
    x, y, z,
    distanceTo: (q) => Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z),
    clone() { return pos(p.x, p.y, p.z) },
  }
  return p
}

const flush = async (n = 8) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)) }

function clock() {
  let t = 0
  return { now: () => t, advance: (ms) => { t += ms } }
}

function sneakBot(log) {
  return { setControlState: (k, v) => { if (k === 'sneak') log.push(v) } }
}

describe('greet module (idkcraft-v92)', () => {
  it('approach from far starts exactly two sneak true/false cycles, ending false', async () => {
    const c = clock()
    const log = []
    const g = createGreeter({ now: c.now, sleep: async () => {} })
    assert.equal(g.greetOnArrival(sneakBot(log), 'P', 10, 2, true), true)
    await flush()
    assert.deepEqual(log, [true, false, true, false])
  })

  it('re-approach within 60 s is silent, after 60 s greets again', async () => {
    const c = clock()
    const log = []
    const g = createGreeter({ now: c.now, sleep: async () => {} })
    const bot = sneakBot(log)
    assert.equal(g.greetOnArrival(bot, 'P', 10, 2, true), true)
    await flush()
    const n = log.length
    c.advance(10000)
    assert.equal(g.greetOnArrival(bot, 'P', 10, 2, true), false)
    await flush()
    assert.equal(log.length, n)
    c.advance(51000) // 61 s total
    assert.equal(g.greetOnArrival(bot, 'P', 10, 2, true), true)
    await flush()
    assert.ok(log.length > n)
    assert.equal(log[log.length - 1], false)
  })

  it('no gesture without the far -> near edge, while moving, or when busy', async () => {
    const c = clock()
    const log = []
    const g = createGreeter({ now: c.now, sleep: async () => {} })
    const bot = sneakBot(log)
    assert.equal(g.greetOnArrival(bot, 'P', 5, 2, true), false) // never far
    assert.equal(g.greetOnArrival(bot, 'P', 10, 4, true), false) // never near
    assert.equal(g.greetOnArrival(bot, 'P', 10, 2, false), false) // moving
    assert.equal(g.greetOnArrival(bot, '', 10, 2, true), false)
    await flush()
    assert.deepEqual(log, [])
    const p1 = g.crouchTwice(bot) // running...
    assert.equal(await g.crouchTwice(bot), false) // ...so this refuses
    assert.equal(await p1, true)
  })

  it('cancel releases sneak and frees the next gesture', async () => {
    const c = clock()
    const log = []
    const g = createGreeter({ now: c.now, sleep: async () => {} })
    const bot = sneakBot(log)
    const p1 = g.crouchTwice(bot)
    g.cancel(bot)
    assert.equal(await p1, false)
    assert.equal(log[log.length - 1], false)
    assert.equal(await g.crouchTwice(bot), true)
  })
})

describe('greet wiring (idkcraft-v92)', () => {
  function workBot() {
    const bot = {
      username: 'IdkBot',
      players: { P: { username: 'P', entity: { id: 7, position: pos(10, 64, 0) } } },
      entities: {},
      health: 20,
      food: 20,
      entity: { position: pos(0, 64, 0) },
      spawnPoint: pos(0, 64, 0),
      chats: [],
      chat(m) { this.chats.push(String(m)) },
      attackCalls: 0,
      attack() { this.attackCalls++ },
      lookAt() {},
      _moving: false,
      _items: [],
      inventory: null,
      equip: async () => {},
      pathfinder: {
        goal: null,
        setGoal(g) { this.goal = g },
        stop() {},
        isMoving: () => bot._moving,
        setMovements() {},
      },
      setControlState() {},
      clearControlStates() {},
    }
    bot.inventory = { items: () => bot._items }
    return bot
  }

  function stubGreeter() {
    return {
      calls: [],
      cancelled: false,
      greetOnArrival(...a) { this.calls.push(a); return true },
      cancel() { this.cancelled = true },
    }
  }

  function mockBrain(decision) {
    return { async decide() { return decision } }
  }

  it('follow arrival far -> near sneaks twice through the real greeter', async () => {
    const c = clock()
    const log = []
    const bot = workBot()
    bot.setControlState = (k, v) => { if (k === 'sneak') log.push(v) }
    const greeter = createGreeter({ now: c.now, sleep: async () => {} })
    const ticker = createTicker({
      bot, brain: mockBrain({ action: 'follow', sprint: false, source: 'stub' }),
      tickMs: 10, idleTickMs: 10, followName: 'P', greeter,
    })
    await ticker.tick() // P at 10: first sight, no edge
    await flush()
    assert.deepEqual(log, [])
    bot.players.P.entity.position = pos(2, 64, 0)
    await ticker.tick() // 10 -> 2 standing: greet
    await flush()
    assert.deepEqual(log, [true, false, true, false])
    await ticker.tick() // still near: no new edge
    await flush()
    assert.deepEqual(log, [true, false, true, false])
  })

  it('the wiring passes the approached player, edge and standing through', async () => {
    const bot = workBot()
    bot._moving = true // body walking: standing=false rides along
    const greeter = stubGreeter()
    const ticker = createTicker({
      bot, brain: mockBrain({ action: 'follow', sprint: false, source: 'stub' }),
      tickMs: 10, idleTickMs: 10, followName: 'P', greeter,
    })
    await ticker.tick()
    bot.players.P.entity.position = pos(2, 64, 0)
    await ticker.tick()
    assert.equal(greeter.calls.length, 1)
    assert.equal(greeter.calls[0][1], 'P')
    assert.equal(greeter.calls[0][2], 10)
    assert.equal(greeter.calls[0][3], 2)
    assert.equal(greeter.calls[0][4], false)
  })

  it('fight never greets; destroy and death cancel', async () => {
    const bot = workBot()
    const greeter = stubGreeter()
    const ticker = createTicker({
      bot, brain: mockBrain({ action: 'fight', sprint: false, source: 'stub' }),
      tickMs: 10, idleTickMs: 10, followName: 'P', greeter,
    })
    bot.entities = { 1: { id: 1, name: 'zombie', type: 'mob', position: pos(5, 64, 0), height: 1.95 } }
    await ticker.tick()
    assert.equal(greeter.calls.length, 0)
    ticker.destroy()
    assert.equal(greeter.cancelled, true)
    greeter.cancelled = false
    handleDeath(bot, ticker)
    assert.equal(greeter.cancelled, true)
  })
})
