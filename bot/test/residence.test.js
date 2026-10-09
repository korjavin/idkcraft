'use strict'

// idkcraft-g0z.28: residence descriptors. hut/house equal the values the
// call sites hardcoded before the extraction; the castle descriptor is pure
// geometry over the v2 blueprint, checked for all 4 rotations.

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const residence = require('../src/residence')
const castle = require('../src/castle')

const xyz = (p) => ({ x: p.x, y: p.y, z: p.z })
const site = { x: 100, y: 64, z: -50 }

describe('residence hut/house: extracted values', () => {
  it('picks the descriptor by kind, then version', () => {
    assert.equal(residence.of(null).kind, 'hut')
    assert.equal(residence.of({ v: 1 }).kind, 'hut')
    assert.equal(residence.of({ v: 2 }).kind, 'house')
    assert.equal(residence.of({ kind: 'castle', v: 2 }).kind, 'castle')
  })

  it('hut: door x+1, stances z-1/z+1, no beds, frozen spot plans', () => {
    const home = { site, v: 1, interior: { min: { x: 101, y: 64, z: -49 }, max: { x: 102, y: 65, z: -48 } } }
    const d = residence.of(home)
    const e = d.entrance(home)
    assert.deepEqual(xyz(e.door), { x: 101, y: 64, z: -50 })
    assert.deepEqual(xyz(e.outside), { x: 101, y: 64, z: -51 })
    assert.deepEqual(xyz(e.inside), { x: 101, y: 64, z: -49 })
    assert.equal(e.facing, 0)
    assert.deepEqual(d.beds(home), [])
    assert.equal(d.lights(home).length, 10)
    assert.deepEqual(d.lights(home)[0], { dx: 1, dz: -2 })
    assert.deepEqual(d.chest(home)[0], { dx: 5, dy: 0, dz: 1 })
    assert.deepEqual(xyz(d.table(home)), { x: 104, y: 64, z: -49 })
    assert.deepEqual(d.furnace(home), [], 'hut furnace stays roadside')
    assert.equal(d.interior(home, { x: 102.9, y: 65.5, z: -47.1 }), true)
    assert.equal(d.interior(home, { x: 103, y: 64, z: -48 }), false)
  })

  it('house: door x+3, beds A (1,4)->(2,4) B (4,4)->(5,4) staged foot.z+2', () => {
    const home = { site, v: 2 }
    const d = residence.of(home)
    const e = d.entrance(home)
    assert.deepEqual(xyz(e.door), { x: 103, y: 64, z: -50 })
    assert.deepEqual(xyz(e.outside), { x: 103, y: 64, z: -51 })
    assert.deepEqual(xyz(e.inside), { x: 103, y: 64, z: -49 })
    const [a, b] = d.beds(home)
    assert.deepEqual([xyz(a.foot), xyz(a.head), xyz(a.stage), a.facing],
      [{ x: 101, y: 64, z: -46 }, { x: 102, y: 64, z: -46 }, { x: 101, y: 64, z: -44 }, 1])
    assert.deepEqual([xyz(b.foot), xyz(b.head), xyz(b.stage), b.facing],
      [{ x: 104, y: 64, z: -46 }, { x: 105, y: 64, z: -46 }, { x: 104, y: 64, z: -44 }, 1])
    assert.deepEqual(d.lights(home)[0], { dx: 3, dz: -2 })
    assert.deepEqual(d.chest(home)[0], { dx: 5, dy: 0, dz: 2 })
    assert.deepEqual(xyz(d.table(home)), { x: 105, y: 64, z: -49 })
    assert.deepEqual(d.furnace(home), [{ dx: 4, dy: 0, dz: 1 }, { dx: 1, dy: 0, dz: 2 }, { dx: 2, dy: 0, dz: 1 }, { dx: 1, dy: 0, dz: 1 }])
  })
})

describe('residence castle: all 4 rotations', () => {
  const bp = castle.blueprintOf(2)
  // The NW tower (x7..11, z7..11, rot 0): its doorway hole into the body
  // (keep-clear air at feet level) and a cell of its stairwell shaft.
  const towerDoor = bp.PLAN.find((c) => c.kind === 'air' && c.dx === 11 && c.dy === 0 && c.dz === 9)
  const shaft = { dx: 9, dy: 4, dz: 8 } // the open z8 row: no floor at dy 3
  const toWorld = (home, c) => {
    const r = castle.rotatePlan([{ ...c, kind: 'air' }], home.rot, 2)[0]
    return { x: site.x + r.dx, y: site.y + r.dy, z: site.z + r.dz }
  }

  for (const rot of [0, 1, 2, 3]) {
    it(`rot ${rot}: door, beds, table off the plan, interior regions`, () => {
      const home = { kind: 'castle', site, rot }
      const d = residence.of(home)
      const plan = castle.absPlan(site, rot, 2)
      const key = (p) => `${p.x},${p.y},${p.z}`
      const e = d.entrance(home)
      const door = plan.cells.find((c) => c.kind === 'door')
      assert.deepEqual(xyz(e.door), { x: door.x, y: door.y, z: door.z })
      assert.deepEqual(xyz(e.outside), toWorld(home, bp.ENTRANCE))
      assert.equal(e.facing, rot)
      const beds = d.beds(home)
      assert.equal(beds.length, 2)
      for (const b of beds) {
        assert.equal(Math.abs(b.head.x - b.foot.x) + Math.abs(b.head.z - b.foot.z), 1)
        assert.equal(b.facing, (2 + rot) % 4) // south at rot 0
        for (const c of [b.foot, b.head, b.stage]) {
          assert.ok(!plan.at.has(key(c)), `bed cell ${key(c)} is a plan/keep-clear cell`)
          assert.ok(!plan.at.has(key({ x: c.x, y: c.y + 1, z: c.z })), `headroom ${key(c)}`)
          assert.equal(d.interior(home, c), true, `bed cell ${key(c)} on a floor`)
        }
      }
      const t = d.table(home)
      assert.ok(!plan.at.has(key(t)), 'table cell is a plan cell')
      assert.equal(d.interior(home, t), true)
      const all = [...beds.flatMap((b) => [b.foot, b.head, b.stage]), t].map(key)
      assert.equal(new Set(all).size, all.length, 'bed/stage/table cells overlap')
      assert.equal(d.interior(home, e.inside), true)
      // Regions: a hall floor cell and an upper bedroom cell yes; a tower
      // stairwell hole and the apron outside the walls no.
      assert.equal(d.interior(home, toWorld(home, { dx: 15, dy: 0, dz: 9 })), true)
      assert.equal(d.interior(home, toWorld(home, { dx: 14, dy: 4, dz: 17 })), true)
      assert.ok(towerDoor, 'the NW tower doorway is a keep-clear cell')
      assert.equal(d.interior(home, toWorld(home, towerDoor)), false)
      assert.equal(d.interior(home, toWorld(home, shaft)), false)
      // g0z.30: the ground stair steps are floor (a bot climbing to its
      // bed never reads outside); the sleep cell is a floor beside the head.
      for (const s of [{ dx: 8, dy: 1, dz: 12 }, { dx: 9, dy: 2, dz: 12 }, { dx: 10, dy: 3, dz: 12 }]) {
        assert.equal(d.interior(home, toWorld(home, s)), true, `stair ${s.dx},${s.dy},${s.dz}`)
      }
      for (const b of beds) {
        assert.ok(!plan.at.has(key(b.sleep)) && d.interior(home, b.sleep), `sleep cell ${key(b.sleep)}`)
        assert.ok(Math.hypot(b.sleep.x - b.head.x, b.sleep.y - b.head.y, b.sleep.z - b.head.z) <= 1, 'sleep beside the head')
      }
      assert.equal(d.interior(home, e.outside), false)
      // Plan cells: the chest and the torches.
      const rel = (c) => ({ x: site.x + c.dx, y: site.y + c.dy, z: site.z + c.dz })
      assert.equal(plan.at.get(key(rel(d.chest(home)[0]))).kind, 'chest')
      assert.ok(d.lights(home).length > 0)
      for (const l of d.lights(home)) assert.equal(plan.at.get(key(rel(l))).kind, 'torch')
      // g0z.36: the kitchen-corner furnace cells, (12,0,18) first; floor
      // cells, off the plan, clear of beds, chest, table and doorways.
      const fc = d.furnace(home).map(rel)
      assert.deepEqual(fc[0], toWorld(home, { dx: 12, dy: 0, dz: 18 }))
      assert.equal(fc.length, 3)
      const taken = new Set([...all, key(rel(d.chest(home)[0])), key(e.door), key(e.inside), key(toWorld(home, { dx: 13, dy: 0, dz: 14 }))])
      for (const c of fc) {
        assert.ok(!plan.at.has(key(c)), `furnace cell ${key(c)} is a plan cell`)
        assert.equal(d.interior(home, c), true, `furnace cell ${key(c)} on a floor`)
        assert.ok(!taken.has(key(c)), `furnace cell ${key(c)} collides`)
      }
      const box = d.box(home)
      for (const c of plan.cells) assert.ok(c.x >= box.min.x && c.x <= box.max.x && c.y >= box.min.y && c.y <= box.max.y && c.z >= box.min.z && c.z <= box.max.z)
    })
  }
})
