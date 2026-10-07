'use strict'

// Bead idkcraft-vmzq.16: no-site follow-ups from PR #324 (codex P2s).
// (1) A failed:no-site hold is a chunk verdict, but the facts text carries
// no chunk signal — chunks loading never released the hold, so a homeless
// bot rested until some unrelated fact moved. The hold now re-validates:
// a site that wins releases it, and decide() wakes for one fresh pick.
// (2) A homeless no-site was invisible to the task stall clock (taskKind
// needs ctx.home.site), so nothing told the owner. A recorded no-site is
// now a pending-house intent: the clock watches at ?/? and the L1 reports
// honestly; the L2 park no-ops (nothing to veto).

const { describe, it, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const goal = require('../src/goal')
const taskMod = require('../src/task')
const resources = require('../src/resources')
const { createTicker } = require('../src/index')

function pos(x, y, z) {
  const p = {
    x, y, z,
    distanceTo: (q) => Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z),
    clone() { return pos(p.x, p.y, p.z) },
    floored() { return pos(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)) },
  }
  return p
}

function flatWorld() {
  return { blockAt: (p) => ({ name: Math.floor(p.y) <= 63 ? 'dirt' : 'air' }) }
}

function darkWorld() {
  return { blockAt: () => null }
}

function wetWorld() {
  // Water at every column top around the origin: every footprint reads wet.
  return { blockAt: (p) => ({ name: Math.floor(p.y) <= 63 ? 'dirt' : 'water' }) }
}

// Homeless full kit: craft/equip/gather all infeasible (200 planks cover
// the 107 budget with logs 0, table+door on hand, stone kit + scaffold),
// so build is the only work step standing between rest and the site.
function kitItems() {
  return [
    { name: 'oak_planks', count: 200 },
    { name: 'crafting_table', count: 1 },
    { name: 'oak_door', count: 1 },
    { name: 'stone_sword', count: 1 },
    { name: 'stone_pickaxe', count: 1 },
    { name: 'cobblestone', count: 64 },
  ]
}

function goalBot(world, { items = kitItems(), at = pos(0, 65, 0), spawn = pos(0, 64, 0) } = {}) {
  return {
    chats: [],
    entity: { position: at },
    inventory: { items: () => items },
    time: { timeOfDay: 6000 },
    spawnPoint: spawn,
    players: {},
    entities: {},
    health: 20,
    food: 20,
    blockAt: (p) => world.blockAt(p),
    chat(m) { this.chats.push(String(m)) },
  }
}

function noSiteRecord(bot, ctx) {
  const text = goal.goalText(goal.goalFacts(bot, ctx), null)
  const bp = bot.entity.position
  return { status: 'failed:no-site', text, pos: { x: bp.x, y: bp.y, z: bp.z }, at: Date.now() }
}

describe('vmzq.16 no-site hold releases when a site validates', () => {
  it('holds while the ground stays dark', () => {
    const bot = goalBot(darkWorld())
    const ctx = {}
    ctx.stepFail = { build: noSiteRecord(bot, ctx) }
    const text = goal.goalText(goal.goalFacts(bot, ctx), null)
    assert.equal(goal.failHolds(ctx, 'build', text, bot), true)
  })

  it('releases once chunks load and a site wins', () => {
    const world = darkWorld()
    const bot = goalBot(world)
    const ctx = {}
    ctx.stepFail = { build: noSiteRecord(bot, ctx) }
    const text = goal.goalText(goal.goalFacts(bot, ctx), null)
    assert.equal(goal.failHolds(ctx, 'build', text, bot), true)
    world.blockAt = (p) => flatWorld().blockAt(p) // chunks stream in
    assert.equal(goal.goalText(goal.goalFacts(bot, ctx), null), text, 'facts carry no chunk signal')
    assert.equal(goal.failHolds(ctx, 'build', text, bot), false)
  })

  it('wet ground keeps the hold: unfixable, no churn', () => {
    const bot = goalBot(wetWorld())
    const ctx = {}
    assert.equal(goal.siteFor(bot, pos(0, 64, 0)), null, 'bay refuses')
    ctx.stepFail = { build: noSiteRecord(bot, ctx) }
    const text = goal.goalText(goal.goalFacts(bot, ctx), null)
    assert.equal(goal.failHolds(ctx, 'build', text, bot), true)
  })

  it('other build failures ignore the site probe', () => {
    // A cannot-reach failure with a validating site still holds: the
    // release is a no-site rule, not a build rule.
    const bot = goalBot(flatWorld())
    const ctx = {}
    assert.ok(goal.siteFor(bot, pos(0, 64, 0)), 'site validates')
    const rec = noSiteRecord(bot, ctx)
    rec.status = 'failed:cannot-reach-site'
    ctx.stepFail = { build: rec }
    const text = goal.goalText(goal.goalFacts(bot, ctx), null)
    assert.equal(goal.failHolds(ctx, 'build', text, bot), true)
  })
})

describe('vmzq.16 decide wakes when no-site releases', () => {
  function restingNoSite(bot) {
    const ctx = { brain: {}, step: 'rest', stepStatus: 'running' }
    ctx.stepFail = { build: noSiteRecord(bot, ctx) }
    const text = goal.goalText(goal.goalFacts(bot, ctx), null)
    ctx.goalText = text
    ctx.askedKey = `${text}\nrunning`
    return ctx
  }

  it('dark spawn: keeps resting, record kept, no churn', async () => {
    const bot = goalBot(darkWorld())
    const ctx = restingNoSite(bot)
    const r = await goal.decide(bot, ctx)
    assert.equal(r.action, 'rest')
    assert.equal(ctx.step, 'rest')
    assert.equal(ctx.stepFail.build.status, 'failed:no-site', 'hold stands')
  })

  it('loaded spawn: re-picks build and retires the record', async () => {
    const world = darkWorld()
    const bot = goalBot(world)
    const ctx = restingNoSite(bot)
    assert.equal((await goal.decide(bot, ctx)).action, 'rest')
    world.blockAt = (p) => flatWorld().blockAt(p) // chunks stream in
    const r = await goal.decide(bot, ctx)
    assert.equal(r.action, 'build')
    assert.equal(ctx.step, 'build')
    assert.equal(ctx.stepFail.build, undefined, 'record retired')
  })

  it('relocation past the failure point forces one re-pick', async () => {
    const bot = goalBot(darkWorld())
    const ctx = restingNoSite(bot)
    assert.equal((await goal.decide(bot, ctx)).action, 'rest')
    bot.entity.position = pos(100, 65, 100) // walked off, same buckets
    const r = await goal.decide(bot, ctx)
    assert.equal(r.action, 'build', 'steady text still re-picks')
    assert.equal(ctx.stepFail.build, undefined, 'record retired')
  })
})

describe('vmzq.16 homeless no-site joins the stall clock', () => {
  let origLog = null
  let lines = []
  let savedWatchdog
  beforeEach(() => {
    lines = []
    origLog = console.log
    console.log = (m) => { lines.push(String(m)) }
    // Legacy ladder (vmzq.21 acceptance 5): the watchdog stays off.
    savedWatchdog = process.env.GOAL_WATCHDOG_MS
    process.env.GOAL_WATCHDOG_MS = '0'
  })
  afterEach(() => {
    console.log = origLog
    if (savedWatchdog === undefined) delete process.env.GOAL_WATCHDOG_MS
    else process.env.GOAL_WATCHDOG_MS = savedWatchdog
  })

  function homelessNoSite() {
    const bot = goalBot(darkWorld())
    bot.username = 'IdkBot'
    bot.oxygenLevel = 20
    bot.pathfinder = { isMoving: () => false, setGoal() {}, stop() {}, goal: null }
    bot.clearControlStates = () => {}
    const ticker = createTicker({ bot, brain: null, tickMs: 10, idleTickMs: 10 })
    ticker.work()
    const ctx = bot._tickerCtx
    ctx.step = 'rest'
    ctx.stepStatus = 'running'
    ctx.stepFail = { build: noSiteRecord(bot, ctx) }
    return { bot, ctx }
  }

  function houseLogs() {
    return lines.filter((l) => l.startsWith('task house '))
  }

  it('taskKind: pending-house intent is a house task', () => {
    const { ctx } = homelessNoSite()
    assert.equal(taskMod.taskKind(ctx), 'house')
    delete ctx.stepFail.build
    assert.equal(taskMod.taskKind(ctx), null, 'homeless without no-site: unchanged')
    ctx.home = { site: { x: 6, y: 64, z: 0 }, built: true }
    assert.equal(taskMod.taskKind(ctx), null, 'built home, no castle: unchanged')
  })

  it('15 min without a site -> one honest L1 at ?/?, no L2 park', () => {
    const { bot, ctx } = homelessNoSite()
    const t0 = 1000000000000
    taskMod.taskTick(bot, ctx, t0)
    assert.equal(ctx.task.active, 'house')
    assert.match(taskMod.taskLine(ctx), /^task house \?\/\? stall=0s$/)
    for (let s = 1; s <= 14 * 60; s++) taskMod.taskTick(bot, ctx, t0 + s * 1000)
    assert.equal(houseLogs().length, 0, 'silent before 15 min')
    assert.equal(bot.chats.length, 0)
    for (let s = 14 * 60 + 1; s <= 15 * 60; s++) taskMod.taskTick(bot, ctx, t0 + s * 1000)
    assert.equal(houseLogs().length, 1, 'one L1 log line')
    assert.equal(bot.chats.length, 1, 'one L1 chat line')
    assert.match(houseLogs()[0], /^task house \?\/\? stall=900s step=rest why=.*build holds after failure/)
    assert.match(bot.chats[0], /^house: no progress for 15 min at \?\/\? — .*build holds after failure.*; still trying$/)
    // Past the 45 min L2 mark: the park no-ops (no home to veto), the L1
    // dedupes on its identical diagnosis — no park chat, no repeat.
    for (let s = 15 * 60 + 1; s <= 46 * 60; s++) taskMod.taskTick(bot, ctx, t0 + s * 1000)
    assert.equal(houseLogs().filter((l) => l.includes('parked')).length, 0, 'no park without a home')
    assert.equal(bot.chats.filter((c) => c.includes('parked')).length, 0)
    assert.equal(bot.chats.length, 1, 'identical diagnosis stays deduped')
    assert.equal(ctx.home, undefined, 'no home founded by the clock')
  })

  it('known flips interleaved with decide never reset the stall clock', async () => {
    // Revmux 01 majors: retiring the no-site record on any text change
    // nulled the task between ticks (taskTick runs before decide), so
    // every bucket flip re-baselined the clock and the L1 never fired.
    const { bot, ctx } = homelessNoSite()
    const t0 = 1000000000000
    taskMod.taskTick(bot, ctx, t0)
    let last = 0
    for (let s = 1; s <= 12; s++) {
      if (s % 2 === 1) resources.noteSpots(ctx, [{ x: 5, y: 60, z: 0, name: 'iron_ore' }], 1000)
      else resources.forget(ctx, 5, 60, 0)
      taskMod.taskTick(bot, ctx, t0 + s * 1000)
      assert.equal(ctx.task.active, 'house', `tick ${s}: task stays pending-house`)
      const stall = ctx.task.house.stallMs
      assert.ok(stall >= last, `tick ${s}: stall keeps growing`)
      last = stall
      await goal.decide(bot, ctx)
      assert.equal(ctx.stepFail.build && ctx.stepFail.build.status, 'failed:no-site', `tick ${s}: record survives the flip`)
    }
    assert.equal(last, 12000, '12 eligible seconds bill 12 s, no reset')
  })
})
