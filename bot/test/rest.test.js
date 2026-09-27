'use strict'

// Unit tests for the rest step (idkcraft-fny): stroll around the home site
// through roam's walk-back branch, with the site re-wrapped as a real Vec3
// (GoalFollow.hasChanged needs position.floored()).
const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const Vec3 = require('vec3')
const rest = require('../src/behaviours/rest')

function pos(x, y, z) {
  const p = {
    x, y, z,
    distanceTo: (q) => Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z),
    clone() { return pos(p.x, p.y, p.z) },
  }
  return p
}

function mockBot({ spawnPoint } = {}) {
  const calls = { setGoal: 0, goals: [] }
  const bot = {
    calls,
    entity: { position: pos(0, 64, 0) },
    pathfinder: {
      setGoal: (goal) => { calls.setGoal++; calls.goals.push(goal) },
      isMoving: () => false,
    },
  }
  if (spawnPoint !== undefined) bot.spawnPoint = spawnPoint
  return bot
}

describe('rest behaviour', () => {
  it('wraps a plain-coords home site in a Vec3 walk-back goal', () => {
    const bot = mockBot()
    const ctx = { home: { site: { x: 10, y: 64, z: 0 } }, lastGoalKey: '' }
    assert.doesNotThrow(() => rest(bot, ctx, null, {}))
    assert.equal(bot.calls.setGoal, 1)
    const g = bot.calls.goals[0]
    assert.equal(g.constructor.name, 'GoalFollow')
    assert.equal(typeof g.entity.position.floored, 'function', 'site must be a real Vec3')
    const f = g.entity.position.floored() // live crash site: used to throw here
    assert.deepEqual({ x: f.x, y: f.y, z: f.z }, { x: 10, y: 64, z: 0 })
  })

  it('passes a Vec3 home site through unwrapped', () => {
    const bot = mockBot()
    const site = new Vec3(10, 64, 0)
    const ctx = { home: { site }, lastGoalKey: '' }
    rest(bot, ctx, null, {})
    assert.equal(bot.calls.setGoal, 1)
    assert.equal(bot.calls.goals[0].entity.position, site, 'same object, not a copy')
  })

  it('falls back to a plain-coords spawn point without ctx.home', () => {
    const bot = mockBot({ spawnPoint: { x: -10, y: 64, z: 0 } })
    const ctx = { lastGoalKey: '' }
    rest(bot, ctx, null, {})
    assert.equal(bot.calls.setGoal, 1)
    const g = bot.calls.goals[0]
    assert.equal(g.constructor.name, 'GoalFollow')
    assert.equal(typeof g.entity.position.floored, 'function', 'site must be a real Vec3')
    assert.deepEqual({ x: g.entity.position.x, y: g.entity.position.y, z: g.entity.position.z }, { x: -10, y: 64, z: 0 })
  })

  it('falls back to spawn point when home has no site', () => {
    const bot = mockBot({ spawnPoint: { x: -10, y: 64, z: 0 } })
    const ctx = { home: {}, lastGoalKey: '' }
    rest(bot, ctx, null, {})
    assert.equal(bot.calls.setGoal, 1)
    assert.equal(typeof bot.calls.goals[0].entity.position.floored, 'function', 'site must be a real Vec3')
  })

  it('passes a Vec3 spawn point through unwrapped', () => {
    const site = new Vec3(-10, 64, 0)
    const bot = mockBot({ spawnPoint: site })
    const ctx = { lastGoalKey: '' }
    rest(bot, ctx, null, {})
    assert.equal(bot.calls.setGoal, 1)
    assert.equal(bot.calls.goals[0].entity.position, site, 'same object, not a copy')
  })

  it('returns silently with no site anywhere', () => {
    const bot = mockBot()
    const ctx = { lastGoalKey: '' }
    assert.doesNotThrow(() => rest(bot, ctx, null, {}))
    assert.equal(bot.calls.setGoal, 0)
    assert.equal(ctx.lastGoalKey, '')
  })

  it('returns silently for a null bot without a home site', () => {
    assert.doesNotThrow(() => rest(null, { lastGoalKey: '' }, null, {}))
    assert.doesNotThrow(() => rest(undefined, {}, null, {}))
  })

  it('registers in BEHAVIOURS under rest', () => {
    const { BEHAVIOURS } = require('../src/index')
    assert.equal(BEHAVIOURS.rest, rest)
  })
})

// NOTE (idkcraft-fny mutant review): dropping `site &&` from the wrap guard
// survives the suite and is equivalent, not a gap — verified by probing:
// the `if (!site) return` above makes a falsy site unreachable there.
