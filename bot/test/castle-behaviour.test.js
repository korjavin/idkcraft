'use strict'

// idkcraft-g0z.2: the castle executor lays the src/castle.js plan from the
// world, blocks (never skips) refusing cells with backoff and a layer gate,
// protects laid castle blocks for every executor, and builds the slice
// tower to completion on a fake world.

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const blueprint = require('../src/castle')
const castle = require('../src/behaviours/castle')
const { protectedReason } = require('../src/behaviours/util')
const { BEHAVIOURS } = require('../src/index')

const SITE = { x: 100, y: 64, z: 200 }
const EMPTY = new Set(['air', 'torch', 'wall_torch'])

function makeWorld() {
  const cells = new Map()
  const key = (x, y, z) => `${Math.floor(x)},${Math.floor(y)},${Math.floor(z)}`
  return {
    set(x, y, z, name) { cells.set(key(x, y, z), name) },
    get(x, y, z) { return this.blockAt({ x, y, z }).name },
    blockAt(p) {
      const fx = Math.floor(p.x)
      const fy = Math.floor(p.y)
      const fz = Math.floor(p.z)
      const k = key(fx, fy, fz)
      const name = cells.has(k) ? cells.get(k) : (fy <= 63 ? 'dirt' : 'air')
      return { name, boundingBox: EMPTY.has(name) ? 'empty' : 'block', position: { x: fx, y: fy, z: fz } }
    },
  }
}

const KIT = [
  { name: 'cobblestone', count: 64 }, { name: 'oak_planks', count: 64 },
  { name: 'oak_door', count: 1 }, { name: 'torch', count: 8 },
]

function mockBot(world, { items = KIT, refuse = () => false } = {}) {
  const calls = { goals: [], places: [], digs: [] }
  const bot = {
    calls,
    chats: [],
    entity: { position: { x: SITE.x - 3, y: 64, z: SITE.z - 3 } },
    world: { getBlock: () => null },
    players: {},
    held: null,
    inventory: { items: () => items },
    blockAt: (p) => world.blockAt(p),
    pathfinder: {
      movements: { exclusionAreasBreak: [] },
      isMoving: () => false,
      // Teleport-arrival in reach, never in the target: place goals stand
      // two above it, dig goals (GoalNear) two beside it.
      setGoal: (g) => {
        calls.goals.push(g)
        if (g && g.pos) bot.entity.position = { x: g.pos.x + 0.5, y: g.pos.y + 2, z: g.pos.z + 0.5 }
        else if (g && g.constructor.name === 'GoalBlock') bot.entity.position = { x: g.x + 0.5, y: g.y, z: g.z + 0.5 }
        else if (g && typeof g.x === 'number') bot.entity.position = { x: g.x + 2.5, y: g.y, z: g.z + 0.5 }
      },
    },
    equip: async (item) => { bot.held = item.name },
    dig: async (b) => {
      calls.digs.push(b.position)
      world.set(b.position.x, b.position.y, b.position.z, 'air')
    },
    placeBlock: async (ref, face) => {
      const p = { x: ref.position.x + face.x, y: ref.position.y + face.y, z: ref.position.z + face.z }
      if (refuse(p)) throw new Error('refused')
      calls.places.push(p)
      world.set(p.x, p.y, p.z, bot.held)
    },
    chat: (m) => bot.chats.push(String(m)),
  }
  return bot
}

const settle = async (n = 4) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)) }

async function run(bot, ctx, ticks) {
  for (let i = 0; i < ticks; i++) {
    castle(bot, ctx)
    await settle()
  }
}

function cells() { return blueprint.absPlan(SITE, 0).cells }
function paint(world, upto) {
  for (const c of cells()) {
    if (c.idx >= upto || !blueprint.isPlaceTarget(c.kind)) continue
    world.set(c.x, c.y, c.z, { stone: 'cobblestone', planks: 'oak_planks', door: 'oak_door', torch: 'torch' }[c.kind])
  }
}

describe('g0z.2 castle executor', () => {
  it('is registered in BEHAVIOURS', () => {
    assert.equal(BEHAVIOURS.castle, castle)
  })

  it('lays the first ground ring in plan order', async () => {
    const world = makeWorld()
    const bot = mockBot(world)
    const ctx = { castle: { site: SITE, rot: 0 } }
    // The door is deferred (revmux 01): the doorway stays open for A*.
    const ring = cells().filter((c) => c.dy === 0 && blueprint.isPlaceTarget(c.kind) && c.kind !== 'door').slice(0, 15)
    await run(bot, ctx, 80)
    const laid = bot.calls.places.slice(0, 15).map((p) => `${p.x},${p.y},${p.z}`)
    assert.deepEqual(laid, ring.map((c) => `${c.x},${c.y},${c.z}`))
    assert.equal(world.get(ring[0].x, 64, ring[0].z), 'cobblestone')
    const door = cells().find((c) => c.kind === 'door')
    assert.equal(world.get(door.x, door.y, door.z), 'air')
  })

  it('lays the door last, from the entrance apron outside', async () => {
    const world = makeWorld()
    const bot = mockBot(world)
    const plan = cells()
    const door = plan.find((c) => c.kind === 'door')
    paint(world, plan.length)
    world.set(door.x, door.y, door.z, 'air')
    const ctx = { castle: { site: SITE, rot: 0 } }
    await run(bot, ctx, 4)
    const g = bot.calls.goals[0]
    const e = blueprint.ENTRANCE
    assert.deepEqual([g.x, g.y, g.z], [SITE.x + e.dx, SITE.y + e.dy, SITE.z + e.dz])
    assert.equal(world.get(door.x, door.y, door.z), 'oak_door')
    assert.equal(ctx.stepStatus, 'done')
  })

  it('never places the door from inside: off the apron re-walks, then blocks', async () => {
    const world = makeWorld()
    const bot = mockBot(world)
    const plan = cells()
    const door = plan.find((c) => c.kind === 'door')
    paint(world, plan.length)
    world.set(door.x, door.y, door.z, 'air')
    bot.pathfinder.setGoal = (g) => { bot.calls.goals.push(g) } // the walk never lands
    bot.entity.position = { x: SITE.x + 5.5, y: SITE.y, z: SITE.z + 5.5 } // ground floor, in reach
    const ctx = { castle: { site: SITE, rot: 0 } }
    await run(bot, ctx, 8)
    assert.equal(world.get(door.x, door.y, door.z), 'air')
    assert.ok(bot.calls.goals.length >= 3, 're-issues the apron walk')
    assert.equal(ctx.castle.blocked[`${blueprint.BLUEPRINT_VERSION}:${door.idx}`].why, 'off-apron')
  })

  it('a sunken apron floor (soul sand, feet ~0.125 low) still counts as on the apron', async () => {
    const world = makeWorld()
    const bot = mockBot(world)
    const plan = cells()
    const door = plan.find((c) => c.kind === 'door')
    paint(world, plan.length)
    world.set(door.x, door.y, door.z, 'air')
    const set = bot.pathfinder.setGoal
    bot.pathfinder.setGoal = (g) => { set(g); bot.entity.position.y -= 0.125 }
    const ctx = { castle: { site: SITE, rot: 0 } }
    await run(bot, ctx, 4)
    assert.equal(world.get(door.x, door.y, door.z), 'oak_door')
  })

  it('digs a wrong natural occupant out of a place cell, then lays it', async () => {
    const world = makeWorld()
    const bot = mockBot(world)
    const c = cells()[0]
    world.set(c.x, c.y, c.z, 'grass_block')
    const ctx = { castle: { site: SITE, rot: 0 } }
    await run(bot, ctx, 6)
    assert.deepEqual(bot.calls.digs[0], { x: c.x, y: c.y, z: c.z })
    assert.equal(world.get(c.x, c.y, c.z), 'cobblestone')
  })

  it('our own scaffold in a place cell is dug like terrain', async () => {
    const world = makeWorld()
    const bot = mockBot(world)
    const c = cells()[0]
    world.set(c.x, c.y, c.z, 'oak_planks') // wrong kind, but ours
    const ctx = { castle: { site: SITE, rot: 0 }, placedByBot: new Set([`${c.x},${c.y},${c.z}`]) }
    await run(bot, ctx, 6)
    assert.deepEqual(bot.calls.digs[0], { x: c.x, y: c.y, z: c.z })
    assert.equal(world.get(c.x, c.y, c.z), 'cobblestone')
    // After a restart (no placedByBot) a cobblestone scaffold in a landing
    // cell still clears: it is the Movements scaffold item.
    const land = cells().find((x) => x.kind === 'planks')
    world.set(land.x, land.y, land.z, 'cobblestone')
    paint(world, land.idx)
    const ctx2 = { castle: { site: SITE, rot: 0 } }
    await run(bot, ctx2, 6)
    assert.equal(world.get(land.x, land.y, land.z), 'oak_planks')
  })

  it('standing on our own dig target steps aside (bot.players lists the bot too)', async () => {
    const world = makeWorld()
    const bot = mockBot(world)
    const c = cells()[0]
    world.set(c.x, c.y, c.z, 'dirt')
    bot.players = { Me: { entity: bot.entity } }
    bot.pathfinder.setGoal = (g) => {
      bot.calls.goals.push(g)
      // The approach parks ON the dig target; the sidestep moves off it.
      if (g && typeof g.x === 'number' && bot.calls.goals.length === 1) bot.entity.position = { x: c.x + 0.5, y: c.y + 1, z: c.z + 0.5 }
      else if (g && typeof g.x === 'number') bot.entity.position = { x: c.x + 2.5, y: c.y, z: c.z + 0.5 }
    }
    const ctx = { castle: { site: SITE, rot: 0 } }
    await run(bot, ctx, 4)
    assert.deepEqual(ctx.castle.blocked, {})
    assert.deepEqual(bot.calls.digs[0], { x: c.x, y: c.y, z: c.z })
  })

  it('a foreign occupant (player build) is kept and blocked, never dug', async () => {
    const world = makeWorld()
    const bot = mockBot(world)
    const c = cells()[0]
    world.set(c.x, c.y, c.z, 'chest')
    const ctx = { castle: { site: SITE, rot: 0 } }
    await run(bot, ctx, 2)
    assert.equal(bot.calls.digs.length, 0)
    assert.equal(ctx.castle.blocked[`${blueprint.BLUEPRINT_VERSION}:0`].why, 'kept-chest')
  })

  it('an unreachable cell blocks after three stands that get no closer', async () => {
    const world = makeWorld()
    const bot = mockBot(world)
    bot.pathfinder.setGoal = (g) => { bot.calls.goals.push(g) } // never arrives
    bot.entity.position = { x: SITE.x - 30, y: 64, z: SITE.z - 30 }
    const ctx = { castle: { site: SITE, rot: 0 } }
    await run(bot, ctx, 5)
    assert.equal(ctx.castle.blocked[`${blueprint.BLUEPRINT_VERSION}:0`], undefined, 'approach ticks never strike')
    await run(bot, ctx, 5)
    assert.equal(ctx.castle.blocked[`${blueprint.BLUEPRINT_VERSION}:0`].why, 'unreachable')
    assert.equal(bot.calls.places.length, 0)
  })

  it('standing in the target steps aside, then blocks past SELF_OCC_LIMIT', async () => {
    const world = makeWorld()
    const bot = mockBot(world)
    const c = cells()[0]
    bot.pathfinder.setGoal = (g) => { bot.calls.goals.push(g) }
    bot.entity.position = { x: c.x + 0.5, y: c.y, z: c.z + 0.5 }
    const ctx = { castle: { site: SITE, rot: 0 } }
    await run(bot, ctx, 12)
    assert.ok(bot.calls.goals.length >= 3, 'sidestep goals issued')
    assert.equal(ctx.castle.blocked[`${blueprint.BLUEPRINT_VERSION}:0`].why, 'occupied')
    assert.ok(!bot.calls.places.some((p) => p.x === c.x && p.y === c.y && p.z === c.z), 'never placed into its own body')
  })

  it('a hung place flight is released after FLIGHT_TIMEOUT_MS and strikes', async () => {
    const world = makeWorld()
    const bot = mockBot(world)
    bot.placeBlock = () => new Promise(() => {}) // never settles
    const ctx = { castle: { site: SITE, rot: 0 } }
    await run(bot, ctx, 3)
    assert.equal(ctx.placeInFlight, true)
    ctx.castleFlight.since -= 31000
    await run(bot, ctx, 1)
    assert.equal(ctx.castleFails.n, 1)
    assert.ok(ctx.placeInFlight) // a fresh flight, not the hung one
  })

  it('re-issues the approach when a borrower replaced the goal', async () => {
    const world = makeWorld()
    const bot = mockBot(world)
    bot.pathfinder.isMoving = () => true
    bot.pathfinder.goal = null
    const set = bot.pathfinder.setGoal
    bot.pathfinder.setGoal = (g) => { bot.pathfinder.goal = g; set(g) }
    const ctx = { castle: { site: SITE, rot: 0 } }
    await run(bot, ctx, 2)
    assert.equal(bot.calls.goals.length, 1)
    bot.pathfinder.goal = { borrowed: true } // fight took the body for a tick
    await run(bot, ctx, 1)
    assert.equal(bot.calls.goals.length, 2)
  })

  it('a missing material reports failed:no-stone without walking', async () => {
    const world = makeWorld()
    const bot = mockBot(world, { items: [{ name: 'oak_planks', count: 64 }] })
    const ctx = { castle: { site: SITE, rot: 0 } }
    await run(bot, ctx, 3)
    assert.equal(ctx.stepStatus, 'failed:no-stone')
    assert.equal(bot.calls.goals.length, 0)
  })

  it('a broken cell is re-laid on the periodic full rescan', async () => {
    const world = makeWorld()
    const bot = mockBot(world)
    const plan = cells()
    paint(world, plan.length)
    const ctx = { castle: { site: SITE, rot: 0 } }
    await run(bot, ctx, 2)
    assert.equal(ctx.stepStatus, 'done')
    assert.equal(ctx.castle.phase, 'complete')
    const victim = plan[3]
    world.set(victim.x, victim.y, victim.z, 'air')
    ctx.castleScanAt = Date.now() - castle.FULL_RESCAN_MS
    await run(bot, ctx, 4)
    assert.equal(world.get(victim.x, victim.y, victim.z), 'cobblestone')
    assert.ok(bot.calls.places.some((p) => p.x === victim.x && p.y === victim.y && p.z === victim.z))
  })

  it('digs a filled air cell during construction, never after complete', async () => {
    const world = makeWorld()
    const bot = mockBot(world)
    const plan = cells()
    paint(world, plan.length)
    const win = plan.find((c) => c.kind === 'air' && c.dy === 4)
    world.set(win.x, win.y, win.z, 'dirt')
    const ctx = { castle: { site: SITE, rot: 0, phase: 'body' } }
    await run(bot, ctx, 4)
    assert.equal(world.get(win.x, win.y, win.z), 'air')
    assert.equal(ctx.castle.phase, 'complete')
    world.set(win.x, win.y, win.z, 'dirt') // owner's block inside: kept
    ctx.castleScanAt = 0
    await run(bot, ctx, 4)
    assert.equal(world.get(win.x, win.y, win.z), 'dirt')
    assert.equal(bot.calls.digs.length, 1)
  })

  it('three refusals block a cell with backoff and gate the layers above', async () => {
    const world = makeWorld()
    const plan = cells()
    const stuck = plan.find((c) => c.dy === 1)
    let refusing = true
    const bot = mockBot(world, { refuse: (p) => refusing && p.x === stuck.x && p.y === stuck.y && p.z === stuck.z })
    paint(world, stuck.idx)
    const ctx = { castle: { site: SITE, rot: 0 } }
    await run(bot, ctx, 60)
    const e = ctx.castle.blocked[`${blueprint.BLUEPRINT_VERSION}:${stuck.idx}`]
    assert.ok(e && e.tries === 1 && e.until > Date.now())
    assert.ok(bot.calls.places.every((p) => p.y <= SITE.y + 1), 'nothing above the blocked layer')
    assert.ok(bot.calls.places.some((p) => p.y === SITE.y + 1), 'the rest of its layer still lays')
    assert.equal(ctx.stepStatus, 'failed:blocked')
    assert.match(ctx.castle.status, /^blocked at /)
    // Backoff expires: the cell retries (and now lands).
    e.until = 0
    refusing = false
    await run(bot, ctx, 6)
    assert.equal(world.get(stuck.x, stuck.y, stuck.z), 'cobblestone')
    assert.equal(ctx.castle.blocked[`${blueprint.BLUEPRINT_VERSION}:${stuck.idx}`], undefined)
  })

  it('backoff is bounded', () => {
    assert.equal(castle.backoffMs(1), 30000)
    assert.equal(castle.backoffMs(20), 600000)
  })

  it('builds the whole slice tower to completion', async () => {
    const world = makeWorld()
    const bot = mockBot(world)
    const ctx = { castle: { site: SITE, rot: 1 } }
    const places = blueprint.absPlan(SITE, 1).cells.filter((c) => blueprint.isPlaceTarget(c.kind))
    await run(bot, ctx, places.length * 3 + 20)
    assert.equal(ctx.stepStatus, 'done')
    assert.deepEqual(ctx.castle.blocked, {})
    for (const c of places) assert.ok(blueprint.matches(c.kind, world.get(c.x, c.y, c.z)), `${c.kind} at ${c.x},${c.y},${c.z}`)
    const door = places.find((c) => c.kind === 'door')
    const last = bot.calls.places[bot.calls.places.length - 1]
    assert.deepEqual([last.x, last.y, last.z], [door.x, door.y, door.z], 'door laid last')
    assert.deepEqual(bot.chats, [`castle done at ${SITE.x} ${SITE.y} ${SITE.z}`])
  })
})

describe('g0z.2 castle protection', () => {
  it('laid castle blocks are protected before the placedByBot exemption', () => {
    const c = cells()[0]
    const block = { name: 'cobblestone', position: { x: c.x, y: c.y, z: c.z } }
    const ctx = { castle: { site: SITE, rot: 0 }, placedByBot: new Set([`${c.x},${c.y},${c.z}`]) }
    assert.equal(protectedReason(null, block, ctx), 'protected')
    assert.equal(protectedReason(null, block, { placedByBot: ctx.placedByBot }), null)
    // A wrong natural occupant of a castle cell stays diggable.
    assert.equal(protectedReason(null, { name: 'dirt', position: block.position }, ctx), null)
  })

  it('guardCastle vetoes pathfinder breaks of laid castle blocks', () => {
    const world = makeWorld()
    const bot = mockBot(world)
    const ctx = { castle: { site: SITE, rot: 0 } }
    castle.guardCastle(bot, ctx)
    castle.guardCastle(bot, ctx) // idempotent
    const list = bot.pathfinder.movements.exclusionAreasBreak
    assert.equal(list.length, 1)
    const c = cells()[0]
    assert.equal(list[0]({ name: 'cobblestone', position: c }), 100)
    assert.equal(list[0]({ name: 'dirt', position: c }), 0)
    ctx.castle = null
    assert.equal(list[0]({ name: 'cobblestone', position: c }), 0)
    // Movements replaced: re-installed on the new object.
    ctx.castle = { site: SITE, rot: 0 }
    bot.pathfinder.movements = { exclusionAreasBreak: [] }
    castle.guardCastle(bot, ctx)
    assert.equal(bot.pathfinder.movements.exclusionAreasBreak.length, 1)
  })
})
