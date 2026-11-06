'use strict'

// Controlled v2 bridge world: the world produces a drop after an actual hit
// and applies food gain after the adapter's item-use request.
const { it } = require('node:test')
const assert = require('node:assert/strict')
const Vec3 = require('vec3')
const { BaritoneBot } = require('../src/bridge')
const { FakeTransport } = require('../src/bridge/transport')
const goal = require('../src/goal')
const forage = require('../src/behaviours/forage')
const resources = require('../src/resources')
const { eatReflex } = require('../src/reflexes')
const stockpile = require('../src/behaviours/stockpile')
const { BEHAVIOURS, handleChat, createTicker } = require('../src/index')

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const registry = { blocksByName: { air: { id: 0 } }, entitiesByName: { cow: { height: 1.4, width: 0.9, type: 'animal' } } }

class FoodWorld extends FakeTransport {
  async call(method, params) {
    const result = await super.call(method, params)
    if (method === 'interact.item') {
      const held = this.state.inventory.find((item) => item.slot === 36 + (this.state.selected || 0) && ['beef', 'bread'].includes(item.name))
      if (held && held.count > 0) {
        held.count--
        this.state.food += held.name === 'bread' ? 5 : 3
      }
    }
    return result
  }
}

it('critical hunger acquires and eats nearby prey despite remembered iron', async () => {
  const previousBody = process.env.BOT_BODY
  process.env.BOT_BODY = 'baritone'
  const transport = new FoodWorld({
    health: 5, food: 3,
    inventory: [{ slot: 9, name: 'stone_pickaxe', count: 1 }, { slot: 10, name: 'stone_sword', count: 1 }, { slot: 11, name: 'dirt', count: 32 }],
    entities: [{ id: 7, uuid: '22222222-2222-2222-2222-222222222222', type: 'cow', displayName: 'Cow', kind: 'animal', pos: { x: 1, y: 64, z: 0 }, vel: { x: 0, y: 0, z: 0 }, yaw: 0, pitch: 0, health: 20, onGround: true, pose: 'standing' }],
  })
  const bot = new BaritoneBot(transport, { Vec3, registry, username: 'IdkBody' })
  await bot.start({ pollMs: 0 })
  try {
    const ctx = {
      home: { built: true },
      castle: { site: { x: 5, y: 64, z: 5 }, rot: 0, blueprintVersion: 1, phase: 'body', blocked: {}, parked: false },
      castleWord: { kind: 'torch', left: 3 }, gear: { saidNeed: 'want-logs' }, stepStatus: 'running',
      sitebed: { deadDay: 0 },
    }
    resources.noteSpots(ctx, [{ x: 5, y: 60, z: 0, name: 'iron_ore' }], 1000)
    assert.equal((await goal.decide(bot, ctx)).action, 'foodRecovery')
    for (let i = 0; i < 20 && !(transport.state.attacks || []).length; i++) {
      BEHAVIOURS.foodRecovery(bot, ctx, null, {})
      await sleep(20)
    }
    assert.deepEqual(transport.state.attacks, [7])
    transport.state.entities = []
    await bot.refresh()
    BEHAVIOURS.foodRecovery(bot, ctx, null, {}) // kill observes despawn, enters pickup
    assert.equal(ctx.foodRecovery.hunt.phase, 'pickup')
    BEHAVIOURS.foodRecovery(bot, ctx, null, {}) // issues the pickup walk
    transport.state.inventory.push({ slot: 12, name: 'beef', count: 1 })
    await bot.refresh()
    assert.ok(bot.inventory.items().some((item) => item.name === 'beef'))
    BEHAVIOURS.foodRecovery(bot, ctx, null, {})
    assert.equal(ctx.stepStatus, 'done', 'the real pickup phase counted the drop')
    assert.equal(eatReflex(bot, ctx, { hostile: { isValid: true }, hostile_distance: 1 }), false, 'close combat defers eating')
    assert.ok(bot.inventory.items().some((item) => item.name === 'beef'))
    assert.equal(eatReflex(bot, ctx, {}), true)
    for (let i = 0; i < 100 && !(transport.state.itemUses || []).length; i++) await sleep(20)
    assert.ok(transport.state.itemUses.length)
    for (let i = 0; i < 100 && ctx.eatInFlight; i++) await sleep(20)
    assert.equal(bot.food, 6)
    // Model subsequent regeneration after more food; the castle gate must
    // eventually give the actual arbiter its work back.
    transport.state.health = 6
    transport.state.food = 18
    await bot.refresh()
    assert.equal((await goal.decide(bot, ctx)).action, 'castlefetch')
  } finally {
    await bot.stop()
    if (previousBody === undefined) delete process.env.BOT_BODY
    else process.env.BOT_BODY = previousBody
  }
})

it('critical hunger withdraws edible food from a reachable stocked chest', async () => {
  const previousBody = process.env.BOT_BODY
  process.env.BOT_BODY = 'baritone'
  const transport = new FoodWorld({
    health: 5, food: 3,
    inventory: [{ slot: 9, name: 'stone_pickaxe', count: 1 }, { slot: 10, name: 'stone_sword', count: 1 }, { slot: 11, name: 'dirt', count: 32 }],
    blocks: { '2,64,0': 'chest' },
    containers: { '2,64,0': { type: 'minecraft:generic_9x3', size: 27, title: 'Chest', slots: [{ slot: 0, name: 'bread', count: 2 }] } },
  })
  const bot = new BaritoneBot(transport, { Vec3, registry: require('minecraft-data')('26.1.2'), username: 'IdkBody' })
  await bot.start({ pollMs: 0 })
  try {
    const ctx = {
      home: { built: true, chest: { x: 2, y: 64, z: 0 } },
      castle: { site: { x: 5, y: 64, z: 5 }, rot: 0, blueprintVersion: 1, phase: 'body', blocked: {}, parked: false },
      castleWord: { kind: 'torch', left: 3 }, gear: { saidNeed: 'want-logs' }, stepStatus: 'running',
    }
    // Establish that this exact chest and the existing withdrawal mechanism
    // work on the real adapter before resetting the world for arbitration.
    const got = await stockpile.withdrawEdible(bot, ctx, 1)
    assert.equal(got.name, 'bread')
    assert.equal(got.got, 1)
    assert.ok(bot.inventory.items().some((item) => item.name === 'bread'))
    transport.state.inventory = transport.state.inventory.filter((item) => item.name !== 'bread')
    await bot.refresh()
    let sawBread = false
    for (let i = 0; i < 30 && bot.food === 3; i++) {
      const decision = await goal.decide(bot, ctx)
      const execute = BEHAVIOURS[decision.action]
      if (execute) await execute(bot, ctx, null, {})
      sawBread ||= bot.inventory.items().some((item) => item.name === 'bread' && item.count > 0)
      eatReflex(bot, ctx, {})
      await sleep(20)
      await bot.refresh()
    }
    assert.ok(sawBread, 'autonomous recovery withdraws food')
    assert.equal(bot.food, 8, 'the item-use request feeds the body')
    for (let i = 0; i < 100 && ctx.eatInFlight; i++) await sleep(20)
  } finally {
    await bot.stop()
    if (previousBody === undefined) delete process.env.BOT_BODY
    else process.env.BOT_BODY = previousBody
  }
})

it('cancelling an opening chest prevents withdrawal and closes it', async () => {
  const opened = Promise.withResolvers()
  let valid = true
  let withdrawals = 0
  let closes = 0
  const win = { containerItems: () => [{ name: 'bread', type: 1, count: 1 }], withdraw: async () => { withdrawals++ }, close: () => { closes++ } }
  const bot = { blockAt: () => ({ name: 'chest' }), openChest: () => opened.promise }
  const pending = stockpile.withdrawEdible(bot, { home: { chest: { x: 0, y: 0, z: 0 } } }, 1, null, () => valid)
  valid = false
  opened.resolve(win)
  await pending
  assert.equal(withdrawals, 0)
  assert.equal(closes, 1)
})

it('cancelling during a withdrawal prevents a subsequent withdrawal', async () => {
  const first = Promise.withResolvers()
  let valid = true
  let withdrawals = 0
  let closes = 0
  const win = {
    containerItems: () => [{ name: 'bread', type: 1, count: 1 }, { name: 'bread', type: 1, count: 1 }],
    withdraw: async () => { withdrawals++; await first.promise },
    close: () => { closes++ },
  }
  const bot = { blockAt: () => ({ name: 'chest' }), openChest: async () => win }
  const pending = stockpile.withdrawEdible(bot, { home: { chest: { x: 0, y: 0, z: 0 } } }, 2, null, () => valid)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(withdrawals, 1)
  valid = false
  first.resolve()
  await pending
  assert.equal(withdrawals, 1)
  assert.equal(closes, 1)
})

it('stop invalidates an open recovery flight and holds off another window', async () => {
  const opened = Promise.withResolvers()
  let opens = 0
  let withdrawals = 0
  let closes = 0
  const ctx = { step: 'foodRecovery', stepStatus: 'running', work: true, home: { chest: { x: 1, y: 64, z: 0 } } }
  const bot = {
    username: 'IdkBody', _tickerCtx: ctx, health: 5, food: 3, players: {}, entities: {},
    entity: { position: new Vec3(0, 64, 0), onGround: true },
    inventory: { items: () => [] }, time: { timeOfDay: 6000 }, chat() {},
    blockAt: () => ({ name: 'chest' }),
    pathfinder: { setGoal() {}, isMoving: () => false },
    openChest: () => { opens++; return opened.promise },
  }
  BEHAVIOURS.foodRecovery(bot, ctx)
  BEHAVIOURS.foodRecovery(bot, ctx)
  assert.equal(opens, 1)
  const old = ctx.foodRecovery
  handleChat(bot, { setFollow() {}, stop() { ctx.paused = true; ctx.work = false } }, 'Owner', 'stop')
  assert.equal(old.valid, false)
  BEHAVIOURS.foodRecovery(bot, ctx)
  assert.equal(opens, 1, 'pending old window excludes another open')
  opened.resolve({ containerItems: () => [{ name: 'bread', type: 1, count: 1 }], withdraw: async () => { withdrawals++ }, close: () => { closes++ } })
  for (let i = 0; i < 10 && ctx.foodRecoveryFlight; i++) await sleep(10)
  assert.equal(withdrawals, 0)
  assert.equal(closes, 1)
  assert.equal(ctx.foodRecoveryFlight, null)
})

it('the real flee reflex invalidates a pending recovery chest open', async () => {
  const opened = Promise.withResolvers()
  const transport = new FakeTransport({ health: 5, food: 3, blocks: { '1,64,0': 'chest' } })
  const bot = new BaritoneBot(transport, { Vec3, registry: require('minecraft-data')('26.1.2'), username: 'IdkBody' })
  await bot.start({ pollMs: 0 })
  const ticker = createTicker({ bot, brain: { decide: async () => ({ action: 'idle', source: 'stub' }) }, autonomous: true })
  try {
    let withdrawals = 0
    let closes = 0
    bot.openChest = () => opened.promise
    const ctx = bot._tickerCtx
    ctx.work = true; ctx.step = 'foodRecovery'; ctx.stepStatus = 'running'
    ctx.home = { built: true, chest: { x: 1, y: 64, z: 0 } }
    BEHAVIOURS.foodRecovery(bot, ctx)
    BEHAVIOURS.foodRecovery(bot, ctx)
    assert.ok(ctx.foodRecoveryFlight)
    const recovery = ctx.foodRecovery
    transport.state.entities = [{ id: 9, uuid: '33333333-3333-3333-3333-333333333333', type: 'creeper', displayName: 'Creeper', kind: 'hostile', pos: { x: 2, y: 64, z: 0 }, vel: { x: 0, y: 0, z: 0 }, yaw: 0, pitch: 0, health: 20, onGround: true, pose: 'standing' }]
    await bot.refresh()
    const result = await ticker.tick()
    assert.equal(result.decision.action, 'flee')
    assert.equal(recovery.valid, false)
    opened.resolve({ containerItems: () => [{ name: 'bread', type: 1, count: 1 }], withdraw: async () => { withdrawals++ }, close: () => { closes++ } })
    for (let i = 0; i < 20 && ctx.foodRecoveryFlight; i++) await sleep(10)
    assert.equal(withdrawals, 0)
    assert.equal(closes, 1)
  } finally {
    ticker.destroy()
    await bot.stop()
  }
})

it('the real breath reflex invalidates a pending recovery chest open', async () => {
  const opened = Promise.withResolvers()
  const transport = new FakeTransport({ health: 5, food: 3, blocks: { '1,64,0': 'chest' } })
  const bot = new BaritoneBot(transport, { Vec3, registry: require('minecraft-data')('26.1.2'), username: 'IdkBody' })
  await bot.start({ pollMs: 0 })
  const ticker = createTicker({ bot, brain: { decide: async () => ({ action: 'idle', source: 'stub' }) }, autonomous: true })
  try {
    let withdrawals = 0
    let closes = 0
    bot.openChest = () => opened.promise
    const ctx = bot._tickerCtx
    ctx.work = true; ctx.step = 'foodRecovery'; ctx.stepStatus = 'running'
    ctx.home = { built: true, chest: { x: 1, y: 64, z: 0 } }
    BEHAVIOURS.foodRecovery(bot, ctx)
    BEHAVIOURS.foodRecovery(bot, ctx)
    const recovery = ctx.foodRecovery
    bot.oxygenLevel = 6
    bot.entity.isInWater = true
    const result = await ticker.tick()
    assert.equal(result.decision.action, 'breath')
    assert.equal(recovery.valid, false)
    opened.resolve({ containerItems: () => [{ name: 'bread', type: 1, count: 1 }], withdraw: async () => { withdrawals++ }, close: () => { closes++ } })
    for (let i = 0; i < 20 && ctx.foodRecoveryFlight; i++) await sleep(10)
    assert.equal(withdrawals, 0)
    assert.equal(closes, 1)
  } finally {
    ticker.destroy()
    await bot.stop()
  }
})

it('a late withdrawal cannot update a replacement step', async () => {
  const withdrawal = Promise.withResolvers()
  let calls = 0
  let closes = 0
  const ctx = { step: 'foodRecovery', stepStatus: 'running', work: true, chestFull: true, home: { chest: { x: 1, y: 64, z: 0 } } }
  const bot = {
    health: 5, food: 3, entity: { position: new Vec3(0, 64, 0), onGround: true }, entities: {},
    inventory: { items: () => [] }, pathfinder: { setGoal() {}, isMoving: () => false }, chat() {},
    blockAt: () => ({ name: 'chest' }),
    openChest: async () => ({ containerItems: () => [{ name: 'bread', type: 1, count: 1 }], withdraw: async () => { calls++; await withdrawal.promise }, close: () => { closes++ } }),
  }
  BEHAVIOURS.foodRecovery(bot, ctx)
  BEHAVIOURS.foodRecovery(bot, ctx)
  for (let i = 0; i < 10 && !calls; i++) await sleep(10)
  assert.equal(calls, 1)
  const old = ctx.foodRecovery
  ctx.step = 'castle'
  ctx.stepStatus = 'running'
  require('../src/behaviours/food-recovery').invalidate(ctx)
  withdrawal.resolve()
  for (let i = 0; i < 10 && ctx.foodRecoveryFlight; i++) await sleep(10)
  assert.equal(ctx.step, 'castle')
  assert.equal(ctx.stepStatus, 'running')
  assert.equal(ctx.chestFull, true)
  assert.equal(old.chest.phase, 'chestfetch')
  assert.equal(calls, 1)
  assert.equal(closes, 1)
})

it('a hung window ends the step but keeps its flight guard', () => {
  const r = { valid: true, phase: 'chest', startFood: 3 }
  const flight = { owner: r, at: Date.now() - 30001 }
  const ctx = { step: 'foodRecovery', stepStatus: 'running', work: true, foodRecovery: r, foodRecoveryFlight: flight }
  const bot = { health: 5, food: 3, entity: { position: new Vec3(0, 64, 0) } }
  BEHAVIOURS.foodRecovery(bot, ctx)
  assert.equal(ctx.stepStatus, 'done')
  assert.equal(r.valid, false)
  assert.equal(ctx.foodRecoveryFlight, flight)
  assert.ok(ctx.foodRecoveryRetryAt > Date.now())
})

it('an unreachable chest walk ends and backs off without opening', () => {
  let goals = 0
  let opens = 0
  const ctx = { step: 'foodRecovery', stepStatus: 'running', work: true, home: { chest: { x: 20, y: 64, z: 0 } } }
  const bot = {
    health: 5, food: 3, entity: { position: new Vec3(0, 64, 0), onGround: true }, entities: {},
    pathfinder: { setGoal() { goals++ }, isMoving: () => false },
    openChest() { opens++ }, chat() {},
  }
  for (let i = 0; i < 12 && ctx.stepStatus === 'running'; i++) BEHAVIOURS.foodRecovery(bot, ctx)
  assert.equal(ctx.stepStatus, 'done')
  assert.equal(goals, 1)
  assert.equal(opens, 0)
  assert.ok(ctx.foodRecoveryRetryAt > Date.now())
  assert.equal(ctx.foodRecoveryChestSeen.length, 1)
  ctx.stepStatus = 'running'
  ctx.foodRecoveryRetryAt = 0
  for (let i = 0; i < 4 && ctx.stepStatus === 'running'; i++) BEHAVIOURS.foodRecovery(bot, ctx)
  assert.equal(goals, 1, 'a later attempt does not walk to the same unreachable chest')
  assert.equal(opens, 0)
})

it('a failed material leg does not strand a later nearby food source', async () => {
  const previousBody = process.env.BOT_BODY
  process.env.BOT_BODY = 'baritone'
  const transport = new FakeTransport({
    health: 5, food: 3,
    inventory: [{ slot: 9, name: 'stone_pickaxe', count: 1 }, { slot: 10, name: 'stone_sword', count: 1 }, { slot: 11, name: 'dirt', count: 32 }],
  })
  const bot = new BaritoneBot(transport, { Vec3, registry, username: 'IdkBody' })
  await bot.start({ pollMs: 0 })
  try {
    const ctx = {
      home: { built: true },
      castle: { site: { x: 5, y: 64, z: 5 }, rot: 0, blueprintVersion: 1, phase: 'body', blocked: {}, parked: false },
      castleWord: { kind: 'torch', left: 3 }, gear: { saidNeed: 'want-logs' }, stepStatus: 'running',
    }
    resources.noteSpots(ctx, [{ x: 5, y: 60, z: 0, name: 'iron_ore' }], 1000)
    assert.equal((await goal.decide(bot, ctx)).action, 'forage')
    forage(bot, ctx, null, {})
    ctx.lastPathStatus = 'noPath'
    forage(bot, ctx, null, {})
    assert.match(ctx.stepStatus, /^failed:/)
    await goal.decide(bot, ctx)
    assert.ok(ctx.stepFail.forage, 'material failure is recorded')
    const materialFinal = ctx.forageFinal
    transport.state.entities = [{ id: 7, uuid: '22222222-2222-2222-2222-222222222222', type: 'cow', displayName: 'Cow', kind: 'animal', pos: { x: 1, y: 64, z: 0 }, vel: { x: 0, y: 0, z: 0 }, yaw: 0, pitch: 0, health: 20, onGround: true, pose: 'standing' }]
    await bot.refresh()
    for (let i = 0; i < 10 && !(transport.state.attacks || []).length; i++) {
      const decision = await goal.decide(bot, ctx)
      const execute = BEHAVIOURS[decision.action]
      if (execute) await execute(bot, ctx, null, {})
      await sleep(20)
      await bot.refresh()
    }
    assert.deepEqual(transport.state.attacks, [7], `recovery reaches the new food source: ${JSON.stringify(ctx.foodRecovery)}`)
    assert.ok(ctx.stepFail.forage, 'the material cooldown remains recorded')
    assert.equal(ctx.forageFinal, materialFinal, 'the executor failure snapshot remains intact')
  } finally {
    await bot.stop()
    if (previousBody === undefined) delete process.env.BOT_BODY
    else process.env.BOT_BODY = previousBody
  }
})

it('an empty reachable chest is tried once, then recovery backs off', async () => {
  const previousBody = process.env.BOT_BODY
  process.env.BOT_BODY = 'baritone'
  const transport = new FakeTransport({
    health: 5, food: 3, blocks: { '2,64,0': 'chest' },
    containers: { '2,64,0': { type: 'minecraft:generic_9x3', size: 27, title: 'Chest', slots: [] } },
    inventory: [{ slot: 9, name: 'stone_pickaxe', count: 1 }, { slot: 10, name: 'stone_sword', count: 1 }, { slot: 11, name: 'dirt', count: 32 }],
  })
  const bot = new BaritoneBot(transport, { Vec3, registry: require('minecraft-data')('26.1.2'), username: 'IdkBody' })
  await bot.start({ pollMs: 0 })
  try {
    const openChest = bot.openChest.bind(bot)
    let opens = 0
    bot.openChest = (...args) => { opens++; return openChest(...args) }
    const ctx = { home: { built: true, chest: { x: 2, y: 64, z: 0 } }, castle: { site: { x: 5, y: 64, z: 5 }, rot: 0, blueprintVersion: 1, phase: 'body', blocked: {}, parked: false }, gear: { saidNeed: 'want-logs' }, stepStatus: 'running' }
    for (let i = 0; i < 30; i++) {
      const decision = await goal.decide(bot, ctx)
      if (decision.action === 'foodRecovery') BEHAVIOURS.foodRecovery(bot, ctx)
      await sleep(10)
      await bot.refresh()
    }
    assert.equal(opens, 1)
    assert.ok(ctx.foodRecoveryRetryAt > Date.now())
  } finally {
    await bot.stop()
    if (previousBody === undefined) delete process.env.BOT_BODY
    else process.env.BOT_BODY = previousBody
  }
})

it('does not start recovery for a healthy bot, an unknown pack, or an expired gate', async () => {
  const previousBody = process.env.BOT_BODY
  process.env.BOT_BODY = 'baritone'
  const transport = new FakeTransport({ health: 5, food: 3, entities: [{ id: 7, uuid: '22222222-2222-2222-2222-222222222222', type: 'cow', displayName: 'Cow', kind: 'animal', pos: { x: 1, y: 64, z: 0 }, vel: { x: 0, y: 0, z: 0 }, yaw: 0, pitch: 0, health: 20, onGround: true, pose: 'standing' }] })
  const bot = new BaritoneBot(transport, { Vec3, registry, username: 'IdkBody' })
  await bot.start({ pollMs: 0 })
  try {
    const recovery = require('../src/behaviours/food-recovery')
    const ctx = { castle: { site: { x: 5, y: 64, z: 5 }, phase: 'body', parked: false } }
    assert.equal(recovery.available(bot, ctx, { time: 'day', health: 5 }), true)
    assert.equal(recovery.available(bot, ctx, { time: 'day', health: 20 }), false)
    const items = bot.inventory.items
    bot.inventory.items = () => { throw new Error('inventory unready') }
    assert.equal(recovery.available(bot, ctx, { time: 'day', health: 5 }), false)
    bot.inventory.items = items
    ctx.lowHpGateSince = Date.now() - goal.LOW_HP_GATE_MS - 1
    assert.equal(recovery.available(bot, ctx, { time: 'day', health: 5 }), false)
    ctx.lowHpGateSince = Date.now()
    ctx.castle = null
    assert.equal(recovery.available(bot, ctx, { time: 'day', health: 5 }), false)
  } finally {
    await bot.stop()
    if (previousBody === undefined) delete process.env.BOT_BODY
    else process.env.BOT_BODY = previousBody
  }
})
