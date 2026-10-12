'use strict'

// Guided dig-in (idkcraft-jlda.4): a buried walk stall delegates the TUNNEL
// to the Baritone worker — resume+goto, follow it through, step it back,
// dig. The worker module is stubbed (sends recorded, entity scripted);
// with no worker the pinned refusal lines are byte-identical.

const { describe, it, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const bring = require('../src/behaviours/bring')
const { guidedTarget, guidedStepback, guidedSameSide, pickSpare, stopGuidedWork } = require('../src/behaviours/bring')
const worker = require('../src/worker')
const { createTicker } = require('../src/index')

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

// sends records every bridge line; entity scripts the worker entity.
function stubWorker({ sends, entity, online = true }) {
  worker.configured = () => true
  worker.name = () => 'W'
  worker.workerOnline = () => online
  worker.workerEntity = () => entity.box
  worker.send = async (line) => { sends.push(String(line)); return true }
}

function pos(x, y, z) {
  const p = {
    x, y, z,
    distanceTo: (q) => Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z),
    clone() { return pos(p.x, p.y, p.z) },
  }
  return p
}

const BLOCKS = { coal_ore: 11, stone: 1, iron_ore: 31 }
const ITEMS = { stone_pickaxe: 22, wooden_pickaxe: 23, iron_pickaxe: 24 }

function mockBot({ spots = [], names = {}, items = [], playerPos = null } = {}) {
  const lines = []
  const tossCalls = []
  const calls = { setGoal: 0, goals: [] }
  const blocksByName = {}
  for (const [name, id] of Object.entries(BLOCKS)) blocksByName[name] = { id }
  const itemsByName = {}
  for (const [name, id] of Object.entries(ITEMS)) itemsByName[name] = { id }
  const bot = {
    lines, tossCalls, calls,
    username: 'IdkBot',
    entities: {},
    health: 20,
    food: 20,
    time: { timeOfDay: 6000 },
    entity: { position: pos(0, 64, 0), onGround: true },
    registry: { blocksByName, itemsByName },
    players: { P: { username: 'P', entity: playerPos ? { position: playerPos } : null } },
    _moving: false,
    _items: items,
    pathfinder: {
      goal: null,
      setGoal: (goal) => { calls.setGoal++; calls.goals.push(goal); bot.pathfinder.goal = goal },
      isMoving: () => bot._moving,
      bestHarvestTool: () => ({ name: 'stone_pickaxe', type: 99 }),
    },
    held: null,
    equip: async (item) => { bot.held = item && item.name },
    inventory: { items: () => bot._items },
    findBlocks(opts) {
      const want = new Set(Array.isArray(opts.matching) ? opts.matching : [opts.matching])
      return spots.filter((q) => {
        const n = names[`${q.x},${q.y},${q.z}`]
        const id = n && blocksByName[n] ? blocksByName[n].id : undefined
        return want.has(id)
      })
    },
    blockAt(p) {
      const n = names[`${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`]
      return n ? { name: n, position: pos(p.x, p.y, p.z) } : null
    },
    canDigBlock: () => true,
    toss: async (id, meta, n) => { tossCalls.push([id, meta, n]) },
    chat(line) { lines.push(String(line)) },
  }
  return bot
}

function tickerFor(bot) {
  return createTicker({
    bot,
    brain: { decide: async () => ({ action: 'idle', sprint: false, source: 'stub' }) },
    tickMs: 10,
    idleTickMs: 10,
  })
}

const flush = () => new Promise((resolve) => setImmediate(resolve))
const flushes = async (n = 4) => { for (let i = 0; i < n; i++) await flush() }

function buriedOrder() {
  return {
    name: 'iron', want: 3, by: 'P', block: 'iron_ore', drop: 'raw_iron',
    pos: pos(10, 64, 0), phase: 'walk', stalls: 0, lastPos: null,
    have: 0, announced: true, exposed: false,
  }
}

describe('guided dig-in', () => {
  it('a buried stall delegates the bore: resume+goto, follow key, leash pause', async () => {
    const sends = []
    const entity = { box: { position: pos(-10, 64, 0) } } // head side: bores at once
    stubWorker({ sends, entity })
    const bot = mockBot({
      spots: [pos(10, 64, 0)],
      names: { '10,64,0': 'iron_ore' },
      items: [{ name: 'stone_pickaxe', count: 1 }],
      playerPos: pos(40, 64, 0),
    })
    bot._moving = true
    tickerFor(bot)
    const c = bot._tickerCtx
    c.bring = buriedOrder()
    for (let i = 0; i < 12 && c.bring && c.bring.phase === 'walk'; i++) bring(bot, c, null, {})
    assert.equal(c.bring.phase, 'guided', 'stall delegated instead of refusing')
    assert.equal(c.bring.guided.phase, 'bore', 'one pickaxe, same side: straight to the bore')
    assert.ok(bot.lines.includes('asking W to dig in to iron_ore at 10 64 0'), `lines: ${bot.lines}`)
    await flushes()
    assert.deepEqual(sends, ['msg #resume', 'msg #goto 9 64 0'], 'bore face toward the head')
    bring(bot, c, null, {}) // bore tick: worker 10 out, head follows leashed
    await flushes()
    assert.equal(c.lastGoalKey, 'bring-guided:10,64,0')
    assert.ok(sends.includes('msg #pause'), `sends: ${sends}`)
  })

  it('a far-side worker meets the head first, then bores', async () => {
    const sends = []
    const entity = { box: { position: pos(30, 64, 0) } } // far side of the ore
    stubWorker({ sends, entity })
    const bot = mockBot({
      spots: [pos(10, 64, 0)],
      names: { '10,64,0': 'iron_ore' },
      items: [{ name: 'stone_pickaxe', count: 1 }],
      playerPos: pos(40, 64, 0),
    })
    bot._moving = true
    tickerFor(bot)
    const c = bot._tickerCtx
    c.bring = buriedOrder()
    for (let i = 0; i < 12 && c.bring && c.bring.phase === 'walk'; i++) bring(bot, c, null, {})
    assert.equal(c.bring.guided.phase, 'meet', 'far side: meet before the bore')
    await flushes()
    assert.deepEqual(sends, ['msg #resume', 'msg #goto 0 64 0'], 'worker called to the head')
    entity.box.position = pos(0, 64, 0) // at the head: bore from the head side
    bring(bot, c, null, {})
    await flushes()
    assert.equal(c.bring.guided.phase, 'bore')
    assert.deepEqual(sends.slice(-1), ['msg #goto 9 64 0'])
  })

  it('an exposed stall never delegates, even with a worker online', async () => {
    const sends = []
    stubWorker({ sends, entity: { box: { position: pos(-10, 64, 0) } } })
    const bot = mockBot({
      spots: [pos(10, 64, 0)],
      names: { '10,64,0': 'iron_ore' },
      items: [{ name: 'stone_pickaxe', count: 1 }],
      playerPos: pos(40, 64, 0),
    })
    bot._moving = true
    tickerFor(bot)
    const c = bot._tickerCtx
    c.bring = { ...buriedOrder(), exposed: true }
    for (let i = 0; i < 12 && c.bring; i++) bring(bot, c, null, {})
    assert.equal(c.bring, null, 'order refused')
    assert.ok(bot.lines.includes('could not reach iron_ore'), `lines: ${bot.lines}`)
    await flushes()
    assert.deepEqual(sends, [], 'exposed path sends nothing')
  })

  it('no worker configured: the buried refusal is byte-identical', async () => {
    const sends = []
    worker.send = async (line) => { sends.push(String(line)); return true } // record only; configured stays false
    const bot = mockBot({
      spots: [pos(10, 64, 0)],
      names: { '10,64,0': 'iron_ore' },
      items: [{ name: 'stone_pickaxe', count: 1 }],
      playerPos: pos(40, 64, 0),
    })
    bot._moving = true
    tickerFor(bot)
    const c = bot._tickerCtx
    c.bring = buriedOrder()
    for (let i = 0; i < 12 && c.bring; i++) bring(bot, c, null, {})
    assert.equal(c.bring, null, 'order refused')
    assert.ok(bot.lines.includes('could not reach iron_ore (buried, no path in) at 10 64 0'), `lines: ${bot.lines}`)
    await flushes()
    assert.deepEqual(sends, [], 'unconfigured worker sends nothing')
  })

  it('configured but offline worker: refusal, no sends', async () => {
    const sends = []
    stubWorker({ sends, entity: { box: null }, online: false })
    const bot = mockBot({
      spots: [pos(10, 64, 0)],
      names: { '10,64,0': 'iron_ore' },
      items: [{ name: 'stone_pickaxe', count: 1 }],
      playerPos: pos(40, 64, 0),
    })
    bot._moving = true
    tickerFor(bot)
    const c = bot._tickerCtx
    c.bring = buriedOrder()
    for (let i = 0; i < 12 && c.bring; i++) bring(bot, c, null, {})
    assert.equal(c.bring, null, 'order refused')
    assert.ok(bot.lines.includes('could not reach iron_ore (buried, no path in) at 10 64 0'), `lines: ${bot.lines}`)
    await flushes()
    assert.deepEqual(sends, [], 'offline worker sends nothing')
  })

  it('the leash only sends on transitions', () => {
    const sends = []
    const entity = { box: { position: pos(-30, 64, 0) } }
    stubWorker({ sends, entity })
    const bot = mockBot({ names: { '10,64,0': 'iron_ore' }, items: [{ name: 'stone_pickaxe', count: 1 }] })
    tickerFor(bot)
    const c = bot._tickerCtx
    const now = Date.now()
    c.bring = {
      ...buriedOrder(), phase: 'guided',
      guided: {
        at: now, target: { x: 9, y: 64, z: 0 }, phase: 'bore',
        paused: false, goneSince: null, lastWorkerPos: { x: -30, y: 64, z: 0 }, lastMove: now,
        reissuedAt: 0, held: false, stopSent: false,
      },
    }
    bring(bot, c, null, {})
    assert.deepEqual(sends, ['msg #pause'])
    entity.box.position = pos(-31, 64, 0) // still far, still moving: no resend
    bring(bot, c, null, {})
    assert.deepEqual(sends, ['msg #pause'])
    entity.box.position = pos(-2, 64, 0) // back within 4: resume once
    bring(bot, c, null, {})
    assert.deepEqual(sends, ['msg #pause', 'msg #resume'])
    entity.box.position = pos(-3, 64, 0)
    bring(bot, c, null, {})
    assert.deepEqual(sends, ['msg #pause', 'msg #resume'])
    assert.equal(c.bring.phase, 'guided', 'leash never ends the job')
  })

  it('arrival steps the worker back along the face, clear runs dig, pickup stops it', async () => {
    const sends = []
    const entity = { box: { position: pos(-30, 64, 0) } }
    stubWorker({ sends, entity })
    const bot = mockBot({
      names: { '10,64,0': 'iron_ore' },
      items: [{ name: 'stone_pickaxe', count: 1 }],
      playerPos: pos(40, 64, 0),
    })
    tickerFor(bot)
    const c = bot._tickerCtx
    const now = Date.now()
    c.bring = {
      ...buriedOrder(), phase: 'guided',
      guided: {
        at: now, target: { x: 9, y: 64, z: 0 }, phase: 'bore',
        paused: false, goneSince: null, lastWorkerPos: { x: -30, y: 64, z: 0 }, lastMove: now,
        reissuedAt: 0, held: false, stopSent: false,
      },
    }
    entity.box.position = pos(9, 64, 0) // at the bore target
    bring(bot, c, null, {})
    await flushes()
    assert.equal(c.bring.guided.phase, 'stepback')
    // back along the face axis away from the ore: never through the ore cell
    assert.deepEqual(sends.slice(-2), ['msg #resume', 'msg #goto 5 64 0'])
    entity.box.position = pos(5, 64, 0) // 4 from the target: clear
    bring(bot, c, null, {})
    assert.equal(c.bring.phase, 'dig', 'clear worker hands the head the dig')
    const metrics = require('../src/metrics')
    const text = await metrics.client.register.metrics()
    assert.match(text, /idkcraft_bot_worker_jobs_total\{kind="bore",outcome="done"\} [1-9]/)
    // pickup completion stops the worker, then the order continues
    c.bring.phase = 'pickup'
    c.lastGoalKey = 'bring-pickup:10,64,0'
    bring(bot, c, null, {})
    await flushes()
    assert.ok(sends.includes('msg #stop'), `sends: ${sends}`)
    assert.equal(c.bring.phase, 'find', 'short of want: next target')
  })

  it('a gone worker in stepback cannot block the dig', () => {
    const sends = []
    const entity = { box: null }
    stubWorker({ sends, entity })
    const bot = mockBot({ names: { '10,64,0': 'iron_ore' }, items: [{ name: 'stone_pickaxe', count: 1 }] })
    tickerFor(bot)
    const c = bot._tickerCtx
    c.bring = {
      ...buriedOrder(), phase: 'guided',
      guided: {
        at: Date.now(), target: { x: 9, y: 64, z: 0 }, phase: 'stepback',
        paused: false, goneSince: null, lastWorkerPos: { x: 9, y: 64, z: 0 }, lastMove: Date.now(),
        reissuedAt: 0, held: false, stopSent: false,
      },
    }
    bring(bot, c, null, {})
    assert.equal(c.bring.phase, 'dig', 'tunnel bored: dig without the worker')
  })

  it('gone, still and total deadlines refuse byte-identical after #stop', async () => {
    const line = 'could not reach iron_ore (buried, no path in) at 10 64 0'
    const setup = () => {
      const sends = []
      const entity = { box: { position: pos(-30, 64, 0) } }
      stubWorker({ sends, entity })
      const bot = mockBot({ names: { '10,64,0': 'iron_ore' }, items: [{ name: 'stone_pickaxe', count: 1 }] })
      tickerFor(bot)
      const c = bot._tickerCtx
      const now = Date.now()
      c.bring = {
        ...buriedOrder(), phase: 'guided',
        guided: {
          at: now, target: { x: 9, y: 64, z: 0 }, phase: 'bore',
          paused: false, goneSince: null, lastWorkerPos: { x: -30, y: 64, z: 0 }, lastMove: now,
          reissuedAt: 0, held: false, stopSent: false,
        },
      }
      return { sends, entity, bot, c }
    }
    // gone 21 s
    {
      const { sends, entity, bot, c } = setup()
      entity.box = null
      c.bring.guided.goneSince = Date.now() - 21000
      bring(bot, c, null, {})
      assert.equal(c.bring, null, 'gone refuses')
      assert.ok(bot.lines.includes(line), `lines: ${bot.lines}`)
      assert.ok(sends.includes('msg #stop'), `sends: ${sends}`)
    }
    // still 31 s (entity present, undisplaced)
    {
      const { sends, bot, c } = setup()
      c.bring.guided.lastMove = Date.now() - 31000
      bring(bot, c, null, {})
      assert.equal(c.bring, null, 'still refuses')
      assert.ok(bot.lines.includes(line), `lines: ${bot.lines}`)
      assert.ok(sends.includes('msg #stop'), `sends: ${sends}`)
    }
    // 181 s total
    {
      const { sends, bot, c } = setup()
      c.bring.guided.at = Date.now() - 181000
      bring(bot, c, null, {})
      assert.equal(c.bring, null, 'total refuses')
      assert.ok(bot.lines.includes(line), `lines: ${bot.lines}`)
      assert.ok(sends.includes('msg #stop'), `sends: ${sends}`)
    }
    await flushes()
    const metrics = require('../src/metrics')
    const text = await metrics.client.register.metrics()
    assert.match(text, /idkcraft_bot_worker_jobs_total\{kind="bore",outcome="fallback"\} [1-9]/)
  })

  it('a still worker does not trip the deadline while leash-paused', () => {
    const sends = []
    const entity = { box: { position: pos(-30, 64, 0) } }
    stubWorker({ sends, entity })
    const bot = mockBot({ names: { '10,64,0': 'iron_ore' }, items: [{ name: 'stone_pickaxe', count: 1 }] })
    tickerFor(bot)
    const c = bot._tickerCtx
    const now = Date.now()
    c.bring = {
      ...buriedOrder(), phase: 'guided',
      guided: {
        at: now, target: { x: 9, y: 64, z: 0 }, phase: 'bore',
        paused: true, goneSince: null, lastWorkerPos: { x: -30, y: 64, z: 0 }, lastMove: now - 60000,
        reissuedAt: 0, held: false, stopSent: false,
      },
    }
    bring(bot, c, null, {})
    assert.equal(c.bring.phase, 'guided', 'paused stillness is leashed, not stuck')
    assert.deepEqual(sends, [], 'no transition, no send')
  })

  it('the resume transition restarts the still clock', () => {
    const sends = []
    const entity = { box: { position: pos(-2, 64, 0) } } // within 4: resumes
    stubWorker({ sends, entity })
    const bot = mockBot({ names: { '10,64,0': 'iron_ore' }, items: [{ name: 'stone_pickaxe', count: 1 }] })
    tickerFor(bot)
    const c = bot._tickerCtx
    const now = Date.now()
    c.bring = {
      ...buriedOrder(), phase: 'guided',
      guided: {
        at: now, target: { x: 9, y: 64, z: 0 }, phase: 'bore',
        paused: true, goneSince: null, lastWorkerPos: { x: -2, y: 64, z: 0 }, lastMove: now - 60000,
        reissuedAt: 0, held: false, stopSent: false,
      },
    }
    bring(bot, c, null, {})
    assert.deepEqual(sends, ['msg #resume'])
    assert.equal(c.bring.phase, 'guided')
    bring(bot, c, null, {}) // worker unmoved, but the clock restarted at resume
    assert.equal(c.bring.phase, 'guided', 'a long pause must not cancel the tick after resume')
  })

  it('first delegation with a spare meets and lends the pickaxe, then bores', async () => {
    const sends = []
    const entity = { box: { position: pos(30, 64, 0) } }
    stubWorker({ sends, entity })
    const bot = mockBot({
      spots: [pos(10, 64, 0)],
      names: { '10,64,0': 'iron_ore' },
      items: [{ name: 'stone_pickaxe', count: 1 }, { name: 'wooden_pickaxe', count: 1 }],
      playerPos: pos(40, 64, 0),
    })
    bot._moving = true
    tickerFor(bot)
    const c = bot._tickerCtx
    c.bring = buriedOrder()
    for (let i = 0; i < 12 && c.bring && c.bring.phase === 'walk'; i++) bring(bot, c, null, {})
    assert.equal(c.bring.guided.phase, 'meet', 'spare pickaxe: meet first')
    await flushes()
    assert.deepEqual(sends, ['msg #resume', 'msg #goto 0 64 0'], 'worker called to the head')
    entity.box.position = pos(0, 64, 0) // at the head's feet
    bring(bot, c, null, {})
    await flushes(6)
    assert.deepEqual(bot.tossCalls, [[ITEMS.wooden_pickaxe, null, 1]], 'lends the worst pickaxe, keeps the best')
    assert.equal(c.workerTooled, true, 'once per session')
    assert.equal(c.bring.guided.phase, 'bore')
    assert.deepEqual(sends.slice(-1), ['msg #goto 9 64 0'])
  })

  it('a toss that lands after the cancel never re-tasks the worker', async () => {
    const sends = []
    const entity = { box: { position: pos(0, 64, 0) } }
    stubWorker({ sends, entity })
    const bot = mockBot({
      names: { '10,64,0': 'iron_ore' },
      items: [{ name: 'stone_pickaxe', count: 1 }, { name: 'wooden_pickaxe', count: 1 }],
    })
    tickerFor(bot)
    const c = bot._tickerCtx
    c.bring = {
      ...buriedOrder(), phase: 'guided',
      guided: {
        at: Date.now(), target: { x: 9, y: 64, z: 0 }, phase: 'meet',
        tool: { name: 'wooden_pickaxe', id: ITEMS.wooden_pickaxe }, headPos: { x: 0, y: 64, z: 0 },
        paused: false, goneSince: null, lastWorkerPos: null, lastMove: Date.now(),
        reissuedAt: 0, held: true, tossInFlight: false, stopSent: false,
      },
    }
    bring(bot, c, null, {}) // arrival starts the toss
    c.bring = null // stop lands while the toss is in flight
    await flushes(6)
    assert.deepEqual(sends, [], 'no bore for a dead job')
  })

  it('meet timeout bores without the lend', async () => {
    const sends = []
    const entity = { box: { position: pos(30, 64, 0) } }
    stubWorker({ sends, entity })
    const bot = mockBot({
      names: { '10,64,0': 'iron_ore' },
      items: [{ name: 'stone_pickaxe', count: 1 }, { name: 'wooden_pickaxe', count: 1 }],
    })
    tickerFor(bot)
    const c = bot._tickerCtx
    c.bring = {
      ...buriedOrder(), phase: 'guided',
      guided: {
        at: Date.now() - 31000, target: { x: 9, y: 64, z: 0 }, phase: 'meet',
        tool: { name: 'wooden_pickaxe', id: ITEMS.wooden_pickaxe }, headPos: { x: 0, y: 64, z: 0 },
        paused: false, goneSince: null, lastWorkerPos: null, lastMove: Date.now(),
        reissuedAt: 0, held: false, tossInFlight: false, stopSent: false,
      },
    }
    bring(bot, c, null, {})
    await flushes()
    assert.equal(c.bring.guided.phase, 'bore', 'worker never came: bore from wherever')
    assert.deepEqual(bot.tossCalls, [], 'nothing lent')
    assert.deepEqual(sends.slice(-1), ['msg #goto 9 64 0'])
  })

  it('dusk cancel of a guided self order stops the worker and counts cancelled', async () => {
    const sends = []
    stubWorker({ sends, entity: { box: { position: pos(-30, 64, 0) } } })
    const bot = mockBot({ names: { '10,64,0': 'iron_ore' }, items: [{ name: 'stone_pickaxe', count: 1 }] })
    bot.time.timeOfDay = 18000
    tickerFor(bot)
    const c = bot._tickerCtx
    c.bring = {
      ...buriedOrder(), self: true, phase: 'guided',
      guided: {
        at: Date.now(), target: { x: 9, y: 64, z: 0 }, phase: 'bore',
        paused: false, goneSince: null, lastWorkerPos: null, lastMove: Date.now(),
        reissuedAt: 0, held: false, tossInFlight: false, stopSent: false,
      },
    }
    await bring(bot, c, null, {})
    await flushes()
    assert.equal(c.bring, null, 'order dropped at dusk')
    assert.ok(sends.includes('msg #stop'), `sends: ${sends}`)
    const metrics = require('../src/metrics')
    const text = await metrics.client.register.metrics()
    assert.match(text, /idkcraft_bot_worker_jobs_total\{kind="bore",outcome="cancelled"\} [1-9]/)
  })

  it('stopGuidedWork parks once, then goes quiet', async () => {
    const sends = []
    stubWorker({ sends, entity: { box: null } })
    const c = { bring: { ...buriedOrder(), guided: { stopSent: false } } }
    assert.equal(stopGuidedWork(c), true)
    await flushes()
    assert.deepEqual(sends, ['msg #stop'])
    assert.equal(stopGuidedWork(c), false, 'second call is a no-op')
    assert.equal(stopGuidedWork({ bring: buriedOrder() }), false, 'unguided order: nothing to park')
    assert.equal(stopGuidedWork({}), false, 'no order: nothing to park')
    await flushes()
    assert.deepEqual(sends, ['msg #stop'])
  })

  it('guidedTarget bores the head-side face, never through the ore', () => {
    const ore = pos(10, 64, 0)
    const west = pos(0, 64, 0) // head west of the ore
    const open = mockBot({ names: { '10,64,0': 'iron_ore' } })
    assert.deepEqual(guidedTarget(open, ore, west), { x: 9, y: 64, z: 0 }, 'head-face air')
    const solid = mockBot({
      names: {
        '10,64,0': 'iron_ore',
        '11,64,0': 'stone', '9,64,0': 'stone', '10,64,1': 'stone',
        '10,64,-1': 'stone', '10,63,0': 'stone', '10,65,0': 'stone',
      },
    })
    assert.deepEqual(guidedTarget(solid, ore, west), { x: 9, y: 64, z: 0 }, 'buried solid: head face')
    const above = mockBot({ names: { '10,64,0': 'iron_ore' } })
    assert.deepEqual(guidedTarget(above, ore, pos(10, 70, 0)), { x: 10, y: 65, z: 0 }, 'head above: top face')
    const mate = mockBot({
      names: {
        '10,64,0': 'iron_ore', '9,64,0': 'iron_ore',
        '11,64,0': 'stone', '10,64,1': 'stone', '10,64,-1': 'stone', '10,63,0': 'stone', '10,65,0': 'stone',
      },
    })
    assert.deepEqual(guidedTarget(mate, ore, west), { x: 10, y: 65, z: 0 }, 'mate on the head face: perpendicular stone')
    const awayAir = mockBot({ names: { '10,64,0': 'iron_ore', '9,64,0': 'stone', '10,64,1': 'stone', '10,64,-1': 'stone', '10,63,0': 'stone', '10,65,0': 'stone' } })
    assert.deepEqual(guidedTarget(awayAir, ore, west), { x: 9, y: 64, z: 0 }, 'away air never wins over head-side stone')
  })

  it('guidedStepback walks the face axis out, guidedSameSide splits the hemispheres', () => {
    assert.deepEqual(guidedStepback({ x: 9, y: 64, z: 0 }, pos(10, 64, 0)), { x: 5, y: 64, z: 0 })
    assert.deepEqual(guidedStepback({ x: 59, y: 57, z: -205 }, pos(59, 56, -205)), { x: 59, y: 61, z: -205 })
    const ore = pos(10, 64, 0)
    assert.equal(guidedSameSide(pos(-10, 64, 0), pos(0, 64, 0), ore), true, 'worker west, head west')
    assert.equal(guidedSameSide(pos(30, 64, 0), pos(0, 64, 0), ore), false, 'worker east, head west')
    assert.equal(guidedSameSide(null, pos(0, 64, 0), ore), false, 'unknown worker meets')
  })

  it('pickSpare wants two pickaxes and lends the worst', () => {
    assert.equal(pickSpare(mockBot({ items: [{ name: 'stone_pickaxe', count: 1 }] })), null)
    assert.equal(pickSpare(mockBot({ items: [] })), null)
    assert.deepEqual(
      pickSpare(mockBot({ items: [{ name: 'stone_pickaxe', count: 1 }, { name: 'wooden_pickaxe', count: 1 }] })),
      { name: 'wooden_pickaxe', id: ITEMS.wooden_pickaxe },
    )
    assert.deepEqual(
      pickSpare(mockBot({ items: [{ name: 'iron_pickaxe', count: 2 }] })),
      { name: 'iron_pickaxe', id: ITEMS.iron_pickaxe },
    )
  })
})
