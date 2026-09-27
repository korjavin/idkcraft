'use strict'

// Danger memory (idkcraft-mnx/idkcraft-h13): gave-up spots that explore and
// gather avoid. First dedicated test file — previously covered only
// incidentally through explore/gather tests.

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const danger = require('../src/danger')

describe('danger spots', () => {
  it('mark then near: inside the radius hits, outside misses', () => {
    const ctx = {}
    assert.equal(danger.mark(ctx, { x: 10, y: 64, z: 0 }, 1000), 1)
    assert.equal(danger.count(ctx), 1)
    assert.equal(danger.near(ctx, { x: 12, y: 64, z: 0 }, 6, 1000), true)
    assert.equal(danger.near(ctx, { x: 100, y: 64, z: 100 }, 6, 1000), false)
  })

  it('distance is xz-only: level never matches the mark exactly', () => {
    const ctx = {}
    danger.mark(ctx, { x: 10, y: 60, z: 0 }, 1000)
    assert.equal(danger.near(ctx, { x: 10, y: 80, z: 0 }, 6, 1000), true)
  })

  it('default radius is AVOID_RADIUS, boundary inclusive', () => {
    const ctx = {}
    danger.mark(ctx, { x: 0, y: 64, z: 0 }, 1000)
    assert.equal(danger.near(ctx, { x: 6, y: 64, z: 0 }, undefined, 1000), true)
    assert.equal(danger.near(ctx, { x: 6.1, y: 64, z: 0 }, undefined, 1000), false)
    assert.equal(danger.AVOID_RADIUS, 6)
    assert.equal(danger.near(ctx, { x: 10, y: 64, z: 0 }, 10, 1000), true)
  })

  it('re-mark refreshes the timestamp instead of doubling', () => {
    const ctx = {}
    danger.mark(ctx, { x: 10, y: 64, z: 0 }, 1000)
    assert.equal(danger.mark(ctx, { x: 10.5, y: 65, z: 0 }, 2000), 1)
    assert.equal(danger.count(ctx), 1)
    // Without the refresh the mark would be stale at 1000 + TTL + 1.
    assert.equal(danger.near(ctx, { x: 10, y: 64, z: 0 }, 6, 1000 + danger.TTL_MS + 1), true)
  })

  it('re-mark far in y adds a separate spot', () => {
    const ctx = {}
    danger.mark(ctx, { x: 10, y: 64, z: 0 }, 1000)
    assert.equal(danger.mark(ctx, { x: 10, y: 70, z: 0 }, 1000), 2)
  })

  it('stale marks neither match nor survive prune', () => {
    const ctx = {}
    danger.mark(ctx, { x: 10, y: 64, z: 0 }, 1000)
    assert.equal(danger.near(ctx, { x: 10, y: 64, z: 0 }, 6, 1000 + danger.TTL_MS + 1), false)
    assert.equal(danger.near(ctx, { x: 10, y: 64, z: 0 }, 6, 1000 + danger.TTL_MS), true)
    assert.equal(danger.prune(ctx, 1000 + danger.TTL_MS + 1), 1)
    assert.equal(danger.count(ctx), 0)
  })

  it('store caps at MAX_SPOTS, oldest out', () => {
    const ctx = {}
    for (let i = 0; i < danger.MAX_SPOTS + 10; i++) {
      danger.mark(ctx, { x: i * 10, y: 64, z: 0 }, 1000 + i)
    }
    assert.equal(danger.count(ctx), danger.MAX_SPOTS)
    assert.equal(danger.near(ctx, { x: 0, y: 64, z: 0 }, 6, 2000), false, 'oldest evicted')
    assert.equal(danger.near(ctx, { x: (danger.MAX_SPOTS + 9) * 10, y: 64, z: 0 }, 6, 2000), true)
  })

  it('clear empties the store', () => {
    const ctx = {}
    danger.mark(ctx, { x: 10, y: 64, z: 0 }, 1000)
    danger.mark(ctx, { x: 30, y: 64, z: 0 }, 1000)
    danger.clear(ctx)
    assert.equal(danger.count(ctx), 0)
    assert.equal(danger.near(ctx, { x: 10, y: 64, z: 0 }, 6, 1000), false)
  })

  it('never throws on corrupt input', () => {
    assert.equal(danger.mark(null, { x: 1, z: 1 }), 0)
    assert.equal(danger.mark({}, null), 0)
    assert.equal(danger.mark({}, { x: 'a', z: 1 }), 0)
    assert.equal(danger.mark({}, { x: 1 }), 0)
    assert.equal(danger.near(null, { x: 1, z: 1 }), false)
    assert.equal(danger.near({}, null), false)
    assert.equal(danger.near({}, { x: 1 }), false)
    assert.equal(danger.near({ danger: { spots: {} } }, { x: 1, z: 1 }), false)
    assert.equal(danger.prune(null), 0)
    assert.equal(danger.prune({}), 0)
    assert.equal(danger.count(null), 0)
    danger.clear(null)
    danger.clear({})
    // A non-array spots store is rebuilt, not trusted.
    const ctx = { danger: { spots: 'x' } }
    assert.equal(danger.mark(ctx, { x: 1, y: 64, z: 1 }, 1000), 1)
    assert.equal(danger.near(ctx, { x: 1, y: 64, z: 1 }, 6, 1000), true)
  })
})

describe('danger spots (rw4.12)', () => {
  it('lists live marks for planning, stale ones filtered', () => {
    const ctx = {}
    danger.mark(ctx, { x: 10, y: 60, z: 0 }, 1000)
    danger.mark(ctx, { x: 50, y: 64, z: 0 }, 1000 + danger.TTL_MS)
    const live = danger.spots(ctx, 1000 + danger.TTL_MS + 1) // boundary inclusive, like near()
    assert.deepEqual(live, [{ x: 50, y: 64, z: 0 }])
  })

  it('empty store means no spots, never throws', () => {
    assert.deepEqual(danger.spots({}), [])
    assert.deepEqual(danger.spots(null), [])
  })

  it('returns copies: planning cannot corrupt the memory', () => {
    const ctx = {}
    danger.mark(ctx, { x: 10, y: 60, z: 0 }, 1000)
    danger.spots(ctx, 1000)[0].x = 999
    assert.equal(danger.near(ctx, { x: 10, y: 60, z: 0 }, 6, 1000), true)
  })
})
