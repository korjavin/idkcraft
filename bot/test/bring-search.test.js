'use strict'

// Bring-me search legs (idkcraft-atl.8): an empty local find walks explore
// legs and re-finds instead of refusing. Per-leg model choice is the
// two-option menu search_more / give_up (FSM reserve: search_more until K);
// exhaustion refuses honestly; stop mid-search cancels the order.

const { describe, it, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const bring = require('../src/behaviours/bring')
const { chooseBringSearch } = bring
const { handleChat, createTicker } = require('../src/index')

function pos(x, y, z) {
  const p = {
    x, y, z,
    distanceTo: (q) => Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z),
    clone() { return pos(p.x, p.y, p.z) },
    offset(ox, oy, oz) { return pos(p.x + ox, p.y + oy, p.z + oz) },
  }
  return p
}

const BLOCKS = { coal_ore: 11, stone: 1 }
const ITEMS = { beef: 42, bread: 41, coal: 21, stone_pickaxe: 22 }

function mockBot({ items = [], playerPos = null, animals = [], spots = [], names = {} } = {}) {
  const lines = []
  const tossCalls = []
  const attackCalls = []
  const calls = { setGoal: 0, goals: [] }
  const blocksByName = {}
  for (const [name, id] of Object.entries(BLOCKS)) blocksByName[name] = { id }
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
    spawnPoint: pos(0, 64, 0),
    registry: { blocksByName, itemsByName },
    players: { P: { username: 'P', entity: playerPos ? { position: playerPos } : null } },
    _moving: false,
    _items: items,
    digCalls: 0,
    pathfinder: {
      goal: null,
      setGoal: (goal) => { calls.setGoal++; calls.goals.push(goal); bot.pathfinder.goal = goal },
      stop: () => {},
      isMoving: () => bot._moving,
      bestHarvestTool: () => ({ name: 'stone_pickaxe', type: 99 }),
    },
    lookAt() {},
    attack(e) { attackCalls.push(e && e.id) },
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
      if (!p || typeof p.x !== 'number') return null
      const n = names[`${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`]
      return n ? { name: n, position: pos(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)) } : null
    },
    canDigBlock: () => true,
    dig: async (block) => {
      bot.digCalls++
      const bp = block && block.position
      if (bp) delete names[`${bp.x},${bp.y},${bp.z}`]
      if (bot.held && bot.held.endsWith('_pickaxe')) bot._items.push({ name: 'coal', count: 1 })
    },
    toss: async (id, meta, n) => { tossCalls.push([id, meta, n]) },
    chat(line) { lines.push(String(line)) },
  }
  return bot
}

function cow(id, x, y = 64, z = 0) {
  const p = pos(x, y, z)
  return { id, name: 'cow', type: 'mob', position: p, height: 1.4, isValid: true }
}

function tickerFor(bot, brain) {
  return createTicker({
    bot,
    brain: brain || { decide: async () => ({ action: 'idle', sprint: false, source: 'stub' }) },
    tickMs: 10,
    idleTickMs: 10,
  })
}

function anchor(ctx) {
  ctx.home = { site: { x: 0, y: 64, z: 0 } }
}

const tick2 = () => new Promise((r) => setImmediate(() => setImmediate(r)))

// Drive the order; teleport along explore legs, walk the hunt/pickup/return.
// statslegs tracks the most legs any live order reached (orders die on done).
async function drive(bot, ctx, onKill, maxTicks = 600, stats = null) {
  for (let i = 0; i < maxTicks && ctx.bring; i++) {
    await bring(bot, ctx, null, {})
    const o = ctx.bring
    if (!o) break
    if (stats && o.searchLegs) stats.legs = Math.max(stats.legs || 0, o.searchLegs.legs)
    const gk = ctx.lastGoalKey
    if (gk.startsWith('explore:') && ctx.explore && ctx.explore.target) {
      const t = ctx.explore.target
      bot.entity.position = pos(t.x, 64, t.z) // arrive next tick
      bot._moving = false
    } else if (gk.startsWith('bring-hunt:') && o.pos) {
      bot.entity.position = pos(o.pos.x + 1, o.pos.y, o.pos.z)
      bot._moving = false
      if (o.phase === 'kill' && onKill) onKill(bot, o)
    } else if (gk.startsWith('bring-food-pickup:')) {
      bot._moving = false
      bot.entity.position = pos(o.dropPos.x, o.dropPos.y, o.dropPos.z)
    } else if (gk.startsWith('bring:') && o.pos) {
      bot.entity.position = pos(o.pos.x + 1, o.pos.y, o.pos.z)
      bot._moving = false
    } else if (gk.startsWith('bring-pickup')) {
      bot._moving = false
    } else if (gk.startsWith('bring-return:')) {
      bot._moving = false
      const pp = bot.players.P.entity.position
      bot.entity.position = pos(pp.x, pp.y, pp.z)
    }
  }
}

beforeEach(() => { delete process.env.BRING_SEARCH_LEGS; delete process.env.BRING_SEARCH_MINUTES })
afterEach(() => { delete process.env.BRING_SEARCH_LEGS; delete process.env.BRING_SEARCH_MINUTES })

describe('bring-me search legs (idkcraft-atl.8)', () => {
  it('cow at 120: explore legs, hunt, toss', async () => {
    // K raised: the spiral reaches ring-128 north around leg 25 with
    // teleports, past the default K=4 (~80 blocks of reach with real
    // walking). Defaults are covered by the one-leg-out test below.
    process.env.BRING_SEARCH_LEGS = '30'
    const bot = mockBot({ playerPos: pos(30, 64, 0), animals: [cow(11, 0, 64, -120)] })
    bot._moving = true
    const ticker = tickerFor(bot)
    anchor(bot._tickerCtx)
    handleChat(bot, ticker, 'P', 'bring me food 1')
    assert.deepEqual(bot.lines, ['looking for animals'])
    const stats = {}
    await drive(bot, bot._tickerCtx, (b, o) => {
      const ent = b.entities[o.animal.id]
      if (ent) ent.isValid = false
      if (!b._items.some((i) => i.name === 'beef')) b._items.push({ name: 'beef', count: 1 })
    }, 600, stats)
    assert.equal(bot._tickerCtx.bring, null)
    assert.ok(bot.lines.some((l) => l === 'no animals nearby, searching…'), `lines: ${bot.lines}`)
    assert.ok(bot.calls.goals.some((g) => g && g.constructor && g.constructor.name === 'GoalXZ'), 'walked explore legs')
    assert.ok(stats.legs > 4, `walked past the default K: ${stats.legs} legs`)
    assert.ok(bot.lines.some((l) => /^going hunting: cow \d+ blocks away$/.test(l)), `lines: ${bot.lines}`)
    assert.ok(bot.lines.some((l) => l === 'here are 1 beef'), `lines: ${bot.lines}`)
    assert.deepEqual(bot.tossCalls, [[ITEMS.beef, null, 1]])
  })

  it('empty world: honest refusal after the default 4 legs', async () => {
    const bot = mockBot({ playerPos: pos(30, 64, 0) })
    const ticker = tickerFor(bot)
    anchor(bot._tickerCtx)
    handleChat(bot, ticker, 'P', 'bring me food')
    await drive(bot, bot._tickerCtx, null)
    assert.equal(bot._tickerCtx.bring, null)
    assert.ok(bot.lines.some((l) => l === 'no animals nearby, searching…'), `lines: ${bot.lines}`)
    assert.ok(bot.lines.some((l) => l === 'searched 4 areas, no animals'), `lines: ${bot.lines}`)
    assert.equal(bot.attackCalls.length, 0)
  })

  it('blocks: coal past the sync find is legged to, dug and tossed', async () => {
    const names = { '0,64,-40': 'coal_ore' }
    const spots = [pos(0, 64, -40)]
    const bot = mockBot({ spots, names, items: [{ name: 'stone_pickaxe', count: 1 }], playerPos: pos(30, 64, 0) })
    const ticker = tickerFor(bot)
    anchor(bot._tickerCtx)
    bot._tickerCtx.bring = {
      kind: 'block', name: 'coal_ore', want: 1, by: 'P', phase: 'find',
      have: 0, announced: false, searchSkipFar: true,
    }
    await drive(bot, bot._tickerCtx, null)
    assert.equal(bot._tickerCtx.bring, null)
    assert.ok(bot.lines.some((l) => l === 'no coal_ore nearby, searching…'), `lines: ${bot.lines}`)
    assert.ok(bot.lines.some((l) => l === 'here are 1 coal'), `lines: ${bot.lines}`)
    assert.deepEqual(bot.tossCalls, [[ITEMS.coal, null, 1]])
  })

  it('blocks with nothing anywhere: honest refusal after 4 legs', async () => {
    const bot = mockBot({ items: [{ name: 'stone_pickaxe', count: 1 }], playerPos: pos(30, 64, 0) })
    const ticker = tickerFor(bot)
    anchor(bot._tickerCtx)
    bot._tickerCtx.bring = {
      kind: 'block', name: 'coal_ore', want: 1, by: 'P', phase: 'find',
      have: 0, announced: false, searchSkipFar: true,
    }
    await drive(bot, bot._tickerCtx, null)
    assert.equal(bot._tickerCtx.bring, null)
    assert.ok(bot.lines.some((l) => l === 'searched 4 areas, no coal_ore'), `lines: ${bot.lines}`)
  })

  it('model give_up refuses at once with no legs walked', async () => {
    const seen = []
    const brain = {
      decide: async () => ({ action: 'idle', sprint: false, source: 'stub' }),
      source: 'test',
      ask: async (q) => { seen.push(q); return 'give_up' },
    }
    const bot = mockBot({ playerPos: pos(30, 64, 0) })
    const ticker = tickerFor(bot, brain)
    anchor(bot._tickerCtx)
    handleChat(bot, ticker, 'P', 'bring me food')
    await drive(bot, bot._tickerCtx, null)
    assert.equal(bot._tickerCtx.bring, null)
    assert.equal(seen.length, 1)
    assert.deepEqual(Object.keys(seen[0].criteria).sort(), ['give_up', 'search_more'])
    assert.ok(bot.lines.some((l) => l === 'searched 0 areas, no animals'), `lines: ${bot.lines}`)
    assert.ok(!bot.calls.goals.some((g) => g && g.constructor && g.constructor.name === 'GoalXZ'), 'no leg walked')
  })

  it('model search_more is asked once per leg until K', async () => {
    let calls = 0
    const brains = []
    const brain = {
      decide: async () => ({ action: 'idle', sprint: false, source: 'stub' }),
      source: 'test',
      ask: async (q) => { calls++; brains.push(q.state); return 'search_more' },
    }
    const bot = mockBot({ playerPos: pos(30, 64, 0) })
    const ticker = tickerFor(bot, brain)
    anchor(bot._tickerCtx)
    handleChat(bot, ticker, 'P', 'bring me food')
    await drive(bot, bot._tickerCtx, null)
    assert.equal(bot._tickerCtx.bring, null)
    assert.equal(calls, 4)
    assert.ok(brains[0].startsWith('search=food legs=0/4'), `first ask: ${brains[0]}`)
    assert.ok(bot.lines.some((l) => l === 'searched 4 areas, no animals'), `lines: ${bot.lines}`)
  })

  it('stop mid-search cancels the order and drops the leg', async () => {
    const bot = mockBot({ playerPos: pos(30, 64, 0) })
    const ticker = tickerFor(bot)
    anchor(bot._tickerCtx)
    handleChat(bot, ticker, 'P', 'bring me food')
    await bring(bot, bot._tickerCtx, null, {})
    assert.equal(bot._tickerCtx.bring.phase, 'searchwalk')
    await bring(bot, bot._tickerCtx, null, {}) // leg issues its GoalXZ
    assert.ok(bot._tickerCtx.explore && bot._tickerCtx.explore.target, 'leg in progress')
    ticker.stop()
    assert.equal(bot._tickerCtx.bring, null)
    assert.equal(bot._tickerCtx.explore.target, null)
  })

  it('chooseBringSearch: two-option menu, FSM reserve, fallbacks', async () => {
    // No brain: FSM reserve searches while legs remain.
    assert.deepEqual(await chooseBringSearch(null, 'search=food legs=0/4 last=empty', 4),
      { action: 'search_more', source: 'fsm', fsm: 'search_more', model: null })
    // Spent budget without asking: only-option give_up.
    const spy = { calls: 0, ask: async () => { spy.calls++; return 'search_more' } }
    assert.deepEqual(await chooseBringSearch(spy, 'search=food legs=4/4 last=empty', 0),
      { action: 'give_up', source: 'only-option', fsm: 'give_up', model: null })
    assert.equal(spy.calls, 0)
    // Invalid label and timeout fall back to the FSM.
    const bad = { source: 'test', ask: async () => 'dance' }
    const r1 = await chooseBringSearch(bad, 'search=food legs=1/4 last=empty', 3)
    assert.equal(r1.action, 'search_more')
    assert.equal(r1.source, 'fsm-fallback')
    const slow = { source: 'test', ask: async () => { const e = new Error('too slow'); e.name = 'TimeoutError'; throw e } }
    const r2 = await chooseBringSearch(slow, 'search=food legs=1/4 last=empty', 3)
    assert.equal(r2.action, 'search_more')
    assert.equal(r2.source, 'fsm-fallback')
  })
  it('default K finds a cow one leg out', async () => {
    // 60 out: past the sync 48, inside 48 of the first leg arrival (0,-16).
    const bot = mockBot({ playerPos: pos(30, 64, 0), animals: [cow(11, 0, 64, -60)] })
    bot._moving = true
    const ticker = tickerFor(bot)
    anchor(bot._tickerCtx)
    handleChat(bot, ticker, 'P', 'bring me food 1')
    const stats = {}
    await drive(bot, bot._tickerCtx, (b, o) => {
      const ent = b.entities[o.animal.id]
      if (ent) ent.isValid = false
      if (!b._items.some((i) => i.name === 'beef')) b._items.push({ name: 'beef', count: 1 })
    }, 600, stats)
    assert.equal(bot._tickerCtx.bring, null)
    assert.ok(bot.lines.some((l) => l === 'no animals nearby, searching…'), `lines: ${bot.lines}`)
    assert.ok(bot.lines.some((l) => l === 'here are 1 beef'), `lines: ${bot.lines}`)
    assert.ok(!bot.lines.some((l) => l.startsWith('searched')), `no exhaustion: ${bot.lines}`)
    assert.equal(stats.legs, 1)
  })

  it('spent time budget refuses without asking', async () => {
    let asks = 0
    const brain = {
      decide: async () => ({ action: 'idle', sprint: false, source: 'stub' }),
      source: 'test',
      ask: async () => { asks++; return 'search_more' },
    }
    const bot = mockBot({ playerPos: pos(30, 64, 0) })
    const ticker = tickerFor(bot, brain)
    anchor(bot._tickerCtx)
    bot._tickerCtx.bring = {
      kind: 'food', name: 'food', want: 1, by: 'P', phase: 'find',
      have: 0, announced: false,
      searchLegs: { legs: 0, startedAt: Date.now() - 4 * 60 * 1000, announced: false, last: 'empty' },
    }
    await bring(bot, bot._tickerCtx, null, {})
    assert.equal(bot._tickerCtx.bring, null)
    assert.equal(asks, 0)
    assert.ok(bot.lines.some((l) => l === 'searched 0 areas, no animals'), `lines: ${bot.lines}`)
  })

  it('setBring with an anchor opens legs when far has no shell; stone is refused', async () => {
    const bot = mockBot({ items: [{ name: 'stone_pickaxe', count: 1 }], playerPos: pos(30, 64, 0) })
    const ticker = tickerFor(bot)
    anchor(bot._tickerCtx)
    handleChat(bot, ticker, 'P', 'bring me coal_ore')
    assert.deepEqual(bot.lines, ['nothing within 48, searching for coal_ore…'])
    const o = bot._tickerCtx.bring
    assert.equal(o && o.kind, 'block')
    assert.equal(o && o.phase, 'find')
    assert.equal(o && o.searchSkipFar, true)
    await drive(bot, bot._tickerCtx, null)
    assert.equal(bot._tickerCtx.bring, null)
    assert.ok(bot.lines.some((l) => l === 'searched 4 areas, no coal_ore'), `lines: ${bot.lines}`)

    const stoneBot = mockBot({ playerPos: pos(30, 64, 0) })
    const stoneTicker = tickerFor(stoneBot)
    anchor(stoneBot._tickerCtx)
    handleChat(stoneBot, stoneTicker, 'P', 'bring me stone')
    assert.deepEqual(stoneBot.lines, ["can't bring stone — ores and logs only"])
    assert.ok(!stoneBot._tickerCtx.bring, 'no order created')
  })

  it('empty far completion opens legs through the ticker', async () => {
    const names = { '48,64,0': 'stone', '96,64,0': 'stone', '128,64,0': 'stone', '160,64,0': 'stone' }
    const bot = mockBot({ names, items: [{ name: 'stone_pickaxe', count: 1 }], playerPos: pos(30, 64, 0) })
    const ticker = tickerFor(bot)
    anchor(bot._tickerCtx)
    handleChat(bot, ticker, 'P', 'bring me coal')
    assert.ok(bot._tickerCtx.pendingSearch, 'far search pending')
    for (let i = 0; i < 40 && bot._tickerCtx.pendingSearch; i++) await ticker.tick()
    assert.equal(bot._tickerCtx.pendingSearch, null)
    const o = bot._tickerCtx.bring
    assert.equal(o && o.kind, 'block')
    assert.ok(o && (o.phase === 'find' || o.phase === 'searchwalk'), `order searching: ${o && o.phase}`)
    assert.ok(!bot.lines.some((l) => l.includes('within 160 blocks')), `no far refusal: ${bot.lines}`)
    await drive(bot, bot._tickerCtx, null)
    assert.equal(bot._tickerCtx.bring, null)
    assert.ok(bot.lines.some((l) => l === 'searched 4 areas, no coal'), `lines: ${bot.lines}`)
  })

  it('stop mid-ask touches nothing: no chat, no refuse', async () => {
    let resolveAsk = null
    const brain = {
      decide: async () => ({ action: 'idle', sprint: false, source: 'stub' }),
      source: 'test',
      ask: () => new Promise((res) => { resolveAsk = res }),
    }
    const bot = mockBot({ playerPos: pos(30, 64, 0) })
    const ticker = tickerFor(bot, brain)
    anchor(bot._tickerCtx)
    handleChat(bot, ticker, 'P', 'bring me food')
    const p = bring(bot, bot._tickerCtx, null, {})
    await tick2()
    assert.ok(resolveAsk, 'ask in flight')
    ticker.stop()
    resolveAsk('search_more')
    await p
    assert.equal(bot._tickerCtx.bring, null)
    assert.deepEqual(bot.lines, ['looking for animals'])
  })

  it('a new order mid-ask survives the stale answer', async () => {
    let resolveAsk = null
    const brain = {
      decide: async () => ({ action: 'idle', sprint: false, source: 'stub' }),
      source: 'test',
      ask: () => new Promise((res) => { resolveAsk = res }),
    }
    const bot = mockBot({ playerPos: pos(30, 64, 0) })
    const ticker = tickerFor(bot, brain)
    anchor(bot._tickerCtx)
    handleChat(bot, ticker, 'P', 'bring me food')
    const p = bring(bot, bot._tickerCtx, null, {})
    await tick2()
    const fresh = { kind: 'food', name: 'food', want: 1, by: 'P', phase: 'find', have: 0, announced: false }
    bot._tickerCtx.bring = fresh
    resolveAsk('give_up')
    await p
    assert.equal(bot._tickerCtx.bring, fresh)
    assert.equal(fresh.phase, 'find')
    assert.ok(!fresh.searchLegs, 'stale answer wrote nothing')
    assert.deepEqual(bot.lines, ['looking for animals'])
  })
  it('exhausted spiral refuses at once without walking', async () => {
    const bot = mockBot({ playerPos: pos(30, 64, 0) })
    const ticker = tickerFor(bot)
    anchor(bot._tickerCtx)
    bot._tickerCtx.explore = { visited: new Set(), target: null, lastPos: null, stalls: 0, markStart: 0, chatAt: 0 }
    for (const r of [16, 32, 64, 128, 192, 256]) {
      for (let a = 0; a < 8; a++) {
        const x = Math.round(r * Math.sin(a * Math.PI / 4))
        const z = Math.round(-r * Math.cos(a * Math.PI / 4))
        bot._tickerCtx.explore.visited.add(Math.floor(x / 16) + ',' + Math.floor(z / 16))
      }
    }
    handleChat(bot, ticker, 'P', 'bring me food')
    await bring(bot, bot._tickerCtx, null, {}) // find -> searchwalk
    assert.equal(bot._tickerCtx.bring.phase, 'searchwalk')
    await bring(bot, bot._tickerCtx, null, {}) // leg finds no new ground
    assert.equal(bot._tickerCtx.bring, null)
    assert.equal(bot.calls.goals.length, 0)
    assert.ok(bot.lines.some((l) => l === 'searched 0 areas, no animals'), `lines: ${bot.lines}`)
  })

})
