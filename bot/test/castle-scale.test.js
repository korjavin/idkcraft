'use strict'

// Castle scale (owner 2026-11-12): `build castle N` grows every dimension
// by N percent; plain `build castle` and saved castles stay unscaled.

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const bp = require('../src/castle')
const { createTicker, handleChat } = require('../src/index')

function box(plan) {
  const m = (k, f) => f(...plan.map((c) => c[k]))
  return ['dx', 'dy', 'dz'].map((k) => m(k, Math.max) - m(k, Math.min) + 1)
}

function makeBot() {
  const pos = (x, y, z) => { const p = { x, y, z, distanceTo: (q) => Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z) }; return p }
  return {
    username: 'IdkBot',
    chats: [],
    chat(m) { this.chats.push(String(m)) },
    entity: { position: pos(0.5, 64, 0.5) },
    inventory: { items: () => [] },
    time: { timeOfDay: 6000, day: 1 },
    spawnPoint: pos(0, 64, 0),
    players: { Steve: { username: 'Steve', entity: { position: pos(0.5, 64, 0.5), yaw: Math.PI } } },
    blockAt: (p) => {
      const name = Math.floor(p.y) <= 63 ? 'dirt' : 'air'
      return { name, position: p, boundingBox: name === 'air' ? 'empty' : 'block' }
    },
    pathfinder: { isMoving: () => false, setGoal() {}, stop() {}, goal: null, movements: null, setMovements() {} },
    clearControlStates() {},
    on() {},
    once() {},
  }
}

function order(msg) {
  const bot = makeBot()
  const ticker = createTicker({ bot, brain: null, tickMs: 10, idleTickMs: 10 })
  handleChat(bot, ticker, 'Steve', msg)
  return { bot, st: bot._tickerCtx.castle }
}

describe('castle scale', () => {
  const base = bp.blueprintOf(bp.BLUEPRINT_VERSION)

  it('plain build castle is unchanged', () => {
    const { bot, st } = order('build castle')
    assert.ok(st, bot.chats.join('|'))
    assert.equal(st.blueprintVersion, bp.BLUEPRINT_VERSION)
    assert.equal(bp.blueprintOf(st.blueprintVersion), base)
  })

  it('build castle 100 doubles each dimension', () => {
    const { bot, st } = order('build castle 100')
    assert.ok(st, bot.chats.join('|'))
    const s = bp.blueprintOf(st.blueprintVersion)
    assert.deepEqual([s.W, s.D], [base.W * 2, base.D * 2])
    assert.deepEqual(box(s.PLAN), box(base.PLAN).map((n) => n * 2))
    assert.deepEqual(bp.siteDimensions(1, st.blueprintVersion), { w: base.D * 2, d: base.W * 2 })
    const stone = (p) => p.filter((c) => c.kind === 'stone').length
    assert.equal(stone(s.PLAN), stone(base.PLAN) * 8)
    const seen = new Set()
    for (const c of s.PLAN.filter((c) => ['door', 'torch', 'stairs'].includes(c.kind))) {
      assert.ok(!seen.has(`${c.dx},${c.dy - 1},${c.dz}`), `stacked ${c.kind}`)
      seen.add(`${c.dx},${c.dy},${c.dz}`)
    }
  })

  it('build castle 2 grows by 2% rounded to whole blocks', () => {
    const { bot, st } = order('build castle 2')
    assert.ok(st, bot.chats.join('|'))
    const s = bp.blueprintOf(st.blueprintVersion)
    assert.deepEqual([s.W, s.D], [Math.round(base.W * 1.02), Math.round(base.D * 1.02)])
    const [bx, by, bz] = box(base.PLAN)
    const [sx, sy, sz] = box(s.PLAN)
    assert.ok(sx > bx && sz > bz && sy >= by && sx <= Math.round(bx * 1.02) + 1)
    assert.ok(s.PLAN.length > base.PLAN.length)
  })

  it('over 100 percent is refused', () => {
    const { bot, st } = order('build castle 101')
    assert.equal(st, undefined)
    assert.match(bot.chats.pop(), /castle scale is 0\.\.100/)
  })

  it('saved castles keep their plan: plain versions are unscaled', () => {
    assert.equal(bp.blueprintOf(3), base)
    assert.equal(bp.blueprintOf(2).W, 31)
    assert.equal(bp.blueprintOf(undefined).version, 1)
  })
})
