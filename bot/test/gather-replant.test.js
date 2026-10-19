'use strict'

// Wood self-sufficiency (idkcraft-gc3j): when the bot fells a tree near home
// it replants a sapling on the stump cell, and far-search log hits are noted
// into resource memory (persisted like finds) so gather routes there when
// the near search is empty. The protected-log rule is untouched: owner
// pillars stay refused and never dug.

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const gather = require('../src/behaviours/gather')
const resources = require('../src/resources')
const { NEED_LOGS } = require('../src/budget')

function pos(x, y, z) {
  const p = {
    x, y, z,
    distanceTo: (q) => Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z),
    clone() { return pos(p.x, p.y, p.z) },
    offset(ox, oy, oz) { return pos(p.x + ox, p.y + oy, p.z + oz) },
    floored() { return pos(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)) },
  }
  return p
}

const LOGREG = { oak_log: 17, oak_leaves: 18, stone: 1, dirt: 2 }
const FIND_MD = 48

function mockBot({ names = {}, items = [], syncHits = null } = {}) {
  const lines = []
  const blocksByName = {}
  for (const [name, id] of Object.entries(LOGREG)) blocksByName[name] = { id }
  const calls = { setGoal: 0, goals: [] }
  const bot = {
    lines,
    calls,
    players: { Owner: {} }, // owner online: no alone-idle leash on far memory
    entity: { position: pos(0, 64, 0) },
    registry: { blocksByName },
    _moving: false,
    _items: items,
    digCalls: 0,
    placeCalls: 0,
    equipped: null,
    pathfinder: {
      goal: null,
      setGoal: (goal) => { calls.setGoal++; calls.goals.push(goal); bot.pathfinder.goal = goal },
      isMoving: () => bot._moving,
    },
    inventory: { items: () => bot._items },
    findBlocks: (opts = {}) => {
      if (Array.isArray(syncHits)) return syncHits.map((c) => pos(c.x, c.y, c.z))
      // Live-world read like the real scan: loaded oak logs in range.
      const md = typeof opts.maxDistance === 'number' ? opts.maxDistance : FIND_MD
      const e = bot.entity.position
      const out = []
      for (const [k, n] of Object.entries(names)) {
        if (n !== 'oak_log') continue
        const [x, y, z] = k.split(',').map(Number)
        if (Math.hypot(x - e.x, y - e.y, z - e.z) <= md) out.push(pos(x, y, z))
      }
      return out.slice(0, typeof opts.count === 'number' ? opts.count : out.length)
    },
    blockAt(p) {
      if (!p || typeof p.x !== 'number') return null
      const n = names[`${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`]
      if (!n) return null // unloaded, like the real thing
      if (typeof p.floored !== 'function') throw new TypeError('pos.floored is not a function (plain g.pos)')
      return { name: n, position: pos(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)), boundingBox: 'block' }
    },
    canDigBlock(block) {
      if (!block || !block.position) return false
      const e = bot.entity.position
      const dx = block.position.x + 0.5 - e.x
      const dy = block.position.y + 0.5 - (e.y + 1.65)
      const dz = block.position.z + 0.5 - e.z
      return Math.hypot(dx, dy, dz) <= 5.1
    },
    dig: async (block) => {
      bot.digCalls++
      const bp = block && block.position
      if (bp) names[`${bp.x},${bp.y},${bp.z}`] = 'air' // chopped: loaded, stale
      bot._items.push({ name: 'oak_log', count: 1 })
    },
    equip: async (item) => { bot.equipped = item && item.name },
    placeBlock: async (ref, face) => {
      bot.placeCalls++
      const rp = ref && ref.position
      const cell = rp ? `${rp.x + face.x},${rp.y + face.y},${rp.z + face.z}` : null
      // A real placement consumes one pack sapling into the world cell.
      const i = bot._items.findIndex((it) => it && it.name && it.name.endsWith('_sapling'))
      if (i === -1) throw new Error('no sapling')
      bot._items.splice(i, 1)
      if (cell) names[cell] = 'oak_sapling'
    },
    chat(line) { lines.push(String(line)) },
  }
  return bot
}

// NEED_LOGS trunks at x0+2i: 3-log oaks with a leaf each (the tree-guard
// shape), dirt under every base so the stump takes a sapling.
function grove(names, x0, n = NEED_LOGS) {
  for (let i = 0; i < n; i++) {
    const x = x0 + 2 * i
    names[`${x},63,0`] = 'dirt'
    names[`${x},64,0`] = 'oak_log'
    names[`${x},65,0`] = 'oak_log'
    names[`${x},66,0`] = 'oak_log'
    names[`${x + 1},66,0`] = 'oak_leaves'
  }
}

function homeCtx(over = {}) {
  return { lastGoalKey: '', stepStatus: 'running', home: { site: { x: 0, y: 64, z: 0 } }, ...over }
}

// Drive the step; teleport along gather walks, hold still for digs/pickup.
async function drive(bot, ctx, maxTicks = 1200) {
  for (let i = 0; i < maxTicks; i++) {
    gather(bot, ctx, null, {})
    await new Promise((resolve) => setImmediate(resolve)) // flush dig landings
    const g = ctx.gather
    if (!g || g.final) break
    const gk = ctx.lastGoalKey
    if (gk.startsWith('gather:') && g.pos) {
      bot.entity.position = pos(g.pos.x + 1, g.pos.y, g.pos.z)
      bot._moving = false
    } else if (gk.startsWith('gather-pickup')) {
      bot._moving = false
    }
  }
  for (let i = 0; i < 30; i++) await new Promise((resolve) => setImmediate(resolve)) // land replant flights
}

describe('gather replant (idkcraft-gc3j)', () => {
  it('replants one pack sapling on the first home stump and hauls to done', async () => {
    const names = {}
    grove(names, 10)
    const bot = mockBot({ names, items: [{ name: 'oak_sapling', count: 1 }] })
    const ctx = homeCtx()
    await drive(bot, ctx)
    assert.equal(ctx.stepStatus, 'done')
    assert.equal(ctx.gather.replanted, 1)
    assert.equal(bot.placeCalls, 1)
    assert.equal(bot.equipped, 'oak_sapling')
    assert.equal(names['10,64,0'], 'oak_sapling')
  })

  it('no sapling in pack: no placement, still done', async () => {
    const names = {}
    grove(names, 10)
    const bot = mockBot({ names, items: [] })
    const ctx = homeCtx()
    await drive(bot, ctx)
    assert.equal(ctx.stepStatus, 'done')
    assert.equal(bot.placeCalls, 0)
    assert.equal(ctx.gather.replanted || 0, 0)
  })

  it('a memory-routed stand past 160 is chopped but never replanted', async () => {
    const names = {}
    grove(names, 200)
    const bot = mockBot({ names, items: [{ name: 'oak_sapling', count: 1 }] })
    const ctx = homeCtx()
    resources.noteSpots(ctx, [{ x: 200, y: 64, z: 0, name: 'oak_log' }], Date.now())
    await drive(bot, ctx)
    assert.equal(ctx.stepStatus, 'done')
    assert.equal(bot.placeCalls, 0)
    assert.equal(bot._items.filter((it) => it.name === 'oak_sapling').length, 1)
  })

  it('a stump inside the house footprint is not replanted', async () => {
    const names = {}
    grove(names, 10)
    const bot = mockBot({ names, items: [{ name: 'oak_sapling', count: 1 }] })
    const ctx = homeCtx({
      home: {
        site: { x: 0, y: 64, z: 0 },
        interior: { min: { x: 8, y: 63, z: -2 }, max: { x: 40, y: 67, z: 2 } },
      },
    })
    await drive(bot, ctx)
    assert.equal(ctx.stepStatus, 'done')
    assert.equal(bot.placeCalls, 0)
  })

  it('a leafless owner pillar stays protected: never dug, never planted', async () => {
    const names = { '12,63,0': 'dirt', '12,64,0': 'oak_log', '12,65,0': 'oak_log' }
    const bot = mockBot({
      names,
      items: [{ name: 'oak_sapling', count: 1 }],
      syncHits: [{ x: 12, y: 64, z: 0 }, { x: 12, y: 65, z: 0 }],
    })
    const ctx = homeCtx()
    await drive(bot, ctx, 60)
    assert.equal(bot.digCalls, 0)
    assert.equal(bot.placeCalls, 0)
  })
})

describe('noteFarWood (idkcraft-gc3j)', () => {
  function farBot(cells) {
    return {
      entity: { position: pos(0, 64, 0) },
      blockAt(p) {
        const n = cells[`${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`]
        return n ? { name: n } : null
      },
    }
  }

  it('notes the nearest live logs up to the cap, skipping stale and stone cells', () => {
    const cells = {}
    for (let i = 0; i < 20; i++) cells[`${100 + i},64,0`] = 'oak_log'
    cells['105,64,0'] = 'air' // chopped since the scan: stale, skipped
    cells['110,64,0'] = 'stone' // not wood: skipped
    const bot = farBot(cells)
    const ctx = {}
    const hits = new Map()
    for (let i = 0; i < 20; i++) hits.set(`${100 + i},64,0`, { x: 100 + i, y: 64, z: 0 })
    const n = gather.noteFarWood(bot, ctx, { x: 0, y: 64, z: 0 }, { hits }, () => false)
    assert.equal(n, 16)
    assert.equal(resources.count(ctx), 16)
    const near = resources.nearest(ctx, { x: 0, y: 64, z: 0 }, ['oak_log'])
    assert.equal(near.x, 100)
  })

  it('an excluded stand is never remembered', () => {
    const cells = { '100,64,0': 'oak_log' }
    const bot = farBot(cells)
    const ctx = {}
    const hits = new Map([['100,64,0', { x: 100, y: 64, z: 0 }]])
    const n = gather.noteFarWood(bot, ctx, { x: 0, y: 64, z: 0 }, { hits }, () => true)
    assert.equal(n, 0)
    assert.equal(resources.count(ctx), 0)
  })
})
