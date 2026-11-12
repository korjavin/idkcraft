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
