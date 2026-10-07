'use strict'

// Bead idkcraft-vmzq.36: JR-BUILD TIMEOUT — the R3 flora read-through
// (#324) widened siteFor acceptance without guarding the door. Candidate
// dir(-4,+4) (-144,71,-69) accepted at y0=71 with a dirt bump under the
// door plan cell (3,0,0): abs (-141,71,-69) is pristine grass_block with
// short_grass above, so groundY reads 72 while the door hangs at 71.
// The build clears only flora — place refuses, 3 strikes skip the cell,
// the step fails failed:skipped-cells, and gather spins to the 300s
// TIMEOUT. Fix: a fit whose door column reads above y0 is refused.

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const goal = require('../src/goal')

function pos(x, y, z) {
  const p = { x, y, z, distanceTo: (q) => Math.hypot(x - q.x, y - q.y, z - q.z) }
  p.clone = () => pos(p.x, p.y, p.z)
  p.floored = () => pos(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z))
  return p
}

// Fake voxel world: explicit cells plus default terrain (dirt at y<=63,
// air above).
function makeWorld() {
  const cells = new Map()
  const key = (x, y, z) => `${Math.floor(x)},${Math.floor(y)},${Math.floor(z)}`
  return {
    set(x, y, z, name) { cells.set(key(x, y, z), name) },
    get(x, y, z) { return cells.get(key(x, y, z)) },
    blockAt(p) {
      const fx = Math.floor(p.x)
      const fy = Math.floor(p.y)
      const fz = Math.floor(p.z)
      const k = key(fx, fy, fz)
      const name = cells.has(k) ? cells.get(k) : (fy <= 63 ? 'dirt' : 'air')
      return { name, boundingBox: name === 'air' ? 'empty' : 'block', position: { x: fx, y: fy, z: fz } }
    },
  }
}

function mockBot(world) {
  return {
    spawnPoint: pos(0, 64, 0),
    entity: { position: pos(0, 65, 0) },
    blockAt: (p) => world.blockAt(p),
    findBlocks: () => [],
  }
}

describe('vmzq.36 siteFor refuses a door-buried fit', () => {
  it('a dirt bump under the door cell deflects to the next footprint', () => {
    // Footprint 1 is x 6..12, z 0..5; its door column (ox+3, oz+0) is
    // (9,0). The prod shape: solid bump at door level with flora above
    // — read-through still sees the dirt, so the door would hang buried.
    const world = makeWorld()
    world.set(9, 64, 0, 'grass_block')
    world.set(9, 65, 0, 'short_grass')
    const bot = mockBot(world)
    const home = goal.siteFor(bot, pos(0, 64, 0))
    assert.deepEqual(home && home.site, { x: 4, y: 64, z: 4 })
  })

  it('flora over flat dirt at the door cell still founds (R3 meadow kept)', () => {
    // The build digs the flower, so a flat flowery door column reads y0
    // and the first fit still wins — the fix must not overcorrect into
    // refusing meadows.
    const world = makeWorld()
    world.set(9, 64, 0, 'short_grass')
    world.set(8, 64, 2, 'lilac')
    world.set(8, 65, 2, 'lilac')
    const bot = mockBot(world)
    const home = goal.siteFor(bot, pos(0, 64, 0))
    assert.deepEqual(home && home.site, { x: 6, y: 64, z: 0 })
  })
})
