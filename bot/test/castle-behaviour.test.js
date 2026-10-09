'use strict'

// idkcraft-g0z.2: the castle executor lays the src/castle.js plan from the
// world, blocks (never skips) refusing cells with backoff and a layer gate,
// protects laid castle blocks for every executor, and builds the slice
// tower to completion on a fake world.

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const blueprint = require('../src/castle')
const castle = require('../src/behaviours/castle')
const { protectedReason } = require('../src/behaviours/util')
const { BEHAVIOURS } = require('../src/index')

const SITE = { x: 100, y: 64, z: 200 }
const EMPTY = new Set(['air', 'torch', 'wall_torch'])

function makeWorld() {
  const cells = new Map()
  const key = (x, y, z) => `${Math.floor(x)},${Math.floor(y)},${Math.floor(z)}`
  return {
    set(x, y, z, name) { cells.set(key(x, y, z), name) },
    get(x, y, z) { return this.blockAt({ x, y, z }).name },
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
  { name: 'cobblestone', count: 64 }, { name: 'oak_planks', count: 64 },
  { name: 'oak_door', count: 1 }, { name: 'torch', count: 8 },
]

function mockBot(world, { items = KIT, refuse = () => false } = {}) {
  const calls = { goals: [], places: [], digs: [] }
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
      // Teleport-arrival in reach, never in the target: place goals stand
      // two above it, dig goals (GoalNear) two beside it.
      setGoal: (g) => {
        calls.goals.push(g)
        if (g && g.pos) bot.entity.position = { x: g.pos.x + 0.5, y: g.pos.y + 2, z: g.pos.z + 0.5 }
        else if (g && g.constructor.name === 'GoalBlock') bot.entity.position = { x: g.x + 0.5, y: g.y, z: g.z + 0.5 }
        else if (g && typeof g.x === 'number') bot.entity.position = { x: g.x + 2.5, y: g.y, z: g.z + 0.5 }
      },
    },
    equip: async (item) => { bot.held = item.name },
    dig: async (b) => {
      calls.digs.push(b.position)
      world.set(b.position.x, b.position.y, b.position.z, 'air')
    },
    placeBlock: async (ref, face) => {
      const p = { x: ref.position.x + face.x, y: ref.position.y + face.y, z: ref.position.z + face.z }
      if (refuse(p)) throw new Error('refused')
      calls.places.push(p)
      world.set(p.x, p.y, p.z, bot.held)
    },
    chat: (m) => bot.chats.push(String(m)),
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

function cells() { return blueprint.absPlan(SITE, 0).cells }
function paint(world, upto) {
  for (const c of cells()) {
    if (c.idx >= upto || !blueprint.isPlaceTarget(c.kind)) continue
    world.set(c.x, c.y, c.z, { stone: 'cobblestone', planks: 'oak_planks', door: 'oak_door', torch: 'torch' }[c.kind])
  }
}

describe('g0z.2 castle executor', () => {
  it('is registered in BEHAVIOURS', () => {
    assert.equal(BEHAVIOURS.castle, castle)
  })

  it('lays the first ground ring in plan order', async () => {
    const world = makeWorld()
    const bot = mockBot(world)
    const ctx = { castle: { site: SITE, rot: 0 } }
    // The door is deferred (revmux 01): the doorway stays open for A*.
    const ring = cells().filter((c) => c.dy === 0 && blueprint.isPlaceTarget(c.kind) && c.kind !== 'door').slice(0, 15)
    await run(bot, ctx, 80)
    const laid = bot.calls.places.slice(0, 15).map((p) => `${p.x},${p.y},${p.z}`)
    assert.deepEqual(laid, ring.map((c) => `${c.x},${c.y},${c.z}`))
    assert.equal(world.get(ring[0].x, 64, ring[0].z), 'cobblestone')
    const door = cells().find((c) => c.kind === 'door')
    assert.equal(world.get(door.x, door.y, door.z), 'air')
  })

  it('lays the door last, from the entrance apron outside', async () => {
    const world = makeWorld()
    const bot = mockBot(world)
    const plan = cells()
    const door = plan.find((c) => c.kind === 'door')
    paint(world, plan.length)
    world.set(door.x, door.y, door.z, 'air')
    const ctx = { castle: { site: SITE, rot: 0 } }
    await run(bot, ctx, 4)
    const g = bot.calls.goals[0]
    const e = blueprint.ENTRANCE
    assert.deepEqual([g.x, g.y, g.z], [SITE.x + e.dx, SITE.y + e.dy, SITE.z + e.dz])
    assert.equal(world.get(door.x, door.y, door.z), 'oak_door')
    assert.equal(ctx.stepStatus, 'done')
  })

  it('never places the door from inside: off the apron re-walks, then blocks', async () => {
    const world = makeWorld()
    const bot = mockBot(world)
    const plan = cells()
    const door = plan.find((c) => c.kind === 'door')
    paint(world, plan.length)
    world.set(door.x, door.y, door.z, 'air')
    bot.pathfinder.setGoal = (g) => { bot.calls.goals.push(g) } // the walk never lands
    bot.entity.position = { x: SITE.x + 5.5, y: SITE.y, z: SITE.z + 5.5 } // ground floor, in reach
    const ctx = { castle: { site: SITE, rot: 0 } }
    await run(bot, ctx, 8)
    assert.equal(world.get(door.x, door.y, door.z), 'air')
    assert.ok(bot.calls.goals.length >= 3, 're-issues the apron walk')
    assert.equal(ctx.castle.blocked[`${1}:${door.idx}`].why, 'off-apron')
  })

  it('a sunken apron floor (soul sand, feet ~0.125 low) still counts as on the apron', async () => {
    const world = makeWorld()
    const bot = mockBot(world)
    const plan = cells()
    const door = plan.find((c) => c.kind === 'door')
    paint(world, plan.length)
    world.set(door.x, door.y, door.z, 'air')
    const set = bot.pathfinder.setGoal
    bot.pathfinder.setGoal = (g) => { set(g); bot.entity.position.y -= 0.125 }
    const ctx = { castle: { site: SITE, rot: 0 } }
    await run(bot, ctx, 4)
    assert.equal(world.get(door.x, door.y, door.z), 'oak_door')
  })

  it('digs a wrong natural occupant out of a place cell, then lays it', async () => {
    const world = makeWorld()
    const bot = mockBot(world)
    const c = cells()[0]
    world.set(c.x, c.y, c.z, 'grass_block')
    const ctx = { castle: { site: SITE, rot: 0 } }
    await run(bot, ctx, 6)
    assert.deepEqual(bot.calls.digs[0], { x: c.x, y: c.y, z: c.z })
    assert.equal(world.get(c.x, c.y, c.z), 'cobblestone')
  })

  it('g0z.22: a place cell holding leaf_litter (1.21.5+ flora) is dug, not kept', async () => {
    const world = makeWorld()
    const bot = mockBot(world)
    const c = cells()[0]
    world.set(c.x, c.y, c.z, 'leaf_litter')
    const ctx = { castle: { site: SITE, rot: 0 } }
    await run(bot, ctx, 6)
    assert.deepEqual(bot.calls.digs[0], { x: c.x, y: c.y, z: c.z })
    assert.equal(world.get(c.x, c.y, c.z), 'cobblestone')
    assert.deepEqual(ctx.castle.blocked, {})
  })

  it('g0z.22: an unreadable (unloaded) cell is approached, never kept-null', async () => {
    const world = makeWorld()
    const plan = cells()
    paint(world, plan.length)
    const win = plan.find((c) => c.kind === 'air' && c.dy === 4)
    const bot = mockBot(world)
    const raw = bot.blockAt
    bot.blockAt = (p) => (Math.floor(p.x) === win.x && Math.floor(p.y) === win.y && Math.floor(p.z) === win.z ? null : raw(p))
    const ctx = { castle: { site: SITE, rot: 0, phase: 'body' } }
    await run(bot, ctx, 2)
    assert.deepEqual(ctx.castle.blocked, {}, 'no instant block: the bot walks there first')
    assert.equal(bot.calls.goals[0].constructor.name, 'GoalNear', 'an approach goal is issued')
    await run(bot, ctx, 4)
    const e = ctx.castle.blocked[`1:${win.idx}`]
    assert.ok(!e || e.why !== 'kept-null', 'never kept-null')
  })

  it('our own scaffold in a place cell is dug like terrain', async () => {
    const world = makeWorld()
    const bot = mockBot(world)
    const c = cells()[0]
    world.set(c.x, c.y, c.z, 'oak_planks') // wrong kind, but ours
    const ctx = { castle: { site: SITE, rot: 0 }, placedByBot: new Set([`${c.x},${c.y},${c.z}`]) }
    await run(bot, ctx, 6)
    assert.deepEqual(bot.calls.digs[0], { x: c.x, y: c.y, z: c.z })
    assert.equal(world.get(c.x, c.y, c.z), 'cobblestone')
    // After a restart (no placedByBot) a cobblestone scaffold in a landing
    // cell still clears: it is the Movements scaffold item.
    const land = cells().find((x) => x.kind === 'planks')
    world.set(land.x, land.y, land.z, 'cobblestone')
    paint(world, land.idx)
    const ctx2 = { castle: { site: SITE, rot: 0 } }
    await run(bot, ctx2, 6)
    assert.equal(world.get(land.x, land.y, land.z), 'oak_planks')
  })

  it('standing on our own dig target steps aside (bot.players lists the bot too)', async () => {
    const world = makeWorld()
    const bot = mockBot(world)
    const c = cells()[0]
    world.set(c.x, c.y, c.z, 'dirt')
    bot.players = { Me: { entity: bot.entity } }
    bot.pathfinder.setGoal = (g) => {
      bot.calls.goals.push(g)
      // The approach parks ON the dig target; the sidestep moves off it.
      if (g && typeof g.x === 'number' && bot.calls.goals.length === 1) bot.entity.position = { x: c.x + 0.5, y: c.y + 1, z: c.z + 0.5 }
      else if (g && typeof g.x === 'number') bot.entity.position = { x: c.x + 2.5, y: c.y, z: c.z + 0.5 }
    }
    const ctx = { castle: { site: SITE, rot: 0 } }
    await run(bot, ctx, 4)
    assert.deepEqual(ctx.castle.blocked, {})
    assert.deepEqual(bot.calls.digs[0], { x: c.x, y: c.y, z: c.z })
  })

  it('scaffold in the doorway clears from the apron, then the door lands', async () => {
    const world = makeWorld()
    const bot = mockBot(world)
    const plan = cells()
    const door = plan.find((c) => c.kind === 'door')
    paint(world, plan.length)
    world.set(door.x, door.y, door.z, 'cobblestone')
    const ctx = { castle: { site: SITE, rot: 0 } }
    await run(bot, ctx, 6)
    const e = blueprint.ENTRANCE
    assert.equal(bot.calls.goals[0].constructor.name, 'GoalBlock')
    assert.deepEqual([bot.calls.goals[0].x, bot.calls.goals[0].z], [SITE.x + e.dx, SITE.z + e.dz])
    assert.equal(world.get(door.x, door.y, door.z), 'oak_door')
  })

  it('a trap-denied dig steps to another stance instead of striking in place', async () => {
    const world = makeWorld()
    const bot = mockBot(world)
    const c = cells()[0]
    world.set(c.x, c.y, c.z, 'dirt')
    // Walled pit one above, diagonal to the target: below-feet refuses.
    const fx = c.x + 1
    const fz = c.z + 1
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) world.set(fx + dx, c.y + 1, fz + dz, 'stone')
    bot.pathfinder.setGoal = (g) => {
      bot.calls.goals.push(g)
      if (bot.calls.goals.length === 1) bot.entity.position = { x: fx + 0.5, y: c.y + 1, z: fz + 0.5 }
      else bot.entity.position = { x: c.x - 1.5, y: c.y, z: c.z + 0.5 } // the sidestep lands on open ground
    }
    const ctx = { castle: { site: SITE, rot: 0 } }
    await run(bot, ctx, 4)
    assert.equal(bot.calls.goals[1].constructor.name, 'GoalBlock', 'sidestep issued')
    assert.deepEqual(bot.calls.digs[0], { x: c.x, y: c.y, z: c.z })
    assert.deepEqual(ctx.castle.blocked, {})
  })

  it('a kept occupant (ender chest: vmzq.40 never digs it) is blocked, never dug', async () => {
    const world = makeWorld()
    const bot = mockBot(world)
    const c = cells()[0]
    world.set(c.x, c.y, c.z, 'ender_chest')
    const ctx = { castle: { site: SITE, rot: 0 } }
    await run(bot, ctx, 2)
    assert.equal(bot.calls.digs.length, 0)
    assert.equal(ctx.castle.blocked[`${1}:0`].why, 'kept-ender_chest')
  })

  it('g0z.13 + vmzq.40: a moat cell holding ore/tuff/planks is dug; a bed in a place cell stays kept', async () => {
    const v2 = blueprint.absPlan(SITE, 0, 2).cells
    const NAME = { stone: 'cobblestone', planks: 'oak_planks', frame: 'oak_log', chest: 'chest', torch: 'torch', door: 'oak_door', fence: 'oak_fence' }
    const moat = v2.find((c) => c.kind === 'dig' && c.dy === -1)
    for (const ore of ['coal_ore', 'deepslate_copper_ore', 'iron_ore', 'tuff', 'oak_planks']) {
      const world = makeWorld()
      for (const c of v2) world.set(c.x, c.y, c.z, NAME[c.kind] || 'air')
      world.set(moat.x, moat.y, moat.z, ore)
      const bot = mockBot(world)
      const ctx = { castle: { site: SITE, rot: 0, blueprintVersion: 2, phase: 'body' } }
      await run(bot, ctx, 6)
      assert.equal(world.get(moat.x, moat.y, moat.z), 'air', ore)
      assert.deepEqual(ctx.castle.blocked, {}, ore)
      assert.equal(ctx.stepStatus, 'done', ore)
    }
    // Beds are never dug (vmzq.40 keeps them out of the footprint rule).
    const world = makeWorld()
    const c = cells()[0]
    world.set(c.x, c.y, c.z, 'red_bed')
    const bot = mockBot(world)
    const ctx = { castle: { site: SITE, rot: 0 } }
    await run(bot, ctx, 2)
    assert.equal(bot.calls.digs.length, 0)
    assert.equal(ctx.castle.blocked['1:0'].why, 'kept-red_bed')
  })

  // vmzq.53 (prod 35,64,11; 19..21,64,11): the body stands on the last
  // moat cell, the dug row around it. The pathfinder mock only lands on a
  // standable GoalBlock (feet + head air, solid floor), like A* would.
  function moatStance() {
    const v2 = blueprint.absPlan(SITE, 0, 2)
    const NAME = { stone: 'cobblestone', planks: 'oak_planks', frame: 'oak_log', chest: 'chest', torch: 'torch', door: 'oak_door', fence: 'oak_fence' }
    const m = v2.cells.find((c) => c.kind === 'dig' && c.dy === -1 && ['1,0', '-1,0', '0,1'].every((d) => {
      const [dx, dz] = d.split(',').map(Number)
      return (v2.at.get(`${c.x + dx},${c.y},${c.z + dz}`) || {}).kind === 'dig'
    }))
    const world = makeWorld()
    for (const c of v2.cells) world.set(c.x, c.y, c.z, NAME[c.kind] || 'air')
    world.set(m.x, m.y, m.z, 'dirt')
    world.set(m.x, m.y + 1, m.z - 1, 'stone') // the fourth blind step is walled
    const bot = mockBot(world)
    const air = (x, y, z) => EMPTY.has(world.get(x, y, z))
    bot.pathfinder.setGoal = (g) => {
      bot.calls.goals.push(g)
      if (g.constructor.name !== 'GoalBlock') bot.entity.position = { x: m.x + 0.5, y: m.y + 1, z: m.z + 0.5 } // parks on the cell
      else if (air(g.x, g.y, g.z) && air(g.x, g.y + 1, g.z) && !air(g.x, g.y - 1, g.z)) bot.entity.position = { x: g.x + 0.5, y: g.y, z: g.z + 0.5 }
    }
    const ctx = { castle: { site: SITE, rot: 0, blueprintVersion: 2, phase: 'body' } }
    return { m, world, bot, ctx }
  }

  it('vmzq.53: standing on a moat dig cell, the dug row around it, steps to a standable stance and digs it', async () => {
    const { m, world, bot, ctx } = moatStance()
    await run(bot, ctx, 12)
    assert.equal(world.get(m.x, m.y, m.z), 'air', 'the moat cell is dug')
    assert.deepEqual(ctx.castle.blocked, {}, 'never struck')
    const s = bot.calls.goals.find((g) => g.constructor.name === 'GoalBlock')
    assert.ok(s && !(s.x === m.x && s.z === m.z), 'the sidestep leaves the column')
  })

  it('vmzq.53: a body that cannot leave the cell blocks it as self-stance, logged with its position', async () => {
    const { m, bot, ctx } = moatStance()
    bot.pathfinder.setGoal = (g) => { bot.calls.goals.push(g); bot.entity.position = { x: m.x + 0.5, y: m.y + 1, z: m.z + 0.5 } }
    const logs = []
    const log = console.log
    console.log = (s) => logs.push(String(s))
    try { await run(bot, ctx, 12) } finally { console.log = log }
    assert.equal(ctx.castle.blocked[`2:${m.idx}`].why, 'self-stance')
    assert.equal(ctx.castleSelfOcc, null, 'the retry after the backoff gets fresh stances')
    assert.ok(logs.some((l) => l === `castle self-stance at ${m.x} ${m.y} ${m.z}: body ${m.x + 0.5} ${m.y + 1}.0 ${m.z + 0.5}`), logs.join('\n'))
  })

  it('vmzq.53: the normal dig path (body beside the cell) digs without a sidestep', async () => {
    const { m, world, bot, ctx } = moatStance()
    bot.pathfinder.setGoal = (g) => { bot.calls.goals.push(g); bot.entity.position = { x: m.x + 0.5, y: m.y + 2, z: m.z - 1.5 } }
    await run(bot, ctx, 6)
    assert.equal(world.get(m.x, m.y, m.z), 'air')
    assert.deepEqual(ctx.castle.blocked, {})
    assert.ok(bot.calls.goals.every((g) => g.constructor.name !== 'GoalBlock'), 'no sidestep goal')
    assert.equal(ctx.castleSelfOcc, undefined)
  })

  it('g0z.14: own scaffold off the plan inside the site clears before complete; plan cells untouched', async () => {
    const world = makeWorld()
    const plan = cells()
    paint(world, plan.length)
    const at = blueprint.absPlan(SITE, 0).at
    const { w, d } = blueprint.siteDimensions(0)
    let spot = null
    for (let dx = 1; dx < w - 1 && !spot; dx++) {
      for (let dz = 1; dz < d - 1 && !spot; dz++) {
        const x = SITE.x + dx, z = SITE.z + dz
        if (!at.has(`${x},${SITE.y},${z}`) && !at.has(`${x},${SITE.y + 1},${z}`)) spot = { x, z }
      }
    }
    assert.ok(spot, 'an off-plan interior column')
    world.set(spot.x, SITE.y, spot.z, 'cobblestone')
    world.set(spot.x, SITE.y + 1, spot.z, 'dirt')
    const bot = mockBot(world)
    const ctx = { castle: { site: SITE, rot: 0, phase: 'body' }, placedByBot: new Set([`${spot.x},${SITE.y + 1},${spot.z}`]) }
    await run(bot, ctx, 12)
    assert.equal(world.get(spot.x, SITE.y, spot.z), 'air')
    assert.equal(world.get(spot.x, SITE.y + 1, spot.z), 'air')
    assert.equal(ctx.castle.phase, 'complete')
    assert.equal(bot.calls.digs.length, 2)
    for (const c of plan) if (blueprint.isPlaceTarget(c.kind)) assert.ok(blueprint.matches(c.kind, world.get(c.x, c.y, c.z)), `${c.kind} at ${c.x},${c.y},${c.z}`)
    // After complete the owner's cobblestone inside is kept.
    world.set(spot.x, SITE.y, spot.z, 'cobblestone')
    ctx.castleScanAt = 0
    ctx.castleLitter = null
    await run(bot, ctx, 4)
    assert.equal(world.get(spot.x, SITE.y, spot.z), 'cobblestone')
  })

  it('g0z.14: a refusing litter block is skipped (blocked) and the castle completes', async () => {
    const world = makeWorld()
    paint(world, cells().length)
    const at = blueprint.absPlan(SITE, 0).at
    const x = SITE.x + 1
    let z = SITE.z + 1
    while (at.has(`${x},${SITE.y},${z}`)) z++
    world.set(x, SITE.y, z, 'cobblestone')
    const bot = mockBot(world)
    bot.dig = async () => { throw new Error('refused') }
    const ctx = { castle: { site: SITE, rot: 0, phase: 'body' } }
    await run(bot, ctx, 20)
    assert.equal(ctx.castle.phase, 'complete')
    assert.equal(world.get(x, SITE.y, z), 'cobblestone')
    assert.ok(Object.values(ctx.castle.blocked).some((e) => e.why === 'dig-refused'))
  })

  it('g0z.11: a v2 castle lays the full plan and keys its blocks by v2', async () => {
    const v2 = blueprint.absPlan(SITE, 0, 2).cells
    const world = makeWorld()
    const bot = mockBot(world)
    const ctx = { castle: { site: SITE, rot: 0, blueprintVersion: 2 } }
    await run(bot, ctx, 30)
    const ring = v2.filter((c) => blueprint.isPlaceTarget(c.kind)).slice(0, 5).map((c) => `${c.x},${c.y},${c.z}`)
    assert.deepEqual(bot.calls.places.slice(0, 5).map((p) => `${p.x},${p.y},${p.z}`), ring)
    const w2 = makeWorld()
    w2.set(v2[0].x, v2[0].y, v2[0].z, 'ender_chest')
    const ctx2 = { castle: { site: SITE, rot: 0, blueprintVersion: 2 } }
    await run(mockBot(w2), ctx2, 2)
    assert.equal(ctx2.castle.blocked['2:0'].why, 'kept-ender_chest')
  })

  it('g0z.6 + vmzq.27: v2 moat digs past a blocked hole; deck first, bridge columns last, fence after the moat, spoil picked up', async () => {
    const v2 = blueprint.absPlan(SITE, 0, 2).cells
    const world = makeWorld()
    const NAME = { stone: 'cobblestone', planks: 'oak_planks', frame: 'oak_log', chest: 'chest', torch: 'torch' }
    const held = v2.find((c) => c.kind === 'planks' && c.dy === 11) // a roof cap cell: the gate above it is empty
    for (const c of v2) if (c !== held && c.dy >= 0 && NAME[c.kind]) world.set(c.x, c.y, c.z, NAME[c.kind])
    const bot = mockBot(world, { items: [...KIT, { name: 'oak_fence', count: 200 }] })
    const log = []
    const dig0 = bot.dig
    bot.dig = async (b) => { log.push({ op: 'dig', p: b.position, above: world.get(b.position.x, b.position.y + 1, b.position.z) }); return dig0(b) }
    const place0 = bot.placeBlock
    bot.placeBlock = async (ref, face) => { await place0(ref, face); log.push({ op: 'place', p: bot.calls.places[bot.calls.places.length - 1], what: bot.held }) }
    const k = (p) => `${p.x},${p.y},${p.z}`
    const moat = new Set(v2.filter((c) => c.kind === 'dig').map(k))
    const deck = v2.filter((c) => c.kind === 'planks' && c.dy === -1)
    const fence = v2.filter((c) => c.kind === 'fence')
    const ctx = { castle: { site: SITE, rot: 0, blueprintVersion: 2, blocked: { [`2:${held.idx}`]: { tries: 1, until: Date.now() + 3600000 } } } }

    // Interior work left (a blocked roof cell): the moat digs past the
    // hole (vmzq.27 revmux 01 — holes never feed `inside`), deck and fence
    // go in, the hole stays reported.
    await run(bot, ctx, 1600)
    for (const c of moat) { const [x, y, z] = c.split(',').map(Number); assert.equal(world.get(x, y, z), 'air', `moat ${c} dug past the hole`) }
    for (const c of deck) assert.equal(world.get(c.x, c.y, c.z), 'oak_planks', 'deck laid (ground dug, then placed)')
    for (const c of fence) assert.equal(world.get(c.x, c.y, c.z), 'oak_fence')
    assert.equal(bot.chats.length, 1, `chats: ${JSON.stringify(bot.chats)}`)
    assert.ok(bot.chats[0].includes(`${held.x} ${held.y} ${held.z}`), 'the hole is listed')
    assert.equal(ctx.stepStatus, 'failed:blocked', 'the live hole still waits')
    assert.equal(castle.menuFact(bot, ctx), 'blocked', 'peek agrees while the hole is live')
    // Moat order, read off phase 1 (the moat digs here now): bridge
    // columns last and under the laid deck, fence ring after the moat,
    // every dig walks onto its drop.
    const digs = log.filter((e) => e.op === 'dig' && moat.has(k(e.p)))
    assert.equal(digs.length, moat.size)
    const cols = digs.slice(-deck.length)
    for (const e of cols) {
      assert.ok(deck.some((c) => c.x === e.p.x && c.z === e.p.z), `${k(e.p)} is a bridge column`)
      assert.equal(e.above, 'oak_planks', 'the deck stands while its column is dug')
    }
    const fences = log.map((e, i) => ({ ...e, i })).filter((e) => e.op === 'place' && e.what === 'oak_fence')
    assert.equal(fences.length, fence.length)
    const lastDig = log.findLastIndex((e) => e.op === 'dig' && moat.has(k(e.p)))
    assert.ok(fences[0].i > lastDig, 'fence ring after the moat')
    const near1 = new Set(bot.calls.goals.filter((g) => g && g.constructor.name === 'GoalNear' && g.rangeSq === 1).map(k))
    const isCol = (e) => deck.some((c) => c.x === e.p.x && c.z === e.p.z)
    assert.ok(digs.every((e) => isCol(e) !== near1.has(k(e.p))), 'every moat dig but a bridge column walks onto its drop')
    assert.ok(deck.every((c) => !near1.has(k(c))), 'no pickup walk into a deck cell')

    // The interior completes: the held cell lands, the knocked-down fence
    // ring re-lays, the castle finishes.
    world.set(held.x, held.y, held.z, 'oak_planks')
    for (const c of fence) world.set(c.x, c.y, c.z, 'air') // fence ring knocked down: it re-lays
    const before = log.length
    for (let i = 0; i < 3000 && ctx.stepStatus !== 'done'; i++) await run(bot, ctx, 1)
    assert.equal(ctx.stepStatus, 'done')
    for (const c of moat) { const [x, y, z] = c.split(',').map(Number); assert.equal(world.get(x, y, z), 'air', `moat ${c} stays dug`) }
    const refences = log.slice(before).filter((e) => e.op === 'place' && e.what === 'oak_fence')
    assert.equal(refences.length, fence.length)
  })

  it('vmzq.27 revmux 01: a retired hole plus the moat ends in phase complete, holes still reported', async () => {
    const v2 = blueprint.absPlan(SITE, 0, 2).cells
    const world = makeWorld()
    const NAME = { stone: 'cobblestone', planks: 'oak_planks', frame: 'oak_log', chest: 'chest', torch: 'torch' }
    const held = v2.find((c) => c.kind === 'planks' && c.dy === 11)
    for (const c of v2) if (c !== held && c.dy >= 0 && NAME[c.kind]) world.set(c.x, c.y, c.z, NAME[c.kind])
    const bot = mockBot(world, { items: [...KIT, { name: 'oak_fence', count: 200 }] })
    const place0 = bot.placeBlock
    bot.placeBlock = async (ref, face) => {
      const p = { x: ref.position.x + face.x, y: ref.position.y + face.y, z: ref.position.z + face.z }
      if (p.x === held.x && p.y === held.y && p.z === held.z) throw new Error('refused')
      return place0(ref, face)
    }
    const moat = new Set(v2.filter((c) => c.kind === 'dig').map((c) => `${c.x},${c.y},${c.z}`))
    const ctx = { castle: { site: SITE, rot: 0, blueprintVersion: 2, blocked: { [`2:${held.idx}`]: { tries: castle.MAX_HOLE_TRIES - 1, until: 0, why: 'air' } } } }
    // The next block retires the hole (tries hit MAX): it re-chats once
    // with the retired marker, then never waits again.
    await run(bot, ctx, 30)
    const e = ctx.castle.blocked[`2:${held.idx}`]
    assert.ok(e && e.retired && e.tries === castle.MAX_HOLE_TRIES, `entry: ${JSON.stringify(e)}`)
    assert.equal(bot.chats.length, 2, `chats: ${JSON.stringify(bot.chats)}`)
    assert.match(bot.chats[1], new RegExp(`^castle: 1 hole at ${held.x} ${held.y} ${held.z} \\(planks: air, retired\\), no retries left$`))
    // The moat, deck, door and fence all finish past it; the castle
    // completes with the hole still listed on the status.
    for (let i = 0; i < 3000 && ctx.stepStatus !== 'done'; i++) await run(bot, ctx, 1)
    assert.equal(ctx.stepStatus, 'done')
    assert.equal(ctx.castle.phase, 'complete')
    assert.ok(bot.chats.some((m) => m.startsWith('castle done at')), `chats: ${JSON.stringify(bot.chats.slice(-3))}`)
    for (const c of moat) { const [x, y, z] = c.split(',').map(Number); assert.equal(world.get(x, y, z), 'air', `moat ${c}`) }
    assert.equal(world.get(held.x, held.y, held.z), 'air', 'the retired hole stays open')
    assert.match(ctx.castle.status, new RegExp(`^holes: ${held.x} ${held.y} ${held.z} \\(planks: air, retired\\)$`))
  })

  it('an unreachable cell blocks after three stands that get no closer', async () => {
    const world = makeWorld()
    const bot = mockBot(world)
    bot.pathfinder.setGoal = (g) => { bot.calls.goals.push(g) } // never arrives
    bot.entity.position = { x: SITE.x - 15, y: 64, z: SITE.z - 15 } // inside SITE_WALK_DIST: past it the XZ far walk runs (vmzq.29)
    const ctx = { castle: { site: SITE, rot: 0 } }
    await run(bot, ctx, 5)
    assert.equal(ctx.castle.blocked[`${1}:0`], undefined, 'approach ticks never strike')
    await run(bot, ctx, 5)
    assert.equal(ctx.castle.blocked[`${1}:0`].why, 'unreachable')
    assert.equal(bot.calls.places.length, 0)
  })

  it('standing in the target steps aside, then blocks past SELF_OCC_LIMIT', async () => {
    const world = makeWorld()
    const bot = mockBot(world)
    const c = cells()[0]
    bot.pathfinder.setGoal = (g) => { bot.calls.goals.push(g) }
    bot.entity.position = { x: c.x + 0.5, y: c.y, z: c.z + 0.5 }
    const ctx = { castle: { site: SITE, rot: 0 } }
    await run(bot, ctx, 12)
    assert.ok(bot.calls.goals.length >= 3, 'sidestep goals issued')
    assert.equal(ctx.castle.blocked[`${1}:0`].why, 'self-stance')
    assert.ok(!bot.calls.places.some((p) => p.x === c.x && p.y === c.y && p.z === c.z), 'never placed into its own body')
  })

  it('a hung place flight is released after FLIGHT_TIMEOUT_MS and strikes', async () => {
    const world = makeWorld()
    const bot = mockBot(world)
    bot.placeBlock = () => new Promise(() => {}) // never settles
    const ctx = { castle: { site: SITE, rot: 0 } }
    await run(bot, ctx, 3)
    assert.equal(ctx.placeInFlight, true)
    ctx.castleFlight.since -= 31000
    await run(bot, ctx, 1)
    assert.equal(ctx.castleFails.n, 1)
    assert.ok(ctx.placeInFlight) // a fresh flight, not the hung one
  })

  it('re-issues the approach when a borrower replaced the goal', async () => {
    const world = makeWorld()
    const bot = mockBot(world)
    bot.pathfinder.isMoving = () => true
    bot.pathfinder.goal = null
    const set = bot.pathfinder.setGoal
    bot.pathfinder.setGoal = (g) => { bot.pathfinder.goal = g; set(g) }
    const ctx = { castle: { site: SITE, rot: 0 } }
    await run(bot, ctx, 2)
    assert.equal(bot.calls.goals.length, 1)
    bot.pathfinder.goal = { borrowed: true } // fight took the body for a tick
    await run(bot, ctx, 1)
    assert.equal(bot.calls.goals.length, 2)
  })

  it('a missing material reports failed:no-stone without walking', async () => {
    const world = makeWorld()
    const bot = mockBot(world, { items: [{ name: 'oak_planks', count: 64 }] })
    const ctx = { castle: { site: SITE, rot: 0 } }
    await run(bot, ctx, 3)
    assert.equal(ctx.stepStatus, 'failed:no-stone')
    assert.equal(bot.calls.goals.length, 0)
  })

  it('a broken cell is re-laid on the periodic full rescan', async () => {
    const world = makeWorld()
    const bot = mockBot(world)
    const plan = cells()
    paint(world, plan.length)
    const ctx = { castle: { site: SITE, rot: 0 } }
    await run(bot, ctx, 2)
    assert.equal(ctx.stepStatus, 'done')
    assert.equal(ctx.castle.phase, 'complete')
    const victim = plan[3]
    world.set(victim.x, victim.y, victim.z, 'air')
    ctx.castleScanAt = Date.now() - castle.FULL_RESCAN_MS
    await run(bot, ctx, 4)
    assert.equal(world.get(victim.x, victim.y, victim.z), 'cobblestone')
    assert.ok(bot.calls.places.some((p) => p.x === victim.x && p.y === victim.y && p.z === victim.z))
  })

  it('digs a filled air cell during construction, never after complete', async () => {
    const world = makeWorld()
    const bot = mockBot(world)
    const plan = cells()
    paint(world, plan.length)
    const win = plan.find((c) => c.kind === 'air' && c.dy === 4)
    world.set(win.x, win.y, win.z, 'dirt')
    const ctx = { castle: { site: SITE, rot: 0, phase: 'body' } }
    await run(bot, ctx, 4)
    assert.equal(world.get(win.x, win.y, win.z), 'air')
    assert.equal(ctx.castle.phase, 'complete')
    world.set(win.x, win.y, win.z, 'dirt') // owner's block inside: kept
    ctx.castleScanAt = 0
    await run(bot, ctx, 4)
    assert.equal(world.get(win.x, win.y, win.z), 'dirt')
    assert.equal(bot.calls.digs.length, 1)
  })

  it('vmzq.27: three refusals block a cell with backoff and the build skips past it', async () => {
    const world = makeWorld()
    const plan = cells()
    const stuck = plan.find((c) => c.dy === 1)
    let refusing = true
    const bot = mockBot(world, { refuse: (p) => refusing && p.x === stuck.x && p.y === stuck.y && p.z === stuck.z })
    paint(world, stuck.idx)
    const ctx = { castle: { site: SITE, rot: 0 } }
    await run(bot, ctx, 120)
    const e = ctx.castle.blocked[`${1}:${stuck.idx}`]
    assert.ok(e && e.tries === 1 && e.until > Date.now())
    assert.ok(bot.calls.places.some((p) => p.y === SITE.y + 1), 'the rest of its layer still lays')
    assert.ok(bot.calls.places.some((p) => p.y > SITE.y + 1), 'layers above lay past the hole')
    assert.notEqual(ctx.stepStatus, 'failed:blocked', 'skipping keeps the step running')
    // Out-of-order attempts cascade: cells above the hole have no laid
    // neighbour yet and block no-ref — unlisted at try 1 (revmux 01), so
    // the seed's line stands alone until a lasting hole appears.
    assert.equal(bot.chats.length, 1, `chats: ${JSON.stringify(bot.chats)}`)
    assert.match(bot.chats[0], new RegExp(`^castle: 1 hole at ${stuck.x} ${stuck.y} ${stuck.z} \\(stone: air\\), retry in \\d+s$`))
    // Backoffs expire: every hole retries (and now lands, refs and all).
    for (const k of Object.keys(ctx.castle.blocked)) ctx.castle.blocked[k].until = 0
    refusing = false
    await run(bot, ctx, 20)
    assert.equal(world.get(stuck.x, stuck.y, stuck.z), 'cobblestone')
    assert.equal(ctx.castle.blocked[`${1}:${stuck.idx}`], undefined)
  })

  it('backoff is bounded', () => {
    assert.equal(castle.backoffMs(1), 30000)
    assert.equal(castle.backoffMs(20), 600000)
  })

  it('g0z.23 + vmzq.27: a skipped hole chats once, then stays silent until a new hole', async () => {
    const world = makeWorld()
    const plan = cells()
    const stuck = plan.find((c) => c.kind === 'stone' && c.dy === 1)
    world.set(stuck.x, stuck.y, stuck.z, 'dirt')
    // A later stone cell in work order: the new hole after stuck lands.
    const next = plan.find((c) => c.kind === 'stone' && c.dy === 4)
    world.set(next.x, next.y, next.z, 'dirt')
    paint(world, stuck.idx)
    let refused = { x: stuck.x, y: stuck.y, z: stuck.z }
    const bot = mockBot(world)
    const dig0 = bot.dig
    bot.dig = async (b) => {
      if (refused && b.position.x === refused.x && b.position.y === refused.y && b.position.z === refused.z) throw new Error('refused')
      return dig0(b)
    }
    const ctx = { castle: { site: SITE, rot: 0 } }
    await run(bot, ctx, 60)
    assert.notEqual(ctx.stepStatus, 'failed:blocked', 'skipping keeps the step running')
    assert.ok(bot.calls.places.length >= 5, 'the build progressed past the refusing cell')
    assert.ok(bot.calls.places.every((p) => !(p.x === stuck.x && p.y === stuck.y && p.z === stuck.z)), 'the hole itself never lays')
    assert.equal(bot.chats.length, 1, `chats: ${JSON.stringify(bot.chats)}`)
    assert.match(bot.chats[0], new RegExp(`^castle: 1 hole at ${stuck.x} ${stuck.y} ${stuck.z} \\(stone: dig-refused\\), retry in \\d+s$`))
    await run(bot, ctx, 6)
    assert.equal(bot.chats.length, 1, 'same backoff window: no re-chat')
    // Backoff expired, still refused: the retry re-blocks silently (one
    // line through two windows, acceptance 6).
    ctx.castle.blocked[`1:${stuck.idx}`].until = 0
    await run(bot, ctx, 8)
    assert.notEqual(ctx.stepStatus, 'failed:blocked')
    assert.equal(ctx.castle.blocked[`1:${stuck.idx}`].tries, 2)
    assert.equal(bot.chats.length, 1, `chats: ${JSON.stringify(bot.chats)}`)
    // The cell lands, then a later cell blocks: a second, different line.
    ctx.castle.blocked[`1:${stuck.idx}`].until = 0
    refused = null
    await run(bot, ctx, 10)
    assert.equal(world.get(stuck.x, stuck.y, stuck.z), 'cobblestone')
    assert.equal(ctx.castleBlockedSaid, null, 'no open holes re-arms the line')
    refused = { x: next.x, y: next.y, z: next.z }
    await run(bot, ctx, 300)
    assert.ok(ctx.castle.blocked[`1:${next.idx}`], 'the later cell blocked')
    assert.equal(bot.chats.length, 2, `chats: ${JSON.stringify(bot.chats)}`)
    assert.match(bot.chats[1], new RegExp(`^castle: 1 hole at ${next.x} ${next.y} ${next.z} \\(stone: dig-refused\\), retry in \\d+s$`))
  })

  it('g0z.23 round 3 + vmzq.27: two holes share one line, re-blocking stays silent', async () => {
    const world = makeWorld()
    const plan = cells()
    const pair = plan.filter((c) => c.kind === 'stone' && c.dy === 1).slice(0, 2)
    assert.equal(pair.length, 2)
    const [a, b] = pair
    world.set(a.x, a.y, a.z, 'dirt')
    world.set(b.x, b.y, b.z, 'dirt')
    paint(world, Math.min(a.idx, b.idx))
    const bot = mockBot(world)
    const dig0 = bot.dig
    const bad = new Set([`${a.x},${a.y},${a.z}`, `${b.x},${b.y},${b.z}`])
    bot.dig = async (t) => {
      if (bad.has(`${t.position.x},${t.position.y},${t.position.z}`)) throw new Error('refused')
      return dig0(t)
    }
    const ctx = { castle: { site: SITE, rot: 0 } }
    await run(bot, ctx, 100)
    assert.notEqual(ctx.stepStatus, 'failed:blocked', 'skipping keeps the step running')
    // One line per new hole, each listing every hole so far.
    assert.equal(bot.chats.length, 2, `chats: ${JSON.stringify(bot.chats)}`)
    assert.match(bot.chats[1], /^castle: 2 holes: .*\(stone: dig-refused\), .*\(stone: dig-refused\), retry in \d+s$/)
    assert.ok(bot.chats[1].includes(`${a.x} ${a.y} ${a.z}`) && bot.chats[1].includes(`${b.x} ${b.y} ${b.z}`), 'both holes listed')
    // Both backoffs expire: both retry and re-block, still two lines.
    ctx.castle.blocked[`1:${a.idx}`].until = 0
    ctx.castle.blocked[`1:${b.idx}`].until = 0
    await run(bot, ctx, 30)
    assert.notEqual(ctx.stepStatus, 'failed:blocked')
    assert.equal(ctx.castle.blocked[`1:${a.idx}`].tries, 2)
    assert.equal(ctx.castle.blocked[`1:${b.idx}`].tries, 2)
    assert.equal(bot.chats.length, 2, `chats: ${JSON.stringify(bot.chats)}`)
  })

  it('g0z.23 round 3: resolving the latched cell re-arms the stuck line', async () => {
    const world = makeWorld()
    const plan = cells()
    const stuck = plan.find((c) => c.kind === 'stone' && c.dy === 1)
    world.set(stuck.x, stuck.y, stuck.z, 'dirt')
    paint(world, stuck.idx)
    let refused = true
    const bot = mockBot(world)
    const dig0 = bot.dig
    bot.dig = async (b) => {
      if (refused && b.position.x === stuck.x && b.position.y === stuck.y && b.position.z === stuck.z) throw new Error('refused')
      return dig0(b)
    }
    const ctx = { castle: { site: SITE, rot: 0 } }
    await run(bot, ctx, 60)
    assert.equal(bot.chats.length, 1)
    assert.ok(ctx.castleBlockedSaid)
    // Backoff expired, digs allowed: the cell lands, work moves elsewhere.
    ctx.castle.blocked[`1:${stuck.idx}`].until = 0
    refused = false
    await run(bot, ctx, 10)
    assert.equal(world.get(stuck.x, stuck.y, stuck.z), 'cobblestone')
    assert.equal(ctx.castleBlockedSaid, null, 'the resolved cell re-arms the line')
  })

  it('g0z.23 + vmzq.27: a kept occupant chats with the remove hint, then the build skips it', async () => {
    const world = makeWorld()
    const plan = cells()
    const stuck = plan.find((c) => c.kind === 'stone' && c.dy === 1)
    world.set(stuck.x, stuck.y, stuck.z, 'chest')
    paint(world, stuck.idx)
    const bot = mockBot(world)
    const ctx = { castle: { site: SITE, rot: 0 } }
    await run(bot, ctx, 60)
    assert.notEqual(ctx.stepStatus, 'failed:blocked', 'skipping keeps the step running')
    assert.equal(world.get(stuck.x, stuck.y, stuck.z), 'chest', 'the foreign block is never dug')
    // The chest is skipped as a placement ref too, so the cell stacked on
    // it holes no-ref until its sides lay — unlisted at try 1 (revmux 01),
    // while the seed itself is reported (the heal is pinned below).
    assert.equal(bot.chats.length, 1, `chats: ${JSON.stringify(bot.chats)}`)
    assert.match(bot.chats[0], new RegExp(`^castle: 1 hole at ${stuck.x} ${stuck.y} ${stuck.z} \\(stone: kept-chest\\), retry in \\d+s — remove the chest there or say castle stop$`))
  })

  it('vmzq.27: above a chest seed the cell lands via a side ref, never clicking the chest', async () => {
    // Prod shape: the rig's chest seed sits in a stone cell; the cell
    // above must not click it (the server opens the GUI instead of
    // placing, and the stuck window desyncs every later equip). The mock
    // refuses chest clicks like the server; sides are laid, so the cell
    // lands against one of them while the seed stays a reported hole.
    const world = makeWorld()
    const plan = cells()
    const stuck = plan.find((c) => c.kind === 'stone' && c.dy === 1)
    const above = plan.find((c) => c.kind === 'stone' && c.x === stuck.x && c.z === stuck.z && c.dy === stuck.dy + 1)
    assert.ok(above, 'a stone cell stacks on the seed cell')
    paint(world, plan.length)
    world.set(stuck.x, stuck.y, stuck.z, 'chest')
    world.set(above.x, above.y, above.z, 'air')
    const bot = mockBot(world)
    const place0 = bot.placeBlock
    bot.placeBlock = async (ref, face) => {
      if (ref.position.x === stuck.x && ref.position.y === stuck.y && ref.position.z === stuck.z) {
        throw new Error('Server refused: chest GUI opened')
      }
      return place0(ref, face)
    }
    const ctx = { castle: { site: SITE, rot: 0 } }
    await run(bot, ctx, 30)
    assert.equal(world.get(above.x, above.y, above.z), 'cobblestone', 'lands via a side ref')
    assert.equal(world.get(stuck.x, stuck.y, stuck.z), 'chest', 'the seed is never dug')
    assert.ok(ctx.castle.blocked[`1:${stuck.idx}`], 'the seed stays a reported hole')
    assert.equal(ctx.castle.blocked[`1:${above.idx}`], undefined, 'no hole for the landed cell')
    assert.equal(bot.chats.length, 1, `chats: ${JSON.stringify(bot.chats)}`)
  })

  it('g0z.23 round 2: a blocked keep-clear cell latches no kind; far reads blocked', () => {
    const world = makeWorld()
    const plan = cells()
    paint(world, plan.length)
    const win = plan.find((c) => c.kind === 'air')
    world.set(win.x, win.y, win.z, 'chest')
    const ctx = { castle: { site: SITE, rot: 0, blocked: { [`1:${win.idx}`]: { tries: 1, until: Date.now() + 3600000, why: 'kept-chest' } } } }
    const bot = mockBot(world, { items: [] })
    assert.equal(castle.menuFact(bot, ctx), 'blocked')
    assert.deepEqual(ctx.castleWord, { word: 'blocked' })
    assert.equal(bot.chats.length, 1, `chats: ${JSON.stringify(bot.chats)}`)
    assert.match(bot.chats[0], new RegExp(`^castle: 1 hole at ${win.x} ${win.y} ${win.z} \\(air: kept-chest\\), retry in \\d+s — remove the chest there or say castle stop$`))
    bot.blockAt = () => null // walked away: no corner reads
    assert.equal(castle.menuFact(bot, ctx), 'blocked')
  })

  it('g0z.23 follow-up: a restart during backoff keeps the why in the stuck line', () => {
    const memory = require('../src/memory')
    const fs = require('node:fs')
    const os = require('node:os')
    const path = require('node:path')
    const world = makeWorld()
    const plan = cells()
    paint(world, plan.length)
    const stuck = plan.find((c) => c.kind === 'stone' && c.dy === 1)
    world.set(stuck.x, stuck.y, stuck.z, 'air')
    // Restart: the blocked map round-trips through disk memory.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'g0z23-'))
    try {
      const file = path.join(dir, 'bot.json')
      const live = { castle: { site: SITE, rot: 0, phase: 'body', blocked: { [`1:${stuck.idx}`]: { tries: 1, until: Date.now() + 3600000, why: 'dig-refused' } } } }
      const botLike = { username: 'IdkBot', spawnPoint: { x: 0, y: 64, z: 0 } }
      memory.save(botLike, live, file, Date.now())
      const ctx = {}
      memory.restore(botLike, ctx, file, Date.now())
      const bot = mockBot(world, { items: [] })
      assert.equal(castle.menuFact(bot, ctx), 'blocked')
      assert.equal(bot.chats.length, 1, `chats: ${JSON.stringify(bot.chats)}`)
      assert.match(bot.chats[0], new RegExp(`^castle: 1 hole at ${stuck.x} ${stuck.y} ${stuck.z} \\(stone: dig-refused\\), retry in \\d+s$`))
      assert.ok(!bot.chats[0].includes('undefined'))
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('g0z.23 + vmzq.27: a far blocked castle reads its waiting kind, never blocked', () => {
    const world = makeWorld()
    const plan = cells()
    paint(world, plan.length)
    const stuck = plan.find((c) => c.kind === 'stone' && c.dy === 1)
    world.set(stuck.x, stuck.y, stuck.z, 'air')
    // Spare stone above, blocked too (skipping would otherwise work it),
    // so the remainder spans none/some/batch.
    const spare = plan.filter((c) => c.kind === 'stone' && c.dy > 1).slice(0, 10)
    assert.equal(spare.length, 10)
    for (const c of spare) world.set(c.x, c.y, c.z, 'air')
    const blocked = { [`1:${stuck.idx}`]: { tries: 1, until: Date.now() + 3600000, why: 'dig-refused' } }
    for (const c of spare) blocked[`1:${c.idx}`] = { tries: 1, until: Date.now() + 3600000, why: 'dig-refused' }
    const ctx = { castle: { site: SITE, rot: 0, blocked } }
    assert.equal(castle.menuFact(mockBot(world, { items: [] }), ctx), 'blocked')
    assert.deepEqual(ctx.castleWord, { word: 'blocked', kind: 'stone', left: 11 })
    const far = (items) => {
      const bot = mockBot(world, { items })
      bot.blockAt = () => null // walked 200 blocks away: no corner reads
      return castle.menuFact(bot, ctx)
    }
    assert.equal(far([]), 'stone-none')
    assert.equal(far([{ name: 'cobblestone', count: 25 }]), 'stone-some')
    assert.equal(far([{ name: 'cobblestone', count: 35 }]), 'stone-batch')
  })

  it('builds the whole slice tower to completion', async () => {
    const world = makeWorld()
    const bot = mockBot(world)
    const ctx = { castle: { site: SITE, rot: 1 } }
    const places = blueprint.absPlan(SITE, 1).cells.filter((c) => blueprint.isPlaceTarget(c.kind))
    await run(bot, ctx, places.length * 3 + 20)
    assert.equal(ctx.stepStatus, 'done')
    assert.deepEqual(ctx.castle.blocked, {})
    for (const c of places) assert.ok(blueprint.matches(c.kind, world.get(c.x, c.y, c.z)), `${c.kind} at ${c.x},${c.y},${c.z}`)
    const door = places.find((c) => c.kind === 'door')
    const last = bot.calls.places[bot.calls.places.length - 1]
    assert.deepEqual([last.x, last.y, last.z], [door.x, door.y, door.z], 'door laid last')
    assert.deepEqual(bot.chats, [`castle done at ${SITE.x} ${SITE.y} ${SITE.z}`])
  })
})

describe('g0z.2 castle protection', () => {
  it('laid castle blocks are protected before the placedByBot exemption', () => {
    const c = cells()[0]
    const block = { name: 'cobblestone', position: { x: c.x, y: c.y, z: c.z } }
    const ctx = { castle: { site: SITE, rot: 0 }, placedByBot: new Set([`${c.x},${c.y},${c.z}`]) }
    assert.equal(protectedReason(null, block, ctx), 'protected')
    assert.equal(protectedReason(null, block, { placedByBot: ctx.placedByBot }), null)
    // A wrong natural occupant of a castle cell stays diggable.
    assert.equal(protectedReason(null, { name: 'dirt', position: block.position }, ctx), null)
  })

  it('guardCastle vetoes pathfinder breaks of laid castle blocks', () => {
    const world = makeWorld()
    const bot = mockBot(world)
    const ctx = { castle: { site: SITE, rot: 0 } }
    castle.guardCastle(bot, ctx)
    castle.guardCastle(bot, ctx) // idempotent
    const list = bot.pathfinder.movements.exclusionAreasBreak
    assert.equal(list.length, 1)
    const c = cells()[0]
    assert.equal(list[0]({ name: 'cobblestone', position: c }), 100)
    assert.equal(list[0]({ name: 'dirt', position: c }), 0)
    assert.equal(list[0]({ name: 'dirt', position: { x: c.x, y: SITE.y - 1, z: c.z } }), 100, 'ground under the site (g0z.14)')
    ctx.castle = null
    assert.equal(list[0]({ name: 'cobblestone', position: c }), 0)
    // Scaffolding on the site costs +100 per block (stairs, not pillars).
    ctx.castle = { site: SITE, rot: 0 }
    const place = bot.pathfinder.movements.exclusionAreasPlace
    assert.equal(place.length, 1)
    assert.equal(place[0]({ position: { x: SITE.x + 5, y: SITE.y, z: SITE.z + 3 } }), 100) // doorway
    assert.equal(place[0]({ position: { x: SITE.x + 5, y: SITE.y - 1, z: SITE.z + 3 } }), 0) // terrain below
    assert.equal(place[0]({ position: { x: SITE.x - 1, y: SITE.y, z: SITE.z } }), 0) // off site
    // Movements replaced: re-installed on the new object.
    bot.pathfinder.movements = { exclusionAreasBreak: [], exclusionAreasPlace: [] }
    castle.guardCastle(bot, ctx)
    assert.equal(bot.pathfinder.movements.exclusionAreasBreak.length, 1)
    assert.equal(bot.pathfinder.movements.exclusionAreasPlace.length, 1)
  })
})
