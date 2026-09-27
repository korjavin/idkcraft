'use strict'

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const { createTicker, BEHAVIOURS } = require('../src/index')
const roam = require('../src/behaviours/roam')

function pos(x, y, z) {
  const p = {
    x, y, z,
    distanceTo: (q) => Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z),
    clone() { return pos(p.x, p.y, p.z) }
  }
  return p
}

function mockBot() {
  const calls = { setGoal: 0, stop: 0, goals: [], dynamic: [] }
  const bot = {
    calls,
    username: 'IdkBot',
    players: {},
    entities: {},
    health: 20,
    food: 20,
    _moving: false,
    entity: { position: pos(0, 64, 0) },
    pathfinder: {
      setGoal: (goal, dynamic) => { calls.setGoal++; calls.goals.push(goal); calls.dynamic.push(dynamic) },
      stop: () => { calls.stop++ },
      isMoving: () => bot._moving,
      setMovements: (m) => { calls.movements = m }
    },
    chat: () => {}
  }
  return bot
}

function playerEntity(x, z = 0) {
  return { id: 7, username: 'Steve', position: pos(x, 64, z) }
}

describe('roam behaviour', () => {
  it('sets a non-dynamic GoalNear within 6 blocks of the player at the same height', () => {
    const bot = mockBot()
    const player = playerEntity(2)
    // Random target: repeat so a widened radius cannot hide behind one lucky
    // roll. The bound is 6 + sqrt(2): GoalNear quantizes to whole blocks, so a
    // picked point at radius r lands up to one block diagonally away.
    for (let i = 0; i < 100; i++) {
      const ctx = { lastGoalKey: '' }
      roam(bot, ctx, player, {})
      assert.equal(bot.calls.setGoal, i + 1)
      const goal = bot.calls.goals[i]
      assert.equal(goal.constructor.name, 'GoalNear')
      assert.equal(goal.y, 64) // same level as the player, never above/below
      const d = Math.hypot(goal.x - player.position.x, goal.z - player.position.z)
      assert.ok(d <= 7.5, `goal ${d.toFixed(2)} blocks from the player, want <= 7.5`)
      assert.equal(bot.calls.dynamic[i], false) // not a tracking goal
      assert.match(ctx.lastGoalKey, /^roam:/)
    }
    assert.equal(bot.calls.stop, 0)
  })

  it('does nothing while the pathfinder is already moving', () => {
    const bot = mockBot()
    bot._moving = true
    const ctx = { lastGoalKey: '' }
    roam(bot, ctx, playerEntity(2), {})
    assert.equal(bot.calls.setGoal, 0)
    assert.equal(bot.calls.stop, 0)
    assert.equal(ctx.lastGoalKey, '')
  })

  it('walks back toward the player instead of freezing past 6 blocks', () => {
    const bot = mockBot() // bot at 0,64,0
    const player = playerEntity(20)
    const ctx = { lastGoalKey: '' }
    roam(bot, ctx, player, {})
    assert.equal(bot.calls.setGoal, 1)
    const goal = bot.calls.goals[0]
    assert.equal(goal.constructor.name, 'GoalFollow')
    assert.equal(goal.entity, player) // heading back to the player, not standing still
    assert.equal(bot.calls.dynamic[0], true)
    assert.match(ctx.lastGoalKey, /^roam-back:/)
    assert.equal(bot.calls.stop, 0)
  })

  it('does not re-issue the walk-back while already walking it', () => {
    const bot = mockBot()
    bot._moving = true
    const ctx = { lastGoalKey: 'roam-back:Steve' }
    roam(bot, ctx, playerEntity(20), {})
    assert.equal(bot.calls.setGoal, 0)
    assert.equal(bot.calls.stop, 0)
  })

  it('re-issues the walk-back when stopped past 6 blocks', () => {
    const bot = mockBot()
    const ctx = { lastGoalKey: 'roam-back:Steve' }
    roam(bot, ctx, playerEntity(20), {})
    assert.equal(bot.calls.setGoal, 1) // arrived nowhere: try the walk-back again
  })

  it('does nothing without a target', () => {
    const bot = mockBot()
    const ctx = { lastGoalKey: '' }
    roam(bot, ctx, null, {})
    roam(bot, ctx, { id: 7 }, {})
    assert.equal(bot.calls.setGoal, 0)
    assert.equal(bot.calls.stop, 0)
  })
})

describe('roam wedge recovery (prod: 10 ticks dist=4.6, 3x reset=stuck)', () => {
  function wedgedBot() {
    const bot = mockBot()
    bot._moving = true // executor reports moving while the body stands still
    bot.controls = {}
    bot.setControlState = (name, value) => { bot.controls[name] = value }
    return bot
  }

  it('re-issues a new point after two stuck resets, never raises (p4s)', () => {
    // Contract change (idkcraft-p4s): the ef3 detector handover is gone —
    // a wedge takes another stroll point, the body never goes to recover.
    const bot = wedgedBot()
    const ctx = { lastGoalKey: 'roam:1,64,1', stuckResets: 2, roamLastPos: pos(0, 64, 0), roamGoal: { x: 1, y: 64, z: 1 } }
    roam(bot, ctx, playerEntity(2), {})
    assert.equal(ctx.stuck, undefined)
    assert.equal(bot.calls.setGoal, 1)
    assert.match(ctx.lastGoalKey, /^roam:/)
    assert.equal(bot.controls.jump, undefined)
    assert.equal(ctx.stuckResets, 0)
  })

  it('stays quiet while a recover episode runs (no fact, no goal)', () => {
    const bot = wedgedBot()
    const ctx = { lastGoalKey: 'roam:1,64,1', stuckResets: 5, roamLastPos: pos(0, 64, 0), recovery: { action: 'sidestep', status: 'running' } }
    roam(bot, ctx, playerEntity(2), {})
    assert.equal(bot.calls.setGoal, 0)
    assert.equal(ctx.stuck || null, null)
  })

  it('a re-wedge at the same spot re-issues, never latches (p4s)', () => {
    // Contract change (idkcraft-p4s): no setStuck, no recoverLatch round-trip
    // for roam — every wedge (same spot or not) is just another point.
    const bot = wedgedBot()
    const ctx = { lastGoalKey: 'roam:1,64,1', stuckResets: 2, roamLastPos: pos(0, 64, 0), roamGoal: { x: 1, y: 64, z: 1 } }
    roam(bot, ctx, playerEntity(2), {})
    assert.equal(ctx.stuck, undefined)
    assert.equal(bot.calls.setGoal, 1)
    assert.equal(ctx.recoverLatch, undefined)
    ctx.roamGoal = { x: -3, y: 64, z: 4 }
    ctx.stuckResets = 2
    roam(bot, ctx, playerEntity(2), {})
    assert.equal(ctx.stuck, undefined)
    assert.equal(bot.calls.setGoal, 2)
  })

  it('keeps walking on a single stuck reset (no premature nudge)', () => {
    const bot = wedgedBot()
    const ctx = { lastGoalKey: 'roam:1,64,1', stuckResets: 1, roamLastPos: pos(0, 64, 0) }
    roam(bot, ctx, playerEntity(2), {})
    assert.equal(bot.calls.setGoal, 0)
    assert.equal(ctx.stuckResets, 1)
  })

  it('displacement zeroes the wedge counter (no nudge after real progress)', () => {
    const bot = wedgedBot()
    const ctx = { lastGoalKey: 'roam:1,64,1', stuckResets: 2, roamLastPos: pos(0, 64, 0) }
    bot.entity.position = pos(3, 64, 0) // moved 3 blocks since last tick
    roam(bot, ctx, playerEntity(2), {})
    assert.equal(bot.calls.setGoal, 0)
    assert.equal(ctx.stuckResets, 0)
  })
})

describe('roam stroll end to end (no follow yo-yo)', () => {
  it('sustains roam past 3 blocks and follows back past 6', async () => {
    const { stubBrain } = require('../src/brain')
    const bot = mockBot()
    const playerPos = pos(0, 64, 0)
    bot.players = { Steve: { username: 'Steve', entity: { id: 7, username: 'Steve', position: playerPos } } }
    bot.entity.position = pos(1, 64, 0)
    const ticker = createTicker({ bot, brain: stubBrain, tickMs: 10, idleTickMs: 10 })
    // Close and still: roam sets the stroll goal, the bot starts walking.
    let r = await ticker.tick()
    assert.equal(r.decision.action, 'roam')
    assert.equal(bot.calls.setGoal, 1)
    bot._moving = true
    // Walking out through 4 and 5.5 blocks: still roam, goal untouched.
    for (const d of [4, 5.5]) {
      bot.entity.position = pos(d, 64, 0)
      r = await ticker.tick()
      assert.equal(r.decision.action, 'roam')
      assert.equal(bot.calls.setGoal, 1) // no preemption mid-stroll
    }
    // Past the envelope: follow reclaims the body.
    bot.entity.position = pos(7, 64, 0)
    r = await ticker.tick()
    assert.equal(r.decision.action, 'follow')
    assert.equal(bot.calls.setGoal, 2)
  })
})

describe('roam hand-back never wedges the ticker', () => {
  it('a stroll resting at 6.4 blocks recovers instead of replaying cached roam forever', async () => {
    const { stubBrain } = require('../src/brain')
    const bot = mockBot()
    const playerPos = pos(0, 64, 0)
    bot.players = { Steve: { username: 'Steve', entity: { id: 7, username: 'Steve', position: playerPos } } }
    // Stroll out: 5.6 rounds to key 6 and caches a roam decision.
    bot.entity.position = pos(5.6, 64, 0)
    const ticker = createTicker({ bot, brain: stubBrain, tickMs: 10, idleTickMs: 10 })
    let r = await ticker.tick()
    assert.equal(r.decision.action, 'roam')
    assert.equal(bot.calls.setGoal, 1)
    // The stroll comes to rest at 6.4: same rounded key, so the cached roam
    // is redispatched without a brain call — it must walk back, not freeze.
    bot.entity.position = pos(6.4, 64, 0)
    r = await ticker.tick()
    assert.equal(r.calledBrain, false) // the wedge setup: stale roam, no fresh answer
    assert.equal(bot.calls.setGoal, 2) // walk-back goal issued instead of freezing
    // Walking back through 5.9 keeps the cached roam but stays silent while moving.
    bot._moving = true
    bot.entity.position = pos(5.9, 64, 0)
    r = await ticker.tick()
    assert.equal(bot.calls.setGoal, 2)
    // Back inside at distance 3 the key changes, the brain answers fresh roam.
    bot.entity.position = pos(3, 64, 0)
    r = await ticker.tick()
    assert.equal(r.decision.action, 'roam')
    assert.equal(r.calledBrain, true)
  })
})

describe('roam dispatch', () => {
  it('roam is wired in the dispatch table and drives a goal through the ticker', async () => {
    assert.equal(BEHAVIOURS.roam, roam)
    const bot = mockBot()
    bot.players = { Steve: { username: 'Steve', entity: playerEntity(2) } }
    const brain = { calls: 0, async decide() { this.calls++; return { action: 'roam', sprint: false, source: 'stub' } } }
    const ticker = createTicker({ bot, brain, tickMs: 10, idleTickMs: 10 })
    const r = await ticker.tick()
    assert.equal(r.decision.action, 'roam')
    assert.equal(bot.calls.setGoal, 1)
    assert.equal(bot.calls.stop, 0)
  })
})

describe('roam wedge without recover (idkcraft-p4s)', () => {
  it('two stuck resets re-issue a new point, never raise ctx.stuck', () => {
    const bot = mockBot()
    bot._moving = true // wedged executor claims motion, body stands still
    const player = playerEntity(2)
    const ctx = { lastGoalKey: '', stuckResets: 2, roamLastPos: pos(0, 64, 0) }
    roam(bot, ctx, player, {})
    assert.equal(ctx.stuck, undefined)
    assert.equal(bot.calls.setGoal, 1)
    assert.match(ctx.lastGoalKey, /^roam:/)
    // Still wedged on the next ticks: every re-issue is a new point, still no stuck.
    ctx.stuckResets = 2
    const key1 = ctx.lastGoalKey
    roam(bot, ctx, player, {})
    assert.equal(ctx.stuck, undefined)
    assert.equal(bot.calls.setGoal, 2)
  })
})

describe('roam-back latch re-arms on relocation (idkcraft-q0h round 2)', () => {
  it('relocation past the latch anchor raises again, same point stays latched', () => {
    // Round-1 core-2: the roam latch on the static site never cleared, so the
    // detector fired once per session. Release anchors the point; moving on
    // clears it.
    const bot = mockBot()
    bot._moving = true
    const site = { x: 20, y: 64, z: 0 }
    bot.entity.position = pos(0, 64, 0)
    const ctx = {
      lastGoalKey: 'roam-back:undefined', stuckResets: 2, roamLastPos: pos(0, 64, 0),
      recoverLatch: { by: 'roam', key: 'roam-back:undefined', goal: { x: 20, y: 64, z: 0 }, at: { x: 0, y: 64, z: 8 } },
    }
    roam(bot, ctx, { position: site }, {})
    assert.ok(ctx.stuck, 're-armed detector raises after relocation')
    assert.equal(ctx.stuck.by, 'roam')
    assert.deepEqual(ctx.stuck.goal, site)
    // Same wedge point: the latch still suppresses.
    const ctx2 = {
      lastGoalKey: 'roam-back:undefined', stuckResets: 2, roamLastPos: pos(0, 64, 0),
      recoverLatch: { by: 'roam', key: 'roam-back:undefined', goal: { x: 20, y: 64, z: 0 }, at: { x: 0, y: 64, z: 1 } },
    }
    roam(bot, ctx2, { position: site }, {})
    assert.equal(ctx2.stuck, undefined)
  })
})
