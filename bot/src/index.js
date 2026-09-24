'use strict'

const mineflayer = require('mineflayer')
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder')
const { makeBrain, stubBrain, jevBrain, hybridBrain, sourceForUrl, JEV_ENDPOINT } = require('./brain')
const { findTarget, resolvePlayer, buildState, stateKey, isFightTarget, findCreeper, snapHostiles } = require('./perception')
const { makeScout, findNearest, loadedSearchRadius, startFarSearch, stepFarSearch } = require('./behaviours/scout')
const { createGreeter } = require('./greet')
const { addSwimExits } = require('./swim')
const { addNoCornerCut } = require('./nocorner')
const { addSnowGround } = require('./snow')
const { helpReply, lookupCommand, detailLine } = require('./commands')
const metrics = require('./metrics')

const fightMod = require('./behaviours/fight')
const LAYA_URL_DEFAULT = 'http://laya:8000/v1/systemone'
function brainTimeoutMs(env) {
  const raw = parseInt((env && env.BRAIN_TIMEOUT_MS) || (env && env.BRAIN_TICK_MS) || '1000', 10)
  return Number.isFinite(raw) ? raw : 1000
}
const bringMod = require('./behaviours/bring')
const homeMod = require('./behaviours/home')
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
  craft: require('./behaviours/craft'),
  equip: require('./behaviours/equip'),
  rest: require('./behaviours/rest'),
  gohome: homeMod.gohome,
  stay: homeMod.stay,
  build: require('./behaviours/build'),
  explore: require('./behaviours/explore'),
  forage: require('./behaviours/forage'),
  deliver: require('./behaviours/deliver'),
  // Recovery primitives (ef3): one BEHAVIOURS line each, like goal steps.
  pillar_up: (bot, ctx) => recover.run(bot, ctx),
  dig_up: (bot, ctx) => recover.run(bot, ctx),
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
    if (ctx.bring) { metrics.bring.inc({ outcome: 'cancelled', kind: (ctx.bring && ctx.bring.kind) || 'block' }); ctx.bring = null; bringMod.clearSearchLeg(ctx) }
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
  function noteDisplacement() {
    if (ctx.paused) return
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
    } else if (!moving) ctx.stuckTicks = 0
    if (bp) ctx.lastPos = { x: bp.x, y: bp.y, z: bp.z }
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
    ctx.stuck = null
    ctx.recovery = null
    ctx.stuckTicks = 0
    ctx.recoverLatch = null
  }

  // Greeting checks (v92): whoever the body approaches — the follow
  // target, or the bring recipient on the way back — is measured directly;
  // the module latches the far -> near edge. Only fighting or fleeing
  // suppress it (near a still player the stub says roam/idle, not follow).
  function greetCheck(decision) {
    if (decision.action === 'fight' || decision.action === 'flee') return
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
    // sprint stays on the decision line as the brain's opinion only; the
    // body never sprints (see setMovements).
    const dist = typeof state.distance_to_player === 'number' ? state.distance_to_player.toFixed(1) : 'none'
    console.log(`decision source=${decision.source} action=${decision.action} sprint=${decision.sprint} dist=${dist} ${pathSuffix()}`)
  }

  let timer = null
  let destroyed = false
  function scheduleNext(fast) {
    if (destroyed) return
    if (timer) { clearTimeout(timer); timer = null }
    timer = setTimeout(() => { timer = null; void tick() }, fast ? tickMs : idleTickMs)
    if (timer && typeof timer.unref === 'function') timer.unref()
  }

  async function tick() {
    const endTimer = metrics.tickDuration.startTimer()
    const r = await runTick()
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

  async function runTick() {
    if (inFlight) { scheduleNext(lastVisible); return { decision: null, calledBrain: false } }
    inFlight = true
    // canDig belongs to the gohome walk alone: any tick it does not own the
    // body gets the shared default back, so a mid-walk preemption (orders,
    // homing, death) cannot leak no-dig into other behaviours (revmux 8kc).
    if (!(ctx.work && ctx.step === 'gohome' && ctx.gohome && ctx.gohome.phase === 'walk')) {
      try {
        const mov = ctx.movements
        if (mov && typeof mov.canDig === 'boolean') mov.canDig = true
      } catch (_) { /* default best-effort */ }
    }
    // Far-search slices (amb): at most ~120ms CPU here, completion chats.
    try { advancePendingSearch(bot, { setLead: (order) => { clearStuck(); ctx.lead = order; ctx.leadStuck = 0; ctx.leadTargetGone = 0; ctx.paused = false; if (ctx.bring) { metrics.bring.inc({ outcome: 'cancelled', kind: (ctx.bring && ctx.bring.kind) || 'block' }); ctx.bring = null; bringMod.clearSearchLeg(ctx) } ctx.step = null; ctx.stepStatus = null; ctx.gohome = null; ctx.stay = null; ctx.inShelter = false; try { const mov = ctx.movements; if (mov && typeof mov.canDig === 'boolean') mov.canDig = true } catch (_) { /* reset best-effort */ } }, clearStuck: () => { clearStuck() } }, ctx) } catch (_) { /* search never breaks the tick */ }
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
          if (!ctx.scout && bot.registry) ctx.scout = makeScout(bot)
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
      } else if (!target && (rosterOnline || ctx.autonomous) && (!ctx.work || followWaiting) && !ctx.bring) {
        ctx.unseenTicks = (ctx.unseenTicks || 0) + 1
      } else ctx.unseenTicks = 0
      const homing = (ctx.unseenTicks || 0) >= UNSEEN_HOME_TICKS
      // An active bring-me owns the body like work-alone: the bot fetches up
      // to 48 blocks out, past entity-tracking range, so the idle branch must
      // not park it and the homing walk must not steal it mid-order.
      const workAlone = (ctx.work || ctx.bring) && !target && (rosterOnline || ctx.autonomous) && !homing
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
      if (!ctx.scout && bot.registry) ctx.scout = makeScout(bot)
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
        // arrival starves into an orbit.
        const nightOwns = ctx.work && (ctx.step === 'gohome' || ctx.step === 'stay')
        // p4s: no place_error backstop — a placement-error streak is the
        // step's own signal (follow/gather count it toward their stalls), and
        // handing the body to recover on it turned rest/roam traps into long
        // sidestep/dig/call episodes. Only the no-displacement backstop stays.
        if (!nightOwns && (ctx.stuckTicks || 0) >= recover.STUCK_TICKS_ENTRY) {
          ctx.stuck = { by: 'no-displacement', goal: null, key: 'ticker' }
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
      // Work mode (epic rw4) owns the body like an order: the goal arbiter
      // picks the step, except fight which still preempts (safety beats work).
      // Placed after lead so an explicit find-me order wins its ticks.
      if (ctx.inShelter && decision.action === 'fight') {
        // Sheltered for the night: no pursuit through our own wall (the
        // pathfinder would dig it with canDig). The melee reflex above
        // still swings at anything that gets inside.
        stopOnce()
        console.log(`decision source=${decision.source} action=shelter dist=none ${pathSuffix()}`)
        return { decision: { action: 'idle', sprint: false, source: 'local-idle' }, calledBrain }
      }
      if (ctx.work && decision.action !== 'fight') {
        if (!ctx.home && !ctx.adoptDone) {
          // Spawn adoption races chunk loading (one shot at join sees an
          // empty world): hold work until the spawn block is visible, then
          // adopt once before build defaults a fresh site. Readiness needs
          // positive evidence once a spawn is known; without a spawn yet
          // (or without a blockAt hook, i.e. unit mocks) adoption no-ops,
          // so work proceeds and the one shot waits for the spawn below.
          let ready = true
          try { if (bot.blockAt && bot.spawnPoint) ready = !!bot.blockAt(bot.spawnPoint) } catch (_) { ready = true }
          if (ready || (ctx.adoptTries = (ctx.adoptTries || 0) + 1) > 60) {
            if (!ctx.adoptDone && bot.spawnPoint) ctx.adoptDone = true
            try {
              const foundEarly = goal.adoptHome(bot)
              // Same resets as setHome below (no ticker handle in this scope).
              if (foundEarly) { ctx.home = foundEarly; ctx.buildSkip = []; ctx.buildFails = 0; ctx.buildFailIdx = -1; ctx.buildGoalIdx = -1; try { memory.save(bot, ctx) } catch (_) { /* memory best-effort */ } }
            } catch (_) { /* no adoptable house; build defaults below */ }
          } else {
            if (ctx.adoptTries <= 1) console.log('waiting for spawn chunks before work')
            return { decision: { action: 'idle', sprint: false, source: 'local-idle' }, calledBrain }
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
        return { decision, calledBrain }
      }
      applyDecision(decision, target, state)
      return { decision, calledBrain }
    } catch (err) {
      console.error(`tick error: ${err && err.message ? err.message : err}`)
      return { decision: null, calledBrain }
    } finally {
      inFlight = false
      scheduleNext(lastVisible || reflexFast || workTickFast)
    }
  }

  return {
    tick,
    setPathStatus: (status) => { ctx.lastPathStatus = status || 'none' },
    // Head of the latest plan (b50): the executor works this list from
    // [0] down, so the wedge line can name the terrain it faces.
    setPathNext: (n) => { ctx.lastPathNext = n && typeof n.clone === 'function' ? n.clone() : (n && typeof n.x === 'number' ? { x: n.x, y: n.y, z: n.z } : null) },
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
    // only on flat segments needs a hook inside the pathfinder executor.
    setMovements: (m) => { if (m) { m.allowSprinting = false; addSwimExits(m); addNoCornerCut(m); addSnowGround(m) } ctx.movements = m; bot.pathfinder.setMovements(m) },
    destroy,
    rearm,
    setFollow: (name) => {
      clearPendingSearch(ctx)
      clearStuck()
      resetNightStep()
      if (ctx.bring) { metrics.bring.inc({ outcome: 'cancelled', kind: (ctx.bring && ctx.bring.kind) || 'block' }); ctx.bring = null; bringMod.clearSearchLeg(ctx) }
      ctx.inShelter = false
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
    setHome: (home) => { ctx.home = home || null; ctx.inShelter = false; ctx.buildSkip = []; ctx.buildFails = 0; ctx.buildFailIdx = -1; ctx.buildGoalIdx = -1; try { memory.save(bot, ctx) } catch (_) { /* memory best-effort */ } },
    // Disk memory (idkcraft-hlk): explicit seams for load-before-adopt and
    // save-on-exit; the periodic tick save covers the rest.
    loadMemory: () => { try { return memory.restore(bot, ctx) } catch (_) { return null } },
    saveMemory: () => { try { return memory.save(bot, ctx) } catch (_) { return false } },
    stop: () => {
      clearPendingSearch(ctx)
      clearStuck()
      resetNightStep()
      if (ctx.bring) { metrics.bring.inc({ outcome: 'cancelled', kind: (ctx.bring && ctx.bring.kind) || 'block' }); ctx.bring = null; bringMod.clearSearchLeg(ctx) }
      ctx.paused = true
      ctx.work = false
      ctx.lead = null
      ctx.leadStuck = 0
      ctx.leadTargetGone = 0
      stopOnce()
    },
    setLead: (order) => { clearStuck(); resetNightStep(); ctx.lead = order; ctx.leadStuck = 0; ctx.leadTargetGone = 0; ctx.paused = false; if (ctx.bring) { metrics.bring.inc({ outcome: 'cancelled', kind: (ctx.bring && ctx.bring.kind) || 'block' }); ctx.bring = null; bringMod.clearSearchLeg(ctx) } },
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
          ctx.bring = {
            kind: 'food', name: 'food', want: n, by, drop: have.name, have: give,
            phase: 'return', saidWaiting: false, announced: true,
          }
          ctx.paused = false
          return `coming with ${give} ${have.name}`
        }
        clearStuck()
        ctx.bring = {
          kind: 'food', name: 'food', want: n, by, drop: null, have: 0,
          phase: 'find', announced: false, animal: null,
        }
        ctx.paused = false
        return 'looking for animals'
      }
      const res = findNearest(bot, name)
      if (res === 'unknown') return `unknown block: ${name}`
      if (!res) {
        // Sync 48 is empty: the 96/160 shells run sliced across ticks (amb).
        // A null cursor (unreadable world) answers from sync alone — unless
        // an anchor exists, when the order opens and search legs walk (atl.8).
        const search = startFarSearch(bot, name)
        if (search === 'unknown') return `unknown block: ${name}`
        if (!search) {
          if (!bringMod.canSearch(bot, ctx)) return `no ${name} within ${loadedSearchRadius(bot)} blocks (loaded area)`
          if (!bringMod.canBringName(bot, name)) return `can't bring ${name} — ores and logs only`
          if (ctx.lead) { ctx.lead = null; ctx.leadStuck = 0; ctx.leadTargetGone = 0 }
          ctx.unseenTicks = 0
          ctx.resumeWork = false
          clearStuck()
          ctx.bring = {
            kind: 'block', name, want, by, phase: 'find',
            have: 0, announced: false, searchSkipFar: true,
          }
          ctx.paused = false
          return `nothing within 48, searching for ${name}…`
        }
        ctx.pendingSearch = { cursor: search, kind: 'bring', name, want, by }
        return `nothing within 48, widening the search for ${name}…`
      }
      clearStuck()
      return startBlockOrder(bot, ctx, { name, want, by }, res)
    },
    status: () => {
      const facts = goal.goalFacts(bot, ctx)
      const mode = ctx.bring ? 'bringing' : (ctx.work ? 'working' : (ctx.paused ? 'parked' : (ctx.lead ? 'leading' : 'following')))
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
      console.log(`spawned as ${bot.username}`)
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
    bot.on('path_update', (r) => { if (r && r.status) ticker.setPathStatus(r.status); if (r && Array.isArray(r.path) && r.path.length > 0) ticker.setPathNext(r.path[0]) })
    bot.on('path_reset', (reason) => ticker.setPathReset(reason))

    const life = createLifecycle(ticker)
    bot.on('death', () => life.onDeath(bot))
    bot.on('respawn', () => life.onRespawn(bot))
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
    return `need ${tier === 'iron' ? 'an' : 'a'} ${tier} pickaxe for ${res.name}`
  }
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
  ctx.paused = false
  return `going for ${want} ${res.name}, ${res.distance} blocks away`
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
function advancePendingSearch(bot, ticker, ctx) {
  const p = ctx && ctx.pendingSearch
  if (!p) return
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
    if (!r.result) {
      // atl.8: open the order instead of refusing — the first tick walks
      // search legs (the far shells just came up empty, skip the re-scan).
      if (!bringMod.canBringName(bot, p.name)) {
        bot.chat(`can't bring ${p.name} — ores and logs only`)
        return
      }
      ctx.bring = {
        kind: 'block', name: p.name, want: p.want, by: p.by, phase: 'find',
        have: 0, announced: false, searchSkipFar: true,
      }
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
      const m = msg.match(/^bring me\s+(something to eat|\S+)(?:\s+(\d+))?$/)
      if (!m) {
        bot.chat('try: bring me coal')
      } else if (ticker && typeof ticker.setBring === 'function') {
        const food = bringMod.isFoodRequest(m[1])
        const want = m[2]
          ? Math.min(bringMod.WANT_MAX, Math.max(1, parseInt(m[2], 10)))
          : (food ? bringMod.WANT_FOOD : (/logs?$|_log$/.test(m[1]) ? bringMod.WANT_LOGS : bringMod.WANT_ORE))
        bot.chat(ticker.setBring({ name: m[1], want, by: playerName }))
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
  // bot.spawnPoint instead: this bot sets no bed/anchor, meaning respawn
  // always lands on world spawn. Entity position is the fallback.
  const dest = (bot.spawnPoint && { x: bot.spawnPoint.x, y: bot.spawnPoint.y, z: bot.spawnPoint.z }) ||
    (bot.entity && bot.entity.position)
  const at = dest ? `${Math.floor(dest.x)} ${Math.floor(dest.y)} ${Math.floor(dest.z)}` : 'unknown'
  return `respawn at ${at}`
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
    onDeath(bot, t = ticker) { died = true; metrics.events.inc({ event: 'death' }); handleDeath(bot, t) },
    onRespawn(bot, t = ticker) {
      if (!died) return
      died = false
      metrics.events.inc({ event: 'respawn' })
      handleRespawn(bot, t)
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

module.exports = { createTicker, BEHAVIOURS, handleChat, advancePendingSearch, parseAutonomous, autonomousEffective, resolvePlayer, startupFollow, handleDeath, handleRespawn, handlePlayerLeft, deathLine, respawnLine, kitLine, createLifecycle, TARGET_GONE_TICKS, parseLeaveAfterMs, waitForPlayers, playersOccupied, runOnce, eatReflex, EDIBLE_FOODS }
