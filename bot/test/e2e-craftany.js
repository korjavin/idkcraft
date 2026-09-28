'use strict'

// Manual e2e: craft-to-bring on a live flat server (not run by npm test).
// Against a running rig (MC_CONTAINER, default idk-rig-m9 on MC_PORT 25579):
// connect the assay bot, RCON-seed stock, run the REAL chat->setBring->
// bring path in-process against REAL recipesAll/bot.craft, and assert.
// Leg 1 (axe): cobble x3 + stick x2 + home table -> 'making you a
// stone_axe' -> craft -> return -> toss, 'here is 1 stone_axe'.
// Leg 2 (shears): empty pack -> one honest 'can't make shears: need 2
// iron_ingot (have 0)', no order opened.
// Leg 3 (torch): coal + stick, no table -> 2x2 craft -> 'here are 3 torch'.
// Exit 0/1; prints CRAFTANY E2E PASS/FAIL.
const mineflayer = require('mineflayer')
const { pathfinder } = require('mineflayer-pathfinder')
const { execFile } = require('node:child_process')
const { promisify } = require('node:util')
const { waitFor, sleep } = require('./e2e-util')
const bring = require('../src/behaviours/bring')
const { handleChat, createTicker } = require('../src/index')

const execFileAsync = promisify(execFile)

const MC_HOST = process.env.MC_HOST || 'localhost'
const MC_PORT = parseInt(process.env.MC_PORT || '25579', 10)
const MC_CONTAINER = process.env.MC_CONTAINER || 'idk-rig-m9'
const NAME = `CraftAssay${Math.floor(Math.random() * 10000)}`
const TICK_MS = 200
const CAP_TICKS = 300

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
  const lines = []
  const bot = mineflayer.createBot({ host: MC_HOST, port: MC_PORT, username: NAME, auth: 'offline' })
  bot.loadPlugin(pathfinder)
  await waitFor(bot, 'spawn', 60000, 'assay spawn')
  const say = bot.chat ? bot.chat.bind(bot) : null
  bot.chat = (line) => { lines.push(String(line)); try { if (say) say(line) } catch (_) { /* record-only */ } }
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

  const ticker = createTicker({
    bot,
    brain: { decide: async () => ({ action: 'idle', sprint: false, source: 'stub' }) },
    tickMs: 10,
    idleTickMs: 10,
  })
  const ctx = bot._tickerCtx
  ctx.home = { site: { x: cx, y: surf, z: cz }, built: true, table: { x: tx, y: surf, z: cz } }
  bot.players.P = { username: 'P', entity: { position: bot.entity.position } }

  async function seedStock(spec) {
    for (const [name, n] of spec) await rcon(`give ${NAME} ${name} ${n}`)
    for (let i = 0; i < 100; i++) {
      await sleep(100)
      if (spec.every(([name, n]) => count(bot, name) >= n)) return
    }
    throw new Error(`setup invalid: stock never synced (${JSON.stringify(spec)})`)
  }

  async function clearPack() {
    await rcon(`clear ${NAME}`)
    await rcon('kill @e[type=item]')
    for (let i = 0; i < 100; i++) {
      await sleep(100)
      if (bot.inventory.items().length === 0) return
    }
    throw new Error('setup invalid: pack never emptied')
  }

  async function tickUntilDone(words) {
    for (let t = 0; t < CAP_TICKS; t++) {
      bot.players.P.entity.position = bot.entity.position
      await bring(bot, ctx, null, {})
      if (!ctx.bring) return t + 1
      await sleep(TICK_MS)
    }
    throw new Error(`${words} order never completed in cap`)
  }

  // Leg 1: axe from mats at the home table.
  await seedStock([['cobblestone', 3], ['stick', 2]])
  handleChat(bot, ticker, 'P', 'bring me axe')
  if (!lines.includes('making you a stone_axe')) {
    throw new Error(`leg 1: missing making line, got ${JSON.stringify(lines)}`)
  }
  await tickUntilDone('leg 1')
  if (!lines.includes('here is 1 stone_axe')) {
    throw new Error(`leg 1: missing tossed line, got ${JSON.stringify(lines)}`)
  }
  if (count(bot, 'stone_axe') !== 0) throw new Error('leg 1: axe still in pack after toss')
  console.log('leg 1 ok: axe crafted and tossed')

  // Leg 2: shears with no iron is one honest line.
  await clearPack()
  lines.length = 0
  handleChat(bot, ticker, 'P', 'bring me shears')
  if (ctx.bring) throw new Error('leg 2: order opened without mats')
  if (lines.length !== 1 || lines[0] !== "can't make shears: need 2 iron_ingot (have 0)") {
    throw new Error(`leg 2: wrong refusal, got ${JSON.stringify(lines)}`)
  }
  console.log('leg 2 ok: honest shears refusal')

  // Leg 3: torch crafts 2x2 with no table claim.
  ctx.home.table = null
  await seedStock([['coal', 1], ['stick', 1]])
  lines.length = 0
  handleChat(bot, ticker, 'P', 'bring me torch')
  if (!lines.includes('making you a torch')) {
    throw new Error(`leg 3: missing making line, got ${JSON.stringify(lines)}`)
  }
  await tickUntilDone('leg 3')
  if (!lines.includes('here are 3 torch')) {
    throw new Error(`leg 3: missing tossed line, got ${JSON.stringify(lines)}`)
  }
  console.log('leg 3 ok: torch crafted 2x2 and tossed')

  console.log('CRAFTANY E2E PASS')
}

main().then(
  () => process.exit(0),
  (err) => { console.error(`CRAFTANY E2E FAIL: ${err && err.message ? err.message : err}`); process.exit(1) },
)
