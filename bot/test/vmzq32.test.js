'use strict'

// Bead idkcraft-vmzq.32: fresh memory + an ordered castle left ctx.home null
// all run (build, the only siter, is castle-vetoed; the rig spawn has no
// flat 7x6 site), and the night shelter needed a home, so the bot worked
// every night (rig: 113 deaths). A homeless active castle now gives the
// night to the shelter, and the shelter runs without a home.

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const goal = require('../src/goal')
const { shelter } = require('../src/behaviours/home')

function pos(x, y, z) {
  const p = { x, y, z, distanceTo: (q) => Math.hypot(x - q.x, y - q.y, z - q.z) }
  p.clone = () => pos(p.x, p.y, p.z)
  p.floored = () => pos(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z))
  p.offset = (a, b, c) => pos(x + a, y + b, z + c)
  return p
}

const CASTLE = { x: 500, y: 64, z: 500 }

function bot(timeOfDay) {
  return {
    username: 'IdkBot',
    players: {},
    entities: {},
    health: 20,
    food: 20,
    time: { timeOfDay, day: 5 },
    spawnPoint: pos(0, 64, 0),
    entity: { position: pos(515, 64, 510), onGround: true, isInWater: false },
    inventory: { items: () => [] },
    blockAt: (p) => (Math.floor(p.y) < 64 ? { name: 'dirt', boundingBox: 'block' } : { name: 'air', boundingBox: 'empty' }),
    findBlocks: () => [],
    pathfinder: { goal: null, setGoal: () => {}, isMoving: () => false },
    setControlState: () => {},
    clearControlStates: () => {},
    chat: () => {},
  }
}
const ctxWith = (castle) => ({ castle, step: 'explore', stepStatus: 'done' })
const active = () => ({ site: { ...CASTLE }, rot: 0, phase: 'body' })

async function quiet(fn) {
  const orig = console.log
  console.log = () => {}
  try { return await fn() } finally { console.log = orig }
}

describe('vmzq.32 homeless castle night', () => {
  it('an active castle with no home shelters at dusk and night', async () => {
    for (const t of [12500, 15000]) {
      const r = await quiet(() => goal.decide(bot(t), ctxWith(active())))
      assert.equal(r.action, 'shelter', `t=${t}`)
    }
  })

  it('no castle, parked or complete: the homeless night is unchanged', async () => {
    for (const castle of [null, { ...active(), parked: true }, { ...active(), phase: 'complete' }]) {
      const r = await quiet(() => goal.decide(bot(15000), ctxWith(castle)))
      assert.notEqual(r.action, 'shelter', JSON.stringify(castle))
    }
  })

  it('the shelter behaviour runs without a home (no failed:no-home)', async () => {
    const ctx = ctxWith(active())
    await quiet(() => shelter(bot(15000), ctx, null, {}))
    assert.notEqual(ctx.stepStatus, 'failed:no-home')
  })
})
