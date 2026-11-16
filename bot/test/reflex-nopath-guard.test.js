'use strict'
// Prod bot3 2026-11-16: creeper flee answered noPath every second for 55 min.
const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const { fleeReflex, reflexGuard } = require('../src/reflexes')

function pos(x, y, z) {
  return { x, y, z, distanceTo: (q) => Math.hypot(x - q.x, y - q.y, z - q.z), offset: (a, b, c) => pos(x + a, y + b, z + c) }
}
function bot(creeperAt) {
  return {
    entity: { position: pos(0, 64, 0) },
    entities: { 9: { id: 9, name: 'creeper', position: pos(...creeperAt), height: 1.7, isValid: true } },
    inventory: { items: () => [] },
    pathfinder: { isMoving: () => false, setGoal () {} },
    hits: [],
    lookAt () {},
    attack (e) { this.hits.push(e) },
  }
}

describe('reflex noPath / stale guard', () => {
  it('flee that keeps answering noPath gives the body back and logs the trigger', () => {
    const b = bot([4, 64, 0])
    const ctx = {}
    for (let i = 0; i < 5; i++) {
      assert.ok(fleeReflex(b, ctx))
      ctx.lastPathStatus = 'noPath'
    }
    assert.match(ctx.reflexTrigger, /threat=creeper tpos=4,64,0 tdist=4\.0 visible=/)
    assert.equal(fleeReflex(b, ctx), false) // 5th noPath in a row: gave up, goal work runs
    assert.equal(fleeReflex(b, ctx), false) // stays dropped while it does not close in
    b.entities[9].position = pos(2, 64, 0)
    ctx.lastPathStatus = 'none'
    assert.ok(fleeReflex(b, ctx)) // came closer: re-armed
  })
  it('dropped creeper in swing range gets hit instead of fled', () => {
    const b = bot([2.5, 64, 0])
    const ctx = { reflexDropped: { 'flee:9': 3 } }
    assert.ok(fleeReflex(b, ctx))
    assert.equal(b.hits.length, 1)
  })
  it('threat that does not come closer goes stale', () => {
    const ctx = {}
    assert.equal(reflexGuard(ctx, 'k', 5, 0), 'go')
    assert.equal(reflexGuard(ctx, 'k', 5, 10000), 'go')
    assert.equal(reflexGuard(ctx, 'k', 5, 16000), 'stale')
    assert.equal(reflexGuard(ctx, 'k', 5, 17000), 'dropped')
  })
})
