'use strict'

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const craft = require('../src/behaviours/craft')

function pos(x, y, z) {
  return { x, y, z }
}

// registry names -> ids; recipes: { itemName: recipe | null }; craftImpl: async fn
function mockBot({ items = [], ids = {}, recipes = {}, craftImpl = null } = {}) {
  const lines = []
  const errs = []
  const itemsByName = {}
  for (const [name, id] of Object.entries(ids)) itemsByName[name] = { id }
  const calls = { craft: [], setGoal: 0, goals: [] }
  const bot = {
    lines,
    errs,
    calls,
    _items: items,
    entity: { position: pos(0, 64, 0) },
    registry: { itemsByName },
    inventory: { items: () => bot._items },
    recipesFor: (id) => {
      const name = Object.keys(ids).find((n) => ids[n] === id)
      if (!(name in recipes)) throw new Error(`unexpected recipesFor(${name})`)
      const r = recipes[name]
      return r ? [r] : []
    },
    craft: craftImpl || (async (recipe, count, table) => { calls.craft.push({ recipe, count, table }) }),
    blockAt: () => null,
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

const IDS = { oak_log: 17, oak_planks: 18, crafting_table: 58, oak_door: 19 }
const recipeFor = (name) => ({ result: { name, count: 1 } })

function freshCtx(home) {
  return { lastGoalKey: '', stepStatus: 'running', home: home || null }
}

async function flush() {
  await new Promise((resolve) => setImmediate(resolve))
  await new Promise((resolve) => setImmediate(resolve))
}

describe('craft step', () => {
  it('(a) 3 logs -> planks recipe with count=3', async () => {
    const bot = mockBot({
      items: [{ name: 'oak_log', count: 3 }],
      ids: IDS,
      recipes: { oak_planks: recipeFor('oak_planks') },
    })
    const ctx = freshCtx()
    craft(bot, ctx, null, {})
    await flush()
    assert.equal(bot.calls.craft.length, 1)
    assert.deepEqual(bot.calls.craft[0].recipe, recipeFor('oak_planks'))
    assert.equal(bot.calls.craft[0].count, 3)
    assert.equal(bot.calls.craft[0].table, null)
    assert.equal(ctx.stepStatus, 'running')
    bot.restoreError()
  })

  it('(b) 4 planks and no table -> crafting table', async () => {
    const bot = mockBot({
      items: [{ name: 'oak_planks', count: 4 }],
      ids: IDS,
      recipes: { crafting_table: recipeFor('crafting_table') },
    })
    const ctx = freshCtx()
    craft(bot, ctx, null, {})
    await flush()
    assert.equal(bot.calls.craft.length, 1)
    assert.deepEqual(bot.calls.craft[0].recipe, recipeFor('crafting_table'))
    assert.equal(bot.calls.craft[0].count, 1)
    bot.restoreError()
  })

  it('(c) door crafts only at a table block in reach, else GoalNear', async () => {
    const tablePos = pos(2, 64, 0)
    const mk = (at) => {
      const bot = mockBot({
        items: [{ name: 'oak_planks', count: 6 }],
        ids: IDS,
        recipes: { oak_door: recipeFor('oak_door') },
      })
      bot.entity.position = pos(at, 64, 0)
      bot.blockAt = () => ({ name: 'crafting_table' })
      return bot
    }
    // near (dist 2): crafts with the table block
    const near = mk(0)
    craft(near, freshCtx({ table: tablePos }), null, {})
    await flush()
    assert.equal(near.calls.craft.length, 1)
    assert.deepEqual(near.calls.craft[0].recipe, recipeFor('oak_door'))
    assert.deepEqual(near.calls.craft[0].table, { name: 'crafting_table' })
    assert.equal(near.calls.setGoal, 0)
    near.restoreError()
    // far (dist 10): walks, does not craft
    const far = mk(10)
    const farCtx = freshCtx({ table: tablePos })
    craft(far, farCtx, null, {})
    await flush()
    assert.equal(far.calls.craft.length, 0)
    assert.equal(far.calls.setGoal, 1)
    assert.equal(far.calls.goals[0].constructor.name, 'GoalNear')
    assert.match(farCtx.lastGoalKey, /^craft-table:2,64,0$/)
    far.restoreError()
  })

  it('(d) nothing to craft -> done', () => {
    const bot = mockBot({ items: [], ids: IDS, recipes: {} })
    const ctx = freshCtx()
    craft(bot, ctx, null, {})
    assert.equal(ctx.stepStatus, 'done')
    assert.equal(bot.calls.craft.length, 0)
    bot.restoreError()
  })

  it('(e) one craft at a time while the previous is in flight', async () => {
    let release = null
    const bot = mockBot({
      items: [{ name: 'oak_log', count: 3 }],
      ids: IDS,
      recipes: { oak_planks: recipeFor('oak_planks') },
    })
    bot.craft = () => new Promise((resolve) => { release = resolve })
    const ctx = freshCtx()
    craft(bot, ctx, null, {})
    craft(bot, ctx, null, {})
    craft(bot, ctx, null, {})
    release()
    await flush()
    assert.equal(ctx.craftInFlight, false)
    bot.restoreError()
  })

  it('craft error -> failed:craft-<item> + error log line', async () => {
    const bot = mockBot({
      items: [{ name: 'oak_log', count: 3 }],
      ids: IDS,
      recipes: { oak_planks: recipeFor('oak_planks') },
    })
    bot.craft = async () => { throw new Error('window jammed') }
    const ctx = freshCtx()
    craft(bot, ctx, null, {})
    await flush()
    assert.equal(ctx.stepStatus, 'failed:craft-oak_planks')
    assert.equal(bot.errs.length, 1)
    assert.match(bot.errs[0], /^craft failed item=oak_planks error=window jammed$/)
    bot.restoreError()
  })

  it('registers in BEHAVIOURS under craft', () => {
    const { BEHAVIOURS } = require('../src/index')
    assert.equal(BEHAVIOURS.craft, craft)
  })
})
