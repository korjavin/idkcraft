'use strict'

// 'bring me food' (idkcraft-n7k): inventory first, else hunt passive animals.

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const bring = require('../src/behaviours/bring')
const { handleChat, createTicker } = require('../src/index')
const { lookupCommand } = require('../src/commands')

function pos(x, y, z) {
  const p = {
    x, y, z,
    distanceTo: (q) => Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z),
    clone() { return pos(p.x, p.y, p.z) },
    offset(ox, oy, oz) { return pos(p.x + ox, p.y + oy, p.z + oz) }, // swing() aims above the mob
  }
  return p
}

const ITEMS = { bread: 41, beef: 42, stone_pickaxe: 22 }

function mockBot({ items = [], playerPos = null, animals = [] } = {}) {
  const lines = []
  const tossCalls = []
  const attackCalls = []
  const calls = { setGoal: 0, goals: [] }
  const itemsByName = {}
  for (const [name, id] of Object.entries(ITEMS)) itemsByName[name] = { id }
  const entities = {}
  for (const a of animals) entities[a.id] = a
  const bot = {
    lines, tossCalls, attackCalls, calls,
    username: 'IdkBot',
    entities,
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
      stop: () => {},
      isMoving: () => bot._moving,
      bestHarvestTool: () => null,
    },
    lookAt() {},
    attack(e) { attackCalls.push(e && e.id) },
    equip: async () => {},
    inventory: { items: () => bot._items },
    blockAt: () => null,
    toss: async (id, meta, n) => { tossCalls.push([id, meta, n]) },
    chat(line) { lines.push(String(line)) },
  }
  return bot
}

function cow(id, x, y = 64, z = 0) {
  const p = pos(x, y, z)
  return { id, name: 'cow', type: 'mob', position: p, height: 1.4, isValid: true }
}

function tickerFor(bot) {
  return createTicker({
    bot,
    brain: { decide: async () => ({ action: 'idle', sprint: false, source: 'stub' }) },
    tickMs: 10,
    idleTickMs: 10,
  })
}

const flush = () => new Promise((resolve) => setImmediate(resolve))

// Drive the order until ctx.bring clears; move the body to each new goal.
async function drive(bot, ctx, onKill) {
  for (let i = 0; i < 120 && ctx.bring; i++) {
    bring(bot, ctx, null, {})
    await flush()
    const o = ctx.bring
    if (!o) break
    const gk = ctx.lastGoalKey
    if (gk.startsWith('bring-hunt:') && o.pos) {
      bot.entity.position = pos(o.pos.x + 1, o.pos.y, o.pos.z) // at the animal
      bot._moving = false
      if (o.phase === 'kill' && onKill) onKill(bot, o)
    } else if (gk.startsWith('bring-food-pickup:')) {
      bot._moving = false
      const dp = o.dropPos
      bot.entity.position = pos(dp.x, dp.y, dp.z) // over the drops
    } else if (gk.startsWith('bring-return:')) {
      bot._moving = false
      const pp = bot.players.P.entity.position
      bot.entity.position = pos(pp.x, pp.y, pp.z) // back at the player
    }
  }
}

describe("'bring me food' (idkcraft-n7k)", () => {
  it('bread in inventory is tossed at once without hunting', async () => {
    const bot = mockBot({ items: [{ name: 'bread', count: 3 }], playerPos: pos(30, 64, 0) })
    const ticker = tickerFor(bot)
    handleChat(bot, ticker, 'P', 'bring me food')
    assert.deepEqual(bot.lines, ['coming with 3 bread'])
    await drive(bot, bot._tickerCtx, null)
    assert.ok(bot.lines.some((l) => l === 'here are 3 bread'), `lines: ${bot.lines}`)
    assert.deepEqual(bot.tossCalls, [[ITEMS.bread, null, 3]])
    assert.equal(bot.attackCalls.length, 0)
  })

  it('no food hunts the nearest cow: swing, beef, return, toss', async () => {
    const bot = mockBot({ playerPos: pos(30, 64, 0), animals: [cow(11, 30), cow(12, 10)] })
    bot._moving = true
    const ticker = tickerFor(bot)
    handleChat(bot, ticker, 'P', 'bring me food 1')
    assert.deepEqual(bot.lines, ['looking for animals'])
    let swings = 0
    await drive(bot, bot._tickerCtx, (b, o) => {
      if (++swings >= 3) {
        const ent = b.entities[o.animal.id]
        if (ent) ent.isValid = false // dead after two recorded swings
        if (!b._items.some((i) => i.name === 'beef')) b._items.push({ name: 'beef', count: 1 })
      }
    })
    assert.ok(bot.lines.some((l) => /^going hunting: cow \d+ blocks away$/.test(l)), `lines: ${bot.lines}`)
    assert.ok(bot.attackCalls.length >= 2, 'swung the sword/fists')
    assert.ok(bot.lines.some((l) => l === 'here are 1 beef'), `lines: ${bot.lines}`)
    assert.deepEqual(bot.tossCalls, [[ITEMS.beef, null, 1]])
  })

  it('one cow for want 2 ends with an honest partial count', async () => {
    const bot = mockBot({ playerPos: pos(30, 64, 0), animals: [cow(11, 10)] })
    bot._moving = true
    const ticker = tickerFor(bot)
    handleChat(bot, ticker, 'P', 'bring me food 2')
    await drive(bot, bot._tickerCtx, (b, o) => {
      const ent = b.entities[o.animal.id]
      if (ent) ent.isValid = false
      b._items.push({ name: 'beef', count: 1 })
    })
    assert.ok(bot.lines.some((l) => l === 'only got 1 beef'), `lines: ${bot.lines}`)
  })

  it('no animals refuses without swinging', async () => {
    const bot = mockBot({ playerPos: pos(30, 64, 0) })
    const ticker = tickerFor(bot)
    handleChat(bot, ticker, 'P', 'bring me food')
    await drive(bot, bot._tickerCtx, null)
    assert.ok(bot.lines.some((l) => l === 'no animals within 48 blocks'), `lines: ${bot.lines}`)
    assert.equal(bot.attackCalls.length, 0)
  })

  it('stop mid-hunt cancels the order', async () => {
    const bot = mockBot({ playerPos: pos(30, 64, 0), animals: [cow(11, 10)] })
    bot._moving = true
    const ticker = tickerFor(bot)
    handleChat(bot, ticker, 'P', 'bring me food')
    bring(bot, bot._tickerCtx, null, {})
    assert.ok(bot._tickerCtx.bring, 'hunt started')
    ticker.stop()
    assert.equal(bot._tickerCtx.bring, null)
  })

  it("synonyms route to food with default and capped want", () => {
    const bot = mockBot({ playerPos: pos(30, 64, 0) })
    const ticker = tickerFor(bot)
    handleChat(bot, ticker, 'P', 'bring me meat')
    assert.equal(bot._tickerCtx.bring.kind, 'food')
    assert.equal(bot._tickerCtx.bring.want, 3)
    const capped = mockBot({ playerPos: pos(30, 64, 0) })
    const ticker2 = tickerFor(capped)
    handleChat(capped, ticker2, 'P', 'bring me something to eat 99')
    assert.equal(capped._tickerCtx.bring.kind, 'food')
    assert.equal(capped._tickerCtx.bring.want, 16)
  })

  it('food commands are described in COMMANDS', () => {
    for (const n of ['bring me food', 'bring me meat', 'bring me something to eat']) {
      assert.ok(lookupCommand(n), `${n} resolves`)
    }
  })
})
