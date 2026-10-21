'use strict'

// idkcraft-qxql.12: the work step 'bank' walks to the castle chest and
// deposits the castle kinds carried above the kit keep. Never withdraws,
// never digs/chops.

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const bank = require('../src/behaviours/bank')
const goal = require('../src/goal')
const llmOrders = require('../src/llm-orders')
const { STEP_EFFECT_TEXT, STEP_ORDER } = require('../src/plan-consts')
require('../src/index') // BEHAVIOURS registration (goal.registered)

const SITE = { x: 0, y: 64, z: 0 }
const AT = { x: 0, y: 64, z: 0 }

function pos(x, y, z) {
  return { x, y, z, distanceTo: (q) => Math.hypot(x - q.x, y - q.y, z - q.z) }
}

const IDS = {}
function idOf(name) { return IDS[name] || (IDS[name] = Object.keys(IDS).length + 1) }

function mockBot({ inv = [], at = pos(1, 64, 0), chest = true, chestCap = Infinity, openErr = false } = {}) {
  const store = {}
  let takes = 0
  const pathfinder = { goals: [], setGoal(g) { this.goals.push(g) }, isMoving: () => false }
  const itemsByName = new Proxy({}, { get: (_, n) => (typeof n === 'string' ? { id: idOf(n) } : undefined) })
  const bot = {
    inv, store, pathfinder,
    entity: { position: at },
    registry: { blocksByName: { chest: { id: 7 } }, itemsByName },
    inventory: { items: () => inv.filter((i) => i.count > 0) },
    blockAt: (p) => {
      const x = Math.floor(p.x); const y = Math.floor(p.y); const z = Math.floor(p.z)
      if (chest && x === AT.x && y === AT.y && z === AT.z) return { name: 'chest' }
      return { name: 'air' }
    },
    findBlocks: () => (chest ? [{ ...AT }] : []),
    chat: () => {},
    openChest: async () => {
      if (openErr) throw new Error('lag')
      return chestWindow
    },
  }
  const chestWindow = {
    close() {},
    containerItems: () => [],
    async deposit(type, _meta, count) {
      if (takes >= chestCap) throw new Error('full')
      let left = count
      for (const i of inv) {
        if (left <= 0) break
        if (i.type !== type || !(i.count > 0)) continue
        const k = Math.min(i.count, left)
        i.count -= k
        left -= k
        store[i.name] = (store[i.name] || 0) + k
      }
      takes++
    },
  }
  for (const i of inv) i.type = idOf(i.name)
  return bot
}

const ctxWithCastle = (over = {}) => ({
  castle: { site: { ...SITE }, phase: 'body' },
  ...over,
})

function packCount(bot, name) {
  return bot.inv.filter((i) => i.name === name).reduce((a, i) => a + i.count, 0)
}

async function bankRun(bot, ctx) {
  bank(bot, ctx)
  bank(bot, ctx)
  await new Promise((r) => setImmediate(r))
  await new Promise((r) => setImmediate(r))
}

describe('bank keep math (idkcraft-qxql.12)', () => {
  it('keeps the kit: 64 planks, 14 logs, 88 stone, 16 stairs/torch', () => {
    const k = bank.keeps()
    assert.equal(k.planks, 64)
    assert.equal(k.logs, 14)
    assert.equal(k.stone, 88)
    assert.equal(k.stairs, 16)
    assert.equal(k.torch, 16)
  })

  it('surplus is empty at exactly the keep', () => {
    const bot = mockBot({ inv: [
      { name: 'oak_planks', count: 64 },
      { name: 'oak_log', count: 14 },
      { name: 'cobblestone', count: 88 },
      { name: 'cobblestone_stairs', count: 16 },
      { name: 'torch', count: 16 },
    ] })
    assert.deepEqual(bank.surplus(bot, ctxWithCastle()), [])
  })

  it('surplus lists what is carried above the keep', () => {
    const bot = mockBot({ inv: [
      { name: 'oak_planks', count: 70 },
      { name: 'oak_log', count: 20 },
      { name: 'cobblestone', count: 100 },
      { name: 'cobblestone_stairs', count: 20 },
      { name: 'torch', count: 18 },
    ] })
    assert.deepEqual(bank.surplus(bot, ctxWithCastle()), [
      { name: 'oak_planks', count: 6 },
      { name: 'oak_log', count: 6 },
      { name: 'cobblestone', count: 12 },
      { name: 'cobblestone_stairs', count: 4 },
      { name: 'torch', count: 2 },
    ])
  })

  it('deposit-only: never lists tools, food or dirt', () => {
    const bot = mockBot({ inv: [
      { name: 'stone_pickaxe', count: 1 },
      { name: 'bread', count: 12 },
      { name: 'dirt', count: 64 },
      { name: 'oak_door', count: 3 },
    ] })
    assert.deepEqual(bank.surplus(bot, ctxWithCastle()), [])
  })
})

describe('bank behaviour (idkcraft-qxql.12)', () => {
  it('failed:no-chest with no castle chest on the site', async () => {
    const bot = mockBot({ inv: [{ name: 'cobblestone', count: 100 }], chest: false })
    const ctx = ctxWithCastle()
    await bankRun(bot, ctx)
    assert.equal(ctx.stepStatus, 'failed:no-chest')
  })

  it('done with an empty surplus (nothing to move)', async () => {
    const bot = mockBot({ inv: [{ name: 'cobblestone', count: 10 }] })
    const ctx = ctxWithCastle()
    await bankRun(bot, ctx)
    assert.equal(ctx.stepStatus, 'done')
    assert.deepEqual(bot.store, {})
  })

  it('opens the castle chest and deposits the surplus, keeps the kit', async () => {
    const bot = mockBot({ inv: [
      { name: 'cobblestone', count: 100 },
      { name: 'oak_planks', count: 70 },
    ] })
    const ctx = ctxWithCastle()
    await bankRun(bot, ctx)
    assert.equal(ctx.stepStatus, 'done')
    assert.equal(bot.store.cobblestone, 12)
    assert.equal(bot.store.oak_planks, 6)
    assert.equal(packCount(bot, 'cobblestone'), 88)
    assert.equal(packCount(bot, 'oak_planks'), 64)
  })

  it('failed:chest-full when nothing fits', async () => {
    const bot = mockBot({ inv: [{ name: 'cobblestone', count: 100 }], chestCap: 0 })
    const ctx = ctxWithCastle()
    await bankRun(bot, ctx)
    assert.equal(ctx.stepStatus, 'failed:chest-full')
  })

  it('a blocked lid fails chest-full, never withdraws', async () => {
    const bot = mockBot({ inv: [{ name: 'cobblestone', count: 100 }], openErr: true })
    const ctx = ctxWithCastle()
    await bankRun(bot, ctx)
    assert.equal(ctx.stepStatus, 'failed:chest-full')
    assert.equal(packCount(bot, 'cobblestone'), 100)
  })
})

describe('bank goal menu (idkcraft-qxql.12)', () => {
  const facts = (over = {}) => ({
    time: 'day', health: 20, food: 20, castle: 'stone-some',
    ...over,
  })

  it('MENU.bank needs day, an active castle, a known chest and a surplus', () => {
    const rich = mockBot({ inv: [{ name: 'cobblestone', count: 100 }] })
    const poor = mockBot({ inv: [{ name: 'cobblestone', count: 10 }] })
    const ctx = ctxWithCastle()
    assert.equal(goal.MENU.bank.feasible(facts(), rich, ctx), true)
    assert.equal(goal.MENU.bank.feasible(facts({ time: 'night' }), rich, ctx), false)
    assert.equal(goal.MENU.bank.feasible(facts({ castle: 'none' }), rich, ctx), false)
    assert.equal(goal.MENU.bank.feasible(facts({ castle: 'done' }), rich, ctx), false)
    assert.equal(goal.MENU.bank.feasible(facts(), poor, ctx), false, 'at the keep: nothing to bank')
    assert.equal(goal.MENU.bank.feasible(facts(), rich, { castle: { site: { ...SITE }, phase: 'complete' } }), false)
    const blind = mockBot({ inv: [{ name: 'cobblestone', count: 100 }], chest: false })
    assert.equal(goal.MENU.bank.feasible(facts(), blind, ctx), false, 'no chest: no bank')
  })

  it('menu text: effect, criteria and why lines', () => {
    assert.equal(
      STEP_EFFECT_TEXT.bank,
      'walks to the castle chest and deposits the castle kinds it carries above its kit keep'
    )
    assert.match(goal.STEP_CRITERIA.bank, /bank the surplus/)
    const bot = mockBot({ inv: [{ name: 'cobblestone', count: 10 }] })
    assert.match(
      goal.stepWhy('bank', facts(), bot, ctxWithCastle(), 'time=day'),
      /nothing above the kit keep/
    )
    assert.match(
      goal.stepWhy('bank', facts({ time: 'night' }), bot, ctxWithCastle(), 'time=night'),
      /daytime job/
    )
  })

  it('STEP_ORDER puts bank after castle, and the chooser whitelists it', () => {
    assert.ok(STEP_ORDER.indexOf('bank') > STEP_ORDER.indexOf('castle'))
    assert.ok(llmOrders.WORK_STEPS.includes('bank'))
    assert.ok(llmOrders.workSteps().includes('bank'), 'registered MENU step joins workSteps()')
    assert.ok(goal.registered('bank'))
  })
})
