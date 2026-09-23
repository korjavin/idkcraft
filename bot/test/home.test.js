'use strict'

// Bead rw4.5 acceptance (a)-(e): gohome walks to the door, opens, enters and
// closes it; stay holds the night and leaves in the morning.

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const home = require('../src/behaviours/home')

const SITE = { x: 10, y: 64, z: 20 }
// Door lower cell, outside approach cell, first interior cell behind the door.
const DOOR = { x: 11, y: 64, z: 20 }
const OUTSIDE = { x: 11, y: 64, z: 19 }
const INSIDE = { x: 11, y: 64, z: 21 }

function mockBot({ at, timeOfDay = 12500, doorOpen = false, moving = false } = {}) {
  const chats = []
  const calls = { goals: [], activates: 0 }
  const state = { doorOpen }
  const bot = {
    chats,
    calls,
    entity: { position: { x: at.x, y: at.y, z: at.z } },
    time: { timeOfDay },
    pathfinder: {
      goal: null,
      isMoving: () => moving,
      setGoal: (g) => { calls.goals.push(g); bot.pathfinder.goal = g },
      stop: () => {},
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
    activateBlock: async () => { calls.activates++; state.doorOpen = !state.doorOpen },
    chat: (m) => { chats.push(String(m)) },
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

const settle = async (n = 5) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)) }

describe('rw4.5 gohome', () => {
  it('(a) far outside walks to the cell before the door', () => {
    const bot = mockBot({ at: { x: 16, y: 64, z: 14 } })
    const ctx = { home: ctxHome() }
    home.gohome(bot, ctx)
    assert.equal(bot.calls.goals.length, 1)
    const g = bot.calls.goals[0]
    assert.equal(g.constructor.name, 'GoalNear')
    assert.deepEqual({ x: g.x, y: g.y, z: g.z }, OUTSIDE)
  })

  it('(b) at the closed door opens once, then heads inside', async () => {
    const bot = mockBot({ at: { ...OUTSIDE } })
    const ctx = { home: ctxHome() }
    home.gohome(bot, ctx)
    await settle()
    assert.equal(bot.calls.activates, 1)
    assert.equal(ctx.gohome.phase, 'open')
    home.gohome(bot, ctx)
    const g = bot.calls.goals[bot.calls.goals.length - 1]
    assert.equal(g.constructor.name, 'GoalBlock')
    assert.deepEqual({ x: g.x, y: g.y, z: g.z }, INSIDE)
    assert.equal(bot.calls.activates, 1)
  })

  it('(c) inside closes the door, done, sheltered', async () => {
    const bot = mockBot({ at: { ...INSIDE }, doorOpen: true })
    const ctx = { home: ctxHome() }
    home.gohome(bot, ctx)
    await settle()
    assert.equal(bot.calls.activates, 1)
    home.gohome(bot, ctx)
    assert.equal(ctx.stepStatus, 'done')
    assert.equal(ctx.inShelter, true)
    assert.ok(bot.chats.some((m) => m === 'home for the night'))
  })

  it('no site: fails without touching the door', () => {
    const bot = mockBot({ at: { ...OUTSIDE } })
    const ctx = {}
    home.gohome(bot, ctx)
    assert.equal(ctx.stepStatus, 'failed:no-home')
    assert.equal(bot.calls.activates, 0)
    assert.equal(bot.calls.goals.length, 0)
  })
})

describe('rw4.5 stay', () => {
  it('(d) at night holds position, sheltered, silent', () => {
    const bot = mockBot({ at: { ...INSIDE }, timeOfDay: 15000, moving: true })
    const ctx = { home: ctxHome() }
    home.stay(bot, ctx)
    assert.equal(bot.calls.goals.length, 0)
    assert.equal(ctx.inShelter, true)
    assert.notEqual(ctx.stepStatus, 'done')
  })

  it('(e) at day leaves, closes, done, unsheltered', async () => {
    const realNow = Date.now
    let now = realNow()
    Date.now = () => now
    try {
    const bot = mockBot({ at: { x: 12, y: 64, z: 22 }, timeOfDay: 1000, doorOpen: false })
    const ctx = { home: ctxHome() }
    home.stay(bot, ctx) // hold -> open the closed door
    await settle()
    assert.equal(bot.calls.activates, 1)
    home.stay(bot, ctx) // door open: exit goal (far corner is out of arrival range)
    const g = bot.calls.goals[bot.calls.goals.length - 1]
    assert.equal(g.constructor.name, 'GoalNear')
    assert.deepEqual({ x: g.x, y: g.y, z: g.z }, OUTSIDE)
    bot.entity.position = { ...OUTSIDE } // stepped out
    home.stay(bot, ctx) // arrived: close phase, no toggle yet
    assert.equal(bot.calls.activates, 1)
    now += 5000
    home.stay(bot, ctx) // door still open: close it
    await settle()
    assert.equal(bot.calls.activates, 2)
    home.stay(bot, ctx) // door closed: done
    assert.equal(ctx.stepStatus, 'done')
    assert.equal(ctx.inShelter, false)
    assert.ok(bot.chats.some((m) => m === 'morning; back to work'))
    } finally {
      Date.now = realNow
    }
  })
})
