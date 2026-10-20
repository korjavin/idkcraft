'use strict'

// idkcraft-qxql.3: a castlefetch leg re-opened with the same need and an
// unchanged pack is dead — past RESTART_MAX starts it fails once and the
// streak resets; any pack change or a different need breaks the streak.

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const fetch = require('../src/behaviours/castlefetch')

const botWith = (items) => ({ inventory: { items: () => items } })

describe('qxql.3 dead castlefetch restarts', () => {
  it('fails once past RESTART_MAX same-need starts with no pack change', () => {
    const ctx = {}
    const bot = botWith([{ name: 'cobblestone', count: 5 }])
    const d = { kind: 'stairs', short: 1 }
    for (let i = 0; i < fetch.RESTART_MAX; i++) assert.equal(fetch.deadRestart(bot, ctx, d), false)
    assert.equal(fetch.deadRestart(bot, ctx, d), true)
    assert.equal(ctx.castleFetchRestarts, null)
    assert.equal(fetch.deadRestart(bot, ctx, d), false) // once: the streak restarts
  })

  it('a pack change or another need breaks the streak', () => {
    const ctx = {}
    const items = [{ name: 'oak_log', count: 1 }]
    const bot = botWith(items)
    const d = { kind: 'planks', short: 33 }
    for (let i = 0; i < fetch.RESTART_MAX; i++) fetch.deadRestart(bot, ctx, d)
    items[0].count = 2 // a log chopped: progress
    assert.equal(fetch.deadRestart(bot, ctx, d), false)
    for (let i = 0; i < fetch.RESTART_MAX - 1; i++) fetch.deadRestart(bot, ctx, d)
    assert.equal(fetch.deadRestart(bot, ctx, { kind: 'planks', short: 29 }), false)
    assert.equal(fetch.deadRestart(bot, ctx, { kind: 'stone', short: 29 }), false)
  })

  it('a start more than 30 s after the last tick breaks the streak', () => {
    const ctx = {}
    const bot = botWith([])
    const d = { kind: 'stairs', short: 1 }
    for (let i = 0; i < fetch.RESTART_MAX; i++) fetch.deadRestart(bot, ctx, d)
    ctx.castleFetchRestarts.at -= 31 * 1000
    assert.equal(fetch.deadRestart(bot, ctx, d), false)
    assert.equal(ctx.castleFetchRestarts.n, 1)
  })
})
