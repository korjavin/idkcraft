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

// ponytail: creepers are excluded from fight targets — hitting one near the
// player makes it explode next to the player. Fleeing is a tick-level reflex
// instead (fleeReflex in index.js), never a brain action or an attack.
function isFightTarget(entity, botPos, playerPos) {
  if (!entity || entity.type === 'player' || !entity.position) return false
  const name = entity.name || ''
  if (!HOSTILE_NAMES.has(name) || name === 'creeper') return false
  if (entity.position.distanceTo(botPos) <= FIGHT_RANGE_BOT) return true
  return !!playerPos && entity.position.distanceTo(playerPos) <= FIGHT_RANGE_PLAYER
}

// Nearest live creeper within maxDist blocks of the bot (or null). Creepers
// are not fight targets (isFightTarget) so they need their own fact for the
// flee reflex in index.js.
function findCreeper(bot, maxDist) {
  const bp = bot && bot.entity && bot.entity.position
  if (!bp) return null
  let best = null
  let bestDist = Infinity
  for (const entity of Object.values(bot.entities || {})) {
    if (!entity || entity.type === 'player' || !entity.position) continue
    if ((entity.name || '') !== 'creeper') continue
    if (entity.isValid === false) continue
    let d
    try { d = entity.position.distanceTo(bp) } catch (_) { continue }
    if (typeof d !== 'number' || d > maxDist) continue
    if (d < bestDist) { bestDist = d; best = entity }
  }
  return best
}

// Snapshot of all hostiles (fight targets AND creepers): the death line's
// truth source — at the death tick the killer is often already gone
// (exploded creeper), so the ticker snapshots this every tick. Same <16 rule
// as nearby_hostiles.
function snapHostiles(bot) {
  const bp = bot && bot.entity && bot.entity.position
  if (!bp) return { count: 0, name: null, dist: null }
  let count = 0
  let name = null
  let dist = null
  for (const entity of Object.values(bot.entities || {})) {
    if (!entity || entity.type === 'player' || !entity.position) continue
    if (!HOSTILE_NAMES.has(entity.name || '')) continue
    let d
    try { d = entity.position.distanceTo(bp) } catch (_) { continue }
    if (typeof d !== 'number' || d >= 16) continue
    count++
    if (dist === null || d < dist) { dist = d; name = entity.name || 'mob' }
  }
  return { count, name, dist }
}

// Inventory counter for goal facts: sums item counts whose name matches pred
// (e.g. n => n.endsWith('_log')). Best-effort 0 when the inventory is not ready.
function countItems(bot, pred) {
  let n = 0
  try {
    const items = bot && bot.inventory && typeof bot.inventory.items === 'function' ? bot.inventory.items() : []
    if (Array.isArray(items)) {
      for (const i of items) {
        if (!i || typeof i.name !== 'string') continue
        if (pred(i.name)) n += typeof i.count === 'number' ? i.count : 1
      }
    }
  } catch (_) { /* inventory not ready: count 0 */ }
  return n
}

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
    !!state.hostile_near_player,
    state.hostile_reachable === false ? 'false' : 'true'
  ].join('|')
}

// Floodgate (Geyser) prefixes Bedrock names with '.' in bot.players
// ('.Steve') while the 'chat' event carries the name without it ('Steve'),
// so a direct lookup misses. Resolve exact, then '.'+name, then a
// case-insensitive match ignoring the leading dot.
function resolvePlayer(bot, name, uuid) {
  const players = (bot && bot.players) || {}
  // UUID first (idkcraft-8gf): Java 'X' and Bedrock '.X' online together are
  // indistinguishable by chat name, so the sender UUID from the message
  // event wins when it matches a roster entry. Dashes/case-insensitive.
  if (uuid) {
    const unorm = String(uuid).toLowerCase().replace(/-/g, '')
    for (const key of Object.keys(players)) {
      const pu = players[key] && players[key].uuid
      if (pu && String(pu).toLowerCase().replace(/-/g, '') === unorm) return key
    }
  }
  if (!name) return name
  if (players[name]) return name
  if (players['.' + name]) return '.' + name
  const norm = String(name).replace(/^\./, '').toLowerCase()
  for (const key of Object.keys(players)) {
    if (String(key).replace(/^\./, '').toLowerCase() === norm) return key
  }
  return name
}

function findTarget(bot, followName) {
  if (followName) {
    const real = resolvePlayer(bot, followName)
    const p = bot.players && bot.players[real]
    return (p && p.entity) || null
  }
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

// fightGivenUpId is fight's give-up latch (entity id, or null): when it names
// the current hostile, the mob beat pursuit (cave, glass, ravine) and the
// brain must yield fight -> follow. Missing/older callers pass nothing and
// every hostile reads reachable.
function buildState(bot, target, lastTargetPos, fightGivenUpId = null) {
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
    const name = entity.name || ''
    if (!HOSTILE_NAMES.has(name)) continue
    if (entity.position.distanceTo(bot.entity.position) < 16) nearbyHostiles++
  }
  let hostile = null
  let hostileDistance = null
  let hostilePlayerDistance = Infinity
  for (const entity of Object.values(bot.entities)) {
    if (!isFightTarget(entity, bot.entity.position, target && target.position)) continue
    const dBot = entity.position.distanceTo(bot.entity.position)
    const dPlayer = target ? entity.position.distanceTo(target.position) : Infinity
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
    hostile_reachable: !(hostile && fightGivenUpId != null && hostile.id === fightGivenUpId),
    hostile
  }
  state._lastTargetPos = nextPos
  return state
}

module.exports = { findTarget, resolvePlayer, buildState, stateKey, HOSTILE_NAMES, isFightTarget, findCreeper, snapHostiles, countItems }
