// idkcraft-neuc.10: lifecycle + event parity for the Baritone body.
//
// The mod (baritone/bridge/mod Lifecycle.java) pushes death/respawn/
// spawnReset/health/entityHurt/playerCollect/rain/time/kicked/end
// notifications; this module folds them into the exact mineflayer emit
// shapes bot/src/index.js wires (death/respawn no args, health after the
// bot.health/food update, entityHurt (entity), playerCollect (collector,
// collected), kicked (reason, loggedIn), end (reason)). entityGone /
// entitySpawn / playerJoined / playerLeft stay in entities.js (neuc.3).
// physicsTick/move/forcedMove are synthesised in index.js at poll cadence.
//
// This file requires nothing outside bot/src/bridge/ (epic section 2).
'use strict'

function entityById(bot, id) {
  if (typeof id !== 'number') return null
  const e = bot.entities && bot.entities[String(id)]
  if (e) return e
  if (bot.entity && bot.entity.id === id) return bot.entity
  return null
}

function installLifecycle(bot) {
  bot.isAlive = true
  if (typeof bot.foodSaturation !== 'number') bot.foodSaturation = 0
  // mineflayer bot.respawn(): ask the client to send the respawn request
  // now (the mod also auto-respawns on the death edge by default).
  bot.respawn = async () => { await bot.transport.call('respawn.now', {}) }
  // Toggle the mod's auto-respawn (mineflayer's respawn option twin).
  bot.setAutoRespawn = (auto) => bot.transport.call('respawn.set', { auto: !!auto })
}

// Returns true when the notification was consumed.
function handleLifecycleEvent(bot, method, params) {
  const p = params || {}
  switch (method) {
    case 'death':
      if (bot.isAlive === false) return true // mineflayer guards on isAlive
      bot.isAlive = false
      bot.health = 0
      bot.emit('death')
      return true
    case 'respawn':
      bot.isAlive = true
      bot.emit('respawn')
      return true
    case 'spawnReset':
      bot.emit('spawnReset')
      return true
    case 'health':
      if (typeof p.health === 'number') bot.health = p.health
      if (typeof p.food === 'number') bot.food = p.food
      if (typeof p.saturation === 'number') bot.foodSaturation = p.saturation
      bot.emit('health')
      return true
    case 'entityHurt':
      bot.emit('entityHurt', entityById(bot, p.id))
      return true
    case 'playerCollect':
      bot.emit('playerCollect', entityById(bot, p.collectorId), entityById(bot, p.itemId))
      return true
    case 'rain':
      if (typeof p.raining === 'boolean') bot.isRaining = p.raining
      bot.emit('rain')
      return true
    case 'time': {
      if (typeof p.age === 'number') {
        bot.time.age = p.age
        if (Number.isInteger(p.age)) bot.time.bigAge = BigInt(p.age)
      }
      if (typeof p.timeOfDay === 'number') bot.time.timeOfDay = p.timeOfDay
      if (typeof bot.time.timeOfDay === 'number' && typeof bot.time.day === 'number') {
        bot.time.time = bot.time.day * 24000 + bot.time.timeOfDay
        bot.time.bigTime = BigInt(bot.time.time)
      }
      bot.emit('time')
      return true
    }
    case 'kicked':
      bot.emit('kicked', typeof p.reason === 'string' ? p.reason : String(p.reason ?? ''), p.loggedIn !== false)
      return true
    case 'end':
      // The transport-close path in createBot also emits 'end'; the
      // _lifecycleEnded latch (cleared by the next in-world poll in
      // index.js) keeps one disconnect to one 'end'. Our own quit()
      // emits its own 'end' and must not be doubled here.
      if (bot._quitting || bot._lifecycleEnded) return true
      bot._lifecycleEnded = true
      bot.emit('end', typeof p.reason === 'string' && p.reason ? p.reason : 'disconnected')
      return true
    default:
      return false
  }
}

module.exports = { installLifecycle, handleLifecycleEvent, entityById }
