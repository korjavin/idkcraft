'use strict'

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const bring = require('../src/behaviours/bring')
const { sharePlan } = require('../src/behaviours/bring')
const { handleChat, createTicker } = require('../src/index')

function pos(x, y, z) {
  const p = {
    x, y, z,
    distanceTo: (q) => Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z),
    clone() { return pos(p.x, p.y, p.z) },
  }
  return p
}

const ITEM_IDS = {
  stone_pickaxe: 101, iron_sword: 102, diamond_helmet: 103,
  dirt: 104, cobblestone: 105, raw_iron: 106, coal: 107, bread: 108,
  bow: 109, shield: 110, arrow: 111,
}

function mockBot({ items = [], playerPos = null } = {}) {
  const lines = []
  const tossCalls = []
  const itemsByName = {}
  for (const [name, id] of Object.entries(ITEM_IDS)) itemsByName[name] = { id }
  const bot = {
    lines, tossCalls,
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
      setGoal: (goal) => { bot.pathfinder.goal = goal },
      isMoving: () => bot._moving,
    },
    inventory: { items: () => bot._items },
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

const flush = () => new Promise((resolve) => setImmediate(resolve))

describe('share plan', () => {
  it('keeps tools, weapons, armour and a 32-block dirt/cobble reserve', () => {
    const items = [
      { name: 'stone_pickaxe', count: 1 },
      { name: 'iron_sword', count: 1 },
      { name: 'diamond_helmet', count: 1 },
      { name: 'bow', count: 1 },
      { name: 'shield', count: 1 },
      { name: 'arrow', count: 16 },
      { name: 'dirt', count: 40 },
      { name: 'cobblestone', count: 10 },
      { name: 'raw_iron', count: 12 },
      { name: 'coal', count: 30 },
      { name: 'bread', count: 8 },
    ]
    assert.deepEqual(sharePlan(items), [
      { name: 'dirt', count: 8 },
      { name: 'cobblestone', count: 10 },
      { name: 'raw_iron', count: 12 },
      { name: 'coal', count: 30 },
      { name: 'bread', count: 8 },
    ])
  })

  it('totals split stacks under one name, first-seen order', () => {
    const items = [
      { name: 'coal', count: 64 },
      { name: 'dirt', count: 64 },
      { name: 'coal', count: 30 },
      { name: 'dirt', count: 10 },
    ]
    assert.deepEqual(sharePlan(items), [
      { name: 'coal', count: 94 },
      { name: 'dirt', count: 42 },
    ])
  })

  it('fills the 32 reserve with cobble when dirt is short', () => {
    const items = [
      { name: 'dirt', count: 10 },
      { name: 'cobblestone', count: 50 },
      { name: 'coal', count: 5 },
    ]
    assert.deepEqual(sharePlan(items), [
      { name: 'cobblestone', count: 28 },
      { name: 'coal', count: 5 },
    ])
  })
})

describe('share order', () => {
  it('tosses everything but the keep-list next to the player', async () => {
    const bot = mockBot({
      items: [
        { name: 'stone_pickaxe', count: 1 },
        { name: 'iron_sword', count: 1 },
        { name: 'diamond_helmet', count: 1 },
        { name: 'dirt', count: 40 },
        { name: 'cobblestone', count: 10 },
        { name: 'raw_iron', count: 12 },
        { name: 'coal', count: 30 },
        { name: 'bread', count: 8 },
      ],
      playerPos: pos(1, 64, 0),
    })
    bot.entity.position = pos(0, 64, 0)
    const ticker = tickerFor(bot)
    handleChat(bot, ticker, 'P', 'share')
    assert.ok(bot._tickerCtx.bring, 'share order created')
    assert.equal(bot._tickerCtx.bring.kind, 'share')
    for (let i = 0; i < 10 && bot._tickerCtx.bring; i++) {
      bring(bot, bot._tickerCtx, null, {})
      await flush()
    }
    assert.equal(bot._tickerCtx.bring, null, 'order done')
    const tossed = bot.tossCalls.map(([id, , n]) => [Object.keys(ITEM_IDS).find((k) => ITEM_IDS[k] === id), n])
    assert.deepEqual(tossed, [
      ['dirt', 8], ['cobblestone', 10], ['raw_iron', 12], ['coal', 30], ['bread', 8],
    ])
    assert.ok(bot.lines.includes('shared: 8 dirt, 10 cobblestone, 12 raw_iron, 30 coal, 8 bread'), `lines: ${bot.lines}`)
  })

  it('empty inventory answers nothing to share', () => {
    const bot = mockBot({ items: [{ name: 'stone_pickaxe', count: 1 }], playerPos: pos(1, 64, 0) })
    handleChat(bot, tickerFor(bot), 'P', 'share')
    assert.deepEqual(bot.lines, ['nothing to share'])
    assert.ok(!bot._tickerCtx.bring, 'no order created')
  })

  it('rechecks the reserve at toss time (scaffolding spent on the walk)', async () => {
    const bot = mockBot({
      items: [
        { name: 'dirt', count: 40 },
        { name: 'coal', count: 5 },
      ],
      playerPos: pos(1, 64, 0),
    })
    bot.entity.position = pos(0, 64, 0)
    const ticker = tickerFor(bot)
    handleChat(bot, ticker, 'P', 'share')
    assert.ok(bot._tickerCtx.bring, 'share order created')
    // The approach walk pillars 10 dirt before arrival.
    bot._items = [
      { name: 'dirt', count: 30 },
      { name: 'coal', count: 5 },
    ]
    for (let i = 0; i < 10 && bot._tickerCtx.bring; i++) {
      bring(bot, bot._tickerCtx, null, {})
      await flush()
    }
    assert.equal(bot._tickerCtx.bring, null, 'order done')
    const tossed = bot.tossCalls.map(([id, , n]) => [Object.keys(ITEM_IDS).find((k) => ITEM_IDS[k] === id), n])
    assert.deepEqual(tossed, [['coal', 5]], 'the 30 dirt stay under the reserve')
    assert.deepEqual(bot.lines, ['shared: 5 coal'], `lines: ${bot.lines}`)
  })

  it('unseen player tosses nothing', async () => {
    const bot = mockBot({
      items: [{ name: 'coal', count: 5 }],
      playerPos: null,
    })
    const ticker = tickerFor(bot)
    handleChat(bot, ticker, 'P', 'share')
    assert.ok(bot._tickerCtx.bring, 'order waits')
    for (let i = 0; i < 5; i++) {
      bring(bot, bot._tickerCtx, null, {})
      await flush()
    }
    assert.deepEqual(bot.tossCalls, [], 'nothing tossed while unseen')
    assert.ok(bot.lines.some((l) => l.includes("I can't see you")), `lines: ${bot.lines}`)
    assert.ok(bot._tickerCtx.bring, 'order still waits')
  })
})
