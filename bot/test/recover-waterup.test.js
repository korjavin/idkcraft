'use strict'

// water_up menu wiring (idkcraft-jsf.2): the bare-pit bucket climber sits in
// RECOVER_ORDER after pillar_up/dig_up and before dig_step, with facts
// bucket (count), combo (a climbable A+B pour pair) and wall2 (a 2-high
// wall beside the body — the one-side pit gate for goalless backstops).

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const { Vec3 } = require('vec3')
const recover = require('../src/behaviours/recover')
const { BEHAVIOURS } = require('../src/index')

function pos(x, y, z) {
  return {
    x, y, z,
    distanceTo: (q) => Math.hypot(x - q.x, y - q.y, z - q.z),
    clone() { return pos(x, y, z) },
  }
}

function key(x, y, z) { return `${x},${y},${z}` }

// Open shaft world (mirrors waterup.test.js): floor top 61, shaft (0,61..70,0)
// open to the sky, stone walls, alcove dest (1,67,0) with solid below and a
// side ref. A pours at (0,66,0), B at (1,67,0).
function shaftWorld() {
  const solids = new Set()
  for (let x = -3; x <= 4; x++) {
    for (let z = -3; z <= 3; z++) {
      for (let y = 55; y <= 60; y++) solids.add(key(x, y, z))
    }
  }
  for (let y = 61; y <= 70; y++) {
    for (let x = -3; x <= 4; x++) {
      for (let z = -3; z <= 3; z++) {
        if (x === 0 && z === 0) continue
        if (x === 1 && z === 0 && y >= 67 && y <= 68) continue
        solids.add(key(x, y, z))
      }
    }
  }
  return { solids, waters: new Set(), lavas: new Set() }
}

function worldBot(world, items) {
  const { solids, waters, lavas } = world
  return {
    username: 'IdkBot',
    players: {},
    entity: { position: pos(0.5, 61, 0.5), onGround: true, isInWater: false },
    inventory: { items: () => items },
    setControlState() {},
    blockAt(p) {
      const k = key(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z))
      const name = waters.has(k) ? 'water' : lavas.has(k) ? 'lava' : solids.has(k) ? 'stone' : 'air'
      const solidCell = solids.has(k)
      return {
        name,
        position: new Vec3(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)),
        boundingBox: solidCell ? 'block' : 'empty',
      }
    },
    pathfinder: { goal: null, setGoal() {}, stop() {}, isMoving: () => false },
    chat() {},
  }
}

function menuNames(bot, stuck) {
  const ctx = { stuck: stuck || { by: 'test', goal: null }, stuckTicks: 12 }
  const facts = recover.recoverFacts(bot, ctx, null, null)
  const names = recover.RECOVER_ORDER.filter((n) => {
    try { return recover.RECOVER_MENU[n].feasible(facts, ctx) } catch (_) { return false }
  })
  return { facts, names }
}

describe('water_up wiring', () => {
  it('menu shape: ORDER, CRITERIA and MENU agree, water_up rides third', () => {
    assert.deepEqual(Object.keys(recover.RECOVER_CRITERIA).sort(), [...recover.RECOVER_ORDER].sort())
    assert.deepEqual(Object.keys(recover.RECOVER_MENU).sort(), [...recover.RECOVER_ORDER].sort())
    const i = recover.RECOVER_ORDER.indexOf('water_up')
    assert.ok(i > recover.RECOVER_ORDER.indexOf('dig_up'), 'after the scaffold/pickaxe climbers')
    assert.ok(i < recover.RECOVER_ORDER.indexOf('dig_step'), 'before the digging climber')
    assert.equal(recover.RECOVER_MENU.water_up.verb, 'pouring water to swim up')
    assert.equal(typeof BEHAVIOURS.water_up, 'function')
  })

  it('facts text carries bucket=yes only with a pair', () => {
    const t2 = recover.recoverText({ goalDy: 0, goalDist: null, scaffold: 0, pickaxe: false, bucket: 2, water: false, headBlocked: false, walls: 4, pit: true, playerOnline: false, playerDist: null, stuckTicks: 12, resetsStuck: 0, resetsPlaceError: 0, last: 'none' })
    assert.match(t2, /bucket=yes/)
    const t1 = recover.recoverText({ goalDy: 0, goalDist: null, scaffold: 0, pickaxe: false, bucket: 1, water: false, headBlocked: false, walls: 4, pit: true, playerOnline: false, playerDist: null, stuckTicks: 12, resetsStuck: 0, resetsPlaceError: 0, last: 'none' })
    assert.match(t1, /bucket=no/)
    // Old literal facts without the field read as no bucket (menu unchanged).
    const t0 = recover.recoverText({ goalDy: 0, goalDist: 5, scaffold: 0, pickaxe: false, water: false, headBlocked: false, walls: 0, pit: false, playerOnline: false, playerDist: null, stuckTicks: 12, resetsStuck: 0, resetsPlaceError: 0, last: 'none' })
    assert.match(t0, /bucket=no/)
  })

  it('bare shaft + bucket pair offers water_up', () => {
    const bot = worldBot(shaftWorld(), [{ name: 'water_bucket', count: 2 }])
    const { facts, names } = menuNames(bot)
    assert.equal(facts.bucket, 2)
    assert.equal(facts.pit, true)
    assert.equal(facts.combo, true)
    assert.equal(facts.wall2, true)
    assert.ok(names.includes('water_up'))
  })

  it('one-sided shaft + high goal offers water_up (pit reads false there)', () => {
    // The CLUSTER shaft: a single hemmed side (pit=false under jsf.3's 2-side
    // rule) with a climbable combo — the replay acceptance geometry.
    const world = shaftWorld()
    for (let y = 61; y <= 70; y++) {
      world.solids.delete(key(-1, y, 0))
      world.solids.delete(key(0, y, 1))
      world.solids.delete(key(0, y, -1))
    }
    const bot = worldBot(world, [{ name: 'water_bucket', count: 2 }])
    const stuck = { by: 'test', goal: { x: 0, y: 70, z: 8 } }
    const { facts, names } = menuNames(bot, stuck)
    assert.equal(facts.pit, false)
    assert.equal(facts.wall2, true)
    assert.equal(facts.combo, true)
    assert.ok(names.includes('water_up'))
  })

  it('known level goal never climbs the one-way door', () => {
    const bot = worldBot(shaftWorld(), [{ name: 'water_bucket', count: 2 }])
    const stuck = { by: 'test', goal: { x: 8, y: 61, z: 0 } }
    const { facts, names } = menuNames(bot, stuck)
    assert.equal(facts.combo, true)
    assert.ok(!names.includes('water_up'))
  })

  it('one bucket is not an offer', () => {
    const bot = worldBot(shaftWorld(), [{ name: 'water_bucket', count: 1 }])
    assert.ok(!menuNames(bot).names.includes('water_up'))
  })

  it('no bucket is not an offer', () => {
    const bot = worldBot(shaftWorld(), [])
    assert.ok(!menuNames(bot).names.includes('water_up'))
  })

  it('standing water vetoes the pour', () => {
    const world = shaftWorld()
    world.waters.add(key(0, 61, 0))
    const bot = worldBot(world, [{ name: 'water_bucket', count: 2 }])
    const { facts, names } = menuNames(bot)
    assert.equal(facts.water, true)
    assert.ok(!names.includes('water_up'))
  })

  it('lava near vetoes the pour', () => {
    const world = shaftWorld()
    world.lavas.add(key(1, 61, 0))
    const bot = worldBot(world, [{ name: 'water_bucket', count: 2 }])
    assert.ok(!menuNames(bot).names.includes('water_up'))
  })

  it('blocked head vetoes the climb', () => {
    const world = shaftWorld()
    world.solids.add(key(0, 62, 0))
    const bot = worldBot(world, [{ name: 'water_bucket', count: 2 }])
    assert.ok(!menuNames(bot).names.includes('water_up'))
  })

  it('capped shaft (no combo, no open sky) is not an offer', () => {
    const world = shaftWorld()
    for (let y = 63; y <= 66; y++) {
      for (let x = -3; x <= 4; x++) {
        for (let z = -3; z <= 3; z++) world.solids.add(key(x, y, z))
      }
    }
    const bot = worldBot(world, [{ name: 'water_bucket', count: 2 }])
    const { facts, names } = menuNames(bot)
    assert.equal(facts.combo, false)
    assert.ok(!names.includes('water_up'))
  })

  it('open field (no pit) is not an offer', () => {
    const world = shaftWorld()
    // Knock three walls down to the floor: one trunk-like side left.
    for (let y = 61; y <= 70; y++) {
      world.solids.delete(key(1, y, 0))
      world.solids.delete(key(-1, y, 0))
      world.solids.delete(key(0, y, 1))
    }
    const bot = worldBot(world, [{ name: 'water_bucket', count: 2 }])
    const { facts, names } = menuNames(bot)
    assert.equal(facts.pit, false)
    assert.ok(!names.includes('water_up'))
  })

  it('FSM climbs water in a goalless pit with no scaffold', () => {
    const facts = { goalDy: 0, goalDist: null, pit: true, wall2: true, last: 'none' }
    assert.equal(recover.recoverFsm(facts, ['water_up', 'sidestep', 'wait']), 'water_up')
  })

  it('FSM leaves a known level goal to hop/sidestep', () => {
    const facts = { goalDy: 0, goalDist: 12, pit: true, wall2: true, last: 'none' }
    assert.equal(recover.recoverFsm(facts, ['water_up', 'hop_step', 'sidestep', 'wait']), 'hop_step')
    assert.equal(recover.recoverFsm(facts, ['water_up', 'sidestep', 'wait']), 'sidestep')
  })

  it('FSM prefers the cheaper climbers first', () => {
    const facts = { goalDy: 3, goalDist: 3, pit: true, last: 'none' }
    assert.equal(recover.recoverFsm(facts, ['pillar_up', 'water_up', 'wait']), 'pillar_up')
    assert.equal(recover.recoverFsm(facts, ['dig_up', 'water_up', 'wait']), 'dig_up')
    assert.equal(recover.recoverFsm(facts, ['water_up', 'dig_step', 'wait']), 'water_up')
  })

  it('a failed water_up escalates past it', () => {
    const facts = { goalDy: 3, goalDist: 3, pit: true, last: 'water_up:failed' }
    assert.equal(recover.recoverFsm(facts, ['water_up', 'sidestep', 'wait']), 'sidestep')
  })

  it('chooseRecovery drops a failed water_up from the model menu', async () => {
    const facts = {
      goalDy: 3, goalDist: 3, scaffold: 0, pickaxe: false, bucket: 2, water: false,
      headBlocked: false, walls: 4, pit: true, playerOnline: false, playerDist: null,
      stuckTicks: 12, resetsStuck: 0, resetsPlaceError: 0, last: 'water_up:failed',
    }
    let seen = null
    const brain = { source: 'test', ask: async (q) => { seen = Object.keys(q.criteria); return 'sidestep' } }
    const choice = await recover.chooseRecovery(brain, facts, ['water_up', 'sidestep', 'wait'])
    assert.equal(choice.action, 'sidestep')
    assert.ok(!seen.includes('water_up'), 'failed primitive leaves the ask menu')
  })
})
