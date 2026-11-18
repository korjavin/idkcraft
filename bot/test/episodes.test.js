'use strict'

// Episode memory (idkcraft-8hpy.5): record -> persist -> recall, fallback
// bias toward past successes, LRU cap.

const { it } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const episodes = require('../src/episodes')
const memory = require('../src/memory')
const { fallbackRank } = require('../src/task')

const bot = { username: 'EpBot', spawnPoint: { x: 0, y: 64, z: 0 } }
const quiet = (fn) => {
  const log = console.log
  console.log = () => {}
  try { return fn() } finally { console.log = log }
}

it('record, persist and recall round-trip', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ep-'))
  const file = path.join(dir, 'bot.json')
  const ctx = { step: 'castle' }
  quiet(() => {
    episodes.record(bot, ctx, 'castle', 'gather', 'progress', 5000, 1)
    episodes.record(bot, ctx, 'castle', 'explore-far', 'flat', 9000, 2)
  })
  assert.equal(memory.save(bot, ctx, file, 10), true)
  const ctx2 = { step: 'castle' }
  memory.restore(bot, ctx2, file, 20)
  assert.equal(ctx2.episodes.length, 2)
  const past = quiet(() => episodes.recall(bot, ctx2, 'castle'))
  assert.deepEqual(past[0], { choice: 'gather', outcome: 'progress', n: 1, successRate: 1 })
  assert.ok(past.find((p) => p.choice === 'explore-far' && p.successRate === 0))
})

it('fallback prefers the past success', () => {
  const offered = [{ id: 'explore-far' }, { id: 'stay' }]
  const ctx = { step: 'castle' }
  quiet(() => episodes.recall(bot, ctx, 'castle'))
  const base = fallbackRank('castle', offered).id
  const other = base === 'stay' ? 'explore-far' : 'stay'
  quiet(() => {
    episodes.record(bot, ctx, 'castle', other, 'progress', 1000, 1)
    episodes.recall(bot, ctx, 'castle')
  })
  assert.equal(fallbackRank('castle', offered).id, other)
  quiet(() => episodes.recall(bot, { step: 'castle' }, 'castle')) // reset module state
})

it('cap respected', () => {
  const ctx = {}
  for (let i = 0; i < episodes.EPISODES_MAX + 20; i++) episodes.record(bot, ctx, 'house', `c${i}`, 'flat', 1, i)
  assert.equal(ctx.episodes.length, episodes.EPISODES_MAX)
  assert.equal(ctx.episodes[0].choice, 'c20')
})
