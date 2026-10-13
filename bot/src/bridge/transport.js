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
      case 'chunks.list': // idkcraft-neuc.6: columns holding scripted blocks
        return { columns: this._fakeColumns() }
      case 'chunk.get': // idkcraft-neuc.6: state-id sections built from s.blocks
        return this._fakeChunk(Math.floor(params.cx), Math.floor(params.cz))
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
      // idkcraft-neuc.7 dig/place. dig.start answers {ok} and the outcome
      // arrives as notifications on a later turn, like the mod's ticks:
      // s.digScript 'hang' = nothing (the adapter's guard/stopDigging
      // decides), 'abort' = dig.abort {reason: s.digAbortReason||'moved'},
      // default = dig.progress then the block turns air + dig.done.
      case 'dig.start': {
        (s.digLog = s.digLog || []).push({ ...params })
        const k = this.key(params.x, params.y, params.z)
        const name = s.blocks[k] || 'air'
        if (name === 'bedrock') throw new Error(`bridge: not diggable at ${k}`)
        const at = { x: Math.floor(params.x), y: Math.floor(params.y), z: Math.floor(params.z) }
        if (s.digScript === 'hang') return { ok: true }
        setImmediate(() => {
          if (s.digScript === 'abort') { this.inject('dig.abort', { ...at, reason: s.digAbortReason || 'moved' }); return }
          this.inject('dig.progress', { ...at, progress: 0.5 })
          s.blocks[k] = 'air'
          this.inject('dig.done', { ...at, broke: name !== 'air', stateId: 0 })
        })
        return { ok: true }
      }
      case 'dig.abort':
        s.digAborts = (s.digAborts | 0) + 1
        return { ok: true, aborted: true }
      // place.once: x,y,z = the target, the server answers with a
      // block.update for it (placed, or the unchanged cell when refused —
      // occupied target or s.refusePlace) plus the inventory.update.
      case 'place.once': {
        (s.placeLog = s.placeLog || []).push({ ...params })
        const k = this.key(params.x, params.y, params.z)
        const registry = require('minecraft-data')(s.mc || '26.1.2')
        const at = { x: Math.floor(params.x), y: Math.floor(params.y), z: Math.floor(params.z) }
        const item = s.inventory.find((i) => i.slot === 36 + (s.selected || 0) && i.count > 0)
        if (!item) return { ok: true, result: 'PASS' }
        const cur = s.blocks[k] || 'air'
        const refused = cur !== 'air' || s.refusePlace
        if (!refused) {
          s.blocks[k] = item.name
          item.count--
        }
        const placed = registry.blocksByName[s.blocks[k] || 'air']
        setImmediate(() => {
          if (s.placeSilent) return
          this.inject('block.update', { ...at, stateId: placed ? placed.defaultState : 0 })
          if (!refused) this.inject('inventory.update', { slot: item.slot, item: item.count > 0 ? { ...item } : null, selected: s.selected || 0 })
        })
        return { ok: true, result: refused ? 'FAIL' : 'SUCCESS' }
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
      // idkcraft-neuc.11 windows: s.containers {"x,y,z": {type,size,title,
      // slots:[{slot,name,count}]}}; the open menu is container slots then
      // inventory 9-44 at size+0..35 (mineflayer numbering, like the mod).
      case 'window.open': {
        const key = this.key(params.x, params.y, params.z)
        if (!(s.containers || {})[key]) throw new Error('bridge: window.open: no window opened')
        s.windowSeq = (s.windowSeq | 0) + 1
        s.window = { id: s.windowSeq, key }
        s.cursor = null
        return this._menu()
      }
      case 'window.click': {
        (s.clickLog = s.clickLog || []).push({ ...params })
        if (!s.window || s.window.id !== params.windowId) throw new Error(`bridge: stale window ${params.windowId}`)
        this._click(params.slot, params.mouseButton, params.mode)
        return this._menu()
      }
      case 'window.close':
        (s.closeLog = s.closeLog || []).push(params.windowId)
        if (s.window && s.window.id === params.windowId) s.window = null
        return { ok: true }
      case 'respawn': // idkcraft-neuc.21: death-screen click; a live player no-ops
        s.respawnCalls = (s.respawnCalls | 0) + 1
        if (s.respawnIgnore > 0) { s.respawnIgnore--; return { ok: true } } // a click the client dropped
        if (typeof s.health === 'number' && s.health <= 0) s.health = 20
        return { ok: true }
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

  // idkcraft-neuc.11: the open menu as the mod's wire shape.
  _menu() {
    const s = this.state
    const c = s.containers[s.window.key]
    const n = c.size
    const slots = c.slots.map((i) => ({ ...i }))
      .concat(s.inventory.filter((i) => i.slot >= 9 && i.slot <= 44).map((i) => ({ ...i, slot: i.slot - 9 + n })))
    return { windowId: s.window.id, type: c.type, title: c.title || '', size: n + 36, slots, cursor: s.cursor ? { ...s.cursor } : null }
  }

  // Vanilla click subset the adapter sends: mode 0 left/right pickup/place/
  // merge/swap, mode 1 shift-move to the other section, slot -999 drop.
  // ponytail: every stack caps at 64 (fixtures are 64-stackers).
  _click(slot, button, mode) {
    const s = this.state
    const c = s.containers[s.window.key]
    const n = c.size
    const arr = new Array(n + 36).fill(null)
    for (const i of c.slots) arr[i.slot] = { name: i.name, count: i.count }
    for (const i of s.inventory) if (i.slot >= 9 && i.slot <= 44) arr[i.slot - 9 + n] = { name: i.name, count: i.count }
    let cur = s.cursor ? { ...s.cursor } : null
    const it = slot >= 0 ? arr[slot] : null
    // c.accept {slot: [names]}: a slot that refuses other items (furnace fuel).
    const refuses = cur && c.accept && c.accept[slot] && !c.accept[slot].includes(cur.name)
    if (refuses) {
      // vanilla mayPlace false: the click changes nothing
    } else if (slot === -999) {
      if (cur) { cur.count = button === 0 ? 0 : cur.count - 1 }
    } else if (mode === 0) {
      if (!cur) {
        if (it) {
          const take = button === 0 ? it.count : Math.ceil(it.count / 2)
          cur = { name: it.name, count: take }
          it.count -= take
        }
      } else if (!it) {
        const put = button === 0 ? cur.count : 1
        arr[slot] = { name: cur.name, count: put }
        cur.count -= put
      } else if (it.name === cur.name) {
        const mv = Math.min(64 - it.count, button === 0 ? cur.count : 1)
        it.count += mv
        cur.count -= mv
      } else if (button === 0) {
        arr[slot] = cur
        cur = it
      }
    } else if (mode === 1 && it) {
      const [a, b] = slot < n ? [n, n + 36] : [0, n]
      for (let pass = 0; pass < 2 && it.count > 0; pass++) {
        for (let d = a; d < b && it.count > 0; d++) {
          const t = arr[d]
          if (pass === 0 && t && t.name === it.name && t.count < 64) {
            const mv = Math.min(64 - t.count, it.count)
            t.count += mv
            it.count -= mv
          } else if (pass === 1 && !t) {
            arr[d] = { name: it.name, count: it.count }
            it.count = 0
          }
        }
      }
    }
    s.cursor = cur && cur.count > 0 ? cur : null
    c.slots = []
    for (let i = 0; i < n; i++) if (arr[i] && arr[i].count > 0) c.slots.push({ slot: i, ...arr[i] })
    s.inventory = s.inventory.filter((i) => i.slot < 9 || i.slot > 44)
    for (let i = n; i < n + 36; i++) if (arr[i] && arr[i].count > 0) s.inventory.push({ slot: i - n + 9, ...arr[i] })
  }

  // Test helper: inject a mod->node event (chat, death, ...).
  inject(method, params = {}) { this.emit('event', method, params) }
}

module.exports = { BridgeTransport, FakeTransport }
