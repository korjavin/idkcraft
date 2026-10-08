'use strict'

// castle: versioned blueprint data for the idkcraft-g0z castle
// (slice: bead idkcraft-g0z.1; full castle: bead idkcraft-g0z.11).
//
// Pure data only — no movement, no bot logic. Like BLUEPRINT_V2 in
// behaviours/build.js: a plan is an array of cells {dx,dy,dz,kind} in LAY
// ORDER, origin = SW corner of the site, plus a pure rotation so the
// entrance faces the player who ordered (4 rotations).
//
// Versions (a castle keeps the version it was ordered with —
// state.blueprintVersion, missing -> 1):
//   v1 the slice: ONE corner tower 5x5 (~13 high, crenellated) + inner block
//      staircase/landings + entrance, on an 11x11 site. Frozen.
//   v2 the full castle (owner-approved shape, epic g0z): 17x13 body, four
//      flush corner towers, stone ground floor, Fachwerk upper floor, stepped
//      plank roof, dry moat 2x2 with exit steps, fence, bridge, chest, on a
//      31x27 site. Layout comment above buildFullPlan.
// Torch cells light every floor/landing (lighting is v1, not cosmetics).
//
// v1 layout (rot 0, entrance faces -z / north, x 0..10, z 0..10):
//   tower 5x5 at x3..7, z3..7, walls dy=0..12, crenellations dy=13
//   door at (5,0,3), entrance apron stance at (5,0,1)
//   switchback block stairs inside the 3x3 interior (x4..6, z4..6):
//     F1 west up to landing L1 (dy=3), F2 east to L2 (dy=6),
//     F3 west to L3 (dy=9), F4 east to L4 (dy=12)
//   windows are 1x1 air openings in the outer faces
//
// Kinds (material ROLES): 'stone' (cobblestone), 'planks' (landings, floors,
// infill, roof), 'frame' (any *_log: Fachwerk beams), 'fence', 'door',
// 'chest', 'torch', 'air' (keep clear: doorways/windows/stairwells — never a
// target), 'dig' (must end as air: the moat).
// Lay order: every place cell has a solid neighbour placed earlier or
// terrain below (same rule as the build.js header); the reach invariant
// (test/castle-reach.js) holds for every plan prefix.

// What a NEW order gets (g0z.12: v2, its frame/chest now sourced). Castles
// already ordered keep their stored version.
const BLUEPRINT_VERSION = 2
const FULL_VERSION = 2

const SITE_W = 11
const SITE_D = 11

const TOWER = { x0: 3, z0: 3, size: 5, top: 12 } // walls dy 0..12
const CRENELLATION_DY = 13

const DOOR = { dx: 5, dy: 0, dz: 3 }
const ENTRANCE = { dx: 5, dy: 0, dz: 1 } // flood start: apron in front

// The tower in LOCAL coords (0..4, door wall at z=0), shared by the v1
// slice and the four v2 corner towers.
// 1x1 window openings: [x, dy, z] on the faces.
const WINDOWS = [
  [2, 4, 0], [2, 7, 0], [2, 10, 0], // north (above the door)
  [2, 2, 4], [2, 5, 4], [2, 8, 4], [2, 11, 4], // south
  [0, 3, 2], [0, 6, 2], [0, 9, 2], // west
  [4, 3, 2], [4, 6, 2], [4, 9, 2], // east
]

// Block-step flights (stone): [x, dy, z] in lay order per flight.
const FLIGHTS = [
  [[1, 0, 1], [1, 1, 2], [1, 2, 3]], // F1 west, ground -> L1
  [[3, 4, 3], [3, 5, 2], [3, 6, 1]], // F2 east, L1 -> L2
  [[1, 7, 1], [1, 8, 2], [1, 9, 3]], // F3 west, L2 -> L3
  [[3, 10, 3], [3, 11, 2], [3, 12, 1]], // F4 east, L3 -> L4
]

// Landing slabs (planks): full 3x3 interior minus the stairwell column
// (headroom for the flight below; the flight's top step fills one hole)
// minus the cell above each flight's first jump origin — the jump needs
// 3 air above its origin feet (pathfinder getMoveJumpUp blockA), so the
// landing above the origin stays open (revmux 01 core-1).
const LANDINGS = [
  { dy: 3, skip: new Set(['1,1', '1,2', '1,3']) }, // L1 + jump ceiling (1,3,1)
  { dy: 6, skip: new Set(['3,1', '3,2', '3,3', '2,3']) }, // L2 + jump ceiling (2,6,3)
  { dy: 9, skip: new Set(['1,1', '1,2', '1,3', '2,1']) }, // L3 + jump ceiling (2,9,1)
  { dy: 12, skip: new Set(['3,1', '3,2', '3,3', '2,3']) }, // L4 + jump ceiling (2,12,3)
]

// Torches at the centre: ground + every landing, each laid right after its
// floor layer (floor dy -> torch dy).
const TORCH_AFTER = new Map([[0, 0], [3, 4], [6, 7], [9, 10], [12, 13]])

function towerRing() {
  const cells = []
  for (let i = 0; i < 5; i++) {
    cells.push([i, 0], [i, 4])
    if (i > 0 && i < 4) cells.push([0, i], [4, i])
  }
  return cells
}

// One tower in local coords, lay order: bottom-up, walls before stairs and
// landings per layer (stair and landing cells lean on the wall ring), each
// torch right after its floor, crenellations last. Returns the place cells
// and the keep-clear markers (doorway/windows) separately.
//   top: last wall layer; door: 'door' (a door block) or 'air' (a doorway);
//   windowAt(x, dy, z): true where a WINDOWS opening stays open.
function towerPlan(top, door, windowAt) {
  const plan = []
  const air = []
  const push = (dx, dy, dz, kind) => plan.push({ dx, dy, dz, kind })
  const hole = (dx, dy, dz) => air.push({ dx, dy, dz, kind: 'air' })
  const windowSet = new Set(WINDOWS.filter(([x, dy, z]) => windowAt(x, dy, z)).map(([x, dy, z]) => x + ',' + dy + ',' + z))
  const flightByDy = new Map() // dy -> [[x,z],...] in flight order
  for (const flight of FLIGHTS) {
    for (const [x, dy, z] of flight) {
      if (!flightByDy.has(dy)) flightByDy.set(dy, [])
      flightByDy.get(dy).push([x, z])
    }
  }
  const landingByDy = new Map(LANDINGS.map((l) => [l.dy, l]))

  for (let dy = 0; dy <= top; dy++) {
    // Walls first: stairs and landings lean on the ring.
    for (const [x, z] of towerRing()) {
      if (windowSet.has(x + ',' + dy + ',' + z)) { hole(x, dy, z); continue }
      if (x === 2 && z === 0) { // door column
        if (dy === 0 && door === 'door') push(x, dy, z, 'door')
        else if (dy <= 1) hole(x, dy, z)
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
      for (let z = 1; z <= 3; z++) {
        for (let x = 3; x >= 1; x--) {
          if (landing.skip.has(x + ',' + z)) continue
          push(x, dy, z, 'planks')
        }
      }
    }
    // Torch for this floor (its dy may sit above the floor layer).
    if (TORCH_AFTER.has(dy)) push(2, TORCH_AFTER.get(dy), 2, 'torch')
  }

  // Crenellated top: alternating blocks on a perimeter walk (evenly split).
  const walk = []
  for (let x = 0; x < 5; x++) walk.push([x, 0])
  for (let z = 1; z < 4; z++) walk.push([4, z])
  for (let x = 4; x >= 0; x--) walk.push([x, 4])
  for (let z = 3; z > 0; z--) walk.push([0, z])
  walk.forEach(([x, z], i) => {
    if (i % 2 === 0) push(x, top + 1, z, 'stone')
  })
  return { plan, air }
}

// v1: the slice — one tower at TOWER.x0/z0, keep-clear markers at the end.
// Frozen: castles ordered on v1 keep exactly this plan (a test pins it).
function buildPlan() {
  const { plan, air } = towerPlan(TOWER.top, 'door', () => true)
  const at = (c) => ({ dx: c.dx + TOWER.x0, dy: c.dy, dz: c.dz + TOWER.z0, kind: c.kind })
  return plan.map(at).concat(air.map(at))
}

// v2 — the full castle (g0z.11). Layout, rot 0 (gate faces -z / north),
// site x 0..30, z 0..26, ground dy=0 = site.y:
//   fence ring x=0/30, z=0/26 (gap x14..16 at z=0, in line with the bridge)
//   dry moat ring x3..27 z3..23 minus x5..25 z5..21, 2 deep (dy -1, -2);
//     the four outer corners are dug 1 deep only: exit steps
//   bridge deck x14..16 z3..4 (planks at dy -1, the moat dug under it)
//   body 17x13 at x7..23 z7..19; 5x5 towers flush in its corners
//     (x7..11 / x19..23 by z7..11 / z15..19), walls dy0..13, crenellations
//     dy14, the slice tower's stair inside, ground doorway into the body
//   gate: door (15,0,7), entrance apron (15,0,5)
//   ground floor dy0..2, cobblestone: hall (x12..18 z8..13 + the side
//     strips), staircase (west strip x8..11 z12..14), kitchen (x12..14
//     z15..18), storeroom (x16..18 z15..18, castle chest at (18,0,18))
//   floor slab dy3 (planks), Fachwerk sill/plate dy3/dy7 (frame), posts
//     (frame) + infill (planks) dy4..6, three bedrooms (x12..14 / x16..18
//     z15..18, east strip x20..22 z12..14), upper hall
//   attic slab dy7, stepped roof dy8..10 + flat cap dy11 (planks), stone
//     gables x=7/23 dy8..11
// Ordering trick (reach invariant): build.findRef places against the block
// BELOW first, whose top face is only visible from an eye above it. A floor
// at feet F sees top faces up to dy F+1, so the two wall layers above that
// are laid first, hanging off side/upper neighbours (towers, the slab)
// while the layer below them is still air: storey order dy0, 3, 2, 1 then
// 4, 7, 6, 5. The towers go up first, complete — they are the anchors.
const FULL_W = 31
const FULL_D = 27
const FULL_ENTRANCE = { dx: 15, dy: 0, dz: 5 }
const FULL_DOOR = { dx: 15, dy: 0, dz: 7 }
const TOWERS = [[7, 7, 1], [19, 7, 3], [7, 15, 1], [19, 15, 3]] // [x0, z0, rot]: doorway faces the body
const COLLIDES = new Set(['stone', 'planks', 'frame', 'fence', 'chest'])
const NEIGH6 = [[0, -1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0]]

function k3(x, y, z) { return x + ',' + y + ',' + z }
function inTower(x, z) { return (x <= 11 || x >= 19) && (z <= 11 || z >= 15) } // within the body box
function outerLine(x, z) { return x === 7 || x === 23 || z === 7 || z === 19 }
// Quarter-turn a 5x5 local cell, same sense as rotatePlan.
function turn5(rot, x, z) {
  if (rot === 1) return [4 - z, x]
  if (rot === 2) return [4 - x, 4 - z]
  if (rot === 3) return [z, 4 - x]
  return [x, z]
}

function buildFullPlan() {
  const plan = []
  const air = []
  const solid = new Set()
  const add = (c) => {
    plan.push({ dx: c.x, dy: c.y, dz: c.z, kind: c.kind })
    if (COLLIDES.has(c.kind)) solid.add(k3(c.x, c.y, c.z))
  }
  const hole = (x, y, z) => air.push({ dx: x, dy: y, dz: z, kind: 'air' })
  // Lay a group of cells: keep-clear ones become markers; the rest go in
  // the given order, except a cell with no laid neighbour (nor terrain)
  // waits until one appears — a hanging layer spreads out from its anchors.
  const lay = (cells) => {
    const left = []
    for (const c of cells) {
      if (c.kind === 'air') hole(c.x, c.y, c.z)
      else left.push(c)
    }
    while (left.length > 0) {
      const i = left.findIndex((c) => c.y <= 0 || NEIGH6.some(([a, b, d]) => solid.has(k3(c.x + a, c.y + b, c.z + d))))
      if (i < 0) throw new Error(`castle v2: unsupported cell ${JSON.stringify(left[0])}`)
      add(left.splice(i, 1)[0])
    }
  }

  // Towers first, complete: the body's hanging layers lean on them.
  for (const [tx, tz, rot] of TOWERS) {
    const w = (c) => { const [x, z] = turn5(rot, c.dx, c.dz); return { x: tx + x, y: c.dy, z: tz + z, kind: c.kind } }
    const t = towerPlan(13, 'air', (x, dy, z) => { const p = w({ dx: x, dy, dz: z }); return outerLine(p.x, p.z) })
    for (const c of t.plan) add(w(c))
    for (const c of t.air) { const p = w(c); hole(p.x, p.y, p.z) }
  }

  // Outer wall segments between the towers.
  const seg = []
  for (let x = 12; x <= 18; x++) seg.push([x, 7], [x, 19])
  for (let z = 12; z <= 14; z++) seg.push([7, z], [23, z])
  const winLow = new Set(['13,7', '17,7', '13,19', '17,19', '7,13', '23,13']) // dy1
  const winHigh = new Set(['13,7', '14,7', '16,7', '17,7', '13,19', '14,19', '16,19', '17,19', '7,13', '23,13']) // dy5
  const post = (x, z) => (z === 7 || z === 19) ? (x === 12 || x === 15 || x === 18) : (z === 12 || z === 14)
  const wallKind = (x, y, z) => {
    if (x === FULL_DOOR.dx && z === FULL_DOOR.dz && y <= 1) return y === 0 ? 'door' : 'air'
    if (y === 1 && winLow.has(x + ',' + z)) return 'air'
    if (y === 5 && winHigh.has(x + ',' + z)) return 'air'
    if (y <= 2) return 'stone'
    if (y === 3 || y === 7) return 'frame'
    return post(x, z) ? 'frame' : 'planks'
  }
  const walls = (y) => seg.map(([x, z]) => ({ x, y, z, kind: wallKind(x, y, z) })).filter((c) => c.kind !== 'door')

  // Inner partitions; doorways are 2 high from the storey's floor.
  const partG = []
  for (let x = 12; x <= 18; x++) partG.push([x, 14])
  for (let z = 15; z <= 18; z++) partG.push([15, z])
  const partU = partG.concat([[19, 12], [19, 13], [19, 14]])
  const doorG = new Set(['13,14', '17,14'])
  const doorU = new Set(['13,14', '17,14', '19,13'])
  const parts = (y, base, list, doors, kind) => list.map(([x, z]) => ({ x, y, z, kind: doors.has(x + ',' + z) && y - base <= 1 ? 'air' : kind }))

  // Floors over the body interior (minus the tower squares).
  const interior = []
  for (let z = 8; z <= 18; z++) {
    for (let x = 8; x <= 22; x++) if (!inTower(x, z)) interior.push([x, z])
  }
  const slab = (y, well) => interior.map(([x, z]) => ({ x, y, z, kind: well.has(x + ',' + z) ? 'air' : 'planks' }))
  const wellG = new Set(['8,12', '9,12', '10,12']) // over the ground stair
  const wellU = new Set(['18,8', '18,9', '18,10']) // over the attic stair
  const stairG = [{ x: 8, y: 0, z: 12 }, { x: 9, y: 1, z: 12 }, { x: 10, y: 2, z: 12 }] // leans on the NW tower
  const stairU = [{ x: 18, y: 4, z: 8 }, { x: 18, y: 5, z: 9 }, { x: 18, y: 6, z: 10 }] // leans on the NE tower
  const torches = (y, list) => list.map(([x, z]) => ({ x, y, z, kind: 'torch' }))

  // Ground storey (feet 0): dy0, then 3 and 2 hanging, then 1.
  lay([...walls(0), ...parts(0, 0, partG, doorG, 'stone'), { ...stairG[0], kind: 'stone' }])
  lay([...walls(3), ...slab(3, wellG)])
  lay([...walls(2), ...parts(2, 0, partG, doorG, 'stone'), { ...stairG[2], kind: 'stone' }])
  lay([...walls(1), ...parts(1, 0, partG, doorG, 'stone'), { ...stairG[1], kind: 'stone' }])
  lay(torches(0, [[15, 10], [10, 14], [21, 13], [13, 17], [16, 16]]))
  // Upper storey (feet 4): dy4, then 7 and 6 hanging, then 5.
  lay([...walls(4), ...parts(4, 4, partU, doorU, 'planks'), { ...stairU[0], kind: 'planks' }])
  lay([...walls(7), ...slab(7, wellU)])
  lay([...walls(6), ...parts(6, 4, partU, doorU, 'planks'), { ...stairU[2], kind: 'planks' }])
  lay([...walls(5), ...parts(5, 4, partU, doorU, 'planks'), { ...stairU[1], kind: 'planks' }])
  lay(torches(4, [[15, 10], [9, 14], [13, 17], [17, 17], [21, 13]]))

  // Attic (feet 8): eaves and gable foot, the gable top hanging off the
  // towers, then the roof steps and the flat cap.
  const row = (y, z) => { const out = []; for (let x = 12; x <= 18; x++) out.push({ x, y, z, kind: 'planks' }); return out }
  const gable = (y) => [12, 13, 14].flatMap((z) => [{ x: 7, y, z, kind: 'stone' }, { x: 23, y, z, kind: 'stone' }])
  lay([...row(8, 7), ...row(8, 19), ...gable(8)])
  lay(torches(8, [[15, 13], [10, 13], [20, 13]]))
  lay(gable(11))
  lay(gable(10))
  lay(gable(9))
  lay([...row(9, 8), ...row(9, 18)])
  lay([...row(10, 9), ...row(10, 17)])
  const cap = []
  for (let z = 10; z <= 16; z++) {
    for (let x = 8; x <= 22; x++) if (!inTower(x, z)) cap.push({ x, y: 11, z, kind: 'planks' })
  }
  lay(cap)

  // Outside (g0z.6 order: body, bridge, moat, fence): the bridge deck (it
  // replaces the ground cell: the executor digs the occupant, then places)
  // before any moat dig, so a way across exists before the moat does.
  const deck = (x, z) => x >= 14 && x <= 16 && z >= 3 && z <= 4
  const deckCells = []
  for (let z = 3; z <= 4; z++) for (let x = 14; x <= 16; x++) deckCells.push({ x, y: -1, z, kind: 'planks' })
  lay(deckCells)

  // Last place cells: the castle chest (nothing later leans on it — a
  // click on a chest opens it), then the gate (door deferral, workOrder).
  lay([{ x: 18, y: 0, z: 18, kind: 'chest' }])
  add({ x: FULL_DOOR.dx, y: FULL_DOOR.dy, z: FULL_DOOR.dz, kind: 'door' })
  for (const c of air) plan.push(c)

  // The moat: the top layer, then the bottom, the bridge columns under the
  // laid deck last (dig ground -> place deck -> dig the column below).
  const moat = []
  for (let z = 3; z <= 23; z++) {
    for (let x = 3; x <= 27; x++) if (!(x >= 5 && x <= 25 && z >= 5 && z <= 21)) moat.push([x, z])
  }
  const exitStep = (x, z) => (x === 3 || x === 27) && (z === 3 || z === 23)
  for (const [x, z] of moat) if (!deck(x, z)) plan.push({ dx: x, dy: -1, dz: z, kind: 'dig' })
  for (const [x, z] of moat) if (!exitStep(x, z) && !deck(x, z)) plan.push({ dx: x, dy: -2, dz: z, kind: 'dig' })
  for (const [x, z] of moat) if (deck(x, z)) plan.push({ dx: x, dy: -2, dz: z, kind: 'dig' })

  // Fence ring last, outside the moat, its gap in line with the bridge.
  const fence = []
  for (let x = 0; x < FULL_W; x++) {
    if (x < 14 || x > 16) fence.push({ x, y: 0, z: 0, kind: 'fence' })
    fence.push({ x, y: 0, z: FULL_D - 1, kind: 'fence' })
  }
  for (let z = 1; z < FULL_D - 1; z++) fence.push({ x: 0, y: 0, z, kind: 'fence' }, { x: FULL_W - 1, y: 0, z, kind: 'fence' })
  for (const c of fence) plan.push({ dx: c.x, dy: c.y, dz: c.z, kind: c.kind })
  return plan
}

const PLAN = buildPlan()
const BLUEPRINTS = {
  1: { version: 1, W: SITE_W, D: SITE_D, ENTRANCE, DOOR, PLAN },
  2: { version: 2, W: FULL_W, D: FULL_D, ENTRANCE: FULL_ENTRANCE, DOOR: FULL_DOOR, PLAN: buildFullPlan() },
}

// The blueprint of a castle version; unknown/missing -> v1 (every castle
// ordered before g0z.11 is v1).
function blueprintOf(version) {
  return BLUEPRINTS[version] || BLUEPRINTS[1]
}

// Quarter-turns clockwise (viewed from above): 0 entrance north, 1 east,
// 2 south, 3 west. Pure; odd turns swap the site's width and depth.
function siteDimensions(rot, version) {
  const { W, D } = blueprintOf(version)
  const r = ((rot % 4) + 4) % 4
  return (r === 1 || r === 3) ? { w: D, d: W } : { w: W, d: D }
}

function rotatePlan(plan, rot, version) {
  const { W, D } = blueprintOf(version)
  const r = ((rot % 4) + 4) % 4
  if (r === 0) return plan.map((c) => ({ ...c }))
  return plan.map((c) => {
    let dx = c.dx
    let dz = c.dz
    if (r === 1) { dx = D - 1 - c.dz; dz = c.dx }
    else if (r === 2) { dx = W - 1 - c.dx; dz = D - 1 - c.dz }
    else { dx = c.dz; dz = W - 1 - c.dx }
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
// The one castle-stone set (vmzq.38): item and placed-block names alike.
// The quarry yields granite/diorite/andesite as often as cobble; the castle
// (wall cells, fetch counts) and the pathfinder scaffold all read this set,
// so quarry yield is laid instead of hoarded into a 36/36 pack.
const STONE_ITEMS = Object.freeze(['cobblestone', 'stone', 'granite', 'diorite', 'andesite',
  'polished_granite', 'polished_diorite', 'polished_andesite', 'cobbled_deepslate'])
const STONE_SET = new Set(STONE_ITEMS)
function isStone(name) {
  return STONE_SET.has(name)
}
function matches(kind, name) {
  if (typeof name !== 'string') return false
  if (kind === 'stone') return isStone(name)
  if (kind === 'planks') return name.endsWith('_planks')
  if (kind === 'frame') return name.endsWith('_log')
  if (kind === 'door') return name.endsWith('_door')
  if (kind === 'torch') return name === 'torch' || name === 'wall_torch'
  if (kind === 'fence') return name.endsWith('_fence')
  if (kind === 'chest') return name === 'chest'
  if (kind === 'air') return AIR_NAMES.has(name) || name.endsWith('_door')
  if (kind === 'dig') return AIR_NAMES.has(name)
  return false
}

// Absolute plan for a site+rot+version, cached by key: cells carry
// {x,y,z,kind,idx} plus a coord -> cell map for the protection guard. Pure.
let absCache = null
function absPlan(site, rot, version) {
  const bp = blueprintOf(version)
  const key = `${site.x},${site.y},${site.z},${rot | 0},v${bp.version}`
  if (absCache && absCache.key === key) return absCache
  const cells = rotatePlan(bp.PLAN, rot | 0, bp.version).map((c, idx) => ({
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
    const c = absPlan(site, state.rot, state.blueprintVersion).at.get(`${Math.floor(pos.x)},${Math.floor(pos.y)},${Math.floor(pos.z)}`)
    return !!c && isPlaceTarget(c.kind) && matches(c.kind, name)
  } catch (_) { return false }
}

// Ground under the site (idkcraft-g0z.14, the house's e5ba rule): a cell in
// the footprint box below site.y that is no plan cell — the walls' support
// and the v2 hall floor. Planned moat digs stay plan cells (diggable); the
// moat banks and floor around them are ground. All the way down, like e5ba.
function groundCell(state, pos) {
  try {
    const site = state && state.site
    if (!site || typeof site.x !== 'number' || !pos) return false
    const x = Math.floor(pos.x), y = Math.floor(pos.y), z = Math.floor(pos.z)
    if (y >= site.y) return false
    const { w, d } = siteDimensions(state.rot | 0, state.blueprintVersion)
    if (x < site.x || x >= site.x + w || z < site.z || z >= site.z + d) return false
    return !absPlan(site, state.rot, state.blueprintVersion).at.has(`${x},${y},${z}`)
  } catch (_) { return false }
}

// Castle footprint (idkcraft-vmzq.40): the site box at and above site.y
// (the entrance apron and door path lie inside it), plus any plan cell
// (moat digs below). What the castle step may clear there: util.protectedReason.
function inFootprint(state, pos) {
  try {
    const site = state && state.site
    if (!site || typeof site.x !== 'number' || !pos) return false
    const x = Math.floor(pos.x), y = Math.floor(pos.y), z = Math.floor(pos.z)
    const { w, d } = siteDimensions(state.rot | 0, state.blueprintVersion)
    if (x < site.x || x >= site.x + w || z < site.z || z >= site.z + d) return false
    return y >= site.y || absPlan(site, state.rot, state.blueprintVersion).at.has(`${x},${y},${z}`)
  } catch (_) { return false }
}

function billOfMaterials(plan) {
  const bom = {}
  for (const c of plan) bom[c.kind] = (bom[c.kind] || 0) + 1
  return bom
}

module.exports = {
  BLUEPRINT_VERSION,
  FULL_VERSION,
  SITE_W,
  SITE_D,
  TOWER,
  CRENELLATION_DY,
  DOOR,
  ENTRANCE,
  PLAN,
  BLUEPRINTS,
  blueprintOf,
  buildPlan,
  buildFullPlan,
  rotatePlan,
  siteDimensions,
  isPlaceTarget,
  billOfMaterials,
  matches,
  STONE_ITEMS,
  isStone,
  absPlan,
  protects,
  groundCell,
  inFootprint,
}
