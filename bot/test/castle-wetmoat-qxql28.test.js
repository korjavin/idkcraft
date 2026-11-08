'use strict'
// qxql.28: a moat 'dig' cell holding water or lava is a done moat (never touched).
const { it } = require('node:test')
const assert = require('node:assert/strict')
const { matches } = require('../src/castle')

it('moat dig cell: air, water and lava done; solids, bubble column and unknown not', () => {
  assert.equal(matches('dig', 'air'), true)
  assert.equal(matches('dig', 'water'), true)
  assert.equal(matches('dig', 'lava'), true)
  assert.equal(matches('dig', 'bubble_column'), false)
  assert.equal(matches('dig', undefined), false) // unloaded
  assert.equal(matches('dig', 'dirt'), false)
  assert.equal(matches('air', 'water'), false) // keep-clear cells unchanged
  assert.equal(matches('air', 'lava'), false)
})
