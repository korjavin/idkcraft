'use strict'

// Bead idkcraft-1c4: the v2 house lays a bedroom floor — ground-fill cells
// at dy -1 under the four jr2.2 bed halves plus the doorway, so a terrain
// dip no longer strands bed or door placement (rig-proven: air under
// A-foot, air under the door). Done means SOLID ground (dirt counts):
// flat sites place nothing, dips take one plank each.

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const goal = require('../src/goal')
const build = require('../src/behaviours/build')

const BLUEPRINT_V2 = build.BLUEPRINT_V2

function pos(x, y, z) {
  const p = { x, y, z, distanceTo: (q) => Math.hypot(x - q.x, y - q.y, z - q.z) }
  p.clone = () => pos(p.x, p.y, p.z)
  p.floored = () => pos(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z))
  return p
}

function makeWorld() {
  const cells = new Map()
  const key = (x, y, z) => `${Math.floor(x)},${Math.floor(y)},${Math.floor(z)}`
  // Collision mirror (revmux 01 core-1): the real client reports an empty
  // bounding box for air-likes and collisionless flora/decor, whatever
  // the name rule lists.
  const NO_COLLISION = new Set(['air', 'cave_air', 'void_air', 'brown_mushroom', 'red_mushroom', 'lily_of_the_valley', 'white_carpet'])
  return {
    set(x, y, z, name) { cells.set(key(x, y, z), name) },
    get(x, y, z) { return cells.get(key(x, y, z)) },
    blockAt(p) {
      const fx = Math.floor(p.x)
      const fy = Math.floor(p.y)
      const fz = Math.floor(p.z)
      const k = key(fx, fy, fz)
      const name = cells.has(k) ? cells.get(k) : (fy <= 63 ? 'dirt' : 'air')
      return { name, boundingBox: NO_COLLISION.has(name) ? 'empty' : 'block', position: { x: fx, y: fy, z: fz } }
    },
  }
}

function mockBot(world, { items = [], doors = [], spawn = pos(0, 64, 0), at = null } = {}) {
  const chats = []
  const calls = { goals: [], places: [], digs: [], equips: [] }
  const bot = {
    chats,
    calls,
    spawnPoint: spawn,
    entity: { position: at || pos(0, 65, 0) },
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
      const rp = (ref && ref.position) || ref
      world.set(rp.x + face.x, rp.y + face.y, rp.z + face.z, bot.held)
    },
    chat: (m) => { chats.push(String(m)) },
  }
  return bot
}

function paintHouse(world, home) {
  for (const cell of build.blueprintFor(home)) {
    const name = cell.kind === 'table' ? 'crafting_table' : cell.kind === 'door' ? 'oak_door' : 'oak_planks'
    world.set(home.site.x + cell.dx, home.site.y + cell.dy, home.site.z + cell.dz, name)
  }
}

const settle = async (n = 5) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)) }

describe('1c4 floor cells sit under the jr2.2 bed halves, table still first', () => {
  it('plan[0] is the table, plan[1..5] the dy -1 bedroom floor', () => {
    assert.deepEqual(BLUEPRINT_V2[0], { dx: 5, dy: 0, dz: 1, kind: 'table' })
    assert.deepEqual(BLUEPRINT_V2.slice(1, 6), [
      { dx: 1, dy: -1, dz: 4, kind: 'fill' },
      { dx: 2, dy: -1, dz: 4, kind: 'fill' },
      { dx: 4, dy: -1, dz: 4, kind: 'fill' },
      { dx: 5, dy: -1, dz: 4, kind: 'fill' },
      { dx: 3, dy: -1, dz: 0, kind: 'fill' },
    ])
  })

  it('v1 huts have no floor: the frozen plan is untouched', () => {
    assert.ok(build.BLUEPRINT.every((c) => c.kind !== 'fill'))
  })
})

describe('1c4 fill done rule: solid ground counts, dips do not', () => {
  const home = { site: { x: 6, y: 64, z: 0 }, v: 2 }
  const cell = BLUEPRINT_V2[1] // A-foot ground
  const check = (name) => {
    const world = makeWorld()
    world.set(7, 63, 4, name)
    return build.cellDone(mockBot(world), home, cell)
  }
  it('dirt, stone, sand and planks read done', () => {
    for (const n of ['dirt', 'grass_block', 'stone', 'cobblestone', 'sand', 'oak_planks']) {
      assert.equal(check(n), true, n)
    }
  })
  it('air, water, lava and flora read missing', () => {
    for (const n of ['air', 'cave_air', 'void_air', 'water', 'lava', 'short_grass', 'poppy', 'red_tulip', 'snow', 'torch']) {
      assert.equal(check(n), false, n)
    }
  })
  it('unlisted flora without collision reads missing too (revmux 01)', () => {
    // Mushrooms, lilies and carpets are not in REPLACEABLE: the
    // collision half of the rule catches them.
    for (const n of ['brown_mushroom', 'red_mushroom', 'lily_of_the_valley', 'white_carpet']) {
      assert.equal(check(n), false, n)
    }
  })
  it('an unreadable cell reads missing, never done', () => {
    const bot = mockBot(makeWorld())
    bot.blockAt = () => null
    assert.equal(build.cellDone(bot, home, cell), false)
  })
})

describe('1c4 build lays the floor before the walls', () => {
  it('flat ground reads done: the first approach aims at ring0, not the floor', () => {
    const world = makeWorld()
    const bot = mockBot(world, { items: [{ name: 'oak_planks', count: 40 }], at: pos(6, 64, 1) })
    const home = goal.siteFor(bot, pos(0, 64, 0))
    const s = home.site
    world.set(s.x + 5, s.y, s.z + 1, 'crafting_table') // table stands
    const ctx = { home, step: 'build', stepStatus: 'running', buildSkip: [], buildLastProgressLog: Date.now() }
    const ring0 = BLUEPRINT_V2.findIndex((c) => c.kind === 'planks' && c.dy === 0)
    assert.equal(build.nextCellIdx(bot, home, []), ring0)
    build(bot, ctx, null, null) // approach
    assert.equal(bot.calls.goals.length, 1)
    const g = bot.calls.goals[0]
    const want = BLUEPRINT_V2[ring0]
    assert.deepEqual({ x: g.pos.x, y: g.pos.y, z: g.pos.z }, { x: s.x + want.dx, y: s.y + want.dy, z: s.z + want.dz })
    assert.equal(bot.calls.places.length, 0)
  })

  it('a dip takes exactly one plank, then the floor cell is done', async () => {
    const world = makeWorld()
    const bot = mockBot(world, {
      items: [{ name: 'oak_planks', count: 40 }, { name: 'crafting_table', count: 1 }],
      at: pos(7, 64, 4),
    })
    const home = goal.siteFor(bot, pos(0, 64, 0))
    const s = home.site
    world.set(s.x + 5, s.y, s.z + 1, 'crafting_table') // table stands
    world.set(s.x + 1, s.y - 1, s.z + 4, 'air') // the rig dip under A-foot
    const ctx = { home, step: 'build', stepStatus: 'running', buildSkip: [], buildLastProgressLog: Date.now() }
    assert.equal(build.nextCellIdx(bot, home, []), 1)
    build(bot, ctx, null, null) // approach
    build(bot, ctx, null, null) // place flight
    await settle()
    assert.equal(bot.calls.places.length, 1)
    assert.equal(world.get(s.x + 1, s.y - 1, s.z + 4), 'oak_planks')
    const ring0 = BLUEPRINT_V2.findIndex((c) => c.kind === 'planks' && c.dy === 0)
    assert.equal(build.nextCellIdx(bot, home, []), ring0, 'the patched dip was the only open floor cell')
    assert.deepEqual(ctx.buildSkip, [], 'bedroom floor never trips the doorway-interior guard')
  })

  it('a lily in the dip is dug once, then the patch lands (revmux 01)', async () => {
    // Unlisted flora refuses the patch like a wall occupier; the fill
    // branch clears anything collisionless and retries in one flight.
    const world = makeWorld()
    const bot = mockBot(world, {
      items: [{ name: 'oak_planks', count: 40 }, { name: 'crafting_table', count: 1 }],
      at: pos(7, 64, 4),
    })
    let attempts = 0
    bot.placeBlock = async (ref, face) => {
      bot.calls.places.push([ref, face])
      attempts++
      if (attempts === 1) throw new Error('refused')
      const rp = (ref && ref.position) || ref
      world.set(rp.x + face.x, rp.y + face.y, rp.z + face.z, bot.held)
    }
    const home = goal.siteFor(bot, pos(0, 64, 0))
    const s = home.site
    world.set(s.x + 5, s.y, s.z + 1, 'crafting_table') // table stands
    world.set(s.x + 1, s.y - 1, s.z + 4, 'lily_of_the_valley')
    const ctx = { home, step: 'build', stepStatus: 'running', buildSkip: [], buildLastProgressLog: Date.now() }
    assert.equal(build.nextCellIdx(bot, home, []), 1)
    build(bot, ctx, null, null) // approach
    build(bot, ctx, null, null) // refuse -> dig -> retry lands
    await settle()
    assert.deepEqual(bot.calls.digs, ['lily_of_the_valley'])
    assert.equal(world.get(s.x + 1, s.y - 1, s.z + 4), 'oak_planks')
    assert.equal(ctx.buildFails, 0)
    assert.deepEqual(ctx.buildSkip, [])
  })

  it('all five dips patch and the house completes with no skips', async () => {
    const world = makeWorld()
    const bot = mockBot(world, {
      items: [{ name: 'oak_planks', count: 40 }, { name: 'crafting_table', count: 1 }, { name: 'oak_door', count: 1 }],
      at: pos(9, 64, 4),
    })
    const home = goal.siteFor(bot, pos(0, 64, 0))
    const s = home.site
    paintHouse(world, home)
    for (const dx of [1, 2, 4, 5]) world.set(s.x + dx, s.y - 1, s.z + 4, 'air')
    world.set(s.x + 3, s.y - 1, s.z, 'air') // the doorway dip
    // The door hangs on the patched ground: unpaint it so the flow proves
    // the order (floor first, door onto the patch).
    world.set(s.x + 3, s.y, s.z, 'air')
    const ctx = { home, step: 'build', stepStatus: 'running', buildSkip: [], buildLastProgressLog: Date.now() }
    for (let i = 0; i < 40 && !home.built; i++) {
      build(bot, ctx, null, null)
      await settle(2)
    }
    assert.equal(home.built, true)
    assert.equal(ctx.stepStatus, 'done')
    assert.deepEqual(ctx.buildSkip, [])
    for (const dx of [1, 2, 4, 5]) {
      assert.equal(world.get(s.x + dx, s.y - 1, s.z + 4), 'oak_planks', `patched under ${dx},4`)
    }
    assert.equal(world.get(s.x + 3, s.y - 1, s.z), 'oak_planks', 'patched under the door')
    assert.equal(world.get(s.x + 3, s.y, s.z), 'oak_door', 'door lands on the patch')
  })
})

describe('1c4 budget and menu cover the floor', () => {
  it('menu counts a dip patch like a wall plank', () => {
    const world = makeWorld()
    const bot = mockBot(world)
    const home = goal.siteFor(bot, pos(0, 64, 0))
    const s = home.site
    paintHouse(world, home)
    world.set(s.x + 1, s.y - 1, s.z + 4, 'air') // one dip left
    const ctx = { home, buildSkip: [] }
    assert.equal(goal.MENU.build.feasible({ planks: 0 }, bot, ctx), false, 'no loose plank: gather/craft first')
    assert.equal(goal.MENU.build.feasible({ planks: 1 }, bot, ctx), true, 'one plank covers the patch')
  })

  it('gather runs until the floor is covered: 106 gathers, 107 rests the axe', () => {
    const bot = mockBot(makeWorld())
    const v2 = { home: goal.siteFor(bot, pos(0, 64, 0)) }
    assert.equal(goal.MENU.gather.feasible({ logs: 0, planks: 106, table: 1, door: 1, home: 'site' }, bot, v2), true)
    assert.equal(goal.MENU.gather.feasible({ logs: 0, planks: 107, table: 1, door: 1, home: 'site' }, bot, v2), false)
  })
})

describe('1c4 adopt sees the floor', () => {
  it('dirt ground reads built, a dip reads unbuilt until patched', () => {
    const world = makeWorld()
    const site = { x: 10, y: 64, z: 10 }
    const bot = mockBot(world, { doors: [{ x: 13, y: 64, z: 10 }] })
    // Paint the shell only: the floor stays natural dirt (the common case).
    for (const cell of BLUEPRINT_V2) {
      if (cell.kind === 'fill') continue
      const name = cell.kind === 'table' ? 'crafting_table' : cell.kind === 'door' ? 'oak_door' : 'oak_planks'
      world.set(site.x + cell.dx, site.y + cell.dy, site.z + cell.dz, name)
    }
    const home = goal.adoptHome(bot)
    assert.ok(home)
    assert.equal(home.v, 2)
    assert.equal(home.built, true, 'dirt under the beds is a floor')
    world.set(site.x + 1, site.y - 1, site.z + 4, 'air') // the dip opens
    const dipped = goal.adoptHome(bot)
    assert.ok(dipped)
    assert.equal(dipped.built, false, 'the dip reopens the repair plan')
    assert.equal(build.nextCellIdx(bot, dipped, []), 1, 'repair starts at the floor')
    world.set(site.x + 1, site.y - 1, site.z + 4, 'oak_planks') // patched
    assert.equal(goal.adoptHome(bot).built, true)
  })

  it('dirt floor adds no quorum: a foreign door with a table and two columns rejects (revmux 01)', () => {
    // Door + table + 4 corner planks = 6 kind matches; the always-done
    // dirt floor must not spend 5 more quorum points on mere terrain.
    const world = makeWorld()
    const site = { x: 10, y: 64, z: 10 }
    world.set(13, 64, 10, 'oak_door')
    world.set(13, 65, 10, 'oak_door')
    world.set(site.x + 5, site.y, site.z + 1, 'crafting_table')
    for (const [cx, cz] of [[0, 0], [6, 5]]) {
      world.set(site.x + cx, site.y, site.z + cz, 'oak_planks')
      world.set(site.x + cx, site.y + 1, site.z + cz, 'oak_planks')
    }
    const bot = mockBot(world, { doors: [{ x: 13, y: 64, z: 10 }] })
    assert.equal(goal.adoptHome(bot), null)
    assert.deepEqual(bot.chats, [])
  })
})
