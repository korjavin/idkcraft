'use strict'

// Goal watchdog delivery 1 (idkcraft-vmzq.21): goal identity + truthful
// metrics/history + fast JEV rounds + bounded commitment incl. same-step
// hold + backoff, castle/house. Fake brains only (brain-plan.test.js
// precedent); no network. Legacy ladder behavior stays pinned in
// task.test.js / task-park.test.js / task-plan.test.js via
// GOAL_WATCHDOG_MS=0 (acceptance 5).

const { describe, it, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const taskMod = require('../src/task')
const goal = require('../src/goal')
const metrics = require('../src/metrics')
const { createTicker } = require('../src/index')

assert.equal(taskMod.GOAL_WATCHDOG_MS_DEFAULT, 60000, 'owner 2026-10-07: 1 min flat window')
assert.equal(taskMod.GOAL_COMMIT_MS_DEFAULT, 120000, 'bounded 120 s window')
assert.equal(taskMod.GOAL_WATCHDOG_MAX_ROUNDS_DEFAULT, 6, '6 flat rounds to park/plan-B')
assert.equal(taskMod.GOAL_TRAVEL_GRACE_MS_DEFAULT, 90000, '90 s travel grace floor')
assert.equal(taskMod.GOAL_PLANB_SWITCH_MS_DEFAULT, 450000, '7.5 min plan-B switch (owner 5-10 min)')
assert.equal(taskMod.GOAL_HISTORY_KEPT, 5, 'last 5 rounds ride the request')
assert.equal(taskMod.TASK_PLAN_MIN_CONF, 0.5, 'confidence gate stays until vmzq.23')

function pos(x, y, z) {
  return { x, y, z, distanceTo: (q) => Math.hypot(x - q.x, y - q.y, z - q.z) }
}

function makeBot({ timeOfDay = 6000, items = null, players = null } = {}) {
  // Usable stone reads count-16 (castle reserve): 73 <-> 57.
  const inv = items || [{ name: 'cobblestone', count: 73 }, { name: 'stone_pickaxe', count: 1 }]
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
    players: players || {},
    entities: {},
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

function houseCtx(bot) {
  bot.blockAt = () => ({ name: 'air', boundingBox: 'empty' }) // loaded, nothing placed
  const ticker = createTicker({ bot, brain: null, tickMs: 10, idleTickMs: 10 })
  ticker.setHome({ site: { x: 0, y: 64, z: 0 }, built: false, v: 2 })
  ticker.work()
  return { ticker, ctx: bot._tickerCtx }
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

// One full watchdog round on the fake clock: advance to the fire, flush
// the answer, consume it, advance to the window end. Returns the new t.
async function fullRound(bot, ctx, t, kind = 'castle') {
  const st = () => ctx.task && ctx.task[kind]
  let guard = 0
  while (!(st() && st().wd && st().wd.pending) && guard++ < 40) {
    t += 10000
    taskMod.taskTick(bot, ctx, t)
  }
  assert.ok(st() && st().wd && st().wd.pending, 'round fired')
  await flush()
  t += 10000
  taskMod.taskTick(bot, ctx, t) // consume
  guard = 0
  while (ctx.goal && ctx.goal.commit && guard++ < 40) {
    t += 10000
    taskMod.taskTick(bot, ctx, t)
  }
  assert.equal((ctx.goal && ctx.goal.commit) || null, null, 'window ended')
  return t
}

// A fake-clock commit can never pin in decide() (real clock): re-stamp.
function restampRealtime(ctx, ms = 120000) {
  const c = ctx.goal.commit
  const now = Date.now()
  c.appliedAt = now
  c.lastTick = now
  c.until = now + ms
}

function answerBrain(step, conf = 0.9) {
  const calls = []
  const brain = {
    plan: async (req) => {
      calls.push(req)
      const s = typeof step === 'function' ? step(req) : step
      return { step: s, confidence: conf, probabilities: { [s]: conf }, source: 'jev' }
    },
  }
  return { calls, brain }
}

function failingBrain(err) {
  const calls = []
  const brain = {
    plan: async () => {
      calls.push(1)
      throw err
    },
  }
  return { calls, brain }
}

async function watchdogCounter(kind, choice, source) {
  const text = await metrics.client.register.metrics()
  const m = text.match(new RegExp(`idkcraft_bot_goal_watchdog_total\\{kind="${kind}",choice="${choice}",source="${source}"\\} ([0-9.e+]+)`))
  return m ? Number(m[1]) : 0
}

let origLog = null
let lines = []
let savedEnv = {}
const WATCHDOG_ENV = ['GOAL_WATCHDOG_MS', 'GOAL_COMMIT_MS', 'GOAL_WATCHDOG_MAX_ROUNDS', 'GOAL_TRAVEL_GRACE_MS', 'GOAL_PLANB_SWITCH_MS']
beforeEach(() => {
  lines = []
  origLog = console.log
  console.log = (m) => { lines.push(String(m)) }
  // Watchdog suite: defaults on (acceptance runs at shipped defaults
  // unless the test says otherwise).
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
function planbLogs() { return lines.filter((l) => l.startsWith('goal planb')) }

describe('goal watchdog env (vmzq.21)', () => {
  it('tunes from env, garbage falls back to defaults', () => {
    assert.equal(taskMod.goalWatchdogMs(), 60000)
    assert.equal(taskMod.goalCommitMs(), 120000)
    assert.equal(taskMod.goalMaxRounds(), 6)
    assert.equal(taskMod.goalGraceMs(), 90000)
    assert.equal(taskMod.goalPlanbMs(), 450000)
    assert.equal(taskMod.watchdogOn(), true)
    process.env.GOAL_WATCHDOG_MS = '0'
    assert.equal(taskMod.watchdogOn(), false, '0 disables the watchdog')
    process.env.GOAL_WATCHDOG_MS = 'nonsense'
    assert.equal(taskMod.goalWatchdogMs(), 60000)
    process.env.GOAL_WATCHDOG_MAX_ROUNDS = '0'
    assert.equal(taskMod.goalMaxRounds(), 6, 'rounds below 1 fall back')
    assert.equal(taskMod.ownerOnline({ username: 'IdkBot', players: {} }), false)
    assert.equal(taskMod.ownerOnline({ username: 'IdkBot', players: { Steve: {} } }), true)
    assert.equal(taskMod.ownerOnline({ username: 'IdkBot', players: { IdkBot: {} } }), false, 'self excluded')
  })

  it('GOAL_WATCHDOG_MS=0 keeps the shipped one-shot ladder (acceptance 5)', async () => {
    process.env.GOAL_WATCHDOG_MS = '0'
    const bot = makeBot()
    const { ctx } = castleCtx(bot)
    const { calls, brain } = answerBrain('gather')
    ctx.brain = brain
    const t0 = 1000000000000
    taskMod.taskTick(bot, ctx, t0)
    const t1 = advance(bot, ctx, t0, 45 * 60)
    assert.equal(ctx.task.castle.planTried, true, 'legacy L2 plan fired')
    await flush()
    assert.equal(calls.length, 1)
    taskMod.taskTick(bot, ctx, t1 + 10000)
    assert.equal(ctx.taskPlanStep, 'gather', 'legacy one-shot force')
    assert.equal(ctx.task.castle.wd, undefined, 'no watchdog state off the watchdog path')
    assert.equal((ctx.goal && ctx.goal.commit) || null, null, 'no commitment off the watchdog path')
    assert.equal(wdLogs().length, 0, 'no watchdog lines')
    assert.equal(outLogs().length, 0, 'no outcome lines')
  })
})

describe('run-4 fixture: flat cells, oscillating stone, alternating steps (acceptance 1)', () => {
  it('fires one round within the window; the same-step answer pins across facts flips; round 2 carries the outcome', async () => {
    const bot = makeBot()
    const { ctx } = castleCtx(bot)
    const { calls, brain } = answerBrain('castlefetch')
    ctx.brain = brain
    const inv = bot.inventory.items()
    const before = await watchdogCounter('castle', 'castlefetch', 'jev')
    const t0 = 1000000000000
    taskMod.taskTick(bot, ctx, t0) // baseline: usable 57
    // Run-4 mirror: stone 57->53->57->53, castle/castlefetch alternating
    // early (fresh picks, but the 90 s grace floor grants only the first
    // leg, so the flips stay flat).
    let t = t0
    const counts = [69, 73, 69, 73, 69, 73, 69]
    for (let s = 0; s < 7; s++) {
      t += 10000
      inv[0].count = counts[s]
      if (s < 3) {
        ctx.step = s % 2 === 0 ? 'castle' : 'castlefetch'
        ctx.stepStatus = 'running'
        ctx.stepPick = { step: ctx.step, at: t, source: 'goal-fsm', why: 'flip' }
      } else {
        ctx.step = 'castlefetch'
        ctx.stepStatus = 'running'
      }
      taskMod.taskTick(bot, ctx, t)
    }
    assert.ok(resetLogs().some((l) => l === 'goal reset kind=castle why=grace'), `one grace: ${JSON.stringify(resetLogs())}`)
    assert.equal(calls.length, 0, 'no fire before the 60 s window')
    let guard = 0
    while (!ctx.task.castle.wd?.pending && guard++ < 20) {
      t += 10000
      inv[0].count = inv[0].count === 73 ? 69 : 73
      taskMod.taskTick(bot, ctx, t)
    }
    assert.ok(ctx.task.castle.wd.pending, 'round fired at the window')
    assert.ok(ctx.task.castle.wd.firedAt - t0 <= 80000, 'fired within the window of eligible time')
    await flush()
    assert.equal(calls.length, 1, 'one JEV call at the window')
    t += 10000
    taskMod.taskTick(bot, ctx, t) // consume
    assert.equal(wdLogs().length, 1, 'ONE goal watchdog line')
    assert.match(
      wdLogs()[0],
      /^goal watchdog kind=castle id=castle-1 progress=8\/1722 stall=70s round=1 step=castlefetch options=castlefetch,gather,park choice=castlefetch conf=0\.90 source=jev why=step=castlefetch running/,
    )
    assert.equal(await watchdogCounter('castle', 'castlefetch', 'jev'), before + 1)
    // The request: goal + history=[] + situation + options, watchdog words.
    const req = calls[0]
    assert.deepEqual(req.state.history, [], 'round 1 carries an empty history')
    assert.equal(req.state.goal, 'build castle')
    assert.equal(req.state.progress, '8/1722')
    assert.match(req.state.facts, /time=day/)
    assert.equal(req.instructions, taskMod.PLAN_INSTRUCTIONS)
    assert.notEqual(req.instructions, goal.ASK_INSTRUCTIONS, 'watchdog words, not the tick words')
    assert.deepEqual(Object.keys(req.criteria), ['castlefetch', 'gather', 'park'])
    assert.equal(req.criteria.park, taskMod.PLAN_PARK_CRITERION)
    // The same-step answer applies as a commit (no same-step park).
    const commit = ctx.goal && ctx.goal.commit
    assert.ok(commit, 'commit applied')
    assert.equal(commit.step, 'castlefetch')
    assert.equal(commit.goalId, 'castle-1')
    assert.equal(commit.generation, 1)
    assert.equal(ctx.castle.parked, false)
    // decide() keeps castlefetch across alternating facts texts: flip the
    // logs bucket (none<->few moves nothing else).
    restampRealtime(ctx)
    const tA = goal.goalText(goal.goalFacts(bot, ctx), ctx.home)
    let d = await goal.decide(bot, ctx)
    assert.equal(d.action, 'castlefetch')
    assert.equal(ctx.stepPick.source, 'task-plan')
    assert.equal(ctx.stepPick.why, 'task-plan')
    inv.push({ name: 'oak_log', count: 1 })
    const tB = goal.goalText(goal.goalFacts(bot, ctx), ctx.home)
    assert.notEqual(tA, tB, 'facts actually flipped')
    d = await goal.decide(bot, ctx)
    assert.equal(d.action, 'castlefetch', 'pinned across the flip')
    assert.equal(ctx.stepPick.source, 'task-plan')
    inv.pop()
    d = await goal.decide(bot, ctx)
    assert.equal(d.action, 'castlefetch', 'pinned across the flip back')
    assert.equal(ctx.taskPlanStep || null, null, 'the window path never touches the one-shot')
    // To the window end: one flat outcome, then round 2 with history.
    // (The pinning above re-stamped the window to the real clock; put it
    // back on the fake clock for the expiry accounting.)
    const c = ctx.goal.commit
    c.appliedAt = t
    c.lastTick = t
    c.until = t + 120000
    guard = 0
    while (ctx.goal.commit && guard++ < 40) {
      t += 10000
      taskMod.taskTick(bot, ctx, t)
    }
    assert.equal(ctx.goal.commit, null, 'window expired')
    assert.equal(outLogs().length, 1, 'one outcome line')
    assert.match(outLogs()[0], /^goal outcome kind=castle choice=castlefetch dur=120s delta=cells8->8 result=flat unlock=-$/)
    assert.equal(ctx.task.castle.wd.rounds, 1)
    t = advance(bot, ctx, t, 20)
    await flush()
    assert.equal(calls.length, 2, 'round 2 fired right after the flat window')
    assert.equal(calls[1].state.history.length, 1, 'round 2 carries the outcome')
    assert.deepEqual(calls[1].state.history[0], { choice: 'castlefetch', outcome: 'flat', dur_s: 120, delta: 'cells8->8' })
    t += 10000
    taskMod.taskTick(bot, ctx, t)
    assert.match(wdLogs()[1], /round=2 step=castlefetch .* choice=castlefetch/)
  })
})

describe('truthful metrics (acceptance 2)', () => {
  it('rising stone under one demand resets with why=material; a demand switch alone does not', async () => {
    const bot = makeBot()
    const { ctx } = castleCtx(bot)
    const { calls, brain } = answerBrain('castlefetch')
    ctx.brain = brain
    const inv = bot.inventory.items()
    const t0 = 1000000000000
    taskMod.taskTick(bot, ctx, t0) // baseline usable 57
    let t = advance(bot, ctx, t0, 50)
    assert.equal(calls.length, 0)
    inv[0].count = 78 // usable 57 -> 62, same demand
    t += 10000
    taskMod.taskTick(bot, ctx, t)
    assert.ok(resetLogs().some((l) => l === 'goal reset kind=castle why=material:stone'), JSON.stringify(resetLogs()))
    assert.equal(ctx.task.castle.stallMs, 0)
    assert.equal(calls.length, 0, 'acquisition re-arms the watchdog')
    // The demanded remainder shrinking resets too.
    t = advance(bot, ctx, t, 50)
    ctx.castleWord.left = 70
    t += 10000
    taskMod.taskTick(bot, ctx, t)
    assert.ok(resetLogs().some((l) => l === 'goal reset kind=castle why=material:stone'))
    assert.equal(ctx.task.castle.stallMs, 0)
    // A demand-kind switch alone is not progress.
    t = advance(bot, ctx, t, 30)
    ctx.castleWord = { kind: 'planks', left: 50 }
    t += 10000
    taskMod.taskTick(bot, ctx, t)
    assert.equal(ctx.task.castle.stallMs, 40000, 'switch alone advances the clock')
    assert.ok(!resetLogs().some((l) => l.includes('material:planks')), JSON.stringify(resetLogs()))
  })

  it('sticky marks: a switch away and back restores the old high-water (run-4 recount fix)', () => {
    const bot = makeBot()
    const { ctx } = castleCtx(bot)
    ctx.brain = null
    const inv = bot.inventory.items()
    const t0 = 1000000000000
    taskMod.taskTick(bot, ctx, t0) // stone baseline usable 57
    assert.equal(ctx.task.castle.matHave, 57)
    let t = t0 + 10000
    inv[0].count = 69 // usable 53: sink ignores the dip
    taskMod.taskTick(bot, ctx, t)
    assert.equal(ctx.task.castle.stallMs, 0, 'fresh leg takes the travel grace')
    // Switch away and back at the dipped count, then rise — but still
    // below the sticky 57: no reset (legacy re-baselined 53 and reset).
    t += 10000
    ctx.castleWord = { kind: 'planks', left: 50 }
    taskMod.taskTick(bot, ctx, t)
    assert.equal(ctx.task.castle.stallMs, 10000)
    t += 10000
    ctx.castleWord = { kind: 'stone', left: 80 }
    taskMod.taskTick(bot, ctx, t)
    assert.equal(ctx.task.castle.matHave, 57, 'sticky mark restored, not re-baselined')
    assert.equal(ctx.task.castle.stallMs, 20000)
    t += 10000
    inv[0].count = 71 // usable 55: above the dip, below the mark
    taskMod.taskTick(bot, ctx, t)
    assert.equal(ctx.task.castle.stallMs, 30000, 'no recount reset')
    assert.ok(!resetLogs().some((l) => l.includes('material:')), JSON.stringify(resetLogs()))
    // Genuine growth past the mark still resets.
    t += 10000
    inv[0].count = 74 // usable 58
    taskMod.taskTick(bot, ctx, t)
    assert.ok(resetLogs().some((l) => l === 'goal reset kind=castle why=material:stone'))
    assert.equal(ctx.task.castle.stallMs, 0)
  })

  it('a house placing cells every 20 s never fires (acceptance 2)', async () => {
    const bot = makeBot()
    const { ctx } = houseCtx(bot)
    const { calls, brain } = answerBrain('build')
    ctx.brain = brain
    const build = require('../src/behaviours/build')
    const plan = build.blueprintFor(ctx.home)
    const key = (c) => `${ctx.home.site.x + c.dx},${ctx.home.site.y + c.dy},${ctx.home.site.z + c.dz}`
    const placed = new Set()
    bot.blockAt = (p) => {
      const k = `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`
      if (placed.has(k)) return { name: 'oak_planks', boundingBox: 'block' }
      return { name: 'air', boundingBox: 'empty' }
    }
    const t0 = 1000000000000
    taskMod.taskTick(bot, ctx, t0)
    let n = 0
    advance(bot, ctx, t0, 5 * 60, (t, s) => {
      if (s % 2 === 1 && n < plan.length) placed.add(key(plan[n++])) // a cell every 20 s
    })
    await flush()
    assert.equal(calls.length, 0, 'continuous building never fires')
    assert.equal(wdLogs().length, 0)
    assert.ok(ctx.task.house.done > 0, 'cells actually placed')
  })

  it('the pre-verdict fresh read saves a building house under a 30 s window', async () => {
    process.env.GOAL_WATCHDOG_MS = '30000'
    const bot = makeBot()
    const { ctx } = houseCtx(bot)
    const { calls, brain } = answerBrain('build')
    ctx.brain = brain
    const build = require('../src/behaviours/build')
    const plan = build.blueprintFor(ctx.home)
    const key = (c) => `${ctx.home.site.x + c.dx},${ctx.home.site.y + c.dy},${ctx.home.site.z + c.dz}`
    const placed = new Set()
    bot.blockAt = (p) => {
      const k = `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`
      if (placed.has(k)) return { name: 'oak_planks', boundingBox: 'block' }
      return { name: 'air', boundingBox: 'empty' }
    }
    const t0 = 1000000000000
    taskMod.taskTick(bot, ctx, t0)
    // A cell every 20 s; the 60 s cache is always stale at the 30 s
    // verdict, so without the fresh read every verdict would fire.
    // (plan[0] is the table — placing it reads unplaced, so skip it.)
    let n = 1
    advance(bot, ctx, t0, 3 * 60, (t, s) => {
      if (s % 2 === 1 && n < plan.length) placed.add(key(plan[n++]))
    })
    await flush()
    assert.equal(calls.length, 0, 'fresh reads reset instead of firing')
    assert.equal(wdLogs().length, 0)
    assert.ok(resetLogs().length >= 2, `verdict resets happened: ${JSON.stringify(resetLogs())}`)
  })
})

describe('window pauses, preempts and generation (acceptance 3)', () => {
  // A live window on the fake clock, plus the consume tick.
  async function liveWindow(bot, ctx, t0, step = 'castlefetch') {
    const { calls, brain } = answerBrain(step)
    brain.ask = async () => 'forage' // present so the night rule reads night-rule (never called for it)
    ctx.brain = brain
    taskMod.taskTick(bot, ctx, t0)
    let t = t0
    let guard = 0
    while (!ctx.task.castle.wd?.pending && guard++ < 20) {
      t += 10000
      taskMod.taskTick(bot, ctx, t)
    }
    assert.ok(ctx.task.castle.wd.pending, 'round fired')
    await flush()
    t += 10000
    taskMod.taskTick(bot, ctx, t) // consume
    assert.ok(ctx.goal.commit, 'window live')
    return { t, calls }
  }

  it('night wins from the ordinary menu, the window pauses, day re-pins', async () => {
    const bot = makeBot()
    const { ctx } = castleCtx(bot)
    ctx.home = { site: { x: -400, y: 64, z: -400 }, built: true, v: 2 } // far, built: shelter fits
    const t0 = 1000000000000
    // Gather: feasible at every day tick, so the re-pin is unconditional
    // (a fetch would honestly degrade once the castle can lay).
    let { t } = await liveWindow(bot, ctx, t0, 'gather')
    const commit = ctx.goal.commit
    const untilDay = commit.until
    // Night falls mid-window: the night rule wins, not the pin.
    bot.time.timeOfDay = 18000
    restampRealtime(ctx)
    const d = await goal.decide(bot, ctx)
    assert.equal(d.action, 'shelter', 'safety from the ordinary menu')
    assert.equal(ctx.stepPick.source, 'night-rule')
    assert.ok(ctx.goal.commit, 'window survives the safety pick')
    // Night ticks pause the window (fake clock again): until extends by
    // the billed time instead of burning it.
    commit.appliedAt = t
    commit.lastTick = t
    commit.until = untilDay
    t = advance(bot, ctx, t, 30)
    assert.equal(ctx.goal.commit.until, untilDay + 30000, 'paused, not burned')
    // Day returns: the pin re-applies over the shelter step.
    bot.time.timeOfDay = 6000
    restampRealtime(ctx)
    const d2 = await goal.decide(bot, ctx)
    assert.equal(d2.action, 'gather', 're-pinned after the safety leg')
    assert.equal(ctx.stepPick.source, 'task-plan')
  })

  it('stop ends the window with preempted:stop', async () => {
    const bot = makeBot()
    const { ticker, ctx } = castleCtx(bot)
    const t0 = 1000000000000
    let { t } = await liveWindow(bot, ctx, t0)
    ticker.stop()
    t += 10000
    taskMod.taskTick(bot, ctx, t)
    assert.equal(ctx.goal.commit, null, 'window ended')
    assert.equal(outLogs().length, 1)
    assert.match(outLogs()[0], /result=preempted:stop/)
    assert.equal(ctx.task.castle.wd.rounds, 0, 'preempted rounds do not count')
  })

  it('a generation bump drops an in-flight answer', async () => {
    const bot = makeBot()
    const { ctx } = castleCtx(bot)
    const { calls, brain } = answerBrain('castlefetch')
    ctx.brain = brain
    const t0 = 1000000000000
    taskMod.taskTick(bot, ctx, t0)
    let t = t0
    let guard = 0
    while (!ctx.task.castle.wd?.pending && guard++ < 20) {
      t += 10000
      taskMod.taskTick(bot, ctx, t)
    }
    assert.ok(ctx.task.castle.wd.pending, 'round in flight')
    taskMod.resetTask(ctx) // stop/go/forget/new order between fire and answer
    await flush()
    t += 10000
    taskMod.taskTick(bot, ctx, t)
    assert.equal(calls.length, 1, 'the call fired, wasted')
    assert.equal(wdLogs().length, 0, 'late answer dropped, no line')
    assert.equal((ctx.goal && ctx.goal.commit) || null, null, 'nothing applied')
    assert.equal(ctx.goal.generation, 2, 'fresh goal founded')
  })

  it('death, follow mode and pack-full preempt with their reasons', async () => {
    // Death.
    {
      const bot = makeBot()
      const { ctx } = castleCtx(bot)
      const t0 = 1000000000000
      let { t } = await liveWindow(bot, ctx, t0)
      ctx.deaths = 1
      t += 10000
      taskMod.taskTick(bot, ctx, t)
      assert.equal(ctx.goal.commit, null)
      assert.match(outLogs().pop(), /result=preempted:death/)
    }
    // Follow mode (work off, no order).
    {
      const bot = makeBot()
      const { ctx } = castleCtx(bot)
      const t0 = 1000000000000
      let { t } = await liveWindow(bot, ctx, t0)
      ctx.work = false
      t += 10000
      taskMod.taskTick(bot, ctx, t)
      assert.equal(ctx.goal.commit, null)
      assert.match(outLogs().pop(), /result=preempted:mode/)
    }
    // Pack full: the fetch releases to the honest bank leg.
    {
      const bot = makeBot()
      const { ctx } = castleCtx(bot)
      const t0 = 1000000000000
      let { t } = await liveWindow(bot, ctx, t0)
      const inv = bot.inventory.items()
      inv.length = 0
      for (let i = 0; i < 36; i++) inv.push({ name: 'stone', count: 64 })
      assert.equal(goal.packFull(bot, ctx), true, 'fixture really is full')
      t += 10000
      taskMod.taskTick(bot, ctx, t)
      assert.equal(ctx.goal.commit, null)
      assert.match(outLogs().pop(), /result=preempted:pack-full/)
    }
  })

  it('an order preempts the window as replaced (vmzq.22: orders are goals)', async () => {
    const bot = makeBot()
    const { ctx } = castleCtx(bot)
    const t0 = 1000000000000
    let { t } = await liveWindow(bot, ctx, t0)
    assert.ok(ctx.goal.commit, 'window live')
    ctx.bring = { kind: 'block', name: 'dirt', want: 8, have: 0, phase: 'find' } // errand owns the body
    t += 10000
    taskMod.taskTick(bot, ctx, t)
    // The castle window ends (its goal is no longer active) and bring is watched.
    assert.ok(outLogs().some((l) => /result=preempted:replaced/.test(l)), `replaced: ${JSON.stringify(outLogs())}`)
    assert.equal(ctx.task.active, 'bring', 'the order is now the goal')
    assert.equal(ctx.goal.kind, 'bring')
  })

  it('a failed window step ends the window early with failed:<reason>', async () => {
    const bot = makeBot()
    const { ctx } = castleCtx(bot)
    const t0 = 1000000000000
    await liveWindow(bot, ctx, t0)
    restampRealtime(ctx)
    ctx.stepStatus = 'failed:no-trees'
    const d = await goal.decide(bot, ctx)
    assert.equal(ctx.goal.commit, null, 'window ended early')
    assert.equal(outLogs().length, 1)
    assert.match(outLogs()[0], /choice=castlefetch .* result=failed:no-trees/)
    assert.equal(ctx.task.castle.wd.rounds, 1, 'failed rounds count')
    assert.notEqual(d.action, 'castlefetch', 'the held step is not re-pinned')
    assert.notEqual(ctx.stepPick.source, 'task-plan')
  })

  it('the L2 backstop parks a live window as preempted:park', async () => {
    const bot = makeBot()
    const { ctx } = castleCtx(bot)
    const t0 = 1000000000000
    let { t } = await liveWindow(bot, ctx, t0)
    ctx.task.castle.stallMs = taskMod.TASK_STALL_L2_MS + 1000 // interrupted episodes still hit the backstop
    t += 10000
    taskMod.taskTick(bot, ctx, t)
    assert.equal(ctx.castle.parked, true)
    assert.match(outLogs().pop(), /result=preempted:park/)
  })
})

describe('watchdog consume paths', () => {
  async function firedAnswer(bot, ctx, t0, answer) {
    const calls = []
    ctx.brain = {
      plan: async (req) => {
        calls.push(req)
        if (answer instanceof Error) throw answer
        return answer
      },
    }
    taskMod.taskTick(bot, ctx, t0)
    let t = t0
    let guard = 0
    while (!ctx.task.castle.wd?.pending && guard++ < 20) {
      t += 10000
      taskMod.taskTick(bot, ctx, t)
    }
    assert.ok(ctx.task.castle.wd.pending, 'round fired')
    await flush()
    t += 10000
    taskMod.taskTick(bot, ctx, t) // consume
    return { t, calls }
  }

  it('low-confidence, stale and invalid answers back off without applying', async () => {
    for (const [name, answer, prefix] of [
      ['low-confidence', { step: 'castlefetch', confidence: 0.2, probabilities: { castlefetch: 0.3 }, source: 'jev' }, 'low-confidence conf=0.20'],
      ['stale', { step: 'castle', confidence: 0.9, probabilities: { castle: 0.9 }, source: 'jev' }, 'stale:castle'],
      ['invalid', { step: 'frobnicate', confidence: 0.9, probabilities: { frobnicate: 0.9 }, source: 'jev' }, 'invalid'],
    ]) {
      const bot = makeBot()
      const { ctx } = castleCtx(bot)
      const { t } = await firedAnswer(bot, ctx, 1000000000000, answer)
      assert.equal((ctx.goal && ctx.goal.commit) || null, null, `${name}: nothing applied`)
      assert.equal(ctx.castle.parked, false, `${name}: no park (backoff, not ladder)`)
      assert.ok(
        wdLogs().some((l) => l.includes('choice=none') && l.includes('source=invalid') && l.includes(prefix)),
        `${name}: ${JSON.stringify(wdLogs())}`,
      )
      assert.equal(ctx.task.castle.wd.backoffMs, 30000, `${name}: backoff armed`)
      assert.ok(ctx.task.castle.wd.backoffUntil > t, `${name}: backoff in the future`)
      lines.length = 0
    }
  })

  it('a park choice parks through the watchdog line when the owner is online', async () => {
    const bot = makeBot({ players: { Steve: {} } })
    const { ctx } = castleCtx(bot)
    await firedAnswer(bot, ctx, 1000000000000, { step: 'park', confidence: 0.9, probabilities: { park: 0.9 }, source: 'jev' })
    assert.equal(ctx.castle.parked, true)
    assert.ok(bot.chats.some((c) => c.includes('parked at')), JSON.stringify(bot.chats))
    assert.ok(wdLogs().some((l) => l.includes('choice=park') && l.includes('source=jev')), JSON.stringify(wdLogs()))
  })

  it('a park choice routes to plan-B when the owner is offline (no alone-park)', async () => {
    const bot = makeBot() // players {} = owner offline
    const { ctx } = castleCtx(bot)
    // Stranded gather (gyw): opens the pre-house explore spiral, the
    // relocate leg (same setup as the round-cap plan-B test).
    ctx.gather = { final: 'failed:no-trees', atLogs: 0 }
    await firedAnswer(bot, ctx, 1000000000000, { step: 'park', confidence: 0.9, probabilities: { park: 0.9 }, source: 'jev' })
    assert.equal(ctx.castle.parked, false, 'offline: plan-B, not park')
    assert.equal(ctx.castle.taskPark || null, null, 'no parkTask record')
    assert.equal(ctx.task.castle.wd.planb, 'relocate')
    assert.match(planbLogs()[0], /phase=relocate step=explore/)
    const reloc = ctx.goal.commit
    assert.ok(reloc, 'relocate window live')
    assert.equal(reloc.optionId, 'planb-relocate')
    assert.ok(wdLogs().some((l) => l.includes('choice=park') && l.includes('source=jev')), 'choice still logged')
  })

  it('a held step is offered as a retry and applies past the hold', async () => {
    const bot = makeBot()
    const { ctx } = castleCtx(bot)
    const facts = goal.goalFacts(bot, ctx)
    const text = goal.goalText(facts, ctx.home)
    ctx.stepFail = { gather: { status: 'failed:no-trees', text, pos: null, at: Date.now() } }
    const { calls } = await firedAnswer(bot, ctx, 1000000000000, { step: 'gather', confidence: 0.9, probabilities: { gather: 0.9 }, source: 'jev' })
    assert.ok('gather' in calls[0].criteria, 'held step offered')
    assert.equal(ctx.goal.commit.step, 'gather', 'held step applied past the hold')
    restampRealtime(ctx)
    const d = await goal.decide(bot, ctx)
    assert.equal(d.action, 'gather')
    assert.equal(ctx.stepPick.source, 'task-plan')
    assert.ok(ctx.stepFail.gather, 'the hold record survives the bypass')
  })
})

describe('rounds, park and backoff (acceptance 4)', () => {
  it('6 flat rounds park with the owner online (no plan-B, no L1 before the cap)', async () => {
    const bot = makeBot({ players: { Steve: {} } })
    const { ctx } = castleCtx(bot)
    const { calls, brain } = answerBrain('castlefetch')
    ctx.brain = brain
    const t0 = 1000000000000
    taskMod.taskTick(bot, ctx, t0)
    let t = t0
    for (let r = 0; r < 6; r++) t = await fullRound(bot, ctx, t)
    assert.equal(calls.length, 6)
    assert.equal(wdLogs().length, 6, 'one line per round')
    assert.equal(outLogs().length, 6, 'every round has an outcome')
    assert.ok(outLogs().every((l) => l.includes('result=flat')), JSON.stringify(outLogs()))
    assert.equal(ctx.castle.parked, true, 'round cap parks')
    assert.ok(bot.chats.some((c) => c.includes('parked at')), JSON.stringify(bot.chats))
    assert.equal(bot.chats.filter((c) => c.startsWith('castle: no progress')).length, 0, 'cap hit before the 15 min L1')
    assert.equal(planbLogs().length, 0, 'owner online: park, not plan-B')
    assert.match(taskMod.taskLine(ctx), /task castle 8\/1722 stall=.* round=6/)
  })

  it('the L1 stays and summarises the rounds', async () => {
    const bot = makeBot({ players: { Steve: {} } })
    const { ctx } = castleCtx(bot)
    const { brain } = answerBrain('castlefetch')
    ctx.brain = brain
    const t0 = 1000000000000
    taskMod.taskTick(bot, ctx, t0)
    let t = t0
    t = await fullRound(bot, ctx, t)
    t = await fullRound(bot, ctx, t)
    assert.equal(ctx.task.castle.wd.rounds, 2)
    ctx.brain = null // no more rounds; the stall reaches the L1 with history behind it
    t = advance(bot, ctx, t, 15 * 60)
    assert.ok(bot.chats.some((c) => /still trying, 2 watchdog rounds$/.test(c)), JSON.stringify(bot.chats))
    assert.ok(lines.some((l) => l.startsWith('task castle ') && l.includes('rounds=2')), JSON.stringify(lines))
  })

  it('3 parks in a day latch the L3 (auto-resume between episodes)', async () => {
    const bot = makeBot({ players: { Steve: {} } })
    const { ctx } = castleCtx(bot)
    const { calls, brain } = answerBrain('castlefetch')
    ctx.brain = brain
    const t0 = 1000000000000
    taskMod.taskTick(bot, ctx, t0)
    let t = t0
    for (let ep = 0; ep < 3; ep++) {
      for (let r = 0; r < 6; r++) t = await fullRound(bot, ctx, t)
      assert.equal(ctx.castle.parked, true, `episode ${ep + 1} parked`)
      if (ep < 2) {
        t = advance(bot, ctx, t, 61 * 60)
        assert.equal(ctx.castle.parked, false, `episode ${ep + 1} auto-resumed`)
      }
    }
    assert.equal(calls.length, 18)
    assert.equal(wdLogs().length, 18)
    assert.equal(outLogs().length, 18)
    assert.deepEqual(ctx.castle.parkHist, { day: '2001-09-09', n: 3 })
    assert.equal(ctx.castle.taskPark.auto, false, 'latched: waits for the owner')
    assert.equal(bot.chats.filter((c) => c.includes('parked at')).length, 2)
    assert.equal(bot.chats.filter((c) => c.includes('for the day')).length, 1)
  })

  it('JEV timeouts back off exponentially; at most one call per interval; the FSM keeps ticking', async () => {
    const bot = makeBot()
    const { ctx } = castleCtx(bot)
    const { calls, brain } = failingBrain(new DOMException('brain timeout', 'TimeoutError'))
    ctx.brain = brain
    const t0 = 1000000000000
    taskMod.taskTick(bot, ctx, t0)
    let t = t0
    const firedAt = []
    for (let k = 0; k < 3; k++) {
      let guard = 0
      while (!ctx.task.castle.wd?.pending && guard++ < 40) {
        t += 10000
        taskMod.taskTick(bot, ctx, t)
      }
      assert.ok(ctx.task.castle.wd.pending, `fire ${k + 1}`)
      firedAt.push(ctx.task.castle.wd.firedAt)
      await flush()
      t += 10000
      taskMod.taskTick(bot, ctx, t) // consume -> backoff line
    }
    assert.equal(calls.length, 3)
    assert.equal(wdLogs().length, 3)
    assert.ok(wdLogs().every((l) => l.includes('choice=none') && l.includes('source=timeout')), JSON.stringify(wdLogs()))
    assert.equal(ctx.task.castle.wd.backoffMs, 120000, '30 s doubling per failure')
    for (let k = 1; k < firedAt.length; k++) {
      assert.ok(firedAt[k] - firedAt[k - 1] >= 60000, 'at most one call per interval')
    }
    assert.equal(ctx.task.castle.wd.rounds, 0, 'failures are not rounds')
    assert.equal(ctx.task.castle.wd.lowConf, 0, 'transport errors never feed the fallback streak')
    assert.equal(ctx.castle.parked, false, 'no park on failures alone')
    const d = await goal.decide(bot, ctx)
    assert.ok(d && d.action, 'the FSM keeps ticking through the backoff')
  })

  it('a 429 backs off as an http failure', async () => {
    const bot = makeBot()
    const { ctx } = castleCtx(bot)
    const { brain } = failingBrain(new Error('jev http 429'))
    ctx.brain = brain
    const t0 = 1000000000000
    taskMod.taskTick(bot, ctx, t0)
    let t = t0
    let guard = 0
    while (!ctx.task.castle.wd?.pending && guard++ < 20) {
      t += 10000
      taskMod.taskTick(bot, ctx, t)
    }
    await flush()
    t += 10000
    taskMod.taskTick(bot, ctx, t)
    assert.ok(wdLogs().some((l) => l.includes('source=http')), JSON.stringify(wdLogs()))
    assert.equal(ctx.task.castle.wd.backoffMs, 30000)
  })
})

describe('plan-B when the owner is offline (owner 2026-10-07)', () => {
  it('relocate, re-ask with history, switch to the house, return on the timer', async () => {
    const bot = makeBot() // players {} = owner offline
    const { ticker, ctx } = castleCtx(bot)
    ticker.setHome({ site: { x: 0, y: 64, z: 0 }, built: false, v: 2 })
    ticker.work() // resetNightStep clears the step: re-apply the running leg
    ctx.step = 'castlefetch'
    ctx.stepStatus = 'running'
    ctx.stepPick = { step: 'castlefetch', at: Date.now() - 5000, source: 'goal-fsm', why: 'fetch stone' }
    // Stranded gather (gyw): opens the pre-house explore spiral, the
    // relocate leg. atLogs matches the empty pack.
    ctx.gather = { final: 'failed:no-trees', atLogs: 0 }
    const { calls, brain } = answerBrain('castlefetch')
    ctx.brain = brain
    const t0 = 1000000000000
    taskMod.taskTick(bot, ctx, t0)
    let t = t0
    for (let r = 0; r < 5; r++) t = await fullRound(bot, ctx, t)
    // Round 6 by hand: stop exactly when its window ends, so the
    // relocate leg is live for the assertions below.
    {
      let guard = 0
      while (!ctx.task.castle.wd?.pending && guard++ < 40) {
        t += 10000
        taskMod.taskTick(bot, ctx, t)
      }
      assert.ok(ctx.task.castle.wd.pending, 'round 6 fired')
      await flush()
      t += 10000
      taskMod.taskTick(bot, ctx, t) // consume
      for (let s = 0; s < 12; s++) {
        t += 10000
        taskMod.taskTick(bot, ctx, t)
      }
    }
    assert.equal(ctx.task.castle.wd.rounds, 6)
    assert.equal(ctx.castle.parked, false, 'offline: no park at the cap')
    assert.equal(planbLogs().length, 1, 'relocate announced')
    assert.match(planbLogs()[0], /phase=relocate step=explore/)
    const reloc = ctx.goal.commit
    assert.ok(reloc, 'relocate window live')
    assert.equal(reloc.optionId, 'planb-relocate')
    assert.equal(reloc.step, 'explore')
    // The relocate leg runs flat: no switch yet — JEV is re-asked first
    // with the leg in history.
    {
      let guard = 0
      while (ctx.goal.commit && guard++ < 40) {
        t += 10000
        taskMod.taskTick(bot, ctx, t)
      }
    }
    assert.equal(ctx.task.castle.wd.rounds, 6, 'the leg is not a round and does not fork')
    t = await fullRound(bot, ctx, t) // round 7 with the relocate outcome in history
    const h7 = calls[6].state.history
    assert.equal(h7[h7.length - 1].choice, 'planb-relocate', 're-asked with the leg in history')
    assert.equal(h7[h7.length - 1].outcome, 'flat')
    assert.equal(ctx.castle.parked, true, 'still flat after the re-ask: switch')
    assert.ok(ctx.castle.planb && typeof ctx.castle.planb.at === 'number', 'switch stamp set')
    assert.match(planbLogs()[1], /phase=switch to=house for=450s/)
    t += 10000 // the switch landed mid-tick; the next tick flips the watch
    taskMod.taskTick(bot, ctx, t)
    assert.equal(ctx.task.active, 'house', 'the other goal is now watched')
    // A restart mid-switch resumes the timer instead of fossilizing.
    const fs = require('node:fs')
    const os = require('node:os')
    const path = require('node:path')
    const memory = require('../src/memory')
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wd-planb-'))
    try {
      const file = path.join(dir, 'bot.json')
      assert.equal(memory.save(bot, ctx, file, t), true)
      const fresh = {}
      memory.restore(bot, fresh, file, t)
      assert.equal(fresh.castle.parked, true)
      assert.equal(fresh.castle.planb.at, ctx.castle.planb.at, 'stamp persisted')
    } finally {
      try { fs.rmSync(dir, { recursive: true, force: true }) } catch (_) { /* tmp best-effort */ }
    }
    // The switch timer returns to the castle with a fresh episode.
    ctx.brain = null // the house episode is not under test here
    const tSwitch = t
    t = advance(bot, ctx, t, 8 * 60)
    assert.ok(t - tSwitch >= 450000, 'timer covered')
    assert.ok(planbLogs().some((l) => l === 'goal planb kind=castle phase=return'), JSON.stringify(planbLogs()))
    assert.equal(ctx.castle.parked, false)
    assert.equal(ctx.castle.planb, null)
    assert.equal(ctx.task.active, 'castle')
    const freshWd = ctx.task.castle.wd
    assert.equal((freshWd && freshWd.rounds) || 0, 0, 'returned goal restarts the round count')
    assert.deepEqual((freshWd && freshWd.history) || [], [], 'returned goal restarts history')
    assert.match(taskMod.taskLine(ctx), /^task castle 8\/1722 stall=\d+s$/, 'no round count on the fresh episode')
  })

  it('no other goal: relocate skipped without a leg, then the deterministic park', async () => {
    const bot = makeBot()
    const { ctx } = castleCtx(bot) // no home at all: no relocate leg, no other goal
    const { brain } = answerBrain('castlefetch')
    ctx.brain = brain
    const t0 = 1000000000000
    taskMod.taskTick(bot, ctx, t0)
    let t = t0
    for (let r = 0; r < 6; r++) t = await fullRound(bot, ctx, t)
    assert.ok(planbLogs().some((l) => l.includes('phase=relocate skipped=no-feasible-leg')), JSON.stringify(planbLogs()))
    assert.equal(ctx.castle.parked, false)
    t = await fullRound(bot, ctx, t) // round 7, still flat
    assert.ok(planbLogs().some((l) => l.includes('phase=switch skipped=no-other-goal')), JSON.stringify(planbLogs()))
    assert.equal(ctx.castle.parked, true, 'nothing else to try: park')
    assert.ok(bot.chats.some((c) => c.includes('parked at')), JSON.stringify(bot.chats))
  })

  it('an oscillation top-up inside the window reads flat against the high-water mark (revmux 01 core-1)', async () => {
    const bot = makeBot()
    const { ctx } = castleCtx(bot)
    const { brain } = answerBrain('castlefetch')
    ctx.brain = brain
    const inv = bot.inventory.items()
    const t0 = 1000000000000
    taskMod.taskTick(bot, ctx, t0) // stone mark 57
    let t = t0
    let guard = 0
    while (!ctx.task.castle.wd?.pending && guard++ < 20) {
      t += 10000
      taskMod.taskTick(bot, ctx, t)
    }
    assert.ok(ctx.task.castle.wd.pending, 'round fired')
    // Dip before the answer lands, so the point reading at consume time
    // (53) sits below the clock's high-water mark (57).
    inv[0].count = 69
    await flush()
    t += 10000
    taskMod.taskTick(bot, ctx, t) // consume
    assert.ok(ctx.goal.commit, 'window live')
    assert.equal(ctx.goal.commit.snapshot.matHave, 57, 'snapshot carries the mark, not the dip')
    // Rise back to the mark mid-window: movement, but no clock progress.
    t += 10000
    inv[0].count = 73
    taskMod.taskTick(bot, ctx, t)
    guard = 0
    while (ctx.goal.commit && guard++ < 40) {
      t += 10000
      taskMod.taskTick(bot, ctx, t)
    }
    assert.equal(outLogs().length, 1)
    assert.match(outLogs()[0], /delta=cells8->8 result=flat unlock=-$/, `top-up is flat: ${JSON.stringify(outLogs())}`)
    assert.equal(ctx.task.castle.wd.rounds, 1, 'the round cap still binds')
  })

  it('endless flips grant exactly one grace; progress re-arms the cap (revmux 01 core-2)', async () => {
    const bot = makeBot()
    const { ctx } = castleCtx(bot)
    const { brain } = answerBrain('castlefetch')
    ctx.brain = brain
    const inv = bot.inventory.items()
    const t0 = 1000000000000
    taskMod.taskTick(bot, ctx, t0)
    // Flip castle<->castlefetch on EVERY tick with fresh picks, stone
    // oscillating: the old floor granted every ~90 s and silenced the
    // ladder; the cap grants once and the watchdog fires on time.
    let t = t0
    for (let s = 0; s < 10; s++) {
      t += 10000
      inv[0].count = s % 2 === 0 ? 69 : 73
      ctx.step = s % 2 === 0 ? 'castle' : 'castlefetch'
      ctx.stepStatus = 'running'
      ctx.stepPick = { step: ctx.step, at: t, source: 'goal-fsm', why: 'flip' }
      taskMod.taskTick(bot, ctx, t)
    }
    assert.equal(resetLogs().filter((l) => l.endsWith('why=grace')).length, 1, `one grace: ${JSON.stringify(resetLogs())}`)
    let guard = 0
    while (!ctx.task.castle.wd?.pending && guard++ < 20) {
      t += 10000
      inv[0].count = inv[0].count === 73 ? 69 : 73
      ctx.step = 'castlefetch'
      ctx.stepStatus = 'running'
      taskMod.taskTick(bot, ctx, t)
    }
    assert.ok(ctx.task.castle.wd.pending, 'watchdog fires despite the flips')
    assert.ok(ctx.task.castle.wd.firedAt - t0 <= 200000, 'fire is not pushed out by re-grants')
    // Progress opens a new episode: the next fresh run grants again.
    await flush()
    t += 10000
    taskMod.taskTick(bot, ctx, t) // consume (commit live, details unasserted)
    inv[0].count = 90 // usable 74: genuine growth past the 57 mark
    t += 10000
    taskMod.taskTick(bot, ctx, t)
    assert.ok(resetLogs().some((l) => l === 'goal reset kind=castle why=material:stone'))
    assert.equal(ctx.goal.commit, null, 'progress ends the window')
    ctx.step = 'castle'
    ctx.stepStatus = 'running'
    t += 10000
    taskMod.taskTick(bot, ctx, t)
    ctx.step = 'castlefetch'
    ctx.stepStatus = 'running'
    ctx.stepPick = { step: 'castlefetch', at: t + 10000, source: 'goal-fsm', why: 'new leg' }
    t += 10000
    taskMod.taskTick(bot, ctx, t)
    assert.equal(resetLogs().filter((l) => l.endsWith('why=grace')).length, 2, 'new episode re-arms the cap')
  })

  it('a degraded pin neither churns nor asks; a pinable one still forces on static facts (revmux 01 core-3)', async () => {
    const bot = makeBot()
    const { ctx } = castleCtx(bot)
    const asks = []
    const { brain } = answerBrain('gather')
    brain.ask = async (q) => {
      asks.push(q)
      return 'castlefetch'
    }
    ctx.brain = brain
    const inv = bot.inventory.items()
    const t0 = 1000000000000
    taskMod.taskTick(bot, ctx, t0)
    let t = t0
    let guard = 0
    while (!ctx.task.castle.wd?.pending && guard++ < 20) {
      t += 10000
      taskMod.taskTick(bot, ctx, t)
    }
    await flush()
    t += 10000
    taskMod.taskTick(bot, ctx, t) // consume: gather pinned, step still on the fetch
    assert.ok(ctx.goal.commit, 'window live')
    assert.equal(ctx.goal.commit.step, 'gather')
    // Static facts, body elsewhere (shelter leg just ended): the force
    // applies the pin without waiting for a facts change.
    ctx.step = 'shelter'
    ctx.stepStatus = 'running'
    restampRealtime(ctx)
    const facts = goal.goalFacts(bot, ctx)
    ctx.goalText = goal.goalText(facts, ctx.home)
    ctx.askedKey = `${ctx.goalText}\nrunning`
    let d = await goal.decide(bot, ctx)
    assert.equal(d.action, 'gather', 'force applies the pin on static facts')
    assert.equal(ctx.stepPick.source, 'task-plan')
    assert.equal(asks.length, 0, 'the singleton pin asks nothing')
    // Gather dies (failed hold): the pin degrades, one honest re-decide
    // moves the menu on, and the window must NOT force a re-decide
    // every tick behind it.
    inv.push({ name: 'oak_log', count: 1 }) // flip the facts text...
    ctx.gather = { final: 'failed:no-trees', atLogs: 1 } // ...and hold gather there
    d = await goal.decide(bot, ctx)
    assert.notEqual(d.action, 'gather', 'degraded pin releases the step')
    // From here the facts are static: the shortcut must re-issue (ask
    // lives only behind the re-decide branch, so no branch means no ask).
    const at = ctx.stepPick.at
    const askCount = asks.length
    d = await goal.decide(bot, ctx)
    assert.equal(d.source, 'goal-fsm', 'shortcut, not force')
    assert.equal(ctx.stepPick.at, at, 'no re-stamp without a re-decide')
    assert.equal(asks.length, askCount, 'no ask behind a degraded pin')
    d = await goal.decide(bot, ctx)
    assert.equal(d.source, 'goal-fsm')
    assert.equal(ctx.stepPick.at, at, 'still quiet on the third tick')
    assert.equal(asks.length, askCount)
    assert.ok(ctx.goal.commit, 'the window itself survives the degrade')
  })

  it('an answer whose stall resolved mid-call is moot: dropped, no pin, no backoff', async () => {
    const bot = makeBot()
    const { ctx } = castleCtx(bot)
    const { calls, brain } = answerBrain('castlefetch')
    ctx.brain = brain
    const inv = bot.inventory.items()
    const t0 = 1000000000000
    taskMod.taskTick(bot, ctx, t0)
    let t = t0
    let guard = 0
    while (!ctx.task.castle.wd?.pending && guard++ < 20) {
      t += 10000
      taskMod.taskTick(bot, ctx, t)
    }
    assert.ok(ctx.task.castle.wd.pending, 'round fired')
    await flush()
    // Progress lands on the consume tick: the progress block runs first
    // and returns, so the answer waits one more tick — over a resolved
    // stall.
    inv[0].count = 90 // usable 74 > 57
    t += 10000
    taskMod.taskTick(bot, ctx, t)
    assert.ok(resetLogs().some((l) => l === 'goal reset kind=castle why=material:stone'))
    t += 10000
    taskMod.taskTick(bot, ctx, t) // consume attempt: moot
    assert.equal(calls.length, 1, 'the call fired, wasted')
    assert.equal(wdLogs().length, 0, 'no line for a moot answer')
    assert.equal((ctx.goal && ctx.goal.commit) || null, null, 'no pin on a resolved stall')
    assert.equal(ctx.task.castle.wd.backoffMs, 0, 'a drop is not a failure')
  })

  it('an owner castle stop over a switch clears the stamp (no auto-expiry of an owner park)', async () => {
    const { handleChat } = require('../src/index')
    const bot = makeBot()
    const { ticker, ctx } = castleCtx(bot)
    const t0 = 1000000000000
    taskMod.taskTick(bot, ctx, t0)
    // A live plan-B switch, then the owner takes over through chat.
    ctx.castle.parked = true
    ctx.castle.planb = { at: t0 }
    handleChat(bot, ticker, 'Steve', 'castle stop')
    assert.equal(ctx.castle.parked, true)
    assert.equal(ctx.castle.planb, null, 'owner park carries no switch stamp')
    assert.ok(bot.chats.some((c) => c.includes('castle parked')), JSON.stringify(bot.chats))
    taskMod.taskTick(bot, ctx, t0 + 600000)
    assert.equal(ctx.castle.parked, true, 'owner park stands past the switch timer')
  })
})

describe('deterministic fallback (vmzq.28)', () => {
  async function firedAnswer(bot, ctx, t0, answer) {
    const calls = []
    ctx.brain = {
      plan: async (req) => {
        calls.push(req)
        if (answer instanceof Error) throw answer
        return answer
      },
    }
    taskMod.taskTick(bot, ctx, t0)
    let t = t0
    let guard = 0
    while (!ctx.task.castle.wd?.pending && guard++ < 60) {
      t += 10000
      taskMod.taskTick(bot, ctx, t)
    }
    assert.ok(ctx.task.castle.wd.pending, 'round fired')
    await flush()
    t += 10000
    taskMod.taskTick(bot, ctx, t) // consume
    return { t, calls }
  }

  async function fireNext(bot, ctx, t, answer) {
    ctx.brain = {
      plan: async (req) => {
        if (answer instanceof Error) throw answer
        return answer
      },
    }
    let guard = 0
    while (!ctx.task.castle.wd?.pending && guard++ < 60) {
      t += 10000
      taskMod.taskTick(bot, ctx, t)
    }
    assert.ok(ctx.task.castle.wd.pending, 'next round fired')
    await flush()
    t += 10000
    taskMod.taskTick(bot, ctx, t) // consume
    return t
  }

  const lowConf = (step) => ({ step, confidence: 0.2, probabilities: { [step]: 0.3 }, source: 'jev' })

  it('first low-conf backs off, second applies the top fresh step (not the stalling one)', async () => {
    const bot = makeBot()
    const { ctx } = castleCtx(bot)
    const t0 = 1000000000000
    const first = await firedAnswer(bot, ctx, t0, lowConf('gather'))
    assert.equal(wdLogs().length, 1)
    assert.ok(wdLogs()[0].includes('choice=none'), JSON.stringify(wdLogs()))
    assert.equal((ctx.goal && ctx.goal.commit) || null, null, 'first none backs off')
    assert.equal(ctx.task.castle.wd.lowConf, 1)
    await fireNext(bot, ctx, first.t, lowConf('gather'))
    assert.equal(wdLogs().length, 2)
    assert.ok(wdLogs()[1].includes('source=fallback'), JSON.stringify(wdLogs()))
    // castleCtx stalls on castlefetch: fallback takes gather, never re-commits it.
    assert.ok(wdLogs()[1].includes('choice=gather'), JSON.stringify(wdLogs()))
    const commit = ctx.goal && ctx.goal.commit
    assert.ok(commit, 'fallback applied')
    assert.equal(commit.optionId, 'gather')
    assert.equal(ctx.task.castle.wd.lowConf, 0, 'streak cleared on fallback')
    assert.equal(ctx.task.castle.wd.backoffMs, 0, 'no backoff on fallback')
  })

  it('fallback takes the far option when offered', async () => {
    const bot = makeBot()
    bot.registry = { blocksByName: { stone: { id: 1 } } }
    bot.findBlocks = () => [{ x: 100, y: 64, z: 136 }]
    const set = new Set(['100,64,136'])
    bot.blockAt = (p) => {
      const x = Math.floor(p.x)
      const y = Math.floor(p.y)
      const z = Math.floor(p.z)
      const name = set.has(`${x},${y},${z}`) ? 'stone' : (y >= 65 ? 'air' : 'dirt')
      return { name, position: pos(x, y, z), boundingBox: name === 'air' ? 'empty' : 'block' }
    }
    const { ctx } = castleCtx(bot)
    const t0 = 1000000000000
    const first = await firedAnswer(bot, ctx, t0, lowConf('gather'))
    assert.ok(wdLogs()[0].includes('castlefetch-far'), `far offered: ${wdLogs()[0]}`)
    await fireNext(bot, ctx, first.t, lowConf('gather'))
    assert.ok(wdLogs()[1].includes('choice=castlefetch-far'), JSON.stringify(wdLogs()))
    assert.ok(wdLogs()[1].includes('source=fallback'), JSON.stringify(wdLogs()))
    const commit = ctx.goal && ctx.goal.commit
    assert.ok(commit && commit.unlock && commit.unlock.candidate, 'far unlock rides')
    assert.deepEqual(commit.unlock.candidate, { x: 100, y: 64, z: 136 })
  })

  it('a confident JEV choice clears the streak', async () => {
    const bot = makeBot()
    const { ctx } = castleCtx(bot)
    const t0 = 1000000000000
    const first = await firedAnswer(bot, ctx, t0, lowConf('gather'))
    assert.equal(ctx.task.castle.wd.lowConf, 1)
    await fireNext(bot, ctx, first.t, { step: 'gather', confidence: 0.9, probabilities: { gather: 0.9 }, source: 'jev' })
    assert.ok(wdLogs()[1].includes('choice=gather') && wdLogs()[1].includes('source=jev'), JSON.stringify(wdLogs()))
    assert.equal(ctx.task.castle.wd.lowConf, 0, 'a decision clears the streak')
  })

  it('progress clears the streak', async () => {
    const bot = makeBot()
    const { ctx } = castleCtx(bot)
    const t0 = 1000000000000
    await firedAnswer(bot, ctx, t0, lowConf('gather'))
    assert.equal(ctx.task.castle.wd.lowConf, 1)
    const inv = bot.inventory.items()
    inv[0].count = 90 // usable 74 > 57: material progress
    taskMod.taskTick(bot, ctx, t0 + 300000)
    assert.equal(ctx.task.castle.wd.lowConf, 0, 'progress starts a fresh episode')
  })

  it('fallback #2 skips the option fallback #1 proved flat', async () => {
    const bot = makeBot()
    const { ctx } = castleCtx(bot)
    const t0 = 1000000000000
    const first = await firedAnswer(bot, ctx, t0, lowConf('gather'))
    const t2 = await fireNext(bot, ctx, first.t, lowConf('gather'))
    assert.ok(wdLogs()[1].includes('choice=gather'), JSON.stringify(wdLogs()))
    // Run the fallback window out flat: history names gather.
    let t = t2
    let guard = 0
    while (ctx.goal && ctx.goal.commit && guard++ < 40) {
      t += 10000
      taskMod.taskTick(bot, ctx, t)
    }
    assert.equal((ctx.goal && ctx.goal.commit) || null, null, 'fallback window ended')
    assert.ok(outLogs().some((l) => l.includes('choice=gather') && l.includes('result=flat')), JSON.stringify(outLogs()))
    const t3 = await fireNext(bot, ctx, t, lowConf('gather'))
    assert.ok(wdLogs()[2].includes('choice=none'), JSON.stringify(wdLogs()))
    await fireNext(bot, ctx, t3, lowConf('gather'))
    assert.ok(wdLogs()[3].includes('source=fallback'), JSON.stringify(wdLogs()))
    assert.ok(wdLogs()[3].includes('choice=castlefetch'), `second fallback moves on: ${JSON.stringify(wdLogs())}`)
  })
})
