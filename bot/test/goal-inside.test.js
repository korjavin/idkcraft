'use strict'

// Inside flap (idkcraft-atl.13): the binary in/out flip on the home 2x2x2
// boundary re-fired the decision point all day (prod: 50% of re-decisions
// are facts-changed; forage<->rest every ~15-60s on inside alone). Inside
// gates only the night steps, so the day decision text hides it.

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const { goalFacts, goalText, decide } = require('../src/goal')
const resources = require('../src/resources')

function pos(x, y, z) {
  const p = {
    x, y, z,
    distanceTo: (q) => Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z),
    clone() { return pos(p.x, p.y, p.z) },
    floored() { return pos(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)) }
  }
  return p
}

// Home interior 2x2x2 at (1..2, 64..65, 1..2); boundary between x=2 and x=3.
function homeCtx() {
  return {
    home: {
      built: true,
      site: pos(0, 64, 0),
      interior: { min: { x: 1, y: 64, z: 1 }, max: { x: 2, y: 65, z: 2 } },
    },
  }
}

function dayBot(at) {
  return {
    entity: { position: at },
    inventory: { items: () => [{ name: 'stone_pickaxe', count: 1 }] },
    time: { timeOfDay: 6000 },
    spawnPoint: pos(0, 64, 0),
    players: {},
    chat: () => {},
  }
}

describe('inside hides in the day decision text (atl.13)', () => {
  it('goalText is steady across the boundary by day, truthful at night', () => {
    const outText = goalText(goalFacts(dayBot(pos(3, 64, 1)), homeCtx()))
    const inText = goalText(goalFacts(dayBot(pos(2, 64, 1)), homeCtx()))
    assert.equal(inText, outText, 'day text ignores the in/out flip')
    assert.match(inText, /inside=no/)
    // Feasibility still sees the truth.
    assert.equal(goalFacts(dayBot(pos(2, 64, 1)), homeCtx()).inside, 'yes')
    assert.equal(goalFacts(dayBot(pos(3, 64, 1)), homeCtx()).inside, 'no')
    // Night keeps the real value (stay/gohome need it).
    const nightBot = (at) => ({ ...dayBot(at), time: { timeOfDay: 18000 } })
    assert.match(goalText(goalFacts(nightBot(pos(2, 64, 1)), homeCtx())), /inside=yes/)
    assert.match(goalText(goalFacts(nightBot(pos(3, 64, 1)), homeCtx())), /inside=no/)
  })

  it('decide does not re-ask the brain on a day inside flap', async () => {
    const bot = dayBot(pos(3, 64, 1))
    const ctx = { ...homeCtx(), brain: null }
    resources.noteSpots(ctx, [{ x: 50, y: 60, z: 0, name: 'oak_log' }], 1000)
    let asks = 0
    ctx.brain = { source: 'test', ask: async () => { asks++; return 'forage' } }
    const first = await decide(bot, ctx)
    assert.equal(first.action, 'forage')
    assert.equal(asks, 1)
    // Flap across the boundary for 6 ticks: no re-decision, no re-ask.
    for (let i = 0; i < 6; i++) {
      bot.entity.position = (i % 2 === 0) ? pos(2, 64, 1) : pos(3, 64, 1)
      ctx.stepStatus = 'running'
      const r = await decide(bot, ctx)
      assert.equal(r.action, 'forage', `tick ${i}: step stable`)
    }
    assert.equal(asks, 1, 'brain asked once, flaps ignored')
    assert.equal(ctx.step, 'forage')
  })
})
