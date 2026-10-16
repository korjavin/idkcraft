// idkcraft-neuc.54: the house v2 builder branch (mock world, mock body).
'use strict'

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const Vec3 = require('vec3')
const build = require('../src/behaviours/build')
const { BLUEPRINT_V2 } = build

const SITE = { x: 0, y: 64, z: 0 }

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

const KIT = [
  { name: 'oak_planks', count: 200 },
  { name: 'oak_door', count: 2 },
  { name: 'crafting_table', count: 2 },
]

// Mock body; withBuilder adds bot.buildCells painting the world like the
// mod would (one batch per call).
function mockBot(world, { items = KIT, withBuilder = true, buildScript = 'ok' } = {}) {
  const calls = { goals: [], places: [], digs: [], equips: [], builds: [] }
  const bot = {
    calls,
    chats: [],
    entity: { position: { x: 0.5, y: 65, z: 3.5 } },
    world: { getBlock: () => null },
    players: {},
    held: null,
    inventory: { items: () => items },
    blockAt: (p) => world.blockAt(p),
    findBlocks: () => [],
    pathfinder: { isMoving: () => false, setGoal: (g) => { calls.goals.push(g) } },
    equip: async (item) => { calls.equips.push(item.name); bot.held = item.name },
    dig: async (b) => { calls.digs.push(b.name); world.set(b.position.x, b.position.y, b.position.z, 'air') },
    placeBlock: async (ref, face) => {
      const rp = (ref && ref.position) || ref
      calls.places.push(bot.held)
      world.set(rp.x + face.x, rp.y + face.y, rp.z + face.z, bot.held)
    },
    chat: (m) => { calls.chats.push(String(m)) },
  }
  if (withBuilder) {
    bot.buildCells = async (name, origin, cells, opts) => {
      calls.builds.push({ name, origin, cells: cells.map((c) => ({ ...c })), forbid: opts && opts.forbid })
      if (buildScript === 'stall') throw new Error('build-stall')
      if (buildScript === 'preempted') throw new Error('build-preempted')
      if (buildScript === 'starve') return { placed: 0, missing: cells.length }
      for (const c of cells) world.set(origin.x + c.dx, origin.y + c.dy, origin.z + c.dz, c.block)
      return { placed: cells.length, missing: 0 }
    }
  }
  return bot
}

const settle = async (n = 4) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)) }

// Stand by the next undone cell (in reach) before every tick.
async function run(bot, ctx, ticks) {
  for (let i = 0; i < ticks; i++) {
    const idx = build.nextCellIdx(bot, ctx.home, ctx.buildSkip, ctx)
    if (idx >= 0) {
      const cell = build.blueprintFor(ctx.home)[idx]
      bot.entity.position = { x: ctx.home.site.x + cell.dx + 0.5, y: ctx.home.site.y + cell.dy + 1, z: ctx.home.site.z + cell.dz + 1.5 }
    }
    build(bot, ctx)
    await settle()
    if (ctx.stepStatus === 'done' || (ctx.stepStatus || '').startsWith('failed:')) break
  }
}

function freshCtx() {
  return { home: { site: { ...SITE }, v: 2 }, step: 'build', stepStatus: 'running', buildSkip: [], buildLastProgressLog: Date.now() }
}

describe('house builder branch (idkcraft-neuc.54)', () => {
  it('batches planks+fill in one buildCells call; door and table keep the per-cell path', async () => {
    const world = makeWorld()
    // Fill dips read undone (air below the floor line).
    for (const [dx, dz] of [[1, 4], [2, 4], [4, 4], [5, 4], [3, 0]]) world.set(dx, 63, dz, 'air')
    const bot = mockBot(world)
    const ctx = freshCtx()
    await run(bot, ctx, 40)
    assert.equal(bot.calls.builds.length, 1, 'one buildCells call per batch')
    const batch = bot.calls.builds[0]
    assert.equal(batch.name, 'house')
    assert.deepEqual(batch.origin, SITE)
    assert.ok(batch.cells.length > 50, `batch covers the plan cubes (${batch.cells.length})`)
    for (const c of batch.cells) {
      assert.ok(c.block.endsWith('_planks'), `plain cube only, got ${c.block}`)
    }
    assert.deepEqual(batch.forbid, ['oak_planks'])
    // Door and table went through placeBlock, never the schematic.
    assert.ok(bot.calls.places.includes('oak_door'), 'door laid via the old path')
    assert.ok(bot.calls.places.includes('crafting_table'), 'table laid via the old path')
    assert.equal(ctx.stepStatus, 'done')
    assert.equal(ctx.home.built, true)
  })

  it('a wedged builder fails build-stall loud', async () => {
    const world = makeWorld()
    const bot = mockBot(world, { buildScript: 'stall' })
    const ctx = freshCtx()
    await run(bot, ctx, 4)
    assert.equal(ctx.stepStatus, 'failed:build-stall')
  })

  it('a starved batch fails no-planks so the FSM fetches', async () => {
    const world = makeWorld()
    const bot = mockBot(world, { buildScript: 'starve' })
    const ctx = freshCtx()
    await run(bot, ctx, 4)
    assert.equal(ctx.stepStatus, 'failed:no-planks')
  })

  it('a refused cell skips after 3 watchdog stalls (core-3 strike-back)', async () => {
    const world = makeWorld()
    // Nothing ever lands (stalling stub paints nothing) but planks stay on
    // hand, so every stall strikes; after 3 the cells skip like 3 refusals.
    const bot = mockBot(world, { buildScript: 'stall' })
    const ctx = freshCtx()
    for (let i = 0; i < 3; i++) {
      build(bot, ctx)
      await settle()
    }
    assert.ok(ctx.buildSkip.length > 0, 'struck cells skip instead of re-batching forever')
    assert.equal(ctx.stepStatus, 'failed:build-stall')
  })

  it('starved batches never strike (round-2 core-2)', async () => {
    const world = makeWorld()
    const bot = mockBot(world, { buildScript: 'starve' })
    const ctx = freshCtx()
    for (let i = 0; i < 3; i++) {
      build(bot, ctx)
      await settle()
    }
    assert.deepEqual(ctx.buildSkip, [])
    assert.deepEqual(ctx.buildBatchStrikes || {}, {})
    assert.equal(ctx.stepStatus, 'failed:no-planks')
  })

  it('a stale preemption never strikes nor fails (round-2 core-2)', async () => {
    const world = makeWorld()
    const bot = mockBot(world, { buildScript: 'stall' })
    const ctx = freshCtx()
    build(bot, ctx)
    ctx.stepGen = (ctx.stepGen | 0) + 1 // the step turned over mid-batch
    await settle()
    assert.deepEqual(ctx.buildSkip, [])
    assert.deepEqual(ctx.buildBatchStrikes || {}, {})
    assert.equal(ctx.stepStatus, 'running')
    assert.equal(ctx.buildCellsInFlight, false)
  })

  it('a same-step preemption neither strikes nor fails (round-3 core-2)', async () => {
    const world = makeWorld()
    // Fight took the body mid-batch without turning the step over: the
    // adapter rejects build-preempted, and the step re-batches silently.
    const bot = mockBot(world, { buildScript: 'preempted' })
    const ctx = freshCtx()
    build(bot, ctx)
    await settle()
    assert.deepEqual(ctx.buildSkip, [])
    assert.deepEqual(ctx.buildBatchStrikes || {}, {})
    assert.equal(ctx.stepStatus, 'running')
    assert.equal(ctx.buildCellsInFlight, false)
  })

  it('without buildCells the v1 per-cell path is unchanged (planks via placeBlock)', async () => {
    const world = makeWorld()
    for (const [dx, dz] of [[1, 4], [2, 4], [4, 4], [5, 4], [3, 0]]) world.set(dx, 63, dz, 'air')
    const bot = mockBot(world, { withBuilder: false })
    assert.equal(typeof bot.buildCells, 'undefined')
    const ctx = freshCtx()
    await run(bot, ctx, 500)
    assert.ok(bot.calls.places.includes('oak_planks'), 'planks still placed per cell')
    assert.equal(ctx.stepStatus, 'done')
  })

  it('with no planks on hand the old path fails no-planks (no empty schematic)', async () => {
    const world = makeWorld()
    const bot = mockBot(world, { items: [{ name: 'oak_door', count: 1 }, { name: 'crafting_table', count: 1 }] })
    const ctx = freshCtx()
    await run(bot, ctx, 12)
    assert.equal(bot.calls.builds.length, 0)
    assert.equal(ctx.stepStatus, 'failed:no-planks')
  })
})
