const { test } = require('node:test')
const assert = require('node:assert/strict')
const goal = require('../src/goal')

// prod 2026-11-19 bot2: 'build farm' lost to the castle-rule (castle tidy) every tick
test('an ordered farm outranks the castle and fun rules', async () => {
  const chooseStep = goal.chooseStep || goal._chooseStep
  assert.equal(typeof chooseStep, 'function')
  const ctx = { farmBuild: { ordered: true } }
  const facts = { time: 'day', castle: 'ordered' }
  const c = await chooseStep(null, facts, ['castle', 'gocastle', 'farmbuild', 'explore', 'rest'], null, null, ctx)
  assert.equal(c.step, 'farmbuild')
  const b = await chooseStep(null, facts, ['castle', 'gocastle', 'farmbuild', 'explore', 'rest'], null, null, { farmBuild: { ordered: true, built: true } })
  assert.notEqual(b.source, 'order-rule')
})
