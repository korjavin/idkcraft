'use strict'

// idkcraft-gyw: a failed far gather must release its hold once the body
// relocates, so the menu can pick something feasible again (nearer trees,
// other wood). The atl.4 same-spot replay stays: only relocation releases.
const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const gather = require('../src/behaviours/gather')
const { MENU, goalFacts, decide } = require('../src/goal')

function pos(x, y, z) {
  const p = {
    x, y, z,
    distanceTo: (q) => Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z),
    clone() { return pos(p.x, p.y, p.z) },
  }
  return p
}

const LOGREG = { oak_log: 17, birch_log: 18, stone: 1 }

function mockBot({ spots = [], names = {}, items = [], at = pos(0, 64, 0), moving = false } = {}) {
  const blocksByName = {}
  for (const [name, id] of Object.entries(LOGREG)) blocksByName[name] = { id }
  const calls = { setGoal: 0 }
  const bot = {
    calls,
    lines: [],
    entity: { position: at },
    registry: { blocksByName },
    _moving: moving,
    _items: items,
    pathfinder: {
      goal: null,
      setGoal: (goal) => { calls.setGoal++; bot.pathfinder.goal = goal },
      isMoving: () => bot._moving,
    },
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
      const n = names[`${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`]
      return n ? { name: n, position: pos(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)) } : null
    },
    canDigBlock: () => true,
    dig: async () => {},
    chat(line) { bot.lines.push(String(line)) },
  }
  return bot
}

function goalBot({ items = [], at = pos(0, 64, 0) } = {}) {
  return {
    chats: [],
    entity: { position: at },
    inventory: { items: () => items },
    time: { timeOfDay: 6000 },
    spawnPoint: pos(0, 64, 0),
    chat(m) { this.chats.push(m) },
  }
}

function failedGather(failPos) {
  return { pos: null, name: 'log', phase: 'walk', skip: new Set(), streak: 3, final: 'failed:unreachable', atLogs: 0, failPos }
}

describe('gyw gather failure records its point', () => {
  it('a real stall-fail stamps failPos at the body', () => {
    // One trunk in reach, the body wedged: 3 crown strikes fail the step.
    const bot = mockBot({ spots: [pos(2, 64, 0)], names: { '2,64,0': 'oak_log' }, moving: true })
    const ctx = { lastGoalKey: '', stepStatus: 'running' }
    for (let i = 0; i < 60 && !(ctx.gather && ctx.gather.final); i++) gather(bot, ctx, null, {})
    assert.equal(ctx.stepStatus, 'failed:unreachable')
    assert.deepEqual(ctx.gather.failPos, { x: 0, y: 64, z: 0 })
  })
})

describe('gyw behaviour latch: same spot replays, relocation retries', () => {
  it('same spot replays the failure with no new goal (atl.4)', () => {
    const bot = mockBot({})
    const ctx = { lastGoalKey: '', stepStatus: 'running', gather: failedGather({ x: 0, y: 64, z: 0 }) }
    gather(bot, ctx, null, {})
    assert.equal(ctx.stepStatus, 'failed:unreachable')
    assert.equal(bot.calls.setGoal, 0, 'no setGoal past final')
  })

  it('relocation past the failure point rescans and walks to nearer trees', () => {
    const bot = mockBot({ spots: [pos(102, 64, 0)], names: { '102,64,0': 'birch_log' }, at: pos(100, 64, 0) })
    // decide() marks running on every pick; the failure latch is the behaviour's own.
    const ctx = { lastGoalKey: '', stepStatus: 'running', gather: failedGather({ x: 0, y: 64, z: 0 }) }
    gather(bot, ctx, null, {})
    assert.equal(ctx.stepStatus, 'running', 'no instant re-fail')
    assert.equal(ctx.gather.final, null, 'latch released')
    assert.match(ctx.lastGoalKey, /^gather:102,64,0$/, 'fresh scan commits the near tree')
  })

  it('a latch without a failure point still holds (legacy ctx)', () => {
    const bot = mockBot({ spots: [pos(102, 64, 0)], names: { '102,64,0': 'birch_log' }, at: pos(100, 64, 0) })
    const g = failedGather(undefined)
    delete g.failPos
    const ctx = { lastGoalKey: '', stepStatus: 'running', gather: g }
    gather(bot, ctx, null, {})
    assert.equal(ctx.stepStatus, 'failed:unreachable')
    assert.equal(bot.calls.setGoal, 0, 'unknown point holds')
  })
})

describe('gyw menu gate: relocation releases gather feasibility', () => {
  const facts = { logs: 0, planks: 0, table: 0, door: 0, home: 'site' }
  const home = { site: pos(10, 64, 10) }

  it('holds at the failure point', () => {
    const bot = goalBot({ at: pos(0, 64, 0) })
    const ctx = { home, gather: failedGather({ x: 0, y: 64, z: 0 }) }
    assert.equal(MENU.gather.feasible(facts, bot, ctx), false)
  })

  it('releases past the failure point with the same log count', () => {
    const bot = goalBot({ at: pos(100, 64, 0) })
    const ctx = { home, gather: failedGather({ x: 0, y: 64, z: 0 }) }
    assert.equal(MENU.gather.feasible(facts, bot, ctx), true)
  })
})

describe('gyw stranded recovery: explore opens pre-build on a holding gather', () => {
  const daySite = { time: 'day', logs: 0, home: 'site', player: 'none' }
  const home = { site: pos(10, 64, 10) }

  it('opens at day while gather holds', () => {
    const bot = goalBot({ at: pos(0, 64, 0) })
    const ctx = { home, gather: failedGather({ x: 0, y: 64, z: 0 }) }
    assert.equal(MENU.explore.feasible(daySite, bot, ctx), true)
  })

  it('stays shut pre-build while gather is fresh', () => {
    const bot = goalBot({ at: pos(0, 64, 0) })
    assert.equal(MENU.explore.feasible(daySite, bot, { home }), false)
  })

  it('stays shut at night even while gather holds', () => {
    const bot = goalBot({ at: pos(0, 64, 0) })
    const ctx = { home, gather: failedGather({ x: 0, y: 64, z: 0 }) }
    assert.equal(MENU.explore.feasible({ ...daySite, time: 'night' }, bot, ctx), false)
  })

  it('stays shut with anyone online even while gather holds (p4s)', () => {
    const bot = goalBot({ at: pos(0, 64, 0) })
    const ctx = { home, gather: failedGather({ x: 0, y: 64, z: 0 }) }
    assert.equal(MENU.explore.feasible({ ...daySite, player: 'near' }, bot, ctx), false)
    assert.equal(MENU.explore.feasible({ ...daySite, player: 'far' }, bot, ctx), false)
    assert.equal(MENU.explore.feasible({ ...daySite, player: 'none' }, bot, ctx), true)
  })

  it('stays open once built (old rule)', () => {
    const bot = goalBot({ at: pos(0, 64, 0) })
    assert.equal(MENU.explore.feasible({ ...daySite, home: 'built' }, bot, { home }), true)
  })

  it('the stranded bot picks explore, not rest', async () => {
    const bot = goalBot({ at: pos(0, 64, 0) })
    const ctx = {
      home: { site: pos(10, 64, 10) },
      step: 'rest',
      stepStatus: 'running',
      goalText: 'stale',
      gather: failedGather({ x: 0, y: 64, z: 0 }),
      brain: {},
    }
    const r = await decide(bot, ctx)
    assert.equal(r.action, 'explore')
  })
})

describe('gyw arbiter: the relocated bot re-picks gather', () => {
  it('rest hands back to gather after relocation (build resumes)', async () => {
    const bot = goalBot({ at: pos(100, 64, 0) })
    const ctx = {
      home: { site: pos(10, 64, 10) },
      step: 'rest',
      stepStatus: 'running',
      goalText: 'stale',
      gather: failedGather({ x: 0, y: 64, z: 0 }),
      brain: {},
    }
    assert.equal(goalFacts(bot, ctx).logs, 0)
    const r = await decide(bot, ctx)
    assert.equal(r.action, 'gather')
    assert.equal(ctx.stepStatus, 'running')
  })

  it('no relocation, no gather re-pick: the stranded bot explores instead', async () => {
    const bot = goalBot({ at: pos(0, 64, 0) })
    const ctx = {
      home: { site: pos(10, 64, 10) },
      step: 'rest',
      stepStatus: 'running',
      goalText: 'stale',
      gather: failedGather({ x: 0, y: 64, z: 0 }),
      brain: {},
    }
    const r = await decide(bot, ctx)
    assert.equal(r.action, 'explore')
  })

  it('at night the stranded bot still rests: pre-house never wanders', async () => {
    const bot = goalBot({ at: pos(0, 64, 0) })
    bot.time = { timeOfDay: 18000 }
    const ctx = {
      home: { site: pos(10, 64, 10) },
      step: 'rest',
      stepStatus: 'running',
      goalText: 'stale',
      gather: failedGather({ x: 0, y: 64, z: 0 }),
      brain: {},
    }
    const r = await decide(bot, ctx)
    assert.equal(r.action, 'rest')
  })
})
