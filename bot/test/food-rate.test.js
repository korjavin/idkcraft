'use strict'
const test = require('node:test')
const assert = require('node:assert')
const fr = require('../src/food-rate')

test('food rate prints one 10-min summary line and resets', () => {
  const ctx = {}
  const lines = []
  const log = console.log
  console.log = (l) => lines.push(l)
  try {
    fr.tick({ food: 10, health: 20 }, ctx, 0)
    fr.note(ctx, 'eaten', 1); fr.note(ctx, 'recoveries', 1); fr.note(ctx, 'deaths', 1)
    fr.tick({ food: 20, health: 3.4 }, ctx, 1000)
    assert.strictEqual(lines.length, 0)
    fr.tick({ food: 15, health: 12 }, ctx, fr.WINDOW_MS)
  } finally { console.log = log }
  assert.deepStrictEqual(lines, ['food rate eaten=1 food=15.0 minHealth=3 recoveries=1 deaths=1'])
  assert.strictEqual(ctx.foodRate, null)
})
