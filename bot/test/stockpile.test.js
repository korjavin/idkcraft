'use strict'

// Home chest stockpile (idkcraft-atl.14): keeps, spot scan, withdraw
// helpers and the step behaviour against a fake chest window.

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const stockpile = require('../src/behaviours/stockpile')

function pos(x, y, z) {
  return {
    x, y, z,
    distanceTo: (q) => Math.hypot(x - q.x, y - q.y, z - q.z),
    clone() { return pos(x, y, z) },
    floored() { return { x: Math.floor(x), y: Math.floor(y), z: Math.floor(z) } },
  }
}

// Fake block world: key 'x,y,z' -> name, default 'air'. Solid ground plane
// at y=63 (dirt) so dy-0 spots always have ground unless overridden.
function world(over = {}) {
  const cells = { ...over }
  return {
    cells,
    blockAt: (p) => ({ name: cells[`${p.x},${p.y},${p.z}`] || (p.y < 64 ? 'dirt' : 'air'), position: pos(p.x, p.y, p.z) }),
  }
}

function mockBot({ inv = [], cells = {}, chest = [], failDeposit = false, failOpen = false, failDig = false } = {}) {
  const w = world(cells)
  const chats = []
  const calls = { goals: [], opens: 0, deposits: [], withdraws: [], closes: 0, digs: [] }
  const ids = {}
  let nextId = 1
  const idOf = (name) => {
    if (!(name in ids)) ids[name] = nextId++
    return ids[name]
  }
  for (const i of inv) idOf(i.name)
  for (const s of chest) idOf(s.name)
  const bot = {
    calls, chats, inv, chest,
    entity: { position: pos(0, 64, 0), onGround: true },
    world: { getBlock: () => null },
    registry: { itemsByName: new Proxy({}, { get: (_, n) => ({ id: idOf(n) }) }) },
    pathfinder: {
      goal: null,
      setGoal: (g) => { calls.goals.push(g && g.constructor && g.constructor.name); bot.pathfinder.goal = g },
      isMoving: () => false,
    },
    inventory: { items: () => inv },
    blockAt: (p) => w.blockAt(p),
    equip: async () => {},
    dig: async (cell) => {
      if (failDig) throw new Error('dig refused')
      calls.digs.push(cell && cell.name)
      const q = cell && cell.position
      if (q) delete w.cells[`${Math.floor(q.x)},${Math.floor(q.y)},${Math.floor(q.z)}`]
    },
    placeBlock: async (ref, face) => {
      const p = ref && ref.position ? ref.position : { x: 5, y: 63, z: 1 }
      const f = face || { x: 0, y: 1, z: 0 }
      w.cells[`${p.x + f.x},${p.y + f.y},${p.z + f.z}`] = 'chest'
      const ix = inv.findIndex((i) => i.name === 'chest')
      if (ix >= 0) {
        if (inv[ix].count <= 1) inv.splice(ix, 1)
        else inv[ix].count--
      }
    },
    openChest: async () => {
      calls.opens++
      if (failOpen) throw new Error('chest blocked')
      return {
        containerItems: () => chest.map((s) => ({ name: s.name, type: idOf(s.name), metadata: null, count: s.count })),
        deposit: async (type, _meta, count) => {
          if (failDeposit) throw new Error('full')
          const name = Object.keys(ids).find((k) => ids[k] === type)
          let n = count
          for (let k = inv.length - 1; k >= 0 && n > 0; k--) {
            if (inv[k].name !== name) continue
            const take = Math.min(inv[k].count, n)
            inv[k].count -= take
            n -= take
            calls.deposits.push(`${take} ${name}`)
            if (inv[k].count <= 0) inv.splice(k, 1)
          }
          const at = chest.find((s) => s.name === name)
          if (at) at.count += count - n
          else if (count - n > 0) chest.push({ name, count: count - n })
        },
        withdraw: async (type, _meta, count) => {
          const name = Object.keys(ids).find((k) => ids[k] === type)
          let n = count
          for (let k = chest.length - 1; k >= 0 && n > 0; k--) {
            if (chest[k].name !== name) continue
            const take = Math.min(chest[k].count, n)
            chest[k].count -= take
            n -= take
            calls.withdraws.push(`${take} ${name}`)
            if (chest[k].count <= 0) chest.splice(k, 1)
          }
          const got = count - n
          if (got > 0) {
            const at = inv.find((i) => i.name === name)
            if (at) at.count += got
            else inv.push({ name, count: got })
          }
        },
        close: () => { calls.closes++ },
      }
    },
    chat: (m) => { chats.push(String(m)) },
  }
  return bot
}

function homeCtx(over = {}) {
  return {
    lastGoalKey: null, stepStatus: 'running',
    home: { site: { x: 0, y: 64, z: 0 }, built: true, chest: null, ...(over.home || {}) },
    ...over.ctx,
  }
}

const flush = () => new Promise((r) => { setImmediate(() => setImmediate(r)) })

describe('stockpile depositPlan', () => {
  it('banks logs, planks and ores, keeps tools and light fuel', () => {
    const bot = mockBot({ inv: [
      { name: 'oak_log', count: 10 }, { name: 'oak_planks', count: 20 },
      { name: 'coal', count: 4 }, { name: 'torch', count: 8 }, { name: 'stick', count: 2 },
      { name: 'stone_pickaxe', count: 1 }, { name: 'stone_sword', count: 1 },
      { name: 'iron_helmet', count: 1 }, { name: 'shears', count: 1 },
    ] })
    assert.deepEqual(stockpile.depositPlan(bot), [
      { name: 'oak_log', count: 10 }, { name: 'oak_planks', count: 20 },
    ])
  })

  it('keeps the first 10 edibles and banks the rest', () => {
    const bot = mockBot({ inv: [{ name: 'bread', count: 14 }, { name: 'apple', count: 3 }] })
    assert.deepEqual(stockpile.depositPlan(bot), [
      { name: 'bread', count: 4 }, { name: 'apple', count: 3 },
    ])
    assert.equal(stockpile.surplusCount(bot), 7)
  })

  it('keeps the 32-block pillar reserve, dirt first', () => {
    const bot = mockBot({ inv: [{ name: 'dirt', count: 20 }, { name: 'cobblestone', count: 20 }] })
    assert.deepEqual(stockpile.depositPlan(bot), [{ name: 'cobblestone', count: 8 }])
  })

  it('empty pack has no surplus', () => {
    const bot = mockBot({ inv: [{ name: 'stone_pickaxe', count: 1 }, { name: 'bread', count: 5 }] })
    assert.deepEqual(stockpile.depositPlan(bot), [])
    assert.equal(stockpile.surplusCount(bot), 0)
  })
})

describe('stockpile chestSpotFor', () => {
  it('prefers table+1 east (5,0,1)', () => {
    const bot = mockBot()
    const ctx = homeCtx()
    assert.deepEqual(stockpile.chestSpotFor(bot, ctx), { x: 5, y: 64, z: 1, adopt: false })
  })

  it('adopts a chest an earlier run left behind', () => {
    const bot = mockBot({ cells: { '5,64,1': 'chest' } })
    const ctx = homeCtx()
    assert.deepEqual(stockpile.chestSpotFor(bot, ctx), { x: 5, y: 64, z: 1, adopt: true })
  })

  it('falls back when the preferred cell is blocked or hanging', () => {
    const bot = mockBot({ cells: { '5,64,1': 'stone', '5,63,1': 'air' } })
    const ctx = homeCtx()
    const spot = stockpile.chestSpotFor(bot, ctx)
    assert.deepEqual(spot, { x: 4, y: 64, z: 0, adopt: false })
  })

  it('returns null with no site or no ground anywhere', () => {
    const bot = mockBot()
    assert.equal(stockpile.chestSpotFor(bot, {}), null)
    const cells = {}
    for (const s of stockpile.CHEST_SPOTS) cells[`${s.dx},63,${s.dz}`] = 'air'
    const air = mockBot({ cells })
    assert.equal(stockpile.chestSpotFor(air, homeCtx()), null)
  })

  it('adopts a chest at a later spot over air at the first', () => {
    const bot = mockBot({ cells: { '4,64,0': 'chest' } })
    assert.deepEqual(stockpile.chestSpotFor(bot, homeCtx()), { x: 4, y: 64, z: 0, adopt: true })
  })

  it('treats clearable flora as placeable, skips torches', () => {
    const grass = mockBot({ cells: { '5,64,1': 'short_grass' } })
    assert.deepEqual(stockpile.chestSpotFor(grass, homeCtx()), { x: 5, y: 64, z: 1, adopt: false })
    const torch = mockBot({ cells: { '5,64,1': 'torch' } })
    assert.deepEqual(stockpile.chestSpotFor(torch, homeCtx()), { x: 4, y: 64, z: 0, adopt: false })
  })

  it('returns unknown when no candidate is decidable', () => {
    const bot = mockBot()
    bot.blockAt = () => null
    assert.equal(stockpile.chestSpotFor(bot, homeCtx()), 'unknown')
  })
})

describe('stockpile chestTodo', () => {
  it('adopts a standing chest without anything in hand', () => {
    const bot = mockBot({ cells: { '5,64,1': 'chest' }, inv: [] })
    assert.equal(stockpile.chestTodo(bot, homeCtx(), 0), 'adopt')
  })
  it('places with a chest item or 8 same-wood planks', () => {
    const item = mockBot({ inv: [{ name: 'chest', count: 1 }] })
    assert.equal(stockpile.chestTodo(item, homeCtx(), 0), 'place')
    const planks = mockBot({ inv: [{ name: 'oak_planks', count: 8 }] })
    assert.equal(stockpile.chestTodo(planks, homeCtx(), 8), 'place')
  })
  it('adopts despite a fresh no-spot stamp', () => {
    const bot = mockBot({ cells: { '5,64,1': 'chest' }, inv: [] })
    const stamped = homeCtx({ ctx: { chestNoSpotAt: Date.now() } })
    assert.equal(stockpile.chestTodo(bot, stamped, 0), 'adopt')
  })

  it('honors a fresh no-spot stamp even when ready', () => {
    const bot = mockBot({ inv: [{ name: 'oak_planks', count: 8 }] })
    const fresh = homeCtx({ ctx: { chestNoSpotAt: Date.now() } })
    assert.equal(stockpile.chestTodo(bot, fresh, 8), 'none')
    const stale = homeCtx({ ctx: { chestNoSpotAt: Date.now() - 61 * 60 * 1000 } })
    assert.equal(stockpile.chestTodo(bot, stale, 8), 'place')
  })

  it('reports none when unready and nothing stands', () => {
    const bot = mockBot({ inv: [{ name: 'oak_planks', count: 7 }] })
    assert.equal(stockpile.chestTodo(bot, homeCtx(), 7), 'none')
    const dark = mockBot({ inv: [] })
    dark.blockAt = () => null
    assert.equal(stockpile.chestTodo(dark, homeCtx(), 0), 'none')
  })
})

describe('stockpile withdraw helpers', () => {
  function chestBot(chest) {
    const bot = mockBot({ inv: [], chest })
    const cells = { '5,64,1': 'chest' }
    bot.blockAt = world(cells).blockAt
    const ctx = homeCtx({ home: { chest: { x: 5, y: 64, z: 1 } } })
    return { bot, ctx }
  }

  it('withdraws up to the want across stacks', async () => {
    const { bot, ctx } = chestBot([{ name: 'coal', count: 3 }, { name: 'coal', count: 4 }])
    const res = await stockpile.withdrawFromChest(bot, ctx, 'coal', 5)
    assert.equal(res.got, 5)
    assert.deepEqual(bot.inv, [{ name: 'coal', count: 5 }])
    assert.equal(bot.calls.closes, 1)
  })

  it('withdraws nothing when the chest lacks the item', async () => {
    const { bot, ctx } = chestBot([{ name: 'oak_log', count: 2 }])
    const res = await stockpile.withdrawFromChest(bot, ctx, 'coal', 5)
    assert.equal(res.got, 0)
    assert.deepEqual(bot.inv, [])
  })

  it('withdraws nothing when the chest is gone', async () => {
    const { bot, ctx } = chestBot([{ name: 'coal', count: 2 }])
    bot.blockAt = world({}).blockAt
    const res = await stockpile.withdrawFromChest(bot, ctx, 'coal', 5)
    assert.equal(res.got, 0)
    assert.equal(bot.calls.opens, 0)
  })

  it('withdrawEdible takes the first edible only', async () => {
    const { bot, ctx } = chestBot([{ name: 'oak_log', count: 9 }, { name: 'bread', count: 2 }])
    const res = await stockpile.withdrawEdible(bot, ctx, 5)
    assert.deepEqual(res, { got: 2, name: 'bread' })
    assert.deepEqual(bot.inv, [{ name: 'bread', count: 2 }])
  })

  it('withdrawEdible reports null with no food', async () => {
    const { bot, ctx } = chestBot([{ name: 'oak_log', count: 9 }])
    assert.deepEqual(await stockpile.withdrawEdible(bot, ctx, 5), { got: 0, name: null })
  })

  it('a blocked open withdraws nothing and keeps the adoption', async () => {
    const bot = mockBot({ inv: [], chest: [{ name: 'coal', count: 5 }], failOpen: true })
    bot.blockAt = world({ '5,64,1': 'chest' }).blockAt
    const ctx = homeCtx({ home: { chest: { x: 5, y: 64, z: 1 } } })
    const res = await stockpile.withdrawFromChest(bot, ctx, 'coal', 5)
    assert.equal(res.got, 0)
    assert.deepEqual(ctx.home.chest, { x: 5, y: 64, z: 1 })
  })
})

describe('stockpile behaviour', () => {
  it('fails with no home', () => {
    const bot = mockBot()
    const ctx = { stepStatus: 'running' }
    stockpile(bot, ctx)
    assert.equal(ctx.stepStatus, 'failed:no-home')
  })

  it('fails with no placable spot', () => {
    const cells = {}
    for (const s of stockpile.CHEST_SPOTS) cells[`${s.dx},63,${s.dz}`] = 'air'
    const bot = mockBot({ cells })
    const ctx = homeCtx()
    stockpile(bot, ctx)
    assert.equal(ctx.stepStatus, 'failed:no-spot')
    assert.equal(typeof ctx.chestNoSpotAt, 'number')
  })

  it('adopts the chest on sight and finishes with an empty surplus', () => {
    const bot = mockBot({ cells: { '5,64,1': 'chest' }, inv: [{ name: 'bread', count: 3 }] })
    const ctx = homeCtx({ ctx: { chestFull: true, chestFullAt: 1, chestErrorAt: 2, chestNoSpotAt: 3 } })
    stockpile(bot, ctx)
    assert.deepEqual({ x: ctx.home.chest.x, y: ctx.home.chest.y, z: ctx.home.chest.z }, { x: 5, y: 64, z: 1 })
    assert.equal(typeof ctx.home.chest.floored, 'function', 'Vec3 claim (h9z): withChest blockAt()s it')
    assert.equal(ctx.stepStatus, 'done')
    assert.equal(ctx.chestFull, false) // a claim proves the chest works: parks cleared
    assert.equal(ctx.chestErrorAt, null)
    assert.equal(ctx.chestNoSpotAt, null)
  })

  it('places a carried chest, then adopts it', async () => {
    const bot = mockBot({ inv: [{ name: 'chest', count: 1 }, { name: 'bread', count: 2 }] })
    const ctx = homeCtx()
    stockpile(bot, ctx) // approach
    assert.ok(ctx.lastGoalKey.startsWith('stockpile-place:'))
    assert.deepEqual(bot.calls.goals, ['GoalPlaceBlock'])
    bot.entity.position = pos(5, 64, 1) // arrived
    stockpile(bot, ctx) // arrived: place
    await flush()
    assert.deepEqual({ x: ctx.home.chest.x, y: ctx.home.chest.y, z: ctx.home.chest.z }, { x: 5, y: 64, z: 1 })
    assert.ok(bot.chats.includes('placed the home chest'))
  })

  it('fails no-chest with neither item nor recipe', () => {
    const bot = mockBot({ inv: [{ name: 'oak_planks', count: 3 }] })
    bot.recipesFor = () => []
    const ctx = homeCtx({ home: { table: { x: 4, y: 64, z: 1 } } })
    stockpile(bot, ctx)
    assert.equal(ctx.stepStatus, 'failed:no-chest')
  })

  it('deposits the surplus and chats what moved', async () => {
    const bot = mockBot({
      cells: { '5,64,1': 'chest' },
      inv: [
        { name: 'oak_log', count: 6 }, { name: 'stone_pickaxe', count: 1 },
        { name: 'bread', count: 12 }, { name: 'dirt', count: 40 },
      ],
      chest: [],
    })
    const ctx = homeCtx({ home: { chest: { x: 5, y: 64, z: 1 } } })
    stockpile(bot, ctx) // approach
    assert.ok(ctx.lastGoalKey.startsWith('stockpile:5,64,1'))
    bot.entity.position = pos(5, 64, 1) // arrived
    stockpile(bot, ctx) // arrived: deposit
    await flush()
    assert.equal(ctx.stepStatus, 'done')
    assert.deepEqual(bot.inv, [
      { name: 'stone_pickaxe', count: 1 }, { name: 'bread', count: 10 }, { name: 'dirt', count: 32 },
    ])
    assert.ok(bot.chats.some((m) => m.startsWith('stockpiled ')), `chats: ${bot.chats.join('|')}`)
    assert.equal(ctx.chestFull, false)
  })

  it('parks itself when the chest is full', async () => {
    const bot = mockBot({
      cells: { '5,64,1': 'chest' },
      inv: [{ name: 'oak_log', count: 6 }],
      chest: [],
      failDeposit: true,
    })
    const ctx = homeCtx({ home: { chest: { x: 5, y: 64, z: 1 } } })
    stockpile(bot, ctx)
    bot.entity.position = pos(5, 64, 1) // arrived
    stockpile(bot, ctx)
    await flush()
    assert.equal(ctx.stepStatus, 'done')
    assert.equal(ctx.chestFull, true)
    assert.equal(typeof ctx.chestFullAt, 'number')
    assert.ok(bot.chats.includes('the home chest is full'))
    assert.deepEqual(bot.inv, [{ name: 'oak_log', count: 6 }])
  })

  it('re-places a mined (ghost) claim in the same step', () => {
    const bot = mockBot({ inv: [{ name: 'chest', count: 1 }] })
    const ctx = homeCtx({ home: { chest: { x: 5, y: 64, z: 1 } } })
    stockpile(bot, ctx)
    assert.equal(ctx.home.chest, null)
    assert.ok(ctx.lastGoalKey.startsWith('stockpile-place:'), ctx.lastGoalKey)
  })

  it('an unknown chunk walks closer and keeps the adoption', () => {
    const bot = mockBot({ inv: [{ name: 'oak_log', count: 6 }] })
    bot.blockAt = () => null // nothing loaded: far from home
    const ctx = homeCtx({ home: { chest: { x: 5, y: 64, z: 1 } } })
    stockpile(bot, ctx)
    assert.deepEqual(ctx.home.chest, { x: 5, y: 64, z: 1 })
    assert.ok(ctx.lastGoalKey.startsWith('stockpile:5,64,1'))
    assert.equal(ctx.stepStatus, 'running')
  })

  it('an unreachable chest fails far without opening', () => {
    const bot = mockBot({
      cells: { '5,64,1': 'chest' },
      inv: [{ name: 'oak_log', count: 6 }],
    })
    const ctx = homeCtx({ home: { chest: { x: 5, y: 64, z: 1 } } })
    stockpile(bot, ctx) // goal issued; the body stays at spawn (no path)
    stockpile(bot, ctx) // one far tick never fails: recovering pathfinder
    assert.equal(ctx.stepStatus, 'running')
    for (let i = 0; i < 4; i++) stockpile(bot, ctx)
    assert.equal(ctx.stepStatus, 'failed:far')
    assert.equal(bot.calls.opens, 0)
    assert.deepEqual(ctx.home.chest, { x: 5, y: 64, z: 1 })
  })

  it('an unreachable spot fails far without placing', () => {
    const bot = mockBot({ inv: [{ name: 'chest', count: 1 }] })
    const ctx = homeCtx()
    stockpile(bot, ctx)
    stockpile(bot, ctx) // standing at spawn, spot 5 blocks out
    assert.equal(ctx.stepStatus, 'running')
    for (let i = 0; i < 4; i++) stockpile(bot, ctx)
    assert.equal(ctx.stepStatus, 'failed:far')
  })

  it('crafts the chest at the table: walks in, then crafts', async () => {
    const bot = mockBot({
      cells: { '4,64,1': 'crafting_table' },
      inv: [{ name: 'oak_planks', count: 8 }],
    })
    bot.recipesFor = () => [{}]
    bot.craft = async () => { bot.inv.push({ name: 'chest', count: 1 }) }
    const ctx = homeCtx({ home: { table: { x: 4, y: 64, z: 1 } } })
    stockpile(bot, ctx) // far from the table: walk, do not craft
    assert.ok(ctx.lastGoalKey.startsWith('stockpile-table:'), ctx.lastGoalKey)
    assert.equal(ctx.stepStatus, 'running')
    assert.equal(bot.inv.some((i) => i.name === 'chest'), false)
    bot.entity.position = pos(4, 64, 1) // at the table
    stockpile(bot, ctx)
    await flush()
    assert.equal(bot.inv.some((i) => i.name === 'chest'), true)
  })

  it('a dark home scan walks to the site instead of failing', () => {
    const bot = mockBot({ inv: [{ name: 'oak_planks', count: 8 }] })
    bot.blockAt = () => null
    bot.entity.position = pos(200, 64, 200)
    const ctx = homeCtx()
    stockpile(bot, ctx)
    assert.ok(ctx.lastGoalKey.startsWith('stockpile-site:'), ctx.lastGoalKey)
    assert.equal(ctx.stepStatus, 'running')
    for (let i = 0; i < 5; i++) stockpile(bot, ctx) // standing, still far: no path home
    assert.equal(ctx.stepStatus, 'failed:far')
  })

  it('a blocked chest fails the deposit loudly', async () => {
    const bot = mockBot({
      cells: { '5,64,1': 'chest' },
      inv: [{ name: 'oak_log', count: 20 }],
      chest: [],
      failOpen: true,
    })
    bot.entity.position = pos(5, 64, 1)
    const ctx = homeCtx({ home: { chest: { x: 5, y: 64, z: 1 } } })
    stockpile(bot, ctx)
    stockpile(bot, ctx)
    await flush()
    assert.equal(ctx.stepStatus, 'failed:deposit')
    assert.deepEqual(ctx.home.chest, { x: 5, y: 64, z: 1 })
    assert.equal(typeof ctx.chestErrorAt, 'number')
  })

  it('digs clearable flora before placing', async () => {
    const bot = mockBot({ cells: { '5,64,1': 'short_grass' }, inv: [{ name: 'chest', count: 1 }] })
    const ctx = homeCtx()
    stockpile(bot, ctx)
    bot.entity.position = pos(5, 64, 1)
    stockpile(bot, ctx)
    await flush()
    assert.deepEqual(bot.calls.digs, ['short_grass'])
    assert.deepEqual({ x: ctx.home.chest.x, y: ctx.home.chest.y, z: ctx.home.chest.z }, { x: 5, y: 64, z: 1 })
  })

  it('a refused dig fails the step loudly', async () => {
    const bot = mockBot({ cells: { '5,64,1': 'poppy' }, inv: [{ name: 'chest', count: 1 }], failDig: true })
    bot.entity.position = pos(5, 64, 1)
    const ctx = homeCtx()
    stockpile(bot, ctx)
    stockpile(bot, ctx)
    await flush()
    assert.equal(ctx.stepStatus, 'failed:dig')
    assert.equal(ctx.home.chest, null)
  })

  it('places from a valid GoalPlaceBlock end node (+x/+z side)', async () => {
    const bot = mockBot({ inv: [{ name: 'chest', count: 1 }, { name: 'bread', count: 2 }] })
    const ctx = homeCtx()
    stockpile(bot, ctx)
    // End node at spot+(3,0,2): head-to-face is in range, feet-to-corner
    // (4.3) is not — the centre-based gate must still accept it.
    bot.entity.position = pos(8.5, 64, 3.5)
    stockpile(bot, ctx)
    await flush()
    assert.deepEqual({ x: ctx.home.chest.x, y: ctx.home.chest.y, z: ctx.home.chest.z }, { x: 5, y: 64, z: 1 })
  })

  it('a failed craft fails the step loudly', async () => {
    const bot = mockBot({
      cells: { '4,64,1': 'crafting_table' },
      inv: [{ name: 'oak_planks', count: 8 }],
    })
    bot.recipesFor = () => [{}]
    bot.craft = async () => { throw new Error('windowOpen timeout') }
    bot.entity.position = pos(4, 64, 1)
    const ctx = homeCtx({ home: { table: { x: 4, y: 64, z: 1 } } })
    stockpile(bot, ctx)
    await flush()
    assert.equal(ctx.stepStatus, 'failed:craft')
  })
})

describe('stockpile helper residuals (idkcraft-cq7)', () => {
  function adoptedBot(over = {}) {
    const bot = mockBot({ cells: { '5,64,1': 'chest' }, inv: [{ name: 'oak_log', count: 20 }], ...over })
    bot.entity.position = pos(5, 64, 1)
    const ctx = homeCtx({ home: { chest: { x: 5, y: 64, z: 1 } } })
    ctx.lastGoalKey = 'stockpile:5,64,1'
    return { bot, ctx }
  }


  it('H-edibles a missing index set falls back to the built-in foods', () => {
    const index = require('../src/index')
    const keep = index.EDIBLE_FOODS
    index.EDIBLE_FOODS = null
    try {
      // baked_potato is index-only: without the set it banks, none kept.
      const plan = stockpile.depositPlan({ inventory: { items: () => [{ name: 'baked_potato', count: 12 }] } })
      assert.deepEqual(plan, [{ name: 'baked_potato', count: 12 }])
    } finally {
      index.EDIBLE_FOODS = keep
    }
    const plan = stockpile.depositPlan({ inventory: { items: () => [{ name: 'baked_potato', count: 12 }] } })
    assert.deepEqual(plan, [{ name: 'baked_potato', count: 2 }])
  })

  it('H-invthrow a dying inventory reads empty, the step finishes', () => {
    const { bot, ctx } = adoptedBot()
    bot.inventory.items = () => { throw new Error('window flicker') }
    assert.doesNotThrow(() => stockpile(bot, ctx))
    assert.equal(ctx.stepStatus, 'done')
    assert.deepEqual(stockpile.depositPlan(bot), [])
  })

  it('H-invshape a non-array inventory reads empty instead of crashing', () => {
    const bot = mockBot()
    bot.inventory.items = () => ({})
    assert.deepEqual(stockpile.depositPlan(bot), [])
    assert.equal(stockpile.surplusCount(bot), 0)
  })

  it('H-nullslots null and nameless slots never reach the keeps', () => {
    const plan = stockpile.depositPlan({ inventory: { items: () => [null, { count: 1 }, { name: 'dirt', count: 40 }] } })
    assert.deepEqual(plan, [{ name: 'dirt', count: 8 }])
  })

  it('H-nocount a count-less stack banks a single item', () => {
    const plan = stockpile.depositPlan({ inventory: { items: () => [{ name: 'oak_log' }] } })
    assert.deepEqual(plan, [{ name: 'oak_log', count: 1 }])
  })

  it('H-scanthrow a throwing scan degrades the spot hunt to unknown', () => {
    const bot = mockBot()
    bot.blockAt = () => { throw new Error('chunk dark') }
    assert.equal(stockpile.chestSpotFor(bot, homeCtx()), 'unknown')
  })

  it('H-badsite a non-numeric site scans nothing, returns null', () => {
    let calls = 0
    const bot = mockBot()
    bot.blockAt = (p) => {
      calls++
      if (typeof p.x !== 'number' || typeof p.y !== 'number' || typeof p.z !== 'number') throw new Error('NaN read')
      return { name: 'air' }
    }
    assert.equal(stockpile.chestSpotFor(bot, homeCtx({ home: { site: { x: 'a' } } })), null)
    assert.equal(calls, 0, 'no junk reads on a bad site')
  })

  it('H-darkbelow air cells over an unreadable floor read unknown', () => {
    const bot = mockBot()
    bot.blockAt = (p) => (p.y === 64 ? { name: 'air' } : null)
    assert.equal(stockpile.chestSpotFor(bot, homeCtx()), 'unknown')
  })

  it('H-stalestamp an expired no-spot stamp places again', () => {
    const bot = mockBot({ inv: [{ name: 'chest', count: 1 }] })
    const ctx = homeCtx({ ctx: { chestNoSpotAt: Date.now() - 2 * 60 * 60 * 1000 } })
    assert.equal(stockpile.chestTodo(bot, ctx, 0), 'place')
  })

  it('H-farkey a fresh goal key restarts the far patience', () => {
    const bot = mockBot({ cells: { '5,64,1': 'chest' }, inv: [{ name: 'oak_log', count: 20 }] })
    const ctx = homeCtx({ home: { chest: { x: 5, y: 64, z: 1 } } })
    ctx.lastGoalKey = 'stockpile:5,64,1'
    ctx.stockpileFar = { key: 'stockpile-table:1,2,3', n: 4 }
    stockpile(bot, ctx) // far on a new key: patience restarts, no fail
    assert.equal(ctx.stepStatus, 'running')
    assert.deepEqual(ctx.stockpileFar, { key: 'stockpile:5,64,1', n: 1 })
  })

  it('H-zerotake a zero-count chest stack issues no withdraw', async () => {
    const bot = mockBot({ inv: [], chest: [] })
    bot.blockAt = world({ '5,64,1': 'chest' }).blockAt
    const asked = []
    bot.openChest = async () => ({
      containerItems: () => [{ name: 'dirt', type: 1, metadata: null, count: 0 }],
      withdraw: async (type, meta, count) => { asked.push(count) },
      close: () => {},
    })
    const ctx = homeCtx({ home: { chest: { x: 5, y: 64, z: 1 } } })
    const res = await stockpile.withdrawFromChest(bot, ctx, 'dirt', 5)
    assert.equal(res.got, 0)
    assert.deepEqual(asked, [], 'no zero-count window click')
  })

  it('H-notake a count-less chest stack withdraws a single item', async () => {
    const bot = mockBot({ inv: [], chest: [{ name: 'dirt' }] })
    bot.blockAt = world({ '5,64,1': 'chest' }).blockAt
    const ctx = homeCtx({ home: { chest: { x: 5, y: 64, z: 1 } } })
    const res = await stockpile.withdrawFromChest(bot, ctx, 'dirt', 5)
    assert.equal(res.got, 1)
  })

  it('H-wdnullbot a null bot withdraws nothing instead of throwing', async () => {
    const ctx = homeCtx({ home: { chest: { x: 5, y: 64, z: 1 } } })
    assert.deepEqual(await stockpile.withdrawFromChest(null, ctx, 'dirt', 5), { got: 0 })
    assert.deepEqual(await stockpile.withdrawFromChest(undefined, ctx, 'dirt', 5), { got: 0 })
  })

  it('H-wenullbot a null bot withdraws no edible instead of throwing', async () => {
    const ctx = homeCtx({ home: { chest: { x: 5, y: 64, z: 1 } } })
    assert.deepEqual(await stockpile.withdrawEdible(null, ctx, 5), { got: 0, name: null })
  })

  it('H-weirdstacks a non-array chest listing reports empty with status', async () => {
    const bot = mockBot({ inv: [], chest: [] })
    bot.blockAt = world({ '5,64,1': 'chest' }).blockAt
    bot.openChest = async () => ({ containerItems: () => 'weird', close: () => {} })
    const ctx = homeCtx({ home: { chest: { x: 5, y: 64, z: 1 } } })
    const res = await stockpile.withdrawEdible(bot, ctx, 5)
    assert.deepEqual(res, { got: 0, name: null, status: 'ok' })
  })
})

describe('stockpile guard residuals (idkcraft-cq7 batch B1)', () => {
  function adoptedNear(over = {}) {
    const bot = mockBot({ cells: { '5,64,1': 'chest' }, inv: [{ name: 'oak_log', count: 20 }], ...over })
    bot.entity.position = pos(5, 64, 1)
    const ctx = homeCtx({ home: { chest: { x: 5, y: 64, z: 1 } } })
    ctx.lastGoalKey = 'stockpile:5,64,1'
    return { bot, ctx }
  }

  it('B-ctx a missing ctx returns silently', () => {
    const bot = mockBot()
    assert.doesNotThrow(() => stockpile(bot, null))
    assert.doesNotThrow(() => stockpile(bot, undefined))
  })

  it('B-inflight a flying op blocks a second one', () => {
    const { bot, ctx } = adoptedNear()
    ctx.stockpileInFlight = true
    stockpile(bot, ctx)
    assert.equal(ctx.stepStatus, 'running')
    assert.equal(bot.calls.goals.length, 0)
    assert.equal(bot.calls.opens, 0)
  })

  it('B-bp a missing body returns silently', () => {
    const bot = mockBot({ inv: [{ name: 'oak_log', count: 20 }] })
    delete bot.entity
    const ctx = homeCtx()
    assert.doesNotThrow(() => stockpile(bot, ctx))
    assert.equal(ctx.stepStatus, 'running')
    assert.equal(bot.calls.goals.length, 0)
  })

  it('B-say a throwing chat still banks the deposit', async () => {
    const { bot, ctx } = adoptedNear()
    bot.chat = () => { throw new Error('chat dead') }
    stockpile(bot, ctx)
    await flush()
    await flush()
    assert.equal(ctx.stepStatus, 'done', `errs: ${ctx.stepStatus}`)
    assert.deepEqual(bot.calls.deposits, ['20 oak_log'])
  })

  it('B-close a throwing close still banks the deposit', async () => {
    const { bot, ctx } = adoptedNear()
    const open = bot.openChest
    bot.openChest = async (block) => {
      const w = await open(block)
      w.close = () => { throw new Error('close stuck') }
      return w
    }
    stockpile(bot, ctx)
    await flush()
    await flush()
    assert.equal(ctx.stepStatus, 'done')
    assert.equal(ctx.chestErrorAt, null)
    assert.deepEqual(bot.calls.deposits, ['20 oak_log'])
  })

  it('B-noopen a missing chest driver unadopts instead of failing', async () => {
    const { bot, ctx } = adoptedNear()
    delete bot.openChest
    stockpile(bot, ctx)
    await flush()
    await flush()
    assert.equal(ctx.stepStatus, 'running')
    assert.equal(ctx.home.chest, null)
  })


  it('B-unregbank an unregistered surplus parks full instead of banking air', async () => {
    const { bot, ctx } = adoptedNear({ inv: [{ name: 'mystery_ore', count: 20 }] })
    bot.registry = { itemsByName: {} }
    stockpile(bot, ctx)
    await flush()
    await flush()
    assert.equal(ctx.stepStatus, 'done')
    assert.equal(ctx.chestFull, true)
    assert.ok(bot.chats.join(' ').includes('full'), `chats: ${bot.chats}`)
    assert.deepEqual(bot.calls.deposits, [])
  })
})

describe('stockpile place residuals (idkcraft-cq7 batch B2)', () => {
  function placeBot(over = {}) {
    const bot = mockBot({ inv: [{ name: 'chest', count: 1 }], ...over })
    bot.entity.position = pos(5, 64, 1)
    return { bot, ctx: homeCtx() }
  }

  it('B-notable no table anywhere fails no-chest instead of throwing', () => {
    const bot = mockBot({ inv: [{ name: 'oak_log', count: 20 }] })
    bot.recipesFor = () => [{}] // craftable: without the guard the null tablePos would crash the tick
    const ctx = homeCtx()
    assert.doesNotThrow(() => stockpile(bot, ctx))
    assert.equal(ctx.stepStatus, 'failed:no-chest')
  })

  it('B-claimedtable a menu-claimed table crafts past a missing home table', () => {
    const bot = mockBot({ cells: { '4,64,1': 'crafting_table' }, inv: [{ name: 'oak_log', count: 20 }] })
    bot.recipesFor = () => [{}]
    const ctx = homeCtx({ ctx: { claimedTable: { x: 4, y: 64, z: 1 } } })
    stockpile(bot, ctx) // far from the table: a walk is issued, no fail
    assert.equal(ctx.stepStatus, 'running')
    assert.equal(ctx.lastGoalKey, 'stockpile-table:4,64,1')
  })

  it('B-wrongtable a non-table block at the claim fails no-chest', () => {
    const bot = mockBot({ cells: { '4,64,1': 'dirt' }, inv: [{ name: 'oak_log', count: 20 }] })
    bot.recipesFor = () => [{}] // craftable: without the name check the walk would issue
    const ctx = homeCtx({ home: { table: { x: 4, y: 64, z: 1 } } })
    assert.doesNotThrow(() => stockpile(bot, ctx))
    assert.equal(ctx.stepStatus, 'failed:no-chest')
  })

  it('B-norecipe a table without ingredients fails no-chest', () => {
    const bot = mockBot({ cells: { '4,64,1': 'crafting_table' }, inv: [{ name: 'oak_log', count: 20 }] })
    bot.recipesFor = () => []
    const ctx = homeCtx({ home: { table: { x: 4, y: 64, z: 1 } } })
    stockpile(bot, ctx)
    assert.equal(ctx.stepStatus, 'failed:no-chest')
  })






  it('B-itemgone a chest lost during the flora dig fails no-chest', async () => {
    const { bot, ctx } = placeBot({ cells: { '5,64,1': 'short_grass' } })
    const dig = bot.dig
    bot.dig = async (cell) => {
      await dig(cell)
      const ix = bot.inv.findIndex((i) => i.name === 'chest')
      if (ix >= 0) bot.inv.splice(ix, 1) // pack changes across the dig await
    }
    stockpile(bot, ctx)
    stockpile(bot, ctx)
    await flush()
    await flush()
    assert.equal(ctx.stepStatus, 'failed:no-chest')
    assert.equal(ctx.stockpileInFlight, false)
  })

  it('B-weirdinv a flaked inventory after the flora dig fails no-chest', async () => {
    const { bot, ctx } = placeBot({ cells: { '5,64,1': 'short_grass' } })
    const items = bot.inventory.items
    let dug = false
    const dig = bot.dig
    bot.dig = async (cell) => { await dig(cell); dug = true }
    bot.inventory.items = () => (dug ? 'weird' : items())
    stockpile(bot, ctx)
    stockpile(bot, ctx)
    await flush()
    await flush()
    assert.equal(ctx.stepStatus, 'failed:no-chest')
    assert.equal(ctx.stockpileInFlight, false)
  })

  it('B-noequipfn a missing hold driver still places', async () => {
    const { bot, ctx } = placeBot()
    delete bot.equip
    stockpile(bot, ctx)
    stockpile(bot, ctx)
    await flush()
    await flush()
    assert.deepEqual({ x: ctx.home.chest.x, y: ctx.home.chest.y, z: ctx.home.chest.z }, { x: 5, y: 64, z: 1 })
    assert.equal(ctx.stepStatus, 'running')
  })

  it('B-noland a placement that leaves no chest fails place', async () => {
    const { bot, ctx } = placeBot()
    bot.placeBlock = async () => {} // server eats it: reread finds air
    stockpile(bot, ctx)
    stockpile(bot, ctx)
    await flush()
    await flush()
    assert.equal(ctx.stepStatus, 'failed:place')
    assert.equal(ctx.home.chest, null)
    assert.ok(!bot.chats.join(' ').includes('placed'), `chats: ${bot.chats}`)
  })

  it('B-holdthrow a throwing hold fails place', async () => {
    const { bot, ctx } = placeBot()
    bot.equip = async () => { throw new Error('hand stuck') }
    stockpile(bot, ctx)
    stockpile(bot, ctx)
    await flush()
    await flush()
    assert.equal(ctx.stepStatus, 'failed:place')
    assert.equal(ctx.stockpileInFlight, false)
  })

  it('B-placethrow a refused placement fails place', async () => {
    const { bot, ctx } = placeBot()
    bot.placeBlock = async () => { throw new Error('placement refused') }
    stockpile(bot, ctx)
    stockpile(bot, ctx)
    await flush()
    await flush()
    assert.equal(ctx.stepStatus, 'failed:place')
    assert.equal(ctx.stockpileInFlight, false)
  })
})

describe('stockpile walk residuals (idkcraft-cq7 batch W)', () => {
  const SITE_KEY = 'stockpile-site:0,64,0'
  const CHEST_KEY = 'stockpile:5,64,1'

  it('W-sitemove a moving body keeps walking to the dark site', () => {
    const bot = mockBot({ inv: [{ name: 'oak_log', count: 20 }] })
    bot.blockAt = () => null // home chunk dark
    bot.entity.position = pos(100, 64, 100)
    bot.pathfinder.isMoving = () => true
    const ctx = homeCtx()
    ctx.lastGoalKey = SITE_KEY
    ctx.stockpileFar = { key: SITE_KEY, n: 4 }
    stockpile(bot, ctx)
    assert.equal(ctx.stepStatus, 'running')
    assert.equal(ctx.stockpileFar.n, 4, 'moving accrues no far tick')
  })

  it('W-siteretry an arrived-but-dark scan retries instead of failing', () => {
    const bot = mockBot({ inv: [{ name: 'oak_log', count: 20 }] })
    bot.blockAt = () => null
    const ctx = homeCtx()
    ctx.lastGoalKey = SITE_KEY
    ctx.stockpileFar = { key: SITE_KEY, n: 4 }
    stockpile(bot, ctx) // near the site (spawn), standing, still dark
    assert.equal(ctx.stepStatus, 'running')
    assert.equal(bot.calls.goals.length, 0)
  })

  it('W-adoptmove a moving body keeps walking to the dark chest', () => {
    const bot = mockBot({ inv: [{ name: 'oak_log', count: 20 }] })
    bot.blockAt = () => null
    bot.entity.position = pos(100, 64, 100)
    bot.pathfinder.isMoving = () => true
    const ctx = homeCtx({ home: { chest: { x: 5, y: 64, z: 1 } } })
    ctx.lastGoalKey = CHEST_KEY
    ctx.stockpileFar = { key: CHEST_KEY, n: 4 }
    stockpile(bot, ctx)
    assert.equal(ctx.stepStatus, 'running')
    assert.deepEqual(ctx.home.chest, { x: 5, y: 64, z: 1 }, 'unknown never unadopts')
  })

  it('W-adoptretry an arrived-but-dark chest retries instead of failing', () => {
    const bot = mockBot({ inv: [{ name: 'oak_log', count: 20 }] })
    bot.blockAt = () => null
    bot.entity.position = pos(5, 64, 1)
    const ctx = homeCtx({ home: { chest: { x: 5, y: 64, z: 1 } } })
    ctx.lastGoalKey = CHEST_KEY
    ctx.stockpileFar = { key: CHEST_KEY, n: 4 }
    stockpile(bot, ctx)
    assert.equal(ctx.stepStatus, 'running')
    assert.deepEqual(ctx.home.chest, { x: 5, y: 64, z: 1 })
  })

  it('W-adoptfar five far ticks on a dark chest fail far', () => {
    const bot = mockBot({ inv: [{ name: 'oak_log', count: 20 }] })
    bot.blockAt = () => null
    const ctx = homeCtx({ home: { chest: { x: 5, y: 64, z: 1 } } })
    ctx.lastGoalKey = CHEST_KEY
    ctx.stockpileFar = { key: CHEST_KEY, n: 4 }
    stockpile(bot, ctx) // standing at spawn: far from the dark chest
    assert.equal(ctx.stepStatus, 'failed:far')
    assert.deepEqual(ctx.home.chest, { x: 5, y: 64, z: 1 }, 'far keeps the claim')
  })

  it('W-walkmove a moving body opens nothing on the way in', () => {
    const bot = mockBot({ cells: { '5,64,1': 'chest' }, inv: [{ name: 'oak_log', count: 20 }] })
    bot.entity.position = pos(5, 64, 1)
    bot.pathfinder.isMoving = () => true
    const ctx = homeCtx({ home: { chest: { x: 5, y: 64, z: 1 } } })
    ctx.lastGoalKey = CHEST_KEY
    stockpile(bot, ctx)
    assert.equal(ctx.stepStatus, 'running')
    assert.equal(bot.calls.opens, 0)
  })

  it('W-tablemove a moving body keeps walking to the table', () => {
    const bot = mockBot({ cells: { '4,64,1': 'crafting_table' }, inv: [{ name: 'oak_log', count: 20 }] })
    bot.recipesFor = () => [{}]
    bot.pathfinder.isMoving = () => true
    const ctx = homeCtx({ home: { table: { x: 4, y: 64, z: 1 } } })
    ctx.lastGoalKey = 'stockpile-table:4,64,1'
    ctx.stockpileFar = { key: 'stockpile-table:4,64,1', n: 4 }
    stockpile(bot, ctx)
    assert.equal(ctx.stepStatus, 'running')
    assert.equal(ctx.stockpileFar.n, 4)
  })

  it('W-tablefar five far ticks on the table walk fail far', () => {
    const bot = mockBot({ cells: { '4,64,1': 'crafting_table' }, inv: [{ name: 'oak_log', count: 20 }] })
    bot.recipesFor = () => [{}]
    const ctx = homeCtx({ home: { table: { x: 4, y: 64, z: 1 } } })
    ctx.lastGoalKey = 'stockpile-table:4,64,1'
    ctx.stockpileFar = { key: 'stockpile-table:4,64,1', n: 4 }
    stockpile(bot, ctx) // standing at spawn: far from the table
    assert.equal(ctx.stepStatus, 'failed:far')
  })

  it('W-placemove a moving body places nothing on the way in', () => {
    const bot = mockBot({ inv: [{ name: 'chest', count: 1 }] })
    bot.entity.position = pos(5, 64, 1)
    bot.pathfinder.isMoving = () => true
    const ctx = homeCtx()
    ctx.lastGoalKey = 'stockpile-place:5,64,1'
    stockpile(bot, ctx)
    assert.equal(ctx.stepStatus, 'running')
    assert.ok(!ctx.stockpileInFlight, 'no window op while walking')
  })
})

// NOTE (idkcraft-cq7 mutant review): the following source mutants survive the
// suite and are equivalent or unreachable, not coverage gaps — verified by
// probing, not by inspection alone:
// - nearPos catch: unreachable — the head bp read and the nearPos re-read
//   run in one synchronous tick, so a deterministic read cannot throw in one
//   and not the other; the `!bp`/non-number guards cover the honest shapes.
// - isKeep non-string guard: unreachable via depositPlan (nameless slots
//   filter first) and isKeep is unexported; dropping depositPlan's own
//   typeof arm is equivalent because isKeep would keep them anyway.
// - `n <= 0` skip: equivalent over realistic counts — a zero count no-ops
//   through the keep math and still fails `n > 0` (only negative counts,
//   which no inventory holds, would diverge).
// - blockNameAt `b &&`: equivalent — a null block throws inside the same
//   try and the catch returns null either way.
// - chestTodo `!=` vs `!==`: equivalent — an undefined stamp NaNs the
//   time math to false, the same as skipping.
// - withdraw `want <= 0` break: equivalent — without it the take math
//   yields 0 and the take guard continues, issuing no window call.
// - withdrawEdible `!first` early return: equivalent — without it the
//   undefined dereference lands in withChest's catch and reports the same
//   { got: 0, name: null }.
// - withdraw `res &&`: equivalent — withChest always resolves an object.
// - `before > 0`: equivalent — before is the same plan sum, so it is 0
//   only when the plan is empty, which returns done earlier.
// - deposit outer catch: unreachable — every inner op is individually
//   guarded (per-item deposit, say, withChest), leaving no realistic throw.
// - place no-ground arms: unreachable — the below re-read runs before the
//   first await, in one synchronous tick with the scan, so a deterministic
//   world cannot show ground at scan time and air at re-read. (The item
//   re-read IS reachable — it runs after the flora-dig await — and is
//   pinned by B-itemgone/B-weirdinv; round-1 minor.)
// - mid-open unknown: unreachable via the step (same-tick reread); via
//   withdraw unknown and gone both report { got: 0 }, so the distinction is
//   untestable. (The gone branch itself IS pinned — B-noopen drives it with
//   a missing chest driver and kills the dropped-branch mutant.)
