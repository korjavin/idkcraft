'use strict'

// Manual e2e castle-quarry check (not run by npm test; idkcraft-g0z.15):
// the REAL bot stack (runOnce, stub brain, work mode) on a flat Paper rig
// (sh test/mc-up.sh). The castle site sits on a stepped hill with no
// exposed stone near it — grass, two dirt, then stone — and the bot starts
// down on the plain, more than DIG_RADIUS from the site, with no stone in
// its pack (pickaxe, sword, beds, the floor torches only). It must walk to
// the site, cut the quarry trench beside it (staircase through the sod) and
// lay 30 stone cells of the plan.
//   MC_HOST=localhost MC_PORT=25565 MC_CONTAINER=idk-mc node test/e2e-castle-quarry.js
// Hold the shared rig lock around it (CLAUDE.md / bot/tools/README.md).
const mineflayer = require('mineflayer')
const os = require('node:os')
const fs = require('node:fs')
const path = require('node:path')
const Vec3 = require('vec3')
const { execFile } = require('node:child_process')
const { promisify } = require('node:util')
const { waitFor, sleep } = require('./e2e-util')

const MEM_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'castle-quarry-'))
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
const NAME = `Quarry${TAG}`
const GUIDE = `Guide${TAG}`
const WANT_STONE = 30
const HILL = 8 // hill top = plain + 8: stone x5, dirt x2, grass

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

// /fill caps a command at 32768 blocks: split along x.
async function fill(x0, y0, z0, x1, y1, z1, what) {
  const per = Math.max(1, Math.floor(32768 / ((y1 - y0 + 1) * (z1 - z0 + 1))))
  const out = []
  for (let x = x0; x <= x1; x += per) out.push(await rcon(`fill ${x} ${y0} ${z0} ${Math.min(x1, x + per - 1)} ${y1} ${z1} ${what}`))
  return out
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
  const home = { x: Math.floor(sp.x) + 12, y: gy, z: Math.floor(sp.z) - 3 }
  const top = gy + HILL
  const at = { x: Math.floor(sp.x) - 60, z: Math.floor(sp.z) }
  const { site, rot } = castleSite({ x: at.x + 0.5, y: top, z: at.z + 0.5 }, 0)
  const { w, d } = blueprint.siteDimensions(rot, blueprint.BLUEPRINT_VERSION)
  // Hill top: the site, the guide's stance, and 26 columns west of the
  // site for the side-0 trench (castlefetch quarrySide 0 runs -x).
  const X0 = Math.min(site.x - 26, at.x - 2)
  const X1 = Math.max(site.x + w + 2, at.x + 2)
  const Z0 = Math.min(site.z - 3, at.z - 2)
  const Z1 = Math.max(site.z + d + 2, at.z + 2)
  log(`spawn ${sp.x} ${sp.y} ${sp.z}, house ${home.x} ${home.y} ${home.z}, castle ${site.x} ${site.y} ${site.z} rot ${rot}, hill x ${X0}..${X1} z ${Z0}..${Z1}`)
  const out = [await rcon(`forceload add ${X0 - HILL} ${Z0 - HILL} ${X1 + HILL} ${Z1 + HILL}`)]
  out.push(...await fill(X0 - HILL, gy, Z0 - HILL, X1 + HILL, gy + 20, Z1 + HILL, 'air'))
  // Stepped flanks: layer k is the top box grown by HILL-1-k, so every
  // layer is a one-block step up from the plain.
  for (let k = 0; k < HILL; k++) {
    const g = HILL - 1 - k
    const what = k < HILL - 3 ? 'stone' : k < HILL - 1 ? 'dirt' : 'grass_block'
    out.push(...await fill(X0 - g, gy + k, Z0 - g, X1 + g, gy + k, Z1 + g, what))
  }
  if (out.some((o) => /not loaded|error|Unknown|Incorrect|too many/i.test(o))) throw new Error(`rig setup failed: ${out.join(' | ')}`)
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
  // Torches: v2's floor torches sit among the first stone cells and their
  // batch is 16 (rig run 1 stalled at 16/30 on 8 torches); this
  // check is about stone (g0z.4's e2e covers the castle-chest torch).
  for (const [item, n] of [['stone_pickaxe', 1], ['stone_sword', 1], ['white_bed', 2], ['torch', 64]]) await rcon(`give ${NAME} ${item} ${n}`)
  await rcon(`tp ${NAME} ${sp.x} ${gy} ${sp.z}`)
  await rcon(`tp ${GUIDE} ${at.x + 0.5} ${top} ${at.z + 0.5} 180 0`)
  await sleep(2000)
  await guide.look(0, 0, true) // mineflayer yaw 0 = north
  await sleep(1000)
  const ctx = bot._tickerCtx
  const steps = new Set()
  const tracker = setInterval(() => { if (ctx.step) steps.add(ctx.step) }, 500)
  const daylight = setInterval(() => { rcon('time set 1000').catch(() => {}) }, 60000)
  guide.chat('build castle')
  await until('castle order', 15000, () => ctx.castle)
  const st = ctx.castle
  if (st.site.x !== site.x || st.site.y !== site.y || st.site.z !== site.z || st.rot !== rot) throw new Error(`site ${JSON.stringify(st.site)} rot ${st.rot}, want ${JSON.stringify(site)} rot ${rot}`)
  const cx = site.x + Math.floor(w / 2)
  const cz = site.z + Math.floor(d / 2)
  const startDist = Math.hypot(bot.entity.position.x - cx, bot.entity.position.z - cz)
  log(`order ok: ${chats[chats.length - 1]}; bot ${startDist.toFixed(0)} blocks from the site centre`)
  // The guide stays online: the bot works only while someone is.
  await rcon(`tp ${GUIDE} ${home.x} ${gy} ${home.z - 4}`)
  const stoneLaid = () => castleMod.progressByKind(bot, st).stone.done
  let last = -1
  await until(`${WANT_STONE} stone cells`, 40 * 60000, () => {
    const n = stoneLaid()
    if (n !== last) { last = n; log(`stone ${n}/${WANT_STONE} step=${ctx.step} status=${st.status} cobble=${bot.inventory.items().filter((i) => i.name === 'cobblestone').reduce((a, i) => a + i.count, 0)}`) }
    return n >= WANT_STONE
  })
  clearInterval(tracker)
  clearInterval(daylight)
  // The trench: dug cells west of the site in the stone layers.
  let trench = 0
  for (let x = site.x - 26; x < site.x - 2; x++) {
    for (let z = site.z; z <= site.z + 5; z++) {
      for (let y = gy + 2; y < top - 3; y++) {
        const b = bot.blockAt(new Vec3(x, y, z))
        if (b && b.name === 'air') trench++
      }
    }
  }
  let holes = 0
  for (let x = site.x - 1; x <= site.x + w; x++) {
    for (let z = site.z - 1; z <= site.z + d; z++) {
      const b = bot.blockAt(new Vec3(x, top - 1, z))
      if (b && b.name === 'air') holes++
    }
  }
  const asked = chats.filter((m) => /no stone near the castle/.test(m)).length
  log(`steps seen: ${[...steps].join(',')}; trench stone cells dug ${trench}; site floor holes ${holes}; owner asked ${asked}x`)
  if (startDist <= 32) throw new Error(`the bot started only ${startDist.toFixed(0)} from the site`)
  if (!steps.has('castlefetch')) throw new Error('castlefetch never ran')
  if (trench < 20) throw new Error(`only ${trench} stone cells dug in the trench`)
  if (asked !== 1) throw new Error(`owner asked ${asked} times, want 1`)
  if (holes > 0) throw new Error(`${holes} holes dug in the castle floor`)
  await rcon(`forceload remove ${X0 - HILL} ${Z0 - HILL} ${X1 + HILL} ${Z1 + HILL}`).catch(() => {})
  console.log(`PASS castle quarry: ${stoneLaid()} stone cells from a trench of ${trench} stone cells (started ${startDist.toFixed(0)} away)`)
  process.exit(0)
}

main().catch((e) => { console.error(`FAIL ${e && e.message ? e.message : e}`); process.exit(1) })
