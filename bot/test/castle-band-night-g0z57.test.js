'use strict'

// Bead idkcraft-g0z.57 (owner 2026-10-14): at night the bot is INSIDE the
// castle or its house, never sheltering at the fence ring — prod's gohome
// failed from a pit by the fence, latched, and the shelter pillared on the
// ring where creepers blew fence rows and the entrance. By the castle with
// a home in walking range, gohome owns the night (latched or not) and the
// shelter never fits; away from the band, deep below it, or with nothing to
// be inside of, the old night stands.

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const goal = require('../src/goal')
const residence = require('../src/residence')
const castle = require('../src/castle')
const home = require('../src/behaviours/home')
const { Vec3 } = require('vec3')

function pos(x, y, z) {
  const p = { x, y, z, distanceTo: (q) => Math.hypot(x - q.x, y - q.y, z - q.z) }
  p.clone = () => pos(p.x, p.y, p.z)
  p.floored = () => pos(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z))
  return p
}

const SITE = { x: 8, y: 65, z: -12 } // the prod castle corner
const { w: W, d: D } = castle.siteDimensions(0, 3)
const BY_FENCE = { x: 11.5, y: 63, z: SITE.z + D + 1.2 } // the 10-10 pit just outside the ring

function bot(at, timeOfDay) {
  return {
    username: 'IdkBot',
    players: {},
    entities: {},
    health: 20,
    food: 20,
    time: { timeOfDay, day: 5 },
    spawnPoint: pos(0, 64, 0),
    entity: { position: pos(at.x, at.y, at.z) },
    inventory: { items: () => [] },
    blockAt: (p) => (Math.floor(p.y) < SITE.y - 3 ? { name: 'dirt', boundingBox: 'block' } : { name: 'air', boundingBox: 'empty' }),
    findBlocks: () => [],
    pathfinder: { goal: null, setGoal: () => {}, isMoving: () => false },
    setControlState: () => {},
    clearControlStates: () => {},
    chat: () => {},
  }
}

function castleState(phase = 'complete') {
  return { site: { ...SITE }, rot: 0, blueprintVersion: 3, phase }
}
const latched = () => ({ fails: 2, pos: { x: BY_FENCE.x, y: BY_FENCE.y, z: BY_FENCE.z }, day: 5 })
function residenceCtx() {
  const st = castleState()
  return { home: residence.castleHome(st), castle: st, gohomeLatch: latched(), step: 'gohome', stepStatus: 'failed:cannot-reach-home' }
}

const FGO = goal.MENU.gohome.feasible
const FSH = goal.MENU.shelter.feasible
const facts = (time) => ({ time, home: 'built', inside: 'no' })

async function quiet(fn) {
  const orig = console.log
  console.log = () => {}
  try { return await fn() } finally { console.log = orig }
}

describe('g0z.57 castle band night: inside the castle or its house, never at the ring', () => {
  it('castle residence, latched gohome by the fence: gohome, no shelter', () => {
    const b = bot(BY_FENCE, 15000)
    const ctx = residenceCtx()
    assert.equal(goal.castleBandHome(b, ctx), true)
    assert.equal(FGO(facts('night'), b, ctx), true, 'the latch does not hand the ring to shelter')
    assert.equal(FSH(facts('night'), b, ctx), false, 'no pillar on the ring')
    assert.equal(goal.stepWhy('shelter', facts('night'), b, ctx, ''), 'shelter: not by the castle, going in')
  })

  it('the band edge: under 6 from the box in, 6 out; deep below not', () => {
    const ctx = residenceCtx()
    assert.equal(goal.castleBandHome(bot({ x: SITE.x - 5, y: 65, z: SITE.z + 3 }, 15000), ctx), true)
    assert.equal(goal.castleBandHome(bot({ x: SITE.x - 6, y: 65, z: SITE.z + 3 }, 15000), ctx), false)
    assert.equal(goal.castleBandHome(bot({ x: SITE.x + W - 1 + 5, y: 65, z: SITE.z + 3 }, 15000), ctx), true)
    assert.equal(goal.castleBandHome(bot({ x: SITE.x + W - 1 + 6, y: 65, z: SITE.z + 3 }, 15000), ctx), false)
    assert.equal(goal.castleBandHome(bot({ x: SITE.x - 4, y: 65, z: SITE.z - 4 }, 15000), ctx), true, 'corner 4,4: 5.7')
    assert.equal(goal.castleBandHome(bot({ x: SITE.x - 5, y: 65, z: SITE.z - 5 }, 15000), ctx), false, 'corner 5,5: 7.1')
    // Prod 10-09: latched 30+ below the castle the shelter dug in down there
    // — harmless to the castle, and a no-dig walk up would fail all night.
    const deep = bot({ x: SITE.x + 15, y: SITE.y - 20, z: SITE.z + 10 }, 15000)
    assert.equal(goal.castleBandHome(deep, ctx), false)
    assert.equal(FGO(facts('night'), deep, ctx), false, 'deep: latched as before')
    assert.equal(FSH(facts('night'), deep, ctx), true, 'deep: shelter as before')
  })

  it('the band override is bounded: BAND fails a night, then the shelter takes it', async () => {
    await quiet(async () => {
      const b = bot(BY_FENCE, 15000)
      const ctx = residenceCtx()
      ctx.gohomeLatch = null
      let n = 0
      for (; n < 20 && FGO(facts('night'), b, ctx); n++) {
        ctx.step = 'gohome'
        ctx.stepStatus = 'failed:cannot-reach-home'
        await goal.decide(b, ctx) // notes the failure, re-picks
      }
      assert.equal(n, 6, 'six band failures a night, never a dawn-long loop')
      assert.equal(FSH(facts('night'), b, ctx), true, 'spent: the shelter (walks out of the band)')
      b.time.day = 6 // the next night re-arms the budget
      assert.equal(goal.castleBandHome(b, ctx), true)
    })
  })

  it('away from the band the latch still hands the night to shelter', () => {
    const b = bot({ x: SITE.x - 30, y: 65, z: SITE.z }, 15000)
    const ctx = residenceCtx()
    assert.equal(FGO(facts('night'), b, ctx), false)
    assert.equal(FSH(facts('night'), b, ctx), true)
  })

  it('unfinished castle far from a built house in walking range: walk home, no castle-night shelter', () => {
    const house = { site: { x: SITE.x + 15, y: 65, z: SITE.z + D + 60 }, built: true, v: 2 }
    const b = bot(BY_FENCE, 12500)
    const ctx = { home: house, castle: castleState('body'), step: 'castle', stepStatus: 'done' }
    for (const t of ['dusk', 'night']) {
      assert.equal(FGO(facts(t), b, ctx), true, `${t}: heads home`)
      assert.equal(FSH(facts(t), b, ctx), false, `${t}: no ring shelter`)
    }
  })

  it('nothing to be inside of: the old shelter stands', () => {
    const b = bot(BY_FENCE, 15000)
    // Homeless with an active castle (vmzq.32): shelter.
    const homeless = { home: null, castle: castleState('body'), step: 'castle', stepStatus: 'done' }
    assert.equal(goal.castleBandHome(b, homeless), false)
    assert.equal(FSH({ time: 'night', home: 'none', inside: 'no' }, b, homeless), true)
    // A house past the night walk range: shelter, not a death march.
    const far = { home: { site: { x: SITE.x + 15, y: 65, z: SITE.z + D + 200 }, built: true, v: 2 }, castle: castleState('body'), step: 'castle', stepStatus: 'done' }
    assert.equal(goal.castleBandHome(b, far), false)
    assert.equal(FSH(facts('night'), b, far), true)
  })

  it('decide: a latched night by the fence picks gohome, and a running shelter yields to it', async () => {
    await quiet(async () => {
      const b = bot(BY_FENCE, 15000)
      assert.equal((await goal.decide(b, residenceCtx())).action, 'gohome')
      const ctx = residenceCtx()
      ctx.step = 'shelter'
      ctx.stepStatus = 'running'
      assert.equal((await goal.decide(b, ctx)).action, 'gohome', 'a ring shelter is not sticky')
    })
  })

  it('shelter by the fence of a complete castle walks out of the band before any pillar', async () => {
    // Flat dirt at y<=64, every castle cell air (the veto reads the plan,
    // not the world): the spot pick must refuse every band cell.
    const b = bot({ x: 11.5, y: 65, z: SITE.z + D + 1.5 }, 15000)
    b.blockAt = (p) => {
      const x = Math.floor(p.x), y = Math.floor(p.y), z = Math.floor(p.z)
      const solid = y <= 64
      return { name: solid ? 'dirt' : 'air', position: new Vec3(x, y, z), boundingBox: solid ? 'block' : 'empty' }
    }
    b.entity.onGround = true
    const ctx = { step: 'shelter', stepStatus: 'running', castle: castleState() }
    const logs = []
    const orig = console.log
    console.log = (m) => { logs.push(String(m)) }
    try { home.shelter(b, ctx, null, null) } finally { console.log = orig }
    assert.ok(logs.some((m) => m.includes('shelter leaving the castle band')), JSON.stringify(logs))
    const walk = ctx.shelter && ctx.shelter.dig && ctx.shelter.dig.walk
    assert.ok(walk, JSON.stringify(logs))
    assert.equal(castle.nightBand(ctx.castle, walk), false, `spot outside the band: ${JSON.stringify(walk)}`)
    // g0z.63: and outside the complete castle's 16 apron (pillar/cap refused there).
    assert.equal(castle.apronOf(ctx.castle, walk), false, `spot outside the apron: ${JSON.stringify(walk)}`)
    assert.ok(Math.hypot(walk.x - 11, walk.z - (SITE.z + D + 1)) <= 16, 'the nearest such spot, not a march')
    assert.equal(ctx.recovery == null || ctx.recovery.action !== 'pillar_up', true, 'no pillar on the ring')
  })
})
