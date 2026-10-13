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
const { installLook, handleLookEvent } = require('./look') // idkcraft-neuc.9: look/attack/interact/sleep
const { installInput, setBaritonePaused } = require('./input') // idkcraft-neuc.13: control states

function keyOf(x, y, z) { return `${Math.floor(x)},${Math.floor(y)},${Math.floor(z)}` }
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
function stripMcPrefix(s) {
  return typeof s === 'string' ? s.replace(/^minecraft:/, '') : s
}

// mineflayer-pathfinder goal -> Baritone console command. GoalFollow is a
// one-shot #goto to the target's live position: follow.js already re-issues
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
function goalToBaritone(goal, from) {
  if (!goal) return null
  const name = (goal.constructor && goal.constructor.name) || ''
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
  if (name === 'GoalFollow' && goal.entity && goal.entity.position) {
    const p = goal.entity.position
    if (typeof p.x === 'number' && typeof p.y === 'number' && typeof p.z === 'number') {
      return `#goto ${p.x.toFixed(1)} ${p.y.toFixed(1)} ${p.z.toFixed(1)}`
    }
  }
  if ((name === 'GoalCompositeAny' || name === 'GoalCompositeAll') && Array.isArray(goal.goals)) {
    for (const member of goal.goals) {
      const cmd = goalToBaritone(member, from)
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
// costs Baritone cannot express (// ponytail: danger marks not mapped;
// Baritone avoidance settings if a prod pit repeats). Empty lists are
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
    if (names.length > 0) desired.blocksToAvoidBreaking = names.join(',')
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

    this.entity = { position: new this.Vec3(0, 64, 0), velocity: new this.Vec3(0, 0, 0), yaw: 0, pitch: 0, onGround: true }
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
    this.game = {}
    this.isRaining = false
    this.isSleeping = false
    this.spawnPoint = new this.Vec3(0, 64, 0)
    this.heldItem = null
    this.targetDigBlock = null
    this.currentWindow = null

    this._blocks = new Map() // "x,y,z" -> {name,type,position}
    this._inventory = [] // [{name,count,slot,type}]
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
      isMoving: () => !!self._pathing,
      isMining: () => false, // spike: single digs, no executor mining
      isBuilding: () => false,
      setMovements: (m) => { self.pathfinder.movements = m || null; self._pushSettings() },
      bestHarvestTool: (block) => self._bestHarvestTool(block),
      // No live callers (bring.js names it as a future upgrade path): a
      // sync noPath shaped like the A* result the site would read.
      getPathTo: (_movements, _goal, _timeout) => ({ status: 'noPath', path: [] }),
    }
    this.inventory = { items: () => this._inventory }
    installLook(this) // idkcraft-neuc.9: look/lookAt/attack/activate*/consume/sleep/wake/waitForTicks
    installInput(this, transport) // neuc.13: setControlState/clearControlStates/controlState
  }

  // mineflayer plugin host: the bridge body needs no plugins (runOnce calls
  // bot.loadPlugin(pathfinder) on every body).
  loadPlugin() {}

  // mineflayer quit: console disconnect, then 'end' with the reason (runOnce
  // resolves on 'end' when it asked for the quit, fatal()s otherwise).
  quit(reason = 'quit') {
    if (this._quitting) return
    this._quitting = true
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
    if (this._poll) clearInterval(this._poll)
    this._poll = null
    if (this.transport && typeof this.transport.removeListener === 'function') {
      this.transport.removeListener('event', this._onTransportEvent)
    }
    if (this.transport && typeof this.transport.close === 'function') this.transport.close()
  }

  // One state round: entity/health/food + inventory + Baritone status.
  // Block cache fills via prefetch() + dig/place write-through: blockAt is
  // sync in mineflayer (268 sites), so it can only ever read the cache —
  // the async->sync gap is the core sizing item in PROTOCOL.md.
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

  async _refreshOnce() {
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
      const vel = st.pos.vel
      if (vel && typeof vel.x === 'number' && typeof vel.y === 'number' && typeof vel.z === 'number') {
        this.entity.velocity.x = vel.x
        this.entity.velocity.y = vel.y
        this.entity.velocity.z = vel.z
      }
    }
    if (st && typeof st.health === 'number') this.health = st.health
    if (st && typeof st.food === 'number') this.food = st.food
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
      this._inventory = Array.isArray(inv && inv.items) ? inv.items : []
      this.heldItem = this._inventory[0] || null // spike: selected slot tracking is plan work
    } catch (_) { /* inventory best-effort per round */ }
    try {
      await refreshEntities(this, this.transport) // idkcraft-neuc.3: one entities.list+roster.get per round
    } catch (_) { /* entities best-effort per round */ }
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
  }

  // Fill the block cache around coords the logic is about to read. Spike:
  // one block.get per coord (N+1); prod uses chunk.get snapshots (PROTOCOL.md).
  async prefetch(coords) {
    for (const c of coords || []) {
      const b = await this.transport.call('block.get', { x: Math.floor(c.x), y: Math.floor(c.y), z: Math.floor(c.z) })
      this._cacheBlock(b)
    }
    return this
  }

  _cacheBlock(b) {
    if (!b || typeof b.x !== 'number') return null
    const byName = (this.registry && this.registry.blocksByName) || {}
    const entry = byName[b.name]
    const rec = {
      name: b.name,
      type: entry && typeof entry.id === 'number' ? entry.id : -1,
      position: new this.Vec3(b.x, b.y, b.z),
    }
    this._blocks.set(keyOf(b.x, b.y, b.z), rec)
    return rec
  }

  blockAt(pos) {
    if (!pos || typeof pos.x !== 'number') return null
    return this._blocks.get(keyOf(pos.x, pos.y, pos.z)) || null // miss reads unloaded, like mineflayer
  }

  canDigBlock(block) {
    if (!block || !block.name) return false
    if (block.name === 'air' || block.name === 'bedrock') return false
    return true // spike: hardness/tool parity is plan work (PROTOCOL.md)
  }

  async dig(block, _forceLook) {
    if (!block || !block.position) throw new Error('adapter dig: want a block with a position')
    if (!this.canDigBlock(block)) throw new Error(`adapter dig: cannot dig ${block.name || 'unknown'}`)
    const p = block.position
    this.targetDigBlock = block // stuck.js reads this during a lib dig
    try {
      const r = await this.transport.call('dig.once', { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) })
      this._blocks.set(keyOf(p.x, p.y, p.z), {
        name: 'air', type: -1, position: new this.Vec3(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)),
      })
      return r
    } finally {
      this.targetDigBlock = null
    }
  }

  async placeBlock(ref, face) {
    if (!ref || !ref.position || !face) throw new Error('adapter placeBlock: want (ref, face)')
    const x = Math.floor(ref.position.x + face.x)
    const y = Math.floor(ref.position.y + face.y)
    const z = Math.floor(ref.position.z + face.z)
    const r = await this.transport.call('place.once', { x, y, z })
    this._cacheBlock({ name: (r && r.placed) || 'stone', x, y, z })
    await this.refresh().catch(() => {}) // inventory moved; re-cache best-effort
    return r
  }

  chat(message) {
    // mineflayer chat is fire-and-forget; the promise must never throw synchronously.
    // A failed call logs, never emits 'error': runOnce fatal()s every 'error'
    // (process exit), and a timed-out chat.send on a live socket is not a
    // dead connection (revmux 01 core-2).
    this.transport.call('chat.send', { message: String(message) }).catch((e) => {
      console.log(`bridge chat.send failed: ${(e && e.message) || e}`)
    })
  }

  _setGoal(goal, dynamic) {
    this.pathfinder.goal = goal || null
    this._follow = null
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
    if (this._satisfiedNow(goal)) {
      const live = this._pathing || this._goalId != null
      this._boundSeq = this._cmdSeq
      this._goalId = null
      this._pathing = false
      if (live) this.transport.call('baritone.cmd', { command: '#stop' }).catch(failLog)
      this._completeTerminal('success')
      return
    }
    const cmd = goalToBaritone(goal, this.entity.position)
    if (!cmd) {
      // No Baritone mapping: stop the live walk (mineflayer's setGoal
      // always resets first) and fail like the executor would.
      const live = this._pathing || this._goalId != null
      this._boundSeq = this._cmdSeq
      this._goalId = null
      this._pathing = false
      if (live) this.transport.call('baritone.cmd', { command: '#stop' }).catch(failLog)
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
    if (dynamic && goal.entity && goal.entity.position) {
      const p = goal.entity.position
      if (typeof p.x === 'number' && typeof p.y === 'number' && typeof p.z === 'number') {
        this._follow = { entity: goal.entity, x: p.x, y: p.y, z: p.z, at: Date.now() }
      }
    }
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
    this._goalCmd = command // neuc.13: last goal cmd (diagnostics; pause/resume keeps the id, no re-issue)
    const seq = (this._cmdSeq = (this._cmdSeq | 0) + 1)
    this.transport.call('baritone.cmd', { command }).then(
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
    this._follow = null
    this._pathing = false
    this._pathStatus = status
    this.emit('path_update', { status })
    this.emit('path_reset', status === 'success' ? 'goal reached' : status)
  }

  // Dynamic GoalFollow mid-walk refresh (idkcraft-neuc.4): follow.js only
  // re-issues on terminal/timeout, so a walking player outruns the
  // one-shot #goto. Re-command when the live target left the commanded
  // spot by > 1 block, at most one cmd/s. Silent: no ticker events — the
  // new echo rebinds the latch and the old id's late verdicts drop.
  _maybeReissueFollow() {
    const f = this._follow
    if (!f || this._goalId == null) return
    const p = f.entity && f.entity.position
    if (!p || typeof p.x !== 'number' || typeof p.y !== 'number' || typeof p.z !== 'number') return
    if (Math.hypot(p.x - f.x, p.y - f.y, p.z - f.z) <= 1) return
    const now = Date.now()
    if (now - f.at < 1000) return
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
    this._sendGoalCmd(`#goto ${p.x.toFixed(1)} ${p.y.toFixed(1)} ${p.z.toFixed(1)}`)
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
    const live = this._pathing || this._goalId != null
    this.pathfinder.goal = null
    this._follow = null
    this._boundSeq = this._cmdSeq // in-flight binds and late verdicts drop
    this._goalId = null
    this._pathing = false
    if (!live) return // mineflayer's stop is silent when idle
    this._pathStatus = 'stopped'
    this.transport.call('baritone.cmd', { command: '#stop' }).catch((e) => {
      console.log(`bridge baritone.cmd #stop failed: ${(e && e.message) || e}`) // never 'error': see chat()
    })
    // v1 emits path_stop here (unheard by our ticker); the reset makes the
    // cancel visible on the same taps as every other terminal.
    this.emit('path_reset', 'stopped')
  }

  _handleEvent(method, params) {
    if (handleBridgeEvent(this, method, params)) return // idkcraft-neuc.3: player.joined/left, entity.gone
    if (handleLookEvent(this, method, params)) return // idkcraft-neuc.9: sleep/wake
    const p = params || {}
    switch (method) {
      case 'chat':
        // mineflayer 'chat' is (username, message); 'message' carries a
        // ChatMessage. index.js:1485 reads (msg, position, senderUuid).
        this.emit('chat', p.username || '', p.message || '')
        this.emit('message', { text: p.message || '', toString: () => String(p.message || '') }, p.position || 'chat', p.uuid || null)
        break
      case 'death':
        this.emit('death')
        break
      case 'respawn':
        this.emit('respawn')
        break
      case 'block.update':
        if (typeof p.x === 'number') this._cacheBlock(p)
        this.emit('blockUpdate', null, this.blockAt(p))
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
