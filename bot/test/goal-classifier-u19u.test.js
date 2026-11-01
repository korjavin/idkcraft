'use strict'

// Classifier plug contract, phase 1 (idkcraft-u19u §§1.1-1.3, §3):
// chooseStep consults a brain with ask() and falls back to the FSM with a
// disagreement reference. Prod note: the tick brain carries ask() since
// idkcraft-82zl (PLANNER seam); these tests pin the contract with a
// hand-built asking brain. No C/deadlock behaviour here.

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const goal = require('../src/goal')
const { makeBrain, JEV_ENDPOINT } = require('../src/brain')
const metrics = require('../src/metrics')

const facts = (over = {}) => ({
  time: 'day', castle: 'none', player: 'none', home: 'built', known: 'none',
  haul: 'none', surplus: 'no', pinned: 'none', beds: 'both', gear: 'done',
  sword: 1, pickaxe: 1, pickWord: 'stone', cobble: 0, logs: 0, planks: 0,
  unlit: 0, torches: 0, rearm: false, health: 20, food: 20, inside: 'no',
  maxPlanks: 0, table: 0, door: 0, scaffold: 16,
  chest: 'yes', chestTodo: 'none', gearHandover: 'none',
  coal: 0, charcoal: 0, sticks: 0, tablePlaced: false, houseTable: false,
  tableOwed: false,
  ...over,
})

function countingBrain(source, answer) {
  return {
    source,
    calls: 0,
    ask: async function (q) {
      this.calls++
      // The plug contract (§1.2): facts text as state and situation, one
      // STEP_CRITERIA clause per asked step.
      assert.equal(typeof q.state, 'string')
      assert.equal(q.situation, q.state)
      assert.deepEqual(Object.keys(q.criteria).sort(), this.menu.slice().sort())
      if (typeof answer === 'function') return answer(q)
      return answer
    },
    menu: null,
  }
}

async function disagreements(model, fsm) {
  const text = await metrics.client.register.metrics()
  const m = text.match(new RegExp(`idkcraft_bot_goal_disagreements_total\\{model="${model}",fsm="${fsm}"\\} ([0-9.]+)`))
  return m ? Number(m[1]) : 0
}

describe('goal classifier plug (u19u phase 1)', () => {
  it('takes an in-menu model answer over the FSM reference', async () => {
    // FSM order ranks craft above gather; the model may pick either.
    const brain = countingBrain('jev', 'gather')
    brain.menu = ['gather', 'craft', 'rest']
    const r = await goal.chooseStep(brain, facts(), ['gather', 'craft', 'rest'], null)
    assert.equal(brain.calls, 1)
    assert.equal(r.step, 'gather')
    assert.equal(r.source, 'jev')
    assert.equal(r.fsm, 'craft')
  })

  it('an out-of-menu answer falls back to the FSM', async () => {
    const brain = countingBrain('jev', 'castle')
    brain.menu = ['gather', 'rest']
    const r = await goal.chooseStep(brain, facts(), ['gather', 'rest'], null)
    assert.equal(r.step, 'gather')
    assert.equal(r.source, 'fsm-fallback')
    assert.equal(r.fsm, 'gather')
  })

  it('timeout and error fall back to the FSM', async () => {
    const timeout = { source: 'jev', ask: async () => { const e = new Error('deadline'); e.name = 'TimeoutError'; throw e } }
    const broken = { source: 'jev', ask: async () => { throw new Error('boom') } }
    for (const brain of [timeout, broken]) {
      const r = await goal.chooseStep(brain, facts(), ['gather', 'rest'], null)
      assert.equal(r.step, 'gather', 'FSM answer survives the failure')
      assert.equal(r.source, 'fsm-fallback')
    }
  })

  it('the night rule never asks', async () => {
    const brain = countingBrain('jev', 'gather')
    brain.menu = ['stay', 'rest']
    const night = facts({ time: 'night', home: 'built', inside: 'yes' })
    const r = await goal.chooseStep(brain, night, ['stay', 'rest'], null)
    assert.equal(brain.calls, 0)
    assert.equal(r.step, 'stay')
    assert.equal(r.source, 'night-rule')
  })

  it('the castle rule never asks', async () => {
    const brain = countingBrain('jev', 'gather')
    brain.menu = ['castle', 'gather', 'rest']
    const r = await goal.chooseStep(brain, facts({ castle: 'stone-batch' }), ['castle', 'gather', 'rest'], null)
    assert.equal(brain.calls, 0)
    assert.equal(r.step, 'castle')
    assert.equal(r.source, 'castle-rule')
  })

  it('a single option never asks', async () => {
    const brain = countingBrain('jev', 'rest')
    brain.menu = ['rest']
    const r = await goal.chooseStep(brain, facts(), ['rest'], null)
    assert.equal(brain.calls, 0)
    assert.equal(r.step, 'rest')
    assert.equal(r.source, 'only-option')
  })

  it('a shaped [work, rest] pair never asks a non-jev brain', async () => {
    const brain = countingBrain('laya', 'rest')
    brain.menu = ['gather', 'rest']
    const r = await goal.chooseStep(brain, facts(), ['gather', 'rest'], null)
    assert.equal(brain.calls, 0, 'laya rest-bias is shaped away without a call')
    assert.equal(r.step, 'gather')
    assert.equal(r.source, 'only-option')
  })

  it('a diverge increments the disagreement metric', async () => {
    const before = await disagreements('forage', 'gather')
    const brain = countingBrain('jev', 'forage')
    brain.menu = ['gather', 'forage', 'rest']
    const r = await goal.chooseStep(brain, facts({ known: 'near' }), ['gather', 'forage', 'rest'], null)
    assert.equal(r.step, 'forage')
    assert.equal(r.fsm, 'gather')
    assert.equal(await disagreements('forage', 'gather'), before + 1)
  })

  it('82zl: makeBrain with a key yields a brain chooseStep asks', async () => {
    // The bead's acceptance: the prod brain carries ask(), so the
    // classifier arbitration runs against the stubbed model, not goal-fsm.
    // FSM ranks craft above gather on the default facts; the model picks gather.
    // jevBrain captures fetch at construction: stub before makeBrain.
    const origFetch = global.fetch
    global.fetch = async (url, opts) => {
      assert.equal(url, JEV_ENDPOINT)
      const q = JSON.parse(opts.body).questions.action
      assert.deepEqual(Object.keys(q.criteria).sort(), ['craft', 'gather', 'rest'])
      return { ok: true, json: async () => ({ answers: { action: { choice: 'gather' } } }) }
    }
    let brain
    try {
      brain = makeBrain({ TYPESAFE_API_KEY: 'k' })
      assert.equal(typeof brain.ask, 'function')
      const r = await goal.chooseStep(brain, facts(), ['gather', 'craft', 'rest'], null)
      assert.equal(r.step, 'gather')
      assert.equal(r.source, 'jev')
      assert.equal(r.fsm, 'craft')
      assert.equal(r.model, 'jev')
    } finally {
      global.fetch = origFetch
    }
  })
})
