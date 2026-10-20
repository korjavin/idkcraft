'use strict'

// Far walk-out dusk guard (idkcraft-p9lx): a >64-block walk-out started near
// dusk or at night cannot work a load and return before dark — dusk catches
// the bot mid-map and the night is sheltered in the open (deforested-home
// rig: a day creeper kill 127 blocks out and a night shelter kill 134 out,
// 8 deaths, never 14 logs). Far/memory targets past 64 commit only in open
// daylight; a running far walk drops its target at dusk/night so the
// arbiter's gohome/shelter takes over from closer in.

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const gather = require('../src/behaviours/gather')
const resources = require('../src/resources')
const { keyOf } = require('../src/behaviours/scout')

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

const LOGREG = { oak_log: 17, oak_leaves: 18, stone: 1 }

function mockBot({ names = {}, items = [], timeOfDay = null } = {}) {
  const lines = []
  const blocksByName = {}
  for (const [name, id] of Object.entries(LOGREG)) blocksByName[name] = { id }
  const calls = { setGoal: 0, goals: [] }
  const bot = {
    lines,
    calls,
    entity: { position: pos(0, 64, 0) },
    registry: { blocksByName },
    _moving: false,
    _items: items,
    time: typeof timeOfDay === 'number' ? { timeOfDay } : undefined,
    pathfinder: {
      goal: null,
      setGoal: (goal) => { calls.setGoal++; calls.goals.push(goal); bot.pathfinder.goal = goal },
      isMoving: () => bot._moving,
    },
    inventory: { items: () => bot._items },
    findBlocks() { return [] }, // sync 48 empty: the stand is memory/far only
    blockAt(p) {
      if (!p || typeof p.x !== 'number') return null
      const n = names[`${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`]
      if (!n) return null // unloaded, like the real thing
      if (typeof p.floored !== 'function') throw new TypeError('pos.floored is not a function (plain g.pos)')
      return { name: n, position: pos(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)) }
    },
    canDigBlock: () => true,
    dig: async () => {},
    chat(line) { lines.push(String(line)) },
  }
  return bot
}

function freshCtx() {
  return { lastGoalKey: '', stepStatus: 'running' }
}

function farCursor(hit) {
  const hits = new Map()
  hits.set(keyOf(hit), hit)
  return {
    blockName: 'logs',
    ids: [LOGREG.oak_log],
    queue: [],
    at: 0,
    hits,
    origin: { x: 0, y: 64, z: 0 },
    edge: 48, // SEARCH_FIRST: no queue rebuild mid-test
    stageMs: {},
    stageScans: {},
    refY: null,
  }
}

describe('gather far walk-out dusk guard (idkcraft-p9lx)', () => {
  it('far memory stand refused near dusk: no-trees, no walk-out, no stranded record', () => {
    const bot = mockBot({ timeOfDay: 11000 })
    const ctx = freshCtx()
    resources.noteSpots(ctx, [{ x: 120, y: 64, z: 0, name: 'oak_log' }], Date.now())
    gather(bot, ctx, null, {})
    assert.equal(ctx.stepStatus, 'failed:no-trees')
    assert.ok(!bot.lines.some((l) => /^going for /.test(l)), `walk-out line: ${bot.lines}`)
    assert.ok(!ctx.gather.pos, 'no target committed')
    assert.equal(ctx.gather.farEmpty, false, 'refused for time, not an empty search')
  })

  it('far memory stand allowed in the morning', () => {
    const bot = mockBot({ timeOfDay: 6000 })
    const ctx = freshCtx()
    resources.noteSpots(ctx, [{ x: 120, y: 64, z: 0, name: 'oak_log' }], Date.now())
    gather(bot, ctx, null, {})
    assert.equal(ctx.stepStatus, 'running')
    assert.ok(
      bot.lines.some((l) => /^going for oak_log, 120 blocks away$/.test(l)),
      `walk-out line: ${bot.lines}`,
    )
    assert.ok(ctx.gather.pos, 'target committed')
  })

  it('far-search hit refused at night: no-trees, no walk-out', () => {
    const bot = mockBot({ timeOfDay: 18000 })
    const ctx = freshCtx()
    ctx.gather = {
      pos: null, name: 'log', phase: 'searchfar', search: farCursor({ x: 120, y: 64, z: 0 }),
      skip: new Set(), gskip: new Set(), streak: 0, final: null, atLogs: -1,
    }
    gather(bot, ctx, null, {})
    assert.equal(ctx.stepStatus, 'failed:no-trees')
    assert.ok(!bot.lines.some((l) => /^going for /.test(l)), `walk-out line: ${bot.lines}`)
    assert.ok(!ctx.gather.pos, 'no target committed')
    assert.equal(ctx.gather.farEmpty, false, 'refused for time, not an empty search')
  })

  it('far-search hit allowed in the morning', () => {
    const bot = mockBot({ timeOfDay: 1000 })
    const ctx = freshCtx()
    ctx.gather = {
      pos: null, name: 'log', phase: 'searchfar', search: farCursor({ x: 120, y: 64, z: 0 }),
      skip: new Set(), gskip: new Set(), streak: 0, final: null, atLogs: -1,
    }
    gather(bot, ctx, null, {})
    assert.equal(ctx.stepStatus, 'running')
    assert.ok(bot.lines.some((l) => /^going for /.test(l)), `walk-out line: ${bot.lines}`)
    assert.ok(ctx.gather.pos, 'target committed')
  })

  it('running far walk fails out at dusk with 64+ blocks left: goal cleared, gather held', () => {
    const bot = mockBot({ timeOfDay: 12500 })
    const ctx = freshCtx()
    ctx.lastGoalKey = 'gather:120,64,0'
    bot.pathfinder.setGoal({ fake: 'far-walk' }, false)
    ctx.gather = {
      pos: pos(120, 64, 0), name: 'oak_log', phase: 'walk', far: true,
      skip: new Set(), gskip: new Set(), streak: 0, stalls: 0, restalls: 0,
      reissued: false, issuedKey: 'gather:120,64,0', lastPos: { x: 0, y: 64, z: 0 },
      lastFound: [{ x: 120, y: 64, z: 0 }],
    }
    gather(bot, ctx, null, {})
    assert.equal(ctx.gather.pos, null, 'far target dropped')
    assert.equal(ctx.gather.far, false)
    assert.equal(ctx.stepStatus, 'failed:no-trees', 'hold parks gather for gohome/shelter')
    assert.equal(bot.pathfinder.goal, null, 'far goal cleared: the body stops now')
    assert.equal(ctx.gather.farEmpty, false, 'aborted for time, not an empty search')
  })

  it('chained hop refused late: 53 from the body but 133 from the home anchor', () => {
    const bot = mockBot({ timeOfDay: 11000 })
    bot.players = { Steve: {} } // someone online: no alone-idle task leash
    bot.entity.position = pos(80, 64, 0)
    const ctx = freshCtx()
    ctx.home = { site: { x: 0, y: 64, z: 0 }, built: true }
    resources.noteSpots(ctx, [{ x: 133, y: 64, z: 0, name: 'oak_log' }], Date.now())
    gather(bot, ctx, null, {})
    assert.equal(ctx.stepStatus, 'failed:no-trees')
    assert.ok(!bot.lines.some((l) => /^going for /.test(l)), `walk-out line: ${bot.lines}`)
    assert.ok(!ctx.gather.pos, 'no target committed')
    assert.equal(ctx.gather.farEmpty, false, 'refused for time, not leash-filtered')
  })

  it('stand-side walk fails out at dusk: body 100 from home, 10 left to the tree', () => {
    const bot = mockBot({ timeOfDay: 12500 })
    bot.players = { Steve: {} }
    bot.entity.position = pos(100, 64, 0)
    const ctx = freshCtx()
    ctx.home = { site: { x: 0, y: 64, z: 0 }, built: true }
    ctx.gather = {
      pos: pos(110, 64, 0), name: 'oak_log', phase: 'walk', far: false,
      skip: new Set(), gskip: new Set(), streak: 0, stalls: 0, restalls: 0,
      reissued: false, issuedKey: null, lastPos: { x: 100, y: 64, z: 0 },
      lastFound: [{ x: 110, y: 64, z: 0 }],
    }
    gather(bot, ctx, null, {})
    assert.equal(ctx.stepStatus, 'failed:no-trees', 'body past 64 fails out even near the tree')
    assert.equal(bot.pathfinder.goal, null, 'goal cleared')
  })

  it('nearly-there far walk continues at dusk with 64 or less left', () => {
    const bot = mockBot({ timeOfDay: 12500 })
    bot.entity.position = pos(100, 64, 0) // 20 left of the 120 stand
    const ctx = freshCtx()
    ctx.gather = {
      pos: pos(120, 64, 0), name: 'oak_log', phase: 'walk', far: true,
      skip: new Set(), gskip: new Set(), streak: 0, stalls: 0, restalls: 0,
      reissued: false, issuedKey: null, lastPos: { x: 100, y: 64, z: 0 },
      lastFound: [{ x: 120, y: 64, z: 0 }],
    }
    gather(bot, ctx, null, {})
    assert.ok(ctx.gather.pos, 'target kept')
    assert.equal(bot.calls.setGoal, 1, 'walk re-issued to the stand')
  })

  it('no clock reads as open daylight (fail-open, the old behaviour)', () => {
    const bot = mockBot() // no time field, like the older mocks
    const ctx = freshCtx()
    resources.noteSpots(ctx, [{ x: 120, y: 64, z: 0, name: 'oak_log' }], Date.now())
    gather(bot, ctx, null, {})
    assert.equal(ctx.stepStatus, 'running')
    assert.ok(bot.lines.some((l) => /^going for oak_log, 120 blocks away$/.test(l)))
  })
})
