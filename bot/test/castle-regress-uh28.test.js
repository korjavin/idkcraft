'use strict'

// idkcraft-uh28: progress logs 'castle regress <n> missing=...' once per drop.

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const castle = require('../src/behaviours/castle')

describe('castle progress regress log (uh28)', () => {
  it('logs missing cells once per drop, capped at 10, never on growth', () => {
    const cells = []
    for (let i = 0; i < 14; i++) cells.push({ idx: i, kind: 'stone', x: i, y: 65, z: 7 })
    const world = new Map(cells.map((c) => [`${c.x},${c.y},${c.z}`, 'stone']))
    const bot = { blockAt: (p) => ({ name: world.get(`${p.x},${p.y},${p.z}`) || 'air' }) }
    const st = { site: { x: 0, y: 64, z: 0 }, rot: 0 }
    const ctx = {}
    const lines = []
    const orig = console.log
    console.log = (m) => lines.push(m)
    try {
      castle.progress(bot, st, cells, ctx)
      for (let i = 0; i < 12; i++) world.delete(`${i},65,7`)
      castle.progress(bot, st, cells, ctx)
      castle.progress(bot, st, cells, ctx) // same drop: silent
      world.set('0,65,7', 'stone') // grew, still below high-water: new count logs
      castle.progress(bot, st, cells, ctx)
    } finally { console.log = orig }
    assert.equal(lines[0], 'castle 14/14')
    const reg = lines.filter((l) => l.startsWith('castle regress'))
    assert.equal(reg.length, 2)
    assert.match(reg[0], /^castle regress 2 missing=(stone@\d+,65,7 ?){10}$/)
    assert.match(reg[1], /^castle regress 3 missing=/)
  })
})
