'use strict'

// idkcraft-g0z.60: castlefetch reads the chests stockpile banks castle
// stock into (ctx.home.chest, ctx.castle.siteChest) before any dig; a
// drained bank chest is dry for the kind for 10 min; a bank batch never
// overshoots stockpile's castle keep (no deposit<->withdraw ping-pong).

const { describe, it, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const fetch = require('../src/behaviours/castlefetch')
const castleMod = require('../src/behaviours/castle')
const stockpileMod = require('../src/behaviours/stockpile')

const IDS = { chest: 2, stone: 1 }
const settle = () => new Promise((r) => setImmediate(r))

function pos(x, y, z) {
  const p = { x, y, z, distanceTo: (q) => Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z), clone: () => pos(x, y, z), floored: () => pos(Math.floor(x), Math.floor(y), Math.floor(z)), offset: (a, b, c) => pos(x + a, y + b, z + c) }
  return p
}

// `chests`: "x,y,z" -> stacks; no chest in the castle footprint, no stone.
// The ht8l.test.js makeBot shape. Each stub mirrors the real API:
// - bot.openChest(block) -> Promise<Chest>: mineflayer lib/plugins/chest.js
//   (openChest = openContainer). Chest.containerItems() -> Item[] with
//   { type, count, metadata, name }.
// - Chest.withdraw(itemType, metadata, count): mineflayer
//   lib/plugins/inventory.js transfer(). It moves count items into the pack
//   and throws "Can't find <item> in slots" once the source runs dry. The
//   stub moves count with no check: stockpile.withdrawAnyFromChest never
//   asks for more than a containerItems() stack holds.
// - bot.findBlocks(options) -> Vec3[] (mineflayer index.d.ts): always [],
//   so there is no footprint chest and no stone in range.
// - bot.pathfinder.setGoal(goal) / isMoving() (mineflayer-pathfinder
//   index.d.ts): records the goal, never moves. Tests teleport
//   entity.position to stand in reach.
function makeBot({ items, chests, at }) {
  const blocksByName = {}
  for (const [n, id] of Object.entries(IDS)) blocksByName[n] = { id }
  const calls = { goals: [], opens: [], dig: 0, mine: 0 }
  const bot = {
    calls,
    entity: { position: at, onGround: true },
    inventory: { items: () => items.filter((i) => i.count > 0), emptySlotCount: () => 36 - items.length },
    registry: { blocksByName, itemsByName: { oak_log: {}, oak_planks: {}, cobblestone: {}, stone_pickaxe: {} } },
    time: { timeOfDay: 6000, day: 1 },
    players: {},
    chat() {},
    blockAt: (p) => {
      const k = `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`
      const name = chests[k] ? 'chest' : (Math.floor(p.y) <= 63 ? 'dirt' : 'air')
      return { name, position: pos(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)), boundingBox: name === 'air' ? 'empty' : 'block' }
    },
    findBlocks: () => [],
    openChest: async (block) => {
      const k = `${block.position.x},${block.position.y},${block.position.z}`
      calls.opens.push(k)
      const stacks = chests[k]
      return {
        containerItems: () => stacks.filter((s) => s.count > 0).map((s) => ({ ...s, type: s.name, metadata: null })),
        withdraw: async (type, meta, n) => {
          stacks.find((s) => s.name === type).count -= n
          const it = items.find((i) => i.name === type)
          if (it) it.count += n
          else items.push({ name: type, count: n })
        },
        close() {},
      }
    },
    canDigBlock: () => true,
    dig: async () => { calls.dig++ },
    mine: async () => { calls.mine++ },
    equip: async () => {},
    pathfinder: { goal: null, isMoving: () => false, setGoal(g) { calls.goals.push(g); bot.pathfinder.goal = g }, stop() {}, setMovements() {}, movements: null },
    clearControlStates() {},
    on() {},
    once() {},
  }
  return bot
}
const count = (bot, name) => bot.inventory.items().filter((i) => i.name === name).reduce((a, i) => a + i.count, 0)
const SITE = { x: 100, y: 64, z: 200 }
const HOME_CHEST = pos(100, 64, 170) // 30 blocks off the castle
const ctxFor = (extra = {}) => ({
  lastGoalKey: '',
  home: { site: pos(100, 64, 168), built: true, chest: HOME_CHEST },
  castle: { site: { ...SITE }, rot: 0, blueprintVersion: 2, phase: 'body', blocked: {}, parked: false },
  ...extra,
})

describe('castlefetch draws the bank chests (g0z.60)', () => {
  const realFact = castleMod.menuFact
  const realBody = process.env.BOT_BODY
  afterEach(() => {
    castleMod.menuFact = realFact
    if (realBody === undefined) delete process.env.BOT_BODY
    else process.env.BOT_BODY = realBody
  })
  const word = (kind) => { castleMod.menuFact = (bot, ctx) => { ctx.castleWord = { kind, left: 400 }; return `${kind}-none` } }

  for (const body of ['mineflayer', 'baritone']) {
    it(`${body}: stone leg walks to the home chest, withdraws, ends done before any dig`, async () => {
      process.env.BOT_BODY = body
      word('stone')
      const chests = { '100,64,170': [{ name: 'cobblestone', count: 400 }] }
      const items = [{ name: 'cobblestone', count: 64 }, { name: 'stone_pickaxe', count: 1 }]
      const bot = makeBot({ items, chests, at: pos(100.5, 64, 200.5) })
      const ctx = ctxFor()
      fetch(bot, ctx)
      assert.equal(ctx.lastGoalKey, 'castlefetch-chest:100,64,170', 'walks to the home chest')
      bot.entity.position = pos(100.5, 64, 171.5)
      fetch(bot, ctx)
      await settle(); await settle(); await settle()
      assert.deepEqual(bot.calls.opens, ['100,64,170'])
      assert.equal(count(bot, 'cobblestone'), 88, 'one batch, up to the castle keep (STONE_KEEP)')
      fetch(bot, ctx)
      assert.equal(ctx.stepStatus, 'done')
      assert.equal(bot.calls.dig + bot.calls.mine, 0, 'never dug')
      // No ping-pong: stockpile's plan banks none of the withdrawn stone.
      const plan = stockpileMod.depositPlan(bot, ctx)
      assert.equal(plan.filter((p) => p.name === 'cobblestone').reduce((a, p) => a + p.count, 0), 0)
    })
  }

  it('planks leg draws the castle site chest', async () => {
    word('planks')
    const chests = { '110,64,190': [{ name: 'oak_planks', count: 100 }] }
    const items = []
    const bot = makeBot({ items, chests, at: pos(110.5, 64, 191.5) })
    const ctx = ctxFor({ home: { site: pos(-500, 64, 0), built: true, chest: null } })
    ctx.castle.siteChest = pos(110, 64, 190)
    fetch(bot, ctx)
    await settle(); await settle(); await settle()
    assert.deepEqual(bot.calls.opens, ['110,64,190'])
    assert.equal(count(bot, 'oak_planks'), 34)
    fetch(bot, ctx)
    assert.equal(ctx.stepStatus, 'done')
  })

  it('an empty home chest: one draw, dry mark, falls through; the next leg does not walk back', async () => {
    word('stone')
    const chests = { '100,64,170': [] }
    const items = [{ name: 'stone_pickaxe', count: 1 }]
    const bot = makeBot({ items, chests, at: pos(100.5, 64, 171.5) })
    const ctx = ctxFor()
    fetch(bot, ctx)
    await settle(); await settle()
    assert.deepEqual(bot.calls.opens, ['100,64,170'])
    assert.equal(typeof ctx.castleChestDry['stone@100,64,170'], 'number')
    fetch(bot, ctx) // no candidate left: the dig source runs
    assert.ok(ctx.castleFetch == null || ctx.castleFetch.chestDone)
    ctx.castleFetch = null // a fresh leg inside the dry window
    ctx.stepStatus = undefined
    fetch(bot, ctx)
    await settle()
    assert.equal(bot.calls.opens.length, 1, 'the dry chest is not reopened')
    assert.notEqual(ctx.lastGoalKey, 'castlefetch-chest:100,64,170')
  })

  // Acceptance 2 (fake harness): the owner's gift banked in the home chest
  // feeds leg after leg — each leg draws one batch, the castle lays it, the
  // chest drains, nothing digs, and stockpile never re-banks a batch.
  for (const body of ['mineflayer', 'baritone']) {
    it(`${body}: bank-and-lay cycles drain the home chest without a dig`, async () => {
      process.env.BOT_BODY = body
      word('stone')
      const chests = { '100,64,170': [{ name: 'cobblestone', count: 480 }] }
      const items = [{ name: 'cobblestone', count: 0 }, { name: 'stone_pickaxe', count: 1 }]
      const bot = makeBot({ items, chests, at: pos(100.5, 64, 171.5) })
      const ctx = ctxFor()
      let laid = 0
      const stock = () => chests['100,64,170'][0].count
      for (let leg = 0; leg < 5; leg++) {
        const before = stock()
        ctx.stepStatus = undefined
        for (let t = 0; t < 6 && ctx.stepStatus !== 'done'; t++) {
          fetch(bot, ctx)
          await settle(); await settle(); await settle()
        }
        assert.equal(ctx.stepStatus, 'done', `leg ${leg} ends done`)
        assert.ok(stock() < before, `leg ${leg} drew from the home chest`)
        const plan = stockpileMod.depositPlan(bot, ctx)
        assert.equal(plan.filter((p) => p.name === 'cobblestone').length, 0, `leg ${leg}: nothing banks back`)
        // The castle lays down to its reserve.
        const c = items.find((i) => i.name === 'cobblestone')
        laid += c.count - castleMod.reserveOf('stone')
        c.count = castleMod.reserveOf('stone')
      }
      assert.equal(bot.calls.dig + bot.calls.mine, 0, 'never dug')
      assert.ok(laid >= 5 * 64, `laid ${laid} from the bank`)
      assert.ok(stock() < 480 - 5 * 64, 'the home chest drains')
    })
  }

  it('a full bank batch never walks on to the second bank chest', async () => {
    word('stone')
    const chests = { '100,64,170': [{ name: 'cobblestone', count: 400 }], '101,64,170': [{ name: 'cobblestone', count: 400 }] }
    const bot = makeBot({ items: [{ name: 'stone_pickaxe', count: 1 }], chests, at: pos(100.5, 64, 171.5) })
    const ctx = ctxFor()
    ctx.castle.siteChest = pos(101, 64, 170)
    fetch(bot, ctx)
    await settle(); await settle(); await settle()
    fetch(bot, ctx)
    assert.equal(ctx.stepStatus, 'done')
    assert.equal(bot.calls.opens.length, 1)
  })

  it('stockpile re-arms the dry marks only on a castle-material bank', () => {
    const ctx = ctxFor()
    ctx.castleChestDry = { 'stone@100,64,170': Date.now() }
    stockpileMod.rearmCastleDraw(ctx, ['64 coal', '32 dirt'])
    assert.ok(ctx.castleChestDry, 'coal/dirt keep the mark')
    stockpileMod.rearmCastleDraw(ctx, ['64 cobblestone'])
    assert.equal(ctx.castleChestDry, null)
  })

  it('a bank chest past the task radius is never walked to', () => {
    word('stone')
    const bot = makeBot({ items: [{ name: 'stone_pickaxe', count: 1 }], chests: { '100,64,170': [{ name: 'cobblestone', count: 400 }] }, at: pos(300.5, 64, 400.5) })
    const ctx = ctxFor()
    fetch(bot, ctx)
    assert.notEqual(ctx.lastGoalKey, 'castlefetch-chest:100,64,170')
  })
})
