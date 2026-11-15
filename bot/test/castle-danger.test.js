'use strict'

// Site danger (prod 2026-11-15 bot3): lost cells log `castle damage lost=N`,
// reset the cursor and put layable torch cells first while fresh.

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const castle = require('../src/behaviours/castle')

describe('castle site danger', () => {
  it('logs damage, rewinds the cursor, and torches first', () => {
    const cells = []
    for (let i = 0; i < 6; i++) cells.push({ idx: i, kind: 'stone', x: i, y: 65, z: 7 })
    cells.push({ idx: 6, kind: 'torch', x: 0, y: 66, z: 7 })
    const world = new Map(cells.slice(0, 6).map((c) => [`${c.x},${c.y},${c.z}`, 'stone']))
    const has = (p) => world.has(`${p.x},${p.y},${p.z}`)
    const bot = {
      blockAt: (p) => ({ name: world.get(`${p.x},${p.y},${p.z}`) || 'air', boundingBox: has(p) ? 'block' : 'empty' }),
      inventory: { items: () => [{ name: 'torch', count: 8 }, { name: 'cobblestone', count: 64 }] },
      entities: {},
    }
    const st = { site: { x: 0, y: 64, z: 0 }, rot: 0, blocked: {} }
    const ctx = {}
    const lines = []
    const orig = console.log
    console.log = (m) => lines.push(String(m))
    try {
      castle.progress(bot, st, cells, ctx)
      world.delete('5,65,7')
      ctx.castleCursor = 6
      castle.progress(bot, st, cells, ctx)
    } finally { console.log = orig }
    assert.ok(lines.includes('castle damage lost=1'), JSON.stringify(lines))
    assert.equal(ctx.castleCursor, 0)
    assert.equal(typeof ctx.castleDangerAt, 'number')
    assert.equal(castle.pick(bot, ctx, st, cells, 'k', Date.now()).idx, 6, 'torch first while dangerous')
  })

  it('a hostile in the site box stamps danger', () => {
    const bot = { blockAt: () => ({ name: 'air' }), entities: { 1: { name: 'zombie', position: { x: 10, y: 64, z: -5 } } } }
    const ctx = {}
    const orig = console.log
    console.log = () => {}
    try { castle.progress(bot, { site: { x: 0, y: 64, z: 0 }, rot: 0 }, [], ctx) } finally { console.log = orig }
    assert.equal(typeof ctx.castleDangerAt, 'number')
  })
})
