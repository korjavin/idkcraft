'use strict'

// Upkeep converges (prod bot4: one cell filled then dug as litter 17x; tidy
// counts flat for an hour): a floor-fill block is never litter, retired
// cells leave the counts, and a cell fixed repeatedly retires.

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const { Vec3 } = require('vec3')
const blueprint = require('../src/castle')
const castle = require('../src/behaviours/castle')

const SITE = { x: 100, y: 64, z: 200 }
const V = 2
const key = (x, y, z) => `${x},${y},${z}`

describe('castle upkeep converges', () => {
  const { w, d } = blueprint.siteDimensions(0, V)
  const at = blueprint.absPlan(SITE, 0, V).at
  // A 1x1 shaft in the apron ring, 2 deep: its bottom cell holds a lone cobble.
  const sx = SITE.x - 4, sz = SITE.z + 10, sy = SITE.y - 2
  const cells = new Map([[key(sx, sy, sz), 'cobblestone'], [key(sx, sy + 1, sz), 'air']])
  const bot = { blockAt(p) {
    const x = Math.floor(p.x), y = Math.floor(p.y), z = Math.floor(p.z)
    const n = cells.get(key(x, y, z)) ?? (y < SITE.y ? 'dirt' : 'air')
    return { name: n, position: new Vec3(x, y, z), boundingBox: n === 'air' || n === 'torch' ? 'empty' : 'block' }
  } }
  const fresh = () => ({ site: { ...SITE }, rot: 0, blueprintVersion: V, phase: 'complete', blocked: {} })

  it('a block in the floor-fill window is never litter; its air above is a fill hole', () => {
    assert.ok(!at.has(key(sx, sy, sz)))
    const st = fresh()
    assert.equal(castle.isLitter(bot, {}, st, sx, sy, sz, w, d), false)
    // fresh lone cobble around: a lone pillar shape, still not litter
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) cells.set(key(sx + dx, sy, sz + dz), 'air')
    assert.equal(castle.isLitter(bot, {}, st, sx, sy, sz, w, d), false)
  })

  it('a cell fixed three times retires and leaves the hole count', () => {
    const st = fresh()
    const list = castle.fillTargets(bot, {}, st, Date.now())
    assert.ok(list.length > 0)
    const before = castle.upkeep(bot, {}, st).holes
    const c = list[0]
    const ctx = {}
    for (let i = 0; i < 3; i++) castle.upkeepLog(ctx, st, c, 'ok')
    const e = Object.values(st.blocked)[0]
    assert.ok(e && e.retired && e.why === 'flipflop')
    assert.equal(castle.upkeep(bot, {}, st).holes, before - 1)
  })

  it('a scaffold column is litter, beside a tree too; a stray table is litter; chest/bed/door/torch never (owner 2026-11-18)', () => {
    const st = fresh()
    const px = SITE.x - 3, pz = SITE.z + 12
    // A hanging 1-wide bridge cell (air below): litter by shape...
    cells.set(key(px, SITE.y + 2, pz), 'dirt')
    assert.equal(castle.isLitter(bot, {}, st, px, SITE.y + 2, pz, w, d), true)
    // ...beside a tree too (owner: no tree-adjacency protection).
    cells.set(key(px + 1, SITE.y + 2, pz), 'oak_leaves')
    assert.equal(castle.isLitter(bot, {}, st, px, SITE.y + 2, pz, w, d), true)
    cells.set(key(px, SITE.y + 2, pz), 'crafting_table')
    assert.equal(castle.isLitter(bot, {}, st, px, SITE.y + 2, pz, w, d), true)
    for (const n of ['chest', 'white_bed', 'oak_door', 'torch']) {
      cells.set(key(px, SITE.y + 2, pz), n)
      assert.equal(castle.isLitter(bot, {}, st, px, SITE.y + 2, pz, w, d), false, n)
    }
  })
})
