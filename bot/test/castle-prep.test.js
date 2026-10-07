'use strict'

// idkcraft-g0z.5: the order-time site check (water/lava/foreign builds/uneven
// ground refused, mild grass accepted) and the castle-owned prep phase
// (chop trees, fill 1-deep dips, then hand over to the plan).

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const blueprint = require('../src/castle')
const castle = require('../src/behaviours/castle')
const { createTicker, handleChat } = require('../src/index')

const SITE = { x: 100, y: 64, z: 200 }
const EMPTY = new Set(['air', 'torch', 'wall_torch', 'rose_bush'])
const KIT = [{ name: 'cobblestone', count: 64 }, { name: 'oak_planks', count: 64 }, { name: 'oak_door', count: 1 }, { name: 'torch', count: 8 }]

// Ground is dirt up to y=63 (top block y=63 = site.y-1); `set` overrides.
function makeWorld() {
  const cells = new Map()
  const key = (x, y, z) => `${Math.floor(x)},${Math.floor(y)},${Math.floor(z)}`
  return {
    set(x, y, z, name) { cells.set(key(x, y, z), name) },
    get(x, y, z) { return this.blockAt({ x, y, z }).name },
    blockAt(p) {
      const [x, y, z] = [Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)]
      const k = key(x, y, z)
      const name = cells.has(k) ? cells.get(k) : (y <= 63 ? 'dirt' : 'air')
      return { name, boundingBox: EMPTY.has(name) ? 'empty' : 'block', position: { x, y, z } }
    },
  }
}

function mockBot(world) {
  const calls = { places: [], digs: [] }
  const bot = {
    calls,
    chats: [],
    entity: { position: { x: SITE.x - 3, y: 64, z: SITE.z - 3 } },
    world: { getBlock: () => null },
    players: {},
    held: null,
    inventory: { items: () => KIT },
    blockAt: (p) => world.blockAt(p),
    pathfinder: {
      movements: { exclusionAreasBreak: [], exclusionAreasPlace: [] },
      isMoving: () => false,
      setGoal: (g) => {
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
  return bot
}

const settle = async (n = 4) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)) }
async function run(bot, ctx, ticks) {
  for (let i = 0; i < ticks; i++) { castle(bot, ctx); await settle() }
}

describe('g0z.5 site check', () => {
  const check = (mutate) => {
    const w = makeWorld()
    if (mutate) mutate(w)
    return castle.siteCheck(mockBot(w), SITE, 0)
  }
  it('accepts mildly uneven grass: a 1-deep dip, a 1-high bump, flora, a tree', () => {
    assert.equal(check(), null)
    assert.equal(check((w) => { w.set(103, 63, 203, 'air') }), null)
    assert.equal(check((w) => { w.set(104, 64, 204, 'grass_block') }), null)
    assert.equal(check((w) => { w.set(101, 64, 201, 'short_grass') }), null)
    assert.equal(check((w) => { w.set(101, 64, 201, 'rose_bush'); w.set(101, 65, 201, 'rose_bush') }), null, 'double-tall flora is not ground')
    assert.equal(check((w) => { for (let y = 64; y < 68; y++) w.set(102, y, 202, 'oak_log'); w.set(102, 68, 202, 'oak_leaves') }), null)
  })
  it('refuses water and lava in the footprint', () => {
    assert.match(check((w) => { w.set(105, 63, 205, 'water') }), /water at 105/)
    assert.match(check((w) => { w.set(105, 64, 205, 'lava') }), /lava at 105/)
  })
  it('refuses built blocks that are not ours', () => {
    assert.match(check((w) => { w.set(101, 64, 201, 'oak_planks') }), /somebody built there/)
    assert.match(check((w) => { w.set(106, 65, 206, 'white_bed') }), /somebody built there/)
  })
  it('g0z.16: accepts a 2-deep hole and a 2-high step (prep levels them)', () => {
    assert.equal(check((w) => { w.set(103, 63, 203, 'air'); w.set(103, 62, 203, 'air') }), null)
    assert.equal(check((w) => { w.set(104, 64, 204, 'dirt'); w.set(104, 65, 204, 'stone') }), null)
  })
  it('g0z.20: the core levels ±4 and refuses past it with the spot count and the worst offset', () => {
    // (103, 203) / (105, 205): v1 tower columns (core).
    assert.equal(check((w) => { for (let y = 60; y <= 63; y++) w.set(103, y, 203, 'air') }), null, '4 deep')
    assert.equal(check((w) => { for (let y = 59; y <= 63; y++) w.set(103, y, 203, 'air') }),
      'the ground is too uneven: 1 spots are more than 4 blocks off level, worst 5 down at 103 203 (I level up to 4 under the castle)')
    const r = check((w) => { for (let y = 64; y <= 69; y++) w.set(105, y, 205, 'stone') })
    assert.match(r, /too uneven: 1 spots are more than 4 blocks off level, worst 6 up at 105 205/)
    assert.match(check((w) => { for (let y = 50; y <= 63; y++) w.set(103, y, 203, 'air') }), /worst 9\+ down at 103 203/)
  })
})

describe('g0z.20 site level, ring and earthwork budget (v2 31x27)', () => {
  const v2 = (mutate, site = SITE) => { const w = makeWorld(); if (mutate) mutate(w); return castle.siteEval(mockBot(w), site, 0, 2) }
  const HALL = { x: SITE.x + 15, z: SITE.z + 10 } // a hall column: core
  const CORNER = { x: SITE.x + 30, z: SITE.z + 26 } // the fence ring's far corner

  it('(a) a flat clearing passes with the speaker on a 2-high bump: the level is the ground median', () => {
    const r = v2(null, { ...SITE, y: 66 }) // feet on the bump
    assert.deepEqual(r, { y: 64, bad: null })
  })

  it('(b) a 1x1 puddle in the fence ring passes and prep fills it', async () => {
    const w = makeWorld()
    w.set(CORNER.x, 63, CORNER.z, 'water')
    const bot = mockBot(w)
    assert.deepEqual(castle.siteEval(bot, SITE, 0, 2), { y: 64, bad: null })
    const ctx = { castle: { site: SITE, rot: 0, blueprintVersion: 2, phase: 'prep', blocked: {} } }
    assert.equal(castle.menuFact(bot, ctx), 'clear', 'the fill works now (stone on hand)')
    await run(bot, ctx, 20)
    assert.equal(w.get(CORNER.x, 63, CORNER.z), 'cobblestone')
    assert.ok(bot.chats.some((m) => /0 blocks to cut, 1 holes to fill/.test(m)), bot.chats.join('|'))
    assert.equal(ctx.castle.phase, 'body')
  })

  it('(b) water in a moat column is filled too (the moat digs it out later); 7 wet ring spots refuse', async () => {
    const plan = blueprint.absPlan(SITE, 0, 2)
    const m = plan.cells.find((c) => c.kind === 'dig' && c.dy === -1)
    const w = makeWorld()
    w.set(m.x, 63, m.z, 'water'); w.set(m.x, 62, m.z, 'water')
    const bot = mockBot(w)
    assert.equal(castle.siteEval(bot, SITE, 0, 2).bad, null)
    const ctx = { castle: { site: SITE, rot: 0, blueprintVersion: 2, phase: 'prep', blocked: {} } }
    await run(bot, ctx, 20)
    assert.ok(bot.chats.some((x) => /0 blocks to cut, 2 holes to fill/.test(x)), bot.chats.join('|'))
    assert.equal(w.get(m.x, 62, m.z), 'cobblestone', 'the dy -2 moat cell filled')
    assert.equal(w.get(m.x, 63, m.z), 'cobblestone', 'the dy -1 moat cell filled')
    const r = v2((w) => { for (let x = 0; x < 7; x++) w.set(SITE.x + x, 63, SITE.z, 'water') })
    assert.match(r.bad, /there is water in 7 spots around it, first at 100 63 200 \(I fill up to 6\)/)
  })

  it('(c) a slope past the earthwork budget refuses with the number', () => {
    // Five front rows (the fence, moat and bridge side: all ring) 5 up.
    const r = v2((w) => { for (let x = 0; x < 31; x++) for (let z = 0; z < 5; z++) for (let y = 64; y < 69; y++) w.set(SITE.x + x, y, SITE.z + z, 'dirt') })
    assert.equal(r.why, 'uneven')
    assert.match(r.bad, /too uneven: levelling it moves 775 blocks, worst 5 up at \d+ \d+ \(I move up to 400\)/)
    // The same rows 2 up stay in budget (310).
    assert.equal(v2((w) => { for (let x = 0; x < 31; x++) for (let z = 0; z < 5; z++) for (let y = 64; y < 66; y++) w.set(SITE.x + x, y, SITE.z + z, 'dirt') }).bad, null)
  })

  it('(d) water in the core refuses', () => {
    const r = v2((w) => { w.set(HALL.x, 63, HALL.z, 'water') })
    assert.equal(r.bad, `there is water at ${HALL.x} 63 ${HALL.z}`)
    assert.equal(r.why, 'water')
  })
  it('an unloaded column is never a refusal', () => {
    const w = makeWorld()
    const bot = mockBot(w)
    bot.blockAt = () => null
    assert.equal(castle.siteCheck(bot, SITE, 0), null)
  })
})

describe('g0z.5 prep phase', () => {
  const dipCell = () => blueprint.absPlan(SITE, 0).cells.find((c) => c.dy === 0 && c.kind === 'stone')

  it('chops the tree, fills the dip, announces, then hands over to the plan', async () => {
    const world = makeWorld()
    const bot = mockBot(world)
    const d = dipCell()
    world.set(d.x, 63, d.z, 'air') // 1-deep dip under a ground wall cell
    // A tree trunk standing on a floor column of the footprint.
    const tx = SITE.x + 5
    const tz = SITE.z + 5
    for (let y = 64; y < 68; y++) world.set(tx, y, tz, 'oak_log')
    world.set(tx, 68, tz, 'oak_leaves')
    const ctx = { castle: { site: SITE, rot: 0, phase: 'prep', blocked: {} } }
    assert.equal(castle.menuFact(bot, ctx), 'clear', 'logs first, no material')
    await run(bot, ctx, 40)
    for (let y = 64; y < 68; y++) assert.equal(world.get(tx, y, tz), 'air', `log at ${y} chopped`)
    assert.equal(world.get(d.x, 63, d.z), 'cobblestone', 'dip filled')
    assert.equal(ctx.castle.phase, 'body')
    assert.ok(bot.chats.some((m) => /preparing the castle site: 4 logs to chop, 0 blocks to cut, 1 holes to fill/.test(m)), bot.chats.join('|'))
    assert.ok(bot.chats.includes('castle site ready, starting to build'))
    // The same ticks went on to lay the plan.
    const first = blueprint.absPlan(SITE, 0).cells.find((c) => c.dy === 0 && c.kind === 'stone')
    assert.equal(world.get(first.x, first.y, first.z), 'cobblestone')
  })

  it('a clean site skips prep silently', async () => {
    const world = makeWorld()
    const bot = mockBot(world)
    const ctx = { castle: { site: SITE, rot: 0, phase: 'prep', blocked: {} } }
    assert.equal(castle.menuFact(bot, ctx), 'stone-batch', 'the body word, never finish at 0/N (g0z.15)')
    await run(bot, ctx, 2)
    assert.equal(ctx.castle.phase, 'body')
    assert.deepEqual(bot.chats, [])
  })

  it('an unloaded site column keeps prep open (g0z.15): never skipped for good', async () => {
    const world = makeWorld()
    const bot = mockBot(world)
    const blockAt = bot.blockAt
    let unloaded = true
    bot.blockAt = (p) => (unloaded && Math.floor(p.x) === SITE.x + 9 ? null : blockAt(p))
    const ctx = { castle: { site: SITE, rot: 0, phase: 'prep', blocked: {} } }
    await run(bot, ctx, 2)
    assert.equal(ctx.castle.phase, 'prep')
    unloaded = false
    await run(bot, ctx, 1)
    assert.equal(ctx.castle.phase, 'body')
  })

  it('a dip with no stone to fill reads a stone word and fails no-stone', async () => {
    const world = makeWorld()
    const bot = mockBot(world)
    bot.inventory = { items: () => [] }
    const d = dipCell()
    world.set(d.x, 63, d.z, 'air')
    const ctx = { castle: { site: SITE, rot: 0, phase: 'prep', blocked: {} } }
    assert.equal(castle.menuFact(bot, ctx), 'stone-none')
    await run(bot, ctx, 2)
    assert.equal(ctx.stepStatus, 'failed:no-stone')
    assert.equal(ctx.castle.phase, 'prep')
  })

  it('a hung prep flight strikes its own cell (not the plan cell of the same index)', async () => {
    const world = makeWorld()
    const bot = mockBot(world)
    world.set(SITE.x + 5, 64, SITE.z + 5, 'oak_log')
    world.set(SITE.x + 5, 65, SITE.z + 5, 'oak_log')
    world.set(SITE.x + 5, 66, SITE.z + 5, 'oak_leaves') // a tree, so the dig is allowed
    bot.dig = () => new Promise(() => {})
    const ctx = { castle: { site: SITE, rot: 0, phase: 'prep', blocked: {} } }
    await run(bot, ctx, 4)
    const idx = ctx.castleFlight.cell.idx
    for (let i = 0; i < castle.STRIKES; i++) {
      ctx.castleFlight.since = 0
      await run(bot, ctx, 1)
    }
    assert.ok(ctx.castle.blocked[`${1}:${idx}`], 'prep cell blocked')
  })

  it('a log that refuses blocks and prep moves on to the body', async () => {
    const world = makeWorld()
    const bot = mockBot(world)
    const tx = SITE.x + 5
    const tz = SITE.z + 5
    world.set(tx, 64, tz, 'oak_log')
    bot.dig = async () => { throw new Error('refused') }
    const ctx = { castle: { site: SITE, rot: 0, phase: 'prep', blocked: {} } }
    await run(bot, ctx, 30)
    assert.equal(ctx.castle.phase, 'body')
  })
})

describe('g0z.5 order refusal', () => {
  it('build castle over water says why and starts a search instead (g0z.19)', () => {
    const w = makeWorld()
    const bot = mockBot(w)
    const p = { x: SITE.x + 5.5, y: 64, z: SITE.z - 1.5 }
    p.distanceTo = (q) => Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z)
    bot.username = 'IdkBot'
    bot.players = { Steve: { username: 'Steve', entity: { position: p, yaw: Math.PI } } }
    bot.time = { timeOfDay: 6000, day: 1 }
    bot.spawnPoint = p
    bot.pathfinder = { ...bot.pathfinder, stop() {}, goal: null, setMovements() {} }
    bot.clearControlStates = () => {}
    bot.on = () => {}
    bot.once = () => {}
    const { castleSite } = require('../src/chat')
    const { site } = castleSite(p, Math.PI)
    w.set(site.x + 15, site.y - 1, site.z + 10, 'water') // a hall column (core)
    const ticker = createTicker({ bot, brain: null, tickMs: 10, idleTickMs: 10 })
    handleChat(bot, ticker, 'Steve', 'build castle')
    assert.equal(bot._tickerCtx.castle, undefined)
    assert.match(bot.chats.pop(), /^not right here \(there is water at .*\) — looking for a castle spot within 48 blocks/)
    assert.equal(bot._tickerCtx.pendingSearch.kind, 'castle')
  })
})

describe('g0z.16 levelling prep (±2)', () => {
  const ctxOf = (version) => ({ castle: { site: SITE, rot: 0, blueprintVersion: version, phase: 'prep', blocked: {} } })

  it('cuts a 2-high bump, keeps a matching natural block, fills a 2-deep hole, then builds', async () => {
    const world = makeWorld()
    const bot = mockBot(world)
    const wall = blueprint.absPlan(SITE, 0).cells.find((c) => c.dy === 0 && c.kind === 'stone')
    const bx = SITE.x + 1
    const bz = SITE.z + 1
    assert.ok(!blueprint.absPlan(SITE, 0).at.has(`${bx},64,${bz}`), 'bump off the plan')
    world.set(bx, 64, bz, 'dirt'); world.set(bx, 65, bz, 'grass_block') // 2-high bump
    world.set(wall.x, 64, wall.z, 'stone'); world.set(wall.x, 65, wall.z, 'dirt') // natural stone in a wall cell
    const hx = SITE.x + 8
    const hz = SITE.z + 2
    world.set(hx, 63, hz, 'air'); world.set(hx, 62, hz, 'air') // 2-deep hole
    assert.equal(castle.siteCheck(bot, SITE, 0), null)
    const ctx = ctxOf(1)
    await run(bot, ctx, 80)
    assert.equal(world.get(bx, 64, bz), 'air')
    assert.equal(world.get(bx, 65, bz), 'air')
    assert.equal(world.get(wall.x, 64, wall.z), 'stone', 'a block that matches its plan cell stays')
    assert.equal(world.get(hx, 62, hz), 'cobblestone')
    assert.equal(world.get(hx, 63, hz), 'cobblestone')
    assert.equal(ctx.castle.phase, 'body')
    assert.ok(bot.chats.some((m) => /preparing the castle site: 0 logs to chop, 3 blocks to cut, 2 holes to fill/.test(m)), bot.chats.join('|'))
    const laid = blueprint.absPlan(SITE, 0).cells.filter((c) => blueprint.isPlaceTarget(c.kind) && c.dy === 0 && world.get(c.x, c.y, c.z) === 'cobblestone')
    assert.ok(laid.length > 0, 'the body started')
  })

  it('a 1-deep dip and a 1-high bump level too; fills take dirt when no stone is spare', async () => {
    const world = makeWorld()
    const bot = mockBot(world)
    // Above the night-shelter floor (vmzq.31): 9 dirt spends one, then holds.
    bot.inventory = { items: () => [{ name: 'dirt', count: 9 }] }
    world.set(SITE.x + 3, 63, SITE.z + 6, 'air')
    world.set(SITE.x + 9, 64, SITE.z + 3, 'dirt')
    const ctx = ctxOf(1)
    assert.equal(castle.menuFact(bot, ctx), 'clear', 'the cut first')
    await run(bot, ctx, 4)
    assert.equal(world.get(SITE.x + 9, 64, SITE.z + 3), 'air')
    assert.equal(castle.menuFact(bot, ctx), 'clear', 'a fill with only dirt on hand works now (not stone-none)')
    await run(bot, ctx, 36)
    assert.equal(world.get(SITE.x + 3, 63, SITE.z + 6), 'dirt')
    assert.equal(ctx.castle.phase, 'body')
  })

  it('v2: a hole in a moat column is the plan\'s (never filled), one beside it is', async () => {
    const world = makeWorld()
    const bot = mockBot(world)
    const plan = blueprint.absPlan(SITE, 0, 2)
    const m = plan.cells.find((c) => c.kind === 'dig' && c.dy === -1 && plan.at.has(`${c.x},${c.y - 1},${c.z}`))
    world.set(m.x, 63, m.z, 'air'); world.set(m.x, 62, m.z, 'air')
    const hx = SITE.x + 15
    const hz = SITE.z + 13
    assert.ok(!plan.at.has(`${hx},63,${hz}`))
    world.set(hx, 63, hz, 'air'); world.set(hx, 62, hz, 'air')
    assert.equal(castle.siteCheck(bot, SITE, 0, 2), null)
    const ctx = ctxOf(2)
    await run(bot, ctx, 40)
    assert.equal(world.get(hx, 62, hz), 'cobblestone')
    assert.equal(world.get(hx, 63, hz), 'cobblestone')
    assert.equal(ctx.castle.phase, 'body')
    assert.equal(world.get(m.x, 63, m.z), 'air', 'moat cell left to the plan')
    assert.equal(world.get(m.x, 62, m.z), 'air')
  })
})
