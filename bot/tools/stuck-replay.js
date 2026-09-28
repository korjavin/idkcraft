'use strict'
// STUCK REGRESSION RUN (idkcraft-4rz): replay known prod stuck spots on the
// prod-world snapshot with the REAL bot stack (runOnce + stubBrain following
// a guide parked on the logged goal) and print a per-spot table:
//   spot | reached? | stuck resets | recover episodes | call_player? | time
// Spots are data: the 4 rig spots are embedded, or pass a JSON file:
//   [{"name":"EP1","spawn":[-61.3,66,-210.5],"goal":[-72,65,-218],"secs":75}]
// (muse-5's extended list drops in as a file, no code change).
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

// Rig spots (START.sh): spawn = where the bot was, goal = the walk goal it
// held when the stuck episode was logged.
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
  if (cmd.startsWith('tp ') && !String(stdout).includes('Teleported')) {
    throw new Error(`rcon tp failed: ${String(stdout).trim().slice(0, 160)}`)
  }
  return String(stdout)
}

function loadSpots() {
  const file = process.argv[2] || process.env.REPLAY_SPOTS || null
  const list = file ? JSON.parse(fs.readFileSync(file, 'utf8')) : DEFAULT_SPOTS
  if (!Array.isArray(list) || list.length === 0) throw new Error('spots: non-empty array expected')
  return list.map((s, i) => {
    if (!s || typeof s.name !== 'string' || !Array.isArray(s.spawn) || s.spawn.length !== 3 || !Array.isArray(s.goal) || s.goal.length !== 3) {
      throw new Error(`spots[${i}]: need {name, spawn:[x,y,z], goal:[x,y,z]}`)
    }
    const secs = s.secs == null ? DEFAULT_SECS : Number(s.secs)
    if (!Number.isFinite(secs) || secs <= 0) throw new Error(`spots[${i}]: bad secs`)
    return { name: s.name, spawn: s.spawn, goal: s.goal, secs }
  })
}

function waitFor(em, ev, ms, what) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { em.removeListener(ev, on); reject(new Error(`${what} timeout`)) }, ms)
    function on(...a) { clearTimeout(t); resolve(a) }
    em.once(ev, on)
  })
}

(async () => {
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
  recover.setStuck = (...args) => { stuckEps.push(args[1]); return origSetStuck(...args) }

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

  console.log(`stuck-replay tag=${TAG} variant=${process.env.REPLAY_VARIANT || '?'} ` +
    `worldsha=${(process.env.REPLAY_WORLDSHA || '?').slice(0, 12)} gitsha=${process.env.REPLAY_GITSHA || '?'} ` +
    `date=${new Date().toISOString()} spots=${spots.length}`)
  console.log('spot      reached  stuck  eps  call?  secs   maxDisp  note')
  const rows = []
  for (const s of spots) {
    await rcon(`tp ${GUIDE} ${s.goal[0]} ${s.goal[1]} ${s.goal[2]}`)
    await rcon(`tp ${FOLLOWER} ${s.spawn[0]} ${s.spawn[1]} ${s.spawn[2]}`)
    await sleep(2000)
    // Quiesce: a recover episode in flight would bleed into this window.
    for (let i = 0; i < 40; i++) {
      const rec = follower._tickerCtx && follower._tickerCtx.recovery
      if (!rec || rec.status !== 'running') break
      await sleep(250)
    }
    stuckEps = []
    resets = {}
    chats = []
    died = false
    const t0 = Date.now()
    const p0 = follower.entity.position.clone()
    let minDist = Infinity
    let maxDisp = 0
    let reached = false
    const gx = s.goal[0]; const gy = s.goal[1]; const gz = s.goal[2]
    while (Date.now() - t0 < s.secs * 1000 && !died) {
      await sleep(500)
      try {
        const p = follower.entity.position
        const d = Math.hypot(p.x - gx, p.y - gy, p.z - gz)
        if (d < minDist) minDist = d
        const disp = p.distanceTo(p0)
        if (disp > maxDisp) maxDisp = disp
        if (d < REACH_DIST) { reached = true; break }
      } catch (_) { /* sampling best-effort */ }
    }
    const secs = (Date.now() - t0) / 1000
    const stuck = resets.stuck || 0
    const call = chats.filter((m) => m.includes("I'm stuck at")).length
    const note = died ? 'DIED' : ''
    rows.push({ spot: s.name, reached, stuck, eps: stuckEps.length, by: stuckEps, call, secs: +secs.toFixed(0), maxDisp: +maxDisp.toFixed(1), minDist: +minDist.toFixed(1), note })
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
})().catch((e) => { console.error('REPLAY-ERROR', e && e.message ? e.message : e); process.exit(2) })
