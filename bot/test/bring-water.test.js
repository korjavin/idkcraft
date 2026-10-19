'use strict'

// 'bring me water_bucket' with an empty bucket (idkcraft-k2ze): the order
// fills from nearby source water instead of refusing 'no recipe, no
// source', then returns and tosses like any item order (WATER-1).

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const bring = require('../src/behaviours/bring')
const { handleChat, createTicker } = require('../src/index')

// Mineflayer contract (prismarine-world src/worldsync.js getBlock calls
// pos.floored(); findBlocks sorts nearest-first, blocks.js:199-200): every
// position the bot hands back or takes here is a floored-able point, and
// blockAt below enforces it — a plain {x,y,z} throws, exactly like prod.
function pos(x, y, z) {
  const p = {
    x, y, z,
    distanceTo: (q) => Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z),
    clone() { return pos(p.x, p.y, p.z) },
    floored() { return pos(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)) },
  }
  return p
}

const ITEMS = { water_bucket: 109, bucket: 110 }

function mockBot({ items = [], playerPos = null, water = [], levels = {}, rock = [] } = {}) {
  const rockSet = new Set(rock)
  const lines = []
  const tossCalls = []
  const calls = { goals: [] }
  const itemsByName = {}
  for (const [name, id] of Object.entries(ITEMS)) itemsByName[name] = { id }
  const bot = {
    lines, tossCalls, calls,
    _water: water,
    username: 'IdkBot',
    entities: {},
    health: 20,
    food: 20,
    entity: { position: pos(0, 64, 0), onGround: true },
    registry: { blocksByName: { water: { id: 100 } }, itemsByName },
    players: { P: { username: 'P', entity: playerPos ? { position: playerPos } : null } },
    _moving: false,
    _items: items,
    pathfinder: {
      goal: null,
      setGoal: (goal) => { calls.goals.push(goal); bot.pathfinder.goal = goal },
      isMoving: () => bot._moving,
    },
    inventory: { items: () => bot._items },
    // Count-honouring findBlocks like the server (mineflayer blocks.js
    // sorts nearest-first, then slices to count).
    findBlocks: ({ count } = {}) => bot._water
      .map(([x, y, z]) => ({ p: pos(x, y, z), d: Math.hypot(x - bot.entity.position.x, y - bot.entity.position.y, z - bot.entity.position.z) }))
      .sort((a, b) => a.d - b.d)
      .slice(0, count)
      .map(({ p }) => p),
    blockAt(p) {
      const f = p.floored() // prod parity: a plain {x,y,z} throws here
      const key = `${f.x},${f.y},${f.z}`
      if (rockSet.has(key)) return { name: 'stone', boundingBox: 'block', position: pos(f.x, f.y, f.z) }
      if (!(key in levels)) return null
      return { name: 'water', position: pos(f.x, f.y, f.z), getProperties: () => ({ level: levels[key] }) }
    },
    equip: async () => {},
    lookAt: () => {},
    activateItem: () => {
      const at = bot._items.find((i) => i && i.name === 'bucket' && (typeof i.count !== 'number' || i.count > 0))
      if (!at) return
      at.count -= 1
      if (at.count <= 0) bot._items.splice(bot._items.indexOf(at), 1)
      const fill = bot._items.find((i) => i && i.name === 'water_bucket')
      if (fill) fill.count += 1
      else bot._items.push({ name: 'water_bucket', count: 1 })
    },
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

// Drive an order to its end: walk the fill leg, then stand at the player.
async function drive(bot, ctx) {
  for (let i = 0; i < 60 && ctx.bring; i++) {
    await bring(bot, ctx, null, {})
    await flush()
    const o = ctx.bring
    if (!o) break
    if (o.phase === 'fill' && o.fillTarget) {
      bot._moving = false
      bot.entity.position = pos(o.fillTarget.x + 1, o.fillTarget.y, o.fillTarget.z)
    }
    if (o.phase === 'return') {
      const pp = bot.players.P.entity.position
      bot.entity.position = pos(pp.x, pp.y, pp.z)
    }
    if (o.fillInFlight || o.tossInFlight) await sleep(700)
  }
}

describe('bring water_bucket fill (idkcraft-k2ze)', () => {
  it("'bring me water_bucket 1' with an empty bucket fills, returns and tosses", async () => {
    const bot = mockBot({
      items: [{ name: 'bucket', count: 1 }],
      playerPos: pos(30, 64, 0),
      water: [[2, 64, 0]],
      levels: { '2,64,0': '0' },
    })
    handleChat(bot, tickerFor(bot), 'P', 'bring me water_bucket 1')
    assert.deepEqual(bot.lines, ['filling a bucket for you'])
    const o = bot._tickerCtx.bring
    assert.equal(o && o.kind, 'item')
    assert.equal(o && o.phase, 'fill')
    await drive(bot, bot._tickerCtx)
    assert.ok(!bot._tickerCtx.bring, 'order ended')
    assert.deepEqual(bot.tossCalls, [[ITEMS.water_bucket, null, 1]])
    assert.ok(bot.lines.includes('here is 1 water_bucket'), `lines: ${bot.lines}`)
  })

  it('without an empty bucket the honest refusal is unchanged', () => {
    const bot = mockBot({ items: [], playerPos: pos(30, 64, 0), water: [[2, 64, 0]], levels: { '2,64,0': '0' } })
    handleChat(bot, tickerFor(bot), 'P', 'bring me water_bucket 1')
    assert.deepEqual(bot.lines, ["can't get water_bucket: no recipe, no source"])
    assert.ok(!bot._tickerCtx.bring, 'no order created')
  })

  it('with a bucket but no water the order refuses honestly', async () => {
    const bot = mockBot({ items: [{ name: 'bucket', count: 1 }], playerPos: pos(30, 64, 0) })
    handleChat(bot, tickerFor(bot), 'P', 'bring me water_bucket 1')
    assert.deepEqual(bot.lines, ['filling a bucket for you'])
    await bring(bot, bot._tickerCtx, null, {})
    await flush()
    assert.ok(!bot._tickerCtx.bring, 'order ended')
    assert.ok(bot.lines.includes('no water nearby to fill the bucket'), `lines: ${bot.lines}`)
  })

  it('flow water never fills: the walk targets the farther source', async () => {
    const bot = mockBot({
      items: [{ name: 'bucket', count: 1 }],
      playerPos: pos(30, 64, 0),
      water: [[2, 64, 0], [30, 64, 0]],
      levels: { '2,64,0': '5', '30,64,0': '0' },
    })
    handleChat(bot, tickerFor(bot), 'P', 'bring me water_bucket 1')
    await bring(bot, bot._tickerCtx, null, {})
    await flush()
    const o = bot._tickerCtx.bring
    assert.ok(o && o.phase === 'fill', 'order still filling')
    assert.equal(bot._tickerCtx.lastGoalKey, 'bring-fill:30,64,0', 'walks to the source, not the in-reach flow')
  })

  it('a homed order that fell through an empty chest still fills (revmux 01 core-1)', async () => {
    const bot = mockBot({
      items: [{ name: 'bucket', count: 1 }],
      playerPos: pos(30, 64, 0),
      water: [[2, 64, 0]],
      levels: { '2,64,0': '0' },
    })
    // The chest rung came up short: enterCraftOrRefuse is its funnel.
    const o = { kind: 'item', name: 'water_bucket', names: ['water_bucket'], want: 1, by: 'P', phase: 'craft' }
    bring.enterCraftOrRefuse(bot, {}, o)
    assert.equal(o.phase, 'fill', 'fill opens after the empty chest')
    assert.ok(bot.lines.includes('filling a bucket for you'), `lines: ${bot.lines}`)
    const ctx = { bring: o }
    await drive(bot, ctx)
    assert.ok(!ctx.bring, 'order ended')
    assert.ok(bot.lines.includes('here is 1 water_bucket'), `lines: ${bot.lines}`)
  })

  it('a partial fill that runs dry still delivers (revmux 01 core-2)', async () => {
    const bot = mockBot({
      items: [{ name: 'bucket', count: 2 }],
      playerPos: pos(30, 64, 0),
      water: [[2, 64, 0]],
      levels: { '2,64,0': '0' },
    })
    handleChat(bot, tickerFor(bot), 'P', 'bring me water_bucket 2')
    const ctx = bot._tickerCtx
    for (let i = 0; i < 20 && ctx.bring && ctx.bring.phase === 'fill'; i++) {
      await bring(bot, ctx, null, {})
      await flush()
      if (ctx.bring && ctx.bring.fillInFlight) await sleep(700)
      // The puddle scoops dry after the first bucket.
      if ((bot._items.find((it) => it && it.name === 'water_bucket') || { count: 0 }).count >= 1) bot._water = []
    }
    assert.ok(ctx.bring && ctx.bring.phase === 'return', 'partial fill returns instead of refusing')
    assert.ok(bot.lines.includes('only 1 water_bucket, coming'), `lines: ${bot.lines}`)
    await drive(bot, ctx)
    assert.ok(!ctx.bring, 'order ended')
    assert.ok(bot.lines.includes('here is 1 water_bucket'), `lines: ${bot.lines}`)
  })

  it('an in-reach walk that never arrives still gives the cell up (revmux 01 core-3)', async () => {
    const bot = mockBot({
      items: [{ name: 'bucket', count: 1 }],
      playerPos: pos(30, 64, 0),
      water: [[2, 64, 0]],
      levels: { '2,64,0': '0' },
    })
    handleChat(bot, tickerFor(bot), 'P', 'bring me water_bucket 1')
    bot._moving = true // shoreline thrash: in reach, never arrived
    for (let i = 0; i < 40 && bot._tickerCtx.bring; i++) {
      await bring(bot, bot._tickerCtx, null, {})
      await flush()
    }
    const o = bot._tickerCtx.bring
    assert.ok(!o, 'order ended instead of holding the body')
    assert.ok(!bot.lines.some((l) => l.includes('here is')), `lines: ${bot.lines}`)
  })

  it('the order-level budget ends a hopeless fill (revmux 01 core-3)', async () => {
    const bot = mockBot({
      items: [{ name: 'bucket', count: 1 }],
      playerPos: pos(30, 64, 0),
      water: [[2, 64, 0]],
      levels: { '2,64,0': '0' },
    })
    handleChat(bot, tickerFor(bot), 'P', 'bring me water_bucket 1')
    bot._tickerCtx.bring.fillStartedAt = Date.now() - 10 * 60 * 1000
    await bring(bot, bot._tickerCtx, null, {})
    await flush()
    assert.ok(!bot._tickerCtx.bring, 'order ended')
    assert.ok(bot.lines.includes('could not fill the bucket in time'), `lines: ${bot.lines}`)
  })

  it('buried water never fills: the walk targets the open source (revmux 02 core-1)', async () => {
    const bot = mockBot({
      items: [{ name: 'bucket', count: 1 }],
      playerPos: pos(30, 64, 0),
      water: [[2, 64, 0], [30, 64, 0]],
      levels: { '2,64,0': '0', '30,64,0': '0' },
      rock: ['2,65,0'],
    })
    handleChat(bot, tickerFor(bot), 'P', 'bring me water_bucket 1')
    await bring(bot, bot._tickerCtx, null, {})
    await flush()
    const o = bot._tickerCtx.bring
    assert.ok(o && o.phase === 'fill', 'order still filling')
    assert.equal(bot._tickerCtx.lastGoalKey, 'bring-fill:30,64,0', 'walks past the buried aquifer to the open source')
  })

  it('flow past the slice never masks the source (deep scan)', async () => {
    // Seventy nearer flow cells plus one farther source, and a
    // count-honouring findBlocks: a 64-cap slice ends inside the flow and
    // refuses despite the source behind it.
    const cells = []
    for (let i = 1; i <= 70; i++) cells.push([i, 64, 0])
    cells.push([100, 64, 0])
    const levels = {}
    for (const [x, y, z] of cells) levels[`${x},${y},${z}`] = x === 100 ? '0' : '2'
    const bot = mockBot({
      items: [{ name: 'bucket', count: 1 }],
      playerPos: pos(30, 64, 0),
      water: cells,
      levels,
    })
    handleChat(bot, tickerFor(bot), 'P', 'bring me water_bucket 1')
    await bring(bot, bot._tickerCtx, null, {})
    await flush()
    const o = bot._tickerCtx.bring
    assert.ok(o && o.phase === 'fill', 'order still filling, not refused')
    assert.equal(bot._tickerCtx.lastGoalKey, 'bring-fill:100,64,0', 'walks past 70 flow cells to the source')
  })

  it('an unreachable cell is skipped, the next one fills', async () => {
    const bot = mockBot({
      items: [{ name: 'bucket', count: 1 }],
      playerPos: pos(30, 64, 0),
      water: [[2, 64, 0], [30, 64, 0]],
      levels: { '2,64,0': '0', '30,64,0': '0' },
    })
    handleChat(bot, tickerFor(bot), 'P', 'bring me water_bucket 1')
    // Never arrives at the near cell: the walk patience marks it tried,
    // then the bot reaches the far one and the scoop fires.
    bot._moving = true
    for (let i = 0; i < 80; i++) {
      await bring(bot, bot._tickerCtx, null, {})
      await flush()
      const oo = bot._tickerCtx.bring
      if (!oo || oo.phase !== 'fill' || oo.fillInFlight) break
      if (oo.fillTarget && oo.fillTarget.key === '30,64,0') {
        bot._moving = false
        bot.entity.position = pos(31, 64, 0)
      }
    }
    const o = bot._tickerCtx.bring
    assert.ok(o && o.fillTried['2,64,0'], 'unreachable cell marked tried')
    await drive(bot, bot._tickerCtx)
    assert.ok(!bot._tickerCtx.bring, 'order ended')
    assert.ok(bot.lines.includes('here is 1 water_bucket'), `lines: ${bot.lines}`)
  })
})
