'use strict'

// Face epsilon (idkcraft-ik7): Paper 26.x rejects EVERY move whose body-box
// edge exactly touches a solid face with a same-pos teleport (10/s idle,
// 20/s pressed — the wall-contact freeze; proven envelope #203/#216).
// prismarine-physics collision resolution (computeOffsetX/Y/Z) clamps the
// AABB BIT-EXACTLY onto the face, so every follow-up move re-touches and
// the storm never ends: every 1-up jump, all contact sliding, all
// current-pushed shore rests die with disp 0.00.
//
// Cure at the source: shift OUTGOING move packets a hair off contacted side
// faces, so the server never sees a touch — no driver can re-touch,
// whatever pushes the body (keys, current, gravity slide). Packets that
// clear every face pass through bit-identical; only dust-scale contacts
// (clamp residue, band sub-1e-6) are lifted to EPS.
//
// Deliberate limits:
// - Y is never touched: ground contact must stay bit-exact (standing IS a
//   face touch the server accepts), and no head-bump pin was ever observed.
// - Unknown cells shift nothing (fail-open = send as-is, chunk holes and
//   pre-login traffic pass through).
// - Real overlaps (deeper than DUST) shift nothing: a body genuinely inside
//   solid needs the server's correction, not our lie.
// - A two-sided pinch (both gaps < EPS, a sub-0.4 mm slot) cannot be
//   shifted clear of both faces; it stays pinned for unpin/recover.
// Ticker hook: none (packet tap). Install in runOnce next to
// installUnpinTap (real bot only).

const { Vec3 } = require('vec3')
const metrics = require('./metrics')

const BODY_W = 0.6
const BODY_H = 1.8
const EPS = 2e-4 // claimed clearance: 200x the pin band, 50x below the 1 cm cure
const DUST = 1e-3 // deeper than this is a real overlap, not clamp residue
const OVERLAP_TOL = 1e-3 // tangential overlap tolerance (same band as unpin)
const CELL_EPS = 1e-7 // an exact upper bound touches the next cell but doesn't occupy it

function bodyBox(p) {
  return { x0: p.x - BODY_W / 2, x1: p.x + BODY_W / 2, y0: p.y, y1: p.y + BODY_H, z0: p.z - BODY_W / 2, z1: p.z + BODY_W / 2 }
}

function bodyCells(bb) {
  const cells = []
  for (let cx = Math.floor(bb.x0); cx <= Math.floor(bb.x1 - CELL_EPS); cx++) {
    for (let cy = Math.floor(bb.y0); cy <= Math.floor(bb.y1 - CELL_EPS); cy++) {
      for (let cz = Math.floor(bb.z0); cz <= Math.floor(bb.z1 - CELL_EPS); cz++) {
        cells.push([cx, cy, cz])
      }
    }
  }
  return cells
}

function blockName(b) {
  return b && typeof b.name === 'string' ? b.name : ''
}

function solid(b) {
  if (!b) return false
  if (typeof b.boundingBox === 'string') return b.boundingBox !== 'empty' && b.name !== 'water' && b.name !== 'lava'
  const n = blockName(b)
  return n !== '' && !n.endsWith('air') && n !== 'water' && n !== 'lava'
}

function cellAt(bot, cx, cy, cz) {
  try {
    if (!bot || typeof bot.blockAt !== 'function') return null
    return bot.blockAt(new Vec3(cx, cy, cz))
  } catch (_) { return null }
}

// Collision shapes as absolute boxes. Live mineflayer blocks carry
// state-specific .shapes; shapeless solid fakes fall back to a full cube.
// Returns null for unknown cells (chunk hole) — distinct from empty.
function shapeBoxes(bot, cx, cy, cz) {
  const b = cellAt(bot, cx, cy, cz)
  if (!b) return null
  const rel = Array.isArray(b.shapes) ? b.shapes : (solid(b) ? [[0, 0, 0, 1, 1, 1]] : [])
  return rel.map((s) => [s[0] + cx, s[1] + cy, s[2] + cz, s[3] + cx, s[4] + cy, s[5] + cz])
}

function overlap1(a0, a1, b0, b1) { return a0 < b1 - OVERLAP_TOL && a1 > b0 + OVERLAP_TOL }

// Signed clearance from each horizontal body face to the nearest solid
// shape plane facing it: positive = free gap, negative = overlap depth,
// Infinity = no face within reach. Only shapes with real tangential
// overlap count; unknown cells contribute nothing (fail-open). Checks body
// cells AND outward neighbours (a door slab can live in the body's cell).
// Two masks are excluded so they cannot hide a dust contact: shapes that
// never reach the face from the facing side (a plane behind the body would
// read as a huge negative gap), and real overlaps (deeper than DUST — the
// server's correction owns those, and a deep track would veto the shift a
// neighbouring touch still needs).
function sideGaps(bot, bb) {
  const gaps = { '-x': Infinity, '+x': Infinity, '-z': Infinity, '+z': Infinity }
  const seen = new Set()
  const cells = bodyCells(bb)
  const dirs = [[-1, 0, '-x'], [1, 0, '+x'], [0, -1, '-z'], [0, 1, '+z']]
  for (const [dx, dz, side] of dirs) {
    const face = side === '-x' ? bb.x0 : side === '+x' ? bb.x1 : side === '-z' ? bb.z0 : bb.z1
    for (const [cx, cy, cz] of cells) {
      for (const q of [[cx, cz], [cx + dx, cz + dz]]) {
        const key = `${side}:${q[0]},${cy},${q[1]}`
        if (seen.has(key)) continue
        seen.add(key)
        const boxes = shapeBoxes(bot, q[0], cy, q[1])
        if (!boxes) continue
        for (const s of boxes) {
          const reaches = side === '-x' ? s[0] < face : side === '+x' ? s[3] > face
            : side === '-z' ? s[2] < face : s[5] > face
          if (!reaches) continue
          const tang = (dx !== 0)
            ? overlap1(s[1], s[4], bb.y0, bb.y1) && overlap1(s[2], s[5], bb.z0, bb.z1)
            : overlap1(s[0], s[3], bb.x0, bb.x1) && overlap1(s[1], s[4], bb.y0, bb.y1)
          if (!tang) continue
          const plane = side === '-x' ? s[3] : side === '+x' ? s[0] : side === '-z' ? s[5] : s[2]
          const gap = (side === '-x' || side === '-z') ? face - plane : plane - face
          if (gap > -DUST && gap < gaps[side]) gaps[side] = gap
        }
      }
    }
  }
  return gaps
}

// Per-axis shift: lift every dust-scale contact (clamp residue or float
// dust, either sign) out to EPS. Touches nothing when both gaps clear EPS
// (packets pass bit-identical) or when a gap is a real overlap. X and Z
// are measured at the same claimed pos — no iteration: a <=1.2 mm shift
// along one axis cannot create an overlap along the other (it moves AWAY),
// it can only flip a tangential verdict at the 1 mm tolerance edge, which
// costs at most one more harmless 0.2 mm shift.
function shiftFor(gMinus, gPlus) {
  let s = 0
  if (gMinus < EPS && gMinus > -DUST) s += (EPS - gMinus)
  if (gPlus < EPS && gPlus > -DUST) s -= (EPS - gPlus)
  return s
}

// Shifted horizontal claim for (x, y, z). Y is input-only (it selects the
// body cells); the returned claim keeps the caller's y.
function decontact(bot, x, y, z) {
  try {
    const bb = bodyBox({ x, y, z })
    const gaps = sideGaps(bot, bb)
    return { x: x + shiftFor(gaps['-x'], gaps['+x']), z: z + shiftFor(gaps['-z'], gaps['+z']), gaps }
  } catch (_) {
    return { x, z, gaps: null } // world unreadable: send as-is
  }
}

// Gate: the touch-reject is observed 26.x behaviour. Unknown version
// (pre-login, unit mocks) fails open — a sub-mm shift is accepted by any
// server, and the real bot always negotiates a version before it can move.
function enabledFor(bot) {
  try {
    const v = bot && bot.version
    if (v == null || v === '') return true
    return String(v).split('.')[0] === '26'
  } catch (_) { return true }
}

// Packet-tap install (runOnce, real bot only). Idempotent. Wraps
// client.write: position/position_look claims are decontacted, everything
// else passes through untouched.
function installFaceEpsilon(bot) {
  if (!bot || bot._faceEpsInstalled) return false
  const client = bot._client
  if (!client || typeof client.write !== 'function') return false
  bot._faceEpsInstalled = true
  const origWrite = client.write.bind(client)
  client.write = function (name, params) {
    if ((name === 'position' || name === 'position_look') && params && typeof params.x === 'number' && enabledFor(bot)) {
      try {
        const c = decontact(bot, params.x, params.y, params.z)
        if (c.x !== params.x || c.z !== params.z) {
          params = { ...params, x: c.x, z: c.z }
          bot._faceEpsShifts = (bot._faceEpsShifts || 0) + 1
          try { metrics.events.inc({ event: 'faceeps_shift' }) } catch (_) { /* metrics best-effort */ }
        }
      } catch (_) { /* decontact best-effort: send as-is */ }
    }
    return origWrite(name, params)
  }
  return true
}

module.exports = {
  installFaceEpsilon,
  decontact,
  sideGaps,
  enabledFor,
  bodyBox,
  EPS,
  DUST,
}
