'use strict'

// idkcraft-gyw: a failed far gather must release its hold once the body
// relocates, so the menu can pick something feasible again (nearer trees,
// other wood). The atl.4 same-spot replay stays: only relocation releases.
const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const gather = require('../src/behaviours/gather')
const { MENU, goalFacts, decide } = require('../src/goal')
const { goalOptions } = require('../src/goal-options')

function pos(x, y, z) {
  const p = {
    x, y, z,
    distanceTo: (q) => Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z),
    clone() { return pos(p.x, p.y, p.z) },
  }
  return p
}

const LOGREG = { oak_log: 17, birch_log: 18, stone: 1 }

// Every named log tops out as a tree (m7ke: gather refuses protected logs
// at selection): an unnamed cell above a log's column reads one more log,
// then leaves — lone fixture logs stay trees for the guard.
function treeCell(names, x, y, z) {
  const n = names[`${x},${y},${z}`]
  if (n) return n
  const b1 = names[`${x},${y - 1},${z}`]
  if (b1 && b1.endsWith('_log')) return 'oak_log'
  const b2 = names[`${x},${y - 2},${z}`]
  if (!b1 && b2 && b2.endsWith('_log')) return 'oak_leaves'
  return undefined
}

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
      const n = treeCell(names, Math.floor(p.x), Math.floor(p.y), Math.floor(p.z))
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

  it('a searchfar no-trees fail stamps failPos and releases into a fresh scan', () => {
    // Revmux core-1: the far-search fail leaves phase=searchfar; without
    // the phase reset the release would re-enter searchfar with a null
    // cursor and re-fail with no rescan.
    const spots = []
    const names = { '96,64,0': 'stone' } // loaded probe: the staged search starts (atl.5 shape)
    const bot = mockBot({ spots, names })
    const ctx = { lastGoalKey: '', stepStatus: 'running' }
    for (let i = 0; i < 60 && !(ctx.gather && ctx.gather.final); i++) gather(bot, ctx, null, {})
    assert.equal(ctx.stepStatus, 'failed:no-trees')
    assert.equal(ctx.gather.phase, 'searchfar')
    assert.deepEqual(ctx.gather.failPos, { x: 0, y: 64, z: 0 })
    bot.entity.position = pos(100, 64, 0)
    spots.push(pos(102, 64, 0))
    names['102,64,0'] = 'oak_log'
    ctx.stepStatus = 'running' // decide() marks running on every pick
    gather(bot, ctx, null, {})
    assert.equal(ctx.stepStatus, 'running', 'no instant re-fail')
    assert.equal(ctx.gather.final, null, 'latch released')
    assert.match(ctx.lastGoalKey, /^gather:102,64,0$/, 'fresh scan commits')
  })

  it('relocation does not re-chase the struck far trunk (skips survive)', () => {
    // Revmux core-2: the far oak that stranded the bot stays skipped —
    // the retry walks to untried wood, never back to the same crown.
    const bot = mockBot({
      spots: [pos(44, 64, 0), pos(60, 64, 0)],
      names: { '44,64,0': 'oak_log', '60,64,0': 'birch_log' },
      at: pos(45, 64, 0),
    })
    const g = failedGather({ x: 0, y: 64, z: 0 })
    g.skip.add('44,64,0')
    const ctx = { lastGoalKey: '', stepStatus: 'running', gather: g }
    gather(bot, ctx, null, {})
    assert.equal(ctx.stepStatus, 'running')
    assert.ok(ctx.gather.skip.has('44,64,0'), 'struck trunk stays skipped')
    assert.match(ctx.lastGoalKey, /^gather:60,64,0$/, 'untried wood wins')
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

describe('vmzq.65 stranded walk-out for a build order', () => {
  // Owner online (roster-only: player reads far), day, a holding no-trees
  // gather at the current log count.
  function onlineBot() {
    return {
      username: 'IdkBot',
      chats: [],
      entity: { position: pos(0, 64, 0), onGround: true, isInWater: false },
      inventory: { items: () => [] },
      time: { timeOfDay: 6000 },
      health: 20,
      food: 20,
      oxygenLevel: 20,
      spawnPoint: pos(0, 64, 0),
      players: { Steve: {} },
      entities: {},
      registry: { blocksByName: { oak_log: { id: 17 } } },
      blockAt: () => ({ name: 'air', boundingBox: 'empty' }),
      pathfinder: { isMoving: () => false, setGoal() {}, stop() {}, goal: null },
      clearControlStates() {},
      chat(m) { this.chats.push(String(m)) },
    }
  }
  function holdingGather() {
    return { final: 'failed:no-trees', atLogs: 0, failPos: { x: 0, y: 64, z: 0 }, skip: new Set(), streak: 0 }
  }

  it('a build order opens stranded explore with the owner online', () => {
    const bot = goalBot({ at: pos(0, 64, 0) })
    const ctx = { home: { site: pos(0, 64, 0), built: false, v: 2 }, gather: holdingGather() }
    assert.equal(MENU.explore.feasible({ time: 'day', logs: 0, home: 'site', player: 'near' }, bot, ctx), true)
    assert.equal(MENU.explore.feasible({ time: 'day', logs: 0, home: 'site', player: 'far' }, bot, ctx), true)
  })

  it('no site, owner online: the stay-with-the-player veto holds (p4s)', () => {
    const bot = goalBot({ at: pos(0, 64, 0) })
    const ctx = { gather: holdingGather() }
    assert.equal(MENU.explore.feasible({ time: 'day', logs: 0, home: 'none', player: 'near' }, bot, ctx), false)
    assert.equal(MENU.explore.feasible({ time: 'day', logs: 0, home: 'none', player: 'far' }, bot, ctx), false)
    // Anchor-only fixtures (built undefined) stay unbound too.
    const anchorOnly = { home: { site: pos(0, 64, 0) }, gather: holdingGather() }
    assert.equal(MENU.explore.feasible({ time: 'day', logs: 0, home: 'site', player: 'near' }, bot, anchorOnly), false)
  })

  it('the house table offers explore-far for the build order, skips it with no site', () => {
    const bot = onlineBot()
    const ctx = {
      home: { site: pos(0, 64, 0), built: false, v: 2 },
      gather: holdingGather(),
      lastGoalKey: '',
      stepStatus: 'running',
    }
    const skips = []
    const ids = goalOptions(bot, ctx, 'house', skips).map((o) => o.id)
    assert.ok(ids.includes('explore-far'), `explore-far offered: ${ids}`)
    assert.ok(!skips.some((s) => s.id === 'explore-far'), `no explore-far skip: ${JSON.stringify(skips)}`)

    const nosite = { gather: holdingGather(), lastGoalKey: '', stepStatus: 'running' }
    const skips2 = []
    const ids2 = goalOptions(bot, nosite, 'house', skips2).map((o) => o.id)
    assert.ok(!ids2.includes('explore-far'), `explore-far withheld: ${ids2}`)
    assert.ok(skips2.some((s) => s.id === 'explore-far' && /explore not feasible/.test(s.why)), JSON.stringify(skips2))
  })
})
