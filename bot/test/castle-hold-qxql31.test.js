'use strict'

// idkcraft-qxql.31: prod 2026-11-09 bot2 flapped castle<->rest every 1-3 s.
// The builder failed:build-stall on a text with castle=clear (the stall
// retired its 3 cells, so a cell recovery was startable); that hold then
// dropped castle from every castle=clear menu, so the recovery never ran.
const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const goal = require('../src/goal')

const text = (w) => `time=day logs=none castle=${w} health=ok`
const bot = { entity: { position: { x: 218, y: 70, z: -39 } } }
const hold = (status, w) => ({ stepFail: { castle: { status, text: text(w), pos: { x: 218, y: 70, z: -39 }, at: Date.now() } } })

describe('castle hold after a build-stall (qxql.31)', () => {
  it('a build-stall does not hold the clear word (the recovery it advertises may start)', () => {
    assert.equal(goal.failHolds(hold('failed:build-stall', 'clear'), 'castle', text('clear'), bot), false)
  })
  it('other castle failures on the same text still hold', () => {
    assert.equal(goal.failHolds(hold('failed:no-path', 'clear'), 'castle', text('clear'), bot), true)
    assert.equal(goal.failHolds(hold('failed:build-stall', 'planks-batch'), 'castle', text('planks-batch'), bot), true)
  })
})

describe('castle hold ignores the player near/far flip (qxql.31b)', () => {
  const t = (p) => `time=day castle=planks-batch player=${p} health=ok`
  const h = { stepFail: { castle: { status: 'failed:build-stall', text: t('near'), pos: { x: 218, y: 70, z: -39 }, at: Date.now() } } }
  it('holds on the same facts whatever the player word', () => {
    assert.equal(goal.failHolds(h, 'castle', t('near'), bot), true)
    assert.equal(goal.failHolds(h, 'castle', t('far'), bot), true)
  })
  it('other steps still release on a player change', () => {
    const d = { stepFail: { deliver: { status: 'failed:x', text: t('far'), at: Date.now() } } }
    assert.equal(goal.failHolds(d, 'deliver', t('near'), bot), false)
  })
})
