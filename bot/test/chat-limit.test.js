'use strict'
// idkcraft-vewo.3: client-side chat bucket vs a simulated vanilla throttle.
const { describe, it, beforeEach, afterEach, mock } = require('node:test')
const assert = require('node:assert/strict')
const { limitChat, packets } = require('../src/chat-limit')

// Vanilla: +20 per chat packet, -1 per 50 ms tick, kick when > 200.
function server() {
  let counter = 0
  let at = Date.now()
  let peak = 0
  return {
    recv(m) {
      const ticks = Math.floor((Date.now() - at) / 50)
      counter = Math.max(0, counter - ticks)
      at += ticks * 50
      counter += 20 * packets(m)
      peak = Math.max(peak, counter)
    },
    get peak() { return peak }
  }
}

function fakeBot() {
  const srv = server()
  const sent = []
  const bot = { sent, srv, chat(m) { sent.push(m); srv.recv(m) } }
  return limitChat(bot)
}

describe('chat-limit', () => {
  beforeEach(() => mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 }))
  afterEach(() => mock.timers.reset())

  it('13 synchronous lines: 8 at once, the rest spaced, order kept, never above 200', () => {
    const bot = fakeBot()
    const lines = Array.from({ length: 13 }, (_, i) => `flat done: ${i}`)
    for (const l of lines) bot.chat(l)
    assert.equal(bot.sent.length, 8)
    for (let t = 0; t < 100; t++) mock.timers.tick(100)
    assert.deepEqual(bot.sent, lines)
    assert.ok(bot.srv.peak <= 200, `peak ${bot.srv.peak}`)
    const raw = server() // pre-fix reproducer: the same burst unwrapped is a kick
    for (const l of lines) raw.recv(l)
    assert.ok(raw.peak > 200, `raw peak ${raw.peak}`)
  })

  it('1 line/s sustained goes out synchronously, untouched', () => {
    const bot = fakeBot()
    for (let i = 0; i < 60; i++) {
      bot.chat(`line ${i}`)
      assert.equal(bot.sent.length, i + 1)
      mock.timers.tick(1000)
    }
  })

  it('queue overflow drops the oldest plain line, never the swarm flat relay', () => {
    const bot = fakeBot()
    const log = mock.method(console, 'log', () => {})
    try {
      for (let i = 0; i < 8; i++) bot.chat(`fill ${i}`)
      bot.chat('swarm flat 16 0 0 y64 level mode by P')
      for (let i = 0; i < 25; i++) bot.chat(`progress ${i}`)
      for (let t = 0; t < 400; t++) mock.timers.tick(100)
    } finally { log.mock.restore() }
    assert.ok(bot.sent.includes('swarm flat 16 0 0 y64 level mode by P'))
    assert.equal(bot.sent.length, 8 + 20)
    assert.equal(bot.sent[8], 'swarm flat 16 0 0 y64 level mode by P')
    assert.ok(!bot.sent.includes('progress 0'), 'oldest plain line dropped')
    assert.equal(bot.sent.at(-1), 'progress 24')
    assert.ok(bot.srv.peak <= 200, `peak ${bot.srv.peak}`)
  })

  it('counts packets: a 600-char line costs 3, a command 1', () => {
    assert.equal(packets('x'.repeat(600)), 3)
    assert.equal(packets('a\nb'), 2)
    assert.equal(packets('/tell P ' + 'x'.repeat(600)), 1)
    const bot = fakeBot()
    bot.chat('x'.repeat(600)) // 3 packets, each its own send
    bot.chat('x'.repeat(600))
    bot.chat('x'.repeat(600)) // the 9th packet would pass 160: queued
    assert.equal(bot.sent.length, 8)
    assert.ok(bot.sent.every((m) => m.length <= 256))
    for (let t = 0; t < 50; t++) mock.timers.tick(100)
    assert.equal(bot.sent.length, 9)
    assert.equal(bot.sent.join(''), 'x'.repeat(1800))
  })

  it('qxql.26: one 3087-char line on an empty bucket is no kick; chat keeps 3 packets, the log keeps it all', () => {
    const line = 'castle: 40 holes: ' + Array.from({ length: 200 }, (_, i) => `${i} 64 ${i} (wall: dug)`).join(', ')
    const raw = server() // pre-fix: the whole line as packets in one go
    for (let i = 0; i < line.length; i += 256) raw.recv(line.slice(i, i + 256))
    assert.ok(raw.peak > 200, `raw peak ${raw.peak}`)
    const bot = fakeBot()
    const logs = []
    const log = mock.method(console, 'log', (m) => logs.push(m))
    try {
      bot.chat(line)
      bot.chat(line) // a repeat right after still paces
      for (let t = 0; t < 100; t++) mock.timers.tick(100)
    } finally { log.mock.restore() }
    assert.equal(bot.sent.length, 6)
    assert.ok(bot.sent.every((m) => m.length <= 256), 'each send is one packet')
    assert.ok(bot.sent[2].endsWith(' …(see log)'))
    assert.ok(bot.srv.peak <= 200, `peak ${bot.srv.peak}`)
    assert.ok(logs.some((m) => m.includes(line)), 'full report in the log')
  })

  it('qxql.26: a burst of packets never exceeds the threshold, even from an empty bucket', () => {
    const bot = fakeBot()
    for (let k = 0; k < 5; k++) bot.chat('y'.repeat(700))
    for (let t = 0; t < 200; t++) mock.timers.tick(100)
    assert.equal(bot.sent.length, 15)
    assert.ok(bot.srv.peak <= 200, `peak ${bot.srv.peak}`)
  })

  it('overflow drops a whole long message, never half of one', () => {
    const bot = fakeBot()
    const log = mock.method(console, 'log', () => {})
    try {
      for (let i = 0; i < 8; i++) bot.chat(`fill ${i}`)
      bot.chat('a'.repeat(600)) // 3 queued packets
      for (let i = 0; i < 19; i++) bot.chat(`later ${i}`)
      for (let t = 0; t < 400; t++) mock.timers.tick(100)
    } finally { log.mock.restore() }
    assert.ok(!bot.sent.some((m) => m.startsWith('a')), 'all 3 parts dropped together')
    assert.equal(bot.sent.at(-1), 'later 18')
  })

  it('a command is never split or cut', () => {
    const bot = fakeBot()
    const cmd = '/tell P ' + 'z'.repeat(900)
    bot.chat(cmd)
    assert.deepEqual(bot.sent, [cmd])
  })

  it('runOnce wraps bot.chat on login', () => {
    const { EventEmitter } = require('node:events')
    const { runOnce } = require('../src/index')
    const sent = []
    const bot = Object.assign(new EventEmitter(), { loadPlugin() {} })
    void runOnce({ host: 'x', port: 1, username: 'IdkBot', tickMs: 10, idleTickMs: 10, brain: { decide: async () => ({}) }, leaveAfterMs: 0, followName: '', createBot: () => bot, pingFn: async () => ({ players: { online: 0 } }) })
    bot.chat = (m) => sent.push(m) // mineflayer installs chat at plugin inject, before 'login'
    bot.emit('login')
    for (let i = 0; i < 13; i++) bot.chat(`l${i}`)
    assert.equal(sent.length, 8)
    // no quit: an unasked 'end' fatal()s the process; the never-spawned ticker holds nothing open
  })
})
