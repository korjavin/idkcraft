'use strict'

// Sustainable harvest (idkcraft-qfus, R1): after the harvest path fells
// trees it replants the recorded bases once their trunks are clear —
// never under standing wood — and speaks one honest line when it felled
// more than it replanted. Every fell counts wherever it falls (no home,
// no radius); planting eligibility gates the plant, never the count.
// Both harvest legs (gather step, bring-mine dig) plant through
// reforest's vetted rule; the landing awaits the flight, so pickup and
// the terminal summary never race it.

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

// NEED_LOGS trunks: 3-log oaks with leaves over the crown on a dirt
// floor, so a replant lands beside the stump it replaces (qfus R1 never
// plants under standing wood). The atop leaf matters: once the lower logs
// are dug, the trunk-remnant rule only still reads the top as a tree with
// leaves above, so tops stay diggable while the trunk comes down.
function grove(names, x0, n = NEED_LOGS) {
  for (let x = x0 - 2; x < x0 + 2 * n + 2; x++) {
    for (let z = -2; z <= 2; z++) names[`${x},63,${z}`] = 'dirt'
  }
  for (let i = 0; i < n; i++) {
    const x = x0 + 2 * i
    names[`${x},64,0`] = 'oak_log'
    names[`${x},65,0`] = 'oak_log'
    names[`${x},66,0`] = 'oak_log'
    names[`${x},67,0`] = 'oak_leaves'
    names[`${x + 1},66,0`] = 'oak_leaves'
  }
  fillAir(names, x0 - 3, x0 + 2 * n + 2)
}

// Short 2-log oaks on the same dirt floor (14 logs = 7 whole trees):
// every bottom completes, so counts are exact regardless of chop order.
function grove2(names, x0, n = 7) {
  for (let x = x0 - 2; x < x0 + 2 * n + 2; x++) {
    for (let z = -2; z <= 2; z++) names[`${x},63,${z}`] = 'dirt'
  }
  for (let i = 0; i < n; i++) {
    const x = x0 + 2 * i
    names[`${x},64,0`] = 'oak_log'
    names[`${x},65,0`] = 'oak_log'
    names[`${x},66,0`] = 'oak_leaves'
    names[`${x + 1},65,0`] = 'oak_leaves'
  }
  fillAir(names, x0 - 3, x0 + 2 * n + 2)
}

// A worked stand is loaded ground: dirt under, air around. Unset cells
// read as unloaded (null) in the mock, which the vetted-spot rule
// correctly refuses — so the stand's air is modelled, not assumed.
function fillAir(names, x0, x1) {
  for (let x = x0; x <= x1; x++) {
    for (let y = 64; y <= 68; y++) {
      for (let z = -3; z <= 3; z++) {
        if (names[`${x},${y},${z}`] === undefined) names[`${x},${y},${z}`] = 'air'
      }
    }
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

// Prod bodies fall: pickup walks onto the dug column (GoalBlock) and
// gravity drops the body back down the hollow trunk, so the next find
// sees bottoms first again. The mock teleports, so it settles the same
// way — otherwise it floats at canopy level, digs tops first, and the
// trunk-remnant rule protects the bottoms below (a mock-only pathology).
function settle(names, x, y, z) {
  let yy = y
  while (yy > 1 && names[`${x},${yy - 1},${z}`] === 'air') yy--
  return pos(x, yy, z)
}

async function drive(bot, ctx, names, maxTicks = 1200) {
  for (let i = 0; i < maxTicks; i++) {
    gather(bot, ctx, null, {})
    await new Promise((resolve) => setImmediate(resolve))
    const g = ctx.gather
    if (!g || g.final) break
    const gk = ctx.lastGoalKey
    if (gk.startsWith('gather:') && g.pos) {
      bot.entity.position = settle(names, g.pos.x + 1, g.pos.y, g.pos.z)
      bot._moving = false
    } else if (gk.startsWith('gather-pickup') && g.pos) {
      bot.entity.position = settle(names, g.pos.x, g.pos.y, g.pos.z)
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
    findBlocks: (opts = {}) => {
      const want = new Set(Array.isArray(opts.matching) ? opts.matching : [opts.matching])
      const md = typeof opts.maxDistance === 'number' ? opts.maxDistance : 48
      const e = bot.entity.position
      const out = []
      for (const [k, n] of Object.entries(cells)) {
        const id = bot.registry.blocksByName[n] && bot.registry.blocksByName[n].id
        if (id === undefined || !want.has(id)) continue
        const [x, y, z] = k.split(',').map(Number)
        if (Math.hypot(x - e.x, y - e.y, z - e.z) <= md) out.push(pos(x, y, z))
      }
      return out.slice(0, typeof opts.count === 'number' ? opts.count : out.length)
    },
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
  const cells = {
    '5,63,0': 'dirt', '5,64,0': 'oak_log', '5,65,0': 'oak_log', '5,66,0': 'oak_log',
    '5,67,0': 'oak_leaves', '6,66,0': 'oak_leaves',
  }
  for (let x = 2; x <= 8; x++) {
    for (let z = -2; z <= 2; z++) {
      if (cells[`${x},63,${z}`] === undefined) cells[`${x},63,${z}`] = 'dirt'
      for (let y = 64; y <= 68; y++) {
        if (cells[`${x},${y},${z}`] === undefined) cells[`${x},${y},${z}`] = 'air'
      }
    }
  }
  return cells
}

function bringOrder(want = 3) {
  return {
    phase: 'dig', kind: 'block', name: 'oak_log', block: 'oak_log',
    drop: 'oak_log', want, have: 0, pos: pos(5, 64, 0), by: 'P',
  }
}

async function driveBring(bot, ctx, maxTicks = 120) {
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

function saplingCells(names) {
  return Object.entries(names).filter(([, n]) => n === 'oak_sapling').map(([k]) => k)
}

describe('qfus sustainable harvest — beside the stump, never under wood', () => {
  it('a bottom landing with a standing trunk plants beside it, never under it', async () => {
    const names = {
      '9,63,0': 'dirt', '10,63,0': 'dirt', '11,63,0': 'dirt',
      '9,64,0': 'air', '9,65,0': 'air', // the clear neighbour, loaded
      '10,64,0': 'oak_log', '10,65,0': 'oak_log', '10,66,0': 'oak_log',
    }
    const bot = gatherBot({ names, items: saplings(1) })
    bot.entity.position = pos(11, 64, 0) // walk-arrival stance, adjacent
    const ctx = { lastGoalKey: 'gather:10,64,0' } // no home: counting needs none
    const block64 = { name: 'oak_log', position: pos(10, 64, 0) }
    names['10,64,0'] = 'air' // the dig landed
    const g = {}
    await gather.harvestLanding(bot, { ...ctx, gather: g }, g, block64, null, 'gather:10,64,0')
    assert.equal(g.felled, 1, 'bottom counts the tree')
    assert.equal(g.replanted, 1)
    assert.equal(bot.placeCalls, 1)
    assert.equal(names['10,64,0'], 'air', 'stump left open, nothing under the trunk')
    assert.equal(names['9,64,0'], 'oak_sapling', 'clear neighbour takes the sapling')
  })

  it('a lone trunk plants where it stood', async () => {
    const names = { '9,63,0': 'dirt', '10,63,0': 'dirt', '10,64,0': 'oak_log', '10,65,0': 'air' }
    const bot = gatherBot({ names, items: saplings(1) })
    bot.entity.position = pos(11, 64, 0)
    const ctx = { lastGoalKey: 'gather:10,64,0' }
    const block64 = { name: 'oak_log', position: pos(10, 64, 0) }
    names['10,64,0'] = 'air'
    const g = {}
    await gather.harvestLanding(bot, { ...ctx, gather: g }, g, block64, null, 'gather:10,64,0')
    assert.equal(g.felled, 1)
    assert.equal(g.replanted, 1)
    assert.equal(names['10,64,0'], 'oak_sapling', 'clear stump cell takes it')
  })
})

describe('qfus sustainable harvest — gather leg', () => {
  it('whole 2-log trees plant 1:1 and stay silent', async () => {
    const names = {}
    grove2(names, 10)
    const bot = gatherBot({ names, items: saplings(7) })
    const ctx = homeCtx()
    await drive(bot, ctx, names)
    assert.equal(ctx.stepStatus, 'done')
    assert.equal(ctx.gather.felled, 7)
    assert.equal(ctx.gather.replanted, 7)
    assert.equal(bot.placeCalls, 7)
    for (let i = 0; i < 7; i++) {
      assert.equal(names[`${10 + 2 * i},64,0`], 'air', `stump ${i} left open, never planted under`)
    }
    assert.equal(saplingCells(names).length, 7, 'one neighbour sapling per felled tree')
    assert.deepEqual(bot.lines, [`got ${NEED_LOGS} logs`], 'whole harvest: no deficit line')
  })

  it('short on saplings: counts stay exact and one honest line names the deficit', async () => {
    const names = {}
    grove2(names, 10)
    const bot = gatherBot({ names, items: saplings(2) })
    const ctx = homeCtx()
    await drive(bot, ctx, names)
    assert.equal(ctx.stepStatus, 'done')
    assert.equal(ctx.gather.felled, 7, 'felled counts trees, not logs')
    assert.equal(ctx.gather.replanted, 2)
    assert.ok(bot.placeCalls <= ctx.gather.felled, 'never more plantings than stumps')
    assert.deepEqual(deficitLines(bot), ['cut 7, replanted 2 — out of saplings'])
  })

  it('no saplings at all: nothing plants, the line still speaks', async () => {
    const names = {}
    grove2(names, 10)
    const bot = gatherBot({ names, items: [] })
    const ctx = homeCtx()
    await drive(bot, ctx, names)
    assert.equal(ctx.stepStatus, 'done')
    assert.equal(bot.placeCalls, 0)
    assert.equal(ctx.gather.felled, 7)
    assert.equal(ctx.gather.replanted, 0)
    assert.deepEqual(deficitLines(bot), ['cut 7, replanted 0 — out of saplings'])
  })

  it('night planting is day-only: the pack keeps its saplings and the line says bare', async () => {
    const names = {}
    grove2(names, 10)
    const bot = gatherBot({ names, items: saplings(3), night: true })
    const ctx = homeCtx()
    await drive(bot, ctx, names)
    assert.equal(ctx.stepStatus, 'done')
    assert.equal(bot.placeCalls, 0)
    assert.equal(ctx.gather.replanted, 0)
    assert.equal(ctx.gather.felled, 7, 'night gates the plant, never the count')
    assert.equal(bot._items.filter((it) => it.name === 'oak_sapling').length, 3)
    assert.deepEqual(deficitLines(bot), ['cut 7, replanted 0 — 7 stumps left bare'])
  })

  it('a partial trunk still repays every recorded fell at once', async () => {
    const names = {}
    grove(names, 10, 5) // 5 three-log trees: 14 logs finish mid-trunk
    const bot = gatherBot({ names, items: saplings(14) })
    const ctx = homeCtx()
    await drive(bot, ctx, names)
    assert.equal(ctx.stepStatus, 'done')
    // Five bottoms recorded (the fifth trunk is half-standing), each repaid
    // beside its stump the moment it fell — nothing waits on the trunk.
    assert.equal(ctx.gather.felled, 5)
    assert.equal(ctx.gather.replanted, 5)
    assert.equal(bot.placeCalls, 5)
    assert.equal(saplingCells(names).length, 5)
    assert.deepEqual(bot.lines, [`got ${NEED_LOGS} logs`])
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

  it('a homeless harvest counts and replants: no home, no radius gate', async () => {
    const names = {}
    grove2(names, 10)
    const bot = gatherBot({ names, items: saplings(7) })
    const ctx = { lastGoalKey: '', stepStatus: 'running' } // no home at all
    await drive(bot, ctx, names)
    assert.equal(ctx.stepStatus, 'done')
    assert.equal(ctx.gather.felled, 7)
    assert.equal(ctx.gather.replanted, 7)
    assert.deepEqual(bot.lines, [`got ${NEED_LOGS} logs`])
  })
})

describe('qfus sustainable harvest — bring leg', () => {
  it('a whole trunk replants beside the stump and the order ends whole', async () => {
    const cells = bringCells()
    const bot = bringBot(cells, [{ name: 'oak_sapling', count: 1 }])
    const o = bringOrder(3)
    const ctx = { lastGoalKey: 'bring:5,64,0', bring: o }
    await driveBring(bot, ctx)
    assert.equal(cells['5,64,0'], 'air', 'stump left open, never planted under')
    assert.equal(cells['6,64,0'], 'oak_sapling', 'clear neighbour takes the sapling')
    assert.equal(o.felled, 1, 'one tree, not three logs')
    assert.equal(o.replanted, 1)
    assert.equal(ctx.bring, null, 'order done')
    assert.ok(bot.lines.some((l) => l === 'here are 3 oak_log'), `toss line: ${bot.lines}`)
    assert.deepEqual(deficitLines(bot), [], 'whole harvest: no deficit line')
  })

  it('a bring-mine dig short on saplings speaks the deficit on the terminal line', async () => {
    const cells = bringCells()
    const bot = bringBot(cells, [])
    const o = bringOrder(3)
    const ctx = { lastGoalKey: 'bring:5,64,0', bring: o }
    await driveBring(bot, ctx)
    assert.equal(cells['5,64,0'], 'air', 'bare stump stays bare')
    assert.equal(o.felled, 1)
    assert.equal(o.replanted, 0, 'counters stay down without saplings')
    assert.equal(ctx.bring, null, 'order done')
    assert.ok(bot.lines.some((l) => l === 'here are 3 oak_log'), `toss line: ${bot.lines}`)
    assert.deepEqual(deficitLines(bot), ['cut 1, replanted 0 — out of saplings'])
  })

  it('a partial fell repays beside the stump at once', async () => {
    const cells = bringCells()
    const bot = bringBot(cells, [{ name: 'oak_sapling', count: 1 }])
    const o = bringOrder(1) // bottom only: the trunk stays up
    const ctx = { lastGoalKey: 'bring:5,64,0', bring: o }
    await driveBring(bot, ctx)
    assert.equal(cells['5,64,0'], 'air', 'no sapling under standing wood')
    assert.equal(cells['6,64,0'], 'oak_sapling', 'clear neighbour takes the sapling')
    assert.equal(o.felled, 1)
    assert.equal(o.replanted, 1)
    assert.equal(ctx.bring, null, 'order done')
    assert.deepEqual(deficitLines(bot), [], 'repaid at once: nothing to confess')
  })

  it('a craft sub that felled without saplings is confessed by the terminal', async () => {
    // Fix-4 shape: the order object morphed through a log sub (subFor set)
    // and back (resumeSub clears block) — the accumulated counters survive.
    const bot = bringBot(bringCells(), [])
    const o = { kind: 'item', name: 'crafting_table', block: null, subFor: null, felled: 2, replanted: 0 }
    const ctx = { lastGoalKey: '', bring: o }
    bring.done(bot, ctx)
    assert.deepEqual(deficitLines(bot), ['cut 2, replanted 0 — out of saplings'])
    assert.equal(ctx.bring, null)
  })

  it('a refused log sub still confesses its fells', async () => {
    const bot = bringBot(bringCells(), [])
    const o = {
      kind: 'block', block: 'oak_log', drop: 'oak_log', want: 3, have: 1,
      subFor: 'crafting_table', subWant: 3, subWord: 'logs', felled: 1, replanted: 0,
    }
    const ctx = { lastGoalKey: '', bring: o }
    bring.refuse(bot, ctx, 'could not reach oak_log safely')
    assert.ok(bot.lines.some((l) => l.includes('crafting_table')), `parent gap line: ${bot.lines}`)
    assert.deepEqual(deficitLines(bot), ['cut 1, replanted 0 — out of saplings'])
    assert.equal(ctx.bring, null)
  })
})
