'use strict'

// idkcraft-neuc.65.3 (family A): prod v2 10-16 — every dusk gohome failed
// cannot-reach-home at the same approach cell beside its house, the
// shelter pillared on that cell (-85 82 -3) and the bot died there three
// nights running. Within 8 of tonight's gohome failure the shelter walks
// 8+ away and digs in; a failed walk pillars where it stands, once.

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const { Vec3 } = require('vec3')
const home = require('../src/behaviours/home')

function pos(x, y, z) {
  const p = { x, y, z, distanceTo: (q) => Math.hypot(x - q.x, y - q.y, z - q.z) }
  p.clone = () => pos(p.x, p.y, p.z)
  p.floored = () => pos(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z))
  return p
}

// Flat dirt world: solid at y <= 63, air above.
function flatBot(at) {
  return {
    username: 'IdkBot',
    players: {},
    entities: {},
    health: 20,
    food: 20,
    time: { timeOfDay: 15000, day: 5 },
    entity: { position: pos(at.x, at.y, at.z), onGround: true },
    inventory: { items: () => [] },
    controls: {},
    pathfinder: { goal: null, setGoal(g) { this.goal = g }, isMoving: () => false, stop() {} },
    setControlState(c, v) { this.controls[c] = !!v },
    clearControlStates() { this.controls = {} },
    findBlocks: () => [],
    chat: () => {},
    blockAt(p) {
      const y = Math.floor(p.y)
      const s = y <= 63
      return { name: s ? 'dirt' : 'air', position: new Vec3(Math.floor(p.x), y, Math.floor(p.z)), boundingBox: s ? 'block' : 'empty' }
    },
  }
}

function quiet(fn) {
  const orig = console.log
  const logs = []
  console.log = (m) => { logs.push(String(m)) }
  try { fn() } finally { console.log = orig }
  return logs
}

describe('neuc.65.3 shelter walks off tonight\'s gohome failure spot', () => {
  it('near the failure: walks 8+ away and digs in there', () => {
    const bot = flatBot({ x: 0.5, y: 64, z: 0.5 })
    const ctx = { step: 'shelter', gohomeLatch: { fails: 1, pos: { x: 0.5, y: 64, z: 0.5 }, day: 5 } }
    const logs = quiet(() => home.shelter(bot, ctx, null, {}))
    const w = ctx.shelter.dig && ctx.shelter.dig.walk
    assert.ok(w, `a walk-off spot, logs: ${logs.join(' | ')}`)
    assert.ok(Math.hypot(w.x + 0.5 - 0.5, w.z + 0.5 - 0.5) >= 8, `spot ${JSON.stringify(w)} is 8+ from the failure`)
    assert.ok(logs.some((l) => l.includes('shelter leaving the gohome failure spot')))
    assert.equal(ctx.recovery == null, true, 'no pillar on the failing cell')
  })

  it('a failure from another day, or far away, pillars as before', () => {
    for (const gl of [{ fails: 2, pos: { x: 0.5, y: 64, z: 0.5 }, day: 4 }, { fails: 2, pos: { x: 40, y: 64, z: 0 }, day: 5 }, null]) {
      const bot = flatBot({ x: 0.5, y: 64, z: 0.5 })
      const ctx = { step: 'shelter', gohomeLatch: gl }
      const logs = quiet(() => home.shelter(bot, ctx, null, {}))
      assert.ok(!logs.some((l) => l.includes('gohome failure spot')), JSON.stringify(gl))
      assert.ok(logs.some((l) => l.startsWith('shelter pillar')), `pillar in place, ${JSON.stringify(gl)}: ${logs.join(' | ')}`)
    }
  })

  it('a walk that never arrives pillars where it stands, and never walks again', () => {
    const bot = flatBot({ x: 0.5, y: 64, z: 0.5 })
    const ctx = { step: 'shelter', gohomeLatch: { fails: 1, pos: { x: 0.5, y: 64, z: 0.5 }, day: 5 } }
    let logs = []
    for (let i = 0; i < 20 && !logs.some((l) => l.includes('pillaring here')); i++) logs = logs.concat(quiet(() => home.shelter(bot, ctx, null, {})))
    assert.ok(logs.some((l) => l.includes('shelter walk-off failed:no-walk, pillaring here')), logs.join(' | '))
    assert.equal(ctx.shelter.dig, null)
    const next = quiet(() => home.shelter(bot, ctx, null, {}))
    assert.ok(next.some((l) => l.startsWith('shelter pillar')), `next tick pillars in place: ${next.join(' | ')}`)
    assert.ok(!next.some((l) => l.includes('gohome failure spot')), 'no second walk-off')
  })

  it('dawn ends the step', () => {
    const bot = flatBot({ x: 0.5, y: 64, z: 0.5 })
    const ctx = { step: 'shelter', gohomeLatch: { fails: 1, pos: { x: 0.5, y: 64, z: 0.5 }, day: 5 } }
    quiet(() => home.shelter(bot, ctx, null, {}))
    bot.time.timeOfDay = 1000
    quiet(() => home.shelter(bot, ctx, null, {}))
    assert.equal(ctx.stepStatus, 'done')
  })
})
