'use strict'

// idkcraft-g0z.58: castle rig start spot — CASTLE_START site-relative
// pocket, CASTLE_START_CELL seals it in a cobble/planks shell.

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const { startPlan } = require('../tools/castle-replay')

const SITE = { x: 100, y: 64, z: 200 }

describe('castle rig start spot (g0z.58)', () => {
  it('unset is off; the cell needs a start', () => {
    assert.equal(startPlan(SITE, '', ''), null)
    assert.throws(() => startPlan(SITE, '', 'cobble'), /needs CASTLE_START/)
  })

  it('a bare pocket: 1x2 air at site + offset (prod 50,-5,31)', () => {
    const s = startPlan(SITE, '50,-5,31', '')
    assert.deepEqual([s.x, s.y, s.z], [150, 59, 231])
    assert.equal(s.cmd, 'fill 150 59 231 150 60 231 minecraft:air')
  })

  it('a sealed cell: a hollow 3x4x3 shell of the block', () => {
    assert.equal(startPlan(SITE, '0,0,0', 'cobble').cmd, 'fill 99 63 199 101 66 201 minecraft:cobblestone hollow')
    assert.equal(startPlan(SITE, '0,0,0', 'planks').cmd, 'fill 99 63 199 101 66 201 minecraft:oak_planks hollow')
  })

  it('out = past the shell box', () => {
    const s = startPlan(SITE, '0,0,0', 'cobble')
    assert.equal(s.out({ x: 100.5, y: 64, z: 200.5 }), false)
    assert.equal(s.out({ x: 101.9, y: 66.5, z: 199.1 }), false) // on the shell
    assert.equal(s.out({ x: 102.1, y: 64, z: 200.5 }), true)
    assert.equal(s.out({ x: 100.5, y: 67, z: 200.5 }), true)
    assert.equal(s.out({ x: 100.5, y: 62.9, z: 200.5 }), true)
  })

  it('rejects junk', () => {
    assert.throws(() => startPlan(SITE, '1,2', ''), /dx,dy,dz/)
    assert.throws(() => startPlan(SITE, '1,2,x', ''), /dx,dy,dz/)
    assert.throws(() => startPlan(SITE, '1.5,2,3', ''), /dx,dy,dz/)
    assert.throws(() => startPlan(SITE, '1,2,3', 'dirt'), /cobble\|planks/)
  })
})
