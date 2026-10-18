'use strict'

// idkcraft-neuc.65.6.2: siteFor must not found on a 1-block crust over a
// void (prod v2 house -88 88 -3 sat over a y 80-86 hollow; the doorstep
// and floor later fell through). Every footprint column and the doorstep
// row need 3 solid blocks under the ground; a hollow site moves on to the
// next SITE_DIRS entry like the relief refusal.

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const { siteFor, solidBelow } = require('../src/site')

// Flat meadow: grass at y=63 over dirt, air above. `hollow` cells are
// air (cave under the crust).
function world(hollow = new Set()) {
  return {
    blockAt(p) {
      const x = Math.floor(p.x), y = Math.floor(p.y), z = Math.floor(p.z)
      const name = hollow.has(`${x},${y},${z}`) ? 'cave_air' : y === 63 ? 'grass_block' : y < 63 ? 'dirt' : 'air'
      return { name, position: { x, y, z } }
    },
  }
}
// A 1-block crust: the two blocks under the ground block are air.
function crust(set, x, z) { set.add(`${x},62,${z}`); set.add(`${x},61,${z}`) }

const AROUND = { x: 0, y: 64, z: 0 }
// The first SITE_DIRS entry is [6, 0]: origin (6, 64, 0).

describe('neuc.65.6.2 siteFor refuses a crust over a void', () => {
  it('accepts a flat site with 3 solid blocks under every column', () => {
    const home = siteFor(world(), AROUND)
    assert.deepEqual(home.site, { x: 6, y: 64, z: 0 })
  })

  it('refuses a crust under one footprint column and tries the next direction', () => {
    const h = new Set()
    crust(h, 6 + 4, 0 + 3) // one interior column
    const home = siteFor(world(h), AROUND)
    assert.ok(home, 'the next direction is founded')
    assert.notDeepEqual(home.site, { x: 6, y: 64, z: 0 })
    assert.deepEqual(home.site, { x: 4, y: 64, z: 4 }, 'SITE_DIRS[1]')
  })

  it('refuses a crust under the doorstep only', () => {
    const h = new Set()
    crust(h, 6 + 3, 0 - 1) // outsidePos of the first candidate
    const home = siteFor(world(h), AROUND)
    assert.deepEqual(home.site, { x: 4, y: 64, z: 4 })
  })

  it('a void 3 down still counts as solid (n = 3 blocks)', () => {
    const h = new Set([`${6 + 4},60,${3}`]) // y 63, 62, 61 solid; 60 air
    assert.deepEqual(siteFor(world(h), AROUND).site, { x: 6, y: 64, z: 0 })
  })

  it('solidBelow refuses liquid and unloaded cells', () => {
    const water = { blockAt: (p) => ({ name: Math.floor(p.y) === 62 ? 'water' : 'dirt' }) }
    assert.equal(solidBelow(water, 0, 0, 64, 3), false)
    const unloaded = { blockAt: () => { throw new Error('unloaded') } }
    assert.equal(solidBelow(unloaded, 0, 0, 64, 3), false)
    assert.equal(solidBelow({ blockAt: () => null }, 0, 0, 64, 3), false)
    assert.equal(solidBelow(world(), 0, 0, 64, 3), true)
  })
})
