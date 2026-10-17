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

  it('a bank chest past the task radius is never walked to', () => {
    word('stone')
    const bot = makeBot({ items: [{ name: 'stone_pickaxe', count: 1 }], chests: { '100,64,170': [{ name: 'cobblestone', count: 400 }] }, at: pos(300.5, 64, 400.5) })
    const ctx = ctxFor()
    fetch(bot, ctx)
    assert.notEqual(ctx.lastGoalKey, 'castlefetch-chest:100,64,170')
  })
})
