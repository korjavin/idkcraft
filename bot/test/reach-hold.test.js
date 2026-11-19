'use strict'

// Prod bot3 2026-11-19: the access build was struck ~4 s after arming
// (a noPath on the next tick -> stage=fast), 85% reach fails.
const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const { Vec3 } = require('vec3')
const castle = require('../src/behaviours/castle')
const reach = require('../src/reach')

const SITE = { x: 100, y: 64, z: 200 }
const quiet = (fn) => { const l = console.log; console.log = () => {}; try { return fn() } finally { console.log = l } }

describe('reach access build hold', () => {
  it('a noPath right after arming keeps the build stage until the hold ends', () => {
    const st = { site: { ...SITE }, rot: 0, blueprintVersion: 3, phase: 'complete', blocked: {} }
    const ctx = { castle: st }
    const cell = { x: SITE.x + 2, y: SITE.y + 12, z: SITE.z + 2, kind: 'air', idx: castle.LITTER_BOX_BASE + 10 }
    const bot = { entity: { position: new Vec3(SITE.x + 4, SITE.y + 6, SITE.z + 2) } }
    let t = 1000
    quiet(() => { for (let i = 0; i < 4 && !(ctx.castleFar && ctx.castleFar.build); i++) castle.far(bot, ctx, st, cell, 4.5, t += 1000) })
    assert.ok(ctx.castleFar.build, 'armed')
    for (let i = 0; i < 10; i++) {
      ctx.castleGoalIdx = cell.idx
      ctx.lastPathStatus = 'noPath'
      assert.equal(quiet(() => castle.far(bot, ctx, st, cell, 4.5, t += 1000)), true)
    }
    assert.equal(ctx.castleFar.dig, undefined, 'still the access build')
    assert.deepEqual(st.blocked, {}, 'no strike')
    t += reach.REACH_HOLD_MS
    ctx.castleGoalIdx = cell.idx
    ctx.lastPathStatus = 'noPath'
    quiet(() => castle.far(bot, ctx, st, cell, 4.5, t))
    assert.ok(ctx.castleFar.dig, 'ladder moves on after the hold')
  })

  it('logs reach summary per how every 10 min', () => {
    const ctx = {}
    const lines = []
    const l = console.log
    console.log = (s) => lines.push(s)
    try {
      reach.arm(ctx, { x: 1, y: 2, z: 3 }, 0)
      reach.done(ctx, { x: 1, y: 2, z: 3 }, 'fail:unreachable', 0)
      reach.done(ctx, { x: 4, y: 5, z: 6 }, 'ok', 1000)
      reach.done(ctx, { x: 4, y: 5, z: 6 }, 'ok', 10 * 60 * 1000)
    } finally { console.log = l }
    const how = process.env.BOT_BODY === 'baritone' ? 'baritone' : 'pillar'
    assert.ok(lines.includes('reach summary ok=2 fail=0 by=walk why=-'), lines.join('\n'))
    assert.ok(lines.includes(`reach summary ok=0 fail=1 by=${how} why=unreachable:1`))
    assert.equal(ctx.reachSummary, null)
  })
})
