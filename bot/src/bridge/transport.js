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
      case 'chunks.list': // idkcraft-neuc.6: columns holding scripted blocks
        return { columns: this._fakeColumns() }
      case 'chunk.get': // idkcraft-neuc.6: state-id sections built from s.blocks
        return this._fakeChunk(Math.floor(params.cx), Math.floor(params.cz))
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
        if (s.baritonePhase === 0) { s.baritonePhase = 1; return { id: s.baritoneId, pathing: true, last: 'none' } }
        return s.baritoneStatus || { id: null, pathing: false, last: 'none' }
      default:
        throw new Error(`bridge: unknown method ${method}`)
    }
  }

  // idkcraft-neuc.6: scripted columns = columns holding a scripted block,
  // plus any state.fakeColumns the test adds explicitly.
  _fakeColumns() {
    const cols = new Map()
    for (const k of Object.keys(this.state.blocks || {})) {
      const [x, , z] = k.split(',').map(Number)
      const cx = Math.floor(x / 16)
      const cz = Math.floor(z / 16)
      cols.set(`${cx},${cz}`, { cx, cz })
    }
    for (const c of this.state.fakeColumns || []) cols.set(`${c.cx},${c.cz}`, { cx: c.cx, cz: c.cz })
    return [...cols.values()]
  }

  // Wire-shaped chunk payload (PROTOCOL.md chunks section): every section
  // present, null for all-air, else base64 int16-LE global state ids in
  // (y<<8)|(z<<4)|x order. State ids come from the real registry so the
  // adapter's prismarine blocks match a mineflayer block for the same id.
  _fakeChunk(cx, cz) {
    const s = this.state
    const registry = require('minecraft-data')(s.mc || '26.1.2')
    const minY = typeof s.chunkMinY === 'number' ? s.chunkMinY : -64
    const numSections = typeof s.chunkSections === 'number' ? s.chunkSections : 24
    const sections = []
    for (let i = 0; i < numSections; i++) sections.push({ y: minY / 16 + i, states: null })
    for (const [k, name] of Object.entries(s.blocks || {})) {
      if (name === 'air') continue
      const [x, y, z] = k.split(',').map(Number)
      if (Math.floor(x / 16) !== cx || Math.floor(z / 16) !== cz) continue
      const entry = registry.blocksByName[name]
      if (!entry) continue
      const si = Math.floor((y - minY) / 16)
      if (si < 0 || si >= numSections) continue
      const sec = sections[si]
      if (sec.states === null) sec.states = Buffer.alloc(4096 * 2)
      const idx = (((y - minY) & 15) << 8) | ((z & 15) << 4) | (x & 15)
      sec.states.writeInt16LE(entry.defaultState, idx * 2)
    }
    for (const sec of sections) if (Buffer.isBuffer(sec.states)) sec.states = sec.states.toString('base64')
    return { cx, cz, minY, sections }
  }

  // Test helper: inject a mod->node event (chat, death, ...).
  inject(method, params = {}) { this.emit('event', method, params) }
}

module.exports = { BridgeTransport, FakeTransport }
