'use strict'

// Resource memory (idkcraft-atl.1): shared find store for the forage step.
// explore.js fills it from arrival scans; forage (atl.2) reads it.

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const resources = require('../src/resources')

function pos(x, y, z) {
  return { x, y, z, distanceTo: (q) => Math.hypot(x - q.x, y - q.y, z - q.z) }
}

describe('resource memory', () => {
  it('stores spots and dedupes by cell', () => {
    const ctx = {}
    const added = resources.noteSpots(ctx, [
      { x: 10, y: 20, z: 30, name: 'iron_ore', at: 1000 },
      { x: 10, y: 20, z: 30, name: 'iron_ore', at: 2000 },
      { x: 11, y: 20, z: 30, name: 'oak_log', at: 2000 },
    ])
    assert.equal(added, 2)
    assert.equal(resources.count(ctx), 2)
  })

  it('nearest returns the closest match, kinds filter by exact name', () => {
    const ctx = {}
    resources.noteSpots(ctx, [
      { x: 100, y: 64, z: 0, name: 'iron_ore', at: 1000 },
      { x: 10, y: 64, z: 0, name: 'diamond_ore', at: 1000 },
      { x: 12, y: 64, z: 0, name: 'oak_log', at: 1000 },
    ])
    assert.equal(resources.nearest(ctx, pos(0, 64, 0)).name, 'diamond_ore')
    assert.equal(resources.nearest(ctx, pos(0, 64, 0), ['iron_ore']).name, 'iron_ore')
    assert.equal(resources.nearest(ctx, pos(0, 64, 0), ['gold_ore']), null)
    assert.equal(resources.nearest({}, pos(0, 64, 0)), null)
  })

  it('caps at MAX_ITEMS, oldest out', () => {
    const ctx = {}
    const spots = []
    for (let i = 0; i < 300; i++) spots.push({ x: i, y: 64, z: 0, name: 'iron_ore', at: i })
    resources.noteSpots(ctx, spots)
    assert.ok(resources.count(ctx) <= 256)
    assert.equal(resources.nearest(ctx, pos(0, 64, 0)).x >= 300 - 256, true)
  })

  it('forget drops a mined-out cell by coords', () => {
    const ctx = {}
    resources.noteSpots(ctx, [{ x: 1, y: 2, z: 3, name: 'iron_ore' }], 1000)
    assert.equal(resources.count(ctx), 1)
    assert.equal(resources.forget(ctx, 1, 2, 3), true)
    assert.equal(resources.count(ctx), 0)
    assert.equal(resources.forget(ctx, 1, 2, 3), false)
    assert.equal(resources.forget(null, 1, 2, 3), false)
  })

  it('scan ingests ores and logs around the bot', () => {
    const spots = [
      { p: pos(10, 60, 0), id: 1 },
      { p: pos(20, 64, 5), id: 2 },
    ]
    const names = { '10,60,0': 'iron_ore', '20,64,5': 'oak_log' }
    const bot = {
      entity: { position: pos(0, 64, 0) },
      registry: { blocksByName: { iron_ore: { id: 1 }, oak_log: { id: 2 } } },
      // Honors options.matching like the real findBlocks: dropping an id
      // list from scan must drop that kind from memory.
      findBlocks: (opts) => spots.filter((s) => opts.matching.includes(s.id)).map((s) => s.p),
      blockAt: (p) => ({ name: names[`${p.x},${p.y},${p.z}`] }),
    }
    const ctx = {}
    const r = resources.scan(bot, ctx, { radius: 48, now: 5000 })
    assert.equal(r.added, 2)
    assert.equal(resources.count(ctx), 2)
    assert.equal(resources.nearest(ctx, pos(0, 64, 0), ['oak_log']).name, 'oak_log')
  })
})
