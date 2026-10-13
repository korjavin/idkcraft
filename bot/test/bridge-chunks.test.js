// idkcraft-neuc.6: chunk cache tests — FakeTransport serves a tiny world
// (stone floor, one oak tree, one water cell, all-air sections null) as
// wire-shaped chunk.get payloads; the adapter must give the sync
// mineflayer reads (blockAt/findBlocks/findBlock/world.raycast/
// canDigBlock/canSeeBlock) with prismarine-block parity, and the REAL
// gather.js find phase must run unchanged through it.
'use strict'

const { describe, it, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert/strict')

const { BaritoneBot } = require('../src/bridge/index')
const { FakeTransport } = require('../src/bridge/transport')
const Vec3 = require('vec3')
const registry = require('minecraft-data')('26.1.2')
const Block = require('prismarine-block')(registry)
const gather = require('../src/behaviours/gather')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function tinyWorld() {
  const blocks = {}
  for (let x = -2; x <= 8; x++) for (let z = -2; z <= 4; z++) blocks[`${x},63,${z}`] = 'stone'
  blocks['3,64,0'] = 'oak_log'
  blocks['3,65,0'] = 'oak_log'
  blocks['3,66,0'] = 'oak_log'
  blocks['3,67,0'] = 'oak_leaves'
  blocks['1,64,1'] = 'water'
  blocks['2,63,2'] = 'bedrock' // under the floor plane, within reach of (1,64,2)
  blocks['160,64,0'] = 'oak_log' // far column (10,0): background fill only
  return blocks
}

async function rigBot() {
  const transport = new FakeTransport({
    pos: { x: 0, y: 64, z: 0, yaw: 0, pitch: 0, onGround: true },
    blocks: tinyWorld(),
  })
  const bot = new BaritoneBot(transport, { Vec3, registry, username: 'IdkBody' })
  await bot.start({ pollMs: 0 })
  return { transport, bot }
}

describe('bridge chunk cache (neuc.6)', () => {
  let transport
  let bot
  beforeEach(async () => { ({ transport, bot } = await rigBot()) })
  afterEach(async () => { await bot.stop() })

  it('blockAt matches a mineflayer prismarine-block for the same stateId', () => {
    for (const [pos, name] of [
      [new Vec3(0, 63, 0), 'stone'],
      [new Vec3(3, 64, 0), 'oak_log'],
      [new Vec3(1, 64, 1), 'water'],
      [new Vec3(0, 64, 0), 'air'],
    ]) {
      const got = bot.blockAt(pos)
      assert.ok(got, `${name} at ${pos}`)
      const want = Block.fromStateId(registry.blocksByName[name].defaultState, 0)
      assert.equal(got.name, want.name)
      assert.equal(got.type, want.type)
      assert.equal(got.stateId, want.stateId)
      assert.equal(got.hardness, want.hardness)
      assert.deepEqual(got.harvestTools, want.harvestTools)
      assert.equal(got.material, want.material)
      assert.equal(got.boundingBox, want.boundingBox)
      assert.deepEqual(got.shapes, want.shapes)
      assert.equal(got.transparent, want.transparent)
      assert.equal(got.diggable, want.diggable)
      assert.deepEqual([got.position.x, got.position.y, got.position.z], [pos.x, pos.y, pos.z])
    }
    assert.equal(bot.blockAt(new Vec3(0, 63, 0)).name, 'stone') // feet-1 probe shape (bot stands at y=64)
  })

  it('unloaded columns read null; chunk.unloaded returns a column to null', async () => {
    assert.equal(bot.blockAt(new Vec3(500, 64, 500)), null)
    assert.equal(bot.blockAt(new Vec3(3, 64, 0)).name, 'oak_log')
    transport.inject('chunk.unloaded', { cx: 0, cz: 0 })
    assert.equal(bot.blockAt(new Vec3(3, 64, 0)), null)
  })

  it('findBlocks finds the log, respects maxDistance and count; findBlock wraps it', () => {
    const logId = registry.blocksByName.oak_log.id
    const hits = bot.findBlocks({ matching: [logId], maxDistance: 16, count: 64 })
    assert.ok(hits.length >= 3, `expected the tree, got ${hits.length}`)
    assert.deepEqual([hits[0].x, hits[0].y, hits[0].z], [3, 64, 0]) // nearest first
    const one = bot.findBlocks({ matching: [logId], maxDistance: 16, count: 1 })
    assert.equal(one.length, 1)
    const none = bot.findBlocks({ matching: [logId], maxDistance: 2, count: 64 })
    assert.equal(none.length, 0)
    const byFn = bot.findBlocks({ matching: (b) => b && b.name === 'oak_log', maxDistance: 16, count: 1 })
    assert.equal(byFn.length, 1)
    const found = bot.findBlock({ matching: [logId], maxDistance: 16 })
    assert.equal(found.name, 'oak_log')
    assert.deepEqual([found.position.x, found.position.y, found.position.z], [3, 64, 0])
  })

  it('block.update flips a cell and emits blockUpdate(old, new)', async () => {
    const seen = []
    bot.on('blockUpdate', (oldB, newB) => seen.push([oldB && oldB.name, newB && newB.name]))
    assert.equal(bot.blockAt(new Vec3(2, 64, 0)).name, 'air')
    transport.inject('block.update', { x: 2, y: 64, z: 0, stateId: registry.blocksByName.stone.defaultState })
    assert.equal(bot.blockAt(new Vec3(2, 64, 0)).name, 'stone')
    assert.deepEqual(seen, [['air', 'stone']])
    // An update for an unloaded column is silent, like mineflayer.
    transport.inject('block.update', { x: 500, y: 64, z: 500, stateId: 1 })
    assert.equal(seen.length, 1)
  })

  it('canDigBlock: diggable+reach, liquids and bedrock refused', () => {
    bot.entity.position = new Vec3(0, 64, 0)
    assert.equal(bot.canDigBlock(bot.blockAt(new Vec3(0, 63, 0))), true) // stone underfoot
    assert.equal(bot.canDigBlock(bot.blockAt(new Vec3(1, 64, 1))), false) // water
    assert.equal(bot.canDigBlock(bot.blockAt(new Vec3(2, 63, 2))), false) // bedrock
    assert.equal(bot.canDigBlock(bot.blockAt(new Vec3(8, 63, 4))), false) // stone, out of reach
    assert.equal(bot.canDigBlock(null), false)
    assert.equal(bot.canDigBlock({ name: 'bedrock' }), false)
  })

  it('world.raycast and canSeeBlock read the same cache', () => {
    const eye = bot.entity.position.offset(0, 1.62, 0)
    const hit = bot.world.raycast(eye, new Vec3(0, -1, 0), 4)
    assert.ok(hit)
    assert.equal(hit.name, 'stone')
    assert.deepEqual([hit.position.x, hit.position.y, hit.position.z], [0, 63, 0])
    assert.equal(bot.canSeeBlock(bot.blockAt(new Vec3(3, 64, 0))), true)
    assert.equal(bot.canSeeBlock(bot.blockAt(new Vec3(0, 63, 0))), true)
  })

  it('far columns trickle in via the background fill (<=4/100 ms)', async () => {
    assert.equal(bot.blockAt(new Vec3(160, 64, 0)), null) // column (10,0), past the near radius
    await sleep(350)
    const b = bot.blockAt(new Vec3(160, 64, 0))
    assert.ok(b && b.name === 'oak_log', `background fill landed, got ${b && b.name}`)
  })

  it('chunk.loaded fetches a new column (far ones via the throttled queue)', async () => {
    transport.state.blocks['80,64,0'] = 'oak_log' // column (5,0), not listed at start
    transport.inject('chunk.loaded', { cx: 5, cz: 0 })
    await sleep(20)
    assert.equal(bot.blockAt(new Vec3(80, 64, 0)), null) // queued, not an immediate flood fetch
    await sleep(300)
    assert.equal(bot.blockAt(new Vec3(80, 64, 0)).name, 'oak_log')
  })

  it('a chunk.get reply that races chunk.unloaded is dropped, next load refetches (revmux 01 core-2)', async () => {
    const origCall = transport.call.bind(transport)
    transport.call = async (method, params) => {
      if (method === 'chunk.get') await sleep(40) // in flight long enough to race
      return origCall(method, params)
    }
    transport.state.blocks['32,64,0'] = 'oak_log' // column (2,0), near
    transport.inject('chunk.loaded', { cx: 2, cz: 0 })
    await sleep(10)
    transport.inject('chunk.unloaded', { cx: 2, cz: 0 })
    await sleep(80)
    assert.equal(bot.blockAt(new Vec3(32, 64, 0)), null, 'stale reply must not resurrect the column')
    transport.inject('chunk.loaded', { cx: 2, cz: 0 })
    await sleep(80)
    assert.equal(bot.blockAt(new Vec3(32, 64, 0)).name, 'oak_log', 'the next load refetches')
  })

  it('loaded/unloaded/loaded inside one in-flight fetch still lands the column (revmux 02 core-1)', async () => {
    const origCall = transport.call.bind(transport)
    transport.call = async (method, params) => {
      if (method === 'chunk.get') await sleep(40)
      return origCall(method, params)
    }
    transport.state.blocks['48,64,0'] = 'oak_log' // column (3,0), near
    transport.inject('chunk.loaded', { cx: 3, cz: 0 })
    await sleep(10)
    transport.inject('chunk.unloaded', { cx: 3, cz: 0 })
    transport.inject('chunk.loaded', { cx: 3, cz: 0 }) // mid-fetch reload: armed, not dropped
    await sleep(200)
    assert.equal(bot.blockAt(new Vec3(48, 64, 0)).name, 'oak_log')
  })

  it('the REAL gather.js find phase runs unchanged through the adapter', () => {
    const ctx = { lastGoalKey: '', stepStatus: 'running' }
    gather(bot, ctx, null, {})
    // gather found the tree through findBlocks+blockAt and committed to it:
    // either it is walking to the nearest log or already in dig phase.
    const g = ctx.gather
    assert.ok(g, 'gather state exists')
    assert.ok(ctx.lastGoalKey.startsWith('gather:') || (g.pos && g.pos.x === 3),
      `gather committed to the tree: key=${ctx.lastGoalKey} pos=${g.pos && `${g.pos.x},${g.pos.y},${g.pos.z}`}`)
    if (g.pos) assert.deepEqual([g.pos.x, g.pos.z], [3, 0])
  })
})
