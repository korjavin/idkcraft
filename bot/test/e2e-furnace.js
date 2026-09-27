'use strict'

// Manual live assay for idkcraft-ipn.1 (not run by npm test): against a
// running flat server (idk-mc up), drive behaviours/furnace.js directly
// with an embedded bot — craft the furnace from 8 cobble at a placed
// table, place it, load 8 ore + coal above the reserve, smelt, take.
// Asserts: the claim stands verified, `smelted 8 iron` logs, 8 ingots
// land in inventory, >=4 coal stays banked (reserve). Cleans its site.
// Exit 0/1. Budget ~8 min (8 ore x 10 s smelt + window flaps).

const mineflayer = require('mineflayer')
const { pathfinder, Movements } = require('mineflayer-pathfinder')
const { execFile } = require('node:child_process')
const { promisify } = require('node:util')
const { waitFor, sleep } = require('./e2e-util')
const furnace = require('../src/behaviours/furnace')

const execFileAsync = promisify(execFile)

const MC_HOST = process.env.MC_HOST || 'localhost'
const MC_PORT = parseInt(process.env.MC_PORT || '25565', 10)
const MC_CONTAINER = process.env.MC_CONTAINER || 'idk-mc'
const NAME = `FurnaceAssay${Math.floor(Math.random() * 10000)}`
const BUDGET_MS = 8 * 60 * 1000
// Spawn-relative candidates: far teleports fall through unloaded chunks
// into the void, so the site is the first free 3x3 pad near spawn.

async function rcon(cmd) {
  await execFileAsync('docker', ['exec', MC_CONTAINER, 'rcon-cli', cmd])
}

// Teleport, then wait until the client's position settles near the
// target: tp packets + chunk loads lag the RCON ack by seconds.
async function tpWait(bot, x, y, z) {
  await rcon(`tp ${NAME} ${x} ${y} ${z}`)
  const end = Date.now() + 15000
  for (;;) {
    await sleep(1000)
    const p = bot.entity.position
    if (Math.abs(p.x - x) < 3 && Math.abs(p.z - z) < 3) return
    if (Date.now() > end) throw new Error(`tp never settled (at ${p.toString()}, want ${x},${y},${z})`)
  }
}

function invCount(bot, name) {
  return bot.inventory.items().filter((i) => i && i.name === name).reduce((n, i) => n + i.count, 0)
}

async function main() {
  const bot = mineflayer.createBot({ host: MC_HOST, port: MC_PORT, username: NAME, auth: 'offline' })
  bot.loadPlugin(pathfinder)
  const lines = []
  const origLog = console.log
  console.log = (...a) => { lines.push(a.map(String).join(' ')); origLog(...a) }
  let site = null
  try {
    await waitFor(bot, 'spawn', 60000, 'assay spawn')
    const spawn = bot.entity.position.clone()
    let site = null
    for (const [ox, oz] of [[30, 30], [-30, 30], [30, -30], [-30, -30], [60, 0], [0, 60]]) {
      const px = Math.round(spawn.x) + ox
      const pz = Math.round(spawn.z) + oz
      await tpWait(bot, px, Math.round(spawn.y) + 30, pz)
      await sleep(2500)
      const feet = bot.entity.position
      let surf = null
      for (let i = 1; i <= 60; i++) {
        const b = bot.blockAt(feet.floored().offset(0, -i, 0))
        if (b && b.name !== 'air') { surf = b.position.y + 1; break }
      }
      if (surf === null) continue // unloaded: try the next candidate
      const cx = Math.round(feet.x)
      const cz = Math.round(feet.z)
      let free = true
      for (let dx = -1; dx <= 1 && free; dx++) {
        for (let dz = -1; dz <= 1 && free; dz++) {
          for (let dy = 0; dy <= 1 && free; dy++) {
            const b = bot.blockAt(feet.floored().offset(cx - Math.round(feet.x) + dx, surf - Math.round(feet.y) + dy, cz - Math.round(feet.z) + dz))
            if (b === null || (b.name !== 'air')) free = false
          }
        }
      }
      if (!free) continue // someone's blocks: keep off
      site = { cx, cz, surf }
      break
    }
    if (!site) throw new Error('setup invalid: no free pad near spawn')
    const { cx, cz, surf } = site
    // 3x3 dirt pad (clean slate under the table + furnace) + table.
    await rcon(`fill ${cx - 1} ${surf - 1} ${cz - 1} ${cx + 1} ${surf - 1} ${cz + 1} dirt`)
    await rcon(`setblock ${cx + 1} ${surf} ${cz} crafting_table`)
    await tpWait(bot, cx, surf + 1, cz)
    await sleep(1500)
    const { Vec3: V3 } = require('vec3')
    const tableBack = bot.blockAt(new V3(cx + 1, surf, cz))
    if (!tableBack || tableBack.name !== 'crafting_table') {
      throw new Error(`setup invalid: table did not land (read ${tableBack ? tableBack.name : 'NULL'})`)
    }
    await rcon(`give ${NAME} cobblestone 8`)
    await rcon(`give ${NAME} raw_iron 8`)
    await rcon(`give ${NAME} coal 6`)
    await sleep(1500)
    if (invCount(bot, 'cobblestone') < 8 || invCount(bot, 'raw_iron') < 8 || invCount(bot, 'coal') < 6) {
      throw new Error('setup invalid: /give did not land')
    }
    bot.pathfinder.setMovements(new Movements(bot))
    const ctx = { home: { table: { x: cx + 1, y: surf, z: cz } }, stepStatus: 'running', lastGoalKey: '' }
    const end = Date.now() + BUDGET_MS
    let lastPhase = ''
    for (;;) {
      try { furnace(bot, ctx) } catch (err) {
        throw new Error(`furnace threw: ${err && err.message ? err.message : err}`)
      }
      if (ctx.furnace && ctx.furnace.phase !== lastPhase) {
        lastPhase = ctx.furnace.phase
        console.log(`phase=${lastPhase} smelted=${ctx.furnace.smelted || 0}`)
      }
      if (ctx.stepStatus === 'done') break
      if (ctx.stepStatus && ctx.stepStatus.startsWith('failed:')) throw new Error(`step ${ctx.stepStatus}`)
      if (Date.now() > end) throw new Error('assay timed out (see phases above)')
      await sleep(1000)
    }
    // Verdicts.
    const spot = ctx.home && ctx.home.furnace
    if (!spot) throw new Error('no furnace claim')
    const { Vec3 } = require('vec3')
    const stood = bot.blockAt(new Vec3(spot.x, spot.y, spot.z))
    if (!stood || stood.name !== 'furnace') throw new Error('claimed furnace is not standing')
    if (!lines.some((l) => l === 'smelted 8 iron')) throw new Error('missing `smelted 8 iron` line')
    if (invCount(bot, 'iron_ingot') < 8) throw new Error('ingots never landed')
    if (invCount(bot, 'coal') < 4) throw new Error('reserve burned: coal below 4')
    console.log('PASS: furnace stands, 8 ore -> 8 ingots, reserve intact')
  } finally {
    try {
      if (site) await rcon(`fill ${site.cx - 1} ${site.surf} ${site.cz - 1} ${site.cx + 1} ${site.surf + 1} ${site.cz + 1} air`)
      await rcon(`clear ${NAME}`)
    } catch (_) { /* cleanup best-effort */ }
    console.log = origLog
    try { bot.quit() } catch (_) { /* quit best-effort */ }
  }
}

main().then(
  () => process.exit(0),
  (err) => { console.error(`FAIL: ${err && err.message ? err.message : err}`); process.exit(1) },
)
