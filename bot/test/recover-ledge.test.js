'use strict'

// Ledge drop (prod 2026-11-11 V2d): a body perched on a 1x2 dirt bridge 4
// blocks over the ground; Baritone never steps off (fall > 3, 'Open set
// size: 0') and every sidestep/wait failed for 45 min. sidestep walks off
// the shallowest survivable ledge by hand: always when no side is walkable,
// and once a plain sidestep from the same cell has failed.

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const { Vec3 } = require('vec3')
const recover = require('../src/behaviours/recover')

const key = (x, y, z) => `${x},${y},${z}`
function pos(x, y, z) { return { x, y, z, distanceTo: (q) => Math.hypot(x - q.x, y - q.y, z - q.z), clone() { return pos(x, y, z) } } }

// Ground at y=56 around; the bridge cells (0,60,0) [+ (0,60,-1)] carry the body at y=61.
function world(bridge2, lava) {
  const solids = new Set([key(0, 60, 0)])
  if (bridge2) solids.add(key(0, 60, -1))
  for (let x = -4; x <= 4; x++) for (let z = -4; z <= 4; z++) solids.add(key(x, 56, z))
  return { solids, lava: lava || new Set() }
}
function bot(w) {
  return {
    entity: { position: pos(0.5, 61, 0.5), onGround: true },
    inventory: { items: () => [] },
    controls: {},
    setControlState(c, v) { this.controls[c] = !!v },
    lookAt() { return Promise.resolve() },
    blockAt(p) {
      const k = key(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z))
      const name = w.lava.has(k) ? 'lava' : w.solids.has(k) ? 'dirt' : 'air'
      return { name, position: new Vec3(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)), boundingBox: name === 'dirt' ? 'block' : 'empty' }
    },
    pathfinder: { goal: null, setGoal(g) { this.goal = g }, stop() {}, isMoving: () => false },
  }
}
const run = (b, ctx) => recover.RECOVER_MENU.sidestep.run(b, ctx)

describe('sidestep ledge drop', () => {
  it('a lone pillar 4 up: walks off by hand, done once landed lower', () => {
    const b = bot(world(false))
    const ctx = { recovery: {}, stuck: { by: 'x', goal: null } }
    assert.equal(run(b, ctx), 'running')
    assert.equal(ctx.recovery.st.ledge, 4)
    assert.equal(b.controls.forward, true, 'forward held, no pathfinder goal')
    assert.equal(b.pathfinder.goal, null)
    b.entity.position = pos(1.5, 57, 0.5)
    assert.equal(run(b, ctx), 'done')
    assert.equal(b.controls.forward, false)
  })
  it('a level neighbour: plain sidestep first, the ledge after it failed from that cell', () => {
    const b = bot(world(true))
    const ctx = { recovery: {}, stuck: { by: 'x', goal: null } }
    let r
    for (let i = 0; i < 20 && (r = run(b, ctx)) === 'running'; i++);
    assert.equal(r, 'failed:no-progress')
    assert.equal(ctx.recovery.st.ledge, undefined, 'first try is the pathfinder sidestep')
    ctx.recovery = {}
    assert.equal(run(b, ctx), 'running')
    assert.equal(ctx.recovery.st.ledge, 4, 'second try drops off the ledge')
  })
  it('health and landing gate: a 6-drop needs HP to spare, magma never', () => {
    const w = world(false); w.solids = new Set([key(0, 60, 0)])
    for (let x = -4; x <= 4; x++) for (let z = -4; z <= 4; z++) w.solids.add(key(x, 54, z))
    const b = bot(w)
    b.health = 6 // a 6-drop costs 3 HP -> 3 left < 4
    const ctx = { recovery: {}, stuck: { by: 'x', goal: null } }
    run(b, ctx)
    assert.equal(ctx.recovery.st.ledge, undefined, 'low health: no drop')
    b.health = 20
    const ctx2 = { recovery: {}, stuck: { by: 'x', goal: null } }
    run(b, ctx2)
    assert.equal(ctx2.recovery.st.ledge, 6)
    const b3 = bot(world(false))
    const orig = b3.blockAt.bind(b3)
    b3.blockAt = (p) => { const r = orig(p); return Math.floor(p.y) === 56 && r.name === 'dirt' ? { ...r, name: 'magma_block' } : r }
    const ctx3 = { recovery: {}, stuck: { by: 'x', goal: null } }
    run(b3, ctx3)
    assert.equal(ctx3.recovery.st.ledge, undefined, 'magma landing refused')
  })
  it('re-entry after a restart (fresh ctx, latch gone) at the same perch: plain try, then the ledge', () => {
    for (let restart = 0; restart < 2; restart++) {
      const b = bot(world(true))
      const ctx = { recovery: {}, stuck: { by: 'no-displacement', goal: null } }
      let r
      for (let i = 0; i < 20 && (r = run(b, ctx)) === 'running'; i++);
      assert.equal(r, 'failed:no-progress')
      ctx.recovery = {}
      assert.equal(run(b, ctx), 'running')
      assert.equal(ctx.recovery.st.ledge, 4)
    }
  })
  it('a ledge try that never lands fails and releases forward', () => {
    const b = bot(world(false))
    const ctx = { recovery: {}, stuck: { by: 'x', goal: null } }
    let r
    for (let i = 0; i < 20 && (r = run(b, ctx)) === 'running'; i++);
    assert.equal(r, 'failed:no-progress')
    assert.equal(b.controls.forward, false)
  })
  it('never onto lava, never deeper than the cap', () => {
    const lava = new Set()
    for (let x = -4; x <= 4; x++) for (let z = -4; z <= 4; z++) lava.add(key(x, 57, z))
    const b = bot(world(false, lava))
    const ctx = { recovery: {}, stuck: { by: 'x', goal: null } }
    run(b, ctx)
    assert.equal(ctx.recovery.st.ledge, undefined)
    const deep = world(false); deep.solids = new Set([key(0, 60, 0)])
    const b2 = bot(deep)
    const ctx2 = { recovery: {}, stuck: { by: 'x', goal: null } }
    run(b2, ctx2)
    assert.equal(ctx2.recovery.st.ledge, undefined)
  })
})
