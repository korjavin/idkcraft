'use strict'

// Bead idkcraft-vd93 (owner 2026-10-28 "go home nightly"): at dusk the
// knock-off beats castle-first — the bot marches home and sleeps even
// with an active castle word — and resumes the same castle leg at dawn.
// Night keeps the old guards (far = shelter, latched = shelter, at the
// castle = shelter); the climb-out still runs first from a cave (vmzq.50).
// Sleep itself, its fight veto and the no-bed honest skip are the a8rb
// chain (stay-sleep-a8rb.test.js); this file pins the arbitration around
// it and the dawn resume.

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const goal = require('../src/goal')

function pos(x, y, z) {
  const p = { x, y, z, distanceTo: (q) => Math.hypot(x - q.x, y - q.y, z - q.z) }
  p.clone = () => pos(p.x, p.y, p.z)
  p.floored = () => pos(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z))
  return p
}

const SITE = { x: 200, y: 64, z: 200 }
const CASTLE = { x: 70, y: 64, z: 190 } // ~115 blocks west of home
const AT_CASTLE = { x: 85, y: 64, z: 200 }
const MIDMAP = { x: 400, y: 64, z: 400 }

function home() {
  return {
    site: { ...SITE },
    built: true,
    v: 2,
    interior: { min: { x: SITE.x + 1, y: SITE.y, z: SITE.z + 1 }, max: { x: SITE.x + 5, y: SITE.y + 1, z: SITE.z + 4 } },
    door: { x: SITE.x + 3, y: SITE.y, z: SITE.z },
    table: { x: SITE.x + 5, y: SITE.y, z: SITE.z + 1 },
  }
}

// underground: false = open sky (surface), true = stone overhead (cave).
function bot(at, timeOfDay, underground = false, hostile = false) {
  const entities = hostile
    ? { 1: { name: 'zombie', type: 'mob', position: { distanceTo: () => 5 } } }
    : {}
  return {
    username: 'IdkBot',
    players: {},
    entities,
    health: 20,
    food: 20,
    time: { timeOfDay, day: 5 },
    spawnPoint: pos(0, 64, 0),
    entity: { position: pos(at.x, at.y, at.z) },
    inventory: { items: () => [{ name: 'oak_log', count: 14 }, { name: 'cobblestone', count: 2 }] },
    blockAt: (p) => {
      const y = Math.floor(p.y)
      if (underground && y >= at.y + 1) return { name: 'stone', boundingBox: 'block' }
      if (y < 64) return { name: 'dirt', boundingBox: 'block' }
      return { name: 'air', boundingBox: 'empty' }
    },
    findBlocks: () => [],
    pathfinder: { goal: null, setGoal: () => {}, isMoving: () => false },
    setControlState: () => {},
    clearControlStates: () => {},
    chat: () => {},
  }
}

const castleCtx = (over = {}) => ({
  home: home(),
  castle: { site: { ...CASTLE }, rot: 0, phase: 'body' },
  step: 'castle',
  stepStatus: 'running',
  ...over,
})

async function quiet(fn) {
  const orig = console.log
  console.log = () => {}
  try { return await fn() } finally { console.log = orig }
}

describe('vd93 go home nightly: dusk knock-off beats castle-first', () => {
  const FGO = goal.MENU.gohome.feasible
  const FSH = goal.MENU.shelter.feasible
  const outFacts = (time) => ({ time, home: 'built', inside: 'no' })

  it('dusk at the far castle: gohome, never the site shelter', async () => {
    const b = bot(AT_CASTLE, 12500)
    assert.equal(FGO(outFacts('dusk'), b, castleCtx()), true)
    await quiet(async () => {
      assert.equal((await goal.decide(b, castleCtx())).action, 'gohome')
    })
  })

  it('dusk in knock-off range with an active castle: march home, not pillar in place', () => {
    const b = bot({ x: 300, y: 64, z: 300 }, 12500) // ~141 out, inside the ring + walk budget
    assert.equal(FGO(outFacts('dusk'), b, castleCtx()), true)
  })

  it('dusk underground in range: the knock-off starts, no castle detour', async () => {
    // Revmux 02-after-fix: the climb veto diverted in-range bots to a full
    // gocastle walk with no hand-back. A cave start marches like before —
    // the walk fails, latches, and hands to the climb leg below.
    const b = bot({ x: 300, y: 30, z: 300 }, 12500, true)
    assert.equal(FGO(outFacts('dusk'), b, castleCtx()), true)
    assert.equal(goal.stepWhy('gohome', outFacts('dusk'), b, castleCtx(), ''), null)
    await quiet(async () => {
      assert.equal((await goal.decide(b, castleCtx())).action, 'gohome')
    })
  })

  it('dusk underground past knock-off range: the climb leg runs to the site', async () => {
    // Far castle, bot caving 700 out: the vetoes stand, shelter refuses
    // the cave (vmzq.50), so gocastle climbs out and walks the site
    // shelter — stepWhy names the site shelter, honestly.
    const b = bot({ x: 700, y: 30, z: 700 }, 12500, true)
    const ctx = castleCtx({ castle: { site: { x: 600, y: 64, z: 600 }, rot: 0, phase: 'body' } })
    assert.equal(FGO(outFacts('dusk'), b, ctx), false)
    assert.equal(goal.stepWhy('gohome', outFacts('dusk'), b, ctx, ''), 'gohome: sheltering at the castle')
    await quiet(async () => {
      assert.equal((await goal.decide(b, ctx)).action, 'gocastle')
    })
  })

  it('dusk past knock-off range: the far castle keeps the site shelter', async () => {
    // ~566 blocks out: the march cannot arrive before the night-far force
    // would pillar it mid-route, so the vetoes stand (revmux 01-review).
    const far = { site: { x: 600, y: 64, z: 600 }, rot: 0, phase: 'body' }
    const at = { x: 615, y: 64, z: 600 }
    const ctx = castleCtx({ castle: far })
    assert.equal(FGO(outFacts('dusk'), bot(at, 12500), ctx), false)
    assert.equal(goal.stepWhy('gohome', outFacts('dusk'), bot(at, 12500), ctx, ''), 'gohome: sheltering at the castle')
    assert.equal(FSH(outFacts('dusk'), bot(at, 12500), ctx), true)
    await quiet(async () => {
      assert.equal((await goal.decide(bot(at, 12500), ctx)).action, 'shelter')
    })
  })

  it('night keeps the old guards: at the castle and far from home it shelters', async () => {
    const atSite = bot(AT_CASTLE, 15000)
    assert.equal(FGO(outFacts('night'), atSite, castleCtx()), false)
    assert.equal(FSH(outFacts('night'), atSite, castleCtx()), true)
    const far = bot(MIDMAP, 15000)
    assert.equal(FGO(outFacts('night'), far, castleCtx()), false)
    await quiet(async () => {
      assert.equal((await goal.decide(atSite, castleCtx())).action, 'shelter')
      assert.equal(goal.stepWhy('gohome', outFacts('night'), atSite, castleCtx(), ''), 'gohome: sheltering at the castle')
    })
  })

  it('a latched dusk march still hands the night to shelter', () => {
    const b = bot(AT_CASTLE, 12500)
    const ctx = castleCtx({ gohomeLatch: { day: 5, fails: 2, pos: { ...AT_CASTLE }, band: 0 } })
    assert.equal(FGO(outFacts('dusk'), b, ctx), false)
    assert.equal(FSH(outFacts('dusk'), b, ctx), true)
  })

  it('no threat gate on the march: fight preempts above the goal, never vetoes it', () => {
    const b = bot(AT_CASTLE, 12500, false, true)
    assert.equal(FGO(outFacts('dusk'), b, castleCtx()), true)
  })

  it('night inside hands to stay (the a8rb sleep chain), dawn resumes the same leg', async () => {
    const inFacts = (time) => ({ time, home: 'built', inside: 'yes' })
    assert.equal(goal.MENU.stay.feasible(inFacts('night')), true)
    const INSIDE = { x: 202.5, y: 64, z: 202.5 } // geometric interior of the home() fixture
    await quiet(async () => {
      assert.equal((await goal.decide(bot(INSIDE, 15000), castleCtx({ step: 'gohome', stepStatus: 'done' }))).action, 'stay')
      // One ctx through the whole night: dusk knocks off, dawn walks back.
      // The leg is mid-progress (cursor + derived word): the night must
      // keep every field, so dawn resumes the same leg, not a re-plan.
      const ctx = castleCtx({ step: 'castle', stepStatus: 'running' })
      ctx.castleCursor = 3
      ctx.castleCell = { x: 71, y: 64, z: 191 }
      assert.equal((await goal.decide(bot(AT_CASTLE, 12500), ctx)).action, 'gohome')
      const leg = JSON.stringify({ castle: ctx.castle, castleCursor: ctx.castleCursor, castleCell: ctx.castleCell, wordKind: ctx.castleWord && ctx.castleWord.kind })
      ctx.step = 'gohome'
      ctx.stepStatus = 'done'
      assert.equal((await goal.decide(bot(INSIDE, 15000), ctx)).action, 'stay')
      ctx.step = 'stay'
      const dawn = await goal.decide(bot(SITE, 1000), ctx)
      assert.equal(dawn.action, 'gocastle')
      assert.equal(JSON.stringify({ castle: ctx.castle, castleCursor: ctx.castleCursor, castleCell: ctx.castleCell, wordKind: ctx.castleWord && ctx.castleWord.kind }), leg)
    })
  })
})
