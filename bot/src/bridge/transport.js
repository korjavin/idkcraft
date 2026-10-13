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
      input: { forward: false, back: false, left: false, right: false, jump: false, sprint: false, sneak: false }, // neuc.13 held states
      inputLog: [], // neuc.13: every input.set diff / input.clear, in order
      inputPaused: false, // neuc.13: Baritone paused while any key held (goal id preserved)
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
          input: { states: { ...(s.input || {}) } },
          baritone: s.baritoneStatus || { pathing: false },
        }
      case 'input.set': { // neuc.13: absent = unchanged; any held pauses Baritone (id kept)
        const diff = {}
        for (const k of Object.keys(params || {})) {
          if (typeof params[k] === 'boolean' && k in s.input) { s.input[k] = params[k]; diff[k] = params[k] }
        }
        s.inputLog.push({ set: diff })
        s.inputPaused = Object.values(s.input).some(Boolean)
        return { states: { ...s.input } }
      }
      case 'input.clear': { // neuc.13: all off; resume (goal id kept)
        for (const k of Object.keys(s.input)) s.input[k] = false
        s.inputLog.push({ clear: true })
        s.inputPaused = false
        return { states: { ...s.input } }
      }
      case 'block.get': {
        const name = s.blocks[this.key(params.x, params.y, params.z)] || 'air'
        return { name, x: Math.floor(params.x), y: Math.floor(params.y), z: Math.floor(params.z) }
      }
      case 'inventory.get': // idkcraft-neuc.8: {selected, slots:[{slot,name,count,...}]}
        return { selected: s.selected || 0, slots: s.inventory.map((i) => ({ ...i })) }
      case 'inventory.select': {
        s.selected = params.hotbar
        return { selected: s.selected, slots: s.inventory.map((i) => ({ ...i })) }
      }
      case 'inventory.equip': {
        // Model the menu swap on the flat fixture list (entries carry their
        // mineflayer slot); dest may be a name or a numeric slot (unequip).
        const destSlot = typeof params.dest === 'number' ? params.dest
          : params.dest === 'hand' ? 36 + (s.selected || 0)
            : ({ head: 5, torso: 6, legs: 7, feet: 8, 'off-hand': 45 })[params.dest]
        if (destSlot == null) throw new Error(`bridge: invalid destination: ${params.dest}`)
        const src = s.inventory.find((i) => i.slot === params.slot)
        if (!src) throw new Error('bridge: equip source slot empty')
        if (params.dest === 'hand' && params.slot >= 36 && params.slot <= 44) {
          s.selected = params.slot - 36
        } else if (params.slot !== destSlot) {
          const dst = s.inventory.find((i) => i.slot === destSlot)
          src.slot = destSlot
          if (dst) dst.slot = params.slot
        }
        return { selected: s.selected || 0, slots: s.inventory.map((i) => ({ ...i })) }
      }
      case 'inventory.toss': {
        const it = s.inventory.find((i) => i.slot === params.slot)
        if (!it) throw new Error('bridge: toss slot empty')
        it.count -= Math.min(params.count || it.count, it.count)
        if (it.count <= 0) s.inventory.splice(s.inventory.indexOf(it), 1)
        return { selected: s.selected || 0, slots: s.inventory.map((i) => ({ ...i })) }
      }
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

  // Test helper: inject a mod->node event (chat, death, ...).
  inject(method, params = {}) { this.emit('event', method, params) }
}

module.exports = { BridgeTransport, FakeTransport }
