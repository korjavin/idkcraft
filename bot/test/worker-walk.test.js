'use strict'

// Guided far walk (idkcraft-jlda.5): comehome/gocastle/gohome legs delegate
// the WALK only after the head's own leg failed. The worker module is stubbed
// (sends recorded, entity scripted); with no worker the failure paths are
// byte-identical.

const { describe, it, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const worker = require('../src/worker')
const home = require('../src/behaviours/home')
const gocastle = require('../src/behaviours/gocastle')
const castleMod = require('../src/behaviours/castle')

const ORIG = {
  configured: worker.configured,
  name: worker.name,
  workerOnline: worker.workerOnline,
  workerEntity: worker.workerEntity,
  send: worker.send,
}
afterEach(() => {
  worker.configured = ORIG.configured
  worker.name = ORIG.name
  worker.workerOnline = ORIG.workerOnline
  worker.workerEntity = ORIG.workerEntity
  worker.send = ORIG.send
  worker.configure({})
})

function stubWorker({ sends, entity, online = true }) {
  worker.configured = () => true
  worker.name = () => 'W'
  worker.workerOnline = () => online
  worker.workerEntity = () => entity.box
  worker.send = async (line) => { sends.push(String(line)); return true }
}

function pos(x, y, z) {
  return { x, y, z, distanceTo: (q) => Math.hypot(x - q.x, y - q.y, z - q.z) }
}

const flush = () => new Promise((resolve) => setImmediate(resolve))
const flushes = async (n = 4) => { for (let i = 0; i < n; i++) await flush() }

// Minimal bot for trigger/guide unit tests: position, clock, pathfinder.
function unitBot({ at = { x: 0, y: 64, z: 0 }, timeOfDay = 6000, moving = false } = {}) {
  const chats = []
  const goals = []
  const bot = {
    chats,
    goals,
    username: 'IdkBot',
    players: {},
    entity: { position: { ...at } },
    time: { timeOfDay, day: 5 },
    pathfinder: {
      goal: null,
      setGoal: (g) => { goals.push(g); bot.pathfinder.goal = g },
      isMoving: () => moving,
      stop: () => {},
    },
    chat: (m) => { chats.push(String(m)) },
    clearControlStates: () => {},
  }
  return bot
}

const SITE = { x: 10, y: 64, z: 20 }
function v2home() {
  return {
    site: { ...SITE },
    built: true,
    v: 2,
    interior: { min: { x: 11, y: 64, z: 21 }, max: { x: 15, y: 65, z: 24 } },
  }
}

// Home-leg bot: door cells + direct-control legs, far positions allowed.
function homeBot({ at, timeOfDay = 6000, moving = false }) {
  const chats = []
  const goals = []
  const bot = {
    chats,
    goals,
    username: 'IdkBot',
    players: {},
    entity: { position: { ...at } },
    time: { timeOfDay, day: 5 },
    pathfinder: {
      goal: null,
      movements: { canDig: true },
      isMoving: () => moving,
      setGoal: (g) => { goals.push(g); bot.pathfinder.goal = g },
      stop: () => {},
    },
    inventory: { items: () => [] },
    blockAt: () => ({ name: 'air', boundingBox: 'empty' }),
    activateBlock: async () => {},
    chat: (m) => { chats.push(String(m)) },
    lookAt: () => {},
    setControlState: () => {},
    clearControlStates: () => {},
  }
  return bot
}

function castleState() {
  return { site: { x: 50, y: 64, z: 50 }, rot: 0, blueprintVersion: 2, phase: 'body', blocked: {}, parked: false }
}

function castleBot({ at, timeOfDay = 6000, moving = false }) {
  const chats = []
  const goals = []
  const bot = {
    chats,
    goals,
    username: 'IdkBot',
    players: {},
    entities: {},
    entity: { position: { ...at }, onGround: true },
    time: { timeOfDay, day: 5 },
    pathfinder: {
      goal: null,
      movements: { canDig: true, allowSprinting: false },
      setGoal(g) { goals.push(g); bot.pathfinder.goal = g || null },
      stop() {},
      isMoving: () => moving,
      setMovements(m) { bot.pathfinder.movements = m },
    },
    inventory: { items: () => [] },
    blockAt: (p) => {
      const fy = Math.floor(p.y)
      if (fy < 64) return { name: 'dirt', boundingBox: 'block' }
      return { name: 'air', boundingBox: 'empty' }
    },
    chat(m) { chats.push(String(m)) },
    lookAt() {},
    setControlState() {},
    clearControlStates() {},
  }
  return bot
}

describe('guided far walk trigger', () => {
  it('night range pins retreat.HOME_WALK_RANGE (no require cycle)', () => {
    const retreat = require('../src/behaviours/retreat')
    assert.equal(worker.WALK_NIGHT_RANGE, retreat.HOME_WALK_RANGE)
  })

  it('never delegates with WORKER_NAME unset', () => {
    worker.configure({}) // unconfigured: all stubs below stay real no-ops
    const bot = unitBot({ at: { x: 0, y: 64, z: 0 } })
    const ctx = { home: v2home(), lastPathStatus: 'noPath' }
    assert.equal(worker.walkShouldDelegate(bot, ctx, 'comehome', { x: 100, y: 64, z: 0 }), false)
  })

  it('never delegates with the worker offline', () => {
    const sends = []
    stubWorker({ sends, entity: { box: null }, online: false })
    const bot = unitBot({ at: { x: 0, y: 64, z: 0 } })
    const ctx = { home: v2home(), lastPathStatus: 'noPath' }
    assert.equal(worker.walkShouldDelegate(bot, ctx, 'comehome', { x: 100, y: 64, z: 0 }), false)
  })

  it('never delegates at or under 32 blocks', () => {
    const sends = []
    stubWorker({ sends, entity: { box: { position: pos(0, 64, 0) } } })
    const bot = unitBot({ at: { x: 0, y: 64, z: 0 } })
    const ctx = { home: v2home(), lastPathStatus: 'noPath' }
    assert.equal(worker.walkShouldDelegate(bot, ctx, 'comehome', { x: 32, y: 64, z: 0 }), false)
    assert.equal(worker.walkShouldDelegate(bot, ctx, 'comehome', { x: 20, y: 64, z: 0 }), false)
  })

  it('never delegates at night far from home', () => {
    const sends = []
    stubWorker({ sends, entity: { box: { position: pos(0, 64, 0) } } })
    const bot = unitBot({ at: { x: 200, y: 64, z: 0 }, timeOfDay: 18000 })
    const ctx = { home: v2home(), lastPathStatus: 'noPath' }
    // 190 from the site: the shelter owns the night.
    assert.equal(worker.walkShouldDelegate(bot, ctx, 'comehome', { x: 300, y: 64, z: 0 }), false)
  })

  it('delegates at night near home, and at dusk far away', () => {
    const sends = []
    stubWorker({ sends, entity: { box: { position: pos(0, 64, 0) } } })
    // Night but 20 from home: the march is legal.
    const nightNear = unitBot({ at: { x: 30, y: 64, z: 20 }, timeOfDay: 18000 })
    assert.equal(worker.walkShouldDelegate(nightNear, { home: v2home(), lastPathStatus: 'timeout' }, 'gohome', { x: 100, y: 64, z: 20 }), true)
    // Dusk marches at any distance.
    const duskFar = unitBot({ at: { x: 200, y: 64, z: 0 }, timeOfDay: 12500 })
    assert.equal(worker.walkShouldDelegate(duskFar, { home: v2home(), lastPathStatus: 'noPath' }, 'comehome', { x: 300, y: 64, z: 0 }), true)
  })

  it('delegates far on noPath/timeout, never on success without a watchdog flat', () => {
    const sends = []
    stubWorker({ sends, entity: { box: { position: pos(0, 64, 0) } } })
    const bot = unitBot({ at: { x: 0, y: 64, z: 0 } })
    const goal = { x: 100, y: 64, z: 0 }
    assert.equal(worker.walkShouldDelegate(bot, { home: v2home(), lastPathStatus: 'noPath' }, 'comehome', goal), true)
    assert.equal(worker.walkShouldDelegate(bot, { home: v2home(), lastPathStatus: 'timeout' }, 'comehome', goal), true)
    assert.equal(worker.walkShouldDelegate(bot, { home: v2home(), lastPathStatus: 'success' }, 'comehome', goal), false)
    assert.equal(worker.walkShouldDelegate(bot, { home: v2home(), lastPathStatus: 'none' }, 'comehome', goal), false)
  })

  it('delegates far on a watchdog flat without a planner verdict', () => {
    const sends = []
    stubWorker({ sends, entity: { box: { position: pos(0, 64, 0) } } })
    const bot = unitBot({ at: { x: 0, y: 64, z: 0 } })
    const goal = { x: 100, y: 64, z: 0 }
    const ctx = { home: v2home(), lastPathStatus: 'success', task: { comehome: { wd: { rounds: 1 } } } }
    assert.equal(worker.walkShouldDelegate(bot, ctx, 'comehome', goal), true)
    // Other kinds do not leak in.
    assert.equal(worker.walkShouldDelegate(bot, ctx, 'gocastle', goal), false)
  })
})

describe('guided far walk guide', () => {
  it('delegate chats once and sends resume+goto XYZ', async () => {
    const sends = []
    const entity = { box: { position: pos(5, 64, 0) } }
    stubWorker({ sends, entity })
    const bot = unitBot({ at: { x: 0, y: 64, z: 0 } })
    const ctx = { home: v2home(), lastGoalKey: 'comehome-walk', lastPathStatus: 'noPath' }
    const rec = { phase: 'walk' }
    worker.walkDelegate(bot, ctx, rec, { x: 100, y: 64, z: 0 }, { kind: 'comehome', label: 'home', key: 'comehome-guided' })
    assert.ok(rec.guided, 'state stashed on the leg record')
    assert.deepEqual(rec.guided.goal, { x: 100, y: 64, z: 0 })
    assert.ok(bot.chats.includes('asking W to guide me home'), `chats: ${bot.chats}`)
    assert.equal(ctx.lastGoalKey, '', 'dead walk goal cleared')
    await flushes()
    assert.deepEqual(sends, ['msg #resume', 'msg #goto 100 64 0'])
  })

  it('delegate goes XZ-only when the leg y is free', async () => {
    const sends = []
    stubWorker({ sends, entity: { box: { position: pos(5, 64, 0) } } })
    const bot = unitBot({ at: { x: 0, y: 64, z: 0 } })
    const ctx = { home: v2home(), lastGoalKey: 'gocastle-far' }
    const rec = { phase: 'walk' }
    worker.walkDelegate(bot, ctx, rec, { x: 50, y: 64, z: 55 }, { kind: 'gocastle', label: 'to the castle', key: 'gocastle-guided', xzOnly: true })
    await flushes()
    assert.deepEqual(sends, ['msg #resume', 'msg #goto 50 55'])
  })

  it('tick follows the worker and re-anchors every 6 s', () => {
    const sends = []
    const wpos = pos(10, 64, 0)
    const entity = { box: { position: wpos } }
    stubWorker({ sends, entity })
    const bot = unitBot({ at: { x: 0, y: 64, z: 0 } })
    const ctx = { home: v2home(), lastGoalKey: '' }
    const rec = { guided: { at: Date.now(), goal: { x: 100, y: 64, z: 0 }, key: 'comehome-guided', paused: false, goneSince: null, lastWorkerPos: null, lastMove: Date.now(), reissuedAt: 0, stopSent: false } }
    // Head 10 out: pause fires on the transition, follow still issues.
    const res = worker.walkTick(bot, ctx, rec, bot.entity.position, () => false)
    assert.equal(res, 'walk')
    assert.equal(ctx.lastGoalKey, 'comehome-guided')
    assert.equal(bot.goals.length, 1)
    assert.equal(bot.goals[0].constructor.name, 'GoalFollow')
    assert.ok(sends.includes('msg #pause'), `sends: ${sends}`)
    // Re-anchor on the stale clock.
    rec.guided.reissuedAt = Date.now() - 7000
    rec.guided.paused = true // pinned: no resume transition (head still 10 out)
    worker.walkTick(bot, ctx, rec, bot.entity.position, () => false)
    assert.equal(bot.goals.length, 2, 'stale follow re-anchored')
  })

  it('leash resumes within 4 and suspends the still clock while paused', () => {
    const sends = []
    const entity = { box: { position: pos(2, 64, 0) } }
    stubWorker({ sends, entity })
    const bot = unitBot({ at: { x: 0, y: 64, z: 0 } })
    const ctx = { home: v2home(), lastGoalKey: 'comehome-guided' }
    const rec = { guided: { at: Date.now(), goal: { x: 100, y: 64, z: 0 }, key: 'comehome-guided', paused: true, goneSince: null, lastWorkerPos: { x: 2, y: 64, z: 0 }, lastMove: Date.now() - 60000, reissuedAt: Date.now(), stopSent: false } }
    const res = worker.walkTick(bot, ctx, rec, bot.entity.position, () => false)
    assert.equal(res, 'walk', 'a 60 s pause never trips the still clock')
    assert.equal(rec.guided.paused, false)
    assert.ok(sends.includes('msg #resume'), `sends: ${sends}`)
  })

  it('gone, still and total deadlines fail after #stop', async () => {
    const setup = () => {
      const sends = []
      const entity = { box: { position: pos(10, 64, 0) } }
      stubWorker({ sends, entity })
      const bot = unitBot({ at: { x: 0, y: 64, z: 0 } })
      const ctx = { home: v2home(), lastGoalKey: 'comehome-guided' }
      const now = Date.now()
      const rec = { guided: { at: now, goal: { x: 100, y: 64, z: 0 }, key: 'comehome-guided', paused: false, goneSince: null, lastWorkerPos: { x: 10, y: 64, z: 0 }, lastMove: now, reissuedAt: now, stopSent: false } }
      return { sends, entity, bot, ctx, rec }
    }
    // Gone 21 s.
    {
      const { sends, entity, bot, ctx, rec } = setup()
      entity.box = null
      rec.guided.goneSince = Date.now() - 21000
      assert.equal(worker.walkTick(bot, ctx, rec, bot.entity.position, () => false), 'failed')
      await flushes()
      assert.ok(sends.includes('msg #stop'), `sends: ${sends}`)
    }
    // Still 31 s (entity present, undisplaced, nowhere near the goal).
    {
      const { sends, bot, ctx, rec } = setup()
      rec.guided.lastMove = Date.now() - 31000
      assert.equal(worker.walkTick(bot, ctx, rec, bot.entity.position, () => false), 'failed')
      await flushes()
      assert.ok(sends.includes('msg #stop'), `sends: ${sends}`)
    }
    // 241 s total.
    {
      const { sends, bot, ctx, rec } = setup()
      rec.guided.at = Date.now() - 241000
      assert.equal(worker.walkTick(bot, ctx, rec, bot.entity.position, () => false), 'failed')
      await flushes()
      assert.ok(sends.includes('msg #stop'), `sends: ${sends}`)
    }
    const metrics = require('../src/metrics')
    const text = await metrics.client.register.metrics()
    assert.match(text, /idkcraft_bot_worker_jobs_total\{kind="walk",outcome="fallback"\} [1-9]/)
  })

  it('a worker waiting at the goal never trips the still clock', () => {
    const sends = []
    const entity = { box: { position: pos(100, 64, 0) } }
    stubWorker({ sends, entity })
    const bot = unitBot({ at: { x: 0, y: 64, z: 0 } })
    const ctx = { home: v2home(), lastGoalKey: 'comehome-guided' }
    const rec = { guided: { at: Date.now(), goal: { x: 100, y: 64, z: 0 }, key: 'comehome-guided', paused: false, goneSince: null, lastWorkerPos: { x: 100, y: 64, z: 0 }, lastMove: Date.now() - 120000, reissuedAt: Date.now(), stopSent: false } }
    const res = worker.walkTick(bot, ctx, rec, bot.entity.position, () => false)
    assert.equal(res, 'walk', 'arrived worker waits; the head is still en route')
    assert.ok(!sends.includes('msg #pause'), 'no leash against a waiting worker')
  })

  it('head arrival ends done after #stop', async () => {
    const sends = []
    stubWorker({ sends, entity: { box: { position: pos(98, 64, 0) } } })
    const bot = unitBot({ at: { x: 99, y: 64, z: 0 } })
    const ctx = { home: v2home(), lastGoalKey: 'comehome-guided' }
    const rec = { guided: { at: Date.now(), goal: { x: 100, y: 64, z: 0 }, key: 'comehome-guided', paused: false, goneSince: null, lastWorkerPos: null, lastMove: Date.now(), reissuedAt: 0, stopSent: false } }
    assert.equal(worker.walkTick(bot, ctx, rec, bot.entity.position, () => true), 'done')
    await flushes()
    assert.ok(sends.includes('msg #stop'), `sends: ${sends}`)
    const metrics = require('../src/metrics')
    const text = await metrics.client.register.metrics()
    assert.match(text, /idkcraft_bot_worker_jobs_total\{kind="walk",outcome="done"\} [1-9]/)
  })

  it('nightfall mid-guide fails the delegation', () => {
    const sends = []
    stubWorker({ sends, entity: { box: { position: pos(10, 64, 0) } } })
    const bot = unitBot({ at: { x: 200, y: 64, z: 0 }, timeOfDay: 18000 })
    const ctx = { home: v2home(), lastGoalKey: 'comehome-guided' }
    const rec = { guided: { at: Date.now(), goal: { x: 300, y: 64, z: 0 }, key: 'comehome-guided', paused: false, goneSince: null, lastWorkerPos: null, lastMove: Date.now(), reissuedAt: 0, stopSent: false } }
    assert.equal(worker.walkTick(bot, ctx, rec, bot.entity.position, () => false), 'failed')
  })
})

describe('guided far walk fallback byte-identity', () => {
  it('comehome: guided failure chats and statuses exactly like the direct failure', () => {
    const at = { x: 150, y: 64, z: 150 } // ~190 from the door: far
    const mkOrder = () => ({ ...home.startMeet('Steve', false, v2home()), stalls: 9, fails: 2, lastPos: { ...at } })
    // Direct: no worker, the walk fails out loud.
    const directBot = homeBot({ at })
    const directCtx = { home: v2home(), lastGoalKey: 'comehome-walk', lastPathStatus: 'noPath', stepStatus: 'running', comehome: mkOrder() }
    home.comehome(directBot, directCtx)
    assert.equal(directCtx.comehome, null, 'direct failure drops the order')
    assert.equal(directCtx.stepStatus, 'failed:cannot-reach-home')
    assert.deepEqual(directBot.chats, ['cannot reach home'])
    // Guided: delegation starts, then the worker vanishes 21 s and the same
    // failure runs.
    const sends = []
    const entity = { box: { position: pos(140, 64, 140) } }
    stubWorker({ sends, entity })
    const bot = homeBot({ at })
    const ctx = { home: v2home(), lastGoalKey: 'comehome-walk', lastPathStatus: 'noPath', stepStatus: 'running', comehome: mkOrder() }
    home.comehome(bot, ctx)
    assert.equal(ctx.comehome.phase, 'guided', 'far noPath delegates instead of failing')
    assert.ok(bot.chats.includes('asking W to guide me home'), `chats: ${bot.chats}`)
    entity.box = null
    ctx.comehome.guided.goneSince = Date.now() - 21000
    home.comehome(bot, ctx)
    assert.equal(ctx.comehome, null, 'guided failure drops the order')
    assert.equal(ctx.stepStatus, 'failed:cannot-reach-home')
    assert.deepEqual(bot.chats.slice(1), ['cannot reach home'], 'one delegation line, then the identical failure')
  })

  it('gohome: guided failure statuses exactly like the direct failure (silent)', () => {
    const at = { x: 150, y: 64, z: 150 }
    const mkSt = () => ({ phase: 'walk', stalls: 9, fails: 2, lastPos: { ...at }, lastToggle: 0, legIdx: 0, legTicks: 0, legPos: null, legStall: 0, backing: 0, viaDone: true, via: null })
    // Direct: silent step failure.
    const directBot = homeBot({ at })
    const directCtx = { home: v2home(), lastGoalKey: 'gohome-walk', lastPathStatus: 'timeout', stepStatus: 'running', step: 'gohome', gohome: mkSt() }
    home.gohome(directBot, directCtx)
    assert.equal(directCtx.gohome.phase, 'failed')
    assert.equal(directCtx.stepStatus, 'failed:cannot-reach-home')
    assert.deepEqual(directBot.chats, [])
    // Guided: delegation starts, the worker stalls 31 s, the same silent
    // failure runs.
    const sends = []
    const entity = { box: { position: pos(140, 64, 140) } }
    stubWorker({ sends, entity })
    const bot = homeBot({ at })
    const ctx = { home: v2home(), lastGoalKey: 'gohome-walk', lastPathStatus: 'timeout', stepStatus: 'running', step: 'gohome', gohome: mkSt() }
    home.gohome(bot, ctx)
    assert.equal(ctx.gohome.phase, 'guided', 'far timeout delegates instead of failing')
    ctx.gohome.guided.lastMove = Date.now() - 31000
    ctx.gohome.guided.lastWorkerPos = { x: 140, y: 64, z: 140 }
    home.gohome(bot, ctx)
    assert.equal(ctx.gohome.phase, 'failed')
    assert.equal(ctx.stepStatus, 'failed:cannot-reach-home')
    assert.deepEqual(bot.chats, ['asking W to guide me home'], 'only the delegation line; the failure stays silent')
  })

  it('gocastle order: guided failure chats and statuses exactly like the direct failure', () => {
    const st = castleState()
    const ent = castleMod.entrance(st)
    const at = { x: ent.x - 100, y: 64, z: ent.z - 100 } // ~140 out: far
    const mkOrder = () => ({ by: 'Steve', castle: { ...st }, phase: 'walk', stalls: 9, fails: 2, lastPos: { ...at } })
    // Direct: no worker, the walk fails out loud.
    const directBot = castleBot({ at })
    const directCtx = { lastGoalKey: 'gocastle-far', lastPathStatus: 'noPath', stepStatus: 'running', gocastle: mkOrder() }
    gocastle(directBot, directCtx)
    assert.equal(directCtx.gocastle, null, 'direct failure drops the order')
    assert.equal(directCtx.stepStatus, 'failed:cannot-reach-castle')
    assert.deepEqual(directBot.chats, ['cannot reach the castle'])
    // Guided: delegation starts, the 240 s total elapses, the same failure.
    const sends = []
    stubWorker({ sends, entity: { box: { position: pos(at.x + 5, 64, at.z + 5) } } })
    const bot = castleBot({ at })
    const ctx = { lastGoalKey: 'gocastle-far', lastPathStatus: 'noPath', stepStatus: 'running', gocastle: mkOrder() }
    gocastle(bot, ctx)
    assert.equal(ctx.gocastle.phase, 'guided', 'far noPath delegates instead of failing')
    ctx.gocastle.guided.at = Date.now() - 241000
    gocastle(bot, ctx)
    assert.equal(ctx.gocastle, null, 'guided failure drops the order')
    assert.equal(ctx.stepStatus, 'failed:cannot-reach-castle')
    assert.deepEqual(bot.chats.slice(1), ['cannot reach the castle'], 'one delegation line, then the identical failure')
  })

  it('guided arrival hands back to the walk, which takes the success path', () => {
    const at = { x: 150, y: 64, z: 150 }
    const sends = []
    // Worker at the door: the head arrives next.
    stubWorker({ sends, entity: { box: { position: pos(13, 64, 19) } } })
    const bot = homeBot({ at })
    const ctx = { home: v2home(), lastGoalKey: 'comehome-guided', lastPathStatus: 'noPath', stepStatus: 'running', comehome: { ...home.startMeet('Steve', false, v2home()), phase: 'guided' } }
    ctx.comehome.guided = { at: Date.now(), goal: { x: 13, y: 64, z: 19 }, key: 'comehome-guided', paused: false, goneSince: null, lastWorkerPos: null, lastMove: Date.now(), reissuedAt: 0, stopSent: false }
    // Still far: keep guiding.
    home.comehome(bot, ctx)
    assert.equal(ctx.comehome.phase, 'guided')
    // At the door: done, back to the walk, which opens next tick (no door
    // block in this mock, so open falls straight through to enter).
    bot.entity.position = { x: 13.5, y: 64, z: 19.5 }
    home.comehome(bot, ctx)
    assert.equal(ctx.comehome.phase, 'walk', 'arrival resumes the walk')
    assert.equal(ctx.comehome.guided, null)
    home.comehome(bot, ctx)
    assert.equal(ctx.comehome.phase, 'enter', 'the walk success path takes over')
  })
})
