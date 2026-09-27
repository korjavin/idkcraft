'use strict'

// E2E scenarios for merged behaviours (idkcraft-jht, tests-only): the
// owner-facing arcs behind 0ay (taking-fire retreat ask), atl.12
// (shelter-run holds fight), rw4.12 (forage-leg detour) and rw4.14 (two
// dawn lines), each through real ticker ticks. A failing scenario on
// master is a live bug, not a bad test.

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const { createTicker } = require('../src/index')

// --- rw4.14: two dawn lines, no leak across days ---

const SITE = { x: 10, y: 64, z: 20 }
const DOOR = { x: 11, y: 64, z: 20 }
const OUTSIDE = { x: 11, y: 64, z: 19 }
const INSIDE = { x: 11, y: 64, z: 21 }

function nightBot() {
  const chats = []
  const state = { doorOpen: false }
  const bot = {
    chats,
    username: 'IdkBot',
    players: {},
    entities: {},
    health: 20,
    food: 20,
    entity: { position: { x: 12, y: 64, z: 22 }, onGround: true },
    time: { timeOfDay: 12500, day: 5 },
    pathfinder: {
      goal: null,
      movements: { canDig: true },
      isMoving: () => false,
      setGoal(g) { bot.pathfinder.goal = g },
      stop() {},
    },
    inventory: { items: () => [] },
    blockAt: (p) => {
      const fx = Math.floor(p.x)
      const fy = Math.floor(p.y)
      const fz = Math.floor(p.z)
      if (fx === DOOR.x && (fy === DOOR.y || fy === DOOR.y + 1) && fz === DOOR.z) {
        return { name: 'oak_door', position: { x: fx, y: fy, z: fz }, getProperties: () => ({ open: state.doorOpen }) }
      }
      return { name: 'air', boundingBox: 'empty', position: { x: fx, y: fy, z: fz } }
    },
    activateBlock: async () => { state.doorOpen = !state.doorOpen },
    chat: (m) => { chats.push(String(m)) },
    lookAt() {},
    setControlState() {},
    clearControlStates() {},
    getControlState: () => false,
  }
  return bot
}

function ctxHome() {
  return {
    site: { ...SITE },
    built: true,
    interior: { min: { x: 11, y: 64, z: 21 }, max: { x: 12, y: 65, z: 22 } },
  }
}

describe('rw4.14: two dawn lines tell two nights', () => {
  it('night 1 reports deaths+haul, night 2 reports only its own', async () => {
    // Night 1: 2 deaths + 14 coal. Day: 1 day death + 40 day coal (haul
    // spans dawn to dawn, deaths do not). Night 2 quiet. Each dawn line
    // covers exactly its night.
    const bot = nightBot()
    const ticker = createTicker({
      bot,
      brain: { async decide() { return { action: 'idle', sprint: false, source: 'stub' } } },
      tickMs: 10,
      idleTickMs: 10,
      autonomous: true,
    })
    const ctx = bot._tickerCtx
    ctx.work = true
    ctx.home = ctxHome()
    ctx.deaths = 5
    ctx.haul = { coal: 20 }
    const realNow = Date.now
    let now = realNow()
    Date.now = () => now
    const closeOut = async () => {
      bot.time.timeOfDay = 1000 // dawn
      await ticker.tick() // open: toggle the closed door
      await ticker.tick() // door open while inside: exit starts
      bot.entity.position = { ...OUTSIDE } // stepped out
      await ticker.tick() // exit arrives -> close
      now += 5000
      await ticker.tick() // close the door
      await ticker.tick() // shut -> done + report
    }
    try {
      await ticker.tick() // dusk 1: stay holds, tally snapshots
      bot.time.timeOfDay = 14000
      await ticker.tick()
      ticker.noteDeath()
      ticker.noteDeath()
      ctx.haul = { coal: 34 }
      await ticker.tick()
      await closeOut() // dawn 1
      assert.equal(ctx.stepStatus, 'done')
      // Day 2: the world moves on without reports.
      bot.time.day = 6
      bot.time.timeOfDay = 6000
      ticker.noteDeath() // a day death: never in a night line
      ctx.haul = { coal: 74 } // day forage banks 40
      await ticker.tick()
      assert.ok(bot.chats.filter((m) => m.startsWith('night: ')).length === 1, 'no day report')
      // Dusk 2: back inside (walked home), a new night opens a new tally.
      bot.time.timeOfDay = 12500
      bot.entity.position = { ...INSIDE }
      await ticker.tick()
      bot.time.timeOfDay = 14000
      await ticker.tick() // quiet night
      await closeOut() // dawn 2
      assert.deepEqual(
        bot.chats.filter((m) => m.startsWith('night: ')),
        [
          'night: survived, 2 deaths, banked 14 coal, at home; back to work',
          'night: survived, no deaths, banked 40 coal, at home; back to work',
        ],
        bot.chats.join(' | '))
    } finally {
      Date.now = realNow
      ticker.destroy()
    }
  })
})

// --- 0ay: the taking-fire ask through ticks ---

const { hybridBrain } = require('../src/brain')

function fpos(x, y, z) {
  return {
    x, y, z,
    distanceTo: (q) => Math.hypot(x - q.x, y - q.y, z - q.z),
    clone() { return fpos(x, y, z) },
  }
}

function fkey(x, y, z) { return `${x},${y},${z}` }

function fireBot() {
  // Open field, solid floor, zombie at ~4.5 blocks (prod 11:50 shape),
  // dirt on hand so pillar stands beside retreat in the menu.
  const ground = new Set()
  for (let x = -4; x <= 4; x++) {
    for (let z = -4; z <= 4; z++) ground.add(fkey(x, 63, z))
  }
  const calls = { chats: [] }
  const bot = {
    calls,
    username: 'IdkBot',
    players: {},
    entities: { 1: { id: 1, name: 'zombie', type: 'mob', position: fpos(5, 64, 0), isValid: true } },
    health: 20,
    food: 20,
    entity: { position: fpos(0.5, 64, 0.5), onGround: true },
    time: { timeOfDay: 6000, day: 5 },
    inventory: { items: () => [{ name: 'dirt', count: 10 }] },
    blockAt(p) {
      const k = fkey(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z))
      const solidCell = ground.has(k)
      return { name: solidCell ? 'dirt' : 'air', position: { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) }, boundingBox: solidCell ? 'block' : 'empty' }
    },
    pathfinder: {
      goal: null,
      setGoal(g) { bot.pathfinder.goal = g },
      stop() {},
      isMoving: () => false,
      setMovements() {},
    },
    setControlState() {},
    clearControlStates() {},
    getControlState: () => false,
    chat: (l) => { calls.chats.push(String(l)) },
  }
  return bot
}

describe('0ay: taking fire asks under the under-fire premise', () => {
  it('hurt + unreachable-close asks taking-fire and dispatches the pick', async () => {
    // Two feasible options (retreat + pillar): the model is asked with
    // the taking-fire state and premise, answers pillar, the bot chats
    // the retreat and dispatches it.
    const bot = fireBot()
    const asks = []
    const remote = {
      name: 'laya',
      source: 'laya',
      async decide() { return { action: 'idle', sprint: false, source: 'laya' } },
      async ask(q) { asks.push(q); return asks.length === 1 ? 'no' : 'pillar' },
    }
    const ticker = createTicker({ bot, brain: hybridBrain(remote), tickMs: 10, idleTickMs: 10, autonomous: true })
    ticker.work()
    try {
      await ticker.tick() // hp 20: arms lastTickHp
      const ctx = bot._tickerCtx
      ctx.fightGivenUpId = 1 // fight wrote the mob off: unreachable
      bot.health = 19 // hurt lands between ticks
      const r = await ticker.tick()
      assert.equal(asks.length, 2, 'retreat asked, declined, pillar asked')
      assert.ok(asks[0].state.startsWith('taking fire (19/20)'), `under-fire state, got: ${asks[0].state}`)
      assert.ok(asks[0].instructions.includes('unreachable hostile'), `under-fire premise, got: ${asks[0].instructions}`)
      assert.equal(r.decision.action, 'pillar')
      assert.ok(bot.calls.chats.some((m) => m === 'retreating: pillaring up (laya)'), bot.calls.chats.join(' | '))
    } finally {
      ticker.destroy()
    }
  })

  it('an all-declined chain latches: no re-ask while the situation holds', async () => {
    // The model declines every option: the chain stamps its bucket and
    // the tick falls through to the goal arbiter; the next identical
    // tick asks nothing.
    const bot = fireBot()
    let askCalls = 0
    const remote = {
      name: 'laya',
      source: 'laya',
      async decide() { return { action: 'idle', sprint: false, source: 'laya' } },
      async ask() { askCalls++; return 'no' },
    }
    const ticker = createTicker({ bot, brain: hybridBrain(remote), tickMs: 10, idleTickMs: 10, autonomous: true })
    ticker.work()
    try {
      await ticker.tick()
      const ctx = bot._tickerCtx
      ctx.fightGivenUpId = 1
      bot.health = 19
      const r1 = await ticker.tick()
      assert.equal(askCalls, 2, 'both options asked once')
      assert.ok(r1.decision.action !== 'retreat' && r1.decision.action !== 'pillar', `fell through: ${r1.decision.action}`)
      assert.ok(typeof ctx.retreatAskedKey === 'string', 'decline stamped the bucket')
      const r2 = await ticker.tick() // hp steady, hurt still fresh, same situation
      assert.equal(askCalls, 2, 'latched: nothing re-asked')
      assert.ok(r2.decision.action !== 'retreat' && r2.decision.action !== 'pillar', `still through: ${r2.decision.action}`)
    } finally {
      ticker.destroy()
    }
  })
})

// --- rw4.12: the forage leg diverts around the pit ---

const resources = require('../src/resources')
const danger = require('../src/danger')

function forageBot() {
  const chats = []
  const bot = {
    chats,
    username: 'IdkBot',
    players: {},
    entities: {},
    health: 20,
    food: 20,
    entity: { position: { x: 0, y: 64, z: 0 }, onGround: true },
    time: { timeOfDay: 6000, day: 5 },
    pathfinder: {
      goal: null,
      movements: { canDig: true },
      isMoving: () => false,
      setGoal(g) { bot.pathfinder.goal = g },
      stop() {},
    },
    inventory: { items: () => [] },
    blockAt: () => null, // unloaded: the walk holds, no ghost rule
    chat: (m) => { chats.push(String(m)) },
    lookAt() {},
    setControlState() {},
    clearControlStates() {},
    getControlState: () => false,
  }
  return bot
}

describe('rw4.12: forage walks around the marked pit', () => {
  it('ore walk diverts via the waypoint, then goes direct, then strikes', async () => {
    // Day work with a remembered oak_log 40 out and a live mark
    // mid-leg: the first goal diverts, arrival re-issues direct, a
    // noPath on the direct leg strikes the cell and replans onward.
    const bot = forageBot()
    const ticker = createTicker({
      bot,
      brain: { async decide() { return { action: 'idle', sprint: false, source: 'stub' } } },
      tickMs: 10,
      idleTickMs: 10,
      autonomous: true,
    })
    const ctx = bot._tickerCtx
    ctx.work = true
    ctx.home = { built: true } // siteless: build/gather infeasible, forage wins the FSM
    resources.noteSpots(ctx, [{ x: 40, y: 64, z: 0, name: 'oak_log' }, { x: 0, y: 64, z: 60, name: 'oak_log' }], Date.now())
    danger.mark(ctx, { x: 20, y: 60, z: 0 })
    try {
      const r1 = await ticker.tick()
      assert.equal(r1.decision.action, 'forage')
      const g1 = bot.pathfinder.goal
      assert.equal(g1.constructor.name, 'GoalNearXZ')
      assert.deepEqual({ x: g1.x, z: g1.z }, { x: 20, z: 8 })
      bot.entity.position = { x: 20, y: 64, z: 8 } // walked around
      const r2 = await ticker.tick()
      assert.equal(r2.decision.action, 'forage')
      const g2 = bot.pathfinder.goal
      assert.equal(g2.constructor.name, 'GoalNear')
      assert.deepEqual({ x: g2.x, y: g2.y, z: g2.z }, { x: 40, y: 64, z: 0 })
      ctx.lastPathStatus = 'noPath' // A* cannot reach the cell at all
      await ticker.tick()
      assert.equal(ctx.forage.streak, 1, 'the direct leg strikes the cell')
      assert.ok(ctx.forageSkip.has('40,64,0'))
      await ticker.tick() // replanned onward
      const g4 = bot.pathfinder.goal
      assert.deepEqual({ x: g4.x, y: g4.y, z: g4.z }, { x: 0, y: 64, z: 60 })
    } finally {
      ticker.destroy()
    }
  })
})

// --- atl.12: the shelter-run holds fight, then lets go ---

const { BEHAVIOURS } = require('../src/index')

function shelterBot() {
  const chats = []
  const bot = {
    chats,
    username: 'IdkBot',
    players: {},
    entities: {},
    health: 20,
    food: 20,
    entity: { position: { x: 60, y: 64, z: 19 }, onGround: true },
    time: { timeOfDay: 14000, day: 5 }, // night
    pathfinder: {
      goal: null,
      movements: { canDig: true },
      isMoving: () => false,
      setGoal(g) { bot.pathfinder.goal = g },
      stop() {},
    },
    inventory: { items: () => [] },
    blockAt: () => ({ name: 'air', boundingBox: 'empty', position: { x: 0, y: 0, z: 0 } }),
    chat: (m) => { chats.push(String(m)) },
    lookAt() {},
    setControlState() {},
    clearControlStates() {},
    getControlState: () => false,
  }
  return bot
}

describe('atl.12: the night walk holds fight until the stamp goes stale', () => {
  it('gohome stamps each walk tick, fight waits, stale stamp releases', async () => {
    // Night exodus far from home: the walk stamps shelterRun, so fight
    // ticks hold and the bot keeps walking; the frozen walk fails, the
    // stamp goes stale, and fight preempts again. Fight is stubbed (the
    // mechanism under test is the hold, not the swing).
    const bot = shelterBot()
    let decides = 0
    const brain = {
      async decide() {
        decides++
        // Walk first (stamp arms), then the model wants every fight.
        return decides <= 2
          ? { action: 'idle', sprint: false, source: 'stub' }
          : { action: 'fight', sprint: false, source: 'stub' }
      },
    }
    const ticker = createTicker({ bot, brain, tickMs: 10, idleTickMs: 10, autonomous: true })
    const ctx = bot._tickerCtx
    ctx.work = true
    ctx.home = ctxHome()
    // Bust the brain decision cache every tick: a frozen mock reuses the
    // idle answer forever (prod state never stands still; atl.12 tick
    // tests bust it the same way). Food flips are behaviour-free here.
    let fed = true
    const step = async () => { fed = !fed; bot.food = fed ? 20 : 19; return ticker.tick() }
    const realNow = Date.now
    let now = realNow()
    Date.now = () => now
    const lines = []
    const origLog = console.log
    console.log = (l) => { lines.push(String(l)) }
    const origFight = BEHAVIOURS.fight
    let fightRan = 0
    BEHAVIOURS.fight = () => { fightRan++ }
    try {
      const r1 = await step()
      assert.equal(r1.decision.action, 'gohome')
      assert.equal(typeof ctx.shelterRun, 'number', 'the night walk stamps')
      const r2 = await step()
      assert.equal(r2.decision.action, 'gohome')
      const r3 = await step() // the model says fight: held
      assert.equal(r3.decision.action, 'gohome', 'fresh stamp holds fight preemption')
      assert.equal(fightRan, 0)
      assert.ok(lines.some((l) => l.includes('shelter-run: holding fight preemption')), lines.join(' | '))
      // Frozen mid-walk: the walk fails, the stamp stops refreshing.
      let failed = false
      for (let i = 0; i < 80 && !failed; i++) {
        const r = await step()
        assert.equal(r.decision.action, 'gohome', `hold until the walk dies, tick ${i}`)
        if (String(ctx.stepStatus).startsWith('failed:')) failed = true
      }
      assert.ok(failed, 'the frozen walk fails')
      assert.equal(fightRan, 0, 'fight never ran during the hold')
      now += 5000 // the stamp goes stale
      const r4 = await step()
      assert.equal(r4.decision.action, 'fight', 'stale stamp releases fight')
      assert.equal(fightRan, 1)
    } finally {
      Date.now = realNow
      console.log = origLog
      BEHAVIOURS.fight = origFight
      ticker.destroy()
    }
  })
})
