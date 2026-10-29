'use strict'

// Strategic goal choice, phase 2 (idkcraft-u19u): one planState-shaped call
// over the watchdog option table at the existing decision points (never
// per tick), gated by state-change + episode memo + cost guards, validated
// against the feasible menu with total FSM fallback. No live model: the
// plan() stub answers synchronously-observable via promise flushes.

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const goal = require('../src/goal')
const taskMod = require('../src/task')
const metrics = require('../src/metrics')

function pos(x, y, z) {
  return { x, y, z, distanceTo: (q) => Math.hypot(x - q.x, y - q.y, z - q.z) }
}

function stratBot({ items = [], timeOfDay = 6000, at = pos(0, 64, 0) } = {}) {
  return {
    entity: { position: at },
    inventory: { items: () => items },
    time: { timeOfDay },
    spawnPoint: pos(0, 64, 0),
    blockAt: () => ({ name: 'air' }),
    chat: () => {},
  }
}

function stratCtx(kind, state) {
  return {
    home: { site: pos(0, 64, 0), built: false },
    task: { [kind]: state },
    goal: { id: `${kind}-1`, kind, generation: 1, text: `build ${kind === 'castle' ? 'castle' : 'home'}`, startedAt: Date.now() },
  }
}

function stratState() {
  return { done: 3, total: 10, stallMs: 120000, fails: [], wd: { history: [] } }
}

// Day work facts where gather is feasible (empty pack, unbuilt site) and
// the FSM over [gather, craft, rest] answers craft (STEP_ORDER priority).
const dayFacts = {
  time: 'day', castle: 'none', player: 'none', home: 'site', known: 'none',
  haul: 'none', surplus: 'no', pinned: 'none', beds: 'both', gear: 'done',
  sword: 1, pickaxe: 1, pickWord: 'stone', cobble: 0, logs: 0, planks: 0,
  unlit: 0, torches: 0, rearm: false, health: 20, food: 20, inside: 'no',
  maxPlanks: 0, table: 0, door: 0, scaffold: 16,
  chest: 'no', chestTodo: 'none', gearHandover: 'none',
  coal: 0, charcoal: 0, sticks: 0, tablePlaced: false, houseTable: false,
  tableOwed: false,
}

function planBrain(answer, source = 'jev') {
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

const flush = () => new Promise((r) => setTimeout(r, 10))

async function metricText() {
  return metrics.client.register.metrics()
}

async function escalationCount(from, to, reason) {
  const text = await metricText()
  const m = text.match(new RegExp(`idkcraft_bot_escalation_total\\{from="${from}",to="${to}",reason="${reason}"\\} ([0-9.]+)`))
  return m ? Number(m[1]) : 0
}

describe('goalPromptState (u19u phase 2 prompt shape)', () => {
  it('is planState plus progressPct/packDelta/abilities/owed', () => {
    const bot = stratBot({ items: [{ name: 'oak_log', count: 5 }] })
    const state = stratState()
    const ctx = stratCtx('house', state)
    const p = taskMod.goalPromptState(bot, ctx, 'house', 3, 10, state)
    // planState base fields ride along.
    assert.equal(p.goal, 'build home')
    assert.equal(p.progress, '3/10')
    assert.equal(typeof p.facts, 'string')
    assert.equal(typeof p.situation, 'string')
    assert.ok(Array.isArray(p.history))
    // §1.2 deltas.
    assert.equal(p.progressPct, 30)
    assert.deepEqual(p.packDelta, { logs: 5, planks: 0, food: 20 })
    assert.deepEqual(p.abilities, { pickaxe: 'no', table: 'no', food: 'ok', sword: 'no' })
    assert.deepEqual(p.owed, { table: true, beds: 'both', door: 'no' })
  })

  it('progressPct is null when the total is 0 or unknown (travel goals)', () => {
    const bot = stratBot()
    const state = stratState()
    const ctx = stratCtx('house', state)
    assert.equal(taskMod.goalPromptState(bot, ctx, 'house', 0, 0, state).progressPct, null)
    const nostate = { stallMs: 0, fails: [], wd: {} }
    assert.equal(taskMod.goalPromptState(bot, stratCtx('house', nostate), 'house', undefined, undefined, nostate).progressPct, null)
  })

  it('packDelta is signed vs the previous fire baseline on the memo', () => {
    const bot = stratBot({ items: [{ name: 'oak_log', count: 9 }] })
    const state = stratState()
    state.wd.stratPack = { logs: 5, planks: 0, food: 20 }
    const ctx = stratCtx('house', state)
    const p = taskMod.goalPromptState(bot, ctx, 'house', 3, 10, state)
    assert.deepEqual(p.packDelta, { logs: 4, planks: 0, food: 0 })
  })

  it('names abilities and owed needs from goalFacts (no rescan)', () => {
    const bot = stratBot({
      items: [
        { name: 'stone_pickaxe', count: 1 },
        { name: 'stone_sword', count: 1 },
        { name: 'oak_door', count: 1 },
      ],
    })
    const state = stratState()
    const ctx = stratCtx('house', state)
    const p = taskMod.goalPromptState(bot, ctx, 'house', 3, 10, state)
    assert.equal(p.abilities.pickaxe, 'stone')
    assert.equal(p.abilities.sword, 'yes')
    assert.equal(p.owed.door, 'yes')
  })
})

describe('strategic chooseStep (u19u phase 2 decision points)', () => {
  it('fires one plan() with option-table criteria and answers FSM this tick', async () => {
    const bot = stratBot()
    const state = stratState()
    const ctx = stratCtx('house', state)
    const brain = planBrain({ step: 'gather', confidence: 0.9, probabilities: { gather: 0.9 }, source: 'jev' })
    const r = await goal.chooseStep(brain, dayFacts, ['gather', 'craft', 'rest'], ctx.home,
      { bot, ctx, choose: taskMod.strategicChoose })
    // Fire-and-forget: this tick answers the FSM (craft outranks gather).
    assert.equal(r.step, 'craft')
    assert.equal(r.source, 'goal-fsm')
    assert.equal(brain.calls, 1)
    // Option-table criteria, not STEP_CRITERIA: the park criterion rides.
    const req = brain.reqs[0]
    assert.ok(req.criteria.park, 'park is offered')
    assert.ok(req.criteria.gather, 'plain steps are offered')
    assert.ok(req.instructions.includes('Prefer the option that moves the progress metric'),
      'the progress-metric sentence rides the instructions')
    assert.equal(req.state.progressPct, 30)
    assert.ok(req.state.packDelta, 'pack delta rides the state')
  })

  it('memo hit applies the stored answer with no second call', async () => {
    const bot = stratBot()
    const state = stratState()
    const ctx = stratCtx('house', state)
    const brain = planBrain({ step: 'gather', confidence: 0.9, source: 'jev' })
    const extra = { bot, ctx, choose: taskMod.strategicChoose }
    await goal.chooseStep(brain, dayFacts, ['gather', 'craft', 'rest'], ctx.home, extra)
    await flush()
    assert.equal(brain.calls, 1)
    const r = await goal.chooseStep(brain, dayFacts, ['gather', 'craft', 'rest'], ctx.home, extra)
    assert.equal(brain.calls, 1, 'memo hit: no second call')
    assert.equal(r.step, 'gather', 'stored answer applies')
    assert.equal(r.source, 'jev')
    assert.equal(r.fsm, 'craft')
  })

  it('a state change (facts text) re-fires; unchanged never re-fires', async () => {
    const bot = stratBot()
    const state = stratState()
    const ctx = stratCtx('house', state)
    const brain = planBrain({ step: 'gather', confidence: 0.9, source: 'jev' })
    const extra = { bot, ctx, choose: taskMod.strategicChoose }
    await goal.chooseStep(brain, dayFacts, ['gather', 'craft', 'rest'], ctx.home, extra)
    // In flight: the same key never fires twice.
    await goal.chooseStep(brain, dayFacts, ['gather', 'craft', 'rest'], ctx.home, extra)
    assert.equal(brain.calls, 1, 'in-flight: no duplicate call')
    await flush()
    await goal.chooseStep(brain, dayFacts, ['gather', 'craft', 'rest'], ctx.home, extra)
    assert.equal(brain.calls, 1, 'memo hit: no call when unchanged')
    // logs 0 -> 20 flips the logs bucket word, so the key moves.
    const moved = { ...dayFacts, logs: 20 }
    const r = await goal.chooseStep(brain, moved, ['gather', 'craft', 'rest'], ctx.home, extra)
    assert.equal(brain.calls, 2, 'state change re-fires')
    assert.equal(r.source, 'goal-fsm', 'the fire tick still answers FSM')
  })

  it('out-of-menu answer falls back to the FSM with an escalation count', async () => {
    const bot = stratBot()
    const state = stratState()
    const ctx = stratCtx('house', state)
    const before = await escalationCount('jev', 'fsm', 'invalid')
    const brain = planBrain({ step: 'rest', confidence: 0.9, source: 'jev' })
    const extra = { bot, ctx, choose: taskMod.strategicChoose }
    await goal.chooseStep(brain, dayFacts, ['gather', 'craft', 'rest'], ctx.home, extra)
    await flush()
    const r = await goal.chooseStep(brain, dayFacts, ['gather', 'craft', 'rest'], ctx.home, extra)
    assert.equal(r.step, 'craft', 'rest is never forced')
    assert.equal(r.source, 'fsm-fallback')
    assert.equal(await escalationCount('jev', 'fsm', 'invalid'), before + 1)
  })

  it('budget respect: a failed fire backs off, changed state stays silent', async () => {
    const bot = stratBot()
    const state = stratState()
    const ctx = stratCtx('house', state)
    const brain = planBrain(new Error('llm budget exhausted'))
    const extra = { bot, ctx, choose: taskMod.strategicChoose }
    const r1 = await goal.chooseStep(brain, dayFacts, ['gather', 'craft', 'rest'], ctx.home, extra)
    assert.equal(r1.source, 'goal-fsm', 'failure never throws, FSM answers')
    await flush()
    assert.equal(brain.calls, 1)
    assert.ok((state.wd.stratBackoffUntil || 0) > Date.now(), 'transport failure arms the backoff')
    const moved = { ...dayFacts, logs: 20 }
    await goal.chooseStep(brain, moved, ['gather', 'craft', 'rest'], ctx.home, extra)
    assert.equal(brain.calls, 1, 'backoff window suppresses the re-fire')
  })

  it('low-confidence answers never coin-flip: fallback or FSM', async () => {
    const bot = stratBot({ items: [{ name: 'oak_log', count: 5 }] })
    const state = stratState()
    const ctx = stratCtx('house', state)
    const brain = planBrain({ step: 'craft', confidence: 0.1, source: 'jev' })
    const extra = { bot, ctx, choose: taskMod.strategicChoose }
    await goal.chooseStep(brain, dayFacts, ['gather', 'craft', 'rest'], ctx.home, extra)
    await flush()
    const r = await goal.chooseStep(brain, dayFacts, ['gather', 'craft', 'rest'], ctx.home, extra)
    assert.ok(r.source === 'fallback' || r.source === 'fsm-fallback', `got source=${r.source}`)
    assert.notEqual(r.step, 'rest')
  })

  it('night and castle rules never call plan()', async () => {
    const bot = stratBot()
    const state = stratState()
    const ctx = stratCtx('house', state)
    const brain = planBrain({ step: 'gather', confidence: 0.9, source: 'jev' })
    const extra = { bot, ctx, choose: taskMod.strategicChoose }
    const night = { ...dayFacts, time: 'night', home: 'built', inside: 'yes' }
    const r = await goal.chooseStep(brain, night, ['stay', 'rest'], ctx.home, extra)
    assert.equal(r.source, 'night-rule')
    const castleFacts = { ...dayFacts, castle: 'stone-batch' }
    const r2 = await goal.chooseStep(brain, castleFacts, ['castle', 'gather', 'rest'], ctx.home, extra)
    assert.equal(r2.source, 'castle-rule')
    assert.equal(brain.calls, 0)
  })

  it('phase-1 plug intact: ask brains ask, plan-less brains stay FSM', async () => {
    const bot = stratBot()
    const state = stratState()
    const ctx = stratCtx('house', state)
    const extra = { bot, ctx, choose: taskMod.strategicChoose }
    // brain.plan absent: the ask plug runs even with strategic context.
    const askBrain = { source: 'jev', ask: async () => 'gather' }
    const r = await goal.chooseStep(askBrain, dayFacts, ['gather', 'craft', 'rest'], ctx.home, extra)
    assert.equal(r.step, 'gather')
    assert.equal(r.source, 'jev')
    // plan present but no strategic context: legacy no-ask path.
    const planOnly = planBrain({ step: 'gather', confidence: 0.9, source: 'jev' })
    delete planOnly.ask
    const r2 = await goal.chooseStep(planOnly, dayFacts, ['gather', 'craft', 'rest'], ctx.home)
    assert.equal(r2.source, 'goal-fsm')
    assert.equal(planOnly.calls, 0)
  })
})

describe('strategic decide integration (decision points only)', () => {
  it('fires once at the re-decide and stays silent on steady ticks', async () => {
    const bot = stratBot({ items: [{ name: 'oak_log', count: 5 }] })
    const state = stratState()
    const ctx = stratCtx('house', state)
    const brain = planBrain({ step: 'gather', confidence: 0.9, source: 'jev' })
    ctx.brain = brain
    ctx.strategicChoose = taskMod.strategicChoose
    const d1 = await goal.decide(bot, ctx)
    assert.equal(brain.calls, 1, 'the re-decide fires once')
    assert.ok(d1.action, 'decide still answers a step')
    const step = ctx.step
    const d2 = await goal.decide(bot, ctx)
    assert.equal(brain.calls, 1, 'steady running ticks never fire')
    assert.equal(d2.action, step)
  })
})
