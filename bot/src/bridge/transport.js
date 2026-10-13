// idkcraft-kqzf spike: transport for the one-body bridge (Node side).
// WebSocket JSON-RPC + event stream. Uses the global WebSocket (Node >=22,
// no deps). FakeTransport is the loopback for tests: it answers the spike
// subset from scripted state so behaviours run unchanged without a client.
'use strict'

const { EventEmitter } = require('node:events')

// One JSON-RPC 2.0 call: {jsonrpc:'2.0',id,method,params}. Replies:
// {jsonrpc:'2.0',id,result|error}. Events (no id): {jsonrpc:'2.0',method,params}.
class BridgeTransport extends EventEmitter {
  constructor(url, { timeoutMs = 5000 } = {}) {
    super()
    this.url = url
    this.timeoutMs = timeoutMs
    this.nextId = 1
    this.pending = new Map()
    this.ws = null
  }

  connect() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url)
      this.ws = ws
      const fail = (e) => reject(e instanceof Error ? e : new Error(`bridge connect: ${e && e.message ? e.message : e}`))
      ws.addEventListener('open', () => {
        ws.addEventListener('message', (ev) => this._onMessage(ev.data))
        ws.addEventListener('close', () => this.emit('close'))
        ws.addEventListener('error', (e) => this.emit('error', e))
        resolve()
      }, { once: true })
      ws.addEventListener('error', fail, { once: true })
    })
  }

  close() {
    try { if (this.ws) this.ws.close() } catch (_) { /* close best-effort */ }
    this.ws = null
  }

  call(method, params = {}) {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`bridge ${method}: timeout (${this.timeoutMs} ms)`))
      }, this.timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      try {
        this.ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }))
      } catch (e) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(e)
      }
    })
  }

  _onMessage(data) {
    let msg
    try { msg = JSON.parse(String(data)) } catch (_) { return }
    if (msg == null || typeof msg !== 'object') return
    if (msg.id != null && this.pending.has(msg.id)) {
      const { resolve, reject, timer } = this.pending.get(msg.id)
      this.pending.delete(msg.id)
      clearTimeout(timer)
      if (msg.error) reject(new Error(`bridge: ${msg.error.message || msg.error.code || 'error'}`))
      else resolve(msg.result)
      return
    }
    if (msg.method) this.emit('event', msg.method, msg.params || {})
  }
}

// Loopback for tests and the offline spike run: scripted world state,
// Baritone answers faked as instant #goto walks (pos jumps to goal).
class FakeTransport extends EventEmitter {
  constructor(state = {}) {
    super()
    this.state = {
      pos: { x: 0, y: 64, z: 0, yaw: 0, pitch: 0, onGround: true, vel: { x: 0, y: 0, z: 0 } },
      health: 20,
      food: 20,
      oxygen: 20,
      time: { age: 1000, timeOfDay: 1000, day: 0, isDay: true },
      spawn: { x: 0, y: 64, z: 0 },
      isRaining: false,
      isSleeping: false,
      dimension: 'overworld',
      gameMode: 'survival',
      blocks: {}, // "x,y,z" -> name
      inventory: [], // [{slot,name,count}]
      entities: [], // idkcraft-neuc.3 wire fixtures: [{id,uuid,type,name?,displayName,kind,pos,vel,yaw,pitch,health?,onGround,pose,self?}]
      roster: [], // idkcraft-neuc.3 wire fixtures: [{name,uuid,ping,gameMode}]
      chatLog: [],
      baritone: null, // last command string
      ...state,
    }
    this.connected = false
  }

  async connect() { this.connected = true }
  close() {
    this.connected = false
    this.emit('close') // loopback fidelity: a real close follows the socket
  }

  key(x, y, z) { return `${Math.floor(x)},${Math.floor(y)},${Math.floor(z)}` }

  async call(method, params = {}) {
    const s = this.state
    switch (method) {
      case 'hello':
        return { mod: 'idkcraft-bridge', v: 0, mc: '26.1.2', baritone: '1.18.0' }
      case 'state.get':
        return {
          pos: s.pos == null ? null : { ...s.pos },
          health: s.health,
          food: s.food,
          oxygen: s.oxygen,
          time: s.time == null ? null : { ...s.time },
          spawn: s.spawn == null ? null : { ...s.spawn },
          isRaining: s.isRaining,
          isSleeping: s.isSleeping,
          dimension: s.dimension,
          gameMode: s.gameMode,
          baritone: s.baritoneStatus || { pathing: false },
        }
      case 'block.get': {
        const name = s.blocks[this.key(params.x, params.y, params.z)] || 'air'
        return { name, x: Math.floor(params.x), y: Math.floor(params.y), z: Math.floor(params.z) }
      }
      case 'inventory.get':
        return { items: s.inventory.map((i) => ({ ...i })) }
      case 'entities.list': // idkcraft-neuc.3: deep copy, the wire would serialize
        return { entities: JSON.parse(JSON.stringify(s.entities || [])) }
      case 'roster.get': // idkcraft-neuc.3
        return { players: (s.roster || []).map((p) => ({ ...p })) }
      case 'dig.once': {
        const k = this.key(params.x, params.y, params.z)
        const name = s.blocks[k] || 'air'
        if (name === 'air' || name === 'bedrock') throw new Error(`bridge: cannot dig ${name} at ${k}`)
        s.blocks[k] = 'air'
        return { broke: name }
      }
      case 'place.once': {
        const k = this.key(params.x, params.y, params.z)
        if ((s.blocks[k] || 'air') !== 'air') throw new Error(`bridge: occupied ${k}`)
        const item = s.inventory.find((i) => i.count > 0)
        if (!item) throw new Error('bridge: empty hand')
        s.blocks[k] = item.name.replace(/_item$/, '')
        item.count--
        return { placed: s.blocks[k] }
      }
      // idkcraft-neuc.9 look/interact surface: recorded for assertions,
      // state mutations mirror the mod (pos yaw/pitch, sleeping, using).
      case 'look.set':
        (s.lookLog = s.lookLog || []).push({ method, ...params })
        if (s.pos) { s.pos = { ...s.pos, yaw: params.yaw, pitch: params.pitch } }
        return { ok: true }
      case 'look.at': {
        (s.lookLog = s.lookLog || []).push({ method, ...params })
        if (s.pos) {
          const dx = params.x - s.pos.x
          const dy = params.y - (s.pos.y + 1.62)
          const dz = params.z - s.pos.z
          s.pos = { ...s.pos, yaw: Math.atan2(-dx, -dz), pitch: Math.atan2(dy, Math.hypot(dx, dz)) }
        }
        return { ok: true }
      }
      case 'attack':
        (s.attacks = s.attacks || []).push(params.entityId)
        return { ok: true }
      case 'interact.block': {
        (s.blockInteracts = s.blockInteracts || []).push({ ...params })
        const name = s.blocks[this.key(params.x, params.y, params.z)] || 'air'
        if (name.endsWith('_bed') || name === 'bed') s.isSleeping = true
        return { ok: true, result: 'SUCCESS' }
      }
      case 'interact.item':
        (s.itemUses = s.itemUses || []).push({ ...params })
        s.usingItem = true
        if (typeof s.eatDelayMs === 'number') {
          const t = setTimeout(() => {
            const held = s.inventory.find((i) => i.count > 0)
            if (held) held.count--
            s.usingItem = false
          }, s.eatDelayMs)
          if (typeof t.unref === 'function') t.unref()
        }
        return { ok: true }
      case 'interact.stop':
        s.usingItem = false
        return { ok: true }
      case 'sleep':
        (s.sleepCalls = s.sleepCalls || []).push({ ...params })
        s.isSleeping = true
        return { ok: true }
      case 'wake':
        (s.wakeCalls = (s.wakeCalls || 0) + 1)
        s.isSleeping = false
        return { ok: true }
      case 'chat.send':
        s.chatLog.push(params.message)
        return { sent: true }
      case 'baritone.cmd': {
        // Goal-id echo (.1 wire contract): every #goto takes an id the
        // status and events carry back. #set is not a goal (no id, no
        // status touch — a settings push mid-walk must not clobber it).
        const cmd = params.command || ''
        s.baritone = cmd
        if (/^#set(\s|$)/.test(cmd)) {
          (s.baritoneSets = s.baritoneSets || []).push(cmd)
          return { id: null }
        }
        if (/^#(pause|resume)(\s|$)/.test(cmd)) { // idkcraft-neuc.9: goal stays armed, no status touch
          (s.baritonePauses = s.baritonePauses || []).push(cmd)
          s.baritonePaused = cmd.startsWith('#pause')
          // Model pausedThisTick: for ~30 ms after #resume a status read
          // still shows the paused tick (pathing:false, no verdict).
          if (!s.baritonePaused) s.resumeStaleUntil = Date.now() + 30
          return { id: null }
        }
        if (/^#stop/.test(cmd)) {
          const id = s.baritoneId != null ? s.baritoneId : null
          s.baritoneStatus = { id, pathing: false, last: 'stopped' }
          s.baritonePhase = null
          return { id }
        }
        const m = /^#goto\s+(-?[\d.]+)(?:\s+(-?[\d.]+))?(?:\s+(-?[\d.]+))?/.exec(cmd)
        if (m) {
          s.baritoneSeq = (s.baritoneSeq | 0) + 1
          const id = s.baritoneSeq
          s.baritoneId = id
          if (m[3] !== undefined) s.pos = { ...s.pos, x: +m[1], y: +m[2], z: +m[3] }
          else if (m[2] !== undefined) s.pos = { ...s.pos, x: +m[1], z: +m[2] }
          else s.pos = { ...s.pos, y: +m[1] }
          // Two-phase status: the first poll witnesses motion (like a real
          // 10 Hz poll over a multi-tick walk), the second reports arrival.
          s.baritoneStatus = { id, pathing: false, last: 'success' }
          s.baritonePhase = 0
          return { id }
        }
        return { id: null }
      }
      case 'baritone.status':
        // While #pause holds, a live goal reads pathing:false with no
        // verdict yet — the shape the adapter's re-issue check must NOT
        // mistake for a dropped goal once #resume lands (the mod reads
        // pathing fresh on the client thread, post-resume).
        if (s.baritonePaused) return { id: s.baritoneId, pathing: false, last: 'none' }
        if (s.resumeStaleUntil && Date.now() < s.resumeStaleUntil) return { id: s.baritoneId, pathing: false, last: 'none' }
        if (s.baritonePhase === 0) { s.baritonePhase = 1; return { id: s.baritoneId, pathing: true, last: 'none' } }
        return s.baritoneStatus || { id: null, pathing: false, last: 'none' }
      default:
        throw new Error(`bridge: unknown method ${method}`)
    }
  }

  // Test helper: inject a mod->node event (chat, death, ...).
  inject(method, params = {}) { this.emit('event', method, params) }
}

module.exports = { BridgeTransport, FakeTransport }
