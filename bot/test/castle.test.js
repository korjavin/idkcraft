'use strict'

// Castle slice blueprint tests (bead idkcraft-g0z.1, revision 2026-10-02).
//
// The hard invariant is the GoalPlaceBlock approach contract, not the
// forgiving PLACE_REACH post-check: for every plan prefix (cells laid
// EARLIER) and every place target, the test asserts a connected walkable
// route from the entrance to a stance with 2-block headroom, a visible
// already-placed (or terrain) reference face within range 4, and — via the
// reversible walk — the route back out. The reference is the face findRef
// (build.js) would pick: first solid neighbour in below-first order, so the
// .2 executor places against the validated face.

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const castle = require('../src/castle')
const build = require('../src/behaviours/build')
const castleMod = require('../src/behaviours/castle')

const PLACE_RANGE = build.PLACE_RANGE // GoalPlaceBlock approach range (build.js:425)
assert.equal(PLACE_RANGE, 4)

// findRef neighbour order (build.js REF_DIRS): below first.
const REF_DIRS = [
  [0, -1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0],
]

const SOLID_KINDS = new Set(['stone', 'planks']) // collision; door/torch/air passable

function key(x, y, z) { return x + ',' + y + ',' + z }

// Prefix solids: plan cells before idx with collision. Terrain (y<0) solid.
function prefixSolids(plan, idx) {
  const set = new Set()
  for (let j = 0; j < idx; j++) {
    const c = plan[j]
    if (SOLID_KINDS.has(c.kind)) set.add(key(c.dx, c.dy, c.dz))
  }
  return set
}

function isSolid(solids, x, y, z) {
  if (y < 0) return true // flat-site terrain (no dig in the slice)
  return solids.has(key(x, y, z))
}

const MAX_FEET = 14

function standable(solids, W, D, x, y, z) {
  if (x < 0 || x >= W || z < 0 || z >= D || y < 0 || y > MAX_FEET) return false
  return isSolid(solids, x, y - 1, z) && !isSolid(solids, x, y, z) && !isSolid(solids, x, y + 1, z)
}

// Voxel raycast (Amanatides & Woo) over the open segment eye->face.
// Blocks on any solid entered strictly before the endpoint, mirroring
// GoalPlaceBlock.getFaceAndRef: the ray must reach the clicked face with
// no other block in the way. Ties step one axis (x, then y, then z) so the
// walk stays face-connected instead of jumping through edges.
function losClear(eye, face, solids) {
  const dir = { x: face.x - eye.x, y: face.y - eye.y, z: face.z - eye.z }
  const len = Math.hypot(dir.x, dir.y, dir.z)
  if (len === 0 || len > PLACE_RANGE + 1e-9) return false
  let x = Math.floor(eye.x)
  let y = Math.floor(eye.y)
  let z = Math.floor(eye.z)
  const stepX = dir.x > 0 ? 1 : dir.x < 0 ? -1 : 0
  const stepY = dir.y > 0 ? 1 : dir.y < 0 ? -1 : 0
  const stepZ = dir.z > 0 ? 1 : dir.z < 0 ? -1 : 0
  const tDeltaX = stepX !== 0 ? Math.abs(1 / dir.x) : Infinity
  const tDeltaY = stepY !== 0 ? Math.abs(1 / dir.y) : Infinity
  const tDeltaZ = stepZ !== 0 ? Math.abs(1 / dir.z) : Infinity
  const frac = (v) => v - Math.floor(v)
  let tMaxX = stepX === 0 ? Infinity : (stepX > 0 ? (1 - frac(eye.x)) : frac(eye.x)) * tDeltaX
  let tMaxY = stepY === 0 ? Infinity : (stepY > 0 ? (1 - frac(eye.y)) : frac(eye.y)) * tDeltaY
  let tMaxZ = stepZ === 0 ? Infinity : (stepZ > 0 ? (1 - frac(eye.z)) : frac(eye.z)) * tDeltaZ
  // Skip the eye voxel (head cell, air by standability); stop at t>=1.
  for (let i = 0; i < 64; i++) {
    let t
    if (tMaxX <= tMaxY && tMaxX <= tMaxZ) { t = tMaxX; x += stepX; tMaxX += tDeltaX }
    else if (tMaxY <= tMaxZ) { t = tMaxY; y += stepY; tMaxY += tDeltaY }
    else { t = tMaxZ; z += stepZ; tMaxZ += tDeltaZ }
    if (t >= 1 - 1e-9) return true // reached the face: nothing in the way
    if (isSolid(solids, x, y, z)) return false
  }
  return true
}

// Full prefix check for plan[idx]: findRef face + reachable stance with
// headroom outside the target, face within range 4, LOS clear. The walk is
// 4-neighbour with dy -1..1 (reversible), so flood membership also proves
// the route back out to the entrance.
function checkPrefix(plan, W, D, entrance, idx) {
  const target = plan[idx]
  const solids = prefixSolids(plan, idx)
  // The face findRef would pick: first solid neighbour, below first.
  let ref = null
  for (const [ox, oy, oz] of REF_DIRS) {
    const rx = target.dx + ox
    const ry = target.dy + oy
    const rz = target.dz + oz
    if (isSolid(solids, rx, ry, rz)) { ref = { x: rx, y: ry, z: rz }; break }
  }
  if (!ref) return { ok: false, reason: `no reference face (no solid neighbour or terrain)` }
  // Centre of the ref block's face toward the target (getShapeFaceCenters
  // for a full block: face centre).
  const face = {
    x: ref.x + 0.5 + (target.dx - ref.x) * 0.5,
    y: ref.y + 0.5 + (target.dy - ref.y) * 0.5,
    z: ref.z + 0.5 + (target.dz - ref.z) * 0.5,
  }
  // Flood walkable stances from the entrance.
  if (!standable(solids, W, D, entrance.dx, entrance.dy, entrance.dz)) {
    return { ok: false, reason: 'entrance stance blocked' }
  }
  const seen = new Set([key(entrance.dx, entrance.dy, entrance.dz)])
  const queue = [[entrance.dx, entrance.dy, entrance.dz]]
  const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]]
  while (queue.length > 0) {
    const [sx, sy, sz] = queue.shift()
    // Stance outside the target (GoalPlaceBlock.isStandingIn).
    const inTarget = (sx === target.dx && sz === target.dz && (sy === target.dy || sy + 1 === target.dy))
    if (!inTarget) {
      const eye = { x: sx + 0.5, y: sy + 1.6, z: sz + 0.5 }
      const dist = Math.hypot(eye.x - face.x, eye.y - face.y, eye.z - face.z)
      if (dist <= PLACE_RANGE && losClear(eye, face, solids)) return { ok: true }
    }
    for (const [ox, oz] of DIRS) {
      for (const dy of [-1, 0, 1]) {
        const nx = sx + ox
        const ny = sy + dy
        const nz = sz + oz
        const k = key(nx, ny, nz)
        if (seen.has(k)) continue
        if (!standable(solids, W, D, nx, ny, nz)) continue
        // Jump/drop headroom (pathfinder getMoveJumpUp blockA / getMoveDropDown
        // blockB): a jump needs air above the origin head, a drop needs air
        // above the destination head (revmux 01 core-1).
        if (dy === 1 && isSolid(solids, sx, sy + 2, sz)) continue
        if (dy === -1 && isSolid(solids, nx, sy + 1, nz)) continue
        seen.add(k)
        queue.push([nx, ny, nz])
      }
    }
  }
  return { ok: false, reason: `no stance: ref (${ref.x},${ref.y},${ref.z}) face (${face.x.toFixed(1)},${face.y.toFixed(1)},${face.z.toFixed(1)}) unreachable/occluded` }
}

describe('castle slice blueprint version', () => {
  it('exports BLUEPRINT_VERSION 2 (new orders: the full castle, g0z.12)', () => {
    assert.equal(castle.BLUEPRINT_VERSION, 2)
    assert.equal(typeof castle.BLUEPRINT_VERSION, 'number')
  })
})

describe('castle slice shape', () => {
  it('prints the bill of materials and stays slice-sized', () => {
    const bom = castle.billOfMaterials(castle.PLAN)
    console.log('castle slice BOM: ' + JSON.stringify(bom))
    // Slice guard: the full ~2000-cell castle is g0z.11, not this bead.
    assert.ok(castle.PLAN.length >= 150, `plan too small: ${castle.PLAN.length}`)
    assert.ok(castle.PLAN.length <= 400, `plan too big for the slice: ${castle.PLAN.length}`)
    for (const kind of ['stone', 'planks', 'door', 'torch', 'air']) {
      assert.ok((bom[kind] || 0) > 0, `missing kind ${kind}`)
    }
    assert.equal(bom.dig || 0, 0, 'slice has no moat dig (g0z.6)')
  })
  it("no 'air' cell is ever a place target", () => {
    assert.equal(castle.isPlaceTarget('air'), false)
    const targets = castle.PLAN.filter((c) => castle.isPlaceTarget(c.kind))
    assert.ok(targets.every((c) => c.kind !== 'air'))
    assert.ok(castle.PLAN.some((c) => c.kind === 'air'), 'expected keep-clear markers')
  })
  it('rotations preserve counts and stay in bounds', () => {
    const base = castle.billOfMaterials(castle.PLAN)
    for (const rot of [0, 1, 2, 3]) {
      const rp = castle.rotatePlan(castle.PLAN, rot)
      assert.deepEqual(castle.billOfMaterials(rp), base, `rot ${rot} BOM`)
      const { w, d } = castle.siteDimensions(rot)
      for (const c of rp) {
        assert.ok(c.dx >= 0 && c.dx < w && c.dz >= 0 && c.dz < d, `rot ${rot} out of bounds ${JSON.stringify(c)}`)
      }
    }
  })
})

describe('castle slice lay order: support exists when laid', () => {
  it('every place cell has a solid neighbour earlier or terrain below', () => {
    const plan = castle.PLAN
    for (let i = 0; i < plan.length; i++) {
      const c = plan[i]
      if (!castle.isPlaceTarget(c.kind)) continue
      const solids = prefixSolids(plan, i)
      let ok = c.dy - 1 < 0 // terrain below
      for (const [ox, oy, oz] of REF_DIRS) {
        if (isSolid(solids, c.dx + ox, c.dy + oy, c.dz + oz)) { ok = true; break }
      }
      assert.ok(ok, `cell ${i} ${JSON.stringify(c)} has no support`)
    }
  })
})

describe('castle slice reach invariant (range 4, ref face, LOS, way back)', () => {
  it('every prefix admits a walkable stance to a visible ref face', () => {
    const plan = castle.PLAN
    let checked = 0
    for (let i = 0; i < plan.length; i++) {
      if (!castle.isPlaceTarget(plan[i].kind)) continue
      const r = checkPrefix(plan, castle.SITE_W, castle.SITE_D, castle.ENTRANCE, i)
      assert.ok(r.ok, `cell ${i} ${JSON.stringify(plan[i])}: ${r.reason}`)
      checked++
    }
    assert.ok(checked > 100, `too few targets checked: ${checked}`)
  })

  it('g0z.17: torches laid in work order (after every other place cell) stay reachable', () => {
    const order = castle.PLAN.slice().sort((a, b) => castleMod.rank(a) - castleMod.rank(b))
    let n = 0
    order.forEach((c, i) => {
      if (c.kind !== 'torch') return
      const r = checkPrefix(order, castle.SITE_W, castle.SITE_D, castle.ENTRANCE, i)
      assert.ok(r.ok, `torch ${i} ${JSON.stringify(c)}: ${r.reason}`)
      n++
    })
    assert.equal(n, castle.PLAN.filter((c) => c.kind === 'torch').length)
  })

  it('mutation: a tower-top cell lifted out of reach fails', () => {
    const plan = castle.PLAN.map((c) => ({ ...c }))
    const top = plan.filter((c) => castle.isPlaceTarget(c.kind)).at(-1)
    top.dy = 30 // no ref face, no stance within range
    const idx = plan.indexOf(top)
    const r = checkPrefix(plan, castle.SITE_W, castle.SITE_D, castle.ENTRANCE, idx)
    assert.equal(r.ok, false, 'lifted cell must fail the invariant')
  })

  it('mutation: a landing ceiling over a stair jump blocks the climb (revmux 02)', () => {
    // Round-1 regression pin: a plank at (4,3,4) ceilings F1's first jump
    // (getMoveJumpUp blockA), so no L1 stance is walkable and the L1 torch
    // that needs one must fail.
    const plan = castle.PLAN.map((c) => ({ ...c }))
    const slabIdx = plan.findIndex((c) => c.dy === 3 && c.kind === 'planks')
    assert.ok(slabIdx !== -1, 'L1 slab found')
    plan.splice(slabIdx, 0, { dx: 4, dy: 3, dz: 4, kind: 'planks' })
    const torchIdx = plan.findIndex((c) => c.kind === 'torch' && c.dx === 5 && c.dy === 4 && c.dz === 5)
    assert.ok(torchIdx !== -1, 'L1 torch found')
    const r = checkPrefix(plan, castle.SITE_W, castle.SITE_D, castle.ENTRANCE, torchIdx)
    assert.equal(r.ok, false, 'ceiled staircase must fail the invariant')
  })

  it('mutation: a tall pillar outruns range 4 with no stance', () => {
    const plan = castle.PLAN.map((c) => ({ ...c }))
    for (let dy = 0; dy <= 8; dy++) plan.push({ dx: 0, dy, dz: 0, kind: 'stone' })
    const idx = plan.length - 1 // top of the pillar: ref below, but eye-to-face > 4 everywhere
    const r = checkPrefix(plan, castle.SITE_W, castle.SITE_D, castle.ENTRANCE, idx)
    assert.equal(r.ok, false, 'out-of-range pillar top must fail the invariant')
  })
})

describe('castle stone variants (vmzq.38)', () => {
  it('granite/diorite/andesite are castle stone: done test, held count, material', () => {
    for (const n of ['cobblestone', 'stone', 'granite', 'diorite', 'andesite', 'polished_andesite']) {
      assert.ok(castle.matches('stone', n), n)
      assert.ok(castleMod.isMaterial(n), n)
    }
    // vmzq.46: calcite, smooth_basalt, tuff and the deepslate variants join
    // the set (solid full blocks); sand stays out.
    for (const n of ['calcite', 'smooth_basalt', 'tuff', 'deepslate', 'polished_deepslate',
        'deepslate_bricks', 'deepslate_tiles', 'cracked_deepslate_bricks',
        'cracked_deepslate_tiles', 'chiseled_deepslate']) {
      assert.ok(castle.matches('stone', n), n)
      assert.ok(castleMod.isMaterial(n), n)
    }
    assert.ok(!castle.matches('stone', 'sand'))
    const bot = { inventory: { items: () => [{ name: 'granite', count: 64 }, { name: 'diorite', count: 10 }, { name: 'sand', count: 30 }] } }
    assert.equal(castleMod.held(bot, 'stone'), 74)
  })
})
