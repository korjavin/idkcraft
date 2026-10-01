'use strict'

// Bead idkcraft-ipn.12: without a bed the respawn is world spawn (~230
// blocks from home in prod), and the night gohome march through the dark
// dies on repeat (prod: 53 of 62 deaths in gohome). At night far from home
// the bot shelters in place (pillar up, hold till dawn) instead of
// marching; dusk still marches at any distance, and near home at night the
// walk continues.

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const goal = require('../src/goal')
const home = require('../src/behaviours/home')
const retreat = require('../src/behaviours/retreat')
const { createTicker, BEHAVIOURS } = require('../src/index')

function pos(x, y, z) {
  const p = { x, y, z, distanceTo: (q) => Math.hypot(x - q.x, y - q.y, z - q.z) }
  p.clone = () => pos(p.x, p.y, p.z)
  p.floored = () => pos(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z))
  return p
}

function v2home(site) {
  return {
    site: { ...site },
    built: true,
    v: 2,
    interior: { min: { x: site.x + 1, y: site.y, z: site.z + 1 }, max: { x: site.x + 5, y: site.y + 1, z: site.z + 4 } },
    door: { x: site.x + 3, y: site.y, z: site.z },
  }
}

const SITE = { x: 200, y: 64, z: 200 } // the prod shape: home far from spawn

function nightBot(at, timeOfDay = 15000) {
  return {
    chats: [],
    username: 'IdkBot',
    players: {},
    entities: {},
    health: 20,
    food: 20,
    time: { timeOfDay, day: 5 },
    spawnPoint: pos(0, 64, 0),
    entity: { position: pos(at.x, at.y, at.z) },
    inventory: { items: () => [] },
    blockAt: () => ({ name: 'stone', boundingBox: 'block' }),
    findBlocks: () => [],
    pathfinder: { goal: null, setGoal: () => {}, isMoving: () => false },
    setControlState: () => {},
    clearControlStates: () => {},
    chat: (m) => {},
  }
}

describe('ipn.12 night-far menu: shelter owns it, gohome owns the rest', () => {
  const FGO = goal.MENU.gohome.feasible
  const FSH = goal.MENU.shelter.feasible

  it('night far: gohome infeasible, shelter feasible', () => {
    const bot = nightBot({ x: 0, y: 64, z: 0 })
    const ctx = { home: v2home(SITE) }
    const facts = { time: 'night', home: 'built', inside: 'no' }
    assert.equal(FGO(facts, bot, ctx), false, 'no death march')
    assert.equal(FSH(facts, bot, ctx), true, 'shelter owns the night-far')
  })

  it('night near: gohome walks, shelter stands down', () => {
    const bot = nightBot({ x: 195, y: 64, z: 195 })
    const ctx = { home: v2home(SITE) }
    const facts = { time: 'night', home: 'built', inside: 'no' }
    assert.equal(FGO(facts, bot, ctx), true)
    assert.equal(FSH(facts, bot, ctx), false)
  })

  it('dusk marches at any distance (the going-home window)', () => {
    const bot = nightBot({ x: 0, y: 64, z: 0 }, 12500)
    const ctx = { home: v2home(SITE) }
    const facts = { time: 'dusk', home: 'built', inside: 'no' }
    assert.equal(FGO(facts, bot, ctx), true, 'dusk walks home from anywhere')
    assert.equal(FSH(facts, bot, ctx), false, 'shelter is night-only')
  })

  it('day, inside, and unbuilt read infeasible with honest reasons', () => {
    const bot = nightBot({ x: 0, y: 64, z: 0 })
    const ctx = { home: v2home(SITE) }
    assert.equal(FSH({ time: 'day', home: 'built', inside: 'no' }, bot, ctx), false)
    assert.equal(goal.stepWhy('shelter', { time: 'day', home: 'built', inside: 'no' }, bot, ctx, ''), 'shelter: daytime')
    assert.equal(FSH({ time: 'night', home: 'built', inside: 'yes' }, bot, ctx), false)
    assert.equal(goal.stepWhy('shelter', { time: 'night', home: 'built', inside: 'yes' }, bot, ctx, ''), 'shelter: already inside')
    assert.equal(FSH({ time: 'night', home: 'site', inside: 'no' }, bot, ctx), false)
    assert.equal(goal.stepWhy('shelter', { time: 'night', home: 'site', inside: 'no' }, bot, ctx, ''), 'shelter: home not built')
    assert.equal(goal.stepWhy('gohome', { time: 'night', home: 'built', inside: 'no' }, bot, ctx, ''), 'gohome: too far to walk at night')
  })

  it('unreadable position keeps the old march (fail open)', () => {
    const bot = nightBot({ x: 0, y: 64, z: 0 })
    delete bot.entity
    const ctx = { home: v2home(SITE) }
    const facts = { time: 'night', home: 'built', inside: 'no' }
    assert.equal(FGO(facts, bot, ctx), true, 'unknown body still walks')
    assert.equal(FSH(facts, bot, ctx), false)
  })

  it('the range is the retreat single source; the fsm gates shelter to night', () => {
    assert.equal(typeof retreat.HOME_WALK_RANGE, 'number')
    assert.equal(goal.goalFsm({ time: 'night' }, ['shelter', 'craft', 'rest']), 'shelter', 'shelter outranks day steps')
    assert.equal(goal.goalFsm({ time: 'day' }, ['shelter', 'rest']), 'rest', 'day never shelters')
    assert.equal(goal.STEP_ORDER.indexOf('shelter'), goal.STEP_ORDER.indexOf('gohome') + 1)
    assert.equal(typeof goal.STEP_CRITERIA.shelter, 'string')
    assert.equal(typeof goal.MENU.shelter.chat, 'function')
  })
})

describe('ipn.12 decide: night-far shelters past feasible day steps', () => {
  // A full menu with craft AND equip feasible (distractors below shelter):
  // the night-far pick must still be shelter, the night-near and dusk-far
  // picks gohome.
  function menuBot(at, timeOfDay) {
    const bot = nightBot(at, timeOfDay)
    bot.inventory = {
      items: () => [
        { name: 'oak_log', count: 14 }, // craft feasible, gather not (14 !< 14)
        { name: 'cobblestone', count: 2 }, // scaffold low: equip feasible
      ],
    }
    // A finished house (build infeasible), bedrooms bedless.
    bot.blockAt = (p) => {
      const x = Math.floor(p.x)
      const y = Math.floor(p.y)
      const z = Math.floor(p.z)
      if (x === SITE.x + 5 && y === SITE.y && z === SITE.z + 1) return { name: 'crafting_table', boundingBox: 'block' }
      if (x === SITE.x + 3 && y === SITE.y && z === SITE.z) return { name: 'oak_door', boundingBox: 'block' }
      if (y < SITE.y) return { name: 'dirt', boundingBox: 'block' }
      return { name: 'oak_planks', boundingBox: 'block' }
    }
    bot.players = { Steve: { username: 'Steve', entity: { position: pos(5, 64, 5), username: 'Steve' } } }
    return bot
  }

  function menuCtx() {
    return {
      home: { ...v2home(SITE), table: { x: SITE.x + 5, y: SITE.y, z: SITE.z + 1 } },
      step: 'explore',
      stepStatus: 'done',
    }
  }

  it('night far shelters; night near and dusk far walk home', async () => {
    const origLog = console.log
    console.log = () => {}
    try {
      const far = await goal.decide(menuBot({ x: 0, y: 64, z: 0 }, 15000), menuCtx())
      assert.equal(far.action, 'shelter', 'night-far shelters past feasible craft/equip')
      const near = await goal.decide(menuBot({ x: 195, y: 64, z: 195 }, 15000), menuCtx())
      assert.equal(near.action, 'gohome', 'night-near walks home')
      const dusk = await goal.decide(menuBot({ x: 0, y: 64, z: 0 }, 12500), menuCtx())
      assert.equal(dusk.action, 'gohome', 'dusk-far marches')
    } finally {
      console.log = origLog
    }
  })

  it('a fresh shelter pick re-arms the pillar state', async () => {
    const origLog = console.log
    console.log = () => {}
    try {
      const bot = menuBot({ x: 0, y: 64, z: 0 }, 15000)
      const ctx = menuCtx()
      ctx.shelter = { pillared: true, pillarLogged: true } // stale from an order-interrupted night
      const r = await goal.decide(bot, ctx)
      assert.equal(r.action, 'shelter')
      assert.deepEqual(ctx.shelter, {}, 'fresh pick re-pillars')
    } finally {
      console.log = origLog
    }
  })
})

describe('ipn.12 shelter behaviour: pillar once, hold till dawn', () => {
  function holdBot() {
    const calls = { goals: [], stops: 0 }
    const bot = nightBot({ x: 0, y: 64, z: 0 })
    bot.inventory = { items: () => [] } // no scaffold: the pillar fails fast
    bot.pathfinder = {
      goal: { kind: 'stale' },
      isMoving: () => false,
      setGoal: (g) => { calls.goals.push(g) },
      stop: () => { calls.stops++ },
    }
    bot.calls = calls
    return bot
  }

  it('a failed pillar still holds (never fails, never marches)', () => {
    const bot = holdBot()
    const ctx = { home: v2home(SITE), step: 'shelter', stepStatus: 'running' }
    const origLog = console.log
    console.log = () => {}
    try {
      home.shelter(bot, ctx, null, null)
    } finally {
      console.log = origLog
    }
    assert.equal(ctx.stepStatus, 'running', 'no pillar, no failure — the hold is the point')
    assert.equal(ctx.inShelter, true, 'no fight pursuit off the hold')
    assert.equal(ctx.recovery, null, 'terminal episode released')
    assert.equal(ctx.shelter.pillared, true)
    assert.deepEqual(bot.calls.goals, [null], 'live goal cancelled, none issued')
    assert.equal(ctx.lastGoalKey, 'stay')
    // The hold is steady: no goals, no march on later ticks either.
    const heldLog = console.log
    console.log = () => {}
    try {
      for (let t = 0; t < 10; t++) home.shelter(bot, ctx, null, null)
    } finally {
      console.log = heldLog
    }
    assert.deepEqual(bot.calls.goals, [null], 'still holding, still no march')
    assert.equal(ctx.stepStatus, 'running')
  })

  it('an adopted pillar episode releases on done and holds', () => {
    const bot = holdBot()
    // A chain pillar episode the goal pick adopted (beginPillar shape).
    const ctx = {
      home: v2home(SITE), step: 'shelter', stepStatus: 'running',
      recovery: { action: 'pillar_up', source: 'retreat', model: null, status: 'done', st: {}, endEpisode: true },
    }
    home.shelter(bot, ctx, null, null)
    assert.equal(ctx.recovery, null, 'adopted episode released')
    assert.equal(ctx.shelter.pillared, true)
    assert.equal(ctx.stepStatus, 'running')
    assert.equal(ctx.inShelter, true)
  })

  it('dawn ends the step with the night report', () => {
    const chats = []
    const bot = holdBot()
    bot.chat = (m) => { chats.push(String(m)) }
    const ctx = { home: v2home(SITE), step: 'shelter', stepStatus: 'running', deaths: 1 }
    const origLog = console.log
    console.log = () => {}
    try {
      home.shelter(bot, ctx, null, null) // one night tick: pillars (fails), holds, opens the tally
      assert.ok(ctx.night && ctx.night.reported === false, 'night tally opened')
      bot.time = { timeOfDay: 1000, day: 6 }
      home.shelter(bot, ctx, null, null) // dawn: report and release
    } finally {
      console.log = origLog
    }
    assert.equal(ctx.stepStatus, 'done')
    assert.equal(ctx.inShelter, false)
    assert.ok(chats.some((m) => m.startsWith('night: survived,')), `dawn report chatted: ${JSON.stringify(chats)}`)
    assert.equal(ctx.night.reported, true, 'tally snapped like stay')
  })

  it('inside hands to stay; no home fails loud', () => {
    const bot = holdBot()
    bot.entity.position = pos(SITE.x + 2, SITE.y, SITE.z + 2) // inside the box
    const ctx = { home: v2home(SITE), step: 'shelter', stepStatus: 'running' }
    home.shelter(bot, ctx, null, null)
    assert.equal(ctx.stepStatus, 'done', 'stay owns the inside')
    const homeless = { step: 'shelter', stepStatus: 'running' }
    home.shelter(bot, homeless, null, null)
    assert.equal(homeless.stepStatus, 'failed:no-home')
  })
})

describe('ipn.12 shelter hold never raises the stuck backstop', () => {
  it('45 still shelter ticks: no episode, no march, step holds', async () => {
    // (e) mirror for the new night step: the hold owns its stillness.
    const bot = nightBot({ x: 0, y: 64, z: 0 })
    bot.players = { Steve: { username: 'Steve', entity: { id: 7, position: pos(10, 64, 0) } } }
    bot.inventory = { items: () => [] }
    const goals = []
    bot.pathfinder.setGoal = (g) => { goals.push(g) }
    const brain = { async decide() { return { action: 'follow', sprint: false, source: 'jev' } } }
    const ticker = createTicker({ bot, brain, tickMs: 10, idleTickMs: 10 })
    ticker.work()
    const ctx = bot._tickerCtx
    ctx.home = v2home(SITE)
    const origLog = console.log
    const origErr = console.error
    console.log = () => {}
    console.error = () => {}
    try {
      for (let i = 0; i < 45; i++) await ticker.tick()
      assert.equal(ctx.step, 'shelter', 'night-far holds shelter')
      assert.equal(ctx.stuck, null, 'no ticker backstop episode during shelter')
      assert.equal(ctx.recovery, null, 'no recovery owns the body during shelter')
      assert.ok(goals.every((g) => g === null), `no march goals issued: ${goals.length} nulls`)
    } finally {
      console.log = origLog
      console.error = origErr
      ticker.destroy()
    }
  })

  it('shelter is a registered behaviour', () => {
    assert.equal(typeof BEHAVIOURS.shelter, 'function')
    assert.equal(BEHAVIOURS.shelter, home.shelter)
  })
})
