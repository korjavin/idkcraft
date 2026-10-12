'use strict'

// idkcraft-neuc.4: pathfinder parity on Baritone — goal-id attribution,
// GoalFollow re-issue, goal class mapping, Movements->#set map,
// bestHarvestTool/getPathTo shims. FakeTransport = the mod.
// NOTE(.2 moves): requires flip to ../src/bridge/* on rebase after .2 lands.
const { describe, it, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert/strict')

const { BaritoneBot, goalToBaritone, movementsToSettings } = require('../../baritone/bridge/adapter')
const { FakeTransport } = require('../../baritone/bridge/transport')
const { goals } = require('mineflayer-pathfinder')
let Vec3
try {
  Vec3 = require('vec3')
} catch (_) {
  Vec3 = require('../../baritone/bridge/adapter').MinimalVec
}
// The REAL behaviour, required unchanged.
const follow = require('../src/behaviours/follow')

const REGISTRY = {
  blocksByName: {
    air: { id: 0, diggable: false },
    dirt: { id: 1, diggable: true },
    stone: { id: 2, diggable: true },
    chest: { id: 10, diggable: true },
    bedrock: { id: 11, diggable: false },
  },
  blocks: [],
  itemsByName: { dirt: { id: 1 }, cobblestone: { id: 2 } },
  items: [],
}
REGISTRY.blocks[10] = { name: 'chest' }
REGISTRY.blocks[11] = { name: 'bedrock' }
REGISTRY.items[1] = { name: 'dirt' }
REGISTRY.items[2] = { name: 'cobblestone' }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function pathBot(state = {}) {
  const transport = new FakeTransport({
    pos: { x: 0, y: 64, z: 0, yaw: 0, pitch: 0, onGround: true },
    ...state,
  })
  const bot = new BaritoneBot(transport, { Vec3, registry: REGISTRY, username: 'IdkBody' })
  return { transport, bot }
}

function taps(bot) {
  const seen = { statuses: [], resets: [], errors: [] }
  bot.on('path_update', (r) => seen.statuses.push(r && r.status))
  bot.on('path_reset', (r) => seen.resets.push(r))
  bot.on('error', (e) => seen.errors.push(e))
  return seen
}

describe('goal translation (pathfinder -> Baritone)', () => {
  it('maps the walk goals to #goto', () => {
    assert.equal(goalToBaritone(new goals.GoalNear(1, 64, -3, 2)), '#goto 1 64 -3')
    assert.equal(goalToBaritone(new goals.GoalBlock(1, 64, -3)), '#goto 1 64 -3')
    assert.equal(goalToBaritone(new goals.GoalGetToBlock(1, 64, -3)), '#goto 1 64 -3')
    assert.equal(goalToBaritone(new goals.GoalXZ(10, -20)), '#goto 10 -20')
    assert.equal(goalToBaritone(new goals.GoalNearXZ(10, -20, 3)), '#goto 10 -20')
  })
  it('maps GoalFollow to a one-shot #goto at the live target', () => {
    const target = { position: new Vec3(10.25, 64, -4.5) }
    assert.equal(goalToBaritone(new goals.GoalFollow(target, 3)), '#goto 10.3 64.0 -4.5')
  })
  it('maps GoalY to a single-number #goto (Baritone Y level)', () => {
    assert.equal(goalToBaritone(new goals.GoalY(70)), '#goto 70')
  })
  it('maps composites to the first mappable member', () => {
    const unmapped = new goals.GoalInvert(new goals.GoalBlock(1, 2, 3))
    assert.equal(
      goalToBaritone(new goals.GoalCompositeAny([unmapped, new goals.GoalBlock(4, 5, 6)])),
      '#goto 4 5 6',
    )
    assert.equal(
      goalToBaritone(new goals.GoalCompositeAll([new goals.GoalXZ(7, 8), new goals.GoalBlock(4, 5, 6)])),
      '#goto 7 8',
    )
    assert.equal(goalToBaritone(new goals.GoalCompositeAny([unmapped])), null)
    assert.equal(goalToBaritone(new goals.GoalCompositeAll([])), null)
  })
  it('maps place/look goals to a #goto at the block', () => {
    const world = { getBlock: () => null }
    assert.equal(
      goalToBaritone(new goals.GoalPlaceBlock(new Vec3(7, 64, 8), world, { range: 4 })),
      '#goto 7 64 8',
    )
    assert.equal(goalToBaritone(new goals.GoalLookAtBlock(new Vec3(7, 64, 8), world)), '#goto 7 64 8')
  })
  it('returns null for goals with no Baritone mapping', () => {
    assert.equal(goalToBaritone(new goals.GoalInvert(new goals.GoalBlock(1, 2, 3))), null)
    assert.equal(goalToBaritone(new goals.GoalBreakBlock(1, 2, 3, null)), null)
    assert.equal(goalToBaritone(null), null)
  })
})

describe('goal-id attribution (FakeTransport = the mod)', () => {
  let transport
  let bot
  let seen
  beforeEach(async () => {
    ({ transport, bot } = pathBot())
    seen = taps(bot)
    await bot.start({ pollMs: 0 })
  })
  afterEach(async () => { await bot.stop() })

  it('binds the echoed id; a foreign status drops, the terminal emits once', async () => {
    bot.pathfinder.setGoal(new goals.GoalNear(9, 64, 9, 2))
    await sleep(10)
    assert.equal(bot._goalId, 1)
    // Foreign verdict for a goal that is not ours: silent, latch kept.
    transport.state.baritonePhase = null
    transport.state.baritoneStatus = { id: 999, pathing: false, last: 'success' }
    await bot.refresh()
    assert.deepEqual(seen.statuses, [])
    assert.equal(bot.pathfinder.isMoving(), true)
    // Ours, in the writer's own words: motion, then arrival via the event.
    transport.state.baritonePhase = 0
    transport.state.baritoneStatus = { id: 1, pathing: false, last: 'success' }
    await bot.refresh()
    assert.equal(bot.pathfinder.isMoving(), true)
    transport.inject('baritone.event', { id: 1, status: 'success' })
    assert.deepEqual(seen.statuses, ['success'])
    assert.deepEqual(seen.resets, ['goal reached'])
    assert.equal(bot.pathfinder.isMoving(), false)
    // The second channel (the arrival poll) finds the latch cleared: once only.
    await bot.refresh()
    assert.deepEqual(seen.statuses, ['success'])
    assert.deepEqual(seen.resets, ['goal reached'])
  })

  it('a superseding setGoal drops the older goal id', async () => {
    bot.pathfinder.setGoal(new goals.GoalNear(9, 64, 9, 2))
    bot.pathfinder.setGoal(new goals.GoalNear(20, 64, 20, 2)) // before either echo lands
    await sleep(10)
    assert.equal(bot._goalId, 2)
    transport.inject('baritone.event', { id: 1, status: 'success' }) // stale: silent
    assert.deepEqual(seen.statuses, [])
    assert.equal(bot.pathfinder.isMoving(), true)
    transport.inject('baritone.event', { id: 2, status: 'noPath' })
    assert.deepEqual(seen.statuses, ['noPath'])
    assert.deepEqual(seen.resets, ['noPath'])
    assert.equal(bot.pathfinder.isMoving(), false)
  })

  it('stop sends #stop + path_reset, keeps the status sticky, drops late verdicts', async () => {
    bot.pathfinder.setGoal(new goals.GoalNear(9, 64, 9, 2))
    await sleep(10)
    bot.pathfinder.stop()
    assert.equal(transport.state.baritone, '#stop')
    assert.deepEqual(seen.statuses, []) // v1 stickiness: no path_update on stop
    assert.deepEqual(seen.resets, ['stopped'])
    assert.equal(bot.pathfinder.isMoving(), false)
    assert.equal(bot.pathfinder.goal, null)
    transport.inject('baritone.event', { id: 1, status: 'stopped' }) // the echo: stale now
    transport.state.baritonePhase = null
    transport.state.baritoneStatus = { id: 1, pathing: false, last: 'stopped' }
    await bot.refresh()
    assert.deepEqual(seen.statuses, [])
    assert.deepEqual(seen.resets, ['stopped'])
  })

  it('idle stop stays silent, like v1', async () => {
    bot.pathfinder.stop()
    await sleep(10)
    assert.equal(transport.state.baritone, null)
    assert.deepEqual(seen.statuses, [])
    assert.deepEqual(seen.resets, [])
  })

  it('a failed command fails the goal and raises error', async () => {
    const orig = transport.call.bind(transport)
    transport.call = async (method, params) => {
      if (method === 'baritone.cmd') throw new Error('bridge down')
      return orig(method, params)
    }
    bot.pathfinder.setGoal(new goals.GoalNear(9, 64, 9, 2))
    await sleep(10)
    transport.call = orig
    assert.deepEqual(seen.statuses, ['noPath'])
    assert.deepEqual(seen.resets, ['noPath'])
    assert.equal(bot.pathfinder.isMoving(), false)
    assert.equal(seen.errors.length, 1)
  })

  it('an unknown last verdict fails as timeout, never synthesised success', async () => {
    bot.pathfinder.setGoal(new goals.GoalNear(9, 64, 9, 2))
    await sleep(10)
    transport.state.baritonePhase = null
    transport.state.baritoneStatus = { id: 1, pathing: false, last: 'weird-future-verdict' }
    await bot.refresh()
    assert.deepEqual(seen.statuses, ['timeout'])
    assert.deepEqual(seen.resets, ['timeout'])
    assert.equal(bot.pathfinder.isMoving(), false)
  })

  it('an unknown pushed verdict waits for the poll', async () => {
    bot.pathfinder.setGoal(new goals.GoalNear(9, 64, 9, 2))
    await sleep(10)
    transport.inject('baritone.event', { id: 1, status: 'weird-future-verdict' })
    assert.deepEqual(seen.statuses, [])
    assert.equal(bot.pathfinder.isMoving(), true)
  })

  it('an unmapped goal stops the live walk and reports noPath', async () => {
    bot.pathfinder.setGoal(new goals.GoalNear(9, 64, 9, 2))
    await sleep(10)
    await bot.refresh() // motion witnessed for id 1
    bot.pathfinder.setGoal(new goals.GoalInvert(new goals.GoalBlock(1, 2, 3)))
    assert.equal(transport.state.baritone, '#stop')
    assert.deepEqual(seen.statuses, ['noPath'])
    assert.deepEqual(seen.resets, ['noPath'])
    transport.inject('baritone.event', { id: 1, status: 'success' }) // late: stale
    assert.deepEqual(seen.statuses, ['noPath'])
  })

  it('GoalY walks the Y leg end to end', async () => {
    bot.pathfinder.setGoal(new goals.GoalY(70))
    await sleep(10)
    assert.equal(transport.state.baritone, '#goto 70')
    await bot.refresh()
    assert.equal(bot.pathfinder.isMoving(), true)
    await bot.refresh()
    assert.deepEqual(seen.statuses, ['success'])
    assert.equal(bot.entity.position.y, 70)
  })

  it('isMining/isBuilding stay false', () => {
    assert.equal(bot.pathfinder.isMining(), false)
    assert.equal(bot.pathfinder.isBuilding(), false)
  })
})

describe('GoalFollow re-issue (dynamic, throttled)', () => {
  let transport
  let bot
  beforeEach(async () => {
    ({ transport, bot } = pathBot())
    await bot.start({ pollMs: 0 })
  })
  afterEach(async () => { await bot.stop() })

  it('re-commands past 1 block of drift, at most one cmd/s', async () => {
    const target = { username: 'Owner', id: 7, position: new Vec3(10, 64, 10) }
    bot.pathfinder.setGoal(new goals.GoalFollow(target, 3), true)
    await sleep(10)
    assert.ok(bot._follow, 'dynamic follow arms')
    assert.equal(transport.state.baritoneSeq, 1)
    // The walk stays live across rounds (still pathing, no verdict yet).
    transport.state.baritonePhase = null
    transport.state.baritoneStatus = { id: 1, pathing: true, last: 'none' }
    await bot.refresh() // motion round; no drift yet
    assert.equal(transport.state.baritoneSeq, 1)

    target.position = new Vec3(10.5, 64, 10) // <= 1 block: hold
    await bot.refresh()
    assert.equal(transport.state.baritoneSeq, 1)

    target.position = new Vec3(30, 64, 30) // far, but inside the throttle window
    await bot.refresh()
    assert.equal(transport.state.baritoneSeq, 1)

    bot._follow.at -= 1500 // the second passes
    await bot.refresh()
    assert.equal(transport.state.baritoneSeq, 2)
    assert.equal(transport.state.baritone, '#goto 30.0 64.0 30.0')
    await sleep(10)
    assert.equal(bot._goalId, 2) // the new echo rebinds
  })

  it('does not arm without the dynamic flag or without a live entity', async () => {
    const target = { username: 'Owner', id: 7, position: new Vec3(10, 64, 10) }
    bot.pathfinder.setGoal(new goals.GoalFollow(target, 3)) // static: the caller re-issues
    await sleep(10)
    assert.equal(bot._follow, null)
    bot.pathfinder.setGoal(new goals.GoalNear(9, 64, 9, 2), true) // dynamic, no entity
    await sleep(10)
    assert.equal(bot._follow, null)
  })
})

describe('Movements -> #set map', () => {
  function movs() {
    return {
      canDig: false,
      allowSprinting: true,
      allowParkour: false,
      allow1by1towers: true,
      scafoldingBlocks: [1, 2, 999],
      blocksCantBreak: new Set([10, 11]),
      canOpenDoors: true,
      blocksToAvoid: new Set([11]),
      exclusionAreasBreak: [() => 0],
    }
  }

  it('maps flags and id lists to Baritone setting values', () => {
    assert.deepEqual(movementsToSettings(movs(), REGISTRY), {
      allowBreak: 'false',
      allowSprint: 'true',
      allowParkour: 'false',
      allowPlace: 'true',
      acceptableThrowawayItems: 'dirt,cobblestone', // unknown item ids skipped
      blocksToAvoidBreaking: 'chest', // bedrock-class defaults need no telling
    })
  })

  it('resolves ids through the ByName maps when arrays are absent', () => {
    const minimal = { blocksByName: REGISTRY.blocksByName, itemsByName: REGISTRY.itemsByName }
    assert.deepEqual(movementsToSettings(movs(), minimal), {
      allowBreak: 'false',
      allowSprint: 'true',
      allowParkour: 'false',
      allowPlace: 'true',
      acceptableThrowawayItems: 'dirt,cobblestone',
      blocksToAvoidBreaking: 'chest',
    })
  })

  it('omits empty lists and survives missing shapes', () => {
    assert.deepEqual(movementsToSettings(null, REGISTRY), {})
    assert.deepEqual(movementsToSettings({}, REGISTRY), {})
    assert.deepEqual(
      movementsToSettings({ canDig: true, scafoldingBlocks: [], blocksCantBreak: new Set() }, REGISTRY),
      { allowBreak: 'true' },
    )
    assert.deepEqual(movementsToSettings({ canDig: true }, null), { allowBreak: 'true' })
  })

  it('pushes on setMovements, diffs on setGoal, never storms', async () => {
    const { transport, bot } = pathBot()
    await bot.start({ pollMs: 0 })
    try {
      const m = movs()
      bot.pathfinder.setMovements(m)
      await sleep(10)
      assert.deepEqual(transport.state.baritoneSets, [
        '#set allowBreak false',
        '#set allowSprint true',
        '#set allowParkour false',
        '#set allowPlace true',
        '#set acceptableThrowawayItems dirt,cobblestone',
        '#set blocksToAvoidBreaking chest',
      ])
      bot.pathfinder.setGoal(new goals.GoalNear(9, 64, 9, 2)) // unchanged: quiet ...
      await sleep(10)
      assert.equal(transport.state.baritoneSets.length, 6)
      assert.equal(transport.state.baritone, '#goto 9 64 9') // ... and the goto goes last
      m.canDig = true // the lease flips a flag between goals ...
      bot.pathfinder.setGoal(new goals.GoalNear(20, 64, 20, 2))
      await sleep(10)
      assert.deepEqual(transport.state.baritoneSets.slice(6), ['#set allowBreak true']) // ... one #set
      assert.equal(transport.state.baritone, '#goto 20 64 20')
    } finally {
      await bot.stop()
    }
  })

  it('a #set mid-walk never clobbers the goal status', async () => {
    const { transport, bot } = pathBot()
    const seen = taps(bot)
    await bot.start({ pollMs: 0 })
    try {
      const m = { canDig: true, allowSprinting: false, allowParkour: true, allow1by1towers: true }
      bot.pathfinder.setMovements(m)
      bot.pathfinder.setGoal(new goals.GoalNear(9, 64, 9, 2))
      await sleep(10)
      await bot.refresh() // motion for id 1
      m.canDig = false
      bot.pathfinder.setMovements(m) // settings push mid-walk
      await sleep(10)
      await bot.refresh() // arrival still attributes to id 1
      assert.deepEqual(seen.statuses, ['success'])
    } finally {
      await bot.stop()
    }
  })

  it('the console backend sends no settings', async () => {
    const lines = []
    const bot = new BaritoneBot(new FakeTransport(), {
      Vec3,
      registry: REGISTRY,
      backend: 'console',
      bridgeSend: async (line) => { lines.push(line) },
    })
    await bot.start({ pollMs: 0 })
    try {
      bot.pathfinder.setMovements(movs())
      await sleep(10)
      assert.deepEqual(lines, [])
    } finally {
      await bot.stop()
    }
  })
})

describe('bestHarvestTool/getPathTo shims', () => {
  let bot
  beforeEach(async () => {
    ({ bot } = pathBot({ inventory: [{ slot: 0, name: 'dirt', count: 3, type: 1 }] }))
    await bot.start({ pollMs: 0 })
  })
  afterEach(async () => { await bot.stop() })

  it('bestHarvestTool mirrors the lowest-digTime pick', () => {
    const calls = []
    const block = {
      digTime: (type, ...rest) => {
        calls.push([type, ...rest])
        return type === 2 ? 5 : 50
      },
    }
    bot._inventory = [{ name: 'dirt', type: 1 }, { name: 'stone_pickaxe', type: 2 }]
    assert.equal(bot.pathfinder.bestHarvestTool(block), bot._inventory[1])
    assert.deepEqual(calls[0], [1, false, false, false, [], undefined])
  })

  it('bestHarvestTool reads null until the world/inventory surfaces fill in', () => {
    assert.equal(bot.pathfinder.bestHarvestTool(null), null)
    assert.equal(bot.pathfinder.bestHarvestTool({ name: 'dirt' }), null) // no digTime yet (.6)
    bot._inventory = []
    assert.equal(bot.pathfinder.bestHarvestTool({ digTime: () => 1 }), null) // empty pack (.8)
    assert.equal(bot.pathfinder.bestHarvestTool({ digTime: () => { throw new Error('x') } }), null)
  })

  it('getPathTo is a sync noPath stub', () => {
    assert.deepEqual(bot.pathfinder.getPathTo({}, new goals.GoalNear(1, 2, 3, 1)), {
      status: 'noPath',
      path: [],
    })
  })
})

describe('follow.js unchanged through the adapter (FakeTransport walk)', () => {
  it('issues, walks (fake #goto), rests in range, re-issues when the target leaves', async () => {
    const { transport, bot } = pathBot()
    await bot.start({ pollMs: 0 })
    try {
      const gotos = []
      const orig = transport.call.bind(transport)
      transport.call = async (method, params) => {
        if (method === 'baritone.cmd' && /^#goto/.test(params.command)) gotos.push(params.command)
        return orig(method, params)
      }
      const ctx = {}
      // The ticker wiring (index.js): adapter path events feed ctx.
      bot.on('path_update', (r) => { ctx.lastPathStatus = r && r.status })
      const target = { username: 'Owner', id: 7, position: new Vec3(10, 64, 10) }

      follow(bot, ctx, target) // fresh key: issues GoalFollow
      assert.ok(bot.pathfinder.goal, 'goal stored')
      assert.equal(transport.state.baritone, '#goto 10.0 64.0 10.0')
      await sleep(10)
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
      assert.deepEqual(gotos, ['#goto 10.0 64.0 10.0', '#goto 30.0 64.0 30.0']) // one #goto per re-issue
    } finally {
      await bot.stop()
    }
  })
})

describe('console backend (rig proof without the mod)', () => {
  it('setGoal sends msg #goto lines, stop sends #stop + path_reset', async () => {
    const lines = []
    const bot = new BaritoneBot(new FakeTransport(), {
      Vec3,
      registry: REGISTRY,
      backend: 'console',
      bridgeSend: async (line) => { lines.push(line) },
    })
    const resets = []
    bot.on('path_reset', (r) => resets.push(r))
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
      assert.deepEqual(resets, ['stopped'])
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
      bot.pathfinder.setGoal(new goals.GoalInvert(new goals.GoalBlock(1, 2, 3)))
      assert.deepEqual(statuses, ['noPath'])
    } finally {
      await bot.stop()
    }
  })
})
