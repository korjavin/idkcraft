'use strict'

// Manual e2e: gear forges from stock and hands over (not run by npm test).
// Against a running flat server (sh test/mc-up.sh): connect the assay bot,
// RCON-seed stock, tick the REAL gear behaviour in-process, and hand each
// owner piece over via the REAL stockpile step (chest placed by RCON).
// Leg 1 (self): stone kit + 3 ingots + 2 sticks -> iron_pickaxe in pack.
// Leg 2 (owner sword): + 2 ingots + stick -> forged, banked, given, NBT.
// Leg 3 (owner pick): + 3 ingots + 2 sticks -> forged, banked with the self
// twin surviving, haul cleared, ladder on diamond, chest NBT holds both.
// Exit 0/1; prints GEAR E2E PASS/FAIL.
const mineflayer = require('mineflayer')
const { pathfinder } = require('mineflayer-pathfinder')
const { execFile } = require('node:child_process')
const { promisify } = require('node:util')
const { waitFor, sleep } = require('./e2e-util')
const gear = require('../src/behaviours/gear')
const stockpile = require('../src/behaviours/stockpile')

const execFileAsync = promisify(execFile)

const MC_HOST = process.env.MC_HOST || 'localhost'
const MC_PORT = parseInt(process.env.MC_PORT || '25565', 10)
const MC_CONTAINER = process.env.MC_CONTAINER || 'idk-mc'
const NAME = `GearAssay${Math.floor(Math.random() * 10000)}`
const TICK_MS = parseInt(process.env.E2E_TICK_MS || '100', 10)
const CAP_TICKS = 150

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
  const hx = cx - 1
  await rcon(`setblock ${tx} ${surf} ${cz} crafting_table`)
  await rcon(`setblock ${hx} ${surf} ${cz} chest`)
  await rcon(`tp ${NAME} ${cx} ${surf} ${cz}`)
  await sleep(1500)
  const ctx = {
    home: { site: { x: cx, y: surf, z: cz }, built: true, table: { x: tx, y: surf, z: cz }, chest: { x: hx, y: surf, z: cz } },
    stepStatus: 'running',
    lastGoalKey: '',
  }

  async function seedStock(spec) {
    for (const [name, n] of spec) await rcon(`give ${NAME} ${name} ${n}`)
    for (let i = 0; i < 100; i++) {
      await sleep(100)
      if (spec.every(([name, n]) => count(bot, name) >= n)) return
    }
    throw new Error(`setup invalid: stock never synced (${JSON.stringify(spec)})`)
  }

  async function tickUntil(words, cap, check) {
    for (let t = 0; t < (cap || CAP_TICKS); t++) {
      ctx.stepStatus = 'running'
      try {
        gear(bot, ctx)
      } catch (err) {
        throw new Error(`${words} tick threw: ${err && err.message}`)
      }
      if (check()) return t + 1
      await sleep(TICK_MS)
    }
    throw new Error(`${words} never satisfied in cap`)
  }

  async function bankUntilDone(words) {
    for (let t = 0; t < CAP_TICKS; t++) {
      ctx.stepStatus = 'running'
      try {
        stockpile(bot, ctx, null, {})
      } catch (err) {
        throw new Error(`${words} tick threw: ${err && err.message}`)
      }
      if (ctx.stepStatus === 'done' && !ctx.stockpileInFlight) {
        await sleep(500) // the async window op may still land
        if (ctx.stepStatus === 'done' && !ctx.stockpileInFlight) return t + 1
      }
      await sleep(TICK_MS)
    }
    throw new Error(`${words} never banked in cap`)
  }

  async function chestIds() {
    // Per-slot queries: a whole-Items dump truncates over RCON.
    const ids = []
    for (let slot = 0; slot < 4; slot++) {
      const out = await execFileAsync('docker', ['exec', MC_CONTAINER, 'rcon-cli', `data get block ${hx} ${surf} ${cz} Items[${slot}].id`])
      ids.push(String((out && out.stdout) || ''))
    }
    return ids.join('\n')
  }

  // Leg 1: stone kit + pick stock -> self iron pickaxe in the pack.
  await rcon(`clear ${NAME}`)
  await seedStock([['stone_pickaxe', 1], ['stone_sword', 1], ['iron_ingot', 3], ['stick', 2]])
  const leg1 = await tickUntil('leg 1', 0, () => count(bot, 'iron_pickaxe') >= 1)
  console.log(`leg 1 PASS: iron_pickaxe in ${leg1} ticks (stone kit kept: pick=${count(bot, 'stone_pickaxe')} sword=${count(bot, 'stone_sword')})`)

  // Leg 2: sword stock -> forged, then banked via the real stockpile step.
  await seedStock([['iron_ingot', 2], ['stick', 1]])
  const leg2 = await tickUntil('leg 2', 0, () => (ctx.haul && ctx.haul.iron_sword) === 1 && (ctx.gearFinished && ctx.gearFinished.iron_sword) === 1)
  console.log(`leg 2 PASS: iron_sword hauled+recorded in ${leg2} ticks`)
  const bank2 = await bankUntilDone('leg 2 bank')
  await sleep(1000) // ledger settles after the window closes
  if (count(bot, 'iron_sword') !== 0) throw new Error('leg 2 bank: sword must leave the pack')
  if ((ctx.gearGiven && ctx.gearGiven.iron_sword) !== 1) throw new Error('leg 2 bank: sword never marked given')
  if ((ctx.haul && ctx.haul.iron_sword) !== 0) throw new Error('leg 2 bank: sword haul claim not cleared')
  if (!(await chestIds()).includes('iron_sword')) throw new Error('leg 2 bank: chest NBT missing the sword')
  console.log(`leg 2 bank PASS in ${bank2} ticks: sword in chest, given, haul cleared`)

  // Leg 3: pick stock -> forged (self twin already held), then banked with
  // the twin surviving. Proves the round-2 double-spend fix live.
  await seedStock([['iron_ingot', 3], ['stick', 2]])
  const leg3 = await tickUntil('leg 3', 0, () => (ctx.haul && ctx.haul.iron_pickaxe) === 1 && (ctx.gearFinished && ctx.gearFinished.iron_pickaxe) === 1)
  if (count(bot, 'iron_pickaxe') !== 2) throw new Error(`leg 3: self+owner picks expected, have ${count(bot, 'iron_pickaxe')}`)
  console.log(`leg 3 PASS: owner iron_pickaxe hauled+recorded in ${leg3} ticks (pack holds 2)`)
  const bank3 = await bankUntilDone('leg 3 bank')
  await sleep(1000)
  if (count(bot, 'iron_pickaxe') !== 1) throw new Error(`leg 3 bank: self pick must survive, pack holds ${count(bot, 'iron_pickaxe')}`)
  if ((ctx.gearGiven && ctx.gearGiven.iron_pickaxe) !== 1) throw new Error('leg 3 bank: pick never marked given')
  if ((ctx.haul && ctx.haul.iron_pickaxe) !== 0) throw new Error('leg 3 bank: pick haul claim not cleared')
  if (gear.deriveNext(bot, ctx).name !== 'diamond_pickaxe') throw new Error('leg 3 bank: ladder did not advance to diamond')
  const nbt = await chestIds()
  if (!nbt.includes('iron_pickaxe') || !nbt.includes('iron_sword')) throw new Error(`leg 3 bank: chest NBT missing pieces: ${nbt.slice(0, 200)}`)
  console.log(`leg 3 bank PASS in ${bank3} ticks: twin survives, ledger settled, haul cleared, chest holds sword+pick, ladder on diamond`)
  console.log(`GEAR E2E PASS: self pick ${leg1}t, sword ${leg2}t+bank, owner pick ${leg3}t+bank`)
  bot.quit()
  process.exit(0)
}

main().catch((err) => {
  console.error(`GEAR E2E FAIL: ${err && err.message ? err.message : err}`)
  process.exit(1)
})
