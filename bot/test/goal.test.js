'use strict'

// Unit tests for the goal arbiter (epic rw4.1): facts, FSM priority and the
// decision point. Behaviour execution is covered in tick.test.js.
const { describe, it, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const { MENU, STEP_ORDER, NEED_LOGS, NEED_PLANKS, goalFacts, goalText, goalFsm, decide } = require('../src/goal')

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
    const facts = { time: 'day', logs: 3, planks: 0, table: 0, door: 0, home: 'none', inside: 'no' }
    assert.equal(goalText(facts), 'time=day logs=3 planks=0 table=0 door=0 home=none inside=no')
  })
})

describe('MENU feasibility gates', () => {
  const F = (name, facts) => MENU[name].feasible(facts)
  const base = { time: 'day', logs: 0, planks: 0, table: 0, door: 0, home: 'none', inside: 'no' }
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
    assert.equal(F('craft', { ...base, planks: 5 }), true) // leftovers finish table/door
    assert.equal(F('craft', { ...base, planks: 56, table: 1, door: 1 }), false) // nothing left to craft
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

  it('first decision picks rest, logs and chats once', () => {
    const bot = goalBot()
    const ctx = {}
    const r = decide(bot, ctx)
    assert.deepEqual(r, { action: 'rest', sprint: false, source: 'goal-fsm' })
    assert.equal(ctx.step, 'rest')
    assert.equal(ctx.stepStatus, 'running')
    assert.deepEqual(goalLines(), [`goal step=rest prev=none source=goal-fsm facts=${goalText(goalFacts(bot, ctx))}`])
    assert.deepEqual(bot.chats, ['on my own: resting near spawn'])
  })

  it('same facts with a running step: no change, no log, no chat', () => {
    const bot = goalBot()
    const ctx = {}
    decide(bot, ctx)
    lines.length = 0
    bot.chats.length = 0
    const r = decide(bot, ctx)
    assert.equal(r.action, 'rest')
    assert.deepEqual(goalLines(), [])
    assert.deepEqual(bot.chats, [])
  })

  it('done step re-decides (logs only on change)', () => {
    const bot = goalBot()
    const ctx = {}
    decide(bot, ctx)
    ctx.stepStatus = 'done'
    lines.length = 0
    bot.chats.length = 0
    const r = decide(bot, ctx)
    assert.equal(r.action, 'rest')
    assert.equal(ctx.stepStatus, 'running')
    assert.deepEqual(goalLines(), []) // same step again: silent restart
    assert.deepEqual(bot.chats, [])
  })

  it('failed step re-decides', () => {
    const bot = goalBot()
    const ctx = {}
    decide(bot, ctx)
    ctx.stepStatus = 'failed:no-trees'
    const r = decide(bot, ctx)
    assert.equal(r.action, 'rest')
    assert.equal(ctx.stepStatus, 'running')
  })

  it('changed facts re-decide', () => {
    const bot = goalBot()
    const ctx = {}
    decide(bot, ctx)
    bot._items = undefined
    bot.inventory = { items: () => [{ name: 'oak_log', count: 3 }] } // logs 0 -> 3
    lines.length = 0
    const r = decide(bot, ctx)
    assert.equal(r.action, 'rest') // craft feasible but unregistered: only rest can run
    assert.ok(ctx.goalText.includes('logs=3'))
  })

  it('unregistered steps never run even when feasible', () => {
    // Only rest is plugged into BEHAVIOURS in this bead; gather/craft/build
    // join in rw4.2-rw4.4 with one require line each, no goal.js change.
    const bot = goalBot({ items: [{ name: 'oak_log', count: 10 }] })
    const r = decide(bot, {})
    assert.equal(r.action, 'rest')
  })
})
