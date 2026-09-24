'use strict'

// Forage step (idkcraft-atl.2): best remembered find first, batch haul,
// ghosts forgotten, no stuck facts.

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const forage = require('../src/behaviours/forage')
const resources = require('../src/resources')

function pos(x, y, z) {
  return {
    x, y, z,
    distanceTo: (q) => Math.hypot(x - q.x, y - q.y, z - q.z),
    clone() { return pos(x, y, z) },
  }
}

function mockBot() {
  const inv = []
  const calls = { setGoal: 0, goals: [], digs: 0 }
  const chats = []
  const bot = {
    calls, chats, inv,
    username: 'IdkBot', players: {}, entities: {},
    spawnPoint: pos(0, 64, 0),
    entity: { position: pos(0, 64, 0), onGround: true },
    _moving: false,
    blocks: {},
    registry: { blocksByName: { iron_ore: { id: 1 }, oak_log: { id: 2 }, coal_ore: { id: 3 }, diamond_ore: { id: 4 } }, itemsByName: {} },
    pathfinder: {
      goal: null,
      setGoal: (g) => { calls.setGoal++; calls.goals.push(g && g.constructor && g.constructor.name); bot.pathfinder.goal = g },
      isMoving: () => bot._moving,
      bestHarvestTool: () => null,
    },
    inventory: { items: () => inv },
    findBlocks: () => [],
    blockAt: (p) => {
      const n = bot.blocks[`${Math.round(p.x)},${Math.round(p.y)},${Math.round(p.z)}`]
      return n ? { name: n } : { name: 'stone' }
    },
    canDigBlock: () => true,
    dig: async (block) => { calls.digs++ },
    chat: (m) => { chats.push(String(m)) },
  }
  return bot
}

function memCtx(cells) {
  const ctx = { lastGoalKey: '', stepStatus: 'running' }
  resources.noteSpots(ctx, cells, 1000)
  return ctx
}

const tick = () => new Promise((r) => setImmediate(r))

describe('planForage', () => {
  it('picks value over distance: far iron beats near coal and nearer logs', () => {
    const bot = mockBot()
    bot.inv.push({ name: 'stone_pickaxe', count: 1 })
    const ctx = memCtx([
      { x: 100, y: 60, z: 0, name: 'iron_ore' },
      { x: 5, y: 60, z: 0, name: 'coal_ore' },
      { x: 2, y: 64, z: 0, name: 'oak_log' },
    ])
    const p = forage.planForage(bot, ctx)
    assert.equal(p.kind, 'ore')
    assert.equal(p.name, 'iron_ore')
    assert.equal(p.drop, 'raw_iron')
  })

  it('skips ore without the right pickaxe, falls back to logs', () => {
    const bot = mockBot() // no pickaxe
    const ctx = memCtx([
      { x: 5, y: 60, z: 0, name: 'iron_ore' },
      { x: 2, y: 64, z: 0, name: 'oak_log' },
    ])
    const p = forage.planForage(bot, ctx)
    assert.equal(p.kind, 'log')
    assert.equal(p.name, 'oak_log')
  })

  it('diamond outranks iron at any distance', () => {
    const bot = mockBot()
    bot.inv.push({ name: 'iron_pickaxe', count: 1 })
    const ctx = memCtx([
      { x: 3, y: 60, z: 0, name: 'iron_ore' },
      { x: 90, y: 50, z: 0, name: 'diamond_ore' },
    ])
    const p = forage.planForage(bot, ctx)
    assert.equal(p.name, 'diamond_ore')
  })

  it('null with empty memory and no animals: explore owns that', () => {
    const bot = mockBot()
    const ctx = memCtx([])
    assert.equal(forage.planForage(bot, ctx), null)
  })

  it('food fallback: passive animal when nothing diggable is remembered', () => {
    const bot = mockBot()
    const ctx = memCtx([])
    bot.entities = { 7: { id: 7, name: 'cow', position: pos(10, 64, 0), isValid: true } }
    const p = forage.planForage(bot, ctx)
    assert.equal(p.kind, 'food')
    assert.equal(p.drop, 'beef')
  })
})

describe('forage behaviour', () => {
  it('walks, digs a batch of 8 and banks the haul', async () => {
    const bot = mockBot()
    bot.inv.push({ name: 'stone_pickaxe', count: 1 })
    const cells = []
    for (let i = 0; i < 8; i++) {
      cells.push({ x: 10 + i * 2, y: 60, z: 0, name: 'iron_ore' })
      bot.blocks[`${10 + i * 2},60,0`] = 'iron_ore'
    }
    const ctx = memCtx(cells)
    bot.dig = async (block) => {
      bot.calls.digs++
      bot.inv.push({ name: 'raw_iron', count: 1 })
    }
    for (let i = 0; i < 200 && !ctx.stepStatus.startsWith('done') && !ctx.stepStatus.startsWith('failed:'); i++) {
      forage(bot, ctx, null, {})
      await tick()
    }
    assert.equal(ctx.stepStatus, 'done')
    assert.deepEqual(ctx.haul, { raw_iron: 8 })
    assert.ok(bot.calls.goals.includes('GoalNear'))
    assert.ok(bot.calls.goals.includes('GoalBlock'))
    assert.ok(bot.chats.some((m) => m.startsWith('foraging:')))
  })

  it('ghost cell is forgotten and the next plan runs, no stuck fact', () => {
    const bot = mockBot()
    bot.inv.push({ name: 'stone_pickaxe', count: 1 })
    const ctx = memCtx([
      { x: 5, y: 60, z: 0, name: 'iron_ore' }, // ghost: stone underneath
      { x: 30, y: 60, z: 0, name: 'coal_ore' },
    ])
    bot.blocks['30,60,0'] = 'coal_ore'
    forage(bot, ctx, null, {}) // plan ghost, issue walk
    bot.entity.position = pos(5, 64, 0)
    bot._moving = false
    forage(bot, ctx, null, {}) // settle: ghost -> forget + replan
    assert.equal(resources.count(ctx), 1)
    assert.equal(ctx.stuck, undefined)
    assert.deepEqual(ctx.forage.target.name, 'coal_ore')
  })

  it('ten still ticks strike the cell and fail unreachable with an empty haul', () => {
    // Contract change (reviewer atl.2): a stall-out is one strike on the
    // point — skip it, memory intact — not a forget (forget flips known and
    // defeats the atl.4 hold, looping forage->explore->forage on rescan).
    const bot = mockBot()
    bot.inv.push({ name: 'stone_pickaxe', count: 1 })
    const ctx = memCtx([{ x: 40, y: 60, z: 0, name: 'iron_ore' }])
    bot.blocks['40,60,0'] = 'iron_ore'
    bot._moving = true // executor claims motion, body stands still
    for (let i = 0; i < 14; i++) forage(bot, ctx, null, {})
    assert.equal(ctx.stepStatus, 'failed:unreachable')
    assert.ok(ctx.forageSkip && ctx.forageSkip.has('40,60,0'))
    assert.equal(resources.count(ctx), 1)
    assert.equal(ctx.stuck, undefined)
    assert.deepEqual(ctx.haul, {})
  })

  it('registers in BEHAVIOURS under forage', () => {
    const { BEHAVIOURS } = require('../src/index')
    assert.equal(BEHAVIOURS.forage, forage)
  })
})

describe('unreachable memory point (reviewer atl.2: strike, never loop)', () => {
  const { decide } = require('../src/goal')
  const CELL = { x: 50, y: 60, z: 0, name: 'oak_log' }

  // Deep-ore fake: the cell is remembered but never loads, never diggable,
  // the body never moves — the live iron-ore trap in miniature.
  function deepBot() {
    const bot = mockBot()
    bot.blockAt = () => null
    bot.canDigBlock = () => false
    bot.entity.position = pos(0, 64, 0)
    bot.time = { timeOfDay: 6000 }
    return bot
  }
  function deepCtx() {
    const ctx = { lastGoalKey: '', home: { built: true }, brain: null, step: null, stepStatus: null }
    resources.noteSpots(ctx, [CELL], 1000)
    return ctx
  }
  async function runStep(bot, ctx, cap) {
    for (let i = 0; i < (cap || 40); i++) {
      forage(bot, ctx, null, {})
      await tick()
      const s = ctx.stepStatus
      if (typeof s === 'string' && (s === 'done' || s.startsWith('failed:'))) return s
    }
    return ctx.stepStatus
  }

  it('explore rescan does not revive a struck point: <=3 forage picks, then explore', async () => {
    const bot = deepBot()
    const ctx = deepCtx()
    let foragePicks = 0
    let last = null
    for (let c = 0; c < 10; c++) {
      const r = await decide(bot, ctx)
      last = r.action
      if (r.action === 'forage') {
        foragePicks++
        await runStep(bot, ctx)
      } else {
        resources.noteSpots(ctx, [CELL], 2000 + c) // explore arrival scan re-adds the deep ore
      }
    }
    assert.ok(foragePicks <= 3, `forage re-picked ${foragePicks}x to the same dead point`)
    assert.equal(last, 'explore') // honest switch, not a silent rest
    assert.ok(ctx.stepFail && ctx.stepFail.forage, 'stepFail recorded for forage')
    assert.equal(ctx.stepFail.forage.status, 'failed:unreachable')
    assert.ok(ctx.forageSkip && ctx.forageSkip.has('50,60,0'), 'the point was skipped, not forgotten')
    assert.equal(resources.count(ctx), 1, 'memory intact across strikes and rescans')
  })

  it('noPath on the live goal strikes at once, memory intact', async () => {
    const bot = deepBot()
    const ctx = deepCtx()
    forage(bot, ctx, null, {}) // plan + issue the walk goal
    ctx.lastPathStatus = 'noPath' // pathfinder verdict on the live goal
    const end = await runStep(bot, ctx, 6)
    assert.equal(end, 'failed:unreachable')
    assert.equal(resources.count(ctx), 1)
    assert.deepEqual(ctx.haul, {})
    assert.equal(ctx.stuck, undefined)
  })

  it('a skipped cell loses to the next one: replan takes another point', () => {
    const bot = deepBot()
    bot.inv.push({ name: 'stone_pickaxe', count: 1 })
    const ctx = deepCtx()
    resources.noteSpots(ctx, [{ x: 8, y: 64, z: 0, name: 'coal_ore' }], 1001)
    ctx.forageSkip = new Set(['50,60,0'])
    const p = forage.planForage(bot, ctx)
    assert.equal(p.name, 'coal_ore')
  })
})
