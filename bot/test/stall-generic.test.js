'use strict'
// idkcraft-8hpy: goals without a progress metric (complete-castle upkeep,
// reflex episodes) still reach the stall chooser when flat.
const { describe, it, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const taskMod = require('../src/task')
const { createTicker } = require('../src/index')

function pos(x, y, z) {
  return { x, y, z, distanceTo: (q) => Math.hypot(x - q.x, y - q.y, z - q.z) }
}
function makeBot() {
  return {
    username: 'IdkBot', chats: [], chat(m) { this.chats.push(String(m)) },
    entity: { position: pos(2, 64, 2), onGround: true, isInWater: false },
    inventory: { items: () => [{ name: 'oak_planks', count: 3 }] },
    time: { timeOfDay: 6000, day: 1 }, health: 20, food: 20, oxygenLevel: 20,
    spawnPoint: pos(0, 64, 0), players: {}, entities: {},
    blockAt: () => ({ name: 'air', boundingBox: 'empty' }),
    pathfinder: { isMoving: () => false, setGoal() {}, stop() {}, goal: null },
    clearControlStates() {},
  }
}
function workCtx(bot) {
  const ticker = createTicker({ bot, brain: null, tickMs: 10, idleTickMs: 10 })
  ticker.setHome({ site: { x: 0, y: 64, z: 0 }, built: false, v: 2 })
  ticker.work()
  const ctx = bot._tickerCtx
  // A complete castle with upkeep owed: no goal kind owns the body.
  ctx.castle = { site: { x: 0, y: 64, z: 0 }, rot: 0, phase: 'complete', upkeepOwed: true }
  ctx.home.built = true
  return ctx
}
const flush = () => new Promise((r) => setImmediate(r))
let lines = []
let origLog = null
const ENV = ['STALL_DECIDE', 'GOAL_WATCHDOG_MS', 'GOAL_COMMIT_MS', 'LLM_ESCALATION', 'GOAL_WATCHDOG_MAX_ROUNDS']
let saved = {}
beforeEach(() => {
  lines = []
  origLog = console.log
  console.log = (m) => { lines.push(String(m)) }
  saved = {}
  for (const k of ENV) { saved[k] = process.env[k]; delete process.env[k] }
})
afterEach(() => {
  console.log = origLog
  for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k] }
})
const decides = () => lines.filter((l) => l.startsWith('stall decide'))
async function round(bot, ctx, t) {
  let guard = 0
  while (!(ctx.stallGen && ctx.stallGen.pending) && guard++ < 20) { t += 10000; taskMod.taskTick(bot, ctx, t) }
  assert.ok(ctx.stallGen && ctx.stallGen.pending, `fired\n${lines.join('\n')}`)
  await flush()
  t += 1000
  taskMod.taskTick(bot, ctx, t)
  return t
}

describe('generic stall clock (8hpy)', () => {
  it('castle upkeep flat -> stall decide goal=castle, progress resets the clock', async () => {
    const bot = makeBot()
    const ctx = workCtx(bot)
    ctx.step = 'castle'
    let asked = null
    ctx.brain = { plan: async (req) => { asked = req; return { step: Object.keys(req.criteria)[0], confidence: 0.9, source: 'jev' } } }
    let t = 1000000000000
    taskMod.taskTick(bot, ctx, t)
    assert.equal(taskMod.goalKind(ctx), null)
    t = await round(bot, ctx, t)
    const d = decides()
    assert.equal(d.length, 1, lines.join('\n'))
    assert.match(d[0], /^stall decide goal=castle round=1 by=jev choice=\S+ conf=0\.90 /)
    assert.match(asked.state.goal, /unstick castle/)
    assert.ok(asked.state.context, 'plan-context attached')
    assert.equal(ctx.taskPlanStep, Object.keys(asked.criteria)[0])
    // An upkeep cell fixed: the episode resets, no round fires on the next window.
    ctx.progressMarks = (ctx.progressMarks || 0) + 1
    taskMod.taskTick(bot, ctx, t + 1000)
    assert.equal(ctx.stallGen.rounds, 0)
  })

  it('enclosed loop flat -> stall decide goal=reflex:enclosed and the pick preempts the reflex', async () => {
    const bot = makeBot()
    const ctx = workCtx(bot)
    ctx.castle = null
    ctx.step = 'gather'
    ctx.brain = { plan: async (req) => ({ step: Object.keys(req.criteria)[0], confidence: 0.8, source: 'jev' }) }
    let t = 1000000000000
    ctx.enclosedUntil = t + 10 * 60 * 1000
    taskMod.taskTick(bot, ctx, t)
    t = await round(bot, ctx, t)
    assert.match(decides()[0] || '', /^stall decide goal=reflex:enclosed round=1 by=jev /, lines.join('\n'))
    assert.ok(ctx.stallPreempt && ctx.stallPreempt.until > t, 'reflex preempted for the window')
    assert.equal(ctx.enclosedUntil, 0, 'enclosed episode ended')
  })

  it('a running step whose body stands still counts as stalled (step:<name>)', async () => {
    const bot = makeBot()
    const ctx = workCtx(bot)
    ctx.castle = null
    ctx.step = 'explore'
    ctx.stepStatus = 'running'
    ctx.brain = { plan: async (req) => ({ step: Object.keys(req.criteria).find((k) => k !== 'explore'), confidence: 0.9, source: 'jev' }) }
    let t = 1000000000000
    taskMod.taskTick(bot, ctx, t)
    t = await round(bot, ctx, t)
    assert.match(decides()[0] || '', /^stall decide goal=step:explore round=1 by=jev /, lines.join('\n'))
  })

  it('JEV none/low-confidence still acts: by=fallback picks an untried option', async () => {
    const bot = makeBot()
    const ctx = workCtx(bot)
    ctx.step = 'castle'
    ctx.brain = { plan: async () => ({ step: 'nonsense', confidence: 0.1, source: 'jev' }) }
    let t = 1000000000000
    taskMod.taskTick(bot, ctx, t)
    t = await round(bot, ctx, t)
    const d = decides()
    assert.match(d[0] || '', /^stall decide goal=castle round=1 by=fallback choice=(\S+) /, lines.join('\n'))
    const pick = /choice=(\S+)/.exec(d[0])[1]
    assert.notEqual(pick, 'none')
    assert.notEqual(pick, 'castle')
    assert.deepEqual(ctx.stallGen.tried, [pick])
  })

  it('no long silence after max rounds: rotation over untried, brief backoff only once all were tried', async () => {
    process.env.GOAL_WATCHDOG_MS = '60000'
    process.env.GOAL_WATCHDOG_MAX_ROUNDS = '1'
    const bot = makeBot()
    const ctx = workCtx(bot)
    ctx.step = 'castle'
    ctx.brain = { plan: async () => ({ step: 'nonsense', confidence: 0.1, source: 'jev' }) }
    let t = 1000000000000
    taskMod.taskTick(bot, ctx, t)
    for (let i = 0; i < 40 && !decides().some((l) => /all-tried/.test(l)); i++) {
      t = await round(bot, ctx, t)
      t += 200000 // past the commit window
    }
    const d = decides()
    const cut = d.findIndex((l) => /all-tried/.test(l))
    const picks = d.slice(0, cut).filter((l) => /by=fallback/.test(l)).map((l) => /choice=(\S+)/.exec(l)[1])
    assert.ok(picks.length >= 3, `rotated past max rounds: ${picks}`)
    assert.equal(new Set(picks).size, picks.length, 'each pick untried in the episode')
    const end = decides().find((l) => /all-tried/.test(l))
    assert.ok(end, lines.join('\n'))
    assert.equal(picks.length, new Set(d.slice(cut).join(' ').match(/options=\[([^\]]*)\]/)[1].split(',')).size, 'every option tried once before the backoff')
  })

  it('STALL_DECIDE=0 keeps the generic clock off', () => {
    process.env.STALL_DECIDE = '0'
    const bot = makeBot()
    const ctx = workCtx(bot)
    ctx.step = 'castle'
    ctx.brain = { plan: async () => ({ step: 'gather', confidence: 0.9 }) }
    let t = 1000000000000
    for (let i = 0; i < 20; i++) { t += 10000; taskMod.taskTick(bot, ctx, t) }
    assert.equal(ctx.stallGen, undefined)
  })
})
