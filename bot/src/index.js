'use strict'

const mineflayer = require('mineflayer')
const Vec3 = require('vec3')
const { pathfinder, Movements } = require('mineflayer-pathfinder')
const { makeBrain, stubBrain, jevBrain, hybridBrain, sourceForUrl, JEV_ENDPOINT, isHard, brainTimeoutMs, layaUrl, planner } = require('./brain')
const { findTarget, resolvePlayer, buildState, stateKey, isFightTarget, snapHostiles } = require('./perception')
const { makeScout } = require('./behaviours/scout')
const stuck = require('./stuck')
const { UNSEEN_HOME_TICKS } = stuck
const body = require('./body')
const { handleChat, advancePendingSearch, clearPendingSearch, wakeBody } = require('./chat')
const { createOrders } = require('./orders')
const { eatReflex, EDIBLE_FOODS, breathReflex, BREATH_OXYGEN_LOW, BREATH_OXYGEN_FULL, meleeReflex, fleeReflex, installEquipGuard } = require('./reflexes')
const { createGreeter } = require('./greet')
const { addSwimExits, addSwimPrune } = require('./swim')
const doors = require('./doors')
const { addNoCornerCut } = require('./nocorner')
const { addSnowGround } = require('./snow')
const { addJumpUpCost } = require('./jumpcost')
const { trackPlaced, installPlaceTiming } = require('./behaviours/util')
const unpin = require('./unpin')
const decontact = require('./decontact')
const dangerMod = require('./danger')
const exploreMod = require('./behaviours/explore')
const metrics = require('./metrics')
const stepMod = require('./step')

const fightMod = require('./behaviours/fight')
const retreatMod = require('./behaviours/retreat')
const bringMod = require('./behaviours/bring')
require('./behaviours/flat') // ponytail: kept for load order only (the table moved to behaviours/index.js)
const homeMod = require('./behaviours/home')
const buildMod = require('./behaviours/build')
const castleMod = require('./behaviours/castle')
const goal = require('./goal')
const memory = require('./memory')
const taskMod = require('./task')
const recover = require('./behaviours/recover')
// The table lives in behaviours/index.js (oqul.3); same object re-exported.
const { BEHAVIOURS } = require('./behaviours/index')

// Poll cadence when nobody is online: no JEV calls happen there, so waking
// up every 10 s just to re-scan the player list is plenty.
const IDLE_TICK_MS = 10000
const IDLE_LOG_MS = 60000
// Taking-fire memory (0ay): an hp drop counts as hostile fire for this
// long. Arrows land ~1/s and poison ticks every 1.25 s, so 5 s bridges a
// few quiet ticks without fleeing stale shadows.
const HURT_FRESH_MS = 5000
const SHELTER_RELEASE_R = 3 // vmzq.58: melee range that releases an open shelter hold to fight
const SHELTER_HURT_MS = 2000 // vmzq.58: ... or a hit this fresh with a hostile in the fight radius
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
// Adopt retries (idkcraft-im4): ready-but-doorless ticks before giving up
// to build. Door chunks trail the spawn block by seconds on a real
// server; 5 ticks cover the stream with a bounded fresh-world delay.
const ADOPT_GRACE = 5
const FAR_FROM_SPAWN = 64

function createTicker({ bot, brain, tickMs = 1000, idleTickMs = IDLE_TICK_MS, followName = '', leaveAfterMs = 0, onLeave = null, now = () => Date.now(), brainEngine = '', greeter = null, autonomous = false }) {
  // Greeting gesture (v92): injectable for fake-clock tests, real otherwise.
  const greet = greeter || createGreeter()
  // ctx.brain feeds goal chooseStep; setBrain refreshes both this and the
  // decide closure below, so 'brain jev' steers step choice too.
  const ctx = { lastGoalKey: '', movements: null, paused: false, lead: null, reflexTargetId: null, reflexSwung: false, stuckResets: 0, placeErrors: 0, jumpCooldown: 0, eatInFlight: false, fleeTargetId: null, lastHostileSnap: null, work: false, step: '', stepStatus: null, goalText: null, brain, stuck: null, recovery: null, stuckTicks: 0, stuckState: 'MOVING', lastPos: null }
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
    // Both wrap bot.placeBlock on the first spawn (mineflayer injects it
    // after createTicker); call order is wrap order: timing(track(raw)).
    trackPlaced(bot, ctx) // idkcraft-drq/dahd: record own placements for the dig guard
    installPlaceTiming(bot) // idkcraft-6x7.11: jump-place waits for the feet to clear
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
  function walkHomeTick() { return stuck.walkHomeTick(bot, ctx) }

  function homeReached() { return stuck.homeReached(bot) }

  // work() body, shared with the homing resume below (one definition, so the
  // resume cannot drift from the chat command).
  // Night-step reset (rw4.5, revmux 01-review loop+goal-4): a stale
  // gohome/stay record (or shelter) must not survive an order, stop or fresh
  // work — the next decide re-arms from facts.
  function resetNightStep() {
    ctx.step = null
    ctx.stepStatus = null
    stepMod.nextStepGen(ctx) // oqul.7: the old step's late async completions drop
    ctx.gohome = null
    ctx.stay = null
    ctx.shelter = null
    ctx.inShelter = false
    wakeBody(bot) // jr2.2: an order takes the body even at night
    // canDig is the body's (body.js): clearing ctx.gohome above ends the
    // walk borrow — re-apply here, not next tick, so an order/stop/homing
    // that ends the walk mid-phase restores digging at once (8kc e3/e5).
    try { body.claimBody(bot, ctx, (ctx.body && ctx.body.owner) || 'idle') } catch (_) { /* lease best-effort */ }
  }
  function startWork() {
    clearPendingSearch(ctx)
    clearStuck()
    resetNightStep()
    homeMod.releaseMeet(bot, ctx) // inside: the exit legs run before the first work path (jr2.3)
    ctx.gocastle = null
    if (ctx.bring) { metrics.bring.inc({ outcome: 'cancelled', kind: (ctx.bring && ctx.bring.kind) || 'block' }); ctx.bring = null; bringMod.clearSearchLeg(ctx) }
    ctx.flat = null
    ctx.work = true
    ctx.paused = false
    ctx.lead = null
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
    try { taskMod.resetTask(ctx) } catch (_) { /* task reset best-effort */ }
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

  // Stuck detection (the MOVING→…→COOLDOWN machine) lives in stuck.js; the
  // ticker samples it once per tick on both branches and routes the fact.

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
      // Alone-exemption for plan() only (idkcraft-vmzq.5): the tick ask
      // runs free/off, but the stall-point planner still reaches JEV. A
      // laya-stepped-down brain keeps plan() automatically (plan posts to
      // JEV, never to the tick URL); the off brain needs it attached, and
      // only when the key exists.
      const key = process.env.TYPESAFE_API_KEY
      const next = to === 'laya'
        ? hybridBrain(jevBrain(key, undefined, brainTimeoutMs(process.env), url))
        : key ? { ...stubBrain, ...planner(key) } : stubBrain
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

  function clearStuck() { return stuck.clearStuck(ctx) }

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
    // Lease refresh with the dispatch's own target/state and fresh keys —
    // the only sprint application (see body.js). Same owner, no cleanup.
    try { body.claimBody(bot, ctx, (ctx.body && ctx.body.owner) || 'idle', { sprint: true, target, dist: state && state.distance_to_player }) } catch (_) { /* lease best-effort */ }
    greetCheck(decision)
    // sprint stays on the decision line as the brain's opinion; the body
    // sprints only on flat follow pursuit (see body.js).
    const dist = typeof state.distance_to_player === 'number' ? state.distance_to_player.toFixed(1) : 'none'
    console.log(`decision source=${decision.source} action=${decision.action} sprint=${decision.sprint} dist=${dist} ${pathSuffix()}`)
  }

  let timer = null
  let destroyed = false
  // Per-tick fast-cadence flag, reset by runTick; the parked/alone blocks set
  // it and the finally reads it. inFlight serialises ticks, so one per ticker.
  let reflexFast = false
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
    await tickPrelude()
    let calledBrain = false
    // Fast cadence while the reflex swings with nobody online: those ticks
    // make no brain call, so speeding them up costs nothing.
    reflexFast = false
    // Fast cadence while working out of sight (see workAlone below): the
    // goal arbiter must keep deciding every tick, like a visible player.
    let workTickFast = false
    try {
      if (ctx.paused) return parkedTick()
      const { target, workAlone } = presence()
      if (workAlone) workTickFast = true
      if (!target && !workAlone) return await aloneTick()
      const state = tickState(target)
      const guarded = reflexGuards(state, calledBrain)
      if (guarded) return guarded
      let decision = null
      if (ctx.stuck && !urgentFight(state)) return await recoverTick(target, state, calledBrain)
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
          ctx.lastDecision = decision // gwvg: status() reads the follow/fight/idle source from here
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
      const ordered = await ordersDispatch(target, state, decision, calledBrain)
      if (ordered) return ordered
      const { shelterRun, nightGraceHold, intruder, dayDivert, dayNow } = holdFlags(target, state, decision)
      if (ctx.inShelter && decision.action === 'fight' && !intruder && !dayDivert) return shelterHold(target, state, decision, calledBrain, dayNow)
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
      if (ctx.work && (decision.action !== 'fight' || shelterRun || nightGraceHold || underFire || dayDivert)) {
        const held = adoptGate(calledBrain)
        if (held) return held
        return await workTick(target, state, decision, calledBrain, underFire, nightGraceHold)
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
      // A body in water ticks fast even parked: the breath trigger window
      // (oxygen 10 → 0 ≈ 7.5 s) is shorter than one 10 s idle tick, so a
      // slow first check can come after the lungs are already empty
      // (revmux 01 core-2). Dry parked ticks stay slow.
      let wetFast = false
      try { wetFast = !!(bot && bot.entity && bot.entity.isInWater === true) } catch (_) { wetFast = false }
      if (scheduled) scheduleNext(lastVisible || reflexFast || workTickFast || wetFast)
    }
  }

  async function tickPrelude() {
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
    // Door reflex (idkcraft-6xno): open the plan's next door within reach,
    // shut our own openings behind us. Reads only + activateBlock, so it
    // runs ahead of every branch (paused, alone, normal) like unpin.
    try { doors.doorReflex(bot, ctx) } catch (_) { /* doors best-effort */ }
    // Far-search slices (amb): at most ~120ms CPU here, completion chats.
    try { await advancePendingSearch(bot, { setLead: (order) => { clearStuck(); ctx.lead = order; ctx.leadTargetGone = 0; ctx.paused = false; ctx.gocastle = null; if (ctx.bring) { metrics.bring.inc({ outcome: 'cancelled', kind: (ctx.bring && ctx.bring.kind) || 'block' }); ctx.bring = null; bringMod.clearSearchLeg(ctx) } resetNightStep(); homeMod.releaseMeet(bot, ctx) }, clearStuck: () => { clearStuck() } }, ctx) } catch (_) { /* search never breaks the tick */ }
    // Body lease (idkcraft-6x7.3): the tick's owner, computed once here —
    // after the far-search await (a setLead mid-await takes the body this
    // tick) and before any dispatch. A switch runs the single cleanup and
    // applies movementsFor; otherwise this only re-applies the flags.
    try { body.resetTick(ctx); body.claimBody(bot, ctx, body.pickOwner(ctx)) } catch (_) { /* lease best-effort */ }
    // Castle guard (idkcraft-g0z.2): laid castle blocks are never break
    // candidates for ANY executor; re-installs after a Movements swap.
    castleMod.guardCastle(bot, ctx)
    // Residence (g0z.29): a completed castle / a forget switches the home
    // here, at the tick top, once no async home op is in flight.
    try { orders.selectResidence() } catch (_) { /* residence best-effort */ }
    ctx.reflexSwung = false // fresh each tick: fight skips its swing once the reflex swung
  }

  function parkedTick() {
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
    // Breath while parked (0u9): 'stop' parks the body, it must not
    // drown it. After stopOnce (its control clear would drop the jump).
    if (!fledParked && breathReflex(bot, ctx)) reflexFast = true
    const now = Date.now()
    if (now - lastIdleLog >= IDLE_LOG_MS) {
      lastIdleLog = now
      console.log(`decision source=local-idle action=idle sprint=false dist=none ${pathSuffix()}`)
    }
    return { decision: { action: 'idle', sprint: false, source: 'local-idle' }, calledBrain: false }
  }

  function presence() {
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
    if (target && !ctx.recovery && ctx.stuck && ctx.stuck.by === 'home') {
      // Sighting ends the homing walk: drop the fact AND its still streak,
      // or it re-raises by=home this same tick (the key flips later).
      ctx.stuck = null
      ctx.stuckTicks = 0
      ctx.buriedStills = 0 // vmzq.42 r2: the streak family resets together
      ctx.stuckState = 'MOVING'
    }
    if (homeReached()) {
      // Arrived means the homing goal is met, not stuck: pin the still
      // streak at zero and drop a stale home fact/latch (2oe).
      ctx.stuckTicks = 0
      ctx.buriedStills = 0 // vmzq.42 r2: the streak family resets together
      if (!ctx.recovery) ctx.stuckState = 'MOVING'
      if (!ctx.recovery && ctx.stuck && ctx.stuck.by === 'home') ctx.stuck = null
      if (ctx.recoverLatch && ctx.recoverLatch.by === 'home') ctx.recoverLatch = null
      // A pending follow order keeps the unseen latch: stand until the
      // player is visible instead of oscillating work-vs-home.
      if (!followWaiting) {
        if (ctx.resumeWork && !followName) startWork()
        ctx.unseenTicks = 0
      }
    } else if (!target && (rosterOnline || ctx.autonomous) && (!ctx.work || followWaiting) && !ctx.bring && !(ctx.flat && !ctx.flat.parked) && !ctx.comehome && !ctx.gocastle) {
      ctx.unseenTicks = (ctx.unseenTicks || 0) + 1
    } else ctx.unseenTicks = 0
    const homing = (ctx.unseenTicks || 0) >= UNSEEN_HOME_TICKS
    // An active bring-me owns the body like work-alone: the bot fetches up
    // to 48 blocks out, past entity-tracking range, so the idle branch must
    // not park it and the homing walk must not steal it mid-order. The
    // come-home meet rides the same way (jr2.3): the owner waits at home,
    // out of tracking range while the bot walks.
    const workAlone = (ctx.work || ctx.bring || (ctx.flat && !ctx.flat.parked) || ctx.comehome || ctx.gocastle) && !target && (rosterOnline || ctx.autonomous) && !homing
    return { target, workAlone }
  }

  async function aloneTick() {
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
    // Breath while alone (0u9): an idle bot parked under water drowns
    // as surely as a digging one. After the stop (its control clear
    // would drop the jump); the stuck menu waits while it surfaces.
    const breathedAlone = !fledAlone && breathReflex(bot, ctx)
    if (breathedAlone) reflexFast = true
    // Melee reflex at spawn: the brain never runs here, but a hostile
    // standing on the bot still gets swung at every slow tick.
    let idleState = null
    try {
      idleState = buildState(bot, null)
      if (meleeReflex(bot, ctx, idleState)) reflexFast = true
      eatReflex(bot, ctx, idleState)
    } catch (_) { /* facts best-effort */ }
    // Sample the stuck machine for the homing walk (2oe): pure local
    // math, no brain call, so the cost guard holds. A wedged homing
    // walk raises by=home off the return-spawn key.
    stuck.update(bot, ctx)
    // Only the home fact: the idle branch is cost-guarded (no brain
    // calls with nobody online), so a pre-existing follow/gather
    // episode pauses while alone and resumes on sighting — while a
    // homing walk that wedged (2oe) reaches the menu here, same
    // routing as the target path above. After release the walk
    // re-issues (release clears lastGoalKey) and the latch admits one
    // episode per situation.
    if (ctx.stuck && ctx.stuck.by === 'home' && !urgentFight(idleState) && !breathedAlone) {
      try { greet.cancel(bot) } catch (_) { /* sneak best-effort */ }
      // Lease: the menu owns pre-decide, so a raise this tick switches before the episode starts.
      try { body.claimBody(bot, ctx, 'recover') } catch (_) { /* lease best-effort */ }
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

  function tickState(target) {
    ctx.leadTargetGone = 0
    if (typeof bot.health === 'number' && bot.health <= 0) {
      if (ctx.lead) bot.chat('following you again')
      ctx.lead = null
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
    return state
  }

  function reflexGuards(state, calledBrain) {
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
    // Drowning owns the body over every order (0u9): a dig 3 blocks down
    // still kills when the vein sits under a lake.
    if (breathReflex(bot, ctx)) {
      const breathPlayerDist = typeof state.distance_to_player === 'number' ? state.distance_to_player.toFixed(1) : 'none'
      console.log(`decision source=reflex action=breath dist=${breathPlayerDist} ${pathSuffix()}`)
      return { decision: { action: 'breath', sprint: false, source: 'reflex' }, calledBrain }
    }
    // Hard-case stuck (ef3) detection lives in stuck.js; routing stays below.
    stuck.update(bot, ctx)
    // Task stall clock (idkcraft-vmzq.2): before recover and the
    // inShelter/fight short-circuits so recover, fight and shelter time
    // counts toward the stall at tick cadence (verify 02 body-1).
    try { taskMod.taskTick(bot, ctx) } catch (_) { /* task clock best-effort */ }
  }

  async function recoverTick(target, state, calledBrain) {
    try { greet.cancel(bot) } catch (_) { /* sneak best-effort */ }
    // Lease: the menu owns pre-decide, so a raise this tick switches before the episode starts.
    try { body.claimBody(bot, ctx, 'recover') } catch (_) { /* lease best-effort */ }
    const decision = await recover.decide(bot, ctx, state, target)
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

  async function ordersDispatch(target, state, decision, calledBrain) {
    // Come-home is an explicit player order like lead: it owns the body
    // above follow/work, except fight which still preempts. Placed before
    // lead so an armed doorway exit runs ahead of any new order's path.
    if (ctx.comehome && decision.action !== 'fight') {
      const handler = BEHAVIOURS.comehome
      if (typeof handler === 'function') handler(bot, ctx, target, state)
      // Lease refresh for the meet's shelter leg (sprint needs fresh keys); same owner, no cleanup.
      try { body.claimBody(bot, ctx, (ctx.body && ctx.body.owner) || 'comehome', { sprint: true }) } catch (_) { /* lease best-effort */ }
      const meetDist = typeof state.distance_to_player === 'number' ? state.distance_to_player.toFixed(1) : 'none'
      console.log(`decision source=${decision.source} action=comehome sprint=${decision.sprint} dist=${meetDist} ${pathSuffix()}`)
      return { decision: { ...decision, action: 'comehome' }, calledBrain }
    }
    if (ctx.gocastle && decision.action !== 'fight') {
      const handler = BEHAVIOURS.gocastle
      if (typeof handler === 'function') handler(bot, ctx, target, state)
      try { body.claimBody(bot, ctx, (ctx.body && ctx.body.owner) || 'gocastle', { sprint: true }) } catch (_) { /* lease best-effort */ }
      const castleDist = typeof state.distance_to_player === 'number' ? state.distance_to_player.toFixed(1) : 'none'
      console.log(`decision source=${decision.source} action=gocastle sprint=${decision.sprint} dist=${castleDist} ${pathSuffix()}`)
      return { decision: { ...decision, action: 'gocastle' }, calledBrain }
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
  }

  function holdFlags(target, state, decision) {
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
    // Post-respawn night grace (idkcraft-lph3): the shelter-run mirror
    // for a night (re)spawn — fight would win every tick while hostiles
    // stay adjacent and the shelter never builds (the bed-loop). While
    // the respawn stamp is fresh the work step below runs first and digs
    // now (melee reflex defends); a stale stamp resumes fight. Alone
    // only (!target: player protection still fights), no order override
    // (comehome/gocastle doorway legs own their ticks, like dayDivert).
    let graceFresh = false
    try { graceFresh = typeof homeMod.nightGrace === 'function' && homeMod.nightGrace(bot, ctx) } catch (_) { graceFresh = false }
    if (!graceFresh) { ctx.nightGraceLogged = false; ctx.nightGraceFallbackLogged = false }
    // vmzq.58 (revmux 01): a shelter release latches while a hostile
    // fact stands, so the grace hold cannot re-arm the open hold on the
    // next tick and flip fight/shelter every other tick.
    if (typeof state.hostile_distance !== 'number') ctx.shelterReleased = false
    const nightGraceHold = ctx.work && !ctx.lead && !ctx.bring && !ctx.comehome && !ctx.gocastle && !ctx.inShelter && !ctx.shelterReleased &&
      decision.action === 'fight' && !target && graceFresh
    if (nightGraceHold && !ctx.nightGraceLogged) {
      console.log('night-grace: holding fight preemption, sheltering')
      ctx.nightGraceLogged = true
    }
    // 33vm: a hostile already INSIDE the interior box is fought (prod: six
    // deaths standing idle in stay with a zombie at 0.7). Scanned, not
    // state.hostile: the nearest may stand outside the wall. The pin and
    // the state swap keep fight's sticky target on the intruder.
    let intruder = null
    if (ctx.inShelter && decision.action === 'fight' && ctx.home) {
      const bp = bot.entity && bot.entity.position
      for (const e of Object.values(bot.entities || {})) {
        if (!e || e.isValid === false || !bp || !isFightTarget(e, bp, null) || !homeMod.isInside({ entity: e }, ctx.home)) continue
        if (!intruder || e.position.distanceTo(bp) < intruder.position.distanceTo(bp)) intruder = e
      }
    }
    if (ctx.inShelter && !intruder) ctx.intruderFight = false
    if (intruder) {
      ctx.fightId = intruder.id
      state.hostile = intruder
      // g9cj: no digging through our own walls while chasing it (no-dig stash, body.js).
      ctx.intruderFight = true
      try { body.claimBody(bot, ctx, (ctx.body && ctx.body.owner) || 'shelter') } catch (_) { /* lease best-effort */ }
    }
    // rw4.15: shelter is a night concept — by day a sheltered fight tick
    // falls through to the work block (goal.decide clears inShelter and
    // the day menu exits) instead of idling before it forever (prod: the
    // bot sat 2 h in its hole, six dawns missed). Positive-day only: an
    // unreadable clock keeps the night hold (fail closed, the gohome
    // stamp precedent). Night unchanged; an intruder still fights (33vm).
    // Orders keep their ticks: lead/bring (the shelterRun gate) plus an
    // exiting comehome / gocastle doorway, whose inShelter guard must
    // survive day fight ticks or the exit paths through the wall (revmux
    // 01 body-1).
    let dayNow = false
    try { dayNow = goal.timeWord(bot) === 'day' } catch (_) { dayNow = false }
    const dayDivert = ctx.work && !ctx.lead && !ctx.bring && !ctx.comehome && !ctx.gocastle &&
      ctx.inShelter && decision.action === 'fight' && !intruder && dayNow
    // vmzq.58: an armed shelter that never enclosed (ground hold after a
    // failed pillar and dig-in) idled next to a zombie until it died —
    // one reflex swing does not kill it. A reachable hostile at melee
    // range (or one within the fight radius right after a hit) releases
    // the hold to fight; when it is gone the work tick re-runs the
    // shelter step. Perched, dug-in and committed-dig holds keep the
    // no-fight hold (shelterOpen).
    if (ctx.inShelter && decision.action === 'fight' && !intruder && !dayDivert) {
      const hd = state.hostile_distance
      const hurtNow = typeof ctx.lastHurtAt === 'number' && (Date.now() - ctx.lastHurtAt) < SHELTER_HURT_MS
      const near = typeof hd === 'number' && state.hostile_reachable !== false &&
        (hd <= SHELTER_RELEASE_R || (hurtNow && hd <= 8))
      let open = false
      try { open = near && homeMod.shelterOpen(ctx) } catch (_) { open = false }
      if (open) {
        console.log(`shelter release: hostile at ${hd.toFixed(1)}, hold not enclosed, fighting`)
        ctx.inShelter = false
        ctx.shelterReleased = true
      }
    }
    return { shelterRun, nightGraceHold, intruder, dayDivert, dayNow }
  }

  function shelterHold(target, state, decision, calledBrain, dayNow) {
    // rw4.18: an exiting comehome doorway keeps its legs on day fight
    // ticks without an intruder — otherwise the exit stalls all day
    // while a mob outside holds fight (this idle never runs the
    // handler, and the order gate above only runs it on non-fight
    // ticks). jr2.3 holds: fight is never dispatched here, the legs
    // are doorway direct control (no A*, no pursuit), and the rw4.17
    // wall guard stays armed. Day is required only to START the exit:
    // committed legs (exit/close, or the toggle sent — carried
    // through the wedge re-arm) finish at dusk/night too, else an
    // exit started before dusk freezes mid-doorway with the door open
    // until dawn (verifier P2, the revmux 02/03 class). By day an
    // already-open door also starts (freezing behind it is worse). A
    // hostile on the out-lane holds the not-started exit shut instead
    // of opening into it (revmux 01 core-1, the bead's 'не выбегая в
    // толпу') — including a pre-open door at night, whose legs never
    // began (revmux 04 body-1); the gate re-checks every tick, so a
    // cleared lane resumes at once. A gocastle without an exiting
    // comehome keeps the hold (its walk is A* — from inside it would
    // path the wall).
    if (ctx.comehome && ctx.comehome.exiting) {
      const exitPhase = ctx.comehome && ctx.comehome.phase
      const exitHome = (ctx.comehome && ctx.comehome.home) || ctx.home
      const legCommitted = !!(ctx.comehome && ctx.comehome.committed)
      let doorShut = true
      let laneClear = false
      try {
        doorShut = homeMod.exitDoorShut(bot, exitHome)
        laneClear = !homeMod.outLaneBlocked(bot, exitHome)
      } catch (_) { doorShut = true; laneClear = false }
      const started = exitPhase === 'exit' || exitPhase === 'close' || legCommitted || (dayNow && !doorShut)
      if (started || (dayNow && laneClear)) {
        const handler = BEHAVIOURS.comehome
        if (typeof handler === 'function') handler(bot, ctx, target, state)
        // Lease refresh for the meet's shelter leg (sprint needs fresh keys); same owner, no cleanup.
        try { body.claimBody(bot, ctx, (ctx.body && ctx.body.owner) || 'comehome', { sprint: true }) } catch (_) { /* lease best-effort */ }
        const meetDist = typeof state.distance_to_player === 'number' ? state.distance_to_player.toFixed(1) : 'none'
        console.log(`decision source=${decision.source} action=comehome sprint=${decision.sprint} dist=${meetDist} ${pathSuffix()}`)
        return { decision: { ...decision, action: 'comehome' }, calledBrain }
      }
    }
    // Committed dig-in (vmzq.30, revmux 01 body-1): the descent
    // suppresses fight, so without this the half-dug pit freezes on
    // fight ticks — the work block below never runs, digInRun never
    // advances, and a camping skeleton wins by arrows. Drive the
    // shelter handler so the dig finishes under melee cover (no
    // pursuit is dispatched here, same as the hold). Mirrors the
    // comehome-exit exception above. A phantom descent in progress
    // (lph3: descended) drives from digs 0 — the walk to the pit
    // is committed too, or walkers at the perch starve it.
    if (ctx.step === 'shelter' && ctx.shelter && ctx.shelter.dig &&
      ((ctx.shelter.dig.digs | 0) > 0 || ctx.shelter.descended)) {
      try {
        const handler = BEHAVIOURS.shelter
        if (typeof handler === 'function') handler(bot, ctx, target, state)
      } catch (_) { /* drive best-effort: hold below */ }
      // Descent walk owns the goal (lph3 revmux 03): stopOnce below
      // would clear the dig-in-walk goal in the same tick, so a
      // cobble-pillar (or stone-stance) descent with walkers at the
      // perch never walks. The walk needs its goal live; the hold
      // still returns idle (no pursuit).
      if (ctx.shelter && ctx.shelter.dig && ctx.shelter.dig.walk) {
        console.log(`decision source=${decision.source} action=shelter dist=none ${pathSuffix()}`)
        return { decision: { action: 'idle', sprint: false, source: 'local-idle' }, calledBrain }
      }
    }
    // Sheltered for the night: no pursuit through our own wall (the
    // pathfinder would dig it with canDig). The melee reflex above
    // still swings at anything that gets inside.
    stopOnce()
    console.log(`decision source=${decision.source} action=shelter dist=none ${pathSuffix()}`)
    return { decision: { action: 'idle', sprint: false, source: 'local-idle' }, calledBrain }
  }

  function adoptGate(calledBrain) {
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
        ctx.home = foundEarly; ctx.buildSkip = []; ctx.buildSkipAt = {}; ctx.buildFails = 0; ctx.buildFailIdx = -1; ctx.buildGoalIdx = -1; ctx.buildFarIdx = -1
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
  }

  async function workTick(target, state, decision, calledBrain, underFire, nightGraceHold) {
    // Retreat chain (1tj): a vetoed follow at low health with a hostile
    // on the bot means the FSM idles and the bot dies standing (gat).
    // 0ay extends it to taking fire from an unreachable hostile (the
    // underFire divert above): same chain — run/pillar breaks the line
    // of fire; a miss falls through to goal.decide, i.e. the old
    // behaviour. The engage log fires only on a dispatched pick, so an
    // empty menu or a declined chain never claims a retreat.
    // Retreat hysteresis (idkcraft-vmzq.49): a latched leg holds across
    // veto flicker — sheltered ticks excepted, like the veto leg,
    // and a truly clear tick (bands) releases at once.
    let retreatHeld = false
    try { retreatHeld = !ctx.inShelter && retreatMod.retreatLatched(ctx) && !retreatMod.retreatClear(bot, state) } catch (_) { retreatHeld = false }
    if ((decision.source === 'fsm-noplayer' && !ctx.inShelter && isHard(state) === 'low-health-hostile') || underFire || retreatHeld) {
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
        if (ctx.step !== retreat.action) stepMod.nextStepGen(ctx) // oqul.7
        ctx.step = retreat.action
        applyDecision(rd, target, state)
        return { decision: rd, calledBrain }
      }
    }
    const brainFight = decision // lph3: the fight the grace hold preempts (for the fallback below)
    // Pre-check (lph3 revmux 02 minor): with no feasible night step,
    // fall back WITHOUT awaiting goal.decide — the await may brain.ask
    // (up to the timeout, possibly paid) for a pick we then discard,
    // and it chats/steps a day job that never runs. Fail open: an
    // unreadable menu proceeds to the post-check below.
    if (nightGraceHold) {
      let nightFeasible = true
      try {
        const facts = goal.goalFacts(bot, ctx)
        nightFeasible = !!(goal.MENU.stay.feasible(facts, bot, ctx) ||
          goal.MENU.gohome.feasible(facts, bot, ctx) || goal.MENU.shelter.feasible(facts, bot, ctx))
      } catch (_) { nightFeasible = true }
      if (!nightFeasible) {
        if (!ctx.nightGraceFallbackLogged) {
          console.log('night-grace: no night step feasible, fighting instead')
          ctx.nightGraceFallbackLogged = true
        }
        applyDecision(brainFight, target, state)
        if (!ctx.paused) ctx.retreat = null
        return { decision: brainFight, calledBrain }
      }
    }
    decision = await goal.decide(bot, ctx)
    if (ctx.paused || !ctx.work) {
      // 'stop' (or a mode change) landed during the goal await: same
      // stale-decision guard as after the brain await above.
      stopOnce()
      return { decision: { action: 'idle', sprint: false, source: 'local-idle' }, calledBrain }
    }
    // Night grace holds only for night steps (lph3 revmux 01): with no
    // home (and no castle) the work block picks a day step — working
    // the dark with fight suppressed for 60 s. Fall back to the
    // brain's fight instead; a night step runs the hold as usual.
    if (nightGraceHold && decision.action !== 'stay' && decision.action !== 'gohome' && decision.action !== 'shelter') {
      if (!ctx.nightGraceFallbackLogged) {
        console.log(`night-grace: work picked ${decision.action}, fighting instead`)
        ctx.nightGraceFallbackLogged = true
      }
      applyDecision(brainFight, target, state)
      if (!ctx.paused) ctx.retreat = null
      return { decision: brainFight, calledBrain }
    }
    // Lease refresh with the fresh step (a gohome walk plans no-dig); same owner, no cleanup.
    try { body.claimBody(bot, ctx, (ctx.body && ctx.body.owner) || 'work') } catch (_) { /* lease best-effort */ }
    applyDecision(decision, target, state)
    // Stale-built revalidation (idkcraft-hlf): an adopt that ran while
    // one plan cell read missing (mid-build, mid-repair, dark chunk)
    // froze built=false, and the build menu goes infeasible on an empty
    // remainder — so the build step that would flip it never runs and
    // the work flow sits on the site stage forever. Re-check the house
    // after every work dispatch; a physically complete house flips here
    // with the same effects as the build step's own done branch (table
    // claim, save, announce). Skips never count (idkcraft-vmzq.10):
    // given-up-but-missing cells keep built=false, else this branch
    // would announce 'home done' over the holes one tick after the
    // build step honestly failed. Post-apply on purpose: normal
    // completions still flow through the build behaviour (which flips
    // first), so only genuinely stuck flags — where build was never
    // dispatched — ever reach this branch.
    if (ctx.home && ctx.home.site && !ctx.home.built) {
      let complete = false
      try {
        // A live clear cell (rw4.19) holds the flip: else the re-open
        // below and this flip would alternate every tick.
        complete = buildMod.isComplete(bot, ctx.home) && !buildMod.clearOwed(bot, ctx.home, ctx.buildSkip)
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
    } else if (ctx.home && ctx.home.site && ctx.home.built && buildMod.clearOwed(bot, ctx.home, ctx.buildSkip)) {
      // rw4.19: a house finished over a relief-1 bump (doorway 1 high,
      // bed foot blocked) re-opens so build digs the interior out.
      ctx.home.built = false
      console.log('home: natural ground inside the house, re-opening the build (rw4.19)')
      try { memory.save(bot, ctx) } catch (_) { /* memory best-effort */ }
    }
    // The chain owns ctx.retreat only across its own dispatches: any other
    // step taking the tick ends the episode, so the next veto re-chains
    // instead of holding a stale pick (live 1tj: an unfinished flee
    // survived into rest, then held and pillar was never asked).
    if (!ctx.paused && ctx.work) ctx.retreat = null
    return { decision, calledBrain }
  }

  // Order methods (setFollow/setBring/...) live in orders.js; the box shares
  // the closure lets they assign (followName) or read (brainEngine).
  const ordersBox = {
    bot, ctx, greet,
    get followName() { return followName },
    set followName(v) { followName = v },
    get brainEngine() { return brainEngine },
    set autonomousOverride(v) { autonomousOverride = v },
    clearStuck, resetNightStep, startWork, stopOnce, doSetBrain,
  }
  const orders = createOrders(ordersBox)

  return {
    tick,
    setPathStatus: (status) => { ctx.lastPathStatus = status || 'none' },
    // Head of the latest plan (b50): the executor works this list from
    // [0] down, so the wedge line can name the terrain it faces.
    setPathNext: (n) => { ctx.lastPathNext = n && typeof n.clone === 'function' ? n.clone() : (n && typeof n.x === 'number' ? { x: n.x, y: n.y, z: n.z } : null) },
    // Sprint lookahead window (5vv): the first nodes of the latest plan,
    // plain coords — follow reads numbers only. Cleared on a new goal.
    setPathNodes: (arr) => { ctx.lastPathNodes = Array.isArray(arr) ? arr.slice(0, 8).map((n) => (n && typeof n.x === 'number' ? { x: n.x, y: n.y, z: n.z } : null)).filter(Boolean) : null },
    setPathReset: (reason) => { stuck.countPathReset(ctx, reason) },
    // Fast door shut (idkcraft-6xno revmux 01 major-1): the physicsTick tap,
    // throttled inside doors.js — a walk-past outruns the 1 s tick closer.
    doorShutFast: () => { try { doors.doorShutFast(bot, ctx) } catch (_) { /* doors best-effort */ } },
    start: () => scheduleNext(true),
    // ponytail: sprint-jump wedges the bot flush against a 1-block step
    // (sprint speed reaches the face before the queued jump lifts off, so
    // physics resolves vel.y=0 with onGround=false and no later jump can
    // fire). Movements flags are the body's (body.js, the single write
    // site): installing adopts the lease defaults here, sprint only ever
    // opens on the flat-pursuit gates, and sprint on the decision line
    // stays the brain's opinion only.
    setMovements: (m) => { if (m) { doors.banDoorBreaks(m); doors.addDoorPassages(m); addSwimExits(m); addSwimPrune(m); addNoCornerCut(m); addSnowGround(m); addJumpUpCost(m) } ctx.movements = m; bot.pathfinder.setMovements(m); try { body.claimBody(bot, ctx, (ctx.body && ctx.body.owner) || 'idle') } catch (_) { /* lease best-effort */ } },
    destroy,
    rearm,
    ...orders,
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

// Names in a status-ping player sample (hide-online-players servers send
// none at all). One definition for the ghost check and the ambiguity check.
function pingSampleNames(res) {
  const p = res && res.players
  return Array.isArray(p && p.sample) ? p.sample.map((e) => e && e.name).filter(Boolean) : []
}

// online==1 with an empty sample is ambiguous: our just-quit ghost or one
// real player. Only a hidden-sample server (hide-online-players) produces
// it; a visible sample always names the one online.
function isAmbiguousPing(res) {
  const p = res && res.players
  return !!p && p.online === 1 && pingSampleNames(res).length === 0
}

// Off-server wait: ping the server until a real player is online. A refused
// or silent ping counts as nobody online. At most one line per minute, the
// same throttle style as local-idle. selfConnected (the confirmLeave ping,
// sent while we are on the server) decides the empty-sample case: the one
// online is us.
function playersOccupied(res, username, selfConnected = false) {
  const p = res && res.players
  if (!p || typeof p.online !== 'number' || p.online <= 0) return false
  if (p.online > 1) return true
  // online==1 with a visible sample: only our name means still empty — our
  // just-quit ghost off-server (the server has not processed our disconnect
  // yet while our local 'end' already fired), or ourselves on the
  // confirmLeave ping. Anyone else means occupied.
  const sample = pingSampleNames(res)
  if (sample.length > 0) return sample.some((name) => name !== username)
  // online==1 with no sample at all: a hidden-sample server
  // (hide-online-players empties it). While connected the one online is
  // us; off-server it is our ghost or one real player — joining is the
  // safe default there.
  return !selfConnected
}

async function waitForPlayers({ host, port, pingFn, pollMs = JOIN_POLL_MS, username = '' }) {
  let lastWaitLog = 0
  for (;;) {
    let occupied = false
    try {
      let res = await pingFn({ host, port, closeTimeout: 10000 })
      if (isAmbiguousPing(res)) {
        // Our just-quit ghost still counted, or one real player: one
        // settle + re-ping tells them apart. The ghost clears to 0; a
        // real player stays ambiguous, which reads occupied below.
        await sleep(pollMs)
        res = await pingFn({ host, port, closeTimeout: 10000 })
      }
      occupied = playersOccupied(res, username)
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
      try { occupied = playersOccupied(await pingFn({ host, port, closeTimeout: 10000 }), username, true) } catch (_) { occupied = false }
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
      // instead of standing through N more ticks. Not when autonomous on an
      // empty server (9ldm): spawn is where players show up, and with none
      // online the walk only throws away the work — start working here.
      const tickCtx = bot._tickerCtx
      try {
        const bp = bot.entity && bot.entity.position
        const sp = bot.spawnPoint
        const alone = tickCtx && tickCtx.autonomous && !Object.keys(bot.players || {}).some((n) => n !== bot.username)
        if (tickCtx && bp && sp && !alone && Math.hypot(bp.x - sp.x, bp.y - sp.y, bp.z - sp.z) > FAR_FROM_SPAWN && !findTarget(bot, followName)) {
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
      // A complete castle in memory is the home before adoptHome scans for
      // a hut door (g0z.29 migration of a castle an earlier image finished).
      if (tickCtx && ticker && typeof ticker.selectResidence === 'function') ticker.selectResidence()
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
    // Fast door shut (idkcraft-6xno revmux 01 major-1): throttled to 250 ms
    // inside doors.js. Same spot as the pathfinder taps: real bot only.
    bot.on('physicsTick', () => ticker.doorShutFast())
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
    if (!bed) bed = ctx && ctx.castle && ctx.castle.siteBed && ctx.castle.siteSpawnSet && ctx.castle.siteBed
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
  // 9kd: a water death (guardian/drowned) bans the swim, so the sheep
  // search rings never walk the same monument cell twice in a day. The
  // killer leg drops with it (revmux 01+02): target cleared AND its chunk
  // consumed — a bare clear re-picks the same target past the disc and the
  // stale GoalXZ re-paths the same swim.
  try {
    const ctx = bot && bot._tickerCtx
    if (dangerMod.markWaterDeath(bot, ctx)) exploreMod.dropDeadLeg(ctx)
  } catch (_) { /* memory best-effort */ }
  // ed88: night-step phase records belong to the dead body's position — a
  // gohome 'enter' resumed from world spawn stood 60 s, then cannot-reach.
  // Drop them so the step re-arms from the respawn (walk / hold / pillar);
  // a shelter climb episode goes with its record.
  try {
    const ctx = bot && bot._tickerCtx
    if (ctx) {
      stepMod.nextStepGen(ctx) // oqul.7: an op cut by the death drops its late completion
      ctx.gohome = null
      ctx.stay = null
      ctx.shelter = null
      ctx.gosite = null // R3: the return-walk watermark belongs to the dead body — a stale highY floors the respawn into a climb
      ctx.inShelter = false // the stay guard that cleared it no longer runs: fight must work on the walk back
      ctx.lastGoalKey = '' // a stale 'stay' would make the next holdStill skip clearing a dead walk goal
      if (ctx.recovery && ctx.recovery.action === 'pillar_up' && ctx.recovery.source === 'shelter') ctx.recovery = null
    }
  } catch (_) { /* reset best-effort */ }
}

function handleRespawn(bot, ticker) {
  if (ticker && typeof ticker.clearLead === 'function') ticker.clearLead()
  console.log(respawnLine(bot))
  // Post-respawn night grace (idkcraft-lph3): stamp the reappearance so
  // dispatch holds fight preemption while the night step digs in. Each
  // death re-stamps; the stamp goes stale on its own after the window.
  try {
    const ctx = bot && bot._tickerCtx
    if (ctx) { ctx.lastRespawnAt = Date.now(); ctx.shelterReleased = false } // vmzq.58: a death drops the release latch
  } catch (_) { /* stamp best-effort */ }
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
        if (ctx && ctx.castle) delete ctx.castle.siteSpawnSet // same: the site click no longer holds
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

module.exports = { createTicker, BEHAVIOURS, handleChat, advancePendingSearch, parseAutonomous, autonomousEffective, resolvePlayer, startupFollow, handleDeath, handleRespawn, handlePlayerLeft, deathLine, respawnLine, kitLine, createLifecycle, wakeBody, TARGET_GONE_TICKS, parseLeaveAfterMs, waitForPlayers, playersOccupied, runOnce, eatReflex, EDIBLE_FOODS, breathReflex, BREATH_OXYGEN_LOW, BREATH_OXYGEN_FULL }
