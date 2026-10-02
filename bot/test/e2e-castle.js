'use strict'

// Manual e2e castle check (not run by npm test; idkcraft-g0z.2): against a
// running flat Paper server (sh test/mc-up.sh), a bot drives the castle
// behaviour on its own 1 s loop and lays the slice tower on real physics.
// Mid-build the bot quits and a fresh session resumes from the world
// (restart resume). Pass = every plan place-cell matches, phase complete,
// no blocked cells. Order/arbiter wiring (dusk return) is g0z.3.
//   MC_HOST=localhost MC_PORT=25565 MC_CONTAINER=idk-mc node test/e2e-castle.js
const mineflayer = require('mineflayer')
const { pathfinder, Movements } = require('mineflayer-pathfinder')
const { execFile } = require('node:child_process')
const { promisify } = require('node:util')
const { waitFor, sleep } = require('./e2e-util')
const blueprint = require('../src/castle')
const castle = require('../src/behaviours/castle')

const execFileAsync = promisify(execFile)
const MC_HOST = process.env.MC_HOST || 'localhost'
const MC_PORT = parseInt(process.env.MC_PORT || '25565', 10)
const MC_CONTAINER = process.env.MC_CONTAINER || 'idk-mc'
const NAME = `Castle${Math.floor(Math.random() * 10000)}`
const RESTART_AT = 60 // laid cells before the simulated restart
const DEADLINE_MS = 30 * 60 * 1000

async function rcon(cmd) {
  const { stdout } = await execFileAsync('docker', ['exec', MC_CONTAINER, 'rcon-cli', cmd])
  return stdout.trim()
}

async function session(state, stopAt, onSpawn) {
  const bot = mineflayer.createBot({ host: MC_HOST, port: MC_PORT, username: NAME, auth: 'offline' })
  bot.loadPlugin(pathfinder)
  await waitFor(bot, 'spawn', 60000, 'bot spawn')
  bot.pathfinder.setMovements(new Movements(bot))
  if (onSpawn) await onSpawn()
  await sleep(2000)
  const ctx = { castle: state }
  const end = Date.now() + DEADLINE_MS
  let lastLog = ''
  try {
    for (;;) {
      castle(bot, ctx)
      const line = `${state.progress ? state.progress.done + '/' + state.progress.total : '?'} ${state.status} ${ctx.stepStatus || ''}`
      if (line !== lastLog) { console.log(line); lastLog = line }
      if (process.env.E2E_VERBOSE) {
        const bp = bot.entity.position
        console.log(`  tick idx=${ctx.castleGoalIdx} moving=${bot.pathfinder.isMoving()} pos=${bp.x.toFixed(1)},${bp.y.toFixed(1)},${bp.z.toFixed(1)} ` +
          `fails=${JSON.stringify(ctx.castleFails)} far=${JSON.stringify(ctx.castleFar)} flight=${ctx.castleFlight ? ctx.castleFlight.kind : '-'}`)
      }
      if (ctx.stepStatus === 'done') return 'done'
      if (stopAt && state.progress && state.progress.done >= stopAt) return 'stopped'
      if (Date.now() > end) return 'timeout'
      await sleep(1000)
    }
  } finally {
    bot.quit()
    await sleep(5000) // past Paper's same-IP connection throttle
  }
}

async function main() {
  await rcon('difficulty peaceful')
  await rcon('time set day')
  await rcon('gamerule doDaylightCycle false')
  // Flat world surface: grass at y=-61, feet y=-60 on 1.18+ superflat.
  const site = { x: 40, y: parseInt(process.env.SITE_Y || '-60', 10), z: 40 }
  const { w, d } = blueprint.siteDimensions(0)
  await rcon(`fill ${site.x - 3} ${site.y} ${site.z - 3} ${site.x + w + 2} ${site.y + 16} ${site.z + d + 2} air`)
  await rcon(`fill ${site.x - 3} ${site.y - 1} ${site.z - 3} ${site.x + w + 2} ${site.y - 1} ${site.z + d + 2} grass_block`)
  const state = { site, rot: 0 }
  const kit = async () => {
    await rcon(`clear ${NAME}`)
    for (const [item, n] of [['cobblestone', 64], ['cobblestone', 64], ['cobblestone', 64], ['cobblestone', 64], ['oak_planks', 64], ['oak_door', 1], ['torch', 8]]) {
      await rcon(`give ${NAME} ${item} ${n}`)
    }
    await rcon(`tp ${NAME} ${site.x + 5} ${site.y} ${site.z - 2}`)
  }
  const first = await session(state, RESTART_AT, kit)
  console.log(`session 1: ${first}`)
  if (first !== 'stopped') throw new Error(`session 1 ended ${first}`)
  // Restart: a fresh process state keeps only site/rot/blocked (persisted).
  const resumed = { site: state.site, rot: state.rot, blocked: state.blocked }
  const second = await session(resumed, 0)
  console.log(`session 2: ${second}`)
  if (second !== 'done') throw new Error(`session 2 ended ${second}`)
  const blocked = Object.keys(resumed.blocked || {})
  if (blocked.length) throw new Error(`blocked cells left: ${blocked.join(' ')}`)
  console.log(`PASS castle slice built: ${resumed.progress.done}/${resumed.progress.total}`)
  process.exit(0)
}

main().catch((e) => { console.error(`FAIL ${e && e.message ? e.message : e}`); process.exit(1) })
