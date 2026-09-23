'use strict'

const mineflayer = require('mineflayer')
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder')
const { makeBrain } = require('./brain')
const { findTarget, resolvePlayer, buildState, stateKey, isFightTarget, findCreeper, snapHostiles } = require('./perception')
const { makeScout, findNearest } = require('./behaviours/scout')
const metrics = require('./metrics')

const fightMod = require('./behaviours/fight')
const goal = require('./goal')
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
  craft: require('./behaviours/craft'),
  rest: require('./behaviours/rest'),
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

function createTicker({ bot, brain, tickMs = 1000, idleTickMs = IDLE_TICK_MS, followName = '', leaveAfterMs = 0, onLeave = null, now = () => Date.now() }) {
  const ctx = { lastGoalKey: '', movements: null, paused: false, lead: null, leadStuck: 0, reflexTargetId: null, reflexSwung: false, stuckResets: 0, placeErrors: 0, eatInFlight: false, fleeTargetId: null, lastHostileSnap: null, work: false, step: '', stepStatus: null, goalText: null }
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
  // Tear-down for the join loop: after our own quit() the old ticker must
  // not tick on (it would log stale idle lines, retain the dead bot's
  // chunks, and a late socket error would fatal-kill the new connection).
  function destroy() {
    destroyed = true
    if (timer) { clearTimeout(timer); timer = null }
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
    if (key !== ctx.lastGoalKey) {
      bot.pathfinder.setGoal(new goals.GoalNear(sp.x, sp.y, sp.z, RETURN_HOME_RANGE), false)
      ctx.lastGoalKey = key
      console.log(`returning to spawn dist=${Math.round(Math.hypot(bp.x - sp.x, bp.y - sp.y, bp.z - sp.z))}`)
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
  function startWork() {
    ctx.work = true
    ctx.paused = false
    ctx.lead = null
    ctx.leadStuck = 0
    ctx.leadTargetGone = 0
    followName = ''
    ctx.lastGoalKey = ''
    ctx.gather = null
    ctx.resumeWork = false
  }

  function stopOnce() {
    if (ctx.lastGoalKey !== 'idle') {
      if (bot.pathfinder.isMoving()) bot.pathfinder.stop()
      else if (bot.pathfinder.goal) bot.pathfinder.setGoal(null)
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

  function applyDecision(decision, target, state) {
    const handler = BEHAVIOURS[decision.action]
    if (typeof handler === 'function') {
      handler(bot, ctx, target, state)
    } else {
      stopOnce()
    }
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
    if (r.decision) {
      endTimer({ brain_called: String(r.calledBrain) })
      metrics.decisions.inc({ source: r.decision.source, action: r.decision.action })
    }
    return r
  }

  async function runTick() {
    if (inFlight) { scheduleNext(lastVisible); return { decision: null, calledBrain: false } }
    inFlight = true
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
        else noteEmpty()
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
      else noteEmpty()
      // A follow order owns the body the moment its player is visible: drop
      // work so the goal arbiter below cannot hijack the tick.
      if (target && followName) ctx.work = false
      // Work mode runs without a visible player while anyone is on the
      // server (roster, not visibility — walking out of render distance is
      // normal). Falls through to the normal path with target=null:
      // buildState handles null, and the work check below swaps idle steps.
      const rosterOnline = bot.players &&
        Object.keys(bot.players).some((n) => n !== bot.username)
      // A pending follow order beats working alone: the player explicitly
      // asked the bot to come, so reunion outranks cave work (3a7 keeps work
      // for an unseen follower; this walks instead once N trips). Pure work
      // mode with nobody waiting keeps running.
      const followWaiting = !target && followName && bot.players && bot.players[resolvePlayer(bot, followName)]
      // A visible player with skipped work resumes it at once (one-shot):
      // sighting is the normal end of the homing walk, arrival the other.
      if (target && ctx.resumeWork && !followName) startWork()
      if (homeReached()) {
        // At spawn there is nothing to walk for — unless a follow order is
        // pending: then keep the latch (counter tripped, no work) and stand
        // until the player is visible, instead of oscillating work-vs-home.
        if (!followWaiting) {
          if (ctx.resumeWork && !followName) startWork()
          ctx.unseenTicks = 0
        }
      } else if (!target && rosterOnline && (!ctx.work || followWaiting)) {
        ctx.unseenTicks = (ctx.unseenTicks || 0) + 1
      } else ctx.unseenTicks = 0
      const homing = (ctx.unseenTicks || 0) >= UNSEEN_HOME_TICKS
      const workAlone = ctx.work && !target && rosterOnline && !homing
      if (workAlone) workTickFast = true
      if (!target && !workAlone) {
        // Cost fix: nobody online => no brain call at all, decide idle
        // locally, stop once, and stay quiet (at most one line per minute).
        // A hissing creeper still moves the body (fast ticks while fleeing).
        const fledAlone = fleeReflex(bot, ctx)
        if (fledAlone) {
          reflexFast = true
        } else if (!walkHomeTick()) {
          stopOnce()
        }
        // Melee reflex at spawn: the brain never runs here, but a hostile
        // standing on the bot still gets swung at every slow tick.
        try {
          const state = buildState(bot, null)
          if (meleeReflex(bot, ctx, state)) reflexFast = true
          eatReflex(bot, ctx, state)
        } catch (_) { /* facts best-effort */ }
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
      const key = stateKey(state)
      let decision
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
      // Work mode (epic rw4) owns the body like an order: the goal arbiter
      // picks the step, except fight which still preempts (safety beats work).
      // Placed after lead so an explicit find-me order wins its ticks.
      if (ctx.work && decision.action !== 'fight') {
        decision = goal.decide(bot, ctx)
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
    setMovements: (m) => { if (m) m.allowSprinting = false; ctx.movements = m; bot.pathfinder.setMovements(m) },
    destroy,
    rearm,
    setFollow: (name) => {
      const real = resolvePlayer(bot, name)
      followName = real
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
    stop: () => {
      ctx.paused = true
      ctx.work = false
      ctx.lead = null
      ctx.leadStuck = 0
      ctx.leadTargetGone = 0
      stopOnce()
    },
    setLead: (order) => { ctx.lead = order; ctx.leadStuck = 0; ctx.leadTargetGone = 0; ctx.paused = false },
    clearLead: (player) => {
      const targetName = followName || (ctx.lead && ctx.lead.by)
      if (player && targetName && player.username && player.username !== targetName) return
      if (ctx.lead && !player) bot.chat('following you again')
      ctx.lead = null
      ctx.leadStuck = 0
      ctx.leadTargetGone = 0
    },
    getLead: () => ctx.lead,
    status: () => {
      const facts = goal.goalFacts(bot, ctx)
      const mode = ctx.work ? 'working' : (ctx.paused ? 'parked' : (ctx.lead ? 'leading' : 'following'))
      bot.chat(`${mode} step=${ctx.step || 'none'} logs=${facts.logs} planks=${facts.planks} home=${facts.home}`)
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

// One connection: resolves after our own quit() (the join loop then goes
// back to polling). An unexpected end/kicked/error still exits — the
// container restart is the reconnect path there. createBot/pingFn are
// parameters so tests can drive the own-quit vs fatal branches.
function runOnce({ host, port, username, tickMs, brain, leaveAfterMs, followName, idleTickMs = IDLE_TICK_MS, createBot = (opts) => mineflayer.createBot(opts), pingFn = require('minecraft-protocol').ping }) {
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
      bot, brain, tickMs, idleTickMs, followName, leaveAfterMs,
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
      if ((!tickCtx || (tickCtx.unseenTicks || 0) < UNSEEN_HOME_TICKS) && !followName) ticker.work()
      ticker.start()
    })
    bot.on('spawn', () => { metrics.events.inc({ event: 'spawn' }); metrics.online.set(1); fightMod.equipGear(bot); console.log(kitLine(bot)) })

    bot.on('chat', (chatUsername, message) => handleChat(bot, ticker, chatUsername, message))

    // Pathfinder status taps: stored on the ticker ctx, logged per tick on the
    // decision line. Registered here in runOnce(), not in createTicker: the test
    // mockBot is a plain object, not an EventEmitter, so only the real
    // mineflayer bot ever reaches this code.
    bot.on('path_update', (r) => { if (r && r.status) ticker.setPathStatus(r.status) })
    bot.on('path_reset', (reason) => ticker.setPathReset(reason))

    const life = createLifecycle(ticker)
    bot.on('death', () => life.onDeath(bot))
    bot.on('respawn', () => life.onRespawn(bot))
    bot.on('playerLeft', (player) => handlePlayerLeft(bot, ticker, player))

    // Our own quit() resolves back into the join loop; anything else is fatal
    // and the container restart reconnects. Late errors on the intentionally
    // closed connection are ignored so they cannot kill the next one.
    bot.on('end', (reason) => {
      metrics.online.set(0)
      metrics.setVitals(null)
      if (wantQuit) { ticker.destroy(); resolve() }
      else fatal('end', reason || 'disconnected')
    })
    bot.on('error', (err) => { if (!wantQuit) fatal('error', err) })
    bot.on('kicked', (reason) => { if (!wantQuit) fatal('kicked', reason) })
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
  metrics.serve(parseInt(process.env.METRICS_PORT || '9464', 10))
  const pingFn = require('minecraft-protocol').ping
  for (;;) {
    // 0 disables the leave: join immediately and stay on, like before.
    if (leaveAfterMs !== 0) {
      await waitForPlayers({ host, port, pingFn, username })
      await sleep(JOIN_SETTLE_MS)
    }
    await runOnce({ host, port, username, tickMs, brain, leaveAfterMs, followName })
  }
}

// Targets declined as too deep, held per player for an explicit 'lead
// anyway'. Overwritten by the next deep decline, cleared on use.
const deepOffers = new Map()
// A target more than this far below the requesting player is announced, not
// led to: walking the player down to buried ore is how prod fell to death.
const DEEP_WARN_DROP = 8

function handleChat(bot, ticker, username, message) {
  if (username === bot.username) return
  const playerName = resolvePlayer(bot, username)
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
  } else if (msg === 'status') {
    if (ticker && typeof ticker.status === 'function') ticker.status()
  } else {
    const m = msg.match(/^find me\s+(\S+)$/)
    if (m) {
      const name = m[1]
      const speaker = bot.players && bot.players[playerName] && bot.players[playerName].entity
      const speakerY = speaker && typeof speaker.position?.y === 'number' ? speaker.position.y : null
      // No speaker entity (out of tracking range): judge depth from the
      // bot's own Y, the same fallback the ranking uses — never silently 0.
      const botY = bot.entity && typeof bot.entity.position?.y === 'number' ? bot.entity.position.y : null
      const refY = speakerY != null ? speakerY : botY
      const res = findNearest(bot, name, 48, refY)
      if (res === 'unknown') {
        bot.chat(`unknown block: ${name}`)
      } else if (!res) {
        bot.chat(`no ${name} within 48 blocks`)
      } else {
        const down = refY != null ? Math.round(refY - res.position.y) : 0
        if (down > DEEP_WARN_DROP) {
          bot.chat(`${res.name} is ${down} blocks down, dig carefully`)
          deepOffers.set(playerName, { name: res.name, pos: res.position, distance: res.distance })
        } else {
          bot.chat(`leading you to ${res.name}, ${res.distance} blocks, follow me`)
          if (ticker && typeof ticker.setLead === 'function') ticker.setLead({ name: res.name, pos: res.position, by: playerName, lastProgressAt: Date.now() })
        }
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

module.exports = { createTicker, BEHAVIOURS, handleChat, resolvePlayer, handleDeath, handleRespawn, handlePlayerLeft, deathLine, respawnLine, kitLine, createLifecycle, TARGET_GONE_TICKS, parseLeaveAfterMs, waitForPlayers, playersOccupied, runOnce, eatReflex, EDIBLE_FOODS }
