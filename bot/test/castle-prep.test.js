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
  it('refuses a 2-deep hole and a 2-high step', () => {
    assert.match(check((w) => { w.set(103, 63, 203, 'air'); w.set(103, 62, 203, 'air') }), /too uneven/)
    assert.match(check((w) => { w.set(104, 64, 204, 'dirt'); w.set(104, 65, 204, 'dirt') }), /too uneven/)
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
    assert.ok(bot.chats.some((m) => /preparing the castle site: 4 logs to chop, 1 dips to fill/.test(m)), bot.chats.join('|'))
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
  it('build castle over water refuses with a reason and sets nothing', () => {
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
    w.set(site.x + 6, site.y - 1, site.z + 6, 'water')
    const ticker = createTicker({ bot, brain: null, tickMs: 10, idleTickMs: 10 })
    handleChat(bot, ticker, 'Steve', 'build castle')
    assert.equal(bot._tickerCtx.castle, undefined)
    assert.match(bot.chats.pop(), /can't build a castle here: there is water at .*flatter/)
  })
})
