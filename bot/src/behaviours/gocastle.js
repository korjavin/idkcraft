'use strict'

// 'go castle' order behaviour (idkcraft-3qia): walk to the castle entrance
// apron and hold there until countermanded (follow me / go work / stop / come home).
const Vec3 = require('vec3')
const { goals } = require('mineflayer-pathfinder')
const { entrance } = require('./castle')
const body = require('../body')

const MOVE_TOLERANCE = 0.5
const STALL_TICKS = 10
const MAX_REISSUES = 3
// Climb-first depth (idkcraft-vmzq.50): terrain above within this many
// blocks means deep cover — an XZ leg from there dives caves (run8: the
// walk back descended to y11 water and drowned). The leg goals up
// instead (see the walk phase); the surface walk only plans from open
// sky. Unloaded reads surfaced — fail open to the old walk.
// R1: only TERRAIN counts. Canopy (leaves/logs), flora and built
// surfaces pass — the walk leaves from under a tree, it does not
// climb it (leaves used to read as deep cover and the leg towered at
// every tree). Anything passable (empty box) passes with them.
const CLIMB_HEADROOM = 8
const CLIMB_AIR = new Set(['air', 'cave_air', 'water', 'bubble_column'])
const CLIMB_WALKOUT = /(_leaves$|_log$|_stem$|_sapling$|_flower$|_grass$|fern$|_bush$|roots$|vines?$|sugar_cane|cactus|mushroom$|planks$|_door$|_bed$|fence|glass|torch|ladder|_slab$|stairs$|rail$|carpet$|^snow$|web$)/
function openAbove(b) {
  if (!b) return true
  const n = b.name
  if (CLIMB_AIR.has(n)) return true
  if (b.boundingBox === 'empty') return true
  return typeof n === 'string' && CLIMB_WALKOUT.test(n)
}
function climbNeeded(bot, bp) {
  try {
    if (!bot || typeof bot.blockAt !== 'function') return false
    const p = bp || bodyPos(bot)
    if (!p || typeof p.x !== 'number') return false
    const x = Math.floor(p.x)
    const z = Math.floor(p.z)
    for (let y = Math.floor(p.y) + 1; y <= Math.floor(p.y) + CLIMB_HEADROOM; y++) {
      let b = null
      try {
        b = bot.blockAt(new Vec3(x, y, z))
      } catch (_) {
        return false
      }
      if (!openAbove(b)) return true
    }
    return false
  } catch (_) {
    return false
  }
}

function bodyPos(bot) {
  const p = bot && bot.entity && bot.entity.position
  return p && typeof p.x === 'number' ? p : null
}

function atEntrance(bp, ent) {
  return Math.hypot(bp.x - (ent.x + 0.5), bp.z - (ent.z + 0.5)) <= 1.5 && Math.abs(bp.y - ent.y) <= 1.5
}

function holdStill(bot, ctx) {
  if (ctx.lastGoalKey !== 'stay') {
    try {
      if (bot.pathfinder && bot.pathfinder.isMoving()) bot.pathfinder.stop()
      else if (bot.pathfinder && bot.pathfinder.goal) bot.pathfinder.setGoal(null)
      if (typeof bot.clearControlStates === 'function') bot.clearControlStates()
    } catch (_) { /* body best-effort */ }
    ctx.lastGoalKey = 'stay'
  }
}

function setGoal(bot, ctx, key, goal) {
  if (ctx.lastGoalKey === key) return
  try {
    bot.pathfinder.setGoal(goal, false)
    ctx.lastGoalKey = key
    ctx.lastPathNodes = null
  } catch (_) { /* retry next tick */ }
}

function gocastle(bot, ctx, target, state) {
  const order = ctx && ctx.gocastle
  // Work-step mode (idkcraft-vmzq.50): the goal arbiter's return-to-site
  // leg reuses this walk with step-local state — no owner order is armed
  // (an order would preempt work and switch the goal kind). The order
  // path below is untouched; step mode ends done/failed, never holds.
  const stepMode = !order && !!ctx && ctx.step === 'gocastle' && ctx.stepStatus === 'running'
  const od = order || (stepMode ? (ctx.gosite || (ctx.gosite = { phase: 'walk', stalls: 0, fails: 0, lastPos: null, said: false })) : null)
  if (!od) return
  const st = (order && (order.castle || (ctx && ctx.castle))) || (stepMode ? ctx.castle : null)
  if (!st || !st.site) {
    if (order) ctx.gocastle = null
    else {
      ctx.stepStatus = 'failed:gocastle-no-site'
      ctx.gosite = null
    }
    return
  }
  let ent
  try { ent = entrance(st) } catch (_) { ent = null }
  if (!ent) {
    if (order) ctx.gocastle = null
    else {
      ctx.stepStatus = 'failed:gocastle-no-site'
      ctx.gosite = null
    }
    return
  }
  const bp = bodyPos(bot)
  if (!bp) return

  if (od.phase === 'hold') {
    if (!atEntrance(bp, ent)) {
      // Died or teleported away with the order standing: walk back to the entrance.
      od.phase = 'walk'
      od.stalls = 0
      od.fails = 0
      od.lastPos = null
      ctx.lastGoalKey = ''
      ctx.stepStatus = 'running'
      return
    }
    holdStill(bot, ctx)
    return
  }

  // Walk phase. Step mode picks climb-vs-walk BEFORE the claim (R1):
  // the climb leg digs (sealed rock has no walkable up) while the XZ
  // leg stays no-dig (the cave-diving fix) — the claim carries the
  // mode so the first plan already computes with the right movements.
  let stepClimb = false
  if (stepMode) {
    const feetY = Math.floor(bp.y)
    // Depth floor (R1+R2): the leg-high watermark minus headroom — an
    // 8-descent from where the walk has been goals up instead of
    // following A* down (the bead's y>=surface-8, self-calibrating:
    // no site assumptions). R2: the watermark DECAYS 2/tick while
    // walking open, so ordinary downhill (walk/jump pace) follows the
    // floor down and never trips — only falling-or-faster outruns it
    // into a dive trigger. The check runs pre-decay (a completed
    // 8-fall still triggers); climbs track up only (stable exit).
    // Near the entrance the floor lifts (arrival digs/walks as needed).
    let seeded = false
    if (typeof od.highY !== 'number') {
      // Blind starts assume site level: a deep start climbs toward the
      // surface, not toward start-8 (R2 reverse gap). Open starts seed
      // from feet (a mountain site never contours).
      const siteY = st && st.site && typeof st.site.y === 'number' ? st.site.y : feetY
      od.highY = climbNeeded(bot, bp) ? Math.max(feetY, siteY) : feetY
      od.climbFromY = null
      seeded = true
    }
    const floorY = od.highY - CLIMB_HEADROOM
    const cover = climbNeeded(bot, bp)
    // R3: swimming skips the depth trigger — a lake drop lands deep by
    // design (infiniteLiquidDropdown), and an up-goal above water is
    // untowerable from water (no path → fail). The XZ leg swims out
    // (breath owns drowning); cover still climbs (cave water is not a lake).
    let awash = false
    try {
      const feet = bot.blockAt(new Vec3(Math.floor(bp.x), feetY, Math.floor(bp.z)))
      awash = !!feet && (feet.name === 'water' || feet.name === 'bubble_column')
    } catch (_) { awash = false }
    const below = feetY < floorY && Math.hypot(bp.x - ent.x, bp.z - ent.z) > 32 && !awash
    if (!od.climbing && !seeded) {
      od.highY = Math.max(feetY, od.highY - 2)
    } else if (od.climbing && feetY > od.highY) {
      od.highY = feetY
    }
    if (!od.climbing && (cover || below)) {
      // Entering the climb: a same-spot re-entry flaps (a cave mouth
      // — or a lake drop — the XZ leg keeps re-planning) — three
      // strikes ends the leg; far-apart episodes reset. R3 counts
      // depth entries too: a drop-climb-drop cycle re-enters at the
      // same spot (the +2 band stops hovering, not cycling).
      const at = od.climbAt
      if (at && Math.hypot(bp.x - at.x, bp.z - at.z) < 16) od.flaps = (od.flaps || 0) + 1
      else {
        od.flaps = 0
        od.climbAt = { x: bp.x, z: bp.z }
      }
      od.climbing = true
      od.climbFromY = feetY
      od.climbHighY = feetY
    } else if (od.climbing && !cover && (feetY >= floorY + 2 || (od.climbFromY != null && feetY >= od.climbFromY + 12))) {
      // Recovered: open sky past the floor, or 12 up past a low local
      // surface. R3: re-anchor the watermark to the exit — without it
      // a site-seeded floor re-trips on the next tick and the leg
      // towers in open sky toward site-8 (the cap exit never sticks).
      od.climbing = false
      od.highY = feetY
    }
    stepClimb = !!od.climbing
  }
  try { body.claimBody(bot, ctx, (ctx.body && ctx.body.owner) || 'gocastle', stepClimb ? {} : { walk: true }) } catch (_) { /* lease best-effort */ }
  try { ctx.shelterLeg = ent } catch (_) { /* lease stash best-effort */ }

  if (atEntrance(bp, ent)) {
    if (order) {
      od.phase = 'hold'
      ctx.stepStatus = 'done'
      holdStill(bot, ctx)
      if (!od.said) {
        od.said = true
        try { bot.chat('at the castle') } catch (_) { /* chat best-effort */ }
      }
    } else {
      // Step mode: arrival ends the leg — decide() re-picks the castle
      // work (the step-change chat announces it, no arrival line here).
      ctx.stepStatus = 'done'
      ctx.gosite = null
      holdStill(bot, ctx)
    }
    return
  }

  // Climb-first (vmzq.50, step mode only): from deep cover — or below
  // the leg's depth floor — goal up, never an XZ leg. A walkable exit
  // climbs and sealed rock digs (the claim above digs for this leg);
  // what neither opens noPaths and stuck→recover digs up. The order
  // walk keeps its shape.
  if (stepClimb) {
    if ((od.flaps || 0) >= 3) {
      // Cave-mouth flap cap (R1): the XZ leg keeps re-planning the
      // tunnel this climb exits. Fail it — the menu falls back instead
      // of oscillating (the castle far leg, then the watchdog).
      od.phase = 'failed'
      ctx.stepStatus = 'failed:cannot-reach-castle'
      ctx.gosite = null
      holdStill(bot, ctx)
      return
    }
    const tx = Math.floor(bp.x)
    const ty = Math.floor(bp.y) + CLIMB_HEADROOM
    const tz = Math.floor(bp.z)
    setGoal(bot, ctx, `gocastle-up:${tx},${ty},${tz}`, new goals.GoalNear(bp.x, ty, bp.z, 2))
    ctx.stepStatus = 'running'
    // 3D progress resets: a dig-up climbs without closing XZ in, and
    // must not burn the give-up budget the order legs share. R2: moves
    // refund fails too — hand-digging is slow (a pickless block
    // outlasts a stall window), and only consecutive still windows
    // fail. R3: fails refund on NEW HEIGHT only (ratchet) — jumping,
    // bobbing or sideways shuffling never gains, so it still fails.
    const last = od.lastPos
    if (!last || Math.abs(bp.x - last.x) + Math.abs(bp.y - last.y) + Math.abs(bp.z - last.z) > MOVE_TOLERANCE) {
      od.stalls = 0
      if (typeof od.climbHighY !== 'number') od.climbHighY = od.climbFromY != null ? od.climbFromY : bp.y
      if (bp.y > od.climbHighY) {
        od.climbHighY = bp.y
        od.fails = 0
      }
      od.lastPos = { x: bp.x, y: bp.y, z: bp.z }
      return
    }
    if (++od.stalls < STALL_TICKS) return
    od.stalls = 0
    od.fails = (od.fails || 0) + 1
    let idle = true
    try { idle = !bot.pathfinder.isMoving() } catch (_) { /* retry */ }
    if (idle) ctx.lastGoalKey = ''
    if (od.fails >= MAX_REISSUES) {
      od.phase = 'failed'
      ctx.stepStatus = 'failed:cannot-reach-castle'
      ctx.gosite = null
      holdStill(bot, ctx)
    }
    return
  }

  let loaded = false
  try {
    loaded = !!(bot.blockAt && bot.blockAt(new Vec3(ent.x, ent.y, ent.z)))
  } catch (_) { loaded = false }

  const goal = loaded
    ? new goals.GoalNear(ent.x, ent.y, ent.z, 1)
    : new goals.GoalNearXZ(ent.x, ent.z, 1)

  const last = od.lastPos
  if (!last || Math.hypot(bp.x - last.x, bp.z - last.z) > MOVE_TOLERANCE) {
    od.stalls = 0
    od.lastPos = { x: bp.x, y: bp.y, z: bp.z }
  } else if (++od.stalls >= STALL_TICKS) {
    od.stalls = 0
    od.fails = (od.fails || 0) + 1
    let idle = true
    try { idle = !bot.pathfinder.isMoving() } catch (_) { /* retry */ }
    if (idle) ctx.lastGoalKey = ''
    if (od.fails >= MAX_REISSUES) {
      od.phase = 'failed'
      ctx.stepStatus = 'failed:cannot-reach-castle'
      if (order) {
        ctx.gocastle = null
        holdStill(bot, ctx)
        try { bot.chat('cannot reach the castle') } catch (_) { /* chat best-effort */ }
      } else {
        ctx.gosite = null
        holdStill(bot, ctx)
      }
      return
    }
  }

  setGoal(bot, ctx, loaded ? 'gocastle-walk' : 'gocastle-far', goal)
}

module.exports = gocastle
module.exports.climbNeeded = climbNeeded
module.exports.CLIMB_HEADROOM = CLIMB_HEADROOM
