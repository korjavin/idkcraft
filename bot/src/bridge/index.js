// idkcraft-neuc.2: Node 'bot' for the Baritone body — looks like
// mineflayer's bot to the UNCHANGED ticker, drives a real headless client
// (HeadlessMc + Fabric bridge mod + Baritone) underneath. Moved from the
// kqzf spike (baritone/bridge/adapter.js); the spike's 'console' backend is
// gone (rig-goto.js went with it — .5 brings the real harness).
//
// Self-containment: this directory must never require anything from
// bot/src outside bridge/ (bot/test/bridge-body.test.js holds that).
'use strict'

const { EventEmitter } = require('node:events')
const net = require('node:net')
const { BridgeTransport } = require('./transport')
const { refreshEntities, handleBridgeEvent } = require('./entities') // idkcraft-neuc.3: entities+roster fold
const chunks = require('./chunks') // idkcraft-neuc.6: chunk cache -> sync blockAt/findBlocks/raycast
const { installInventory, applyInventory, handleInventoryEvent } = require('./inventory') // idkcraft-neuc.8: inventory/equip/toss fold
const { installLook, handleLookEvent, withBaritonePaused } = require('./look') // idkcraft-neuc.9: look/attack/interact/sleep
const { installInput, setBaritonePaused } = require('./input') // idkcraft-neuc.13: control states
const { installLifecycle, handleLifecycleEvent } = require('./lifecycle') // idkcraft-neuc.10: lifecycle/event parity
const { installWindows, handleWindowEvent } = require('./windows') // idkcraft-neuc.11: container windows
const { installInteract, handleInteractEvent } = require('./interact') // idkcraft-neuc.7: dig/place
const { installMine, handleMineEvent, cancelMine } = require('./mine') // idkcraft-neuc.53: baritone.mine -> MineProcess
const { installBuild, installBuildStop, handleBuildEvent } = require('./build') // idkcraft-neuc.54: buildCells

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)) }
// Failed fire-and-forget baritone.cmd: log, never emit 'error' (runOnce
// fatal()s every 'error'; see chat()).
function failLog(e) {
  console.log(`bridge baritone.cmd failed: ${(e && e.message) || e}`)
}

// Minimal Vec3 when the caller injects none (tests inject the real vec3
// from bot/node_modules for full parity: plus/minus/scaled/floored/...).
class MinimalVec {
  constructor(x, y, z) { this.x = x; this.y = y; this.z = z }
  floored() { return new MinimalVec(Math.floor(this.x), Math.floor(this.y), Math.floor(this.z)) }
  offset(dx, dy, dz) { return new MinimalVec(this.x + dx, this.y + dy, this.z + dz) }
  distanceTo(q) { return Math.hypot(this.x - q.x, this.y - q.y, this.z - q.z) }
  clone() { return new MinimalVec(this.x, this.y, this.z) }
}

// mineflayer game-mode names by the two low bits (mineflayer game.js
// parseGameMode): the mod may send either form.
const GAME_MODES = ['survival', 'creative', 'adventure', 'spectator']
function gameModeName(gm) {
  if (typeof gm === 'number' && gm >= 0 && gm <= 3) return GAME_MODES[gm]
  return gm
}
// idkcraft-neuc.22: mineflayer bot.chat's split (lib/plugins/chat.js
// chatWithHeader, header ''): a '/' command goes whole, else per '\n' line
// (empties dropped) in 256-char packets. One unsplit 449-char line killed
// the v2 client ("String too big", EncoderException) every ~62 s on prod.
const CHAT_LENGTH_LIMIT = 256
let chatSplitSaid = false
function chatParts(message) {
  const msg = String(message)
  if (msg.startsWith('/')) return [msg]
  const parts = []
  for (const line of msg.split('\n')) {
    if (line.length > CHAT_LENGTH_LIMIT && !chatSplitSaid) {
      chatSplitSaid = true // once per process: names the long line for the bead
      console.log(`bridge chat split ${line.length} chars: ${line.slice(0, 120)}`)
    }
    for (let i = 0; i < line.length; i += CHAT_LENGTH_LIMIT) parts.push(line.substring(i, i + CHAT_LENGTH_LIMIT))
  }
  return parts
}

const STALL_MS = 10000 // still-while-pathing budget before a re-plan (_stallReplan)
const STALL_MOVE = 0.5 // displacement that counts as moving (stuck.js MOVE_TOLERANCE)
const DOOR_KICK_COOLDOWN_MS = 2000 // one hand-toggle per door cell per window (doors.js DOOR_TOGGLE_COOLDOWN_MS shape)
const CHAT_HOLD_MS = 10000 // neuc.33: max wait for the near columns before an order is delivered anyway (~8 columns/s)

function stripMcPrefix(s) {
  return typeof s === 'string' ? s.replace(/^minecraft:/, '') : s
}

// mineflayer-pathfinder goal -> Baritone console command. GoalFollow is a
// one-shot #near around the target's live cell (followCmd): follow.js already re-issues
// on movement/timeout, so no Baritone #follow semantics are needed (plus
// the adapter's own 1/s re-issue for dynamic goals, _maybeReissueFollow).
// GoalY is a single-number #goto (Baritone: "goto <y> - Go to a Y level").
// Composites resolve to the first mappable member; GoalInvert and
// GoalBreakBlock have no mapping (the latter throws on v1 too — gather.js
// documents the pinned-pathfinder crash — so noPath is the graceful twin).
// from = the bot's feet {x,y,z}: place/look goals walk to the neighbour
// cell on the bot's side, never into p itself (v1's isEnd excludes the
// bot's own cells; walking in would stand in the placement cell or dig
// out a look target). Without from there is no safe side: null.
// Returns null when the goal has no Baritone mapping (caller then reports
// noPath, like the executor would).
// GoalFollow -> `#near` on the target's floored cell (idkcraft-neuc.28):
// v1's isEnd is the same floored distSq <= rangeSq test as GoalNear, while
// an exact `#goto` on the cell walked Baritone into the mob (and a mob in a
// hole answered noPath). Shared by the initial goal and every re-issue.
function followCmd(p, rangeSq) {
  if (!p || typeof p.x !== 'number' || typeof p.y !== 'number' || typeof p.z !== 'number') return null
  const r = typeof rangeSq === 'number' && rangeSq >= 0 ? Math.floor(Math.sqrt(rangeSq)) : 0
  return `#near ${Math.floor(p.x)} ${Math.floor(p.y)} ${Math.floor(p.z)} ${r}`
}

// The xz a goal command aims at (cell centre, like danger.js goalXZ), or
// null for a Y-only #goto.
function cmdXZ(command) {
  const n = String(command || '').trim().split(/\s+/).slice(1).map(Number)
  if (!n.every(Number.isFinite)) return null
  if (n.length === 3 || n.length === 4) return { x: n[0] + 0.5, z: n[2] + 0.5 } // #goto x y z / #near x y z r
  if (n.length === 2) return { x: n[0] + 0.5, z: n[1] + 0.5 } // #goto x z
  return null
}

// neuc.50: the GoalSeeTable cell (see goalToBaritone). blockAt = the body's
// sync world read; feet + head passable, solid floor. ponytail: a 7x7x7
// scan once per setGoal (343 isEnd rays at most), no path-cost ranking.
function seeCellCmd(goal, from, blockAt) {
  if (typeof blockAt !== 'function' || typeof goal.isEnd !== 'function' || !from) return null
  const open = (b) => !!b && b.boundingBox === 'empty'
  let best = null
  let bestD = Infinity
  try {
    for (let dx = -3; dx <= 3; dx++) {
      for (let dy = -3; dy <= 3; dy++) {
        for (let dz = -3; dz <= 3; dz++) {
          const x = goal.x + dx
          const y = goal.y + dy
          const z = goal.z + dz
          const d = (x + 0.5 - from.x) ** 2 + (y - from.y) ** 2 + (z + 0.5 - from.z) ** 2
          if (d >= bestD || !goal.isEnd({ x, y, z })) continue
          const below = blockAt(x, y - 1, z)
          if (!below || below.boundingBox !== 'block' || !open(blockAt(x, y, z)) || !open(blockAt(x, y + 1, z))) continue
          best = { x, y, z }
          bestD = d
        }
      }
    }
  } catch (_) { return null }
  return best ? `#goto ${best.x} ${best.y} ${best.z}` : null
}

function goalToBaritone(goal, from, blockAt) {
  if (!goal) return null
  const name = (goal.constructor && goal.constructor.name) || ''
  // GoalNear keeps its range (idkcraft-neuc.21): `#goto x y z` is an exact
  // GoalBlock, and callers centre GoalNear on cells nobody can stand in
  // (one above the floor, a log, a chest) — Baritone answered noPath or
  // stopped beside it while v1 had long arrived. `#near` is the mod's own
  // verb for Baritone's GoalNear (same distSq <= r² test as isEnd; the
  // floored range never accepts a cell v1 would not).
  // GoalSeeTable (craft.tableGoal, g0z.40) is a GoalNear whose isEnd also
  // wants sight of the table; unmapped it answered noPath and every table
  // walk on v2 failed (neuc.50: castlefetch stairs "can't reach the crafting
  // table"). Baritone has no sight test, so the bridge picks the cell: the
  // standable cell nearest the body that the goal's own isEnd accepts
  // (range 3 + the eye ray), as an exact #goto. A plain #near stopped on
  // blind cells — a forest-floor table under leaves is seen from 2 away,
  // never from beside it (rig: table-unseeable, no pickaxe for 35 min).
  // No seeing cell known (unloaded, boxed in): #near 3, and the callers'
  // walk give-up fails it honestly (equip's tableFor then places its own).
  if (name === 'GoalSeeTable' && typeof goal.x === 'number' && typeof goal.y === 'number' && typeof goal.z === 'number') {
    return seeCellCmd(goal, from, blockAt) || `#near ${goal.x} ${goal.y} ${goal.z} 3`
  }
  if (name === 'GoalNear' && typeof goal.x === 'number' && typeof goal.y === 'number' &&
    typeof goal.z === 'number' && typeof goal.rangeSq === 'number' && goal.rangeSq >= 0) {
    return `#near ${goal.x} ${goal.y} ${goal.z} ${Math.floor(Math.sqrt(goal.rangeSq))}`
  }
  if ((name === 'GoalNear' || name === 'GoalBlock' || name === 'GoalGetToBlock') &&
    typeof goal.x === 'number' && typeof goal.y === 'number' && typeof goal.z === 'number') {
    return `#goto ${goal.x} ${goal.y} ${goal.z}`
  }
  if ((name === 'GoalXZ' || name === 'GoalNearXZ') && typeof goal.x === 'number' && typeof goal.z === 'number') {
    return `#goto ${goal.x} ${goal.z}`
  }
  if (name === 'GoalY' && typeof goal.y === 'number') {
    return `#goto ${goal.y}`
  }
  if (name === 'GoalFollow' && goal.entity) return followCmd(goal.entity.position, goal.rangeSq)
  if ((name === 'GoalCompositeAny' || name === 'GoalCompositeAll') && Array.isArray(goal.goals)) {
    for (const member of goal.goals) {
      const cmd = goalToBaritone(member, from, blockAt)
      if (cmd) return cmd
    }
    return null
  }
  if ((name === 'GoalPlaceBlock' || name === 'GoalLookAtBlock') && goal.pos && from) {
    const p = goal.pos
    if (typeof p.x !== 'number' || typeof p.y !== 'number' || typeof p.z !== 'number') return null
    if (typeof from.x !== 'number' || typeof from.y !== 'number' || typeof from.z !== 'number') return null
    const px = Math.floor(p.x)
    const py = Math.floor(p.y)
    const pz = Math.floor(p.z)
    const fx = Math.floor(from.x)
    const fy = Math.floor(from.y)
    const fz = Math.floor(from.z)
    const dx = fx - px
    const dz = fz - pz
    let nx = px
    let nz = pz
    if (dx === 0 && dz === 0) nx = px + 1 // above/below: deterministic side
    else if (Math.abs(dx) >= Math.abs(dz)) nx = px + Math.sign(dx)
    else nz = pz + Math.sign(dz)
    // Only a roof-height cell needs the climb: GoalBlock, Baritone pillars
    // like v1's executor does when no ground node is in range — unless the
    // cell IS our feet (degenerate range), which Baritone would answer
    // with silence. Anything else stands on the surface beside via GoalXZ
    // (v1 places rows 2-3 from the ground) — except our own column at any
    // level: GoalXZ counts any Y in it, so an in-goal #goto is answered
    // with silence. Both silence shapes fail visibly instead, never wedge.
    const range = (goal.options && typeof goal.options.range === 'number') ? goal.options.range
      : (typeof goal.reach === 'number' ? goal.reach : 4)
    if (py - fy > range - 1) {
      if (nx === fx && py === fy && nz === fz) return null
      return `#goto ${nx} ${py} ${nz}`
    }
    if (nx === fx && nz === fz) return null
    return `#goto ${nx} ${nz}`
  }
  return null
}

function nameForId(registry, kind, id) {
  if (!registry || typeof id !== 'number') return null
  const arr = registry[kind]
  if (Array.isArray(arr) && arr[id] && typeof arr[id].name === 'string') return arr[id].name
  const byName = registry[kind + 'ByName']
  if (byName && typeof byName === 'object') {
    for (const n of Object.keys(byName)) {
      if (byName[n] && byName[n].id === id) return n
    }
  }
  return null
}

// Movements flags -> Baritone `#set` values (idkcraft-neuc.4). Pure over
// (movements, registry); the adapter diffs the map and sends only changes.
// canOpenDoors has no setting (Baritone opens doors itself); blocksToAvoid
// is unmapped (a future bead can send Baritone's own blocksToAvoid);
// exclusionAreas* + danger.addPathCost wrap getNeighbors with function
// costs Baritone cannot express (danger's water discs cross per goal
// instead: _dangerAvoid, neuc.25). Empty lists are
// omitted (no `#set` spelling clears a list); both are non-empty whenever
// body.js runs (the scaffold set never reads empty, vmzq.29; chest is a
// default cant-break).
function movementsToSettings(m, registry) {
  if (!m || typeof m !== 'object') return {}
  const desired = {}
  if (typeof m.canDig === 'boolean') desired.allowBreak = String(m.canDig)
  if (typeof m.allowSprinting === 'boolean') desired.allowSprint = String(m.allowSprinting)
  if (typeof m.allowParkour === 'boolean') desired.allowParkour = String(m.allowParkour)
  if (typeof m.allow1by1towers === 'boolean') desired.allowPlace = String(m.allow1by1towers)
  if (m.scafoldingBlocks != null && typeof m.scafoldingBlocks[Symbol.iterator] === 'function') {
    const names = []
    for (const id of m.scafoldingBlocks) {
      const n = nameForId(registry, 'items', id)
      if (n) names.push(n)
    }
    if (names.length > 0) desired.acceptableThrowawayItems = names.join(',')
  }
  if (m.blocksCantBreak != null && typeof m.blocksCantBreak[Symbol.iterator] === 'function') {
    // The default set is chest + every undiggable block; Baritone needs no
    // telling about bedrock (it cannot break it), so only diggable names
    // cross — chest plus deliberate additions like gather's future
    // blueprint gate. Unknown ids stay protected (fail-safe).
    const byName = (registry && registry.blocksByName) || {}
    const names = []
    for (const id of m.blocksCantBreak) {
      const n = nameForId(registry, 'blocks', id)
      if (!n) continue
      const entry = byName[n]
      if (entry && entry.diggable === false) continue
      names.push(n)
    }
    // build.js's own-home guard (idkcraft-neuc.27): a per-cell cost Baritone
    // cannot express, so its block names are avoided everywhere while it is
    // installed — rig: GoalXZ approaches dug the fresh walls and rebuilt them
    // for 10+ min. ponytail: id-global; a box-scoped Baritone hook if v2 must
    // dig stray planks far from home.
    if (Array.isArray(m.exclusionAreasBreak)) {
      for (const fn of m.exclusionAreasBreak) {
        if (fn && Array.isArray(fn.guardNames)) {
          for (const n of fn.guardNames) if (!names.includes(n)) names.push(n)
        }
      }
    }
    if (names.length > 0) desired.blocksToAvoidBreaking = names.join(',')
  }
  // body.js's v2 castle guard (idkcraft-g0z.55): built-only castle kinds are
  // a hard ban (blocksToDisallowBreaking) — the avoid list above is a cost
  // a long detour outweighs.
  if (Array.isArray(m.exclusionAreasBreak)) {
    const ban = []
    for (const fn of m.exclusionAreasBreak) {
      if (fn && Array.isArray(fn.banNames)) {
        for (const n of fn.banNames) if (!ban.includes(n)) ban.push(n)
      }
    }
    if (ban.length > 0) desired.blocksToDisallowBreaking = ban.join(',')
  }
  return desired
}

class BaritoneBot extends EventEmitter {
  // transport: BridgeTransport (real mod) or FakeTransport (tests).
  // opts: { Vec3, registry, username, version, console:{host,port,send} }.
  constructor(transport, opts = {}) {
    super()
    this.transport = transport
    this.Vec3 = opts.Vec3 || MinimalVec
    this.registry = opts.registry || { blocksByName: {} }
    this.username = opts.username || 'IdkBody'
    this.version = opts.version || '26.1.2'
    this._console = opts.console || null

    this.entity = { position: new this.Vec3(0, 64, 0), velocity: new this.Vec3(0, 0, 0), yaw: 0, pitch: 0, onGround: true, height: 1.8, width: 0.6, eyeHeight: 1.62 }
    this.players = {}
    this.entities = {}
    this.health = 20
    this.food = 20
    this.oxygenLevel = 20
    this.time = {
      doDaylightCycle: null,
      bigTime: null,
      time: null,
      timeOfDay: null,
      day: null,
      isDay: null,
      moonPhase: null,
      bigAge: null,
      age: null,
    }
    this.game = { minY: -64, height: 384 } // overworld defaults; chunk.get refines (neuc.6)
    this.world = null // prismarine-world WorldSync, built lazily by chunks.ensureWorld
    this.isRaining = false
    this.isSleeping = false
    this.spawnPoint = new this.Vec3(0, 64, 0)
    this.heldItem = null
    this.targetDigBlock = null
    this.currentWindow = null

    this._goalId = null // live goal id from baritone.cmd; null = none or awaiting the echo
    this._cmdSeq = 0 // every baritone.cmd takes a sequence number ...
    this._boundSeq = 0 // ... and binds only when newer than this (stale replies drop)
    this._pathing = false // Baritone pathing for the CURRENT id (the setGoal latch)
    this._follow = null // dynamic GoalFollow re-issue arm { entity, x, y, z, at }
    this._settings = {} // last `#set` values pushed (name -> string)
    this._refreshing = false
    this._pathStatus = 'none'
    this._hasPos = false // first state.get with a non-null pos (createBot emits spawn on it)
    // idkcraft-neuc.20: out-of-world detection. The mod serves the null
    // snapshot once the client leaves the world (disconnect/kick), but the
    // ws stays up — without this the ticker keeps driving a body that is
    // at the menu forever and never rejoins. A sustained null pos past
    // the grace (respawn/dimension swaps flap briefly) ends the bot like
    // a dropped v1 connection: runOnce fatal()s, the container restarts,
    // and the handshake re-sends the console connect.
    this._leftWorldMs = typeof opts.leftWorldMs === 'number' ? opts.leftWorldMs : 3000
    this._outSince = null
    this._leftFired = false
    this._quitting = false
    this._poll = null
    this._onTransportEvent = (method, params) => this._handleEvent(method, params)

    const self = this
    this.pathfinder = {
      goal: null,
      movements: null,
      setGoal: (goal, dynamic) => self._setGoal(goal, dynamic === true),
      stop: () => self._stopPath(),
      // False while a mine owns the body (round-3 core-1): the mine parks
      // a marker as pathfinder.goal instead, which is what stopOnce/
      // clearGoal and the owner-switch cleanup read. Reading true here
      // would feed the stuck machine a still body every stone/scaffold
      // mine (the mine has its own 60 s stall).
      isMoving: () => !!self._pathing,
      isMining: () => false, // spike: single digs, no executor mining
      isBuilding: () => false,
      setMovements: (m) => { self.pathfinder.movements = m || null; self._pushSettings() },
      bestHarvestTool: (block) => self._bestHarvestTool(block),
      // No live callers (bring.js names it as a future upgrade path): a
      // sync noPath shaped like the A* result the site would read.
      getPathTo: (_movements, _goal, _timeout) => ({ status: 'noPath', path: [] }),
    }
    // idkcraft-neuc.8: bot.inventory/heldItem/equip/unequip/toss/tossStack/
    // setQuickBarSlot — defined here, before 'spawn', so reflexes'
    // installEquipGuard can wrap bot.equip (see inventory.js).
    installInventory(this)
    installLook(this) // idkcraft-neuc.9: look/lookAt/attack/activate*/consume/sleep/wake/waitForTicks
    installInput(this, transport) // neuc.13: setControlState/clearControlStates/controlState
    installLifecycle(this) // neuc.10: isAlive/foodSaturation/respawn()
    installWindows(this) // idkcraft-neuc.11: openContainer/openChest/openFurnace/currentWindow/clickWindow/closeWindow
    installInteract(this) // idkcraft-neuc.7: dig/stopDigging/targetDigBlock/placeBlock/swingArm — before 'spawn' (util.js wraps placeBlock)
    installMine(this) // idkcraft-neuc.53: bot.mine (v2 only; v1 never loads bridge/)
    installBuild(this) // idkcraft-neuc.54: buildCells over baritone.build
    installBuildStop(this) // idkcraft-neuc.54: stopBuild spelling of #stop
  }

  // mineflayer plugin host: the bridge body needs no plugins (runOnce calls
  // bot.loadPlugin(pathfinder) on every body).
  loadPlugin() {}

  // mineflayer quit: console disconnect, then 'end' with the reason (runOnce
  // resolves on 'end' when it asked for the quit, fatal()s otherwise).
  quit(reason = 'quit') {
    if (this._quitting) return
    this._quitting = true
    chunks.stopChunks(this)
    if (this._poll) clearInterval(this._poll)
    this._poll = null
    // neuc.13: release held controls before the transport goes away, so
    // the mod never keeps driving (or holding Baritone paused) for a body
    // nobody owns. Best-effort with a bounded wait: a dead transport must
    // not delay 'end' (runOnce resolves on it).
    const cleared = (async () => {
      try {
        this.clearControlStates()
        await Promise.race([this._flushInput(), sleep(500)])
      } catch (_) { /* release best-effort */ }
    })()
    const finish = () => {
      if (this.transport && typeof this.transport.close === 'function') {
        try { this.transport.close() } catch (_) { /* close best-effort */ }
      }
      this.emit('end', reason)
    }
    const disconnect = () => {
      const done = () => { cleared.then(finish, finish) }
      if (this._console && typeof this._console.send === 'function') {
        this._console.send('disconnect').catch(() => {}).then(done, done)
      } else {
        done()
      }
    }
    // idkcraft-neuc.20: cancel Baritone before the client leaves the
    // world, so no pathing process survives into the menu (its out-of-
    // world ticks NPE in Baritone's playerFeet). Bounded: a hung call
    // must not delay the disconnect past 1 s. The mod also cancels on
    // world unload, so this is belt and braces.
    if (this.transport && typeof this.transport.call === 'function') {
      const stopped = this.transport.call('baritone.cmd', { command: '#stop' }).catch(() => {})
      Promise.race([stopped, sleep(1000)]).then(disconnect, disconnect)
    } else {
      disconnect()
    }
  }

  async start({ pollMs = 100, connect = true } = {}) {
    if (connect && this.transport && typeof this.transport.connect === 'function') await this.transport.connect()
    if (this.transport && typeof this.transport.on === 'function') this.transport.on('event', this._onTransportEvent)
    await this._resetInput().catch(() => { /* best-effort; refresh still runs */ })
    await this.refresh()
    if (pollMs > 0) {
      this._poll = setInterval(() => {
        if (this._refreshing) return // a slow round skips, never piles up (revmux 01 core-2)
        this.refresh().catch(() => { /* poll best-effort; errors surface on demand calls */ })
      }, pollMs)
      if (typeof this._poll.unref === 'function') this._poll.unref()
    }
    return this
  }

  async stop() {
    chunks.stopChunks(this)
    if (this._poll) clearInterval(this._poll)
    this._poll = null
    if (this.transport && typeof this.transport.removeListener === 'function') {
      this.transport.removeListener('event', this._onTransportEvent)
    }
    if (this.transport && typeof this.transport.close === 'function') this.transport.close()
  }

  // One state round: entity/health/food + inventory + Baritone status +
  // the one-time chunk fill (neuc.6; afterwards block.update is steady
  // state and blockAt/findBlocks/raycast are sync local reads).
  async refresh() {
    this._refreshing = true
    try {
      await this._refreshOnce()
    } finally {
      this._refreshing = false
    }
    return this
  }

  // idkcraft-neuc.20: one null-pos poll. Only a sustained absence past
  // the grace ends the bot (see the constructor note); firing clears the
  // poll so no further bridge traffic drives the out-of-world client.
  _noteOutOfWorld() {
    if (!this._hasPos || this._quitting || this._leftFired) return
    const now = Date.now()
    if (this._outSince == null) this._outSince = now
    if (now - this._outSince < this._leftWorldMs) return
    this._leftFired = true
    if (this._poll) clearInterval(this._poll)
    this._poll = null
    this.emit('end', 'bridge: left world (client disconnected)')
  }

  // idkcraft-neuc.21: mineflayer's respawn:true parity. A dead client sits
  // on the death screen with its pos frozen — every goal, sidestep and
  // hop then reads no-progress forever (a wedge). Death edge -> 'death',
  // then click respawn (re-sent at most 1/s while still dead); the first
  // live poll after it -> 'respawn' (index.js lifecycle pairs the two).
  _noteLife(health) {
    if (health > 0) {
      this.isAlive = true // neuc.10: mirror mineflayer's isAlive alongside _dead
      if (this._dead) {
        this._dead = false
        this.emit('respawn')
      }
      return
    }
    this.isAlive = false
    if (!this._dead) {
      this._dead = true
      this.emit('death')
    }
    const now = Date.now()
    if (now - (this._respawnAt || 0) < 1000) return
    this._respawnAt = now
    this.transport.call('respawn', {}).catch(failLog)
  }

  async _refreshOnce() {
    const prevPos = this._hasPos && this.entity && this.entity.position
      ? { x: this.entity.position.x, y: this.entity.position.y, z: this.entity.position.z } : null
    const st = await this.transport.call('state.get', {})
    if (!st || !st.pos) this._noteOutOfWorld()
    if (st && st.pos) {
      this._outSince = null
      this._hasPos = true
      this.entity.position.x = st.pos.x
      this.entity.position.y = st.pos.y
      this.entity.position.z = st.pos.z
      if (typeof st.pos.yaw === 'number') this.entity.yaw = st.pos.yaw
      if (typeof st.pos.pitch === 'number') this.entity.pitch = st.pos.pitch
      if (typeof st.pos.onGround === 'boolean') this.entity.onGround = st.pos.onGround
      // neuc.25: mineflayer physics flags; without them the breath reflex never fires on v2.
      if (typeof st.pos.inWater === 'boolean') this.entity.isInWater = st.pos.inWater
      if (typeof st.pos.inLava === 'boolean') this.entity.isInLava = st.pos.inLava
      this._digging = st.pos.digging === true // neuc.30: a break in progress holds the stall re-plan
      const vel = st.pos.vel
      if (vel && typeof vel.x === 'number' && typeof vel.y === 'number' && typeof vel.z === 'number') {
        this.entity.velocity.x = vel.x
        this.entity.velocity.y = vel.y
        this.entity.velocity.z = vel.z
      }
    }
    if (st && typeof st.health === 'number') {
      this.health = st.health
      this._noteLife(st.health)
    }
    if (st && typeof st.food === 'number') this.food = st.food
    if (st && typeof st.saturation === 'number') this.foodSaturation = st.saturation
    if (st && typeof st.oxygen === 'number') this.oxygenLevel = st.oxygen
    if (st && st.time && typeof st.time === 'object') {
      const t = st.time
      if (typeof t.age === 'number') {
        this.time.age = t.age
        if (Number.isInteger(t.age)) this.time.bigAge = BigInt(t.age)
      }
      if (typeof t.timeOfDay === 'number') this.time.timeOfDay = t.timeOfDay
      if (typeof t.day === 'number') {
        this.time.day = t.day
        this.time.moonPhase = t.day % 8
      }
      if (typeof t.isDay === 'boolean') this.time.isDay = t.isDay
      if (typeof this.time.timeOfDay === 'number' && typeof this.time.day === 'number') {
        this.time.time = this.time.day * 24000 + this.time.timeOfDay
        this.time.bigTime = BigInt(this.time.time)
      }
    }
    if (st && st.spawn && typeof st.spawn.x === 'number' && typeof st.spawn.y === 'number' && typeof st.spawn.z === 'number') {
      this.spawnPoint = new this.Vec3(st.spawn.x, st.spawn.y, st.spawn.z)
    }
    if (st && typeof st.isRaining === 'boolean') this.isRaining = st.isRaining
    if (st && typeof st.isSleeping === 'boolean') this.isSleeping = st.isSleeping
    if (st && st.input && st.input.states) this._syncInputFromState(st.input.states) // neuc.13: mod-reported held states
    if (st && typeof st.dimension === 'string' && st.dimension) this.game.dimension = stripMcPrefix(st.dimension)
    if (st && st.gameMode !== undefined && st.gameMode !== null) this.game.gameMode = gameModeName(st.gameMode)
    try {
      const inv = await this.transport.call('inventory.get', {})
      if (inv) applyInventory(this, inv) // idkcraft-neuc.8: full snapshot per round
    } catch (_) { /* inventory best-effort per round */ }
    try {
      await refreshEntities(this, this.transport) // idkcraft-neuc.3: one entities.list+roster.get per round
    } catch (_) { /* entities best-effort per round */ }
    try {
      await chunks.refreshChunks(this, this.transport) // idkcraft-neuc.6: initial chunk fill (near first, rest background)
    } catch (_) { /* chunks best-effort per round */ }
    try {
      // Goal-id attribution (idkcraft-neuc.4): a status is ours only when
      // its id is the latched one. Anything else — older, foreign, or
      // arriving while no goal is live (setGoal/stop invalidate
      // synchronously) — drops. pathing:false with a verdict completes the
      // goal exactly once: the cleared latch drops the second channel
      // (poll or pushed event). pathing:false + last none means still
      // calculating: hold the setGoal latch, stay silent — synthesising a
      // verdict re-issues follow.js every tick and the body never moves
      // (the spike's lesson, kept).
      const bs = await this.transport.call('baritone.status', {})
      if (bs && typeof bs === 'object' && bs.id != null && bs.id === this._goalId) {
        if (bs.pathing) {
          this._pathing = true
        } else if (bs.last !== 'none' && bs.last != null && !(this._pausedDepth > 0)) {
          // While a bridge pause is outstanding (neuc.9 withBaritonePaused)
          // pathing reads false; a verdict waits for the post-resume poll.
          this._completeTerminal(bs.last)
        }
      }
    } catch (_) { /* status best-effort per round */ }
    this._maybeReissueFollow()
    this._stallReplan()
    // neuc.10: poll-cadence event synthesis. physicsTick every in-world
    // round (doors.doorShutFast throttles to 250 ms itself); move (with
    // the previous position, mineflayer's shape) when the position
    // changed; forcedMove on a teleport-sized jump (> 8 blocks).
    if (st && st.pos && this._hasPos) {
      this._lifecycleEnded = false // in world again: a future end may fire
      const p = this.entity.position
      if (prevPos && (p.x !== prevPos.x || p.y !== prevPos.y || p.z !== prevPos.z)) {
        this.emit('move', new this.Vec3(prevPos.x, prevPos.y, prevPos.z))
        if (Math.hypot(p.x - prevPos.x, p.y - prevPos.y, p.z - prevPos.z) > 8) this.emit('forcedMove')
      }
      this.emit('physicsTick')
    }
  }

  // Load the columns holding coords the logic is about to read
  // (chunk.get snapshots, neuc.6 — the spike's N+1 block.get is gone).
  async prefetch(coords) {
    for (const c of coords || []) {
      const cx = Math.floor(c.x / 16)
      const cz = Math.floor(c.z / 16)
      const key = `${cx},${cz}`
      if (this._chunkCols && this._chunkCols.has(key)) continue
      try {
        const payload = await this.transport.call('chunk.get', { cx, cz })
        if (payload) chunks.applyChunk(this, payload)
      } catch (_) { /* unloaded stays unloaded: blockAt reads null */ }
    }
    return this
  }

  // Sync world reads (neuc.6): prismarine-world over the chunk cache.
  // Misses read null (unloaded), exactly like mineflayer.
  blockAt(pos, _extraInfos) {
    const world = chunks.ensureWorld(this)
    if (!world || !pos || typeof pos.x !== 'number') return null
    try { return world.getBlock(pos) } catch (_) { return null }
  }

  findBlocks(options) { return chunks.findBlocks(this, options) }
  findBlock(options) { return chunks.findBlock(this, options) }
  canSeeBlock(block) { return chunks.canSeeBlock(this, block) }
  blockInSight(block) { return this.canSeeBlock(block) }

  // mineflayer canDigBlock: diggable and within eye reach (5.1 from the
  // eye point to the block centre); liquids and unbreakables excluded
  // (their digTime is Infinity on v1, so dig() would throw there too).
  canDigBlock(block) {
    if (!block || !block.diggable) return false
    if (block.name === 'air' || block.name === 'bedrock' ||
      block.name === 'water' || block.name === 'flowing_water' ||
      block.name === 'lava' || block.name === 'flowing_lava') return false
    if (typeof block.hardness === 'number' && block.hardness < 0) return false
    try {
      const eye = this.entity.position.offset(0, 1.65, 0)
      return block.position.offset(0.5, 0.5, 0.5).distanceTo(eye) <= 5.1
    } catch (_) {
      return true // no usable geometry (unit fakes): diggability decided it
    }
  }

  chat(message) {
    // mineflayer chat is fire-and-forget; the promise must never throw synchronously.
    // A failed call logs, never emits 'error': runOnce fatal()s every 'error'
    // (process exit), and a timed-out chat.send on a live socket is not a
    // dead connection (revmux 01 core-2).
    for (const part of chatParts(message)) {
      this.transport.call('chat.send', { message: part }).catch((e) => {
        console.log(`bridge chat.send failed: ${(e && e.message) || e}`)
      })
    }
  }

  _setGoal(goal, dynamic) {
    this.pathfinder.goal = goal || null
    this._follow = null
    // A new goal supersedes a live mine (round-1 body-2/core-2): the mine
    // walks Baritone itself, outside the path latch, so an owner stop or a
    // step change would otherwise leave it mining forever.
    cancelMine(this)
    if (!goal) {
      this._stopPath()
      return
    }
    // Already there (revmux 01 core-1/2): v1 ends at once when
    // goal.isEnd(start), while Baritone's setGoalAndPath returns before
    // CALC_STARTED with no PathEvent for an in-goal #goto — the mod would
    // hold last:'none' (or a lone CANCELED) and the latch would never
    // clear. Succeed without a command, stopping the live walk first
    // like every other setGoal.
    // neuc.25: arm a dynamic GoalFollow BEFORE the in-range shortcut. v1
    // keeps a dynamic goal live after arrival (pathfinder re-plans on
    // goal.hasChanged), so a mob knocked back out of reach is chased at
    // once; a fight that starts in range must arm too, or the body stands
    // still until fight.js's 6-tick retry while the mob hits it.
    const arm = this._followArm(goal, dynamic)
    if (this._satisfiedNow(goal)) {
      this._follow = arm
      // A live builder counts as live (round-2 core-3): an in-reach goal
      // sends no walk, so without this no #stop cancels the builder.
      const live = this._pathing || this._goalId != null || this._build != null
      this._boundSeq = this._cmdSeq
      this._goalId = null
      this._pathing = false
      if (live) {
        if (this._build) this._build.preempted = true
        this.transport.call('baritone.cmd', { command: '#stop' }).catch(failLog)
      }
      this._completeTerminal('success')
      return
    }
    const cmd = goalToBaritone(goal, this.entity.position, (x, y, z) => this.blockAt(new this.Vec3(x, y, z)))
    if (!cmd) {
      // No Baritone mapping: stop the live walk (mineflayer's setGoal
      // always resets first) and fail like the executor would.
      const live = this._pathing || this._goalId != null || this._build != null
      this._boundSeq = this._cmdSeq
      this._goalId = null
      this._pathing = false
      if (live) {
        if (this._build) this._build.preempted = true
        this.transport.call('baritone.cmd', { command: '#stop' }).catch(failLog)
      }
      this._pathStatus = 'noPath'
      this.emit('path_update', { status: 'noPath' })
      this.emit('path_reset', 'noPath')
      return
    }
    this._pathStatus = 'none'
    // The lease mutates the Movements object between goals (body.js
    // movementsFor), so flags re-push on every goal; the diff keeps the
    // cmd stream quiet.
    this._pushSettings()
    this._boundSeq = this._cmdSeq // older in-flight binds drop on reply
    this._goalId = null // awaiting the echo; foreign ids drop meanwhile
    this._pathing = true // optimistic latch: follow.js re-issues on !isMoving
    this._sendGoalCmd(cmd)
    this._follow = arm
  }

  _followArm(goal, dynamic) {
    const p = dynamic && goal.entity && goal.entity.position
    if (!p || typeof p.x !== 'number' || typeof p.y !== 'number' || typeof p.z !== 'number') return null
    const rangeSq = typeof goal.rangeSq === 'number' ? goal.rangeSq : 0
    return { entity: goal.entity, x: p.x, y: p.y, z: p.z, at: Date.now(), rangeSq }
  }

  // The goal's own verdict on the live feet, defaulting to "walk" on any
  // doubt (missing/worldless isEnd must never fail a goal by itself).
  // Worldless place/look one step away count as satisfied: in range by
  // construction, and the walk alternative targets the live feet where
  // Baritone answers with no PathEvent — success here, the place/look
  // attempt validates. A clean isEnd=false is honoured (walk or visible
  // noPath), and feet==p / p-at-head are excluded like v1's
  // isStandingIn: v1 steps out first, so do we.
  _satisfiedNow(goal) {
    try {
      if (!goal) return false
      const p = this.entity && this.entity.position
      if (!p || typeof p.x !== 'number' || typeof p.y !== 'number' || typeof p.z !== 'number') return false
      const feet = typeof p.floored === 'function' ? p.floored() : { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) }
      let worldless = true
      if (typeof goal.isEnd === 'function') {
        try {
          if (goal.isEnd(feet) === true) return true
          worldless = false
        } catch (_) { /* worldless isEnd: adjacency decides below */ }
      }
      if (!worldless) return false
      const name = goal.constructor && goal.constructor.name
      if ((name === 'GoalPlaceBlock' || name === 'GoalLookAtBlock') && goal.pos &&
        typeof goal.pos.x === 'number' && typeof goal.pos.y === 'number' && typeof goal.pos.z === 'number' &&
        typeof feet.x === 'number' && typeof feet.y === 'number' && typeof feet.z === 'number') {
        const dx = Math.floor(goal.pos.x) - feet.x
        const dy = Math.floor(goal.pos.y) - feet.y
        const dz = Math.floor(goal.pos.z) - feet.z
        if (Math.abs(dx) + Math.abs(dy) + Math.abs(dz) === 1 && !(dx === 0 && dy === 1 && dz === 0)) return true
      }
      return false
    } catch (_) {
      return false
    }
  }

  // Goal command with id binding: the echoed id latches only when this
  // send is still the newest (a superseding setGoal/stop invalidates via
  // _boundSeq, overlapping follow re-issues order by seq). Failures log,
  // never emit 'error' (runOnce fatal()s every 'error'; see chat()).
  _sendGoalCmd(command) {
    // A new goal preempts a live builder on the Baritone side without any
    // #stop going out (round-3 core-2): mark it, so the idle final rejects
    // 'build-preempted' instead of settling starved.
    if (this._build) this._build.preempted = true
    this._goalCmd = command // neuc.13: last goal cmd (diagnostics; pause/resume keeps the id, no re-issue)
    const seq = (this._cmdSeq = (this._cmdSeq | 0) + 1)
    // idkcraft-neuc.48: never path-start inside a closed door cell. The
    // body sometimes ends up standing in the doorway with the panel shut
    // around it (DOOR-ROOM ~1 in 4), and Baritone CALC_FAILEDs every
    // re-plan out of the closed cell while nothing ever re-opens it:
    // bot.activateBlock is a deliberate no-op for doors while pathing
    // (neuc.9 landmine) and doors.js's opener needs a plan window v2 never
    // fills. The kick runs first; the goal follows on its heels.
    const wedge = this._doorKickCell()
    if (!wedge) {
      this._sendGoalCmdNow(command, seq)
      return
    }
    void (async () => {
      await this._doorKickOpen(wedge)
      if (seq <= this._boundSeq) return // superseded/stopped mid-kick: stay stopped, never revive the walk
      this._sendGoalCmdNow(command, seq)
    })()
  }

  // The closed hand-door cell around the feet, or null. Sync (blockAt is a
  // local cache read), so a wedgeless _sendGoalCmd keeps its exact timing.
  // Iron doors never kick (no hand toggle exists); an open or unreadable
  // cell never kicks either (fail closed, like doorEdge).
  _doorKickCell() {
    try {
      const p = this.entity && this.entity.position
      if (!p || typeof p.x !== 'number' || typeof p.y !== 'number' || typeof p.z !== 'number') return null
      const x = Math.floor(p.x)
      const y = Math.floor(p.y)
      const z = Math.floor(p.z)
      const key = `${x},${y},${z}`
      if (this._doorKickKey === key && Date.now() - (this._doorKickAt || 0) < DOOR_KICK_COOLDOWN_MS) return null
      const feet = this.blockAt(new this.Vec3(x, y, z))
      if (!feet || typeof feet.name !== 'string') return null
      if (!feet.name.endsWith('_door') || feet.name.includes('iron')) return null
      let props = null
      try { props = typeof feet.getProperties === 'function' ? feet.getProperties() : null } catch (_) { return null }
      if (!props || props.open === true) return null
      return { x, y, z }
    } catch (_) {
      return null
    }
  }

  // Re-open the wedged panel, then the caller sends the goal: Baritone
  // plans from an open doorway instead of CALC_FAILEDing out of a closed
  // one. A direct transport call, never bot.activateBlock — the stall
  // re-plan kicks while still pathing, where that helper no-ops.
  // Best-effort: a refused click still sends the goal (the next re-plan
  // retries past the cooldown), and nothing here ever throws.
  async _doorKickOpen(cell) {
    try {
      if (!this.transport || !cell) return
      this._doorKickKey = `${cell.x},${cell.y},${cell.z}`
      this._doorKickAt = Date.now()
      await withBaritonePaused(this, () => this.transport.call('interact.block', {
        x: cell.x, y: cell.y, z: cell.z, face: 'up', cursor: { x: 0.5, y: 0.5, z: 0.5 }, sneak: false,
      }))
      console.log(`bridge door kick at ${cell.x} ${cell.y} ${cell.z}`)
    } catch (_) { /* best-effort */ }
  }

  _sendGoalCmdNow(command, seq) {
    const avoid = this._dangerAvoid(command)
    this.transport.call('baritone.cmd', avoid ? { command, avoid } : { command }).then(
      (r) => {
        if (seq <= this._boundSeq) return
        this._boundSeq = seq
        if (!r || r.id == null) {
          this._goalFailed() // tracked by nobody: fail, don't wedge isMoving
          console.log('bridge baritone.cmd failed: no goal id echoed')
          return
        }
        this._goalId = r.id
      },
      (e) => {
        if (seq <= this._boundSeq) return
        this._boundSeq = seq
        this._goalFailed()
        failLog(e)
      },
    )
  }

  // Water-death discs (idkcraft-neuc.25) for the goal command: v1's
  // danger.addPathCost wraps getNeighbors, which Baritone never calls, so
  // v2 walked straight through the drowned shore (rig DROWNED-SHORE). The
  // live discs ride the command as [[x, z, lim]] (same feet/goal ring
  // shrink as v1); the mod wraps the goal with a heuristic penalty inside
  // them. Null when none apply (the wire stays {command}).
  _dangerAvoid(command) {
    try {
      const m = this.pathfinder && this.pathfinder.movements
      if (!m || typeof m.dangerDiscs !== 'function') return null
      const discs = m.dangerDiscs(this.entity && this.entity.position, cmdXZ(command))
      const out = []
      for (const d of discs || []) if (d && d.lim > 0) out.push([d.x, d.z, d.lim])
      return out.length > 0 ? out : null
    } catch (_) { return null }
  }

  _goalFailed() {
    this._goalId = null
    this._follow = null
    this._pathing = false
    this._pathStatus = 'noPath'
    this.emit('path_update', { status: 'noPath' })
    this.emit('path_reset', 'noPath')
  }

  // Attributed terminal for the live goal: idle the latch, verdict the
  // ticker pair exactly once (the cleared id drops the second channel).
  // Unknown verdicts fail as timeout (retry-safe); success is never
  // synthesised — only the mod's own word arrives here.
  _completeTerminal(last) {
    const status = last === 'noPath' || last === 'timeout' || last === 'stopped' || last === 'success' ? last : 'timeout'
    this._goalId = null
    if (status !== 'success') this._follow = null // neuc.25: a reached dynamic goal stays armed (v1 parity)
    this._pathing = false
    this._pathStatus = status
    this.emit('path_update', { status })
    this.emit('path_reset', status === 'success' ? 'goal reached' : status)
  }

  // Dynamic GoalFollow mid-walk refresh (idkcraft-neuc.4): follow.js only
  // re-issues on terminal/timeout, so a walking player outruns the
  // one-shot #near. Re-command when the live target left the commanded
  // spot by > 1 block, at most one cmd/s. Silent: no ticker events — the
  // new echo rebinds the latch and the old id's late verdicts drop.
  _maybeReissueFollow() {
    const f = this._follow
    if (!f) return
    const p = f.entity && f.entity.position
    if (!p || typeof p.x !== 'number' || typeof p.y !== 'number' || typeof p.z !== 'number') return
    if (f.entity.isValid === false) return
    const idle = this._goalId == null && !this._pathing
    if (idle) {
      // neuc.25: reached (armed, idle). v1's GoalFollow re-plans once the
      // target leaves range of the bot's feet (hasChanged + isEnd), so do
      // the same: a knocked-back mob or a stepping player is re-chased.
      const b = this.entity && this.entity.position
      if (!b || typeof b.x !== 'number') return
      const dx = Math.floor(p.x) - Math.floor(b.x)
      const dy = Math.floor(p.y) - Math.floor(b.y)
      const dz = Math.floor(p.z) - Math.floor(b.z)
      if (dx * dx + dy * dy + dz * dz <= f.rangeSq) return
    } else {
      if (this._goalId == null) return // awaiting the echo
      if (Math.hypot(p.x - f.x, p.y - f.y, p.z - f.z) <= 1) return
    }
    const now = Date.now()
    if (now - f.at < 1000) return
    if (idle) this._pathing = true // a fresh walk: isMoving like v1's re-plan
    f.x = p.x
    f.y = p.y
    f.z = p.z
    f.at = now
    this._pushSettings()
    // The re-issue supersedes the live goal exactly like a setGoal: drop
    // the old id now, so a late terminal for it cannot clear the arm or
    // verdict a goal Baritone no longer runs. The arm (_follow) and the
    // motion latch (_pathing) stay: Baritone never stopped walking.
    this._boundSeq = this._cmdSeq
    this._goalId = null
    this._sendGoalCmd(followCmd(p, f.rangeSq))
  }

  // Stall re-plan (idkcraft-neuc.30): mineflayer-pathfinder resets a path
  // with 'stuck' when the next node takes > 3.5 s and re-plans from where
  // the body stands; Baritone can hang inside one movement with the goal
  // live and no PathEvent (rig JR-BUILD: a place approach's GoalXZ on the
  // partition column, pathing:true, body still 30 s), so isMoving read
  // true forever and the backstop's recover episode gave up. First stall:
  // the same goal re-sent from the live feet plus v1's 'stuck' reset
  // (stuck.js counts it). Still again (the rig re-plan re-hung 2/2): the
  // walk is unexecutable — stop Baritone and verdict noPath, so the owner
  // acts like on any terminal (build places from where it stands, follow
  // re-issues). Bridge-only: v1 never loads this file. Progress reads like
  // stuck.js progressed(): horizontal past the tolerance or a grounded
  // floor change, so a jump apex or a water bob is not motion; a block
  // break in progress (the mod's digging flag — Baritone mines inside a
  // movement, barehand stone ~7.5 s a block) holds the clock like v1's dig
  // hold. ponytail: 10 s still, not v1's 3.5 s — Baritone's own place and
  // door waits stay inside it; a stall still owned by stuck.js's backstop.
  _stallReplan() {
    const p = this.entity && this.entity.position
    const live = this._pathing && this._goalCmd && !(this._pausedDepth > 0) &&
      !Object.values(this.controlState || {}).some(Boolean)
    if (!live || !p || typeof p.x !== 'number') { this._stall = null; return }
    const now = Date.now()
    const s = this._stall
    const moved = !!s && (Math.hypot(p.x - s.x, p.z - s.z) > STALL_MOVE ||
      (this.entity.onGround !== false && Math.floor(p.y) !== Math.floor(s.y)))
    if (!s || s.cmd !== this._goalCmd || moved) {
      this._stall = { x: p.x, y: p.y, z: p.z, at: now, cmd: this._goalCmd, replans: 0 }
      return
    }
    if (this._digging) { s.at = now; return }
    if (now - s.at < STALL_MS) return
    const secs = Math.round((now - s.at) / 1000)
    this._boundSeq = this._cmdSeq // the old id's late verdict drops, like a follow re-issue
    if (s.replans >= 1) {
      console.log(`bridge stall noPath ${this._goalCmd} after ${secs} s still (re-plan hung too)`)
      this._stall = null
      this.transport.call('baritone.cmd', { command: '#stop' }).catch(failLog)
      this._completeTerminal('noPath')
      return
    }
    console.log(`bridge stall re-plan ${this._goalCmd} after ${secs} s still`)
    s.at = now
    s.replans++
    this._goalId = null
    this._sendGoalCmd(this._goalCmd)
    this.emit('path_reset', 'stuck')
  }

  // Diffed Movements -> `#set` push (idkcraft-neuc.4): installed flags on
  // setMovements, lease-mutated flags on every setGoal. First push sends
  // every mapped setting absolutely (the image settings.txt is the
  // baseline only until then); afterwards only changes cross, so the cmd
  // stream stays quiet. A failed send unmarks for retry on the next push.
  _pushSettings() {
    if (!this.transport) return
    const desired = movementsToSettings(this.pathfinder.movements, this.registry)
    for (const k of Object.keys(desired)) {
      // A live mine owns break-policy for the call (neuc.53 rig evidence):
      // the mod suspends the ban/avoid for the mine's blocks at begin and
      // restores at end; a lease re-push mid-mine would re-ban targets and
      // starve it back into 60 s stalls. Skipped keys wait for the next
      // push after settle (a mid-mine lease flip heals on the next goal).
      if (k === 'allowBreak' || k === 'blocksToAvoidBreaking' || k === 'blocksToDisallowBreaking') {
        const m = this._mine
        if (m && !m.settled) continue
      }
      if (this._settings[k] === desired[k]) continue
      this._settings[k] = desired[k]
      this.transport.call('baritone.cmd', { command: `#set ${k} ${desired[k]}` }).catch((e) => {
        if (this._settings[k] === desired[k]) delete this._settings[k]
        console.log(`bridge #set ${k} failed: ${(e && e.message) || e}`) // never 'error': see chat()
      })
    }
  }

  // mineflayer-pathfinder's bestHarvestTool, mirrored: lowest digTime over
  // the pack. Null until the world (.6) and inventory (.8) surfaces fill
  // in — cache records grow digTime, items grow type. Enchantments read
  // empty (prismarine-nbt is not a direct dep): an enchanted tool may lose
  // the ranking, the dig still works.
  _bestHarvestTool(block) {
    try {
      if (!block || typeof block.digTime !== 'function') return null
      const items = this.inventory.items()
      if (!Array.isArray(items) || items.length === 0) return null
      const effects = this.entity && this.entity.effects
      let fastest = Number.MAX_VALUE
      let best = null
      for (const tool of items) {
        const t = block.digTime(tool ? tool.type : null, false, false, false, [], effects)
        if (typeof t === 'number' && t < fastest) {
          fastest = t
          best = tool
        }
      }
      return best
    } catch (_) {
      return null
    }
  }

  _stopPath() {
    // A live builder counts as live (core-4): #stop cancels it like any
    // other process, so a step change, fight, or follow that stops pathing
    // never leaves BuilderProcess steering an unowned body. Our own #stop
    // preempts our own build (round-3 core-2): the final rejects
    // 'build-preempted' instead of settling starved. A live mine counts
    // too (neuc.53): cancelMine below sends the #stop for it.
    const live = this._pathing || this._goalId != null || (this._mine && !this._mine.settled) || this._build != null
    this.pathfinder.goal = null
    this._follow = null
    this._boundSeq = this._cmdSeq // in-flight binds and late verdicts drop
    this._goalId = null
    this._pathing = false
    if (!live) return // mineflayer's stop is silent when idle
    this._pathStatus = 'stopped'
    // A #stop preempts our own build (round-3 core-2): mark it so its end
    // settles build-preempted instead of starved — including the #stop
    // cancelMine sends for a live mine, which cancels the build mod-side
    // too. cancelMine sends the #stop itself when a live mine was holding
    // the body (the behaviour gen guards drop its mine-stopped settle);
    // otherwise one #stop goes out here.
    if (this._build) this._build.preempted = true
    if (!cancelMine(this)) {
      this.transport.call('baritone.cmd', { command: '#stop' }).catch((e) => {
        console.log(`bridge baritone.cmd #stop failed: ${(e && e.message) || e}`) // never 'error': see chat()
      })
    }
    // v1 emits path_stop here (unheard by our ticker); the reset makes the
    // cancel visible on the same taps as every other terminal.
    this.emit('path_reset', 'stopped')
  }

  // idkcraft-neuc.33: mineflayer applies chunk packets before a later chat
  // packet, so an order sees the terrain streamed ahead of it. Here columns
  // arrive by async chunk.get after their chunk.loaded: an order right after
  // a teleport/respawn read a half-empty cache ('no home yet' in 1 s). Chat
  // waits, in arrival order, while columns around the body are still
  // pending — capped, so a stalled fetch never swallows an order. Nothing
  // pending = delivered synchronously, as before.
  _holdChat(p) {
    const q = this._chatHeld || (this._chatHeld = [])
    q.push(p)
    if (q.length > 1) return // a flush is already waiting; keep the order
    const deadline = Date.now() + CHAT_HOLD_MS
    const flush = () => {
      if (!this._quitting && Date.now() < deadline && chunks.nearPending(this)) {
        const t = setTimeout(flush, 50)
        if (typeof t.unref === 'function') t.unref()
        return
      }
      for (const m of q.splice(0)) {
        // mineflayer 'chat' is (username, message); 'message' carries a
        // ChatMessage. index.js:1485 reads (msg, position, senderUuid).
        this.emit('chat', m.username || '', m.message || '')
        this.emit('message', { text: m.message || '', toString: () => String(m.message || '') }, m.position || 'chat', m.uuid || null)
      }
    }
    flush()
  }

  _handleEvent(method, params) {
    if (chunks.handleChunkEvent(this, this.transport, method, params)) return // idkcraft-neuc.6: chunk.loaded/unloaded, block.update
    if (handleInventoryEvent(this, method, params)) return // idkcraft-neuc.8: inventory.update
    if (handleBridgeEvent(this, method, params)) return // idkcraft-neuc.3: player.joined/left, entity.gone
    if (handleLookEvent(this, method, params)) return // idkcraft-neuc.9: sleep/wake
    if (handleLifecycleEvent(this, method, params)) return // idkcraft-neuc.10: death/respawn/health/…/kicked/end
    if (handleWindowEvent(this, method, params)) return // idkcraft-neuc.11: window.open/slot/close
    if (handleInteractEvent(this, method, params)) return // idkcraft-neuc.7: dig.progress/done/abort
    if (handleMineEvent(this, method, params)) return // idkcraft-neuc.53: baritone.event kind mine
    if (handleBuildEvent(this, method, params)) return // idkcraft-neuc.54: build progress/end
    const p = params || {}
    switch (method) {
      case 'chat':
        this._holdChat(p)
        break
      case 'baritone.event':
        // Pushed Baritone PathEvent, id-attributed like the poll: foreign
        // ids (a superseded goal, a stop echo) drop; unknown verdicts stay
        // for the poll to resolve (an event alone never proves idleness).
        if (p.id == null || p.id !== this._goalId) break
        if (p.status === 'noPath' || p.status === 'timeout' || p.status === 'stopped' || p.status === 'success') {
          this._completeTerminal(p.status)
        }
        break
      case 'body.stats': // neuc.67: the body JVM once a minute (Stats.java) — the prod GC read
        console.log(`body.stats heap=${p.heapUsedMb}/${p.heapMaxMb}MB gc=${p.gcCount}x${p.gcMs}ms maxTickGap=${p.maxTickGapMs}ms maxPush=${p.maxPushMs}ms chunks=${p.chunks} entities=${p.entities} rpc=[${p.rpc ?? ''}] rtt=[${typeof this.transport.takeRtt === 'function' ? this.transport.takeRtt() : ''}]`) // neuc.67.1: mod handler ms vs Node round trip per method
        break
      default:
        this.emit(method, p)
        break
    }
  }
}

// Console-line sender (worker.js send() shape, bridge-local: bridge/ must
// not require bot/src): connect, one line + '\n', end. Never throws, never
// rejects; resolves true only when the line flushed.
function sendConsoleLine({ host, port, line, timeoutMs = 5000 }) {
  return new Promise((resolve) => {
    let sock = null
    let settled = false
    const done = (ok) => {
      if (settled) return
      settled = true
      try { if (sock) sock.destroy() } catch (_) { /* already gone */ }
      resolve(ok)
    }
    try {
      sock = net.connect({ host, port })
      sock.setTimeout(timeoutMs)
      sock.once('connect', () => {
        try { sock.end(String(line) + '\n', () => done(true)) } catch (_) { done(false) }
      })
      sock.once('timeout', () => done(false))
      sock.once('error', () => done(false))
      sock.once('close', () => done(false))
    } catch (_) {
      done(false)
    }
  })
}

// mineflayer.createBot-shaped factory for runOnce: returns the BaritoneBot
// synchronously (mineflayer contract — runOnce calls loadPlugin on it
// before the first await), then handshakes in the background and emits
// 'login' + 'spawn' once the client is really on the server. Handshake
// failures surface as 'error' (runOnce fatal()s → container restart =
// reconnect, same as v1). inj = test seams only { transport, consoleSend }.
function createBot(opts = {}, inj = {}) {
  const Vec3 = require('vec3')
  const host = opts.host || 'mc'
  const port = opts.port || 25565
  const bridgeHost = process.env.BRIDGE_HOST || 'body2'
  const rawBridgePort = parseInt(process.env.BRIDGE_PORT || '7778', 10)
  const bridgePort = Number.isFinite(rawBridgePort) ? rawBridgePort : 7778
  const rawConsolePort = parseInt(process.env.BRIDGE_CONSOLE_PORT || '7777', 10)
  const consolePort = Number.isFinite(rawConsolePort) ? rawConsolePort : 7777
  const transport = (inj && inj.transport) || new BridgeTransport(`ws://${bridgeHost}:${bridgePort}/rpc`)
  const consoleSend = (inj && inj.consoleSend) || ((line) => sendConsoleLine({ host: bridgeHost, port: consolePort, line }))
  const bot = new BaritoneBot(transport, {
    Vec3,
    username: opts.username || 'IdkBody',
    console: { host: bridgeHost, port: consolePort, send: consoleSend },
  })
  // Socket close/error while not quitting: 'end'/'error' like a dropped v1
  // connection (runOnce fatal()s → container restart = reconnect).
  transport.on('close', () => { if (!bot._quitting) bot.emit('end', 'bridge closed') })
  transport.on('error', (err) => { if (!bot._quitting) bot.emit('error', err instanceof Error ? err : new Error(`bridge: ${err}`)) })
  // Deadline for the first joined state (step 4): past the ~60 s
  // HeadlessMC boot with margin; inj.posTimeoutMs overrides it in tests.
  const rawPosTimeout = (inj && inj.posTimeoutMs) ?? 120000
  const posTimeoutMs = Number.isFinite(rawPosTimeout) ? rawPosTimeout : 120000
  void handshake(bot, { host, port, consoleSend, posTimeoutMs })
  return bot
}

async function handshake(bot, { host, port, consoleSend, posTimeoutMs }) {
  const transport = bot.transport
  // 1. ws connect with backoff — HeadlessMC takes ~60 s to boot.
  let delay = 1000
  for (;;) {
    if (bot._quitting) return
    try {
      await transport.connect()
      break
    } catch (e) {
      console.log(`bridge waiting for the body: ${e && e.message ? e.message : e} (retry in ${Math.round(delay / 1000)} s)`)
      await sleep(delay)
      delay = Math.min(delay * 2, 10000)
    }
  }
  if (bot._quitting) return
  // 2. console connect: the client joins the MC server on our name. The
  // adapter is the sole connecter, so three failed sends mean this round
  // can never produce a join — error out (runOnce fatal()s → container
  // restart = reconnect) instead of hanging on a pos that never comes
  // (revmux 01 core-1).
  let linked = false
  for (let i = 0; i < 3 && !linked && !bot._quitting; i++) {
    try { linked = await consoleSend(`connect ${host} ${port}`) } catch (_) { linked = false }
    if (!linked && !bot._quitting) await sleep(2000)
  }
  console.log(`bridge console connect ${host} ${port} ok=${linked}`)
  if (bot._quitting) return
  if (!linked) {
    bot.emit('error', new Error(`bridge: console connect ${host} ${port} failed (3 tries)`))
    return
  }
  // 3. hello: the mc version gates the static registry (zero bridge
  // traffic for the 93 registry sites afterwards).
  let hello
  try {
    hello = await transport.call('hello', {})
  } catch (e) {
    bot.emit('error', e instanceof Error ? e : new Error(`bridge hello: ${e}`))
    return
  }
  const mc = (hello && hello.mc) || null
  let registry = null
  try {
    registry = mc ? require('minecraft-data')(mc) : null
  } catch (_) { registry = null }
  if (!registry) {
    bot.emit('error', new Error(`bridge: no minecraft-data for mc=${mc}`))
    return
  }
  bot.version = mc
  bot.protocolVersion = registry.version && registry.version.version
  bot.registry = registry
  // 4. the first state.get with a non-null pos, then login+spawn. start()'s
  // own refresh throws the mod-contact failure into the error path below;
  // the 100 ms poll (skip-when-slow) drives the wait from there. The wait
  // has a deadline: a refused join (or a state.get that never answers)
  // must error into the container restart, never hang the process
  // (revmux 01 core-1).
  try {
    await bot.start({ pollMs: 100, connect: false })
    const deadline = Date.now() + posTimeoutMs
    while (!bot._hasPos && !bot._quitting) {
      if (Date.now() >= deadline) {
        bot.emit('error', new Error(`bridge: no joined state within ${posTimeoutMs} ms`))
        return
      }
      await sleep(250)
    }
  } catch (e) {
    bot.emit('error', e instanceof Error ? e : new Error(`bridge state: ${e}`))
    return
  }
  if (bot._quitting) return
  bot.emit('login')
  bot.emit('spawn')
}

module.exports = { BaritoneBot, goalToBaritone, movementsToSettings, MinimalVec, createBot, setBaritonePaused }
