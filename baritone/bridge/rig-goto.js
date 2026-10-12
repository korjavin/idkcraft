// idkcraft-kqzf spike: rig proof that the ADAPTER's pathfinder drives real
// Baritone. One stuck spot through BaritoneBot (console backend:
// setGoal(GoalNear) -> `msg #goto` on the existing write-only bridge),
// judged server-side over rcon like ab.js. Run via rig.sh (slot z Paper +
// offline client), or against any rig with RIG_CONTAINER/BOT/BRIDGE_* set.
// Env: RIG_CONTAINER (default idk-replay-z), BOT=IdkBody,
// BRIDGE_HOST/BRIDGE_PORT (default localhost:7779 = rig.sh's publish),
// GOTO_SPOT (default EP1), GOTO_OUT (default /private/tmp/kqzf-rig-goto.json).
'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

const { parsePos, dist, reachedAt, sendBridgeLine } = require('../ab')
const { BaritoneBot } = require('./adapter')

let goals
try {
  goals = require('../../bot/node_modules/mineflayer-pathfinder').goals
} catch (_) {
  throw new Error('rig-goto: run `cd bot && npm ci` first (needs mineflayer-pathfinder)')
}
let Vec3
try {
  Vec3 = require('../../bot/node_modules/vec3')
} catch (_) {
  Vec3 = require('./adapter').MinimalVec
}

async function main() {
  const C = process.env.RIG_CONTAINER || 'idk-replay-z'
  const BOT = process.env.BOT || 'IdkBody'
  const BRIDGE = { host: process.env.BRIDGE_HOST || 'localhost', port: +(process.env.BRIDGE_PORT || 7779) }
  const spotName = process.env.GOTO_SPOT || 'EP1'
  const rcon = (cmd) => execFileSync('docker', ['exec', C, 'rcon-cli', cmd], { encoding: 'utf8' })
  // Async sleep, NOT the ab.js Atomics.wait block: the adapter's setGoal is
  // sync fire-and-forget by mineflayer contract, so its socket send needs a
  // pumping event loop — a blocked loop starves the connect and the #goto
  // never leaves (first rig run: timeout, minDist 13.1, no `> goto`).
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const pos = () => parsePos(rcon(`data get entity ${BOT} Pos`))

  const spots = JSON.parse(fs.readFileSync(path.join(__dirname, '../../bot/tools/stuck-spots.json'), 'utf8'))
  const s = spots.find((x) => x.name === spotName)
  if (!s) throw new Error(`rig-goto: no spot ${spotName}`)
  if (s.mode) throw new Error(`rig-goto: spot ${spotName} is mode=${s.mode}, want a plain walk spot`)

  // The adapter under test: console backend, goals become `msg #goto` lines.
  const bot = new BaritoneBot(null, {
    Vec3,
    backend: 'console',
    username: BOT,
    bridgeSend: (line) => sendBridgeLine({ ...BRIDGE, line }),
  })
  await bot.start({ pollMs: 0 })
  const errors = []
  bot.on('error', (e) => errors.push(String((e && e.message) || e)))

  const secs = s.secs || 75
  await sendBridgeLine({ ...BRIDGE, line: 'msg #stop' })
  for (const cmd of s.prep || []) rcon(cmd)
  rcon(`tp ${BOT} ${s.spawn.join(' ')}`)
  rcon(`clear ${BOT}`)
  if ((s.scaffold || 0) > 0) rcon(`give ${BOT} dirt ${s.scaffold}`)
  if (s.pickaxe) rcon(`give ${BOT} stone_pickaxe 1`)
  if (s.bucket) { rcon(`give ${BOT} water_bucket 1`); rcon(`give ${BOT} water_bucket 1`) }
  for (const e of ['water_breathing', 'fire_resistance']) rcon(`effect give ${BOT} minecraft:${e} ${secs + 30}`)
  await sleep(2000)
  // THE spike line: a mineflayer goal object, through the adapter, onto Baritone.
  const g = s.goal.length === 2 ? new goals.GoalXZ(s.goal[0], s.goal[1]) : new goals.GoalNear(s.goal[0], s.goal[1], s.goal[2], 2)
  bot.pathfinder.setGoal(g)
  await sleep(1000) // the fire-and-forget `msg` line lands on the console
  const t0 = Date.now()
  let reached = false
  let minDist = Infinity
  let note = ''
  while (Date.now() - t0 < secs * 1000) {
    await sleep(500)
    const p = pos()
    if (!p) { note = 'NO-POS (client dropped?)'; break }
    minDist = Math.min(minDist, dist(p, s.goal))
    if (reachedAt(s, p)) { reached = true; break }
  }
  const rowSecs = +((Date.now() - t0) / 1000).toFixed(0)
  await sendBridgeLine({ ...BRIDGE, line: 'msg #stop' }).catch(() => {})
  await bot.stop().catch(() => {})
  const row = {
    engine: 'adapter-console->baritone-1.18.0',
    spot: s.name,
    reached,
    secs: rowSecs,
    minDist: Number.isFinite(minDist) ? +minDist.toFixed(1) : null,
    note: [note, errors.length > 0 ? `adapter errors: ${errors.join('; ')}` : ''].filter(Boolean).join('; '),
  }
  const out = process.env.GOTO_OUT || '/private/tmp/kqzf-rig-goto.json'
  fs.writeFileSync(out, JSON.stringify(row, null, 1))
  console.log(`${s.name}: reached=${reached} secs=${rowSecs} minDist=${row.minDist} ${row.note} -> ${out}`)
  process.exit(reached ? 0 : 1)
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(2) })
