'use strict'

// idkcraft-x15: prod refused 'bring me ore' with kit pickaxe=yes — the held
// pickaxe was wooden (tier-correct, but opaque: nothing ever upgraded it,
// and the line never said what was held). The refusal now names the held
// tool, and equip upgrades rank-0 to stone while the chain can land.
const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const { tierRefusal, bestPickRank } = require('../src/behaviours/bring')
const equip = require('../src/behaviours/equip')
const { MENU, stepWhy } = require('../src/goal')

function invBot(items) {
  return { inventory: { items: () => items } }
}

describe('x15 refusal names the held pickaxe', () => {
  it('wooden held: the line says so', () => {
    const bot = invBot([{ name: 'wooden_pickaxe', count: 1 }])
    assert.equal(bestPickRank(bot), 0)
    assert.equal(tierRefusal(bot, 'iron_ore'), "need a stone pickaxe for iron_ore (my wooden_pickaxe can't break it)")
  })
  it('stone held for gold: names the stone pickaxe', () => {
    const bot = invBot([{ name: 'stone_pickaxe', count: 1 }])
    assert.equal(tierRefusal(bot, 'gold_ore'), "need an iron pickaxe for gold_ore (my stone_pickaxe can't break it)")
  })
  it('two held: names the best one', () => {
    const bot = invBot([{ name: 'wooden_pickaxe', count: 1 }, { name: 'stone_pickaxe', count: 1 }])
    assert.equal(bestPickRank(bot), 1)
    assert.equal(tierRefusal(bot, 'gold_ore'), "need an iron pickaxe for gold_ore (my stone_pickaxe can't break it)")
  })
  it('no pickaxe: the bare legacy line', () => {
    const bot = invBot([{ name: 'dirt', count: 3 }])
    assert.equal(bestPickRank(bot), -1)
    assert.equal(tierRefusal(bot, 'iron_ore'), 'need a stone pickaxe for iron_ore')
  })
  it('unreadable inventory: the bare legacy line, never throws', () => {
    assert.equal(tierRefusal(null, 'iron_ore'), 'need a stone pickaxe for iron_ore')
    assert.equal(tierRefusal({}, 'iron_ore'), 'need a stone pickaxe for iron_ore')
    assert.equal(bestPickRank(null), -1)
  })
})

function mockBot({ items = [], ids = {}, recipes = {}, blockAtImpl = null, findBlocksImpl = null } = {}) {
  const calls = { craft: [], dig: [], equipped: [] }
  const bot = {
    calls,
    lines: [],
    _items: items,
    entity: { position: { x: 0, y: 64, z: 0 } },
    registry: { itemsByName: Object.fromEntries(Object.entries(ids).map(([n, id]) => [n, { id }])) },
    inventory: { items: () => bot._items },
    _syncWindow: async () => {}, // modern mineflayer: the verify resync is instant here
    recipesFor: (id) => {
      const name = Object.keys(ids).find((n) => ids[n] === id)
      if (!(name in recipes)) throw new Error(`unexpected recipesFor(${name})`)
      return recipes[name] ? [recipes[name]] : []
    },
    craft: async (recipe, count, table) => { calls.craft.push({ recipe, count, table }) },
    blockAt: blockAtImpl || (() => null),
    findBlocks: findBlocksImpl || (() => []),
    dig: async (block) => { calls.dig.push(block) },
    equip: async (item, dest) => { calls.equipped.push({ item: item.name, dest }) },
    placeBlock: async () => { throw new Error('unexpected placeBlock') },
    pathfinder: { setGoal: () => {}, isMoving: () => false },
    chat: (line) => { bot.lines.push(String(line)) },
  }
  return bot
}

const IDS = {
  oak_log: 17, oak_planks: 18, stick: 280, crafting_table: 58, cobblestone: 4,
  wooden_pickaxe: 270, stone_pickaxe: 274, wooden_sword: 268, stone_sword: 272,
}
const recipeFor = (name, count = 1) => ({ result: { name, count } })
const TABLE = { name: 'crafting_table' }
const AIR = { name: 'air' }

async function flush() {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve))
}

describe('x15 equip upgrades a wooden pickaxe to stone', () => {
  it('wooden + cobble + sticks + standing table crafts stone_pickaxe, never a second wooden', async () => {
    const bot = mockBot({
      items: [
        { name: 'wooden_pickaxe', count: 1 }, { name: 'stone_sword', count: 1 },
        { name: 'cobblestone', count: 3 }, { name: 'stick', count: 2 },
      ],
      ids: IDS,
      recipes: { stone_pickaxe: recipeFor('stone_pickaxe') },
      blockAtImpl: () => TABLE,
    })
    const ctx = { lastGoalKey: '', stepStatus: 'running', home: { table: { x: 1, y: 64, z: 0 } } }
    equip(bot, ctx, null, {})
    await flush()
    assert.equal(bot.calls.craft.length, 1)
    assert.deepEqual(bot.calls.craft[0].recipe, recipeFor('stone_pickaxe'))
    assert.equal(ctx.stepStatus, 'running')
  })
  it('landed stone ends the upgrade: no second craft, kit done', async () => {
    const bot = mockBot({
      items: [
        { name: 'wooden_pickaxe', count: 1 }, { name: 'stone_sword', count: 1 },
        { name: 'cobblestone', count: 6 }, { name: 'stick', count: 4 }, { name: 'dirt', count: 32 },
      ],
      ids: IDS,
      recipes: { stone_pickaxe: recipeFor('stone_pickaxe') },
      blockAtImpl: () => TABLE,
    })
    bot.craft = async (recipe, count, table) => {
      bot.calls.craft.push({ recipe, count, table })
      bot._items.push({ name: recipe.result.name, count: 1 })
    }
    const ctx = { lastGoalKey: '', stepStatus: 'running', home: { table: { x: 1, y: 64, z: 0 } } }
    equip(bot, ctx, null, {})
    await flush()
    assert.equal(bot.calls.craft.length, 1)
    equip(bot, ctx, null, {})
    await flush()
    assert.equal(bot.calls.craft.length, 1)
    assert.equal(ctx.stepStatus, 'done')
  })
  it('no cobble: digs scaffold as before, no craft, no fail', async () => {
    const bot = mockBot({
      items: [{ name: 'wooden_pickaxe', count: 1 }, { name: 'stone_sword', count: 1 }],
      ids: IDS,
      recipes: {},
      blockAtImpl: () => TABLE,
      findBlocksImpl: () => [{ x: 1, y: 64, z: 0, name: 'dirt' }],
    })
    const ctx = { lastGoalKey: '', stepStatus: 'running', home: { table: { x: 1, y: 64, z: 0 } } }
    equip(bot, ctx, null, {})
    await flush()
    assert.equal(bot.calls.craft.length, 0)
    assert.equal(bot.calls.dig.length, 1)
    assert.equal(ctx.stepStatus, 'running')
  })
  it('no table anywhere: digs scaffold as before instead of failing no-table', async () => {
    const bot = mockBot({
      items: [
        { name: 'wooden_pickaxe', count: 1 }, { name: 'stone_sword', count: 1 },
        { name: 'cobblestone', count: 3 }, { name: 'stick', count: 2 },
      ],
      ids: IDS,
      recipes: {},
      blockAtImpl: () => null,
      findBlocksImpl: () => [{ x: 1, y: 64, z: 0, name: 'dirt' }],
    })
    const ctx = { lastGoalKey: '', stepStatus: 'running', home: null }
    equip(bot, ctx, null, {})
    await flush()
    assert.equal(bot.calls.craft.length, 0)
    assert.equal(bot.calls.dig.length, 1)
    assert.equal(ctx.stepStatus, 'running')
  })
  it('ghost table claim: digs scaffold as before, no craft, no fail', async () => {
    const bot = mockBot({
      items: [
        { name: 'wooden_pickaxe', count: 1 }, { name: 'stone_sword', count: 1 },
        { name: 'cobblestone', count: 3 }, { name: 'stick', count: 2 },
      ],
      ids: IDS,
      recipes: {},
      blockAtImpl: () => AIR, // mined-away claim reads as no station
      findBlocksImpl: () => [{ x: 1, y: 64, z: 0, name: 'dirt' }],
    })
    const ctx = { lastGoalKey: '', stepStatus: 'running', home: { table: { x: 1, y: 64, z: 0 } } }
    equip(bot, ctx, null, {})
    await flush()
    assert.equal(bot.calls.craft.length, 0)
    assert.equal(bot.calls.dig.length, 1)
    assert.equal(ctx.stepStatus, 'running')
  })
  it('table item in the pack counts: crafts stone without a standing table', async () => {
    const bot = mockBot({
      items: [
        { name: 'wooden_pickaxe', count: 1 }, { name: 'stone_sword', count: 1 },
        { name: 'cobblestone', count: 3 }, { name: 'stick', count: 2 }, { name: 'crafting_table', count: 1 },
      ],
      ids: IDS,
      recipes: { stone_pickaxe: recipeFor('stone_pickaxe') },
      // Roadside placement: solid ground everywhere, air above, then the
      // placed table verifies.
      blockAtImpl: (p) => (p && p.y === 63 ? { name: 'dirt', position: p } : { name: 'air' }),
    })
    bot.placeBlock = async () => {
      bot.blockAt = () => TABLE
    }
    const ctx = { lastGoalKey: '', stepStatus: 'running', home: null }
    equip(bot, ctx, null, {})
    await flush()
    assert.equal(bot.calls.craft.length, 1)
    assert.deepEqual(bot.calls.craft[0].recipe, recipeFor('stone_pickaxe'))
  })
})

describe('x15 goal gate diverts to equip while the upgrade is due', () => {
  const F = (facts, bot, ctx) => MENU.equip.feasible(facts, bot, ctx)
  const W = (facts, bot, ctx) => stepWhy('equip', facts, bot, ctx, 'text')
  const geared = { sword: 1, pickaxe: 1, scaffold: 32, sticks: 2, planks: 0, logs: 0, cobble: 3 }
  const CHAIN = [
    { name: 'wooden_pickaxe', count: 1 }, { name: 'cobblestone', count: 3 }, { name: 'stick', count: 2 },
  ]
  const chainBot = (blockAt) => ({ inventory: { items: () => CHAIN }, blockAt: blockAt || (() => null) })
  const claimCtx = () => ({ home: { table: { x: 1, y: 64, z: 0 } } })
  it('geared + wooden + chain + verified table: equip feasible', () => {
    assert.equal(F({ ...geared, table: 0, tablePlaced: true }, chainBot(() => TABLE), claimCtx()), true)
  })
  it('geared + wooden + chain + table item: equip feasible', () => {
    const bot = { inventory: { items: () => [...CHAIN, { name: 'crafting_table', count: 1 }] } }
    assert.equal(F({ ...geared, table: 1, tablePlaced: false }, bot, {}), true)
  })
  it('geared + wooden + chain, no table: kit complete (digs later, never fails)', () => {
    assert.equal(F({ ...geared, table: 0, tablePlaced: false }, chainBot(), {}), false)
  })
  it('revmux 01: unloaded claim does not divert — kit complete, no done loop', () => {
    // stationStanding reads the null blockAt as a standing table
    // (facts.tablePlaced true), but the shared probe refuses the claim,
    // so the gate must agree with the behaviour: no diversion.
    assert.equal(F({ ...geared, table: 0, tablePlaced: true }, chainBot(() => null), claimCtx()), false)
    assert.equal(W({ ...geared, table: 0, tablePlaced: true }, chainBot(() => null), claimCtx()), 'equip: kit complete')
  })
  it('revmux 01: unloaded claim + low scaffold still digs via the scaffold branch', () => {
    assert.equal(F({ ...geared, scaffold: 0, table: 0, tablePlaced: true }, chainBot(() => null), claimCtx()), true)
  })
  it('geared + stone pickaxe: kit complete', () => {
    const bot = invBot([{ name: 'stone_pickaxe', count: 1 }, { name: 'cobblestone', count: 3 }, { name: 'stick', count: 2 }])
    assert.equal(F({ ...geared, table: 0, tablePlaced: true }, bot, {}), false)
  })
  it('geared + wooden, no cobble: kit complete', () => {
    const bot = invBot([{ name: 'wooden_pickaxe', count: 1 }, { name: 'stick', count: 2 }])
    assert.equal(F({ ...geared, cobble: 0, table: 0, tablePlaced: true }, bot, {}), false)
  })
  it('stepWhy: a due upgrade is not "kit complete"', () => {
    assert.equal(W({ ...geared, table: 0, tablePlaced: true }, chainBot(() => TABLE), claimCtx()), null)
  })
  it('stepWhy: a stone kit is still "kit complete"', () => {
    const bot = invBot([{ name: 'stone_pickaxe', count: 1 }])
    assert.equal(W({ ...geared, table: 0, tablePlaced: true }, bot, {}), 'equip: kit complete')
  })
})
