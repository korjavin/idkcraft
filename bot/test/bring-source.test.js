'use strict'

// Bring source choice (idkcraft-atl.15): exposed ore (live or remembered)
// beats digging a buried hit by cost; a contested pair asks the model once
// with exactly two options. Mock style mirrors bring.test.js.

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const bring = require('../src/behaviours/bring')
const {
  decideBringSource, chooseBringSource, memoryNames, memoryExposed, memoryInBudget,
  liveExposed, buriedCand, bestExposed, SOURCE_COST,
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

function mockBot({ spots = [], names = {}, items = [], playerPos = null } = {}) {
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

function countingBrain(answer) {
  const seen = []
  return {
    seen,
    brain: {
      source: 'testmodel',
      decide: async () => ({ action: 'idle', sprint: false, source: 'stub' }),
      ask: async (q) => { seen.push(q); return answer },
    },
  }
}

function seedMemory(ctx, x, y, z, name, opts = {}) {
  if (!ctx.resources) ctx.resources = { items: new Map() }
  const item = { x, y, z, name, at: opts.at ?? Date.now() - 5 * 60000 }
  if (!('exposed' in opts)) item.exposed = true
  else if (opts.exposed !== undefined) item.exposed = opts.exposed
  // explicit exposed: undefined omits the key: a pre-flag record (atl.16)
  ctx.resources.items.set(`${x},${y},${z}`, item)
}

const PICK = [{ name: 'stone_pickaxe', count: 1 }]

const tick2 = () => new Promise((r) => setImmediate(() => setImmediate(r)))

describe('bring source choice (idkcraft-atl.15)', () => {
  it('(1) remembered exposed ore at 40 beats buried ore 5 down, no model ask', async () => {
    const names = { '0,59,0': 'iron_ore', '40,64,0': 'iron_ore', '41,64,0': 'air' }
    const bot = mockBot({ spots: [pos(0, 59, 0)], names, items: PICK, playerPos: pos(30, 64, 0) })
    const { seen, brain } = countingBrain('walk_exposed')
    const ticker = tickerFor(bot, brain)
    seedMemory(bot._tickerCtx, 40, 64, 0, 'iron_ore')
    handleChat(bot, ticker, 'P', 'bring me iron')
    assert.deepEqual(bot.lines, ['going for 3 iron_ore, 40 blocks away (exposed)'])
    assert.equal(seen.length, 0, 'clear winner asks nothing')
    const o = bot._tickerCtx.bring
    assert.deepEqual([o.pos.x, o.pos.y, o.pos.z], [40, 64, 0])
    assert.equal(o.exposed, true)
    assert.equal(o.far, true)
  })

  it('(1b) the same verdict on a find-phase re-find', async () => {
    const names = { '0,59,0': 'iron_ore', '40,64,0': 'iron_ore', '41,64,0': 'air' }
    const bot = mockBot({ spots: [pos(0, 59, 0)], names, items: PICK, playerPos: pos(30, 64, 0) })
    const { seen, brain } = countingBrain('walk_exposed')
    tickerFor(bot, brain)
    const ctx = bot._tickerCtx
    seedMemory(ctx, 40, 64, 0, 'iron_ore')
    ctx.bring = { kind: 'block', name: 'iron', want: 3, by: 'P', phase: 'find', have: 0, announced: false }
    await bring(bot, ctx, null, {})
    assert.deepEqual(bot.lines, ['going for 3 iron_ore, 40 blocks away (exposed)'])
    assert.equal(seen.length, 0, 'clear winner asks nothing')
    assert.deepEqual([ctx.bring.pos.x, ctx.bring.pos.y, ctx.bring.pos.z], [40, 64, 0])
    assert.equal(ctx.bring.phase, 'walk')
  })

  it('(2) no open ore anywhere: digs as today, exposed=false, bare line', async () => {
    const bot = mockBot({ spots: [pos(0, 59, 0)], names: { '0,59,0': 'iron_ore' }, items: PICK, playerPos: pos(30, 64, 0) })
    const { seen, brain } = countingBrain('walk_exposed')
    const ticker = tickerFor(bot, brain)
    handleChat(bot, ticker, 'P', 'bring me iron')
    assert.deepEqual(bot.lines, ['going for 3 iron_ore, 5 blocks away'])
    assert.equal(seen.length, 0)
    const o = bot._tickerCtx.bring
    assert.deepEqual([o.pos.x, o.pos.y, o.pos.z], [0, 59, 0])
    assert.equal(o.exposed, false)
    assert.ok(!o.far)
  })

  it('pre-flag memory (no exposed key) stays absent: beads independent', async () => {
    const names = { '0,59,0': 'iron_ore', '40,64,0': 'iron_ore', '41,64,0': 'air' }
    const bot = mockBot({ spots: [pos(0, 59, 0)], names, items: PICK, playerPos: pos(30, 64, 0) })
    const ticker = tickerFor(bot)
    seedMemory(bot._tickerCtx, 40, 64, 0, 'iron_ore', { exposed: undefined })
    handleChat(bot, ticker, 'P', 'bring me iron')
    assert.deepEqual(bot.lines, ['going for 3 iron_ore, 5 blocks away'])
    assert.deepEqual([bot._tickerCtx.bring.pos.x, bot._tickerCtx.bring.pos.y, bot._tickerCtx.bring.pos.z], [0, 59, 0])
  })

  it('exposed hit already nearest: legacy line byte-identical, memory ignored', async () => {
    const names = { '10,64,0': 'iron_ore', '11,64,0': 'air', '40,64,0': 'iron_ore', '41,64,0': 'air' }
    const bot = mockBot({ spots: [pos(10, 64, 0)], names, items: PICK, playerPos: pos(30, 64, 0) })
    const { seen, brain } = countingBrain('walk_exposed')
    const ticker = tickerFor(bot, brain)
    seedMemory(bot._tickerCtx, 40, 64, 0, 'iron_ore')
    handleChat(bot, ticker, 'P', 'bring me iron')
    assert.deepEqual(bot.lines, ['going for 3 iron_ore, 10 blocks away'])
    assert.equal(seen.length, 0)
    assert.deepEqual([bot._tickerCtx.bring.pos.x, bot._tickerCtx.bring.pos.y, bot._tickerCtx.bring.pos.z], [10, 64, 0])
  })

  it('wet nearest is not committed at chat time: find opens, dry farther wins (revmux 02 core-1)', async () => {
    const names = {
      '10,64,0': 'iron_ore', '10,65,0': 'water', '11,64,0': 'air', // wet but exposed
      '30,64,0': 'iron_ore', '31,64,0': 'air', // dry exposed
    }
    const bot = mockBot({ spots: [pos(10, 64, 0), pos(30, 64, 0)], names, items: PICK, playerPos: pos(60, 64, 0) })
    const ticker = tickerFor(bot)
    handleChat(bot, ticker, 'P', 'bring me iron')
    assert.deepEqual(bot.lines, ['nearest iron_ore is underwater, checking for a dry one…'])
    const ctx = bot._tickerCtx
    assert.equal(ctx.bring.phase, 'find', 'wet chat-time hit must not commit a walk')
    await bring(bot, ctx, null, {})
    assert.equal(ctx.bring.phase, 'walk')
    assert.deepEqual([ctx.bring.pos.x, ctx.bring.pos.y, ctx.bring.pos.z], [30, 64, 0])
    assert.match(bot.lines[1], /^going for 3 iron_ore, 30 blocks away$/)
  })

  it('(3) contested costs: exactly one ask with exactly 2 criteria, answer respected', async () => {
    const names = { '0,61,0': 'iron_ore', '30,64,0': 'iron_ore', '31,64,0': 'air' }
    const bot = mockBot({ spots: [pos(0, 61, 0)], names, items: PICK, playerPos: pos(30, 64, 0) })
    const { seen, brain } = countingBrain('dig_buried')
    tickerFor(bot, brain)
    const ctx = bot._tickerCtx
    seedMemory(ctx, 30, 64, 0, 'iron_ore')
    ctx.bring = { kind: 'block', name: 'iron', want: 3, by: 'P', phase: 'find', have: 0, announced: false }
    await bring(bot, ctx, null, {})
    assert.equal(seen.length, 1, 'one ask per order')
    assert.deepEqual(Object.keys(seen[0].criteria).sort(), ['dig_buried', 'walk_exposed'])
    assert.match(seen[0].state, /dist=30/)
    assert.match(seen[0].state, /depth=3/)
    assert.match(seen[0].state, /age=/)
    assert.deepEqual([ctx.bring.pos.x, ctx.bring.pos.y, ctx.bring.pos.z], [0, 61, 0])
    assert.deepEqual(bot.lines, ['going for 3 iron_ore, 3 blocks down (digging)'])
  })

  it('(3b) invalid model label: FSM reserve walk_exposed + escalation counted', async () => {
    const names = { '0,61,0': 'iron_ore', '30,64,0': 'iron_ore', '31,64,0': 'air' }
    const bot = mockBot({ spots: [pos(0, 61, 0)], names, items: PICK, playerPos: pos(30, 64, 0) })
    const { seen, brain } = countingBrain('dance')
    tickerFor(bot, brain)
    const ctx = bot._tickerCtx
    seedMemory(ctx, 30, 64, 0, 'iron_ore')
    ctx.bring = { kind: 'block', name: 'iron', want: 3, by: 'P', phase: 'find', have: 0, announced: false }
    await bring(bot, ctx, null, {})
    assert.equal(seen.length, 1)
    assert.deepEqual([ctx.bring.pos.x, ctx.bring.pos.y, ctx.bring.pos.z], [30, 64, 0])
    assert.deepEqual(bot.lines, ['going for 3 iron_ore, 30 blocks away (exposed)'])
    const metrics = require('../src/metrics')
    const text = await metrics.client.register.metrics()
    assert.match(text, /idkcraft_bot_escalation_total\{from="testmodel",to="fsm",reason="invalid"\} [1-9]/)
  })

  it('(3c) contested re-find replays the cached pick: still one ask', async () => {
    const names = { '0,61,0': 'iron_ore', '30,64,0': 'iron_ore', '31,64,0': 'air' }
    const bot = mockBot({ spots: [pos(0, 61, 0)], names, items: PICK, playerPos: pos(30, 64, 0) })
    const { seen, brain } = countingBrain('dig_buried')
    tickerFor(bot, brain)
    const ctx = bot._tickerCtx
    seedMemory(ctx, 30, 64, 0, 'iron_ore')
    ctx.bring = { kind: 'block', name: 'iron', want: 3, by: 'P', phase: 'find', have: 0, announced: false }
    await bring(bot, ctx, null, {})
    assert.equal(seen.length, 1)
    ctx.bring.pos = null // deny-strike re-picks the same pair
    ctx.bring.phase = 'find'
    await bring(bot, ctx, null, {})
    assert.equal(seen.length, 1, 'no second ask on the same order')
    assert.deepEqual([ctx.bring.pos.x, ctx.bring.pos.y, ctx.bring.pos.z], [0, 61, 0])
  })

  it('(3d) contested without a brain: silent FSM reserve, no crash', async () => {
    const names = { '0,61,0': 'iron_ore', '30,64,0': 'iron_ore', '31,64,0': 'air' }
    const bot = mockBot({ spots: [pos(0, 61, 0)], names, items: PICK, playerPos: pos(30, 64, 0) })
    tickerFor(bot) // stub brain: decide only, no ask
    const ctx = bot._tickerCtx
    seedMemory(ctx, 30, 64, 0, 'iron_ore')
    ctx.bring = { kind: 'block', name: 'iron', want: 3, by: 'P', phase: 'find', have: 0, announced: false }
    await bring(bot, ctx, null, {})
    assert.deepEqual([ctx.bring.pos.x, ctx.bring.pos.y, ctx.bring.pos.z], [30, 64, 0])
    assert.deepEqual(bot.lines, ['going for 3 iron_ore, 30 blocks away (exposed)'])
  })

  it('creation with loaded far shells: buried stash + exposed far verdict over ticks', async () => {
    const names = {
      '0,59,0': 'iron_ore', '60,64,0': 'iron_ore', '61,64,0': 'air',
      '48,64,0': 'stone', '96,64,0': 'stone', '128,64,0': 'stone', '160,64,0': 'stone',
    }
    const bot = mockBot({ spots: [pos(0, 59, 0), pos(60, 64, 0)], names, items: PICK, playerPos: pos(30, 64, 0) })
    const { seen, brain } = countingBrain('walk_exposed')
    const ticker = tickerFor(bot, brain)
    handleChat(bot, ticker, 'P', 'bring me iron')
    assert.deepEqual(bot.lines, ['only buried iron within 48, checking further for open ore…'])
    assert.ok(bot._tickerCtx.pendingSearch, 'far search pending')
    assert.ok(bot._tickerCtx.pendingSearch.buried, 'buried hit stashed')
    for (let i = 0; i < 200 && bot._tickerCtx.pendingSearch; i++) await ticker.tick()
    assert.equal(bot._tickerCtx.pendingSearch, null)
    assert.equal(seen.length, 0, 'clear winner asks nothing')
    assert.ok(bot.lines.includes('going for 3 iron_ore, 60 blocks away (exposed)'), `lines: ${bot.lines}`)
    assert.deepEqual([bot._tickerCtx.bring.pos.x, bot._tickerCtx.bring.pos.y, bot._tickerCtx.bring.pos.z], [60, 64, 0])
  })

  it('creation contested at edge 48: interim line, then one ask on the first tick', async () => {
    const names = { '0,61,0': 'iron_ore', '30,64,0': 'iron_ore', '31,64,0': 'air' }
    const bot = mockBot({ spots: [pos(0, 61, 0)], names, items: PICK, playerPos: pos(30, 64, 0) })
    const { seen, brain } = countingBrain('dig_buried')
    const ticker = tickerFor(bot, brain)
    seedMemory(bot._tickerCtx, 30, 64, 0, 'iron_ore')
    handleChat(bot, ticker, 'P', 'bring me iron')
    assert.deepEqual(bot.lines, ['comparing open and buried iron…'])
    assert.equal(bot._tickerCtx.bring.phase, 'find')
    await ticker.tick()
    assert.equal(seen.length, 1)
    assert.ok(bot.lines.includes('going for 3 iron_ore, 3 blocks down (digging)'), `lines: ${bot.lines}`)
  })

  it('far exposed with empty 48: only option, bare line, no ask (revmux 01 core-1)', async () => {
    const names = {
      '60,64,0': 'iron_ore', '61,64,0': 'air',
      '48,64,0': 'stone', '96,64,0': 'stone', '128,64,0': 'stone', '160,64,0': 'stone',
    }
    const bot = mockBot({ spots: [pos(60, 64, 0)], names, items: PICK, playerPos: pos(30, 64, 0) })
    const { seen, brain } = countingBrain('dig_buried') // must never be consulted
    const ticker = tickerFor(bot, brain)
    handleChat(bot, ticker, 'P', 'bring me iron')
    assert.deepEqual(bot.lines, ['nothing within 48, widening the search for iron…'])
    for (let i = 0; i < 200 && bot._tickerCtx.pendingSearch; i++) await ticker.tick()
    assert.equal(seen.length, 0, 'a single option never asks')
    assert.ok(bot.lines.includes('going for 3 iron_ore, 60 blocks away'), `lines: ${bot.lines}`)
    assert.ok(!bot.lines.some((l) => l.includes('(exposed)') || l.includes('(digging)')), `lines: ${bot.lines}`)
    assert.equal(bot._tickerCtx.bring.exposed, true)
  })

  it('buried 48-best without pickaxe tier: short pack still hands over (revmux 01 core-3)', () => {
    const names = {
      '0,59,0': 'coal_ore',
      '48,64,0': 'stone', '96,64,0': 'stone', '128,64,0': 'stone', '160,64,0': 'stone',
    }
    const bot = mockBot({ spots: [pos(0, 59, 0)], names, items: [{ name: 'coal', count: 2 }], playerPos: pos(30, 64, 0) })
    const ticker = tickerFor(bot)
    handleChat(bot, ticker, 'P', 'bring me coal 5')
    assert.deepEqual(bot.lines, ['only 2 coal, coming'])
    assert.equal(bot._tickerCtx.bring.kind, 'item')
    assert.equal(bot._tickerCtx.pendingSearch, null, 'no deferred search without a harvest tool')
  })

  it('stop mid-source-ask touches nothing: no chat, no commit (revmux 01 core-2)', async () => {
    let resolveAsk = null
    const brain = {
      decide: async () => ({ action: 'idle', sprint: false, source: 'stub' }),
      source: 'test',
      ask: () => new Promise((res) => { resolveAsk = res }),
    }
    const names = { '0,61,0': 'iron_ore', '30,64,0': 'iron_ore', '31,64,0': 'air' }
    const bot = mockBot({ spots: [pos(0, 61, 0)], names, items: PICK, playerPos: pos(30, 64, 0) })
    const ticker = tickerFor(bot, brain)
    const ctx = bot._tickerCtx
    seedMemory(ctx, 30, 64, 0, 'iron_ore')
    ctx.bring = { kind: 'block', name: 'iron', want: 3, by: 'P', phase: 'find', have: 0, announced: false }
    const p = bring(bot, ctx, null, {})
    await tick2()
    assert.ok(resolveAsk, 'ask in flight')
    ticker.stop()
    resolveAsk('dig_buried')
    await p
    assert.equal(ctx.bring, null)
    assert.deepEqual(bot.lines, [])
  })

  it('pending verdict retired mid-ask commits nothing (revmux 01 core-2)', async () => {
    let resolveAsk = null
    const brain = {
      decide: async () => ({ action: 'idle', sprint: false, source: 'stub' }),
      source: 'test',
      ask: () => new Promise((res) => { resolveAsk = res }),
    }
    const names = {
      '0,60,0': 'iron_ore', '60,64,0': 'iron_ore', '61,64,0': 'air',
      '48,64,0': 'stone', '96,64,0': 'stone', '128,64,0': 'stone', '160,64,0': 'stone',
    }
    const bot = mockBot({ spots: [pos(0, 60, 0), pos(60, 64, 0)], names, items: PICK, playerPos: pos(30, 64, 0) })
    const ticker = tickerFor(bot, brain)
    handleChat(bot, ticker, 'P', 'bring me iron')
    assert.deepEqual(bot.lines, ['only buried iron within 48, checking further for open ore…'])
    const t = ticker.tick()
    await tick2()
    assert.ok(resolveAsk, 'verdict ask in flight')
    handleChat(bot, ticker, 'P', 'stop')
    resolveAsk('walk_exposed')
    await t
    assert.ok(!bot._tickerCtx.bring, 'retired verdict commits nothing')
    assert.equal(bot._tickerCtx.pendingSearch, null)
    assert.ok(!bot.lines.some((l) => l.startsWith('going for')), `lines: ${bot.lines}`)
  })

  it('re-find reuses the far verdict until moved or edge-changed (revmux 01 body-3)', async () => {
    const names = {
      '0,59,0': 'iron_ore', '60,64,0': 'iron_ore', '61,64,0': 'air',
      '48,64,0': 'stone', '96,64,0': 'stone', '128,64,0': 'stone', '160,64,0': 'stone',
    }
    const bot = mockBot({ spots: [pos(0, 59, 0), pos(60, 64, 0)], names, items: PICK, playerPos: pos(30, 64, 0) })
    tickerFor(bot)
    const ctx = bot._tickerCtx
    ctx.bring = { kind: 'block', name: 'iron', want: 3, by: 'P', phase: 'find', have: 0, announced: true }
    await bring(bot, ctx, null, {})
    assert.equal(ctx.bring.phase, 'searchfar')
    await bring(bot, ctx, null, {})
    assert.equal(ctx.bring.phase, 'walk')
    assert.deepEqual([ctx.bring.pos.x, ctx.bring.pos.y, ctx.bring.pos.z], [60, 64, 0])
    assert.ok(ctx.bring.farCache, 'verdict cached')
    // Next unit from the same spot: no rescan, same-tick commit.
    let scans = 0
    const inner = bot.findBlocks.bind(bot)
    bot.findBlocks = (o) => { scans++; return inner(o) }
    ctx.bring.pos = null
    ctx.bring.phase = 'find'
    await bring(bot, ctx, null, {})
    assert.equal(ctx.bring.phase, 'walk', 'cached verdict commits same tick')
    assert.deepEqual([ctx.bring.pos.x, ctx.bring.pos.y, ctx.bring.pos.z], [60, 64, 0])
    assert.equal(scans, 1, 'only the sync 48 scan ran')
    // Walked off: the cache drops and the shells run again.
    names['248,64,0'] = 'stone'
    names['296,64,0'] = 'stone'
    names['328,64,0'] = 'stone'
    names['360,64,0'] = 'stone'
    bot.entity.position = pos(200, 64, 0)
    ctx.bring.pos = null
    ctx.bring.phase = 'find'
    await bring(bot, ctx, null, {})
    assert.equal(ctx.bring.phase, 'searchfar', 'moved-off cache rescans')
    // Back home but the edge shrank: the cache drops, buried verdict, no ask.
    delete names['48,64,0']
    delete names['96,64,0']
    delete names['128,64,0']
    delete names['160,64,0']
    bot.entity.position = pos(0, 64, 0)
    ctx.bring.pos = null
    ctx.bring.phase = 'find'
    await bring(bot, ctx, null, {})
    assert.equal(ctx.bring.phase, 'walk')
    assert.deepEqual([ctx.bring.pos.x, ctx.bring.pos.y, ctx.bring.pos.z], [0, 59, 0])
  })

  it('walk to a memory target tolerates the unloaded chunk, re-finds on a loaded mismatch', async () => {
    const bot = mockBot({ spots: [], names: {}, items: PICK, playerPos: pos(30, 64, 0) })
    bot._moving = true
    tickerFor(bot)
    const ctx = bot._tickerCtx
    ctx.lastGoalKey = 'bring:30,64,0'
    ctx.bring = {
      kind: 'block', name: 'iron', want: 3, by: 'P', block: 'iron_ore', drop: 'raw_iron',
      pos: pos(30, 64, 0), phase: 'walk', stalls: 0, lastPos: null,
      have: 0, announced: true, exposed: true, far: true,
    }
    await bring(bot, ctx, null, {}) // target chunk unreadable: keep walking
    assert.equal(ctx.bring.phase, 'walk')
    bot.blockAt = (p) => ({ name: 'stone', position: pos(p.x, p.y, p.z) }) // loaded, mined out
    await bring(bot, ctx, null, {})
    assert.equal(ctx.bring.phase, 'find', 'loaded mismatch re-finds')
  })

  it('dug-out 48 falls back to the cached buried far hit, no rescan (revmux 02)', async () => {
    const names = {
      '0,59,0': 'iron_ore', '60,64,0': 'iron_ore',
      '48,64,0': 'stone', '96,64,0': 'stone', '128,64,0': 'stone', '160,64,0': 'stone',
    }
    const bot = mockBot({ spots: [pos(0, 59, 0), pos(60, 64, 0)], names, items: PICK, playerPos: pos(30, 64, 0) })
    tickerFor(bot)
    const ctx = bot._tickerCtx
    ctx.bring = { kind: 'block', name: 'iron', want: 3, by: 'P', phase: 'find', have: 0, announced: true }
    await bring(bot, ctx, null, {})
    await bring(bot, ctx, null, {})
    assert.equal(ctx.bring.phase, 'walk')
    assert.deepEqual([ctx.bring.pos.x, ctx.bring.pos.y, ctx.bring.pos.z], [0, 59, 0])
    delete names['0,59,0'] // vein dug out within 48
    let scans = 0
    const inner = bot.findBlocks.bind(bot)
    bot.findBlocks = (o) => { scans++; return inner(o) }
    ctx.bring.pos = null
    ctx.bring.phase = 'find'
    await bring(bot, ctx, null, {})
    assert.equal(ctx.bring.phase, 'walk', 'cached buried far hit commits same tick')
    assert.deepEqual([ctx.bring.pos.x, ctx.bring.pos.y, ctx.bring.pos.z], [60, 64, 0])
    assert.equal(scans, 1, 'only the sync 48 scan ran')
  })

  it('buried-48 path serves the cached exposed half when the buried half is dug (revmux 03 body-1)', async () => {
    const names = {
      '0,59,0': 'iron_ore', '60,64,0': 'iron_ore', '61,64,0': 'air',
      '60,59,0': 'air', // the cached buried half, dug out (loaded chunk reads air)
      '48,64,0': 'stone', '96,64,0': 'stone', '128,64,0': 'stone', '160,64,0': 'stone',
    }
    const bot = mockBot({ spots: [pos(0, 59, 0), pos(60, 64, 0)], names, items: PICK, playerPos: pos(30, 64, 0) })
    tickerFor(bot)
    const ctx = bot._tickerCtx
    ctx.bring = { kind: 'block', name: 'iron', want: 3, by: 'P', phase: 'find', have: 0, announced: true }
    // An earlier far scan cached both halves; this order has since dug the
    // buried half. The exposed half is live.
    ctx.bring.farCache = {
      x: 0, y: 64, z: 0, edge: 160, hit: { name: 'iron_ore', pos: pos(60, 64, 0) },
      buriedHit: { name: 'iron_ore', pos: pos(60, 59, 0) },
    }
    let scans = 0
    const inner = bot.findBlocks.bind(bot)
    bot.findBlocks = (o) => { scans++; return inner(o) }
    await bring(bot, ctx, null, {})
    assert.equal(ctx.bring.phase, 'walk', 'dug buried half does not rescan the buried path')
    assert.deepEqual([ctx.bring.pos.x, ctx.bring.pos.y, ctx.bring.pos.z], [60, 64, 0])
    assert.equal(scans, 1, 'only the sync 48 scan ran')
  })

  it('a finished search leg drops the far cache: the next find rescans (revmux 02)', async () => {
    const bot = mockBot({ playerPos: pos(30, 64, 0) })
    delete bot.pathfinder.setGoal // broken executor fails the leg, like the pun test
    const ctx = {
      lastGoalKey: '', stepStatus: 'running',
      bring: {
        kind: 'block', name: 'coal_ore', phase: 'searchwalk',
        farCache: { x: 0, y: 64, z: 0, edge: 48, hit: null, buriedHit: null },
        searchLegs: { legs: 0, startedAt: Date.now(), announced: true, last: 'empty' },
      },
    }
    await bring(bot, ctx, null, {})
    assert.equal(ctx.bring.phase, 'find')
    assert.equal(ctx.bring.farCache, null, 'leg completion drops the cache')
  })

  it('unloaded cached hit rides far: walk tolerates, no walk/find flip (revmux 02)', async () => {
    const names = {
      '0,59,0': 'iron_ore', '60,64,0': 'iron_ore', '61,64,0': 'air',
      '48,64,0': 'stone', '96,64,0': 'stone', '128,64,0': 'stone', '160,64,0': 'stone',
    }
    const bot = mockBot({ spots: [pos(0, 59, 0), pos(60, 64, 0)], names, items: PICK, playerPos: pos(30, 64, 0) })
    bot._moving = true
    tickerFor(bot)
    const ctx = bot._tickerCtx
    ctx.bring = { kind: 'block', name: 'iron', want: 3, by: 'P', phase: 'find', have: 0, announced: true }
    await bring(bot, ctx, null, {})
    await bring(bot, ctx, null, {})
    assert.deepEqual([ctx.bring.pos.x, ctx.bring.pos.y, ctx.bring.pos.z], [60, 64, 0])
    delete names['60,64,0'] // chunk with the cached hit unloads
    delete names['61,64,0']
    ctx.bring.pos = null
    ctx.bring.phase = 'find'
    await bring(bot, ctx, null, {})
    assert.equal(ctx.bring.phase, 'walk', 'trusted-flag hit recommits')
    assert.equal(ctx.bring.far, true, 'unreadable target rides far')
    ctx.lastGoalKey = 'bring:60,64,0'
    await bring(bot, ctx, null, {})
    assert.equal(ctx.bring.phase, 'walk', 'no walk/find flip without far (tick 1)')
    assert.deepEqual([ctx.bring.pos.x, ctx.bring.pos.y, ctx.bring.pos.z], [60, 64, 0])
    await bring(bot, ctx, null, {})
    assert.equal(ctx.bring.phase, 'walk', 'no walk/find flip without far (tick 2)')
    assert.deepEqual([ctx.bring.pos.x, ctx.bring.pos.y, ctx.bring.pos.z], [60, 64, 0])
  })

  it('refused completion grafts nothing onto a surviving order (revmux 02 core-1)', async () => {
    const { advancePendingSearch } = require('../src/index')
    const names = { '60,64,0': 'gold_ore', '61,64,0': 'air' }
    const bot = mockBot({ spots: [pos(60, 64, 0)], names, items: [{ name: 'stone_pickaxe', count: 1 }] })
    tickerFor(bot)
    const ctx = bot._tickerCtx
    const old = { kind: 'block', name: 'iron', want: 3, by: 'P', phase: 'walk', have: 0, announced: true }
    ctx.bring = old
    ctx.pendingSearch = {
      cursor: {
        blockName: 'gold_ore', ids: [32], queue: [], at: 0,
        hits: new Map([['60,64,0', pos(60, 64, 0)]]),
        stageMs: {}, stageScans: {}, edge: 160, origin: pos(0, 64, 0),
      },
      kind: 'bring', name: 'gold', want: 3, by: 'P',
    }
    await advancePendingSearch(bot, {}, ctx)
    assert.ok(bot.lines.some((l) => l === 'need an iron pickaxe for gold_ore'), `lines: ${bot.lines}`)
    assert.equal(ctx.bring, old, 'old order survives the refusal')
    assert.equal(old.farCache, undefined, 'no cache grafted')
    assert.equal(old.sourceAsked, undefined, 'no ask cache grafted')
  })
})

describe('bring source helpers (idkcraft-atl.15)', () => {
  const bp = pos(0, 64, 0)

  function cand(kind, distH, extra) {
    return { kind, name: 'iron_ore', pos: pos(0, 64, 0), distH, dist: distH, cost: 0, ageMs: null, ...extra }
  }

  it('decideBringSource: only-option, clear winner, contested', () => {
    const exposed = cand('live', 40, { cost: 15 })
    const buried = cand('buried', 0, { cost: 35, depthBelow: 5 })
    assert.deepEqual(decideBringSource(exposed, null), { pick: 'exposed', why: 'only-option' })
    assert.deepEqual(decideBringSource(null, buried), { pick: 'buried', why: 'only-option' })
    assert.deepEqual(decideBringSource(exposed, buried), { pick: 'exposed', why: 'clear' })
    assert.deepEqual(decideBringSource(null, null), { pick: null, why: 'none' })
    const closeE = cand('memory', 30, { cost: 11.25 })
    const closeB = cand('buried', 0, { cost: 6, depthBelow: 3 })
    assert.deepEqual(decideBringSource(closeE, closeB), { contested: true })
    const cheapB = cand('buried', 0, { cost: 2, depthBelow: 1 })
    assert.deepEqual(decideBringSource(closeE, cheapB), { pick: 'buried', why: 'clear' })
  })

  it('decideBringSource: beyond-budget memory never wins deterministically', () => {
    const farMem = cand('memory', 170, { cost: 63.75, dist: 170 })
    const deepDig = cand('buried', 0, { cost: 145, depthBelow: 60 })
    assert.deepEqual(decideBringSource(farMem, deepDig), { contested: true })
  })

  it('memoryInBudget: far memory only against a deep shaft', () => {
    const far = cand('memory', 200, { dist: 200 })
    const near = cand('memory', 100, { dist: 100 })
    const shallow = cand('buried', 0, { depthBelow: 3 })
    const deep = cand('buried', 0, { depthBelow: 10 })
    assert.equal(memoryInBudget(far, shallow), null)
    assert.equal(memoryInBudget(far, deep), far)
    assert.equal(memoryInBudget(far, null), far)
    assert.equal(memoryInBudget(near, shallow), near)
    assert.equal(memoryInBudget(null, deep), null)
  })

  it('memoryNames expands requests like the id resolver', () => {
    const bot = mockBot({})
    assert.deepEqual(memoryNames(bot, 'iron'), ['iron_ore'])
    assert.deepEqual(memoryNames(bot, 'iron_ore'), ['iron_ore'])
    assert.deepEqual(memoryNames(bot, 'coal'), ['coal_ore'])
    assert.deepEqual(memoryNames(bot, 'logs'), [])
    const logBot = mockBot({})
    logBot.registry.blocksByName.oak_log = { id: 12 }
    assert.deepEqual(memoryNames(logBot, 'logs'), ['oak_log'])
    assert.deepEqual(memoryNames(logBot, 'oak_log'), ['oak_log'])
    assert.ok(memoryNames(bot, 'ore').includes('iron_ore'))
    assert.deepEqual(memoryNames(bot, 'unobtanium'), [])
  })

  it('memoryExposed honours skip and live validation', () => {
    const names = { '30,64,0': 'iron_ore', '31,64,0': 'air' }
    const bot = mockBot({ spots: [], names, items: PICK })
    tickerFor(bot)
    const ctx = bot._tickerCtx
    seedMemory(ctx, 30, 64, 0, 'iron_ore')
    const hit = memoryExposed(bot, ctx, bp, 'iron', null)
    assert.ok(hit)
    assert.equal(hit.kind, 'memory')
    assert.equal(hit.cost, (30 / SOURCE_COST.walkBlocksPerSec) * SOURCE_COST.memoryFactor)
    const skip = new Set(['30,64,0'])
    assert.equal(memoryExposed(bot, ctx, bp, 'iron', skip), null)
    delete names['31,64,0'] // closed up since noted
    assert.equal(memoryExposed(bot, ctx, bp, 'iron', null), null)
  })

  it('bestExposed picks the cheaper walk; live/buried builders cost honestly', () => {
    const a = liveExposed(bp, { name: 'iron_ore', position: pos(60, 64, 0), distance: 60, exposed: true })
    assert.equal(a.cost, 15)
    assert.equal(liveExposed(bp, { name: 'iron_ore', position: pos(5, 64, 0), distance: 5, exposed: false }), null)
    const b = buriedCand(bp, { name: 'iron_ore', position: pos(0, 59, 0), distance: 5, exposed: false })
    assert.equal(b.depthBelow, 5)
    assert.equal(b.cost, 5 * SOURCE_COST.digSecPerBlock + SOURCE_COST.shaftPenaltySec)
    const shallow = buriedCand(bp, { name: 'iron_ore', position: pos(0, 61, 0), distance: 3, exposed: false })
    assert.equal(shallow.cost, 3 * SOURCE_COST.digSecPerBlock)
    const mem = cand('memory', 40, { cost: 15 })
    assert.equal(bestExposed(a, mem), a)
    assert.equal(bestExposed(null, mem), mem)
    assert.equal(bestExposed(null, null), null)
  })

  it('chooseBringSource: invalid and timeout fall back with escalation; cached replays', async () => {
    const exposed = cand('memory', 30, { cost: 11.25 })
    const buried = cand('buried', 0, { cost: 6, depthBelow: 3 })
    const bad = { source: 'testmodel', ask: async () => 'dance' }
    const r1 = await chooseBringSource(bad, 'source=iron walk:11.2s dig:6.0s', exposed, buried, {})
    assert.equal(r1.action, 'walk_exposed')
    assert.equal(r1.source, 'fsm-fallback')
    const slow = { source: 'testmodel', ask: async () => { const e = new Error('slow'); e.name = 'TimeoutError'; throw e } }
    const r2 = await chooseBringSource(slow, 'facts', exposed, buried, {})
    assert.equal(r2.action, 'walk_exposed')
    assert.equal(r2.source, 'fsm-fallback')
    const spy = { calls: 0, ask: async () => { spy.calls++; return 'dig_buried' } }
    const o = { sourceAsked: true, sourcePick: 'dig_buried' }
    const r3 = await chooseBringSource(spy, 'facts', exposed, buried, o)
    assert.deepEqual([r3.action, r3.source], ['dig_buried', 'cached'])
    assert.equal(spy.calls, 0)
    const metrics = require('../src/metrics')
    const text = await metrics.client.register.metrics()
    assert.match(text, /idkcraft_bot_escalation_total\{from="testmodel",to="fsm",reason="invalid"\} [1-9]/)
    assert.match(text, /idkcraft_bot_escalation_total\{from="testmodel",to="fsm",reason="timeout"\} [1-9]/)
  })
})
