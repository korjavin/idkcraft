'use strict'

// idkcraft-vmzq.40: the castle footprint is ours — for the castle step a
// foreign/unknown blocker in it clears (planks, a building log), a chest
// relocates outside with its contents intact; beds, doors and laid castle
// blocks stay protected, and outside the footprint default-deny stands.

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const blueprint = require('../src/castle')
const castle = require('../src/behaviours/castle')
const { protectedReason } = require('../src/behaviours/util')

const SITE = { x: 100, y: 64, z: 200 }
const EMPTY = new Set(['air', 'torch', 'wall_torch'])
const settle = async (n = 4) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)) }

function makeWorld() {
  const cells = new Map()
  const key = (x, y, z) => `${Math.floor(x)},${Math.floor(y)},${Math.floor(z)}`
  return {
    boxes: new Map(), // "x,y,z" -> [{name,type,count}]
    set(x, y, z, name) { cells.set(key(x, y, z), name) },
    get(x, y, z) { return this.blockAt({ x, y, z }).name },
    blockAt(p) {
      const fx = Math.floor(p.x), fy = Math.floor(p.y), fz = Math.floor(p.z)
      const k = key(fx, fy, fz)
      const name = cells.has(k) ? cells.get(k) : (fy <= 63 ? 'dirt' : 'air')
      return { name, boundingBox: EMPTY.has(name) ? 'empty' : 'block', position: { x: fx, y: fy, z: fz } }
    },
  }
}

// Inventory and chest windows that move whole stacks (mineflayer's
// withdraw/deposit by type), the dug box auto-picked up.
function mockBot(world, items) {
  const k = (p) => `${p.x},${p.y},${p.z}`
  const take = (from, type, count) => {
    const i = from.findIndex((s) => s.type === type && s.count >= count)
    if (i < 0) throw new Error('no such stack')
    const s = from[i]
    s.count -= count
    if (!s.count) from.splice(i, 1)
    return { name: s.name, type, count }
  }
  const bot = {
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
        if (g && g.pos) bot.entity.position = { x: g.pos.x + 0.5, y: g.pos.y + 1, z: g.pos.z + 1.5 }
        else if (g && g.constructor.name === 'GoalBlock') bot.entity.position = { x: g.x + 0.5, y: g.y, z: g.z + 0.5 }
        else if (g && typeof g.x === 'number') bot.entity.position = { x: g.x + 2.5, y: g.y, z: g.z + 0.5 }
      },
    },
    equip: async (item) => { bot.held = item.name },
    openContainer: async (b) => {
      const box = world.boxes.get(k(b.position)) || []
      world.boxes.set(k(b.position), box)
      return {
        containerItems: () => box.map((s) => ({ ...s })),
        withdraw: async (type, _m, count) => { items.push(take(box, type, count)) },
        deposit: async (type, _m, count) => { box.push(take(items, type, count)) },
        close: () => {},
      }
    },
    dig: async (b) => {
      const name = world.get(b.position.x, b.position.y, b.position.z)
      assert.ok(!(world.boxes.get(k(b.position)) || []).length, 'a box is dug only once empty')
      world.set(b.position.x, b.position.y, b.position.z, 'air')
      if (name === 'chest') items.push({ name: 'chest', type: 900, count: 1 })
    },
    placeBlock: async (ref, face) => {
      const p = { x: ref.position.x + face.x, y: ref.position.y + face.y, z: ref.position.z + face.z }
      world.set(p.x, p.y, p.z, bot.held)
      const i = items.findIndex((s) => s.name === bot.held)
      if (i >= 0 && !--items[i].count) items.splice(i, 1)
    },
    chat: (m) => bot.chats.push(String(m)),
  }
  return bot
}

async function run(bot, ctx, ticks) {
  for (let i = 0; i < ticks; i++) {
    castle(bot, ctx)
    await settle()
  }
}

describe('vmzq.40 castle footprint is ours', () => {
  const c0 = blueprint.absPlan(SITE, 0).cells[0]
  const inside = { x: c0.x, y: c0.y, z: c0.z }
  const outside = { x: SITE.x - 3, y: SITE.y, z: SITE.z - 3 }
  const st = { site: SITE, rot: 0 }

  it('planks / a lone log / a fence in the footprint are breakable for the castle step only', () => {
    for (const name of ['oak_planks', 'oak_log', 'oak_fence', 'white_wool']) {
      const block = { name, position: inside }
      assert.equal(protectedReason(null, block, { castle: st, castleClear: true }), null, name)
      assert.equal(protectedReason(null, block, { castle: st }), 'protected', `${name}: other executors`)
      assert.equal(protectedReason(null, { name, position: outside }, { castle: st, castleClear: true }), 'protected', `${name}: outside the footprint`)
    }
  })

  it('beds, doors, containers and laid castle blocks stay protected', () => {
    const ctx = { castle: st, castleClear: true }
    for (const name of ['red_bed', 'oak_door', 'chest', 'barrel', 'furnace', 'ender_chest', 'hopper']) {
      assert.equal(protectedReason(null, { name, position: inside }, ctx), 'protected', name)
    }
    // An emptied box relocates; an ender chest (obsidian drop) never.
    const emptied = { castle: st, castleClear: 'emptied' }
    assert.equal(protectedReason(null, { name: 'chest', position: inside }, emptied), null)
    assert.equal(protectedReason(null, { name: 'ender_chest', position: inside }, emptied), 'protected')
    assert.equal(protectedReason(null, { name: 'red_bed', position: inside }, emptied), 'protected')
    // c0 is a stone cell: laid cobblestone is the castle's own.
    assert.equal(protectedReason(null, { name: 'cobblestone', position: inside }, ctx), 'protected')
  })

  it('planks in a place cell are dug and the cell laid', async () => {
    const world = makeWorld()
    world.set(c0.x, c0.y, c0.z, 'oak_planks')
    const items = [{ name: 'cobblestone', type: 1, count: 64 }]
    const bot = mockBot(world, items)
    const ctx = { castle: { site: SITE, rot: 0 } }
    await run(bot, ctx, 6)
    assert.equal(world.get(c0.x, c0.y, c0.z), 'cobblestone')
    assert.deepEqual(ctx.castle.blocked, {})
  })

  it('a filled chest in a place cell moves outside the footprint with its contents intact', async () => {
    const world = makeWorld()
    world.set(c0.x, c0.y, c0.z, 'chest')
    world.boxes.set(`${c0.x},${c0.y},${c0.z}`, [{ name: 'diamond', type: 500, count: 3 }, { name: 'oak_planks', type: 600, count: 20 }])
    const items = [{ name: 'cobblestone', type: 1, count: 64 }, { name: 'oak_planks', type: 600, count: 2 }]
    const bot = mockBot(world, items)
    const ctx = { castle: { site: SITE, rot: 0 } }
    await run(bot, ctx, 3)
    // Carried: the chest's planks are not castle material while carried.
    assert.ok(ctx.castleCarry, 'carrying the contents')
    assert.equal(castle.findItem(bot, 'planks', ctx), null, 'carried planks are reserved')
    await run(bot, ctx, 8)
    assert.equal(ctx.castleCarry, null, 'stowed')
    const moved = [...world.boxes.entries()].find(([, box]) => box.length)
    assert.ok(moved, 'contents in a box')
    const [x, y, z] = moved[0].split(',').map(Number)
    assert.equal(world.get(x, y, z), 'chest')
    assert.equal(blueprint.inFootprint(ctx.castle, { x, y, z }), false, 'outside the footprint')
    const got = Object.fromEntries(moved[1].map((s) => [s.name, s.count]))
    assert.deepEqual(got, { diamond: 3, oak_planks: 20 })
    assert.equal(world.get(c0.x, c0.y, c0.z), 'cobblestone', 'the cell is laid')
    assert.ok(bot.chats.some((m) => /moved the chest out of the castle to .*contents kept/.test(m)), bot.chats.join('|'))
    // Not on the door path: the entrance column out to the north edge.
    const ent = castle.entrance(ctx.castle)
    assert.ok(!(Math.abs(x - ent.x) <= 2 && z <= ent.z), 'off the door path')
  })

  it('a chest whose contents do not fit the pack stays a hole, contents back in it', async () => {
    const world = makeWorld()
    world.set(c0.x, c0.y, c0.z, 'chest')
    const box = [{ name: 'diamond', type: 500, count: 3 }, { name: 'dirt', type: 700, count: 5 }]
    world.boxes.set(`${c0.x},${c0.y},${c0.z}`, box)
    const items = [{ name: 'cobblestone', type: 1, count: 64 }]
    const bot = mockBot(world, items)
    const open = bot.openContainer
    bot.openContainer = async (b) => {
      const w = await open(b)
      const wd = w.withdraw
      w.withdraw = async (type, m, count) => { if (type === 700) throw new Error('full'); return wd(type, m, count) }
      return w
    }
    const ctx = { castle: { site: SITE, rot: 0 } }
    await run(bot, ctx, 3)
    assert.equal(world.get(c0.x, c0.y, c0.z), 'chest')
    assert.deepEqual(Object.fromEntries(box.map((s) => [s.name, s.count])), { diamond: 3, dirt: 5 })
    assert.equal(ctx.castleCarry, null)
    assert.equal(ctx.castle.blocked['1:0'].why, 'kept-chest')
  })

  it('someone\'s block is never destroyed by hand: no harvest tool, no dig', async () => {
    const world = makeWorld()
    world.set(c0.x, c0.y, c0.z, 'iron_block')
    const at = world.blockAt.bind(world)
    world.blockAt = (p) => { const b = at(p); if (b.name === 'iron_block') b.harvestTools = { 999: true }; return b }
    const bot = mockBot(world, [{ name: 'cobblestone', type: 1, count: 64 }])
    bot.pathfinder.bestHarvestTool = () => ({ name: 'cobblestone', type: 1 }) // any pack item, not a pick
    const ctx = { castle: { site: SITE, rot: 0 } }
    await run(bot, ctx, 3)
    assert.equal(world.get(c0.x, c0.y, c0.z), 'iron_block')
    assert.equal(ctx.castle.blocked['1:0'].why, 'no-tool-iron_block')
  })

  it('a lost box drop ends the carry: contents stay in the pack, the castle builds on', async () => {
    const world = makeWorld()
    world.set(c0.x, c0.y, c0.z, 'chest')
    world.boxes.set(`${c0.x},${c0.y},${c0.z}`, [{ name: 'diamond', type: 500, count: 3 }])
    const items = [{ name: 'cobblestone', type: 1, count: 64 }]
    const bot = mockBot(world, items)
    const dig = bot.dig
    bot.dig = async (b) => { await dig(b); items.splice(items.findIndex((s) => s.name === 'chest'), 1) } // never picked up
    const ctx = { castle: { site: SITE, rot: 0 } }
    await run(bot, ctx, 16)
    assert.equal(ctx.castleCarry, null)
    assert.ok(items.some((s) => s.name === 'diamond' && s.count === 3), 'contents kept in the pack')
    assert.ok(bot.chats.some((m) => /lost the drop of the chest, keeping its contents/.test(m)), bot.chats.join('|'))
    assert.equal(world.get(c0.x, c0.y, c0.z), 'cobblestone')
  })

  it('round-1 guards: no interactive stow support, a slot for the box, furnaces stay holes', async () => {
    // A crafting table under the nearest ring cell: the chest goes elsewhere.
    {
      const world = makeWorld()
      world.set(c0.x, c0.y, c0.z, 'chest')
      world.boxes.set(`${c0.x},${c0.y},${c0.z}`, [{ name: 'diamond', type: 500, count: 3 }])
      for (let x = SITE.x - 6; x <= SITE.x + 16; x++) {
        for (let z = SITE.z - 6; z <= SITE.z + 16; z++) world.set(x, 63, z, 'crafting_table')
      }
      const bot = mockBot(world, [{ name: 'cobblestone', type: 1, count: 64 }])
      const ctx = { castle: { site: SITE, rot: 0 } }
      await run(bot, ctx, 12)
      for (const [k, box] of world.boxes) {
        const [x, y, z] = k.split(',').map(Number)
        if (box.length) assert.notEqual(world.get(x, y - 1, z), 'crafting_table', 'never placed on a table')
      }
      assert.ok(bot.chats.some((m) => /no spot outside for the chest/.test(m)), bot.chats.join('|'))
    }
    // A full pack: the contents go back, the cell stays a hole.
    {
      const world = makeWorld()
      world.set(c0.x, c0.y, c0.z, 'chest')
      const box = [{ name: 'diamond', type: 500, count: 3 }]
      world.boxes.set(`${c0.x},${c0.y},${c0.z}`, box)
      const items = [{ name: 'cobblestone', type: 1, count: 64 }]
      const bot = mockBot(world, items)
      bot.inventory.emptySlotCount = () => 0
      const ctx = { castle: { site: SITE, rot: 0 } }
      await run(bot, ctx, 3)
      assert.equal(world.get(c0.x, c0.y, c0.z), 'chest')
      assert.deepEqual(box.map((s) => [s.name, s.count]), [['diamond', 3]])
      assert.equal(ctx.castle.blocked['1:0'].why, 'kept-chest')
    }
    // A furnace is never opened or dug.
    {
      const world = makeWorld()
      world.set(c0.x, c0.y, c0.z, 'furnace')
      const bot = mockBot(world, [{ name: 'cobblestone', type: 1, count: 64 }])
      let opened = 0
      bot.openContainer = async () => { opened++; throw new Error('no') }
      const ctx = { castle: { site: SITE, rot: 0 } }
      await run(bot, ctx, 3)
      assert.equal(opened, 0)
      assert.equal(world.get(c0.x, c0.y, c0.z), 'furnace')
      assert.equal(ctx.castle.blocked['1:0'].why, 'kept-furnace')
    }
  })
})
