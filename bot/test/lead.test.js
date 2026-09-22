'use strict'

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const lead = require('../src/behaviours/lead')
const { GIVE_UP_TICKS } = require('../src/behaviours/lead')

function pos(x, y, z) {
  const p = {
    x, y, z,
    distanceTo: (q) => Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z),
    clone() { return pos(p.x, p.y, p.z) }
  }
  return p
}

function mockBot() {
  const calls = { setGoal: 0, stop: 0, goals: [], dynamic: [], chats: [] }
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
    assert.deepEqual(bot.calls.chats, ['here: coal at 10 64 0'])
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
    assert.deepEqual(bot.calls.chats, ['here: coal at 10 64 0'])
    assert.equal(ctx.lead, null)
  })

  it('arrival boundary: 2.0 arrives, 2.1 keeps walking', () => {
    const near = mockBot()
    near.entity.position = pos(8, 64, 0)
    const ctxNear = { lastGoalKey: '', lead: orderAt(10, 64, 0, 'coal') }
    lead(near, ctxNear, playerEntity(8), { distance_to_player: 0 })
    assert.equal(ctxNear.lead, null)
    assert.deepEqual(near.calls.chats, ['here: coal at 10 64 0'])
    const far = mockBot()
    far.entity.position = pos(7.9, 64, 0)
    const ctxFar = { lastGoalKey: '', lead: orderAt(10, 64, 0, 'coal') }
    lead(far, ctxFar, playerEntity(7.9), { distance_to_player: 0 })
    assert.ok(ctxFar.lead)
    assert.deepEqual(far.calls.chats, [])
    assert.equal(far.calls.setGoal, 1)
  })

  it('gives up after N stationary ticks with cannot-reach and clears', () => {
    const bot = mockBot()
    const ctx = { lastGoalKey: 'lead:10,64,0', lead: orderAt(10, 64, 0, 'diamond_ore'), leadStuck: 0 }
    for (let t = 0; t <= GIVE_UP_TICKS; t++) {
      lead(bot, ctx, playerEntity(2), { distance_to_player: 2 })
      if (t < GIVE_UP_TICKS) assert.ok(ctx.lead, `gave up early at tick ${t}`)
    }
    assert.equal(ctx.lead, null)
    assert.ok(bot.calls.chats.some((l) => l === 'cannot reach diamond_ore at 10 64 0'))
  })

  it('moving resets the give-up budget', () => {
    const bot = mockBot()
    const ctx = { lastGoalKey: 'lead:10,64,0', lead: orderAt(10, 64, 0), leadStuck: 9 }
    bot._moving = true
    lead(bot, ctx, playerEntity(2), { distance_to_player: 2 })
    assert.equal(ctx.leadStuck, 0)
    assert.ok(ctx.lead)
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
    assert.deepEqual(bot.calls.chats, ['giving up on iron_ore'])
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
    assert.deepEqual(bot.calls.chats, [])
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

