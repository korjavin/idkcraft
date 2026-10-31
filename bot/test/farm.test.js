'use strict'

// Wheat autonomy (idkcraft-1z1m): hoe, till, water, plant, harvest, feed.
// Unit pins: pure block predicates (tillable tufts, mature wheat age 7,
// dry farmland), the menu feasibility gate (ripe crop pulls the step;
// night never does), and one mock-body run per leg — till turns soil to
// farmland, planting seeds empty farmland, harvest digs only mature
// wheat, the bucket trench waters dry soil, and wheat carried to sheep
// ends the step done with no failed: reason.

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const farm = require('../src/behaviours/farm')
const { denyReason } = require('../src/behaviours/util')
const { MENU, STEP_ORDER, STEP_CRITERIA, registered } = require('../src/goal')
const { BEHAVIOURS } = require('../src/behaviours/index')

const IDS = {
  grass_block: 1, dirt: 2, farmland: 3, wheat: 4, water: 5, stone: 6,
  short_grass: 7, sand: 8, air: 0,
}

function mockBot({ cells = {}, items = [], sheep = null } = {}) {
  const world = new Map(Object.entries(cells))
  const ops = { dig: [], use: [], useItem: [], useEntity: [], equip: [], goals: [], chat: [] }
  const bot = {
    ops,
    world,
    entity: { position: { x: 0, y: 64, z: 0 } },
    time: { timeOfDay: 6000 },
    heldItem: null,
    entities: {},
    registry: { blocksByName: Object.fromEntries(Object.entries(IDS).map(([n, id]) => [n, { id }])) },
    pathfinder: {
      goal: null,
      setGoal: (g) => { ops.goals.push(`${g && g.constructor && g.constructor.name}:${g && g.rangeSq}`); bot.pathfinder.goal = g },
      isMoving: () => false,
    },
    inventory: { items: () => bot.inv },
    inv: items.slice(),
    blockAt: (p) => {
      const x = Math.floor(p.x), y = Math.floor(p.y), z = Math.floor(p.z)
      const cell = world.get(`${x},${y},${z}`)
      const name = !cell ? 'air' : (typeof cell === 'string' ? cell : cell.name)
      return {
        name,
        position: { x, y, z },
        getProperties: () => (cell && typeof cell === 'object' && cell.props) ? { ...cell.props } : {},
      }
    },
    findBlocks: ({ matching, maxDistance, count }) => {
      const bp = bot.entity.position
      const out = []
      for (const [key, cell] of world) {
        const name = typeof cell === 'string' ? cell : cell.name
        const id = IDS[name]
        if (!matching.includes(id)) continue
        const [x, y, z] = key.split(',').map(Number)
        if (Math.hypot(x - bp.x, y - bp.y, z - bp.z) > maxDistance) continue
        out.push({ x, y, z })
      }
      out.sort((a, b) =>
        Math.hypot(a.x - bp.x, a.y - bp.y, a.z - bp.z) -
        Math.hypot(b.x - bp.x, b.y - bp.y, b.z - bp.z))
      return out.slice(0, count || 16)
    },
    dig: async (b) => {
      ops.dig.push(b.name)
      const p = b.position
      world.set(`${p.x},${p.y},${p.z}`, 'air')
    },
    activateBlock: async (b) => {
      ops.use.push(`${bot.heldItem ? bot.heldItem.name : 'empty'}>${b.name}`)
      const p = b.position
      const k = `${p.x},${p.y},${p.z}`
      if (bot.heldItem && bot.heldItem.name.endsWith('_hoe') && (b.name === 'grass_block' || b.name === 'dirt')) {
        world.set(k, 'farmland')
      } else if (bot.heldItem && bot.heldItem.name === 'wheat_seeds' && b.name === 'farmland') {
        world.set(`${p.x},${p.y + 1},${p.z}`, { name: 'wheat', props: { age: 0 } })
      } else if (bot.heldItem && bot.heldItem.name === 'water_bucket' && b.name === 'stone') {
        world.set(`${p.x},${p.y + 1},${p.z}`, 'water')
      }
    },
    equip: async (item) => { ops.equip.push(item.name); bot.heldItem = item },
    lookAt: async (p) => { bot.lookPoint = { x: p.x, y: p.y, z: p.z } },
    activateItem: async () => {
      ops.useItem.push(bot.heldItem ? bot.heldItem.name : 'empty')
      // Bucket use places water at the aimed cell (look point), like the
      // client use path on both bodies. noPour spills: the use fires but no
      // water lands (the honest-miss branch).
      if (bot.noPour) return
      if (bot.heldItem && bot.heldItem.name === 'water_bucket' && bot.lookPoint) {
        const k = `${Math.floor(bot.lookPoint.x)},${Math.floor(bot.lookPoint.y)},${Math.floor(bot.lookPoint.z)}`
        world.set(k, 'water')
        bot.inv = bot.inv.filter((i) => i.name !== 'water_bucket')
        bot.inv.push({ name: 'bucket', count: 1 })
      }
    },
    chat: (line) => { ops.chat.push(line) },
  }
  if (sheep) {
    const flock = Array.isArray(sheep) ? sheep : [sheep]
    flock.forEach((s, i) => {
      bot.entities[7 + i] = { id: 7 + i, name: 'sheep', position: { x: s.x, y: s.y, z: s.z }, isValid: true }
    })
  }
  bot.activateEntity = async (e) => {
    ops.useEntity.push(e && e.id)
    // Server consumes one wheat per fed sheep (love mode), like the bucket.
    const w = bot.inv.find((it) => it && it.name === 'wheat')
    if (w) { w.count = (typeof w.count === 'number' ? w.count : 1) - 1; if (w.count <= 0) bot.inv = bot.inv.filter((it) => it !== w) }
  }
  return bot
}

function ctxOf() {
  return { step: 'farm', stepStatus: 'running' }
}

const DAY = { time: 'day' }

describe('farm predicates', () => {
  it('tills dirt and grass only, tufts seed, wheat ripes at 7', () => {
    assert.equal(farm.isTillable('dirt'), true)
    assert.equal(farm.isTillable('grass_block'), true)
    assert.equal(farm.isTillable('farmland'), false)
    assert.equal(farm.isTillable('coarse_dirt'), false)
    assert.equal(farm.isSeedTuft('short_grass'), true)
    assert.equal(farm.isSeedTuft('tall_grass'), true)
    assert.equal(farm.isSeedTuft('wheat'), false)
    assert.equal(farm.isMatureWheat({ name: 'wheat', getProperties: () => ({ age: 7 }) }), true)
    assert.equal(farm.isMatureWheat({ name: 'wheat', getProperties: () => ({ age: 3 }) }), false)
    assert.equal(farm.isMatureWheat({ name: 'wheat', getProperties: () => ({}) }), false)
    assert.equal(farm.isMatureWheat({ name: 'wheat' }), false)
    assert.equal(farm.isFarmland({ name: 'farmland' }), true)
    assert.equal(farm.needsWater({ name: 'farmland', getProperties: () => ({ moisture: 0 }) }), true)
    assert.equal(farm.needsWater({ name: 'farmland', getProperties: () => ({ moisture: 4 }) }), false)
    assert.equal(farm.needsWater({ name: 'farmland', getProperties: () => ({}) }), false)
  })

  it('guard: farm step digs tufts + mature wheat only', () => {
    const ripe = { name: 'wheat', position: { x: 1, y: 64, z: 0 }, getProperties: () => ({ age: 7 }) }
    const young = { name: 'wheat', position: { x: 1, y: 64, z: 0 }, getProperties: () => ({ age: 2 }) }
    const tuft = { name: 'short_grass', position: { x: 1, y: 64, z: 0 }, getProperties: () => ({}) }
    const bot = mockBot()
    assert.equal(denyReason(bot, ripe, { step: 'farm' }), null)
    assert.equal(denyReason(bot, tuft, { step: 'farm' }), null)
    assert.equal(denyReason(bot, young, { step: 'farm' }), 'protected')
    assert.equal(denyReason(bot, ripe, { step: 'gather' }), 'protected')
  })

  it('feed pulls only near sheep and cools down after a lure', () => {
    const near = mockBot({ items: [{ name: 'wheat', count: 1 }], sheep: { x: 2, y: 64, z: 0 } })
    assert.ok(farm.feedReady(near, ctxOf()))
    const far = mockBot({ items: [{ name: 'wheat', count: 1 }], sheep: { x: 40, y: 64, z: 0 } })
    assert.equal(farm.feedReady(far, ctxOf()), null)
    const cooled = mockBot({ items: [{ name: 'wheat', count: 1 }], sheep: { x: 2, y: 64, z: 0 } })
    const cooledCtx = ctxOf()
    cooledCtx.farmFedAt = Date.now()
    assert.equal(farm.feedReady(cooled, cooledCtx), null)
  })

  it('menu gate: ripe crop pulls, night never does', () => {
    const ripe = mockBot({ cells: { '2,64,0': { name: 'wheat', props: { age: 7 } } } })
    assert.equal(farm.farmFeasible(DAY, ripe, ctxOf()), true)
    assert.equal(farm.farmFeasible({ time: 'night' }, ripe, ctxOf()), false)
    const empty = mockBot()
    assert.equal(farm.farmFeasible(DAY, empty, ctxOf()), false)
    const young = mockBot({ cells: { '2,64,0': { name: 'wheat', props: { age: 1 } } } })
    assert.equal(farm.farmFeasible(DAY, young, ctxOf()), false)
  })

  it('registers in the goal menu between reforest and explore', () => {
    assert.equal(typeof BEHAVIOURS.farm, 'function')
    assert.equal(registered('farm'), true)
    assert.ok(STEP_ORDER.includes('farm'))
    assert.ok(STEP_ORDER.indexOf('farm') > STEP_ORDER.indexOf('reforest'))
    assert.ok(STEP_ORDER.indexOf('farm') < STEP_ORDER.indexOf('explore'))
    assert.equal(typeof MENU.farm.feasible, 'function')
    assert.equal(typeof STEP_CRITERIA.farm, 'string')
    assert.equal(MENU.farm.chat(), 'on my own: tending the wheat field')
  })
})

describe('farm legs', () => {
  it('tills soil near water then plants the new farmland', async () => {
    const bot = mockBot({
      cells: { '1,64,0': 'grass_block', '3,64,0': 'water' },
      items: [{ name: 'wooden_hoe', count: 1 }, { name: 'wheat_seeds', count: 4 }],
    })
    const ctx = ctxOf()
    for (let t = 0; t < 12 && ctx.stepStatus === 'running'; t++) await farm(bot, ctx)
    assert.ok(bot.ops.use.some((u) => u === 'wooden_hoe>grass_block'), `till op missing: ${bot.ops.use}`)
    assert.ok(bot.ops.use.some((u) => u === 'wheat_seeds>farmland'), `plant op missing: ${bot.ops.use}`)
    assert.equal(ctx.stepStatus, 'done')
    assert.ok(!String(ctx.stepStatus).startsWith('failed:'))
  })

  it('harvests only mature wheat', async () => {
    const bot = mockBot({
      cells: {
        '1,64,0': { name: 'wheat', props: { age: 7 } },
        '1,63,0': 'farmland',
        '-1,64,0': { name: 'wheat', props: { age: 2 } },
      },
      items: [],
    })
    const ctx = ctxOf()
    for (let t = 0; t < 8 && ctx.stepStatus === 'running'; t++) await farm(bot, ctx)
    assert.deepEqual(bot.ops.dig, ['wheat'])
    assert.equal(ctx.stepStatus, 'done')
  })

  it('trenches water at field level and pours via use', async () => {
    const bot = mockBot({
      cells: {
        '2,64,0': { name: 'farmland', props: { moisture: 0 } },
        '3,64,0': 'dirt',
        '3,63,0': 'stone',
      },
      items: [{ name: 'water_bucket', count: 1 }, { name: 'wooden_hoe', count: 1 }],
    })
    bot.entity.position = { x: 2, y: 64, z: 1 }
    const ctx = ctxOf()
    for (let t = 0; t < 14 && ctx.stepStatus === 'running'; t++) await farm(bot, ctx)
    assert.ok(bot.ops.dig.includes('dirt'), `trench dig missing: ${bot.ops.dig}`)
    assert.ok(bot.ops.useItem.includes('water_bucket'), `pour missing: ${bot.ops.useItem}`)
    assert.equal(bot.world.get('3,64,0'), 'water')
  })

  it('counts watering only when the water reads back', async () => {
    const bot = mockBot({
      cells: {
        '2,64,0': { name: 'farmland', props: { moisture: 0 } },
        '3,64,0': 'dirt',
        '3,63,0': 'stone',
      },
      items: [{ name: 'water_bucket', count: 1 }],
    })
    bot.entity.position = { x: 2, y: 64, z: 1 }
    bot.noPour = true
    const ctx = ctxOf()
    const lines = []
    const orig = console.log
    console.log = (l) => { lines.push(String(l)) }
    try {
      for (let t = 0; t < 14 && ctx.stepStatus === 'running'; t++) await farm(bot, ctx)
    } finally {
      console.log = orig
    }
    assert.equal(bot.world.get('3,64,0'), 'air')
    assert.ok(bot.ops.useItem.includes('water_bucket'), 'use never fired')
    assert.ok(!lines.some((l) => l.startsWith('farm water trench')), `dishonest water line: ${lines}`)
    assert.equal(ctx.stepStatus, 'done')
  })

  it('struck cells survive the pick within TTL, then release', () => {
    const fresh = { step: 'farm', stepStatus: 'running', farmStruck: new Set(['9,9,9']), farmStruckAt: Date.now() }
    assert.ok(farm.farmState(fresh).struck.has('9,9,9'))
    const stale = { step: 'farm', stepStatus: 'running', farmStruck: new Set(['9,9,9']), farmStruckAt: Date.now() - farm.STRUCK_TTL_MS - 1 }
    assert.ok(!farm.farmState(stale).struck.has('9,9,9'))
  })

  it('resets per pick: a second run re-tills capped cells', async () => {
    // All 8 soils inside one-bot reach (the mock body never walks) and
    // inside one water cell's hydration box.
    const cells = { '2,64,2': 'water' }
    for (const [x, z] of [[1, 0], [2, 0], [3, 0], [1, 1], [2, 1], [3, 1], [1, -1], [2, -1]]) {
      cells[`${x},64,${z}`] = 'grass_block'
    }
    const bot = mockBot({
      cells,
      items: [{ name: 'wooden_hoe', count: 1 }, { name: 'wheat_seeds', count: 20 }],
    })
    const tills = () => bot.ops.use.filter((u) => u === 'wooden_hoe>grass_block').length
    const ctx1 = ctxOf()
    for (let t = 0; t < 60 && ctx1.stepStatus === 'running'; t++) await farm(bot, ctx1)
    assert.equal(ctx1.stepStatus, 'done')
    assert.equal(ctx1.farm, null)
    assert.equal(tills(), 4)
    const ctx2 = ctxOf()
    for (let t = 0; t < 60 && ctx2.stepStatus === 'running'; t++) await farm(bot, ctx2)
    assert.equal(tills(), 8)
  })

  it('dedupes the walk goal per unchanged target', async () => {
    const bot = mockBot({ cells: { '5,64,0': 'grass_block', '7,64,0': 'water' } })
    const ctx = ctxOf()
    const w = { x: 5, y: 64, z: 0 }
    assert.equal(farm.walkTo(bot, ctx, {}, 'farm-till', w), true)
    assert.equal(farm.walkTo(bot, ctx, {}, 'farm-till', w), true)
    assert.deepEqual(bot.ops.goals, ['GoalNear:9'])
    assert.equal(farm.walkTo(bot, ctx, {}, 'farm-till', { x: 1, y: 64, z: 0 }), false)
  })

  it('keeps stall patience across nearby re-targets, resets on far moves', () => {
    const bot = mockBot()
    const ctx = ctxOf()
    const f = {}
    assert.equal(farm.walkTo(bot, ctx, f, 'farm-feed', { x: 10, y: 64, z: 0 }), true)
    assert.equal(f.still, 0)
    f.still = 7
    assert.equal(farm.walkTo(bot, ctx, f, 'farm-feed', { x: 11, y: 64, z: 0 }), true)
    assert.equal(f.still, 7)
    assert.equal(farm.walkTo(bot, ctx, f, 'farm-feed', { x: 30, y: 64, z: 0 }), true)
    assert.equal(f.still, 0)
    assert.deepEqual(bot.ops.goals, ['GoalNear:9', 'GoalNear:9', 'GoalNear:9'])
  })

  it('pours from pit-side: walk goal range 1, arrival within 2', () => {
    const bot = mockBot()
    const ctx = ctxOf()
    const f = {}
    assert.equal(farm.walkTo(bot, ctx, f, 'farm-water', { x: 5, y: 64, z: 0 }, 2, 1), true)
    assert.deepEqual(bot.ops.goals, ['GoalNear:1'])
    bot.entity.position = { x: 4, y: 64, z: 0 }
    assert.equal(farm.walkTo(bot, ctx, f, 'farm-water', { x: 5, y: 64, z: 0 }, 2, 1), false)
  })

  it('carries wheat to sheep and ends done with no failure', async () => {
    const bot = mockBot({ items: [{ name: 'wheat', count: 3 }], sheep: { x: 2, y: 64, z: 0 } })
    const ctx = ctxOf()
    for (let t = 0; t < 14 && ctx.stepStatus === 'running'; t++) await farm(bot, ctx)
    assert.ok(bot.ops.equip.includes('wheat'), 'wheat never held out')
    assert.ok(bot.ops.chat.some((l) => /sheep/.test(l)), `sheep line missing: ${bot.ops.chat}`)
    assert.equal(ctx.stepStatus, 'done')
  })

  it('ends done (never failed) with no hoe mats', async () => {
    const bot = mockBot({
      cells: { '1,64,0': 'grass_block', '3,64,0': 'water' },
      items: [{ name: 'wheat_seeds', count: 2 }],
    })
    const ctx = ctxOf()
    for (let t = 0; t < 6 && ctx.stepStatus === 'running'; t++) await farm(bot, ctx)
    assert.equal(ctx.stepStatus, 'done')
  })

  it('breeds a pair: wheat to two near sheep, one wheat each', async () => {
    const bot = mockBot({
      items: [{ name: 'wheat', count: 3 }],
      sheep: [{ x: 2, y: 64, z: 0 }, { x: 3, y: 64, z: 1 }],
    })
    const ctx = ctxOf()
    for (let t = 0; t < 14 && ctx.stepStatus === 'running'; t++) await farm(bot, ctx)
    assert.deepEqual(bot.ops.useEntity, [7, 8])
    assert.equal(farm.feedReady(bot, ctx), null) // wheat left (1) but flock cooling down
    assert.ok(bot.ops.chat.some((l) => /fed wheat to two sheep/.test(l)), `breed line missing: ${bot.ops.chat}`)
    assert.equal(ctx.stepStatus, 'done')
  })

  it('tills nothing without seeds in the pack', async () => {
    const bot = mockBot({
      cells: { '1,64,0': 'grass_block', '3,64,0': 'water' },
      items: [{ name: 'wooden_hoe', count: 1 }],
    })
    const ctx = ctxOf()
    for (let t = 0; t < 6 && ctx.stepStatus === 'running'; t++) await farm(bot, ctx)
    assert.equal(ctx.stepStatus, 'done')
    assert.ok(!bot.ops.use.some((u) => u === 'wooden_hoe>grass_block'), `seedless till happened: ${bot.ops.use}`)
    assert.equal(farm.farmFeasible(DAY, bot, ctxOf()), false)
  })

  it('struck farmland stays out of the menu until TTL passes', () => {
    const bot = mockBot({
      cells: { '2,64,0': { name: 'farmland', props: { moisture: 0 } } },
      items: [{ name: 'water_bucket', count: 1 }],
    })
    bot.entity.position = { x: 2, y: 64, z: 2 }
    assert.equal(farm.farmFeasible(DAY, bot, ctxOf()), true)
    const struck = ctxOf()
    struck.farmStruck = new Set(['2,64,0'])
    struck.farmStruckAt = Date.now()
    assert.equal(farm.farmFeasible(DAY, bot, struck), false)
  })
})
