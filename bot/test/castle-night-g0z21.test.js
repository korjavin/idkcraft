'use strict'

// Bead idkcraft-g0z.21: a castle 113 blocks from home cost every night a
// march (gohome failed x46, deaths on the night transitions). While an
// unfinished, unparked castle stands far from home and the bot works at
// it, the night (from dusk) goes to the shelter step by the site; a bot
// without a castle, or near home, walks home as before.

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

function bot(at, timeOfDay) {
  return {
    username: 'IdkBot',
    players: { Steve: { username: 'Steve', entity: { position: pos(5, 64, 5), username: 'Steve' } } },
    entities: {},
    health: 20,
    food: 20,
    time: { timeOfDay, day: 5 },
    spawnPoint: pos(0, 64, 0),
    entity: { position: pos(at.x, at.y, at.z) },
    inventory: { items: () => [{ name: 'oak_log', count: 14 }, { name: 'cobblestone', count: 2 }] },
    blockAt: (p) => {
      const x = Math.floor(p.x)
      const y = Math.floor(p.y)
      const z = Math.floor(p.z)
      if (x === SITE.x + 5 && y === SITE.y && z === SITE.z + 1) return { name: 'crafting_table', boundingBox: 'block' }
      if (x === SITE.x + 3 && y === SITE.y && z === SITE.z) return { name: 'oak_door', boundingBox: 'block' }
      if (y < SITE.y) return { name: 'dirt', boundingBox: 'block' }
      // Open sky above ground (vmzq.50: solid sky reads underground and
      // the dusk climb-out would stand shelter down).
      return { name: 'air', boundingBox: 'empty' }
    },
    findBlocks: () => [],
    pathfinder: { goal: null, setGoal: () => {}, isMoving: () => false },
    setControlState: () => {},
    clearControlStates: () => {},
    chat: () => {},
  }
}

function ctxWith(castle) {
  return { home: home(), castle: castle === undefined ? { site: { ...CASTLE }, rot: 0, phase: 'body' } : castle, step: 'explore', stepStatus: 'done' }
}

async function quiet(fn) {
  const orig = console.log
  console.log = () => {}
  try { return await fn() } finally { console.log = orig }
}

describe('g0z.21 castle night: shelter by the far castle, not the march home', () => {
  const FGO = goal.MENU.gohome.feasible
  const FSH = goal.MENU.shelter.feasible
  const facts = (time) => ({ time, home: 'built', inside: 'no' })

  it('dusk and night at the far castle: shelter, never gohome', () => {
    for (const t of ['dusk', 'night']) {
      const b = bot(AT_CASTLE, 15000)
      assert.equal(FGO(facts(t), b, ctxWith()), false, `${t}: no march home`)
      assert.equal(FSH(facts(t), b, ctxWith()), true, `${t}: shelter at the site`)
    }
    assert.equal(goal.stepWhy('gohome', facts('dusk'), bot(AT_CASTLE), ctxWith(), ''), 'gohome: sheltering at the castle')
    assert.equal(FSH(facts('day'), bot(AT_CASTLE), ctxWith()), false, 'day works')
  })

  it('without a castle, parked, complete, or near home: as before', () => {
    const near = { x: 190, y: 64, z: 195 }
    const cases = [
      ['no castle', AT_CASTLE, null],
      ['parked', AT_CASTLE, { site: { ...CASTLE }, rot: 0, parked: true }],
      ['complete', AT_CASTLE, { site: { ...CASTLE }, rot: 0, phase: 'complete' }],
      ['near home', near, undefined],
    ]
    for (const [name, at, castle] of cases) {
      const b = bot(at, 12500)
      assert.equal(FGO(facts('dusk'), b, ctxWith(castle)), true, `${name}: dusk marches`)
      assert.equal(FSH(facts('dusk'), b, ctxWith(castle)), false, `${name}: no dusk shelter`)
    }
    // Far from both with an active castle (vmzq.19, reverses the old dusk
    // march): run3 was caught mid-map at two dusks and marched 500 blocks
    // home each time — now it shelters in place.
    {
      const b = bot({ x: 400, y: 64, z: 400 }, 12500)
      assert.equal(FGO(facts('dusk'), b, ctxWith()), false, 'far from both: no dusk march')
      assert.equal(FSH(facts('dusk'), b, ctxWith()), true, 'far from both: shelter in place')
    }
    assert.equal(goal.stepWhy('shelter', facts('dusk'), bot(AT_CASTLE), ctxWith(null), ''), 'shelter: dusk marches home')
    // A castle next to the house: home is close, walk in.
    const close = ctxWith({ site: { x: SITE.x + 10, y: 64, z: SITE.z + 10 }, rot: 0 })
    assert.equal(FGO(facts('dusk'), bot({ x: SITE.x + 20, y: 64, z: SITE.z + 20 }), close), true)
  })

  it('decide: castle dusk shelters past feasible day steps; no castle marches', async () => {
    await quiet(async () => {
      assert.equal((await goal.decide(bot(AT_CASTLE, 12500), ctxWith())).action, 'shelter')
      assert.equal((await goal.decide(bot(AT_CASTLE, 12500), ctxWith(null))).action, 'gohome')
      assert.equal((await goal.decide(bot(AT_CASTLE, 15000), ctxWith())).action, 'shelter')
    })
  })

  it('decide: a dusk shelter holds, and parking the castle releases it home', async () => {
    await quiet(async () => {
      const b = bot(AT_CASTLE, 12500)
      const ctx = ctxWith()
      assert.equal((await goal.decide(b, ctx)).action, 'shelter')
      assert.equal((await goal.decide(b, ctx)).action, 'shelter', 'held')
      ctx.castle.parked = true
      assert.equal((await goal.decide(b, ctx)).action, 'gohome', 'parked: the old dusk march')
    })
  })
})
