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
const recipeFor = (name, count = 1) => ({ result: { name, count } })

function freshCtx(home) {
  return { lastGoalKey: '', stepStatus: 'running', home: home || null }
}

async function flush() {
  await new Promise((resolve) => setImmediate(resolve))
  await new Promise((resolve) => setImmediate(resolve))
}

// xg9: paced batches take real time (60 ms/op); poll for N craft calls.
async function untilCrafts(bot, n, timeoutMs = 8000) {
  const t0 = Date.now()
  while (bot.calls.craft.length < n) {
    if (Date.now() - t0 > timeoutMs) throw new Error(`craft calls stuck at ${bot.calls.craft.length}, want ${n}`)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  await flush()
}

async function untilCount(get, n, timeoutMs = 8000) {
  const t0 = Date.now()
  while (get() < n) {
    if (Date.now() - t0 > timeoutMs) throw new Error(`count stuck at ${get()}, want ${n}`)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  await flush()
}

describe('craft step', () => {
  it('(a) 3 logs -> batched single-log planks calls, one chat with the total', async () => {
    const bot = mockBot({
      items: [{ name: 'oak_log', count: 3 }],
      ids: IDS,
      recipes: { oak_planks: recipeFor('oak_planks', 4) },
    })
    const ctx = freshCtx()
    craft(bot, ctx, null, {})
    await untilCrafts(bot, 3)
    assert.equal(bot.calls.craft.length, 3) // the batch loops count=1 calls
    for (const c of bot.calls.craft) {
      assert.deepEqual(c.recipe, recipeFor('oak_planks', 4))
      assert.equal(c.count, 1)
      assert.equal(c.table, null)
    }
    assert.equal(ctx.stepStatus, 'running')
    // 3 repetitions x 4 planks: items, not repetitions (mock inventory is static)
    assert.deepEqual(bot.lines, ['crafted 12 oak_planks (planks 0, logs 3)'])
    bot.restoreError()
  })

  it('logs beat planks: 3 logs + 4 planks still crafts planks first', async () => {
    const bot = mockBot({
      items: [{ name: 'oak_log', count: 3 }, { name: 'oak_planks', count: 4 }],
      ids: IDS,
      recipes: { oak_planks: recipeFor('oak_planks', 4), crafting_table: recipeFor('crafting_table') },
    })
    const ctx = freshCtx()
    craft(bot, ctx, null, {})
    await untilCrafts(bot, 3)
    assert.equal(bot.calls.craft.length, 3) // batch of 3, all planks (never the table)
    for (const c of bot.calls.craft) assert.deepEqual(c.recipe, recipeFor('oak_planks', 4))
    bot.restoreError()
  })

  it('recipe-less logs fail loudly instead of done-churn', async () => {
    const bot = mockBot({
      items: [{ name: 'stripped_oak_log', count: 14 }],
      ids: { ...IDS, stripped_oak_log: 21 },
      recipes: {},
    })
    const ctx = freshCtx()
    craft(bot, ctx, null, {})
    await flush()
    assert.equal(bot.calls.craft.length, 0)
    assert.equal(ctx.stepStatus, 'failed:craft-stripped_oak_planks')
    assert.equal(bot.errs.length, 1)
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

  it('(c2) claimed station crafts the door; ghost claim rebuilds', async () => {
    // atl.6: the equip step's placed table doubles for the door branch, and
    // a mined (ghost) claim reads as no station so the table branch heals.
    const doorBot = mockBot({
      items: [{ name: 'oak_planks', count: 6 }],
      ids: IDS,
      recipes: { oak_door: recipeFor('oak_door') },
    })
    doorBot.blockAt = () => ({ name: 'crafting_table' })
    const doorCtx = freshCtx()
    doorCtx.claimedTable = { x: 1, y: 64, z: 0 }
    craft(doorBot, doorCtx, null, {})
    await flush()
    assert.equal(doorBot.calls.craft.length, 1)
    assert.deepEqual(doorBot.calls.craft[0].recipe, recipeFor('oak_door'))
    doorBot.restoreError()
    const ghostBot = mockBot({
      items: [{ name: 'oak_planks', count: 4 }],
      ids: IDS,
      recipes: { crafting_table: recipeFor('crafting_table') },
    })
    ghostBot.blockAt = () => ({ name: 'air' })
    const ghostCtx = freshCtx()
    ghostCtx.claimedTable = { x: 1, y: 64, z: 0 }
    craft(ghostBot, ghostCtx, null, {})
    await flush()
    assert.equal(ghostBot.calls.craft.length, 1)
    assert.deepEqual(ghostBot.calls.craft[0].recipe, recipeFor('crafting_table'))
    assert.equal(ghostBot.calls.setGoal, 0) // rebuilds, never walks to the ghost
    ghostBot.restoreError()
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
    let calls = 0
    bot.craft = () => new Promise((resolve) => { calls++; release = resolve })
    const ctx = freshCtx()
    craft(bot, ctx, null, {})
    craft(bot, ctx, null, {})
    craft(bot, ctx, null, {})
    await flush() // let the 1st op start (the safeCraft pre-clear yields first)
    assert.equal(calls, 1) // the 2nd and 3rd calls wait on the in-flight guard
    release() // batch of 3: release once per iteration
    await flush()
    assert.equal(ctx.craftInFlight, true) // held between iterations (round-2)
    craft(bot, ctx, null, {}) // a re-entrant tick must not start a second op
    await untilCount(() => calls, 2)
    assert.equal(calls, 2) // only the loop's own next iteration
    release()
    await untilCount(() => calls, 3) // op 3 starts after the pace gap
    release()
    await flush()
    assert.equal(calls, 3)
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

describe('craft edges (idkcraft-l71)', () => {
  it('throwing recipesFor reads as no recipes', () => {
    const bot = mockBot({ ids: { stick: 1 }, recipes: {} })
    bot.recipesFor = () => { throw new Error('registry busy') }
    assert.deepEqual(craft.recipes(bot, 'stick', null), [])
    bot.restoreError()
  })

  it('missing bot.craft fails the op instead of throwing', async () => {
    const bot = mockBot({
      items: [{ name: 'oak_log', count: 3 }],
      ids: IDS,
      recipes: { oak_planks: recipeFor('oak_planks', 4) },
    })
    delete bot.craft
    const ctx = freshCtx()
    craft(bot, ctx, null, {})
    await flush()
    assert.equal(ctx.stepStatus, 'failed:craft-oak_planks')
    assert.ok(bot.errs[0].includes('bot.craft missing'), `errs: ${bot.errs}`)
    bot.restoreError()
  })
})

describe('craft decision residuals (idkcraft-zaw)', () => {
  it('bigger wood stack crafts first; ties break alphabetical', async () => {
    const bot = mockBot({
      items: [{ name: 'oak_log', count: 2 }, { name: 'birch_log', count: 5 }],
      ids: { oak_planks: 18, birch_planks: 181 },
      recipes: { oak_planks: recipeFor('oak_planks'), birch_planks: recipeFor('birch_planks') },
    })
    craft(bot, freshCtx(), null, {})
    await untilCrafts(bot, 7) // 8cx: both woods convert in one step, birch first
    assert.equal(bot.calls.craft.length, 7)
    assert.ok(bot.lines.join(' ').match(/crafted 5 birch_planks.*crafted 2 oak_planks/))
    bot.restoreError()
    const tie = mockBot({
      items: [{ name: 'oak_log', count: 3 }, { name: 'birch_log', count: 3 }],
      ids: { oak_planks: 18, birch_planks: 181 },
      recipes: { oak_planks: recipeFor('oak_planks'), birch_planks: recipeFor('birch_planks') },
    })
    craft(tie, freshCtx(), null, {})
    await untilCrafts(tie, 3)
    assert.ok(tie.lines.join(' ').match(/crafted 3 birch_planks/), 'tie: birch before oak')
    tie.restoreError()
  })

  it('a throwing inventory reads as empty and finishes done', async () => {
    const bot = mockBot({ items: [{ name: 'oak_log', count: 3 }], ids: IDS, recipes: {} })
    bot.inventory.items = () => { throw new Error('no window') }
    const ctx = freshCtx()
    assert.doesNotThrow(() => craft(bot, ctx, null, {}))
    await flush()
    assert.equal(ctx.stepStatus, 'done')
    assert.equal(bot.calls.craft.length, 0)
    bot.restoreError()
  })

  it('does nothing without a body', async () => {
    const bot = mockBot({
      items: [{ name: 'oak_log', count: 3 }],
      ids: IDS,
      recipes: { oak_planks: recipeFor('oak_planks') },
    })
    bot.entity = null
    const ctx = freshCtx()
    craft(bot, ctx, null, {})
    await flush()
    await flush()
    assert.equal(bot.calls.craft.length, 0)
    assert.equal(bot.calls.setGoal, 0)
    assert.equal(ctx.craftInFlight, undefined, 'no op started')
    bot.restoreError()
  })

  it('a throwing table lookup rebuilds like a ghost claim', async () => {
    const bot = mockBot({
      items: [{ name: 'oak_planks', count: 4 }],
      ids: IDS,
      recipes: { crafting_table: recipeFor('crafting_table') },
    })
    bot.blockAt = () => { throw new Error('chunk gone') }
    const ctx = freshCtx()
    ctx.claimedTable = { x: 1, y: 64, z: 0 }
    craft(bot, ctx, null, {})
    await flush()
    assert.equal(bot.calls.craft.length, 1)
    assert.deepEqual(bot.calls.craft[0].recipe, recipeFor('crafting_table'))
    bot.restoreError()
  })

  it('fewer than 4 planks never starts a table', async () => {
    const bot = mockBot({
      items: [{ name: 'oak_planks', count: 3 }],
      ids: IDS,
      recipes: { crafting_table: recipeFor('crafting_table') },
    })
    const ctx = freshCtx()
    craft(bot, ctx, null, {})
    await flush()
    assert.equal(ctx.stepStatus, 'done')
    assert.equal(bot.calls.craft.length, 0)
    bot.restoreError()
  })

  it('does not re-issue the table walk on the same key', async () => {
    const bot = mockBot({
      items: [{ name: 'oak_planks', count: 6 }],
      ids: IDS,
      recipes: { oak_door: recipeFor('oak_door') },
    })
    bot.entity.position = pos(10, 64, 0)
    bot.blockAt = () => ({ name: 'crafting_table' })
    const ctx = freshCtx({ table: pos(2, 64, 0) })
    ctx.lastGoalKey = 'craft-table:2,64,0'
    craft(bot, ctx, null, {})
    await flush()
    assert.equal(bot.calls.setGoal, 0, 'already walking there')
    assert.equal(bot.calls.craft.length, 0)
    bot.restoreError()
  })

  it('fewer than 6 planks at the table never starts a door', () => {
    const bot = mockBot({
      items: [{ name: 'oak_planks', count: 5 }],
      ids: IDS,
      recipes: { oak_door: recipeFor('oak_door') },
    })
    bot.blockAt = () => ({ name: 'crafting_table' })
    const ctx = freshCtx({ table: pos(2, 64, 0) })
    craft(bot, ctx, null, {})
    assert.equal(ctx.stepStatus, 'done')
    assert.equal(bot.calls.craft.length, 0)
    bot.restoreError()
  })
})

describe('craft op residuals (idkcraft-zaw)', () => {
  it('a recipe without a result count reports one per op', async () => {
    const bot = mockBot({
      items: [{ name: 'oak_log', count: 3 }],
      ids: IDS,
      recipes: { oak_planks: {} },
    })
    craft(bot, freshCtx(), null, {})
    await untilCrafts(bot, 3)
    assert.equal(bot.calls.craft.length, 3)
    assert.ok(bot.lines.join(' ').match(/crafted 3 oak_planks/))
    bot.restoreError()
  })

  it('a throwing chat still completes the op without a rejection', async () => {
    const bot = mockBot({
      items: [{ name: 'oak_log', count: 3 }],
      ids: IDS,
      recipes: { oak_planks: recipeFor('oak_planks') },
    })
    bot.chat = () => { throw new Error('muted') }
    const ctx = freshCtx()
    let rejected = null
    const onRej = (err) => { rejected = err }
    process.on('unhandledRejection', onRej)
    try {
      craft(bot, ctx, null, {})
      await untilCrafts(bot, 3)
    } finally {
      process.removeListener('unhandledRejection', onRej)
    }
    assert.equal(bot.calls.craft.length, 3)
    assert.equal(ctx.craftInFlight, false)
    assert.equal(rejected, null, 'chat throw swallowed, nothing rejects')
    bot.restoreError()
  })

  it('a message-less craft error still logs the failure', async () => {
    const bot = mockBot({
      items: [{ name: 'oak_log', count: 3 }],
      ids: IDS,
      recipes: { oak_planks: recipeFor('oak_planks') },
      craftImpl: async () => { throw ({ code: 'ESTRAND' }) },
    })
    const ctx = freshCtx()
    craft(bot, ctx, null, {})
    await flush()
    assert.equal(ctx.stepStatus, 'failed:craft-oak_planks')
    assert.ok(bot.errs.join(' ').includes('[object Object]'), `raw err logged: ${bot.errs.join('|')}`)
    bot.restoreError()
  })

  it('a failing error log never throws out of the step', () => {
    const bot = mockBot({
      items: [{ name: 'stripped_oak_log', count: 14 }],
      ids: { ...IDS, stripped_oak_log: 21 },
      recipes: {},
    })
    console.error = () => { throw new Error('log sink gone') }
    const ctx = freshCtx()
    try {
      assert.doesNotThrow(() => craft(bot, ctx, null, {}))
    } finally {
      bot.restoreError()
    }
    assert.equal(ctx.stepStatus, 'failed:craft-stripped_oak_planks')
  })

  it('a null recipe list reads as no recipes', async () => {
    const bot = mockBot({
      items: [{ name: 'oak_log', count: 3 }],
      ids: IDS,
      recipes: { oak_planks: recipeFor('oak_planks') },
    })
    bot.recipesFor = () => null
    const ctx = freshCtx()
    craft(bot, ctx, null, {})
    await flush()
    assert.equal(ctx.stepStatus, 'done')
    assert.equal(bot.calls.craft.length, 0)
    bot.restoreError()
  })

  it('a non-numeric registry id reads as no recipe', async () => {
    const bot = mockBot({
      items: [{ name: 'oak_log', count: 3 }],
      ids: { oak_planks: 'eighteen' },
      recipes: { oak_planks: recipeFor('oak_planks') },
    })
    const ctx = freshCtx()
    craft(bot, ctx, null, {})
    await flush()
    assert.equal(ctx.stepStatus, 'done')
    assert.equal(bot.calls.craft.length, 0)
    bot.restoreError()
  })

  it('count-less stacks tally as one each', async () => {
    const bot = mockBot({
      items: [{ name: 'oak_log' }, { name: 'oak_log' }, { name: 'oak_log' }],
      ids: IDS,
      recipes: { oak_planks: recipeFor('oak_planks') },
    })
    craft(bot, freshCtx(), null, {})
    await untilCrafts(bot, 3)
    assert.equal(bot.calls.craft.length, 3)
    assert.ok(bot.lines.join(' ').match(/crafted 3 oak_planks/))
    bot.restoreError()
  })

  it('a door without a recipe is skipped, not failed', () => {
    const bot = mockBot({
      items: [{ name: 'oak_planks', count: 6 }],
      ids: {},
      recipes: {},
    })
    bot.blockAt = () => ({ name: 'crafting_table' })
    const ctx = freshCtx({ table: pos(2, 64, 0) })
    craft(bot, ctx, null, {})
    assert.equal(ctx.stepStatus, 'done')
    assert.equal(bot.calls.craft.length, 0)
    bot.restoreError()
  })

  it('a placed table suppresses a second table build', async () => {
    const bot = mockBot({
      items: [{ name: 'oak_planks', count: 4 }],
      ids: IDS,
      recipes: { crafting_table: recipeFor('crafting_table') },
    })
    bot.blockAt = () => ({ name: 'crafting_table' })
    const ctx = freshCtx({ table: pos(2, 64, 0) })
    craft(bot, ctx, null, {})
    await flush()
    assert.equal(ctx.stepStatus, 'done')
    assert.equal(bot.calls.craft.length, 0, 'no duplicate table')
    bot.restoreError()
  })

  it('a table in hand suppresses a second table build', async () => {
    const bot = mockBot({
      items: [{ name: 'oak_planks', count: 4 }, { name: 'crafting_table', count: 1 }],
      ids: IDS,
      recipes: { crafting_table: recipeFor('crafting_table') },
    })
    const ctx = freshCtx()
    craft(bot, ctx, null, {})
    await flush()
    assert.equal(ctx.stepStatus, 'done')
    assert.equal(bot.calls.craft.length, 0, 'no duplicate table')
    bot.restoreError()
  })

  it('a door in hand suppresses a second door build', () => {
    const bot = mockBot({
      items: [{ name: 'oak_planks', count: 6 }, { name: 'oak_door', count: 1 }],
      ids: IDS,
      recipes: { oak_door: recipeFor('oak_door') },
    })
    bot.blockAt = () => ({ name: 'crafting_table' })
    const ctx = freshCtx({ table: pos(2, 64, 0) })
    craft(bot, ctx, null, {})
    assert.equal(ctx.stepStatus, 'done')
    assert.equal(bot.calls.craft.length, 0, 'no duplicate door')
    bot.restoreError()
  })

  it('an unreadable grid sizes the batch from visible stock only', async () => {
    const bot = mockBot({
      items: [{ name: 'oak_log', count: 3 }],
      ids: IDS,
      recipes: { oak_planks: recipeFor('oak_planks') },
    })
    const slots = new Array(46).fill(null)
    Object.defineProperty(slots, '1', { get() { throw new Error('slot gone') } })
    bot.inventory = { slots, items: () => bot._items, selectedItem: null }
    craft(bot, freshCtx(), null, {})
    await untilCrafts(bot, 3)
    assert.equal(bot.calls.craft.length, 3, 'no stranded bonus, no throw')
    assert.ok(bot.lines.join(' ').match(/crafted 3 oak_planks/))
    bot.restoreError()
  })
})

describe('craft stranded residuals (idkcraft-zaw)', () => {
  // NOTE: no clickWindow-missing test: without it the per-slot click throws
  // into the same per-kind catch (:125) that a silent server hits, so the
  // :118 guard is an equivalent mutant. No putSelected-missing test either:
  // the call throws into the cursor catch (:117), same outcome as the skip.
  it('count-less stranded stacks size the batch as one each', async () => {
    const bot = mockBot({
      items: [{ name: 'oak_log', count: 1 }],
      ids: IDS,
      recipes: { oak_planks: recipeFor('oak_planks') },
    })
    const slots = new Array(46).fill(null)
    slots[1] = { name: 'oak_log' }
    bot.inventory = { slots, items: () => bot._items, selectedItem: { name: 'oak_log' } }
    bot.clickWindow = async (slot) => { bot.inventory.slots[slot] = null }
    craft(bot, freshCtx(), null, {})
    await untilCrafts(bot, 3)
    assert.equal(bot.calls.craft.length, 3, '1 visible + grid 1 + cursor 1')
    assert.ok(bot.lines.join(' ').match(/crafted 3 oak_planks/))
    bot.restoreError()
  })
})
