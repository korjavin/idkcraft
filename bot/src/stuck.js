'use strict'

// Stuck detection (idkcraft-6x7.2): the ONLY body-stuck detector — a state
// machine owned end to end by this module: MOVING -> SUSPECT -> STUCK ->
// RECOVERING -> COOLDOWN. It owns every counter (stuckTicks, stuckResets,
// placeErrors), every body threshold and the release latch; behaviours keep
// only their TARGET give-up (skip/fail/refuse) and read this module's
// verdict() — they never count resets, never touch the latch. A behaviour
// may still ask for ONE escape attempt at its give-up moment through
// request() below (same choke point: attribution, logging, latch) — that is
// a target event (atl.17 stance, explore pit, M3 second strike), not body
// detection, and the only way a give-up reaches the menu.
// Thresholds: the old ticker backstop (STUCK_TICKS_ENTRY=30, canonical in
// recover.js for the recoverText buckets) plus a fast entry on path resets
// (2 'stuck' / 3 consecutive place_error) for the follow/roam-back wedges.
// Attribution (by/goal/key) derives from the live goal key, so release()
// keeps its per-owner branches with no behaviour cooperation.
const { goals } = require('mineflayer-pathfinder')
const recover = require('./behaviours/recover')

// The single displacement tolerance: every stall budget in every behaviour
// measures against this (was 8 copies of MOVE_TOLERANCE=0.5).
const MOVE_TOLERANCE = 0.5
// Fast entry: wedged-executor resets with no displacement (was the
// follow/roam-back wedge rule, inline 2).
const STUCK_RESETS_ENTRY = 2
// Fast entry: consecutive place_error resets with no displacement (was
// follow/gather PLACE_ERROR_STALLS and the dead recover PLACE_ERROR_ENTRY).
const PLACE_ERRORS_ENTRY = 3
// The single latch radius (was HOME_LATCH_CLEAR/ROAM_LATCH_CLEAR/
// TICKER_LATCH_CLEAR, three copies of 4): release anchors here, relocation
// past it re-arms.
const LATCH_CLEAR = 4

// Detector states. MOVING: displacing (or parked/at-goal/mid-plan).
// SUSPECT: still while the body should move, counting toward the entry.
// STUCK: fact raised, waiting for the recover route. RECOVERING: an episode
// (or a retreat pillar borrowing ctx.recovery) owns the body — hold.
// COOLDOWN: a release latch stands — hold until the situation changes
// (relocation past LATCH_CLEAR, a new pursuit key, a moved goal).
const STATES = ['MOVING', 'SUSPECT', 'STUCK', 'RECOVERING', 'COOLDOWN']

// Online-but-unseen ticks before walking back to world spawn (return-home):
// death+respawn at spawn, or walked out of entity range. Same 10-tick scale
// as the lead give-up. Spawn pre-arm uses blocks, not ticks (below).
const UNSEEN_HOME_TICKS = 10

// GoalNear range of the homing walk, and arrival radius for resuming work.
const RETURN_HOME_RANGE = 2

function bodyPos(bot) {
  try {
    const p = bot && bot.entity && bot.entity.position
    if (p && typeof p.x === 'number' && typeof p.z === 'number') return p
  } catch (_) { /* unknown body */ }
  return null
}

function movingNow(bot) {
  try {
    return !!(bot.pathfinder && typeof bot.pathfinder.isMoving === 'function' && bot.pathfinder.isMoving())
  } catch (_) { return false }
}

function horiz(a, b) {
  return Math.hypot(a.x - b.x, a.z - b.z)
}

// Progress from the anchor (ctx.lastPos): cumulative horizontal displacement
// past the tolerance, or a grounded level change. The anchor moves ONLY on
// progress (like the old follow/roam-back progress anchors), so slow but
// real movement (water, soul sand: 0.4/tick) accumulates instead of reading
// still every tick. Vertical progress un-breaks climbing: towering,
// step-ups and swim-ups land grounded at a new level and clear the reset
// streaks (core-2: horizontal-only sampling fast-entered wedges mid-climb
// on place_error streaks). Tower jumps in place still count as still: the
// apex is airborne (ignored) and the landing returns to the anchor level.
function progressed(bot, ctx, bp) {
  const last = ctx && ctx.lastPos
  if (!bp || !last) return false
  if (horiz(bp, last) > MOVE_TOLERANCE) return true
  return !!(groundedNow(bot) && typeof bp.y === 'number' && typeof last.y === 'number' &&
    Math.floor(bp.y) !== Math.floor(last.y))
}

function groundedNow(bot) {
  try {
    return !bot.entity || bot.entity.onGround !== false
  } catch (_) { return true }
}

// Still-tick maintenance for the fast gate: a 3D jump (apex-size move from
// the anchor that is not progress — the landing returns to the anchor, so
// only the apex trips this) re-arms the quiet window, otherwise it decays.
// Called on still ticks only — progress zeroes through zeroCounters.
function trackJump(bot, ctx, bp) {
  const last = ctx && ctx.lastPos
  const jumped = !!(bp && last && typeof bp.y === 'number' && typeof last.y === 'number' &&
    Math.hypot(bp.x - last.x, bp.y - last.y, bp.z - last.z) > MOVE_TOLERANCE)
  ctx.jumpCooldown = jumped ? JUMP_QUIET_TICKS : Math.max(0, (ctx.jumpCooldown || 0) - 1)
}

// Return-home: after UNSEEN_HOME_TICKS online-but-unseen ticks, walk to
// world spawn once (GoalNear keyed, so no re-issue) and keep standing
// there until someone is visible. Returns true while homing (caller skips
// stopOnce); pure stop otherwise. Fleeing still wins above.
// Detection-free since 6x7.2 (was its own 10-tick stall detector): the
// homing leg is a plain walk, the central update() below watches the body
// and raises by=home off the return-spawn key. Arrival/fact hygiene lives
// with the ticker (homeReached branches in index.js).
function walkHomeTick(bot, ctx) {
  // While the breath reflex owns the body the homing walk stands down:
  // re-issuing (and re-logging) a goal the reflex drops on the same
  // tick is pure spam (revmux 01 body-3). True = handled, no stopOnce.
  if (ctx.breath) return true
  if ((ctx.unseenTicks || 0) < UNSEEN_HOME_TICKS) return false
  const sp = bot.spawnPoint
  const bp = bodyPos(bot)
  if (!sp || !bp) return false
  const key = `return-spawn:${sp.x},${sp.y},${sp.z}`
  if (key !== ctx.lastGoalKey) {
    bot.pathfinder.setGoal(new goals.GoalNear(sp.x, sp.y, sp.z, RETURN_HOME_RANGE), false)
    ctx.lastGoalKey = key
    console.log(`returning to spawn dist=${Math.round(Math.hypot(bp.x - sp.x, bp.y - sp.y, bp.z - sp.z))}`)
  }
  return true
}

function homeReached(bot) {
  // The executor ends GoalNear on the floored block and stops at its
  // centre, up to ~2.5 blocks (float) from spawnPoint — agreeing with the
  // goal needs the +1.5 slack, not the raw range.
  const sp = bot.spawnPoint
  const bp = bot.entity && bot.entity.position
  return !!(sp && bp && Math.hypot(bp.x - sp.x, bp.y - sp.y, bp.z - sp.z) <= RETURN_HOME_RANGE + 1.5)
}

// Stillness fact for the stuck menu: consecutive ticks with no
// horizontal displacement while the executor claims to move. Progress
// clears a stale detector fact (but never a running episode).
// Backstop goal (q0h): the stuck menu needs the walk target — read the live
// pathfinder goal best-effort (the entity position, then the x/y/z snapshot).
function backstopGoal(bot) {
  try {
    const g = bot.pathfinder && bot.pathfinder.goal
    if (!g) return null
    const ep = g.entity && g.entity.position
    if (ep && typeof ep.x === 'number' && typeof ep.y === 'number' && typeof ep.z === 'number') {
      return { x: ep.x, y: ep.y, z: ep.z }
    }
    if (typeof g.x === 'number' && typeof g.y === 'number' && typeof g.z === 'number') {
      return { x: g.x, y: g.y, z: g.z }
    }
  } catch (_) { /* goal-less backstop */ }
  return null
}

// Idle-while-far probe (idkcraft-rra): a noPath verdict empties the
// executor, so moving reads false and the moving-only watch never counts —
// the trap stays silent forever. A live but unsatisfied goal with an idle
// executor counts the same stillness instead. Only the goal itself knows
// its radius, so satisfaction is asked of it; a goal without coordinates
// reads as no goal (conservative: no stuck).
function idleFarFromGoal(bot, bp) {
  let g = null
  try { g = bot.pathfinder && bot.pathfinder.goal } catch (_) { return false }
  if (!g) return false
  // Entity goals (GoalFollow) snapshot the target: hasChanged re-anchors
  // only past rangeSq, so the snapshot lags a walking player by up to the
  // range — while follow.js rests on the LIVE position. Measure live like
  // follow does, or a player who walked into range reads stuck against a
  // stale snapshot plus a stale noPath (revmux 01 major).
  try {
    const ep = g.entity && g.entity.position
    if (ep && typeof g.rangeSq === 'number' && bp &&
      typeof ep.x === 'number' && typeof ep.y === 'number' && typeof ep.z === 'number') {
      const dx = Math.floor(ep.x) - Math.floor(bp.x)
      const dy = Math.floor(ep.y) - Math.floor(bp.y)
      const dz = Math.floor(ep.z) - Math.floor(bp.z)
      return (dx * dx + dy * dy + dz * dz) > g.rangeSq
    }
  } catch (_) { /* fall through to isEnd */ }
  try {
    if (typeof g.isEnd === 'function') {
      const node = bp && typeof bp.floored === 'function'
        ? bp.floored()
        : { x: Math.floor(bp.x), y: Math.floor(bp.y), z: Math.floor(bp.z) }
      return !g.isEnd(node)
    }
  } catch (_) { /* fall through to the distance check */ }
  const gp = backstopGoal(bot)
  if (!gp || !bp) return false
  let d = null
  try { d = Math.hypot(bp.x - gp.x, bp.y - gp.y, bp.z - gp.z) } catch (_) { return false }
  return typeof d === 'number' && d > 3
}

// Owner attribution for a raise: the behaviour whose walk wedged, read off
// the live goal key (release() branches on it: lead nudges, gather clears
// skips, follow/roam/gather/home/lead anchor the latch). Stroll keys
// ('roam:x,y,z') attribute to roam for the latch but never fast-enter (p4s:
// a wedged stroll takes another point, the menu only gets a genuinely
// motionless body via the slow path). Anything unrecognised is the generic
// backstop.
function ownerOf(ctx) {
  const k = (ctx && ctx.lastGoalKey) || ''
  if (k.startsWith('follow:')) return 'follow'
  if (k.startsWith('roam-back:') || k.startsWith('roam:')) return 'roam'
  if (k.startsWith('lead:')) return 'lead'
  if (k.startsWith('gather')) return 'gather'
  if (k.startsWith('explore:')) return 'explore'
  if (k.startsWith('bring:')) return 'bring'
  if (k.startsWith('deep')) return 'deep'
  if (k.startsWith('return-spawn:')) return 'home'
  return 'no-displacement'
}

// Fast entry (reset streaks) replaces exactly the old reset-based detectors:
// follow and roam-back. Every other owner unifies on the slow threshold —
// gather owns its place_error streak for column skips (yvi), and a ticker
// place_error backstop is what p4s deleted.
function fastKey(ctx) {
  const k = (ctx && ctx.lastGoalKey) || ''
  return k.startsWith('follow:') || k.startsWith('roam-back:')
}

// The raise key is the live goal key for owned walks (same strings the old
// detectors carried: follow:X, lead:x,y,z, explore:x,z, deep-*, ...), so
// the setStuck latch scopes per situation; the generic backstop keeps the
// historical 'ticker' key the rra latch tests seed.
function raiseKey(ctx, by) {
  if (by !== 'no-displacement' && ctx && ctx.lastGoalKey) return ctx.lastGoalKey
  return 'ticker'
}

// Coord fallback for goals without an x/y/z snapshot (GoalXZ has no y, so
// the live-goal read is null for every explore leg): parse the key the walk
// issued. y falls back to the body level for the x,z-only explore key.
function keyCoords(ctx, bp) {
  try {
    const k = (ctx && ctx.lastGoalKey) || ''
    const m = /^(-?[0-9.]+),(-?[0-9.]+)(?:,(-?[0-9.]+))?$/.exec(k.slice(k.indexOf(':') + 1))
    if (!m) return null
    const nums = m.slice(1).filter((s) => s !== undefined).map(Number)
    if (nums.some((n) => !Number.isFinite(n))) return null
    if (nums.length === 3) return { x: nums[0], y: nums[1], z: nums[2] }
    if (nums.length === 2 && bp && typeof bp.y === 'number') return { x: nums[0], y: bp.y, z: nums[1] }
  } catch (_) { /* key-less goal */ }
  return null
}

function goalForRaise(bot, ctx, bp) {
  return backstopGoal(bot) || keyCoords(ctx, bp)
}

// Wedge-line diagnostics (moved from follow.js/roam.js verbatim — formats
// frozen): feet/head/next block names so the next prod trap names its edge.
// Positions must stay Vec3: real blockAt calls pos.floored() and throws on
// plain {x,y,z}. Guarded: mocks and unloaded cells read '?'.
function blockNameAt(bot, p) {
  try {
    const b = p && typeof p.floored === 'function' && bot.blockAt && bot.blockAt(p)
    return (b && b.name) || '?'
  } catch (_) { return '?' }
}

function formatPos(p) {
  if (!p) return 'unknown'
  const fx = typeof p.x === 'number' ? (Number.isInteger(p.x) ? p.x : p.x.toFixed(1)) : '0'
  const fy = typeof p.y === 'number' ? (Number.isInteger(p.y) ? p.y : p.y.toFixed(1)) : '0'
  const fz = typeof p.z === 'number' ? (Number.isInteger(p.z) ? p.z : p.z.toFixed(1)) : '0'
  return `${fx},${fy},${fz}`
}

// Raise lines, one per owner that ever printed one (byte-identical to the
// old detectors): follow/roam/home wedge lines, the lead nudge line. All
// other owners raised silently and still do.
function logRaise(bot, ctx, bp, by, goal) {
  try {
    if (by === 'follow') {
      const dist = goal && bp ? Math.hypot(bp.x - goal.x, bp.y - goal.y, bp.z - goal.z).toFixed(1) : 'none'
      const feetP = bp && typeof bp.floored === 'function' ? bp.floored() : null
      const headP = feetP && typeof feetP.offset === 'function' ? feetP.offset(0, 1, 0) : null
      const next = ctx.lastPathNext
      const nextStr = next ? `${next.x},${next.y},${next.z}:${blockNameAt(bot, next)}` : '?:?'
      console.log(`stuck reason=wedge pos=${formatPos(bp)} dist=${dist} feet=${blockNameAt(bot, feetP)} head=${blockNameAt(bot, headP)} next=${nextStr}`)
    } else if (by === 'roam') {
      const dist = goal && bp ? Math.hypot(bp.x - goal.x, bp.y - goal.y, bp.z - goal.z).toFixed(1) : 'none'
      console.log(`stuck reason=wedge pos=${formatPos(bp)} dist=${dist} goal=${formatPos(goal)}`)
    } else if (by === 'home') {
      const dist = goal && bp ? Math.hypot(bp.x - goal.x, bp.y - goal.y, bp.z - goal.z).toFixed(1) : 'none'
      console.log(`stuck reason=wedge pos=${formatPos(bp)} dist=${dist}`)
    } else if (by === 'lead') {
      const rx = bp ? Math.round(bp.x) : '?'
      const ry = bp ? Math.round(bp.y) : '?'
      const rz = bp ? Math.round(bp.z) : '?'
      console.log(`stuck reason=nudge pos=${rx},${ry},${rz}`)
    }
  } catch (_) { /* logging never breaks detection */ }
}

// The single raise path (was ~10 setStuck call sites plus the ticker's
// direct ctx.stuck assignment, which bypassed the setStuck latch). Through
// setStuck, so the latch semantics hold for every owner including the
// generic backstop. True when the fact stuck.
function raise(bot, ctx, bp) {
  const by = ownerOf(ctx)
  const goal = goalForRaise(bot, ctx, bp)
  const key = raiseKey(ctx, by)
  return fire(bot, ctx, bp, by, goal, key)
}

function fire(bot, ctx, bp, by, goal, key) {
  let ok = false
  try { ok = recover.setStuck(ctx, by, goal, key) } catch (_) { ok = false }
  if (ok) logRaise(bot, ctx, bp, by, goal)
  return ok
}

// One-shot escape request: the ONLY way a behaviour give-up reaches the
// menu (core-3/core-1: deleting the give-up raises stranded bots — explore
// pits cycle targets forever, deep shaft-stucks and gather trunk wedges get
// no episode, bring below-feet refuses a diggable block). Same choke point
// as the central raise (setStuck latch, raise lines, STUCK state); the
// trigger is a TARGET event, never body detection — no counters consulted,
// no exemptions (the old give-up raises were ungated too). True when the
// fact stuck; false when an episode already runs, the fact is set, or the
// latch holds the same situation (then the caller gives up — bounded).
function request(bot, ctx, by, goal, key) {
  if (!ctx) return false
  const ok = fire(bot, ctx, bodyPos(bot), by, goal, key)
  if (ok) ctx.stuckState = 'STUCK'
  return ok
}

// COOLDOWN consult: is the release latch stale (re-arm) or standing (hold)?
// At-anchored latches (home/roam/ticker/lead) clear on relocation past the
// radius; real-key at-latches also clear on a new pursuit (was follow.js's
// preserve-ticker-drop-others rule), while the synthetic 'ticker' key is
// sticky across pursuits by design (rra: one episode per trap). Goal
// latches (follow/gather) clear on a new pursuit key or a moved goal (was
// setStuck's raise-time goalClose, now consulted every tick). The lead latch
// additionally re-arms on real gain past its mark (M3, core-4): closer to
// the ore than the no-gain point means a new wedge, not the same trap.
function latchStale(ctx, bot, bp) {
  const L = ctx && ctx.recoverLatch
  if (!L || typeof L !== 'object') return true
  try {
    const cur = (ctx && ctx.lastGoalKey) || ''
    const realKey = cur !== '' && cur !== 'idle'
    if (!L.at) {
      if (L.key && realKey && cur !== L.key) return true
      if (L.goal) {
        const g = backstopGoal(bot)
        if (g && !recover.goalClose(L.goal, g)) return true
      }
      return false
    }
    if (L.key && L.key !== 'ticker' && realKey && cur !== L.key) return true
    if (L.by === 'lead' && L.mark != null && ctx.lead && ctx.lead.pos && bp) {
      // 3D, like blocksLeft/nudgedAt (round 2): the mark is a 3D distance,
      // and horizontal is never larger — a 2D read goes stale on the first
      // tick for any ore above or below the bot and loops episodes forever.
      const op = ctx.lead.pos
      const xyz = op && typeof op.x === 'number' && typeof op.y === 'number' && typeof op.z === 'number'
      if (xyz && Math.round(Math.hypot(bp.x - op.x, bp.y - op.y, bp.z - op.z)) < L.mark) return true
    }
    if (L.at && typeof L.at.x === 'number' && bp) {
      if (horiz(bp, L.at) > LATCH_CLEAR) return true
    }
    return false
  } catch (_) { return false }
}

// Raise exemptions (gates, not states — counting continues underneath, as
// the old backstop did; the raise waits for the exemption to lift).
// Gohome/stay own their approach stalls (rw4.5): walkTo re-issues and fails
// the step itself (cannot-reach-home) — a backstop here sidesteps the body
// mid-doorway every slow approach and the arrival starves into an orbit.
// The come-home meet owns its own the same way (jr2.3). The rest gave-up
// hold (q0h) owns repeats at its marked point.
function raiseExempt(ctx, bot) {
  const nightOwns = (ctx.work && (ctx.step === 'gohome' || ctx.step === 'stay')) || !!ctx.comehome
  if (nightOwns) return true
  try {
    if (recover.restGaveUpHolds(ctx, bot)) return true
  } catch (_) { /* hold best-effort */ }
  return false
}

function zeroCounters(ctx) {
  ctx.stuckTicks = 0
  ctx.stuckResets = 0
  ctx.placeErrors = 0
  ctx.jumpCooldown = 0
}

// Still ticks after a 3D jump during which the fast entry holds fire
// (core-2 follow-up): tower attempts apex every jump, so a streak alone
// must not wedge mid-jump-cycle — master cleared the streaks on every 3D
// jump instead. Genuine ground wedges (no jumps) pass immediately. Small
// oscillations (water bobbing ±0.3) are not jumps, so a bobbing pit still
// fires like master (S6-PIT); jump-spam pits fall through to the slow
// entry at 30, exactly like master's ticker backstop.
const JUMP_QUIET_TICKS = 4

// Read-only verdict for behaviours: the ONLY stuck state they may consult
// (target give-up reads stills/resets/placeErrors/episode; the counters
// themselves are written here alone). Fresh object per call, no aliasing.
function verdict(ctx) {
  return {
    state: (ctx && ctx.stuckState) || 'MOVING',
    stills: (ctx && ctx.stuckTicks) || 0,
    resets: (ctx && ctx.stuckResets) || 0,
    placeErrors: (ctx && ctx.placeErrors) || 0,
    episode: !!(ctx && (ctx.stuck || ctx.recovery)),
    latched: !!(ctx && ctx.recoverLatch),
  }
}

// The tick: sample displacement, advance the machine, raise at most once.
// Called from both ticker branches (target path and the nobody-online idle
// branch, where the homing walk wedges); paused ticks never sample.
// ctx.lastPos is the progress anchor: it moves ONLY on progress (never on
// still ticks), so slow movement accumulates and climbing breaks streaks.
function update(bot, ctx) {
  if (!ctx || ctx.paused) return
  const bp = bodyPos(bot)
  const moving = movingNow(bot)
  const anchor = () => { if (bp) ctx.lastPos = { x: bp.x, y: bp.y, z: bp.z } }
  // An episode (or a retreat pillar borrowing ctx.recovery) owns the body:
  // hold, keep the anchor fresh so the release samples from the freed body.
  if (ctx.recovery) {
    ctx.stuckState = 'RECOVERING'
    anchor()
    return
  }
  // A raised fact waits for the route (urgent fight, idle cost guard):
  // hold it, but progress still clears a stale fact — the body moved, the
  // situation is gone. Never under a running episode (set above). The
  // anchor holds while waiting, so a slow crawl still accumulates out.
  if (ctx.stuck) {
    if (progressed(bot, ctx, bp)) {
      ctx.stuck = null
      zeroCounters(ctx)
      ctx.stuckState = 'MOVING'
      anchor()
    } else {
      ctx.stuckState = 'STUCK'
      trackJump(bot, ctx, bp)
    }
    return
  }
  // A release latch holds new episodes until the situation changes; a
  // stale latch clears and the tick falls through to counting below.
  // Progress while latched still zeroes the streaks (core-5): resets keep
  // arriving while the body walks normally, and must not fire a fast wedge
  // on the tick the latch goes stale.
  if (ctx.recoverLatch) {
    if (latchStale(ctx, bot, bp)) ctx.recoverLatch = null
    else {
      ctx.stuckState = 'COOLDOWN'
      if (progressed(bot, ctx, bp)) {
        zeroCounters(ctx)
        anchor()
      } else {
        trackJump(bot, ctx, bp)
      }
      if (ctx.restGaveUpAt) {
        try { recover.clearRelocatedRestMark(ctx, bot) } catch (_) { /* mark best-effort */ }
      }
      return
    }
  }
  // First sample (or bodiless tick): anchor only, never count — a seeded
  // counter survives the anchor tick and trips on the first real still.
  if (!bp || !ctx.lastPos) {
    anchor()
    if (!ctx.stuckState) ctx.stuckState = 'MOVING'
    return
  }
  if (progressed(bot, ctx, bp)) {
    // Progress clears everything: the still streak and both reset streaks
    // (was the follow/roam/gather displacement clears, now one place).
    zeroCounters(ctx)
    ctx.stuckState = 'MOVING'
    anchor()
  } else {
    // Still — the anchor holds, so the next tick measures from the same
    // point and slow movement accumulates out. Counting needs a body that
    // should move: a driving executor, or an idle one against a live
    // unsatisfied goal after a terminal planner verdict (rra).
    // Parked/at-goal/mid-plan stillness resets.
    const terminal = ctx.lastPathStatus === 'noPath' || ctx.lastPathStatus === 'timeout'
    const shouldCount = moving || (!moving && terminal && idleFarFromGoal(bot, bp))
    trackJump(bot, ctx, bp)
    if (!shouldCount) {
      ctx.stuckTicks = 0
      ctx.stuckState = 'MOVING'
    } else {
      ctx.stuckTicks = (ctx.stuckTicks || 0) + 1
      ctx.stuckState = 'SUSPECT'
      if (!raiseExempt(ctx, bot)) {
        const fast = moving && fastKey(ctx) && (ctx.jumpCooldown || 0) <= 0 &&
          ((ctx.stuckResets || 0) >= STUCK_RESETS_ENTRY || (ctx.placeErrors || 0) >= PLACE_ERRORS_ENTRY)
        const slow = (ctx.stuckTicks || 0) >= recover.STUCK_TICKS_ENTRY
        if (fast || slow) {
          ctx.stuckState = raise(bot, ctx, bp) ? 'STUCK' : 'SUSPECT'
        }
      }
    }
  }
  // A clean relocation (a /tp out) ends the rest gave-up hold even when no
  // detector fires to consult the gate (core-1 follow-up).
  if (ctx.restGaveUpAt) {
    try { recover.clearRelocatedRestMark(ctx, bot) } catch (_) { /* mark best-effort */ }
  }
}

// A stale stuck fact must not survive a mode change: the goal it names
// belongs to the previous order.
function clearStuck(ctx) {
  // ponytail: an order preempting a running water_up drops its poured
  // sources with it (the strip only runs from ctx.recovery.st) — the water
  // stays and the buckets read lost until gear refills them (jsf.5). A later
  // strip cannot adopt them: scooping needs 4.4 reach and the body already
  // left. Logged so prod shows the loss instead of hiding it.
  try {
    const rec = ctx.recovery
    if (rec && rec.action === 'water_up' && rec.st && rec.st.sources && rec.st.sources.length > 0) {
      console.log(`recover action=water_up outcome=dropped phase=${rec.st.phase || '?'} sources=${rec.st.sources.length} reason=order`)
    }
  } catch (_) { /* log best-effort */ }
  ctx.stuck = null
  ctx.recovery = null
  ctx.stuckTicks = 0
  ctx.stuckResets = 0
  ctx.placeErrors = 0
  ctx.jumpCooldown = 0
  ctx.stuckState = 'MOVING'
  ctx.recoverLatch = null
  ctx.retreat = null // orders end a retreat episode like any other step
}

// place_error streaks (tower attempts into the same cell while a previous
// placeBlock still awaits blockUpdate): consecutive only — any other
// reset reason breaks the streak. The 'stuck' streak instead survives
// across resets until displacement (a wedged executor replans identically
// for minutes); episodes and orders clear both.
function countPathReset(ctx, reason) {
  ctx.lastPathReset = reason || null
  if (reason === 'stuck') ctx.stuckResets = (ctx.stuckResets || 0) + 1
  if (reason === 'place_error') ctx.placeErrors = (ctx.placeErrors || 0) + 1
  else ctx.placeErrors = 0
}

module.exports = {
  STATES,
  MOVE_TOLERANCE,
  STUCK_RESETS_ENTRY,
  PLACE_ERRORS_ENTRY,
  LATCH_CLEAR,
  UNSEEN_HOME_TICKS,
  RETURN_HOME_RANGE,
  ownerOf,
  backstopGoal,
  idleFarFromGoal,
  verdict,
  request,
  update,
  clearStuck,
  walkHomeTick,
  homeReached,
  countPathReset,
}
