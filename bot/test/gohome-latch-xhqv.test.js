'use strict'

// Bead idkcraft-xhqv: gohome is self-advancing (no failHolds), so a gohome
// failing at the same spot (cannot-reach-home, door-stuck, a re-skipped door)
// was re-picked through the askedKey shortcut till dawn. Two failures at one
// spot latch gohome out for the night; shelter takes it, as a night rule.

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const goal = require('../src/goal')
require('../src/index') // BEHAVIOURS registration for registered()

function pos(x, y, z) {
  const p = { x, y, z, distanceTo: (q) => Math.hypot(x - q.x, y - q.y, z - q.z) }
  p.clone = () => pos(p.x, p.y, p.z)
  p.floored = () => pos(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z))
  return p
}

const SITE = { x: 200, y: 64, z: 200 }

function menuBot(at, timeOfDay = 15000) {
  return {
    chats: [],
    username: 'IdkBot',
    entities: {},
    health: 20,
    food: 20,
    time: { timeOfDay, day: 5 },
    spawnPoint: pos(0, 64, 0),
    entity: { position: pos(at.x, at.y, at.z) },
    // craft + equip feasible: day-step distractors below shelter.
    inventory: { items: () => [{ name: 'oak_log', count: 14 }, { name: 'cobblestone', count: 2 }] },
    blockAt: (p) => {
      const x = Math.floor(p.x)
      const y = Math.floor(p.y)
      const z = Math.floor(p.z)
      if (x === SITE.x + 5 && y === SITE.y && z === SITE.z + 1) return { name: 'crafting_table', boundingBox: 'block' }
      if (x === SITE.x + 3 && y === SITE.y && z === SITE.z) return { name: 'oak_door', boundingBox: 'block' }
      if (y < SITE.y) return { name: 'dirt', boundingBox: 'block' }
      return { name: 'oak_planks', boundingBox: 'block' }
    },
    findBlocks: () => [],
    players: { Steve: { username: 'Steve', entity: { position: pos(5, 64, 5), username: 'Steve' } } },
    pathfinder: { goal: null, setGoal: () => {}, isMoving: () => false },
    setControlState: () => {},
    clearControlStates: () => {},
    chat: () => {},
  }
}

function menuCtx() {
  const site = { ...SITE }
  return {
    home: {
      site,
      built: true,
      v: 2,
      interior: { min: { x: site.x + 1, y: site.y, z: site.z + 1 }, max: { x: site.x + 5, y: site.y + 1, z: site.z + 4 } },
      door: { x: site.x + 3, y: site.y, z: site.z },
      table: { x: site.x + 5, y: site.y, z: site.z + 1 },
    },
  }
}

// One gohome failure handed to decide with the shortcut armed (same text,
// same failure status): exactly the prod re-pick loop.
async function failGohome(bot, ctx, status = 'failed:cannot-reach-home') {
  ctx.step = 'gohome'
  ctx.stepStatus = status
  ctx.gohome = { phase: 'failed' }
  const text = goal.goalText(goal.goalFacts(bot, ctx), ctx.home)
  ctx.goalText = text
  ctx.askedKey = `${text}\n${status}`
  return goal.decide(bot, ctx)
}

async function quiet(fn) {
  const log = console.log
  const err = console.error
  const lines = []
  console.log = (m) => lines.push(String(m))
  console.error = () => {}
  try {
    await fn()
  } finally {
    console.log = log
    console.error = err
  }
  return lines
}

describe('xhqv per-night gohome latch', () => {
  it('two failures at one spot hand the night to shelter till dawn', async () => {
    const bot = menuBot({ x: 195, y: 64, z: 195 })
    const ctx = menuCtx()
    const lines = await quiet(async () => {
      assert.equal((await failGohome(bot, ctx)).action, 'gohome', 'the first failure retries')
      bot.entity.position = pos(197, 64, 196) // a few blocks on: same spot
      assert.equal((await failGohome(bot, ctx, 'failed:door-stuck')).action, 'shelter', 'the second latches')
      assert.deepEqual(ctx.shelter, {}, 'fresh pillar state')
      // Running shelter with unchanged facts near home: no night-near release.
      ctx.stepStatus = 'running'
      for (let i = 0; i < 3; i++) assert.equal((await goal.decide(bot, ctx)).action, 'shelter', 'holds all night')
      assert.equal(goal.stepWhy('gohome', goal.goalFacts(bot, ctx), bot, ctx, ''), 'gohome: failed at the same spot tonight')
      // Dawn clears the latch; the next dusk walks home again.
      bot.time.timeOfDay = 1000
      await goal.decide(bot, ctx)
      assert.equal(ctx.gohomeLatch, null, 'the latch lasts one night')
      bot.time.timeOfDay = 12500
      ctx.stepStatus = 'done'
      assert.equal((await goal.decide(bot, ctx)).action, 'gohome', 'tomorrow dusk walks home')
    })
    assert.ok(lines.some((l) => l.startsWith('goal gohome latched for the night fails=2 status=failed:door-stuck')), 'latch logged')
  })

  it('failures far apart never latch', async () => {
    const bot = menuBot({ x: 195, y: 64, z: 195 })
    const ctx = menuCtx()
    await quiet(async () => {
      await failGohome(bot, ctx)
      bot.entity.position = pos(150, 64, 150) // ~64 blocks away, still near home
      assert.equal((await failGohome(bot, ctx)).action, 'gohome', 'a new spot retries')
      assert.equal(ctx.gohomeLatch.fails, 1)
    })
  })

  it('the model is not asked once latched: shelter is a night rule', async () => {
    const bot = menuBot({ x: 195, y: 64, z: 195 })
    const ctx = menuCtx()
    let asked = 0
    ctx.brain = { source: 'laya', ask: async () => { asked++; return 'craft' } }
    await quiet(async () => {
      await failGohome(bot, ctx)
      const r = await failGohome(bot, ctx)
      assert.equal(r.action, 'shelter')
    })
    assert.equal(asked, 0)
  })

  it('latched at dusk: gohome is off, the work menu runs till night shelters', async () => {
    const bot = menuBot({ x: 195, y: 64, z: 195 }, 12500)
    const ctx = menuCtx()
    await quiet(async () => {
      await failGohome(bot, ctx)
      const r = await failGohome(bot, ctx)
      assert.notEqual(r.action, 'gohome')
      assert.notEqual(r.action, 'shelter', 'shelter is the night step')
      bot.time.timeOfDay = 15000
      ctx.stepStatus = 'running'
      assert.equal((await goal.decide(bot, ctx)).action, 'shelter')
    })
  })
})
