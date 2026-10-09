'use strict'

// idkcraft-vmzq.4: step commitment. A running step re-decides only on
// done/failed, a table force (FORCES), its own menu exit, a moved FSM
// answer, or an executive pin — never on a facts-text move alone. One
// trace per deleted suppressor and per symptom bead; the FSM-equivalence
// property is the offline trace-equivalence (acceptance a).
const { describe, it, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const { MENU, STEP_ORDER, decide, goalFacts, goalText, goalFsm } = require('../src/goal')

const pos = (x, y, z) => ({ x, y, z, distanceTo: (q) => Math.hypot(x - q.x, y - q.y, z - q.z) })
function mkBot() {
  const b = { items: [], entity: { position: pos(0, 64, 0) }, time: { timeOfDay: 6000 }, spawnPoint: pos(0, 64, 0), health: 20, food: 20, chat: () => {} }
  b.inventory = { items: () => b.items }
  return b
}
const logs = (b, n) => { b.items = n > 0 ? [{ name: 'oak_log', count: n }] : [] }

// The menu under test: feasibility is the scenario's, so each trace
// controls exactly which steps can run while the facts text moves for real.
let saved
let feasible
function useMenu(fn) { feasible = fn }
beforeEach(() => {
  saved = Object.fromEntries(Object.keys(MENU).map((n) => [n, MENU[n].feasible]))
  for (const n of Object.keys(MENU)) MENU[n].feasible = (facts, bot, ctx) => n === 'rest' || !!feasible(n, facts, bot, ctx)
  feasible = () => false
})
afterEach(() => { for (const n of Object.keys(saved)) MENU[n].feasible = saved[n] })

function model(answer) {
  const brain = { source: 'laya', asks: 0, async ask({ criteria }) { brain.asks++; const a = typeof answer === 'function' ? answer(criteria) : answer; return a } }
  return brain
}

describe('vmzq.4 commitment: a text move alone never re-asks', () => {
  it('beds<->explore (2026-10-09): a model-picked explore holds across log flips that keep the FSM answer', async () => {
    const b = mkBot()
    useMenu((n) => n === 'beds' || n === 'explore')
    const brain = model('explore')
    const ctx = { brain }
    await decide(b, ctx)
    assert.equal(ctx.step, 'explore')
    assert.equal(ctx.stepPick.fsm, 'beds')
    const pick = ctx.stepPick
    for (let i = 1; i <= 20; i++) {
      logs(b, i % 2 ? 3 : 0) // logs none <-> few every tick
      assert.equal((await decide(b, ctx)).action, 'explore')
    }
    assert.equal(brain.asks, 1, 'asked once, at the pick')
    assert.equal(ctx.stepPick, pick)
  })

  it('a move that changes the FSM answer re-decides (equivalence with the old facts-changed re-pick)', async () => {
    const b = mkBot()
    let lightOk = false
    useMenu((n) => n === 'beds' || n === 'explore' || (n === 'light' && lightOk))
    const brain = model('explore')
    const ctx = { brain }
    await decide(b, ctx)
    lightOk = true
    useMenu((n) => n === 'light' || n === 'explore')
    logs(b, 3)
    await decide(b, ctx)
    assert.equal(brain.asks, 2)
    assert.equal(ctx.stepPick.why, 'facts-changed')
  })

  it('the running step leaving the menu re-decides', async () => {
    const b = mkBot()
    let craftOk = true
    useMenu((n) => (n === 'craft' && craftOk) || n === 'gather')
    const ctx = {}
    await decide(b, ctx)
    assert.equal(ctx.step, 'craft')
    craftOk = false
    logs(b, 3)
    assert.equal((await decide(b, ctx)).action, 'gather')
    assert.equal(ctx.stepPick.why, 'facts-changed')
  })

  it('a held text is evaluated once: steady facts after a hold never re-run the menu', async () => {
    const b = mkBot()
    let calls = 0
    useMenu((n) => { if (n === 'gather') calls++; return n === 'gather' })
    const ctx = {}
    await decide(b, ctx)
    logs(b, 3)
    calls = 0
    await decide(b, ctx)
    const once = calls
    await decide(b, ctx)
    await decide(b, ctx)
    assert.ok(once > 0)
    assert.equal(calls, once, 'no menu pass on the remembered held text')
  })
})

describe('vmzq.4 commitment: rest never finishes', () => {
  it('a model rest over a work answer is re-asked on every text move (revmux 01)', async () => {
    const b = mkBot()
    useMenu((n) => n === 'beds' || n === 'explore')
    let answer = 'rest'
    const brain = model(() => answer)
    const ctx = { brain }
    await decide(b, ctx)
    assert.equal(ctx.step, 'rest')
    answer = 'explore'
    logs(b, 3)
    assert.equal((await decide(b, ctx)).action, 'explore')
    assert.equal(brain.asks, 2)
  })
})

describe('vmzq.4 commitment: forces still cut through', () => {
  it('dusk forces gohome (time word)', async () => {
    const b = mkBot()
    useMenu((n, facts) => n === 'explore' || (n === 'gohome' && facts.time !== 'day'))
    const ctx = { brain: model('explore') }
    await decide(b, ctx)
    assert.equal(ctx.step, 'explore')
    b.time.timeOfDay = 12500
    assert.equal((await decide(b, ctx)).action, 'gohome')
  })

  it('a broken pickaxe mid-castle re-arms (kit word)', async () => {
    const b = mkBot()
    b.items = [{ name: 'stone_pickaxe', count: 1 }, { name: 'stone_sword', count: 1 }]
    useMenu((n, facts) => (n === 'castle' && facts.pickaxe > 0) || (n === 'equip' && !(facts.pickaxe > 0)))
    const ctx = {}
    await decide(b, ctx)
    assert.equal(ctx.step, 'castle')
    b.items = [{ name: 'stone_sword', count: 1 }]
    assert.equal((await decide(b, ctx)).action, 'equip')
  })

  it('an order preempts: a cleared step re-decides with force=order', async () => {
    const b = mkBot()
    useMenu((n) => n === 'explore')
    const ctx = {}
    await decide(b, ctx)
    ctx.step = null // resetNightStep
    ctx.stepStatus = null
    await decide(b, ctx)
    assert.equal(ctx.stepPick.why, 'start')
  })

  it('a build whose planks run out fails and re-decides', async () => {
    const b = mkBot()
    let buildOk = true
    useMenu((n) => (n === 'build' && buildOk) || n === 'gather')
    const ctx = {}
    await decide(b, ctx)
    assert.equal(ctx.step, 'build')
    buildOk = false
    ctx.stepStatus = 'failed:no-planks'
    assert.equal((await decide(b, ctx)).action, 'gather')
    assert.equal(ctx.stepPick.why, 'step-failed')
    assert.equal(ctx.stepFail.build.status, 'failed:no-planks')
  })

  it('a task-plan pin keeps the old rule: any text move re-decides (the vmzq.21 bound releases)', async () => {
    const b = mkBot()
    useMenu((n) => n === 'beds' || n === 'explore')
    const ctx = { taskPlanStep: 'explore' }
    await decide(b, ctx)
    assert.equal(ctx.stepPick.source, 'task-plan')
    logs(b, 3)
    await decide(b, ctx)
    assert.equal(ctx.step, 'beds')
    assert.equal(ctx.stepPick.why, 'facts-changed')
  })

  it('a step moved outside decide (order, retreat) keeps the old rule', async () => {
    const b = mkBot()
    useMenu((n) => n === 'beds' || n === 'explore')
    const ctx = { brain: model('explore') }
    await decide(b, ctx)
    ctx.step = 'roam'
    logs(b, 3)
    await decide(b, ctx)
    assert.equal(ctx.stepPick.step, 'explore')
    assert.equal(ctx.stepPick.why, 'facts-changed')
  })
})

describe('vmzq.4 commitment: symptom beads', () => {
  it('forage<->explore (4dse/bt8s/sqg2): known held by the running leg — a known-only flip is no move', async () => {
    const b = mkBot()
    const ctx = {}
    useMenu((n) => n === 'forage')
    await decide(b, ctx)
    assert.equal(ctx.step, 'forage')
    // goalFacts reads known from memory; drive the text word through ctx.goalText the way a flip reads.
    const text = goalText(goalFacts(b, ctx), ctx.home)
    ctx.goalText = text.replace(/known=\S+/, 'known=near')
    const pick = ctx.stepPick
    useMenu((n) => n === 'explore') // known=none: forage infeasible, explore feasible
    for (let i = 0; i < 10; i++) await decide(b, ctx)
    assert.equal(ctx.step, 'forage')
    assert.equal(ctx.stepPick, pick)
    // Another word moving with it is a real move: the leg left the menu.
    logs(b, 3)
    assert.equal((await decide(b, ctx)).action, 'explore')
  })

  it('gear done re-pick (ipn.7) and craft done loop (h9z): a finished step always goes through the menu', async () => {
    const b = mkBot()
    useMenu((n) => n === 'craft' || n === 'gather')
    const ctx = {}
    await decide(b, ctx)
    assert.equal(ctx.step, 'craft')
    ctx.stepStatus = 'done' // same text: the h9z done-hold
    assert.equal((await decide(b, ctx)).action, 'gather')
    assert.ok(ctx.stepFail.craft)
  })

  it('rw4.16: a finished infeasible gohome is never re-issued', async () => {
    const b = mkBot()
    let night = true
    useMenu((n) => n === 'gohome' && night)
    const ctx = {}
    b.time.timeOfDay = 12500
    await decide(b, ctx)
    assert.equal(ctx.step, 'gohome')
    night = false
    ctx.stepStatus = 'done'
    for (let i = 0; i < 3; i++) assert.equal((await decide(b, ctx)).action, 'rest')
  })

  it('beds unreachable (vmzq.61): explore after a held beds is not re-asked on log flips', async () => {
    const b = mkBot()
    let bedsHeld = false
    useMenu((n) => (n === 'beds' && !bedsHeld) || n === 'explore')
    const brain = model((c) => (c.beds ? 'beds' : 'explore'))
    const ctx = { brain }
    await decide(b, ctx)
    assert.equal(ctx.step, 'beds')
    bedsHeld = true
    ctx.stepStatus = 'failed:cant-reach-bed'
    await decide(b, ctx)
    assert.equal(ctx.step, 'explore')
    const asks = brain.asks
    for (let i = 1; i <= 10; i++) { logs(b, i % 2 ? 3 : 0); await decide(b, ctx) }
    assert.equal(ctx.step, 'explore')
    assert.equal(brain.asks, asks)
  })
})

// Offline trace-equivalence (acceptance a): with the FSM brain the old
// rule re-picked goalFsm(menu) on every text move. Random traces over
// moving words and moving menus: after every tick the running step is
// exactly that re-pick whenever the text moved, and unchanged otherwise.
describe('vmzq.4 trace-equivalence with the FSM (old facts-changed rule)', () => {
  for (const seed0 of [42, 7, 1234]) it(`seed ${seed0}: 1500 random ticks, commitment == old re-pick`, async () => {
    let seed = seed0
    const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648 }
    const pool = STEP_ORDER.filter((n) => n !== 'rest')
    let menu = new Set()
    useMenu((n) => menu.has(n))
    const b = mkBot()
    const ctx = {}
    await decide(b, ctx)
    let lastText = ctx.goalText
    let moves = 0
    for (let t = 0; t < 1500; t++) {
      if (rnd() < 0.05) b.time.timeOfDay = [6000, 12500, 18000][Math.floor(rnd() * 3)]
      if (rnd() < 0.5) logs(b, Math.floor(rnd() * 20))
      // A menu change only lands with a text move (feasibility reads the facts).
      const moved = goalText(goalFacts(b, ctx), ctx.home) !== lastText
      if (moved) menu = new Set(pool.filter(() => rnd() < 0.3))
      const prev = ctx.step
      await decide(b, ctx)
      const text = goalText(goalFacts(b, ctx), ctx.home)
      if (text !== lastText) {
        moves++
        const want = goalFsm(goalFacts(b, ctx), [...Object.keys(MENU).filter((n) => MENU[n].feasible(goalFacts(b, ctx), b, ctx))])
        assert.equal(ctx.step, want, `tick ${t} prev=${prev} pick=${JSON.stringify(ctx.stepPick)} menu=${[...menu]} rearm=${goalFacts(b, ctx).rearm}`)
      } else {
        assert.equal(ctx.step, prev, `tick ${t}: steady text keeps the step`)
      }
      lastText = text
    }
    assert.ok(moves > 50, `moves=${moves}`)
  })
})
