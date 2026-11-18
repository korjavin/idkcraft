'use strict'
const test = require('node:test')
const assert = require('node:assert')
const goal = require('../src/goal')
const task = require('../src/task')
const castlefetch = require('../src/behaviours/castlefetch')

function emptyTwice(ctx, step) {
  ctx.stepDecides = 0
  goal.emptyRun(ctx, step, 'done', true)
  ctx.stepDecides = 0
  return goal.emptyRun(ctx, step, 'done', true)
}

test('empty-run hold names the owed kind and survives a drifting facts text', () => {
  const ctx = { castleWord: { kind: 'stone', left: 40 } }
  assert.strictEqual(emptyTwice(ctx, 'castlefetch'), 'failed:no-effect-stone')
  ctx.stepFail = { castlefetch: { status: 'failed:no-effect-stone', text: 'a', at: Date.now() } }
  assert.strictEqual(goal.failHolds(ctx, 'castlefetch', 'b totally different text', null), true)
  ctx.emptyHeld.castlefetch.at = 0 // window over
  assert.strictEqual(goal.emptyHeld(ctx, 'castlefetch'), null)
})

test('a held step is not offered: the feasible filter drops it', () => {
  const ctx = {}
  emptyTwice(ctx, 'craft')
  assert.strictEqual(goal.failHolds(ctx, 'craft', 'x', null), true)
  assert.strictEqual(goal.failHolds(ctx, 'gather', 'x', null), false)
})

test('JEV picking a held step falls back to the FSM and logs it', () => {
  const ctx = {}
  emptyTwice(ctx, 'castlefetch')
  const wd = { stratStep: 'castlefetch' }
  const lines = []
  const orig = console.log
  console.log = (l) => lines.push(String(l))
  let r
  try {
    r = task.consumeStrategic({}, ctx, 'castle', {}, wd, {}, goal, 'x', [{ id: 'castlefetch' }, { id: 'beds' }], 'beds', 'jev', () => ({ step: 'beds', source: 'fsm-fallback' }))
  } finally { console.log = orig }
  assert.strictEqual(r.step, 'beds')
  assert.strictEqual(r.source, 'held-fallback')
  assert.ok(lines.some((l) => l.startsWith('jev pick held step=castlefetch')), lines.join('\n'))
})

test('outcome history and the held annotation ride every plan() request', () => {
  const ctx = {}
  goal.noteOutcome(ctx, 'castlefetch', 'failed:no-effect-stone')
  emptyTwice(ctx, 'castlefetch')
  const req = require('../src/plan-context').withContext({}, ctx, 'castle', 0, 1, {}, { state: {}, criteria: { castlefetch: 'fetch', beds: 'beds' } })
  assert.deepStrictEqual(req.state.outcomes, [{ step: 'castlefetch', result: 'failed:no-effect-stone' }])
  assert.match(req.criteria.castlefetch, /^held: done-without-effect x2/)
  assert.strictEqual(req.criteria.beds, 'beds')
})

function stoneOwed(acquireHeldAt) {
  const now = Date.now()
  const ctx = {
    castle: { site: { x: 0, y: 64, z: 0 } },
    castleWord: { kind: 'stone', left: 40 },
    resources: { items: new Map() },
    acquireHeld: acquireHeldAt ? { stone: acquireHeldAt } : {},
    stepFail: { castlefetch: { at: now, status: 'failed:castlefetch-no-stone', text: 'x', kinds: { stone: { at: now } } } },
  }
  const bot = { inventory: { items: () => [], emptySlotCount: () => 30 }, entity: { position: { x: 10, y: 64, z: 10 } } }
  return { bot, ctx }
}

test('castlefetch with stone owed, no chest stone and acquire held fails naming stone (never done)', () => {
  const { bot, ctx } = stoneOwed(Date.now())
  assert.strictEqual(castlefetch.demand(bot, ctx), null)
  castlefetch(bot, ctx, null, {})
  assert.strictEqual(ctx.stepStatus, 'failed:no-effect-stone')
  assert.strictEqual(ctx.castleFetchFailKind, 'stone')
})

test('castlefetch with stone owed and no chest stone runs the acquire block', () => {
  const acq = require('../src/behaviours/acquire')
  const orig = acq.acquire
  const calls = []
  acq.acquire = (bot, ctx, item) => { calls.push(item); return 'running' }
  try {
    const { bot, ctx } = stoneOwed(0)
    castlefetch(bot, ctx, null, {})
    assert.notStrictEqual(ctx.stepStatus, 'done')
    assert.ok(calls.length > 0 || /stone/.test(String(ctx.stepStatus)), `status=${ctx.stepStatus} calls=${calls}`)
  } finally { acq.acquire = orig }
})
