'use strict'

// Reforest-1 (idkcraft-6p4l): beat leaves, bank saplings on idle.
// Reforest-2 (idkcraft-lc55): plant the banked saplings at random vetted
// spots once the leaves run out (same step, capped tail).
// Unit pins: leaf matcher on registry names, feasibility predicate
// (feasible: leaves near + room + day + no castle; infeasible: night
// with castle / full pack / no leaves), done/failed stepStatus paths
// with the prod signal line, canopy + placed-leaf guards (revmux 01),
// honest drop pickup + pre-cap hedge filter (revmux 02), spot-picker
// vetoes, per-step planting cap, per-plant prod lines.

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
      // One leaf beaten and banked, no soil to plant on: the step did its
      // beat work, so it reads done (like the leaf-cap path), not no-leaves.
      assert.equal(ctx.stepStatus, 'done')
    } finally {
      console.log = orig
    }
    const prod = lines.filter((l) => l.startsWith('reforest leaves='))
    assert.equal(prod.length, 1)
    assert.match(prod[0], /^reforest leaves=1 saplings=\+1 fail=- planted=0$/)
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
      /^reforest leaves=0 saplings=\+0 fail=- planted=0$/)
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
      /^reforest leaves=0 saplings=\+0 fail=pack-full planted=0$/)
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
      /^reforest leaves=0 saplings=\+0 fail=unreachable planted=0$/)
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

// Reforest-2 planting (idkcraft-lc55): the plant tail once the leaves run
// out. The world is a dirt field (soil + air + headroom everywhere), so
// every vetted spot plants; each veto is pinned by breaking one gate at a
// time. The mock placement consumes one equipped item into the cell, like
// the live server.
function plantWorld() {
  const names = {}
  for (let x = -40; x <= 40; x++) {
    for (let z = -40; z <= 40; z++) names[`${x},63,${z}`] = 'dirt'
  }
  return names
}

function plantBot({ names = plantWorld(), items = [], onEquip = null } = {}) {
  const goals = []
  const bot = {
    names,
    goals,
    placeCalls: 0,
    equipped: null,
    _items: items,
    entity: { position: { x: 0, y: 64, z: 0 }, onGround: true },
    registry: { blocksByName: { oak_leaves: { id: 18 }, dirt: { id: 2 } } },
    pathfinder: {
      goal: null,
      setGoal: (g) => { goals.push(g && g.constructor && g.constructor.name); bot.pathfinder.goal = g },
      isMoving: () => !!bot._moving,
    },
    inventory: { items: () => bot._items },
    findBlocks: () => [], // no leaves: the step starts in the plant tail
    blockAt: (p) => {
      const x = Math.floor(p.x)
      const y = Math.floor(p.y)
      const z = Math.floor(p.z)
      const name = names[`${x},${y},${z}`] || 'air'
      return { name, position: { x, y, z }, getProperties: () => ({ persistent: false }) }
    },
    canDigBlock: () => true,
    dig: async () => {},
    equip: async (item) => {
      bot.equipped = item && item.name
      if (onEquip) await onEquip(item)
    },
    placeBlock: async (ref, face) => {
      bot.placeCalls++
      const rp = ref && ref.position
      const want = bot.equipped
      const i = bot._items.findIndex((it) => it && it.name === want)
      if (i === -1) throw new Error(`no ${want}`)
      bot._items[i].count -= 1
      if (bot._items[i].count <= 0) bot._items.splice(i, 1)
      if (rp) names[`${rp.x + face.x},${rp.y + face.y},${rp.z + face.z}`] = want
    },
    chat: () => {},
  }
  return bot
}

function plantCtx(over = {}) {
  return { lastGoalKey: '', lastPathStatus: 'none', stepStatus: 'running', ...over }
}

// Drive the tail; teleport along plant walks like the replant drive.
async function drivePlant(bot, ctx, maxTicks = 400) {
  for (let i = 0; i < maxTicks; i++) {
    reforest(bot, ctx)
    await tick()
    await tick() // flush place flights
    if (ctx.stepStatus !== 'running') break
    const r = ctx.reforest
    if (r && r.phase === 'plant-walk' && r.spot) {
      bot.entity.position = { x: r.spot.x + 1, y: r.spot.y, z: r.spot.z }
      bot._moving = false
    }
  }
  await tick()
  await tick()
}

describe('reforest plant spot picker', () => {
  it('accepts soil + air + headroom inside the radius', () => {
    assert.equal(reforest.plantSpotOk(plantBot(), plantCtx(), 5, 64, 0), true)
  })

  it('rejects missing soil, wrong soil and blocked headroom', () => {
    const bot = plantBot()
    assert.equal(reforest.plantSpotOk(bot, plantCtx(), 5, 70, 0), false, 'air below is no soil')
    const stone = plantBot()
    stone.names['6,63,0'] = 'stone'
    assert.equal(reforest.plantSpotOk(stone, plantCtx(), 6, 64, 0), false, 'stone takes no sapling')
    const capped = plantBot()
    capped.names['7,65,0'] = 'oak_leaves'
    assert.equal(reforest.plantSpotOk(capped, plantCtx(), 7, 64, 0), false, 'canopy overhead wastes the item')
  })

  it('rejects outside the radius and inside the body cells', () => {
    const bot = plantBot()
    assert.equal(reforest.plantSpotOk(bot, plantCtx(), 31, 64, 0), false, 'past 30 blocks')
    assert.equal(reforest.plantSpotOk(bot, plantCtx(), 0, 64, 0), false, 'own feet cell')
    assert.equal(reforest.plantSpotOk(bot, plantCtx(), 0, 65, 0), false, 'own head cell')
  })

  it('rejects the house footprint', () => {
    const bot = plantBot()
    const ctx = plantCtx({
      home: {
        site: { x: 0, y: 64, z: 0 },
        interior: { min: { x: 3, y: 63, z: -2 }, max: { x: 9, y: 67, z: 2 } },
      },
    })
    assert.equal(reforest.plantSpotOk(bot, ctx, 5, 64, 0), false)
  })

  it('the shared guard protects footprint soil (the wired gate)', () => {
    const { protectedReason } = require('../src/behaviours/util')
    const bot = plantBot()
    const ctx = plantCtx({
      home: {
        site: { x: 0, y: 64, z: 0 },
        interior: { min: { x: 3, y: 63, z: -2 }, max: { x: 9, y: 67, z: 2 } },
      },
    })
    const soil = { name: 'dirt', position: { x: 5, y: 63, z: 0 }, getProperties: () => null }
    assert.equal(protectedReason(bot, soil, ctx), 'protected')
  })

  it('rejects the castle footprint', () => {
    const castle = require('../src/castle')
    const bot = plantBot()
    const st = { site: { x: 0, y: 60, z: 0 }, rot: 0 }
    assert.equal(castle.inFootprint(st, { x: 2, y: 64, z: 2 }), true, 'fixture sits inside the box')
    assert.equal(reforest.plantSpotOk(bot, plantCtx({ castle: st }), 2, 64, 2), false)
    assert.equal(reforest.plantSpotOk(bot, plantCtx(), 2, 64, 2), true, 'same ground without a castle plants')
  })

  it('rejects danger-marked ground', () => {
    const danger = require('../src/danger')
    const bot = plantBot()
    const ctx = plantCtx()
    danger.mark(ctx, { x: 5, y: 64, z: 0 }, Date.now())
    assert.equal(reforest.plantSpotOk(bot, ctx, 5, 64, 0), false)
    assert.equal(reforest.plantSpotOk(bot, plantCtx(), 5, 64, 0), true, 'unmarked ground plants')
  })

  it('firstSapling skips the lone dark oak, like gather', () => {
    assert.equal(reforest.firstSapling(plantBot()), null)
    assert.equal(reforest.firstSapling(plantBot({ items: [{ name: 'dark_oak_sapling', count: 3 }] })), null)
    const mixed = plantBot({ items: [{ name: 'dark_oak_sapling', count: 1 }, { name: 'oak_sapling', count: 1 }] })
    assert.equal(reforest.firstSapling(mixed).name, 'oak_sapling')
  })

  it('sampled spots stay within the radius', () => {
    const bot = plantBot()
    for (let i = 0; i < 200; i++) {
      const spot = reforest.pickPlantSpot(bot, plantCtx(), new Set())
      assert.ok(spot, `sample ${i} finds a spot on open dirt`)
      assert.ok(Math.hypot(spot.x - 0, spot.z - 0) <= reforest.PLANT_RADIUS, `sample ${i} within 30: ${spot.x},${spot.z}`)
    }
  })

  it('the sampler takes an injectable rng', () => {
    const bot = plantBot()
    const seq = [0, 0.25] // angle 0, radius 30*sqrt(0.25) = 15: exact in fp
    let i = 0
    const spot = reforest.pickPlantSpot(bot, plantCtx(), new Set(), () => seq[(i++) % seq.length])
    assert.deepEqual(spot, { x: 15, y: 64, z: 0 })
  })

  it('no soil anywhere reads no spot', () => {
    assert.equal(reforest.pickPlantSpot(mockBot(), ctxOf(), new Set()), null)
  })

  it('sparse ground falls back to the feasibility probe columns', () => {
    // Soil only under the first probe column: random sampling with a
    // missing rng misses it, the fallback still plants what the menu saw.
    const bot = plantBot({ names: { '10,63,0': 'dirt' }, items: [{ name: 'oak_sapling', count: 1 }] })
    assert.equal(reforest.plantFeasible(bot, plantCtx()), true)
    const spot = reforest.pickPlantSpot(bot, plantCtx(), new Set(), () => 0.999)
    assert.deepEqual(spot, { x: 10, y: 64, z: 0 })
  })

  it('rejects peer-known castles and their yard ring', () => {
    const st = { site: { x: 0, y: 60, z: 0 }, rot: 0 }
    const bot = plantBot()
    assert.equal(reforest.plantSpotOk(bot, plantCtx({ knownCastles: [st] }), 2, 64, 2), false, 'peer footprint')
    assert.equal(reforest.plantSpotOk(bot, plantCtx({ knownCastles: [st] }), -1, 64, 2), false, 'yard ring')
    assert.equal(reforest.plantSpotOk(bot, plantCtx(), -1, 64, 2), true, 'same ground with no castles plants')
  })

  it('a capped column never plants the pocket below', () => {
    const bot = plantBot()
    bot.names['5,64,0'] = 'stone'
    bot.names['5,59,0'] = 'dirt'
    assert.equal(reforest.surfaceSpotAt(bot, plantCtx(), 5, 0, null), null)
  })
})

describe('reforest planting feasibility', () => {
  const day = { time: 'day' }
  it('feasible with banked saplings and a vetted spot, no leaves', () => {
    const bot = plantBot({ items: [{ name: 'oak_sapling', count: 1 }] })
    assert.equal(reforest.plantFeasible(bot, plantCtx()), true)
    assert.equal(reforest.reforestFeasible(day, bot, plantCtx()), true)
    assert.equal(MENU.reforest.feasible(day, plantBot({ items: [{ name: 'oak_sapling', count: 1 }] }), plantCtx()), true)
  })

  it('infeasible with saplings but no soil anywhere', () => {
    const bot = mockBot({ leaves: [], items: [{ name: 'oak_sapling', count: 1 }] })
    assert.equal(reforest.plantFeasible(bot, ctxOf()), false)
    assert.equal(reforest.reforestFeasible(day, bot, ctxOf()), false)
    assert.equal(MENU.reforest.feasible(day, mockBot({ leaves: [], items: [{ name: 'oak_sapling', count: 1 }] }), ctxOf()), false)
  })

  it('infeasible with a dark-oak-only pack and no leaves', () => {
    const bot = plantBot({ items: [{ name: 'dark_oak_sapling', count: 3 }] })
    assert.equal(reforest.reforestFeasible(day, bot, plantCtx()), false)
  })
})

// Beat-then-plant integration (core-1): leaf groves on the dirt field, so
// the step beats first and the tail plants the vacuumed drops.
function groveBot({ leaves = [], items = [], onEquip = null } = {}) {
  const names = plantWorld()
  for (const p of leaves) names[`${p.x},${p.y},${p.z}`] = 'oak_leaves'
  const bot = plantBot({ names, items, onEquip })
  bot.registry.blocksByName = {
    oak_leaves: { id: 18 },
    birch_leaves: { id: 19 },
    oak_log: { id: 17 },
    stone: { id: 1 },
    dirt: { id: 2 },
  }
  bot.drops = []
  bot.findBlocks = ({ matching, maxDistance, count, useExtraInfo }) => {
    const cands = []
    const bp = bot.entity.position
    for (const [key, cell] of Object.entries(names)) {
      if (cell !== 'oak_leaves' && cell !== 'birch_leaves') continue
      const [x, y, z] = key.split(',').map(Number)
      if (!matching.includes(bot.registry.blocksByName[cell].id)) continue
      if (Math.hypot(x - bp.x, y - bp.y, z - bp.z) > maxDistance) continue
      if (typeof useExtraInfo === 'function') {
        if (!useExtraInfo({ name: cell, getProperties: () => ({ persistent: false }) })) continue
      }
      cands.push({ x, y, z })
    }
    cands.sort((a, b) =>
      Math.hypot(a.x - bp.x, a.y - bp.y, a.z - bp.z) -
      Math.hypot(b.x - bp.x, b.y - bp.y, b.z - bp.z))
    return cands.slice(0, count || 16)
  }
  bot.canDigBlock = (block) => {
    if (!block || !block.position) return false
    const e = bot.entity.position
    const dx = block.position.x + 0.5 - e.x
    const dy = block.position.y + 0.5 - (e.y + 1.65)
    const dz = block.position.z + 0.5 - e.z
    return Math.hypot(dx, dy, dz) <= 4.5
  }
  bot.dig = async (block) => {
    const pos = block.position || block
    const x = Math.floor(pos.x)
    const y = Math.floor(pos.y)
    const z = Math.floor(pos.z)
    names[`${x},${y},${z}`] = 'air'
    bot.drops.push({ x: x + 0.5, y, z: z + 0.5, name: 'oak_sapling', count: 1 })
  }
  return bot
}

function settleGrove(bot) {
  const bp = bot.entity.position
  bot.drops = bot.drops.filter((d) => {
    if (Math.hypot(d.x - bp.x, d.y - bp.y, d.z - bp.z) <= PICKUP_VACUUM) {
      bot._items.push({ name: d.name, count: d.count })
      return false
    }
    return true
  })
}

// Drive beats and plants; teleport along every walk leg.
async function driveGrove(bot, ctx, maxTicks = 600) {
  for (let i = 0; i < maxTicks; i++) {
    reforest(bot, ctx)
    await tick()
    await tick()
    settleGrove(bot)
    if (ctx.stepStatus !== 'running') break
    const r = ctx.reforest
    if (!r) continue
    if ((r.phase === 'walk' || r.phase === 'pickup') && r.pos) {
      bot.entity.position = { x: r.pos.x, y: r.pos.y, z: r.pos.z }
      bot._moving = false
    } else if (r.phase === 'plant-walk' && r.spot) {
      bot.entity.position = { x: r.spot.x + 1, y: r.spot.y, z: r.spot.z }
      bot._moving = false
    }
  }
  await tick()
  await tick()
  settleGrove(bot)
}

describe('reforest beat-then-plant', () => {
  it('beats the grove dry, then plants the vacuumed drops', async () => {
    const lines = []
    const orig = console.log
    console.log = (...a) => { lines.push(a.join(' ')) }
    try {
      const bot = groveBot({ leaves: [{ x: 5, y: 64, z: 0 }, { x: 8, y: 64, z: 0 }] })
      const ctx = plantCtx()
      await driveGrove(bot, ctx)
      assert.equal(ctx.stepStatus, 'done')
      assert.equal(bot.placeCalls, 2)
    } finally {
      console.log = orig
    }
    const plants = lines.filter((l) => l.startsWith('reforest plant '))
    assert.equal(plants.length, 2)
    const summary = lines.filter((l) => l.startsWith('reforest leaves='))
    assert.equal(summary.length, 1)
    assert.match(summary[0], /^reforest leaves=2 saplings=\+2 fail=- planted=2$/)
  })

  it('a dense grove beats to the leaf cap, then plants', async () => {
    const lines = []
    const orig = console.log
    console.log = (...a) => { lines.push(a.join(' ')) }
    try {
      const leaves = []
      for (let x = 5; x <= 14; x++) leaves.push({ x, y: 64, z: 0 })
      const bot = groveBot({ leaves })
      const ctx = plantCtx()
      await driveGrove(bot, ctx)
      assert.equal(ctx.stepStatus, 'done')
      assert.equal(bot.placeCalls, reforest.PLANT_MAX)
    } finally {
      console.log = orig
    }
    const summary = lines.filter((l) => l.startsWith('reforest leaves='))
    assert.equal(summary.length, 1)
    assert.match(summary[0], /^reforest leaves=8 saplings=\+8 fail=- planted=8$/)
  })

  it('struck leaves plant the banked saplings instead of failing', async () => {
    const lines = []
    const orig = console.log
    console.log = (...a) => { lines.push(a.join(' ')) }
    try {
      const bot = groveBot({
        leaves: [{ x: 5, y: 64, z: 0 }, { x: 8, y: 64, z: 0 }, { x: 11, y: 64, z: 0 }],
        items: [{ name: 'oak_sapling', count: 2 }],
      })
      const ctx = plantCtx()
      for (let i = 0; i < 600 && ctx.stepStatus === 'running'; i++) {
        reforest(bot, ctx)
        await tick()
        await tick()
        settleGrove(bot)
        if (/^reforest:\d/.test(ctx.lastGoalKey)) ctx.lastPathStatus = 'noPath'
        const r = ctx.reforest
        if (r && r.phase === 'plant-walk' && r.spot) {
          bot.entity.position = { x: r.spot.x + 1, y: r.spot.y, z: r.spot.z }
          bot._moving = false
        }
      }
      assert.equal(ctx.stepStatus, 'done')
      assert.equal(bot.placeCalls, 2)
    } finally {
      console.log = orig
    }
    assert.match(lines.find((l) => l.startsWith('reforest leaves=')),
      /^reforest leaves=0 saplings=\+0 fail=- planted=2$/)
  })
})

describe('reforest plant tail execution', () => {
  it('plants to the per-step cap, then done with the prod lines', async () => {
    const lines = []
    const orig = console.log
    console.log = (...a) => { lines.push(a.join(' ')) }
    let bot = null
    try {
      bot = plantBot({ items: [{ name: 'oak_sapling', count: 20 }] })
      const ctx = plantCtx()
      await drivePlant(bot, ctx)
      assert.equal(ctx.stepStatus, 'done')
      assert.equal(ctx.reforest, null)
      assert.equal(bot.placeCalls, reforest.PLANT_MAX)
    } finally {
      console.log = orig
    }
    const plants = lines.filter((l) => l.startsWith('reforest plant '))
    assert.equal(plants.length, reforest.PLANT_MAX)
    for (const l of plants) assert.match(l, /^reforest plant oak_sapling at -?\d+,64,-?\d+$/)
    const summary = lines.filter((l) => l.startsWith('reforest leaves='))
    assert.equal(summary.length, 1)
    assert.match(summary[0], /^reforest leaves=0 saplings=\+0 fail=- planted=8$/)
    assert.equal(bot._items.reduce((n, it) => n + it.count, 0), 20 - reforest.PLANT_MAX)
  })

  it('an empty pack plants nothing and keeps the leaf verdict', async () => {
    const lines = []
    const orig = console.log
    console.log = (...a) => { lines.push(a.join(' ')) }
    try {
      const bot = plantBot({ items: [] })
      const ctx = plantCtx()
      await drivePlant(bot, ctx)
      assert.equal(ctx.stepStatus, 'failed:no-leaves')
    } finally {
      console.log = orig
    }
    assert.equal(lines.filter((l) => l.startsWith('reforest plant ')).length, 0)
    assert.match(lines.find((l) => l.startsWith('reforest leaves=')),
      /^reforest leaves=0 saplings=\+0 fail=no-leaves planted=0$/)
  })

  it('a dark-oak-only pack never plants', async () => {
    const bot = plantBot({ items: [{ name: 'dark_oak_sapling', count: 3 }] })
    const ctx = plantCtx()
    await quietDrive(bot, ctx)
    assert.equal(ctx.stepStatus, 'failed:no-leaves')
    assert.equal(bot.placeCalls, 0)
    assert.equal(bot._items.filter((it) => it.name === 'dark_oak_sapling').length, 1)
  })

  it('unreachable walks burn the fail budget, never the leaf strikes', async () => {
    const orig = console.log
    console.log = () => {}
    try {
      const bot = plantBot({ items: [{ name: 'oak_sapling', count: 3 }] })
      const ctx = plantCtx()
      for (let i = 0; i < 400 && ctx.stepStatus === 'running'; i++) {
        reforest(bot, ctx)
        await tick()
        await tick()
        if (ctx.lastGoalKey.startsWith('reforest-plant:')) ctx.lastPathStatus = 'noPath'
      }
      assert.equal(ctx.stepStatus, 'failed:no-leaves')
      assert.equal(bot.placeCalls, 0)
    } finally {
      console.log = orig
    }
  })

  it('a steal across the equip await aborts the place', async () => {
    const bot = plantBot({
      items: [{ name: 'oak_sapling', count: 3 }],
      onEquip: async () => { ctx.lastGoalKey = 'fight:zombie' },
    })
    const ctx = plantCtx()
    await quietDrive(bot, ctx)
    assert.equal(ctx.stepStatus, 'failed:no-leaves')
    assert.equal(bot.placeCalls, 0)
    assert.equal(bot.equipped, 'oak_sapling')
  })

  it('a taken spot across the equip await is never planted over', async () => {
    const names = plantWorld()
    const bot = plantBot({
      names,
      items: [{ name: 'oak_sapling', count: 3 }],
      onEquip: async () => {
        const s = ctx.reforest && ctx.reforest.spot
        // Stone kills the whole column (no soil at any row), so the
        // re-veto refuses and no later pick plants over it either.
        if (s) names[`${s.x},${s.y},${s.z}`] = 'stone'
      },
    })
    const ctx = plantCtx()
    await quietDrive(bot, ctx)
    assert.equal(bot.placeCalls, 0, 'every attempt meets a taken cell')
    assert.equal(ctx.stepStatus, 'failed:no-leaves')
    assert.equal(bot._items.reduce((n, it) => n + it.count, 0), 3, 'no sapling spent on taken cells')
  })

  it('a deadline tick waits for the in-flight planting', async () => {
    const lines = []
    const orig = console.log
    console.log = (...a) => { lines.push(a.join(' ')) }
    try {
      const bot = plantBot({ items: [{ name: 'oak_sapling', count: 1 }] })
      const rawPlace = bot.placeBlock
      let release = null
      bot.placeBlock = (...a) => new Promise((resolve, reject) => {
        release = () => rawPlace(...a).then(resolve, reject)
      })
      const ctx = plantCtx()
      let fired = false
      for (let i = 0; i < 400 && ctx.stepStatus === 'running' && !fired; i++) {
        reforest(bot, ctx)
        await tick()
        await tick()
        const r = ctx.reforest
        if (r && r.plantInFlight) fired = true
        else if (r && r.phase === 'plant-walk' && r.spot) {
          bot.entity.position = { x: r.spot.x + 1, y: r.spot.y, z: r.spot.z }
          bot._moving = false
        }
      }
      assert.ok(fired, 'flight fired')
      assert.ok(release, 'flight held')
      // The tail budget expires mid-flight: the step must wait, not finish.
      ctx.reforest.plantStartedAt = Date.now() - reforest.REFOREST_MAX_MS - 1000
      reforest(bot, ctx)
      await tick()
      assert.equal(ctx.stepStatus, 'running', 'deadline waits for the landing')
      release()
      await tick()
      await tick()
      reforest(bot, ctx) // plant-pick: pack empty now
      assert.equal(ctx.stepStatus, 'done')
      assert.equal(bot.placeCalls, 1)
    } finally {
      console.log = orig
    }
    assert.match(lines.find((l) => l.startsWith('reforest leaves=')),
      /^reforest leaves=0 saplings=\+0 fail=- planted=1$/)
  })

  it('a refused planting bans its cell and moves on', async () => {
    const lines = []
    const orig = console.log
    console.log = (...a) => { lines.push(a.join(' ')) }
    try {
      const bot = plantBot({ items: [{ name: 'oak_sapling', count: 1 }] })
      const rawPlace = bot.placeBlock
      let refused = null
      bot.placeBlock = async (ref, face) => {
        const rp = ref && ref.position
        const cell = rp ? `${rp.x + face.x},${rp.y + face.y},${rp.z + face.z}` : null
        if (!refused) {
          refused = cell // first attempt refused, never retried
          throw new Error('refused')
        }
        return rawPlace(ref, face)
      }
      const ctx = plantCtx()
      let seenTried = null
      for (let i = 0; i < 600 && ctx.stepStatus === 'running'; i++) {
        reforest(bot, ctx)
        await tick()
        await tick()
        const r = ctx.reforest
        if (r && r.plantFails >= 1 && seenTried === null && r.spot === null && r.phase === 'plant-pick') {
          seenTried = new Set(r.triedPlant)
        }
        if (r && r.phase === 'plant-walk' && r.spot) {
          bot.entity.position = { x: r.spot.x + 1, y: r.spot.y, z: r.spot.z }
          bot._moving = false
        }
      }
      assert.equal(ctx.stepStatus, 'done')
      assert.ok(refused, 'a refusal happened')
      assert.ok(seenTried && seenTried.has(refused), `refused cell ${refused} banned`)
      assert.notEqual(bot.names[refused], 'oak_sapling', 'refused cell never planted over')
    } finally {
      console.log = orig
    }
    assert.match(lines.find((l) => l.startsWith('reforest leaves=')),
      /^reforest leaves=0 saplings=\+0 fail=- planted=1$/)
  })
})

async function quietDrive(bot, ctx) {
  const orig = console.log
  console.log = () => {}
  try {
    await drivePlant(bot, ctx)
  } finally {
    console.log = orig
  }
}
