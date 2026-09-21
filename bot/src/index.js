'use strict'

const mineflayer = require('mineflayer')
const { pathfinder, Movements } = require('mineflayer-pathfinder')
const { makeBrain } = require('./brain')
const { findTarget, buildState, stateKey } = require('./perception')
const { makeScout } = require('./behaviours/scout')

const BEHAVIOURS = {
  fight: require('./behaviours/fight'),
  follow: require('./behaviours/follow'),
}

// Poll cadence when nobody is online: no JEV calls happen there, so waking
// up every 10 s just to re-scan the player list is plenty.
const IDLE_TICK_MS = 10000
const IDLE_LOG_MS = 60000

function createTicker({ bot, brain, tickMs = 1000, idleTickMs = IDLE_TICK_MS, followName = '' }) {
  const ctx = { lastGoalKey: '', movements: null }
  let inFlight = false
  let lastTargetPos = null
  let lastVisible = true
  let lastIdleLog = 0
  let lastStateKey = null
  let lastDecision = null

  function applyDecision(decision, target, state) {
    const handler = BEHAVIOURS[decision.action]
    if (typeof handler === 'function') {
      handler(bot, ctx, target, state)
    } else {
      if (ctx.lastGoalKey !== 'idle') bot.pathfinder.stop()
      ctx.lastGoalKey = 'idle'
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
      const target = findTarget(bot, followName)
      lastVisible = !!target
      if (!target) {
        // Cost fix: nobody online => no brain call at all, decide idle
        // locally, stop once, and stay quiet (at most one line per minute).
        if (ctx.lastGoalKey !== 'idle') {
          bot.pathfinder.stop()
          ctx.lastGoalKey = 'idle'
        }
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
      const state = buildState(bot, target, lastTargetPos)
      lastTargetPos = state._lastTargetPos
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
    setFollow: (name) => { followName = name; ctx.lastGoalKey = '' },
    stop: () => {
      if (ctx.lastGoalKey !== 'idle') bot.pathfinder.stop()
      ctx.lastGoalKey = 'idle'
    }
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

  bot.on('chat', (username, message) => {
    if (username === bot.username) return
    const msg = message.toLowerCase().trim()
    if (msg === 'follow me') {
      ticker.setFollow(username)
      bot.chat(`Following ${username}`)
    } else if (msg === 'stop') {
      ticker.setFollow('')
      ticker.stop()
    }
  })

  function fatal(where, err) {
    console.error(`${where}: ${err && err.message ? err.message : err}`)
    process.exit(1)
  }
  bot.on('end', (reason) => fatal('end', reason || 'disconnected'))
  bot.on('error', (err) => fatal('error', err))
  bot.on('kicked', (reason) => fatal('kicked', reason))
}

if (require.main === module) main()

module.exports = { createTicker, BEHAVIOURS }
