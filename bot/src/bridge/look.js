// idkcraft-neuc.9: look/attack/interact/sleep for the Baritone body.
//
// mineflayer signatures over the bridge wire (baritone/bridge/PROTOCOL.md,
// look section): look.set / look.at / attack / interact.block /
// interact.item / interact.stop / sleep / wake, plus the mod's sleep/wake
// notifications folded by handleLookEvent.
//
// Baritone owns the crosshair while pathing, so every interaction pauses
// it first and resumes after (withBaritonePaused — the ONE pause/resume
// helper, exported for neuc.7's dig/place). #pause/#resume are Baritone
// control commands: they leave the tracked goal armed and freeze its
// 120 s watchdog (GoalTracker), so the goal survives; after resume we
// re-check the goal status and re-issue the latched goal only when
// Baritone dropped it without a terminal verdict.
//
// This file requires nothing outside bot/src/bridge/ (epic section 2).
'use strict'

const { setBaritonePaused } = require('./input') // neuc.13's shared pause helper

const DEG = Math.PI / 180
// Open-state read for a fence gate (g0z.46): fail-closed reads as shut,
// so an unreadable gate keeps the mid-walk open no-op.
function gateOpen(block) {
  try {
    const p = typeof block.getProperties === 'function' ? block.getProperties() : null
    return !!p && p.open === true
  } catch (_) { return false }
}
function underFeet(bot, p) {
  const e = bot.entity && bot.entity.position
  return !!e && Math.floor(e.x) === Math.floor(p.x) && Math.floor(e.y) === Math.floor(p.y) && Math.floor(e.z) === Math.floor(p.z)
}
const EYE_HEIGHT = 1.62 // mineflayer player eye height; adapter entity has no eyeHeight field yet
// mineflayer inventory.js ALWAYS_CONSUMABLES: edible even at full food.
const ALWAYS_CONSUMABLES = ['potion', 'milk_bucket', 'enchanted_golden_apple', 'golden_apple']

function sleepMs(ms) { return new Promise((r) => setTimeout(r, ms)) }
function failLog(what, e) { console.log(`bridge ${what} failed: ${(e && e.message) || e}`) }

// Wrapped yaw difference in (-pi, pi].
function yawDiff(a, b) {
  let d = (a - b) % (Math.PI * 2)
  if (d > Math.PI) d -= Math.PI * 2
  if (d < -Math.PI) d += Math.PI * 2
  return d
}

// mineflayer lookAt math (physics.js): yaw/pitch that aim the eye at point.
function yawPitchFor(eye, point) {
  const dx = point.x - eye.x
  const dy = point.y - eye.y
  const dz = point.z - eye.z
  return {
    yaw: Math.atan2(-dx, -dz),
    pitch: Math.atan2(dy, Math.hypot(dx, dz)),
  }
}

function eyeOf(bot) {
  const p = bot.entity.position
  const h = typeof bot.entity.eyeHeight === 'number' ? bot.entity.eyeHeight : EYE_HEIGHT
  return { x: p.x, y: p.y + h, z: p.z }
}

// The shared Baritone pause/resume helper (neuc.7 reuses this for
// dig/place): pause only when pathing, always resume, and re-issue the
// latched goal when Baritone cancelled it silently during the pause
// (status for the latched id, not pathing, no terminal verdict yet).
// Reference-counted (bot._pausedDepth): overlapping interactions share
// one #pause/#resume pair, and the adapter poll skips terminal
// attribution while a pause is outstanding (a paused body reads
// pathing:false, which must not verdict the live goal).
async function withBaritonePaused(bot, fn) {
  const moving = !!(bot.pathfinder && typeof bot.pathfinder.isMoving === 'function' && bot.pathfinder.isMoving())
  if (!moving || !bot.transport) return fn()
  bot._pausedDepth = (bot._pausedDepth || 0) + 1
  if (bot._pausedDepth === 1) {
    if (!await setBaritonePaused(bot, true)) failLog('#pause', new Error('not accepted'))
  }
  try {
    return await fn()
  } finally {
    bot._pausedDepth--
    if (bot._pausedDepth <= 0) {
      bot._pausedDepth = 0
      // A lost #resume leaves Baritone paused with its watchdog frozen:
      // retry once before giving up to the log.
      if (!await setBaritonePaused(bot, false) && !await setBaritonePaused(bot, false)) {
        failLog('#resume', new Error('not accepted'))
      }
      // One tick before trusting status: Baritone's pausedThisTick (and
      // the mod's snapshot) clear only on the next game tick, so an
      // immediate read can still show a resumed goal as idle.
      await sleepMs(60)
      try {
        const st = await bot.transport.call('baritone.status', {})
        if (st && bot._goalId != null && st.id === bot._goalId && !st.pathing &&
          (st.last === 'none' || st.last == null) &&
          bot.pathfinder.goal && typeof bot._setGoal === 'function') {
          bot._setGoal(bot.pathfinder.goal, !!bot._follow) // goal dropped mid-pause: re-issue the latch
        }
      } catch (_) { /* status best-effort; the poll resolves the goal */ }
    }
  }
}

const FACE_BY_VECTOR = [
  ['down', 0, -1, 0], ['up', 0, 1, 0], ['north', 0, 0, -1],
  ['south', 0, 0, 1], ['west', -1, 0, 0], ['east', 1, 0, 0],
]
function faceName(direction) {
  if (!direction) return 'up'
  for (const [name, x, y, z] of FACE_BY_VECTOR) {
    if (direction.x === x && direction.y === y && direction.z === z) return name
  }
  return 'up'
}

function installLook(bot) {
  bot.usingHeldItem = false

  // mineflayer look: resolves when the rotation is sent. Cheap-tick rule:
  // reflexes call look every tick, so a sub-degree change never crosses
  // the wire (the local entity still tracks it, like mineflayer).
  bot.look = async (yaw, pitch, force) => {
    if (typeof yaw !== 'number' || typeof pitch !== 'number') throw new Error('look: yaw/pitch must be numbers')
    const near = Math.abs(yawDiff(yaw, bot.entity.yaw || 0)) < DEG && Math.abs(pitch - (bot.entity.pitch || 0)) < DEG
    if (near && !force) {
      bot.entity.yaw = yaw
      bot.entity.pitch = pitch
      return
    }
    await withBaritonePaused(bot, () => bot.transport.call('look.set', { yaw, pitch, force: !!force }))
    bot.entity.yaw = yaw
    bot.entity.pitch = pitch
  }

  bot.lookAt = async (point, force) => {
    if (!point || typeof point.x !== 'number') throw new Error('lookAt: want a point')
    const { yaw, pitch } = yawPitchFor(eyeOf(bot), point)
    await withBaritonePaused(bot, () => bot.transport.call('look.at', { x: point.x, y: point.y, z: point.z }))
    bot.entity.yaw = yaw
    bot.entity.pitch = pitch
  }

  // mineflayer attack is fire-and-forget (fight.js never awaits it).
  bot.attack = (entity, _swing = true) => {
    if (!entity || typeof entity.id !== 'number') return
    void withBaritonePaused(bot, () => bot.transport.call('attack', { entityId: entity.id }))
      .catch((e) => failLog('attack', e))
  }

  // mineflayer activateBlock: look at the block centre, then use the held
  // item on it. Doors are the exception while pathing: Baritone opens
  // doors itself, so a reflex toggle mid-walk would double-toggle the
  // panel shut again (neuc.9 landmine) — a no-op here, adapter-side only.
  // Fence gates (g0z.46): only the OPEN click no-ops mid-walk (Baritone's
  // job); shutting an open gate the body walked through goes ahead —
  // Baritone never shuts one, and an open ring gate lets mobs in. A shut
  // gate under the feet is a Baritone stall (doors.openGateUnderFeet): it
  // never clicks a gate in the cell it stands in, so that open goes ahead.
  // Same for a shut door under the feet (idkcraft-da2f, doors.openGateUnderFeet).
  bot.activateBlock = async (block, direction, cursorPos) => {
    if (!block || !block.position) throw new Error('activateBlock: want a block with a position')
    const moving = bot.pathfinder && typeof bot.pathfinder.isMoving === 'function' && bot.pathfinder.isMoving()
    if (moving && typeof block.name === 'string' && block.name.endsWith('_door') && (gateOpen(block) || !underFeet(bot, block.position))) return
    if (moving && typeof block.name === 'string' && block.name.endsWith('_fence_gate') && !gateOpen(block) && !underFeet(bot, block.position)) return
    const p = block.position
    const bx = Math.floor(p.x)
    const by = Math.floor(p.y)
    const bz = Math.floor(p.z)
    await bot.lookAt(new bot.Vec3(bx + 0.5, by + 0.5, bz + 0.5))
    const cursor = cursorPos && typeof cursorPos.x === 'number'
      ? { x: cursorPos.x, y: cursorPos.y, z: cursorPos.z } : { x: 0.5, y: 0.5, z: 0.5 }
    await withBaritonePaused(bot, () => bot.transport.call('interact.block', {
      x: bx, y: by, z: bz, face: faceName(direction), cursor, sneak: false,
    }))
  }

  // mineflayer activateItem/deactivateItem are synchronous use start/stop.
  bot.activateItem = (offHand = false) => {
    bot.usingHeldItem = true
    void withBaritonePaused(bot, () => bot.transport.call('interact.item', { hand: offHand ? 'off' : 'main' }))
      .catch((e) => { bot.usingHeldItem = false; failLog('interact.item', e) })
  }

  bot.deactivateItem = () => {
    bot.usingHeldItem = false
    if (bot.transport) bot.transport.call('interact.stop', {}).catch((e) => failLog('interact.stop', e))
  }

  // mineflayer consume: start using the held item and hold until it is
  // consumed (held count drops / item changes) or 2 s pass. Rejects with
  // mineflayer's own messages where mineflayer has one ('Food is full').
  bot.consume = async () => {
    const held = bot.heldItem
    if (!held) throw new Error('not holding any item')
    if (bot.game && bot.game.gameMode !== 'creative' && !ALWAYS_CONSUMABLES.includes(held.name) && bot.food === 20) {
      throw new Error('Food is full')
    }
    const beforeName = held.name
    const beforeCount = typeof held.count === 'number' ? held.count : null
    await withBaritonePaused(bot, async () => {
      await bot.transport.call('interact.item', { hand: 'main' })
      bot.usingHeldItem = true
      let dropped = false
      try {
        const deadline = Date.now() + 2000
        while (Date.now() < deadline) {
          await sleepMs(50)
          if (typeof bot.refresh === 'function') await bot.refresh().catch(() => {})
          const cur = bot.heldItem
          if (!cur || cur.name !== beforeName) { dropped = true; break }
          if (beforeCount != null && typeof cur.count === 'number' && cur.count < beforeCount) { dropped = true; break }
        }
      } finally {
        bot.usingHeldItem = false
        await bot.transport.call('interact.stop', {}).catch(() => {})
      }
      // No count drop in the window = nothing was eaten (wrong item, use
      // cancelled): fail visibly instead of reporting a phantom meal.
      if (!dropped) throw new Error('consume: held item was not consumed')
    })
  }

  // mineflayer sleep: click the bed, then wait for the sleeping state
  // (state poll or the mod's sleep notification, whichever lands first).
  bot.sleep = async (bedBlock) => {
    if (bot.isSleeping) throw new Error('already sleeping')
    if (!bedBlock || !bedBlock.position) throw new Error('wrong block : not a bed block')
    if (typeof bedBlock.name === 'string' && !bedBlock.name.endsWith('_bed') && bedBlock.name !== 'bed') {
      throw new Error('wrong block : not a bed block')
    }
    const p = bedBlock.position
    await withBaritonePaused(bot, () => bot.transport.call('sleep', {
      x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z),
    }))
    const deadline = Date.now() + 3000
    while (!bot.isSleeping && Date.now() < deadline) {
      await sleepMs(50)
      if (typeof bot.refresh === 'function') await bot.refresh().catch(() => {})
    }
    if (!bot.isSleeping) throw new Error('bot is not sleeping')
  }

  // mineflayer wake: throws when awake; the mod sends STOP_SLEEPING and
  // the wake notification / state poll flips isSleeping back.
  bot.wake = async () => {
    if (!bot.isSleeping) throw new Error('already awake')
    await bot.transport.call('wake', {})
  }

  // Bead contract: n ticks = n*50 ms (no physicsTick on this body yet).
  bot.waitForTicks = async (ticks) => {
    if (typeof ticks === 'number' && ticks > 0) await sleepMs(ticks * 50)
  }
}

// Mod sleep/wake notifications: flip isSleeping and re-emit mineflayer's
// 'sleep'/'wake' (home.js/chat.js listen through bot state + wake()).
function handleLookEvent(bot, method, _params) {
  if (method === 'sleep') {
    bot.isSleeping = true
    bot.emit('sleep')
    return true
  }
  if (method === 'wake') {
    bot.isSleeping = false
    bot.emit('wake')
    return true
  }
  return false
}

module.exports = { installLook, handleLookEvent, withBaritonePaused, yawPitchFor, yawDiff, faceName, ALWAYS_CONSUMABLES }
