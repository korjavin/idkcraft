'use strict'

// Reach invariant model for a castle blueprint (idkcraft-g0z.11), the same
// contract as castle.test.js's slice checker, on a voxel grid so the full
// ~2000-cell plan checks every prefix in about a second:
//   for every place cell, given the cells laid EARLIER (terrain below dy 0,
//   earlier 'dig' cells removed, the target itself cleared — the executor
//   digs a wrong occupant before placing), the face build.findRef would
//   pick (first solid neighbour, below first) is visible (raycast, no other
//   block in the way) from the eye of a stance with 2-block headroom outside
//   the target, eye-to-face <= GoalPlaceBlock range 4, and the stance is
//   reachable from the entrance by reversible walking (4-neighbour, dy
//   -1..1, jump/drop headroom) — so the route back out exists too.
// Collision kinds: stone, planks, frame, fence, chest (door/torch/air pass,
// as in the slice model). Fences and chests are not stood on.

const RANGE = 4 // build.PLACE_RANGE (GoalPlaceBlock approach range)
const REF_DIRS = [[0, -1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0]]
const COLLIDES = new Set(['stone', 'planks', 'frame', 'fence', 'chest'])
const NO_STAND = new Set(['fence', 'chest'])
const YMIN = -4
const YMAX = 20
const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]]

function makeGrid(W, D) {
  const H = YMAX - YMIN + 1
  const solid = new Uint8Array(W * D * H) // 1 collides, 2 collides but not standable-on
  const at = (x, y, z) => ((y - YMIN) * D + z) * W + x
  for (let y = YMIN; y < 0; y++) {
    for (let z = 0; z < D; z++) for (let x = 0; x < W; x++) solid[at(x, y, z)] = 1
  }
  const inside = (x, y, z) => x >= 0 && x < W && z >= 0 && z < D && y >= YMIN && y <= YMAX
  // Outside the site the ground is terrain too (rays may leave the site).
  const isSolid = (x, y, z) => inside(x, y, z) ? solid[at(x, y, z)] !== 0 : y < 0
  return { W, D, H, solid, at, inside, isSolid }
}

function standable(g, x, y, z) {
  if (x < 0 || x >= g.W || z < 0 || z >= g.D || y <= YMIN || y + 1 > YMAX) return false
  return g.solid[g.at(x, y - 1, z)] === 1 && g.solid[g.at(x, y, z)] === 0 && g.solid[g.at(x, y + 1, z)] === 0
}

// Voxel raycast eye->face (Amanatides & Woo), same walk as castle.test.js.
function losClear(g, eye, face) {
  const dir = { x: face.x - eye.x, y: face.y - eye.y, z: face.z - eye.z }
  const len = Math.hypot(dir.x, dir.y, dir.z)
  if (len === 0 || len > RANGE + 1e-9) return false
  let x = Math.floor(eye.x)
  let y = Math.floor(eye.y)
  let z = Math.floor(eye.z)
  const stepX = Math.sign(dir.x)
  const stepY = Math.sign(dir.y)
  const stepZ = Math.sign(dir.z)
  const tDeltaX = stepX !== 0 ? Math.abs(1 / dir.x) : Infinity
  const tDeltaY = stepY !== 0 ? Math.abs(1 / dir.y) : Infinity
  const tDeltaZ = stepZ !== 0 ? Math.abs(1 / dir.z) : Infinity
  const frac = (v) => v - Math.floor(v)
  let tMaxX = stepX === 0 ? Infinity : (stepX > 0 ? (1 - frac(eye.x)) : frac(eye.x)) * tDeltaX
  let tMaxY = stepY === 0 ? Infinity : (stepY > 0 ? (1 - frac(eye.y)) : frac(eye.y)) * tDeltaY
  let tMaxZ = stepZ === 0 ? Infinity : (stepZ > 0 ? (1 - frac(eye.z)) : frac(eye.z)) * tDeltaZ
  for (let i = 0; i < 64; i++) {
    let t
    if (tMaxX <= tMaxY && tMaxX <= tMaxZ) { t = tMaxX; x += stepX; tMaxX += tDeltaX }
    else if (tMaxY <= tMaxZ) { t = tMaxY; y += stepY; tMaxY += tDeltaY }
    else { t = tMaxZ; z += stepZ; tMaxZ += tDeltaZ }
    if (t >= 1 - 1e-9) return true
    if (g.isSolid(x, y, z)) return false
  }
  return true
}

// Reachable stances from the entrance on the current grid: a visited mask
// (index g.at) or null when the entrance itself is blocked. With `goal`,
// stops at the first stance goal(x,y,z) accepts and returns true.
function flood(g, entrance, goal) {
  const { dx: ex, dy: ey, dz: ez } = entrance
  if (!standable(g, ex, ey, ez)) return null
  const seen = new Uint8Array(g.solid.length)
  const queue = new Int32Array(g.solid.length * 3)
  let head = 0
  let tail = 0
  seen[g.at(ex, ey, ez)] = 1
  queue[tail++] = ex; queue[tail++] = ey; queue[tail++] = ez
  while (head < tail) {
    const sx = queue[head++]
    const sy = queue[head++]
    const sz = queue[head++]
    if (goal && goal(sx, sy, sz)) return true
    for (const [ox, oz] of DIRS) {
      for (let dy = -1; dy <= 1; dy++) {
        const nx = sx + ox
        const ny = sy + dy
        const nz = sz + oz
        if (!standable(g, nx, ny, nz)) continue
        const i = g.at(nx, ny, nz)
        if (seen[i]) continue
        // Jump/drop headroom (pathfinder getMoveJumpUp blockA /
        // getMoveDropDown blockB).
        if (dy === 1 && g.isSolid(sx, sy + 2, sz)) continue
        if (dy === -1 && g.isSolid(nx, sy + 1, nz)) continue
        seen[i] = 1
        queue[tail++] = nx; queue[tail++] = ny; queue[tail++] = nz
      }
    }
  }
  return goal ? false : seen
}

// One place cell against the current grid (cells laid before it).
function checkCell(g, entrance, t) {
  const ti = g.inside(t.dx, t.dy, t.dz) ? g.at(t.dx, t.dy, t.dz) : -1
  const saved = ti >= 0 ? g.solid[ti] : 0
  if (ti >= 0) g.solid[ti] = 0 // cleared before the place (wrong occupant dug)
  try {
    let ref = null
    for (const [ox, oy, oz] of REF_DIRS) {
      if (g.isSolid(t.dx + ox, t.dy + oy, t.dz + oz)) { ref = { x: t.dx + ox, y: t.dy + oy, z: t.dz + oz }; break }
    }
    if (!ref) return { ok: false, reason: 'no reference face (no solid neighbour or terrain)' }
    const face = {
      x: ref.x + 0.5 + (t.dx - ref.x) * 0.5,
      y: ref.y + 0.5 + (t.dy - ref.y) * 0.5,
      z: ref.z + 0.5 + (t.dz - ref.z) * 0.5,
    }
    let stance = null
    const r = flood(g, entrance, (sx, sy, sz) => {
      if (sx === t.dx && sz === t.dz && (sy === t.dy || sy + 1 === t.dy)) return false // GoalPlaceBlock.isStandingIn
      const eye = { x: sx + 0.5, y: sy + 1.6, z: sz + 0.5 }
      if (Math.hypot(eye.x - face.x, eye.y - face.y, eye.z - face.z) > RANGE || !losClear(g, eye, face)) return false
      stance = { x: sx, y: sy, z: sz }
      return true
    })
    if (r === null) return { ok: false, reason: 'entrance stance blocked' }
    if (!r) return { ok: false, reason: `no stance: ref (${ref.x},${ref.y},${ref.z}) face (${face.x},${face.y},${face.z}) unreachable/occluded` }
    return { ok: true, ref, stance } // stance: the first one by walk distance (what A* would pick)
  } finally {
    if (ti >= 0) g.solid[ti] = saved
  }
}

function apply(g, c) {
  if (!g.inside(c.dx, c.dy, c.dz)) return
  const i = g.at(c.dx, c.dy, c.dz)
  if (c.kind === 'dig') g.solid[i] = 0
  else if (COLLIDES.has(c.kind)) g.solid[i] = NO_STAND.has(c.kind) ? 2 : 1
}

// Walk the whole plan in order; first failure or { ok, checked, grid,
// stances } (stances[i] = { stance, under } per place cell: under = the
// plan cell the stance stands on, null for terrain).
// isTarget: blueprint isPlaceTarget. upTo: stop before this index.
function checkPlan(bp, isTarget, upTo = bp.PLAN.length) {
  const g = makeGrid(bp.W, bp.D)
  const laid = new Map()
  const stances = []
  let checked = 0
  for (let i = 0; i < upTo; i++) {
    const c = bp.PLAN[i]
    if (isTarget(c.kind)) {
      const r = checkCell(g, bp.ENTRANCE, c)
      if (!r.ok) return { ok: false, idx: i, cell: c, reason: r.reason, checked }
      const s = r.stance
      stances[i] = { stance: s, under: laid.get(s.x + ',' + (s.y - 1) + ',' + s.z) || null }
      checked++
    }
    apply(g, c)
    laid.set(c.dx + ',' + c.dy + ',' + c.dz, c)
  }
  return { ok: true, checked, grid: g, stances }
}

module.exports = { checkPlan, checkCell, makeGrid, apply, flood, standable, losClear, RANGE, REF_DIRS }
