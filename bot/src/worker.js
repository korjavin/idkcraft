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

// The worker's player name ('' when unconfigured): chat lines address the
// delegation to it. Read at call time — tests stub it like send().
function name() {
  return cfg.name
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
      if (isSwarmBot(key)) continue
      out[key] = entry
    }
  } catch (_) { /* unreadable roster reads empty */ }
  return out
}

// Flat swarm (lhg2): with BOT_SWARM_N > 1 the swarm helpers (<prefix>1..32)
// are never players — not a target, owner or delivery recipient — and a
// helper (BOT_SWARM_I >= 1) also drops the main bot (BOT_PEER_USERNAME).
// Env read per call; swarm off = no-op. ponytail: the server ping count still
// includes the bots (hidden sample), so they keep each other on like bot+bot2.
function isSwarmBot(name, env = process.env) {
  if (typeof name !== 'string') return false
  // vewo.2: bot2 is a bot too — its flat lines are never orders, swarm or not.
  if (env.BOT2_USERNAME && name === env.BOT2_USERNAME) return true
  if (!(parseInt(env.BOT_SWARM_N || '', 10) > 1)) return false
  if (parseInt(env.BOT_SWARM_I || '0', 10) >= 1 && name === env.BOT_PEER_USERNAME) return true
  const p = env.BOT_SWARM_PREFIX || 'IdkSwarm'
  return name.startsWith(p) && /^([1-9]|[12]\d|3[0-2])$/.test(name.slice(p.length))
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

// Guided far walk (idkcraft-jlda.5): comehome/gocastle/gohome legs delegate
// the WALK only after the head's own leg failed — never first. The worker
// #gotos the goal, the head follows its entity (GoalFollow 2) on the
// pause/resume leash below. Every delegation has a deadline and falls back
// to the leg's byte-identical failure path.
//
// The leash + judge mirror the dig-in bead's (bring.js guidedTick) but live
// here so both share one implementation — except bring.js still carries its
// own copy (parallel bead jlda.11 owns that file; unification is deferred,
// see the report). This walk copy is standalone: no require back into
// bring.js, internal deps lazy-required so the unconfigured path stays a
// no-op with zero new load-time edges.
const WALK_FAR_BLOCKS = 32 // legs at or under this never delegate
const WALK_TOTAL_MS = 240000 // whole delegation, then the leg's failure path
const WALK_GONE_MS = 20000 // worker entity out of view
const WALK_STILL_MS = 30000 // worker entity not displacing (suspended while leash-paused or arrived)
const WALK_PAUSE_D = 8 // head this far behind the worker: #pause
const WALK_RESUME_D = 4 // head back within this: #resume
const WALK_ARRIVE_D = 2.5 // ab.js REACH_DIST: the worker is at its goto
const WALK_FOLLOW_RANGE = 2 // GoalFollow range behind the guiding worker
const WALK_REISSUE_MS = 6000 // re-anchor GoalFollow on the moving worker (follow.js rule)

function walkAvailable(bot) {
  try {
    // Via the exports (not the closures) so unit tests stub like bring.js.
    return module.exports.configured() && module.exports.workerOnline(bot)
  } catch (_) {
    return false
  }
}

// The night range is retreat.HOME_WALK_RANGE's single source (96) — pinned
// here, not required: worker -> retreat closes a require cycle
// (retreat -> recover -> worker, the structure gate). A test pins the two
// equal, so a retreat change fails loudly instead of drifting.
const WALK_NIGHT_RANGE = 96

// The night gate from the legs themselves (goal.js nightFarFromHome, the
// risky file this bead does not touch): at night far from home the shelter
// owns the night, so no delegation starts and a running one fails. Replica,
// not import: unreadable reads near (the old march, never a new hold).
function walkNightBlocked(bot, ctx) {
  try {
    const { timeWord } = require('./site')
    if (timeWord(bot) !== 'night') return false
    const site = ctx && ctx.home && ctx.home.site
    const bp = bot && bot.entity && bot.entity.position
    if (!site || typeof site.x !== 'number' || !bp || typeof bp.x !== 'number') return false
    return Math.hypot(bp.x - site.x, bp.z - site.z) > WALK_NIGHT_RANGE
  } catch (_) {
    return false
  }
}

// The watchdog half of the trigger (task.js owns the state, read-only
// here): the goal's metric went flat for a full window. gohome has no task
// entry (work step, not an order kind) so this half never fires for it.
function walkWatchdogFlat(ctx, kind) {
  try {
    const st = ctx && ctx.task && ctx.task[kind]
    const rounds = st && st.wd && st.wd.rounds
    return typeof rounds === 'number' && rounds >= 1
  } catch (_) {
    return false
  }
}

// Trigger: an active far leg (goal > 32 XZ away) AND (the planner said
// noPath/timeout for it, or the watchdog went flat for its kind) AND the
// worker online AND the night not owning it. Callers invoke this at their
// walk-failure point, after any via fallback, before their failure path.
function walkShouldDelegate(bot, ctx, kind, goalPos) {
  try {
    if (!walkAvailable(bot)) return false
    const bp = bot && bot.entity && bot.entity.position
    if (!bp || typeof bp.x !== 'number' || !goalPos || typeof goalPos.x !== 'number') return false
    if (Math.hypot(bp.x - goalPos.x, bp.z - goalPos.z) <= WALK_FAR_BLOCKS) return false
    if (walkNightBlocked(bot, ctx)) return false
    const s = ctx && ctx.lastPathStatus
    if (s === 'noPath' || s === 'timeout') return true
    if (kind && walkWatchdogFlat(ctx, kind)) return true
    return false
  } catch (_) {
    return false
  }
}

// Ordered bridge lines: one connection per line, so chain the sends — two
// bare sends could arrive swapped and a #goto would land on a pause.
function walkSendSeq(lines) {
  void (async () => {
    for (const line of lines) {
      try { await module.exports.send(line) } catch (_) { /* next line anyway */ }
    }
  })()
}

function walkD3(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)
}

// Start a guided walk: stash the state on the leg record (a cancelled order
// drops it with the record; the worker idles and the next delegation
// re-tasks it, the bring.js self-healing shape), clear the dead walk goal,
// chat one delegation line, and #resume (a stale pause must not swallow the
// goto) + #goto. opts: { kind, label, xzOnly, key }. The caller flips its
// own phase to 'guided' and resets its stall record. Returns true.
function walkDelegate(bot, ctx, rec, goalPos, opts) {
  const o = opts && typeof opts === 'object' ? opts : {}
  const now = Date.now()
  const gx = Math.floor(goalPos.x)
  const gy = Math.floor(goalPos.y)
  const gz = Math.floor(goalPos.z)
  let gen = null
  try { gen = require('./step').stepGen(ctx) } catch (_) { gen = null }
  rec.guided = {
    at: now, goal: { x: gx, y: gy, z: gz }, xzOnly: !!o.xzOnly,
    key: typeof o.key === 'string' && o.key ? o.key : 'walk-guided',
    paused: false, goneSince: null, lastWorkerPos: null, lastMove: now,
    reissuedAt: 0, stopSent: false, gen,
  }
  try {
    const { clearGoal, say } = require('./behaviours/util')
    clearGoal(bot, ctx)
    say(bot, `asking ${module.exports.name()} to guide me ${o.label || 'there'}`)
  } catch (_) { /* chat best-effort */ }
  try {
    console.log(`guided walk kind=${o.kind || '?'} goal=${gx},${gy},${gz}${o.xzOnly ? ' xz' : ''}`)
  } catch (_) { /* log best-effort */ }
  const goto = o.xzOnly ? `msg #goto ${gx} ${gz}` : `msg #goto ${gx} ${gy} ${gz}`
  walkSendSeq(['msg #resume', goto])
  return true
}

// Park the worker after a guided walk ends. True when a #stop went out.
// No metric: done/fallback are counted at the guided outcome in walkTick.
function walkStop(rec) {
  const g = rec && rec.guided
  if (!g || g.stopSent) return false
  g.stopSent = true
  try { void module.exports.send('msg #stop') } catch (_) { /* bridge best-effort */ }
  return true
}

// Cancel a live guided walk (a stale re-pick restarts the leg): #stop the
// worker and count outcome 'cancelled'. True when a live job was dropped.
// Terminal jobs (stopSent, already counted done/fallback) are no-ops.
// Drops that null the whole record (stop/new-order, shelter preempt) have
// no record to cancel — the worker finishes its bounded #goto, idles, and
// the next delegation's resume+goto re-tasks it (the bring.js shape).
function walkCancel(rec) {
  const g = rec && rec.guided
  if (!g || g.stopSent) return false
  walkStop(rec)
  try {
    const metrics = require('./metrics')
    metrics.workerJobs.inc({ kind: 'walk', outcome: 'cancelled' })
  } catch (_) { /* metric best-effort */ }
  return true
}

// True when the guided state belongs to an older step instance (the step
// was preempted away and re-picked: fight never bumps the gen, a fresh pick
// does). The caller restarts its walk instead of failing stale at once.
// Unreadable gens fail open to resume (the old tick continues).
function walkStale(rec, ctx) {
  try {
    const g = rec && rec.guided
    if (!g || typeof g.gen !== 'number') return false
    return require('./step').stepGen(ctx) !== g.gen
  } catch (_) {
    return false
  }
}

// One guided tick. arrived(bp) is the leg's own arrival predicate — when it
// fires the leg's existing success path takes over next tick. Returns
// 'walk' (keep guiding), 'done' (head arrived: #stop, metric done) or
// 'failed' (gone/still/total/night: #stop, metric fallback, the caller runs
// its byte-identical failure path). Terminal returns leave rec.guided set
// (stopSent latched); the caller clears it on the transition.
function walkTick(bot, ctx, rec, bp, arrived) {
  const g = rec && rec.guided
  if (!g || !g.goal || !bp) return 'failed'
  const now = Date.now()
  const done = (outcome) => {
    walkStop(rec)
    try {
      const metrics = require('./metrics')
      metrics.workerJobs.inc({ kind: 'walk', outcome })
    } catch (_) { /* metric best-effort */ }
    return outcome === 'done' ? 'done' : 'failed'
  }
  if (now - g.at >= WALK_TOTAL_MS) return done('fallback')
  if (walkNightBlocked(bot, ctx)) return done('fallback')
  let w = null
  try { w = module.exports.workerEntity(bot) } catch (_) { w = null }
  const wpos = w && w.position ? w.position : null
  if (!wpos) {
    if (g.goneSince === null || g.goneSince === undefined) g.goneSince = now
    if (now - g.goneSince >= WALK_GONE_MS) return done('fallback')
    return 'walk' // hold the last follow goal while it is out of view
  }
  g.goneSince = null
  let home = false
  try { home = typeof arrived === 'function' ? !!arrived(bp) : false } catch (_) { home = false }
  if (home) return done('done')
  const waiting = walkD3(wpos, g.goal) <= WALK_ARRIVE_D
  if (waiting) {
    // The worker is at the goal waiting: the still clock cannot fail a head
    // still en route, and a pause is meaningless (it already stopped). Once
    // the head closes to leash range the follow goal (range 2) can already
    // be satisfied 2 out on an axis — outside the leg's 1.5 arrival — so
    // hand over to the leg's own walk for the last meters instead of
    // idling to the 240 s total (revmux 01 core-1).
    const d = walkD3(bp, wpos)
    if (d <= WALK_RESUME_D) return done('done')
    g.lastMove = now
    g.lastWorkerPos = { x: wpos.x, y: wpos.y, z: wpos.z }
  } else {
    if (!g.paused) {
      if (!g.lastWorkerPos || walkD3(wpos, g.lastWorkerPos) > 0.5) {
        g.lastWorkerPos = { x: wpos.x, y: wpos.y, z: wpos.z }
        g.lastMove = now
      } else if (now - (g.lastMove || g.at) >= WALK_STILL_MS) return done('fallback')
    }
    const d = walkD3(bp, wpos)
    // Both transitions restart the still clock: a 30 s+ pause must not fail
    // the job on the first tick after resume.
    if (!g.paused && d > WALK_PAUSE_D) {
      g.paused = true
      g.lastMove = now
      g.lastWorkerPos = { x: wpos.x, y: wpos.y, z: wpos.z }
      try { void module.exports.send('msg #pause') } catch (_) { /* bridge best-effort */ }
    } else if (g.paused && d < WALK_RESUME_D) {
      g.paused = false
      g.lastMove = now
      g.lastWorkerPos = { x: wpos.x, y: wpos.y, z: wpos.z }
      try { void module.exports.send('msg #resume') } catch (_) { /* bridge best-effort */ }
    }
  }
  try {
    const { goals } = require('mineflayer-pathfinder')
    const { issueGoal } = require('./behaviours/util')
    if (g.key !== ctx.lastGoalKey) {
      issueGoal(bot, ctx, new goals.GoalFollow(w, WALK_FOLLOW_RANGE), g.key, true)
      g.reissuedAt = now
    } else if (now - (g.reissuedAt || 0) >= WALK_REISSUE_MS) {
      try { bot.pathfinder.setGoal(new goals.GoalFollow(w, WALK_FOLLOW_RANGE), true) } catch (_) { /* body best-effort */ }
      g.reissuedAt = now
    }
  } catch (_) { /* body best-effort: retry next tick */ }
  return 'walk'
}

module.exports = { configure, configured, name, isWorker, isSwarmBot, players, workerEntity, workerOnline, send, ensureJoined, leave, JOIN_ABSENT_MS, JOIN_RESEND_MS, SEND_TIMEOUT_MS, walkAvailable, walkNightBlocked, walkWatchdogFlat, walkShouldDelegate, walkDelegate, walkStop, walkCancel, walkStale, walkTick, WALK_FAR_BLOCKS, WALK_TOTAL_MS, WALK_GONE_MS, WALK_STILL_MS, WALK_PAUSE_D, WALK_RESUME_D, WALK_ARRIVE_D, WALK_FOLLOW_RANGE, WALK_REISSUE_MS, WALK_NIGHT_RANGE }
