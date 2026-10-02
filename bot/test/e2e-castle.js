'use strict'

// Manual e2e castle check (not run by npm test; idkcraft-g0z.2): against a
// running flat Paper server (sh test/mc-up.sh), a bot drives the castle
// behaviour on its own 1 s loop and lays the slice tower on real physics.
// Mid-build the bot quits and a fresh session resumes from the world
// (restart resume). Pass = every plan place-cell matches, phase complete,
// no blocked cells. Order/arbiter wiring (dusk return) is g0z.3.
//   MC_HOST=localhost MC_PORT=25565 MC_CONTAINER=idk-mc node test/e2e-castle.js
const mineflayer = require('mineflayer')
const { Vec3 } = require('vec3')
const { pathfinder, Movements } = require('mineflayer-pathfinder')
const { execFile } = require('node:child_process')
const { promisify } = require('node:util')
const { waitFor, sleep } = require('./e2e-util')
const blueprint = require('../src/castle')
const castle = require('../src/behaviours/castle')
const { trackPlaced } = require('../src/behaviours/util')
const unpin = require('../src/unpin')
const decontact = require('../src/decontact')
const { addSwimExits, addSwimPrune } = require('../src/swim')
const { addNoCornerCut } = require('../src/nocorner')
const { addSnowGround } = require('../src/snow')
const { addJumpUpCost } = require('../src/jumpcost')

const execFileAsync = promisify(execFile)
const MC_HOST = process.env.MC_HOST || 'localhost'
const MC_PORT = parseInt(process.env.MC_PORT || '25565', 10)
const MC_CONTAINER = process.env.MC_CONTAINER || 'idk-mc'
const NAME = `Castle${Math.floor(Math.random() * 10000)}`
const RESTART_AT = 60 // laid cells before the simulated restart
const DEADLINE_MS = 120 * 60 * 1000

async function rcon(cmd) {
  const { stdout } = await execFileAsync('docker', ['exec', MC_CONTAINER, 'rcon-cli', cmd])
  return stdout.trim()
}

async function session(state, stopAt, onSpawn) {
  const bot = mineflayer.createBot({ host: MC_HOST, port: MC_PORT, username: NAME, auth: 'offline' })
  bot.loadPlugin(pathfinder)
  await waitFor(bot, 'spawn', 60000, 'bot spawn')
  // The prod Movements stack (index.js setMovements): plain Movements
  // corner-cuts the doorway diagonal and wedges on the wall.
  const m = new Movements(bot)
  addSwimExits(m); addSwimPrune(m); addNoCornerCut(m); addSnowGround(m); addJumpUpCost(m)
  bot.pathfinder.setMovements(m)
  if (process.env.E2E_VERBOSE) {
    const at = (m) => (m ? `${m.x},${m.y},${m.z}${m.toBreak && m.toBreak.length ? ' brk' + m.toBreak.length : ''}${m.toPlace && m.toPlace.length ? ' plc' + m.toPlace.length : ''}` : '-')
    bot.on('path_update', (r) => { try { console.log(`  path ${r.status} len=${r.path.length} visited=${r.visitedNodes} ms=${Math.round(r.time)} next=${at(r.path[0])} end=${at(r.path[r.path.length - 1])}`) } catch (e) { console.log('  path log err', e.message) } })
    bot.on('path_reset', (why) => console.log(`  reset ${why}`))
  }
  if (onSpawn) await onSpawn()
  await sleep(2000)
  const ctx = { castle: state }
  trackPlaced(bot, ctx) // prod tracks every placement, incl. pathfinder scaffolds
  // Prod contact taps (index.js runOnce): without them a body touching a
  // stair-slab face exactly is pinned by Paper's move rejection (1cj/ik7)
  // and the F1->L1 jump wedges forever (rig, 6568016).
  unpin.installUnpinTap(bot, ctx)
  decontact.installFaceEpsilon(bot)
  const end = Date.now() + DEADLINE_MS
  let lastLog = ''
  try {
    for (;;) {
      try { unpin.unpinTick(bot, ctx, Date.now()) } catch (_) { /* best-effort, like the ticker */ }
      castle(bot, ctx)
      const line = `${state.progress ? state.progress.done + '/' + state.progress.total : '?'} ${state.status} ${ctx.stepStatus || ''}`
      if (line !== lastLog) { console.log(line); lastLog = line }
      if (process.env.E2E_VERBOSE) {
        const bp = bot.entity.position
        console.log(`  tick idx=${ctx.castleGoalIdx} moving=${bot.pathfinder.isMoving()} pos=${bp.x.toFixed(1)},${bp.y.toFixed(1)},${bp.z.toFixed(1)} ` +
          `fails=${JSON.stringify(ctx.castleFails)} far=${JSON.stringify(ctx.castleFar)} flight=${ctx.castleFlight ? ctx.castleFlight.kind : '-'}`)
      }
      if (ctx.stepStatus === 'done') {
        const bp = bot.entity.position
        const t = blueprint.TOWER
        const inside = bp.x >= state.site.x + t.x0 && bp.x < state.site.x + t.x0 + t.size &&
          bp.z >= state.site.z + t.z0 && bp.z < state.site.z + t.z0 + t.size
        console.log(`finished at ${bp.x.toFixed(1)},${bp.y.toFixed(1)},${bp.z.toFixed(1)} ${inside ? 'INSIDE' : 'outside'} the tower`)
        // g0z.14: no own scaffold left in the site box off the plan.
        const { w, d } = blueprint.siteDimensions(state.rot | 0, state.blueprintVersion)
        const at = blueprint.absPlan(state.site, state.rot, state.blueprintVersion).at
        const litter = []
        for (let dy = 0; dy <= 16; dy++) {
          for (let dx = 0; dx < w; dx++) {
            for (let dz = 0; dz < d; dz++) {
              const p = new Vec3(state.site.x + dx, state.site.y + dy, state.site.z + dz)
              const b = bot.blockAt(p)
              if (b && b.name === 'cobblestone' && !at.has(`${p.x},${p.y},${p.z}`)) litter.push(`${p.x},${p.y},${p.z}`)
            }
          }
        }
        console.log(`off-plan cobblestone in the site box: ${litter.length}${litter.length ? ' ' + litter.join(' ') : ''}`)
        if (litter.length) return 'litter'
        return inside ? 'sealed-inside' : 'done'
      }
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
  const state = { site, rot: 0 }
  const kit = async () => {
    await rcon(`clear ${NAME}`)
    for (const [item, n] of [['cobblestone', 64], ['cobblestone', 64], ['cobblestone', 64], ['cobblestone', 64], ['oak_planks', 64], ['oak_door', 1], ['torch', 8]]) {
      await rcon(`give ${NAME} ${item} ${n}`)
    }
    await rcon(`tp ${NAME} ${site.x + 5} ${site.y} ${site.z - 2}`)
    // Clear the site once the bot's chunks are loaded (a fill into unloaded
    // chunks fails, and flat worldgen can drop a village on the site).
    await sleep(3000)
    const out = [
      await rcon(`fill ${site.x - 3} ${site.y} ${site.z - 3} ${site.x + w + 2} ${site.y + 16} ${site.z + d + 2} air`),
      await rcon(`fill ${site.x - 3} ${site.y - 1} ${site.z - 3} ${site.x + w + 2} ${site.y - 1} ${site.z + d + 2} grass_block`),
    ]
    console.log(`site fill: ${out.join(' | ')}`)
    if (out.some((o) => /not loaded|error|Unknown/i.test(o))) throw new Error('site fill failed')
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
