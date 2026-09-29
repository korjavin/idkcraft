'use strict'

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const lead = require('../src/behaviours/lead')
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

  it('holds the order while the detector counts, gives up when it disengages', () => {
    // 6x7.2: lead never raises — a stall waits out SUSPECT (an episode is
    // coming) and gives up once the detector disengages (MOVING on a parked
    // executor, COOLDOWN past an episode that already tried).
    const bot = mockBot()
    const ctx = { lastGoalKey: 'lead:10,64,0', lead: orderAt(10, 64, 0, 'diamond_ore'), leadStuck: 0, stuckState: 'SUSPECT' }
    for (let t = 0; t <= GIVE_UP_TICKS + 1; t++) {
      lead(bot, ctx, playerEntity(2), { distance_to_player: 2 })
      assert.ok(ctx.lead, `gave up early at tick ${t}`)
    }
    assert.equal(ctx.stuck || null, null, 'no fact from the order itself')
    assert.equal(bot.calls.goals.filter((goal) => goal.rangeSq === 1).length, 0)
    // The detector disengaged: the same stall is now a give-up.
    ctx.stuckState = 'MOVING'
    lead(bot, ctx, playerEntity(2), { distance_to_player: 2 })
    assert.equal(ctx.lead, null)
    assert.ok(bot.calls.chats.some((l) => l === 'cannot reach diamond_ore at 10 64 0; following you again'))
  })

  it('holds the order while an episode runs or waits', () => {
    // The escape may still reach the ore: a set fact waits, like SUSPECT.
    const bot = mockBot()
    const ctx = {
      lastGoalKey: 'lead:10,64,0', lead: orderAt(10, 64, 0, 'iron_ore'),
      stuck: { by: 'lead', goal: { x: 10, y: 64, z: 0 }, key: 'lead:10,64,0' },
    }
    for (let t = 0; t <= GIVE_UP_TICKS + 1; t++) {
      lead(bot, ctx, playerEntity(2), { distance_to_player: 2 })
      assert.ok(ctx.lead, `order dropped mid-episode at tick ${t}`)
    }
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

  it('a wedged executor gives up without a fact when the detector is quiet', () => {
    // 6x7.2: isMoving with no displacement still stalls the order, but the
    // fact is the central detector's, not lead's — a quiet detector means
    // give-up, no nudge, no episode from here.
    const bot = mockBot()
    bot._moving = true
    const ctx = { lastGoalKey: 'lead:10,64,0', lead: orderAt(10, 64, 0, 'iron_ore') }
    for (let t = 0; t < GIVE_UP_TICKS + 2 && ctx.lead; t++) {
      lead(bot, ctx, playerEntity(2), { distance_to_player: 2 })
    }
    assert.equal(ctx.lead, null)
    assert.equal(ctx.stuck || null, null)
    assert.equal(bot.calls.goals.filter((goal) => goal.rangeSq === 1).length, 0)
    assert.deepEqual(bot.calls.controls, [])
    assert.deepEqual(bot.calls.chats, ['cannot reach iron_ore at 10 64 0; following you again'])
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

  it('gives up on a mining stall without a fact when the detector is quiet', () => {
    // 6x7.2: the work-stall strike is a give-up, not a detector — through
    // the ticker the central detector fires first (slow entry at 30) and
    // the lead latch bounds the resume; direct, a quiet detector gives up.
    const bot = mockBot()
    bot._moving = true
    bot.pathfinder.isMining = () => true
    const ctx = { lastGoalKey: 'lead:10,64,0', lead: orderAt(10, 64, 0, 'iron_ore') }
    for (let t = 0; t < WORK_STALL_TICKS + 2 && ctx.lead; t++) {
      lead(bot, ctx, playerEntity(2), { distance_to_player: 2 })
    }
    assert.equal(ctx.lead, null)
    assert.equal(ctx.stuck || null, null)
    assert.equal(bot.calls.goals.filter((goal) => goal.rangeSq === 1).length, 0)
    assert.deepEqual(bot.calls.chats, ['cannot reach iron_ore at 10 64 0; following you again'])
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
    // Tower jumps read as standing still: the order stalls out and gives
    // up (no fact — the detector owns the body, lead owns the target).
    const bot = mockBot()
    bot._moving = true
    const ctx = { lastGoalKey: 'lead:10,64,0', lead: orderAt(10, 64, 0, 'iron_ore') }
    for (let t = 0; t <= GIVE_UP_TICKS && ctx.lead; t++) {
      bot.entity.onGround = false
      bot.entity.position = pos(0, 65, 0)
      lead(bot, ctx, playerEntity(2), { distance_to_player: 2 })
      if (!ctx.lead) break
      bot.entity.onGround = true
      bot.entity.position = pos(0, 64, 0)
      lead(bot, ctx, playerEntity(2), { distance_to_player: 2 })
    }
    assert.equal(ctx.lead, null)
    assert.equal(ctx.stuck || null, null)
    assert.equal(bot.calls.goals.filter((goal) => goal.rangeSq === 1).length, 0)
    assert.equal(bot.calls.chats.some((line) => line.includes('blocks left')), false)
    assert.deepEqual(bot.calls.chats, ['cannot reach iron_ore at 10 64 0; following you again'])
  })

  // 6x7.2: the nudged/nudgedAt/stallDist two-strike machinery is gone — lead
  // holds SUSPECT/episode and gives up otherwise, and the central COOLDOWN
  // (lead latch from release, pinned in stuck.test.js) bounds re-fires.

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

describe('lead distance edges (idkcraft-l71)', () => {
  it('plain positions measure by hypot and wait when far', () => {
    // No distanceTo anywhere (snapshotted positions): hypot still meters
    // the gap, and a far player parks the order in waiting.
    const bot = mockBot()
    bot.entity.position = { x: 0, y: 64, z: 0 }
    const target = { id: 7, username: 'Steve', position: { x: 100, y: 64, z: 0 } }
    const ctx = { lastGoalKey: '', lead: orderAt(10, 64, 0) }
    lead(bot, ctx, target, {})
    assert.equal(ctx.lead.waiting, true)
    assert.equal(ctx.lead.waitTicks, 1)
    assert.ok(bot.calls.chats.some((l) => l.startsWith('waiting for you')), `chats: ${bot.calls.chats}`)
  })

  it('unresolvable distance keeps waiting without resuming', () => {
    // No state distance, no target, no crash: dp null never satisfies the
    // resume check, the order holds its wait budget.
    const bot = mockBot()
    const ctx = { lastGoalKey: '', lead: { ...orderAt(10, 64, 0), waiting: true, waitTicks: 0 } }
    lead(bot, ctx, null, {})
    assert.equal(ctx.lead.waiting, true)
    assert.equal(ctx.lead.waitTicks, 1)
    assert.equal(ctx.lead.stuckTicks, 0)
  })
})
