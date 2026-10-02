'use strict'

// Manual e2e v2 castle-materials check (not run by npm test; idkcraft-g0z.12):
// the REAL bot stack (runOnce, stub brain, work mode) on a flat Paper rig
// (sh test/mc-up.sh). A 'build castle' order must come out v2; the rig then
// lays the plan prefix by rcon (the bot would need hours for the towers)
// and the bot must source and lay what the executor could not before:
//   1. the first Fachwerk sill: frame cells from logs it chops itself
//      (empty pack, a few trees west of the fence), one gather load per batch;
//   2. the storeroom chest: crafted from planks and placed inside the castle.
//   MC_HOST=localhost MC_PORT=25565 MC_CONTAINER=idk-mc node test/e2e-castle-v2.js
// Hold the shared rig lock around it (CLAUDE.md / bot/tools/README.md).
const mineflayer = require('mineflayer')
const os = require('node:os')
const fs = require('node:fs')
const path = require('node:path')
const { execFile } = require('node:child_process')
const { promisify } = require('node:util')
const { waitFor, sleep } = require('./e2e-util')

const MEM_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'castle-v2-'))
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
const NAME = `Vtwo${TAG}`
const GUIDE = `Guide${TAG}`
const WANT_FRAME = castleMod.batchOf('frame') // one full gather load laid
const BLOCK = { stone: 'cobblestone', planks: 'oak_planks', torch: 'torch', frame: 'oak_log', chest: 'chest' }

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

// Lay every rank-0 place cell before plan index `stop` (work order = plan
// order for them; door/air/dig/fence come later anyway). 8 rcon in flight.
async function prefill(st, stop) {
  const cells = blueprint.absPlan(st.site, st.rot, st.blueprintVersion).cells
    .filter((c) => c.idx < stop && BLOCK[c.kind])
  for (let i = 0; i < cells.length; i += 8) {
    await Promise.all(cells.slice(i, i + 8).map((c) => rcon(`setblock ${c.x} ${c.y} ${c.z} ${BLOCK[c.kind]}`)))
  }
  return cells.length
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
  const at = { x: Math.floor(sp.x) - 8, z: Math.floor(sp.z) }
  const { site, rot } = castleSite({ x: at.x + 0.5, y: gy, z: at.z + 0.5 }, 0)
  const { w, d } = blueprint.siteDimensions(rot, blueprint.BLUEPRINT_VERSION)
  // Trees west of the fence, outside the site: 5 short oaks, 4 logs each.
  const tx = site.x - 6
  log(`spawn ${sp.x} ${sp.y} ${sp.z}, house ${home.x} ${home.y} ${home.z}, castle ${site.x} ${site.y} ${site.z} rot ${rot} (${w}x${d}), trees x=${tx}`)
  const out = [
    await rcon(`fill ${site.x - 10} ${gy} ${site.z - 2} ${site.x + w + 1} ${gy + 16} ${site.z + d + 3} air`),
    await rcon(`fill ${site.x - 10} ${gy - 1} ${site.z - 2} ${site.x + w + 1} ${gy - 1} ${site.z + d + 3} grass_block`),
  ]
  for (let i = 0; i < 5; i++) {
    const z = site.z + 3 + i * 5
    out.push(await rcon(`fill ${tx - 1} ${gy + 3} ${z - 1} ${tx + 1} ${gy + 4} ${z + 1} oak_leaves[persistent=true]`))
    out.push(await rcon(`fill ${tx} ${gy} ${z} ${tx} ${gy + 3} ${z} oak_log`))
  }
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
  for (const [item, n] of [['stone_pickaxe', 1], ['stone_sword', 1], ['stone_axe', 1], ['white_bed', 2], ['cobblestone', 32]]) await rcon(`give ${NAME} ${item} ${n}`)
  await rcon(`tp ${GUIDE} ${at.x + 0.5} ${gy} ${at.z + 0.5} 180 0`)
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
  if (st.blueprintVersion !== 2) throw new Error(`new order got v${st.blueprintVersion}, want v2`)
  if (st.site.x !== site.x || st.site.z !== site.z || st.rot !== rot) throw new Error(`site ${JSON.stringify(st.site)} rot ${st.rot}, want ${JSON.stringify(site)} rot ${rot}`)
  log(`order ok: ${chats[chats.length - 1]}`)
  guide.chat('castle stop')
  await rcon(`tp ${GUIDE} ${tx - 4} ${gy} ${site.z - 1}`)
  await rcon(`tp ${NAME} ${tx - 2} ${gy} ${site.z + 1}`)
  await sleep(2000)
  const plan = blueprint.BLUEPRINTS[2].PLAN
  const firstFrame = plan.findIndex((c) => c.kind === 'frame')
  log(`prefill ${await prefill(st, firstFrame)} cells up to the first frame cell (#${firstFrame})`)
  st.phase = 'body'
  guide.chat('castle go')
  const progress = (kind) => castleMod.progressByKind(bot, st)[kind].done
  let last = -1
  await until(`${WANT_FRAME} frame cells`, 30 * 60000, () => {
    const n = progress('frame')
    const logs = bot.inventory.items().filter((i) => i.name.endsWith('_log')).reduce((a, i) => a + i.count, 0)
    if (n !== last) { last = n; log(`frame ${n}/${WANT_FRAME} logs=${logs} step=${ctx.step} status=${st.status}`) }
    return n >= WANT_FRAME
  })
  if (!steps.has('castlefetch')) throw new Error('castlefetch never ran')
  log(`PASS 1: ${progress('frame')} frame cells from chopped logs; steps ${[...steps].join(',')}`)

  // 2: everything up to the storeroom chest laid by rcon; the bot crafts
  // the chest (planks + a table on hand) and places it inside.
  guide.chat('castle stop')
  await sleep(2000)
  await rcon(`tp ${NAME} ${tx - 2} ${gy} ${site.z + 1}`)
  const chestIdx = plan.findIndex((c) => c.kind === 'chest')
  log(`prefill ${await prefill(st, chestIdx)} cells up to the chest (#${chestIdx})`)
  await rcon(`clear ${NAME} chest`)
  for (const [item, n] of [['oak_planks', 24], ['crafting_table', 1]]) await rcon(`give ${NAME} ${item} ${n}`)
  guide.chat('castle go')
  last = -1
  await until('the storeroom chest', 20 * 60000, () => {
    const n = progress('chest')
    if (n !== last) { last = n; log(`chest ${n}/1 step=${ctx.step} status=${st.status}`) }
    return n >= 1
  })
  clearInterval(tracker)
  clearInterval(daylight)
  console.log(`PASS castle v2: new order v2, ${progress('frame')} frame cells from chopped logs, storeroom chest crafted and placed`)
  process.exit(0)
}

main().catch((e) => { console.error(`FAIL ${e && e.message ? e.message : e}`); process.exit(1) })
