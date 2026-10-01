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

  it('a night-far gohome walk converts to shelter past the stickiness', async () => {
    // The dusk march (or a respawn) mid-walk at night, facts UNCHANGED (a
    // keepInventory death moves no bucket): without the force the
    // stickiness plus the askedKey shortcut would march the dark forever.
    const origLog = console.log
    console.log = () => {}
    try {
      const bot = menuBot({ x: 0, y: 64, z: 0 }, 15000)
      const ctx = menuCtx()
      ctx.step = 'gohome'
      ctx.stepStatus = 'running'
      ctx.gohome = { phase: 'walk', stalls: 0, fails: 0, lastPos: null, lastToggle: 0 }
      const text = goal.goalText(goal.goalFacts(bot, ctx), ctx.home)
      ctx.goalText = text // unchanged facts
      ctx.askedKey = `${text}\nrunning` // the shortcut would re-issue gohome
      const r = await goal.decide(bot, ctx)
      assert.equal(r.action, 'shelter', 'forced past stickiness and shortcut')
      assert.equal(ctx.gohome, null, 'interrupted walk resets for the next march')
      assert.deepEqual(ctx.shelter, {}, 'fresh pillar state')
    } finally {
      console.log = origLog
    }
  })

  it('dusk-far and door-phase walks keep their stickiness', async () => {
    const origLog = console.log
    console.log = () => {}
    try {
      const duskBot = menuBot({ x: 0, y: 64, z: 0 }, 12500)
      const duskCtx = menuCtx()
      duskCtx.step = 'gohome'
      duskCtx.stepStatus = 'running'
      duskCtx.gohome = { phase: 'walk', stalls: 0, fails: 0, lastPos: null, lastToggle: 0 }
      const duskText = goal.goalText(goal.goalFacts(duskBot, duskCtx), duskCtx.home)
      duskCtx.goalText = duskText
      duskCtx.askedKey = `${duskText}\nrunning`
      assert.equal((await goal.decide(duskBot, duskCtx)).action, 'gohome', 'dusk marches on')

      // A doorway phase never converts, wherever the body reads: the force
      // is walk-only, so it cannot break an open door mid-swing.
      const doorBot = menuBot({ x: 0, y: 64, z: 0 }, 15000)
      const doorCtx = menuCtx()
      doorCtx.step = 'gohome'
      doorCtx.stepStatus = 'running'
      doorCtx.gohome = { phase: 'open', stalls: 0, fails: 0, lastPos: null, lastToggle: 0 }
      const doorText = goal.goalText(goal.goalFacts(doorBot, doorCtx), doorCtx.home)
      doorCtx.goalText = doorText
      doorCtx.askedKey = `${doorText}\nrunning`
      assert.equal((await goal.decide(doorBot, doorCtx)).action, 'gohome', 'door phases stick')
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

  it('the night hold sticks past a model re-pick to a day step', async () => {
    // Revmux 01 body-2: a laya re-pick to a day step would walk off the
    // pillar and work the dark with inShelter still armed (no fight, no
    // retreat, till dawn). Stale facts defeat the askedKey shortcut, so only
    // the stickiness returns shelter — the model is never even asked.
    const origLog = console.log
    const origErr = console.error
    console.log = () => {}
    console.error = () => {}
    try {
      const bot = menuBot({ x: 0, y: 64, z: 0 }, 15000)
      const ctx = menuCtx()
      ctx.step = 'shelter'
      ctx.stepStatus = 'running'
      ctx.shelter = { pillared: true }
      ctx.goalText = 'stale'
      ctx.askedKey = 'stale'
      let asked = 0
      ctx.brain = { source: 'laya', ask: async () => { asked++; return 'craft' } }
      const r = await goal.decide(bot, ctx)
      assert.equal(r.action, 'shelter', 'the hold continues')
      assert.equal(asked, 0, 'stickiness bypasses the model re-pick')
      assert.deepEqual(ctx.shelter, { pillared: true }, 'no re-pillar mid-hold')
    } finally {
      console.log = origLog
      console.error = origErr
    }
  })

  it('near home at night the hold releases to the walk in', async () => {
    // Revmux 02: the night stickiness only holds far from home — a death
    // that respawns by the house must walk in (gohome), not pillar outside
    // it all night. Stale facts defeat the askedKey shortcut, so only the
    // menu pick returns gohome.
    const origLog = console.log
    console.log = () => {}
    try {
      const bot = menuBot({ x: 195, y: 64, z: 195 }, 15000)
      const ctx = menuCtx()
      ctx.step = 'shelter'
      ctx.stepStatus = 'running'
      ctx.shelter = { pillared: true }
      ctx.goalText = 'stale'
      ctx.askedKey = 'stale'
      const r = await goal.decide(bot, ctx)
      assert.equal(r.action, 'gohome', 'near home the night re-decides into the walk in')
    } finally {
      console.log = origLog
    }
  })

  it('day exits the hold through the menu', async () => {
    // Body-2 control: shelter is night-infeasible, so the day re-decide
    // cannot stick and the model re-pick lands.
    const origLog = console.log
    const origErr = console.error
    console.log = () => {}
    console.error = () => {}
    try {
      const bot = menuBot({ x: 0, y: 64, z: 0 }, 6000)
      const ctx = menuCtx()
      ctx.step = 'shelter'
      ctx.stepStatus = 'running'
      ctx.shelter = { pillared: true }
      ctx.goalText = 'stale'
      ctx.askedKey = 'stale'
      let asked = 0
      ctx.brain = { source: 'laya', ask: async () => { asked++; return 'craft' } }
      const r = await goal.decide(bot, ctx)
      assert.notEqual(r.action, 'shelter', 'day never holds the pillar')
      assert.equal(asked, 1, 'the day re-decide consults the model')
    } finally {
      console.log = origLog
      console.error = origErr
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

  it('a displaced hold re-pillars at the new body (death/respawn)', () => {
    // Revmux 01 core-2: death respawns the body far from the pillar while
    // the step survives — holding there would camp open ground at spawn.
    const bot = holdBot()
    const ctx = { home: v2home(SITE), step: 'shelter', stepStatus: 'running' }
    const origLog = console.log
    const logs = []
    console.log = (m) => { logs.push(String(m)) }
    try {
      home.shelter(bot, ctx, null, null) // pillars (fails, no scaffold), holds
      assert.equal(ctx.shelter.pillared, true)
      assert.deepEqual(ctx.shelter.pillarAt, { x: 0, z: 0 })
      bot.entity.position = pos(50, 64, 50) // death: the body wakes far away
      home.shelter(bot, ctx, null, null)
    } finally {
      console.log = origLog
    }
    assert.ok(logs.some((m) => m.includes('shelter displaced, re-pillaring')), `re-pillar logged: ${JSON.stringify(logs)}`)
    assert.deepEqual(ctx.shelter.pillarAt, { x: 50, z: 50 }, 're-anchored at the new body')
    assert.equal(ctx.shelter.pillared, true, 'failed re-pillar still holds — at the new spot')
    assert.equal(ctx.inShelter, true)
  })

  it('a displaced climb drops the stale episode and re-pillars', () => {
    // Core-2 mid-climb half: a running pillar_up from the old spot must not
    // resume at the new position. A resumed episode would skip beginPillar
    // and leave pillarAt null — the re-anchor proves the drop.
    const bot = holdBot()
    const ctx = {
      home: v2home(SITE), step: 'shelter', stepStatus: 'running',
      shelter: { pillarAt: { x: 0, z: 0 } },
      recovery: { action: 'pillar_up', source: 'shelter', model: null, status: 'running', st: {} },
    }
    const origLog = console.log
    const logs = []
    console.log = (m) => { logs.push(String(m)) }
    try {
      bot.entity.position = pos(50, 64, 50)
      home.shelter(bot, ctx, null, null)
    } finally {
      console.log = origLog
    }
    assert.ok(logs.some((m) => m.includes('shelter displaced, re-pillaring')), `re-pillar logged: ${JSON.stringify(logs)}`)
    assert.deepEqual(ctx.shelter.pillarAt, { x: 50, z: 50 }, 'stale climb dropped, re-anchored')
  })

  it('a first tick under a foreign episode still anchors the hold', () => {
    // Revmux 02: a foreign live episode skips beginPillar, so the hold used
    // to stand with pillarAt null and the death/respawn displacement check
    // dead — the round-1 open-ground camp on another path. The foreign
    // episode itself is never touched.
    const bot = holdBot()
    const foreign = { action: 'dig_step', source: 'stuck', model: null, status: 'running', st: {} }
    const ctx = { home: v2home(SITE), step: 'shelter', stepStatus: 'running', recovery: foreign }
    const origLog = console.log
    const logs = []
    console.log = (m) => { logs.push(String(m)) }
    try {
      home.shelter(bot, ctx, null, null)
      assert.equal(ctx.shelter.pillared, true, 'the hold stands past the foreign episode')
      assert.deepEqual(ctx.shelter.pillarAt, { x: 0, z: 0 }, 'anchored at the current body')
      assert.equal(ctx.recovery, foreign, 'foreign episode untouched')
      bot.entity.position = pos(50, 64, 50) // death: the body wakes far away
      home.shelter(bot, ctx, null, null)
    } finally {
      console.log = origLog
    }
    assert.ok(logs.some((m) => m.includes('shelter displaced, re-pillaring')), `re-pillar logged: ${JSON.stringify(logs)}`)
    assert.deepEqual(ctx.shelter.pillarAt, { x: 50, z: 50 }, 're-anchored at the new body')
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
