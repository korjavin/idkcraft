'use strict'

// Night deep-water entry ban (idkcraft-vmzq.44): Noel's-arc "cross only by
// day" — at night, moves entering deep water (2+ deep from a dry or shallow
// source) are pruned, so legs detour on land or hold ashore; day plans are
// identical to master. Real Movements + A* on a scripted fake world, wired
// through the production sites (ticker.setMovements for the swim stack,
// body.movementsFor for the clock-gated prune — same shape as
// dangercost.test.js).

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const { Vec3 } = require('vec3')
const mcData = require('minecraft-data')('1.21.4')
const Block = require('prismarine-block')(mcData)
const { Movements, goals } = require('mineflayer-pathfinder')
const AStar = require('mineflayer-pathfinder/lib/astar')
const Move = require('mineflayer-pathfinder/lib/move')
const { createTicker } = require('../src/index')
const body = require('../src/body')
const { addNightWaterPrune } = require('../src/swim')

// River 6 wide (x=4..9, surface feet y=62, 3 deep: water 60..62) between flat
// banks flush with the surface (feet y=63). opts.bridgeAt builds a dry land
// bridge (grass across the river at bank level) at that z; opts.shelf makes
// x=4 a 1-deep wading shelf (water 62 over dirt 61) in front of deep x=5..9;
// opts.shallow makes the whole river 1-deep so wading never prunes;
// opts.twoDeep makes it exactly 2-deep (water 61..62 over stone 60).
function makeNameAt({ bridgeAt = null, shelf = false, shallow = false, twoDeep = false } = {}) {
  return function nameAt(x, y, z) {
    if (bridgeAt !== null && z === bridgeAt && x >= 4 && x <= 9) {
      if (y < 62) return 'dirt'
      if (y === 62) return 'grass_block'
      return 'air'
    }
    const river = x >= 4 && x <= 9
    if (river) {
      const oneDeep = shallow || (shelf && x === 4)
      if (oneDeep) {
        if (y < 61) return 'stone'
        if (y === 61) return 'dirt'
        if (y === 62) return 'water'
        return 'air'
      }
      if (twoDeep) {
        if (y < 61) return 'stone'
        if (y <= 62) return 'water'
        return 'air'
      }
      if (y < 60) return 'stone'
      if (y <= 62) return 'water'
      return 'air'
    }
    if (y < 60) return 'stone'
    if (y <= 61) return 'dirt'
    if (y === 62) return 'grass_block'
    return 'air'
  }
}

function blockAtFor(nameFn) {
  return (p) => {
    const b = Block.fromStateId(mcData.blocksByName[nameFn(p.x, p.y, p.z)].minStateId, 0)
    b.position = new Vec3(p.x, p.y, p.z)
    return b
  }
}

function worldBot(nameFn, timeOfDay) {
  const bot = {
    registry: mcData,
    game: { minY: -64 },
    entity: { effects: [] },
    pathfinder: { bestHarvestTool: () => null, setMovements() {}, setGoal() {}, stop() {}, isMoving: () => false },
    setControlState() {},
    clearControlStates: () => {},
    blockAt: (p) => blockAtFor(nameFn)(new Vec3(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z))),
  }
  if (timeOfDay !== undefined) bot.time = { timeOfDay }
  return bot
}

function mockBrain() {
  return { async decide() { return { action: 'follow', sprint: false, source: 'stub' } } }
}

// Production wiring: ticker.setMovements installs the swim stack, then the
// lease claim (inside setMovements) installs danger + the night prune via
// body.movementsFor. The bot clock is live on the bot object.
function wiredMovements(nameFn, timeOfDay) {
  const bot = worldBot(nameFn, timeOfDay)
  const ticker = createTicker({ bot, brain: mockBrain(), tickMs: 10, idleTickMs: 10 })
  const movements = new Movements(bot)
  movements.allowSprinting = false
  ticker.setMovements(movements)
  return { bot, movements }
}

// Master baseline: identical wiring with the night-prune install suppressed
// (pre-marked, so movementsFor skips it like an already-installed wrapper).
// Day plans through the two stacks must be identical.
function masterMovements(nameFn, timeOfDay) {
  const bot = worldBot(nameFn, timeOfDay)
  const ticker = createTicker({ bot, brain: mockBrain(), tickMs: 10, idleTickMs: 10 })
  const movements = new Movements(bot)
  movements.allowSprinting = false
  movements._nightWaterPruneInstalled = true
  ticker.setMovements(movements)
  return { bot, movements }
}

function plan(movements, sx, sy, sz, gx, gy, gz, timeout = 30000) {
  const astar = new AStar(new Move(sx, sy, sz, 0, 0), movements, new goals.GoalBlock(gx, gy, gz), timeout, 90000)
  return astar.compute()
}

const hash = (ns) => ns.map((m) => `${m.hash}=${m.cost}`).sort().join(' ')

describe('night deep-water entry ban (idkcraft-vmzq.44)', () => {
  it('at night dry->deep and shallow->deep entries prune; wading, exits and committed cruises stay', () => {
    const nameFn = makeNameAt({ shelf: true })
    const night = wiredMovements(nameFn, 18000).movements
    const day = wiredMovements(nameFn, 6000).movements
    // Dry bank -> deep, on the plain deep river: the (3,63,0)->(4,61,0)
    // bank dive (in the shelf world x=4/y=61 is shelf dirt, no dive there).
    const deepFn = makeNameAt({})
    const dive = (mov) => mov.getNeighbors(new Move(3, 63, 0, 0, 0)).find((m) => m.x === 4 && m.y === 61 && m.z === 0)
    assert.ok(dive(wiredMovements(deepFn, 6000).movements), 'day offers the bank dive')
    assert.ok(!dive(wiredMovements(deepFn, 18000).movements), 'night prunes the bank dive into deep')
    const lip = (mov) => mov.getNeighbors(new Move(3, 63, 0, 0, 0)).find((m) => m.x === 4 && m.y === 62 && m.z === 1)
    assert.ok(lip(day) && lip(night), 'the shelf lip stays day and night (wading)')
    // Shallow shelf -> deep: pruned at night (no hop-in via the shelf).
    const hop = (mov) => mov.getNeighbors(new Move(4, 62, 0, 0, 0)).filter((m) => m.x === 5 && m.y === 62)
    assert.ok(hop(day).length > 0, 'day cruises shelf->deep')
    assert.equal(hop(night).length, 0, 'night prunes shelf->deep')
    // Committed deep body: cruises and exits stay (swim OUT, not tread).
    const cruise = (mov) => mov.getNeighbors(new Move(5, 62, 0, 0, 0)).filter((m) => m.x === 6 && m.y === 62)
    assert.ok(cruise(day).length > 0 && cruise(night).length > 0, 'deep cruises stay at night')
    const exit = (mov) => mov.getNeighbors(new Move(9, 62, 0, 0, 0)).find((m) => m.x === 10 && m.y === 63 && m.z === 0)
    assert.ok(exit(day) && exit(night), 'the bank exit stays at night')
    // Dry land untouched.
    assert.equal(hash(night.getNeighbors(new Move(0, 63, 0, 0, 0))), hash(day.getNeighbors(new Move(0, 63, 0, 0, 0))))
  })

  it('the gate follows the MC clock: night prunes, dusk/day/unknown do not', () => {
    const nameFn = makeNameAt({})
    const hasDive = (tod) => {
      const { movements } = wiredMovements(nameFn, tod)
      return movements.getNeighbors(new Move(3, 63, 0, 0, 0)).some((m) => m.x === 4 && m.y === 61 && m.z === 0)
    }
    assert.equal(hasDive(0), true, 'dawn offers')
    assert.equal(hasDive(11999), true, 'last day tick offers')
    assert.equal(hasDive(12000), true, 'dusk offers')
    assert.equal(hasDive(13000), true, 'last dusk tick offers')
    assert.equal(hasDive(13001), false, 'first night tick prunes')
    assert.equal(hasDive(18000), false, 'midnight prunes')
    assert.equal(hasDive(23999), false, 'last night tick prunes')
    // Unknown clocks read as day (goalFacts precedent): no bot.time at all.
    assert.equal(hasDive(undefined), true, 'missing clock reads as day')
  })

  it('day plans are identical to master (the wrapper no-ops off-night)', () => {
    // Neighbors: every move on bank, shelf, surface and dry nodes matches.
    const nameFn = makeNameAt({ shelf: true })
    const { movements } = wiredMovements(nameFn, 6000)
    const { movements: master } = masterMovements(nameFn, 6000)
    for (const [x, y, z] of [[0, 63, 0], [3, 63, 0], [4, 62, 0], [5, 62, 0], [9, 62, 0], [12, 63, 0]]) {
      assert.equal(hash(movements.getNeighbors(new Move(x, y, z, 0, 0))), hash(master.getNeighbors(new Move(x, y, z, 0, 0))), `neighbors match at ${x},${y},${z}`)
    }
    // Plans: the same A* across the river returns the same path.
    const r = plan(movements, 0, 63, 0, 14, 63, 0)
    const m = plan(master, 0, 63, 0, 14, 63, 0)
    assert.equal(r.status, 'success')
    assert.equal(m.status, 'success')
    assert.deepEqual(r.path.map((p) => [p.x, p.y, p.z]), m.path.map((p) => [p.x, p.y, p.z]))
    assert.equal(r.path.reduce((a, p) => a + p.cost, 0), m.path.reduce((a, p) => a + p.cost, 0))
  })

  it('at night the planner detours over the land bridge; by day it crosses', () => {
    // Bridge at z=12: the dry detour (~29 moves) loses to the day swim
    // (~14 moves) but wins at night (deep entries pruned).
    const nameFn = makeNameAt({ bridgeAt: 12 })
    const night = wiredMovements(nameFn, 18000).movements
    const rn = plan(night, 0, 63, 0, 14, 63, 0)
    assert.equal(rn.status, 'success')
    assert.ok(rn.path.every((p) => p.y === 63), `night stays dry via the bridge: ${rn.path.map((p) => `${p.x},${p.y},${p.z}`).join(' ')}`)
    assert.ok(rn.path.some((p) => p.z === 12 && p.x >= 4 && p.x <= 9), 'night crosses on the bridge')
    const day = wiredMovements(nameFn, 6000).movements
    const rd = plan(day, 0, 63, 0, 14, 63, 0)
    assert.equal(rd.status, 'success')
    assert.ok(rd.path.some((p) => p.y < 63), 'day crosses through the water')
  })

  it('a forced night crossing holds dry (no swim planned); day crosses', () => {
    // No bridge, river runs the whole z axis: the far bank is unreachable
    // without a deep entry, so the night search must not return a swim.
    // Short budget: an unreachable goal on an infinite grid searches till
    // timeout (the rig equivalent of holding ashore, retried till day).
    const night = wiredMovements(makeNameAt({}), 18000).movements
    const rn = plan(night, 0, 63, 0, 14, 63, 0, 1000)
    assert.notEqual(rn.status, 'success', `night must not plan the swim (got ${rn.status})`)
    assert.ok(rn.path.every((p) => p.y === 63), 'the night partial stays ashore')
    const day = wiredMovements(makeNameAt({}), 6000).movements
    const rd = plan(day, 0, 63, 0, 14, 63, 0)
    assert.equal(rd.status, 'success')
    assert.ok(rd.path.some((p) => p.y < 63), 'day crosses')
  })

  it('exactly-2-deep water bans entries but keeps bottom rises (revmux 01)', () => {
    // core-1: the bottom cell of 2-deep (solid below, water above) must read
    // deep — else bank dives land there at night. body-1: the same bottom
    // body must read committed — else its rises prune and it sits till dawn.
    const nameFn = makeNameAt({ twoDeep: true })
    const night = wiredMovements(nameFn, 18000).movements
    const day = wiredMovements(nameFn, 6000).movements
    const dive = (mov) => mov.getNeighbors(new Move(3, 63, 0, 0, 0)).find((m) => m.x === 4 && m.y === 61 && m.z === 0)
    assert.ok(dive(day), 'day offers the 2-deep bank dive')
    assert.ok(!dive(night), 'night prunes the 2-deep bank dive')
    const bottom = new Move(5, 61, 0, 0, 0)
    const rises = (mov) => mov.getNeighbors(bottom).filter((m) => m.y === 62 && Math.abs(m.x - 5) + Math.abs(m.z) === 1)
    assert.ok(rises(day).length > 0, 'day rises from the 2-deep bottom')
    assert.deepEqual(
      rises(night).map((m) => m.hash).sort(),
      rises(day).map((m) => m.hash).sort(),
      'a bottom body keeps every rise at night (committed)'
    )
    const cruise = (mov) => mov.getNeighbors(bottom).filter((m) => m.x === 6 && m.y === 61)
    assert.ok(cruise(day).length > 0 && cruise(night).length > 0, 'bottom cruises stay at night')
  })

  it('install is idempotent and plain-object safe', () => {
    const { movements } = wiredMovements(makeNameAt({}), 18000)
    const before = hash(movements.getNeighbors(new Move(3, 63, 0, 0, 0)))
    addNightWaterPrune(movements, { time: { timeOfDay: 18000 } }) // second install: same filter
    assert.equal(hash(movements.getNeighbors(new Move(3, 63, 0, 0, 0))), before)
    assert.doesNotThrow(() => addNightWaterPrune({ allowSprinting: false }, { time: { timeOfDay: 18000 } }))
    assert.doesNotThrow(() => addNightWaterPrune(null, null))
    // movementsFor installs once per Movements like danger.addPathCost.
    const bot = worldBot(makeNameAt({}), 18000)
    const ctx = { movements: new Movements(bot) }
    body.movementsFor('idle', bot, ctx)
    const wrapped = ctx.movements.getNeighbors
    body.movementsFor('idle', bot, ctx)
    assert.equal(ctx.movements.getNeighbors, wrapped)
  })
})
