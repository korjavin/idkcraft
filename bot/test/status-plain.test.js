'use strict'

// Owner 2026-11-14: status is <= 3 plain lines without internal ids; behaviour
// chat dedupes the same line for 10 min; step flips chat at most every 5 min.
const test = require('node:test')
const assert = require('node:assert/strict')
const { statusLines } = require('../src/orders')
const { say, SAY_SAME_MS } = require('../src/behaviours/util')
const { activityChat, ACTIVITY_CHAT_MS } = require('../src/goal')
const castle = require('../src/behaviours/castle')

test('status: castle work reads as progress, rate and the shortfall', () => {
  const now = 10 * 3600000
  const ctx = {
    work: true,
    step: 'castlefetch',
    castle: { site: { x: 0, y: 64, z: 0 }, progress: { done: 5671, total: 11493 } },
    castleFetch: { kind: 'stone', haul: 64 },
    castleRate: [{ at: now - 30 * 60000, done: 5521 }, { at: now, done: 5671 }],
  }
  const bot = { health: 6, food: 20, time: { timeOfDay: 1000 }, entity: { position: { x: 100, y: 64, z: 0 } } }
  const lines = statusLines(bot, ctx, null, now)
  assert.deepEqual(lines, [
    'Fetching castle material: 5671/11493 (49%), ~300 blocks/h',
    'Short on stone (need 64) — fetching it',
    'Health 6/20, 100 blocks from the castle',
  ])
  for (const l of lines) assert.doesNotMatch(l, /castle-rule|goal-fsm|castlefetch|step=/)
})

test('status: a healthy follower says one line', () => {
  const bot = { health: 20, food: 20, time: { timeOfDay: 1000 } }
  assert.deepEqual(statusLines(bot, { work: false }, 'Alex'), ['Following Alex'])
})

test('say: the same line within 10 min is suppressed', () => {
  const lines = []
  const bot = { chat: (l) => lines.push(l) }
  assert.equal(say(bot, 'took 12 white_wool from a chest', 0), true)
  assert.equal(say(bot, 'took 12 white_wool from a chest', SAY_SAME_MS - 1), false)
  assert.equal(say(bot, 'took 12 white_wool from a chest', SAY_SAME_MS), true)
  assert.equal(lines.length, 2)
})

test('activity chat: plain words, a new activity at most every 5 min', () => {
  const lines = []
  const bot = { chat: (l) => lines.push(l) }
  const ctx = {}
  activityChat(bot, ctx, 'building the castle', 0)
  activityChat(bot, ctx, 'fetching castle material', 60000)
  activityChat(bot, ctx, 'building the castle', ACTIVITY_CHAT_MS + 1)
  activityChat(bot, ctx, 'fetching castle material', 2 * ACTIVITY_CHAT_MS + 2)
  assert.deepEqual(lines, ['now building the castle', 'now fetching castle material'])
})

test('castle milestone: each new 10% once, the first scan only baselines', () => {
  const lines = []
  const bot = { chat: (l) => lines.push(l) }
  const ctx = {}
  castle.castleMilestone(bot, ctx, 450, 1000, 0)
  castle.castleMilestone(bot, ctx, 499, 1000, 60000)
  castle.castleMilestone(bot, ctx, 500, 1000, 120000)
  castle.castleMilestone(bot, ctx, 510, 1000, 180000)
  assert.deepEqual(lines, ['castle 50% built (500/1000)'])
})
