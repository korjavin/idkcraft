'use strict'

// rest (idkcraft-p4s): with a player near, stroll near the player — never
// wander back to the site trap while the owner stands next to the bot.

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const rest = require('../src/behaviours/rest')

function pos(x, y, z) {
  return {
    x, y, z,
    distanceTo: (q) => Math.hypot(x - q.x, y - q.y, z - q.z),
    clone() { return pos(x, y, z) },
    floored() { return { x: Math.floor(x), y: Math.floor(y), z: Math.floor(z) } },
  }
}

function mockBot() {
  const calls = { setGoal: 0, goals: [] }
  const bot = {
    calls,
    username: 'IdkBot', players: {}, entities: {},
    spawnPoint: pos(0, 64, 0),
    entity: { position: pos(0, 64, 0), onGround: true },
    _moving: false,
    pathfinder: {
      goal: null,
      setGoal: (g, d) => { calls.setGoal++; calls.goals.push(g); bot.pathfinder.goal = g },
      isMoving: () => bot._moving,
    },
    chat: () => {},
  }
  return bot
}

describe('rest near player (idkcraft-p4s)', () => {
  it('strolls near the visible player, not the far site', () => {
    const bot = mockBot()
    const ctx = { lastGoalKey: '', home: { site: pos(100, 64, 100) } }
    const player = { id: 7, username: 'P', position: pos(5, 64, 0) }
    for (let i = 0; i < 20; i++) {
      rest(bot, ctx, player, {})
      const g = bot.calls.goals[bot.calls.goals.length - 1]
      const dPlayer = Math.hypot(g.x - 5, g.z - 0)
      const dSite = Math.hypot(g.x - 100, g.z - 100)
      assert.ok(dPlayer < dSite, `goal at ${g.x},${g.z} nearer site than player`)
    }
  })

  it('falls back to the site with nobody around', () => {
    const bot = mockBot()
    const ctx = { lastGoalKey: '', home: { site: pos(100, 64, 100) } }
    rest(bot, ctx, null, {})
    const g = bot.calls.goals[0]
    assert.ok(Math.hypot(g.x - 100, g.z - 100) <= 8, 'goal near site')
  })
})
