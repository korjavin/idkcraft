'use strict'

// Unit tests for the goal arbiter (epic rw4.1): facts, FSM priority and the
// decision point. Behaviour execution is covered in tick.test.js.
const { describe, it, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const { MENU, STEP_ORDER, NEED_LOGS, NEED_PLANKS, goalFacts, goalText, goalFsm, decide, chooseStep, STEP_CRITERIA, ASK_INSTRUCTIONS } = require('../src/goal')

function pos(x, y, z) {
  const p = {
    x, y, z,
    distanceTo: (q) => Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z),
    clone() { return pos(p.x, p.y, p.z) },
    floored() { return pos(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)) }
  }
  return p
}

function goalBot({ items = [], timeOfDay = 6000, at = pos(0, 64, 0), spawn = pos(0, 64, 0) } = {}) {
  const chats = []
  return {
    chats,
    entity: { position: at },
    inventory: { items: () => items },
    time: timeOfDay === null ? undefined : { timeOfDay },
    spawnPoint: spawn,
    chat: (m) => { chats.push(m) },
  }
}

describe('goal constants and menu shape', () => {
  it('house budget constants', () => {
    assert.equal(NEED_LOGS, 14)
    assert.equal(NEED_PLANKS, 48)
  })

  it('menu has all six steps with feasible and chat functions', () => {
    assert.deepEqual(Object.keys(MENU).sort(), ['build', 'craft', 'gather', 'gohome', 'rest', 'stay'])
    for (const name of Object.keys(MENU)) {
      assert.equal(typeof MENU[name].feasible, 'function', `${name}.feasible`)
      assert.equal(typeof MENU[name].chat, 'function', `${name}.chat`)
    }
    assert.deepEqual(STEP_ORDER, ['stay', 'gohome', 'craft', 'build', 'gather', 'rest'])
  })
})

describe('goalFacts', () => {
  it('reads time of day on day/dusk/night boundaries', () => {
    for (const [tod, want] of [[0, 'day'], [11999, 'day'], [12000, 'dusk'], [12500, 'dusk'], [13000, 'dusk'], [13001, 'night'], [18000, 'night']]) {
      assert.equal(goalFacts(goalBot({ timeOfDay: tod }), {}).time, want, `tod=${tod}`)
    }
    assert.equal(goalFacts(goalBot({ timeOfDay: null }), {}).time, 'day') // unknown reads as day
  })

  it('counts inventory by suffix, ignores the rest', () => {
    const bot = goalBot({
      items: [
        { name: 'oak_log', count: 3 }, { name: 'birch_log', count: 2 },
        { name: 'oak_planks', count: 10 }, { name: 'crafting_table', count: 1 },
        { name: 'stone', count: 64 }, { name: 'iron_sword', count: 1 },
      ],
    })
    const facts = goalFacts(bot, {})
    assert.equal(facts.logs, 5)
    assert.equal(facts.planks, 10)
    assert.equal(facts.table, 1)
    assert.equal(facts.door, 0)
  })

  it('missing inventory counts zero without throwing', () => {
    const facts = goalFacts({ entity: { position: pos(0, 64, 0) } }, {})
    assert.equal(facts.logs, 0)
    assert.equal(facts.planks, 0)
    assert.equal(facts.table, 0)
    assert.equal(facts.door, 0)
  })

  it('home none/site/built from ctx.home', () => {
    assert.equal(goalFacts(goalBot(), {}).home, 'none')
    assert.equal(goalFacts(goalBot(), { home: { site: pos(10, 64, 10) } }).home, 'site')
    assert.equal(goalFacts(goalBot(), { home: { site: pos(10, 64, 10), built: true } }).home, 'built')
  })

  it('inside yes/no from ctx.home.interior', () => {
    const interior = { min: { x: 9, y: 63, z: 9 }, max: { x: 12, y: 66, z: 12 } }
    const ctx = { home: { site: pos(10, 64, 10), built: true, interior } }
    assert.equal(goalFacts(goalBot({ at: pos(10, 64, 10) }), ctx).inside, 'yes')
    assert.equal(goalFacts(goalBot({ at: pos(50, 64, 50) }), ctx).inside, 'no')
    assert.equal(goalFacts(goalBot(), {}).inside, 'no') // no home, no interior
  })

  it('goalText is the canonical facts line', () => {
    assert.equal(goalText({ time: 'day', logs: 3, planks: 0, table: 0, door: 0, home: 'none', inside: 'no', health: 20, food: 20 }), 'time=day logs=few planks=none table=no door=no home=none inside=no health=ok food=ok')
    assert.equal(goalText({ time: 'night', logs: 14, planks: 48, table: 2, door: 1, home: 'built', inside: 'yes', health: 4, food: 3 }), 'time=night logs=enough planks=enough table=yes door=yes home=built inside=yes health=low food=hungry')
  })
})

describe('MENU feasibility gates', () => {
  const F = (name, facts) => MENU[name].feasible(facts)
  const base = { time: 'day', logs: 0, planks: 0, maxPlanks: 0, table: 0, door: 0, home: 'none', tablePlaced: false, inside: 'no' }
  it('gather runs while material is missing, not once built', () => {
    assert.equal(F('gather', base), true) // empty hands: gather
    assert.equal(F('gather', { ...base, logs: 5 }), true) // mid-load: keep gathering
    assert.equal(F('gather', { ...base, home: 'built' }), false) // job done: rest becomes reachable
  })
  it('gather finishes the load instead of deadlocking on rest', () => {
    // Review state: 1 log + 46 planks + kit. Stopping here strands a
    // sub-batch craft can never take (batch gate needs 14) — gather stays
    // feasible until the load is full, then craft/build take over.
    assert.equal(F('gather', { ...base, logs: 1, planks: 46, table: 1, door: 1 }), true)
    assert.equal(F('craft', { ...base, logs: 1, planks: 46, table: 1, door: 1 }), false)
    // Sufficient material but no site: all work gates closed, rest is the
    // correct idle (the owner places the site with 'build here').
    const ready = { ...base, logs: 0, planks: 48, table: 1, door: 1, home: 'none' }
    assert.equal(F('gather', ready), false)
    assert.equal(F('craft', ready), false)
    assert.equal(F('build', ready), false)
    assert.equal(goalFsm(ready, ['rest']), 'rest')
  })
  it('craft starts on a full load, not on the first log', () => {
    assert.equal(F('craft', base), false)
    assert.equal(F('craft', { ...base, logs: 5 }), false) // no per-log preempt churn
    assert.equal(F('craft', { ...base, logs: 14 }), true) // full batch
    assert.equal(F('craft', { ...base, planks: 5, maxPlanks: 5 }), true) // leftovers finish table/door
    assert.equal(F('craft', { ...base, planks: 56, maxPlanks: 56, table: 1, door: 1 }), false) // nothing left to craft
  })
  it('build needs budget, kit and a site — never a finished house', () => {
    assert.equal(F('build', { ...base, planks: 48, table: 1, door: 1, home: 'site' }), true)
    assert.equal(F('build', { ...base, planks: 46, table: 1, door: 1, home: 'site' }), false)
    assert.equal(F('build', { ...base, planks: 48, table: 1, door: 1, home: 'built' }), false)
    assert.equal(F('build', { ...base, planks: 48, table: 1, door: 1, home: 'none' }), false)
  })
})

describe('goalFsm priority', () => {
  const day = { time: 'day' }
  it('night inside a built home stays', () => {
    assert.equal(goalFsm({ time: 'night' }, ['stay', 'gohome', 'craft', 'rest']), 'stay')
  })
  it('dusk with a site goes home before crafting', () => {
    assert.equal(goalFsm({ time: 'dusk' }, ['gohome', 'craft', 'gather', 'rest']), 'gohome')
  })
  it('day: craft > build > gather > rest', () => {
    assert.equal(goalFsm(day, ['craft', 'build', 'gather', 'rest']), 'craft')
    assert.equal(goalFsm(day, ['build', 'gather', 'rest']), 'build')
    assert.equal(goalFsm(day, ['gather', 'rest']), 'gather')
    assert.equal(goalFsm(day, ['rest']), 'rest')
  })
  it('day skips night steps even when passed', () => {
    assert.equal(goalFsm(day, ['stay', 'gohome', 'rest']), 'rest')
  })
  it('empty feasible set falls back to rest', () => {
    assert.equal(goalFsm(day, []), 'rest')
  })
})

describe('decide decision point', () => {
  let origLog
  let lines
  beforeEach(() => {
    origLog = console.log
    lines = []
    console.log = (line) => { lines.push(String(line)) }
  })
  afterEach(() => { console.log = origLog })

  const goalLines = () => lines.filter((l) => l.includes('goal step='))

  it('first decision picks gather, logs and chats once', async () => {
    const bot = goalBot()
    const ctx = {}
    const r = await decide(bot, ctx)
    assert.deepEqual(r, { action: 'gather', sprint: false, source: 'goal-fsm' })
    assert.equal(ctx.step, 'gather')
    assert.equal(ctx.stepStatus, 'running')
    assert.deepEqual(goalLines(), [`goal step=gather prev=none source=goal-fsm fsm=gather why=start facts=${goalText(goalFacts(bot, ctx))}`])
    assert.deepEqual(bot.chats, ['next: chopping wood (goal-fsm)'])
  })

  it('same facts with a running step: no change, no log, no chat', async () => {
    const bot = goalBot()
    const ctx = {}
    await decide(bot, ctx)
    lines.length = 0
    bot.chats.length = 0
    const r = await decide(bot, ctx)
    assert.equal(r.action, 'gather')
    assert.deepEqual(goalLines(), [])
    assert.deepEqual(bot.chats, [])
  })

  it('done step re-decides (logs only on change)', async () => {
    const bot = goalBot()
    const ctx = {}
    await decide(bot, ctx)
    ctx.stepStatus = 'done'
    lines.length = 0
    bot.chats.length = 0
    const r = await decide(bot, ctx)
    assert.equal(r.action, 'gather')
    assert.equal(ctx.stepStatus, 'running')
    assert.deepEqual(goalLines(), []) // same step again: silent restart
    assert.deepEqual(bot.chats, [])
  })

  it('failed step re-decides', async () => {
    const bot = goalBot()
    const ctx = {}
    await decide(bot, ctx)
    ctx.stepStatus = 'failed:no-trees'
    const r = await decide(bot, ctx)
    assert.equal(r.action, 'gather')
    assert.equal(ctx.stepStatus, 'running')
  })

  it('changed facts re-decide', async () => {
    const bot = goalBot()
    const ctx = {}
    await decide(bot, ctx)
    bot._items = undefined
    bot.inventory = { items: () => [{ name: 'oak_log', count: 3 }] } // logs 0 -> 3
    lines.length = 0
    const r = await decide(bot, ctx)
    assert.equal(r.action, 'gather') // craft feasible but unregistered: gather runs now that rw4.2 registered it
    assert.ok(ctx.goalText.includes('logs=few'))
  })

  it('craft needs a placed table for the door: unplaced table rests', async () => {
    // A door recipe requires the table block; a table sitting in the
    // inventory does not unlock it, so the step must not even be picked
    // (otherwise it would report done forever while still feasible).
    const bot = goalBot({ items: [{ name: 'oak_planks', count: 58 }, { name: 'crafting_table', count: 1 }] })
    const r = await decide(bot, {})
    assert.equal(r.action, 'rest')
  })

  it('placed table unlocks craft for the door', async () => {
    const bot = goalBot({ items: [{ name: 'oak_planks', count: 6 }] })
    const r = await decide(bot, { home: { table: pos(2, 64, 0) } })
    assert.equal(r.action, 'craft')
  })

  it('placed table with door done gathers on (table clause needs no table)', async () => {
    // 10 planks are short of the 48 budget, so gather (not rest) is correct
    // here — but never craft: with the door done only the table clause could
    // fire, and the placed table guards it. Deleting the guard picks craft.
    const bot = goalBot({ items: [{ name: 'oak_planks', count: 10 }, { name: 'oak_door', count: 1 }] })
    const r = await decide(bot, { home: { table: pos(2, 64, 0) } })
    assert.equal(r.action, 'gather')
  })

  it('mixed planks from outside gather on (recipes cannot mix woods)', async () => {
    // 2+2 needs more material, so gather (not rest) is correct — but never
    // craft: total-planks clauses would fire on the mixed 4. Deleting the
    // per-wood counts picks craft into a done-forever loop.
    const bot = goalBot({ items: [{ name: 'oak_planks', count: 2 }, { name: 'birch_planks', count: 2 }] })
    const r = await decide(bot, {})
    assert.equal(r.action, 'gather')
  })

  it('feasible-but-unregistered build never runs', async () => {
    // The registration gate in decide(): a full kit on a build site makes
    // build feasible, but with no behaviour behind it the step must not be
    // picked (deleting the check would route to stopOnce() every tick).
    const bot = goalBot({ items: [
      { name: 'oak_planks', count: 48 },
      { name: 'crafting_table', count: 1 },
      { name: 'oak_door', count: 1 },
    ] })
    const r = await decide(bot, { home: { table: pos(2, 64, 0) } })
    assert.equal(r.action, 'rest')
  })

  it('chooseStep single feasible step: only-option, brain not asked', async () => {
    // (a) only-option: full kit, no site — rest is the only registered step.
    // The brain explodes if consulted: source must be only-option, not goal-fsm.
    const bot = goalBot({ items: [
      { name: 'oak_planks', count: 48 },
      { name: 'crafting_table', count: 1 },
      { name: 'oak_door', count: 1 },
    ] })
    const facts = goalFacts(bot, {})
    const boom = { source: 'laya', ask: async () => { throw new Error('asked with one option') } }
    const r = await chooseStep(boom, facts, ['rest'])
    assert.deepEqual(r, { step: 'rest', source: 'only-option', fsm: 'rest', model: null })
  })

  it('chooseStep model answer flows through; disagreement logged on fsm split', async () => {
    // (b) craft answered by laya on a craft menu (fsm agrees here: craft tops
    // the order, so agreement is the honest expectation)...
    const facts = { time: 'day', logs: 0, planks: 5, maxPlanks: 5, table: 0, door: 0, home: 'none', tablePlaced: false, inside: 'no', health: 20, food: 20 }
    const laya = { source: 'laya', ask: async () => 'craft' }
    const r = await chooseStep(laya, facts, ['craft', 'gather', 'rest'])
    assert.equal(r.step, 'craft')
    assert.equal(r.source, 'laya')
    assert.equal(r.fsm, 'craft')
    // ...while a rest answer against a gather fsm is the disagreement case:
    // STEP_ORDER ranks craft above gather, so no menu can pair a craft answer
    // with a gather fsm — the machinery is proven on rest-vs-gather instead.
    const errLines = []
    const origErr = console.error
    console.error = (l) => { errLines.push(String(l)) }
    try {
      const r2 = await chooseStep(laya, { ...facts, logs: 0, planks: 0, maxPlanks: 0 }, ['gather', 'rest'])
      const layaRest = { source: 'laya', ask: async () => 'rest' }
      const r3 = await chooseStep(layaRest, { ...facts, logs: 0, planks: 0, maxPlanks: 0 }, ['gather', 'rest'])
      assert.equal(r2.step, 'gather') // control: fsm path agrees silently
      assert.equal(r3.step, 'rest')
      assert.equal(r3.source, 'laya')
      assert.ok(errLines.some((l) => l.includes('goal disagree') && l.includes('model=rest') && l.includes('fsm=gather')),
        `disagreement logged, got: ${errLines.join(' | ')}`)
    } finally {
      console.error = origErr
    }
  })

  it('chooseStep timeout falls back to fsm with escalation counted', async () => {
    // (c) timeout: the FSM step runs, source is fsm-fallback.
    const facts = { time: 'day', logs: 0, planks: 0, maxPlanks: 0, table: 0, door: 0, home: 'none', tablePlaced: false, inside: 'no', health: 20, food: 20 }
    const slow = { source: 'laya', ask: async () => { const e = new Error('slow'); e.name = 'TimeoutError'; throw e } }
    const r = await chooseStep(slow, facts, ['gather', 'rest'])
    assert.deepEqual(r, { step: 'gather', source: 'fsm-fallback', fsm: 'gather', model: 'laya' })
    const metrics = require('../src/metrics')
    const text = await metrics.client.register.metrics()
    assert.match(text, /idkcraft_bot_escalation_total\{from="laya",to="fsm",reason="timeout"\} [1-9]/)
  })

  it('decide asks once per decision point, not per tick', async () => {
    // (e) same goalText + running step: ask is not called again. Deleting the
    // change gate (ask every tick) fails this test.
    const bot = goalBot()
    const brain = { source: 'laya', calls: 0, ask: async function () { this.calls++; return 'gather' } }
    const ctx = { brain }
    await decide(bot, ctx)
    assert.equal(brain.calls, 1)
    await decide(bot, ctx)
    await decide(bot, ctx)
    assert.equal(brain.calls, 1, 'no re-ask without a decision point')
  })

  it('goal metrics count the model choice', async () => {
    // (f) goal_steps_total, goal_step gauge, goal_choice_duration.
    const bot = goalBot()
    const brain = { source: 'laya', ask: async () => 'gather' }
    await decide(bot, { brain })
    const metrics = require('../src/metrics')
    const text = await metrics.client.register.metrics()
    assert.match(text, /idkcraft_bot_goal_steps_total\{step="gather",source="laya"\} [1-9]/)
    assert.match(text, /idkcraft_bot_goal_step\{step="gather"\} 1/)
    assert.match(text, /idkcraft_bot_goal_choice_duration_seconds_count\{source="laya"\} [1-9]/)
  })

  it('full load hands gather to craft', async () => {
    // craft joined in rw4.3; build joins in rw4.4. Over a full load
    // (15 logs = 60 plank-equivalent over the 58 budget) gather is done
    // and craft — now registered — runs instead of rest.
    const bot = goalBot({ items: [{ name: 'oak_log', count: 15 }] })
    const r = await decide(bot, {})
    assert.equal(r.action, 'craft')
  })
})

describe('decide failed-step dedup (revmux 01 major)', () => {
  it('a step that fails again with unchanged facts asks once', async () => {
    // gather re-asserts failed:no-trees while the trees stay missing: the
    // first failure is a decision point, the repeats reuse the choice.
    // Deleting the (text, status) gate (ask every tick) fails this test.
    const bot = goalBot()
    const brain = { source: 'laya', calls: 0, ask: async function () { this.calls++; return 'gather' } }
    const ctx = { brain }
    await decide(bot, ctx)
    assert.equal(brain.calls, 1)
    ctx.stepStatus = 'failed:no-trees' // behaviour re-runs, fails identically
    await decide(bot, ctx)
    assert.equal(brain.calls, 2, 'first repeat failure still asks')
    ctx.stepStatus = 'failed:no-trees' // behaviour fails identically again
    await decide(bot, ctx)
    ctx.stepStatus = 'failed:no-trees'
    await decide(bot, ctx)
    assert.equal(brain.calls, 2, 'further identical failures reuse the choice')
    assert.equal(ctx.step, 'gather')
  })
})
