'use strict'

// WORK-RIG (idkcraft-6x7.16): offline work-cycle harness, run via
// work-rig.sh (boots a disposable Paper, normal difficulty, the clock runs).
// Flow: the guide joins at world spawn, a flat dirt pad is levelled under
// it, a plan-driven v2 house is raised on the pad (raise-house.js) with both
// bedroom beds set in place (+ a home chest for WORK_KIT=chest|seeded), the
// follower joins (adopting the house from the world, like a prod restart),
// the guide chats `autonomous on` + `go work` and quits (prod-alone parity,
// castle-replay precedent), the bot works WORK_MINS, and the run prints ONE
// verdict line plus a JSON record (WORK_OUT):
//   work nights=<n> slept=<n> inside=<n> dugin=<n> deaths=<n> banked=<items>/h brought=<n> steps=<top-4> fail=<top-3>
// Counters come from the bot's own log/chat lines only (verdict(), pure):
//   nights  — server dusks (castle-replay time resync, server truth; a bed
//             at dusk skips the night before nightfall ever crosses)
//   slept   — 'sleeping in my bed' chats
//   inside  — 'home for the night' chats (inside the shut house at night)
//   dugin   — 'shelter dig-in done' (dug in instead of going home)
//   deaths  — 'death health=' lines
//   banked  — items in 'forage done: banked …' (+ the pack-full yield's
//             'forage failed:pack-full (banked …)') lines, per hour of window
//   brought — 'brought …' / 'stockpiled …' chats (handed over or banked)
//   steps   — top goal steps by 'goal step=' count
//   fail    — top failed steps (prev of why=step-failed; :<reason> when the
//             line carries fail=<reason>, ipn.15)
// Env: WORK_HOST (localhost), WORK_PORT (25611), WORK_CONTAINER (idk-work),
//   WORK_TAG (w + pid digits), WORK_MINS (20), WORK_KIT (empty|chest|seeded),
//   WORK_TICKRATE (60), WORK_OUT (json), WORK_LOG (full log),
//   RIG_PLANNER (jev|stub, default jev), TYPESAFE_API_KEY (jev bearer).
// Exit: 0 = measured, 2 = environment/setup failure.

const fs = require('node:fs')
const { execFile } = require('node:child_process')
const { promisify } = require('node:util')

const execFileAsync = promisify(execFile)

const HOST = process.env.WORK_HOST || 'localhost'
const PORT = parseInt(process.env.WORK_PORT || '25611', 10)
const CONTAINER = process.env.WORK_CONTAINER || 'idk-work'
const TAG = process.env.WORK_TAG || `w${Math.floor(Math.random() * 1000)}`
const GUIDE = `WorkGuide${TAG}`
const FOLLOWER = `WorkBot${TAG}`
const MINS = Math.max(1, parseInt(process.env.WORK_MINS || '20', 10) || 20)
const KIT = process.env.WORK_KIT || 'empty'
const TICKRATE = process.env.WORK_TICKRATE || '60'
const OUT = process.env.WORK_OUT || `/tmp/work-rig-${TAG}.json`
const LOGFILE = process.env.WORK_LOG || `/tmp/work-rig-${TAG}.log`
const PLANNER = process.env.RIG_PLANNER || 'jev'

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)) }

// Verdict over the kept lines (pure, unit-tested without docker).
function verdict(lines, mins) {
  const c = { nights: 0, slept: 0, inside: 0, dugin: 0, deaths: 0, banked: 0, brought: 0 }
  const steps = {}
  const fails = {}
  const bump = (o, k) => { o[k] = (o[k] || 0) + 1 }
  for (const line of lines) {
    let m
    if (/^WORK-RIG time: dusk\b/.test(line)) c.nights++
    else if (/^say: sleeping in my bed\b/.test(line)) c.slept++
    else if (/^say: home for the night\b/.test(line)) c.inside++
    else if (/^say: (brought|stockpiled) /.test(line)) c.brought++
    else if (/^shelter dig-in done\b/.test(line)) c.dugin++
    else if (/^death health=/.test(line)) c.deaths++
    else if ((m = /^forage done: banked (.*)$/.exec(line) || /^forage failed:pack-full \(banked (.*)\)$/.exec(line))) {
      // '(reason)' tail stripped: its words must never read as items.
      for (const n of m[1].replace(/\s*\(.*\)\s*$/, '').matchAll(/(\d+) [a-z_]+/g)) c.banked += Number(n[1])
    } else if ((m = /^goal step=(\S+) prev=(\S+)/.exec(line))) {
      bump(steps, m[1])
      if (/ why=step-failed\b/.test(line)) {
        const f = / fail=(\S+)/.exec(line)
        bump(fails, f ? `${m[2]}:${f[1]}` : m[2])
      }
    }
  }
  const top = (o, n) => Object.entries(o).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, n).map(([k, v]) => `${k}:${v}`).join(',') || 'none'
  const perH = Math.round(c.banked * 60 / Math.max(1, mins))
  const line = `work nights=${c.nights} slept=${c.slept} inside=${c.inside} dugin=${c.dugin} deaths=${c.deaths} banked=${perH}/h brought=${c.brought} steps=${top(steps, 4)} fail=${top(fails, 3)}`
  return { line, ...c, bankedPerH: perH, steps, fails }
}

// Lines the verdict reads; the rest only reach the full log.
const KEEP = /^(WORK-RIG time: |say: |shelter dig-in |death health=|forage (done|failed):|goal step=)/
// Stdout: the cycle-readable subset (the full log stays in WORK_LOG).
const PRINT = /^(WORK-RIG |say: |shelter dig-in |death health=|forage done: |goal step=|goal watchdog |task )/

let logStream = null
const kept = []
const origLog = console.log
const origErr = console.error
function record(line, isErr) {
  try { if (logStream) logStream.write((isErr ? 'ERR ' : '') + line + '\n') } catch (_) { /* log best-effort */ }
  if (KEEP.test(line)) kept.push(line)
  if (isErr) origErr(line)
  else if (PRINT.test(line)) origLog(line)
}
function hookConsole() {
  logStream = fs.createWriteStream(LOGFILE, { flags: 'w' })
  console.log = (...a) => record(a.map(String).join(' '), false)
  console.error = (...a) => record(a.map(String).join(' '), true)
}

function fail(kind, detail) {
  origLog(`WORK-RIG SETUP-FAIL ${kind}: ${detail} (full log ${LOGFILE})`)
  try { if (logStream) logStream.end() } catch (_) { /* close best-effort */ }
  process.exit(2)
}

async function rcon(cmd) {
  const { stdout } = await execFileAsync('docker', ['exec', CONTAINER, 'rcon-cli', cmd])
  const out = String(stdout)
  if ((cmd.startsWith('tp ') && !out.includes('Teleported')) ||
      (cmd.startsWith('op ') && !out.toLowerCase().includes('operator')) ||
      ((cmd.startsWith('clear ') || cmd.startsWith('give ')) && /No entity was found|Unknown|incorrect/i.test(out)) ||
      ((cmd.startsWith('fill ') || cmd.startsWith('setblock ')) && !/Successfully filled|No blocks were filled|Changed the block/.test(out))) {
    throw new Error(`rcon failed [${cmd}]: ${out.trim().slice(0, 160)}`)
  }
  return out
}

function waitFor(em, ev, ms, what) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { em.removeListener(ev, on); reject(new Error(`${what} timeout`)) }, ms)
    function on(...a) { clearTimeout(t); resolve(a) }
    em.once(ev, on)
  })
}

// Pad + house + beds (+ chest) around the guide's landing (gx, gy, gz): a
// 21x21 dirt pad 4 deep (caps the spawn cave), air 10 up, the v2 house with
// its door 3 south of the landing (doorstep on the pad). Pure, unit-tested.
function siteCommands(gx, gy, gz, kit) {
  const { houseCommands } = require('./raise-house')
  const site = { x: gx - 3, y: gy, z: gz + 3 }
  const cmds = [
    `fill ${gx - 10} ${gy - 4} ${gz - 8} ${gx + 10} ${gy - 1} ${gz + 12} dirt`,
    `fill ${gx - 10} ${gy} ${gz - 8} ${gx + 10} ${gy + 9} ${gz + 12} air`,
    ...houseCommands(site),
  ]
  // Beds at the canonical bedroom cells (beds.cellsOf): foot west, head east.
  const cells = require('../src/behaviours/beds').cellsOf({ site, v: 2 })
  const beds = []
  for (const k of ['a', 'b']) {
    const { foot, head } = cells[k]
    cmds.push(`setblock ${head.x} ${head.y} ${head.z} white_bed[facing=east,part=head]`)
    cmds.push(`setblock ${foot.x} ${foot.y} ${foot.z} white_bed[facing=east,part=foot]`)
    beds.push(foot, head)
  }
  let chest = null
  if (kit === 'chest' || kit === 'seeded') {
    const s = require('../src/behaviours/stockpile').CHEST_SPOTS_V2[0]
    chest = { x: site.x + s.dx, y: site.y + s.dy, z: site.z + s.dz }
    cmds.push(`setblock ${chest.x} ${chest.y} ${chest.z} chest`)
  }
  return { site, cmds, beds, chest }
}

async function main() {
  if (GUIDE.length > 16 || FOLLOWER.length > 16) {
    throw new Error(`bot names exceed 16 chars (TAG=${JSON.stringify(TAG)}); set a shorter WORK_TAG`)
  }
  hookConsole()
  const mineflayer = require('mineflayer')
  const Vec3 = require('vec3')
  // castle-replay opens its log stream at require time: point it at the
  // null device so the shared time resync costs no stray /tmp file.
  process.env.CASTLE_LOG = require('node:os').devNull
  const { createTimeResync } = require('./castle-replay')
  const index = require('../src/index')
  const brainMod = require('../src/brain')
  let brain = brainMod.stubBrain
  let brainEngine = ''
  if (PLANNER === 'jev') {
    const key = process.env.TYPESAFE_API_KEY
    if (!key) fail('planner-key', 'RIG_PLANNER=jev needs TYPESAFE_API_KEY (stash secrets/jev-api-key)')
    brain = brainMod.hybridBrain(brainMod.jevBrain(key, undefined, brainMod.brainTimeoutMs(process.env), brainMod.JEV_ENDPOINT))
    brainEngine = 'jev'
  } else if (PLANNER !== 'stub') {
    fail('planner', `RIG_PLANNER: want jev|stub, got ${JSON.stringify(PLANNER)}`)
  }
  origLog(`WORK-RIG planner=${PLANNER} kit=${KIT} tickrate=${TICKRATE} mins=${MINS}`)

  // Server dusk/nightfall/dawn (vmzq.45 resync): corrects bot.time above
  // rate 1, tracks only at 1. Nightfalls are the verdict's nights=.
  const RESYNC_WRITE = (parseInt(TICKRATE, 10) || 1) > 1
  const timeT0 = Date.now()
  const timeResync = createTimeResync({
    write: RESYNC_WRITE,
    onEvent: (ev) => console.log(`WORK-RIG time: ${ev.event} server=${ev.server} bot=${ev.bot} +${Math.round((ev.at - timeT0) / 1000)}s`),
  })

  const guide = mineflayer.createBot({ host: HOST, port: PORT, username: GUIDE, auth: 'offline' })
  await waitFor(guide, 'spawn', 60000, 'guide spawn').catch((e) => fail('guide-spawn', e.message))
  await sleep(4000) // landed + spawn chunks in
  let gx = null; let gy = null; let gz = null
  try { const p = guide.entity.position; gx = Math.floor(p.x); gy = Math.floor(p.y); gz = Math.floor(p.z) } catch (_) { gy = null }
  if (gy == null || gy < 40 || gy > 140) fail('pad', `no guide landing (y=${gy})`)
  const { site, cmds, beds, chest } = siteCommands(gx, gy, gz, KIT)
  for (const c of cmds) await rcon(c).catch((e) => fail('house', e.message))
  await rcon(`tp ${GUIDE} ${gx + 0.5} ${gy} ${gz + 0.5}`).catch((e) => fail('pad-tp', e.message))
  await sleep(2000)
  for (const b of beds) {
    let name = null
    try { const blk = guide.blockAt(new Vec3(b.x, b.y, b.z)); name = blk && blk.name } catch (_) { name = null }
    if (name !== 'white_bed') fail('beds', `readback ${b.x} ${b.y} ${b.z}: want white_bed, got ${name}`)
  }
  origLog(`WORK-RIG house v2 at ${site.x} ${site.y} ${site.z}, beds A+B${chest ? `, chest ${chest.x} ${chest.y} ${chest.z}` : ''}`)
  await sleep(6000) // past Paper's same-IP connection throttle (stuck-replay precedent)

  let follower = null
  const mk = (opts) => {
    const b = mineflayer.createBot({ ...opts, username: FOLLOWER })
    follower = b
    b._client.on('update_time', (packet) => timeResync.onPacket(b, packet))
    b.on('time', () => timeResync.apply(b))
    b.on('physicsTick', () => timeResync.onTick(b))
    b.once('spawn', () => {
      const origChat = b.chat.bind(b)
      b.chat = (msg) => { console.log(`say: ${String(msg)}`); return origChat(msg) }
    })
    return b
  }
  index.runOnce({
    host: HOST, port: PORT, username: FOLLOWER, tickMs: 1000, idleTickMs: 1000,
    brain, brainEngine, leaveAfterMs: 0, followName: '', autonomous: true, createBot: mk,
    pingFn: async () => ({ players: {} }),
  }).then(() => {}, (e) => { origLog(`WORK-RIG follower runOnce rejected: ${e && e.message ? e.message : e}`); process.exit(2) })
  if (!follower) throw new Error('follower never created')
  await waitFor(follower, 'spawn', 60000, 'follower spawn').catch((e) => fail('follower-spawn', e.message))
  follower.on('end', () => fail('follower-dropped', 'connection ended mid-run'))
  await sleep(3000)
  const tickCtx = () => follower._tickerCtx
  if (tickCtx()) tickCtx().paused = true
  await rcon(`tp ${FOLLOWER} ${gx + 2.5} ${gy} ${gz + 0.5}`).catch((e) => fail('tp', e.message))
  await rcon(`clear ${FOLLOWER}`).catch((e) => fail('clear', e.message))
  if (KIT === 'seeded') {
    for (const [item, count] of [['stone_pickaxe', 1], ['stone_axe', 1], ['stone_sword', 1], ['bread', 16]]) {
      await rcon(`give ${FOLLOWER} ${item} ${count}`).catch((e) => fail('seed', `${item}: ${e.message}`))
    }
  }
  await sleep(2000)
  if (tickCtx()) tickCtx().paused = false

  // The house must be the bot's home before the window opens: a missed
  // adopt would measure a fresh build, not the work cycle.
  let home = null
  for (let i = 0; i < 60 && !home; i++) {
    const h = tickCtx() && tickCtx().home
    if (h && h.site && h.site.x === site.x && h.site.y === site.y && h.site.z === site.z) home = h
    else await sleep(1000)
  }
  if (!home) fail('adopt', `rig house at ${site.x} ${site.y} ${site.z} never adopted`)

  let sees = false
  for (let i = 0; i < 40 && !sees; i++) {
    try { sees = !!(follower.players && follower.players[GUIDE] && follower.players[GUIDE].entity) } catch (_) { sees = false }
    if (!sees) await sleep(500)
  }
  if (!sees) fail('order', `follower never saw ${GUIDE}`)
  try { guide.chat('autonomous on') } catch (e) { fail('order', `autonomous chat: ${e.message}`) }
  await sleep(1000)
  try { guide.chat('go work') } catch (e) { fail('order', `work chat: ${e.message}`) }
  await sleep(2000)
  if (!kept.some((l) => /^say: autonomous on\b/.test(l))) fail('order', 'no autonomous ack')
  try { guide.quit('ordered') } catch (_) { /* quit best-effort */ }

  const winStart = kept.length // setup chats (ore finds, the ack) stay out of the verdict
  const t0 = Date.now()
  const endAt = t0 + MINS * 60000
  origLog(`WORK-RIG window: ${MINS} min, ends ${new Date(endAt).toISOString()}`)
  let lastSample = t0
  while (Date.now() < endAt) {
    await sleep(Math.min(15000, Math.max(0, endAt - Date.now())))
    if (Date.now() - lastSample >= 300000) {
      lastSample = Date.now()
      let pos = '?'
      try { const p = follower.entity.position; pos = `${Math.round(p.x)} ${Math.round(p.y)} ${Math.round(p.z)}` } catch (_) { /* pos best-effort */ }
      const c = tickCtx() || {}
      origLog(`WORK-RIG sample t=${Math.round((Date.now() - t0) / 60000)}min pos=${pos} step=${c.step} hp=${follower.health} food=${follower.food} day=${timeResync.daytime()} ${verdict(kept.slice(winStart), MINS).line}`)
    }
  }
  const v = verdict(kept.slice(winStart), MINS)
  try {
    fs.writeFileSync(OUT, JSON.stringify({
      date: new Date().toISOString(), mins: MINS, tag: TAG, gitsha: process.env.WORK_GITSHA || '?',
      kit: KIT, tickrate: TICKRATE, planner: PLANNER, site, log: LOGFILE, ...v,
    }, null, 1))
  } catch (e) { origLog(`WORK-RIG out write failed: ${e.message}`) }
  origLog(v.line)
  try { logStream.end() } catch (_) { /* close best-effort */ }
  process.exit(0)
}

if (require.main === module) {
  main().catch((e) => {
    origLog(`WORK-RIG FATAL: ${e && e.message ? e.message : e}`)
    try { if (logStream) logStream.end() } catch (_) { /* close best-effort */ }
    process.exit(2)
  })
}
module.exports = { verdict, siteCommands }
