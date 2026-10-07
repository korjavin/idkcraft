'use strict'

// Goal watchdog delivery 2 (idkcraft-vmzq.22): owner orders as goals
// (bring/comehome/gocastle/lead/flat metrics + dispatch seam) + option
// table of costed unlocks. Fake brains only; no network.

const { describe, it, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const taskMod = require('../src/task')
const goal = require('../src/goal')
const { goalOptions, planInstructions } = require('../src/goal-options')
const { goalUnlock, clampRadius } = require('../src/goal-unlock')
const { createTicker } = require('../src/index')

function pos(x, y, z) {
  return { x, y, z, distanceTo: (q) => Math.hypot(x - q.x, y - q.y, z - q.z) }
}

function makeBot({ timeOfDay = 6000, items = null, players = null } = {}) {
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
  }
}

function bringCtx(bot, { have = 0, want = 8, name = 'oak_log', by = 'P', phase = 'find' } = {}) {
  const ticker = createTicker({ bot, brain: null, tickMs: 10, idleTickMs: 10 })
  ticker.work()
  const ctx = bot._tickerCtx
  ctx.work = false
  ctx.bring = { kind: 'block', name, want, by, have, drop: name, phase, announced: true }
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

describe('bring watchdog (acceptance 1)', () => {
  it('have flat fires kind=bring with explore-far/gather-far; unlock sets and snaps back', async () => {
    const bot = makeBot()
    const { ctx } = bringCtx(bot)
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

describe('option table (acceptance 2)', () => {
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

  it('run-4 ctx offers explore-far and castlefetch, not castlefetch-far (reason logged)', () => {
    const { bot, ctx } = castleFixture()
    ctx.goal = { id: 'castle-1', kind: 'castle', generation: 1 }
    const skips = []
    const opts = goalOptions(bot, ctx, 'castle', skips)
    const ids = opts.map((o) => o.id)
    assert.ok(ids.includes('castlefetch'), `hold-castlefetch offered: ${ids}`)
    assert.ok(ids.includes('explore-far'), `explore-far offered: ${ids}`)
    assert.ok(!ids.includes('castlefetch-far'), `castlefetch-far withheld: ${ids}`)
    const skip = skips.find((s) => s.id === 'castlefetch-far')
    assert.ok(skip, 'reason recorded')
    assert.match(skip.why, /no remembered stone past 32/)
  })

  it('remembered stone at 90 offers castlefetch-far with the candidate', () => {
    const { bot, ctx } = castleFixture()
    ctx.goal = { id: 'castle-1', kind: 'castle', generation: 1 }
    ctx.resources = { items: new Map([['s', { x: 190, y: 64, z: 200, name: 'stone' }]]) }
    const skips = []
    const opts = goalOptions(bot, ctx, 'castle', skips)
    const far = opts.find((o) => o.id === 'castlefetch-far')
    assert.ok(far, `castlefetch-far offered: ${opts.map((o) => o.id)}`)
    assert.equal(far.step, 'castlefetch')
    assert.ok(far.unlock.candidate, 'candidate rides')
    assert.equal(far.unlock.candidate.x, 190)
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

describe('radius clamp (acceptance 4)', () => {
  it('1000 clamps to 256', () => {
    assert.equal(clampRadius(1000), 256)
    assert.equal(clampRadius(256), 256)
    assert.equal(clampRadius(64), 64)
    assert.equal(clampRadius(0), null)
  })

  it('explore honours the clamped unlock around the anchor', () => {
    const explore = require('../src/behaviours/explore')
    const bot = makeBot({ })
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
})
