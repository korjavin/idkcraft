'use strict'

// Home chest without a standing table (idkcraft-ipn.16): placeChest used to
// fail no-chest in the same tick, so a built home with no table never got a
// chest and a 36/36 pack never drained. Now craftany places a table from
// the planks and crafts the chest at it; with no wood at all it still fails
// no-chest, loud.

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const stockpile = require('../src/behaviours/stockpile')

function pos(x, y, z) {
  return {
    x, y, z,
    distanceTo: (q) => Math.hypot(x - q.x, y - q.y, z - q.z),
    clone() { return pos(x, y, z) },
    floored() { return pos(Math.floor(x), Math.floor(y), Math.floor(z)) },
    offset(dx, dy, dz) { return pos(x + dx, y + dy, z + dz) },
  }
}

const ITEMS = { oak_planks: 1, crafting_table: 2, chest: 3, dirt: 4, cobblestone: 5 }
const byId = Object.fromEntries(Object.entries(ITEMS).map(([n, id]) => [id, n]))
function R(product, takes, reqTable) {
  const delta = takes.map(([n, c]) => ({ id: ITEMS[n], count: -c }))
  delta.push({ id: ITEMS[product], count: 1 })
  return { delta, result: { id: ITEMS[product], count: 1 }, requiresTable: reqTable, product }
}
const RECIPES = {
  crafting_table: [R('crafting_table', [['oak_planks', 4]], false)],
  chest: [R('chest', [['oak_planks', 8]], true)],
}

function fakeBot(inv) {
  const cells = {}
  const calls = { craft: [], place: [] }
  let held = null
  const itemsByName = {}
  for (const [n, id] of Object.entries(ITEMS)) itemsByName[n] = { id, name: n, stackSize: 64 }
  const bot = {
    inv, calls, cells,
    username: 'IdkBot',
    players: {},
    entity: { position: pos(4, 64, 1), onGround: true },
    world: { getBlock: () => null },
    registry: { itemsByName, items: Object.fromEntries(Object.entries(itemsByName).map(([, e]) => [e.id, e])) },
    pathfinder: { goal: null, setGoal: (g) => { bot.pathfinder.goal = g }, isMoving: () => false },
    inventory: { items: () => bot.inv, slots: [], emptySlotCount: () => 36 - bot.inv.length },
    _syncWindow: async () => {},
    blockAt: (p) => {
      const k = `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`
      return { name: cells[k] || (p.y < 64 ? 'dirt' : 'air'), position: pos(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)), boundingBox: cells[k] || p.y < 64 ? 'block' : 'empty' }
    },
    recipesAll: (id) => RECIPES[byId[id]] || [],
    recipesFor: (id) => RECIPES[byId[id]] || [],
    craft: async (recipe, count) => {
      calls.craft.push(recipe.product)
      for (const d of recipe.delta) {
        if (d.count >= 0) continue
        let n = -d.count * count
        for (const s of bot.inv) {
          if (n <= 0) break
          if (s.name !== byId[d.id]) continue
          const take = Math.min(s.count, n)
          s.count -= take
          n -= take
        }
      }
      bot.inv = bot.inv.filter((s) => s.count > 0)
      bot.inv.push({ name: recipe.product, count: count })
    },
    equip: async (item) => { held = item && item.name },
    placeBlock: async (ref, face) => {
      const p = ref.position
      const f = face || { x: 0, y: 1, z: 0 }
      const name = held || 'air'
      calls.place.push(name)
      cells[`${p.x + f.x},${p.y + f.y},${p.z + f.z}`] = name
      const ix = bot.inv.findIndex((i) => i.name === name)
      if (ix >= 0) {
        bot.inv[ix].count -= 1
        if (bot.inv[ix].count <= 0) bot.inv.splice(ix, 1)
      }
    },
    chat: () => {},
  }
  return bot
}

const homeCtx = () => ({
  lastGoalKey: null,
  stepStatus: 'running',
  home: { site: { x: 0, y: 64, z: 0 }, built: true, chest: null },
})
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// Tick the step like the brain: wait out the in-flight windows.
async function drive(bot, ctx, until, max = 40) {
  for (let i = 0; i < max && !until(); i++) {
    if (ctx.gearInFlight || ctx.stockpileInFlight) { await sleep(100); continue }
    if (String(ctx.stepStatus).startsWith('failed')) break
    stockpile(bot, ctx, null, {})
    await sleep(20)
  }
}

describe('stockpile chest without a standing table (idkcraft-ipn.16)', () => {
  it('36/36 planks pack, no table: places a table, crafts the chest, places and adopts it, banks planks', async () => {
    // Two small plank stacks fund the table (4) and the chest (8) and free
    // their slots; the rest is the prod-shaped 36/36 plank/cobble pile.
    const inv = [{ name: 'oak_planks', count: 4 }, { name: 'oak_planks', count: 8 }]
    for (let i = 0; i < 12; i++) inv.push({ name: 'oak_planks', count: 64 })
    while (inv.length < 36) inv.push({ name: 'cobblestone', count: 64 })
    const bot = fakeBot(inv)
    const ctx = homeCtx()
    assert.equal(stockpile.chestTodo(bot, ctx, 64), 'place', 'the menu offers the step with no table')
    await drive(bot, ctx, () => !!ctx.home.chest)
    assert.notEqual(ctx.stepStatus, 'failed:no-chest')
    assert.deepEqual(bot.calls.craft, ['crafting_table', 'chest'])
    assert.deepEqual(bot.calls.place, ['crafting_table', 'chest'], 'table placed first, then the chest')
    assert.ok(ctx.home.chest, `chest adopted, status=${ctx.stepStatus}`)
    assert.equal(ctx.craftany, null, 'the finished chest run is dropped')
    // Next ticks: the adopted chest banks the plank surplus.
    const deposits = []
    bot.openChest = async () => ({
      containerItems: () => [],
      deposit: async (type, _m, count) => {
        const name = byId[type]
        deposits.push({ name, count })
        let n = count
        for (const s of bot.inv) {
          if (n <= 0) break
          if (s.name !== name) continue
          const take = Math.min(s.count, n)
          s.count -= take
          n -= take
        }
        bot.inv = bot.inv.filter((s) => s.count > 0)
      },
      close: () => {},
    })
    ctx.stepStatus = 'running'
    ctx.lastGoalKey = null
    await drive(bot, ctx, () => deposits.length > 0)
    const planks = deposits.filter((d) => d.name === 'oak_planks').reduce((a, d) => a + d.count, 0)
    assert.ok(planks > 0, `deposits: ${JSON.stringify(deposits)}`)
    assert.ok(bot.inv.length < 36, 'the pack drained')
  })

  it('no planks and no table: fails no-chest at once with a logged reason', () => {
    const bot = fakeBot([{ name: 'cobblestone', count: 64 }])
    bot.players = {}
    const ctx = homeCtx()
    const logs = []
    const orig = console.log
    console.log = (...a) => { logs.push(a.join(' ')) }
    try {
      stockpile(bot, ctx, null, {})
    } finally { console.log = orig }
    assert.equal(ctx.stepStatus, 'failed:no-chest')
    assert.deepEqual(bot.calls.craft, [])
    assert.ok(logs.some((l) => l.startsWith('stockpile failed no-chest no-table: ') && l.includes("can't make chest")), `logs: ${logs}`)
  })

  it('a standing home table keeps the old path: no table placed, chest crafted there', async () => {
    const bot = fakeBot([{ name: 'oak_planks', count: 16 }])
    bot.cells['4,64,2'] = 'crafting_table'
    const ctx = homeCtx()
    ctx.home.table = { x: 4, y: 64, z: 2 }
    ctx.craftany = { key: 'chestx1' } // a run left over from the table leg
    await drive(bot, ctx, () => !!ctx.home.chest)
    assert.deepEqual(bot.calls.craft, ['chest'])
    assert.deepEqual(bot.calls.place, ['chest'])
    assert.equal(ctx.craftany, null, 'the standing table drops the stale run')
  })

  it('far from the chest spot: walks there before craftany places a table', () => {
    const bot = fakeBot([{ name: 'oak_planks', count: 16 }])
    bot.entity.position = pos(40, 64, 40)
    const ctx = homeCtx()
    stockpile(bot, ctx, null, {})
    assert.equal(bot.pathfinder.goal && bot.pathfinder.goal.constructor.name, 'GoalNear')
    assert.deepEqual(bot.calls.craft, [])
    assert.equal(ctx.craftany, undefined)
  })
})
