'use strict'

// Stuck state machine (idkcraft-6x7.2): the single body-stuck detector.
// Asserts on STATE (verdict/update transitions), not on log lines — except
// the raise-line formats, which are pinned byte-identical here (moved from
// the old per-behaviour detectors).

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const { goals } = require('mineflayer-pathfinder')
const stuck = require('../src/stuck')
const recover = require('../src/behaviours/recover')

function pos(x, y, z) {
  const p = {
    x, y, z,
    distanceTo: (q) => Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z),
    clone() { return pos(p.x, p.y, p.z) },
    floored() { return pos(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)) },
    offset(ox, oy, oz) { return pos(p.x + ox, p.y + oy, p.z + oz) },
  }
  return p
}

function mockBot({ at = [0, 64, 0], moving = false, goal = null, blocks = null } = {}) {
  const bot = {
    username: 'IdkBot',
    players: {},
    entities: {},
    entity: { position: pos(at[0], at[1], at[2]), onGround: true },
    _moving: moving,
    pathfinder: {
      goal,
      setGoal(g) { bot.pathfinder.goal = g || null },
      stop() {},
      isMoving: () => bot._moving,
    },
    blockAt: blocks
      ? (p) => {
        if (!p || typeof p.floored !== 'function') throw new Error('pos.floored is not a function')
        const f = p.floored()
        const n = blocks[`${f.x},${f.y},${f.z}`]
        return n ? { name: n } : null
      }
      : () => null,
  }
  return bot
}

function followGoal(target) {
  return new goals.GoalFollow(target, 3)
}

function capture() {
  const lines = []
  const orig = console.log
  console.log = (m) => { lines.push(String(m)) }
  return { lines, release() { console.log = orig } }
}

describe('stuck verdict', () => {
  it('defaults to a healthy MOVING view on an empty ctx', () => {
    assert.deepEqual(stuck.verdict({}), {
      state: 'MOVING', stills: 0, resets: 0, placeErrors: 0, episode: false, latched: false,
    })
  })

  it('mirrors counters, fact, episode and latch read-only', () => {
    const v = stuck.verdict({
      stuckState: 'SUSPECT', stuckTicks: 12, stuckResets: 1, placeErrors: 2,
      stuck: { by: 'follow' }, recoverLatch: { by: 'follow', key: 'follow:P' },
    })
    assert.deepEqual(v, {
      state: 'SUSPECT', stills: 12, resets: 1, placeErrors: 2, episode: true, latched: true,
    })
  })

  it('a running episode reads as episode even without the fact', () => {
    assert.equal(stuck.verdict({ stuckState: 'RECOVERING', recovery: { action: 'wait' } }).episode, true)
  })
})

describe('stuck update: sampling', () => {
  it('the anchor tick samples position, never counts', () => {
    const bot = mockBot({ moving: true })
    const ctx = { lastGoalKey: 'follow:P', stuckTicks: 29 } // seeded streak survives the anchor
    stuck.update(bot, ctx)
    assert.deepEqual(ctx.lastPos, { x: 0, y: 64, z: 0 })
    assert.equal(ctx.stuckTicks, 29)
    assert.equal(ctx.stuckState, 'MOVING')
    assert.equal(ctx.stuck || null, null)
  })

  it('still ticks with a driving executor count SUSPECT toward the slow entry', () => {
    const bot = mockBot({ moving: true })
    const ctx = { lastGoalKey: 'build:x', lastPos: { x: 0, y: 64, z: 0 } }
    for (let i = 0; i < 10; i++) stuck.update(bot, ctx)
    assert.equal(ctx.stuckTicks, 10)
    assert.equal(stuck.verdict(ctx).state, 'SUSPECT')
    assert.equal(ctx.stuck || null, null)
  })

  it('displacement zeroes every counter and returns to MOVING', () => {
    const bot = mockBot({ moving: true })
    const ctx = {
      lastGoalKey: 'follow:P', lastPos: { x: 0, y: 64, z: 0 },
      stuckTicks: 20, stuckResets: 1, placeErrors: 2, stuckState: 'SUSPECT',
    }
    bot.entity.position = pos(3, 64, 0) // one real step
    stuck.update(bot, ctx)
    assert.equal(ctx.stuckTicks, 0)
    assert.equal(ctx.stuckResets, 0)
    assert.equal(ctx.placeErrors, 0)
    assert.equal(ctx.stuckState, 'MOVING')
  })

  it('a sub-tolerance shuffle still counts (0.5 block tolerance)', () => {
    const bot = mockBot({ moving: true })
    const ctx = { lastGoalKey: 'build:x', lastPos: { x: 0, y: 64, z: 0 } }
    bot.entity.position = pos(0.4, 64, 0)
    stuck.update(bot, ctx)
    assert.equal(ctx.stuckTicks, 1)
    assert.equal(ctx.stuckState, 'SUSPECT')
  })

  it('slow movement accumulates from the progress anchor (core-2)', () => {
    // Water/soul-sand pace (0.4/tick) is real movement: the anchor holds on
    // still ticks, so the second shuffle trips the tolerance from the same
    // point. Per-tick re-anchoring would read still forever and wedge.
    const bot = mockBot({ moving: true })
    const ctx = { lastGoalKey: 'follow:P', lastPos: { x: 0, y: 64, z: 0 } }
    bot.entity.position = pos(0.4, 64, 0)
    stuck.update(bot, ctx)
    assert.equal(ctx.stuckTicks, 1)
    assert.deepEqual(ctx.lastPos, { x: 0, y: 64, z: 0 }, 'anchor holds on still ticks')
    bot.entity.position = pos(0.8, 64, 0)
    stuck.update(bot, ctx)
    assert.equal(ctx.stuckTicks, 0, 'cumulative 0.8 clears the streak')
    assert.equal(ctx.stuckState, 'MOVING')
    assert.deepEqual(ctx.lastPos, { x: 0.8, y: 64, z: 0 }, 'anchor moves on progress')
  })

  it('a grounded level change is progress, tower jumps are still (core-2)', () => {
    // Towering lands grounded at a new level: progress, streaks clear (was:
    // horizontal-only sampling fast-entered a wedge mid-climb on the tower
    // place_error streaks).
    const bot = mockBot({ moving: true })
    const ctx = { lastGoalKey: 'follow:P', lastPos: { x: 0, y: 64, z: 0 }, stuckTicks: 5, placeErrors: 3 }
    bot.entity.position = pos(0, 65, 0)
    bot.entity.onGround = true
    stuck.update(bot, ctx)
    assert.equal(ctx.stuckTicks, 0)
    assert.equal(ctx.placeErrors, 0)
    // Jumping in place: the apex is airborne (ignored) and the landing
    // returns to the anchor level — still counts.
    const ctx2 = { lastGoalKey: 'follow:P', lastPos: { x: 0, y: 64, z: 0 } }
    bot.entity.position = pos(0, 65.2, 0)
    bot.entity.onGround = false
    stuck.update(bot, ctx2)
    bot.entity.position = pos(0, 64, 0)
    bot.entity.onGround = true
    stuck.update(bot, ctx2)
    assert.equal(ctx2.stuckTicks, 2)
    assert.equal(ctx2.stuckState, 'SUSPECT')
  })

  it('a non-numeric body never samples (no count, no raise)', () => {
    const bot = mockBot({ moving: true })
    bot.entity.position = { x: '0', y: 64, z: 0 }
    const ctx = { lastGoalKey: 'follow:P', lastPos: { x: 0, y: 64, z: 0 }, stuckTicks: 29, stuckResets: 2 }
    stuck.update(bot, ctx)
    assert.equal(ctx.stuckTicks, 29)
    assert.equal(ctx.stuck || null, null)
  })

  it('paused ticks never sample', () => {
    const bot = mockBot({ moving: true })
    const ctx = { paused: true, lastGoalKey: 'follow:P', stuckTicks: 29 }
    stuck.update(bot, ctx)
    assert.equal(ctx.lastPos || null, null)
    assert.equal(ctx.stuckTicks, 29)
  })
})

describe('stuck update: slow entry', () => {
  it('thirty still ticks raise by=no-displacement on an unowned key', () => {
    const target = { username: 'P', id: 7, position: pos(10, 64, 0) }
    const bot = mockBot({ moving: true, goal: followGoal(target) })
    const ctx = { lastGoalKey: 'fight:1', lastPos: { x: 0, y: 64, z: 0 } }
    const cap = capture()
    try {
      for (let i = 0; i < 30; i++) stuck.update(bot, ctx)
    } finally { cap.release() }
    assert.equal(ctx.stuckState, 'STUCK')
    assert.deepEqual(ctx.stuck, { by: 'no-displacement', goal: { x: 10, y: 64, z: 0 }, key: 'ticker' })
  })

  it('raise attribution follows the live goal key', () => {
    const cases = [
      ['follow:Steve', 'follow', 'follow:Steve'],
      ['roam-back:Steve', 'roam', 'roam-back:Steve'],
      ['roam:1,64,1', 'roam', 'roam:1,64,1'], // stroll: slow path only, still latches as roam
      ['lead:10,64,0', 'lead', 'lead:10,64,0'],
      ['gather:2,64,0', 'gather', 'gather:2,64,0'],
      ['explore:0,-16', 'explore', 'explore:0,-16'],
      ['bring:0,62,0', 'bring', 'bring:0,62,0'],
      ['deep-back:3', 'deep', 'deep-back:3'],
      ['return-spawn:0,64,0', 'home', 'return-spawn:0,64,0'],
      ['fight:1', 'no-displacement', 'ticker'],
      ['idle', 'no-displacement', 'ticker'],
      ['', 'no-displacement', 'ticker'],
    ]
    for (const [key, by] of cases) assert.equal(stuck.ownerOf({ lastGoalKey: key }), by, key)
    // End to end for two owned keys: the raise carries key + live goal.
    for (const [key, by] of [['lead:10,64,0', 'lead'], ['gather:2,64,0', 'gather']]) {
      const bot = mockBot({ moving: true, goal: new goals.GoalNear(10, 64, 0, 2) })
      const ctx = { lastGoalKey: key, lastPos: { x: 0, y: 64, z: 0 } }
      const cap = capture()
      try {
        for (let i = 0; i < 30; i++) stuck.update(bot, ctx)
      } finally { cap.release() }
      assert.equal(ctx.stuck && ctx.stuck.by, by, key)
      assert.equal(ctx.stuck && ctx.stuck.key, key, key)
    }
  })

  it('an explore raise parses the target from the key (GoalXZ carries no y)', () => {
    const bot = mockBot({ moving: true, goal: new goals.GoalXZ(0, -16) })
    const ctx = { lastGoalKey: 'explore:0,-16', lastPos: { x: 0, y: 64, z: 0 } }
    const cap = capture()
    try {
      for (let i = 0; i < 30; i++) stuck.update(bot, ctx)
    } finally { cap.release() }
    assert.deepEqual(ctx.stuck, { by: 'explore', goal: { x: 0, y: 64, z: -16 }, key: 'explore:0,-16' })
  })

  it('a refused raise stays SUSPECT and silent', () => {
    // A latch the consult could not see (seeded between consult and raise
    // is impossible single-threaded; a pre-set fact is the real shape):
    // the STUCK branch holds it instead of raising over it.
    const bot = mockBot({ moving: true })
    const ctx = {
      lastGoalKey: 'follow:P', lastPos: { x: 0, y: 64, z: 0 },
      stuckTicks: 29, stuckResets: 2,
      stuck: { by: 'fight', goal: null, key: 'fight' },
    }
    const cap = capture()
    try {
      stuck.update(bot, ctx)
    } finally { cap.release() }
    assert.deepEqual(ctx.stuck.by, 'fight')
    assert.equal(ctx.stuckState, 'STUCK')
    assert.equal(cap.lines.filter((l) => l.includes('stuck reason=')).length, 0)
  })
})

describe('stuck update: dig hold (uqhp)', () => {
  function diggingBot() {
    const target = { username: 'P', id: 7, position: pos(10, 64, 0) }
    const bot = mockBot({ moving: true, goal: followGoal(target) })
    bot.targetDigBlock = { name: 'granite', position: pos(1, 64, 0) }
    return bot
  }

  it('stills accrue on the dig budget, never the slow count, while the executor digs', () => {
    const bot = diggingBot()
    const ctx = { lastGoalKey: 'follow:P', lastPos: { x: 0, y: 64, z: 0 } }
    for (let i = 0; i < 45; i++) stuck.update(bot, ctx)
    assert.equal(ctx.digStills, 45)
    assert.equal(ctx.stuckTicks || 0, 0)
    assert.equal(ctx.stuck || null, null)
    assert.equal(stuck.verdict(ctx).state, 'SUSPECT')
  })

  it('past the cap the slow count resumes, so a pathological dig still wedges', () => {
    const bot = diggingBot()
    const ctx = { lastGoalKey: 'follow:P', lastPos: { x: 0, y: 64, z: 0 } }
    const cap = capture()
    try {
      for (let i = 0; i < stuck.DIG_STILLS_CAP; i++) stuck.update(bot, ctx)
      assert.equal(ctx.stuck || null, null, 'no wedge inside the dig budget')
      assert.equal(ctx.stuckTicks || 0, 0)
      for (let i = 0; i < recover.STUCK_TICKS_ENTRY; i++) stuck.update(bot, ctx)
    } finally { cap.release() }
    assert.equal(ctx.stuckState, 'STUCK')
    assert.equal(ctx.stuck && ctx.stuck.by, 'follow')
  })

  it('progress zeroes the dig budget (tunnel legs each get a fresh hold)', () => {
    const bot = diggingBot()
    const ctx = { lastGoalKey: 'follow:P', lastPos: { x: 0, y: 64, z: 0 } }
    for (let i = 0; i < 20; i++) stuck.update(bot, ctx)
    assert.equal(ctx.digStills, 20)
    bot.entity.position = pos(3, 64, 0) // mount between dig legs
    stuck.update(bot, ctx)
    assert.equal(ctx.digStills, 0)
    assert.equal(ctx.stuckState, 'MOVING')
  })

  it('the fast entry still fires mid-dig on lib complaints', () => {
    const bot = diggingBot()
    const ctx = { lastGoalKey: 'follow:P', lastPos: { x: 0, y: 64, z: 0 } }
    const cap = capture()
    try {
      stuck.update(bot, ctx)
      stuck.countPathReset(ctx, 'stuck')
      stuck.update(bot, ctx)
      stuck.countPathReset(ctx, 'stuck')
      stuck.update(bot, ctx)
    } finally { cap.release() }
    assert.equal(ctx.stuckState, 'STUCK')
    assert.equal(ctx.stuck && ctx.stuck.by, 'follow')
  })
})

describe('stuck update: fast entry', () => {
  function wedgedBot(key, goal) {
    const target = { username: 'P', id: 7, position: pos(20, 64, 0) }
    const bot = mockBot({ moving: true, goal: goal || followGoal(target) })
    return { bot, target }
  }

  it("two 'stuck' resets with no displacement raise by=follow", () => {
    const { bot } = wedgedBot()
    const ctx = { lastGoalKey: 'follow:P', lastPos: { x: 0, y: 64, z: 0 } }
    const cap = capture()
    try {
      stuck.countPathReset(ctx, 'stuck')
      stuck.update(bot, ctx)
      assert.equal(ctx.stuck || null, null, 'single knock never raises')
      assert.equal(ctx.stuckState, 'SUSPECT')
      stuck.countPathReset(ctx, 'stuck')
      stuck.update(bot, ctx)
    } finally { cap.release() }
    assert.equal(ctx.stuckState, 'STUCK')
    assert.deepEqual(ctx.stuck, { by: 'follow', goal: { x: 20, y: 64, z: 0 }, key: 'follow:P' })
    assert.equal(cap.lines.filter((l) => l.includes('stuck reason=wedge')).length, 1)
  })

  it('three consecutive place_error raise the same wedge (2oe)', () => {
    const { bot } = wedgedBot()
    const ctx = { lastGoalKey: 'follow:P', lastPos: { x: 0, y: 64, z: 0 } }
    const cap = capture()
    try {
      for (let i = 0; i < 3; i++) {
        stuck.countPathReset(ctx, 'place_error')
        stuck.update(bot, ctx)
      }
    } finally { cap.release() }
    assert.equal(ctx.stuckState, 'STUCK')
    assert.deepEqual(ctx.stuck, { by: 'follow', goal: { x: 20, y: 64, z: 0 }, key: 'follow:P' })
  })

  it('fast entry fires on roam-back keys, never on stroll or unowned keys', () => {
    for (const [key, want] of [
      ['roam-back:P', true],
      ['roam:1,64,1', false], // p4s: the stroll takes another point instead
      ['gather:2,64,0', false], // yvi: gather owns the streak for skips
      ['lead:10,64,0', false],
      ['fight:1', false],
    ]) {
      const { bot } = wedgedBot()
      const ctx = { lastGoalKey: key, lastPos: { x: 0, y: 64, z: 0 } }
      const cap = capture()
      try {
        stuck.countPathReset(ctx, 'stuck')
        stuck.countPathReset(ctx, 'stuck')
        stuck.update(bot, ctx)
      } finally { cap.release() }
      assert.equal(!!(ctx.stuck), want, key)
      assert.equal(ctx.stuckState, want ? 'STUCK' : 'SUSPECT', key)
    }
  })

  it('three place_error with no movement context never raise (p4s)', () => {
    const bot = mockBot({ moving: false, goal: null })
    const ctx = { lastGoalKey: 'follow:P', lastPos: { x: 0, y: 64, z: 0 } }
    stuck.countPathReset(ctx, 'place_error')
    stuck.countPathReset(ctx, 'place_error')
    stuck.countPathReset(ctx, 'place_error')
    stuck.update(bot, ctx)
    assert.equal(ctx.stuck || null, null)
    assert.equal(ctx.stuckState, 'MOVING')
  })

  it('fast entry fires at once on a ground wedge, no waiting gate', () => {
    // Genuine ground wedges (no jumps) pass immediately: streak alone
    // raises on the first still tick, like master's always-on streak check.
    const target = { username: 'P', id: 7, position: pos(20, 64, 0) }
    const bot = mockBot({ moving: true, goal: followGoal(target) })
    const ctx = { lastGoalKey: 'follow:P', lastPos: { x: 0, y: 64, z: 0 } }
    stuck.countPathReset(ctx, 'stuck')
    stuck.countPathReset(ctx, 'stuck')
    stuck.update(bot, ctx)
    assert.equal(ctx.stuckState, 'STUCK', 'ground wedge fast-fires at once')
    assert.equal(ctx.stuck.by, 'follow')
  })

  it('fast entry waits out the tower jump cycle: jump quiets, landing stalls', () => {
    // Tower attempts apex every jump — a streak alone must not wedge
    // mid-jump-cycle (master cleared the streaks on every 3D jump). The
    // jump-quiet window holds the fast entry for 4 still ticks after each
    // apex-size move; the slow entry at 30 still catches a run that never
    // gains (master's ticker backstop).
    const target = { username: 'P', id: 7, position: pos(20, 64, 0) }
    const bot = mockBot({ moving: true, goal: followGoal(target) })
    const ctx = { lastGoalKey: 'follow:P', lastPos: { x: 0, y: 64, z: 0 } }
    stuck.countPathReset(ctx, 'stuck')
    stuck.countPathReset(ctx, 'stuck')
    // Jump-cycle traffic: apex, then landing back at the anchor level.
    for (let k = 0; k < 3; k++) {
      bot.entity.position = pos(0, 65.2, 0); bot.entity.onGround = false
      stuck.update(bot, ctx)
      assert.equal(ctx.stuck || null, null, 'apex never fast-fires')
      bot.entity.position = pos(0, 64, 0); bot.entity.onGround = true
      stuck.update(bot, ctx)
      assert.equal(ctx.stuck || null, null, 'landing inside the quiet window holds')
    }
    stuck.update(bot, ctx) // window runs down: 3 → 2 → 1 → fires at 0
    stuck.update(bot, ctx)
    stuck.update(bot, ctx)
    assert.equal(ctx.stuckState, 'STUCK', 'stalled tower fires after the window')
    assert.equal(ctx.stuck.by, 'follow')
  })

  it('fast entry ignores water bobbing: small oscillation is not a jump', () => {
    // Stuck-replay S6-PIT bobs ±0.3 around the anchor; the bob must not
    // arm the quiet window (master fires there on the streak alone).
    const target = { username: 'P', id: 7, position: pos(20, 64, 0) }
    const bot = mockBot({ moving: true, goal: followGoal(target) })
    const ctx = { lastGoalKey: 'follow:P', lastPos: { x: 0, y: 64, z: 0 } }
    stuck.countPathReset(ctx, 'place_error')
    stuck.countPathReset(ctx, 'place_error')
    stuck.countPathReset(ctx, 'place_error')
    bot.entity.position = pos(0, 64.3, 0); bot.entity.onGround = false
    stuck.update(bot, ctx)
    assert.equal(ctx.stuckState, 'STUCK', 'bobbing pit fast-fires like master')
    assert.equal(ctx.stuck.by, 'follow')
  })

  it('any other reset reason breaks only the place_error streak', () => {
    const ctx = {}
    stuck.countPathReset(ctx, 'place_error')
    stuck.countPathReset(ctx, 'place_error')
    assert.equal(ctx.placeErrors, 2)
    stuck.countPathReset(ctx, 'stuck') // a wedge knock is not a place streak
    assert.equal(ctx.placeErrors, 0)
    assert.equal(ctx.stuckResets, 1)
    assert.equal(ctx.lastPathReset, 'stuck')
  })

  it('sustained tower spam fast-fires past the moving/key/jump gates (vmzq.47)', () => {
    // c410: 172 place_error resets, moving=false, path=success, work key —
    // neither entry fired for 3 min (the fast check needs shouldCount, the
    // slow needs moving-or-terminal). Past PLACE_SPAM_ENTRY the streak
    // alone raises: a parked executor plans no resets, and a healthy tower
    // climbs and zeroes the streak via progressed().
    const bot = mockBot({ moving: false, goal: null })
    const ctx = { lastGoalKey: 'castle:12,64,0', lastPos: { x: 0, y: 64, z: 0 }, jumpCooldown: 4 }
    for (let i = 0; i < stuck.PLACE_SPAM_ENTRY - 1; i++) stuck.countPathReset(ctx, 'place_error')
    const cap = capture()
    try {
      stuck.update(bot, ctx)
      assert.equal(ctx.stuck || null, null, '9 consecutive refusals hold (mid-cycle traffic)')
      stuck.countPathReset(ctx, 'place_error')
      stuck.update(bot, ctx)
    } finally { cap.release() }
    assert.equal(ctx.stuckState, 'STUCK', '10th consecutive refusal raises')
    assert.equal(ctx.stuck.by, 'no-displacement')
  })
})

describe('stuck update: idle probe (rra)', () => {
  function idleBot() {
    const target = { username: 'P', id: 7, position: pos(10, 61, 0) }
    const bot = mockBot({ at: [0.5, 61, 0.5], moving: false, goal: followGoal(target) })
    return { bot, target }
  }

  it('idle far from a live goal counts after a terminal verdict, then raises', () => {
    const { bot } = idleBot()
    const ctx = { lastGoalKey: 'follow:P', lastPos: { x: 0.5, y: 61, z: 0.5 }, lastPathStatus: 'noPath' }
    const cap = capture()
    try {
      for (let i = 0; i < 30; i++) stuck.update(bot, ctx)
    } finally { cap.release() }
    assert.equal(ctx.stuckState, 'STUCK')
    assert.deepEqual(ctx.stuck, { by: 'follow', goal: { x: 10, y: 61, z: 0 }, key: 'follow:P' })
  })

  it('idle without a goal, at the goal, or mid-plan stays MOVING', () => {
    const { bot, target } = idleBot()
    // No goal.
    let ctx = { lastGoalKey: '', lastPos: { x: 0.5, y: 61, z: 0.5 }, lastPathStatus: 'noPath' }
    bot.pathfinder.goal = null
    for (let i = 0; i < 35; i++) stuck.update(bot, ctx)
    assert.equal(ctx.stuck || null, null)
    assert.equal(ctx.stuckState, 'MOVING')
    // At the goal: the live measure beats the stale snapshot + stale noPath.
    target.position = pos(2, 61, 0)
    bot.pathfinder.goal = followGoal(target)
    ctx = { lastGoalKey: 'follow:P', lastPos: { x: 0.5, y: 61, z: 0.5 }, lastPathStatus: 'noPath' }
    for (let i = 0; i < 35; i++) stuck.update(bot, ctx)
    assert.equal(ctx.stuck || null, null, 'live range reads satisfied, not stuck')
    // Mid-plan: none/success with an idle executor is a plan in flight.
    target.position = pos(10, 61, 0)
    for (const status of ['none', 'success']) {
      ctx = { lastGoalKey: 'follow:P', lastPos: { x: 0.5, y: 61, z: 0.5 }, lastPathStatus: status }
      for (let i = 0; i < 35; i++) stuck.update(bot, ctx)
      assert.equal(ctx.stuck || null, null, `mid-plan ${status} never counts`)
      assert.equal(ctx.stuckState, 'MOVING')
    }
  })

  it('displacement restarts the idle count', () => {
    const { bot } = idleBot()
    const ctx = { lastGoalKey: 'build:x', lastPos: { x: 0.5, y: 61, z: 0.5 }, lastPathStatus: 'noPath' }
    for (let i = 0; i < 20; i++) stuck.update(bot, ctx)
    assert.equal(ctx.stuckTicks, 20)
    bot.entity.position = pos(1.5, 61, 0.5) // one real step, still far
    stuck.update(bot, ctx)
    assert.equal(ctx.stuckTicks, 0)
    assert.equal(ctx.stuckState, 'MOVING')
  })
})

describe('stuck update: raise gates', () => {
  it('a night approach never raises (rw4.5): gohome, stay, comehome', () => {
    for (const ctx of [
      { work: true, step: 'gohome' },
      { work: true, step: 'stay' },
      { comehome: { phase: 'walk' } },
    ]) {
      const bot = mockBot({ moving: true })
      Object.assign(ctx, { lastGoalKey: 'gohome', lastPos: { x: 0, y: 64, z: 0 } })
      for (let i = 0; i < 35; i++) stuck.update(bot, ctx)
      assert.equal(ctx.stuck || null, null, JSON.stringify({ step: ctx.step, comehome: !!ctx.comehome }))
      assert.equal(ctx.stuckState, 'SUSPECT', 'counting continues under the gate')
    }
  })

  it('the rest gave-up hold suppresses the raise at its point (q0h)', () => {
    const bot = mockBot({ moving: true })
    const ctx = {
      lastGoalKey: 'roam-back:P', lastPos: { x: 0, y: 64, z: 0 },
      work: true, step: 'rest', restGaveUpAt: { x: 0, y: 64, z: 0 },
    }
    stuck.countPathReset(ctx, 'stuck')
    stuck.countPathReset(ctx, 'stuck')
    stuck.update(bot, ctx)
    assert.equal(ctx.stuck || null, null)
    assert.equal(ctx.stuckState, 'SUSPECT')
  })

  it('relocation ends the rest hold on any tick', () => {
    const bot = mockBot({ moving: false, goal: null })
    const ctx = {
      lastGoalKey: '', lastPos: { x: 6, y: 64, z: 0 },
      work: true, step: 'rest', restGaveUpAt: { x: 0, y: 64, z: 0 },
    }
    bot.entity.position = pos(6, 64, 0)
    stuck.update(bot, ctx)
    assert.equal(ctx.restGaveUpAt, null)
  })
})

describe('stuck update: STUCK and RECOVERING', () => {
  it('a raised fact holds while still, clears on displacement', () => {
    const bot = mockBot({ moving: true })
    const ctx = {
      lastGoalKey: 'follow:P', lastPos: { x: 0, y: 64, z: 0 },
      stuck: { by: 'follow', goal: { x: 20, y: 64, z: 0 }, key: 'follow:P' },
    }
    stuck.update(bot, ctx)
    assert.equal(ctx.stuckState, 'STUCK')
    assert.ok(ctx.stuck, 'fact waits for the route')
    bot.entity.position = pos(2, 64, 0)
    stuck.update(bot, ctx)
    assert.equal(ctx.stuck, null, 'displacement clears the stale fact')
    assert.equal(ctx.stuckState, 'MOVING')
  })

  it('a running episode holds the machine and tracks the freed body', () => {
    const bot = mockBot({ moving: false, goal: null })
    const ctx = {
      lastGoalKey: '', lastPos: { x: 0, y: 64, z: 0 }, stuckTicks: 29,
      stuck: { by: 'follow', goal: null, key: 'follow:P' },
      recovery: { action: 'sidestep', status: 'running' },
    }
    bot.entity.position = pos(2, 64, 0) // the sidestep freed the body
    stuck.update(bot, ctx)
    assert.equal(ctx.stuckState, 'RECOVERING')
    assert.deepEqual(ctx.lastPos, { x: 2, y: 64, z: 0 })
    assert.ok(ctx.stuck, 'the fact drives the routing until release')
  })

  it('a retreat pillar borrowing ctx.recovery holds detection too', () => {
    const bot = mockBot({ moving: true })
    const ctx = {
      lastGoalKey: 'retreat', lastPos: { x: 0, y: 64, z: 0 }, stuckTicks: 29,
      recovery: { action: 'pillar_up', status: 'running' }, retreat: { action: 'pillar' },
    }
    stuck.update(bot, ctx)
    assert.equal(ctx.stuckState, 'RECOVERING')
    assert.equal(ctx.stuck || null, null)
  })
})

describe('stuck update: COOLDOWN', () => {
  it('an anchored latch holds the count until relocation re-arms', () => {
    const target = { username: 'P', id: 7, position: pos(10, 61, 0) }
    const bot = mockBot({ at: [0.5, 61, 0.5], moving: false, goal: followGoal(target) })
    const ctx = {
      lastGoalKey: 'follow:P', lastPos: { x: 0.5, y: 61, z: 0.5 }, lastPathStatus: 'noPath',
      recoverLatch: { by: 'no-displacement', key: 'ticker', goal: { x: 10, y: 61, z: 0 }, at: { x: 0.5, y: 61, z: 0.5 } },
    }
    for (let i = 0; i < 35; i++) stuck.update(bot, ctx)
    assert.equal(ctx.stuck || null, null, 'latched trap stays quiet')
    assert.equal(ctx.stuckState, 'COOLDOWN')
    bot.entity.position = pos(6, 61, 0.5) // 5.5 past the anchor, still far
    for (let i = 0; i < 31; i++) stuck.update(bot, ctx)
    assert.equal(ctx.recoverLatch, null, 'relocation clears the latch')
    assert.equal(ctx.stuck && ctx.stuck.by, 'follow', 're-armed trap fires again')
  })

  it("the synthetic 'ticker' latch is sticky across pursuits (position only)", () => {
    // rra round 1: a follow re-issue must not clear the trap latch — only
    // relocation does.
    const bot = mockBot({ moving: true })
    const ctx = {
      lastGoalKey: 'follow:Q', lastPos: { x: 0, y: 64, z: 0 },
      recoverLatch: { by: 'no-displacement', key: 'ticker', goal: { x: 10, y: 64, z: 0 }, at: { x: 0, y: 64, z: 1 } },
    }
    stuck.update(bot, ctx)
    assert.ok(ctx.recoverLatch, 'key change keeps the ticker latch')
    assert.equal(ctx.stuckState, 'COOLDOWN')
  })

  it('a real-key anchored latch clears on a new pursuit (was follow.js:54)', () => {
    const bot = mockBot({ moving: true })
    const ctx = {
      lastGoalKey: 'follow:Q', lastPos: { x: 0, y: 64, z: 0 },
      recoverLatch: { by: 'home', key: 'return-spawn:0,64,0', goal: { x: 0, y: 64, z: 0 }, at: { x: 0, y: 64, z: 1 } },
    }
    stuck.update(bot, ctx)
    assert.equal(ctx.recoverLatch, null, 'new pursuit, new situation')
    assert.equal(ctx.stuckState, 'SUSPECT')
  })

  it('a goal latch holds the same situation, clears on a moved goal or key', () => {
    const target = { username: 'P', id: 7, position: pos(10, 64, 0) }
    // Same key + close goal: hold.
    let bot = mockBot({ moving: true, goal: followGoal(target) })
    let ctx = {
      lastGoalKey: 'follow:P', lastPos: { x: 0, y: 64, z: 0 },
      recoverLatch: { by: 'follow', key: 'follow:P', goal: { x: 10, y: 64, z: 0 } },
    }
    stuck.update(bot, ctx)
    assert.ok(ctx.recoverLatch)
    assert.equal(ctx.stuckState, 'COOLDOWN')
    // Player walked off: the live goal moved, re-arm.
    target.position = pos(30, 64, 0)
    ctx = {
      lastGoalKey: 'follow:P', lastPos: { x: 0, y: 64, z: 0 },
      recoverLatch: { by: 'follow', key: 'follow:P', goal: { x: 10, y: 64, z: 0 } },
    }
    stuck.update(bot, ctx)
    assert.equal(ctx.recoverLatch, null)
    // New pursuit key: re-arm.
    ctx = {
      lastGoalKey: 'follow:Q', lastPos: { x: 0, y: 64, z: 0 },
      recoverLatch: { by: 'follow', key: 'follow:P', goal: { x: 30, y: 64, z: 0 } },
    }
    stuck.update(bot, ctx)
    assert.equal(ctx.recoverLatch, null)
  })

  it('release anchors the lead latch, COOLDOWN bounds the mining stall', () => {
    const bot = mockBot({ at: [0, 64, 0] })
    const ctx = {
      stuck: { by: 'lead', goal: { x: 10, y: 64, z: 0 }, key: 'lead:10,64,0' },
      recovery: { action: 'sidestep', source: 'fsm' },
      lead: { name: 'ore', pos: { x: 10, y: 64, z: 0 }, stuckTicks: 5, workTicks: 40 },
      brain: null,
    }
    recover.release(bot, ctx, 'done')
    assert.equal(ctx.recoverLatch && ctx.recoverLatch.by, 'lead')
    assert.deepEqual(ctx.recoverLatch.at, { x: 0, y: 64, z: 0 }, 'lead latch anchored (core-4)')
    assert.equal(ctx.recoverLatch.mark, 10, 'no-gain mark rides the latch')
    assert.equal(ctx.lead.nudged, true)
    // Post-episode stills hold instead of re-firing every slow threshold.
    ctx.lastGoalKey = 'lead:10,64,0'
    ctx.lastPos = { x: 0, y: 64, z: 0 }
    bot._moving = true
    bot.pathfinder.goal = new goals.GoalNear(10, 64, 0, 2)
    for (let i = 0; i < 35; i++) stuck.update(bot, ctx)
    assert.equal(ctx.stuck, null)
    assert.equal(ctx.stuckState, 'COOLDOWN')
  })

  it('an ore below the bot holds the latch: the mark is 3D, not horizontal (round 2)', () => {
    // Ore at y=40, bot at y=64: horizontal 10 < 3D 26 — a 2D read would go
    // stale on the first tick and loop an episode every slow threshold.
    const bot = mockBot({ at: [0, 64, 0] })
    const ctx = {
      stuck: { by: 'lead', goal: { x: 10, y: 40, z: 0 }, key: 'lead:10,40,0' },
      recovery: { action: 'sidestep', source: 'fsm' },
      lead: { name: 'ore', pos: { x: 10, y: 40, z: 0 }, stuckTicks: 5, workTicks: 40 },
      brain: null,
    }
    recover.release(bot, ctx, 'done')
    assert.equal(ctx.recoverLatch.mark, 26, 'mark is the 3D distance')
    ctx.lastGoalKey = 'lead:10,40,0'
    ctx.lastPos = { x: 0, y: 64, z: 0 }
    bot._moving = true
    bot.pathfinder.goal = new goals.GoalNear(10, 40, 0, 2)
    for (let i = 0; i < 35; i++) stuck.update(bot, ctx)
    assert.equal(ctx.stuck, null)
    assert.equal(ctx.stuckState, 'COOLDOWN', '35 still ticks hold, no re-fire')
    // Real 3D gain still re-arms, inside the latch radius: straight down to
    // y=60 leaves 22 of 26 — the mark rule alone clears the latch.
    bot.entity.position = pos(0, 60, 0)
    stuck.update(bot, ctx)
    assert.equal(ctx.recoverLatch, null, '3D gain past the mark re-arms')
  })

  it('real gain past the mark re-arms the lead latch for a new wedge (core-4)', () => {
    const bot = mockBot({ at: [0, 64, 0], moving: true, goal: new goals.GoalNear(10, 64, 0, 2) })
    const ctx = {
      lastGoalKey: 'lead:10,64,0', lastPos: { x: 0, y: 64, z: 0 },
      lead: { name: 'ore', pos: { x: 10, y: 64, z: 0 }, nudged: true, nudgedAt: 10 },
      recoverLatch: { by: 'lead', key: 'lead:10,64,0', goal: { x: 10, y: 64, z: 0 }, at: { x: 0, y: 64, z: 0 }, mark: 10 },
    }
    stuck.update(bot, ctx)
    assert.ok(ctx.recoverLatch, 'no gain: the latch holds')
    bot.entity.position = pos(5, 64, 0) // 5 left of 10: real gain
    stuck.update(bot, ctx)
    assert.equal(ctx.recoverLatch, null, 'gain past the mark re-arms')
  })

  it('progress while latched zeroes the streaks (core-5)', () => {
    // Resets keep arriving while the body walks normally under a latch;
    // they must not fire a fast wedge on the tick the latch goes stale.
    const bot = mockBot({ moving: true })
    const ctx = {
      lastGoalKey: 'follow:P', lastPos: { x: 0, y: 64, z: 0 },
      stuckResets: 2, placeErrors: 1,
      recoverLatch: { by: 'follow', key: 'follow:P', goal: { x: 20, y: 64, z: 0 } },
    }
    bot.entity.position = pos(3, 64, 0) // walking, same pursuit: latch holds
    stuck.update(bot, ctx)
    assert.ok(ctx.recoverLatch)
    assert.equal(ctx.stuckState, 'COOLDOWN')
    assert.equal(ctx.stuckResets, 0)
    assert.equal(ctx.placeErrors, 0)
  })
})

describe('stuck raise lines (formats frozen)', () => {
  const BLOCKS = {
    '-41,64,-208': 'water', '-41,65,-208': 'air', '-39,64,-207': 'dirt',
  }

  it('follow names feet/head/next blocks on the wedge line (b50)', () => {
    const target = { username: 'P', id: 7, position: pos(-20, 64, -207) }
    const bot = mockBot({ at: [-40.4, 64.4, -207.7], moving: true, goal: followGoal(target), blocks: BLOCKS })
    const ctx = {
      lastGoalKey: 'follow:P', lastPos: { x: -40.4, y: 64.4, z: -207.7 },
      lastPathNext: pos(-39, 64, -207),
    }
    stuck.countPathReset(ctx, 'stuck')
    stuck.countPathReset(ctx, 'stuck')
    const cap = capture()
    try {
      stuck.update(bot, ctx)
    } finally { cap.release() }
    assert.equal(cap.lines.length, 1)
    assert.match(cap.lines[0], /^stuck reason=wedge pos=/)
    assert.ok(cap.lines[0].includes('feet=water'), cap.lines[0])
    assert.ok(cap.lines[0].includes('head=air'), cap.lines[0])
    assert.ok(cap.lines[0].includes('next=-39,64,-207:dirt'), cap.lines[0])
  })

  it('unreadable cells read ? instead of throwing', () => {
    const target = { username: 'P', id: 7, position: pos(-20, 64, -207) }
    const bot = mockBot({ at: [-40.4, 64.4, -207.7], moving: true, goal: followGoal(target) })
    bot.blockAt = () => { throw new Error('unloaded') }
    const ctx = { lastGoalKey: 'follow:P', lastPos: { x: -40.4, y: 64.4, z: -207.7 } }
    stuck.countPathReset(ctx, 'stuck')
    stuck.countPathReset(ctx, 'stuck')
    const cap = capture()
    try {
      stuck.update(bot, ctx)
    } finally { cap.release() }
    assert.equal(cap.lines.length, 1)
    assert.ok(cap.lines[0].includes('feet=?'), cap.lines[0])
    assert.ok(cap.lines[0].includes('next=?:?'), cap.lines[0])
  })

  it('roam prints pos with one decimal and the goal (1hy)', () => {
    const target = { id: 7, username: 'S', position: pos(20, 64, 0) }
    const bot = mockBot({ at: [7.36, 64, 0], moving: true, goal: followGoal(target) })
    const ctx = { lastGoalKey: 'roam-back:S', lastPos: { x: 7.36, y: 64, z: 0 } }
    stuck.countPathReset(ctx, 'stuck')
    stuck.countPathReset(ctx, 'stuck')
    const cap = capture()
    try {
      stuck.update(bot, ctx)
    } finally { cap.release() }
    assert.ok(ctx.stuck, 'wedge raised')
    assert.ok(cap.lines.some((m) => m.includes('pos=7.4,64,0')), `feet rounded: ${cap.lines.join('|')}`)
    assert.ok(cap.lines.some((m) => m.includes('goal=20,64,0')), `goal ints: ${cap.lines.join('|')}`)
  })

  it('lead prints the nudge line with rounded feet', () => {
    const bot = mockBot({ at: [0.4, 64, 0], moving: true, goal: new goals.GoalNear(10, 64, 0, 2) })
    const ctx = { lastGoalKey: 'lead:10,64,0', lastPos: { x: 0.4, y: 64, z: 0 } }
    const cap = capture()
    try {
      for (let i = 0; i < 30; i++) stuck.update(bot, ctx)
    } finally { cap.release() }
    assert.equal(ctx.stuck && ctx.stuck.by, 'lead')
    assert.ok(cap.lines.some((m) => m === 'stuck reason=nudge pos=0,64,0'), cap.lines.join('|'))
  })

  it('home prints the wedge line with dist to spawn', () => {
    const bot = mockBot({ at: [-205, 39, -35], moving: true, goal: new goals.GoalNear(-48, 65, -208, 2) })
    bot.spawnPoint = pos(-48, 65, -208)
    const ctx = { lastGoalKey: 'return-spawn:-48,65,-208', lastPos: { x: -205, y: 39, z: -35 } }
    const cap = capture()
    try {
      for (let i = 0; i < 30; i++) stuck.update(bot, ctx)
    } finally { cap.release() }
    assert.equal(ctx.stuck && ctx.stuck.by, 'home')
    assert.match(
      cap.lines.find((m) => m.includes('stuck reason=wedge')),
      /^stuck reason=wedge pos=-205,39,-35 dist=/,
    )
  })

  it('gather/explore/bring/deep/no-displacement raise silently', () => {
    for (const [key, goal] of [
      ['gather:2,64,0', new goals.GoalNear(2, 64, 0, 2)],
      ['bring:0,62,0', new goals.GoalNear(0, 62, 0, 2)],
      ['deep-back:3', new goals.GoalBlock(1, 60, 0)],
      ['fight:1', new goals.GoalNear(5, 64, 0, 2)],
    ]) {
      const bot = mockBot({ moving: true, goal })
      const ctx = { lastGoalKey: key, lastPos: { x: 0, y: 64, z: 0 } }
      const cap = capture()
      try {
        for (let i = 0; i < 30; i++) stuck.update(bot, ctx)
      } finally { cap.release() }
      assert.ok(ctx.stuck, `${key} raised`)
      assert.equal(cap.lines.filter((l) => l.includes('stuck reason=')).length, 0, `${key} silent`)
    }
  })
})

describe('stuck request (give-up escape)', () => {
  it('raises through the same choke point: fact, line, STUCK state', () => {
    const bot = mockBot({ at: [0.4, 64, 0] })
    const ctx = { lastGoalKey: 'lead:10,64,0' }
    const cap = capture()
    let ok = false
    try {
      ok = stuck.request(bot, ctx, 'lead', { x: 10, y: 64, z: 0 }, 'lead:10,64,0')
    } finally { cap.release() }
    assert.equal(ok, true)
    assert.deepEqual(ctx.stuck, { by: 'lead', goal: { x: 10, y: 64, z: 0 }, key: 'lead:10,64,0' })
    assert.equal(ctx.stuckState, 'STUCK')
    assert.ok(cap.lines.some((m) => m === 'stuck reason=nudge pos=0,64,0'), cap.lines.join('|'))
  })

  it('refuses while a fact, an episode, or the same latch holds', () => {
    const bot = mockBot()
    assert.equal(stuck.request(bot, { stuck: { by: 'fight' } }, 'bring', null, 'bring:0,62,0'), false)
    assert.equal(stuck.request(bot, { recovery: { action: 'wait' } }, 'bring', null, 'bring:0,62,0'), false)
    const cap = capture()
    let ok = true
    try {
      ok = stuck.request(bot, {
        recoverLatch: { by: 'bring', key: 'bring:0,62,0', goal: { x: 0, y: 62, z: 0 } },
      }, 'bring', { x: 0, y: 62, z: 0 }, 'bring:0,62,0')
    } finally { cap.release() }
    assert.equal(ok, false, 'latch holds the same situation')
    assert.equal(cap.lines.length, 0, 'refused requests stay silent')
  })
})

describe('stuck clearStuck', () => {
  it('a mode change resets the machine, counters and latch', () => {
    const ctx = {
      stuck: { by: 'follow' }, recovery: { action: 'wait' },
      stuckTicks: 10, stuckResets: 1, placeErrors: 2, jumpCooldown: 3,
      stuckState: 'SUSPECT', recoverLatch: { by: 'follow', key: 'follow:P' }, retreat: { action: 'pillar' },
    }
    stuck.clearStuck(ctx)
    assert.deepEqual(
      [ctx.stuck, ctx.recovery, ctx.stuckTicks, ctx.stuckResets, ctx.placeErrors, ctx.jumpCooldown, ctx.stuckState, ctx.recoverLatch, ctx.retreat],
      [null, null, 0, 0, 0, 0, 'MOVING', null, null],
    )
  })
})

describe('stuck walkHomeTick (pure walk)', () => {
  it('stands down for the breath reflex, walks after N unseen ticks', () => {
    const bot = mockBot({ at: [-205, 39, -35] })
    bot.spawnPoint = pos(-48, 65, -208)
    const goalsSeen = []
    bot.pathfinder.setGoal = (g) => { goalsSeen.push(g); bot.pathfinder.goal = g }
    assert.equal(stuck.walkHomeTick(bot, { breath: true, unseenTicks: 99 }), true)
    assert.equal(goalsSeen.length, 0)
    const ctx = { unseenTicks: 3, lastGoalKey: '' }
    assert.equal(stuck.walkHomeTick(bot, ctx), false)
    ctx.unseenTicks = 10
    const cap = capture()
    try {
      assert.equal(stuck.walkHomeTick(bot, ctx), true)
    } finally { cap.release() }
    assert.equal(goalsSeen.length, 1)
    assert.equal(goalsSeen[0].constructor.name, 'GoalNear')
    assert.equal(ctx.lastGoalKey, 'return-spawn:-48,65,-208')
    assert.ok(cap.lines.some((l) => l.startsWith('returning to spawn dist=')), cap.lines.join('|'))
    // Keyed: standing ticks never re-issue and never raise on their own.
    for (let i = 0; i < 40; i++) stuck.walkHomeTick(bot, ctx)
    assert.equal(goalsSeen.length, 1)
    assert.equal(ctx.stuck || null, null)
  })

  it('homeReached agrees with the executor stop point', () => {
    const bot = mockBot({ at: [-48, 65, -208] })
    bot.spawnPoint = pos(-48, 65, -208)
    assert.equal(stuck.homeReached(bot), true)
    bot.entity.position = pos(-205, 39, -35)
    assert.equal(stuck.homeReached(bot), false)
  })
})
