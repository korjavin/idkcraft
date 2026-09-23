'use strict'

// Bead rw4.4 acceptance (a)-(h): blueprint, site, adopt, cell stepping,
// material failure, skip-after-3, build-here refusal.

const { describe, it, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const { createTicker, handleChat } = require('../src/index')
const goal = require('../src/goal')
const build = require('../src/behaviours/build')
const { BLUEPRINT, PLANK_COUNT } = build

function pos(x, y, z) {
  return { x, y, z, distanceTo: (q) => Math.hypot(x - q.x, y - q.y, z - q.z) }
}

// Fake voxel world: explicit cells plus default terrain (dirt at y<=63,
// air above). placeBlock/dig mutate it, so a test can watch the house rise.
function makeWorld() {
  const cells = new Map()
  const key = (x, y, z) => `${Math.floor(x)},${Math.floor(y)},${Math.floor(z)}`
  return {
    set(x, y, z, name) { cells.set(key(x, y, z), name) },
    get(x, y, z) { return cells.get(key(x, y, z)) },
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

function mockBot(world, { items = [], spawn = pos(0, 64, 0), doors = [], failPlace = false } = {}) {
  const chats = []
  const calls = { goals: [], places: [], digs: [], equips: [] }
  const bot = {
    chats,
    calls,
    spawnPoint: spawn,
    entity: { position: pos(0, 65, 0) },
    world: { getBlock: () => null },
    players: {},
    held: null,
    inventory: { items: () => items },
    blockAt: (p) => world.blockAt(p),
    findBlocks: () => doors,
    pathfinder: {
      isMoving: () => false,
      setGoal: (g) => { calls.goals.push(g) },
    },
    equip: async (item, dest) => { calls.equips.push([item.name, dest]); bot.held = item.name },
    dig: async (b) => {
      calls.digs.push(b.name)
      world.set(b.position.x, b.position.y, b.position.z, 'air')
    },
    placeBlock: async (ref, face) => {
      calls.places.push([ref, face])
      if (failPlace) throw new Error('refused')
      const rp = (ref && ref.position) || ref // real placeBlock derefs ref.position
      world.set(rp.x + face.x, rp.y + face.y, rp.z + face.z, bot.held)
    },
    chat: (m) => { chats.push(String(m)) },
  }
  return bot
}

// Paint a whole correct house for `home` into the world (plan cells only;
// the server-side door upper half is set explicitly where needed).
function paintHouse(world, home) {
  for (const cell of BLUEPRINT) {
    const name = cell.kind === 'table' ? 'crafting_table' : cell.kind === 'door' ? 'oak_door' : 'oak_planks'
    world.set(home.site.x + cell.dx, home.site.y + cell.dy, home.site.z + cell.dz, name)
  }
}

const settle = async (n = 5) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)) }

describe('rw4.4 (a) build step announces itself', () => {
  it("MENU.build.chat is 'on my own: building the house' and decide picks it", () => {
    assert.equal(goal.MENU.build.chat(), 'on my own: building the house')
    const world = makeWorld()
    const bot = mockBot(world, {
      items: [
        { name: 'oak_planks', count: 56 },
        { name: 'crafting_table', count: 1 },
        { name: 'oak_door', count: 1 },
      ],
    })
    const ctx = { step: '', stepStatus: null, goalText: null, home: goal.siteFor(bot, pos(0, 64, 0)) }
    const r = goal.decide(bot, ctx)
    assert.equal(r.action, 'build')
    assert.deepEqual(bot.chats, ['on my own: building the house'])
  })
})

describe('rw4.4 (b) blueprint: table first, ring-door-ring-roof', () => {
  it('lays 40 cells: table, 22 wall planks, door, 16 roof planks', () => {
    assert.equal(BLUEPRINT.length, 40)
    assert.equal(PLANK_COUNT, 38)
    assert.deepEqual(BLUEPRINT[0], { dx: 4, dy: 0, dz: 1, kind: 'table' })
    const doorIdx = BLUEPRINT.findIndex((c) => c.kind === 'door')
    assert.deepEqual(BLUEPRINT[doorIdx], { dx: 1, dy: 0, dz: 0, kind: 'door' })
    const lower = BLUEPRINT.slice(1, doorIdx)
    assert.equal(lower.length, 11)
    assert.ok(lower.every((c) => c.kind === 'planks' && c.dy === 0))
    const upper = BLUEPRINT.slice(doorIdx + 1, doorIdx + 12)
    assert.equal(upper.length, 11)
    assert.ok(upper.every((c) => c.kind === 'planks' && c.dy === 1))
    const roof = BLUEPRINT.slice(doorIdx + 12)
    assert.equal(roof.length, 16)
    assert.ok(roof.every((c) => c.kind === 'planks' && c.dy === 2))
  })
})

describe('rw4.4 (c) site pick and facts none->site', () => {
  it('takes the first flat 4x4 at radius 6', () => {
    const world = makeWorld()
    const bot = mockBot(world)
    const home = goal.siteFor(bot, pos(0, 64, 0))
    assert.deepEqual(home.site, { x: 6, y: 64, z: 0 })
    assert.deepEqual(home.door, { x: 7, y: 64, z: 0 })
    assert.equal(home.table, null) // claimed only once the workbench stands (rw4.3 station contract)
    assert.equal(home.built, false)
    assert.equal(goal.goalFacts(bot, {}).home, 'none')
    assert.equal(goal.goalFacts(bot, { home }).home, 'site')
  })
})

describe('rw4.4 (d) adoptHome finds the earlier house', () => {
  it('adopts by door near spawn, origin = door-(1,0,0), built when full', () => {
    const world = makeWorld()
    const bot = mockBot(world, { doors: [{ x: 11, y: 64, z: 10 }] })
    const before = goal.siteFor(bot, pos(0, 64, 0))
    paintHouse(world, { site: { x: 10, y: 64, z: 10 } })
    const home = goal.adoptHome(bot)
    assert.deepEqual(home.site, { x: 10, y: 64, z: 10 })
    assert.equal(home.built, true)
    assert.deepEqual(bot.chats, ['my home is at 10 64 10'])
    assert.notDeepEqual(home.site, before.site)
  })
  it('steps down when findBlocks returns the door upper half', () => {
    const world = makeWorld()
    world.set(11, 64, 10, 'oak_door')
    const bot = mockBot(world, { doors: [{ x: 11, y: 65, z: 10 }] })
    paintHouse(world, { site: { x: 10, y: 64, z: 10 } })
    const home = goal.adoptHome(bot)
    assert.deepEqual(home.site, { x: 10, y: 64, z: 10 })
    assert.equal(home.built, true)
  })
  it('no door near spawn: null, silent', () => {
    const bot = mockBot(makeWorld(), { doors: [] })
    assert.equal(goal.adoptHome(bot), null)
    assert.deepEqual(bot.chats, [])
  })
})

describe('rw4.4 (e) step places the next cell, then completes', () => {
  it('walks to the cell, places, and finishes built=true with done', async () => {
    const world = makeWorld()
    const items = [
      { name: 'oak_planks', count: 40 },
      { name: 'crafting_table', count: 1 },
      { name: 'oak_door', count: 1 },
    ]
    const bot = mockBot(world, { items })
    const ctx = { home: goal.siteFor(bot, pos(0, 64, 0)), step: 'build', stepStatus: 'running', buildSkip: [], buildLastProgressLog: 0 }
    build(bot, ctx, null, null) // tick 1: progress chat + approach goal
    assert.ok(bot.chats.some((m) => m === 'building 0/40'))
    assert.equal(bot.calls.goals.length, 1)
    assert.equal(bot.calls.goals[0].constructor.name, 'GoalPlaceBlock')
    assert.equal(bot.calls.places.length, 0)
    build(bot, ctx, null, null) // tick 2: arrived (!isMoving) -> place flight
    await settle()
    assert.equal(bot.calls.places.length, 1)
    const [refBlock] = bot.calls.places[0]
    assert.ok(refBlock && refBlock.position, 'placeBlock gets a real block, not a Vec3')
    assert.equal(world.get(10, 64, 1), 'crafting_table') // table at (4,0,1)+origin
    assert.equal(ctx.placeInFlight, false)
    paintHouse(world, ctx.home) // the rest goes up (e.g. between restarts)
    build(bot, ctx, null, null) // tick 3: nothing left -> done
    assert.deepEqual(ctx.home.table, { x: 10, y: 64, z: 1 }) // table claimed on placement
    assert.equal(ctx.home.built, true)
    assert.equal(ctx.stepStatus, 'done')
    assert.ok(bot.chats.some((m) => m === 'home done at 6 64 0'))
  })
})

describe('rw4.4 (f) missing material fails without walking', () => {
  it('failed:no-planks, no goal, no place call', () => {
    const world = makeWorld()
    const bot = mockBot(world, { items: [] })
    const ctx = { home: goal.siteFor(bot, pos(0, 64, 0)), step: 'build', stepStatus: 'running', buildSkip: [], buildLastProgressLog: Date.now() }
    build(bot, ctx, null, null)
    assert.equal(ctx.stepStatus, 'failed:no-planks')
    assert.equal(bot.calls.goals.length, 0)
    assert.equal(bot.calls.places.length, 0)
  })
})

describe('rw4.4 (g) three refusals skip the cell with one log line', () => {
  let origLog
  let lines
  beforeEach(() => { origLog = console.log; lines = []; console.log = (l) => { lines.push(String(l)) } })
  afterEach(() => { console.log = origLog })

  it('skips after 3 refusals and moves on', async () => {
    const world = makeWorld()
    const bot = mockBot(world, { items: [{ name: 'oak_planks', count: 40 }], failPlace: true })
    const ctx = { home: goal.siteFor(bot, pos(0, 64, 0)), step: 'build', stepStatus: 'running', buildSkip: [], buildLastProgressLog: Date.now() }
    world.set(10, 64, 1, 'crafting_table') // table done: first target is a wall plank
    build(bot, ctx, null, null) // approach
    build(bot, ctx, null, null) // flight 1: 1 refusal
    await settle()
    build(bot, ctx, null, null) // flight 2: 2 refusals
    await settle()
    assert.deepEqual(ctx.buildSkip, [])
    build(bot, ctx, null, null) // flight 3: 3 refusals -> skip
    await settle()
    assert.equal(ctx.buildSkip.length, 1)
    const skips = lines.filter((l) => l.startsWith('build skip'))
    assert.equal(skips.length, 1)
    assert.ok(skips[0].includes('after 3 refusals'))
    const skippedIdx = ctx.buildSkip[0]
    build(bot, ctx, null, null) // next tick targets the following cell
    await settle()
    assert.equal(ctx.buildGoalIdx !== skippedIdx, true)
  })
})

describe('rw4.4 rest walks a plain-coords home site', () => {
  it('wraps the site in a Vec3 (GoalFollow.hasChanged needs floored)', () => {
    const rest = require('../src/behaviours/rest')
    const bot = mockBot(makeWorld()) // entity at (0,65,0): ~6 blocks out, takes the walk-back branch
    const home = goal.siteFor(bot, pos(0, 64, 0))
    assert.ok(typeof home.site.floored !== 'function') // the home shape stays plain coords
    rest(bot, { home, lastGoalKey: '' }, null, {})
    const g = bot.calls.goals[0]
    assert.equal(g.constructor.name, 'GoalFollow')
    const f = g.entity.position.floored() // live crash site: used to throw here
    assert.deepEqual({ x: f.x, y: f.y, z: f.z }, { x: 6, y: 64, z: 0 })
  })
})

describe('rw4.4 (h) build here on a built home refuses', () => {
  function chatBot() {
    const world = makeWorld()
    const bot = mockBot(world)
    bot.players = { Steve: { username: 'Steve', entity: { position: pos(100, 64, 100) } } }
    return bot
  }
  it("refuses with 'home already built at x y z' and keeps the home", () => {
    const bot = chatBot()
    const ticker = createTicker({ bot, brain: null, tickMs: 10, idleTickMs: 10 })
    const home = { site: { x: 6, y: 64, z: 0 }, built: true }
    ticker.setHome(home)
    bot.chats.length = 0
    handleChat(bot, ticker, 'Steve', 'build here')
    assert.deepEqual(bot.chats, ['home already built at 6 64 0'])
    assert.equal(ticker.home(), home)
  })
  it('sets a fresh site near the speaker otherwise', () => {
    const bot = chatBot()
    const ticker = createTicker({ bot, brain: null, tickMs: 10, idleTickMs: 10 })
    handleChat(bot, ticker, 'Steve', 'build here')
    assert.deepEqual(ticker.home().site, { x: 106, y: 64, z: 100 })
    assert.deepEqual(bot.chats, [])
  })
})
