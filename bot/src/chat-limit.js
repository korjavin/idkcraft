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
  const drain = () => { const t = now(); level = Math.max(0, level - (t - at) * DRAIN_PER_MS); at = t }
  // level === 0: a line costing more than LIMIT on its own still goes out on an empty bucket
  const fits = (m) => level === 0 || level + packets(m) * COST <= LIMIT
  function flush() {
    timer = null
    drain()
    while (queue.length && fits(queue[0])) {
      const m = queue.shift()
      level += packets(m) * COST
      try { send(m) } catch (e) { console.log(`chat send failed: ${(e && e.message) || e}`) }
    }
    if (!queue.length) return
    const over = Math.min(level, level + packets(queue[0]) * COST - LIMIT)
    timer = setTimeout(flush, Math.max(1, Math.ceil(over / DRAIN_PER_MS)))
    if (timer.unref) timer.unref()
  }
  bot.chat = (message) => {
    drain()
    if (!queue.length && fits(message)) { level += packets(message) * COST; return send(message) }
    queue.push(message)
    if (queue.length > QUEUE_MAX) {
      const i = queue.findIndex((q) => !String(q).startsWith('swarm flat '))
      if (i >= 0) console.log(`chat dropped: ${queue.splice(i, 1)[0]}`)
    }
    if (!timer) flush()
  }
  if (typeof bot.on === 'function') bot.on('end', () => { queue.length = 0; clearTimeout(timer); timer = null })
  return bot
}

module.exports = { limitChat, packets, LIMIT, COST }
