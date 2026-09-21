'use strict'

const mineflayer = require('mineflayer')
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder')
const { makeBrain } = require('./brain')

const HOSTILE_NAMES = new Set([
  'zombie', 'skeleton', 'spider', 'creeper', 'enderman', 'witch',
  'slime', 'husk', 'stray', 'drowned', 'pillager', 'phantom', 'blaze',
  'ghast', 'piglin_brute', 'hoglin', 'zoglin', 'cave_spider', 'silverfish',
  'endermite', 'vex', 'vindicator', 'evoker', 'ravager', 'warden', 'breeze',
  'bogged', 'creaking'
])

// Poll cadence when nobody is online: no JEV calls happen there, so waking
// up every 10 s just to re-scan the player list is plenty.
const IDLE_TICK_MS = 10000
const IDLE_LOG_MS = 60000

// Dedup key: distance rounded to 1 block + same flags => reuse last decision,
// skip the JEV call. Staleness is at most half a block of travel.
function stateKey(state) {
  const d = state.distance_to_player
  return [
    typeof d === 'number' ? Math.round(d) : 'none',
    !!state.player_visible, !!state.player_moving,
    state.bot_health, state.bot_food, state.nearby_hostiles
  ].join('|')
}

function createTicker({ bot, brain, tickMs = 1000, idleTickMs = IDLE_TICK_MS, followName = '' }) {
  let movements = null
  let inFlight = false
  let lastTargetPos = null
  let lastGoalKey = ''
  let lastVisible = true
  let lastIdleLog = 0
  let lastStateKey = null
  let lastDecision = null

  function findTarget() {
    if (followName) return (bot.players[followName] && bot.players[followName].entity) || null
    let best = null
    let bestDist = Infinity
    for (const player of Object.values(bot.players)) {
      if (!player.entity) continue
      if (player.username === bot.username) continue
      const d = bot.entity.position.distanceTo(player.entity.position)
      if (d < bestDist) {
        bestDist = d
        best = player.entity
      }
    }
    return best
  }

  function buildState(target) {
    let distanceToPlayer = null
    let playerMoving = false
    if (target) {
      distanceToPlayer = bot.entity.position.distanceTo(target.position)
      if (lastTargetPos) {
        playerMoving = target.position.distanceTo(lastTargetPos) > 0.1
      }
      lastTargetPos = target.position.clone()
    } else {
      lastTargetPos = null
    }
    let nearbyHostiles = 0
    for (const entity of Object.values(bot.entities)) {
      if (entity.type === 'player' || !entity.position) continue
      const name = entity.name || entity.mobType || ''
      if (!HOSTILE_NAMES.has(name)) continue
      if (entity.position.distanceTo(bot.entity.position) < 16) nearbyHostiles++
    }
    return {
      distance_to_player: distanceToPlayer,
      player_visible: !!target,
      player_moving: playerMoving,
      bot_health: typeof bot.health === 'number' ? bot.health : 20,
      bot_food: typeof bot.food === 'number' ? bot.food : 20,
      nearby_hostiles: nearbyHostiles
    }
  }

  function applyDecision(decision, target, state) {
    if (decision.action === 'follow' && target) {
      const key = `follow:${target.username || target.id}`
      // Re-issue while standing still: the first path can fail on an empty
      // (not yet loaded) world, and a dynamic goal only re-paths when the
      // target moves — so retry until the bot is actually moving.
      if (key !== lastGoalKey || !bot.pathfinder.isMoving()) {
        bot.pathfinder.setGoal(new goals.GoalFollow(target, 3), true)
        lastGoalKey = key
      }
    } else {
      if (lastGoalKey !== 'idle') bot.pathfinder.stop()
      lastGoalKey = 'idle'
    }
    if (movements) movements.allowSprinting = !!decision.sprint
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
      const target = findTarget()
      lastVisible = !!target
      if (!target) {
        // Cost fix: nobody online => no brain call at all, decide idle
        // locally, stop once, and stay quiet (at most one line per minute).
        if (lastGoalKey !== 'idle') {
          bot.pathfinder.stop()
          lastGoalKey = 'idle'
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
      const state = buildState(target)
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
    setMovements: (m) => { movements = m; bot.pathfinder.setMovements(m) },
    setFollow: (name) => { followName = name; lastGoalKey = '' },
    stop: () => {
      if (lastGoalKey !== 'idle') bot.pathfinder.stop()
      lastGoalKey = 'idle'
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

module.exports = { createTicker, stateKey }
