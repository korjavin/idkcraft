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
// - aims are VISIBLE side faces (a voxel ray from the live eye must first-hit
//   the ref through the aimed face): backfaces and neighbour-occluded faces
//   send the water somewhere the strip does not know, or into an occupied
//   cell — which EATS the bucket (rig pocket rim-pour). Grazing but visible
//   rays pour fine (every A aims up at ~7 deg to its face); the scan ranks
//   faces by squareness but gates on visibility, and the pour re-verifies
//   pre-use because the hover moves between the scan and the activate.
// - scoop takes the TOP source regardless of aim: strip top-down, and never
//   scoop mid-climb (it cancels the newest pour).
// - hover holds position (jump held); releasing drifts back into the shaft,
//   so the strip runs with jump held and releases only at the end.
// - spawn protection (r=16, prod-faithful 16 on the rig too) refuses un-opped
//   pours: the run fails failed:pour there, it never hangs.

const { Vec3 } = require('vec3')
const { countItems } = require('../perception')
const { botPos, clearGoal } = require('./util')

// Reach for the server use-raycast (survival 4.5). Scans budget 4.0: the
// hover heaves ±1 between the scan and the activate, and a marginal site
// (4.39 in, 4.41 out across 0.3 of sub-cell) flickers offers that die
// mid-climb (replay slope). The pour-time recheck below uses server truth.
const USE_REACH = 4.4
const SCAN_REACH = 4.0
// Floor-predicted mount budget: B must sit within this above the predicted
// plateau (heave-corrected). Shaft +1.6 offers, slope +2.6 does not (the
// traverse mounts ~1.2 of jump-out; the live re-scan re-checks from the
// true hover, which heaves ±0.5 either way).
const COMBO_MOUNT_BUDGET = 1.7
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
const CENTER_DIST = 0.12 // pre-pour stance tolerance inside the own cell
const CENTER_TIMEOUT_TICKS = 10 // center tap budget (a 0.7 corner at 0.16/tap + a stall-break walk-off + re-center)
const CENTER_STALL_PROG = 0.05 // per-tick progress below this reads stuck (a free sneak tap steps ~0.16)
const CENTER_STALL_TICKS = 3 // stuck this long: one unsneaked walk tap instead of another sneak tap
const CENTER_TAP_MS = 120 // tap length (~0.16 blocks per tap at sneak speed)
const SWIM_CENTER_DIST = 0.2 // past this off the lane middle: centering tap
const SWIM_TAP_MS = 100 // tap length (releases between 1 Hz ticks)
const TRAVERSE_STALL_TICKS = 3 // no horizontal progress: release press 1 tick
const TRAVERSE_ARRIVE_XZ = 0.35 // arrival ring around the stand middle (0.5 left no drift budget for the B window: replay no-gain)
const STRIP_STATION_DIST = 0.3 // past this off the stand middle: station tap (deadband swallows tap-sized steps)
const STRIP_SCOOP_XZ = 0.25 // B-scoop ring around the stand middle: the support water goes back only from over the stand (off-stand scoops drop past the edge: replay no-gain)
const STRIP_STANCE_TICKS = 6 // off-stand stance budget before the B scoop fires best-effort anyway (buckets-first, never hangs)
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

// A 2-high wall beside the body (at least ONE hemmed side): the bead's
// original pit gate ("хотя бы с одной стороны"), which jsf.3's merged pitAt
// (2+ sides, pillar economy) reads false in 1-wide open shafts — the proven
// water_up geometry. The swim lane and the B ledge are the combo's own
// checks; this one only keeps goalless offers out of the open.
function wall2At(bot) {
  for (const [dx, dz] of SIDES) {
    if (solid(cellAt(bot, dx, 0, dz)) && solid(cellAt(bot, dx, 1, dz))) return true
  }
  return false
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
    if (dist(eye, cellCenter(dest.position)) > SCAN_REACH) continue // eslint-disable-line no-continue
    const face = [-dx || 0, 0, -dz || 0]
    if (!faceVisible(bot, eye, ref.position, face)) continue // eslint-disable-line no-continue
    return { dest: { x: dest.position.x, y: dest.position.y, z: dest.position.z }, ref, face }
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

// First solid cell along the eye→aim ray (Amanatides & Woo voxel walk over
// bot.blockAt — no world-raycast API dependency, and every mock exercises
// it). Returns { pos, face } of entry, or null when the ray reaches the aim
// inside air. Water is not solid (rays pass); unknown cells (null) read
// clear, consistent with every other check in this file — scans run within
// 4.4 blocks of the bot, where chunks are loaded.
function rayFace(bot, eye, aim) {
  const dir = { x: aim.x - eye.x, y: aim.y - eye.y, z: aim.z - eye.z }
  const len = Math.hypot(dir.x, dir.y, dir.z)
  if (len < 1e-6) return null
  const dx = dir.x / len
  const dy = dir.y / len
  const dz = dir.z / len
  let cx = Math.floor(eye.x)
  let cy = Math.floor(eye.y)
  let cz = Math.floor(eye.z)
  const stepX = dx > 0 ? 1 : -1
  const stepY = dy > 0 ? 1 : -1
  const stepZ = dz > 0 ? 1 : -1
  const tDX = dx !== 0 ? Math.abs(1 / dx) : Infinity
  const tDY = dy !== 0 ? Math.abs(1 / dy) : Infinity
  const tDZ = dz !== 0 ? Math.abs(1 / dz) : Infinity
  let tMX = dx !== 0 ? (stepX > 0 ? cx + 1 - eye.x : eye.x - cx) * tDX : Infinity
  let tMY = dy !== 0 ? (stepY > 0 ? cy + 1 - eye.y : eye.y - cy) * tDY : Infinity
  let tMZ = dz !== 0 ? (stepZ > 0 ? cz + 1 - eye.z : eye.z - cz) * tDZ : Infinity
  for (let i = 0; i < 64; i++) {
    let t = Infinity
    let face = [0, 0, 0]
    if (tMX <= tMY && tMX <= tMZ) { cx += stepX; t = tMX; tMX += tDX; face = [-stepX, 0, 0] }
    else if (tMY <= tMZ) { cy += stepY; t = tMY; tMY += tDY; face = [0, -stepY, 0] }
    else { cz += stepZ; t = tMZ; tMZ += tDZ; face = [0, 0, -stepZ] }
    if (t > len + 1e-4) return null
    let b = null
    try { b = bot.blockAt(new Vec3(cx, cy, cz)) } catch (_) { b = null }
    if (solid(b)) return { pos: { x: cx, y: cy, z: cz }, face }
  }
  return null
}

// The aimed face is pourable only when the server ray would first-hit it:
// the eye→face-center ray must enter the ref through that exact face. A
// backface (normal pointing away) or a neighbour-occluded face sends the
// water to a cell the strip does not know — or into an occupied cell,
// which eats the bucket (rig pocket rim-pour).
function faceVisible(bot, eye, refPos, face) {
  const aim = aimFace(refPos, face)
  const hit = rayFace(bot, eye, aim)
  return !!hit
    && hit.pos.x === refPos.x && hit.pos.y === refPos.y && hit.pos.z === refPos.z
    && hit.face[0] === face[0] && hit.face[1] === face[1] && hit.face[2] === face[2]
}

function faceRefs(bot, dc, eye) {
  // Front faces only (SIGNED cos — a backface normal points away from the
  // eye and can never pour), squarest first. Visibility is checked
  // separately per face (raycast): squareness ranks, visibility gates.
  const out = []
  for (const [rx, rz] of SIDES) {
    let ref = null
    try { ref = bot.blockAt(new Vec3(dc.x + rx, dc.y, dc.z + rz)) } catch (_) { ref = null }
    if (!solid(ref)) continue // eslint-disable-line no-continue
    const face = [-rx || 0, 0, -rz || 0]
    const aim = {
      x: ref.position.x + 0.5 + face[0] * 0.5,
      y: ref.position.y + 0.5 + face[1] * 0.5,
      z: ref.position.z + 0.5 + face[2] * 0.5,
    }
    const toEye = { x: eye.x - aim.x, y: eye.y - aim.y, z: eye.z - aim.z }
    const len = Math.hypot(toEye.x, toEye.y, toEye.z) || 1
    const cos = (face[0] * toEye.x + face[1] * toEye.y + face[2] * toEye.z) / len
    if (cos <= 0) continue // eslint-disable-line no-continue
    out.push({ ref, face, cos })
  }
  out.sort((a, b) => b.cos - a.cos)
  return out
}

// B ledge pour at explicit coords (the plateau is predicted, not yet stood
// on): a 4-neighbour cell with a dry air dest, solid below (the stand), a
// solid side ref (near-horizontal aim), 2-high clear head, in reach, strictly
// above the A source (below-or-level would already be A spread — current that
// pins the traverse), and within the traverse mount of the plateau.
// Returns { dest, ref, face, below } or null.
function ledgePourAt(bot, cx, cy, cz, eyeY, srcAY, plateauY) {
  const p = botPos(bot)
  if (!p) return null
  const eye = { x: p.x, y: eyeY, z: p.z }
  const mountMax = (plateauY === null || plateauY === undefined ? eyeY - EYE_HEIGHT : plateauY) + COMBO_MOUNT_BUDGET
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
      if (dc.y > mountMax) continue // eslint-disable-line no-continue
      if (dc.y > eye.y + 1) continue // eslint-disable-line no-continue
      if (dist(eye, cellCenter(dc)) > SCAN_REACH) continue // eslint-disable-line no-continue
      for (const picked of faceRefs(bot, dc, eye)) {
        if (!faceVisible(bot, eye, picked.ref.position, picked.face)) continue // eslint-disable-line no-continue
        return {
          dest: dc,
          ref: picked.ref,
          face: picked.face,
          below: { x: below.position.x, y: below.position.y, z: below.position.z },
        }
      }
    }
  }
  return null
}

// B ledge pour from the live stance (plateau hover). The spread current at
// the column top pushes the hover up to a block off the lane (rig pocket:
// the hover sat a full block north while B waited in reach of the lane
// column), so the scan covers the drift disk — the own column first, then
// the 4 neighbours — with reach and face still scored from the TRUE eye.
// The mount budget rides on the PREDICTED plateau (floor of the live
// hover): the instantaneous hover heaves ±0.5, and budgeting the trough
// flickers offers the hover peak would make.
function findLedgePour(bot, srcAY, plateauHint) {
  const p = botPos(bot)
  if (!p) return null
  const plateauY = plateauHint === null || plateauHint === undefined
    ? p.y
    : Math.max(plateauHint, p.y)
  const cx = Math.floor(p.x)
  const cy = Math.floor(p.y)
  const cz = Math.floor(p.z)
  const eyeY = p.y + EYE_HEIGHT
  for (const [ax, az] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]]) {
    const B = ledgePourAt(bot, cx + ax, cy, cz + az, eyeY, srcAY, plateauY)
    if (B) return B
  }
  return null
}

function laneCell(bot, cx, y, cz) {
  try {
    return bot.blockAt(new Vec3(cx, y, cz))
  } catch (_) { return null }
}

// The climbable combo from the floor: highest A with a dry B above its
// spread and a clear swim lane (own column, feet+1 through the source — a
// ceiling inside the lane kills the combo even when the pour face reads
// fine). The swim is vertical, so the plateau column is the floor column.
function findCombo(bot) {
  // Decide-time stance gate: a combo predicted from a falling/jumping body
  // is meaningless — the replay shaft fired water_up mid-hop, the center
  // target fell away (failed:no-center), and the follow-up shuffles walked
  // the bot out of the climbable shaft to gave-up. The climb starts
  // standing (onGround; standing under water still counts); the run itself
  // never re-decides, so this cannot abort a mid-climb hover.
  if (!bot || !bot.entity || bot.entity.onGround !== true) return null
  const p = botPos(bot)
  if (!p) return null
  const cx = Math.floor(p.x)
  const cz = Math.floor(p.z)
  for (let dy = 5; dy >= 2; dy--) {
    const A = highPourAt(bot, dy)
    if (!A) continue // eslint-disable-line no-continue
    let lane = true
    for (let y = Math.floor(p.y) + 1; y <= A.dest.y; y++) {
      const c = laneCell(bot, cx, y, cz)
      if (!isAirish(c) && !isWater(c)) { lane = false; break }
    }
    if (!lane) continue // eslint-disable-line no-continue
    const plateauY = A.dest.y - PLATEAU_BELOW_SRC
    const B = ledgePourAt(bot, cx, Math.floor(plateauY), cz, plateauY + EYE_HEIGHT, A.dest.y, plateauY)
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

function setSneak(bot, on) {
  try {
    if (typeof bot.setControlState === 'function') bot.setControlState('sneak', !!on)
  } catch (_) { /* control best-effort */ }
}

// One 100 ms step toward (x, z) when farther than maxDist: the hover drifts
// off-station during multi-tick aims (rig pocket: 5 blocks down during the
// B verify), and a stale timer only ever releases (hop_step shape).
function tapToward(bot, bp, x, z, maxDist) {
  if (Math.hypot(bp.x - x, bp.z - z) <= maxDist) return
  try { bot.lookAt(new Vec3(x, bp.y + 1.0, z)) } catch (_) { /* facing best-effort */ }
  setForward(bot, true)
  try { setTimeout(() => setForward(bot, false), SWIM_TAP_MS) } catch (_) { /* timer best-effort */ }
}

// Same-tick aim + use: the hover heaves too fast for a 1 s aim gap (the
// pour phases pack for the same reason; TCP keeps packet order so the
// server raycasts with the fresh look). Best-effort — the verify/retry
// re-aims.
function fireScoop(bot, cell) {
  try {
    bot.lookAt(cellCenter(cell))
    bot.activateItem()
  } catch (_) { /* use best-effort, the retry re-aims */ }
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
  const fresh = !rec.st
  const st = rec.st || (rec.st = { phase: 'scan', waited: 0 })
  if (fresh) {
    // Take the body: a live follow goal (entity goals repath on their own
    // loop) and latched keys (jump held from follow's last parkour press)
    // survive into recover and fight the 1 Hz ticks — the replay shaft
    // drifted guideward through 8 center taps to failed:no-center. Drop
    // the goal (clearGoal, not stop(): no same-tick setGoal follows, but
    // the latch warning in fight.js still applies) and clear the keys.
    try { clearGoal(bot, ctx) } catch (_) { /* body best-effort */ }
    try { if (typeof bot.clearControlStates === 'function') bot.clearControlStates() } catch (_) { /* body best-effort */ }
  }
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
    if (countBuckets(bot) < BUCKETS_NEEDED) { setJump(bot, false); setSneak(bot, false); return 'failed:no-bucket' }
    // Center in the own cell FIRST: a stance touching a wall (0.1 gaps at
    // off-center spawns) pins the swim on tick 1 (h04: bbox starts
    // in/against collision zeroes vy) — every centered rig spawn rose,
    // every touching one stalled at +0. Pouring from a bad stance only
    // wastes the budget, so an uncenterable cell fails fast and clean.
    const ccx = Math.floor(bp.x) + 0.5
    const ccz = Math.floor(bp.z) + 0.5
    if (Math.hypot(bp.x - ccx, bp.z - ccz) >= CENTER_DIST) {
      // Sneak taps, not a held walk: 1 Hz ticks hold forward for a full
      // second (4+ blocks at walk speed) and blow straight past the middle
      // and off the floor (rig pocket) — and even 120 ms walk taps step
      // ~0.5, which limit-cycles around the 0.12 window instead of landing
      // it (rig pocket no-center). A 120 ms SNEAK tap steps ~0.16 and
      // converges from anywhere in the cell. Sneak releases on every scan
      // exit: it must never leak into the swim (sneak sinks).
      const moved = st.centerSeen ? Math.hypot(bp.x - st.centerSeen.x, bp.z - st.centerSeen.z) : Infinity
      st.centerSeen = { x: bp.x, z: bp.z }
      if (moved < CENTER_STALL_PROG) st.centerStall = (st.centerStall || 0) + 1
      else st.centerStall = 0
      // Stall breaker: N taps with no progress (replay shaft: sneak taps
      // glue at a brink stance — the vanilla edge-guard refuses to step
      // off, and the run dies no-center 1 block above the climbable floor).
      // One UNSNEAKED walk tap steps off (falls ≤1 onto the floor below;
      // the center re-targets the landing cell), then sneak resumes. Also
      // the pin-vs-glue experiment for 1cj: displacement here rules the
      // edge-touch pin out (a pin would hold through the walk tap too).
      const walkItOff = (st.centerStall || 0) >= CENTER_STALL_TICKS
      if (walkItOff) st.centerStall = 0
      try { bot.lookAt(new Vec3(ccx, bp.y + 0.5, ccz)) } catch (_) { /* facing best-effort */ }
      setSneak(bot, !walkItOff)
      setForward(bot, true)
      setJump(bot, false)
      try { setTimeout(() => setForward(bot, false), CENTER_TAP_MS) } catch (_) { /* timer best-effort */ }
      if (++st.waited > CENTER_TIMEOUT_TICKS) {
        setForward(bot, false)
        setSneak(bot, false)
        return 'failed:no-center'
      }
      return 'running'
    }
    setForward(bot, false)
    setSneak(bot, false)
    const combo = findCombo(bot)
    if (!combo) { setJump(bot, false); setSneak(bot, false); return 'failed:no-pour-site' }
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
    if (!st.used) {
      const eq = equipStep(bot, st, 'water_bucket', POUR_TIMEOUT_TICKS)
      if (eq !== true) {
        if (eq === 'running') return 'running'
        return toStripFail(st, eq === 'failed:no-bucket' && !isA ? 'failed:need-2nd-bucket' : failReason)
      }
      // Pour-time reach recheck against server truth: the hover heaves
      // between the scan and the activate, and activating past 4.5 risks
      // the Paper quirk (bucket eaten into an occupied cell). Never
      // activated means never lost — fail clean with the bucket kept.
      const eye = eyeOf(bot)
      if (!eye || dist(eye, cellCenter(site.dest)) > USE_REACH) {
        return toStripFail(st, failReason)
      }
      // Pour-time visibility + dry-dest recheck against server truth: the
      // hover moves between the scan and the activate, and an occluded ray
      // (or a dest A-spread has since wetted) eats the bucket. Wait it out
      // within the pour budget — heave oscillates — never pour blind.
      if (!faceVisible(bot, eye, site.ref.position, site.face) || !isAirish(readCell(bot, site.dest))) {
        if (++st.waited > POUR_TIMEOUT_TICKS) return toStripFail(st, failReason)
        return 'running'
      }
      // Aim and activate in the SAME tick (both sync): a 1 s aim gap lets
      // the hover heave ±1 and the ray arrives stale — replay rim-pours
      // died exactly this way while 350 ms probe gaps held. Packets keep
      // TCP order, so the server raycasts with the fresh look.
      try {
        bot.lookAt(aimFace(site.ref.position, site.face))
        bot.activateItem()
      } catch (_) { return toStripFail(st, failReason) }
      st.used = true
      st.waited = 0
      return 'running'
    }
    if (++st.waited < POUR_VERIFY_TICKS) return 'running'
    if (!isWater(readCell(bot, site.dest))) {
      st.used = false
      return toStripFail(st, failReason)
    }
    st.sources.push(site.dest)
    st.used = false
    if (isA) {
      st.phase = 'swim'
      st.lastY = bp.y
      st.lastGainTick = 0
    } else {
      st.phase = 'traverse'
      st.travStall = 0
      st.travSeen = { x: bp.x, z: bp.z }
      resetEquip(st) // fresh for the traverse pre-equip below (also restarts the traverse timeout)
    }
    st.waited = 0
    return 'running'
  }

  if (st.phase === 'swim') {
    const srcAY = st.combo.A.dest.y
    const targetY = srcAY - PLATEAU_BELOW_SRC
    // The forward guard: swim is jump ONLY — any sustained forward press
    // (stuck keys from a killed primitive included) rides the shaft wall
    // into a pin. The single exception is the centering tap below: open
    // lanes drift the hover off the 1-wide column (replay slope: 0.6 out,
    // lift lost, flood left behind), so past 0.2 off-center the body faces
    // the lane middle and taps forward for 100 ms (hop_step's timed-tap
    // shape — a stale timer only ever releases, never latches a press).
    setForward(bot, false)
    setJump(bot, true)
    tapToward(bot, bp, st.combo.A.dest.x + 0.5, st.combo.A.dest.z + 0.5, SWIM_CENTER_DIST)
    if (bp.y >= targetY) {
      // Jump stays held into pourB (hover — releasing sinks, rig).
      setJump(bot, true)
      // Plateau drift re-scans B live (the combo predicted it from the floor).
      const liveB = findLedgePour(bot, srcAY, st.combo.plateauY)
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
    // Pre-equip the empty bucket while driving: the strip then scoops B on
    // its first tick instead of its third, halving the hover window the
    // spread current gets to walk the body off the stand (replay no-gain).
    // equipStep borrows st.waited (its own timeout); save/restore keeps the
    // traverse timeout exact (else it ticks twice as fast). Result ignored:
    // the strip re-checks (a failed pre-equip just costs the old ticks).
    if (!st.equipDone) {
      const wSave = st.waited
      equipStep(bot, st, 'bucket', 999)
      st.waited = wSave
    }
    if (!st.faced) {
      // Face the stand point (the pour aim still points at the ref wall —
      // driving into it would pin). One aim, held for the whole traverse.
      try { bot.lookAt(new Vec3(B.below.x + 0.5, B.below.y + 1.0, B.below.z + 0.5)) } catch (_) { /* facing best-effort */ }
      st.faced = true
      return 'running'
    }
    const standX = B.below.x + 0.5
    const standZ = B.below.z + 0.5
    const horiz = Math.hypot(bp.x - standX, bp.z - standZ)
    if (bp.y >= B.dest.y - 0.1 && horiz < TRAVERSE_ARRIVE_XZ) {
      // Jump STAYS held: releasing drifts back into the shaft (rig), the
      // strip below runs from the hover and releases at the end.
      st.phase = 'strip'
      st.stripLeft = st.sources.slice().sort((a, b) => b.y - a.y)
      st.stripTries = 0
      st.used = false
      st.stanceWaited = 0
      // Scoop or coast, never brake-and-float: releasing forward floats the
      // hover back north on the B current during the 1 s gap to the first
      // strip tick (replay: 0.32 in, 0.97 out, the stance never re-won).
      if (st.equipDone && horiz < STRIP_SCOOP_XZ) {
        // Arrival scoop: B goes back the SAME tick the ring closes — firing
        // from the arrival stance drops the body straight onto the stand.
        // The strip verifies and retries like any scoop.
        setForward(bot, false)
        fireScoop(bot, B.dest)
        st.used = true
        st.waited = 0
      } else {
        // Coast: keep swimming the gap stand-faced (a failed pre-equip
        // resets for a fresh strip-side equip). The press roughly cancels
        // the current drift, landing on/over the stand or against the far
        // wall; the stance gate withholds B until the taps re-center. The
        // strip kills the press on entry. Re-face: the correction storm
        // may have yawed the body mid-traverse.
        if (!st.equipDone) resetEquip(st)
        try { bot.lookAt(new Vec3(B.below.x + 0.5, B.below.y + 1.0, B.below.z + 0.5)) } catch (_) { /* facing best-effort */ }
        setForward(bot, true)
      }
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
      // Drift may have yawed the body off-course: re-face the stand point
      // while the press is released, then resume next tick.
      try { bot.lookAt(new Vec3(B.below.x + 0.5, B.below.y + 1.0, B.below.z + 0.5)) } catch (_) { /* facing best-effort */ }
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
    // Land ASAP: the old code hovered (jump held) through the whole strip,
    // and the hover drifted off the 1-wide stand during the B window — the
    // replay fell 5 past the stand to failed:no-gain. Jump stays on only
    // while airborne (hover-scoop); stood means scoop grounded, no drift.
    setJump(bot, !grounded)
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
      st.used = false
      st.stripTries = 0
      resetEquip(st)
      return 'running'
    }
    // Station hold over the stand: the B window hovers (jump on, above),
    // and an unheld hover walks off the 1-wide stand on the spread current
    // (replay no-gain). The deadband swallows tap-sized steps, so a stood
    // body never taps (no ledge-jumps); a drifted hover or a low landing
    // walks-swims back. This sets yaw before the strip aim below, so the
    // tap pushes aim-ward (≈ stand-ward for the B scoop directly overhead).
    if (st.combo && st.combo.B && st.combo.B.below) {
      const stand = st.combo.B.below
      tapToward(bot, bp, stand.x + 0.5, stand.z + 0.5, STRIP_STATION_DIST)
    }
    // Scoop-range tap, HOVER ONLY: a stood body scoops what is reachable
    // from the stand (walking off cannot help — A sits below the stand and
    // every fall increases its range). A drifting hover closes range the
    // same tap (aim-ward, above).
    const eye = eyeOf(bot)
    if (!grounded && dist(eye, cellCenter(cell)) > USE_REACH - 0.5) {
      tapToward(bot, bp, cell.x + 0.5, cell.z + 0.5, SWIM_CENTER_DIST)
    }
    if (!st.used) {
      const eq = equipStep(bot, st, 'bucket', POUR_TIMEOUT_TICKS)
      if (eq !== true) {
        if (eq === 'running') return 'running'
        // No empty bucket: nothing more to scoop — strip what we can.
        st.stripLeft.shift()
        st.used = false
        st.stripTries = 0
        resetEquip(st)
        return 'running'
      }
      // Stance gate, B only: B is the support water the hover floats in,
      // and scooping it off-stand drops the body past the stand edge into
      // the shaft (replay no-gain). An airborne hover outside the scoop
      // ring taps back (the station hold above already faced it) and waits
      // out the drift; stood, A, stripFail, and unknown-stand shapes fire
      // as before. The budget fires best-effort (buckets-first), never hangs.
      const Bc = st.combo && st.combo.B
      const standScoop = !failPhase && !grounded && Bc && Bc.dest && Bc.below && cell &&
        cell.x === Bc.dest.x && cell.y === Bc.dest.y && cell.z === Bc.dest.z &&
        Math.hypot(bp.x - (Bc.below.x + 0.5), bp.z - (Bc.below.z + 0.5)) > STRIP_SCOOP_XZ
      if (standScoop) {
        st.stanceWaited = (st.stanceWaited || 0) + 1
        if (st.stanceWaited <= STRIP_STANCE_TICKS) return 'running'
      }
      fireScoop(bot, cell)
      st.used = true
      st.waited = 0
      return 'running'
    }
    if (++st.waited < SCOOP_WAIT_TICKS) return 'running'
    st.used = false
    if (!isWater(readCell(bot, cell))) {
      st.stripLeft.shift()
      st.stripTries = 0
      resetEquip(st)
      return 'running'
    }
    if (++st.stripTries >= tries) {
      if (failPhase) {
        st.stripLeft.shift()
        st.stripTries = 0
        resetEquip(st)
        return 'running'
      }
      setJump(bot, false)
      return toStripFail(st, 'failed:strip')
    }
    // Retry same-tick aim + use next tick (hover heave moves the eye).
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
  SCAN_REACH,
  COMBO_MOUNT_BUDGET,
  EYE_HEIGHT,
  PLATEAU_BELOW_SRC,
  BUCKETS_NEEDED,
  POUR_VERIFY_TICKS,
  POUR_TIMEOUT_TICKS,
  SWIM_TIMEOUT_TICKS,
  SWIM_STALL_TICKS,
  SWIM_CENTER_DIST,
  SWIM_TAP_MS,
  CENTER_DIST,
  CENTER_TIMEOUT_TICKS,
  CENTER_TAP_MS,
  REASCEND_TICKS,
  TRAVERSE_TIMEOUT_TICKS,
  TRAVERSE_STALL_TICKS,
  STRIP_STANCE_TICKS,
  SCOOP_WAIT_TICKS,
  SCOOP_TRIES,
  STRIP_FAIL_TRIES,
  SETTLE_TICKS,
  countBuckets,
  wall2At,
  aimFace,
  cellCenter,
  rayFace,
  faceVisible,
  highPourAt,
  findHighPour,
  ledgePourAt,
  findLedgePour,
  findCombo,
  waterUpRun,
}
