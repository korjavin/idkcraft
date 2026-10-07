'use strict'

// Bead idkcraft-vmzq.17: castle work-mode never progresses — the castle step
// failed no-<kind> on the empty kit before approaching the site, and no step
// fetched fill material (prod run2: 0/1722 after 35 min, menu without
// castlefetch). Fix: a far castle step walks to the site (running, never
// failed), and gather chops one load when the castle word is -none/-some.

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const { goals } = require('mineflayer-pathfinder')
const blueprint = require('../src/castle')
const castle = require('../src/behaviours/castle')
const goal = require('../src/goal')
require('../src/index') // BEHAVIOURS registration (goal.registered)

const SITE = { x: 100, y: 64, z: 200 }
const HOME_SITE = { x: 0, y: 64, z: 0 }

function pos(x, y, z) {
  const p = {
    x, y, z,
    distanceTo: (q) => Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z),
    clone() { return pos(p.x, p.y, p.z) },
    floored() { return pos(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)) },
  }
  return p
}

function flatWorld() {
  return { blockAt: (p) => ({ name: Math.floor(p.y) <= 63 ? 'dirt' : 'air', position: pos(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)), boundingBox: Math.floor(p.y) <= 63 ? 'block' : 'empty' }) }
}

// Goal-menu bot: flat world, day, fed, standing where told.
function goalBot({ items = [], at = pos(SITE.x, 64, SITE.z) } = {}) {
  return {
    chats: [],
    entity: { position: at },
    inventory: { items: () => items },
    time: { timeOfDay: 6000, day: 1 },
    spawnPoint: pos(0, 64, 0),
    players: {},
    entities: {},
    health: 20,
    food: 20,
    blockAt: (p) => flatWorld().blockAt(p),
    findBlocks: () => [],
    registry: { blocksByName: {}, itemsByName: {} },
    chat(m) { this.chats.push(String(m)) },
  }
}

// Built v1 home: beds read 'both' (nothing owed), so gather's beds top-up
// never fires — only the castle chain can make it feasible.
function builtHome() {
  return { site: { ...HOME_SITE }, built: true, v: 1 }
}

function castleState(extra) {
  return { site: { ...SITE }, rot: 0, blueprintVersion: 1, phase: 'body', blocked: {}, parked: false, ...extra }
}

describe('vmzq.17 far castle walks instead of failing no-material', () => {
  it('500 blocks off with an empty kit: running + a site goal, never failed:no-stone', () => {
    const bot = goalBot({ items: [], at: pos(0, 64, 0) })
    const setGoals = []
    bot.pathfinder = { goal: null, setGoal: (g) => { setGoals.push(g); bot.pathfinder.goal = g }, isMoving: () => true, movements: { exclusionAreasBreak: [], exclusionAreasPlace: [] } }
    bot.world = { getBlock: () => null }
    const ctx = { castle: castleState(), step: 'castle', stepStatus: 'running' }
    castle(bot, ctx)
    assert.notEqual(ctx.stepStatus, 'failed:no-stone', 'a far step never fails on material')
    assert.ok(!String(ctx.stepStatus || '').startsWith('failed:'), `status ${ctx.stepStatus}`)
    assert.equal(ctx.castle.status, 'walking to the site')
    assert.ok(setGoals.length >= 1, 'a walk goal is issued')
    const g = setGoals[0]
    // GoalNearXZ to the material-short cell: inside the site footprint.
    const gx = typeof g.x === 'number' ? g.x : (g.pos && g.pos.x)
    const gz = typeof g.z === 'number' ? g.z : (g.pos && g.pos.z)
    const { w, d } = blueprint.siteDimensions(0, 1)
    assert.ok(gx >= SITE.x - 8 && gx <= SITE.x + w + 8 && gz >= SITE.z - 8 && gz <= SITE.z + d + 8, `goal ${gx},${gz} at the site`)
  })
})

describe('vmzq.17 gather chops the castle chain', () => {
  const F = (name, facts, bot, ctx) => goal.MENU[name].feasible(facts, bot, ctx)
  const facts = (over) => ({
    time: 'day', logs: 0, planks: 0, maxPlanks: 0, table: 0, door: 0,
    home: 'built', beds: 'both', castle: 'stone-none', ...over,
  })

  it('built home + beds both + stone-none + no logs: gather feasible (the pickaxe chain)', () => {
    assert.equal(F('gather', facts(), null, { home: builtHome() }), true)
  })

  it('stays narrow: batch/clear/blocked words and full loads never farm', () => {
    const ctx = { home: builtHome() }
    assert.equal(F('gather', facts({ castle: 'stone-batch' }), null, ctx), false)
    assert.equal(F('gather', facts({ castle: 'clear' }), null, ctx), false)
    assert.equal(F('gather', facts({ castle: 'blocked' }), null, ctx), false)
    assert.equal(F('gather', facts({ castle: 'torch-none' }), null, ctx), false, 'torch wants coal, not logs')
    assert.equal(F('gather', facts({ castle: 'stone-none', logs: 14 }), null, ctx), false)
    assert.equal(F('gather', facts({ castle: 'none' }), null, ctx), false)
  })
})

describe('vmzq.17 empty kit reaches rising castle progress', () => {
  it('gather->craft->equip->castlefetch->castle lays blocks; fails reach the stall ladder', async () => {
    // World: flat dirt, site loaded; bot stands on the site with nothing.
    const cells = new Map()
    const key = (x, y, z) => `${Math.floor(x)},${Math.floor(y)},${Math.floor(z)}`
    const world = {
      blockAt: (p) => {
        const fx = Math.floor(p.x)
        const fy = Math.floor(p.y)
        const fz = Math.floor(p.z)
        const k = key(fx, fy, fz)
        const name = cells.has(k) ? cells.get(k) : (fy <= 63 ? 'dirt' : 'air')
        return { name, position: pos(fx, fy, fz), boundingBox: name === 'air' ? 'empty' : 'block' }
      },
    }
    const items = []
    const setGoals = []
    const places = []
    let held = null
    const bot = {
      chats: [],
      entity: { position: pos(SITE.x + 2, 64, SITE.z + 2) },
      inventory: { items: () => items },
      time: { timeOfDay: 6000, day: 1 },
      spawnPoint: pos(0, 64, 0),
      players: {},
      entities: {},
      health: 20,
      food: 20,
      world: { getBlock: () => null },
      blockAt: (p) => world.blockAt(p),
      findBlocks: () => [],
      registry: { blocksByName: {}, itemsByName: {} },
      pathfinder: {
        goal: null,
        movements: { exclusionAreasBreak: [], exclusionAreasPlace: [] },
        isMoving: () => false,
        setGoal: (g) => { setGoals.push(g); bot.pathfinder.goal = g },
      },
      equip: async (item) => { held = item.name },
      dig: async () => {},
      placeBlock: async (ref, face) => {
        const p = { x: ref.position.x + face.x, y: ref.position.y + face.y, z: ref.position.z + face.z }
        places.push(p)
        cells.set(key(p.x, p.y, p.z), held)
      },
      chat(m) { this.chats.push(String(m)) },
    }
    // The v1 home truly stands (else build wants repairs and outranks equip).
    const buildMod = require('../src/behaviours/build')
    const home = builtHome()
    for (const cell of buildMod.blueprintFor(home)) {
      const x = home.site.x + cell.dx
      const y = home.site.y + cell.dy
      const z = home.site.z + cell.dz
      const name = cell.kind === 'table' ? 'crafting_table' : cell.kind === 'door' ? 'oak_door' : cell.kind === 'fill' ? 'dirt' : 'oak_planks'
      cells.set(key(x, y, z), name)
    }
    const ctx = { home, castle: castleState(), work: true }
    const facts0 = goal.goalFacts(bot, ctx)
    assert.equal(facts0.castle, 'stone-none', `empty kit reads ${facts0.castle}`)
    assert.equal((await goal.decide(bot, ctx)).action, 'gather', 'empty kit chops first (was gear/explore)')
    // Gather done: a full load crafts.
    items.push({ name: 'oak_log', count: 14 })
    assert.equal((await goal.decide(bot, ctx)).action, 'craft')
    // Craft done: planks + table + sticks arm the kit.
    items.length = 0
    items.push({ name: 'oak_planks', count: 32 }, { name: 'crafting_table', count: 1 }, { name: 'stick', count: 4 })
    assert.equal((await goal.decide(bot, ctx)).action, 'equip')
    // Equip done: pick + sword + scaffold fetch stone.
    items.push({ name: 'stone_pickaxe', count: 1 }, { name: 'stone_sword', count: 1 }, { name: 'dirt', count: 32 })
    assert.equal((await goal.decide(bot, ctx)).action, 'castlefetch')
    // Fetch done: the 64-stack (plus reserve) lays.
    items.push({ name: 'cobblestone', count: 64 })
    assert.equal(goal.goalFacts(bot, ctx).castle, 'stone-batch')
    assert.equal((await goal.decide(bot, ctx)).action, 'castlefetch', 'the fetch finishes its stack first')
    items.push({ name: 'cobblestone', count: 16 })
    ctx.stepStatus = 'done' // the fetch behaviour ends at its target
    assert.equal((await goal.decide(bot, ctx)).action, 'castle')
    // Lay: progress rises from 0 (live read; the 30 s cached counter follows).
    const settle = async (n = 4) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)) }
    for (let i = 0; i < 30; i++) { castle(bot, ctx); await settle() }
    assert.ok(places.length > 0, 'blocks are laid')
    const laid = castle.progressByKind(bot, ctx.castle).stone.done
    assert.ok(laid > 0, `stone progress ${laid}`)
    // Stall ladder sees a fail cycle: a no-stone fail lands in the record.
    const taskMod = require('../src/task')
    ctx.step = 'castle'
    ctx.stepStatus = 'running'
    taskMod.taskTick(bot, ctx, Date.now()) // baseline
    ctx.stepStatus = 'failed:no-stone'
    taskMod.taskTick(bot, ctx, Date.now())
    const fails = ctx.task && ctx.task.castle && ctx.task.castle.fails
    assert.ok(Array.isArray(fails) && fails.some((f) => f === 'castle:no-stone'), `fails ${JSON.stringify(fails)}`)
  })
})
