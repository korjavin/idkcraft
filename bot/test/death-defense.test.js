'use strict'
// Prod bot3 2026-11-16: 3 daylight deaths, one with no known cause, one to a
// creeper at 8.4 by the castle. Death attribution + the wider castle creeper band.
const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const hurt = require('../src/hurt')
const { fleeReflex } = require('../src/reflexes')
const { siteDimensions } = require('../src/castle')

function pos(x, y, z) {
  return { x, y, z, distanceTo: (q) => Math.hypot(x - q.x, y - q.y, z - q.z), offset: (a, b, c) => pos(x + a, y + b, z + c) }
}
function mkBot({ blocks = {}, entities = {}, oxygen = 20, food = 20 } = {}) {
  const at = pos(0, 64, 0)
  return {
    entity: { position: at, onGround: true },
    entities,
    oxygenLevel: oxygen,
    food,
    blockAt: (p) => ({ name: blocks[Math.floor(p.y)] || 'air', boundingBox: blocks[Math.floor(p.y)] ? 'block' : 'empty' }),
  }
}

describe('hurt cause', () => {
  it('names the attacking mob, a creeper as explosion', () => {
    const now = 1000
    assert.equal(hurt.classify(mkBot(), { hurtSource: { name: 'zombie', at: now } }, 3, now), 'mob:zombie')
    assert.equal(hurt.classify(mkBot(), { hurtSource: { name: 'creeper', at: now } }, 9, now), 'explosion')
  })
  it('reads lava, a fresh fall, drowning, suffocation from the surroundings', () => {
    const now = 1000
    assert.equal(hurt.classify(mkBot({ blocks: { 64: 'lava' } }), {}, 4, now), 'lava')
    assert.equal(hurt.classify(mkBot(), { lastFall: { dist: 12, at: now } }, 9, now), 'fall')
    assert.equal(hurt.classify(mkBot({ oxygen: 0 }), {}, 2, now), 'drowning')
    assert.equal(hurt.classify(mkBot({ blocks: { 65: 'gravel' } }), {}, 1, now), 'suffocation')
  })
  it('nearby mobs without a source: creeper blast or the closest hostile', () => {
    const creeper = { name: 'creeper', position: pos(3, 64, 0) }
    const zombie = { name: 'zombie', position: pos(2, 64, 0) }
    assert.equal(hurt.classify(mkBot({ entities: { 1: creeper } }), {}, 8), 'explosion')
    assert.equal(hurt.classify(mkBot({ entities: { 2: zombie } }), {}, 2), 'mob:zombie')
    assert.equal(hurt.classify(mkBot(), {}, 1), 'unknown')
  })
  it('death cause is the last fresh hurt, then the log clears', () => {
    const ctx = {}
    hurt.noteHurt(mkBot(), Object.assign(ctx, { lastFall: { dist: 20, at: Date.now() } }), 20)
    assert.equal(hurt.deathCause(mkBot(), ctx), 'fall')
    assert.deepEqual(ctx.hurtLog, [])
  })
})

describe('creeper by own castle: lured off at 10 blocks, plain flee band stays 6', () => {
  const { w, d } = siteDimensions(0)
  function creeperBot(at, creeperAt) {
    const goals = []
    return {
      goals,
      entity: { position: pos(...at) },
      entities: { 9: { name: 'creeper', position: pos(...creeperAt), height: 1.7, isValid: true } },
      inventory: { items: () => [] },
      pathfinder: { isMoving: () => false, setGoal (g) { goals.push(g) } },
      lookAt () {},
      attack () {},
    }
  }
  it('creeper 8.5 away at the castle edge moves the body', () => {
    const bot = creeperBot([w + 1, 64, d / 2], [w + 9.5, 64, d / 2])
    assert.ok(fleeReflex(bot, { castle: { site: { x: 0, y: 64, z: 0 }, rot: 0, phase: 'body' } }))
    assert.equal(bot.goals.length, 1)
  })
  it('creeper 8.5 away far from any castle is ignored', () => {
    const bot = creeperBot([w + 100, 64, 0], [w + 108.5, 64, 0])
    assert.equal(fleeReflex(bot, { castle: { site: { x: 0, y: 64, z: 0 }, rot: 0, phase: 'body' } }), false)
  })
})
