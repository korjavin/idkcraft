'use strict'

// Owner 2026-11-12: a no-castle v2 bot (home = site) at food 0 finds food anywhere:
// a far remembered chest, prey; a watchdog task-plan does not hold it.
// Rotten flesh is a true last resort.
const { it } = require('node:test')
const assert = require('node:assert/strict')
const Vec3 = require('vec3')
const { BaritoneBot } = require('../src/bridge')
const { FakeTransport } = require('../src/bridge/transport')
const goal = require('../src/goal')
const stockpile = require('../src/behaviours/stockpile')
const { pickEdible, eatReflex } = require('../src/reflexes')

const registry = { blocksByName: { air: { id: 0 } }, entitiesByName: { cow: { height: 1.4, width: 0.9, type: 'animal' } } }
const cow = { id: 7, uuid: '22222222-2222-2222-2222-222222222222', type: 'cow', displayName: 'Cow', kind: 'animal', pos: { x: 2, y: 64, z: 0 }, vel: { x: 0, y: 0, z: 0 }, yaw: 0, pitch: 0, health: 20, onGround: true, pose: 'standing' }

async function decideWith(health, entities, extra) {
  const prev = process.env.BOT_BODY
  process.env.BOT_BODY = 'baritone'
  const bot = new BaritoneBot(new FakeTransport({ health, food: 0, inventory: [{ slot: 9, name: 'stone_pickaxe', count: 1 }, { slot: 11, name: 'dirt', count: 32 }], entities }), { Vec3, registry, username: 'IdkBody' })
  await bot.start({ pollMs: 0 })
  try {
    const ctx = { home: { site: { x: 0, y: 64, z: 0 } }, gear: { saidNeed: 'want-logs' }, stepStatus: 'running', ...extra }
    return (await goal.decide(bot, ctx)).action
  } finally {
    await bot.stop()
    if (prev === undefined) delete process.env.BOT_BODY
    else process.env.BOT_BODY = prev
  }
}

// Hunt comes after the chest search (owner order): these pin a search on cooldown.
const COOL = { chestSearchRetryAt: Date.now() + 3600000 }
for (const health of [10, 3]) {
  it(`no castle, health ${health} food 0: a remembered unopened chest beyond NEARBY_CHEST_RADIUS -> foodRecovery`, async () => {
    assert.equal(await decideWith(health, [], { chests: [{ x: stockpile.NEARBY_CHEST_RADIUS + 60, y: 64, z: 0 }] }), 'foodRecovery')
  })
  it(`no castle, health ${health} food 0: no chest, a cow near -> foodRecovery`, async () => {
    assert.equal(await decideWith(health, [cow], COOL), 'foodRecovery')
    assert.equal(await decideWith(health, [cow]), 'chestSearch', 'search due: chest search before the hunt')
  })
  it(`no castle, health ${health} food 0: a watchdog task-plan does not hold a starving bot`, async () => {
    assert.equal(await decideWith(health, [cow], { taskPlanStep: 'craft', ...COOL }), 'foodRecovery')
  })
}

function eater(food, items) {
  let ate = null
  const bot = { food, health: 10, inventory: { items: () => items }, consume: async () => {}, equip: async (i) => { ate = i.name } }
  return { bot, ate: () => ate }
}
const flush = () => new Promise((r) => setTimeout(r, 10))

it('rotten flesh: never picked over bread; eaten only when starving with no hope chest', async () => {
  assert.equal(pickEdible([{ name: 'rotten_flesh' }, { name: 'bread' }], true).name, 'bread')
  assert.equal(pickEdible([{ name: 'rotten_flesh' }]), null)
  const only = eater(0, [{ name: 'rotten_flesh', count: 3 }])
  assert.ok(eatReflex(only.bot, { position: null }, null) !== false)
  await flush()
  assert.equal(only.ate(), 'rotten_flesh')
  const fed = eater(5, [{ name: 'rotten_flesh', count: 3 }])
  assert.equal(eatReflex(fed.bot, {}, null), false, 'food 5 is not critical')
})

it('rotten flesh: a read chest holding only rotten flesh is a food target at food 0, not at food 13', async () => {
  const prev = process.env.BOT_BODY
  process.env.BOT_BODY = 'baritone'
  const bot = new BaritoneBot(new FakeTransport({ health: 10, food: 0, inventory: [{ slot: 11, name: 'dirt', count: 3 }], entities: [] }), { Vec3, registry, username: 'IdkBody' })
  await bot.start({ pollMs: 0 })
  try {
    const chest = { x: 60, y: 64, z: 0, at: Date.now(), contents: { rotten_flesh: 14 } }
    const ctx = { home: { site: { x: 0, y: 64, z: 0 } }, gear: { saidNeed: 'want-logs' }, stepStatus: 'running', chests: [chest] }
    assert.equal((await goal.decide(bot, ctx)).action, 'foodRecovery')
    const fr = require('../src/behaviours/food-recovery')
    bot.food = 13
    assert.equal(fr.needed(bot, { chests: [chest] }, { time: 'day', health: 10 }), false, 'not starving: flesh is no target')
  } finally {
    await bot.stop()
    if (prev === undefined) delete process.env.BOT_BODY
    else process.env.BOT_BODY = prev
  }
})

it('rotten flesh: a known chest with bread wins, flesh stays in the pack', async () => {
  const prev = process.env.BOT_BODY
  process.env.BOT_BODY = 'baritone'
  const bot = new BaritoneBot(new FakeTransport({ health: 10, food: 0, inventory: [{ slot: 11, name: 'rotten_flesh', count: 3 }], entities: [] }), { Vec3, registry, username: 'IdkBody' })
  await bot.start({ pollMs: 0 })
  try {
    const ctx = { home: { site: { x: 0, y: 64, z: 0 } }, gear: { saidNeed: 'want-logs' }, stepStatus: 'running', chests: [{ x: 60, y: 64, z: 0 }] }
    assert.equal(eatReflex(bot, ctx, null), false, 'an unread chest still hopes for real food')
    assert.equal((await goal.decide(bot, ctx)).action, 'foodRecovery')
  } finally {
    await bot.stop()
    if (prev === undefined) delete process.env.BOT_BODY
    else process.env.BOT_BODY = prev
  }
})
