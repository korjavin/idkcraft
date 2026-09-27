'use strict'

// Manual e2e: gear forges from stock (not run by npm test). Against a running
// flat server (sh test/mc-up.sh): connect the assay bot, RCON-seed stock,
// tick the REAL gear behaviour in-process, assert forged + handed.
// Leg 1 (self): stone kit + 3 ingots + 2 sticks -> iron_pickaxe in the pack.
// Leg 2 (owner): + 2 ingots + stick -> iron_sword forged, hauled, recorded.
// Exit 0/1; prints GEAR E2E PASS/FAIL.
const mineflayer = require('mineflayer')
const { pathfinder } = require('mineflayer-pathfinder')
const { execFile } = require('node:child_process')
const { promisify } = require('node:util')
const { waitFor, sleep } = require('./e2e-util')
const gear = require('../src/behaviours/gear')

const execFileAsync = promisify(execFile)

const MC_HOST = process.env.MC_HOST || 'localhost'
const MC_PORT = parseInt(process.env.MC_PORT || '25565', 10)
const MC_CONTAINER = process.env.MC_CONTAINER || 'idk-mc'
const NAME = `GearAssay${Math.floor(Math.random() * 10000)}`
const TICK_MS = 100
const CAP_TICKS = 150 // 15 s per leg: craft round-trips, no walking

async function rcon(cmd) {
  await execFileAsync('docker', ['exec', MC_CONTAINER, 'rcon-cli', cmd])
}

function count(bot, name) {
  let n = 0
  try {
    for (const i of bot.inventory.items()) {
      if (i && i.name === name) n += typeof i.count === 'number' ? i.count : 1
    }
  } catch (_) { /* unreadable: 0 */ }
  return n
}

async function main() {
  const bot = mineflayer.createBot({ host: MC_HOST, port: MC_PORT, username: NAME, auth: 'offline' })
  bot.loadPlugin(pathfinder)
  await waitFor(bot, 'spawn', 60000, 'assay spawn')
  await rcon('difficulty peaceful') // flat spawns slimes that knock bots mid-run
  const chunkDeadline = Date.now() + 30000
  while (bot.blockAt(bot.entity.position.floored().offset(0, -1, 0)) == null) {
    if (Date.now() > chunkDeadline) throw new Error('setup invalid: spawn chunk never loaded')
    await sleep(1000)
  }
  const feet = bot.entity.position
  let surf = null
  for (let i = 1; i <= 8; i++) {
    const b = bot.blockAt(feet.floored().offset(0, -i, 0))
    if (b && b.name !== 'air') { surf = b.position.y + 1; break }
  }
  if (surf === null) throw new Error('setup invalid: no ground under assay bot')
  const cx = Math.round(feet.x)
  const cz = Math.round(feet.z)
  const tx = cx + 1
  await rcon(`setblock ${tx} ${surf} ${cz} crafting_table`)
  await rcon(`tp ${NAME} ${cx} ${surf} ${cz}`)
  await sleep(1500)
  const ctx = { home: { site: { x: cx, y: surf, z: cz }, built: true, table: { x: tx, y: surf, z: cz } }, stepStatus: 'running' }

  // Leg 1: stone kit + pick stock -> self iron pickaxe in the pack.
  await rcon(`clear ${NAME}`)
  await rcon(`give ${NAME} stone_pickaxe 1`)
  await rcon(`give ${NAME} stone_sword 1`)
  await rcon(`give ${NAME} iron_ingot 3`)
  await rcon(`give ${NAME} stick 2`)
  let synced = false
  for (let i = 0; i < 100 && !synced; i++) {
    await sleep(100)
    synced = count(bot, 'iron_ingot') === 3 && count(bot, 'stick') === 2
  }
  if (!synced) throw new Error('setup invalid: leg-1 stock never synced')
  let leg1 = -1
  for (let t = 0; t < CAP_TICKS; t++) {
    ctx.stepStatus = 'running'
    try {
      gear(bot, ctx)
    } catch (err) {
      throw new Error(`leg 1 tick threw: ${err && err.message}`)
    }
    if (count(bot, 'iron_pickaxe') >= 1) { leg1 = t + 1; break }
    await sleep(TICK_MS)
  }
  if (leg1 < 0) throw new Error('leg 1: no iron_pickaxe forged from stock in cap')
  console.log(`leg 1 PASS: iron_pickaxe in ${leg1} ticks (stone kit kept: pick=${count(bot, 'stone_pickaxe')} sword=${count(bot, 'stone_sword')})`)

  // Leg 2: sword stock -> owner sword forged, hauled, finished-recorded.
  await rcon(`give ${NAME} iron_ingot 2`)
  await rcon(`give ${NAME} stick 1`)
  synced = false
  for (let i = 0; i < 100 && !synced; i++) {
    await sleep(100)
    synced = count(bot, 'iron_ingot') >= 2 && count(bot, 'stick') >= 1
  }
  if (!synced) throw new Error('setup invalid: leg-2 stock never synced')
  let leg2 = -1
  for (let t = 0; t < CAP_TICKS; t++) {
    ctx.stepStatus = 'running'
    try {
      gear(bot, ctx)
    } catch (err) {
      throw new Error(`leg 2 tick threw: ${err && err.message}`)
    }
    if ((ctx.haul && ctx.haul.iron_sword) === 1 && (ctx.gearFinished && ctx.gearFinished.iron_sword) === 1) { leg2 = t + 1; break }
    await sleep(TICK_MS)
  }
  if (leg2 < 0) throw new Error('leg 2: iron_sword never hauled+recorded in cap')
  console.log(`leg 2 PASS: iron_sword hauled+recorded in ${leg2} ticks`)
  console.log(`GEAR E2E PASS: self pick ${leg1}t, owner sword ${leg2}t`)
  bot.quit()
  process.exit(0)
}

main().catch((err) => {
  console.error(`GEAR E2E FAIL: ${err && err.message ? err.message : err}`)
  process.exit(1)
})
