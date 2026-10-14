'use strict'

// Bead idkcraft-g0z.59 (owner 2026-10-14): at night the bot is inside the
// castle or its house. (1) An unbuilt house order next to a complete castle
// ran no night step at all — the castle is now the night residence (enter,
// stay/sleep, dawn exit) and the house order keeps the day. (2) v2 keeps no
// castle of its own: it reads the peer bot's complete castle read-only
// (BOT_CASTLE_PEER) and sleeps inside it too, without adopting it.

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const goal = require('../src/goal')
const residence = require('../src/residence')
const memory = require('../src/memory')
const home = require('../src/behaviours/home')

function pos(x, y, z) {
  const p = { x, y, z, distanceTo: (q) => Math.hypot(x - q.x, y - q.y, z - q.z) }
  p.clone = () => pos(p.x, p.y, p.z)
  p.floored = () => pos(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z))
  p.offset = (dx, dy, dz) => pos(p.x + dx, p.y + dy, p.z + dz)
  return p
}

const SITE = { x: 8, y: 65, z: -12 }
const HOUSE = () => ({ site: { x: SITE.x + 45, y: 65, z: SITE.z + 10 }, built: false, v: 2 }) // a 'build here' by the castle

function bot(at, timeOfDay, username = 'IdkBot') {
  return {
    username,
    players: {},
    entities: {},
    health: 20,
    food: 20,
    time: { timeOfDay, day: 5 },
    spawnPoint: pos(0, 64, 0),
    entity: { position: pos(at.x, at.y, at.z) },
    inventory: { items: () => [] },
    blockAt: () => ({ name: 'air', boundingBox: 'empty' }),
    findBlocks: () => [],
    pathfinder: { goal: null, setGoal(g) { this.goal = g }, isMoving: () => false },
    setControlState: () => {},
    clearControlStates: () => {},
    chat: () => {},
  }
}
const castleState = (phase = 'complete') => ({ site: { ...SITE }, rot: 0, blueprintVersion: 3, phase, residence: true, blocked: {}, parked: false })
const NEAR_HOUSE = { x: SITE.x + 44, y: 65, z: SITE.z + 8 }
const NIGHT = 15000
const DUSK = 12500
const DAY = 3000

async function quiet(fn) {
  const orig = console.log
  console.log = () => {}
  try { return await fn() } finally { console.log = orig }
}

describe('g0z.59 night residence: the castle covers an unbuilt house', () => {
  it('nightHome: the complete castle in range of an unbuilt house, else the home', () => {
    const ctx = { home: HOUSE(), castle: castleState() }
    const nh = residence.nightHome(ctx, NEAR_HOUSE)
    assert.equal(nh.kind, 'castle')
    assert.deepEqual({ x: nh.site.x, y: nh.site.y, z: nh.site.z }, SITE)
    assert.equal(residence.nightHome(ctx, NEAR_HOUSE), nh, 'cached: bed claims ride the night')
    const built = { ...HOUSE(), built: true }
    assert.equal(residence.nightHome({ home: built, castle: castleState() }, NEAR_HOUSE), built, 'a built house is the night home')
    const far = { site: { x: SITE.x + 200, y: 65, z: SITE.z }, built: false, v: 2 }
    assert.equal(residence.nightHome({ home: far, castle: castleState() }, NEAR_HOUSE), far, 'castle past the walk range of the site')
    const h = HOUSE()
    assert.equal(residence.nightHome({ home: h, castle: castleState('body') }, NEAR_HOUSE), h, 'an unfinished castle is no residence')
    assert.equal(residence.nightHome({ home: h, castle: { ...castleState(), blueprintVersion: 1 } }, NEAR_HOUSE), h, 'v1 castles never were')
    assert.equal(residence.nightHome({ home: null, castle: castleState() }, NEAR_HOUSE).kind, 'castle', 'homeless: by the bot')
    assert.equal(residence.nightHome({ home: null, castle: castleState() }, { x: 500, y: 65, z: 500 }), null)
  })

  it('facts: built at dusk and night, the house site by day', () => {
    const ctx = { home: HOUSE(), castle: castleState() }
    assert.equal(goal.goalFacts(bot(NEAR_HOUSE, DAY), ctx).home, 'site')
    for (const t of [DUSK, NIGHT]) assert.equal(goal.goalFacts(bot(NEAR_HOUSE, t), ctx).home, 'built')
    const inn = residence.CASTLE.entrance(residence.castleHome(castleState())).inside
    const f = goal.goalFacts(bot({ x: inn.x + 0.5, y: inn.y, z: inn.z + 0.5 }, NIGHT), ctx)
    assert.equal(f.inside, 'yes', 'inside the castle reads inside')
  })

  it('decide: dusk by the unbuilt house heads to the castle; inside, stay', async () => {
    await quiet(async () => {
      const ctx = { home: HOUSE(), castle: castleState(), step: 'build', stepStatus: 'done' }
      const b = bot(NEAR_HOUSE, DUSK)
      assert.equal((await goal.decide(b, ctx)).action, 'gohome')
      home.gohome(b, ctx, null, null)
      assert.equal(ctx.gohome.phase, 'walk', 'walking to the castle, not yielding to build')
      const out = residence.CASTLE.entrance(residence.castleHome(castleState())).outside
      const g = b.pathfinder.goal
      assert.ok(g, 'a walk goal was issued')
      assert.ok(Math.hypot(g.x - out.x, g.z - out.z) <= 1, `aims at the castle entrance: ${JSON.stringify(g)} vs ${JSON.stringify(out)}`)
      const inn = residence.CASTLE.entrance(residence.castleHome(castleState())).inside
      const inside = bot({ x: inn.x + 0.5, y: inn.y, z: inn.z + 0.5 }, NIGHT)
      const c2 = { home: HOUSE(), castle: castleState(), step: 'gohome', stepStatus: 'done' }
      assert.equal((await goal.decide(inside, c2)).action, 'stay')
      home.stay(inside, c2, null, null)
      assert.notEqual(c2.stepStatus, 'failed:not-inside', 'stay holds inside the castle')
      assert.equal(c2.home.built, false, 'the house order is untouched')
    })
  })

  it('inside the castle: shelter yields, no creeper flee, an intruder in the castle counts', () => {
    const inn = residence.CASTLE.entrance(residence.castleHome(castleState())).inside
    const at = { x: inn.x + 0.5, y: inn.y, z: inn.z + 0.5 }
    const ctx = { home: HOUSE(), castle: castleState(), step: 'shelter', stepStatus: 'running', inShelter: true }
    home.shelter(bot(at, NIGHT), ctx, null, null)
    assert.equal(ctx.stepStatus, 'done', 'walked in: stay owns the inside')
    const b = bot(at, NIGHT)
    b.entities = { 1: { id: 1, name: 'creeper', type: 'hostile', isValid: true, position: pos(at.x + 3, at.y, at.z) } }
    const { fleeReflex } = require('../src/reflexes')
    assert.ok(fleeReflex(b, { ...ctx, inShelter: false }), 'the control: out of shelter the creeper is fled')
    assert.equal(fleeReflex(b, { ...ctx, inShelter: true }), false, 'no flee out of the castle')
  })

  it('night-far is measured to the castle: past the walk range the night shelters', () => {
    // House 90 off the castle, bot 100 past the house on the far side.
    const house = { site: { x: SITE.x + 90, y: 65, z: SITE.z }, built: false, v: 2 }
    const ctx = { home: house, castle: castleState(), step: 'build', stepStatus: 'done' }
    const b = bot({ x: SITE.x + 150, y: 65, z: SITE.z }, NIGHT)
    const f = goal.goalFacts(b, ctx)
    assert.equal(f.home, 'built')
    assert.equal(goal.MENU.gohome.feasible(f, b, ctx), false, 'no night march to the castle')
    assert.equal(goal.MENU.shelter.feasible(f, b, ctx), true)
  })

  it('the house far from the castle keeps the old night', () => {
    const far = { site: { x: SITE.x + 200, y: 65, z: SITE.z }, built: false, v: 2 }
    const ctx = { home: far, castle: castleState() }
    assert.equal(goal.goalFacts(bot({ x: far.site.x, y: 65, z: far.site.z }, NIGHT), ctx).home, 'site')
  })
})

describe('g0z.59 peer castle: v2 reads v1\'s complete castle, never writes it', () => {
  function setup(castle) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'g0z59-'))
    const b = bot(NEAR_HOUSE, NIGHT, 'IdkBotV2')
    const peerFile = path.join(dir, 'IdkBot.json')
    const doc = { v: 1, world: memory.worldKey(b), castle }
    fs.writeFileSync(peerFile, JSON.stringify(doc))
    const env = { BOT_MEMORY_FILE: path.join(dir, 'IdkBotV2.json'), BOT_CASTLE_PEER: 'IdkBot' }
    return { dir, b, peerFile, env, raw: fs.readFileSync(peerFile, 'utf8') }
  }
  let clock = 1e12
  const tick = () => (clock += memory.SAVE_MIN_MS)

  it('a complete peer castle becomes the night home; no adoption, no write', async () => {
    const { b, peerFile, env, raw } = setup(castleState())
    const ctx = { home: HOUSE(), castle: null }
    memory.refreshPeerCastle(b, ctx, tick(), env)
    assert.ok(ctx.peerCastle && ctx.peerCastle.phase === 'complete')
    assert.equal(ctx.castle, null, 'never its own castle: no castle work')
    assert.equal(residence.wanted(ctx), undefined, 'no residence switch')
    assert.equal(residence.nightHome(ctx, NEAR_HOUSE).kind, 'castle')
    assert.equal(goal.goalFacts(b, ctx).home, 'built')
    await quiet(async () => { assert.equal((await goal.decide(b, { ...ctx, step: 'build', stepStatus: 'done' })).action, 'gohome') })
    assert.equal(fs.readFileSync(peerFile, 'utf8'), raw, 'the peer file is untouched')
    // Homeless v2 by the castle: the band rule applies to the peer castle too.
    const ring = bot({ x: SITE.x - 3, y: 65, z: SITE.z + 3 }, NIGHT, 'IdkBotV2')
    assert.equal(goal.castleBandHome(ring, { home: null, castle: null, peerCastle: ctx.peerCastle }), true)
  })

  it('unset, unfinished, v1-blueprint or other-world peers read nothing', () => {
    for (const [castle, envPatch, world] of [
      [castleState(), { BOT_CASTLE_PEER: '' }, null],
      [castleState('body'), {}, null],
      [{ ...castleState(), blueprintVersion: 1 }, {}, null],
      [castleState(), {}, 'spawn:1,2,3'],
    ]) {
      const { b, peerFile, env } = setup(castle)
      if (world) fs.writeFileSync(peerFile, JSON.stringify({ v: 1, world, castle }))
      const ctx = { home: HOUSE(), peerCastle: castleState() }
      memory.refreshPeerCastle(b, ctx, tick(), { ...env, ...envPatch })
      assert.equal(ctx.peerCastle, null, JSON.stringify({ castle, envPatch, world }))
    }
  })

  it('throttled: one read per SAVE_MIN_MS', () => {
    const { b, peerFile, env } = setup(castleState())
    const ctx = { home: HOUSE() }
    const t = tick()
    memory.refreshPeerCastle(b, ctx, t, env)
    assert.ok(ctx.peerCastle)
    fs.unlinkSync(peerFile)
    memory.refreshPeerCastle(b, ctx, t + 1000, env)
    assert.ok(ctx.peerCastle, 'within the window: no re-read')
    memory.refreshPeerCastle(b, ctx, tick(), env)
    assert.equal(ctx.peerCastle, null, 'next window: the gone file reads nothing')
  })
})
