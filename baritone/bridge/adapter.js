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
    // The step lands on us (cardinally adjacent with a clean isEnd=false):
    // an in-goal #goto is answered with silence, so fail visibly instead.
    if (nx === fx && py === fy && nz === fz) return null
    // Above the feet (walls, roofs): GoalBlock, Baritone pillars to reach
    // like v1's executor does. Level or below (fills, floors, table look):
    // GoalXZ stands on the surface beside — never into solid ground
    // (Baritone would dig the stand cell out) or up into air.
    if (py > fy) return `#goto ${nx} ${py} ${nz}`
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
    this._goalId = null // live goal id from baritone.cmd; null = none or awaiting the echo
    this._cmdSeq = 0 // every baritone.cmd takes a sequence number ...
    this._boundSeq = 0 // ... and binds only when newer than this (stale replies drop)
    this._pathing = false // Baritone pathing for the CURRENT id (the setGoal latch)
    this._follow = null // dynamic GoalFollow re-issue arm { entity, x, y, z, at }
    this._settings = {} // last `#set` values pushed (name -> string)
    this._refreshing = false
    this._pathStatus = 'none'
    this._poll = null
    this._onTransportEvent = (method, params) => this._handleEvent(method, params)

    const self = this
    this.pathfinder = {
      goal: null,
      movements: null,
      setGoal: (goal, dynamic) => self._setGoal(goal, dynamic === true),
      stop: () => self._stopPath(),
      isMoving: () => (self.backend === 'mod' ? !!self._pathing : !!self._consoleMoving),
      isMining: () => false, // spike: single digs, no executor mining
      isBuilding: () => false,
      setMovements: (m) => { self.pathfinder.movements = m || null; self._pushSettings() },
      bestHarvestTool: (block) => self._bestHarvestTool(block),
      // No live callers (bring.js names it as a future upgrade path): a
      // sync noPath shaped like the A* result the site would read.
      getPathTo: (_movements, _goal, _timeout) => ({ status: 'noPath', path: [] }),
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
        } else if (bs.last !== 'none' && bs.last != null) {
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
    if (this.backend !== 'mod') return
    this.transport.call('chat.send', { message: String(message) }).catch((e) => this.emit('error', e))
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
      const live = this.backend === 'mod' ? (this._pathing || this._goalId != null) : !!this._consoleMoving
      this._boundSeq = this._cmdSeq
      this._goalId = null
      this._pathing = false
      this._consoleMoving = false
      if (live) {
        if (this.backend === 'mod') this.transport.call('baritone.cmd', { command: '#stop' }).catch((e) => this.emit('error', e))
        else if (this.bridgeSend) Promise.resolve().then(() => this.bridgeSend('msg #stop')).catch((e) => this.emit('error', e))
      }
      this._completeTerminal('success')
      return
    }
    // The console backend is position-blind: no safe approach side, so
    // place/look goals report noPath there (the rig never sends them).
    const from = this.backend === 'mod' ? this.entity.position : null
    const cmd = goalToBaritone(goal, from)
    if (!cmd) {
      // No Baritone mapping: stop the live walk (mineflayer's setGoal
      // always resets first) and fail like the executor would.
      const live = this.backend === 'mod' ? (this._pathing || this._goalId != null) : !!this._consoleMoving
      this._boundSeq = this._cmdSeq
      this._goalId = null
      this._pathing = false
      this._consoleMoving = false
      if (live) {
        if (this.backend === 'mod') this.transport.call('baritone.cmd', { command: '#stop' }).catch((e) => this.emit('error', e))
        else if (this.bridgeSend) Promise.resolve().then(() => this.bridgeSend('msg #stop')).catch((e) => this.emit('error', e))
      }
      this._pathStatus = 'noPath'
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
  // _boundSeq, overlapping follow re-issues order by seq).
  _sendGoalCmd(command) {
    const seq = (this._cmdSeq = (this._cmdSeq | 0) + 1)
    this.transport.call('baritone.cmd', { command }).then(
      (r) => {
        if (seq <= this._boundSeq) return
        this._boundSeq = seq
        if (!r || r.id == null) {
          this._goalFailed() // tracked by nobody: fail, don't wedge isMoving
          return
        }
        this._goalId = r.id
      },
      (e) => {
        if (seq <= this._boundSeq) return
        this._boundSeq = seq
        this._goalFailed()
        this.emit('error', e)
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
    this._sendGoalCmd(`#goto ${p.x.toFixed(1)} ${p.y.toFixed(1)} ${p.z.toFixed(1)}`)
  }

  // Diffed Movements -> `#set` push (idkcraft-neuc.4): installed flags on
  // setMovements, lease-mutated flags on every setGoal. First push sends
  // every mapped setting absolutely (the image settings.txt is the
  // baseline only until then); afterwards only changes cross, so the cmd
  // stream stays quiet. A failed send unmarks for retry on the next push.
  _pushSettings() {
    if (this.backend !== 'mod' || !this.transport) return
    const desired = movementsToSettings(this.pathfinder.movements, this.registry)
    for (const k of Object.keys(desired)) {
      if (this._settings[k] === desired[k]) continue
      this._settings[k] = desired[k]
      this.transport.call('baritone.cmd', { command: `#set ${k} ${desired[k]}` }).catch((e) => {
        if (this._settings[k] === desired[k]) delete this._settings[k]
        this.emit('error', e)
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
    const live = this.backend === 'mod'
      ? (this._pathing || this._goalId != null)
      : (this.pathfinder.goal != null || !!this._consoleMoving)
    this.pathfinder.goal = null
    this._follow = null
    this._boundSeq = this._cmdSeq // in-flight binds and late verdicts drop
    this._goalId = null
    this._pathing = false
    this._consoleMoving = false
    if (!live) return // mineflayer's stop is silent when idle
    this._pathStatus = 'stopped'
    if (this.backend === 'console') {
      if (this.bridgeSend) Promise.resolve().then(() => this.bridgeSend('msg #stop')).catch((e) => this.emit('error', e))
    } else {
      this.transport.call('baritone.cmd', { command: '#stop' }).catch((e) => this.emit('error', e))
    }
    // v1 emits path_stop here (unheard by our ticker); the reset makes the
    // cancel visible on the same taps as every other terminal.
    this.emit('path_reset', 'stopped')
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

module.exports = { BaritoneBot, goalToBaritone, movementsToSettings, MinimalVec }
