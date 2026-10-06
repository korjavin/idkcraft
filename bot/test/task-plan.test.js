'use strict'

// Stall-point planner (idkcraft-vmzq.5): at L2 one async JEV step pick
// fires before the deterministic park; the answer applies on the next
// tick — a menu step is forced one-shot with a fresh window, any failure
// parks as .3 would. Park/ask-owner stay rule-based.

const { describe, it, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const taskMod = require('../src/task')
const goal = require('../src/goal')
const metrics = require('../src/metrics')
const { createTicker } = require('../src/index')

assert.equal(taskMod.TASK_PLAN_MIN_CONF, 0.5, 'low-confidence answers park')

function pos(x, y, z) {
  return { x, y, z, distanceTo: (q) => Math.hypot(x - q.x, y - q.y, z - q.z) }
}

function makeBot({ timeOfDay = 6000, items = null } = {}) {
  const inv = items || [{ name: 'cobblestone', count: 20 }]
  return {
    username: 'IdkBot',
    chats: [],
    chat(m) { this.chats.push(String(m)) },
    entity: { position: pos(100, 64, 200), onGround: true, isInWater: false },
    inventory: { items: () => inv },
    time: { timeOfDay, day: 1 },
    health: 20,
    food: 20,
    oxygenLevel: 20,
    spawnPoint: pos(0, 64, 0),
    players: {},
    entities: {},
    blockAt: () => null,
    pathfinder: { isMoving: () => false, setGoal() {}, stop() {}, goal: null },
    clearControlStates() {},
  }
}

function castleCtx(bot, { done = 8, total = 1722, phase = 'body', kind = 'stone', left = 80 } = {}) {
  const ticker = createTicker({ bot, brain: null, tickMs: 10, idleTickMs: 10 })
  const st = { site: { x: 100, y: 64, z: 200 }, rot: 0, phase, blocked: {}, parked: false, progress: { done, total } }
  ticker.setCastle(st)
  ticker.work()
  const ctx = bot._tickerCtx
  ctx.castleWord = { kind, left }
  ctx.step = 'castlefetch'
  ctx.stepStatus = 'running'
  ctx.stepPick = { step: 'castlefetch', at: Date.now() - 5000, source: 'goal-fsm', why: 'fetch stone' }
  return { ticker, ctx }
}

function houseCtx(bot) {
  bot.blockAt = () => ({ name: 'air', boundingBox: 'empty' }) // loaded, nothing placed
  const ticker = createTicker({ bot, brain: null, tickMs: 10, idleTickMs: 10 })
  ticker.setHome({ site: { x: 0, y: 64, z: 0 }, built: false, v: 2 })
  ticker.work()
  return { ticker, ctx: bot._tickerCtx }
}

// Advance the fake clock in 10 s steps (the per-tick clamp bills 10 s
// fully, like task-park.test.js).
function advance(bot, ctx, t0, minutes) {
  let t = t0
  const steps = Math.round((minutes * 60 * 1000) / 10000)
  for (let s = 0; s < steps; s++) {
    t += 10000
    taskMod.taskTick(bot, ctx, t)
  }
  return t
}

const flush = () => new Promise((r) => setImmediate(r))

function planCounter(answer) {
  return metrics.client.register.metrics().then((text) => {
    const m = text.match(new RegExp(`idkcraft_bot_task_plan_total\\{answer="${answer}"\\} ([0-9.e+]+)`))
    return m ? Number(m[1]) : 0
  })
}

// Mock planner: answers the first menu key at high confidence, records
// every request. Returns { calls, brain }.
function firstKeyPlanner(conf = 0.9) {
  const calls = []
  const brain = {
    plan: async (req) => {
      calls.push(req)
      const k = Object.keys(req.criteria)[0]
      return { step: k, confidence: conf, probabilities: { [k]: conf }, source: 'jev' }
    },
  }
  return { calls, brain }
}

let origLog = null
let lines = []
beforeEach(() => {
  lines = []
  origLog = console.log
  console.log = (m) => { lines.push(String(m)) }
})
afterEach(() => { console.log = origLog })

function planLogs() {
  return lines.filter((l) => l.startsWith('task plan'))
}
function parkChats(bot) {
  return bot.chats.filter((c) => /parked at|for the day/.test(c))
}

describe('stall-point planner (vmzq.5)', () => {
  it('L2 calls plan() once; the step applies on the next tick with a fresh window', async () => {
    const bot = makeBot()
    const { ctx } = castleCtx(bot)
    const { calls, brain } = firstKeyPlanner()
    ctx.brain = brain
    const t0 = 1000000000000
    taskMod.taskTick(bot, ctx, t0)
    const t1 = advance(bot, ctx, t0, 45)
    assert.equal(ctx.task.castle.planTried, true, 'plan fired at L2')
    assert.ok(ctx.task.castle.planPending, 'pending recorded')
    assert.equal(ctx.castle.parked, false, 'no park while the answer is in flight')
    assert.equal(parkChats(bot).length, 0)
    // A tick while the answer is in flight waits: no park, no second fire.
    taskMod.taskTick(bot, ctx, t1 + 10000)
    assert.ok(ctx.task.castle.planPending, 'still pending')
    assert.equal(ctx.castle.parked, false, 'no park while pending')
    await flush()
    assert.equal(calls.length, 1, 'one plan call at L2')
    assert.ok(ctx.task.castle.planAnswer, 'answer stored for the next tick')
    const step = ctx.task.castle.planAnswer.step
    const before = await planCounter(step)
    const t2 = t1 + 20000
    taskMod.taskTick(bot, ctx, t2)
    assert.equal(ctx.taskPlanStep, step, 'forced step handed to decide()')
    assert.equal(ctx.task.castle.stallMs, 0, 'fresh window for the retry')
    assert.equal(ctx.task.castle.planTried, true)
    assert.equal(ctx.castle.parked, false, 'planned step preempts the park')
    assert.equal(parkChats(bot).length, 0)
    // The request carries the goal/situation/history object state.
    const req = calls[0]
    assert.deepEqual(Object.keys(req.state).sort(), ['blocked_on', 'facts', 'goal', 'progress', 'recent', 'since_min'])
    assert.equal(req.state.goal, 'build castle')
    assert.equal(req.state.progress, '8/1722')
    assert.equal(req.state.since_min, 45)
    assert.deepEqual(req.state.recent, [])
    assert.match(req.state.blocked_on, /step=castlefetch running/)
    assert.match(req.state.facts, /time=day/)
    assert.equal(req.instructions, goal.ASK_INSTRUCTIONS)
    assert.ok(Object.keys(req.criteria).length > 0)
    assert.ok(!('rest' in req.criteria), 'rest is not a plan option')
    for (const k of Object.keys(req.criteria)) assert.equal(req.criteria[k], goal.STEP_CRITERIA[k])
    // The plan line, the disagree line against the .3 park, the metric.
    assert.match(
      planLogs().find((l) => l.includes('answer=')) || '',
      new RegExp(`^task plan kind=castle progress=8/1722 source=jev answer=${step} conf=0\\.90 probs=${step}:0\\.90$`),
    )
    assert.ok(planLogs().some((l) => l === `task plan disagree kind=castle plan=${step} rule=park`), JSON.stringify(planLogs()))
    assert.equal(await planCounter(step), before + 1)
  })

  it('the forced step runs via decide() with source task-plan, past the hold', async () => {
    const bot = makeBot()
    const { ctx } = houseCtx(bot)
    // Hold gather on the current text: the FSM cannot pick it.
    const facts = goal.goalFacts(bot, ctx)
    const text = goal.goalText(facts, ctx.home)
    ctx.stepFail = { gather: { status: 'failed:no-trees', text, pos: null, at: Date.now() } }
    ctx.brain = null
    const first = await goal.decide(bot, ctx)
    assert.equal(first.action, 'rest', 'held gather leaves rest')
    // Stamp the running key a steady re-decide would leave: without the
    // force the shortcut below would re-issue rest without choosing.
    ctx.askedKey = `${text}\nrunning`
    // The planner forces the held step anyway, one-shot.
    ctx.taskPlanStep = 'gather'
    const second = await goal.decide(bot, ctx)
    assert.equal(second.action, 'gather')
    assert.equal(ctx.taskPlanStep, null, 'one-shot consumed')
    assert.equal(ctx.stepPick.why, 'task-plan')
    assert.equal(ctx.stepPick.source, 'task-plan')
    assert.ok(ctx.stepFail.gather, 'the hold record survives the bypass')
    assert.ok(bot.chats.some((c) => c === 'next: chopping wood (task-plan)'), JSON.stringify(bot.chats))
    assert.match(lines.filter((l) => l.startsWith('goal step=')).pop() || '', /goal step=gather .*source=task-plan/)
  })

  it('one call per episode: the retry window ends in a deterministic park', async () => {
    const bot = makeBot()
    const { ctx } = castleCtx(bot)
    const { calls, brain } = firstKeyPlanner()
    ctx.brain = brain
    const t0 = 1000000000000
    taskMod.taskTick(bot, ctx, t0)
    const t1 = advance(bot, ctx, t0, 45)
    assert.ok(ctx.task.castle.planPending, 'plan fired at L2')
    await flush()
    assert.equal(calls.length, 1)
    const t2 = t1 + 10000
    taskMod.taskTick(bot, ctx, t2)
    assert.ok(ctx.taskPlanStep, 'forced step set')
    // A full second window with no progress: no second call, plain park.
    advance(bot, ctx, t2, 45)
    await flush()
    assert.equal(calls.length, 1, 'no second plan call in the episode')
    assert.equal(ctx.castle.parked, true)
    assert.deepEqual(ctx.castle.parkHist, { day: '2001-09-09', n: 1 })
    assert.equal(parkChats(bot).length, 1)
    assert.equal(ctx.taskPlanStep, null, 'the park voids the stale force')
    assert.equal(planLogs().filter((l) => l.includes('answer=')).length, 1, 'one plan line total')
  })

  it('a timed-out plan parks with why=timeout and no disagree line', async () => {
    const bot = makeBot()
    const { ctx } = castleCtx(bot)
    let n = 0
    ctx.brain = {
      plan: async () => {
        n++
        throw new DOMException('brain timeout', 'TimeoutError')
      },
    }
    const before = await planCounter('park')
    const t0 = 1000000000000
    taskMod.taskTick(bot, ctx, t0)
    const t1 = advance(bot, ctx, t0, 45)
    assert.ok(ctx.task.castle.planPending, 'plan fired at L2')
    await flush()
    assert.equal(n, 1)
    taskMod.taskTick(bot, ctx, t1 + 10000)
    assert.equal(ctx.castle.parked, true)
    assert.equal(parkChats(bot).length, 1)
    assert.ok(
      planLogs().some((l) => l === 'task plan kind=castle progress=8/1722 source=jev answer=park why=timeout'),
      JSON.stringify(planLogs()),
    )
    assert.equal(planLogs().filter((l) => l.includes('disagree')).length, 0, 'fallback agrees with the rule')
    assert.equal(await planCounter('park'), before + 1)
  })

  it('unknown and rest answers park as invalid (rest is never forced)', async () => {
    for (const bad of ['frobnicate', 'rest']) {
      const bot = makeBot()
      const { ctx } = castleCtx(bot)
      ctx.brain = { plan: async () => ({ step: bad, confidence: 0.9, probabilities: { [bad]: 0.9 }, source: 'jev' }) }
      const t0 = 1000000000000
      taskMod.taskTick(bot, ctx, t0)
      const t1 = advance(bot, ctx, t0, 45)
      await flush()
      taskMod.taskTick(bot, ctx, t1 + 10000)
      assert.equal(ctx.castle.parked, true, `${bad} parks`)
      assert.equal(ctx.taskPlanStep || null, null, `${bad} is not forced`)
      assert.ok(
        planLogs().some((l) => l === `task plan kind=castle progress=8/1722 source=jev answer=park why=invalid`),
        `${bad}: ${JSON.stringify(planLogs())}`,
      )
    }
  })

  it('a low-confidence answer parks with why=low-confidence', async () => {
    const bot = makeBot()
    const { ctx } = castleCtx(bot)
    ctx.brain = { plan: async () => ({ step: 'equip', confidence: 0.2, probabilities: { equip: 0.3, forage: 0.3 }, source: 'jev' }) }
    const t0 = 1000000000000
    taskMod.taskTick(bot, ctx, t0)
    const t1 = advance(bot, ctx, t0, 45)
    await flush()
    taskMod.taskTick(bot, ctx, t1 + 10000)
    assert.equal(ctx.castle.parked, true)
    assert.ok(
      planLogs().some((l) => l === 'task plan kind=castle progress=8/1722 source=jev answer=park why=low-confidence conf=0.20'),
      JSON.stringify(planLogs()),
    )
  })

  it('an empty menu parks without calling (nothing to try)', async () => {
    // Rich bot, placed table, door on hand, full kit: gather/craft/equip
    // infeasible by the numbers, build gated on the table item it has no
    // reason to craft, everything else site/none-gated.
    const bot = makeBot({
      items: [
        { name: 'oak_planks', count: 120 },
        { name: 'oak_door', count: 1 },
        { name: 'stone_sword', count: 1 },
        { name: 'stone_pickaxe', count: 1 },
        { name: 'cobblestone', count: 64 },
      ],
    })
    const { ctx } = houseCtx(bot)
    ctx.home.table = { x: 50, y: 64, z: 50 } // standing, off the footprint
    bot.blockAt = (p) => (Math.floor(p.x) === 50 && Math.floor(p.z) === 50
      ? { name: 'crafting_table', boundingBox: 'block' }
      : { name: 'air', boundingBox: 'empty' })
    const calls = []
    ctx.brain = { plan: async (req) => { calls.push(req); return { step: 'gather', confidence: 0.9, source: 'jev' } } }
    const t0 = 1000000000000
    taskMod.taskTick(bot, ctx, t0)
    assert.equal(ctx.task.active, 'house')
    advance(bot, ctx, t0, 45)
    await flush()
    assert.equal(ctx.home.parked, true, 'deterministic park')
    assert.equal(calls.length, 0, `no plan call, menu was ${calls.length ? Object.keys(calls[0].criteria) : '(empty)'}`)
    assert.equal(planLogs().length, 0, 'no plan lines without a consultation')
  })

  it('progress clears a pending plan; the late answer is dropped, the next stall plans again', async () => {
    const bot = makeBot()
    const { ctx } = castleCtx(bot)
    const { calls, brain } = firstKeyPlanner()
    ctx.brain = brain
    const t0 = 1000000000000
    taskMod.taskTick(bot, ctx, t0)
    const t1 = advance(bot, ctx, t0, 45)
    assert.ok(ctx.task.castle.planPending, 'plan fired at L2')
    // Progress before the answer lands ends the stall.
    ctx.castle.progress.done = 9
    taskMod.taskTick(bot, ctx, t1 + 10000)
    assert.equal(ctx.task.castle.planTried, false, 'progress re-arms')
    assert.equal(ctx.task.castle.planPending, null)
    await flush()
    assert.equal(calls.length, 1, 'the call fired, wasted')
    assert.equal(ctx.task.castle.planAnswer, null, 'late answer dropped')
    assert.equal(ctx.castle.parked, false)
    assert.equal(ctx.taskPlanStep || null, null, 'nothing forced')
    assert.equal(planLogs().length, 0, 'no plan lines for a dropped answer')
    // The next stall is a new episode: plans again.
    const t2 = advance(bot, ctx, t1 + 10000, 45)
    assert.ok(ctx.task.castle.planPending, 'second episode fired')
    await flush()
    assert.equal(calls.length, 2)
    taskMod.taskTick(bot, ctx, t2 + 10000)
    assert.ok(ctx.taskPlanStep, 'second episode forces its step')
  })

  it('auto-resume re-arms the planner', async () => {
    const bot = makeBot()
    const { ctx } = castleCtx(bot)
    const { calls, brain } = firstKeyPlanner()
    ctx.brain = brain
    const t0 = 1000000000000
    taskMod.taskTick(bot, ctx, t0)
    ctx.task.castle.planTried = true // a previous episode already planned
    const t1 = advance(bot, ctx, t0, 45)
    assert.equal(calls.length, 0, 'tried flag skips the call')
    assert.equal(ctx.castle.parked, true)
    const t2 = advance(bot, ctx, t1, 61)
    assert.equal(ctx.castle.parked, false, 'auto-resumed')
    advance(bot, ctx, t2, 45)
    assert.ok(ctx.task.castle.planPending, 'fresh episode fired')
    await flush()
    assert.equal(calls.length, 1, 'fresh episode plans again')
  })

  it('a stale planned step degrades to the normal menu', async () => {
    const bot = makeBot()
    const { ctx } = houseCtx(bot)
    ctx.brain = null
    // Infeasible (no castle): consumed, normal FSM pick, no task-plan stamp.
    ctx.taskPlanStep = 'castle'
    const first = await goal.decide(bot, ctx)
    assert.equal(first.action, 'gather')
    assert.equal(ctx.taskPlanStep, null)
    assert.equal(ctx.stepPick.source, 'goal-fsm')
    assert.notEqual(ctx.stepPick.why, 'task-plan')
    // Unknown step: same graceful path on the re-decide it forces.
    ctx.taskPlanStep = 'frobnicate'
    const second = await goal.decide(bot, ctx)
    assert.equal(second.action, 'gather')
    assert.equal(ctx.taskPlanStep, null)
    assert.notEqual(ctx.stepPick.source, 'task-plan')
  })

  it('a brain without plan() parks deterministically with no plan lines', async () => {
    const bot = makeBot()
    const { ctx } = castleCtx(bot)
    ctx.brain = { decide: async () => ({ action: 'idle', sprint: false, source: 'fake' }) }
    const t0 = 1000000000000
    taskMod.taskTick(bot, ctx, t0)
    advance(bot, ctx, t0, 45)
    await flush()
    assert.equal(ctx.castle.parked, true)
    assert.equal(planLogs().length, 0)
  })
})
