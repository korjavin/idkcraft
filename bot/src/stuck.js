'use strict'

// Stuck detection (idkcraft-6x7.1): mechanically moved from index.js —
// displacement watch, homing walk + stall, path-reset counters. The recover
// menu (routing) stays in runTick; the state machine lands in 6x7.2.
const { goals } = require('mineflayer-pathfinder')
const recover = require('./behaviours/recover')

// Online-but-unseen ticks before walking back to world spawn (return-home):
// death+respawn at spawn, or walked out of entity range. Same 10-tick scale
// as the lead give-up. Spawn pre-arm uses blocks, not ticks (below).
const UNSEEN_HOME_TICKS = 10

// GoalNear range of the homing walk, and arrival radius for resuming work.
const RETURN_HOME_RANGE = 2
// Homing ticks with no displacement before the stuck fact (2oe): the same
// 10-tick budget as the gather walk stall detector.
const HOME_STALL_TICKS = 10
// A homing episode latches its release point; only walking this far from it
// re-arms another episode. Wider than one sidestep (2): walking back into
// the same wedge must not chat+ask every ~15 ticks (revmux round 3).
const HOME_LATCH_CLEAR = 4

// Return-home: after UNSEEN_HOME_TICKS online-but-unseen ticks, walk to
// world spawn once (GoalNear keyed, so no re-issue) and keep standing
// there until someone is visible. Returns true while homing (caller skips
// stopOnce); pure stop otherwise. Fleeing still wins above.
function walkHomeTick(bot, ctx) {
  // While the breath reflex owns the body the homing walk stands down:
  // re-issuing (and re-logging) a goal the reflex drops on the same
  // tick is pure spam (revmux 01 body-3). True = handled, no stopOnce.
  if (ctx.breath) return true
  if ((ctx.unseenTicks || 0) < UNSEEN_HOME_TICKS) return false
  const sp = bot.spawnPoint
  const bp = bot.entity && bot.entity.position
  if (!sp || !bp) return false
  const key = `return-spawn:${sp.x},${sp.y},${sp.z}`
  const homePos = { x: bp.x, y: bp.y, z: bp.z }
  if (key !== ctx.lastGoalKey) {
    bot.pathfinder.setGoal(new goals.GoalNear(sp.x, sp.y, sp.z, RETURN_HOME_RANGE), false)
    ctx.lastGoalKey = key
    ctx.homeStalls = 0
    ctx.homeLastPos = homePos
    console.log(`returning to spawn dist=${Math.round(Math.hypot(bp.x - sp.x, bp.y - sp.y, bp.z - sp.z))}`)
  } else if (homeReached(bot) || (ctx.homeLastPos && Math.hypot(bp.x - ctx.homeLastPos.x, bp.z - ctx.homeLastPos.z) > 0.5)) {
    // Standing at spawn is the goal, not a stall (06v holds spawn); real
    // displacement breaks the streak like the gather walk detector. Either
    // clears a stale home fact the same way noteDisplacement does.
    ctx.homeStalls = 0
    ctx.homeLastPos = homePos
    // Moved = new situation only when genuinely relocated: the homing
    // walk itself is displacement, so any 0.5-block move re-arming the
    // episode loops it on the same wedge. Clear against the release
    // point the latch carries (lead's nudgedAt pattern).
    if (ctx.recoverLatch && ctx.recoverLatch.by === 'home') {
      const at = ctx.recoverLatch.at
      if (at && Math.hypot(bp.x - at.x, bp.z - at.z) > HOME_LATCH_CLEAR) ctx.recoverLatch = null
    }
    // Never under a running episode: clearing the fact while recovery is
    // set orphans it — no routing, no release, every detector stays off.
    if (!ctx.recovery && ctx.stuck && ctx.stuck.by === 'home') ctx.stuck = null
  } else if (++ctx.homeStalls >= HOME_STALL_TICKS) {
    // Detection only (2oe) — the recover menu owns the escape, same as
    // every other detector. Fires once per episode: setStuck latches.
    const dist = Math.hypot(bp.x - sp.x, bp.y - sp.y, bp.z - sp.z).toFixed(1)
    const fx = Number.isInteger(bp.x) ? bp.x : bp.x.toFixed(1)
    const fy = Number.isInteger(bp.y) ? bp.y : bp.y.toFixed(1)
    const fz = Number.isInteger(bp.z) ? bp.z : bp.z.toFixed(1)
    if (recover.setStuck(ctx, 'home', { x: sp.x, y: sp.y, z: sp.z }, key)) console.log(`stuck reason=wedge pos=${fx},${fy},${fz} dist=${dist}`)
    ctx.homeStalls = 0
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

function noteDisplacement(bot, ctx) {
  if (ctx.paused) return
  // Relocation re-arms the ticker latch on EVERY tick (rra round 2): the
  // idle-branch consult below short-circuits while moving/at-goal, so a
  // walk away and back would otherwise return to a stale anchor. Evaluated
  // once here for both its clearing side effect and the idle condition.
  let latched = false
  try { latched = recover.tickerLatched(ctx, bot) } catch (_) { /* latch best-effort */ }
  let bp = null
  try { bp = bot.entity && bot.entity.position } catch (_) { bp = null }
  let moving = false
  try {
    moving = !!(bot.pathfinder && typeof bot.pathfinder.isMoving === 'function' && bot.pathfinder.isMoving())
  } catch (_) { /* stationary default */ }
  if (bp && ctx.lastPos && moving) {
    if (Math.hypot(bp.x - ctx.lastPos.x, bp.z - ctx.lastPos.z) < 0.5) ctx.stuckTicks = (ctx.stuckTicks || 0) + 1
    else {
      ctx.stuckTicks = 0
      if (!ctx.recovery) ctx.stuck = null
    }
  } else if (!moving && bp && ctx.lastPos) {
    // Idle executor (idkcraft-rra): stillness counts only against a live
    // unsatisfied goal after a terminal planner verdict (noPath/timeout).
    // Normal idle at goal, without a goal, or mid-plan (none/success)
    // resets — a placing build holds unsatisfiable approach goals with an
    // idle executor for minutes, and must never trip this. A latched
    // release point holds too: one episode + one page per trap, then quiet
    // until the body relocates (revmux 01 major).
    const terminal = ctx.lastPathStatus === 'noPath' || ctx.lastPathStatus === 'timeout'
    if (Math.hypot(bp.x - ctx.lastPos.x, bp.z - ctx.lastPos.z) < 0.5) {
      if (terminal && idleFarFromGoal(bot, bp) && !latched) ctx.stuckTicks = (ctx.stuckTicks || 0) + 1
      else ctx.stuckTicks = 0
    } else {
      ctx.stuckTicks = 0
      if (!ctx.recovery) ctx.stuck = null
    }
  } else if (!moving) ctx.stuckTicks = 0
  if (bp) ctx.lastPos = { x: bp.x, y: bp.y, z: bp.z }
  // A clean relocation (a /tp out) ends the rest gave-up hold even when no
  // detector fires to consult the gate (core-1 follow-up).
  if (ctx.restGaveUpAt) recover.clearRelocatedRestMark(ctx, bot)
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
  ctx.recoverLatch = null
  ctx.retreat = null // orders end a retreat episode like any other step
}

// Hard-case stuck (ef3): displacement watch + generic backstops, then
// the recover menu owns the body. Detectors in the behaviours raise
// ctx.stuck with the goal they pursued; place_error streaks and long
// stillness while the executor claims to move raise it here. An urgent
// fight skips recovery (safety beats escape) and the brain call is
// skipped — the episode asks the model at decision points only.
function stuckBackstop(bot, ctx) {
  noteDisplacement(bot, ctx)
  if (!ctx.recovery && !ctx.stuck) {
    // The place_error streak belongs to gather: its own stall logic
    // skips the column (the yvi fix) and raises the fact at the
    // unreachable final. A ticker backstop here would starve the skip
    // and loop episodes on one trunk. Other placers keep the backstop.
    const gatherOwns = ctx.work && ctx.step === 'gather' && !!ctx.gather
    // Follow owns its place_error streaks (2oe): its wedge names the
    // relief and carries the goal, while this backstop would preempt it
    // with a goal-less fact on the same tick. Other owners keep it.
    const followOwns = (ctx.lastGoalKey || '').startsWith('follow:')
    // Gohome/stay own their approach stalls (rw4.5): walkTo re-issues
    // and fails the step itself (cannot-reach-home) — a ticker backstop
    // here sidesteps the body mid-doorway every slow approach and the
    // arrival starves into an orbit. The come-home meet owns its own the
    // same way (jr2.3): its walk re-issues and fails the order itself,
    // its doorway legs unstick and re-arm.
    const nightOwns = (ctx.work && (ctx.step === 'gohome' || ctx.step === 'stay')) || !!ctx.comehome
    // p4s: no place_error backstop — a placement-error streak is the
    // step's own signal (follow/gather count it toward their stalls), and
    // handing the body to recover on it turned rest/roam traps into long
    // sidestep/dig/call episodes. Only the no-displacement backstop stays.
    if (!nightOwns && (ctx.stuckTicks || 0) >= recover.STUCK_TICKS_ENTRY && !recover.restGaveUpHolds(ctx, bot)) {
      ctx.stuck = { by: 'no-displacement', goal: backstopGoal(bot), key: 'ticker' }
    }
  }
}

// place_error streaks (tower attempts into the same cell while a previous
// placeBlock still awaits blockUpdate): consecutive only — any other
// reset reason breaks the streak. Behaviours treat N>=3 with no
// displacement as a stall, the shared fact the hard-case stuck menu needs.
function countPathReset(ctx, reason) {
ctx.lastPathReset = reason || null
if (reason === 'stuck') ctx.stuckResets = (ctx.stuckResets || 0) + 1
if (reason === 'place_error') ctx.placeErrors = (ctx.placeErrors || 0) + 1
else ctx.placeErrors = 0
}

module.exports = { backstopGoal, idleFarFromGoal, noteDisplacement, clearStuck, walkHomeTick, homeReached, stuckBackstop, countPathReset, UNSEEN_HOME_TICKS, RETURN_HOME_RANGE, HOME_STALL_TICKS, HOME_LATCH_CLEAR }
