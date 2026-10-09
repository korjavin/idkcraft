'use strict'

const { describe, it, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const { makeScout, findNearestBlock, findNearest, ORE_NAMES } = require('../src/behaviours/scout')
const { handleChat } = require('../src/index')

function pos(x, y, z) {
  const p = {
    x, y, z,
    distanceTo: (q) => Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z),
    clone() { return pos(p.x, p.y, p.z) }
  }
  return p
}

// registry: { name: id }, spots: [pos], names: { 'x,y,z': oreName }
function mockBot({ registry = {}, spots = [], names = {}, findImpl = null } = {}) {
  const lines = []
  const blocksByName = {}
  for (const [name, id] of Object.entries(registry)) blocksByName[name] = { id }
  const bot = {
    lines,
    findCalls: 0,
    entity: { position: pos(0, 64, 0) },
    registry: { blocksByName },
    findBlocks(opts) {
      bot.findCalls++
      bot.lastOpts = opts
      if (findImpl) return findImpl(opts)
      // Emulate the real client: only positions whose ore id is in the
      // requested matching list come back.
      const want = new Set(Array.isArray(opts.matching) ? opts.matching : [opts.matching])
      return spots.filter((q) => {
        const n = names[`${q.x},${q.y},${q.z}`]
        const id = n && blocksByName[n] ? blocksByName[n].id : undefined
        return want.has(id)
      })
    },
    blockAt(p) {
      const n = names[`${p.x},${p.y},${p.z}`]
      return n ? { name: n } : null
    },
    chat(line) { lines.push(line) },
  }
  return bot
}

let logs
let origLog
beforeEach(() => {
  logs = []
  origLog = console.log
  console.log = (msg) => { logs.push(String(msg)) }
})
afterEach(() => { console.log = origLog })

const REG = { diamond_ore: 56, deepslate_diamond_ore: 57, emerald_ore: 58, gold_ore: 14, iron_ore: 15, redstone_ore: 73 }

describe('scout first scan', () => {
  it('says one line per ore name with count and nearest position', () => {
    const d1 = pos(5, 10, 0)
    const d2 = pos(3, 10, 0) // nearest diamond
    const iron = pos(1, 12, 0)
    const bot = mockBot({
      registry: REG,
      spots: [d1, d2, iron],
      names: { '5,10,0': 'diamond_ore', '3,10,0': 'diamond_ore', '1,12,0': 'iron_ore' },
    })
    makeScout(bot, { everyMs: 0 }).tick()
    assert.deepEqual(bot.lines, ['diamond_ore x2 at 3 10 0', 'iron_ore x1 at 1 12 0'])
    assert.deepEqual(logs, ['scout diamond_ore x2 at 3 10 0', 'scout iron_ore x1 at 1 12 0'])
  })

  it('groups deepslate variants under the base name', () => {
    const bot = mockBot({
      registry: REG,
      spots: [pos(4, 10, 0), pos(2, 10, 0), pos(6, 10, 0)],
      names: { '4,10,0': 'deepslate_diamond_ore', '2,10,0': 'diamond_ore', '6,10,0': 'deepslate_diamond_ore' },
    })
    makeScout(bot, { everyMs: 0 }).tick()
    assert.deepEqual(bot.lines, ['diamond_ore x3 at 2 10 0'])
  })
})

describe('scout dedup', () => {
  it('second identical scan says nothing; a new position says one line', () => {
    const spots = [pos(3, 10, 0)]
    const names = { '3,10,0': 'diamond_ore' }
    const bot = mockBot({ registry: REG, spots, names })
    const scout = makeScout(bot, { everyMs: 0 })
    scout.tick()
    assert.deepEqual(bot.lines, ['diamond_ore x1 at 3 10 0'])
    scout.tick()
    assert.deepEqual(bot.lines, ['diamond_ore x1 at 3 10 0']) // no repeat
    assert.equal(bot.findCalls, 2) // scanned again, deduped by position
    spots.push(pos(4, 10, 0))
    names['4,10,0'] = 'diamond_ore'
    scout.tick()
    assert.deepEqual(bot.lines, ['diamond_ore x1 at 3 10 0', 'diamond_ore x1 at 4 10 0'])
  })

  it('clears the seen set past the cap so memory stays bounded', () => {
    const bot = mockBot({
      registry: REG,
      spots: [pos(1, 1, 1), pos(2, 2, 2), pos(3, 3, 3)],
      names: { '1,1,1': 'iron_ore', '2,2,2': 'iron_ore', '3,3,3': 'iron_ore' },
    })
    const scout = makeScout(bot, { everyMs: 0, maxSeen: 2 })
    scout.tick()
    assert.equal(bot.lines.length, 1)
    scout.tick()
    assert.equal(bot.lines.length, 2) // seen cleared -> reports again
  })
})

describe('scout rate limit', () => {
  it('no-ops until everyMs elapsed (boundary: exactly everyMs scans)', () => {
    let t = 1000000
    const bot = mockBot({ registry: REG, spots: [pos(3, 10, 0)], names: { '3,10,0': 'diamond_ore' } })
    const scout = makeScout(bot, { everyMs: 5000, now: () => t })
    scout.tick()
    assert.equal(bot.findCalls, 1)
    t += 1000
    scout.tick()
    assert.equal(bot.findCalls, 1)
    t += 4000 // exactly 5000 since last scan
    scout.tick()
    assert.equal(bot.findCalls, 2)
  })
})

describe('scout report cap', () => {
  it('says at most 3 lines per scan, highest value first, rest still marked seen', () => {
    const bot = mockBot({
      registry: REG,
      spots: [pos(1, 1, 0), pos(2, 2, 0), pos(3, 3, 0), pos(4, 4, 0), pos(5, 5, 0)],
      names: {
        '1,1,0': 'redstone_ore',
        '2,2,0': 'iron_ore',
        '3,3,0': 'gold_ore',
        '4,4,0': 'emerald_ore',
        '5,5,0': 'diamond_ore',
      },
    })
    const scout = makeScout(bot, { everyMs: 0 })
    scout.tick()
    assert.deepEqual(bot.lines, [
      'diamond_ore x1 at 5 5 0',
      'emerald_ore x1 at 4 4 0',
      'gold_ore x1 at 3 3 0',
    ])
    scout.tick()
    assert.equal(bot.lines.length, 3) // iron + redstone were capped, not re-reported
  })
})

describe('scout robustness', () => {
  it('skips registry names that are missing instead of throwing', () => {
    const bot = mockBot({
      registry: { iron_ore: 15 }, // diamond_ore and friends absent
      spots: [pos(3, 10, 0), pos(1, 12, 0)],
      names: { '3,10,0': 'diamond_ore', '1,12,0': 'iron_ore' },
    })
    assert.doesNotThrow(() => makeScout(bot, { everyMs: 0 }).tick())
    assert.deepEqual(bot.lastOpts.matching, [15])
    assert.deepEqual(bot.lines, ['iron_ore x1 at 1 12 0'])
  })

  it('empty registry matches nothing and says nothing', () => {
    const bot = mockBot({ registry: {} })
    // The real client matches nothing for an empty id list; emulate that.
    bot.findBlocks = (opts) => { bot.findCalls++; bot.lastOpts = opts; return opts.matching.length ? [pos(1, 1, 1)] : [] }
    assert.doesNotThrow(() => makeScout(bot, { everyMs: 0 }).tick())
    assert.deepEqual(bot.lastOpts.matching, [])
    assert.deepEqual(bot.lines, [])
  })

  it('skips positions where the block is gone or unreadable', () => {
    const gone = mockBot({ registry: REG, findImpl: () => [pos(9, 9, 9)] }) // blockAt -> null
    assert.doesNotThrow(() => makeScout(gone, { everyMs: 0 }).tick())
    assert.deepEqual(gone.lines, [])
    const unreadable = mockBot({ registry: REG, findImpl: () => [pos(9, 9, 9)] })
    unreadable.blockAt = () => { throw new Error('unloaded') }
    assert.doesNotThrow(() => makeScout(unreadable, { everyMs: 0 }).tick())
    assert.deepEqual(unreadable.lines, [])
  })

  it('a throwing findBlocks does not throw the tick', () => {
    const bot = mockBot({ registry: REG, findImpl() { throw new Error('no chunks') } })
    assert.doesNotThrow(() => makeScout(bot, { everyMs: 0 }).tick())
    assert.deepEqual(bot.lines, [])
  })

  it('lists the valuable ores, excluding coal and copper', () => {
    assert.ok(ORE_NAMES.includes('diamond_ore'))
    assert.ok(ORE_NAMES.includes('ancient_debris'))
    assert.ok(!ORE_NAMES.includes('coal_ore'))
    assert.ok(!ORE_NAMES.includes('copper_ore'))
  })
})

describe('scout coal goes to memory, not chat (ipn.14)', () => {
  const CREG = { ...REG, coal_ore: 16, deepslate_coal_ore: 17 }

  it('notes coal_ore in finds memory, says only the iron', () => {
    const coal = pos(3, 64, 0)
    const iron = pos(5, 60, 0)
    const bot = mockBot({ registry: CREG, spots: [coal, iron], names: { '3,64,0': 'coal_ore', '5,60,0': 'iron_ore' } })
    const ctx = {}
    makeScout(bot, { everyMs: 0, ctx }).tick()
    const names = [...ctx.resources.items.values()].map((c) => c.name).sort()
    assert.deepEqual(names, ['coal_ore', 'iron_ore'])
    assert.equal(bot.lines.length, 1)
    assert.match(bot.lines[0], /^iron_ore/)
    assert.ok(!bot.lines.some((l) => l.includes('coal')))
    assert.ok(!ORE_NAMES.includes('coal_ore'))
  })

  it('the ore scan never asks for coal, so coal cannot crowd its 64 (normal path)', () => {
    const calls = []
    const bot = mockBot({ registry: CREG, findImpl(opts) { calls.push(opts); return [] } })
    makeScout(bot, { everyMs: 0, ctx: {} }).tick()
    assert.equal(calls.length, 2)
    assert.ok(!calls[0].matching.includes(16) && !calls[0].matching.includes(17))
    assert.equal(calls[0].count, 64)
    assert.deepEqual(calls[1].matching, [16, 17])
    assert.equal(calls[1].count, 16)
  })

  it('without ctx no coal scan runs (chat-only call sites unchanged)', () => {
    const bot = mockBot({ registry: CREG, spots: [pos(3, 64, 0)], names: { '3,64,0': 'coal_ore' } })
    makeScout(bot, { everyMs: 0 }).tick()
    assert.equal(bot.findCalls, 1)
    assert.deepEqual(bot.lines, [])
  })
})

describe('findNearestBlock', () => {
  const NAMES = { coal_ore: 10, deepslate_coal_ore: 11, diamond_ore: 179, deepslate_diamond_ore: 180, iron_ore: 15 }

  it("resolves a plain name to every variant id ('coal' -> both coal ores)", () => {
    const bot = mockBot({ registry: NAMES })
    let got = null
    bot.findBlocks = (opts) => { got = opts; return [pos(8, 64, 0), pos(2, 64, 0)] }
    const best = findNearestBlock(bot, 'coal')
    assert.deepEqual(got.matching, [10, 11])
    assert.deepEqual([best.x, best.y, best.z], [2, 64, 0])
  })

  it("resolves an ore name to itself plus its deepslate variant", () => {
    const bot = mockBot({ registry: NAMES })
    let got = null
    bot.findBlocks = (opts) => { got = opts; return [] }
    assert.equal(findNearestBlock(bot, 'diamond_ore'), null)
    assert.deepEqual(got.matching, [179, 180])
  })

  it("answers 'unknown' when the name matches no block at all", () => {
    const bot = mockBot({ registry: NAMES })
    assert.equal(findNearestBlock(bot, 'xyzzy'), 'unknown')
  })

  it('returns null when the scan throws', () => {
    const bot = mockBot({ registry: NAMES })
    bot.findBlocks = () => { throw new Error('no chunks') }
    assert.equal(findNearestBlock(bot, 'coal'), null)
  })
})

describe('findNearest', () => {
  const NAMES = { coal_ore: 10, deepslate_coal_ore: 11, diamond_ore: 179, deepslate_diamond_ore: 180, iron_ore: 15 }

  it('resolves block name, calculates distance, and returns position', () => {
    const p = pos(6, 64, 8)
    const bot = mockBot({
      registry: NAMES,
      spots: [p],
      names: { '6,64,8': 'coal_ore' },
    })
    const res = findNearest(bot, 'coal')
    assert.equal(res.name, 'coal_ore')
    assert.deepEqual([res.position.x, res.position.y, res.position.z], [6, 64, 8])
    assert.equal(res.distance, 10)
  })

  it('rounds non-integral Euclidean distance to nearest integer (guards against Math.floor)', () => {
    // distance from (0, 64, 0) to (3, 64, 5) is sqrt(34) ≈ 5.83 -> rounds up to 6
    const p = pos(3, 64, 5)
    const bot = mockBot({
      registry: NAMES,
      spots: [p],
      names: { '3,64,5': 'coal_ore' },
    })
    const res = findNearest(bot, 'coal')
    assert.equal(res.distance, 6)
  })

  it('rounds non-integral Euclidean distance to nearest integer (guards against Math.ceil)', () => {
    // distance from (0, 64, 0) to (5, 64, 1) is sqrt(26) ≈ 5.10 -> rounds down to 5
    const p = pos(5, 64, 1)
    const bot = mockBot({
      registry: NAMES,
      spots: [p],
      names: { '5,64,1': 'coal_ore' },
    })
    const res = findNearest(bot, 'coal')
    assert.equal(res.distance, 5)
  })

  it('resolves nether ore variants such as nether_quartz_ore for "quartz"', () => {
    const p = pos(2, 64, 0)
    const bot = mockBot({
      registry: { ...NAMES, nether_quartz_ore: 153 },
      spots: [p],
      names: { '2,64,0': 'nether_quartz_ore' },
    })
    const res = findNearest(bot, 'quartz')
    assert.equal(res.name, 'nether_quartz_ore')
    assert.equal(res.distance, 2)
  })

  it('pads the 48 scan to cover the sphere (octahedral section walk), count 64', () => {
    const bot = mockBot({ registry: NAMES })
    let opts = null
    bot.findBlocks = (o) => { opts = o; return [] }
    findNearest(bot, 'coal')
    // ceil(48*sqrt(3)) = 84: the smallest octahedron containing the 48-sphere
    assert.equal(opts.maxDistance, 84)
    assert.equal(opts.count, 64)
  })

  it('finds ore at 100 blocks via the tick-sliced far search (amb)', () => {
    // Sync 48 is empty; the 96/160 shells run as sub-scans across ticks.
    const { startFarSearch, stepFarSearch } = require('../src/behaviours/scout')
    const ore = pos(100, 64, 0)
    const bot = mockBot({
      registry: NAMES,
      spots: [ore],
      names: {
        '100,64,0': 'iron_ore',
        '48,64,0': 'stone', '96,64,0': 'stone', '128,64,0': 'stone', '160,64,0': 'stone',
      },
    })
    assert.equal(findNearest(bot, 'iron'), null, 'sync 48 misses it')
    const inner = bot.findBlocks.bind(bot)
    bot.findBlocks = (o) => {
      // Emulate the real client: only hits near the scan center come back.
      const c = o.point || { x: 0, y: 64, z: 0 }
      return inner(o).filter((q) => Math.hypot(q.x - c.x, q.y - c.y, q.z - c.z) <= o.maxDistance)
    }
    const cursor = startFarSearch(bot, 'iron')
    assert.ok(cursor && cursor !== 'unknown', 'far search starts')
    let r = { done: false, result: null }
    for (let i = 0; i < 200 && !r.done; i++) r = stepFarSearch(bot, cursor)
    assert.ok(r.done, 'cursor completes')
    assert.ok(r.result, 'ore at 100 blocks must be found')
    assert.equal(r.result.distance, 100)
  })

  it('filters sync hits beyond the claimed 48 (amb review)', () => {
    // A hit inside the padded octahedron but outside the 48-sphere must not
    // count: the stage stays empty and the answer stays honest.
    const bot = mockBot({ registry: NAMES, spots: [pos(60, 64, 0)], names: { '60,64,0': 'iron_ore' } })
    assert.equal(findNearest(bot, 'iron'), null)
  })

  it('stops after the 48 stage when a nearby vein exists (no extra scans)', () => {
    const radii = []
    const bot = mockBot({ registry: NAMES, spots: [pos(10, 64, 0)], names: { '10,64,0': 'iron_ore' } })
    const inner = bot.findBlocks.bind(bot)
    bot.findBlocks = (o) => { radii.push(o.maxDistance); return inner(o) }
    const res = findNearest(bot, 'iron')
    assert.equal(res.distance, 10)
    assert.deepEqual(radii, [84])
  })

  it('slices the queue across steps under the tick budget (amb)', () => {
    // Fake clock: each sub-scan costs 100ms; the 120ms budget fits 2.
    const { performance } = require('node:perf_hooks')
    const { startFarSearch, stepFarSearch } = require('../src/behaviours/scout')
    const realNow = performance.now
    let t = 0
    performance.now = () => t
    try {
      const bot = mockBot({
        registry: NAMES,
        spots: [],
        names: { '48,64,0': 'stone', '96,64,0': 'stone', '128,64,0': 'stone', '160,64,0': 'stone' },
      })
      bot.findBlocks = () => { t += 100; return [] }
      const cursor = startFarSearch(bot, 'iron')
      assert.ok(cursor && cursor.queue.length === 78)
      const r = stepFarSearch(bot, cursor)
      assert.equal(r.done, false)
      assert.equal(cursor.at, 2, 'third scan would exceed the budget')
    } finally {
      performance.now = realNow
    }
  })

  it('stops after ring 70 when a hit within 96 exists (amb)', () => {
    const { startFarSearch, stepFarSearch } = require('../src/behaviours/scout')
    const ore = pos(90, 64, 0)
    const bot = mockBot({
      registry: NAMES,
      spots: [ore],
      names: {
        '90,64,0': 'iron_ore',
        '48,64,0': 'stone', '96,64,0': 'stone', '128,64,0': 'stone', '160,64,0': 'stone',
      },
    })
    let calls = 0
    const inner = bot.findBlocks.bind(bot)
    bot.findBlocks = (o) => {
      calls++
      const c = o.point || { x: 0, y: 64, z: 0 }
      return inner(o).filter((q) => Math.hypot(q.x - c.x, q.y - c.y, q.z - c.z) <= o.maxDistance)
    }
    const cursor = startFarSearch(bot, 'iron')
    let r = { done: false, result: null }
    for (let i = 0; i < 200 && !r.done; i++) r = stepFarSearch(bot, cursor)
    assert.ok(r.done && r.result, 'ore at 90 found')
    assert.equal(calls, 26, 'ring 110/150 never scanned')
  })

  it('ends early on one exposed hit, scans on for buried-only (amb)', () => {
    const { performance } = require('node:perf_hooks')
    const { startFarSearch, stepFarSearch } = require('../src/behaviours/scout')
    const realNow = performance.now
    const PROBES = { '48,64,0': 'stone', '96,64,0': 'stone', '128,64,0': 'stone', '160,64,0': 'stone' }
    function centerAware(bot) {
      const inner = bot.findBlocks.bind(bot)
      bot.findBlocks = (o) => {
        const c = o.point || { x: 0, y: 64, z: 0 }
        return inner(o).filter((q) => Math.hypot(q.x - c.x, q.y - c.y, q.z - c.z) <= o.maxDistance)
      }
    }
    let t = 0
    performance.now = () => t
    try {
      // Exposed vein at 60: first tick with a hit answers.
      const open = mockBot({ registry: NAMES, spots: [pos(60, 64, 0)], names: { ...PROBES, '60,64,0': 'iron_ore', '61,64,0': 'air' } })
      centerAware(open)
      const c1 = startFarSearch(open, 'iron')
      let r1 = { done: false, result: null }
      let n1 = 0
      for (let i = 0; i < 200 && !r1.done; i++) { r1 = stepFarSearch(open, c1); n1++ }
      assert.ok(r1.done && r1.result, 'exposed vein found')
      assert.ok(n1 < 13, `early exit, not the full ring (steps=${n1})`)
      // Buried-only: no early exit, ring 70 runs out, then fast-forward.
      t = 0
      const shut = mockBot({ registry: NAMES, spots: [pos(60, 64, 0)], names: { ...PROBES, '60,64,0': 'iron_ore' } })
      let calls = 0
      const inner = shut.findBlocks.bind(shut)
      shut.findBlocks = (o) => {
        calls++
        t += 100
        const c = o.point || { x: 0, y: 64, z: 0 }
        return inner(o).filter((q) => Math.hypot(q.x - c.x, q.y - c.y, q.z - c.z) <= o.maxDistance)
      }
      const c2 = startFarSearch(shut, 'iron')
      let r2 = { done: false, result: null }
      for (let i = 0; i < 200 && !r2.done; i++) r2 = stepFarSearch(shut, c2)
      assert.ok(r2.done && r2.result, 'buried vein still found')
      assert.equal(calls, 26, 'full ring 70, then fast-forward past 110/150')
    } finally {
      performance.now = realNow
    }
  })

  it('unrelated logoff keeps the pending search, asker logoff retires it (amb)', () => {
    const { createTicker, handlePlayerLeft } = require('../src/index')
    const bot = mockBot({
      registry: REG,
      spots: [],
      names: { '48,64,0': 'stone', '96,64,0': 'stone', '128,64,0': 'stone', '160,64,0': 'stone' },
    })
    const ticker = createTicker({
      bot,
      brain: { decide: async () => ({ action: 'idle', sprint: false, source: 'stub' }) },
      tickMs: 10, idleTickMs: 10,
    })
    handleChat(bot, ticker, 'Steve', 'find me diamond')
    assert.ok(bot._tickerCtx.pendingSearch, 'search pending')
    handlePlayerLeft(bot, ticker, { username: 'Alex' })
    assert.ok(bot._tickerCtx.pendingSearch, 'unrelated logoff keeps it')
    handlePlayerLeft(bot, ticker, { username: 'Steve' })
    assert.equal(bot._tickerCtx.pendingSearch, null, 'asker logoff retires it')
  })

  it('pauses far slices while hostiles are near (amb)', () => {
    const { advancePendingSearch } = require('../src/index')
    const bot = mockBot({
      registry: REG,
      spots: [],
      names: { '48,64,0': 'stone', '96,64,0': 'stone', '128,64,0': 'stone', '160,64,0': 'stone' },
    })
    bot._tickerCtx = {}
    handleChat(bot, { setLead() {} }, 'Steve', 'find me diamond')
    const ctx = bot._tickerCtx
    assert.ok(ctx.pendingSearch, 'search pending')
    ctx.lastHostileSnap = { count: 2, name: 'zombie', dist: 5 }
    advancePendingSearch(bot, {}, ctx)
    assert.ok(ctx.pendingSearch, 'still pending under hostiles')
    assert.equal(ctx.pendingSearch.cursor.at, 0, 'no progress under hostiles')
    ctx.lastHostileSnap = { count: 0, name: null, dist: null }
    advancePendingSearch(bot, {}, ctx)
    assert.equal(ctx.pendingSearch, null, 'completes when clear (instant mocks)')
    assert.ok(bot.lines.includes('no diamond within 160 blocks (loaded area)'), `lines: ${bot.lines}`)
  })

  it('reports the loaded boundary from blockAt probes', () => {
    const { loadedSearchRadius } = require('../src/behaviours/scout')
    const dark = mockBot({ registry: NAMES })
    assert.equal(loadedSearchRadius(dark), 48) // nothing readable: old behaviour
    const half = mockBot({ registry: NAMES, names: { '48,64,0': 'stone', '96,64,0': 'stone' } })
    assert.equal(loadedSearchRadius(half), 96)
    half.blockAt = () => { throw new Error('unloaded') }
    assert.equal(loadedSearchRadius(half), 48) // throws: never 0, never throw
  })

  it('returns null when no matching blocks are within range', () => {
    const bot = mockBot({ registry: NAMES, spots: [] })
    assert.equal(findNearest(bot, 'diamond'), null)
  })

  it("returns 'unknown' when block is not in registry", () => {
    const bot = mockBot({ registry: NAMES })
    assert.equal(findNearest(bot, 'xyzzy'), 'unknown')
  })
})

describe('findNearestBlock exposure ranking', () => {
  const NAMES = { gold_ore: 14, deepslate_gold_ore: 15 }

  it('exposed ore wins over nearer buried ore', () => {
    const buried = pos(2, 60, 0)
    const exposed = pos(8, 60, 0)
    const bot = mockBot({
      registry: NAMES,
      spots: [buried, exposed],
      names: { '2,60,0': 'gold_ore', '8,60,0': 'gold_ore', '9,60,0': 'air' },
    })
    const best = findNearestBlock(bot, 'gold')
    assert.deepEqual([best.x, best.y, best.z], [8, 60, 0]) // farther but walkable
  })

  it("among exposed, closer in height to the player's Y wins over nearer", () => {
    const playerLevel = pos(25, 40, 0) // dy 0 to refY, dist ~34.7
    const botLevel = pos(5, 64, 0) // dy 24 to refY, dist 5 (nearer)
    const bot = mockBot({
      registry: NAMES,
      spots: [playerLevel, botLevel],
      names: {
        '25,40,0': 'gold_ore', '26,40,0': 'air',
        '5,64,0': 'gold_ore', '6,64,0': 'air',
      },
    })
    const best = findNearestBlock(bot, 'gold', 48, 40)
    assert.deepEqual([best.x, best.y, best.z], [25, 40, 0])
  })

  it("cave air counts as exposed (ravine and carver-cave walls)", () => {
    const bot = mockBot({
      registry: NAMES,
      spots: [pos(2, 60, 0), pos(8, 60, 0)],
      names: { '2,60,0': 'gold_ore', '8,60,0': 'gold_ore', '9,60,0': 'cave_air' },
    })
    const best = findNearestBlock(bot, 'gold')
    assert.deepEqual([best.x, best.y, best.z], [8, 60, 0])
  })

  it('unreadable neighbours count as buried, never throw', () => {
    const bot = mockBot({ registry: NAMES, spots: [pos(2, 60, 0)], names: { '2,60,0': 'gold_ore' } })
    bot.blockAt = () => { throw new Error('unloaded') }
    const best = findNearestBlock(bot, 'gold')
    assert.deepEqual([best.x, best.y, best.z], [2, 60, 0])
  })
})

describe("chat command 'find me <block>'", () => {
  const REG = {
    coal_ore: 10,
    deepslate_coal_ore: 11,
    diamond_ore: 179,
    deepslate_diamond_ore: 180,
    iron_ore: 15,
  }

  it("announces the lead order when a block is found", () => {
    const coalPos = pos(6, 64, 8)
    const bot = mockBot({
      registry: REG,
      spots: [coalPos],
      names: { '6,64,8': 'coal_ore' },
    })
    handleChat(bot, null, 'Steve', 'find me coal')
    assert.deepEqual(bot.lines, ['leading you to coal_ore, 10 blocks, follow me'])
  })

  it("replies with 'no <name> within <r> blocks (loaded area)' when none are in range", () => {
    const bot = mockBot({ registry: REG, spots: [] })
    handleChat(bot, null, 'Steve', 'find me diamond')
    // Mock world probes unreadable: boundary falls back to 48.
    assert.deepEqual(bot.lines, ['no diamond within 48 blocks (loaded area)'])
  })

  it('widens past 48 and answers the loaded boundary after ticks (amb)', () => {
    const { advancePendingSearch } = require('../src/index')
    const bot = mockBot({
      registry: REG,
      spots: [],
      names: { '48,64,0': 'stone', '96,64,0': 'stone', '128,64,0': 'stone', '160,64,0': 'stone' },
    })
    bot._tickerCtx = {}
    const ticker = { setLead: () => {} }
    handleChat(bot, ticker, 'Steve', 'find me diamond')
    assert.deepEqual(bot.lines, ['nothing within 48, widening the search for diamond…'])
    for (let i = 0; i < 200 && bot._tickerCtx.pendingSearch; i++) {
      advancePendingSearch(bot, ticker, bot._tickerCtx)
    }
    assert.deepEqual(bot.lines, [
      'nothing within 48, widening the search for diamond…',
      'no diamond within 160 blocks (loaded area)',
    ])
  })

  it("replies with 'unknown block: <name>' when block name is unrecognized", () => {
    const bot = mockBot({ registry: REG })
    handleChat(bot, null, 'Steve', 'find me xyzzy')
    assert.deepEqual(bot.lines, ['unknown block: xyzzy'])
  })

  it('is case-insensitive and trims input', () => {
    const coalPos = pos(6, 64, 8)
    const bot = mockBot({
      registry: REG,
      spots: [coalPos],
      names: { '6,64,8': 'coal_ore' },
    })
    handleChat(bot, null, 'Steve', '  FIND ME COAL  ')
    assert.deepEqual(bot.lines, ['leading you to coal_ore, 10 blocks, follow me'])
  })

  it('does not move the bot when answering the command', () => {
    const coalPos = pos(6, 64, 8)
    const bot = mockBot({
      registry: REG,
      spots: [coalPos],
      names: { '6,64,8': 'coal_ore' },
    })
    const before = [bot.entity.position.x, bot.entity.position.y, bot.entity.position.z]
    handleChat(bot, null, 'Steve', 'find me coal')
    const after = [bot.entity.position.x, bot.entity.position.y, bot.entity.position.z]
    assert.deepEqual(after, before)
  })

  it('ignores messages sent by the bot itself', () => {
    const bot = mockBot({ registry: REG })
    bot.username = 'IdkBot'
    handleChat(bot, null, 'IdkBot', 'find me coal')
    assert.deepEqual(bot.lines, [])
  })

  it('hints usage for an incomplete find me, ignores chatter', () => {
    const bot = mockBot({ registry: REG })
    handleChat(bot, null, 'Steve', 'find me coal ore')
    handleChat(bot, null, 'Steve', 'find me')
    handleChat(bot, null, 'Steve', 'hello bot')
    // 'find me coal ore' and bare 'find me' name the command but carry no
    // usable block (kae): hint instead of silence; chatter stays silent.
    assert.deepEqual(bot.lines, ['try: find me iron', 'try: find me iron'])
  })

  const GREG = { ...REG, gold_ore: 14, deepslate_gold_ore: 15 }

  it("warns instead of leading when the ore is deep below the player", () => {
    const goldPos = pos(6, 35, 0)
    const bot = mockBot({
      registry: GREG,
      spots: [goldPos],
      names: { '6,35,0': 'gold_ore', '7,35,0': 'air' },
    })
    bot.players = { Steve: { entity: { position: pos(0, 66, 0) } } }
    const leads = []
    const ticker = { setLead(order) { leads.push(order) } }
    handleChat(bot, ticker, 'Steve', 'find me gold')
    assert.deepEqual(bot.lines, ['gold_ore is 31 blocks down, dig carefully'])
    assert.deepEqual(leads, []) // no lead order on a deep target
  })

  it("leads a deep target only on 'lead anyway', once", () => {
    const goldPos = pos(6, 35, 0)
    const bot = mockBot({
      registry: GREG,
      spots: [goldPos],
      names: { '6,35,0': 'gold_ore', '7,35,0': 'air' },
    })
    bot.players = { Steve: { entity: { position: pos(0, 66, 0) } } }
    const leads = []
    const ticker = { setLead(order) { leads.push(order) } }
    handleChat(bot, ticker, 'Steve', 'find me gold')
    assert.equal(leads.length, 0)
    handleChat(bot, ticker, 'Steve', 'lead anyway')
    assert.deepEqual(bot.lines[1], 'leading you to gold_ore, 30 blocks, follow me')
    assert.equal(leads.length, 1)
    assert.deepEqual([leads[0].pos.x, leads[0].pos.y, leads[0].pos.z], [6, 35, 0])
    handleChat(bot, ticker, 'Steve', 'lead anyway')
    assert.deepEqual(bot.lines[2], 'no deep find on hold — ask me to find something first')
    assert.equal(leads.length, 1) // offer cleared on use
  })

  it('leads normally at exactly 8 blocks down (boundary)', () => {
    const goldPos = pos(6, 56, 0)
    const bot = mockBot({
      registry: GREG,
      spots: [goldPos],
      names: { '6,56,0': 'gold_ore' },
    })
    bot.players = { Steve: { entity: { position: pos(0, 64, 0) } } }
    handleChat(bot, null, 'Steve', 'find me gold')
    assert.deepEqual(bot.lines, ['leading you to gold_ore, 10 blocks, follow me'])
  })

  it("warns on a deep target even with no speaker entity (bot Y fallback)", () => {
    const goldPos = pos(6, 35, 0)
    const bot = mockBot({
      registry: GREG,
      spots: [goldPos],
      names: { '6,35,0': 'gold_ore', '7,35,0': 'air' },
    })
    // no bot.players: speaker out of tracking range, bot at y 64
    const leads = []
    const ticker = { setLead(order) { leads.push(order) } }
    handleChat(bot, ticker, 'Steve', 'find me gold')
    assert.deepEqual(bot.lines, ['gold_ore is 29 blocks down, dig carefully'])
    assert.deepEqual(leads, [])
  })

  it("'find me ores' finds ore like 'find me ore'", () => {
    const oreReg = { diamond_ore: 179, iron_ore: 15 }
    const bot = mockBot({
      registry: oreReg,
      spots: [pos(3, 64, 0)],
      names: { '3,64,0': 'iron_ore' },
    })
    handleChat(bot, null, 'Steve', 'find me ores')
    assert.deepEqual(bot.lines, ['leading you to iron_ore, 3 blocks, follow me'])
  })

  it("'find me ore' finds the nearest ore of any kind", () => {
    const oreReg = { diamond_ore: 179, iron_ore: 15, gold_ore: 14 }
    const bot = mockBot({
      registry: oreReg,
      spots: [pos(10, 64, 0), pos(3, 64, 0)],
      names: { '10,64,0': 'diamond_ore', '3,64,0': 'iron_ore' },
    })
    handleChat(bot, null, 'Steve', 'find me ore')
    assert.deepEqual(bot.lines, ['leading you to iron_ore, 3 blocks, follow me'])
  })

  it("resolves simple plurals ('diamonds') but keeps typos unknown", () => {
    const bot = mockBot({
      registry: REG,
      spots: [pos(4, 64, 0)],
      names: { '4,64,0': 'diamond_ore' },
    })
    handleChat(bot, null, 'Steve', 'find me diamonds')
    assert.deepEqual(bot.lines, ['leading you to diamond_ore, 4 blocks, follow me'])
    handleChat(bot, null, 'Steve', 'find me diamand')
    assert.deepEqual(bot.lines[1], 'unknown block: diamand')
  })

  it("handles 'follow me' command by setting follow target on ticker and chatting confirmation", () => {
    const bot = mockBot({ registry: REG })
    bot.players = { Steve: { username: 'Steve', entity: { position: pos(10, 64, 0) } } }
    const calls = []
    const ticker = {
      setFollow(name) { calls.push(['setFollow', name]) },
      stop() { calls.push(['stop']) },
    }
    handleChat(bot, ticker, 'Steve', 'follow me')
    assert.deepEqual(calls, [['setFollow', 'Steve']])
    assert.deepEqual(bot.lines, ['Following Steve'])
  })

  it("handles 'stop' command by clearing follow target and stopping ticker", () => {
    const bot = mockBot({ registry: REG })
    const calls = []
    const ticker = {
      setFollow(name) { calls.push(['setFollow', name]) },
      stop() { calls.push(['stop']) },
    }
    handleChat(bot, ticker, 'Steve', 'stop')
    assert.deepEqual(calls, [['setFollow', ''], ['stop']])
  })
})

describe('far search exposed mode (idkcraft-atl.19)', () => {
  const NAMES = { iron_ore: 15, stone: 1 }
  const PROBES = { '48,64,0': 'stone', '96,64,0': 'stone', '128,64,0': 'stone', '160,64,0': 'stone' }

  function centerAware(bot) {
    const inner = bot.findBlocks.bind(bot)
    bot.findBlocks = (o) => {
      const c = o.point || { x: 0, y: 64, z: 0 }
      return inner(o).filter((q) => Math.hypot(q.x - c.x, q.y - c.y, q.z - c.z) <= o.maxDistance)
    }
  }

  function run(bot, cursor, opts) {
    const { stepFarSearch } = require('../src/behaviours/scout')
    let r = { done: false, result: null }
    for (let i = 0; i < 200 && !r.done; i++) r = stepFarSearch(bot, cursor, opts)
    return r
  }

  it('exposed mode: buried at 60 + exposed at 120 → (a) exposed, (c) buried', () => {
    const { startFarSearch } = require('../src/behaviours/scout')
    const bot = mockBot({
      registry: NAMES,
      spots: [pos(60, 64, 0), pos(120, 64, 0)],
      names: { ...PROBES, '60,64,0': 'iron_ore', '120,64,0': 'iron_ore', '121,64,0': 'air' },
    })
    const cursor = startFarSearch(bot, 'iron', null, { exposedOnly: true })
    assert.equal(cursor.exposedOnly, true)
    const r = run(bot, cursor)
    assert.ok(r.done)
    assert.ok(r.result, 'exposed vein at 120 must be found')
    assert.deepEqual([r.result.position.x, r.result.position.z], [120, 0])
    assert.equal(r.result.exposed, true)
    assert.ok(r.buried, 'the buried second pass feeds candidate (c)')
    assert.deepEqual([r.buried.position.x, r.buried.position.z], [60, 0])
    assert.equal(r.buried.exposed, false)
  })

  it('default mode on the same world: buried at 60 wins, exposed at 120 dropped', () => {
    const { startFarSearch } = require('../src/behaviours/scout')
    const bot = mockBot({
      registry: NAMES,
      spots: [pos(60, 64, 0), pos(120, 64, 0)],
      names: { ...PROBES, '60,64,0': 'iron_ore', '120,64,0': 'iron_ore', '121,64,0': 'air' },
    })
    const cursor = startFarSearch(bot, 'iron')
    assert.ok(!cursor.exposedOnly, 'default stays off')
    const r = run(bot, cursor)
    assert.ok(r.done && r.result)
    assert.deepEqual([r.result.position.x, r.result.position.z], [60, 0])
    assert.ok(!('buried' in r), 'default result shape unchanged')
  })

  it('exposed mode keeps the rings open past buried ore (farShellDone)', () => {
    // Center-aware world: the exposed vein sits in a ring-70 corner gap
    // (>88 from every ring-70 center), so only ring 110+ collects it.
    const { startFarSearch } = require('../src/behaviours/scout')
    const world = () => {
      const bot = mockBot({
        registry: NAMES,
        spots: [pos(60, 64, 0), pos(139, 64, 57)],
        names: { ...PROBES, '60,64,0': 'iron_ore', '139,64,57': 'iron_ore', '140,64,57': 'air' },
      })
      centerAware(bot)
      return bot
    }
    const open = world()
    const r1 = run(open, startFarSearch(open, 'iron', null, { exposedOnly: true }))
    assert.ok(r1.done && r1.result, 'rings stay open: exposed at 150 found')
    assert.deepEqual([r1.result.position.x, r1.result.position.z], [139, 57])
    const shut = world()
    const r2 = run(shut, startFarSearch(shut, 'iron'))
    assert.ok(r2.done && r2.result)
    assert.deepEqual([r2.result.position.x, r2.result.position.z], [60, 0], 'default closes ring 70 on buried ore')
  })

  it('stepFarSearch opts can opt a default cursor into exposed mode', () => {
    const { startFarSearch } = require('../src/behaviours/scout')
    const bot = mockBot({
      registry: NAMES,
      spots: [pos(60, 64, 0), pos(120, 64, 0)],
      names: { ...PROBES, '60,64,0': 'iron_ore', '120,64,0': 'iron_ore', '121,64,0': 'air' },
    })
    const r = run(bot, startFarSearch(bot, 'iron'), { exposedOnly: true })
    assert.ok(r.done && r.result)
    assert.deepEqual([r.result.position.x, r.result.position.z], [120, 0])
  })

  it('exposed mode with nothing found: null result and null buried', () => {
    const { startFarSearch } = require('../src/behaviours/scout')
    const bot = mockBot({ registry: NAMES, spots: [], names: { ...PROBES } })
    const r = run(bot, startFarSearch(bot, 'iron', null, { exposedOnly: true }))
    assert.ok(r.done)
    assert.equal(r.result, null)
    assert.equal(r.buried, null)
  })
})

describe('scout ranking edges (idkcraft-l71)', () => {
  it('unknown ore base ranks last in the report', () => {
    // A remapped registry names an id outside ORE_NAMES: rankOf falls back
    // to the list length, so known ores report first, no crash.
    const d = pos(3, 10, 0)
    const c = pos(30, 10, 0)
    const bot = mockBot({
      registry: { diamond_ore: 179, iron_ore: 15 },
      spots: [c, d], // copper first: only the fallback rank moves it last
      names: { '3,10,0': 'diamond_ore', '30,10,0': 'iron_ore' },
    })
    const raw = bot.blockAt.bind(bot)
    bot.blockAt = (p) => (p.x === 30 ? { name: 'copper_ore' } : raw(p))
    makeScout(bot, { everyMs: 0 }).tick()
    assert.deepEqual(bot.lines, ['diamond_ore x1 at 3 10 0', 'copper_ore x1 at 30 10 0'])
  })

  it('completion trims past 64 hits to the nearest, plain positions meter by hypot', () => {
    const { startFarSearch, stepFarSearch } = require('../src/behaviours/scout')
    const bot = mockBot({
      registry: { coal_ore: 10 },
      names: { '48,64,0': 'stone', '96,64,0': 'stone', '128,64,0': 'stone', '160,64,0': 'stone', '80,65,0': 'air' },
    })
    bot.entity.position = { x: 0, y: 64, z: 0 } // plain: clonePos and dist fall back
    const cursor = startFarSearch(bot, 'coal')
    assert.ok(cursor && cursor !== 'unknown')
    assert.deepEqual(cursor.origin, { x: 0, y: 64, z: 0 })
    for (let x = 5; x < 75; x++) cursor.hits.set(`${x},64,0`, { x, y: 64, z: 0 })
    cursor.hits.set('80,64,0', { x: 80, y: 64, z: 0 }) // exposed, past the 64-nearest window
    cursor.at = cursor.queue.length
    const r = stepFarSearch(bot, cursor)
    assert.equal(r.done, true)
    assert.equal(r.result.name, 'coal')
    assert.deepEqual([r.result.position.x, r.result.position.z], [5, 0])
    assert.equal(r.result.distance, 5)
  })

  it('walked-off bot rebuilds the cursor at the live origin', () => {
    const { startFarSearch, stepFarSearch } = require('../src/behaviours/scout')
    const bot = mockBot({
      registry: { coal_ore: 10 },
      names: {
        '48,64,0': 'stone', '96,64,0': 'stone', '128,64,0': 'stone', '160,64,0': 'stone',
        '248,64,0': 'stone', '296,64,0': 'stone', '328,64,0': 'stone', '360,64,0': 'stone',
      },
      findImpl: () => [],
    })
    const cursor = startFarSearch(bot, 'coal')
    assert.ok(cursor && cursor !== 'unknown')
    // Same loaded edge at the new spot: only the walked-off distance rebuilds.
    bot.entity.position = { x: 200, y: 64, z: 0 } // walked past SEARCH_FIRST
    const r = stepFarSearch(bot, cursor)
    assert.deepEqual(cursor.origin, { x: 200, y: 64, z: 0 })
    assert.equal(r.done, true)
    assert.equal(r.result, null)
  })

  it('throwing findBlocks skips the ring instead of failing', () => {
    const { startFarSearch, stepFarSearch } = require('../src/behaviours/scout')
    let n = 0
    const bot = mockBot({
      registry: { coal_ore: 10 },
      names: { '48,64,0': 'stone', '96,64,0': 'stone', '128,64,0': 'stone', '160,64,0': 'stone' },
      findImpl: () => { n++; if (n === 1) throw new Error('chunk busy'); return n === 2 ? [{ x: 60, y: 64, z: 0 }] : [] },
    })
    const cursor = startFarSearch(bot, 'coal')
    assert.ok(cursor && cursor !== 'unknown')
    let r = { done: false, result: null }
    for (let i = 0; i < 200 && !r.done; i++) r = stepFarSearch(bot, cursor)
    assert.equal(r.done, true)
    assert.ok(r.result, 'later rings still run after the throw')
    assert.deepEqual([r.result.position.x, r.result.position.z], [60, 0])
  })

  it('throwing blockAt keeps the requested name', () => {
    const bot = mockBot({ registry: { iron_ore: 15 }, findImpl: () => [pos(5, 64, 0)] })
    bot.blockAt = () => { throw new Error('unloaded') }
    const r = findNearest(bot, 'iron')
    assert.equal(r.name, 'iron')
    assert.equal(r.exposed, false)
  })
})

describe('findNearestBlock full-pool rescan (idkcraft-chv)', () => {
  const NAMES = { iron_ore: 15, deepslate_iron_ore: 16 }

  // Walk-order pool: 80 deep-far decoys (walk order = array order in the
  // mock), then one shallow vein the count-64 cut never sees. Every decoy
  // is past both gate axes (dy 24, distH 21+), so the cheap winner rescans.
  function richGround() {
    const spots = []
    const names = {}
    for (let x = 21; x <= 40; x++) {
      for (let z = 0; z <= 3; z++) {
        spots.push(pos(x, 40, z))
        names[`${x},40,${z}`] = 'iron_ore'
      }
    }
    spots.push(pos(10, 60, 0))
    names['10,60,0'] = 'iron_ore'
    return { spots, names }
  }

  function countHonoringBot(spots, names) {
    return mockBot({
      registry: NAMES,
      findImpl: (opts) => {
        const n = typeof opts.count === 'number' ? opts.count : 64
        return spots.slice(0, n)
      },
      names,
    })
  }

  it('a deep-buried cheap winner rescans and the shallow full-pool hit wins', () => {
    const { spots, names } = richGround()
    const bot = countHonoringBot(spots, names)
    const best = findNearestBlock(bot, 'iron')
    assert.deepEqual([best.x, best.y, best.z], [10, 60, 0])
    assert.equal(bot.findCalls, 2, 'cheap scan plus one full-pool rescan')
    assert.ok(bot.lastOpts.count > 64, `rescan count: ${bot.lastOpts.count}`)
    assert.ok(logs.some((l) => l.includes('r=48 full')), `logs: ${logs}`)
  })

  it('a shallow buried winner never rescans', () => {
    const bot = mockBot({ registry: NAMES, spots: [pos(10, 60, 0)], names: { '10,60,0': 'iron_ore' } })
    const best = findNearestBlock(bot, 'iron')
    assert.deepEqual([best.x, best.y, best.z], [10, 60, 0])
    assert.equal(bot.findCalls, 1)
  })

  it('an exposed winner never rescans, however deep', () => {
    const bot = mockBot({
      registry: NAMES,
      spots: [pos(10, 40, 0)],
      names: { '10,40,0': 'iron_ore', '11,40,0': 'air' },
    })
    const best = findNearestBlock(bot, 'iron')
    assert.deepEqual([best.x, best.y, best.z], [10, 40, 0])
    assert.equal(bot.findCalls, 1)
  })

  it('gate boundary: 12 down skips the rescan, 13 down rescans', () => {
    const even = mockBot({ registry: NAMES, spots: [pos(25, 52, 0)], names: { '25,52,0': 'iron_ore' } })
    findNearestBlock(even, 'iron')
    assert.equal(even.findCalls, 1, 'depth 12 is diggable, no rescan')
    const odd = mockBot({ registry: NAMES, spots: [pos(25, 51, 0)], names: { '25,51,0': 'iron_ore' } })
    findNearestBlock(odd, 'iron')
    assert.equal(odd.findCalls, 2, 'depth 13 rescans')
  })

  it('gate boundary: a deep shaft inside distH 20 never rescans (S4 steep dig)', () => {
    const near = mockBot({ registry: NAMES, spots: [pos(19, 40, 0)], names: { '19,40,0': 'iron_ore' } })
    findNearestBlock(near, 'iron')
    assert.equal(near.findCalls, 1, 'distH 19 digs without a rescan')
    const far = mockBot({ registry: NAMES, spots: [pos(20, 40, 0)], names: { '20,40,0': 'iron_ore' } })
    const best = findNearestBlock(far, 'iron')
    assert.equal(far.findCalls, 2, 'distH 20 rescans')
    assert.deepEqual([best.x, best.y, best.z], [20, 40, 0])
  })

  it('a throwing rescan keeps the cheap winner', () => {
    const { spots, names } = richGround()
    const bot = mockBot({
      registry: NAMES,
      findImpl: (opts) => {
        if (opts.count > 64) throw new Error('chunk busy')
        return spots.slice(0, opts.count)
      },
      names,
    })
    const best = findNearestBlock(bot, 'iron')
    assert.deepEqual([best.x, best.y, best.z], [21, 40, 0])
  })

  it('the rescan honors the skip filter', () => {
    const { spots, names } = richGround()
    const bot = countHonoringBot(spots, names)
    const best = findNearestBlock(bot, 'iron', null, (q) => q.x === 10 && q.y === 60)
    // The shallow rival is skipped: the deep cheap winner stands, gated
    // downstream by the bring verdict instead of here.
    assert.deepEqual([best.x, best.y, best.z], [21, 40, 0])
  })
})

describe('rankHits diggable-first (idkcraft-chv revmux 01)', () => {
  const NAMES = { iron_ore: 15, deepslate_iron_ore: 16 }
  // A: gated-but-shallower (dy 13, distH 25); B: diggable deep-near
  // (dy 24, distH 5). The gate key outranks dy in every pool.
  const A = pos(25, 51, 0)
  const B = pos(5, 40, 0)
  const NAMES_AB = { '25,51,0': 'iron_ore', '5,40,0': 'iron_ore' }

  it('a diggable deep-near vein beats a gated shallower one in the cheap pool', () => {
    const bot = mockBot({ registry: NAMES, spots: [A, B], names: NAMES_AB })
    const best = findNearestBlock(bot, 'iron')
    assert.deepEqual([best.x, best.y, best.z], [5, 40, 0])
    assert.equal(bot.findCalls, 1, 'diggable winner needs no rescan')
  })

  it('the rescan ranks the full pool diggable-first too', () => {
    const spots = []
    const names = { ...NAMES_AB }
    for (let x = 21; x <= 40; x++) {
      for (let z = 0; z <= 3; z++) {
        spots.push(pos(x, 40, z))
        names[`${x},40,${z}`] = 'iron_ore'
      }
    }
    spots.push(A, B) // past the count-64 cut, like the S3 geometry
    const bot = mockBot({
      registry: NAMES,
      findImpl: (opts) => spots.slice(0, typeof opts.count === 'number' ? opts.count : 64),
      names,
    })
    const best = findNearestBlock(bot, 'iron')
    assert.deepEqual([best.x, best.y, best.z], [5, 40, 0])
    assert.equal(bot.findCalls, 2)
    assert.ok(logs.some((l) => l.includes('r=48 full')), `logs: ${logs}`)
  })
})
