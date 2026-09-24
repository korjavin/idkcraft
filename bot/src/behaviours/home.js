'use strict'

const Vec3 = require('vec3')
const { goals } = require('mineflayer-pathfinder')
const { goalFacts } = require('../goal')

// Night behaviours (bead rw4.5): gohome walks to the door, opens it, steps
// inside and closes it; stay holds the night, then leaves in the morning.
// mineflayer-pathfinder never opens doors (Movements.canOpenDoors=false),
// so both steps work the door themselves with bot.activateBlock. The
// doorway legs (enter/exit) also bypass the pathfinder entirely: with doors
// in blocksCantBreak (8si) the door cell reads unsafe and unbreakable, so
// A* can never route through it — the body sneaks the open doorway by
// direct control instead.
//
// The door is the lower door cell at site+(1,0,0) (rw4.4 blueprint); the
// outside approach cell is site+(1,y,-1), the first interior cell behind
// the door site+(1,y,+1) (the interior-box corner, see makeHome).

// Stall by displacement, not isMoving (gather lesson: a wedged executor
// keeps reporting moving while the body stands still).
const STALL_TICKS = 10
const MOVE_TOLERANCE = 0.5
const MAX_REISSUES = 3
// A lagged block update can hide a toggle we just did; re-trying at once
// would flip the door back. One attempt per window is plenty.
const TOGGLE_COOLDOWN_MS = 2000

function doorPos(home) {
  return new Vec3(home.site.x + 1, home.site.y, home.site.z)
}

function outsidePos(home) {
  return new Vec3(home.site.x + 1, home.site.y, home.site.z - 1)
}

function insidePos(home) {
  return new Vec3(home.site.x + 1, home.site.y, home.site.z + 1)
}

function botPos(bot) {
  const p = bot && bot.entity && bot.entity.position
  return p && typeof p.x === 'number' ? p : null
}

function isInside(bot, home) {
  try {
    const bp = botPos(bot)
    const box = home && home.interior
    if (!bp || !box || !box.min || !box.max) return false
    return bp.x >= box.min.x && bp.x <= box.max.x &&
      bp.y >= box.min.y && bp.y <= box.max.y &&
      bp.z >= box.min.z && bp.z <= box.max.z
  } catch (_) {
    return false
  }
}

function doorBlock(bot, home) {
  try {
    const b = bot.blockAt && bot.blockAt(doorPos(home))
    return b && typeof b.name === 'string' && b.name.endsWith('_door') ? b : null
  } catch (_) {
    return null
  }
}

function doorOpen(block) {
  try {
    const props = block && typeof block.getProperties === 'function' && block.getProperties()
    return !!props && props.open === true
  } catch (_) {
    return false
  }
}

// Fire-and-forget toggle, at most one per window; the phase only advances
// on the OBSERVED state, never optimistically.
function tryToggle(bot, st, block) {
  const now = Date.now()
  if (st.lastToggle && now - st.lastToggle < TOGGLE_COOLDOWN_MS) return
  st.lastToggle = now
  try {
    const r = bot.activateBlock(block)
    if (r && typeof r.catch === 'function') r.catch(() => {})
  } catch (_) { /* retry next window */ }
}

function setGoal(bot, ctx, key, goal) {
  if (ctx.lastGoalKey === key) return
  try {
    bot.pathfinder.setGoal(goal, false)
    ctx.lastGoalKey = key
  } catch (_) { /* retry next tick */ }
}

// Arrival is read from the approach-cell CENTRE (out+0.5), the way the goal
// does: from the integer corner the east GoalNear end cell reads ~1.58, so
// a 1.5 corner radius misses it one-sided (revmux 01-review loop+goal-5).
function nearOut(out, range) {
  return (bp) => Math.hypot(bp.x - (out.x + 0.5), bp.z - (out.z + 0.5)) <= range + 0.5
}

// Walk-phase helper: arrivals are read from positions (robust without
// pathfinder events). Returns true on arrival. On stall the goal is
// re-issued; after MAX_REISSUES the step fails AND the phase is marked
// failed, so the next pick starts a fresh record instead of resuming a
// stranded one (revmux 01-review loop+goal-2).
function walkTo(bot, ctx, st, key, goal, arrived) {
  const bp = botPos(bot)
  if (!bp) return false
  if (arrived(bp)) {
    st.stalls = 0
    return true
  }
  const last = st.lastPos
  if (!last || Math.hypot(bp.x - last.x, bp.z - last.z) > MOVE_TOLERANCE) {
    st.stalls = 0
    st.lastPos = { x: bp.x, y: bp.y, z: bp.z }
  } else if (++st.stalls >= STALL_TICKS) {
    st.stalls = 0
    st.fails = (st.fails || 0) + 1
    // A still-claiming-motion executor may be mid-plan (slow A* around our
    // own walls takes ~20 s): a fresh goal restarts planning forever, so
    // re-issue only a died-silent executor.
    let idle = true
    try { idle = !bot.pathfinder.isMoving() } catch (_) { /* retry below */ }
    if (idle) ctx.lastGoalKey = '' // force re-issue below
    if (st.fails >= MAX_REISSUES) {
      st.phase = 'failed'
      ctx.stepStatus = 'failed:cannot-reach-home'
      return false
    }
  }
  setGoal(bot, ctx, key, goal)
  return false
}

// Doorway legs (enter/exit) walk by direct control, not the pathfinder
// (see header). Sneak pace: a full-speed tick overshoots the small arrival
// window, sneak cannot. Legs stage through cell centres (out-centre, then
// inn-centre or vice versa) so a leg never cuts a wall corner. Returns true
// on arrival. The tick cap is purely anti-hang — no displacement stall, so
// there is no false-fail mode on fast ticks.
const DOOR_LEG_TICKS = 60

function legMet(bp, t) {
  return Math.hypot(bp.x - (t.x + 0.5), bp.z - (t.z + 0.5)) <= 0.6
}

function stepThrough(bot, ctx, st, legs, arrived) {
  const bp = botPos(bot)
  if (!bp) return false
  if (arrived(bp)) {
    st.legIdx = 0
    st.legTicks = 0
    try { bot.clearControlStates() } catch (_) { /* body best-effort */ }
    return true
  }
  let idx = st.legIdx || 0
  if (idx < legs.length && legMet(bp, legs[idx])) idx++
  st.legIdx = idx
  if ((st.legTicks = (st.legTicks || 0) + 1) > DOOR_LEG_TICKS) {
    st.legIdx = 0
    st.legTicks = 0
    try { bot.clearControlStates() } catch (_) { /* body best-effort */ }
    st.phase = 'failed'
    ctx.stepStatus = 'failed:cannot-reach-home'
    return false
  }
  const leg = legs[Math.min(idx, legs.length - 1)]
  // Kill any live path so the executor doesn't fight manual control (the
  // pathfinder never clears control states itself).
  try {
    if (bot.pathfinder.isMoving()) bot.pathfinder.stop()
    else if (bot.pathfinder.goal) bot.pathfinder.setGoal(null)
  } catch (_) { /* body best-effort */ }
  ctx.lastGoalKey = 'home-door'
  try {
    bot.lookAt(new Vec3(leg.x + 0.5, bp.y + 1.62, leg.z + 0.5))
    bot.setControlState('forward', true)
    bot.setControlState('sneak', true)
  } catch (_) { /* retry next tick */ }
  return false
}

function freshGo() {
  return { phase: '', stalls: 0, fails: 0, lastPos: null, lastToggle: 0, legIdx: 0, legTicks: 0 }
}

function gohome(bot, ctx, target, state) {
  const home = ctx && ctx.home
  if (!home || !home.site) {
    ctx.stepStatus = 'failed:no-home'
    return
  }
  if (!ctx.gohome || ctx.gohome.phase === 'done' || ctx.gohome.phase === 'failed') {
    // Already inside (re-picked step, lagged first tick): skip the walk-out.
    // Restore 'running': with a stale failed status decide would otherwise
    // hand stay the step the tick the bot steps inside, leaving the door
    // open all night (revmux 03-review).
    ctx.gohome = freshGo()
    ctx.gohome.phase = isInside(bot, home) ? 'close' : 'walk'
    ctx.stepStatus = 'running'
  }
  const st = ctx.gohome
  const out = outsidePos(home)
  const inn = insidePos(home)
  if (st.phase === 'walk') {
    const arrived = walkTo(bot, ctx, st, 'gohome-walk',
      new goals.GoalNear(out.x, out.y, out.z, 1),
      nearOut(out, 1))
    if (st.phase === 'failed') return // walkTo failed the step
    if (arrived) st.phase = 'open'
    else return
  }
  if (st.phase === 'open') {
    const door = doorBlock(bot, home)
    if (!door || doorOpen(door)) st.phase = 'enter'
    else {
      tryToggle(bot, st, door)
      return
    }
  }
  if (st.phase === 'enter') {
    // One-sided: the whole 0.6-wide body past the door plane, so 'close'
    // cannot shut the panel into the bot (revmux 03-review).
    const through = stepThrough(bot, ctx, st, [out, inn],
      (bp) => isInside(bot, home) && bp.z >= inn.z + 0.3)
    if (st.phase === 'failed') return // stepThrough failed the step
    if (through) st.phase = 'close'
    else return
  }
  if (st.phase === 'close') {
    const door = doorBlock(bot, home)
    if (!door || !doorOpen(door)) {
      st.phase = 'done'
      ctx.stepStatus = 'done'
      ctx.inShelter = true
      try { bot.chat('home for the night') } catch (_) { /* chat best-effort */ }
      return
    }
    tryToggle(bot, st, door)
  }
}

function holdStill(bot, ctx) {
  // Same guard as lead.js holdGoal: stop a live path, cancel a stationary
  // goal, and never latch stopPathing (which would swallow the next goal).
  // Also clears manual control states (the doorway sneak): the pathfinder
  // never clears them itself.
  if (ctx.lastGoalKey !== 'stay') {
    try {
      if (bot.pathfinder.isMoving()) bot.pathfinder.stop()
      else if (bot.pathfinder.goal) bot.pathfinder.setGoal(null)
      bot.clearControlStates()
    } catch (_) { /* body best-effort */ }
    ctx.lastGoalKey = 'stay'
  }
}

function stay(bot, ctx, target, state) {
  const home = ctx && ctx.home
  if (!home || !home.site) {
    ctx.stepStatus = 'failed:no-home'
    return
  }
  if (!ctx.stay || ctx.stay.phase === 'done' || ctx.stay.phase === 'failed') {
    ctx.stay = freshGo()
    ctx.stay.phase = 'hold'
    ctx.stepStatus = 'running' // same sticky restore as gohome above
  }
  const st = ctx.stay
  // A stale stay (death, follow->work, lead order) must not hold the bot
  // outside with fight suppressed: only the walk-out phases may run while
  // not inside (revmux 01-review loop+goal-4).
  if (!isInside(bot, home) && st.phase !== 'exit' && st.phase !== 'close') {
    ctx.stepStatus = 'failed:not-inside'
    ctx.inShelter = false
    return
  }
  ctx.inShelter = true
  let time = 'night'
  try {
    time = goalFacts(bot, ctx).time || 'night'
  } catch (_) { /* hold on unknown time */ }
  if (time !== 'day') {
    st.phase = 'hold'
    holdStill(bot, ctx)
    return
  }
  const out = outsidePos(home)
  const inn = insidePos(home)
  if (st.phase === 'hold') st.phase = 'open'
  if (st.phase === 'open') {
    const door = doorBlock(bot, home)
    if (!door || doorOpen(door)) st.phase = 'exit'
    else {
      tryToggle(bot, st, door)
      return
    }
  }
  if (st.phase === 'exit') {
    // No pathfinder goal here at all (revmux 02-review): any GoalNear the
    // inside cell meets would close the door on itself without walking out,
    // and with doors unbreakable A* cannot cross the doorway anyway. The
    // sneak legs cannot meet arrival in place.
    // One-sided like enter: arrival only with the whole body north of the
    // door cell, never standing in the doorway (revmux 03-review).
    const through = stepThrough(bot, ctx, st, [inn, out], (bp) => bp.z <= out.z + 0.7)
    if (st.phase === 'failed') return // stepThrough failed the step
    if (through) st.phase = 'close'
    else return
  }
  if (st.phase === 'close') {
    const door = doorBlock(bot, home)
    if (!door || !doorOpen(door)) {
      st.phase = 'done'
      ctx.stepStatus = 'done'
      ctx.inShelter = false
      try { bot.chat('morning; back to work') } catch (_) { /* chat best-effort */ }
      return
    }
    tryToggle(bot, st, door)
  }
}

module.exports = { gohome, stay }
