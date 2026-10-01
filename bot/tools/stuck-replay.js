'use strict'
// STUCK REGRESSION RUN (idkcraft-4rz): replay known prod stuck spots on the
// prod-world snapshot with the REAL bot stack (runOnce + stubBrain following
// a guide parked on the logged goal) and print a per-spot table:
//   spot | reached? | stuck resets | recover episodes | call_player? | time
// Spots are data (default: stuck-spots.json next to this file; argv[2]/
// REPLAY_SPOTS overrides with another file):
//   [{"name":"EP1","spawn":[-61.3,66,-210.5],"goal":[-72,65,-218],
//     "secs":75,"scaffold":0,"pickaxe":true}]
// secs/scaffold/pickaxe are optional (defaults 75 / 64 dirt / stone pickaxe).
// bucket:true adds 2 water buckets (jsf.2 water_up needs a pair: high pour +
// ledge pour, both back after the strip). REPLAY_OP=1 pre-ops both bots
// before login (deterministic offline UUIDs, like water-assay.js ASSAY_OP):
// spots inside spawn protection (CLUSTER, r=16) refuse un-opped pours, so
// water_up spots run opped — mirroring a prod bot with op.
// Order spots (idkcraft-6x7.7) replay work mode instead of a follow walk:
// the guide parks ON the goal (the delivery point, near the spawn) and chats
// `order` at window start; reached = an `expect` marker seen in follower
// chat, a `fail` marker ends the window unreached:
//   [{"name":"ATL-SHAFT","mode":"order","spawn":[59.5,64,-205.5],
//     "goal":[62.5,64,-205.5],"order":"bring me iron_ore 2",
//     "expect":["here is ","here are "],"fail":["could not "]}]
// mode defaults to follow; goal keeps its feet-coords convention in both.
// The 4 header rig spots stay embedded as a no-file fallback.
// Usage: node stuck-replay.js [spots.json] [secs]
// Env: REPLAY_SPOTS (spots file; argv[2] wins), REPLAY_SECS (argv[3] wins),
//   REPLAY_QUIET=0 (keep per-tick ticker chatter; default filters it so the
//   table stays readable — recover/stuck lines always print),
//   REPLAY_HOST (127.0.0.1), REPLAY_PORT (25571),
//   REPLAY_CONTAINER (idk-replay, docker exec rcon-cli for tp/op),
//   REPLAY_TAG (bot name suffix; default random), REPLAY_OUT (JSON results
//   path; default tools/last-replay.json, gitignored),
//   REPLAY_BASELINE (baseline file; default stuck-baseline.json next to
//   this file), REPLAY_BASELINE_OFF=1 (record only, skip the comparison),
//   REPLAY_BRAIN (stub|laya; default stub — laya runs the follower on the
//   hybrid brain against the prod sidecar, see REPLAY_BRAIN_URL),
//   REPLAY_BRAIN_URL (default http://localhost:8000/v1/systemone — the
//   operator's tunnel to the prod sidecar; sequential single-bot calls,
//   inference only, never a local stand),
//   REPLAY_VARIANT/REPLAY_WORLDSHA/REPLAY_GITSHA (run header,
//   set by stuck-run.sh). The rig server must already be up.
// Exit codes: 0 = baseline holds (or comparison skipped), 1 = REGRESSION
// vs the baseline (a spot flipped reached->unreached, or overran its
// stuck/episode ceiling, or has no baseline entry), 2 = harness/env error
// (guide setup failed, follower dropped mid-run, rig never came up).
// Code under test is imported, never copied: runOnce, recover.setStuck,
// the shipped follow path and movement wrappers.
const mineflayer = require('mineflayer')
const fs = require('node:fs')
const { execFile } = require('node:child_process')
const { promisify } = require('node:util')

const execFileAsync = promisify(execFile)

const HOST = process.env.REPLAY_HOST || '127.0.0.1'
const PORT = parseInt(process.env.REPLAY_PORT || '25571', 10)
const CONTAINER = process.env.REPLAY_CONTAINER || 'idk-replay'
const TAG = process.env.REPLAY_TAG || String(Math.floor(Math.random() * 1000))
const GUIDE = `StuckGuide${TAG}`
const FOLLOWER = `StuckReplay${TAG}`
const DEFAULT_SECS = parseInt(process.argv[3] || process.env.REPLAY_SECS || '75', 10)
const REACH_DIST = 2.5 // GoalNear r=2 equivalent, on 2 Hz samples

// The guide stands BEYOND the goal along the spawn->goal walk line (not on
// it): stubBrain only follows a still player at d>6 and roams inside, so a
// guide on a close goal would never exercise the follow path (EP0 starts at
// 5.97). reached = passed within 2.5 of the goal point OR arrived within 6
// of the guide landing (detours count as through-walks) — except spots
// whose spawn sits inside the goal shell (<4), which judge by guide
// arrival only (else S7's 1.87 starts reached with maxDisp 0.0).
const DEFAULT_SPOTS = [
  { name: 'EP1', spawn: [-61.3, 66, -210.5], goal: [-72, 65, -218] },
  { name: 'CLUSTER', spawn: [-59.6, 54, -211.3], goal: [-59, 58, -205] },
  { name: 'EP2', spawn: [-37.5, 61, -219.3], goal: [-37, 65, -212] },
  { name: 'EP0', spawn: [-56.4, 63, -194.5], goal: [-60, 64, -200] },
]

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)) }

// Ticker chatter filter (default on): the table is the product; per-tick
// decision/scout lines would bury it. Recover/stuck/error lines pass.
if (process.env.REPLAY_QUIET !== '0') {
  const origLog = console.log
  const MUTE = ['decision ', 'scout ', 'kit ', 'eat ', 'goal step=', 'search ', 'resting: ', 'next: ']
  console.log = (...a) => {
    try {
      if (a.length > 0 && typeof a[0] === 'string' && MUTE.some((p) => a[0].startsWith(p))) return
    } catch (_) { /* fall through */ }
    origLog(...a)
  }
}

async function rcon(cmd) {
  const { stdout } = await execFileAsync('docker', ['exec', CONTAINER, 'rcon-cli', cmd])
  // rcon-cli exits 0 even when the command fails ("No entity was found"),
  // so assert on the output text instead of the exit code.
  const out = String(stdout)
  if ((cmd.startsWith('tp ') && !out.includes('Teleported')) ||
      (cmd.startsWith('op ') && !out.toLowerCase().includes('operator')) ||
      ((cmd.startsWith('clear ') || cmd.startsWith('give ') || cmd.startsWith('effect ')) && /No entity was found|Unknown|incorrect/i.test(out))) {
    throw new Error(`rcon failed [${cmd}]: ${out.trim().slice(0, 160)}`)
  }
  return String(stdout)
}

function loadSpots() {
  const path = require('node:path')
  const bundled = path.join(__dirname, 'stuck-spots.json')
  const file = process.argv[2] || process.env.REPLAY_SPOTS || (fs.existsSync(bundled) ? bundled : null)
  const list = file ? JSON.parse(fs.readFileSync(file, 'utf8')) : DEFAULT_SPOTS
  if (!Array.isArray(list) || list.length === 0) throw new Error('spots: non-empty array expected')
  return list.map((s, i) => {
    if (!s || typeof s.name !== 'string' || !Array.isArray(s.spawn) || s.spawn.length !== 3 || !Array.isArray(s.goal) || s.goal.length !== 3) {
      throw new Error(`spots[${i}]: need {name, spawn:[x,y,z], goal:[x,y,z]}`)
    }
    const secs = s.secs == null ? DEFAULT_SECS : Number(s.secs)
    if (!Number.isFinite(secs) || secs <= 0) throw new Error(`spots[${i}]: bad secs`)
    const scaffold = s.scaffold == null ? 64 : Number(s.scaffold)
    if (!Number.isFinite(scaffold) || scaffold < 0 || scaffold > 2304) throw new Error(`spots[${i}]: bad scaffold`)
    const pickaxe = s.pickaxe == null ? true : !!s.pickaxe
    const bucket = s.bucket == null ? false : !!s.bucket
    // bead: provenance for the corpus rule (every closed movement bead adds
    // its prod coords + a baseline entry). Optional, validated, passed
    // through to the row so the JSON stays traceable.
    const bead = s.bead == null ? '' : String(s.bead)
    if (bead.length > 64) throw new Error(`spots[${i}]: bad bead`)
    // Order spots (idkcraft-6x7.7): mode=order replays a guide-chatted work
    // order instead of a follow walk. order/expect/fail are required there
    // and rejected on follow spots (dead data in a gate corpus confuses).
    const mode = s.mode == null ? 'follow' : String(s.mode)
    if (mode !== 'follow' && mode !== 'order') throw new Error(`spots[${i}]: bad mode (want follow|order)`)
    let order = null
    let expect = null
    let fail = null
    if (mode === 'order') {
      if (typeof s.order !== 'string' || !s.order.trim() || s.order.length > 256) {
        throw new Error(`spots[${i}]: order spots need a chat order (<=256 chars)`)
      }
      order = s.order
      for (const [k, v] of [['expect', s.expect], ['fail', s.fail]]) {
        if (!Array.isArray(v) || v.length === 0 || v.length > 16) {
          throw new Error(`spots[${i}]: order spots need non-empty ${k} markers (<=16)`)
        }
        for (const m of v) {
          if (typeof m !== 'string' || !m || m.length > 80) throw new Error(`spots[${i}]: bad ${k} marker`)
        }
      }
      expect = s.expect.slice()
      fail = s.fail.slice()
    } else if (s.order != null || s.expect != null || s.fail != null) {
      throw new Error(`spots[${i}]: order/expect/fail need mode=order`)
    }
    return { name: s.name, spawn: s.spawn, goal: s.goal, secs, scaffold, pickaxe, bucket, bead, mode, order, expect, fail }
  })
}

// Order-spot chat verdict (idkcraft-6x7.7): pure, unit-tested. Matches one
// follower chat line against the spot's expect/fail markers (substring —
// bot lines carry counts and coords, e.g. 'here are 2 iron_ore'). Markers
// are per-order-kind data: every expect/fail hit must be terminal for THAT
// order (a bring's 'here are' delivers; its 'I can't see you' waits and is
// NOT a fail marker). Expect wins when one line matches both (no shipped
// line does — the order keeps the matcher total, not opinionated).
function matchOrderLine(line, expect, fail) {
  const s = String(line)
  if (expect.some((m) => s.includes(m))) return 'expect'
  if (fail.some((m) => s.includes(m))) return 'fail'
  return null
}

// Window verdict step (idkcraft-6x7.7 revmux 01 core-2): pure,
// unit-tested. Follow spots end on position; order spots NEVER do — the
// bot starts within guide range (gd<=6 at t=0 on ATL-SHAFT), so a
// position break would end the window before any chat marker is scanned
// and the spot would pass no matter what the order did (fail-open).
// Only the chat verdict judges an order. Returns true/false on a
// terminal verdict, null to keep the window open.
function windowReached(mode, useGoal, d, gd, orderVerdict) {
  if (mode === 'order') {
    if (orderVerdict === 'expect') return true
    if (orderVerdict === 'fail') return false
    return null
  }
  if ((useGoal && d !== null && d < REACH_DIST) || (gd !== null && gd <= 6)) return true
  return null
}

// Baseline comparison (idkcraft-6x7.4): pure, unit-tested. baseline shape:
//   { brain: 'stub', spots: { NAME: { reached: bool, maxStuck: n, maxEps: m, maxCalls: k } } }
// was/now diffs print per spot; verdicts: 'ok', 'improved' (reached flipped
// false->true — exit stays 0, the entry wants updating), 'regressed',
// 'no-baseline' (a corpus spot without an entry fails the gate: record via
// REPLAY_BASELINE_OFF=1, then commit the entry with the spot).
// Ceilings are tripwires with slack, so under-ceiling runs are 'ok', not
// 'improved' — a green run must be quiet, else the gate trains its readers
// to skim (the first judged run printed 15 IMPROVED lines for a clean 0/0).
// maxCalls is the strict one (no slack): a page is a gave-up, a decision,
// not physics — and S6-PIT trips it when the recover budget breaks
// (MAX_FAILS=0 pages after the first failed primitive instead of rescuing;
// see README Sensitivity). Widening it needs the same re-record rule.
function compareBaseline(rows, baseline) {
  const want = (baseline && baseline.spots) || {}
  return rows.map((r) => {
    const e = want[r.spot]
    if (!e || typeof e.reached !== 'boolean' ||
        !Number.isInteger(e.maxStuck) || e.maxStuck < 0 ||
        !Number.isInteger(e.maxEps) || e.maxEps < 0 ||
        !Number.isInteger(e.maxCalls) || e.maxCalls < 0) {
      return { spot: r.spot, verdict: 'no-baseline', was: 'none', now: `reached=${r.reached} stuck=${r.stuck} eps=${r.eps} calls=${r.call}` }
    }
    const was = `reached=${e.reached} stuck<=${e.maxStuck} eps<=${e.maxEps} calls<=${e.maxCalls}`
    const now = `reached=${r.reached} stuck=${r.stuck} eps=${r.eps} calls=${r.call}`
    if (!r.reached && e.reached) return { spot: r.spot, verdict: 'regressed', was, now, why: 'unreached (was reached)' }
    if (r.stuck > e.maxStuck) return { spot: r.spot, verdict: 'regressed', was, now, why: `stuck ${r.stuck} > ${e.maxStuck}` }
    if (r.eps > e.maxEps) return { spot: r.spot, verdict: 'regressed', was, now, why: `episodes ${r.eps} > ${e.maxEps}` }
    if (r.call > e.maxCalls) return { spot: r.spot, verdict: 'regressed', was, now, why: `calls ${r.call} > ${e.maxCalls}` }
    if (r.reached && !e.reached) return { spot: r.spot, verdict: 'improved', was, now }
    return { spot: r.spot, verdict: 'ok', was, now }
  })
}

function loadBaseline() {
  const path = require('node:path')
  const file = process.env.REPLAY_BASELINE || path.join(__dirname, 'stuck-baseline.json')
  if (!fs.existsSync(file)) return { file, baseline: null }
  return { file, baseline: JSON.parse(fs.readFileSync(file, 'utf8')) }
}

// Gate verdict (idkcraft-6x7.4): pure, unit-tested. diffs aligns with rows
// by index (see compareBaseline). Rows the bot never ran (the guide buried
// or died in setup) are environment failures, not regressions: they skip
// the comparison and force exit 2. Env dominates a co-occurring regression
// (3ro's lesson: never send the dev to bisect code while the rig is sick —
// the rerun re-surfaces any real regression; both print either way).
// A dropped follower never reaches here (the exit wrapper maps it to 2);
// a dead follower (DIED) stays judged — dying is behavior.
// Follower-drop guard (idkcraft-6x7.4): runOnce's fatal path (follower
// kicked/error/disconnected) hard-exits 1, which the wrapper would read as
// REGRESSION. The guard maps any exit(1) before arm() to exit 2 (env); the
// gate's own exit arms first and passes through untouched. Pure over the
// injected realExit, unit-tested. No runOnce hook exists and index.js is
// out of scope for rig code, hence the interposer instead of a parameter.
function makeExitGuard(realExit) {
  let armed = false
  return {
    arm() { armed = true },
    exit(code) {
      if (code === 1 && !armed) {
        console.error('REPLAY-ERROR follower dropped before the verdict (kicked/error/disconnect?)')
        return realExit(2)
      }
      return realExit(code)
    },
  }
}

const ENV_NOTES = new Set(['GUIDE-BURIED', 'GUIDE-DIED'])
function gateCode(rows, diffs) {
  let ok = 0
  let better = 0
  let bad = 0
  let env = 0
  diffs.forEach((d, i) => {
    if (ENV_NOTES.has(rows[i] && rows[i].note)) { env++; return }
    if (d.verdict === 'ok') ok++
    else if (d.verdict === 'improved') better++
    else bad++ // regressed + no-baseline both fail the gate
  })
  const code = env > 0 ? 2 : bad > 0 ? 1 : 0
  return { code, ok, better, bad, env }
}

// Follower brain (idkcraft-6x7.4): stub by default; laya runs the shipped
// hybrid (FSM primary, model on hard states only) against the prod sidecar
// via the operator's tunnel — sequential single-bot inference calls, the
// same read-only shape the stands use. Unknown values fail loud (exit 2):
// a typo must not silently measure the wrong brain.
function pickBrain() {
  const which = process.env.REPLAY_BRAIN || 'stub'
  if (which === 'stub') return { label: 'stub', make: () => require('../src/brain').stubBrain }
  if (which === 'laya') {
    const url = process.env.REPLAY_BRAIN_URL || 'http://localhost:8000/v1/systemone'
    const timeout = parseInt(process.env.REPLAY_BRAIN_TIMEOUT_MS || '10000', 10)
    return {
      label: `laya(${url})`,
      make: () => {
        const { jevBrain, hybridBrain } = require('../src/brain')
        return hybridBrain(jevBrain('replay', undefined, Number.isFinite(timeout) ? timeout : 10000, url))
      },
    }
  }
  throw new Error(`REPLAY_BRAIN: want stub|laya, got ${JSON.stringify(which)}`)
}

function waitFor(em, ev, ms, what) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { em.removeListener(ev, on); reject(new Error(`${what} timeout`)) }, ms)
    function on(...a) { clearTimeout(t); resolve(a) }
    em.once(ev, on)
  })
}

// Headroom verify-and-step (idkcraft-4rz round 4): check-then-step with
// steps+1 checks for steps tps — the last tp's landing is re-checked
// too, else a spot it cleared would be falsely GUIDE-BURIED. readHead()
// returns the head block (null when unreadable, counts as solid); tpUp()
// climbs one step; alive() lets a mid-loop guide death cut the climb
// short (the caller then reports GUIDE-DIED, not GUIDE-BURIED).
async function verifyHeadroom(readHead, tpUp, alive, steps = 6) {
  let buried = false
  let tps = 0
  for (let i = 0; i <= steps && alive(); i++) {
    const head = readHead()
    // Passability, not block names: tall grass/kelp/vines are fine to
    // stand in (boundingBox empty); only solid rock needs stepping over.
    if (head && head.boundingBox === 'empty') { buried = false; break }
    buried = true
    if (i < steps) { await tpUp(); tps++ }
  }
  return { buried, tps }
}

async function main() {
  const spots = loadSpots()
  // Usernames cap at 16 chars: an overlong TAG dies in the hello decode
  // with a cryptic server-side error, so fail fast with the real cause.
  if (GUIDE.length > 16 || FOLLOWER.length > 16) {
    throw new Error(`bot names exceed 16 chars (TAG=${JSON.stringify(TAG)}); set a shorter REPLAY_TAG`)
  }
  const picked = pickBrain()
  // Installed before the follower exists: any fatal exit(1) from here on
  // is a dropped follower (env → 2) until the gate arms its own verdict.
  const exitGuard = makeExitGuard(process.exit.bind(process))
  process.exit = exitGuard.exit
  const index = require('../src/index')
  const brain = picked.make()
  const recover = require('../src/behaviours/recover')
  const bringMod = require('../src/behaviours/bring')

  // Windowed counters (reset per spot): stuck declarations, path resets by
  // reason, follower-sent chats. Patched once — the ticker reads them live.
  let stuckEps = []
  let resets = {}
  let chats = []
  let died = false
  const origSetStuck = recover.setStuck
  // Count only declarations that stick: setStuck returns false while an
  // episode is in flight or the latch holds (recover.js) — those calls
  // declare nothing, so counting them would equate a latched fix with a loop.
  recover.setStuck = (...args) => { const r = origSetStuck(...args); if (r) stuckEps.push(args[1]); return r }

  // Pre-login op (jsf.2): offline UUIDs derive from the name, and a
  // mid-session op does not lift spawn protection for the live session.
  if (process.env.REPLAY_OP === '1') {
    await rcon(`op ${GUIDE}`)
    await rcon(`op ${FOLLOWER}`)
  }
  const guide = mineflayer.createBot({ host: HOST, port: PORT, username: GUIDE, auth: 'offline' })
  await waitFor(guide, 'spawn', 60000, 'guide spawn')
  // Chunks in, plus past Paper's 4000 ms connection throttle (bukkit.yml):
  // a same-IP login inside the window is kicked pre-spawn with no event
  // to retry on (runOnce fatal-exits), so the gap must hold by itself.
  await sleep(6000)

  let follower = null
  const mk = (opts) => {
    const b = mineflayer.createBot({ ...opts, username: FOLLOWER })
    follower = b
    b.on('path_reset', (reason) => {
      const k = String(reason)
      resets[k] = (resets[k] || 0) + 1
    })
    b.on('death', () => { died = true })
    b.once('error', (e) => console.error(`follower pre-spawn error: ${e && e.message ? e.message : e}`))
    b.once('end', () => { if (!b.entity) console.error('follower ended before spawn (rig connection throttle?)') })
    // Chat record-and-forward, patched on spawn: b.chat is undefined on a
    // fresh bot (mineflayer injects it at login), so patching in mk throws
    // and silently kills runOnce. This listener attaches before runOnce's
    // own spawn tap, so no ticker chat slips past.
    b.once('spawn', () => {
      const origChat = b.chat.bind(b)
      b.chat = (msg) => { chats.push(String(msg)); return origChat(msg) }
    })
    return b
  }
  index.runOnce({
    host: HOST, port: PORT, username: FOLLOWER, tickMs: 1000, idleTickMs: 1000,
    brain, leaveAfterMs: 0, followName: GUIDE, createBot: mk,
    pingFn: async () => ({ players: {} }),
  }).then(() => {}, (e) => { console.error('REPLAY-ERROR runOnce rejected:', e && e.message ? e.message : e); process.exit(2) })
  if (!follower) throw new Error('follower never created')
  await Promise.race([
    waitFor(follower, 'spawn', 60000, 'follower spawn'),
    (async () => { for (let i = 0; i < 240 && !follower.entity; i++) await sleep(250) })(),
  ])
  await sleep(3000)
  // Operator status (idkcraft-3ro): the spawn-cluster replay spots sit
  // inside the spawn-protection radius (world spawn (-48,65,-208), r=16),
  // and Paper
  // enforces protection once ops.json is non-empty — one afternoon op
  // (another rig's probes, 2026-09-28) armed it for every later run and
  // the baseline collapsed to 3/10 with no code change anywhere (only
  // the pure-walk spots pass unopped). Op both bots once per run, before
  // the first spot, so the etalon never depends on ambient ops.json
  // state again; rcon asserts, so a run that lost op fails loud. rcon
  // cannot set spawn-protection and START.sh lives outside the repo, so
  // self-op is the harness-side fix (resetting ops.json would delete
  // other rigs' live entries).
  await rcon(`op ${GUIDE}`)
  await rcon(`op ${FOLLOWER}`)
  // Park the body for setups: without this the ticker walks during the
  // multi-second tp/kit/settle phase and rows measure pre-window walking
  // (baseline-1 EP0 reached in 1 s with maxDisp 0.0). ctx.paused is the
  // bot's own 'stop' park (brain skipped, idle dispatched); each window
  // unparks after its boundary reset.
  const tickCtx = () => follower._tickerCtx
  if (tickCtx()) tickCtx().paused = true

  console.log(`stuck-replay tag=${TAG} variant=${process.env.REPLAY_VARIANT || '?'} brain=${picked.label} ` +
    `worldsha=${(process.env.REPLAY_WORLDSHA || '?').slice(0, 12)} gitsha=${process.env.REPLAY_GITSHA || '?'} ` +
    `date=${new Date().toISOString()} spots=${spots.length}`)
  console.log('spot      reached  stuck  eps  call?  secs   maxDisp  note')
  const rows = []
  let guideDied = false
  let prevBucket = false
  guide.on('death', () => { guideDied = true })
  for (const s of spots) {
    guideDied = false
    const wipeFlood = prevBucket
    prevBucket = !!s.bucket
    if (tickCtx()) tickCtx().paused = true
    // Hard-stop BEFORE the guide tp: paused takes effect on the next tick
    // (<=1 s), but the guide tp re-plans the live GoalFollow instantly from
    // the old spot — and stop() only latches a flag the stale path may not
    // honor for seconds. setGoal(null) resets the path synchronously, so no
    // walk can leak into the setup phase.
    try { follower.pathfinder.setGoal(null) } catch (_) { /* goal best-effort */ }
    try { follower.clearControlStates() } catch (_) { /* control best-effort */ }
    // Guide beyond the goal (horizontal projection): the follow walk passes
    // through the goal point. Degenerate vertical goals fall back to +x.
    // Start above both ends, then verify headroom: a guide tp'd into rock
    // suffocates (baseline-1 S6) and a buried guide near spawn fakes
    // reached (baseline-1 EP0/S4).
    // Order spots park the guide ON the goal instead: it is the delivery
    // point (corpus rule: near the spawn), and the bot walks back to it.
    let gx; let gz; let gy
    if (s.mode === 'order') {
      gx = s.goal[0]; gz = s.goal[2]; gy = s.goal[1] + 1
    } else {
      let dx = s.goal[0] - s.spawn[0]; let dz = s.goal[2] - s.spawn[2]
      let len = Math.hypot(dx, dz)
      if (!(len > 0.01)) { dx = 1; dz = 0; len = 1 }
      const L = Math.max(14, Math.hypot(s.goal[0] - s.spawn[0], s.goal[1] - s.spawn[1], s.goal[2] - s.spawn[2]) + 6)
      gx = s.spawn[0] + (dx / len) * L; gz = s.spawn[2] + (dz / len) * L
      gy = Math.max(s.spawn[1], s.goal[1]) + 1
    }
    await rcon(`tp ${GUIDE} ${gx.toFixed(1)} ${gy} ${gz.toFixed(1)}`)
    await rcon(`tp ${FOLLOWER} ${s.spawn[0]} ${s.spawn[1]} ${s.spawn[2]}`)
    // A bucket spot's flood (failed strip, trial-budget cut mid-climb)
    // persists in the shared world and griefs the next trial's scans: wipe
    // water around the spawn when the previous spot poured (both bots are
    // here now, so the chunks are loaded). Dig holes stay (harness-standard:
    // terrain progress persists across spots).
    if (wipeFlood) {
      const [sx, sy, sz] = s.spawn.map(Math.floor)
      await rcon(`fill ${sx - 12} ${sy - 6} ${sz - 12} ${sx + 12} ${sy + 12} ${sz + 12} air replace water`)
    }
    // Fresh kit per spot (repeatability: drops picked up mid-run reset).
    await rcon(`clear ${FOLLOWER}`)
    if (s.scaffold > 0) await rcon(`give ${FOLLOWER} dirt ${s.scaffold}`)
    if (s.pickaxe) await rcon(`give ${FOLLOWER} stone_pickaxe 1`)
    if (s.bucket) {
      await rcon(`give ${FOLLOWER} water_bucket 1`)
      await rcon(`give ${FOLLOWER} water_bucket 1`)
    }
    // Anti-noise effects (death ends windows early and corrupts stuck
    // measurement): guides stand in water/lava lakes, followers walk them.
    for (const who of [GUIDE, FOLLOWER]) {
      await rcon(`effect give ${who} minecraft:water_breathing 200`)
      await rcon(`effect give ${who} minecraft:fire_resistance 200`)
    }
    await sleep(2000) // chunks in, guide landed
    const { buried } = await verifyHeadroom(
      () => { try { return guide.blockAt(guide.entity.position.offset(0, 1, 0)) } catch (_) { return null } },
      async () => {
        gy += 2
        await rcon(`tp ${GUIDE} ${gx.toFixed(1)} ${gy} ${gz.toFixed(1)}`)
        await sleep(800) // let it fall back before re-checking
      },
      () => !guideDied,
    )
    if (buried && !guideDied) {
      rows.push({ spot: s.name, reached: false, stuck: 0, eps: 0, by: [], call: 0, secs: 0, maxDisp: 0, minDist: -1, minGuide: -1, note: 'GUIDE-BURIED', bead: s.bead || undefined })
      console.log(`${s.name.padEnd(9)} ${String(false).padEnd(7)} ${String(0).padEnd(6)} ` +
        `${String(0).padEnd(4)} ${String(false).padEnd(6)} ${String(0).padEnd(6)} ${(0).toFixed(1).padEnd(8)} GUIDE-BURIED`)
      continue
    }
    if (guideDied || !guide.entity) {
      rows.push({ spot: s.name, reached: false, stuck: 0, eps: 0, by: [], call: 0, secs: 0, maxDisp: 0, minDist: -1, minGuide: -1, note: 'GUIDE-DIED', bead: s.bead || undefined })
      console.log(`${s.name.padEnd(9)} ${String(false).padEnd(7)} ${String(0).padEnd(6)} ` +
        `${String(0).padEnd(4)} ${String(false).padEnd(6)} ${String(0).padEnd(6)} ${(0).toFixed(1).padEnd(8)} GUIDE-DIED`)
      continue
    }
    const gl = guide.entity.position.clone()
    // Deterministic episode boundary (a tp is already unfaithful; a clean
    // cut beats a timed quiesce): mirror index.js clearStuck plus the
    // streak counters and the live goal, and release held controls so a
    // killed mid-flight primitive leaves no stuck keys.
    const c = follower._tickerCtx
    if (c) {
      c.stuck = null; c.recovery = null; c.recoverLatch = null; c.retreat = null
      c.stuckTicks = 0; c.stuckResets = 0; c.placeErrors = 0; c.lastGoalKey = ''
      c.stuckState = 'MOVING'; c.jumpCooldown = 0
      // Order-spot hygiene (idkcraft-6x7.7): a timed-out order owns the body
      // over follow, so a live ctx.bring (or a pending far search about to
      // open one) would hijack the NEXT window's walk. Drop both at the cut.
      if (c.bring) { c.bring = null; try { bringMod.clearSearchLeg(c) } catch (_) { /* legs best-effort */ } }
      c.pendingSearch = null
    }
    stuckEps = []
    resets = {}
    chats = []
    died = false
    if (c) c.paused = false
    // Order spots (idkcraft-6x7.7): the guide chats the work order at window
    // start, like a player would — the follower takes it through the real
    // handleChat path (a bring owns the body over follow). A send failure
    // is rig sickness, not a verdict: fail loud (exit 2), never burn the
    // window and misreport a timeout as a regression.
    if (s.mode === 'order') {
      try { guide.chat(s.order) } catch (e) {
        throw new Error(`spot ${s.name}: order chat failed: ${e && e.message ? e.message : e}`)
      }
    }
    const t0 = Date.now()
    try { follower.pathfinder.setGoal(null) } catch (_) { /* goal best-effort */ }
    for (const k of ['jump', 'back', 'forward', 'sprint', 'sneak']) {
      try { follower.setControlState(k, false) } catch (_) { /* control best-effort */ }
    }
    const p0 = follower.entity.position.clone()
    let minDist = Infinity
    let minGuide = Infinity
    let maxDisp = 0
    let reached = false
    // Order-spot verdict (idkcraft-6x7.7): the first expect/fail marker in
    // windowed follower chat. scannedChats cursors the shared array so each
    // line judges once; position never judges an order (the bot starts
    // within guide range, so a position break would end the window at t=0).
    let orderVerdict = null
    let orderLine = ''
    let scannedChats = 0
    const scanOrderChat = () => {
      if (s.mode !== 'order' || orderVerdict) return
      for (; scannedChats < chats.length; scannedChats++) {
        const v = matchOrderLine(chats[scannedChats], s.expect, s.fail)
        if (v) { orderVerdict = v; orderLine = String(chats[scannedChats]); break }
      }
    }
    const tx = s.goal[0]; const ty = s.goal[1]; const tz = s.goal[2]
    const useGoal = Math.hypot(tx - s.spawn[0], ty - s.spawn[1], tz - s.spawn[2]) >= 4
    while (Date.now() - t0 < s.secs * 1000 && !died && !guideDied) {
      await sleep(500)
      let d = null
      let gd = null
      try {
        const p = follower.entity.position
        d = Math.hypot(p.x - tx, p.y - ty, p.z - tz)
        if (d < minDist) minDist = d
        gd = Math.hypot(p.x - gl.x, p.y - gl.y, p.z - gl.z)
        if (gd < minGuide) minGuide = gd
        const disp = p.distanceTo(p0)
        if (disp > maxDisp) maxDisp = disp
      } catch (_) { /* sampling best-effort */ }
      scanOrderChat()
      // Reached ends the window: post-goal walking is outside the spot.
      const w = windowReached(s.mode, useGoal, d, gd, orderVerdict)
      if (w !== null) { reached = w; break }
    }
    scanOrderChat() // final gap: a marker in the last <500 ms still counts
    const wEnd = windowReached(s.mode, false, null, null, orderVerdict)
    if (wEnd !== null) reached = wEnd
    const secs = (Date.now() - t0) / 1000
    const stuck = resets.stuck || 0
    const call = chats.filter((m) => m.includes("I'm stuck at")).length
    // Order spots report the terminal line (truncated): TIMEOUT vs FAIL
    // tells a hung order from a refused one at a glance. Death keeps its
    // note (dying is behavior, judged like any unreached row).
    const onote = s.mode === 'order'
      ? (orderVerdict === 'expect' ? `OK ${orderLine}` : orderVerdict === 'fail' ? `FAIL ${orderLine}` : 'TIMEOUT').slice(0, 70)
      : ''
    const note = died ? 'DIED' : (guideDied ? 'GUIDE-DIED' : onote)
    rows.push({ spot: s.name, reached, stuck, eps: stuckEps.length, by: stuckEps, call, secs: +secs.toFixed(0), maxDisp: +maxDisp.toFixed(1), minDist: +minDist.toFixed(1), minGuide: +minGuide.toFixed(1), note, bead: s.bead || undefined, ...(s.mode === 'order' ? { order: s.order, orderLine: orderLine || null } : {}) })
    console.log(`${s.name.padEnd(9)} ${String(reached).padEnd(7)} ${String(stuck).padEnd(6)} ` +
      `${String(stuckEps.length).padEnd(4)} ${String(call > 0).padEnd(6)} ${String(secs.toFixed(0)).padEnd(6)} ${maxDisp.toFixed(1).padEnd(8)} ${note}`)
  }
  const path = require('node:path')
  const outFile = process.env.REPLAY_OUT || path.join(__dirname, 'last-replay.json')
  fs.writeFileSync(outFile, JSON.stringify(rows, null, 1) + '\n')
  console.log(`results: ${outFile}`)
  // Baseline gate (idkcraft-6x7.4): compare, print the was/now diff, exit 1
  // on any regression. A laya run never judges against the stub baseline
  // (different menu policy): it records and exits 0 until a laya baseline
  // ships. REPLAY_BASELINE_OFF=1 records without judging (how a new spot's
  // entry is measured before it is committed).
  let code = 0
  const brainName = (process.env.REPLAY_BRAIN || 'stub')
  if (process.env.REPLAY_BASELINE_OFF === '1') {
    console.log('baseline: skipped (REPLAY_BASELINE_OFF=1)')
  } else if (brainName !== 'stub') {
    console.log(`baseline: skipped (no ${brainName} baseline committed; stub baseline does not apply)`)
  } else {
    const { file, baseline } = loadBaseline()
    if (!baseline) {
      console.log(`baseline: no file at ${file} — run unjudged (commit the baseline to arm the gate)`)
    } else {
      const diffs = compareBaseline(rows, baseline)
      const verdict = gateCode(rows, diffs)
      diffs.forEach((d, i) => {
        if (ENV_NOTES.has(rows[i] && rows[i].note)) {
          console.log(`BASELINE ${d.spot}: ${rows[i].note} — ENV (setup failed, not judged)`)
          return
        }
        if (d.verdict === 'ok') return
        if (d.verdict === 'improved') {
          console.log(`BASELINE ${d.spot}: was ${d.was} | now ${d.now} — IMPROVED (update the baseline)`)
        } else {
          const why = d.verdict === 'no-baseline' ? 'NO BASELINE ENTRY' : `REGRESSION (${d.why})`
          console.log(`BASELINE ${d.spot}: was ${d.was} | now ${d.now} — ${why}`)
        }
      })
      console.log(`baseline: ${verdict.ok}/${diffs.length} ok, ${verdict.better} improved, ` +
        `${verdict.bad} regressed, ${verdict.env} env (${file})`)
      code = verdict.code
    }
  }
  // Quit the guide only: quitting the follower trips runOnce's fatal end
  // path (exit 1 races our gate code — and the guard above would map it
  // to 2). The follower socket dies with us.
  try { guide.quit() } catch (_) {}
  await sleep(1000)
  exitGuard.arm()
  process.exit(code)
}

if (require.main === module) {
  main().catch((e) => { console.error('REPLAY-ERROR', e && e.message ? e.message : e); process.exit(2) })
}

module.exports = { verifyHeadroom, compareBaseline, loadBaseline, pickBrain, loadSpots, gateCode, ENV_NOTES, makeExitGuard, matchOrderLine, windowReached }
