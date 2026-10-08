'use strict'

// The ONLY body-stuck detector (idkcraft-6x7.2): MOVING -> SUSPECT -> STUCK
// -> RECOVERING -> COOLDOWN. It owns the counters (stuckTicks, stuckResets,
// placeErrors), the thresholds and the release latch. Behaviours keep only
// their TARGET give-up and read verdict(); a give-up may ask for one escape
// through request() (same choke point: attribution, logging, latch).
// Entries: the slow STUCK_TICKS_ENTRY (canonical in recover.js) plus a fast
// one on path-reset streaks for the follow/roam-back wedges. Attribution
// (by/key) derives from the live goal key.
const { goals } = require('mineflayer-pathfinder')
const recover = require('./behaviours/recover')

const MOVE_TOLERANCE = 0.5 // the single displacement tolerance, every stall budget
const STUCK_RESETS_ENTRY = 2 // fast entry: 'stuck' resets with no displacement
const PLACE_ERRORS_ENTRY = 3 // fast entry: consecutive place_error resets
// Sustained tower spam (vmzq.47): consecutive place_error resets with no
// progress are active failing, not parked idleness — a parked executor
// plans no resets. Past this the fast entry fires through the jump quiet
// (a healthy tower climbs and zeroes the streak via progressed(); only a
// refused spin survives 10 resets), the moving gate (a refused tower never
// displaces) and the follow/roam key gate (work legs tower too). Normal
// mid-cycle resets (1-2 per jump) never reach it.
const PLACE_SPAM_ENTRY = 10
// Dig hold (uqhp): still ticks while the executor works a planned dig
// (bot.targetDigBlock set) before the slow count resumes. Barehand granite
// runs ~8 s a block and multi-block legs pass 30 stills with zero
// displacement (CLUSTER-BARE: 7 barehand cells, ~54 s of digging per green
// run) — a wedge mid-dig kills the dig (the episode clears the goal and
// break progress resets), walks away, pages, and re-digs from scratch.
// 2x the slow entry: measured legs run <= ~25 s of digging, so the hold
// covers any working leg while a pathological dig (unbreakable target,
// endless flail) still wedges one minute late, not never.
const DIG_STILLS_CAP = 60
// Buried fast entry (idkcraft-vmzq.42): consecutive flail stills while
// buried with no working path (recover.buriedFlail) before the detector
// raises. Pocket digs feed the hold and shuffles reset it, so without
// this the buried body flails for minutes; working legs read a success
// path and never accrue here.
const BURIED_STILLS_ENTRY = 15
// Horizontal progress bar while buriedFlail: pocket shuffles stay inside
// it (no reset), a real walk leaves it (resets like before).
const BURIED_PROGRESS_DIST = 3
const LATCH_CLEAR = 4 // release-latch radius: relocation past it re-arms
// Still ticks after a 3D jump during which the fast entry holds fire: tower
// attempts apex every jump, so a reset streak alone must not wedge
// mid-jump-cycle. Ground wedges (no jumps) fire at once; bobbing (±0.3) is
// not a jump (S6-PIT); jump-spam pits fall to the slow entry.
const JUMP_QUIET_TICKS = 4
// Online-but-unseen ticks before walking back to world spawn (return-home).
const UNSEEN_HOME_TICKS = 10
const RETURN_HOME_RANGE = 2 // GoalNear range of the homing walk

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

// Active lib dig (uqhp): bot.targetDigBlock is the block mineflayer is
// currently breaking (the executor sets it for plan toBreak digs; behaviour
// bot.dig calls set it too). Mocks and pre-dig ticks read nothing —
// fail-open counts as before, so digging is never assumed.
function diggingNow(bot) {
  try {
    return !!(bot && bot.targetDigBlock)
  } catch (_) { return false }
}

function horiz(a, b) {
  return Math.hypot(a.x - b.x, a.z - b.z)
}

function groundedNow(bot) {
  try {
    return !bot.entity || bot.entity.onGround !== false
  } catch (_) { return true }
}

// Progress from the anchor (ctx.lastPos, moved ONLY on progress, so slow
// movement accumulates): horizontal displacement past the tolerance, or a
// grounded level change (climbing clears the reset streaks, core-2). Tower
// jumps in place stay still: the apex is airborne, the landing returns.
function progressed(bot, ctx, bp) {
  const last = ctx && ctx.lastPos
  if (!bp || !last) return false
  if (horiz(bp, last) > MOVE_TOLERANCE) {
    // Buried with no working path (vmzq.42): pocket shuffles are flail,
    // not progress — only leaving the pocket past the buried bar counts,
    // and a climb/descent still counts via the floor check below. The scan
    // runs only on would-be-progress ticks, so healthy ticks cost nothing
    // further; working legs read a success path and keep the old bar.
    if (!recover.buriedFlail(bot, ctx)) return true
    if (horiz(bp, last) > BURIED_PROGRESS_DIST) return true
  }
  return !!(groundedNow(bot) && typeof bp.y === 'number' && typeof last.y === 'number' &&
    Math.floor(bp.y) !== Math.floor(last.y))
}

// Still ticks only: an apex-size 3D move from the anchor re-arms the jump
// quiet window, otherwise it decays.
function trackJump(bot, ctx, bp) {
  const last = ctx && ctx.lastPos
  const jumped = !!(bp && last && typeof bp.y === 'number' && typeof last.y === 'number' &&
    Math.hypot(bp.x - last.x, bp.y - last.y, bp.z - last.z) > MOVE_TOLERANCE)
  ctx.jumpCooldown = jumped ? JUMP_QUIET_TICKS : Math.max(0, (ctx.jumpCooldown || 0) - 1)
}

// Return-home: after UNSEEN_HOME_TICKS online-but-unseen ticks, walk to
// world spawn once (keyed, no re-issue). True while homing (caller skips
// stopOnce). A plain walk: update() raises by=home off the return-spawn key.
function walkHomeTick(bot, ctx) {
  // The breath reflex owns the body: re-issuing a goal it drops is spam.
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
  // GoalNear ends on the floored block's centre, up to ~2.5 from
  // spawnPoint: agreeing with the goal needs +1.5 slack.
  const sp = bot.spawnPoint
  const bp = bot.entity && bot.entity.position
  return !!(sp && bp && Math.hypot(bp.x - sp.x, bp.y - sp.y, bp.z - sp.z) <= RETURN_HOME_RANGE + 1.5)
}

// The live pathfinder goal's coords (q0h), best-effort: entity, then x/y/z.
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

// Idle-while-far (rra): a noPath verdict empties the executor, so a live
// but unsatisfied goal with an idle executor counts as stillness too. The
// goal knows its own radius; a goal without coordinates reads as none.
function idleFarFromGoal(bot, bp) {
  let g = null
  try { g = bot.pathfinder && bot.pathfinder.goal } catch (_) { return false }
  if (!g) return false
  // Entity goals: measure the LIVE position like follow does — the
  // GoalFollow snapshot lags a walking player by up to the range.
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

// Raise attribution off the live goal key (release() branches on it).
// Stroll keys ('roam:') attribute to roam but never fast-enter (p4s).
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

// Fast entry only for the old reset-based detectors: follow and roam-back.
function fastKey(ctx) {
  const k = (ctx && ctx.lastGoalKey) || ''
  return k.startsWith('follow:') || k.startsWith('roam-back:')
}

// Coords parsed from the walk's key, for goals without an x/y/z snapshot
// (GoalXZ: explore legs). y falls back to the body level for x,z keys.
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

// Wedge-line block names. Positions must stay Vec3 (real blockAt calls
// pos.floored()); mocks and unloaded cells read '?'.
function blockNameAt(bot, p) {
  try {
    const b = p && typeof p.floored === 'function' && bot.blockAt && bot.blockAt(p)
    return (b && b.name) || '?'
  } catch (_) { return '?' }
}

function formatPos(p) {
  if (!p) return 'unknown'
  const f = (v) => typeof v === 'number' ? (Number.isInteger(v) ? v : v.toFixed(1)) : '0'
  return `${f(p.x)},${f(p.y)},${f(p.z)}`
}

// Raise lines (formats frozen, byte-identical to the old detectors):
// follow/roam/home wedge lines, the lead nudge line; other owners are silent.
function logRaise(bot, ctx, bp, by, goal) {
  try {
    const dist = () => goal && bp ? Math.hypot(bp.x - goal.x, bp.y - goal.y, bp.z - goal.z).toFixed(1) : 'none'
    if (by === 'follow') {
      const feetP = bp && typeof bp.floored === 'function' ? bp.floored() : null
      const headP = feetP && typeof feetP.offset === 'function' ? feetP.offset(0, 1, 0) : null
      const next = ctx.lastPathNext
      const nextStr = next ? `${next.x},${next.y},${next.z}:${blockNameAt(bot, next)}` : '?:?'
      console.log(`stuck reason=wedge pos=${formatPos(bp)} dist=${dist()} feet=${blockNameAt(bot, feetP)} head=${blockNameAt(bot, headP)} next=${nextStr}`)
    } else if (by === 'roam') {
      console.log(`stuck reason=wedge pos=${formatPos(bp)} dist=${dist()} goal=${formatPos(goal)}`)
    } else if (by === 'home') {
      console.log(`stuck reason=wedge pos=${formatPos(bp)} dist=${dist()}`)
    } else if (by === 'lead') {
      const r = (v) => bp ? Math.round(v) : '?'
      console.log(`stuck reason=nudge pos=${r(bp && bp.x)},${r(bp && bp.y)},${r(bp && bp.z)}`)
    }
  } catch (_) { /* logging never breaks detection */ }
}

// The single raise path, through setStuck so its latch holds for every
// owner. True when the fact stuck.
function fire(bot, ctx, bp, by, goal, key) {
  let ok = false
  try { ok = recover.setStuck(ctx, by, goal, key) } catch (_) { ok = false }
  if (ok) logRaise(bot, ctx, bp, by, goal)
  return ok
}

// Central raise: owned walks key on the live goal key so the latch scopes
// per situation; the generic backstop keeps the historical 'ticker' key.
function raise(bot, ctx, bp) {
  const by = ownerOf(ctx)
  const key = by !== 'no-displacement' && ctx.lastGoalKey ? ctx.lastGoalKey : 'ticker'
  return fire(bot, ctx, bp, by, backstopGoal(bot) || keyCoords(ctx, bp), key)
}

// One-shot escape request: the ONLY way a behaviour give-up reaches the
// menu (core-1/core-3: explore pits, deep steps, gather trunks, bring
// below-feet, lead first strike). A TARGET event: no counters, no
// exemptions. False when an episode runs, the fact is set, or the latch
// holds the same situation — then the caller gives up (bounded).
function request(bot, ctx, by, goal, key) {
  if (!ctx) return false
  const ok = fire(bot, ctx, bodyPos(bot), by, goal, key)
  if (ok) ctx.stuckState = 'STUCK'
  return ok
}

// COOLDOWN consult: is the release latch stale (re-arm) or standing?
// At-anchored latches (home/roam/ticker/lead) clear on relocation past
// LATCH_CLEAR, and real keys also on a new pursuit ('ticker' is sticky
// across pursuits, rra: one episode per trap). Goal latches (follow/gather)
// clear on a new pursuit key or a moved goal. The lead latch also re-arms
// on 3D gain past its no-gain mark (M3, core-4).
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

// Raise gates (counting continues underneath): gohome/stay/shelter and the
// come-home meet own their own stalls (rw4.5, jr2.3, ipn.12); the rest
// gave-up hold (q0h) owns repeats at its marked point.
function raiseExempt(ctx, bot) {
  if ((ctx.work && (ctx.step === 'gohome' || ctx.step === 'stay' || ctx.step === 'shelter')) || ctx.comehome || ctx.gocastle) return true
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
  ctx.digStills = 0
  ctx.buriedStills = 0
}

// Read-only verdict: the ONLY stuck state behaviours may consult.
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

function clearRestMark(ctx, bot) {
  if (ctx.restGaveUpAt) {
    try { recover.clearRelocatedRestMark(ctx, bot) } catch (_) { /* mark best-effort */ }
  }
}

// The tick (both ticker branches; paused ticks never sample): sample
// displacement, advance the machine, raise at most once.
function update(bot, ctx) {
  if (!ctx || ctx.paused) return
  const bp = bodyPos(bot)
  // Bans and page stamps are situation state: observe every tick, not just
  // at episode boundaries, so a /tp rescue (or plain walk) with no episode
  // in between still re-arms (revmux 03 core-1). At episode boundaries
  // decide() resets identically; only non-episode movement is newly seen.
  try { recover.resetRecoverStreaksIfMoved(ctx, bp) } catch (_) { /* anchor best-effort */ }
  const moving = movingNow(bot)
  const anchor = () => { if (bp) ctx.lastPos = { x: bp.x, y: bp.y, z: bp.z } }
  // An episode (or a retreat pillar borrowing ctx.recovery) owns the body;
  // keep the anchor fresh so the release samples from the freed body.
  if (ctx.recovery) {
    ctx.stuckState = 'RECOVERING'
    anchor()
    return
  }
  // A raised fact waits for its route; progress clears a stale fact.
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
  // A standing latch holds new episodes; progress still zeroes the streaks
  // (core-5) so they cannot fast-fire the tick it goes stale.
  if (ctx.recoverLatch) {
    if (latchStale(ctx, bot, bp)) ctx.recoverLatch = null
    else {
      ctx.stuckState = 'COOLDOWN'
      ctx.buriedStills = 0 // latched situations never raise: no stale streak survives them
      if (progressed(bot, ctx, bp)) {
        zeroCounters(ctx)
        anchor()
      } else {
        trackJump(bot, ctx, bp)
      }
      clearRestMark(ctx, bot)
      return
    }
  }
  // First sample (or bodiless tick): anchor only, never count.
  if (!bp || !ctx.lastPos) {
    anchor()
    if (!ctx.stuckState) ctx.stuckState = 'MOVING'
    return
  }
  if (progressed(bot, ctx, bp)) {
    zeroCounters(ctx)
    ctx.stuckState = 'MOVING'
    anchor()
  } else {
    // Still: counting needs a body that should move — a driving executor,
    // or an idle one against a live unsatisfied goal after a terminal
    // planner verdict (rra). Parked/at-goal/mid-plan stillness resets.
    const terminal = ctx.lastPathStatus === 'noPath' || ctx.lastPathStatus === 'timeout'
    const spam = (ctx.placeErrors || 0) >= PLACE_SPAM_ENTRY
    const shouldCount = moving || (terminal && idleFarFromGoal(bot, bp)) || spam
    trackJump(bot, ctx, bp)
    if (!shouldCount) {
      ctx.stuckTicks = 0
      ctx.stuckState = 'MOVING'
    } else {
      // Dig hold (uqhp): an active dig is work, not stuck — stills accrue on
      // a separate budget instead of the slow count, so a working multi-block
      // dig never wedges mid-dig (the episode would clear the goal and break
      // progress resets). The fast entry still consults below: lib complaints
      // wedge even mid-dig, and past the cap the slow count resumes.
      if (diggingNow(bot) && (ctx.digStills || 0) < DIG_STILLS_CAP) ctx.digStills = (ctx.digStills || 0) + 1
      else ctx.stuckTicks = (ctx.stuckTicks || 0) + 1
      // Buried fast streak (vmzq.42): a flail tick accrues here too, so the
      // raise below beats the dig hold instead of waiting it out. Progress
      // zeroes via zeroCounters; any non-flail tick restarts the streak.
      if (recover.buriedFlail(bot, ctx)) ctx.buriedStills = (ctx.buriedStills || 0) + 1
      else ctx.buriedStills = 0
      ctx.stuckState = 'SUSPECT'
      if (!raiseExempt(ctx, bot)) {
        const fast = (moving && fastKey(ctx) && (ctx.jumpCooldown || 0) <= 0 &&
          ((ctx.stuckResets || 0) >= STUCK_RESETS_ENTRY || (ctx.placeErrors || 0) >= PLACE_ERRORS_ENTRY)) || spam ||
          (ctx.buriedStills || 0) >= BURIED_STILLS_ENTRY
        if (fast || ctx.stuckTicks >= recover.STUCK_TICKS_ENTRY) {
          ctx.stuckState = raise(bot, ctx, bp) ? 'STUCK' : 'SUSPECT'
        }
      }
    }
  }
  // A clean relocation (a /tp out) ends the rest gave-up hold (core-1).
  clearRestMark(ctx, bot)
}

// A stale stuck fact must not survive a mode change: its goal belongs to
// the previous order.
function clearStuck(ctx) {
  // ponytail: an order preempting a running water_up drops its poured
  // sources (the strip only runs from ctx.recovery.st) — the buckets read
  // lost until gear refills them (jsf.5); logged so prod shows the loss.
  try {
    const rec = ctx.recovery
    if (rec && rec.action === 'water_up' && rec.st && rec.st.sources && rec.st.sources.length > 0) {
      console.log(`recover action=water_up outcome=dropped phase=${rec.st.phase || '?'} sources=${rec.st.sources.length} reason=order`)
    }
  } catch (_) { /* log best-effort */ }
  ctx.stuck = null
  ctx.recovery = null
  zeroCounters(ctx)
  ctx.stuckState = 'MOVING'
  ctx.recoverLatch = null
  ctx.retreat = null // orders end a retreat episode like any other step
}

// place_error streaks are consecutive only (any other reset breaks them);
// the 'stuck' streak survives until displacement. Episodes/orders clear both.
function countPathReset(ctx, reason) {
  ctx.lastPathReset = reason || null
  if (reason === 'stuck') ctx.stuckResets = (ctx.stuckResets || 0) + 1
  if (reason === 'place_error') ctx.placeErrors = (ctx.placeErrors || 0) + 1
  else ctx.placeErrors = 0
}

module.exports = {
  MOVE_TOLERANCE,
  STUCK_RESETS_ENTRY,
  PLACE_ERRORS_ENTRY,
  PLACE_SPAM_ENTRY,
  DIG_STILLS_CAP,
  BURIED_STILLS_ENTRY,
  BURIED_PROGRESS_DIST,
  UNSEEN_HOME_TICKS,
  ownerOf,
  verdict,
  request,
  update,
  clearStuck,
  walkHomeTick,
  homeReached,
  countPathReset,
}
