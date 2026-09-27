'use strict'

// Detour waypoints (idkcraft-rw4.12): gohome/forage route around live
// danger marks instead of walking the pit straight. Pure geometry over
// danger.spots: null means go direct (no marks, target/feet inside a
// mark, segment misses every disc, no valid side).

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const danger = require('../src/danger')
const detour = require('../src/detour')

const T0 = 1000
function marked(spots, now = T0) {
  const ctx = {}
  for (const s of spots) danger.mark(ctx, { x: s[0], y: s[1], z: s[2] }, now)
  return ctx
}

describe('detour.via', () => {
  it('null with no marks: straight as today', () => {
    assert.equal(detour.via({}, { x: 0, y: 64, z: 0 }, { x: 40, y: 64, z: 0 }, T0), null)
  })

  it('null when the segment misses every disc', () => {
    const ctx = marked([[20, 60, 20]])
    assert.equal(detour.via(ctx, { x: 0, y: 64, z: 0 }, { x: 40, y: 64, z: 0 }, T0), null)
  })

  it('null for stale marks: TTL still applies', () => {
    const ctx = marked([[20, 60, 0]])
    assert.equal(detour.via(ctx, { x: 0, y: 64, z: 0 }, { x: 40, y: 64, z: 0 }, T0 + danger.TTL_MS + 1), null)
  })

  it('null when the target sits inside a mark: stall/strike owns it', () => {
    const ctx = marked([[38, 60, 0]])
    assert.equal(detour.via(ctx, { x: 0, y: 64, z: 0 }, { x: 40, y: 64, z: 0 }, T0), null)
  })

  it('null when the bot stands inside a mark: recover owns the pit', () => {
    const ctx = marked([[2, 60, 0]])
    assert.equal(detour.via(ctx, { x: 0, y: 64, z: 0 }, { x: 40, y: 64, z: 0 }, T0), null)
  })

  it('mid-segment pit diverts perpendicular, radius + margin out', () => {
    const ctx = marked([[20, 60, 0]])
    assert.deepEqual(detour.via(ctx, { x: 0, y: 64, z: 0 }, { x: 40, y: 64, z: 0 }, T0),
      { x: 20, y: 64, z: 8 })
  })

  it('off-centre pit picks the shorter side', () => {
    const ctx = marked([[20, 60, 2]])
    assert.deepEqual(detour.via(ctx, { x: 0, y: 64, z: 0 }, { x: 40, y: 64, z: 0 }, T0),
      { x: 20, y: 64, z: -6 })
  })

  it('first pit along the path wins, not the nearest to the bot', () => {
    // (30,0) is nearer the bot at x=40 walking to x=0... both intersect;
    // the x=30 disc is met first, so the waypoint hangs off it.
    const ctx = marked([[10, 60, 0], [30, 60, 0]])
    const v = detour.via(ctx, { x: 40, y: 64, z: 0 }, { x: 0, y: 64, z: 0 }, T0)
    assert.deepEqual(v, { x: 30, y: 64, z: -8 })
  })

  it('a side inside another mark is rejected, the free side stands', () => {
    const ctx = marked([[20, 60, 0], [20, 60, 8]])
    assert.deepEqual(detour.via(ctx, { x: 0, y: 64, z: 0 }, { x: 40, y: 64, z: 0 }, T0),
      { x: 20, y: 64, z: -8 })
  })

  it('both sides marked means no waypoint: direct with the fallback', () => {
    const ctx = marked([[20, 60, 0], [20, 60, 8], [20, 60, -8]])
    assert.equal(detour.via(ctx, { x: 0, y: 64, z: 0 }, { x: 40, y: 64, z: 0 }, T0), null)
  })

  it('never throws on junk: null in, null out', () => {
    assert.equal(detour.via(null, null, null), null)
    assert.equal(detour.via({}, {}, {}), null)
    assert.equal(detour.via({}, { x: 0, y: 64, z: 0 }, { x: 0, y: 64, z: 0 }, T0), null)
  })
})
