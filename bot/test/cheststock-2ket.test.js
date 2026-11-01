'use strict'

// idkcraft-2ket (stock-first planning): fetch/craft planning consults the
// inventory + remembered chest stock FIRST and skips the gather/mine leg
// when stock covers the need — the withdraw path still runs, so nothing
// strands. Planks stocked -> no chop leg planned; ingots stocked -> no
// ore-dig leg planned; unstocked -> legs as today.

const { describe, it, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const chestStock = require('../src/cheststock')
const gear = require('../src/behaviours/gear')
const castleMod = require('../src/behaviours/castle')
const goal = require('../src/goal')
require('../src/index') // BEHAVIOURS registration (goal.registered)

const SITE = { x: 100, y: 64, z: 200 }

function pos(x, y, z) {
  const p = { x, y, z, distanceTo: (q) => Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z), clone: () => pos(x, y, z), floored: () => pos(Math.floor(x), Math.floor(y), Math.floor(z)) }
  return p
}

function makeBot({ items = [] } = {}) {
  return {
    username: 'IdkBot',
    chats: [],
    chat(m) { this.chats.push(String(m)) },
    entity: { position: pos(SITE.x - 4, 64, SITE.z - 4), onGround: true },
    inventory: { items: () => items },
    time: { timeOfDay: 6000, day: 1 },
    spawnPoint: pos(0, 64, 0),
    players: {},
    entities: {},
    health: 20,
    food: 20,
    blockAt: () => ({ name: 'air', position: pos(0, 64, 0), boundingBox: 'empty' }),
    findBlocks: () => [],
    registry: {
      blocksByName: {},
      itemsByName: { oak_planks: {}, birch_planks: {}, oak_log: {}, stick: {}, crafting_table: {}, stone_pickaxe: {} },
    },
    pathfinder: { goal: null, setGoal() {}, isMoving: () => false, stop() {} },
    clearControlStates() {},
    on() {},
    once() {},
  }
}

function castleState(extra) {
  return { site: { ...SITE }, rot: 0, blueprintVersion: 1, phase: 'body', blocked: {}, parked: false, ...extra }
}

function stockedCtx(extraStock) {
  return {
    home: { site: { x: 0, y: 64, z: 0 }, built: false, chest: { x: 1, y: 64, z: 1 } },
    castle: castleState(),
    castleWord: { kind: 'planks', left: 32 },
    chestLast: { home: { contents: { ...(extraStock || {}) }, at: Date.now() } },
  }
}

const realFact = castleMod.menuFact
afterEach(() => { castleMod.menuFact = realFact })

describe('2ket cheststock readers', () => {
  it('homeStockOf sums names, reads 0 without an adopted chest', () => {
    const ctx = stockedCtx({ oak_planks: 60, birch_planks: 4, oak_log: 3 })
    assert.equal(chestStock.homeStockOf(ctx, 'oak_planks'), 60)
    assert.equal(chestStock.homeStockOf(ctx, ['oak_planks', 'birch_planks']), 64)
    assert.equal(chestStock.homeStockOf(ctx, ['oak_planks', 'stone']), 60)
    assert.equal(chestStock.homeStockOf({}, 'oak_planks'), 0)
    assert.equal(chestStock.homeStockOf({ home: {} }, 'oak_planks'), 0) // lost adoption: stale reads 0
    assert.equal(chestStock.homeStockOf({ home: { chest: { x: 1, y: 1, z: 1 } } }, 'oak_planks'), 0)
  })
  it('fetchStockOf aggregates home/site/castle, site and castle need the order', () => {
    const ctx = stockedCtx({ oak_planks: 10 })
    ctx.chestLast.site = { contents: { oak_planks: 20 }, at: Date.now() }
    ctx.chestLast.castle = { contents: { oak_planks: 4 }, at: Date.now() }
    assert.equal(chestStock.fetchStockOf(ctx, ['oak_planks']), 34)
    const noOrder = { home: ctx.home, chestLast: ctx.chestLast }
    assert.equal(chestStock.fetchStockOf(noOrder, ['oak_planks']), 10) // home only, adoption-guarded
  })
  it('slotContents fails open on garbage', () => {
    assert.deepEqual(chestStock.slotContents(null, 'home'), {})
    assert.deepEqual(chestStock.slotContents({ chestLast: { home: null } }, 'home'), {})
    assert.deepEqual(chestStock.slotContents({ chestLast: { home: { contents: [1] } } }, 'home'), {})
  })
})

describe('2ket gear ladder: remembered stock routes to withdraw', () => {
  const C = (over) => ({
    ironOre: 0, ingots: 0, diamonds: 0, sticks: 0, planks: 0, logs: 0,
    iron_pickaxe: 0, iron_sword: 0, diamond_pickaxe: 0, diamond_sword: 0,
    bucket: 0, water_bucket: 0,
    iron_helmet: 0, iron_chestplate: 0, iron_leggings: 0, iron_boots: 0,
    diamond_helmet: 0, diamond_chestplate: 0, diamond_leggings: 0, diamond_boots: 0,
    tablePlaced: false, furnaceClaim: false, furnaceItem: 0, cobble: 0, fuel: 0,
    ...(over || {}),
  })
  // Latched: a withdraw already drew and came up short (pantrySeen caught
  // up with the bank counter), so the pantry path stays shut — only
  // remembered stock re-arms the withdraw.
  const latched = (stock) => ({
    home: { chest: { x: 1, y: 64, z: 1 } },
    gearPantryBanked: 1,
    gear: { pantrySeen: 1 },
    chestLast: { home: { contents: { ...(stock || {}) }, at: Date.now() } },
  })
  it('ingots stocked -> withdraw, not an ore-dig leg', () => {
    const p = gear.planFor(C({ sticks: 2 }), latched({ iron_ingot: 64 }), {})
    assert.deepEqual([p.state, p.action], ['ready', 'withdraw'])
  })
  it('ore stocked -> withdraw, smelt chain covers the rung', () => {
    const p = gear.planFor(C({ sticks: 2 }), latched({ raw_iron: 32 }), {})
    assert.deepEqual([p.state, p.action], ['ready', 'withdraw'])
  })
  it('unstocked + latched -> want-ore leg as today', () => {
    const p = gear.planFor(C({ sticks: 2 }), latched({}), {})
    assert.equal(p.key, 'want-ore')
    assert.ok(p.line.includes('going to dig'))
  })
  it('fresh session still withdraws first as today (pantry reads fresh)', () => {
    const p = gear.planFor(C({ sticks: 2 }), { home: { chest: { x: 1, y: 64, z: 1 } } }, {})
    assert.deepEqual([p.state, p.action], ['ready', 'withdraw'])
  })
  it('diamonds stocked -> withdraw, not the deep leg', () => {
    const given = { water_bucket: 2, iron_sword: 1, iron_pickaxe: 1, iron_helmet: 1, iron_chestplate: 1, iron_leggings: 1, iron_boots: 1 }
    const counts = C({ sticks: 2, diamonds: 1, iron_pickaxe: 1, water_bucket: 2, iron_helmet: 1, iron_chestplate: 1, iron_leggings: 1, iron_boots: 1 })
    const ctx = { gearGiven: given, ...latched({ diamond: 3 }) }
    assert.deepEqual([gear.planFor(counts, ctx, { deep: true }).state, gear.planFor(counts, ctx, { deep: true }).action], ['ready', 'withdraw'])
  })
  it('diamonds unstocked + latched -> deep leg as today', () => {
    const given = { water_bucket: 2, iron_sword: 1, iron_pickaxe: 1, iron_helmet: 1, iron_chestplate: 1, iron_leggings: 1, iron_boots: 1 }
    const counts = C({ sticks: 2, diamonds: 1, iron_pickaxe: 1, water_bucket: 2, iron_helmet: 1, iron_chestplate: 1, iron_leggings: 1, iron_boots: 1 })
    const ctx = { gearGiven: given, ...latched({}) }
    assert.equal(gear.planFor(counts, ctx, { deep: true }).action, 'deep')
  })
})

describe('2ket goal kit chop: remembered stock skips the chop', () => {
  const facts = { time: 'day', logs: 0, planks: 0, maxPlanks: 0, table: 0, door: 1, home: 'site', beds: 'both', castle: 'planks-none', health: 20, food: 20 }
  it('planks stocked -> no chop leg, fetch withdraws', () => {
    castleMod.menuFact = () => 'planks-none'
    const bot = makeBot()
    const ctx = stockedCtx({ oak_planks: 64 })
    assert.equal(goal.MENU.gather.feasible(facts, bot, ctx), false)
    assert.equal(goal.stepWhy('gather', facts, bot, ctx, ''), 'gather: planks stocked in chests')
  })
  it('unstocked -> kit chop as today', () => {
    castleMod.menuFact = () => 'planks-none'
    const bot = makeBot()
    const ctx = stockedCtx({})
    assert.equal(goal.MENU.gather.feasible(facts, bot, ctx), true)
    assert.equal(goal.stepWhy('gather', facts, bot, ctx, ''), null)
  })
  it('partial stock still chops as today', () => {
    castleMod.menuFact = () => 'planks-none'
    const bot = makeBot()
    const ctx = stockedCtx({ oak_planks: 10 }) // short is 34: target 32 + reserve 2
    assert.equal(goal.MENU.gather.feasible(facts, bot, ctx), true)
  })
  it('held kind stays parked as today (no chop even when stocked)', () => {
    castleMod.menuFact = () => 'planks-none'
    const bot = makeBot()
    const now = Date.now()
    const ctx = stockedCtx({ oak_planks: 64 })
    ctx.stepFail = { castlefetch: { status: 'failed:castlefetch-unreachable', at: now, kinds: { planks: { at: now } } } }
    assert.equal(goal.MENU.gather.feasible(facts, bot, ctx), false)
    assert.equal(goal.stepWhy('gather', facts, bot, ctx, ''), 'gather: planks fetch held')
  })
})
