'use strict'

const Vec3 = require('vec3')

// Farm blueprint (idkcraft-qphv.1): a house-style plan (behaviours/build.js
// cells {dx,dy,dz,kind}, LAY ORDER) laid by the house builder on a
// home of kind 'farm'. One 27x9 strip, origin = SW corner at ground level:
//   x 0..6   barn: 7x6, walls 2 high, flat roof, door (3,0,0), chest inside
//            at (5,0,4); the free interior holds hay bales later;
//   x 8..16  pen: 9x9 fence ring at ground level, gate at (12,0,0) (.3 keeps animals);
//   x 18..26 field: 9x9 farmland at dy -1 around one water cell (22,-1,4).
// 'clear' cells dig natural ground (bumps, the water pit) and are no work in
// the progress count; 'farmland' is tilled with a hoe, 'water' poured from a bucket.

const W = 27
const D = 9
const DOOR = { dx: 3, dz: 0 }
const GATE = { dx: 12, dz: 0 }
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
  for (let x = FIELD.x0; x <= FIELD.x1; x++) {
    for (let z = FIELD.z0; z <= FIELD.z1; z++) {
      if (!(x === WATER.dx && z === WATER.dz)) c(x, -1, z, 'farmland', 'field')
    }
  }
  return Object.freeze(plan)
})()

function inField(dx, dz) { return dx >= FIELD.x0 && dx <= FIELD.x1 && dz >= FIELD.z0 && dz <= FIELD.z1 }

// Footprint test at origin (ox, oz): every column resolves to ground within
// one block (site.groundY: no water, no built surface), the door and gate
// columns sit at the base level, and the field ground is tillable soil.
// Returns the base y or null.
function footprintY(bot, ox, oz, topY) {
  const { groundY } = require('./site')
  const ys = []
  for (let dx = 0; dx < W; dx++) {
    for (let dz = 0; dz < D; dz++) {
      const gy = groundY(bot, ox + dx, oz + dz, topY)
      if (gy == null) return null
      if (inField(dx, dz)) {
        let b = null
        try { b = bot.blockAt(new Vec3(ox + dx, gy - 1, oz + dz)) } catch (_) { b = null }
        if (!b || (b.name !== 'grass_block' && b.name !== 'dirt')) return null
      }
      ys.push(gy)
    }
  }
  const y0 = Math.min(...ys)
  if (!ys.every((y) => y === y0 || y === y0 + 1)) return null
  const at = (p) => ys[p.dx * D + p.dz]
  if (at(DOOR) !== y0 || at(GATE) !== y0) return null
  return y0
}

// Overlap with a box {x0,z0,x1,z1} grown by pad.
function overlaps(ox, oz, box, pad) {
  return !(ox + W - 1 < box.x0 - pad || ox > box.x1 + pad || oz + D - 1 < box.z0 - pad || oz > box.z1 + pad)
}

const RADII = [14, 22, 30, 38]
const DIRS = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]]
// First fitting origin on rings around `around`, clear of the `avoid` boxes.
function siteFor(bot, around, avoid = []) {
  if (!around || typeof around.x !== 'number' || typeof around.z !== 'number') return null
  const cy = typeof around.y === 'number' ? Math.floor(around.y) : 64
  for (const r of RADII) {
    for (const [ux, uz] of DIRS) {
      const ox = Math.floor(around.x + ux * r - W / 2)
      const oz = Math.floor(around.z + uz * r - D / 2)
      if (avoid.some((b) => overlaps(ox, oz, b, 3))) continue
      const y = footprintY(bot, ox, oz, cy + 8)
      if (y != null) return { x: ox, y, z: oz }
    }
  }
  return null
}

module.exports = { PLAN, W, D, DOOR, GATE, WATER, BARN, PEN, FIELD, siteFor, footprintY }
