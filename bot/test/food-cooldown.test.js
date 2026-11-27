'use strict'

// prod 2026-11-19 bot2: food 17, no meal, ~470 foodRecovery starts per 10 min.
// Every non-eating end strikes a growing cooldown; the idle no-target end is
// struck even when the source is gone (failed() ran after invalidate before).
const { it } = require('node:test')
const assert = require('node:assert/strict')
const Vec3 = require('vec3')
const { BaritoneBot } = require('../src/bridge')
const { FakeTransport } = require('../src/bridge/transport')
const goal = require('../src/goal')
const fr = require('../src/behaviours/food-recovery')

const fakeBot = (items = []) => ({ health: 11, food: 17, inventory: { items: () => items } })

it('empty ends strike a growing cooldown; eating resets it', () => {
  const ctx = {}
  const bot = fakeBot()
  const start = () => { ctx.foodRecovery = { valid: true, phase: 'hunt', startFood: 17 }; Object.defineProperty(ctx.foodRecovery, 'bot', { value: bot }) }
  start(); fr.invalidate(ctx)
  const a = ctx.foodRecoveryRetryAt - Date.now()
  start(); fr.invalidate(ctx)
  const b = ctx.foodRecoveryRetryAt - Date.now()
  assert.ok(a > 50000 && a <= fr.RETRY_MS && b > 1.9 * fr.RETRY_MS, `${a} ${b}`)
  bot.food = 18; start(); fr.invalidate(ctx)
  assert.equal(ctx.foodRecoveryFails, 0)
})

it('idle no-target end with no source left still takes the cooldown', async () => {
  const prev = process.env.BOT_BODY
  process.env.BOT_BODY = 'baritone'
  const bot = new BaritoneBot(new FakeTransport({ health: 11, food: 17, inventory: [{ slot: 9, name: 'stone_pickaxe', count: 1 }], entities: [] }), { Vec3, registry: { blocksByName: { air: { id: 0 } }, entitiesByName: {} }, username: 'IdkBody' })
  await bot.start({ pollMs: 0 })
  try {
    const ctx = { home: { site: { x: 0, y: 64, z: 0 } }, gear: { saidNeed: 'want-logs' }, step: 'foodRecovery', stepStatus: 'failed:no-target', chestSearchRetryAt: Date.now() + 3600000 }
    ctx.foodRecovery = { valid: true, phase: 'hunt', startFood: 17 }
    Object.defineProperty(ctx.foodRecovery, 'bot', { value: bot })
    await goal.decide(bot, ctx)
    assert.ok(ctx.foodRecoveryRetryAt > Date.now(), 'struck')
    assert.equal(ctx.foodRecoveryFails, 1)
    assert.equal(ctx.foodNoSource, true, 'no source flagged for the stall/JEV context')
  } finally {
    await bot.stop()
    if (prev === undefined) delete process.env.BOT_BODY
    else process.env.BOT_BODY = prev
  }
})

// prod 2026-11-19 bot3: a live foodRecovery step under cooldown restarted every tick
require('node:test').test('a run under cooldown ends the step instead of restarting', () => {
  const assert = require('node:assert/strict')
  const fr = require('../src/behaviours/food-recovery')
  const ctx = { step: 'foodRecovery', foodRecoveryRetryAt: Date.now() + 60000 }
  const bot = { health: 10, food: 17, inventory: { items: () => [] }, entity: { position: { x: 0, y: 64, z: 0 } } }
  fr.run(bot, ctx)
  assert.match(String(ctx.stepStatus), /^failed:cooldown/)
  assert.equal(ctx.foodRecovery, undefined)
})

// prod 2026-11-20 bot4: foodRecovery at 0.15 hp hunted into a cave (y=-30) and died to a skeleton.
it('low hp hunt never follows prey down or into the dark', () => {
  const v = (x, y, z) => ({ x, y, z, offset: (a, b, c) => v(x + a, y + b, z + c) })
  let sky = 15
  const bot = { health: 4, entity: { position: v(0, 64, 0) }, entities: { 3: { position: v(5, 64, 0) } }, blockAt: () => ({ skyLight: sky }) }
  const t = { id: 3, name: 'cow' }
  assert.equal(fr.safeHunt(bot, t), t, 'lit, level prey: hunt')
  sky = 0
  assert.equal(fr.safeHunt(bot, t), null, 'dark: no hunt')
  sky = 15; bot.entities[3].position = v(5, 50, 0)
  assert.equal(fr.safeHunt(bot, t), null, 'below: no hunt')
  bot.health = 15
  assert.equal(fr.safeHunt(bot, t), t, 'healthy: unchanged')
})

const CRITICAL = { time: 'day', health: 5, food: 0 }
const CHEST_A = { x: 4, y: 64, z: 0 }
const CHEST_B = { x: 7, y: 64, z: 0 }

function recoveryWorld(t) {
  const previousBody = process.env.BOT_BODY
  process.env.BOT_BODY = 'baritone'
  t.after(() => {
    if (previousBody === undefined) delete process.env.BOT_BODY
    else process.env.BOT_BODY = previousBody
  })
  t.mock.method(Date, 'now', () => 1000000)
  const bot = {
    ...fakeBot(), health: 5, food: 0, entities: {},
    entity: { position: new Vec3(0, 64, 0) },
    pathfinder: { setGoal() {} }, blockAt: () => ({ skyLight: 0 }),
  }
  const ctx = { work: true, step: 'foodRecovery', chests: [{ ...CHEST_A }] }
  return { bot, ctx }
}

function failPath(bot, ctx) {
  fr.run(bot, ctx)
  ctx.stepStatus = 'failed:unreachable'
  fr.failed(ctx)
  assert.ok(ctx.foodRecoveryRetryAt > Date.now())
}

it('losing and regaining the same failed chest does not reopen the cooldown', (t) => {
  const { bot, ctx } = recoveryWorld(t)
  failPath(bot, ctx)
  const retryAt = ctx.foodRecoveryRetryAt
  assert.equal(fr.available(bot, ctx, CRITICAL), false)
  bot.entity.position = new Vec3(300, 64, 0)
  assert.equal(fr.available(bot, ctx, CRITICAL), false)
  assert.equal(ctx.foodRecoveryRetryAt, retryAt)
  bot.entity.position = new Vec3(0, 64, 0)
  assert.equal(fr.available(bot, ctx, CRITICAL), false)
  t.mock.method(Date, 'now', () => retryAt)
  assert.equal(fr.available(bot, ctx, CRITICAL), true, 'ordinary cooldown still expires')
})

it('expiry of an old failed chest does not lift a longer recovery cooldown', (t) => {
  const { bot, ctx } = recoveryWorld(t)
  ctx.foodRecoveryFails = 4
  failPath(bot, ctx)
  const retryAt = ctx.foodRecoveryRetryAt
  ctx.chests[0].contents = { bread: 8 }
  ctx.chests[0].at = Date.now() - 30000
  ctx.chests[0].failAt = Date.now()
  ctx.foodChestDryUntil = Date.now() + 600000
  assert.equal(fr.available(bot, ctx, CRITICAL), false)
  t.mock.method(Date, 'now', () => 1600000)
  assert.ok(retryAt > Date.now())
  assert.equal(fr.available(bot, ctx, CRITICAL), false, 'same failed source is only stale')
  assert.equal(ctx.foodRecoveryRetryAt, retryAt)
})

it('a different reachable stocked chest reopens the cooldown', (t) => {
  const { bot, ctx } = recoveryWorld(t)
  failPath(bot, ctx)
  assert.equal(fr.available(bot, ctx, CRITICAL), false)
  ctx.chests = [{ ...CHEST_A, contents: {}, at: Date.now() }, { ...CHEST_B, contents: { bread: 8 }, at: Date.now() }]
  assert.equal(fr.available(bot, ctx, CRITICAL), true)
  fr.run(bot, ctx)
  assert.equal(ctx.lastGoalKey, 'bring-chest:7,64,0')
})

it('prey that the survival executor rejects does not lift the cooldown', (t) => {
  const { bot, ctx } = recoveryWorld(t)
  failPath(bot, ctx)
  assert.equal(fr.available(bot, ctx, CRITICAL), false)
  bot.entities[3] = { name: 'cow', id: 3, position: new Vec3(4, 61, 0) }
  assert.equal(fr.available(bot, ctx, CRITICAL), false)
  bot.entities[3].position = new Vec3(4, 64, 0)
  bot.blockAt = () => ({ skyLight: 15 })
  assert.equal(fr.available(bot, ctx, CRITICAL), true, 'a safely huntable animal is a new option')
})

it('a newer verified refill reopens a tried chest during the dry window and provides food', async (t) => {
  const { bot, ctx } = recoveryWorld(t)
  bot.health = 10
  bot.food = 9
  const pack = []
  const bread = { name: 'bread', type: 1, count: 12 }
  bot.inventory.items = () => pack
  bot.blockAt = () => ({ name: 'chest' })
  bot.openChest = async () => ({
    containerItems: () => [bread],
    withdraw: async (type, meta, count) => {
      bread.count -= count
      pack.push({ name: bread.name, type, count })
    },
    close() {},
  })
  bot.chat = () => {}
  const hungry = { time: 'day', health: 10, food: 9 }
  ctx.chests[0].contents = { bread: 8 }
  ctx.chests[0].at = Date.now() - 30000
  failPath(bot, ctx)
  ctx.foodRecoveryChestSeen = ['4,64,0']
  ctx.foodChestDryUntil = Date.now() + 600000
  assert.equal(fr.available(bot, ctx, hungry), false, 'old positive contents are not a new sighting')
  t.mock.method(Date, 'now', () => 1001000)
  ctx.chests[0].contents.bread = 12
  ctx.chests[0].at = Date.now()
  assert.equal(fr.available(bot, ctx, hungry), true)
  ctx.lastGoalKey = ''
  fr.run(bot, ctx)
  assert.deepEqual(ctx.foodRecoveryChestSeen, [])
  assert.equal(ctx.foodRecovery.phase, 'chest')
  assert.equal(ctx.lastGoalKey, 'bring-chest:4,64,0')
  assert.equal(fr.needed(bot, ctx, hungry), true, 'next decision keeps the live reopened chest leg')
  ctx.stepStatus = 'running'
  for (let i = 0; i < 4 && ctx.stepStatus === 'running'; i++) {
    fr.run(bot, ctx)
    await new Promise((resolve) => setImmediate(resolve))
  }
  assert.equal(ctx.stepStatus, 'done')
  assert.deepEqual(pack, [{ name: 'bread', type: 1, count: fr.HUNGRY_WANT }])
})
