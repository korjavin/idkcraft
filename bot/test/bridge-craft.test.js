// idkcraft-neuc.12: bridge craft — recipesFor/recipesAll parity with
// mineflayer's plugin, bot.craft on FakeTransport (2x2 inventory grid and a
// 3x3 table, result slot filled a round trip after the click like the
// server), and the REAL craft.js paths run unchanged through the adapter.
// Run: `cd bot && npm test`.
'use strict'

const { describe, it, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const Vec3 = require('vec3')

const { BaritoneBot } = require('../src/bridge/index')
const { FakeTransport } = require('../src/bridge/transport')
const craftStep = require('../src/behaviours/craft')

const registry = require('minecraft-data')('26.1.2')
const id = (name) => registry.itemsByName[name].id

const TABLE = { x: 2, y: 64, z: 0 }
const RECIPES = [
  { grid: { oak_log: 1 }, result: { name: 'oak_planks', count: 4 } },
  { grid: { oak_planks: 4 }, result: { name: 'crafting_table', count: 1 } },
  { grid: { oak_planks: 2 }, result: { name: 'stick', count: 4 } },
  { grid: { oak_planks: 3, stick: 2 }, result: { name: 'wooden_pickaxe', count: 1 } },
  { grid: { cobblestone: 3, stick: 2 }, result: { name: 'stone_pickaxe', count: 1 } },
]

function craftBot(inventory) {
  const transport = new FakeTransport({
    pos: { x: 0, y: 64, z: 0, yaw: 0, pitch: 0, onGround: true },
    inventory,
    recipes: RECIPES,
    blocks: { '2,64,0': 'crafting_table' },
    containers: { '2,64,0': { type: 'minecraft:crafting', size: 10, title: 'Crafting', slots: [] } },
  })
  const bot = new BaritoneBot(transport, { Vec3, registry, username: 'IdkBody' })
  return { transport, bot }
}

function invOf(bot, name) {
  return bot.inventory.items().filter((i) => i.name === name).reduce((n, i) => n + i.count, 0)
}
function fakeOf(transport, name) {
  return transport.state.inventory.filter((i) => i.slot >= 9 && i.name === name).reduce((n, i) => n + i.count, 0)
}
const sig = (r) => JSON.stringify([r.result, r.inShape, r.ingredients, r.requiresTable])

describe('bridge craft (idkcraft-neuc.12)', () => {
  let transport
  let bot
  afterEach(async () => { await bot.stop() })

  it('recipesFor/recipesAll match mineflayer\'s plugin on the same inventory', async () => {
    ({ transport, bot } = craftBot([
      { slot: 9, name: 'oak_log', count: 3 }, { slot: 10, name: 'oak_planks', count: 7 },
      { slot: 11, name: 'stick', count: 4 }, { slot: 12, name: 'cobblestone', count: 3 }, { slot: 13, name: 'coal', count: 1 },
    ]))
    await bot.start({ pollMs: 0 })
    const mf = { registry, inventory: bot.inventory }
    require('mineflayer/lib/plugins/craft')(mf)
    const table = bot.blockAt(new Vec3(TABLE.x, TABLE.y, TABLE.z))
    for (const name of ['oak_planks', 'stick', 'crafting_table', 'wooden_pickaxe', 'stone_pickaxe', 'torch']) {
      for (const t of [null, table]) {
        const ours = bot.recipesFor(id(name), null, 1, t)
        assert.deepEqual(ours.map(sig), mf.recipesFor(id(name), null, 1, t).map(sig), `${name} table=${!!t}`)
        assert.deepEqual(bot.recipesAll(id(name), null, t).map(sig), mf.recipesAll(id(name), null, t).map(sig))
      }
    }
    assert.ok(bot.recipesFor(id('oak_planks'), null, 1, null).length > 0) // the prod failure: [] -> failed:craft-oak_planks
    assert.equal(bot.recipesFor(id('wooden_pickaxe'), null, 1, null).length, 0) // 3x3 needs the table
    assert.ok(bot.recipesFor(id('wooden_pickaxe'), null, 1, table).length > 0)
  })

  it('2x2 craft: planks then a crafting table, ingredients consumed, grid and cursor empty', async () => {
    ({ transport, bot } = craftBot([{ slot: 9, name: 'oak_log', count: 2 }]))
    await bot.start({ pollMs: 0 })
    await bot.craft(bot.recipesFor(id('oak_planks'), null, 1, null)[0], 2, null)
    assert.equal(fakeOf(transport, 'oak_planks'), 8)
    assert.equal(fakeOf(transport, 'oak_log'), 0)
    assert.equal(invOf(bot, 'oak_planks'), 8)
    await bot.craft(bot.recipesFor(id('crafting_table'), null, 1, null)[0], 1, null)
    assert.equal(fakeOf(transport, 'crafting_table'), 1)
    assert.equal(fakeOf(transport, 'oak_planks'), 4)
    assert.equal(transport.state.inventory.filter((i) => i.slot < 5).length, 0)
    assert.equal(transport.state.cursor, null)
    assert.ok(transport.state.clickLog.every((c) => c.windowId === 0))
  })

  it('table craft: opens the crafting window, crafts, closes; pickaxe out, mats spent', async () => {
    ({ transport, bot } = craftBot([{ slot: 9, name: 'oak_planks', count: 3 }, { slot: 10, name: 'stick', count: 2 }]))
    await bot.start({ pollMs: 0 })
    const table = bot.blockAt(new Vec3(TABLE.x, TABLE.y, TABLE.z))
    await bot.craft(bot.recipesFor(id('wooden_pickaxe'), null, 1, table)[0], 1, table)
    assert.equal(fakeOf(transport, 'wooden_pickaxe'), 1)
    assert.equal(fakeOf(transport, 'oak_planks'), 0)
    assert.equal(fakeOf(transport, 'stick'), 0)
    assert.equal(bot.currentWindow, null)
    assert.equal(transport.state.closeLog.length, 1)
  })

  it('a grid the server never fills fails instead of hanging', async () => {
    ({ transport, bot } = craftBot([{ slot: 9, name: 'oak_log', count: 1 }]))
    transport.state.recipes = []
    await bot.start({ pollMs: 0 })
    const recipe = bot.recipesFor(id('oak_planks'), null, 1, null)[0]
    await assert.rejects(bot.craft(recipe, 1, null), /result slot/)
  })

  it('REAL craft.js step: logs -> planks through recipesFor + safeCraft, no failed:craft-oak_planks', async () => {
    ({ transport, bot } = craftBot([{ slot: 9, name: 'oak_log', count: 4 }]))
    await bot.start({ pollMs: 0 })
    bot.chat = () => {}
    const ctx = { lastGoalKey: '', stepStatus: 'running', home: null }
    craftStep(bot, ctx, null, {})
    assert.equal(ctx.craftInFlight, true)
    for (let i = 0; i < 400 && ctx.craftInFlight; i++) await new Promise((r) => setTimeout(r, 10))
    assert.equal(ctx.craftInFlight, false)
    assert.equal(ctx.stepStatus, 'running')
    assert.equal(fakeOf(transport, 'oak_planks'), 16)
    assert.equal(fakeOf(transport, 'oak_log'), 0)
  })

  it('REAL craft.js safeCraft at a table (paced clicks): sticks -> stone_pickaxe', async () => {
    ({ transport, bot } = craftBot([{ slot: 9, name: 'oak_planks', count: 2 }, { slot: 10, name: 'cobblestone', count: 3 }]))
    await bot.start({ pollMs: 0 })
    await craftStep.safeCraft(bot, bot.recipesFor(id('stick'), null, 1, null)[0], 1, null, { item: 'stick' })
    assert.equal(fakeOf(transport, 'stick'), 4)
    const table = bot.blockAt(new Vec3(TABLE.x, TABLE.y, TABLE.z))
    const recipe = bot.recipesFor(id('stone_pickaxe'), null, 1, table)[0]
    await craftStep.safeCraft(bot, recipe, 1, table, { item: 'stone_pickaxe' })
    assert.equal(fakeOf(transport, 'stone_pickaxe'), 1)
    assert.equal(fakeOf(transport, 'cobblestone'), 0)
    assert.equal(fakeOf(transport, 'stick'), 2)
    assert.equal(invOf(bot, 'stone_pickaxe'), 1)
  })
})
