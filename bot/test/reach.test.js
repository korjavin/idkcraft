'use strict'

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const reach = require('../src/reach')

describe('reach access window', () => {
  it('lifts place vetoes near the target column only, logs and closes on done', () => {
    const ctx = {}
    const t = { x: -163, y: 80, z: 424 }
    assert.equal(reach.nearTarget(ctx, { x: -163, y: 70, z: 424 }), false, 'no window')
    reach.arm(ctx, t, 1000)
    assert.ok(reach.live(ctx, 2000))
    assert.equal(reach.nearTarget(ctx, { x: -162, y: 68, z: 425 }, 2000), true, 'pillar column beside the target')
    assert.equal(reach.nearTarget(ctx, { x: -166, y: 79, z: 424 }, 2000), true, 'bridge cell 3 out')
    assert.equal(reach.nearTarget(ctx, { x: -150, y: 70, z: 424 }, 2000), false, 'far column')
    assert.equal(reach.nearTarget(ctx, { x: -163, y: 85, z: 424 }, 2000), false, 'above the target')
    assert.equal(reach.live(ctx, 1000 + reach.REACH_BUILD_MS), false, 'window expires')
    const lines = []
    const log = console.log
    console.log = (s) => lines.push(s)
    try { reach.done(ctx, t, 'ok'); reach.done(ctx, { x: 1, y: 2, z: 3 }, 'ok') } finally { console.log = log }
    assert.match(lines[0], /^reach target=-163,80,424 how=(baritone|pillar) result=ok$/)
    assert.equal(lines[1], 'reach target=1,2,3 how=walk result=ok')
    assert.equal(ctx.reachBuild, null)
  })
})
