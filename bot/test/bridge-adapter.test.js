// idkcraft-neuc.2: bridge adapter tests (moved from the kqzf spike's
// baritone/bridge/adapter.test.js; the console-backend block is gone with
// the deleted backend). Pathfinder parity moved to bridge-pathfinder.test.js
// (idkcraft-neuc.4). Run: `cd bot && npm test`.
'use strict'

const { describe, it, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert/strict')

const { BaritoneBot, goalToBaritone } = require('../src/bridge/index')
const { FakeTransport } = require('../src/bridge/transport')

const { goals } = require('mineflayer-pathfinder')
const Vec3 = require('vec3')
// The REAL behaviours, required unchanged — the spike's whole point is
// that this file is the only new code in the loop.
const follow = require('../src/behaviours/follow')
const { countItems } = require('../src/perception')

const REGISTRY = require('minecraft-data')('26.1.2') // neuc.6: the chunk cache builds real prismarine blocks
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function spikeBot(state = {}) {
  const transport = new FakeTransport({
    pos: { x: 0, y: 64, z: 0, yaw: 0, pitch: 0, onGround: true },
    ...state,
  })
  const bot = new BaritoneBot(transport, { Vec3, registry: REGISTRY, username: 'IdkBody' })
  return { transport, bot }
}

describe('goal translation (pathfinder -> Baritone)', () => {
  it('maps the walk goals to #goto', () => {
    assert.equal(goalToBaritone(new goals.GoalNear(1, 64, -3, 2)), '#near 1 64 -3 2') // neuc.21: the range rides along
    assert.equal(goalToBaritone(new goals.GoalNear(1, 64, -3, 1.5)), '#near 1 64 -3 1') // floored: never wider than isEnd
    assert.equal(goalToBaritone(new goals.GoalBlock(1, 64, -3)), '#goto 1 64 -3')
    assert.equal(goalToBaritone(new goals.GoalXZ(10, -20)), '#goto 10 -20')
    assert.equal(goalToBaritone(new goals.GoalNearXZ(10, -20, 3)), '#goto 10 -20')
  })
  it('maps the table-sight goal to #near (neuc.50: every v2 table walk was noPath)', () => {
    const g = require('../src/behaviours/craft').tableGoal({ world: null }, { x: 260, y: 70, z: 352 })
    assert.equal(g.constructor.name, 'GoalSeeTable')
    assert.equal(goalToBaritone(g), '#near 260 70 352 1') // no sight test in Baritone: beside/on the table
  })
  it('maps GoalFollow to #near around the floored live target cell (neuc.28)', () => {
    const target = { position: new Vec3(10.25, 64, -4.5) }
    assert.equal(goalToBaritone(new goals.GoalFollow(target, 3)), '#near 10 64 -5 3')
    // floored range never wider than v1's isEnd; range 0 = the target cell
    assert.equal(goalToBaritone(new goals.GoalFollow(target, 1.5)), '#near 10 64 -5 1')
    assert.equal(goalToBaritone(new goals.GoalFollow(target, 0)), '#near 10 64 -5 0')
  })
  it('returns null for goals with no Baritone mapping', () => {
    assert.equal(goalToBaritone(new goals.GoalInvert(new goals.GoalBlock(1, 2, 3))), null)
    assert.equal(goalToBaritone(null), null)
  })
})

describe('spike surface round-trips (FakeTransport = the mod)', () => {
  let transport
  let bot
  beforeEach(async () => {
    ({ transport, bot } = spikeBot({
      blocks: { '5,64,5': 'dirt' },
      inventory: [{ slot: 36, name: 'dirt', count: 3 }], // wire carries no type: the full registry resolves it by name
    }))
    await bot.start({ pollMs: 0 })
  })
  afterEach(async () => { await bot.stop() })

  it('entity position tracks state.get', async () => {
    assert.deepEqual([bot.entity.position.x, bot.entity.position.y, bot.entity.position.z], [0, 64, 0])
    transport.state.pos = { x: 1, y: 65, z: 2, yaw: 0, pitch: 0, onGround: true }
    await bot.refresh()
    assert.deepEqual([bot.entity.position.x, bot.entity.position.y, bot.entity.position.z], [1, 65, 2])
    assert.equal(typeof bot.entity.position.floored, 'function') // behaviours call .floored()
  })

  it('blockAt reads the chunk cache, misses read unloaded (null)', async () => {
    // The initial fill (start's first refresh) already loaded column 0,0.
    const b = bot.blockAt(new Vec3(5, 64, 5))
    assert.equal(b.name, 'dirt')
    assert.equal(b.type, REGISTRY.blocksByName.dirt.id)
    assert.equal(bot.blockAt(new Vec3(160, 64, 160)), null) // unloaded column
  })

  it('inventory.items feeds the real countItems unchanged', () => {
    assert.equal(countItems(bot, (n) => n === 'dirt'), 3)
    assert.equal(countItems(bot, (n) => n === 'stone'), 0)
  })

  it('dig breaks the block and clears targetDigBlock', async () => {
    await bot.prefetch([{ x: 5, y: 64, z: 5 }])
    bot.entity.position = new Vec3(4, 64, 5) // within canDigBlock eye reach
    const b = bot.blockAt(new Vec3(5, 64, 5))
    assert.equal(bot.canDigBlock(b), true)
    assert.equal(bot.canDigBlock({ name: 'bedrock' }), false)
    assert.equal(bot.canDigBlock({ name: 'air' }), false)
    await bot.dig(b)
    assert.equal(bot.blockAt(new Vec3(5, 64, 5)).name, 'air')
    assert.equal(bot.targetDigBlock, null)
    assert.equal(transport.state.blocks['5,64,5'], 'air')
  })

  it('placeBlock targets ref+face and spends one item', async () => {
    await bot.prefetch([{ x: 5, y: 64, z: 5 }])
    const ref = bot.blockAt(new Vec3(5, 64, 5))
    await bot.placeBlock(ref, new Vec3(0, 1, 0))
    assert.equal(bot.blockAt(new Vec3(5, 65, 5)).name, 'dirt')
    assert.equal(countItems(bot, (n) => n === 'dirt'), 2)
  })

  it('chat splits like mineflayer bot.chat: 256-char packets, per line, commands whole (neuc.22)', async () => {
    transport.state.chatLog.length = 0
    const long = 'a'.repeat(256) + 'b'.repeat(193) // the prod 449-char line
    const cmd = '/tell Owner ' + 'c'.repeat(300)
    bot.chat(long + '\n\nshort')
    bot.chat(cmd)
    await sleep(10)
    assert.deepEqual(transport.state.chatLog, ['a'.repeat(256), 'b'.repeat(193), 'short', cmd])
    assert.ok(transport.state.chatLog.slice(0, 3).every((m) => m.length <= 256))
  })

  it('chat is fire-and-forget; mod chat events arrive as chat+message', async () => {
    bot.chat('hello rig')
    await sleep(10)
    assert.deepEqual(transport.state.chatLog, ['hello rig'])
    const seen = {}
    bot.on('chat', (username, message) => { seen.chat = [username, message] })
    bot.on('message', (msg) => { seen.message = String(msg) })
    transport.inject('chat', { username: 'Owner', message: 'follow me' })
    assert.deepEqual(seen.chat, ['Owner', 'follow me'])
    assert.equal(seen.message, 'follow me')
  })

  it('a dead body clicks respawn (death -> respawn pair, mineflayer respawn:true parity; neuc.21)', async () => {
    const seen = []
    bot.on('death', () => seen.push('death'))
    bot.on('respawn', () => seen.push('respawn'))
    transport.state.health = 20
    await bot.refresh()
    assert.equal(transport.state.respawnCalls | 0, 0) // alive: no click
    transport.state.health = 0
    await bot.refresh()
    await sleep(10)
    assert.equal(transport.state.respawnCalls, 1)
    assert.deepEqual(seen, ['death'])
    await bot.refresh() // fake respawned it: health 20 again
    assert.deepEqual(seen, ['death', 'respawn'])
    assert.equal(bot.health, 20)
  })

  it('a dropped respawn click is re-sent at most 1/s while still dead (neuc.21)', async () => {
    const seen = []
    bot.on('death', () => seen.push('death'))
    const realNow = Date.now
    let now = realNow()
    Date.now = () => now
    try {
      transport.state.respawnIgnore = 1
      transport.state.health = 0
      await bot.refresh()
      await bot.refresh() // same second: no re-click
      await sleep(10)
      assert.equal(transport.state.respawnCalls, 1)
      now += 1000
      await bot.refresh()
      await sleep(10)
      assert.equal(transport.state.respawnCalls, 2)
      assert.deepEqual(seen, ['death']) // one death edge, however many clicks
    } finally {
      Date.now = realNow
    }
  })
})

describe('follow.js unchanged through the adapter (FakeTransport walk)', () => {
  it('issues, walks (fake #goto), rests in range, re-issues when the target leaves', async () => {
    const { transport, bot } = spikeBot()
    await bot.start({ pollMs: 0 })
    try {
      const ctx = {}
      // The ticker wiring (index.js): adapter path events feed ctx.
      bot.on('path_update', (r) => { ctx.lastPathStatus = r && r.status })
      const target = { username: 'Owner', id: 7, position: new Vec3(10, 64, 10) }

      follow(bot, ctx, target) // fresh key: issues GoalFollow
      assert.ok(bot.pathfinder.goal, 'goal stored')
      assert.equal(transport.state.baritone, '#near 10 64 10 3')
      await bot.refresh() // round 1: fake walk lands, motion witnessed
      assert.deepEqual(
        [bot.entity.position.x, bot.entity.position.z],
        [10, 10],
      )
      assert.equal(bot.pathfinder.isMoving(), true)
      await bot.refresh() // round 2: arrival -> path_update success
      assert.equal(bot.pathfinder.isMoving(), false)
      assert.equal(ctx.lastPathStatus, 'success')

      const first = transport.state.baritone
      follow(bot, ctx, target) // in range: rest, no re-issue
      assert.equal(transport.state.baritone, first)

      target.position = new Vec3(30, 64, 30) // player walks away
      ctx.lastPathStatus = 'success' // terminal verdict, executor idle
      follow(bot, ctx, target)
      assert.equal(transport.state.baritone, '#near 30 64 30 3')
    } finally {
      await bot.stop()
    }
  })
})

describe('poll overlap (revmux 01 core-2, kept; latch tests moved to bridge-pathfinder)', () => {
  it('poll honors pollMs: a handful of calls, not one per ms (core-2)', async () => {
    const { transport, bot } = spikeBot()
    let calls = 0
    const orig = transport.call.bind(transport)
    transport.call = async (...a) => { calls++; return orig(...a) }
    await bot.start({ pollMs: 50 })
    await sleep(130)
    await bot.stop()
    assert.ok(calls <= 30, `expected a handful of calls, got ${calls}`)
  })

  it('a slow round skips, never overlaps (core-2)', async () => {
    const { transport, bot } = spikeBot()
    let active = 0
    let max = 0
    const orig = transport.call.bind(transport)
    transport.call = async (...a) => {
      active++
      max = Math.max(max, active)
      try {
        await sleep(80)
        return await orig(...a)
      } finally {
        active--
      }
    }
    await bot.start({ pollMs: 20 })
    await sleep(110)
    await bot.stop()
    assert.equal(max, 1)
  })

  // The latch tests (revmux 01 core-3, 02 core-1, 03 core-1/2) tested the
  // spike's witnessed-motion attribution, replaced by goal ids in
  // idkcraft-neuc.4 — their equivalents live in bridge-pathfinder.test.js.
})

describe('unmapped goals (neuc.2: kept from the deleted console block)', () => {
  it('report noPath like an executor failure', async () => {
    const bot = new BaritoneBot(new FakeTransport(), { Vec3, registry: REGISTRY })
    await bot.start({ pollMs: 0 })
    try {
      const statuses = []
      bot.on('path_update', (r) => statuses.push(r.status))
      // Unsatisfied (fresh feet are in the inner block) so it reports noPath.
      bot.pathfinder.setGoal(new goals.GoalInvert(new goals.GoalBlock(0, 64, 0)))
      assert.deepEqual(statuses, ['noPath'])
    } finally {
      await bot.stop()
    }
  })
})
