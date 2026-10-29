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
  const ops = { dig: [], use: [], equip: [], goals: [], chat: [] }
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
      setGoal: (g) => { ops.goals.push(g && g.constructor && g.constructor.name); bot.pathfinder.goal = g },
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
    chat: (line) => { ops.chat.push(line) },
  }
  if (sheep) bot.entities[7] = { id: 7, name: 'sheep', position: { ...sheep }, isValid: true }
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

  it('trenches water for dry farmland with a bucket', async () => {
    const bot = mockBot({
      cells: {
        '2,64,0': { name: 'farmland', props: { moisture: 0 } },
        '3,63,0': 'dirt',
        '3,62,0': 'stone',
      },
      items: [{ name: 'water_bucket', count: 1 }, { name: 'wooden_hoe', count: 1 }],
    })
    bot.entity.position = { x: 2, y: 64, z: 2 }
    const ctx = ctxOf()
    for (let t = 0; t < 14 && ctx.stepStatus === 'running'; t++) await farm(bot, ctx)
    assert.ok(bot.ops.dig.includes('dirt'), `trench dig missing: ${bot.ops.dig}`)
    assert.ok(bot.ops.use.some((u) => u === 'water_bucket>stone'), `pour missing: ${bot.ops.use}`)
    assert.equal(bot.world.get('3,63,0'), 'water')
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
      items: [],
    })
    const ctx = ctxOf()
    for (let t = 0; t < 6 && ctx.stepStatus === 'running'; t++) await farm(bot, ctx)
    assert.equal(ctx.stepStatus, 'done')
  })
})
