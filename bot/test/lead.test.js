'use strict'

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const lead = require('../src/behaviours/lead')
const recover = require('../src/behaviours/recover')
const { GIVE_UP_TICKS, WORK_STALL_TICKS } = require('../src/behaviours/lead')

function pos(x, y, z) {
  const p = {
    x, y, z,
    distanceTo: (q) => Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z),
    clone() { return pos(p.x, p.y, p.z) }
  }
  return p
}

function mockBot() {
  const calls = { setGoal: 0, stop: 0, goals: [], dynamic: [], chats: [], controls: [] }
  const bot = {
    calls,
    username: 'IdkBot',
    _moving: false,
    entity: { position: pos(0, 64, 0) },
    pathfinder: {
      goal: null,
      setGoal: (goal, dynamic) => {
        calls.setGoal++
        calls.goals.push(goal)
        calls.dynamic.push(dynamic)
        bot.pathfinder.goal = goal
      },
      stop: () => { calls.stop++ },
      isMoving: () => bot._moving,
    },
    setControlState: (control, value) => { calls.controls.push([control, value]) },
    chat: (line) => { calls.chats.push(line) },
  }
  return bot
}

function playerEntity(x) {
  return { id: 7, username: 'Steve', position: pos(x, 64, 0) }
}

function orderAt(x, y = 64, z = 0, name = 'coal') {
  return { name, pos: pos(x, y, z) }
}

describe('lead behaviour', () => {
  it('issues GoalNear(pos, 2) once with key lead:x,y,z', () => {
    const bot = mockBot()
    bot.entity.position = pos(0, 64, 0)
    const ctx = { lastGoalKey: '', lead: orderAt(10, 64, 0) }
    lead(bot, ctx, playerEntity(2), { distance_to_player: 2 })
    assert.equal(bot.calls.setGoal, 1)
    const goal = bot.calls.goals[0]
    assert.equal(goal.constructor.name, 'GoalNear')
    assert.equal(goal.x, 10)
    assert.equal(goal.y, 64)
    assert.equal(goal.z, 0)
    assert.equal(goal.rangeSq, 4) // range 2
    assert.equal(bot.calls.dynamic[0], false) // static ore goal, like roam
    assert.equal(ctx.lastGoalKey, 'lead:10,64,0')
  })

  it('does not re-issue while already moving to the ore', () => {
    const bot = mockBot()
    bot._moving = true
    const ctx = { lastGoalKey: 'lead:10,64,0', lead: orderAt(10, 64, 0) }
    lead(bot, ctx, playerEntity(2), { distance_to_player: 2 })
    assert.equal(bot.calls.setGoal, 0)
    assert.equal(bot.calls.stop, 0)
  })

  it('spaces retries while stalled instead of re-issuing every tick', () => {
    const bot = mockBot()
    const ctx = { lastGoalKey: 'lead:10,64,0', lead: orderAt(10, 64, 0), leadStuck: 0 }
    for (let t = 0; t < 5; t++) lead(bot, ctx, playerEntity(2), { distance_to_player: 2 })
    assert.equal(bot.calls.setGoal, 0) // ticks 1-5: counting, no retry yet
    lead(bot, ctx, playerEntity(2), { distance_to_player: 2 }) // 6th stationary tick
    assert.equal(bot.calls.setGoal, 1) // one spaced retry, not six
  })

  it('waits when the player falls > 12 behind, resumes at <= 8', () => {
    const bot = mockBot()
    bot._moving = true
    const ctx = { lastGoalKey: 'lead:10,64,0', lead: orderAt(10, 64, 0) }
    lead(bot, ctx, playerEntity(20), { distance_to_player: 13 })
    assert.equal(ctx.lead.waiting, true)
    assert.equal(bot.calls.stop, 1) // hold: halt the live path
    assert.equal(ctx.lastGoalKey, 'idle')
    // Still far: keep holding, issue no goal.
    bot._moving = false
    bot.pathfinder.goal = null
    lead(bot, ctx, playerEntity(20), { distance_to_player: 9 })
    assert.equal(ctx.lead.waiting, true)
    assert.equal(bot.calls.setGoal, 0)
    // Back within 8: resume with a fresh goal.
    lead(bot, ctx, playerEntity(5), { distance_to_player: 8 })
    assert.equal(ctx.lead.waiting, false)
    assert.equal(bot.calls.setGoal, 1)
    assert.equal(ctx.lastGoalKey, 'lead:10,64,0')
  })

  it('wait boundary: 12 keeps walking, 12.1 waits; resume needs <= 8', () => {
    const at12 = mockBot()
    const ctx12 = { lastGoalKey: '', lead: orderAt(30, 64, 0) }
    lead(at12, ctx12, playerEntity(12), { distance_to_player: 12 })
    assert.equal(ctx12.lead.waiting, undefined)
    assert.equal(at12.calls.setGoal, 1)
    const over = mockBot()
    const ctxOver = { lastGoalKey: '', lead: orderAt(30, 64, 0) }
    lead(over, ctxOver, playerEntity(13), { distance_to_player: 12.1 })
    assert.equal(ctxOver.lead.waiting, true)
    assert.equal(over.calls.setGoal, 0)
    // 8.1 while waiting: still holding.
    lead(over, ctxOver, playerEntity(8.1), { distance_to_player: 8.1 })
    assert.equal(ctxOver.lead.waiting, true)
    assert.equal(over.calls.setGoal, 0)
  })

  it('waiting cancels a stationary live goal via setGoal(null) without latching stop', () => {
    const bot = mockBot()
    bot._moving = false
    bot.pathfinder.goal = { some: 'live-goal' }
    let nulled = 0
    const origSet = bot.pathfinder.setGoal
    bot.pathfinder.setGoal = (g, d) => { if (g === null) nulled++; return origSet(g, d) }
    const ctx = { lastGoalKey: 'lead:10,64,0', lead: orderAt(10, 64, 0) }
    lead(bot, ctx, playerEntity(20), { distance_to_player: 15 })
    assert.equal(bot.calls.stop, 0) // empty path: never stop (would latch)
    assert.equal(nulled, 1) // stationary live goal cancelled
    assert.equal(ctx.lastGoalKey, 'idle')
  })

  it('arrival within 2 blocks chats once and clears the order', () => {
    const bot = mockBot()
    bot.entity.position = pos(9, 64, 0)
    const ctx = { lastGoalKey: 'lead:10,64,0', lead: orderAt(10, 64, 0, 'coal') }
    lead(bot, ctx, playerEntity(9), { distance_to_player: 0 })
    assert.deepEqual(bot.calls.chats, ['here: coal at 10 64 0; following you again'])
    assert.equal(ctx.lead, null)
    assert.equal(bot.calls.setGoal, 0)
  })

  it('arrival from a block centre matches the goal measure (12.5,0.5 vs ore at 10)', () => {
    // GoalNear.isEnd passes on feet block (12,64,0): dx=2 exactly. The entity
    // stands at the block centre, 2.55 float blocks away — a float arrival
    // check would walk past this into 'cannot reach'.
    const bot = mockBot()
    bot.entity.position = pos(12.5, 64, 0.5)
    const ctx = { lastGoalKey: 'lead:10,64,0', lead: orderAt(10, 64, 0, 'coal') }
    lead(bot, ctx, playerEntity(12), { distance_to_player: 1 })
    assert.deepEqual(bot.calls.chats, ['here: coal at 10 64 0; following you again'])
    assert.equal(ctx.lead, null)
  })

  it('arrival boundary: 2.0 arrives, 2.1 keeps walking', () => {
    const near = mockBot()
    near.entity.position = pos(8, 64, 0)
    const ctxNear = { lastGoalKey: '', lead: orderAt(10, 64, 0, 'coal') }
    lead(near, ctxNear, playerEntity(8), { distance_to_player: 0 })
    assert.equal(ctxNear.lead, null)
    assert.deepEqual(near.calls.chats, ['here: coal at 10 64 0; following you again'])
    const far = mockBot()
    far.entity.position = pos(7.9, 64, 0)
    const ctxFar = { lastGoalKey: '', lead: orderAt(10, 64, 0, 'coal') }
    lead(far, ctxFar, playerEntity(7.9), { distance_to_player: 0 })
    assert.ok(ctxFar.lead)
    assert.deepEqual(far.calls.chats, [])
    assert.equal(far.calls.setGoal, 1)
  })

  it('raises the stuck fact, then gives up after an episode with no progress', () => {
    // ef3: the first stall is a detector now (no sidestep — the recover menu
    // moves the body between the strikes). Restoring the nudge fails this
    // test (a GoalNear fires, no fact).
    const bot = mockBot()
    const ctx = { lastGoalKey: 'lead:10,64,0', lead: orderAt(10, 64, 0, 'diamond_ore'), leadStuck: 0 }
    for (let t = 0; t <= GIVE_UP_TICKS + 1; t++) {
      lead(bot, ctx, playerEntity(2), { distance_to_player: 2 })
      assert.ok(ctx.lead, `gave up early at tick ${t}`)
    }
    assert.deepEqual(ctx.stuck, { by: 'lead', goal: { x: 10, y: 64, z: 0 }, key: 'lead:10,64,0' })
    assert.equal(bot.calls.goals.filter((goal) => goal.rangeSq === 1).length, 0)
    assert.ok(!ctx.lead.nudged)
    // The episode ran and ended without progress: drive the real release()
    // (what the ticker leaves behind), not a hand-made copy.
    ctx.recovery = { action: 'sidestep', source: 'fsm', model: null, status: 'done' }
    recover.release(bot, ctx, 'done')
    assert.equal(ctx.stuck, null)
    assert.equal(ctx.recovery, null)
    assert.equal(ctx.lead.nudged, true)
    assert.equal(ctx.lead.nudgedAt, 10, 'release marks the no-gain point')
    assert.equal(ctx.lead.stuckTicks, 0)
    for (let t = 0; t <= GIVE_UP_TICKS + 1; t++) {
      lead(bot, ctx, playerEntity(2), { distance_to_player: 2 })
      if (t < GIVE_UP_TICKS) assert.ok(ctx.lead, `gave up early at tick ${t}`)
    }
    assert.equal(ctx.lead, null)
    assert.ok(bot.calls.chats.some((l) => l === 'cannot reach diamond_ore at 10 64 0; following you again'))
  })

  it('moving resets the give-up budget', () => {
    const bot = mockBot()
    const order = orderAt(10, 64, 0)
    order.lastPos = pos(-1, 64, 0)
    order.stuckTicks = 9
    const ctx = { lastGoalKey: 'lead:10,64,0', lead: order }
    bot._moving = true
    lead(bot, ctx, playerEntity(2), { distance_to_player: 2 })
    assert.equal(order.stuckTicks, 0)
    assert.ok(ctx.lead)
  })

  it('raises the fact (no nudge) when isMoving stays true without displacement', () => {
    // ef3: same detector, executor-wedged branch. The jump + GoalNear moved
    // to the sidestep primitive; the order survives until an episode runs.
    const bot = mockBot()
    bot._moving = true
    const ctx = { lastGoalKey: 'lead:10,64,0', lead: orderAt(10, 64, 0, 'iron_ore') }
    const originalNow = Date.now
    let now = 1000
    Date.now = () => now
    try {
      for (let t = 0; t < GIVE_UP_TICKS + 2; t++) {
        lead(bot, ctx, playerEntity(2), { distance_to_player: 2 })
        now += 1000
      }
      assert.ok(ctx.lead)
      assert.deepEqual(ctx.stuck, { by: 'lead', goal: { x: 10, y: 64, z: 0 }, key: 'lead:10,64,0' })
      assert.equal(bot.calls.goals.filter((goal) => goal.rangeSq === 1).length, 0)
      assert.deepEqual(bot.calls.controls, [])
      assert.deepEqual(bot.calls.chats, [])
      // Post-episode with no progress (real release): the strike gives up.
      ctx.recovery = { action: 'sidestep', source: 'fsm', model: null, status: 'done' }
      recover.release(bot, ctx, 'done')
      assert.equal(ctx.lead.nudgedAt, 10)
      for (let t = 0; t < GIVE_UP_TICKS + 2 && ctx.lead; t++) {
        lead(bot, ctx, playerEntity(2), { distance_to_player: 2 })
        now += 1000
      }
      assert.equal(ctx.lead, null)
      assert.deepEqual(bot.calls.chats, ['cannot reach iron_ore at 10 64 0; following you again'])
    } finally {
      Date.now = originalNow
    }
  })

  it('does not count stationary mining as a lead stall', () => {
    const bot = mockBot()
    bot._moving = true
    bot.pathfinder.isMining = () => true
    const ctx = { lastGoalKey: 'lead:10,64,0', lead: orderAt(10, 64, 0, 'iron_ore') }
    const originalNow = Date.now
    let now = 1000
    Date.now = () => now
    try {
      for (let t = 0; t < GIVE_UP_TICKS * 3; t++) {
        lead(bot, ctx, playerEntity(2), { distance_to_player: 2 })
        now += 1000
      }
      assert.ok(ctx.lead)
      assert.equal(bot.calls.goals.some((goal) => goal.rangeSq === 1), false)
      assert.equal(bot.calls.chats.some((line) => line.includes('blocks left')), false)
    } finally {
      Date.now = originalNow
    }
  })

  it('raises the fact on a mining stall, gives up after an episode with no progress', () => {
    // ef3: the work-stall strike is a detector too; the episode runs between
    // the strikes like the idle-stall path.
    const bot = mockBot()
    bot._moving = true
    bot.pathfinder.isMining = () => true
    const ctx = { lastGoalKey: 'lead:10,64,0', lead: orderAt(10, 64, 0, 'iron_ore') }
    const originalNow = Date.now
    let now = 1000
    Date.now = () => now
    try {
      for (let t = 0; t < WORK_STALL_TICKS + 2; t++) {
        lead(bot, ctx, playerEntity(2), { distance_to_player: 2 })
        now += 1000
      }
      assert.ok(ctx.lead)
      assert.deepEqual(ctx.stuck, { by: 'lead', goal: { x: 10, y: 64, z: 0 }, key: 'lead:10,64,0' })
      assert.equal(bot.calls.goals.filter((goal) => goal.rangeSq === 1).length, 0)
      ctx.stuck = null
      ctx.recovery = null
      ctx.lead.nudged = true
      ctx.lead.workTicks = 0
      for (let t = 0; t < WORK_STALL_TICKS + 2 && ctx.lead; t++) {
        lead(bot, ctx, playerEntity(2), { distance_to_player: 2 })
        now += 1000
      }
      assert.equal(ctx.lead, null)
      assert.deepEqual(bot.calls.chats, ['cannot reach iron_ore at 10 64 0; following you again'])
    } finally {
      Date.now = originalNow
    }
  })

  it('does not carry mining ticks into the idle stall budget', () => {
    const bot = mockBot()
    bot._moving = true
    bot.pathfinder.isMining = () => true
    const ctx = { lastGoalKey: 'lead:10,64,0', lead: orderAt(10, 64, 0, 'iron_ore') }
    for (let t = 0; t < GIVE_UP_TICKS + 5; t++) {
      lead(bot, ctx, playerEntity(2), { distance_to_player: 2 })
    }
    bot.pathfinder.isMining = () => false
    lead(bot, ctx, playerEntity(2), { distance_to_player: 2 })
    assert.ok(ctx.lead)
    assert.equal(bot.calls.goals.some((goal) => goal.rangeSq === 1), false)
  })

  it('does not treat jumping in place as displacement progress', () => {
    const bot = mockBot()
    bot._moving = true
    const ctx = { lastGoalKey: 'lead:10,64,0', lead: orderAt(10, 64, 0, 'iron_ore') }
    for (let t = 0; t <= GIVE_UP_TICKS; t++) {
      bot.entity.onGround = false
      bot.entity.position = pos(0, 65, 0)
      lead(bot, ctx, playerEntity(2), { distance_to_player: 2 })
      bot.entity.onGround = true
      bot.entity.position = pos(0, 64, 0)
      lead(bot, ctx, playerEntity(2), { distance_to_player: 2 })
    }
    assert.ok(ctx.lead)
    assert.equal(bot.calls.goals.filter((goal) => goal.rangeSq === 1).length, 0)
    assert.deepEqual(ctx.stuck, { by: 'lead', goal: { x: 10, y: 64, z: 0 }, key: 'lead:10,64,0' })
    assert.equal(bot.calls.chats.some((line) => line.includes('blocks left')), false)
  })

  it('a sidestep away does not re-arm: walking back still gives up', () => {
    // Round-2 minor: nudgedAt is the wedge distance, not the release one.
    // Wedge at W (10 from the ore), episode ends 2 blocks further out, bot
    // walks back to W: blocksLeft(W) == stallDist, not below it, so the
    // next stall is still the second strike. min(stallDist, release) fails
    // this test if release() uses the release distance (12 < 12 re-arms).
    const bot = mockBot()
    bot.entity.position = pos(0, 64, 0)
    const ctx = { lastGoalKey: 'lead:10,64,0', lead: orderAt(10, 64, 0, 'iron_ore') }
    for (let t = 0; t <= GIVE_UP_TICKS + 1; t++) {
      lead(bot, ctx, playerEntity(2), { distance_to_player: 2 })
    }
    assert.deepEqual(ctx.stuck.by, 'lead')
    assert.equal(ctx.lead.stallDist, 10)
    // Episode sidesteps away: release 2 blocks further out.
    bot.entity.position = pos(-2, 64, 0)
    ctx.recovery = { action: 'sidestep', source: 'fsm', model: null, status: 'done' }
    recover.release(bot, ctx, 'done')
    assert.equal(ctx.lead.nudgedAt, 10, 'wedge distance wins over release distance')
    // Walk back to the wedge point: displacement without gain.
    bot.entity.position = pos(0, 64, 0)
    lead(bot, ctx, playerEntity(2), { distance_to_player: 2 })
    assert.ok(ctx.lead)
    assert.equal(ctx.lead.nudged, true, 'back at W, still no fresh strikes')
    // Next stall: second strike gives up.
    for (let t = 0; t <= GIVE_UP_TICKS + 1 && ctx.lead; t++) {
      lead(bot, ctx, playerEntity(2), { distance_to_player: 2 })
    }
    assert.equal(ctx.lead, null)
    assert.deepEqual(bot.calls.chats.at(-1), 'cannot reach iron_ore at 10 64 0; following you again')
  })

  it('nudged resets only on real gain, not on walking back to the wedge', () => {
    // M3 regression: clearing nudged on any displacement loops episodes
    // (sidestep moves -> release -> walk back -> moved=true resets nudged ->
    // new episode). Only getting closer than the release point re-arms.
    const recover = require('../src/behaviours/recover')
    const bot = mockBot()
    bot.entity.position = pos(0, 64, 0)
    const ctx = { lastGoalKey: 'lead:10,64,0', lead: orderAt(10, 64, 0, 'iron_ore') }
    ctx.lead.lastPos = pos(0, 64, 0)
    ctx.lead.nudged = true
    ctx.lead.nudgedAt = 10
    // Strafe without gain: displacement, but 11 blocks left stays >= 10.
    bot.entity.position = pos(0, 64, 5)
    lead(bot, ctx, playerEntity(2), { distance_to_player: 2 })
    assert.ok(ctx.lead)
    assert.equal(ctx.lead.nudged, true, 'no gain, no fresh strikes')
    // Walk past the release mark toward the goal: re-armed.
    bot.entity.position = pos(5, 64, 0)
    lead(bot, ctx, playerEntity(2), { distance_to_player: 2 })
    assert.ok(ctx.lead)
    assert.equal(ctx.lead.nudged, false, 'real gain re-arms the episode budget')
  })

  it('counts horizontal movement while airborne as progress', () => {
    const bot = mockBot()
    bot._moving = true
    bot.entity.onGround = false
    const ctx = { lastGoalKey: 'lead:100,64,0', lead: orderAt(100, 64, 0, 'iron_ore') }
    const originalNow = Date.now
    let now = 1000
    Date.now = () => now
    try {
      for (let x = 1; x <= 15; x++) {
        bot.entity.position = pos(x, x % 2 ? 65 : 64, 0)
        lead(bot, ctx, playerEntity(2), { distance_to_player: 2 })
        now += 1000
      }
      assert.ok(ctx.lead)
      assert.equal(bot.calls.goals.some((goal) => goal.rangeSq === 1), false)
      assert.ok(bot.calls.chats.some((line) => line.includes('blocks left')))
    } finally {
      Date.now = originalNow
    }
  })

  it('gives up after waiting longer than budget with chat and clears', () => {
    const bot = mockBot()
    const ctx = { lastGoalKey: 'lead:10,64,0', lead: orderAt(10, 64, 0, 'iron_ore') }
    lead(bot, ctx, playerEntity(20), { distance_to_player: 15 })
    assert.equal(ctx.lead.waiting, true)
    for (let t = 0; t < lead.WAIT_BUDGET_TICKS; t++) {
      assert.ok(ctx.lead, `gave up early at wait tick ${t}`)
      lead(bot, ctx, playerEntity(20), { distance_to_player: 15 })
    }
    assert.equal(ctx.lead, null)
    assert.deepEqual(bot.calls.chats, ['waiting for you, come to me (15 blocks)', 'giving up on iron_ore; following you again'])
  })

  it('resuming before wait budget expires resets the wait budget', () => {
    const bot = mockBot()
    const ctx = { lastGoalKey: 'lead:10,64,0', lead: orderAt(10, 64, 0, 'iron_ore') }
    lead(bot, ctx, playerEntity(20), { distance_to_player: 15 })
    for (let t = 0; t < 100; t++) {
      lead(bot, ctx, playerEntity(20), { distance_to_player: 15 })
    }
    assert.ok(ctx.lead)
    assert.equal(ctx.lead.waiting, true)
    lead(bot, ctx, playerEntity(5), { distance_to_player: 5 })
    assert.equal(ctx.lead.waiting, false)
    assert.equal(ctx.lead.waitTicks, 0)
    lead(bot, ctx, playerEntity(20), { distance_to_player: 15 })
    for (let t = 0; t < 100; t++) {
      lead(bot, ctx, playerEntity(20), { distance_to_player: 15 })
    }
    assert.ok(ctx.lead, 'wait budget was not reset after resume')
    assert.deepEqual(bot.calls.chats, [
      'waiting for you, come to me (15 blocks)',
      'going on, 10 blocks left',
      'waiting for you, come to me (15 blocks)',
    ])
  })

  it('announces wait and resume transitions once, and throttles progress to ten seconds', () => {
    const bot = mockBot()
    const ctx = { lastGoalKey: 'lead:20,64,0', lead: orderAt(20, 64, 0) }
    const originalNow = Date.now
    let now = 1000
    Date.now = () => now
    try {
      lead(bot, ctx, playerEntity(15), { distance_to_player: 15 })
      lead(bot, ctx, playerEntity(15), { distance_to_player: 15 })
      assert.deepEqual(bot.calls.chats, ['waiting for you, come to me (15 blocks)'])

      lead(bot, ctx, playerEntity(5), { distance_to_player: 5 })
      assert.equal(bot.calls.chats[1], 'going on, 20 blocks left')
      assert.equal(bot.calls.chats.length, 2)

      now += 9_999
      bot.entity.position = pos(1, 64, 0)
      lead(bot, ctx, playerEntity(5), { distance_to_player: 5 })
      assert.equal(bot.calls.chats.length, 2)
      now += 1
      bot.entity.position = pos(2, 64, 0)
      lead(bot, ctx, playerEntity(5), { distance_to_player: 5 })
      assert.deepEqual(bot.calls.chats.slice(2), ['coal: 18 blocks left'])
      lead(bot, ctx, playerEntity(5), { distance_to_player: 5 })
      assert.equal(bot.calls.chats.length, 3)
    } finally {
      Date.now = originalNow
    }
  })

  it('does nothing without an order or position', () => {
    const bot = mockBot()
    const ctx = { lastGoalKey: '' }
    lead(bot, ctx, playerEntity(2), { distance_to_player: 2 })
    lead(bot, { lastGoalKey: '', lead: { name: 'coal' } }, playerEntity(2), { distance_to_player: 2 })
    assert.equal(bot.calls.setGoal, 0)
    assert.deepEqual(bot.calls.chats, [])
  })
})
