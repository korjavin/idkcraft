'use strict'

// Manual e2e check (not run by npm test): against a running server
// (see mc-up.sh), spawn a FakePlayer, walk it ~10 blocks away, and assert
// IdkBot's distance to it drops below 4 blocks within 30 s. Exit 0/1.
const mineflayer = require('mineflayer')
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder')

const MC_HOST = process.env.MC_HOST || 'localhost'
const MC_PORT = parseInt(process.env.MC_PORT || '25565', 10)
const BOT_USERNAME = process.env.BOT_USERNAME || 'IdkBot'
const FAKE_NAME = `FakePlayer${Math.floor(Math.random() * 10000)}`

const fake = mineflayer.createBot({ host: MC_HOST, port: MC_PORT, username: FAKE_NAME, auth: 'offline' })
fake.loadPlugin(pathfinder)

function waitFor(emitter, event, timeoutMs, what) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${what}`)), timeoutMs)
    emitter.once(event, (...args) => { clearTimeout(timer); resolve(args) })
  })
}

function distanceToIdkBot() {
  const idk = fake.players[BOT_USERNAME] && fake.players[BOT_USERNAME].entity
  if (!idk) return null
  return fake.entity.position.distanceTo(idk.position)
}

async function main() {
  await waitFor(fake, 'spawn', 60000, 'fake spawn')
  console.log(`fake ${FAKE_NAME} spawned`)
  fake.pathfinder.setMovements(new Movements(fake))

  // Wait until IdkBot is visible to the fake player.
  const deadline = Date.now() + 60000
  while (distanceToIdkBot() === null) {
    if (Date.now() > deadline) throw new Error('IdkBot never appeared')
    await new Promise((r) => setTimeout(r, 1000))
  }
  console.log(`IdkBot spotted at dist=${distanceToIdkBot().toFixed(1)}`)

  // Wait for the world to load: paths computed on empty chunks fail and
  // never retry, which freezes both bots. Chunks are in when the block
  // below the feet is known.
  const chunkDeadline = Date.now() + 30000
  while (fake.blockAt(fake.entity.position.offset(0, -1, 0)) == null) {
    if (Date.now() > chunkDeadline) throw new Error('world never loaded for FakePlayer')
    await new Promise((r) => setTimeout(r, 1000))
  }
  console.log('world loaded, walking away')

  // Walk ~10 blocks away from spawn.
  const p = fake.entity.position
  const walkStart = p.clone()
  const goal = new goals.GoalNear(p.x + 10, p.y, p.z + 10, 2)
  fake.pathfinder.setGoal(goal)
  try {
    await waitFor(fake, 'goal_reached', 30000, 'walk away')
  } catch {
    console.log('walk-away goal not fully reached, continuing anyway')
  }
  fake.pathfinder.stop()
  const awayDist = distanceToIdkBot()
  console.log(`after walk-away dist=${awayDist !== null ? awayDist.toFixed(1) : 'unknown'}`)
  const walked = walkStart.distanceTo(fake.entity.position)
  if (walked < 6) throw new Error(`setup invalid: FakePlayer only walked ${walked.toFixed(1)} blocks`)

  // IdkBot (stub brain: follow when > 3) should close to < 4 within 30 s.
  const end = Date.now() + 30000
  for (;;) {
    const d = distanceToIdkBot()
    if (d !== null) {
      console.log(`dist=${d.toFixed(1)}`)
      if (d < 4) {
        console.log('PASS: IdkBot followed within 4 blocks')
        process.exit(0)
      }
    }
    if (Date.now() > end) {
      console.error('FAIL: IdkBot did not get within 4 blocks in 30 s')
      process.exit(1)
    }
    await new Promise((r) => setTimeout(r, 1000))
  }
}

main().catch((err) => {
  console.error(`FAIL: ${err && err.message ? err.message : err}`)
  process.exit(1)
})
