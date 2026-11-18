'use strict'

// Walkable castle floor (owner 2026-11-16): a creeper crater in the floor
// and a dug stair shaft in the apron ring are filled bottom-up; a doorway,
// plan cells and an open drop (no bottom in the window) are never filled.

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const { Vec3 } = require('vec3')
const blueprint = require('../src/castle')
const castle = require('../src/behaviours/castle')

const SITE = { x: 100, y: 64, z: 200 }
const V = 2
const key = (x, y, z) => `${Math.floor(x)},${Math.floor(y)},${Math.floor(z)}`

function world(cells, below = () => 'dirt') {
  return {
    blockAt(p) {
      const x = Math.floor(p.x), y = Math.floor(p.y), z = Math.floor(p.z)
      const k = key(x, y, z)
      const name = cells.has(k) ? cells.get(k) : (y < SITE.y ? below(x, y, z) : 'air')
      return { name, position: new Vec3(x, y, z) }
    },
  }
}

describe('walkable castle floor fill', () => {
  const st = { site: { ...SITE }, rot: 0, blueprintVersion: V, phase: 'complete', blocked: {} }
  const at = blueprint.absPlan(SITE, 0, V).at
  const free = (x, z, depth) => { for (let dd = 1; dd <= depth; dd++) if (at.has(key(x, SITE.y - dd, z))) return false; return true }

  it('fills a floor crater and a ring shaft bottom-up, never a doorway', () => {
    const cells = new Map()
    // crater: 3x3, 3 deep, inside the footprint
    let cx = null, cz = null
    for (let x = SITE.x + 2; x < SITE.x + 28 && cx == null; x++) {
      for (let z = SITE.z + 2; z < SITE.z + 24 && cx == null; z++) {
        let ok = true
        for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) if (!free(x + i, z + j, 3)) ok = false
        if (ok) { cx = x; cz = z }
      }
    }
    assert.ok(cx != null, 'a crater spot exists')
    const crater = []
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) for (let dd = 1; dd <= 3; dd++) {
      cells.set(key(cx + i, SITE.y - dd, cz + j), 'air'); crater.push(key(cx + i, SITE.y - dd, cz + j))
    }
    // shaft: 1x1, FILL_DEPTH deep, in the ring 4 blocks outside the west wall
    const sx = SITE.x - 4, sz = SITE.z + 10
    for (let dd = 1; dd <= castle.FILL_DEPTH; dd++) cells.set(key(sx, SITE.y - dd, sz), 'air')
    // the doorway (above grade) stays air and is never listed
    const door = blueprint.absPlan(SITE, 0, V).cells.find((c) => c.kind === 'door')
    const list = castle.fillTargets(world(cells), {}, st, Date.now())
    const keys = new Set(list.map((c) => key(c.x, c.y, c.z)))
    for (const k of crater) assert.ok(keys.has(k), `crater cell ${k} listed`)
    const shaft = list.filter((c) => c.x === sx && c.z === sz)
    assert.equal(shaft.length, castle.FILL_DEPTH, 'whole shaft listed')
    assert.deepEqual(shaft.map((c) => c.y), shaft.map((c) => c.y).slice().sort((a, b) => a - b), 'bottom-up')
    assert.ok(!keys.has(key(door.x, door.y, door.z)), 'doorway not filled')
    assert.ok(list.every((c) => c.y < SITE.y && !at.has(key(c.x, c.y, c.z))), 'below grade, no plan cell')
    for (const c of list) assert.ok(castle.fillOf(st, c.idx), 'idx decodes back')
  })

  it('a pocket sealed under solid ground is no hole (count = work list)', () => {
    const cells = new Map()
    const sx = SITE.x - 4, sz = SITE.z + 10
    for (let dd = 2; dd <= 4; dd++) cells.set(key(sx, SITE.y - dd, sz), 'air') // grade dd=1 stays solid
    const list = castle.fillTargets(world(cells), {}, st, Date.now())
    assert.equal(list.filter((c) => c.x === sx && c.z === sz).length, 0)
  })
  it('nextFill: nearest column first, its lowest open cell, the cell above when the bottom backs off', () => {
    const cells = new Map()
    const near = { x: SITE.x - 4, z: SITE.z + 10 }, farc = { x: SITE.x - 4, z: SITE.z - 4 }
    for (const c of [near, farc]) for (let dd = 1; dd <= 3; dd++) cells.set(key(c.x, SITE.y - dd, c.z), 'air')
    const s2 = { ...st, blocked: {} }
    const list = castle.fillTargets(world(cells), {}, s2, Date.now())
    const bot = { entity: { position: { x: near.x + 0.5, y: SITE.y, z: near.z + 3.5 } } }
    const now = Date.now()
    const a = castle.nextFill(s2, list, now, bot, {})
    assert.deepEqual([a.x, a.y, a.z], [near.x, SITE.y - 3, near.z])
    s2.blocked[`2:${a.idx}`] = { tries: 1, until: now + 60000 }
    const b = castle.nextFill(s2, list, now, bot, {})
    assert.deepEqual([b.x, b.y, b.z], [near.x, SITE.y - 2, near.z])
    assert.equal(castle.nextFill(s2, list, now, bot, { castleUpkeep: list.find((c) => c.z === farc.z) }).z, farc.z, 'latched target kept')
  })
  it('an open drop past the ring window (a hillside) is not walled up', () => {
    const list = castle.fillTargets(world(new Map(), (x) => (x < SITE.x - 2 ? 'air' : 'dirt')), {}, st, Date.now())
    assert.ok(list.every((c) => c.x >= SITE.x - 2), 'no fill over open air')
  })
})
