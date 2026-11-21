'use strict'

// Farm plan cells (idkcraft-qphv.1/.2), split from farm-blueprint.js so the
// dig guard (behaviours/util.js) reads them without the site scan's requires.
// Layout notes: farm-blueprint.js.

const W = 27
const D = 9
const DOOR = { dx: 3, dz: 0 }
const GATE = { dx: 12, dz: 0 }
const FIELD_GATE = { dx: 22, dz: 0 }
const WATER = { dx: 22, dz: 4 }
const BARN = { x0: 0, x1: 6, z0: 0, z1: 5 }
const PEN = { x0: 8, x1: 16, z0: 0, z1: 8 }
const FIELD = { x0: 18, x1: 26, z0: 0, z1: 8 }

function edge(b, x, z) { return x === b.x0 || x === b.x1 || z === b.z0 || z === b.z1 }

const PLAN = (() => {
  const plan = []
  const c = (dx, dy, dz, kind, phase) => plan.push({ dx, dy, dz, kind, phase })
  for (let x = BARN.x0 + 1; x < BARN.x1; x++) for (let z = BARN.z0 + 1; z < BARN.z1; z++) c(x, 0, z, 'clear', 'barn')
  c(5, 0, 4, 'chest', 'barn')
  const ring = (dy) => {
    for (let x = BARN.x0; x <= BARN.x1; x++) {
      for (let z = BARN.z0; z <= BARN.z1; z++) {
        if (edge(BARN, x, z) && !(x === DOOR.dx && z === DOOR.dz)) c(x, dy, z, 'planks', 'barn')
      }
    }
  }
  ring(0)
  c(DOOR.dx, 0, DOOR.dz, 'door', 'barn')
  ring(1)
  for (let x = BARN.x0; x <= BARN.x1; x++) for (let z = BARN.z0; z <= BARN.z1; z++) c(x, 2, z, 'planks', 'barn')
  for (let x = PEN.x0; x <= PEN.x1; x++) {
    for (let z = PEN.z0; z <= PEN.z1; z++) {
      if (edge(PEN, x, z)) c(x, 0, z, x === GATE.dx && z === GATE.dz ? 'gate' : 'fence', 'pen')
    }
  }
  for (let x = FIELD.x0; x <= FIELD.x1; x++) for (let z = FIELD.z0; z <= FIELD.z1; z++) c(x, 0, z, 'clear', 'field')
  c(WATER.dx, -1, WATER.dz, 'clear', 'field')
  c(WATER.dx, -1, WATER.dz, 'water', 'field') // water first: the farmland stays hydrated
  // farmland only inside the fence ring: every cell <=3 from the water (hydration reach 4)
  for (let x = FIELD.x0 + 1; x < FIELD.x1; x++) {
    for (let z = FIELD.z0 + 1; z < FIELD.z1; z++) {
      if (!(x === WATER.dx && z === WATER.dz)) c(x, -1, z, 'farmland', 'field')
    }
  }
  // fence + gate ring on the field edge: mobs reverted the open field by trampling (prod bot2 183->109/199)
  for (let x = FIELD.x0; x <= FIELD.x1; x++) {
    for (let z = FIELD.z0; z <= FIELD.z1; z++) {
      if (edge(FIELD, x, z)) c(x, 0, z, x === FIELD_GATE.dx && z === FIELD_GATE.dz ? 'gate' : 'fence', 'field')
    }
  }
  return Object.freeze(plan)
})()

function inField(dx, dz) { return dx >= FIELD.x0 && dx <= FIELD.x1 && dz >= FIELD.z0 && dz <= FIELD.z1 }

// Laid farm cells are guarded like castle cells (qphv.2): a plan cell
// holding its own block is no other step's to dig or pour from.
const LAID = {
  planks: (n) => n.endsWith('_planks'), door: (n) => n.endsWith('_door'), fence: (n) => n.endsWith('_fence'),
  gate: (n) => n.endsWith('_fence_gate'), chest: (n) => n === 'chest', farmland: (n) => n === 'farmland', water: (n) => n === 'water',
}
const AT = new Map()
for (const c of PLAN) if (LAID[c.kind]) AT.set(`${c.dx},${c.dy},${c.dz}`, LAID[c.kind])
function protects(fb, pos, name) {
  const s = fb && fb.site
  if (!s || !pos || typeof name !== 'string') return false
  const laid = AT.get(`${Math.floor(pos.x) - s.x},${Math.floor(pos.y) - s.y},${Math.floor(pos.z) - s.z}`)
  return !!laid && laid(name)
}

// Field box in world coords (feet level over the farmland included).
function inFieldAt(fb, pos) {
  const s = fb && fb.site
  if (!s || !pos) return false
  const dx = Math.floor(pos.x) - s.x, dy = Math.floor(pos.y) - s.y, dz = Math.floor(pos.z) - s.z
  return inField(dx, dz) && dy >= -1 && dy <= 1
}

module.exports = { PLAN, W, D, DOOR, GATE, FIELD_GATE, WATER, BARN, PEN, FIELD, inField, protects, inFieldAt }
