'use strict'

// Full castle blueprint tests (bead idkcraft-g0z.11): blueprint version 2
// next to the frozen v1 slice, the bill of materials, the prefix reach
// invariant over the whole plan (test/castle-reach.js — same contract as
// castle.test.js: range 4 GoalPlaceBlock, findRef face visible, 2-block
// headroom, a reversible walk in and out), and the moat exit steps.

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const castle = require('../src/castle')
const build = require('../src/behaviours/build')
const reach = require('./castle-reach')

assert.equal(reach.RANGE, build.PLACE_RANGE)
const V2 = castle.BLUEPRINTS[castle.FULL_VERSION]
const key = (c) => `${c.dx},${c.dy},${c.dz}`

describe('castle blueprint versions', () => {
  it('new orders stay on v1; v2 is the full castle', () => {
    assert.equal(castle.BLUEPRINT_VERSION, 1)
    assert.equal(castle.FULL_VERSION, 2)
    assert.equal(castle.blueprintOf(undefined).version, 1, 'a pre-versioned castle reads v1')
    assert.equal(castle.blueprintOf(99).version, 1, 'an unknown version falls back to v1')
  })

  it('the v1 slice plan is frozen: a castle started on v1 keeps its plan', () => {
    const h = crypto.createHash('sha256').update(JSON.stringify(castle.BLUEPRINTS[1].PLAN)).digest('hex')
    assert.equal(h, '315181989f714558eba2448f66e941d852388d07172940af870df563c7730783')
    assert.equal(castle.BLUEPRINTS[1].PLAN, castle.PLAN)
  })

  it('the grid model agrees with the slice checker on v1', () => {
    const r = reach.checkPlan(castle.BLUEPRINTS[1], castle.isPlaceTarget)
    assert.ok(r.ok, `v1 cell ${r.idx} ${JSON.stringify(r.cell)}: ${r.reason}`)
    assert.equal(r.checked, castle.PLAN.filter((c) => castle.isPlaceTarget(c.kind)).length)
  })

  it('absPlan, siteDimensions and protects follow state.blueprintVersion', () => {
    const site = { x: 100, y: 64, z: 200 }
    assert.equal(castle.absPlan(site, 0).cells.length, castle.PLAN.length)
    assert.equal(castle.absPlan(site, 0, 2).cells.length, V2.PLAN.length)
    assert.deepEqual(castle.siteDimensions(0, 2), { w: 31, d: 27 })
    assert.deepEqual(castle.siteDimensions(1, 2), { w: 27, d: 31 })
    assert.deepEqual(castle.siteDimensions(1), { w: 11, d: 11 })
    // (12,3,7) is a Fachwerk sill beam in v2 and outside the v1 site.
    const pos = { x: site.x + 12, y: site.y + 3, z: site.z + 7 }
    assert.equal(castle.protects({ site, rot: 0, blueprintVersion: 2 }, pos, 'spruce_log'), true)
    assert.equal(castle.protects({ site, rot: 0 }, pos, 'spruce_log'), false)
    assert.equal(castle.protects({ site, rot: 0, blueprintVersion: 2 }, pos, 'cobblestone'), false)
  })
})

describe('castle v2 shape', () => {
  it('prints the bill of materials and is castle-sized (~2000 blocks +-30%)', () => {
    const bom = castle.billOfMaterials(V2.PLAN)
    console.log('castle v2 BOM: ' + JSON.stringify(bom))
    const blocks = V2.PLAN.filter((c) => c.kind !== 'air').length
    assert.ok(blocks >= 1400 && blocks <= 2600, `blocks ${blocks}`)
    for (const kind of ['stone', 'planks', 'frame', 'fence', 'door', 'chest', 'torch', 'air', 'dig']) {
      assert.ok((bom[kind] || 0) > 0, `missing kind ${kind}`)
    }
    assert.equal(bom.door, 1)
    assert.equal(bom.chest, 1)
  })

  it('one cell per coordinate, inside the site', () => {
    const seen = new Set()
    for (const c of V2.PLAN) {
      assert.ok(!seen.has(key(c)), `duplicate ${key(c)}`)
      seen.add(key(c))
      assert.ok(c.dx >= 0 && c.dx < V2.W && c.dz >= 0 && c.dz < V2.D, `out of site ${key(c)}`)
    }
  })

  it('rotations preserve counts and stay in bounds', () => {
    const base = castle.billOfMaterials(V2.PLAN)
    for (const rot of [0, 1, 2, 3]) {
      const rp = castle.rotatePlan(V2.PLAN, rot, 2)
      assert.deepEqual(castle.billOfMaterials(rp), base, `rot ${rot} BOM`)
      const { w, d } = castle.siteDimensions(rot, 2)
      for (const c of rp) assert.ok(c.dx >= 0 && c.dx < w && c.dz >= 0 && c.dz < d, `rot ${rot} out of bounds ${key(c)}`)
    }
  })

  it('work order = plan order: places, then the door, keep-clear, the moat, the fence', () => {
    const rank = (c) => (c.kind === 'fence' ? 4 : c.kind === 'dig' ? 3 : c.kind === 'air' ? 2 : c.kind === 'door' ? 1 : 0)
    for (let i = 1; i < V2.PLAN.length; i++) {
      assert.ok(rank(V2.PLAN[i - 1]) <= rank(V2.PLAN[i]), `cell ${i} ${JSON.stringify(V2.PLAN[i])} out of rank`)
    }
    assert.deepEqual(V2.PLAN.find((c) => c.kind === 'door'), { ...V2.DOOR, kind: 'door' })
  })

  it('nothing laid after the chest leans on it (a click on a chest opens it)', () => {
    const i = V2.PLAN.findIndex((c) => c.kind === 'chest')
    const ch = V2.PLAN[i]
    for (const c of V2.PLAN.slice(i + 1)) {
      if (!castle.isPlaceTarget(c.kind)) continue
      assert.ok(Math.abs(c.dx - ch.dx) + Math.abs(c.dy - ch.dy) + Math.abs(c.dz - ch.dz) > 1, `${key(c)} touches the chest`)
    }
  })

  it('g0z.6: dig ground -> place deck -> dig the bridge columns, which go last', () => {
    const deck = V2.PLAN.map((c, i) => ({ c, i })).filter(({ c }) => c.kind === 'planks' && c.dy === -1)
    assert.equal(deck.length, 6)
    const digs = V2.PLAN.map((c, i) => ({ c, i })).filter(({ c }) => c.kind === 'dig')
    const firstDig = digs[0].i
    const cols = digs.filter(({ c }) => deck.some(({ c: d }) => d.dx === c.dx && d.dz === c.dz))
    assert.equal(cols.length, 6, 'the moat is dug under every deck cell')
    assert.ok(cols.every(({ c }) => c.dy === -2), 'never the deck cell itself')
    assert.ok(deck.every(({ i }) => i < firstDig), 'the deck is laid before any moat dig')
    assert.deepEqual(digs.slice(-6).map(({ c }) => key(c)), cols.map(({ c }) => key(c)), 'bridge columns last')
  })

  it('the fence gap lines up with the bridge deck in every rotation', () => {
    for (const rot of [0, 1, 2, 3]) {
      const rp = castle.rotatePlan(V2.PLAN, rot, 2)
      const { w, d } = castle.siteDimensions(rot, 2)
      const fence = new Set(rp.filter((c) => c.kind === 'fence').map((c) => `${c.dx},${c.dz}`))
      const deck = rp.filter((c) => c.kind === 'planks' && c.dy === -1)
      assert.equal(deck.length, 6)
      // Walk from each deck cell straight away from the castle to the edge:
      // never through a fence post.
      const door = rp.find((c) => c.kind === 'door')
      for (const c of deck) {
        const sx = Math.sign(c.dx - door.dx) * (Math.abs(c.dx - door.dx) > Math.abs(c.dz - door.dz) ? 1 : 0)
        const sz = Math.sign(c.dz - door.dz) * (Math.abs(c.dz - door.dz) >= Math.abs(c.dx - door.dx) ? 1 : 0)
        for (let x = c.dx, z = c.dz; x >= 0 && x < w && z >= 0 && z < d; x += sx, z += sz) {
          assert.ok(!fence.has(`${x},${z}`), `rot ${rot}: fence at ${x},${z} in front of the bridge`)
        }
      }
    }
  })
})

describe('castle v2 reach invariant (range 4, ref face, LOS, way in and out)', () => {
  it('every plan prefix admits a walkable stance to a visible ref face', () => {
    const r = reach.checkPlan(V2, castle.isPlaceTarget)
    assert.ok(r.ok, `cell ${r.idx} ${JSON.stringify(r.cell)}: ${r.reason}`)
    assert.equal(r.checked, V2.PLAN.filter((c) => castle.isPlaceTarget(c.kind)).length)
    assert.ok(r.checked > 1500)
  })

  const fails = (plan) => reach.checkPlan({ ...V2, PLAN: plan }, castle.isPlaceTarget)

  it('mutation: plain bottom-up walls (dy2 after dy1) fail — the hanging order is load-bearing', () => {
    const north = (c) => c.dx >= 12 && c.dx <= 18 && c.dz === 7
    let plan = V2.PLAN.map((c) => ({ ...c }))
    const dy2 = plan.filter((c) => north(c) && c.dy === 2)
    plan = plan.filter((c) => !dy2.includes(c))
    const last1 = plan.findLastIndex((c) => north(c) && c.dy === 1)
    plan.splice(last1 + 1, 0, ...dy2)
    assert.equal(fails(plan).ok, false)
  })

  it('mutation: a roof cap cell lifted out of reach fails', () => {
    const plan = V2.PLAN.map((c) => ({ ...c }))
    plan.filter((c) => c.dy === 11 && c.kind === 'planks')[10].dy = 13
    assert.equal(fails(plan).ok, false)
  })

  it('mutation: a covered stairwell strands the upper floor', () => {
    const plan = V2.PLAN.map((c) => ({ ...c }))
    const i = plan.findIndex((c) => c.dy === 3 && c.kind === 'planks')
    plan.splice(i, 0, { dx: 9, dy: 3, dz: 12, kind: 'planks' })
    assert.equal(fails(plan).ok, false)
  })

  it('mutation: a missing attic stair step strands the roof', () => {
    assert.equal(fails(V2.PLAN.filter((c) => !(c.dx === 18 && c.dy === 5 && c.dz === 9))).ok, false)
  })
})

describe('castle v2 moat: exit steps', () => {
  const bottoms = (plan) => plan.filter((c) => c.kind === 'dig' && c.dy === -2)
  const stranded = (plan) => {
    const r = reach.checkPlan({ ...V2, PLAN: plan }, castle.isPlaceTarget)
    assert.ok(r.ok)
    const seen = reach.flood(r.grid, V2.ENTRANCE)
    return bottoms(plan).filter((c) => reach.standable(r.grid, c.dx, c.dy, c.dz) && !seen[r.grid.at(c.dx, c.dy, c.dz)])
  }

  it('from anywhere on the dug moat bottom the walk climbs out to the gate', () => {
    assert.ok(bottoms(V2.PLAN).length > 100)
    assert.deepEqual(stranded(V2.PLAN).map(key), [])
  })

  it('mutation: without the corner steps the moat bottom is a trap', () => {
    const plan = V2.PLAN.slice()
    for (const [x, z] of [[3, 3], [27, 3], [3, 23], [27, 23]]) plan.push({ dx: x, dy: -2, dz: z, kind: 'dig' })
    assert.ok(stranded(plan).length > 100)
  })
})
