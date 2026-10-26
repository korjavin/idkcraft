'use strict'

// Sustainable harvest (idkcraft-qfus): after the harvest path fells trees
// it replants saplings on the stumps — cut N trees -> plant N saplings
// when saplings are on hand — and speaks one honest line when it felled
// more than it replanted. Both harvest legs (gather step, bring-mine dig)
// plant through reforest's vetted rule; the planting rides the cycle's
// own bounds (one attempt per stump, never a spin) and days only.

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const gather = require('../src/behaviours/gather')
const bring = require('../src/behaviours/bring')
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

function gatherBot({ names = {}, items = [], night = false } = {}) {
  const lines = []
  const blocksByName = {}
  for (const [name, id] of Object.entries(LOGREG)) blocksByName[name] = { id }
  const calls = { setGoal: 0, goals: [] }
  const bot = {
    lines,
    calls,
    players: { Owner: {} },
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
      if (!n) return null
      if (typeof p.floored !== 'function') throw new TypeError('plain pos')
      return { name: n, position: pos(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)), boundingBox: 'block' }
    },
    canDigBlock: () => true,
    dig: async (block) => {
      bot.digCalls++
      const bp = block && block.position
      if (bp) names[`${bp.x},${bp.y},${bp.z}`] = 'air'
      bot._items.push({ name: 'oak_log', count: 1 })
    },
    equip: async (item) => { bot.equipped = item && item.name },
    placeBlock: async (ref, face) => {
      bot.placeCalls++
      const rp = ref && ref.position
      const cell = rp ? `${rp.x + face.x},${rp.y + face.y},${rp.z + face.z}` : null
      const want = bot.equipped
      const i = bot._items.findIndex((it) => it && it.name === want)
      if (i === -1) throw new Error(`no ${want}`)
      bot._items.splice(i, 1)
      if (cell) names[cell] = want
    },
    chat(line) { lines.push(String(line)) },
  }
  if (night) bot.time = { timeOfDay: 20000 }
  return bot
}

// NEED_LOGS trunks: 3-log oaks with a leaf each, dirt under every base.
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

function saplings(n) {
  const out = []
  for (let i = 0; i < n; i++) out.push({ name: 'oak_sapling', count: 1 })
  return out
}

function homeCtx(over = {}) {
  return { lastGoalKey: '', stepStatus: 'running', home: { site: { x: 0, y: 64, z: 0 } }, ...over }
}

async function drive(bot, ctx, maxTicks = 1200) {
  for (let i = 0; i < maxTicks; i++) {
    gather(bot, ctx, null, {})
    await new Promise((resolve) => setImmediate(resolve))
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
  for (let i = 0; i < 30; i++) await new Promise((resolve) => setImmediate(resolve))
}

// One bring-mine bot: a single oak on dirt with a leaf, the owner standing
// next to the body so the return leg tosses at once.
function bringBot(cells, items) {
  const lines = []
  const bot = {
    lines,
    username: 'IdkBot',
    entities: {},
    health: 20,
    food: 20,
    time: { timeOfDay: 1000 },
    entity: { position: pos(4.5, 63, 0.5), onGround: true },
    registry: {
      blocksByName: { oak_log: { id: 17 }, dirt: { id: 1 } },
      itemsByName: { oak_log: { id: 17 }, oak_sapling: { id: 18 } },
    },
    players: { P: { username: 'P', entity: { position: pos(4.5, 63, 1.5) } } },
    _items: items,
    held: null,
    digCalls: 0,
    placeCalls: 0,
    pathfinder: {
      goal: null,
      setGoal(g) { bot.pathfinder.goal = g },
      isMoving: () => false,
      stop() {},
      bestHarvestTool: () => null,
    },
    inventory: { items: () => bot._items },
    findBlocks: () => [],
    blockAt(p) {
      const n = cells[`${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`]
      if (!n) return null
      return { name: n, position: pos(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)) }
    },
    canDigBlock: () => true,
    equip: async (item) => { bot.held = item && item.name },
    dig: async (block) => {
      bot.digCalls++
      const bp = block && block.position
      if (bp) cells[`${bp.x},${bp.y},${bp.z}`] = 'air'
      bot._items.push({ name: 'oak_log', count: 1 })
    },
    placeBlock: async (ref, face) => {
      bot.placeCalls++
      const rp = ref && ref.position
      const cell = rp ? `${rp.x + face.x},${rp.y + face.y},${rp.z + face.z}` : null
      const want = bot.held
      const i = bot._items.findIndex((it) => it && it.name === want)
      if (i === -1) throw new Error(`no ${want}`)
      bot._items.splice(i, 1)
      if (cell) cells[cell] = want
    },
    toss: async () => {},
    chat(line) { lines.push(String(line)) },
  }
  return bot
}

function bringCells() {
  return {
    '5,63,0': 'dirt', '5,64,0': 'oak_log', '5,65,0': 'oak_log', '5,66,0': 'oak_log',
    '6,66,0': 'oak_leaves', '4,63,0': 'dirt',
  }
}

function bringOrder() {
  return {
    phase: 'dig', kind: 'block', name: 'oak_log', block: 'oak_log',
    drop: 'oak_log', want: 1, have: 0, pos: pos(5, 64, 0), by: 'P',
  }
}

async function driveBring(bot, ctx, maxTicks = 60) {
  for (let i = 0; i < maxTicks; i++) {
    await bring(bot, ctx, null, {})
    await new Promise((resolve) => setImmediate(resolve))
    if (!ctx.bring) break
  }
  for (let i = 0; i < 30; i++) await new Promise((resolve) => setImmediate(resolve))
}

function deficitLines(bot) {
  return bot.lines.filter((l) => l.startsWith('cut '))
}

describe('qfus sustainable harvest — gather leg', () => {
  it('cut N, replant N: a full pack replants every stump and stays silent', async () => {
    const names = {}
    grove(names, 10)
    const bot = gatherBot({ names, items: saplings(NEED_LOGS) })
    const ctx = homeCtx()
    await drive(bot, ctx)
    assert.equal(ctx.stepStatus, 'done')
    assert.equal(ctx.gather.felled, NEED_LOGS)
    assert.equal(ctx.gather.replanted, NEED_LOGS)
    assert.equal(bot.placeCalls, NEED_LOGS)
    for (let i = 0; i < NEED_LOGS; i++) {
      assert.equal(names[`${10 + 2 * i},64,0`], 'oak_sapling', `stump ${i} replanted`)
    }
    assert.deepEqual(bot.lines, [`got ${NEED_LOGS} logs`], 'whole harvest: no deficit line')
  })

  it('short on saplings: counts stay exact and one honest line names the deficit', async () => {
    const names = {}
    grove(names, 10)
    const bot = gatherBot({ names, items: saplings(2) })
    const ctx = homeCtx()
    await drive(bot, ctx)
    assert.equal(ctx.stepStatus, 'done')
    assert.equal(ctx.gather.felled, NEED_LOGS, 'felled counts trees, not logs')
    assert.equal(ctx.gather.replanted, 2)
    assert.ok(bot.placeCalls <= ctx.gather.felled, 'never more plantings than stumps')
    assert.deepEqual(deficitLines(bot), [`cut ${NEED_LOGS}, replanted 2 — out of saplings`])
  })

  it('no saplings at all: nothing plants, the line still speaks', async () => {
    const names = {}
    grove(names, 10)
    const bot = gatherBot({ names, items: [] })
    const ctx = homeCtx()
    await drive(bot, ctx)
    assert.equal(ctx.stepStatus, 'done')
    assert.equal(bot.placeCalls, 0)
    assert.equal(ctx.gather.felled, NEED_LOGS)
    assert.equal(ctx.gather.replanted, 0)
    assert.deepEqual(deficitLines(bot), [`cut ${NEED_LOGS}, replanted 0 — out of saplings`])
  })

  it('night planting is day-only: the pack keeps its saplings and the line says bare, not out', async () => {
    const names = {}
    grove(names, 10)
    const bot = gatherBot({ names, items: saplings(3), night: true })
    const ctx = homeCtx()
    await drive(bot, ctx)
    assert.equal(ctx.stepStatus, 'done')
    assert.equal(bot.placeCalls, 0)
    assert.equal(ctx.gather.replanted, 0)
    assert.equal(bot._items.filter((it) => it.name === 'oak_sapling').length, 3)
    assert.deepEqual(deficitLines(bot), [`cut ${NEED_LOGS}, replanted 0 — ${NEED_LOGS} stumps left bare`])
  })

  it('no replant when nothing felled: a full pack stays single-line', async () => {
    const names = {}
    grove(names, 10)
    const bot = gatherBot({ names, items: [{ name: 'oak_log', count: NEED_LOGS }] })
    const ctx = homeCtx()
    gather(bot, ctx, null, {})
    assert.equal(ctx.stepStatus, 'done')
    assert.equal((ctx.gather.felled | 0), 0)
    assert.equal(bot.placeCalls, 0)
    assert.deepEqual(bot.lines, [`got ${NEED_LOGS} logs`])
  })
})

describe('qfus sustainable harvest — bring leg', () => {
  it('a bring-mine dig replants the stump and the order ends without a deficit', async () => {
    const cells = bringCells()
    const bot = bringBot(cells, [{ name: 'oak_sapling', count: 1 }])
    const ctx = { lastGoalKey: 'bring:5,64,0', bring: bringOrder() }
    await driveBring(bot, ctx)
    assert.equal(cells['5,64,0'], 'oak_sapling', 'felled stump replanted')
    assert.equal(bot.placeCalls, 1, 'exactly one planting attempt')
    assert.equal(ctx.bring, null, 'order done')
    assert.ok(bot.lines.some((l) => l === 'here is 1 oak_log'), `toss line: ${bot.lines}`)
    assert.deepEqual(deficitLines(bot), [], 'whole harvest: no deficit line')
  })

  it('a bring-mine dig short on saplings speaks the deficit on the terminal line', async () => {
    const cells = bringCells()
    const bot = bringBot(cells, [])
    const ctx = { lastGoalKey: 'bring:5,64,0', bring: bringOrder() }
    await driveBring(bot, ctx)
    assert.equal(cells['5,64,0'], 'air', 'bare stump stays bare')
    assert.equal(ctx.bring, null, 'order done')
    assert.ok(bot.lines.some((l) => l === 'here is 1 oak_log'), `toss line: ${bot.lines}`)
    assert.deepEqual(deficitLines(bot), ['cut 1, replanted 0 — out of saplings'])
  })
})
