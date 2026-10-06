'use strict'

// idkcraft-vmzq.2: task progress gauges + stall invariant + L1 honest line.
// Unit-tests the clock with a fake ctx/clock (no world, no castle ticks).

const { describe, it, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const taskMod = require('../src/task')
const metrics = require('../src/metrics')
const { createTicker } = require('../src/index')

const L1 = taskMod.TASK_STALL_L1_MS
assert.equal(L1, 15 * 60 * 1000, 'L1 is 15 min')

function pos(x, y, z) {
  return { x, y, z, distanceTo: (q) => Math.hypot(x - q.x, y - q.y, z - q.z) }
}

function makeBot({ timeOfDay = 6000, items = null } = {}) {
  const inv = items || [{ name: 'cobblestone', count: 20 }]
  return {
    username: 'IdkBot',
    chats: [],
    chat(m) { this.chats.push(String(m)) },
    entity: { position: pos(100, 64, 200) },
    inventory: { items: () => inv },
    time: { timeOfDay, day: 1 },
    spawnPoint: pos(0, 64, 0),
    players: {},
    // Unloaded world (null): menuFact keeps the last progress/word instead
    // of rescanning, so the fake ctx values below stand.
    blockAt: () => null,
    pathfinder: { isMoving: () => false, setGoal() {}, stop() {}, goal: null },
    clearControlStates() {},
  }
}

function castleCtx(bot, { done = 8, total = 1722, phase = 'body', kind = 'stone', left = 80 } = {}) {
  const ticker = createTicker({ bot, brain: null, tickMs: 10, idleTickMs: 10 })
  const st = { site: { x: 100, y: 64, z: 200 }, rot: 0, phase, blocked: {}, parked: false, progress: { done, total } }
  ticker.setCastle(st)
  ticker.work()
  const ctx = bot._tickerCtx
  ctx.castleWord = { kind, left }
  ctx.step = 'castlefetch'
  ctx.stepStatus = 'running'
  ctx.stepPick = { step: 'castlefetch', at: Date.now() - 5000, source: 'goal-fsm', why: 'fetch stone' }
  return { ticker, ctx }
}

let origLog = null
let lines = []
beforeEach(() => {
  lines = []
  origLog = console.log
  console.log = (m) => { lines.push(String(m)) }
})
afterEach(() => { console.log = origLog })

function taskLogs() {
  return lines.filter((l) => l.startsWith('task castle ') || l.startsWith('task house '))
}

describe('task stall clock (vmzq.2)', () => {
  it('eligible ticks without progress for 15 min -> exactly one L1 log+chat', () => {
    const bot = makeBot()
    const { ctx } = castleCtx(bot)
    const t0 = 1000000000000
    taskMod.taskTick(bot, ctx, t0)
    assert.equal(taskLogs().length, 0)
    assert.equal(bot.chats.length, 0)
    // 14 min of day/work ticks: silent.
    for (let s = 1; s <= 14 * 60; s++) taskMod.taskTick(bot, ctx, t0 + s * 1000)
    assert.equal(taskLogs().length, 0, 'no L1 before 15 min')
    assert.equal(bot.chats.length, 0)
    // The 15th minute trips exactly one L1.
    for (let s = 14 * 60 + 1; s <= 15 * 60; s++) taskMod.taskTick(bot, ctx, t0 + s * 1000)
    assert.equal(taskLogs().length, 1, 'one L1 log line')
    assert.equal(bot.chats.length, 1, 'one L1 chat line')
    assert.match(taskLogs()[0], /^task castle 8\/1722 stall=900s step=castlefetch why=step=castlefetch running/)
    assert.match(bot.chats[0], /^castle: no progress for 15 min at 8\/1722 — step=castlefetch running.*; still trying$/)
    // Further stalled ticks stay silent until the 15 min repeat.
    for (let s = 15 * 60 + 1; s <= 29 * 60; s++) taskMod.taskTick(bot, ctx, t0 + s * 1000)
    assert.equal(taskLogs().length, 1, 'no repeat before 15 min')
    assert.equal(bot.chats.length, 1)
    for (let s = 29 * 60 + 1; s <= 30 * 60 + 1; s++) taskMod.taskTick(bot, ctx, t0 + s * 1000)
    assert.equal(taskLogs().length, 2, 'repeat at 15 min')
    assert.equal(bot.chats.length, 2)
  })

  it('cell progress resets the clock', () => {
    const bot = makeBot()
    const { ctx } = castleCtx(bot)
    const t0 = 1000000000000
    taskMod.taskTick(bot, ctx, t0)
    for (let s = 1; s <= 14 * 60; s++) taskMod.taskTick(bot, ctx, t0 + s * 1000)
    ctx.castle.progress.done = 9
    taskMod.taskTick(bot, ctx, t0 + (14 * 60 + 1) * 1000)
    assert.equal(taskLogs().length, 0, 'progress at 14 min prevents the L1')
    // A fresh 15 min stall from here trips again.
    for (let s = 1; s <= 15 * 60; s++) taskMod.taskTick(bot, ctx, t0 + (14 * 60 + 1 + s) * 1000)
    assert.equal(taskLogs().length, 1)
    assert.match(taskLogs()[0], /^task castle 9\/1722 stall=900s/)
  })

  it('material on hand resets the clock (quarry trip is not a stall)', () => {
    const items = [{ name: 'cobblestone', count: 20 }]
    const bot = makeBot({ items })
    const { ctx } = castleCtx(bot)
    const t0 = 1000000000000
    taskMod.taskTick(bot, ctx, t0)
    for (let s = 1; s <= 14 * 60; s++) taskMod.taskTick(bot, ctx, t0 + s * 1000)
    items[0].count = 40 // +20 stone quarried, no cells laid yet
    taskMod.taskTick(bot, ctx, t0 + (14 * 60 + 1) * 1000)
    assert.equal(taskLogs().length, 0, 'quarried stone resets')
    // The demanded remainder shrinking resets too.
    for (let s = 1; s <= 14 * 60; s++) taskMod.taskTick(bot, ctx, t0 + (14 * 60 + 1 + s) * 1000)
    ctx.castleWord.left = 70
    taskMod.taskTick(bot, ctx, t0 + (28 * 60 + 2) * 1000)
    assert.equal(taskLogs().length, 0, 'shrinking remainder resets')
  })

  it('prep progress resets the clock', () => {
    const castle = require('../src/behaviours/castle')
    const origPrep = castle.prepTargets
    try {
      let n = 50
      castle.prepTargets = () => new Array(n).fill({ idx: 1 })
      const bot = makeBot()
      const { ctx } = castleCtx(bot, { phase: 'prep', done: 0 })
      const t0 = 1000000000000
      taskMod.taskTick(bot, ctx, t0)
      for (let s = 1; s <= 14 * 60; s++) taskMod.taskTick(bot, ctx, t0 + s * 1000)
      n = 40 // ten prep cells cleared
      taskMod.taskTick(bot, ctx, t0 + (14 * 60 + 1) * 1000)
      assert.equal(taskLogs().length, 0, 'prep work resets')
    } finally {
      castle.prepTargets = origPrep
    }
  })

  it('night, paused and order ticks do not advance', () => {
    const bot = makeBot()
    const { ctx } = castleCtx(bot)
    const t0 = 1000000000000
    taskMod.taskTick(bot, ctx, t0)
    // 20 min of night ticks: silent, clock held.
    bot.time.timeOfDay = 14000
    for (let s = 1; s <= 20 * 60; s++) taskMod.taskTick(bot, ctx, t0 + s * 1000)
    assert.equal(taskLogs().length, 0)
    assert.equal(ctx.task.castle.stallMs, 0)
    // 20 min paused at day: silent.
    bot.time.timeOfDay = 6000
    ctx.paused = true
    for (let s = 1; s <= 20 * 60; s++) taskMod.taskTick(bot, ctx, t0 + (20 * 60 + s) * 1000)
    assert.equal(taskLogs().length, 0)
    assert.equal(ctx.task.castle.stallMs, 0)
    // 20 min under a lead order: silent.
    ctx.paused = false
    ctx.lead = { name: 'Steve', by: 'Steve' }
    for (let s = 1; s <= 20 * 60; s++) taskMod.taskTick(bot, ctx, t0 + (40 * 60 + s) * 1000)
    assert.equal(taskLogs().length, 0)
    assert.equal(ctx.task.castle.stallMs, 0)
    for (const order of ['bring', 'comehome', 'gocastle']) {
      ctx.lead = null
      ctx[order] = { phase: 'walk' }
      taskMod.taskTick(bot, ctx, t0 + (60 * 60 + 1) * 1000)
      assert.equal(ctx.task.castle.stallMs, 0, `${order} pauses the clock`)
      ctx[order] = null
    }
  })

  it('fight and shelter ticks DO advance (no decision/inShelter gate)', () => {
    const bot = makeBot()
    const { ctx } = castleCtx(bot)
    ctx.inShelter = true // the 2 h dig-in freeze shape: sheltered fight ticks
    const t0 = 1000000000000
    taskMod.taskTick(bot, ctx, t0)
    for (let s = 1; s <= 15 * 60; s++) taskMod.taskTick(bot, ctx, t0 + s * 1000)
    assert.equal(taskLogs().length, 1, 'sheltered ticks count toward the stall')
    assert.equal(bot.chats.length, 1)
  })

  it('regress sinks the baseline without resetting (repair re-arms)', () => {
    const bot = makeBot()
    const { ctx } = castleCtx(bot)
    const t0 = 1000000000000
    taskMod.taskTick(bot, ctx, t0)
    for (let s = 1; s <= 10 * 60; s++) taskMod.taskTick(bot, ctx, t0 + s * 1000)
    ctx.castle.progress.done = 5 // creeper hole: 8 -> 5
    taskMod.taskTick(bot, ctx, t0 + (10 * 60 + 1) * 1000)
    assert.equal(ctx.task.castle.stallMs, 601000, 'stall continues through regress')
    assert.equal(ctx.task.castle.done, 5, 'baseline sinks')
    ctx.castle.progress.done = 6 // repair: first block back resets
    taskMod.taskTick(bot, ctx, t0 + (10 * 60 + 2) * 1000)
    assert.equal(ctx.task.castle.stallMs, 0)
  })

  it('failed reasons since progress ride the diagnosis (last 3 distinct)', () => {
    const bot = makeBot()
    const { ctx } = castleCtx(bot)
    const t0 = 1000000000000
    taskMod.taskTick(bot, ctx, t0)
    ctx.step = 'equip'
    ctx.stepStatus = 'failed:craft-stall'
    taskMod.taskTick(bot, ctx, t0 + 1000)
    ctx.step = 'castlefetch'
    ctx.stepStatus = 'failed:no-stone'
    taskMod.taskTick(bot, ctx, t0 + 2000)
    ctx.stepStatus = 'failed:no-stone' // duplicate: kept once
    taskMod.taskTick(bot, ctx, t0 + 3000)
    ctx.step = 'equip'
    ctx.stepStatus = 'failed:craft-stall' // duplicate: kept once
    taskMod.taskTick(bot, ctx, t0 + 4000)
    ctx.step = 'gather'
    ctx.stepStatus = 'failed:no-trees'
    taskMod.taskTick(bot, ctx, t0 + 5000)
    const d = taskMod.diagnose(bot, ctx)
    assert.match(d, /failed: equip:craft-stall, castlefetch:no-stone, gather:no-trees/)
    // Progress clears the list (the stepStatus itself belongs to the step).
    ctx.castle.progress.done = 9
    ctx.stepStatus = 'running'
    taskMod.taskTick(bot, ctx, t0 + 6000)
    assert.doesNotMatch(taskMod.diagnose(bot, ctx), /; failed:/)
  })

  it('resetTask clears the clock (stop/go/go-work/new-task seam)', () => {
    const bot = makeBot()
    const { ctx } = castleCtx(bot)
    const t0 = 1000000000000
    taskMod.taskTick(bot, ctx, t0)
    for (let s = 1; s <= 10 * 60; s++) taskMod.taskTick(bot, ctx, t0 + s * 1000)
    assert.ok(ctx.task.castle.stallMs > 0)
    taskMod.resetTask(ctx)
    assert.equal(ctx.task, null)
    taskMod.taskTick(bot, ctx, t0 + (10 * 60 + 1) * 1000)
    assert.equal(ctx.task.castle.stallMs, 0, 're-baselined, no advance on the reset tick')
  })

  it('/metrics exports the task gauges and the L1 counter', async () => {
    const bot = makeBot()
    const { ctx } = castleCtx(bot)
    taskMod.taskTick(bot, ctx, 1000000000000)
    const text = await metrics.client.register.metrics()
    assert.match(text, /idkcraft_bot_task_progress\{task="castle"\} 8/)
    assert.match(text, /idkcraft_bot_task_total\{task="castle"\} 1722/)
    assert.match(text, /idkcraft_bot_task_stall_seconds\{task="castle"\} 0/)
    // Trip an L1 and watch the counter move.
    const t0 = 1000000000000
    for (let s = 1; s <= 15 * 60; s++) taskMod.taskTick(bot, ctx, t0 + s * 1000)
    const text2 = await metrics.client.register.metrics()
    assert.match(text2, /idkcraft_bot_task_stall_total\{task="castle",level="L1"\} [1-9]/)
  })

  it('status shows the task line when a task exists', () => {
    const bot = makeBot()
    const { ticker, ctx } = castleCtx(bot)
    const t0 = 1000000000000
    taskMod.taskTick(bot, ctx, t0)
    for (let s = 1; s <= 23 * 60; s++) taskMod.taskTick(bot, ctx, t0 + s * 1000)
    assert.equal(taskMod.taskLine(ctx), 'task castle 8/1722 stall=23m')
    const before = bot.chats.length
    ticker.status()
    const after = bot.chats.slice(before)
    assert.ok(after.some((l) => l === 'task castle 8/1722 stall=23m'), JSON.stringify(after))
    // No task, no line.
    ticker.setCastle(null)
    assert.equal(taskMod.taskLine(ctx), null)
  })

  it('house task: placed cells, active while unbuilt', () => {
    const bot = makeBot()
    const ticker = createTicker({ bot, brain: null, tickMs: 10, idleTickMs: 10 })
    // Fake a built-nothing site: blockAt reads air everywhere, so 0 placed.
    ticker.setHome({ site: { x: 0, y: 64, z: 0 }, built: false, v: 2 })
    ticker.work()
    const ctx = bot._tickerCtx
    const t0 = 1000000000000
    taskMod.taskTick(bot, ctx, t0)
    assert.equal(ctx.task.active, 'house')
    assert.equal(taskMod.taskLine(ctx), 'task house 0/99 stall=0s')
    for (let s = 1; s <= 15 * 60; s++) taskMod.taskTick(bot, ctx, t0 + s * 1000)
    assert.equal(taskLogs().length, 1)
    assert.match(bot.chats[0], /^house: no progress for 15 min at 0\/99/)
  })
})
