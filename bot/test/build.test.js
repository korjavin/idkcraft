'use strict'

// Bead rw4.4 acceptance (a)-(h): blueprint, site, adopt, cell stepping,
// material failure, skip-after-3, build-here. rpw: build here always
// starts a new house, even over a built home.

const { describe, it, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const { createTicker, handleChat } = require('../src/index')
const goal = require('../src/goal')
const build = require('../src/behaviours/build')
const { BLUEPRINT, PLANK_COUNT } = build

function pos(x, y, z) {
  const p = { x, y, z, distanceTo: (q) => Math.hypot(x - q.x, y - q.y, z - q.z) }
  p.clone = () => pos(p.x, p.y, p.z)
  p.floored = () => pos(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z))
  return p
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

// Mirror of Movements.safeToBreak's break veto (cjq): session-global ids
// plus the position-scoped exclusion closures the narrowed guard installs.
function breakVetoed(mov, name, id, x, y, z) {
  if (id != null && mov && mov.blocksCantBreak && mov.blocksCantBreak.has(id)) return true
  if (mov && Array.isArray(mov.exclusionAreasBreak)) {
    const block = { type: id, name, position: { x, y, z } }
    for (const f of mov.exclusionAreasBreak) {
      try { if (f(block) >= 100) return true } catch (_) { /* veto best-effort */ }
    }
  }
  return false
}

describe('rw4.4 (a) build step announces itself', () => {
  it("MENU.build announces 'building the house' and decide picks it", async () => {
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
    const r = await goal.decide(bot, ctx)
    assert.equal(r.action, 'build')
    assert.deepEqual(bot.chats, ['next: building the house (goal-fsm)'])
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
  it('rejects an uneven first candidate for the second direction', () => {
    const world = makeWorld()
    // raise one column of the first candidate (6,0)+ by 2: outside the
    // one-block tolerance, so the site moves to the second direction (4,4)
    world.set(6, 64, 0, 'dirt')
    world.set(6, 65, 0, 'dirt')
    const bot = mockBot(world)
    const home = goal.siteFor(bot, pos(0, 64, 0))
    assert.deepEqual(home.site, { x: 4, y: 64, z: 4 })
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
  it('work waits for spawn chunks, then adopts once', async () => {
    const world = makeWorld()
    const doors = [{ x: 11, y: 64, z: 10 }]
    const bot = mockBot(world, { doors })
    paintHouse(world, { site: { x: 10, y: 64, z: 10 } })
    let chunks = false // spawn handler raced empty chunks
    const seen = bot.blockAt
    bot.blockAt = (p) => (chunks ? seen(p) : null)
    bot.players = { Steve: { username: 'Steve', entity: { position: pos(10, 64, 0) } } }
    bot.health = 20
    bot.food = 20
    bot.entities = {}
    const stubBrain = { decide: async () => ({ action: 'idle', sprint: false, source: 'stub' }) }
    const ticker = createTicker({ bot, brain: stubBrain, tickMs: 10, idleTickMs: 10 })
    try {
      ticker.work()
      await ticker.tick()
      assert.equal(ticker.home(), null) // chunks missing: work held, no default
      chunks = true // chunks arrive
      await ticker.tick()
      assert.deepEqual(ticker.home().site, { x: 10, y: 64, z: 10 })
      assert.ok(bot.chats.some((m) => m === 'my home is at 10 64 10'))
    } finally {
      ticker.destroy()
    }
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
    bot.entity.position = pos(10, 64, 2) // next to the table cell (placements are in-reach only)
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
    assert.deepEqual({ x: ctx.home.table.x, y: ctx.home.table.y, z: ctx.home.table.z }, { x: 10, y: 64, z: 1 }) // table claimed on placement
    assert.equal(ctx.home.built, true)
    assert.equal(ctx.stepStatus, 'done')
    assert.ok(bot.chats.some((m) => m === 'home done at 6 64 0'))
  })
})

describe('rw4.4 out-of-reach re-approaches instead of refusing', () => {
  it('no place call, goal reset for a fresh approach', () => {
    const world = makeWorld()
    const bot = mockBot(world, { items: [{ name: 'crafting_table', count: 1 }] })
    // entity stays at spawn (0,65,0): ~11 blocks from the table cell
    const ctx = { home: goal.siteFor(bot, pos(0, 64, 0)), step: 'build', stepStatus: 'running', buildSkip: [], buildLastProgressLog: Date.now() }
    build(bot, ctx, null, null) // approach goal
    build(bot, ctx, null, null) // arrived? no — still 11 out: re-approach, no attempt
    assert.equal(bot.calls.places.length, 0)
    assert.equal(ctx.buildGoalIdx, -1)
    assert.equal(ctx.stepStatus, 'running')
    assert.deepEqual(ctx.buildSkip, [])
  })
})

describe('rw4.4 roof above the door avoids the door reference', () => {
  it('places against the side roof neighbour (doors toggle on right-click)', async () => {
    const world = makeWorld()
    const bot = mockBot(world, { items: [{ name: 'oak_planks', count: 40 }] })
    bot.entity.position = pos(7, 67, 1) // next to the cell
    const ctx = { home: goal.siteFor(bot, pos(0, 64, 0)), step: 'build', stepStatus: 'running', buildSkip: [], buildLastProgressLog: Date.now() }
    paintHouse(world, ctx.home)
    world.set(7, 66, 0, 'air') // only the roof-above-door cell is missing
    world.set(7, 65, 0, 'oak_door') // the placed door upper half (server-side)
    build(bot, ctx, null, null) // approach
    build(bot, ctx, null, null) // place
    await settle()
    assert.equal(bot.calls.places.length, 1)
    const [refBlock] = bot.calls.places[0]
    assert.deepEqual(
      { x: refBlock.position.x, y: refBlock.position.y, z: refBlock.position.z },
      { x: 8, y: 66, z: 0 }, // east roof neighbour, not the door below
    )
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
    bot.entity.position = pos(6, 64, 1) // next to the first ring cell (placements are in-reach only)
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

describe('rw4.4 one flight at a time, dig-retry on weeds', () => {
  it('a second tick while placing starts no second flight', async () => {
    const world = makeWorld()
    const bot = mockBot(world, { items: [{ name: 'crafting_table', count: 1 }] })
    bot.entity.position = pos(10, 64, 2)
    let release = null
    const gate = new Promise((res) => { release = res })
    bot.placeBlock = async (ref, face) => {
      bot.calls.places.push([ref, face])
      await gate // hangs: the flight never settles
    }
    const ctx = { home: goal.siteFor(bot, pos(0, 64, 0)), step: 'build', stepStatus: 'running', buildSkip: [], buildLastProgressLog: Date.now() }
    build(bot, ctx, null, null) // approach
    build(bot, ctx, null, null) // flight starts, hangs
    build(bot, ctx, null, null) // must not start another
    await settle(2)
    assert.equal(bot.calls.places.length, 1)
    assert.equal(ctx.placeInFlight, true)
    release()
  })
  it('grass in the cell is dug once, then the retry lands', async () => {
    const world = makeWorld()
    world.set(6, 64, 0, 'short_grass') // first lower-ring cell overgrown
    let attempts = 0
    const bot = mockBot(world, { items: [{ name: 'oak_planks', count: 40 }] })
    bot.entity.position = pos(6, 64, 1)
    const planted = []
    bot.placeBlock = async (ref, face) => {
      bot.calls.places.push([ref, face])
      attempts++
      if (attempts === 1) throw new Error('refused')
      const rp = (ref && ref.position) || ref
      world.set(rp.x + face.x, rp.y + face.y, rp.z + face.z, bot.held)
      planted.push(world.get(6, 64, 0))
    }
    const ctx = { home: goal.siteFor(bot, pos(0, 64, 0)), step: 'build', stepStatus: 'running', buildSkip: [], buildLastProgressLog: Date.now() }
    world.set(10, 64, 1, 'crafting_table') // table already stands: the ring cell is next
    build(bot, ctx, null, null) // approach
    build(bot, ctx, null, null) // refuse -> dig -> retry lands
    await settle()
    assert.deepEqual(bot.calls.digs, ['short_grass'])
    assert.deepEqual(planted, ['oak_planks'])
    assert.equal(ctx.buildFails, 0)
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

describe('rw4.4 no solid neighbour skips instead of looping', () => {
  let origLog
  let lines
  beforeEach(() => { origLog = console.log; lines = []; console.log = (l) => { lines.push(String(l)) } })
  afterEach(() => { console.log = origLog })

  it('three no-ref ticks skip the cell with one log line', () => {
    const world = makeWorld()
    // air pocket around the table cell: below, sides and top are all air
    for (const [x, y, z] of [[10, 63, 1], [9, 64, 1], [11, 64, 1], [10, 64, 0], [10, 64, 2], [10, 65, 1]]) {
      world.set(x, y, z, 'air')
    }
    const bot = mockBot(world, { items: [{ name: 'crafting_table', count: 1 }] })
    bot.entity.position = pos(10, 64, 2) // next to the cell (in reach, but nothing to build against)
    const ctx = { home: goal.siteFor(bot, pos(0, 64, 0)), step: 'build', stepStatus: 'running', buildSkip: [], buildLastProgressLog: Date.now() }
    for (let i = 0; i < 8; i++) build(bot, ctx, null, null)
    assert.equal(ctx.buildSkip.length, 1)
    const norefs = lines.filter((l) => l.startsWith('build skip') && l.includes('no-ref'))
    assert.equal(norefs.length, 1)
  })
})

describe('rpw build here on a built home starts a new house', () => {
  function chatBot() {
    const world = makeWorld()
    const bot = mockBot(world, {
      items: [
        { name: 'oak_planks', count: 56 },
        { name: 'crafting_table', count: 1 },
        { name: 'oak_door', count: 1 },
      ],
    })
    bot.players = { Steve: { username: 'Steve', entity: { position: pos(100, 64, 100) } } }
    return bot
  }
  it('replaces a built home with a fresh site and goal picks build', async () => {
    const bot = chatBot()
    const ticker = createTicker({ bot, brain: null, tickMs: 10, idleTickMs: 10 })
    const home = { site: { x: 6, y: 64, z: 0 }, built: true }
    ticker.setHome(home)
    bot.chats.length = 0
    handleChat(bot, ticker, 'Steve', 'build here')
    assert.deepEqual(bot.chats, [])
    const next = ticker.home()
    assert.deepEqual(next.site, { x: 106, y: 64, z: 100 })
    assert.ok(!next.built, 'a fresh site is not built')
    const r = await goal.decide(bot, { step: '', stepStatus: null, goalText: null, home: next })
    assert.equal(r.action, 'build')
  })
  it('sets a fresh site near the speaker otherwise', () => {
    const bot = chatBot()
    const ticker = createTicker({ bot, brain: null, tickMs: 10, idleTickMs: 10 })
    handleChat(bot, ticker, 'Steve', 'build here')
    assert.deepEqual(ticker.home().site, { x: 106, y: 64, z: 100 })
    assert.deepEqual(bot.chats, [])
  })
})

describe('8si the approach must not eat the door or the workbench', () => {
  const REG = {
    oak_planks: { id: 5 },
    oak_log: { id: 17 },
    dirt: { id: 3 },
    oak_door: { id: 64 },
    crafting_table: { id: 998 },
  }

  // Hostile executor: the real one digs anything breakable on the segment
  // (cww's harness exempted doors/tables — live the door got eaten).
  // Guarded ids route around.
  function hostileSetGoal(bot, world, transit) {
    return (g) => {
      bot.calls.goals.push(g)
      if (!g || g.constructor.name !== 'GoalPlaceBlock' || !g.pos) return
      const mov = bot.pathfinder.movements
      const bp = bot.entity.position
      const solidAt = (x, y, z) => {
        const name = world.get(x, y, z) ?? (y <= 63 ? 'dirt' : 'air')
        return name !== 'air' ? name : null
      }
      for (let t = 0.05; t < 1; t += 0.05) {
        const x = Math.floor(bp.x + (g.pos.x - bp.x) * t)
        const z = Math.floor(bp.z + (g.pos.z - bp.z) * t)
        for (const y of [Math.floor(bp.y), Math.floor(bp.y) + 1]) {
          const name = solidAt(x, y, z)
          if (!name) continue
          const id = REG[name] != null ? REG[name].id : null
          if (breakVetoed(mov, name, id, x, y, z)) continue // routes around
          world.set(x, y, z, 'air')
          bot.calls.digs.push(name)
          bot._moving = true
          transit.n = 1
          return
        }
      }
      // Arrived: the mock body overshoots two east (inside the build
      // 5-block reach), so later segments cross the standing house — past
      // the table cell and the door, which a static bot never threatens.
      bot.entity.position = pos(Math.floor(g.pos.x) + 2, g.pos.y, Math.floor(g.pos.z))
      bot._moving = true
      transit.n = 1
    }
  }

  function driveHouse() {
    const world = makeWorld()
    const bot = mockBot(world, {
      items: [
        { name: 'oak_planks', count: 40 },
        { name: 'crafting_table', count: 1 },
        { name: 'oak_door', count: 1 },
      ],
    })
    bot.registry = { blocksByName: REG }
    bot.pathfinder.movements = { blocksCantBreak: new Set(), exclusionAreasBreak: [] }
    const home = goal.siteFor(bot, pos(0, 64, 0))
    bot.entity.position = pos(home.site.x + 4, home.site.y, home.site.z + 1)
    const transit = { n: 0 }
    bot._moving = false
    bot.pathfinder.isMoving = () => bot._moving
    bot.pathfinder.setGoal = hostileSetGoal(bot, world, transit)
    const ctx = { home, step: 'build', stepStatus: 'running', buildSkip: [], buildLastProgressLog: Date.now() }
    return { world, bot, home, ctx, transit }
  }

  it('build guards door and workbench cells like wall cells, strays stay diggable', () => {
    // cjq: the guard is blueprint-scoped now, not a session id ban — the
    // bead orders strays diggable, the box cells keep the cww protection.
    const { bot } = driveHouse()
    bot.entity.position = pos(10, 64, 2)
    const home = goal.siteFor(bot, pos(0, 64, 0))
    const ctx = { home, step: 'build', stepStatus: 'running', buildSkip: [], buildLastProgressLog: 0 }
    build(bot, ctx, null, null)
    const mov = bot.pathfinder.movements
    const st = home.site
    assert.ok(breakVetoed(mov, 'oak_door', 64, st.x + 1, st.y, st.z), 'door cell protected')
    assert.ok(breakVetoed(mov, 'crafting_table', 998, st.x + 4, st.y, st.z + 1), 'workbench cell protected')
    assert.ok(breakVetoed(mov, 'oak_planks', 5, st.x, st.y, st.z), 'wall cell protected')
    assert.ok(!breakVetoed(mov, 'oak_planks', 5, st.x + 40, st.y, st.z), 'stray planks diggable')
    assert.ok(!breakVetoed(mov, 'dirt', 3, st.x, st.y, st.z), 'dirt inside the box diggable')
  })

  it('full drive: door stands, doorway and interior stay plank-free, adopt stable', async () => {
    const { world, bot, home, ctx, transit } = driveHouse()
    for (let i = 0; i < 400 && !home.built; i++) {
      if (transit.n > 0 && --transit.n === 0) bot._moving = false
      build(bot, ctx, null, null)
      await settle(2)
    }
    assert.equal(home.built, true, 'house completes')
    assert.deepEqual(bot.calls.digs.filter((n) => n.endsWith('_door') || n === 'crafting_table'), [], 'door and workbench never dug')
    const s = home.site
    assert.equal(world.get(s.x + 1, s.y, s.z), 'oak_door', 'doorway holds the door')
    for (const [dx, dz] of [[1, 1], [1, 2], [2, 1], [2, 2]]) {
      assert.ok(world.get(s.x + dx, s.y, s.z + dz) !== 'oak_planks', `interior ${dx},${dz} plank-free`)
      assert.ok(world.get(s.x + dx, s.y + 1, s.z + dz) !== 'oak_planks', `interior ${dx},${dz}+1 plank-free`)
    }
    bot.spawnPoint = pos(s.x, s.y, s.z)
    bot.findBlocks = () => {
      const out = []
      for (const [x, y, z] of [[s.x + 1, s.y, s.z], [s.x + 1, s.y + 1, s.z]]) {
        if (String(world.get(x, y, z) || '').endsWith('_door')) out.push(pos(x, y, z))
      }
      return out
    }
    const adopted = goal.adoptHome(bot)
    assert.ok(adopted, 'adopt finds the house after the drive')
    assert.equal(adopted.built, true, 'adopt sees it complete')
  })

  it('no BLUEPRINT planks cell targets the doorway or the interior', () => {
    for (const cell of BLUEPRINT) {
      if (cell.kind !== 'planks') continue
      assert.ok(!build.isDoorwayOrInterior(cell), `planks at ${cell.dx},${cell.dy},${cell.dz}`)
    }
    // Predicate shape, doorway branch included: a killed doorway check must
    // fail here, not slip a future plan edit through.
    assert.equal(build.isDoorwayOrInterior({ dx: 1, dy: 0, dz: 0 }), true, 'door lower')
    assert.equal(build.isDoorwayOrInterior({ dx: 1, dy: 1, dz: 0 }), true, 'door upper')
    assert.equal(build.isDoorwayOrInterior({ dx: 1, dy: 0, dz: 1 }), true, 'interior')
    assert.equal(build.isDoorwayOrInterior({ dx: 1, dy: 2, dz: 0 }), false, 'roof above the door is legit')
    assert.equal(build.isDoorwayOrInterior({ dx: 0, dy: 0, dz: 0 }), false, 'wall')
  })
})

describe('cww roof approach must not demolish its own wall', () => {
  const REG = {
    oak_planks: { id: 5 },
    oak_log: { id: 17 },
    dirt: { id: 3 },
    oak_door: { id: 64 },
    crafting_table: { id: 998 },
  }

  // Fake executor with canDig pathing: on a GoalPlaceBlock it breaks into
  // the path at once (first solid cell on the straight segment, feet and
  // head height) — unless the cell's id sits in movements.blocksCantBreak,
  // mirroring Movements.safeToBreak — then walks one more tick and arrives.
  // Doors and tables are interacted with, never dug.
  function diggingSetGoal(bot, world, transit) {
    return (g) => {
      bot.calls.goals.push(g)
      if (!g || g.constructor.name !== 'GoalPlaceBlock' || !g.pos) return
      const mov = bot.pathfinder.movements
      const bp = bot.entity.position
      const solidAt = (x, y, z) => {
        const name = world.get(x, y, z) ?? (y <= 63 ? 'dirt' : 'air')
        return name !== 'air' ? name : null
      }
      for (let t = 0.05; t < 1; t += 0.05) {
        const x = Math.floor(bp.x + (g.pos.x - bp.x) * t)
        const z = Math.floor(bp.z + (g.pos.z - bp.z) * t)
        for (const y of [Math.floor(bp.y), Math.floor(bp.y) + 1]) {
          const name = solidAt(x, y, z)
          if (!name || name.endsWith('_door') || name === 'crafting_table') continue
          const id = REG[name] != null ? REG[name].id : null
          if (breakVetoed(mov, name, id, x, y, z)) continue // routes around
          world.set(x, y, z, 'air')
          bot.calls.digs.push(name)
          bot._moving = true
          transit.n = 1
          return
        }
      }
      bot._moving = true
      transit.n = 1
    }
  }

  it('build forbids the executor from breaking the house, not strays', () => {
    // cjq: same scope change — the box keeps the cww roof protection, a
    // plank pile two chunks over is a legitimate dig target again.
    const world = makeWorld()
    const bot = mockBot(world, { items: [{ name: 'oak_planks', count: 40 }] })
    bot.registry = { blocksByName: REG }
    bot.pathfinder.movements = { blocksCantBreak: new Set(), exclusionAreasBreak: [] }
    bot.entity.position = pos(10, 64, 2)
    const home = goal.siteFor(bot, pos(0, 64, 0))
    const ctx = { home, step: 'build', stepStatus: 'running', buildSkip: [], buildLastProgressLog: 0 }
    build(bot, ctx, null, null)
    const mov = bot.pathfinder.movements
    const st = home.site
    assert.ok(breakVetoed(mov, 'oak_planks', 5, st.x, st.y, st.z), 'house planks protected')
    assert.ok(!breakVetoed(mov, 'oak_planks', 5, st.x + 40, st.y, st.z + 40), 'stray planks diggable')
    assert.ok(!breakVetoed(mov, 'oak_log', 17, st.x, st.y, st.z), 'logs still diggable')
    assert.ok(!breakVetoed(mov, 'dirt', 3, st.x, st.y, st.z), 'dirt still diggable')
  })

  it('roof completes with walls standing: 24/40 never flaps back', async () => {
    // Prod state (cww): walls+door+table stand, the bot is outside after the
    // wall ring, the first roof cell approach used to eat a wall corner and
    // the rebuild took priority every other tick (23/40<->24/40 for 10+ min).
    const world = makeWorld()
    const bot = mockBot(world, { items: [{ name: 'oak_planks', count: 40 }] })
    bot.registry = { blocksByName: REG }
    bot.pathfinder.movements = { blocksCantBreak: new Set(), exclusionAreasBreak: [] }
    const home = goal.siteFor(bot, pos(0, 64, 0))
    for (const cell of BLUEPRINT) {
      if (cell.dy === 2) continue // roof not started
      world.set(home.site.x + cell.dx, home.site.y + cell.dy, home.site.z + cell.dz,
        cell.kind === 'table' ? 'crafting_table' : cell.kind === 'door' ? 'oak_door' : 'oak_planks')
    }
    bot.entity.position = pos(home.site.x + 4, home.site.y, home.site.z + 1)
    const transit = { n: 0 }
    bot._moving = false
    bot.pathfinder.isMoving = () => bot._moving
    bot.pathfinder.setGoal = diggingSetGoal(bot, world, transit)
    const ctx = { home, step: 'build', stepStatus: 'running', buildSkip: [], buildLastProgressLog: 0 }
    for (let i = 0; i < 200 && !home.built; i++) {
      if (transit.n > 0 && --transit.n === 0) bot._moving = false
      build(bot, ctx, null, null)
      await settle(2)
    }
    assert.equal(home.built, true, 'roof completes')
    assert.equal(ctx.stepStatus, 'done')
    assert.deepEqual(bot.calls.digs.filter((n) => n.endsWith('_planks')), [], 'no wall plank dug')
  })
})

describe('cjq guardOwnWalls is blueprint-scoped, not session-global', () => {
  const REG = {
    oak_planks: { id: 5 },
    oak_log: { id: 17 },
    dirt: { id: 3 },
    oak_door: { id: 64 },
    crafting_table: { id: 998 },
  }
  const vetoed = (mov, name, x, y, z) => breakVetoed(mov, name, REG[name].id, x, y, z)
  function guardedBot() {
    const world = makeWorld()
    const bot = mockBot(world, { items: [{ name: 'oak_planks', count: 40 }] })
    bot.registry = { blocksByName: REG }
    bot.pathfinder.movements = { blocksCantBreak: new Set(), exclusionAreasBreak: [] }
    const home = goal.siteFor(bot, pos(0, 64, 0))
    return { world, bot, home }
  }

  it('stray planks outside the blueprint box stay diggable', () => {
    const { bot, home } = guardedBot()
    bot.entity.position = pos(10, 64, 2)
    const ctx = { home, step: 'build', stepStatus: 'running', buildSkip: [], buildLastProgressLog: 0 }
    build(bot, ctx, null, null)
    const s = home.site
    assert.equal(vetoed(bot.pathfinder.movements, 'oak_planks', s.x + 1, s.y, s.z), true, 'wall cell guarded')
    assert.equal(vetoed(bot.pathfinder.movements, 'oak_door', s.x + 1, s.y, s.z), true, 'door cell guarded')
    assert.equal(vetoed(bot.pathfinder.movements, 'crafting_table', s.x + 4, s.y, s.z + 1), true, 'table cell guarded')
    assert.equal(vetoed(bot.pathfinder.movements, 'oak_planks', s.x + 40, s.y, s.z + 40), false, 'stray planks diggable')
    assert.equal(vetoed(bot.pathfinder.movements, 'dirt', s.x + 1, s.y, s.z), false, 'dirt inside the box diggable')
  })

  it('moving home re-guards the new box and frees the old one', () => {
    const { bot, home } = guardedBot()
    const ctx = { home, step: 'build', stepStatus: 'running', buildSkip: [], buildLastProgressLog: 0 }
    build(bot, ctx, null, null)
    const s = home.site
    assert.equal(vetoed(bot.pathfinder.movements, 'oak_planks', s.x + 1, s.y, s.z), true)
    const nClosures = bot.pathfinder.movements.exclusionAreasBreak.length
    build(bot, ctx, null, null)
    assert.equal(bot.pathfinder.movements.exclusionAreasBreak.length, nClosures, 'one closure per movements')
    ctx.home = goal.siteFor(bot, pos(100, 64, 100))
    build(bot, ctx, null, null)
    const n2 = ctx.home.site
    assert.equal(vetoed(bot.pathfinder.movements, 'oak_planks', n2.x + 1, n2.y, n2.z), true, 'new box guarded')
    assert.equal(vetoed(bot.pathfinder.movements, 'oak_planks', s.x + 1, s.y, s.z), false, 'old box freed')
  })
})
