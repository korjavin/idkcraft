'use strict'

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const gather = require('../src/behaviours/gather')
const { NEED_LOGS } = require('../src/goal')

function pos(x, y, z) {
  const p = {
    x, y, z,
    distanceTo: (q) => Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z),
    clone() { return pos(p.x, p.y, p.z) },
  }
  return p
}

const LOGREG = { oak_log: 17, birch_log: 18, stone: 1 }

// registry: { name: id }, spots: [pos], names: { 'x,y,z': blockName }
function mockBot({ registry = LOGREG, spots = [], names = {}, items = [] } = {}) {
  const lines = []
  const blocksByName = {}
  for (const [name, id] of Object.entries(registry)) blocksByName[name] = { id }
  const calls = { setGoal: 0, goals: [] }
  const bot = {
    lines,
    calls,
    entity: { position: pos(0, 64, 0) },
    registry: { blocksByName },
    _moving: false,
    _items: items,
    digCalls: 0,
    pathfinder: {
      goal: null,
      setGoal: (goal, dynamic) => { calls.setGoal++; calls.goals.push(goal); bot.pathfinder.goal = goal },
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
      const n = names[`${p.x},${p.y},${p.z}`]
      return n ? { name: n } : null
    },
    canDigBlock: () => true,
    dig: async () => { bot.digCalls++ },
    chat(line) { lines.push(String(line)) },
  }
  return bot
}

function freshCtx() {
  return { lastGoalKey: '', stepStatus: 'running' }
}

describe('gather step', () => {
  it('(a) finds the nearest log and issues a working GoalNear', () => {
    const bot = mockBot({
      spots: [pos(8, 64, 0), pos(2, 64, 0)],
      names: { '8,64,0': 'oak_log', '2,64,0': 'birch_log' },
    })
    const ctx = freshCtx()
    gather(bot, ctx, null, {})
    assert.equal(bot.calls.setGoal, 1)
    assert.equal(bot.calls.goals[0].constructor.name, 'GoalNear')
    // Regression: GoalBreakBlock.isEnd throws in pathfinder 2.4.5 and would
    // crash-loop the process on the first executor tick. The issued goal
    // must answer isEnd on a plain node without throwing.
    assert.equal(typeof bot.calls.goals[0].isEnd({ x: 0, y: 64, z: 0 }), 'boolean')
    assert.match(ctx.lastGoalKey, /^gather:2,64,0$/)
    assert.equal(ctx.stepStatus, 'running')
  })

  it('(b) digs exactly once while the dig is in flight', async () => {
    let release = null
    const bot = mockBot({
      spots: [pos(2, 64, 0)],
      names: { '2,64,0': 'oak_log' },
    })
    bot.dig = () => new Promise((resolve) => { release = resolve; bot.digCalls++ })
    const ctx = freshCtx()
    gather(bot, ctx, null, {}) // search + GoalBreakBlock
    assert.equal(bot.digCalls, 0)
    bot._moving = false // executor arrived
    gather(bot, ctx, null, {}) // -> dig phase, dig starts
    assert.equal(bot.digCalls, 1)
    gather(bot, ctx, null, {}) // still in flight: no second dig
    gather(bot, ctx, null, {})
    assert.equal(bot.digCalls, 1) // fails if dig runs every tick
    release()
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(ctx.gather.phase, 'pickup')
  })

  it('(c) after the dig walks onto the drop with GoalBlock', async () => {
    const bot = mockBot({
      spots: [pos(2, 64, 0)],
      names: { '2,64,0': 'oak_log' },
    })
    const ctx = freshCtx()
    gather(bot, ctx, null, {})
    gather(bot, ctx, null, {}) // dig starts (mock dig resolves at once)
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(ctx.gather.phase, 'pickup')
    const n = bot.calls.setGoal
    gather(bot, ctx, null, {}) // pickup goal
    assert.equal(bot.calls.setGoal, n + 1)
    assert.equal(bot.calls.goals[bot.calls.goals.length - 1].constructor.name, 'GoalBlock')
  })

  it('(d) done at NEED_LOGS with one chat line', () => {
    const bot = mockBot({ items: [{ name: 'oak_log', count: NEED_LOGS }] })
    const ctx = freshCtx()
    gather(bot, ctx, null, {})
    assert.equal(ctx.stepStatus, 'done')
    assert.deepEqual(bot.lines, [`got ${NEED_LOGS} logs`])
    gather(bot, ctx, null, {})
    assert.deepEqual(bot.lines, [`got ${NEED_LOGS} logs`]) // stays done, chats once
  })

  it('(atl.5) empty 48 with a remembered log at 90: walks to memory, not final', () => {
    // Session 2026-09-24: trees past 48 read as 'no trees within 48 blocks'.
    // A resources-memory log must become the next target before any final.
    const bot = mockBot({ spots: [], names: { '90,64,0': 'oak_log' } })
    const ctx = freshCtx()
    ctx.resources = { items: new Map([['90,64,0', { x: 90, y: 64, z: 0, name: 'oak_log', at: 1 }]]) }
    gather(bot, ctx, null, {})
    assert.equal(ctx.stepStatus, 'running')
    assert.match(ctx.lastGoalKey, /^gather:90,64,0$/)
    assert.ok(!bot.lines.some((l) => l.includes('48 blocks')), `lines: ${bot.lines}`)
  })

  it('(atl.5) empty 48 and empty memory with a log at 100 in loaded chunks: far search walks there', () => {
    // No memory: the amb staged search (96 shell) must find it before final.
    const bot = mockBot({
      spots: [pos(100, 64, 0)],
      names: { '48,64,0': 'stone', '96,64,0': 'stone', '100,64,0': 'oak_log' },
    })
    const rawFind = bot.findBlocks.bind(bot)
    bot.findBlocks = (opts) => {
      const origin = opts.point || bot.entity.position
      const maxD = typeof opts.maxDistance === 'number' ? opts.maxDistance : Infinity
      return rawFind(opts).filter((q) => Math.hypot(q.x - origin.x, q.y - origin.y, q.z - origin.z) <= maxD)
    }
    const ctx = freshCtx()
    for (let i = 0; i < 10 && !/^gather:100,64,0$/.test(ctx.lastGoalKey); i++) gather(bot, ctx, null, {})
    assert.match(ctx.lastGoalKey, /^gather:100,64,0$/)
    assert.equal(ctx.stepStatus, 'running')
  })

  it('(atl.5) a stale memory point is skipped once, search still ends in final', () => {
    // The remembered log is already gone (loaded chunk reads air): re-taking
    // it forever would hang the step — it must join skip and the search must
    // conclude.
    const bot = mockBot({ spots: [], names: { '90,64,0': 'air' } })
    const ctx = freshCtx()
    ctx.resources = { items: new Map([['90,64,0', { x: 90, y: 64, z: 0, name: 'oak_log', at: 1 }]]) }
    for (let i = 0; i < 10; i++) gather(bot, ctx, null, {})
    assert.ok(ctx.gather.skip.has('90,64,0'), `skip: ${[...ctx.gather.skip]}`)
    assert.equal(ctx.stepStatus, 'failed:no-trees')
  })

  it('(atl.5) a remembered log in an unloaded chunk keeps the walk, never skip', () => {
    // Memory's value is trees past view: blockAt null means unloaded, not
    // chopped. The bot must hold the goal and stay running, not skip+final.
    const bot = mockBot({ spots: [], names: { '90,64,0': 'oak_log' } })
    bot.blockAt = () => null // nothing loaded, not even the memory point
    bot.canDigBlock = (b) => !!b // like the real one: nothing diggable unloaded
    const ctx = freshCtx()
    ctx.resources = { items: new Map([['90,64,0', { x: 90, y: 64, z: 0, name: 'oak_log', at: 1 }]]) }
    for (let i = 0; i < 5; i++) gather(bot, ctx, null, {})
    assert.match(ctx.lastGoalKey, /^gather:90,64,0$/)
    assert.ok(!ctx.gather.skip.has('90,64,0'), `skip: ${[...ctx.gather.skip]}`)
    assert.equal(ctx.stepStatus, 'running')
  })

  it('(atl.5) a skipped trunk at 40 does not hide a reachable log at 100', () => {
    // The bead's own case: in-48 trees unreachable, a far tree reachable.
    // The staged search must exclude skipped/in-48 hits, not end on them.
    const bot = mockBot({
      spots: [pos(40, 64, 0), pos(100, 64, 0)],
      names: {
        '40,64,0': 'oak_log', '41,64,0': 'air',
        '48,64,0': 'stone', '96,64,0': 'stone', '100,64,0': 'oak_log',
      },
    })
    bot._moving = true // wedged executor: the 40-trunk stalls and is skipped
    const rawFind = bot.findBlocks.bind(bot)
    bot.findBlocks = (opts) => {
      const origin = opts.point || bot.entity.position
      const maxD = typeof opts.maxDistance === 'number' ? opts.maxDistance : Infinity
      return rawFind(opts).filter((q) => Math.hypot(q.x - origin.x, q.y - origin.y, q.z - origin.z) <= maxD)
    }
    const ctx = freshCtx()
    for (let i = 0; i < 30 && !/^gather:100,64,0$/.test(ctx.lastGoalKey); i++) gather(bot, ctx, null, {})
    assert.match(ctx.lastGoalKey, /^gather:100,64,0$/)
    assert.equal(ctx.stepStatus, 'running')
  })

  it('(e) no trees: failed:no-trees with one chat line', () => {
    const bot = mockBot({ spots: [] })
    const ctx = freshCtx()
    gather(bot, ctx, null, {})
    assert.equal(ctx.stepStatus, 'failed:no-trees')
    assert.deepEqual(bot.lines, ['no trees within 48 blocks'])
    gather(bot, ctx, null, {})
    gather(bot, ctx, null, {})
    assert.deepEqual(bot.lines, ['no trees within 48 blocks']) // once, not per tick
  })

  it('(f) no displacement for N ticks: tree skipped, next tree searched', () => {
    const bot = mockBot({
      spots: [pos(2, 64, 0), pos(6, 64, 0)],
      names: { '2,64,0': 'oak_log', '6,64,0': 'birch_log' },
    })
    bot._moving = true // wedged executor: claims moving, body static
    const ctx = freshCtx()
    gather(bot, ctx, null, {}) // goal on tree 1
    for (let i = 0; i < 10; i++) gather(bot, ctx, null, {})
    assert.ok(ctx.gather.skip.has('2,64,0'))
    assert.equal(ctx.stepStatus, 'running')
    const n = bot.calls.setGoal
    gather(bot, ctx, null, {}) // new search skips tree 1
    assert.equal(bot.calls.setGoal, n + 1)
    assert.match(ctx.lastGoalKey, /^gather:6,64,0$/)
  })

  it('one stalled trunk spends one strike: mates skipped together', () => {
    const names = {
      '2,64,0': 'oak_log', '2,65,0': 'oak_log', '2,66,0': 'oak_log',
      '8,64,0': 'birch_log',
    }
    const bot = mockBot({
      spots: [pos(2, 64, 0), pos(2, 65, 0), pos(2, 66, 0), pos(8, 64, 0)],
      names,
    })
    bot._moving = true // wedged: body static
    const ctx = freshCtx()
    gather(bot, ctx, null, {}) // goal on the trunk base
    assert.match(ctx.lastGoalKey, /^gather:2,64,0$/)
    for (let i = 0; i < 10; i++) gather(bot, ctx, null, {})
    assert.deepEqual([...ctx.gather.skip].sort(), ['2,64,0', '2,65,0', '2,66,0'])
    assert.equal(ctx.gather.streak, 1)
    assert.equal(ctx.stepStatus, 'running')
    gather(bot, ctx, null, {}) // next search moves to the second tree
    assert.match(ctx.lastGoalKey, /^gather:8,64,0$/)
  })

  it('three skipped trees in a row: failed:unreachable, chat once', () => {
    const bot = mockBot({
      spots: [pos(2, 64, 0), pos(6, 64, 0), pos(9, 64, 0)],
      names: { '2,64,0': 'oak_log', '6,64,0': 'oak_log', '9,64,0': 'oak_log' },
    })
    bot._moving = true
    const ctx = freshCtx()
    for (let i = 0; i < 40; i++) gather(bot, ctx, null, {})
    assert.equal(ctx.stepStatus, 'failed:unreachable')
    assert.deepEqual(bot.lines, ['cannot reach the trees'])
  })

  it('a vanished block (chopped by someone else) triggers a new search', () => {
    const names = { '2,64,0': 'oak_log', '6,64,0': 'birch_log' }
    const bot = mockBot({ spots: [pos(2, 64, 0), pos(6, 64, 0)], names })
    const ctx = freshCtx()
    gather(bot, ctx, null, {}) // goal on tree 1
    assert.match(ctx.lastGoalKey, /^gather:2,64,0$/)
    names['2,64,0'] = 'air' // someone else chopped it: reads back as air
    bot._moving = false
    gather(bot, ctx, null, {}) // block gone -> forget it
    gather(bot, ctx, null, {}) // search again
    assert.match(ctx.lastGoalKey, /^gather:6,64,0$/)
    assert.equal(ctx.stepStatus, 'running')
  })

  it('progress timer spans the whole step, not each target', () => {
    const bot = mockBot({
      spots: [pos(2, 64, 0)],
      names: { '2,64,0': 'oak_log' },
      items: [{ name: 'oak_log', count: 1 }],
    })
    const ctx = freshCtx()
    // Step started 20 s ago: the first search tick already reports progress.
    ctx.gather = { pos: null, name: 'log', phase: 'walk', skip: new Set(), streak: 0, final: null, atLogs: -1, lastProgressAt: Date.now() - 20000 }
    gather(bot, ctx, null, {})
    assert.deepEqual(bot.lines, ['chopping oak_log 1/14'])
    gather(bot, ctx, null, {})
    assert.deepEqual(bot.lines, ['chopping oak_log 1/14']) // timer restarted: silent again
  })

  it('tower jumps in place do not count as displacement', () => {
    // yvi: the executor pillars (y 64<->65.2, x/z fixed). The old 3D hypot
    // saw dy ~1.2 > MOVE_TOLERANCE every tick, so stalls never reached
    // STALL_TICKS and one tree burned ~4.5 min instead of ~10 s.
    const bot = mockBot({
      spots: [pos(2, 64, 0), pos(6, 64, 0)],
      names: { '2,64,0': 'oak_log', '6,64,0': 'birch_log' },
    })
    bot._moving = true // wedged executor: claims moving, body jumping in place
    bot.entity.position = pos(0, 64, 5)
    const ctx = freshCtx()
    gather(bot, ctx, null, {}) // goal on tree 1
    for (let i = 1; i <= 11; i++) {
      bot.entity.position = pos(0, i % 2 ? 65.2 : 64, 5)
      bot.entity.onGround = !(i % 2)
      gather(bot, ctx, null, {})
    }
    assert.ok(ctx.gather.skip.has('2,64,0'), 'jump in place = standing still')
  })

  it('a grounded climb to a new level counts as progress', () => {
    // Genuine pillaring (x/z fixed, standing one block higher each tick)
    // must not burn stalls: only jumps in place are standing still.
    const bot = mockBot({
      spots: [pos(2, 64, 0), pos(6, 64, 0)],
      names: { '2,64,0': 'oak_log', '6,64,0': 'birch_log' },
    })
    bot._moving = true
    bot.entity.position = pos(0, 64, 5)
    const ctx = freshCtx()
    gather(bot, ctx, null, {}) // goal on tree 1
    for (let i = 0; i <= 10; i++) {
      bot.entity.position = pos(0, 64 + i, 5)
      bot.entity.onGround = true
      gather(bot, ctx, null, {})
    }
    assert.ok(!ctx.gather.skip.has('2,64,0'), 'climbing is progress, not a stall')
  })

  it('setPathReset counts consecutive place_error, breaks on other reasons', () => {
    const { createTicker } = require('../src/index')
    const bot = mockBot({})
    const ticker = createTicker({
      bot,
      brain: { decide: async () => ({ action: 'idle', sprint: false, source: 'stub' }) },
      tickMs: 10,
      idleTickMs: 10,
    })
    ticker.setPathReset('place_error')
    ticker.setPathReset('place_error')
    assert.equal(bot._tickerCtx.placeErrors, 2)
    ticker.setPathReset('stuck') // any other reason breaks the streak
    assert.equal(bot._tickerCtx.placeErrors, 0)
    assert.equal(bot._tickerCtx.stuckResets, 1)
  })

  it('place_error loop with tower jumps: columns skipped, then failed with goal cleared', () => {
    // yvi acceptance: upper-log columns, path_reset place_error every tick,
    // body jumping in place. Columns must skip fast and the dead goal must go.
    const names = {}
    const spots = []
    for (const cx of [2, 6, 9]) {
      for (const cy of [64, 65]) {
        names[`${cx},${cy},0`] = 'oak_log'
        spots.push(pos(cx, cy, 0))
      }
    }
    const bot = mockBot({ spots, names })
    bot._moving = true
    const { createTicker } = require('../src/index')
    const ticker = createTicker({
      bot,
      brain: { decide: async () => ({ action: 'idle', sprint: false, source: 'stub' }) },
      tickMs: 10,
      idleTickMs: 10,
    })
    const ctx = bot._tickerCtx
    let ticks = 0
    const tick = () => {
      bot.entity.position = pos(0, ticks % 2 ? 65.2 : 64, 5)
      bot.entity.onGround = !(ticks % 2)
      ticks++
      ticker.setPathReset('place_error') // what the ticker does on path_reset
      gather(bot, ctx, null, {})
    }
    for (let i = 0; i < 4; i++) tick()
    assert.ok(ctx.gather.skip.has('2,64,0') && ctx.gather.skip.has('2,65,0'),
      'place_error streak skips the column before STALL_TICKS')
    for (let i = 0; i < 8; i++) tick()
    assert.ok(ctx.gather.skip.has('2,64,0') && ctx.gather.skip.has('2,65,0'),
      'first column skipped within STALL_TICKS+2 despite jumps')
    for (let i = 0; i < 24; i++) tick()
    assert.equal(ctx.stepStatus, 'failed:unreachable')
    assert.deepEqual(bot.lines, ['cannot reach the trees'])
    assert.equal(bot.pathfinder.goal, null)
    const n = bot.calls.setGoal
    for (let i = 0; i < 5; i++) tick()
    assert.equal(bot.calls.setGoal, n, 'no setGoal past final')
    assert.equal(bot.pathfinder.goal, null)
  })

  it('tick-level yvi: place_error streaks skip columns, no backstop hijack, fact at final', async () => {
    // M1 regression: the ticker place_error backstop must not preempt
    // gather's own column skip (endless ask-episodes on one trunk). Drives
    // real ticker.tick() in work mode: skips happen locally, the stuck fact
    // raises only at the unreachable final, with by=gather (not place_error).
    const names = {}
    const spots = []
    for (const cx of [2, 6, 9]) {
      for (const cy of [64, 65]) {
        names[`${cx},${cy},0`] = 'oak_log'
        spots.push(pos(cx, cy, 0))
      }
    }
    const bot = mockBot({ spots, names })
    bot.entities = {}
    bot.username = 'IdkBot'
    bot.players = { Steve: { username: 'Steve' } } // roster online, target unseen
    bot._moving = true
    const { createTicker } = require('../src/index')
    const ticker = createTicker({
      bot,
      brain: { decide: async () => ({ action: 'idle', sprint: false, source: 'stub' }) },
      tickMs: 10,
      idleTickMs: 10,
    })
    const ctx = bot._tickerCtx
    ctx.work = true // work mode: the goal arbiter dispatches gather
    let ticks = 0
    const tick = async () => {
      bot.entity.position = pos(0, ticks % 2 ? 65.2 : 64, 5)
      bot.entity.onGround = !(ticks % 2)
      ticks++
      ticker.setPathReset('place_error') // what the ticker does on path_reset
      await ticker.tick()
    }
    for (let i = 0; i < 4; i++) await tick()
    assert.ok(ctx.gather && ctx.gather.skip.has('2,64,0') && ctx.gather.skip.has('2,65,0'),
      'place_error streak skips the column through the ticker')
    assert.equal(ctx.stuck, null, 'no backstop episode while gather owns the streak')
    for (let i = 0; i < 32 && ctx.stepStatus !== 'failed:unreachable'; i++) await tick()
    assert.equal(ctx.stepStatus, 'failed:unreachable')
    assert.ok(bot.lines.includes('cannot reach the trees'))
    // Asserted on the final tick, not N ticks later: the episode this fact
    // opens ends (gave-up) and clears it, so a later read pins how long the
    // escape takes — not who raised the fact. What matters here is the
    // attribution: by=gather from the detector, not the ticker backstop.
    assert.equal(ctx.stuck && ctx.stuck.by, 'gather', 'fact raised by the detector, not the backstop')
  })

  it('registers in BEHAVIOURS under gather (one line in index.js)', () => {
    const { BEHAVIOURS } = require('../src/index')
    assert.equal(BEHAVIOURS.gather, gather)
  })

  it("'go work' clears a stale gather failure so the step retries", () => {
    const { createTicker } = require('../src/index')
    const bot = mockBot({
      spots: [pos(2, 64, 0)],
      names: { '2,64,0': 'oak_log' },
    })
    const ticker = createTicker({
      bot,
      brain: { decide: async () => ({ action: 'idle', sprint: false, source: 'stub' }) },
      tickMs: 10,
      idleTickMs: 10,
    })
    bot._tickerCtx.gather = { final: 'failed:no-trees', atLogs: 0 }
    ticker.work() // explicit order retries: stale failure forgotten
    assert.equal(bot._tickerCtx.gather, null)
  })
})

describe('stuck-detector blind spots (idkcraft-68p)', () => {
  it('a fight tick every 3rd call still skips the tree within STALL_TICKS walk ticks', () => {
    // 68p acceptance: motionless body, fight steals the body (flips
    // lastGoalKey) every 3rd tick. Today the stalls reset each time and the
    // tree never skips; with the fix the walk continues across the theft.
    const bot = mockBot({ spots: [pos(10, 64, 0)], names: { '10,64,0': 'oak_log' } })
    bot._moving = true // walking, body stands still
    const { createTicker } = require('../src/index')
    const ticker = createTicker({
      bot,
      brain: { decide: async () => ({ action: 'idle', sprint: false, source: 'stub' }) },
      tickMs: 10,
      idleTickMs: 10,
    })
    const ctx = bot._tickerCtx
    gather(bot, ctx, null, {}) // issues the walk goal
    let skippedAt = -1
    for (let i = 1; i <= 10; i++) {
      if (i % 3 === 0) ctx.lastGoalKey = 'fight:9' // fight owned this tick
      gather(bot, ctx, null, {})
      if (ctx.gather.skip.has('10,64,0')) { skippedAt = i; break }
    }
    assert.equal(skippedAt, 10)
  })

  it('chopping line repeats only when the count grows', () => {
    const bot = mockBot({
      spots: [pos(2, 64, 0)],
      names: { '2,64,0': 'oak_log' },
      items: [{ name: 'oak_log', count: 1 }],
    })
    const ctx = freshCtx()
    ctx.gather = { pos: null, name: 'log', phase: 'walk', skip: new Set(), streak: 0, final: null, atLogs: -1, lastProgressAt: Date.now() - 20000, progressLogs: -1 }
    gather(bot, ctx, null, {})
    assert.deepEqual(bot.lines, ['chopping oak_log 1/14'])
    ctx.gather.lastProgressAt = Date.now() - 20000 // interval elapsed, same count
    gather(bot, ctx, null, {})
    assert.deepEqual(bot.lines, ['chopping oak_log 1/14']) // no repeat without growth
    bot._items[0].count = 2
    ctx.gather.lastProgressAt = Date.now() - 20000
    gather(bot, ctx, null, {})
    assert.deepEqual(bot.lines, ['chopping oak_log 1/14', 'chopping oak_log 2/14'])
  })
})
