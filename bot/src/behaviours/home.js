'use strict'

const Vec3 = require('vec3')
const { goals } = require('mineflayer-pathfinder')
const { goalFacts } = require('../goal')
const detour = require('../detour')
const stuck = require('../stuck')
const { botPos } = require('./util')
const body = require('../body')
const retreatMod = require('./retreat')
const recover = require('./recover')
const buildMod = require('./build')

// Night behaviours (bead rw4.5): gohome walks to the door, opens it, steps
// inside and closes it; stay holds the night, then leaves in the morning.
// mineflayer-pathfinder never opens doors (Movements.canOpenDoors=false),
// so both steps work the door themselves with bot.activateBlock. The
// doorway legs (enter/exit) also bypass the pathfinder entirely: with doors
// in blocksCantBreak (8si) the door cell reads unsafe and unbreakable, so
// A* can never route through it — the body sneaks the open doorway by
// direct control instead.
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

function doorOpen(block) {
  try {
    const props = block && typeof block.getProperties === 'function' && block.getProperties()
    return !!props && props.open === true
  } catch (_) {
    return false
  }
}

// Door-crossing lane (bv6): an open door leaves a 0.8125-wide gap beside its
// 0.1875 panel, so the 0.6 body crossing at cell centre clears the panel by
// ~1 cm — and a diagonal entry (the walk ends up to 1.5 off-centre, the legs
// cut corners at the 0.6 met radius) pushes the body INTO the panel face at
// a steep angle, where friction holds it: no slide, the unstick backs up and
// re-drives the same line, 60 ticks, failed:cannot-reach-home (two nights in
// a row on rig-m4, door left standing open). The lane is the free gap's
// centre — cell centre +/- half a panel — on the side AWAY from the open
// panel. Panel slices per mc-data collision boxes (prismarine-block): with
// open=true, north/left and south/right hug the west edge, north/right and
// south/left the east edge. North-wall doors cross along z, so only
// north/south facings lane; east/west (no z gap), closed, or unreadable
// doors read 0 and keep today's centre crossing.
const DOOR_LANE_DX = 0.09375
function doorLaneDX(bot, home) {
  try {
    const door = doorBlock(bot, home)
    if (!door || !doorOpen(door)) return 0
    const props = typeof door.getProperties === 'function' && door.getProperties()
    if (!props) return 0
    const { facing, hinge } = props
    if (facing !== 'north' && facing !== 'south') return 0
    if (hinge !== 'left' && hinge !== 'right') return 0
    // Open panel on the west slice -> lane east of centre, and vice versa.
    const panelWest = (facing === 'north') === (hinge === 'left')
    return panelWest ? DOOR_LANE_DX : -DOOR_LANE_DX
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
    // The new plan has no nodes yet: drop the previous behaviour's so the
    // sprint gate fails closed until path_update (follow.js 5vv mirror).
    ctx.lastPathNodes = null
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
    const arrived = walkTo(bot, ctx, st, diverting ? 'gohome-via' : 'gohome-walk', goal, nearOut(aim, 1))
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
      tryToggle(bot, st, door)
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
      tryToggle(bot, st, door)
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
    tryToggle(bot, st, door)
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
    const pa = st.pillarAt
    if (bp && pa && typeof pa.x === 'number' &&
      Math.hypot(bp.x - pa.x, bp.z - pa.z) > SHELTER_DISPLACE_XZ) {
      // Displaced past the anchor: drop the hold and the stale climb, and
      // re-pillar below. A foreign non-pillar episode is never touched.
      st.pillared = false
      st.pillarAt = null
      if (ctx.recovery && ctx.recovery.action === 'pillar_up') {
        try { ctx.recovery = null } catch (_) { /* release best-effort */ }
      }
      try { console.log('shelter displaced, re-pillaring') } catch (_) { /* log best-effort */ }
    }
  } catch (_) { /* anchor best-effort */ }
  if (!st.pillared) {
    // Climbing unsheltered (revmux 01 core-1): arming inShelter before the
    // pillar stands turns every fight tick idle at the ticker gate — and
    // stopOnce kills the pillar jump — freezing the climb on the first
    // hostile. Fight and the retreat chain run during the climb; the
    // shelter arms once the pillar stands.
    ctx.inShelter = false
    // A foreign live episode (a stuck flow's non-pillar prim) is never
    // touched: the hold is the point, the pillar best-effort.
    if (!ctx.recovery) {
      try { retreatMod.beginPillar(ctx, 'shelter', null) } catch (_) { /* episode best-effort */ }
      try {
        const bp0 = botPos(bot)
        if (bp0) st.pillarAt = { x: bp0.x, z: bp0.z }
      } catch (_) { /* anchor best-effort */ }
    }
    if (!ctx.recovery || ctx.recovery.action === 'pillar_up') {
      const before = ctx.recovery && ctx.recovery.status
      if (before === 'running' || before === 'starting' || before == null) {
        try { recover.run(bot, ctx) } catch (_) { /* prim best-effort */ }
      }
      const rec = ctx.recovery && ctx.recovery.status
      if (rec === 'running' || rec === 'starting' || rec == null) return // still climbing
      // Terminal verdict (pillar-wrapper mirror): pillared or not, the hold
      // starts — even a failed pillar beats the march. Release the episode
      // so a later stuck flow never adopts this stale record.
      if (rec !== 'done' && !st.pillarLogged) {
        st.pillarLogged = true
        try { console.log(`shelter pillar ${rec}, holding on the ground`) } catch (_) { /* log best-effort */ }
      }
      try { ctx.recovery = null } catch (_) { /* release best-effort */ }
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
  ctx.lastGoalKey = ''
  ctx.inShelter = true
}

// The order ends out loud (lead precedent): one chat line, then the body is
// released to the standing mode. The console keeps the machine reason.
function failMeet(bot, ctx, status) {
  const order = ctx && ctx.comehome
  if (order) order.phase = 'failed'
  ctx.stepStatus = status
  ctx.comehome = null
  try { body.claimBody(bot, ctx, (ctx.body && ctx.body.owner) || 'idle') } catch (_) { /* lease best-effort */ }
  ctx.shelterLeg = null
  try { bot.clearControlStates() } catch (_) { /* body best-effort */ }
  if (status === 'failed:cannot-seat') {
    try { bot.chat('cannot reach the common room') } catch (_) { /* chat best-effort */ }
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
    else {
      tryToggle(bot, order, door)
      return
    }
  }
  if (order.phase === 'exit') {
    const door = doorPos(home)
    const through = stepThrough(bot, ctx, order, [meet, door, out], (bp) => bp.z <= out.z + 0.7, doorLaneDX(bot, home))
    if (order.phase === 'failed') {
      const keepBy = order.by
      ctx.comehome = { ...freshGo(), by: keepBy, exiting: true, phase: 'open', home: order.home, reseek: order.reseek || false }
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
    tryToggle(bot, order, door)
  }
}

// 'Come home' order (jr2.3): the walk→open→enter→close wire mirrors gohome
// (same door primitives, same staging, same arrival predicates — only the
// meet target is named), then the bot HOLDS the common room until
// countermanded: day steps work the house through the walls and A* cannot
// route the doorway (see header), so ending the order inside would strand
// the next step digging through the wall. A move command while inside arms
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
      if (nightish && doorOpen(held) && !playerAtDoor(bot, home)) tryToggle(bot, order, held)
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
    const arrived = walkTo(bot, ctx, order, diverting ? 'comehome-via' : 'comehome-walk', goal, nearOut(aim, 1))
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
      tryToggle(bot, order, door)
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
    tryToggle(bot, order, door)
  }
}

module.exports = { gohome, stay, shelter, comehome, releaseMeet, startMeet, isInside, meetPos, SHELTER_RUN_FRESH_MS }
