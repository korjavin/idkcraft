'use strict'

// Night deep-water entry cost (idkcraft-vmzq.44): at night, WORK-mode legs
// pay NIGHT_WATER_COST per move landing in deep water (2+ column), so they
// detour on land when one exists; water-only targets stay reachable (a
// forced crossing pays and completes — bounded cost, verifier scope). Follow
// (ambient idle owner, never claims), orders, recover, breath and day/dusk
// pay nothing. Real Movements + A* on a scripted fake world, wired through
// the production stack (index.js setMovements wrapper order) plus
// body.movementsFor for the clock+owner-gated cost.

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const { Vec3 } = require('vec3')
const mcData = require('minecraft-data')('1.21.4')
const Block = require('prismarine-block')(mcData)
const { Movements, goals } = require('mineflayer-pathfinder')
const AStar = require('mineflayer-pathfinder/lib/astar')
const Move = require('mineflayer-pathfinder/lib/move')
const body = require('../src/body')
const doors = require('../src/doors')
const { addNoCornerCut } = require('../src/nocorner')
const { addSnowGround } = require('../src/snow')
const { addJumpUpCost } = require('../src/jumpcost')
const { addSwimExits, addSwimPrune, addNightWaterCost, NIGHT_WATER_COST } = require('../src/swim')

// River 6 wide (x=4..9, surface feet y=62, 3 deep: water 60..62) between flat
// banks flush with the surface (feet y=63). opts.bridgeAt builds a dry land
// bridge (grass across the river at bank level) at that z; opts.twoDeep makes
// it exactly 2-deep (water 61..62 over stone 60); opts.shallow makes it 1-deep.
function makeNameAt({ bridgeAt = null, twoDeep = false, shallow = false } = {}) {
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

// Production wiring with a controlled owner: the index.js setMovements
// wrapper order, then body.movementsFor (danger + night cost) on our own ctx
// so tests flip ctx.body.owner live, the way claims do.
function installStack(movements) {
  doors.banDoorBreaks(movements)
  doors.addDoorPassages(movements)
  addSwimExits(movements)
  addSwimPrune(movements)
  addNoCornerCut(movements)
  addSnowGround(movements)
  addJumpUpCost(movements)
}

function wiredMovements(nameFn, timeOfDay, owner) {
  const bot = worldBot(nameFn, timeOfDay)
  const movements = new Movements(bot)
  movements.allowSprinting = false
  installStack(movements)
  const ctx = { movements, body: { owner } }
  body.movementsFor(owner, bot, ctx)
  return { bot, movements, ctx }
}

// Master baseline: identical wiring with the night-cost install suppressed
// (pre-marked, so movementsFor skips it like an already-installed wrapper).
function masterMovements(nameFn, timeOfDay, owner = 'work') {
  const bot = worldBot(nameFn, timeOfDay)
  const movements = new Movements(bot)
  movements.allowSprinting = false
  installStack(movements)
  movements._nightWaterCostInstalled = true
  const ctx = { movements, body: { owner } }
  body.movementsFor(owner, bot, ctx)
  return { bot, movements, ctx }
}

function plan(movements, sx, sy, sz, gx, gy, gz, timeout = 30000) {
  const astar = new AStar(new Move(sx, sy, sz, 0, 0), movements, new goals.GoalBlock(gx, gy, gz), timeout, 90000)
  return astar.compute()
}

const hash = (ns) => ns.map((m) => `${m.hash}=${m.cost}`).sort().join(' ')

describe('night deep-water entry cost, work-scoped (idkcraft-vmzq.44 R4)', () => {
  it('at night work pays per deep landing; dry/shallow moves do not', () => {
    const nameFn = makeNameAt({})
    const { movements } = wiredMovements(nameFn, 18000, 'work')
    const day = wiredMovements(nameFn, 6000, 'work').movements
    // The (3,63,0)->(4,62,1) level lip diagonal skims deep surface.
    const lip = (mov) => mov.getNeighbors(new Move(3, 63, 0, 0, 0)).find((m) => m.x === 4 && m.y === 62 && m.z === 1)
    assert.ok(lip(day) && lip(movements), 'the lip entry exists')
    assert.equal(lip(movements).cost, lip(day).cost + NIGHT_WATER_COST)
    // Deep cruises pay too (per-move steering, not entry-once).
    const cruise = (mov) => mov.getNeighbors(new Move(5, 62, 0, 0, 0)).find((m) => m.x === 6 && m.y === 62 && m.z === 0)
    assert.ok(cruise(day) && cruise(movements), 'the deep cruise exists')
    assert.equal(cruise(movements).cost, cruise(day).cost + NIGHT_WATER_COST)
    // Dry bank moves and shallow wading never pay.
    const dry = (mov) => mov.getNeighbors(new Move(3, 63, 0, 0, 0)).find((m) => m.x === 2 && m.y === 63 && m.z === 0)
    assert.equal(dry(movements).cost, dry(day).cost)
    const shallowFn = makeNameAt({ shallow: true })
    const wade = (mov) => mov.getNeighbors(new Move(3, 63, 0, 0, 0)).find((m) => m.x === 4 && m.y === 62 && m.z === 1)
    assert.equal(wade(wiredMovements(shallowFn, 18000, 'work').movements).cost, wade(wiredMovements(shallowFn, 6000, 'work').movements).cost, 'wading never pays')
    // 2-deep bottom cells read deep (wet above) and pay.
    const twoFn = makeNameAt({ twoDeep: true })
    const dive = (mov) => mov.getNeighbors(new Move(3, 63, 0, 0, 0)).find((m) => m.x === 4 && m.y === 61 && m.z === 0)
    const nd = wiredMovements(twoFn, 18000, 'work').movements
    const dd = wiredMovements(twoFn, 6000, 'work').movements
    assert.ok(dive(dd) && dive(nd), 'the 2-deep bank dive exists')
    assert.equal(dive(nd).cost, dive(dd).cost + NIGHT_WATER_COST)
  })

  it('only owner work pays: follow/idle/orders/recover/unknown are exempt, live', () => {
    const nameFn = makeNameAt({})
    const costOf = (tod, owner) => {
      const { movements } = wiredMovements(nameFn, tod, owner)
      const m = movements.getNeighbors(new Move(3, 63, 0, 0, 0)).find((x) => x.x === 4 && x.y === 62 && x.z === 1)
      assert.ok(m, `entry exists at tod=${tod} owner=${owner}`)
      return m.cost
    }
    const dayWork = costOf(6000, 'work')
    assert.equal(costOf(18000, 'work'), dayWork + NIGHT_WATER_COST, 'night work pays')
    for (const owner of ['idle', 'follow', 'fight', 'lead', 'bring', 'comehome', 'gocastle', 'shelter', 'recover', 'breath', undefined, null]) {
      assert.equal(costOf(18000, owner), dayWork, `night ${String(owner)} exempt (follow MUST cross)`)
    }
    // Live: flipping the lease on one install toggles the cost, no reinstall.
    const { movements, ctx } = wiredMovements(nameFn, 18000, 'work')
    const lip = () => movements.getNeighbors(new Move(3, 63, 0, 0, 0)).find((x) => x.x === 4 && x.y === 62 && x.z === 1).cost
    assert.equal(lip(), dayWork + NIGHT_WATER_COST)
    ctx.body.owner = 'idle' // follow runs ambient: same clock, cost gone
    assert.equal(lip(), dayWork)
    ctx.body.owner = 'work'
    assert.equal(lip(), dayWork + NIGHT_WATER_COST)
  })

  it('the gate follows the MC clock: night pays, dusk/day/unknown do not', () => {
    const nameFn = makeNameAt({})
    const costAt = (tod) => {
      const { movements } = wiredMovements(nameFn, tod, 'work')
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
    assert.equal(costAt(undefined), day, 'missing clock reads as day')
  })

  it('(c) day plans are identical to master (the wrapper no-ops off-night)', () => {
    const nameFn = makeNameAt({})
    const { movements } = wiredMovements(nameFn, 6000, 'work')
    const { movements: master } = masterMovements(nameFn, 6000, 'work')
    for (const [x, y, z] of [[0, 63, 0], [3, 63, 0], [5, 62, 0], [9, 62, 0], [12, 63, 0]]) {
      assert.equal(hash(movements.getNeighbors(new Move(x, y, z, 0, 0))), hash(master.getNeighbors(new Move(x, y, z, 0, 0))), `neighbors match at ${x},${y},${z}`)
    }
    const r = plan(movements, 0, 63, 0, 14, 63, 0)
    const m = plan(master, 0, 63, 0, 14, 63, 0)
    assert.equal(r.status, 'success')
    assert.equal(m.status, 'success')
    assert.deepEqual(r.path.map((p) => [p.x, p.y, p.z]), m.path.map((p) => [p.x, p.y, p.z]))
    assert.equal(r.path.reduce((a, p) => a + p.cost, 0), m.path.reduce((a, p) => a + p.cost, 0))
  })

  it('(b) at night work detours over the land bridge; by day it crosses', () => {
    // Bridge at z=12: the dry detour (~29 moves) loses to the day swim
    // (~14 moves) but beats the night swim (+60 water penalty).
    const nameFn = makeNameAt({ bridgeAt: 12 })
    const night = wiredMovements(nameFn, 18000, 'work').movements
    const rn = plan(night, 0, 63, 0, 14, 63, 0)
    assert.equal(rn.status, 'success')
    assert.ok(rn.path.every((p) => p.y === 63), `night stays dry via the bridge: ${rn.path.map((p) => `${p.x},${p.y},${p.z}`).join(' ')}`)
    assert.ok(rn.path.some((p) => p.z === 12 && p.x >= 4 && p.x <= 9), 'night crosses on the bridge')
    const day = wiredMovements(nameFn, 6000, 'work').movements
    const rd = plan(day, 0, 63, 0, 14, 63, 0)
    assert.equal(rd.status, 'success')
    assert.ok(rd.path.some((p) => p.y < 63), 'day crosses through the water')
    // Follow at night takes the day line (exempt): crosses, no detour.
    const nf = wiredMovements(nameFn, 18000, 'idle').movements
    const rf = plan(nf, 0, 63, 0, 14, 63, 0)
    assert.equal(rf.status, 'success')
    assert.ok(rf.path.some((p) => p.y < 63), 'night follow crosses like day')
  })

  it('(a) a water-only night target stays reachable (bounded cost)', () => {
    // No bridge, river runs the whole z axis: the far bank needs a swim.
    // Finite cost steers, never blocks: the night work plan completes.
    const night = wiredMovements(makeNameAt({}), 18000, 'work').movements
    const r = plan(night, 0, 63, 0, 14, 63, 0)
    assert.equal(r.status, 'success')
    const last = r.path[r.path.length - 1]
    assert.deepEqual([last.x, last.y, last.z], [14, 63, 0])
    assert.ok(r.path.some((p) => p.y < 63), 'no land alternative: still swims')
  })

  it('install is idempotent and plain-object safe', () => {
    const { movements, ctx } = wiredMovements(makeNameAt({}), 18000, 'work')
    const before = hash(movements.getNeighbors(new Move(3, 63, 0, 0, 0)))
    addNightWaterCost(movements, { time: { timeOfDay: 18000 } }, ctx) // second install: no double charge
    assert.equal(hash(movements.getNeighbors(new Move(3, 63, 0, 0, 0))), before)
    assert.doesNotThrow(() => addNightWaterCost({ allowSprinting: false }, { time: { timeOfDay: 18000 } }, { body: { owner: 'work' } }))
    assert.doesNotThrow(() => addNightWaterCost(null, null, null))
    // movementsFor installs once per Movements like danger.addPathCost.
    const bot = worldBot(makeNameAt({}), 18000)
    const c2 = { movements: new Movements(bot), body: { owner: 'work' } }
    body.movementsFor('work', bot, c2)
    const wrapped = c2.movements.getNeighbors
    body.movementsFor('work', bot, c2)
    assert.equal(c2.movements.getNeighbors, wrapped)
  })
})
