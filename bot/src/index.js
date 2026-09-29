'use strict'

const mineflayer = require('mineflayer')
const Vec3 = require('vec3')
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder')
const { makeBrain, stubBrain, jevBrain, hybridBrain, sourceForUrl, JEV_ENDPOINT, isHard } = require('./brain')
const { findTarget, resolvePlayer, buildState, stateKey, isFightTarget, findCreeper, snapHostiles } = require('./perception')
const { makeScout, findNearest, loadedSearchRadius, startFarSearch, stepFarSearch } = require('./behaviours/scout')
const { createGreeter } = require('./greet')
const { addSwimExits, addSwimPrune } = require('./swim')
const { addNoCornerCut } = require('./nocorner')
const { addSnowGround } = require('./snow')
const { addJumpUpCost } = require('./jumpcost')
const { trackPlaced } = require('./behaviours/util')
const unpin = require('./unpin')
const decontact = require('./decontact')
const { helpReply, lookupCommand, detailLine } = require('./commands')
const metrics = require('./metrics')

const fightMod = require('./behaviours/fight')
const retreatMod = require('./behaviours/retreat')
const LAYA_URL_DEFAULT = 'http://laya:8000/v1/systemone'
function brainTimeoutMs(env) {
  const raw = parseInt((env && env.BRAIN_TIMEOUT_MS) || (env && env.BRAIN_TICK_MS) || '1000', 10)
  return Number.isFinite(raw) ? raw : 1000
}
const bringMod = require('./behaviours/bring')
const woolMod = require('./behaviours/wool')
const bedMod = require('./behaviours/bed')
const bedsMod = require('./behaviours/beds')
const craftanyMod = require('./behaviours/craftany')
const flatMod = require('./behaviours/flat')
const homeMod = require('./behaviours/home')
const buildMod = require('./behaviours/build')
const goal = require('./goal')
const memory = require('./memory')
const recover = require('./behaviours/recover')
const origEquipGear = fightMod.equipGear
fightMod.equipGear = function(bot) {
  if (bot && bot._tickerCtx && bot._tickerCtx.eatInFlight) return Promise.resolve()
  return origEquipGear(bot)
}

const BEHAVIOURS = {
  fight: fightMod,
  follow: require('./behaviours/follow'),
  roam: require('./behaviours/roam'),
  lead: require('./behaviours/lead'),
  gather: require('./behaviours/gather'),
  bring: bringMod,
  flat: flatMod,
  craft: require('./behaviours/craft'),
  equip: require('./behaviours/equip'),
  rest: require('./behaviours/rest'),
  gohome: homeMod.gohome,
  stay: homeMod.stay,
  comehome: homeMod.comehome,
  build: require('./behaviours/build'),
  beds: require('./behaviours/beds'),
  light: require('./behaviours/light'),
  explore: require('./behaviours/explore'),
  forage: require('./behaviours/forage'),
  deliver: require('./behaviours/deliver'),
  stockpile: require('./behaviours/stockpile'),
  gear: require('./behaviours/gear'),
  retreat: retreatMod.retreat,
  pillar: retreatMod.pillar,
  // Recovery primitives (ef3): one BEHAVIOURS line each, like goal steps.
  pillar_up: (bot, ctx) => recover.run(bot, ctx),
  dig_up: (bot, ctx) => recover.run(bot, ctx),
  water_up: (bot, ctx) => recover.run(bot, ctx),
  dig_step: (bot, ctx) => recover.run(bot, ctx),
  hop_step: (bot, ctx) => recover.run(bot, ctx),
  sidestep: (bot, ctx) => recover.run(bot, ctx),
  dig_through: (bot, ctx) => recover.run(bot, ctx),
  wait: (bot, ctx) => recover.run(bot, ctx),
  call_player: (bot, ctx) => recover.run(bot, ctx),
}

// Poll cadence when nobody is online: no JEV calls happen there, so waking
// up every 10 s just to re-scan the player list is plenty.
const IDLE_TICK_MS = 10000
const IDLE_LOG_MS = 60000
// Taking-fire memory (0ay): an hp drop counts as hostile fire for this
// long. Arrows land ~1/s and poison ticks every 1.25 s, so 5 s bridges a
// few quiet ticks without fleeing stale shadows.
const HURT_FRESH_MS = 5000
// Server-ping cadence while off the server (owner: rejoin ~5 s after the
// first player appears), and the nobody-online grace before the bot quits
// (one night-tick so a relogging player never sees it leave).
const JOIN_POLL_MS = 2000
// Quiet settle after the ping first sees a player: Paper's connection-throttle
// (default 4000 ms; the local test image uses the default) counts our status
// pings, so joining the instant a ping succeeds is kicked as throttled.
// 4500 ms clears the 4 s window with a small margin; typical join lands
// ~5.5 s after the first player (up to ~6.5 s worst case).
const JOIN_SETTLE_MS = 4500
const LEAVE_AFTER_MS_DEFAULT = 60000
const STAY_LOG_MS = 600000
function parseAutonomous(env) {
  const raw = String((env && env.BOT_AUTONOMOUS) || '').trim().toLowerCase()
  return raw === '1' || raw === 'true' || raw === 'yes'
}
// Laya address for the autonomous downgrade (dxl): BRAIN_URL only when it
// does NOT point at JEV — a JEV-configured BRAIN_URL would keep the paid
// brain running under a 'laya' label. Null means off.
function layaUrl() {
  const env = process.env && process.env.BRAIN_URL
  return env && sourceForUrl(env) !== 'jev' ? env : null
}
// Chat toggle outlives the ticker (dxl major): 'autonomous off' must survive
// the leave it causes, until container restart. Null = follow the env.
let autonomousOverride = null
function autonomousEffective(env) {
  if (autonomousOverride !== null) return autonomousOverride
  return parseAutonomous(env)
}
// Re-probe ceiling (ticks) for a given-up hostile: the world may change
// (bridged ravine, opened door), so a pursuit fight abandoned is retried
// from scratch this often. Lives here, not in fight.js — once the brain
// answers follow for an unreachable mob, fight stops being dispatched and
// its own counter would never advance.
const FIGHT_REPROBE_TICKS = 30
const TARGET_GONE_TICKS = 10
// Online-but-unseen ticks before walking back to world spawn (return-home):
// death+respawn at spawn, or walked out of entity range. Same 10-tick scale
// as the lead give-up. Spawn pre-arm uses blocks, not ticks (below).
const UNSEEN_HOME_TICKS = 10
// Adopt retries (idkcraft-im4): ready-but-doorless ticks before giving up
// to build. Door chunks trail the spawn block by seconds on a real
// server; 5 ticks cover the stream with a bounded fresh-world delay.
const ADOPT_GRACE = 5
const FAR_FROM_SPAWN = 64
// GoalNear range of the homing walk, and arrival radius for resuming work.
const RETURN_HOME_RANGE = 2
// Homing ticks with no displacement before the stuck fact (2oe): the same
// 10-tick budget as the gather walk stall detector.
const HOME_STALL_TICKS = 10
// A homing episode latches its release point; only walking this far from it
// re-arms another episode. Wider than one sidestep (2): walking back into
// the same wedge must not chat+ask every ~15 ticks (revmux round 3).
const HOME_LATCH_CLEAR = 4

// Eat reflex (3nt.22): natural regen needs food >= 18. Consumes the first
// edible item from inventory on the every-tick seam when food < 18 and no
// hostile is within swing reach. Equips food to hand, consumes, then
// restores gear via fightMod.equipGear.
const EDIBLE_FOODS = new Set([
  'bread',
  'cooked_beef',
  'cooked_porkchop',
  'cooked_chicken',
  'apple',
  'carrot',
  'baked_potato',
])

function installEquipGuard(bot, ctx) {
  if (!bot || bot._equipGuardInstalled) return
  const origEquip = bot.equip
  if (typeof origEquip !== 'function') return
  bot._equipGuardInstalled = true
  bot.equip = function(item, dest, ...args) {
    if (dest === 'hand' && ctx.eatInFlight && item && typeof item.name === 'string' && item.name.endsWith('_sword')) {
      return Promise.resolve()
    }
    return origEquip.call(this, item, dest, ...args)
  }
}

function eatReflex(bot, ctx, state) {
  installEquipGuard(bot, ctx)
  if (ctx.eatInFlight) return false
  if (typeof bot.food !== 'number' || bot.food >= 18) return false
  if (ctx.reflexSwung) return false
  const hostile = state && state.hostile
  if (hostile && hostile.isValid !== false) {
    let d = typeof state.hostile_distance === 'number' ? state.hostile_distance : null
    if (d === null) {
      try { d = bot.entity.position.distanceTo(hostile.position) } catch (_) {}
    }
    if (typeof d === 'number' && d <= fightMod.SWING_RANGE) return false
  }
  if (!bot.inventory || typeof bot.inventory.items !== 'function') return false
  let items
  try { items = bot.inventory.items() } catch (_) { return false }
  if (!Array.isArray(items)) return false
  const foodItem = items.find((i) => i && typeof i.name === 'string' && EDIBLE_FOODS.has(i.name))
  if (!foodItem) return false
  if (typeof bot.consume !== 'function') return false

  ctx.eatInFlight = true
  const prevFood = bot.food
  const doEat = async () => {
    try {
      if (typeof bot.equip === 'function') {
        try { await bot.equip(foodItem, 'hand') } catch (_) {}
      }
      await bot.consume()
      console.log(`eat ${foodItem.name} food=${prevFood}`)
    } catch (_) {
    } finally {
      ctx.eatInFlight = false
      try { fightMod.equipGear(bot) } catch (_) {}
    }
  }
  void doEat()
  return true
}

function createTicker({ bot, brain, tickMs = 1000, idleTickMs = IDLE_TICK_MS, followName = '', leaveAfterMs = 0, onLeave = null, now = () => Date.now(), brainEngine = '', greeter = null, autonomous = false }) {
  // Greeting gesture (v92): injectable for fake-clock tests, real otherwise.
  const greet = greeter || createGreeter()
  // ctx.brain feeds goal chooseStep; setBrain refreshes both this and the
  // decide closure below, so 'brain jev' steers step choice too.
  const ctx = { lastGoalKey: '', movements: null, paused: false, lead: null, leadStuck: 0, reflexTargetId: null, reflexSwung: false, stuckResets: 0, placeErrors: 0, eatInFlight: false, fleeTargetId: null, lastHostileSnap: null, work: false, step: '', stepStatus: null, goalText: null, brain, stuck: null, recovery: null, stuckTicks: 0, lastPos: null, homeStalls: 0, homeLastPos: null }
  ctx.greeter = greet // deliver greets arrivals through the same latch
  ctx.autonomous = !!autonomous
  ctx.manualBrain = null
  ctx.brainRestore = null
  ctx.rosterWasOnline = false
  ctx.exploreAloneRadius = goal.AUTONOMOUS_EXPLORE_RADIUS
  metrics.autonomous.set(ctx.autonomous ? 1 : 0)
  if (bot) {
    bot._tickerCtx = ctx
    installEquipGuard(bot, ctx)
    trackPlaced(bot, ctx) // idkcraft-drq: record own placements for the dig guard
  }
  let inFlight = false
  let lastTargetPos = null
  let lastVisible = true
  let lastIdleLog = 0
  let lastStateKey = null
  let lastDecision = null
  // Latest mineflayer-pathfinder status: 'path_update' carries
  // results.status (success|partial|timeout|noPath), 'path_reset' carries a
  // reason (stuck, dig_error, no_scaffolding_blocks, goal_moved, ...).
  // Facts about the body, logged on the decision line so a stall is diagnosable.
  ctx.lastPathStatus = 'none'
  ctx.lastPathReset = null

  // Suffix for every decision line. Existing fields and order are untouched
  // (prod greps 'decision source='). reset= clears after one log so a stale
  // reason does not repeat; path= persists until the next path_update.
  function pathSuffix() {
    let moving = false
    try {
      if (bot.pathfinder && typeof bot.pathfinder.isMoving === 'function') moving = !!bot.pathfinder.isMoving()
    } catch (_) { /* stationary default */ }
    const path = ctx.lastPathStatus || 'none'
    const reset = ctx.lastPathReset || 'none'
    ctx.lastPathReset = null
    return `moving=${moving} path=${path} reset=${reset}`
  }

  // Nobody-online streak: wall time since the first consecutive no-target
  // tick. When it reaches leaveAfterMs the ticker fires onLeave once (main()
  // quits there); a visible target resets the streak. Wall time, not
  // tick-counted: empty-server ticks can run at the fast 1 s cadence while
  // the melee reflex is swinging, so counting idleTickMs per tick would
  // expire the grace up to 10x early. 0 disables. `now` is injectable for
  // tests, like the scout seam.
  let emptySince = null
  let leaveFired = false
  function noteEmpty() {
    if (!leaveAfterMs) return
    const t = now()
    if (emptySince === null) emptySince = t
    if (!leaveFired && t - emptySince >= leaveAfterMs) {
      leaveFired = true
      if (typeof onLeave === 'function') {
        try { onLeave() } catch (err) { console.error(`onLeave error: ${err && err.message ? err.message : err}`) }
      }
    }
  }
  function noteSeen() {
    emptySince = null
    leaveFired = false
  }
  // Autonomous stay (dxl): with nobody to see, the bot does not arm a leave
  // at all — one log line per 10 minutes, wall-clocked on the same
  // injectable clock as the leave streak so fake-clock tests can observe it.
  let lastStayLog = -STAY_LOG_MS
  function noteStay() {
    const t = now()
    if (t - lastStayLog >= STAY_LOG_MS) {
      lastStayLog = t
      console.log('nobody online, staying (autonomous)')
    }
  }
  function noteGone() {
    if (ctx.autonomous) noteStay()
    else noteEmpty()
  }
  // Tear-down for the join loop: after our own quit() the old ticker must
  // not tick on (it would log stale idle lines, retain the dead bot's
  // chunks, and a late socket error would fatal-kill the new connection).
  function destroy() {
    destroyed = true
    if (timer) { clearTimeout(timer); timer = null }
    try { greet.cancel(bot) } catch (_) { /* sneak best-effort */ }
  }
  // Stand down after a re-check found someone online: re-arm the streak so
  // the next grace period is measured fresh from here.
  function rearm() {
    emptySince = null
    leaveFired = false
  }

  // mineflayer-pathfinder's stop() only sets a stopPathing flag that the
  // next setGoal consumes with the new goal — on an empty path with no goal
  // it latches and swallows the next goal, so skip it there. A live but
  // stationary goal (dynamic follow resting in range) still needs cancelling;
  // setGoal(null) clears it without latching. lastGoalKey still flips to
  // 'idle' for stop-once.
  // Return-home: after UNSEEN_HOME_TICKS online-but-unseen ticks, walk to
  // world spawn once (GoalNear keyed, so no re-issue) and keep standing
  // there until someone is visible. Returns true while homing (caller skips
  // stopOnce); pure stop otherwise. Fleeing still wins above.
  function walkHomeTick() {
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
    } else if (homeReached() || (ctx.homeLastPos && Math.hypot(bp.x - ctx.homeLastPos.x, bp.z - ctx.homeLastPos.z) > 0.5)) {
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

  function homeReached() {
    // The executor ends GoalNear on the floored block and stops at its
    // centre, up to ~2.5 blocks (float) from spawnPoint — agreeing with the
    // goal needs the +1.5 slack, not the raw range.
    const sp = bot.spawnPoint
    const bp = bot.entity && bot.entity.position
    return !!(sp && bp && Math.hypot(bp.x - sp.x, bp.y - sp.y, bp.z - sp.z) <= RETURN_HOME_RANGE + 1.5)
  }

  // work() body, shared with the homing resume below (one definition, so the
  // resume cannot drift from the chat command).
  // Night-step reset (rw4.5, revmux 01-review loop+goal-4): a stale
  // gohome/stay record (or shelter) must not survive an order, stop or fresh
  // work — the next decide re-arms from facts.
  function resetNightStep() {
    ctx.step = null
    ctx.stepStatus = null
    ctx.gohome = null
    ctx.stay = null
    ctx.inShelter = false
    wakeBody(bot) // jr2.2: an order takes the body even at night
    // The gohome walk borrows canDig=false on this shared object; an order,
    // stop or fresh work that ends the walk mid-phase must give it back, or
    // every other behaviour loses digging until rejoin (revmux 8kc).
    try {
      const mov = ctx.movements
      if (mov && typeof mov.canDig === 'boolean') mov.canDig = true
    } catch (_) { /* reset best-effort */ }
  }
  function startWork() {
    clearPendingSearch(ctx)
    clearStuck()
    resetNightStep()
    homeMod.releaseMeet(bot, ctx) // inside: the exit legs run before the first work path (jr2.3)
    if (ctx.bring) { metrics.bring.inc({ outcome: 'cancelled', kind: (ctx.bring && ctx.bring.kind) || 'block' }); ctx.bring = null; bringMod.clearSearchLeg(ctx) }
    ctx.flat = null
    ctx.work = true
    ctx.paused = false
    ctx.lead = null
    ctx.leadStuck = 0
    ctx.leadTargetGone = 0
    // p4s: 'go work'/'free'/'build here' revoke a HELD follow order — the
    // disk copy goes with it, or a restart resurrects an order the owner
    // cancelled. Only the live closure counts as held: a merely remembered
    // (restored, unadopted) name stays on disk for the next restart.
    const held = followName
    followName = ''
    if (held) {
      try { ctx.followName = null } catch (_) { /* follow best-effort */ }
      try { memory.save(bot, ctx) } catch (_) { /* memory best-effort */ }
    }
    ctx.lastGoalKey = ''
    ctx.gather = null
    ctx.forage = null // fresh episode: stale skips/finals must not veto it
    ctx.forageSkip = null
    ctx.forageFinal = null
    ctx.stepFail = {} // atl.4 hold is per-episode too: a stale failure must not veto the ordered retry
    ctx.resumeWork = false
  }

  function stopOnce() {
    if (ctx.lastGoalKey !== 'idle') {
      if (bot.pathfinder.isMoving()) bot.pathfinder.stop()
      else if (bot.pathfinder.goal) bot.pathfinder.setGoal(null)
      // Manual control states too (rw4.5 doorway sneak): the pathfinder
      // never clears them itself, so a parked bot would keep walking.
      try { bot.clearControlStates() } catch (_) { /* park best-effort */ }
      ctx.lastGoalKey = 'idle'
    }
  }

// Melee reflex (3nt.13): the arm is not the body. A hostile already
// within swing reach is hit every tick regardless of the brain answer —
// the same every-tick seam as scout. Runs on every tick path that has (or
// can cheaply build) hostile facts, including parked and nobody-online
// ticks. Logs at most one line per target; fight.js skips its own swing
// via ctx.reflexSwung so the rate stays one swing per tick.
function meleeReflex(bot, ctx, state) {
  // Every tick path that has facts passes here, so vitals are exported here too.
  metrics.setVitals(state)
  // Same seam for the death line's hostile snapshot (see deathLine): the
  // killer is often gone at the death tick (exploded creeper), so the last
  // tick's scan is the truthful one.
  try { ctx.lastHostileSnap = snapHostiles(bot) } catch (_) { /* snapshot best-effort */ }
  const hostile = state && state.hostile
  if (!hostile || hostile.isValid === false) return false
  let d
  try {
    d = bot.entity.position.distanceTo(hostile.position)
  } catch (_) { return false }
  if (typeof d !== 'number' || d > fightMod.SWING_RANGE) return false
  if (ctx.reflexTargetId !== hostile.id) {
    ctx.reflexTargetId = hostile.id
    try { fightMod.equipGear(bot) } catch (_) { /* fists are fine */ }
    console.log(`reflex swing ${hostile.name || 'mob'}`)
  }
  try { fightMod.swing(bot, hostile) } catch (_) { /* mock bots may lack lookAt/attack */ }
  metrics.events.inc({ event: 'reflex_swing' })
  ctx.reflexSwung = true // any target: the arm swung once this tick
  return true
}

// Creeper flee reflex (c2u): creepers are the one hostile the brain never
// sees (isFightTarget excludes them, so no hostile fact and no hard route),
// yet they kill. Within CREEPER_FLEE_RANGE the body walks away from the
// nearest creeper — an FSM rule, never an attack (hitting one near the
// player explodes it next to the player). Returns the creeper distance, or
// false when none is close.
// ponytail: no isHard 'creeper-near' case — the reflex already moves the
// body, so asking the model follow-vs-flee would add a wire case for zero gain.
const CREEPER_FLEE_RANGE = 6
const CREEPER_FLEE_DIST = 6
function fleeReflex(bot, ctx) {
  let creeper = null
  try { creeper = findCreeper(bot, CREEPER_FLEE_RANGE) } catch (_) { return false }
  if (!creeper) { ctx.fleeTargetId = null; return false }
  const bp = bot.entity && bot.entity.position
  if (!bp) return false
  let d
  try { d = bp.distanceTo(creeper.position) } catch (_) { return false }
  if (typeof d !== 'number') return false
  let dx = bp.x - creeper.position.x
  let dz = bp.z - creeper.position.z
  if (dx === 0 && dz === 0) dx = 1
  const len = Math.hypot(dx, dz)
  const nx = bp.x + (dx / len) * CREEPER_FLEE_DIST
  const nz = bp.z + (dz / len) * CREEPER_FLEE_DIST
  const key = `flee:${creeper.id}`
  let moving = false
  try { moving = !!(bot.pathfinder && typeof bot.pathfinder.isMoving === 'function' && bot.pathfinder.isMoving()) } catch (_) { /* stationary default */ }
  // Re-issue on a new creeper or a stalled executor (the creeper chases, so a
  // finished away-goal is stale); never tear down a running climb-out.
  if (key !== ctx.lastGoalKey || !moving) {
    bot.pathfinder.setGoal(new goals.GoalNear(nx, bp.y, nz, 1), false)
    ctx.lastGoalKey = key
  }
  if (ctx.fleeTargetId !== creeper.id) {
    ctx.fleeTargetId = creeper.id
    console.log(`reflex flee creeper dist=${d.toFixed(1)}`)
  }
  return d
}

  // Stillness fact for the stuck menu: consecutive ticks with no
  // horizontal displacement while the executor claims to move. Progress
  // clears a stale detector fact (but never a running episode).
  // Backstop goal (q0h): the stuck menu needs the walk target — read the live
  // pathfinder goal best-effort (the entity position, then the x/y/z snapshot).
  function backstopGoal() {
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
  function idleFarFromGoal(bp) {
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
    const gp = backstopGoal()
    if (!gp || !bp) return false
    let d = null
    try { d = Math.hypot(bp.x - gp.x, bp.y - gp.y, bp.z - gp.z) } catch (_) { return false }
    return typeof d === 'number' && d > 3
  }

  function noteDisplacement() {
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
        if (terminal && idleFarFromGoal(bp) && !latched) ctx.stuckTicks = (ctx.stuckTicks || 0) + 1
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

  // A hostile inside swing reach preempts recovery: the body fights first,
  // the stuck fact waits for the next tick.
  function urgentFight(state) {
    if (!state || !state.hostile || state.hostile.isValid === false) return false
    const d = state.hostile_distance
    if (typeof d !== 'number' || d > fightMod.SWING_RANGE) return false
    return state.hostile_reachable !== false
  }

  // Autonomous brain policy (dxl): alone, only free brains run. A jev
  // brain with an empty roster steps down to laya (BRAIN_URL) or off when
  // laya is not configured; a manually chosen jev returns on the next
  // roster join. Downgrade fires once per empty period (brainRestore latch),
  // restore clears the latch on every join.
  function autoBrain(rosterOnline) {
    if (!ctx.autonomous) return
    if (!rosterOnline && brainEngine === 'jev' && !ctx.brainRestore) {
      const url = layaUrl()
      const to = url ? 'laya' : 'off'
      const next = to === 'laya'
        ? hybridBrain(jevBrain(process.env.TYPESAFE_API_KEY, undefined, brainTimeoutMs(process.env), url))
        : stubBrain
      ctx.brainRestore = { from: 'jev', manual: ctx.manualBrain === 'jev' }
      doSetBrain(next, to)
      console.log(`brain auto to=${to} (nobody online)`)
      return
    }
    if (rosterOnline && !ctx.rosterWasOnline) {
      if (ctx.brainRestore && ctx.brainRestore.manual) {
        const next = hybridBrain(jevBrain(process.env.TYPESAFE_API_KEY, undefined, brainTimeoutMs(process.env), JEV_ENDPOINT))
        doSetBrain(next, 'jev')
        console.log('brain auto to=jev (player joined)')
      }
      ctx.brainRestore = null
    }
    ctx.rosterWasOnline = rosterOnline
  }

  function doSetBrain(b, label) {
    if (b) { brain = b; ctx.brain = b; if (label) brainEngine = label }
  }

  // A stale stuck fact must not survive a mode change: the goal it names
  // belongs to the previous order.
  function clearStuck() {
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

  // Greeting checks (v92): whoever the body approaches — the follow
  // target, or the bring recipient on the way back — is measured directly;
  // the module latches the far -> near edge. Only fighting or fleeing
  // suppress it (near a still player the stub says roam/idle, not follow).
  function greetCheck(decision) {
    if (decision.action === 'fight' || decision.action === 'flee' || decision.action === 'retreat') return
    // No greeting mid-recovery (ef3): the body belongs to the menu, and a
    // crouch would fight the primitive (jump/place/sneak conflict).
    if (ctx.stuck || ctx.recovery) return
    const bringing = decision.action === 'bring' && (decision.by || (ctx.bring && ctx.bring.by))
    const name = bringing || followName
    if (!name) return
    const ent = bot.players && bot.players[name] && bot.players[name].entity
    const bp = bot.entity && bot.entity.position
    if (!ent || !ent.position || !bp) return
    let d = null
    try {
      d = typeof bp.distanceTo === 'function'
        ? bp.distanceTo(ent.position)
        : Math.hypot(bp.x - ent.position.x, bp.y - ent.position.y, bp.z - ent.position.z)
    } catch (_) { return }
    let standing = false
    try { standing = !!(bot.pathfinder && typeof bot.pathfinder.isMoving === 'function' && !bot.pathfinder.isMoving()) } catch (_) { standing = false }
    greet.greetOnArrival(bot, name, d, standing)
  }

  function applyDecision(decision, target, state) {
    const handler = BEHAVIOURS[decision.action]
    if (typeof handler === 'function') {
      handler(bot, ctx, target, state)
    } else {
      stopOnce()
    }
    greetCheck(decision)
    // sprint stays on the decision line as the brain's opinion; the body
    // sprints only on flat follow pursuit (see follow.js).
    const dist = typeof state.distance_to_player === 'number' ? state.distance_to_player.toFixed(1) : 'none'
    console.log(`decision source=${decision.source} action=${decision.action} sprint=${decision.sprint} dist=${dist} ${pathSuffix()}`)
  }

  let timer = null
  let destroyed = false
  function scheduleNext(fast) {
    if (destroyed) return
    if (timer) { clearTimeout(timer); timer = null }
    timer = setTimeout(() => { timer = null; void tick(true) }, fast ? tickMs : idleTickMs)
    if (timer && typeof timer.unref === 'function') timer.unref()
  }

  // scheduled: true only for timer-driven ticks. A manual tick() (tests,
  // harness loops) must not arm the background timer — under contention a
  // shadow tick lands mid-loop and advances recovery without the harness
  // stepBody, which flaked the 9sh/pillar climb acceptances (8e9).
  async function tick(scheduled = false) {
    const endTimer = metrics.tickDuration.startTimer()
    const r = await runTick(scheduled)
    // Disk memory (idkcraft-hlk): one throttled write per window covers
    // every in-place store mutation (table claim, build done, arrival
    // scans, danger marks) with no per-store hooks. No world key (unit
    // mocks) or missing dir means a silent skip.
    try { memory.saveThrottled(bot, ctx) } catch (_) { /* memory best-effort */ }
    if (r.decision) {
      endTimer({ brain_called: String(r.calledBrain) })
      metrics.decisions.inc({ source: r.decision.source, action: r.decision.action })
    }
    return r
  }

  async function runTick(scheduled = false) {
    if (inFlight) { scheduleNext(lastVisible); return { decision: null, calledBrain: false } }
    inFlight = true
    // 0ay: tick-over-tick hp drops stamp taking-fire (unreachable archers,
    // poison, anything the FSM cannot see). The retreat trigger below reads
    // the stamp; nothing else does yet. Best-effort, never breaks the tick.
    try {
      if (typeof bot.health === 'number' && typeof ctx.lastTickHp === 'number' &&
        bot.health < ctx.lastTickHp - 0.5) ctx.lastHurtAt = Date.now()
      if (typeof bot.health === 'number') ctx.lastTickHp = bot.health
    } catch (_) { /* hurt tracking best-effort */ }
    // Hover-arrest watchdog (idkcraft-1cj): first in the tick — a pinned
    // body needs its decontact nudge in seconds, not after the brain. Sends
    // at most one cloned packet per second, only on the airborne + storm +
    // zero-disp signature; see unpin.js for the ceiling. Best-effort.
    try { unpin.unpinTick(bot, ctx, now()) } catch (_) { /* unpin best-effort */ }
    // canDig belongs to the gohome walk alone: any tick it does not own the
    // body gets the shared default back, so a mid-walk preemption (orders,
    // homing, death) cannot leak no-dig into other behaviours (revmux 8kc).
    // The come-home walk and seating borrow it the same way (jr2.3): without
    // the exemption the tick-start restore reopens the dig window for the
    // whole brain await (revmux 01 body-4).
    const meetDig = ctx.comehome && !ctx.comehome.exiting && (ctx.comehome.phase === 'walk' || ctx.comehome.phase === 'seat')
    if (!(ctx.work && ctx.step === 'gohome' && ctx.gohome && ctx.gohome.phase === 'walk') && !meetDig) {
      try {
        const mov = ctx.movements
        if (mov && typeof mov.canDig === 'boolean') mov.canDig = true
      } catch (_) { /* default best-effort */ }
    }
    // Sprint belongs to flat follow pursuit alone (5vv): any tick follow
    // does not own gets the shared default back, so a stolen body
    // (fight/bring) or a mode switch (work/stop) cannot inherit it and
    // sprint-jump into a +1 step (3nt.24).
    try {
      const smov = ctx.movements
      if (smov && typeof smov.allowSprinting === 'boolean') smov.allowSprinting = false
      // Planning rides the same object (5vv): a sprint window with parkour
      // on would plan 3-4 gap jumps the next sprint-off tick cannot run.
      if (smov && typeof smov.allowParkour === 'boolean') smov.allowParkour = true
    } catch (_) { /* default best-effort */ }
    // Far-search slices (amb): at most ~120ms CPU here, completion chats.
    try { await advancePendingSearch(bot, { setLead: (order) => { clearStuck(); ctx.lead = order; ctx.leadStuck = 0; ctx.leadTargetGone = 0; ctx.paused = false; if (ctx.bring) { metrics.bring.inc({ outcome: 'cancelled', kind: (ctx.bring && ctx.bring.kind) || 'block' }); ctx.bring = null; bringMod.clearSearchLeg(ctx) } resetNightStep(); homeMod.releaseMeet(bot, ctx) }, clearStuck: () => { clearStuck() } }, ctx) } catch (_) { /* search never breaks the tick */ }
    ctx.reflexSwung = false // fresh each tick: fight skips its swing once the reflex swung
    let calledBrain = false
    // Fast cadence while the reflex swings with nobody online: those ticks
    // make no brain call, so speeding them up costs nothing.
    let reflexFast = false
    // Fast cadence while working out of sight (see workAlone below): the
    // goal arbiter must keep deciding every tick, like a visible player.
    let workTickFast = false
    try {
      if (ctx.paused) {
        // 'stop' parks the bot: perception + scout keep running while a
        // player is visible, but the brain is skipped and idle is dispatched
        // (stop once) — same cost guard as 'no player online'. The only scan
        // with nobody online is the melee reflex hostile check below.
        const target = findTarget(bot, followName)
        lastVisible = !!target
        if (target) noteSeen()
        else noteGone()
        if (target) {
          const state = buildState(bot, target, lastTargetPos)
          lastTargetPos = state._lastTargetPos
          if (!ctx.scout && bot.registry) ctx.scout = makeScout(bot, { ctx })
          if (ctx.scout) ctx.scout.tick()
          meleeReflex(bot, ctx, state)
          eatReflex(bot, ctx, state)
        } else {
          try {
            const state = buildState(bot, null)
            if (meleeReflex(bot, ctx, state)) reflexFast = true
            eatReflex(bot, ctx, state)
          } catch (_) { /* facts best-effort */ }
          lastTargetPos = null
          lastDecision = null
          lastStateKey = null
        }
        // Parked but not dead: a hissing creeper still moves the body
        // (fast ticks while fleeing, same as the nobody-online path).
        const fledParked = fleeReflex(bot, ctx)
        if (fledParked) reflexFast = true
        else stopOnce()
        const now = Date.now()
        if (now - lastIdleLog >= IDLE_LOG_MS) {
          lastIdleLog = now
          console.log(`decision source=local-idle action=idle sprint=false dist=none ${pathSuffix()}`)
        }
        return { decision: { action: 'idle', sprint: false, source: 'local-idle' }, calledBrain: false }
      }
      const target = findTarget(bot, followName)
      lastVisible = !!target
      if (target) noteSeen()
      else noteGone()
      // A follow order owns the body the moment its player is visible: drop
      // work so the goal arbiter below cannot hijack the tick. A transition
      // out of work also ends any night step at once (same reset as an
      // order), so a borrowed canDig=false never survives the tick.
      if (target && followName && ctx.work) { ctx.work = false; resetNightStep() }
      // Work mode runs without a visible player while anyone is on the
      // server (roster, not visibility — walking out of render distance is
      // normal). Falls through to the normal path with target=null:
      // buildState handles null, and the work check below swaps idle steps.
      const rosterOnline = bot.players &&
        Object.keys(bot.players).some((n) => n !== bot.username)
      autoBrain(rosterOnline)
      // Alone-explore cap (dxl x atl.1): with nobody online the spiral must
      // not wander past AUTONOMOUS_EXPLORE_RADIUS — new chunks bloat the
      // host disk. explore.js defaults an untouched maxRadius to MAX_RADIUS
      // (the same 256), so only a live wider explore needs clamping.
      if (!rosterOnline && ctx.autonomous && ctx.explore) ctx.explore.maxRadius = ctx.exploreAloneRadius
      // A pending follow order beats working alone: the player explicitly
      // asked the bot to come, so reunion outranks cave work (3a7 keeps work
      // for an unseen follower; this walks instead once N trips). Pure work
      // mode with nobody waiting keeps running.
      const followWaiting = !target && followName && bot.players && bot.players[resolvePlayer(bot, followName)]
      // A visible player with skipped work resumes it at once (one-shot):
      // sighting is the normal end of the homing walk, arrival the other.
      if (target && ctx.resumeWork && !followName) startWork()
      if (target && !ctx.recovery && ctx.stuck && ctx.stuck.by === 'home') ctx.stuck = null
      if (homeReached()) {
        // At spawn there is nothing to walk for — unless a follow order is
        // pending: then keep the latch (counter tripped, no work) and stand
        // until the player is visible, instead of oscillating work-vs-home.
        // Arrived means the homing goal is met, not stuck: drop a stale home
        // fact (2oe) so the next sighting does not open a pointless episode.
        // (walkHomeTick never runs past arrival — unseen resets below.)
        if (!ctx.recovery && ctx.stuck && ctx.stuck.by === 'home') ctx.stuck = null
        if (ctx.recoverLatch && ctx.recoverLatch.by === 'home') ctx.recoverLatch = null
        if (!followWaiting) {
          if (ctx.resumeWork && !followName) startWork()
          ctx.unseenTicks = 0
        }
      } else if (!target && (rosterOnline || ctx.autonomous) && (!ctx.work || followWaiting) && !ctx.bring && !(ctx.flat && !ctx.flat.parked) && !ctx.comehome) {
        ctx.unseenTicks = (ctx.unseenTicks || 0) + 1
      } else ctx.unseenTicks = 0
      const homing = (ctx.unseenTicks || 0) >= UNSEEN_HOME_TICKS
      // An active bring-me owns the body like work-alone: the bot fetches up
      // to 48 blocks out, past entity-tracking range, so the idle branch must
      // not park it and the homing walk must not steal it mid-order. The
      // come-home meet rides the same way (jr2.3): the owner waits at home,
      // out of tracking range while the bot walks.
      const workAlone = (ctx.work || ctx.bring || (ctx.flat && !ctx.flat.parked) || ctx.comehome) && !target && (rosterOnline || ctx.autonomous) && !homing
      if (workAlone) workTickFast = true
      if (!target && !workAlone) {
        // Cost fix: nobody online => no brain call at all, decide idle
        // locally, stop once, and stay quiet (at most one line per minute).
        // A hissing creeper still moves the body (fast ticks while fleeing).
        const fledAlone = fleeReflex(bot, ctx)
        if (fledAlone) {
          reflexFast = true
        } else {
          // Homing owns the body now: end any night step at once (same
          // reset as an order), or the walk's borrowed canDig=false leaks
          // onto the shared Movements until someone comes into view.
          if (ctx.work && ctx.step === 'gohome') resetNightStep()
          if (!walkHomeTick()) stopOnce()
        }
        // Melee reflex at spawn: the brain never runs here, but a hostile
        // standing on the bot still gets swung at every slow tick.
        let idleState = null
        try {
          idleState = buildState(bot, null)
          if (meleeReflex(bot, ctx, idleState)) reflexFast = true
          eatReflex(bot, ctx, idleState)
        } catch (_) { /* facts best-effort */ }
        // Only the home fact: the idle branch is cost-guarded (no brain
        // calls with nobody online), so a pre-existing follow/gather
        // episode pauses while alone and resumes on sighting — while a
        // homing walk that wedged (2oe) reaches the menu here, same
        // routing as the target path above. After release the walk
        // re-issues (release clears lastGoalKey) and the latch admits one
        // episode per situation.
        if (ctx.stuck && ctx.stuck.by === 'home' && !urgentFight(idleState)) {
          try { greet.cancel(bot) } catch (_) { /* sneak best-effort */ }
          const decision = await recover.decide(bot, ctx, idleState, null)
          if (ctx.paused) {
            stopOnce()
            return { decision: { action: 'idle', sprint: false, source: 'local-idle' }, calledBrain: false }
          }
          applyDecision(decision, null, idleState)
          return { decision, calledBrain: false }
        }
        if (ctx.lead) {
          ctx.leadTargetGone = (ctx.leadTargetGone || 0) + 1
          if (ctx.leadTargetGone >= TARGET_GONE_TICKS) {
            bot.chat(`giving up on ${ctx.lead.name}; following you again`)
            ctx.lead = null
            ctx.leadStuck = 0
            ctx.leadTargetGone = 0
          }
        }
        lastTargetPos = null
        lastDecision = null
        lastStateKey = null
        const now = Date.now()
        if (now - lastIdleLog >= IDLE_LOG_MS) {
          lastIdleLog = now
          console.log(`decision source=local-idle action=idle sprint=false dist=none ${pathSuffix()}`)
        }
        return { decision: { action: 'idle', sprint: false, source: 'local-idle' }, calledBrain: false }
      }
      ctx.leadTargetGone = 0
      if (typeof bot.health === 'number' && bot.health <= 0) {
        if (ctx.lead) bot.chat('following you again')
        ctx.lead = null
        ctx.leadStuck = 0
      }
      const state = buildState(bot, target, lastTargetPos, ctx.fightGivenUpId)
      lastTargetPos = state._lastTargetPos
      // Feed fight's give-up latch back to the brain as hostile_reachable.
      // Keyed on the latched mob itself, not state.hostile: fight pursues the
      // sticky incumbent (ctx.fightId) while perception ranks nearest, and a
      // newcomer inside the sticky margin must not read as a stale latch —
      // clearing there would re-arm pursuit of the unreachable mob forever.
      if (ctx.fightGivenUpId != null) {
        const latched = bot.entities ? bot.entities[ctx.fightGivenUpId] : null
        if (!isFightTarget(latched, bot.entity.position, target && target.position)) {
          ctx.fightGivenUpId = null // stale: mob gone or no longer a candidate
          ctx.fightUnreachableTicks = 0
          state.hostile_reachable = true
        } else if (latched.position.distanceTo(bot.entity.position) <= BEHAVIOURS.fight.SWING_RANGE) {
          // Written-off mob in melee reach: report reachable so the brain
          // answers fight and fight.js swings via its given-up branch (which
          // clears the latch itself). The latch stays set — clearing here
          // would re-issue a pursuit goal at a mob already in reach.
          state.hostile_reachable = true
        } else if (state.hostile && state.hostile.id === ctx.fightGivenUpId) {
          ctx.fightUnreachableTicks = (ctx.fightUnreachableTicks || 0) + 1
          if (ctx.fightUnreachableTicks >= FIGHT_REPROBE_TICKS) {
            ctx.fightGivenUpId = null
            ctx.fightUnreachableTicks = 0
            state.hostile_reachable = true
          }
        } else {
          ctx.fightUnreachableTicks = 0
        }
      } else {
        ctx.fightUnreachableTicks = 0
      }
      // every-tick hooks (no body cost) go here
      if (!ctx.scout && bot.registry) ctx.scout = makeScout(bot, { ctx })
      if (ctx.scout) ctx.scout.tick()
      meleeReflex(bot, ctx, state)
      eatReflex(bot, ctx, state)
      // Safety preempts arbitration (and the lead order below): the brain
      // never sees creepers, so nothing else would move the body.
      const fleeDist = fleeReflex(bot, ctx)
      if (fleeDist !== false) {
        const fleePlayerDist = typeof state.distance_to_player === 'number' ? state.distance_to_player.toFixed(1) : 'none'
        console.log(`decision source=reflex action=flee dist=${fleePlayerDist} ${pathSuffix()}`)
        return { decision: { action: 'flee', sprint: false, source: 'reflex' }, calledBrain }
      }
      // Hard-case stuck (ef3): displacement watch + generic backstops, then
      // the recover menu owns the body. Detectors in the behaviours raise
      // ctx.stuck with the goal they pursued; place_error streaks and long
      // stillness while the executor claims to move raise it here. An urgent
      // fight skips recovery (safety beats escape) and the brain call is
      // skipped — the episode asks the model at decision points only.
      noteDisplacement()
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
          ctx.stuck = { by: 'no-displacement', goal: backstopGoal(), key: 'ticker' }
        }
      }
      let decision = null
      if (ctx.stuck && !urgentFight(state)) {
        try { greet.cancel(bot) } catch (_) { /* sneak best-effort */ }
        decision = await recover.decide(bot, ctx, state, target)
        if (ctx.paused) {
          // 'stop' landed during the recover await: same stale-decision
          // guard as after the brain await below.
          stopOnce()
          return { decision: { action: 'idle', sprint: false, source: 'local-idle' }, calledBrain }
        }
        applyDecision(decision, target, state)
        // Stuck recovery taking the tick ends a retreat episode like any
        // other non-chain dispatch (same release as the goal path).
        if (!ctx.paused) ctx.retreat = null
        return { decision, calledBrain }
      }
      const key = stateKey(state)
      if (lastDecision && key === lastStateKey) {
        decision = lastDecision
      } else {
        decision = await brain.decide(state)
        calledBrain = true
        // A stub-fallback means JEV failed; don't cache it or JEV would
        // never be retried while the player stands still.
        if (decision.source !== 'stub-fallback') {
          lastStateKey = key
          lastDecision = decision
        }
      }
      if (ctx.paused) {
        // 'stop' landed during the brain await: discard the stale decision
        // so one in-flight tick cannot issue a follow goal after the park.
        stopOnce()
        const now = Date.now()
        if (now - lastIdleLog >= IDLE_LOG_MS) {
          lastIdleLog = now
          console.log(`decision source=local-idle action=idle sprint=false dist=none ${pathSuffix()}`)
        }
        return { decision: { action: 'idle', sprint: false, source: 'local-idle' }, calledBrain }
      }
      // Come-home is an explicit player order like lead: it owns the body
      // above follow/work, except fight which still preempts. Placed before
      // lead so an armed doorway exit runs ahead of any new order's path.
      if (ctx.comehome && decision.action !== 'fight') {
        const handler = BEHAVIOURS.comehome
        if (typeof handler === 'function') handler(bot, ctx, target, state)
        const meetDist = typeof state.distance_to_player === 'number' ? state.distance_to_player.toFixed(1) : 'none'
        console.log(`decision source=${decision.source} action=comehome sprint=${decision.sprint} dist=${meetDist} ${pathSuffix()}`)
        return { decision: { ...decision, action: 'comehome' }, calledBrain }
      }
      if (ctx.lead && decision.action !== 'fight') {
        // Lead is an explicit player order: it overrides the brain like
        // 'stop' does, but fight still preempts (safety beats errands).
        const handler = BEHAVIOURS.lead
        if (typeof handler === 'function') handler(bot, ctx, target, state)
        const leadDist = typeof state.distance_to_player === 'number' ? state.distance_to_player.toFixed(1) : 'none'
        console.log(`decision source=${decision.source} action=lead sprint=${decision.sprint} dist=${leadDist} ${pathSuffix()}`)
        return { decision: { ...decision, action: 'lead' }, calledBrain }
      }
      // Bring-me is an explicit player order like lead: it owns the body
      // above work, except fight which still preempts. Placed after lead
      // so the newest order wins its ticks.
      if (ctx.bring && decision.action !== 'fight') {
        const handler = BEHAVIOURS.bring
        // Greeting on the way back (v92): snapshot before awaiting — the
        // toss lands on a microtask and clears ctx.bring before the check.
        const bringBy = ctx.bring.phase === 'return' ? ctx.bring.by : null
        if (typeof handler === 'function') await handler(bot, ctx, target, state)
        if (bringBy) greetCheck({ action: 'bring', by: bringBy })
        const bringDist = typeof state.distance_to_player === 'number' ? state.distance_to_player.toFixed(1) : 'none'
        console.log(`decision source=${decision.source} action=bring sprint=${decision.sprint} dist=${bringDist} ${pathSuffix()}`)
        return { decision: { ...decision, action: 'bring' }, calledBrain }
      }
      // Flat is an explicit player order like lead/bring: it owns the body
      // above work, except fight which still preempts. Placed after
      // lead/bring so a short errand preempts the long job tick-by-tick and
      // the job resumes when the errand ends (only a mode change clears it).
      // A parked episode (stop) never dispatches: any order that unparks the
      // body (bring/share/lead) must not resurrect it — only `flat` resumes.
      if (ctx.flat && !ctx.flat.parked && decision.action !== 'fight') {
        const handler = BEHAVIOURS.flat
        if (typeof handler === 'function') handler(bot, ctx, target, state)
        const flatDist = typeof state.distance_to_player === 'number' ? state.distance_to_player.toFixed(1) : 'none'
        console.log(`decision source=${decision.source} action=flat sprint=${decision.sprint} dist=${flatDist} ${pathSuffix()}`)
        return { decision: { ...decision, action: 'flat' }, calledBrain }
      }
      // Work mode (epic rw4) owns the body like an order: the goal arbiter
      // picks the step, except fight which still preempts (safety beats work).
      // Placed after lead so an explicit find-me order wins its ticks.
      // atl.12 + rw4.10 split: a live night shelter-run holds fight
      // preemption like shelter — stopping to fight every mob on the way
      // home is how the bot dies outside (prod: 68% of deaths at night,
      // 57% gohome-active). gohome stamps ctx.shelterRun on every night
      // walk tick; while the stamp is fresh the work step below keeps
      // walking (melee reflex defends) instead of engaging, and a stalled
      // walk lets it go stale so fight resumes. Nobody-visible only
      // (player protection still fights), no shelter/lead/bring override:
      // an explicit order owns fight ticks exactly as before, so a fresh
      // stamp can neither starve an order nor leak the walk's no-dig into
      // order pathing. Dormant until rw4.10 lands (the export reads
      // undefined and no stamp is ever fresh).
      const runFreshMs = homeMod.SHELTER_RUN_FRESH_MS || 0
      const stampFresh = typeof ctx.shelterRun === 'number' && (Date.now() - ctx.shelterRun) < runFreshMs
      if (!stampFresh) ctx.shelterRunLogged = false
      const shelterRun = ctx.work && !ctx.lead && !ctx.bring && !ctx.inShelter &&
        decision.action === 'fight' && !target && stampFresh
      if (shelterRun && !ctx.shelterRunLogged) {
        console.log('shelter-run: holding fight preemption, walking home')
        ctx.shelterRunLogged = true
      }
      if (ctx.inShelter && decision.action === 'fight') {
        // Sheltered for the night: no pursuit through our own wall (the
        // pathfinder would dig it with canDig). The melee reflex above
        // still swings at anything that gets inside.
        stopOnce()
        console.log(`decision source=${decision.source} action=shelter dist=none ${pathSuffix()}`)
        return { decision: { action: 'idle', sprint: false, source: 'local-idle' }, calledBrain }
      }
      // 0ay: taking fire from an unreachable hostile (arrows across a gap
      // drain a bot the FSM idles — prod 11:50: 20 to 6.8 in 18 s standing
      // still). Alone, close (<=8, the perception fight radius), hurt
      // within HURT_FRESH_MS: fight ticks divert into the work block so
      // the retreat leg below runs instead of the give-up shadow-stand.
      // Orders still own their ticks (no starve, no no-dig leak — same
      // gate as the atl.12 shelter hold); shelter never diverts.
      const hurtFresh = typeof ctx.lastHurtAt === 'number' && (Date.now() - ctx.lastHurtAt) < HURT_FRESH_MS
      const underFire = !ctx.inShelter && !ctx.lead && !ctx.bring && !target &&
        state.hostile_reachable === false &&
        typeof state.hostile_distance === 'number' && state.hostile_distance <= 8 && hurtFresh
      if (!hurtFresh) ctx.underFireLogged = false
      if (ctx.work && (decision.action !== 'fight' || shelterRun || underFire)) {
        if (!ctx.home && !ctx.adoptDone) {
          // Spawn adoption races chunk loading (one shot at join sees an
          // empty world): hold work until the spawn block is visible, then
          // adopt before build defaults a fresh site. Readiness needs
          // positive evidence once a spawn is known; without a spawn yet
          // (or without a blockAt hook, i.e. unit mocks) adoption no-ops,
          // so work proceeds and the one shot waits for the spawn below.
          // im4: a VISIBLE spawn block does not mean the door chunks (12
          // blocks off) have streamed — the old adopt-once missed forever
          // (2/5 live-assay bots). Retry while the miss may be streaming,
          // then give up to build. Retry needs a world that can stream
          // (all three hooks); hook-less mocks keep the old immediate
          // path, so unit timing is untouched.
          const canStream = !!(bot.blockAt && bot.spawnPoint && bot.findBlocks)
          let ready = true
          try { if (bot.blockAt && bot.spawnPoint) ready = !!bot.blockAt(bot.spawnPoint) } catch (_) { ready = true }
          if (!ready && (ctx.adoptTries = (ctx.adoptTries || 0) + 1) <= 60) {
            if (ctx.adoptTries <= 1) console.log('waiting for spawn chunks before work')
            return { decision: { action: 'idle', sprint: false, source: 'local-idle' }, calledBrain }
          }
          let foundEarly = null
          try {
            foundEarly = goal.adoptHome(bot)
          } catch (_) { foundEarly = null }
          if (foundEarly) {
            ctx.adoptDone = true
            // Same resets as setHome below (no ticker handle in this scope).
            ctx.home = foundEarly; ctx.buildSkip = []; ctx.buildFails = 0; ctx.buildFailIdx = -1; ctx.buildGoalIdx = -1; ctx.buildFarIdx = -1
            try { memory.save(bot, ctx) } catch (_) { /* memory best-effort */ }
          } else if (!canStream || !ready || (ctx.adoptReadyMisses = (ctx.adoptReadyMisses || 0) + 1) > ADOPT_GRACE) {
            // Give up to build: a mock that never streams, patience out
            // without readiness, or grace exhausted.
            ctx.adoptDone = true
          } else {
            if (ctx.adoptReadyMisses <= 1) console.log('waiting for home chunks before work')
            // A returned decision is not dispatched: stop a live goal (e.g.
            // a follow the owner just revoked with 'go work') or it keeps
            // driving the body through the grace (revmux 01 minor).
            try { stopOnce() } catch (_) { /* stop best-effort */ }
            return { decision: { action: 'idle', sprint: false, source: 'local-idle' }, calledBrain }
          }
        }
        // Retreat chain (1tj): a vetoed follow at low health with a hostile
        // on the bot means the FSM idles and the bot dies standing (gat).
        // 0ay extends it to taking fire from an unreachable hostile (the
        // underFire divert above): same chain — run/pillar breaks the line
        // of fire; a miss falls through to goal.decide, i.e. the old
        // behaviour. The engage log fires only on a dispatched pick, so an
        // empty menu or a declined chain never claims a retreat.
        if ((decision.source === 'fsm-noplayer' && !ctx.inShelter && isHard(state) === 'low-health-hostile') || underFire) {
          const retreat = await retreatMod.chooseRetreat(ctx.brain, bot, ctx, state)
          if (retreat) {
            if (ctx.paused || !ctx.work) {
              // 'stop' (or a mode change) landed during the chain await:
              // same stale-decision guard as after the goal await below.
              stopOnce()
              return { decision: { action: 'idle', sprint: false, source: 'local-idle' }, calledBrain }
            }
            if (underFire && !ctx.underFireLogged) {
              console.log('taking-fire: unreachable hostile and fresh hurt, retreating')
              ctx.underFireLogged = true
            }
            const rd = { action: retreat.action, sprint: false, source: retreat.source }
            ctx.step = retreat.action
            applyDecision(rd, target, state)
            return { decision: rd, calledBrain }
          }
        }
        decision = await goal.decide(bot, ctx)
        if (ctx.paused || !ctx.work) {
          // 'stop' (or a mode change) landed during the goal await: same
          // stale-decision guard as after the brain await above.
          stopOnce()
          return { decision: { action: 'idle', sprint: false, source: 'local-idle' }, calledBrain }
        }
        applyDecision(decision, target, state)
        // Stale-built revalidation (idkcraft-hlf): an adopt that ran while
        // one plan cell read missing (mid-build, mid-repair, dark chunk)
        // froze built=false, and the build menu goes infeasible on an empty
        // remainder — so the build step that would flip it never runs and
        // the work flow sits on the site stage forever. Re-check the
        // remainder (minus given-up cells) after every work dispatch; a
        // complete house flips here with the same effects as the build
        // step's own done branch (table claim, save, announce). Post-apply
        // on purpose: normal completions still flow through the build
        // behaviour (which flips first), so only genuinely stuck flags —
        // where build was never dispatched — ever reach this branch.
        if (ctx.home && ctx.home.site && !ctx.home.built) {
          let complete = false
          try {
            complete = buildMod.nextCellIdx(bot, ctx.home, ctx.buildSkip) === -1
          } catch (_) { complete = false }
          if (complete) {
            try {
              if (!ctx.home.table && buildMod.cellDone(bot, ctx.home, buildMod.blueprintFor(ctx.home)[0])) {
                const t = buildMod.blueprintFor(ctx.home)[0]
                ctx.home.table = new Vec3(ctx.home.site.x + t.dx, ctx.home.site.y + t.dy, ctx.home.site.z + t.dz)
              }
            } catch (_) { /* claim best-effort */ }
            ctx.home.built = true
            try { memory.save(bot, ctx) } catch (_) { /* memory best-effort */ }
            const s = ctx.home.site
            try { bot.chat(`home done at ${s.x} ${s.y} ${s.z}`) } catch (_) { /* chat best-effort */ }
          }
        }
        // The chain owns ctx.retreat only across its own dispatches: any other
        // step taking the tick ends the episode, so the next veto re-chains
        // instead of holding a stale pick (live 1tj: an unfinished flee
        // survived into rest, then held and pillar was never asked).
        if (!ctx.paused && ctx.work) ctx.retreat = null
        return { decision, calledBrain }
      }
      applyDecision(decision, target, state)
      // Non-chain dispatch releases retreat ownership (see goal path).
      if (!ctx.paused) ctx.retreat = null
      return { decision, calledBrain }
    } catch (err) {
      console.error(`tick error: ${err && err.message ? err.message : err}`)
      return { decision: null, calledBrain }
    } finally {
      inFlight = false
      if (scheduled) scheduleNext(lastVisible || reflexFast || workTickFast)
    }
  }

  return {
    tick,
    setPathStatus: (status) => { ctx.lastPathStatus = status || 'none' },
    // Head of the latest plan (b50): the executor works this list from
    // [0] down, so the wedge line can name the terrain it faces.
    setPathNext: (n) => { ctx.lastPathNext = n && typeof n.clone === 'function' ? n.clone() : (n && typeof n.x === 'number' ? { x: n.x, y: n.y, z: n.z } : null) },
    // Sprint lookahead window (5vv): the first nodes of the latest plan,
    // plain coords — follow reads numbers only. Cleared on a new goal.
    setPathNodes: (arr) => { ctx.lastPathNodes = Array.isArray(arr) ? arr.slice(0, 8).map((n) => (n && typeof n.x === 'number' ? { x: n.x, y: n.y, z: n.z } : null)).filter(Boolean) : null },
    // place_error streaks (tower attempts into the same cell while a previous
    // placeBlock still awaits blockUpdate): consecutive only — any other
    // reset reason breaks the streak. Behaviours treat N>=3 with no
    // displacement as a stall, the shared fact the hard-case stuck menu needs.
    setPathReset: (reason) => {
      ctx.lastPathReset = reason || null
      if (reason === 'stuck') ctx.stuckResets = (ctx.stuckResets || 0) + 1
      if (reason === 'place_error') ctx.placeErrors = (ctx.placeErrors || 0) + 1
      else ctx.placeErrors = 0
    },
    start: () => scheduleNext(true),
    // ponytail: sprint-jump wedges the bot flush against a 1-block step
    // (sprint speed reaches the face before the queued jump lifts off, so
    // physics resolves vel.y=0 with onGround=false and no later jump can
    // fire). Hold the flag off here — the single write site — so neither
    // applyDecision nor the lead branch can re-enable it per tick; sprint on
    // the decision line stays the brain's opinion only. Upgrade path: sprint
    // only on flat segments: follow.js toggles it per tick on far level
    // pursuit (5vv), and runTick restores the default on every other tick.
    setMovements: (m) => { if (m) { m.allowSprinting = false; addSwimExits(m); addSwimPrune(m); addNoCornerCut(m); addSnowGround(m); addJumpUpCost(m) } ctx.movements = m; bot.pathfinder.setMovements(m) },
    destroy,
    rearm,
    setFollow: (name) => {
      clearPendingSearch(ctx)
      clearStuck()
      resetNightStep()
      if (ctx.bring) { metrics.bring.inc({ outcome: 'cancelled', kind: (ctx.bring && ctx.bring.kind) || 'block' }); ctx.bring = null; bringMod.clearSearchLeg(ctx) }
      ctx.flat = null
      ctx.inShelter = false
      homeMod.releaseMeet(bot, ctx) // inside: the exit legs run before the first follow path (jr2.3)
      const real = resolvePlayer(bot, name)
      followName = real
      try { ctx.followName = real || null } catch (_) { /* follow best-effort */ }
      try { memory.save(bot, ctx) } catch (_) { /* memory best-effort */ }
      const seen = !real || (bot.players && bot.players[real] && bot.players[real].entity)
      if (!real || seen) ctx.work = false
      ctx.lastGoalKey = ''
      ctx.lead = null
      ctx.leadStuck = 0
      ctx.leadTargetGone = 0
      if (real) ctx.paused = false
    },
    // Work mode (epic rw4): autonomous goal steps until follow me / stop.
    work: () => { startWork() },
    // Home site (epic rw4.4): 'build here' and spawn adoption replace the
    // site. Build progress resets with it — old skips/fail counts belong
    // to the old origin. The facts text (home none->site) re-decides.
    home: () => ctx.home || null,
    setHome: (home) => {
      // A standing meet releases against the OLD house first: the exit legs
      // run against the pinned order.home, and the shelter refresh lands in
      // startWork's release right after (revmux 01 core-1). No meet: no-op.
      homeMod.releaseMeet(bot, ctx)
      // Same-site bed claims ride across the swap (idkcraft-ybt): a fresh
      // adopt object at the same site would otherwise drop sleptA until the
      // next sleep. A new site keeps its dropped claims (new bedrooms).
      try { if (home) bedsMod.migrateClaims(ctx.home, home) } catch (_) { /* claims best-effort */ }
      ctx.home = home || null; ctx.inShelter = false; ctx.buildSkip = []; ctx.buildFails = 0; ctx.buildFailIdx = -1; ctx.buildGoalIdx = -1; ctx.buildFarIdx = -1; try { memory.save(bot, ctx) } catch (_) { /* memory best-effort */ }
    },
    // Disk memory (idkcraft-hlk): explicit seams for load-before-adopt and
    // save-on-exit; the periodic tick save covers the rest.
    loadMemory: () => { try { return memory.restore(bot, ctx) } catch (_) { return null } },
    saveMemory: () => { try { return memory.save(bot, ctx) } catch (_) { return false } },
    stop: () => {
      clearPendingSearch(ctx)
      clearStuck()
      resetNightStep()
      if (ctx.bring) { metrics.bring.inc({ outcome: 'cancelled', kind: (ctx.bring && ctx.bring.kind) || 'block' }); ctx.bring = null; bringMod.clearSearchLeg(ctx) }
      // ctx.flat survives stop as a parked episode: the next `flat` resumes
      // it instead of re-scanning (w52 resumable job). The parked flag (not
      // just paused) gates the dispatch, so an unrelated order that unparks
      // the body cannot resurrect the job on its own (core-1).
      if (ctx.flat) ctx.flat.parked = true
      ctx.paused = true
      ctx.work = false
      ctx.lead = null
      ctx.leadStuck = 0
      ctx.leadTargetGone = 0
      stopOnce()
    },
    setLead: (order) => { clearStuck(); resetNightStep(); homeMod.releaseMeet(bot, ctx); ctx.lead = order; ctx.leadStuck = 0; ctx.leadTargetGone = 0; ctx.paused = false; if (ctx.bring) { metrics.bring.inc({ outcome: 'cancelled', kind: (ctx.bring && ctx.bring.kind) || 'block' }); ctx.bring = null; bringMod.clearSearchLeg(ctx) } },
    clearLead: (player) => {
      // A pending far search dies with the asker (or with the bot, when no
      // player is named) — never with an unrelated player logging off.
      if (!player || (ctx.pendingSearch && ctx.pendingSearch.by === player.username)) clearPendingSearch(ctx)
      const targetName = followName || (ctx.lead && ctx.lead.by)
      if (player && targetName && player.username && player.username !== targetName) return
      if (ctx.lead && !player) bot.chat('following you again')
      clearStuck()
      ctx.lead = null
      ctx.leadStuck = 0
      ctx.leadTargetGone = 0
    },
    getLead: () => ctx.lead,
    cancelGreet: () => { try { greet.cancel(bot) } catch (_) { /* sneak best-effort */ } },
    noteDeath: () => { try { ctx.deaths = (ctx.deaths || 0) + 1 } catch (_) { /* counter best-effort */ } },
    getFollowName: () => followName,
    getBrainEngine: () => brainEngine,
    setBrain: (b, label) => { doSetBrain(b, label) },
    // Autonomous toggle (dxl): chat lives until container restart, the
    // permanent default is the BOT_AUTONOMOUS env (owner sets it).
    setAutonomous: (on) => {
      ctx.autonomous = !!on
      autonomousOverride = !!on
      metrics.autonomous.set(ctx.autonomous ? 1 : 0)
      if (!on) return 'autonomous off'
      let r = 'autonomous on — stays without players until restart (permanent: BOT_AUTONOMOUS env)'
      if (brainEngine === 'jev') {
        r += layaUrl()
          ? ' — brain is jev now, laya without players'
          : ' — brain is jev now, off without players (laya not configured)'
      }
      return r
    },
    // Bring-me order creation: find + tool checks answer in this tick (like
    // find-me); the behaviour only walks, digs, returns and tosses.
    // Share (idkcraft-ah9): hand over everything carried except tools,
    // weapons, armour and the 32-block pillar reserve. Same body slot as
    // bring (priority, stop, metrics) with kind 'share'; the behaviour
    // walks to the speaker and tosses, like the bring return.
    setShare: ({ by }) => {
      clearPendingSearch(ctx)
      resetNightStep()
      let items = []
      try {
        items = bot && bot.inventory && typeof bot.inventory.items === 'function' ? bot.inventory.items() : []
      } catch (_) { items = [] }
      const plan = bringMod.sharePlan(items)
      if (plan.length === 0) return 'nothing to share'
      homeMod.releaseMeet(bot, ctx) // inside: the exit legs run before the return walk (jr2.3)
      if (ctx.lead) { ctx.lead = null; ctx.leadStuck = 0; ctx.leadTargetGone = 0 }
      ctx.unseenTicks = 0
      ctx.resumeWork = false
      clearStuck()
      ctx.bring = {
        kind: 'share', name: 'share', by, phase: 'return',
        items: plan, saidWaiting: false, announced: true,
      }
      ctx.paused = false
      return null
    },
    setBring: ({ name, want, by }) => {
      clearPendingSearch(ctx)
      resetNightStep()
      if (bringMod.isFoodRequest(name)) {
        if (ctx.lead) { ctx.lead = null; ctx.leadStuck = 0; ctx.leadTargetGone = 0 }
        ctx.unseenTicks = 0
        ctx.resumeWork = false
        const n = want || bringMod.WANT_FOOD
        const have = bringMod.findEdible(bot)
        if (have) {
          const give = Math.min(have.count, n)
          clearStuck()
          homeMod.releaseMeet(bot, ctx)
          ctx.bring = {
            kind: 'food', name: 'food', want: n, by, drop: have.name, have: give,
            phase: 'return', saidWaiting: false, announced: true,
          }
          ctx.paused = false
          return `coming with ${give} ${have.name}`
        }
        clearStuck()
        homeMod.releaseMeet(bot, ctx)
        ctx.bring = {
          kind: 'food', name: 'food', want: n, by, drop: null, have: 0,
          phase: bringMod.openPhase(ctx), announced: false, animal: null,
        }
        ctx.paused = false
        return 'looking for animals'
      }
      // Item ladder (did.1): the pack first — the bot may already hold what
      // the player wants, even when the world holds no such block. A short
      // pack still falls through for diggable names: the block path tops up
      // from the chest and mines the rest, as before.
      const resolved = bringMod.resolveItem(bot, name)
      const need = want || bringMod.WANT_ORE
      const plan = resolved ? bringMod.planItemGive(bot, resolved, need) : null
      const worldFallback = resolved ? bringMod.canBringName(bot, name) : false
      const openPackOrder = () => {
        if (ctx.lead) { ctx.lead = null; ctx.leadStuck = 0; ctx.leadTargetGone = 0 }
        ctx.unseenTicks = 0
        ctx.resumeWork = false
        clearStuck()
        homeMod.releaseMeet(bot, ctx)
        ctx.bring = {
          kind: 'item', name: resolved.family, names: resolved.names, want: need, by,
          items: plan.items, drop: plan.items[0].name, have: plan.have,
          phase: 'return', saidWaiting: false, announced: true,
        }
        ctx.paused = false
        const desc = plan.items.map((i) => `${i.count} ${i.name}`).join(', ')
        return plan.have >= need ? `coming with ${desc}` : `only ${desc}, coming`
      }
      // A short wool pack falls through to the chest and mob rungs instead
      // of giving partial (did.3): toWoolHunt counts the pack stock toward
      // the want, and the sheep top it up.
      if (plan && plan.have > 0 && (plan.have >= need || (!worldFallback && !woolMod.isWoolFamily(resolved)))) return openPackOrder()
      // Orders carry the canonical family name, so 'beds' reads as 'bed'
      // everywhere. The chest rung runs for every name with no diggable world
      // form — including exact block names like white_wool, dirt or torch.
      const keptName = plan && plan.keptOnly ? resolved.family : null
      if (resolved && !worldFallback && ctx.home && ctx.home.chest) {
        if (ctx.lead) { ctx.lead = null; ctx.leadStuck = 0; ctx.leadTargetGone = 0 }
        ctx.unseenTicks = 0
        ctx.resumeWork = false
        clearStuck()
        homeMod.releaseMeet(bot, ctx)
        ctx.bring = {
          kind: 'item', name: resolved.family, names: resolved.names, want: need, by,
          items: [], drop: null, have: 0, packBase: bringMod.packCounts(bot),
          phase: 'chestfetch', announced: true, keptName,
        }
        ctx.paused = false
        return `checking the home chest for ${resolved.family}`
      }
      // Mob rung (did.3): wool the pack and chest could not fill comes
      // from sheep — after the chest rung, before the block path (wool
      // blocks are never diggable, so the block rung cannot serve wool).
      if (resolved && woolMod.isWoolFamily(resolved)) {
        if (ctx.lead) { ctx.lead = null; ctx.leadStuck = 0; ctx.leadTargetGone = 0 }
        ctx.unseenTicks = 0
        ctx.resumeWork = false
        clearStuck()
        ctx.bring = bringMod.toWoolHunt(bot, {
          kind: 'item', name: resolved.family, names: resolved.names,
          want: need, by, drop: null, have: 0,
        })
        ctx.paused = false
        const c = ctx.bring.color
        return c ? `looking for ${c} sheep` : 'looking for sheep'
      }
      // Craft rung (did.2): pack mats plus a recipe beat the block search
      // for names with no diggable form — torch resolves as a block but is
      // never bringable, so without this it dies 'ores and logs only'.
      // Uncraftable names fall through to the block path / honest stub.
      // did.4: a ladder-bringable gap opens a sub-order instead of refusing.
      if (resolved && !worldFallback) {
        const cPlan = craftanyMod.planCraft(bot, ctx, bringMod.orderCraftNames(resolved.names), 1)
        if (cPlan.ok) {
          if (ctx.lead) { ctx.lead = null; ctx.leadStuck = 0; ctx.leadTargetGone = 0 }
          ctx.unseenTicks = 0
          ctx.resumeWork = false
          clearStuck()
          ctx.craftany = null // a cancelled run must not resume under the new one
          ctx.bring = {
            kind: 'item', name: resolved.family, names: resolved.names, want: need, by,
            items: [], drop: null, have: 0, packBase: bringMod.packCounts(bot),
            phase: 'craft', announced: true, keptName, craftTarget: cPlan.target,
          }
          ctx.paused = false
          return `making you a ${cPlan.target}`
        }
        if (cPlan.fail === 'missing') {
          const miss = Array.isArray(cPlan.missing) ? cPlan.missing : []
          // Smelting first (body-4): a furnace-gated gap refuses up front,
          // before any ladder gap sends the bot gathering for a craft that
          // cannot land.
          const smelt = bringMod.smeltingGap(miss)
          if (smelt) return `need ${smelt} (smelting not part of bring)`
          let sub = null
          if (bedMod.isBedFamily(resolved)) {
            sub = bringMod.bedGap(bot, { names: resolved.names })
          } else if (miss.every((e) => e && bringMod.pickSubGap([e]))) {
            // Every gap rides the ladder, or the gather is wasted (body-4).
            const gap = bringMod.pickSubGap(miss)
            if (gap) sub = { gap, target: cPlan.target, color: woolMod.dropColor(gap.name) }
          }
          if (sub) {
            if (ctx.lead) { ctx.lead = null; ctx.leadStuck = 0; ctx.leadTargetGone = 0 }
            ctx.unseenTicks = 0
            ctx.resumeWork = false
            clearStuck()
            ctx.craftany = null
            ctx.bring = {
              kind: 'item', name: resolved.family, names: resolved.names, want: need, by,
              items: [], drop: null, have: 0, packBase: bringMod.packCounts(bot),
              phase: 'craft', announced: true, keptName,
            }
            const line = bringMod.openSubOrder(bot, ctx, ctx.bring, sub.gap, sub.target, sub.color)
            if (line) {
              ctx.paused = false
              return line
            }
            ctx.bring = null // a refused open never leaves a half order behind
          }
          return cPlan.line
        }
        if (cPlan.fail === 'no-table') return cPlan.line
      }
      const res = findNearest(bot, name)
      if (res === 'unknown') {
        if (!resolved) return `unknown item: ${name}`
        // No diggable block, the pack came up short, and no adopted chest:
        // the honest stub (did.2-4 replace its branches).
        return bringMod.itemRefusal(bot, resolved.family, resolved, keptName)
      }
      if (!res) {
        // Sync 48 is empty: the 96/160 shells run sliced across ticks (amb).
        // A null cursor (unreadable world) answers from sync alone — unless
        // an anchor exists, when the order opens and search legs walk (atl.8).
        const search = startFarSearch(bot, name)
        if (search === 'unknown') return `unknown block: ${name}`
        if (!search) {
          if (!bringMod.canSearch(bot, ctx)) {
            // No legs to walk: a short pack still gives instead of refusing.
            if (plan && plan.have > 0) return openPackOrder()
            return `no ${name} within ${loadedSearchRadius(bot)} blocks (loaded area)`
          }
          if (!bringMod.canBringName(bot, name)) return `can't bring ${name} — ores and logs only`
          if (ctx.lead) { ctx.lead = null; ctx.leadStuck = 0; ctx.leadTargetGone = 0 }
          ctx.unseenTicks = 0
          ctx.resumeWork = false
          clearStuck()
          homeMod.releaseMeet(bot, ctx)
          ctx.bring = {
            kind: 'block', name, want, by, phase: bringMod.openPhase(ctx),
            have: 0, announced: false, searchSkipFar: true,
          }
          ctx.paused = false
          return `nothing within 48, searching for ${name}…`
        }
        ctx.pendingSearch = { cursor: search, kind: 'bring', name, want, by }
        return `nothing within 48, widening the search for ${name}…`
      }
      const bp0 = bot.entity && bot.entity.position
      if (res.exposed === false && bp0) {
        // No pickaxe tier, no dig and no walk either (harvest needs the
        // tier for both): refuse synchronously so a short pack still hands
        // over — the deferred verdicts below have no plan in scope
        // (revmux 01 core-3). Order mirrors startBlockOrder + fallback.
        if (bringMod.needsPickaxe(res.name) && !bringMod.hasPickaxe(bot, res.name)) {
          clearStuck()
          if (plan && plan.have > 0) return openPackOrder()
          const tier = bringMod.requiredTier(res.name)
          return `need ${bringMod.tierArticle(tier)} ${tier} pickaxe for ${res.name}`
        }
        // Buried 48-best (atl.15): the far shells may see exposed ore and
        // memory may know some — the buried hit is stashed as the dig
        // candidate instead of committing to the shaft at once.
        const buried = bringMod.buriedCand(bp0, res)
        let mem = null
        try { mem = bringMod.memoryExposed(bot, ctx, bp0, name, null) } catch (_) { mem = null }
        mem = bringMod.memoryInBudget(mem, buried)
        const search = startFarSearch(bot, name)
        if (search === 'unknown') return `unknown block: ${name}`
        if (!search) {
          // Edge 48, no shells: decide now; a contested pair opens the
          // order in find so the first (awaited) tick asks the model once.
          const d = bringMod.decideBringSource(mem, buried)
          if (!d.contested) {
            clearStuck()
            const win = d.pick === 'buried' ? buried : mem
            const rival = d.pick === 'buried' ? mem : buried
            console.log(bringMod.verdictLine(name, mem, buried, d.pick))
            const prevOrder = ctx.bring
            const answer = startBlockOrder(bot, ctx, { name, want, by }, bringMod.choiceRes(win, rival, bp0))
            if (ctx.bring && ctx.bring !== prevOrder) ctx.bring.verdict = bringMod.verdictFacts(mem, buried, d.pick)
            if (!ctx.bring && plan && plan.have > 0) return openPackOrder()
            return answer
          }
          if (ctx.lead) { ctx.lead = null; ctx.leadStuck = 0; ctx.leadTargetGone = 0 }
          ctx.unseenTicks = 0
          ctx.resumeWork = false
          clearStuck()
          homeMod.releaseMeet(bot, ctx)
          ctx.bring = { kind: 'block', name, want, by, phase: 'find', have: 0, announced: false }
          ctx.paused = false
          return `comparing open and buried ${name}…`
        }
        ctx.pendingSearch = { cursor: search, kind: 'bring', name, want, by, buried: res }
        return `only buried ${name} within 48, checking further for open ore…`
      }
      clearStuck()
      const prevDirect = ctx.bring
      const answer = startBlockOrder(bot, ctx, { name, want, by }, res)
      if (ctx.bring && ctx.bring !== prevDirect) {
        const only = bp0 ? bringMod.liveExposed(bp0, res) : null
        console.log(bringMod.verdictLine(name, only, null, 'exposed'))
        ctx.bring.verdict = bringMod.verdictFacts(only, null, 'exposed')
      }
      // A refused block order (pickaxe tier) still gives a short pack.
      if (!ctx.bring && plan && plan.have > 0) return openPackOrder()
      return answer
    },
    setFlat: ({ radius, by, explicit }) => {
      clearPendingSearch(ctx)
      clearStuck()
      resetNightStep()
      homeMod.releaseMeet(bot, ctx) // inside: the exit legs run before the first flat walk (jr2.3)
      if (ctx.lead) { ctx.lead = null; ctx.leadStuck = 0; ctx.leadTargetGone = 0 }
      if (ctx.bring) { metrics.bring.inc({ outcome: 'cancelled', kind: (ctx.bring && ctx.bring.kind) || 'block' }); ctx.bring = null; bringMod.clearSearchLeg(ctx) }
      // Center: the player who gave the command, or the bot itself when the
      // speaker is out of tracking range (same honest fallback as build here).
      const speaker = by && bot.players && bot.players[by] && bot.players[by].entity
      const anchor = (speaker && speaker.position) || (bot.entity && bot.entity.position)
      const cx = anchor ? Math.floor(anchor.x) : 0
      const cz = anchor ? Math.floor(anchor.z) : 0
      const yTop = Math.floor(anchor ? anchor.y : 64) + flatMod.SCAN_UP
      const f = ctx.flat
      // Any re-flat from inside the running square resumes with its
      // progress (9k4: a stepped-aside retype used to wipe the run); only
      // a new area or an explicit new radius starts over. Bare `flat`
      // (no radius argument) always means "this job".
      const inside = f &&
        Math.abs(cx - f.cx) <= f.r && Math.abs(cz - f.cz) <= f.r
      if (f && inside && (!explicit || radius === f.r)) {
        f.by = by || f.by
        f.parked = false
        ctx.paused = false
        return flatMod.resumeLine(f)
      }
      ctx.flat = flatMod.startEpisode(cx, cz, radius, yTop, by || 'you')
      ctx.unseenTicks = 0
      ctx.resumeWork = false
      ctx.paused = false
      const size = 2 * radius + 1
      const hint = explicit ? '' : ' (flat 48 for a big field)'
      return `scanning ${size}x${size} for holes…${hint}`
    },
    // 'Come home' order (jr2.3): drop follow/work and wait in the common
    // room until countermanded. Refuses honestly without a built home
    // (adopting a standing house first, like the work tick); a repeat
    // re-arms fresh, so stop/retype can never hang the phase.
    setComehome: ({ by }) => {
      let home = ctx.home
      if (!home || !home.site) {
        let found = null
        try { found = goal.adoptHome(bot) } catch (_) { found = null }
        if (!found) return 'no home yet — say build here'
        home = found
      }
      // A stale unbuilt flag (adopted mid-build or mid-repair, then finished
      // without the build step ever flipping it) re-validates against THIS
      // site's plan, silently: adopting here would announce the wrong house
      // when 'build here' just moved. Given-up cells stay skipped.
      if (!home.built) {
        let complete = false
        try {
          complete = buildMod.nextCellIdx(bot, home, ctx.buildSkip) === -1
        } catch (_) { complete = false }
        if (!complete) return 'home not built yet — say go work'
        home.built = true
        try { memory.save(bot, ctx) } catch (_) { /* memory best-effort */ }
      }
      clearPendingSearch(ctx)
      clearStuck()
      resetNightStep()
      if (home !== ctx.home) {
        ctx.home = home; ctx.buildSkip = []; ctx.buildFails = 0; ctx.buildFailIdx = -1; ctx.buildGoalIdx = -1; ctx.buildFarIdx = -1
        try { memory.save(bot, ctx) } catch (_) { /* memory best-effort */ }
      }
      if (ctx.bring) { metrics.bring.inc({ outcome: 'cancelled', kind: (ctx.bring && ctx.bring.kind) || 'block' }); ctx.bring = null; bringMod.clearSearchLeg(ctx) }
      if (ctx.lead) { ctx.lead = null; ctx.leadStuck = 0; ctx.leadTargetGone = 0 }
      if (ctx.flat) ctx.flat.parked = true
      // A mode change away from follow revokes the held order with its disk
      // copy (startWork precedent): a restart must not resurrect a follow
      // the owner cancelled for the meet.
      const held = followName
      followName = ''
      if (held) {
        try { ctx.followName = null } catch (_) { /* follow best-effort */ }
        try { memory.save(bot, ctx) } catch (_) { /* memory best-effort */ }
      }
      ctx.work = false
      ctx.paused = false
      ctx.unseenTicks = 0
      ctx.resumeWork = false
      ctx.lastGoalKey = ''
      ctx.stepStatus = 'running'
      let inside = false
      try { inside = homeMod.isInside(bot, ctx.home) } catch (_) { inside = false }
      const prior = ctx.comehome
      ctx.comehome = homeMod.startMeet(by, inside, home)
      // Re-ordered mid-exit after 'build here' swapped the house: the fresh
      // order keeps exiting the pinned old house, then reseeks the current
      // home instead of releasing — a fresh walk from inside the old walls
      // would plan through them (revmux 01 core-1).
      if (prior && prior.exiting && prior.home && !inside) {
        ctx.comehome.exiting = true
        ctx.comehome.phase = 'open'
        ctx.comehome.home = prior.home
        ctx.comehome.reseek = true
        ctx.comehome.settle = false
        ctx.inShelter = true
      }
      return 'coming home'
    },
    status: () => {
      const facts = goal.goalFacts(bot, ctx)
      const flatParked = ctx.flat && ctx.flat.parked
      const mode = ctx.comehome ? 'coming home' : (ctx.bring ? 'bringing' : (ctx.flat && !ctx.flat.parked && !ctx.paused && !ctx.lead ? 'flattening' : (ctx.work ? 'working' : (ctx.lead ? 'leading' : ((ctx.paused || flatParked) ? (ctx.flat ? 'parked (flat paused)' : 'parked') : 'following')))))
      // atl.7: a resting bot names the reason decide() stored, if any.
      const why = ctx.step === 'rest' && ctx.restWhy ? ` resting because ${ctx.restWhy}` : ''
      bot.chat(`${mode} step=${ctx.step || 'none'}${why} logs=${facts.logs} planks=${facts.planks} home=${facts.home}`)
    }
  }
}

function parseLeaveAfterMs(env) {
  const raw = parseInt((env && env.BOT_LEAVE_AFTER_MS) || '60000', 10)
  if (!Number.isFinite(raw) || raw < 0) return LEAVE_AFTER_MS_DEFAULT
  return raw
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// Off-server wait: ping the server until a real player is online. A refused
// or silent ping counts as nobody online. At most one line per minute, the
// same throttle style as local-idle.
function playersOccupied(res, username) {
  const p = res && res.players
  if (!p || typeof p.online !== 'number' || p.online <= 0) return false
  if (p.online > 1) return true
  // online==1 right after our own quit() is usually ourselves: the server
  // has not processed our disconnect yet while our local 'end' already
  // fired. Only our name in the sample means still empty; anyone else (or
  // no sample at all) means occupied — joining is the safe default there.
  const sample = Array.isArray(p.sample) ? p.sample.map((e) => e && e.name).filter(Boolean) : []
  if (sample.length === 0) return true
  return sample.some((name) => name !== username)
}

async function waitForPlayers({ host, port, pingFn, pollMs = JOIN_POLL_MS, username = '' }) {
  let lastWaitLog = 0
  for (;;) {
    let occupied = false
    try {
      occupied = playersOccupied(await pingFn({ host, port, closeTimeout: 10000 }), username)
    } catch (_) { occupied = false }
    if (occupied) return
    const now = Date.now()
    if (now - lastWaitLog >= IDLE_LOG_MS) {
      lastWaitLog = now
      console.log('waiting for players')
    }
    await sleep(pollMs)
  }
}

function fatal(where, err) {
  console.error(`${where}: ${err && err.message ? err.message : err}`)
  process.exit(1)
}

// Disk memory (idkcraft-hlk): a bot-container stop arrives as SIGTERM with
// no mineflayer event at all. Armed once per process (never per connection,
// so reconnects cannot stack listeners); each runOnce registers its live
// saver. The default SIGTERM death becomes an explicit save-then-exit.
let termSaver = null
try {
  process.once('SIGTERM', () => {
    try { if (termSaver) termSaver() } catch (_) { /* exit anyway */ }
    process.exit(143)
  })
} catch (_) { /* no process object in some harnesses */ }

// One connection: resolves after our own quit() (the join loop then goes
// back to polling). An unexpected end/kicked/error still exits — the
// container restart is the reconnect path there. createBot/pingFn are
// parameters so tests can drive the own-quit vs fatal branches.
// Follow target adoption at (re)start (idkcraft-p4s): the env order wins
// (already the ticker's name, so this only runs when it is empty) — then
// ONLY the name disk memory kept across the deploy, and only while that
// player is online. Never the single online player: the owner may want
// autonomous work, and that is their command, not the restart's decision.
// Pure: roster reads only, so unit tests pin every branch.
function startupFollow(bot, memName) {
  try {
    const players = (bot && bot.players) || {}
    if (typeof memName === 'string' && memName) {
      const real = resolvePlayer(bot, memName)
      if (real && players[real]) return real
    }
  } catch (_) { /* roster best-effort */ }
  return ''
}

function runOnce({ host, port, username, tickMs, brain, leaveAfterMs, followName, idleTickMs = IDLE_TICK_MS, brainEngine = '', autonomous = false, createBot = (opts) => mineflayer.createBot(opts), pingFn = require('minecraft-protocol').ping }) {
  return new Promise((resolve) => {
    const bot = createBot({
      host,
      port,
      username,
      auth: 'offline' // offline-mode server; see README for the online-mode note
    })
    bot.loadPlugin(pathfinder)
    let wantQuit = false
    const ticker = createTicker({
      bot, brain, tickMs, idleTickMs, followName, leaveAfterMs, brainEngine, autonomous,
      onLeave: () => { void confirmLeave() }
    })
    // The streak only proves nobody is *visible*. Re-check the world-wide
    // player count before quitting: a player online-but-far would otherwise
    // flap join/leave every grace period. Standing down re-arms the streak.
    async function confirmLeave() {
      let occupied = false
      try { occupied = playersOccupied(await pingFn({ host, port, closeTimeout: 10000 }), username) } catch (_) { occupied = false }
      if (occupied) { ticker.rearm(); return }
      console.log('leaving: nobody online')
      wantQuit = true
      ticker.destroy()
      try { bot.quit('nobody online') } catch (_) { /* already gone */ }
    }

    bot.once('spawn', () => {
      ticker.setMovements(new Movements(bot))
      // idkcraft-der: log the negotiated version + registry data at spawn so
      // rig/prod logs show which minecraft-data the bot actually runs on.
      const verSuffix = bot.version ? ` mc=${bot.version} proto=${bot.protocolVersion} data=${bot.registry?.version?.minecraftVersion}` : ''
      console.log(`spawned as ${bot.username}${verSuffix}`)
      // Session start far from spawn with nobody visible (quit in a cave):
      // pre-arm the unseen counter so the tick path walks home at once
      // instead of standing through N more ticks.
      const tickCtx = bot._tickerCtx
      try {
        const bp = bot.entity && bot.entity.position
        const sp = bot.spawnPoint
        if (tickCtx && bp && sp && Math.hypot(bp.x - sp.x, bp.y - sp.y, bp.z - sp.z) > FAR_FROM_SPAWN && !findTarget(bot, followName)) {
          tickCtx.unseenTicks = UNSEEN_HOME_TICKS
        }
      } catch (_) { /* best-effort */ }
      // Owner rule (epic rw4): with no follow target the bot works on its
      // own until 'follow me'. createTicker defaults work=false so unit
      // tests stay explicit about entering work mode. Exception: a far,
      // unseen start walks home first (see pre-arm below) — working a cave
      // 225 blocks from the player helps no one.
      if (tickCtx && tickCtx.unseenTicks >= UNSEEN_HOME_TICKS && !followName) tickCtx.resumeWork = true
      // Disk memory (idkcraft-hlk): restore before adopting — a saved
      // home (e.g. an unfinished new site) wins over re-adopting the old
      // door near spawn. Adopt only when memory holds no home.
      if (tickCtx && ticker && typeof ticker.loadMemory === 'function') ticker.loadMemory()
      // idkcraft-p4s: follow survives the deploy — adopt the remembered (or
      // sole) target before the first decision, so work mode never starts.
      if (tickCtx && ticker && !followName && typeof ticker.setFollow === 'function') {
        const adopted = startupFollow(bot, tickCtx.followName)
        if (adopted) ticker.setFollow(adopted)
      }
      // Epic rw4.4: adopt a house an earlier run finished (door near
      // spawn) before the first decision, so a restart resumes as built.
      const found = (!tickCtx || !tickCtx.home) ? goal.adoptHome(bot) : null
      if (found && ticker && typeof ticker.setHome === 'function') ticker.setHome(found)
      const followedNow = ticker && typeof ticker.getFollowName === 'function' && ticker.getFollowName()
      if ((!tickCtx || (tickCtx.unseenTicks || 0) < UNSEEN_HOME_TICKS) && !followName && !followedNow) ticker.work()
      ticker.start()
    })
    bot.on('spawn', () => { metrics.events.inc({ event: 'spawn' }); metrics.online.set(1); fightMod.equipGear(bot); console.log(kitLine(bot)) })

    // Sender UUID cache (idkcraft-8gf): the 'chat' event carries only the
    // parsed name, but the 'message' event delivers the sender UUID just
    // before the same text is pattern-matched — prefer it so Java 'X' and
    // Bedrock '.X' online together never mix up. Name resolution stays the
    // fallback when the texts do not line up.
    let lastChatSender = null
    bot.on('message', (chatMsg, position, senderUuid) => {
      if (position === 'chat' && senderUuid) lastChatSender = { text: String(chatMsg), uuid: String(senderUuid) }
    })
    bot.on('chat', (chatUsername, message) => {
      const senderUuid = lastChatSender && lastChatSender.text.endsWith(message) ? lastChatSender.uuid : null
      handleChat(bot, ticker, chatUsername, message, senderUuid)
    })

    // Pathfinder status taps: stored on the ticker ctx, logged per tick on the
    // decision line. Registered here in runOnce(), not in createTicker: the test
    // mockBot is a plain object, not an EventEmitter, so only the real
    // mineflayer bot ever reaches this code.
    bot.on('path_update', (r) => { if (r && r.status) ticker.setPathStatus(r.status); if (r && Array.isArray(r.path) && r.path.length > 0) ticker.setPathNext(r.path[0]); if (r && Array.isArray(r.path)) ticker.setPathNodes(r.path) })
    bot.on('path_reset', (reason) => ticker.setPathReset(reason))
    // Hover-arrest taps (idkcraft-1cj): teleport counter + move-packet clone
    // for the watchdog. Same spot as the pathfinder taps: real bot only.
    try { unpin.installUnpinTap(bot, bot._tickerCtx || {}) } catch (_) { /* unpin tap best-effort */ }
    // Face epsilon (idkcraft-ik7): outgoing move packets shift a hair off
    // contacted side faces (the wall-contact freeze cure at the source).
    // Same spot: real bot only. Wraps outside the unpin tap; unpin's nudge
    // shape is unaffected (it re-bases coordinates onto the correction).
    try { decontact.installFaceEpsilon(bot) } catch (_) { /* face epsilon best-effort */ }

    const life = createLifecycle(ticker)
    bot.on('death', () => life.onDeath(bot))
    bot.on('respawn', () => life.onRespawn(bot))
    bot.on('spawnReset', () => life.onSpawnReset(bot))
    bot.on('playerLeft', (player) => handlePlayerLeft(bot, ticker, player))

    // Our own quit() resolves back into the join loop; anything else is fatal
    // and the container restart reconnects. Late errors on the intentionally
    // closed connection are ignored so they cannot kill the next one.
    // Disk memory (idkcraft-hlk): the live saver for this connection.
    // Cleared on settle so a later SIGTERM never writes through a dead
    // ticker; the next runOnce registers its own.
    const thisSaver = () => { try { return ticker.saveMemory() } catch (_) { return false } }
    termSaver = thisSaver
    bot.on('end', (reason) => {
      metrics.online.set(0)
      metrics.setVitals(null)
      // Disk memory (idkcraft-hlk): persist on the way out — the next
      // connection (join loop or container restart) restores it. Fatal ends
      // save too: the container restart is the reconnect path there.
      if (ticker && typeof ticker.saveMemory === 'function') ticker.saveMemory()
      if (termSaver === thisSaver) termSaver = null
      if (wantQuit) { ticker.destroy(); resolve() }
      else fatal('end', reason || 'disconnected')
    })
    // A Paper shutdown/redeploy arrives as 'kicked', a socket reset as
    // 'error' — both fatal() past the 'end' save above, so save first
    // (revmux 01-review). Sync fs: safe before the synchronous exit.
    bot.on('error', (err) => { if (!wantQuit) { thisSaver(); fatal('error', err) } })
    bot.on('kicked', (reason) => { if (!wantQuit) { thisSaver(); fatal('kicked', reason) } })
  })
}

async function main() {
  const rawTick = parseInt(process.env.BRAIN_TICK_MS || '1000', 10)
  const tickMs = Number.isFinite(rawTick) ? rawTick : 1000
  const leaveAfterMs = parseLeaveAfterMs(process.env)
  const host = process.env.MC_HOST || 'mc'
  const port = parseInt(process.env.MC_PORT || '25565', 10)
  const username = process.env.BOT_USERNAME || 'IdkBot'
  const followName = process.env.BOT_FOLLOW || ''
  const brain = makeBrain(process.env)
  // Initial engine label for 'brain' (mirrors makeBrain's choice).
  const brainEngine = (process.env.BRAIN_URL || process.env.TYPESAFE_API_KEY)
    ? sourceForUrl(process.env.BRAIN_URL || JEV_ENDPOINT)
    : 'off'
  metrics.serve(parseInt(process.env.METRICS_PORT || '9464', 10))
  const pingFn = require('minecraft-protocol').ping
  for (;;) {
    // 0 disables the leave: join immediately and stay on, like before.
    // Autonomous joins an empty server too: staying is the point. The chat
    // toggle (not the env const) decides, so 'autonomous off' lasts.
    const autonomous = autonomousEffective(process.env)
    if (leaveAfterMs !== 0 && !autonomous) {
      await waitForPlayers({ host, port, pingFn, username })
      await sleep(JOIN_SETTLE_MS)
    }
    await runOnce({ host, port, username, tickMs, brain, leaveAfterMs, followName, brainEngine, autonomous })
  }
}

// Targets declined as too deep, held per player for an explicit 'lead
// anyway'. Overwritten by the next deep decline, cleared on use.
const deepOffers = new Map()
// A target more than this far below the requesting player is announced, not
// led to: walking the player down to buried ore is how prod fell to death.
const DEEP_WARN_DROP = 8

// Shared block-order creation (amb): sync setBring and far-search
// completion build the same order and announce the honest distance.
function startBlockOrder(bot, ctx, { name, want, by }, res) {
  if (!bringMod.isBringable(res.name)) return `can't bring ${res.name} — ores and logs only`
  if (bringMod.needsPickaxe(res.name) && !bringMod.hasPickaxe(bot, res.name)) {
    const tier = bringMod.requiredTier(res.name)
    return `need ${bringMod.tierArticle(tier)} ${tier} pickaxe for ${res.name}`
  }
  homeMod.releaseMeet(bot, ctx) // inside: the exit legs run before the fetch walk (jr2.3)
  if (ctx.lead) { ctx.lead = null; ctx.leadStuck = 0; ctx.leadTargetGone = 0 }
  // A fresh explicit order restarts homing math (a tripped counter would
  // starve the order) and supersedes a pending spawn work-resume (which
  // would otherwise cancel the order on the next sighted tick).
  ctx.unseenTicks = 0
  ctx.resumeWork = false
  ctx.bring = {
    kind: 'block', name, want, by, block: res.name, drop: bringMod.dropFor(res.name),
    pos: res.position, phase: 'walk', stalls: 0, lastPos: null,
    have: 0, announced: true, exposed: res.exposed !== false,
  }
  if (res.far === true) ctx.bring.far = true // memory target: unloaded is not gone
  ctx.paused = false
  return bringMod.goingForLine(want, res)
}

// Shared found-answer (amb): sync find-me and far-search completion lead to
// the hit or warn about depth the same way.
function answerFound(bot, ticker, playerName, refY, res) {
  const down = refY != null ? Math.round(refY - res.position.y) : 0
  if (down > DEEP_WARN_DROP) {
    bot.chat(`${res.name} is ${down} blocks down, dig carefully`)
    deepOffers.set(playerName, { name: res.name, pos: res.position, distance: res.distance })
  } else {
    bot.chat(`leading you to ${res.name}, ${res.distance} blocks, follow me`)
    if (ticker && typeof ticker.setLead === 'function') ticker.setLead({ name: res.name, pos: res.position, by: playerName, lastProgressAt: Date.now() })
  }
}

// One pending far search (amb), advanced once per tick: the 96/160 shells
// sliced to the per-tick CPU budget. Completion chats the answer (find) or
// opens the order (bring); a newer request replaces a stale one. Slices
// pause while hostiles are near (last tick's snapshot): search must not
// stall the fight reflexes. A negative names the cursor's own edge — the
// radius actually scanned, not a re-probe that may have drifted.
async function advancePendingSearch(bot, ticker, ctx) {
  const p = ctx && ctx.pendingSearch
  if (!p || p.deciding) return
  if (ctx.lastHostileSnap && ctx.lastHostileSnap.count > 0) return
  const r = stepFarSearch(bot, p.cursor)
  if (!r.done) return
  ctx.pendingSearch = null
  if (r.result === 'unknown') {
    bot.chat(`unknown block: ${p.name}`)
    return
  }
  const edge = (r && typeof r.edge === 'number') ? r.edge : loadedSearchRadius(bot)
  if (p.kind === 'bring') {
    const bp0 = bot.entity && bot.entity.position
    if (bp0) {
      // Shells done (atl.15): the verdict weighs live exposed (a) against
      // memory (b) and the dig (c) — the stashed 48 hit when creation saw
      // buried ore, else the far hit itself. Contested asks the model once
      // (the tick awaits this); the cache rides onto the new order.
      const stash = p.buried && p.buried.position ? p.buried : null
      const far = r.result && r.result.exposed !== false ? bringMod.liveExposed(bp0, r.result) : null
      const buried = stash ? bringMod.buriedCand(bp0, stash) : (r.result && r.result.exposed === false ? bringMod.buriedCand(bp0, r.result) : null)
      let mem = null
      try { mem = bringMod.memoryExposed(bot, ctx, bp0, p.name, null) } catch (_) { mem = null }
      const exposed = bringMod.bestExposed(far, bringMod.memoryInBudget(mem, buried))
      if (!exposed && !buried) {
        // atl.8: open the order instead of refusing — the first tick walks
        // search legs (the far shells just came up empty, skip the re-scan).
        if (!bringMod.canBringName(bot, p.name)) {
          bot.chat(`can't bring ${p.name} — ores and logs only`)
          return
        }
        homeMod.releaseMeet(bot, ctx)
        ctx.bring = {
          kind: 'block', name: p.name, want: p.want, by: p.by, phase: bringMod.openPhase(ctx),
          have: 0, announced: false, searchSkipFar: true,
        }
        try {
          ctx.bring.farCache = { x: bp0.x, y: bp0.y, z: bp0.z, edge, hit: null, buriedHit: null }
        } catch (_) { /* cache best-effort */ }
        // The handover takes the body (jr2.2): a stale stay must not
        // survive, and a body asleep from the pending wait must wake.
        ctx.step = null
        ctx.stepStatus = null
        ctx.gohome = null
        ctx.stay = null
        ctx.inShelter = false
        wakeBody(bot)
        try {
          const mov = ctx.movements
          if (mov && typeof mov.canDig === 'boolean') mov.canDig = true
        } catch (_) { /* reset best-effort */ }
        ctx.paused = false
        return
      }
      // The ask suspends: re-arm the pending token across the await so a
      // mid-ask retire (stop/death/newer order) aborts the commit below.
      // Non-contested verdicts never suspend (no brain call to await).
      const d0 = bringMod.decideBringSource(exposed, buried)
      let c
      const cache = {}
      if (!d0.contested) {
        c = { action: d0.pick === 'buried' ? 'dig_buried' : 'walk_exposed' }
      } else {
        ctx.pendingSearch = p
        p.deciding = true
        try {
          c = await bringMod.chooseBringSource(ctx && ctx.brain, bringMod.sourceText(p, exposed, buried), exposed, buried, cache)
        } finally {
          p.deciding = false
        }
        if (!ctx || ctx.pendingSearch !== p) return // retired mid-ask: touch nothing
        ctx.pendingSearch = null
      }
      if (ticker && typeof ticker.clearStuck === 'function') ticker.clearStuck()
      // Bring owns the body now: end any night step at once (module scope has
      // no resetNightStep, so inline it). Otherwise the walk's borrowed
      // canDig=false leaks onto the shared Movements for the whole bring.
      ctx.step = null
      ctx.stepStatus = null
      ctx.gohome = null
      ctx.stay = null
      ctx.inShelter = false
      try {
        const mov = ctx.movements
        if (mov && typeof mov.canDig === 'boolean') mov.canDig = true
      } catch (_) { /* reset best-effort */ }
      wakeBody(bot) // jr2.2: an order takes the body even at night
      const pick = c.action === 'dig_buried' ? 'buried' : 'exposed'
      const win = pick === 'buried' ? buried : exposed
      const rival = pick === 'buried' ? exposed : buried
      console.log(bringMod.verdictLine(p.name, exposed, buried, pick))
      // A refusal (tier/unbringable) leaves a surviving older order in
      // place: attach the verdict only to an order this commit created
      // (revmux 02 core-1), never graft it onto the old one.
      const prev = ctx.bring
      bot.chat(startBlockOrder(bot, ctx, p, bringMod.choiceRes(win, rival, bp0)))
      if (ctx.bring && ctx.bring !== prev) {
        ctx.bring.verdict = bringMod.verdictFacts(exposed, buried, pick)
        if (cache.sourceAsked) { ctx.bring.sourceAsked = true; ctx.bring.sourcePick = cache.sourcePick }
        try {
          ctx.bring.farCache = {
            x: bp0.x, y: bp0.y, z: bp0.z, edge, hit: far,
            buriedHit: r.result && r.result.exposed === false ? bringMod.buriedCand(bp0, r.result) : null,
          }
        } catch (_) { /* cache best-effort */ }
      }
      return
    }
    if (!r.result) {
      // atl.8: open the order instead of refusing — the first tick walks
      // search legs (the far shells just came up empty, skip the re-scan).
      if (!bringMod.canBringName(bot, p.name)) {
        bot.chat(`can't bring ${p.name} — ores and logs only`)
        return
      }
      homeMod.releaseMeet(bot, ctx)
      ctx.bring = {
        kind: 'block', name: p.name, want: p.want, by: p.by, phase: bringMod.openPhase(ctx),
        have: 0, announced: false, searchSkipFar: true,
      }
      // The handover takes the body (revmux 02-review): same inline reset as
      // the found branch — a stale stay must not survive, and a body asleep
      // from the pending wait must wake.
      ctx.step = null
      ctx.stepStatus = null
      ctx.gohome = null
      ctx.stay = null
      ctx.inShelter = false
      wakeBody(bot)
      try {
        const mov = ctx.movements
        if (mov && typeof mov.canDig === 'boolean') mov.canDig = true
      } catch (_) { /* reset best-effort */ }
      ctx.paused = false
      return
    }
    if (ticker && typeof ticker.clearStuck === 'function') ticker.clearStuck()
    // Bring owns the body now: end any night step at once (module scope has
    // no resetNightStep, so inline it). Otherwise the walk's borrowed
    // canDig=false leaks onto the shared Movements for the whole bring.
    ctx.step = null
    ctx.stepStatus = null
    ctx.gohome = null
    ctx.stay = null
    ctx.inShelter = false
    wakeBody(bot) // jr2.2: an order takes the body even at night
    try {
      const mov = ctx.movements
      if (mov && typeof mov.canDig === 'boolean') mov.canDig = true
    } catch (_) { /* reset best-effort */ }
    bot.chat(startBlockOrder(bot, ctx, p, r.result))
    return
  }
  if (!r.result) {
    bot.chat(`no ${p.name} within ${edge} blocks (loaded area)`)
    return
  }
  answerFound(bot, ticker, p.by, p.refY, r.result)
}

// A pending far search belongs to the order or question that started it:
// any mode change or death retires it, so a late completion can never
// override stop, follow, work, or a newer order.
function clearPendingSearch(ctx) {
  if (ctx) ctx.pendingSearch = null
}

function handleChat(bot, ticker, username, message, senderUuid) {
  if (username === bot.username) return
  const playerName = resolvePlayer(bot, username, senderUuid)
  const msg = message.toLowerCase().trim()
  if (msg === 'follow me') {
    if (ticker) ticker.setFollow(playerName)
    const seen = bot.players && bot.players[playerName] && bot.players[playerName].entity
    if (seen) {
      bot.chat(`Following ${playerName}`)
    } else {
      // Honest: the server sends no coordinates for an out-of-range player
      // and the bot is not OP, so it cannot walk there — say where it is.
      const bp = bot.entity && bot.entity.position
      const at = bp ? `${Math.round(bp.x)} ${Math.round(bp.y)} ${Math.round(bp.z)}` : 'unknown'
      const sp = bot.spawnPoint
      const dist = bp && sp ? ` (~${Math.round(Math.hypot(bp.x - sp.x, bp.y - sp.y, bp.z - sp.z))} blocks from spawn)` : ''
      bot.chat(`I can't see you — I'm at ${at}${dist}; come closer or /tp ${bot.username} ${playerName}`)
    }
  } else if (msg === 'stop') {
    if (ticker) {
      ticker.setFollow('')
      ticker.stop()
    }
  } else if (msg === 'lead anyway') {
    const offer = deepOffers.get(playerName)
    deepOffers.delete(playerName)
    if (offer) {
      bot.chat(`leading you to ${offer.name}, ${offer.distance} blocks, follow me`)
      if (ticker && typeof ticker.setLead === 'function') ticker.setLead({ name: offer.name, pos: offer.pos, by: playerName, lastProgressAt: Date.now() })
    } else {
      bot.chat('no deep find on hold — ask me to find something first')
    }
  } else if (msg === 'go work' || msg === 'free') {
    if (ticker) ticker.work()
    bot.chat(`on my own; say 'follow me' to call me`)
  } else if (msg === 'come home') {
    if (ticker && typeof ticker.setComehome === 'function') bot.chat(ticker.setComehome({ by: playerName }))
  } else if (msg === 'build here') {
    const speaker = bot.players && bot.players[playerName] && bot.players[playerName].entity
    const pos = speaker && speaker.position
    // b2o: out of tracking range is an answer, not silence — the server
    // sends no coordinates and the bot cannot walk there.
    if (!pos || typeof pos.x !== 'number') {
      bot.chat("I can't see you, come closer")
      return
    }
    // rpw: always a new site, even over a built home — the owner asked.
    // The new home becomes current (gohome/night go there); old walls stay
    // protected by build.js guardOwnWalls (block-type based, not site).
    // b2o: then the same transition as 'go work' — follow drops the body
    // and the goal loop starts building instead of trailing the owner.
    const site = goal.siteFor(bot, pos)
    if (ticker && typeof ticker.setHome === 'function') ticker.setHome(site)
    if (ticker) ticker.work()
    const st = (site && site.site) || {}
    bot.chat(`building a home at ${st.x} ${st.y} ${st.z}`)
  } else if (msg === 'status') {
    if (ticker && typeof ticker.status === 'function') ticker.status()
  } else if (msg === 'brain' || msg.startsWith('brain ')) {
    // Brain switch (d75): with a follow target only they may switch; with
    // nobody followed (work mode) any roster player may. Others get silence
    // and the engine never changes for them.
    const followed = ticker && typeof ticker.getFollowName === 'function' ? ticker.getFollowName() : null
    const allowed = ticker && playerName && (followed
      ? playerName === followed
      : !!(bot.players && bot.players[playerName]))
    if (!allowed) return
    const arg = msg.slice(5).trim()
    if (!arg) {
      bot.chat(`brain: ${ticker.getBrainEngine()}`)
      return
    }
    if (arg === 'off' || arg === 'laya' || arg === 'jev') {
      if (arg === 'jev' && !process.env.TYPESAFE_API_KEY) {
        bot.chat('jev: no api key')
        return
      }
      const from = ticker.getBrainEngine()
      const url = arg === 'laya' ? (layaUrl() || LAYA_URL_DEFAULT) : JEV_ENDPOINT
      const next = arg === 'off' ? stubBrain : hybridBrain(jevBrain(process.env.TYPESAFE_API_KEY, undefined, brainTimeoutMs(process.env), url))
      ticker.setBrain(next, arg)
      if (bot._tickerCtx) bot._tickerCtx.manualBrain = arg
      bot.chat(`brain: ${arg}`)
      console.log(`brain switch from=${from} to=${arg} by=${playerName}`)
    } else {
      bot.chat(`unknown brain: "${arg.slice(0, 30)}" — say help brain`)
    }
  } else if (msg === 'help' || msg.startsWith('help ')) {
    const topic = msg.slice(4).trim()
    if (!topic) {
      bot.chat(helpReply(1))
    } else if (/^\d+$/.test(topic)) {
      bot.chat(helpReply(Number(topic)) || `no help page ${topic.slice(0, 10)} — say help for the list`)
    } else {
      const cmd = lookupCommand(topic)
      if (cmd) bot.chat(detailLine(cmd))
      // Echo capped: the raw topic is unbounded player text, and an overlong
      // reply would be split past the 256-char chat cap.
      else bot.chat(`unknown command: "${topic.slice(0, 30)}" — say help for the list`)
    }
  } else {
    const m = msg.match(/^find me\s+(\S+)$/)
    if (m) {
      if (bot._tickerCtx) clearPendingSearch(bot._tickerCtx)
      const name = m[1]
      const speaker = bot.players && bot.players[playerName] && bot.players[playerName].entity
      const speakerY = speaker && typeof speaker.position?.y === 'number' ? speaker.position.y : null
      // No speaker entity (out of tracking range): judge depth from the
      // bot's own Y, the same fallback the ranking uses — never silently 0.
      const botY = bot.entity && typeof bot.entity.position?.y === 'number' ? bot.entity.position.y : null
      const refY = speakerY != null ? speakerY : botY
      const res = findNearest(bot, name, refY)
      if (res === 'unknown') {
        bot.chat(`unknown block: ${name}`)
      } else if (!res) {
        const search = startFarSearch(bot, name, refY)
        if (search === 'unknown') {
          bot.chat(`unknown block: ${name}`)
        } else if (!search) {
          bot.chat(`no ${name} within ${loadedSearchRadius(bot)} blocks (loaded area)`)
        } else {
          const t = ticker && bot._tickerCtx ? bot._tickerCtx : null
          if (t) t.pendingSearch = { cursor: search, kind: 'find', name, refY, by: playerName }
          bot.chat(`nothing within 48, widening the search for ${name}…`)
        }
      } else {
        answerFound(bot, ticker, playerName, refY, res)
      }
    } else if (msg === 'find me' || msg.startsWith('find me ')) {
      bot.chat('try: find me iron')
    } else if (msg === 'flat' || msg.startsWith('flat ') || msg === 'make flat' || msg.startsWith('make flat ') || msg === 'flatten' || msg.startsWith('flatten ')) {
      const m = msg.match(/^(?:flat|make flat|flatten)(?:\s+(\S+))?$/)
      const r = m ? flatMod.parseRadius(m[1]) : null
      if (r == null) bot.chat('try: flat 16')
      else if (ticker && typeof ticker.setFlat === 'function') bot.chat(ticker.setFlat({ radius: r, by: playerName, explicit: m[1] != null }))
    } else if (msg === 'share') {
      if (ticker && typeof ticker.setShare === 'function') {
        const r = ticker.setShare({ by: playerName })
        if (r) bot.chat(r)
      }
    } else if (msg === 'autonomous' || msg.startsWith('autonomous ')) {
      const m = msg.match(/^autonomous(?:\s+(on|off))?$/)
      if (!m) {
        bot.chat('try: autonomous on')
      } else if (ticker && typeof ticker.setAutonomous === 'function') {
        if (!m[1]) bot.chat(`autonomous is ${bot._tickerCtx && bot._tickerCtx.autonomous ? 'on' : 'off'}`)
        else bot.chat(ticker.setAutonomous(m[1] === 'on'))
      }
    } else if (msg === 'bring me' || msg.startsWith('bring me ')) {
      const m = msg.match(/^bring me\s+(.+?)(?:\s+(\d+))?$/)
      if (!m) {
        bot.chat('try: bring me coal')
      } else if (ticker && typeof ticker.setBring === 'function') {
        const name = bringMod.normalizeBringName(m[1])
        const food = bringMod.isFoodRequest(name)
        const want = m[2]
          ? Math.min(bringMod.WANT_MAX, Math.max(1, parseInt(m[2], 10)))
          : (food ? bringMod.WANT_FOOD : (/logs?$|_log$/.test(name) ? bringMod.WANT_LOGS : bringMod.WANT_ORE))
        bot.chat(ticker.setBring({ name, want, by: playerName }))
      }
    }
  }
}

if (require.main === module) { main().catch((err) => fatal('main', err)) }

// Death/respawn are logged, never silent: mineflayer auto-respawns by
// default, so without these lines a death looks like a teleport. The
// hostile count reuses buildState(bot, null) (null target = no player
// needed for the nearby-hostile scan).
function deathLine(bot) {
  let health = typeof bot.health === 'number' ? bot.health : 20
  let hostiles = 0
  let nearest = null
  try {
    const state = buildState(bot, null)
    health = state.bot_health
    hostiles = state.nearby_hostiles
    const snap = (bot && bot._tickerCtx && bot._tickerCtx.lastHostileSnap) || null
    if (hostiles <= 0 && snap && typeof snap.count === 'number' && snap.count > 0) {
      // The killer is usually gone at the death tick (exploded creeper), so a
      // live scan prints hostiles=0 over a corpse. The last tick's snapshot
      // is the truthful count.
      hostiles = snap.count
    }
    const live = snapHostiles(bot)
    if (live && live.count > 0) nearest = live
    else if (snap && snap.count > 0) nearest = snap
  } catch (_) { /* keep defaults: the line must still print */ }
  const pos = bot.entity && bot.entity.position
  const at = pos ? `${Math.floor(pos.x)} ${Math.floor(pos.y)} ${Math.floor(pos.z)}` : 'unknown'
  let line = `death health=${health} hostiles=${hostiles} at ${at}`
  if (nearest && nearest.name) line += ` nearest=${nearest.name} ${nearest.dist.toFixed(1)}`
  return line
}

function respawnLine(bot) {
  // At the 'respawn' packet bot.entity.position still holds the death
  // coords (mineflayer only moves it on the later position sync), so read
  // bot.spawnPoint instead. jr2.2: the bot sleeps in its bedroom bed, and
  // respawn then lands at the claimed bed — bot.spawnPoint never learns it
  // (mineflayer updates spawnPoint on the spawn_position packet alone), so
  // the stay step's claim wins. Entity position is the fallback.
  let bed = null
  try {
    const ctx = bot && bot._tickerCtx
    // The claim alone never set the spawn: only a slept bed wins (revmux
    // 01-review — a day-1 /kill before first sleep lands on world spawn).
    bed = ctx && ctx.home && ctx.home.sleptA && (ctx.home.bedA || null)
  } catch (_) { bed = null }
  const dest = (bed && typeof bed.x === 'number' && { x: bed.x, y: bed.y, z: bed.z }) ||
    (bot.spawnPoint && { x: bot.spawnPoint.x, y: bot.spawnPoint.y, z: bot.spawnPoint.z }) ||
    (bot.entity && bot.entity.position)
  const at = dest ? `${Math.floor(dest.x)} ${Math.floor(dest.y)} ${Math.floor(dest.z)}` : 'unknown'
  return bed && at !== 'unknown' ? `respawn at ${at} (bed)` : `respawn at ${at}`
}

function handleDeath(bot, ticker) {
  if (ticker && typeof ticker.clearLead === 'function') ticker.clearLead()
  if (ticker && typeof ticker.cancelGreet === 'function') ticker.cancelGreet()
  console.log(deathLine(bot))
}

function handleRespawn(bot, ticker) {
  if (ticker && typeof ticker.clearLead === 'function') ticker.clearLead()
  console.log(respawnLine(bot))
}

// jr2.2: an order takes the body even at night — the server ignores
// movement from a sleeping player until the client sends leave-bed, which
// only bot.wake() sends (revmux 01-review). Awake bots pass through.
function wakeBody(bot) {
  try {
    if (!bot || !bot.isSleeping || typeof bot.wake !== 'function') return
  } catch (_) { return }
  void (async () => { try { await bot.wake() } catch (_) { /* already awake: the event won */ } })()
}

function handlePlayerLeft(bot, ticker, player) {
  if (ticker && typeof ticker.clearLead === 'function') ticker.clearLead(player)
}

// Death/respawn pair: mineflayer also emits 'respawn' on dimension change
// (portal transit), which is not a reappearance after death. The flag keeps
// the log strictly paired — one respawn line per observed death — so the
// death/respawn counts stay meaningful.
function createLifecycle(ticker) {
  let died = false
  return {
    onDeath(bot, t = ticker) { died = true; metrics.events.inc({ event: 'death' }); try { if (t && typeof t.noteDeath === 'function') t.noteDeath() } catch (_) { /* counter best-effort */ } handleDeath(bot, t) },
    onRespawn(bot, t = ticker) {
      if (!died) return
      died = false
      metrics.events.inc({ event: 'respawn' })
      handleRespawn(bot, t)
    },
    onSpawnReset(bot) {
      try {
        const ctx = bot && bot._tickerCtx
        if (ctx && ctx.home) delete ctx.home.sleptA // obstructed/mined: the spawn is world spawn again
      } catch (_) { /* claim best-effort */ }
    },
  }
}

// Kit line (3nt.20): mineflayer-pathfinder only pillars/bridges when
// dirt/cobblestone is in inventory (remainingBlocks>0) and digs cheaply
// with a pickaxe (bestHarvestTool). Logged on every spawn so the next
// stuck report shows whether the bot could have climbed at all.
// ponytail: deliberately NOT self-/give on respawn (needs the bot itself
// as OP); with keepInventory the kit survives death, so a manual /give is
// enough until blocks run out.
function kitLine(bot) {
  let scaffold = 0
  let pickaxe = false
  let sword = false
  let food = 0
  try {
    const items = bot.inventory.items()
    if (Array.isArray(items)) {
      for (const i of items) {
        if (!i || typeof i.name !== 'string') continue
        if (i.name === 'dirt' || i.name === 'cobblestone') scaffold += typeof i.count === 'number' ? i.count : 1
        if (i.name.endsWith('_pickaxe')) pickaxe = true
        if (i.name.endsWith('_sword')) sword = true
        if (EDIBLE_FOODS.has(i.name)) food += typeof i.count === 'number' ? i.count : 1
      }
    }
  } catch (_) { /* inventory not ready at spawn: the line must still print */ }
  return `kit scaffold=${scaffold} pickaxe=${pickaxe ? 'yes' : 'no'} sword=${sword ? 'yes' : 'no'} food=${food}`
}

module.exports = { createTicker, BEHAVIOURS, handleChat, advancePendingSearch, parseAutonomous, autonomousEffective, resolvePlayer, startupFollow, handleDeath, handleRespawn, handlePlayerLeft, deathLine, respawnLine, kitLine, createLifecycle, wakeBody, TARGET_GONE_TICKS, parseLeaveAfterMs, waitForPlayers, playersOccupied, runOnce, eatReflex, EDIBLE_FOODS }
