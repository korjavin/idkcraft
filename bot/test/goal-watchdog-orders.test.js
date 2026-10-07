'use strict'

// Goal watchdog delivery 2 (idkcraft-vmzq.22) + round-2 fixes: owner
// orders as goals (bring/comehome/gocastle/lead/flat metrics) + option
// table of costed unlocks. Fake brains only; no network.

const { describe, it, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const taskMod = require('../src/task')
const goal = require('../src/goal')
const { goalOptions, planInstructions } = require('../src/goal-options')
const { goalUnlock, clampRadius } = require('../src/goal-unlock')
const { createTicker } = require('../src/index')
const bringMod = require('../src/behaviours/bring')
const exploreMod = require('../src/behaviours/explore')
const gatherMod = require('../src/behaviours/gather')
const forageMod = require('../src/behaviours/forage')
const cfMod = require('../src/behaviours/castlefetch')
const scoutMod = require('../src/behaviours/scout')

function pos(x, y, z) {
  return { x, y, z, distanceTo: (q) => Math.hypot(x - q.x, y - q.y, z - q.z) }
}

function makeBot({ timeOfDay = 6000, items = null, players = null, registry = null } = {}) {
  const inv = items || [{ name: 'cobblestone', count: 10 }]
  return {
    username: 'IdkBot',
    chats: [],
    chat(m) { this.chats.push(String(m)) },
    entity: { position: pos(0, 64, 0), onGround: true, isInWater: false },
    inventory: { items: () => inv },
    time: { timeOfDay, day: 1 },
    health: 20,
    food: 20,
    oxygenLevel: 20,
    spawnPoint: pos(0, 64, 0),
    players: players || {},
    entities: {},
    blockAt: () => null,
    pathfinder: { isMoving: () => false, setGoal() {}, stop() {}, goal: null },
    clearControlStates() {},
    registry: registry || null,
  }
}

function bringCtx(bot, { have = 0, want = 8, name = 'oak_log', by = 'P', phase = 'find', self = null } = {}) {
  const ticker = createTicker({ bot, brain: null, tickMs: 10, idleTickMs: 10 })
  ticker.work()
  const ctx = bot._tickerCtx
  ctx.work = false
  ctx.bring = { kind: 'block', name, want, by, have, drop: name, phase, announced: true }
  if (self) ctx.bring.self = self
  ctx.step = 'bring'
  ctx.stepStatus = 'running'
  return { ticker, ctx }
}

function advance(bot, ctx, t0, seconds) {
  let t = t0
  const steps = Math.round((seconds * 1000) / 10000)
  for (let s = 0; s < steps; s++) {
    t += 10000
    taskMod.taskTick(bot, ctx, t)
  }
  return t
}

const flush = () => new Promise((r) => setImmediate(r))

function answerBrain(step, conf = 0.9) {
  const calls = []
  const brain = {
    plan: async (req) => {
      calls.push(req)
      const s = typeof step === 'function' ? step(req) : step
      return { step: s, confidence: conf, probabilities: { [s]: conf }, source: 'jev' }
    },
  }
  return { calls, brain }
}

let origLog = null
let lines = []
let savedEnv = {}
const WATCHDOG_ENV = ['GOAL_WATCHDOG_MS', 'GOAL_COMMIT_MS', 'GOAL_WATCHDOG_MAX_ROUNDS', 'GOAL_TRAVEL_GRACE_MS', 'GOAL_PLANB_SWITCH_MS']
beforeEach(() => {
  lines = []
  origLog = console.log
  console.log = (m) => { lines.push(String(m)) }
  savedEnv = {}
  for (const k of WATCHDOG_ENV) {
    savedEnv[k] = process.env[k]
    delete process.env[k]
  }
})
afterEach(() => {
  console.log = origLog
  for (const k of WATCHDOG_ENV) {
    if (savedEnv[k] === undefined) delete process.env[k]
    else process.env[k] = savedEnv[k]
  }
})

function wdLogs() { return lines.filter((l) => l.startsWith('goal watchdog')) }
function outLogs() { return lines.filter((l) => l.startsWith('goal outcome')) }
function optLogs() { return lines.filter((l) => l.startsWith('goal options')) }

describe('goalKind + order identity (vmzq.22)', () => {
  it('body-owning order first, then castle, then house', () => {
    const ctx = {}
    assert.equal(taskMod.goalKind(ctx), null)
    ctx.home = { site: { x: 0, y: 64, z: 0 }, built: false, v: 2 }
    ctx.stepFail = { build: { status: 'failed:no-site' } }
    assert.equal(taskMod.goalKind(ctx), 'house')
    ctx.castle = { site: { x: 100, y: 64, z: 200 }, phase: 'body', parked: false }
    assert.equal(taskMod.goalKind(ctx), 'castle')
    ctx.bring = { kind: 'block', name: 'oak_log', want: 8, have: 0 }
    assert.equal(taskMod.goalKind(ctx), 'bring')
    ctx.lead = { name: 'iron_ore', pos: { x: 10, y: 64, z: 10 } }
    assert.equal(taskMod.goalKind(ctx), 'lead')
    ctx.gocastle = { phase: 'walk' }
    assert.equal(taskMod.goalKind(ctx), 'gocastle')
    ctx.comehome = { phase: 'walk' }
    assert.equal(taskMod.goalKind(ctx), 'comehome')
    // Parked flat is not running.
    delete ctx.comehome
    delete ctx.gocastle
    delete ctx.lead
    delete ctx.bring
    ctx.flat = { parked: true }
    assert.equal(taskMod.goalKind(ctx), 'castle')
    ctx.flat.parked = false
    assert.equal(taskMod.goalKind(ctx), 'flat')
  })

  it('goal text names the order', () => {
    const ctx = { bring: { want: 8, name: 'oak_log', by: 'P' } }
    assert.equal(taskMod.goalTextFor('bring', ctx), 'bring 8 oak_log to P')
    assert.equal(taskMod.goalTextFor('comehome', ctx), 'come home')
    assert.equal(taskMod.goalTextFor('lead', { lead: { name: 'iron_ore' } }), 'lead to iron_ore')
  })
})

describe('bring watchdog (acceptance 1, finding 8)', () => {
  it('self bring, have flat: kind=bring with explore-far/gather-far; unlock sets and snaps back', async () => {
    const bot = makeBot({ registry: { blocksByName: { oak_log: { id: 17 } } } })
    const { ctx } = bringCtx(bot, { self: 'beds' })
    // Remembered oak at 90 blocks (past the 64 task radius) makes
    // gather-far available; home anchors explore-far.
    ctx.home = { site: { x: 0, y: 64, z: 0 }, built: true, v: 2 }
    ctx.resources = { items: new Map([['1', { x: 90, y: 64, z: 0, name: 'oak_log' }]]) }
    const { calls, brain } = answerBrain('explore-far')
    ctx.brain = brain
    const t0 = 1000000000000
    taskMod.taskTick(bot, ctx, t0)
    assert.equal(ctx.task.active, 'bring')
    assert.equal(ctx.goal.kind, 'bring')
    let t = t0
    let guard = 0
    while (!(ctx.task.bring.wd && ctx.task.bring.wd.pending) && guard++ < 20) {
      t += 10000
      taskMod.taskTick(bot, ctx, t)
    }
    assert.ok(ctx.task.bring.wd.pending, 'round fired')
    await flush()
    assert.equal(calls.length, 1)
    t += 10000
    taskMod.taskTick(bot, ctx, t)
    assert.equal(wdLogs().length, 1)
    assert.match(wdLogs()[0], /kind=bring/)
    assert.match(wdLogs()[0], /options=.*explore-far/)
    assert.match(wdLogs()[0], /options=.*gather-far/)
    assert.match(wdLogs()[0], /choice=explore-far/)
    // Instructions name the bring goal (not the tick words).
    assert.match(calls[0].instructions, /Goal: bring 8 oak_log to P; have 0\/8/)
    // The unlock rides the window and reads via the one helper.
    const c = ctx.goal.commit
    assert.ok(c, 'commit applied')
    assert.equal(c.optionId, 'explore-far')
    assert.deepEqual(c.unlock, { radius: 256 })
    // Re-stamp to the real clock for the helper read (fake-clock window).
    const now = Date.now()
    c.appliedAt = now
    c.lastTick = now
    c.until = now + 120000
    assert.equal(goalUnlock(ctx, 'radius'), 256)
    // Window end snaps back: no unlock reads.
    c.until = Date.now() - 1
    assert.equal(goalUnlock(ctx, 'radius'), null)
  })

  it('owner bring is NOT offered far options (finding 8: the legs are already uncapped)', async () => {
    const bot = makeBot({ registry: { blocksByName: { oak_log: { id: 17 } } } })
    const { ctx } = bringCtx(bot) // no self: an owner order
    ctx.home = { site: { x: 0, y: 64, z: 0 }, built: true, v: 2 }
    ctx.resources = { items: new Map([['1', { x: 90, y: 64, z: 0, name: 'oak_log' }]]) }
    const { calls, brain } = answerBrain('hold-bring')
    ctx.brain = brain
    const t0 = 1000000000000
    taskMod.taskTick(bot, ctx, t0)
    let t = t0
    let guard = 0
    while (!(ctx.task.bring.wd && ctx.task.bring.wd.pending) && guard++ < 20) {
      t += 10000
      taskMod.taskTick(bot, ctx, t)
    }
    await flush()
    assert.equal(calls.length, 1)
    assert.deepEqual(Object.keys(calls[0].criteria), ['hold-bring', 'park'])
    assert.ok(optLogs().some((l) => /skip=explore-far why=owner bring already uncapped/.test(l)), JSON.stringify(optLogs()))
    assert.ok(optLogs().some((l) => /skip=gather-far why=owner bring already uncapped/.test(l)), JSON.stringify(optLogs()))
    t += 10000
    taskMod.taskTick(bot, ctx, t)
    assert.match(wdLogs()[0], /choice=hold-bring/)
    assert.equal(ctx.goal.commit.unlock, null, 'hold carries no unlock')
  })

  it('have rising stays silent', async () => {
    const bot = makeBot()
    const { ctx } = bringCtx(bot)
    ctx.home = { site: { x: 0, y: 64, z: 0 }, built: true, v: 2 }
    const { calls, brain } = answerBrain('hold-bring')
    ctx.brain = brain
    const t0 = 1000000000000
    taskMod.taskTick(bot, ctx, t0)
    let t = t0
    for (let s = 0; s < 12; s++) {
      t += 10000
      ctx.bring.have += 1
      taskMod.taskTick(bot, ctx, t)
    }
    await flush()
    assert.equal(calls.length, 0, 'acquisition re-arms the watchdog')
    assert.equal(wdLogs().length, 0)
  })

  it('stop ends the order window with preempted:stop', async () => {
    const bot = makeBot()
    const { ctx } = bringCtx(bot)
    ctx.home = { site: { x: 0, y: 64, z: 0 }, built: true, v: 2 }
    const { brain } = answerBrain('hold-bring')
    ctx.brain = brain
    const t0 = 1000000000000
    taskMod.taskTick(bot, ctx, t0)
    let t = t0
    let guard = 0
    while (!(ctx.task.bring.wd && ctx.task.bring.wd.pending) && guard++ < 20) {
      t += 10000
      taskMod.taskTick(bot, ctx, t)
    }
    await flush()
    t += 10000
    taskMod.taskTick(bot, ctx, t)
    assert.ok(ctx.goal.commit, 'window live')
    ctx.paused = true
    t += 10000
    taskMod.taskTick(bot, ctx, t)
    assert.equal(ctx.goal.commit, null, 'window ended')
    assert.ok(outLogs().some((l) => /result=preempted:stop/.test(l)), JSON.stringify(outLogs()))
  })
})

describe('option table (acceptance 2, findings 1+3)', () => {
  function castleFixture() {
    // .21 run-4 shape: usable stone 57 (73 - 16 reserve) + pickaxe.
    const bot = makeBot({ items: [{ name: 'cobblestone', count: 73 }, { name: 'stone_pickaxe', count: 1 }] })
    const ticker = createTicker({ bot, brain: null, tickMs: 10, idleTickMs: 10 })
    const st = { site: { x: 100, y: 64, z: 200 }, rot: 0, phase: 'body', blocked: {}, parked: false, progress: { done: 8, total: 1722 } }
    ticker.setCastle(st)
    ticker.work()
    const ctx = bot._tickerCtx
    ctx.castleWord = { kind: 'stone', left: 80 }
    ctx.step = 'castlefetch'
    ctx.stepStatus = 'running'
    return { bot, ctx }
  }

  it('run-4 ctx offers castlefetch, skips explore-far (infeasible) and castlefetch-far (no live stone)', () => {
    const { bot, ctx } = castleFixture()
    ctx.goal = { id: 'castle-1', kind: 'castle', generation: 1 }
    const skips = []
    const opts = goalOptions(bot, ctx, 'castle', skips)
    const ids = opts.map((o) => o.id)
    assert.ok(ids.includes('castlefetch'), `hold-castlefetch offered: ${ids}`)
    assert.ok(!ids.includes('explore-far'), `explore-far withheld (infeasible): ${ids}`)
    assert.ok(skips.some((s) => s.id === 'explore-far' && /explore not feasible/.test(s.why)), JSON.stringify(skips))
    assert.ok(!ids.includes('castlefetch-far'), `castlefetch-far withheld: ${ids}`)
    assert.ok(skips.some((s) => s.id === 'castlefetch-far' && /no exposed stone past 32/.test(s.why)), JSON.stringify(skips))
  })

  it('feasible explore re-offers explore-far', () => {
    const { bot, ctx } = castleFixture()
    ctx.home = { site: { x: 0, y: 64, z: 0 }, built: true, v: 2 }
    ctx.goal = { id: 'castle-1', kind: 'castle', generation: 1 }
    const opts = goalOptions(bot, ctx, 'castle')
    const ids = opts.map((o) => o.id)
    assert.ok(ids.includes('explore-far'), `explore-far offered when feasible: ${ids}`)
  })

  it('stone demand + live exposed stone offers castlefetch-far with the candidate', () => {
    const { bot, ctx } = castleFixture()
    bot.registry = { blocksByName: { stone: { id: 1 } } }
    bot.findBlocks = () => [{ x: 100, y: 64, z: 136 }]
    const origExposed = scoutMod.isExposed
    scoutMod.isExposed = () => true
    try {
      ctx.goal = { id: 'castle-1', kind: 'castle', generation: 1 }
      const opts = goalOptions(bot, ctx, 'castle')
      const far = opts.find((o) => o.id === 'castlefetch-far')
      assert.ok(far, `castlefetch-far offered: ${opts.map((o) => o.id)}`)
      assert.equal(far.step, 'castlefetch')
      assert.deepEqual(far.unlock.candidate, { x: 100, y: 64, z: 136 })
    } finally {
      scoutMod.isExposed = origExposed
    }
  })

  it('stone demand + remembered logs only does NOT offer castlefetch-far (demand mismatch)', () => {
    const { bot, ctx } = castleFixture()
    // No findBlocks on this bot: no live stone. A remembered tree must not
    // stand in for stone demand (finding 1).
    ctx.resources = { items: new Map([['t', { x: 190, y: 64, z: 200, name: 'oak_log' }]]) }
    ctx.goal = { id: 'castle-1', kind: 'castle', generation: 1 }
    const skips = []
    const opts = goalOptions(bot, ctx, 'castle', skips)
    assert.ok(!opts.some((o) => o.id === 'castlefetch-far'), JSON.stringify(opts.map((o) => o.id)))
    assert.ok(skips.some((s) => s.id === 'castlefetch-far' && /no exposed stone past 32/.test(s.why)), JSON.stringify(skips))
  })

  it('wood demand + remembered logs offers castlefetch-far from memory', () => {
    const { bot, ctx } = castleFixture()
    ctx.castleWord = { kind: 'planks', left: 20 }
    ctx.resources = { items: new Map([['t', { x: 190, y: 64, z: 200, name: 'oak_log' }]]) }
    ctx.goal = { id: 'castle-1', kind: 'castle', generation: 1 }
    const opts = goalOptions(bot, ctx, 'castle')
    const far = opts.find((o) => o.id === 'castlefetch-far')
    assert.ok(far, `castlefetch-far offered for wood: ${opts.map((o) => o.id)}`)
    assert.deepEqual(far.unlock.candidate, { x: 190, y: 64, z: 200 })
  })
})

describe('arrival hold stays silent (finding 2)', () => {
  it('comehome in hold runs no rounds and keeps no stall', async () => {
    const bot = makeBot()
    const ticker = createTicker({ bot, brain: null, tickMs: 10, idleTickMs: 10 })
    ticker.work()
    const ctx = bot._tickerCtx
    ctx.work = false
    ctx.home = { site: { x: 0, y: 64, z: 0 }, built: true, v: 2 }
    ctx.comehome = { phase: 'hold', home: ctx.home }
    const { calls, brain } = answerBrain('hold-comehome')
    ctx.brain = brain
    const t0 = 1000000000000
    taskMod.taskTick(bot, ctx, t0)
    assert.equal(ctx.task.active, 'comehome')
    advance(bot, ctx, t0, 130)
    await flush()
    assert.equal(calls.length, 0, 'no paid rounds for an arrived order')
    assert.equal(wdLogs().length, 0)
    assert.equal(ctx.task.comehome.stallMs, 0, 'hold resets the clock')
    assert.ok(ctx.comehome, 'the order is not parked away')
  })

  it('lead while waiting runs no rounds', async () => {
    const bot = makeBot()
    const ticker = createTicker({ bot, brain: null, tickMs: 10, idleTickMs: 10 })
    ticker.work()
    const ctx = bot._tickerCtx
    ctx.work = false
    ctx.lead = { name: 'coal', pos: { x: 50, y: 64, z: 50 }, by: 'P', waiting: true, waitTicks: 1 }
    const { calls, brain } = answerBrain('hold-lead')
    ctx.brain = brain
    const t0 = 1000000000000
    taskMod.taskTick(bot, ctx, t0)
    advance(bot, ctx, t0, 130)
    await flush()
    assert.equal(calls.length, 0, 'waiting is not stalling')
    assert.equal(ctx.task.lead.stallMs, 0)
  })
})

describe('order replacement re-baselines (finding 4)', () => {
  it('bring over bring: new goal, fresh clock, unlock dropped, replaced outcome', async () => {
    const bot = makeBot()
    const { ctx } = bringCtx(bot)
    ctx.home = { site: { x: 0, y: 64, z: 0 }, built: true, v: 2 }
    const { brain } = answerBrain('hold-bring')
    ctx.brain = brain
    const t0 = 1000000000000
    taskMod.taskTick(bot, ctx, t0)
    let t = t0
    let guard = 0
    while (!(ctx.task.bring.wd && ctx.task.bring.wd.pending) && guard++ < 20) {
      t += 10000
      taskMod.taskTick(bot, ctx, t)
    }
    await flush()
    t += 10000
    taskMod.taskTick(bot, ctx, t)
    assert.ok(ctx.goal.commit, 'window live on order A')
    const oldId = ctx.goal.id
    // A new order lands over the running one (setBring replaces in place).
    const orderB = { kind: 'block', name: 'cobblestone', want: 4, by: 'P', have: 0, drop: 'cobblestone', phase: 'find', announced: true }
    ctx.bring = orderB
    t += 10000
    taskMod.taskTick(bot, ctx, t)
    assert.notEqual(ctx.goal.id, oldId, 'a new goal is founded')
    assert.equal(ctx.task.bring.done, 0, 'baseline is order B')
    assert.equal(ctx.task.bring.stallMs, 0)
    assert.equal((ctx.task.bring.wd || {}).rounds || 0, 0, 'no rounds leak across')
    assert.equal(ctx.task.bring.orderRef, orderB)
    assert.ok(!ctx.goal.commit, 'no unlock leaks across')
    assert.ok(outLogs().some((l) => /result=preempted:replaced/.test(l)), JSON.stringify(outLogs()))
  })
})

describe('unlock windows survive progress (finding 5)', () => {
  function stoneFixture() {
    const bot = makeBot({ items: [{ name: 'cobblestone', count: 73 }, { name: 'stone_pickaxe', count: 1 }] })
    bot.registry = { blocksByName: { stone: { id: 1 } } }
    bot.findBlocks = () => [{ x: 100, y: 64, z: 136 }]
    const ticker = createTicker({ bot, brain: null, tickMs: 10, idleTickMs: 10 })
    const st = { site: { x: 100, y: 64, z: 200 }, rot: 0, phase: 'body', blocked: {}, parked: false, progress: { done: 8, total: 1722 } }
    ticker.setCastle(st)
    ticker.work()
    const ctx = bot._tickerCtx
    ctx.castleWord = { kind: 'stone', left: 80 }
    ctx.step = 'castlefetch'
    ctx.stepStatus = 'running'
    return { bot, ctx }
  }

  async function liveWindow(bot, ctx, choice) {
    const { brain } = answerBrain(choice)
    ctx.brain = brain
    const t0 = 1000000000000
    taskMod.taskTick(bot, ctx, t0)
    let t = t0
    let guard = 0
    while (!(ctx.task.castle.wd && ctx.task.castle.wd.pending) && guard++ < 20) {
      t += 10000
      taskMod.taskTick(bot, ctx, t)
    }
    assert.ok(ctx.task.castle.wd.pending, 'round fired')
    await flush()
    t += 10000
    taskMod.taskTick(bot, ctx, t)
    assert.ok(ctx.goal.commit, 'window live')
    return t
  }

  it('castlefetch-far window survives the first stone; expiry reads progress', async () => {
    const { bot, ctx } = stoneFixture()
    const origExposed = scoutMod.isExposed
    scoutMod.isExposed = () => true
    try {
      const t = await liveWindow(bot, ctx, 'castlefetch-far')
      const c = ctx.goal.commit
      assert.deepEqual(c.unlock.candidate, { x: 100, y: 64, z: 136 })
      // One stone lands mid-window: the window stays, rounds clear.
      bot.inventory.items()[0].count = 74
      const t2 = t + 10000
      taskMod.taskTick(bot, ctx, t2)
      assert.equal(ctx.goal.commit, c, 'far leg keeps its bounds')
      assert.equal(c.sawProgress, true)
      assert.equal(ctx.task.castle.wd.rounds, 0)
      // Expiry verdicts progress with the unlock named.
      c.until = t2
      taskMod.taskTick(bot, ctx, t2 + 10000)
      assert.equal(ctx.goal.commit, null)
      assert.ok(outLogs().some((l) => /result=progress/.test(l) && /unlock=candidate,radius/.test(l)), JSON.stringify(outLogs()))
    } finally {
      scoutMod.isExposed = origExposed
    }
  })

  it('plain windows still end on first progress', async () => {
    const { bot, ctx } = stoneFixture()
    const t = await liveWindow(bot, ctx, 'castlefetch')
    assert.equal(ctx.goal.commit.unlock, null)
    bot.inventory.items()[0].count = 74
    taskMod.taskTick(bot, ctx, t + 10000)
    assert.equal(ctx.goal.commit, null, 'plain window ends')
    assert.ok(outLogs().some((l) => /result=progress/.test(l) && /unlock=-/.test(l)), JSON.stringify(outLogs()))
  })
})

describe('house-step unlock (acceptance 3)', () => {
  it('house-build lifts build only; others stay vetoed; expiry snaps back', () => {
    const bot = makeBot()
    bot.entity.position = pos(500, 64, 500) // far from home: homeLegVetoed binds
    const ticker = createTicker({ bot, brain: null, tickMs: 10, idleTickMs: 10 })
    ticker.setHome({ site: { x: 0, y: 64, z: 0 }, built: false, v: 2 })
    ticker.setCastle({ site: { x: 100, y: 64, z: 200 }, rot: 0, phase: 'body', blocked: {}, parked: false, progress: { done: 0, total: 10 } })
    ticker.work()
    const ctx = bot._tickerCtx
    // Planks for the batch gate; the veto is the only block.
    bot.inventory = { items: () => [{ name: 'oak_planks', count: 20 }] }
    const facts = goal.goalFacts(bot, ctx)
    assert.equal(goal.MENU.build.feasible(facts, bot, ctx), false, 'vetoed without unlock')
    // Arm the window with a house-build unlock.
    ctx.goal = { id: 'castle-1', kind: 'castle', generation: 1 }
    ctx.goal.commit = { goalId: 'castle-1', generation: 1, kind: 'castle', optionId: 'house-build', step: 'build', until: Date.now() + 60000, unlock: { houseStep: 'build' } }
    assert.equal(goal.MENU.build.feasible(goal.goalFacts(bot, ctx), bot, ctx), true, 'build lifted')
    assert.equal(goal.MENU.beds.feasible(goal.goalFacts(bot, ctx), bot, ctx), false, 'beds stays vetoed')
    assert.equal(goal.MENU.light.feasible(goal.goalFacts(bot, ctx), bot, ctx), false, 'light stays vetoed')
    assert.equal(goal.MENU.stockpile.feasible(goal.goalFacts(bot, ctx), bot, ctx), false, 'stockpile stays vetoed')
    assert.equal(goal.MENU.gear.feasible(goal.goalFacts(bot, ctx), bot, ctx), false, 'gear stays vetoed')
    // Expiry snaps back.
    ctx.goal.commit.until = Date.now() - 1
    assert.equal(goal.MENU.build.feasible(goal.goalFacts(bot, ctx), bot, ctx), false, 'veto returns after the window')
  })

  it('an owner castle stop stays parked under any unlock', () => {
    const bot = makeBot()
    const ticker = createTicker({ bot, brain: null, tickMs: 10, idleTickMs: 10 })
    ticker.setCastle({ site: { x: 100, y: 64, z: 200 }, rot: 0, phase: 'body', blocked: {}, parked: true, progress: { done: 0, total: 10 } })
    ticker.work()
    const ctx = bot._tickerCtx
    ctx.goal = { id: 'castle-1', kind: 'castle', generation: 1 }
    ctx.goal.commit = { goalId: 'castle-1', generation: 1, kind: 'castle', optionId: 'house-build', step: 'build', until: Date.now() + 60000, unlock: { houseStep: 'build', radius: 256 } }
    assert.equal(ctx.castle.parked, true, 'unlock never clears the owner park')
    assert.equal(taskMod.goalKind(ctx), null, 'parked castle is no goal (no house)')
  })
})

describe('radius clamp (acceptance 4, finding 10)', () => {
  it('1000 clamps to 256', () => {
    assert.equal(clampRadius(1000), 256)
    assert.equal(clampRadius(256), 256)
    assert.equal(clampRadius(64), 64)
    assert.equal(clampRadius(0), null)
  })

  it('explore honours the clamped unlock around the anchor', () => {
    const explore = require('../src/behaviours/explore')
    const bot = makeBot({})
    bot.entity.position = pos(100, 64, 200)
    const ctx = {
      home: { site: { x: 0, y: 64, z: 0 }, built: true, v: 2 },
      castle: { site: { x: 100, y: 64, z: 200 }, rot: 0, phase: 'body', parked: false },
      explore: { visited: new Set(), target: null, lastPos: null, stalls: 0, issuedKey: null, markStart: 0, chatAt: 0 },
      goal: { id: 'castle-1', kind: 'castle', generation: 1 },
    }
    // Rings 16/32/64 visited at the site: capped the spiral ends.
    for (const r of [16, 32, 64]) {
      for (let a = 0; a < 8; a++) {
        const x = Math.round(100 + r * Math.sin(a * Math.PI / 4))
        const z = Math.round(200 - r * Math.cos(a * Math.PI / 4))
        ctx.explore.visited.add(`${Math.floor(x / 16)},${Math.floor(z / 16)}`)
      }
    }
    explore(bot, ctx, null, null)
    assert.equal(ctx.explore.target, null, 'capped without unlock')
    // The exhausted spiral resets visited to the current chunk — re-mark
    // the capped rings before the unlocked pick.
    for (const r of [16, 32, 64]) {
      for (let a = 0; a < 8; a++) {
        const x = Math.round(100 + r * Math.sin(a * Math.PI / 4))
        const z = Math.round(200 - r * Math.cos(a * Math.PI / 4))
        ctx.explore.visited.add(`${Math.floor(x / 16)},${Math.floor(z / 16)}`)
      }
    }
    // A 1000 unlock clamps to the 256 spiral, not past it.
    ctx.goal.commit = { goalId: 'castle-1', generation: 1, kind: 'castle', optionId: 'explore-far', step: 'explore', until: Date.now() + 60000, unlock: { radius: 1000 } }
    ctx.explore.target = null
    ctx.stepStatus = null
    explore(bot, ctx, null, null)
    const t = ctx.explore.target
    assert.ok(t, 'a far leg picks')
    const d = Math.hypot(t.x - 100, t.z - 200)
    assert.ok(d > 64 && d <= 256, `far leg ${Math.round(d)} within the clamped disk`)
  })

  it('bring enterSearch passes the task cap, the unlock cap, or nothing (findings 8+10)', async () => {
    const bot = makeBot()
    bot.entity.position = pos(100, 64, 200)
    const base = {
      castle: { site: { x: 100, y: 64, z: 200 }, rot: 0, phase: 'body', parked: false },
      home: { site: { x: 0, y: 64, z: 0 }, built: true, v: 2 },
      brain: null,
    }
    const caps = []
    const origNext = exploreMod.nextTarget
    exploreMod.nextTarget = (b, c, cap) => { caps.push(cap); return { x: 1, z: 1 } }
    try {
      // Self hunt under a task: the 64 task cap.
      const oSelf = { kind: 'block', name: 'oak_log', drop: 'oak_log', want: 8, have: 0, by: 'P', phase: 'find', self: 'beds', announced: true }
      const ctx = { ...base, bring: oSelf, goal: { id: 'bring-1', kind: 'bring', generation: 1 } }
      await bringMod.enterSearch(bot, ctx, oSelf, 'legacy')
      assert.deepEqual(caps, [64])
      assert.equal(oSelf.phase, 'searchwalk')
      // Live radius unlock: the clamped 256.
      ctx.goal.commit = { goalId: 'bring-1', generation: 1, kind: 'bring', optionId: 'explore-far', step: null, until: Date.now() + 60000, unlock: { radius: 1000 } }
      const oSelf2 = { kind: 'block', name: 'oak_log', drop: 'oak_log', want: 8, have: 0, by: 'P', phase: 'find', self: 'beds', announced: true }
      ctx.bring = oSelf2
      await bringMod.enterSearch(bot, ctx, oSelf2, 'legacy')
      assert.deepEqual(caps, [64, 256])
      // Owner order: uncapped legs never consult the spiral cap.
      const oOwner = { kind: 'block', name: 'oak_log', drop: 'oak_log', want: 8, have: 0, by: 'P', phase: 'find', announced: true }
      ctx.bring = oOwner
      await bringMod.enterSearch(bot, ctx, oOwner, 'legacy')
      assert.deepEqual(caps, [64, 256], 'owner legs do not read the cap')
    } finally {
      exploreMod.nextTarget = origNext
    }
  })

  it('gather taskFar admits 200 and refuses 300 under the clamped unlock (finding 10)', () => {
    const ctx = {
      castle: { site: { x: 100, y: 64, z: 200 }, rot: 0, phase: 'body', parked: false },
      home: { site: { x: 0, y: 64, z: 0 }, built: true, v: 2 },
      goal: { id: 'castle-1', kind: 'castle', generation: 1 },
    }
    const near = { x: 300, y: 64, z: 200 } // 200 from the site anchor
    const far = { x: 400, y: 64, z: 200 } // 300 from the site anchor
    assert.equal(gatherMod.taskFar(ctx, near), true, 'past 64 without unlock')
    assert.equal(gatherMod.taskFar(ctx, far), true)
    ctx.goal.commit = { goalId: 'castle-1', generation: 1, kind: 'castle', optionId: 'gather-far', step: 'gather', until: Date.now() + 60000, unlock: { radius: 1000 } }
    assert.equal(gatherMod.taskFar(ctx, near), false, '200 admitted under the clamped 256')
    assert.equal(gatherMod.taskFar(ctx, far), true, '300 refused past the clamp')
  })

  it('forage parkedCellSkipped admits 200 and refuses 300 under the clamped unlock (finding 10)', () => {
    const ctx = {
      home: { site: { x: 0, y: 64, z: 0 }, built: true, v: 2 },
      castle: { site: { x: 100, y: 64, z: 200 }, rot: 0, phase: 'body', parked: true },
      goal: { id: 'castle-1', kind: 'castle', generation: 1 },
    }
    const near = { x: 200, y: 64, z: 0 } // 200 from home, ~141 from castle
    const far = { x: 500, y: 64, z: 0 } // past 256 of both anchors
    assert.equal(forageMod.parkedCellSkipped(ctx, near), true, 'skipped past 64 without unlock')
    assert.equal(forageMod.parkedCellSkipped(ctx, far), true)
    ctx.goal.commit = { goalId: 'castle-1', generation: 1, kind: 'castle', optionId: 'forage-far', step: 'forage', until: Date.now() + 60000, unlock: { radius: 1000 } }
    assert.equal(forageMod.parkedCellSkipped(ctx, near), false, 'admitted under the clamped 256')
    assert.equal(forageMod.parkedCellSkipped(ctx, far), true, 'refused past the clamp')
  })
})

describe('far-fetch leg walks the candidate (findings 9+10)', () => {
  function fetchRig() {
    const bot = makeBot({ items: [{ name: 'stone_pickaxe', count: 1 }] })
    bot.entity.position = pos(100, 64, 200) // standing on the site
    const goalsSeen = []
    bot.pathfinder.setGoal = (g) => { goalsSeen.push(g) }
    const ctx = {
      castle: { site: { x: 100, y: 64, z: 200 }, rot: 0, phase: 'body', parked: false },
      lastGoalKey: '',
      goal: {
        id: 'castle-1', kind: 'castle', generation: 1,
        commit: {
          goalId: 'castle-1', generation: 1, kind: 'castle', optionId: 'castlefetch-far', step: 'castlefetch',
          until: Date.now() + 60000, unlock: { radius: 256, candidate: { x: 190, y: 64, z: 200 } },
        },
      },
    }
    return { bot, ctx, goalsSeen }
  }

  it('live window walks to the candidate; expiry holds the latched leg, fresh legs walk home', () => {
    const { bot, ctx, goalsSeen } = fetchRig()
    const f = { kind: 'stone', skip: new Set(), target: null }
    cfMod.digTick(bot, ctx, f)
    assert.match(ctx.lastGoalKey, /^castlefetch-site:190,200$/, ctx.lastGoalKey)
    assert.deepEqual(f.farCandidate, { x: 190, y: 64, z: 200 }, 'candidate latches onto the leg')
    assert.equal(goalsSeen.length, 1)
    assert.equal(goalsSeen[0].x, 190)
    // The window expires mid-leg: the latched leg keeps walking out.
    ctx.goal.commit.until = Date.now() - 1
    ctx.lastGoalKey = ''
    cfMod.digTick(bot, ctx, f)
    assert.match(ctx.lastGoalKey, /^castlefetch-site:190,200$/, `latched: ${ctx.lastGoalKey}`)
    // A fresh leg after expiry walks back to the site: the bot is out at
    // the candidate ground (the latch died with the old leg).
    bot.entity.position = pos(190, 64, 200)
    const f2 = { kind: 'stone', skip: new Set(), target: null }
    ctx.lastGoalKey = ''
    cfMod.digTick(bot, ctx, f2)
    assert.ok(/^castlefetch-site:/.test(ctx.lastGoalKey), ctx.lastGoalKey)
    assert.doesNotMatch(ctx.lastGoalKey, /190,200/, `snapped back: ${ctx.lastGoalKey}`)
    const g2 = goalsSeen[goalsSeen.length - 1]
    assert.ok(Math.hypot(g2.x - 100, g2.z - 200) < 32, `site walk: ${g2.x},${g2.z}`)
    assert.ok(Math.hypot(g2.x - 190, g2.z - 200) > 50, `not the candidate: ${g2.x},${g2.z}`)
  })
})
