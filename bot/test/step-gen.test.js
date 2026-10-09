'use strict'

// Step identity (idkcraft-oqul.7): an async op that captured ctx.stepGen at
// its start must not complete a step that replaced it — re-decision, an
// order, a death. A completion of the step that still owns the gen lands.
const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const step = require('../src/step')
const metrics = require('../src/metrics')
const craft = require('../src/behaviours/craft')
const { decide } = require('../src/goal')
const resources = require('../src/resources')
const { createTicker, handleDeath } = require('../src/index')

function pos(x, y, z) {
  const p = { x, y, z, distanceTo: (q) => Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z), clone() { return pos(p.x, p.y, p.z) }, floored() { return pos(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)) } }
  return p
}

async function staleCount() {
  const m = await metrics.stepStaleCompletions.get()
  return m.values.reduce((s, v) => s + v.value, 0)
}

function quiet(fn) {
  const log = console.log
  const err = console.error
  const lines = []
  console.log = (l) => lines.push(String(l))
  console.error = (l) => lines.push(String(l))
  try { return { r: fn(), lines } } finally { console.log = log; console.error = err }
}

// A bot that can run the craft step and a ticker; bot.craft hangs until the
// test rejects it (the late async failure).
function craftBot() {
  let rejectCraft = null
  const bot = {
    username: 'IdkBot',
    chats: [],
    chat(m) { this.chats.push(String(m)) },
    entity: { position: pos(0, 64, 0), onGround: true, isInWater: false },
    inventory: { items: () => [{ name: 'oak_log', count: 3 }] },
    time: { timeOfDay: 6000, day: 1 },
    health: 20,
    food: 20,
    oxygenLevel: 20,
    spawnPoint: pos(0, 64, 0),
    players: {},
    entities: {},
    blockAt: () => null,
    pathfinder: { isMoving: () => false, setGoal() {}, stop() {}, goal: null },
    clearControlStates() {},
    registry: { itemsByName: { oak_log: { id: 17 }, oak_planks: { id: 18 }, crafting_table: { id: 58 }, oak_door: { id: 19 } } },
    recipesFor: (id) => (id === 18 ? [{ result: { name: 'oak_planks', count: 4 } }] : []),
    craft: () => new Promise((_, reject) => { rejectCraft = reject }),
  }
  bot.lateFail = async () => {
    const t0 = Date.now()
    while (!rejectCraft) {
      if (Date.now() - t0 > 5000) throw new Error('craft never started')
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    const log = console.log
    const err = console.error
    console.log = () => {}
    console.error = () => {}
    try {
      rejectCraft(new Error('window closed'))
      for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve))
    } finally { console.log = log; console.error = err }
  }
  return bot
}

describe('step.js gen check (oqul.7)', () => {
  it('no gen = old path; matching gen lands; stale gen drops and counts', async () => {
    const ctx = { step: 'craft', stepStatus: 'running' }
    assert.equal(step.stepFailed(ctx, 'a'), true)
    assert.equal(ctx.stepStatus, 'failed:a')
    const g = step.stepGen(ctx)
    assert.equal(g, 0, 'an unset gen reads 0')
    assert.equal(step.stepDone(ctx, g), true)
    assert.equal(ctx.stepStatus, 'done')
    step.nextStepGen(ctx)
    ctx.stepStatus = 'running'
    const before = await staleCount()
    const { r, lines } = quiet(() => step.stepFailed(ctx, 'b', g))
    assert.equal(r, false)
    assert.equal(ctx.stepStatus, 'running')
    assert.equal(await staleCount(), before + 1)
    assert.deepEqual(lines, ['step stale-completion dropped step=craft gen=0 now=1'])
  })
})

describe('decide bumps the gen on a new step instance only (oqul.7)', () => {
  it('a finished step re-decided bumps; a running re-issue keeps the gen', async () => {
    const bot = { entity: { position: pos(0, 64, 0) }, inventory: { items: () => [{ name: 'stone_pickaxe', count: 1 }] }, time: { timeOfDay: 6000 }, spawnPoint: pos(0, 64, 0), chat() {} }
    const ctx = { home: { built: true, chest: { x: 5, y: 64, z: 1 } }, brain: {}, gear: { saidNeed: 'want-logs' } }
    resources.noteSpots(ctx, [{ x: 5, y: 60, z: 0, name: 'iron_ore' }], 1000)
    assert.equal((await decide(bot, ctx)).action, 'forage')
    const g1 = step.stepGen(ctx)
    assert.ok(g1 > 0, 'the first pick bumps')
    await decide(bot, ctx) // still running, same facts
    assert.equal(step.stepGen(ctx), g1, 'a running step is the same instance')
    ctx.stepStatus = 'failed:unreachable'
    await decide(bot, ctx)
    assert.ok(step.stepGen(ctx) > g1, 'a finished step re-decided is a new instance')
  })
})

describe('late async completion after an interrupt (oqul.7)', () => {
  it('normal: the craft failure lands on its own step', async () => {
    const bot = craftBot()
    const ctx = { lastGoalKey: '', step: 'craft', stepStatus: 'running', home: null }
    craft(bot, ctx, null, {})
    await bot.lateFail()
    assert.equal(ctx.stepStatus, 'failed:craft-oak_planks')
    assert.equal(ctx.craftInFlight, false)
  })

  it('re-decision: a late craft failure leaves the new step untouched', async () => {
    const bot = craftBot()
    const ctx = { lastGoalKey: '', step: 'craft', stepStatus: 'running', home: null }
    craft(bot, ctx, null, {})
    ctx.step = 'gather' // decide picked another step (its bump, pinned above)
    step.nextStepGen(ctx)
    ctx.stepStatus = 'running'
    await bot.lateFail()
    assert.equal(ctx.stepStatus, 'running', 'the new step is not failed')
    assert.equal(ctx.craftInFlight, false, 'the flag still releases')
  })

  it('order: work() resets the step; the late failure drops', async () => {
    const bot = craftBot()
    const ticker = quiet(() => createTicker({ bot, brain: null, tickMs: 10, idleTickMs: 10 })).r
    quiet(() => ticker.work())
    const ctx = bot._tickerCtx
    ctx.step = 'craft'
    ctx.stepStatus = 'running'
    craft(bot, ctx, null, {})
    quiet(() => ticker.work()) // an order: resetNightStep
    assert.equal(ctx.stepStatus, null)
    await bot.lateFail()
    assert.equal(ctx.stepStatus, null, 'no failure left for the next decide to hold')
  })

  it('death: the late failure of the op the death cut drops', async () => {
    const bot = craftBot()
    const ctx = { lastGoalKey: '', step: 'craft', stepStatus: 'running', home: null }
    bot._tickerCtx = ctx
    craft(bot, ctx, null, {})
    quiet(() => handleDeath(bot, null))
    await bot.lateFail()
    assert.equal(ctx.stepStatus, 'running')
    assert.equal(ctx.step, 'craft', 'the step itself survives the death as before')
  })
})
