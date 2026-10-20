// idkcraft-neuc.3: entities + roster fold for the Baritone-body bridge.
//
// The mod streams players/mobs over `entities.list` + `roster.get` (one
// round per adapter poll) plus `player.joined`/`player.left`/`entity.gone`
// notifications. This module folds both channels into the mineflayer shapes
// the logic already reads — bot.entities, bot.players, bot.nearestEntity —
// so follow.js, perception.js, worker.players() and the chat sender
// resolution run unchanged on v2.
//
// Wiring (landed in index.js): the poll round calls refreshEntities(bot,
// transport) best-effort after inventory, and _handleEvent delegates to
// handleBridgeEvent first. bridge-entities.test.js covers the wired path
// end to end (incl. an EP1-shaped follow microcosm).
//
// Fold rules (mineflayer parity, plugins/entities.js):
// - bot.entities[id] objects are STABLE: sighted entities mutate in place
//   (perception/follow keep references between ticks), gone ones emit
//   entityGone, flip isValid=false, unlink and delete.
// - bot.players[name] merges roster.get with the matching player entity by
//   uuid (name fallback); entity is null when out of range. Roster diffs
//   emit playerJoined/playerLeft; the notifications converge on the same
//   state, so whichever channel runs first emits and the other is a no-op.
// - bot.entity stays the state.get-fed object; when the wire tags our own
//   entry (self:true) it is ALSO aliased under bot.entities[selfId], exactly
//   like mineflayer (fetchEntity on login). Perception skips type=player,
//   nearestEntity skips bot.entity by identity, so the alias is safe.
// - Floodgate dot-names pass through untouched: no normalization here,
//   perception.resolvePlayer already matches '.Steve' <-> 'Steve'.
// - This file requires nothing outside bot/src/bridge/ (epic section 2).
'use strict'

// Player dimensions mirror mineflayer's PLAYER_* constants: the logic reads
// hostile.height (fight.js lookAt) and e.eyeHeight (craft.js), so every
// entity carries them. Mob dims come from the passed-through registry
// (zero bridge traffic, epic section 5); players are constant.
const PLAYER_HEIGHT = 1.8
const PLAYER_WIDTH = 0.6
const PLAYER_EYE_HEIGHT = 1.62

function dimsFor(bot, name, type) {
  if (type === 'player') return { height: PLAYER_HEIGHT, width: PLAYER_WIDTH, eyeHeight: PLAYER_EYE_HEIGHT }
  try {
    const byName = bot && bot.registry && bot.registry.entitiesByName
    const e = byName && byName[name]
    if (e && typeof e.height === 'number' && typeof e.width === 'number') {
      return { height: e.height, width: e.width, eyeHeight: null }
    }
  } catch (_) { /* unknown mob reads 1x1, like an unmapped registry entry */ }
  return { height: 1, width: 1, eyeHeight: null }
}

// v1 parity (mineflayer setEntityData): entity.type comes from the
// passed-through registry (zombie->'hostile', arrow->'projectile',
// item->'other'), not the old mob/object buckets — flat.js skips only
// type 'projectile'. Players stay 'player'; names missing from the
// registry fall back to the kind bucket.
function entityTypeOf(bot, w) {
  if (w.type === 'player' || w.kind === 'player') return 'player'
  try {
    const byName = bot && bot.registry && bot.registry.entitiesByName
    const reg = byName && w.type && byName[w.type]
    if (reg && typeof reg.type === 'string' && reg.type) return reg.type
  } catch (_) { /* unmapped name reads the kind bucket below */ }
  return w.kind === 'other' ? 'object' : 'mob'
}

function newVec(bot, p, fallback) {
  const f = fallback || { x: 0, y: 0, z: 0 }
  const x = p && typeof p.x === 'number' ? p.x : f.x
  const y = p && typeof p.y === 'number' ? p.y : f.y
  const z = p && typeof p.z === 'number' ? p.z : f.z
  return new bot.Vec3(x, y, z)
}

function setVec(v, p) {
  if (!v || !p) return
  if (typeof p.x === 'number') v.x = p.x
  if (typeof p.y === 'number') v.y = p.y
  if (typeof p.z === 'number') v.z = p.z
}

// idkcraft-poyd: the wire names the dropped stack (item registry path) on
// item entities; the fold carries it as entity.item plus a mineflayer-shaped
// getDroppedItem() so the skill facade reads drops on both bodies.
function dropItemOf(w) {
  return (w && typeof w.item === 'string' && w.item) ? w.item : null
}

function makeEntity(bot, w) {
  const type = entityTypeOf(bot, w)
  const name = type === 'player' ? 'player' : String(w.type || 'unknown')
  const dims = dimsFor(bot, name, type)
  const displayName = w.displayName || w.name || name
  const dropItem = dropItemOf(w)
  const e = {
    id: w.id,
    uuid: w.uuid || null,
    type,
    name,
    displayName,
    mobType: displayName, // prismarine-entity aliases mobType to displayName
    position: newVec(bot, w.pos, { x: 0, y: 64, z: 0 }),
    velocity: newVec(bot, w.vel),
    yaw: typeof w.yaw === 'number' ? w.yaw : 0,
    pitch: typeof w.pitch === 'number' ? w.pitch : 0,
    onGround: w.onGround !== false,
    health: typeof w.health === 'number' ? w.health : null,
    pose: typeof w.pose === 'string' ? w.pose : null,
    kind: w.kind || 'other',
    height: dims.height,
    width: dims.width,
    eyeHeight: dims.eyeHeight,
    isValid: true,
    metadata: [], // ponytail: raw metadata streaming is later work; wool reads fail open on []
  }
  if (type === 'player') e.username = w.name || null
  if (dropItem) {
    e.item = dropItem
    e.getDroppedItem = () => ({ name: dropItem })
  }
  return e
}

// In-place update: position/velocity Vec3 objects keep identity (perception
// holds them across ticks); scalars overwrite when the wire carries them.
function updateEntity(e, w) {
  if (w.uuid && !e.uuid) e.uuid = w.uuid
  const dropItem = dropItemOf(w)
  if (dropItem) {
    if (e.item !== dropItem) {
      e.item = dropItem
      e.getDroppedItem = () => ({ name: dropItem })
    }
  } else if ('item' in e) {
    delete e.item
    delete e.getDroppedItem
  }
  setVec(e.position, w.pos)
  setVec(e.velocity, w.vel)
  if (typeof w.yaw === 'number') e.yaw = w.yaw
  if (typeof w.pitch === 'number') e.pitch = w.pitch
  if (typeof w.onGround === 'boolean') e.onGround = w.onGround
  if (typeof w.health === 'number') e.health = w.health
  if (typeof w.pose === 'string') e.pose = w.pose
  if (typeof w.kind === 'string') e.kind = w.kind
  if (w.displayName) { e.displayName = w.displayName; e.mobType = w.displayName }
  if (w.name && e.type === 'player' && !e.username) e.username = w.name
  e.isValid = true
}

// Our own entry (self:true): alias, never duplicate. bot.entity stays the
// state.get-fed object — the list only contributes id/uuid/identity fields,
// never position (single writer).
function linkSelf(bot, w) {
  if (!bot.entity) return
  if (bot.entity.id == null && typeof w.id === 'number') bot.entity.id = w.id
  if (bot.entity.uuid == null && w.uuid) bot.entity.uuid = w.uuid
  if (!bot.entity.type) bot.entity.type = 'player'
  if (!bot.entity.name) bot.entity.name = 'player'
  if (bot.entity.username == null && w.name) bot.entity.username = w.name
  bot.entities[String(w.id)] = bot.entity
}

function normUuid(u) {
  return String(u).toLowerCase().replace(/-/g, '')
}

// Re-link every roster entry to its live player entity (uuid first, name
// fallback, self fallback): null when out of range, exactly mineflayer.
function linkPlayers(bot) {
  const roster = bot.players || {}
  const entities = bot.entities || {}
  const byUuid = new Map()
  for (const e of Object.values(entities)) {
    if (e && e.type === 'player' && e.uuid) byUuid.set(normUuid(e.uuid), e)
  }
  for (const key of Object.keys(roster)) {
    const entry = roster[key]
    if (!entry) continue
    let found = entry.uuid ? byUuid.get(normUuid(entry.uuid)) || null : null
    if (!found && entry.username) {
      for (const e of Object.values(entities)) {
        if (e && e.type === 'player' && e.username === entry.username) { found = e; break }
      }
    }
    if (!found && bot.entity && entry.username && entry.username === bot.username) found = bot.entity
    entry.entity = found || null
  }
}

function unlinkRosterEntity(bot, e) {
  const roster = bot.players || {}
  for (const key of Object.keys(roster)) {
    const entry = roster[key]
    if (entry && entry.entity === e) entry.entity = null
  }
}

// Removal order mirrors mineflayer's entity_destroy: emit first (listeners
// see a valid entity), then invalidate, unlink and delete.
function removeEntity(bot, key, e) {
  if (!e || e === bot.entity) return // self is state.get-owned, never removed
  bot.emit('entityGone', e)
  e.isValid = false
  unlinkRosterEntity(bot, e)
  if (bot.entities[key] === e) delete bot.entities[key]
}

function syncEntities(bot, payload) {
  ensureNearestEntity(bot)
  if (!bot.entities) bot.entities = {}
  const list = payload && Array.isArray(payload.entities) ? payload.entities : []
  const seen = new Set()
  for (const w of list) {
    if (!w || typeof w.id !== 'number' || !w.pos) continue
    const key = String(w.id)
    seen.add(key)
    if (w.self) { linkSelf(bot, w); continue }
    const cur = bot.entities[key]
    if (cur) {
      if (cur !== bot.entity) updateEntity(cur, w)
      continue
    }
    const e = makeEntity(bot, w)
    bot.entities[key] = e
    bot.emit('entitySpawn', e)
  }
  for (const key of Object.keys(bot.entities)) {
    if (!seen.has(key)) removeEntity(bot, key, bot.entities[key])
  }
  linkPlayers(bot)
  return bot
}

function syncRoster(bot, payload) {
  if (!bot.players) bot.players = {}
  const list = payload && Array.isArray(payload.players) ? payload.players : []
  const seen = new Set()
  for (const p of list) {
    if (!p || typeof p.name !== 'string' || !p.name) continue
    seen.add(p.name)
    const cur = bot.players[p.name]
    if (cur) {
      if (p.uuid) cur.uuid = p.uuid
      if (typeof p.ping === 'number') cur.ping = p.ping
      if (p.gameMode != null) cur.gamemode = p.gameMode
    } else {
      const entry = {
        username: p.name,
        uuid: p.uuid || null,
        ping: typeof p.ping === 'number' ? p.ping : null,
        gamemode: p.gameMode != null ? p.gameMode : null,
        entity: null,
      }
      bot.players[p.name] = entry
      bot.emit('playerJoined', entry)
    }
  }
  for (const key of Object.keys(bot.players)) {
    if (seen.has(key)) continue
    const entry = bot.players[key]
    delete bot.players[key]
    bot.emit('playerLeft', entry)
  }
  linkPlayers(bot)
  return bot
}

// mineflayer's nearestEntity, verbatim semantics: skips bot.entity by
// identity, ranks by distanceSquared, default match-all.
function ensureNearestEntity(bot) {
  if (typeof bot.nearestEntity === 'function') return
  bot.nearestEntity = (match = () => true) => {
    const bp = bot.entity && bot.entity.position
    if (!bp || typeof bp.distanceSquared !== 'function') return null
    let best = null
    let bestDistance = Infinity
    for (const e of Object.values(bot.entities || {})) {
      if (!e || e === bot.entity || !e.position) continue
      let ok = false
      try { ok = match(e) } catch (_) { continue }
      if (!ok) continue
      let d
      try { d = bp.distanceSquared(e.position) } catch (_) { continue }
      if (typeof d !== 'number') continue
      if (d < bestDistance) { bestDistance = d; best = e }
    }
    return best
  }
}

// One entities.list + one roster.get per poll round. Throws on transport
// errors (the adapter poll is best-effort per round); partial folds stay.
async function refreshEntities(bot, transport) {
  const list = await transport.call('entities.list', {})
  syncEntities(bot, list)
  const roster = await transport.call('roster.get', {})
  syncRoster(bot, roster)
  return bot
}

// Notification half of the fold. Returns true when consumed so the adapter
// routes unknown methods on; state-convergent with the poll diffs, so a
// notification followed by a poll (or vice versa) emits exactly once.
function handleBridgeEvent(bot, method, params) {
  const p = params || {}
  if (method === 'player.joined') {
    if (typeof p.name !== 'string' || !p.name) return true
    if (!bot.players) bot.players = {}
    if (!bot.players[p.name]) {
      const entry = { username: p.name, uuid: p.uuid || null, ping: null, gamemode: null, entity: null }
      bot.players[p.name] = entry
      linkPlayers(bot)
      bot.emit('playerJoined', entry)
    }
    return true
  }
  if (method === 'player.left') {
    if (typeof p.name !== 'string' || !p.name) return true
    const entry = bot.players && bot.players[p.name]
    if (entry) {
      delete bot.players[p.name]
      bot.emit('playerLeft', entry)
    }
    return true
  }
  if (method === 'entity.gone') {
    if (typeof p.id !== 'number') return true
    const key = String(p.id)
    const e = bot.entities && bot.entities[key]
    if (e) removeEntity(bot, key, e)
    return true
  }
  return false
}

module.exports = { syncEntities, syncRoster, refreshEntities, handleBridgeEvent, ensureNearestEntity }
