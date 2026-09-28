'use strict'

// Hover-arrest watchdog (idkcraft-1cj): Paper 26.x rejects EVERY move whose
// box edge exactly touches a solid face (bit-exact contact, band sub-1e-6)
// with a same-pos teleport, 10/s idle, 20/s pressed. Cure: step 1 cm off on
// a move packet cloned from mineflayer's own last send (coords rebased to
// the live entity position, so the delta is pure-horizontal).
//
// CEILING: the touch is planted by prismarine-physics clipping and locked by
// Paper validation — both outside bot code, prevention impossible (0.05 scan
// margins vs a 1e-6 band). Proven envelope is air-touch with a survivable
// landing; everything else (water, lava, mounts, climbs, faces unknown,
// lethal below) belongs to swim/recover/stuck, never here.
// Ticker hook: index.js runTick (1 Hz while active).

const { Vec3 } = require('vec3')
const metrics = require('./metrics')

const STORM_WINDOW_MS = 2000 // trailing teleport-rate window
const STORM_MIN_TPS = 6 // teleports in the window = storm (pin: 20 idle, 40 pressed; calm: <=2)
const STORM_MAX_DISP = 0.3 // max teleport-target spread (pin: 0.00; walking under corrections scatters)
const NUDGE_DIST = 0.01 // 1 cm: 1e4x the pin band, 1e-2x anything physics-noticeable
const VERIFY_MIN_MS = 700 // nudge -> first verdict gap (an accepted nudge calms the storm <200 ms)
const VERIFY_CONFIRM_MS = 1500 // nudge -> success gap (freedom must hold, not flicker)
const VERIFY_SETTLE_MS = 150 // teleports inside this after a nudge are the storm's tail
const VERIFY_MAX_TPS = 2 // teleports past the settle gap = still storming
const VERIFY_DISP_MIN = 0.15 // displacement evidence for freedom (the nudge itself is 0.01)
const BELOW_SCAN_MAX = 30 // below-scan depth: past it a fall kills at full hp, whatever is there
const REARM_DIST = 1.0 // body moved this far from a failed anchor: new spot, re-arm
const WIN_TTL_MS = 60000 // win memory prune horizon
const PRESS_WINDOW_MS = 20000 // 3 wins this close at one anchor = sustained press: rest
const PRESS_MAX_WINS = 3
// Climb-or-passable: no lockable face (ladder/scaffold read bb=block in the
// data, but sides are passable/uncertain), no landable top (scaffold support
// unknown), climb physics owns any storm here.
const CLIMBABLES = new Set([
  'ladder', 'vine', 'scaffolding',
  'twisting_vines', 'twisting_vines_plant', 'weeping_vines', 'weeping_vines_plant',
  'cave_vines', 'cave_vines_plant',
])

function state(ctx) {
  if (!ctx.unpin) ctx.unpin = { teleports: [], lastMove: null, sendNudge: null, anchor: null, tries: [], stoodDown: null, wins: [] }
  return ctx.unpin
}

// pos is the server's teleport target (post-apply entity sample, always
// absolute — see installUnpinTap): its spread is the displacement evidence.
function noteTeleport(ctx, t, pos = null) {
  const st = state(ctx)
  const p = pos && typeof pos.x === 'number' ? { x: pos.x, y: pos.y, z: pos.z } : null
  st.teleports.push({ t, pos: p })
  prune(st, t)
  return st.teleports.length
}

function noteMoveParams(ctx, name, params) {
  const st = state(ctx)
  try {
    st.lastMove = { name, params: { ...params, flags: params && params.flags ? { ...params.flags } : params.flags } }
  } catch (_) { /* clone best-effort */ }
  return !!st.lastMove
}

function prune(st, now) {
  while (st.teleports.length > 0 && st.teleports[0].t < now - STORM_WINDOW_MS) st.teleports.shift()
  while (st.teleports.length > 60) st.teleports.shift()
  st.wins = (st.wins || []).filter((w) => now - w.t < WIN_TTL_MS)
}

function stormSpread(st) {
  const w = st.teleports
  if (w.length === 0) return null
  const ref = w[w.length - 1].pos
  if (!ref) return null
  let spread = 0
  for (const tp of w) {
    if (!tp.pos) return null
    const d = Math.hypot(tp.pos.x - ref.x, tp.pos.y - ref.y, tp.pos.z - ref.z)
    if (d > spread) spread = d
  }
  return spread
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

// Player body box (feet-centre pos): 0.6 wide, 1.8 tall.
const BODY_W = 0.6
const BODY_H = 1.8
const CONTACT_EPS = 1e-3 // contact band: 1e3x the pin band, 10x below the nudge
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

// Collision shapes as absolute boxes. Live mineflayer blocks carry
// state-specific .shapes; shapeless solid fakes fall back to a full cube.
// Returns null for unknown cells (chunk hole) — distinct from empty.
function shapeBoxes(bot, cx, cy, cz) {
  const b = cellAt(bot, cx, cy, cz)
  if (!b) return null
  const rel = Array.isArray(b.shapes) ? b.shapes : (solid(b) ? [[0, 0, 0, 1, 1, 1]] : [])
  return { name: blockName(b), boxes: rel.map((s) => [s[0] + cx, s[1] + cy, s[2] + cz, s[3] + cx, s[4] + cy, s[5] + cz]) }
}

function overlap1(a0, a1, b0, b1) { return a0 < b1 - CONTACT_EPS && a1 > b0 + CONTACT_EPS } // sub-mm = touching, not overlap (float dust at exact faces)

// True shape contact on side (dx,dz): a solid plane within CONTACT_EPS of
// the body's face with real tangential overlap. Checks body cells AND
// outward neighbours (a door slab can live in the body's own cell).
// Unknown cells prove nothing; climbables are excluded (climb vetoes own
// those storms, same as before).
function sideContact(bot, bb, dx, dz) {
  const seen = new Set()
  for (const [cx, cy, cz] of bodyCells(bb)) {
    for (const q of [[cx, cz], [cx + dx, cz + dz]]) {
      const key = `${q[0]},${cy},${q[1]}`
      if (seen.has(key)) continue
      seen.add(key)
      const sb = shapeBoxes(bot, q[0], cy, q[1])
      if (!sb || CLIMBABLES.has(sb.name)) continue
      for (const s of sb.boxes) {
        const plane = dx === -1 ? s[3] : dx === 1 ? s[0] : dz === -1 ? s[5] : s[2]
        const face = dx === -1 ? bb.x0 : dx === 1 ? bb.x1 : dz === -1 ? bb.z0 : bb.z1
        if (Math.abs(plane - face) > CONTACT_EPS) continue
        const tang = dx !== 0
          ? overlap1(s[1], s[4], bb.y0, bb.y1) && overlap1(s[2], s[5], bb.z0, bb.z1)
          : overlap1(s[0], s[3], bb.x0, bb.x1) && overlap1(s[1], s[4], bb.y0, bb.y1)
        if (tang) return true
      }
    }
  }
  return false
}

// Destination validation: the stepped body must not end inside solid
// (strict overlap; touching is fine) nor in unknown cells. No name
// carve-outs: any shape overlap vetoes (conservative = safe).
function destFree(bot, p, dx, dz) {
  const bb = bodyBox({ x: p.x + dx, y: p.y, z: p.z + dz })
  for (const [cx, cy, cz] of bodyCells(bb)) {
    const sb = shapeBoxes(bot, cx, cy, cz)
    if (!sb) return false
    for (const s of sb.boxes) {
      if (overlap1(s[0], s[3], bb.x0, bb.x1) && overlap1(s[1], s[4], bb.y0, bb.y1) && overlap1(s[2], s[5], bb.z0, bb.z1)) {
        return false
      }
    }
  }
  return true
}

function cellAt(bot, cx, cy, cz) {
  try {
    if (!bot || typeof bot.blockAt !== 'function') return null
    return bot.blockAt(new Vec3(cx, cy, cz))
  } catch (_) { return null }
}

function posOf(bot) {
  try {
    const p = bot && bot.entity && bot.entity.position
    if (p && typeof p.x === 'number' && typeof p.y === 'number' && typeof p.z === 'number') {
      return { x: p.x, y: p.y, z: p.z }
    }
  } catch (_) { /* no position */ }
  return null
}

function dist3(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)
}

function liquidAt(bot, pos, kind) {
  if (bot && bot.entity && ((kind === 'water' && bot.entity.isInWater === true) || (kind === 'lava' && bot.entity.isInLava === true))) return true
  const feet = pos && bot ? cellAt(bot, Math.floor(pos.x), Math.floor(pos.y), Math.floor(pos.z)) : null
  return !!feet && blockName(feet).includes(kind)
}

function climbableAt(bot, pos) {
  if (!pos || !bot || typeof bot.blockAt !== 'function') return false
  const fx = Math.floor(pos.x)
  const fy = Math.floor(pos.y)
  const fz = Math.floor(pos.z)
  return CLIMBABLES.has(blockName(cellAt(bot, fx, fy, fz))) || CLIMBABLES.has(blockName(cellAt(bot, fx, fy + 1, fz)))
}

// Away-steps off proven shape contact only (unknown terrain never nudges),
// each destination-validated: the stepped body must not end inside solid.
// Corners cure sequentially (parallel moves preserve earlier gaps
// bit-exactly — no delta means no change).
const AXIS = [[-1, 0], [1, 0], [0, -1], [0, 1]]
const nz = (v) => (v === 0 ? 0 : v) // -0 doubles as +0 except deepEqual and the wire
function orderNudgeDirs(bot) {
  const away = []
  try {
    const p = posOf(bot)
    if (p) {
      const bb = bodyBox(p)
      for (const [dx, dz] of AXIS) {
        const step = [nz(-dx * NUDGE_DIST), nz(-dz * NUDGE_DIST)]
        if (sideContact(bot, bb, dx, dz) && destFree(bot, p, step[0], step[1])) {
          away.push(step)
        }
      }
    }
  } catch (_) { /* scan best-effort */ }
  return away // ≤4 (one per axis): the tried-set over this universe bounds every episode
}

// Landing feasibility for the freed fall: the escape must not kill. Scans
// level by level under the whole body footprint (a straddler's edge counts);
// the highest landing across columns wins (the still-air fall path; drift
// is the brain's business post-free). Landing tops come from shapes (a slab
// top is 0.5 below the cell top). Strict: any lava/unknown at or above the
// landing vetoes; any water saves. Returns null when survivable, else why.
function belowVeto(bot, pos) {
  const bb = bodyBox(pos)
  const cols = []
  for (let cx = Math.floor(bb.x0); cx <= Math.floor(bb.x1 - CELL_EPS); cx++) {
    for (let cz = Math.floor(bb.z0); cz <= Math.floor(bb.z1 - CELL_EPS); cz++) {
      cols.push([cx, cz])
    }
  }
  const hp = bot && typeof bot.health === 'number' ? bot.health : 20 // real bots report; mocks fail open
  for (let y = Math.floor(bb.y0) - 1; (bb.y0 - (y + 1)) <= BELOW_SCAN_MAX; y--) {
    let top = -Infinity
    for (const [cx, cz] of cols) {
      const b = cellAt(bot, cx, y, cz)
      if (!b) return 'unknown-below'
      const n = blockName(b)
      if (n.includes('lava')) return 'lava-below'
      if (n.includes('water')) return null // any water breaks any fall
      if (CLIMBABLES.has(n)) continue
      const rel = Array.isArray(b.shapes) ? b.shapes : (solid(b) ? [[0, 0, 0, 1, 1, 1]] : [])
      for (const s of rel) {
        if (s[4] + y > top) top = s[4] + y
      }
    }
    if (top > -Infinity) {
      const dmg = Math.max(0, Math.floor((bb.y0 - top) - 3)) // MC: floor(fall - 3)
      return dmg >= hp ? 'lethal-below' : null
    }
  }
  return 'lethal-below' // nothing to land on: void or death-certain
}

// Full eligibility, checked at detection AND before every retry (stable
// gates only on retry — see below). Returns null when the watchdog may
// act, else the veto reason. The flag sample is NOT a verdict (every
// teleport falsifies onGround until the next physics tick): proven rest
// vetoes at detection, a down flag proceeds — re-pin locks read down and
// need the cure; grounded-press episodes are bounded (a live storm re-verifies
// to tried-set exhaustion, then rests; each try is 1 cm) and indistinguishable
// in one sample.
function eligible(bot, pos, forRetry = false) {
  // No flag re-gate on retry (revmux-01 churn proof): a true read mid-storm
  // is a flap, and dropping on flaps resets tries forever instead of
  // bounding them. Landed+calm already returned above; storming+true must
  // continue to the next verified try or stand down.
  if (!forRetry && (!bot || !bot.entity || bot.entity.onGround !== false)) return 'rest'
  if (liquidAt(bot, pos, 'water')) return 'wet'
  if (liquidAt(bot, pos, 'lava')) return 'lava'
  if (bot.entity.vehicle != null) return 'mounted'
  if (climbableAt(bot, pos)) return 'climb'
  if (orderNudgeDirs(bot).length === 0) return 'noface'
  return belowVeto(bot, pos)
}

function sendTry(ctx, dir, base) {
  const st = state(ctx)
  if (typeof st.sendNudge !== 'function') return false
  try {
    return st.sendNudge(dir[0], dir[1], base) === true
  } catch (_) { return false }
}

// Latest server correction still inside the evidence window: the only base
// a nudge may rebase onto (F5: live prediction drags client error along,
// so the claimed delta would not be the pure 1 cm step).
function freshBase(st, now) {
  for (let i = st.teleports.length - 1; i >= 0; i--) {
    const tp = st.teleports[i]
    if (tp.pos && now - tp.t < STORM_WINDOW_MS) return tp.pos
  }
  return null
}

function drop(ctx, reason, pos) {
  const st = state(ctx)
  st.anchor = null
  st.tries = []
  console.log(`unpin drop ${reason} pos=${pos.x.toFixed(1)},${pos.y.toFixed(1)},${pos.z.toFixed(1)}`)
  return 'idle'
}

// Per-tick check. Returns idle | watching | nudged | verifying | freed |
// stood-down. The only side effect is one cloned packet per nudge.
function unpinTick(bot, ctx, now = Date.now()) {
  const st = state(ctx)
  const pos = posOf(bot)
  if (!pos) return 'idle'
  prune(st, now)

  if (st.stoodDown && dist3(pos, st.stoodDown) > REARM_DIST) {
    st.stoodDown = null
    st.anchor = null
    st.tries = []
  }
  if (st.stoodDown && st.stoodDown.kind === 'press') {
    const rapid = (st.wins || []).filter((w) => dist3(pos, w) < REARM_DIST && now - w.t < PRESS_WINDOW_MS).length
    if (rapid === 0) { st.stoodDown = null; st.anchor = null; st.tries = [] }
  }

  // Verify a nudge in flight: silence AND sustained displacement (a quiet
  // window alone proves nothing — traffic can pause while pinned).
  const last = st.tries.length > 0 ? st.tries[st.tries.length - 1] : null
  if (last && !last.verdict) {
    if (now - last.t < VERIFY_MIN_MS) return 'verifying'
    const tail = st.teleports.filter((tp) => tp.t > last.t + VERIFY_SETTLE_MS).length
    const disp = dist3(pos, last.from)
    if (tail <= VERIFY_MAX_TPS && disp >= VERIFY_DISP_MIN) {
      last.verdict = 'pending' // half evidence; confirm next tick (no snapback)
      return 'verifying'
    }
    if (tail <= VERIFY_MAX_TPS) return drop(ctx, 'calm-unmoved', pos) // calm but still: not a reject-lock
    last.verdict = 'storming'
  } else if (last && last.verdict === 'pending') {
    if (now - last.t < VERIFY_CONFIRM_MS) return 'verifying'
    const tail = st.teleports.filter((tp) => tp.t > last.t + VERIFY_SETTLE_MS).length
    const disp = dist3(pos, last.from)
    if (tail <= VERIFY_MAX_TPS && disp >= VERIFY_DISP_MIN) {
      st.wins.push({ x: pos.x, y: pos.y, z: pos.z, t: now })
      st.anchor = null
      st.tries = []
      try { metrics.events.inc({ event: 'unpin_freed' }) } catch (_) { /* metrics best-effort */ }
      console.log(`unpin freed sustained disp=${disp.toFixed(2)} pos=${pos.x.toFixed(1)},${pos.y.toFixed(1)},${pos.z.toFixed(1)}`)
      return 'freed'
    }
    if (tail <= VERIFY_MAX_TPS) return drop(ctx, 'calm-unmoved', pos)
    last.verdict = 'storming'
  }

  const inEpisode = !!st.anchor
  if (!inEpisode) {
    if (st.teleports.length < STORM_MIN_TPS) return st.teleports.length > 0 ? 'watching' : 'idle'
    const spread = stormSpread(st)
    if (spread === null || spread >= STORM_MAX_DISP) return 'watching'
    if (eligible(bot, pos) !== null) return 'watching'
    if (st.stoodDown) return 'watching'
    const rapidWins = (st.wins || []).filter((w) => dist3(pos, w) < REARM_DIST && now - w.t < PRESS_WINDOW_MS).length
    if (rapidWins >= PRESS_MAX_WINS) {
      st.stoodDown = { ...pos, kind: 'press' }
      console.log(`unpin stand-down press-loop wins=${rapidWins}/20s pos=${pos.x.toFixed(1)},${pos.y.toFixed(1)},${pos.z.toFixed(1)}`)
      return 'stood-down'
    }
    if (!st.lastMove || typeof st.sendNudge !== 'function') return 'watching'
    st.anchor = { ...pos, t: now }
    st.tries = []
    try { metrics.events.inc({ event: 'unpin_storm' }) } catch (_) { /* metrics best-effort */ }
    console.log(`unpin storm teleports=${st.teleports.length}/2s disp=0.00 pos=${pos.x.toFixed(1)},${pos.y.toFixed(1)},${pos.z.toFixed(1)}`)
  }
  // A body that moves needs no nudge — drop (also catches frees the strict
  // tail count misses, and re-pins, which re-detect as fresh episodes).
  if (st.anchor && dist3(pos, { x: st.anchor.x, y: st.anchor.y, z: st.anchor.z }) >= STORM_MAX_DISP) {
    return drop(ctx, 'moved', pos)
  }
  // Re-gate every retry (conditions change mid-episode: splashes, mounts,
  // climbs, faces gone, landing turned lethal). Each drop condition persists
  // into a detection veto — no churn.
  const veto = eligible(bot, pos, true)
  if (veto !== null) return drop(ctx, veto, pos)
  const order = orderNudgeDirs(bot)
  const tried = new Set(st.tries.map((tr) => `${tr.dx},${tr.dz}`))
  const dir = order.find(([x, z]) => !tried.has(`${x},${z}`))
  if (!dir) {
    const a = st.anchor ? { x: st.anchor.x, y: st.anchor.y, z: st.anchor.z } : { ...pos }
    st.stoodDown = { ...a, kind: 'failed' }
    st.anchor = null
    st.tries = []
    console.log(`unpin stand-down exhausted anchor=${a.x.toFixed(1)},${a.y.toFixed(1)},${a.z.toFixed(1)}`)
    return 'stood-down'
  }
  const base = freshBase(st, now)
  if (!base) return drop(ctx, 'no-target', pos) // corrections gone quiet/blank: never send blind
  if (sendTry(ctx, dir, base)) {
    st.tries.push({ dx: dir[0], dz: dir[1], t: now, from: { ...pos }, verdict: null })
    console.log(`unpin nudge dx=${dir[0].toFixed(2)} dz=${dir[1].toFixed(2)} try=${st.tries.length}`)
    return 'nudged'
  }
  return 'watching'
}

// Real-bot wiring (runOnce only). Idempotent. Teleport targets come from a
// post-apply entity-position sample — always absolute, even for relative
// teleports (the listener registers after spawn, so physics has applied
// each packet before the tap samples). The write tap clones mineflayer's
// own last move packet for shape; coordinates always come from the latest
// saved server correction, so the claimed delta is the pure 1 cm step.
//
// Interleaving (no pause/yield by design): the nudge claims base+delta
// where base is the server's own last correction. Follow-up behaviour
// moves carry client coordinates WITHOUT the delta — but any follow-up
// that re-touches the contact face is rejected back to the nudged server
// pos (the pin's own reject storm defends the cure: same-pos teleports
// target server pos, observed 10/s idle); a follow-up that clears the face
// is accepted motion, i.e. the cure working. Clobber would need an accepted
// delta-less re-touch, which face-touch validation forbids — end to end
// proven by rig cures (A-spot 3/3 twice, freed on sustained displacement).
function installUnpinTap(bot, ctx) {
  if (!bot || bot._unpinTapInstalled) return
  bot._unpinTapInstalled = true
  const client = bot._client
  if (client && typeof client.on === 'function') {
    const reg = () => {
      client.on('position', () => {
        try {
          const p = bot.entity && bot.entity.position
          noteTeleport(ctx, Date.now(), p)
        } catch (_) { /* counter best-effort */ }
      })
    }
    // After spawn: mineflayer's physics handler (plugins inject on next
    // tick, long before login) is already registered, so it applies each
    // packet before this tap samples — every burst element resolves after
    // its own application, never as a copy of the final one (F4).
    // Mocks without .once register immediately.
    if (bot && typeof bot.once === 'function') bot.once('spawn', reg)
    else reg()
  }
  if (client && typeof client.write === 'function') {
    const origWrite = client.write.bind(client)
    client.write = function (name, params) {
      if ((name === 'position' || name === 'position_look') && params && typeof params.x === 'number') {
        try { noteMoveParams(ctx, name, params) } catch (_) { /* clone best-effort */ }
      }
      return origWrite(name, params)
    }
    state(ctx).sendNudge = (dx, dz, pos) => {
      const st = state(ctx)
      if (!st.lastMove || !pos) return false
      const p = { ...st.lastMove.params, x: pos.x + dx, y: pos.y, z: pos.z + dz }
      origWrite(st.lastMove.name, p)
      return true
    }
  }
}

module.exports = {
  installUnpinTap,
  noteTeleport,
  noteMoveParams,
  orderNudgeDirs,
  unpinTick,
  STORM_WINDOW_MS,
  STORM_MIN_TPS,
  STORM_MAX_DISP,
  NUDGE_DIST,
  VERIFY_MIN_MS,
}
