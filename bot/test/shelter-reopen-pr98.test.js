'use strict'

// idkcraft-pr98: the rw4.19 re-open (clear cell inside a finished house)
// flips home.built false, and the neuc.65.3 homeless-night clause then read
// the standing house as homeless — shelter dug in outside instead of build
// digging the bump and stay sleeping in the bed (HOUSE-BUMP TIMEOUT).
// revmux 01: only a build that can take the night waives the shelter.

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const goal = require('../src/goal')
const buildMod = require('../src/behaviours/build')

const SITE = { x: 97, y: 71, z: -357 }
const FSH = goal.MENU.shelter.feasible
const facts = (time, health = 20) => ({ time, home: 'site', inside: 'no', health })
const bot = { entity: { position: { x: 100.5, y: 71, z: -370.5 } } }
const ctx = (extra) => ({ home: { site: { ...SITE }, built: false, v: 2 }, castle: null, step: 'gather', stepStatus: 'done', ...extra })

function stub(obj, key, fn, body) {
  const orig = obj[key]
  obj[key] = fn
  try { return body() } finally { obj[key] = orig }
}
// Fake of isComplete (bot/src/behaviours/build.js:317): true when every
// wall/roof/door/table cell stands (clear cells never count).
const complete = (v, body) => stub(buildMod, 'isComplete', () => v, body)
// Fake of MENU.build.feasible (bot/src/goal.js:185): build can take the tick.
const buildOk = (v, body) => stub(goal.MENU.build, 'feasible', () => v, body)

describe('pr98 a re-opened standing house is not homeless', () => {
  it('standing house, build feasible: no homeless shelter at dusk/night', () => {
    for (const t of ['dusk', 'night']) assert.equal(complete(true, () => buildOk(true, () => FSH(facts(t), bot, ctx()))), false, t)
  })
  it('unfinished site: the neuc.65.3 homeless shelter still fits', () => {
    for (const t of ['dusk', 'night']) assert.equal(complete(false, () => buildOk(true, () => FSH(facts(t), bot, ctx()))), true, t)
  })
  it('standing house but build held or hurt (real build gate): shelter still fits', () => {
    // Fakes of build.js cellDone (:291: every cell but the clear bump stands),
    // cellLoaded (:283) and nextCellIdx (:339: build's pick = the bump), so the
    // real MENU.build.feasible passes with no veto (the control below).
    const plan = buildMod.blueprintFor(ctx().home)
    const bump = plan.findIndex((c) => c.kind === 'clear')
    const real = (body) => stub(buildMod, 'cellDone', (b, h, c) => c.kind !== 'clear', () =>
      stub(buildMod, 'cellLoaded', () => true, () => stub(buildMod, 'nextCellIdx', () => bump, () => complete(true, body))))
    assert.equal(real(() => FSH(facts('night'), bot, ctx())), false, 'control: build takes the night')
    const held = ctx({ stepFail: { build: { status: 'failed:cannot-reach-site', at: Date.now() } } })
    assert.equal(real(() => FSH(facts('night'), bot, held)), true, 'buildHeld')
    assert.equal(real(() => FSH(facts('night', 3), bot, ctx())), true, 'nightHurt')
  })
  it('a shelter already running keeps the night (no mid-night climb-out on a hold flip)', () => {
    assert.equal(complete(true, () => buildOk(true, () => FSH(facts('night'), bot, ctx({ step: 'shelter' })))), true)
  })
})
