'use strict'
// Survival steps pause the stall clock (owner 2026-11-13: a foodRecovery
// run parked the castle for 60 min).
const { it } = require('node:test')
const assert = require('node:assert/strict')
const site = require('../src/site')
const task = require('../src/task')

it('foodRecovery/chestSearch are not eligible stall time', () => {
  const orig = site.timeWord
  site.timeWord = () => 'day'
  try {
    assert.equal(task.eligible({}, { work: true, step: 'castle' }), true)
    assert.equal(task.eligible({}, { work: true, step: 'foodRecovery' }), false)
    assert.equal(task.eligible({}, { work: true, step: 'chestSearch' }), false)
  } finally { site.timeWord = orig }
})

it('fight/shelter body owners pause the clock; recover does not', () => {
  const orig = site.timeWord
  site.timeWord = () => 'day'
  try {
    assert.equal(task.eligible({}, { work: true, step: 'castle', body: { owner: 'fight' } }), false)
    assert.equal(task.eligible({}, { work: true, step: 'shelter' }), false)
    assert.equal(task.eligible({}, { work: true, step: 'castle', body: { owner: 'recover' } }), true)
  } finally { site.timeWord = orig }
})
