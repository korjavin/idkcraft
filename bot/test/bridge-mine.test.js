// idkcraft-neuc.53: bridge mine — bot.mine over FakeTransport (verb sent,
// settings pinned, event->resolve, noPath/stall/leash rejects, #stop on a
// tripped watch). Run: `cd bot && npm test`.
'use strict'

const { describe, it, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const Vec3 = require('vec3')

const { BaritoneBot } = require('../src/bridge/index')
const { FakeTransport } = require('../src/bridge/transport')
const { cacheReady } = require('../src/bridge/mine')

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
  // The stall/leash watch runs on an unref'd interval (prod: a background
  // watch must never hold the process open). A test run whose loop holds
  // only unref'd handles fails the pending test on some Node versions, so
  // one ref'd heartbeat lives for the file; the per-test timers do the
  // real waiting.
  let beat = null
  beforeEach(() => { beat = setInterval(() => {}, 1000) })
  afterEach(async () => { try { clearInterval(beat) } catch (_) { /* heartbeat best-effort */ } await bot.stop() })

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
    assert.ok(!sets.some((c) => c.startsWith('#set mineMaxOreLocationsCount')), 'no phantom pin: the setting does not exist in Baritone 1.18.2')
    assert.ok(sets.some((c) => c === '#set exploreForBlocks false'), 'no wandering on empty scan')
    assert.ok(sets.some((c) => c === '#set allowBreak true'), 'a mine digs even under a no-dig walk lease')
    assert.equal(bot._settings.allowBreak, 'true', 'the pin mirrors into the adapter diff')
    assert.ok(!(transport.state.digLog || []).length, 'no single digs on the mine path')
  })

  it('a mine that ends below target rejects mine-noPath', async () => {
    ({ transport, bot } = mineBot({ mineScript: 'noPath' }))
    await bot.start({ pollMs: 0 })
    await assert.rejects(bot.mine(['stone', 'cobblestone'], 4, { tickMs: 5 }), /mine-noPath/)
  })

  it('a churn-tripped mine rejects mine-futile', async () => {
    ({ transport, bot } = mineBot({ mineScript: 'futile' }))
    await bot.start({ pollMs: 0 })
    await assert.rejects(bot.mine(['stone', 'cobblestone'], 4, { tickMs: 5 }), /mine-futile/)
  })

  it('the verb waits for the leg area chunks, then arms', async () => {
    ({ transport, bot } = mineBot({}))
    await bot.start({ pollMs: 0 })
    let calls = 0
    let loaded = false
    setTimeout(() => { loaded = true }, 300).unref()
    bot.world = { getChunk: () => { calls++; return loaded ? {} : null } }
    // pos (0,64,0) radius 12: one full pass is 4 chunk reads; waiting
    // adds sleep rounds, so more reads prove the gate held the verb.
    await bot.mine(['dirt'], 3, { radius: 12, tickMs: 5, warmupMs: 5000 })
    assert.ok(calls > 4, `gate waited for chunks (reads=${calls})`)
    assert.equal(transport.state.mineLog.length, 1)
  })

  it('the verb arms anyway when the warmup budget runs out', async () => {
    ({ transport, bot } = mineBot({}))
    await bot.start({ pollMs: 0 })
    bot.world = { getChunk: () => null }
    await bot.mine(['dirt'], 3, { radius: 12, tickMs: 5, warmupMs: 300 })
    assert.equal(transport.state.mineLog.length, 1)
  })

  it('cacheReady needs every chunk in radius, or no world at all', () => {
    const at = { x: 0, y: 64, z: 0 }
    assert.equal(cacheReady({}, at, 12), true, 'no world reads warm')
    assert.equal(cacheReady({ world: {} }, at, 12), true, 'no getChunk reads warm')
    assert.equal(cacheReady({ world: { getChunk: () => ({}) } }, at, 12), true)
    let calls = 0
    const hole = { world: { getChunk: () => { calls++; return calls > 1 ? {} : null } } }
    assert.equal(cacheReady(hole, at, 12), false, 'one missing chunk fails the area')
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

  it('a gain re-anchors the leash start to the working frontier', async () => {
    ({ transport, bot } = mineBot({ mineScript: 'hang' }))
    await bot.start({ pollMs: 0 })
    const p = bot.mine(['dirt'], 30, { radius: 2, stallMs: 5000, tickMs: 5 })
    await untilMineSent()
    let settled = null
    p.then(() => { settled = 'resolved' }, () => { settled = 'rejected' })
    transport.state.pos = { ...transport.state.pos, x: 1.5 }
    await bot.refresh()
    await new Promise((r) => setTimeout(r, 30))
    assert.equal(settled, null, 'inside the radius: no trip')
    // A gain at the frontier moves the leash with the body: 3.0 is past
    // the arm origin's radius but inside the re-anchored one.
    transport.inject('baritone.event', { kind: 'mine', id: bot._mine.id, have: 5, target: 30, active: true })
    await new Promise((r) => setTimeout(r, 10))
    transport.state.pos = { ...transport.state.pos, x: 3 }
    await bot.refresh()
    await new Promise((r) => setTimeout(r, 30))
    assert.equal(settled, null, 'a gaining mine roams with its frontier')
    transport.state.pos = { ...transport.state.pos, x: 10 }
    await bot.refresh()
    await assert.rejects(p, /mine-leash/)
  })

  it('the origin backstop trips a gainer that drifts past 3x radius', async () => {
    ({ transport, bot } = mineBot({ mineScript: 'hang' }))
    await bot.start({ pollMs: 0 })
    const p = bot.mine(['dirt'], 90, { radius: 100, stallMs: 20000, tickMs: 5 })
    await untilMineSent()
    let settled = null
    p.then(() => { settled = 'resolved' }, () => { settled = 'rejected' })
    // Four 90-block hops with a gain each: every hop stays inside the
    // re-anchored radius, but the fourth crosses 3x radius from origin.
    let have = 0
    for (const x of [90, 180, 270]) {
      transport.state.pos = { ...transport.state.pos, x }
      await bot.refresh()
      transport.inject('baritone.event', { kind: 'mine', id: bot._mine.id, have: (have += 5), target: 90, active: true })
      await new Promise((r) => setTimeout(r, 10))
      assert.equal(settled, null, `hop to ${x}: roaming with gains`)
    }
    transport.state.pos = { ...transport.state.pos, x: 360 }
    await bot.refresh()
    await assert.rejects(p, /mine-leash/)
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

  it('a guard break ends mine-guard even at target', async () => {
    ({ transport, bot } = mineBot({ mineScript: 'guard' }))
    await bot.start({ pollMs: 0 })
    await assert.rejects(bot.mine(['stone'], 4, { tickMs: 5 }), /mine-guard/)
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

  it('a live mine parks a goal marker (not a moving latch) so stop paths reach it', async () => {
    ({ transport, bot } = mineBot({ mineScript: 'hang' }))
    await bot.start({ pollMs: 0 })
    const p = bot.mine(['dirt'], 3, { stallMs: 5000, tickMs: 5 })
    await untilMineSent()
    assert.equal(bot.pathfinder.isMoving(), false, 'stuck machine stays silent mid-mine')
    assert.ok(bot.pathfinder.goal && bot.pathfinder.goal.mine === true, 'stop paths gate on the goal')
    // stopOnce shape (bot/src/index.js): moving? stop : goal? setGoal(null).
    if (bot.pathfinder.isMoving()) bot.pathfinder.stop()
    else if (bot.pathfinder.goal) bot.pathfinder.setGoal(null)
    await assert.rejects(p, /mine-stopped/)
    assert.equal(transport.state.baritone, '#stop')
    assert.equal(bot.pathfinder.goal, null, 'settle lifts the marker')
  })

  it('pathfinder.stop() cancels a live mine instead of leaving it mining', async () => {
    ({ transport, bot } = mineBot({ mineScript: 'hang' }))
    await bot.start({ pollMs: 0 })
    const p = bot.mine(['dirt'], 3, { stallMs: 5000, tickMs: 5 })
    await untilMineSent()
    bot.pathfinder.stop()
    await assert.rejects(p, /mine-stopped/)
    assert.equal(transport.state.baritone, '#stop')
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

  it('lease re-pushes skip break-policy while a mine is live', async () => {
    ({ transport, bot } = mineBot({ mineScript: 'hang' }))
    await bot.start({ pollMs: 0 })
    const mov = (canDig, sprint, guard, ban) => ({
      canDig, allowSprinting: sprint, blocksCantBreak: [],
      exclusionAreasBreak: [{ guardNames: guard, banNames: ban }],
    })
    const sets = () => transport.state.baritoneSets || []
    bot.pathfinder.movements = mov(false, false, ['dirt'], ['cobblestone'])
    bot._pushSettings()
    await new Promise((r) => setImmediate(r))
    assert.ok(sets().some((c) => c === '#set allowBreak false'), 'the lease breaks sync without a mine')
    const p = bot.mine(['stone', 'cobblestone'], 4, { stallMs: 5000, tickMs: 5 })
    await untilMineSent()
    const n = sets().length
    bot.pathfinder.movements = mov(true, true, ['sand'], ['stone'])
    bot._pushSettings()
    await new Promise((r) => setImmediate(r))
    assert.ok(sets().some((c) => c === '#set allowSprint true'), 'non-break keys still flow mid-mine')
    assert.ok(!sets().slice(n).some((c) => c.startsWith('#set allowBreak')), 'no allowBreak re-push mid-mine')
    assert.ok(!sets().slice(n).some((c) => c.startsWith('#set blocksTo')), 'no avoid/ban re-push mid-mine')
    bot.cancelMine()
    await assert.rejects(p, /mine-stopped/)
    // Flip every lease value: the skipped call-2 values were never marked,
    // so the post-settle push must carry all three break keys.
    bot.pathfinder.movements = mov(false, false, ['clay'], ['oak_planks'])
    bot._pushSettings()
    await new Promise((r) => setImmediate(r))
    const after = sets().slice(n + 1) // past the mid-mine allowSprint push
    assert.ok(after.some((c) => c === '#set allowBreak false'), 'allowBreak restores after settle')
    assert.ok(after.some((c) => c === '#set blocksToAvoidBreaking clay'), 'avoid restores after settle')
    assert.ok(after.some((c) => c === '#set blocksToDisallowBreaking oak_planks'), 'ban restores after settle')
  })

  it('rejects empty names and non-positive counts without touching the wire', async () => {
    ({ transport, bot } = mineBot({}))
    await bot.start({ pollMs: 0 })
    await assert.rejects(bot.mine([], 3), /non-empty names/)
    await assert.rejects(bot.mine(['dirt'], 0), /positive count/)
    assert.ok(!(transport.state.mineLog || []).length)
  })
})
