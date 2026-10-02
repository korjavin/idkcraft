'use strict'

// Doors (idkcraft-6xno): never break them, open them on the path, close behind.
//
// Two halves in one module — the first without the second would lock the bot
// in rooms:
//
// 1. banDoorBreaks: every *_door (+ *_trapdoor, *_fence_gate) id joins
//    movements.blocksCantBreak at setMovements. The lib breaks anything
//    diggable unless banned, and the old bans were pointwise (guardOwnWalls —
//    the CURRENT house box only; guardCastle — castle blocks only), so the
//    owner's doors, village doors and the old house after 'build here' all
//    read as breakable. protectedReason (KEEP_OWN) only guards our own dig
//    executors, never A*. Doors are not planks: a global id ban is safe here
//    (8si lifted the plank ban because walls must stay diggable).
//
// 2. addDoorPassages: a getNeighbors wrap (the nocorner/swim shape) offering
//    level straight moves across a hand-openable door — any *_door except
//    iron (copper doors click open too): the target feet cell holds the
//    lower half, the head cell the upper half, and the step runs ALONG the
//    door's facing axis, i.e. across the panel plane — never diagonal, never
//    along the wall. Open doors ride the same edge (their panel reads as
//    'break' without it). A small extra cost keeps open passages preferred.
//    Iron doors stay impassable (unbreakable + no edge: routed around).
//    The hand-door ids also join movements.openable — NOT canOpenDoors (it
//    stays false): the fork's postProcessPath treats openable nodes as
//    doorways (floor centre), while getPositionOnTopOf would perch the node
//    on top of the panel and the executor would jump at the door. The lib's
//    useOne executor is deliberately unused: it clicks blind and would SHUT
//    an already-open door, and the upper half in the head cell still reads
//    as break. A* crosses head-on by construction, so the bv6 lane stays a
//    home-legs affair (shared via behaviours/util, not copied).
//
// 3. doorReflex, the executor reflex, runs every tick (index.js, next to
//    unpin): the opener clicks a closed hand door on the plan head within
//    reach, re-reading open at the moment of the click; the closer shuts a
//    door the bot opened itself once the body is out of the doorway — never
//    a door the player opened (untracked doors are never touched), never
//    into the bot (the feet-cell + distance guard), never twice per window
//    (a lagged block update hiding our toggle must not flip it back — the
//    home.js cooldown shape). A door past the 8-node plan window heals via
//    one stuck cycle: the push replans, the fresh head names the door, the
//    opener fires.
const Vec3 = require('vec3')
const Move = require('mineflayer-pathfinder/lib/move')
const { botPos, doorOpen } = require('./behaviours/util')

const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]]
// A door handling costs a beat (open, walk, shut): price it above a free
// step so A* prefers open passages, far below any dig.
const DOOR_PASS_EXTRA = 2
// activateBlock reach with margin (survival reach is ~4.5 from the eye).
const DOOR_REACH = 3.5
// The body is out of the doorway: past cell edge (0.5) + half body (0.3)
// with margin, so the closer never shuts the panel into the bot.
const DOOR_CLOSE_DIST = 1.2
// One toggle per door per window (home.js TOGGLE_COOLDOWN_MS shape).
const DOOR_TOGGLE_COOLDOWN_MS = 2000
// Tracked doors cap (FIFO): a teleported-away bot must not grow the map.
const DOOR_TRACK_MAX = 16

function isDoorName(name) {
  return typeof name === 'string' && name.endsWith('_door')
}

function isHandDoor(name) {
  return isDoorName(name) && !name.includes('iron')
}

function registryOf(movements) {
  const reg = movements && movements.bot && movements.bot.registry
  return reg && reg.blocksByName ? reg : null
}

// Part 1: doors (+ trapdoors, fence gates) are never break candidates.
function banDoorBreaks(movements) {
  if (!movements || !(movements.blocksCantBreak instanceof Set)) return
  const reg = registryOf(movements)
  if (!reg) return
  for (const name of Object.keys(reg.blocksByName)) {
    if (!/(?:_door|_trapdoor|_fence_gate)$/.test(name)) continue
    const e = reg.blocksByName[name]
    if (e && Number.isInteger(e.id)) movements.blocksCantBreak.add(e.id)
  }
}

// Part 2: hand-door ids read as openable (the postProcessPath doorway arm —
// floor centre, not on top of the panel). canOpenDoors stays false: the
// lib's blind useOne click would shut open doors.
function addHandDoorsOpenable(movements) {
  if (!movements || !(movements.openable instanceof Set)) return
  const reg = registryOf(movements)
  if (!reg) return
  for (const name of Object.keys(reg.blocksByName)) {
    if (!isHandDoor(name)) continue
    const e = reg.blocksByName[name]
    if (e && Number.isInteger(e.id)) movements.openable.add(e.id)
  }
}

function addDoorPassages(movements) {
  // setMovements also accepts plain movement-like objects (unit mocks carry
  // only flags): wrap only a real Movements with getNeighbors.
  if (!movements || typeof movements.getNeighbors !== 'function' || movements._doorPassInstalled) return
  movements._doorPassInstalled = true
  addHandDoorsOpenable(movements)
  const orig = movements.getNeighbors.bind(movements)
  movements.getNeighbors = (node) => {
    const out = orig(node)
    for (const [dx, dz] of DIRS) {
      const edge = doorEdge(movements, node, dx, dz)
      if (edge) out.push(edge)
    }
    return out
  }
}

// A level straight step into a hand-door cell, across the panel plane:
// feet = lower half, head = upper half of the same door, the move along the
// facing axis. Anything unreadable fails closed (no edge): the door stays
// shut-but-whole rather than planned through blind.
function doorEdge(movements, node, dx, dz) {
  let feet = null
  try { feet = movements.getBlock(node, dx, 0, dz) } catch (_) { return null }
  if (!feet || !isHandDoor(feet.name)) return null
  let head = null
  try { head = movements.getBlock(node, dx, 1, dz) } catch (_) { return null }
  if (!head || head.name !== feet.name) return null
  let props = null
  try { props = typeof feet.getProperties === 'function' ? feet.getProperties() : null } catch (_) { return null }
  if (!props || props.half !== 'lower') return null
  let headProps = null
  try { headProps = typeof head.getProperties === 'function' ? head.getProperties() : null } catch (_) { return null }
  if (!headProps || headProps.half !== 'upper') return null
  // Across the plane = along the facing axis: north/south doors cross along
  // z, east/west along x (the home.js lane geometry). The facing read comes
  // from the lower half; the upper half carries the same facing.
  const f = props.facing
  const across = (f === 'north' || f === 'south')
    ? (dx === 0 && dz !== 0)
    : (f === 'east' || f === 'west') ? (dz === 0 && dx !== 0) : false
  if (!across) return null
  // Standable floor under the door (never place under one).
  let under = null
  try { under = movements.getBlock(node, dx, -1, dz) } catch (_) { return null }
  if (!under || !under.physical) return null
  let cost = 1 + DOOR_PASS_EXTRA
  try {
    const excl = movements.exclusionStep(feet)
    if (excl >= 100) return null
    cost += excl
  } catch (_) { /* exclusion best-effort */ }
  try {
    if (feet.position) cost += movements.getNumEntitiesAt(feet.position, 0, 0, 0) * movements.entityCost
  } catch (_) { /* entity cost best-effort */ }
  return new Move(node.x + dx, node.y, node.z + dz, node.remainingBlocks, cost, [], [])
}

// Part 3: the executor reflex. Closer first so a passed door shuts on the
// same tick the next leg opens another; per-door cooldowns keep the two
// from ever double-toggling one door.
function doorReflex(bot, ctx) {
  if (!bot || !ctx) return
  try { closeOwnDoors(bot, ctx) } catch (_) { /* closer best-effort */ }
  try { openNextDoor(bot, ctx) } catch (_) { /* opener best-effort */ }
}

function doorKey(x, y, z) {
  return `${x},${y},${z}`
}

function trackedDoors(ctx) {
  if (!(ctx.doorOpened instanceof Map)) ctx.doorOpened = new Map()
  return ctx.doorOpened
}

function toggleStamps(ctx) {
  if (!ctx.doorToggleAt || typeof ctx.doorToggleAt !== 'object') ctx.doorToggleAt = {}
  return ctx.doorToggleAt
}

function toggleReady(ctx, key, now) {
  const stamps = toggleStamps(ctx)
  const at = stamps[key]
  if (typeof at === 'number' && now - at < DOOR_TOGGLE_COOLDOWN_MS) return false
  stamps[key] = now
  return true
}

function tryToggle(bot, block) {
  try {
    const r = bot.activateBlock(block)
    if (r && typeof r.catch === 'function') r.catch(() => {})
    return true
  } catch (_) {
    return false
  }
}

// Plan-window geometry: the index of the window node nearest the body, so
// 'ahead' means index >= that (a passed door in a stale window still
// closes; a door the body walks toward never does).
function nearestAhead(nodes, bp) {
  let best = 0
  let bestD = Infinity
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i]
    if (!n || typeof n.x !== 'number' || typeof n.z !== 'number') continue
    const d = Math.hypot(n.x - bp.x, n.z - bp.z)
    if (d < bestD) { bestD = d; best = i }
  }
  return best
}

function windowIndexOf(nodes, x, y, z) {
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i]
    if (!n || typeof n.x !== 'number' || typeof n.y !== 'number' || typeof n.z !== 'number') continue
    if (Math.floor(n.x) === x && Math.floor(n.y) === y && Math.floor(n.z) === z) return i
  }
  return -1
}

function planWindow(ctx) {
  const nodes = ctx && Array.isArray(ctx.lastPathNodes) ? ctx.lastPathNodes : null
  return nodes && nodes.length > 0 ? nodes : null
}

function executorMoving(bot) {
  try {
    return !!(bot.pathfinder && typeof bot.pathfinder.isMoving === 'function' && bot.pathfinder.isMoving())
  } catch (_) {
    return false
  }
}

// The opener: the nearest closed hand door on the plan ahead within reach.
// A stale plan never opens behind the body (the ahead guard); an idle
// executor (home-legs direct control, parked stop) never opens at all.
function openNextDoor(bot, ctx) {
  if (!executorMoving(bot)) return
  const bp = botPos(bot)
  if (!bp) return
  const nodes = planWindow(ctx)
  if (!nodes) return
  const ahead = nearestAhead(nodes, bp)
  let pick = null
  let pickD = Infinity
  for (let i = ahead; i < nodes.length; i++) {
    const n = nodes[i]
    if (!n || typeof n.x !== 'number' || typeof n.y !== 'number' || typeof n.z !== 'number') continue
    const x = Math.floor(n.x)
    const y = Math.floor(n.y)
    const z = Math.floor(n.z)
    let block = null
    try { block = bot.blockAt && bot.blockAt(new Vec3(x, y, z)) } catch (_) { continue }
    if (!block || !isHandDoor(block.name)) continue
    const d = Math.hypot(x + 0.5 - bp.x, y + 0.5 - bp.y, z + 0.5 - bp.z)
    if (d > DOOR_REACH || d >= pickD) continue
    pick = { x, y, z, block }
    pickD = d
  }
  if (!pick) return
  // State at the moment of the click: a door the player just opened is
  // none of ours — re-read, never trust the scan above.
  let fresh = null
  try { fresh = bot.blockAt && bot.blockAt(new Vec3(pick.x, pick.y, pick.z)) } catch (_) { return }
  if (!fresh || !isHandDoor(fresh.name) || doorOpen(fresh)) return
  const key = doorKey(pick.x, pick.y, pick.z)
  if (!toggleReady(ctx, key, Date.now())) return
  if (!tryToggle(bot, fresh)) return
  const tracked = trackedDoors(ctx)
  tracked.set(key, { x: pick.x, y: pick.y, z: pick.z })
  while (tracked.size > DOOR_TRACK_MAX) tracked.delete(tracked.keys().next().value)
  try { console.log(`door open at ${pick.x} ${pick.y} ${pick.z}`) } catch (_) { /* log best-effort */ }
}

// The closer: only doors the opener tracked (its own openings), only once
// the body is out of the doorway and the door is off the walked-ahead
// plan, only within reach (a teleport away leaves the entry for the return
// visit). A missing or non-door cell and an already-shut door untrack.
function closeOwnDoors(bot, ctx) {
  const tracked = ctx.doorOpened instanceof Map ? ctx.doorOpened : null
  if (!tracked || tracked.size === 0) return
  const bp = botPos(bot)
  if (!bp) return
  const nodes = planWindow(ctx)
  const ahead = nodes ? nearestAhead(nodes, bp) : 0
  const feetKey = doorKey(Math.floor(bp.x), Math.floor(bp.y), Math.floor(bp.z))
  for (const [key, door] of tracked) {
    if (!door || typeof door.x !== 'number') { tracked.delete(key); continue }
    let block = null
    try { block = bot.blockAt && bot.blockAt(new Vec3(door.x, door.y, door.z)) } catch (_) { continue }
    if (!block || !isDoorName(block.name)) { tracked.delete(key); continue }
    if (!doorOpen(block)) { tracked.delete(key); continue }
    if (key === feetKey) continue // standing in the doorway
    if (nodes) {
      const at = windowIndexOf(nodes, door.x, door.y, door.z)
      if (at >= ahead) continue // still walking toward it
    }
    if (Math.hypot(door.x + 0.5 - bp.x, door.z + 0.5 - bp.z) <= DOOR_CLOSE_DIST) continue
    const d = Math.hypot(door.x + 0.5 - bp.x, door.y + 0.5 - bp.y, door.z + 0.5 - bp.z)
    if (d > DOOR_REACH) continue // out of reach: shut on the return visit
    if (!toggleReady(ctx, key, Date.now())) continue
    if (!tryToggle(bot, block)) continue
    try { console.log(`door shut at ${door.x} ${door.y} ${door.z}`) } catch (_) { /* log best-effort */ }
  }
}

module.exports = {
  banDoorBreaks,
  addDoorPassages,
  addHandDoorsOpenable,
  doorReflex,
  isDoorName,
  isHandDoor,
  DOOR_PASS_EXTRA,
  DOOR_REACH,
  DOOR_CLOSE_DIST,
  DOOR_TOGGLE_COOLDOWN_MS,
}
