'use strict'
// North star (8hpy): the behaviour-block catalogue the external brain picks from.
const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const task = require('../src/task')
const { STEP_ORDER } = require('../src/plan-consts')

describe('brainOptions', () => {
  it('lists every work step as a block with feasible/held/why/progress and never throws', () => {
    const bot = { entity: { position: { x: 0, y: 64, z: 0 } }, inventory: { items: () => [] }, blockAt: () => null, time: { timeOfDay: 1000 }, health: 20, food: 20 }
    const ctx = { funProject: { blueprint: [{}, {}, {}], placed: 1 } }
    const opts = task.brainOptions(bot, ctx)
    assert.deepEqual(opts.map((o) => o.id), [...STEP_ORDER.filter((n) => n !== 'rest' && n !== 'fun'), 'fun'])
    for (const o of opts) {
      assert.equal(typeof o.feasible, 'boolean')
      assert.equal(typeof o.held, 'boolean')
      assert.ok(typeof o.why === 'string' && o.why.length > 0, o.id)
    }
    const fun = opts.find((o) => o.id === 'fun')
    assert.deepEqual(fun.progress, { done: 1, total: 3 })
  })
})
