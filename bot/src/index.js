'use strict'

const mineflayer = require('mineflayer')
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder')
const { makeBrain } = require('./brain')

const MC_HOST = process.env.MC_HOST || 'mc'
const MC_PORT = parseInt(process.env.MC_PORT || '25565', 10)
const BOT_USERNAME = process.env.BOT_USERNAME || 'IdkBot'
let BOT_FOLLOW = process.env.BOT_FOLLOW || ''
const BRAIN_TICK_MS = parseInt(process.env.BRAIN_TICK_MS || '1000', 10)

const HOSTILE_NAMES = new Set([
  'zombie', 'skeleton', 'spider', 'creeper', 'enderman', 'witch',
  'slime', 'husk', 'stray', 'drowned', 'pillager', 'phantom', 'blaze',
  'ghast', 'piglin_brute', 'hoglin', 'zoglin', 'cave_spider', 'silverfish',
  'endermite', 'vex', 'vindicator', 'evoker', 'ravager', 'warden', 'breeze',
  'bogged', 'creaking'
])

const brain = makeBrain(process.env)

const bot = mineflayer.createBot({
  host: MC_HOST,
  port: MC_PORT,
  username: BOT_USERNAME,
  auth: 'offline' // offline-mode server; see README for the online-mode note
})
bot.loadPlugin(pathfinder)

bot.once('spawn', () => {
  bot.pathfinder.setMovements(new Movements(bot))
  console.log(`spawned as ${BOT_USERNAME} on ${MC_HOST}:${MC_PORT}`)
})

let inFlight = false
let lastTargetPos = null
let lastGoalKey = ''

function findTarget() {
  if (BOT_FOLLOW) return (bot.players[BOT_FOLLOW] && bot.players[BOT_FOLLOW].entity) || null
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
    if (entity.type !== 'mob' || !entity.position) continue
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

async function tick() {
  if (inFlight) return
  inFlight = true
  try {
    const target = findTarget()
    const state = buildState(target)
    const decision = await brain.decide(state)
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
    bot.setControlState('sprint', !!decision.sprint)
    const dist = typeof state.distance_to_player === 'number' ? state.distance_to_player.toFixed(1) : 'none'
    console.log(`decision source=${decision.source} action=${decision.action} sprint=${decision.sprint} dist=${dist}`)
  } catch (err) {
    console.error(`tick error: ${err && err.message ? err.message : err}`)
  } finally {
    inFlight = false
  }
}

bot.on('spawn', () => {
  setInterval(tick, BRAIN_TICK_MS)
})

bot.on('chat', (username, message) => {
  if (username === bot.username) return
  const msg = message.toLowerCase().trim()
  if (msg === 'follow me') {
    BOT_FOLLOW = username
    lastGoalKey = ''
    bot.chat(`Following ${username}`)
  } else if (msg === 'stop') {
    BOT_FOLLOW = ''
    lastGoalKey = ''
    bot.pathfinder.stop()
  }
})

function fatal(where, err) {
  console.error(`${where}: ${err && err.message ? err.message : err}`)
  process.exit(1)
}
bot.on('end', (reason) => fatal('end', reason || 'disconnected'))
bot.on('error', (err) => fatal('error', err))
bot.on('kicked', (reason) => fatal('kicked', reason))
