'use strict'

// residence: the geometry of where the bot lives (idkcraft-g0z.28, slice 1
// of g0z.9). One descriptor per residence kind, pure (no bot/world reads):
//
//   entrance(home) -> { door, outside, inside, facing }   world cells
//   beds(home)     -> [{ foot, head, stage, facing }]     world cells
//   lights(home)   -> [{ dx, dy?, dz, ... }]  light plan, site-relative
//   chest(home)    -> [{ dx, dy, dz }]        chest candidates, site-relative
//   table(home)    -> world cell of the workbench
//   interior(home, pos) -> bool               pos on a residence floor
//   box(home)      -> { min, max }            whole building, inclusive
//
// facing: 0 north (-z), 1 east (+x), 2 south (+z), 3 west (-x) — the castle
// rot sense (rot r = entrance faces r). For a bed: foot -> head.
//
// hut/house are EXTRACTED from the call sites (home.js stances, beds.js
// cells, light/stockpile spot plans, the home.interior box): same values.
// The castle descriptor is added but no behaviour selects it yet (g0z.30).

const Vec3 = require('vec3')
const castle = require('./castle')

// --- hut (v1) / house (v2) ---------------------------------------------

// Light spot plans: comments live with the light step (behaviours/light.js).
const LIGHT_SPOTS = [
  { dx: 1, dz: -2 },
  { dx: -2, dz: -2 }, { dx: 4, dz: -2 },
  { dx: -2, dz: 1 }, { dx: 5, dz: -1 },
  { dx: -2, dz: 4 }, { dx: 4, dz: 4 },
  { dx: 1, dz: 5 },
  { dx: 1, dy: 3, dz: 1, stage: { dx: 0, dz: -1 } },
  { dx: 2, dz: 2, stage: { dx: 1, dz: -1 }, interior: true },
]
const LIGHT_SPOTS_V2 = [
  { dx: 3, dz: -2 },
  { dx: -2, dz: -2 }, { dx: 8, dz: -2 },
  { dx: -2, dz: 1 }, { dx: 8, dz: 1 },
  { dx: -2, dz: 4 }, { dx: 8, dz: 4 },
  { dx: 3, dz: 7 },
  { dx: 3, dy: 3, dz: 1, stage: { dx: 3, dz: -1 } },
  { dx: 1, dz: 1, stage: { dx: 3, dz: -1 }, interior: true },
]

// Chest candidate cells: comments live with the stockpile step.
const CHEST_SPOTS = [
  { dx: 5, dy: 0, dz: 1 },
  { dx: 4, dy: 0, dz: 0 },
  { dx: 4, dy: 0, dz: 2 },
  { dx: 5, dy: 0, dz: 0 },
  { dx: 5, dy: 0, dz: 2 },
  { dx: 6, dy: 0, dz: 1 },
]
const CHEST_SPOTS_V2 = [
  { dx: 5, dy: 0, dz: 2 },
  { dx: 1, dy: 0, dz: 2 },
  { dx: 2, dy: 0, dz: 1 },
  { dx: 1, dy: 0, dz: 1 },
  { dx: 4, dy: 0, dz: 1 },
]

function at(home, dx, dy, dz) {
  const s = home.site
  return new Vec3(s.x + dx, s.y + dy, s.z + dz)
}

// Door in the north wall at x = doorDx; stances one cell out / in.
function hutEntrance(doorDx) {
  return (home) => ({
    door: at(home, doorDx, 0, 0),
    outside: at(home, doorDx, 0, -1),
    inside: at(home, doorDx, 0, 1),
    facing: 0,
  })
}

// The home.interior box (goal.makeHome), floored: the box holds inclusive
// BLOCK coords and the entity carries a float (live jr2.3).
function boxInterior(home, pos) {
  const box = home && home.interior
  if (!pos || !box || !box.min || !box.max) return false
  const fx = Math.floor(pos.x)
  const fy = Math.floor(pos.y)
  const fz = Math.floor(pos.z)
  return fx >= box.min.x && fx <= box.max.x &&
    fy >= box.min.y && fy <= box.max.y &&
    fz >= box.min.z && fz <= box.max.z
}

const HUT = {
  kind: 'hut',
  entrance: hutEntrance(1),
  beds: () => [], // no bedrooms
  lights: () => LIGHT_SPOTS,
  chest: () => CHEST_SPOTS,
  table: (home) => at(home, 4, 0, 1), // build BLUEPRINT[0], outside the east wall
  interior: boxInterior,
  box: (home) => ({ min: at(home, 0, 0, 0), max: at(home, 3, 2, 3) }),
}

// House bedrooms (jr2.2): A is the bot's (sleep sets the respawn), B the
// owner's; head +x, placed through the south wall from foot.z + 2.
function houseBed(home, fx) {
  const foot = at(home, fx, 0, 4)
  return { foot, head: at(home, fx + 1, 0, 4), stage: at(home, fx, 0, 6), facing: 1 }
}

const HOUSE = {
  kind: 'house',
  entrance: hutEntrance(3),
  beds: (home) => [houseBed(home, 1), houseBed(home, 4)],
  lights: () => LIGHT_SPOTS_V2,
  chest: () => CHEST_SPOTS_V2,
  table: (home) => at(home, 5, 0, 1), // BLUEPRINT_V2[0], common room
  interior: boxInterior,
  box: (home) => ({ min: at(home, 0, -1, 0), max: at(home, 6, 2, 5) }), // dy -1: the bedroom floor fill
}

// --- castle (blueprint v2, the full castle) ----------------------------
//
// home carries the castle state shape: { site, rot } (the SW-corner site of
// castle.absPlan). Only the v2 castle has rooms: the v1 slice tower is no
// residence, so the descriptor always reads v2 — g0z.29 must never select
// it for a v1 castle.
const CV = 2
const BP = castle.blueprintOf(CV)
const COLLIDES = new Set(['stone', 'planks', 'frame', 'fence', 'chest'])

// rot-0 local cells (all checked against the plan in residence.test.js:
// no plan cell, no keep-clear cell). Bedrooms are the upper-storey rooms
// behind the partition (x12..14 / x16..18, z15..18, feet dy 4); each bed
// runs south along a wall, staged from the cell beside its foot.
const C_BEDS = [
  { foot: [12, 4, 17], head: [12, 4, 18], stage: [13, 4, 16] },
  { foot: [18, 4, 17], head: [18, 4, 18], stage: [17, 4, 16] },
]
const C_TABLE = [16, 0, 18] // ground storeroom, beside the plan chest (18,0,18)
const C_INSIDE = [BP.DOOR.dx, 0, BP.DOOR.dz + 1] // first hall cell behind the gate

// Residence floors, rot 0: every body-interior column (towers excluded —
// their stairwells are no living space) with a free 2-high feet space on
// the ground storey (dy 0, terrain floor) or the upper storey (dy 4, on
// the dy 3 slab: the stairwell over the ground stair has none). Hall,
// kitchen, storeroom and bedrooms, listed from the plan, not one box.
function castleFloors() {
  const plan = new Map(BP.PLAN.map((c) => [`${c.dx},${c.dy},${c.dz}`, c.kind]))
  const solid = (x, y, z) => COLLIDES.has(plan.get(`${x},${y},${z}`))
  const out = []
  for (let z = 8; z <= 18; z++) {
    for (let x = 8; x <= 22; x++) {
      if ((x <= 11 || x >= 19) && (z <= 11 || z >= 15)) continue // a corner tower
      for (const y of [0, 4]) {
        if (solid(x, y, z) || solid(x, y + 1, z)) continue
        if (y === 4 && plan.get(`${x},3,${z}`) !== 'planks') continue
        out.push({ dx: x, dy: y, dz: z })
      }
    }
  }
  return out
}
const C_FLOORS = castleFloors()

const rot = (home) => (home.rot | 0)
// rot-0 local [x,y,z] -> site-relative {dx,dy,dz} for the castle's rot.
function local(home, cells) {
  return castle.rotatePlan(cells.map(([dx, dy, dz]) => ({ dx, dy, dz, kind: 'air' })), rot(home), CV)
    .map(({ dx, dy, dz }) => ({ dx, dy, dz }))
}
function world(home, cells) {
  return local(home, cells).map((c) => at(home, c.dx, c.dy, c.dz))
}
// The world direction of a foot -> head pair.
function dirOf(a, b) {
  if (b.z < a.z) return 0
  if (b.x > a.x) return 1
  if (b.z > a.z) return 2
  return 3
}

let floorCache = null
function floorSet(home) {
  const s = home.site
  const key = `${s.x},${s.y},${s.z},${rot(home)}`
  if (floorCache && floorCache.key === key) return floorCache.set
  const set = new Set(world(home, C_FLOORS.map((c) => [c.dx, c.dy, c.dz])).map((p) => `${p.x},${p.y},${p.z}`))
  floorCache = { key, set }
  return set
}

const CASTLE = {
  kind: 'castle',
  entrance: (home) => {
    const [door, outside, inside] = world(home, [
      [BP.DOOR.dx, BP.DOOR.dy, BP.DOOR.dz],
      [BP.ENTRANCE.dx, BP.ENTRANCE.dy, BP.ENTRANCE.dz],
      C_INSIDE,
    ])
    return { door, outside, inside, facing: rot(home) % 4 }
  },
  beds: (home) => C_BEDS.map((b) => {
    const [foot, head, stage] = world(home, [b.foot, b.head, b.stage])
    return { foot, head, stage, facing: dirOf(foot, head) }
  }),
  lights: (home) => local(home, BP.PLAN.filter((c) => c.kind === 'torch').map((c) => [c.dx, c.dy, c.dz])),
  chest: (home) => local(home, BP.PLAN.filter((c) => c.kind === 'chest').map((c) => [c.dx, c.dy, c.dz])),
  table: (home) => world(home, [C_TABLE])[0],
  interior: (home, pos) => !!pos && floorSet(home).has(`${Math.floor(pos.x)},${Math.floor(pos.y)},${Math.floor(pos.z)}`),
  box: (home) => {
    const cells = castle.absPlan(home.site, rot(home), CV).cells
    const min = { x: Infinity, y: Infinity, z: Infinity }
    const max = { x: -Infinity, y: -Infinity, z: -Infinity }
    for (const c of cells) {
      for (const k of ['x', 'y', 'z']) { min[k] = Math.min(min[k], c[k]); max[k] = Math.max(max[k], c[k]) }
    }
    return { min: new Vec3(min.x, min.y, min.z), max: new Vec3(max.x, max.y, max.z) }
  },
}

// The descriptor of a home: a castle by kind, else by blueprint version —
// v2 the house, anything else (v1, or a home that predates the version
// mark) the hut.
function of(home) {
  if (home && home.kind === 'castle') return CASTLE
  return home && home.v === 2 ? HOUSE : HUT
}

module.exports = { of, HUT, HOUSE, CASTLE, LIGHT_SPOTS, LIGHT_SPOTS_V2, CHEST_SPOTS, CHEST_SPOTS_V2 }
