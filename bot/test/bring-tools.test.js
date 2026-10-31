'use strict'

// Tool-chain rung (idkcraft-0jvh): the bot produces simple tools from empty
// hands as a shared building-block rung. Mocks carry real recipe shapes
// (delta negatives = consumed, requiresTable); bot.craft lands the product
// generically, bot.equip records the held item.

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const bring = require('../src/behaviours/bring')
const { handleChat, createTicker } = require('../src/index')

function pos(x, y, z) {
  const p = {
    x, y, z,
    distanceTo: (q) => Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z),
    clone() { return pos(p.x, p.y, p.z) },
    offset(ox, oy, oz) { return pos(p.x + ox, p.y + oy, p.z + oz) },
    floored() { return { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) } },
  }
  return p
}

const ITEMS = {
  stone_hoe: 201, stone_axe: 202, stone_sword: 203, wooden_shovel: 204,
  iron_axe: 205, wooden_pickaxe: 206,
  cobblestone: 113, stick: 115, oak_log: 118, oak_planks: 119,
  iron_ingot: 117, raw_iron: 125, crafting_table: 120,
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
    stone_hoe: [R('stone_hoe', [['cobblestone', 3], ['stick', 2]], 1, true)],
    stone_axe: [R('stone_axe', [['cobblestone', 3], ['stick', 2]], 1, true)],
    stone_sword: [R('stone_sword', [['cobblestone', 2], ['stick', 1]], 1, true)],
    wooden_shovel: [R('wooden_shovel', [['oak_planks', 1], ['stick', 2]], 1, true)],
    iron_axe: [R('iron_axe', [['iron_ingot', 3], ['stick', 2]], 1, true)],
    wooden_pickaxe: [R('wooden_pickaxe', [['oak_planks', 3], ['stick', 2]], 1, true)],
    stick: [R('stick', [['oak_planks', 2]], 4, false)],
    oak_planks: [R('oak_planks', [['oak_log', 1]], 4, false)],
    crafting_table: [R('crafting_table', [['oak_planks', 4]], 1, false)],
  }
}

function mockBot({ items = [], chest = [], playerPos = null, cells = {}, recipes = null } = {}) {
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
    held: null,
    entity: { position: pos(0, 64, 0), onGround: true },
    registry: { blocksByName: {}, itemsByName },
    players: { P: { username: 'P', entity: playerPos ? { position: playerPos } : null } },
    _moving: false,
    _items: items,
    pathfinder: {
      goal: null,
      setGoal: (goal) => { calls.setGoal++; calls.goals.push(goal); bot.pathfinder.goal = goal },
      stop: () => {},
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
    craft: async (recipe, count) => {
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
    },
    findBlocks: () => [],
    blockAt(p) {
      const key = p && `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`
      if (key === '5,64,1') return { name: 'chest', position: pos(5, 64, 1) }
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
    equip: async (item) => { bot.held = item && item.name },
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

function tableChestHome(ctx) {
  ctx.home = { site: { x: 0, y: 64, z: 0 }, built: true, table: { x: 0, y: 64, z: 0 }, chest: { x: 5, y: 64, z: 1 } }
}

// A bare rung ctx: the rung reads/writes ctx.bring like the order path.
function rungCtx(o) {
  const ctx = {}
  if (o) ctx.bring = o
  return ctx
}

describe('tool order parsing (idkcraft-0jvh)', () => {
  it('parses verbs, tiers and tools; stone is the default', () => {
    assert.deepEqual(bring.parseToolRequest('make me a stone hoe'), { tool: 'stone_hoe' })
    assert.deepEqual(bring.parseToolRequest('craft iron axe'), { tool: 'iron_axe' })
    assert.deepEqual(bring.parseToolRequest('make axe'), { tool: 'stone_axe' })
    assert.deepEqual(bring.parseToolRequest('make me a sharp sword'), { tool: 'stone_sword' })
    assert.deepEqual(bring.parseToolRequest('craft wooden shovel'), { tool: 'wooden_shovel' })
    assert.deepEqual(bring.parseToolRequest('make me wood pickaxe'), { tool: 'wooden_pickaxe' })
    assert.deepEqual(bring.parseToolRequest('craft iron axes'), { tool: 'iron_axe' })
    for (const bad of ['make me a gold hoe', 'make me a diamond sword', 'bring me axe', 'make sandwiches', 'make', 'craft', '', null]) {
      assert.equal(bring.parseToolRequest(bad), null, String(bad))
    }
  })

  it("resolveItem handles '<tier>_<tool>' names exactly", () => {
    const bot = mockBot({})
    assert.deepEqual(bring.resolveItem(bot, 'stone_hoe'), { names: ['stone_hoe'], family: 'stone_hoe' })
    assert.deepEqual(bring.resolveItem(bot, 'iron_axe'), { names: ['iron_axe'], family: 'iron_axe' })
    assert.equal(bring.isToolName('stone_hoe'), true)
    assert.equal(bring.isToolName('hoe'), false)
    assert.equal(bring.isToolName('diamond_sword'), false)
  })
})

describe('ensureTool rung (idkcraft-0jvh)', () => {
  it('a held tool equips and ends the order', () => {
    const bot = mockBot({ items: [{ name: 'stone_hoe', count: 1 }] })
    const o = {}
    const ctx = rungCtx(o)
    assert.equal(bring.ensureTool(bot, ctx, o, 'stone_hoe'), 'done')
    assert.equal(bot.held, 'stone_hoe')
    assert.deepEqual(bot.lines, ['equipped stone_hoe'])
    assert.equal(ctx.bring, null)
  })

  it('covered mats open the craft phase', () => {
    const bot = mockBot({ items: [
      { name: 'cobblestone', count: 3 }, { name: 'stick', count: 2 }, { name: 'crafting_table', count: 1 },
    ] })
    const o = {}
    const ctx = rungCtx(o)
    assert.equal(bring.ensureTool(bot, ctx, o, 'stone_hoe'), 'craft')
    assert.equal(o.phase, 'craft')
    assert.equal(o.craftTarget, 'stone_hoe')
    assert.deepEqual(bot.lines, ['making you a stone_hoe'])
  })

  it('empty hands open the sticks sub first', () => {
    const bot = mockBot({})
    const o = {}
    const ctx = rungCtx(o)
    assert.equal(bring.ensureTool(bot, ctx, o, 'stone_hoe'), 'gap')
    assert.equal(o.kind, 'block')
    assert.equal(o.subFor, 'stone_hoe')
    assert.deepEqual(bot.lines, ['making you a stone_hoe: need 2 sticks, going for logs'])
  })

  it('sticks in hand plus a pick open the cobble block sub', () => {
    const bot = mockBot({ items: [{ name: 'stick', count: 2 }, { name: 'wooden_pickaxe', count: 1 }] })
    const o = {}
    const ctx = rungCtx(o)
    assert.equal(bring.ensureTool(bot, ctx, o, 'stone_hoe'), 'gap')
    assert.equal(o.kind, 'block')
    assert.equal(o.name, 'stone')
    assert.equal(o.drop, 'cobblestone')
    assert.equal(o.subFor, 'stone_hoe')
    assert.deepEqual(bot.lines, ['making you a stone_hoe: need 3 cobblestone, going for stone'])
  })

  it('a cobble gap with no pickaxe refuses honestly', () => {
    const bot = mockBot({ items: [{ name: 'stick', count: 2 }] })
    const o = {}
    const ctx = rungCtx(o)
    assert.equal(bring.ensureTool(bot, ctx, o, 'stone_hoe'), 'refused')
    assert.deepEqual(bot.lines, ['need a pickaxe to dig stone for the stone_hoe'])
    assert.equal(ctx.bring, null)
  })

  it('an iron tool with raw iron opens the smelt gap', () => {
    const bot = mockBot({ items: [{ name: 'raw_iron', count: 3 }] })
    const o = {}
    const ctx = rungCtx(o)
    assert.equal(bring.ensureTool(bot, ctx, o, 'iron_axe'), 'gap')
    assert.equal(o.phase, 'smelt')
    assert.equal(o.smelt.output, 'iron_ingot')
    assert.deepEqual(bot.lines, ['smelting 3 raw_iron for your iron_axe'])
  })

  it('no recipe refuses honestly', () => {
    const bot = mockBot({ recipes: {} })
    const o = {}
    const ctx = rungCtx(o)
    assert.equal(bring.ensureTool(bot, ctx, o, 'stone_hoe'), 'refused')
    assert.deepEqual(bot.lines, ["can't get stone_hoe: no recipe, no source"])
    assert.equal(ctx.bring, null)
  })
})

describe("'make me a stone hoe' (idkcraft-0jvh)", () => {
  it('empty hands with no chest open the wild sticks sub', () => {
    const bot = mockBot({ playerPos: pos(30, 64, 0) })
    handleChat(bot, tickerFor(bot), 'P', 'make me a stone hoe')
    assert.deepEqual(bot.lines, ['making you a stone_hoe: need 2 sticks, going for logs'])
    const o = bot._tickerCtx.bring
    assert.equal(o.toolName, 'stone_hoe')
    assert.deepEqual(o.names, ['stone_hoe'])
    assert.equal(o.subFor, 'stone_hoe')
  })

  it('crafts at the home table, then equips instead of tossing', async () => {
    const bot = mockBot({
      items: [{ name: 'cobblestone', count: 3 }, { name: 'stick', count: 2 }],
      playerPos: pos(30, 64, 0),
      cells: { '0,64,0': 'crafting_table' },
    })
    const ticker = tickerFor(bot)
    tableHome(bot._tickerCtx, 0, 64, 0)
    handleChat(bot, ticker, 'P', 'make me a stone hoe')
    assert.deepEqual(bot.lines, ['making you a stone_hoe'])
    assert.equal(bot._tickerCtx.bring.phase, 'craft')
    await drive(bot, bot._tickerCtx)
    assert.ok(!bot._tickerCtx.bring, 'order completed')
    assert.equal(bot.held, 'stone_hoe')
    assert.ok(bot.lines.includes('equipped stone_hoe'), `lines: ${bot.lines}`)
    assert.deepEqual(bot.tossCalls, [])
    assert.deepEqual(bot.calls.craft, ['stone_hoe'])
  })

  it('chest mats come first: empty hands, full chest, home table', async () => {
    const bot = mockBot({
      chest: [{ name: 'stick', count: 2 }, { name: 'cobblestone', count: 3 }],
      playerPos: pos(30, 64, 0),
      cells: { '0,64,0': 'crafting_table' },
    })
    const ticker = tickerFor(bot)
    tableChestHome(bot._tickerCtx)
    handleChat(bot, ticker, 'P', 'make me a stone hoe')
    assert.deepEqual(bot.lines, ['checking the home chest for stone_hoe'])
    await drive(bot, bot._tickerCtx)
    assert.ok(!bot._tickerCtx.bring, 'order completed')
    assert.equal(bot.held, 'stone_hoe')
    assert.ok(bot.lines.includes('making you a stone_hoe'), `lines: ${bot.lines}`)
    assert.ok(bot.lines.includes('equipped stone_hoe'), `lines: ${bot.lines}`)
    assert.deepEqual(bot.tossCalls, [])
  })

  it("'craft iron axe' with raw iron opens the smelt gap", () => {
    const bot = mockBot({ items: [{ name: 'raw_iron', count: 3 }], playerPos: pos(30, 64, 0) })
    handleChat(bot, tickerFor(bot), 'P', 'craft iron axe')
    assert.deepEqual(bot.lines, ['smelting 3 raw_iron for your iron_axe'])
    assert.equal(bot._tickerCtx.bring.toolName, 'iron_axe')
    assert.equal(bot._tickerCtx.bring.phase, 'smelt')
  })

  it('an unobtainable tool refuses honestly', () => {
    const bot = mockBot({ playerPos: pos(30, 64, 0), recipes: {} })
    handleChat(bot, tickerFor(bot), 'P', 'make me a stone hoe')
    assert.deepEqual(bot.lines, ["can't get stone_hoe: no recipe, no source"])
    assert.ok(!bot._tickerCtx.bring, 'no order created')
  })
})
