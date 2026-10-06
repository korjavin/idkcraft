'use strict'

// Bead idkcraft-vmzq.10: the prod house (site -40 63 -215, window
// 2026-10-06T16:56:03Z) skipped 30 cells — whole rows with `build skip …
// after 3 refusals (no-ref)` — then reported `home done` over the holes
// (world-read 70/99). Root cause: the site was never validated as flat
// (stale speaker pos + unloaded-chunk fallback in siteFor), so wall cells
// over water/dips found no reference block; the verdict then counted
// given-up cells as done. build.js cannot place floating or buried cells,
// so the fix is the verdict: a house with holes is failed, never done.

const { describe, it, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const goal = require('../src/goal')
const build = require('../src/behaviours/build')

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

function mockBot(world, { items = [], at = pos(0, 65, 0) } = {}) {
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
      const rp = (ref && ref.position) || ref
      world.set(rp.x + face.x, rp.y + face.y, rp.z + face.z, bot.held)
    },
    chat: (m) => { chats.push(String(m)) },
  }
  return bot
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

const settle = async (n = 5) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)) }

describe('vmzq.10 isComplete: done means placed, skips never count', () => {
  it('a fully placed house is complete', () => {
    const world = makeWorld()
    const bot = mockBot(world)
    const home = goal.siteFor(bot, pos(0, 64, 0))
    paintHouse(world, home)
    assert.equal(build.isComplete(bot, home), true)
  })

  it('one missing cell is incomplete', () => {
    // Skip interplay (a skip never completes a hole, a stale skip over a
    // placed cell still completes) is pinned at the build level below —
    // isComplete takes no skip list, so units here cannot exercise it.
    const world = makeWorld()
    const bot = mockBot(world)
    const home = goal.siteFor(bot, pos(0, 64, 0))
    const plan = build.blueprintFor(home)
    const roof = plan.findIndex((c) => c.kind === 'planks' && c.dy === 2)
    paintHouse(world, home, [roof])
    assert.equal(build.isComplete(bot, home), false)
  })

  it('a correctly empty doorway-interior cell is not a hole (8si)', () => {
    // A corrupt plan entry (planks in the living room) must skip, not
    // brick the house: the invariant forbids placing there, so air reads
    // complete. The full-drive 8si scenario pins the end-to-end shape.
    const injected = { dx: 2, dy: 0, dz: 1, kind: 'planks' }
    build.BLUEPRINT_V2.splice(1, 0, injected)
    try {
      const world = makeWorld()
      const bot = mockBot(world)
      const home = goal.siteFor(bot, pos(0, 64, 0))
      paintHouse(world, home, [1]) // everything but the bad cell
      assert.equal(world.get(home.site.x + 2, home.site.y, home.site.z + 1), undefined)
      assert.equal(build.isComplete(bot, home), true)
    } finally {
      build.BLUEPRINT_V2.splice(build.BLUEPRINT_V2.indexOf(injected), 1)
    }
  })
})

describe('vmzq.10 build fails instead of done over skipped cells', () => {
  let origLog
  let lines
  beforeEach(() => { origLog = console.log; lines = []; console.log = (l) => { lines.push(String(l)) } })
  afterEach(() => { console.log = origLog })

  it('holes fail the step: no built flag, no home-done chat', () => {
    const world = makeWorld()
    const bot = mockBot(world, { items: [{ name: 'oak_planks', count: 40 }] })
    const home = goal.siteFor(bot, pos(0, 64, 0))
    const plan = build.blueprintFor(home)
    const roof = plan.findIndex((c) => c.kind === 'planks' && c.dy === 2)
    paintHouse(world, home, [roof]) // one hole left
    const ctx = { home, step: 'build', stepStatus: 'running', buildSkip: [roof], buildLastProgressLog: Date.now() }
    build(bot, ctx, null, null)
    assert.equal(ctx.stepStatus, 'failed:skipped-cells')
    assert.equal(ctx.home.built, false)
    assert.ok(!bot.chats.some((m) => m.startsWith('home done at')), bot.chats.join(' | '))
    const holes = lines.filter((l) => l.startsWith('build holes remain'))
    assert.equal(holes.length, 1)
    assert.ok(holes[0].includes('1 skipped'))
  })

  it('the holes line logs once per episode, not every tick', () => {
    const world = makeWorld()
    const bot = mockBot(world, { items: [{ name: 'oak_planks', count: 40 }] })
    const home = goal.siteFor(bot, pos(0, 64, 0))
    const plan = build.blueprintFor(home)
    const roof = plan.findIndex((c) => c.kind === 'planks' && c.dy === 2)
    paintHouse(world, home, [roof])
    const ctx = { home, step: 'build', stepStatus: 'running', buildSkip: [roof], buildLastProgressLog: Date.now() }
    build(bot, ctx, null, null)
    build(bot, ctx, null, null)
    build(bot, ctx, null, null)
    assert.equal(ctx.stepStatus, 'failed:skipped-cells')
    assert.equal(lines.filter((l) => l.startsWith('build holes remain')).length, 1)
  })

  it('a stale skip over a placed cell still completes', () => {
    const world = makeWorld()
    const bot = mockBot(world, { items: [{ name: 'oak_planks', count: 40 }] })
    const home = goal.siteFor(bot, pos(0, 64, 0))
    paintHouse(world, home) // everything physically placed…
    const plan = build.blueprintFor(home)
    const roof = plan.findIndex((c) => c.kind === 'planks' && c.dy === 2)
    const ctx = { home, step: 'build', stepStatus: 'running', buildSkip: [roof], buildLastProgressLog: Date.now() }
    build(bot, ctx, null, null)
    assert.equal(ctx.stepStatus, 'done')
    assert.equal(ctx.home.built, true)
    assert.ok(bot.chats.some((m) => m === 'home done at 6 64 0'))
  })

  it('prod shape: a dip cell skips no-ref, then the house fails, never done', async () => {
    // Miniature of the prod run: the ground under the table cell is gone
    // (prod: water/dip columns over an unvalidated shore site), so the
    // reference scan finds nothing on all six sides three ticks running.
    const world = makeWorld()
    const bot = mockBot(world, {
      items: [
        { name: 'oak_planks', count: 60 },
        { name: 'crafting_table', count: 1 },
        { name: 'oak_door', count: 1 },
      ],
      at: pos(11, 64, 2), // next to the table cell (11,64,1)
    })
    const home = goal.siteFor(bot, pos(0, 64, 0))
    assert.deepEqual(home.site, { x: 6, y: 64, z: 0 })
    world.set(11, 63, 1, 'air') // the dip: no ground under the table cell
    const ctx = { home, step: 'build', stepStatus: 'running', buildSkip: [], buildLastProgressLog: Date.now() }
    for (let i = 0; i < 8; i++) {
      build(bot, ctx, null, null)
      await settle()
      if (ctx.buildSkip.length > 0) break
    }
    assert.deepEqual(ctx.buildSkip, [0], 'the table cell gives up')
    const skips = lines.filter((l) => l.startsWith('build skip'))
    assert.equal(skips.length, 1)
    assert.ok(skips[0].includes('(no-ref)'), skips[0])
    paintHouse(world, home, [0]) // the rest of the house goes up
    world.set(11, 64, 1, 'air') // …but the skipped table cell stays a hole
    build(bot, ctx, null, null)
    assert.equal(ctx.stepStatus, 'failed:skipped-cells')
    assert.equal(ctx.home.built, false)
    assert.ok(!bot.chats.some((m) => m.startsWith('home done at')), bot.chats.join(' | '))
  })
})
