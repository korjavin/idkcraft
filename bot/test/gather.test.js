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
      setGoal: (goal, dynamic) => { calls.setGoal++; calls.goals.push(goal) },
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
