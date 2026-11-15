'use strict'
const { describe, it } = require('node:test')
const assert = require('node:assert')
const { pickTarget } = require('../src/behaviours/explore')

const chunkOf = (x, z) => `${Math.floor(x / 16)},${Math.floor(z / 16)}`

describe('wood expedition: one ray outward to 400', () => {
  it('walks only the chosen ray, ring after ring, out to 384', () => {
    const visited = new Set()
    const seen = []
    for (let t; (t = pickTarget(visited, { x: 0, z: 0 }, 400, null, 2));) {
      seen.push(t)
      visited.add(chunkOf(t.x, t.z))
    }
    assert.deepStrictEqual(seen.map((t) => t.x), [16, 32, 64, 128, 192, 256, 320, 384])
    assert.ok(seen.every((t) => t.z === 0), 'ray 2 is due east')
  })
})
