'use strict'

// idkcraft-oqul.8: util.issueGoal is an exact pass-through for the literal
// `bot.pathfinder.setGoal(goal, dynamic); ctx.lastGoalKey = key` pair.

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { issueGoal } = require('../src/behaviours/util')

function fakeBot(throws) {
  const calls = []
  return { calls, pathfinder: { setGoal(...args) { calls.push({ args, key: this.ctx.lastGoalKey }); if (throws) throw new Error('boom') } } }
}

describe('issueGoal pass-through (oqul.8)', () => {
  it('forwards goal and dynamic unchanged, then writes the key', () => {
    for (const dynamic of [true, false]) {
      const bot = fakeBot(false)
      const ctx = { lastGoalKey: 'old' }
      bot.pathfinder.ctx = ctx
      const goal = { g: 1 }
      issueGoal(bot, ctx, goal, 'new', dynamic)
      assert.equal(bot.calls.length, 1)
      assert.equal(bot.calls[0].args.length, 2)
      assert.equal(bot.calls[0].args[0], goal)
      assert.equal(bot.calls[0].args[1], dynamic) // follow/fight stay dynamic (3nt.19/ak4)
      assert.equal(bot.calls[0].key, 'old') // key written after setGoal, as before
      assert.equal(ctx.lastGoalKey, 'new')
    }
  })

  it('a throwing setGoal leaves the key unwritten', () => {
    const bot = fakeBot(true)
    const ctx = { lastGoalKey: 'old' }
    bot.pathfinder.ctx = ctx
    assert.throws(() => issueGoal(bot, ctx, {}, 'new', false), /boom/)
    assert.equal(ctx.lastGoalKey, 'old')
  })

  it('no literal setGoal+key pair is left in src', () => {
    const re = /^([ \t]*)bot\.pathfinder\.setGoal\((.*), (true|false)\)\n\1ctx\.lastGoalKey = \w+\n/m
    const left = []
    for (const dir of ['src', 'src/behaviours']) {
      for (const f of fs.readdirSync(path.join(__dirname, '..', dir))) {
        if (f.endsWith('.js') && re.test(fs.readFileSync(path.join(__dirname, '..', dir, f), 'utf8'))) left.push(`${dir}/${f}`)
      }
    }
    assert.deepEqual(left, [], 'use issueGoal for the literal pattern')
  })
})
