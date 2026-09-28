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

// pos is the server's teleport target (post-apply entity position, always
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

// A face that can lock: solid and not climb-or-passable.
function faceSolid(b) {
  return solid(b) && !CLIMBABLES.has(blockName(b))
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

// Away-steps off known faces only (unknown terrain never nudges). At most
// one per solid neighbour; corners cure sequentially (parallel moves
// preserve earlier gaps bit-exactly — no delta means no change).
const AXIS = [[-1, 0], [1, 0], [0, -1], [0, 1]]
const nz = (v) => (v === 0 ? 0 : v) // -0 doubles as +0 except deepEqual and the wire
function orderNudgeDirs(bot) {
  const away = []
  try {
    const p = posOf(bot)
    if (p) {
      const fx = Math.floor(p.x)
      const fy = Math.floor(p.y)
      const fz = Math.floor(p.z)
      for (const [dx, dz] of AXIS) {
        if (faceSolid(cellAt(bot, fx + dx, fy, fz + dz)) || faceSolid(cellAt(bot, fx + dx, fy + 1, fz + dz))) {
          away.push([nz(-dx * NUDGE_DIST), nz(-dz * NUDGE_DIST)])
        }
      }
    }
  } catch (_) { /* scan best-effort */ }
  return away // ≤4 (one per axis): the tried-set over this universe bounds every episode
}

// Landing feasibility for the freed fall: the escape must not kill. Nearest
// landing straight below wins (the still-air fall path; drift is the brain's
// business post-free). Returns null when survivable, else a veto reason.
function belowVeto(bot, pos) {
  const fx = Math.floor(pos.x)
  const fz = Math.floor(pos.z)
  const hp = bot && typeof bot.health === 'number' ? bot.health : 20 // real bots report; mocks fail open
  for (let y = Math.floor(pos.y) - 1; (pos.y - (y + 1)) <= BELOW_SCAN_MAX; y--) {
    const b = cellAt(bot, fx, y, fz)
    if (!b) return 'unknown-below'
    const n = blockName(b)
    if (n.includes('lava')) return 'lava-below'
    if (n.includes('water')) return null // any water breaks any fall
    if (n === '' || n.endsWith('air') || CLIMBABLES.has(n) || !solid(b)) continue // pass-through
    const dmg = Math.max(0, Math.floor((pos.y - (y + 1)) - 3)) // MC: floor(fall - 3)
    return dmg >= hp ? 'lethal-below' : null
  }
  return 'lethal-below' // nothing to land on: void or death-certain
}

// Full eligibility, checked at detection AND before every retry (stable
// gates only on retry — see below). Returns null when the watchdog may
// act, else the veto reason. The flag sample is NOT a verdict (every
// teleport falsifies onGround until the next physics tick): proven rest
// vetoes at detection, a down flag proceeds — re-pin locks read down and
// need the cure, grounded-press episodes are harmless (verified, bounded)
// and indistinguishable in one sample.
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

function sendTry(ctx, dir, pos) {
  const st = state(ctx)
  if (typeof st.sendNudge !== 'function') return false
  try {
    return st.sendNudge(dir[0], dir[1], pos) === true
  } catch (_) { return false }
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
  if (sendTry(ctx, dir, pos)) {
    st.tries.push({ dx: dir[0], dz: dir[1], t: now, from: { ...pos }, verdict: null })
    console.log(`unpin nudge dx=${dir[0].toFixed(2)} dz=${dir[1].toFixed(2)} try=${st.tries.length}`)
    return 'nudged'
  }
  return 'watching'
}

// Real-bot wiring (runOnce only). Idempotent. Teleport targets come from the
// post-apply entity position — always absolute, even for relative teleports
// (mineflayer's handler runs first: plugins load before this tap). The write
// tap clones mineflayer's own last move packet for shape; coordinates always
// come from the live entity position, so the nudge delta is pure-horizontal.
//
// Non-interference (no pause/yield needed): the nudge is one absolute packet
// on a disjoint control surface (no controls/goals touched); the server
// serializes it with behaviour moves, and teleport-backs target server pos,
// which includes an accepted nudge — behaviour moves can neither clobber it
// (self-pin: client≈server, deltas stay valid) nor be broken by it.
function installUnpinTap(bot, ctx) {
  if (!bot || bot._unpinTapInstalled) return
  bot._unpinTapInstalled = true
  const client = bot._client
  if (client && typeof client.on === 'function') {
    client.on('position', () => {
      try {
        const p = bot.entity && bot.entity.position
        noteTeleport(ctx, Date.now(), p)
      } catch (_) { /* counter best-effort */ }
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
  VERIFY_MIN_MS,
}
