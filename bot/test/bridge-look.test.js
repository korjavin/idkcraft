// idkcraft-neuc.9: look/attack/interact/sleep over the bridge. The REAL
// BaritoneBot adapter + REAL eatReflex (reflexes.js) run unchanged against
// FakeTransport fixtures shaped like the mod's look.* wire (PROTOCOL.md).
'use strict'

const { describe, it, afterEach } = require('node:test')
const assert = require('node:assert/strict')

const Vec3 = require('vec3')
const { goals } = require('mineflayer-pathfinder')
const { BaritoneBot } = require('../src/bridge/index')
const { FakeTransport } = require('../src/bridge/transport')
const { eatReflex } = require('../src/reflexes')

const REGISTRY = { blocksByName: { air: { id: 0 } }, entitiesByName: {} }
const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms))

async function lookBot(state = {}) {
  const transport = new FakeTransport({
    pos: { x: 0, y: 64, z: 0, yaw: 0, pitch: 0, onGround: true, vel: { x: 0, y: 0, z: 0 } },
    ...state,
  })
  const bot = new BaritoneBot(transport, { Vec3, registry: REGISTRY, username: 'IdkBody' })
  await bot.start({ pollMs: 0 })
  return { transport, bot }
}

describe('bridge look/lookAt (idkcraft-neuc.9)', () => {
  let bot
  afterEach(async () => { if (bot) await bot.stop(); bot = null })

  it('lookAt aims the four cardinal directions with mineflayer yaw', async () => {
    let transport
    ;({ transport, bot } = await lookBot())
    // Eye at (0, 65.62, 0): mineflayer yaw = atan2(-dx, -dz).
    const cases = [
      [new Vec3(0, 65.62, -10), 0, 'north'],
      [new Vec3(0, 65.62, 10), Math.PI, 'south'],
      [new Vec3(10, 65.62, 0), -Math.PI / 2, 'east'],
      [new Vec3(-10, 65.62, 0), Math.PI / 2, 'west'],
    ]
    for (const [point, wantYaw, label] of cases) {
      await bot.lookAt(point)
      const got = Math.abs(bot.entity.yaw) === Math.PI ? Math.PI : bot.entity.yaw
      assert.ok(Math.abs(got - wantYaw) < 1e-9, `${label}: yaw ${bot.entity.yaw} != ${wantYaw}`)
      assert.equal(bot.entity.pitch, 0, label)
    }
    assert.equal(transport.state.lookLog.filter((l) => l.method === 'look.at').length, 4)
  })

  it('look skips sub-degree changes (reflex tick cheapness) but force sends', async () => {
    let transport
    ;({ transport, bot } = await lookBot())
    await bot.look(1, 0) // baseline, crosses the wire
    assert.equal(transport.state.lookLog.length, 1)
    await bot.look(1 + Math.PI / 360, 0) // +0.5 deg: skipped
    assert.equal(transport.state.lookLog.length, 1)
    assert.ok(Math.abs(bot.entity.yaw - (1 + Math.PI / 360)) < 1e-12) // local still tracks
    await bot.look(1 + Math.PI / 360, 0, true) // forced: sends
    assert.equal(transport.state.lookLog.length, 2)
  })

  it('attack pauses and resumes Baritone around the hit while pathing', async () => {
    let transport
    ;({ transport, bot } = await lookBot())
    bot.pathfinder.setGoal(new goals.GoalNear(10, 64, 10, 1))
    await tick()
    assert.equal(bot.pathfinder.isMoving(), true)
    const seqBefore = transport.state.baritoneSeq
    bot.attack({ id: 42 })
    await tick(150) // pause + resume + the one-tick status wait
    assert.deepEqual(transport.state.attacks, [42])
    assert.deepEqual(transport.state.baritonePauses, ['#pause', '#resume'])
    assert.equal(bot.pathfinder.isMoving(), true) // goal survived the pause
    assert.equal(transport.state.baritoneSeq, seqBefore) // and was NOT re-issued (fresh post-resume status)
  })

  it('a refresh during a pause does not verdict the live goal', async () => {
    let transport
    ;({ transport, bot } = await lookBot())
    bot.pathfinder.setGoal(new goals.GoalNear(10, 64, 10, 1))
    await tick()
    let resets = 0
    bot.on('path_reset', () => { resets++ })
    transport.state.baritoneStatus = { id: bot._goalId, pathing: false, last: 'success' }
    transport.state.baritonePhase = 1
    bot._pausedDepth = 1 // withBaritonePaused outstanding
    await bot.refresh()
    assert.equal(resets, 0)
    assert.equal(bot.pathfinder.isMoving(), true)
    bot._pausedDepth = 0
    await bot.refresh()
    assert.equal(resets, 1) // the same verdict lands once the pause lifts
  })

  it('re-issues the latched goal when Baritone drops it silently during a pause', async () => {
    let transport
    ;({ transport, bot } = await lookBot())
    bot.pathfinder.setGoal(new goals.GoalNear(10, 64, 10, 1))
    await tick()
    const seqBefore = transport.state.baritoneSeq
    // Baritone cancelled without a terminal: status for our id, idle, none.
    transport.state.baritoneStatus = { id: bot._goalId, pathing: false, last: 'none' }
    transport.state.baritonePhase = 1
    bot.attack({ id: 7 })
    await tick(150) // pause + resume + the one-tick status wait
    assert.ok(transport.state.baritoneSeq > seqBefore, 'latched goal re-issued after resume')
  })

  it('activateBlock looks at the centre and interacts with the mapped face; doors are a no-op while moving', async () => {
    let transport
    ;({ transport, bot } = await lookBot({ blocks: { '5,64,5': 'chest', '6,64,5': 'oak_door' } }))
    const chest = { name: 'chest', position: new Vec3(5, 64, 5) }
    await bot.activateBlock(chest, new Vec3(0, 0, -1))
    assert.deepEqual(transport.state.blockInteracts, [
      { x: 5, y: 64, z: 5, face: 'north', cursor: { x: 0.5, y: 0.5, z: 0.5 }, sneak: false },
    ])
    bot.pathfinder.setGoal(new goals.GoalNear(10, 64, 10, 1))
    await tick()
    await bot.activateBlock({ name: 'oak_door', position: new Vec3(6, 64, 5) })
    assert.equal(transport.state.blockInteracts.length, 1) // Baritone opens it; no double-toggle
  })

  it('activateItem/deactivateItem start and stop the held-item use', async () => {
    let transport
    ;({ transport, bot } = await lookBot())
    bot.activateItem()
    await tick()
    assert.deepEqual(transport.state.itemUses, [{ hand: 'main' }])
    assert.equal(bot.usingHeldItem, true)
    bot.deactivateItem()
    await tick()
    assert.equal(transport.state.usingItem, false)
    assert.equal(bot.usingHeldItem, false)
  })

  it('waitForTicks waits n*50 ms', async () => {
    ;({ bot } = await lookBot())
    const t0 = Date.now()
    await bot.waitForTicks(2)
    assert.ok(Date.now() - t0 >= 90)
    await bot.waitForTicks(0) // no-op, must not hang
  })
})

describe('bridge consume/sleep (idkcraft-neuc.9)', () => {
  let bot
  afterEach(async () => { if (bot) await bot.stop(); bot = null })

  it('the REAL eatReflex eats bread when food < 18', async () => {
    let transport
    ;({ transport, bot } = await lookBot({
      food: 10,
      inventory: [{ slot: 0, name: 'bread', count: 2 }],
      eatDelayMs: 80,
    }))
    const ctx = {}
    assert.equal(eatReflex(bot, ctx, {}), true)
    assert.equal(ctx.eatInFlight, true)
    for (let i = 0; i < 40 && ctx.eatInFlight; i++) await tick(25)
    assert.equal(ctx.eatInFlight, false)
    assert.equal(transport.state.inventory[0].count, 1) // one bread consumed
    assert.equal(transport.state.itemUses.length, 1)
  })

  it('consume rejects with mineflayer\'s message at full food', async () => {
    ;({ bot } = await lookBot({ food: 20, inventory: [{ slot: 0, name: 'bread', count: 1 }] }))
    await assert.rejects(() => bot.consume(), /Food is full/)
  })

  it('consume rejects visibly when nothing is eaten in the window', async () => {
    ;({ bot } = await lookBot({ food: 10, inventory: [{ slot: 0, name: 'bread', count: 1 }] }))
    await assert.rejects(() => bot.consume(), /not consumed/)
  })

  it('overlapping interactions share one pause/resume pair (refcounted)', async () => {
    let transport
    ;({ transport, bot } = await lookBot())
    bot.pathfinder.setGoal(new goals.GoalNear(10, 64, 10, 1))
    await tick()
    bot.attack({ id: 5 }) // fire-and-forget, overlaps the awaited lookAt
    await bot.lookAt(new Vec3(5, 65, 5))
    await tick(60)
    assert.deepEqual(transport.state.baritonePauses, ['#pause', '#resume'])
    assert.deepEqual(transport.state.attacks, [5])
  })

  it('sleep clicks the bed, wake flips back on the mod notification', async () => {
    let transport
    ;({ transport, bot } = await lookBot({ blocks: { '3,64,3': 'red_bed' } }))
    const bed = { name: 'red_bed', position: new Vec3(3, 64, 3) }
    await assert.rejects(() => bot.wake(), /already awake/)
    await bot.sleep(bed)
    assert.equal(bot.isSleeping, true)
    assert.deepEqual(transport.state.sleepCalls, [{ x: 3, y: 64, z: 3 }])
    await assert.rejects(() => bot.sleep(bed), /already sleeping/)
    let wakes = 0
    bot.on('wake', () => { wakes++ })
    await bot.wake()
    transport.inject('wake', {})
    assert.equal(bot.isSleeping, false)
    assert.equal(wakes, 1)
    await assert.rejects(() => bot.sleep({ name: 'stone', position: new Vec3(0, 64, 0) }), /not a bed/)
  })
})
