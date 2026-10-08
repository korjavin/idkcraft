'use strict'

// Night deep-water entry cost (idkcraft-vmzq.44): at night, moves landing in
// deep water (2+ deep) pay NIGHT_WATER_COST so legs detour on land or hold
// ashore; day costs are unchanged. Real Movements + A* on a scripted fake
// world, wired through the production sites (ticker.setMovements for the
// swim stack, body.movementsFor for the clock-gated cost — same shape as
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
const { addNightWaterCost, NIGHT_WATER_COST } = require('../src/swim')

// River 6 wide (x=4..9, surface feet y=62, 3 deep: water 60..62) between flat
// banks flush with the surface (feet y=63). opts.bridgeAt builds a dry land
// bridge (grass across the river at bank level) at that z; opts.shallow makes
// the river 1-deep (water 62 only, dirt 61) so entries stay cheap at night.
function makeNameAt({ bridgeAt = null, shallow = false } = {}) {
  return function nameAt(x, y, z) {
    if (bridgeAt !== null && z === bridgeAt && x >= 4 && x <= 9) {
      if (y < 62) return 'dirt'
      if (y === 62) return 'grass_block'
      return 'air'
    }
    const river = x >= 4 && x <= 9
    if (river) {
      if (shallow) {
        if (y < 61) return 'stone'
        if (y === 61) return 'dirt'
        if (y === 62) return 'water'
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
// lease claim (inside setMovements) installs danger + night costs via
// body.movementsFor. The bot clock is live on the bot object.
function wiredMovements(nameFn, timeOfDay) {
  const bot = worldBot(nameFn, timeOfDay)
  const ticker = createTicker({ bot, brain: mockBrain(), tickMs: 10, idleTickMs: 10 })
  const movements = new Movements(bot)
  movements.allowSprinting = false
  ticker.setMovements(movements)
  return { bot, movements }
}

// Master baseline: identical wiring with the night-cost install suppressed
// (pre-marked, so movementsFor skips it like an already-installed wrapper).
// Day plans through the two stacks must be identical.
function masterMovements(nameFn, timeOfDay) {
  const bot = worldBot(nameFn, timeOfDay)
  const ticker = createTicker({ bot, brain: mockBrain(), tickMs: 10, idleTickMs: 10 })
  const movements = new Movements(bot)
  movements.allowSprinting = false
  movements._nightWaterCostInstalled = true
  ticker.setMovements(movements)
  return { bot, movements }
}

function plan(movements, sx, sy, sz, gx, gy, gz) {
  const astar = new AStar(new Move(sx, sy, sz, 0, 0), movements, new goals.GoalBlock(gx, gy, gz), 30000, 90000)
  return astar.compute()
}

const hash = (ns) => ns.map((m) => `${m.hash}=${m.cost}`).sort().join(' ')

describe('night deep-water entry cost (idkcraft-vmzq.44)', () => {
  it('at night deep entries pay, shallow/dry/exit moves do not', () => {
    const nameFn = makeNameAt({})
    const { movements } = wiredMovements(nameFn, 18000)
    // Dry bank -> deep surface: the (3,63,0)->(4,62,1) level lip diagonal
    // (the straight (4,62,0) is a dive; the diagonals skim the surface).
    const entry = movements.getNeighbors(new Move(3, 63, 0, 0, 0))
    const wet = entry.find((m) => m.x === 4 && m.y === 62 && m.z === 1)
    assert.ok(wet, 'the lip entry exists')
    const { movements: day } = wiredMovements(nameFn, 6000)
    const dayWet = day.getNeighbors(new Move(3, 63, 0, 0, 0)).find((m) => m.x === 4 && m.y === 62 && m.z === 1)
    assert.equal(wet.cost, dayWet.cost + NIGHT_WATER_COST)
    // Dry bank -> dry bank: unchanged.
    const dry = entry.find((m) => m.x === 2 && m.y === 63 && m.z === 0)
    const dayDry = day.getNeighbors(new Move(3, 63, 0, 0, 0)).find((m) => m.x === 2 && m.y === 63 && m.z === 0)
    assert.ok(dry && dayDry, 'flat dry edges exist')
    assert.equal(dry.cost, dayDry.cost)
    // Wet surface -> dry bank: the exit stays cheap (caught-out bodies leave).
    const exit = movements.getNeighbors(new Move(9, 62, 0, 0, 0)).find((m) => m.x === 10 && m.y === 63 && m.z === 0)
    const dayExit = day.getNeighbors(new Move(9, 62, 0, 0, 0)).find((m) => m.x === 10 && m.y === 63 && m.z === 0)
    assert.ok(exit && dayExit, 'the bank exit exists')
    assert.equal(exit.cost, dayExit.cost)
    // Shallow river (1-deep, solid below): entries stay cheap at night.
    const shallowFn = makeNameAt({ shallow: true })
    const night = wiredMovements(shallowFn, 18000).movements
    const nightEntry = night.getNeighbors(new Move(3, 63, 0, 0, 0)).find((m) => m.x === 4 && m.y === 62 && m.z === 1)
    const dayEntry = wiredMovements(shallowFn, 6000).movements
      .getNeighbors(new Move(3, 63, 0, 0, 0)).find((m) => m.x === 4 && m.y === 62 && m.z === 1)
    assert.ok(nightEntry && dayEntry, 'the shallow entry exists')
    assert.equal(nightEntry.cost, dayEntry.cost, 'wading never pays')
  })

  it('the gate follows the MC clock: night pays, dusk/day/unknown do not', () => {
    const nameFn = makeNameAt({})
    const costAt = (tod) => {
      const { movements } = wiredMovements(nameFn, tod)
      const m = movements.getNeighbors(new Move(3, 63, 0, 0, 0)).find((x) => x.x === 4 && x.y === 62 && x.z === 1)
      assert.ok(m, `entry exists at tod=${tod}`)
      return m.cost
    }
    const day = costAt(6000)
    assert.equal(costAt(0), day, 'dawn is day')
    assert.equal(costAt(11999), day, 'last day tick')
    assert.equal(costAt(12000), day, 'dusk stays cheap')
    assert.equal(costAt(13000), day, 'last dusk tick stays cheap')
    assert.equal(costAt(13001), day + NIGHT_WATER_COST, 'first night tick pays')
    assert.equal(costAt(18000), day + NIGHT_WATER_COST, 'midnight pays')
    assert.equal(costAt(23999), day + NIGHT_WATER_COST, 'last night tick pays')
    // Unknown clocks read as day (goalFacts precedent): no bot.time at all.
    const { movements } = wiredMovements(nameFn, undefined)
    const m = movements.getNeighbors(new Move(3, 63, 0, 0, 0)).find((x) => x.x === 4 && x.y === 62 && x.z === 1)
    assert.equal(m.cost, day, 'missing clock reads as day')
  })

  it('day plans are identical to master (the wrapper no-ops off-night)', () => {
    // Neighbors: every cost on bank, surface and dry nodes matches master.
    const nameFn = makeNameAt({})
    const { movements } = wiredMovements(nameFn, 6000)
    const { movements: master } = masterMovements(nameFn, 6000)
    for (const [x, y, z] of [[0, 63, 0], [3, 63, 0], [5, 62, 0], [9, 62, 0], [12, 63, 0]]) {
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
    // (~14 moves) but beats the night swim (+60 water penalty).
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

  it('a forced night crossing still plans (cost, never a ban)', () => {
    const night = wiredMovements(makeNameAt({}), 18000).movements
    const r = plan(night, 0, 63, 0, 14, 63, 0)
    assert.equal(r.status, 'success')
    const last = r.path[r.path.length - 1]
    assert.deepEqual([last.x, last.y, last.z], [14, 63, 0])
    assert.ok(r.path.some((p) => p.y < 63), 'no land alternative: still swims')
  })

  it('install is idempotent and plain-object safe', () => {
    const { movements } = wiredMovements(makeNameAt({}), 18000)
    const before = hash(movements.getNeighbors(new Move(3, 63, 0, 0, 0)))
    addNightWaterCost(movements, { time: { timeOfDay: 18000 } }) // second install: no double charge
    assert.equal(hash(movements.getNeighbors(new Move(3, 63, 0, 0, 0))), before)
    assert.doesNotThrow(() => addNightWaterCost({ allowSprinting: false }, { time: { timeOfDay: 18000 } }))
    assert.doesNotThrow(() => addNightWaterCost(null, null))
    // movementsFor installs once per Movements like danger.addPathCost.
    const bot = worldBot(makeNameAt({}), 18000)
    const ctx = { movements: new Movements(bot) }
    body.movementsFor('idle', bot, ctx)
    const wrapped = ctx.movements.getNeighbors
    body.movementsFor('idle', bot, ctx)
    assert.equal(ctx.movements.getNeighbors, wrapped)
  })
})
