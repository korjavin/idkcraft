'use strict'

// Water-up escape (idkcraft-jsf.2): a bare bot (no scaffold, no pickaxe) climbs
// out of an open pit with 2 water buckets — pour high on the shaft wall, swim
// up jump-only, pour a second source onto an adjacent ledge, traverse over,
// stand, strip both sources top-down. Proven on the prod-world rig (see bead
// notes): 9/9 ledge exits, including 3/3 un-opped outside spawn protection.
//
// Shaped by rig assays, not by vanilla intuition:
// - buckets work ONLY via use_item (lookAt + activateItem, server raycast);
//   placeBlock is silently ignored for buckets on Paper 26.1.2 (jsf.1 a).
// - swim is jump ONLY, forward=false every tick: sustained wall contact pins
//   the body even in water (h04/y5o), and a 1x1 shaft leaves 0.2 gaps.
// - lift stops at the eye-out plateau (source-0.6 standing); the B ledge must
//   sit within [plateau-1, eye+1] with a dry dest: B poured as a fresh SOURCE.
//   A wet (A-spread) dest carries current that shoves the traverse into the
//   back wall and pins it 0/3 (dug-pit assay); a source dest goes 6/6.
// - aims are near-horizontal side faces: top faces from below always miss,
//   grazing rays (<25 deg) miss, aim into an occupied cell EATS the bucket.
// - scoop takes the TOP source regardless of aim: strip top-down, and never
//   scoop mid-climb (it cancels the newest pour).
// - hover holds position (jump held); releasing drifts back into the shaft,
//   so the strip runs with jump held and releases only at the end.
// - spawn protection (r=16, prod-faithful 16 on the rig too) refuses un-opped
//   pours: the run fails failed:pour there, it never hangs.

const { Vec3 } = require('vec3')
const { countItems } = require('../perception')
const { botPos } = require('./util')

// Reach for the server use-raycast (survival 4.5, 0.1 margin for hover heave).
const USE_REACH = 4.4
// Standing eye height (lift stops when the eye exits the surface).
const EYE_HEIGHT = 1.62
// Plateau below the source surface where the swim ends (eye-out).
const PLATEAU_BELOW_SRC = 0.6
// Buckets the combo needs (A + B, both back after the strip).
const BUCKETS_NEEDED = 2

const POUR_VERIFY_TICKS = 3 // spread + client update after activateItem
const POUR_TIMEOUT_TICKS = 6 // equip + aim + verify budget per pour
const SWIM_TIMEOUT_TICKS = 25 // ~5 blocks at 1.6 b/s plus hover margin
const SWIM_STALL_TICKS = 4 // no +0.15 gain this long: pinned, strip and fail
const SWIM_GAIN = 0.15
const REASCEND_TICKS = 6 // re-climb budget after sinking during the B scan
const TRAVERSE_TIMEOUT_TICKS = 15
const TRAVERSE_STALL_TICKS = 3 // no horizontal progress: release press 1 tick
const SCOOP_WAIT_TICKS = 2 // scoop apply + client update
const SCOOP_TRIES = 2 // scoop attempts per source on the happy path
const STRIP_FAIL_TRIES = 1 // ... and on failure paths (bounded, best-effort)
const SETTLE_TICKS = 3 // landing window before the F2 done check
const PROGRESS_TOLERANCE = 0.5 // same stuck tolerance as recover.js

// --- cell predicates (same name-based shape as recover.js; local because
// recover.js owns its privates and requiring it back would cycle) ---

function solid(b) {
  if (!b) return false
  if (typeof b.boundingBox === 'string') return b.boundingBox !== 'empty'
  const n = typeof b.name === 'string' ? b.name : ''
  return n !== '' && !n.endsWith('air') && n !== 'water' && n !== 'lava'
}

function isWater(b) {
  return !!b && typeof b.name === 'string' && b.name.includes('water')
}

function isAirish(b) {
  return !b || (typeof b.name === 'string' && (b.name === '' || b.name.endsWith('air')))
}

function cellAt(bot, dx, dy, dz) {
  try {
    const p = botPos(bot)
    if (!p || !bot.blockAt) return null
    return bot.blockAt(new Vec3(Math.floor(p.x) + dx, Math.floor(p.y) + dy, Math.floor(p.z) + dz))
  } catch (_) { return null }
}

function eyeOf(bot) {
  const p = botPos(bot)
  if (!p) return null
  return { x: p.x, y: p.y + EYE_HEIGHT, z: p.z }
}

function dist(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)
}

function countBuckets(bot) {
  return countItems(bot, (n) => n === 'water_bucket')
}

// Open above the head: the A column and the swim need dy 2..5 free. A ceiling
// (the CLUSTER pocket's stone at dy+4) reads closed — water_up is for open
// pits only (jsf.1 finding 9).
function openAbove(bot) {
  for (let dy = 2; dy <= 5; dy++) {
    if (solid(cellAt(bot, 0, dy, dz0()))) return false
  }
  return true
}
function dz0() { return 0 }

const SIDES = [[1, 0], [-1, 0], [0, 1], [0, -1]]

// Aim point: the ref face plane center (vanilla crosshair). Strictly ON the
// plane: 0.9 past the face misplaces the pour by 2 blocks (jsf.1 finding 8).
function aimFace(refPos, face) {
  return new Vec3(
    refPos.x + 0.5 + face[0] * 0.5,
    refPos.y + 0.5 + face[1] * 0.5,
    refPos.z + 0.5 + face[2] * 0.5,
  )
}

function cellCenter(c) {
  return new Vec3(c.x + 0.5, c.y + 0.5, c.z + 0.5)
}

// A pour at one height: solid side ref + air dest in the own column + reach.
// Returns { dest:{x,y,z}, ref, face:[x,y,z] } or null.
function highPourAt(bot, dy) {
  const p = botPos(bot)
  const eye = eyeOf(bot)
  if (!p || !eye) return null
  const fx = Math.floor(p.x)
  const fy = Math.floor(p.y)
  const fz = Math.floor(p.z)
  for (const [dx, dz] of SIDES) {
    let ref = null
    let dest = null
    try {
      ref = bot.blockAt(new Vec3(fx + dx, fy + dy, fz + dz))
      dest = bot.blockAt(new Vec3(fx, fy + dy, fz))
    } catch (_) { continue } // eslint-disable-line no-continue
    if (!solid(ref) || !isAirish(dest) || !dest || !dest.position) continue // eslint-disable-line no-continue
    if (dist(eye, cellCenter(dest.position)) > USE_REACH) continue // eslint-disable-line no-continue
    return { dest: { x: dest.position.x, y: dest.position.y, z: dest.position.z }, ref, face: [-dx, 0, -dz] }
  }
  return null
}

// Highest A pour (feet+5 down to feet+2).
function findHighPour(bot) {
  for (let dy = 5; dy >= 2; dy--) {
    const found = highPourAt(bot, dy)
    if (found) return found
  }
  return null
}

// B ledge pour at explicit coords (the plateau is predicted, not yet stood
// on): a 4-neighbour cell with a dry air dest, solid below (the stand), a
// solid side ref (near-horizontal aim), 2-high clear head, in reach, strictly
// above the A source (below-or-level would already be A spread — current that
// pins the traverse). Returns { dest, ref, face, below } or null.
function ledgePourAt(bot, cx, cy, cz, eyeY, srcAY) {
  const p = botPos(bot)
  if (!p) return null
  const eye = { x: p.x, y: eyeY, z: p.z }
  for (let dy = 3; dy >= -1; dy--) {
    for (const [dx, dz] of SIDES) {
      const dc = { x: cx + dx, y: cy + dy, z: cz + dz }
      let db = null
      let below = null
      let head = null
      try {
        db = bot.blockAt(new Vec3(dc.x, dc.y, dc.z))
        below = bot.blockAt(new Vec3(dc.x, dc.y - 1, dc.z))
        head = bot.blockAt(new Vec3(dc.x, dc.y + 1, dc.z))
      } catch (_) { continue } // eslint-disable-line no-continue
      if (!isAirish(db)) continue // eslint-disable-line no-continue
      if (!solid(below) || !below.position) continue // eslint-disable-line no-continue
      if (!isAirish(head) && !isWater(head)) continue // eslint-disable-line no-continue
      if (dc.y <= srcAY) continue // eslint-disable-line no-continue
      if (dc.y > eye.y + 1) continue // eslint-disable-line no-continue
      if (dist(eye, cellCenter(dc)) > USE_REACH) continue // eslint-disable-line no-continue
      for (const [rx, rz] of SIDES) {
        let ref = null
        try { ref = bot.blockAt(new Vec3(dc.x + rx, dc.y, dc.z + rz)) } catch (_) { ref = null }
        if (!solid(ref)) continue // eslint-disable-line no-continue
        return {
          dest: dc,
          ref,
          face: [-rx, 0, -rz],
          below: { x: below.position.x, y: below.position.y, z: below.position.z },
        }
      }
    }
  }
  return null
}

// B ledge pour from the live stance (plateau hover).
function findLedgePour(bot, srcAY) {
  const p = botPos(bot)
  if (!p) return null
  return ledgePourAt(bot, Math.floor(p.x), Math.floor(p.y), Math.floor(p.z), p.y + EYE_HEIGHT, srcAY)
}

// The climbable combo from the floor: highest A with a dry B above its
// spread. The swim is vertical, so the plateau column is the floor column.
function findCombo(bot) {
  const p = botPos(bot)
  if (!p) return null
  const cx = Math.floor(p.x)
  const cz = Math.floor(p.z)
  for (let dy = 5; dy >= 2; dy--) {
    const A = highPourAt(bot, dy)
    if (!A) continue // eslint-disable-line no-continue
    const plateauY = A.dest.y - PLATEAU_BELOW_SRC
    const B = ledgePourAt(bot, cx, Math.floor(plateauY), cz, plateauY + EYE_HEIGHT, A.dest.y)
    if (!B) continue // eslint-disable-line no-continue
    return { A, B, plateauY }
  }
  return null
}

function setJump(bot, on) {
  try {
    if (typeof bot.setControlState === 'function') bot.setControlState('jump', !!on)
  } catch (_) { /* control best-effort */ }
}

function setForward(bot, on) {
  try {
    if (typeof bot.setControlState === 'function') bot.setControlState('forward', !!on)
  } catch (_) { /* control best-effort */ }
}

function findItem(bot, name) {
  let items = []
  try {
    items = bot && bot.inventory && typeof bot.inventory.items === 'function' ? bot.inventory.items() : []
  } catch (_) { return null }
  if (!Array.isArray(items)) return null
  return items.find((i) => i && i.name === name && (typeof i.count !== 'number' || i.count > 0)) || null
}

// --- the tick primitive (ctx.recovery.st holds the phase machine) ---
// Every return is 'running' | 'done' | 'failed:<reason>'. Every failure path
// strips known poured sources first (stripFail phase), then reports the
// original reason — a lost bucket is kit jsf.5 must refill.

function toStripFail(st, reason) {
  st.pendingFail = reason
  st.stripLeft = (st.sources || []).slice().sort((a, b) => b.y - a.y)
  st.stripTries = 0
  st.phase = 'stripFail'
  // Fresh aim/use/equip state: leftovers (traverse aim, a spent held bucket)
  // would re-pour instead of scooping.
  st.aimed = false
  st.used = false
  resetEquip(st)
  return 'running'
}

function readCell(bot, c) {
  try {
    return bot.blockAt(new Vec3(c.x, c.y, c.z))
  } catch (_) { return null }
}

// Async equip step shared by pour/scoop/strip phases. Returns 'running' while
// busy, true when the item is in hand, or a 'failed:*' string (equipment
// failures strip first like everything else — callers route via toStripFail,
// except stripFail itself which skips missing buckets).
function equipStep(bot, st, name, timeoutTicks) {
  if (st.equipDone) return true
  if (typeof bot.equip !== 'function') return 'failed:no-equip'
  if (!st.equipInFlight) {
    st.equipInFlight = true
    st.equipMissing = false
    st.equipError = false
    void (async () => {
      try {
        const item = findItem(bot, name)
        if (!item) { st.equipMissing = true; return }
        await bot.equip(item, 'hand')
        st.equipDone = true
      } catch (_) { st.equipError = true } finally { st.equipInFlight = false }
    })()
  }
  if (st.equipMissing) return 'failed:no-' + (name === 'water_bucket' ? 'bucket' : 'empty-bucket')
  if (st.equipError) return 'failed:equip-error'
  if (++st.waited > timeoutTicks) return 'failed:equip-timeout'
  return 'running'
}

function resetEquip(st) {
  st.equipInFlight = false
  st.equipDone = false
  st.equipMissing = false
  st.equipError = false
  st.waited = 0
}

function waterUpRun(bot, ctx) {
  const rec = ctx.recovery
  const st = rec.st || (rec.st = { phase: 'scan', waited: 0 })
  const bp = botPos(bot)
  if (!bp) return 'failed:no-pos'
  if (typeof bot.lookAt !== 'function') { setJump(bot, false); setForward(bot, false); return 'failed:no-look' }
  if (typeof bot.activateItem !== 'function') { setJump(bot, false); setForward(bot, false); return 'failed:no-use' }
  if (st.startFloor === null || st.startFloor === undefined) {
    st.startFloor = Math.floor(bp.y)
    st.start = { x: bp.x, y: bp.y, z: bp.z }
  }
  const grounded = !bot.entity || !!bot.entity.onGround

  if (st.phase === 'scan') {
    if (countBuckets(bot) < BUCKETS_NEEDED) { setJump(bot, false); return 'failed:no-bucket' }
    const combo = findCombo(bot)
    if (!combo) { setJump(bot, false); return 'failed:no-pour-site' }
    st.combo = combo
    st.sources = []
    st.phase = 'pourA'
    resetEquip(st)
    return 'running'
  }

  if (st.phase === 'pourA' || st.phase === 'pourB') {
    const isA = st.phase === 'pourA'
    const site = isA ? st.combo.A : st.combo.B
    const failReason = isA ? 'failed:pour' : 'failed:rim-pour'
    // pourB hovers (jump held — releasing sinks 2 blocks during equip+aim,
    // rig); pourA stands on the floor (jump off).
    setJump(bot, !isA)
    setForward(bot, false)
    if (!site) return toStripFail(st, failReason)
    if (!st.aimed) {
      const eq = equipStep(bot, st, 'water_bucket', POUR_TIMEOUT_TICKS)
      if (eq !== true) {
        if (eq === 'running') return 'running'
        return toStripFail(st, eq === 'failed:no-bucket' && !isA ? 'failed:need-2nd-bucket' : failReason)
      }
      try { bot.lookAt(aimFace(site.ref.position, site.face)) } catch (_) { return toStripFail(st, failReason) }
      st.aimed = true
      st.waited = 0
      return 'running'
    }
    if (!st.used) {
      try { bot.activateItem() } catch (_) { return toStripFail(st, failReason) }
      st.used = true
      st.waited = 0
      return 'running'
    }
    if (++st.waited < POUR_VERIFY_TICKS) return 'running'
    if (!isWater(readCell(bot, site.dest))) {
      st.aimed = false
      st.used = false
      return toStripFail(st, failReason)
    }
    st.sources.push(site.dest)
    st.aimed = false
    st.used = false
    if (isA) {
      st.phase = 'swim'
      st.lastY = bp.y
      st.lastGainTick = 0
    } else {
      st.phase = 'traverse'
      st.travStall = 0
      st.travSeen = { x: bp.x, z: bp.z }
    }
    st.waited = 0
    return 'running'
  }

  if (st.phase === 'swim') {
    const srcAY = st.combo.A.dest.y
    const targetY = srcAY - PLATEAU_BELOW_SRC
    // The forward guard: swim is jump ONLY — any forward press (stuck keys
    // from a killed primitive included) rides the shaft wall into a pin.
    setForward(bot, false)
    setJump(bot, true)
    if (bp.y >= targetY) {
      // Jump stays held into pourB (hover — releasing sinks, rig).
      setJump(bot, true)
      // Plateau drift re-scans B live (the combo predicted it from the floor).
      const liveB = findLedgePour(bot, srcAY)
      if (!liveB) return toStripFail(st, 'failed:no-ledge')
      st.combo.B = liveB
      if (countBuckets(bot) < 1) return toStripFail(st, 'failed:need-2nd-bucket')
      st.phase = 'pourB'
      resetEquip(st)
      st.waited = 0
      return 'running'
    }
    if (bp.y - st.lastY > SWIM_GAIN) { st.lastY = bp.y; st.lastGainTick = st.waited }
    st.waited++
    if (st.waited - st.lastGainTick > SWIM_STALL_TICKS || st.waited > SWIM_TIMEOUT_TICKS) {
      setJump(bot, false)
      return toStripFail(st, 'failed:no-rise')
    }
    return 'running'
  }

  if (st.phase === 'traverse') {
    const B = st.combo.B
    if (!B) return toStripFail(st, 'failed:traverse')
    if (!st.aimed) {
      // Face the stand point (the pour aim still points at the ref wall —
      // driving into it would pin). One aim, held for the whole traverse.
      try { bot.lookAt(new Vec3(B.below.x + 0.5, B.below.y + 1.0, B.below.z + 0.5)) } catch (_) { /* facing best-effort */ }
      st.aimed = true
      return 'running'
    }
    const standX = B.below.x + 0.5
    const standZ = B.below.z + 0.5
    const horiz = Math.hypot(bp.x - standX, bp.z - standZ)
    if (bp.y >= B.dest.y - 0.1 && horiz < 0.5) {
      setForward(bot, false)
      // Jump STAYS held: releasing drifts back into the shaft (rig), the
      // strip below runs from the hover and releases at the end.
      st.phase = 'strip'
      st.stripLeft = st.sources.slice().sort((a, b) => b.y - a.y)
      st.stripTries = 0
      st.aimed = false
      st.used = false
      resetEquip(st)
      return 'running'
    }
    // Pin-break: no horizontal progress — release the press one tick so a
    // wall graze does not latch into a sustained pin, then resume.
    if (Math.hypot(bp.x - st.travSeen.x, bp.z - st.travSeen.z) > SWIM_GAIN) {
      st.travSeen = { x: bp.x, z: bp.z }
      st.travStall = 0
    } else if (++st.travStall >= TRAVERSE_STALL_TICKS) {
      st.travStall = 0
      setForward(bot, false)
      setJump(bot, true)
      if (++st.waited > TRAVERSE_TIMEOUT_TICKS) return toStripFail(st, 'failed:traverse')
      return 'running'
    }
    setForward(bot, true)
    setJump(bot, true)
    if (++st.waited > TRAVERSE_TIMEOUT_TICKS) return toStripFail(st, 'failed:traverse')
    return 'running'
  }

  // Strip (happy path): top-down over the KNOWN sources (a blind scan would
  // target spread water, which never scoops), SCOOP_TRIES each, jump held.
  // Wet leftovers at the end fail the phase — the buckets matter.
  if (st.phase === 'strip' || st.phase === 'stripFail') {
    const failPhase = st.phase === 'stripFail'
    const tries = failPhase ? STRIP_FAIL_TRIES : SCOOP_TRIES
    setJump(bot, true)
    setForward(bot, false)
    const cell = (st.stripLeft || [])[0]
    if (!cell) {
      setJump(bot, false)
      if (failPhase) {
        const reason = st.pendingFail || 'failed:error'
        st.phase = 'terminal'
        return reason
      }
      st.phase = 'settle'
      st.waited = 0
      return 'running'
    }
    if (!isWater(readCell(bot, cell))) {
      st.stripLeft.shift()
      st.aimed = false
      st.used = false
      st.stripTries = 0
      resetEquip(st)
      return 'running'
    }
    if (!st.aimed) {
      const eq = equipStep(bot, st, 'bucket', POUR_TIMEOUT_TICKS)
      if (eq !== true) {
        if (eq === 'running') return 'running'
        // No empty bucket: nothing more to scoop — strip what we can.
        st.stripLeft.shift()
        st.aimed = false
        st.used = false
        st.stripTries = 0
        resetEquip(st)
        return 'running'
      }
      try { bot.lookAt(cellCenter(cell)) } catch (_) { /* aim best-effort, the retry re-aims */ }
      st.aimed = true
      st.waited = 0
      return 'running'
    }
    if (!st.used) {
      try { bot.activateItem() } catch (_) { /* use best-effort, the retry re-uses */ }
      st.used = true
      st.waited = 0
      return 'running'
    }
    if (++st.waited < SCOOP_WAIT_TICKS) return 'running'
    st.used = false
    if (!isWater(readCell(bot, cell))) {
      st.stripLeft.shift()
      st.aimed = false
      st.stripTries = 0
      resetEquip(st)
      return 'running'
    }
    if (++st.stripTries >= tries) {
      if (failPhase) {
        st.stripLeft.shift()
        st.aimed = false
        st.stripTries = 0
        resetEquip(st)
        return 'running'
      }
      setJump(bot, false)
      return toStripFail(st, 'failed:strip')
    }
    // Retry: re-aim next tick (hover heave moves the eye between tries).
    st.aimed = false
    st.waited = 0
    return 'running'
  }

  if (st.phase === 'settle') {
    setJump(bot, false)
    setForward(bot, false)
    const risen = Math.floor(bp.y) > st.startFloor + 1
    const moved = Math.hypot(bp.x - st.start.x, bp.z - st.start.z) > PROGRESS_TOLERANCE
    if (grounded && risen && moved) return 'done'
    if (++st.waited > SETTLE_TICKS) {
      // Standing on the ledge with the water stripped is still an escape
      // only when it climbs: a +1 stand reports no-gain, honestly.
      return (grounded && (risen || moved)) && (Math.floor(bp.y) > st.startFloor || moved)
        ? (risen ? 'done' : 'failed:no-gain')
        : 'failed:no-gain'
    }
    return 'running'
  }

  return 'failed:error'
}

module.exports = {
  USE_REACH,
  EYE_HEIGHT,
  PLATEAU_BELOW_SRC,
  BUCKETS_NEEDED,
  POUR_VERIFY_TICKS,
  POUR_TIMEOUT_TICKS,
  SWIM_TIMEOUT_TICKS,
  SWIM_STALL_TICKS,
  REASCEND_TICKS,
  TRAVERSE_TIMEOUT_TICKS,
  TRAVERSE_STALL_TICKS,
  SCOOP_WAIT_TICKS,
  SCOOP_TRIES,
  STRIP_FAIL_TRIES,
  SETTLE_TICKS,
  countBuckets,
  openAbove,
  aimFace,
  cellCenter,
  highPourAt,
  findHighPour,
  ledgePourAt,
  findLedgePour,
  findCombo,
  waterUpRun,
}
