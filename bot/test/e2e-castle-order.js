'use strict'

// Manual e2e castle-order check (not run by npm test; idkcraft-g0z.3):
// the REAL bot stack (runOnce, stub brain, work mode) on a flat Paper rig
// (sh test/mc-up.sh) takes 'build castle' from a guide, and the work
// arbiter drives the castle step through a day: lay cells, dusk -> gohome
// -> stay in the (rcon-raised) house, morning -> castle re-entry, 'castle
// stop' parks it, 'castle go' resumes, 'castle' reports progress.
//   MC_HOST=localhost MC_PORT=25565 MC_CONTAINER=idk-mc node test/e2e-castle-order.js
// Hold the shared rig lock around it (CLAUDE.md / bot/tools/README.md).
const mineflayer = require('mineflayer')
const os = require('node:os')
const fs = require('node:fs')
const path = require('node:path')
const { execFile } = require('node:child_process')
const { promisify } = require('node:util')
const { waitFor, sleep } = require('./e2e-util')

const MEM_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'castle-order-'))
process.env.BOT_MEMORY_FILE = path.join(MEM_DIR, 'bot.json')
const index = require('../src/index')
const { stubBrain } = require('../src/brain')
const blueprint = require('../src/castle')
const castleMod = require('../src/behaviours/castle')
const { castleSite } = require('../src/chat')
const { raiseHouse } = require('../tools/raise-house')

const execFileAsync = promisify(execFile)
const MC_HOST = process.env.MC_HOST || 'localhost'
const MC_PORT = parseInt(process.env.MC_PORT || '25565', 10)
const MC_CONTAINER = process.env.MC_CONTAINER || 'idk-mc'
const TAG = Math.floor(Math.random() * 10000)
const NAME = `Order${TAG}`
const GUIDE = `Guide${TAG}`

async function rcon(cmd) {
  const { stdout } = await execFileAsync('docker', ['exec', MC_CONTAINER, 'rcon-cli', cmd])
  return stdout.trim()
}

function laid(bot, st) {
  let n = 0
  for (const e of Object.values(castleMod.progressByKind(bot, st))) n += e.done
  return n
}

async function until(what, ms, fn) {
  const end = Date.now() + ms
  for (;;) {
    const v = fn()
    if (v) return v
    if (Date.now() > end) throw new Error(`timed out: ${what}`)
    await sleep(1000)
  }
}

async function main() {
  const t0 = Date.now()
  const log = (m) => console.log(`[${Math.round((Date.now() - t0) / 1000)}s] ${m}`)
  await rcon('difficulty peaceful')
  await rcon('gamerule doDaylightCycle false')
  await rcon('time set 1000')
  const guide = mineflayer.createBot({ host: MC_HOST, port: MC_PORT, username: GUIDE, auth: 'offline' })
  await waitFor(guide, 'spawn', 60000, 'guide spawn')
  await sleep(3000)
  const sp = guide.spawnPoint
  const gy = Math.floor(guide.entity.position.y)
  const home = { x: Math.floor(sp.x) + 12, y: gy, z: Math.floor(sp.z) - 3 } // clear of the v2 site (g0z.12)
  const at = { x: Math.floor(sp.x) - 8, z: Math.floor(sp.z) }
  // Guide looks north: the castle rises to -z with its gate facing south.
  const { site, rot } = castleSite({ x: at.x + 0.5, y: gy, z: at.z + 0.5 }, 0)
  const { w, d } = blueprint.siteDimensions(rot, blueprint.BLUEPRINT_VERSION) // the order's version (g0z.12: v2)
  log(`spawn ${sp.x} ${sp.y} ${sp.z}, house at ${home.x} ${home.y} ${home.z}, castle site ${site.x} ${site.y} ${site.z} rot ${rot}`)
  const fills = [
    await rcon(`fill ${site.x - 2} ${gy} ${site.z - 2} ${site.x + w + 1} ${gy + 16} ${site.z + d + 3} air`),
    await rcon(`fill ${site.x - 2} ${gy - 1} ${site.z - 2} ${site.x + w + 1} ${gy - 1} ${site.z + d + 3} grass_block`),
  ]
  if (fills.some((o) => /not loaded|error|Unknown/i.test(o))) throw new Error(`site fill failed: ${fills.join(' | ')}`)
  await raiseHouse(rcon, home)
  await sleep(6000) // Paper same-IP connection throttle
  let bot = null
  const chats = []
  const mk = (opts) => {
    const b = mineflayer.createBot({ ...opts, username: NAME })
    bot = b
    b.once('spawn', () => {
      const orig = b.chat.bind(b)
      b.chat = (m) => { chats.push(String(m)); log(`bot: ${m}`); return orig(m) }
    })
    return b
  }
  index.runOnce({
    host: MC_HOST, port: MC_PORT, username: NAME, tickMs: 1000, idleTickMs: 1000,
    brain: stubBrain, leaveAfterMs: 0, followName: '', createBot: mk,
    pingFn: async () => ({ players: { online: 2 } }),
  }).then(() => {}, (e) => { console.error(`runOnce rejected: ${e && e.message}`); process.exit(2) })
  await until('bot spawn', 60000, () => bot && bot.entity && bot._tickerCtx)
  await sleep(3000)
  for (const [item, n] of [['cobblestone', 64], ['cobblestone', 64], ['cobblestone', 64], ['cobblestone', 64], ['oak_planks', 64], ['oak_door', 1], ['torch', 64], ['white_bed', 2], ['stone_pickaxe', 1], ['stone_sword', 1]]) {
    await rcon(`give ${NAME} ${item} ${n}`)
  }
  await rcon(`tp ${GUIDE} ${at.x + 0.5} ${gy} ${at.z + 0.5} 180 0`)
  await sleep(2000)
  await guide.look(0, 0, true) // mineflayer yaw 0 = north
  await sleep(1000)
  const ctx = bot._tickerCtx
  guide.chat('build castle')
  await until('castle order', 15000, () => ctx.castle)
  const st = ctx.castle
  if (st.site.x !== site.x || st.site.z !== site.z || st.rot !== rot) throw new Error(`site ${JSON.stringify(st.site)} rot ${st.rot}, want ${JSON.stringify(site)} rot ${rot}`)
  log(`order ok: ${chats[chats.length - 1]}`)

  // Day 1: the arbiter reaches the castle step (after the house chain) and lays cells.
  await until('castle step', 8 * 60000, () => ctx.step === 'castle')
  log('castle step picked')
  const day1 = await until('20 cells laid', 15 * 60000, () => (laid(bot, st) >= 20 ? laid(bot, st) : 0))
  log(`day 1: ${day1} cells laid`)

  // Dusk: off the castle, home, inside.
  await rcon('time set 12500')
  await until('gohome at dusk', 30000, () => ctx.step === 'gohome' || ctx.step === 'stay')
  log(`dusk: step=${ctx.step}`)
  await until('inside at dusk', 4 * 60000, () => ctx.step === 'stay')
  const atDusk = laid(bot, st)
  const bp = bot.entity.position
  log(`stay inside at ${bp.x.toFixed(1)} ${bp.y.toFixed(1)} ${bp.z.toFixed(1)}, castle ${atDusk}`)
  await rcon('time set 18000')
  await sleep(15000)
  if (ctx.step === 'castle') throw new Error('castle step at night')
  if (laid(bot, st) !== atDusk) throw new Error(`castle grew at night: ${atDusk} -> ${laid(bot, st)}`)

  // Morning: re-entry.
  await rcon('time set 1000')
  await until('castle re-entry', 4 * 60000, () => ctx.step === 'castle')
  await until('morning cells', 10 * 60000, () => laid(bot, st) >= atDusk + 5)
  log(`morning re-entry: castle ${laid(bot, st)}`)

  // Stop / go.
  guide.chat('castle stop')
  await until('parked', 15000, () => st.parked && ctx.step !== 'castle')
  await sleep(5000)
  const parked = laid(bot, st)
  await sleep(30000)
  if (laid(bot, st) > parked + 1) throw new Error(`parked castle grew ${parked} -> ${laid(bot, st)}`)
  log(`parked: step=${ctx.step}, castle ${laid(bot, st)}`)
  guide.chat('castle go')
  await until('resumed', 60000, () => ctx.step === 'castle')
  await until('resumed cells', 5 * 60000, () => laid(bot, st) >= parked + 3)
  log(`resumed: castle ${laid(bot, st)}`)

  // Status line + persisted record.
  guide.chat('castle')
  await until('status line', 10000, () => chats.find((c) => /^castle at .*%/.test(c)))
  const saved = JSON.parse(fs.readFileSync(process.env.BOT_MEMORY_FILE, 'utf8')).castle
  if (!saved || saved.site.x !== site.x || saved.rot !== rot) throw new Error(`memory castle ${JSON.stringify(saved)}`)
  log(`memory castle ${JSON.stringify(saved.site)} rot ${saved.rot} parked ${saved.parked}`)
  console.log(`PASS castle order: ${laid(bot, st)} cells, dusk return + morning re-entry + stop/go`)
  process.exit(0)
}

main().catch((e) => { console.error(`FAIL ${e && e.message ? e.message : e}`); process.exit(1) })
