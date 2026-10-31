'use strict'

// All-chests lookup (idkcraft-0jvh follow-up): the bot uses every chest on
// the map, not only the home chest. Sighted non-home chests persist in the
// bot's disk memory (memory.js `chests`) and the chest-first material
// lookup checks nearby ones after the home chest comes up short.

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const bring = require('../src/behaviours/bring')
const stockpile = require('../src/behaviours/stockpile')
const memory = require('../src/memory')
const { makeScout } = require('../src/behaviours/scout')
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

const HOME_CHEST = { x: 5, y: 64, z: 1 }
const NEAR_CHEST = { x: 12, y: 64, z: 0 }
const FAR_CHEST = { x: 200, y: 64, z: 0 }
const keyOf = (p) => `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`

const BLOCKS = { stone: 1, chest: 40, crafting_table: 41 }
const ITEMS = {
  stone_hoe: 201, cobblestone: 113, stick: 115, oak_log: 118,
  oak_planks: 119, crafting_table: 120, coal: 21,
}

// Fake recipe with the real shape (delta negatives = consumed);
// bot.craft lands the product generically, bot.equip records the held item.
function R(product, takes, resCount, reqTable) {
  const delta = takes.map(([n, c]) => ({ id: ITEMS[n], count: -c }))
  delta.push({ id: ITEMS[product], count: resCount })
  return { delta, result: { count: resCount }, requiresTable: !!reqTable, product }
}

function RECIPES() {
  return {
    stone_hoe: [R('stone_hoe', [['cobblestone', 3], ['stick', 2]], 1, true)],
    stick: [R('stick', [['oak_planks', 2]], 4, false)],
    oak_planks: [R('oak_planks', [['oak_log', 1]], 4, false)],
    crafting_table: [R('crafting_table', [['oak_planks', 4]], 1, false)],
  }
}

// chests: { 'x,y,z': [{ name, count }] } — per-position contents, so the
// test can tell which chest a fetch opened. opens records each openChest
// call's target key in order.
function mockBot({ items = [], chests = {}, names = {}, playerPos = null } = {}) {
  const lines = []
  const tossCalls = []
  const calls = { setGoal: 0, goals: [], opens: [] }
  const blocksByName = {}
  for (const [name, id] of Object.entries(BLOCKS)) blocksByName[name] = { id }
  const itemsByName = {}
  for (const [name, id] of Object.entries(ITEMS)) itemsByName[name] = { id }
  const byId = {}
  for (const [name, id] of Object.entries(ITEMS)) byId[id] = name
  const table = RECIPES()
  const bot = {
    lines, tossCalls, calls, chests,
    username: 'IdkBot',
    entities: {},
    health: 20,
    food: 20,
    held: null,
    entity: { position: pos(0, 64, 0), onGround: true },
    registry: { blocksByName, itemsByName },
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
    recipesAll: (id) => (table[byId[id]] || []),
    recipesFor: (id) => (table[byId[id]] || []),
    craft: async (recipe, count) => {
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
    findBlocks: (opts) => {
      const want = new Set(Array.isArray(opts.matching) ? opts.matching : [opts.matching])
      const spots = Object.keys(names)
        .filter((k) => names[k] === 'chest')
        .map((k) => { const [x, y, z] = k.split(',').map(Number); return { x, y, z } })
      return spots.filter((q) => {
        const n = names[`${q.x},${q.y},${q.z}`]
        const id = n && blocksByName[n] ? blocksByName[n].id : undefined
        return want.has(id)
      })
    },
    blockAt(p) {
      const n = names[`${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`]
      if (!n) return null
      return { name: n, position: pos(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)) }
    },
    openChest: async (block) => {
      const k = block && block.position ? keyOf(block.position) : 'unknown'
      calls.opens.push(k)
      const store = chests[k] || []
      return {
        containerItems: () => store.map((s) => ({ name: s.name, type: itemsByName[s.name].id, metadata: null, count: s.count })),
        withdraw: async (type, _meta, count) => {
          const name = byId[type]
          let n = count
          for (let i = store.length - 1; i >= 0 && n > 0; i--) {
            if (store[i].name !== name) continue
            const take = Math.min(store[i].count, n)
            store[i].count -= take
            n -= take
            if (store[i].count <= 0) store.splice(i, 1)
          }
          const got = count - n
          if (got > 0) {
            const at = bot._items.find((it) => it.name === name)
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

// Drive an order to the end, teleporting along the chest walk goals the
// rung issues (parsed from ctx.lastGoalKey). Table/player teleports cover
// the craft and return legs, like the bring-tools drive.
async function drive(bot, ctx) {
  for (let i = 0; i < 80 && ctx.bring; i++) {
    await bring(bot, ctx, null, {})
    const o = ctx.bring
    if (!o) break
    // runOp's async completion (craft settle windows) needs real time,
    // like the chest window ops — the bring-tools drive shape.
    if (ctx.gearInFlight || o.chestInFlight) {
      await sleep(650)
      continue
    }
    await flush()
    if (o.phase === 'chestfetch' && typeof ctx.lastGoalKey === 'string') {
      const m = ctx.lastGoalKey.match(/bring-chest:(-?\d+),(-?\d+),(-?\d+)/)
      if (m) { bot._moving = false; bot.entity.position = pos(+m[1], +m[2], +m[3]) }
    }
    if (o.phase === 'craft') { bot._moving = false; bot.entity.position = pos(0, 64, 0) }
    if (o.phase === 'return') {
      const pp = bot.players.P.entity.position
      bot.entity.position = pos(pp.x, pp.y, pp.z)
    }
  }
}

function chestHome(ctx) {
  ctx.home = { site: { x: 0, y: 64, z: 0 }, built: true, table: { x: 0, y: 64, z: 0 }, chest: { ...HOME_CHEST } }
}

function chestCells(extra = {}) {
  return { '5,64,1': 'chest', '0,64,0': 'crafting_table', ...extra }
}

describe('remembered chest sightings', () => {
  it('the scout tick records sighted chests, deduped', () => {
    const bot = mockBot({ names: { '12,64,0': 'chest' } })
    const ctx = {}
    makeScout(bot, { everyMs: 0, ctx }).tick()
    assert.deepEqual(ctx.chests, [{ x: 12, y: 64, z: 0 }])
    makeScout(bot, { everyMs: 0, ctx }).tick()
    assert.deepEqual(ctx.chests, [{ x: 12, y: 64, z: 0 }])
  })

  it('the sighting list is capped and drops the oldest', () => {
    const ctx = {}
    const many = []
    for (let i = 0; i < 40; i++) many.push({ x: i, y: 64, z: 0 })
    stockpile.rememberChests(ctx, many)
    assert.equal(ctx.chests.length, stockpile.CHEST_SIGHT_MAX)
    assert.deepEqual(ctx.chests[0], { x: 8, y: 64, z: 0 })
    assert.deepEqual(ctx.chests[ctx.chests.length - 1], { x: 39, y: 64, z: 0 })
    // A duplicate of a kept entry adds nothing.
    stockpile.rememberChests(ctx, [{ x: 10, y: 64, z: 0 }])
    assert.equal(ctx.chests.length, stockpile.CHEST_SIGHT_MAX)
  })

  it('disk memory round-trips sightings and never wipes them', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chests-'))
    try {
      const file = path.join(dir, 'bot.json')
      const bot = { username: 'IdkBot', spawnPoint: { x: 0, y: 64, z: 0 } }
      const ctx1 = { home: { site: { x: 0, y: 64, z: 0 }, built: true }, chests: [{ x: 12, y: 64, z: 0 }] }
      assert.equal(memory.save(bot, ctx1, file, Date.now()), true)
      const ctx2 = {}
      const back = memory.restore(bot, ctx2, file, Date.now())
      assert.ok(back)
      assert.deepEqual(ctx2.chests, [{ x: 12, y: 64, z: 0 }])
      assert.equal(back.chests, 1)
      // An unrestored ctx (no chests key) saves the home without wiping.
      const ctx3 = { home: { site: { x: 0, y: 64, z: 0 }, built: true } }
      assert.equal(memory.save(bot, ctx3, file, Date.now()), true)
      const ctx4 = {}
      memory.restore(bot, ctx4, file, Date.now())
      assert.deepEqual(ctx4.chests, [{ x: 12, y: 64, z: 0 }])
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("'make me a stone hoe' with an empty home chest", () => {
  it('opens the remembered nearby chest holding the mats and equips', async () => {
    const bot = mockBot({
      chests: { '5,64,1': [], '12,64,0': [{ name: 'cobblestone', count: 3 }, { name: 'stick', count: 2 }] },
      names: chestCells({ '12,64,0': 'chest' }),
      playerPos: pos(30, 64, 0),
    })
    const ticker = tickerFor(bot)
    chestHome(bot._tickerCtx)
    bot._tickerCtx.chests = [{ ...NEAR_CHEST }]
    handleChat(bot, ticker, 'P', 'make me a stone hoe')
    assert.deepEqual(bot.lines, ['checking the home chest for stone_hoe'])
    await drive(bot, bot._tickerCtx)
    assert.ok(!bot._tickerCtx.bring, 'order completed')
    assert.equal(bot.held, 'stone_hoe')
    // The fetch targeted the remembered chest after the empty home one: the
    // family window plus the two mat-draw windows (sticks, cobblestone).
    assert.equal(bot.calls.opens[0], '5,64,1')
    assert.deepEqual(bot.calls.opens.slice(1), ['12,64,0', '12,64,0', '12,64,0'])
    assert.ok(bot.lines.includes('checking a nearby chest for stone_hoe'), `lines: ${bot.lines}`)
    assert.ok(bot.lines.includes('making you a stone_hoe'), `lines: ${bot.lines}`)
    assert.ok(bot.lines.includes('equipped stone_hoe'), `lines: ${bot.lines}`)
  })

  it('a far-away remembered chest is skipped', async () => {
    const bot = mockBot({
      chests: { '5,64,1': [], '200,64,0': [{ name: 'cobblestone', count: 3 }, { name: 'stick', count: 2 }] },
      names: chestCells({ '200,64,0': 'chest' }),
      playerPos: pos(30, 64, 0),
    })
    const ticker = tickerFor(bot)
    chestHome(bot._tickerCtx)
    bot._tickerCtx.chests = [{ ...FAR_CHEST }]
    handleChat(bot, ticker, 'P', 'make me a stone hoe')
    assert.deepEqual(bot.lines, ['checking the home chest for stone_hoe'])
    // Drive the chest rung only: the gap sub would wander the mock world.
    // Only tick while the order sits on the rung — a find tick would run
    // the sub's search legs instead of holding the gap.
    for (let i = 0; i < 40; i++) {
      const o = bot._tickerCtx.bring
      if (!o || (o.phase !== 'chestfetch' && !o.chestInFlight)) break
      await bring(bot, bot._tickerCtx, null, {})
      if (!bot._tickerCtx.bring) break
      if (bot._tickerCtx.bring.chestInFlight) { await sleep(650); continue }
      await flush()
      const m = (bot._tickerCtx.lastGoalKey || '').match(/bring-chest:(-?\d+),(-?\d+),(-?\d+)/)
      if (m) { bot._moving = false; bot.entity.position = pos(+m[1], +m[2], +m[3]) }
    }
    const o = bot._tickerCtx.bring
    assert.ok(o, 'order still open on the sticks gap')
    assert.equal(o.subFor, 'stone_hoe')
    // Only the home chest was ever opened — the family window plus the two
    // empty mat-draw windows. The far one was never walked to nor opened.
    assert.ok(bot.calls.opens.length > 0)
    assert.ok(bot.calls.opens.every((k) => k === '5,64,1'), `opens: ${bot.calls.opens}`)
    assert.ok(!bot.lines.some((l) => l.includes('nearby chest')), `lines: ${bot.lines}`)
  })
})

describe("'bring me coal' with an empty home chest", () => {
  it('tops up from the remembered nearby chest, then returns', async () => {
    const bot = mockBot({
      names: { '5,64,1': 'chest', '12,64,0': 'chest' },
      items: [],
      chests: { '5,64,1': [], '12,64,0': [{ name: 'coal', count: 5 }] },
      playerPos: pos(30, 64, 0),
    })
    const ticker = tickerFor(bot)
    const ctx = bot._tickerCtx
    chestHome(ctx)
    ctx.chests = [{ ...NEAR_CHEST }]
    handleChat(bot, ticker, 'P', 'bring me coal')
    await drive(bot, ctx)
    assert.equal(ctx.bring, null)
    assert.deepEqual(bot.calls.opens, ['5,64,1', '12,64,0'])
    assert.ok(bot.lines.includes('checking a nearby chest for coal'), `lines: ${bot.lines}`)
    assert.ok(bot.lines.includes('here are 3 coal'), `lines: ${bot.lines}`)
  })
})
