'use strict'

// Dark spawnable cells in a work area (prod 2026-11-16 bot3: six hostiles
// by day around the castle, deaths at -160 68 402 and in a cave 20 below).
// 1.18+ hostiles spawn on block light 0, so a dark cell is: air at the feet
// and head over a solid floor, block light 0 when the chunk carries light
// data, else (no light data) roofed and no torch within TORCH_R. Greedy
// spacing: one torch per SPACING (light 14 still reads >= 6 there), so a
// scan never queues neighbours one torch will light anyway. Pure leaf.

const { Vec3 } = require('vec3')

const AIR = new Set(['air', 'cave_air', 'void_air'])
const LIGHTS = new Set(['torch', 'wall_torch', 'lantern', 'soul_torch', 'soul_wall_torch', 'soul_lantern', 'glowstone', 'sea_lantern', 'shroomlight', 'jack_o_lantern', 'campfire', 'lava'])
const SPACING = 8 // manhattan between picked torches
const TORCH_R = 7 // heuristic only: a known light this close lights the cell
const ROOF_UP = 6 // heuristic only: a solid block this far above = under a roof
const MAX = 16 // cells per scan: the next scan sees the new light

function at(bot, x, y, z) {
  try { return bot.blockAt(new Vec3(x, y, z)) } catch (_) { return null }
}
function solid(b) { return !!b && !AIR.has(b.name) && b.boundingBox === 'block' }
function open(b) { return !!b && AIR.has(b.name) }

// boxes: [{ x0, x1, y0, y1, z0, z1, hot? }] inclusive. hot boxes (death
// zones) rank first, then roofed cells (interiors, caves), then the rest.
// skip(x, y, z) vetoes a cell (plan cells). Returns [{ x, y, z }].
function scan(bot, boxes, skip) {
  const seen = new Set()
  const lights = []
  const cand = []
  for (const bx of boxes || []) {
    for (let x = bx.x0; x <= bx.x1; x++) {
      for (let z = bx.z0; z <= bx.z1; z++) {
        let below = at(bot, x, bx.y0 - 1, z)
        let here = at(bot, x, bx.y0, z)
        for (let y = bx.y0; y <= bx.y1; y++) {
          const above = at(bot, x, y + 1, z)
          const k = `${x},${y},${z}`
          if (here && !seen.has(k)) {
            seen.add(k)
            if (LIGHTS.has(here.name)) lights.push({ x, y, z })
            else if (open(here) && open(above) && solid(below) && !(skip && skip(x, y, z))) {
              cand.push({ x, y, z, light: here.light, hot: !!bx.hot })
            }
          }
          below = here
          here = above
        }
      }
    }
  }
  const roofed = (c) => {
    for (let d = 2; d <= ROOF_UP; d++) if (solid(at(bot, c.x, c.y + d, c.z))) return true
    return false
  }
  const dark = []
  for (const c of cand) {
    if (typeof c.light === 'number') {
      if (c.light > 0) continue
      c.roof = roofed(c)
    } else {
      // shortcut: no light data (fake worlds, old chunks) reads distance to known lights; prod chunks carry light.
      if (!(c.roof = roofed(c))) continue
      if (lights.some((l) => Math.abs(l.x - c.x) + Math.abs(l.y - c.y) + Math.abs(l.z - c.z) <= TORCH_R)) continue
    }
    dark.push(c)
  }
  dark.sort((a, b) => (b.hot - a.hot) || (b.roof - a.roof))
  const out = []
  for (const c of dark) {
    if (out.length >= MAX) break
    if (out.some((o) => Math.abs(o.x - c.x) + Math.abs(o.y - c.y) + Math.abs(o.z - c.z) < SPACING)) continue
    out.push(c.hot ? { x: c.x, y: c.y, z: c.z, hot: true } : { x: c.x, y: c.y, z: c.z })
  }
  return out
}

module.exports = { scan, SPACING, MAX, TORCH_R }
