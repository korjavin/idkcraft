'use strict'

// Unit tests for the equip step (idkcraft-atl.6): pickaxe -> sword -> ~32
// scaffold blocks, reusing the craft.js recipe machinery.
const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const equip = require('../src/behaviours/equip')

function mockBot({ items = [], ids = {}, recipes = {}, craftImpl = null, blockAtImpl = null, findBlocksImpl = null, digImpl = null, placeBlockImpl = null } = {}) {
  const lines = []
  const errs = []
  const itemsByName = {}
  for (const [name, id] of Object.entries(ids)) itemsByName[name] = { id }
  const calls = { craft: [], setGoal: 0, goals: [], dig: [], placeBlock: [], equipped: [] }
  const bot = {
    lines,
    errs,
    calls,
    _items: items,
    entity: { position: { x: 0, y: 64, z: 0 } },
    registry: { itemsByName },
    inventory: { items: () => bot._items },
    recipesFor: (id) => {
      const name = Object.keys(ids).find((n) => ids[n] === id)
      if (!(name in recipes)) throw new Error(`unexpected recipesFor(${name})`)
      const r = recipes[name]
      return r ? [r] : []
    },
    craft: craftImpl || (async (recipe, count, table) => { calls.craft.push({ recipe, count, table }) }),
    blockAt: blockAtImpl || (() => null),
    findBlocks: findBlocksImpl || (() => []),
    dig: digImpl || (async (block) => { calls.dig.push(block) }),
    equip: async (item, dest) => { calls.equipped.push({ item: item && item.name, dest }) },
    placeBlock: placeBlockImpl || (async (ref, face) => { calls.placeBlock.push({ ref, face }) }),
    pathfinder: {
      setGoal: (goal) => { calls.setGoal++; calls.goals.push(goal) },
      isMoving: () => false,
    },
    chat: (line) => { lines.push(String(line)) },
  }
  const origError = console.error
  console.error = (m) => { errs.push(String(m)) }
  bot.restoreError = () => { console.error = origError }
  return bot
}

const IDS = {
  oak_log: 17, oak_planks: 18, stick: 280, crafting_table: 58,
  wooden_pickaxe: 270, stone_pickaxe: 274, wooden_sword: 268, stone_sword: 272,
}
const recipeFor = (name, count = 1) => ({ result: { name, count } })
const TABLE = { name: 'crafting_table' }

function freshCtx(home) {
  return { lastGoalKey: '', stepStatus: 'running', home: home || null }
}

async function flush() {
  for (let i = 0; i < 3; i++) await new Promise((resolve) => setImmediate(resolve))
}

// Craft lands the item, like a live window update before the next tick.
function landingCraft(bot) {
  return async (recipe, count, table) => {
    bot.calls.craft.push({ recipe, count, table })
    bot._items.push({ name: recipe.result.name, count: recipe.result.count || 1 })
  }
}

describe('equip step', () => {
  it('pickaxe first: planks + sticks + placed table crafts wooden_pickaxe', async () => {
    const bot = mockBot({
      items: [{ name: 'oak_planks', count: 3 }, { name: 'stick', count: 2 }],
      ids: IDS,
      recipes: { wooden_pickaxe: recipeFor('wooden_pickaxe') },
      blockAtImpl: () => TABLE,
    })
    const ctx = freshCtx({ table: { x: 1, y: 64, z: 0 } })
    equip(bot, ctx, null, {})
    await flush()
    assert.equal(bot.calls.craft.length, 1)
    assert.deepEqual(bot.calls.craft[0].recipe, recipeFor('wooden_pickaxe'))
    assert.equal(bot.calls.craft[0].count, 1)
    assert.deepEqual(bot.calls.craft[0].table, TABLE)
    assert.equal(ctx.stepStatus, 'running')
    bot.restoreError()
  })

  it('cobble picks stone, the sword lands in hand via equipGear', async () => {
    const bot = mockBot({
      items: [{ name: 'stone_pickaxe', count: 1 }, { name: 'cobblestone', count: 2 }, { name: 'stick', count: 1 }],
      ids: IDS,
      recipes: { stone_sword: recipeFor('stone_sword') },
      blockAtImpl: () => TABLE,
    })
    bot.craft = landingCraft(bot)
    const ctx = freshCtx({ table: { x: 1, y: 64, z: 0 } })
    equip(bot, ctx, null, {})
    await flush()
    assert.equal(bot.calls.craft.length, 1)
    assert.deepEqual(bot.calls.craft[0].recipe, recipeFor('stone_sword'))
    assert.deepEqual(bot.calls.equipped, [{ item: 'stone_sword', dest: 'hand' }])
    assert.deepEqual(bot.lines, ['equipped stone_sword'])
    bot.restoreError()
  })

  it('chains across ticks: pickaxe lands, the next tick crafts the sword', async () => {
    const bot = mockBot({
      items: [{ name: 'oak_planks', count: 6 }, { name: 'stick', count: 3 }],
      ids: IDS,
      recipes: { wooden_pickaxe: recipeFor('wooden_pickaxe'), wooden_sword: recipeFor('wooden_sword') },
      blockAtImpl: () => TABLE,
    })
    bot.craft = landingCraft(bot)
    const ctx = freshCtx({ table: { x: 1, y: 64, z: 0 } })
    equip(bot, ctx, null, {})
    await flush()
    assert.deepEqual(bot.calls.craft[0].recipe, recipeFor('wooden_pickaxe'))
    equip(bot, ctx, null, {})
    await flush()
    assert.equal(bot.calls.craft.length, 2)
    assert.deepEqual(bot.calls.craft[1].recipe, recipeFor('wooden_sword'))
    bot.restoreError()
  })

  it('sticks first when short: planks but no sticks crafts sticks, no table', async () => {
    const bot = mockBot({
      items: [{ name: 'oak_planks', count: 4 }],
      ids: IDS,
      recipes: { stick: recipeFor('stick', 4) },
    })
    const ctx = freshCtx()
    equip(bot, ctx, null, {})
    await flush()
    assert.equal(bot.calls.craft.length, 1)
    assert.deepEqual(bot.calls.craft[0].recipe, recipeFor('stick', 4))
    assert.equal(bot.calls.craft[0].table, null)
    bot.restoreError()
  })

  it('logs become planks first', async () => {
    const bot = mockBot({
      items: [{ name: 'oak_log', count: 2 }],
      ids: IDS,
      recipes: { oak_planks: recipeFor('oak_planks', 4) },
    })
    const ctx = freshCtx()
    equip(bot, ctx, null, {})
    await flush()
    assert.equal(bot.calls.craft.length, 1)
    assert.deepEqual(bot.calls.craft[0].recipe, recipeFor('oak_planks', 4))
    assert.equal(bot.calls.craft[0].table, null)
    bot.restoreError()
  })

  it('no materials fails loudly, crafts nothing', async () => {
    const bot = mockBot({ items: [], ids: IDS, recipes: {} })
    const ctx = freshCtx()
    equip(bot, ctx, null, {})
    await flush()
    assert.equal(bot.calls.craft.length, 0)
    assert.equal(ctx.stepStatus, 'failed:equip-pickaxe')
    assert.equal(bot.errs.length, 1)
    bot.restoreError()
  })

  it('no table anywhere fails no-table', async () => {
    const bot = mockBot({
      items: [{ name: 'oak_planks', count: 3 }, { name: 'stick', count: 2 }],
      ids: IDS,
      recipes: {},
    })
    const ctx = freshCtx()
    equip(bot, ctx, null, {})
    await flush()
    assert.equal(bot.calls.craft.length, 0)
    assert.equal(ctx.stepStatus, 'failed:equip-wooden_pickaxe')
    assert.ok(bot.errs[0].includes('no-table'))
    bot.restoreError()
  })

  it('inventory table is placed beside the body, then the tool is crafted', async () => {
    // Beside, never under: the feet cell collides with the bot and live
    // servers reject the placement (no-table loop).
    let placed = null
    const bot = mockBot({
      items: [{ name: 'crafting_table', count: 1 }, { name: 'oak_planks', count: 3 }, { name: 'stick', count: 2 }],
      ids: IDS,
      recipes: { wooden_pickaxe: recipeFor('wooden_pickaxe') },
      blockAtImpl: (p) => {
        if (placed && p.x === placed.x && p.y === placed.y && p.z === placed.z) {
          return { name: 'crafting_table', position: { ...placed } }
        }
        if (p.y === 63) return { name: 'dirt', position: { x: p.x, y: p.y, z: p.z } }
        return { name: 'air' }
      },
      placeBlockImpl: async (ref, face) => {
        bot.calls.placeBlock.push({ ref, face })
        placed = { x: ref.position.x + face.x, y: ref.position.y + face.y, z: ref.position.z + face.z }
      },
    })
    const ctx = freshCtx()
    equip(bot, ctx, null, {})
    await flush()
    assert.equal(bot.calls.placeBlock.length, 1)
    assert.deepEqual(placed, { x: 1, y: 64, z: 0 })
    assert.deepEqual(bot.calls.equipped, [{ item: 'crafting_table', dest: 'hand' }])
    assert.equal(bot.calls.craft.length, 1)
    assert.deepEqual(bot.calls.craft[0].recipe, recipeFor('wooden_pickaxe'))
    assert.equal(bot.calls.craft[0].table.name, 'crafting_table')
    bot.restoreError()
  })

  it('far home table: walks into reach, crafts nothing yet, one goal', async () => {
    const bot = mockBot({
      items: [{ name: 'oak_planks', count: 3 }, { name: 'stick', count: 2 }],
      ids: IDS,
      recipes: {},
      blockAtImpl: () => TABLE,
    })
    const ctx = freshCtx({ table: { x: 100, y: 64, z: 0 } })
    equip(bot, ctx, null, {})
    await flush()
    assert.equal(bot.calls.setGoal, 1)
    assert.equal(bot.calls.craft.length, 0)
    assert.equal(ctx.stepStatus, 'running')
    equip(bot, ctx, null, {})
    await flush()
    assert.equal(bot.calls.setGoal, 1) // deduped while walking
    bot.restoreError()
  })

  it('blocks: dirt in reach digs; a full kit is done', async () => {
    const bot = mockBot({
      items: [{ name: 'stone_sword', count: 1 }, { name: 'stone_pickaxe', count: 1 }, { name: 'dirt', count: 5 }],
      ids: IDS,
      recipes: {},
      findBlocksImpl: () => [{ x: 1, y: 64, z: 0, name: 'dirt' }],
    })
    const ctx = freshCtx()
    equip(bot, ctx, null, {})
    await flush()
    assert.equal(bot.calls.dig.length, 1)
    assert.deepEqual(bot.calls.dig[0], { x: 1, y: 64, z: 0, name: 'dirt' })
    assert.equal(ctx.stepStatus, 'running')
    bot._items = [{ name: 'stone_sword', count: 1 }, { name: 'stone_pickaxe', count: 1 }, { name: 'dirt', count: 32 }]
    equip(bot, ctx, null, {})
    assert.equal(ctx.stepStatus, 'done')
    bot.restoreError()
  })

  it('no dirt near fails loudly instead of digging forever', async () => {
    const bot = mockBot({
      items: [{ name: 'stone_sword', count: 1 }, { name: 'stone_pickaxe', count: 1 }],
      ids: IDS,
      recipes: {},
      findBlocksImpl: () => [],
    })
    const ctx = freshCtx()
    equip(bot, ctx, null, {})
    await flush()
    assert.equal(bot.calls.dig.length, 0)
    assert.equal(ctx.stepStatus, 'failed:equip-blocks')
    bot.restoreError()
  })

  it('never digs the ground under its own feet', async () => {
    const bot = mockBot({
      items: [{ name: 'stone_sword', count: 1 }, { name: 'stone_pickaxe', count: 1 }],
      ids: IDS,
      recipes: {},
      findBlocksImpl: () => [{ x: 0, y: 63, z: 0, name: 'dirt' }],
    })
    const ctx = freshCtx()
    equip(bot, ctx, null, {})
    await flush()
    assert.equal(bot.calls.dig.length, 0)
    assert.equal(ctx.stepStatus, 'failed:equip-blocks')
    bot.restoreError()
  })

  it('stone holds the pickaxe first: no hand-mining, no lost drops', async () => {
    const pick = { name: 'stone_pickaxe', count: 1 }
    const bot = mockBot({
      items: [{ name: 'stone_sword', count: 1 }, pick],
      ids: IDS,
      recipes: {},
      findBlocksImpl: () => [{ x: 1, y: 64, z: 0, name: 'stone' }],
    })
    const ctx = freshCtx()
    equip(bot, ctx, null, {})
    await flush()
    assert.deepEqual(bot.calls.equipped, [{ item: 'stone_pickaxe', dest: 'hand' }])
    assert.equal(bot.calls.dig.length, 1)
    bot.restoreError()
  })

  it('ghost crafts stall out: three strikes fail instead of looping', async () => {
    const bot = mockBot({
      items: [{ name: 'oak_planks', count: 3 }, { name: 'stick', count: 2 }],
      ids: IDS,
      recipes: { wooden_pickaxe: recipeFor('wooden_pickaxe') },
      blockAtImpl: () => TABLE,
    })
    const ctx = freshCtx({ table: { x: 1, y: 64, z: 0 } })
    for (let i = 0; i < 3; i++) {
      equip(bot, ctx, null, {})
      await flush()
    }
    assert.equal(bot.calls.craft.length, 3)
    assert.equal(ctx.stepStatus, 'failed:equip-wooden_pickaxe')
    assert.ok(bot.errs.some((e) => e.includes('craft-stall')))
    bot.restoreError()
  })

  it('wrong block after placement fails table-place instead of a window timeout', async () => {
    // Live 26.1 lesson: a planks block reads truthy, and activating it
    // waits out the 20 s window timeout instead of failing.
    let placed = false
    const bot = mockBot({
      items: [{ name: 'crafting_table', count: 1 }, { name: 'oak_planks', count: 3 }, { name: 'stick', count: 2 }],
      ids: IDS,
      recipes: { wooden_pickaxe: recipeFor('wooden_pickaxe') },
      blockAtImpl: (p) => {
        if (p.y === 63) return { name: 'dirt', position: { x: p.x, y: p.y, z: p.z } }
        return placed ? { name: 'oak_planks' } : { name: 'air' }
      },
      placeBlockImpl: async (ref, face) => {
        bot.calls.placeBlock.push({ ref, face })
        placed = true // the server put planks (wrong held item) where the table goes
      },
    })
    const ctx = freshCtx()
    equip(bot, ctx, null, {})
    await flush()
    assert.equal(bot.calls.placeBlock.length, 1)
    assert.equal(bot.calls.craft.length, 0)
    assert.equal(ctx.stepStatus, 'failed:equip-wooden_pickaxe')
    assert.ok(bot.errs.some((e) => e.includes('table-place')))
    bot.restoreError()
  })

  it('ghost home table falls through to the inventory branch', async () => {
    let placed = null
    const bot = mockBot({
      items: [{ name: 'crafting_table', count: 1 }, { name: 'oak_planks', count: 3 }, { name: 'stick', count: 2 }],
      ids: IDS,
      recipes: { wooden_pickaxe: recipeFor('wooden_pickaxe') },
      blockAtImpl: (p) => {
        if (placed && p.x === placed.x && p.y === placed.y && p.z === placed.z) {
          return { name: 'crafting_table', position: { ...placed } }
        }
        if (p.y === 63) return { name: 'dirt', position: { x: p.x, y: p.y, z: p.z } }
        return { name: 'air' }
      },
      placeBlockImpl: async (ref, face) => {
        bot.calls.placeBlock.push({ ref, face })
        placed = { x: ref.position.x + face.x, y: ref.position.y + face.y, z: ref.position.z + face.z }
      },
    })
    const ctx = freshCtx({ table: { x: 50, y: 64, z: 50 } }) // mined away: reads air
    equip(bot, ctx, null, {})
    await flush()
    assert.equal(bot.calls.placeBlock.length, 1)
    assert.equal(bot.calls.craft.length, 1)
    assert.deepEqual(bot.calls.craft[0].recipe, recipeFor('wooden_pickaxe'))
    bot.restoreError()
  })

  it('ghost home table with no spare fails no-table instead of stalling', async () => {
    const bot = mockBot({
      items: [{ name: 'oak_planks', count: 3 }, { name: 'stick', count: 2 }],
      ids: IDS,
      recipes: {},
      blockAtImpl: () => ({ name: 'air' }),
    })
    const ctx = freshCtx({ table: { x: 50, y: 64, z: 50 } })
    ctx.claimedTable = { x: 50, y: 64, z: 50 } // stale: retract so craft rebuilds
    equip(bot, ctx, null, {})
    await flush()
    assert.equal(bot.calls.craft.length, 0)
    assert.equal(ctx.stepStatus, 'failed:equip-wooden_pickaxe')
    assert.ok(bot.errs.some((e) => e.includes('no-table')))
    assert.equal(ctx.claimedTable, undefined)
    bot.restoreError()
  })

  it('walking to a table that never arrives fails table-unreachable', async () => {
    const bot = mockBot({
      items: [{ name: 'oak_planks', count: 3 }, { name: 'stick', count: 2 }],
      ids: IDS,
      recipes: {},
      blockAtImpl: () => TABLE,
    })
    const ctx = freshCtx({ table: { x: 100, y: 64, z: 0 } })
    for (let i = 0; i < 21; i++) {
      equip(bot, ctx, null, {})
      await flush()
      if (ctx.stepStatus !== 'running') break
    }
    assert.equal(bot.calls.setGoal, 1) // one goal, then patience, then fail
    assert.equal(ctx.stepStatus, 'failed:equip-wooden_pickaxe')
    assert.ok(bot.errs.some((e) => e.includes('table-unreachable')))
    bot.restoreError()
  })

  it('placed table is claimed as the home station (menu stops rebuilding)', async () => {
    let placed = null
    const bot = mockBot({
      items: [{ name: 'crafting_table', count: 1 }, { name: 'oak_planks', count: 3 }, { name: 'stick', count: 2 }],
      ids: IDS,
      recipes: { wooden_pickaxe: recipeFor('wooden_pickaxe') },
      blockAtImpl: (p) => {
        if (placed && p.x === placed.x && p.y === placed.y && p.z === placed.z) {
          return { name: 'crafting_table', position: { ...placed } }
        }
        if (p.y === 63) return { name: 'dirt', position: { x: p.x, y: p.y, z: p.z } }
        return { name: 'air' }
      },
      placeBlockImpl: async (ref, face) => {
        bot.calls.placeBlock.push({ ref, face })
        placed = { x: ref.position.x + face.x, y: ref.position.y + face.y, z: ref.position.z + face.z }
      },
    })
    const ctx = freshCtx({ site: { x: 0, y: 64, z: 0 } })
    equip(bot, ctx, null, {})
    await flush()
    assert.equal(bot.calls.craft.length, 1)
    assert.deepEqual({ x: ctx.home.table.x, y: ctx.home.table.y, z: ctx.home.table.z }, placed)
    assert.deepEqual(ctx.claimedTable, placed) // menu-visible claim, homeless or not
    bot.restoreError()
  })

  it('digs only in pickup reach: steps in first so drops land at the feet', async () => {
    const bot = mockBot({
      items: [{ name: 'stone_sword', count: 1 }, { name: 'stone_pickaxe', count: 1 }],
      ids: IDS,
      recipes: {},
      findBlocksImpl: () => [{ x: 3, y: 64, z: 0, name: 'dirt' }],
    })
    const ctx = freshCtx()
    equip(bot, ctx, null, {}) // 3 blocks away: walk, do not dig
    await flush()
    assert.equal(bot.calls.setGoal, 1)
    assert.equal(bot.calls.dig.length, 0)
    bot.entity.position = { x: 2, y: 64, z: 0 } // arrived: dig now
    ctx.lastGoalKey = ''
    equip(bot, ctx, null, {})
    await flush()
    assert.equal(bot.calls.dig.length, 1)
    bot.restoreError()
  })

  it('an approach that never arrives fails dig-unreachable', async () => {
    const bot = mockBot({
      items: [{ name: 'stone_sword', count: 1 }, { name: 'stone_pickaxe', count: 1 }],
      ids: IDS,
      recipes: {},
      findBlocksImpl: () => [{ x: 3, y: 64, z: 0, name: 'dirt' }],
    })
    const ctx = freshCtx()
    for (let i = 0; i < 31; i++) {
      equip(bot, ctx, null, {})
      await flush()
      if (ctx.stepStatus !== 'running') break
    }
    assert.equal(bot.calls.dig.length, 0)
    assert.equal(ctx.stepStatus, 'failed:equip-blocks')
    assert.ok(bot.errs.some((e) => e.includes('dig-unreachable')))
    bot.restoreError()
  })

  it('registers in BEHAVIOURS under equip', () => {
    const { BEHAVIOURS } = require('../src/index')
    assert.equal(BEHAVIOURS.equip, equip)
  })
})
