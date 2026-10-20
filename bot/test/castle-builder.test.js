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
      if (buildScript === 'starve-spent') { items.length = 0; return { placed: 0, missing: cells.length } }
      if (buildScript === 'starve-names') { // the mod spent every named stack, other variants stay
        const names = new Set(cells.map((c) => c.block))
        for (let i = items.length - 1; i >= 0; i--) if (names.has(items[i].name)) items.splice(i, 1)
        return { placed: 0, missing: cells.length }
      }
      if (buildScript === 'partial') { // laid half the batch, refused the rest
        const half = cells.slice(0, Math.ceil(cells.length / 2))
        for (const c of half) world.set(origin.x + c.dx, origin.y + c.dy, origin.z + c.dz, c.block)
        return { placed: half.length, missing: cells.length - half.length }
      }
      if (buildScript === 'stall-after-partial') { // laid half, then wedged
        const half = cells.slice(0, Math.ceil(cells.length / 2))
        for (const c of half) world.set(origin.x + c.dx, origin.y + c.dy, origin.z + c.dz, c.block)
        throw new Error('build-stall')
      }
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

function capture() {
  const logged = []
  const origLog = console.log
  console.log = (m) => { logged.push(String(m)) }
  return { logged, release() { console.log = origLog } }
}

describe('castle builder branch (idkcraft-neuc.54)', () => {
  it('the fire line names the batch composition (r185 stall diagnosis)', async () => {
    const world = makeWorld()
    paintAll(world)
    const plan = blueprint.absPlan(SITE, 0, 3).cells
    const broken = plan.filter((c) => c.kind === 'stone').slice(0, 2)
    for (const c of broken) world.set(c.x, c.y, c.z, 'air')
    const bot = mockBot(world)
    const ctx = { castle: { site: { ...SITE }, rot: 0, blueprintVersion: 3 } }
    const cap = capture()
    try {
      castle(bot, ctx)
      await settle()
    } finally {
      cap.release()
    }
    const line = cap.logged.find((m) => m.startsWith('castle builder castle@'))
    assert.ok(line, `fire line logged, got: ${cap.logged.join(' | ').slice(0, 200)}`)
    assert.ok(/stone/.test(line) && /first=/.test(line), `composition reads back: ${line}`)
  })

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

  it('a starved batch with the kind spent fails the fetch word and releases the flight (core-9)', async () => {
    const world = makeWorld()
    const bot = mockBot(world, { items: KIT.map((i) => ({ ...i })), buildScript: 'starve-spent' })
    const ctx = { castle: { site: { ...SITE }, rot: 0, blueprintVersion: 3 } }
    await run(bot, ctx, 1)
    assert.equal(bot.calls.builds.length, 1)
    assert.ok((ctx.stepStatus || '').startsWith('failed:no-'), `fetch word, got ${ctx.stepStatus}`)
    assert.equal(ctx.castleBuildFlight, false)
  })

  it('a starved batch with the kind still usable re-batches, no fetch word, no strike (cu1a)', async () => {
    const world = makeWorld()
    const items = [{ name: 'cobblestone', count: 300 }, { name: 'andesite', count: 30 }]
    const bot = mockBot(world, { items, buildScript: 'starve-names' })
    const ctx = { castle: { site: { ...SITE }, rot: 0, blueprintVersion: 3 } }
    await run(bot, ctx, 1)
    assert.equal(bot.calls.builds.length, 1)
    assert.ok(!(ctx.stepStatus || '').startsWith('failed:'), `no failure while usable, got ${ctx.stepStatus}`)
    assert.equal(ctx.castleBuildFlight, false)
    assert.deepEqual(ctx.castle.batchStrikes || {}, {}, 'starved misses never strike')
    await run(bot, ctx, 1)
    assert.equal(bot.calls.builds.length, 2, 'the next tick re-batches')
    assert.ok(bot.calls.builds[1].cells.every((c) => c.block === 'andesite'), 'fresh names from what is left')
  })

  it('a final that leaves cells missing with their name still held strikes them (cu1a review)', async () => {
    const world = makeWorld()
    const bot = mockBot(world, { buildScript: 'starve' })
    const ctx = { castle: { site: { ...SITE }, rot: 0, blueprintVersion: 3 } }
    await run(bot, ctx, 1)
    assert.ok(!(ctx.stepStatus || '').startsWith('failed:'), `no fetch word, got ${ctx.stepStatus}`)
    assert.ok(Object.keys(ctx.castle.batchStrikes || {}).length > 0, 'refused cells strike')
  })

  it('a stack is never named past its count: the next stack takes over (cu1a review)', () => {
    const world = makeWorld()
    const items = [{ name: 'cobblestone', count: 40 }, { name: 'andesite', count: 40 }, { name: 'granite', count: 10 }]
    const bot = mockBot(world, { items })
    const ctx = { castleCarry: null }
    const st = { site: { ...SITE }, rot: 0, blueprintVersion: 3 }
    const stone = castle.castleBuilderCells(bot, ctx, st).cells.filter((c) => c.kind === 'stone')
    const by = {}
    for (const c of stone) by[c.block] = (by[c.block] | 0) + 1
    assert.equal(stone.length, castle.usable(bot, 'stone', ctx), 'budget = usable')
    assert.ok(by.cobblestone <= 40 && by.andesite <= 40 && (by.granite | 0) <= 10, JSON.stringify(by))
    assert.ok(by.cobblestone > 0 && by.andesite > 0, `both stacks named: ${JSON.stringify(by)}`)
  })

  it('the owner\'s carried stacks never get names (cu1a review)', () => {
    const world = makeWorld()
    const items = [{ name: 'cobblestone', count: 60 }, { name: 'andesite', count: 64 }]
    const bot = mockBot(world, { items })
    const ctx = { castleCarry: { items: [{ name: 'andesite', count: 64 }] } }
    const st = { site: { ...SITE }, rot: 0, blueprintVersion: 3 }
    const stone = castle.castleBuilderCells(bot, ctx, st).cells.filter((c) => c.kind === 'stone')
    assert.ok(stone.length > 0 && stone.every((c) => c.block === 'cobblestone'), 'own cobble only')
  })

  it('names each cell from the held stacks, biggest first, capped at usable (cu1a)', () => {
    const world = makeWorld()
    const items = [{ slot: 9, name: 'andesite', count: 3 }, { slot: 20, name: 'cobblestone', count: 64 },
      { slot: 21, name: 'cobblestone', count: 64 }, { slot: 22, name: 'cobblestone', count: 72 }]
    const bot = mockBot(world, { items })
    const ctx = { castleCarry: null }
    const st = { site: { ...SITE }, rot: 0, blueprintVersion: 3 }
    const usable = castle.usable(bot, 'stone', ctx)
    assert.equal(usable, 203 - castle.reserveOf('stone'))
    const stone = castle.castleBuilderCells(bot, ctx, st).cells.filter((c) => c.kind === 'stone')
    const by = {}
    for (const c of stone) by[c.block] = (by[c.block] | 0) + 1
    assert.ok(stone.length <= usable, `batch ${stone.length} <= usable ${usable}`)
    assert.ok((by.andesite | 0) <= 3, `andesite at most its count: ${JSON.stringify(by)}`)
    assert.equal(stone[0].block, 'cobblestone', 'the biggest stack leads')
    assert.equal(by.cobblestone + (by.andesite | 0), stone.length, 'only held names')
  })

  it('two refused cells retire after 3 stalls (round-2 core-1, synq one-shot)', async () => {
    const world = makeWorld()
    const plan = blueprint.absPlan(SITE, 0, 3).cells
    const open = plan.filter((c) => c.kind === 'stone').slice(0, 2)
    paintAll(world, { except: (c) => open.includes(c) })
    const bot = mockBot(world, { buildScript: 'stall' })
    const ctx = { castle: { site: { ...SITE }, rot: 0, blueprintVersion: 3 } }
    await run(bot, ctx, 5)
    assert.ok(bot.calls.builds.length >= 3, `re-batches while unblocked (${bot.calls.builds.length})`)
    const keys = open.map((c) => `${blueprint.blueprintOf(3).version}:${c.idx}`)
    for (const k of keys) assert.ok(ctx.castle.blocked[k] && ctx.castle.blocked[k].retired, `${k} retired`)
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

describe('castle builder over the fake body (idkcraft-cu1a repro)', () => {
  it('a small first variant stack no longer starves the batch: the cobble lays, no failed:no-stone', async () => {
    const Vec3 = require('vec3')
    const { BaritoneBot } = require('../src/bridge/index')
    const { FakeTransport } = require('../src/bridge/transport')
    const site = { x: 100, y: 64, z: -40 }
    const transport = new FakeTransport({
      pos: { x: 100.5, y: 64, z: -39.5, yaw: 0, pitch: 0, onGround: true },
      blocks: {},
      fakeColumns: [{ cx: 6, cz: -3 }, { cx: 7, cz: -3 }, { cx: 6, cz: -2 }, { cx: 7, cz: -2 }],
      inventory: [{ slot: 9, name: 'andesite', count: 3 }, { slot: 20, name: 'cobblestone', count: 64 },
        { slot: 21, name: 'cobblestone', count: 64 }, { slot: 22, name: 'cobblestone', count: 64 }],
    })
    const bot = new BaritoneBot(transport, { Vec3, registry: require('minecraft-data')('26.1.2'), username: 'IdkBody' })
    await bot.start({ pollMs: 0 })
    try {
      bot._buildTiming = { stallMs: 200, watchMs: 5 }
      const st = { site: { ...site }, rot: 0, blueprintVersion: 3 }
      const ctx = { castle: st, castleCarry: null }
      const c = blueprint.absPlan(site, 0, 3).cells.find((x) => x.kind === 'stone' && !x.prep)
      assert.equal(castle.castleBuilderBatch(bot, ctx, st, c), true, 'batch fired')
      for (let i = 0; i < 400 && ctx.castleBuildFlight; i++) await new Promise((r) => setTimeout(r, 5))
      assert.equal(ctx.castleBuildFlight, false, 'flight settled')
      assert.ok(!(ctx.stepStatus || '').startsWith('failed:'), `no failure with stone on hand, got ${ctx.stepStatus}`)
      const laid = Object.values(transport.state.blocks).filter((n) => n === 'cobblestone').length
      assert.ok(laid > 3, `the cobble lays past the andesite (${laid})`)
    } finally {
      await bot.stop()
    }
  })
})

describe('castle builder bottom-up (idkcraft-synq)', () => {
  // Prod 2026-10-20: the same tower-top cells missed every pass while the
  // batch kept firing plan-ordered (dy14 stone idx~1039 ahead of dy2 walls
  // idx~1193 and dy8-11 planks floors idx~1460+). The tops have no stand
  // floor yet — possibly unheld, hence never in the same batch — the
  // layers skip, the watchdog stalls, the step fails, repeat.
  it('batches lowest-first so stand floors precede their tops', () => {
    const world = makeWorld()
    const bot = mockBot(world)
    const st = { site: { ...SITE }, rot: 0, blueprintVersion: 3 }
    const batch = castle.castleBuilderCells(bot, { castleCarry: null }, st)
    assert.ok(batch && batch.cells.length > 0, 'a batch is selected')
    const ys = batch.cells.map((c) => {
      const at = blueprint.absPlan(st.site, st.rot, 3).at.get(`${c.x},${c.y},${c.z}`)
      return at ? at.y : null
    })
    assert.ok(ys.every((y) => typeof y === 'number'), 'every batch cell is on the plan')
    assert.ok(ys.every((y, i) => i === 0 || y >= ys[i - 1]), 'non-decreasing y')
    // Every batched cell stands on a laid plan cell, natural ground, or a
    // cell batched before it — never on an unlaid plan cell outside the
    // batch.
    const plan = blueprint.absPlan(st.site, st.rot, 3)
    const inBatch = new Set(batch.cells.map((c) => `${c.x},${c.y},${c.z}`))
    for (const c of batch.cells) {
      const below = plan.at.get(`${c.x},${c.y - 1},${c.z}`)
      if (!below || !blueprint.isPlaceTarget(below.kind)) continue
      const n = world.blockAt(below).name
      assert.ok(blueprint.matches(below.kind, n) || inBatch.has(`${below.x},${below.y},${below.z}`),
        `batched ${c.x},${c.y},${c.z} stands on unlaid ${below.x},${below.y},${below.z}`)
    }
  })

  it('a top whose stand floor is unheld stays out: null batch, no wedge', async () => {
    const world = makeWorld()
    // Everything stands except one planks floor cell and the torch above
    // it — and the pack holds no planks, so the floor can never batch.
    // (Below-supports of builder cells are only ever stone/planks/frame;
    // torches on planks are the direct-above pair in the plan.)
    const plan = blueprint.absPlan(SITE, 0, 3).cells
    const floor = plan.find((c) => c.kind === 'planks' && !c.prep &&
      plan.some((d) => d.kind === 'torch' && d.x === c.x && d.y === c.y + 1 && d.z === c.z))
    assert.ok(floor, 'a planks floor with a torch above exists')
    const top = plan.find((d) => d.kind === 'torch' && d.x === floor.x && d.y === floor.y + 1 && d.z === floor.z)
    paintAll(world, { except: (c) => c === floor || c === top })
    const bot = mockBot(world, { items: [{ name: 'cobblestone', count: 500 }, { name: 'torch', count: 64 }] })
    const st = { site: { ...SITE }, rot: 0, blueprintVersion: 3 }
    const batch = castle.castleBuilderCells(bot, { castleCarry: null }, st)
    assert.equal(batch, null, 'the unfunded top never enters a schematic')
    // ...and the step names the missing floor (fetch word) instead of
    // stalling the builder on it.
    const ctx = { castle: { site: { ...SITE }, rot: 0, blueprintVersion: 3 } }
    for (let i = 0; i < 3; i++) {
      castle(bot, ctx)
      await settle()
    }
    assert.equal(bot.calls.builds.length, 0, 'no schematic fired at the gap')
    assert.ok((ctx.stepStatus || '').startsWith('failed:no-'), `fetch word, got ${ctx.stepStatus}`)
  })

  it('a refused floor-laid cell retires on its first block, still reported', async () => {
    const world = makeWorld()
    const plan = blueprint.absPlan(SITE, 0, 3).cells
    const open = plan.filter((c) => c.kind === 'stone').slice(0, 2)
    paintAll(world, { except: (c) => open.includes(c) })
    const bot = mockBot(world, { buildScript: 'stall' })
    const ver = blueprint.blueprintOf(3).version
    const ctx = { castle: { site: { ...SITE }, rot: 0, blueprintVersion: 3 } }
    const cap = capture()
    try {
      await run(bot, ctx, 4)
    } finally {
      cap.release()
    }
    for (const c of open) {
      const e = ctx.castle.blocked[`${ver}:${c.idx}`]
      assert.ok(e && e.retired, `${c.idx} retired: ${JSON.stringify(e)}`)
      assert.equal(e.tries, castle.BUILD_MISS_TRIES)
    }
    assert.ok(cap.logged.some((m) => m.includes('build-miss') && m.includes('retired')), 'retire line logged')
  })

  it('placed growth resets suspicion: stale strikes do not retire', async () => {
    const world = makeWorld()
    const plan = blueprint.absPlan(SITE, 0, 3).cells
    const open = plan.filter((c) => c.kind === 'stone').slice(0, 2)
    paintAll(world, { except: (c) => open.includes(c) })
    const bot = mockBot(world, { buildScript: 'partial' })
    bot.entity.position = { x: open[0].x + 2.5, y: open[0].y, z: open[0].z + 0.5 }
    const ver = blueprint.blueprintOf(3).version
    const ctx = { castle: { site: { ...SITE }, rot: 0, blueprintVersion: 3 } }
    // Two stale strikes behind each cell; the batch lays half its cells.
    ctx.castle.batchStrikes = Object.fromEntries(open.map((c) => [`${ver}:${c.idx}`, 2]))
    await run(bot, ctx, 1)
    for (const c of open) {
      assert.ok(!ctx.castle.blocked[`${ver}:${c.idx}`], `${c.idx} not blocked after a growing batch`)
    }
    const left = Object.values(ctx.castle.batchStrikes || {})
    assert.ok(left.every((n) => n <= 1), `strikes reset by growth: ${JSON.stringify(ctx.castle.batchStrikes)}`)
  })

  it('a stall after placement resets stale strikes: no retire on progress', async () => {
    const world = makeWorld()
    const plan = blueprint.absPlan(SITE, 0, 3).cells
    const open = plan.filter((c) => c.kind === 'stone').slice(0, 2)
    paintAll(world, { except: (c) => open.includes(c) })
    const bot = mockBot(world, { buildScript: 'stall-after-partial' })
    bot.entity.position = { x: open[0].x + 2.5, y: open[0].y, z: open[0].z + 0.5 }
    const ver = blueprint.blueprintOf(3).version
    const ctx = { castle: { site: { ...SITE }, rot: 0, blueprintVersion: 3 } }
    // Two stale strikes behind each cell; the batch lays one, then wedges.
    ctx.castle.batchStrikes = Object.fromEntries(open.map((c) => [`${ver}:${c.idx}`, 2]))
    await run(bot, ctx, 1)
    assert.equal(ctx.stepStatus, 'failed:build-stall', 'the stall still fails the step')
    for (const c of open) {
      assert.ok(!ctx.castle.blocked[`${ver}:${c.idx}`], `${c.idx} not blocked after a growing batch`)
    }
    const left = Object.values(ctx.castle.batchStrikes || {})
    assert.ok(left.length > 0 && left.every((n) => n <= 1), `strikes reset by growth: ${JSON.stringify(ctx.castle.batchStrikes)}`)
  })

  it('a batch-wide wedge rides the backoff ladder, never the one-shot', async () => {
    const world = makeWorld()
    // A whole lowest course refused at once: not cell-specific evidence.
    const plan = blueprint.absPlan(SITE, 0, 3).cells
    const open = plan.filter((c) => c.kind === 'stone' && c.dy === 0).slice(0, castle.STRIKE_WIDE_CAP + 4)
    assert.ok(open.length > castle.STRIKE_WIDE_CAP, 'wider than the cap')
    paintAll(world, { except: (c) => open.includes(c) })
    const bot = mockBot(world, { buildScript: 'stall' })
    bot.entity.position = { x: open[0].x + 2.5, y: open[0].y, z: open[0].z + 0.5 }
    const ver = blueprint.blueprintOf(3).version
    const ctx = { castle: { site: { ...SITE }, rot: 0, blueprintVersion: 3 } }
    await run(bot, ctx, 2)
    for (const c of open) {
      const e = ctx.castle.blocked[`${ver}:${c.idx}`]
      assert.ok(e && !e.retired && e.why === 'build-miss-wide', `${c.idx} backed off, not retired: ${JSON.stringify(e)}`)
    }
  })

  it('a top whose floor is still unlaid never strikes: no collateral retire', async () => {
    const world = makeWorld()
    // Two open cells: a low support and the stone directly above it. The
    // builder wedges on both every pass; only the support (floor laid)
    // may burn the one-shot build-miss ladder.
    const plan = blueprint.absPlan(SITE, 0, 3).cells
    const top = plan.find((c) => c.kind === 'stone' && !c.prep &&
      plan.some((d) => d.kind === 'stone' && !d.prep && d.x === c.x && d.y === c.y - 1 && d.z === c.z))
    assert.ok(top, 'a stone with a stone support exists')
    const support = plan.find((d) => d.kind === 'stone' && d.x === top.x && d.y === top.y - 1 && d.z === top.z)
    paintAll(world, { except: (c) => c === top || c === support })
    const bot = mockBot(world, { buildScript: 'stall' })
    // Park the body by the pair (like the stairs test): nearest-first must
    // keep picking the support, so the batch — not a far stair — fires.
    bot.entity.position = { x: support.x + 2.5, y: support.y, z: support.z + 0.5 }
    const ver = blueprint.blueprintOf(3).version
    const ctx = { castle: { site: { ...SITE }, rot: 0, blueprintVersion: 3 } }
    await run(bot, ctx, 5)
    const se = ctx.castle.blocked[`${ver}:${support.idx}`]
    assert.ok(se && se.retired, `support retired: ${JSON.stringify(se)}`)
    const te = ctx.castle.blocked[`${ver}:${top.idx}`]
    assert.ok(!te || !te.retired, `top never burns the ladder: ${JSON.stringify(te)}`)
    assert.deepEqual(ctx.castle.batchStrikes || {}, {}, 'no lingering strikes')
  })
})
