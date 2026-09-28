'use strict'
// STUCK REGRESSION RUN (idkcraft-4rz): replay known prod stuck spots on the
// prod-world snapshot with the REAL bot stack (runOnce + stubBrain following
// a guide parked on the logged goal) and print a per-spot table:
//   spot | reached? | stuck resets | recover episodes | call_player? | time
// Spots are data (default: stuck-spots.json next to this file, 9 rig
// spots with per-spot kit; argv[2]/REPLAY_SPOTS overrides with another file):
//   [{"name":"EP1","spawn":[-61.3,66,-210.5],"goal":[-72,65,-218],
//     "secs":75,"scaffold":0,"pickaxe":true}]
// secs/scaffold/pickaxe are optional (defaults 75 / 64 dirt / stone pickaxe).
// bucket:true adds 2 water buckets (jsf.2 water_up needs a pair: high pour +
// ledge pour, both back after the strip). REPLAY_OP=1 pre-ops both bots
// before login (deterministic offline UUIDs, like water-assay.js ASSAY_OP):
// spots inside spawn protection (CLUSTER, r=16) refuse un-opped pours, so
// water_up spots run opped — mirroring a prod bot with op.
// The 4 header rig spots stay embedded as a no-file fallback.
// Usage: node stuck-replay.js [spots.json] [secs]
// Env: REPLAY_SPOTS (spots file; argv[2] wins), REPLAY_SECS (argv[3] wins),
//   REPLAY_QUIET=0 (keep per-tick ticker chatter; default filters it so the
//   table stays readable — recover/stuck lines always print),
//   REPLAY_HOST (127.0.0.1), REPLAY_PORT (25571),
//   REPLAY_CONTAINER (idk-replay, docker exec rcon-cli for tp),
//   REPLAY_TAG (bot name suffix; default random), REPLAY_OUT (optional JSON
//   results path), REPLAY_VARIANT/REPLAY_WORLDSHA/REPLAY_GITSHA (run header,
//   set by stuck-run.sh). The rig server must already be up.
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
    return { name: s.name, spawn: s.spawn, goal: s.goal, secs, scaffold, pickaxe, bucket }
  })
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
  const index = require('../src/index')
  const { stubBrain } = require('../src/brain')
  const recover = require('../src/behaviours/recover')

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
    brain: stubBrain, leaveAfterMs: 0, followName: GUIDE, createBot: mk,
    pingFn: async () => ({ players: {} }),
  }).then(() => {}, (e) => { console.error('REPLAY-ERROR runOnce rejected:', e && e.message ? e.message : e); process.exit(2) })
  if (!follower) throw new Error('follower never created')
  await Promise.race([
    waitFor(follower, 'spawn', 60000, 'follower spawn'),
    (async () => { for (let i = 0; i < 240 && !follower.entity; i++) await sleep(250) })(),
  ])
  await sleep(3000)
  // Park the body for setups: without this the ticker walks during the
  // multi-second tp/kit/settle phase and rows measure pre-window walking
  // (baseline-1 EP0 reached in 1 s with maxDisp 0.0). ctx.paused is the
  // bot's own 'stop' park (brain skipped, idle dispatched); each window
  // unparks after its boundary reset.
  const tickCtx = () => follower._tickerCtx
  if (tickCtx()) tickCtx().paused = true

  console.log(`stuck-replay tag=${TAG} variant=${process.env.REPLAY_VARIANT || '?'} ` +
    `worldsha=${(process.env.REPLAY_WORLDSHA || '?').slice(0, 12)} gitsha=${process.env.REPLAY_GITSHA || '?'} ` +
    `date=${new Date().toISOString()} spots=${spots.length}`)
  console.log('spot      reached  stuck  eps  call?  secs   maxDisp  note')
  const rows = []
  let guideDied = false
  guide.on('death', () => { guideDied = true })
  for (const s of spots) {
    guideDied = false
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
    let dx = s.goal[0] - s.spawn[0]; let dz = s.goal[2] - s.spawn[2]
    let len = Math.hypot(dx, dz)
    if (!(len > 0.01)) { dx = 1; dz = 0; len = 1 }
    const L = Math.max(14, Math.hypot(s.goal[0] - s.spawn[0], s.goal[1] - s.spawn[1], s.goal[2] - s.spawn[2]) + 6)
    const gx = s.spawn[0] + (dx / len) * L; const gz = s.spawn[2] + (dz / len) * L
    let gy = Math.max(s.spawn[1], s.goal[1]) + 1
    await rcon(`tp ${GUIDE} ${gx.toFixed(1)} ${gy} ${gz.toFixed(1)}`)
    await rcon(`tp ${FOLLOWER} ${s.spawn[0]} ${s.spawn[1]} ${s.spawn[2]}`)
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
      rows.push({ spot: s.name, reached: false, stuck: 0, eps: 0, by: [], call: 0, secs: 0, maxDisp: 0, minDist: -1, minGuide: -1, note: 'GUIDE-BURIED' })
      console.log(`${s.name.padEnd(9)} ${String(false).padEnd(7)} ${String(0).padEnd(6)} ` +
        `${String(0).padEnd(4)} ${String(false).padEnd(6)} ${String(0).padEnd(6)} ${(0).toFixed(1).padEnd(8)} GUIDE-BURIED`)
      continue
    }
    if (guideDied || !guide.entity) {
      rows.push({ spot: s.name, reached: false, stuck: 0, eps: 0, by: [], call: 0, secs: 0, maxDisp: 0, minDist: -1, minGuide: -1, note: 'GUIDE-DIED' })
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
    }
    stuckEps = []
    resets = {}
    chats = []
    died = false
    if (c) c.paused = false
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
    const tx = s.goal[0]; const ty = s.goal[1]; const tz = s.goal[2]
    const useGoal = Math.hypot(tx - s.spawn[0], ty - s.spawn[1], tz - s.spawn[2]) >= 4
    while (Date.now() - t0 < s.secs * 1000 && !died && !guideDied) {
      await sleep(500)
      try {
        const p = follower.entity.position
        const d = Math.hypot(p.x - tx, p.y - ty, p.z - tz)
        if (d < minDist) minDist = d
        const gd = Math.hypot(p.x - gl.x, p.y - gl.y, p.z - gl.z)
        if (gd < minGuide) minGuide = gd
        const disp = p.distanceTo(p0)
        if (disp > maxDisp) maxDisp = disp
        // Reached ends the window: post-goal walking is outside the spot.
        if ((useGoal && d < REACH_DIST) || gd <= 6) { reached = true; break }
      } catch (_) { /* sampling best-effort */ }
    }
    const secs = (Date.now() - t0) / 1000
    const stuck = resets.stuck || 0
    const call = chats.filter((m) => m.includes("I'm stuck at")).length
    const note = died ? 'DIED' : (guideDied ? 'GUIDE-DIED' : '')
    rows.push({ spot: s.name, reached, stuck, eps: stuckEps.length, by: stuckEps, call, secs: +secs.toFixed(0), maxDisp: +maxDisp.toFixed(1), minDist: +minDist.toFixed(1), minGuide: +minGuide.toFixed(1), note })
    console.log(`${s.name.padEnd(9)} ${String(reached).padEnd(7)} ${String(stuck).padEnd(6)} ` +
      `${String(stuckEps.length).padEnd(4)} ${String(call > 0).padEnd(6)} ${String(secs.toFixed(0)).padEnd(6)} ${maxDisp.toFixed(1).padEnd(8)} ${note}`)
  }
  if (process.env.REPLAY_OUT) {
    fs.writeFileSync(process.env.REPLAY_OUT, JSON.stringify(rows, null, 1) + '\n')
  }
  // Quit the guide only: quitting the follower trips runOnce's fatal end
  // path (exit 1 races our exit 0). The follower socket dies with us.
  try { guide.quit() } catch (_) {}
  await sleep(1000)
  process.exit(0)
}

if (require.main === module) {
  main().catch((e) => { console.error('REPLAY-ERROR', e && e.message ? e.message : e); process.exit(2) })
}

module.exports = { verifyHeadroom }
