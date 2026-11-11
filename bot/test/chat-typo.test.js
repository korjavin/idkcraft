'use strict'
const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const { fixTypo } = require('../src/chat')

describe('chat typo fix', () => {
  it('maps one-edit typos of fixed commands', () => {
    assert.equal(fixTypo('follwo me'), 'follow me') // prod 2026-11-11
    assert.equal(fixTypo('folow me'), 'follow me')
    assert.equal(fixTypo('go wrok'), 'go work')
    assert.equal(fixTypo('come hme'), 'come home')
    assert.equal(fixTypo('go hoke'), 'go home')
  })
  it('leaves exact, short, far or ambiguous lines alone', () => {
    for (const m of ['follow me', 'stpo', 'shrae', 'farm 10', 'hello there', 'flat 20', 'go', 'no work', 'build there', 'do work']) assert.equal(fixTypo(m), m)
  })
})
