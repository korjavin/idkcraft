'use strict'

// High litter (prod bot3: 1020 litter, high scaffold retired on fast strikes
// with no ladder ever tried): the strike that would retire a litter cell
// takes the dig/step ladder instead of the fast yield.

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const { Vec3 } = require('vec3')
const castle = require('../src/behaviours/castle')

const { bkey } = castle.RECOVERY_HOOKS
const { REACH_HOLD_MS } = require('../src/reach')

describe('castle litter last try takes the ladder', () => {
  it('fast strikes until the last try, then dig-approach', () => {
    const st = { site: { x: 100, y: 64, z: 200 }, rot: 0, blueprintVersion: 2, phase: 'complete', blocked: {} }
    const lit = (n) => ({ x: 100, y: 80, z: 190 + n, kind: 'air', idx: castle.LITTER_BOX_BASE + n })
    const bot = { entity: { position: new Vec3(100, 64, 180) } }
    const a = lit(0), b = lit(1)
    const k = bkey(st, a.idx)
    let ctx = null
    const run = () => {
      ctx = { castleLitter: { pend: [a, b] } }
      let t = Date.now()
      for (let i = 0; i < 20 && !(ctx.castleFar && ctx.castleFar.dig) && !(st.blocked[k] && st.blocked[k].until); i++) castle.far(bot, ctx, st, a, 4, t += REACH_HOLD_MS / 4)
    }
    run()
    assert.equal(st.blocked[k].tries, 1, 'first strike is fast')
    st.blocked[k].tries = 2
    st.blocked[k].until = 0
    run()
    assert.ok(ctx.castleFar && ctx.castleFar.dig, 'last try runs the dig ladder')
    assert.equal(st.blocked[k].tries, 2)
  })
  it('a noPath verdict on the cell strikes on the same tick', () => {
    const st = { site: { x: 100, y: 64, z: 200 }, rot: 0, blueprintVersion: 2, phase: 'complete', blocked: {} }
    const lit = (n) => ({ x: 100, y: 80, z: 190 + n, kind: 'air', idx: castle.LITTER_BOX_BASE + n })
    const bot = { entity: { position: new Vec3(100, 64, 180) } }
    const a = lit(0), b = lit(1)
    const ctx = { castleLitter: { pend: [a, b] }, castleGoalIdx: a.idx, lastPathStatus: 'noPath' }
    castle.far(bot, ctx, st, a, 4, Date.now())
    assert.ok(ctx.castleFar.build && ctx.reachBuild, 'first noPath arms the access build (reach.js)')
    assert.equal(st.blocked[bkey(st, a.idx)], undefined)
    assert.equal(ctx.lastPathStatus, null, 'stale no-place verdict dropped')
    ctx.castleGoalIdx = a.idx
    ctx.lastPathStatus = 'noPath' // a stale/stall noPath right after arming (prod bot3 2026-11-19)
    castle.far(bot, ctx, st, a, 4, Date.now())
    assert.equal(st.blocked[bkey(st, a.idx)], undefined, 'the access build holds')
    ctx.castleGoalIdx = a.idx
    ctx.lastPathStatus = 'noPath' // Baritone found no path even with placing on
    castle.far(bot, ctx, st, a, 4, Date.now() + REACH_HOLD_MS)
    assert.equal(st.blocked[bkey(st, a.idx)].tries, 1, 'struck on the first noPath tick after the hold')
  })
})
