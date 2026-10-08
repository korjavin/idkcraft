'use strict'

// Goal watchdog enabling credit (idkcraft-m1yb): the castle stall verdict
// credits the opening chain (logs/planks/sticks/table+first picks), so a
// healthy opening never reads as a 60 s stall and burns no watchdog
// rounds. Fake brains only; no network.

const { describe, it, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const taskMod = require('../src/task')
const { createTicker } = require('../src/index')

function pos(x, y, z) {
  return { x, y, z, distanceTo: (q) => Math.hypot(x - q.x, y - q.y, z - q.z) }
}

function makeBot({ timeOfDay = 6000, items = null } = {}) {
  const inv = items || []
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
    blockAt: () => null,
    pathfinder: { isMoving: () => false, setGoal() {}, stop() {}, goal: null },
    clearControlStates() {},
  }
}

// Opening shape: castle goal, stone demand, the gather step holding the
// body (the bead's r1/r2: choice=gather while the demand sits flat).
function castleCtx(bot, { done = 0, total = 1722, phase = 'body', kind = 'stone', left = 80 } = {}) {
  const ticker = createTicker({ bot, brain: null, tickMs: 10, idleTickMs: 10 })
  const st = { site: { x: 100, y: 64, z: 200 }, rot: 0, phase, blocked: {}, parked: false, progress: { done, total } }
  ticker.setCastle(st)
  ticker.work()
  const ctx = bot._tickerCtx
  ctx.castleWord = { kind, left }
  ctx.step = 'gather'
  ctx.stepStatus = 'running'
  ctx.stepPick = { step: 'gather', at: Date.now() - 5000, source: 'goal-fsm', why: 'chop logs' }
  return { ticker, ctx }
}

// Advance the fake clock in 10 s steps (the per-tick clamp bills fully).
function advance(bot, ctx, t0, seconds, every = null) {
  let t = t0
  const steps = Math.round((seconds * 1000) / 10000)
  for (let s = 0; s < steps; s++) {
    t += 10000
    if (every) every(t, s)
    taskMod.taskTick(bot, ctx, t)
  }
  return t
}

const flush = () => new Promise((r) => setImmediate(r))

function answerBrain(step, conf = 0.9) {
  const calls = []
  const brain = {
    plan: async (req) => {
      calls.push(req)
      return { step, confidence: conf, probabilities: { [step]: conf }, source: 'jev' }
    },
  }
  return { calls, brain }
}

let origLog = null
let lines = []
let savedEnv = {}
const WATCHDOG_ENV = ['GOAL_WATCHDOG_MS', 'GOAL_COMMIT_MS', 'GOAL_WATCHDOG_MAX_ROUNDS', 'GOAL_TRAVEL_GRACE_MS', 'GOAL_PLANB_SWITCH_MS']
beforeEach(() => {
  lines = []
  origLog = console.log
  console.log = (m) => { lines.push(String(m)) }
  savedEnv = {}
  for (const k of WATCHDOG_ENV) {
    savedEnv[k] = process.env[k]
    delete process.env[k]
  }
})
afterEach(() => {
  console.log = origLog
  for (const k of WATCHDOG_ENV) {
    if (savedEnv[k] === undefined) delete process.env[k]
    else process.env[k] = savedEnv[k]
  }
})

function wdLogs() { return lines.filter((l) => l.startsWith('goal watchdog')) }
function outLogs() { return lines.filter((l) => l.startsWith('goal outcome')) }
function resetLogs() { return lines.filter((l) => l.startsWith('goal reset')) }

describe('enabling credit (idkcraft-m1yb)', () => {
  it('steady log growth across the 60 s window fires no round (the bead r1/r2)', async () => {
    const bot = makeBot({ items: [{ name: 'oak_log', count: 0 }] })
    const { ctx } = castleCtx(bot)
    const { calls, brain } = answerBrain('gather')
    ctx.brain = brain
    const inv = bot.inventory.items()
    const t0 = 1000000000000
    taskMod.taskTick(bot, ctx, t0) // baseline
    assert.equal(ctx.task.castle.enLogs, 0, 'baseline seeds enabling')
    // A log chop every 30 s for 150 s (the bead: 11 logs by t180) —
    // sparse, but no 60 s gap.
    advance(bot, ctx, t0, 150, (t, s) => {
      if (s % 3 === 2) inv[0].count += 2
    })
    await flush()
    assert.equal(calls.length, 0, 'no watchdog round fires mid-opening')
    assert.equal(wdLogs().length, 0, 'no watchdog lines')
    assert.ok(resetLogs().some((l) => l === 'goal reset kind=castle why=enabling:logs'), JSON.stringify(resetLogs()))
    assert.equal((ctx.task.castle.wd && ctx.task.castle.wd.rounds) || 0, 0, 'no rounds burned')
  })

  it('each enabling category resets with its reason; consumption accrues; regather resets (delta, kit-open)', () => {
    const bot = makeBot({ items: [] })
    const { ctx } = castleCtx(bot)
    const inv = bot.inventory.items()
    const t0 = 1000000000000
    let t = t0
    taskMod.taskTick(bot, ctx, t) // baseline, empty kit
    const tick = () => {
      t += 10000
      taskMod.taskTick(bot, ctx, t)
    }
    const lastReset = () => resetLogs()[resetLogs().length - 1]
    inv.push({ name: 'oak_planks', count: 4 })
    tick()
    assert.equal(lastReset(), 'goal reset kind=castle why=enabling:planks')
    assert.equal(ctx.task.castle.stallMs, 0)
    // Consumption is not progress: the clock accrues (no grace on gather).
    const openBefore = resetLogs().length
    inv[0].count = 0 // planks 4 -> 0, crafted away
    tick()
    assert.equal(resetLogs().length, openBefore, 'no reset on consumption')
    assert.equal(ctx.task.castle.stallMs, 10000)
    // Regather below the old peak still resets while the kit is open:
    // last-tick delta, not high-water.
    inv[0].count = 2
    tick()
    assert.equal(lastReset(), 'goal reset kind=castle why=enabling:planks')
    assert.equal(ctx.task.castle.stallMs, 0)
    inv.push({ name: 'stick', count: 4 })
    tick()
    assert.equal(lastReset(), 'goal reset kind=castle why=enabling:sticks')
    inv.push({ name: 'crafting_table', count: 1 })
    tick()
    assert.equal(lastReset(), 'goal reset kind=castle why=enabling:gear')
    // The first pick completes the kit and still credits (baseline open).
    inv.push({ name: 'wooden_pickaxe', count: 1 })
    tick()
    assert.equal(lastReset(), 'goal reset kind=castle why=enabling:gear')
    assert.equal(ctx.task.castle.enReady, true, 'baseline holds the pick')
    // Bound: past a ready baseline, further gear growth stays flat.
    const resetsBefore = resetLogs().length
    inv.push({ name: 'stone_pickaxe', count: 1 })
    tick()
    assert.equal(resetLogs().length, resetsBefore, 'no reset past kit-ready')
    assert.equal(ctx.task.castle.stallMs, 10000)
    // Regather past a ready baseline stays flat too.
    inv[0].count = 0
    tick()
    inv[0].count = 2
    tick()
    assert.equal(resetLogs().length, resetsBefore, 'regather past ready stays flat')
  })

  it('past a ready kit, log/plank/stick growth does NOT reset the stall (the livelock bound)', async () => {
    // Verifier: unbounded enabling let a chop loop silence the watchdog.
    // Once the baseline holds any pickaxe, only castle metrics count.
    const bot = makeBot({ items: [{ name: 'oak_log', count: 0 }, { name: 'stone_pickaxe', count: 1 }] })
    const { ctx } = castleCtx(bot)
    const { calls, brain } = answerBrain('gather')
    ctx.brain = brain
    const inv = bot.inventory.items()
    const t0 = 1000000000000
    taskMod.taskTick(bot, ctx, t0) // baseline, kit ready
    assert.equal(ctx.task.castle.enReady, true, 'baseline ready')
    const resetsBefore = resetLogs().length
    // Steady chops across the 60 s window: no reset, the stall accrues,
    // and the watchdog still fires.
    advance(bot, ctx, t0, 130, (t, s) => {
      if (s % 3 === 2) inv[0].count += 2
    })
    await flush()
    assert.equal(resetLogs().length, resetsBefore, 'no enabling reset past ready')
    assert.ok(ctx.task.castle.stallMs >= 60000, `stall accrues, got ${ctx.task.castle.stallMs}`)
    assert.ok(calls.length >= 1, 'watchdog fires past a ready-kit chop loop')
    // Planks and sticks past ready stay flat too.
    const t1 = t0 + 140000
    inv.push({ name: 'oak_planks', count: 4 })
    taskMod.taskTick(bot, ctx, t1)
    inv.push({ name: 'stick', count: 4 })
    taskMod.taskTick(bot, ctx, t1 + 10000)
    assert.equal(resetLogs().length, resetsBefore, 'planks/sticks past ready stay flat')
  })

  it('enabling is material-class: the any-clock resets while the placed clock accrues', () => {
    const bot = makeBot({ items: [{ name: 'oak_log', count: 0 }] })
    const { ctx } = castleCtx(bot)
    const inv = bot.inventory.items()
    const t0 = 1000000000000
    taskMod.taskTick(bot, ctx, t0) // baseline
    inv[0].count = 3
    taskMod.taskTick(bot, ctx, t0 + 10000)
    assert.equal(ctx.task.castle.stallMs, 0, 'any-clock resets')
    assert.equal(ctx.task.castle.placedStallMs, 10000, 'placed accrues toward L1')
    inv[0].count = 6
    taskMod.taskTick(bot, ctx, t0 + 20000)
    assert.equal(ctx.task.castle.stallMs, 0)
    assert.equal(ctx.task.castle.placedStallMs, 20000, 'a fetch loop still reports')
  })

  it('a truly flat opening still fires, and the window snapshot carries enabling', async () => {
    // Empty kit held static: nothing grows, so the verdict stays flat.
    // (The menu stays offerable on an empty kit — gather+park — so the
    // fire pins the verdict, not the table.)
    const bot = makeBot({ items: [] })
    const { ctx } = castleCtx(bot)
    const { calls, brain } = answerBrain('gather')
    ctx.brain = brain
    const t0 = 1000000000000
    taskMod.taskTick(bot, ctx, t0) // baseline, static kit, nothing grows
    const t = advance(bot, ctx, t0, 130)
    await flush() // the fire calls brain.plan off the tick
    assert.ok(calls.length >= 1, 'round 1 fires on a flat opening')
    taskMod.taskTick(bot, ctx, t + 10000) // consume
    assert.equal(wdLogs().length, 1, 'one watchdog line')
    assert.match(wdLogs()[0], /step=gather .* choice=gather/)
    const snap = ctx.goal && ctx.goal.commit && ctx.goal.commit.snapshot
    assert.ok(snap, 'window live')
    assert.equal(snap.enLogs, 0, 'snapshot carries enabling')
    assert.equal(snap.enPlanks, 0)
    assert.equal(snap.enSticks, 0)
    assert.equal(snap.enGear, 0)
    assert.equal(snap.enReady, false, 'snapshot carries the readiness gate')
  })

  it('a done window with enabling-only growth reads progress with a logs delta', () => {
    const bot = makeBot({ items: [{ name: 'oak_log', count: 0 }] })
    const { ctx } = castleCtx(bot)
    const inv = bot.inventory.items()
    const t0 = 1000000000000
    taskMod.taskTick(bot, ctx, t0) // baseline
    const arm = (enLogs, enReady = false) => {
      ctx.goal = { id: 'castle-1', kind: 'castle', generation: 1 }
      ctx.goal.commit = {
        goalId: 'castle-1', generation: 1, kind: 'castle', optionId: 'gather', step: 'gather',
        until: Date.now() + 120000, appliedAt: Date.now() - 5000, lastTick: Date.now() - 5000,
        deaths: 0, unlock: null,
        snapshot: {
          done: 0, total: 1722, prepLeft: 0, matKind: 'stone', matHave: 0, matLeft: 80,
          enLogs, enPlanks: 0, enSticks: 0, enGear: 0, enReady, marks: {},
        },
      }
    }
    inv[0].count = 5 // logs 0 -> 5 under the window, stone flat
    arm(0)
    taskMod.commitFinished(bot, ctx, 'done')
    assert.equal(outLogs().length, 1, 'one outcome line')
    assert.match(outLogs()[0], /delta=logs0->5 result=progress/, outLogs()[0])
    assert.equal(ctx.task.castle.wd.rounds, 0, 'progress clears rounds')
    // Control: a done window with nothing grown reads flat.
    arm(5)
    taskMod.commitFinished(bot, ctx, 'done')
    assert.equal(outLogs().length, 2, 'two outcome lines')
    assert.match(outLogs()[1], /result=flat/, outLogs()[1])
    assert.equal(ctx.task.castle.wd.rounds, 1, 'flat counts')
    // Bound: the same logs growth past a ready snapshot reads flat.
    inv[0].count = 9
    arm(5, true)
    taskMod.commitFinished(bot, ctx, 'done')
    assert.equal(outLogs().length, 3, 'three outcome lines')
    assert.match(outLogs()[2], /result=flat/, outLogs()[2])
  })

  it('house clock cross-resets on castle enabling growth (castleWatch, revmux 01 core-2)', () => {
    const bot = makeBot({ items: [{ name: 'oak_log', count: 0 }] })
    bot.blockAt = () => ({ name: 'air', boundingBox: 'empty' }) // house loaded, nothing placed
    const ticker = createTicker({ bot, brain: null, tickMs: 10, idleTickMs: 10 })
    ticker.setHome({ site: { x: 0, y: 64, z: 0 }, built: false, v: 2 })
    ticker.setCastle({ site: { x: 100, y: 64, z: 200 }, rot: 0, phase: 'complete', blocked: {}, parked: false, progress: { done: 1722, total: 1722 } })
    ticker.work()
    const ctx = bot._tickerCtx
    ctx.castleWord = { kind: 'stone', left: 0 }
    ctx.step = 'castle'
    ctx.stepStatus = 'running'
    const inv = bot.inventory.items()
    const t0 = 1000000000000
    taskMod.taskTick(bot, ctx, t0) // house baseline
    assert.equal(taskMod.goalKind(ctx), 'house', 'complete castle yields to the unbuilt home')
    taskMod.taskTick(bot, ctx, t0 + 10000) // castleWatch seeds
    inv[0].count = 3 // logs grow, stone flat
    taskMod.taskTick(bot, ctx, t0 + 20000)
    assert.ok(resetLogs().some((l) => l === 'goal reset kind=house why=enabling:logs'), JSON.stringify(resetLogs()))
    assert.equal(ctx.task.house.stallMs, 0)
  })

  it('under a frame demand, log growth still reports material:frame', () => {
    const bot = makeBot({ items: [{ name: 'oak_log', count: 0 }] })
    const { ctx } = castleCtx(bot, { kind: 'frame', left: 40 })
    const inv = bot.inventory.items()
    const t0 = 1000000000000
    taskMod.taskTick(bot, ctx, t0) // baseline under the frame demand
    inv[0].count = 3
    taskMod.taskTick(bot, ctx, t0 + 10000)
    assert.ok(resetLogs().some((l) => l === 'goal reset kind=castle why=material:frame'), JSON.stringify(resetLogs()))
    assert.ok(!resetLogs().some((l) => l.includes('enabling:')), 'material names the move first')
  })
})
