'use strict'
const { describe, it } = require('node:test')
const assert = require('node:assert')
const { pickTarget, expedition } = require('../src/behaviours/explore')

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

describe('castle expedition: any kind with a remembered source', () => {
  it('a pane word hunts until sand is remembered; logs do not end it; stone never hunts', () => {
    const items = new Map()
    const ctx = { castleWord: { kind: 'pane' }, resources: { items } }
    assert.strictEqual(expedition(ctx), true)
    items.set('1,60,1', { x: 1, y: 60, z: 1, name: 'oak_log' })
    assert.strictEqual(expedition(ctx), true, 'a log is no pane source')
    items.set('2,60,2', { x: 2, y: 60, z: 2, name: 'sand' })
    assert.strictEqual(expedition(ctx), false)
    assert.strictEqual(expedition({ castleWord: { kind: 'stone' }, resources: { items: new Map() } }), false)
  })
})
