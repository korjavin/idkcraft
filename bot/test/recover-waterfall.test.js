'use strict'

// waterfall_up wiring + run (idkcraft-i1cw): the wet climber for
// player-made waterfalls. water_up only climbs POURED water in a DRY shaft
// (its feasible vetoes facts.water); a body already standing IN a falling
// sheet got no climber at all, so the detector wedged. waterfall_up swims
// the sheet it stands in — no kit, no pour, no strip.

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const { Vec3 } = require('vec3')
const recover = require('../src/behaviours/recover')
const waterup = require('../src/behaviours/waterup')
const { BEHAVIOURS } = require('../src/index')

function pos(x, y, z) {
  return {
    x, y, z,
    distanceTo: (q) => Math.hypot(x - q.x, y - q.y, z - q.z),
    clone() { return pos(x, y, z) },
  }
}

function key(x, y, z) { return `${x},${y},${z}` }

// Cliff-face fall world: floor top 61, a cliff at x=1, and a 4-high sheet
// (0,61..64,0) running down its face with air above to exit into.
function fallWorld() {
  const solids = new Set()
  for (let x = -3; x <= 4; x++) {
    for (let z = -3; z <= 3; z++) {
      for (let y = 55; y <= 60; y++) solids.add(key(x, y, z))
    }
  }
  for (let y = 61; y <= 70; y++) solids.add(key(1, y, 0))
  const waters = new Set()
  for (let y = 61; y <= 64; y++) waters.add(key(0, y, 0))
  return { solids, waters, lavas: new Set() }
}

function worldBot(world, at) {
  const { solids, waters, lavas } = world
  const bot = {
    username: 'IdkBot',
    players: {},
    entity: { position: at || pos(0.5, 61, 0.5), onGround: false, isInWater: true },
    inventory: { items: () => [] },
    controls: {},
    opts: {},
    setControlState(c, v) { this.controls[c] = !!v },
    clearControlStates() { this.controls = {} },
    blockAt(p) {
      const k = key(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z))
      const name = waters.has(k) ? 'water' : lavas.has(k) ? 'lava' : solids.has(k) ? 'stone' : 'air'
      return {
        name,
        position: new Vec3(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)),
        boundingBox: (solids.has(k) ? 'block' : 'empty'),
      }
    },
    lookAt() {},
    pathfinder: { goal: null, setGoal() {}, stop() {}, isMoving: () => false },
    chat() {},
  }
  return bot
}

function menuNames(bot, stuck) {
  const ctx = { stuck: stuck || { by: 'test', goal: null }, stuckTicks: 12 }
  const facts = recover.recoverFacts(bot, ctx, null, null)
  const names = recover.RECOVER_ORDER.filter((n) => {
    try { return recover.RECOVER_MENU[n].feasible(facts, ctx) } catch (_) { return false }
  })
  return { facts, names }
}

// Cheap buoyancy double: the sheet lifts 0.5 a tick until the feet leave
// the water. The state machine under test — jump held, gain tracked,
// wet/dry transitions, stall/timeout — is the point, not buoyancy (the
// eye-out plateau the combo models is skipped here).
function harness(bot, ctx) {
  const out = waterup.waterfallUpRun(bot, ctx)
  const p = bot.entity.position
  const feet = key(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z))
  const head = key(Math.floor(p.x), Math.floor(p.y) + 1, Math.floor(p.z))
  const inWater = bot._waters.has(feet) || bot._waters.has(head)
  bot.entity.isInWater = inWater
  if (bot.controls.jump && inWater && !bot.opts.freezeRise) p.y += 0.5
  const below = bot.blockAt({ x: p.x, y: p.y - 0.1, z: p.z })
  bot.entity.onGround = !!below && below.boundingBox !== 'empty' && p.y <= below.position.y + 1.05
  return out
}

async function flush() {
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r))
}

describe('waterfall scans', () => {
  it('finds the fall: 4-high sheet, top and height', () => {
    const bot = worldBot(fallWorld())
    assert.deepEqual(waterup.findWaterfall(bot), { topY: 64, height: 4 })
  })

  it('null when dry', () => {
    const bot = worldBot(fallWorld(), pos(2.5, 61, 0.5))
    bot.entity.isInWater = false
    assert.equal(waterup.findWaterfall(bot), null)
  })

  it('null for a 1-high sheet (hop/sidestep ground)', () => {
    const world = fallWorld()
    for (let y = 62; y <= 64; y++) world.waters.delete(key(0, y, 0))
    assert.equal(waterup.findWaterfall(worldBot(world)), null)
  })

  it('null when capped (solid inside the column)', () => {
    const world = fallWorld()
    world.waters.delete(key(0, 63, 0))
    world.solids.add(key(0, 63, 0))
    assert.equal(waterup.findWaterfall(worldBot(world)), null)
  })

  it('null with no exit above the top', () => {
    const world = fallWorld()
    world.solids.add(key(0, 65, 0))
    assert.equal(waterup.findWaterfall(worldBot(world)), null)
  })
})

describe('waterfall_up wiring', () => {
  it('menu shape: ORDER, CRITERIA and MENU agree, waterfall_up rides after water_up', () => {
    assert.deepEqual(Object.keys(recover.RECOVER_CRITERIA).sort(), [...recover.RECOVER_ORDER].sort())
    assert.deepEqual(Object.keys(recover.RECOVER_MENU).sort(), [...recover.RECOVER_ORDER].sort())
    const i = recover.RECOVER_ORDER.indexOf('waterfall_up')
    assert.ok(i > recover.RECOVER_ORDER.indexOf('water_up'), 'right after the dry pour climber')
    assert.equal(recover.RECOVER_MENU.waterfall_up.verb, 'swimming up the waterfall')
    assert.equal(typeof BEHAVIOURS.waterfall_up, 'function')
  })

  it('wet in the fall with a high goal offers waterfall_up, never water_up', () => {
    const bot = worldBot(fallWorld())
    const stuck = { by: 'test', goal: { x: 0, y: 70, z: 0 } }
    const { facts, names } = menuNames(bot, stuck)
    assert.equal(facts.water, true)
    assert.equal(facts.fall, true)
    assert.equal(facts.combo, false)
    assert.ok(names.includes('waterfall_up'))
    assert.ok(!names.includes('water_up'), 'dry-only: no buckets, no pour from inside the sheet')
  })

  it('dry body offers nothing wet', () => {
    const bot = worldBot(fallWorld(), pos(2.5, 61, 0.5))
    bot.entity.isInWater = false
    const stuck = { by: 'test', goal: { x: 0, y: 70, z: 0 } }
    const { facts, names } = menuNames(bot, stuck)
    assert.equal(facts.fall, false)
    assert.ok(!names.includes('waterfall_up'))
  })

  it('known level goal never climbs the fall', () => {
    const bot = worldBot(fallWorld())
    const stuck = { by: 'test', goal: { x: 8, y: 61, z: 0 } }
    const { facts, names } = menuNames(bot, stuck)
    assert.equal(facts.fall, true)
    assert.ok(!names.includes('waterfall_up'))
  })

  it('lava near vetoes the swim', () => {
    const world = fallWorld()
    world.lavas.add(key(1, 61, 0))
    const bot = worldBot(world)
    const stuck = { by: 'test', goal: { x: 0, y: 70, z: 0 } }
    assert.ok(!menuNames(bot, stuck).names.includes('waterfall_up'))
  })

  it('FSM climbs the fall on a high goal', () => {
    const facts = { goalDy: 9, goalDist: 40, pit: false, wall2: false, last: 'none' }
    assert.equal(recover.recoverFsm(facts, ['waterfall_up', 'sidestep', 'wait']), 'waterfall_up')
  })

  it('a failed waterfall_up escalates past it', () => {
    const facts = { goalDy: 9, goalDist: 40, pit: false, wall2: false, last: 'waterfall_up:failed' }
    assert.equal(recover.recoverFsm(facts, ['waterfall_up', 'sidestep', 'wait']), 'sidestep')
  })

  it('chooseRecovery drops a failed waterfall_up from the model menu', async () => {
    const facts = {
      goalDy: 9, goalDist: 40, scaffold: 0, pickaxe: false, bucket: 0, water: true,
      headBlocked: false, walls: 1, pit: false, playerOnline: false, playerDist: null,
      stuckTicks: 12, resetsStuck: 0, resetsPlaceError: 0, last: 'waterfall_up:failed',
    }
    let seen = null
    const brain = { source: 'test', ask: async (q) => { seen = Object.keys(q.criteria); return 'sidestep' } }
    const choice = await recover.chooseRecovery(brain, facts, ['waterfall_up', 'sidestep', 'wait'])
    assert.equal(choice.action, 'sidestep')
    assert.ok(!seen.includes('waterfall_up'), 'failed primitive leaves the ask menu')
  })
})

describe('waterfallUpRun', () => {
  it('swims the sheet: done, higher up, jump held and forward off', async () => {
    const bot = worldBot(fallWorld())
    bot._waters = fallWorld().waters
    const ctx = { recovery: {} }
    const jumps = []
    let out = 'running'
    for (let i = 0; i < 40 && out === 'running'; i++) {
      out = harness(bot, ctx)
      await flush()
      if (out === 'running') jumps.push([!!bot.controls.jump, !!bot.controls.forward])
    }
    assert.equal(out, 'done')
    assert.ok(bot.entity.position.y >= 64, 'left the water higher up')
    assert.ok(jumps.length > 2, 'swam several ticks')
    assert.ok(jumps.every(([j, f]) => j === true && f === false), 'jump-only the whole climb')
    assert.equal(bot.controls.jump, false, 'releases on done')
  })

  it('pinned sheet fails no-progress on the stall window', async () => {
    const bot = worldBot(fallWorld())
    bot._waters = fallWorld().waters
    bot.opts.freezeRise = true
    const ctx = { recovery: {} }
    let out = 'running'
    for (let i = 0; i < 20 && out === 'running'; i++) { out = harness(bot, ctx); await flush() }
    assert.equal(out, 'failed:no-progress')
    assert.equal(bot.controls.jump, false, 'releases on fail')
  })

  it('a level walk-out is no-progress, not done', () => {
    const bot = worldBot(fallWorld())
    const ctx = { recovery: {} }
    assert.equal(waterup.waterfallUpRun(bot, ctx), 'running')
    bot.entity.position = pos(2.5, 61, 0.5)
    bot.entity.isInWater = false
    assert.equal(waterup.waterfallUpRun(bot, ctx), 'failed:no-progress')
  })
})
