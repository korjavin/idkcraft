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

  it('hands the body back with no goal when the bot is already > 6 away', () => {
    const bot = mockBot() // bot at 0,64,0
    const ctx = { lastGoalKey: '' }
    roam(bot, ctx, playerEntity(20), {})
    assert.equal(bot.calls.setGoal, 0)
    assert.equal(bot.calls.stop, 0)
    assert.equal(ctx.lastGoalKey, '') // untouched: the next tick answers follow
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
