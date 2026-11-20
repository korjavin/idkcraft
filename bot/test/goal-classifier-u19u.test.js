'use strict'

// Classifier plug contract, phase 1 (idkcraft-u19u §§1.1-1.3, §3):
// chooseStep consults a brain with menuAsk()/ask() and falls back to the
// FSM with a disagreement reference. Prod note (82zl fix): the prod brain
// carries menuAsk() only behind opt-in BOT_MENU_ASK=1 (PLANNER seam); these
// tests pin the contract with a hand-built asking brain. No C/deadlock
// behaviour here.

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

  it('82zl fix: makeBrain with a key but no switch yields a brain chooseStep never asks', async () => {
    // Switch off (default): no menuAsk and no ask, so the classifier runs
    // the FSM even though a key exists. The fetch stub must stay untouched.
    const origFetch = global.fetch
    let calls = 0
    global.fetch = async () => { calls++; throw new Error('must not be called') }
    try {
      const brain = makeBrain({ TYPESAFE_API_KEY: 'k' })
      assert.equal(brain.menuAsk, undefined)
      assert.equal(brain.ask, undefined)
      const r = await goal.chooseStep(brain, facts(), ['gather', 'craft', 'rest'], null)
      assert.equal(r.step, 'craft', 'FSM rank answers unasked')
      assert.equal(r.source, 'goal-fsm')
      assert.equal(r.model, null)
    } finally {
      global.fetch = origFetch
    }
    assert.equal(calls, 0)
  })

  it('82zl fix: makeBrain with the switch yields a menuAsk brain chooseStep asks', async () => {
    // The bead's acceptance: the opt-in prod brain carries menuAsk() (not
    // ask()), so the classifier arbitration runs against the stubbed model,
    // not goal-fsm. FSM ranks craft above gather on the default facts; the
    // model picks gather.
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
      brain = makeBrain({ TYPESAFE_API_KEY: 'k', BOT_MENU_ASK: '1' })
      assert.equal(typeof brain.menuAsk, 'function')
      assert.equal(brain.ask, undefined)
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

describe('JEV choice at normal v2 work boundaries', () => {
  const flush = () => new Promise((resolve) => setImmediate(resolve))

  it('asks once, carries outcomes, and takes JEV’s executable choice', async () => {
    const requests = []
    let resolve
    const brain = { workChoice: (req) => { requests.push(req); return new Promise((r) => { resolve = r }) } }
    const ctx = { stepOutcomes: [{ step: 'build', result: 'failed:no-planks' }] }
    const extra = { workBoundary: '12:build:failed:no-planks', choose: () => { throw new Error('legacy chooser ran') } }
    const names = ['craft', 'gather', 'rest']
    const pick = () => goal.chooseStep(brain, facts(), names, null, extra, ctx)

    assert.equal((await pick()).source, 'jev-work-pending')
    assert.equal((await pick()).source, 'jev-work-pending')
    assert.equal(requests.length, 1)
    assert.deepEqual(Object.keys(requests[0].criteria), ['craft', 'gather'])
    assert.deepEqual(requests[0].state.outcomes, ctx.stepOutcomes)
    resolve({ step: 'gather', confidence: 0.9 })
    await flush()
    assert.deepEqual(await pick(), { step: 'gather', source: 'jev-work', fsm: 'craft', model: 'jev' })
  })

  it('uses current eligibility and lets an owner order cut in while waiting', async () => {
    let resolve
    const brain = { workChoice: () => new Promise((r) => { resolve = r }) }
    const ctx = {}
    const extra = { workBoundary: '1:build:done' }
    const names = ['craft', 'gather', 'explore']
    assert.equal((await goal.chooseStep(brain, facts(), names, null, extra, ctx)).source, 'jev-work-pending')

    ctx.farmBuild = { ordered: true }
    const order = await goal.chooseStep(brain, facts(), [...names, 'farmbuild'], null, extra, ctx)
    assert.equal(order.source, 'order-rule')
    assert.equal(order.step, 'farmbuild')

    ctx.farmBuild = null
    resolve({ step: 'gather', confidence: 1 })
    await flush()
    const current = await goal.chooseStep(brain, facts(), ['craft', 'explore'], null, extra, ctx)
    assert.equal(current.source, 'fsm-fallback')
    assert.equal(current.step, 'craft')
  })

  it('drops late decisions and leaves night safety in charge', async (t) => {
    let now = 1000
    t.mock.method(Date, 'now', () => now)
    let resolve
    const ctx = {}
    const brain = { workChoice: () => new Promise((r) => { resolve = r }) }
    const extra = { workBoundary: '1:build:done' }
    const names = ['craft', 'gather']
    assert.equal((await goal.chooseStep(brain, facts(), names, null, extra, ctx)).source, 'jev-work-pending')
    const safety = await goal.chooseStep(brain, facts({ time: 'night' }), [...names, 'shelter'], null, extra, ctx)
    assert.equal(safety.source, 'night-rule')
    assert.equal(safety.step, 'shelter')
    now += 3001
    resolve({ step: 'gather', confidence: 1 })
    await flush()
    const fallback = await goal.chooseStep(brain, facts(), names, null, extra, ctx)
    assert.equal(fallback.source, 'fsm-fallback')
    assert.equal(fallback.step, 'craft')
  })

  it('dispatches a real boundary result without repeating the finished action', async (t) => {
    for (const [name, entry] of Object.entries(goal.MENU)) {
      t.mock.method(entry, 'feasible', () => ['craft', 'gather', 'rest'].includes(name))
    }
    const bot = {
      entity: { position: { x: 0, y: 64, z: 0 } },
      time: { timeOfDay: 6000, day: 1 }, health: 20, food: 20,
      inventory: { items: () => [] }, entities: {}, players: {},
      blockAt: () => null,
    }
    let resolve
    const ctx = {
      step: 'build', stepStatus: 'failed:no-planks', work: true,
      brain: { workChoice: () => new Promise((r) => { resolve = r }) },
    }
    assert.equal((await goal.decide(bot, ctx)).action, 'idle')
    assert.equal((await goal.decide(bot, ctx)).action, 'idle')
    assert.equal(ctx.step, 'build')
    assert.equal(ctx.stepOutcomes.length, 1)
    resolve({ step: 'gather', confidence: 0.9 })
    await flush()
    assert.equal((await goal.decide(bot, ctx)).action, 'gather')
    assert.equal(ctx.stepOutcomes.length, 1)
  })

  it('feeds a failed dispatch and measured progress into the next ranked menu', async (t) => {
    for (const [name, entry] of Object.entries(goal.MENU)) {
      t.mock.method(entry, 'feasible', () => ['craft', 'gather', 'rest'].includes(name))
    }
    const bot = {
      time: { timeOfDay: 6000, day: 1 }, health: 20, food: 20,
      entity: { position: { x: 0, y: 64, z: 0 } },
      inventory: { items: () => [] }, entities: {}, players: {},
      blockAt: () => null,
    }
    const requests = []
    let gathered = 0
    const ctx = {
      work: true,
      brainOptions: () => [
        { id: 'craft', feasible: true, why: 'make planks' },
        { id: 'gather', feasible: true, why: 'chop logs', cost: 2, progress: { done: gathered, total: 8 } },
      ],
      brain: {
        workFeedback: true,
        workChoice: async (req) => {
          requests.push(req)
          return { step: requests.length === 1 ? 'craft' : 'gather', confidence: 1 }
        },
      },
    }
    await goal.decide(bot, ctx)
    await flush()
    assert.equal((await goal.decide(bot, ctx)).action, 'craft')
    ctx.stepStatus = 'failed:no-wood'
    assert.equal((await goal.decide(bot, ctx)).action, 'gather')
    assert.equal(ctx.episodes[0].fail, 'no-wood')

    // When the failed block becomes feasible again, prior evidence still
    // downgrades it in the next model prompt.
    const retry = { ...ctx, workChoice: null }
    const extra = { workBoundary: 'retry', bot }
    await goal.chooseStep(ctx.brain, facts(), ['craft', 'gather'], null, extra, retry)
    await flush()
    assert.equal(requests[1].state.history.craft.successRate, 0.33)
    assert.equal(requests[1].state.history.craft.outcome, 'failed:no-wood')
    assert.deepEqual(Object.keys(requests[1].criteria), ['gather', 'craft'])
    assert.deepEqual(requests[1].state.blocks[0], { id: 'gather', cost: 2, progress: { done: 0, total: 8 } })
    // Now exercise the measured result of the model-driven gather.
    ctx.workEpisode = null
    ctx.step = 'build'
    ctx.stepStatus = 'done'
    ctx.stepFail = {}
    await goal.decide(bot, ctx)
    await flush()
    assert.equal((await goal.decide(bot, ctx)).action, 'gather')
    gathered = 4
    ctx.stepStatus = 'done'
    await goal.decide(bot, ctx)
    await goal.decide(bot, ctx)
    assert.equal(ctx.episodes.length, 2)
    assert.equal(ctx.episodes[1].outcome, 'progress')
    assert.equal(ctx.episodes[1].delta, 4)
  })

  it('temporarily removes blocks after three recent failures', async (t) => {
    const now = 1000000
    t.mock.method(Date, 'now', () => now)
    const episodes = [1, 2, 3].map((offset) => ({ sig: { kind: 'work' }, choice: 'craft', outcome: 'failed:no-wood', at: now - 1000 * offset })).reverse()
    const ctx = { episodes }
    const brain = { workFeedback: true, workChoice: () => { throw new Error('only one block remains') } }
    const choice = await goal.chooseStep(brain, facts(), ['craft', 'gather'], null, { workBoundary: 'retry' }, ctx)
    assert.equal(choice.step, 'gather')
    assert.equal(choice.workBy, 'fallback')
    assert.equal(require('../src/episodes').workRates(ctx, ['craft'], now + 300000).craft.coolingDown, false)
  })

  it('logs a five-minute sample once and retains the terminal outcome for learning', (t) => {
    const logs = []
    t.mock.method(console, 'log', (line) => logs.push(line))
    const episodes = require('../src/episodes')
    const ctx = {}
    episodes.beginWork(null, ctx, 'build', 7, { done: 1, total: 10 }, 'snapshot', { by: 'jev', conf: 0.9 }, 1000)
    episodes.sampleWork(ctx, 7, { done: 2, total: 10 }, 'snapshot', 300999)
    assert.equal(logs.length, 1)
    episodes.sampleWork(ctx, 7, { done: 3, total: 10 }, 'snapshot', 301000)
    episodes.finishWork(ctx, 7, { done: 6, total: 10 }, 'done', 'snapshot', 302000)
    assert.match(logs[0], /choice=build by=jev conf=0.9 id=1000-7/)
    assert.match(logs[1], /outcome choice=build by=jev id=1000-7 result=progress delta=2 fail=- ms=300000/)
    assert.equal(logs.length, 2)
    assert.equal(ctx.episodes[0].delta, 5)
  })

  it('asks at an autonomous pin and preserves an explicit plan pin', async (t) => {
    for (const [name, entry] of Object.entries(goal.MENU)) {
      t.mock.method(entry, 'feasible', () => ['craft', 'gather', 'rest'].includes(name))
    }
    const bot = {
      time: { timeOfDay: 6000, day: 1 }, health: 20, food: 20,
      entity: { position: { x: 0, y: 64, z: 0 } },
      inventory: { items: () => [] }, entities: {}, players: {}, blockAt: () => null,
    }
    const seen = []
    const brain = { workChoice: async (request) => {
      seen.push(request)
      return { step: 'gather', confidence: 1 }
    } }
    const ctx = { work: true, step: 'explore', stepStatus: 'running', taskPlanStep: 'craft', brain }
    assert.equal((await goal.decide(bot, ctx)).source, 'jev-work-pending')
    assert.equal(ctx.taskPlanStep, 'craft')
    await flush()
    assert.equal((await goal.decide(bot, ctx)).action, 'gather')
    assert.equal(ctx.taskPlanStep, null)
    assert.equal(seen[0].state.previousPlan, 'craft')
    assert.deepEqual(Object.keys(seen[0].criteria), ['craft', 'gather'])

    const explicit = { work: true, step: 'explore', stepStatus: 'done', taskPlanStep: 'craft', taskPlanArgs: { step: 'craft', by: 'owner' }, brain }
    assert.equal((await goal.decide(bot, explicit)).action, 'craft')
    assert.equal(seen.length, 1)
  })

  it('logs ordered farm suppression once and allows a recovery choice when the farm is held', async (t) => {
    const logs = []
    t.mock.method(console, 'log', (line) => logs.push(line))
    const brain = { workChoice: async () => ({ step: 'gather', confidence: 1 }) }
    const ctx = { farmBuild: { ordered: true } }
    const extra = { workBoundary: 'farm-failure', orderRecovery: true }
    for (let i = 0; i < 2; i++) {
      const ordered = await goal.chooseStep(brain, facts(), ['farmbuild', 'castlefetch', 'gather'], null, extra, ctx)
      assert.equal(ordered.step, 'farmbuild')
    }
    assert.deepEqual(logs, ['brain work skip why=order-rule'])
    assert.equal((await goal.chooseStep(brain, facts(), ['castlefetch', 'gather'], null, extra, ctx)).source, 'jev-work-pending')
    await flush()
    assert.equal((await goal.chooseStep(brain, facts(), ['castlefetch', 'gather'], null, extra, ctx)).step, 'gather')
  })

  it('keeps both JEV and fallback recovery through facts changes until done or expiry', async (t) => {
    for (const [name, entry] of Object.entries(goal.MENU)) {
      t.mock.method(entry, 'feasible', () => ['farmbuild', 'gather', 'stockpile', 'rest'].includes(name))
    }
    let now = 1000000
    t.mock.method(Date, 'now', () => now)
    for (const confidence of [1, 0]) {
      const bot = {
        time: { timeOfDay: 6000, day: 1 }, health: 20, food: 20,
        entity: { position: { x: 0, y: 64, z: 0 } }, entities: {}, players: {},
        inventory: { items: () => [] }, blockAt: () => null,
      }
      const ctx = {
        work: true, step: 'farmbuild', stepStatus: 'failed:no-mats', farmBuild: { ordered: true },
        brain: { workChoice: async () => ({ step: 'stockpile', confidence }) },
      }
      assert.equal((await goal.decide(bot, ctx)).source, 'jev-work-pending')
      await flush()
      const recovery = await goal.decide(bot, ctx)
      assert.ok(['gather', 'stockpile'].includes(recovery.action))
      assert.equal(ctx.stepPick.source, confidence ? 'jev-work' : 'fsm-fallback')
      assert.ok(ctx.stepPick.recovery)

      now += 5000
      bot.entity.position = { x: 40, y: 64, z: 0 }
      assert.equal(goal.failHolds(ctx, 'farmbuild', 'changed inventory and position', bot), true)
      ctx.taskPlanStep = 'stockpile'
      assert.equal((await goal.decide(bot, ctx)).action, recovery.action)
      ctx.taskPlanStep = null

      if (confidence) {
        ctx.stepStatus = 'done'
        ctx.taskPlanStep = 'farmbuild'
        const next = await goal.decide(bot, ctx)
        assert.notEqual(next.action, 'farmbuild')
        assert.ok(next.source === 'jev-work-pending' || ctx.stepPick.why === 'step-done')
      } else {
        now += 90000
        assert.equal((await goal.decide(bot, ctx)).action, 'farmbuild')
      }
    }
  })

  it('wires work JEV separately from legacy menu ask, on keyed v2 only', () => {
    const env = { BOT_BODY: 'baritone', TYPESAFE_API_KEY: 'fake-test-key' }
    assert.equal(typeof makeBrain(env).workChoice, 'function')
    assert.equal(makeBrain(env).menuAsk, undefined)
    assert.equal(makeBrain({ ...env, BOT_WORK_JEV: '0' }).workChoice, undefined)
    assert.equal(makeBrain({ BOT_BODY: 'baritone' }).workChoice, undefined)
    assert.equal(makeBrain({ ...env, BOT_BODY: 'mineflayer' }).workChoice, undefined)
  })
})
