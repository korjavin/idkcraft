'use strict'

// CASTLE-RIG (idkcraft-vmzq.20): unattended-build throughput harness. Run via
// castle-rig.sh (boots a disposable Paper, flattens nothing itself — the pad
// is built here). Flow: guide + follower join, a dirt pad is flattened at
// CASTLE_PAD, the follower's kit is emptied, the guide chats `autonomous on`
// + `build castle` through the real chat path, the guide quits (prod-alone
// parity: nobody online, autonomous on), the bot works CASTLE_MINS, and the
// run prints ONE verdict line plus a JSON record (CASTLE_OUT).
//
// The bot runs the REAL stack (index.runOnce) on real Paper physics:
// gather/craft/equip/fetch/build all run. The planner is the REAL JEV by
// default (RIG_PLANNER=jev, idkcraft-vmzq.23): the key arrives as
// TYPESAFE_API_KEY (never printed, never logged), the tick brain steps
// down to stub once the guide quits (prod-alone parity) while plan()
// keeps reaching JEV. RIG_PLANNER=stub keeps the deterministic stub brain
// for tests that need no network.
// Day is locked by the wrapper (gamerule), so the window measures work, not
// shelter. No baseline judging: this is a measurement loop instrument, the
// verdict line is the product.
//
// Env: CASTLE_HOST (localhost), CASTLE_PORT (25581),
//   CASTLE_CONTAINER (idk-castle), CASTLE_TAG (c + pid digits),
//   CASTLE_MINS (30), CASTLE_PAD ("300,300"), CASTLE_PADSPOT ("x,z", pins the
//   pad probe pick — controlled pairs set it on both legs), CASTLE_OUT (json path),
//   CASTLE_LOG (full log path; stdout keeps goal/need/blocked/death lines).
//   RIG_PLANNER (jev|stub, default jev), TYPESAFE_API_KEY (jev bearer).
//   CASTLE_NIGHT (1 = night mode, set by castle-rig.sh --night: the
//   wrapper skips the day lock, createNightDriver runs the nights).
//   CASTLE_SEED (complete = g0z.33: rcon-place the whole v2 castle + beds
//   + table on the pad, no order; the bot adopts it as its residence and
//   createResidenceNights reports entered/slept/shelter/deaths/dawn-exit).
//   CASTLE_IDLE (1 = 6x7.24, needs CASTLE_SEED=complete: the verdict adds
//   idle-maxdist/idle-miny/idle-underground-s, yard-litter=N (g0z.44: own
//   blocks left in the fence band, placedByBot + rcon readback) and a
//   CASTLE-RIG idle: PASS|FAIL line; FAIL exits 1).
//   CASTLE_IDLE_DEATH (N > 0 = 6x7.25, with CASTLE_IDLE: after N min the
//   follower is cleared and killed once, respawning with an empty kit
//   IDLE_RESPAWN_DIST blocks from home on the line to the world spawn —
//   the prod 10-09 drift path (home 23,65,7, world spawn ~225 off; the
//   rig pad is ~600 from it, a walk that eats the day). The seed adds the
//   decor (panes + banners) so castlefetch stays idle. That death is not
//   counted against the verdict; tracking pauses until the bot is back
//   within the leash (idle-rehome) and a never-back run FAILs).
//   CASTLE_SAND (1 = g0z.38: a 6x3x6 sand patch on a dirt base just east
//   of the pad, top flush with it — the pad has no sand of its own; with
//   CASTLE_SEED=complete the verdict adds panes=<laid>/44 and
//   upper-fence=<laid>/109 (g0z.45)).
// Exit: 0 = measured (even at 0 laid — the line says so),
//   1 = CASTLE_IDLE verdict FAIL,
//   2 = environment/setup failure (spawn, pad, order, dropped follower,
//   jev without a key).

const mineflayer = require('mineflayer')
const Vec3 = require('vec3')
const fs = require('node:fs')
const { execFile } = require('node:child_process')
const { promisify } = require('node:util')

const execFileAsync = promisify(execFile)

const HOST = process.env.CASTLE_HOST || 'localhost'
const PORT = parseInt(process.env.CASTLE_PORT || '25581', 10)
const CONTAINER = process.env.CASTLE_CONTAINER || 'idk-castle'
const TAG = process.env.CASTLE_TAG || `c${Math.floor(Math.random() * 1000)}`
const GUIDE = `CastleGuide${TAG}`
const FOLLOWER = `CastleBuild${TAG}`
const MINS = Math.max(1, parseInt(process.env.CASTLE_MINS || '30', 10) || 30)
const PAD = String(process.env.CASTLE_PAD || '300,300').split(',').map(Number)
const OUT = process.env.CASTLE_OUT || `${__dirname}/last-castle.json`
const LOGFILE = process.env.CASTLE_LOG || `/tmp/castle-rig-${TAG}.log`
const KIT = process.env.CASTLE_KIT || 'empty'
const TICKRATE = process.env.CASTLE_TICKRATE || '1'
const BLOCKED = Math.max(0, parseInt(process.env.CASTLE_BLOCKED || '0', 10) || 0)
const PLANNER = process.env.RIG_PLANNER || 'jev'
const NIGHT = process.env.CASTLE_NIGHT === '1'
const SEED = process.env.CASTLE_SEED || ''
const SAND = process.env.CASTLE_SAND === '1'
const IDLE = process.env.CASTLE_IDLE === '1'
const IDLE_DEATH = IDLE ? Math.max(0, parseInt(process.env.CASTLE_IDLE_DEATH || '0', 10) || 0) : 0
// Far respawn (vmzq.29, prod run6): after CASTLE_FAR_AFTER min of the
// window the follower lands CASTLE_FAR blocks off the half-built site in a
// 3x3 pit 7 deep, dirt cleared, 64 cobble given — the walk back must pillar
// with cobble and progress must never read 0 meanwhile. 0 = off.
const FAR = Math.max(0, parseInt(process.env.CASTLE_FAR || '0', 10) || 0)
const FAR_AFTER = Math.max(1, parseInt(process.env.CASTLE_FAR_AFTER || '4', 10) || 4)
// Buried pickless (vmzq.37, prod y~37): after CASTLE_BURY_AFTER min the
// follower lands in a sealed 3x2x3 air pocket CASTLE_BURY blocks below the
// pad top, 12 off the site, every pickaxe cleared — it must craft a pick
// (or hand-dig) out and lay again. The verdict gets surfaced/resumed
// seconds. 0 = off.
const BURY = Math.max(0, parseInt(process.env.CASTLE_BURY || '0', 10) || 0)
const BURY_AFTER = Math.max(1, parseInt(process.env.CASTLE_BURY_AFTER || '4', 10) || 4)
// CASTLE_BURY_NOWOOD=1 also clears planks/logs/sticks/tables: no pick can
// be crafted, so only the bare-hand staircase (recover dig_step) gets out.
const BURY_NOWOOD = process.env.CASTLE_BURY_NOWOOD === '1'
// Pit-trapped with tools (vmzq.47, prod run7 stall962): after
// CASTLE_PIT_AFTER min a pit-guide leads the follower east past the site
// box and a CASTLE_PIT-deep open stone pit is built around it; it falls
// in with a stone pickaxe + 19 dirt (the prod kit), and every placement
// near/below the rim is refused with the prod text — recover must
// dig-staircase out instead of looping pillar_up. The verdict gets
// pit=escaped@Ns,resumed@Ms. 0 = off.
// CASTLE_PIT_REFUSE=0 keeps placements working (control: pillar escape).
// CASTLE_PIT_GOAL=level (idkcraft-i4wm) forces every stuck episode raised
// from inside the pit to carry a LEVEL coords goal (30 east at pit-floor
// height, the c698 shape: dist~30, through the open side). Organic pit
// episodes are usually high (surface fetch above) or goal-less, which climb
// out on master too — the forced goal is the only deterministic level-goal
// repro. Episodes outside the pit stay organic. Replay-only, default off.
// CASTLE_PIT_SHAPE=corner (idkcraft-i4wm): the hollow is a 3x3 with the
// settle pos in its northwest corner (walls=2, runway 2+ east and south)
// instead of the west-column landing. A wall-pressed west-column stance
// fails its shuffles (Paper rejects touch-moves), which bans via fails on
// master too.
// CASTLE_PIT_SHAPE=hall (idkcraft-i4wm): the hollow is a 5x5 centre
// landing (walls=0, runway 2+ every way) — the prod-like roomy pit where
// free-stance shuffles displace and the c698 done-loop (no fail accrual,
// no dig switch) reproduces instead of fail-banning. Same verdict; the
// staircase digs the hall sides. Replay-only, default off.
const PIT = Math.max(0, parseInt(process.env.CASTLE_PIT || '0', 10) || 0)
const PIT_AFTER = Math.max(1, parseInt(process.env.CASTLE_PIT_AFTER || '2', 10) || 2)
const PIT_REFUSE = process.env.CASTLE_PIT_REFUSE !== '0'
const PIT_GOAL = process.env.CASTLE_PIT_GOAL || ''
const PIT_SHAPE = process.env.CASTLE_PIT_SHAPE || ''

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)) }

// Carried-food census (idkcraft-vmzq.34): mirror of reflexes.js EDIBLE_FOODS
// (the source of truth — update both). The 15 s sample reads hunger + carried
// edibles so long runs evidence the food economy, not just the build.
const SAMPLE_EDIBLES = new Set([
  'bread', 'cooked_beef', 'cooked_porkchop', 'cooked_chicken', 'cooked_mutton',
  'cooked_rabbit', 'apple', 'carrot', 'baked_potato',
  'beef', 'porkchop', 'mutton', 'rabbit',
])

// Full log to a file; stdout keeps the cycle-readable lines (goal steps,
// fetch needs, blocked cells, progress, deaths, verdict). Ticker chatter
// (decision/scout/kit/eat) would bury the verdict on a 30+ min run.
const logStream = fs.createWriteStream(LOGFILE, { flags: 'w' })
const PRINT = [/^goal step=/, /^castlefetch \S+: need /, /^castle blocked /, /^castle relocate /,
  /^castle \d+\/\d+$/, /death/, /^castle-sample /, /^castle \d+\/\d+ in /,
  /^CASTLE-RIG /, /^task castle /, /no progress for/,
  /^goal watchdog /, /^goal outcome /, /^residence /]
const origLog = console.log
const origErr = console.error
const seen = { flips: 0, steps: {}, fails: {}, progress: [], said: [], wdCalls: 0, wdChoices: {}, wdFirstAt: 0, outcomes: { progress: 0, flat: 0, preempted: 0 }, timeEvents: [], timeMaxDrift: 0, step: null, nightSteps: null, shelterEps: 0 }
function resetSeen() {
  seen.shelterEps = 0
  seen.flips = 0
  seen.steps = {}
  seen.fails = {}
  seen.progress = []
  seen.said = []
  seen.wdCalls = 0
  seen.wdChoices = {}
  seen.wdFirstAt = 0
  seen.outcomes = { progress: 0, flat: 0, preempted: 0 }
  seen.timeEvents = []
  seen.timeMaxDrift = 0
  seen.step = null
  seen.nightSteps = null
}
function hookConsole() {
  console.log = (...a) => {
    const line = a.map(String).join(' ')
    try { logStream.write(line + '\n') } catch (_) { /* log best-effort */ }
    classify(line)
    if (PRINT.some((re) => re.test(line))) origLog(line)
  }
  console.error = (...a) => {
    const line = a.map(String).join(' ')
    try { logStream.write('ERR ' + line + '\n') } catch (_) { /* log best-effort */ }
    classify(line)
    origErr(line)
  }
}
// Goal-step flips castle<->castlefetch, per-step decision counts, failure
// reasons, watchdog fires + choices, commitment outcomes. Parsed from the
// bot's own log lines (in-process, loss-free). now is injectable for tests.
function classify(line, now = Date.now()) {
  let m = /^goal step=(\S+) prev=(\S+)/.exec(line)
  if (m) {
    seen.step = m[1]
    if (seen.nightSteps) seen.nightSteps.add(m[1])
    if (m[1] === 'shelter' && m[2] !== 'shelter') seen.shelterEps++
    const pair = [m[1], m[2]].sort().join('<>')
    if (pair === 'castle<>castlefetch') seen.flips++
    return
  }
  m = /^decision source=\S+ action=(\S+)/.exec(line)
  if (m) {
    seen.steps[m[1]] = (seen.steps[m[1]] || 0) + 1
    return
  }
  m = /failed:([A-Za-z0-9_-]+)/.exec(line)
  if (m) {
    const r = m[1]
    // Count step-failure reasons, not the ticker's fail-count echoes: the
    // goal line's why=step-failed and the behaviour's own failed: line each
    // fire once per finish (dedup by reason per second is overkill for a
    // top-list; the ordering is what matters).
    seen.fails[r] = (seen.fails[r] || 0) + 1
  }
  // Watchdog resolutions (vmzq.21): every `goal watchdog` line is one
  // consumed round; choice=none is a failure path (error/stale/low-conf),
  // not an intervention — counted in calls, not in choices/first.
  m = /^goal watchdog .* choice=(\S+)/.exec(line)
  if (m) {
    seen.wdCalls++
    if (m[1] !== 'none') {
      seen.wdChoices[m[1]] = (seen.wdChoices[m[1]] || 0) + 1
      if (!seen.wdFirstAt) seen.wdFirstAt = now
    }
  }
  // Commitment outcomes: progress moved the metric, flat covers flat +
  // failed:* (no goal effect either way), preempted:* never ran its course.
  m = /^goal outcome .* result=(\S+)/.exec(line)
  if (m) {
    const r = m[1]
    if (r === 'progress') seen.outcomes.progress++
    else if (r.startsWith('preempted:')) seen.outcomes.preempted++
    else seen.outcomes.flat++
  }
}

// Server-clock resync (idkcraft-vmzq.45): on MC 26.1 + /tick rate > 1 the
// server sends full clock state only on join/time-set/gamerule flips and
// thereafter one EMPTY update_time per 20 game ticks (measured on Paper
// 26.1.2: 1/s wall at rate 20, 5/s at rate 100, tick-aligned). Mineflayer
// keeps interpolating the stale rate=1 clock at 20/s wall — it never learns
// the new rate — so bot.time lags ~5x at rate 100 and the bot shelters
// through server days. The rig re-anchors on every full packet and counts
// +20 game ticks per empty while the anchor rate is > 0 (daylock fulls
// carry rate=0 and empties keep arriving on the frozen clock — counting
// those would invent time). Pre-26.1 packets (no clockUpdates), unknown
// dimensions and dimension switches stay hands-off. TICKRATE=1 tracks only:
// the gate path never writes bot.time.
// Split tap: onPacket only mutates resync state (mineflayer injects its own
// update_time listener deferred on inject_allowed, so it runs AFTER any
// listener attached at createBot and would overwrite an onPacket write).
// apply() runs on the bot 'time' event, which mineflayer's handler emits
// synchronously at its end — the correction always lands last.
const RESYNC_TICKS_PER_EMPTY = 20
const RESYNC_JUMP_TICKS = 1000 // bigger anchor moves are time-sets: re-arm silently
const RESYNC_DRIFT_TICKS = 100 // srv/bt breach: the correction stopped landing
function resyncDimName(bot, id) {
  try { return bot.registry.dimensionsById[id] && bot.registry.dimensionsById[id].name } catch (_) { return null }
}
function resyncWrite(bot, total) { // exact mirror of mineflayer time.js
  const t = Math.floor(total)
  bot.time.bigTime = BigInt(t)
  bot.time.time = t
  bot.time.timeOfDay = t % 24000
  bot.time.day = Math.floor(t / 24000)
  bot.time.isDay = bot.time.timeOfDay >= 0 && bot.time.timeOfDay < 13000
  bot.time.moonPhase = bot.time.day % 8
}
function resyncWord(daytime) { // goal.js timeWord cutoffs
  return daytime < 12000 ? 'day' : daytime <= 13000 ? 'dusk' : 'night'
}
// Circular |srv - bt| in daytime ticks, null when either clock is unreadable
// (the midnight straddle reads 10 ticks, not 23990).
function timeDrift(srv, bt) {
  if (typeof srv !== 'number' || typeof bt !== 'number' || !Number.isFinite(srv) || !Number.isFinite(bt)) return null
  const d = Math.abs(srv - bt) % 24000
  return Math.min(d, 24000 - d)
}
// onEvent({ event, server, bot, at }) — event is dusk|nightfall|dawn,
// server/bot are daytimes, at is a wall epoch. now is injectable for tests
// (classify precedent).
function createTimeResync({ write = true, onEvent = null } = {}) {
  const st = { anchor: null, rate: 0, empties: 0, dim: null, word: null, pending: null }
  const total = () => st.anchor == null ? null : st.anchor + st.empties * RESYNC_TICKS_PER_EMPTY
  const daytime = () => {
    const t = total()
    return t == null ? null : Math.floor(t) % 24000
  }
  function crossed(bot, now) {
    const d = daytime()
    if (d == null) return
    const w = resyncWord(d)
    const prev = st.word
    st.word = w
    if (!onEvent || prev == null || prev === w) return
    const fwd = (prev === 'day' && w === 'dusk') || (prev === 'dusk' && w === 'night') || (prev === 'night' && w === 'day')
    if (!fwd) return // non-forward word changes re-arm silently
    const ev = { event: w === 'dusk' ? 'dusk' : w === 'night' ? 'nightfall' : 'dawn', server: d, at: now }
    // In write mode the event waits for the next physicsTick and reports
    // the live clock as the brain would read it — never the counted value
    // (revmux 02 minor: a read-back on the line after the write agrees by
    // construction, a live-tick read can fail).
    if (write) { st.pending = ev; return }
    onEvent({ ...ev, bot: bot && bot.time ? bot.time.timeOfDay : null })
  }
  return {
    state: st,
    daytime,
    onPacket(bot, packet, now = Date.now()) {
      const cu = packet && packet.clockUpdates
      if (!Array.isArray(cu)) return // pre-26.1 absolute-time shape
      if (cu.length > 0) {
        const cur = bot && bot.game && bot.game.dimension
        const hit = cu.find((c) => resyncDimName(bot, c.id) === cur)
        const tot = hit ? Number(hit.totalTicks) : NaN
        if (!hit || !Number.isFinite(tot)) { st.anchor = null; st.word = null; st.pending = null; return }
        const prev = total()
        st.anchor = tot; st.rate = Number(hit.rate) || 0; st.empties = 0; st.dim = cur
        st.pending = null // a new anchor invalidates any queued crossing
        if (prev != null && Math.abs(tot - prev) > RESYNC_JUMP_TICKS) {
          const was = st.word
          st.word = resyncWord(daytime()) // time-set jump (a night->day set is not a dawn)
          // g0z.33 revmux 01: a FORWARD jump out of dusk/night into day is
          // the server's sleep skip (the bot alone in bed) — a dawn, or the
          // night it slept through never closes. Backward sets stay silent.
          if (onEvent && tot > prev && (was === 'dusk' || was === 'night') && st.word === 'day') {
            const ev = { event: 'dawn', server: daytime(), at: now, skip: true }
            if (write) st.pending = ev
            else onEvent({ ...ev, bot: bot && bot.time ? bot.time.timeOfDay : null })
          }
          return
        }
        crossed(bot, now) // full packet: mineflayer already wrote server truth
        return
      }
      if (st.anchor == null || !(st.rate > 0)) return // frozen (daylock) or unanchored
      if (!bot || !bot.game || bot.game.dimension !== st.dim) return // switched dimension: hands off
      st.empties++
      crossed(bot, now)
    },
    apply(bot) { // bot 'time' tap: lands after mineflayer's own write
      if (!write || st.anchor == null || !(st.rate > 0)) return
      if (!bot || !bot.game || bot.game.dimension !== st.dim) return
      resyncWrite(bot, st.anchor + st.empties * RESYNC_TICKS_PER_EMPTY)
    },
    onTick(bot) { // physicsTick tap: flushes queued crossings with the live clock
      if (!write || !st.pending || !onEvent) return
      onEvent({ ...st.pending, bot: bot && bot.time ? bot.time.timeOfDay : null })
      st.pending = null
    },
  }
}

// Night mode (idkcraft-ek69, absorbs the orchestrator's night-driver.sh):
// castle-rig.sh --night runs the natural cycle; open() at window start sets
// time 0, each nightfall goes easy + summons phantoms over the follower,
// each dawn goes peaceful and logs one night verdict (deaths during the
// night, sheltered = a shelter/rest goal step held at any point of it).
// Crossings before open() (setup) stay peaceful. cmd runs one rcon command,
// deaths() reads the follower's death count; never fails the run.
const NIGHT_SAFE_STEPS = new Set(['shelter', 'rest'])
function createNightDriver({ cmd, who, deaths, log, phantoms = 2 }) {
  const nights = []
  let armed = false
  let cur = null
  const run = (c) => Promise.resolve().then(() => cmd(c)).then(
    (o) => log(`CASTLE-RIG night-rcon [${c}]: ${String(o).trim().split('\n')[0]}`),
    (e) => log(`CASTLE-RIG night-rcon FAILED [${c}]: ${e && e.message ? e.message : e}`))
  const close = (partial) => {
    if (!cur) return null
    const steps = [...cur.steps]
    const n = { night: nights.length + 1, deaths: deaths() - cur.d0, sheltered: steps.some((s) => NIGHT_SAFE_STEPS.has(s)), steps, partial }
    nights.push(n)
    cur = null
    seen.nightSteps = null
    log(`CASTLE-RIG night ${n.night}: deaths=${n.deaths}, sheltered=${n.sheltered ? 'yes' : 'no'}, steps=${steps.join(',') || 'none'}${partial ? ' (partial)' : ''}`)
    return n
  }
  return {
    nights,
    async open() { armed = true; await run('time set 0') },
    async onEvent(ev) {
      if (!armed) return
      if (ev.event === 'nightfall' && !cur) {
        cur = { d0: deaths(), steps: new Set(seen.step ? [seen.step] : []) }
        seen.nightSteps = cur.steps
        await run('difficulty easy')
        for (let i = 0; i < phantoms; i++) await run(`execute at ${who} run summon phantom ~ ~16 ~`)
      } else if (ev.event === 'dawn' && cur) {
        close(false)
        await run('difficulty peaceful')
      }
    },
    finish() { return close(true) },
    // Verdict-line tail: nights seen, how many sheltered, deaths at night.
    tag() {
      if (!nights.length) return ', nights=0'
      return `, nights=${nights.length}, sheltered=${nights.filter((n) => n.sheltered).length}/${nights.length}, night-deaths=${nights.reduce((a, n) => a + n.deaths, 0)}`
    },
  }
}

// Residence nights (idkcraft-g0z.33, the g0z.30 acceptance): one record per
// night of a seeded complete castle, dusk to dawn — entered (inside a
// residence floor, seconds after dusk), slept (bot.isSleeping or a 'sleep'
// event), shelter episodes (goal step entries into shelter), deaths, and
// dawn-exit (seconds from dawn to the first sample off the floors; only
// owed when the bot was inside at dawn). A night passes on entered +
// slept + 0 shelter + 0 deaths + a dawn exit. t = window seconds.
function createResidenceNights({ deaths, log }) {
  const nights = []
  let armed = false
  let cur = null
  let exitWait = null
  const fmt = (n) => `CASTLE-RIG residence night ${n.night}: entered=${n.enteredS != null ? `yes@${n.enteredS}s` : 'no'}, slept=${n.slept ? 'yes' : 'no'}, ` +
    `shelter=${n.shelter}, deaths=${n.deaths}, dawn-exit=${n.dawnExitS != null ? `${n.dawnExitS}s` : n.insideAtDawn ? 'pending' : 'n/a'}` +
    `${n.partial ? ' (partial)' : ''}${n.pass != null ? (n.pass ? ', PASS' : ', FAIL') : ''}`
  const close = (t, partial) => {
    const n = {
      night: cur.night, enteredS: cur.enteredS, slept: cur.slept, shelter: seen.shelterEps - cur.sh0,
      deaths: deaths() - cur.d0, insideAtDawn: cur.inside === true, dawnExitS: null, partial, pass: null,
    }
    nights.push(n)
    cur = null
    if (!partial && n.insideAtDawn) exitWait = { n, dawnS: t }
    log(fmt(n))
  }
  const judge = (n) => { n.pass = !n.partial && n.enteredS != null && n.slept && n.shelter === 0 && n.deaths === 0 && n.dawnExitS != null }
  return {
    nights,
    open() { armed = true },
    onEvent(ev, t) {
      if (!armed) return
      if ((ev.event === 'dusk' || ev.event === 'nightfall') && !cur) {
        exitWait = null // never left all day: the dawn exit stays unset
        cur = { night: nights.length + 1, duskS: t, enteredS: null, slept: false, sh0: seen.shelterEps, d0: deaths(), inside: null }
      } else if (ev.event === 'dawn' && cur) close(t, false)
    },
    onSample(t, inside, sleeping) {
      if (cur) {
        if (inside && cur.enteredS == null) cur.enteredS = t - cur.duskS
        if (sleeping) cur.slept = true
        cur.inside = !!inside
      } else if (exitWait && !inside) {
        exitWait.n.dawnExitS = t - exitWait.dawnS
        log(`CASTLE-RIG residence night ${exitWait.n.night}: dawn-exit=${exitWait.n.dawnExitS}s`)
        exitWait = null
      }
    },
    finish(t) {
      if (cur) close(t, true)
      for (const n of nights) { judge(n); log(fmt(n)) }
    },
    tag() {
      return `, residence=${nights.filter((n) => n.pass).length}/${nights.length}`
    },
  }
}

// Idle-alone oracle (idkcraft-6x7.24, for atl.24/vmzq.63/vmzq.64): where the
// bot goes with a complete castle, nobody online, no order. Tracks max XZ
// distance from home.site (explore.anchorOf's home anchor), min feet y and
// seconds spent below home.y - 20. Pass: maxdist <= 64 + 16 (the alone
// leash plus a margin), miny >= resources.surfaceFloor (the gather/explore
// depth floor, read from the bot's own code), 0 deaths, every closed
// residence night PASS. Pure (unit-tested): t = window seconds.
const IDLE_MAXDIST = 64 + 16
const IDLE_UNDERGROUND_DY = 20
const IDLE_RESPAWN_DIST = 225
// Respawn point for the forced death: IDLE_RESPAWN_DIST from home toward
// the world spawn (the spawn itself when closer), y 150 — fall damage is
// off in the rig, the bot drops onto whatever surface is there.
function idleRespawnPoint(home, spawn) {
  const dx = spawn.x - home.x
  const dz = spawn.z - home.z
  const k = Math.min(1, IDLE_RESPAWN_DIST / (Math.hypot(dx, dz) || 1))
  return { x: Math.round(home.x + dx * k), y: 150, z: Math.round(home.z + dz * k) }
}
function createIdleTrack(home) {
  const h = home.site
  const floor = require('../src/resources').surfaceFloor({ home })
  const st = { maxdist: 0, miny: null, undergroundS: 0, lastT: null, lastUnder: false, diedS: null, rehomeS: null, paused: false, yardLitter: null }
  return {
    st,
    floor,
    // Yard litter (idkcraft-g0z.44): own blocks left in the fence band,
    // counted once after the window (placedByBot candidates, rcon
    // readback). Unset = unjudged, like an empty night list.
    setYardLitter(n) { st.yardLitter = n },
    // Forced death (6x7.25): the respawn walk from world spawn is not
    // judged; tracking resumes at the first sample back inside the leash.
    // pause() spans the kill until the body stands at the respawn point
    // (the sampler timer runs on its own: a stale or fresh position read in
    // between must not count).
    pause() { st.paused = true },
    died(t) { st.paused = false; st.diedS = t; st.rehomeS = null; st.lastT = null; st.lastUnder = false },
    onSample(t, p) {
      if (st.paused || !p || typeof p.y !== 'number') return
      const d = Math.hypot(p.x - h.x, p.z - h.z)
      if (st.diedS != null && st.rehomeS == null) {
        if (d > IDLE_MAXDIST) return
        st.rehomeS = t
      }
      if (d > st.maxdist) st.maxdist = d
      if (st.miny == null || p.y < st.miny) st.miny = p.y
      if (st.lastUnder && st.lastT != null) st.undergroundS += t - st.lastT
      st.lastUnder = p.y < h.y - IDLE_UNDERGROUND_DY
      st.lastT = t
    },
    tag() {
      const death = st.diedS == null ? '' : `, idle-death=${Math.round(st.diedS)}s, idle-rehome=${st.rehomeS == null ? 'never' : `${Math.round(st.rehomeS)}s`}`
      const yard = st.yardLitter == null ? '' : `, yard-litter=${st.yardLitter}`
      return `, idle-maxdist=${Math.round(st.maxdist)}, idle-miny=${st.miny == null ? '?' : Math.floor(st.miny)}, idle-underground-s=${Math.round(st.undergroundS)}${death}${yard}`
    },
    // nights: residence night records (partial ones are not judged).
    verdict(deaths, nights = []) {
      const why = []
      if (st.maxdist > IDLE_MAXDIST) why.push(`maxdist ${Math.round(st.maxdist)}>${IDLE_MAXDIST}`)
      if (st.miny == null) why.push('no position samples')
      else if (Math.floor(st.miny) < floor) why.push(`miny ${Math.floor(st.miny)}<${floor}`)
      if (st.diedS != null && st.rehomeS == null) why.push('never back within the leash after the forced death')
      if (st.yardLitter != null && st.yardLitter > 0) why.push(`yard-litter ${st.yardLitter}>0`)
      if (deaths > 0) why.push(`deaths ${deaths}>0`)
      for (const n of nights) if (!n.partial && !n.pass) why.push(`residence night ${n.night} FAIL`)
      return { pass: why.length === 0, line: `CASTLE-RIG idle: ${why.length ? `FAIL (${why.join(', ')})` : 'PASS'} floor=${floor}` }
    },
  }
}

// Seeded complete castle (idkcraft-g0z.33): every setblock for a finished
// v2 castle at st — keep-clear/moat cells to air first, then the plan
// cells in lay order (the bot's own paint: cobble, oak planks/fence,
// spruce frame), the gate's upper half, both bedroom beds and the table
// on the residence cells. kind = plan kind (read back with
// castle.matches) or 'extra' (read back by block name). Pure.
const SEED_PAINT = { stone: 'cobblestone', planks: 'oak_planks', frame: 'spruce_log', fence: 'oak_fence', chest: 'chest', torch: 'torch', air: 'air', dig: 'air' }
const FACING = ['north', 'east', 'south', 'west']
function seedCastleCells(st) {
  const blueprint = require('../src/castle')
  const residence = require('../src/residence')
  const cells = blueprint.absPlan(st.site, st.rot, 2).cells
  const f = FACING[(st.rot | 0) % 4]
  const out = []
  for (const c of cells) if (!blueprint.isPlaceTarget(c.kind)) out.push({ x: c.x, y: c.y, z: c.z, kind: c.kind, block: 'air' })
  for (const c of cells) {
    if (!blueprint.isPlaceTarget(c.kind)) continue
    out.push({ x: c.x, y: c.y, z: c.z, kind: c.kind, block: c.kind === 'door' ? `oak_door[half=lower,facing=${f}]` : SEED_PAINT[c.kind] })
  }
  const door = cells.find((c) => c.kind === 'door')
  out.push({ x: door.x, y: door.y + 1, z: door.z, kind: 'extra', block: `oak_door[half=upper,facing=${f}]` })
  const home = residence.castleHome(st)
  for (const b of residence.CASTLE.beds(home)) {
    out.push({ x: b.foot.x, y: b.foot.y, z: b.foot.z, kind: 'extra', block: `red_bed[part=foot,facing=${FACING[b.facing]}]` })
    out.push({ x: b.head.x, y: b.head.y, z: b.head.z, kind: 'extra', block: `red_bed[part=head,facing=${FACING[b.facing]}]` })
  }
  const t = residence.CASTLE.table(home)
  out.push({ x: t.x, y: t.y, z: t.z, kind: 'extra', block: 'crafting_table' })
  return out
}
function seedMatches(cell, name) {
  if (cell.kind === 'extra') return name === cell.block.split('[')[0]
  return require('../src/castle').matches(cell.kind, name)
}

async function rcon(cmd) {
  const { stdout } = await execFileAsync('docker', ['exec', CONTAINER, 'rcon-cli', cmd])
  const out = String(stdout)
  if ((cmd.startsWith('tp ') && !out.includes('Teleported')) ||
      (cmd.startsWith('op ') && !out.toLowerCase().includes('operator')) ||
      ((cmd.startsWith('clear ') || cmd.startsWith('give ') || cmd.startsWith('effect ')) && /No entity was found|Unknown|incorrect/i.test(out)) ||
      ((cmd.startsWith('fill ') || cmd.startsWith('setblock ')) && !/Successfully filled|No blocks were filled|Changed the block|Could not set the block/.test(out))) {
    throw new Error(`rcon failed [${cmd}]: ${out.trim().slice(0, 160)}`)
  }
  return out
}

function fail(kind, detail) {
  origLog(`CASTLE-RIG SETUP-FAIL ${kind}: ${detail} (full log ${LOGFILE})`)
  try { logStream.end() } catch (_) { /* close best-effort */ }
  process.exit(2)
}

// Blocked-cell seeds (idkcraft-vmzq.27): prod run4's stall mix — a lone
// oak_log reads 'protected' (util.isTreeLog wants a trunk or a crown),
// a chest reads kept-chest (FOREIGN, never dug). Lowest (dy, idx) stone
// first: all three land in the work order's first-16 prefix, so the old
// layer gate stalls on them within minutes and the skip fix must build
// past. Pure (unit-tested): the rcon writes + readback live in main().
// vmzq.40: planks join the mix and the chest is seeded filled (SEED_NBT) —
// the footprint rule clears both and relocates the chest, contents intact.
const SEED_MATS = ['oak_log', 'chest', 'oak_planks']
const SEED_NBT = { chest: '{Items:[{Slot:0b,id:"minecraft:diamond",count:3},{Slot:1b,id:"minecraft:oak_planks",count:20}]}' }
function pickBlockedSeeds(site, rot, version, n) {
  const blueprint = require('../src/castle')
  const { cells } = blueprint.absPlan(site, rot, version)
  const byDyIdx = (a, b) => a.dy - b.dy || a.idx - b.idx
  return cells.filter((c) => c.kind === 'stone').sort(byDyIdx).slice(0, n)
    .map((c, i) => ({ x: c.x, y: c.y, z: c.z, kind: c.kind, block: SEED_MATS[i % SEED_MATS.length] }))
}

// Pad-spot pick (pair 2, vmzq.33): the flattest readable 48x48 among the 9
// candidates around the pad. Readability is chunk-load timing after a fixed
// sleep, so two runs on the same pad can pick different spots — pair 2 ran
// the castle at 235,347 (master) vs 235,297 (branch), different quarries,
// and the branch-only dig stalls. CASTLE_PADSPOT="x,z" pins the spot and
// skips the scan: controlled pairs set it on both legs. Pure over scan
// (a null scan reads unreadable); exported for tests.
function pickPadSpot(scan, px, pz) {
  const pin = String(process.env.CASTLE_PADSPOT || '').trim()
  if (pin) {
    const m = pin.match(/^(-?\d+)\s*,\s*(-?\d+)$/)
    if (!m) throw new Error(`CASTLE_PADSPOT: want "x,z", got ${JSON.stringify(process.env.CASTLE_PADSPOT)}`)
    return { bx: +m[1], bz: +m[2], brel: null, best: null, pinned: true }
  }
  const cands = [[px, pz], [px - 50, pz], [px + 50, pz], [px, pz - 50], [px, pz + 50],
    [px - 50, pz - 50], [px + 50, pz - 50], [px - 50, pz + 50], [px + 50, pz + 50]]
  let best = null
  for (const [qx, qz] of cands) {
    const r = scan(qx, qz)
    if (r && (!best || r.score < best.score)) best = { ...r, x: qx, z: qz }
  }
  if (best) return { bx: best.x, bz: best.z, brel: best, best, pinned: false }
  return { bx: px, bz: pz, brel: null, best: null, pinned: false }
}

function waitFor(em, ev, ms, what) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { em.removeListener(ev, on); reject(new Error(`${what} timeout`)) }, ms)
    function on(...a) { clearTimeout(t); resolve(a) }
    em.once(ev, on)
  })
}

// Landing read (idkcraft-g0z.54): the guide's Y once it stops falling —
// five stable floored reads (2.5 s), so a laggy mid-fall read (the 0/44
// "regression": y=139 on a fixed 4 s sleep, pad floating 77 above the
// terrain) never becomes the pad top. reads is Y floats or nulls
// (unreadable); the floored Y or null. Pure.
const LANDING_STABLE_READS = 5
function landingY(reads) {
  if (!Array.isArray(reads) || reads.length < LANDING_STABLE_READS) return null
  const tail = reads.slice(-LANDING_STABLE_READS)
  if (tail.some((y) => typeof y !== 'number' || !Number.isFinite(y))) return null
  const f = Math.floor(tail[0])
  return tail.every((y) => Math.floor(y) === f) ? f : null
}

// Grounded check (idkcraft-g0z.54): the block just below the pad dirt —
// air/void/unreadable means the pad floats (a sky-platform landing) and
// the setup fails loud instead of stranding a 60 min run. Solid or
// liquid passes (an ocean pad sits on water). Pure.
function padFloats(below) {
  if (!below || typeof below.name !== 'string') return true
  return below.name === 'air' || below.name === 'cave_air' || below.name === 'void_air'
}

async function main() {
  if (GUIDE.length > 16 || FOLLOWER.length > 16) {
    throw new Error(`bot names exceed 16 chars (TAG=${JSON.stringify(TAG)}); set a shorter CASTLE_TAG`)
  }
  if (PAD.length !== 2 || !PAD.every(Number.isFinite)) throw new Error(`CASTLE_PAD: want "x,z", got ${JSON.stringify(process.env.CASTLE_PAD)}`)
  hookConsole()
  const [px, pz] = PAD.map(Math.floor)
  const index = require('../src/index')
  const brainMod = require('../src/brain')
  let brain = brainMod.stubBrain
  let brainEngine = ''
  if (SEED && SEED !== 'complete') fail('seed', `CASTLE_SEED: want ''|complete, got ${JSON.stringify(SEED)}`)
  if (IDLE && SEED !== 'complete') fail('idle', 'CASTLE_IDLE=1 needs CASTLE_SEED=complete (castle-rig.sh sets it)')
  if (PLANNER === 'jev') {
    const key = process.env.TYPESAFE_API_KEY
    // Loud, never silent: a jev run without a key would measure the stub
    // while the verdict claims JEV. The key itself is never printed.
    if (!key) fail('planner-key', 'RIG_PLANNER=jev needs TYPESAFE_API_KEY (stash secrets/jev-api-key)')
    brain = brainMod.hybridBrain(brainMod.jevBrain(key, undefined, brainMod.brainTimeoutMs(process.env), brainMod.JEV_ENDPOINT))
    brainEngine = 'jev'
  } else if (PLANNER !== 'stub') {
    fail('planner', `RIG_PLANNER: want jev|stub, got ${JSON.stringify(PLANNER)}`)
  }
  origLog(`CASTLE-RIG planner=${PLANNER}`)

  // Clock resync (vmzq.45): track server dusk/dawn every run, correct
  // bot.time only above wall-clock rate (the TICKRATE=1 gate path writes
  // nothing). Attached in mk(), before login completes — the spawn full
  // packets are the first anchor, and a post-spawn attach would miss them.
  const RESYNC_WRITE = (parseInt(TICKRATE, 10) || 1) > 1
  const timeT0 = Date.now()
  // deaths is declared below; the driver reads it only once armed (window open).
  const night = NIGHT ? createNightDriver({ cmd: rcon, who: FOLLOWER, deaths: () => deaths, log: origLog }) : null
  const resNights = SEED ? createResidenceNights({ deaths: () => deaths, log: origLog }) : null
  let winT0 = 0 // window start; residence nights count seconds from it
  const timeResync = createTimeResync({
    write: RESYNC_WRITE,
    onEvent: (ev) => {
      const plusS = Math.round((ev.at - timeT0) / 1000)
      seen.timeEvents.push({ event: ev.event, server: ev.server, bot: ev.bot, plusS })
      origLog(`CASTLE-RIG time: ${ev.event} server=${ev.server} bot=${ev.bot} +${plusS}s${ev.skip ? ' (sleep skip)' : ''}`)
      if (night) night.onEvent(ev)
      if (resNights) resNights.onEvent(ev, Math.round((ev.at - winT0) / 1000))
    },
  })
  origLog(`CASTLE-RIG time-resync: tickrate=${TICKRATE} mode=${RESYNC_WRITE ? 'correct' : 'track'}`)

  const guide = mineflayer.createBot({ host: HOST, port: PORT, username: GUIDE, auth: 'offline' })
  await waitFor(guide, 'spawn', 60000, 'guide spawn').catch((e) => fail('guide-spawn', e.message))
  await sleep(6000) // past Paper's same-IP connection throttle (stuck-replay precedent)

  let follower = null
  const chats = []
  const mk = (opts) => {
    const b = mineflayer.createBot({ ...opts, username: FOLLOWER })
    follower = b
    b._client.on('update_time', (packet) => timeResync.onPacket(b, packet))
    b.on('time', () => timeResync.apply(b))
    b.on('physicsTick', () => timeResync.onTick(b))
    b.once('spawn', () => {
      const origChat = b.chat.bind(b)
      b.chat = (msg) => { chats.push(String(msg)); return origChat(msg) }
    })
    return b
  }
  let deaths = 0
  index.runOnce({
    host: HOST, port: PORT, username: FOLLOWER, tickMs: 1000, idleTickMs: 1000,
    brain, brainEngine, leaveAfterMs: 0, followName: '', autonomous: true, createBot: mk,
    pingFn: async () => ({ players: {} }),
  }).then(() => {}, (e) => { origLog(`CASTLE-RIG follower runOnce rejected: ${e && e.message ? e.message : e}`); process.exit(2) })
  if (!follower) throw new Error('follower never created')
  await waitFor(follower, 'spawn', 60000, 'follower spawn').catch((e) => fail('follower-spawn', e.message))
  follower.on('death', () => { deaths++ })
  let worldSpawn = null // 6x7.25: the first spawn, before any tp, is the world spawn
  try { worldSpawn = follower.entity.position.floored() } catch (_) { worldSpawn = null }
  follower.on('end', () => fail('follower-dropped', 'connection ended mid-run'))
  await sleep(3000)
  await rcon(`op ${GUIDE}`).catch((e) => fail('op', e.message))
  await rcon(`op ${FOLLOWER}`).catch((e) => fail('op', e.message))
  const tickCtx = () => follower._tickerCtx
  if (tickCtx()) tickCtx().paused = true

  // Pad probe: drop the guide over the preferred centre (loads chunks
  // around it), pick the flattest 48x48 among candidates, read the landing
  // there, flatten around it. Flat matters: prod's castle search wants
  // level ground, and a mesa pad strands the gather return under sheer
  // dirt walls (rig cycle 8: the bot sat 14 below the trench, unreachable).
  // Pad top = landing (dirt box below, air above in <=17k-block fills —
  // the fill cap is 32768). 48x48 holds the 31x27 site plus the search.
  await rcon(`tp ${GUIDE} ${px} 150 ${pz}`).catch((e) => fail('pad-probe', e.message))
  await sleep(6000) // fall + chunks in (view distance covers the candidates)
  const scanRelief = (qx, qz) => {
    let lo = Infinity; let hi = -Infinity; let liquid = 0; let n = 0
    for (let x = qx - 24; x <= qx + 24; x += 3) {
      for (let z = qz - 24; z <= qz + 24; z += 3) {
        let top = null; let topY = null
        for (let y = 110; y >= 45; y--) {
          let b = null
          // A Vec3, never a bare {x,y,z}: getBlock floors it, a plain object
          // threw into the catch and every candidate read unreadable — the
          // pad fell back to the preferred spot, a lake (idkcraft-vmzq.26).
          try { b = guide.blockAt(new Vec3(x, y, z)) } catch (_) { b = null }
          if (!b) return null // unloaded: candidate unreadable
          if (b.name === 'air' || b.name === 'cave_air' || b.name === 'void_air') continue
          top = b.name; topY = y
          break
        }
        if (top == null) return null
        n++
        if (top === 'water' || top === 'lava') liquid++
        if (topY < lo) lo = topY
        if (topY > hi) hi = topY
      }
    }
    if (n === 0) return null
    return { span: hi - lo, liquid, score: (hi - lo) + liquid * 2 }
  }
  let bx = px; let bz = pz; let brel = null
  {
    const pick = pickPadSpot(scanRelief, px, pz)
    bx = pick.bx; bz = pick.bz; brel = pick.brel
    const tag = pick.best ? '' : (pick.pinned ? ' (pinned)' : ' (preferred, unreadable)')
    origLog(`CASTLE-RIG padspot ${bx},${bz} span=${brel ? brel.span : '?'} liquid=${brel ? brel.liquid : '?'}${tag}`)
  }
  await rcon(`tp ${GUIDE} ${bx} 150 ${bz}`).catch((e) => fail('pad-probe', e.message))
  // Wait for the landing (g0z.54): poll Y to 30 s, accept on five stable
  // reads — a fixed 4 s sleep misread y=139 mid-fall under lag and the
  // pad floated 77 above the terrain (the 0/44 "regression").
  let gy = null
  {
    const reads = []
    for (let i = 0; i < 60 && gy == null; i++) {
      await sleep(500)
      let y = null
      try { y = guide.entity.position.y } catch (_) { y = null }
      reads.push(typeof y === 'number' ? y : null)
      gy = landingY(reads)
    }
  }
  if (gy == null) fail('pad-probe', `guide never landed at ${bx},150,${bz}`)
  if (gy < 40 || gy > 140) fail('pad-probe', `no landing at ${bx},150,${bz} (y=${gy})`)
  const x0 = bx - 24; const x1 = bx + 24; const z0 = bz - 24; const z1 = bz + 24
  origLog(`CASTLE-RIG pad ${x0}..${x1} top ${gy} ${z0}..${z1}`)
  for (const cmd of [
    `fill ${x0} ${gy - 5} ${z0} ${x1} ${gy} ${z1} dirt`,
    `fill ${x0} ${gy + 1} ${z0} ${x1} ${gy + 7} ${z1} air`,
    `fill ${x0} ${gy + 8} ${z0} ${x1} ${gy + 14} ${z1} air`,
  ]) {
    await rcon(cmd).catch((e) => fail('pad-fill', e.message))
  }
  // Grounded (g0z.54): the pad dirt must sit on something — air below is
  // a floating pad (a sky-platform landing) that would strand the run.
  {
    let below = null
    try { below = guide.blockAt(new Vec3(bx, gy - 6, bz)) } catch (_) { below = null }
    if (padFloats(below)) fail('pad-float', `pad top ${gy} floats (below ${bx} ${gy - 6} ${bz} is ${below && below.name ? below.name : 'unreadable'})`)
  }
  // Sand patch (g0z.38): east of the pad edge (x1 = bx + 24), ~11 off the
  // seeded castle's east wall, dry (dirt base) and walkable from the pad.
  if (SAND) {
    for (const cmd of [
      `fill ${bx + 25} ${gy - 5} ${bz - 4} ${bx + 32} ${gy} ${bz + 3} dirt`,
      `fill ${bx + 25} ${gy + 1} ${bz - 4} ${bx + 32} ${gy + 7} ${bz + 3} air`,
      `fill ${bx + 26} ${gy - 2} ${bz - 3} ${bx + 31} ${gy} ${bz + 2} sand`,
    ]) {
      await rcon(cmd).catch((e) => fail('sand-fill', e.message))
    }
    origLog(`CASTLE-RIG sand patch ${bx + 26}..${bx + 31} ${gy - 2}..${gy} ${bz - 3}..${bz + 2} (108 sand)`)
  }
  // Seeded castle (g0z.33): the castle covers the pad centre, so both
  // land north of its fence line (site.z = bz - 13) instead.
  const standZ = SEED ? bz - 17 : bz
  await rcon(`tp ${GUIDE} ${bx + 0.5} ${gy + 1} ${standZ + 0.5}`).catch((e) => fail('pad-tp', e.message))
  await rcon(`tp ${FOLLOWER} ${bx + 2.5} ${gy + 1} ${standZ + 0.5}`).catch((e) => fail('pad-tp', e.message))
  await rcon(`clear ${FOLLOWER}`).catch((e) => fail('clear', e.message))
  // Seeded kit (pace split: laying measured independent of fetching): a
  // complete castle-opening kit — batch stone, planks, scaffold dirt and a
  // stone kit (pick + sword), so equip is kit-complete and the first castle
  // word is a batch. One give carries many stacks (stuck precedent).
  if (KIT === 'seeded') {
    for (const [item, count] of [['cobblestone', 128], ['oak_planks', 64], ['dirt', 64],
      ['stone_pickaxe', 1], ['stone_sword', 1]]) {
      await rcon(`give ${FOLLOWER} ${item} ${count}`).catch((e) => fail('seed', `${item}: ${e.message}`))
    }
    origLog('CASTLE-RIG kit=seeded (128 cobble, 64 planks, 64 dirt, stone pick+sword)')
  }
  // Junk kit (vmzq.38): the prod 2026-10-06 pack — 36/36 stone variants,
  // sand and mob junk, wooden sword only: no pickaxe, no table, no cobble.
  if (KIT === 'junk') {
    for (const [item, count] of [['granite', 90], ['diorite', 113], ['andesite', 115], ['smooth_basalt', 12],
      ['sand', 30], ['leaf_litter', 40], ['rotten_flesh', 20], ['bow', 4], ['raw_iron', 63], ['oak_planks', 128],
      ['acacia_door', 3], ['white_bed', 1], ['arrow', 88], ['wooden_sword', 1], ['bone', 64], ['string', 64],
      ['gunpowder', 64], ['spider_eye', 64], ['feather', 64], ['flint', 64], ['wheat_seeds', 64], ['oak_sapling', 64],
      ['kelp', 64], ['cactus', 64], ['egg', 16], ['ink_sac', 64], ['slime_ball', 64], ['clay_ball', 64]]) {
      await rcon(`give ${FOLLOWER} ${item} ${count}`).catch((e) => fail('seed', `${item}: ${e.message}`))
    }
    origLog('CASTLE-RIG kit=junk (36/36 stone variants + junk, no pickaxe)')
  }
  // Valuables kit (vmzq.39): 36/36 never-dropped valuables — ores, wool,
  // tools, coal, wood — no stone or dirt (the dig has no room until the
  // site chest takes them), a pick to dig with once it does, chests and a
  // table to build the storage. Nothing droppable, nothing shedable.
  if (KIT === 'valuables') {
    for (const [item, count] of [['raw_iron', 64], ['iron_ingot', 64], ['raw_gold', 64], ['diamond', 32],
      ['coal', 64], ['oak_log', 64], ['oak_planks', 64], ['white_wool', 32],
      ['stone_pickaxe', 2], ['iron_sword', 1], ['bow', 2], ['chest', 2], ['crafting_table', 1],
      ['bread', 32], ['arrow', 96], ['white_bed', 1], ['oak_door', 1], ['oak_fence', 16], ['torch', 32],
      ['charcoal', 64], ['raw_copper', 64], ['lapis_lazuli', 64], ['redstone', 64], ['emerald', 32],
      ['iron_helmet', 1], ['iron_chestplate', 1], ['shield', 1], ['string', 64], ['bone', 64],
      ['gunpowder', 64], ['feather', 64], ['flint', 64], ['leather', 64]]) {
      await rcon(`give ${FOLLOWER} ${item} ${count}`).catch((e) => fail('seed', `${item}: ${e.message}`))
    }
    origLog('CASTLE-RIG kit=valuables (36/36 ores + tools + wood, no stone/dirt)')
  }
  await sleep(3000) // chunks in, both landed
  // Seeded complete castle (g0z.33): site SW corner so the 31x27 castle
  // centres on the pad, floor on the pad top + 1 (siteEval's median + 1).
  // setblock 8 wide, read back from the guide; misses get one ordered
  // retry, then a setup fail. The castle state lands complete (memory
  // shape), so the live g0z.30 path adopts it: residence -> castle,
  // setHome saves the memory home kind=castle — both checked.
  let seedTag = ''
  if (SEED === 'complete') {
    const st = { site: { x: bx - 15, y: gy + 1, z: bz - 13 }, rot: 0, blueprintVersion: 2 }
    const cells = seedCastleCells(st)
    const set = (c) => rcon(`setblock ${c.x} ${c.y} ${c.z} minecraft:${c.block}`).catch((e) => fail('seed-castle', e.message))
    let next = 0
    await Promise.all(Array.from({ length: 8 }, async () => { while (next < cells.length) await set(cells[next++]) }))
    const misses = async () => {
      await sleep(2000) // block updates reach the guide
      return cells.filter((c) => {
        let name = null
        try { const b = guide.blockAt(new Vec3(c.x, c.y, c.z)); name = b && b.name } catch (_) { name = null }
        return !seedMatches(c, name)
      })
    }
    let miss = await misses()
    for (const c of miss) await set(c)
    if (miss.length) miss = await misses()
    if (miss.length) fail('seed-castle', `${miss.length} cells wrong after retry: ${miss.slice(0, 5).map((c) => `${c.x} ${c.y} ${c.z} ${c.block}`).join('; ')}`)
    const placed = cells.filter((c) => c.kind !== 'extra' && c.kind !== 'air' && c.kind !== 'dig').length
    seedTag = `, seeded=${placed}/${placed}`
    origLog(`CASTLE-RIG seeded castle site ${st.site.x} ${st.site.y} ${st.site.z} rot 0: ${cells.length} setblocks, ${placed} plan blocks + gate + 2 beds + table read back`)
    if (IDLE_DEATH > 0) {
      // 6x7.25: decor too (44 panes + 2 gate banners + the g0z.45 upper
      // fence row), so castlefetch has nothing left to fetch: its
      // sand/wool legs walked 85+ out on both builds and drowned the
      // gather drift this scenario measures.
      const decor = require('../src/castle').decorPlan(st.site, 0, 2).cells
      for (const c of decor) {
        let block = 'glass_pane'
        if (c.kind === 'banner') {
          const f = c.wall.z > c.z ? 'north' : c.wall.z < c.z ? 'south' : c.wall.x > c.x ? 'west' : 'east'
          block = `white_wall_banner[facing=${f}]`
        } else if (c.kind === 'fence') {
          block = 'oak_fence'
        }
        await rcon(`setblock ${c.x} ${c.y} ${c.z} minecraft:${block}`).catch((e) => fail('seed-decor', e.message))
      }
      origLog(`CASTLE-RIG seeded decor: ${decor.length} cells (panes + banners + upper fence)`)
    }
    if (!tickCtx()) fail('seed-castle', 'no follower ctx')
    tickCtx().castle = { ...st, phase: 'complete', blocked: {}, parked: false }
  }
  if (tickCtx()) tickCtx().paused = false
  if (SEED === 'complete') {
    let adopted = false
    for (let i = 0; i < 60 && !adopted; i++) {
      const h = tickCtx() && tickCtx().home
      adopted = !!h && h.kind === 'castle'
      if (!adopted) await sleep(500)
    }
    if (!adopted) fail('seed-castle', 'the bot never adopted the castle as its residence')
    let memHome = null
    try {
      const doc = JSON.parse(fs.readFileSync(process.env.BOT_MEMORY_FILE, 'utf8'))
      memHome = doc.homes[doc.homes.length - 1]
    } catch (e) { fail('seed-castle', `memory file unreadable: ${e.message}`) }
    if (!memHome || memHome.kind !== 'castle') fail('seed-castle', `memory home is not kind=castle: ${JSON.stringify(memHome).slice(0, 160)}`)
    origLog('CASTLE-RIG residence: castle adopted, memory home kind=castle')
  }

  // The order needs the speaker's entity loaded on the follower, else the
  // bot answers "I can't see you" and nothing starts. A seeded castle
  // needs no order (autonomous rides runOnce).
  let ordered = SEED ? 'seeded' : null
  let sees = !!SEED
  for (let i = 0; i < 40 && !sees; i++) {
    try { sees = !!(follower.players && follower.players[GUIDE] && follower.players[GUIDE].entity) } catch (_) { sees = false }
    if (!sees) await sleep(500)
  }
  if (!sees) fail('order', `follower never saw ${GUIDE}`)
  if (!SEED) {
    try { guide.chat('autonomous on') } catch (e) { fail('order', `autonomous chat: ${e.message}`) }
    await sleep(1000)
    try { guide.chat('build castle') } catch (e) { fail('order', `castle chat: ${e.message}`) }
  }
  // Order ack: the direct site ('castle at …, ~1722 blocks') or the search
  // ('found a castle spot …', which carries the same startCastle tail).
  // The asker leaving cancels the search, so the guide stays till the ack.
  const tOrder = Date.now()
  let scanned = 0
  while (Date.now() - tOrder < 300000) {
    for (; scanned < chats.length; scanned++) {
      const line = chats[scanned]
      if (/found a castle spot |castle at -?\d+ -?\d+ -?\d+, ~\d+ blocks/.test(line)) { ordered = line; break }
      if (/I found no castle spot|I can't see you/.test(line)) fail('order', line.slice(0, 160))
    }
    if (ordered) break
    await sleep(500)
  }
  if (!ordered) fail('order', 'no castle ack in 300 s')
  origLog(`CASTLE-RIG ordered: ${ordered.slice(0, 160)}`)
  // Blocked seeds (vmzq.27): set after the ack (the site only exists now),
  // before the guide quits — its presence loads the site chunks, and the
  // readback below fails the run instead of measuring an unseeded castle.
  let blockedSeeds = []
  if (BLOCKED > 0 && !SEED) {
    const st = follower._tickerCtx && follower._tickerCtx.castle
    if (!st || !st.site || typeof st.site.x !== 'number') fail('seed-blocked', 'no castle site after order')
    blockedSeeds = pickBlockedSeeds(st.site, st.rot, st.blueprintVersion, BLOCKED)
    if (blockedSeeds.length < BLOCKED) fail('seed-blocked', `only ${blockedSeeds.length} seed cells for ${BLOCKED}`)
    await rcon(`tp ${GUIDE} ${st.site.x + 15.5} ${st.site.y + 10} ${st.site.z + 13.5}`).catch((e) => fail('seed-blocked', e.message))
    await sleep(3000)
    for (const s of blockedSeeds) {
      await rcon(`setblock ${s.x} ${s.y} ${s.z} minecraft:${s.block}${SEED_NBT[s.block] || ''}`).catch((e) => fail('seed-blocked', `${s.x} ${s.y} ${s.z}: ${e.message}`))
    }
    await sleep(1000)
    for (const s of blockedSeeds) {
      let name = null
      try { const b = guide.blockAt(new Vec3(s.x, s.y, s.z)); name = b && b.name } catch (_) { name = null }
      if (name !== s.block) fail('seed-blocked', `readback ${s.x} ${s.y} ${s.z}: want ${s.block}, got ${name}`)
    }
    origLog(`CASTLE-RIG blocked: ${blockedSeeds.map((s) => `${s.x} ${s.y} ${s.z} ${s.kind} ${s.block}`).join('; ')}`)
  }
  try { guide.quit('ordered') } catch (_) { /* quit best-effort */ }

  // Window: sample progress/step/pos every 15 s; a short sample line every
  // 5 min keeps long runs visibly alive without burying the verdict.
  const series = []
  const t0 = Date.now()
  const endAt = t0 + MINS * 60000
  let lastSampleLine = 0
  const sample = () => {
    const s = { t: Math.round((Date.now() - t0) / 1000) }
    try {
      const c = follower._tickerCtx
      const st = c && c.castle
      s.done = st && st.progress && typeof st.progress.done === 'number' ? st.progress.done : null
      s.total = st && st.progress && typeof st.progress.total === 'number' ? st.progress.total : null
      s.phase = st && st.phase
      s.step = c && c.step
      s.status = c && c.stepStatus
    } catch (_) { /* sample best-effort */ }
    try {
      const p = follower.entity.position
      s.x = Math.round(p.x); s.y = Math.round(p.y); s.z = Math.round(p.z)
    } catch (_) { /* pos best-effort */ }
    try {
      s.hunger = (follower && typeof follower.food === 'number') ? follower.food : null
    } catch (_) { /* hunger best-effort */ }
    try {
      // vmzq.45: server daytime (re-anchored + counted) vs the bot's own
      // clock as the brain reads it. srv=null means the resync never
      // anchored (pre-26.1 shape or unknown dimension). A breach is loud:
      // the correction stopped landing (revmux 01 major).
      s.srv = timeResync.daytime()
      s.bt = (follower && follower.time && typeof follower.time.timeOfDay === 'number') ? follower.time.timeOfDay : null
      const drift = timeDrift(s.srv, s.bt)
      if (drift != null) {
        if (drift > seen.timeMaxDrift) seen.timeMaxDrift = drift
        if (drift > RESYNC_DRIFT_TICKS) origErr(`CASTLE-RIG time-drift: srv=${s.srv} bt=${s.bt} (+${s.t}s)`)
      }
    } catch (_) { /* time best-effort */ }
    try {
      let cobble = 0; let dirt = 0; let logs = 0; let planks = 0; let sticks = 0
      let edibles = 0
      let pick = 'none'
      for (const it of (follower.inventory && follower.inventory.items()) || []) {
        if (!it || typeof it.name !== 'string') continue
        const n = typeof it.count === 'number' ? it.count : 1
        if (SAMPLE_EDIBLES.has(it.name)) edibles += n
        if (it.name === 'cobblestone') cobble += n
        else if (it.name === 'dirt') dirt += n
        else if (/_log$/.test(it.name)) logs += n
        else if (/_planks$/.test(it.name)) planks += n
        else if (it.name === 'stick') sticks += n
        else if (/_pickaxe$/.test(it.name)) {
          if (it.name === 'stone_pickaxe') pick = 'stone'
          else if (pick === 'none' && it.name === 'wooden_pickaxe') pick = 'wood'
        }
      }
      s.cobble = cobble; s.dirt = dirt; s.logs = logs; s.planks = planks; s.sticks = sticks; s.pick = pick; s.edibles = edibles
    } catch (_) { /* inventory best-effort */ }
    try {
      // Ground-drop census (vmzq.20): non-player entities near the bot.
      // In a peaceful rig these are item drops — a direct read on whether
      // dug blocks bank or litter the trench (cycle 12: ~2/3 never banked).
      let drops = 0
      const bp = follower.entity && follower.entity.position
      const ents = (follower.entities && typeof follower.entities === 'object') ? Object.values(follower.entities) : []
      for (const e of ents) {
        if (!e || e.type === 'player' || e.username) continue
        if (!bp || !e.position) continue
        if (Math.hypot(e.position.x - bp.x, e.position.y - bp.y, e.position.z - bp.z) <= 12) drops++
      }
      s.drops = drops
    } catch (_) { /* drops best-effort */ }
    try {
      const c = follower._tickerCtx
      const f = c && c.castleFetch
      if (f) s.fetch = { kind: f.kind, quarry: !!(f.target && f.target.quarry), skips: f.skips || 0, dead: (f.quarry && f.quarry.dead) || [] }
    } catch (_) { /* fetch best-effort */ }
    series.push(s)
    return s
  }
  const checkpoint = () => {
    const last = series[series.length - 1] || {}
    try {
      fs.writeFileSync(OUT, JSON.stringify({
        date: new Date().toISOString(), mins: MINS,
        done: typeof last.done === 'number' ? last.done : 0,
        total: typeof last.total === 'number' ? last.total : 0,
        flips: seen.flips, deaths, steps: seen.steps, fails: seen.fails,
        partial: Date.now() < endAt,
        tag: TAG, gitsha: process.env.CASTLE_GITSHA || '?', log: LOGFILE,
        kit: KIT, tickrate: TICKRATE, planner: PLANNER, said: seen.said,
        wdCalls: seen.wdCalls, wdChoices: seen.wdChoices, outcomes: seen.outcomes, series,
        timeEvents: seen.timeEvents, timeMaxDrift: seen.timeMaxDrift,
        nights: night ? night.nights : undefined,
      }))
    } catch (_) { /* checkpoint best-effort */ }
  }
  sample()
  checkpoint()
  // Holes report (vmzq.27): the follower's own `castle: ` chats (the ack
  // has no colon, so the prefix skips it) land in the log + OUT record.
  let scannedSay = chats.length
  const drainSaid = () => {
    for (; scannedSay < chats.length; scannedSay++) {
      const msg = chats[scannedSay]
      if (typeof msg === 'string' && msg.startsWith('castle: ')) {
        seen.said.push(msg.slice(0, 300))
        origLog(`CASTLE-RIG say: ${msg.slice(0, 300)}`)
      }
    }
  }
  origLog(`CASTLE-RIG window: ${MINS} min, ends ${new Date(endAt).toISOString()}`)
  if (night) await night.open()
  winT0 = t0
  let resTimer = null
  const idle = IDLE ? createIdleTrack(tickCtx().home) : null
  if (resNights) {
    resNights.open()
    const resSample = () => {
      let inside = false
      try {
        const h = follower._tickerCtx && follower._tickerCtx.home
        inside = !!h && h.kind === 'castle' && require('../src/residence').of(h).interior(h, follower.entity.position)
      } catch (_) { inside = false }
      resNights.onSample(Math.round((Date.now() - t0) / 1000), inside, !!follower.isSleeping)
      if (idle) { try { idle.onSample((Date.now() - t0) / 1000, follower.entity.position) } catch (_) { /* idle best-effort */ } }
    }
    resTimer = setInterval(resSample, 1000)
    follower.on('sleep', resSample)
  }
  let farAt = 0
  let farPre = null
  let buryAt = 0
  let buryPre = null
  let surfacedS = null
  let resumedS = null
  let pitAt = 0
  let pitPre = null
  let pitRim = null
  let pitCX = null
  let pitCZ = null
  let escapedS = null
  let pitResumedS = null
  let pitEsc = null
  let idleDeathAt = 0
  let idleForced = 0
  let idlePosAt = 0
  while (Date.now() < endAt) {
    await sleep(15000)
    if (IDLE_DEATH > 0 && !idleDeathAt && Date.now() - t0 >= IDLE_DEATH * 60000) {
      idleDeathAt = Date.now()
      if (!worldSpawn) fail('idle-death', 'world spawn never read')
      const rp = idleRespawnPoint(tickCtx().home.site, worldSpawn)
      // keep_inventory is on: clear first, so the respawn kit is empty. The
      // spawnpoint overrides a castle bed the bot may have slept in.
      await rcon(`clear ${FOLLOWER}`).catch((e) => fail('idle-death', e.message))
      await rcon(`spawnpoint ${FOLLOWER} ${rp.x} ${rp.y} ${rp.z}`).catch((e) => fail('idle-death', e.message))
      const d0 = deaths
      if (idle) idle.pause()
      await rcon(`kill ${FOLLOWER}`).catch((e) => fail('idle-death', e.message))
      for (let i = 0; i < 20 && deaths === d0; i++) await sleep(500)
      if (deaths === d0) fail('idle-death', 'kill never reached the follower')
      idleForced = deaths - d0
      const atRp = () => { try { const p = follower.entity.position; return Math.hypot(p.x - rp.x - 0.5, p.z - rp.z - 0.5) <= 4 } catch (_) { return false } }
      for (let i = 0; i < 60 && !atRp(); i++) await sleep(500)
      if (!atRp()) fail('idle-death', `never respawned at ${rp.x} ${rp.z}`)
      if (idle) idle.died((idleDeathAt - t0) / 1000)
      origLog(`CASTLE-RIG idle-death: at ${(idleDeathAt - t0) / 1000 | 0}s, cleared + killed, respawn ${rp.x} ${rp.y} ${rp.z} (world spawn ${worldSpawn.x} ${worldSpawn.y} ${worldSpawn.z})`)
    }
    if (idleDeathAt && Date.now() - idlePosAt >= 60000) {
      idlePosAt = Date.now()
      try {
        const p = follower.entity.position
        const h = tickCtx().home.site
        origLog(`CASTLE-RIG idle-pos t=${(Date.now() - t0) / 1000 | 0}s dist=${Math.round(Math.hypot(p.x - h.x, p.z - h.z))} y=${Math.floor(p.y)} step=${seen.step}`)
      } catch (_) { /* diagnostic best-effort */ }
    }
    if (FAR > 0 && !farAt && Date.now() - t0 >= FAR_AFTER * 60000) {
      farAt = Date.now()
      const st = follower._tickerCtx && follower._tickerCtx.castle
      if (!st || !st.site) fail('far', 'no castle site')
      const fx = st.site.x + FAR
      const fz = st.site.z
      await rcon(`tp ${FOLLOWER} ${fx + 0.5} 200 ${fz + 0.5}`).catch((e) => fail('far', e.message))
      let fy = null
      for (let i = 0; i < 40; i++) {
        await sleep(500)
        try { if (follower.entity.onGround) { fy = Math.floor(follower.entity.position.y); break } } catch (_) { /* landing */ }
      }
      if (fy == null) fail('far', 'never landed')
      await rcon(`fill ${fx - 1} ${fy - 7} ${fz - 1} ${fx + 1} ${fy - 1} ${fz + 1} air`).catch((e) => fail('far', e.message))
      await rcon(`clear ${FOLLOWER} minecraft:dirt`).catch((e) => fail('far', e.message))
      await rcon(`give ${FOLLOWER} cobblestone 64`).catch((e) => fail('far', e.message))
      farPre = st.progress && typeof st.progress.done === 'number' ? st.progress.done : null
      origLog(`CASTLE-RIG far: at ${(Date.now() - t0) / 1000 | 0}s ${(st.progress && st.progress.done) ?? '?'}/${(st.progress && st.progress.total) ?? '?'} -> pit ${fx} ${fy - 8} ${fz} (${FAR} off), dirt cleared, +64 cobble`)
    }
    if (BURY > 0 && !buryAt && Date.now() - t0 >= BURY_AFTER * 60000) {
      const st = follower._tickerCtx && follower._tickerCtx.castle
      if (!st || !st.site) fail('bury', 'no castle site')
      const px = st.site.x - 12
      const pz = st.site.z
      const py = gy - BURY
      await rcon(`fill ${px - 2} ${py - 1} ${pz - 2} ${px + 2} ${py + 3} ${pz + 2} minecraft:stone`).catch((e) => fail('bury', e.message))
      await rcon(`fill ${px - 1} ${py} ${pz - 1} ${px + 1} ${py + 1} ${pz + 1} air`).catch((e) => fail('bury', e.message))
      await rcon(`tp ${FOLLOWER} ${px + 0.5} ${py} ${pz + 0.5}`).catch((e) => fail('bury', e.message))
      for (const m of ['wooden', 'stone', 'golden', 'iron', 'diamond', 'netherite']) {
        await rcon(`clear ${FOLLOWER} minecraft:${m}_pickaxe`).catch(() => { /* none held */ })
      }
      if (BURY_NOWOOD) {
        for (const it of ['#minecraft:planks', '#minecraft:logs', 'minecraft:stick', 'minecraft:crafting_table']) {
          await rcon(`clear ${FOLLOWER} ${it}`).catch(() => { /* none held */ })
        }
      }
      await sleep(2000) // the pack read lags the clears
      buryAt = Date.now()
      buryPre = st.progress && typeof st.progress.done === 'number' ? st.progress.done : 0
      const k = sample()
      origLog(`CASTLE-RIG bury: at ${(buryAt - t0) / 1000 | 0}s ${buryPre}/${(st.progress && st.progress.total) ?? '?'} -> pocket ${px} ${py} ${pz} (${BURY} below ${gy}), picks cleared${BURY_NOWOOD ? ' + wood' : ''}, pack cobble=${k.cobble} planks=${k.planks} logs=${k.logs} pick=${k.pick}`)
    }
    if (PIT > 0 && !pitAt && Date.now() - t0 >= PIT_AFTER * 60000) {
      const pst = follower._tickerCtx && follower._tickerCtx.castle
      if (!pst || !pst.site) fail('pit', 'no castle site')
      // Lead-out past the site box (max width 31: inside it the pit stone
      // reads as castle groundCell and every recover dig refuses
      // 'protected' (c31)). The follower itself never tps — burst tp
      // confirms lie (c698/c921 dropped nowhere with 'Teleported'
      // printed). Instead an expendable pit-guide tps near the site
      // (retried to client-verify), chats 'follow me', and walks east;
      // the follower trails it by gameplay. Then the pit is built around
      // the follower and it falls in — physics, client-verified.
      const GUIDE2 = `PitGuide${TAG}`.slice(0, 16)
      let guide2 = null
      try {
        guide2 = mineflayer.createBot({ host: HOST, port: PORT, username: GUIDE2, auth: 'offline' })
        await waitFor(guide2, 'spawn', 60000, 'pit guide2 spawn')
      } catch (e) { fail('pit', `guide2 join: ${e.message}`) }
      await sleep(6000) // past Paper's same-IP connection throttle (guide precedent)
      let pfMod = null
      try {
        pfMod = require('mineflayer-pathfinder')
        guide2.loadPlugin(pfMod.pathfinder)
      } catch (e) { fail('pit', `guide2 pathfinder: ${e.message}`) }
      try { guide2.chat('follow me') } catch (e) { fail('pit', `guide2 chat: ${e.message}`) }
      await sleep(2000) // the follower adopts on the next tick or two
      const fpos = () => {
        try {
          const p = follower.entity && follower.entity.position
          return p && typeof p.x === 'number' ? p : null
        } catch (_) { return null }
      }
      const gpos = () => {
        try {
          const p = guide2.entity && guide2.entity.position
          return p && typeof p.x === 'number' ? p : null
        } catch (_) { return null }
      }
      try {
        const moves = new pfMod.Movements(guide2)
        moves.canDig = false // surface walk only: no tunnels the follower cannot trail
        moves.allowParkour = true
        moves.allowSprinting = true
        guide2.pathfinder.setMovements(moves)
      } catch (e) { fail('pit', `guide2 moves: ${e.message}`) }
      // Guide2 goes by tp (the follower never does): it is expendable and
      // retries are cheap, and its client position is truth (no rcon
      // data-get, whose point readback false-passed once (c921)). Then a
      // short lead on loaded chunks — a 400-block GoalXZ from world spawn
      // never computes (c69, c900) and strands the lead.
      const G2X = pst.site.x + 10
      const G2Z = pst.site.z
      let g2there = false
      for (let i = 0; i < 5 && !g2there; i++) {
        if (i > 0) await sleep(2000) // space burst rcon (silent-no-op class)
        await rcon(`tp ${GUIDE2} ${G2X + 0.5} ${gy + 1} ${G2Z + 0.5}`).catch(() => {}) // confirm lies; client verifies
        for (let k = 0; k < 10 && !g2there; k++) {
          await sleep(1000)
          const gp = gpos()
          if (gp && Math.hypot(gp.x - (G2X + 0.5), gp.z - (G2Z + 0.5)) < 6 && Math.abs(gp.y - (gy + 1)) < 3) g2there = true
        }
      }
      if (!g2there) fail('pit', 'guide2 tp never applied (client readback)')
      // Pull-to-window on the flat on-pad east strip (pad x1 274, site box
      // ends at site.x+31): off-pad slopes slide the parked bot downhill
      // and false-positive the fall-in (c216), and inside the box the pit
      // stone is castle-protected (c31). Guide2 steps east until the
      // follower reads inside [site.x+32, site.x+36].
      const WIN_LO = pst.site.x + 32
      const WIN_HI = pst.site.x + 36
      let ledOut = false
      for (let step = 0; step < 12 && !ledOut; step++) {
        try { guide2.pathfinder.setGoal(new pfMod.goals.GoalXZ(pst.site.x + 38 + step * 5, pst.site.z)) } catch (e) { fail('pit', `guide2 goal: ${e.message}`) }
        for (let i = 0; i < 10 && !ledOut; i++) {
          await sleep(2000)
          const fp = fpos()
          if (fp && fp.x >= WIN_LO && fp.x <= WIN_HI) ledOut = true
        }
      }
      try { guide2.chat('stop') } catch (_) { /* parking best-effort */ }
      await sleep(2000)
      if (!ledOut) fail('pit', 'follower never entered the on-pad window [site.x+32, site.x+36] (lead-out)')
      // Parked for the build: a working bot walks out from under the fills
      // (c982). Resume ('go work') only after the fall verifies — 'stop'
      // alone would park it idle with no goal to get stuck against (c429).
      // The hollow takes its footing and it falls 4 to the pit floor.
      // Hollow east-shifted so it lands in the west column, wall-adjacent
      // (a centre landing has no dig_step: no solid side at feet — the
      // dead zone, not the dig).
      let bx = null
      let by = null
      let bz = null
      for (let i = 0; i < 20; i++) {
        await sleep(500)
        try {
          if (follower.entity && follower.entity.onGround !== false) {
            const p = follower.entity.position
            if (p && typeof p.x === 'number') { bx = Math.floor(p.x); by = Math.floor(p.y); bz = Math.floor(p.z); break }
          }
        } catch (_) { /* settling */ }
      }
      if (bx == null) fail('pit', 'follower never settled')
      if (bx < WIN_LO || bx > WIN_HI) fail('pit', 'settle x left the on-pad window')
      // Mass rim (bx-3..bx+3) stays on the flattened pad: WIN_HI+3 <= 274.
      if (PIT_SHAPE !== '' && PIT_SHAPE !== 'corner' && PIT_SHAPE !== 'hall') fail('pit-shape', `CASTLE_PIT_SHAPE: want ''|corner|hall, got ${JSON.stringify(PIT_SHAPE)}`)
      const massFill = PIT_SHAPE === 'hall'
        ? `fill ${bx - 3} ${by - 5} ${bz - 3} ${bx + 3} ${by - 1} ${bz + 3} minecraft:stone`
        : `fill ${bx - 3} ${by - 5} ${bz - 2} ${bx + 3} ${by - 1} ${bz + 2} minecraft:stone`
      await rcon(massFill).catch((e) => fail('pit', e.message))
      await sleep(1000) // space burst rcon (same silent-no-op class as the tps)
      const hollowFill = PIT_SHAPE === 'hall'
        ? `fill ${bx - 2} ${by - 4} ${bz - 2} ${bx + 2} ${by + 6} ${bz + 2} minecraft:air`
        : PIT_SHAPE === 'corner'
          ? `fill ${bx} ${by - 4} ${bz} ${bx + 2} ${by + 6} ${bz + 2} minecraft:air`
          : `fill ${bx} ${by - 4} ${bz - 1} ${bx + 2} ${by + 6} ${bz + 1} minecraft:air`
      await rcon(hollowFill).catch((e) => fail('pit', e.message))
      // Fill-verify (client scan): burst rcon silently no-ops (c698). The
      // mass cell proves the mass applied; the hollow cell is air only if
      // the hollow applied on top of it (the mass would stone it).
      await sleep(1000)
      let massOk = false
      let hollowOk = false
      try {
        const m = follower.blockAt(new Vec3(bx - 3, by - 2, bz))
        massOk = !!(m && m.name !== 'air' && m.name !== 'cave_air' && m.name !== 'void_air')
        const h = follower.blockAt(new Vec3(bx + 1, by - 2, bz))
        hollowOk = !!(h && (h.name === 'air' || h.name === 'cave_air' || h.name === 'void_air'))
      } catch (_) { /* scan failed: verify loud below */ }
      if (!massOk || !hollowOk) fail('pit', `fills never landed (mass=${massOk} hollow=${hollowOk})`)
      // Persistent fall-in: one low read is a downhill slide off-pad, a
      // jump transient, or lag — three consecutive lows is the pit floor.
      let lowRun = 0
      let fellIn = false
      for (let i = 0; i < 30 && !fellIn; i++) {
        await sleep(500)
        const p = fpos()
        if (p && Math.floor(p.y) <= by - 3) { lowRun++; if (lowRun >= 3) fellIn = true } else lowRun = 0
      }
      if (!fellIn) fail('pit', 'follower never fell in')
      // Open top (client scan, no rcon): a hill lip overhead head-blocks
      // every dig mount and the pit is unescapable-by-shape.
      let capped = false
      try {
        for (let y = by; y <= by + 6; y++) {
          const b = follower.blockAt(new Vec3(bx + 1, y, bz))
          if (b && b.name !== 'air' && b.name !== 'cave_air' && b.name !== 'void_air') { capped = true; break }
        }
      } catch (_) { capped = false }
      if (capped) fail('pit', 'capped by terrain (re-run; the walk varies)')
      const qy = by - PIT // pit-floor feet level; rim feet level is by
      await sleep(1000)
      await rcon(`give ${FOLLOWER} minecraft:stone_pickaxe 1`).catch((e) => fail('pit', e.message))
      await sleep(1000)
      await rcon(`give ${FOLLOWER} minecraft:dirt 19`).catch((e) => fail('pit', e.message))
      await sleep(1000)
      await rcon(`clear ${FOLLOWER} minecraft:water_bucket`).catch(() => { /* none held */ })
      await sleep(2000) // the pack read lags the gives
      pitRim = by
      pitCX = bx + 1
      pitCZ = bz
      if (PIT_GOAL !== '' && PIT_GOAL !== 'level') fail('pit-goal', `CASTLE_PIT_GOAL: want ''|level, got ${JSON.stringify(PIT_GOAL)}`)
      if (PIT_GOAL === 'level' && !follower._pitGoalInstalled) {
        // Installed BEFORE the resume like the refuse hook: the first pit
        // episode must already carry the forced goal. stuck.js raises every
        // episode through recover.setStuck (property lookup, same module
        // object in-process), so one wrapper covers all owners; the guides
        // are bare bots and never raise. The goal is fixed (c698: level,
        // dist~30, east through the open side) while the body is below the
        // rim near the pit; outside episodes stay organic.
        follower._pitGoalInstalled = true
        const recoverMod = require('../src/behaviours/recover')
        const rawSetStuck = recoverMod.setStuck
        recoverMod.setStuck = (ctx, by, goal, key) => {
          let g = goal
          try {
            const p = follower.entity && follower.entity.position
            if (p && typeof p.y === 'number' && p.y < pitRim &&
              Math.hypot(p.x - (pitCX + 0.5), p.z - (pitCZ + 0.5)) <= 6) {
              g = { x: pitCX + 30, y: qy, z: pitCZ }
            }
          } catch (_) { /* forcing best-effort */ }
          return rawSetStuck(ctx, by, g, key)
        }
      }
      if (PIT_REFUSE && !follower._pitRefuseInstalled) {
        // Installed BEFORE the resume: a post-resume install gives the bot
        // an unrefused head start and it pillar-towers out (c913: 67->69
        // in the 4s gap). Below the rim, near the pit, every placement
        // throws the run7 text. Above the rim or back at the site the real
        // place runs, so resumed-seconds still measure.
        follower._pitRefuseInstalled = true
        const rawPlace = follower.placeBlock.bind(follower)
        follower.placeBlock = async (ref, face, opts) => {
          let p = null
          try { p = follower.entity && follower.entity.position } catch (_) { p = null }
          if (p && typeof p.y === 'number' && p.y < pitRim &&
            Math.hypot(p.x - (pitCX + 0.5), p.z - (pitCZ + 0.5)) <= 6) {
            const held = (follower.heldItem && follower.heldItem.name) || 'block'
            const rp = ref && ref.position
            const d = rp && face ? `(${rp.x + face.x}, ${rp.y + face.y}, ${rp.z + face.z})` : '(?, ?, ?)'
            throw new Error(`Server refused to place ${held} at ${d}: the block is still air`)
          }
          return rawPlace(ref, face, opts)
        }
      }
      // Post-kit still-low, checked while still parked (before the resume):
      // the parked bot cannot move, so a high read here is a slope the
      // fall-in false-positived (c216), while a post-resume check would
      // also catch the control's first legit pillar block (c998: 68).
      {
        const pk = fpos()
        if (!pk || Math.floor(pk.y) > by - 3) fail('pit', `follower not pit-low after kit (y=${pk ? pk.y : '?'}, need block<=${by - 3})`)
      }
      try { guide2.chat('go work') } catch (_) { /* resume best-effort */ }
      await sleep(2000) // adopts on the next tick or two
      try { guide2.quit() } catch (_) { /* quit best-effort */ }
      pitAt = Date.now()
      pitPre = pst.progress && typeof pst.progress.done === 'number' ? pst.progress.done : 0
      const k = sample()
      origLog(`CASTLE-RIG pit: at ${(pitAt - t0) / 1000 | 0}s ${pitPre}/${(pst.progress && pst.progress.total) ?? '?'} -> open ${PIT}-deep stone pit ${bx} ${qy} ${bz} (rim ${by}), shape=${PIT_SHAPE || 'square'}, pick+scaffold kit, refuse=${PIT_REFUSE ? 'on' : 'off'}, goal=${PIT_GOAL || 'organic'}, pack cobble=${k.cobble} dirt=${k.dirt} pick=${k.pick}`)
    }
    const s = sample()
    if (buryAt) {
      const since = Math.round((Date.now() - buryAt) / 1000)
      if (surfacedS == null && typeof s.y === 'number' && s.y >= gy - 2) surfacedS = since
      if (surfacedS != null && resumedS == null && typeof s.done === 'number' && s.done > buryPre) resumedS = since // laid after surfacing
    }
    if (pitAt) {
      const since = Math.round((Date.now() - pitAt) / 1000)
      // Resume baselines at the escape sample, not the pit sample: the
      // initial done=0 is set without scanning, so the first rescan can
      // jump on terrain stone (c378: 0->5 from the pit floor) and a
      // pit-baselined resume would fire at the escape sample.
      if (escapedS == null && typeof s.y === 'number' && s.y >= pitRim) { escapedS = since; pitEsc = typeof s.done === 'number' ? s.done : null }
      const resumeBase = pitEsc != null ? pitEsc : pitPre
      if (escapedS != null && pitResumedS == null && typeof s.done === 'number' && s.done > resumeBase) pitResumedS = since // laid after escaping
    }
    drainSaid()
    checkpoint()
    const line = `castle-sample t=${Math.round(s.t / 60)}min ${s.done ?? '?'}/${s.total ?? '?'} step=${s.step} flips=${seen.flips} deaths=${deaths} hunger=${s.hunger ?? '?'} edibles=${s.edibles ?? '?'}`
    try { logStream.write(line + '\n') } catch (_) { /* log best-effort */ }
    if (Date.now() - lastSampleLine > 300000) {
      lastSampleLine = Date.now()
      origLog(line)
    }
  }
  drainSaid()
  // Relocated boxes (vmzq.40): read the contents back where the bot says it put them.
  for (const m of seen.said) {
    const mv = /moved the (\S+) out of the castle to (-?\d+) (-?\d+) (-?\d+)/.exec(m)
    if (!mv) continue
    const got = await rcon(`data get block ${mv[2]} ${mv[3]} ${mv[4]} Items`).catch((e) => `error ${e.message}`)
    origLog(`CASTLE-RIG relocated ${mv[1]} at ${mv[2]} ${mv[3]} ${mv[4]}: ${String(got).slice(0, 300)}`)
  }
  const last = series[series.length - 1] || {}
  const done = typeof last.done === 'number' ? last.done : 0
  const total = typeof last.total === 'number' ? last.total : 0
  const top = (obj, n) => Object.entries(obj).sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => `${k}:${v}`).join(',') || 'none'
  const first = seen.wdFirstAt ? Math.round((seen.wdFirstAt - t0) / 1000) : '-'
  // Far event readout (vmzq.29): done at the jump / lowest sample after it
  // (must never drop: an unloaded site keeps the last read) / final.
  const farMin = farAt ? Math.min(...series.filter((x) => x.t * 1000 >= farAt - t0 && typeof x.done === 'number').map((x) => x.done)) : null
  const farTag = farAt ? `, far=${farPre}/${farMin}/${done}${farMin < farPre ? ' DROPPED' : ''}` : ''
  const buryTag = buryAt ? `, bury=surfaced@${surfacedS ?? 'never'}s,resumed@${resumedS ?? 'never'}s` : ''
  const pitTag = pitAt ? `, pit=escaped@${escapedS ?? 'never'}s,resumed@${pitResumedS ?? 'never'}s` : ''
  if (night) night.finish()
  if (resTimer) clearInterval(resTimer)
  if (resNights) resNights.finish(Math.round((Date.now() - t0) / 1000))
  // Yard litter (idkcraft-g0z.44): own blocks left in the fence band —
  // placedByBot candidates from the in-process ctx, read back via rcon
  // (the follower may end far away, its site chunks unloaded). `execute
  // if block` answers 'Test passed' for air, 'Test failed' for a block.
  if (idle) {
    const c = tickCtx()
    const cands = require('../src/castle').ownBandCells(c && c.placedByBot, c && c.castle)
    let n = 0
    for (const cell of cands) {
      const out = await rcon(`execute if block ${cell.x} ${cell.y} ${cell.z} air`).catch((e) => fail('yard-litter', e.message))
      if (/Test passed/.test(out)) continue
      if (/Test failed/.test(out)) { n++; continue }
      fail('yard-litter', `unreadable cell ${cell.x} ${cell.y} ${cell.z}: ${String(out).slice(0, 120)}`)
    }
    if (n > 0) origLog(`CASTLE-RIG yard-litter: ${n} own blocks left in the fence band`)
    idle.setYardLitter(n)
  }
  // Panes (g0z.38): decor pane cells of the seeded castle reading
  // *glass_pane on the follower (unloaded cells are counted apart).
  // Upper fence (g0z.45): the same for the second fence row.
  // Recall (g0z.45): the window's side work can end the follower far off
  // site (a 60-min seed run read 153/153 unread) — tp it over the site and
  // wait for the chunks before counting. Verdict phase only: the idle
  // extremes below accumulate during the window, a centre sample moves none.
  let paneTag = ''
  let fenceTag = ''
  if (SEED === 'complete') {
    const site = { x: bx - 15, y: gy + 1, z: bz - 13 }
    await rcon(`tp ${FOLLOWER} ${site.x + 15.5} ${site.y + 12} ${site.z + 13.5}`).catch(() => {})
    for (let i = 0; i < 30; i++) {
      let loaded = false
      try {
        loaded = [[0, 0], [30, 0], [0, 26], [30, 26]]
          .every(([dx, dz]) => !!follower.blockAt(new Vec3(site.x + dx, site.y, site.z + dz)))
      } catch (_) { loaded = false }
      if (loaded) break
      await sleep(1000)
    }
    const dp = require('../src/castle').decorPlan(site, 0, 2).cells
    for (const [kind, re, tag] of [['pane', /glass_pane$/, 'panes'], ['fence', /_fence$/, 'upper-fence']]) {
      const cells = dp.filter((c) => c.kind === kind)
      let laid = 0
      let unread = 0
      for (const c of cells) {
        let b = null
        try { b = follower.blockAt(new Vec3(c.x, c.y, c.z)) } catch (_) { b = null }
        if (!b) unread++
        else if (re.test(b.name)) laid++
      }
      const t = `, ${tag}=${laid}/${cells.length}${unread ? `(${unread} unread)` : ''}`
      if (kind === 'pane') paneTag = t
      else fenceTag = t
    }
  }
  const nightTag = (night ? night.tag() : '') + seedTag + paneTag + fenceTag + (resNights ? resNights.tag() : '') + (idle ? idle.tag() : '')
  const line = `castle ${done}/${total} in ${MINS} min, flips=${seen.flips}, deaths=${deaths}, top-steps=${top(seen.steps, 4)}, top-fail=${top(seen.fails, 3)}, watchdog=${seen.wdCalls}, first=${first}, choices=${top(seen.wdChoices, 3)}, outcomes=progress:${seen.outcomes.progress},flat:${seen.outcomes.flat},preempted:${seen.outcomes.preempted}${farTag}${buryTag}${pitTag}${nightTag}`
  const record = {
    date: new Date().toISOString(), mins: MINS, done, total, flips: seen.flips, deaths,
    steps: seen.steps, fails: seen.fails, pad: { x0, x1, z0, z1, top: gy, cx: bx, cz: bz, span: brel ? brel.span : null },
    tag: TAG, gitsha: process.env.CASTLE_GITSHA || '?', log: LOGFILE,
    kit: KIT, tickrate: TICKRATE, planner: PLANNER, blocked: blockedSeeds, said: seen.said,
    wdCalls: seen.wdCalls, wdFirstS: first, wdChoices: seen.wdChoices, outcomes: seen.outcomes,
    series, timeEvents: seen.timeEvents, timeMaxDrift: seen.timeMaxDrift,
    nights: night ? night.nights : undefined,
    seed: SEED || undefined, residence: resNights ? resNights.nights : undefined,
  }
  try { fs.writeFileSync(OUT, JSON.stringify(record, null, 1)) } catch (e) {
    origLog(`CASTLE-RIG out write failed: ${e.message}`)
  }
  origLog(line)
  const idleV = idle ? idle.verdict(deaths - idleForced, resNights ? resNights.nights : []) : null
  if (idleV) origLog(idleV.line)
  try { logStream.end() } catch (_) { /* close best-effort */ }
  process.exit(idleV && !idleV.pass ? 1 : 0)
}

if (require.main === module) {
  main().catch((e) => {
    origLog(`CASTLE-RIG FATAL: ${e && e.message ? e.message : e}`);
    try { logStream.end() } catch (_) { /* close best-effort */ }
    process.exit(2)
  })
}
module.exports = { createIdleTrack, IDLE_MAXDIST, idleRespawnPoint, classify, seen, resetSeen, pickBlockedSeeds, createResidenceNights, seedCastleCells, seedMatches, pickPadSpot, createTimeResync, timeDrift, createNightDriver, landingY, padFloats }
