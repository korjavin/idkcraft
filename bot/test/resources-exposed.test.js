'use strict'

// Finds memory exposed flag (idkcraft-atl.16): cells carry exposed at note
// time, the flag + at survive save/restore, pre-flag files read as
// exposed undefined, and the scout tick feeds what the bot walks past.

const { describe, it, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const resources = require('../src/resources')
const memory = require('../src/memory')
const { makeScout } = require('../src/behaviours/scout')

function pos(x, y, z) {
  const p = {
    x, y, z,
    distanceTo: (q) => Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z),
    clone() { return pos(p.x, p.y, p.z) },
  }
  return p
}

// names: { 'x,y,z': blockName }; missing = stone (loaded, not air).
function worldBot({ registry = {}, veins = [], names = {} } = {}) {
  const blocksByName = {}
  for (const [name, id] of Object.entries(registry)) blocksByName[name] = { id }
  return {
    entity: { position: pos(0, 64, 0) },
    registry: { blocksByName },
    findBlocks: (opts) => {
      const want = new Set(Array.isArray(opts.matching) ? opts.matching : [opts.matching])
      return veins.filter((q) => {
        const n = names[`${q.x},${q.y},${q.z}`]
        const id = n && blocksByName[n] ? blocksByName[n].id : undefined
        return want.has(id)
      })
    },
    blockAt: (p) => {
      const n = names[`${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`]
      return { name: n || 'stone' }
    },
    chat() {},
  }
}

let origLog
beforeEach(() => { origLog = console.log; console.log = () => {} })
afterEach(() => { console.log = origLog })

const REG = { iron_ore: 15, gold_ore: 14, oak_log: 17 }

describe('scan notes exposure (atl.16)', () => {
  it('an open vein notes exposed true, a buried one false', () => {
    const open = pos(10, 60, 0)
    const shut = pos(20, 60, 0)
    const bot = worldBot({
      registry: REG,
      veins: [open, shut],
      names: {
        '10,60,0': 'iron_ore', '11,60,0': 'air', // open: air touches the vein
        '20,60,0': 'iron_ore', // shut: stone all around
      },
    })
    const ctx = {}
    const r = resources.scan(bot, ctx, { radius: 48, now: 5000 })
    assert.equal(r.added, 2)
    const cells = [...ctx.resources.items.values()].sort((a, b) => a.x - b.x)
    assert.equal(cells[0].exposed, true)
    assert.equal(cells[1].exposed, false)
    assert.equal(cells[0].at, 5000)
  })

  it('re-note refreshes the flag when a vein opens up or closes', () => {
    const ctx = {}
    resources.noteSpots(ctx, [{ x: 1, y: 2, z: 3, name: 'iron_ore', exposed: false }], 1000)
    assert.equal(resources.nearest(ctx, pos(1, 2, 3)).exposed, false)
    resources.noteSpots(ctx, [{ x: 1, y: 2, z: 3, name: 'iron_ore', exposed: true }], 2000)
    const cell = resources.nearest(ctx, pos(1, 2, 3))
    assert.equal(cell.exposed, true)
    assert.equal(cell.at, 2000)
    assert.equal(resources.count(ctx), 1)
  })

  it('a per-spot at wins over now; garbage exposed reads as undefined', () => {
    const ctx = {}
    resources.noteSpots(ctx, [
      { x: 1, y: 2, z: 3, name: 'iron_ore', at: 111, exposed: 'yes' },
      { x: 4, y: 5, z: 6, name: 'gold_ore' },
    ], 9999)
    const a = resources.nearest(ctx, pos(1, 2, 3), ['iron_ore'])
    assert.equal(a.at, 111)
    assert.equal(a.exposed, undefined)
    const b = resources.nearest(ctx, pos(4, 5, 6), ['gold_ore'])
    assert.equal(b.at, 9999)
    assert.equal(b.exposed, undefined)
  })
})

describe('exposedOf read rule (atl.16)', () => {
  const cell = (exposed) => ({ x: 10, y: 60, z: 0, name: 'iron_ore', at: 1, exposed })

  it('loaded chunk recomputes live, stale flag ignored', () => {
    const bot = worldBot({ names: { '10,60,0': 'iron_ore', '11,60,0': 'air' } })
    assert.equal(resources.exposedOf(bot, cell(false)), true)
    const shut = worldBot({ names: { '10,60,0': 'iron_ore' } })
    assert.equal(resources.exposedOf(shut, cell(true)), false)
  })

  it('a mined-out loaded cell reads undefined, not a confident boolean', () => {
    // Dug out with the tunnel beside it: neighbours say exposed, but the
    // vein is gone — must not read true.
    const dug = worldBot({ names: { '10,60,0': 'air', '11,60,0': 'air' } })
    assert.equal(resources.exposedOf(dug, cell(true)), undefined)
    // Filled with stone: must not read a confident false either.
    const filled = worldBot({ names: { '10,60,0': 'stone' } })
    assert.equal(resources.exposedOf(filled, cell(true)), undefined)
  })

  it('unloaded chunk trusts the remembered flag', () => {
    const bot = worldBot({})
    bot.blockAt = () => null
    assert.equal(resources.exposedOf(bot, cell(true)), true)
    assert.equal(resources.exposedOf(bot, cell(false)), false)
    assert.equal(resources.exposedOf(bot, cell(undefined)), undefined)
  })

  it('no bot, bad item, or throwing world never throws', () => {
    assert.equal(resources.exposedOf(null, cell(true)), true)
    assert.equal(resources.exposedOf(undefined, cell(undefined)), undefined)
    assert.equal(resources.exposedOf(worldBot({}), null), undefined)
    assert.equal(resources.exposedOf(worldBot({}), { name: 'iron_ore' }), undefined)
    const bad = worldBot({})
    bad.blockAt = () => { throw new Error('unloaded') }
    assert.equal(resources.exposedOf(bad, cell(true)), true)
  })
})

describe('scout tick feeds finds memory (atl.16)', () => {
  it('chat-fresh veins land in memory with exposure', () => {
    const lines = []
    const bot = worldBot({
      registry: REG,
      veins: [pos(3, 60, 0), pos(8, 60, 0)],
      names: {
        '3,60,0': 'iron_ore', '4,60,0': 'air',
        '8,60,0': 'iron_ore', // shut: stone all around
      },
    })
    bot.chat = (line) => { lines.push(line) }
    const ctx = {}
    makeScout(bot, { everyMs: 0, ctx }).tick()
    assert.deepEqual(lines, ['iron_ore x2 at 3 60 0'])
    assert.equal(resources.count(ctx), 2)
    const cells = [...ctx.resources.items.values()].sort((a, b) => a.x - b.x)
    assert.equal(cells[0].exposed, true)
    assert.equal(cells[1].exposed, false)
  })

  it('repeat ticks refresh flags without re-chatting', () => {
    const lines = []
    const names = { '3,60,0': 'iron_ore' }
    const bot = worldBot({ registry: REG, veins: [pos(3, 60, 0)], names })
    bot.chat = (line) => { lines.push(line) }
    const ctx = {}
    const scout = makeScout(bot, { everyMs: 0, ctx })
    scout.tick()
    assert.equal(resources.nearest(ctx, pos(0, 64, 0)).exposed, false)
    names['4,60,0'] = 'air' // the vein opens up (dug out next door)
    scout.tick()
    assert.deepEqual(lines, ['iron_ore x1 at 3 60 0']) // still chats once
    assert.equal(resources.nearest(ctx, pos(0, 64, 0)).exposed, true)
  })

  it('without ctx the tick writes no memory (old call sites)', () => {
    const bot = worldBot({
      registry: REG,
      veins: [pos(3, 60, 0)],
      names: { '3,60,0': 'iron_ore' },
    })
    const lines = []
    bot.chat = (line) => { lines.push(line) }
    makeScout(bot, { everyMs: 0 }).tick()
    assert.deepEqual(lines, ['iron_ore x1 at 3 60 0'])
  })

  it('ticker seam: a player-present tick grows memory with the flag', async () => {
    const { createTicker } = require('../src/index')
    const names = { '4,60,1': 'iron_ore', '5,60,1': 'air' }
    const bot = {
      username: 'IdkBot',
      players: { Steve: { username: 'Steve', entity: { id: 7, position: pos(10, 64, 0) } } },
      entities: {},
      health: 20,
      food: 20,
      entity: { position: pos(0, 64, 0) },
      registry: { blocksByName: { iron_ore: { id: 15 } } },
      findBlocks: () => [pos(4, 60, 1)],
      blockAt: (p) => ({ name: names[`${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`] || 'stone' }),
      lines: [],
      chat(line) { this.lines.push(line) },
      pathfinder: { goal: null, setGoal() {}, stop() {}, isMoving: () => false, setMovements() {} },
      setControlState() {},
      clearControlStates() {},
      getControlState: () => false,
    }
    const ticker = createTicker({
      bot,
      brain: { async decide() { return { action: 'idle', sprint: false, source: 'stub' } } },
      tickMs: 10,
      idleTickMs: 10,
    })
    await ticker.tick()
    assert.ok(bot.lines.includes('iron_ore x1 at 4 60 1'), `lines: ${bot.lines}`)
    const ctx = bot._tickerCtx
    assert.ok(ctx, 'ticker ctx exists')
    assert.equal(resources.count(ctx), 1)
    assert.equal(resources.nearest(ctx, pos(0, 64, 0)).exposed, true)
  })
})

describe('exposed + at survive save/restore (atl.16)', () => {
  const SPAWN = { x: 0, y: 64, z: 0 }
  const botAt = (spawn) => ({ username: 'MemBot', spawnPoint: { ...spawn } })
  let dir = null
  let file = null

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atl16-'))
    file = path.join(dir, 'bot.json')
  })
  afterEach(() => {
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch (_) { /* tmp best-effort */ }
  })

  it('save/restore round-trips exposed and at per cell', () => {
    const ctx1 = {}
    resources.noteSpots(ctx1, [
      { x: 12, y: 60, z: 22, name: 'iron_ore', at: 1000, exposed: true },
      { x: -5, y: 64, z: 8, name: 'oak_log', at: 2000, exposed: false },
    ])
    assert.equal(memory.save(botAt(SPAWN), ctx1, file, 3000), true)
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
    const byName = Object.fromEntries(raw.resources.map((r) => [r.name, r]))
    assert.equal(byName.iron_ore.exposed, true)
    assert.equal(byName.iron_ore.at, 1000)
    assert.equal(byName.oak_log.exposed, false)
    assert.equal(byName.oak_log.at, 2000)

    const ctx2 = {}
    const back = memory.restore(botAt(SPAWN), ctx2, file, 9999)
    assert.ok(back)
    assert.equal(resources.count(ctx2), 2)
    assert.deepEqual(
      resources.nearest(ctx2, pos(12, 60, 22), ['iron_ore']),
      { x: 12, y: 60, z: 22, name: 'iron_ore', at: 1000, exposed: true })
    assert.deepEqual(
      resources.nearest(ctx2, pos(-5, 64, 8), ['oak_log']),
      { x: -5, y: 64, z: 8, name: 'oak_log', at: 2000, exposed: false })
  })

  it('an old file without the flag loads as exposed undefined', () => {
    const world = memory.worldKey(botAt(SPAWN))
    fs.writeFileSync(file, JSON.stringify({
      v: 1,
      world,
      savedAt: 1000,
      homes: [],
      resources: [{ x: 1, y: 2, z: 3, name: 'iron_ore' }],
      visited: [],
      danger: [],
    }))
    const ctx = {}
    const back = memory.restore(botAt(SPAWN), ctx, file, 5000)
    assert.ok(back)
    assert.equal(resources.count(ctx), 1)
    const cell = resources.nearest(ctx, pos(1, 2, 3))
    assert.equal(cell.exposed, undefined)
    assert.equal('exposed' in cell, true)
    assert.equal(cell.at, 5000, 'missing at falls back to restore time')
  })
})
