'use strict'

// Unit tests for the goal arbiter (epic rw4.1): facts, FSM priority and the
// decision point. Behaviour execution is covered in tick.test.js.
const { describe, it, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const { MENU, STEP_ORDER, NEED_LOGS, NEED_PLANKS, goalFacts, goalText, goalFsm, decide, chooseStep, restWhy, STEP_CRITERIA, ASK_INSTRUCTIONS, siteFor } = require('../src/goal')
const resources = require('../src/resources')
const home = require('../src/behaviours/home')

function pos(x, y, z) {
  const p = {
    x, y, z,
    distanceTo: (q) => Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z),
    clone() { return pos(p.x, p.y, p.z) },
    floored() { return pos(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)) }
  }
  return p
}

function goalBot({ items = [], timeOfDay = 6000, at = pos(0, 64, 0), spawn = pos(0, 64, 0) } = {}) {
  const chats = []
  return {
    chats,
    entity: { position: at },
    inventory: { items: () => items },
    time: timeOfDay === null ? undefined : { timeOfDay },
    spawnPoint: spawn,
    chat: (m) => { chats.push(m) },
  }
}

describe('goal constants and menu shape', () => {
  it('house budget constants', () => {
    assert.equal(NEED_LOGS, 14)
    assert.equal(NEED_PLANKS, 48)
  })

  it('menu has all nine steps with feasible and chat functions', () => {
    assert.deepEqual(Object.keys(MENU).sort(), ['build', 'craft', 'deliver', 'explore', 'forage', 'gather', 'gohome', 'rest', 'stay'])
    for (const name of Object.keys(MENU)) {
      assert.equal(typeof MENU[name].feasible, 'function', `${name}.feasible`)
      assert.equal(typeof MENU[name].chat, 'function', `${name}.chat`)
    }
    assert.deepEqual(STEP_ORDER, ['stay', 'gohome', 'craft', 'build', 'gather', 'deliver', 'forage', 'explore', 'rest'])
  })
})

describe('goalFacts', () => {
  it('reads time of day on day/dusk/night boundaries', () => {
    for (const [tod, want] of [[0, 'day'], [11999, 'day'], [12000, 'dusk'], [12500, 'dusk'], [13000, 'dusk'], [13001, 'night'], [18000, 'night']]) {
      assert.equal(goalFacts(goalBot({ timeOfDay: tod }), {}).time, want, `tod=${tod}`)
    }
    assert.equal(goalFacts(goalBot({ timeOfDay: null }), {}).time, 'day') // unknown reads as day
  })

  it('counts inventory by suffix, ignores the rest', () => {
    const bot = goalBot({
      items: [
        { name: 'oak_log', count: 3 }, { name: 'birch_log', count: 2 },
        { name: 'oak_planks', count: 10 }, { name: 'crafting_table', count: 1 },
        { name: 'stone', count: 64 }, { name: 'iron_sword', count: 1 },
      ],
    })
    const facts = goalFacts(bot, {})
    assert.equal(facts.logs, 5)
    assert.equal(facts.planks, 10)
    assert.equal(facts.table, 1)
    assert.equal(facts.door, 0)
  })

  it('missing inventory counts zero without throwing', () => {
    const facts = goalFacts({ entity: { position: pos(0, 64, 0) } }, {})
    assert.equal(facts.logs, 0)
    assert.equal(facts.planks, 0)
    assert.equal(facts.table, 0)
    assert.equal(facts.door, 0)
  })

  it('home none/site/built from ctx.home', () => {
    assert.equal(goalFacts(goalBot(), {}).home, 'none')
    assert.equal(goalFacts(goalBot(), { home: { site: pos(10, 64, 10) } }).home, 'site')
    assert.equal(goalFacts(goalBot(), { home: { site: pos(10, 64, 10), built: true } }).home, 'built')
  })

  it('inside yes/no from ctx.home.interior', () => {
    const interior = { min: { x: 9, y: 63, z: 9 }, max: { x: 12, y: 66, z: 12 } }
    const ctx = { home: { site: pos(10, 64, 10), built: true, interior } }
    assert.equal(goalFacts(goalBot({ at: pos(10, 64, 10) }), ctx).inside, 'yes')
    assert.equal(goalFacts(goalBot({ at: pos(50, 64, 50) }), ctx).inside, 'no')
    assert.equal(goalFacts(goalBot(), {}).inside, 'no') // no home, no interior
  })

  it('goalText is the canonical facts line', () => {
    assert.equal(goalText({ time: 'day', logs: 3, planks: 0, table: 0, door: 0, home: 'none', inside: 'no', health: 20, food: 20, known: 'none', haul: 'none', player: 'none' }), 'time=day logs=few planks=none table=no door=no home=none inside=no health=ok food=ok known=none haul=none player=none')
    assert.equal(goalText({ time: 'night', logs: 14, planks: 48, table: 2, door: 1, home: 'built', inside: 'yes', health: 4, food: 3, known: 'near', haul: 'waiting', player: 'near' }), 'time=night logs=enough planks=enough table=yes door=yes home=built inside=yes health=low food=hungry known=near haul=waiting player=near')
  })
})

describe('MENU feasibility gates', () => {
  const F = (name, facts, bot, ctx) => MENU[name].feasible(facts, bot, ctx)
  const base = { time: 'day', logs: 0, planks: 0, maxPlanks: 0, table: 0, door: 0, home: 'none', tablePlaced: false, inside: 'no' }
  it('gather runs while material is missing, not once built', () => {
    assert.equal(F('gather', base), true) // empty hands: gather
    assert.equal(F('gather', { ...base, logs: 5 }), true) // mid-load: keep gathering
    assert.equal(F('gather', { ...base, home: 'built' }), false) // job done: rest becomes reachable
  })
  it('gather finishes the load instead of deadlocking on rest', () => {
    // Review state: 1 log + 46 planks + kit. Stopping here strands a
    // sub-batch craft can never take (batch gate needs 14) — gather stays
    // feasible until the load is full, then craft/build take over.
    assert.equal(F('gather', { ...base, logs: 1, planks: 46, table: 1, door: 1 }), true)
    assert.equal(F('craft', { ...base, logs: 1, planks: 46, table: 1, door: 1 }), false)
    // Sufficient material but no site: build defaults the site to spawn
    // (bead .4 batch gate); the owner moves it with 'build here'.
    const ready = { ...base, logs: 0, planks: 48, table: 1, door: 1, home: 'none' }
    assert.equal(F('gather', ready), false)
    assert.equal(F('craft', ready), false)
    assert.equal(F('build', ready, goalBot(), {}), true)
    assert.equal(goalFsm(ready, ['rest']), 'rest')
  })
  it('craft starts on a full load, not on the first log', () => {
    assert.equal(F('craft', base), false)
    assert.equal(F('craft', { ...base, logs: 5 }), false) // no per-log preempt churn
    assert.equal(F('craft', { ...base, logs: 14 }), true) // full batch
    assert.equal(F('craft', { ...base, planks: 5, maxPlanks: 5 }), true) // leftovers finish table/door
    assert.equal(F('craft', { ...base, planks: 56, maxPlanks: 56, table: 1, door: 1 }), false) // nothing left to craft
  })
  it('stay holds at dusk and night inside a built home, never by day', () => {
    // Revmux 01-review loop+goal-3.
    const indoors = { ...base, home: 'built', inside: 'yes' }
    assert.equal(F('stay', { ...indoors, time: 'dusk' }), true)
    assert.equal(F('stay', { ...indoors, time: 'night' }), true)
    assert.equal(F('stay', { ...indoors, time: 'day' }), false)
    assert.equal(F('stay', { ...base, time: 'dusk', home: 'built', inside: 'no' }), false)
    assert.equal(F('stay', { ...base, time: 'night', home: 'none', inside: 'yes' }), false)
  })
  it('build works in batches from spawn or a site — never without material', () => {
    const bot = goalBot() // spawnPoint set; no blockAt: the homeless path scans nothing
    assert.equal(F('build', { ...base, planks: 48 }, goalBot({ spawn: null }), {}), false) // no home, no spawn
    assert.equal(F('build', { ...base, planks: 48 }, bot, {}), true) // homeless: defaults the site
    assert.equal(F('build', { ...base, planks: 16 }, bot, {}), true) // one full batch
    assert.equal(F('build', { ...base, planks: 15 }, bot, {}), false) // short of a batch
    const siteCtx = { home: siteFor(bot, pos(0, 64, 0)) } // all cells read missing: full remainder
    const kit = { table: 1, door: 1 } // the item gate needs both held for a full remainder
    assert.equal(F('build', { ...base, ...kit, planks: 48, home: 'site' }, bot, siteCtx), true)
    assert.equal(F('build', { ...base, ...kit, planks: 15, home: 'site' }, bot, siteCtx), false)
    // item gate: an unfinished door/table without its item yields (no livelock)
    assert.equal(F('build', { ...base, planks: 48, table: 1, door: 0, home: 'site' }, bot, siteCtx), false)
    assert.equal(F('build', { ...base, planks: 48, table: 0, door: 1, home: 'site' }, bot, siteCtx), false)
  })
})

describe('goalFsm priority', () => {
  const day = { time: 'day' }
  it('night inside a built home stays', () => {
    assert.equal(goalFsm({ time: 'night' }, ['stay', 'gohome', 'craft', 'rest']), 'stay')
  })
  it('dusk with a site goes home before crafting', () => {
    assert.equal(goalFsm({ time: 'dusk' }, ['gohome', 'craft', 'gather', 'rest']), 'gohome')
  })
  it('dusk inside a built home stays (gohome hands off to stay, not roaming rest)', () => {
    // Revmux 01-review loop+goal-3: stay used to be night-only.
    assert.equal(goalFsm({ time: 'dusk' }, ['stay', 'gohome', 'craft', 'rest']), 'stay')
    assert.equal(goalFsm({ time: 'night' }, ['stay', 'gohome', 'craft', 'rest']), 'stay')
  })
  it('day: craft > build > gather > rest', () => {
    assert.equal(goalFsm(day, ['craft', 'build', 'gather', 'rest']), 'craft')
    assert.equal(goalFsm(day, ['build', 'gather', 'rest']), 'build')
    assert.equal(goalFsm(day, ['gather', 'rest']), 'gather')
    assert.equal(goalFsm(day, ['rest']), 'rest')
  })
  it('day skips night steps even when passed', () => {
    assert.equal(goalFsm(day, ['stay', 'gohome', 'rest']), 'rest')
  })
  it('empty feasible set falls back to rest', () => {
    assert.equal(goalFsm(day, []), 'rest')
  })
})

describe('atl.2 menu: forage/deliver/explore priority', () => {
  const F = (name, facts, bot, ctx) => MENU[name].feasible(facts, bot, ctx)
  // Names exactly like decide() computes them: MENU filter, then FSM rank.
  const feasibleNames = (facts, bot, ctx) => STEP_ORDER.filter((n) => {
    try { return MENU[n].feasible(facts, bot, ctx) } catch (_) { return false }
  })
  const memCtx = (cells, items) => {
    const bot = goalBot({ items: items || [] })
    const ctx = { home: { built: true } }
    resources.noteSpots(ctx, cells, 1000)
    return { bot, ctx }
  }
  it('known ore routes to forage', () => {
    const { bot, ctx } = memCtx([{ x: 5, y: 60, z: 0, name: 'iron_ore' }], [{ name: 'stone_pickaxe', count: 1 }])
    const facts = goalFacts(bot, ctx)
    assert.equal(facts.known, 'near')
    assert.equal(F('forage', facts), true)
    assert.equal(goalFsm(facts, feasibleNames(facts, bot, ctx)), 'forage')
  })
  it('waiting haul plus player routes to deliver first', () => {
    const { bot, ctx } = memCtx(
      [{ x: 5, y: 60, z: 0, name: 'iron_ore' }],
      [{ name: 'stone_pickaxe', count: 1 }, { name: 'raw_iron', count: 8 }])
    ctx.haul = { raw_iron: 8 }
    bot.players = { P: { username: 'P', entity: { position: pos(2, 64, 0) } } }
    const facts = goalFacts(bot, ctx)
    assert.equal(facts.haul, 'waiting')
    assert.equal(facts.player, 'near')
    assert.equal(F('deliver', facts), true)
    assert.equal(goalFsm(facts, feasibleNames(facts, bot, ctx)), 'deliver')
  })
  it('nothing known routes to explore once built', () => {
    const bot = goalBot()
    const ctx = { home: { built: true } }
    const facts = goalFacts(bot, ctx)
    assert.equal(facts.known, 'none')
    assert.equal(F('explore', facts), true)
    assert.equal(F('forage', facts), false)
    assert.equal(goalFsm(facts, feasibleNames(facts, bot, ctx)), 'explore')
  })
  it('pre-house gaps rest: explore waits for the house', () => {
    // Full kit but nowhere to build (no home, no spawn origin): rw4 steps
    // all refuse, explore stays gated, rest fills the gap.
    const bot = goalBot({
      items: [{ name: 'oak_planks', count: 48 }, { name: 'crafting_table', count: 1 }, { name: 'oak_door', count: 1 }],
      spawn: null,
    })
    const ctx = {}
    const facts = goalFacts(bot, ctx)
    assert.equal(F('explore', facts), false)
    assert.equal(goalFsm(facts, feasibleNames(facts, bot, ctx)), 'rest')
  })
  it('night safety beats a waiting haul', () => {
    const bot = goalBot({ timeOfDay: 15000, items: [{ name: 'coal', count: 8 }] })
    const ctx = { home: { built: true }, haul: { coal: 8 } }
    bot.players = { P: { username: 'P', entity: { position: pos(2, 64, 0) } } }
    const facts = goalFacts(bot, ctx)
    assert.equal(facts.time, 'night')
    assert.equal(goalFsm(facts, feasibleNames(facts, bot, ctx)), 'gohome')
  })
  it('nobody online parks deliver: the forage loop continues (dxl)', () => {
    const { bot, ctx } = memCtx(
      [{ x: 5, y: 60, z: 0, name: 'iron_ore' }],
      [{ name: 'stone_pickaxe', count: 1 }, { name: 'raw_iron', count: 8 }])
    ctx.haul = { raw_iron: 8 }
    const facts = goalFacts(bot, ctx)
    assert.equal(facts.player, 'none')
    assert.equal(F('deliver', facts), false)
    assert.equal(goalFsm(facts, feasibleNames(facts, bot, ctx)), 'forage')
  })
  it('criteria name one fact each', () => {
    assert.ok(STEP_CRITERIA.forage.includes('known is near'))
    assert.ok(STEP_CRITERIA.deliver.includes('haul is waiting'))
    assert.ok(STEP_CRITERIA.explore.includes('known is none'))
  })
  it('decide picks forage when a find is known', async () => {
    const bot = goalBot({ items: [{ name: 'stone_pickaxe', count: 1 }] })
    const ctx = { home: { built: true }, brain: {} }
    resources.noteSpots(ctx, [{ x: 5, y: 60, z: 0, name: 'iron_ore' }], 1000)
    const r = await decide(bot, ctx)
    assert.deepEqual(r, { action: 'forage', sprint: false, source: 'goal-fsm' })
    assert.equal(ctx.step, 'forage')
  })
})

describe('atl.4 livelock guard: a holding failure bars its step', () => {
  const logsBot = (n, at) => {
    const items = []
    for (let i = 0; i < n; i++) items.push({ name: 'oak_log', count: 1 })
    return goalBot({ items, at: at || pos(0, 64, 0) })
  }
  it('failed gather is infeasible while the log count stands, decide rests', async () => {
    // Bead-literal: no house yet, so explore is gated too — rest, not gather.
    const bot = logsBot(9)
    const ctx = { home: { site: pos(10, 64, 10) }, gather: { final: 'failed:unreachable', atLogs: 9 }, brain: {} }
    const facts = goalFacts(bot, ctx)
    assert.equal(facts.logs, 9)
    assert.equal(MENU.gather.feasible(facts, bot, ctx), false)
    const r = await decide(bot, ctx)
    assert.equal(r.action, 'rest')
  })
  it('failed gather routes to explore once the house stands', async () => {
    // atl.2 menu: the atLogs final outlives the home transition, so the
    // FSM takes explore instead of re-picking gather or idling on rest.
    const bot = logsBot(9)
    const ctx = { home: { built: true }, gather: { final: 'failed:unreachable', atLogs: 9 }, brain: {} }
    const r = await decide(bot, ctx)
    assert.equal(r.action, 'explore')
  })
  it('new logs release gather: the final no longer holds', async () => {
    const bot = logsBot(10)
    const ctx = { home: { site: pos(10, 64, 10) }, gather: { final: 'failed:unreachable', atLogs: 9 }, brain: {} }
    const facts = goalFacts(bot, ctx)
    assert.equal(MENU.gather.feasible(facts, bot, ctx), true)
  })
  it('any failed step holds until the situation moves: craft waits, relocation releases', async () => {
    const bot = logsBot(14) // craft feasible on a full load
    const ctx = { home: { site: pos(10, 64, 10) }, brain: {}, step: 'craft', stepStatus: 'failed:no-table' }
    const first = await decide(bot, ctx)
    assert.equal(first.action, 'gather') // craft held at the failure point
    // Gather fails away from the point: craft's hold releases by distance.
    bot.entity.position = pos(40, 64, 0)
    ctx.stepStatus = 'failed:away'
    const second = await decide(bot, ctx)
    assert.equal(second.action, 'craft')
  })
  it('a done step retires its own hold: the next identical failure re-arms fresh', async () => {
    // Round-1 major: records never expired, so a stale failure re-armed
    // hours later. A success deletes its own record.
    const bot = logsBot(14)
    const ctx = { home: { site: pos(10, 64, 10) }, brain: {}, step: 'craft', stepStatus: 'failed:no-table' }
    await decide(bot, ctx) // records + holds craft
    assert.ok(ctx.stepFail && ctx.stepFail.craft, 'recorded')
    ctx.step = 'craft' // the step runs again and finishes done
    ctx.stepStatus = 'done'
    const r = await decide(bot, ctx)
    assert.equal(ctx.stepFail.craft, undefined, 'retired by the success')
    assert.equal(r.action, 'craft')
  })
  it('new facts release the hold without moving', async () => {
    const bot = logsBot(14)
    const ctx = { home: { built: true }, brain: {}, step: 'craft', stepStatus: 'failed:no-table' }
    await decide(bot, ctx) // craft held under these facts
    ctx.haul = { coal: 5 } // banked haul flips the facts line; no player, so deliver stays out
    bot.inventory = { items: () => [{ name: 'oak_log', count: 14 }, { name: 'coal', count: 5 }] }
    ctx.step = 'gather'
    ctx.stepStatus = 'running'
    ctx.goalText = 'stale'
    const r = await decide(bot, ctx)
    assert.equal(r.action, 'craft')
  })
})

describe('atl.4 exemptions: self-advancing failures never hold', () => {
  it('explore is re-picked after its own failure: the point is consumed', async () => {
    // Holding explore would deadlock the spiral after one river: the failed
    // point is visited and the next pick is a new target by construction.
    const bot = goalBot()
    const ctx = { home: { built: true }, brain: {}, step: 'explore', stepStatus: 'failed:unreachable' }
    const r = await decide(bot, ctx)
    assert.equal(r.action, 'explore')
  })
})

describe('decide decision point', () => {
  let origLog
  let lines
  beforeEach(() => {
    origLog = console.log
    lines = []
    console.log = (line) => { lines.push(String(line)) }
  })
  afterEach(() => { console.log = origLog })

  const goalLines = () => lines.filter((l) => l.includes('goal step='))

  it('first decision picks gather, logs and chats once', async () => {
    const bot = goalBot()
    const ctx = {}
    const r = await decide(bot, ctx)
    assert.deepEqual(r, { action: 'gather', sprint: false, source: 'goal-fsm' })
    assert.equal(ctx.step, 'gather')
    assert.equal(ctx.stepStatus, 'running')
    assert.deepEqual(goalLines(), [`goal step=gather prev=none source=goal-fsm fsm=gather why=start facts=${goalText(goalFacts(bot, ctx))}`])
    assert.deepEqual(bot.chats, ['next: chopping wood (goal-fsm)'])
  })

  it('same facts with a running step: no change, no log, no chat', async () => {
    const bot = goalBot()
    const ctx = {}
    await decide(bot, ctx)
    lines.length = 0
    bot.chats.length = 0
    const r = await decide(bot, ctx)
    assert.equal(r.action, 'gather')
    assert.deepEqual(goalLines(), [])
    assert.deepEqual(bot.chats, [])
  })

  it('gohome keeps the step after stepping inside (stay must not preempt close)', async () => {
    const bot = goalBot({ timeOfDay: 15000, at: pos(11, 64, 21) })
    const ctx = {
      step: 'gohome',
      stepStatus: 'running',
      gohome: { phase: 'enter', stalls: 0, fails: 0, lastPos: null, lastToggle: 0 },
      goalText: 'stale',
      home: { site: pos(10, 64, 20), built: true, interior: { min: { x: 11, y: 64, z: 21 }, max: { x: 12, y: 65, z: 22 } } },
    }
    const r = await decide(bot, ctx)
    assert.equal(r.action, 'gohome')
    assert.equal(ctx.step, 'gohome')
    assert.deepEqual(goalLines(), [])
    assert.deepEqual(bot.chats, [])
  })

  it('stay keeps the step after stepping out on a morning exit', async () => {
    const bot = goalBot({ timeOfDay: 1000, at: pos(11, 64, 19) })
    const ctx = {
      step: 'stay',
      stepStatus: 'running',
      stay: { phase: 'exit', stalls: 0, fails: 0, lastPos: null, lastToggle: 0 },
      goalText: 'stale',
      home: { site: pos(10, 64, 20), built: true, interior: { min: { x: 11, y: 64, z: 21 }, max: { x: 12, y: 65, z: 22 } } },
    }
    const r = await decide(bot, ctx)
    assert.equal(r.action, 'stay')
    assert.deepEqual(goalLines(), [])
  })

  it('day decide clears a leftover shelter flag', async () => {
    // Revmux 01-review loop+goal-3: a sticky gohome finishing after sunrise
    // leaves inShelter true with no stay step to clear it.
    const bot = goalBot({ timeOfDay: 1000 })
    const ctx = { inShelter: true }
    await decide(bot, ctx)
    assert.equal(ctx.inShelter, false)
  })
  it('re-armed gohome survives the inside transition (stale failed status)', async () => {
    // Revmux 03-review: with a stale failed status decide early-returns and
    // dispatches gohome; the re-arm restores 'running' so the sticky guard
    // holds the phase machine through enter->close instead of handing stay
    // the step the tick the bot steps inside.
    const house = { site: pos(10, 64, 20), built: true, interior: { min: { x: 11, y: 64, z: 21 }, max: { x: 12, y: 65, z: 22 } } }
    const bot = goalBot({ timeOfDay: 15000, at: pos(11, 64, 19) }) // outside the door
    const ctx = {
      step: 'gohome',
      stepStatus: 'failed:cannot-reach-home',
      gohome: { phase: 'failed', stalls: 0, fails: 3, lastPos: null, lastToggle: 0, legIdx: 0, legTicks: 0 },
      home: house,
    }
    ctx.goalText = goalText(goalFacts(bot, ctx))
    ctx.askedKey = `${ctx.goalText}\n${ctx.stepStatus}` // same facts: decide early-returns
    const r1 = await decide(bot, ctx)
    assert.equal(r1.action, 'gohome')
    home.gohome(bot, ctx) // re-arm: walk arrived at the door, enter leg runs, status restored
    assert.equal(ctx.gohome.phase, 'enter')
    assert.equal(ctx.stepStatus, 'running')
    bot.entity.position = pos(11, 64, 21) // physics carries the bot inside
    const r2 = await decide(bot, ctx)
    assert.equal(r2.action, 'gohome') // sticky holds; stay must not preempt close
    assert.deepEqual(goalLines(), [])
  })
  it('finished night phase re-arms choice (gohome done inside at night -> stay)', async () => {
    const bot = goalBot({ timeOfDay: 15000, at: pos(11, 64, 21) })
    const ctx = {
      step: 'gohome',
      stepStatus: 'done',
      gohome: { phase: 'done', stalls: 0, fails: 0, lastPos: null, lastToggle: 0 },
      home: { site: pos(10, 64, 20), built: true, interior: { min: { x: 11, y: 64, z: 21 }, max: { x: 12, y: 65, z: 22 } } },
    }
    const r = await decide(bot, ctx)
    assert.equal(r.action, 'stay')
  })

  it('done step re-decides (logs only on change)', async () => {
    const bot = goalBot()
    const ctx = {}
    await decide(bot, ctx)
    ctx.stepStatus = 'done'
    lines.length = 0
    bot.chats.length = 0
    const r = await decide(bot, ctx)
    assert.equal(r.action, 'gather')
    assert.equal(ctx.stepStatus, 'running')
    assert.deepEqual(goalLines(), []) // same step again: silent restart
    assert.deepEqual(bot.chats, [])
  })

  it('failed step moves on (atl.4)', async () => {
    // Re-picking the just-failed step with an unchanged situation was the
    // gather livelock: the guard routes to rest instead.
    const bot = goalBot()
    const ctx = {}
    await decide(bot, ctx)
    ctx.stepStatus = 'failed:no-trees'
    const r = await decide(bot, ctx)
    assert.equal(r.action, 'rest')
    assert.equal(ctx.stepStatus, 'running')
  })

  it('changed facts re-decide', async () => {
    const bot = goalBot()
    const ctx = {}
    await decide(bot, ctx)
    bot._items = undefined
    bot.inventory = { items: () => [{ name: 'oak_log', count: 3 }] } // logs 0 -> 3
    lines.length = 0
    const r = await decide(bot, ctx)
    assert.equal(r.action, 'gather') // craft feasible but unregistered: gather runs now that rw4.2 registered it
    assert.ok(ctx.goalText.includes('logs=few'))
  })

  it('table in inventory does not unlock craft: build lays it', async () => {
    // A door recipe requires the table block, so craft stays out — but with
    // build registered (rw4.4) the full kit defaults a site at spawn and
    // builds instead of resting.
    const bot = goalBot({ items: [{ name: 'oak_planks', count: 58 }, { name: 'crafting_table', count: 1 }] })
    const r = await decide(bot, {})
    assert.equal(r.action, 'build')
  })

  it('placed table unlocks craft for the door', async () => {
    const bot = goalBot({ items: [{ name: 'oak_planks', count: 6 }] })
    const r = await decide(bot, { home: { table: pos(2, 64, 0) } })
    assert.equal(r.action, 'craft')
  })

  it('placed table with door done gathers on (table clause needs no table)', async () => {
    // 10 planks are short of the 48 budget, so gather (not rest) is correct
    // here — but never craft: with the door done only the table clause could
    // fire, and the placed table guards it. Deleting the guard picks craft.
    const bot = goalBot({ items: [{ name: 'oak_planks', count: 10 }, { name: 'oak_door', count: 1 }] })
    const r = await decide(bot, { home: { table: pos(2, 64, 0) } })
    assert.equal(r.action, 'gather')
  })

  it('mixed planks from outside gather on (recipes cannot mix woods)', async () => {
    // 2+2 needs more material, so gather (not rest) is correct — but never
    // craft: total-planks clauses would fire on the mixed 4. Deleting the
    // per-wood counts picks craft into a done-forever loop.
    const bot = goalBot({ items: [{ name: 'oak_planks', count: 2 }, { name: 'birch_planks', count: 2 }] })
    const r = await decide(bot, {})
    assert.equal(r.action, 'gather')
  })

  it('full kit on a build site runs build', async () => {
    // Build joined in rw4.4 and is registered: a full kit on a build site
    // is feasible AND runs (craft and gather both correctly stay out).
    const bot = goalBot({ items: [
      { name: 'oak_planks', count: 48 },
      { name: 'crafting_table', count: 1 },
      { name: 'oak_door', count: 1 },
    ] })
    const r = await decide(bot, { home: { table: pos(2, 64, 0) } })
    assert.equal(r.action, 'build')
  })

  it('chooseStep single feasible step: only-option, brain not asked', async () => {
    // (a) only-option: full kit, no site — rest is the only registered step.
    // The brain explodes if consulted: source must be only-option, not goal-fsm.
    const bot = goalBot({ items: [
      { name: 'oak_planks', count: 48 },
      { name: 'crafting_table', count: 1 },
      { name: 'oak_door', count: 1 },
    ] })
    const facts = goalFacts(bot, {})
    const boom = { source: 'laya', ask: async () => { throw new Error('asked with one option') } }
    const r = await chooseStep(boom, facts, ['rest'])
    assert.deepEqual(r, { step: 'rest', source: 'only-option', fsm: 'rest', model: null })
  })

  it('chooseStep model answer flows through; disagreement logged on fsm split', async () => {
    // (b) craft answered by laya on a craft menu (fsm agrees here: craft tops
    // the order, so agreement is the honest expectation)...
    const facts = { time: 'day', logs: 0, planks: 5, maxPlanks: 5, table: 0, door: 0, home: 'none', tablePlaced: false, inside: 'no', health: 20, food: 20 }
    const laya = { source: 'laya', ask: async () => 'craft' }
    const r = await chooseStep(laya, facts, ['craft', 'gather', 'rest'])
    assert.equal(r.step, 'craft')
    assert.equal(r.source, 'laya')
    assert.equal(r.fsm, 'craft')
    // ...while a rest answer against a gather fsm is the disagreement case:
    // STEP_ORDER ranks craft above gather, so no menu can pair a craft answer
    // with a gather fsm — the machinery is proven on rest-vs-gather instead.
    const errLines = []
    const origErr = console.error
    console.error = (l) => { errLines.push(String(l)) }
    try {
      const r2 = await chooseStep(laya, { ...facts, logs: 0, planks: 0, maxPlanks: 0 }, ['gather', 'rest'])
      const layaRest = { source: 'laya', ask: async () => 'rest' }
      const r3 = await chooseStep(layaRest, { ...facts, logs: 0, planks: 0, maxPlanks: 0 }, ['gather', 'rest'])
      assert.equal(r2.step, 'gather') // control: fsm path agrees silently
      assert.equal(r3.step, 'rest')
      assert.equal(r3.source, 'laya')
      assert.ok(errLines.some((l) => l.includes('goal disagree') && l.includes('model=rest') && l.includes('fsm=gather')),
        `disagreement logged, got: ${errLines.join(' | ')}`)
    } finally {
      console.error = origErr
    }
  })

  it('chooseStep timeout falls back to fsm with escalation counted', async () => {
    // (c) timeout: the FSM step runs, source is fsm-fallback.
    const facts = { time: 'day', logs: 0, planks: 0, maxPlanks: 0, table: 0, door: 0, home: 'none', tablePlaced: false, inside: 'no', health: 20, food: 20 }
    const slow = { source: 'laya', ask: async () => { const e = new Error('slow'); e.name = 'TimeoutError'; throw e } }
    const r = await chooseStep(slow, facts, ['gather', 'rest'])
    assert.deepEqual(r, { step: 'gather', source: 'fsm-fallback', fsm: 'gather', model: 'laya' })
    const metrics = require('../src/metrics')
    const text = await metrics.client.register.metrics()
    assert.match(text, /idkcraft_bot_escalation_total\{from="laya",to="fsm",reason="timeout"\} [1-9]/)
  })

  it('decide asks once per decision point, not per tick', async () => {
    // (e) same goalText + running step: ask is not called again. Deleting the
    // change gate (ask every tick) fails this test.
    const bot = goalBot()
    const brain = { source: 'laya', calls: 0, ask: async function () { this.calls++; return 'gather' } }
    const ctx = { brain }
    await decide(bot, ctx)
    assert.equal(brain.calls, 1)
    await decide(bot, ctx)
    await decide(bot, ctx)
    assert.equal(brain.calls, 1, 'no re-ask without a decision point')
  })

  it('goal metrics count the model choice', async () => {
    // (f) goal_steps_total, goal_step gauge, goal_choice_duration.
    const bot = goalBot()
    const brain = { source: 'laya', ask: async () => 'gather' }
    await decide(bot, { brain })
    const metrics = require('../src/metrics')
    const text = await metrics.client.register.metrics()
    assert.match(text, /idkcraft_bot_goal_steps_total\{step="gather",source="laya"\} [1-9]/)
    assert.match(text, /idkcraft_bot_goal_step\{step="gather"\} 1/)
    assert.match(text, /idkcraft_bot_goal_choice_duration_seconds_count\{source="laya"\} [1-9]/)
  })

  it('full load hands gather to craft', async () => {
    // craft joined in rw4.3; build joins in rw4.4. Over a full load
    // (15 logs = 60 plank-equivalent over the 58 budget) gather is done
    // and craft — now registered — runs instead of rest.
    const bot = goalBot({ items: [{ name: 'oak_log', count: 15 }] })
    const r = await decide(bot, {})
    assert.equal(r.action, 'craft')
  })
})

describe('decide failed-step dedup (revmux 01 major)', () => {
  it('a step that fails again with unchanged facts asks once', async () => {
    // atl.4: the failed step leaves the menu, so the repeat re-decides to
    // rest without asking (only-option); further ticks reuse the choice.
    // Deleting the (text, status) gate (ask every tick) still fails this
    // test: a fresh multi-option point would ask on every tick.
    const bot = goalBot()
    const brain = { source: 'laya', calls: 0, ask: async function () { this.calls++; return 'gather' } }
    const ctx = { brain }
    await decide(bot, ctx)
    assert.equal(brain.calls, 1)
    ctx.stepStatus = 'failed:no-trees' // behaviour re-runs, fails identically
    await decide(bot, ctx)
    assert.equal(brain.calls, 1, 'repeat failure re-decides without asking')
    assert.equal(ctx.step, 'rest')
    await decide(bot, ctx)
    await decide(bot, ctx)
    assert.equal(brain.calls, 1, 'further ticks reuse the choice')
    assert.equal(ctx.step, 'rest')
  })
})
describe('atl.7 rest explains itself', () => {
  function siteHome() {
    return { site: { x: 0, y: 64, z: 0 }, table: { x: 4, y: 64, z: 1 }, built: false }
  }
  function ladenBot() {
    return goalBot({ items: [{ name: 'oak_planks', count: 56 }, { name: 'oak_door', count: 1 }] })
  }
  const ALL_OUT = [
    'stay: daytime',
    'gohome: daytime',
    'craft: table already placed',
    'build: need table/door item',
    'gather: load full',
    'deliver: nothing waiting',
    'forage: nothing known nearby',
    'explore: house not built yet',
  ]
  it('FSM rest chats every infeasible step with its reason', async () => {
    const bot = ladenBot()
    const ctx = { step: '', stepStatus: null, goalText: null, home: siteHome() }
    const r = await decide(bot, ctx)
    assert.equal(r.action, 'rest')
    const line = bot.chats.find((l) => l.startsWith('resting: '))
    assert.ok(line && line.endsWith('(only-option)'), `chats: ${bot.chats}`)
    assert.equal(line, `resting: ${ctx.restWhy} (only-option)`)
    for (const frag of ALL_OUT) assert.ok(line.includes(frag), `missing ${frag} in: ${line}`)
  })
  it('rest repeats stay silent but refresh the stored reason', async () => {
    const bot = ladenBot()
    const ctx = { step: '', stepStatus: null, goalText: null, home: siteHome() }
    await decide(bot, ctx)
    const n = bot.chats.length
    assert.ok(n > 0)
    await decide(bot, ctx)
    assert.equal(bot.chats.length, n)
    assert.ok(ctx.restWhy && ctx.restWhy.includes('gather: load full'))
  })
  it('model-chosen rest skips the feasible steps', async () => {
    const bot = goalBot({ items: [{ name: 'oak_planks', count: 56 }, { name: 'crafting_table', count: 1 }, { name: 'oak_door', count: 1 }] })
    const brain = { source: 'test', ask: async () => 'rest' }
    const ctx = { step: '', stepStatus: null, goalText: null, home: { site: { x: 6, y: 64, z: 0 }, built: true }, brain }
    const r = await decide(bot, ctx)
    assert.equal(r.action, 'rest')
    assert.ok(ctx.restWhy.includes('gather: home built'), `why: ${ctx.restWhy}`)
    assert.ok(!ctx.restWhy.includes('explore:'), `explore is feasible here: ${ctx.restWhy}`)
    assert.ok(bot.chats.some((l) => l.startsWith('resting: ') && l.endsWith('(test)')), `chats: ${bot.chats}`)
  })
  it('held steps report the hold, not the facts', async () => {
    const bot = ladenBot()
    const facts = goalFacts(bot, { home: siteHome() })
    const ctx = { gather: { final: 'failed:unreachable', atLogs: facts.logs } }
    const why = restWhy(facts, bot, ctx, ['rest'])
    assert.ok(why.includes('gather holds after failure'), `why: ${why}`)
    assert.ok(!why.includes('gather: load full'), `no stale facts wording: ${why}`)
  })
  it('long rest streak asks once with the reason text, then never again', async () => {
    const seen = []
    const brain = { source: 'test', ask: async (q) => { seen.push(q); return 'rest' } }
    const bot = ladenBot()
    const ctx = { step: '', stepStatus: null, goalText: null, home: siteHome(), brain }
    await decide(bot, ctx)
    assert.equal(seen.length, 0)
    ctx.restSince = Date.now() - 11 * 60 * 1000
    await decide(bot, ctx)
    assert.equal(seen.length, 1)
    assert.ok(seen[0].state.startsWith('resting long: '), `state: ${seen[0].state}`)
    assert.deepEqual(Object.keys(seen[0].criteria).sort(), ['recheck', 'rest'])
    assert.ok(seen[0].state.includes('gather: load full'), `reason rides along: ${seen[0].state}`)
    await decide(bot, ctx)
    assert.equal(seen.length, 1)
  })
  it('leaving rest clears the streak and the stored reason', async () => {
    const bot = goalBot({}) // empty hands: gather is feasible again
    const ctx = { step: 'rest', stepStatus: 'running', goalText: null, restSince: 1, restEscalated: true, restWhy: 'old', home: null }
    const r = await decide(bot, ctx)
    assert.equal(r.action, 'gather')
    assert.equal(ctx.restSince, null)
    assert.equal(ctx.restEscalated, false)
    assert.equal(ctx.restWhy, null)
  })
})
