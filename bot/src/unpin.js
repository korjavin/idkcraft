'use strict'

// Hover-arrest watchdog (idkcraft-1cj): Paper 26.x rejects EVERY move whose
// box edge exactly touches a solid face (bit-exact 0.0 contact, band sub-1e-6)
// with a same-pos teleport, 10/s idle and 20/s pressed — the first gravity
// tick already (-0.0784 claimed, teleport back 2 ms later). The touch is
// planted by prismarine-physics collision clipping (a wall-slide/fall/jump
// resting the edge exactly on the face plane); the lock is Paper movement
// validation disagreeing with the client's prediction at that contact. Same
// family as the known rise-while-touching rejects (swim.js h04, recover.js
// mountStep wqt: both Paper-26.x-only, vanilla accepts), extended to
// fall-while-touching: the body hangs mid-air, g=false, displacement 0.00
// forever, and no menu primitive can move it (jump rises rejected 0.00,
// sidestep grinds or re-pins, look is dead — storm teleports reset yaw/pitch
// absolute at 10 Hz).
//
// CEILING (ponytail): the source (prismarine clip epsilon) and the lock
// (Paper validation) are both outside bot code and unpatchable from here;
// prevention is impossible (our scans run 0.05 margins, the band is 1e-6).
// The only bot-side lever is this watchdog: detect the reject signature
// (airborne + teleport storm + zero displacement) and step 1 cm off the
// singularity with a move packet cloned from mineflayer's own last send
// (coordinates rebased to the live entity position = server position, so the
// delta is pure-horizontal with no fall component to clip). Rig: storm
// 10/s -> calm, grounded, 3/3, no re-pin. Proven rest vetoes; a down flag
// during storms is no verdict (every teleport falsifies it), so grounded
// press episodes may start — harmless (verified centimeters, 8 max, then
// stand down) and sometimes curative (re-pin locks read down too). Wet
// never fires (water pins storm the same way but never free on 1 cm
// steps: swim owns them). Never forces onGround, never hand-rolls packet
// fields. Ticker hook lives in index.js runTick (1 Hz while active).

const { Vec3 } = require('vec3')
const metrics = require('./metrics')

const STORM_WINDOW_MS = 2000 // trailing teleport-rate window
const STORM_MIN_TPS = 6 // teleports in the window = storm (pin: 20 idle, 40 pressed; calm: <=2)
const STORM_MAX_DISP = 0.3 // max displacement over the window (pin: 0.00; a self-escaping grind runs 0.6+)
const NUDGE_DIST = 0.01 // 1 cm: 1e4x the pin band (guaranteed exit), 1e-2x anything physics-noticeable
const MAX_TRIES = 8 // 4 axis + 4 diagonal, then stand down to the stuck flow
const VERIFY_MIN_MS = 700 // nudge -> verify gap (storm stops <200 ms after an accepted nudge)
const VERIFY_SETTLE_MS = 150 // teleports inside this after a nudge are the storm's tail, not a verdict
const VERIFY_MAX_TPS = 2 // teleports past the settle gap = still storming
const REARM_DIST = 1.0 // body moved this far from a failed anchor: new spot, re-arm
const WIN_TTL_MS = 60000 // win memory prune horizon
const PRESS_WINDOW_MS = 20000 // press-loop guard: wins this close together ...
const PRESS_MAX_WINS = 3 // ... at one anchor mean a sustained press re-plants: stand down.
// (Legit re-pins minutes apart keep curing; only a sub-20 s re-win cycle rests.)

function state(ctx) {
  if (!ctx.unpin) ctx.unpin = { teleports: [], lastMove: null, sendNudge: null, anchor: null, tries: [], stoodDown: null, wins: [] }
  return ctx.unpin
}

// Event feeds (wired by installUnpinTap on the real bot; tests call directly).
// pos is the server's teleport target ({x,y,z} or null): its spread over the
// window is the displacement evidence — a pin repeats one point exactly,
// a walking body under lag corrections scatters.
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

// Spread of the in-window teleport targets (max dist from the latest). A pin
// repeats one point (0.00); any real motion scatters. Null when a target is
// missing — without positions there is no verdict.
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

function solid(b) {
  if (!b) return false
  if (typeof b.boundingBox === 'string') return b.boundingBox !== 'empty' && b.name !== 'water' && b.name !== 'lava'
  const n = typeof b.name === 'string' ? b.name : ''
  return n !== '' && !n.endsWith('air') && n !== 'water' && n !== 'lava'
}

function cellAt(bot, cx, cy, cz) {
  try {
    if (!bot || typeof bot.blockAt !== 'function') return null
    return bot.blockAt(new Vec3(cx, cy, cz))
  } catch (_) { return null }
}

// Proven envelope is air-touch only: water pins (surface bob / +2 mount,
// h04 family) storm the same way but 1 cm steps never free them — swim and
// recover own that water, not this watchdog. Lava stays eligible: dying is
// no time to withhold a harmless verified step.
function inWater(bot) {
  try {
    if (bot && bot.entity && bot.entity.isInWater === true) return true
    const p = posOf(bot)
    if (p && bot && typeof bot.blockAt === 'function') {
      const feet = bot.blockAt(new Vec3(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)))
      if (feet && typeof feet.name === 'string' && feet.name.includes('water')) return true
    }
  } catch (_) { /* wet check best-effort */ }
  return false
}

// Nudge order, geometry-guided (scanSides pattern): away from every solid
// neighbour first, then the remaining axis dirs, then diagonals (a corner
// touch may need both axes freed at once). Wrong guesses cost one verified
// second each — the order only affects speed, never correctness.
const AXIS = [[-1, 0], [1, 0], [0, -1], [0, 1]]
// -0 doubles as +0 everywhere except deepEqual and the wire: normalize.
const nz = (v) => (v === 0 ? 0 : v)
function orderNudgeDirs(bot) {
  const away = []
  try {
    const p = bot && bot.entity && bot.entity.position
    if (p && typeof p.x === 'number') {
      const fx = Math.floor(p.x)
      const fy = Math.floor(p.y)
      const fz = Math.floor(p.z)
      for (const [dx, dz] of AXIS) {
        if (solid(cellAt(bot, fx + dx, fy, fz + dz)) || solid(cellAt(bot, fx + dx, fy + 1, fz + dz))) {
          away.push([nz(-dx * NUDGE_DIST), nz(-dz * NUDGE_DIST)])
        }
      }
    }
  } catch (_) { /* scan best-effort */ }
  const out = [...away]
  for (const [dx, dz] of AXIS) {
    const d = [nz(dx * NUDGE_DIST), nz(dz * NUDGE_DIST)]
    if (!out.some(([x, z]) => x === d[0] && z === d[1])) out.push(d)
  }
  const diags = [[-1, -1], [-1, 1], [1, -1], [1, 1]].map(([x, z]) => [nz(x * NUDGE_DIST), nz(z * NUDGE_DIST)])
  // Corner diagonal first when two adjacent sides read solid (both axes away).
  if (away.length >= 2) {
    const sx = away.some(([x]) => x < 0) ? -1 : 1
    const sz = away.some(([, z]) => z < 0) ? -1 : 1
    const corner = diags.find(([x, z]) => Math.sign(x) === sx && Math.sign(z) === sz)
    if (corner) return [...out, corner, ...diags.filter((d) => d !== corner)].slice(0, MAX_TRIES)
  }
  return [...out, ...diags].slice(0, MAX_TRIES)
}

function dist3(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)
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

function sendTry(ctx, dir, pos) {
  const st = state(ctx)
  if (typeof st.sendNudge !== 'function') return false
  try {
    return st.sendNudge(dir[0], dir[1], pos) === true
  } catch (_) { return false }
}

// Per-tick check. Returns idle | watching | nudged | verifying | freed |
// stood-down. Pure-ish: inputs are bot position/onGround/scan + ctx.unpin
// state + the injected clock; the only side effect is one cloned packet.
function unpinTick(bot, ctx, now = Date.now()) {
  const st = state(ctx)
  const pos = posOf(bot)
  if (!pos) return 'idle'
  prune(st, now)
  // The flag sample, NOT an airborne verdict: mineflayer falsifies onGround
  // on every teleport until the next physics tick, so a grounded press storm
  // reads down half the time. Accepted (revmux 01): re-pin locks (exact
  // rest reading down) NEED the cure, and grounded-press episodes are
  // harmless (verified centimeters, 8 max, then stand down) — and there is
  // no telling them apart in one sample. Unknown/non-boolean fails closed.
  const flagDown = !!(bot && bot.entity && bot.entity.onGround === false)

  // Re-arm: the body left a failed anchor behind (owner /tp, knockback,
  // a grind that finally moved) — this spot is new, judge it fresh.
  if (st.stoodDown && dist3(pos, st.stoodDown) > REARM_DIST) {
    st.stoodDown = null
    st.anchor = null
    st.tries = []
  }
  // A press rest expires when the rapid-win cycle stops (the behaviour moved
  // on): later legit re-pins at the same face cure again. A failed rest
  // waits for movement — the stuck flow owns the still-pinned body.
  if (st.stoodDown && st.stoodDown.kind === 'press') {
    const rapid = (st.wins || []).filter((w) => dist3(pos, w) < REARM_DIST && now - w.t < PRESS_WINDOW_MS).length
    if (rapid === 0) { st.stoodDown = null; st.anchor = null; st.tries = [] }
  }

  // Verify a nudge in flight before anything else (one verdict per second).
  const last = st.tries.length > 0 ? st.tries[st.tries.length - 1] : null
  if (last && !last.verdict) {
    if (now - last.t < VERIFY_MIN_MS) return 'verifying'
    const tail = st.teleports.filter((tp) => tp.t > last.t + VERIFY_SETTLE_MS).length
    if (tail <= VERIFY_MAX_TPS) {
      last.verdict = 'freed'
      const disp = dist3(pos, last.from)
      st.wins.push({ x: pos.x, y: pos.y, z: pos.z, t: now })
      st.anchor = null
      st.tries = []
      try { metrics.events.inc({ event: 'unpin_freed' }) } catch (_) { /* metrics best-effort */ }
      console.log(`unpin freed calm disp=${disp.toFixed(2)} pos=${pos.x.toFixed(1)},${pos.y.toFixed(1)},${pos.z.toFixed(1)}`)
      return 'freed'
    }
    last.verdict = 'storming'
    if (st.tries.length >= MAX_TRIES) {
      const a = st.anchor ? { x: st.anchor.x, y: st.anchor.y, z: st.anchor.z } : { ...pos }
      st.stoodDown = { ...a, kind: 'failed' }
      st.anchor = null
      st.tries = []
      console.log(`unpin stand-down tries=${MAX_TRIES} anchor=${st.stoodDown.x.toFixed(1)},${st.stoodDown.y.toFixed(1)},${st.stoodDown.z.toFixed(1)}`)
      return 'stood-down'
    }
    // Fall through: same tick fires the next direction (no idle second).
  }

  const inEpisode = !!st.anchor
  if (!inEpisode) {
    // Detection: storm + zero spread + flag down + sender ready + not resting.
    // The spread gate is the displacement evidence: a pin repeats one server
    // point exactly, a walking body under lag corrections scatters.
    if (st.teleports.length < STORM_MIN_TPS) return st.teleports.length > 0 ? 'watching' : 'idle'
    const spread = stormSpread(st)
    if (spread === null || spread >= STORM_MAX_DISP) return 'watching'
    if (!flagDown) return 'watching'
    if (inWater(bot)) return 'watching'
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
  // Displacement gate, every tick of the episode: a body that moves (a grind
  // escaping on its own, a fall resuming past the strict tail count) needs
  // no nudge — drop the episode. No landed-drop beside it (revmux 01): a
  // calm landing already returned 'freed' above, a storming one (re-pin)
  // must continue, and the flag flaps true mid-storm — dropping on it would
  // churn episodes instead of bounding them.
  if (st.anchor && dist3(pos, { x: st.anchor.x, y: st.anchor.y, z: st.anchor.z }) >= STORM_MAX_DISP) {
    st.anchor = null
    st.tries = []
    return 'idle'
  }
  // Re-scan the guide every attempt (a grinding body slides onto new faces;
  // a stale order burns tries on dead directions), skipping tried ones so an
  // episode still ends after MAX_TRIES.
  const order = orderNudgeDirs(bot)
  const tried = new Set(st.tries.map((tr) => `${tr.dx},${tr.dz}`))
  const dir = order.find(([x, z]) => !tried.has(`${x},${z}`)) || order[st.tries.length % order.length]
  if (sendTry(ctx, dir, pos)) {
    st.tries.push({ dx: dir[0], dz: dir[1], t: now, from: { ...pos }, verdict: null })
    console.log(`unpin nudge dx=${dir[0].toFixed(2)} dz=${dir[1].toFixed(2)} try=${st.tries.length}/${MAX_TRIES}`)
    return 'nudged'
  }
  return 'watching'
}

// Real-bot wiring (runOnce only: the unit mockBot is no EventEmitter and has
// no _client). Idempotent. The write tap clones mineflayer's own last move
// packet for shape; coordinates always come from the live entity position
// (post-teleport = server position), so the nudge delta is pure-horizontal.
function installUnpinTap(bot, ctx) {
  if (!bot || bot._unpinTapInstalled) return
  bot._unpinTapInstalled = true
  const client = bot._client
  if (client && typeof client.on === 'function') {
    // Raw server teleports (the packet IS the server's verdict, with the
    // target point for the spread gate). forcedMove carries no position.
    client.on('position', (pkt) => {
      try { noteTeleport(ctx, Date.now(), pkt) } catch (_) { /* counter best-effort */ }
    })
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
  MAX_TRIES,
  VERIFY_MIN_MS,
}
