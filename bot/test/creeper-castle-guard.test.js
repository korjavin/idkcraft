'use strict'
// Prod bot3: fleeing creepers walked them into the own castle, which blew up.
const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const { fleeReflex } = require('../src/reflexes')
const { siteDimensions } = require('../src/castle')

function pos(x, y, z) {
  return { x, y, z, distanceTo: (q) => Math.hypot(x - q.x, y - q.y, z - q.z), offset: (a, b, c) => pos(x + a, y + b, z + c) }
}
function creeperBot(at, creeperAt) {
  const goals = []
  const hits = []
  return {
    goals,
    hits,
    entity: { position: pos(...at) },
    entities: { 9: { name: 'creeper', position: pos(...creeperAt), height: 1.7, isValid: true } },
    inventory: { items: () => [] },
    pathfinder: { isMoving: () => false, setGoal (g) { goals.push(g) } },
    lookAt () {},
    attack (e) { hits.push(e) },
  }
}

describe('creeper near own castle: hit and retreat away from the castle', () => {
  const { w, d } = siteDimensions(0)
  const cx = w / 2
  const cz = d / 2
  const castle = () => ({ castle: { site: { x: 0, y: 64, z: 0 }, rot: 0, phase: 'body' } })

  it('close creeper at the edge: swings and still goes outward, not deeper in', () => {
    const bot = creeperBot([w - 1, 64, cz], [w + 1, 64, cz])
    assert.ok(fleeReflex(bot, castle()))
    assert.equal(bot.hits.length, 1)
    assert.ok(bot.goals[0].x > w - 1)
  })
  it('creeper from the castle side: flee moves away from the centre, no swing out of range', () => {
    const bot = creeperBot([w + 2, 64, cz + 2], [w - 2, 64, cz + 2])
    assert.ok(fleeReflex(bot, castle()))
    assert.equal(bot.hits.length, 0)
    const g = bot.goals[0]
    assert.ok(Math.hypot(g.x - cx, g.z - cz) > Math.hypot(w + 2 - cx, 2))
  })
  it('far from the castle: plain flee, no hit', () => {
    const bot = creeperBot([w + 100, 64, 0], [w + 102, 64, 0])
    assert.ok(fleeReflex(bot, castle()))
    assert.equal(bot.hits.length, 0)
    assert.ok(bot.goals[0].x < w + 100)
  })
})
