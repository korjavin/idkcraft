// idkcraft-neuc.7: dig/place parity over the bridge (FakeTransport = the mod).
'use strict'

const { describe, it, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const Vec3 = require('vec3')

const { BaritoneBot } = require('../src/bridge/index')
const { FakeTransport } = require('../src/bridge/transport')
const { trackPlaced, installPlaceTiming } = require('../src/behaviours/util') // REAL wrappers, unchanged

const REGISTRY = require('minecraft-data')('26.1.2')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

describe('bridge dig/place (idkcraft-neuc.7)', () => {
  let transport
  let bot
  beforeEach(async () => {
    transport = new FakeTransport({
      pos: { x: 4.5, y: 64, z: 5.5, yaw: 0, pitch: 0, onGround: true },
      blocks: { '5,64,5': 'dirt', '5,63,5': 'bedrock', '6,64,5': 'stone' },
      inventory: [{ slot: 36, name: 'cobblestone', count: 3 }],
    })
    bot = new BaritoneBot(transport, { Vec3, registry: REGISTRY, username: 'IdkBody' })
    await bot.start({ pollMs: 0 })
  })
  afterEach(async () => { await bot.stop() })

  it('dig: dig.start -> progress -> done; targetDigBlock set mid-dig, cleared after; diggingCompleted', async () => {
    const b = bot.blockAt(new Vec3(5, 64, 5))
    const seen = []
    bot.on('diggingCompleted', (nb) => seen.push(nb && nb.name))
    const p = bot.dig(b)
    assert.equal(bot.targetDigBlock, b) // stuck.js reads it while the dig runs
    await p
    assert.equal(bot.targetDigBlock, null)
    assert.deepEqual(seen, ['air'])
    assert.equal(bot.blockAt(new Vec3(5, 64, 5)).name, 'air') // re-read right after resolves air
    assert.deepEqual(transport.state.digLog, [{ x: 5, y: 64, z: 5, face: 'up', look: true }])
  })

  it('dig: face vector and forceLook ignore cross the wire', async () => {
    await bot.dig(bot.blockAt(new Vec3(5, 64, 5)), 'ignore', new Vec3(-1, 0, 0))
    assert.deepEqual(transport.state.digLog, [{ x: 5, y: 64, z: 5, face: 'west', look: false }])
  })

  it('dig: a mod dig.abort rejects Digging aborted (reason), emits diggingAborted, clears the target', async () => {
    transport.state.digScript = 'abort'
    const b = bot.blockAt(new Vec3(5, 64, 5))
    const aborted = []
    bot.on('diggingAborted', (blk) => aborted.push(blk))
    await assert.rejects(bot.dig(b), /^Error: Digging aborted \(moved\)$/)
    assert.deepEqual(aborted, [b])
    assert.equal(bot.targetDigBlock, null)
    assert.equal(bot.blockAt(new Vec3(5, 64, 5)).name, 'dirt')
  })

  it('stopDigging mid-dig rejects Digging aborted and sends dig.abort; a no-op when idle', async () => {
    bot.stopDigging() // idle: mineflayer's noop
    assert.equal(transport.state.digAborts | 0, 0)
    transport.state.digScript = 'hang'
    const p = bot.dig(bot.blockAt(new Vec3(5, 64, 5)))
    await sleep(5)
    bot.stopDigging()
    await assert.rejects(p, /^Error: Digging aborted$/)
    assert.equal(transport.state.digAborts, 1)
    assert.equal(bot.targetDigBlock, null)
  })

  it('Baritone pauses across a dig while pathing and resumes after', async () => {
    bot._pathing = true
    await bot.dig(bot.blockAt(new Vec3(5, 64, 5)))
    assert.deepEqual(transport.state.baritonePauses, ['#pause', '#resume'])
  })

  it('dig refuses like mineflayer: null block, Infinity dig time', async () => {
    await assert.rejects(bot.dig(null), /dig was called with an undefined or null block/)
    await assert.rejects(bot.dig(bot.blockAt(new Vec3(5, 63, 5))), /dig time for bedrock is Infinity/)
  })

  it('placeBlock resolves on the target block.update, emits blockPlaced, places at ref+face', async () => {
    const ref = bot.blockAt(new Vec3(5, 64, 5))
    const placed = []
    bot.on('blockPlaced', (o, n) => placed.push([o.name, n.name]))
    await bot.placeBlock(ref, new Vec3(0, 1, 0))
    assert.equal(bot.blockAt(new Vec3(5, 65, 5)).name, 'cobblestone')
    assert.deepEqual(placed, [['air', 'cobblestone']])
    const call = transport.state.placeLog[0]
    assert.deepEqual([call.x, call.y, call.z, call.face], [5, 65, 5, 'up'])
    assert.deepEqual(call.cursor, { x: 0.5, y: 1, z: 0.5 }) // mineflayer's face-centre look point
    assert.equal(bot.heldItem.count, 2)
  })

  it('placeBlock refusals reject with mineflayer strings', async () => {
    const ref = bot.blockAt(new Vec3(5, 64, 5))
    transport.state.refusePlace = true
    await assert.rejects(bot.placeBlock(ref, new Vec3(0, 1, 0)),
      /^Error: Server refused to place cobblestone at \(5, 65, 5\): the block is still air$/)
    transport.state.refusePlace = false
    transport.state.placeSilent = true
    await assert.rejects(bot.placeBlock(ref, new Vec3(0, 1, 0)), /Server did not answer the placement at \(5, 65, 5\)/)
    transport.state.inventory = []
    await bot.refresh()
    await assert.rejects(bot.placeBlock(ref, new Vec3(0, 1, 0)), /^Error: must be holding an item to place$/)
  })

  it('REAL util.js trackPlaced + installPlaceTiming wrap the adapter placeBlock before spawn; a dig un-owns the cell', async () => {
    const ctx = {}
    trackPlaced(bot, ctx)
    installPlaceTiming(bot)
    assert.equal(bot._placedTrackInstalled, true) // installed now, not deferred to spawn
    assert.equal(bot._placeTimingInstalled, true)
    await bot.placeBlock(bot.blockAt(new Vec3(5, 64, 5)), new Vec3(0, 1, 0))
    assert.ok(ctx.placedByBot.has('5,65,5'))
    assert.equal(ctx.placedNames.get('5,65,5'), 'cobblestone')
    await bot.dig(bot.blockAt(new Vec3(5, 65, 5)))
    assert.equal(ctx.placedByBot.has('5,65,5'), false) // blockUpdate on dig.done
  })
})
