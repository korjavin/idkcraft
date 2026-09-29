'use strict'

// Gear acceptance metrics (idkcraft-ipn.5): forges and handovers counted by
// piece, so the night's MEASURE (time-to-sword, deliver-vs-stockpile) reads
// off Prometheus instead of log archaeology. Deltas, not absolutes: the
// registry is module-global and shared across tests in this file.

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const gear = require('../src/behaviours/gear')
const stockpile = require('../src/behaviours/stockpile')
const metrics = require('../src/metrics')

const tick = (ms) => new Promise((resolve) => setTimeout(resolve, ms || 30))

function pos(x, y, z) {
  return {
    x, y, z,
    distanceTo: (q) => Math.hypot(x - q.x, y - q.y, z - q.z),
    clone() { return pos(x, y, z) },
    floored() { return { x: Math.floor(x), y: Math.floor(y), z: Math.floor(z) } },
  }
}

function mockBot({ items = [], ids = {}, recipes = {}, cells = {}, slots = null } = {}) {
  const lines = []
  const calls = { craft: [], goals: [] }
  const itemsByName = {}
  for (const [name, id] of Object.entries(ids)) itemsByName[name] = { id }
  const bot = {
    lines, calls,
    _items: items,
    entity: { position: pos(0, 64, 0), onGround: true },
    registry: { itemsByName },
    inventory: { items: () => bot._items, slots },
    recipesFor: (id) => {
      const name = Object.keys(ids).find((n) => ids[n] === id)
      if (!(name in recipes)) throw new Error(`unexpected recipesFor(${name})`)
      const r = recipes[name]
      return r ? [r] : []
    },
    craft: async (recipe, count, table) => {
      calls.craft.push({ recipe, count, table: !!table })
      if (recipe && recipe.provides) bot._items.push({ name: recipe.provides, count: (recipe.n || 1) * count })
    },
    blockAt: (p) => {
      const name = cells[`${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`]
      if (!name) return null
      return { name, position: pos(p.x, p.y, p.z) }
    },
    pathfinder: {
      setGoal: (goal) => { calls.goals.push(goal) },
      isMoving: () => false,
    },
    time: { timeOfDay: 6000 },
    players: {},
    chat: (line) => { lines.push(String(line)) },
  }
  return bot
}

function chestBot(items) {
  const ids = {}
  let next = 1
  const idOf = (name) => (ids[name] = ids[name] || next++)
  for (const i of items) idOf(i.name)
  const lines = []
  const bot = {
    lines,
    _items: items,
    entity: { position: pos(5.5, 64.5, 1.5), onGround: true },
    registry: { itemsByName: new Proxy({}, { get: (_, n) => ({ id: idOf(n) }) }) },
    inventory: { items: () => bot._items },
    blockAt: (p) => ({ name: 'chest', position: pos(p.x, p.y, p.z) }),
    pathfinder: { setGoal: () => {}, isMoving: () => false },
    openChest: async () => ({
      containerItems: () => [],
      deposit: async (type, _meta, count) => {
        const name = Object.keys(ids).find((k) => ids[k] === type)
        let n = count
        for (let k = bot._items.length - 1; k >= 0 && n > 0; k--) {
          if (bot._items[k].name !== name) continue
          const take = Math.min(bot._items[k].count, n)
          bot._items[k].count -= take
          n -= take
          if (bot._items[k].count <= 0) bot._items.splice(k, 1)
        }
      },
      close: async () => {},
    }),
    chat: (line) => { lines.push(String(line)) },
  }
  return bot
}

const home = (over) => ({ site: { x: 0, y: 64, z: 0 }, built: true, table: { x: 0, y: 64, z: 0 }, ...(over || {}) })

async function counterVal(name, labels) {
  const text = await metrics.client.register.metrics()
  for (const line of text.split('\n')) {
    if (!line.startsWith(`${name}{`)) continue
    const ok = Object.entries(labels).every(([k, v]) => line.includes(`${k}="${v}"`))
    if (!ok) continue
    const m = line.match(/\} ([0-9.eE+-]+)$/)
    if (m) return parseFloat(m[1])
  }
  return 0
}

describe('gear acceptance metrics (ipn.5)', () => {
  it('owner forge counts gear_forged_total{piece,owner}', async () => {
    const before = await counterVal('idkcraft_bot_gear_forged_total', { piece: 'iron_sword', owner: 'owner' })
    const bot = mockBot({
      items: [{ name: 'iron_pickaxe', count: 1 }, { name: 'water_bucket', count: 2 }, { name: 'iron_ingot', count: 2 }, { name: 'stick', count: 1 }],
      ids: { iron_sword: 21 },
      recipes: { iron_sword: { provides: 'iron_sword' } },
      cells: { '0,64,0': 'crafting_table' },
    })
    const ctx = { home: home(), stepStatus: 'running' }
    gear(bot, ctx)
    await tick(700)
    assert.ok(bot.lines.some((l) => l.includes('forged iron_sword for you')), 'forge happened')
    const after = await counterVal('idkcraft_bot_gear_forged_total', { piece: 'iron_sword', owner: 'owner' })
    assert.equal(after - before, 1)
  })

  it('self forge counts gear_forged_total{piece,self}', async () => {
    const before = await counterVal('idkcraft_bot_gear_forged_total', { piece: 'iron_pickaxe', owner: 'self' })
    const bot = mockBot({
      items: [{ name: 'iron_ingot', count: 3 }, { name: 'stick', count: 2 }],
      ids: { iron_pickaxe: 22 },
      recipes: { iron_pickaxe: { provides: 'iron_pickaxe' } },
      cells: { '0,64,0': 'crafting_table' },
    })
    const ctx = { home: home(), stepStatus: 'running' }
    gear(bot, ctx)
    await tick(700)
    assert.ok(bot.lines.some((l) => l.includes('forged iron_pickaxe for me')), 'forge happened')
    const after = await counterVal('idkcraft_bot_gear_forged_total', { piece: 'iron_pickaxe', owner: 'self' })
    assert.equal(after - before, 1)
  })

  it('toss handover counts gear_given_total{channel=toss}, once per unit', async () => {
    const before = await counterVal('idkcraft_bot_gear_given_total', { piece: 'iron_sword', channel: 'toss' })
    const bot = mockBot({ items: [] }) // tossed: forged, pack empty, haul clear
    const ctx = { gear: { made: { iron_sword: true } }, gearFinished: { iron_sword: 1 }, gearGiven: {} }
    gear.reconcile(ctx, bot)
    assert.equal(ctx.gearGiven.iron_sword, 1, 'ledger marked handed')
    gear.reconcile(ctx, bot) // second tick: settled, must not recount
    const after = await counterVal('idkcraft_bot_gear_given_total', { piece: 'iron_sword', channel: 'toss' })
    assert.equal(after - before, 1)
  })

  it('bank handover counts gear_given_total{channel=bank}, not toss', async () => {
    const beforeBank = await counterVal('idkcraft_bot_gear_given_total', { piece: 'iron_sword', channel: 'bank' })
    const beforeToss = await counterVal('idkcraft_bot_gear_given_total', { piece: 'iron_sword', channel: 'toss' })
    const bot = chestBot([{ name: 'iron_sword', count: 1 }])
    const ctx = {
      home: { site: { x: 0, y: 64, z: 0 }, built: true, chest: { x: 5, y: 64, z: 1 } },
      lastGoalKey: '', stepStatus: 'running',
      gear: { made: { iron_sword: true } }, gearFinished: { iron_sword: 1 }, gearGiven: {},
    }
    stockpile(bot, ctx)
    stockpile(bot, ctx)
    await tick(80)
    assert.equal(ctx.gearGiven.iron_sword, 1, 'ledger marked handed')
    const afterBank = await counterVal('idkcraft_bot_gear_given_total', { piece: 'iron_sword', channel: 'bank' })
    const afterToss = await counterVal('idkcraft_bot_gear_given_total', { piece: 'iron_sword', channel: 'toss' })
    assert.equal(afterBank - beforeBank, 1)
    assert.equal(afterToss - beforeToss, 0, 'the bank channel owns it')
  })

  it('death with a stale haul counts nothing', async () => {
    const beforeToss = await counterVal('idkcraft_bot_gear_given_total', { piece: 'iron_sword', channel: 'toss' })
    const beforeBank = await counterVal('idkcraft_bot_gear_given_total', { piece: 'iron_sword', channel: 'bank' })
    const bot = mockBot({ items: [] }) // died: pack empty but the haul claim stands
    const ctx = { gear: { made: { iron_sword: true } }, gearFinished: { iron_sword: 1 }, gearGiven: {}, haul: { iron_sword: 1 } }
    gear.reconcile(ctx, bot)
    assert.deepEqual(ctx.gearGiven, {}, 'no handover without the toss')
    const afterToss = await counterVal('idkcraft_bot_gear_given_total', { piece: 'iron_sword', channel: 'toss' })
    const afterBank = await counterVal('idkcraft_bot_gear_given_total', { piece: 'iron_sword', channel: 'bank' })
    assert.equal(afterToss - beforeToss, 0)
    assert.equal(afterBank - beforeBank, 0)
  })
})
