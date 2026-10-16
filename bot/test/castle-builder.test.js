// idkcraft-neuc.54: the castle v2 builder branch (mock world, mock body).
'use strict'

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const blueprint = require('../src/castle')
const castle = require('../src/behaviours/castle')

const SITE = { x: 100, y: 64, z: 200 }
const EMPTY = new Set(['air', 'torch', 'wall_torch'])
const ELIGIBLE = new Set(['stone', 'planks', 'frame', 'fence', 'torch'])

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
      return { name, boundingBox: EMPTY.has(name) ? 'empty' : 'block', position: { x: fx, y: fy, z: fz } }
    },
  }
}

const KIT = [
  { name: 'cobblestone', count: 500 }, { name: 'oak_planks', count: 500 },
  { name: 'oak_log', count: 200 }, { name: 'oak_fence', count: 200 },
  { name: 'torch', count: 64 }, { name: 'oak_door', count: 2 },
  { name: 'cobblestone_stairs', count: 64 },
]

function mockBot(world, { items = KIT, withBuilder = true, buildScript = 'ok' } = {}) {
  const calls = { goals: [], places: [], digs: [], builds: [] }
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
      movements: { exclusionAreasBreak: [], exclusionAreasPlace: [] },
      isMoving: () => false,
      setGoal: (g) => {
        calls.goals.push(g)
        if (g && g.pos) bot.entity.position = { x: g.pos.x + 0.5, y: g.pos.y + 2, z: g.pos.z + 0.5 }
        else if (g && g.constructor.name === 'GoalBlock') bot.entity.position = { x: g.x + 0.5, y: g.y, z: g.z + 0.5 }
        else if (g && typeof g.x === 'number') bot.entity.position = { x: g.x + 2.5, y: g.y, z: g.z + 0.5 }
      },
    },
    equip: async (item) => { bot.held = item.name },
    dig: async (b) => { calls.digs.push(b.position); world.set(b.position.x, b.position.y, b.position.z, 'air') },
    placeBlock: async (ref, face) => {
      const p = { x: ref.position.x + face.x, y: ref.position.y + face.y, z: ref.position.z + face.z }
      calls.places.push(p)
      world.set(p.x, p.y, p.z, bot.held)
    },
    chat: (m) => bot.chats.push(String(m)),
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
async function run(bot, ctx, ticks) {
  for (let i = 0; i < ticks; i++) {
    castle(bot, ctx)
    await settle()
  }
}

const LAID = { stone: 'cobblestone', planks: 'oak_planks', frame: 'oak_log', fence: 'oak_fence', torch: 'torch', door: 'oak_door', chest: 'chest' }
function paintAll(world, { except = null } = {}) {
  for (const c of blueprint.absPlan(SITE, 0, 3).cells) {
    if (!blueprint.isPlaceTarget(c.kind)) continue
    if (except && except(c)) continue
    if (LAID[c.kind]) world.set(c.x, c.y, c.z, LAID[c.kind])
  }
}

describe('castle builder branch (idkcraft-neuc.54)', () => {
  it('only plain cubes batch: no fence/stairs/door (core-6)', () => {
    assert.deepEqual([...castle.CASTLE_BUILDER_KINDS].sort(), ['frame', 'planks', 'stone', 'torch'])
    const world = makeWorld()
    // A lone open fence cell must not enter any schematic.
    paintAll(world, { except: (c) => c.kind === 'fence' })
    const bot = mockBot(world)
    const st = { site: { ...SITE }, rot: 0, blueprintVersion: 3 }
    const batch = castle.castleBuilderCells(bot, { castleCarry: null }, st)
    // Only fence cells stand open: no eligible cube is owed, so no batch.
    assert.equal(batch, null, 'open fence cells never form a schematic')
  })

  it('one buildCells call per batch; only plain cubes enter the schematic', async () => {
    const world = makeWorld()
    const bot = mockBot(world)
    // Everything stands except the door (old path) and a few cubes, so the
    // first pick is an eligible cube and the batch has something to cover.
    const open = new Set()
    paintAll(world, {
      except: (c) => {
        if (c.kind === 'door') return true
        if ((c.kind === 'stone' || c.kind === 'planks') && open.size < 6) {
          open.add(`${c.x},${c.y},${c.z}`)
          return true
        }
        return false
      },
    })
    const ctx = { castle: { site: { ...SITE }, rot: 0, blueprintVersion: 3 } }
    await run(bot, ctx, 1)
    assert.equal(bot.calls.builds.length, 1, 'one buildCells call per batch')
    const batch = bot.calls.builds[0]
    assert.ok(batch.name.startsWith('castle@'))
    assert.deepEqual(batch.origin, SITE)
    assert.ok(batch.cells.length >= 1 && batch.cells.length <= 256)
    const kinds = new Set()
    for (const c of batch.cells) {
      const at = blueprint.absPlan(SITE, 0, 3).at.get(`${batch.origin.x + c.dx},${batch.origin.y + c.dy},${batch.origin.z + c.dz}`)
      assert.ok(at, 'batch cell is on the plan')
      assert.ok(ELIGIBLE.has(at.kind), `plain cubes only, got ${at.kind}`)
      kinds.add(at.kind)
    }
    assert.ok(kinds.has('stone'), 'stone batches through the builder')
    assert.ok(bot.calls.places.length === 0, 'no per-cell placements while batching')
  })

  it('stairs keep the faced per-cell path (never in the schematic)', async () => {
    const world = makeWorld()
    paintAll(world) // everything stands...
    const plan = blueprint.absPlan(SITE, 0, 3).cells
    const stair = plan.find((c) => c.kind === 'stairs')
    world.set(stair.x, stair.y, stair.z, 'air') // ...except one step
    const bot = mockBot(world)
    const ctx = { castle: { site: { ...SITE }, rot: 0, blueprintVersion: 3 } }
    for (let i = 0; i < 8; i++) {
      bot.entity.position = { x: stair.x + 2.5, y: stair.y, z: stair.z + 0.5 }
      castle(bot, ctx)
      await settle()
    }
    assert.equal(bot.calls.builds.length, 0, 'no schematic for a stair')
    assert.ok(bot.calls.places.length > 0, 'the stair lays via placeCell')
    assert.ok(world.blockAt(stair).name.endsWith('_stairs'))
  })

  it('after phase complete a broken cube re-issues the schematic on arrival (repair)', async () => {
    const world = makeWorld()
    paintAll(world)
    const plan = blueprint.absPlan(SITE, 0, 3).cells
    const broken = plan.filter((c) => c.kind === 'stone' && blueprint.matches('stone', world.blockAt(c).name)).slice(0, 2)
    assert.equal(broken.length, 2)
    for (const c of broken) world.set(c.x, c.y, c.z, 'air')
    const bot = mockBot(world)
    bot.entity.position = { x: SITE.x + 2.5, y: 64, z: SITE.z + 2.5 } // on site
    const ctx = { castle: { site: { ...SITE }, rot: 0, blueprintVersion: 3, phase: 'complete', blocked: {} } }
    await run(bot, ctx, 3)
    assert.equal(bot.calls.builds.length, 1, 'repair re-issues one schematic')
    assert.equal(bot.calls.builds[0].cells.length, 2)
    for (const c of broken) assert.ok(blueprint.matches('stone', world.blockAt(c).name), 'broken cube re-laid')
  })

  it('with no held material the old path fails the fetch word (no empty schematic)', async () => {
    const world = makeWorld()
    const bot = mockBot(world, { items: [{ name: 'oak_door', count: 1 }] })
    const ctx = { castle: { site: { ...SITE }, rot: 0, blueprintVersion: 3 } }
    await run(bot, ctx, 3)
    assert.equal(bot.calls.builds.length, 0)
    assert.ok((ctx.stepStatus || '').startsWith('failed:no-'), `fetch word, got ${ctx.stepStatus}`)
  })

  it('without buildCells nothing batches (v1 path untouched)', async () => {
    const world = makeWorld()
    const bot = mockBot(world, { withBuilder: false })
    assert.equal(typeof bot.buildCells, 'undefined')
    const ctx = { castle: { site: { ...SITE }, rot: 0, blueprintVersion: 3 } }
    await run(bot, ctx, 6)
    assert.ok(bot.calls.places.length > 0, 'per-cell placements still lay')
  })

  it('a wedged builder fails build-stall and releases the flight (core-9)', async () => {
    const world = makeWorld()
    const bot = mockBot(world, { buildScript: 'stall' })
    const ctx = { castle: { site: { ...SITE }, rot: 0, blueprintVersion: 3 } }
    await run(bot, ctx, 1)
    assert.equal(bot.calls.builds.length, 1)
    assert.equal(ctx.stepStatus, 'failed:build-stall')
    assert.equal(ctx.castleBuildFlight, false)
  })

  it('a starved batch fails the fetch word and releases the flight (core-9)', async () => {
    const world = makeWorld()
    const bot = mockBot(world, { buildScript: 'starve' })
    const ctx = { castle: { site: { ...SITE }, rot: 0, blueprintVersion: 3 } }
    await run(bot, ctx, 1)
    assert.equal(bot.calls.builds.length, 1)
    assert.ok((ctx.stepStatus || '').startsWith('failed:no-'), `fetch word, got ${ctx.stepStatus}`)
    assert.equal(ctx.castleBuildFlight, false)
  })

  it('two refused cells both back off after 3 stalls (round-2 core-1)', async () => {
    const world = makeWorld()
    const plan = blueprint.absPlan(SITE, 0, 3).cells
    const open = plan.filter((c) => c.kind === 'stone').slice(0, 2)
    paintAll(world, { except: (c) => open.includes(c) })
    const bot = mockBot(world, { buildScript: 'stall' })
    const ctx = { castle: { site: { ...SITE }, rot: 0, blueprintVersion: 3 } }
    await run(bot, ctx, 5)
    assert.ok(bot.calls.builds.length >= 3, `re-batches while unblocked (${bot.calls.builds.length})`)
    const keys = open.map((c) => `${blueprint.blueprintOf(3).version}:${c.idx}`)
    for (const k of keys) assert.ok(ctx.castle.blocked[k], `${k} backed off`)
  })

  it('a stale preemption neither fails nor strikes (round-2 core-2)', async () => {
    const world = makeWorld()
    const bot = mockBot(world, { buildScript: 'starve' })
    const ctx = { castle: { site: { ...SITE }, rot: 0, blueprintVersion: 3 } }
    castle(bot, ctx)
    ctx.stepGen = (ctx.stepGen | 0) + 1 // the step turned over mid-batch
    await settle()
    assert.ok(!ctx.stepStatus, `stale settle writes nothing, got ${ctx.stepStatus}`)
    assert.equal(ctx.castleBuildFlight, false)
    assert.deepEqual(ctx.castle.batchStrikes || {}, {})
  })

  it('a same-step preemption neither fails nor strikes (round-3 core-2)', async () => {
    const world = makeWorld()
    const bot = mockBot(world, { buildScript: 'preempted' })
    const ctx = { castle: { site: { ...SITE }, rot: 0, blueprintVersion: 3 } }
    castle(bot, ctx)
    await settle()
    assert.ok(!ctx.stepStatus, `preempted settle writes nothing, got ${ctx.stepStatus}`)
    assert.equal(ctx.castleBuildFlight, false)
    assert.deepEqual(ctx.castle.batchStrikes || {}, {})
  })
})
