'use strict'

// idkcraft-pr98: the rw4.19 re-open (clear cell inside a finished house)
// flips home.built false, and the neuc.65.3 homeless-night clause then read
// the standing house as homeless — shelter dug in outside instead of build
// digging the bump and stay sleeping in the bed (HOUSE-BUMP TIMEOUT).

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const goal = require('../src/goal')
const buildMod = require('../src/behaviours/build')

const SITE = { x: 97, y: 71, z: -357 }
const FSH = goal.MENU.shelter.feasible
const facts = (time) => ({ time, home: 'site', inside: 'no' })
const bot = { entity: { position: { x: 100.5, y: 71, z: -370.5 } } }
const ctx = () => ({ home: { site: { ...SITE }, built: false, v: 2 }, castle: null, step: 'gather', stepStatus: 'done' })

function withComplete(v, fn) {
  // Fake of isComplete (bot/src/behaviours/build.js:317): true when every
  // wall/roof/door/table cell stands (clear cells never count).
  const orig = buildMod.isComplete
  buildMod.isComplete = () => v
  try { return fn() } finally { buildMod.isComplete = orig }
}

describe('pr98 a re-opened standing house is not homeless', () => {
  it('standing house re-opened: no homeless shelter at dusk/night', () => {
    for (const t of ['dusk', 'night']) assert.equal(withComplete(true, () => FSH(facts(t), bot, ctx())), false, t)
  })
  it('unfinished site: the neuc.65.3 homeless shelter still fits', () => {
    for (const t of ['dusk', 'night']) assert.equal(withComplete(false, () => FSH(facts(t), bot, ctx())), true, t)
  })
})
