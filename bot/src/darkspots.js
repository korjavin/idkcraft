'use strict'

// Dark spawnable cells in a work area (prod 2026-11-16 bot3: six hostiles
// by day around the castle, deaths at -160 68 402 and in a cave 20 below).
// 1.18+ hostiles spawn on block light 0, so a dark cell is: air at the feet
// and head over a solid floor, block light 0 when the chunk carries light
// data, else (no light data) roofed; and no light propagated to it. Greedy
// picks: each picked torch spreads its light before the next pick, so a
// scan never queues neighbours one torch will light anyway. Pure leaf.

const { Vec3 } = require('vec3')

const AIR = new Set(['air', 'cave_air', 'void_air'])
const LIGHTS = new Set(['torch', 'wall_torch', 'lantern', 'soul_torch', 'soul_wall_torch', 'soul_lantern', 'glowstone', 'sea_lantern', 'shroomlight', 'jack_o_lantern', 'campfire', 'lava'])
const TORCH_LIGHT = 14 // block light at a torch, -1 per step through non-solid cells
const NB = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]
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
  // Block light is propagated here from every light the scan saw (prod
  // bot3: the bridge body's chunks carry no light, every cell read 0, so
  // torches piled on the ground floor and the upper storeys stayed dark).
  // Each picked torch joins the field, so the next pick lands past its glow.
  const lit = new Map()
  const spread = (sx, sy, sz) => {
    const q = [[sx, sy, sz, TORCH_LIGHT]]
    while (q.length) {
      const [x, y, z, l] = q.pop()
      const k = `${x},${y},${z}`
      if ((lit.get(k) || 0) >= l) continue
      lit.set(k, l)
      if (l <= 1) continue
      for (const [dx, dy, dz] of NB) {
        const b = at(bot, x + dx, y + dy, z + dz)
        if (b && !solid(b)) q.push([x + dx, y + dy, z + dz, l - 1])
      }
    }
  }
  for (const l of lights) spread(l.x, l.y, l.z)
  const dark = []
  for (const c of cand) {
    if (typeof c.light === 'number') {
      if (c.light > 0) continue
      c.roof = roofed(c)
    } else if (!(c.roof = roofed(c))) continue // shortcut: no light data + open sky reads lit, as before
    dark.push(c)
  }
  dark.sort((a, b) => (b.hot - a.hot) || (b.roof - a.roof))
  const out = []
  const floors = new Set()
  let darkN = 0
  for (const c of dark) {
    if (lit.get(`${c.x},${c.y},${c.z}`)) continue
    darkN++
    floors.add(c.y)
    if (out.length >= MAX) continue
    out.push(c.hot ? { x: c.x, y: c.y, z: c.z, hot: true } : { x: c.x, y: c.y, z: c.z })
    spread(c.x, c.y, c.z)
  }
  out.dark = darkN // still-dark cells after the picks' light
  out.floors = floors.size
  return out
}

module.exports = { scan, MAX, TORCH_LIGHT }
