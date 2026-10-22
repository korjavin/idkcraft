'use strict'

// Reforest-1 (idkcraft-6p4l): beat leaves, bank saplings on idle.
// Unit pins: leaf matcher on registry names, feasibility predicate
// (feasible: leaves near + room + day + no castle; infeasible: night
// with castle / full pack / no leaves), done/failed stepStatus paths
// with the prod signal line.

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const reforest = require('../src/behaviours/reforest')
const { MENU, STEP_ORDER, STEP_CRITERIA, stepWhy } = require('../src/goal')

const LEAF_IDS = { oak_leaves: 18, birch_leaves: 19, oak_log: 17, stone: 1 }

function mockBot({ leaves = [{ x: 5, y: 64, z: 0 }], items = [], castle = null } = {}) {
  const world = new Map()
  for (const p of leaves) world.set(`${p.x},${p.y},${p.z}`, 'oak_leaves')
  const inv = items.slice()
  const bot = {
    inv,
    world,
    entity: { position: { x: 0, y: 64, z: 0 }, onGround: true },
    registry: {
      blocksByName: Object.fromEntries(
        Object.entries(LEAF_IDS).map(([name, id]) => [name, { id }]),
      ),
    },
    pathfinder: {
      goal: null,
      setGoal: (g) => { bot.pathfinder.goal = g },
      isMoving: () => !!bot._moving,
    },
    inventory: { items: () => inv },
    findBlocks: ({ matching, maxDistance, count }) => {
      const out = []
      const bp = bot.entity.position
      for (const [key, name] of world) {
        if (name !== 'oak_leaves' && name !== 'birch_leaves') continue
        const [x, y, z] = key.split(',').map(Number)
        if (!matching.includes(LEAF_IDS[name])) continue
        if (Math.hypot(x - bp.x, y - bp.y, z - bp.z) > maxDistance) continue
        out.push({ x, y, z })
        if (out.length >= (count || 16)) break
      }
      return out
    },
    blockAt: (p) => {
      const x = Math.floor(p.x)
      const y = Math.floor(p.y)
      const z = Math.floor(p.z)
      const name = world.get(`${x},${y},${z}`)
      return { name: name || 'air', position: { x, y, z } }
    },
    canDigBlock: () => true,
    dig: async (block) => {
      const pos = block.position || block
      world.set(`${Math.floor(pos.x)},${Math.floor(pos.y)},${Math.floor(pos.z)}`, 'air')
      inv.push({ name: 'oak_sapling', count: 1 })
    },
    chat: () => {},
  }
  return bot
}

function ctxOf(castle = null) {
  return { lastGoalKey: '', lastPathStatus: 'none', stepStatus: 'running', castle }
}

const tick = () => new Promise((r) => setImmediate(r))

describe('reforest leaf matcher', () => {
  it('matches *_leaves registry names, never logs or stone', () => {
    const bot = mockBot()
    assert.deepEqual(reforest.leafNames(bot).sort(), ['birch_leaves', 'oak_leaves'])
    assert.ok(reforest.isLeafName('oak_leaves'))
    assert.equal(reforest.isLeafName('oak_log'), false)
    assert.equal(reforest.isLeafName('stone'), false)
  })

  it('unscannable bots read no leaves (menu never changes for them)', () => {
    assert.deepEqual(reforest.leafNames({}), [])
    assert.deepEqual(reforest.leavesNear({}, 32, null), [])
    assert.deepEqual(reforest.leavesNear({ findBlocks: () => { throw new Error('x') } }, 32, null), [])
  })
})

describe('reforest feasibility', () => {
  const day = { time: 'day' }
  it('feasible: leaves near + room + day + no castle', () => {
    assert.equal(reforest.reforestFeasible(day, mockBot(), ctxOf()), true)
    assert.equal(MENU.reforest.feasible(day, mockBot(), ctxOf()), true)
  })

  it('infeasible at night', () => {
    assert.equal(reforest.reforestFeasible({ time: 'night' }, mockBot(), ctxOf()), false)
    assert.equal(reforest.reforestFeasible({ time: 'dusk' }, mockBot(), ctxOf()), false)
  })

  it('infeasible under an active castle order', () => {
    const castle = { site: { x: 100, y: 64, z: 100 }, phase: 'lay' }
    assert.equal(reforest.reforestFeasible(day, mockBot(), ctxOf(castle)), false)
  })

  it('infeasible with a full pack', () => {
    const full = []
    for (let i = 0; i < 36; i++) full.push({ name: 'cobblestone', count: 64, stackSize: 64 })
    assert.equal(reforest.reforestFeasible(day, mockBot({ items: full }), ctxOf()), false)
  })

  it('infeasible with no leaves in reach', () => {
    assert.equal(reforest.reforestFeasible(day, mockBot({ leaves: [] }), ctxOf()), false)
  })
})

describe('reforest step wiring', () => {
  it('sits in STEP_ORDER between forage and explore', () => {
    assert.equal(STEP_ORDER.indexOf('reforest'), STEP_ORDER.indexOf('forage') + 1)
    assert.equal(STEP_ORDER.indexOf('explore'), STEP_ORDER.indexOf('reforest') + 1)
  })

  it('names its criterion and rest grounds', () => {
    assert.ok(typeof STEP_CRITERIA.reforest === 'string' && STEP_CRITERIA.reforest.length > 0)
    assert.match(stepWhy('reforest', { time: 'night' }, mockBot(), ctxOf(), ''), /waiting for daylight/)
  })
})

describe('reforest execution', () => {
  it('walks, digs, vacuums and banks the sapling, then keeps beating', async () => {
    const lines = []
    const orig = console.log
    console.log = (...a) => { lines.push(a.join(' ')) }
    try {
      const bot = mockBot()
      const ctx = ctxOf()
      reforest(bot, ctx) // find: takes the leaf
      assert.equal(ctx.reforest.phase, 'walk')
      reforest(bot, ctx) // walk: issues the goal
      const key = ctx.lastGoalKey
      assert.match(key, /^reforest:/)
      // Arrival: standing on the leaf, executor idle.
      bot.entity.position = { x: 5, y: 64, z: 0 }
      bot._moving = false
      reforest(bot, ctx)
      assert.equal(ctx.reforest.phase, 'dig')
      reforest(bot, ctx) // dig: fires the async dig
      await tick()
      await tick()
      assert.equal(ctx.reforest.leaves, 1)
      assert.equal(ctx.reforest.phase, 'pickup')
      assert.equal(bot.inv.filter((i) => i.name === 'oak_sapling').length, 1)
      // Pickup settles on the dug cell, then rescans (leaf is gone).
      bot.entity.position = { x: 5, y: 64, z: 0 }
      for (let i = 0; i < 6; i++) reforest(bot, ctx)
      assert.equal(ctx.stepStatus, 'failed:no-leaves')
    } finally {
      console.log = orig
    }
    const prod = lines.filter((l) => l.startsWith('reforest leaves='))
    assert.equal(prod.length, 1)
    assert.match(prod[0], /^reforest leaves=1 saplings=\+1 fail=no-leaves$/)
  })

  it('done at the wall-time cap with the prod line', () => {
    const logged = []
    const orig = console.log
    console.log = (...a) => { logged.push(a.join(' ')) }
    try {
      const bot = mockBot()
      const ctx = ctxOf()
      reforest(bot, ctx)
      ctx.reforest.startedAt = Date.now() - reforest.REFOREST_MAX_MS - 1
      reforest(bot, ctx)
      assert.equal(ctx.stepStatus, 'done')
    } finally {
      console.log = orig
    }
    assert.match(logged.find((l) => l.startsWith('reforest leaves=')),
      /^reforest leaves=0 saplings=\+0 fail=-$/)
  })

  it('failed:unreachable after three noPath strikes', () => {
    const logged = []
    const orig = console.log
    console.log = (...a) => { logged.push(a.join(' ')) }
    try {
      const bot = mockBot()
      const ctx = ctxOf()
      reforest(bot, ctx) // find
      reforest(bot, ctx) // walk: issues goal
      for (let s = 0; s < 3; s++) {
        ctx.lastPathStatus = 'noPath'
        reforest(bot, ctx)
        // Re-issue after each strike until the step fails.
        if (ctx.stepStatus === 'running') reforest(bot, ctx)
      }
      assert.equal(ctx.stepStatus, 'failed:unreachable')
    } finally {
      console.log = orig
    }
    assert.match(logged.find((l) => l.startsWith('reforest leaves=')),
      /^reforest leaves=0 saplings=\+0 fail=unreachable$/)
  })
})
