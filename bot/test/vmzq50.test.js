'use strict'

// Bead idkcraft-vmzq.50: after a far respawn the castle step treks 400
// blocks through caves (prod run8: drowned y11, creeper, run ends stuck
// sheltering 450 off) and the watchdog offers no go-to-site option. Fix:
// a return-to-site goal step (surface route, day only, climb-first from
// deep cover) that outranks the castle legs while displaced, plus a
// dusk dig-up preference over sheltering in a cave.

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const { Vec3 } = require('vec3')
const goal = require('../src/goal')
const taskMod = require('../src/task')
const { goalOptions } = require('../src/goal-options')
const gocastleMod = require('../src/behaviours/gocastle')
const blueprint = require('../src/castle')
require('../src/index') // BEHAVIOURS registration (goal.registered)

const CASTLE = { x: 276, y: 64, z: 180 } // run8 site
const HOME = { x: -40, y: 64, z: -215 } // run8 home ground, ~500 off
const SPAWN = { x: -48, y: 65, z: -208 } // world spawn (the far respawn)

function pos(x, y, z) {
  const p = {
    x, y, z,
    distanceTo: (q) => Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z),
    clone() { return pos(p.x, p.y, p.z) },
    offset(ox, oy, oz) { return pos(p.x + ox, p.y + oy, p.z + oz) },
    floored() { return pos(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)) },
  }
  return p
}

// Flat world: dirt at y<=63, air above, plus explicit cell overrides
// (key 'x,y,z' -> name; null value = unloaded column).
function flatWorld(cells) {
  return {
    blockAt: (p) => {
      const fx = Math.floor(p.x)
      const fy = Math.floor(p.y)
      const fz = Math.floor(p.z)
      if (cells && cells.has(`${fx},${fy},${fz}`)) {
        const name = cells.get(`${fx},${fy},${fz}`)
        if (name === null) return null
        return { name, position: pos(fx, fy, fz), boundingBox: name === 'air' ? 'empty' : 'block' }
      }
      const name = fy <= 63 ? 'dirt' : 'air'
      return { name, position: pos(fx, fy, fz), boundingBox: name === 'air' ? 'empty' : 'block' }
    },
  }
}

function goalBot({ items = [], at = pos(CASTLE.x + 2, 64, CASTLE.z + 2), timeOfDay = 6000, cells = null, health = 20, food = 20, entities = {} } = {}) {
  const world = flatWorld(cells)
  return {
    chats: [],
    entity: { position: at, onGround: true },
    inventory: { items: () => items },
    time: { timeOfDay, day: 1 },
    spawnPoint: pos(0, 64, 0),
    players: {},
    entities,
    health,
    food,
    blockAt: (p) => world.blockAt(p),
    findBlocks: () => [],
    registry: { blocksByName: {}, itemsByName: {} },
    pathfinder: { goal: null, setGoal() {}, isMoving: () => false, movements: { exclusionAreasBreak: [], exclusionAreasPlace: [] } },
    world: { getBlock: () => null },
    chat(m) { this.chats.push(String(m)) },
  }
}

function castleState(extra) {
  return { site: { ...CASTLE }, rot: 0, blueprintVersion: 1, phase: 'body', blocked: {}, parked: false, ...extra }
}

function siteCentre() {
  const { w, d } = blueprint.siteDimensions(0, 1)
  return { x: CASTLE.x + w / 2, z: CASTLE.z + d / 2 }
}

async function quietAsync(fn) {
  const origLog = console.log
  const origErr = console.error
  console.log = () => {}
  console.error = () => {}
  try { return await fn() } finally { console.log = origLog; console.error = origErr }
}

describe('vmzq.50 return-to-site: displacement', () => {
  it('GOSITE_DIST is the bead 64', () => {
    assert.equal(goal.GOSITE_DIST, 64)
  })

  it('displaced past 64 XZ from the site centre, not at 64', () => {
    const c = siteCentre()
    const ctx = { castle: castleState() }
    assert.equal(goal.displacedFromCastle(goalBot({ at: pos(c.x + 64, 64, c.z) }), ctx), false)
    assert.equal(goal.displacedFromCastle(goalBot({ at: pos(c.x + 64.1, 64, c.z) }), ctx), true)
    assert.equal(goal.displacedFromCastle(goalBot({ at: pos(SPAWN.x, SPAWN.y, SPAWN.z) }), ctx), true)
    assert.equal(goal.displacedFromCastle(goalBot({ at: pos(CASTLE.x + 2, 64, CASTLE.z + 2) }), ctx), false)
  })

  it('needs an active castle: none, parked and complete read housed', () => {
    const far = goalBot({ at: pos(SPAWN.x, SPAWN.y, SPAWN.z) })
    assert.equal(goal.displacedFromCastle(far, {}), false)
    assert.equal(goal.displacedFromCastle(far, { castle: castleState({ parked: true }) }), false)
    assert.equal(goal.displacedFromCastle(far, { castle: castleState({ phase: 'complete' }) }), false)
  })
})

describe('vmzq.50 return-to-site: menu', () => {
  const F = (facts, bot, ctx) => goal.MENU.gocastle.feasible(facts, bot, ctx)

  it('day + displaced + active castle walks, even with an empty pack', () => {
    const bot = goalBot({ items: [], at: pos(SPAWN.x, SPAWN.y, SPAWN.z) })
    const ctx = { castle: castleState() }
    assert.equal(F({ time: 'day' }, bot, ctx), true)
  })

  it('at the site it never runs (day, dusk or night)', () => {
    const bot = goalBot({ at: pos(CASTLE.x + 2, 64, CASTLE.z + 2) })
    const ctx = { castle: castleState() }
    for (const time of ['day', 'dusk', 'night']) {
      assert.equal(F({ time }, bot, ctx), false, time)
    }
  })

  it('night never marches; dusk only climbs out, never walks the surface', () => {
    const ctx = { castle: castleState() }
    const surf = goalBot({ at: pos(SPAWN.x, SPAWN.y, SPAWN.z) })
    assert.equal(F({ time: 'night' }, surf, ctx), false)
    assert.equal(F({ time: 'dusk' }, surf, ctx), false)
    // Underground: solid above the head.
    const cells = new Map()
    for (let y = 66; y <= 73; y++) cells.set(`${SPAWN.x},${y},${SPAWN.z}`, 'stone')
    const under = goalBot({ at: pos(SPAWN.x + 0.5, 65, SPAWN.z + 0.5), cells })
    assert.equal(F({ time: 'dusk' }, under, ctx), true)
    assert.equal(F({ time: 'day' }, under, ctx), true)
  })

  it('outranks the castle legs, forage and explore in the FSM', () => {
    const day = { time: 'day' }
    assert.equal(goal.goalFsm(day, ['castlefetch', 'castle', 'forage', 'explore', 'rest']), 'castlefetch')
    assert.equal(goal.goalFsm(day, ['gocastle', 'castlefetch', 'castle', 'forage', 'explore', 'rest']), 'gocastle')
  })

  it('the castle rule answers it without asking the model', async () => {
    const bot = goalBot({ at: pos(SPAWN.x, SPAWN.y, SPAWN.z) })
    const ctx = { castle: castleState() }
    const facts = goal.goalFacts(bot, ctx)
    const throwing = { source: 'x', ask: async () => { throw new Error('must not ask') } }
    const choice = await goal.chooseStep(throwing, facts, ['gocastle', 'forage', 'explore', 'rest'], null)
    assert.equal(choice.step, 'gocastle')
    assert.equal(choice.source, 'castle-rule')
  })

  it('stepWhy mirrors the gate', () => {
    const ctx = { castle: castleState() }
    const far = goalBot({ at: pos(SPAWN.x, SPAWN.y, SPAWN.z) })
    const near = goalBot({ at: pos(CASTLE.x + 2, 64, CASTLE.z + 2) })
    assert.equal(goal.stepWhy('gocastle', { time: 'day' }, far, {}, ''), 'gocastle: no active castle')
    assert.equal(goal.stepWhy('gocastle', { time: 'night' }, far, ctx, ''), 'gocastle: daytime job')
    assert.equal(goal.stepWhy('gocastle', { time: 'day' }, near, ctx, ''), 'gocastle: already at the site')
    assert.equal(goal.stepWhy('gocastle', { time: 'dusk' }, far, ctx, ''), 'gocastle: dusk shelters')
  })

  it('threat gate (R1): low + foodless into mobs does not travel, quiet does', () => {
    const zombieNear = { 1: { id: 1, name: 'zombie', type: 'mob', position: pos(SPAWN.x + 5, SPAWN.y, SPAWN.z), isValid: true } }
    const zombieFar = { 1: { id: 1, name: 'zombie', type: 'mob', position: pos(SPAWN.x + 11, SPAWN.y, SPAWN.z), isValid: true } }
    const ctx = { castle: castleState() }
    const facts = { time: 'day', health: 5, food: 10 }
    const threatened = goalBot({ items: [], at: pos(SPAWN.x, SPAWN.y, SPAWN.z), entities: zombieNear })
    assert.equal(goal.MENU.gocastle.feasible(facts, threatened, ctx), false)
    assert.equal(
      goal.stepWhy('gocastle', facts, threatened, ctx, ''),
      'gocastle: too hurt to travel (low health, no food, hostile near)'
    )
    const quiet = goalBot({ items: [], at: pos(SPAWN.x, SPAWN.y, SPAWN.z), entities: zombieFar })
    assert.equal(goal.MENU.gocastle.feasible(facts, quiet, ctx), true, 'past the band the walk runs')
    const fed = goalBot({ items: [{ name: 'bread', count: 1 }], at: pos(SPAWN.x, SPAWN.y, SPAWN.z), entities: zombieNear })
    assert.equal(goal.MENU.gocastle.feasible(facts, fed, ctx), true, 'food re-opens')
    const healthy = goalBot({ items: [], at: pos(SPAWN.x, SPAWN.y, SPAWN.z), entities: zombieNear })
    assert.equal(goal.MENU.gocastle.feasible({ ...facts, health: 20 }, healthy, ctx), true, 'hp re-opens')
  })
})

describe('vmzq.50 return-to-site: decide force', () => {
  it('a running castle leg re-decides to gocastle once displaced (site-far)', async () => {
    await quietAsync(async () => {
      const bot = goalBot({ at: pos(SPAWN.x, SPAWN.y, SPAWN.z) })
      const ctx = { castle: castleState(), work: true }
      const facts = goal.goalFacts(bot, ctx)
      const text = goal.goalText(facts, null)
      // A teleport moves no bucket: without the force the shortcut below
      // would re-issue castle forever.
      ctx.step = 'castle'
      ctx.stepStatus = 'running'
      ctx.goalText = text
      ctx.askedKey = `${text}\nrunning`
      const d = await goal.decide(bot, ctx)
      assert.equal(d.action, 'gocastle')
      assert.equal(ctx.stepPick.why, 'site-far')
    })
  })

  it('a running castlefetch leg re-decides too', async () => {
    await quietAsync(async () => {
      const bot = goalBot({ at: pos(SPAWN.x, SPAWN.y, SPAWN.z) })
      const ctx = { castle: castleState(), work: true }
      const facts = goal.goalFacts(bot, ctx)
      const text = goal.goalText(facts, null)
      ctx.step = 'castlefetch'
      ctx.stepStatus = 'running'
      ctx.goalText = text
      ctx.askedKey = `${text}\nrunning`
      const d = await goal.decide(bot, ctx)
      assert.equal(d.action, 'gocastle')
    })
  })

  it('a running far-fetch leg is exempt (R1): it finishes past 64, no turn-back', async () => {
    await quietAsync(async () => {
      const bot = goalBot({ at: pos(SPAWN.x, SPAWN.y, SPAWN.z) })
      const ctx = {
        castle: castleState(), work: true,
        castleFetch: { farCandidate: { x: SPAWN.x - 100, y: 60, z: SPAWN.z, kind: 'stone', left: 10 } },
      }
      const facts = goal.goalFacts(bot, ctx)
      const text = goal.goalText(facts, null)
      ctx.step = 'castlefetch'
      ctx.stepStatus = 'running'
      ctx.goalText = text
      ctx.askedKey = `${text}\nrunning`
      const d = await goal.decide(bot, ctx)
      assert.equal(d.action, 'castlefetch')
      assert.equal(ctx.stepPick, undefined, 'no re-decide: the shortcut re-issues')
    })
  })

  it('a pin on the current step is exempt (R1): no per-tick re-decide churn', async () => {
    await quietAsync(async () => {
      const bot = goalBot({ at: pos(SPAWN.x, SPAWN.y, SPAWN.z) })
      const ctx = {
        castle: castleState(), work: true,
        goal: { id: 'g1', generation: 1, commit: { goalId: 'g1', generation: 1, step: 'castlefetch', until: Date.now() + 60000 } },
      }
      const facts = goal.goalFacts(bot, ctx)
      const text = goal.goalText(facts, null)
      ctx.step = 'castlefetch'
      ctx.stepStatus = 'running'
      ctx.goalText = text
      ctx.askedKey = `${text}\nrunning`
      const d = await goal.decide(bot, ctx)
      assert.equal(d.action, 'castlefetch')
      assert.equal(ctx.stepPick, undefined, 'no re-decide: the pin holds silently')
    })
  })
})

describe('vmzq.50 return-to-site: watchdog options', () => {
  it('displaced options contain gocastle and the fallback picks it first', () => {
    const bot = goalBot({ items: [], at: pos(SPAWN.x, SPAWN.y, SPAWN.z) })
    const ctx = { castle: castleState() }
    const offered = goalOptions(bot, ctx, 'castle')
    const ids = offered.map((o) => o.id)
    assert.ok(ids.includes('gocastle'), `options: ${ids.join(',')}`)
    const gocastle = offered.find((o) => o.id === 'gocastle')
    assert.match(gocastle.criterion, /return/)
    const top = taskMod.fallbackRank('castle', offered, [], 'castle', null)
    assert.equal(top.id, 'gocastle')
  })

  it('at the site the normal menu carries no gocastle (by-construction not-worse)', () => {
    const bot = goalBot({ at: pos(CASTLE.x + 2, 64, CASTLE.z + 2) })
    const ctx = { castle: castleState() }
    const ids = goalOptions(bot, ctx, 'castle').map((o) => o.id)
    assert.ok(!ids.includes('gocastle'), `options: ${ids.join(',')}`)
  })
})

describe('vmzq.50 return-to-site: dusk dig-up', () => {
  // Mid-map: displaced from the castle AND far from home, so the castle
  // night owns dusk (at spawn the bot is near home and gohome wins).
  const MID = { x: 143, y: 62, z: 6 }
  function duskCtx() {
    return {
      castle: castleState(),
      home: { site: { ...HOME }, built: true, v: 2 },
    }
  }

  it('underground at dusk: shelter stands down, the climb runs', () => {
    const cells = new Map()
    for (let y = 63; y <= 70; y++) cells.set(`${MID.x},${y},${MID.z}`, 'stone')
    const bot = goalBot({ at: pos(MID.x + 0.5, MID.y, MID.z + 0.5), cells })
    const ctx = duskCtx()
    const facts = { time: 'dusk', home: 'built', inside: 'no' }
    assert.equal(goal.MENU.shelter.feasible(facts, bot, ctx), false)
    assert.equal(goal.MENU.gocastle.feasible(facts, bot, ctx), true)
    assert.equal(goal.stepWhy('shelter', facts, bot, ctx, ''), 'shelter: climbing out before sheltering')
  })

  it('on the surface at dusk: shelter as before, no march', () => {
    const bot = goalBot({ at: pos(MID.x, 64, MID.z) })
    const ctx = duskCtx()
    const facts = { time: 'dusk', home: 'built', inside: 'no' }
    assert.equal(goal.MENU.shelter.feasible(facts, bot, ctx), true)
    assert.equal(goal.MENU.gocastle.feasible(facts, bot, ctx), false)
  })

  it('a held climb falls back to shelter (R1), as does a threat-gated one', () => {
    const cells = new Map()
    for (let y = 63; y <= 70; y++) cells.set(`${MID.x},${y},${MID.z}`, 'stone')
    const bot = goalBot({ at: pos(MID.x + 0.5, MID.y, MID.z + 0.5), cells })
    const facts = { time: 'dusk', home: 'built', inside: 'no', health: 20, food: 20 }
    // Failed climb, same text and ground: the hold lifts the carve-out.
    // Record shape mirrors decide(): { status, text, pos, at } (R2: the
    // bare x/y/z shape held everywhere and proved nothing about radius).
    const held = duskCtx()
    held.stepFail = { gocastle: { status: 'failed:cannot-reach-castle', text: goal.goalText(facts, held.home), pos: { x: MID.x, y: MID.y, z: MID.z }, at: Date.now() } }
    assert.equal(goal.MENU.shelter.feasible(facts, bot, held), true)
    // Low + foodless + hostile near: the climb will not run either.
    const zombie = { 1: { id: 1, name: 'zombie', type: 'mob', position: pos(MID.x + 3, MID.y, MID.z), isValid: true } }
    const hurt = goalBot({ items: [], at: pos(MID.x + 0.5, MID.y, MID.z + 0.5), cells, entities: zombie })
    const lowFacts = { ...facts, health: 5, food: 10 }
    assert.equal(goal.MENU.gocastle.feasible(lowFacts, hurt, duskCtx()), false)
    assert.equal(goal.MENU.shelter.feasible(lowFacts, hurt, duskCtx()), true)
  })
})

describe('vmzq.50 return-to-site: step behaviour', () => {
  const castleMod = require('../src/behaviours/castle')

  function stepBot({ at, cells = null, loadedEnt = true } = {}) {
    const world = flatWorld(cells)
    const goals = []
    return {
      chats: [],
      entity: { position: at, onGround: true },
      blockAt(p) {
        if (!loadedEnt) {
          const ent = castleMod.entrance(castleState())
          if (Math.floor(p.x) === ent.x && Math.floor(p.y) === ent.y && Math.floor(p.z) === ent.z) return null
        }
        return world.blockAt(p)
      },
      pathfinder: {
        goal: null,
        movements: { canDig: true, allowSprinting: false, allowParkour: true },
        setGoal(g) { goals.push(g); this.goal = g || null },
        stop() {},
        isMoving: () => false,
        setMovements() {},
      },
      registry: {},
      chat(m) { this.chats.push(String(m)) },
      lookAt() {},
      setControlState() {},
      clearControlStates() {},
      _goals: goals,
    }
  }

  function stepCtx(extra) {
    return { step: 'gocastle', stepStatus: 'running', castle: castleState(), body: { owner: 'work' }, work: true, lastGoalKey: '', ...extra }
  }

  it('from the surface far away it plans the XZ walk, never down', () => {
    const bot = stepBot({ at: pos(SPAWN.x, SPAWN.y, SPAWN.z) })
    const ctx = stepCtx()
    gocastleMod(bot, ctx)
    assert.equal(ctx.stepStatus, 'running')
    assert.ok(ctx.lastGoalKey === 'gocastle-far' || ctx.lastGoalKey === 'gocastle-walk', ctx.lastGoalKey)
    assert.equal(bot._goals.length, 1)
  })

  it('from deep cover it goals up, never an XZ leg (the trigger; the rig pins the route)', () => {
    const cells = new Map()
    for (let y = 42; y <= 49; y++) cells.set(`0,${y},0`, 'stone')
    const bot = stepBot({ at: pos(0.5, 41, 0.5), cells })
    const ctx = stepCtx()
    gocastleMod(bot, ctx)
    assert.equal(ctx.stepStatus, 'running')
    assert.ok(String(ctx.lastGoalKey).startsWith('gocastle-up:'), ctx.lastGoalKey)
    assert.equal(bot._goals.length, 1)
    assert.ok(bot._goals[0].y > 41, `up goal y=${bot._goals[0] && bot._goals[0].y}`)
  })

  it('below the leg depth floor it goals up under open sky (R1 y-floor)', () => {
    // Air shaft: open sky down low (no cover) — the floor alone triggers.
    const cells = new Map()
    for (let y = 40; y <= 72; y++) cells.set(`0,${y},0`, 'air')
    const bot = stepBot({ at: pos(0.5, 55, 0.5), cells })
    const ctx = stepCtx({ gosite: { phase: 'walk', stalls: 0, fails: 0, lastPos: null, highY: 64 } })
    gocastleMod(bot, ctx)
    assert.ok(String(ctx.lastGoalKey).startsWith('gocastle-up:'), ctx.lastGoalKey)
    assert.equal(ctx.gosite.climbing, true)
    // At the floor it walks.
    const level = stepBot({ at: pos(0.5, 56, 0.5), cells })
    const lctx = stepCtx({ gosite: { phase: 'walk', stalls: 0, fails: 0, lastPos: null, highY: 64 } })
    gocastleMod(level, lctx)
    assert.ok(lctx.lastGoalKey === 'gocastle-far' || lctx.lastGoalKey === 'gocastle-walk', lctx.lastGoalKey)
  })

  it('the climb latches till floor+2, and lifts near the entrance (R1)', () => {
    const cells = new Map()
    for (let y = 40; y <= 72; y++) cells.set(`0,${y},0`, 'air')
    // Still climbing at floor+1 (margin), exits at floor+2.
    const low = stepBot({ at: pos(0.5, 57, 0.5), cells })
    const lctx = stepCtx({ gosite: { phase: 'walk', stalls: 0, fails: 0, lastPos: null, highY: 64, climbing: true, climbAt: { x: 0, z: 0 }, flaps: 0 } })
    gocastleMod(low, lctx)
    assert.ok(String(lctx.lastGoalKey).startsWith('gocastle-up:'), lctx.lastGoalKey)
    const out = stepBot({ at: pos(0.5, 58, 0.5), cells })
    const octx = stepCtx({ gosite: { phase: 'walk', stalls: 0, fails: 0, lastPos: null, highY: 64, climbing: true, climbAt: { x: 0, z: 0 }, flaps: 0 } })
    gocastleMod(out, octx)
    assert.ok(octx.lastGoalKey === 'gocastle-far' || octx.lastGoalKey === 'gocastle-walk', octx.lastGoalKey)
    assert.equal(octx.gosite.climbing, false)
    // At the doorstep the floor lifts (arrival digs/walks as needed).
    const ent = castleMod.entrance(castleState())
    const doorCells = new Map()
    for (let y = 30; y <= 72; y++) doorCells.set(`${ent.x + 10},${y},${ent.z}`, 'air')
    const door = stepBot({ at: pos(ent.x + 10.5, 40, ent.z + 0.5), cells: doorCells })
    const dctx = stepCtx({ gosite: { phase: 'walk', stalls: 0, fails: 0, lastPos: null, highY: 64 } })
    gocastleMod(door, dctx)
    assert.ok(dctx.lastGoalKey === 'gocastle-far' || dctx.lastGoalKey === 'gocastle-walk', dctx.lastGoalKey)
  })

  it('ordinary downhill never trips the floor; an 8-fall does (R2 decay)', () => {
    const cells = new Map()
    for (let y = 40; y <= 80; y++) cells.set(`0,${y},0`, 'air')
    // Walk down 2/tick: the watermark follows, the XZ leg holds throughout.
    const ctx = stepCtx({ gosite: { phase: 'walk', stalls: 0, fails: 0, lastPos: null, highY: 70 } })
    for (const y of [70, 68, 66, 64, 62]) {
      gocastleMod(stepBot({ at: pos(0.5, y, 0.5), cells }), ctx)
      assert.equal(ctx.stepStatus, 'running', `y=${y}`)
      assert.ok(ctx.lastGoalKey === 'gocastle-far' || ctx.lastGoalKey === 'gocastle-walk', `y=${y}: ${ctx.lastGoalKey}`)
      assert.equal(ctx.gosite.climbing || false, false, `y=${y}`)
    }
    assert.equal(ctx.gosite.highY, 62)
    // A completed 8-fall (pre-decay check) still triggers.
    const fell = stepBot({ at: pos(0.5, 61, 0.5), cells })
    const fctx = stepCtx({ gosite: { phase: 'walk', stalls: 0, fails: 0, lastPos: null, highY: 70 } })
    gocastleMod(fell, fctx)
    assert.ok(String(fctx.lastGoalKey).startsWith('gocastle-up:'), fctx.lastGoalKey)
  })

  it('blind starts seed the watermark at site level; open starts at feet (R2)', () => {
    const cells = new Map()
    for (let y = 42; y <= 49; y++) cells.set(`0,${y},0`, 'stone')
    const deep = stepBot({ at: pos(0.5, 41, 0.5), cells })
    const dctx = stepCtx()
    gocastleMod(deep, dctx)
    assert.equal(dctx.gosite.highY, 64, 'covered start assumes the site surface')
    const open = stepBot({ at: pos(SPAWN.x, SPAWN.y, SPAWN.z) })
    const octx = stepCtx()
    gocastleMod(open, octx)
    assert.equal(octx.gosite.highY, SPAWN.y, 'open start seeds from feet')
  })

  it('a climb past a low local surface exits after 12 gained (R2 cap)', () => {
    const cells = new Map()
    for (let y = 40; y <= 80; y++) cells.set(`0,${y},0`, 'air')
    const mk = (y) => stepCtx({ gosite: { phase: 'walk', stalls: 0, fails: 0, lastPos: null, highY: 64, climbing: true, climbFromY: 41, climbAt: { x: 0, z: 0 }, flaps: 0 } })
    // Floor 56: at 52 neither the band (58) nor the cap (53) releases.
    const low = stepBot({ at: pos(0.5, 52, 0.5), cells })
    const lctx = mk(52)
    gocastleMod(low, lctx)
    assert.ok(String(lctx.lastGoalKey).startsWith('gocastle-up:'), lctx.lastGoalKey)
    // At 53 the cap releases even below the band.
    const out = stepBot({ at: pos(0.5, 53, 0.5), cells })
    const octx = mk(53)
    gocastleMod(out, octx)
    assert.ok(octx.lastGoalKey === 'gocastle-far' || octx.lastGoalKey === 'gocastle-walk', octx.lastGoalKey)
    assert.equal(octx.gosite.climbing, false)
  })

  it('depth entries never flap; a dig that steps up refunds fails (R2)', () => {
    const cells = new Map()
    for (let y = 40; y <= 72; y++) cells.set(`0,${y},0`, 'air')
    // Open sky below the floor at the flap spot: enters, counts nothing.
    const bot = stepBot({ at: pos(0.5, 55, 0.5), cells })
    const ctx = stepCtx({ gosite: { phase: 'walk', stalls: 0, fails: 0, lastPos: null, highY: 64, climbing: false, climbAt: { x: 0, z: 0 }, flaps: 2 } })
    gocastleMod(bot, ctx)
    assert.equal(ctx.stepStatus, 'running')
    assert.ok(String(ctx.lastGoalKey).startsWith('gocastle-up:'), ctx.lastGoalKey)
    assert.equal(ctx.gosite.flaps, 2)
    // A move between stall windows refunds the fail budget (slow hand dig).
    const stones = new Map()
    for (let y = 42; y <= 50; y++) stones.set(`0,${y},0`, 'stone')
    const dug = stepBot({ at: pos(0.5, 42, 0.5), cells: stones })
    const dctx = stepCtx({ gosite: { phase: 'walk', stalls: 9, fails: 2, lastPos: { x: 0, y: 41, z: 0 }, highY: 64, climbing: true, climbFromY: 41, climbAt: { x: 0, z: 0 }, flaps: 0 } })
    gocastleMod(dug, dctx)
    assert.equal(dctx.stepStatus, 'running')
    assert.equal(dctx.gosite.fails, 0)
    assert.equal(dctx.gosite.stalls, 0)
  })

  it('same-spot climb re-entry fails the leg; far-apart episodes reset (R1 flap cap)', () => {
    const cells = new Map()
    for (let y = 42; y <= 49; y++) cells.set(`0,${y},0`, 'stone')
    // Third same-spot re-entry: fail.
    const bot = stepBot({ at: pos(0.5, 41, 0.5), cells })
    const ctx = stepCtx({ gosite: { phase: 'walk', stalls: 0, fails: 0, lastPos: null, highY: 64, climbing: false, climbAt: { x: 0, z: 0 }, flaps: 2 } })
    gocastleMod(bot, ctx)
    assert.equal(ctx.stepStatus, 'failed:cannot-reach-castle')
    assert.equal(ctx.gosite, null)
    // A far-apart climb resets the count and goals up.
    const far = stepBot({ at: pos(0.5, 41, 0.5), cells })
    const fctx = stepCtx({ gosite: { phase: 'walk', stalls: 0, fails: 0, lastPos: null, highY: 64, climbing: false, climbAt: { x: 500, z: 500 }, flaps: 2 } })
    gocastleMod(far, fctx)
    assert.equal(fctx.stepStatus, 'running')
    assert.ok(String(fctx.lastGoalKey).startsWith('gocastle-up:'), fctx.lastGoalKey)
    assert.equal(fctx.gosite.flaps, 0)
  })

  it('arrival ends the leg done; a missing site fails it', () => {
    const ent = castleMod.entrance(castleState())
    const bot = stepBot({ at: pos(ent.x + 0.5, ent.y, ent.z + 0.5) })
    const ctx = stepCtx()
    gocastleMod(bot, ctx)
    assert.equal(ctx.stepStatus, 'done')
    assert.equal(ctx.gosite, null)

    const lost = stepBot({ at: pos(SPAWN.x, SPAWN.y, SPAWN.z) })
    const lctx = stepCtx({ castle: null })
    gocastleMod(lost, lctx)
    assert.equal(lctx.stepStatus, 'failed:gocastle-no-site')
  })

  it('the owner order walk keeps its shape underground (no climb there)', () => {
    const cells = new Map()
    for (let y = 42; y <= 49; y++) cells.set(`0,${y},0`, 'stone')
    const bot = stepBot({ at: pos(0.5, 41, 0.5), cells })
    const ctx = { gocastle: { by: 'Steve', castle: castleState(), phase: 'walk', stalls: 0, fails: 0, lastPos: null }, castle: castleState(), body: { owner: 'gocastle' }, lastGoalKey: '' }
    gocastleMod(bot, ctx)
    assert.ok(ctx.lastGoalKey === 'gocastle-far' || ctx.lastGoalKey === 'gocastle-walk', ctx.lastGoalKey)
  })

  it('climbNeeded: terrain above within 8, canopy/flora/built pass, unloaded opens', () => {
    const surf = stepBot({ at: pos(0.5, 64, 0.5) })
    assert.equal(gocastleMod.climbNeeded(surf), false)
    for (const name of ['stone', 'dirt', 'grass_block', 'gravel', 'iron_ore', 'deepslate', 'bedrock']) {
      const cells = new Map([[`0,70,0`, name]])
      assert.equal(gocastleMod.climbNeeded(stepBot({ at: pos(0.5, 64, 0.5), cells })), true, name)
    }
    for (const name of ['oak_leaves', 'oak_log', 'tall_grass', 'oak_planks', 'torch', 'oak_fence', 'glass', 'sugar_cane', 'snow', 'cobweb']) {
      const cells = new Map([[`0,65,0`, name], [`0,66,0`, name]])
      const bot = stepBot({ at: pos(0.5, 64, 0.5), cells })
      // Solid-box lookalikes still pass by name (boundingBox empty skips first).
      assert.equal(gocastleMod.climbNeeded(bot), false, name)
    }
    const water = new Map([[`0,65,0`, 'water']])
    assert.equal(gocastleMod.climbNeeded(stepBot({ at: pos(0.5, 64, 0.5), cells: water })), false)
    const unloaded = new Map([[`0,65,0`, null]])
    assert.equal(gocastleMod.climbNeeded(stepBot({ at: pos(0.5, 64, 0.5), cells: unloaded })), false)
    assert.equal(gocastleMod.CLIMB_HEADROOM, 8)
  })

  it('a fresh gocastle pick restarts the walk state', async () => {
    await quietAsync(async () => {
      const bot = goalBot({ at: pos(SPAWN.x, SPAWN.y, SPAWN.z) })
      const ctx = { castle: castleState(), work: true, gosite: { phase: 'walk', stalls: 9, fails: 2, lastPos: { x: 1, y: 2, z: 3 } }, step: 'rest', stepStatus: 'done' }
      const d = await goal.decide(bot, ctx)
      assert.equal(d.action, 'gocastle')
      assert.equal(ctx.gosite, null)
    })
  })
})

describe('vmzq.50 return-to-site: movements (R1)', () => {
  const body = require('../src/body')

  function movCtx(over = {}) {
    return {
      movements: { canDig: true, allowSprinting: false, allowParkour: true },
      lastGoalKey: '',
      lastPathNodes: null,
      work: true,
      step: 'gocastle',
      stepStatus: 'running',
      ...over,
    }
  }
  const movBot = { entity: { position: pos(0, 64, 0) } }

  it('the XZ leg borrows no-dig; the climb leg digs', () => {
    const walk = movCtx({ gosite: { phase: 'walk', climbing: false } })
    walk.movements.canDig = true
    body.movementsFor('work', movBot, walk)
    assert.equal(walk.movements.canDig, false)
    const climb = movCtx({ gosite: { phase: 'walk', climbing: true } })
    climb.movements.canDig = false
    body.movementsFor('work', movBot, climb)
    assert.equal(climb.movements.canDig, true)
  })
})
