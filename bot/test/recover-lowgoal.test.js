'use strict'

// Low goal on open ground (prod bot2 2026-11-20): goal=low dist=29,
// pickaxe=yes, scaffold=0, walls=0, sidestep failed -> wait was the only
// option for 40 min. dig_through now cuts a staircase down toward a goal
// >= 2 below, and a wait-only gave-up fails the work step.

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const { Vec3 } = require('vec3')
const recover = require('../src/behaviours/recover')

const key = (x, y, z) => `${x},${y},${z}`
const pos = (x, y, z) => ({ x, y, z, distanceTo: (q) => Math.hypot(x - q.x, y - q.y, z - q.z), clone() { return pos(x, y, z) } })

function openBot() {
  const solids = new Set()
  for (let x = -3; x <= 35; x++) for (let z = -3; z <= 3; z++) solids.add(key(x, 60, z))
  return {
    username: 'IdkBot2', players: {}, entities: {}, health: 20, food: 20,
    entity: { position: pos(0.5, 61, 0.5), onGround: true },
    inventory: { items: () => [{ name: 'iron_pickaxe', count: 1 }] },
    controls: {},
    setControlState(c, v) { this.controls[c] = !!v },
    getControlState(c) { return !!this.controls[c] },
    blockAt(p) {
      const v = new Vec3(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z))
      const s = solids.has(key(v.x, v.y, v.z))
      return { name: s ? 'stone' : 'air', position: v, boundingBox: s ? 'block' : 'empty' }
    },
    async dig(b) { solids.delete(key(b.position.x, b.position.y, b.position.z)) },
    pathfinder: { goal: null, setGoal(g) { this.goal = g }, stop() {}, isMoving: () => false },
    chat() {},
  }
}

const flush = async () => { for (let i = 0; i < 3; i++) await new Promise((r) => setImmediate(r)) }

describe('low goal with a pickaxe on open ground', () => {
  it('offers dig_through (staircase down), not wait alone', () => {
    const bot = openBot()
    const ctx = { stuck: { by: 'gather', goal: { x: 29, y: 50, z: 0 } } }
    const f = recover.recoverFacts(bot, ctx, null, null)
    assert.equal(f.throughBlocked, true)
    assert.equal(recover.RECOVER_MENU.dig_through.feasible(f, ctx), true)
  })

  it('digs the floor ahead and walks into the step', async () => {
    const bot = openBot()
    const ctx = { stuck: { by: 'gather', goal: { x: 29, y: 50, z: 0 } }, recovery: { action: 'dig_through', status: 'running', st: null } }
    recover.run(bot, ctx)
    await flush()
    recover.run(bot, ctx)
    assert.equal(bot.controls.forward, true, 'cut clear: the body walks into it')
    bot.entity.position = pos(1.5, 60, 0.5)
    recover.run(bot, ctx)
    assert.equal(ctx.recovery.status, 'done')
    assert.equal(bot.controls.forward, false)
  })

  it('a wait-only gave-up fails the work step', () => {
    const bot = openBot()
    const ctx = { work: true, step: 'gather', stepStatus: null, stuck: { by: 'gather', goal: null }, recovery: { action: 'wait', source: 'only-option' } }
    recover.release(bot, ctx, 'gave-up')
    assert.equal(ctx.stepStatus, 'failed:stuck')
  })
})
