'use strict'

// idkcraft-vmzq.3: stall ladder L2/L3 — park with a diagnosis, side work
// while parked, resume rules. Bundled: vmzq.8 (flat order pauses the clock).
// Unit-tests the ladder with a fake ctx/clock (no world, no castle ticks).

const { describe, it, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const os = require('node:os')
const path = require('node:path')
const fs = require('node:fs')
const taskMod = require('../src/task')
const goal = require('../src/goal')
const metrics = require('../src/metrics')
const memory = require('../src/memory')
const resources = require('../src/resources')
const forageMod = require('../src/behaviours/forage')
const { handleChat } = require('../src/chat')
const { createTicker } = require('../src/index')

const L2 = taskMod.TASK_STALL_L2_MS
const RETRY = taskMod.TASK_PARK_RETRY_MS
assert.equal(L2, 45 * 60 * 1000, 'L2 is 45 min')
assert.equal(RETRY, 60 * 60 * 1000, 'park retry is 60 min')
assert.equal(taskMod.TASK_PARKS_PER_DAY, 3, '3 parks latch for the day')
assert.equal(goal.PARK_FORAGE_RADIUS, 64, 'parked forage stays within 64')

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
// fully, so this is 6x faster than 1 s steps with identical billing).
function advance(bot, ctx, t0, minutes) {
  let t = t0
  const steps = Math.round((minutes * 60 * 1000) / 10000)
  for (let s = 0; s < steps; s++) {
    t += 10000
    taskMod.taskTick(bot, ctx, t)
  }
  return t
}

function stallCounter(task, level) {
  return metrics.client.register.metrics().then((text) => {
    const m = text.match(new RegExp(`idkcraft_bot_task_stall_total\\{task="${task}",level="${level}"\\} (\\d+)`))
    return m ? Number(m[1]) : 0
  })
}

let origLog = null
let lines = []
let savedWatchdog
beforeEach(() => {
  lines = []
  origLog = console.log
  console.log = (m) => { lines.push(String(m)) }
  // Legacy ladder suite (vmzq.21 acceptance 5): the watchdog stays off.
  savedWatchdog = process.env.GOAL_WATCHDOG_MS
  process.env.GOAL_WATCHDOG_MS = '0'
})
afterEach(() => {
  console.log = origLog
  if (savedWatchdog === undefined) delete process.env.GOAL_WATCHDOG_MS
  else process.env.GOAL_WATCHDOG_MS = savedWatchdog
})

function taskLogs() {
  return lines.filter((l) => l.startsWith('task castle ') || l.startsWith('task house '))
}
function parkChats(bot) {
  return bot.chats.filter((c) => /parked at|for the day/.test(c))
}
function resumeChats(bot) {
  return bot.chats.filter((c) => /retrying after 60 min parked/.test(c))
}

describe('stall ladder L2/L3 (vmzq.3)', () => {
  it('45 min eligible stall parks with the diagnosis, once', async () => {
    const bot = makeBot()
    const { ctx } = castleCtx(bot)
    const l2Before = await stallCounter('castle', 'L2')
    const t0 = 1000000000000
    taskMod.taskTick(bot, ctx, t0)
    const t1 = advance(bot, ctx, t0, 44)
    assert.equal(ctx.castle.parked, false, 'no park before 45 min')
    assert.equal(parkChats(bot).length, 0)
    advance(bot, ctx, t1, 1)
    assert.equal(ctx.castle.parked, true)
    assert.ok(ctx.castle.taskPark, 'L2 episode on the record')
    assert.equal(ctx.castle.taskPark.auto, true, 'first park retries')
    assert.deepEqual(ctx.castle.parkHist, { day: '2001-09-09', n: 1 })
    assert.equal(parkChats(bot).length, 1, 'exactly one park chat')
    assert.match(parkChats(bot)[0], /^castle parked at 8\/1722 after 45 min without progress — step=castlefetch running.*; say castle go to resume$/)
    assert.ok(parkChats(bot)[0].length <= 200, `park chat caps at 200, got ${parkChats(bot)[0].length}`)
    assert.match(taskLogs().find((l) => l.includes('parked')) || '', /^task castle 8\/1722 parked #1 why=step=castlefetch running/)
    assert.equal(await stallCounter('castle', 'L2'), l2Before + 1)
    // No re-park while parked: 30 more stalled minutes stay at one line.
    const epAt = ctx.castle.taskPark.at
    const t2 = advance(bot, ctx, t0, 45)
    advance(bot, ctx, t2, 30)
    assert.equal(parkChats(bot).length, 1, 'no second park while parked')
    assert.equal(ctx.castle.taskPark.at, epAt, 'episode untouched')
  })

  it('L1 keeps firing while parked, with the parked suffix', () => {
    const bot = makeBot()
    const { ctx } = castleCtx(bot)
    const t0 = 1000000000000
    taskMod.taskTick(bot, ctx, t0)
    const t1 = advance(bot, ctx, t0, 45)
    assert.equal(ctx.castle.parked, true)
    const l1Before = bot.chats.filter((c) => c.startsWith('castle: no progress')).length
    // Side work moves to a new failure: the changed diagnosis re-fires.
    ctx.step = 'equip'
    ctx.stepStatus = 'failed:craft-stall'
    advance(bot, ctx, t1, 15)
    const l1s = bot.chats.filter((c) => c.startsWith('castle: no progress'))
    assert.equal(l1s.length, l1Before + 1, 'changed diagnosis re-fires while parked')
    assert.match(l1s[l1s.length - 1], /; parked, doing side work$/)
    assert.ok(taskLogs().some((l) => /stall=\d+s parked step=equip/.test(l)), 'parked token in the log')
  })

  it('auto-resume after 60 min wall, once per episode', () => {
    const bot = makeBot()
    const { ctx } = castleCtx(bot)
    const t0 = 1000000000000
    taskMod.taskTick(bot, ctx, t0)
    const t1 = advance(bot, ctx, t0, 45)
    assert.equal(ctx.castle.parked, true)
    const at = ctx.castle.taskPark.at
    // 59 min of park: still parked, silent.
    const t2 = advance(bot, ctx, t1, 59)
    assert.equal(at - t1 <= 0, true, 'episode started at the park tick')
    assert.equal(ctx.castle.parked, true, 'no resume before 60 min')
    assert.equal(resumeChats(bot).length, 0)
    // The 60th minute resumes: flags clear, history stays, clock resets.
    advance(bot, ctx, t2, 2)
    assert.equal(ctx.castle.parked, false)
    assert.equal(ctx.castle.taskPark, null)
    assert.deepEqual(ctx.castle.parkHist, { day: '2001-09-09', n: 1 })
    assert.equal(resumeChats(bot).length, 1, 'one resume line')
    assert.match(resumeChats(bot)[0], /^castle retrying after 60 min parked \(stall 1\/3\)$/)
    assert.match(taskLogs().find((l) => l.includes('resumed')) || '', /^task castle resumed after 60 min parked \(stall 1\/3\)$/)
    // The clock re-baselines: a fresh 45 min stall parks again (#2).
    const t3 = at + RETRY + 2 * 60 * 1000
    taskMod.taskTick(bot, ctx, t3)
    advance(bot, ctx, t3, 45)
    assert.equal(ctx.castle.parkHist.n, 2, 'second stall parks again')
    assert.equal(ctx.castle.taskPark.auto, true, 'second park still retries')
    assert.equal(parkChats(bot).length, 2)
  })

  it('third park in a day latches until an owner command', async () => {
    const bot = makeBot()
    const { ticker, ctx } = castleCtx(bot)
    const l3Before = stallCounter('castle', 'L3')
    const t0 = 1000000000000
    taskMod.taskTick(bot, ctx, t0)
    let t = t0
    // Three full stall cycles: 45 to park, 60 to retry, twice, then park.
    t = advance(bot, ctx, t, 45)
    assert.equal(ctx.castle.parkHist.n, 1)
    t = advance(bot, ctx, t, 61)
    assert.equal(ctx.castle.parked, false, 'park 1 auto-resumes')
    t = advance(bot, ctx, t, 45)
    assert.equal(ctx.castle.parkHist.n, 2)
    t = advance(bot, ctx, t, 61)
    assert.equal(ctx.castle.parked, false, 'park 2 auto-resumes')
    t = advance(bot, ctx, t, 45)
    assert.equal(ctx.castle.parkHist.n, 3)
    assert.equal(ctx.castle.taskPark.auto, false, 'park 3 latches')
    const latched = parkChats(bot).filter((c) => /for the day/.test(c))
    assert.equal(latched.length, 1)
    assert.match(latched[0], /^castle parked for the day \(3 stalls\) — step=/)
    assert.ok(latched[0].length <= 200, `L3 chat caps at 200, got ${latched[0].length}`)
    assert.equal((await stallCounter('castle', 'L3')) - (await l3Before), 1, 'L3 counter moves')
    // 2 h more: still parked, no resume.
    advance(bot, ctx, t, 120)
    assert.equal(ctx.castle.parked, true, 'latched park waits for the owner')
    assert.equal(ctx.castle.taskPark.auto, false)
    assert.equal(resumeChats(bot).length, 2, 'no third auto-resume')
    // Owner command clears: parked flag, episode and clock.
    handleChat(bot, ticker, 'Steve', 'castle go')
    assert.equal(ctx.castle.parked, false)
    assert.equal(ctx.castle.taskPark, null)
    assert.equal(ctx.task, null, 'clock resets on resume')
    assert.equal(bot.chats[bot.chats.length - 1], 'castle resumed')
  })

  it('day rollover restarts the park count', () => {
    const bot = makeBot()
    const { ctx } = castleCtx(bot)
    ctx.castle.parkHist = { day: '2001-09-08', n: 3 } // latched yesterday
    const t0 = 1000000000000 // 2001-09-09
    taskMod.taskTick(bot, ctx, t0)
    advance(bot, ctx, t0, 45)
    assert.deepEqual(ctx.castle.parkHist, { day: '2001-09-09', n: 1 })
    assert.equal(ctx.castle.taskPark.auto, true, 'new day retries again')
  })

  it('house park vetoes the house chain; go work resumes', () => {
    const bot = makeBot()
    const { ticker, ctx } = houseCtx(bot)
    const t0 = 1000000000000
    taskMod.taskTick(bot, ctx, t0)
    assert.equal(ctx.task.active, 'house')
    advance(bot, ctx, t0, 45)
    assert.equal(ctx.home.parked, true)
    assert.ok(ctx.home.taskPark)
    assert.equal(parkChats(bot).length, 1)
    assert.match(parkChats(bot)[0], /^house parked at 0\/99 after 45 min without progress — .*; say go work to resume$/)
    // The house chain is out, explore is out, rest stays.
    const day = { time: 'day', health: 20, home: 'site', inside: 'no', logs: 14, planks: 0, maxPlanks: 0, table: 0, tablePlaced: false, door: 0, castle: 'none', known: 'none', player: 'none', beds: 'both' }
    assert.equal(goal.MENU.build.feasible(day, bot, ctx), false)
    assert.equal(goal.MENU.gather.feasible(day, bot, ctx), false)
    assert.equal(goal.MENU.craft.feasible(day, bot, ctx), false)
    assert.equal(goal.MENU.explore.feasible({ ...day, home: 'built' }, bot, ctx), false)
    assert.equal(goal.MENU.rest.feasible(day, bot, ctx), true)
    assert.equal(goal.stepWhy('build', day, bot, ctx, ''), 'build: house parked')
    // Owner resume clears the park and the clock.
    handleChat(bot, ticker, 'Steve', 'go work')
    assert.equal(ctx.home.parked, false)
    assert.equal(ctx.home.taskPark, null)
    assert.equal(ctx.task, null, 'clock resets on resume')
  })

  it('owner park pauses the clock and never auto-resumes', () => {
    const bot = makeBot()
    const { ticker, ctx } = castleCtx(bot)
    handleChat(bot, ticker, 'Steve', 'castle stop')
    assert.equal(ctx.castle.parked, true)
    assert.ok(!ctx.castle.taskPark, 'owner park has no episode')
    const chatsAfterStop = bot.chats.length
    const t0 = 1000000000000
    taskMod.taskTick(bot, ctx, t0)
    assert.equal(ctx.task.active, null, 'owner-parked castle is not active')
    advance(bot, ctx, t0, 70)
    assert.equal(taskLogs().length, 0, 'paused clock stays silent')
    assert.equal(bot.chats.length, chatsAfterStop, 'no ladder lines, no resume')
    assert.equal(ctx.castle.parked, true)
    // ... and explore is vetoed on an owner park too (the wander stops).
    const day = { time: 'day', health: 20, home: 'built', inside: 'no', castle: 'parked', known: 'none', player: 'none' }
    assert.equal(goal.MENU.explore.feasible(day, bot, ctx), false)
    assert.equal(goal.stepWhy('explore', day, bot, ctx, ''), 'explore: parked, staying near home')
    handleChat(bot, ticker, 'Steve', 'castle go')
    assert.equal(ctx.castle.parked, false)
    taskMod.taskTick(bot, ctx, t0 + 71 * 60 * 1000)
    assert.equal(ctx.task.active, 'castle', 'go re-arms the task')
  })

  it('castle stop drops the L2 episode (owner takes over)', () => {
    const bot = makeBot()
    const { ticker, ctx } = castleCtx(bot)
    const t0 = 1000000000000
    taskMod.taskTick(bot, ctx, t0)
    const t1 = advance(bot, ctx, t0, 45)
    assert.ok(ctx.castle.taskPark, 'parked by the ladder')
    handleChat(bot, ticker, 'Steve', 'castle stop')
    assert.equal(ctx.castle.taskPark, null, 'episode dropped')
    assert.equal(ctx.castle.parked, true, 'owner park stays')
    advance(bot, ctx, t1, 70)
    assert.equal(ctx.castle.parked, true, 'no auto-resume after owner stop')
    assert.equal(resumeChats(bot).length, 0)
  })

  it('parked menu: explore out, near forage in, castle legs out, nights unchanged', () => {
    const bot = makeBot()
    const { ctx } = castleCtx(bot)
    // A near oak stand (11 blocks from the castle site) and the park flags.
    // Facts come through the real goalFacts path, like decide() sees them.
    resources.noteSpots(ctx, [{ x: 110, y: 60, z: 205, name: 'oak_log' }], Date.now())
    ctx.castle.parked = true
    ctx.castle.taskPark = { at: 1000000000000, auto: true, diag: 'step=castlefetch running' }
    assert.equal(goal.taskParked(ctx), true)
    const facts = goal.goalFacts(bot, ctx)
    assert.equal(facts.castle, 'parked')
    assert.equal(facts.known, 'near')
    assert.equal(goal.MENU.explore.feasible({ ...facts, home: 'built' }, bot, ctx), false, 'explore vetoed while parked')
    assert.equal(goal.MENU.forage.feasible(facts, bot, ctx), true, 'near forage is side work')
    assert.equal(goal.MENU.castle.feasible(facts, bot, ctx), false, 'parked word stalls the leg')
    assert.equal(goal.MENU.castlefetch.feasible(facts, bot, ctx), false, 'parked word stalls the fetch')
    assert.equal(goal.MENU.rest.feasible(facts, bot, ctx), true)
    // Night steps own the night as before (bot at the castle, home near).
    ctx.home = { site: { x: 95, y: 64, z: 195 }, built: true, v: 2 }
    const night = { time: 'night', health: 20, home: 'built', inside: 'no' }
    assert.equal(goal.MENU.stay.feasible({ ...night, inside: 'yes' }, bot, ctx), true)
    assert.equal(goal.MENU.gohome.feasible(night, bot, ctx), true, 'gohome marches home, not to the site')
    // A far find (360 blocks out) is not parked side work: known reads
    // none, so the hunt is out through the plain facts gate.
    ctx.resources.items.clear()
    resources.noteSpots(ctx, [{ x: 400, y: 60, z: 500, name: 'oak_log' }], Date.now())
    const farFacts = goal.goalFacts(bot, ctx)
    assert.equal(farFacts.known, 'none', 'only far finds read as none while parked')
    assert.equal(goal.MENU.forage.feasible(farFacts, bot, ctx), false)
    // The replan path shares the filter: planForage itself returns null
    // (replan's null finish ends the leg instead of walking far).
    assert.equal(forageMod.planForage(bot, ctx), null, 'replan finds nothing while parked')
    // Unparked, the same far find is fair game (no cap off-park).
    ctx.castle.parked = false
    ctx.castle.taskPark = null
    const plan = forageMod.planForage(bot, ctx)
    assert.ok(plan && plan.pos && plan.pos.x === 400, 'unparked plans the far find')
    const freeFacts = goal.goalFacts(bot, ctx)
    assert.equal(freeFacts.known, 'near')
    assert.equal(goal.MENU.forage.feasible(freeFacts, bot, ctx), true)
    assert.equal(goal.MENU.explore.feasible({ ...freeFacts, home: 'built' }, bot, ctx), true)
  })

  it('parked hunts: near animals only, hunger is no exemption (05-verify major)', () => {
    // Bot far from the anchors (park landed mid-leg), one cow 30 blocks
    // from the bot but ~300 from the castle site, no remembered cells.
    const bot = makeBot()
    bot.entity.position = pos(300, 64, 300)
    bot.entities = { 1: { name: 'cow', id: 1, position: pos(320, 64, 310), isValid: true } }
    const { ctx } = castleCtx(bot)
    ctx.castle.parked = true
    ctx.castle.taskPark = { at: 1000000000000, auto: true, diag: 'step=castlefetch running' }
    // Well-fed: no hunt — the hop chain would drift home-away.
    assert.equal(bot.food, 20)
    assert.equal(forageMod.planForage(bot, ctx), null, 'well-fed parked bot skips the far cow')
    assert.equal(goal.goalFacts(bot, ctx).known, 'none')
    // Hungry (food 17): still no hunt — raw drops never feed the bot
    // (EDIBLE_FOODS has no raw), so the exemption was pure drift.
    bot.food = 17
    assert.equal(forageMod.planForage(bot, ctx), null, 'hungry parked bot skips the far cow')
    assert.equal(goal.goalFacts(bot, ctx).known, 'none')
    // Near the anchor, the same cow is fair game even well-fed.
    bot.food = 20
    bot.entity.position = pos(100, 64, 200)
    bot.entities = { 2: { name: 'cow', id: 2, position: pos(110, 64, 205), isValid: true } }
    const plan = forageMod.planForage(bot, ctx)
    assert.ok(plan && plan.kind === 'food', 'parked bot hunts the near cow')
    assert.equal(goal.goalFacts(bot, ctx).known, 'near')
    // Unparked and well-fed far away: the old opportunistic hunt is back.
    bot.entity.position = pos(300, 64, 300)
    bot.entities = { 1: { name: 'cow', id: 1, position: pos(320, 64, 310), isValid: true } }
    ctx.castle.parked = false
    ctx.castle.taskPark = null
    assert.ok(forageMod.planForage(bot, ctx), 'unparked bot hunts opportunistically')
  })

  it('parked food leg ends instead of re-targeting far (03 major)', () => {
    // Mid-leg state: first cow killed and picked up, one beef short of
    // the batch. The next same-drop cow is 30 blocks from the bot but
    // ~300 from the castle anchor; the only remembered cell is far too.
    const bot = makeBot()
    bot.entity.position = pos(300, 64, 300)
    bot.entities = { 9: { id: 9, name: 'cow', position: pos(320, 64, 310), isValid: true } }
    bot.food = 17 // hungry too: the exemption is gone, the leg still ends
    const { ctx } = castleCtx(bot)
    resources.noteSpots(ctx, [{ x: 400, y: 60, z: 500, name: 'oak_log' }], Date.now())
    ctx.castle.parked = true
    ctx.castle.taskPark = { at: 1000000000000, auto: true, diag: 'x' }
    ctx.forage = { phase: 'find', target: { kind: 'food', name: 'cow', id: null, drop: 'beef', want: 8 }, leg: null, via: null, stalls: 0, streak: 1, lastBotPos: null, startInv: {}, drops: { beef: true }, announced: true }
    ctx.stepStatus = 'running'
    forageMod(bot, ctx, null, {})
    assert.equal(ctx.forage, null, 'leg finished instead of adopting the far cow')
    assert.ok(ctx.stepStatus.startsWith('failed:'), `leg failed, got ${ctx.stepStatus}`)
    // Unparked, the same state re-targets onto the cow and keeps hunting.
    const bot2 = makeBot()
    bot2.entity.position = pos(300, 64, 300)
    bot2.entities = { 9: { id: 9, name: 'cow', position: pos(320, 64, 310), isValid: true } }
    const { ctx: ctx2 } = castleCtx(bot2)
    ctx2.forage = { phase: 'find', target: { kind: 'food', name: 'cow', id: null, drop: 'beef', want: 8 }, leg: null, via: null, stalls: 0, streak: 1, lastBotPos: null, startInv: {}, drops: { beef: true }, announced: true }
    ctx2.stepStatus = 'running'
    forageMod(bot2, ctx2, null, {})
    assert.equal(ctx2.forage.target.id, 9, 'unparked leg adopts the cow')
    assert.equal(ctx2.forage.phase, 'walk')
  })

  it('owner castle stop keeps the pre-house stranded release (core-1)', () => {
    const bot = makeBot()
    bot.entity.position = pos(0, 64, 0)
    const daySite = { time: 'day', logs: 0, home: 'site', player: 'none' }
    const stranded = { pos: null, name: 'log', phase: 'walk', skip: new Set(), streak: 3, final: 'failed:unreachable', atLogs: 0, failPos: { x: 0, y: 64, z: 0 } }
    // Owner-stopped castle (no episode, never auto-resumes): the stranded
    // spiral still opens — it is the only no-trees release.
    const ownerParked = { home: { site: pos(10, 64, 10) }, gather: { ...stranded }, castle: { site: { x: 100, y: 64, z: 200 }, parked: true } }
    assert.equal(goal.MENU.explore.feasible(daySite, bot, ownerParked), true, 'owner stop keeps the release')
    // The timer-bounded house park vetoes it (auto-resume retries).
    const houseParked = { home: { site: pos(10, 64, 10), parked: true, taskPark: { at: 1000000000000, auto: true, diag: 'x' } }, gather: { ...stranded } }
    assert.equal(goal.MENU.explore.feasible(daySite, bot, houseParked), false, 'house park vetoes briefly')
    // And the built-home search stays vetoed on any park.
    assert.equal(goal.MENU.explore.feasible({ ...daySite, home: 'built' }, bot, ownerParked), false)
  })

  it('status shows the parked diagnosis', () => {
    const bot = makeBot()
    const { ticker, ctx } = castleCtx(bot)
    const t0 = 1000000000000
    taskMod.taskTick(bot, ctx, t0)
    advance(bot, ctx, t0, 45)
    assert.ok(ctx.castle.taskPark)
    const before = bot.chats.length
    ticker.status()
    const after = bot.chats.slice(before)
    assert.ok(after.some((l) => l.startsWith('parked castle: step=')), JSON.stringify(after))
    assert.ok(after.some((l) => l.startsWith('task castle 8/1722 stall=')), 'task line still rides along')
  })

  it('park episode and day count survive a restart (memory round-trip)', () => {
    const bot = makeBot()
    const { ctx } = castleCtx(bot)
    const t0 = 1000000000000
    taskMod.taskTick(bot, ctx, t0)
    const t1 = advance(bot, ctx, t0, 45)
    assert.ok(ctx.castle.taskPark)
    const file = path.join(os.tmpdir(), `task-park-mem-${process.pid}.json`)
    try {
      assert.equal(memory.save(bot, ctx, file, t1), true)
      const bot2 = makeBot()
      const ctx2 = {}
      assert.ok(memory.restore(bot2, ctx2, file, t1))
      assert.equal(ctx2.castle.parked, true)
      assert.equal(ctx2.castle.taskPark.at, ctx.castle.taskPark.at, 'episode timer survives')
      assert.equal(ctx2.castle.taskPark.auto, true)
      assert.ok(ctx2.castle.taskPark.diag.startsWith('step='), 'diagnosis survives')
      assert.deepEqual(ctx2.castle.parkHist, { day: '2001-09-09', n: 1 })
      // The restored episode still auto-resumes on its wall clock.
      ctx2.work = true
      taskMod.taskTick(bot2, ctx2, ctx.castle.taskPark.at + RETRY + 1000)
      assert.equal(ctx2.castle.parked, false, 'restored park resumes')
      assert.equal(ctx2.castle.taskPark, null)
      assert.deepEqual(ctx2.castle.parkHist, { day: '2001-09-09', n: 1 }, 'history rides the resume')
      assert.equal(resumeChats(bot2).length, 1)
    } finally {
      try { fs.unlinkSync(file) } catch (_) { /* tmp best-effort */ }
    }
  })

  it('stale episode clears silently when the task finished under the park', () => {
    const bot = makeBot()
    const { ctx } = castleCtx(bot)
    const t0 = 1000000000000
    taskMod.taskTick(bot, ctx, t0)
    const t1 = advance(bot, ctx, t0, 45)
    assert.ok(ctx.castle.taskPark)
    ctx.castle.phase = 'complete' // owner finished by hand mid-park
    const chatsBefore = bot.chats.length
    taskMod.taskTick(bot, ctx, t1 + 1000)
    assert.equal(ctx.castle.taskPark, null)
    assert.equal(ctx.castle.parked, false)
    assert.equal(bot.chats.length, chatsBefore, 'silent clear')
  })

  it("running flat order pauses the clock (vmzq.8); parked flat doesn't", () => {
    const bot = makeBot()
    const { ctx } = castleCtx(bot)
    const t0 = 1000000000000
    taskMod.taskTick(bot, ctx, t0)
    // 20 min flattening on owner request: silent, clock held.
    ctx.flat = { phase: 'walk', parked: false }
    advance(bot, ctx, t0, 20)
    assert.equal(taskLogs().length, 0)
    assert.equal(bot.chats.length, 0)
    assert.equal(ctx.task.castle.stallMs, 0)
    // A parked (stopped) flat episode is not running: the clock advances.
    ctx.flat.parked = true
    const t1 = t0 + 20 * 60 * 1000
    advance(bot, ctx, t1, 15)
    assert.equal(taskLogs().length, 1, 'parked flat does not pause')
    assert.equal(bot.chats.length, 1)
  })
})
