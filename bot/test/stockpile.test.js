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

function mockBot({ inv = [], cells = {}, chest = [], failDeposit = false, failOpen = false } = {}) {
  const w = world(cells)
  const chats = []
  const calls = { goals: [], opens: 0, deposits: [], withdraws: [], closes: 0 }
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
  })

  it('adopts the chest on sight and finishes with an empty surplus', () => {
    const bot = mockBot({ cells: { '5,64,1': 'chest' }, inv: [{ name: 'bread', count: 3 }] })
    const ctx = homeCtx()
    stockpile(bot, ctx)
    assert.deepEqual(ctx.home.chest, { x: 5, y: 64, z: 1 })
    assert.equal(ctx.stepStatus, 'done')
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
    assert.deepEqual(ctx.home.chest, { x: 5, y: 64, z: 1 })
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
    stockpile(bot, ctx)
    assert.equal(ctx.stepStatus, 'failed:far')
    assert.equal(bot.calls.opens, 0)
    assert.deepEqual(ctx.home.chest, { x: 5, y: 64, z: 1 })
  })

  it('an unreachable spot fails far without placing', () => {
    const bot = mockBot({ inv: [{ name: 'chest', count: 1 }] })
    const ctx = homeCtx()
    stockpile(bot, ctx)
    stockpile(bot, ctx) // standing at spawn, spot 5 blocks out
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
    stockpile(bot, ctx) // standing, still far: no path home
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
    assert.deepEqual(ctx.home.chest, { x: 5, y: 64, z: 1 })
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
