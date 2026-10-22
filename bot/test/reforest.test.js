'use strict'

// Reforest-1 (idkcraft-6p4l): beat leaves, bank saplings on idle.
// Unit pins: leaf matcher on registry names, feasibility predicate
// (feasible: leaves near + room + day + no castle; infeasible: night
// with castle / full pack / no leaves), done/failed stepStatus paths
// with the prod signal line, canopy + placed-leaf guards (revmux 01),
// honest drop pickup + pre-cap hedge filter (revmux 02).

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const reforest = require('../src/behaviours/reforest')
const { MENU, STEP_ORDER, STEP_CRITERIA, stepWhy, decide } = require('../src/goal')

const LEAF_IDS = { oak_leaves: 18, birch_leaves: 19, oak_log: 17, stone: 1 }

// Honest drops (revmux 02 core-2): the mock dig spawns a drop entity at
// the dug cell instead of crediting the inventory — the behaviour only
// banks what its pickup walk vacuums, like the live bot.
const PICKUP_VACUUM = 1.5

function mockBot({ leaves = [{ x: 5, y: 64, z: 0 }], items = [], castle = null } = {}) {
  const world = new Map()
  for (const p of leaves) world.set(`${p.x},${p.y},${p.z}`, p.persistent ? { name: 'oak_leaves', persistent: true } : 'oak_leaves')
  const inv = items.slice()
  const goals = []
  const drops = []
  const bot = {
    inv,
    world,
    goals,
    drops,
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
    findBlocks: ({ matching, maxDistance, count, useExtraInfo }) => {
      // Like the live scan: nearest first, the count cap applies last.
      const cands = []
      const bp = bot.entity.position
      for (const [key, cell] of world) {
        const name = typeof cell === 'string' ? cell : cell.name
        if (name !== 'oak_leaves' && name !== 'birch_leaves') continue
        const [x, y, z] = key.split(',').map(Number)
        if (!matching.includes(LEAF_IDS[name])) continue
        if (Math.hypot(x - bp.x, y - bp.y, z - bp.z) > maxDistance) continue
        if (typeof useExtraInfo === 'function') {
          const persistent = !!cell && typeof cell === 'object' && cell.persistent === true
          if (!useExtraInfo({ name, getProperties: () => ({ persistent }) })) continue
        }
        cands.push({ x, y, z })
      }
      cands.sort((a, b) =>
        Math.hypot(a.x - bp.x, a.y - bp.y, a.z - bp.z) -
        Math.hypot(b.x - bp.x, b.y - bp.y, b.z - bp.z))
      return cands.slice(0, count || 16)
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
      const x = Math.floor(pos.x)
      const y = Math.floor(pos.y)
      const z = Math.floor(pos.z)
      world.set(`${x},${y},${z}`, 'air')
      drops.push({ x: x + 0.5, y, z: z + 0.5, name: 'oak_sapling', count: 1 })
    },
    chat: () => {},
  }
  return bot
}

// The engine vacuums drops near the body between ticks.
function settleDrops(bot) {
  const bp = bot.entity.position
  bot.drops = bot.drops.filter((d) => {
    if (Math.hypot(d.x - bp.x, d.y - bp.y, d.z - bp.z) <= PICKUP_VACUUM) {
      bot.inv.push({ name: d.name, count: d.count })
      return false
    }
    return true
  })
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
    // The scan refuses the hedge before the cap, so the menu reads
    // infeasible instead of re-picking into an instant fail.
    assert.equal(reforest.leavesNear(bot, 32, null).length, 0)
    assert.equal(reforest.reforestFeasible(day, bot, ctxOf()), false)
    assert.equal(MENU.reforest.feasible(day, bot, ctxOf()), false)
  })

  it('infeasible with only canopy above reach (the walk must never tower)', () => {
    const bot = mockBot({ leaves: [{ x: 0, y: 71, z: 0 }] })
    assert.equal(reforest.beatablesNear(bot, 32, null).length, 0)
    assert.equal(reforest.reforestFeasible(day, bot, ctxOf()), false)
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
      assert.equal(bot.drops.length, 1, 'the dig drops a sapling entity, not inventory')
      settleDrops(bot) // the body stands on the column: the drop vacuums in
      assert.equal(bot.inv.filter((i) => i.name === 'oak_sapling').length, 1)
      // Pickup walks the dug column (XZ), never the empty canopy cell.
      reforest(bot, ctx)
      assert.equal(bot.goals[bot.goals.length - 1], 'GoalNearXZ')
      assert.equal(bot.pathfinder.goal.rangeSq, reforest.PICKUP_RANGE * reforest.PICKUP_RANGE)
      bot.entity.position = { x: 5, y: 64, z: 0 }
      for (let i = 0; i < 4; i++) { reforest(bot, ctx); settleDrops(bot) }
      assert.equal(ctx.stepStatus, 'failed:no-leaves')
    } finally {
      console.log = orig
    }
    const prod = lines.filter((l) => l.startsWith('reforest leaves='))
    assert.equal(prod.length, 1)
    assert.match(prod[0], /^reforest leaves=1 saplings=\+1 fail=no-leaves$/)
  })

  it('a far pickup stays out until the walk closes the column', async () => {
    const bot = mockBot()
    const ctx = ctxOf()
    reforest(bot, ctx) // find
    reforest(bot, ctx) // walk issues
    bot.entity.position = { x: 5, y: 64, z: 0 }
    reforest(bot, ctx) // dig phase
    reforest(bot, ctx) // dig fires
    await tick()
    await tick()
    // The drop waits 5 blocks out: no vacuum, no exit.
    bot.entity.position = { x: 0, y: 64, z: 0 }
    settleDrops(bot)
    assert.equal(bot.inv.filter((i) => i.name === 'oak_sapling').length, 0)
    assert.equal(bot.drops.length, 1)
    reforest(bot, ctx) // pickup: heads for the column
    assert.equal(ctx.reforest.phase, 'pickup')
    assert.equal(ctx.stepStatus, 'running')
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

  it('a high-only canopy issues no walk goal and fails honestly', () => {
    quiet(() => {
      const bot = mockBot({ leaves: [{ x: 0, y: 71, z: 0 }] })
      const ctx = ctxOf()
      reforest(bot, ctx) // find: nothing beatable
      reforest(bot, ctx)
      assert.equal(ctx.stepStatus, 'failed:no-leaves')
      assert.ok(!bot.goals.includes('GoalNear'), 'no tower walk ever issued')
    })
  })

  it('a hedge does not hide the natural stand behind it', () => {
    quiet(() => {
      // The hedge is inserted first (and nearer): without the pre-cap
      // filter the natural leaf never survives the count cap.
      const leaves = []
      for (let i = 1; i <= 17; i++) leaves.push({ x: i, y: 64, z: 1, persistent: true })
      leaves.push({ x: 20, y: 64, z: 0 })
      const bot = mockBot({ leaves })
      const ctx = ctxOf()
      // 17 placed cells nearer than the tree: the pre-cap filter still
      // surfaces the natural leaf.
      reforest(bot, ctx)
      assert.deepEqual(
        { x: Math.floor(ctx.reforest.pos.x), y: Math.floor(ctx.reforest.pos.y), z: Math.floor(ctx.reforest.pos.z) },
        { x: 20, y: 64, z: 0 },
      )
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
