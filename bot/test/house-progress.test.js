'use strict'
// Prod bot5: house status read 48/149 over an untouched field. Progress
// counts plan blocks standing in the world, never air-by-plan clear cells.
const { it } = require('node:test')
const assert = require('node:assert/strict')
const task = require('../src/task')
const build = require('../src/behaviours/build')

it('house progress: an all-air site reads 0 done, clear cells out of the total', () => {
  const home = { site: { x: 0, y: 64, z: 0 }, v: 2 }
  const bot = { blockAt: (p) => ({ name: 'air', boundingBox: 'empty', position: p }) }
  const plan = build.blueprintFor(home)
  const p = task.houseProgress(bot, home)
  assert.equal(p.done, 0)
  assert.equal(p.total, plan.filter((c) => c.kind !== 'clear').length)
  assert.ok(plan.some((c) => c.kind === 'clear'), 'the plan has clear cells to exclude')
})
