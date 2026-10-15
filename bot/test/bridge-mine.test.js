// idkcraft-neuc.53: bridge mine — bot.mine over FakeTransport (verb sent,
// settings pinned, event->resolve, noPath/stall/leash rejects, #stop on a
// tripped watch). Run: `cd bot && npm test`.
'use strict'

const { describe, it, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const Vec3 = require('vec3')

const { BaritoneBot } = require('../src/bridge/index')
const { FakeTransport } = require('../src/bridge/transport')

const registry = require('minecraft-data')('26.1.2')

function mineBot(state) {
  const transport = new FakeTransport({
    pos: { x: 0, y: 64, z: 0, yaw: 0, pitch: 0, onGround: true },
    inventory: [],
    blocks: {},
    ...state,
  })
  const bot = new BaritoneBot(transport, { Vec3, registry, username: 'IdkBody' })
  return { transport, bot }
}

describe('bridge mine (idkcraft-neuc.53)', () => {
  let transport
  let bot
  afterEach(async () => { await bot.stop() })

  // The mine captures its start position on the way to the verb; move the
  // body only after the verb landed, or the start moves with it.
  async function untilMineSent() {
    for (let i = 0; i < 200 && !(transport.state.mineLog || []).length; i++) {
      await new Promise((r) => setTimeout(r, 5))
    }
    assert.ok((transport.state.mineLog || []).length, 'baritone.mine sent')
  }

  it('sends baritone.mine with blocks+count, pins the mine settings, resolves on the done event', async () => {
    ({ transport, bot } = mineBot({ inventory: [{ slot: 9, name: 'dirt', count: 2 }] }))
    await bot.start({ pollMs: 0 })
    const got = await bot.mine(['dirt'], 3, { radius: 12, tickMs: 5 })
    assert.equal(got.have, 5)
    assert.equal(transport.state.mineLog.length, 1)
    assert.deepEqual(transport.state.mineLog[0].blocks, ['dirt'])
    assert.equal(transport.state.mineLog[0].count, 3)
    const sets = transport.state.baritoneSets || []
    assert.ok(sets.some((c) => c === '#set mineScanDroppedItems true'), 'scan drops pinned')
    assert.ok(sets.some((c) => c === '#set legitMine false'), 'legit mine pinned')
    assert.ok(sets.some((c) => c === '#set mineGoalUpdateInterval 5'), 'goal interval pinned')
    assert.ok(sets.some((c) => c === '#set allowBreak true'), 'a mine digs even under a no-dig walk lease')
    assert.equal(bot._settings.allowBreak, 'true', 'the pin mirrors into the adapter diff')
    assert.ok(!(transport.state.digLog || []).length, 'no single digs on the mine path')
  })

  it('a mine that ends below target rejects mine-noPath', async () => {
    ({ transport, bot } = mineBot({ mineScript: 'noPath' }))
    await bot.start({ pollMs: 0 })
    await assert.rejects(bot.mine(['stone', 'cobblestone'], 4, { tickMs: 5 }), /mine-noPath/)
  })

  it('no gain for the stall budget rejects mine-stall and stops the process', async () => {
    ({ transport, bot } = mineBot({ mineScript: 'hang' }))
    await bot.start({ pollMs: 0 })
    await assert.rejects(bot.mine(['dirt'], 3, { stallMs: 40, tickMs: 5 }), /mine-stall/)
    assert.equal(transport.state.baritone, '#stop')
  })

  it('a body past the radius stops and rejects mine-leash', async () => {
    ({ transport, bot } = mineBot({ mineScript: 'hang' }))
    await bot.start({ pollMs: 0 })
    const p = bot.mine(['dirt'], 3, { radius: 2, stallMs: 5000, tickMs: 5 })
    await untilMineSent()
    transport.state.pos = { ...transport.state.pos, x: 50, z: 50 }
    await bot.refresh()
    await assert.rejects(p, /mine-leash/)
    assert.equal(transport.state.baritone, '#stop')
  })

  it('entering the forbid predicate stops and rejects mine-leash', async () => {
    ({ transport, bot } = mineBot({ mineScript: 'hang' }))
    await bot.start({ pollMs: 0 })
    const p = bot.mine(['dirt'], 3, { radius: 100, stallMs: 5000, tickMs: 5, forbid: (pos) => pos.x > 5 })
    await untilMineSent()
    transport.state.pos = { ...transport.state.pos, x: 6 }
    await bot.refresh()
    await assert.rejects(p, /mine-leash/)
    assert.equal(transport.state.baritone, '#stop')
  })

  it('starting inside forbid arms on exit: no instant reject, re-entry trips', async () => {
    ({ transport, bot } = mineBot({ mineScript: 'hang' }))
    await bot.start({ pollMs: 0 })
    transport.state.pos = { ...transport.state.pos, x: 6 }
    await bot.refresh()
    let settled = null
    const p = bot.mine(['dirt'], 3, { radius: 100, stallMs: 5000, tickMs: 5, forbid: (pos) => pos.x > 5 })
    p.then(() => { settled = 'resolved' }, () => { settled = 'rejected' })
    await new Promise((r) => setTimeout(r, 30))
    assert.equal(settled, null, 'no instant reject while starting inside')
    transport.state.pos = { ...transport.state.pos, x: 0 }
    await bot.refresh()
    await new Promise((r) => setTimeout(r, 30))
    assert.equal(settled, null, 'leaving arms the leash silently')
    transport.state.pos = { ...transport.state.pos, x: 6 }
    await bot.refresh()
    await assert.rejects(p, /mine-leash/)
  })

  it('a guard break ends mine-leash even at target', async () => {
    ({ transport, bot } = mineBot({ mineScript: 'guard' }))
    await bot.start({ pollMs: 0 })
    await assert.rejects(bot.mine(['stone'], 4, { tickMs: 5 }), /mine-leash/)
  })

  it('cancelMine stops the body and rejects mine-stopped; stop() cancels a live mine', async () => {
    ({ transport, bot } = mineBot({ mineScript: 'hang' }))
    await bot.start({ pollMs: 0 })
    const p = bot.mine(['dirt'], 3, { stallMs: 5000, tickMs: 5 })
    await untilMineSent()
    assert.equal(bot.cancelMine(), true, 'a live mine cancels')
    await assert.rejects(p, /mine-stopped/)
    assert.equal(transport.state.baritone, '#stop')
    assert.equal(bot.cancelMine(), false, 'nothing live: quiet')
  })

  it('pathfinder.stop() cancels a live mine instead of leaving it mining', async () => {
    ({ transport, bot } = mineBot({ mineScript: 'hang' }))
    await bot.start({ pollMs: 0 })
    const p = bot.mine(['dirt'], 3, { stallMs: 5000, tickMs: 5 })
    await untilMineSent()
    assert.equal(bot.pathfinder.isMoving(), true, 'a live mine reads as moving (stopOnce gate)')
    bot.pathfinder.stop()
    await assert.rejects(p, /mine-stopped/)
    assert.equal(transport.state.baritone, '#stop')
    assert.equal(bot.pathfinder.isMoving(), false, 'settled: idle again')
  })

  it('a cancel between the pre-verb awaits sends no verb and no watch', async () => {
    ({ transport, bot } = mineBot({ mineScript: 'hang' }))
    await bot.start({ pollMs: 0 })
    const p = bot.mine(['dirt'], 3, { stallMs: 5000, tickMs: 5 })
    bot.cancelMine()
    await assert.rejects(p, /mine-stopped/)
    await new Promise((r) => setTimeout(r, 30))
    assert.ok(!(transport.state.mineLog || []).length, 'baritone.mine never sent')
    assert.equal(transport.state.baritone, '#stop', 'only the cancel stop')
  })

  it('rejects empty names and non-positive counts without touching the wire', async () => {
    ({ transport, bot } = mineBot({}))
    await bot.start({ pollMs: 0 })
    await assert.rejects(bot.mine([], 3), /non-empty names/)
    await assert.rejects(bot.mine(['dirt'], 0), /positive count/)
    assert.ok(!(transport.state.mineLog || []).length)
  })
})
