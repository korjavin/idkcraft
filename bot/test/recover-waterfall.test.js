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

// Cliff-face fall world: floor top 61, a cliff at x=1, a 4-high sheet
// (0,61..64,0) running down its face with air above to exit into, and the
// lip it pours over — a ledge at (0,61..63,-1) with top surface 64, the
// beach the plateau drive mounts.
function fallWorld() {
  const solids = new Set()
  for (let x = -3; x <= 4; x++) {
    for (let z = -3; z <= 3; z++) {
      for (let y = 55; y <= 60; y++) solids.add(key(x, y, z))
    }
  }
  for (let y = 61; y <= 70; y++) solids.add(key(1, y, 0))
  for (let y = 61; y <= 63; y++) solids.add(key(0, y, -1))
  const waters = new Set()
  for (let y = 61; y <= 64; y++) waters.add(key(0, y, 0))
  return { solids, waters, lavas: new Set() }
}

// The same sheet with no lip: open water at the top, nothing to beach on.
function openFallWorld() {
  const world = fallWorld()
  for (let y = 61; y <= 63; y++) world.solids.delete(key(0, y, -1))
  return world
}

// The player-made shape (i1cw core-1): the source sits ON the lip and
// spreads across it — the step/head cells are water standing on solid,
// not dry air. A dry-only exit read finds nothing here.
function wetLipFallWorld() {
  const world = fallWorld()
  world.waters.add(key(0, 64, -1)) // source on the lip
  world.waters.add(key(0, 64, -2)) // spread sheet across the top
  return world
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

// Server-faithful buoyancy double: the sheet lifts 0.5 a tick only while
// the eye is under the local surface — the eye-out plateau emerges (the
// combo models it; the P1 probe pins this run on it). A beach drive toward
// the aimed exit crosses onto the lip and mounts it with the held jump.
function harness(bot, ctx) {
  const out = waterup.waterfallUpRun(bot, ctx)
  const p = bot.entity.position
  const feet = key(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z))
  const head = key(Math.floor(p.x), Math.floor(p.y) + 1, Math.floor(p.z))
  const inWater = bot._waters.has(feet) || bot._waters.has(head)
  bot.entity.isInWater = inWater
  if (bot.controls.jump && inWater && !bot.opts.freezeRise) {
    // A flowing top surfaces below top+1 (opts.flowTop models it — the run
    // itself never reads fluid heights).
    let top = null
    for (const k of bot._waters) {
      const [x, y, z] = k.split(',').map(Number)
      if (x === Math.floor(p.x) && z === Math.floor(p.z) && y + 1 > p.y) {
        if (top === null || y > top) top = y
      }
    }
    if (top !== null) {
      const surface = bot.opts.flowTop ? top + 0.5 : top + 1
      if (p.y + 1.62 < surface) p.y = Math.min(p.y + 0.5, surface - 1.62 + 0.4)
    }
  }
  // Beach crossing: forward taps toward the aimed exit, mounting the lip
  // once over it (the jump is held).
  const st = ctx.recovery && ctx.recovery.st
  if (bot.controls.forward && st && st.phase === 'exit' && st.exit) {
    const dx = st.exit.x - p.x
    const dz = st.exit.z - p.z
    const d = Math.hypot(dx, dz)
    if (d > 0.05) {
      const step = Math.min(0.4, d)
      p.x += (dx / d) * step
      p.z += (dz / d) * step
    }
    if (Math.floor(p.x) === Math.floor(st.exit.x) && Math.floor(p.z) === Math.floor(st.exit.z) &&
      p.y < st.exit.y && p.y > st.exit.y - 1.6) {
      p.y = st.exit.y
    }
  }
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

describe('fall exits', () => {
  it('beaches goalward: the lip behind the fall wins over the cliff', () => {
    const bot = worldBot(fallWorld())
    const ctx = { stuck: { by: 'test', goal: { x: 0, y: 70, z: -8 } }, recovery: {} }
    assert.deepEqual(waterup.findFallExit(bot, 64, ctx), { x: 0.5, y: 64, z: -0.5 })
  })

  it('null with open water at the top (tread, never swim blind)', () => {
    const bot = worldBot(openFallWorld())
    const ctx = { stuck: { by: 'test', goal: { x: 0, y: 70, z: -8 } }, recovery: {} }
    assert.equal(waterup.findFallExit(bot, 64, ctx), null)
  })

  it('wet lip beaches: source spread over the lip is still an exit', () => {
    const bot = worldBot(wetLipFallWorld())
    const ctx = { stuck: { by: 'test', goal: { x: 0, y: 70, z: -8 } }, recovery: {} }
    assert.deepEqual(waterup.findFallExit(bot, 64, ctx), { x: 0.5, y: 64, z: -0.5 })
  })
})

describe('waterfallUpRun', () => {
  it('swims the sheet then beaches the lip: done, higher up, dry', async () => {
    const bot = worldBot(fallWorld())
    bot._waters = fallWorld().waters
    const ctx = { stuck: { by: 'test', goal: { x: 0, y: 70, z: -8 } }, recovery: {} }
    const swims = []
    let out = 'running'
    for (let i = 0; i < 40 && out === 'running'; i++) {
      out = harness(bot, ctx)
      await flush()
      if (out === 'running') swims.push({ jump: !!bot.controls.jump, fwd: !!bot.controls.forward, phase: ctx.recovery.st.phase })
    }
    assert.equal(out, 'done')
    assert.ok(bot.entity.position.y >= 64, 'left the water higher up')
    assert.ok(swims.length > 2, 'swam several ticks')
    assert.ok(swims.every((s) => s.jump === true), 'jump held the whole climb')
    assert.ok(swims.filter((s) => s.phase === 'swim').every((s) => s.fwd === false), 'jump-only up the sheet')
    assert.ok(swims.some((s) => s.phase === 'exit' && s.fwd === true), 'forward drive past the plateau')
    assert.equal(bot.controls.jump, false, 'releases on done')
    assert.equal(bot.controls.forward, false, 'releases on done')
  })

  it('pinned sheet fails no-progress on the stall window', async () => {
    const bot = worldBot(fallWorld())
    bot._waters = fallWorld().waters
    bot.opts.freezeRise = true
    const ctx = { stuck: { by: 'test', goal: { x: 0, y: 70, z: -8 } }, recovery: {} }
    let out = 'running'
    for (let i = 0; i < 20 && out === 'running'; i++) { out = harness(bot, ctx); await flush() }
    assert.equal(out, 'failed:no-progress')
    assert.equal(bot.controls.jump, false, 'releases on fail')
  })

  it('flowing top beaches via the stall arm (the P2 probe)', async () => {
    // A flowing top surfaces below top+1, so the eye-out read never fires:
    // the stall with a beach in reach is the surface signal. No fluid
    // heights in the run — only the stalled plateau drives out.
    const bot = worldBot(fallWorld())
    bot._waters = fallWorld().waters
    bot.opts.flowTop = true
    const ctx = { stuck: { by: 'test', goal: { x: 0, y: 70, z: -8 } }, recovery: {} }
    let out = 'running'
    let exits = 0
    for (let i = 0; i < 40 && out === 'running'; i++) {
      out = harness(bot, ctx)
      await flush()
      if (out === 'running' && ctx.recovery.st.phase === 'exit') exits++
    }
    assert.equal(out, 'done')
    assert.ok(exits > 0, 'the stall arm drove the beach')
    assert.ok(bot.entity.position.y >= 64, 'left the water higher up')
  })

  it('open top plateaus then treads to no-progress (the P1 probe)', async () => {
    // No lip to beach on: the plateau holds, the run treads the column and
    // fails the stall window instead of hanging — and never swims blind.
    const bot = worldBot(openFallWorld())
    bot._waters = openFallWorld().waters
    const ctx = { stuck: { by: 'test', goal: { x: 0, y: 70, z: -8 } }, recovery: {} }
    let out = 'running'
    for (let i = 0; i < 20 && out === 'running'; i++) { out = harness(bot, ctx); await flush() }
    assert.equal(out, 'failed:no-progress')
    assert.ok(bot.entity.position.y >= 63, 'rose to the surface plateau')
    assert.equal(bot.controls.forward, false, 'never swims blind')
  })

  it('a level walk-out is no-progress, not done', () => {
    const bot = worldBot(fallWorld())
    const ctx = { stuck: { by: 'test', goal: { x: 0, y: 70, z: -8 } }, recovery: {} }
    assert.equal(waterup.waterfallUpRun(bot, ctx), 'running')
    bot.entity.position = pos(2.5, 61, 0.5)
    bot.entity.isInWater = false
    assert.equal(waterup.waterfallUpRun(bot, ctx), 'failed:no-progress')
  })

  it('wet lip run ends done (feet stay wet past the top)', async () => {
    const bot = worldBot(wetLipFallWorld())
    bot._waters = wetLipFallWorld().waters
    const ctx = { stuck: { by: 'test', goal: { x: 0, y: 70, z: -8 } }, recovery: {} }
    let out = 'running'
    for (let i = 0; i < 40 && out === 'running'; i++) {
      out = harness(bot, ctx)
      await flush()
    }
    assert.equal(out, 'done')
    assert.ok(bot.entity.position.y >= 64, 'left the fall higher up')
    assert.equal(bot.controls.jump, false, 'releases on done')
    assert.equal(bot.controls.forward, false, 'releases on done')
  })
})

describe('waterfall_up cross-episode ban', () => {
  it('three top-failures on a 6-high fall ban the kind (the rise must not wipe the streak)', () => {
    const ctx = {}
    const floor = pos(0.5, 61, 0.5)
    const mid = pos(0.5, 63.5, 0.5)
    const top = pos(0.5, 65.6, 0.5) // >3 (3D) above the floor
    const facts = { water: true, fall: true, lavaNear: false, goalDy: 9, goalDist: 40, pit: false, wall2: false, last: 'none' }
    const feasible = () => recover.RECOVER_MENU.waterfall_up.feasible(facts, ctx)
    assert.equal(feasible(), true, 'offered before any failure')
    for (let i = 0; i < 3; i++) {
      recover.resetRecoverStreaksIfMoved(ctx, floor) // episode start at the floor
      recover.resetRecoverStreaksIfMoved(ctx, mid) // the rise (stuck.js per-tick anchor check)
      recover.resetRecoverStreaksIfMoved(ctx, top)
      recover.noteRecoverFail(ctx, top, 'waterfall_up', 'failed:no-progress')
      assert.equal(recover.recoverBanned(ctx, 'waterfall_up'), i === 2, `ban state after top-failure ${i + 1}`)
      recover.resetRecoverStreaksIfMoved(ctx, floor) // sinks back to the floor
    }
    assert.equal(feasible(), false, 'banned kind leaves the menu')
    recover.noteRecoverDone(ctx, top, 'waterfall_up', false)
    assert.equal(recover.recoverBanned(ctx, 'waterfall_up'), false, 'a done restarts the column run')
  })
})
