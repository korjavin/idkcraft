'use strict'

// Chest loop slice: a healthy hungry body with no meal draws food from a
// remembered chest; reads are remembered with a time, an empty read is not
// re-toured until stale, a refill is picked up after staleness.
const { it, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const Vec3 = require('vec3')
const { BEHAVIOURS } = require('../src/index')
const foodRecovery = require('../src/behaviours/food-recovery')
const stockpile = require('../src/behaviours/stockpile')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let prevBody
beforeEach(() => { prevBody = process.env.BOT_BODY; process.env.BOT_BODY = 'baritone' })
afterEach(() => { if (prevBody === undefined) delete process.env.BOT_BODY; else process.env.BOT_BODY = prevBody })

const CHEST = { x: 6, y: 64, z: 0 }
function world(chestItems) {
  const pack = []
  const bot = {
    health: 20, food: 4, entity: { position: new Vec3(0, 64, 0), onGround: true }, entities: {},
    inventory: { items: () => pack },
    pathfinder: { setGoal(g) { bot.entity.position = new Vec3(g.x - 1, g.y, g.z) }, isMoving: () => false },
    chat() {},
    blockAt: () => ({ name: 'chest' }),
    openChest: async () => ({
      containerItems: () => chestItems.filter((s) => s.count > 0),
      withdraw: async (type, meta, n) => {
        const s = chestItems.find((i) => i.type === type)
        s.count -= n
        pack.push({ name: s.name, count: n, type })
      },
      close() {},
    }),
  }
  return { bot, pack }
}
const facts = { time: 'day', health: 20 }

async function drive(bot, ctx) {
  ctx.step = 'foodRecovery'; ctx.stepStatus = 'running'; ctx.work = true
  for (let i = 0; i < 20 && ctx.stepStatus === 'running'; i++) {
    BEHAVIOURS.foodRecovery(bot, ctx, null, facts)
    await sleep(5)
  }
}

it('hungry, no meal, a remembered chest with bread: walks, takes a bounded amount, remembers the rest', async () => {
  const chest = [{ name: 'bread', type: 1, count: 20 }]
  const { bot, pack } = world(chest)
  const ctx = { chests: [{ ...CHEST }] }
  assert.equal(foodRecovery.needed(bot, ctx, facts), true)
  await drive(bot, ctx)
  assert.equal(ctx.stepStatus, 'done')
  assert.deepEqual(pack.map((i) => [i.name, i.count]), [['bread', foodRecovery.HUNGRY_WANT]])
  assert.equal(ctx.chests[0].contents.bread, 20 - foodRecovery.HUNGRY_WANT)
  assert.ok(Date.now() - ctx.chests[0].at < 1000)
  assert.equal(foodRecovery.needed(bot, ctx, facts), false, 'bread in the pack: the eat reflex takes over')
})

it('a healthy body that is not hungry does not tour', () => {
  const { bot } = world([{ name: 'bread', type: 1, count: 5 }])
  bot.food = 17
  assert.equal(foodRecovery.needed(bot, { chests: [{ ...CHEST }] }, facts), false)
})

it('an empty chest is remembered empty and not re-toured until stale; a refill is picked up after', async () => {
  const chest = [{ name: 'bread', type: 1, count: 0 }, { name: 'dirt', type: 2, count: 3 }]
  const { bot, pack } = world(chest)
  const ctx = { chests: [{ ...CHEST }] }
  assert.equal(foodRecovery.needed(bot, ctx, facts), true, 'never read: worth a look')
  await drive(bot, ctx)
  assert.equal(pack.length, 0)
  assert.deepEqual(ctx.chests[0].contents, { dirt: 3 })
  ctx.foodRecoveryChestSeen = null; ctx.foodRecoveryRetryAt = 0
  assert.equal(foodRecovery.needed(bot, ctx, facts), false, 'fresh empty read: no re-tour')
  chest[0].count = 8 // refilled meanwhile
  ctx.chests[0].at -= stockpile.CHEST_STALE_MS
  assert.equal(foodRecovery.needed(bot, ctx, facts), true, 'stale read: look again')
  await drive(bot, ctx)
  assert.deepEqual(pack.map((i) => [i.name, i.count]), [['bread', foodRecovery.HUNGRY_WANT]])
})

it('stocked chests come before unknown ones; fresh-empty ones are skipped', () => {
  const near = { x: 3, y: 64, z: 0 }
  const mid = { x: 5, y: 64, z: 0, contents: { stone: 9 }, at: Date.now() }
  const far = { x: 9, y: 64, z: 0, contents: { bread: 2 }, at: Date.now() }
  const { bot } = world([])
  const ctx = { chests: [near, mid, far] }
  const pick = require('../src/behaviours/bring').pickChest(bot, ctx, { wants: (n) => n === 'bread', chestSeen: [] })
  assert.equal(pick.pos, far)
  assert.equal(stockpile.chestHope(ctx, mid, (n) => n === 'bread'), 0)
  assert.equal(stockpile.chestHope(ctx, near, (n) => n === 'bread'), 1)
})

// Through the real goal.decide on a castle build (Codex #776): a sighted,
// never-opened chest (scout's rememberChests: no contents = hope 1) with bread.
const goal = require('../src/goal')
for (const [food, health] of [[0, 10], [0, 20], [9, 10], [9, 20]]) {
  it(`decide on a castle build picks the food leg: food=${food} health=${health}, a sighted chest`, async () => {
    const chest = [{ name: 'bread', type: 1, count: 16 }]
    const { bot, pack } = world(chest)
    bot.food = food; bot.health = health
    bot.time = { timeOfDay: 1000 }
    const ctx = {
      home: { built: true },
      castle: { site: { x: 5, y: 64, z: 5 }, rot: 0, blueprintVersion: 1, phase: 'body', blocked: {}, parked: false },
      stepStatus: 'running', work: true,
    }
    stockpile.rememberChests(ctx, [new Vec3(CHEST.x, CHEST.y, CHEST.z)])
    assert.equal(stockpile.chestHope(ctx, CHEST, () => true), 1, 'sighted, never opened: a candidate')
    const d = await goal.decide(bot, ctx)
    assert.equal(d.action, 'foodRecovery')
    for (let i = 0; i < 20 && ctx.stepStatus === 'running'; i++) {
      BEHAVIOURS.foodRecovery(bot, ctx, null, { time: 'day', health })
      await sleep(5)
    }
    assert.equal(pack[0] && pack[0].name, 'bread')
    assert.equal(pack[0].count, foodRecovery.HUNGRY_WANT)
    // the real eat reflex on the mock body (consume is the mock's food gain)
    bot.equip = async () => {}
    bot.consume = async () => { pack[0].count--; bot.food += 5 }
    assert.equal(require('../src/reflexes').eatReflex(bot, ctx, null), true)
    for (let i = 0; i < 10 && ctx.eatInFlight; i++) await sleep(5)
    assert.equal(bot.food, food + 5)
  })
}

it('an unreachable chest is not re-toured when the seen list is wiped; it is retried after staleness', async () => {
  let goals = 0
  const { bot } = world([{ name: 'bread', type: 1, count: 5 }])
  bot.pathfinder = { setGoal() { goals++ }, isMoving: () => false } // never arrives
  const ctx = { chests: [{ ...CHEST }] }
  await drive(bot, ctx)
  assert.equal(goals, 1)
  ctx.foodRecoveryChestSeen = null; ctx.foodRecoveryRetryAt = 0 // goal.js lowHpClock wipes it on every healthy tick
  assert.equal(foodRecovery.needed(bot, ctx, facts), false, 'failed chest skipped across episodes')
  ctx.chests[0].failAt -= stockpile.CHEST_STALE_MS
  assert.equal(foodRecovery.needed(bot, ctx, facts), true, 'stale failure: try again')
})

// Source ladder (owner 2026-11-13): a hungry run whose near chest is empty
// falls to the obtain rung (hunt) in the same leg, never a chest-only retry.
it('a hungry (healthy) run at an empty chest hunts the cow beside it', async () => {
  const { bot } = world([{ name: 'dirt', type: 2, count: 3 }])
  bot.food = 10
  bot.entities = { 7: { id: 7, name: 'cow', type: 'animal', position: new Vec3(2, 64, 0), isValid: true } }
  const ctx = { chests: [{ ...CHEST }] }
  ctx.step = 'foodRecovery'; ctx.stepStatus = 'running'; ctx.work = true
  for (let i = 0; i < 20 && !(ctx.foodRecovery && ctx.foodRecovery.hunt); i++) {
    BEHAVIOURS.foodRecovery(bot, ctx, null, facts)
    await sleep(5)
  }
  assert.ok(ctx.foodRecovery.hunt, 'hunt started after the empty chest')
  assert.ok(!(ctx.foodRecoveryRetryAt > Date.now()), 'no chest-only retry')
})

it('hungry with no chest at all: the hunt rung is offered, not a chest search', () => {
  const { bot } = world([])
  bot.food = 10
  bot.entities = { 7: { id: 7, name: 'cow', type: 'animal', position: new Vec3(2, 64, 0), isValid: true } }
  const ctx = {}
  assert.equal(foodRecovery.needed(bot, ctx, facts), true)
  assert.equal(foodRecovery.available(bot, ctx, facts), true)
})

// Review #778: run-level, not only decide (food 0, health 10 = the Easy prod case).
it('food 0 health 10: an empty remembered chest falls through to the hunt', async () => {
  const { bot } = world([{ name: 'dirt', type: 2, count: 3 }])
  bot.food = 0; bot.health = 10
  bot.entities = { 7: { id: 7, name: 'cow', type: 'animal', position: new Vec3(2, 64, 0), isValid: true } }
  const ctx = { chests: [{ ...CHEST }] }
  ctx.step = 'foodRecovery'; ctx.stepStatus = 'running'; ctx.work = true
  for (let i = 0; i < 20 && !(ctx.foodRecovery && ctx.foodRecovery.hunt); i++) {
    BEHAVIOURS.foodRecovery(bot, ctx, null, { time: 'day', health: 10 })
    await sleep(5)
  }
  assert.ok(ctx.foodRecovery.hunt, 'hunt started after the empty chest')
  assert.ok(!(ctx.foodRecoveryRetryAt > Date.now()), 'no chest-only retry')
})

it('food 0: a rotten-flesh-only chest is withdrawn, then eaten by the eat reflex', async () => {
  const { bot, pack } = world([{ name: 'rotten_flesh', type: 3, count: 14 }])
  bot.food = 0; bot.health = 10
  await drive(bot, { chests: [{ ...CHEST }] })
  assert.equal(pack[0] && pack[0].name, 'rotten_flesh')
  let eaten = null
  bot.equip = async (i) => { eaten = i.name }
  bot.consume = async () => {}
  require('../src/reflexes').eatReflex(bot, {}, null)
  await sleep(10)
  assert.equal(eaten, 'rotten_flesh')
})

it('bread and rotten flesh in one chest: bread is drawn', async () => {
  const { bot, pack } = world([{ name: 'rotten_flesh', type: 3, count: 14 }, { name: 'bread', type: 1, count: 2 }])
  bot.food = 0; bot.health = 10
  await drive(bot, { chests: [{ ...CHEST }] })
  assert.deepEqual(pack.map((i) => i.name), ['bread'])
})

it('night: food 0 or health<6 recovers, food 4 at health 10 waits for day', () => {
  const night = (food, health) => {
    const { bot } = world([])
    bot.food = food; bot.health = health
    return foodRecovery.needed(bot, { chests: [{ ...CHEST }] }, { time: 'night', health, food })
  }
  assert.equal(night(0, 10), true)
  assert.equal(night(4, 3), true)
  assert.equal(night(4, 10), false)
})

it('moderate hunger walks at most 64 to a chest; critical hunger up to 256', () => {
  const far = { x: 120, y: 64, z: 0 }
  const { bot } = world([])
  bot.food = 4; bot.health = 10
  assert.equal(foodRecovery.available(bot, { chests: [{ ...far }] }, { time: 'day', health: 10, food: 4 }), false)
  bot.food = 0
  assert.equal(foodRecovery.available(bot, { chests: [{ ...far }] }, { time: 'day', health: 10, food: 0 }), true)
})
