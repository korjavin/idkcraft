'use strict'

// Bring fetch-first from the home chest (atl.14 phase 2): orders that open
// with no world hit check the adopted chest before the far shells and
// search legs; anything short falls back to find and digs the rest.

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const bring = require('../src/behaviours/bring')
const { handleChat, createTicker } = require('../src/index')

function pos(x, y, z) {
  const p = {
    x, y, z,
    distanceTo: (q) => Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z),
    clone() { return pos(p.x, p.y, p.z) },
    floored() { return pos(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)) },
  }
  return p
}

const BLOCKS = { coal_ore: 11, oak_log: 12, stone: 1, chest: 40 }
const ITEMS = { coal: 21, oak_log: 12, stone_pickaxe: 22, bread: 23 }

function mockBot({ spots = [], names = {}, items = [], chest = [], playerPos = null } = {}) {
  const lines = []
  const tossCalls = []
  const calls = { setGoal: 0, goals: [], opens: 0 }
  const blocksByName = {}
  for (const [name, id] of Object.entries(BLOCKS)) blocksByName[name] = { id }
  const itemsByName = {}
  for (const [name, id] of Object.entries(ITEMS)) itemsByName[name] = { id }
  const bot = {
    lines, tossCalls, calls, chest,
    username: 'IdkBot',
    entities: {},
    health: 20,
    food: 20,
    entity: { position: pos(0, 64, 0), onGround: true },
    registry: { blocksByName, itemsByName },
    players: { P: { username: 'P', entity: playerPos ? { position: playerPos } : null } },
    _moving: false,
    _items: items,
    pathfinder: {
      goal: null,
      setGoal: (goal) => { calls.setGoal++; calls.goals.push(goal && goal.constructor && goal.constructor.name); bot.pathfinder.goal = goal },
      isMoving: () => bot._moving,
    },
    inventory: { items: () => bot._items },
    findBlocks(opts) {
      const want = new Set(Array.isArray(opts.matching) ? opts.matching : [opts.matching])
      return spots.filter((q) => {
        const n = names[`${q.x},${q.y},${q.z}`]
        const id = n && blocksByName[n] ? blocksByName[n].id : undefined
        return want.has(id)
      })
    },
    blockAt(p) {
      const n = names[`${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`]
      return n ? { name: n, position: pos(p.x, p.y, p.z) } : null
    },
    openChest: async () => {
      calls.opens++
      return {
        containerItems: () => chest.map((s) => ({ name: s.name, type: itemsByName[s.name].id, metadata: null, count: s.count })),
        withdraw: async (type, _meta, count) => {
          const name = Object.keys(itemsByName).find((k) => itemsByName[k].id === type)
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
    toss: async (id, meta, n) => {
      tossCalls.push([id, meta, n])
      const name = Object.keys(itemsByName).find((k) => itemsByName[k].id === id)
      let left = n
      for (let k = bot._items.length - 1; k >= 0 && left > 0; k--) {
        if (bot._items[k].name !== name) continue
        const take = Math.min(bot._items[k].count, left)
        bot._items[k].count -= take
        left -= take
        if (bot._items[k].count <= 0) bot._items.splice(k, 1)
      }
    },
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

function chestHome(ctx) {
  ctx.home = { site: { x: 0, y: 64, z: 0 }, built: true, chest: { x: 5, y: 64, z: 1 } }
}

const flush = () => new Promise((r) => { setImmediate(() => setImmediate(r)) })

describe('bring openPhase', () => {
  it('opens chestfetch with an adopted chest, find without', () => {
    assert.equal(bring.openPhase({ home: { chest: { x: 1, y: 2, z: 3 } } }), 'chestfetch')
    assert.equal(bring.openPhase({ home: { chest: null } }), 'find')
    assert.equal(bring.openPhase({}), 'find')
  })
})

describe('bring chestfetch phase', () => {
  it('pack already holding the want returns without opening', async () => {
    const bot = mockBot({ names: { '5,64,1': 'chest' }, items: [{ name: 'coal', count: 5 }] })
    const ctx = { bring: { kind: 'block', name: 'coal_ore', drop: 'coal', want: 3, by: 'P', phase: 'chestfetch', have: 0, announced: true } }
    chestHome(ctx)
    await bring(bot, ctx, null, {})
    assert.equal(ctx.bring.phase, 'return')
    assert.equal(bot.calls.opens, 0)
  })

  it('derives the drop for hitless orders and returns from the pack', async () => {
    const bot = mockBot({ names: { '5,64,1': 'chest' }, items: [{ name: 'coal', count: 5 }] })
    const ctx = { bring: { kind: 'block', name: 'coal_ore', want: 3, by: 'P', phase: 'chestfetch', have: 0, announced: true } }
    chestHome(ctx)
    await bring(bot, ctx, null, {})
    assert.equal(ctx.bring.drop, 'coal')
    assert.equal(ctx.bring.phase, 'return')
  })

  it('tops up from the chest, then returns', async () => {
    const bot = mockBot({
      names: { '5,64,1': 'chest' },
      items: [{ name: 'coal', count: 1 }],
      chest: [{ name: 'coal', count: 5 }],
    })
    const ctx = { bring: { kind: 'block', name: 'coal_ore', drop: 'coal', want: 4, by: 'P', phase: 'chestfetch', have: 1, announced: false }, chestFull: true }
    chestHome(ctx)
    await bring(bot, ctx, null, {}) // walk to the chest
    assert.equal(bot.calls.goals[0], 'GoalNear')
    assert.deepEqual(bot.lines, ['checking the home chest for coal'])
    await bring(bot, ctx, null, {}) // arrived: fetch
    await flush()
    assert.equal(ctx.bring.phase, 'return')
    assert.equal(ctx.bring.have, 4)
    assert.equal(bot.calls.opens, 1)
    assert.equal(ctx.chestFull, false) // the fetch re-arms the stockpile step
  })

  it('a short chest falls back to find, exactly once', async () => {
    const bot = mockBot({
      names: { '5,64,1': 'chest' },
      items: [],
      chest: [{ name: 'coal', count: 2 }],
    })
    const ctx = { bring: { kind: 'block', name: 'coal_ore', drop: 'coal', want: 4, by: 'P', phase: 'chestfetch', have: 0, announced: true } }
    chestHome(ctx)
    await bring(bot, ctx, null, {})
    await bring(bot, ctx, null, {})
    await flush()
    assert.equal(ctx.bring.phase, 'find')
    assert.equal(ctx.bring.chestTried, true)
    assert.equal(ctx.bring.have, 2)
  })

  it('an empty chest falls back to find', async () => {
    const bot = mockBot({ names: { '5,64,1': 'chest' }, items: [], chest: [{ name: 'oak_log', count: 9 }] })
    const ctx = { bring: { kind: 'block', name: 'coal_ore', drop: 'coal', want: 4, by: 'P', phase: 'chestfetch', have: 0, announced: true } }
    chestHome(ctx)
    await bring(bot, ctx, null, {})
    await bring(bot, ctx, null, {})
    await flush()
    assert.equal(ctx.bring.phase, 'find')
    assert.equal(ctx.bring.chestTried, true)
  })

  it('a lost chest falls back without walking', async () => {
    const bot = mockBot({ names: {}, items: [] })
    const ctx = { bring: { kind: 'block', name: 'coal_ore', drop: 'coal', want: 4, by: 'P', phase: 'chestfetch', have: 0, announced: true } }
    await bring(bot, ctx, null, {})
    assert.equal(ctx.bring.phase, 'find')
    assert.equal(bot.calls.setGoal, 0)
  })

  it('one window op at a time across ticks', async () => {
    const bot = mockBot({ names: { '5,64,1': 'chest' }, items: [], chest: [{ name: 'coal', count: 5 }] })
    const ctx = { bring: { kind: 'block', name: 'coal_ore', drop: 'coal', want: 4, by: 'P', phase: 'chestfetch', have: 0, announced: true } }
    chestHome(ctx)
    await bring(bot, ctx, null, {})
    await bring(bot, ctx, null, {})
    await bring(bot, ctx, null, {}) // still in flight: no second open
    await flush()
    assert.equal(bot.calls.opens, 1)
  })

  it('food orders fetch the first edible', async () => {
    const bot = mockBot({
      names: { '5,64,1': 'chest' },
      items: [],
      chest: [{ name: 'oak_log', count: 9 }, { name: 'bread', count: 6 }],
    })
    const ctx = { bring: { kind: 'food', name: 'food', drop: null, want: 5, by: 'P', phase: 'chestfetch', have: 0, announced: false } }
    chestHome(ctx)
    await bring(bot, ctx, null, {})
    assert.deepEqual(bot.lines, ['checking the home chest for food'])
    await bring(bot, ctx, null, {})
    await flush()
    assert.equal(ctx.bring.drop, 'bread')
    assert.equal(ctx.bring.have, 5)
    assert.equal(ctx.bring.phase, 'return')
  })

  it('food with an empty chest hunts instead', async () => {
    const bot = mockBot({ names: { '5,64,1': 'chest' }, items: [], chest: [] })
    const ctx = { bring: { kind: 'food', name: 'food', drop: null, want: 5, by: 'P', phase: 'chestfetch', have: 0, announced: true } }
    chestHome(ctx)
    await bring(bot, ctx, null, {})
    await bring(bot, ctx, null, {})
    await flush()
    assert.equal(ctx.bring.phase, 'find')
  })

  it('find enters the chest once before the far shells', async () => {
    const bot = mockBot({ names: { '5,64,1': 'chest' }, items: [], chest: [] })
    const ctx = { bring: { kind: 'block', name: 'coal_ore', drop: 'coal', want: 3, by: 'P', phase: 'find', have: 0, announced: true } }
    chestHome(ctx)
    await bring(bot, ctx, null, {})
    assert.equal(ctx.bring.phase, 'chestfetch')
  })

  it('end to end: chestfetch to toss at the player', async () => {
    const bot = mockBot({
      names: { '5,64,1': 'chest' },
      items: [{ name: 'stone_pickaxe', count: 1 }],
      chest: [{ name: 'coal', count: 3 }],
      playerPos: pos(6, 64, 1),
    })
    const ticker = tickerFor(bot)
    const ctx = bot._tickerCtx
    chestHome(ctx)
    handleChat(bot, ticker, 'P', 'bring me coal')
    assert.equal(ctx.bring.phase, 'chestfetch')
    for (let i = 0; i < 20 && ctx.bring; i++) {
      await bring(bot, ctx, null, {})
      await flush()
      const o = ctx.bring
      if (!o) break
      if (o.phase === 'chestfetch') bot._moving = false // chest next door
      if (o.phase === 'return') bot.entity.position = pos(6, 64, 1) // at the player
    }
    assert.equal(ctx.bring, null)
    assert.ok(bot.lines.includes('here are 3 coal'), `lines: ${bot.lines.join('|')}`)
    assert.deepEqual(bot.tossCalls, [[21, null, 3]])
  })
})
