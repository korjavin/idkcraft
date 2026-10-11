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
const castleMod = require('../src/behaviours/castle')

assert.equal(reach.RANGE, build.PLACE_RANGE)
const V2 = castle.BLUEPRINTS[2]
const V3 = castle.BLUEPRINTS[castle.FULL_VERSION]
const key = (c) => `${c.dx},${c.dy},${c.dz}`

describe('castle blueprint versions', () => {
  it('new orders get v3 (g0z.47); a stored v1 castle keeps v1', () => {
    assert.equal(castle.BLUEPRINT_VERSION, 3)
    assert.equal(castle.FULL_VERSION, 3)
    assert.equal(castle.blueprintOf(undefined).version, 1, 'a pre-versioned castle reads v1')
    assert.equal(castle.blueprintOf(99).version, 1, 'an unknown version falls back to v1')
  })

  it('the v1 slice plan is frozen: a castle started on v1 keeps its plan', () => {
    const h = crypto.createHash('sha256').update(JSON.stringify(castle.BLUEPRINTS[1].PLAN)).digest('hex')
    assert.equal(h, '315181989f714558eba2448f66e941d852388d07172940af870df563c7730783')
    assert.equal(castle.BLUEPRINTS[1].PLAN, castle.PLAN)
  })

  it('the v2 full plan is frozen: a castle started on v2 keeps its plan', () => {
    const h = crypto.createHash('sha256').update(JSON.stringify(castle.BLUEPRINTS[2].PLAN)).digest('hex')
    assert.equal(h, 'bcb48eb3dd838f365d71fd5b4948421367595c63bb249c7805ea8fe5f45bf367')
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

  it('g0z.17: the work order (torches after every other place cell) holds the invariant too', () => {
    const order = V2.PLAN.slice().sort((a, b) => castleMod.rank(a) - castleMod.rank(b))
    assert.notDeepEqual(order, V2.PLAN, 'torches moved')
    const r = reach.checkPlan({ ...V2, PLAN: order }, castle.isPlaceTarget)
    assert.ok(r.ok, `cell ${r.idx} ${JSON.stringify(r.cell)}: ${r.reason}`)
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

describe('castle v3 stairs (g0z.47)', () => {
  it('same shell as v2, 60 kind-only changes to stairs with a face each', () => {
    assert.equal(V3.W, V2.W)
    assert.equal(V3.D, V2.D)
    assert.deepEqual(V3.ENTRANCE, V2.ENTRANCE)
    assert.deepEqual(V3.DOOR, V2.DOOR)
    assert.equal(V3.PLAN.length, V2.PLAN.length)
    const stairs = V3.PLAN.filter((c) => c.kind === 'stairs')
    assert.equal(stairs.length, 60)
    for (const c of stairs) {
      assert.ok(c.face && typeof c.face.dx === 'number' && typeof c.face.dz === 'number', JSON.stringify(c))
      assert.ok(['north', 'south', 'east', 'west'].includes(castle.faceName(c.face)), JSON.stringify(c))
    }
    assert.equal(V2.PLAN.filter((c) => c.kind === 'stairs').length, 0)
    let kindDiff = 0
    for (let i = 0; i < V2.PLAN.length; i++) {
      assert.deepEqual([V3.PLAN[i].dx, V3.PLAN[i].dy, V3.PLAN[i].dz], [V2.PLAN[i].dx, V2.PLAN[i].dy, V2.PLAN[i].dz], `cell ${i} moved`)
      if (V2.PLAN[i].kind !== V3.PLAN[i].kind) {
        kindDiff++
        assert.equal(V3.PLAN[i].kind, 'stairs')
      }
    }
    assert.equal(kindDiff, 60)
    assert.equal(castle.billOfMaterials(V3.PLAN).stairs, 60)
    assert.equal(castle.isPlaceTarget('stairs'), true)
    assert.equal(castle.matches('stairs', 'cobblestone_stairs'), true)
    assert.equal(castle.matches('stairs', 'cobblestone'), false)
    assert.equal(castle.DECOR[3], castle.DECOR[2], 'v3 shares v2 decor object')
  })

  it('rotations rotate faces with the same quarter-turn; absPlan passes them through', () => {
    const g0 = V3.PLAN.find((c) => c.dx === 8 && c.dy === 0 && c.dz === 12)
    assert.deepEqual(g0, { dx: 8, dy: 0, dz: 12, kind: 'stairs', face: { dx: 1, dz: 0 } })
    for (const rot of [1, 2, 3]) {
      const rp = castle.rotatePlan(V3.PLAN, rot, 3)
      assert.equal(rp.filter((c) => c.kind === 'stairs').length, 60, `rot ${rot} stairs`)
      const { w, d } = castle.siteDimensions(rot, 3)
      for (const c of rp.filter((c) => c.kind === 'stairs')) {
        assert.ok(c.face, `rot ${rot} ${JSON.stringify(c)} kept its face`)
        assert.ok(c.dx >= 0 && c.dx < w && c.dz >= 0 && c.dz < d, `rot ${rot} out of bounds`)
      }
    }
    const r1 = castle.rotatePlan([g0], 1, 3)[0]
    assert.deepEqual([r1.dx, r1.dz], [V3.D - 1 - 12, 8])
    assert.deepEqual(r1.face, { dx: 0, dz: 1 })
    const site = { x: 100, y: 64, z: 200 }
    const abs = castle.absPlan(site, 1, 3).at.get(`${site.x + r1.dx},${site.y},${site.z + r1.dz}`)
    assert.equal(abs.kind, 'stairs')
    assert.deepEqual(abs.face, { dx: 0, dz: 1 })
  })

  it('no landing-edge stair sits on a jump-ceiling skip', () => {
    // Flight steps already stood on skip coords in v2 (the top step fills
    // the stairwell hole), so only the converted landing cells — planks in
    // v2, stairs in v3 — must avoid the skips.
    const turn5 = (rot, x, z) => rot === 1 ? [4 - z, x] : rot === 3 ? [z, 4 - x] : [x, z]
    const skips = new Set()
    for (const [tx, tz, rot] of [[7, 7, 1], [19, 7, 3], [7, 15, 1], [19, 15, 3]]) {
      for (const { dy, skip } of [
        { dy: 3, skip: ['1,1', '1,2', '1,3'] },
        { dy: 6, skip: ['3,1', '3,2', '3,3', '2,3'] },
        { dy: 9, skip: ['1,1', '1,2', '1,3', '2,1'] },
        { dy: 12, skip: ['3,1', '3,2', '3,3', '2,3'] },
      ]) {
        for (const s of skip) {
          const [x, z] = s.split(',').map(Number)
          const [lx, lz] = turn5(rot, x, z)
          skips.add(`${tx + lx},${dy},${tz + lz}`)
        }
      }
    }
    const v2kind = new Map(V2.PLAN.map((c) => [key(c), c.kind]))
    let checked = 0
    for (const c of V3.PLAN.filter((c) => c.kind === 'stairs')) {
      if (v2kind.get(key(c)) === 'stone') continue // a flight step, solid since v2
      checked++
      assert.ok(!skips.has(`${c.dx},${c.dy},${c.dz}`), `stairs on a skip: ${JSON.stringify(c)}`)
    }
    assert.equal(checked, 9, '4 L1 edges + 3 attic steps + 2 slab edges')
  })

  it('every stair run (3 steps + edge) climbs 0.5-block rises only', () => {
    // Pure helper: the next cell is one along the face and one up (steps)
    // (revmux 01 core-3: edges only where the slab is one block above).
    const stepOk = (prev, next, face) =>
      next.dx - prev.dx === face.dx && next.dz - prev.dz === face.dz && next.dy - prev.dy === 1
    const edgeOk = stepOk
    const at = new Map(V3.PLAN.map((c) => [`${c.dx},${c.dy},${c.dz}`, c]))
    const turn5 = (rot, x, z) => rot === 1 ? [4 - z, x] : rot === 2 ? [4 - x, 4 - z] : rot === 3 ? [z, 4 - x] : [x, z]
    const runs = []
    const flights = [
      { steps: [[1, 0, 1], [1, 1, 2], [1, 2, 3]], face: { dx: 0, dz: 1 }, edge: [2, 3, 3], edgeFace: { dx: 1, dz: 0 } },
      { steps: [[3, 4, 3], [3, 5, 2], [3, 6, 1]], face: { dx: 0, dz: -1 }, edge: [2, 6, 1], edgeFace: { dx: -1, dz: 0 } },
      { steps: [[1, 7, 1], [1, 8, 2], [1, 9, 3]], face: { dx: 0, dz: 1 }, edge: [2, 9, 3], edgeFace: { dx: 1, dz: 0 } },
      { steps: [[3, 10, 3], [3, 11, 2], [3, 12, 1]], face: { dx: 0, dz: -1 }, edge: [2, 12, 1], edgeFace: { dx: -1, dz: 0 } },
    ]
    for (const [tx, tz, rot] of [[7, 7, 1], [19, 7, 3], [7, 15, 1], [19, 15, 3]]) {
      for (const f of flights) {
        const cells = f.steps.map(([x, y, z]) => {
          const [lx, lz] = turn5(rot, x, z)
          return at.get(`${tx + lx},${y},${tz + lz}`)
        })
        const [ex, ey, ez] = f.edge
        const [lx, lz] = turn5(rot, ex, ez)
        const edge = at.get(`${tx + lx},${ey},${tz + lz}`)
        if (ey !== 3) { // L2-L4: the flight tops out level with the slab, no edge stair
          assert.equal(edge.kind, 'planks', JSON.stringify(edge))
          assert.equal(cells[2].dy, ey, 'top step level with its landing')
          runs.push({ cells, face: castle.rotFace(rot, f.face), edgeFace: null })
          continue
        }
        cells.push(edge)
        const face = castle.rotFace(rot, f.face)
        const edgeFace = castle.rotFace(rot, f.edgeFace)
        runs.push({ cells, face, edgeFace })
      }
    }
    runs.push({
      cells: [[8, 0, 12], [9, 1, 12], [10, 2, 12], [11, 3, 12]].map(([x, y, z]) => at.get(`${x},${y},${z}`)),
      face: { dx: 1, dz: 0 }, edgeFace: { dx: 1, dz: 0 },
    })
    runs.push({
      cells: [[18, 4, 8], [18, 5, 9], [18, 6, 10], [18, 7, 11]].map(([x, y, z]) => at.get(`${x},${y},${z}`)),
      face: { dx: 0, dz: 1 }, edgeFace: { dx: 0, dz: 1 },
    })
    assert.equal(runs.length, 18)
    for (const { cells, face, edgeFace } of runs) {
      for (const c of cells) assert.equal(c.kind, 'stairs', JSON.stringify(c))
      assert.deepEqual(cells[0].face, face)
      assert.deepEqual(cells[1].face, face)
      assert.deepEqual(cells[2].face, face)
      assert.ok(stepOk(cells[0], cells[1], face), `run ${JSON.stringify(cells[0])}`)
      assert.ok(stepOk(cells[1], cells[2], face), `run ${JSON.stringify(cells[1])}`)
      if (!edgeFace) continue
      assert.deepEqual(cells[3].face, edgeFace)
      assert.ok(edgeOk(cells[2], cells[3], edgeFace), `edge ${JSON.stringify(cells[2])} -> ${JSON.stringify(cells[3])}`)
    }
    // Known limit (revmux 01 core-2, follow-up bead): step 1's low half backs
    // onto a wall, so a player enters it from the side and jumps once per run
    // (18 per full climb); the bot jumps regardless.
  })

  it('reach invariant green for every v3 prefix with the stairs ref restriction', () => {
    const r = reach.checkPlan(V3, castle.isPlaceTarget)
    assert.ok(r.ok, `cell ${r.idx} ${JSON.stringify(r.cell)}: ${r.reason}`)
    assert.equal(r.checked, V3.PLAN.filter((c) => castle.isPlaceTarget(c.kind)).length)
    assert.ok(r.checked > 1500)
  })
})
