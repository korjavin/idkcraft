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
//   CASTLE_MINS (30), CASTLE_PAD ("300,300"), CASTLE_OUT (json path),
//   CASTLE_LOG (full log path; stdout keeps goal/need/blocked/death lines).
//   RIG_PLANNER (jev|stub, default jev), TYPESAFE_API_KEY (jev bearer).
// Exit: 0 = measured (even at 0 laid — the line says so),
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
  /^goal watchdog /, /^goal outcome /]
const origLog = console.log
const origErr = console.error
const seen = { flips: 0, steps: {}, fails: {}, progress: [], said: [], wdCalls: 0, wdChoices: {}, wdFirstAt: 0, outcomes: { progress: 0, flat: 0, preempted: 0 } }
function resetSeen() {
  seen.flips = 0
  seen.steps = {}
  seen.fails = {}
  seen.progress = []
  seen.said = []
  seen.wdCalls = 0
  seen.wdChoices = {}
  seen.wdFirstAt = 0
  seen.outcomes = { progress: 0, flat: 0, preempted: 0 }
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

function waitFor(em, ev, ms, what) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { em.removeListener(ev, on); reject(new Error(`${what} timeout`)) }, ms)
    function on(...a) { clearTimeout(t); resolve(a) }
    em.once(ev, on)
  })
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

  const guide = mineflayer.createBot({ host: HOST, port: PORT, username: GUIDE, auth: 'offline' })
  await waitFor(guide, 'spawn', 60000, 'guide spawn').catch((e) => fail('guide-spawn', e.message))
  await sleep(6000) // past Paper's same-IP connection throttle (stuck-replay precedent)

  let follower = null
  const chats = []
  const mk = (opts) => {
    const b = mineflayer.createBot({ ...opts, username: FOLLOWER })
    follower = b
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
    const cands = [[px, pz], [px - 50, pz], [px + 50, pz], [px, pz - 50], [px, pz + 50],
      [px - 50, pz - 50], [px + 50, pz - 50], [px - 50, pz + 50], [px + 50, pz + 50]]
    let best = null
    for (const [qx, qz] of cands) {
      const r = scanRelief(qx, qz)
      if (r && (!best || r.score < best.score)) best = { ...r, x: qx, z: qz }
    }
    if (best) { bx = best.x; bz = best.z; brel = best }
    origLog(`CASTLE-RIG padspot ${bx},${bz} span=${brel ? brel.span : '?'} liquid=${brel ? brel.liquid : '?'}${best ? '' : ' (preferred, unreadable)'}`)
  }
  await rcon(`tp ${GUIDE} ${bx} 150 ${bz}`).catch((e) => fail('pad-probe', e.message))
  await sleep(4000)
  let gy = null
  try { gy = Math.floor(guide.entity.position.y) } catch (_) { gy = null }
  if (gy == null || gy < 40 || gy > 140) fail('pad-probe', `no landing at ${bx},150,${bz} (y=${gy})`)
  const x0 = bx - 24; const x1 = bx + 24; const z0 = bz - 24; const z1 = bz + 24
  origLog(`CASTLE-RIG pad ${x0}..${x1} top ${gy} ${z0}..${z1}`)
  for (const cmd of [
    `fill ${x0} ${gy - 5} ${z0} ${x1} ${gy} ${z1} dirt`,
    `fill ${x0} ${gy + 1} ${z0} ${x1} ${gy + 7} ${z1} air`,
    `fill ${x0} ${gy + 8} ${z0} ${x1} ${gy + 14} ${z1} air`,
  ]) {
    await rcon(cmd).catch((e) => fail('pad-fill', e.message))
  }
  await rcon(`tp ${GUIDE} ${bx + 0.5} ${gy + 1} ${bz + 0.5}`).catch((e) => fail('pad-tp', e.message))
  await rcon(`tp ${FOLLOWER} ${bx + 2.5} ${gy + 1} ${bz + 0.5}`).catch((e) => fail('pad-tp', e.message))
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
  await sleep(3000) // chunks in, both landed
  if (tickCtx()) tickCtx().paused = false

  // The order needs the speaker's entity loaded on the follower, else the
  // bot answers "I can't see you" and nothing starts.
  let sees = false
  for (let i = 0; i < 40 && !sees; i++) {
    try { sees = !!(follower.players && follower.players[GUIDE] && follower.players[GUIDE].entity) } catch (_) { sees = false }
    if (!sees) await sleep(500)
  }
  if (!sees) fail('order', `follower never saw ${GUIDE}`)
  try { guide.chat('autonomous on') } catch (e) { fail('order', `autonomous chat: ${e.message}`) }
  await sleep(1000)
  try { guide.chat('build castle') } catch (e) { fail('order', `castle chat: ${e.message}`) }
  // Order ack: the direct site ('castle at …, ~1722 blocks') or the search
  // ('found a castle spot …', which carries the same startCastle tail).
  // The asker leaving cancels the search, so the guide stays till the ack.
  const tOrder = Date.now()
  let ordered = null
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
  if (BLOCKED > 0) {
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
  let farAt = 0
  let farPre = null
  let buryAt = 0
  let buryPre = null
  let surfacedS = null
  let resumedS = null
  while (Date.now() < endAt) {
    await sleep(15000)
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
    const s = sample()
    if (buryAt) {
      const since = Math.round((Date.now() - buryAt) / 1000)
      if (surfacedS == null && typeof s.y === 'number' && s.y >= gy - 2) surfacedS = since
      if (surfacedS != null && resumedS == null && typeof s.done === 'number' && s.done > buryPre) resumedS = since // laid after surfacing
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
  const line = `castle ${done}/${total} in ${MINS} min, flips=${seen.flips}, deaths=${deaths}, top-steps=${top(seen.steps, 4)}, top-fail=${top(seen.fails, 3)}, watchdog=${seen.wdCalls}, first=${first}, choices=${top(seen.wdChoices, 3)}, outcomes=progress:${seen.outcomes.progress},flat:${seen.outcomes.flat},preempted:${seen.outcomes.preempted}${farTag}${buryTag}`
  const record = {
    date: new Date().toISOString(), mins: MINS, done, total, flips: seen.flips, deaths,
    steps: seen.steps, fails: seen.fails, pad: { x0, x1, z0, z1, top: gy, cx: bx, cz: bz, span: brel ? brel.span : null },
    tag: TAG, gitsha: process.env.CASTLE_GITSHA || '?', log: LOGFILE,
    kit: KIT, tickrate: TICKRATE, planner: PLANNER, blocked: blockedSeeds, said: seen.said,
    wdCalls: seen.wdCalls, wdFirstS: first, wdChoices: seen.wdChoices, outcomes: seen.outcomes,
    series,
  }
  try { fs.writeFileSync(OUT, JSON.stringify(record, null, 1)) } catch (e) {
    origLog(`CASTLE-RIG out write failed: ${e.message}`)
  }
  origLog(line)
  try { logStream.end() } catch (_) { /* close best-effort */ }
  process.exit(0)
}

if (require.main === module) {
  main().catch((e) => {
    origLog(`CASTLE-RIG FATAL: ${e && e.message ? e.message : e}`);
    try { logStream.end() } catch (_) { /* close best-effort */ }
    process.exit(2)
  })
}
module.exports = { classify, seen, resetSeen, pickBlockedSeeds }
