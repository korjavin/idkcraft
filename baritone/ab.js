// Baritone A/B driver (idkcraft-vhlb.6): replays the stuck corpus follow spots
// (the 16 secs<=90 the vhlb.1 A/B used) plus baritone/tasks.json against a
// Baritone client on the rig, judged server-side over rcon. Run by run.sh.
// Env: RIG_CONTAINER (rcon target), BOT (client player name), CHAT_FIFO (the
// client's HeadlessMc console stdin), AB_OUT (json), AB_ONLY (comma list).
// Kit, prep and the reach radius mirror bot/tools/stuck-replay.js so the rows
// sit next to its last-replay.json; stuck/eps/call are mineflayer-internal
// counters, so here `stuck` = longest stretch (s) without 0.3 blocks of motion.
const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

const REACH_DIST = 2.5 // stuck-replay.js REACH_DIST
const IDLE_MOVE = 0.3

function parsePos(out) { // "... has the following entity data: [-61.3d, 66.0d, -210.5d]"
  const m = /\[(-?[\d.]+)d, (-?[\d.]+)d, (-?[\d.]+)d\]/.exec(out)
  return m ? [+m[1], +m[2], +m[3]] : null
}
function parseCount(out) { // `clear <p> <item> 0`: "Found 3 matching item(s) on player X" | "No items were found ..."
  const m = /Found (\d+) matching/.exec(out)
  return m ? +m[1] : 0
}
function dist(a, b) { // b = [x, y, z], or an [x, z] goal (y ignored)
  if (b.length === 2) b = [b[0], a[1], b[1]]
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])
}
// A spawn inside the goal shell (S7: 1.9 from its goal) would read reached on
// the first sample; there Baritone must arrive at the goal block itself.
function reachRadius(s) {
  return s.goal.length === 3 && dist(s.spawn, s.goal) < 4 ? 1 : REACH_DIST
}
function command(s) { // the Baritone chat command for a spot
  if (s.mode === 'mine') return `#mine ${s.count} ${s.blocks.join(' ')}`
  if (s.goal.length === 2) return `#goto ${s.goal[0]} ${s.goal[1]}`
  return `#goto ${s.goal.join(' ')}`
}
function loadSpots(corpusFile, tasksFile, only) {
  const corpus = JSON.parse(fs.readFileSync(corpusFile, 'utf8'))
    .filter((s) => !s.mode && (s.secs == null || s.secs <= 90))
    .map((s) => ({ secs: 75, scaffold: 64, pickaxe: true, bucket: false, prep: [], ...s }))
  const tasks = JSON.parse(fs.readFileSync(tasksFile, 'utf8'))
    .map((s) => ({ scaffold: 0, pickaxe: false, bucket: false, prep: [], ...s }))
  const all = corpus.concat(tasks)
  return only ? all.filter((s) => only.includes(s.name)) : all
}

function main() {
  const C = process.env.RIG_CONTAINER || 'idk-replay-z'
  const BOT = process.env.BOT
  const FIFO = process.env.CHAT_FIFO
  if (!BOT || !FIFO) throw new Error('BOT and CHAT_FIFO are required (run via run.sh)')
  const rcon = (cmd) => execFileSync('docker', ['exec', C, 'rcon-cli', cmd], { encoding: 'utf8' })
  const chat = (msg) => fs.appendFileSync(FIFO, `msg "${msg}"\n`)
  const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
  const pos = () => parsePos(rcon(`data get entity ${BOT} Pos`))
  const only = process.env.AB_ONLY ? process.env.AB_ONLY.split(',') : null
  const spots = loadSpots(path.join(__dirname, '../bot/tools/stuck-spots.json'), path.join(__dirname, 'tasks.json'), only)
  const rows = []
  console.log('spot              reached  stuck  secs   minDist  note')
  for (const s of spots) {
    chat('#stop')
    for (const cmd of s.prep) rcon(cmd)
    rcon(`tp ${BOT} ${s.spawn.join(' ')}`)
    rcon(`clear ${BOT}`)
    if (s.scaffold > 0) rcon(`give ${BOT} dirt ${s.scaffold}`)
    if (s.pickaxe) rcon(`give ${BOT} stone_pickaxe 1`)
    if (s.bucket) { rcon(`give ${BOT} water_bucket 1`); rcon(`give ${BOT} water_bucket 1`) }
    for (const e of ['water_breathing', 'fire_resistance']) rcon(`effect give ${BOT} minecraft:${e} ${s.secs + 30}`)
    sleep(2000) // chunks in, client landed
    chat(command(s))
    const t0 = Date.now()
    let reached = false; let stuck = 0; let minDist = Infinity; let note = ''
    let still = pos(); let stillAt = t0
    while (Date.now() - t0 < s.secs * 1000) {
      sleep(500)
      const p = pos()
      if (!p) { note = 'NO-POS (client dropped?)'; break }
      if (dist(p, still) > IDLE_MOVE) { still = p; stillAt = Date.now() }
      stuck = Math.max(stuck, (Date.now() - stillAt) / 1000)
      if (s.mode === 'mine') {
        const n = parseCount(rcon(`clear ${BOT} raw_iron 0`))
        note = `raw_iron ${n}`
        if (n >= s.count) { reached = true; break }
      } else {
        minDist = Math.min(minDist, dist(p, s.goal))
        if (minDist <= reachRadius(s)) { reached = true; break }
      }
    }
    const secs = +((Date.now() - t0) / 1000).toFixed(0)
    const row = { spot: s.name, reached, stuck: +stuck.toFixed(0), secs, minDist: Number.isFinite(minDist) ? +minDist.toFixed(1) : null, note }
    rows.push(row)
    console.log(`${s.name.padEnd(17)} ${String(reached).padEnd(8)} ${String(row.stuck).padEnd(6)} ${String(secs).padEnd(6)} ${String(row.minDist).padEnd(8)} ${note}`)
  }
  chat('#stop')
  const out = process.env.AB_OUT || '/private/tmp/baritone-ab.json'
  fs.writeFileSync(out, JSON.stringify({ engine: 'baritone-1.18.0', date: new Date().toISOString(), rows }, null, 1))
  const ok = rows.filter((r) => r.reached).length
  console.log(`baritone: ${ok}/${rows.length} reached, ${rows.reduce((a, r) => a + r.secs, 0)} s total -> ${out}`)
}

module.exports = { parsePos, parseCount, dist, reachRadius, command, loadSpots }
if (require.main === module) main()
