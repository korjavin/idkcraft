'use strict'

// Craft-to-bring (idkcraft-did.2): the generic recipesAll planner plus the
// fake-player bring loop — pack/chest miss, craft rung, return and toss.
// Mocks carry real recipe shapes (delta negatives = consumed, requiresTable,
// result count); bot.craft consumes takes and lands the product generically,
// so the phantom test proves single-spend, not mock shape.

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const bring = require('../src/behaviours/bring')
const craftany = require('../src/behaviours/craftany')
const { handleChat, createTicker } = require('../src/index')

function pos(x, y, z) {
  const p = {
    x, y, z,
    distanceTo: (q) => Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z),
    clone() { return pos(p.x, p.y, p.z) },
    floored() { return { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) } },
  }
  return p
}

const ITEMS = {
  stone_axe: 101, iron_axe: 102, wooden_axe: 103, shears: 105,
  white_wool: 106, torch: 111, dirt: 112, cobblestone: 113, bucket: 114,
  stick: 115, coal: 116, iron_ingot: 117, oak_log: 118, oak_planks: 119,
  crafting_table: 120, cobbled_deepslate: 121, blackstone: 122,
  birch_planks: 123, birch_log: 124,
}

// Fake recipe with the real shape: delta negatives consumed, result count,
// requiresTable. takes = [[name, n], ...].
function R(product, takes, resCount, reqTable) {
  const delta = takes.map(([n, c]) => ({ id: ITEMS[n], count: -c }))
  delta.push({ id: ITEMS[product], count: resCount })
  return { delta, result: { count: resCount }, requiresTable: !!reqTable, product }
}

function RECIPES() {
  return {
    stone_axe: [
      R('stone_axe', [['cobbled_deepslate', 3], ['stick', 2]], 1, true),
      R('stone_axe', [['blackstone', 3], ['stick', 2]], 1, true),
      R('stone_axe', [['cobblestone', 3], ['stick', 2]], 1, true),
    ],
    iron_axe: [R('iron_axe', [['iron_ingot', 3], ['stick', 2]], 1, true)],
    wooden_axe: [R('wooden_axe', [['oak_planks', 3], ['stick', 2]], 1, true)],
    torch: [R('torch', [['coal', 1], ['stick', 1]], 4, false)],
    shears: [R('shears', [['iron_ingot', 2]], 1, false)],
    bucket: [R('bucket', [['iron_ingot', 3]], 1, true)],
    stick: [R('stick', [['oak_planks', 2]], 4, false)],
    oak_planks: [R('oak_planks', [['oak_log', 1]], 4, false)],
    crafting_table: [R('crafting_table', [['oak_planks', 4]], 1, false)],
  }
}

function mockBot({ items = [], chest = [], playerPos = null, cells = {}, recipes = null, craftImpl = null } = {}) {
  const lines = []
  const tossCalls = []
  const calls = { setGoal: 0, goals: [], opens: 0, craft: [], place: 0 }
  const itemsByName = {}
  for (const [name, id] of Object.entries(ITEMS)) itemsByName[name] = { id }
  const byId = {}
  for (const [name, id] of Object.entries(ITEMS)) byId[id] = name
  const table = recipes === null ? RECIPES() : recipes
  const bot = {
    lines, tossCalls, calls, chest, cells,
    username: 'IdkBot',
    entities: {},
    health: 20,
    food: 20,
    entity: { position: pos(0, 64, 0), onGround: true },
    registry: { blocksByName: {}, itemsByName },
    players: { P: { username: 'P', entity: playerPos ? { position: playerPos } : null } },
    _moving: false,
    _items: items,
    pathfinder: {
      goal: null,
      setGoal: (goal) => { calls.setGoal++; calls.goals.push(goal); bot.pathfinder.goal = goal },
      isMoving: () => bot._moving,
    },
    inventory: { items: () => bot._items },
    recipesAll: (id) => {
      const name = byId[id]
      return (name && table[name]) || []
    },
    recipesFor: (id) => {
      const name = byId[id]
      return (name && table[name]) || []
    },
    craft: craftImpl || (async (recipe, count) => {
      calls.craft.push(recipe.product)
      for (const d of recipe.delta) {
        if (d.count >= 0) continue
        let n = -d.count * count
        for (const s of bot._items) {
          if (n <= 0) break
          if (s.name !== byId[d.id]) continue
          const take = Math.min(s.count, n)
          s.count -= take
          n -= take
        }
      }
      bot._items.push({ name: recipe.product, count: recipe.result.count * count })
      bot._items = bot._items.filter((s) => s.count > 0)
    }),
    findBlocks: () => [],
    blockAt(p) {
      const key = p && `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`
      const name = cells[key]
      if (!name) return null
      return { name, position: pos(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)) }
    },
    openChest: async () => {
      calls.opens++
      return {
        containerItems: () => chest.map((s) => ({ name: s.name, type: itemsByName[s.name].id, metadata: null, count: s.count })),
        withdraw: async (type, _meta, count) => {
          const name = byId[type]
          let n = count
          for (let k = chest.length - 1; k >= 0 && n > 0; k--) {
            if (chest[k].name !== name) continue
            const take = Math.min(chest[k].count, n)
            chest[k].count -= take
            n -= take
            if (chest[k].count <= 0) chest.splice(k, 1)
          }
          const got = count - n
          if (got > 0) {
            const at = bot._items.find((i) => i.name === name)
            if (at) at.count += got
            else bot._items.push({ name, count: got })
          }
        },
        close: () => {},
      }
    },
    equip: async () => {},
    placeBlock: async (ref) => {
      calls.place++
      const at = `${ref.position.x},${ref.position.y + 1},${ref.position.z}`
      cells[at] = 'crafting_table'
      const held = bot._items.find((i) => i.name === 'crafting_table')
      if (held) {
        held.count -= 1
        bot._items = bot._items.filter((s) => s.count > 0)
      }
    },
    toss: async (id, meta, n) => { tossCalls.push([id, meta, n]) },
    chat(line) { lines.push(String(line)) },
  }
  return bot
}

function tickerFor(bot) {
  return createTicker({
    bot,
    brain: { decide: async () => ({ action: 'idle', sprint: false, source: 'stub' }) },
    tickMs: 10,
    idleTickMs: 10,
  })
}

const flush = () => new Promise((r) => { setImmediate(() => setImmediate(r)) })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// Drive an order to the end: teleport the walk legs, sleep through the
// 500 ms runOp settle windows, cap the ticks so a stuck order fails loud.
async function drive(bot, ctx) {
  for (let i = 0; i < 60 && ctx.bring; i++) {
    await bring(bot, ctx, null, {})
    const o = ctx.bring
    if (!o) break
    if (ctx.gearInFlight || (o && o.chestInFlight) || (o && o.tossInFlight)) {
      await sleep(650)
      continue
    }
    await flush()
    if (o.phase === 'chestfetch') { bot._moving = false; bot.entity.position = pos(5, 64, 1) }
    if (o.phase === 'craft') { bot._moving = false; bot.entity.position = pos(0, 64, 0) }
    if (o.phase === 'return') {
      const pp = bot.players.P.entity.position
      bot.entity.position = pos(pp.x, pp.y, pp.z)
    }
  }
}

function tableHome(ctx, x, y, z) {
  ctx.home = { site: { x: 0, y: 64, z: 0 }, built: true, table: { x, y, z } }
}

function chestHome(ctx) {
  ctx.home = { site: { x: 0, y: 64, z: 0 }, built: true, chest: { x: 5, y: 64, z: 1 } }
}

describe('craftany planner (idkcraft-did.2)', () => {
  const cells = { '0,64,0': 'crafting_table' }
  const placed = () => ({ home: { table: { x: 0, y: 64, z: 0 } } })
  it('picks the covered stone variant, not the first listed', () => {
    const bot = mockBot({ items: [{ name: 'cobblestone', count: 3 }, { name: 'stick', count: 2 }], cells })
    const p = craftany.planCraft(bot, placed(), ['stone_axe'], 1)
    assert.equal(p.ok, true)
    assert.equal(p.target, 'stone_axe')
    assert.deepEqual(p.recipe.delta.filter((d) => d.count < 0).map((d) => d.id), [ITEMS.cobblestone, ITEMS.stick])
    assert.equal(p.requiresTable, true)
  })

  it('crafts the best covered tier: iron over stone over wooden', () => {
    const both = mockBot({
      items: [
        { name: 'iron_ingot', count: 3 }, { name: 'cobblestone', count: 3 },
        { name: 'stick', count: 2 },
      ],
      cells,
    })
    assert.equal(craftany.planCraft(both, placed(), bring.orderCraftNames(['iron_axe', 'stone_axe', 'wooden_axe']), 1).target, 'iron_axe')
    const stone = mockBot({ items: [{ name: 'cobblestone', count: 3 }, { name: 'stick', count: 2 }], cells })
    assert.equal(craftany.planCraft(stone, placed(), bring.orderCraftNames(['iron_axe', 'stone_axe', 'wooden_axe']), 1).target, 'stone_axe')
  })

  it('exact names stay exact: iron axe without ingots names iron, never stone', () => {
    const bot = mockBot({ items: [{ name: 'cobblestone', count: 3 }, { name: 'stick', count: 2 }] })
    const p = craftany.planCraft(bot, {}, ['iron_axe'], 1)
    assert.equal(p.ok, false)
    assert.equal(p.fail, 'missing')
    assert.equal(p.line, "can't make iron_axe: need 3 iron_ingot (have 0)")
  })

  it('one log and nothing else refuses with the stone gap', () => {
    const bot = mockBot({ items: [{ name: 'oak_log', count: 1 }] })
    const p = craftany.planCraft(bot, {}, bring.orderCraftNames(['iron_axe', 'stone_axe', 'wooden_axe']), 1)
    assert.equal(p.ok, false)
    assert.equal(p.fail, 'missing')
    assert.equal(p.line, "can't make stone_axe: need 3 cobblestone (have 0), 2 stick (have 0)")
  })

  it('sticks close through planks, planks through logs', () => {
    const planks = mockBot({ items: [{ name: 'cobblestone', count: 3 }, { name: 'oak_planks', count: 2 }], cells })
    assert.equal(craftany.planCraft(planks, placed(), ['stone_axe'], 1).ok, true)
    const logs = mockBot({ items: [{ name: 'cobblestone', count: 3 }, { name: 'oak_log', count: 1 }], cells })
    assert.equal(craftany.planCraft(logs, placed(), ['stone_axe'], 1).ok, true)
  })

  it('a table recipe with no table path refuses honestly', () => {
    const bot = mockBot({ items: [{ name: 'cobblestone', count: 3 }, { name: 'stick', count: 2 }] })
    const p = craftany.planCraft(bot, {}, ['stone_axe'], 1)
    assert.equal(p.ok, false)
    assert.equal(p.fail, 'no-table')
    assert.equal(p.line, 'need a crafting table')
  })

  it('malformed recipes and missing recipesAll read as no-recipe', () => {
    const bad = mockBot({ items: [{ name: 'cobblestone', count: 3 }] })
    bad.recipesAll = () => [{}]
    assert.equal(craftany.planCraft(bad, {}, ['stone_axe'], 1).fail, 'no-recipe')
    const bare = mockBot({})
    delete bare.recipesAll
    delete bare.recipesFor
    assert.equal(craftany.planCraft(bare, {}, ['stone_axe'], 1).fail, 'no-recipe')
  })
})

describe('bring me axe crafted (idkcraft-did.2)', () => {
  it("'bring me axe' crafts from cobble+sticks at the home table, then tosses", async () => {
    const bot = mockBot({
      items: [{ name: 'cobblestone', count: 3 }, { name: 'stick', count: 2 }],
      playerPos: pos(30, 64, 0),
      cells: { '0,64,0': 'crafting_table' },
    })
    const ticker = tickerFor(bot)
    tableHome(bot._tickerCtx, 0, 64, 0)
    handleChat(bot, ticker, 'P', 'bring me axe')
    assert.deepEqual(bot.lines, ['making you a stone_axe'])
    assert.equal(bot._tickerCtx.bring.phase, 'craft')
    await drive(bot, bot._tickerCtx)
    assert.ok(!bot._tickerCtx.bring, 'order completed')
    assert.deepEqual(bot.tossCalls, [[ITEMS.stone_axe, null, 1]])
    assert.ok(bot.lines.includes('here is 1 stone_axe'), `lines: ${bot.lines}`)
    assert.deepEqual(bot.calls.craft, ['stone_axe'])
  })

  it('forges iron when the pack feeds it', async () => {
    const bot = mockBot({
      items: [
        { name: 'iron_ingot', count: 3 }, { name: 'cobblestone', count: 3 },
        { name: 'stick', count: 2 },
      ],
      playerPos: pos(30, 64, 0),
      cells: { '0,64,0': 'crafting_table' },
    })
    const ticker = tickerFor(bot)
    tableHome(bot._tickerCtx, 0, 64, 0)
    handleChat(bot, ticker, 'P', 'bring me axe')
    assert.deepEqual(bot.lines, ['making you a iron_axe'])
    await drive(bot, bot._tickerCtx)
    assert.deepEqual(bot.tossCalls, [[ITEMS.iron_axe, null, 1]])
  })

  it('crafts the intermediates too: log+cobble becomes planks, sticks, axe', async () => {
    const bot = mockBot({
      items: [{ name: 'cobblestone', count: 3 }, { name: 'oak_log', count: 1 }],
      playerPos: pos(30, 64, 0),
      cells: { '0,64,0': 'crafting_table' },
    })
    const ticker = tickerFor(bot)
    tableHome(bot._tickerCtx, 0, 64, 0)
    handleChat(bot, ticker, 'P', 'bring me axe')
    assert.deepEqual(bot.lines, ['making you a stone_axe'])
    await drive(bot, bot._tickerCtx)
    assert.ok(!bot._tickerCtx.bring, 'order completed')
    assert.deepEqual(bot.calls.craft, ['oak_planks', 'stick', 'stone_axe'])
    assert.deepEqual(bot.tossCalls, [[ITEMS.stone_axe, null, 1]])
  })

  it('one log and nothing else is one honest line, nothing crafted', () => {
    const bot = mockBot({ items: [{ name: 'oak_log', count: 1 }], playerPos: pos(30, 64, 0) })
    handleChat(bot, tickerFor(bot), 'P', 'bring me axe')
    assert.deepEqual(bot.lines, ["can't make stone_axe: need 3 cobblestone (have 0), 2 stick (have 0)"])
    assert.ok(!bot._tickerCtx.bring, 'no order created')
    assert.deepEqual(bot.calls.craft, [])
  })

  it('the last axe is kept: mats forge a second one to give', async () => {
    const bot = mockBot({
      items: [{ name: 'stone_axe', count: 1 }, { name: 'cobblestone', count: 3 }, { name: 'stick', count: 2 }],
      playerPos: pos(30, 64, 0),
      cells: { '0,64,0': 'crafting_table' },
    })
    const ticker = tickerFor(bot)
    tableHome(bot._tickerCtx, 0, 64, 0)
    handleChat(bot, ticker, 'P', 'bring me axe')
    assert.deepEqual(bot.lines, ['making you a stone_axe'])
    await drive(bot, bot._tickerCtx)
    assert.ok(!bot._tickerCtx.bring, 'order completed')
    assert.deepEqual(bot.tossCalls, [[ITEMS.stone_axe, null, 1]])
    const left = bot._items.find((i) => i.name === 'stone_axe')
    assert.equal(left && left.count, 1, 'the kept axe stays home')
  })

  it('a phantom first craft retries without double spend', async () => {
    let n = 0
    const real = []
    const bot = mockBot({
      items: [{ name: 'cobblestone', count: 3 }, { name: 'stick', count: 2 }],
      playerPos: pos(30, 64, 0),
      cells: { '0,64,0': 'crafting_table' },
    })
    const impl = bot.craft
    bot.craft = async (recipe, count, table) => {
      n += 1
      if (n === 1) return // live phantom: resolves, lands nothing, spends nothing
      real.push(recipe.product)
      return impl(recipe, count, table)
    }
    const ticker = tickerFor(bot)
    tableHome(bot._tickerCtx, 0, 64, 0)
    handleChat(bot, ticker, 'P', 'bring me axe')
    await drive(bot, bot._tickerCtx)
    assert.ok(!bot._tickerCtx.bring, 'order completed')
    assert.equal(n, 2, 'one phantom plus one landing op')
    assert.deepEqual(real, ['stone_axe'])
    assert.deepEqual(bot._items.filter((i) => i.name === 'cobblestone'), [], 'mats spent exactly once')
    assert.deepEqual(bot.tossCalls, [[ITEMS.stone_axe, null, 1]])
  })

  it('an empty chest falls through to the craft rung', async () => {
    const bot = mockBot({
      items: [{ name: 'cobblestone', count: 3 }, { name: 'stick', count: 2 }],
      chest: [{ name: 'torch', count: 9 }],
      playerPos: pos(30, 64, 0),
      cells: { '0,64,0': 'crafting_table' },
    })
    const ticker = tickerFor(bot)
    const ctx = bot._tickerCtx
    ctx.home = { site: { x: 0, y: 64, z: 0 }, built: true, chest: { x: 5, y: 64, z: 1 }, table: { x: 0, y: 64, z: 0 } }
    handleChat(bot, ticker, 'P', 'bring me axe')
    assert.deepEqual(bot.lines, ['checking the home chest for axe'])
    await drive(bot, ctx)
    assert.ok(!ctx.bring, 'order completed')
    assert.ok(bot.lines.includes('making you a stone_axe'), `lines: ${bot.lines}`)
    assert.deepEqual(bot.tossCalls, [[ITEMS.stone_axe, null, 1]])
  })
})

describe('bring me torch/shears/bucket (idkcraft-did.2)', () => {
  it("'bring me torch' crafts 2x2 with no table anywhere", async () => {
    const bot = mockBot({
      items: [{ name: 'coal', count: 1 }, { name: 'stick', count: 1 }],
      playerPos: pos(30, 64, 0),
    })
    handleChat(bot, tickerFor(bot), 'P', 'bring me torch')
    assert.deepEqual(bot.lines, ['making you a torch'])
    await drive(bot, bot._tickerCtx)
    assert.ok(!bot._tickerCtx.bring, 'order completed')
    assert.deepEqual(bot.tossCalls, [[ITEMS.torch, null, 3]])
    assert.ok(bot.lines.includes('here are 3 torch'), `lines: ${bot.lines}`)
  })

  it("'bring me shears' crafts 2x2 from two ingots", async () => {
    const bot = mockBot({
      items: [{ name: 'iron_ingot', count: 2 }],
      playerPos: pos(30, 64, 0),
    })
    handleChat(bot, tickerFor(bot), 'P', 'bring me shears')
    assert.deepEqual(bot.lines, ['making you a shears'])
    await drive(bot, bot._tickerCtx)
    assert.ok(!bot._tickerCtx.bring, 'order completed')
    assert.deepEqual(bot.tossCalls, [[ITEMS.shears, null, 1]])
  })

  it("'bring me bucket' crafts at the table, refuses honestly with no iron", async () => {
    const bot = mockBot({
      items: [{ name: 'iron_ingot', count: 3 }],
      playerPos: pos(30, 64, 0),
      cells: { '0,64,0': 'crafting_table' },
    })
    const ticker = tickerFor(bot)
    tableHome(bot._tickerCtx, 0, 64, 0)
    handleChat(bot, ticker, 'P', 'bring me bucket')
    assert.deepEqual(bot.lines, ['making you a bucket'])
    await drive(bot, bot._tickerCtx)
    assert.ok(!bot._tickerCtx.bring, 'order completed')
    assert.deepEqual(bot.tossCalls, [[ITEMS.bucket, null, 1]])

    const poor = mockBot({ playerPos: pos(30, 64, 0) })
    handleChat(poor, tickerFor(poor), 'P', 'bring me bucket')
    assert.deepEqual(poor.lines, ['need iron_ingot (smelting not part of bring)'])
    assert.ok(!poor._tickerCtx.bring, 'no order created')
  })

  it('a smelting gap refuses before any ladder gap gathers (body-4)', () => {
    const bot = mockBot({ playerPos: pos(30, 64, 0) })
    handleChat(bot, tickerFor(bot), 'P', 'bring me iron axe')
    assert.deepEqual(bot.lines, ['need iron_ingot (smelting not part of bring)'])
    assert.ok(!bot._tickerCtx.bring, 'no stick sub opened for an unsmeltable axe')
  })

  it('an off-ladder gap refuses with the plan line, no wasted sub (body-4)', () => {
    const bot = mockBot({ playerPos: pos(30, 64, 0) })
    handleChat(bot, tickerFor(bot), 'P', 'bring me axe')
    assert.deepEqual(bot.lines, ["can't make stone_axe: need 3 cobblestone (have 0), 2 stick (have 0)"])
    assert.ok(!bot._tickerCtx.bring, 'no stick sub opened without cobble')
    assert.deepEqual(bot.calls.craft, [])
  })

  it('no table and fewer than 4 planks is one line, nothing crafted', () => {
    const bot = mockBot({
      items: [{ name: 'iron_ingot', count: 3 }],
      playerPos: pos(30, 64, 0),
    })
    handleChat(bot, tickerFor(bot), 'P', 'bring me bucket')
    assert.deepEqual(bot.lines, ['need a crafting table'])
    assert.ok(!bot._tickerCtx.bring, 'no order created')
    assert.deepEqual(bot.calls.craft, [])
  })

  it('eight planks and no table: make a table, place it, craft the axe', async () => {
    const bot = mockBot({
      items: [
        { name: 'cobblestone', count: 3 }, { name: 'stick', count: 2 },
        { name: 'oak_planks', count: 8 },
      ],
      playerPos: pos(30, 64, 0),
      cells: { '1,63,0': 'dirt' },
    })
    handleChat(bot, tickerFor(bot), 'P', 'bring me axe')
    assert.deepEqual(bot.lines, ['making you a stone_axe'])
    await drive(bot, bot._tickerCtx)
    assert.ok(!bot._tickerCtx.bring, 'order completed')
    assert.deepEqual(bot.calls.craft, ['crafting_table', 'stone_axe'])
    assert.equal(bot.calls.place, 1, 'the made table is placed beside the body')
    assert.deepEqual(bot.tossCalls, [[ITEMS.stone_axe, null, 1]])
  })

  it('a phantom table-make retries instead of refusing no-table', async () => {
    let n = 0
    const real = []
    const bot = mockBot({
      items: [
        { name: 'cobblestone', count: 3 }, { name: 'stick', count: 2 },
        { name: 'oak_planks', count: 8 },
      ],
      playerPos: pos(30, 64, 0),
      cells: { '1,63,0': 'dirt' },
    })
    const impl = bot.craft
    bot.craft = async (recipe, count, table) => {
      n += 1
      if (n === 1) return // the table op phantoms: nothing lands, nothing spent
      real.push(recipe.product)
      return impl(recipe, count, table)
    }
    handleChat(bot, tickerFor(bot), 'P', 'bring me axe')
    await drive(bot, bot._tickerCtx)
    assert.ok(!bot._tickerCtx.bring, 'order completed')
    assert.equal(n, 3, 'phantom table plus two landing ops')
    assert.deepEqual(real, ['crafting_table', 'stone_axe'])
    assert.equal(bot.calls.place, 1)
    const planks = bot._items.find((i) => i.name === 'oak_planks')
    assert.equal(planks && planks.count, 4, 'the table ate 4 planks exactly once')
    assert.deepEqual(bot.tossCalls, [[ITEMS.stone_axe, null, 1]])
  })

  it('four planks fund the table: the stick gap opens a log sub-order (idkcraft-did.4)', async () => {
    const bot = mockBot({
      items: [{ name: 'cobblestone', count: 3 }, { name: 'oak_planks', count: 4 }],
      playerPos: pos(30, 64, 0),
    })
    handleChat(bot, tickerFor(bot), 'P', 'bring me axe')
    assert.deepEqual(bot.lines, ['making you a stone_axe: need 2 sticks, going for logs'])
    const o = bot._tickerCtx.bring
    assert.equal(o && o.kind, 'block')
    assert.equal(o && o.name, 'oak_log')
    assert.equal(o && o.subFor, 'stone_axe')
    assert.deepEqual(bot.calls.craft, [], 'no stray table burned')
    await drive(bot, bot._tickerCtx) // the mock world holds no logs: one honest line
    assert.ok(!bot._tickerCtx.bring, 'order refused')
    assert.ok(bot.lines.includes('could not get 2 sticks for the stone_axe in time'), `lines: ${bot.lines}`)
  })

  it('mixed woods: the table burns the spare wood, not the recipe wood', async () => {
    // Registry order lists birch before oak for both; the plan picks the
    // birch axe with an oak table, and execution must agree (revmux 02).
    const recipes = {
      ...RECIPES(),
      wooden_axe: [
        R('wooden_axe', [['birch_planks', 3], ['stick', 2]], 1, true),
        R('wooden_axe', [['oak_planks', 3], ['stick', 2]], 1, true),
      ],
      crafting_table: [
        R('crafting_table', [['birch_planks', 4]], 1, false),
        R('crafting_table', [['oak_planks', 4]], 1, false),
      ],
    }
    const bot = mockBot({
      items: [
        { name: 'oak_planks', count: 5 }, { name: 'birch_planks', count: 4 },
        { name: 'stick', count: 2 },
      ],
      playerPos: pos(30, 64, 0),
      cells: { '1,63,0': 'dirt' },
      recipes,
    })
    handleChat(bot, tickerFor(bot), 'P', 'bring me axe')
    assert.deepEqual(bot.lines, ['making you a wooden_axe'])
    await drive(bot, bot._tickerCtx)
    assert.ok(!bot._tickerCtx.bring, 'order completed')
    assert.deepEqual(bot.tossCalls, [[ITEMS.wooden_axe, null, 1]])
    const left = (n) => (bot._items.find((i) => i.name === n) || {}).count || 0
    assert.equal(left('oak_planks'), 1, 'the table ate 4 oak')
    assert.equal(left('birch_planks'), 1, 'the axe ate 3 birch')
  })
})

describe('bring craft handover and give-ups (idkcraft-did.2 revmux 01)', () => {
  it('a kept stone axe plus iron mats hands over the forged iron', async () => {
    const bot = mockBot({
      items: [
        { name: 'stone_axe', count: 1 }, { name: 'iron_ingot', count: 3 },
        { name: 'stick', count: 2 },
      ],
      playerPos: pos(30, 64, 0),
      cells: { '0,64,0': 'crafting_table' },
    })
    const ticker = tickerFor(bot)
    tableHome(bot._tickerCtx, 0, 64, 0)
    handleChat(bot, ticker, 'P', 'bring me axe')
    assert.deepEqual(bot.lines, ['making you a iron_axe'])
    await drive(bot, bot._tickerCtx)
    assert.ok(!bot._tickerCtx.bring, 'order completed')
    assert.deepEqual(bot.tossCalls, [[ITEMS.iron_axe, null, 1]], 'the announced tier goes out')
    const kept = bot._items.find((i) => i.name === 'stone_axe')
    assert.equal(kept && kept.count, 1, 'the original tool stays home')
  })

  it('a cancelled run never resumes under the next order', async () => {
    const bot = mockBot({
      items: [{ name: 'cobblestone', count: 6 }, { name: 'stick', count: 4 }],
      playerPos: pos(30, 64, 0),
      cells: { '0,64,0': 'crafting_table' },
    })
    const ticker = tickerFor(bot)
    const ctx = bot._tickerCtx
    tableHome(ctx, 0, 64, 0)
    handleChat(bot, ticker, 'P', 'bring me axe')
    assert.deepEqual(bot.lines, ['making you a stone_axe'])
    await bring(bot, ctx, null, {}) // one craft tick: the stone run opens
    assert.ok(ctx.craftany, 'run state exists mid-order')
    ticker.stop() // cancel mid-run
    assert.equal(ctx.bring, null)
    await sleep(650) // the issued op lands in the background: stone in pack
    bot._items.push({ name: 'iron_ingot', count: 3 })
    handleChat(bot, ticker, 'P', 'bring me axe')
    assert.deepEqual(bot.lines.slice(-1), ['making you a iron_axe'])
    await drive(bot, ctx)
    assert.ok(!ctx.bring, 'order completed')
    assert.deepEqual(bot.tossCalls, [[ITEMS.iron_axe, null, 1]], 'fresh plan, fresh tier')
  })

  it('a far frozen table gives up after 21 ticks; progress keeps walking', () => {
    const frozen = mockBot({
      items: [{ name: 'cobblestone', count: 3 }, { name: 'stick', count: 2 }],
      cells: { '100,64,0': 'crafting_table' },
    })
    const fctx = { home: { table: { x: 100, y: 64, z: 0 } } }
    let res = 'running'
    let at = -1
    for (let i = 0; i < 25 && res === 'running'; i++) {
      res = craftany(frozen, fctx, ['stone_axe'], 1)
      at = i
    }
    assert.equal(at, 20, 'gives up on the 21st frozen tick')
    assert.deepEqual(res, { done: false, line: "can't reach the crafting table" })
    assert.equal(fctx.craftany, null)

    const moving = mockBot({
      items: [{ name: 'cobblestone', count: 3 }, { name: 'stick', count: 2 }],
      cells: { '100,64,0': 'crafting_table' },
    })
    const mctx = { home: { table: { x: 100, y: 64, z: 0 } } }
    for (let i = 0; i < 25; i++) {
      res = craftany(moving, mctx, ['stone_axe'], 1)
      assert.equal(res, 'running', `tick ${i} still walking while closing in`)
      if (i % 3 === 2) moving.entity.position = pos(moving.entity.position.x + 5, 64, 0)
    }
  })

  it('g0z.40: a table in reach but behind a wall walks to a seen cell, never crafts', () => {
    const Vec3 = require('vec3')
    const bot = mockBot({
      items: [{ name: 'cobblestone', count: 3 }, { name: 'stick', count: 2 }],
      cells: { '2,64,0': 'crafting_table' },
    })
    bot.entity.position = new Vec3(0.5, 64, 0.5) // reach 2, the wall at x=1
    bot.entity.eyeHeight = 1.62
    bot.world = { raycast: () => ({ position: new Vec3(1, 65, 0) }) }
    const ctx = { home: { table: { x: 2, y: 64, z: 0 } } }
    const res = craftany(bot, ctx, ['stone_axe'], 1)
    assert.equal(res, 'running')
    assert.equal(bot.calls.goals[0].constructor.name, 'GoalSeeTable')
    assert.equal(ctx.lastGoalKey, 'craftany-table:2,64,0')
    assert.equal(ctx.craftany.table, null, 'no table latched through the wall')
    assert.equal(ctx.gearInFlight, undefined, 'no craft fired')
  })

  it('three failed placements end with need-a-table', async () => {
    const bot = mockBot({
      items: [
        { name: 'cobblestone', count: 3 }, { name: 'stick', count: 2 },
        { name: 'crafting_table', count: 1 },
      ],
      cells: { '1,63,0': 'dirt' },
    })
    bot.placeBlock = async () => { bot.calls.place++; throw new Error('no room') }
    const ctx = {}
    let res = 'running'
    for (let i = 0; i < 60 && res === 'running'; i++) {
      res = craftany(bot, ctx, ['stone_axe'], 1)
      await flush()
    }
    assert.deepEqual(res, { done: false, line: 'need a crafting table' })
    assert.equal(bot.calls.place, 3, 'exactly three place attempts')
    assert.equal(ctx.craftany, null)
  })

  it('a stale gear failure does not fail the fresh run', async () => {
    const bot = mockBot({
      items: [{ name: 'cobblestone', count: 3 }, { name: 'stick', count: 2 }],
      cells: { '0,64,0': 'crafting_table' },
    })
    const ctx = { home: { table: { x: 0, y: 64, z: 0 } }, stepStatus: 'failed:gear-iron_pickaxe' }
    const res = craftany(bot, ctx, ['stone_axe'], 1)
    assert.equal(res, 'running')
    assert.equal(ctx.stepStatus, null)
    assert.equal(ctx.gearInFlight, true)
    await sleep(650) // let the issued op settle so no timer leaks past the test
  })
})
