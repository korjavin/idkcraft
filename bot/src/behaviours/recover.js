'use strict'

// Recovery menu (idkcraft-ef3): 'stuck' is a HARD STATE — the smart model
// picks the escape from a feasibility-gated menu of body primitives through
// the shared brain.ask(), with the FSM below as reserve and disagreement
// reference (same shape as goal.js chooseStep). The stuck fact is raised by
// the single detector in stuck.js via setStuck() below; the handwritten
// sidestep/jump the old detectors used to do lives here as the sidestep
// primitive. Safety veto is feasibility, not separate logic: a dangerous
// option never reaches the menu (lava near the dig_* primitives).
//
// Episode: the ticker routes here while ctx.stuck is set. decide() asks at
// entry and after each finished primitive only, never per tick; a running
// primitive keeps its action. A done progress primitive (pillar_up/dig_up)
// chains without re-asking (max REPEATS); anything else done ends the
// episode. 3 failures force call_player once, then the goal is dropped.

const { Vec3 } = require('vec3')
const { goals } = require('mineflayer-pathfinder')
const { countItems } = require('../perception')
const metrics = require('../metrics')
const danger = require('../danger')
const { botPos, denyReason, logDeny } = require('./util')
const { waterUpRun, countBuckets, wall2At, findCombo } = require('./waterup')

const MAX_FAILS = 3 // failed primitives before call_player + drop goal
const REPEATS = 4 // max chained dones of one progress primitive, no re-ask
const WAIT_TICKS = 10
const APEX_TIMEOUT_TICKS = 20
const DIG_TIMEOUT_TICKS = 40
const SIDESTEP_TIMEOUT_TICKS = 8
const DISPLACE_TIMEOUT_TICKS = 8 // dug-open patience (9sq): clear-but-still ticks before failed:no-progress
const HOP_MOUNT_TICKS = 14 // walk-in plus leap cycles (jsf.4: dig_step mounts through the same drive)
const HOP_STALL_TICKS = 2 // airborne + vel.y=0 samples before the unwedge back-off
const HOP_STALL_VY = 0.08 // stall band: a jump apex crosses it for one sample at most
const HOP_UNWEDGE_MS = 250 // unwedge back-hold: ~1 block per 1 Hz tick, re-held while stalled
const HOP_RETRY_BACK_MS = 100 // short back-off to leap stance: gap 0.25-0.5 off the face (wqt assay)
const HOP_PRESS_DIST = 1.0 // pressed: closer than this to the anchor a leap goes into the face (flush is 0.8)
const REST_GAVE_UPS = 2 // consecutive rest gave-ups before the step fails
const STUCK_TICKS_ENTRY = 30 // generic backstop: still + moving this long (canonical home: the recoverText buckets below need it too, and stuck.js reads it — one number, not two)
const PROGRESS_TOLERANCE = 0.5
const PILLAR_ISSUE_DY = 0.6 // ascent issue height: fire place on the way up (2bh)
const PILLAR_FAST_DY = 0.9 // fast-path issue height (round-3: see below)
const PILLAR_ISSUE_MS = 150 // jump-start → place issue delay (lzw: physics, not tick phase)
const PILLAR_REARM_MS = 50 // fire-time window miss (jump not registered yet): retry step
const PILLAR_ISSUE_LAST_MS = 300 // ceiling: re-arms stop here (see firePillarTimer)
const PILLAR_LIFTOFF_DY = 0.15 // below this height the jump hasn't begun (lzw: the ceiling slides)
const PILLAR_STALL_MS = 5000 // absolute patience per arm: a stall past this yields (quit bounds the chain)
const SIDESTEP_DIST = 2
const NEAR_PLAYER = 8

const RECOVER_ORDER = ['pillar_up', 'dig_up', 'water_up', 'dig_step', 'hop_step', 'sidestep', 'dig_through', 'wait', 'call_player']

// Menu shaping (y34: laya answers dig_step on 549/603 prod stuck menus where
// the FSM says hop_step/sidestep - digging where a hop would do). Where a hop
// works, never ask about digging: hop is feasible only for a level goal
// (|goalDy| <= 1), where dig_step is never the FSM answer, so the menu loses
// no climber. A failed hop still escalates to digging: the 4jr exclusion
// below removes hop from the ask menu first, and shaping is a no-op without
// it. Stand (/tmp/y34-stand, 45 real menus x2 reps vs laya): agreement
// 26.7% -> 77.8%, dig picks 37 -> 14, hop picks 1 -> 24. Exported so the
// rule has one source of truth, like shapeGoalMenu.
// duc: the same for sidestep, goal-gated — on a level/low goal a sidestep
// beats digging a step upward (wrong direction), but on a high goal dig is
// the FSM climber and stays. No escape on the menu ([dig,wait] pit): no
// shaping, digging out beats standing still.
function shapeRecoverMenu(names, facts) {
  if (names.length > 1 && names.includes('dig_step')) {
    if (names.includes('hop_step')) return names.filter((n) => n !== 'dig_step')
    if (names.includes('sidestep') && facts && facts.goalDy < 2) return names.filter((n) => n !== 'dig_step')
  }
  return names
}

// --- world scan helpers (all best-effort: nulls read as free/safe) ---


function fmtPos(p) {
  if (!p) return 'unknown'
  const f = (n) => (typeof n === 'number' ? (Number.isInteger(n) ? n : n.toFixed(1)) : '0')
  return `${f(p.x)},${f(p.y)},${f(p.z)}`
}

function cellAt(bot, dx, dy, dz) {
  try {
    const p = botPos(bot)
    if (!p || !bot.blockAt) return null
    return bot.blockAt(new Vec3(Math.floor(p.x) + dx, Math.floor(p.y) + dy, Math.floor(p.z) + dz))
  } catch (_) { return null }
}

// Solid for movement: a full block. Air-like, water and lava are passable
// (lava is tracked separately as a veto fact, not a wall).
function solid(b) {
  if (!b) return false
  if (typeof b.boundingBox === 'string') return b.boundingBox !== 'empty'
  const n = typeof b.name === 'string' ? b.name : ''
  return n !== '' && !n.endsWith('air') && n !== 'water' && n !== 'lava'
}

function isLava(b) {
  return !!b && typeof b.name === 'string' && b.name.includes('lava')
}

function isWater(b) {
  return !!b && typeof b.name === 'string' && b.name.includes('water')
}

// Own-column headroom: the two cells the 1.8 body rises through. dig_up's
// gate (9sq F1): it digs exactly these cells, so free own headroom means
// nothing to dig even when a neighbour lip vetoes the pillar (oz8).
function ownHeadBlockedAt(bot) {
  return solid(cellAt(bot, 0, 1, 0)) || solid(cellAt(bot, 0, 2, 0))
}

// Headroom for a jump (oz8): the own column plus a neighbouring lip the
// drifting 0.6-wide body can reach. Rig 2026-09-28 (CLUSTER pocket, stance
// frac-x 0.30): own column free, west lip at dy+2 with air below — the jump
// wedged and failed no-apex over 20 ticks while the scan read free. A
// neighbour threatens only when the body can drift into it (dy+0 AND dy+1
// free — a dy+1-solid neighbour can never hold the 1.8 body, it is a wall
// to slide along, so chimney climbs and feet-level notches read free)
// with rock two above, and only inside the body's XZ reach (half-width 0.3
// + margin). Diagonals need both orthogonal neighbours enterable too (a
// wall in either seals the corner). The margin covers float noise at
// exact-boundary stances plus sub-tick drift; it must stay well under 0.2,
// past which centered stances (frac 0.5) would catch the side columns and
// veto working chimney jumps.
const HEAD_DRIFT_MARGIN = 0.05
function headBlockedAt(bot) {
  if (ownHeadBlockedAt(bot)) return true
  let bp = null
  try { bp = botPos(bot) } catch (_) { bp = null }
  if (!bp) return false
  const reach = 0.3 + HEAD_DRIFT_MARGIN
  const fx = Math.floor(bp.x)
  const fz = Math.floor(bp.z)
  for (let cx = Math.floor(bp.x - reach); cx <= Math.floor(bp.x + reach); cx++) {
    for (let cz = Math.floor(bp.z - reach); cz <= Math.floor(bp.z + reach); cz++) {
      const dx = cx - fx
      const dz = cz - fz
      if (dx === 0 && dz === 0) continue
      // A diagonal lip is reachable only past both orthogonal neighbours:
      // a wall in either seals the corner (revmux 01).
      if (dx !== 0 && dz !== 0) {
        if (solid(cellAt(bot, dx, 0, 0)) || solid(cellAt(bot, dx, 1, 0))) continue
        if (solid(cellAt(bot, 0, 0, dz)) || solid(cellAt(bot, 0, 1, dz))) continue
      }
      // A lip needs TWO free cells below the rock (revmux 01): with dy+1
      // solid the 1.8 body can never be inside the column at any jump
      // phase, so that neighbour is a wall to slide along, never a bonk.
      if (!solid(cellAt(bot, dx, 0, dz)) && !solid(cellAt(bot, dx, 1, dz)) &&
        solid(cellAt(bot, dx, 2, dz))) return true
    }
  }
  return false
}

// Goalward 1x2 solidity for the dig_through menu fact (9sq F1): stuck.goal
// only, mirroring the run body (no target fallback) — without a stuck goal
// the primitive fails no-direction, so it must not be offered. Nulls read
// as open (never offer a blind dig).
function throughBlockedAt(bot, goal) {
  try {
    const bp = botPos(bot)
    if (!bp || !goal || typeof goal.x !== 'number' || typeof goal.z !== 'number') return false
    const dx = goal.x - bp.x
    const dz = goal.z - bp.z
    if (dx === 0 && dz === 0) return false
    const step = Math.abs(dx) >= Math.abs(dz) ? [Math.sign(dx), 0] : [0, Math.sign(dz)]
    return solid(cellAt(bot, step[0], 0, step[1])) || solid(cellAt(bot, step[0], 1, step[1]))
  } catch (_) { return false }
}

// Measured displacement since the primitive started (9sq F2): sideways drift
// past the stuck tolerance, or a grounded floor rise — the sidestep freed /
// climbed pair, minus the goal-approach arm. A rise only counts on the
// ground (the ak4 apex guard, like dig_step/hop_step/sidestep).
function displaced(st, bp, grounded) {
  try {
    if (!st || !st.start || !bp) return false
    if (Math.hypot(bp.x - st.start.x, bp.z - st.start.z) > PROGRESS_TOLERANCE) return true
    return !!grounded && Math.floor(bp.y) > Math.floor(st.start.y)
  } catch (_) { return false }
}

// Blocks a bare hand breaks fast (9sh): pit dirt/grass/sand/gravel walls.
// canDigBlock with an empty hand is the arbiter where available; the name
// set is the fallback (unit mocks, unreadable registry).
const HAND_DIG = new Set([
  'dirt', 'grass_block', 'coarse_dirt', 'rooted_dirt', 'podzol', 'mycelium',
  'mud', 'muddy_mangrove_roots', 'sand', 'red_sand', 'suspicious_sand',
  'gravel', 'suspicious_gravel', 'clay', 'snow', 'snow_block', 'moss_block',
])
function handDiggable(bot, b) {
  // Round-1 finding 1: mineflayer canDigBlock checks only diggable+reach,
  // never the tool — trusting it alone calls stone hand-diggable in prod.
  // The name set governs; canDigBlock only confirms reach where present.
  if (!b || typeof b.name !== 'string' || b.name === 'air') return false
  if (!HAND_DIG.has(b.name) && !b.name.endsWith('_leaves')) return false
  try {
    if (bot && typeof bot.canDigBlock === 'function') return !!bot.canDigBlock(b)
  } catch (_) { /* reach check best-effort */ }
  return true
}

// Stone a pickaxe breaks fast (jsf.4): pit andesite/granite/diorite/stone
// walls ladder with a pick on hand. No ores — forage owns those.
const PICK_DIG = new Set([
  'stone', 'andesite', 'granite', 'diorite', 'cobblestone',
  'deepslate', 'tuff', 'calcite', 'sandstone', 'dripstone_block',
])
function diggable(bot, b) {
  if (handDiggable(bot, b)) return true
  if (!b || typeof b.name !== 'string') return false
  if (!hasPickaxe(bot)) return false
  if (!PICK_DIG.has(b.name)) return false
  try {
    if (bot && typeof bot.canDigBlock === 'function') return !!bot.canDigBlock(b)
  } catch (_) { /* reach check best-effort */ }
  return true
}

const SIDES = [[1, 0], [-1, 0], [0, 1], [0, -1]]

function scanSides(bot) {
  const free = []
  let walls = 0
  for (const [dx, dz] of SIDES) {
    const blocked = solid(cellAt(bot, dx, 0, dz)) || solid(cellAt(bot, dx, 1, dz))
    if (blocked) walls++
    else free.push([dx, dz])
  }
  return { walls, free }
}

function inWater(bot) {
  return isWater(cellAt(bot, 0, 0, 0)) || !!(bot && bot.entity && bot.entity.isInWater === true)
}

// Sidestep direction. Dry: random free side (along-wall can round the
// obstacle). Wet against one wall (1wj): the shore current pushes every
// tick's prediction back into face-touch, and Paper 26.x rejects the whole
// move on any touch — a random side swims along the face and re-touches
// forever (10-20/s same-pos storm, zero displacement; rig: even accepted
// 1 cm packet nudges re-touch next tick, a 30 cm jump is dragged back in
// 0.5 s). Away from the solid side is the only escape: predictions clear
// the face, the storm stops, the body is free in ~2 s (rig: fm 0,
// executor GOAL-REACHED). Corners and open water keep the random pick.
function pickSidestepDir(bot, sides) {
  const free = sides.free
  if (free.length > 0 && inWater(bot)) {
    const blocked = SIDES.filter(([dx, dz]) => !free.some(([fx, fz]) => fx === dx && fz === dz))
    if (blocked.length === 1) {
      const away = free.find(([fx, fz]) => fx === -blocked[0][0] && fz === -blocked[0][1])
      if (away) return away
    }
  }
  return free[Math.floor(Math.random() * free.length)]
}

// Pit fact (jsf.3, shared with jsf.2 water_up): at least TWO sides rise two
// solid blocks (dy 0 AND 1) — hemmed in, not merely next to one trunk,
// house wall or cliff face (revmux 01: a lone 2-high side on open ground
// must keep sidestepping, not pillar dirt against the owner's base).
// Nulls read as open (never claim a pit blind). Lava and water never
// count (solid() reads them passable).
function pitAt(bot) {
  let high = 0
  for (const [dx, dz] of SIDES) {
    if (solid(cellAt(bot, dx, 0, dz)) && solid(cellAt(bot, dx, 1, dz))) high++
  }
  return high >= 2
}

// Climb arm for goal-less backstop episodes (jsf.3): the ticker backstop
// fires between walk legs with no live goal (goalDist null), and a pit
// around the body means up is the only way out (the 44-scaffold gave-up:
// menu hop/dig_step/sidestep, pillar_up never offered). A level goal with
// a known dist stays unclimbable even in a pit (4jr: the goal sits inside
// the pit, a pillar to it is pointless).
function pitClimb(facts) {
  return !!facts && facts.goalDist === null && !!facts.pit
}

// Lava in or around the mount head: digging the cap would open a flow
// onto the mount, and standing under lava is death either way. Mirrors the
// executor's dontCreateFlow refusal (liquid above or beside the break).
function capLavaAt(bot, dx, dz) {
  return isLava(cellAt(bot, dx, 2, dz)) || isLava(cellAt(bot, dx, 3, dz)) ||
    isLava(cellAt(bot, dx + 1, 2, dz)) || isLava(cellAt(bot, dx - 1, 2, dz)) ||
    isLava(cellAt(bot, dx, 2, dz + 1)) || isLava(cellAt(bot, dx, 2, dz - 1))
}

// Lava behind the above cell (revmux jsf.4-01 minor): breaking above lets it
// flow into the dug cell and on toward the head. lavaNear's ±1 cube covers
// above's other neighbours and capLavaAt covers the cap's whole surround —
// the two-out cell at above height is the gap (hand-dig had it too, but the
// stone ladder reaches the depths where lava sits).
function farLavaAt(bot, dx, dz) {
  return isLava(cellAt(bot, dx * 2, 1, dz * 2))
}

// A dug staircase cycle (9sh hand, jsf.4 pickaxe): the side cell at feet
// level stays as the step to mount, the side cell above it is air or digs
// (by hand, or stone with a pickaxe on hand), the mount head above that is
// air or digs the same way (adv: the 1.8 body stands the mount with its
// head in (dx,2,dz)), no lava in or around the head, none behind the dig,
// and the head has room to jump. Returns the side [dx, dz] or null.
function findDigStepDir(bot) {
  if (solid(cellAt(bot, 0, 2, 0))) return null
  let cobbleSide = null
  for (const [dx, dz] of SIDES) {
    const step = cellAt(bot, dx, 0, dz)
    if (!solid(step)) continue
    const above = cellAt(bot, dx, 1, dz)
    if (above && solid(above) && !diggable(bot, above)) continue
    const cap = cellAt(bot, dx, 2, dz)
    if (cap && solid(cap) && !diggable(bot, cap)) continue
    if (capLavaAt(bot, dx, dz)) continue
    if (farLavaAt(bot, dx, dz)) continue
    // Cobble last (revmux jsf.4-01 major): foreign cobble is drq-protected
    // and refuses at denyReason — never let it shadow a natural side that
    // digs. An only-cobble staircase is still offered (own-session pillars
    // ladder through placedByBot).
    if ((above && above.name === 'cobblestone') || (cap && cap.name === 'cobblestone')) {
      if (!cobbleSide) cobbleSide = [dx, dz]
      continue
    }
    return [dx, dz]
  }
  return cobbleSide
}

// A plain +1 mount (cjq): the side cell at feet level is solid, the cell
// above it is air (never a dig — the dig_step staircase owns dug mounts),
// the head has room to jump, neither cell is lava. Sides read goalward
// first so the mount walks toward the stuck goal, not away. Returns the
// side [dx, dz] or null.
function findHopStepDir(bot, gp) {
  if (solid(cellAt(bot, 0, 2, 0))) return null
  const bp = botPos(bot)
  let gx = 0
  let gz = 0
  if (gp && typeof gp.x === 'number' && bp) {
    gx = Math.sign(gp.x - bp.x)
    gz = Math.sign(gp.z - bp.z)
  }
  const sides = SIDES.slice().sort((a, b) => (b[0] * gx + b[1] * gz) - (a[0] * gx + a[1] * gz))
  for (const [dx, dz] of sides) {
    const step = cellAt(bot, dx, 0, dz)
    if (!solid(step) || isLava(step)) continue
    const above = cellAt(bot, dx, 1, dz)
    if (above && (solid(above) || isLava(above))) continue
    // Headroom after the mount: the head ends two above the step base.
    const head = cellAt(bot, dx, 2, dz)
    if (head && (solid(head) || isLava(head))) continue
    return [dx, dz]
  }
  return null
}

function lavaNearAt(bot) {
  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      for (let dz = -1; dz <= 1; dz++) {
        if (isLava(cellAt(bot, dx, dy, dz))) return true
      }
    }
  }
  return false
}

// Pillar fuel: dirt and cobblestone. One predicate for the count and the
// finder, so a positive count always yields an item to equip below.
function isScaffoldName(n) {
  return n === 'dirt' || n === 'cobblestone'
}

function scaffoldCount(bot) {
  return countItems(bot, isScaffoldName)
}

// Scaffold already in hand: the apply path skips the equip wait (and the
// look wait when aiming down the same column, i.e. every block after the
// first), so L drops to send + tick-align and a +100 ms issue would apply
// before the feet exit the cell (round-2 minor: rig +100 2/3, the refusal
// applied at +102). Best-effort: a false negative just keeps +0.6.
function heldScaffold(bot) {
  try {
    const h = bot && bot.heldItem
    return !!h && typeof h.name === 'string' && isScaffoldName(h.name)
  } catch (_) { return false }
}

// Latency-adaptive trigger height (round-3): slow path (equip + look
// waits, L ~100-300) fires from +0.6 so the apply lands before the feet
// return (~+410); fast path (in hand, L ~ send + align) fires from +0.9
// so the apply lands after the feet exit (+154). Same-tick fall-through
// forces the re-jump guard below to use this same height.
function pillarTriggerDy(bot) {
  return heldScaffold(bot) ? PILLAR_FAST_DY : PILLAR_ISSUE_DY
}

function findScaffoldItem(bot) {
  let items = []
  try {
    items = bot && bot.inventory && typeof bot.inventory.items === 'function' ? bot.inventory.items() : []
  } catch (_) { return null }
  if (!Array.isArray(items)) return null
  return items.find((i) => i && typeof i.name === 'string' && isScaffoldName(i.name) && (typeof i.count !== 'number' || i.count > 0)) || null
}

// Fire-time rise check (2bh window, lzw timer): the +150 ms jump-start timer
// issues placeBlock only while RISING (vy > 0 past the trigger height),
// never on the fall. Measured jump: +0.42/+0.75/+1.00/+1.17 at
// +50/+100/+150/+200 ms, apex +1.25 at +250 (vy +0.003), feet re-enter the
// cell falling at ~+410. The async issue lands the server apply L later
// (prod L ~100-300: equip + look + tick align — the old +1.0 window's 0/79
// proves L is large, not localhost-small): +150 ms issues apply +250..+450
// with the feet clear, while apex (+250) issues apply up to +550, feet
// back in the cell (self-intersection refusal).
// Deliberately NO vy floor above 0 (round-2): with tick-phase issuance
// 1 Hz ticks against the exact 600 ms jump cycle phase-locked onto 3 fixed
// phases per episode (rig: 15 ticks, zero drift), so any window under
// ~200 ms could miss the whole episode — a vy > 0.1 floor timed out 0/3.
// (Fast-apply race: +100 ms issues refuse when L < 50 applies before the
// feet exit at +154 — happens whenever scaffold is already in hand, prod
// included (every block after the first). pillarTriggerDy answers it: the
// fast path fires from +0.9 instead.)
// A missing velocity (mocks) reads as inside the window.
function risingWindow(bot) {
  try {
    const v = bot && bot.entity && bot.entity.velocity
    if (!v || typeof v.y !== 'number') return true
    return v.y > 0
  } catch (_) { return true }
}

// Dig with the right tool: pillar_up leaves scaffold in hand, and digging
// stone bare-handed takes ~7.5 s instead of ~1 s (revmux 01 body-1). Same
// bestHarvestTool pattern as forage.js; a missing tool reads as "dig with
// whatever is in hand".
function digTool(bot, cell) {
  try {
    if (bot.pathfinder && typeof bot.pathfinder.bestHarvestTool === 'function') return bot.pathfinder.bestHarvestTool(cell) || null
  } catch (_) { /* tool best-effort */ }
  return null
}

// One log-safe token from a place error: the prod line carries err= so the
// next session review sees WHY the server refused, not just that it did.
function shortErr(e) {
  const m = e && typeof e.message === 'string' ? e.message : String(e)
  return m.split('\n')[0].trim().replace(/\s+/g, '_').slice(0, 80) || 'unknown'
}

function hasPickaxe(bot) {
  return countItems(bot, (n) => n.endsWith('_pickaxe')) > 0
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

function setBack(bot, on) {
  try {
    if (typeof bot.setControlState === 'function') bot.setControlState('back', !!on)
  } catch (_) { /* control best-effort */ }
}

// --- stuck facts ---

function recoverFacts(bot, ctx, state, target) {
  const bp = botPos(bot)
  const stuck = (ctx && ctx.stuck) || {}
  const gp = stuck.goal || (target && target.position) || null
  let goalDy = 0
  let goalDist = null
  if (gp && typeof gp.x === 'number' && typeof gp.y === 'number' && typeof gp.z === 'number' && bp) {
    goalDy = Math.round(gp.y - bp.y)
    goalDist = Math.round(Math.hypot(gp.x - bp.x, gp.y - bp.y, gp.z - bp.z))
  }
  const sides = scanSides(bot)
  let playerOnline = false
  let playerDist = null
  let playerName = (target && target.username) || ((ctx && ctx.lead && ctx.lead.by) || null)
  try {
    const players = (bot && bot.players) || {}
    for (const key of Object.keys(players)) {
      if (key === bot.username) continue
      playerOnline = true
      const ent = players[key] && players[key].entity
      if (ent && ent.position && bp) {
        const d = Math.hypot(ent.position.x - bp.x, ent.position.y - bp.y, ent.position.z - bp.z)
        if (playerDist === null || d < playerDist) {
          playerDist = d
          playerName = (players[key] && players[key].username) || key
        }
      }
    }
  } catch (_) { /* roster best-effort */ }
  const rec = ctx && ctx.recovery
  return {
    by: stuck.by || 'unknown',
    goalDy,
    goalDist,
    scaffold: scaffoldCount(bot),
    pickaxe: hasPickaxe(bot),
    bucket: countBuckets(bot),
    water: inWater(bot),
    headBlocked: headBlockedAt(bot),
    ownHeadBlocked: ownHeadBlockedAt(bot),
    throughBlocked: throughBlockedAt(bot, stuck.goal),
    digStep: findDigStepDir(bot),
    hopStep: findHopStepDir(bot, gp),
    walls: sides.walls,
    pit: pitAt(bot),
    // water_up (jsf.2): a climbable pour combo (high shaft pour with a clear
    // swim lane + a dry ledge pour above its spread) and a 2-high wall beside
    // the body (the bead's one-side pit gate — jsf.3's 2-side pit reads false
    // in 1-wide open shafts, the proven geometry). Scanned like digStep /
    // hopStep: decide-time only, never per tick.
    combo: !!findCombo(bot),
    wall2: wall2At(bot),
    freeSides: sides.free,
    lavaNear: lavaNearAt(bot),
    playerOnline,
    playerDist: playerDist === null ? null : Math.round(playerDist),
    playerName,
    stuckTicks: (ctx && ctx.stuckTicks) || 0,
    resetsStuck: (ctx && ctx.stuckResets) || 0,
    resetsPlaceError: (ctx && ctx.placeErrors) || 0,
    placeError: !!(ctx && ctx.recovery && ctx.recovery.placeError),
    last: rec && rec.last ? `${rec.last.action}:${rec.last.outcome}` : 'none',
  }
}

function stuckBucket(n) {
  return n < 10 ? 'fresh' : n < STUCK_TICKS_ENTRY ? 'long' : 'very-long'
}

// Canonical facts text, ALSO the model state and the ask dedup key: bucket
// words, not raw counters (iwb lesson) — raw stuck_ticks would re-ask every
// tick while the bot stands still.
function recoverText(facts) {
  const dy = facts.goalDy >= 2 ? 'high' : facts.goalDy <= -2 ? 'low' : 'level'
  const dist = facts.goalDist === null ? 'none' : String(facts.goalDist)
  const player = !facts.playerOnline ? 'none' : facts.playerDist === null ? 'far' : facts.playerDist <= NEAR_PLAYER ? 'near' : 'far'
  return `stuck=${stuckBucket(facts.stuckTicks)} goal=${dy} dist=${dist} ` +
    `scaffold=${facts.scaffold} pickaxe=${facts.pickaxe ? 'yes' : 'no'} bucket=${(facts.bucket || 0) >= 2 ? 'yes' : 'no'} water=${facts.water ? 'yes' : 'no'} ` +
    `head=${facts.headBlocked ? 'blocked' : 'free'} walls=${facts.walls} pit=${facts.pit ? 'yes' : 'no'} player=${player} ` +
    `resets=${facts.resetsStuck}/${facts.resetsPlaceError} last=${facts.last}`
}

// FSM reserve and disagreement reference (bead order verbatim): climb when
// the goal is above, else sidestep, else dig through, else call, else wait.
// wait is always feasible so this always returns a menu member. Escalation,
// not repetition (prod 2026-09-23: 28 of 35 repeat wedges at the same spot):
// after a failure the just-failed primitive yields to the next feasible one
// (the model sees the same signal via last=<action>:<outcome> in the facts).
function recoverFsm(facts, names) {
  const ok = new Set(Array.isArray(names) ? names : [])
  let failed = null
  const m = /^(pillar_up|dig_up|water_up|dig_step|hop_step|sidestep|dig_through|wait|call_player):failed/.exec((facts && facts.last) || '')
  if (m && ok.size > 1) failed = m[1]
  const pick = (n) => n !== failed && ok.has(n)
  if ((facts.goalDy >= 2 || pitClimb(facts)) && pick('pillar_up')) return 'pillar_up'
  if ((facts.goalDy >= 2 || pitClimb(facts)) && pick('dig_up')) return 'dig_up'
  // jsf.2: buckets climb water after the scaffold/pickaxe climbers (a pillar
  // is cheaper and cannot lose the kit). High goal, or a goalless backstop
  // beside a 2-high wall — never a known level goal: the climb is a one-way
  // door (4jr: the goal sits inside the pit, height gained is never given
  // back), and hop/sidestep own the level case.
  if ((facts.goalDy >= 2 || (facts.goalDist === null && facts.wall2)) && pick('water_up')) return 'water_up'
  if (facts.goalDy >= 2 && pick('dig_step')) return 'dig_step'
  // High goal, no climb primitive, enclosed pit, player online: asking beats
  // a sideways shuffle the strict sidestep rule would fail anyway (9sh). In
  // the open (walls < 3) sidestep keeps its turn: walking goalward can still
  // gain and free the wedge, which the fja rule counts as done.
  if (facts.goalDy >= 2 && facts.playerOnline && facts.walls >= 3 && pick('call_player') &&
    !ok.has('pillar_up') && !ok.has('dig_up') && !ok.has('water_up') && !ok.has('dig_step')) return 'call_player'
  // Level goal with a mountable +1 next to the body: hopping it beats a
  // sideways shuffle (cjq: the executor wedges on straight +1 steps with
  // path=success, and sidestep displacement just re-queues the same wedge).
  if (Math.abs(facts.goalDy) <= 1 && pick('hop_step')) return 'hop_step'
  if (pick('sidestep')) return 'sidestep'
  if (pick('dig_through')) return 'dig_through'
  if (pick('call_player')) return 'call_player'
  return 'wait'
}

// One question for the smart model. Short clauses on the fact words,
// exactly like the goal step criteria: every longer variant regressed on
// the stand. Dangerous options are absent by feasibility (lava veto), never
// by instruction — the model only ever sees safe labels.
// Wording validated on the stand (bot/tools/stand-ef3.js): verbs-first v1
// beats the long v0 on laya 5/7 to 4/7 agreement (JEV ties 5/7); all runs
// 7/7 valid labels, disagreements are all safe (wait / call_player).
const RECOVER_INSTRUCTIONS = 'The bot is stuck. Pick one recovery action'
const RECOVER_CRITERIA = {
  pillar_up: 'climb: goal is high or in a pit, scaffold on hand, headroom free — jump and place one block under your feet',
  dig_up: 'climb: goal is high or in a pit, pickaxe on hand — dig above your head and climb',
  water_up: 'climb: water bucket on hand, wall too high — pour water on the wall, swim up the fall, scoop it back',
  dig_step: 'climb: low on blocks, pit wall digs by hand or pickaxe — dig one step and climb out',
  hop_step: 'climb: level goal, solid step with air above — back up and hop one block up, no digging',
  sidestep: 'bypass: a side is open — step sideways around the obstacle',
  dig_through: 'tunnel: pickaxe on hand, no lava near — dig 1-wide 2-tall toward the goal',
  wait: 'wait: the blockage looks temporary — stand still',
  call_player: 'help: a player is online and no escape works — ask the player for a teleport',
}

// Model recovery choice with the FSM as fallback and disagreement
// reference, exactly like goal chooseStep: { action, source, fsm, model }.
// source is only-option (single feasible action, model not asked), fsm (no
// ask method: stub brain or unit tests), <brain source> (model answered) or
// stub-fallback (model consulted and failed: invalid label or error).
async function chooseRecovery(brain, facts, feasible) {
  const names = RECOVER_ORDER.filter((n) => feasible.includes(n))
  const text = recoverText(facts)
  const fsm = recoverFsm(facts, names)
  // The just-failed primitive is out of the MODEL menu (4jr): the FSM
  // already escalates past it, but laya repeated pillar_up to MAX_FAILS.
  // Kept when it is the only option; the FSM fallback below still sees it.
  // Decided on askNames, not names (round-2 minors): a menu shrunk to one
  // answer must not cost a brain call on the tick path.
  const failedM = /^(pillar_up|dig_up|water_up|dig_step|hop_step|sidestep|dig_through|wait|call_player):failed/.exec((facts && facts.last) || '')
  const unshaped = (failedM && names.length > 1) ? names.filter((n) => n !== failedM[1]) : names
  // y34/duc shaping after the 4jr exclusion: a failed hop/sidestep is
  // already out, so shaping never hides the dig it escalates to. Before
  // the only-option check: a menu shrunk to one answer costs no brain
  // call (round-2 rule).
  const askNames = shapeRecoverMenu(unshaped, facts)
  if (askNames.length <= 1) return { action: askNames[0] || 'wait', source: 'only-option', fsm, model: null }
  if (!brain || typeof brain.ask !== 'function') return { action: fsm, source: 'fsm', fsm, model: null }
  const model = (brain.source || brain.name || 'model')
  const criteria = {}
  for (const n of askNames) criteria[n] = RECOVER_CRITERIA[n]
  const fail = (reason) => {
    metrics.escalation.inc({ from: model, to: 'fsm', reason })
    return { action: fsm, source: 'stub-fallback', fsm, model }
  }
  try {
    const label = await brain.ask({ state: text, instructions: RECOVER_INSTRUCTIONS, criteria, situation: text })
    // An infeasible label is still a model opinion against the FSM
    // reference: disagree first, then fall back (acceptance: invalid answers
    // disagree in the log).
    if (label !== fsm) {
      // menu= is the asked menu (post-4jr exclusion + y34 shaping), like
      // goal's disagree line — the y34 stand replays prod stuck menus.
      console.error(`brain disagree source=${model} model=${label} fsm=${fsm} reason=stuck menu=${askNames.join(',')} facts=${text}`)
    }
    if (!askNames.includes(label)) return fail('invalid')
    return { action: label, source: model, fsm, model }
  } catch (err) {
    const msg = String((err && err.message) || err)
    const reason = (err && err.name === 'TimeoutError') ? 'timeout'
      : msg.startsWith('jev missing') ? 'invalid'
      : 'error'
    return fail(reason)
  }
}

// --- primitives: one tick each, multi-tick state in ctx.recovery.st ---
// Every primitive returns 'running' | 'done' | 'failed:<reason>'.

// Pillar up: jump, issue ONE placeBlock into the feet cell from a +150 ms
// jump-start timer (lzw — tick phase phase-locks against the 600 ms jump),
// verify. Exactly one placement in flight at a time — parallel
// placeBlock calls into one cell share one server ack and loop forever
// (idkcraft-yvi: 438 place_error, 7.5 min in place).
function pillarUpRun(bot, ctx) {
  const rec = ctx.recovery
  const st = rec.st || (rec.st = { phase: 'jump', waited: 0, placeInFlight: false, placed: false, placeError: false, startFloor: null })
  const bp = botPos(bot)
  if (!bp) return 'failed:no-pos'
  // Runtime veto double-check: feasibility said yes, the world may disagree.
  if (scaffoldCount(bot) === 0) { setJump(bot, false); return 'failed:no-scaffold' }
  if (headBlockedAt(bot)) { setJump(bot, false); return 'failed:head-blocked' }
  if (st.startFloor === null) st.startFloor = Math.floor(bp.y)
  if (st.phase === 'jump') {
    // Descending floor anchor (cm0.2): the cycle may arm mid-flight — an
    // approach jump still airborne when stuck fires (prod 09:36:48 armed at
    // +0.8 with feet=air; the 5 s place silence followed). A first tick
    // that samples the body a block too high parks the trigger above the
    // apex and the cycle jumps to no-apex (rig 3/3). Follow the body down;
    // never up (a rise is the jump the timer is timing). A grounded sample
    // below re-seeds at once; airborne samples need two in a row (1 Hz
    // ticks phase-lock against the 600 ms hop and can miss the ~50 ms
    // grounded window between bunny-hops, but a single correction blip is
    // not a landing).
    if (st.startFloor !== null && Math.floor(bp.y) < st.startFloor) {
      st.belowFloor = (st.belowFloor || 0) + 1
      if ((bot.entity && bot.entity.onGround) || st.belowFloor >= 2) {
        st.startFloor = Math.floor(bp.y)
        st.belowFloor = 0 // every re-seed needs its own confirmation
      }
    } else {
      st.belowFloor = 0
    }
    // The timer owns issuance; jump-phase ticks only hold jump and the
    // no-apex budget. Armed once per cycle (the re-jump guard below resets
    // the flags so a fresh cycle arms a fresh timer).
    if (!st.timerArmed) {
      st.timerArmed = true
      st.jumpAt = Date.now()
      st.armedAt = st.jumpAt
      try {
        const t = setTimeout(() => firePillarTimer(bot, ctx, st), PILLAR_ISSUE_MS)
        if (t && typeof t.unref === 'function') t.unref()
      } catch (_) { /* timer best-effort */ }
    }
    setJump(bot, true)
    if (++st.waited > APEX_TIMEOUT_TICKS) { setJump(bot, false); return 'failed:no-apex' }
    return 'running'
  }
  if (st.placed) {
    // Verify the block is really there before claiming done: the target is
    // the feet cell we jumped from (startFloor), whatever floor we read now.
    return solid(cellAt(bot, 0, st.startFloor - Math.floor(bp.y), 0)) ? 'done' : 'failed:no-place'
  }
  if (st.placeError) return 'failed:place-error'
  if (st.syncFail) return 'failed:' + st.syncFail
  if (st.placeInFlight) return 'running'
  // Fell below the issue height with a stale place phase and nothing in
  // flight (knockback): jump again and re-arm. The timer issues atomically
  // with the transition, so a live episode rarely lands here — the guard
  // matches pillarTriggerDy, and no-self-intersection comes from apply
  // timing (see risingWindow), not from this line.
  if (bp.y < st.startFloor + pillarTriggerDy(bot) - 0.01) {
    st.phase = 'jump'; st.waited = 0; st.timerArmed = false; st.jumpAt = null; st.armedAt = null
    return 'running'
  }
  const reason = issuePillarPlace(bot, st)
  if (reason) return 'failed:' + reason
  return 'running'
}

// Physics-timed issue (lzw): fire placeBlock ~150 ms after jump start with
// a FRESH height/velocity read at fire time, not on tick phase. The 1 Hz
// tick against the exact 600 ms jump cycle phase-locks onto 3 fixed phases
// per episode (rig: 15 ticks, zero drift), so a tick-phase trigger can miss
// the ~150 ms rise window the whole episode; the timer cannot. A fire-time
// miss re-arms every 50 ms — ceiling: the feet re-enter the cell falling
// at ~+410 (rig +450 refused 3/3), so re-arms stop at +300 past liftoff
// and even a slow-path apply (L ~100-300) lands before the return. The
// ceiling is liftoff-anchored: while the body is still at the start height
// the 600 ms cycle hasn't begun (stall at cycle start — rig: a jump that
// left 750 ms late), so the clock slides instead of burning and a held
// jump issues into the next rise. Absolute patience per arm is 5 s (a stall
// past that yields; with no ticks — quit — nothing re-arms and the chain
// ends instead of polling a dead bot). A dead chain always yields: the
// next jump-phase tick arms a fresh timer, so a later rise still issues
// instead of jumping to no-apex (a mid-air arm catches apex/fall only).
// Stale timers (the episode chained or released under us) only ever return.
function firePillarTimer(bot, ctx, st) {
  try {
    if (!st || !ctx || ctx.recovery == null || ctx.recovery.st !== st) return
    if (st.phase !== 'jump' || st.placed || st.placeInFlight || st.placeError || st.syncFail) return
    const bp = botPos(bot)
    if (!bp || st.startFloor === null) return
    if (bp.y >= st.startFloor + pillarTriggerDy(bot) && risingWindow(bot)) {
      st.phase = 'place'
      setJump(bot, false)
      const reason = issuePillarPlace(bot, st)
      if (reason) st.syncFail = reason
      return
    }
    const now = Date.now()
    if (bp.y < st.startFloor + PILLAR_LIFTOFF_DY) st.jumpAt = now
    if (now - (st.jumpAt || 0) < PILLAR_ISSUE_LAST_MS && now - (st.armedAt || st.jumpAt || 0) < PILLAR_STALL_MS) {
      try {
        const t = setTimeout(() => firePillarTimer(bot, ctx, st), PILLAR_REARM_MS)
        if (t && typeof t.unref === 'function') t.unref()
      } catch (_) { /* timer best-effort */ }
    } else {
      st.timerArmed = false
    }
  } catch (_) { /* timer best-effort */ }
}

// Synchronous half of the place issue, shared by the jump-start timer and
// the tick path: finds the reference, equips scaffold, starts the async
// placement. Returns a fail reason, or null once the async issue is in
// flight (or an already-solid cell verified instead). Never throws.
function issuePillarPlace(bot, st) {
  const bp = botPos(bot)
  if (!bp) return 'no-pos'
  // Already solid (a twin call, an earlier cycle): verify instead of
  // stacking a second placement into the cell (the yvi loop).
  if (solid(cellAt(bot, 0, st.startFloor - Math.floor(bp.y), 0))) { st.placed = true; return null }
  // Reference: a solid neighbour of the feet cell, ground below first.
  const fx = Math.floor(bp.x)
  const fz = Math.floor(bp.z)
  const fy = st.startFloor
  const refs = [
    { d: [0, -1, 0], f: [0, 1, 0] },
    { d: [1, 0, 0], f: [-1, 0, 0] },
    { d: [-1, 0, 0], f: [1, 0, 0] },
    { d: [0, 0, 1], f: [0, 0, -1] },
    { d: [0, 0, -1], f: [0, 0, 1] },
  ]
  let ref = null
  let face = null
  for (const r of refs) {
    const c = cellAt(bot, fx - Math.floor(bp.x) + r.d[0], fy - Math.floor(bp.y) + r.d[1], fz - Math.floor(bp.z) + r.d[2])
    if (solid(c)) { ref = c; face = new Vec3(r.f[0], r.f[1], r.f[2]); break }
  }
  if (!ref || typeof bot.placeBlock !== 'function') return 'no-reference'
  // Equip first: mineflayer throws 'must be holding an item to place' on
  // an empty hand and the server refuses a held tool (prod 2026-09-27: 67
  // pillar_ups, 0 placed). Prefer the held stack: the fast trigger
  // assumed its instant apply, while findScaffoldItem returns main
  // inventory first and would pay a window move (round-3 core-1/body-2).
  // The count gate in pillarUpRun already vetoed an empty stock; this
  // covers an inventory that changed mid-jump.
  const item = heldScaffold(bot) ? bot.heldItem : findScaffoldItem(bot)
  if (!item) { setJump(bot, false); return 'no-scaffold' }
  st.placeInFlight = true
  void (async () => {
    try {
      if (typeof bot.equip === 'function') await bot.equip(item, 'hand')
      await bot.placeBlock(ref, face)
      st.placed = true
    } catch (e) { st.placeError = true; st.placeErr = shortErr(e) } finally { st.placeInFlight = false }
  })()
  return null
}

// Dig up: remove headroom (feet+1, then feet+2) with the pickaxe. Done needs
// measured displacement since the start (9sq F2), not just air above — clear
// headroom with a frozen body waits out the displace budget, then fails, so
// the episode moves on to a climber (or call_player) instead of looping
// instant dones. Lava next to the dig is a runtime veto.
function digUpRun(bot, ctx) {
  const rec = ctx.recovery
  const st = rec.st || (rec.st = { waited: 0, digInFlight: false, digError: false })
  const bp = botPos(bot)
  if (!bp) return 'failed:no-pos'
  if (!st.start) st.start = { x: bp.x, y: bp.y, z: bp.z }
  if (!hasPickaxe(bot)) return 'failed:no-pickaxe'
  if (lavaNearAt(bot)) return 'failed:lava'
  const head1 = cellAt(bot, 0, 1, 0)
  const head2 = cellAt(bot, 0, 2, 0)
  if (!solid(head1) && !solid(head2)) {
    const grounded = !bot.entity || !!bot.entity.onGround
    if (displaced(st, bp, grounded)) return 'done'
    st.verify = (st.verify || 0) + 1
    if (st.verify > DISPLACE_TIMEOUT_TICKS) return 'failed:no-progress'
    return 'running'
  }
  if (st.digError) return 'failed:dig-error'
  if (st.digInFlight) {
    if (++st.waited > DIG_TIMEOUT_TICKS) return 'failed:dig-timeout'
    return 'running'
  }
  if (typeof bot.dig !== 'function') return 'failed:no-dig'
  const cell = solid(head1) ? head1 : head2
  const denyUp = denyReason(bot, cell, ctx)
  if (denyUp) { logDeny(cell, denyUp); return 'failed:' + denyUp } // idkcraft-drq
  st.digInFlight = true
  void (async () => {
    try {
      const tool = digTool(bot, cell)
      if (tool && typeof bot.equip === 'function') await bot.equip(tool, 'hand')
      await bot.dig(cell)
    } catch (_) { st.digError = true } finally { st.digInFlight = false }
  })()
  return 'running'
}

// Dig a step and mount it (9sh hand, jsf.4 pickaxe ladder): no scaffold,
// dirt pit bare-handed, stone pit with a pick. One cycle digs the wall
// above the side step plus the mount head above that (adv), then mounts
// the step top through the shared hop leap — done on floor rise,
// repeatable to the mouth. st.dir re-scans when its step collapses
// mid-cycle.
function digStepRun(bot, ctx) {
  const rec = ctx.recovery
  const st = rec.st || (rec.st = { dir: null, phase: 'dig', waited: 0, digInFlight: false, digError: false, startFloor: null })
  const bp = botPos(bot)
  if (!bp) return 'failed:no-pos'
  if (st.startFloor === null) st.startFloor = Math.floor(bp.y)
  // Round-1 finding 2: a 1 Hz tick sampling the jump apex reads y+1 while
  // airborne. Done needs ground under the risen feet — landing back on the
  // pit floor is not an escape. (The step column itself is not required: a
  // natural +1 ledge nearby is genuine progress too.)
  const grounded = !bot.entity || !!bot.entity.onGround
  if (Math.floor(bp.y) > st.startFloor && grounded) { setJump(bot, false); setForward(bot, false); return 'done' }
  // Release drive controls every tick (the leap holds forward into the
  // step — without this a chained cycle walks on while digging). The mount
  // below re-asserts what it needs same-tick.
  setForward(bot, false)
  setBack(bot, false)
  if (!st.dir) {
    st.dir = findDigStepDir(bot)
    if (!st.dir) { setJump(bot, false); return 'failed:no-step' }
  }
  if (st.stepPos) {
    // Mount in progress: validate the ABSOLUTE anchor, hop-style — the
    // relative step cell reads the dug above-cell once the leap rises, so
    // a relative check collapses every leap mid-arc. The leap owns the
    // tick: no digging mid-arc.
    let anchored = null
    try {
      if (bot.blockAt) anchored = bot.blockAt(new Vec3(st.stepPos.x, st.stepPos.y, st.stepPos.z))
    } catch (_) { /* anchor read best-effort */ }
    if (!solid(anchored)) {
      st.dir = null
      st.stepPos = null
      st.leapt = false
      st.armed = false
      st.settled = false
      setJump(bot, false)
      setForward(bot, false)
      setBack(bot, false)
      return 'running'
    }
    return mountStep(bot, st, st.stepPos)
  }
  // Lava in or around the mount head re-scans before any digging: opening
  // the cells under lava would pour a flow onto the mount. The find skips
  // these sides, so this terminates.
  if (capLavaAt(bot, st.dir[0], st.dir[1])) { st.dir = null; return 'running' }
  if (farLavaAt(bot, st.dir[0], st.dir[1])) { st.dir = null; return 'running' }
  const above = cellAt(bot, st.dir[0], 1, st.dir[1])
  if (above && solid(above)) {
    if (!diggable(bot, above)) { st.dir = null; return 'running' }
    if (lavaNearAt(bot)) { setJump(bot, false); return 'failed:lava' }
    if (st.digError) { setJump(bot, false); return 'failed:dig-error' }
    if (st.digInFlight) {
      if (++st.waited > DIG_TIMEOUT_TICKS) { setJump(bot, false); return 'failed:dig-timeout' }
      return 'running'
    }
    if (typeof bot.dig !== 'function') { setJump(bot, false); return 'failed:no-dig' }
    const denyAbove = denyReason(bot, above, ctx)
    if (denyAbove) { setJump(bot, false); logDeny(above, denyAbove); return 'failed:' + denyAbove } // idkcraft-drq
    st.digInFlight = true
    void (async () => {
      try {
        const tool = digTool(bot, above)
        if (tool && typeof bot.equip === 'function') await bot.equip(tool, 'hand')
        await bot.dig(above)
      } catch (_) { st.digError = true } finally { st.digInFlight = false }
    })()
    return 'running'
  }
  // Mount head (adv): the body stands the mount with its head in
  // (dx,2,dz) — dig a hand-diggable solid there like above instead of
  // relying on the executor's canDig to clear it mid-mount.
  const cap = cellAt(bot, st.dir[0], 2, st.dir[1])
  if (cap && solid(cap)) {
    if (!diggable(bot, cap)) { st.dir = null; return 'running' }
    if (lavaNearAt(bot)) { setJump(bot, false); return 'failed:lava' }
    if (st.digError) { setJump(bot, false); return 'failed:dig-error' }
    if (st.digInFlight) {
      if (++st.waited > DIG_TIMEOUT_TICKS) { setJump(bot, false); return 'failed:dig-timeout' }
      return 'running'
    }
    if (typeof bot.dig !== 'function') { setJump(bot, false); return 'failed:no-dig' }
    const denyCap = denyReason(bot, cap, ctx)
    if (denyCap) { setJump(bot, false); logDeny(cap, denyCap); return 'failed:' + denyCap } // idkcraft-drq
    st.digInFlight = true
    void (async () => {
      try {
        const tool = digTool(bot, cap)
        if (tool && typeof bot.equip === 'function') await bot.equip(tool, 'hand')
        await bot.dig(cap)
      } catch (_) { st.digError = true } finally { st.digInFlight = false }
    })()
    return 'running'
  }
  // Headroom dug: fix the absolute anchor and mount through the shared hop
  // leap (jsf.4) — direct drive only, no executor goal: a GoalNear would
  // fight the leap at 20 Hz (7gt), and a leap from wall contact never
  // leaves the ground on Paper (wqt). The relative cell goes stale the
  // moment the body walks (floor(bp) shifts), so the target is fixed once
  // here; the mount branch above validates the anchor, never the cell.
  const step = cellAt(bot, st.dir[0], 0, st.dir[1])
  if (!solid(step)) { st.dir = null; return 'running' }
  st.phase = 'step'
  st.waited = 0
  st.leapt = false
  st.armed = false
  st.stall = 0
  st.settled = false
  const q = step && step.position
  st.stepPos = q ? { x: q.x, y: q.y, z: q.z } : null
  if (!st.stepPos) { st.dir = null; return 'running' }
  return mountStep(bot, st, st.stepPos)
}

// Shared +1 mount drive (jsf.4): the hop_step leap both climbers mount
// through. Paper 26.1.2 silently rejects (server teleport, no log) any move
// whose arc meets a wall, so a leap from contact never leaves the ground
// (wqt: rise 0.00, ~20 rejects/s; vanilla mounts the same leap). A 1 Hz
// tick cannot time a run-up leap — the body walks 4+ blocks between ticks
// and is always already pressed — so there is no run-up: pressed (under
// HOP_PRESS_DIST of the anchor) backs to leap stance on a 100 ms timer
// (gap 0.25-0.5, measured) and leaps from the standstill (measured 4/4
// mounts, 0 rejects); open floor walks in without jumping, in-flight arcs
// coast with thrust held, airborne stalls unwedge (ak4). A failed leap
// lands back pressed and re-backs (self-retry inside HOP_MOUNT_TICKS). No
// executor goal the whole mount — direct drive only, so the lib never
// fights the leap (7gt). st carries dir/waited/leapt/armed/stall/settled/
// startFloor; stepPos is the absolute anchor the caller fixed (the relative
// cell goes stale once the body walks). Returns running | done | failed:*.
function mountStep(bot, st, stepPos) {
  const bp = botPos(bot)
  if (!bp) return 'failed:no-pos'
  const grounded = !bot.entity || !!bot.entity.onGround
  setBack(bot, false) // the back-offs below re-assert it every tick they hold
  // Airborne-stall samples (ak4): hang time at vel.y=0 with no ground reads
  // here; the stall section backs off once they pile up.
  const hopVy = bot.entity && bot.entity.velocity && typeof bot.entity.velocity.y === 'number'
    ? bot.entity.velocity.y : null
  if (!grounded && hopVy !== null && Math.abs(hopVy) < HOP_STALL_VY) st.stall = (st.stall || 0) + 1
  else st.stall = 0
  const sx = stepPos.x + 0.5
  const sz = stepPos.z + 0.5
  const dx = sx - bp.x
  const dz = sz - bp.z
  // Past the step on the ground: an arc overflowing a narrow top lands
  // beyond it at the old floor — the wedge is behind, no re-mount needed.
  if (grounded && (-dx * st.dir[0] - dz * st.dir[1]) > 1.0) { setJump(bot, false); setForward(bot, false); return 'done' }
  // Settled waits inside the same mount budget: a body knocked or coasted
  // off the top (overshoot, fight borrow, knockback) must fail out instead
  // of waiting for a grounded sample that never comes (no episode timeout).
  if (st.settled) {
    if (++st.waited > HOP_MOUNT_TICKS) { setJump(bot, false); setForward(bot, false); return 'failed:no-progress' }
    return 'running'
  }
  if (Math.floor(bp.y) > st.startFloor &&
      Math.hypot(bp.x - (stepPos.x + 0.5), bp.z - (stepPos.z + 0.5)) < 0.5) {
    // Over the top (airborne or landed): cut thrust and settle. Holding jump
    // bunny-hops past the top while the anchor-facing look walks the body
    // back off the ledge. Not released on floor rise alone: mid-leap over
    // the face still needs forward to carry over.
    st.settled = true
    st.waited = 0 // fresh landing window inside the same bound
    setJump(bot, false); setForward(bot, false)
    return 'running'
  }
  // Head veto, disarmed mid-leap: a mount that lands under a 2-high ceiling
  // is still an escape, and killing jump mid-air drops the body back off
  // the step. Re-arms on every back-off, so each fresh leap re-checks.
  if (!st.leapt && headBlockedAt(bot)) { setJump(bot, false); setForward(bot, false); return 'failed:head-blocked' }
  try {
    if (typeof bot.look === 'function') bot.look(Math.atan2(-dx, -dz), 0)
  } catch (_) { /* facing best-effort */ }
  if ((st.stall || 0) >= HOP_STALL_TICKS) {
    // Airborne stall (ak4): pressed to the face with vel.y=0 and no ground,
    // the held jump never fires (the sprint-wedge hang from index.js). Back
    // off — facing stays on the anchor, so back walks off the face — until a
    // sample reads ground, then the drive walks back in. Shares the mount
    // budget; leap state resets so the resume re-backs instead of leaping
    // from a 250 ms stance (too long a runway for a standstill leap).
    st.leapt = false
    st.armed = false
    setForward(bot, false)
    setJump(bot, false)
    // Timed hold (round 2): primitives run at 1 Hz, so a raw hold walks ~4
    // blind blocks. 250 ms backs ~1 block off the face; a still-stalled next
    // tick holds again. A stale timer only ever releases — safe across ticks.
    setBack(bot, true)
    try { setTimeout(() => setBack(bot, false), HOP_UNWEDGE_MS) } catch (_) { /* timer best-effort */ }
    if (++st.waited > HOP_MOUNT_TICKS) { setBack(bot, false); return 'failed:no-progress' }
    return 'running'
  }
  if (grounded && Math.hypot(dx, dz) < HOP_PRESS_DIST) {
    // Pressed (wqt): Paper zeroes a leap from contact, so back to leap
    // stance instead of leaping — 100 ms lands gap 0.25-0.5, and the next
    // tick leaps from the standstill. A still-pressed next tick holds
    // again. A stale timer only ever releases — safe across ticks.
    st.leapt = false
    st.armed = true
    setForward(bot, false)
    setJump(bot, false)
    setBack(bot, true)
    try { setTimeout(() => setBack(bot, false), HOP_RETRY_BACK_MS) } catch (_) { /* timer best-effort */ }
    if (++st.waited > HOP_MOUNT_TICKS) { setBack(bot, false); return 'failed:no-progress' }
    return 'running'
  }
  // Open floor: armed (just backed off) leaps from the standstill; anything
  // else walks in without jumping — a run-up leap cannot be timed on 1 Hz
  // ticks and only re-presses. Airborne samples coast with thrust held: an
  // in-flight arc must complete, never back off mid-air.
  setForward(bot, true)
  if (st.armed || !grounded) {
    setJump(bot, true)
    st.leapt = true
    st.armed = false
  } else {
    setJump(bot, false)
  }
  if (++st.waited > HOP_MOUNT_TICKS) { setJump(bot, false); setForward(bot, false); return 'failed:no-progress' }
  return 'running'
}

// Hop a plain +1 step (cjq): no digging, level goal only. Finds the
// goalward step, fixes the absolute anchor, re-scans when it is gone, and
// mounts through mountStep — done on a grounded floor rise (same
// apex-sampling guard as dig_step) or grounded past the step (an arc
// overflowing a narrow top still escapes). Single shot, never repeatable:
// one mount ends the episode.
function hopStepRun(bot, ctx) {
  const rec = ctx.recovery
  const st = rec.st || (rec.st = { dir: null, stepPos: null, waited: 0, startFloor: null, leapt: false, armed: false, stall: 0, settled: false })
  const bp = botPos(bot)
  if (!bp) return 'failed:no-pos'
  if (st.startFloor === null) st.startFloor = Math.floor(bp.y)
  const grounded = !bot.entity || !!bot.entity.onGround
  if (Math.floor(bp.y) > st.startFloor && grounded) { setJump(bot, false); setForward(bot, false); return 'done' }
  if (!st.dir) {
    const gp = ctx.stuck && ctx.stuck.goal
    st.dir = findHopStepDir(bot, gp)
    if (!st.dir) { setJump(bot, false); setForward(bot, false); return 'failed:no-step' }
    // Absolute anchor: the relative cell goes stale the moment the body
    // walks (floor(bp) shifts), so the mount target is fixed once here.
    const step = cellAt(bot, st.dir[0], 0, st.dir[1])
    const q = step && step.position
    if (!q) { st.dir = null; setJump(bot, false); setForward(bot, false); return 'failed:no-step' }
    st.stepPos = { x: q.x, y: q.y, z: q.z }
  }
  let step = null
  try {
    if (bot.blockAt && st.stepPos) step = bot.blockAt(new Vec3(st.stepPos.x, st.stepPos.y, st.stepPos.z))
  } catch (_) { /* anchor read best-effort */ }

  if (!solid(step)) {
    st.dir = null; st.stepPos = null; st.leapt = false; st.armed = false; st.settled = false
    setJump(bot, false); setForward(bot, false)
    return 'running'
  }
  return mountStep(bot, st, st.stepPos)
}

// Sidestep: the old wedge/nudge action, now a primitive — 2 blocks toward
// a free side with a one-tick jump. Done on displacement, failed when the
// body still does not move.
function sidestepRun(bot, ctx) {
  const rec = ctx.recovery
  const st = rec.st || (rec.st = { start: null, dir: null, waited: 0, issued: false })
  const bp = botPos(bot)
  if (!bp) return 'failed:no-pos'
  if (!st.start) {
    st.start = { x: bp.x, y: bp.y, z: bp.z }
    // Snapshot the goal for the approach check below (fja): a flat shuffle
    // toward a far goal is not an escape. Null for the generic backstop.
    const gp = ctx.stuck && ctx.stuck.goal
    st.goal0 = gp && typeof gp.x === 'number' && typeof gp.y === 'number' && typeof gp.z === 'number'
      ? { x: gp.x, y: gp.y, z: gp.z }
      : null
    st.goalDist0 = st.goal0 ? Math.hypot(bp.x - st.goal0.x, bp.y - st.goal0.y, bp.z - st.goal0.z) : null
    const sides = scanSides(bot)
    if (sides.free.length === 0) return 'failed:boxed'
    st.dir = pickSidestepDir(bot, sides)
  }
  // Done only when the situation really changed (fja). The strict rule
  // applies to goal-less backstop episodes (the session pit: nothing to
  // resume toward, shuffling proves nothing) and high goals (a climb
  // situation). A level goal keeps the old displacement done: a wedge that
  // walks 2 blocks sideways is genuinely free and the mode resumes pathing
  // — failing that would burn strikes and misroute to dig/call_player.
  // Backstop episodes stay strict (q0h round 2): the ticker backstop now
  // carries the live walk goal, but a 0.5-block shuffle toward it still
  // proves nothing — without this the fja pit loop returns for every
  // level-goal backstop and the rest counter never reaches its mark.
  const backstop = ctx.stuck && ctx.stuck.by === 'no-displacement'
  const strict = backstop || !st.goal0 || (st.goal0.y - st.start.y) >= 2
  // Apex guard (ak4): the 1 Hz tick samples the sidestep jump mid-air, so a
  // floor rise only counts on the ground — same rule as dig_step/hop_step.
  const climbed = (!bot.entity || !!bot.entity.onGround) && Math.floor(bp.y) > Math.floor(st.start.y)
  let gained = false
  if (strict && st.goal0 && (st.goal0.y - st.start.y) >= 2 && typeof st.goalDist0 === 'number') {
    gained = st.goalDist0 - Math.hypot(bp.x - st.goal0.x, bp.y - st.goal0.y, bp.z - st.goal0.z) > 1
  }
  const freed = !strict && Math.hypot(bp.x - st.start.x, bp.z - st.start.z) > PROGRESS_TOLERANCE
  if (climbed || gained || freed) {
    setJump(bot, false)
    return 'done'
  }
  if (++st.waited > SIDESTEP_TIMEOUT_TICKS) { setJump(bot, false); return 'failed:no-progress' }
  if (!st.issued) {
    st.issued = true
    try {
      if (bot.pathfinder && typeof bot.pathfinder.setGoal === 'function') {
        bot.pathfinder.setGoal(new goals.GoalNear(bp.x + st.dir[0] * SIDESTEP_DIST, bp.y, bp.z + st.dir[1] * SIDESTEP_DIST, 1), false)
      }
    } catch (_) { /* goal best-effort */ }
    setJump(bot, true)
  } else {
    setJump(bot, false)
  }
  return 'running'
}

// Dig through: a 1x2 tunnel toward the goal, feet cell first, one dig at a
// time. Done needs measured displacement since the start (9sq F2), like
// dig_up: an open tunnel with a frozen body waits out the displace budget,
// then fails. Lava in a target cell is a runtime veto, like the menu
// feasibility.
function digThroughRun(bot, ctx) {
  const rec = ctx.recovery
  const st = rec.st || (rec.st = { waited: 0, digInFlight: false, digError: false })
  const bp = botPos(bot)
  if (!bp) return 'failed:no-pos'
  if (!st.start) st.start = { x: bp.x, y: bp.y, z: bp.z }
  if (!hasPickaxe(bot)) return 'failed:no-pickaxe'
  const stuck = ctx.stuck || {}
  const gp = stuck.goal
  let dx = 0
  let dz = 0
  if (gp && typeof gp.x === 'number' && typeof gp.z === 'number') {
    dx = gp.x - bp.x
    dz = gp.z - bp.z
  }
  if (dx === 0 && dz === 0) return 'failed:no-direction'
  const step = Math.abs(dx) >= Math.abs(dz) ? [Math.sign(dx), 0] : [0, Math.sign(dz)]
  const feet = cellAt(bot, step[0], 0, step[1])
  const head = cellAt(bot, step[0], 1, step[1])
  if (isLava(feet) || isLava(head)) return 'failed:lava'
  if (lavaNearAt(bot)) return 'failed:lava'
  if (!solid(feet) && !solid(head)) {
    const grounded = !bot.entity || !!bot.entity.onGround
    if (displaced(st, bp, grounded)) return 'done'
    st.verify = (st.verify || 0) + 1
    if (st.verify > DISPLACE_TIMEOUT_TICKS) return 'failed:no-progress'
    return 'running'
  }
  if (st.digError) return 'failed:dig-error'
  if (st.digInFlight) {
    if (++st.waited > DIG_TIMEOUT_TICKS) return 'failed:dig-timeout'
    return 'running'
  }
  if (typeof bot.dig !== 'function') return 'failed:no-dig'
  const cell = solid(feet) ? feet : head
  const denyThrough = denyReason(bot, cell, ctx)
  if (denyThrough) { logDeny(cell, denyThrough); return 'failed:' + denyThrough } // idkcraft-drq
  st.digInFlight = true
  void (async () => {
    try {
      const tool = digTool(bot, cell)
      if (tool && typeof bot.equip === 'function') await bot.equip(tool, 'hand')
      await bot.dig(cell)
    } catch (_) { st.digError = true } finally { st.digInFlight = false }
  })()
  return 'running'
}

// Wait out a temporary blockage. Done only on measured displacement (9sq
// F2): a full wait with a frozen body is failed:no-progress, so a hopeless
// wait burns budget toward call_player instead of ending the episode done.
function waitRun(bot, ctx) {
  const rec = ctx.recovery
  const st = rec.st || (rec.st = { n: 0 })
  const bp = botPos(bot)
  if (!bp) return 'failed:no-pos'
  if (!st.start) st.start = { x: bp.x, y: bp.y, z: bp.z }
  const grounded = !bot.entity || !!bot.entity.onGround
  if (displaced(st, bp, grounded)) return 'done'
  st.n++
  return st.n >= WAIT_TICKS ? 'failed:no-progress' : 'running'
}

// Call the player for a teleport, exactly once per episode. Terminal: the
// episode ends after this (release drops the goal).
function callPlayerRun(bot, ctx) {
  const rec = ctx.recovery
  if (rec.calledPlayer) return 'done'
  const bp = botPos(bot)
  const facts = recoverFacts(bot, ctx, null, null)
  const name = facts.playerName
  if (!name) return 'failed:no-player'
  try {
    bot.chat(`I'm stuck at ${Math.floor(bp.x)} ${Math.floor(bp.y)} ${Math.floor(bp.z)}, /tp ${bot.username} ${name}`)
  } catch (_) { return 'failed:chat' }
  rec.calledPlayer = true
  rec.endEpisode = true
  return 'done'
}

const RECOVER_MENU = {
  pillar_up: {
    // 4jr: a pillar to a level goal is pointless — laya took the first menu
    // item anyway, 29 times in 16 min. Climb prims need the goal above —
    // jsf.3 excepts a pit with NO goal (pitClimb): up is the only way out.
    // p4s: placing is what just failed (3 done / 49 failed:place-error a
    // day) — after a place-error in this episode pillar_up leaves the menu.
    // 5vv: jumping to the apex in water is pointless — swim exits and
    // sidestep own the escape, not the scaffold.
    feasible: (facts) => (facts.goalDy >= 1 || pitClimb(facts)) && facts.scaffold > 0 && !facts.headBlocked && !facts.placeError && !facts.water,
    run: pillarUpRun,
    repeatable: (facts) => (facts.goalDy >= 1 || pitClimb(facts)) && facts.scaffold > 0 && !facts.placeError && !facts.water,
    verb: 'pillaring up',
  },
  dig_up: {
    // 9sq F1: headroom already free means nothing to dig — never offer, and
    // never chain onto free headroom either (the chain is an offer with no ask).
    // jsf.3: like pillar_up, a pit with no goal climbs (head still blocked).
    // oz8: the own-column gate — a neighbour lip vetoes the pillar above but
    // leaves nothing to dig; the fallback keeps stand/tests literals working.
    feasible: (facts) => (facts.goalDy >= 1 || pitClimb(facts)) && facts.pickaxe && !facts.lavaNear && (facts.ownHeadBlocked ?? facts.headBlocked),
    run: digUpRun,
    repeatable: (facts) => (facts.goalDy >= 1 || pitClimb(facts)) && facts.pickaxe && (facts.ownHeadBlocked ?? facts.headBlocked),
    verb: 'digging up',
  },
  water_up: {
    // jsf.2: the bare-pit climber (no scaffold, no pickaxe). Two buckets, not
    // one: a single pour cannot ratchet (a scoop takes the top source, i.e.
    // cancels the newest pour — rig), so the combo always spends a pair.
    // High goal, or a goalless backstop beside a 2-high wall: a known level
    // goal never climbs (one-way door, see the FSM arm). The chain re-scans
    // the combo at each stand; the strip returns both buckets.
    feasible: (facts) => (facts.bucket || 0) >= 2 && facts.combo && !facts.water && !facts.lavaNear && !facts.headBlocked &&
      (facts.goalDy >= 2 || (facts.goalDist === null && facts.wall2)),
    run: waterUpRun,
    repeatable: (facts) => (facts.bucket || 0) >= 2 && facts.combo && !facts.water && !facts.lavaNear && !facts.headBlocked &&
      (facts.goalDy >= 2 || (facts.goalDist === null && facts.wall2)),
    verb: 'pouring water to swim up',
  },
  dig_step: {
    feasible: (facts) => facts.digStep != null && !facts.lavaNear,
    run: digStepRun,
    repeatable: (facts) => facts.goalDy >= 1 && facts.digStep != null,
    verb: 'digging a step',
  },
  hop_step: {
    feasible: (facts) => facts.hopStep != null && Math.abs(facts.goalDy) <= 1 && !facts.lavaNear,
    run: hopStepRun,
    verb: 'hopping the step',
  },
  sidestep: {
    feasible: (facts) => facts.walls < 4,
    run: sidestepRun,
    verb: 'sidestepping',
  },
  dig_through: {
    // 9sq F1: nothing solid toward the goal means nothing to tunnel.
    feasible: (facts) => facts.pickaxe && !facts.lavaNear && facts.throughBlocked,
    run: digThroughRun,
    verb: 'digging through',
  },
  wait: {
    feasible: () => true,
    run: waitRun,
    verb: 'waiting it out',
  },
  call_player: {
    feasible: (facts, ctx) => facts.playerOnline && !(ctx && ctx.recovery && ctx.recovery.calledPlayer),
    run: callPlayerRun,
    verb: 'calling the player',
  },
}

// --- episode ---

// The single detector (stuck.js) calls this instead of moving the body
// itself. True on the transition (fact raised), false when an episode
// already runs, the fact is already set, or the latch holds for the same
// situation (a just-finished episode: re-firing without new information
// would ask+chat every few seconds). A moved goal clears the latch and
// raises fresh.
function goalClose(a, b) {
  if (!a || !b) return !a && !b
  if (typeof a.x !== 'number' || typeof b.x !== 'number') return false
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z) <= 2
}
// Rest gave-up marker (q0h): while the rest step keeps failing at one
// point, detectors hold their fire there — relocation re-arms them. Lazy: a
// far sample clears the marker and reports no hold.
function anyPlayerOnline(bot) {
  try {
    const players = (bot && bot.players) || {}
    for (const key of Object.keys(players)) {
      if (key !== bot.username) return true
    }
  } catch (_) { /* roster best-effort */ }
  return false
}

const REST_GIVE_UP_DIST = 2
// Relocation ends the hold in any step or mode (core-1 follow-up): the
// detectors consult the gate only when firing, so a clean /tp out would
// otherwise leave a stale mark behind. Called every tick (stuck.update)
// and from the gate itself.
function clearRelocatedRestMark(ctx, bot) {
  try {
    const at = ctx && ctx.restGaveUpAt
    if (!at || typeof at.x !== 'number') return
    const bp = botPos(bot)
    if (bp && Math.hypot(bp.x - at.x, bp.z - at.z) > REST_GIVE_UP_DIST) {
      ctx.restGaveUpAt = null
      ctx.restGaveUpCalled = false
      ctx.restGaveUps = 0
    }
  } catch (_) { /* marker best-effort */ }
}

function restGaveUpHolds(ctx, bot) {
  try {
    if (!ctx || !ctx.work || ctx.step !== 'rest') return false
    const at = ctx.restGaveUpAt
    if (!at || typeof at.x !== 'number') return false
    // A player online lapses the hold once per mark (rounds 2-3): one episode
    // must stay reachable so MAX_FAILS asks for a teleport — afterwards the
    // point holds even online until relocation, instead of paging every
    // episode. The marker stays across roster changes; relocation clears all.
    if (anyPlayerOnline(bot) && !ctx.restGaveUpCalled) return false
    const bp = botPos(bot)
    if (!bp) return true // no position: hold, never spin blind
    if (Math.hypot(bp.x - at.x, bp.z - at.z) > REST_GIVE_UP_DIST) {
      clearRelocatedRestMark(ctx, bot)
      return false
    }
    return true
  } catch (_) { return false }
}

// Latch consults (were tickerLatched/clearStaleRoamLatch plus the walkHomeTick
// inline check, with three copies of the radius): since 6x7.2 the one
// release latch lives in stuck.js COOLDOWN — one radius (LATCH_CLEAR), one
// consult covering every owner. The backstop raises through setStuck like
// every other owner, so a noPath trap re-fires only past the latch radius
// (rra round 1), never every ~45 s.
function setStuck(ctx, by, goal, key) {
  if (!ctx || ctx.recovery || ctx.stuck) return false
  const g = goal && typeof goal.x === 'number' ? { x: goal.x, y: goal.y, z: goal.z } : null
  const k = key || by || 'unknown'
  const L = ctx.recoverLatch
  if (L && L.by === (by || 'unknown') && L.key === k) {
    // spot: keys latch on the key alone (the goal they carry is random or
    // irrelevant); other keys latch on a close goal (a moved goal is new).
    if (k.startsWith('spot:') || goalClose(L.goal, g)) return false
    ctx.recoverLatch = null // same detector, moved situation: fresh episode
  }
  ctx.stuck = { by: by || 'unknown', goal: g, key: k }
  return true
}

function blockNameOf(b) {
  try {
    return (b && typeof b.name === 'string' && b.name) || '?'
  } catch (_) { return '?' }
}

// Chosen lines (fja) carry the facts text plus feet/head/next block names
// (b50 wedge-line style), so a pit, water and a wall read apart in prod
// logs. facts is null on terminal/continue lines: pos alone there.
// Hop diagnostics (ak4): why the mount does or does not fire — ground
// contact, vertical speed, the step column and the own column above the
// head. Best-effort: unknown sides read '?'.
function hopDetail(bot, ctx) {
  let og = '?'
  let vy = '?'
  try {
    og = !bot.entity ? '?' : bot.entity.onGround ? '1' : '0'
    const v = bot.entity && bot.entity.velocity
    vy = v && typeof v.y === 'number' ? v.y.toFixed(2) : '?'
  } catch (_) { /* telemetry best-effort */ }
  let dir = null
  try { dir = ctx && ctx.recovery && ctx.recovery.st && ctx.recovery.st.dir } catch (_) { dir = null }
  if (!dir) {
    try { dir = findHopStepDir(bot, ctx && ctx.stuck && ctx.stuck.goal) } catch (_) { dir = null }
  }
  const nm = (dx, dy, dz) => blockNameOf(cellAt(bot, dx, dy, dz))
  const step = dir ? nm(dir[0], 0, dir[1]) : '?'
  const above = dir ? nm(dir[0], 1, dir[1]) : '?'
  const head = dir ? nm(dir[0], 2, dir[1]) : '?'
  return `hop=og:${og},vy:${vy},step:${step},above:${above},head:${head},col2:${nm(0, 2, 0)}`
}

function logRecover(bot, ctx, action, source, outcome, facts) {
  let extra = ''
  if (facts) {
    let next = '?:?'
    try {
      const n = ctx && ctx.lastPathNext
      if (n && typeof n.x === 'number') {
        next = `${n.x},${n.y},${n.z}:${blockNameOf(bot.blockAt && bot.blockAt(n))}`
      }
    } catch (_) { /* next best-effort */ }
    extra = ` facts=${recoverText(facts)} feet=${blockNameOf(cellAt(bot, 0, 0, 0))} ` +
      `head=${blockNameOf(cellAt(bot, 0, 1, 0))} next=${next}`
  }
  if (action === 'hop_step') extra += ` ${hopDetail(bot, ctx)}`
  if (outcome === 'failed:place-error') {
    try {
      const pe = ctx && ctx.recovery && ctx.recovery.st && ctx.recovery.st.placeErr
      if (pe) extra += ` err=${pe}`
    } catch (_) { /* err best-effort */ }
  }
  console.log(`recover action=${action} source=${source} outcome=${outcome} pos=${fmtPos(botPos(bot))}${extra}`)
}

// One page per pit per mark TTL: the latch zone is the same avoid radius
// that triggers paging, so gave-ups wandering one pit floor (revmux
// 01-review: A-B-A ping-pong inside 6 blocks) page once, not per episode.
// Relocation past the pit (or an expired mark) re-arms.
function repeatPaged(ctx, bp) {
  const pg = ctx && ctx.repeatGaveUpPage
  if (!pg || typeof pg.x !== 'number' || typeof pg.z !== 'number') return false
  if (typeof pg.at !== 'number' || Date.now() - pg.at > danger.TTL_MS) return false
  return Math.hypot(bp.x - pg.x, bp.z - pg.z) <= danger.AVOID_RADIUS
}

// Episode end: drop the pathfinder goal (a stale goal re-wedges the next
// tick — idkcraft-yvi), resume the owning mode, clear the fact. done =
// an escape worked; gave-up = budget spent, target stays dropped.
function release(bot, ctx, how) {
  const rec = ctx.recovery || {}
  const by = (ctx.stuck && ctx.stuck.by) || 'unknown'
  // Rest escalation (q0h): consecutive gave-ups in the rest step fail it, so
  // the goal arbiter reconsiders instead of spinning episodes in one pit. A
  // done episode is progress and clears the count; other steps never feed it.
  if (how === 'gave-up' && ctx.work && ctx.step === 'rest') {
    ctx.restGaveUps = (ctx.restGaveUps || 0) + 1
    if (ctx.restGaveUps >= REST_GAVE_UPS) {
      ctx.restGaveUps = 0
      try {
        const bp = botPos(bot)
        ctx.restGaveUpAt = bp ? { x: bp.x, y: bp.y, z: bp.z } : null
      } catch (_) { ctx.restGaveUpAt = null }
      ctx.restGaveUpCalled = false // fresh mark, fresh lapse
      ctx.stepStatus = 'failed:cannot-reach-home'
    }
    // One lapse per mark: a gave-up while marked and online consumes it —
    // whether the /tp chat landed or the player was out of entity range
    // (failed:no-player) — so the point then holds even online until
    // relocation instead of paging or spinning every episode.
    if (ctx.restGaveUpAt && anyPlayerOnline(bot)) ctx.restGaveUpCalled = true
  } else {
    ctx.restGaveUps = 0
    if (how === 'done') { ctx.restGaveUpAt = null; ctx.restGaveUpCalled = false }
  }
  try {
    if (bot.pathfinder && bot.pathfinder.goal && typeof bot.pathfinder.setGoal === 'function') {
      bot.pathfinder.setGoal(null)
    }
  } catch (_) { /* body best-effort */ }
  setJump(bot, false)
  if (by === 'lead' && ctx.lead) {
    // One escape episode per order: a still-stuck order gives up next, like
    // the old second nudge. A gave-up episode clears the order itself. The
    // stall counters restart so the resume gets a fresh give-up window.
    // nudgedAt marks real gain: only getting closer than the release point
    // earns fresh strikes (walking back to the wedge is not progress).
    ctx.lead.nudged = true
    try {
      const bp = botPos(bot)
      const t = ctx.lead.pos
      const atRelease = (bp && t) ? Math.round(Math.hypot(t.x - bp.x, t.y - bp.y, t.z - bp.z)) : null
      // The wedge point, not the release point, marks no-gain: a sidestep
      // away from the goal must not re-arm the budget on the walk back.
      const atWedge = ctx.lead.stallDist
      ctx.lead.nudgedAt = (atWedge != null && atRelease != null) ? Math.min(atWedge, atRelease)
        : (atWedge != null ? atWedge : atRelease)
    } catch (_) { ctx.lead.nudgedAt = null }
    ctx.lead.stuckTicks = 0
    ctx.lead.workTicks = 0
    if (how === 'gave-up') ctx.lead = null
  }
  if (by === 'gather' && ctx.gather) {
    // An escape may have moved the bot somewhere reachable: scan fresh.
    // On gave-up the step's failed:* final stands and the arbiter moves on.
    if (how !== 'gave-up') { ctx.gather.skip.clear(); ctx.gather.streak = 0 }
  }
  if (by === 'follow') ctx.followStalls = 0
  // The ticker latch anchors on gave-up only (rra round 2): a 'done' episode
  // may be a partial climb (REPEATS cap, single-shot climbers) that leaves
  // the body in the pit — latching that would end all further escape
  // attempts with no page. Progress clears the old anchor instead, so the
  // next trap gets a fresh episode.
  // Lead anchors like the other owned walks (6x7.2): without a latch the
  // central detector re-fires every slow threshold through a mining stall
  // (episodes reset both budgets) and the order never gives up. Anchored
  // like home/roam (the order goal is static), plus the no-gain mark: real
  // gain past it re-arms for a second, different wedge (M3, core-4).
  if (by === 'follow' || by === 'roam' || by === 'gather' || by === 'home' || by === 'lead' || (by === 'no-displacement' && how === 'gave-up')) {
    const sk = (ctx.stuck && ctx.stuck.key) || by
    const sg = ctx.stuck && ctx.stuck.goal
    ctx.recoverLatch = { by, key: sk, goal: sg ? { x: sg.x, y: sg.y, z: sg.z } : null }
    if (by === 'home' || by === 'roam' || by === 'no-displacement' || by === 'lead') {
      // Static goals never move, so goal-closeness cannot tell one wedge
      // from the next: anchor the release point instead. The stuck.js
      // COOLDOWN consult re-arms once the body relocated past the latch
      // radius (was walkHomeTick/roam-back/tickerLatched, rra round 1).
      const bp = botPos(bot)
      if (bp) ctx.recoverLatch.at = { x: bp.x, y: bp.y, z: bp.z }
      if (by === 'lead' && ctx.lead) ctx.recoverLatch.mark = ctx.lead.nudgedAt
    }
  } else if (by === 'no-displacement' && ctx.recoverLatch && ctx.recoverLatch.by === 'no-displacement') {
    ctx.recoverLatch = null
  }
  if (how === 'gave-up') {
    // Repeat page (rw4.9): gave up where a live mark already sits and
    // nobody is online — a resourceless pit is inescapable alone (prod
    // 2026-09-27 ground 3 dusks in one hole), so page the owner once per
    // mark; chat persists in the server log for the next session. Online
    // paging stays with the call_player menu item, and the rest step stays
    // with its own q0h escalation (gave-up hold + online lapse), which
    // already owns repeats there.
    try {
      const bp = botPos(bot)
      const restOwned = !!(ctx && ctx.work && ctx.step === 'rest')
      if (bp && !restOwned && !anyPlayerOnline(bot) && danger.near(ctx, bp) && !repeatPaged(ctx, bp)) {
        bot.chat(`I'm stuck at ${Math.floor(bp.x)} ${Math.floor(bp.y)} ${Math.floor(bp.z)} again with nobody online, /tp ${bot.username} <your-name>`)
        ctx.repeatGaveUpPage = { x: bp.x, y: bp.y, z: bp.z, at: Date.now() }
        console.log(`repeat gave-up at ${fmtPos(bp)}, owner paged`)
      }
    } catch (_) { /* paging best-effort */ }
    // Pit memory (mnx): the release point stays dangerous, so explore and
    // gather do not lead back into it. call_player ends here too
    // (endEpisode -> gave-up), same mark.
    try { danger.mark(ctx, botPos(bot)) } catch (_) { /* memory best-effort */ }
  }
  ctx.lastGoalKey = ''
  ctx.stuckResets = 0
  ctx.placeErrors = 0
  ctx.stuckTicks = 0
  ctx.groundedStills = 0
  ctx.stuck = null
  ctx.recovery = null
  // Terminal dones are already counted by decide() per finished primitive;
  // counting here too doubled outcome=done in prod (fja). gave-up is only
  // ever recorded here.
  if (how !== 'done') metrics.recover.inc({ action: rec.action || 'none', source: rec.source || 'fsm', outcome: how })
  logRecover(bot, ctx, rec.action || 'none', rec.source || 'fsm', how)
  return { action: 'idle', sprint: false, source: rec.source || 'fsm' }
}

// Decision point: entry (no episode) or a finished primitive. A running
// primitive keeps its action with no re-ask. Returns a BEHAVIOURS action
// (the primitive) or idle after release.
async function decide(bot, ctx, state, target) {
  const facts = recoverFacts(bot, ctx, state, target)
  const text = recoverText(facts)
  let rec = ctx.recovery
  if (rec && rec.status === 'running') {
    return { action: rec.action, sprint: false, source: rec.source }
  }
  if (!rec) {
    rec = ctx.recovery = { action: null, source: null, model: null, status: 'starting', st: null, attempts: 0, fails: 0, repeats: 0, last: null, calledPlayer: false, endEpisode: false, lastDy: null, lastY: null, flats: 0, placeError: (ctx.placeErrors || 0) > 0 }
    metrics.routes.inc({ route: 'hard', reason: 'stuck' })
    // Drop the stale goal first: a live GoalFollow/GoalNear keeps driving
    // the executor (jump/forward overrides at 20 Hz) and fights every
    // primitive except sidestep, which sets its own goal afterwards.
    try {
      if (bot.pathfinder && bot.pathfinder.goal && typeof bot.pathfinder.setGoal === 'function') {
        bot.pathfinder.setGoal(null)
      }
    } catch (_) { /* body best-effort */ }
  } else {
    // A primitive finished: record the outcome, then continue, re-ask, or
    // give up. Terminal states feed the next facts as last=<action>:<outcome>.
    const prev = rec.action
    const outcome = rec.status
    const source = rec.source || 'fsm'
    rec.last = { action: prev, outcome }
    if (outcome === 'failed:place-error') rec.placeError = true
    // The choice below must see the just-recorded outcome: facts was built
    // before it, so FSM escalation and the model-menu exclusion would both
    // read the previous last (4jr: the model repeated pillar_up live).
    facts.last = `${prev}:${outcome}`
    metrics.recover.inc({ action: prev, source, outcome: outcome === 'done' ? 'done' : outcome })
    // Failed primitives leave a log line, not just a metric (ak4): done
    // already logs through release(), failures never did.
    if (outcome !== 'done') logRecover(bot, ctx, prev, source, outcome)
    // A finished goal-owner (sidestep) leaves its GoalNear live, and the
    // next primitive's direct drive would fight the lib at 20 Hz (7gt:
    // revmux-01 found hop's instance) — decide() is the one choke point
    // between primitives, so the stale goal dies here. Chains are safe:
    // pillar/dig_up/dig_step set no goals (dig_step mounts direct since
    // jsf.4), and release() clears again anyway.
    try {
      if (bot.pathfinder && bot.pathfinder.goal && typeof bot.pathfinder.setGoal === 'function') {
        bot.pathfinder.setGoal(null)
      }
    } catch (_) { /* body best-effort */ }
    if (outcome === 'done') {
      if (rec.endEpisode || !(RECOVER_MENU[prev] && RECOVER_MENU[prev].repeatable)) {
        return release(bot, ctx, rec.endEpisode ? 'gave-up' : 'done')
      }
      const fresh = recoverFacts(bot, ctx, state, target)
      // Chain without re-asking only while making progress: toward the goal
      // (goalDy falling) with a goal, upward without one — goalDy stays 0
      // on the goal-less path, so the goal arm would stop a pit chain after
      // one repeat (revmux 01: every goal-less episode climbed at most 2
      // blocks). A done fires the tick the ack lands, often mid-air, so the
      // next cycle starts at the old floor and re-verifies it once before
      // the climb resumes (prod and mock alike): one flat twin chains free,
      // a second flat or a fell-back done ends the episode. REPEATS counts
      // risen dones, so a flat twin never eats the climb budget either way.
      let closer
      if (fresh.goalDist === null) {
        // Verified height, not live height: the verified block (the
        // cycle's startFloor) tracks the climb while live y samples the
        // mid-air arc. Primitives without a startFloor (dig_up) fall back
        // to the live floor.
        const st = rec.st
        const verifiedY = (st && typeof st.startFloor === 'number') ? st.startFloor : null
        const bp = botPos(bot)
        const feetY = verifiedY !== null ? verifiedY : (bp ? Math.floor(bp.y) : null)
        // == null: null on entry, undefined on hand-built ctx — both first.
        if (feetY !== null && (rec.lastY == null || feetY > rec.lastY)) {
          rec.lastY = feetY
          rec.flats = 0
          rec.repeats = (rec.repeats || 0) + 1
          closer = true
        } else if (feetY !== null && feetY === rec.lastY && (rec.flats || 0) < 1) {
          rec.flats = (rec.flats || 0) + 1
          closer = true
        } else {
          closer = false
        }
      } else {
        rec.repeats = (rec.repeats || 0) + 1
        closer = rec.lastDy === null || fresh.goalDy < rec.lastDy
      }
      if (closer && rec.repeats < REPEATS && RECOVER_MENU[prev].repeatable(fresh)) {
        rec.lastDy = fresh.goalDy
        rec.status = 'running'
        rec.st = null
        logRecover(bot, ctx, prev, source, 'continue')
        return { action: prev, sprint: false, source }
      }
      return release(bot, ctx, 'done')
    }
    rec.fails = (rec.fails || 0) + 1
    rec.repeats = 0
    if (rec.fails >= MAX_FAILS) {
      // Pilot budget spent: one call for help (when anyone can hear it),
      // then the goal is dropped. call_player runs through the normal
      // choice path so its chat and metric stay in one place.
      const names = RECOVER_ORDER.filter((n) => {
        try { return RECOVER_MENU[n].feasible(recoverFacts(bot, ctx, state, target), ctx) } catch (_) { return false }
      })
      // A just-failed call_player (nobody online to hear it) must not be
      // re-picked: feasibility stays true while calledPlayer is false, so
      // without this the episode loops 'chosen' forever. Falls through to
      // gave-up below instead.
      if (names.includes('call_player') && (!rec.last || rec.last.action !== 'call_player')) {
        rec.action = 'call_player'
        rec.source = 'fsm'
        rec.model = null
        rec.status = 'running'
        rec.st = null
        rec.attempts = (rec.attempts || 0) + 1
        metrics.recover.inc({ action: 'call_player', source: 'fsm', outcome: 'chosen' })
        logRecover(bot, ctx, 'call_player', 'fsm', 'chosen')
        return { action: 'call_player', sprint: false, source: 'fsm' }
      }
      return release(bot, ctx, 'gave-up')
    }
  }
  // Fresh choice: feasible menu through the smart model, FSM on failure.
  const names = RECOVER_ORDER.filter((n) => {
    try { return RECOVER_MENU[n].feasible(facts, ctx) } catch (_) { return false }
  })
  const choice = await chooseRecovery(ctx && ctx.brain, facts, names)
  rec.action = choice.action
  rec.source = choice.source
  rec.model = choice.model
  rec.status = 'running'
  rec.st = null
  rec.attempts = (rec.attempts || 0) + 1
  metrics.recover.inc({ action: choice.action, source: choice.source, outcome: 'chosen' })
  logRecover(bot, ctx, choice.action, choice.source, 'chosen', facts)
  if (choice.action !== 'call_player' && (!rec.last || rec.last.action !== choice.action)) {
    // rw4.9.1: repeats stay silent — a live mark underfoot means this pit
    // already had its stuck chat. Same spot/TTL as the repeat-page gate,
    // so the one page stands out instead of drowning. Episodes run as
    // before; only the narration gates.
    let marked = false
    try { marked = danger.near(ctx, botPos(bot)) } catch (_) { marked = false }
    if (!marked) {
      try { bot.chat(`stuck, trying ${RECOVER_MENU[choice.action].verb} (${choice.source})`) } catch (_) { /* chat best-effort */ }
    }
  }
  return { action: choice.action, sprint: false, source: choice.source }
}

// BEHAVIOURS entry: run one tick of the episode's primitive. The ticker
// dispatches here via applyDecision, so the decision line and the decisions
// metric work unchanged.
function run(bot, ctx) {
  const rec = ctx && ctx.recovery
  if (!rec || !rec.action || !RECOVER_MENU[rec.action]) return
  try {
    rec.status = RECOVER_MENU[rec.action].run(bot, ctx)
  } catch (_) {
    rec.status = 'failed:error'
  }
}

module.exports = {
  RECOVER_ORDER,
  RECOVER_MENU,
  RECOVER_INSTRUCTIONS,
  RECOVER_CRITERIA,
  MAX_FAILS,
  REPEATS,
  REST_GAVE_UPS,
  WAIT_TICKS,
  DISPLACE_TIMEOUT_TICKS,
  STUCK_TICKS_ENTRY,
  goalClose,
  recoverFacts,
  recoverText,
  recoverFsm,
  shapeRecoverMenu,
  chooseRecovery,
  setStuck,
  restGaveUpHolds,
  clearRelocatedRestMark,
  decide,
  release,
  run,
  pillarUpRun,
}
