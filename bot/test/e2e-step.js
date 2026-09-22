'use strict'

// Manual e2e step-up check (not run by npm test): against a running server
// (sh test/mc-up.sh), raise a 1-block stone plateau via RCON, walk the
// FakePlayer end to end on top, and assert IdkBot climbs up within 15 s —
// once from a cardinal start, once diagonal. Exit 0/1; prints IdkBot's y
// every second so a wedge (y hovering ~0.5 above ground) is visible.
const mineflayer = require('mineflayer')
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder')
const { execFile } = require('node:child_process')
const { promisify } = require('node:util')
const { waitFor, sleep } = require('./e2e-util')

const execFileAsync = promisify(execFile)

const MC_HOST = process.env.MC_HOST || 'localhost'
const MC_PORT = parseInt(process.env.MC_PORT || '25565', 10)
const BOT_USERNAME = process.env.BOT_USERNAME || 'IdkBot'
const FAKE_NAME = `StepFake${Math.floor(Math.random() * 10000)}`
const MC_CONTAINER = process.env.MC_CONTAINER || 'idk-mc' // --name in mc-up.sh
const RUN_MS = 15000

const fake = mineflayer.createBot({ host: MC_HOST, port: MC_PORT, username: FAKE_NAME, auth: 'offline' })
fake.loadPlugin(pathfinder)

// Server commands go over RCON (docker exec): chat-sent commands fail — the
// OPS-seeded ops.json UUID does not match offline-mode logins, so the server
// hides every command from the FakePlayer ("Unknown or incomplete command").
async function rcon(cmd) {
  await execFileAsync('docker', ['exec', MC_CONTAINER, 'rcon-cli', cmd])
}

function botPos() {
  const e = fake.players[BOT_USERNAME] && fake.players[BOT_USERNAME].entity
  return e ? e.position : null
}

async function attempt(name, bx, bz, surf, top) {
  await rcon(`tp ${BOT_USERNAME} ${bx} ${surf} ${bz}`)
  await sleep(1500)
  let consec = 0
  const end = Date.now() + RUN_MS
  for (;;) {
    const p = botPos()
    console.log(`${name} y=${p ? p.y.toFixed(2) : 'unknown'}`)
    if (p && p.y >= top - 0.2) {
      if (++consec >= 2) { console.log(`PASS: ${name} IdkBot on the plateau`); return true }
    } else consec = 0
    if (Date.now() > end) { console.error(`FAIL: ${name} IdkBot never climbed (see y above)`); return false }
    await sleep(1000)
  }
}

async function main() {
  await waitFor(fake, 'spawn', 60000, 'fake spawn')
  const chunkDeadline = Date.now() + 30000
  while (fake.blockAt(fake.entity.position.offset(0, -1, 0)) == null) {
    if (Date.now() > chunkDeadline) throw new Error('world never loaded for FakePlayer')
    await sleep(1000)
  }
  const botDeadline = Date.now() + 60000
  while (botPos() === null) {
    if (Date.now() > botDeadline) throw new Error('IdkBot never appeared (start it: MC_HOST=localhost node src/index.js)')
    await sleep(1000)
  }
  await rcon('difficulty peaceful') // flat spawns slimes that kill both bots mid-run
  // Ground surface under the fake (flat world: top solid block + 1).
  const feet = fake.entity.position
  let surf = null
  for (let i = 1; i <= 8; i++) {
    const b = fake.blockAt(feet.floored().offset(0, -i, 0))
    if (b && b.name !== 'air') { surf = b.position.y + 1; break }
  }
  if (surf === null) throw new Error('setup invalid: no ground under FakePlayer')
  // 7x7 1-block plateau centred on the fake; wide enough that the bot cannot
  // satisfy GoalFollow (range 3) from the ground — 3D dist stays above 3.
  const cx = Math.round(feet.x)
  const cz = Math.round(feet.z)
  await rcon(`fill ${cx - 3} ${surf} ${cz - 3} ${cx + 3} ${surf} ${cz + 3} stone`)
  const probe = feet.floored()
  const capEnd = Date.now() + 8000 // fill + block-change packets round trip
  let cap = null
  while (!cap || cap.name !== 'stone') {
    if (Date.now() > capEnd) throw new Error(`setup invalid: plateau not stone (is ${MC_CONTAINER} up with RCON? see mc-up.sh)`)
    await sleep(500)
    cap = fake.blockAt(probe.offset(cx - probe.x, surf - probe.y, cz - probe.z))
  }
  const top = surf + 1
  await rcon(`tp ${FAKE_NAME} ${cx} ${top} ${cz}`)
  await sleep(1000)
  if (fake.entity.position.y < top - 1) throw new Error('setup invalid: FakePlayer not on the plateau')
  // Walk the top end to end: continuous motion keeps the stub on follow (the
  // behaviour under test) — a standing player would read as roam and the bot
  // would stroll instead of climbing. The 8 s fallback flips a failed leg.
  fake.pathfinder.setMovements(new Movements(fake))
  let toB = true
  const legs = () => {
    toB = !toB
    const t = toB ? { x: cx + 2, y: top, z: cz } : { x: cx - 2, y: top, z: cz }
    fake.pathfinder.setGoal(new goals.GoalNear(t.x, t.y, t.z, 1))
  }
  fake.on('goal_reached', legs)
  const walkFallback = setInterval(legs, 8000)
  legs()
  const ok1 = await attempt('cardinal', cx, cz + 7, surf, top)
  const ok2 = await attempt('diagonal', cx + 5, cz + 5, surf, top)
  clearInterval(walkFallback)
  await rcon(`fill ${cx - 3} ${surf} ${cz - 3} ${cx + 3} ${surf} ${cz + 3} air`)
  if (ok1 && ok2) { console.log('PASS: IdkBot climbed the 1-block step (cardinal + diagonal)'); process.exit(0) }
  process.exit(1)
}

main().catch((err) => {
  console.error(`FAIL: ${err && err.message ? err.message : err}`)
  process.exit(1)
})
