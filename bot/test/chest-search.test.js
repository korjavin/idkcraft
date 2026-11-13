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

it('near death (0.29 hp, food 0), no chest/bread/animal: the search runs, not a hung foodRecovery', async () => {
  const { bot, ctx, transport } = await world([])
  try {
    transport.state.health = 0.29; transport.state.food = 0
    bot.health = 0.29; bot.food = 0
    assert.equal((await goal.decide(bot, ctx)).action, 'chestSearch')
  } finally { await bot.stop() }
})

it('a found chest whose walk then fails (failAt) is not found again: the next search starts at once', async () => {
  const chests = []
  const { bot, ctx } = await world(chests)
  try {
    await goal.decide(bot, ctx)
    BEHAVIOURS.chestSearch(bot, ctx)
    const p = bot.entity.position
    chests.push({ x: Math.floor(p.x) + 10, y: Math.floor(p.y), z: Math.floor(p.z) })
    BEHAVIOURS.chestSearch(bot, ctx)
    assert.equal(ctx.stepStatus, 'done')
    assert.ok(!ctx.chestSearchRetryAt, 'found: no cooldown')
    require('../src/behaviours/stockpile').markChestFailed(ctx, chests[0]) // the food leg's walk failed
    assert.equal(chestsearch.available(bot, ctx, { time: 'day', health: 20 }), true, 'failed chest has no hope: search again')
    ctx.step = 'chestSearch'; ctx.stepStatus = 'running'; ctx.chestSearch = null
    BEHAVIOURS.chestSearch(bot, ctx)
    assert.equal(ctx.stepStatus, 'running', 'the failed chest does not end the search as found')
  } finally { await bot.stop() }
})

it('a remembered barrel opens through withChest (not dropped as gone)', async () => {
  const { withChest } = require('../src/behaviours/packroom')
  const ctx = { chests: [{ x: 1, y: 64, z: 0 }] }
  const bot = { blockAt: () => ({ name: 'barrel' }), openChest: async () => ({ containerItems: () => [{ name: 'bread', count: 3 }], close() {} }) }
  const res = await withChest(bot, ctx, async (w) => w.containerItems().length, { x: 1, y: 64, z: 0 })
  assert.equal(res.status, 'ok')
  assert.equal(ctx.chests.length, 1)
})

// Whole loop (source ladder: near chest -> hunt -> chest search), real decide + behaviour ticks.
const cowAt = (p) => ({ id: 7, uuid: '22222222-2222-2222-2222-222222222222', type: 'cow', displayName: 'Cow', kind: 'animal', pos: { x: p.x + 3, y: p.y, z: p.z }, vel: { x: 0, y: 0, z: 0 }, yaw: 0, pitch: 0, health: 20, onGround: true, pose: 'standing' })
async function loopWorld(chests, chestItems) {
  const w = await world(chests)
  registry.entitiesByName.cow = { height: 1.4, width: 0.9, type: 'animal' }
  const blockAt = w.bot.blockAt.bind(w.bot)
  w.bot.blockAt = (p) => chests.some((c) => c.x === Math.floor(p.x) && c.y === Math.floor(p.y) && c.z === Math.floor(p.z)) ? { name: 'chest', position: p } : blockAt(p)
  w.bot.openChest = async () => ({
    containerItems: () => chestItems.filter((s) => s.count > 0),
    withdraw: async (type, meta, n) => { const s = chestItems.find((i) => i.type === type); s.count -= n; w.transport.state.inventory.push({ slot: 12, name: s.name, count: n }) },
    close() {},
  })
  return w
}
async function tick(bot, ctx) {
  const d = await goal.decide(bot, ctx)
  const run = BEHAVIOURS[d.action]
  if (run) await run(bot, ctx, null, {})
  await new Promise((r) => setTimeout(r, 5))
  await bot.refresh()
  return d.action
}

it('loop: hungry, no cow, no chest -> search; a chest at ~50 appears -> foodRecovery takes bread from it', async () => {
  const chests = []
  const items = [{ name: 'bread', type: 1, count: 10 }]
  const { bot, ctx, transport } = await loopWorld(chests, items)
  try {
    assert.equal(await tick(bot, ctx), 'chestSearch', 'nothing nearer: the long-trip rung')
    const p = bot.entity.position
    chests.push({ x: Math.floor(p.x) + 50, y: Math.floor(p.y), z: Math.floor(p.z) })
    let got = false
    for (let i = 0; i < 60 && !got; i++) {
      await tick(bot, ctx)
      got = transport.state.inventory.some((s) => s.name === 'bread')
    }
    assert.ok(got, `bread drawn from the found chest: step=${ctx.step} ${JSON.stringify(ctx.foodRecovery && ctx.foodRecovery.chest && ctx.foodRecovery.chest.phase)}`)
    assert.ok(!(transport.state.attacks || []).length, 'no hunt while a chest had hope')
  } finally { await bot.stop() }
})

// Prod 2026-11-13: 13 of 20 steps were fruitless chest searches with food
// around. The obtain rung (hunt) now runs before the long trip.
it('loop: hungry, cow near, no chest -> foodRecovery hunts, no chest search first', async () => {
  const { bot, ctx, transport } = await loopWorld([], [])
  try {
    transport.state.entities = [cowAt(bot.entity.position)]
    await bot.refresh()
    assert.equal(await tick(bot, ctx), 'foodRecovery', 'obtain before the long trip')
    assert.equal(ctx.chestSearch, undefined)
  } finally { await bot.stop() }
})

it('moderate hunger (food 4, hp 10): a remembered chest at 50 is targeted by foodRecovery, no search', async () => {
  const { bot, ctx, transport } = await world([])
  try {
    transport.state.health = 10
    await bot.refresh()
    const p = bot.entity.position
    ctx.chests = [{ x: Math.floor(p.x) + 50, y: Math.floor(p.y), z: Math.floor(p.z) }]
    assert.equal((await goal.decide(bot, ctx)).action, 'foodRecovery')
  } finally { await bot.stop() }
})

it('stuck: no movement for the stall ticks marks the target chunk visited and picks another', async () => {
  const { bot, ctx } = await world([])
  try {
    await goal.decide(bot, ctx)
    bot.pathfinder.setGoal = () => {} // the body never moves
    BEHAVIOURS.chestSearch(bot, ctx)
    const t = ctx.chestSearch.target
    for (let i = 0; i < 12; i++) BEHAVIOURS.chestSearch(bot, ctx)
    assert.ok(ctx.explore.visited.has(`${Math.floor(t.x / 16)},${Math.floor(t.z / 16)}`))
    assert.notDeepEqual(ctx.chestSearch.target, t)
  } finally { await bot.stop() }
})

it('dusk ends the search: decide does not hold it and clears the leg', async () => {
  const { bot, ctx } = await world([])
  try {
    assert.equal((await goal.decide(bot, ctx)).action, 'chestSearch')
    BEHAVIOURS.chestSearch(bot, ctx)
    bot.time = { timeOfDay: 12500, isDay: false }
    assert.notEqual((await goal.decide(bot, ctx)).action, 'chestSearch')
    assert.equal(ctx.chestSearch, null)
  } finally { await bot.stop() }
})

it('spiral explored: failed:explored arms the cooldown', async () => {
  const { bot, ctx } = await world([])
  try {
    await goal.decide(bot, ctx)
    const all = new Set()
    all.has = () => true // every spiral chunk already visited
    ctx.explore = { visited: all, target: null }
    BEHAVIOURS.chestSearch(bot, ctx)
    assert.equal(ctx.stepStatus, 'failed:explored')
    assert.ok(ctx.chestSearchRetryAt > Date.now())
  } finally { await bot.stop() }
})
