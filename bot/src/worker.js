'use strict'

// Hybrid body (idkcraft-jlda.2): the head owns a Baritone worker — a real
// headless Java client that only MOVES (long walks, tunnel bores) while the
// head follows it and keeps every item-touching action. This module is the
// head side: env-gated, write-only TCP line bridge (socat -> the HMC console
// FIFO on the worker container), no reply is ever read.
//
// Env (read once at createTicker via configure()): WORKER_NAME (the worker's
// player name), WORKER_HOST (default baritone), WORKER_PORT (default 7777).
// The connect line carries MC_HOST/MC_PORT (defaults mc/25565). Empty
// WORKER_NAME -> every export is a no-op: no socket, no log, zero behaviour
// diff (the whole suite + the stuck baseline run that way).
//
// Roster landmine (epic point 5): the worker must NEVER count as a player.
// players() is the single sieve — roster minus self and worker — and every
// bot.players read outside this file goes through it. isWorker stays an
// exact match (a Java client; no Floodgate dot tolerance). bot.players is
// deliberately NOT proxied at the packet level: mineflayer's entity plugin
// writes bot.players[name].entity on spawn and the head needs the worker
// entity to follow it later.
const net = require('net')

const DEFAULT_HOST = 'baritone'
const DEFAULT_PORT = 7777
const DEFAULT_MC_HOST = 'mc'
const DEFAULT_MC_PORT = '25565'
// One bridge attempt may never stall the tick past this.
const SEND_TIMEOUT_MS = 1000
// Absent this long before the first connect, and at most one connect per
// this long: a connect resent mid-login restarts the handshake.
const JOIN_ABSENT_MS = 30000
const JOIN_RESEND_MS = 30000

const cfg = { name: '', host: DEFAULT_HOST, port: DEFAULT_PORT, mcHost: DEFAULT_MC_HOST, mcPort: DEFAULT_MC_PORT }
let absentSince = null
let lastConnectAt = 0
let joinOnline = false

function configure(env) {
  const e = env || {}
  cfg.name = String(e.WORKER_NAME || '').trim()
  cfg.host = String(e.WORKER_HOST || DEFAULT_HOST).trim() || DEFAULT_HOST
  const port = parseInt(e.WORKER_PORT || String(DEFAULT_PORT), 10)
  cfg.port = Number.isFinite(port) && port > 0 ? port : DEFAULT_PORT
  cfg.mcHost = String(e.MC_HOST || DEFAULT_MC_HOST).trim() || DEFAULT_MC_HOST
  cfg.mcPort = String(e.MC_PORT || DEFAULT_MC_PORT).trim() || DEFAULT_MC_PORT
  absentSince = null
  lastConnectAt = 0
  joinOnline = false
}

function configured() {
  return cfg.name !== ''
}

function isWorker(name) {
  return cfg.name !== '' && typeof name === 'string' && name === cfg.name
}

// The tab-list roster minus the bot itself and the worker. A fresh object
// every call (rosters are tiny); never null, so lookups stay guard-free.
function players(bot) {
  const out = {}
  try {
    const roster = (bot && bot.players) || {}
    // A bot without a name (unit mocks) has no self to drop: comparing
    // against undefined would eat every nameless entry with it.
    const self = (bot && bot.username) || null
    for (const key of Object.keys(roster)) {
      if (self !== null && key === self) continue
      const entry = roster[key]
      if (self !== null && entry && entry.username === self) continue
      if (isWorker(key) || (entry && isWorker(entry.username))) continue
      out[key] = entry
    }
  } catch (_) { /* unreadable roster reads empty */ }
  return out
}

function workerEntity(bot) {
  try {
    if (cfg.name === '') return null
    const p = bot && bot.players && bot.players[cfg.name]
    return (p && p.entity) || null
  } catch (_) {
    return null
  }
}

// In the tab list (bot.players has the key), entity or not.
function workerOnline(bot) {
  try {
    if (cfg.name === '') return false
    return !!(bot && bot.players && bot.players[cfg.name])
  } catch (_) {
    return false
  }
}

// Write-only bridge: connect, one line + '\n', end. Never throws, never
// rejects; resolves true only when the line flushed. Exactly one log line
// per attempted call; unconfigured calls resolve false silently.
function send(line) {
  if (cfg.name === '') return Promise.resolve(false)
  const text = String(line)
  return new Promise((resolve) => {
    let sock = null
    let settled = false
    const done = (ok) => {
      if (settled) return
      settled = true
      try { if (sock) sock.destroy() } catch (_) { /* already gone */ }
      try { console.log(`worker send ${text} ok=${ok}`) } catch (_) { /* log best-effort */ }
      resolve(ok)
    }
    try {
      sock = net.connect({ host: cfg.host, port: cfg.port })
      sock.setTimeout(SEND_TIMEOUT_MS)
      sock.once('connect', () => {
        try {
          // end() flushes before FIN; the callback is the only true: a
          // destroy-before-flush would drop the line on the floor.
          sock.end(text + '\n', () => done(true))
        } catch (_) {
          done(false)
        }
      })
      sock.once('timeout', () => done(false))
      sock.once('error', () => done(false))
      // A close before connect (refused/reset) reads false; after done(true)
      // the settled guard eats it.
      sock.once('close', () => done(false))
    } catch (_) {
      done(false)
    }
  })
}

// Head-owned join, called every tick from tickPrelude: worker configured,
// absent from the tab list for > 30 s -> 'connect mc 25565', at most one
// per 30 s. Returns the in-flight send promise, or null when nothing was
// sent (the tick never awaits it; send never rejects). Logs state changes
// only — the send itself logs its own line.
function ensureJoined(bot, now) {
  if (cfg.name === '') return null
  const t = typeof now === 'number' ? now : Date.now()
  let online = false
  try {
    online = workerOnline(bot)
  } catch (_) {
    return null
  }
  if (online) {
    if (!joinOnline) {
      try { console.log('worker online') } catch (_) { /* log best-effort */ }
    }
    joinOnline = true
    absentSince = null
    return null
  }
  if (joinOnline) {
    try { console.log('worker offline') } catch (_) { /* log best-effort */ }
  }
  joinOnline = false
  if (absentSince === null) absentSince = t
  if (t - absentSince > JOIN_ABSENT_MS && t - lastConnectAt >= JOIN_RESEND_MS) {
    lastConnectAt = t
    return send(`connect ${cfg.mcHost} ${cfg.mcPort}`)
  }
  return null
}

// Head-owned leave: before the head quits for nobody-online and on SIGTERM,
// so the worker never keeps the server "occupied" after the head is gone.
function leave() {
  if (cfg.name === '') return Promise.resolve(false)
  return send('disconnect')
}

module.exports = { configure, configured, isWorker, players, workerEntity, workerOnline, send, ensureJoined, leave, JOIN_ABSENT_MS, JOIN_RESEND_MS, SEND_TIMEOUT_MS }
