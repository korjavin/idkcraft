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
    entity: { position: pos(100, 64, 200), onGround: true, isInWater: false },
    inventory: { items: () => inv },
    time: { timeOfDay, day: 1 },
    health: 20,
    food: 20,
    oxygenLevel: 20,
    spawnPoint: pos(0, 64, 0),
    players: {},
    entities: {},
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
    // Further stalled ticks stay silent until the 15 min throttle passes.
    for (let s = 15 * 60 + 1; s <= 29 * 60; s++) taskMod.taskTick(bot, ctx, t0 + s * 1000)
    assert.equal(taskLogs().length, 1, 'no repeat before 15 min')
    assert.equal(bot.chats.length, 1)
    // Identical diagnosis stays deduped past the throttle (sayBlocked rule).
    for (let s = 29 * 60 + 1; s <= 30 * 60 + 1; s++) taskMod.taskTick(bot, ctx, t0 + s * 1000)
    assert.equal(taskLogs().length, 1, 'same diagnosis does not repeat')
    assert.equal(bot.chats.length, 1)
    // A changed diagnosis would repeat the L1 — but the stall ends at
    // 45:01, so the L2 park fires first and supersedes the second L1 (one
    // line, not 'still trying' + 'parked' back to back). The changed-
    // diagnosis repeat itself is pinned while parked in task-park.test.js.
    ctx.step = 'equip'
    ctx.stepStatus = 'failed:craft-stall'
    for (let s = 1; s <= 15 * 60; s++) taskMod.taskTick(bot, ctx, t0 + (30 * 60 + 1 + s) * 1000)
    assert.equal(taskLogs().filter((l) => !l.includes('parked')).length, 1, 'no second L1 at the park tick')
    assert.equal(bot.chats.filter((c) => c.startsWith('castle: no progress')).length, 1)
    assert.equal(taskLogs().filter((l) => l.includes('parked')).length, 1, 'L2 parks at 45 min')
    assert.equal(bot.chats.filter((c) => c.includes('parked at')).length, 1)
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
      castle.prepTargets = (bot, ctx) => {
        ctx.castlePrep = { unknown: 0 }
        return new Array(n).fill({ idx: 1 })
      }
      const bot = makeBot()
      bot.blockAt = () => ({ name: 'dirt', boundingBox: 'block' }) // loaded site
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

  it('unloaded prep scan holds the last value (core-2)', () => {
    const castle = require('../src/behaviours/castle')
    const origPrep = castle.prepTargets
    try {
      let n = 50
      let unknown = 0
      castle.prepTargets = (bot, ctx) => {
        ctx.castlePrep = { unknown }
        return new Array(n).fill({ idx: 1 })
      }
      const bot = makeBot()
      bot.blockAt = () => ({ name: 'dirt', boundingBox: 'block' })
      const { ctx } = castleCtx(bot, { phase: 'prep', done: 0 })
      const t0 = 1000000000000
      taskMod.taskTick(bot, ctx, t0)
      assert.equal(ctx.task.castle.prepLeft, 50)
      // Trip off site: partial scan reads short, held, clock advances.
      unknown = 12
      n = 5
      taskMod.taskTick(bot, ctx, t0 + 1000)
      assert.equal(ctx.task.castle.prepLeft, 50, 'partial scan does not move the baseline')
      assert.equal(ctx.task.castle.stallMs, 1000)
      // Back on site, same work left: no false progress.
      unknown = 0
      n = 50
      taskMod.taskTick(bot, ctx, t0 + 2000)
      assert.equal(ctx.task.castle.stallMs, 2000, 'return trip is not progress')
      assert.equal(taskLogs().length, 0)
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
    bot.blockAt = () => ({ name: 'air', boundingBox: 'empty' }) // loaded, nothing placed
    const ticker = createTicker({ bot, brain: null, tickMs: 10, idleTickMs: 10 })
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

  it('unloaded house holds the baseline (core-1)', () => {
    const bot = makeBot()
    let loaded = true
    // 30 cells read placed while loaded (planks on the first 30 plan cells).
    const build = require('../src/behaviours/build')
    const home = { site: { x: 0, y: 64, z: 0 }, built: false, v: 2 }
    const plan = build.blueprintFor(home)
    const placed = new Set(plan.slice(0, 30).map((c) => `${home.site.x + c.dx},${home.site.y + c.dy},${home.site.z + c.dz}`))
    bot.blockAt = (p) => {
      if (!loaded) return null
      const k = `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`
      if (placed.has(k)) return { name: 'oak_planks', boundingBox: 'block' }
      return { name: 'air', boundingBox: 'empty' }
    }
    const ticker = createTicker({ bot, brain: null, tickMs: 10, idleTickMs: 10 })
    ticker.setHome(home)
    ticker.work()
    const ctx = bot._tickerCtx
    const t0 = 1000000000000
    taskMod.taskTick(bot, ctx, t0)
    // Table (plan[0]) and door (plan[27]) are not planks: 28 of 30 read placed.
    assert.equal(ctx.task.house.done, 28)
    // Walk out of range: the reading would be 0/99, held instead.
    loaded = false
    for (let s = 1; s <= 61; s++) taskMod.taskTick(bot, ctx, t0 + s * 1000) // past the 60 s cache
    assert.equal(ctx.task.house.done, 28, 'unloaded read does not sink the baseline')
    assert.equal(ctx.task.house.stallMs, 61000)
    // Back on site, same 28: no false progress.
    loaded = true
    for (let s = 62; s <= 122; s++) taskMod.taskTick(bot, ctx, t0 + s * 1000)
    assert.equal(ctx.task.house.stallMs, 122000, 'return trip is not progress')
    assert.equal(taskLogs().length, 0)
  })

  it('material oscillation does not reset (core-3 high-water)', () => {
    const items = [{ name: 'cobblestone', count: 20 }]
    const bot = makeBot({ items })
    const { ctx } = castleCtx(bot)
    const t0 = 1000000000000
    taskMod.taskTick(bot, ctx, t0)
    // Place 1 cobble (scaffold), dig it back: net zero.
    items[0].count = 19
    taskMod.taskTick(bot, ctx, t0 + 1000)
    assert.equal(ctx.task.castle.stallMs, 1000, 'spend does not reset')
    items[0].count = 20
    taskMod.taskTick(bot, ctx, t0 + 2000)
    assert.equal(ctx.task.castle.stallMs, 2000, 'net-zero regain does not reset')
    // A genuine gain above the high-water mark resets.
    items[0].count = 30
    taskMod.taskTick(bot, ctx, t0 + 3000)
    assert.equal(ctx.task.castle.stallMs, 0)
  })

  it('castle growth resets the house clock while the castle step runs (body-2)', () => {
    const bot = makeBot()
    bot.blockAt = () => ({ name: 'air', boundingBox: 'empty' })
    const ticker = createTicker({ bot, brain: null, tickMs: 10, idleTickMs: 10 })
    ticker.setHome({ site: { x: 0, y: 64, z: 0 }, built: false, v: 2 })
    ticker.setCastle({ site: { x: 100, y: 64, z: 200 }, rot: 0, phase: 'body', blocked: {}, parked: false, progress: { done: 8, total: 1722 } })
    ticker.work()
    const ctx = bot._tickerCtx
    ctx.step = 'castle'
    ctx.stepStatus = 'running'
    ctx.castleWord = { kind: 'stone', left: 80 }
    const t0 = 1000000000000
    taskMod.taskTick(bot, ctx, t0)
    assert.equal(ctx.task.active, 'house')
    taskMod.taskTick(bot, ctx, t0 + 1000)
    assert.equal(ctx.task.house.stallMs, 1000)
    ctx.castle.progress.done = 9 // the castle grew under the castle step
    taskMod.taskTick(bot, ctx, t0 + 2000)
    assert.equal(ctx.task.house.stallMs, 0, 'castle progress resets the house clock')
  })

  it('unloaded house with no cache still reports (round-2 core-1)', () => {
    const bot = makeBot() // null world: unloaded throughout
    const ticker = createTicker({ bot, brain: null, tickMs: 10, idleTickMs: 10 })
    ticker.setHome({ site: { x: 0, y: 64, z: 0 }, built: false, v: 2 })
    ticker.work()
    const ctx = bot._tickerCtx
    const t0 = 1000000000000
    taskMod.taskTick(bot, ctx, t0)
    assert.equal(ctx.task.active, 'house')
    assert.equal(ctx.task.house.done, undefined, 'no baseline without a loaded read')
    for (let s = 1; s <= 15 * 60; s++) taskMod.taskTick(bot, ctx, t0 + s * 1000)
    assert.equal(taskLogs().length, 1, 'far-off stall still gets an L1')
    assert.match(taskLogs()[0], /^task house \?\/\? stall=900s/)
    assert.match(bot.chats[0], /^house: no progress for 15 min at \?\/\?/)
    // First loaded reading baselines without resetting the clock.
    bot.blockAt = () => ({ name: 'air', boundingBox: 'empty' })
    taskMod.taskTick(bot, ctx, t0 + (15 * 60 + 1) * 1000)
    assert.equal(ctx.task.house.done, 0)
    assert.ok((ctx.task.house.stallMs || 0) >= 900000, 'first reading does not reset')
  })

  it('runTick advances the stall on sheltered fight ticks (core-5)', async () => {
    // Pins the hook position: the shelter/fight short-circuits must not skip it.
    const bot = makeBot()
    bot.blockAt = () => null
    const brain = { decide: async () => ({ action: 'fight', sprint: false, source: 'stub' }) }
    const ticker = createTicker({ bot, brain, tickMs: 10, idleTickMs: 10, autonomous: true })
    ticker.setCastle({ site: { x: 100, y: 64, z: 200 }, rot: 0, phase: 'body', blocked: {}, parked: false, progress: { done: 8, total: 1722 } })
    ticker.work()
    const ctx = bot._tickerCtx
    ctx.inShelter = true
    ctx.castleWord = { kind: 'stone', left: 80 }
    await ticker.tick()
    assert.ok(ctx.task && ctx.task.castle, 'hook ran on the first tick')
    ctx.task.castle.lastAt = Date.now() - 5000
    await ticker.tick()
    assert.ok((ctx.task.castle.stallMs || 0) >= 4000, `stall advanced on a sheltered fight tick, got ${ctx.task.castle.stallMs}`)
  })

  it('castle unread since connect still reports (verify core-1)', () => {
    const bot = makeBot() // null world: off-site, progress never restored
    const ticker = createTicker({ bot, brain: null, tickMs: 10, idleTickMs: 10 })
    ticker.setCastle({ site: { x: 100, y: 64, z: 200 }, rot: 0, phase: 'body', blocked: {}, parked: false })
    ticker.work()
    const ctx = bot._tickerCtx
    ctx.castleWord = { kind: 'stone', left: 80 }
    ctx.step = 'castlefetch'
    ctx.stepStatus = 'running'
    const t0 = 1000000000000
    taskMod.taskTick(bot, ctx, t0)
    assert.equal(ctx.task.active, 'castle')
    for (let s = 1; s <= 15 * 60; s++) taskMod.taskTick(bot, ctx, t0 + s * 1000)
    assert.equal(taskLogs().length, 1, 'off-site stall still gets an L1')
    assert.match(taskLogs()[0], /^task castle \?\/\? stall=900s/)
    assert.match(bot.chats[0], /^castle: no progress for 15 min at \?\/\?/)
    // First loaded reading baselines without resetting.
    ctx.castle.progress = { done: 8, total: 1722 }
    taskMod.taskTick(bot, ctx, t0 + (15 * 60 + 1) * 1000)
    assert.equal(ctx.task.castle.done, 8)
    assert.ok((ctx.task.castle.stallMs || 0) >= 900000, 'first reading does not reset')
  })

  it("planks left oscillation does not reset (verify body-1)", () => {
    const bot = makeBot()
    const { ctx } = castleCtx(bot, { kind: 'planks', left: 8 })
    const t0 = 1000000000000
    taskMod.taskTick(bot, ctx, t0)
    // Block/unblock cycle with nothing placed: left flips 8→7→8… every minute.
    for (let s = 1; s <= 15 * 60; s++) {
      if (s % 60 === 0) ctx.castleWord.left = ctx.castleWord.left === 8 ? 7 : 8
      taskMod.taskTick(bot, ctx, t0 + s * 1000)
    }
    assert.equal(ctx.task.castle.stallMs, 900000, 'planks left is ignored')
    assert.equal(taskLogs().length, 1, 'oscillation still fires the L1')
  })

  it('stone left repair cycle does not reset (verify 02 core-1 low-water)', () => {
    const bot = makeBot()
    const { ctx } = castleCtx(bot, { kind: 'stone', left: 80 })
    const t0 = 1000000000000
    taskMod.taskTick(bot, ctx, t0)
    // Creeper hole (+1 remainder) then repair, every minute, nothing net.
    for (let s = 1; s <= 15 * 60; s++) {
      if (s % 120 === 60) ctx.castleWord.left = 81
      if (s % 120 === 0) ctx.castleWord.left = 80
      taskMod.taskTick(bot, ctx, t0 + s * 1000)
    }
    assert.equal(ctx.task.castle.stallMs, 900000, 'repair to the low-water mark is not progress')
    assert.equal(taskLogs().length, 1, 'dig/repair cycle still fires the L1')
  })

  it('runTick advances the stall on recover ticks (verify 03 core-1)', async () => {
    // Pins the hook above the recover branch: stuck ticks must bill at cadence.
    const bot = makeBot()
    bot.blockAt = () => null
    const brain = { decide: async () => ({ action: 'follow', sprint: false, source: 'stub' }) }
    const ticker = createTicker({ bot, brain, tickMs: 10, idleTickMs: 10, autonomous: true })
    ticker.setCastle({ site: { x: 100, y: 64, z: 200 }, rot: 0, phase: 'body', blocked: {}, parked: false, progress: { done: 8, total: 1722 } })
    ticker.work()
    const ctx = bot._tickerCtx
    ctx.castleWord = { kind: 'stone', left: 80 }
    const recover = require('../src/behaviours/recover')
    const origDecide = recover.decide
    recover.decide = async () => ({ action: 'idle', sprint: false, source: 'stub-recover' })
    try {
      ctx.stuck = { by: 'test', key: 'test' }
      await ticker.tick()
      assert.ok(ctx.task && ctx.task.castle, 'hook ran on a recover tick')
      ctx.stuck = { by: 'test', key: 'test' }
      ctx.task.castle.lastAt = Date.now() - 5000
      await ticker.tick()
      assert.ok((ctx.task.castle.stallMs || 0) >= 4000, `recover tick billed at cadence, got ${ctx.task.castle.stallMs}`)
    } finally {
      recover.decide = origDecide
    }
  })

  it('wall-time gap clamps to 10 s per tick (verify core-2)', () => {
    const bot = makeBot()
    const { ctx } = castleCtx(bot)
    const t0 = 1000000000000
    taskMod.taskTick(bot, ctx, t0)
    taskMod.taskTick(bot, ctx, t0 + 3600000) // 1 h gap (idle/reflex before the hook)
    assert.equal(ctx.task.castle.stallMs, taskMod.STALL_TICK_CLAMP_MS)
    assert.equal(taskLogs().length, 0, 'no instant L1 from a gap')
  })
})
