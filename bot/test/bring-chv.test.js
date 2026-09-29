'use strict'

// Bring dig-down gate (idkcraft-chv): the verdict chose a far deep vein the
// walk phase could never dig to — atl.20 S3 0/3 stalled on the surface into
// 'buried, no path in'. Buried hits past maxDigDepth are no-dig: the order
// hunts search legs or refuses honestly with the vein coords. Mock style
// mirrors bring-source.test.js.

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const bring = require('../src/behaviours/bring')
const {
  buriedCand, deepVeinOf, deepRefusal, SOURCE_COST,
} = require('../src/behaviours/bring')
const { handleChat, createTicker } = require('../src/index')

function pos(x, y, z) {
  const p = {
    x, y, z,
    distanceTo: (q) => Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z),
    clone() { return pos(p.x, p.y, p.z) },
  }
  return p
}

const BLOCKS = { coal_ore: 11, stone: 1, iron_ore: 31, gold_ore: 32 }
const ITEMS = { coal: 21, raw_iron: 25, stone_pickaxe: 22, iron_pickaxe: 24 }
const PICK = [{ name: 'stone_pickaxe', count: 1 }]

function mockBot({ spots = [], names = {}, items = [], playerPos = null, spawnPoint = null } = {}) {
  const lines = []
  const tossCalls = []
  const calls = { setGoal: 0, goals: [] }
  const blocksByName = {}
  for (const [name, id] of Object.entries(BLOCKS)) blocksByName[name] = { id }
  const itemsByName = {}
  for (const [name, id] of Object.entries(ITEMS)) itemsByName[name] = { id }
  const bot = {
    lines, tossCalls, calls,
    username: 'IdkBot',
    entities: {},
    health: 20,
    food: 20,
    entity: { position: pos(0, 64, 0), onGround: true },
    registry: { blocksByName, itemsByName },
    players: { P: { username: 'P', entity: playerPos ? { position: playerPos } : null } },
    _moving: false,
    _items: items,
    digCalls: 0,
    pathfinder: {
      goal: null,
      setGoal: (goal) => { calls.setGoal++; calls.goals.push(goal); bot.pathfinder.goal = goal },
      isMoving: () => bot._moving,
      bestHarvestTool: () => ({ name: 'stone_pickaxe', type: 99 }),
    },
    held: null,
    equip: async (item) => { bot.held = item && item.name },
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
      const n = names[`${p.x},${p.y},${p.z}`]
      return n ? { name: n, position: pos(p.x, p.y, p.z) } : null
    },
    canDigBlock: () => true,
    dig: async () => { bot.digCalls++ },
    toss: async (id, meta, n) => { tossCalls.push([id, meta, n]) },
    chat(line) { lines.push(String(line)) },
  }
  if (spawnPoint) bot.spawnPoint = spawnPoint
  return bot
}

function tickerFor(bot, brain) {
  return createTicker({
    bot,
    brain: brain || { decide: async () => ({ action: 'idle', sprint: false, source: 'stub' }) },
    tickMs: 10,
    idleTickMs: 10,
  })
}

describe('bring dig-down gate (idkcraft-chv)', () => {
  it('buriedCand gates past maxDigDepth, keeps the boundary', () => {
    const bp = pos(0, 64, 0)
    const at = (y) => ({ name: 'iron_ore', position: pos(0, y, 0), distance: 64 - y, exposed: false })
    assert.ok(buriedCand(bp, at(52)), 'depth 12 digs')
    assert.equal(buriedCand(bp, at(51)), null, 'depth 13 is no-dig')
    assert.equal(SOURCE_COST.maxDigDepth, 12)
  })

  it('deepVeinOf/deepRefusal name the vein coords', () => {
    const v = deepVeinOf(pos(0, 64, 0), { name: 'iron_ore', position: pos(3, 40, -7) })
    assert.deepEqual(v, { name: 'iron_ore', x: 3, y: 40, z: -7, depth: 24 })
    assert.equal(deepRefusal({ deepVein: v }), 'iron_ore at 3 40 -7 is 24 down — too deep to dig')
    assert.equal(deepRefusal({}), null)
  })

  it('creation with only a deep vein opens find, then refuses honestly with coords', async () => {
    const bot = mockBot({
      spots: [pos(0, 40, 0)],
      names: { '0,40,0': 'iron_ore' },
      items: PICK,
      playerPos: pos(30, 64, 0),
    })
    const ticker = tickerFor(bot)
    handleChat(bot, ticker, 'P', 'bring me iron')
    assert.deepEqual(bot.lines, ['nearest iron too deep to dig, looking for a diggable vein…'])
    const o = bot._tickerCtx.bring
    assert.ok(o, 'order opened')
    assert.equal(o.phase, 'find')
    assert.deepEqual(o.deepVein, { name: 'iron_ore', x: 0, y: 40, z: 0, depth: 24 })
    for (let i = 0; i < 10 && bot._tickerCtx.bring; i++) await bring(bot, bot._tickerCtx, null, {})
    assert.equal(bot._tickerCtx.bring, null, 'order refused')
    assert.ok(
      bot.lines.includes('iron_ore at 0 40 0 is 24 down — too deep to dig'),
      `lines: ${bot.lines}`,
    )
    assert.equal(bot.calls.setGoal, 0, 'never walked to the undiggable shaft')
  })

  it('spent legs name the known deep vein instead of a bare no-ore', async () => {
    const bot = mockBot({
      spots: [pos(0, 40, 0)],
      names: { '0,40,0': 'iron_ore' },
      items: PICK,
      playerPos: pos(30, 64, 0),
      spawnPoint: pos(0, 64, 0), // anchor: legs exist, so exhaustion is reachable
    })
    const ticker = tickerFor(bot)
    handleChat(bot, ticker, 'P', 'bring me iron')
    const o = bot._tickerCtx.bring
    assert.ok(o, 'order opened')
    o.searchLegs = { legs: 24, startedAt: Date.now(), announced: true, last: 'empty' }
    for (let i = 0; i < 10 && bot._tickerCtx.bring; i++) await bring(bot, bot._tickerCtx, null, {})
    assert.equal(bot._tickerCtx.bring, null, 'order refused')
    assert.ok(
      bot.lines.includes('searched 24 areas, no iron — nearest known vein too deep at 0 40 0'),
      `lines: ${bot.lines}`,
    )
  })

  it('a shallow buried vein still commits to the dig (gate regression)', () => {
    const bot = mockBot({
      spots: [pos(5, 54, 0)],
      names: { '5,54,0': 'iron_ore' },
      items: PICK,
      playerPos: pos(30, 64, 0),
    })
    const ticker = tickerFor(bot)
    handleChat(bot, ticker, 'P', 'bring me iron')
    assert.deepEqual(bot.lines, ['going for 3 iron_ore, 11 blocks away'])
    const o = bot._tickerCtx.bring
    assert.ok(o, 'order opened')
    assert.equal(o.phase, 'walk')
    assert.equal(o.verdict.pick, 'buried')
  })

  it('a gated far stash opens legs carrying the vein, then refuses with coords', async () => {
    // Readable world to the 160 edge: creation defers to the far shells,
    // whose only hit is the same gated shaft. The anchor keeps the legs
    // order alive for the deepVein assertion; the skip-far re-find below
    // runs anchorless so the refusal lands on this tick, deterministically.
    const bot = mockBot({
      spots: [pos(0, 40, 0)],
      names: {
        '0,40,0': 'iron_ore',
        '48,64,0': 'stone', '96,64,0': 'stone', '128,64,0': 'stone', '160,64,0': 'stone',
      },
      items: PICK,
      playerPos: pos(30, 64, 0),
      spawnPoint: pos(0, 64, 0),
    })
    const ticker = tickerFor(bot)
    handleChat(bot, ticker, 'P', 'bring me iron')
    assert.deepEqual(bot.lines, ['only buried iron within 48, checking further for open ore…'])
    for (let i = 0; i < 200 && !bot._tickerCtx.bring; i++) await ticker.tick()
    const o = bot._tickerCtx.bring
    assert.ok(o, 'legs order opened after the empty shells')
    assert.deepEqual(o.deepVein, { name: 'iron_ore', x: 0, y: 40, z: 0, depth: 24 })
    o.phase = 'find'
    o.searchSkipFar = true
    delete bot.spawnPoint
    await bring(bot, bot._tickerCtx, null, {})
    assert.equal(bot._tickerCtx.bring, null, 'order refused')
    assert.ok(
      bot.lines.includes('iron_ore at 0 40 0 is 24 down — too deep to dig'),
      `lines: ${bot.lines}`,
    )
  })
})
