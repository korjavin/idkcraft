'use strict'

const mineflayer = require('mineflayer')
const { pathfinder, Movements } = require('mineflayer-pathfinder')
const { makeBrain } = require('./brain')
const { findTarget, buildState, stateKey, isFightTarget } = require('./perception')
const { makeScout, findNearest } = require('./behaviours/scout')

const BEHAVIOURS = {
  fight: require('./behaviours/fight'),
  follow: require('./behaviours/follow'),
  roam: require('./behaviours/roam'),
  lead: require('./behaviours/lead'),
}

// Poll cadence when nobody is online: no JEV calls happen there, so waking
// up every 10 s just to re-scan the player list is plenty.
const IDLE_TICK_MS = 10000
const IDLE_LOG_MS = 60000
// Re-probe ceiling (ticks) for a given-up hostile: the world may change
// (bridged ravine, opened door), so a pursuit fight abandoned is retried
// from scratch this often. Lives here, not in fight.js — once the brain
// answers follow for an unreachable mob, fight stops being dispatched and
// its own counter would never advance.
const FIGHT_REPROBE_TICKS = 30

function createTicker({ bot, brain, tickMs = 1000, idleTickMs = IDLE_TICK_MS, followName = '' }) {
  const ctx = { lastGoalKey: '', movements: null, paused: false, lead: null, leadStuck: 0 }
  let inFlight = false
  let lastTargetPos = null
  let lastVisible = true
  let lastIdleLog = 0
  let lastStateKey = null
  let lastDecision = null

  // mineflayer-pathfinder's stop() only sets a stopPathing flag that the
  // next setGoal consumes with the new goal — on an empty path with no goal
  // it latches and swallows the next goal, so skip it there. A live but
  // stationary goal (dynamic follow resting in range) still needs cancelling;
  // setGoal(null) clears it without latching. lastGoalKey still flips to
  // 'idle' for stop-once.
  function stopOnce() {
    if (ctx.lastGoalKey !== 'idle') {
      if (bot.pathfinder.isMoving()) bot.pathfinder.stop()
      else if (bot.pathfinder.goal) bot.pathfinder.setGoal(null)
      ctx.lastGoalKey = 'idle'
    }
  }

  function applyDecision(decision, target, state) {
    const handler = BEHAVIOURS[decision.action]
    if (typeof handler === 'function') {
      handler(bot, ctx, target, state)
    } else {
      stopOnce()
    }
    if (ctx.movements) ctx.movements.allowSprinting = !!decision.sprint
    const dist = typeof state.distance_to_player === 'number' ? state.distance_to_player.toFixed(1) : 'none'
    console.log(`decision source=${decision.source} action=${decision.action} sprint=${decision.sprint} dist=${dist}`)
  }

  function scheduleNext(fast) {
    const t = setTimeout(() => { void tick() }, fast ? tickMs : idleTickMs)
    if (t && typeof t.unref === 'function') t.unref()
  }

  async function tick() {
    if (inFlight) { scheduleNext(lastVisible); return { decision: null, calledBrain: false } }
    inFlight = true
    let calledBrain = false
    try {
      if (ctx.paused) {
        // 'stop' parks the bot: perception + scout keep running while a
        // player is visible, but the brain is skipped and idle is dispatched
        // (stop once) — same cost guard as 'no player online', including no
        // scans with nobody online.
        const target = findTarget(bot, followName)
        lastVisible = !!target
        if (target) {
          const state = buildState(bot, target, lastTargetPos)
          lastTargetPos = state._lastTargetPos
          if (!ctx.scout && bot.registry) ctx.scout = makeScout(bot)
          if (ctx.scout) ctx.scout.tick()
        } else {
          lastTargetPos = null
          lastDecision = null
          lastStateKey = null
        }
        stopOnce()
        const now = Date.now()
        if (now - lastIdleLog >= IDLE_LOG_MS) {
          lastIdleLog = now
          console.log('decision source=local-idle action=idle sprint=false dist=none')
        }
        return { decision: { action: 'idle', sprint: false, source: 'local-idle' }, calledBrain: false }
      }
      const target = findTarget(bot, followName)
      lastVisible = !!target
      if (!target) {
        // Cost fix: nobody online => no brain call at all, decide idle
        // locally, stop once, and stay quiet (at most one line per minute).
        stopOnce()
        lastTargetPos = null
        lastDecision = null
        lastStateKey = null
        const now = Date.now()
        if (now - lastIdleLog >= IDLE_LOG_MS) {
          lastIdleLog = now
          console.log('decision source=local-idle action=idle sprint=false dist=none')
        }
        return { decision: { action: 'idle', sprint: false, source: 'local-idle' }, calledBrain: false }
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
          console.log('decision source=local-idle action=idle sprint=false dist=none')
        }
        return { decision: { action: 'idle', sprint: false, source: 'local-idle' }, calledBrain }
      }
      if (ctx.lead && decision.action !== 'fight') {
        // Lead is an explicit player order: it overrides the brain like
        // 'stop' does, but fight still preempts (safety beats errands).
        const handler = BEHAVIOURS.lead
        if (typeof handler === 'function') handler(bot, ctx, target, state)
        if (ctx.movements) ctx.movements.allowSprinting = !!decision.sprint
        const leadDist = typeof state.distance_to_player === 'number' ? state.distance_to_player.toFixed(1) : 'none'
        console.log(`decision source=${decision.source} action=lead sprint=${decision.sprint} dist=${leadDist}`)
        return { decision: { ...decision, action: 'lead' }, calledBrain }
      }
      applyDecision(decision, target, state)
      return { decision, calledBrain }
    } catch (err) {
      console.error(`tick error: ${err && err.message ? err.message : err}`)
      return { decision: null, calledBrain }
    } finally {
      inFlight = false
      scheduleNext(lastVisible)
    }
  }

  return {
    tick,
    start: () => scheduleNext(true),
    setMovements: (m) => { ctx.movements = m; bot.pathfinder.setMovements(m) },
    setFollow: (name) => { followName = name; ctx.lastGoalKey = ''; ctx.lead = null; ctx.leadStuck = 0; if (name) ctx.paused = false },
    stop: () => {
      ctx.paused = true
      ctx.lead = null
      ctx.leadStuck = 0
      stopOnce()
    },
    setLead: (order) => { ctx.lead = order; ctx.leadStuck = 0 }
  }
}

function main() {
  const rawTick = parseInt(process.env.BRAIN_TICK_MS || '1000', 10)
  const tickMs = Number.isFinite(rawTick) ? rawTick : 1000
  const brain = makeBrain(process.env)
  const bot = mineflayer.createBot({
    host: process.env.MC_HOST || 'mc',
    port: parseInt(process.env.MC_PORT || '25565', 10),
    username: process.env.BOT_USERNAME || 'IdkBot',
    auth: 'offline' // offline-mode server; see README for the online-mode note
  })
  bot.loadPlugin(pathfinder)
  const ticker = createTicker({ bot, brain, tickMs, followName: process.env.BOT_FOLLOW || '' })

  bot.once('spawn', () => {
    ticker.setMovements(new Movements(bot))
    console.log(`spawned as ${bot.username}`)
    ticker.start()
  })

  bot.on('chat', (username, message) => handleChat(bot, ticker, username, message))

  function fatal(where, err) {
    console.error(`${where}: ${err && err.message ? err.message : err}`)
    process.exit(1)
  }
  bot.on('end', (reason) => fatal('end', reason || 'disconnected'))
  bot.on('error', (err) => fatal('error', err))
  bot.on('kicked', (reason) => fatal('kicked', reason))
}

function handleChat(bot, ticker, username, message) {
  if (username === bot.username) return
  const msg = message.toLowerCase().trim()
  if (msg === 'follow me') {
    if (ticker) ticker.setFollow(username)
    bot.chat(`Following ${username}`)
  } else if (msg === 'stop') {
    if (ticker) {
      ticker.setFollow('')
      ticker.stop()
    }
  } else {
    const m = msg.match(/^find me\s+(\S+)$/)
    if (m) {
      const name = m[1]
      const res = findNearest(bot, name)
      if (res === 'unknown') {
        bot.chat(`unknown block: ${name}`)
      } else if (!res) {
        bot.chat(`no ${name} within 48 blocks`)
      } else {
        bot.chat(`${res.name} at ${res.position.x} ${res.position.y} ${res.position.z} (${res.distance} blocks)`)
        if (ticker && typeof ticker.setLead === 'function') ticker.setLead({ name: res.name, pos: res.position })
      }
    }
  }
}

if (require.main === module) main()

module.exports = { createTicker, BEHAVIOURS, handleChat }
