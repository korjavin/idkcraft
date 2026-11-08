'use strict'
// idkcraft-vewo.3: client-side mirror of the vanilla chat spam throttle
// (+20 per chat packet, -1 per tick = 20/s, kick above 200). Below LIMIT a
// line goes out at once (byte-identical to plain bot.chat); above it lines
// queue FIFO and flush at the drain rate. Queue past QUEUE_MAX drops the
// oldest line, never the zchb `swarm flat ...` relay (delay is fine).
// ponytail: one bucket per bot, constants not env; add a knob if a server
// with a different throttle shows up. Drains by wall clock = assumes 20 TPS:
// under lag the server drains slower and the 40-point headroom covers only
// ~40/(20-TPS) s of saturated flushing; drain by bot.time.age deltas if a
// lagging server still kicks (a slower constant would queue 1 line/s too).
const COST = 20
const DRAIN_PER_MS = 20 / 1000
const LIMIT = 160 // headroom under 200 for the server's own tick skew
const QUEUE_MAX = 20
const PACKET_LEN = 256 // mineflayer chat.js CHAT_LENGTH_LIMIT: longer lines go as several packets
const MAX_PARTS = 3 // qxql.26: packets one message may take in chat; the rest goes to the log only

// The body's own split (mineflayer chat.js / bridge chatParts): a '/' command
// whole, else per '\n' line (empties dropped) in 256-char packets.
function parts(message) {
  const s = String(message)
  if (s.startsWith('/')) return [s]
  const out = []
  for (const line of s.split('\n')) for (let i = 0; i < line.length; i += PACKET_LEN) out.push(line.substring(i, i + PACKET_LEN))
  return out
}

function packets(message) {
  const s = String(message)
  if (s.startsWith('/')) return 1
  return s.split('\n').reduce((n, line) => n + Math.ceil(line.length / PACKET_LEN), 0)
}

function limitChat(bot, now = Date.now) {
  if (typeof bot.chat !== 'function') return bot
  const send = bot.chat.bind(bot)
  const queue = []
  let level = 0
  let at = now()
  let timer = null
  let seq = 0
  const drain = () => { const t = now(); level = Math.max(0, level - (t - at) * DRAIN_PER_MS); at = t }
  // qxql.26: every queued entry is one packet, so no single send can overshoot.
  // The old empty-bucket exception let a 3087-char line out as 13 packets at once (kick).
  const fits = () => level + COST <= LIMIT
  function flush() {
    timer = null
    drain()
    while (queue.length && fits()) {
      const m = queue.shift().p
      level += COST
      try { send(m) } catch (e) { console.log(`chat send failed: ${(e && e.message) || e}`) }
    }
    if (!queue.length) return
    const over = Math.min(level, level + COST - LIMIT)
    timer = setTimeout(flush, Math.max(1, Math.ceil(over / DRAIN_PER_MS)))
    if (timer.unref) timer.unref()
  }
  bot.chat = (message) => {
    let ps = parts(message)
    if (ps.length > MAX_PARTS) {
      console.log(`chat long ${String(message).length} chars, ${ps.length} packets, chat keeps ${MAX_PARTS}: ${message}`)
      ps = ps.slice(0, MAX_PARTS)
      const last = ps[MAX_PARTS - 1]
      ps[MAX_PARTS - 1] = last.slice(0, PACKET_LEN - 12) + ' …(see log)'
    }
    const id = ++seq
    const relay = String(message).startsWith('swarm flat ')
    for (const p of ps) {
      drain()
      if (!queue.length && fits()) { level += COST; send(p); continue }
      queue.push({ p, id, relay })
    }
    // Overflow drops whole messages (all their queued packets), oldest first, never the relay.
    while (queue.length > QUEUE_MAX) {
      const old = queue.find((q) => !q.relay)
      if (!old) break
      const gone = queue.filter((q) => q.id === old.id)
      for (const g of gone) queue.splice(queue.indexOf(g), 1)
      console.log(`chat dropped: ${gone.map((g) => g.p).join('')}`)
    }
    if (queue.length && !timer) flush()
  }
  if (typeof bot.on === 'function') bot.on('end', () => { queue.length = 0; clearTimeout(timer); timer = null })
  return bot
}

module.exports = { limitChat, packets, parts, LIMIT, COST, MAX_PARTS }
