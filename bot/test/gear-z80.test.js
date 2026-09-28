'use strict'

// GEAR e2e fill-leg flakes (idkcraft-z80): a fill walk left live steers the
// head during the next table/chest use (silent server ignore, 20 s
// windowOpen timeouts), and nearest-first over flow cells spirals away
// from the source (500-tick death with zero fills).

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const gear = require('../src/behaviours/gear')

const tick = (ms) => new Promise((resolve) => setTimeout(resolve, ms || 30))

function pos(x, y, z) {
  return {
    x, y, z,
    distanceTo: (q) => Math.hypot(x - q.x, y - q.y, z - q.z),
    clone() { return pos(x, y, z) },
    floored() { return { x: Math.floor(x), y: Math.floor(y), z: Math.floor(z) } },
  }
}

function mockBot({ items = [], ids = {}, recipes = {}, cells = {}, water = null, levels = {} } = {}) {
  const lines = []
  const calls = { craft: [], goals: [] }
  const itemsByName = {}
  for (const [name, id] of Object.entries(ids)) itemsByName[name] = { id }
  const bot = {
    lines, calls,
    _items: items,
    entity: { position: pos(0, 64, 0), onGround: true },
    registry: { itemsByName, blocksByName: { water: { id: 100 } } },
    inventory: { items: () => bot._items, slots: null },
    recipesFor: (id) => {
      const name = Object.keys(ids).find((n) => ids[n] === id)
      if (!(name in recipes)) throw new Error(`unexpected recipesFor(${name})`)
      const r = recipes[name]
      return r ? [r] : []
    },
    craft: async (recipe, count) => {
      calls.craft.push({ recipe, count })
      if (recipe && recipe.provides) bot._items.push({ name: recipe.provides, count: (recipe.n || 1) * count })
    },
    blockAt: (p) => {
      const key = `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`
      if (key in levels) {
        const lv = levels[key]
        return {
          name: 'water',
          position: pos(p.x, p.y, p.z),
          getProperties: () => ({ level: lv }),
        }
      }
      const name = cells[key]
      if (!name) return null
      return { name, position: pos(p.x, p.y, p.z) }
    },
    pathfinder: {
      setGoal: (goal) => { calls.goals.push(goal) },
      isMoving: () => false,
    },
    time: { timeOfDay: 6000 },
    players: {},
    chat: (line) => { lines.push(String(line)) },
  }
  if (water) bot.findBlocks = () => water.map(([x, y, z]) => ({ x, y, z }))
  return bot
}

const home = (over) => ({ site: { x: 0, y: 64, z: 0 }, built: true, table: { x: 0, y: 64, z: 0 }, ...(over || {}) })

describe('z80: stale steering stops before look-dependent ops', () => {
  it('a live walk goal clears before the table craft fires', async () => {
    const bot = mockBot({
      items: [{ name: 'iron_pickaxe', count: 1 }, { name: 'iron_ingot', count: 3 }],
      ids: { bucket: 31 },
      recipes: { bucket: { provides: 'bucket' } },
      cells: { '0,64,0': 'crafting_table' },
    })
    bot.pathfinder.goal = { x: 2, y: 64, z: 0 } // the fill walk, still live
    const ctx = { home: home(), stepStatus: 'running', lastGoalKey: 'gear-water:2,64,0' }
    gear(bot, ctx)
    assert.deepEqual(bot.calls.goals, [null], 'stale goal cleared before the table use')
    assert.equal(ctx.lastGoalKey, '', 'key reset so the next walk re-issues')
    await tick(700)
    assert.equal(bot._items.filter((i) => i && i.name === 'bucket').length, 1, 'the craft itself still fires')
  })

  it('the fill walk give-up stops its own goal (revmux z80-01 core-1)', () => {
    const bot = mockBot({
      items: [{ name: 'iron_pickaxe', count: 1 }, { name: 'bucket', count: 1 }],
      water: [[30, 64, 0]],
      levels: { '30,64,0': '0' },
    })
    bot.pathfinder.goal = { x: 30, y: 64, z: 0 } // the walk goal, still live
    const ctx = { home: home(), stepStatus: 'running', lastGoalKey: '' }
    for (let i = 0; i < 21; i++) {
      ctx.stepStatus = 'running'
      gear(bot, ctx)
      bot.pathfinder.goal = { x: 30, y: 64, z: 0 } // the body never arrives
    }
    assert.deepEqual(bot.calls.goals[bot.calls.goals.length - 1], null, 'give-up clears the walk goal')
    assert.equal(ctx.lastGoalKey, '', 'key reset for the retarget')
    assert.equal(ctx.stepStatus, 'running', 'still never fails the ladder')
  })

  it('no live goal leaves the pathfinder untouched (key still resets)', async () => {
    const bot = mockBot({
      items: [{ name: 'iron_pickaxe', count: 1 }, { name: 'iron_ingot', count: 3 }],
      ids: { bucket: 31 },
      recipes: { bucket: { provides: 'bucket' } },
      cells: { '0,64,0': 'crafting_table' },
    })
    bot.pathfinder.goal = null // arrived walks auto-clear; nothing to stop
    const ctx = { home: home(), stepStatus: 'running', lastGoalKey: 'gear-water:2,64,0' }
    gear(bot, ctx)
    assert.deepEqual(bot.calls.goals, [], 'no redundant clear')
    assert.equal(ctx.lastGoalKey, '', 'stale key still resets')
    await tick(700)
    assert.equal(bot._items.filter((i) => i && i.name === 'bucket').length, 1, 'the craft itself still fires')
  })

  it('a live walk goal clears before the pantry withdraw fires', () => {
    const stacks = [{ name: 'iron_ingot', count: 8, type: 100, metadata: null }]
    const bot = mockBot({ items: [{ name: 'iron_pickaxe', count: 1 }, { name: 'water_bucket', count: 2 }] })
    bot.openChest = async () => ({
      containerItems: () => stacks,
      withdraw: async () => {},
      close: () => {},
    })
    bot.pathfinder.goal = { x: 2, y: 64, z: 0 }
    const ctx = {
      home: home({ chest: { x: 1, y: 64, z: 0 } }),
      stepStatus: 'running',
      lastGoalKey: 'gear-water:2,64,0',
      gearGiven: { water_bucket: 2, iron_sword: 1, iron_pickaxe: 1 },
      gearPantryBanked: 1,
    }
    gear(bot, ctx)
    assert.deepEqual(bot.calls.goals, [null], 'stale goal cleared before the chest open')
    assert.equal(ctx.lastGoalKey, '')
    assert.equal(ctx.gearInFlight, true, 'the withdraw itself still fires')
  })
})

describe('z80: the fill scan targets sources, never flow', () => {
  it('a nearer flow cell loses to a farther source (string level)', () => {
    const bot = mockBot({
      items: [{ name: 'iron_pickaxe', count: 1 }, { name: 'bucket', count: 1 }],
      water: [[2, 64, 0], [30, 64, 0]],
      levels: { '2,64,0': '3', '30,64,0': '0' },
    })
    bot.equip = async () => {}
    bot.lookAt = () => {}
    let scoops = 0
    bot.activateItem = () => { scoops++ }
    const ctx = { home: home(), stepStatus: 'running', lastGoalKey: '' }
    gear(bot, ctx)
    assert.equal(ctx.lastGoalKey, 'gear-water:30,64,0', 'walks to the source, not the in-reach flow')
    assert.equal(scoops, 0, 'no scoop at flow')
    assert.equal(bot.calls.goals.length, 1)
  })

  it('numeric metadata levels filter the same way', () => {
    const bot = mockBot({
      items: [{ name: 'iron_pickaxe', count: 1 }, { name: 'bucket', count: 1 }],
      water: [[2, 64, 0], [30, 64, 0]],
    })
    bot.blockAt = (p) => {
      const key = `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`
      if (key === '2,64,0') return { name: 'water', metadata: 5 }
      if (key === '30,64,0') return { name: 'water', metadata: 0 }
      return null
    }
    bot.equip = async () => {}
    bot.lookAt = () => {}
    let scoops = 0
    bot.activateItem = () => { scoops++ }
    const ctx = { home: home(), stepStatus: 'running', lastGoalKey: '' }
    gear(bot, ctx)
    assert.equal(ctx.lastGoalKey, 'gear-water:30,64,0', 'walks to the source, not the in-reach flow')
    assert.equal(scoops, 0, 'no scoop at flow')
  })

  it('flow hiding behind the slice never masks the source (deep scan)', () => {
    // Forty nearer flow cells (a re-flow plume, as observed) plus one
    // farther source, and a count-honouring findBlocks like the server:
    // without the deep scan the slice ends at the flow and the rung
    // latches dry despite the wet 2x2.
    const cells = []
    for (let i = 1; i <= 40; i++) cells.push([i, 64, 0])
    cells.push([60, 64, 0])
    const levels = {}
    for (const [x, y, z] of cells) levels[`${x},${y},${z}`] = x === 60 ? '0' : '2'
    const bot = mockBot({
      items: [{ name: 'iron_pickaxe', count: 1 }, { name: 'bucket', count: 1 }],
      water: cells,
      levels,
    })
    bot.findBlocks = ({ count }) => cells
      .map(([x, y, z]) => ({ x, y, z, d: Math.hypot(x - bot.entity.position.x, z - bot.entity.position.z) }))
      .sort((a, b) => a.d - b.d)
      .slice(0, count)
    bot.equip = async () => {}
    bot.lookAt = () => {}
    let scoops = 0
    bot.activateItem = () => { scoops++ }
    const ctx = { home: home(), stepStatus: 'running', lastGoalKey: '' }
    gear(bot, ctx)
    assert.equal(ctx.gear.noWater || false, false, 'the source past 40 flow cells must not latch dry')
    assert.equal(ctx.lastGoalKey, 'gear-water:60,64,0', 'walks to the source through the flow')
    assert.equal(scoops, 0, 'no scoop at flow')
  })

  it('flow-only water holds, then latches dry after patience runs out', () => {
    const bot = mockBot({
      items: [{ name: 'iron_pickaxe', count: 1 }, { name: 'bucket', count: 1 }],
      water: [[2, 64, 0]],
      levels: { '2,64,0': '1' },
    })
    bot.equip = async () => {}
    bot.lookAt = () => {}
    let scoops = 0
    bot.activateItem = () => { scoops++ }
    const ctx = { home: home(), stepStatus: 'running', lastGoalKey: '' }
    for (let i = 0; i < 19; i++) {
      ctx.stepStatus = 'running'
      gear(bot, ctx)
    }
    assert.equal(scoops, 0, 'no scoop at flow')
    assert.equal(ctx.gear.noWater || false, false, 'holds while water may still settle')
    assert.equal(ctx.stepStatus, 'running', 'holds the step, never yields')
    assert.ok(!bot.lines.some((l) => l.includes('need water')), 'silent during patience')
    ctx.stepStatus = 'running'
    gear(bot, ctx) // 20th consecutive flow-only scan: latch
    assert.equal(ctx.gear.noWater, true, 'truly flow-only latches, loud instead of a spiral')
    assert.ok(bot.lines.some((l) => l.includes('need water')), 'says once')
  })

  it('a source appearing resets the flow patience', () => {
    const levels = { '2,64,0': '1', '30,64,0': '1' }
    const bot = mockBot({
      items: [{ name: 'iron_pickaxe', count: 1 }, { name: 'bucket', count: 1 }],
      water: [[2, 64, 0], [30, 64, 0]],
      levels,
    })
    bot.equip = async () => {}
    bot.lookAt = () => {}
    bot.activateItem = () => {}
    const ctx = { home: home(), stepStatus: 'running', lastGoalKey: '' }
    for (let i = 0; i < 10; i++) {
      ctx.stepStatus = 'running'
      gear(bot, ctx)
    }
    assert.equal(ctx.gear.noWater || false, false)
    levels['30,64,0'] = '0' // the 2x2 settles: a source appears
    ctx.stepStatus = 'running'
    gear(bot, ctx)
    assert.equal(ctx.lastGoalKey, 'gear-water:30,64,0', 'walks to the settled source')
    levels['30,64,0'] = '1' // flow again: the counter restarts, not resumes
    for (let i = 0; i < 19; i++) {
      ctx.stepStatus = 'running'
      gear(bot, ctx)
    }
    assert.equal(ctx.gear.noWater || false, false, '10 + 19 flow ticks must not latch after a reset')
  })

  it('all-tried water still latches instantly (no flow, no patience)', () => {
    const bot = mockBot({
      items: [{ name: 'iron_pickaxe', count: 1 }, { name: 'bucket', count: 1 }],
      water: [[2, 64, 0]],
      levels: { '2,64,0': '0' },
    })
    bot.equip = async () => {}
    bot.lookAt = () => {}
    bot.activateItem = () => {}
    const ctx = {
      home: home(),
      stepStatus: 'running',
      lastGoalKey: '',
      gearRun: { fillEmpties: 1, fillTried: { '2,64,0': true } },
    }
    gear(bot, ctx)
    assert.equal(ctx.gear.noWater, true, 'tried-out latches on the first tick, as before')
    assert.equal(ctx.stepStatus, 'done')
  })

  it('unreadable cells stay candidates (lenient: mocks, chunk edges)', async () => {
    const bot = mockBot({
      items: [{ name: 'iron_pickaxe', count: 1 }, { name: 'bucket', count: 1 }],
      water: [[2, 64, 0]],
    })
    bot.equip = async () => {}
    bot.lookAt = () => {}
    bot.activateItem = () => {
      const i = bot._items.find((e) => e && e.name === 'bucket')
      i.count--
      bot._items.splice(bot._items.indexOf(i), 1)
      bot._items.push({ name: 'water_bucket', count: 1 })
    }
    const ctx = { home: home(), stepStatus: 'running', lastGoalKey: '' }
    gear(bot, ctx)
    await tick(700)
    assert.equal(bot._items.filter((i) => i && i.name === 'water_bucket').length, 1, 'level-less cells still fill')
  })
})
