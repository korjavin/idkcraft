'use strict'

// Site lighting (prod 2026-11-16 bot3: hostiles by day at the castle, deaths
// on site and in a cave below): dark spawnable cells get torches, a mob death
// zone lights first, and torches without coal go the charcoal way.

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const dark = require('../src/darkspots')
const castle = require('../src/behaviours/castle')
const S = require('../src/sources')
const { acquire } = require('../src/behaviours/acquire')

// World: stone floor at y 63 everywhere, plus extra blocks; air elsewhere.
function world(extra = {}, light) {
  return {
    blockAt: (p) => {
      const k = `${p.x},${p.y},${p.z}`
      const name = extra[k] || (p.y === 63 ? 'stone' : 'air')
      const b = { name, boundingBox: name === 'air' || name === 'torch' ? 'empty' : 'block' }
      if (light) b.light = light(p)
      return b
    },
  }
}
function roof(x0, x1, z0, z1, y) {
  const o = {}
  for (let x = x0; x <= x1; x++) for (let z = z0; z <= z1; z++) o[`${x},${y},${z}`] = 'stone'
  return o
}

describe('darkspots.scan', () => {
  const box = { x0: 0, x1: 4, y0: 64, y1: 64, z0: 0, z1: 4 }
  it('no light data: a roofed floor cell is dark, an open one is not, a near torch lights it', () => {
    const bot = world(roof(0, 4, 0, 4, 67))
    const out = dark.scan(bot, [box])
    assert.ok(out.length >= 1 && out.length <= 2, 'spacing: a torch or two cover the 5x5 room')
    assert.equal(out[0].y, 64)
    assert.equal(dark.scan(world({}), [box]).length, 0, 'open sky without light data reads lit')
    assert.equal(dark.scan(world({ ...roof(0, 4, 0, 4, 67), '2,64,2': 'torch' }), [box]).length, 0)
  })
  it('light data: block light 0 is dark (open or roofed), any light is not', () => {
    assert.ok(dark.scan(world({}, () => 0), [box]).length >= 1)
    assert.equal(dark.scan(world({}, () => 3), [box]).length, 0)
  })
  it('skip vetoes cells and hot boxes rank first', () => {
    const bot = world({}, () => 0)
    assert.equal(dark.scan(bot, [box], () => true).length, 0)
    const out = dark.scan(bot, [box, { x0: 40, x1: 40, y0: 64, y1: 64, z0: 40, z1: 40, hot: true }])
    assert.deepEqual(out[0], { x: 40, y: 64, z: 40, hot: true })
  })
})

describe('castle dark cells', () => {
  it('dark interior cells become torch cells with a round-trip idx; a mob death zone lights first', () => {
    const bot = world({}, (p) => (p.x === 50 && p.z === 50 ? 0 : (p.y === 64 && p.x === 2 && p.z === 2 ? 0 : 5)))
    const st = { site: { x: 0, y: 64, z: 0 }, rot: 0, blocked: {} }
    const ctx = { danger: { spots: [{ x: 50, y: 64, z: 50, at: Date.now(), r: 16 }] } }
    const orig = console.log
    console.log = () => {}
    let list
    try { list = castle.darkTargets(bot, ctx, st, Date.now()) } finally { console.log = orig }
    assert.ok(list.length >= 2, JSON.stringify(list))
    assert.deepEqual([list[0].x, list[0].y, list[0].z], [50, 64, 50], 'the death zone first')
    for (const c of list) {
      assert.equal(c.kind, 'torch')
      const back = castle.darkOf(st, c.idx)
      assert.deepEqual([back.x, back.y, back.z], [c.x, c.y, c.z])
    }
    assert.ok(list.some((c) => c.x === 2 && c.z === 2))
  })
})

describe('torch without coal: charcoal via acquire', () => {
  it('no coal ore near, logs held: the charcoal variant is taken (smelt leg), not a coal expedition', () => {
    const reg = S.DEFAULT_REG
    const id = (n) => reg.itemsByName[n].id
    const recipe = (fuel) => ({ delta: [{ id: id(fuel), count: -1 }, { id: id('stick'), count: -1 }, { id: id('torch'), count: 4 }], result: { count: 4 } })
    const bot = {
      registry: reg,
      entity: { position: { x: 0, y: 64, z: 0 } },
      inventory: { items: () => [{ name: 'stick', count: 2 }, { name: 'oak_log', count: 3 }], emptySlotCount: () => 10 },
      recipesAll: (itemId) => (itemId === id('torch') ? [recipe('coal'), recipe('charcoal')] : []),
      findBlocks: () => [],
      mine: () => { throw new Error('no coal expedition') },
    }
    assert.equal(acquire(bot, {}, 'torch', 4), 'failed:smelt-charcoal')
  })
})
