'use strict'

// Chest search (owner 2026-11-12): a hungry v2 body with no meal and no chest
// with hope goes looking (bounded radius + time, cooldown after); a chest seen
// on the way is remembered and the food leg then targets it.
const { it, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const Vec3 = require('vec3')
const { BaritoneBot } = require('../src/bridge')
const { FakeTransport } = require('../src/bridge/transport')
const goal = require('../src/goal')
const chestsearch = require('../src/behaviours/chestsearch')
const foodRecovery = require('../src/behaviours/food-recovery')
const bring = require('../src/behaviours/bring')
const { makeScout } = require('../src/behaviours/scout')
const { BEHAVIOURS } = require('../src/index')

const registry = { blocksByName: { air: { id: 0 }, chest: { id: 54 }, trapped_chest: { id: 146 }, barrel: { id: 900 } }, entitiesByName: {} }
let prevBody
beforeEach(() => { prevBody = process.env.BOT_BODY; process.env.BOT_BODY = 'baritone' })
afterEach(() => { if (prevBody === undefined) delete process.env.BOT_BODY; else process.env.BOT_BODY = prevBody })

async function world(chests) {
  const transport = new FakeTransport({ health: 20, food: 4, inventory: [{ slot: 11, name: 'dirt', count: 32 }], entities: [] })
  const bot = new BaritoneBot(transport, { Vec3, registry, username: 'IdkBody' })
  await bot.start({ pollMs: 0 })
  bot.time = { timeOfDay: 1000, isDay: true }
  // Loaded-chunk scan stand-in: chests within maxDistance of the bot, nearest first.
  bot.findBlocks = ({ maxDistance, count }) => {
    const p = bot.entity.position
    return chests.map((c) => new Vec3(c.x, c.y, c.z)).filter((c) => c.distanceTo(p) <= maxDistance)
      .sort((a, b) => a.distanceTo(p) - b.distanceTo(p)).slice(0, count)
  }
  const ctx = { home: { built: true, site: { x: 0, y: 64, z: 0 } }, stepStatus: 'running', sitebed: { deadDay: 0 } }
  return { bot, ctx, transport }
}

it('hungry, no meal, no known chest: decide picks the chest search', async () => {
  const { bot, ctx } = await world([])
  try {
    assert.equal((await goal.decide(bot, ctx)).action, 'chestSearch')
  } finally { await bot.stop() }
})

it('a chest sighted during the search is remembered, the search ends, the food leg targets it', async () => {
  const chests = []
  const { bot, ctx } = await world(chests)
  try {
    assert.equal((await goal.decide(bot, ctx)).action, 'chestSearch')
    BEHAVIOURS.chestSearch(bot, ctx)
    assert.ok(ctx.chestSearch, 'leg running')
    const p = bot.entity.position
    chests.push({ x: Math.floor(p.x) + 10, y: Math.floor(p.y), z: Math.floor(p.z) }) // walks into view
    BEHAVIOURS.chestSearch(bot, ctx)
    assert.equal(ctx.stepStatus, 'done')
    assert.equal(ctx.chests.length, 1)
    const pick = bring.pickChest(bot, ctx, { wants: (n) => n === 'bread', chestSeen: [], maxChestDistance: 32 })
    assert.deepEqual([pick.pos.x, pick.pos.z], [chests[0].x, chests[0].z])
    assert.equal(foodRecovery.available(bot, ctx, { time: 'day', health: 20, food: 4 }), true, 'the hungry chest leg now has a target')
  } finally { await bot.stop() }
})

it('bounded: times out after the budget, stays inside the radius, and the cooldown blocks a second search', async () => {
  const { bot, ctx } = await world([])
  try {
    assert.equal((await goal.decide(bot, ctx)).action, 'chestSearch')
    BEHAVIOURS.chestSearch(bot, ctx)
    const t = ctx.chestSearch.target
    assert.ok(Math.hypot(t.x, t.z) <= chestsearch.RADIUS, 'leg target within the radius')
    ctx.chestSearch.at -= chestsearch.BUDGET_MS + 1
    BEHAVIOURS.chestSearch(bot, ctx)
    assert.equal(ctx.stepStatus, 'failed:timeout')
    assert.ok(ctx.chestSearchRetryAt - Date.now() > chestsearch.COOLDOWN_MS - 1000)
    assert.notEqual((await goal.decide(bot, ctx)).action, 'chestSearch', 'cooldown: no second search')
  } finally { await bot.stop() }
})

it('the needy scout scan sees a chest at 40 blocks that the 16-block scan misses', async () => {
  const { bot, ctx } = await world([{ x: 40, y: 64, z: 0 }])
  try {
    bot.food = 20
    const calm = makeScout(bot, { ctx, now: () => 0, everyMs: 0 })
    calm.tick()
    assert.equal((ctx.chests || []).length, 0, '16-block scan misses it')
    bot.food = 4
    const needy = makeScout(bot, { ctx, now: () => 1e9, everyMs: 0 })
    needy.tick()
    assert.equal(ctx.chests.length, 1)
  } finally { await bot.stop() }
})
