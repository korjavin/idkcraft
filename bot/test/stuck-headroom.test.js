'use strict'

// Bead 4rz round 4: the headroom verify-and-step must re-check the last
// tp's landing (steps+1 checks for steps tps) — otherwise a spot the
// last step cleared is falsely reported GUIDE-BURIED and dropped.

process.env.REPLAY_QUIET = '0' // keep the script's ticker-chatter filter off
const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const { verifyHeadroom } = require('../tools/stuck-replay')

const SOLID = { boundingBox: 'block' }
const CLEAR = { boundingBox: 'empty' }

// heads[i] is what readHead() returns on check i (last repeats); tpUp
// just counts, no sleeping.
function rig(heads, alive = () => true) {
  let checks = 0
  const stats = { checks: 0, tps: 0 }
  return {
    readHead: () => heads[Math.min(checks++, heads.length - 1)],
    tpUp: async () => { stats.tps++ },
    alive,
    stats: () => { stats.checks = checks; return stats },
  }
}

describe('stuck-replay verifyHeadroom (idkcraft-4rz)', () => {
  it('clear on first check tps zero times', async () => {
    const r = rig([CLEAR])
    const res = await verifyHeadroom(r.readHead, r.tpUp, r.alive)
    assert.equal(res.buried, false)
    assert.equal(res.tps, 0)
    assert.equal(r.stats().checks, 1)
  })

  it('landing cleared by the last tp is re-checked, not buried', async () => {
    const r = rig([SOLID, SOLID, SOLID, SOLID, SOLID, SOLID, CLEAR])
    const res = await verifyHeadroom(r.readHead, r.tpUp, r.alive)
    assert.equal(res.buried, false)
    assert.equal(res.tps, 6)
    assert.equal(r.stats().checks, 7)
  })

  it('never clearing buries after exactly 6 tps', async () => {
    const r = rig([SOLID])
    const res = await verifyHeadroom(r.readHead, r.tpUp, r.alive)
    assert.equal(res.buried, true)
    assert.equal(res.tps, 6)
    assert.equal(r.stats().checks, 7)
  })

  it('unreadable (null) head counts as solid', async () => {
    const r = rig([null])
    const res = await verifyHeadroom(r.readHead, r.tpUp, r.alive)
    assert.equal(res.buried, true)
    assert.equal(res.tps, 6)
  })

  it('guide death cuts the climb short', async () => {
    let n = 0
    const r = rig([SOLID], () => n++ < 2)
    const res = await verifyHeadroom(r.readHead, r.tpUp, r.alive)
    assert.equal(res.buried, true)
    assert.equal(res.tps, 2)
  })

  it('honours a custom step count', async () => {
    const r = rig([SOLID, SOLID, CLEAR])
    const res = await verifyHeadroom(r.readHead, r.tpUp, r.alive, 2)
    assert.equal(res.buried, false)
    assert.equal(res.tps, 2)
    assert.equal(r.stats().checks, 3)
  })
})
