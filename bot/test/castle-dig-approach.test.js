'use strict'

// Unreachable plan cells (prod 2026-11-16 bot3: torch cells 15-40 below,
// retired 'unreachable' x82, 'no castle material owed'): far() opens the
// stuck window for one dig-approach ladder before striking, and a retired
// open cell keeps its material on the castle word.

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const { Vec3 } = require('vec3')
const blueprint = require('../src/castle')
const castle = require('../src/behaviours/castle')

const SITE = { x: 100, y: 64, z: 200 }
const V = 2

describe('castle dig-approach for unreachable cells', () => {
  it('far() opens the stuck window once, then strikes', () => {
    const st = { site: { ...SITE }, rot: 0, blueprintVersion: V, blocked: {} }
    const ctx = { castle: st }
    const cell = { x: SITE.x, y: SITE.y - 20, z: SITE.z, kind: 'torch', idx: 5 }
    const bot = { entity: { position: new Vec3(SITE.x, SITE.y, SITE.z) } }
    const orig = console.log
    console.log = () => {}
    try {
      const now = Date.now()
      for (let i = 0; i <= castle.STRIKES; i++) castle.far(bot, ctx, st, cell, 4.5, now)
      assert.equal(st.blocked['2:5'], undefined, 'no strike yet')
      assert.ok(ctx.ownBreakUntil > now, 'stuck window open')
      for (let i = 0; i <= castle.STRIKES; i++) castle.far(bot, ctx, st, cell, 4.5, now)
      assert.equal(st.blocked['2:5'].why, 'unreachable')
    } finally { console.log = orig }
  })

  it('retired open cells still word their material in the body phase', () => {
    const plan = blueprint.absPlan(SITE, 0, V)
    const torches = plan.cells.filter((c) => c.kind === 'torch')
    assert.ok(torches.length > 0)
    const open = new Set(torches.map((c) => `${c.x},${c.y},${c.z}`))
    const LAID = { stone: 'cobblestone', planks: 'oak_planks', frame: 'oak_log', fence: 'oak_fence', door: 'oak_door', chest: 'chest' }
    const bot = {
      entity: { position: { x: SITE.x + 5.5, y: SITE.y, z: SITE.z + 5.5 } },
      inventory: { items: () => [] }, players: {}, pathfinder: { goal: null }, chat() {},
      blockAt(p) {
        const x = Math.floor(p.x); const y = Math.floor(p.y); const z = Math.floor(p.z)
        const k = `${x},${y},${z}`
        const c = plan.at.get(k)
        let name = 'air'
        if (!c) name = y < SITE.y ? 'dirt' : 'air'
        else if (!open.has(k) && blueprint.isPlaceTarget(c.kind)) name = LAID[c.kind] || 'cobblestone'
        return { name, position: new Vec3(x, y, z), boundingBox: name === 'air' ? 'empty' : 'block' }
      },
    }
    const now = Date.now()
    const blocked = Object.fromEntries(torches.map((c) => [`2:${c.idx}`, { tries: 6, until: 0, why: 'unreachable', retired: true, retiredAt: now }]))
    const ctx = { castle: { site: { ...SITE }, rot: 0, blueprintVersion: V, phase: 'body', blocked } }
    const orig = console.log
    console.log = () => {}
    try {
      castle.menuFact(bot, ctx, now)
      assert.equal(ctx.castleWord && ctx.castleWord.kind, 'torch')
    } finally { console.log = orig }
  })
})
