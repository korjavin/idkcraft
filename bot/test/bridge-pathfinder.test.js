'use strict'

// idkcraft-neuc.4: pathfinder parity on Baritone — goal-id attribution,
// GoalFollow re-issue, goal class mapping, Movements->#set map,
// bestHarvestTool/getPathTo shims. FakeTransport = the mod.
const { describe, it, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert/strict')

const { BaritoneBot, goalToBaritone, movementsToSettings } = require('../src/bridge/index')
const { FakeTransport } = require('../src/bridge/transport')
const { goals } = require('mineflayer-pathfinder')
const Vec3 = require('vec3')
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
  it('maps place/look goals to the neighbour on the bot side, never into p', () => {
    const world = { getBlock: () => null }
    const place = () => new goals.GoalPlaceBlock(new Vec3(7, 64, 8), world, { range: 4 })
    // Level or below: GoalXZ — stand on the surface beside, never into ground.
    assert.equal(goalToBaritone(place(), new Vec3(10, 64, 8)), '#goto 8 8') // bot east
    assert.equal(goalToBaritone(place(), new Vec3(7, 64, 3)), '#goto 7 7') // bot north
    assert.equal(goalToBaritone(place(), new Vec3(7, 70, 8)), '#goto 8 8') // bot above: descend beside
    // Roof height: GoalBlock — pillar to reach, like v1's executor.
    assert.equal(goalToBaritone(place(), new Vec3(10, 60, 8)), '#goto 8 64 8')
    // Near-above (rows 2-3): GoalXZ — v1 places those from the ground.
    assert.equal(goalToBaritone(place(), new Vec3(10, 62, 8)), '#goto 8 8')
    assert.equal(
      goalToBaritone(new goals.GoalLookAtBlock(new Vec3(7, 64, 8), world), new Vec3(4, 64, 8)),
      '#goto 6 8',
    )
    // Our own column at any level: null, never a silent in-goal #goto.
    assert.equal(
      goalToBaritone(new goals.GoalLookAtBlock(new Vec3(1, 64, 0), world), new Vec3(0, 64, 0)),
      null,
    )
    assert.equal(
      goalToBaritone(new goals.GoalLookAtBlock(new Vec3(1, 64, 0), world), new Vec3(0, 70, 0)),
      null,
    )
    assert.equal(
      goalToBaritone(new goals.GoalLookAtBlock(new Vec3(1, 66, 0), world), new Vec3(0, 64, 0)),
      null,
    )
    // Degenerate range (negative survives the constructor default): the
    // GoalBlock cell is our own feet, so null as well.
    const tiny = new goals.GoalPlaceBlock(new Vec3(1, 64, 0), world, { range: -1 })
    assert.equal(goalToBaritone(tiny, new Vec3(0, 64, 0)), null)
    assert.equal(goalToBaritone(place(), null), null) // no safe side without feet
    assert.equal(goalToBaritone(place(), {}), null)
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

  it('a failed command fails the goal, logs, never emits error', async () => {
    const orig = transport.call.bind(transport)
    transport.call = async (method, params) => {
      if (method === 'baritone.cmd') throw new Error('bridge down')
      return orig(method, params)
    }
    const lines = []
    const origLog = console.log
    console.log = (l) => { lines.push(String(l)) }
    try {
      bot.pathfinder.setGoal(new goals.GoalNear(9, 64, 9, 2))
      await sleep(10)
    } finally {
      console.log = origLog
      transport.call = orig
    }
    assert.deepEqual(seen.statuses, ['noPath'])
    assert.deepEqual(seen.resets, ['noPath'])
    assert.equal(bot.pathfinder.isMoving(), false)
    assert.deepEqual(seen.errors, []) // runOnce fatal()s every 'error'
    assert.ok(lines.some((l) => l.includes('bridge baritone.cmd failed')))
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
    // Unsatisfied (the fake walk landed the feet in the inner block).
    bot.pathfinder.setGoal(new goals.GoalInvert(new goals.GoalBlock(9, 64, 9)))
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

describe('already-satisfied goals succeed without a command (revmux 01 core-1)', () => {
  let transport
  let bot
  let seen
  beforeEach(async () => {
    ({ transport, bot } = pathBot())
    seen = taps(bot)
    await bot.start({ pollMs: 0 })
  })
  afterEach(async () => { await bot.stop() })

  it('a goal ending at the live feet emits success and sends nothing', async () => {
    bot.pathfinder.setGoal(new goals.GoalBlock(0, 64, 0)) // feet are (0, 64, 0)
    await sleep(10)
    assert.equal(transport.state.baritone, null)
    assert.deepEqual(seen.statuses, ['success'])
    assert.deepEqual(seen.resets, ['goal reached'])
    assert.equal(bot.pathfinder.isMoving(), false)
    assert.ok(bot.pathfinder.goal, 'goal stored')
  })

  it('in-range near/follow goals never reach Baritone', async () => {
    bot.pathfinder.setGoal(new goals.GoalNear(1, 64, 0, 3))
    await sleep(10)
    assert.equal(transport.state.baritone, null)
    assert.deepEqual(seen.statuses, ['success'])
    const target = { username: 'Owner', id: 7, position: new Vec3(1, 64, 0) }
    bot.pathfinder.setGoal(new goals.GoalFollow(target, 3), true)
    await sleep(10)
    assert.equal(transport.state.baritone, null)
    assert.deepEqual(seen.statuses, ['success', 'success'])
    assert.equal(bot._follow, null) // nothing to refresh mid-walk
  })

  it('the short-circuit stops a live walk first, like every setGoal', async () => {
    bot.pathfinder.setGoal(new goals.GoalNear(9, 64, 9, 2))
    await sleep(10)
    await bot.refresh() // motion witnessed for id 1
    // Feet faked back under the new goal (a teleport, a push): the walk dies.
    transport.state.pos = { x: 0, y: 64, z: 0, yaw: 0, pitch: 0, onGround: true }
    transport.state.baritonePhase = null
    transport.state.baritoneStatus = { id: 1, pathing: true, last: 'none' } // still walking
    await bot.refresh()
    bot.pathfinder.setGoal(new goals.GoalBlock(0, 64, 0))
    await sleep(10)
    assert.equal(transport.state.baritone, '#stop')
    assert.deepEqual(seen.statuses, ['success'])
    assert.deepEqual(seen.resets, ['goal reached'])
    transport.inject('baritone.event', { id: 1, status: 'success' }) // late: stale
    assert.deepEqual(seen.statuses, ['success'])
  })

  it('an isEnd that throws walks normally (worldless look goal)', async () => {
    // Reach gate passes, then the null world throws: caught, adjacency fails, walk.
    const g = new goals.GoalLookAtBlock(new Vec3(2, 64, 0), null)
    bot.pathfinder.setGoal(g)
    await sleep(10)
    assert.equal(transport.state.baritone, '#goto 1 0') // surface beside, level with p
    assert.deepEqual(seen.statuses, [])
  })

  it('a look one step away succeeds (the walk would target our own feet)', async () => {
    const g = new goals.GoalLookAtBlock(new Vec3(1, 64, 0), null)
    bot.pathfinder.setGoal(g)
    await sleep(10)
    assert.equal(transport.state.baritone, null)
    assert.deepEqual(seen.statuses, ['success'])
    assert.deepEqual(seen.resets, ['goal reached'])
  })

  it('standing in the placement cell walks out (world), like v1', async () => {
    const world = { getBlock: () => null }
    const g = new goals.GoalPlaceBlock(new Vec3(0, 64, 0), world, { range: 4 })
    bot.pathfinder.setGoal(g)
    await sleep(10)
    assert.equal(transport.state.baritone, '#goto 1 0') // +x step out, GoalXZ at level
    assert.deepEqual(seen.statuses, [])
  })

  it('p at head height walks, never instant-succeeds (worldless)', async () => {
    const g = new goals.GoalLookAtBlock(new Vec3(0, 65, 0), null)
    bot.pathfinder.setGoal(g)
    await sleep(10)
    assert.equal(transport.state.baritone, '#goto 1 0') // +x side, GoalXZ near-above
    assert.deepEqual(seen.statuses, [])
  })

  it('an above-feet neighbour in our own column fails visibly, never silently', async () => {
    // Near-above takes the GoalXZ branch, which counts any Y in the column.
    const g = new goals.GoalLookAtBlock(new Vec3(1, 66, 0), { raycast: () => null })
    bot.pathfinder.setGoal(g)
    await sleep(10)
    assert.equal(transport.state.baritone, null)
    assert.deepEqual(seen.statuses, ['noPath'])
    assert.deepEqual(seen.resets, ['noPath'])
  })

  it('a below-feet neighbour column fails visibly, never silently', async () => {
    // Cardinally adjacent in XZ, p below: GoalXZ would target our own column.
    const { transport: t2, bot: b2 } = pathBot({
      pos: { x: 0, y: 70, z: 0, yaw: 0, pitch: 0, onGround: true },
    })
    const seen2 = taps(b2)
    await b2.start({ pollMs: 0 })
    try {
      const g = new goals.GoalLookAtBlock(new Vec3(1, 64, 0), { raycast: () => null })
      b2.pathfinder.setGoal(g)
      await sleep(10)
      assert.equal(t2.state.baritone, null)
      assert.deepEqual(seen2.statuses, ['noPath'])
      assert.deepEqual(seen2.resets, ['noPath'])
    } finally {
      await b2.stop()
    }
  })

  it('adjacent with a clean isEnd=false fails visibly, never silently', async () => {
    // World says no line of sight; the neighbour step would land on us.
    const world = { raycast: () => null }
    const g = new goals.GoalLookAtBlock(new Vec3(1, 64, 0), world)
    bot.pathfinder.setGoal(g)
    await sleep(10)
    assert.equal(transport.state.baritone, null)
    assert.deepEqual(seen.statuses, ['noPath'])
    assert.deepEqual(seen.resets, ['noPath'])
  })

  it('follow with the target already in range sends no #goto', async () => {
    const ctx = {}
    bot.on('path_update', (r) => { ctx.lastPathStatus = r && r.status })
    const target = { username: 'Owner', id: 7, position: new Vec3(1, 64, 0) }
    follow(bot, ctx, target) // fresh key, in range: instant success
    await sleep(10)
    assert.equal(transport.state.baritone, null)
    assert.equal(ctx.lastPathStatus, 'success')
    follow(bot, ctx, target) // rest, still nothing sent
    await sleep(10)
    assert.equal(transport.state.baritone, null)
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

  it('a late terminal for the superseded goal drops after a re-issue', async () => {
    const target = { username: 'Owner', id: 7, position: new Vec3(10, 64, 10) }
    bot.pathfinder.setGoal(new goals.GoalFollow(target, 3), true)
    await sleep(10)
    transport.state.baritonePhase = null
    transport.state.baritoneStatus = { id: 1, pathing: true, last: 'none' }
    await bot.refresh() // motion round; arm live
    // Hold the re-issue echo: the send→bind window stays open on purpose.
    const orig = transport.call.bind(transport)
    let releaseEcho = () => {}
    transport.call = async (method, params) => {
      const r = await orig(method, params)
      if (method === 'baritone.cmd' && transport.state.baritoneSeq === 2) {
        await new Promise((res) => { releaseEcho = res })
      }
      return r
    }
    try {
      target.position = new Vec3(30, 64, 30)
      bot._follow.at -= 1500
      const statuses = []
      const resets = []
      bot.on('path_update', (r) => statuses.push(r.status))
      bot.on('path_reset', (r) => resets.push(r))
      await bot.refresh() // re-issue sends; id 2 parked in flight
      assert.equal(transport.state.baritoneSeq, 2)
      transport.inject('baritone.event', { id: 1, status: 'success' }) // late: stale now
      assert.deepEqual(statuses, [])
      assert.deepEqual(resets, [])
      assert.ok(bot._follow, 'arm survives the stale terminal')
      assert.equal(bot.pathfinder.isMoving(), true)
      releaseEcho()
      await sleep(10)
      assert.equal(bot._goalId, 2) // the new echo binds
      transport.inject('baritone.event', { id: 2, status: 'success' }) // the live goal completes
      assert.deepEqual(statuses, ['success'])
      assert.deepEqual(resets, ['goal reached'])
    } finally {
      transport.call = orig
    }
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

