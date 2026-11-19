'use strict'

// Own access/scaffold blocks anywhere in the apron are litter (prod bot3:
// the sweep ran net-flat, access pillars stuck to scaffold never cleared),
// and the sweep logs its net rate.

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const { Vec3 } = require('vec3')
const blueprint = require('../src/castle')
const castle = require('../src/behaviours/castle')

const SITE = { x: 100, y: 64, z: 200 }
const V = 2
const key = (x, y, z) => `${x},${y},${z}`

describe('own-placed litter in the apron', () => {
  it('an own block in a solid cluster far from the ring is litter; a foreign one is not', () => {
    const st = { site: { ...SITE }, rot: 0, blueprintVersion: V, phase: 'complete', blocked: {} }
    const { w, d } = blueprint.siteDimensions(0, V)
    const R = blueprint.apronR(V)
    const x0 = SITE.x - R + 1
    const z0 = SITE.z + 2
    const set = new Map()
    for (let dx = 0; dx < 3; dx++) for (let dz = 0; dz < 3; dz++) for (let dy = 0; dy < 2; dy++) set.set(key(x0 + dx, SITE.y + dy, z0 + dz), 'dirt')
    const bot = {
      blockAt(p) {
        const name = set.get(key(p.x, p.y, p.z)) || (p.y < SITE.y ? 'dirt' : 'air')
        return { name, position: new Vec3(p.x, p.y, p.z), boundingBox: name === 'air' ? 'empty' : 'block' }
      },
    }
    const c = { x: x0 + 1, y: SITE.y + 1, z: z0 + 1 }
    assert.equal(castle.isLitter(bot, {}, st, c.x, c.y, c.z, w, d), false)
    const ctx = { placedByBot: new Set([key(c.x, c.y, c.z)]) }
    assert.equal(castle.isLitter(bot, ctx, st, c.x, c.y, c.z, w, d), true)
  })

  it('litter rate logs removed/added/left every 10 min', () => {
    const logs = []
    const log = console.log
    console.log = (s) => logs.push(String(s))
    const c = {}
    try {
      castle.litterRate(c, [{ x: 1, y: 1, z: 1 }, { x: 2, y: 1, z: 1 }], 0)
      castle.litterRate(c, [{ x: 2, y: 1, z: 1 }, { x: 3, y: 1, z: 1 }], 1000)
      castle.litterRate(c, [{ x: 3, y: 1, z: 1 }], 10 * 60 * 1000)
    } finally { console.log = log }
    assert.deepEqual(logs, ['litter rate removed=2 added=1 left=1'])
  })
})
