'use strict'

// Bead idkcraft-ipn.10: the build step looped one fill cell 316 min
// ('building 98/99', moving=false) — a wedged executor, a hung place
// flight, or a success-without-effect cycle never touch the refusal
// counters. A per-cell tick budget with displacement forgiveness skips the
// cell like a refusal, and given-up cells persist in the home record.

const { describe, it, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const goal = require('../src/goal')
const build = require('../src/behaviours/build')
const memory = require('../src/memory')
const { createTicker } = require('../src/index')

function pos(x, y, z) {
  const p = { x, y, z, distanceTo: (q) => Math.hypot(x - q.x, y - q.y, z - q.z) }
  p.clone = () => pos(p.x, p.y, p.z)
  p.floored = () => pos(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z))
  return p
}

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

// Paint a whole correct v2 house except `leaveOut` plan indices.
function paintHouse(world, home, leaveOut = []) {
  const skip = new Set(leaveOut)
  build.blueprintFor(home).forEach((cell, i) => {
    if (skip.has(i)) return
    const name = cell.kind === 'table' ? 'crafting_table' : cell.kind === 'door' ? 'oak_door' : 'oak_planks'
    world.set(home.site.x + cell.dx, home.site.y + cell.dy, home.site.z + cell.dz, name)
  })
}

function mockBot(world, { items = [], at = pos(0, 65, 0), moving = false, place = null } = {}) {
  const chats = []
  const calls = { goals: [], places: [], digs: [], equips: [] }
  const bot = {
    chats,
    calls,
    spawnPoint: pos(0, 64, 0),
    entity: { position: at },
    world: { getBlock: () => null },
    players: {},
    held: null,
    inventory: { items: () => items },
    blockAt: (p) => world.blockAt(p),
    findBlocks: () => [],
    pathfinder: {
      isMoving: () => moving,
      setGoal: (g) => { calls.goals.push(g) },
    },
    equip: async (item, dest) => { calls.equips.push([item.name, dest]); bot.held = item.name },
    dig: async (b) => {
      calls.digs.push(b.name)
      world.set(b.position.x, b.position.y, b.position.z, 'air')
    },
    placeBlock: place || (async (ref, face) => {
      calls.places.push([ref, face])
      const rp = (ref && ref.position) || ref
      world.set(rp.x + face.x, rp.y + face.y, rp.z + face.z, bot.held)
    }),
    chat: (m) => { chats.push(String(m)) },
  }
  return bot
}

const settle = async (n = 5) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)) }

function quiet() {
  const lines = []
  const origLog = console.log
  const origErr = console.error
  console.log = (m) => lines.push(String(m))
  console.error = (m) => lines.push(String(m))
  return { lines, restore() { console.log = origLog; console.error = origErr } }
}

describe('ipn.10 per-cell attempt budget', () => {
  it('a success-without-effect cell skips within the budget, not after 316 min', async () => {
    // Prod shape: placeBlock resolves, the cell never reads done, the body
    // stands still — pre-fix nothing counts and the step loops forever.
    const home = { site: { x: 0, y: 64, z: 0 }, v: 2, built: false }
    const world = makeWorld()
    const stuckIdx = 10 // a lower-ring planks cell
    paintHouse(world, home, [stuckIdx])
    const cell = build.blueprintFor(home)[stuckIdx]
    const bot = mockBot(world, {
      items: [{ name: 'oak_planks', count: 64 }],
      at: pos(home.site.x + cell.dx + 0.5, home.site.y + cell.dy, home.site.z + cell.dz + 2.5),
      place: async (ref, face) => { bot.calls.places.push([ref, face]) }, // resolves, lands nothing
    })
    const ctx = { home, step: 'build', stepStatus: 'running', buildSkip: [], buildLastProgressLog: Date.now() }
    const q = quiet()
    let ticks = 0
    try {
      for (ticks = 0; ticks < build.CELL_TICK_BUDGET + 30 && ctx.buildSkip.length === 0; ticks++) {
        build(bot, ctx, null, null)
        await settle()
      }
    } finally {
      q.restore()
    }
    assert.deepEqual(ctx.buildSkip, [stuckIdx], 'the stuck cell skips')
    assert.ok(ticks <= build.CELL_TICK_BUDGET + 2, `bounded (${ticks} ticks, budget ${build.CELL_TICK_BUDGET})`)
    assert.ok(q.lines.some((m) => m.includes('cell-budget')), `budget skip logged: ${JSON.stringify(q.lines)}`)
  })

  it('a wedged executor (moving forever, no displacement) skips too', async () => {
    // The `if (moving) return` branch reaches no counter pre-fix.
    const home = { site: { x: 0, y: 64, z: 0 }, v: 2, built: false }
    const world = makeWorld()
    const stuckIdx = 10
    paintHouse(world, home, [stuckIdx])
    const cell = build.blueprintFor(home)[stuckIdx]
    const bot = mockBot(world, {
      items: [{ name: 'oak_planks', count: 64 }],
      at: pos(home.site.x + cell.dx + 0.5, home.site.y + cell.dy, home.site.z + cell.dz + 2.5),
      moving: true, // wedged: claims motion, body never moves
    })
    const ctx = { home, step: 'build', stepStatus: 'running', buildSkip: [], buildLastProgressLog: Date.now() }
    const q = quiet()
    try {
      for (let t = 0; t < build.CELL_TICK_BUDGET + 30 && ctx.buildSkip.length === 0; t++) {
        build(bot, ctx, null, null)
        await settle()
      }
    } finally {
      q.restore()
    }
    assert.deepEqual(ctx.buildSkip, [stuckIdx], 'the unwalkable cell skips')
  })

  it('a genuine approach walk never trips the budget', async () => {
    // Displacement past CELL_PROGRESS forgives: 200 ticks of real walking
    // with no placement still skip nothing.
    const home = { site: { x: 0, y: 64, z: 0 }, v: 2, built: false }
    const world = makeWorld()
    const stuckIdx = 10
    paintHouse(world, home, [stuckIdx])
    const cell = build.blueprintFor(home)[stuckIdx]
    const bot = mockBot(world, {
      items: [{ name: 'oak_planks', count: 64 }],
      at: pos(home.site.x + cell.dx - 20.5, home.site.y, home.site.z + cell.dz),
      moving: true,
      place: async (ref, face) => { bot.calls.places.push([ref, face]) },
    })
    const ctx = { home, step: 'build', stepStatus: 'running', buildSkip: [], buildLastProgressLog: Date.now() }
    const q = quiet()
    try {
      for (let t = 0; t < 200; t++) {
        // Walk toward the cell in 2-block legs (real displacement).
        if (t % 10 === 0) bot.entity.position = pos(bot.entity.position.x + 2, 64, bot.entity.position.z)
        build(bot, ctx, null, null)
        await settle()
      }
    } finally {
      q.restore()
    }
    assert.deepEqual(ctx.buildSkip, [], 'steady approach progress never skips')
  })

  it('three hung flights skip the cell as flight-hang', async () => {
    // A placeBlock that never settles wedges every tick on the
    // placeInFlight early-return pre-fix; the deadline strikes like a
    // refusal instead.
    const home = { site: { x: 0, y: 64, z: 0 }, v: 2, built: false }
    const world = makeWorld()
    const stuckIdx = 10
    paintHouse(world, home, [stuckIdx])
    const cell = build.blueprintFor(home)[stuckIdx]
    const bot = mockBot(world, {
      items: [{ name: 'oak_planks', count: 64 }],
      at: pos(home.site.x + cell.dx + 0.5, home.site.y + cell.dy, home.site.z + cell.dz + 2.5),
      place: () => new Promise(() => {}), // hangs forever
    })
    const ctx = { home, step: 'build', stepStatus: 'running', buildSkip: [], buildLastProgressLog: Date.now() }
    const q = quiet()
    try {
      for (let hang = 0; hang < 3; hang++) {
        // The flight starts on the second tick (the first only (re)approaches).
        for (let t = 0; t < 5 && !ctx.placeInFlight; t++) {
          build(bot, ctx, null, null)
          await settle()
        }
        assert.equal(ctx.placeInFlight, true, 'flight in flight')
        ctx.buildFlightSince = Date.now() - build.FLIGHT_TIMEOUT_MS - 1 // age past the deadline
        build(bot, ctx, null, null) // trips the deadline, strikes, re-flights
        await settle()
      }
    } finally {
      q.restore()
    }
    assert.deepEqual(ctx.buildSkip, [stuckIdx], 'three hangs skip the cell')
    assert.ok(q.lines.some((m) => m.includes('flight-hang')), `hang skip logged: ${JSON.stringify(q.lines)}`)
  })

  it('a foreign (beds/light) flight never trips the build deadline', async () => {
    // Only build's own flights carry the stamp.
    const home = { site: { x: 0, y: 64, z: 0 }, v: 2, built: false }
    const world = makeWorld()
    paintHouse(world, home, [10])
    const bot = mockBot(world, { items: [{ name: 'oak_planks', count: 64 }] })
    const ctx = { home, step: 'build', stepStatus: 'running', buildSkip: [], buildLastProgressLog: Date.now() }
    ctx.placeInFlight = true // someone else's flight, no build stamp
    ctx.buildFlightSince = null
    build(bot, ctx, null, null)
    await settle()
    assert.equal(ctx.placeInFlight, true, 'foreign flight untouched')
    assert.equal(ctx.buildFails || 0, 0, 'no strike')
    assert.deepEqual(ctx.buildSkip, [])
  })

  it('a late settlement for a skipped cell strikes nothing', async () => {
    // The budget skip races the flight: its verdict must not land on the
    // next cell.
    const home = { site: { x: 0, y: 64, z: 0 }, v: 2, built: false }
    const world = makeWorld()
    paintHouse(world, home, [10, 11])
    const cell = build.blueprintFor(home)[10]
    let rejectFlight = null
    const bot = mockBot(world, {
      items: [{ name: 'oak_planks', count: 64 }],
      at: pos(home.site.x + cell.dx + 0.5, home.site.y + cell.dy, home.site.z + cell.dz + 2.5),
      place: () => new Promise((_, reject) => { rejectFlight = reject }),
    })
    const ctx = { home, step: 'build', stepStatus: 'running', buildSkip: [], buildLastProgressLog: Date.now(), buildFailIdx: -1 }
    const q = quiet()
    try {
      // The flight starts on the second tick (the first only approaches).
      for (let t = 0; t < 5 && !ctx.placeInFlight; t++) {
        build(bot, ctx, null, null)
        await settle()
      }
      assert.equal(ctx.placeInFlight, true)
      const staleReject = rejectFlight
      // Budget-trip cell 10 while the flight hangs.
      ctx.buildCellSite = `${home.site.x},${home.site.y},${home.site.z},v2`
      ctx.buildMaxIdx = 10
      ctx.buildCellIdx = 10
      ctx.buildStallTicks = build.CELL_TICK_BUDGET - 1
      ctx.buildAnchor = { ...bot.entity.position }
      ctx.placeInFlight = false // the deadline path would have cleared it
      ctx.buildFlightSince = null
      build(bot, ctx, null, null)
      await settle()
      assert.deepEqual(ctx.buildSkip, [10], 'cell 10 budget-skipped')
      build(bot, ctx, null, null) // advance to cell 11 (buildFailIdx moves on)
      await settle()
      staleReject(new Error('refused')) // the stale verdict lands late
      await settle(10)
    } finally {
      q.restore()
    }
    assert.equal(ctx.buildFails || 0, 0, 'stale refusal strikes nothing')
    assert.deepEqual(ctx.buildSkip, [10], 'no cascade skip')
  })
})

describe('ipn.10 buildSkip survives restart', () => {
  let dir = null
  let file = null
  let prevEnv = null

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ipn10-'))
    file = path.join(dir, 'bot.json')
    prevEnv = process.env.BOT_MEMORY_FILE
    process.env.BOT_MEMORY_FILE = file
  })

  afterEach(() => {
    if (prevEnv === undefined) delete process.env.BOT_MEMORY_FILE
    else process.env.BOT_MEMORY_FILE = prevEnv
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch (_) { /* tmp best-effort */ }
  })

  it('save/restore round-trips the skips of the current home', () => {
    const botAt = { username: 'IdkBot', spawnPoint: { x: 0, y: 64, z: 0 } }
    const now = Date.now()
    const ctx1 = { home: { site: { x: 0, y: 64, z: 0 }, v: 2 }, buildSkip: [7, 12] }
    assert.equal(memory.save(botAt, ctx1, file, now), true)
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).homes[0].skip, [7, 12])
    const ctx2 = {}
    assert.ok(memory.restore(botAt, ctx2, file, now))
    assert.deepEqual(ctx2.buildSkip, [7, 12], 'restart resumes past the given-up cells')
  })

  it('a doc without skips restores an empty list, garbage sanitizes', () => {
    const botAt = { username: 'IdkBot', spawnPoint: { x: 0, y: 64, z: 0 } }
    const now = Date.now()
    const ctx1 = { home: { site: { x: 0, y: 64, z: 0 }, v: 2 }, buildSkip: [] }
    assert.equal(memory.save(botAt, ctx1, file, now), true)
    assert.ok(!('skip' in JSON.parse(fs.readFileSync(file, 'utf8')).homes[0]), 'empty skips write no key')
    const ctx2 = { buildSkip: [3] }
    assert.ok(memory.restore(botAt, ctx2, file, now))
    assert.deepEqual(ctx2.buildSkip, [], 'no record means no skips')
    // Hand-edited garbage: non-integers, negatives, and over-cap dropped.
    const doc = JSON.parse(fs.readFileSync(file, 'utf8'))
    doc.homes[0].skip = ['7', -1, 999, 7, 7]
    fs.writeFileSync(file, JSON.stringify(doc))
    const ctx3 = {}
    assert.ok(memory.restore(botAt, ctx3, file, now))
    assert.deepEqual(ctx3.buildSkip, [7])
  })

  it('setHome keeps same-site skips, drops them on a move', () => {
    const bot = { username: 'IdkBot', players: {}, entity: { position: pos(0, 65, 0) }, chat: () => {} }
    const ticker = createTicker({ bot, brain: null, tickMs: 10, idleTickMs: 10 })
    const ctx = bot._tickerCtx
    try {
      ticker.setHome({ site: { x: 0, y: 64, z: 0 }, v: 2 })
      ctx.buildSkip = [7, 12]
      ticker.setHome({ site: { x: 0, y: 64, z: 0 }, v: 2 }) // fresh adopt object, same site
      assert.deepEqual(ctx.buildSkip, [7, 12], 'same-site swap keeps the skips')
      ticker.setHome({ site: { x: 100, y: 64, z: 100 }, v: 2 }) // 'build here' elsewhere
      assert.deepEqual(ctx.buildSkip, [], 'moved: skips dropped with the old plan')
      ctx.buildSkip = [7]
      ticker.setHome({ site: { x: 100, y: 64, z: 100 }, v: 1 }) // same site, other version
      assert.deepEqual(ctx.buildSkip, [], 'version flip drops: indices belong to the plan')
    } finally {
      ticker.destroy()
    }
  })

  it("an explicit 'build here' re-verdicts even same-site", () => {
    // Revmux 01 core-4: the owner may have fixed the terrain, so a fresh
    // verdict clears given-up cells (and their stamps) for a re-probe.
    const bot = { username: 'IdkBot', players: {}, entity: { position: pos(0, 65, 0) }, chat: () => {} }
    const ticker = createTicker({ bot, brain: null, tickMs: 10, idleTickMs: 10 })
    const ctx = bot._tickerCtx
    try {
      ticker.setHome({ site: { x: 0, y: 64, z: 0 }, v: 2 })
      const ts = Date.now()
      ctx.buildSkip = [7, 12]
      ctx.buildSkipAt = { 7: ts, 12: ts }
      ticker.setHome({ site: { x: 0, y: 64, z: 0 }, v: 2 }) // adopt: keeps
      assert.deepEqual(ctx.buildSkip, [7, 12], 'adopt keeps the skips')
      assert.deepEqual(ctx.buildSkipAt, { 7: ts, 12: ts }, 'adopt keeps the stamps')
      ticker.setHome({ site: { x: 0, y: 64, z: 0 }, v: 2 }, { fresh: true }) // 'build here'
      assert.deepEqual(ctx.buildSkip, [], 'fresh verdict re-probes the cells')
      assert.deepEqual(ctx.buildSkipAt, {}, 'stamps go with the skips')
    } finally {
      ticker.destroy()
    }
  })
})

describe('ipn.10 revmux 01: hard cap and skip retry', () => {
  let dir = null
  let file = null
  let prevEnv = null

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ipn10r1-'))
    file = path.join(dir, 'bot.json')
    prevEnv = process.env.BOT_MEMORY_FILE
    process.env.BOT_MEMORY_FILE = file
  })

  afterEach(() => {
    if (prevEnv === undefined) delete process.env.BOT_MEMORY_FILE
    else process.env.BOT_MEMORY_FILE = prevEnv
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch (_) { /* tmp best-effort */ }
  })

  it('an oscillation that keeps displacing still ends at the hard cap', async () => {
    // Core-3: displacement forgiveness cannot tell an approach from a
    // back-and-forth re-approach. The hard cap counts every non-advancing
    // tick unforgiven, so the loop ends anyway.
    const home = { site: { x: 0, y: 64, z: 0 }, v: 2, built: false }
    const world = makeWorld()
    const stuckIdx = 10
    paintHouse(world, home, [stuckIdx])
    const cell = build.blueprintFor(home)[stuckIdx]
    const bot = mockBot(world, {
      items: [{ name: 'oak_planks', count: 64 }],
      at: pos(home.site.x + cell.dx + 0.5, home.site.y + cell.dy, home.site.z + cell.dz + 2.5),
      moving: true,
      place: async (ref, face) => { bot.calls.places.push([ref, face]) },
    })
    const ctx = {
      home, step: 'build', stepStatus: 'running', buildSkip: [], buildLastProgressLog: Date.now(),
      buildCellSite: '0,64,0,v2', buildMaxIdx: stuckIdx, buildCellIdx: stuckIdx, buildStallTicks: 0,
      buildHardTicks: build.CELL_HARD_CAP - 3, buildAnchor: { ...bot.entity.position },
    }
    const q = quiet()
    try {
      for (let t = 0; t < 10 && ctx.buildSkip.length === 0; t++) {
        // Oscillate ±2: every tick displaces past CELL_PROGRESS, so the
        // stall budget forgives — the hard cap must not.
        const dx = t % 2 === 0 ? 2 : -2
        bot.entity.position = pos(bot.entity.position.x + dx, bot.entity.position.y, bot.entity.position.z)
        build(bot, ctx, null, null)
        await settle()
      }
    } finally {
      q.restore()
    }
    assert.deepEqual(ctx.buildSkip, [stuckIdx], 'oscillation ends at the hard cap')
    assert.ok(q.lines.some((m) => m.includes('cell-hard-cap')), `hard-cap skip logged: ${JSON.stringify(q.lines)}`)
  })

  it('below a traversed max, each lower cell gets its own budget', async () => {
    // Revmux 02: the hard and stall counters were shared across cells, so
    // once the house had been fully traversed a skip handed the next lower
    // cell the exhausted remainder and skipped it on its first tick.
    const home = { site: { x: 0, y: 64, z: 0 }, v: 2, built: false }
    const world = makeWorld()
    paintHouse(world, home, [6, 7]) // two broken lower cells, max stands at 98
    const cell = build.blueprintFor(home)[6]
    const bot = mockBot(world, {
      items: [{ name: 'oak_planks', count: 64 }],
      at: pos(home.site.x + cell.dx + 0.5, home.site.y + cell.dy, home.site.z + cell.dz + 2.5),
      place: async (ref, face) => { bot.calls.places.push([ref, face]) }, // unplaceable
    })
    const ctx = {
      home, step: 'build', stepStatus: 'running', buildSkip: [], buildLastProgressLog: Date.now(),
      buildCellSite: '0,64,0,v2', buildMaxIdx: 98, buildCellIdx: 6,
      buildStallTicks: build.CELL_TICK_BUDGET - 1, buildHardTicks: build.CELL_HARD_CAP - 1,
      buildAnchor: { ...bot.entity.position },
    }
    const q = quiet()
    try {
      build(bot, ctx, null, null) // cell 6 exhausts the shared remainder, skips
      await settle()
      assert.deepEqual(ctx.buildSkip, [6], 'cell 6 skips at the cap')
      for (let t = 0; t < 5; t++) { // cell 7 starts its own budget
        build(bot, ctx, null, null)
        await settle()
      }
    } finally {
      q.restore()
    }
    assert.deepEqual(ctx.buildSkip, [6], 'cell 7 is not skipped on the remainder')
    assert.ok(ctx.buildHardTicks <= 6, `cell 7 counts its own ticks (${ctx.buildHardTicks})`)
    assert.ok(ctx.buildStallTicks <= 6, `stall budget re-armed too (${ctx.buildStallTicks})`)
  })

  it('stamped skips retry after the window, fresh and unstamped skips stay', () => {
    // Core-4: only verdicts this code stamped may expire.
    const old = Date.now() - build.BUILD_SKIP_RETRY_MS - 1
    const fresh = Date.now()
    const ctx = { buildSkip: [5, 6, 7], buildSkipAt: { 5: old, 6: fresh } }
    build.pruneBuildSkips(ctx)
    assert.deepEqual(ctx.buildSkip, [6, 7], 'only the stale stamped skip re-probes')
    assert.deepEqual(ctx.buildSkipAt, { 6: fresh }, 'dead stamp dropped with its skip')
    build.pruneBuildSkips(ctx)
    assert.deepEqual(ctx.buildSkip, [6, 7], 'prune is idempotent')
  })

  it('the build menu gate re-probes a restored stale skip on the first decide', () => {
    // Core-4: a deploy heals stale holes like the pre-persistence code did.
    const home = { site: { x: 0, y: 64, z: 0 }, v: 2, built: false }
    const world = makeWorld()
    paintHouse(world, home, [10])
    const bot = mockBot(world, { items: [{ name: 'oak_planks', count: 64 }] })
    const old = Date.now() - build.BUILD_SKIP_RETRY_MS - 1
    const ctx = { home, buildSkip: [10], buildSkipAt: { 10: old } }
    const facts = { planks: 16, table: 1, door: 1 }
    const feasible = goal.MENU.build.feasible(facts, bot, ctx)
    assert.deepEqual(ctx.buildSkip, [], 'stale skip dropped before the scan')
    assert.equal(feasible, true, 'cell 10 re-probes as unfinished work')
    // Control: a fresh verdict stays skipped.
    const ctx2 = { home, buildSkip: [10], buildSkipAt: { 10: Date.now() } }
    goal.MENU.build.feasible(facts, bot, ctx2)
    assert.deepEqual(ctx2.buildSkip, [10], 'fresh skip survives the gate')
  })

  it('verdict stamps round-trip through the home record, garbage sanitizes', () => {
    const botAt = { username: 'IdkBot', spawnPoint: { x: 0, y: 64, z: 0 } }
    const now = Date.now()
    const ts = now - 1000
    const ctx1 = { home: { site: { x: 0, y: 64, z: 0 }, v: 2 }, buildSkip: [7, 12], buildSkipAt: { 7: ts, 12: ts } }
    assert.equal(memory.save(botAt, ctx1, file, now), true)
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).homes[0].skipAt, { 7: ts, 12: ts })
    const ctx2 = {}
    assert.ok(memory.restore(botAt, ctx2, file, now))
    assert.deepEqual(ctx2.buildSkipAt, { 7: ts, 12: ts }, 'restart keeps the verdict clocks')
    // Hand-edited garbage: stamps for non-skips, far-future, and junk dropped.
    const doc = JSON.parse(fs.readFileSync(file, 'utf8'))
    doc.homes[0].skipAt = { 7: ts, 99: ts, 12: 'soon', 13: now + 86400000 * 2 }
    doc.homes[0].skip = [7, 12]
    fs.writeFileSync(file, JSON.stringify(doc))
    const ctx3 = {}
    assert.ok(memory.restore(botAt, ctx3, file, now))
    assert.deepEqual(ctx3.buildSkipAt, { 7: ts })
  })
})
