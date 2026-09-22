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

  it('uses default radius 48 and count 64 in findBlocks scan', () => {
    const bot = mockBot({ registry: NAMES })
    let opts = null
    bot.findBlocks = (o) => { opts = o; return [] }
    findNearest(bot, 'coal')
    assert.equal(opts.maxDistance, 48)
    assert.equal(opts.count, 64)
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

  it("replies with 'no <name> within 48 blocks' when none are in range", () => {
    const bot = mockBot({ registry: REG, spots: [] })
    handleChat(bot, null, 'Steve', 'find me diamond')
    assert.deepEqual(bot.lines, ['no diamond within 48 blocks'])
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

  it('ignores non-matching or multi-word messages', () => {
    const bot = mockBot({ registry: REG })
    handleChat(bot, null, 'Steve', 'find me coal ore')
    handleChat(bot, null, 'Steve', 'find me')
    handleChat(bot, null, 'Steve', 'hello bot')
    assert.deepEqual(bot.lines, [])
  })

  it("handles 'follow me' command by setting follow target on ticker and chatting confirmation", () => {
    const bot = mockBot({ registry: REG })
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
