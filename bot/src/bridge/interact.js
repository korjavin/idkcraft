// idkcraft-neuc.7: dig/place for the Baritone body.
//
// mineflayer signatures over the bridge wire (baritone/bridge/PROTOCOL.md,
// dig/place section): bot.dig / stopDigging / targetDigBlock /
// diggingCompleted / diggingAborted over dig.start + the mod's
// dig.progress/done/abort notifications, bot.placeBlock over place.once +
// the server's block.update for the target (mineflayer place_block.js
// waits on the same update). No artificial delays: the real client's
// break progress sets the pace.
//
// Defined from the adapter constructor, i.e. before 'spawn' — util.js
// trackPlaced/installPlaceTiming wrap bot.placeBlock at first spawn.
// _placeBlockWithOptions stays absent (castle.js falls back to placeBlock).
//
// This file requires nothing outside bot/src/bridge/ (epic section 2).
'use strict'

const chunks = require('./chunks')
const { withBaritonePaused, yawPitchFor, faceName } = require('./look')

const DIG_GUARD_MS = 35000 // mod aborts at 30 s; a lost notification must not hang the dig
const PLACE_WAIT_MS = 1000 // server block.update for the target after place.once

function failLog(what, e) { console.log(`bridge ${what} failed: ${(e && e.message) || e}`) }

function cell(p) { return { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) } }
function same(a, b) { return !!a && !!b && a.x === b.x && a.y === b.y && a.z === b.z }
function fmt(p) { return `(${p.x}, ${p.y}, ${p.z})` } // mineflayer Vec3.toString shape

function eyeOf(bot) {
  const p = bot.entity.position
  const h = typeof bot.entity.eyeHeight === 'number' ? bot.entity.eyeHeight : 1.62
  return { x: p.x, y: p.y + h, z: p.z }
}

// mineflayer bot.digTime, held item only (helmet aqua affinity skipped).
function digTimeOf(bot, block) {
  if (!block || typeof block.digTime !== 'function') return 0
  const held = bot.heldItem
  let eyeBlock = null
  try { eyeBlock = bot.blockAt(bot.entity.position.offset(0, 1.62, 0)) } catch (_) { eyeBlock = null }
  return block.digTime(
    held ? held.type : null,
    !!(bot.game && bot.game.gameMode === 'creative'),
    !!eyeBlock && (eyeBlock.name === 'water' || eyeBlock.name === 'flowing_water'),
    !bot.entity.onGround,
    (held && held.enchants) || [],
    bot.entity.effects,
  )
}

function installInteract(bot) {
  bot.targetDigBlock = null
  bot._dig = null

  // Settle the dig in flight exactly once (done / abort / guard / stop).
  const settle = (d, err, newBlock) => {
    if (bot._dig !== d) return false
    bot._dig = null
    clearTimeout(d.guard)
    bot.targetDigBlock = null
    if (err) {
      bot.emit('diggingAborted', d.block)
      d.reject(err)
    } else {
      bot.emit('diggingCompleted', newBlock)
      d.resolve()
    }
    return true
  }
  bot._settleDig = settle

  // mineflayer dig(block, forceLook, digFace): resolves when the block is
  // gone (the mod's dig.done = the client saw air), rejects 'Digging
  // aborted' on stopDigging and on the mod's dig.abort (reason appended).
  bot.dig = async (block, forceLook, digFace) => {
    if (block === null || block === undefined) throw new Error('dig was called with an undefined or null block')
    if (digTimeOf(bot, block) === Infinity) throw new Error(`dig time for ${block.name ?? block} is Infinity`)
    if (!block.position) throw new Error('dig: block has no position')
    if (bot.targetDigBlock) bot.stopDigging()
    const pos = cell(block.position)
    const vec = digFace && typeof digFace === 'object' && (digFace.x || digFace.y || digFace.z) ? digFace : null
    const face = vec ? faceName(vec) : 'up' // mineflayer 'auto' digs the top face
    const look = forceLook !== 'ignore'
    if (look) {
      const point = { x: pos.x + 0.5 + (vec ? vec.x * 0.5 : 0), y: pos.y + 0.5 + (vec ? vec.y * 0.5 : 0), z: pos.z + 0.5 + (vec ? vec.z * 0.5 : 0) }
      const { yaw, pitch } = yawPitchFor(eyeOf(bot), point)
      bot.entity.yaw = yaw // the mod aims from the real eye; mirror it locally
      bot.entity.pitch = pitch
    }
    await withBaritonePaused(bot, () => new Promise((resolve, reject) => {
      const d = { pos, block, resolve, reject, guard: null }
      bot._dig = d
      bot.targetDigBlock = block // stuck.js / deep.js read this mid-dig
      d.guard = setTimeout(() => {
        if (settle(d, new Error('Digging aborted (timeout)'))) {
          bot.transport.call('dig.abort', {}).catch((e) => failLog('dig.abort', e))
        }
      }, DIG_GUARD_MS)
      if (typeof d.guard.unref === 'function') d.guard.unref()
      bot.transport.call('dig.start', { ...pos, face, look }).catch((e) => settle(d, e instanceof Error ? e : new Error(String(e))))
    }))
  }

  bot.stopDigging = () => {
    const d = bot._dig
    if (!d) return
    if (settle(d, new Error('Digging aborted'))) {
      bot.transport.call('dig.abort', {}).catch((e) => failLog('dig.abort', e))
    }
  }

  // mineflayer swingArm: cosmetic; the mod swings on every dig/place itself.
  bot.swingArm = () => {}

  // mineflayer placeBlock(referenceBlock, faceVector): look at the face
  // centre, click it, then settle on the server's block.update for the
  // target — a type change places; an unchanged answer (or none within
  // 1 s) rejects with mineflayer's strings.
  bot.placeBlock = async (referenceBlock, faceVector) => {
    if (!referenceBlock || !referenceBlock.position || !faceVector) throw new Error('placeBlock: want (referenceBlock, faceVector)')
    if (!bot.heldItem) throw new Error('must be holding an item to place')
    const rp = cell(referenceBlock.position)
    const dest = { x: rp.x + faceVector.x, y: rp.y + faceVector.y, z: rp.z + faceVector.z }
    const cursor = { x: 0.5 + faceVector.x * 0.5, y: 0.5 + faceVector.y * 0.5, z: 0.5 + faceVector.z * 0.5 }
    const { yaw, pitch } = yawPitchFor(eyeOf(bot), { x: rp.x + cursor.x, y: rp.y + cursor.y, z: rp.z + cursor.z })
    const heldName = bot.heldItem.name
    let oldBlock = null
    try { oldBlock = bot.blockAt(new bot.Vec3(dest.x, dest.y, dest.z)) } catch (_) { oldBlock = null }
    await withBaritonePaused(bot, async () => {
      // Listen before the click: the update can beat the reply.
      let seen = null
      let onUpdate = null
      let timer = null
      let done = null
      const settled = new Promise((resolve) => { done = resolve })
      onUpdate = (_o, n) => {
        if (!n || !n.position || !same(cell(n.position), dest)) return
        if (!oldBlock || n.type !== oldBlock.type) done({ placed: n })
        else seen = n
      }
      bot.on('blockUpdate', onUpdate)
      try {
        await bot.transport.call('place.once', { ...dest, face: faceName(faceVector), yaw, pitch, cursor, sneak: false })
        bot.entity.yaw = yaw
        bot.entity.pitch = pitch
        timer = setTimeout(() => done({ timeout: true }), PLACE_WAIT_MS)
        const r = await settled
        if (r.placed) {
          bot.emit('blockPlaced', oldBlock, r.placed)
          return
        }
        if (seen) throw new Error(`Server refused to place ${heldName} at ${fmt(dest)}: the block is still ${seen.name}`)
        throw new Error(`Server did not answer the placement at ${fmt(dest)}: timeout`)
      } finally {
        clearTimeout(timer)
        bot.removeListener('blockUpdate', onUpdate)
      }
    })
  }
}

// Mod dig notifications. dig.done writes the broken cell through (the
// logic re-reads blockAt right after the promise) and emits blockUpdate
// like a block.update would (trackPlaced un-owns dug cells on it).
function handleInteractEvent(bot, method, params) {
  if (method === 'dig.progress') return true
  if (method !== 'dig.done' && method !== 'dig.abort') return false
  const p = params || {}
  const d = bot._dig
  if (!d || !same(d.pos, cell(p))) return true // a stale dig's outcome
  if (method === 'dig.done') {
    const stateId = typeof p.stateId === 'number' ? p.stateId : 0
    const [oldBlock, newBlock] = chunks.applyBlockUpdate(bot, { ...d.pos, stateId })
    if (newBlock) bot.emit('blockUpdate', oldBlock, newBlock)
    bot._settleDig(d, null, newBlock)
  } else {
    bot._settleDig(d, new Error(`Digging aborted (${p.reason || 'unknown'})`))
  }
  return true
}

module.exports = { installInteract, handleInteractEvent, digTimeOf }
