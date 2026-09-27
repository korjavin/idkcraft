'use strict'

// Bead rw4.13: the bot torches the house and yard by day.

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const goal = require('../src/goal')
const metrics = require('../src/metrics')
const light = require('../src/behaviours/light')
const buildMod = require('../src/behaviours/build')
const { LIGHT_SPOTS, COAL_RESERVE, countUnlit, nextSpotIdx, spotLit, torchOp } = light

function pos(x, y, z) {
  return { x, y, z }
}

function makeWorld() {
  const cells = new Map()
  const key = (x, y, z) => `${Math.floor(x)},${Math.floor(y)},${Math.floor(z)}`
  return {
    set(x, y, z, name) { cells.set(key(x, y, z), name) },
    blockAt(p) {
      const fx = Math.floor(p.x)
      const fy = Math.floor(p.y)
      const fz = Math.floor(p.z)
      const k = key(fx, fy, fz)
      const name = cells.has(k) ? cells.get(k) : (fy <= 63 ? 'dirt' : 'air')
      return { name, boundingBox: name === 'air' ? 'empty' : 'block', position: { x: fx, y: fy, z: fz } }
    },
  }
}

function mockBot(world, { items = [], ids = {}, recipes = {}, craftImpl = null, failPlace = false, at = pos(0, 65, 0) } = {}) {
  const lines = []
  const calls = { craft: [], goals: [], places: [], digs: [], equips: [] }
  const itemsByName = {}
  for (const [name, id] of Object.entries(ids)) itemsByName[name] = { id }
  const bot = {
    lines,
    calls,
    _items: items,
    spawnPoint: pos(0, 64, 0),
    time: { timeOfDay: 6000 },
    entity: { position: at },
    world: { getBlock: () => null },
    players: {},
    held: null,
    registry: { itemsByName },
    inventory: { items: () => bot._items },
    recipesFor: (id) => {
      const name = Object.keys(ids).find((n) => ids[n] === id)
      if (!(name in recipes)) throw new Error(`unexpected recipesFor(${name})`)
      const r = recipes[name]
      return r ? [r] : []
    },
    craft: craftImpl || (async (recipe, count, table) => { calls.craft.push({ recipe, count, table }) }),
    blockAt: (p) => world.blockAt(p),
    findBlocks: () => [],
    pathfinder: { isMoving: () => false, setGoal: (g) => { calls.goals.push(g) } },
    equip: async (item, dest) => { calls.equips.push([item.name, dest]); bot.held = item.name },
    dig: async (b) => { calls.digs.push(b.name); world.set(b.position.x, b.position.y, b.position.z, 'air') },
    placeBlock: async (ref, face) => {
      calls.places.push([ref, face])
      if (failPlace) throw new Error('refused')
      const rp = (ref && ref.position) || ref
      world.set(rp.x + face.x, rp.y + face.y, rp.z + face.z, bot.held)
    },
    chat: (m) => { lines.push(String(m)) },
  }
  return bot
}

function home(site) {
  return { site: site || pos(0, 64, 0), built: true }
}

async function flush() {
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r))
}

async function metricText() {
  return metrics.client.register.metrics()
}

function paintSpots(world, h, name) {
  for (const s of LIGHT_SPOTS) world.set(h.site.x + s.dx, h.site.y + (s.dy || 0), h.site.z + s.dz, name || 'torch')
}

describe('light spot plan (rw4.13)', () => {
  it('door-front first, ring around the shell, chest cell free, roof then interior', () => {
    assert.equal(LIGHT_SPOTS.length, 10)
    assert.deepEqual(LIGHT_SPOTS[0], { dx: 1, dz: -2 }) // the mob door first
    assert.deepEqual(LIGHT_SPOTS[8], { dx: 1, dy: 3, dz: 1, stage: { dx: 0, dz: -1 } }) // the air above the dark flat roof
    assert.deepEqual(LIGHT_SPOTS[9], { dx: 2, dz: 2, stage: { dx: 1, dz: -1 } }) // the dark interior, staged from the doorway
    // atl.14 adopts the stockpile chest at table+1 east (table is (4,1)):
    // the plan must never take that cell.
    assert.ok(!LIGHT_SPOTS.some((s) => s.dx === 5 && s.dz === 1), 'chest cell not on the plan')
    // Doorway walk column stays clear for gohome/stay legs.
    assert.ok(!LIGHT_SPOTS.some((s) => s.dx === 1 && (s.dz === 0 || s.dz === -1)), 'doorway not on the plan')
  })
  it('spotLit counts floor and wall torches only', () => {
    const world = makeWorld()
    const h = home()
    const bot = mockBot(world)
    assert.equal(countUnlit(bot, h, []), 10)
    world.set(1, 64, -2, 'torch')
    world.set(-2, 64, -2, 'wall_torch')
    world.set(4, 64, -2, 'redstone_torch') // too dim to hold the ring
    world.set(1, 67, 1, 'wall_torch') // the roof spot burns too
    assert.equal(countUnlit(bot, h, []), 7)
    assert.equal(nextSpotIdx(bot, h, []), 2)
  })
  it('table/chest cells and skips read as done', () => {
    const world = makeWorld()
    const bot = mockBot(world)
    // Table and chest adopted exactly on two planned spots.
    const h = { site: pos(0, 64, 0), built: true, table: pos(1, 64, -2), chest: pos(-2, 64, -2) }
    assert.equal(countUnlit(bot, h, []), 8)
    assert.equal(nextSpotIdx(bot, h, []), 2)
    assert.equal(countUnlit(bot, h, [2, 3, 4, 5, 6, 7, 8, 9]), 0)
    assert.equal(nextSpotIdx(bot, home(), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]), -1)
  })
})

describe('light torch economy (rw4.13)', () => {
  const ids = { torch: 1, stick: 2, oak_planks: 3 }
  const recipes = { torch: {}, stick: {}, oak_planks: {} }
  const bot = (items) => mockBot(makeWorld(), { items, ids, recipes })
  it('reserve: fuel at or below COAL_RESERVE never crafts', () => {
    assert.equal(torchOp(bot([{ name: 'coal', count: 4 }, { name: 'stick', count: 8 }])).fail, 'failed:no-fuel')
    assert.equal(torchOp(bot([{ name: 'coal', count: 3 }, { name: 'stick', count: 8 }])).fail, 'failed:no-fuel')
    assert.equal(torchOp(bot([{ name: 'coal', count: 5 }, { name: 'stick', count: 1 }])).item, 'torch')
  })
  it('charcoal is fuel too', () => {
    assert.equal(torchOp(bot([{ name: 'charcoal', count: 6 }, { name: 'stick', count: 1 }])).item, 'torch')
    assert.equal(torchOp(bot([{ name: 'coal', count: 2 }, { name: 'charcoal', count: 3 }, { name: 'stick', count: 1 }])).item, 'torch')
  })
  it('sticks from planks, planks from logs (equip order)', () => {
    assert.equal(torchOp(bot([{ name: 'coal', count: 5 }, { name: 'oak_planks', count: 2 }])).item, 'stick')
    assert.equal(torchOp(bot([{ name: 'coal', count: 5 }, { name: 'oak_log', count: 1 }])).item, 'oak_planks')
    assert.equal(torchOp(bot([{ name: 'coal', count: 5 }, { name: 'oak_planks', count: 1 }])).fail, 'failed:no-sticks')
  })
  it('missing recipes fail loudly per item', () => {
    const noTorch = mockBot(makeWorld(), { items: [{ name: 'coal', count: 5 }, { name: 'stick', count: 1 }], ids, recipes: { torch: null } })
    assert.equal(torchOp(noTorch).fail, 'failed:no-torch-recipe')
  })
})

describe('MENU.light feasibility (rw4.13)', () => {
  const F = (o) => ({
    time: 'day', logs: 0, planks: 0, maxPlanks: 0, sticks: 0, coal: 0, torches: 0, home: 'built', unlit: 8, ...o,
  })
  const ctx = { home: home() }
  const feasible = goal.MENU.light.feasible
  it('day, site, dark yard, material: the matrix', () => {
    assert.equal(feasible(F({ time: 'night', torches: 8 }), null, ctx), false, 'night never lights')
    assert.equal(feasible(F({ time: 'dusk', torches: 8 }), null, ctx), false, 'dusk belongs to gohome')
    assert.equal(feasible(F({ torches: 8 }), null, {}), false, 'no home site')
    assert.equal(feasible(F({ torches: 8, home: 'site' }), null, ctx), false, 'unbuilt site builds first')
    assert.equal(feasible(F({ torches: 8, home: 'none' }), null, ctx), false, 'no home at all')
    assert.equal(feasible(F({ torches: 8, unlit: 0 }), null, ctx), false, 'lit yard rests')
    assert.equal(feasible(F({ torches: 8 }), null, ctx), true, 'torches on hand')
    assert.equal(feasible(F({ coal: 4, sticks: 4 }), null, ctx), false, 'reserve fuel is not spendable')
    assert.equal(feasible(F({ coal: 5, sticks: 1 }), null, ctx), true, 'fuel + sticks')
    assert.equal(feasible(F({ coal: 5, planks: 2, maxPlanks: 2 }), null, ctx), true, 'fuel + planks for sticks')
    assert.equal(feasible(F({ coal: 5, planks: 2, maxPlanks: 1 }), null, ctx), false, 'split woods make no sticks')
    assert.equal(feasible(F({ coal: 5, logs: 1 }), null, ctx), true, 'fuel + log for sticks')
    assert.equal(feasible(F({ coal: 5, planks: 1 }), null, ctx), false, 'one plank makes no sticks')
    assert.equal(feasible(F({ coal: 5 }), null, ctx), false, 'no stick material')
  })
  it('stepWhy mirrors the feasible branches', () => {
    const why = goal.stepWhy
    const text = 't'
    assert.equal(why('light', F({ time: 'night' }), null, ctx, text), 'light: daytime job')
    assert.equal(why('light', F({}), null, {}, text), 'light: no home site')
    assert.equal(why('light', F({ home: 'site' }), null, ctx, text), 'light: home not built')
    assert.equal(why('light', F({ unlit: 0 }), null, ctx, text), 'light: yard lit')
    assert.equal(why('light', F({ coal: 2 }), null, ctx, text), 'light: saving coal')
    assert.equal(why('light', F({ coal: 9 }), null, ctx, text), 'light: no sticks or wood')
    assert.equal(why('light', F({ torches: 3 }), null, ctx, text), null, 'feasible explains nothing')
  })
  it('criteria names the bucket words', () => {
    assert.ok(goal.STEP_CRITERIA.light.includes('unlit is few or many'), goal.STEP_CRITERIA.light)
    assert.ok(goal.STEP_CRITERIA.light.includes('time is day'), goal.STEP_CRITERIA.light)
    assert.ok(goal.STEP_CRITERIA.light.includes('home is built'), goal.STEP_CRITERIA.light)
  })
})

describe('light behaviour ticks (rw4.13)', () => {
  it('every tick guards the house walls against the dig approach', () => {
    // Live assay: the adopted house never ran build, so no guard was
    // installed and the SE corner got eaten by GoalPlaceBlock approaches.
    const world = makeWorld()
    const h = home()
    const bot = mockBot(world, { items: [{ name: 'torch', count: 8 }] })
    bot.registry.blocksByName = { oak_planks: { id: 5 }, oak_door: { id: 6 }, crafting_table: { id: 7 } }
    bot.pathfinder.movements = { exclusionAreasBreak: [] }
    const ctx = { home: h }
    light(bot, ctx)
    assert.equal(bot.pathfinder.movements.exclusionAreasBreak.length, 1)
  })
  it('no home: failed, nothing moves', () => {
    const bot = mockBot(makeWorld(), { items: [{ name: 'torch', count: 8 }] })
    const ctx = {}
    light(bot, ctx)
    assert.equal(ctx.stepStatus, 'failed:no-home')
    assert.equal(bot.calls.goals.length, 0)
  })
  it('lit yard: done with the torches placed line', () => {
    const world = makeWorld()
    const h = home()
    paintSpots(world, h)
    const bot = mockBot(world, { items: [] })
    const ctx = { home: h, lightPlaced: 8, lightSkipKey: '0,64,0' }
    const logs = []
    const orig = console.log
    console.log = (l) => { logs.push(String(l)) }
    try {
      light(bot, ctx)
    } finally {
      console.log = orig
    }
    assert.equal(ctx.stepStatus, 'done')
    assert.ok(logs.some((l) => l === 'torches placed 8'), logs.join(' | '))
  })
  it('torch on hand: approach then place on the door-front spot', async () => {
    const world = makeWorld()
    const h = home()
    const bot = mockBot(world, { items: [{ name: 'torch', count: 8 }] })
    const ctx = { home: h }
    light(bot, ctx) // approach
    assert.equal(bot.calls.goals.length, 1)
    assert.equal(ctx.stepStatus, undefined)
    light(bot, ctx) // arrived (mock never moves): place flight
    await flush()
    assert.equal(world.blockAt({ x: 1, y: 64, z: -2 }).name, 'torch')
    assert.equal(ctx.lightPlaced, 1)
    const text = await metricText()
    assert.match(text, /idkcraft_bot_light_total\{op="placed"\} [1-9]/)
  })
  it('the landing that closes the ring logs torches placed (live assay: done never runs)', async () => {
    // The last torch flips unlit to none, which flips the goal text and
    // re-decides away before any tick can report done — the line must fire
    // in the place flight, not just the done branch.
    const world = makeWorld()
    const h = home()
    for (const s of LIGHT_SPOTS.slice(1)) world.set(h.site.x + s.dx, h.site.y + (s.dy || 0), h.site.z + s.dz, 'torch')
    const bot = mockBot(world, { items: [{ name: 'torch', count: 1 }] })
    const ctx = { home: h }
    const logs = []
    const orig = console.log
    console.log = (l) => { logs.push(String(l)) }
    try {
      light(bot, ctx)
      light(bot, ctx)
      await flush()
    } finally {
      console.log = orig
    }
    assert.ok(logs.some((l) => l === 'torches placed 1'), `completion line logged, got: ${logs.join(' | ')}`)
    light(bot, ctx) // the done branch observes the same closed ring...
    await flush()
    assert.equal(logs.filter((l) => l === 'torches placed 1').length, 1, `exactly once, got: ${logs.join(' | ')}`)
  })
  it('interior spot: staged from the door-front ground, torch inside', async () => {
    // nhb: no entry, no door phases — the place lands through the doorway.
    const world = makeWorld()
    const h = home()
    for (const s of LIGHT_SPOTS.slice(0, 9)) world.set(h.site.x + s.dx, h.site.y + (s.dy || 0), h.site.z + s.dz, 'torch')
    const bot = mockBot(world, { items: [{ name: 'torch', count: 1 }] })
    const ctx = { home: h }
    assert.equal(nextSpotIdx(bot, h, []), 9)
    light(bot, ctx)
    assert.equal(bot.calls.goals.length, 1)
    const g = bot.calls.goals[0]
    assert.deepEqual([g.x, g.y, g.z], [1, 64, -1], 'door-front staging')
    light(bot, ctx)
    await flush()
    assert.equal(world.blockAt({ x: 2, y: 64, z: 2 }).name, 'torch')
  })
  it('roof spot: staged via ground, never a high GoalPlaceBlock', () => {
    // Live assay: aiming GoalPlaceBlock 3 above the feet dug the bot into
    // a hole. The roof approach must be a plain ground walk.
    const world = makeWorld()
    const h = home()
    for (const s of LIGHT_SPOTS.slice(0, 8)) world.set(h.site.x + s.dx, h.site.y, h.site.z + s.dz, 'torch')
    const bot = mockBot(world, { items: [{ name: 'torch', count: 1 }] })
    const ctx = { home: h }
    light(bot, ctx)
    assert.equal(bot.calls.goals.length, 1)
    const g = bot.calls.goals[0]
    assert.equal(g.x, 0, `staged ground x, got ${g.x},${g.y},${g.z}`)
    assert.equal(g.y, 64, `staged ground y, got ${g.x},${g.y},${g.z}`)
    assert.equal(g.z, -1, `staged ground z, got ${g.x},${g.y},${g.z}`)
  })
  it('roof spot: placeable from the ground next to the house', async () => {
    // The roof top (dy 2) reads a below-ref (the roof block) and sits in
    // place reach from the yard — no climbing needed.
    const world = makeWorld()
    const h = home()
    for (const s of LIGHT_SPOTS.slice(0, 8)) world.set(h.site.x + s.dx, h.site.y, h.site.z + s.dz, 'torch')
    world.set(1, 66, 1, 'oak_planks') // the roof block under the spot
    const bot = mockBot(world, { items: [{ name: 'torch', count: 1 }], at: pos(1, 65, -2) })
    const ctx = { home: h }
    assert.equal(nextSpotIdx(bot, h, []), 8)
    light(bot, ctx)
    light(bot, ctx)
    await flush()
    assert.equal(world.blockAt({ x: 1, y: 67, z: 1 }).name, 'torch')
  })
  it('a non-closing landing stays silent', async () => {
    const world = makeWorld()
    const h = home()
    const bot = mockBot(world, { items: [{ name: 'torch', count: 8 }] })
    const ctx = { home: h }
    const logs = []
    const orig = console.log
    console.log = (l) => { logs.push(String(l)) }
    try {
      light(bot, ctx)
      light(bot, ctx)
      await flush()
    } finally {
      console.log = orig
    }
    assert.ok(!logs.some((l) => l.startsWith('torches placed')), `silent, got: ${logs.join(' | ')}`)
  })
  it('a run closed by skipping still logs torches placed exactly once', async () => {
    // The unlit flip re-decides away before any done tick (revmux 01
    // minor) — the line must fire in the skip path.
    const world = makeWorld()
    const h = home()
    for (const s of LIGHT_SPOTS.slice(0, 9)) world.set(h.site.x + s.dx, h.site.y + (s.dy || 0), h.site.z + s.dz, 'torch')
    const bot = mockBot(world, { items: [{ name: 'torch', count: 8 }], failPlace: true })
    const ctx = { home: h }
    const logs = []
    const orig = console.log
    console.log = (l) => { logs.push(String(l)) }
    try {
      // Set/strike alternate (no-ref resets the goal each strike).
      for (let i = 0; i < 6; i++) { light(bot, ctx); await flush() }
      assert.deepEqual(ctx.lightSkip, [9])
      // Mutant-grade (revmux 02 minor): the line must already be here
      // from the skip path, before any done-branch tick could print it.
      assert.equal(logs.filter((l) => l === 'torches placed 0').length, 1, `skip path logs, got: ${logs.join(' | ')}`)
      light(bot, ctx) // done branch observes the same closed ring...
      assert.equal(logs.filter((l) => l === 'torches placed 0').length, 1, '...and stays silent')
    } finally {
      console.log = orig
    }
  })
  it('a home move clears the old site skips', () => {
    // Skip indices are site-relative (revmux 01 major): inheriting them
    // would leave the new door-front dark forever.
    const world = makeWorld()
    const h = home()
    const bot = mockBot(world, { items: [{ name: 'torch', count: 8 }] })
    const ctx = { home: h, lightSkipKey: '9,9,9', lightSkip: [0], lightPlaced: 3, lightLineDone: true }
    light(bot, ctx)
    assert.deepEqual(ctx.lightSkip, [], 'fresh site starts unskipped')
    assert.equal(ctx.lightPlaced, 0)
    assert.equal(ctx.lightLineDone, false)
    assert.equal(nextSpotIdx(bot, h, ctx.lightSkip), 0)
  })
  it('refusals skip the spot after 3, the ring completes without it', async () => {
    const world = makeWorld()
    const h = home()
    const bot = mockBot(world, { items: [{ name: 'torch', count: 8 }], failPlace: true })
    const ctx = { home: h }
    light(bot, ctx)
    for (let i = 0; i < 3; i++) { light(bot, ctx); await flush() }
    assert.deepEqual(ctx.lightSkip, [0])
    assert.equal(nextSpotIdx(bot, h, ctx.lightSkip), 1)
  })
  it('unwalkable spot: 3 consecutive far-idle ticks skip it as unreachable', () => {
    const world = makeWorld()
    const h = home()
    const bot = mockBot(world, { items: [{ name: 'torch', count: 8 }], at: pos(100, 65, 100) })
    const ctx = { home: h, lightGoalIdx: 0, lightSkipKey: '0,64,0' } // approach never arrives
    light(bot, ctx)
    assert.equal(ctx.lightGoalIdx, -1, 'forced fresh approach')
    assert.equal(ctx.lightFarTicks, 1, 'first streak tick counted')
    assert.equal(ctx.lightFails || 0, 0, 'refusal counter untouched')
    assert.equal(bot.calls.places.length, 0)
    light(bot, ctx) // re-approach set...
    light(bot, ctx) // ...still out of reach: streak 2
    assert.equal(ctx.lightFarTicks, 2)
    light(bot, ctx)
    light(bot, ctx) // streak 3: give up instead of looping all day
    assert.deepEqual(ctx.lightSkip, [0])
    assert.equal(nextSpotIdx(bot, h, ctx.lightSkip), 1)
  })
  it('stalled walk: 10 motionless ticks re-path on the far budget, 3rd skips', () => {
    // nhb live assay: a corner squeeze loops pathfinder stuck/success
    // forever with moving=true — the behaviour must notice and give up.
    const world = makeWorld()
    const h = home()
    const bot = mockBot(world, { items: [{ name: 'torch', count: 8 }], at: pos(7.7, 64, 8.2) })
    bot.pathfinder.isMoving = () => true // frozen mid-walk
    const ctx = { home: h, lightGoalIdx: 0, lightSkipKey: '0,64,0' }
    // 11: first tick records the baseline, then 10 motionless.
    for (let i = 0; i < 11; i++) light(bot, ctx)
    assert.equal(ctx.lightFarTicks, 1, 'first stall burns one far strike')
    assert.equal(ctx.lightGoalIdx, -1, 're-pathed')
    for (let i = 0; i < 22; i++) light(bot, ctx)
    assert.deepEqual(ctx.lightSkip, [0], '3rd stall gives up')
  })
  it('jump in place reads as still: y bobbing is not progress', () => {
    // Revmux 01 minor: the pathfinder holding jump bobs y while x/z are
    // frozen — tick-to-tick 3D comparison would wipe the budget forever.
    const world = makeWorld()
    const h = home()
    const bot = mockBot(world, { items: [{ name: 'torch', count: 8 }], at: pos(7.7, 64, 8.2) })
    bot.pathfinder.isMoving = () => true
    const ctx = { home: h, lightGoalIdx: 0, lightSkipKey: '0,64,0' }
    for (let i = 0; i < 11; i++) {
      bot.entity.position = pos(7.7, 64 + (i % 2 === 0 ? 0.4 : -0.1), 8.2)
      light(bot, ctx)
    }
    assert.equal(ctx.lightFarTicks, 1, 'bobbing still strikes')
  })
  it('a far-idle strike resets the stall state; XZ progress forgives', () => {
    // Revmux 01 minor: far budget is one consecutive no-progress budget —
    // a far strike clears the still counter + anchor so the old stall can
    // never combine with new evidence, and genuine XZ movement forgives.
    const world = makeWorld()
    const h = home()
    const bot = mockBot(world, { items: [{ name: 'torch', count: 8 }], at: pos(7.7, 64, 8.2) })
    let walking = true
    bot.pathfinder.isMoving = () => walking
    const ctx = { home: h, lightGoalIdx: 0, lightSkipKey: '0,64,0' }
    for (let i = 0; i < 10; i++) light(bot, ctx) // anchor + 9 still
    assert.equal(ctx.lightStillTicks, 9)
    walking = false
    bot.entity.position = pos(100, 65, 100) // preemption carried the body off
    light(bot, ctx)
    assert.equal(ctx.lightFarTicks, 1, 'far strike counted')
    assert.equal(ctx.lightStillTicks, 0, 'still counter cleared')
    assert.equal(ctx.lightStillAnchor, null, 'anchor cleared')
    walking = true
    light(bot, ctx) // moving again: re-anchors, budget forgiven
    assert.equal(ctx.lightFarTicks, 0, 'progress forgives the streak')
    assert.equal(ctx.lightStillTicks, 0, 'no inherited stall')
  })
  it('walking with progress resets the stall counter', () => {
    const world = makeWorld()
    const h = home()
    const bot = mockBot(world, { items: [{ name: 'torch', count: 8 }], at: pos(0, 65, 0) })
    bot.pathfinder.isMoving = () => true
    const ctx = { home: h, lightGoalIdx: 0, lightSkipKey: '0,64,0', lightStillTicks: 9 }
    bot.entity.position = pos(5, 65, 5) // strides on
    light(bot, ctx)
    assert.equal(ctx.lightStillTicks, 0)
    assert.equal(ctx.lightFarTicks, 0)
    assert.deepEqual(ctx.lightSkip || [], [])
  })
  it('preemption resume: one far tick then walking back never burns the spot', () => {
    // Round-2 minor: the far streak must break on walking, or fight
    // preemptions pile strikes onto a reachable spot across the day.
    const world = makeWorld()
    const h = home()
    const bot = mockBot(world, { items: [{ name: 'torch', count: 8 }], at: pos(100, 65, 100) })
    let walking = false
    bot.pathfinder.isMoving = () => walking
    const ctx = { home: h, lightGoalIdx: 0, lightSkipKey: '0,64,0' }
    for (let i = 0; i < 3; i++) {
      walking = false
      light(bot, ctx) // resume: far and idle, streak 1...
      assert.equal(ctx.lightFarTicks, 1)
      walking = true
      // A real walk strides; a static pos would read as stalled.
      bot.entity.position = pos(100 - (i + 1) * 5, 65, 100)
      light(bot, ctx) // ...then the walk back breaks the streak (and re-sets)
      assert.equal(ctx.lightFarTicks, 0)
    }
    assert.deepEqual(ctx.lightSkip || [], [], 'reachable spot never skipped')
    assert.equal(ctx.lightFails || 0, 0)
  })
  it('no torches: one craft op per tick, flag settled, metric counted', async () => {
    const world = makeWorld()
    const h = home()
    const ids = { torch: 1 }
    const bot = mockBot(world, { items: [{ name: 'coal', count: 5 }, { name: 'stick', count: 2 }], ids, recipes: { torch: {} } })
    const ctx = { home: h }
    light(bot, ctx)
    assert.equal(ctx.lightCraftInFlight, true)
    await flush() // the safeCraft pre-clear yields before bot.craft runs
    assert.equal(bot.calls.craft.length, 1)
    assert.equal(ctx.lightCraftInFlight, false)
    const text = await metricText()
    assert.match(text, /idkcraft_bot_light_total\{op="crafted"\} [1-9]/)
  })
  it('craft window flying: further ticks stay silent', async () => {
    const world = makeWorld()
    const h = home()
    const ids = { torch: 1 }
    // A hung window: the op starts but never lands (the 30 s deadline is
    // unref'd, so the test loop still exits).
    const started = []
    const bot = mockBot(world, {
      items: [{ name: 'coal', count: 5 }, { name: 'stick', count: 2 }], ids, recipes: { torch: {} },
      craftImpl: (...a) => { started.push(a); return new Promise(() => {}) },
    })
    const ctx = { home: h }
    light(bot, ctx)
    await flush()
    assert.equal(started.length, 1)
    light(bot, ctx)
    light(bot, ctx)
    assert.equal(started.length, 1, 'no second op while one flies')
    assert.equal(ctx.lightCraftInFlight, true)
  })
  it('no fuel and no torches: failed:no-fuel yields the menu', () => {
    const world = makeWorld()
    const h = home()
    const bot = mockBot(world, { items: [{ name: 'coal', count: 4 }, { name: 'stick', count: 2 }] })
    const ctx = { home: h }
    light(bot, ctx)
    assert.equal(ctx.stepStatus, 'failed:no-fuel')
  })
})

describe('light goal wiring (rw4.13)', () => {
  it('goalFacts counts coal/torches and scans unlit', () => {
    const world = makeWorld()
    const h = home()
    const bot = mockBot(world, { items: [{ name: 'coal', count: 3 }, { name: 'charcoal', count: 2 }, { name: 'torch', count: 4 }] })
    const facts = goal.goalFacts(bot, { home: h })
    assert.equal(facts.coal, 5)
    assert.equal(facts.torches, 4)
    assert.equal(facts.unlit, 10)
    paintSpots(world, h)
    assert.equal(goal.goalFacts(bot, { home: h }).unlit, 0)
  })
  it("MENU.light announces 'lighting the yard' and decide picks it", async () => {
    assert.equal(goal.MENU.light.chat(), 'on my own: lighting the yard')
    const world = makeWorld()
    const h = home()
    const bot = mockBot(world, { items: [{ name: 'torch', count: 8 }] })
    // A finished house: every blueprint cell skipped reads as built-done.
    const ctx = { home: h, buildSkip: buildMod.BLUEPRINT.map((_, i) => i) }
    const d = await goal.decide(bot, ctx)
    assert.equal(d.action, 'light')
    assert.equal(ctx.step, 'light')
  })
  it('decide holds light across a facts change while crafting flies', async () => {
    const world = makeWorld()
    const h = home()
    const bot = mockBot(world, { items: [{ name: 'torch', count: 8 }] })
    const ctx = { home: h, buildSkip: buildMod.BLUEPRINT.map((_, i) => i) }
    await goal.decide(bot, ctx)
    assert.equal(ctx.step, 'light')
    ctx.lightCraftInFlight = true
    bot._items.push({ name: 'oak_log', count: 3 }) // facts flip mid-craft
    const d = await goal.decide(bot, ctx)
    assert.equal(d.action, 'light', 'craft window not preempted')
    assert.equal(ctx.stepStatus, 'running')
  })
})
