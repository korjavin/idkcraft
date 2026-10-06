'use strict'
// PUPPET PLAYER (idkcraft-jlw7): agents run real prod play sessions without
// the owner. A long-running mineflayer client joins as PUPPET_NAME (default
// IdkTester) and takes the owner's place at the keyboard: commands go through
// the real chat path, so entity-needing orders (follow me, build here, bring
// me) work, and the puppet counts as roster for work mode. Zero bot changes.
// Usage: node puppet.js [--host=H] [--port=P] [--name=N] [--bot-name=B]
//   [--http-port=HP] [--log=PATH] [--idle-ms=MS]
// Env: PUPPET_HOST (localhost), PUPPET_PORT (25565), PUPPET_NAME (IdkTester),
//   BOT_USERNAME (IdkBot, the prod bot to ignore in the roster),
//   PUPPET_HTTP_PORT (18080), PUPPET_LOG (/tmp/idkcraft-puppet-<pid>.jsonl),
//   PUPPET_IDLE_MS (900000, 15 min). Argv wins over env. The prod host/port
//   NEVER live here — env/argv only (privacy rule).
// Control is HTTP on localhost ONLY (never exposed):
//   POST /say {text}            chat it, as if the owner typed it
//   POST /goto {x,y,z} | {player}  pathfinder walk (prod-safe: never digs/places)
//   POST /look {yaw,pitch}      turn the head
//   POST /stop                  stand still, drop the goal
//   GET  /state[?n=N]           puppet pos/health, bot pos+dist if visible,
//                               roster, last N chat lines (default 20, max 100)
//   POST /quit                  leave the server, close down, exit 0
// Every control call (say/goto/look/stop — polls of /state are neither
// logged nor idle-resetting) and every chat line heard appends to the JSONL
// transcript. Yield to humans (owner requirement): a roster entry other than
// the puppet and BOT_USERNAME (exact match, the index.js:505 semantics — a
// Bedrock '.Name' is just a roster key) makes the puppet say goodbye and
// leave within 2 s; the HTTP server stays up and later control calls return
// 409. A human already on at connect refuses with exit 2 and no join (ping
// sample first, post-spawn roster re-scan as the backstop). No control call
// for PUPPET_IDLE_MS quits the process, so a crashed agent cannot leave the
// puppet on prod forever. Exit codes: 0 = /quit or idle timeout, 1 = error,
// 2 = human online (pre-connect refuse; the mid-session yield keeps HTTP up
// until /quit and /quit still exits 0).
const http = require('node:http')
const fs = require('node:fs')
const mineflayer = require('mineflayer')
const mc = require('minecraft-protocol')
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder')

const EXIT_HUMAN = 2
const EXIT_ERROR = 1
const DEFAULTS = {
  host: 'localhost', port: 25565, name: 'IdkTester', botName: 'IdkBot',
  httpPort: 18080, idleMs: 15 * 60 * 1000, chatKeep: 200, chatDefault: 20, chatMax: 100,
}
const GOODBYE = 'human online — leaving, bye!'
const YIELD_QUIT_MS = 500 // goodbye chat flush before the MC quit (< 2 s)
const BODY_LIMIT = 64 * 1024

// Humans on the roster: anyone but the puppet and the bot. Exact match, the
// index.js:505 rosterOnline semantics — no dot-stripping, so a Bedrock
// '.Name' is human unless it literally equals the puppet/bot name.
function findHumans(names, botName, puppetName) {
  return (names || []).filter((n) => n !== botName && n !== puppetName)
}

function num(v, dflt) {
  // Absent/empty reads as unset, not zero: Number(null) is 0, which made a
  // plain GET /state return 1 chat line instead of 20 (verify #310.4).
  if (v == null || v === '') return dflt
  const n = Number(v)
  return Number.isFinite(n) ? n : dflt
}

// Argv (--k=v) wins over env wins over DEFAULTS. Pure: (argv, env) -> config.
function parseArgs(argv, env) {
  const e = env || {}
  const cfg = {
    host: e.PUPPET_HOST || DEFAULTS.host,
    port: num(e.PUPPET_PORT, DEFAULTS.port),
    name: e.PUPPET_NAME || DEFAULTS.name,
    botName: e.BOT_USERNAME || DEFAULTS.botName,
    httpPort: num(e.PUPPET_HTTP_PORT, DEFAULTS.httpPort),
    log: e.PUPPET_LOG || `/tmp/idkcraft-puppet-${process.pid}.jsonl`,
    idleMs: num(e.PUPPET_IDLE_MS, DEFAULTS.idleMs),
  }
  for (const a of argv || []) {
    const m = /^--([a-z-]+)=(.*)$/.exec(a)
    if (!m) throw new Error(`bad arg ${JSON.stringify(a)} (want --k=v)`)
    const v = m[2]
    if (m[1] === 'host') cfg.host = v
    else if (m[1] === 'port') cfg.port = num(v, NaN)
    else if (m[1] === 'name') cfg.name = v
    else if (m[1] === 'bot-name') cfg.botName = v
    else if (m[1] === 'http-port') cfg.httpPort = num(v, NaN)
    else if (m[1] === 'log') cfg.log = v
    else if (m[1] === 'idle-ms') cfg.idleMs = num(v, NaN)
    else throw new Error(`unknown arg --${m[1]}`)
  }
  if (!cfg.host) throw new Error('empty host')
  if (!Number.isFinite(cfg.port) || cfg.port <= 0 || cfg.port > 65535) throw new Error(`bad port ${JSON.stringify(cfg.port)}`)
  if (!cfg.name || cfg.name.length > 16) throw new Error('name must be 1..16 chars (MC cap)')
  if (!cfg.botName) throw new Error('empty bot name')
  if (!Number.isFinite(cfg.httpPort) || cfg.httpPort <= 0 || cfg.httpPort > 65535) throw new Error(`bad http-port ${JSON.stringify(cfg.httpPort)}`)
  if (!cfg.log) throw new Error('empty log path')
  if (!Number.isFinite(cfg.idleMs) || cfg.idleMs < 1000) throw new Error(`bad idle-ms ${JSON.stringify(cfg.idleMs)} (min 1000)`)
  return cfg
}

function send(res, status, obj) {
  const body = `${JSON.stringify(obj)}\n`
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) })
  res.end(body)
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0
    const parts = []
    req.on('data', (c) => {
      size += c.length
      if (size > BODY_LIMIT) { reject(new Error('body too large')); req.destroy(); return }
      parts.push(c)
    })
    req.on('end', () => {
      if (parts.length === 0) { resolve({}); return }
      try { resolve(JSON.parse(Buffer.concat(parts).toString('utf8'))) }
      catch (_) { reject(new Error('invalid JSON')) }
    })
    req.on('error', reject)
  })
}

// The localhost HTTP control plane. hooks: gate() -> null (open) or
// { status, error } (409 yielded / 503 not connected); say/goto/look/stop/
// quit/state do the work; logCall(line) transcripts the control call;
// idleMs + onIdle() are the crashed-agent watchdog. The watchdog lives here
// (armed at listen, re-armed by every mutating arrival) so no connect/spawn
// path can skip it — a yield on first spawn still quits (verify #310.3).
// All seams injected, so tests drive the real HTTP + gating with a fake
// puppet and no MC server.
function startControlServer(httpPort, hooks) {
  let idleTimer = null
  const rearm = () => {
    if (idleTimer) clearTimeout(idleTimer)
    idleTimer = setTimeout(() => {
      idleTimer = null
      try { hooks.onIdle() } catch (_) { /* watchdog best-effort */ }
    }, hooks.idleMs)
    if (typeof idleTimer.unref === 'function') idleTimer.unref()
  }
  rearm()
  const server = http.createServer(async (req, res) => {
    try {
      const u = new URL(req.url || '/', 'http://localhost')
      const path = u.pathname
      const mutating = req.method === 'POST' && (path === '/say' || path === '/goto' || path === '/look' || path === '/stop')
      if (mutating) {
        try { rearm() } catch (_) { /* idle best-effort */ }
        const early = hooks.gate()
        let body = null
        try { body = await readBody(req) } catch (e) {
          hooks.logCall({ path, body: null, status: 400, error: e.message })
          send(res, 400, { error: e.message })
          return
        }
        // Re-check after the read: a request straddling a human join must
        // 409, not run (verify #310.2).
        const denied = early || hooks.gate()
        if (denied) {
          hooks.logCall({ path, body, status: denied.status, error: denied.error })
          send(res, denied.status, { error: denied.error })
          return
        }
        try {
          const out = await hooks[path.slice(1)](body, u)
          hooks.logCall({ path, body, status: out.status, error: out.error })
          send(res, out.status, out.error ? { error: out.error } : (out.body || { ok: true }))
        } catch (e) {
          hooks.logCall({ path, body, status: 500, error: String((e && e.message) || e) })
          send(res, 500, { error: String((e && e.message) || e) })
        }
        return
      }
      if (req.method === 'GET' && path === '/state') {
        const n = Math.min(DEFAULTS.chatMax, Math.max(1, num(u.searchParams.get('n'), DEFAULTS.chatDefault)))
        send(res, 200, hooks.state(n))
        return
      }
      if (req.method === 'POST' && path === '/quit') {
        send(res, 200, { ok: true })
        hooks.quit()
        return
      }
      if ((path === '/say' || path === '/goto' || path === '/look' || path === '/stop' || path === '/quit' || path === '/state')) {
        send(res, 405, { error: 'method not allowed' })
        return
      }
      send(res, 404, { error: 'unknown path' })
    } catch (_) {
      try { send(res, 500, { error: 'internal error' }) } catch (_) { /* socket gone */ }
    }
  })
  // Localhost only: the control plane must never listen on a public iface.
  server.on('close', () => { if (idleTimer) clearTimeout(idleTimer) })
  return new Promise((resolve, reject) => {
    server.on('error', reject)
    server.listen(httpPort, 'localhost', () => resolve(server))
  })
}

// Prod-safe feet (verify #310.1): the puppet walks prod ground — canDig off,
// no 1x1 towers, and an emptied scaffolding list (countScaffoldingItems reads
// 0, so every toPlace move is refused) — a /goto through a wall fails
// instead of griefing, even holding dirt.
function puppetMovements(bot) {
  const mov = new Movements(bot)
  mov.canDig = false
  mov.allow1by1towers = false
  mov.scafoldingBlocks = []
  return mov
}

async function main() {
  let cfg
  try { cfg = parseArgs(process.argv.slice(2), process.env) } catch (e) {
    console.error(`puppet: ${e.message}`)
    process.exit(EXIT_ERROR)
  }
  const logLine = (obj) => {
    try { fs.appendFileSync(cfg.log, `${JSON.stringify({ t: new Date().toISOString(), ...obj })}\n`) } catch (e) {
      console.error(`puppet: transcript write failed: ${e.message}`)
    }
  }
  // Refuse before joining when the ping sample already shows a human. The
  // sample can miss players, so the post-spawn roster scan stays the
  // backstop; a ping failure is not a verdict — the join fails loudly.
  try {
    const st = await mc.ping({ host: cfg.host, port: cfg.port })
    const sample = (st && st.players && Array.isArray(st.players.sample) ? st.players.sample : []).map((p) => p && p.name).filter(Boolean)
    const pre = findHumans(sample, cfg.botName, cfg.name)
    if (pre.length > 0) {
      console.error(`puppet: refusing to join, human online: ${pre.join(', ')}`)
      process.exit(EXIT_HUMAN)
    }
  } catch (e) {
    console.error(`puppet: ping inconclusive (${e.message}), joining anyway`)
  }

  let state = 'connecting' // connecting | online | yielded | offline | quitting
  let goal = null
  let lastRoster = []
  const chatRing = []
  const hear = (from, msg) => {
    chatRing.push({ t: new Date().toISOString(), from: String(from), msg: String(msg) })
    if (chatRing.length > DEFAULTS.chatKeep) chatRing.splice(0, chatRing.length - DEFAULTS.chatKeep)
    logLine({ dir: 'chat', from: String(from), msg: String(msg) })
  }

  const bot = mineflayer.createBot({ host: cfg.host, port: cfg.port, username: cfg.name, auth: 'offline' })
  bot.loadPlugin(pathfinder)
  const r3 = (v) => Math.round(v * 1000) / 1000
  const posOf = (p) => (p && typeof p.x === 'number' ? { x: r3(p.x), y: r3(p.y), z: r3(p.z) } : null)

  const snapshot = (n) => {
    const bp = bot.entity ? posOf(bot.entity.position) : null
    const botP = (bot.players || {})[cfg.botName]
    const botPos = botP && botP.entity ? posOf(botP.entity.position) : null
    let dist = null
    if (bp && botPos) dist = r3(Math.hypot(bp.x - botPos.x, bp.y - botPos.y, bp.z - botPos.z))
    return {
      state, connected: state === 'online',
      pos: bp, health: typeof bot.health === 'number' ? bot.health : null,
      food: typeof bot.food === 'number' ? bot.food : null,
      bot: { name: cfg.botName, pos: botPos, dist },
      roster: lastRoster.slice(), humans: findHumans(lastRoster, cfg.botName, cfg.name),
      goal, moving: !!(bot.pathfinder && typeof bot.pathfinder.isMoving === 'function' && bot.pathfinder.isMoving()),
      chat: chatRing.slice(-n), transcript: cfg.log,
    }
  }

  let server = null
  const onIdle = () => {
    logLine({ dir: 'event', event: 'idle', detail: `no control call for ${cfg.idleMs} ms` })
    shutdown(0, 'idle timeout')
  }
  const shutdown = (code, why) => {
    if (state === 'quitting') return
    state = 'quitting'
    logLine({ dir: 'event', event: 'quit', detail: why })
    try { bot.quit(String(why || 'quit')) } catch (_) { /* already gone */ }
    const done = () => process.exit(code)
    try { if (server) server.close(() => done()); else done() } catch (_) { done() }
    setTimeout(done, 1000).unref()
  }

  // Yield (owner requirement): goodbye, off the server inside 2 s, HTTP
  // stays up answering 409 so the agent sees the reason, not a hangup.
  const yieldTo = (humans) => {
    if (state === 'yielded' || state === 'quitting') return
    const wasOnline = state === 'online'
    state = 'yielded'
    goal = null
    logLine({ dir: 'event', event: 'yield', detail: `human online: ${humans.join(', ')}` })
    try { if (wasOnline) bot.chat(GOODBYE) } catch (_) { /* say best-effort */ }
    setTimeout(() => { try { bot.quit('human online') } catch (_) { /* already gone */ } }, YIELD_QUIT_MS)
  }
  const scanRoster = () => {
    lastRoster = Object.keys(bot.players || {})
    return findHumans(lastRoster, cfg.botName, cfg.name)
  }

  bot.on('chat', (username, message) => hear(username, message))
  bot.on('playerJoined', (player) => {
    const humans = scanRoster()
    const joined = player && player.username
    if (joined && joined !== cfg.name && joined !== cfg.botName) {
      console.log(`puppet: human joined (${joined}), yielding`)
      yieldTo(humans.length > 0 ? humans : [joined])
    }
  })
  bot.on('playerLeft', () => scanRoster())
  // Mineflayer re-emits spawn after every death-respawn: only the first one
  // sets up (revmux 01 core-1). The idle clock needs no arming here — the
  // control server armed it at listen on every path (verify #310.3).
  let spawnedOnce = false
  bot.on('spawn', () => {
    scanRoster()
    const humans = findHumans(lastRoster, cfg.botName, cfg.name)
    if (humans.length > 0) {
      console.log(`puppet: human already online (${humans.join(', ')}), yielding`)
      yieldTo(humans)
      return
    }
    state = 'online'
    if (spawnedOnce) {
      logLine({ dir: 'event', event: 'respawn', detail: 'auto-respawned' })
      return
    }
    spawnedOnce = true
    try {
      bot.pathfinder.setMovements(puppetMovements(bot))
    } catch (e) { console.error(`puppet: movements failed: ${e.message}`) }
    logLine({ dir: 'event', event: 'ready', detail: `spawned as ${cfg.name}` })
    console.log(`puppet: spawned as ${cfg.name}, control at http://localhost:${cfg.httpPort}, transcript ${cfg.log}`)
    // Login-time roster race: a tab-list straggler reads as nobody here,
    // so re-scan once — a missed human still yields within seconds.
    setTimeout(() => {
      if (state !== 'online') return
      const late = scanRoster()
      if (late.length > 0) {
        console.log(`puppet: late roster human (${late.join(', ')}), yielding`)
        yieldTo(late)
      }
    }, 2000).unref()
  })
  const onEnd = (why) => {
    scanRoster()
    if (state === 'online' || state === 'connecting') {
      state = 'offline'
      logLine({ dir: 'event', event: 'end', detail: String(why || 'connection lost') })
      console.error(`puppet: connection lost (${why || 'end'}), control stays up — POST /quit to exit`)
    }
  }
  bot.on('end', (reason) => onEnd(reason))
  bot.on('kicked', (reason) => onEnd(`kicked: ${reason}`))
  bot.on('error', (e) => {
    if (state === 'connecting') {
      console.error(`puppet: connect failed: ${(e && e.message) || e}`)
      try { if (server) server.close() } catch (_) { /* close best-effort */ }
      process.exit(EXIT_ERROR)
    }
    console.error(`puppet: bot error: ${(e && e.message) || e}`)
  })

  const gate = () => {
    if (state === 'yielded') return { status: 409, error: 'human online' }
    if (state !== 'online') return { status: 503, error: state === 'offline' ? 'not connected' : state }
    return null
  }
  const hooks = {
    gate, state: snapshot, idleMs: cfg.idleMs, onIdle,
    logCall: ({ path, body, status, error }) => logLine({ dir: 'in', path, body, status, error }),
    say: async (body) => {
      const text = body && body.text
      if (typeof text !== 'string' || text.length === 0 || text.length > 256) return { status: 400, error: 'text must be a 1..256 char string' }
      bot.chat(text)
      return { status: 200 }
    },
    goto: async (body) => {
      if (body && typeof body.player === 'string' && body.player) {
        const p = (bot.players || {})[body.player]
        const ent = p && p.entity
        if (!ent) return { status: 404, error: `player not visible: ${body.player}` }
        bot.pathfinder.setGoal(new goals.GoalFollow(ent, 2), true)
        goal = { player: body.player }
        return { status: 200, body: { ok: true, goal } }
      }
      const x = body && body.x
      const y = body && body.y
      const z = body && body.z
      if (![x, y, z].every((v) => typeof v === 'number' && Number.isFinite(v))) {
        return { status: 400, error: 'want {x,y,z} numbers or {player}' }
      }
      bot.pathfinder.setGoal(new goals.GoalNear(Math.floor(x), Math.floor(y), Math.floor(z), 1), true)
      goal = { x: Math.floor(x), y: Math.floor(y), z: Math.floor(z) }
      return { status: 200, body: { ok: true, goal } }
    },
    look: async (body) => {
      const yaw = body && body.yaw
      const pitch = body && body.pitch
      if (typeof yaw !== 'number' || !Number.isFinite(yaw) || typeof pitch !== 'number' || !Number.isFinite(pitch)) {
        return { status: 400, error: 'want {yaw,pitch} numbers' }
      }
      await bot.look(yaw, pitch, true)
      return { status: 200 }
    },
    stop: async () => {
      goal = null
      try { bot.clearControlStates() } catch (_) { /* stop best-effort */ }
      try { bot.pathfinder.setGoal(null) } catch (_) { /* goal best-effort */ }
      return { status: 200 }
    },
    quit: () => shutdown(0, 'agent quit'),
  }
  try {
    server = await startControlServer(cfg.httpPort, hooks)
  } catch (e) {
    console.error(`puppet: control listen failed: ${e.message}`)
    process.exit(EXIT_ERROR)
  }
  console.log(`puppet: connecting to ${cfg.host}:${cfg.port} as ${cfg.name} (bot ${cfg.botName})`)
  process.on('SIGINT', () => shutdown(0, 'SIGINT'))
  process.on('SIGTERM', () => shutdown(0, 'SIGTERM'))
}

module.exports = { findHumans, parseArgs, startControlServer, puppetMovements, DEFAULTS, GOODBYE, EXIT_HUMAN, EXIT_ERROR }

if (require.main === module) {
  main().catch((e) => { console.error(`puppet: fatal: ${(e && e.message) || e}`); process.exit(EXIT_ERROR) })
}
