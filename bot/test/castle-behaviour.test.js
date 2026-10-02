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
    const ring = cells().filter((c) => c.dy === 0 && blueprint.isPlaceTarget(c.kind)).slice(0, 16)
    await run(bot, ctx, 80)
    const laid = bot.calls.places.slice(0, 16).map((p) => `${p.x},${p.y},${p.z}`)
    assert.deepEqual(laid, ring.map((c) => `${c.x},${c.y},${c.z}`))
    assert.equal(world.get(ring[0].x, 64, ring[0].z), 'cobblestone')
    const door = ring.find((c) => c.kind === 'door')
    assert.equal(world.get(door.x, door.y, door.z), 'oak_door')
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
