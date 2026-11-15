'use strict'
const test = require('node:test')
const assert = require('node:assert')
const goal = require('../src/goal')
const castlefetch = require('../src/behaviours/castlefetch')

test('loop-break: gather<->castlefetch pins with a flat castle block the kind', () => {
  const ctx = { castle: { progress: { done: 7370 } }, castleWord: { kind: 'frame', left: 40 } }
  const trips = ['gather', 'castlefetch', 'gather', 'castlefetch', 'gather'].map((s) => goal.noteLoop(ctx, s))
  assert.deepStrictEqual(trips, [false, false, false, false, true])
  assert.ok(goal.loopBlocked(ctx, 'frame'))
  assert.ok(!goal.loopBlocked(ctx, 'stone'))
})

test('loop-break: castle progress resets the streak; a third step never trips', () => {
  const ctx = { castle: { progress: { done: 1 } }, castleWord: { kind: 'planks' } }
  for (const s of ['gather', 'castlefetch', 'gather', 'castlefetch']) goal.noteLoop(ctx, s)
  ctx.castle.progress.done = 2
  assert.strictEqual(goal.noteLoop(ctx, 'gather'), false)
  const c2 = { castleWord: { kind: 'planks' } }
  assert.strictEqual(['a', 'b', 'c', 'a', 'b', 'c'].some((s) => goal.noteLoop(c2, s)), false)
})

test('loop-blocked kind: no fetch demand, and the castle lays a partial on hand', () => {
  const ctx = { loopBlocked: { frame: Date.now() + 60000 }, castle: { site: { x: 0, y: 64, z: 0 } }, castleWord: { kind: 'frame', left: 20 } }
  ctx.acquireHeld = { frame: Date.now() } // acquire just failed: the fetch rests
  assert.strictEqual(castlefetch.demand({ inventory: { items: () => [] } }, ctx), null)
  assert.strictEqual(goal.castleGo({ castle: 'frame-some', time: 'day' }, ctx, null), goal.registered('castle'))
  assert.strictEqual(goal.castleGo({ castle: 'stone-some', time: 'day' }, ctx, null), false)
})

test('held kind with no known chest: castlefetch hands acquire() the item and remaining need', () => {
  const acq = require('../src/behaviours/acquire')
  const orig = acq.acquire
  const calls = []
  acq.acquire = (bot, ctx, item, n) => { calls.push([item, n]); return 'running' }
  try {
    const ctx = { loopBlocked: { frame: Date.now() + 60000 }, castle: { site: { x: 0, y: 64, z: 0 } }, castleWord: { kind: 'frame', left: 20 } }
    const bot = { inventory: { items: () => [{ name: 'oak_log', count: 5 }], emptySlotCount: () => 30 }, entity: { position: { x: 500, y: 64, z: 500 } } }
    const d = castlefetch.demand(bot, ctx)
    assert.strictEqual(d.acquire, true)
    castlefetch(bot, ctx, null, {})
    assert.strictEqual(calls.length, 1); assert.strictEqual(calls[0][0], 'oak_log')
    assert.ok(calls[0][1] >= 5 + d.short, 'a bulk trip: at least the short, up to the castle remainder') // acquire-bulk.test.js pins the remainder
  } finally { acq.acquire = orig }
})
