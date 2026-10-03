'use strict'

// Manual e2e castle site levelling (not run by npm test; idkcraft-g0z.16):
// the REAL bot stack (runOnce, stub brain, work mode) on a flat Paper rig
// (sh test/mc-up.sh). A footprint with a 5-high step in the hall (core,
// g0z.20: ±4) is refused with the spot count and worst offset, and the
// site search it starts is cancelled; levelled (2-high bumps, a 2-deep
// hole) the order is taken, prep cuts and fills it to site.y-1 and the
// castle reaches its body phase.
//   MC_HOST=localhost MC_PORT=25565 MC_CONTAINER=idk-mc node test/e2e-castle-level.js
const mineflayer = require('mineflayer')
const Vec3 = require('vec3')
const os = require('node:os')
const fs = require('node:fs')
const path = require('node:path')
const { execFile } = require('node:child_process')
const { promisify } = require('node:util')
const { waitFor, sleep } = require('./e2e-util')

const MEM_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'castle-level-'))
process.env.BOT_MEMORY_FILE = path.join(MEM_DIR, 'bot.json')
const index = require('../src/index')
const { stubBrain } = require('../src/brain')
const blueprint = require('../src/castle')
const { castleSite } = require('../src/chat')
const { raiseHouse } = require('../tools/raise-house')

const execFileAsync = promisify(execFile)
const MC_HOST = process.env.MC_HOST || 'localhost'
const MC_PORT = parseInt(process.env.MC_PORT || '25565', 10)
const MC_CONTAINER = process.env.MC_CONTAINER || 'idk-mc'
const TAG = Math.floor(Math.random() * 10000)
const NAME = `Level${TAG}`
const GUIDE = `Guide${TAG}`

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
  const home = { x: Math.floor(sp.x) + 12, y: gy, z: Math.floor(sp.z) - 3 }
  const at = { x: Math.floor(sp.x) - 8, z: Math.floor(sp.z) }
  const { site, rot } = castleSite({ x: at.x + 0.5, y: gy, z: at.z + 0.5 }, 0)
  const { w, d } = blueprint.siteDimensions(rot, blueprint.BLUEPRINT_VERSION)
  log(`castle site ${site.x} ${site.y} ${site.z} rot ${rot} (${w}x${d})`)
  const sy = site.y
  const flatten = [
    `fill ${site.x - 2} ${sy} ${site.z - 2} ${site.x + w + 1} ${sy + 16} ${site.z + d + 3} air`,
    `fill ${site.x - 2} ${sy - 1} ${site.z - 2} ${site.x + w + 1} ${sy - 1} ${site.z + d + 3} grass_block`,
    `fill ${site.x - 2} ${sy - 3} ${site.z - 2} ${site.x + w + 1} ${sy - 2} ${site.z + d + 3} dirt`,
  ]
  for (const c of flatten) {
    const o = await rcon(c)
    if (/not loaded|error|Unknown/i.test(o)) throw new Error(`site fill failed: ${o}`)
  }
  // Uneven ground inside the footprint, away from the guide's stance.
  const bump = { x: site.x + 14, z: site.z + 10 } // a hall column: core
  const ridge = { x: site.x + 12, z: site.z + 18 }
  const hole = { x: site.x + 20, z: site.z + 8 }
  await rcon(`fill ${bump.x} ${sy} ${bump.z} ${bump.x + 1} ${sy + 4} ${bump.z + 1} dirt`) // 5 high: refused
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
  for (const [item, n] of [['cobblestone', 64], ['cobblestone', 64], ['oak_planks', 64], ['oak_door', 1], ['torch', 64], ['white_bed', 2], ['stone_pickaxe', 1], ['stone_shovel', 1], ['stone_sword', 1]]) {
    await rcon(`give ${NAME} ${item} ${n}`)
  }
  await rcon(`tp ${GUIDE} ${at.x + 0.5} ${gy} ${at.z + 0.5} 180 0`)
  await sleep(2000)
  await guide.look(0, 0, true)
  await sleep(1000)
  const ctx = bot._tickerCtx

  // ±5 in the core: refused, with the spot count and the worst offset; the
  // search it starts (g0z.19) is cancelled.
  guide.chat('build castle')
  const no = await until('refusal', 15000, () => chats.find((c) => /too uneven/.test(c)))
  if (!/4 spots are more than 4 blocks off level, worst 5 up/.test(no) || ctx.castle) throw new Error(`refusal: ${no}`)
  guide.chat('castle forget')
  // The search may already have found a spot nearby: forget drops it too.
  await until('search cancelled', 15000, () => chats.some((c) => c === 'castle search cancelled' || /forgotten/.test(c)))
  if (ctx.castle) throw new Error('castle still set after forget')
  log(`refused ok: ${no}`)

  // In range: two 2-high bumps (one planted on the plan) and a 2-deep hole.
  await rcon(`fill ${bump.x} ${sy + 2} ${bump.z} ${bump.x + 1} ${sy + 4} ${bump.z + 1} air`)
  await rcon(`fill ${ridge.x} ${sy} ${ridge.z} ${ridge.x + 2} ${sy + 1} ${ridge.z} stone`)
  await rcon(`fill ${hole.x} ${sy - 2} ${hole.z} ${hole.x + 1} ${sy - 1} ${hole.z + 1} air`)
  await sleep(1000)
  guide.chat('build castle')
  await until('castle order', 15000, () => ctx.castle)
  const st = ctx.castle
  log(`order ok: ${chats[chats.length - 1]}`)
  await until('prep announced', 8 * 60000, () => chats.find((c) => /preparing the castle site/.test(c)))
  await until('body phase', 15 * 60000, () => st.phase === 'body' || st.phase === 'complete')
  log(`body phase: ${chats.filter((c) => /castle site/.test(c)).join(' | ')}`)

  // The footprint is level wherever the plan does not say otherwise.
  const plan = blueprint.absPlan(st.site, st.rot, st.blueprintVersion).at
  const bad = []
  for (const [x0, z0, dxn, dzn] of [[bump.x, bump.z, 2, 2], [ridge.x, ridge.z, 3, 1], [hole.x, hole.z, 2, 2]]) {
    for (let x = x0; x < x0 + dxn; x++) {
      for (let z = z0; z < z0 + dzn; z++) {
        for (let y = sy - 2; y <= sy + 1; y++) {
          const p = plan.get(`${x},${y},${z}`)
          if (p) continue
          const n = bot.blockAt(new Vec3(x, y, z)).name
          const want = y < sy ? n !== 'air' : n === 'air'
          if (!want) bad.push(`${x} ${y} ${z} ${n}`)
        }
      }
    }
  }
  const blocked = Object.entries(st.blocked || {}).map(([k, e]) => `${k}:${e.why}`)
  if (bad.length) throw new Error(`not level: ${bad.join(', ')}; blocked ${blocked.join(' ')}`)
  console.log(`PASS castle level: ±3 refused with counts, ±2 levelled, body phase reached (blocked ${blocked.length})`)
  process.exit(0)
}

main().catch((e) => { console.error(`FAIL ${e && e.message ? e.message : e}`); process.exit(1) })
