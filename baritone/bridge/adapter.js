// idkcraft-kqzf spike: Node 'bot' adapter — looks like mineflayer's bot to
// the logic, drives a real client (Fabric bridge mod + Baritone) underneath.
// Spike subset only: entity/position, blockAt (sync cache), inventory,
// canDigBlock, dig, placeBlock, chat + chat/message events, pathfinder
// goto/follow mapped to Baritone #goto (mod backend) or the HMC console
// (console backend = rig proof without the mod). Everything else is
// documented in PROTOCOL.md with a size, not implemented here.
'use strict'

const { EventEmitter } = require('node:events')

function keyOf(x, y, z) { return `${Math.floor(x)},${Math.floor(y)},${Math.floor(z)}` }

// Minimal Vec3 when the caller injects none (tests inject the real vec3
// from bot/node_modules for full parity: plus/minus/scaled/floored/...).
class MinimalVec {
  constructor(x, y, z) { this.x = x; this.y = y; this.z = z }
  floored() { return new MinimalVec(Math.floor(this.x), Math.floor(this.y), Math.floor(this.z)) }
  offset(dx, dy, dz) { return new MinimalVec(this.x + dx, this.y + dy, this.z + dz) }
  distanceTo(q) { return Math.hypot(this.x - q.x, this.y - q.y, this.z - q.z) }
  clone() { return new MinimalVec(this.x, this.y, this.z) }
}

// mineflayer-pathfinder goal -> Baritone console command. GoalFollow is a
// one-shot #goto to the target's live position: follow.js already re-issues
// on movement/timeout, so no Baritone #follow semantics are needed for the
// spike. Returns null when the goal has no Baritone mapping (caller then
// reports noPath, like the executor would).
function goalToBaritone(goal) {
  if (!goal) return null
  const name = (goal.constructor && goal.constructor.name) || ''
  if ((name === 'GoalNear' || name === 'GoalBlock' || name === 'GoalGetToBlock') &&
    typeof goal.x === 'number' && typeof goal.y === 'number' && typeof goal.z === 'number') {
    return `#goto ${goal.x} ${goal.y} ${goal.z}`
  }
  if ((name === 'GoalXZ' || name === 'GoalNearXZ') && typeof goal.x === 'number' && typeof goal.z === 'number') {
    return `#goto ${goal.x} ${goal.z}`
  }
  if (name === 'GoalFollow' && goal.entity && goal.entity.position) {
    const p = goal.entity.position
    if (typeof p.x === 'number' && typeof p.y === 'number' && typeof p.z === 'number') {
      return `#goto ${p.x.toFixed(1)} ${p.y.toFixed(1)} ${p.z.toFixed(1)}`
    }
  }
  return null
}

class BaritoneBot extends EventEmitter {
  // transport: BridgeTransport (real mod) or FakeTransport (tests).
  // opts: { Vec3, registry, username, backend='mod', bridgeSend }
  // backend 'console' sends pathfinder goals as `msg <cmd>` lines via
  // bridgeSend(line) (the existing write-only HMC bridge, no mod, no
  // state — rig proof of the #goto leg only).
  constructor(transport, opts = {}) {
    super()
    this.transport = transport
    this.Vec3 = opts.Vec3 || MinimalVec
    this.registry = opts.registry || { blocksByName: {} }
    this.username = opts.username || 'IdkBody'
    this.backend = opts.backend || 'mod'
    this.bridgeSend = opts.bridgeSend || null
    this.version = opts.version || '26.1.2'

    this.entity = { position: new this.Vec3(0, 64, 0), yaw: 0, pitch: 0, onGround: true }
    this.players = {}
    this.entities = {}
    this.health = 20
    this.food = 20
    this.spawnPoint = new this.Vec3(0, 64, 0)
    this.heldItem = null
    this.targetDigBlock = null
    this.currentWindow = null

    this._blocks = new Map() // "x,y,z" -> {name,type,position}
    this._inventory = [] // [{name,count,slot,type}]
    this._baritone = { pathing: false, last: 'none' }
    this._goalGen = 0 // bumped per mod-backend setGoal; stale statuses drop (revmux 01 core-3)
    this._refreshing = false
    this._pathStatus = 'none'
    this._poll = null
    this._onTransportEvent = (method, params) => this._handleEvent(method, params)

    const self = this
    this.pathfinder = {
      goal: null,
      movements: null,
      setGoal: (goal, _dynamic) => self._setGoal(goal),
      stop: () => self._stopPath(),
      isMoving: () => (self.backend === 'mod' ? !!self._baritone.pathing : !!self._consoleMoving),
      isMining: () => false, // spike: single digs, no executor mining
      isBuilding: () => false,
      setMovements: (m) => { self.pathfinder.movements = m || null }, // inert until the settings map lands (PROTOCOL.md)
      bestHarvestTool: (_block) => null, // the mod auto-selects the tool; callers are null-tolerant
    }
    this._consoleMoving = false
    this.inventory = { items: () => this._inventory }
  }

  async start({ pollMs = 100 } = {}) {
    if (this.transport && typeof this.transport.connect === 'function') await this.transport.connect()
    if (this.transport && typeof this.transport.on === 'function') this.transport.on('event', this._onTransportEvent)
    if (this.backend === 'mod') {
      await this.refresh()
      if (pollMs > 0) {
        this._poll = setInterval(() => {
          if (this._refreshing) return // a slow round skips, never piles up (revmux 01 core-2)
          this.refresh().catch(() => { /* poll best-effort; errors surface on demand calls */ })
        }, pollMs)
        if (typeof this._poll.unref === 'function') this._poll.unref()
      }
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
    if (this.backend !== 'mod') throw new Error('adapter: refresh needs the mod backend (console has no state)')
    this._refreshing = true
    try {
      await this._refreshOnce()
    } finally {
      this._refreshing = false
    }
    return this
  }

  async _refreshOnce() {
    const st = await this.transport.call('state.get', {})
    if (st && st.pos) {
      this.entity.position.x = st.pos.x
      this.entity.position.y = st.pos.y
      this.entity.position.z = st.pos.z
      if (typeof st.pos.yaw === 'number') this.entity.yaw = st.pos.yaw
      if (typeof st.pos.pitch === 'number') this.entity.pitch = st.pos.pitch
      if (typeof st.pos.onGround === 'boolean') this.entity.onGround = st.pos.onGround
    }
    if (st && typeof st.health === 'number') this.health = st.health
    if (st && typeof st.food === 'number') this.food = st.food
    try {
      const inv = await this.transport.call('inventory.get', {})
      this._inventory = Array.isArray(inv && inv.items) ? inv.items : []
      this.heldItem = this._inventory[0] || null // spike: selected slot tracking is plan work
    } catch (_) { /* inventory best-effort per round */ }
    try {
      // revmux 01 core-3: read was+generation BEFORE the await; a status
      // older than the last setGoal, or one the mod can't attribute yet
      // (last 'none': still calculating), stays silent and keeps the
      // setGoal latch — synthesising 'success' here re-issues follow.js
      // every tick and the body never moves. Prod echoes a goal id
      // through baritone.cmd -> baritone.status instead of the latch.
      const genBefore = this._goalGen
      const was = this._baritone.pathing
      const bs = await this.transport.call('baritone.status', {})
      if (genBefore !== this._goalGen) return // a setGoal landed mid-round: stale
      if (!bs || typeof bs !== 'object' || bs.last === 'none' || bs.last == null) return
      const nowPathing = !!bs.pathing
      this._baritone = { pathing: nowPathing, last: bs.last }
      if (was && !nowPathing) {
        const last = bs.last
        this._pathStatus = last === 'noPath' || last === 'timeout' ? last : 'success'
        this.emit('path_update', { status: this._pathStatus })
        this.emit('path_reset', this._pathStatus === 'success' ? 'goal reached' : this._pathStatus)
      }
    } catch (_) { /* status best-effort per round */ }
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
    if (this.backend !== 'mod') return
    this.transport.call('chat.send', { message: String(message) }).catch((e) => this.emit('error', e))
  }

  _setGoal(goal) {
    this.pathfinder.goal = goal || null
    if (!goal) {
      this._stopPath()
      return
    }
    const cmd = goalToBaritone(goal)
    if (!cmd) {
      this._pathStatus = 'noPath' // no Baritone mapping: like an executor failure
      this.emit('path_update', { status: 'noPath' })
      this.emit('path_reset', 'noPath')
      return
    }
    this._pathStatus = 'none'
    if (this.backend === 'console') {
      if (!this.bridgeSend) throw new Error('adapter: console backend needs bridgeSend(line)')
      this._consoleMoving = true
      // Fire-and-forget like chat: setGoal is sync in mineflayer. The
      // caller must keep the event loop pumping (async sleeps, never a
      // blocked Atomics.wait) or the socket send starves — see rig-goto.js.
      Promise.resolve()
        .then(() => this.bridgeSend(`msg ${cmd}`))
        .catch((e) => this.emit('error', e))
      return
    }
    this._baritone = { pathing: true, last: 'none' }
    this._goalGen = (this._goalGen | 0) + 1
    this.transport.call('baritone.cmd', { command: cmd }).catch((e) => {
      this._baritone = { pathing: false, last: 'noPath' }
      this._pathStatus = 'noPath'
      this.emit('path_update', { status: 'noPath' })
      this.emit('error', e)
    })
  }

  _stopPath() {
    this.pathfinder.goal = null
    this._consoleMoving = false
    if (this.backend === 'console') {
      if (this.bridgeSend) Promise.resolve().then(() => this.bridgeSend('msg #stop')).catch((e) => this.emit('error', e))
      return
    }
    this._baritone = { pathing: false, last: 'stopped' }
    this.transport.call('baritone.cmd', { command: '#stop' }).catch((e) => this.emit('error', e))
  }

  _handleEvent(method, params) {
    const p = params || {}
    switch (method) {
      case 'chat':
        // mineflayer 'chat' is (username, message); 'message' carries a ChatMessage.
        this.emit('chat', p.username || '', p.message || '')
        this.emit('message', { text: p.message || '', toString: () => String(p.message || '') }, 'chat', null)
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
        // Mod-side Baritone API listener (path found/lost/failed): fold into
        // the pathfinder event pair the ticker already consumes.
        if (p.status === 'noPath' || p.status === 'timeout') {
          this._baritone = { pathing: false, last: p.status }
          this._pathStatus = p.status
          this.emit('path_update', { status: p.status })
          this.emit('path_reset', p.status)
        } else if (p.status === 'success') {
          this._baritone = { pathing: false, last: 'success' }
          this._pathStatus = 'success'
          this.emit('path_update', { status: 'success' })
          this.emit('path_reset', 'goal reached')
        }
        break
      default:
        this.emit(method, p)
        break
    }
  }
}

module.exports = { BaritoneBot, goalToBaritone, MinimalVec }
