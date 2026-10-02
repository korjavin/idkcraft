'use strict'

// castle: versioned blueprint data for the idkcraft-g0z castle slice
// (bead idkcraft-g0z.1, revision 2026-10-02).
//
// Pure data only — no movement, no bot logic. Like BLUEPRINT_V2 in
// behaviours/build.js: the plan is an array of cells {dx,dy,dz,kind} in LAY
// ORDER, origin = SW corner of the site, plus a pure rotation so the
// entrance faces the player who ordered (4 rotations).
//
// Slice scope: ONE corner tower 5x5 (~13 high, crenellated) + inner block
// staircase/landings + entrance. The full ~2000-cell castle is g0z.11.
// Torch cells light every floor/landing (lighting is v1, not cosmetics).
//
// Layout (rot 0, entrance faces -z / north, x 0..10, z 0..10):
//   tower 5x5 at x3..7, z3..7, walls dy=0..12, crenellations dy=13
//   door at (5,0,3), entrance apron stance at (5,0,1)
//   switchback block stairs inside the 3x3 interior (x4..6, z4..6):
//     F1 west up to landing L1 (dy=3), F2 east to L2 (dy=6),
//     F3 west to L3 (dy=9), F4 east to L4 (dy=12)
//   windows are 1x1 air openings in the outer faces
//
// Kinds (material ROLES): 'stone' (cobblestone), 'planks' (landings),
// 'door', 'torch', 'air' (keep clear: doorway/windows — never a target).
// Lay order: bottom-up, walls before stairs/landings per layer (stair and
// landing cells lean on the wall ring), each torch right after its floor,
// crenellations last. Every place cell has a solid neighbour placed
// earlier or terrain below (same rule as the build.js header).

const BLUEPRINT_VERSION = 1

const SITE_W = 11
const SITE_D = 11

const TOWER = { x0: 3, z0: 3, size: 5, top: 12 } // walls dy 0..12
const CRENELLATION_DY = 13

const DOOR = { dx: 5, dy: 0, dz: 3 }
const ENTRANCE = { dx: 5, dy: 0, dz: 1 } // flood start: apron in front

// 1x1 window openings: [x, dy, z] on the outer faces.
const WINDOWS = [
  [5, 4, 3], [5, 7, 3], [5, 10, 3], // north (above the door)
  [5, 2, 7], [5, 5, 7], [5, 8, 7], [5, 11, 7], // south
  [3, 3, 5], [3, 6, 5], [3, 9, 5], // west
  [7, 3, 5], [7, 6, 5], [7, 9, 5], // east
]

// Block-step flights (stone): [x, dy, z] in lay order per flight.
const FLIGHTS = [
  [[4, 0, 4], [4, 1, 5], [4, 2, 6]], // F1 west, ground -> L1
  [[6, 4, 6], [6, 5, 5], [6, 6, 4]], // F2 east, L1 -> L2
  [[4, 7, 4], [4, 8, 5], [4, 9, 6]], // F3 west, L2 -> L3
  [[6, 10, 6], [6, 11, 5], [6, 12, 4]], // F4 east, L3 -> L4
]

// Landing slabs (planks): full 3x3 interior minus the stairwell column
// (headroom for the flight below; the flight's top step fills one hole)
// minus the cell above each flight's first jump origin — the jump needs
// 3 air above its origin feet (pathfinder getMoveJumpUp blockA), so the
// landing above the origin stays open (revmux 01 core-1).
const LANDINGS = [
  { dy: 3, skip: new Set(['4,4', '4,5', '4,6']) }, // L1 + jump ceiling (4,3,4)
  { dy: 6, skip: new Set(['6,4', '6,5', '6,6', '5,6']) }, // L2 + jump ceiling (5,6,6)
  { dy: 9, skip: new Set(['4,4', '4,5', '4,6', '5,4']) }, // L3 + jump ceiling (5,9,4)
  { dy: 12, skip: new Set(['6,4', '6,5', '6,6', '5,6']) }, // L4 + jump ceiling (5,12,6)
]

// Torches: ground floor + every landing, each on its floor.
const TORCHES = [
  { dx: 5, dy: 0, dz: 5 }, // ground (after walls dy=0, before F1)
  { dx: 5, dy: 4, dz: 5 }, // L1 (after L1, before F2)
  { dx: 5, dy: 7, dz: 5 }, // L2 (after L2, before F3)
  { dx: 5, dy: 10, dz: 5 }, // L3 (after L3, before F4)
  { dx: 5, dy: 13, dz: 5 }, // L4 roof deck (after L4, before crenellations)
]

function onTowerPerimeter(x, z) {
  const { x0, z0, size } = TOWER
  if (x < x0 || x >= x0 + size || z < z0 || z >= z0 + size) return false
  return x === x0 || x === x0 + size - 1 || z === z0 || z === z0 + size - 1
}

function towerRing() {
  const { x0, z0, size } = TOWER
  const cells = []
  for (let i = 0; i < size; i++) {
    cells.push([x0 + i, z0], [x0 + i, z0 + size - 1])
    if (i > 0 && i < size - 1) cells.push([x0, z0 + i], [x0 + size - 1, z0 + i])
  }
  return cells
}

function buildPlan() {
  const plan = []
  const air = []
  const push = (dx, dy, dz, kind) => plan.push({ dx, dy, dz, kind })
  const hole = (dx, dy, dz) => air.push({ dx, dy, dz, kind: 'air' })

  const windowSet = new Set(WINDOWS.map(([x, dy, z]) => x + ',' + dy + ',' + z))
  const flightByDy = new Map() // dy -> [[x,z],...] in flight order
  for (const flight of FLIGHTS) {
    for (const [x, dy, z] of flight) {
      if (!flightByDy.has(dy)) flightByDy.set(dy, [])
      flightByDy.get(dy).push([x, z])
    }
  }
  const landingByDy = new Map(LANDINGS.map((l) => [l.dy, l]))
  const torchByDy = new Map() // torches ride right after their floor layer
  torchByDy.set(0, [[TORCHES[0].dx, TORCHES[0].dz]])
  torchByDy.set(3, [[TORCHES[1].dx, TORCHES[1].dz]])
  torchByDy.set(6, [[TORCHES[2].dx, TORCHES[2].dz]])
  torchByDy.set(9, [[TORCHES[3].dx, TORCHES[3].dz]])
  torchByDy.set(12, [[TORCHES[4].dx, TORCHES[4].dz]])
  const torchDy = new Map([[0, 0], [3, 4], [6, 7], [9, 10], [12, 13]])

  for (let dy = 0; dy <= TOWER.top; dy++) {
    // Walls first: stairs and landings lean on the ring.
    for (const [x, z] of towerRing()) {
      if (windowSet.has(x + ',' + dy + ',' + z)) { hole(x, dy, z); continue }
      if (x === DOOR.dx && z === DOOR.dz) {
        if (dy === 0) push(x, dy, z, 'door')
        else if (dy === 1) hole(x, dy, z)
        else push(x, dy, z, 'stone')
        continue
      }
      push(x, dy, z, 'stone')
    }
    // Flight steps at this layer.
    for (const [x, z] of flightByDy.get(dy) || []) push(x, dy, z, 'stone')
    // Landing slab at this layer, east-first row-major: the first cell of
    // each slab leans on the north wall ring, the rest on laid neighbours
    // (west-first strands cells east of the stairwell skips).
    const landing = landingByDy.get(dy)
    if (landing) {
      for (let z = TOWER.z0 + 1; z < TOWER.z0 + TOWER.size - 1; z++) {
        for (let x = TOWER.x0 + TOWER.size - 2; x >= TOWER.x0 + 1; x--) {
          if (landing.skip.has(x + ',' + z)) continue
          push(x, dy, z, 'planks')
        }
      }
    }
    // Torch for this floor (its dy may sit above the floor layer).
    for (const [x, z] of torchByDy.get(dy) || []) push(x, torchDy.get(dy), z, 'torch')
  }

  // Crenellated top: alternating blocks on a perimeter walk (evenly split).
  const { x0, z0, size } = TOWER
  const walk = []
  for (let x = x0; x < x0 + size; x++) walk.push([x, z0])
  for (let z = z0 + 1; z < z0 + size - 1; z++) walk.push([x0 + size - 1, z])
  for (let x = x0 + size - 1; x >= x0; x--) walk.push([x, z0 + size - 1])
  for (let z = z0 + size - 2; z > z0; z--) walk.push([x0, z])
  walk.forEach(([x, z], i) => {
    if (i % 2 === 0) push(x, CRENELLATION_DY, z, 'stone')
  })

  // Keep-clear markers (never place targets) ride at the end.
  for (const c of air) plan.push(c)

  return plan
}

// Quarter-turns clockwise (viewed from above): 0 entrance north, 1 east,
// 2 south, 3 west. Pure; the slice site is square so dims never change.
function siteDimensions(rot) {
  const r = ((rot % 4) + 4) % 4
  return (r === 1 || r === 3) ? { w: SITE_D, d: SITE_W } : { w: SITE_W, d: SITE_D }
}

function rotatePlan(plan, rot) {
  const r = ((rot % 4) + 4) % 4
  if (r === 0) return plan.map((c) => ({ ...c }))
  return plan.map((c) => {
    let dx = c.dx
    let dz = c.dz
    if (r === 1) { dx = SITE_D - 1 - c.dz; dz = c.dx }
    else if (r === 2) { dx = SITE_W - 1 - c.dx; dz = SITE_D - 1 - c.dz }
    else { dx = c.dz; dz = SITE_W - 1 - c.dx }
    return { dx, dy: c.dy, dz, kind: c.kind }
  })
}

function isPlaceTarget(kind) {
  return kind !== 'dig' && kind !== 'air'
}

// World-block match per kind (idkcraft-g0z.2): the executor's done test
// and the protection guard share it. 'air' accepts the door's upper half
// (the server places it into the doorway hole with the lower half).
const AIR_NAMES = new Set(['air', 'cave_air', 'void_air'])
function matches(kind, name) {
  if (typeof name !== 'string') return false
  if (kind === 'stone') return name === 'cobblestone' || name === 'stone'
  if (kind === 'planks') return name.endsWith('_planks')
  if (kind === 'door') return name.endsWith('_door')
  if (kind === 'torch') return name === 'torch' || name === 'wall_torch'
  if (kind === 'fence') return name.endsWith('_fence')
  if (kind === 'air') return AIR_NAMES.has(name) || name.endsWith('_door')
  if (kind === 'dig') return AIR_NAMES.has(name)
  return false
}

// Absolute plan for a site+rot, cached by key: cells carry {x,y,z,kind,idx}
// plus a coord -> cell map for the protection guard. Pure.
let absCache = null
function absPlan(site, rot) {
  const key = `${site.x},${site.y},${site.z},${rot | 0}`
  if (absCache && absCache.key === key) return absCache
  const cells = rotatePlan(PLAN, rot | 0).map((c, idx) => ({
    x: site.x + c.dx, y: site.y + c.dy, z: site.z + c.dz, kind: c.kind, dy: c.dy, idx,
  }))
  const at = new Map()
  for (const c of cells) at.set(`${c.x},${c.y},${c.z}`, c)
  absCache = { key, cells, at }
  return absCache
}

// Protection (g0z.2 revision): a laid castle block — a positive cell whose
// world block matches its kind — is never dug by any executor. Planned
// air/dig cells and wrong occupants (grass in a wall cell) stay open.
function protects(state, pos, name) {
  try {
    const site = state && state.site
    if (!site || typeof site.x !== 'number' || !pos) return false
    const c = absPlan(site, state.rot).at.get(`${Math.floor(pos.x)},${Math.floor(pos.y)},${Math.floor(pos.z)}`)
    return !!c && isPlaceTarget(c.kind) && matches(c.kind, name)
  } catch (_) { return false }
}

function billOfMaterials(plan) {
  const bom = {}
  for (const c of plan) bom[c.kind] = (bom[c.kind] || 0) + 1
  return bom
}

const PLAN = buildPlan()

module.exports = {
  BLUEPRINT_VERSION,
  SITE_W,
  SITE_D,
  TOWER,
  CRENELLATION_DY,
  DOOR,
  ENTRANCE,
  PLAN,
  buildPlan,
  rotatePlan,
  siteDimensions,
  isPlaceTarget,
  billOfMaterials,
  matches,
  absPlan,
  protects,
}
