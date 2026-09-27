'use strict'

// E2E scenarios: owner-facing detour behaviour through work-mode ticks.
// rw4.12: gohome routes around a live danger mark on the way home; a dead
// detour leg falls back to direct instead of failing the night.

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const { createTicker } = require('../src/index')
const danger = require('../src/danger')

const SITE = { x: 10, y: 64, z: 20 }
const DOOR = { x: 11, y: 64, z: 20 }
const OUTSIDE = { x: 11, y: 64, z: 19 }
const FAR = { x: 60, y: 64, z: 19 } // straight leg home runs along z=19
const PIT = { x: 35, y: 60, z: 19 }
const VIA = { x: 35, y: 64, z: 11 }

function detourBot() {
  const chats = []
  const state = { doorOpen: false }
  const bot = {
    chats,
    username: 'IdkBot',
    players: {}, // dusk exodus: nobody online
    entities: {},
    health: 20,
    food: 20,
    entity: { position: { ...FAR }, onGround: true },
    time: { timeOfDay: 12500, day: 5 }, // dusk
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

function tickerFor(bot) {
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
  danger.mark(ctx, PIT)
  return { ticker, ctx }
}

describe('rw4.12: gohome walks around the marked pit', () => {
  it('dusk walk aims at the waypoint first, then the door', async () => {
    const bot = detourBot()
    const { ticker, ctx } = tickerFor(bot)
    try {
      const r1 = await ticker.tick()
      assert.equal(r1.decision.action, 'gohome')
      const g1 = bot.pathfinder.goal
      assert.equal(g1.constructor.name, 'GoalNear')
      assert.deepEqual({ x: g1.x, y: g1.y, z: g1.z }, VIA)
      bot.entity.position = { ...VIA } // walked around the pit
      await ticker.tick() // arrived: flips direct
      const r3 = await ticker.tick() // re-issues to the door
      assert.equal(r3.decision.action, 'gohome')
      assert.deepEqual({ x: bot.pathfinder.goal.x, y: bot.pathfinder.goal.y, z: bot.pathfinder.goal.z }, OUTSIDE)
      assert.ok(!bot.chats.some((m) => m === 'home for the night'), 'not home yet')
      assert.equal(ctx.stepStatus, 'running')
    } finally {
      ticker.destroy()
    }
  })

  it('a dead detour leg falls back direct through ticks, then fails honestly', async () => {
    const bot = detourBot() // frozen: the pit leg cannot progress
    const { ticker, ctx } = tickerFor(bot)
    try {
      let directTick = -1
      for (let i = 0; i < 45; i++) {
        const r = await ticker.tick()
        assert.equal(r.decision.action, 'gohome', `tick ${i} holds gohome`)
        const g = bot.pathfinder.goal
        if (g && g.x === OUTSIDE.x && g.z === OUTSIDE.z) { directTick = i; break }
      }
      assert.ok(directTick >= 25, `the via leg dies first (3x10 stalls), direct at tick ${directTick}`)
      assert.equal(ctx.stepStatus, 'running', 'detour death is not step death')
      let failed = null
      for (let i = 0; i < 60; i++) {
        await ticker.tick()
        if (typeof ctx.stepStatus === 'string' && ctx.stepStatus.startsWith('failed:')) { failed = ctx.stepStatus; break }
      }
      assert.equal(failed, 'failed:cannot-reach-home', 'direct death fails honestly')
    } finally {
      ticker.destroy()
    }
  })
})
