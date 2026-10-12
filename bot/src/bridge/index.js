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

function keyOf(x, y, z) { return `${Math.floor(x)},${Math.floor(y)},${Math.floor(z)}` }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)) }

// Minimal Vec3 when the caller injects none (tests inject the real vec3
// from bot/node_modules for full parity: plus/minus/scaled/floored/...).
class MinimalVec {
  constructor(x, y, z) { this.x = x; this.y = y; this.z = z }
  floored() { return new MinimalVec(Math.floor(this.x), Math.floor(this.y), Math.floor(this.z)) }
  offset(dx, dy, dz) { return new MinimalVec(this.x + dx, this.y + dy, this.z + dz) }
  distanceTo(q) { return Math.hypot(this.x - q.x, this.y - q.z) }
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
    this._baritone = { pathing: false, last: 'none' }
    this._goalGen = 0 // bumped per setGoal; stale statuses drop (revmux 01 core-3)
    this._sawPathing = false // witnessed pathing:true for THIS goal; unattributed terminals stay silent (revmux 02 core-1)
    this._refreshing = false
    this._pathStatus = 'none'
    this._hasPos = false // first state.get with a non-null pos (createBot emits spawn on it)
    this._quitting = false
    this._poll = null
    this._onTransportEvent = (method, params) => this._handleEvent(method, params)

    const self = this
    this.pathfinder = {
      goal: null,
      movements: null,
      setGoal: (goal, _dynamic) => self._setGoal(goal),
      stop: () => self._stopPath(),
      isMoving: () => !!self._baritone.pathing,
      isMining: () => false, // spike: single digs, no executor mining
      isBuilding: () => false,
      setMovements: (m) => { self.pathfinder.movements = m || null }, // inert until the settings map lands (PROTOCOL.md)
      bestHarvestTool: (_block) => null, // the mod auto-selects the tool; callers are null-tolerant
    }
    this.inventory = { items: () => this._inventory }
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
    const finish = () => {
      if (this.transport && typeof this.transport.close === 'function') {
        try { this.transport.close() } catch (_) { /* close best-effort */ }
      }
      this.emit('end', reason)
    }
    if (this._console && typeof this._console.send === 'function') {
      this._console.send('disconnect').catch(() => {}).then(finish, finish)
    } else {
      finish()
    }
  }

  async start({ pollMs = 100, connect = true } = {}) {
    if (connect && this.transport && typeof this.transport.connect === 'function') await this.transport.connect()
    if (this.transport && typeof this.transport.on === 'function') this.transport.on('event', this._onTransportEvent)
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

  async _refreshOnce() {
    const st = await this.transport.call('state.get', {})
    if (st && st.pos) {
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
    if (st && typeof st.dimension === 'string' && st.dimension) this.game.dimension = stripMcPrefix(st.dimension)
    if (st && st.gameMode !== undefined && st.gameMode !== null) this.game.gameMode = gameModeName(st.gameMode)
    try {
      const inv = await this.transport.call('inventory.get', {})
      this._inventory = Array.isArray(inv && inv.items) ? inv.items : []
      this.heldItem = this._inventory[0] || null // spike: selected slot tracking is plan work
    } catch (_) { /* inventory best-effort per round */ }
    try {
      // ponytail (idkcraft-neuc.2): the witnessed-motion latch below is the
      // spike's status attribution — neuc.4 owns the prod replacement (goal
      // id echoed through baritone.cmd -> baritone.status). This bead keeps
      // the spike behaviour compiling and touches nothing below this line.
      // Status attribution (revmux 01 core-3, 02 core-1): read was+generation
      // BEFORE the await. A status older than the last setGoal is stale.
      // Motion witnessed NOW is attributed by construction (we are the only
      // driver) and arms the latch. A pathing:false terminal is only OURS if
      // motion was already witnessed for this goal — otherwise it is a stale
      // latch from a previous goal (or still calculating) and must keep the
      // setGoal latch AND stay silent: synthesising 'success' — or even just
      // flipping isMoving — re-issues follow.js every tick and the body never
      // moves. A goal that fails before any poll shows pathing must surface
      // via the pushed baritone.event, not the poll (else the latch holds
      // isMoving until the next setGoal — revmux 03 core-1; accepting a
      // noPath/timeout after N motionless polls is epic tuning, not spike).
      // Prod replaces the latch with a goal id echoed through
      // baritone.cmd -> baritone.status.
      const genBefore = this._goalGen
      const was = this._baritone.pathing
      const bs = await this.transport.call('baritone.status', {})
      if (genBefore !== this._goalGen) return // a setGoal landed mid-round: stale
      if (!bs || typeof bs !== 'object') return
      if (bs.pathing) {
        this._sawPathing = true
        this._baritone = { pathing: true, last: bs.last || 'none' }
        return
      }
      if (bs.last === 'none' || bs.last == null) return
      if (!this._sawPathing) return // unattributed terminal: keep the latch, stay silent
      const last = bs.last
      this._baritone = { pathing: false, last }
      if (!was) return
      this._pathStatus = last === 'noPath' || last === 'timeout' ? last : (last === 'stopped' ? 'stopped' : 'success')
      this.emit('path_update', { status: this._pathStatus })
      this.emit('path_reset', this._pathStatus === 'success' ? 'goal reached' : this._pathStatus)
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
    this._baritone = { pathing: true, last: 'none' }
    this._goalGen = (this._goalGen | 0) + 1
    this._sawPathing = false // new goal: nothing witnessed yet (revmux 02 core-1)
    this.transport.call('baritone.cmd', { command: cmd }).catch((e) => {
      this._baritone = { pathing: false, last: 'noPath' }
      this._pathStatus = 'noPath'
      this.emit('path_update', { status: 'noPath' })
      this.emit('error', e)
    })
  }

  _stopPath() {
    this.pathfinder.goal = null
    this._sawPathing = false // goal cancelled: later terminals are not ours
    this._goalGen = (this._goalGen | 0) + 1 // in-flight pre-stop polls drop as stale (revmux 03 core-2)
    this._baritone = { pathing: false, last: 'stopped' }
    this.transport.call('baritone.cmd', { command: '#stop' }).catch((e) => this.emit('error', e))
  }

  _handleEvent(method, params) {
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
  void handshake(bot, { host, port, consoleSend })
  return bot
}

async function handshake(bot, { host, port, consoleSend }) {
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
  // 2. console connect: the client joins the MC server on our name.
  let linked = false
  for (let i = 0; i < 3 && !linked && !bot._quitting; i++) {
    try { linked = await consoleSend(`connect ${host} ${port}`) } catch (_) { linked = false }
    if (!linked && !bot._quitting) await sleep(2000)
  }
  console.log(`bridge console connect ${host} ${port} ok=${linked}`)
  if (bot._quitting) return
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
  // the 100 ms poll (skip-when-slow) drives the wait from there.
  try {
    await bot.start({ pollMs: 100, connect: false })
    while (!bot._hasPos && !bot._quitting) await sleep(250)
  } catch (e) {
    bot.emit('error', e instanceof Error ? e : new Error(`bridge state: ${e}`))
    return
  }
  if (bot._quitting) return
  bot.emit('login')
  bot.emit('spawn')
}

module.exports = { BaritoneBot, goalToBaritone, MinimalVec, createBot }
