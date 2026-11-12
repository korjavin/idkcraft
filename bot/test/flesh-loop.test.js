'use strict'

// Prod 2026-11-12 bot5 (health 5.78, food 16): the run drew rotten flesh, the
// eater refused it, "acquired", restart: 4 chests in 5 min, never ate. One
// predicate now; the chain withdraw -> eat -> food rises -> run ends, once.
const { it, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const Vec3 = require('vec3')
const { BEHAVIOURS } = require('../src/index')
const foodRecovery = require('../src/behaviours/food-recovery')
const { eatReflex } = require('../src/reflexes')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let prevBody
beforeEach(() => { prevBody = process.env.BOT_BODY; process.env.BOT_BODY = 'baritone' })
afterEach(() => { if (prevBody === undefined) delete process.env.BOT_BODY; else process.env.BOT_BODY = prevBody })

const GAIN = { rotten_flesh: 4, bread: 5 }
function world(chestItems, pack, health, food) {
  let withdraws = 0
  let held = null
  const bot = {
    health, food, entity: { position: new Vec3(0, 64, 0), onGround: true }, entities: {},
    inventory: { items: () => pack.filter((i) => i.count > 0) },
    pathfinder: { setGoal(g) { bot.entity.position = new Vec3(g.x - 1, g.y, g.z) }, isMoving: () => false },
    chat() {},
    blockAt: () => ({ name: 'chest' }),
    openChest: async () => ({
      containerItems: () => chestItems.filter((s) => s.count > 0),
      withdraw: async (type, meta, n) => {
        withdraws++
        const s = chestItems.find((i) => i.type === type)
        s.count -= n
        pack.push({ name: s.name, count: n, type })
      },
      close() {},
    }),
    equip: async (i) => { held = i },
    consume: async () => { held.count--; bot.food = Math.min(20, bot.food + GAIN[held.name]) },
  }
  return { bot, withdraws: () => withdraws }
}

async function live(bot, ctx, ticks = 40) {
  ctx.step = 'foodRecovery'; ctx.stepStatus = 'running'; ctx.work = true
  let starts = 0
  for (let i = 0; i < ticks; i++) {
    if (ctx.stepStatus !== 'running' && foodRecovery.available(bot, ctx, { time: 'day', health: bot.health, food: bot.food })) {
      ctx.stepStatus = 'running'
    }
    if (ctx.stepStatus === 'running' && !foodRecovery.needed(bot, ctx, { time: 'day', health: bot.health, food: bot.food })) ctx.stepStatus = 'done' // goal's foodExit
    if (ctx.stepStatus === 'running') {
      if (!(ctx.foodRecovery && ctx.foodRecovery.valid)) starts++
      BEHAVIOURS.foodRecovery(bot, ctx, null, { time: 'day', health: bot.health, food: bot.food })
    }
    eatReflex(bot, ctx, null)
    await sleep(5)
  }
  return starts
}

for (const food of [16, 17]) {
  it(`health 5 food ${food}, flesh-only chest: one withdraw, eaten, food rises, no restart`, async () => {
    const { bot, withdraws } = world([{ name: 'rotten_flesh', type: 3, count: 14 }], [], 5, food)
    const ctx = { chests: [{ x: 6, y: 64, z: 0 }] }
    const starts = await live(bot, ctx)
    assert.equal(withdraws(), 1)
    assert.ok(bot.food >= 18, `food ${bot.food}`)
    assert.equal(starts, 1, 'no start/acquired flapping')
  })
}

it('health 5 food 16, bread in the pack: eats to >= 18 without a chest run', async () => {
  const pack = [{ name: 'bread', count: 3, type: 1 }]
  const { bot, withdraws } = world([], pack, 5, 16)
  const starts = await live(bot, { chests: [] }, 10)
  assert.ok(bot.food >= 18)
  assert.equal(withdraws(), 0)
  assert.equal(starts, 0)
})

it('prod shape: two unread flesh-only chests -> one run tours both, then eats, no restart', async () => {
  const { bot, withdraws } = world([{ name: 'rotten_flesh', type: 3, count: 14 }], [], 5, 16)
  const ctx = { chests: [{ x: 6, y: 64, z: 0 }, { x: 9, y: 64, z: 0 }] }
  const starts = await live(bot, ctx, 60)
  assert.ok(bot.food >= 18, `food ${bot.food}`)
  assert.equal(starts, 1)
  assert.ok(withdraws() <= 2)
})

it('flesh in the pack is not eaten while a remembered chest may hold real food', async () => {
  const pack = [{ name: 'rotten_flesh', count: 3, type: 3 }]
  const { bot } = world([{ name: 'bread', type: 1, count: 4 }], pack, 5, 16)
  const ctx = { chests: [{ x: 6, y: 64, z: 0 }] }
  assert.equal(eatReflex(bot, ctx, null), false)
  await live(bot, ctx)
  assert.equal(pack[0].count, 3, 'flesh kept')
  assert.ok(bot.food >= 18, 'bread fetched and eaten')
})
