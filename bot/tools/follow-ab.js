'use strict'
// Follow A/B stand (idkcraft-202): bare mineflayer-pathfinder vs our
// movement layer vs the full bot, on natural terrain with a fixed seed.
// Usage: node follow-ab.js <A|B|C> <run#>   (one child process per run)
// Env: AB_HOST (default 127.0.0.1), AB_PORT (default 25566),
//   AB_OUT (default ./ab-<variant>-<run>.json),
//   AB_REPLAY (path to follow-ab-course.json: replay the recorded guide
//   track instead of walking waypoints),
//   AB_GUIDE_TP=1 + AB_RCON=name:password (teleport the guide along the
//   recording each second — identical target motion every run/server).
// Server (same 26.1.2 as prod, normal gen, fixed seed, peaceful, frozen day):
//   docker run --rm -d --name idk-202 -e EULA=TRUE -e TYPE=PAPER \
//     -e ONLINE_MODE=FALSE -e ENABLE_WHITELIST=FALSE -e VERSION=26.1.2 \
//     -e DIFFICULTY=peaceful -e LEVEL_SEED=idkcraft202 \
//     -e ENABLE_RCON=true -e RCON_PASSWORD=... -p 25566:25565 itzg/minecraft-server
//   docker exec idk-202 rcon-cli "gamerule doDaylightCycle false"
//   docker exec idk-202 rcon-cli "time set day"
// Course (absolute, seed idkcraft202; scouted 2026-09-24): frozen lake -/-
// snow hills (y~90) -/- lake descent -/- spruce forest -/- grass -/- home.
// Code under test is imported, never copied: B applies the real
// setMovements tweaks, C runs the real ticker via runOnce.

const mineflayer = require('mineflayer')
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder')
const Vec3 = require('vec3')
const fs = require('node:fs')

const VARIANT = process.argv[2]
const RUN = process.argv[3] || '1'
if (!['A', 'B', 'C', 'S'].includes(VARIANT)) {
  console.error('usage: node follow-ab.js <A|B|C|S> <run#>')
  process.exit(2)
}
// Variants: A bare pathfinder, B + our Movements tweaks, C full bot,
// S bare + snow getBlock wrapper (Paper only).
const HOST = process.env.AB_HOST || '127.0.0.1'
const PORT = parseInt(process.env.AB_PORT || '25566', 10)
const OUT = process.env.AB_OUT || `./ab-${VARIANT}-${RUN}.json`
const TAG = process.env.AB_TAG || ''
const GUIDE = `AbGuide${TAG}`
const NAMES = { A: `AbA${TAG}`, B: `AbB${TAG}`, C: `AbC${TAG}`, S: `AbS${TAG}` }
// Absolute course for LEVEL_SEED=idkcraft202 (spawn -48,63,-16).
const COURSE = [
  [-48, -16], [-128, -96], [-208, -176], [-48, -176],
  [112, -96], [32, 64], [-128, 64], [-48, -16],
]
const WP_PAUSE_MS = 1000
const SAMPLE_MS = 500

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
function waitFor(emitter, event, timeoutMs, what) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${what}`)), timeoutMs)
    emitter.once(event, (...args) => { clearTimeout(timer); resolve(args) })
  })
}

async function main() {
  const guide = mineflayer.createBot({ host: HOST, port: PORT, username: GUIDE, auth: 'offline' })
  guide.loadPlugin(pathfinder)
  await waitFor(guide, 'spawn', 60000, 'guide spawn')
  await sleep(5000) // chunks in

  let follower = null
  let stopSampling = false
  const samples = []
  const resets = {}
  const onReset = (reason) => { resets[reason] = (resets[reason] || 0) + 1 }

  if (VARIANT === 'C') {
    const index = require('../src/index')
    const { stubBrain } = require('../src/brain')
    const recover = require('../src/behaviours/recover')
    let stuckCalls = 0
    const origSetStuck = recover.setStuck
    recover.setStuck = (...args) => { stuckCalls++; return origSetStuck(...args) }
    const mk = (opts) => {
      const b = mineflayer.createBot({ ...opts, username: NAMES.C })
      b.loadPlugin(pathfinder)
      follower = b
      follower.on('path_reset', onReset)
      return b
    }
    index.runOnce({
      host: HOST, port: PORT, username: NAMES.C, tickMs: 1000, idleTickMs: 1000,
      brain: stubBrain, leaveAfterMs: 0, followName: GUIDE, createBot: mk,
      pingFn: async () => ({ players: {} }),
    }).then(() => {}, () => {})
    if (!follower) throw new Error('C bot never created')
    // Spawn may fire before we listen: race the event against the entity.
    await Promise.race([
      waitFor(follower, 'spawn', 60000, 'C spawn'),
      (async () => { for (let i = 0; i < 240 && !follower.entity; i++) await sleep(250) })(),
    ])
    await sleep(3000)
    let getStuckFn = () => stuckCalls
    globalThis.__abStuck = getStuckFn
  } else {
    follower = mineflayer.createBot({ host: HOST, port: PORT, username: NAMES[VARIANT], auth: 'offline' })
    follower.loadPlugin(pathfinder)
    follower.on('path_reset', onReset)
    await waitFor(follower, 'spawn', 60000, 'follower spawn')
    await sleep(3000)
    const mov = new Movements(follower)
    if (VARIANT === 'B') {
      // The real setMovements tweaks (src/index.js), imported not copied.
      mov.allowSprinting = false
      require('../src/swim').addSwimExits(mov)
      require('../src/nocorner').addNoCornerCut(mov)
    }
    follower.pathfinder.setMovements(mov)
    if (VARIANT === 'S') {
      // Snow-patch probe (idkcraft-202): the planner reads snow layers as
      // non-physical air (boundingBox 'empty' in minecraft-data) and walks
      // through them; Paper rolls the penetration back. Mark snow ground.
      // Harness-only — src/ is untouched.
      const origGetBlock = mov.getBlock.bind(mov)
      mov.getBlock = (node, dx, dy, dz) => {
        const b = origGetBlock(node, dx, dy, dz)
        try { if (b && b.name === 'snow') b.physical = true } catch (_) {}
        return b
      }
    }
  }

  // Sampler: 2 Hz truth series from both bots in this process.
  const t0 = Date.now()
  const guideTrack = []
  let lastTrack = 0
  const sampler = setInterval(() => {
    if (stopSampling) return
    try {
      const gp = guide.entity && guide.entity.position
      const fp = follower.entity && follower.entity.position
      if (!gp || !fp) return
      const dist = Math.hypot(fp.x - gp.x, fp.y - gp.y, fp.z - gp.z)
      let moving = false
      try { moving = !!(follower.pathfinder && follower.pathfinder.isMoving()) } catch (_) {}
      samples.push({ t: Date.now() - t0, dist: +dist.toFixed(2), moving: moving ? 1 : 0 })
      if (Date.now() - lastTrack >= 1000) {
        lastTrack = Date.now()
        guideTrack.push([+gp.x.toFixed(1), +gp.y.toFixed(1), +gp.z.toFixed(1)])
      }
    } catch (_) { /* sampling best-effort */ }
  }, SAMPLE_MS)

  // Bare A/B follower: hold a dynamic GoalFollow on the guide, re-issued
  // only for a new target (like the ticker's lastGoalKey). Unseen guide =
  // stand: same blindness every variant has.
  let followKey = ''
  const followTick = setInterval(() => {
    if (stopSampling || VARIANT === 'C') return
    try {
      const gp = guide.entity && guide.entity.position
      const seen = follower.players && follower.players[GUIDE] && follower.players[GUIDE].entity
      if (!gp || !seen) return
      const key = `ab-follow:${Math.round(gp.x / 8)},${Math.round(gp.z / 8)}`
      if (key !== followKey) {
        followKey = key
        follower.pathfinder.setGoal(new goals.GoalFollow(seen, 3), true)
      }
    } catch (_) { /* follow best-effort */ }
  }, 1000)

  // Guide walks the frozen course once (~3-5 min over ~1000 blocks).
  // GoalXZ: the course crosses hills and lakes, a fixed y would misroute.
  // The guide is the owner stand-in: it walks (no sprint), so its own
  // layer never wedges — only the follower variants differ.
  const gmov = new Movements(guide)
  gmov.allowSprinting = false
  guide.pathfinder.setMovements(gmov)
  const replayFile = process.env.AB_REPLAY
  const tpGuide = process.env.AB_GUIDE_TP === '1'
  const rconSpec = process.env.AB_RCON || ''
  async function rconTp(name, x, y, z) {
    const i = rconSpec.indexOf(':')
    if (i < 0) throw new Error('AB_RCON=name:password required for AB_GUIDE_TP=1')
    const { execFile } = require('node:child_process')
    const { promisify } = require('node:util')
    await promisify(execFile)('docker', ['exec', rconSpec.slice(0, i), 'rcon-cli', `tp ${name} ${x.toFixed(1)} ${y.toFixed(1)} ${z.toFixed(1)}`])
  }
  async function guideTp(x, y, z) { await rconTp(GUIDE, x, y, z) }
  async function followerTp(x, y, z) { await rconTp(NAMES[VARIANT], x, y, z) }
  if (replayFile) {
    // Recorded route (follow-ab-course.json): identical guide motion for
    // every variant/run — the follower is the only variable. The guide
    // re-targets each recorded point at 1 Hz, so pushes self-correct.
    const rec = JSON.parse(fs.readFileSync(replayFile, 'utf8'))
    if (tpGuide) {
      // Teleport guide: byte-identical target motion every run/server —
      // the follower's terrain traversal stays genuine, pushes cannot
      // accumulate. RCON tp each second (docker + AB_RCON=name:password).
      // Both bots start at the course origin: world spawns differ per
      // server even on the same seed, so start positions are teleported.
      const [sx, sy, sz] = rec.track[0]
      try { await followerTp(sx, sy, sz) } catch (_) {}
      await sleep(2000)
      for (const [rx, ry, rz] of rec.track) {
        try { await guideTp(rx, ry, rz) } catch (_) {}
        await sleep(1000)
      }
    } else {
      for (const [rx, , rz] of rec.track) {
        try { guide.pathfinder.setGoal(new goals.GoalXZ(rx, rz), false) } catch (_) {}
        await sleep(1000)
      }
    }
    await sleep(WP_PAUSE_MS)
  } else {
    const legs = process.env.AB_MAXLEGS ? COURSE.slice(0, parseInt(process.env.AB_MAXLEGS, 10)) : COURSE
    for (const [wx, wz] of legs) {
      try { guide.pathfinder.setGoal(new goals.GoalXZ(wx, wz), false) } catch (_) {}
      const deadline = Date.now() + 45000
      for (;;) {
        await sleep(1000)
        const gp = guide.entity && guide.entity.position
        if (gp && Math.hypot(gp.x - wx, gp.z - wz) <= 3) break
        if (Date.now() > deadline) break // leg cap: keep runs bounded
        try {
          if (!guide.pathfinder.isMoving() && !(guide.pathfinder.goal)) {
            guide.pathfinder.setGoal(new goals.GoalXZ(wx, wz), false)
          }
        } catch (_) {}
      }
      await sleep(WP_PAUSE_MS)
    }
  }
  // Follower top-up: bare A/B stop at the last goal; C keeps following.
  await sleep(10000)
  stopSampling = true
  clearInterval(sampler)
  clearInterval(followTick)

  // Summary.
  let movingGrowing = 0
  let comparable = 0
  let maxDist = 0
  for (let i = 1; i < samples.length; i++) {
    const s = samples[i]
    if (s.dist > maxDist) maxDist = s.dist
    if (s.dist > samples[i - 1].dist + 0.05) {
      comparable++
      if (s.moving) movingGrowing++
    }
  }
  const doc = {
    meta: { variant: VARIANT, run: RUN, seed: 'idkcraft202', version: '26.1.2', samples: samples.length },
    summary: {
      maxDist: +maxDist.toFixed(1),
      growingTicks: comparable,
      movingWhileGrowing: movingGrowing,
      fracMovingWhileGrowing: comparable ? +(movingGrowing / comparable).toFixed(3) : null,
      pathResets: resets,
      stuckCalls: VARIANT === 'C' && globalThis.__abStuck ? globalThis.__abStuck() : 0,
    },
    guideTrack,
    samples,
  }
  fs.writeFileSync(OUT, JSON.stringify(doc))
  console.log(`wrote ${OUT}: n=${samples.length} maxDist=${maxDist.toFixed(1)} fracMoveGrow=${doc.summary.fracMovingWhileGrowing} resets=${JSON.stringify(resets)} stuck=${doc.summary.stuckCalls}`)
  try { guide.quit() } catch (_) {}
  if (VARIANT === 'C') process.exit(0) // runOnce owns quit/fatal; socket dies with us
  try { follower.quit() } catch (_) {}
  await sleep(1500)
  process.exit(0)
}

main().catch((err) => { console.error(`AB ${VARIANT} run ${RUN} failed: ${err && err.message ? err.message : err}`); process.exit(1) })
setTimeout(() => { console.error('AB harness timeout'); process.exit(1) }, 1200000)
