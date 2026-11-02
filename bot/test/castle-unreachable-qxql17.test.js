'use strict'

// idkcraft-qxql.17: Castle post-complete roof pacing deadlock on unreachable litter/decor.
// When perched on a roof or ledge, distance oscillations to an unreachable target
// (e.g. in the moat or ground apron) must not reset strikes in far().
// Pathfinder 'noPath' immediately accumulates strikes.
// nextLitter prioritizes candidate cells closest to the bot with vertical weight.
// taskTick/taskLine treat complete castle as finished without false stall or watchdog rounds.

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const { Vec3 } = require('vec3')
const blueprint = require('../src/castle')
const castle = require('../src/behaviours/castle')
const task = require('../src/task')

const SITE = { x: 100, y: 64, z: 200 }
const V = 3
const st3 = (extra) => ({ site: { ...SITE }, rot: 0, blueprintVersion: V, phase: 'complete', blocked: {}, ...extra })

describe('castle unreachable litter/decor deadlock fixes (idkcraft-qxql.17)', () => {
  it('far() does not reset strikes when distance oscillates along a ledge', () => {
    const st = st3()
    const ctx = { castle: st }
    const cell = { x: SITE.x + 2, y: SITE.y, z: SITE.z + 2, kind: 'air', idx: castle.LITTER_BOX_BASE + 10 }
    const now = 1000

    // Simulate bot walking back and forth along a ledge at y = 75 (target y = 64)
    // Distance fluctuates between 22.8 and 22.1 (diff = 0.7 > CELL_PROGRESS 0.5)
    const bot = { entity: { position: new Vec3(SITE.x + 20, SITE.y + 11, SITE.z + 2) } }

    // Tick 1: bot at x = SITE.x + 20 (dist ~21.28)
    let moved = castle.far(bot, ctx, st, cell, 4.5, now)
    assert.equal(moved, true)
    assert.equal(ctx.castleFar.n, 1)

    // Tick 2: bot makes genuine forward progress: x = SITE.x + 18 (dist decreases by ~1.6 > CELL_PROGRESS 1)
    bot.entity.position.x = SITE.x + 18
    moved = castle.far(bot, ctx, st, cell, 4.5, now + 1000)
    assert.equal(moved, true)
    // Forward progress made: n reset to 0, minDist updated
    assert.equal(ctx.castleFar.n, 0)
    const bestDist = ctx.castleFar.minDist

    // Tick 3: bot paces backwards along the ledge: x = SITE.x + 20
    bot.entity.position.x = SITE.x + 20
    moved = castle.far(bot, ctx, st, cell, 4.5, now + 2000)
    assert.equal(moved, true)
    assert.equal(ctx.castleFar.n, 1)

    // Tick 4: bot paces forward again to x = SITE.x + 18.5 (closer than tick 3 by 1.5, but NOT beating bestDist - 1)
    bot.entity.position.x = SITE.x + 18.5
    moved = castle.far(bot, ctx, st, cell, 4.5, now + 3000)
    assert.equal(moved, true)
    // Under old code, 18.5 was < 20 - 1, resetting n to 0!
    // Under qxql.17 monotonic tracking, n increments because it did not beat bestDist - 1.
    assert.equal(ctx.castleFar.n, 2)

    // Tick 5: bot still oscillating at x = SITE.x + 18.2
    bot.entity.position.x = SITE.x + 18.2
    moved = castle.far(bot, ctx, st, cell, 4.5, now + 4000)
    assert.equal(moved, true)
    // Hits STRIKES (3) -> blocked as unreachable!
    assert.ok(st.blocked[`3:${cell.idx}`])
    assert.equal(st.blocked[`3:${cell.idx}`].why, 'unreachable')
    assert.equal(st.blocked[`3:${cell.idx}`].tries, 1)
  })

  it('far() resets minDist baseline when in reach so return walk does not false-strike (revmux minor-1)', () => {
    const st = st3()
    const cell = { x: SITE.x + 2, y: SITE.y, z: SITE.z + 2, kind: 'air', idx: castle.LITTER_BOX_BASE + 15 }
    const ctx = { castle: st }
    const bot = { entity: { position: new Vec3(SITE.x + 2, SITE.y, SITE.z + 2) } } // exactly at cell, dist ~1.6 < 4.5
    const now = 1000

    // Step 1: in-reach tick resets minDist to Infinity
    let moved = castle.far(bot, ctx, st, cell, 4.5, now)
    assert.equal(moved, false, 'in reach')

    // Step 2: bot knocked back or walked away to 12 blocks off
    bot.entity.position.x = SITE.x + 12
    moved = castle.far(bot, ctx, st, cell, 4.5, now + 1000)
    assert.equal(moved, true)
    assert.equal(ctx.castleFar.n, 1)

    // Step 3: bot walks closer to 8 blocks off — forward progress from 12!
    bot.entity.position.x = SITE.x + 8
    moved = castle.far(bot, ctx, st, cell, 4.5, now + 2000)
    assert.equal(moved, true)
    assert.equal(ctx.castleFar.n, 0, 'progress resets strike on walk back')
  })

  it('nextLitter() latches current target across ticks to prevent candidate ping-pong', () => {
    const st = st3()
    const now = 1000
    const c1 = { x: SITE.x + 2, y: SITE.y, z: SITE.z + 2, kind: 'air', idx: castle.LITTER_BOX_BASE + 10 }
    const c2 = { x: SITE.x + 8, y: SITE.y, z: SITE.z + 8, kind: 'air', idx: castle.LITTER_BOX_BASE + 20 }
    const list = [c1, c2]
    const bot = { entity: { position: new Vec3(SITE.x + 8, SITE.y, SITE.z + 8) } } // much closer to c2

    // With castleGoalIdx = c1.idx, c1 stays latched even though c2 is closer
    const ctx = { castleGoalIdx: c1.idx }
    let pick = castle.nextLitter(st, list, now, bot, ctx)
    assert.equal(pick.idx, c1.idx, 'latched current target prevents ping-pong')

    // After far() clears castleGoalIdx = -1 during strike rounds, castleFar maintains the latch
    ctx.castleGoalIdx = -1
    ctx.castleFar = { idx: c1.idx, n: 1 }
    pick = castle.nextLitter(st, list, now, bot, ctx)
    assert.equal(pick.idx, c1.idx, 'castleFar strike maintains latch across far rounds')

    // Without an active goal or castleFar, closest candidate c2 is picked
    const freshPick = castle.nextLitter(st, list, now, bot, { castleGoalIdx: -1, castleFar: null })
    assert.equal(freshPick.idx, c2.idx, 'fresh selection picks closer cell')
  })

  it('nextLitter() prioritizes candidate closest to the body with vertical weighting', () => {
    const st = st3()
    const now = 1000
    // Two open candidates:
    // c1 is earlier in the list, but down at the moat (y = SITE.y - 4 = 60)
    // c2 is later in the list, but on the roof right next to the bot (y = SITE.y + 11 = 75)
    const cMoat = { x: SITE.x + 5, y: SITE.y - 4, z: SITE.z + 5, kind: 'air', idx: castle.LITTER_BOX_BASE + 1 }
    const cRoof = { x: SITE.x + 5, y: SITE.y + 11, z: SITE.z + 6, kind: 'air', idx: castle.LITTER_BOX_BASE + 2 }

    const list = [cMoat, cRoof]
    // Bot standing on roof at y = SITE.y + 11
    const bot = { entity: { position: new Vec3(SITE.x + 5, SITE.y + 11, SITE.z + 5) } }

    const pick = castle.nextLitter(st, list, now, bot)
    assert.equal(pick.idx, cRoof.idx, 'roof litter chosen over deep moat litter')
  })

  it('taskTick & taskLine report complete castle without false stall or watchdog round', () => {
    const st = st3({ status: 'clearing scaffold' })
    const ctx = {
      castle: st,
      task: {
        active: 'castle',
        castle: { done: 2024, total: 2048, stallMs: 60000, wd: { rounds: 3 } },
      },
    }
    const bot = {}
    const now = 50000

    task.taskTick(bot, ctx)

    // Complete castle should not accrue stallMs or watchdog rounds
    assert.equal(ctx.task.castle.stallMs, 0)
    assert.equal(ctx.task.castle.wd.rounds, 0)

    const line = task.taskLine(ctx)
    assert.equal(line, 'task castle complete (2024/2048, clearing scaffold)')
  })
})
