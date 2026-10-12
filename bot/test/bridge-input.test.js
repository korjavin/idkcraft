'use strict'
// idkcraft-neuc.13: bridge control states. FakeTransport input scripts,
// coalescing, goal-id survival across pause, and the REAL recover.js /
// waterup.js control sequences run unchanged on the adapter.
const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const { BaritoneBot, setBaritonePaused } = require('../src/bridge/index')
const { FakeTransport } = require('../src/bridge/transport')
const Vec3 = require('vec3')
const { goals } = require('mineflayer-pathfinder')
const recover = require('../src/behaviours/recover')
const waterup = require('../src/behaviours/waterup')

const REGISTRY = { blocksByName: { air: { id: 0 }, dirt: { id: 1 }, stone: { id: 2 } } }
function make(state = {}) {
  const transport = new FakeTransport({ pos: { x: 0, y: 64, z: 0, yaw: 0, pitch: 0, onGround: true }, ...state })
  const bot = new BaritoneBot(transport, { Vec3, registry: REGISTRY, username: 'IdkBody' })
  return { transport, bot }
}

describe('bridge input (neuc.13)', () => {
  it('mirrors mineflayer controls, validates names, coalesces one tick into one input.set', async () => {
    const { transport, bot } = make()
    await bot.start({ pollMs: 0 })
    try {
      bot.setControlState('forward', true)
      bot.setControlState('sneak', true)
      bot.setControlState('jump', true)
      bot.setControlState('jump', true) // no-op, mineflayer parity
      assert.equal(bot.controlState.forward, true)
      assert.equal(bot.getControlState('sneak'), true)
      await bot._flushInput()
      assert.deepEqual(transport.state.inputLog, [{ set: { forward: true, sneak: true, jump: true } }])
      assert.equal(transport.state.inputPaused, true)
      // Diff only: releasing one key sends only that key.
      bot.setControlState('jump', false)
      await bot._flushInput()
      assert.deepEqual(transport.state.inputLog[1], { set: { jump: false } })
      assert.throws(() => bot.setControlState('fly', true), /invalid control/)
      assert.throws(() => bot.getControlState('fly'), /invalid control/)
      assert.throws(() => bot.setControlState('jump', 1), /invalid state/)
    } finally { await bot.stop() }
  })

  it('clearControlStates sends input.clear, releases mirror, resumes (goal id kept)', async () => {
    const { transport, bot } = make()
    await bot.start({ pollMs: 0 })
    try {
      bot.pathfinder.setGoal(new goals.GoalNear(10, 64, 10, 1))
      await new Promise((r) => setTimeout(r, 10))
      const goalId = bot._goalId
      bot.setControlState('forward', true)
      await bot._flushInput()
      assert.equal(transport.state.inputPaused, true)
      bot.clearControlStates()
      await bot._flushInput()
      assert.deepEqual(transport.state.inputLog.at(-1), { clear: true })
      assert.equal(bot.getControlState('forward'), false)
      assert.equal(transport.state.inputPaused, false)
      assert.equal(bot._goalId, goalId, 'pause/resume must not lose the latched goal id')
      assert.equal(bot._goalCmd, '#goto 10 64 10')
      // Idle clear is a no-op (no spam).
      const n = transport.state.inputLog.length
      bot.clearControlStates()
      await bot._flushInput()
      assert.equal(transport.state.inputLog.length, n)
    } finally { await bot.stop() }
  })

  it('state.get input.states reconciles the mirror when idle', async () => {
    const { transport, bot } = make()
    await bot.start({ pollMs: 0 })
    try {
      transport.state.input.jump = true // mod-side held (e.g. rejoin snapshot)
      await bot.refresh()
      assert.equal(bot.getControlState('jump'), true)
      assert.equal(bot.controlState.jump, true)
    } finally { await bot.stop() }
  })

  it('setBaritonePaused helper sends #pause/#resume for neuc.9 reuse', async () => {
    const { transport, bot } = make()
    assert.equal(await setBaritonePaused(bot, true), true)
    assert.equal(transport.state.baritone, '#pause')
    assert.equal(await setBaritonePaused(bot, false), true)
    assert.equal(transport.state.baritone, '#resume')
    assert.equal(await setBaritonePaused(null, true), false)
  })

  it('REAL recover.js pillarUpRun first tick holds jump through the adapter', async () => {
    const { transport, bot } = make({ inventory: [{ slot: 0, name: 'dirt', count: 3, type: 1 }] })
    await bot.start({ pollMs: 0 })
    try {
      const ctx = { recovery: {} }
      const out = recover.pillarUpRun(bot, ctx)
      assert.equal(out, 'running')
      assert.equal(bot.getControlState('jump'), true)
      await bot._flushInput()
      assert.equal(transport.state.input.jump, true)
      assert.equal(transport.state.inputPaused, true)
    } finally { await bot.stop() }
  })

  it('REAL waterup.js waterUpRun fresh tick clears controls, then fails no-bucket with keys off', async () => {
    const { transport, bot } = make({ inventory: [] })
    bot.lookAt = async () => {} // neuc.9 surface, stubbed until it lands
    bot.activateItem = () => {}
    await bot.start({ pollMs: 0 })
    try {
      bot.setControlState('jump', true)
      await bot._flushInput()
      const ctx = { recovery: {} }
      const out = waterup.waterUpRun(bot, ctx)
      assert.equal(out, 'failed:no-bucket')
      await bot._flushInput()
      assert.equal(bot.getControlState('jump'), false)
      assert.equal(bot.getControlState('sneak'), false)
      assert.equal(transport.state.input.jump, false)
    } finally { await bot.stop() }
  })
})
