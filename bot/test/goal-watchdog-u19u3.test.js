'use strict'

// Deadlock escalation, phase C (idkcraft-u19u): the work-mode twin of the
// task-executive watchdog. A rest-only stretch with owed needs past the
// watchdog window, or an A->B->A action loop x3, fires ONE contextual
// plan() with full deadlock context; the answer applies as a bounded pick
// (cooldown <= 120 s) and every failure falls back to the FSM answer.
// Zero model calls while progressing. No live model: the plan() stub
// answers observably via promise flushes.

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const goal = require('../src/goal')
const taskMod = require('../src/task')
const metrics = require('../src/metrics')

function pos(x, y, z) {
  return { x, y, z, distanceTo: (q) => Math.hypot(x - q.x, y - q.y, z - q.z) }
}

function dlBot({ items = [], timeOfDay = 6000, food = 20 } = {}) {
  return {
    entity: { position: pos(0, 64, 0) },
    inventory: { items: () => items },
    time: { timeOfDay },
    spawnPoint: pos(0, 64, 0),
    blockAt: () => ({ name: 'air' }),
    pathfinder: {},
    chat: () => {},
    food,
    health: 20,
  }
}

// Work-mode ctx: no orders, no castle, no house site — goalKind reads null.
function dlCtx(over = {}) {
  return { step: 'rest', stepStatus: 'running', ...over }
}

// Day facts with owed beds (an unmet need); gather feasible, rest in menu.
function owedFacts(over = {}) {
  return {
    time: 'day', castle: 'none', player: 'none', home: 'none', known: 'none',
    haul: 'none', surplus: 'no', pinned: 'none', beds: 'none', gear: 'done',
    sword: 0, pickaxe: 0, pickWord: 'no', cobble: 0, logs: 0, planks: 0,
    unlit: 0, torches: 0, rearm: false, health: 20, food: 20, inside: 'no',
    maxPlanks: 0, table: 0, door: 0, scaffold: 0,
    chest: 'no', chestTodo: 'none', gearHandover: 'none',
    coal: 0, charcoal: 0, sticks: 0, tablePlaced: false, houseTable: false,
    tableOwed: false, ...over,
  }
}

// Needs met: no owed need in facts.
function clearFacts(over = {}) {
  return owedFacts({ beds: 'both', pickaxe: 1, pickWord: 'stone', sword: 1, ...over })
}

function planBrain(answer = { step: 'gather', confidence: 0.8, source: 'jev' }, source = 'jev') {
  return {
    source,
    planner: source,
    calls: 0,
    reqs: [],
    plan: async function (req) {
      this.calls++
      this.reqs.push(req)
      if (typeof answer === 'function') return answer(req, this)
      if (answer instanceof Error) throw answer
      return answer
    },
  }
}

function timeoutBrain() {
  const err = new Error('jev http 504')
  err.name = 'TimeoutError'
  return planBrain(err)
}

const flush = () => new Promise((r) => setTimeout(r, 10))

function dlExtra(bot, ctx) {
  return { bot, ctx }
}

function seedRest(over = {}) {
  return {
    restSince: Date.now() - 61000, restPicks: 4, chain: [], lastStep: 'rest',
    seq: 0, pending: null, answer: null, key: null, trigger: null,
    model: null, firedAt: 0, cooldownUntil: 0, rounds: 0, ...over,
  }
}

async function metricText() {
  return metrics.client.register.metrics()
}

async function countSeries(re, before) {
  const text = await metricText()
  let sum = 0
  for (const line of text.split('\n')) {
    const m = line.match(re)
    if (m) sum += Number(m[1])
  }
  return sum - before
}

async function escalationBefore() {
  const text = await metricText()
  const m = text.match(/idkcraft_bot_escalation_total\{[^}]*\} ([0-9.]+)/g)
  return m ? m.reduce((s, l) => s + Number(l.split(' ').pop()), 0) : 0
}

async function watchdogWorkBefore() {
  const text = await metricText()
  const lines = text.match(/idkcraft_bot_goal_watchdog_total\{[^}]*kind="work"[^}]*\} ([0-9.]+)/g)
  return lines ? lines.reduce((s, l) => s + Number(l.split(' ').pop()), 0) : 0
}

describe('deadlock rest-stretch (u19u phase C)', () => {
  it('fires ONE plan() past the window with owed needs, FSM answers the fire tick', async () => {
    const bot = dlBot()
    const ctx = dlCtx({ deadlock: seedRest() })
    const brain = planBrain()
    const facts = owedFacts()
    const r = await taskMod.deadlockChoose(brain, facts, ['gather', 'rest'], null, dlExtra(bot, ctx), 'rest')
    assert.equal(brain.calls, 1)
    assert.deepEqual(r, { step: 'rest', source: 'goal-fsm', fsm: 'rest', model: null })
    // Full deadlock context on the one request.
    const req = brain.reqs[0]
    assert.equal(req.state.goal, 'unstick the work loop')
    assert.match(String(req.state.blocked_on), /rest:/)
    assert.ok(req.criteria.gather)
    assert.ok(req.criteria.park)
    assert.ok(!('rest' in req.criteria))
    assert.match(String(req.instructions), /prefer the owed need the facts name/)
    // A second re-decide while in flight spends no second call.
    const r2 = await taskMod.deadlockChoose(brain, facts, ['gather', 'rest'], null, dlExtra(bot, ctx), 'rest')
    assert.equal(r2, null)
    assert.equal(brain.calls, 1)
  })

  it('does not fire when needs are met, at night, low-hp-gated, or parked', async () => {
    for (const [name, facts, ctxOver] of [
      ['needs-met', clearFacts(), {}],
      ['night', owedFacts({ time: 'night' }), {}],
      ['low-hp', owedFacts({ health: 3 }), {}],
      ['parked', owedFacts(), { home: { parked: true } }],
    ]) {
      const bot = dlBot()
      const ctx = dlCtx({ deadlock: seedRest(), ...ctxOver })
      const brain = planBrain()
      const r = await taskMod.deadlockChoose(brain, facts, ['gather', 'rest'], null, dlExtra(bot, ctx), name)
      assert.equal(r, null, name)
      assert.equal(brain.calls, 0, name)
    }
  })

  it('needs a full window: a fresh stretch does not fire', async () => {
    const bot = dlBot()
    const ctx = dlCtx({})
    const brain = planBrain()
    const r = await taskMod.deadlockChoose(brain, owedFacts(), ['gather', 'rest'], null, dlExtra(bot, ctx), 'rest')
    assert.equal(r, null)
    assert.equal(brain.calls, 0)
    assert.ok(ctx.deadlock.restSince != null)
  })
})

describe('deadlock action loop (u19u phase C)', () => {
  const now = Date.now()
  const loopChain = (steps) => steps.map(() => ({ step: null, at: now })).map((e, i) => ({ step: steps[i], at: now }))

  it('fires on A->B->A x3 without an intervening done', async () => {
    const bot = dlBot()
    const ctx = dlCtx({
      step: 'forage',
      stepStatus: 'failed:stuck',
      deadlock: seedRest({
        restSince: null,
        restPicks: 0,
        lastStep: 'gather',
        chain: loopChain(['gather', 'forage', 'gather', 'forage', 'gather']),
      }),
    })
    const brain = planBrain()
    const r = await taskMod.deadlockChoose(brain, clearFacts(), ['gather', 'forage', 'rest'], null, dlExtra(bot, ctx), 'gather')
    assert.equal(brain.calls, 1)
    assert.deepEqual(r, { step: 'gather', source: 'goal-fsm', fsm: 'gather', model: null })
    assert.equal(brain.reqs[0].state.goal, 'unstick the work loop')
    assert.match(String(brain.reqs[0].state.blocked_on), /loop: /)
  })

  it('does not fire on three distinct steps or after a done', async () => {
    const bot = dlBot()
    // Three distinct steps rotating: not a 2-step loop.
    const ctx = dlCtx({
      step: 'explore',
      stepStatus: 'failed:stuck',
      deadlock: seedRest({
        restSince: null,
        lastStep: 'forage',
        chain: loopChain(['gather', 'forage', 'explore', 'gather', 'forage']),
      }),
    })
    const brain = planBrain()
    const r = await taskMod.deadlockChoose(brain, clearFacts(), ['gather', 'forage', 'explore', 'rest'], null, dlExtra(bot, ctx), 'gather')
    assert.equal(r, null)
    assert.equal(brain.calls, 0)
    // A done resets the whole episode.
    const ctx2 = dlCtx({
      step: 'gather',
      stepStatus: 'done',
      deadlock: seedRest({ chain: loopChain(['gather', 'forage', 'gather', 'forage', 'gather', 'forage']) }),
    })
    const brain2 = planBrain()
    const r2 = await taskMod.deadlockChoose(brain2, clearFacts(), ['gather', 'forage', 'rest'], null, dlExtra(bot, ctx2), 'gather')
    assert.equal(r2, null)
    assert.equal(brain2.calls, 0)
    assert.deepEqual(ctx2.deadlock.chain, [])
    assert.equal(ctx2.deadlock.restSince, null)
  })
})

describe('deadlock consume + cooldown (u19u phase C)', () => {
  it('applies a valid answer as a bounded pick, then cools down', async () => {
    const bot = dlBot()
    const ctx = dlCtx({ deadlock: seedRest() })
    const brain = planBrain({ step: 'gather', confidence: 0.8, source: 'jev' })
    const facts = owedFacts()
    const menu = ['gather', 'rest']
    await taskMod.deadlockChoose(brain, facts, menu, null, dlExtra(bot, ctx), 'rest')
    await flush()
    const before = await watchdogWorkBefore()
    const r = await taskMod.deadlockChoose(brain, facts, menu, null, dlExtra(bot, ctx), 'rest')
    assert.deepEqual(r, { step: 'gather', source: 'deadlock-plan', fsm: 'rest', model: 'jev' })
    assert.equal(brain.calls, 1)
    const after = await watchdogWorkBefore()
    assert.equal(after - before, 1)
    // Commit window: bounded, never above 120 s.
    const wait = ctx.deadlock.cooldownUntil - Date.now()
    assert.ok(wait > 0 && wait <= 120000, `cooldown ${wait}ms out of (0,120000]`)
    // Continued stall inside the window spends no second call.
    const r2 = await taskMod.deadlockChoose(brain, facts, menu, null, dlExtra(bot, ctx), 'rest')
    assert.equal(r2, null)
    assert.equal(brain.calls, 1)
  })

  it('progress resets the episode and drops the late answer', async () => {
    const bot = dlBot()
    const ctx = dlCtx({ deadlock: seedRest() })
    const brain = planBrain({ step: 'gather', confidence: 0.8 })
    const facts = owedFacts()
    const menu = ['gather', 'rest']
    await taskMod.deadlockChoose(brain, facts, menu, null, dlExtra(bot, ctx), 'rest')
    assert.equal(brain.calls, 1)
    // A step-done before the answer lands ends the episode.
    ctx.stepStatus = 'done'
    const r = await taskMod.deadlockChoose(brain, facts, menu, null, dlExtra(bot, ctx), 'rest')
    assert.equal(r, null)
    assert.equal(ctx.deadlock.pending, null)
    await flush()
    assert.equal(ctx.deadlock.answer, null)
    // A fresh stall fires fresh (time-travel past the min-interval guard).
    ctx.stepStatus = 'running'
    ctx.deadlock.restSince = Date.now() - 61000
    ctx.deadlock.firedAt = 0
    const r2 = await taskMod.deadlockChoose(brain, facts, menu, null, dlExtra(bot, ctx), 'rest')
    assert.equal(brain.calls, 2)
    assert.ok(r2)
  })
})

describe('deadlock fallback (u19u phase C)', () => {
  it('timeout answers fall back to FSM with an escalation count', async () => {
    const bot = dlBot()
    const ctx = dlCtx({ deadlock: seedRest() })
    const brain = timeoutBrain()
    const facts = owedFacts()
    const menu = ['gather', 'rest']
    await taskMod.deadlockChoose(brain, facts, menu, null, dlExtra(bot, ctx), 'rest')
    assert.equal(brain.calls, 1)
    await flush()
    const before = await escalationBefore()
    const r = await taskMod.deadlockChoose(brain, facts, menu, null, dlExtra(bot, ctx), 'rest')
    assert.deepEqual(r, { step: 'rest', source: 'fsm-fallback', fsm: 'rest', model: 'jev' })
    const after = await escalationBefore()
    assert.equal(after - before, 1)
    // Failure backs off: no immediate re-fire.
    const r2 = await taskMod.deadlockChoose(brain, facts, menu, null, dlExtra(bot, ctx), 'rest')
    assert.equal(r2, null)
    assert.equal(brain.calls, 1)
  })

  it('out-of-menu and low-confidence answers fall back to FSM', async () => {
    for (const [name, answer] of [
      ['out-of-menu', { step: 'castle', confidence: 0.9, source: 'jev' }],
      ['low-confidence', { step: 'gather', confidence: 0.2, source: 'jev' }],
    ]) {
      const bot = dlBot()
      const ctx = dlCtx({ deadlock: seedRest() })
      const brain = planBrain(answer)
      const facts = owedFacts()
      const menu = ['gather', 'rest']
      await taskMod.deadlockChoose(brain, facts, menu, null, dlExtra(bot, ctx), 'rest')
      await flush()
      const r = await taskMod.deadlockChoose(brain, facts, menu, null, dlExtra(bot, ctx), 'rest')
      assert.deepEqual(r, { step: 'rest', source: 'fsm-fallback', fsm: 'rest', model: 'jev' }, name)
      assert.equal(brain.calls, 1, name)
    }
  })
})

describe('deadlock guards (u19u phase C)', () => {
  it('zero calls while progressing, and none under a task goal', async () => {
    const bot = dlBot()
    // A running work step re-deciding: progressing, never a stall.
    const ctx = dlCtx({ step: 'gather', stepStatus: 'running' })
    const brain = planBrain()
    for (let i = 0; i < 3; i++) {
      const r = await taskMod.deadlockChoose(brain, clearFacts(), ['gather', 'rest'], null, dlExtra(bot, ctx), 'gather')
      assert.equal(r, null)
    }
    assert.equal(brain.calls, 0)
    // A task goal owns escalation: the executive must not double-fire.
    const home = { site: pos(10, 64, 10), built: false }
    const tctx = { step: 'build', stepStatus: 'running', home, task: { house: { stallMs: 99999 } }, goal: { id: 'house-1', kind: 'house', generation: 1 }, deadlock: seedRest() }
    const brain2 = planBrain()
    const r = await taskMod.deadlockChoose(brain2, owedFacts(), ['build', 'rest'], home, { bot, ctx: tctx }, 'build')
    assert.equal(r, null)
    assert.equal(brain2.calls, 0)
    assert.equal(tctx.deadlock.restSince, null)
  })

  it('taskTick wires the chooser', () => {
    const bot = dlBot()
    const ctx = { work: true }
    taskMod.taskTick(bot, ctx, Date.now())
    assert.equal(typeof ctx.deadlockChoose, 'function')
  })
})

describe('deadlock episode bound (u19u phase C, R3 core-2)', () => {
  // Rebuild a fresh 3-cycle loop (alternating picks within the window)
  // and drive it through fire + consume.
  async function loopRound(brain, bot, ctx, facts, menu) {
    const dl = ctx.deadlock
    dl.cooldownUntil = 0
    dl.stratBackoffUntil = 0
    dl.firedAt = 0
    const steps = ['gather', 'forage']
    for (let i = 0; i < 7; i++) {
      ctx.step = steps[i % 2]
      ctx.stepStatus = 'failed:stuck'
      await taskMod.deadlockChoose(brain, facts, menu, null, dlExtra(bot, ctx), steps[i % 2])
    }
    await flush()
    return taskMod.deadlockChoose(brain, facts, menu, null, dlExtra(bot, ctx), ctx.step)
  }

  it('fire and consume each clear the evidence: the next round needs fresh picks', async () => {
    const bot = dlBot()
    const now = Date.now()
    const ctx = dlCtx({
      step: 'forage',
      stepStatus: 'failed:stuck',
      deadlock: seedRest({
        restSince: null,
        lastStep: 'gather',
        chain: [
          { step: 'gather', at: now }, { step: 'forage', at: now },
          { step: 'gather', at: now }, { step: 'forage', at: now },
          { step: 'gather', at: now },
        ],
      }),
    })
    const brain = planBrain()
    const facts = clearFacts()
    const menu = ['gather', 'forage', 'rest']
    const r = await taskMod.deadlockChoose(brain, facts, menu, null, dlExtra(bot, ctx), 'gather')
    assert.equal(brain.calls, 1)
    assert.deepEqual(ctx.deadlock.chain, [], 'fire spends the loop evidence')
    assert.equal(ctx.deadlock.restSince, null)
    await flush()
    assert.ok(r, 'fire tick answers FSM')
    const r2 = await taskMod.deadlockChoose(brain, facts, menu, null, dlExtra(bot, ctx), 'gather')
    assert.ok(r2 && r2.step, 'consume resolves the round')
    assert.equal(ctx.deadlock.rounds, 1)
    assert.deepEqual(ctx.deadlock.chain, [], 'consume spends the post-fire evidence')
  })

  it('a persistent loop spends one call per round and stops at the round cap', async () => {
    const bot = dlBot()
    const now = Date.now()
    const ctx = dlCtx({ step: 'gather', stepStatus: 'failed:stuck', deadlock: seedRest() })
    const brain = planBrain()
    const facts = clearFacts()
    const menu = ['gather', 'forage', 'rest']
    const maxRounds = 6 // GOAL_WATCHDOG_MAX_ROUNDS_DEFAULT
    for (let round = 1; round <= maxRounds; round++) {
      const before = brain.calls
      await loopRound(brain, bot, ctx, facts, menu)
      assert.equal(brain.calls, before + 1, `round ${round} spends exactly one call`)
      assert.equal(ctx.deadlock.rounds, round)
    }
    // Past the budget, fresh stalls with expired guards still spend nothing.
    for (let extra = 0; extra < 3; extra++) {
      const before = brain.calls
      ctx.deadlock.cooldownUntil = 0
      ctx.deadlock.stratBackoffUntil = 0
      ctx.deadlock.firedAt = 0
      ctx.deadlock.chain = [
        { step: 'gather', at: now }, { step: 'forage', at: now },
        { step: 'gather', at: now }, { step: 'forage', at: now },
        { step: 'gather', at: now }, { step: 'forage', at: now },
      ]
      ctx.deadlock.lastStep = 'forage'
      ctx.step = 'gather'
      ctx.stepStatus = 'failed:stuck'
      const r = await taskMod.deadlockChoose(brain, facts, menu, null, dlExtra(bot, ctx), 'gather')
      assert.equal(r, null)
      assert.equal(brain.calls, before, `capped stall ${extra} spends no call`)
      assert.ok(ctx.deadlock.cooldownUntil - Date.now() > 120000, 'cap holds a long backoff')
      assert.equal(ctx.deadlock.rounds, maxRounds, 'cap never resets the round count')
    }
  })
})

describe('deadlock tick clock (u19u phase C, core-1)', () => {
  // Homeless, empty pack: only gather is feasible — hold it out of the
  // menu (a fail hold), so the FSM rests while gather stays runnable for
  // the escalation to offer. The missing pickaxe is the owed need.
  function heldRestWorld() {
    const bot = dlBot()
    const ctx = dlCtx({})
    const facts0 = goal.goalFacts(bot, ctx)
    const text0 = goal.goalText(facts0, ctx.home)
    assert.deepEqual(
      Object.keys(goal.MENU).filter((n) => {
        try { return goal.MENU[n].feasible(facts0, bot, ctx) && goal.registered(n) } catch (_) { return false }
      }).sort(),
      ['gather', 'rest'],
      'probe: only gather is feasible pre-hold',
    )
    ctx.stepFail = { gather: { text: text0 } }
    return { bot, ctx }
  }

  it('steady-rest ticks fire without a re-decide; the answer pins and decide applies it', async () => {
    const { bot, ctx } = heldRestWorld()
    const brain = planBrain({ step: 'gather', confidence: 0.8, source: 'jev' })
    ctx.brain = brain
    // The pick tick and steady ticks: the clock seeds the stretch, no call.
    taskMod.taskTick(bot, ctx, Date.now())
    assert.equal(brain.calls, 0)
    assert.ok(ctx.deadlock.restSince != null, 'steady rest seeds the stretch')
    taskMod.taskTick(bot, ctx, Date.now())
    assert.equal(brain.calls, 0)
    // Past the window the clock fires: exactly one call, zero decide()s.
    ctx.deadlock.restSince = Date.now() - 61000
    taskMod.taskTick(bot, ctx, Date.now())
    await flush()
    assert.equal(brain.calls, 1)
    assert.deepEqual(ctx.deadlock.chain, [], 'fire spends the loop evidence')
    assert.equal(ctx.deadlock.restSince, null, 'fire spends the rest stretch')
    await flush()
    // The landed answer pins as a one-shot force — still no decide() yet.
    taskMod.taskTick(bot, ctx, Date.now())
    assert.equal(ctx.taskPlanStep, 'gather')
    assert.equal(brain.calls, 1, 'consume spends no second call')
    // ... and the next decide() applies the pin and consumes it.
    const d = await goal.decide(bot, ctx)
    assert.equal(d.action, 'gather')
    assert.equal(ctx.step, 'gather')
    assert.equal(ctx.taskPlanStep, null, 'pin consumed')
    assert.equal(brain.calls, 1)
  })

  it('a dusk flip defers the pin: night owns the body, the pin applies at dawn', async () => {
    const { bot, ctx } = heldRestWorld()
    const brain = planBrain({ step: 'gather', confidence: 0.8, source: 'jev' })
    ctx.brain = brain
    taskMod.taskTick(bot, ctx, Date.now())
    ctx.deadlock.restSince = Date.now() - 61000
    taskMod.taskTick(bot, ctx, Date.now())
    await flush()
    assert.equal(brain.calls, 1)
    taskMod.taskTick(bot, ctx, Date.now())
    assert.equal(ctx.taskPlanStep, 'gather', 'day consume pins the answer')
    // Dusk: the night rule owns the body — the pin waits, unconsumed.
    bot.time.timeOfDay = 12500
    const dusk = await goal.decide(bot, ctx)
    assert.equal(dusk.action, 'shelter')
    assert.equal(ctx.taskPlanStep, 'gather', 'pin deferred past the night march')
    // Dawn: the pin forces the re-decide and applies.
    bot.time.timeOfDay = 6000
    const dawn = await goal.decide(bot, ctx)
    assert.equal(dawn.action, 'gather')
    assert.equal(ctx.taskPlanStep, null, 'pin consumed')
    assert.equal(brain.calls, 1)
  })

  it('no trigger while progressing: running ticks spend no call', async () => {
    const bot = dlBot()
    const brain = planBrain({ step: 'gather', confidence: 0.8, source: 'jev' })
    // A running work step re-deciding: progressing, never a stall.
    const ctx = dlCtx({ step: 'gather', stepStatus: 'running' })
    ctx.brain = brain
    for (let i = 0; i < 3; i++) {
      taskMod.taskTick(bot, ctx, Date.now())
      assert.equal(brain.calls, 0, `steady tick ${i} spends no call`)
    }
    // A fresh rest stretch seeds the clock but spends no call either.
    ctx.step = 'rest'
    taskMod.taskTick(bot, ctx, Date.now())
    assert.equal(brain.calls, 0)
    assert.ok(ctx.deadlock.restSince != null)
  })

  it('no trigger while progressing: a running work step never forces', async () => {
    const bot = dlBot()
    const ctx = dlCtx({ step: 'gather', stepStatus: 'running' })
    const brain = planBrain({ step: 'gather', confidence: 0.8, source: 'jev' })
    ctx.brain = brain
    taskMod.taskTick(bot, ctx, Date.now())
    for (let i = 0; i < 3; i++) {
      const d = await goal.decide(bot, ctx)
      assert.equal(d.action, 'gather')
      assert.equal(brain.calls, 0, `steady tick ${i} spends no call`)
    }
  })
})
