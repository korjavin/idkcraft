'use strict'

// Breath reflex (idkcraft-0u9): prod 2026-09-28 drowned mid-dig on an
// underwater iron vein — nothing read bot.oxygenLevel. Low oxygen in water
// stops the dig, drops the path and swims up within one tick; wet digs are
// refused ('submerged') and wet bring sources costed so dry ore wins.

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const { createTicker, breathReflex } = require('../src/index')
const { denyReason, submergedAt } = require('../src/behaviours/util')
const bring = require('../src/behaviours/bring')
const { liveExposed, buriedCand, decideBringSource, sourceText, SOURCE_COST } = require('../src/behaviours/bring')

function pos(x, y, z) {
  const p = {
    x, y, z,
    distanceTo: (q) => Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z),
    clone() { return pos(p.x, p.y, p.z) },
    floored() { return pos(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)) },
    offset(dx, dy, dz) { return pos(p.x + dx, p.y + dy, p.z + dz) },
  }
  return p
}

// World view: cells maps 'x,y,z' -> block name; the bot floats at bodyPos.
function diveBot({ cells = {}, bodyPos = pos(0, 60, 0), oxygen = 20, inWater = false } = {}) {
  const calls = { stopDigging: 0, setGoal: 0, goals: [] }
  const controls = {}
  const bot = {
    calls,
    _cells: cells,
    username: 'IdkBot',
    players: {},
    entities: {},
    health: 20,
    food: 20,
    oxygenLevel: oxygen,
    entity: { position: bodyPos, isInWater: inWater, onGround: false },
    pathfinder: {
      goal: null,
      setGoal: (g) => { calls.setGoal++; calls.goals.push(g); bot.pathfinder.goal = g },
      stop: () => {},
      isMoving: () => false,
      setMovements: () => {},
    },
    setControlState: (c, v) => { controls[c] = !!v },
    getControlState: (c) => !!controls[c],
    clearControlStates: () => { for (const k in controls) controls[k] = false },
    lookCalls: [],
    look: (yaw, pitch) => { bot.lookCalls.push([yaw, pitch]) },
    blockAt: (p) => {
      const n = cells[`${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`]
      return n ? { name: n, position: pos(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)) } : null
    },
    stopDigging: () => { calls.stopDigging++ },
    chat: () => {},
  }
  return bot
}

describe('breathReflex', () => {
  it('ignores a dry bot with low oxygen', () => {
    const bot = diveBot({ oxygen: 6, inWater: false })
    const ctx = { lastGoalKey: 'bring:dig' }
    assert.equal(breathReflex(bot, ctx), false)
    assert.equal(bot.calls.stopDigging, 0)
    assert.equal(ctx.breath, undefined)
  })

  it('ignores full lungs in water', () => {
    const bot = diveBot({ oxygen: 20, inWater: true })
    assert.equal(breathReflex(bot, { lastGoalKey: '' }), false)
    assert.equal(bot.getControlState('jump'), false)
  })

  it('ignores a missing oxygen readout', () => {
    const bot = diveBot({ inWater: true })
    delete bot.oxygenLevel
    assert.equal(breathReflex(bot, { lastGoalKey: '' }), false)
  })

  it('mid-dig trigger: stops the dig, drops the path, holds jump', () => {
    const bot = diveBot({ oxygen: 6, inWater: true })
    bot.targetDigBlock = { name: 'iron_ore' }
    bot.pathfinder.goal = { fake: 'dive-goal' }
    const ctx = { lastGoalKey: 'bring:dig' }
    assert.equal(breathReflex(bot, ctx), true)
    assert.equal(bot.calls.stopDigging, 1)
    assert.equal(bot.pathfinder.goal, null)
    assert.equal(ctx.lastGoalKey, '')
    assert.equal(bot.getControlState('jump'), true)
    assert.equal(ctx.breath, true)
  })

  it('swims diagonally toward the surface-breaking lane', () => {
    const bot = diveBot({
      oxygen: 6, inWater: true,
      cells: {
        '0,61,0': 'water',
        '1,61,0': 'water', '1,62,0': 'air', // east lane breaks the surface
        '-1,61,0': 'water', '-1,62,0': 'water', // west lane stays wet
      },
    })
    const ctx = { lastGoalKey: '' }
    assert.equal(breathReflex(bot, ctx), true)
    assert.equal(bot.getControlState('jump'), true)
    assert.equal(bot.getControlState('forward'), true)
    assert.equal(bot.lookCalls.length, 1)
    assert.equal(bot.lookCalls[0][0], Math.atan2(-1, 0)) // faces east
  })

  it('takes a wet lane when no lane breaks the surface', () => {
    const bot = diveBot({
      oxygen: 6, inWater: true,
      cells: { '0,61,0': 'water', '0,61,1': 'water', '0,62,1': 'water' },
    })
    assert.equal(breathReflex(bot, { lastGoalKey: '' }), true)
    assert.equal(bot.getControlState('forward'), true)
    assert.equal(bot.lookCalls[0][0], Math.atan2(-0, -1)) // faces +z
  })

  it('swims out from under a ceiling as a last resort', () => {
    const bot = diveBot({
      oxygen: 6, inWater: true,
      cells: { '0,61,0': 'water', '-1,61,0': 'water', '-1,62,0': 'stone' },
    })
    assert.equal(breathReflex(bot, { lastGoalKey: '' }), true)
    assert.equal(bot.getControlState('forward'), true)
  })

  it('rotates lanes when a lane stalls: dead lane, blind unstick, next lane', () => {
    const bot = diveBot({
      oxygen: 6, inWater: true,
      cells: {
        '0,61,0': 'water',
        '1,61,0': 'water', '1,62,0': 'water', // east lane 0
        '0,61,1': 'water', '0,62,1': 'water', // +z lane 2
      },
    })
    const ctx = { lastGoalKey: '' }
    const east = Math.atan2(-1, -0)
    const west = Math.atan2(1, -0)
    const south = Math.atan2(-0, -1)
    assert.equal(breathReflex(bot, ctx), true) // trigger: lane 0 east
    assert.equal(breathReflex(bot, ctx), true) // hold 1: still=1, lane 0
    assert.equal(breathReflex(bot, ctx), true) // hold 2: still=2, stall -> unstick west
    assert.equal(breathReflex(bot, ctx), true) // hold 3: second unstick tick
    assert.equal(breathReflex(bot, ctx), true) // hold 4: re-scan without lane 0 -> lane 3
    assert.deepEqual(bot.lookCalls.map(([yaw]) => yaw), [east, east, west, west, south])
    assert.ok(ctx.breathDead instanceof Set && ctx.breathDead.has(0))
  })

  it('forgives dead lanes when every lane stalled', () => {
    const bot = diveBot({
      oxygen: 6, inWater: true,
      cells: { '0,61,0': 'water', '1,61,0': 'water', '1,62,0': 'water' }, // east only
    })
    const ctx = { lastGoalKey: '' }
    const east = Math.atan2(-1, -0)
    for (let i = 0; i < 5; i++) assert.equal(breathReflex(bot, ctx), true)
    assert.equal(bot.lookCalls.length, 5)
    assert.equal(bot.lookCalls[4][0], east) // forgiven: the only lane again
    assert.equal(ctx.breathDead, null)
  })

  it('progress keeps the lane: no rotation while rising', () => {
    const bot = diveBot({
      oxygen: 6, inWater: true,
      cells: {
        '0,61,0': 'water', '1,61,0': 'water', '1,62,0': 'water',
        '2,62,0': 'water', '2,63,0': 'water', // the lane continues east
      },
    })
    const ctx = { lastGoalKey: '' }
    const east = Math.atan2(-1, -0)
    assert.equal(breathReflex(bot, ctx), true)
    bot.entity.position = pos(0.5, 60.5, 0) // swam up-east
    assert.equal(breathReflex(bot, ctx), true)
    bot.entity.position = pos(1, 61, 0)
    assert.equal(breathReflex(bot, ctx), true)
    assert.deepEqual(bot.lookCalls.map(([yaw]) => yaw), [east, east, east])
    assert.equal(ctx.breathDead, null)
  })

  it('release clears the episode swim state', () => {
    const bot = diveBot({
      oxygen: 6, inWater: true,
      cells: { '0,61,0': 'water', '1,61,0': 'water', '1,62,0': 'water' },
    })
    const ctx = { lastGoalKey: '' }
    assert.equal(breathReflex(bot, ctx), true)
    assert.equal(breathReflex(bot, ctx), true)
    bot.oxygenLevel = 20
    assert.equal(breathReflex(bot, ctx), false)
    assert.equal(ctx.breathDead, null)
    assert.equal(ctx.breathLane, -1)
    assert.equal(ctx.breathLastPos, null)
  })

  it('sticky lane: no flip-flop when the next cell points back', () => {
    const bot = diveBot({
      oxygen: 6, inWater: true,
      cells: {
        '0,61,-1': 'water', '0,62,-1': 'water', // -z: the only lane at P
        '0,61,-2': 'water', '0,62,-2': 'stone', // -z stays open (flat) one cell on
        '0,61,0': 'water', '0,62,0': 'air', // +z would win a fresh scan at Q
      },
    })
    const ctx = { lastGoalKey: '' }
    const north = Math.atan2(-0, 1) // faces -z
    assert.equal(breathReflex(bot, ctx), true)
    assert.equal(bot.lookCalls[0][0], north)
    bot.entity.position = pos(0, 60.5, -0.9) // swam -z with progress
    assert.equal(breathReflex(bot, ctx), true)
    assert.equal(bot.lookCalls[1][0], north) // sticky: keeps -z, no flip to +z
  })

  it('oscillation: a returned spot kills the lane pair, no unstick', () => {
    const bot = diveBot({
      oxygen: 6, inWater: true,
      cells: {
        '1,61,0': 'water', '1,62,0': 'water', // east from P
        '0,61,1': 'water', '0,62,1': 'water', // +z from P
        '2,61,0': 'stone', // east closed from Q
        '1,61,1': 'water', '1,62,1': 'water', // +z from Q
      },
    })
    const ctx = { lastGoalKey: '' }
    const east = Math.atan2(-1, -0)
    const south = Math.atan2(-0, -1)
    assert.equal(breathReflex(bot, ctx), true) // P: lane 0 east
    bot.entity.position = pos(1.1, 60, 0) // Q: east closed -> lane 2
    assert.equal(breathReflex(bot, ctx), true)
    assert.deepEqual(bot.lookCalls.map(([yaw]) => yaw), [east, south])
    bot.entity.position = pos(0, 60, 0) // back at P: oscillation
    assert.equal(breathReflex(bot, ctx), true)
    assert.equal(bot.lookCalls[2][0], east) // pair dead, forgiven, east again
    assert.equal(ctx.breathDead, null)
    assert.equal(ctx.breathUnstick, 0)
  })

  it('coasts (no thrust) when air is just above the head', () => {
    const bot = diveBot({
      oxygen: 6, inWater: true,
      cells: {
        '0,61,0': 'water', '0,62,0': 'water',
        '1,61,0': 'water', '1,62,0': 'water', // east lane open
      },
    })
    const ctx = { lastGoalKey: '' }
    bot.pathfinder.goal = { fake: 'dive-goal' }
    assert.equal(breathReflex(bot, ctx), true) // trigger swims
    assert.equal(bot.getControlState('jump'), true)
    assert.equal(bot.lookCalls.length, 1)
    bot.entity.velocity = { x: 0, y: 0.5, z: 0 } // rising now
    bot._cells['0,62,0'] = 'air' // surfaced to just below air
    assert.equal(breathReflex(bot, ctx), true) // still owns the body...
    assert.equal(bot.getControlState('jump'), false) // ...but coasts
    assert.equal(bot.getControlState('forward'), false)
    assert.equal(bot.pathfinder.goal, null)
    assert.equal(bot.lookCalls.length, 1) // no lane drive while coasting
    assert.equal(ctx.breathDead, null) // and no rotation from the bob
    bot._cells['0,62,0'] = 'water' // sank back down
    assert.equal(breathReflex(bot, ctx), true)
    assert.equal(bot.getControlState('jump'), true) // swim resumes
  })

  it('coasting needs momentum: grounded or falling bodies keep thrusting', () => {
    const bot = diveBot({
      oxygen: 6, inWater: true,
      cells: {
        '0,61,0': 'water', '0,62,0': 'air', // 2-deep band off the floor
        '1,61,0': 'water', '1,62,0': 'water',
      },
    })
    const ctx = { lastGoalKey: '' }
    assert.equal(breathReflex(bot, ctx), true) // trigger swims
    bot.entity.onGround = true // beached on the 2-deep floor
    bot.entity.velocity = { x: 0, y: 0.5, z: 0 }
    assert.equal(breathReflex(bot, ctx), true)
    assert.equal(bot.getControlState('jump'), true) // thrusts off the floor
    bot.entity.onGround = false
    bot.entity.velocity = { x: 0, y: -0.5, z: 0 } // sinking through the band
    assert.equal(breathReflex(bot, ctx), true)
    assert.equal(bot.getControlState('jump'), true) // re-arrests the sink
  })

  it('post-release cooldown blocks an instant re-trigger', () => {
    const bot = diveBot({ oxygen: 6, inWater: true, cells: { '0,61,0': 'water' } })
    const ctx = { lastGoalKey: '' }
    assert.equal(breathReflex(bot, ctx, 10000), true)
    bot.oxygenLevel = 20
    assert.equal(breathReflex(bot, ctx, 11000), false) // release, calm until 15000
    bot.oxygenLevel = 6
    assert.equal(breathReflex(bot, ctx, 12000), false) // lands back under: calm
    assert.equal(breathReflex(bot, ctx, 14999), false)
    assert.equal(breathReflex(bot, ctx, 15000), true) // calm over: rescue again
  })

  it('treads when walled in at head level', () => {
    const bot = diveBot({
      oxygen: 6, inWater: true,
      cells: {
        '0,61,0': 'water',
        '1,61,0': 'stone', '-1,61,0': 'stone', '0,61,1': 'stone', '0,61,-1': 'stone',
      },
    })
    assert.equal(breathReflex(bot, { lastGoalKey: '' }), true)
    assert.equal(bot.getControlState('jump'), true)
    assert.equal(bot.getControlState('forward'), false)
    assert.equal(bot.lookCalls.length, 0)
  })

  it('keeps rising until the lungs are full', () => {
    const bot = diveBot({ oxygen: 6, inWater: true, cells: { '0,61,0': 'water' } })
    const ctx = { lastGoalKey: '' }
    assert.equal(breathReflex(bot, ctx), true)
    bot.oxygenLevel = 12 // surfacing, not there yet
    assert.equal(breathReflex(bot, ctx), true)
    assert.equal(bot.getControlState('jump'), true)
    assert.equal(ctx.breath, true)
  })

  it('releases on full lungs', () => {
    const bot = diveBot({
      oxygen: 6, inWater: true,
      cells: { '1,61,0': 'water', '1,62,0': 'water' },
    })
    const ctx = { lastGoalKey: '' }
    assert.equal(breathReflex(bot, ctx), true)
    assert.equal(bot.getControlState('forward'), true)
    bot.oxygenLevel = 20
    assert.equal(breathReflex(bot, ctx), false)
    assert.equal(bot.getControlState('jump'), false)
    assert.equal(bot.getControlState('forward'), false)
    assert.equal(ctx.breath, false)
  })

  it('releases out of the water', () => {
    const bot = diveBot({ oxygen: 6, inWater: true })
    const ctx = { lastGoalKey: '' }
    assert.equal(breathReflex(bot, ctx), true)
    bot.entity.isInWater = false // hauled out, still panting
    assert.equal(breathReflex(bot, ctx), false)
    assert.equal(bot.getControlState('jump'), false)
  })

  it('breathing eases off but keeps the episode (no release flap)', () => {
    const bot = diveBot({ oxygen: 6, inWater: true, cells: { '0,61,0': 'water' } })
    const ctx = { lastGoalKey: '' }
    bot.pathfinder.goal = { fake: 'dive-goal' }
    assert.equal(breathReflex(bot, ctx), true)
    assert.equal(bot.getControlState('jump'), true)
    bot._cells['0,61,0'] = 'air' // head pokes out mid-rise
    assert.equal(breathReflex(bot, ctx), true) // still owns the body...
    assert.equal(bot.getControlState('jump'), false) // ...but floats
    assert.equal(bot.getControlState('forward'), false)
    assert.equal(bot.pathfinder.goal, null) // and keeps the dive dropped
    assert.equal(ctx.breath, true)
  })

  it('sustained air releases past a stale readout; a dip resets the count', () => {
    const bot = diveBot({ oxygen: 6, inWater: true, cells: { '0,61,0': 'air' } })
    const ctx = { lastGoalKey: '' }
    assert.equal(breathReflex(bot, ctx), true)
    for (let i = 0; i < 3; i++) assert.equal(breathReflex(bot, ctx), true)
    bot._cells['0,61,0'] = 'water' // dipped back under
    assert.equal(breathReflex(bot, ctx), true)
    assert.equal(ctx.breathAir, 0)
    bot._cells['0,61,0'] = 'air'
    for (let i = 0; i < 4; i++) assert.equal(breathReflex(bot, ctx), true)
    assert.equal(breathReflex(bot, ctx), false) // 5th consecutive air tick
    assert.equal(ctx.breath, false)
  })

  it('survives a minimal bot', () => {
    assert.equal(breathReflex({}, {}), false)
    assert.equal(breathReflex(null, {}), false)
  })
})

describe('breath ticker preempt', () => {
  function tickBot() {
    const bot = diveBot({ oxygen: 6, inWater: true, bodyPos: pos(0, 60, 0) })
    bot.players = { Steve: { username: 'Steve', entity: { id: 7, position: pos(10, 64, 0) } } }
    bot.entity.onGround = true
    bot.pathfinder.goal = { fake: 'dive-goal' }
    bot.targetDigBlock = { name: 'iron_ore' }
    delete bot.blockAt // no head backstop: pure oxygen behaviour
    return bot
  }

  it('one tick: low oxygen mid-dig preempts the order and the brain', async () => {
    const bot = tickBot()
    const brain = { calls: 0, async decide() { this.calls++; return { action: 'follow', sprint: false, source: 'jev' } } }
    const ticker = createTicker({ bot, brain, tickMs: 10, idleTickMs: 10 })
    const r = await ticker.tick()
    assert.equal(r.decision.action, 'breath')
    assert.equal(r.decision.source, 'reflex')
    assert.equal(r.calledBrain, false)
    assert.equal(brain.calls, 0)
    assert.equal(bot.calls.stopDigging, 1)
    assert.equal(bot.getControlState('jump'), true)
    assert.equal(bot.pathfinder.goal, null)
  })

  it('idle ticks surface a parked bot (nobody online)', async () => {
    const bot = diveBot({ oxygen: 6, inWater: true, bodyPos: pos(0, 60, 0) })
    delete bot.blockAt
    const brain = { calls: 0, async decide() { this.calls++; return { action: 'follow', sprint: false, source: 'jev' } } }
    const ticker = createTicker({ bot, brain, tickMs: 10, idleTickMs: 10 })
    const r = await ticker.tick()
    assert.equal(r.decision.source, 'local-idle')
    assert.equal(brain.calls, 0)
    assert.equal(bot.getControlState('jump'), true)
    assert.equal(bot._tickerCtx.breath, true)
  })

  it("'stop' parks the body but still surfaces it", async () => {
    const bot = diveBot({ oxygen: 6, inWater: true, bodyPos: pos(0, 60, 0) })
    delete bot.blockAt
    const brain = { calls: 0, async decide() { this.calls++; return { action: 'follow', sprint: false, source: 'jev' } } }
    const ticker = createTicker({ bot, brain, tickMs: 10, idleTickMs: 10 })
    bot._tickerCtx.paused = true
    const r = await ticker.tick()
    assert.equal(r.decision.action, 'idle')
    assert.equal(bot.getControlState('jump'), true)
    assert.equal(bot._tickerCtx.breath, true)
  })

  it('alone path: the home-stuck menu waits while the body surfaces', async () => {
    const recoverMod = require('../src/behaviours/recover')
    const orig = recoverMod.decide
    let calls = 0
    recoverMod.decide = async () => { calls++; return null }
    try {
      const bot = diveBot({ oxygen: 6, inWater: true, bodyPos: pos(0, 60, 0) })
      delete bot.blockAt
      const brain = { async decide() { return { action: 'follow', sprint: false, source: 'jev' } } }
      const ticker = createTicker({ bot, brain, tickMs: 10, idleTickMs: 10 })
      bot._tickerCtx.stuck = { by: 'home' }
      await ticker.tick()
      assert.equal(calls, 0) // gated while breathing
      bot.oxygenLevel = 20
      bot.entity.isInWater = false
      await ticker.tick()
      assert.equal(calls, 1) // resumes after release
    } finally {
      recoverMod.decide = orig
    }
  })

  it('a bring order pauses for breath and resumes after release', async () => {
    const idx = require('../src/index')
    const origBring = idx.BEHAVIOURS.bring
    let brings = 0
    idx.BEHAVIOURS.bring = async () => { brings++ }
    try {
      const bot = diveBot({ oxygen: 6, inWater: true, bodyPos: pos(0, 60, 0) })
      bot.players = { Steve: { username: 'Steve', entity: { id: 7, position: pos(10, 64, 0) } } }
      bot.entity.onGround = true
      delete bot.blockAt
      const brain = { calls: 0, async decide() { this.calls++; return { action: 'follow', sprint: false, source: 'jev' } } }
      const ticker = createTicker({ bot, brain, tickMs: 10, idleTickMs: 10 })
      bot._tickerCtx.bring = { kind: 'block', name: 'iron_ore', phase: 'walk' }
      const r1 = await ticker.tick()
      assert.equal(r1.decision.action, 'breath')
      assert.equal(brings, 0)
      assert.equal(brain.calls, 0)
      bot.oxygenLevel = 20
      bot.entity.isInWater = false
      const r2 = await ticker.tick()
      assert.equal(brings, 1)
      assert.equal(r2.decision.action, 'bring')
    } finally {
      idx.BEHAVIOURS.bring = origBring
    }
  })

  it('release tick resumes normal arbitration', async () => {
    const bot = tickBot()
    const brain = { calls: 0, async decide() { this.calls++; return { action: 'follow', sprint: false, source: 'jev' } } }
    const ticker = createTicker({ bot, brain, tickMs: 10, idleTickMs: 10 })
    await ticker.tick()
    assert.equal(brain.calls, 0)
    bot.oxygenLevel = 20
    bot.entity.isInWater = false
    const r = await ticker.tick()
    assert.equal(brain.calls, 1)
    assert.equal(r.decision.action, 'follow')
    assert.equal(bot.getControlState('jump'), false)
  })
})

describe("denyReason 'submerged'", () => {
  const vein = () => ({ name: 'iron_ore', position: pos(0, 60, 0) })

  it('refuses a dig with water above the target', () => {
    const bot = diveBot({ cells: { '0,60,0': 'iron_ore', '0,61,0': 'water' } })
    assert.equal(denyReason(bot, vein(), {}), 'submerged')
  })

  it('refuses a water target cell', () => {
    const bot = diveBot({ cells: { '0,60,0': 'water', '0,61,0': 'water' } })
    assert.equal(denyReason(bot, { name: 'water', position: pos(0, 60, 0) }, {}), 'submerged')
  })

  it('allows the same vein dry', () => {
    const bot = diveBot({ cells: { '0,60,0': 'iron_ore', '0,61,0': 'air' } })
    assert.equal(denyReason(bot, vein(), {}), null)
  })

  it('unknown cells read dry (proof rule)', () => {
    const bot = diveBot({})
    delete bot.blockAt
    assert.equal(denyReason(bot, vein(), {}), null)
  })

  it('needs no stance: refuses with no body position', () => {
    const bot = diveBot({ cells: { '0,60,0': 'iron_ore', '0,61,0': 'water' } })
    delete bot.entity
    assert.equal(denyReason(bot, vein(), {}), 'submerged')
  })

  it('submergedAt is the shared predicate', () => {
    const bot = diveBot({ cells: { '0,60,0': 'stone', '0,61,0': 'water' } })
    assert.equal(submergedAt(bot, 0, 60, 0), true)
    assert.equal(submergedAt(bot, 5, 60, 5), false)
    assert.equal(submergedAt({}, 0, 60, 0), false)
  })
})

describe('bring water penalty', () => {
  const bp = pos(0, 64, 0)

  it('liveExposed prices a dive above a walk', () => {
    const dry = diveBot({})
    const a = liveExposed(bp, { name: 'iron_ore', position: pos(20, 64, 0), distance: 20, exposed: true }, dry)
    assert.equal(a.wet, false)
    assert.equal(a.cost, 5)
    const wet = diveBot({ cells: { '20,64,0': 'iron_ore', '20,65,0': 'water' } })
    const b = liveExposed(bp, { name: 'iron_ore', position: pos(20, 64, 0), distance: 20, exposed: true }, wet)
    assert.equal(b.wet, true)
    assert.equal(b.cost, 5 + SOURCE_COST.wetPenaltySec)
  })

  it('buriedCand scans the column over the vein', () => {
    const dry = diveBot({})
    const a = buriedCand(bp, { name: 'iron_ore', position: pos(2, 60, 0), distance: 5, exposed: false }, dry)
    assert.equal(a.wet, false)
    // Lakebed three cells over the vein: the shaft floods.
    const wet = diveBot({ cells: { '2,63,0': 'water', '2,64,0': 'water' } })
    const b = buriedCand(bp, { name: 'iron_ore', position: pos(2, 60, 0), distance: 5, exposed: false }, wet)
    assert.equal(b.wet, true)
    assert.equal(b.cost, a.cost + SOURCE_COST.wetPenaltySec)
  })

  it('builders without a world view keep legacy costs', () => {
    const a = liveExposed(bp, { name: 'iron_ore', position: pos(60, 64, 0), distance: 60, exposed: true })
    assert.equal(a.wet, false)
    assert.equal(a.cost, 15)
    const b = buriedCand(bp, { name: 'iron_ore', position: pos(0, 59, 0), distance: 5, exposed: false })
    assert.equal(b.wet, false)
    assert.equal(b.cost, 5 * SOURCE_COST.digSecPerBlock + SOURCE_COST.shaftPenaltySec)
  })

  it('decideBringSource: dry exposed beats a wet shaft', () => {
    const dry = diveBot({})
    const wet = diveBot({ cells: { '2,63,0': 'water' } })
    const exposed = liveExposed(bp, { name: 'iron_ore', position: pos(20, 64, 0), distance: 20, exposed: true }, dry)
    const buried = buriedCand(bp, { name: 'iron_ore', position: pos(2, 62, 0), distance: 3, exposed: false }, wet)
    assert.equal(buried.wet, true)
    assert.deepEqual(decideBringSource(exposed, buried), { pick: 'exposed', why: 'clear' })
  })

  it('decideBringSource: dry wins contested outright, never asks the model', () => {
    const wetExposed = { kind: 'live', cost: 20, dist: 80, wet: true }
    const dryBuried = { kind: 'buried', cost: 25, dist: 5, depthBelow: 2, wet: false }
    assert.deepEqual(decideBringSource(wetExposed, dryBuried), { pick: 'buried', why: 'clear' })
    const dryExposed = { kind: 'live', cost: 20, dist: 80, wet: false }
    const wetBuried = { kind: 'buried', cost: 25, dist: 5, depthBelow: 2, wet: true }
    assert.deepEqual(decideBringSource(dryExposed, wetBuried), { pick: 'exposed', why: 'clear' })
  })

  it('sourceText marks underwater candidates', () => {
    const dry = { kind: 'live', cost: 5, distH: 20 }
    const wet = { kind: 'buried', cost: 35, distH: 2, depthBelow: 2, wet: true }
    const t = sourceText({ name: 'iron_ore' }, dry, wet)
    assert.ok(t.includes('underwater'))
    assert.ok(!sourceText({ name: 'iron_ore' }, dry, null).includes('underwater'))
  })
})

describe('bring submerged skips', () => {
  function bringBot(cells, bodyPos) {
    const bot = diveBot({ bodyPos: bodyPos || pos(1, 60, 0), cells })
    bot.lines = []
    bot.chat = (line) => { bot.lines.push(String(line)) }
    bot.canDigBlock = () => true
    bot.dig = async () => {}
    bot.registry = { blocksByName: { iron_ore: { id: 1 } } }
    bot.inventory = { items: () => [{ name: 'stone_pickaxe' }] }
    return bot
  }

  const V = { x: 0, y: 60, z: 0 } // wet vein (lakebed)
  function bringCtx(phase, extra) {
    return {
      lastGoalKey: '',
      bring: Object.assign({
        kind: 'block', name: 'iron_ore', block: 'iron_ore', drop: 'raw_iron',
        pos: pos(V.x, V.y, V.z), phase: phase || 'dig', have: 0, want: 1, denyStrikes: 0,
      }, extra),
    }
  }

  it('a submerged dig skips the vein without striking', async () => {
    const bot = bringBot({ '0,60,0': 'iron_ore', '0,61,0': 'water', '1,60,0': 'water', '1,61,0': 'water' })
    const ctx = bringCtx('dig')
    await bring(bot, ctx, null, {})
    const o = ctx.bring
    assert.ok(o)
    assert.equal(o.denyStrikes, 0)
    assert.equal(o.phase, 'find')
    assert.equal(o.pos, null)
    assert.ok(o.skip && o.skip.has('0,60,0'))
    assert.equal(o.sawSubmerged, true)
  })

  it('find skips a wet nearest vein and commits a dry farther one', async () => {
    const wet = pos(2, 62, 0)
    const dry = pos(20, 62, 0)
    const bot = bringBot({
      '2,62,0': 'iron_ore', '2,63,0': 'water', '3,62,0': 'air', // exposed + dived
      '20,62,0': 'iron_ore', '20,63,0': 'air', '21,62,0': 'air', // exposed + dry
    }, pos(0, 64, 0))
    bot.findBlocks = () => [wet, dry]
    const ctx = bringCtx('find', { pos: null })
    await bring(bot, ctx, null, {})
    const o = ctx.bring
    assert.ok(o)
    assert.equal(o.phase, 'walk')
    assert.equal(o.pos.x, 20)
    assert.equal(o.pos.z, 0)
    assert.equal(o.sawSubmerged, true)
    assert.ok(o.skip && o.skip.has('2,62,0'))
  })

  it('an underwater-only vein refuses honestly after the skips', async () => {
    const wet = pos(2, 62, 0)
    const bot = bringBot({
      '2,62,0': 'iron_ore', '2,63,0': 'water', '3,62,0': 'air',
    }, pos(0, 64, 0))
    bot.findBlocks = () => [wet]
    const ctx = bringCtx('find', { pos: null })
    await bring(bot, ctx, null, {})
    assert.equal(ctx.bring, null)
    assert.deepEqual(bot.lines, ['could not reach iron_ore safely'])
  })
})
