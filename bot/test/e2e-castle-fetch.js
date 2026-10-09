'use strict'

// Manual e2e castle-materials check (not run by npm test; idkcraft-g0z.4):
// the REAL bot stack (runOnce, stub brain, work mode) on a flat Paper rig
// (sh test/mc-up.sh). The bot holds NO castle material — tools and the
// house beds only — and must lay 30 stone cells of the slice by itself:
// castlefetch digs cobble from a stone field off the site, and takes the
// floor torch from a chest the owner stood on the castle site.
//   MC_HOST=localhost MC_PORT=25565 MC_CONTAINER=idk-mc node test/e2e-castle-fetch.js
// Hold the shared rig lock around it (CLAUDE.md / bot/tools/README.md).
// The pane sand ladder (g0z.38: sand order -> fuel -> furnace -> panes) is
// not covered here; its live scenario is the castle rig:
//   CASTLE_SEED=complete CASTLE_KIT=empty CASTLE_SAND=1 sh bot/tools/castle-rig.sh 60
// (verdict panes=<laid>/44, castle still complete).
const mineflayer = require('mineflayer')
const os = require('node:os')
const fs = require('node:fs')
const path = require('node:path')
const { execFile } = require('node:child_process')
const { promisify } = require('node:util')
const { waitFor, sleep } = require('./e2e-util')

const MEM_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'castle-fetch-'))
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
const NAME = `Fetch${TAG}`
const GUIDE = `Guide${TAG}`
const WANT_STONE = 30

async function rcon(cmd) {
  const { stdout } = await execFileAsync('docker', ['exec', MC_CONTAINER, 'rcon-cli', cmd])
  return stdout.trim()
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
  const { site, rot } = castleSite({ x: at.x + 0.5, y: gy, z: at.z + 0.5 }, 0)
  const { w, d } = blueprint.siteDimensions(rot, blueprint.BLUEPRINT_VERSION) // the order's version (g0z.12: v2)
  // Stone field west of the site (outside the castle's dig margin): two
  // layers above ground plus the ground layer — ~190 stone, no ore.
  const fx = site.x - 13
  const fz = site.z + 1
  log(`spawn ${sp.x} ${sp.y} ${sp.z}, house ${home.x} ${home.y} ${home.z}, castle ${site.x} ${site.y} ${site.z} rot ${rot}, field ${fx} ${fz}`)
  const out = [
    await rcon(`fill ${site.x - 2} ${gy} ${site.z - 2} ${site.x + w + 1} ${gy + 16} ${site.z + d + 3} air`),
    await rcon(`fill ${site.x - 2} ${gy - 1} ${site.z - 2} ${site.x + w + 1} ${gy - 1} ${site.z + d + 3} grass_block`),
    await rcon(`fill ${fx} ${gy - 1} ${fz} ${fx + 7} ${gy + 1} ${fz + 7} stone`),
    await rcon(`setblock ${site.x} ${gy} ${site.z} chest`),
    await rcon(`item replace block ${site.x} ${gy} ${site.z} container.0 with torch 16`),
  ]
  if (out.some((o) => /not loaded|error|Unknown|Incorrect/i.test(o))) throw new Error(`rig setup failed: ${out.join(' | ')}`)
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
  await rcon(`clear ${NAME}`)
  for (const [item, n] of [['stone_pickaxe', 1], ['stone_sword', 1], ['white_bed', 2]]) await rcon(`give ${NAME} ${item} ${n}`)
  await rcon(`tp ${GUIDE} ${at.x + 0.5} ${gy} ${at.z + 0.5} 180 0`)
  await sleep(2000)
  await guide.look(0, 0, true) // mineflayer yaw 0 = north
  await sleep(1000)
  const ctx = bot._tickerCtx
  const steps = new Set()
  const tracker = setInterval(() => { if (ctx.step) steps.add(ctx.step) }, 500)
  // Keep it day: the gamerule above does not hold on 26.1 (rig: dusk at
  // ~550 s); this check is about materials, the night chain is g0z.3's.
  const daylight = setInterval(() => { rcon('time set 1000').catch(() => {}) }, 60000)
  guide.chat('build castle')
  await until('castle order', 15000, () => ctx.castle)
  const st = ctx.castle
  if (st.site.x !== site.x || st.site.z !== site.z || st.rot !== rot) throw new Error(`site ${JSON.stringify(st.site)} rot ${st.rot}, want ${JSON.stringify(site)} rot ${rot}`)
  log(`order ok: ${chats[chats.length - 1]}`)
  const stoneLaid = () => castleMod.progressByKind(bot, st).stone.done
  let last = -1
  await until(`${WANT_STONE} stone cells`, 40 * 60000, () => {
    const n = stoneLaid()
    if (n !== last) { last = n; log(`stone ${n}/${WANT_STONE} step=${ctx.step} status=${st.status}`) }
    return n >= WANT_STONE
  })
  clearInterval(tracker)
  clearInterval(daylight)
  const torch = castleMod.progressByKind(bot, st).torch.done
  // Nothing dug on the castle ground: the site floor is intact grass.
  let holes = 0
  for (let x = site.x - 1; x <= site.x + w; x++) {
    for (let z = site.z - 1; z <= site.z + d; z++) {
      const b = bot.blockAt(new (require('vec3'))(x, gy - 1, z))
      if (b && b.name === 'air') holes++
    }
  }
  log(`steps seen: ${[...steps].join(',')}; torch cells ${torch}; site floor holes ${holes}`)
  if (!steps.has('castlefetch')) throw new Error('castlefetch never ran')
  if (torch < 1) throw new Error('the floor torch (castle chest) never went in')
  if (holes > 0) throw new Error(`${holes} holes dug in the castle floor`)
  console.log(`PASS castle fetch: ${stoneLaid()} stone cells + ${torch} torch from an empty pack (dug stone, chest torches)`)
  process.exit(0)
}

main().catch((e) => { console.error(`FAIL ${e && e.message ? e.message : e}`); process.exit(1) })
