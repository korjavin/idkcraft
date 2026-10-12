// idkcraft-kqzf spike: adapter tests. Run from the repo root after
// `cd bot && npm ci`: `node --test baritone/bridge/`.
'use strict'

const { describe, it, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert/strict')

const { BaritoneBot, goalToBaritone } = require('./adapter')
const { FakeTransport } = require('./transport')

let goals
try {
  goals = require('../../bot/node_modules/mineflayer-pathfinder').goals
} catch (_) {
  throw new Error('adapter.test: run `cd bot && npm ci` first (needs mineflayer-pathfinder)')
}
let Vec3
try {
  Vec3 = require('../../bot/node_modules/vec3')
} catch (_) {
  Vec3 = require('./adapter').MinimalVec
}
// The REAL behaviours, required unchanged — the spike's whole point is
// that this file is the only new code in the loop.
const follow = require('../../bot/src/behaviours/follow')
const { countItems } = require('../../bot/src/perception')

const REGISTRY = { blocksByName: { air: { id: 0 }, dirt: { id: 1 }, stone: { id: 2 } } }
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
    assert.equal(goalToBaritone(new goals.GoalNear(1, 64, -3, 2)), '#goto 1 64 -3')
    assert.equal(goalToBaritone(new goals.GoalBlock(1, 64, -3)), '#goto 1 64 -3')
    assert.equal(goalToBaritone(new goals.GoalXZ(10, -20)), '#goto 10 -20')
    assert.equal(goalToBaritone(new goals.GoalNearXZ(10, -20, 3)), '#goto 10 -20')
  })
  it('maps GoalFollow to a one-shot #goto at the live target', () => {
    const target = { position: new Vec3(10.25, 64, -4.5) }
    assert.equal(goalToBaritone(new goals.GoalFollow(target, 3)), '#goto 10.3 64.0 -4.5')
  })
  it('returns null for goals with no Baritone mapping', () => {
    assert.equal(goalToBaritone(new goals.GoalY(70)), null)
    assert.equal(goalToBaritone(null), null)
  })
})

describe('spike surface round-trips (FakeTransport = the mod)', () => {
  let transport
  let bot
  beforeEach(async () => {
    ({ transport, bot } = spikeBot({
      blocks: { '5,64,5': 'dirt' },
      inventory: [{ slot: 0, name: 'dirt', count: 3, type: 1 }],
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

  it('blockAt reads the prefetched cache, misses read unloaded (null)', async () => {
    assert.equal(bot.blockAt(new Vec3(5, 64, 5)), null) // nothing prefetched yet
    await bot.prefetch([{ x: 5.2, y: 64, z: 5.8 }]) // floors like the world sync
    const b = bot.blockAt(new Vec3(5, 64, 5))
    assert.equal(b.name, 'dirt')
    assert.equal(b.type, 1)
    assert.equal(bot.blockAt(new Vec3(6, 64, 6)), null)
  })

  it('inventory.items feeds the real countItems unchanged', () => {
    assert.equal(countItems(bot, (n) => n === 'dirt'), 3)
    assert.equal(countItems(bot, (n) => n === 'stone'), 0)
  })

  it('dig breaks the block and clears targetDigBlock', async () => {
    await bot.prefetch([{ x: 5, y: 64, z: 5 }])
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
      assert.equal(transport.state.baritone, '#goto 10.0 64.0 10.0')
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
      assert.equal(transport.state.baritone, '#goto 30.0 64.0 30.0')
    } finally {
      await bot.stop()
    }
  })
})

describe('status attribution fixes (revmux 01-03)', () => {
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

  it("a stale 'none' status after setGoal stays silent, keeps isMoving (core-3)", async () => {
    const { transport, bot } = spikeBot()
    await bot.start({ pollMs: 0 })
    try {
      const statuses = []
      bot.on('path_update', (r) => statuses.push(r.status))
      bot.pathfinder.setGoal(new goals.GoalNear(9, 64, 9, 2))
      // The mod hasn't caught up: still calculating, last unknown (no
      // motion round comes back, so nothing is witnessed for this goal).
      transport.state.baritonePhase = 1
      transport.state.baritoneStatus = { pathing: false, last: 'none' }
      await bot.refresh()
      assert.deepEqual(statuses, [])
      assert.equal(bot.pathfinder.isMoving(), true)
      // The real walk: motion witnessed, then arrival synthesizes the pair.
      transport.state.baritonePhase = 0
      transport.state.baritoneStatus = { pathing: false, last: 'success' }
      await bot.refresh()
      assert.equal(bot.pathfinder.isMoving(), true)
      await bot.refresh()
      assert.deepEqual(statuses, ['success'])
      assert.equal(bot.pathfinder.isMoving(), false)
    } finally {
      await bot.stop()
    }
  })

  it("a previous goal's latched success never completes the next goal (02 core-1)", async () => {
    const { transport, bot } = spikeBot()
    await bot.start({ pollMs: 0 })
    try {
      const statuses = []
      bot.on('path_update', (r) => statuses.push(r.status))
      // Goal 1 runs to arrival: motion witnessed, success synthesized.
      bot.pathfinder.setGoal(new goals.GoalNear(9, 64, 9, 2))
      await bot.refresh()
      await bot.refresh()
      assert.deepEqual(statuses, ['success'])
      assert.equal(bot.pathfinder.isMoving(), false)
      // Goal 2 issued; the mod still latches success while calculating
      // (no motion round comes back yet for the new goal).
      statuses.length = 0
      bot.pathfinder.setGoal(new goals.GoalNear(20, 64, 20, 2))
      transport.state.baritonePhase = 1
      await bot.refresh()
      assert.deepEqual(statuses, []) // silent: the stale latch is not ours
      assert.equal(bot.pathfinder.isMoving(), true) // latch kept: no re-issue storm
      // Gen-2 motion + arrival still complete normally.
      transport.state.baritonePhase = 0
      await bot.refresh()
      await bot.refresh()
      assert.deepEqual(statuses, ['success'])
      assert.equal(bot.pathfinder.isMoving(), false)
    } finally {
      await bot.stop()
    }
  })

  it('a no-motion noPath poll stays silent; the pushed event rescues the goal (03 core-1)', async () => {
    const { transport, bot } = spikeBot()
    await bot.start({ pollMs: 0 })
    try {
      const statuses = []
      const resets = []
      bot.on('path_update', (r) => statuses.push(r.status))
      bot.on('path_reset', (r) => resets.push(r))
      bot.pathfinder.setGoal(new goals.GoalNear(9, 64, 9, 2))
      // CALC_FAILED before any poll saw motion: the mod latches noPath.
      transport.state.baritonePhase = 1
      transport.state.baritoneStatus = { pathing: false, last: 'noPath' }
      await bot.refresh()
      assert.deepEqual(statuses, []) // the poll cannot attribute it: silent
      assert.equal(bot.pathfinder.isMoving(), true) // latch kept
      // The pushed PathEvent is the attributed channel: it completes the goal.
      transport.inject('baritone.event', { status: 'noPath' })
      assert.deepEqual(statuses, ['noPath'])
      assert.deepEqual(resets, ['noPath'])
      assert.equal(bot.pathfinder.isMoving(), false)
    } finally {
      await bot.stop()
    }
  })

  it('stop drops an in-flight pre-stop motion poll: no phantom re-arm (03 core-2)', async () => {
    const { transport, bot } = spikeBot()
    await bot.start({ pollMs: 0 })
    try {
      const statuses = []
      bot.on('path_update', (r) => statuses.push(r.status))
      bot.pathfinder.setGoal(new goals.GoalNear(9, 64, 9, 2))
      await bot.refresh() // motion witnessed
      assert.equal(bot.pathfinder.isMoving(), true)
      // A status round already in flight when stop lands.
      const orig = transport.call.bind(transport)
      let release
      const gate = new Promise((r) => { release = r })
      transport.call = async (method, params) => {
        if (method === 'baritone.status') await gate
        return orig(method, params)
      }
      const flight = bot.refresh()
      await sleep(10) // the round parks on the status call (state+inventory pass first)
      bot.pathfinder.setGoal(null) // stop: latch cleared, generation bumped
      assert.equal(bot.pathfinder.goal, null)
      // The reply in flight was generated pre-stop: it reports motion.
      transport.state.baritonePhase = 0
      release()
      await flight
      transport.call = orig
      assert.equal(bot.pathfinder.isMoving(), false) // stale reply dropped, no re-arm
      assert.deepEqual(statuses, [])
    } finally {
      await bot.stop()
    }
  })
})

describe('console backend (rig proof without the mod)', () => {
  it('setGoal sends msg #goto lines, setGoal(null) stops', async () => {
    const lines = []
    const bot = new BaritoneBot(new FakeTransport(), {
      Vec3,
      registry: REGISTRY,
      backend: 'console',
      bridgeSend: async (line) => { lines.push(line) },
    })
    await bot.start({ pollMs: 0 })
    try {
      bot.pathfinder.setGoal(new goals.GoalNear(1, 64, -3, 2))
      await sleep(10)
      assert.deepEqual(lines, ['msg #goto 1 64 -3'])
      assert.equal(bot.pathfinder.isMoving(), true)
      assert.ok(bot.pathfinder.goal)
      bot.pathfinder.setGoal(null) // clearGoal shape
      await sleep(10)
      assert.deepEqual(lines, ['msg #goto 1 64 -3', 'msg #stop'])
      assert.equal(bot.pathfinder.goal, null)
      assert.equal(bot.pathfinder.isMoving(), false)
    } finally {
      await bot.stop()
    }
  })

  it('unmapped goals report noPath like an executor failure', async () => {
    const bot = new BaritoneBot(new FakeTransport(), { Vec3, registry: REGISTRY, backend: 'console', bridgeSend: async () => {} })
    await bot.start({ pollMs: 0 })
    try {
      const statuses = []
      bot.on('path_update', (r) => statuses.push(r.status))
      bot.pathfinder.setGoal(new goals.GoalY(70))
      assert.deepEqual(statuses, ['noPath'])
    } finally {
      await bot.stop()
    }
  })
})
