'use strict'

const Vec3 = require('vec3')
const { goals } = require('mineflayer-pathfinder')
const { HOSTILE_NAMES } = require('../perception')
const { goalFacts, timeWord } = require('../goal')
const detour = require('../detour')
const stuck = require('../stuck')
const { botPos, doorOpen, doorLaneDX: blockLaneDX } = require('./util')
const body = require('../body')
const retreatMod = require('./retreat')
const recover = require('./recover')
const buildMod = require('./build')

// Night behaviours (bead rw4.5): gohome walks to the door, opens it, steps
// inside and closes it; stay holds the night, then leaves in the morning.
// A* routes wooden doors on its own since idkcraft-6xno (doors.js: the
// opener reflex), but the home door keeps its dedicated phases: the walks
// end outside, the doorway legs (enter/exit) still bypass the pathfinder
// entirely and sneak the open doorway by direct control on the bv6 lane,
// and the shut is explicit — never entrusted to the executor reflex.
//
// The door is the lower door cell at site+(1,0,0) on a v1 hut, site+(3,0,0)
// on a v2 house (jr2.1 blueprint); the outside approach cell is one north
// of it, the first interior cell one south (the v2 one lands in the common
// room, see makeHome).

// Stall by displacement, not isMoving (gather lesson: a wedged executor
// keeps reporting moving while the body stands still).
const STALL_TICKS = 10
const MOVE_TOLERANCE = stuck.MOVE_TOLERANCE
const MAX_REISSUES = 3
// A lagged block update can hide a toggle we just did; re-trying at once
// would flip the door back. One attempt per window is plenty.
const TOGGLE_COOLDOWN_MS = 2000
// Within this many blocks of the site the dawn report says 'at home'.
const HOME_NEAR_BLOCKS = 10

function dayOf(bot) {
  try {
    const d = bot && bot.time && bot.time.day
    return typeof d === 'number' ? d : 0
  } catch (_) { return 0 }
}

// Night tally (rw4.14): deaths + banked haul for the one dawn line. The
// tally is day-stamped: each new MC day re-opens it, so an unreported
// night never leaks day deaths into the next line; a death mid-night
// starts a second gohome/stay but the same-day latch keeps the day's
// first opening, so multi-episode nights still accumulate. Deaths snap
// at dusk (night-only); haul snaps at the report, so it spans dawn to
// dawn across a reported night (cold start: the first dusk). Chat-only:
// no decision reads it.
function ensureNight(bot, ctx) {
  try {
    const day = dayOf(bot)
    const n = ctx.night
    if (!n || n.reported === true || n.day !== day) {
      ctx.night = {
        deaths: ctx.deaths || 0,
        haul: (n && n.haul) ? n.haul : { ...(ctx.haul || {}) },
        reported: false,
        day,
      }
    }
  } catch (_) { /* tally best-effort */ }
}

function nightLine(bot, ctx, home) {
  let deaths = 0
  const banked = []
  try {
    const snap = (ctx && ctx.night) || {}
    deaths = Math.max(0, (ctx.deaths || 0) - (snap.deaths || 0))
    const haul = ctx.haul || {}
    const before = snap.haul || {}
    for (const d of Object.keys(haul)) {
      const g = (haul[d] || 0) - (before[d] || 0)
      if (g > 0) banked.push(`${g} ${d}`)
    }
  } catch (_) { /* report best-effort */ }
  const dText = deaths === 0 ? 'no deaths' : `${deaths} death${deaths === 1 ? '' : 's'}`
  const bText = banked.length ? `banked ${banked.join(', ')}` : 'banked nothing'
  let pText = 'at home'
  try {
    const bp = botPos(bot)
    const st = home && home.site
    if (bp && st) {
      const d = Math.hypot(bp.x - st.x, bp.z - st.z)
      if (d > HOME_NEAR_BLOCKS) pText = `${Math.round(d)} blocks from home`
    }
  } catch (_) { /* position best-effort */ }
  return `night: survived, ${dText}, ${bText}, ${pText}; back to work`
}

function doorDx(home) {
  return home && home.v === 2 ? 3 : 1
}

function doorPos(home) {
  return new Vec3(home.site.x + doorDx(home), home.site.y, home.site.z)
}

function outsidePos(home) {
  return new Vec3(home.site.x + doorDx(home), home.site.y, home.site.z - 1)
}

function insidePos(home) {
  return new Vec3(home.site.x + doorDx(home), home.site.y, home.site.z + 1)
}


function isInside(bot, home) {
  try {
    const bp = botPos(bot)
    const box = home && home.interior
    if (!bp || !box || !box.min || !box.max) return false
    // The box holds inclusive BLOCK coords; the entity carries a float.
    // Comparing raw puts the back row and east column outside (live jr2.3:
    // a bedroom order at z=4.5 read as outside and walked A* at the shut
    // door). Floor to the standing block first.
    const fx = Math.floor(bp.x)
    const fy = Math.floor(bp.y)
    const fz = Math.floor(bp.z)
    return fx >= box.min.x && fx <= box.max.x &&
      fy >= box.min.y && fy <= box.max.y &&
      fz >= box.min.z && fz <= box.max.z
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

// The home door's lane (bv6 geometry lives in behaviours/util, shared with
// the A* door reflex since idkcraft-6xno): the free-gap offset for the legs.
function doorLaneDX(bot, home) {
  try {
    return blockLaneDX(doorBlock(bot, home))
  } catch (_) {
    return 0
  }
}

// A player at the door (revmux jr2.3-02 core-2/body-3): the meet is the
// one mode where the owner is expected through that door, so the night
// hold never shuts it on them — it closes once they clear it. Anyone on
// the roster counts; the bot itself never does. Only the doorway side
// counts (revmux jr2.3-03): past the door plane they are in, so the hold
// shuts the door behind them instead of standing it open all night.
const DOOR_GRACE_BLOCKS = 2.5
function playerAtDoor(bot, home) {
  try {
    const door = doorPos(home)
    const cx = door.x + 0.5
    const cz = door.z + 0.5
    const roomZ = insidePos(home).z
    const players = (bot && bot.players) || {}
    for (const key of Object.keys(players)) {
      if (key === bot.username) continue
      const ent = players[key] && players[key].entity
      const p = ent && ent.position
      if (!p || typeof p.x !== 'number' || typeof p.z !== 'number') continue
      if (p.z < roomZ && Math.hypot(p.x - cx, p.z - cz) <= DOOR_GRACE_BLOCKS) return true
    }
  } catch (_) { /* unreadable roster: the old rule stands */ }
  return false
}

// Out-lane block (rw4.18, revmux 01 core-1): a hostile standing on or
// beside the outside approach cell while the exit legs would step out. The
// rw4.18 tick gate holds (door shut) instead of opening into it — the
// bead's 'не выбегая в толпу'. Radius 2 around the out-cell centre: the
// cell itself plus the adjacent ring, with a step of margin for wandering
// mobs; the gate re-checks every tick, so a cleared lane resumes at once
// and mobs pressing other walls never hold. Creepers count (the step-out
// lands inside their blast); endermen don't (neutral unless stared at or
// struck, and the legs do neither — the isFightTarget precedent), and
// players never block (stepping out to the owner is the point). Anything
// unreadable reads as clear: the exit legs validate the home themselves
// (failMeet), and a missing world must not latch a silent hold.
const OUT_LANE_BLOCKED_R = 2
function outLaneBlocked(bot, home) {
  try {
    const site = home && home.site
    if (!site || typeof site.x !== 'number') return false
    const out = outsidePos(home)
    const ox = out.x + 0.5
    const oz = out.z + 0.5
    const ents = (bot && bot.entities) || {}
    for (const key of Object.keys(ents)) {
      const e = ents[key]
      if (!e || e.isValid === false || e.type === 'player') continue
      const p = e.position
      if (!p || typeof p.x !== 'number' || typeof p.y !== 'number' || typeof p.z !== 'number') continue
      const nm = e.name || ''
      if (!HOSTILE_NAMES.has(nm) || nm === 'enderman') continue
      if (Math.hypot(p.x - ox, p.y - out.y, p.z - oz) <= OUT_LANE_BLOCKED_R) return true
    }
  } catch (_) { /* unreadable reads as clear, see above */ }
  return false
}

// Door-shut read for the rw4.18 out-lane hold (revmux 03 core-1): the hold
// only means something behind a shut door — with the door open or gone the
// legs must finish (walk out, shut it, release, hand to fight) instead of
// freezing mid-doorway. Missing/unreadable reads as NOT shut (run): there
// is no shut door to hold behind, and the legs validate the doorway
// themselves (gap-walk, wedge re-arm).
function exitDoorShut(bot, home) {
  try {
    const door = doorBlock(bot, home)
    if (!door) return false
    return !doorOpen(door)
  } catch (_) { return false }
}

// A close into a missing door is a failure, never a silent done (rw4.8):
// prod stood a whole night 'sheltered' with arrows coming through. Failing
// surfaces the fault to the arbiter (day picks can send build to repair
// the door cell). stay-hold instead logs once and keeps holding: stay is
// self-advancing, so failing there would re-pick and log every tick.
function failNoDoor(ctx, st, where) {
  st.phase = 'failed'
  ctx.stepStatus = 'failed:no-door'
  console.log(`door missing at ${where}`)
}

// Fire-and-forget toggle, at most one per window; the phase only advances
// on the OBSERVED state, never optimistically. Untracks the door from the
// A* door reflex first (revmux 01 major-2): home owns its door from here,
// so the reflex stands down instead of double-toggling on its own cooldown.
// Returns whether the toggle was sent (false on the cooldown skip): the
// rw4.18 exit gate commits only on a send (verifier P2b).
function tryToggle(bot, ctx, st, block) {
  try {
    const p = block && block.position
    if (ctx && ctx.doorOpened instanceof Map && p && typeof p.x === 'number') {
      ctx.doorOpened.delete(`${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`)
    }
  } catch (_) { /* untrack best-effort */ }
  const now = Date.now()
  if (st.lastToggle && now - st.lastToggle < TOGGLE_COOLDOWN_MS) return false
  st.lastToggle = now
  try {
    const r = bot.activateBlock(block)
    if (r && typeof r.catch === 'function') r.catch(() => {})
  } catch (_) { /* retry next window */ }
  return true
}

function setGoal(bot, ctx, key, goal) {
  if (ctx.lastGoalKey === key) return
  try {
    bot.pathfinder.setGoal(goal, false)
    ctx.lastGoalKey = key
    // The new plan has no nodes yet: drop the previous behaviour's so the
    // sprint gate fails closed until path_update (follow.js 5vv mirror).
    ctx.lastPathNodes = null
  } catch (_) { /* retry next tick */ }
}

// Arrival is read from the approach-cell CENTRE (out+0.5), the way the goal
// does: from the integer corner the east GoalNear end cell reads ~1.58, so
// a 1.5 corner radius misses it one-sided (revmux 01-review loop+goal-5).
// Feet must also be at the threshold level (rgsi/i2bi): XZ-only read a roof
// 2.8 up or a pit below the door as arrived, then enter walked into a wall.
// A detour waypoint has no meaningful y (flat = true skips it).
function nearOut(out, range, flat) {
  return (bp) => Math.hypot(bp.x - (out.x + 0.5), bp.z - (out.z + 0.5)) <= range + 0.5 &&
    (flat || Math.abs(bp.y - out.y) <= 1.5)
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
    // i2bi: a body 2+ below the aim (a pit at the door) with no path is a
    // stuck situation the menu can solve (dig a step); gohome/comehome are
    // raise-exempt, so ask once per walk record (st.asked: a done episode
    // clears the latch, so the latch alone does not bound it).
    if (!st.asked && idle && goal && typeof goal.y === 'number' && bp.y < goal.y - 1.5 &&
        stuck.request(bot, ctx, 'no-displacement', { x: goal.x, y: goal.y, z: goal.z }, key)) {
      st.asked = true
      st.fails = 0
      return false
    }
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
// inn-centre or vice versa) so a leg never cuts a wall corner — shifted onto
// the door lane when laneDX is live (bv6, see legAims). Returns true on
// arrival. The tick cap is purely anti-hang — no displacement stall, so
// there is no false-fail mode on fast ticks.
const DOOR_LEG_TICKS = 60
// Unstick: a 1-wide doorway scrapes the frame with no lateral room, so a
// leg that makes no displacement progress backs straight up (keeping its
// alignment) instead of pushing forever (live 8kc).
const UNSTICK_TICKS = 8
const UNSTICK_TOLERANCE = 0.1

function legMet(bp, p) {
  return Math.hypot(bp.x - p.x, bp.z - p.z) <= 0.6
}

// Door-plane crossing (bv6): with a live lane the middle (door) leg advances
// on CROSSING the door plane, never on the 0.6 window — an early advance
// from the near side would swap the steep near-edge correction for a shallow
// far aim and cut the corner into the panel anyway. Direction mirrors
// legAims (staging leg's side decides).
function doorCrossed(bp, legs) {
  return legs[0].z < legs[1].z ? bp.z >= legs[1].z : bp.z <= legs[1].z + 1
}

// Aim points for the legs: cell centres, shifted onto the door lane when one
// is live (bv6). Every leg shares the lane x — stage aligned, cross aligned,
// arrive aligned. The MIDDLE leg is always the door cell (all four call sites
// pass [stage, door, far]) and aims at the door cell's NEAR edge — derived
// from which side the staging leg stands on — so the lateral correction
// completes before the panel plane instead of halfway across it. With no lane
// (0/unreadable) every leg aims at the bare cell centre, exactly as before.
function legAims(legs, laneDX) {
  const dx = (typeof laneDX === 'number' && Number.isFinite(laneDX)) ? laneDX : 0
  const edge = (!dx || legs.length < 3) ? 0.5 : (legs[0].z < legs[1].z ? 0.1 : 0.9)
  return legs.map((t, i) => ({ x: t.x + 0.5 + dx, z: t.z + (dx && i === 1 && legs.length >= 3 ? edge : 0.5) }))
}

function stepThrough(bot, ctx, st, legs, arrived, laneDX) {
  const aims = legAims(legs, laneDX)
  const bp = botPos(bot)
  if (!bp) return false
  if (arrived(bp)) {
    st.legIdx = 0
    st.legTicks = 0
    st.legPos = null
    st.legStall = 0
    st.backing = 0
    try { bot.clearControlStates() } catch (_) { /* body best-effort */ }
    return true
  }
  let idx = st.legIdx || 0
  const laneLive = typeof laneDX === 'number' && Number.isFinite(laneDX) &&
    laneDX !== 0 && aims.length >= 3
  const advanced = idx === 1 && laneLive
    ? doorCrossed(bp, legs)
    : (idx < aims.length && legMet(bp, aims[idx]))
  if (idx < aims.length && advanced) {
    idx++
    st.legStall = 0
    st.backing = 0
  }
  st.legIdx = idx
  if ((st.legTicks = (st.legTicks || 0) + 1) > DOOR_LEG_TICKS) {
    st.legIdx = 0
    st.legTicks = 0
    st.legPos = null
    st.legStall = 0
    st.backing = 0
    try { bot.clearControlStates() } catch (_) { /* body best-effort */ }
    st.phase = 'failed'
    ctx.stepStatus = 'failed:cannot-reach-home'
    return false
  }
  const last = st.legPos
  if (!last || Math.hypot(bp.x - last.x, bp.z - last.z) > UNSTICK_TOLERANCE) {
    st.legPos = { x: bp.x, z: bp.z }
    st.legStall = 0
  } else if (++st.legStall >= UNSTICK_TICKS && !(st.backing > 0)) {
    st.backing = UNSTICK_TICKS
    st.legStall = 0
  }
  const leg = aims[Math.min(idx, aims.length - 1)]
  // Kill any live path so the executor doesn't fight manual control (the
  // pathfinder never clears control states itself).
  try {
    if (bot.pathfinder.isMoving()) bot.pathfinder.stop()
    else if (bot.pathfinder.goal) bot.pathfinder.setGoal(null)
  } catch (_) { /* body best-effort */ }
  ctx.lastGoalKey = 'home-door'
  if (st.backing > 0) {
    st.backing--
    try {
      bot.setControlState('forward', false)
      bot.setControlState('back', true)
      bot.setControlState('sneak', true)
    } catch (_) { /* retry next tick */ }
    return false
  }
  try {
    bot.lookAt(new Vec3(leg.x, bp.y + 1.62, leg.z))
    // Back must be released too: forward+back cancel in physics, so a leg
    // that backed out of frame contact would never drive again (revmux 8kc).
    bot.setControlState('back', false)
    bot.setControlState('forward', true)
    bot.setControlState('sneak', true)
  } catch (_) { /* retry next tick */ }
  return false
}

// Walk flags moved to body.js (idkcraft-6x7.3): the walk borrows no-dig
// via lease claims at the walk/seat phases (the gohome walk never digs —
// with the house unbreakable A* would tunnel through dirt beside the
// walls, live 8kc), and the flat-run sprint gate (rw4.10, same inputs as
// follow.js 5vv) runs in movementsFor off the ctx.shelterLeg stash. A raw
// setControlState would die in 50 ms (the 20 Hz executor rewrites sprint
// from allowSprinting), so the lease drives the flag the executor reads.

// Shelter-run contract (rw4.10, dispatch half in atl.12): gohome stamps
// ctx.shelterRun with Date.now() on every night walk tick. Dispatch treats
// the run as live while the stamp is fresher than this — a step switch
// away simply lets it go stale, so no ticker clearing is needed.
const SHELTER_RUN_FRESH_MS = 2500
function freshGo() {
  return { phase: '', stalls: 0, fails: 0, lastPos: null, lastToggle: 0, legIdx: 0, legTicks: 0, legPos: null, legStall: 0, backing: 0 }
}

// idkcraft-1l9: the open phase had no cap (tryToggle every 2 s forever).
// ~5 toggle windows, then fail. Repeat failures at the same door latch
// gohome out for the night in goal.js (idkcraft-xhqv: gohomeLatched).
const OPEN_TICKS = 10

// A loaded door cell that holds no door (idkcraft-1l9). A dark cell
// (blockAt null) is unknown, not gone.
function doorGone(bot, home) {
  try {
    const b = bot.blockAt && bot.blockAt(doorPos(home))
    return !!b && !(typeof b.name === 'string' && b.name.endsWith('_door'))
  } catch (_) {
    return false
  }
}

// No door = no shelter, and gohome never holds a failure (self-advancing):
// failing alone re-picks gohome at the same hole every tick till dawn
// (idkcraft-1l9). The house is genuinely unfinished, so built drops and
// build repairs the door. A skipped door cell is un-skipped first (revmux
// 01): else the index.js revalidation (nextCellIdx minus skips === -1)
// flips built straight back and the hole loop returns. Once per skip stamp
// (revmux 02): a door build re-skipped after our re-probe cannot be placed,
// so it keeps its skip window instead of cycling build -> 'home done' ->
// gohome all night. That residual still fails gohome at the hole (no chat);
// goal.js latches it out for the night after repeats (idkcraft-xhqv).
function failGoneDoor(bot, ctx, st, home, where) {
  failNoDoor(ctx, st, where)
  try {
    const di = buildMod.blueprintFor(home).findIndex((c) => c.kind === 'door')
    const skipped = Array.isArray(ctx.buildSkip) && ctx.buildSkip.includes(di)
    const at = ctx.buildSkipAt && typeof ctx.buildSkipAt === 'object' ? ctx.buildSkipAt[di] : undefined
    if (skipped && typeof ctx.doorReprobeAt === 'number' && !(typeof at === 'number' && at < ctx.doorReprobeAt)) return
    if (skipped) {
      ctx.buildSkip = ctx.buildSkip.filter((i) => i !== di)
      if (ctx.buildSkipAt && typeof ctx.buildSkipAt === 'object') delete ctx.buildSkipAt[di]
      ctx.doorReprobeAt = Date.now()
    }
    home.built = false
  } catch (_) { /* keep built */ }
}

// One line per phase change (idkcraft-1l9): prod stood 8 minutes with
// nothing but moving=false path=success to read.
function logPhase(bot, ctx, st, home) {
  if (!st || st.logged === st.phase) return
  st.logged = st.phase
  const f = (p) => (p ? `${Math.round(p.x * 10) / 10},${Math.round(p.y * 10) / 10},${Math.round(p.z * 10) / 10}` : '?')
  let aim = null
  try {
    if (st.phase === 'walk') aim = !st.viaDone && st.via ? st.via : outsidePos(home)
    else if (st.phase === 'enter') aim = insidePos(home)
    else aim = doorPos(home)
  } catch (_) { /* aim unknown */ }
  console.log(`gohome phase=${st.phase} aim=${f(aim)} pos=${f(botPos(bot))} status=${ctx.stepStatus} built=${!!home.built}`)
}

function gohome(bot, ctx, target, state) {
  gohomeTick(bot, ctx, target, state)
  if (ctx && ctx.home && ctx.home.site) logPhase(bot, ctx, ctx.gohome, ctx.home)
}

function gohomeTick(bot, ctx, target, state) {
  const home = ctx && ctx.home
  if (!home || !home.site) {
    ctx.stepStatus = 'failed:no-home'
    // The walk borrow needs a home site: refresh to release a leaked one.
    try { body.claimBody(bot, ctx, (ctx.body && ctx.body.owner) || 'idle') } catch (_) { /* lease best-effort */ }
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
    ctx.lastGoalKey = '' // fresh walk must replan, not latch-skip (live 8kc)
    ensureNight(bot, ctx) // the night begins when the bot heads home
  }
  const st = ctx.gohome
  const out = outsidePos(home)
  const inn = insidePos(home)
  if (st.phase === 'walk') {
    // Lease refresh pre-issue (the walk plans no-dig — explicit borrow,
    // the walk dispatches) + the shelter anchor for the post-dispatch
    // sprint gate.
    try { body.claimBody(bot, ctx, (ctx.body && ctx.body.owner) || 'work', { walk: true }) } catch (_) { /* lease best-effort */ }
    try { ctx.shelterLeg = out } catch (_) { /* lease stash best-effort */ }
    // rw4.12: a live mark on the leg diverts via a waypoint first; a dead
    // detour leg falls back to direct once (never noPath instead of home).
    if (st.via === undefined) {
      let v = null
      try { v = detour.via(ctx, botPos(bot), out) } catch (_) { v = null }
      st.via = v
      st.viaDone = !v
    }
    const diverting = !st.viaDone && !!st.via
    const aim = diverting ? st.via : out
    // The waypoint names x/z only (revmux 01): its y is the bot's feet at
    // plan time, meaningless 20 blocks away on a slope. nearOut already
    // reads arrival xz-only from the cell centre.
    const goal = diverting
      ? new goals.GoalNearXZ(aim.x, aim.z, 1)
      : new goals.GoalNear(aim.x, aim.y, aim.z, 1)
    const arrived = walkTo(bot, ctx, st, diverting ? 'gohome-via' : 'gohome-walk', goal, nearOut(aim, 1, diverting))
    if (st.phase === 'failed') {
      if (st.via && !st.viaDone) {
        st.phase = 'walk'
        st.stalls = 0
        st.fails = 0
        st.lastPos = null
        st.viaDone = true
        ctx.stepStatus = 'running'
        ctx.lastGoalKey = ''
        return
      }
      try { body.claimBody(bot, ctx, (ctx.body && ctx.body.owner) || 'work') } catch (_) { /* lease best-effort */ }
      ctx.shelterLeg = null; return // a failed leg holds no sprint stash
    } // walkTo failed the step
    if (arrived) {
      if (st.via && !st.viaDone) {
        st.viaDone = true
        st.fails = 0 // the direct leg starts with a clean record
        ctx.lastGoalKey = ''
      } else st.phase = 'open'
    }
    else {
      // rw4.10: the walk home runs far flat legs (48 blocks take ~11 s
      // sprinted; fight churn on the way killed prod 7 times in 3.5 min),
      // and every night walk tick stamps the shelter run for dispatch
      // (atl.12) — gait-independent: rough legs walk but still count.
      // (rw4.10 sprint runs in movementsFor off the stash above.)
      try {
        if (goalFacts(bot, ctx).time === 'night') ctx.shelterRun = Date.now()
      } catch (_) { /* unknown time: no stamp (fail closed) */ }
      return
    }
  }
  if (st.phase === 'open') {
    // No-dig released: the phase moved (the walk borrow is walk-scoped).
    try { body.claimBody(bot, ctx, (ctx.body && ctx.body.owner) || 'work') } catch (_) { /* lease best-effort */ }
    if (doorGone(bot, home)) { failGoneDoor(bot, ctx, st, home, 'gohome-open'); return }
    const door = doorBlock(bot, home)
    if (!door || doorOpen(door)) st.phase = 'enter'
    else if ((st.openTicks = (st.openTicks || 0) + 1) > OPEN_TICKS) {
      st.phase = 'failed'
      ctx.stepStatus = 'failed:door-stuck'
      return
    } else {
      tryToggle(bot, ctx, st, door)
      return
    }
  }
  if (st.phase === 'enter') {
    // One-sided: the whole 0.6-wide body past the door plane, so 'close'
    // cannot shut the panel into the bot (revmux 03-review).
    const door = doorPos(home)
    const through = stepThrough(bot, ctx, st, [out, door, inn],
      (bp) => isInside(bot, home) && bp.z >= inn.z + 0.3, doorLaneDX(bot, home))
    if (st.phase === 'failed') {    return } // stepThrough failed the step
    if (through) st.phase = 'close'
    else {    return }
  }
  if (st.phase === 'close') {
    const door = doorBlock(bot, home)
    if (!door) { failGoneDoor(bot, ctx, st, home, 'gohome-close'); return }
    if (!doorOpen(door)) {
      st.phase = 'done'
      ctx.stepStatus = 'done'
      ctx.inShelter = true
      // rw4.16: one arrival line per night, never by day — a re-issued
      // done (stale shortcut, retreat re-pick) must not re-chat every
      // tick (prod: 434 lines in 7 min, kick risk). Dusk and night share
      // one MC day (xhqv), so the stamp is the night; an unreadable
      // clock still chats (legacy behaviour, fail open).
      let day = false
      try { day = timeWord(bot) === 'day' } catch (_) { day = false }
      const mcDay = dayOf(bot)
      if (!day && ctx.gohomeSaidDay !== mcDay) {
        ctx.gohomeSaidDay = mcDay
        try { bot.chat('home for the night') } catch (_) { /* chat best-effort */ }
      }
      return
    }
    tryToggle(bot, ctx, st, door)
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

// Sleep (jr2.2): at night the bot sleeps in its OWN bed (bedroom A) instead
// of standing — the first sleep sets the home respawn. The owner's bed
// (bedroom B) is never touched: sleep fails closed to the old hold when the
// own bed is missing, and a sleeping body touches nothing (activateBlock
// while asleep would leave the bed). Returns true when it owns the tick.
// A failed attempt must not own the tick (revmux 01-review): only a
// sleeping body skips the rw4.8 door check — an awake one re-closes the
// door and re-evaluates shelter between tries. Transient failures (dusk,
// monsters near) back off; server-side refusals (occupied, obstructed,
// timeout) give up tonight and retry tomorrow. A dawn that finds the body
// still asleep wakes it (missed wake event).
const SLEEP_REACH = 2 // from the head: inside mineflayer's click box on every facing
const SLEEP_STALL_TICKS = 30
const SLEEP_RETRY_TICKS = 30 // transient backoff: covers dusk (~27 ticks), re-tries mobs nightly
function sleepTick(bot, ctx, home, st) {
  try {
    if (!home || home.v !== 2 || !home.site) return false
    if (typeof bot.sleep !== 'function') return false
    if (bot.isSleeping) return true
    if (ctx.sleepInFlight) return true
    if (st.sleepGiveUp) return false
    if ((st.sleepCooldown || 0) > 0) { st.sleepCooldown--; return false } // awake and waiting: the door check runs
    let cells = null
    try {
      cells = require('./beds').cellsOf(home) // deferred: home loads inside the behaviour chain
    } catch (_) { cells = null }
    if (!cells) return false
    let bed = null
    try { bed = require('./beds').bedroomBed(bot, home, 'a') } catch (_) { bed = null }
    if (!bed) {
      try { if (home.bedA) { delete home.bedA; delete home.sleptA } } catch (_) { /* retract best-effort */ }
      return false // no whole bed in A: hold as before, never take B
    }
    try { home.bedA = new Vec3(cells.a.foot.x, cells.a.foot.y, cells.a.foot.z) } catch (_) { /* claim best-effort */ }
    const bp = botPos(bot)
    if (!bp) return false
    const head = cells.a.head
    if (Math.hypot(bp.x - head.x, bp.y - head.y, bp.z - head.z) > SLEEP_REACH) {
      const open = new Vec3(home.site.x + 2, home.site.y, home.site.z + 3)
      setGoal(bot, ctx, 'stay-bed', new goals.GoalNear(open.x, open.y, open.z, 1))
      const last = st.sleepAnchor
      if (!last || Math.hypot(bp.x - last.x, bp.z - last.z) > MOVE_TOLERANCE) {
        st.sleepStalls = 0
        st.sleepAnchor = { x: bp.x, z: bp.z }
      } else if (++st.sleepStalls >= SLEEP_STALL_TICKS) {
        st.sleepGiveUp = true // unreachable tonight: hold, retry tomorrow
        return false
      }
      return true
    }
    ctx.sleepInFlight = true
    void (async () => {
      try {
        await bot.sleep(bed)
        try { home.sleptA = true } catch (_) { /* claim best-effort */ } // vanilla sets the spawn on use
        if (ctx.stay !== st) {
          // An order took the body mid-flight (revmux 02-review): the spawn
          // is set, but the body must not sleep under the order — wake at
          // once, skip the chat.
          try { if (typeof bot.wake === 'function') await bot.wake() } catch (_) { /* the order wakes */ }
          return
        }
        if (!st.sleepSaid) {
          st.sleepSaid = true
          try { bot.chat('sleeping in my bed') } catch (_) { /* chat best-effort */ }
        }
      } catch (err) {
        const msg = err && err.message ? String(err.message) : ''
        if (/monsters nearby|not night/i.test(msg)) st.sleepCooldown = SLEEP_RETRY_TICKS
        else st.sleepGiveUp = true // occupied/obstructed/timeout: hold tonight, retry tomorrow
        if (!st.sleepErrSaid) {
          st.sleepErrSaid = true
          try { console.log(`sleep failed: ${msg || err}`) } catch (_) { /* logging best-effort */ }
        }
      } finally {
        ctx.sleepInFlight = false
      }
    })()
    return true
  } catch (_) {
    return false
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
    ensureNight(bot, ctx) // already-inside dusk starts the tally here
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
    // jr2.2: sleep owns the tick before the door check — a sleeping body
    // must not toggle the door (activateBlock would leave the bed).
    if (sleepTick(bot, ctx, home, st)) return
    // rw4.8: the shelter is only a shelter with a shut door — an opened
    // door gets re-closed; a missing one logs once per episode (st is
    // fresh per stay) and keeps holding unsheltered so fight is not
    // suppressed through the open doorway. Failing would spin: stay
    // re-picks every tick at night (SELF_ADVANCING).
    const door = doorBlock(bot, home)
    if (!door) {
      ctx.inShelter = false
      if (!st.doorLogged) { st.doorLogged = true; console.log('door missing at stay-hold') }
    } else if (doorOpen(door)) {
      tryToggle(bot, ctx, st, door)
    }
    holdStill(bot, ctx)
    return
  }
  const out = outsidePos(home)
  const inn = insidePos(home)
  // jr2.2: dawn usually auto-wakes (vanilla), but a missed wake event must
  // not walk the exit legs asleep — wake first, then open.
  if (bot.isSleeping) {
    if (typeof bot.wake === 'function' && !ctx.sleepInFlight) {
      ctx.sleepInFlight = true
      void (async () => {
        try { await bot.wake() } catch (_) { /* already awake: the event won */ } finally { ctx.sleepInFlight = false }
      })()
    }
    return
  }
  if (st.phase === 'hold') st.phase = 'open'
  if (st.phase === 'open') {
    const door = doorBlock(bot, home)
    if (!door || doorOpen(door)) st.phase = 'exit'
    else if ((st.openTicks = (st.openTicks || 0) + 1) > OPEN_TICKS) {
      st.phase = 'failed'
      ctx.stepStatus = 'failed:door-stuck' // gohome's 1l9 cap (idkcraft-470s)
      return
    } else {
      tryToggle(bot, ctx, st, door)
      return
    }
  }
  if (st.phase === 'exit') {
    // No pathfinder goal here at all (revmux 02-review): any GoalNear the
    // inside cell meets would close the door on itself without walking out.
    // (A* crosses wooden doorways since idkcraft-6xno, which only strengthens
    // the point: the exit stays on the sneak legs, never on a goal.) The
    // sneak legs cannot meet arrival in place.
    // One-sided like enter: arrival only with the whole body north of the
    // door cell, never standing in the doorway (revmux 03-review).
    const door = doorPos(home)
    const through = stepThrough(bot, ctx, st, [inn, door, out], (bp) => bp.z <= out.z + 0.7, doorLaneDX(bot, home))
    if (st.phase === 'failed') {    return } // stepThrough failed the step
    if (through) st.phase = 'close'
    else {    return }
  }
  if (st.phase === 'close') {
    const door = doorBlock(bot, home)
    if (!door) { failNoDoor(ctx, st, 'stay-close'); return }
    if (!doorOpen(door)) {
      st.phase = 'done'
      ctx.stepStatus = 'done'
      ctx.inShelter = false
      // Compose before snapshotting: the line reads the opening, then the
      // report becomes the next opening (haul spans dawn to dawn).
      let line = ''
      try { line = nightLine(bot, ctx, home) } catch (_) { /* report best-effort */ }
      try {
        if (ctx.night) {
          ctx.night.deaths = ctx.deaths || 0
          ctx.night.haul = { ...(ctx.haul || {}) }
          ctx.night.reported = true
        }
      } catch (_) { /* tally best-effort */ }
      try { if (line) bot.chat(line) } catch (_) { /* chat best-effort */ }
      return
    }
    tryToggle(bot, ctx, st, door)
  }

}

// Night shelter (idkcraft-ipn.12): the night-far step — without a bed the
// respawn is world spawn, and marching home through the dark dies on repeat
// (prod: 53 of 62 deaths in gohome). Instead the bot pillars up once where
// it stands and holds till dawn. A failed pillar still holds on the ground:
// standing beats marching. inShelter once the pillar stands (stay rule): no
// fight pursuit off the pillar — the melee reflex still swings at climbers.
// The dawn report mirrors stay's close (same night tally).
// Pillar anchor (revmux 01 core-2): death respawns (or teleports) the body
// far from the pillar while the step survives — holding there would camp
// open ground at world spawn. XZ only: the climb itself is vertical.
const SHELTER_DISPLACE_XZ = 2
const SHELTER_DRY_R = 24
// yrtx: nearest dry standing cell (solid non-water floor, two free cells
// above) within SHELTER_DRY_R. Pillaring in water never stands (the breath
// reflex lifts the body, the anchor reads 'displaced', Drowned finish it).
const WET_PLANTS = new Set(['kelp', 'kelp_plant', 'seagrass', 'tall_seagrass', 'bubble_column'])
function wetCell(b) {
  return !b || b.isWaterlogged === true ||
    (typeof b.name === 'string' && (b.name.includes('water') || WET_PLANTS.has(b.name)))
}
function freeCell(b) {
  return !!b && b.boundingBox === 'empty' && !wetCell(b)
}
// One dry stance: feet cell (x, y, z) standable (solid dry floor, two free
// cells above). Shared by nearestDry and the n9ta water abort (which also
// verifies its entry shore through it).
function dryStanceAt(bot, x, y, z) {
  if (!bot || typeof bot.blockAt !== 'function') return false
  const floor = bot.blockAt(new Vec3(x, y - 1, z))
  if (!floor || floor.boundingBox !== 'block' || wetCell(floor)) return false
  return freeCell(bot.blockAt(new Vec3(x, y, z))) && freeCell(bot.blockAt(new Vec3(x, y + 1, z)))
}
function nearestDry(bot, skip = [], dyLo = -4, dyHi = 1) {
  const bp = botPos(bot)
  if (!bp || typeof bot.blockAt !== 'function') return null
  const x0 = Math.floor(bp.x), y0 = Math.floor(bp.y), z0 = Math.floor(bp.z)
  let best = null
  let bd = Infinity
  for (let dx = -SHELTER_DRY_R; dx <= SHELTER_DRY_R; dx++) {
    for (let dz = -SHELTER_DRY_R; dz <= SHELTER_DRY_R; dz++) {
      const d = dx * dx + dz * dz
      if (d >= bd) continue
      for (let dy = dyHi; dy >= dyLo; dy--) { // at most a step above the surface: climbable
        if (!dryStanceAt(bot, x0 + dx, y0 + dy, z0 + dz)) continue
        if (skip.some((s) => s.x === x0 + dx && s.z === z0 + dz)) continue
        best = { x: x0 + dx, y: y0 + dy, z: z0 + dz }
        bd = d
        break
      }
    }
  }
  return best
}
function shelter(bot, ctx, target, state) {
  const home = ctx && ctx.home
  if (!home || !home.site) {
    ctx.stepStatus = 'failed:no-home'
    return
  }
  if (isInside(bot, home)) {
    // Walked in by hand (or a lagged first tick): stay owns the inside.
    ctx.stepStatus = 'done'
    return
  }
  let time = 'night'
  try {
    time = goalFacts(bot, ctx).time || 'night'
  } catch (_) { /* hold on unknown time */ }
  if (time === 'day') {
    ctx.stepStatus = 'done'
    ctx.inShelter = false
    // Compose before snapshotting (stay-close mirror): the line reads the
    // opening, then the report becomes the next opening.
    let line = ''
    try { line = nightLine(bot, ctx, home) } catch (_) { /* report best-effort */ }
    try {
      if (ctx.night) {
        ctx.night.deaths = ctx.deaths || 0
        ctx.night.haul = { ...(ctx.haul || {}) }
        ctx.night.reported = true
      }
    } catch (_) { /* tally best-effort */ }
    try { if (line) bot.chat(line) } catch (_) { /* chat best-effort */ }
    return
  }
  ensureNight(bot, ctx) // idempotent: the tally opens once, like gohome/stay
  if (!ctx.shelter || typeof ctx.shelter !== 'object') ctx.shelter = {}
  const st = ctx.shelter
  try {
    const bp = botPos(bot)
    // Not while the dig-in walks to a dirt column (stone stance): arrival
    // re-anchors at the pit column below, and from then on a fight that
    // drags the body off the pit resets the record like any displacement.
    if (st.dig && st.dig.walked && !st.dig.walk && !st.dig.anchored && bp) {
      st.pillarAt = { x: bp.x, z: bp.z }
      st.dig.anchored = true
    }
    const pa = st.pillarAt
    if (!(st.dig && st.dig.walk) && bp && pa && typeof pa.x === 'number' &&
      Math.hypot(bp.x - pa.x, bp.z - pa.z) > SHELTER_DISPLACE_XZ) {
      // Displaced past the anchor: drop the hold and the stale climb, and
      // re-pillar below. A foreign non-pillar episode is never touched.
      st.pillared = false
      st.pillarAt = null
      st.dig = null
      if (ctx.recovery && ctx.recovery.action === 'pillar_up') {
        try { ctx.recovery = null } catch (_) { /* release best-effort */ }
      }
      try { console.log('shelter displaced, re-pillaring') } catch (_) { /* log best-effort */ }
    }
  } catch (_) { /* anchor best-effort */ }
  if (!st.pillared && !ctx.recovery && !st.dig) {
    // yrtx: get out of the water first; the pillar anchor is set on land.
    let wet = false
    try {
      const f = botPos(bot)
      const b = f && bot.blockAt(new Vec3(Math.floor(f.x), Math.floor(f.y), Math.floor(f.z)))
      wet = !!(b && typeof b.name === 'string' && b.name.includes('water')) ||
        !!(bot.entity && bot.entity.isInWater === true)
    } catch (_) { /* dry on doubt */ }
    if (wet) {
      ctx.inShelter = false
      const now = Date.now()
      const bp = botPos(bot)
      if (!st.skip) st.skip = []
      // Give-up (revmux 01): a cell the swim does not get closer to in 15 s
      // is skipped; the scan reruns at most every 5 s (no land: home goal).
      // A gap between wet ticks means fight/breath held the body: not a stall.
      if (st.wetTickAt && now - st.wetTickAt > 2000 && typeof st.dryProgressAt === 'number') {
        st.dryProgressAt += now - st.wetTickAt // pause, keep stall time already counted
      }
      st.wetTickAt = now
      if (st.dry && bp) {
        const dist = Math.hypot(bp.x - st.dry.x, bp.z - st.dry.z)
        if (!(dist < (st.dryBest === undefined ? Infinity : st.dryBest) - 0.5)) {
          if (now - st.dryProgressAt > 15000) { st.skip.push(st.dry); st.dry = null; st.scanAt = 0 }
        } else {
          st.dryBest = dist
          st.dryProgressAt = now
        }
      }
      if (!st.dry && st.skip.length < 3 && !(now - (st.scanAt || 0) < 5000)) {
        st.scanAt = now
        try { st.dry = nearestDry(bot, st.skip) } catch (_) { st.dry = null }
        st.dryBest = undefined
        st.dryProgressAt = now
        ctx.lastGoalKey = null
      }
      const d = st.dry
      // No land in reach: keep swimming toward the house, never pillar here.
      setGoal(bot, ctx, d ? `shelter-dry-${d.x},${d.z}` : 'shelter-dry', d
        ? new goals.GoalNear(d.x + 0.5, d.y, d.z + 0.5, 1)
        : new goals.GoalNearXZ(home.site.x, home.site.z, 2))
      return
    }
    if (st.dry || ctx.lastGoalKey === 'shelter-dry') {
      // Landed: drop the swim goal so it cannot fight the pillar jump.
      try { bot.pathfinder.setGoal(null) } catch (_) { /* best-effort */ }
      ctx.lastGoalKey = null
    }
    st.dry = null
    st.skip = null
  }
  if (!st.pillared) {
    // Climbing unsheltered (revmux 01 core-1): arming inShelter before the
    // pillar stands turns every fight tick idle at the ticker gate — and
    // stopOnce kills the pillar jump — freezing the climb on the first
    // hostile. Fight and the retreat chain run during the climb; the
    // shelter arms once the pillar stands.
    ctx.inShelter = false
    // A foreign live episode (a stuck flow's non-pillar prim) is never
    // touched: the hold is the point, the pillar best-effort.
    if (!ctx.recovery && !st.dig) {
      try { retreatMod.beginPillar(ctx, 'shelter', null) } catch (_) { /* episode best-effort */ }
      try {
        const bp0 = botPos(bot)
        if (bp0) st.pillarAt = { x: bp0.x, z: bp0.z }
      } catch (_) { /* anchor best-effort */ }
    }
    if (!st.dig && (!ctx.recovery || ctx.recovery.action === 'pillar_up')) {
      const before = ctx.recovery && ctx.recovery.status
      if (before === 'running' || before === 'starting' || before == null) {
        try { recover.run(bot, ctx) } catch (_) { /* prim best-effort */ }
      }
      const rec = ctx.recovery && ctx.recovery.status
      if (rec === 'running' || rec === 'starting' || rec == null) return // still climbing
      // Terminal verdict (pillar-wrapper mirror): pillared or not, the hold
      // starts — even a failed pillar beats the march. Release the episode
      // so a later stuck flow never adopts this stale record.
      if (rec === 'failed:no-scaffold') {
        // Empty kit (ed88: world-spawn respawn, 7 deaths in 3 min holding
        // on the ground): dig in instead. Stop any live path first so the
        // walk cannot drag the body off the pit column.
        // setGoal(null), never stop(): stop() on a live path only latches,
        // and the latch would swallow a same-tick dig-in walk goal (revmux 03).
        st.dig = {}
        try {
          bot.pathfinder.setGoal(null)
          bot.clearControlStates()
        } catch (_) { /* body best-effort */ }
        ctx.lastGoalKey = 'stay'
      } else if (rec !== 'done' && !st.pillarLogged) {
        st.pillarLogged = true
        try { console.log(`shelter pillar ${rec}, holding on the ground`) } catch (_) { /* log best-effort */ }
      }
      try { ctx.recovery = null } catch (_) { /* release best-effort */ }
    }
    if (st.dig) {
      let r = 'failed:error'
      try { r = recover.digInRun(bot, ctx, st.dig) } catch (_) { /* fail into the hold */ }
      if (r === 'running') return
      st.dig = null
      st.pillarAt = null // re-anchored below, at the pit
      try { console.log(`shelter dig-in ${r}`) } catch (_) { /* log best-effort */ }
    }
    // Anchor the hold (revmux 02): a foreign live episode skips beginPillar
    // above, so holding here would leave pillarAt null and the death/
    // respawn displacement check dead — the round-1 open-ground camp on
    // another path. Anchor at the current body instead.
    if (!st.pillarAt) {
      try {
        const bp2 = botPos(bot)
        if (bp2) st.pillarAt = { x: bp2.x, z: bp2.z }
      } catch (_) { /* anchor best-effort */ }
    }
    st.pillared = true
  }
  ctx.inShelter = true
  holdStill(bot, ctx)
}

// Meet target (jr2.3 'come home'): the common-room cell behind the door on a
// v2 house, the inside cell on a v1 hut. Named separately from insidePos so
// the jr2.2 bedroom/sleep targeting cannot hijack the meeting: the owner is
// met in the common room, never in a bedroom.
function meetPos(home) {
  return insidePos(home)
}

// Fresh meet record (jr2.3): inside settles straight into the hold (say hi,
// leave the door to whoever is using it), outside walks in. The order pins
// its house at creation: 'build here' may swap ctx.home mid-order, and the
// walk/legs must keep running against the pinned geometry (revmux 01 core-1).
function startMeet(by, inside, home) {
  return { ...freshGo(), by: by || null, exiting: false, phase: inside ? 'close' : 'walk', settle: !!inside, home: home || null }
}

// Release (jr2.3): a move command while the meet stands. Outside the order
// simply ends; inside, the exit legs (exitMeet) run before the new mode's
// first path — clearing here would hand A* a through-wall plan (probed: an
// unguarded plan eats two wall planks, a guarded one tunnels under the
// house). Arms inShelter with the exit so fight pursuit cannot preempt the
// doorway either. Idempotent: an armed exit is left alone, so double-release
// paths (setBring + startBlockOrder) cannot reset running legs.
function releaseMeet(bot, ctx) {
  const order = ctx && ctx.comehome
  if (!order) return
  // An armed exit persists across double-release paths (setBring +
  // startBlockOrder) with its shelter intact: fight must not preempt the
  // doorway. setHome's unshelter lands between two releases, so keeping
  // refreshes it (revmux 01 core-1).
  if (order.exiting) {
    ctx.inShelter = true
    return
  }
  let inside = false
  try { inside = isInside(bot, ctx.home) } catch (_) { inside = false }
  if (!inside) {
    ctx.comehome = null
    return
  }
  ctx.comehome = { ...freshGo(), by: order.by, exiting: true, phase: 'open', lastToggle: order.lastToggle || 0, home: order.home || ctx.home }
  try { require('../task').carryOrderStamp(order, ctx.comehome) } catch (_) { /* stamp best-effort */ }
  ctx.lastGoalKey = ''
  ctx.inShelter = true
  // rw4.17 (#311 reuse): the exit may yet release unsheltered-while-inside
  // (door-stuck fail, an order handover clearing the flag), and the next A*
  // from inside would eat the walls — the doorway hold is the protection,
  // the guard is the backstop. Exit-context install: the box stays put
  // across a home move while the body stands inside it (no runtime
  // movements swap exists), so one arming covers the episode; the exiting
  // branch above deliberately does not re-arm.
  try { buildMod.guardExitWalls(bot, ctx) } catch (_) { /* guard best-effort */ }
}

// The order ends out loud (lead precedent): one chat line, then the body is
// released to the standing mode. The console keeps the machine reason.
function failMeet(bot, ctx, status) {
  const order = ctx && ctx.comehome
  const exiting = !!(order && order.exiting)
  if (order) order.phase = 'failed'
  ctx.stepStatus = status
  ctx.comehome = null
  if (exiting) ctx.inShelter = false // exit path: the shelter flag was armed by releaseMeet
  if (exiting) {
    // rw4.17 (#311 reuse): clearing the flag while the body is still inside
    // the exited house must arm the wall guard first — the released body's
    // A* (fight/work) otherwise digs the walls (the old revmux 01 minor on
    // the door-stuck leg below). The box is the EXITED (pinned) house, not
    // ctx.home — a 'build here' swap may have moved on mid-exit — and it
    // stays put across later re-box ticks until the body leaves (sticky).
    try {
      const done = order.home || ctx.home
      if (done && isInside(bot, done)) buildMod.guardExitWalls(bot, ctx, done)
    } catch (_) { /* guard best-effort */ }
  }
  try { body.claimBody(bot, ctx, (ctx.body && ctx.body.owner) || 'idle') } catch (_) { /* lease best-effort */ }
  ctx.shelterLeg = null
  try { bot.clearControlStates() } catch (_) { /* body best-effort */ }
  if (status === 'failed:cannot-seat') {
    try { bot.chat('cannot reach the common room') } catch (_) { /* chat best-effort */ }
    console.log(`comehome ${status}`)
    return
  }
  if (exiting && status === 'failed:door-stuck') {
    try { bot.chat('cannot get out: door stuck') } catch (_) { /* chat best-effort */ }
    console.log(`comehome ${status}`)
    return
  }
  const why = status === 'failed:no-door' ? ': no door' : status === 'failed:no-home' ? ': no home' : status === 'failed:door-stuck' ? ': door stuck' : ''
  try { bot.chat(`cannot reach home${why}`) } catch (_) { /* chat best-effort */ }
  console.log(`comehome ${status}`)
}

// Arrival shared by the door close and the seating walk: hold the room,
// sheltered, one line out loud. Restores the walk's borrowed canDig.
function arriveMeet(bot, ctx, order) {
  order.phase = 'hold'
  ctx.stepStatus = 'done'
  ctx.inShelter = true
  try { body.claimBody(bot, ctx, (ctx.body && ctx.body.owner) || 'idle') } catch (_) { /* lease best-effort */ }
  try { bot.chat('home') } catch (_) { /* chat best-effort */ }
}

// Exit completion: normally the body releases to the flipped mode, but a
// re-ordered meet (jr2.3 reseek) walks to the current home instead.
function finishExit(bot, ctx, order) {
  const by = order && order.by
  if (order && order.reseek && ctx.home && ctx.home.site) {
    ctx.comehome = startMeet(by, false, ctx.home)
    // No stamp carry (R3 body-1): the destination changed to the new home,
    // so the reseek re-baselines instead of inheriting the old dist clock.
    ctx.inShelter = false
    ctx.stepStatus = 'running'
    ctx.lastGoalKey = ''
    return
  }
  ctx.comehome = null
  ctx.inShelter = false
  ctx.stepStatus = 'running'
}

// Release walk (jr2.3): the exit legs mirrored from stay, with release
// semantics. Missing door on the way out is success (walk the gap, nothing
// to shut); a wedged leg re-arms silently like stay (the doorway usually
// clears), never failing into a wall-digging fallback. Already-out means
// released — except mid-doorway with the exit legs running, where the close
// phase still shuts the door. The gate is the toggle-reach bound: close must
// only run within activateBlock reach of the door, never toggling at air
// from across the yard. Death/respawn and teleports jump past it and release
// at once instead of sneak-marching the legs back from spawn.
const EXIT_SHUT_BLOCKS = 2.5
// Settle seats when farther than this (2D, meet centre): a walk-in arrival
// ends within ~1.4, a bedroom or the partition row beyond 2.
const SEAT_FAR = 1.5
function exitMeet(bot, ctx, home, order) {
  if (!isInside(bot, home)) {
    let shut = false
    if (order.phase === 'exit' || order.phase === 'close') {
      try {
        const bp = botPos(bot)
        const door = doorPos(home)
        shut = !!bp && Math.hypot(bp.x - (door.x + 0.5), bp.z - (door.z + 0.5)) <= EXIT_SHUT_BLOCKS
      } catch (_) { shut = false }
    }
    if (!shut) {
      finishExit(bot, ctx, order)
      return
    }
  }
  ctx.inShelter = true
  const out = outsidePos(home)
  const meet = meetPos(home)
  if (order.phase === 'hold') order.phase = 'open'
  if (order.phase === 'open') {
    const door = doorBlock(bot, home)
    if (!door || doorOpen(door)) order.phase = 'exit'
    else if ((order.openTicks = (order.openTicks || 0) + 1) > OPEN_TICKS) {
      failMeet(bot, ctx, 'failed:door-stuck') // gohome's 1l9 cap (idkcraft-470s); failMeet arms the wall guard, so the released body's A* routes via door/gap instead of the wall (rw4.17 closes the old revmux 01 minor)
      return
    } else {
      // rw4.18/04: the legs started the exit. Commit only on a send: a
      // cooldown skip (releaseMeet carries the hold's lastToggle) must not
      // mark an untouched exit started, or the night/lane hold is bypassed
      // (verifier P2b). The tick gate finishes a committed exit at any
      // clock; without the flag a re-armed 'open' is indistinguishable
      // from a door the legs never touched.
      if (tryToggle(bot, ctx, order, door)) order.committed = true
      return
    }
  }
  if (order.phase === 'exit') {
    const door = doorPos(home)
    const through = stepThrough(bot, ctx, order, [meet, door, out], (bp) => bp.z <= out.z + 0.7, doorLaneDX(bot, home))
    if (order.phase === 'failed') {
      const keepBy = order.by
      // Committed unconditionally (not carried): the re-arm proves the legs
      // drove — even through a gap or a pre-open door that never needed a
      // toggle — so dusk/night finishes instead of freezing behind it.
      ctx.comehome = { ...freshGo(), by: keepBy, exiting: true, phase: 'open', home: order.home, reseek: order.reseek || false, committed: true }
      try { require('../task').carryOrderStamp(order, ctx.comehome) } catch (_) { /* stamp best-effort */ }
      ctx.stepStatus = 'running'
      ctx.lastGoalKey = ''
      return
    }
    if (through) order.phase = 'close'
    else return
  }
  if (order.phase === 'close') {
    const door = doorBlock(bot, home)
    if (!door || !doorOpen(door)) {
      finishExit(bot, ctx, order) // gap walked or door shut: released
      return
    }
    tryToggle(bot, ctx, order, door)
  }
}

// 'Come home' order (jr2.3): the walk→open→enter→close wire mirrors gohome
// (same door primitives, same staging, same arrival predicates — only the
// meet target is named), then the bot HOLDS the common room until
// countermanded: day steps work the house through the walls, so ending the
// order inside would strand the next step against them (A* opens wooden
// doors since idkcraft-6xno, but the exit legs stay the doorway's owners).
// A move command while inside arms
// the exit via releaseMeet; death/respawn outside silently re-arms the walk.
// Fight preempts like every other explicit order.
function comehome(bot, ctx, target, state) {
  const order = ctx && ctx.comehome
  if (!order) return
  const home = order.home
  if (!home || !home.site) {
    failMeet(bot, ctx, 'failed:no-home')
    return
  }
  if (order.exiting) {
    exitMeet(bot, ctx, home, order)
    return
  }
  if (order.phase === 'hold') {
    if (!isInside(bot, home)) {
      // Died or teleported out with the order standing: walk back home.
      order.phase = 'walk'
      order.stalls = 0
      order.fails = 0
      order.lastPos = null
      order.via = undefined // re-route from the new position
      order.viaDone = false
      ctx.lastGoalKey = ''
      ctx.stepStatus = 'running'
      return
    }
    // Stay's rw4.8 rule, night half: the shelter is only a shelter with a
    // shut door. By day the door belongs to whoever is using it (no
    // re-close into the owner's face); at night the hold secures it, and
    // with no door at all the hold drops the shelter flag so fight pursuit
    // stays legal through the gap (revmux 01 body-3).
    const held = doorBlock(bot, home)
    if (!held) ctx.inShelter = false
    else {
      let nightish = false
      try { nightish = goalFacts(bot, ctx).time !== 'day' } catch (_) { nightish = false }
      if (nightish && doorOpen(held) && !playerAtDoor(bot, home)) tryToggle(bot, ctx, order, held)
    }
    holdStill(bot, ctx)
    return
  }
  const out = outsidePos(home)
  const meet = meetPos(home)
  if (order.phase === 'walk') {
    // Lease refresh pre-issue (the walk plans no-dig — explicit borrow,
    // the walk dispatches) + the shelter anchor for the post-dispatch
    // sprint gate.
    try { body.claimBody(bot, ctx, (ctx.body && ctx.body.owner) || 'comehome', { walk: true }) } catch (_) { /* lease best-effort */ }
    try { ctx.shelterLeg = out } catch (_) { /* lease stash best-effort */ }
    // rw4.12 detour mirror: a live mark diverts via a waypoint first; a dead
    // detour leg falls back to direct once.
    if (order.via === undefined) {
      let v = null
      try { v = detour.via(ctx, botPos(bot), out) } catch (_) { v = null }
      order.via = v
      order.viaDone = !v
    }
    const diverting = !order.viaDone && !!order.via
    const aim = diverting ? order.via : out
    const goal = diverting
      ? new goals.GoalNearXZ(aim.x, aim.z, 1)
      : new goals.GoalNear(aim.x, aim.y, aim.z, 1)
    const arrived = walkTo(bot, ctx, order, diverting ? 'comehome-via' : 'comehome-walk', goal, nearOut(aim, 1, diverting))
    if (order.phase === 'failed') {
      if (order.via && !order.viaDone) {
        order.phase = 'walk'
        order.stalls = 0
        order.fails = 0
        order.lastPos = null
        order.viaDone = true
        ctx.stepStatus = 'running'
        ctx.lastGoalKey = ''
        return
      }
      failMeet(bot, ctx, 'failed:cannot-reach-home')
      return
    }
    if (arrived) {
      if (order.via && !order.viaDone) {
        order.viaDone = true
        order.fails = 0
        ctx.lastGoalKey = ''
      } else order.phase = 'open'
    } else {
      // Same flat-run sprint as the night walk (rw4.10, in movementsFor);
      // no shelterRun stamp: the atl.12 gate only holds fight for work
      // steps, and the meet is an order — fight preempts it like
      // lead/bring/flat.
      return
    }
  }
  if (order.phase === 'open') {
    // No-dig released: the phase moved (the walk borrow is walk-scoped).
    try { body.claimBody(bot, ctx, (ctx.body && ctx.body.owner) || 'comehome') } catch (_) { /* lease best-effort */ }
    const door = doorBlock(bot, home)
    if (!door || doorOpen(door)) order.phase = 'enter'
    else if ((order.openTicks = (order.openTicks || 0) + 1) > OPEN_TICKS) {
      failMeet(bot, ctx, 'failed:door-stuck') // gohome's 1l9 cap (idkcraft-xhqv)
      return
    } else {
      tryToggle(bot, ctx, order, door)
      return
    }
  }
  if (order.phase === 'enter') {
    // One-sided like gohome: the whole body past the door plane, so 'close'
    // cannot shut the panel into the bot.
    const door = doorPos(home)
    const through = stepThrough(bot, ctx, order, [out, door, meet],
      (bp) => isInside(bot, home) && bp.z >= meet.z + 0.3, doorLaneDX(bot, home))
    if (order.phase === 'failed') {
      failMeet(bot, ctx, 'failed:cannot-reach-home')
      return
    }
    if (through) order.phase = 'close'
    else return
  }
  if (order.phase === 'seat') {
    // Ordered while inside but away from the meet cell (a v2 bedroom or the
    // partition row): walk the room to the common room — never hold a
    // bedroom (revmux 01 core-2). A* around the furniture; the door stays
    // whoever's it is.
    if (!isInside(bot, home)) {
      order.phase = 'walk'
      order.stalls = 0
      order.fails = 0
      order.lastPos = null
      order.via = undefined
      order.viaDone = false
      ctx.lastGoalKey = ''
      ctx.stepStatus = 'running'
      return
    }
    // Lease refresh pre-issue (the seat walk plans no-dig — explicit
    // borrow, the walk dispatches) + the shelter anchor for the
    // post-dispatch sprint gate.
    try { body.claimBody(bot, ctx, (ctx.body && ctx.body.owner) || 'comehome', { walk: true }) } catch (_) { /* lease best-effort */ }
    try { ctx.shelterLeg = meet } catch (_) { /* lease stash best-effort */ }
    // Arrival matches the settle radius (revmux jr2.3-02 body-2): a
    // tighter band strands a seat that stops in (1.2, 1.5] — inside the
    // room, failing 'cannot reach the common room'.
    const arrived = walkTo(bot, ctx, order, 'comehome-seat', new goals.GoalNear(meet.x, meet.y, meet.z, 1), (bp) => {
      try {
        const dx = bp.x - (meet.x + 0.5)
        const dz = bp.z - (meet.z + 0.5)
        return Math.hypot(dx, dz) <= SEAT_FAR
      } catch (_) { return false }
    })
    if (order.phase === 'failed') {
      failMeet(bot, ctx, 'failed:cannot-seat')
      return
    }
    if (arrived) arriveMeet(bot, ctx, order)
    return // (seat sprint runs in movementsFor off the stash above)
  }
  if (order.phase === 'close') {
    // A settle (ordered while already inside) holds as-is: the bot is home,
    // and the door belongs to whoever is using it — no toggle at air from
    // across the room, no panel shut in the owner's face. Far from the meet
    // cell it seats first (see above): v1 maxes at 1.41, so only v2
    // bedrooms and the partition row ever seat.
    const door = doorBlock(bot, home)
    if (!door && !order.settle) {
      failMeet(bot, ctx, 'failed:no-door')
      return
    }
    if (order.settle) {
      let far = false
      try {
        const bp = botPos(bot)
        far = !!bp && Math.hypot(bp.x - (meet.x + 0.5), bp.z - (meet.z + 0.5)) > SEAT_FAR
      } catch (_) { far = false }
      if (far) {
        order.phase = 'seat'
        order.stalls = 0
        order.fails = 0
        order.lastPos = null
        ctx.lastGoalKey = ''
        ctx.stepStatus = 'running'
        return
      }
      arriveMeet(bot, ctx, order)
      return
    }
    if (!doorOpen(door)) {
      arriveMeet(bot, ctx, order)
      return
    }
    tryToggle(bot, ctx, order, door)
  }
}

module.exports = { gohome, stay, shelter, comehome, releaseMeet, startMeet, isInside, meetPos, outLaneBlocked, exitDoorShut, SHELTER_RUN_FRESH_MS, nearestDry, dryStanceAt }
