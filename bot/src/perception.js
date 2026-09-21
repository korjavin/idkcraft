'use strict'

const HOSTILE_NAMES = new Set([
  'zombie', 'skeleton', 'spider', 'creeper', 'enderman', 'witch',
  'slime', 'husk', 'stray', 'drowned', 'pillager', 'phantom', 'blaze',
  'ghast', 'piglin_brute', 'hoglin', 'zoglin', 'cave_spider', 'silverfish',
  'endermite', 'vex', 'vindicator', 'evoker', 'ravager', 'warden', 'breeze',
  'bogged', 'creaking'
])

// Fight-candidate ranges: same numbers the brain criteria state (3nt.2) —
// a hostile counts for fight when within 8 blocks of the bot OR 6 of the player.
const FIGHT_RANGE_BOT = 8
const FIGHT_RANGE_PLAYER = 6

// ponytail: creepers are excluded from fight targets, not fled from —
// hitting one near the player makes it explode next to the player, and
// fleeing is out of scope.

// Dedup key: distance rounded to 1 block + same flags => reuse last decision,
// skip the JEV call. Staleness is at most half a block of travel.
function stateKey(state) {
  const d = state.distance_to_player
  const hd = state.hostile_distance
  return [
    typeof d === 'number' ? Math.round(d) : 'none',
    !!state.player_visible, !!state.player_moving,
    state.bot_health, state.bot_food, state.nearby_hostiles,
    typeof hd === 'number' ? Math.round(hd) : 'none',
    !!state.hostile_near_player
  ].join('|')
}

function findTarget(bot, followName) {
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

function buildState(bot, target, lastTargetPos) {
  let distanceToPlayer = null
  let playerMoving = false
  let nextPos = null
  if (target) {
    distanceToPlayer = bot.entity.position.distanceTo(target.position)
    if (lastTargetPos) {
      playerMoving = target.position.distanceTo(lastTargetPos) > 0.1
    }
    nextPos = target.position.clone()
  }
  let nearbyHostiles = 0
  for (const entity of Object.values(bot.entities)) {
    if (entity.type === 'player' || !entity.position) continue
    const name = entity.name || entity.mobType || ''
    if (!HOSTILE_NAMES.has(name)) continue
    if (entity.position.distanceTo(bot.entity.position) < 16) nearbyHostiles++
  }
  let hostile = null
  let hostileDistance = null
  let hostilePlayerDistance = Infinity
  for (const entity of Object.values(bot.entities)) {
    if (entity.type === 'player' || !entity.position) continue
    const name = entity.name || entity.mobType || ''
    if (!HOSTILE_NAMES.has(name) || name === 'creeper') continue
    const dBot = entity.position.distanceTo(bot.entity.position)
    const dPlayer = target ? entity.position.distanceTo(target.position) : Infinity
    if (dBot > FIGHT_RANGE_BOT && dPlayer > FIGHT_RANGE_PLAYER) continue
    if (hostileDistance === null || dBot < hostileDistance) {
      hostile = entity
      hostileDistance = dBot
      hostilePlayerDistance = dPlayer
    }
  }
  const state = {
    distance_to_player: distanceToPlayer,
    player_visible: !!target,
    player_moving: playerMoving,
    bot_health: typeof bot.health === 'number' ? bot.health : 20,
    bot_food: typeof bot.food === 'number' ? bot.food : 20,
    nearby_hostiles: nearbyHostiles,
    hostile_distance: hostileDistance,
    hostile_near_player: hostile ? hostilePlayerDistance <= FIGHT_RANGE_PLAYER : false,
    hostile
  }
  state._lastTargetPos = nextPos
  return state
}

module.exports = { findTarget, buildState, stateKey, HOSTILE_NAMES }
