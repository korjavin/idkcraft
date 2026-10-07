'use strict'

// CASTLE-RIG (idkcraft-vmzq.20): unattended-build throughput harness. Run via
// castle-rig.sh (boots a disposable Paper, flattens nothing itself — the pad
// is built here). Flow: guide + follower join, a dirt pad is flattened at
// CASTLE_PAD, the follower's kit is emptied, the guide chats `autonomous on`
// + `build castle` through the real chat path, the guide quits (prod-alone
// parity: nobody online, autonomous on), the bot works CASTLE_MINS, and the
// run prints ONE verdict line plus a JSON record (CASTLE_OUT).
//
// The bot runs the REAL stack (index.runOnce, stub brain — deterministic, no
// paid LLM) on real Paper physics: gather/craft/equip/fetch/build all run.
// Day is locked by the wrapper (gamerule), so the window measures work, not
// shelter. No baseline judging: this is a measurement loop instrument, the
// verdict line is the product.
//
// Env: CASTLE_HOST (127.0.0.1), CASTLE_PORT (25581),
//   CASTLE_CONTAINER (idk-castle), CASTLE_TAG (c + pid digits),
//   CASTLE_MINS (30), CASTLE_PAD ("300,300"), CASTLE_OUT (json path),
//   CASTLE_LOG (full log path; stdout keeps goal/need/blocked/death lines).
// Exit: 0 = measured (even at 0 laid — the line says so),
//   2 = environment/setup failure (spawn, pad, order, dropped follower).

const mineflayer = require('mineflayer')
const fs = require('node:fs')
const { execFile } = require('node:child_process')
const { promisify } = require('node:util')

const execFileAsync = promisify(execFile)

const HOST = process.env.CASTLE_HOST || '127.0.0.1'
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

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)) }

// Full log to a file; stdout keeps the cycle-readable lines (goal steps,
// fetch needs, blocked cells, progress, deaths, verdict). Ticker chatter
// (decision/scout/kit/eat) would bury the verdict on a 30+ min run.
const logStream = fs.createWriteStream(LOGFILE, { flags: 'w' })
const PRINT = [/^goal step=/, /^castlefetch \S+: need /, /^castle blocked /,
  /^castle \d+\/\d+$/, /death/, /^castle-sample /, /^castle \d+\/\d+ in /,
  /^CASTLE-RIG /, /^task castle /, /no progress for/]
const origLog = console.log
const origErr = console.error
const seen = { flips: 0, steps: {}, fails: {}, progress: [] }
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
// reasons. Parsed from the bot's own log lines (in-process, loss-free).
function classify(line) {
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
  const brain = require('../src/brain').stubBrain

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
    brain, leaveAfterMs: 0, followName: '', autonomous: true, createBot: mk,
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

  // Pad probe: drop the guide, read the landing, flatten around it. Pad top
  // = landing (dirt box below, air above in <=17k-block fills — the fill cap
  // is 32768). 48x48 holds the 31x27 site plus the search centre.
  await rcon(`tp ${GUIDE} ${px} 150 ${pz}`).catch((e) => fail('pad-probe', e.message))
  await sleep(4000)
  let gy = null
  try { gy = Math.floor(guide.entity.position.y) } catch (_) { gy = null }
  if (gy == null || gy < 40 || gy > 140) fail('pad-probe', `no landing at ${px},150,${pz} (y=${gy})`)
  const x0 = px - 24; const x1 = px + 24; const z0 = pz - 24; const z1 = pz + 24
  origLog(`CASTLE-RIG pad ${x0}..${x1} top ${gy} ${z0}..${z1}`)
  for (const cmd of [
    `fill ${x0} ${gy - 5} ${z0} ${x1} ${gy} ${z1} dirt`,
    `fill ${x0} ${gy + 1} ${z0} ${x1} ${gy + 7} ${z1} air`,
    `fill ${x0} ${gy + 8} ${z0} ${x1} ${gy + 14} ${z1} air`,
  ]) {
    await rcon(cmd).catch((e) => fail('pad-fill', e.message))
  }
  await rcon(`tp ${GUIDE} ${px + 0.5} ${gy + 1} ${pz + 0.5}`).catch((e) => fail('pad-tp', e.message))
  await rcon(`tp ${FOLLOWER} ${px + 2.5} ${gy + 1} ${pz + 0.5}`).catch((e) => fail('pad-tp', e.message))
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
      let cobble = 0; let dirt = 0; let logs = 0
      for (const it of (follower.inventory && follower.inventory.items()) || []) {
        if (!it || typeof it.name !== 'string') continue
        const n = typeof it.count === 'number' ? it.count : 1
        if (it.name === 'cobblestone') cobble += n
        else if (it.name === 'dirt') dirt += n
        else if (/_log$/.test(it.name)) logs += n
      }
      s.cobble = cobble; s.dirt = dirt; s.logs = logs
    } catch (_) { /* inventory best-effort */ }
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
        kit: KIT, tickrate: TICKRATE, series,
      }))
    } catch (_) { /* checkpoint best-effort */ }
  }
  sample()
  checkpoint()
  origLog(`CASTLE-RIG window: ${MINS} min, ends ${new Date(endAt).toISOString()}`)
  while (Date.now() < endAt) {
    await sleep(15000)
    const s = sample()
    checkpoint()
    const line = `castle-sample t=${Math.round(s.t / 60)}min ${s.done ?? '?'}/${s.total ?? '?'} step=${s.step} flips=${seen.flips} deaths=${deaths}`
    try { logStream.write(line + '\n') } catch (_) { /* log best-effort */ }
    if (Date.now() - lastSampleLine > 300000) {
      lastSampleLine = Date.now()
      origLog(line)
    }
  }
  const last = series[series.length - 1] || {}
  const done = typeof last.done === 'number' ? last.done : 0
  const total = typeof last.total === 'number' ? last.total : 0
  const top = (obj, n) => Object.entries(obj).sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => `${k}:${v}`).join(',') || 'none'
  const line = `castle ${done}/${total} in ${MINS} min, flips=${seen.flips}, deaths=${deaths}, top-steps=${top(seen.steps, 4)}, top-fail=${top(seen.fails, 3)}`
  const record = {
    date: new Date().toISOString(), mins: MINS, done, total, flips: seen.flips, deaths,
    steps: seen.steps, fails: seen.fails, pad: { x0, x1, z0, z1, top: gy },
    tag: TAG, gitsha: process.env.CASTLE_GITSHA || '?', log: LOGFILE,
    kit: KIT, tickrate: TICKRATE, series,
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
module.exports = { classify, seen }
