'use strict'

// prod 2026-11-15 bot3: acquire trips took 1-16 per walk; a trip now
// harvests the castle's whole remainder of the kind (pack-room capped).
const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const castleMod = require('../src/behaviours/castle')
const acquireMod = require('../src/behaviours/acquire')
const fetch = require('../src/behaviours/castlefetch')

const botOf = (items = []) => ({
  username: 'IdkBot',
  entity: { position: { x: 0, y: 64, z: 0 } },
  inventory: { items: () => items, emptySlotCount: () => 36 - items.length },
  registry: { blocksByName: {}, itemsByName: {} },
})

describe('acquire trips harvest in bulk', () => {
  for (const [kind, remain] of [['frame', 891], ['stone', 400], ['planks', 300]]) {
    it(`${kind}: the trip asks for the whole remainder, not the step batch`, (t) => {
      t.mock.method(castleMod, 'progressByKind', () => ({ [kind]: { total: remain + 10, done: 10 } }))
      let asked = null
      t.mock.method(acquireMod, 'acquire', (bot, ctx, item, n) => { asked = n; return 'running' })
      const ctx = { castle: { site: { x: 0, y: 64, z: 0 } }, castleWord: { kind, left: 8 } }
      assert.equal(fetch.acquireTick(botOf(), ctx, {}, { kind, short: 8 }), true)
      assert.ok(asked >= remain, `${kind}: asked ${asked} >= ${remain}`)
    })
  }

  it('the pack cap holds: never more than the free slots carry', (t) => {
    t.mock.method(castleMod, 'progressByKind', () => ({ stone: { total: 5000, done: 0 } }))
    let asked = null
    t.mock.method(acquireMod, 'acquire', (bot, ctx, item, n) => { asked = n; return 'running' })
    const full = Array.from({ length: 30 }, () => ({ name: 'dirt', count: 64 }))
    fetch.acquireTick(botOf(full), { castle: {}, castleWord: { kind: 'stone', left: 8 } }, {}, { kind: 'stone', short: 8 })
    assert.ok(asked < 6 * 64, `asked ${asked}`)
  })

  it('a pack that fills mid-harvest hands what it holds to the craft rung', (t) => {
    t.mock.method(castleMod, 'progressByKind', () => ({ stone: { total: 500, done: 0 } }))
    t.mock.method(acquireMod, 'acquire', () => 'failed:pack-full')
    const ctx = { castle: {}, castleWord: { kind: 'stone', left: 8 } }
    const f = {}
    assert.equal(fetch.acquireTick(botOf([{ name: 'cobblestone', count: 64 }]), ctx, f, { kind: 'stone', short: 8, acquire: true }), true)
    assert.equal(f.acquireDone, true)
    assert.ok(!(ctx.acquireHeld && ctx.acquireHeld.stone), 'no hold on a full pack')
  })
})
