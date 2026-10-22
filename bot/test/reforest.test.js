'use strict'

// Reforest-1 (idkcraft-6p4l): beat leaves, bank saplings on idle.
// Unit pins: leaf matcher on registry names, feasibility predicate
// (feasible: leaves near + room + day + no castle; infeasible: night
// with castle / full pack / no leaves), done/failed stepStatus paths
// with the prod signal line, canopy + placed-leaf guards (revmux 01).

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const reforest = require('../src/behaviours/reforest')
const { MENU, STEP_ORDER, STEP_CRITERIA, stepWhy, decide } = require('../src/goal')

const LEAF_IDS = { oak_leaves: 18, birch_leaves: 19, oak_log: 17, stone: 1 }

function mockBot({ leaves = [{ x: 5, y: 64, z: 0 }], items = [], castle = null } = {}) {
  const world = new Map()
  for (const p of leaves) world.set(`${p.x},${p.y},${p.z}`, p.persistent ? { name: 'oak_leaves', persistent: true } : 'oak_leaves')
  const inv = items.slice()
  const goals = []
  const bot = {
    inv,
    world,
    goals,
    entity: { position: { x: 0, y: 64, z: 0 }, onGround: true },
    time: { timeOfDay: 6000 },
    spawnPoint: { x: 0, y: 64, z: 0 },
    registry: {
      blocksByName: Object.fromEntries(
        Object.entries(LEAF_IDS).map(([name, id]) => [name, { id }]),
      ),
    },
    pathfinder: {
      goal: null,
      setGoal: (g) => { goals.push(g && g.constructor && g.constructor.name); bot.pathfinder.goal = g },
      isMoving: () => !!bot._moving,
      bestHarvestTool: () => null,
    },
    inventory: { items: () => inv },
    findBlocks: ({ matching, maxDistance, count }) => {
      const out = []
      const bp = bot.entity.position
      for (const [key, cell] of world) {
        const name = typeof cell === 'string' ? cell : cell.name
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
      const cell = world.get(`${x},${y},${z}`)
      const name = !cell ? 'air' : (typeof cell === 'string' ? cell : cell.name)
      const persistent = !!cell && typeof cell === 'object' && cell.persistent === true
      return {
        name,
        position: { x, y, z },
        getProperties: () => ({ persistent }),
      }
    },
    canDigBlock: (block) => {
      try {
        const pos = (block && block.position) || block
        const bp = bot.entity.position
        return Math.hypot(pos.x - bp.x, pos.y - bp.y, pos.z - bp.z) <= 4.5
      } catch (_) {
        return true
      }
    },
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

function quiet(fn) {
  const logged = []
  const orig = console.log
  console.log = (...a) => { logged.push(a.join(' ')) }
  try {
    fn()
  } finally {
    console.log = orig
  }
  return logged
}

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

  it('infeasible with only placed leaves around (hedges are never targets)', () => {
    const bot = mockBot({ leaves: [{ x: 3, y: 64, z: 0, persistent: true }] })
    assert.equal(reforest.isPersistentLeaf(bot, { x: 3, y: 64, z: 0 }), true)
    assert.equal(reforest.isPersistentLeaf(bot, { x: 9, y: 64, z: 0 }), false)
    assert.equal(reforest.reforestFeasible(day, bot, ctxOf()), true) // scan sees the cell...
    const ctx = ctxOf()
    reforest(bot, ctx) // ...but find skips it and fails honestly
    reforest(bot, ctx)
    assert.equal(ctx.stepStatus, 'failed:no-leaves')
    assert.ok(!bot.goals.includes('GoalNear'), 'no walk goal ever issued at the hedge')
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

  it('a fresh decide pick drops the stale walk', async () => {
    const logged = []
    const orig = console.log
    console.log = (...a) => { logged.push(a.join(' ')) }
    try {
      const bot = mockBot()
      // gear latched (want announced): the idle menu is reforest/explore/rest.
      const ctx = { lastGoalKey: '', lastPathStatus: 'none', stepStatus: 'running', home: { site: { x: 0, y: 64, z: 0 }, built: true }, gear: { saidNeed: 'want-logs' } }
      assert.equal((await decide(bot, ctx)).action, 'reforest')
      // The interrupted leg: a stale mid-walk at the old leaf.
      ctx.reforest = { phase: 'walk', pos: { x: 5, y: 64, z: 0 }, stale: true }
      bot.world.delete('5,64,0') // leaves gone: the menu loses reforest
      ctx.stepStatus = 'done'
      assert.equal((await decide(bot, ctx)).action, 'explore')
      bot.world.set('5,64,0', 'oak_leaves') // leaves back
      ctx.stepStatus = 'done'
      assert.equal((await decide(bot, ctx)).action, 'reforest')
      assert.equal(ctx.reforest, null, 'fresh pick drops the stale walk (the behaviour re-inits at find)')
    } finally {
      console.log = orig
    }
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
      assert.match(ctx.lastGoalKey, /^reforest:/)
      assert.equal(bot.goals[bot.goals.length - 1], 'GoalNear')
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
      // Pickup walks the dug column (XZ), never the empty canopy cell.
      reforest(bot, ctx)
      assert.equal(bot.goals[bot.goals.length - 1], 'GoalNearXZ')
      bot.entity.position = { x: 5, y: 64, z: 0 }
      for (let i = 0; i < 5; i++) reforest(bot, ctx)
      assert.equal(ctx.stepStatus, 'failed:no-leaves')
    } finally {
      console.log = orig
    }
    const prod = lines.filter((l) => l.startsWith('reforest leaves='))
    assert.equal(prod.length, 1)
    assert.match(prod[0], /^reforest leaves=1 saplings=\+1 fail=no-leaves$/)
  })

  it('prefers feet-level leaves over a nearer canopy and walks range 4', () => {
    quiet(() => {
      const bot = mockBot({ leaves: [{ x: 1, y: 70, z: 0 }, { x: 5, y: 64, z: 0 }] })
      const ctx = ctxOf()
      reforest(bot, ctx) // find: the overhead canopy loses to the low leaf 5 out
      assert.deepEqual(
        { x: Math.floor(ctx.reforest.pos.x), y: Math.floor(ctx.reforest.pos.y), z: Math.floor(ctx.reforest.pos.z) },
        { x: 5, y: 64, z: 0 },
      )
      reforest(bot, ctx) // walk: 3D-sphere range 4, never a tower ask
      const goal = bot.pathfinder.goal
      assert.equal(goal && goal.constructor && goal.constructor.name, 'GoalNear')
      assert.equal(goal.rangeSq, reforest.WALK_RANGE * reforest.WALK_RANGE)
    })
  })

  it('done at the wall-time cap with the prod line', () => {
    const logged = quiet(() => {
      const bot = mockBot()
      const ctx = ctxOf()
      reforest(bot, ctx)
      ctx.reforest.startedAt = Date.now() - reforest.REFOREST_MAX_MS - 1
      reforest(bot, ctx)
      assert.equal(ctx.stepStatus, 'done')
    })
    assert.match(logged.find((l) => l.startsWith('reforest leaves=')),
      /^reforest leaves=0 saplings=\+0 fail=-$/)
  })

  it('fails pack-full when the pack fills mid-step, keeping the banked saplings', async () => {
    const lines = []
    const orig = console.log
    console.log = (...a) => { lines.push(a.join(' ')) }
    try {
      const bot = mockBot()
      const ctx = ctxOf()
      reforest(bot, ctx) // find
      reforest(bot, ctx) // walk: issues the goal
      assert.equal(ctx.stepStatus, 'running')
      for (let i = 0; i < 36; i++) bot.inv.push({ name: 'cobblestone', count: 64, stackSize: 64 })
      reforest(bot, ctx)
      assert.equal(ctx.stepStatus, 'failed:pack-full')
    } finally {
      console.log = orig
    }
    assert.match(lines.find((l) => l.startsWith('reforest leaves=')),
      /^reforest leaves=0 saplings=\+0 fail=pack-full$/)
  })

  it('failed:unreachable comes from the strike cap, not the empty scan', () => {
    const lines = []
    const orig = console.log
    console.log = (...a) => { lines.push(a.join(' ')) }
    try {
      const bot = mockBot({ leaves: [{ x: 5, y: 64, z: 0 }, { x: 8, y: 64, z: 0 }, { x: 11, y: 64, z: 0 }] })
      const ctx = ctxOf()
      for (let s = 0; s < 3; s++) {
        reforest(bot, ctx) // find: takes the next leaf (empty only after 3 strikes)
        assert.equal(ctx.stepStatus, 'running', `find ${s + 1} must not finish the step`)
        reforest(bot, ctx) // walk: issues the goal
        ctx.lastPathStatus = 'noPath'
        reforest(bot, ctx) // noPath: one strike on this leaf
        if (s < 2) assert.equal(ctx.stepStatus, 'running', `strike ${s + 1} must not finish the step`)
      }
      assert.equal(ctx.stepStatus, 'failed:unreachable')
      assert.equal(ctx.reforest, null)
    } finally {
      console.log = orig
    }
    assert.match(lines.find((l) => l.startsWith('reforest leaves=')),
      /^reforest leaves=0 saplings=\+0 fail=unreachable$/)
  })

  it('a wedged walk stalls out on displacement, striking at the tick bound', () => {
    quiet(() => {
      const bot = mockBot()
      const ctx = ctxOf()
      bot._moving = true // executor churns, the body never moves
      reforest(bot, ctx) // find
      reforest(bot, ctx) // walk: issues the goal
      for (let i = 0; i < reforest.WALK_STALL_TICKS - 1; i++) {
        reforest(bot, ctx)
        assert.equal(ctx.stepStatus, 'running', `stall tick ${i + 1} must not finish the step`)
      }
      reforest(bot, ctx) // stall bound: the leaf is struck, the scan is empty now
      assert.equal(ctx.reforest.streak, 1)
      reforest(bot, ctx) // find: the struck leaf is skipped
      assert.equal(ctx.stepStatus, 'failed:unreachable')
    })
  })
})
