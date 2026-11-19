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
