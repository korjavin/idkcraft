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
    equip: async (item, dest) => {
      if (!item) throw new Error('Invalid item object in equip') // live mineflayer rejects non-objects
      calls.equipped.push({ item: item.name, dest })
    },
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

// xg9: paced crafts take real time (60 ms/op); poll for N craft calls.
async function untilCrafts(bot, n, timeoutMs = 8000) {
  const t0 = Date.now()
  while (bot.calls.craft.length < n) {
    if (Date.now() - t0 > timeoutMs) throw new Error(`craft calls stuck at ${bot.calls.craft.length}, want ${n}`)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  await flush()
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
    await untilCrafts(bot, 1)
    assert.deepEqual(bot.calls.craft[0].recipe, recipeFor('wooden_pickaxe'))
    equip(bot, ctx, null, {})
    await untilCrafts(bot, 2)
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
      await untilCrafts(bot, i + 1)
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

  it('placed table is claimed menu-visibly, never as the home table', async () => {
    // Revmux round-1: writing ctx.home.table shadowed the blueprint cell
    // (build claims only while unset) and the house never finished.
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
    assert.equal(ctx.home.table, undefined) // the blueprint cell stays build's
    assert.deepEqual({ x: ctx.claimedTable.x, y: ctx.claimedTable.y, z: ctx.claimedTable.z }, placed) // menu-visible claim, homeless or not
    assert.equal(typeof ctx.claimedTable.floored, 'function', 'Vec3 claim (h9z): readers blockAt() it')
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

  it('chains leftover logs: sticks satisfied, rock short, logs remain', async () => {
    // Revmux round-1: 2 logs stalled after one planks op while logs were
    // still on hand. The consuming mock proves the chain runs to the tool.
    const bot = mockBot({
      items: [{ name: 'oak_log', count: 1 }, { name: 'stick', count: 2 }],
      ids: IDS,
      recipes: { oak_planks: recipeFor('oak_planks', 4), wooden_pickaxe: recipeFor('wooden_pickaxe') },
      blockAtImpl: () => TABLE,
    })
    bot.craft = async (recipe, count, table) => {
      bot.calls.craft.push({ recipe, count, table })
      if (recipe.result.name.endsWith('_planks')) {
        const log = bot._items.find((i) => i.name === 'oak_log')
        if (log) log.count -= 1
        bot._items.push({ name: 'oak_planks', count: 4 })
      } else {
        bot._items.push({ name: recipe.result.name, count: 1 })
      }
    }
    const ctx = freshCtx({ table: { x: 1, y: 64, z: 0 } })
    equip(bot, ctx, null, {})
    await untilCrafts(bot, 1)
    assert.deepEqual(bot.calls.craft[0].recipe, recipeFor('oak_planks', 4))
    equip(bot, ctx, null, {})
    await untilCrafts(bot, 2)
    assert.equal(bot.calls.craft.length, 2)
    assert.deepEqual(bot.calls.craft[1].recipe, recipeFor('wooden_pickaxe'))
    assert.equal(ctx.stepStatus, 'running') // chained, never failed
    bot.restoreError()
  })

  it('finished runs spend their counters: the next pick starts fresh', async () => {
    const bot = mockBot({
      items: [{ name: 'stone_sword', count: 1 }, { name: 'stone_pickaxe', count: 1 }],
      ids: IDS,
      recipes: {},
      findBlocksImpl: () => [],
    })
    const ctx = freshCtx()
    ctx.equip = { digs: 64, walkWaits: 20, approachWaits: 30, made: { wooden_pickaxe: 2 } }
    equip(bot, ctx, null, {}) // no dirt: fails, and the stale budget clears
    await flush()
    assert.equal(ctx.stepStatus, 'failed:equip-blocks')
    assert.deepEqual(ctx.equip, {})
    bot.restoreError()
  })

  it('registers in BEHAVIOURS under equip', () => {
    const { BEHAVIOURS } = require('../src/index')
    assert.equal(BEHAVIOURS.equip, equip)
  })
})

describe('equip failure edges (idkcraft-pun)', () => {
  it('planks without a stick recipe fail no-stick-recipe', async () => {
    const bot = mockBot({
      items: [{ name: 'oak_planks', count: 4 }],
      ids: IDS,
      recipes: { stick: null },
    })
    const ctx = freshCtx()
    equip(bot, ctx, null, {})
    await flush()
    assert.equal(bot.calls.craft.length, 0)
    assert.equal(ctx.stepStatus, 'failed:equip-pickaxe')
    assert.ok(bot.errs[0].includes('no-stick-recipe'), `errs: ${bot.errs}`)
    bot.restoreError()
  })

  it('logs without a planks recipe fail no-planks-recipe', async () => {
    const bot = mockBot({
      items: [{ name: 'oak_log', count: 2 }],
      ids: IDS,
      recipes: { oak_planks: null },
    })
    const ctx = freshCtx()
    equip(bot, ctx, null, {})
    await flush()
    assert.equal(bot.calls.craft.length, 0)
    assert.equal(ctx.stepStatus, 'failed:equip-pickaxe')
    assert.ok(bot.errs[0].includes('no-planks-recipe'), `errs: ${bot.errs}`)
    bot.restoreError()
  })

  it('sticks plus logs without a planks recipe fail converting the rock', async () => {
    const bot = mockBot({
      items: [{ name: 'stick', count: 2 }, { name: 'oak_log', count: 2 }],
      ids: IDS,
      recipes: { oak_planks: null },
    })
    const ctx = freshCtx()
    equip(bot, ctx, null, {})
    await flush()
    assert.equal(bot.calls.craft.length, 0)
    assert.equal(ctx.stepStatus, 'failed:equip-pickaxe')
    assert.ok(bot.errs[0].includes('no-planks-recipe'), `errs: ${bot.errs}`)
    bot.restoreError()
  })

  it('sticks alone fail no-materials', async () => {
    const bot = mockBot({ items: [{ name: 'stick', count: 2 }], ids: IDS, recipes: {} })
    const ctx = freshCtx()
    equip(bot, ctx, null, {})
    await flush()
    assert.equal(bot.calls.craft.length, 0)
    assert.equal(ctx.stepStatus, 'failed:equip-pickaxe')
    assert.ok(bot.errs[0].includes('no-materials'), `errs: ${bot.errs}`)
    bot.restoreError()
  })

  it('table lands but the tool recipe is gone: no-recipe fails loudly', async () => {
    const bot = mockBot({
      items: [{ name: 'oak_planks', count: 3 }, { name: 'stick', count: 2 }],
      ids: IDS,
      recipes: { wooden_pickaxe: null },
      blockAtImpl: () => TABLE,
    })
    const ctx = freshCtx({ table: { x: 1, y: 64, z: 0 } })
    equip(bot, ctx, null, {})
    await flush()
    assert.equal(bot.calls.craft.length, 0)
    assert.equal(ctx.stepStatus, 'failed:equip-wooden_pickaxe')
    assert.ok(bot.errs[0].includes('no-recipe'), `errs: ${bot.errs}`)
    bot.restoreError()
  })

  it('missing bot.craft fails instead of throwing', async () => {
    const bot = mockBot({
      items: [{ name: 'oak_planks', count: 4 }],
      ids: IDS,
      recipes: { stick: recipeFor('stick', 4) },
    })
    delete bot.craft
    const ctx = freshCtx()
    equip(bot, ctx, null, {})
    await flush()
    assert.equal(ctx.stepStatus, 'failed:equip-stick')
    assert.ok(bot.errs[0].includes('bot.craft missing'), `errs: ${bot.errs}`)
    bot.restoreError()
  })

  it('throwing craft fails with the window error', async () => {
    const bot = mockBot({
      items: [{ name: 'oak_planks', count: 4 }],
      ids: IDS,
      recipes: { stick: recipeFor('stick', 4) },
      craftImpl: async () => { throw new Error('window busy') },
    })
    const ctx = freshCtx()
    equip(bot, ctx, null, {})
    await flush()
    assert.equal(ctx.stepStatus, 'failed:equip-stick')
    assert.ok(bot.errs[0].includes('window busy'), `errs: ${bot.errs}`)
    bot.restoreError()
  })

  it('hanging craft fails craft-timeout on the deadline', async () => {
    const { mock } = require('node:test')
    mock.timers.enable({ apis: ['setTimeout'] })
    try {
      const bot = mockBot({
        items: [{ name: 'oak_planks', count: 4 }],
        ids: IDS,
        recipes: { stick: recipeFor('stick', 4) },
        craftImpl: () => new Promise(() => {}), // hung window
      })
      const ctx = freshCtx()
      equip(bot, ctx, null, {})
      mock.timers.tick(30001)
      await flush()
      assert.equal(ctx.stepStatus, 'failed:equip-stick')
      assert.ok(bot.errs[0].includes('craft-timeout'), `errs: ${bot.errs}`)
      bot.restoreError()
    } finally {
      mock.timers.reset()
    }
  })

  it('landed craft clears strikes, frozen guard held', async () => {
    const bot = mockBot({
      items: [{ name: 'oak_planks', count: 4 }],
      ids: IDS,
      recipes: { stick: recipeFor('stick', 4) },
    })
    bot.craft = landingCraft(bot)
    const ctx = freshCtx()
    ctx.equip = { made: Object.freeze({ stick: 2 }) }
    equip(bot, ctx, null, {})
    await flush()
    assert.equal(ctx.stepStatus, 'running')
    assert.ok(bot.lines.some((l) => l === 'equipped stick'), `lines: ${bot.lines}`)
    assert.deepEqual(bot.errs, [])
    bot.restoreError()
  })

  it('flaky inventory degrades the table hunt to no-table', async () => {
    // items() dies mid-tick: tableFor reads [] and fails loudly instead of
    // crashing the tick. 6 = hasPickaxe + 4 toolOp reads, so the 6th call is
    // tableFor's itemsOf; the calls assert below keeps this honest if a read
    // is added or removed upstream.
    const bot = mockBot({
      items: [{ name: 'oak_planks', count: 3 }, { name: 'stick', count: 2 }],
      ids: IDS,
      recipes: { wooden_pickaxe: recipeFor('wooden_pickaxe') },
    })
    let calls = 0
    bot.inventory.items = () => {
      calls++
      if (calls >= 6) throw new Error('window flicker')
      return bot._items
    }
    const ctx = freshCtx()
    equip(bot, ctx, null, {})
    await flush()
    assert.ok(calls >= 6, `items() throw reached tableFor, calls=${calls}`)
    assert.equal(ctx.stepStatus, 'failed:equip-wooden_pickaxe')
    assert.ok(bot.errs[0].includes('no-table'), `errs: ${bot.errs}`)
    bot.restoreError()
  })

  it('nameless find hit is named through blockAt', async () => {
    const bot = mockBot({
      items: [{ name: 'stone_sword', count: 1 }, { name: 'stone_pickaxe', count: 1 }, { name: 'dirt', count: 5 }],
      ids: IDS,
      recipes: {},
      findBlocksImpl: () => [{ x: 1, y: 64, z: 0 }],
      blockAtImpl: (p) => ({ name: 'dirt', position: p }),
    })
    const ctx = freshCtx()
    equip(bot, ctx, null, {})
    await flush()
    assert.equal(bot.calls.dig.length, 1)
    assert.equal(ctx.stepStatus, 'running')
    bot.restoreError()
  })

  it('far dirt walks into reach first', async () => {
    const bot = mockBot({
      items: [{ name: 'stone_sword', count: 1 }, { name: 'stone_pickaxe', count: 1 }, { name: 'dirt', count: 5 }],
      ids: IDS,
      recipes: {},
      findBlocksImpl: () => [{ x: 20, y: 64, z: 0, name: 'dirt' }],
    })
    const ctx = freshCtx()
    equip(bot, ctx, null, {})
    await flush()
    assert.equal(bot.calls.dig.length, 0)
    assert.equal(ctx.lastGoalKey, 'equip-dig:20,64,0')
    assert.equal(ctx.stepStatus, 'running')
    bot.restoreError()
  })

  it('dig error fails the blocks loudly', async () => {
    const bot = mockBot({
      items: [{ name: 'stone_sword', count: 1 }, { name: 'stone_pickaxe', count: 1 }, { name: 'dirt', count: 5 }],
      ids: IDS,
      recipes: {},
      findBlocksImpl: () => [{ x: 1, y: 64, z: 0, name: 'dirt' }],
      digImpl: async () => { throw new Error('ghost block') },
    })
    const ctx = freshCtx()
    equip(bot, ctx, null, {})
    await flush()
    assert.equal(ctx.stepStatus, 'failed:equip-blocks')
    assert.ok(bot.errs[0].includes('ghost block'), `errs: ${bot.errs}`)
    bot.restoreError()
  })
})

describe('equip helper residuals (idkcraft-17a)', () => {
  // NOTE: no itemsOf-throw test beyond the flaky one below: a persistently
  // throwing items() empties every tally first (no-materials), so only the
  // flaky-mid-tick shape reaches itemsOf with garbage.
  it('flaky non-array inventory degrades the held search, the dig proceeds', async () => {
    const bot = mockBot({
      items: [{ name: 'stone_pickaxe', count: 1 }, { name: 'stone_sword', count: 1 }],
      ids: IDS,
      recipes: {},
      findBlocksImpl: () => [{ x: 1, y: 63, z: 0, name: 'stone' }],
      blockAtImpl: (q) => ({ name: q && q.y >= 64 ? 'air' : 'stone' }), // open ground: stone below, air at feet
    })
    let calls = 0
    bot.inventory.items = () => {
      calls++
      if (calls >= 5) return {} // kind + scaffold + digTargets ok; the held search sees garbage
      return bot._items
    }
    const ctx = freshCtx()
    equip(bot, ctx, null, {})
    await flush()
    await flush()
    assert.ok(calls >= 5, `held search hit the garbage, calls=${calls}`)
    assert.equal(bot.calls.dig.length, 1, 'no held pickaxe found, still digs')
    assert.deepEqual(bot.calls.equipped, [], 'garbled inventory holds nothing')
    assert.equal(ctx.stepStatus, 'running')
    bot.restoreError()
  })

  it('a message-less craft error still logs the failure', async () => {
    const bot = mockBot({
      items: [{ name: 'oak_planks', count: 4 }],
      ids: IDS,
      recipes: { stick: recipeFor('stick', 4) },
      craftImpl: async () => { throw ({ code: 'EWINDOW' }) },
    })
    const ctx = freshCtx()
    equip(bot, ctx, null, {})
    await flush()
    assert.equal(ctx.stepStatus, 'failed:equip-stick')
    assert.ok(bot.errs.join(' ').includes('[object Object]'), `raw err logged: ${bot.errs}`)
    bot.restoreError()
  })

  it('a failing error log never throws out of the step', () => {
    const bot = mockBot({ items: [{ name: 'stick', count: 2 }], ids: IDS, recipes: {} })
    console.error = () => { throw new Error('log sink gone') }
    const ctx = freshCtx()
    try {
      assert.doesNotThrow(() => equip(bot, ctx, null, {}))
    } finally {
      bot.restoreError()
    }
    assert.equal(ctx.stepStatus, 'failed:equip-pickaxe')
  })

  it('a claim identical to our station scans once, not twice', async () => {
    const bot = mockBot({
      items: [
        { name: 'oak_planks', count: 3 },
        { name: 'stick', count: 2 },
        { name: 'crafting_table', count: 1 },
      ],
      ids: IDS,
      recipes: { wooden_pickaxe: recipeFor('wooden_pickaxe') },
    })
    const station = { x: 5, y: 64, z: 0 }
    let stationReads = 0
    let placed = null
    bot.blockAt = (p) => {
      // Coord match, not identity (h9z): tableFor normalises claims to Vec3.
      if (p.x === station.x && p.y === station.y && p.z === station.z) {
        stationReads++
        return null // ghosted: falls through to the inventory branch
      }
      if (placed && p.x === placed.x && p.y === placed.y && p.z === placed.z) {
        return { name: 'crafting_table', position: { ...placed } }
      }
      if (p.y === 63) return { name: 'dirt', position: { x: p.x, y: p.y, z: p.z } }
      return { name: 'air' }
    }
    bot.placeBlock = async (ref, face) => {
      bot.calls.placeBlock.push({ ref, face })
      placed = { x: ref.position.x + face.x, y: ref.position.y + face.y, z: ref.position.z + face.z }
    }
    const ctx = freshCtx()
    ctx.equip = { tablePos: station }
    ctx.claimedTable = station // same ref: dedup, one scan
    equip(bot, ctx, null, {})
    await flush()
    await flush()
    assert.equal(stationReads, 1, 'ghost scanned once')
    assert.equal(bot.calls.craft.length, 1, 'inventory branch places and crafts')
    bot.restoreError()
  })

  it('a throwing station lookup falls through to the inventory branch', async () => {
    const bot = mockBot({
      items: [
        { name: 'oak_planks', count: 3 },
        { name: 'stick', count: 2 },
        { name: 'crafting_table', count: 1 },
      ],
      ids: IDS,
      recipes: { wooden_pickaxe: recipeFor('wooden_pickaxe') },
    })
    const station = { x: 5, y: 64, z: 0 }
    let placed = null
    bot.blockAt = (p) => {
      if (p.x === station.x && p.y === station.y && p.z === station.z) throw new Error('chunk gone') // coord match (h9z): reads are Vec3-normalised
      if (placed && p.x === placed.x && p.y === placed.y && p.z === placed.z) {
        return { name: 'crafting_table', position: { ...placed } }
      }
      if (p.y === 63) return { name: 'dirt', position: { x: p.x, y: p.y, z: p.z } }
      return { name: 'air' }
    }
    bot.placeBlock = async (ref, face) => {
      bot.calls.placeBlock.push({ ref, face })
      placed = { x: ref.position.x + face.x, y: ref.position.y + face.y, z: ref.position.z + face.z }
    }
    const ctx = freshCtx()
    ctx.claimedTable = station
    assert.doesNotThrow(() => equip(bot, ctx, null, {}))
    await flush()
    await flush()
    assert.equal(bot.calls.craft.length, 1, 'placed from inventory and crafted')
    bot.restoreError()
  })

  it('reaching the table clears a piled walk wait', async () => {
    const bot = mockBot({
      items: [{ name: 'oak_planks', count: 3 }, { name: 'stick', count: 2 }],
      ids: IDS,
      recipes: { wooden_pickaxe: recipeFor('wooden_pickaxe') },
      blockAtImpl: () => TABLE,
    })
    const ctx = freshCtx({ table: { x: 1, y: 64, z: 0 } })
    ctx.equip = { walkWaits: 5 }
    equip(bot, ctx, null, {})
    await flush()
    assert.equal(bot.calls.craft.length, 1)
    assert.equal(ctx.equip.walkWaits, 0, 'arrival resets the stall budget')
    bot.restoreError()
  })

  it('a table in hand without placeBlock fails no-table', async () => {
    const bot = mockBot({
      items: [
        { name: 'oak_planks', count: 3 },
        { name: 'stick', count: 2 },
        { name: 'crafting_table', count: 1 },
      ],
      ids: IDS,
      recipes: { wooden_pickaxe: recipeFor('wooden_pickaxe') },
      // Solid ground: without the placeBlock guard the scan would find a
      // cell and die calling the missing driver (revmux round-1).
      blockAtImpl: (p) => (p.y === 63
        ? { name: 'dirt', position: { x: p.x, y: p.y, z: p.z } }
        : { name: 'air' }),
    })
    delete bot.placeBlock
    const ctx = freshCtx()
    equip(bot, ctx, null, {})
    await flush()
    assert.equal(ctx.stepStatus, 'failed:equip-wooden_pickaxe')
    assert.ok(bot.errs.join(' ').includes('no-table'), `errs: ${bot.errs}`)
    bot.restoreError()
  })
})

describe('equip table-branch residuals (idkcraft-17a)', () => {
  it('no solid ground anywhere fails no-table', async () => {
    const bot = mockBot({
      items: [
        { name: 'oak_planks', count: 3 },
        { name: 'stick', count: 2 },
        { name: 'crafting_table', count: 1 },
      ],
      ids: IDS,
      recipes: { wooden_pickaxe: recipeFor('wooden_pickaxe') },
      blockAtImpl: () => null, // void below, air cells: nowhere to stand a table
    })
    const ctx = freshCtx()
    equip(bot, ctx, null, {})
    await flush()
    assert.equal(ctx.stepStatus, 'failed:equip-wooden_pickaxe')
    assert.ok(bot.errs.join(' ').includes('no-table'), `errs: ${bot.errs}`)
    assert.equal(bot.calls.placeBlock.length, 0)
    bot.restoreError()
  })

  it('a throwing hold still places the table', async () => {
    let placed = null
    const bot = mockBot({
      items: [
        { name: 'oak_planks', count: 3 },
        { name: 'stick', count: 2 },
        { name: 'crafting_table', count: 1 },
      ],
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
    bot.equip = async () => { throw new Error('hand stuck') }
    const ctx = freshCtx()
    equip(bot, ctx, null, {})
    await flush()
    assert.equal(bot.calls.placeBlock.length, 1)
    assert.equal(bot.calls.craft.length, 1, 'placement decides, not the hold')
    bot.restoreError()
  })

  it('an unreadable placed cell fails table-place', async () => {
    const bot = mockBot({
      items: [
        { name: 'oak_planks', count: 3 },
        { name: 'stick', count: 2 },
        { name: 'crafting_table', count: 1 },
      ],
      ids: IDS,
      recipes: { wooden_pickaxe: recipeFor('wooden_pickaxe') },
    })
    let reads = 0
    bot.blockAt = (p) => {
      reads++
      if (reads >= 3) throw new Error('reread gone') // below, cell, then the verify read
      if (p.y === 63) return { name: 'dirt', position: { x: p.x, y: p.y, z: p.z } }
      return { name: 'air' }
    }
    const ctx = freshCtx()
    equip(bot, ctx, null, {})
    await flush()
    assert.ok(reads >= 3, `verify read attempted, reads=${reads}`)
    assert.equal(ctx.stepStatus, 'failed:equip-wooden_pickaxe')
    assert.ok(bot.errs.join(' ').includes('table-place'), `errs: ${bot.errs}`)
    bot.restoreError()
  })

  it('an unclaimable station still crafts the tool', async () => {
    let placed = null
    const bot = mockBot({
      items: [
        { name: 'oak_planks', count: 3 },
        { name: 'stick', count: 2 },
        { name: 'crafting_table', count: 1 },
      ],
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
    Object.defineProperty(ctx, 'claimedTable', { value: undefined }) // read-only: the claim write throws
    equip(bot, ctx, null, {})
    await flush()
    assert.equal(bot.calls.craft.length, 1, 'claim failure does not fail the tool')
    assert.equal(ctx.stepStatus, 'running')
    bot.restoreError()
  })

  it('one plank plus logs converts the logs, not sticks', async () => {
    const bot = mockBot({
      items: [{ name: 'oak_planks', count: 1 }, { name: 'oak_log', count: 2 }],
      ids: IDS,
      recipes: { stick: recipeFor('stick', 4), oak_planks: recipeFor('oak_planks', 4) },
    })
    const ctx = freshCtx()
    equip(bot, ctx, null, {})
    await flush()
    assert.equal(bot.calls.craft.length, 1)
    assert.deepEqual(bot.calls.craft[0].recipe, recipeFor('oak_planks', 4))
    bot.restoreError()
  })

  it('sticks without rock or logs fail no-materials', async () => {
    const bot = mockBot({
      items: [{ name: 'stick', count: 2 }],
      ids: IDS,
      recipes: {},
    })
    const ctx = freshCtx()
    equip(bot, ctx, null, {})
    await flush()
    assert.equal(ctx.stepStatus, 'failed:equip-pickaxe')
    assert.ok(bot.errs.join(' ').includes('no-materials'), `errs: ${bot.errs}`)
    assert.equal(bot.calls.craft.length, 0)
    bot.restoreError()
  })

  it('an in-flight op blocks a second one', async () => {
    const bot = mockBot({
      items: [{ name: 'oak_planks', count: 4 }],
      ids: IDS,
      recipes: { stick: recipeFor('stick', 4) },
    })
    const ctx = freshCtx()
    ctx.equipInFlight = true
    equip(bot, ctx, null, {})
    await flush()
    assert.equal(bot.calls.craft.length, 0)
    assert.equal(ctx.stepStatus, 'running')
    bot.restoreError()
  })

  it('does nothing without a body', async () => {
    const bot = mockBot({
      items: [{ name: 'oak_planks', count: 4 }],
      ids: IDS,
      recipes: { stick: recipeFor('stick', 4) },
    })
    bot.entity = null
    const ctx = freshCtx()
    equip(bot, ctx, null, {})
    await flush()
    assert.equal(bot.calls.craft.length, 0)
    assert.equal(ctx.stepStatus, 'running', 'silent, not failed')
    bot.restoreError()
  })
})

describe('equip dig residuals (idkcraft-17a)', () => {
  it('a landed craft deletes its strike counter', async () => {
    const bot = mockBot({
      items: [{ name: 'oak_planks', count: 4 }],
      ids: IDS,
      recipes: { stick: recipeFor('stick', 4) },
    })
    bot.craft = landingCraft(bot)
    const ctx = freshCtx()
    ctx.equip = { made: { stick: 2 } }
    equip(bot, ctx, null, {})
    await flush()
    assert.equal(ctx.stepStatus, 'running')
    assert.equal(ctx.equip.made.stick, undefined, 'strikes cleared on landing')
    bot.restoreError()
  })

  it('the first dig starts the counter at one', async () => {
    const bot = mockBot({
      items: [{ name: 'stone_pickaxe', count: 1 }, { name: 'stone_sword', count: 1 }],
      ids: IDS,
      recipes: {},
      findBlocksImpl: () => [{ x: 1, y: 63, z: 0, name: 'dirt' }],
    })
    const ctx = freshCtx()
    equip(bot, ctx, null, {})
    await flush()
    await flush()
    assert.equal(bot.calls.dig.length, 1)
    assert.equal(ctx.equip.digs, 1)
    bot.restoreError()
  })

  it('sixty-four fruitless digs fail dig-stall', () => {
    const bot = mockBot({
      items: [{ name: 'stone_pickaxe', count: 1 }, { name: 'stone_sword', count: 1 }],
      ids: IDS,
      recipes: {},
      findBlocksImpl: () => [{ x: 1, y: 63, z: 0, name: 'dirt' }],
    })
    const ctx = freshCtx()
    ctx.equip = { digs: 64 }
    equip(bot, ctx, null, {})
    assert.equal(ctx.stepStatus, 'failed:equip-blocks')
    assert.ok(bot.errs.join(' ').includes('dig-stall'), `errs: ${bot.errs}`)
    assert.equal(bot.calls.dig.length, 0)
    bot.restoreError()
  })

  it('soft dirt wins over nearer stone', async () => {
    const bot = mockBot({
      items: [{ name: 'stone_pickaxe', count: 1 }, { name: 'stone_sword', count: 1 }],
      ids: IDS,
      recipes: {},
      findBlocksImpl: () => [
        { x: 1, y: 63, z: 0, name: 'stone' },
        { x: 1, y: 63, z: 1, name: 'dirt' },
      ],
    })
    const ctx = freshCtx()
    equip(bot, ctx, null, {})
    await flush()
    await flush()
    assert.equal(bot.calls.dig.length, 1)
    assert.deepEqual([bot.calls.dig[0].x, bot.calls.dig[0].name], [1, 'dirt'])
    assert.deepEqual(bot.calls.equipped, [], 'no pickaxe held for dirt')
    bot.restoreError()
  })

  it('does not re-issue the dig walk on the same key', async () => {
    const bot = mockBot({
      items: [{ name: 'stone_pickaxe', count: 1 }, { name: 'stone_sword', count: 1 }],
      ids: IDS,
      recipes: {},
      findBlocksImpl: () => [{ x: 10, y: 63, z: 0, name: 'dirt' }],
    })
    const ctx = freshCtx()
    ctx.lastGoalKey = 'equip-dig:10,63,0'
    equip(bot, ctx, null, {})
    await flush()
    assert.equal(bot.calls.setGoal, 0, 'already walking there')
    assert.equal(bot.calls.dig.length, 0)
    bot.restoreError()
  })

  it('reaching the dirt clears a piled approach wait', async () => {
    const bot = mockBot({
      items: [{ name: 'stone_pickaxe', count: 1 }, { name: 'stone_sword', count: 1 }],
      ids: IDS,
      recipes: {},
      findBlocksImpl: () => [{ x: 1, y: 63, z: 0, name: 'dirt' }],
    })
    const ctx = freshCtx()
    ctx.equip = { approachWaits: 3 }
    equip(bot, ctx, null, {})
    await flush()
    await flush()
    assert.equal(bot.calls.dig.length, 1)
    assert.equal(ctx.equip.approachWaits, 0, 'arrival resets the stall budget')
    bot.restoreError()
  })

  it('a dig already flying blocks a second one', async () => {
    let release
    const gate = new Promise((r) => { release = r })
    const bot = mockBot({
      items: [{ name: 'stone_pickaxe', count: 1 }, { name: 'stone_sword', count: 1 }],
      ids: IDS,
      recipes: {},
      findBlocksImpl: () => [{ x: 1, y: 63, z: 0, name: 'dirt' }],
      digImpl: () => gate,
    })
    const ctx = freshCtx()
    equip(bot, ctx, null, {}) // first dig starts, hangs on the gate
    await flush()
    equip(bot, ctx, null, {}) // second tick while flying: nothing new
    await flush()
    assert.equal(ctx.equip.digs, 1, 'one attempt counted')
    release()
    await flush()
    bot.restoreError()
  })

  it('no dig driver waits silently instead of failing', async () => {
    const bot = mockBot({
      items: [{ name: 'stone_pickaxe', count: 1 }, { name: 'stone_sword', count: 1 }],
      ids: IDS,
      recipes: {},
      findBlocksImpl: () => [{ x: 1, y: 63, z: 0, name: 'dirt' }],
    })
    delete bot.dig
    const ctx = freshCtx()
    equip(bot, ctx, null, {})
    await flush()
    assert.equal(ctx.stepStatus, 'running')
    assert.equal(ctx.equip.digs, 0, 'no attempt counted')
    bot.restoreError()
  })

  it('hard rock without a hold still digs', async () => {
    const bot = mockBot({
      items: [{ name: 'stone_pickaxe', count: 1 }, { name: 'stone_sword', count: 1 }],
      ids: IDS,
      recipes: {},
      findBlocksImpl: () => [{ x: 1, y: 63, z: 0, name: 'stone' }],
    })
    delete bot.equip
    const ctx = freshCtx()
    equip(bot, ctx, null, {})
    await flush()
    await flush()
    assert.equal(bot.calls.dig.length, 1)
    assert.equal(ctx.stepStatus, 'running')
    bot.restoreError()
  })

  it('the find filter runs through the mock like the driver', async () => {
    // The matching callback is a real func: a faithful findBlocks calls it.
    // A nameless hit is rejected up front even though blockAt could name it.
    const bot = mockBot({
      items: [{ name: 'stone_pickaxe', count: 1 }, { name: 'stone_sword', count: 1 }],
      ids: IDS,
      recipes: {},
      findBlocksImpl: (opts) => [{ x: 1, y: 63, z: 0 }].filter((b) => opts.matching(b)),
      blockAtImpl: () => ({ name: 'dirt' }),
    })
    const ctx = freshCtx()
    equip(bot, ctx, null, {})
    await flush()
    assert.equal(ctx.stepStatus, 'failed:equip-blocks')
    assert.ok(bot.errs.join(' ').includes('no-dirt'), `nameless hit filtered: ${bot.errs}`)
    assert.equal(bot.calls.dig.length, 0)
    bot.restoreError()
  })

  it('a hanging placement fails table-timeout on the deadline', async () => {
    const { mock } = require('node:test')
    mock.timers.enable({ apis: ['setTimeout'] })
    try {
      const bot = mockBot({
        items: [
          { name: 'oak_planks', count: 3 },
          { name: 'stick', count: 2 },
          { name: 'crafting_table', count: 1 },
        ],
        ids: IDS,
        recipes: { wooden_pickaxe: recipeFor('wooden_pickaxe') },
        blockAtImpl: (p) => {
          if (p.y === 63) return { name: 'dirt', position: { x: p.x, y: p.y, z: p.z } }
          return { name: 'air' }
        },
        placeBlockImpl: () => new Promise(() => {}), // hung placement
      })
      const ctx = freshCtx()
      equip(bot, ctx, null, {})
      mock.timers.tick(15001)
      await flush()
      assert.equal(ctx.stepStatus, 'failed:equip-wooden_pickaxe')
      assert.ok(bot.errs[0].includes('table-timeout'), `errs: ${bot.errs}`)
      bot.restoreError()
    } finally {
      mock.timers.reset()
    }
  })
})

describe('equip guard-arm residuals (idkcraft-17a batch Q)', () => {
  const KIT = [{ name: 'stone_pickaxe', count: 1 }, { name: 'stone_sword', count: 1 }]
  const PLACE_ITEMS = [
    { name: 'crafting_table', count: 1 },
    { name: 'oak_planks', count: 3 },
    { name: 'stick', count: 2 },
  ]

  it('Q01 ground without a position is skipped, no-table', async () => {
    const bot = mockBot({
      items: PLACE_ITEMS,
      ids: IDS,
      recipes: { wooden_pickaxe: recipeFor('wooden_pickaxe') },
      blockAtImpl: (p) => (p.y === 63 ? { name: 'dirt' } : { name: 'air' }),
    })
    const ctx = freshCtx()
    equip(bot, ctx, null, {})
    await flush()
    await flush()
    assert.equal(ctx.stepStatus, 'failed:equip-wooden_pickaxe')
    assert.ok(bot.errs[0].includes('no-table'), `errs: ${bot.errs}`)
    assert.equal(bot.calls.placeBlock.length, 0)
    bot.restoreError()
  })

  it('Q02 ground without a name is skipped, no-table', async () => {
    const bot = mockBot({
      items: PLACE_ITEMS,
      ids: IDS,
      recipes: { wooden_pickaxe: recipeFor('wooden_pickaxe') },
      blockAtImpl: (p) => (p.y === 63 ? { position: { x: p.x, y: p.y, z: p.z } } : { name: 'air' }),
    })
    const ctx = freshCtx()
    equip(bot, ctx, null, {})
    await flush()
    await flush()
    assert.equal(ctx.stepStatus, 'failed:equip-wooden_pickaxe')
    assert.ok(bot.errs[0].includes('no-table'), `errs: ${bot.errs}`)
    assert.equal(bot.calls.placeBlock.length, 0)
    bot.restoreError()
  })

  it('Q03 air ground is skipped, no-table', async () => {
    const bot = mockBot({
      items: PLACE_ITEMS,
      ids: IDS,
      recipes: { wooden_pickaxe: recipeFor('wooden_pickaxe') },
      blockAtImpl: (p) => (p.y === 63
        ? { name: 'air', position: { x: p.x, y: p.y, z: p.z } }
        : { name: 'air' }),
    })
    const ctx = freshCtx()
    equip(bot, ctx, null, {})
    await flush()
    await flush()
    assert.equal(ctx.stepStatus, 'failed:equip-wooden_pickaxe')
    assert.ok(bot.errs[0].includes('no-table'), `errs: ${bot.errs}`)
    assert.equal(bot.calls.placeBlock.length, 0)
    bot.restoreError()
  })

  it('Q04 occupied cells are skipped, no-table', async () => {
    const bot = mockBot({
      items: PLACE_ITEMS,
      ids: IDS,
      recipes: { wooden_pickaxe: recipeFor('wooden_pickaxe') },
      blockAtImpl: (p) => ({ name: 'stone', position: { x: p.x, y: p.y, z: p.z } }),
    })
    const ctx = freshCtx()
    equip(bot, ctx, null, {})
    await flush()
    await flush()
    assert.equal(ctx.stepStatus, 'failed:equip-wooden_pickaxe')
    assert.ok(bot.errs[0].includes('no-table'), `errs: ${bot.errs}`)
    assert.equal(bot.calls.placeBlock.length, 0)
    bot.restoreError()
  })

  it('Q05 a cell without a name reads free, placement attempted', async () => {
    const bot = mockBot({
      items: PLACE_ITEMS,
      ids: IDS,
      recipes: { wooden_pickaxe: recipeFor('wooden_pickaxe') },
      blockAtImpl: (p) => (p.y === 63
        ? { name: 'dirt', position: { x: p.x, y: p.y, z: p.z } }
        : {}),
    })
    const ctx = freshCtx()
    equip(bot, ctx, null, {})
    await flush()
    await flush()
    // Free cell, placed, but the reread finds no table: table-place, not no-table.
    assert.equal(ctx.stepStatus, 'failed:equip-wooden_pickaxe')
    assert.ok(bot.errs[0].includes('table-place'), `errs: ${bot.errs}`)
    assert.equal(bot.calls.placeBlock.length, 1)
    bot.restoreError()
  })

  it('Q06 null scan hits are skipped, no-dirt', async () => {
    const bot = mockBot({ items: KIT, ids: IDS, recipes: {}, findBlocksImpl: () => [null] })
    const ctx = freshCtx()
    equip(bot, ctx, null, {})
    await flush()
    assert.equal(ctx.stepStatus, 'failed:equip-blocks')
    assert.ok(bot.errs[0].includes('no-dirt'), `errs: ${bot.errs}`)
    bot.restoreError()
  })

  it('Q07 a hit without x is skipped even when named, no-dirt', async () => {
    const bot = mockBot({
      items: KIT,
      ids: IDS,
      recipes: {},
      findBlocksImpl: () => [{ y: 63, z: 0, name: 'dirt' }],
    })
    const ctx = freshCtx()
    equip(bot, ctx, null, {})
    await flush()
    assert.equal(ctx.stepStatus, 'failed:equip-blocks')
    assert.ok(bot.errs[0].includes('no-dirt'), `errs: ${bot.errs}`)
    assert.equal(bot.calls.dig.length, 0)
    bot.restoreError()
  })

  it('Q08 a throwing blockAt degrades the hit to no-dirt', async () => {
    const bot = mockBot({
      items: KIT,
      ids: IDS,
      recipes: {},
      findBlocksImpl: () => [{ x: 1, y: 63, z: 0 }],
      blockAtImpl: () => { throw new Error('chunk not loaded') },
    })
    const ctx = freshCtx()
    equip(bot, ctx, null, {})
    await flush()
    assert.equal(ctx.stepStatus, 'failed:equip-blocks')
    assert.ok(bot.errs[0].includes('no-dirt'), `errs: ${bot.errs}`)
    assert.equal(bot.calls.dig.length, 0)
    bot.restoreError()
  })

  it('Q09 a named non-target hit is skipped, no-dirt', async () => {
    const bot = mockBot({
      items: KIT,
      ids: IDS,
      recipes: {},
      findBlocksImpl: () => [{ x: 1, y: 63, z: 0, name: 'sand' }],
    })
    const ctx = freshCtx()
    equip(bot, ctx, null, {})
    await flush()
    assert.equal(ctx.stepStatus, 'failed:equip-blocks')
    assert.ok(bot.errs[0].includes('no-dirt'), `errs: ${bot.errs}`)
    assert.equal(bot.calls.dig.length, 0)
    bot.restoreError()
  })

  it('Q11 a missing pathfinder waits silently instead of throwing', async () => {
    const bot = mockBot({
      items: KIT,
      ids: IDS,
      recipes: {},
      findBlocksImpl: () => [{ x: 10, y: 63, z: 0, name: 'dirt' }],
    })
    bot.pathfinder = null
    const ctx = freshCtx()
    assert.doesNotThrow(() => equip(bot, ctx, null, {}))
    await flush()
    assert.equal(ctx.stepStatus, 'running')
    assert.equal(ctx.equip.approachWaits, 1)
    assert.equal(bot.calls.setGoal, 0)
    bot.restoreError()
  })

  it('Q12 a missing pathfinder waits silently on the table walk', async () => {
    const bot = mockBot({
      items: [{ name: 'oak_planks', count: 3 }, { name: 'stick', count: 2 }],
      ids: IDS,
      recipes: { wooden_pickaxe: recipeFor('wooden_pickaxe') },
      blockAtImpl: () => TABLE,
    })
    bot.pathfinder = null
    const ctx = freshCtx({ table: { x: 20, y: 64, z: 0 } })
    assert.doesNotThrow(() => equip(bot, ctx, null, {}))
    await flush()
    await flush()
    assert.equal(ctx.stepStatus, 'running')
    assert.equal(ctx.equip.walkWaits, 1)
    assert.equal(bot.calls.setGoal, 0)
    bot.restoreError()
  })

  it('Q14 a throwing scan degrades to no-dirt', async () => {
    const bot = mockBot({
      items: KIT,
      ids: IDS,
      recipes: {},
      findBlocksImpl: () => { throw new Error('scan failed') },
    })
    const ctx = freshCtx()
    equip(bot, ctx, null, {})
    await flush()
    assert.equal(ctx.stepStatus, 'failed:equip-blocks')
    assert.ok(bot.errs[0].includes('no-dirt'), `errs: ${bot.errs}`)
    bot.restoreError()
  })

  it('Q15 a null scan degrades to no-dirt', async () => {
    const bot = mockBot({ items: KIT, ids: IDS, recipes: {}, findBlocksImpl: () => null })
    const ctx = freshCtx()
    equip(bot, ctx, null, {})
    await flush()
    assert.equal(ctx.stepStatus, 'failed:equip-blocks')
    assert.ok(bot.errs[0].includes('no-dirt'), `errs: ${bot.errs}`)
    bot.restoreError()
  })

  it('Q16 a rejected placement fails with the raw error', async () => {
    const bot = mockBot({
      items: PLACE_ITEMS,
      ids: IDS,
      recipes: { wooden_pickaxe: recipeFor('wooden_pickaxe') },
      blockAtImpl: (p) => (p.y === 63
        ? { name: 'dirt', position: { x: p.x, y: p.y, z: p.z } }
        : { name: 'air' }),
      placeBlockImpl: async () => { throw new Error('placement rejected') },
    })
    const ctx = freshCtx()
    equip(bot, ctx, null, {})
    await flush()
    await flush()
    assert.equal(ctx.stepStatus, 'failed:equip-wooden_pickaxe')
    assert.ok(bot.errs[0].includes('placement rejected'), `errs: ${bot.errs}`)
    bot.restoreError()
  })

  it('Q17 two planks fall short of the rock, no-materials (rock-short line)', async () => {
    const bot = mockBot({
      items: [{ name: 'oak_planks', count: 2 }, { name: 'stick', count: 2 }],
      ids: IDS,
      recipes: {},
    })
    const ctx = freshCtx()
    equip(bot, ctx, null, {})
    await flush()
    assert.equal(bot.calls.craft.length, 0)
    assert.equal(ctx.stepStatus, 'failed:equip-pickaxe')
    assert.match(bot.errs[0], /error=no-materials$/, `errs: ${bot.errs}`)
    bot.restoreError()
  })

  it('Q18 a craft resolving after the deadline settles exactly once', async () => {
    const { mock } = require('node:test')
    mock.timers.enable({ apis: ['setTimeout'] })
    try {
      let release = null
      const bot = mockBot({
        items: [{ name: 'oak_planks', count: 4 }],
        ids: IDS,
        recipes: { stick: recipeFor('stick', 4) },
        craftImpl: () => new Promise((_, reject) => { release = reject }),
      })
      const ctx = freshCtx()
      equip(bot, ctx, null, {})
      mock.timers.tick(30001)
      await flush()
      assert.equal(ctx.stepStatus, 'failed:equip-stick')
      assert.equal(bot.errs.length, 1)
      release(new Error('late window error'))
      await flush()
      await flush()
      assert.equal(bot.errs.length, 1, `second settlement must be a no-op: ${bot.errs}`)
      assert.equal(ctx.stepStatus, 'failed:equip-stick')
      bot.restoreError()
    } finally {
      mock.timers.reset()
    }
  })

  it('Q-sort1 two dirts dig the nearer one', async () => {
    const bot = mockBot({
      items: KIT,
      ids: IDS,
      recipes: {},
      findBlocksImpl: () => [
        { x: 10, y: 63, z: 0, name: 'dirt' },
        { x: 1, y: 63, z: 0, name: 'dirt' },
      ],
    })
    const ctx = freshCtx()
    equip(bot, ctx, null, {})
    await flush()
    await flush()
    assert.equal(bot.calls.dig.length, 1)
    assert.equal(bot.calls.dig[0].x, 1, `dug: ${JSON.stringify(bot.calls.dig)}`)
    bot.restoreError()
  })


})

describe('equip reset/fail residuals (idkcraft-17a batch R)', () => {
  const KIT = [{ name: 'stone_pickaxe', count: 1 }, { name: 'stone_sword', count: 1 }]

  it('R-frozen a frozen counter block still fails the step instead of throwing', async () => {
    const bot = mockBot({ items: [], ids: IDS, recipes: {} })
    const ctx = freshCtx()
    ctx.equip = Object.freeze({ digs: 1 })
    assert.doesNotThrow(() => equip(bot, ctx, null, {}))
    await flush()
    assert.equal(ctx.stepStatus, 'failed:equip-pickaxe')
    assert.ok(bot.errs[0].includes('no-materials'), `errs: ${bot.errs}`)
    bot.restoreError()
  })

  it('R-nullitem a null inventory slot does not break the table hunt', async () => {
    let placed = null
    const bot = mockBot({
      items: [null, { name: 'crafting_table', count: 1 }, { name: 'oak_planks', count: 3 }, { name: 'stick', count: 2 }],
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
    assert.doesNotThrow(() => equip(bot, ctx, null, {}))
    await flush()
    await flush()
    assert.equal(bot.calls.craft.length, 1, `errs: ${bot.errs}`)
    bot.restoreError()
  })

  it('R-twice a landed dig clears the flight flag, the next tick digs again', async () => {
    const bot = mockBot({
      items: KIT,
      ids: IDS,
      recipes: {},
      findBlocksImpl: () => [{ x: 1, y: 63, z: 0, name: 'dirt' }],
    })
    const ctx = freshCtx()
    equip(bot, ctx, null, {})
    await flush()
    await flush()
    assert.equal(bot.calls.dig.length, 1)
    equip(bot, ctx, null, {})
    await flush()
    await flush()
    assert.equal(bot.calls.dig.length, 2, 'second tick must dig, not stall in-flight')
    assert.equal(ctx.stepStatus, 'running')
    bot.restoreError()
  })

  it('R-holdthrow a throwing hold fails the blocks loudly', async () => {
    const bot = mockBot({
      items: KIT,
      ids: IDS,
      recipes: {},
      findBlocksImpl: () => [{ x: 1, y: 63, z: 0, name: 'stone' }],
    })
    bot.equip = async () => { throw new Error('hand stuck') }
    const ctx = freshCtx()
    equip(bot, ctx, null, {})
    await flush()
    await flush()
    assert.equal(ctx.stepStatus, 'failed:equip-blocks')
    assert.ok(bot.errs[0].includes('hand stuck'), `errs: ${bot.errs}`)
    bot.restoreError()
  })

  it('R-nullerr a null craft error still logs the failure', async () => {
    const bot = mockBot({
      items: [{ name: 'oak_planks', count: 4 }],
      ids: IDS,
      recipes: { stick: recipeFor('stick', 4) },
      craftImpl: async () => { throw null },
    })
    const ctx = freshCtx()
    equip(bot, ctx, null, {})
    await flush()
    assert.equal(ctx.stepStatus, 'failed:equip-stick')
    assert.equal(bot.errs.length, 1)
    assert.ok(bot.errs[0].includes('error=null'), `errs: ${bot.errs}`)
    bot.restoreError()
  })

  it('R-ststring a non-object counter block is replaced, the dig proceeds', async () => {
    const bot = mockBot({
      items: KIT,
      ids: IDS,
      recipes: {},
      findBlocksImpl: () => [{ x: 1, y: 63, z: 0, name: 'dirt' }],
    })
    const ctx = freshCtx()
    ctx.equip = 'stale'
    assert.doesNotThrow(() => equip(bot, ctx, null, {}))
    await flush()
    await flush()
    assert.equal(bot.calls.dig.length, 1)
    assert.equal(typeof ctx.equip, 'object')
    bot.restoreError()
  })

  it('R-chatthrow a throwing chat does not fail a landed craft', async () => {
    const bot = mockBot({
      items: [{ name: 'oak_planks', count: 4 }],
      ids: IDS,
      recipes: { stick: recipeFor('stick', 4) },
    })
    bot.craft = landingCraft(bot)
    bot.chat = () => { throw new Error('chat dead') }
    const ctx = freshCtx()
    assert.doesNotThrow(() => equip(bot, ctx, null, {}))
    await flush()
    await flush()
    assert.equal(ctx.stepStatus, 'running', `errs: ${bot.errs}`)
    assert.equal(bot.errs.length, 0)
    bot.restoreError()
  })
})

describe('equip place/dig guard residuals (idkcraft-17a batch S)', () => {
  const KIT = [{ name: 'stone_pickaxe', count: 1 }, { name: 'stone_sword', count: 1 }]

  it('S-noblockat ghost station plus no lookup fails no-table, never throws', async () => {
    const bot = mockBot({
      items: [{ name: 'crafting_table', count: 1 }, { name: 'oak_planks', count: 3 }, { name: 'stick', count: 2 }],
      ids: IDS,
      recipes: { wooden_pickaxe: recipeFor('wooden_pickaxe') },
    })
    delete bot.blockAt
    const ctx = freshCtx({ table: { x: 1, y: 64, z: 0 } })
    assert.doesNotThrow(() => equip(bot, ctx, null, {}))
    await flush()
    await flush()
    assert.equal(ctx.stepStatus, 'failed:equip-wooden_pickaxe')
    assert.ok(bot.errs[0].includes('no-table'), `errs: ${bot.errs}`)
    bot.restoreError()
  })

  it('S-noblockat-dig a nameless hit without lookup degrades to no-dirt', async () => {
    const bot = mockBot({
      items: KIT,
      ids: IDS,
      recipes: {},
      findBlocksImpl: () => [{ x: 1, y: 63, z: 0 }],
    })
    delete bot.blockAt
    const ctx = freshCtx()
    assert.doesNotThrow(() => equip(bot, ctx, null, {}))
    await flush()
    assert.equal(ctx.stepStatus, 'failed:equip-blocks')
    assert.ok(bot.errs[0].includes('no-dirt'), `errs: ${bot.errs}`)
    bot.restoreError()
  })

  it('S-claimfrozen an unclaimable station still crafts when counters froze', async () => {
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
    ctx.equip = Object.freeze({})
    assert.doesNotThrow(() => equip(bot, ctx, null, {}))
    await flush()
    await flush()
    assert.equal(bot.calls.craft.length, 1, `errs: ${bot.errs}`)
    bot.restoreError()
  })

  it('S-retract a ghost claim is retracted so craft rebuilds', async () => {
    // h9z: the ghost must be VERIFIED (air block) — a null read is an
    // unloaded chunk, unknown, and the claim is kept (see the kept-claim
    // test in table-ghost.test.js).
    const bot = mockBot({
      items: [{ name: 'oak_planks', count: 3 }, { name: 'stick', count: 2 }],
      ids: IDS,
      recipes: { wooden_pickaxe: recipeFor('wooden_pickaxe') },
      blockAtImpl: () => ({ name: 'air' }),
    })
    const ctx = freshCtx()
    ctx.claimedTable = { x: 9, y: 63, z: 9 }
    equip(bot, ctx, null, {})
    await flush()
    await flush()
    assert.equal(ctx.stepStatus, 'failed:equip-wooden_pickaxe')
    assert.equal(ctx.claimedTable, undefined, 'lying claim must be retracted')
    bot.restoreError()
  })

  it('S-pfshape a pathfinder without setGoal waits silently on the table walk', async () => {
    const bot = mockBot({
      items: [{ name: 'oak_planks', count: 3 }, { name: 'stick', count: 2 }],
      ids: IDS,
      recipes: { wooden_pickaxe: recipeFor('wooden_pickaxe') },
      blockAtImpl: () => TABLE,
    })
    bot.pathfinder = {}
    const ctx = freshCtx({ table: { x: 20, y: 64, z: 0 } })
    assert.doesNotThrow(() => equip(bot, ctx, null, {}))
    await flush()
    await flush()
    assert.equal(ctx.stepStatus, 'running')
    assert.equal(ctx.equip.walkWaits, 1)
    bot.restoreError()
  })

  it('S-pfshape-dig a pathfinder without setGoal waits silently on the approach', async () => {
    const bot = mockBot({
      items: KIT,
      ids: IDS,
      recipes: {},
      findBlocksImpl: () => [{ x: 10, y: 63, z: 0, name: 'dirt' }],
    })
    bot.pathfinder = {}
    const ctx = freshCtx()
    assert.doesNotThrow(() => equip(bot, ctx, null, {}))
    await flush()
    assert.equal(ctx.stepStatus, 'running')
    assert.equal(ctx.equip.approachWaits, 1)
    bot.restoreError()
  })

  it('S-noholdfn stone without a hold driver still digs', async () => {
    const bot = mockBot({
      items: KIT,
      ids: IDS,
      recipes: {},
      findBlocksImpl: () => [{ x: 1, y: 63, z: 0, name: 'stone' }],
    })
    delete bot.equip
    const ctx = freshCtx()
    assert.doesNotThrow(() => equip(bot, ctx, null, {}))
    await flush()
    await flush()
    assert.equal(bot.calls.dig.length, 1)
    assert.equal(ctx.stepStatus, 'running')
    bot.restoreError()
  })
})

// NOTE (idkcraft-17a mutant review): the following source mutants survive the
// suite and are equivalent, not coverage gaps — verified by probing, not by
// inspection alone:
// - dig naming `if (blk)` for `if (blk && typeof ...)`: a nameless block
//   reads as undefined, and the `!name` filter below skips it either way.
// - craftOne's inner safeCraft try/catch: dropping it rejects run(), and the
//   race catch fails identically — deliberate defense in depth.
// - craftOne's chat/equipGear try/catches: post-finish throws already die on
//   the settled guard via the race catch; the tries are belt and suspenders.
//   R-chatthrow pins the behaviour (a dead chat never fails a landed craft).
// - tableFor's `!bp` arm: equip checks bp first, so tableFor never sees null.
// - home-without-table (`if (ctx.home)`): pushing undefined reads through
//   the guarded blockAt the same as skipping.
// - `st.digs == null` vs `=== undefined`: null inits to 0 either way
//   (`null >= 64` is false, `null++` lands on 1).
// - `if (!op)`: toolOp never returns null (stale comment aside).
// - (round-1: the `if (held)` guard is NOT equivalent — live mineflayer
//   throws on equip(undefined). The mock hold driver mirrors that, and the
//   flaky-held test kills the dropped-guard mutant.)
// - `else if (st.made)` vs bare `else`: the guarded delete no-ops on
//   undefined either way.
// - timeout `t &&`: setTimeout always returns an object.
// - place-run `typeof bot.equip` guard, table-scan `bot.blockAt &&` guard,
//   dig-naming `bot.blockAt` guard, L136 `!bot.blockAt`: each is absorbed by
//   the try/catch around its use (S-noblockat* pin the behaviour).
// - tableFor's st-init and resetRunCounters' guards: equip normalises
//   ctx.equip first, so the false arms are unreachable via the step.
