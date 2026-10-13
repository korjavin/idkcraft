// idkcraft-neuc.10: lifecycle + event parity on the Baritone body.
// FakeTransport pushes each mod notification; the adapter must emit the
// exact mineflayer shapes bot/src/index.js wires, and the REAL runOnce +
// createLifecycle path must log death/respawn and resolve on a wanted end.
'use strict'

const { describe, it, afterEach } = require('node:test')
const assert = require('node:assert/strict')

const Vec3 = require('vec3')
const { BaritoneBot, createBot } = require('../src/bridge/index')
const { FakeTransport } = require('../src/bridge/transport')
const { runOnce } = require('../src/index')

const REGISTRY = { blocksByName: { air: { id: 0 } }, entitiesByName: {} }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
function once(emitter, name, ms = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${name}`)), ms)
    emitter.once(name, (...args) => { clearTimeout(timer); resolve(args) })
  })
}
async function quiet(fn) {
  const orig = console.log
  console.log = () => {}
  try { return await fn() } finally { console.log = orig }
}

async function lifeBot(state = {}) {
  const transport = new FakeTransport({
    pos: { x: 0, y: 64, z: 0, yaw: 0, pitch: 0, onGround: true, vel: { x: 0, y: 0, z: 0 } },
    entities: [
      { id: 7, uuid: 'u-zombie', type: 'zombie', kind: 'hostile', pos: { x: 2, y: 64, z: 0 }, vel: { x: 0, y: 0, z: 0 }, yaw: 0, pitch: 0, health: 20, onGround: true },
      { id: 9, uuid: 'u-item', type: 'item', kind: 'other', pos: { x: 1, y: 64, z: 0 }, vel: { x: 0, y: 0, z: 0 }, yaw: 0, pitch: 0, onGround: true },
    ],
    ...state,
  })
  const bot = new BaritoneBot(transport, { Vec3, registry: REGISTRY, username: 'IdkBody' })
  await bot.start({ pollMs: 0 })
  return { transport, bot }
}

describe('bridge lifecycle events (idkcraft-neuc.10)', () => {
  let bot
  afterEach(async () => { if (bot) await bot.stop(); bot = null })

  it('death/respawn/spawnReset emit with mineflayer no-arg shapes; death is isAlive-guarded', async () => {
    let transport
    ;({ transport, bot } = await lifeBot())
    const seen = []
    bot.on('death', (...a) => seen.push(['death', a.length]))
    bot.on('respawn', (...a) => seen.push(['respawn', a.length]))
    bot.on('spawnReset', (...a) => seen.push(['spawnReset', a.length]))
    transport.inject('death', {})
    transport.inject('death', {}) // duplicate while dead: mineflayer does not re-fire
    assert.equal(bot.isAlive, false)
    assert.equal(bot.health, 0)
    transport.inject('respawn', {})
    assert.equal(bot.isAlive, true)
    transport.inject('spawnReset', {})
    assert.deepEqual(seen, [['death', 0], ['respawn', 0], ['spawnReset', 0]])
  })

  it('health updates bot.health/food/foodSaturation before emitting (no args)', async () => {
    let transport
    ;({ transport, bot } = await lifeBot())
    let atEmit = null
    bot.on('health', (...a) => { atEmit = [bot.health, bot.food, bot.foodSaturation, a.length] })
    transport.inject('health', { health: 12, food: 9, saturation: 3.5 })
    assert.deepEqual(atEmit, [12, 9, 3.5, 0])
  })

  it('entityHurt/entityGone/playerCollect resolve wire ids to entity objects', async () => {
    let transport
    ;({ transport, bot } = await lifeBot())
    await bot.refresh() // entities fold in
    const zombie = bot.entities['7']
    const item = bot.entities['9']
    assert.ok(zombie && item)
    const seen = {}
    bot.on('entityHurt', (e) => { seen.hurt = e })
    bot.on('playerCollect', (collector, collected) => { seen.collect = [collector, collected] })
    bot.on('entityGone', (e) => { seen.gone = e })
    transport.inject('entityHurt', { id: 7 })
    assert.equal(seen.hurt, zombie)
    transport.inject('playerCollect', { collectorId: 7, itemId: 9 })
    assert.deepEqual(seen.collect, [zombie, item])
    transport.inject('entity.gone', { id: 9 })
    assert.equal(seen.gone, item)
    assert.equal(bot.entities['9'], undefined)
  })

  it('rain and time update state then emit with no args', async () => {
    let transport
    ;({ transport, bot } = await lifeBot())
    const seen = []
    bot.on('rain', () => seen.push(['rain', bot.isRaining]))
    bot.on('time', () => seen.push(['time', bot.time.age, bot.time.timeOfDay]))
    transport.inject('rain', { raining: true })
    transport.inject('time', { age: 48000, timeOfDay: 6000 })
    assert.deepEqual(seen, [['rain', true], ['time', 48000, 6000]])
  })

  it('kicked carries (reason, loggedIn); end fires once per disconnect', async () => {
    let transport
    ;({ transport, bot } = await lifeBot())
    const seen = []
    bot.on('kicked', (reason, loggedIn) => seen.push(['kicked', reason, loggedIn]))
    bot.on('end', (reason) => seen.push(['end', reason]))
    transport.inject('kicked', { reason: 'Kicked by an operator', loggedIn: true })
    transport.inject('end', { reason: 'Kicked by an operator' })
    transport.inject('end', { reason: 'Kicked by an operator' }) // transport close twin: dropped
    assert.deepEqual(seen, [['kicked', 'Kicked by an operator', true], ['end', 'Kicked by an operator']])
    await bot.refresh() // in world again: the latch re-arms
    transport.inject('end', { reason: 'second drop' })
    assert.deepEqual(seen.at(-1), ['end', 'second drop'])
  })

  it('physicsTick synthesises per poll round; move carries the old pos; >8 blocks is forcedMove', async () => {
    let transport
    ;({ transport, bot } = await lifeBot())
    const seen = []
    bot.on('physicsTick', () => seen.push('physicsTick'))
    bot.on('move', (old) => seen.push(['move', old.x, old.y, old.z]))
    bot.on('forcedMove', () => seen.push('forcedMove'))
    await bot.refresh() // no movement: physicsTick only
    assert.deepEqual(seen, ['physicsTick'])
    transport.state.pos = { ...transport.state.pos, x: 3 }
    await bot.refresh()
    assert.deepEqual(seen, ['physicsTick', ['move', 0, 64, 0], 'physicsTick'])
    transport.state.pos = { ...transport.state.pos, x: 30 }
    await bot.refresh()
    assert.deepEqual(seen.at(-3), ['move', 3, 64, 0])
    assert.equal(seen.at(-2), 'forcedMove')
    assert.equal(seen.at(-1), 'physicsTick')
  })

  it('respawn()/setAutoRespawn() cross the wire as respawn.now/respawn.set', async () => {
    let transport
    ;({ transport, bot } = await lifeBot())
    await bot.respawn()
    assert.equal(transport.state.respawnCalls, 1)
    await bot.setAutoRespawn(false)
    assert.equal(transport.state.respawnAuto, false)
  })
})

describe('runOnce on the bridge body (real createLifecycle)', () => {
  it('death → respawn logs through life.onDeath/onRespawn; a wanted end resolves runOnce', async () => {
    const transport = new FakeTransport()
    const lines = []
    const origLog = console.log
    const origErr = console.error
    console.log = (l) => { lines.push(String(l)) }
    console.error = () => {}
    try {
      const done = runOnce({
        host: 'x', port: 1, username: 'IdkBody', tickMs: 100, idleTickMs: 20,
        brain: { async decide() { return { action: 'idle' } } },
        leaveAfterMs: 400, followName: '',
        createBot: (opts) => createBot(opts, { transport, consoleSend: async () => true }),
        pingFn: async () => ({ players: { online: 0, sample: [] } }),
      })
      // Wait for the bridge spawn (handshake is async inside createBot).
      const deadline = Date.now() + 8000
      while (!lines.some((l) => l.startsWith('spawned as')) && Date.now() < deadline) await sleep(25)
      assert.ok(lines.some((l) => l.startsWith('spawned as IdkBody')), `lines: ${lines.slice(0, 12).join(' | ')}`)
      transport.state.health = 0
      transport.inject('death', {})
      transport.inject('respawn', {})
      await done // nobody-online leave: wantQuit → quit → end resolves
      assert.ok(lines.some((l) => l.startsWith('death health=0')), `lines: ${lines.join(' | ')}`)
      assert.ok(lines.some((l) => l.startsWith('respawn at')), `lines: ${lines.join(' | ')}`)
    } finally {
      console.log = origLog
      console.error = origErr
    }
  })
})
