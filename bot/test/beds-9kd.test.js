'use strict'

// Bead idkcraft-9kd: the beds sheep search walked into an ocean monument —
// 9 guardian/drowned deaths in one day, one cell twice. Guardians are not in
// the hostile snapshot, so the deaths read as nearest=none and nothing was
// ever marked; and every death-respawn released the stepFail hold, so the
// search re-hunted the same day. Two fixes: a water death bans a wide danger
// disc that the explore/bring rings skip, and the second failed wool hunt of
// one MC day latches beds infeasible until tomorrow.

const { describe, it, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const danger = require('../src/danger')
const detour = require('../src/detour')
const memory = require('../src/memory')
const goal = require('../src/goal')
const explore = require('../src/behaviours/explore')
const beds = require('../src/behaviours/beds')
const { handleDeath } = require('../src/index')

// Prod cell, twice in one day (2026-09-28 15:34 and 18:29, guardian magic).
const MONUMENT = { x: -256, y: 62, z: -294 }

function pos(x, y, z) {
  const p = { x, y, z, distanceTo: (q) => Math.hypot(x - q.x, y - q.y, z - q.z) }
  p.clone = () => pos(p.x, p.y, p.z)
  p.floored = () => pos(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z))
  return p
}

function deathBot(at, blockName) {
  const ctx = {}
  const bot = {
    username: 'IdkBot',
    players: {},
    entities: {},
    health: 0,
    time: { timeOfDay: 6000, day: 5 },
    spawnPoint: pos(0, 64, 0),
    entity: { position: pos(at.x, at.y, at.z) },
    blockAt: (p) => ({ name: typeof blockName === 'function' ? blockName(p) : blockName }),
    chat: () => {},
  }
  bot._tickerCtx = ctx
  return { bot, ctx }
}

function exploreBot(at) {
  const calls = { goals: [] }
  return {
    calls,
    chats: [],
    username: 'IdkBot',
    players: {},
    entities: {},
    spawnPoint: pos(0, 64, 0),
    entity: { position: pos(at.x, at.y, at.z) },
    time: { timeOfDay: 6000, day: 5 },
    registry: { blocksByName: {} },
    pathfinder: { goal: null, setGoal: (g) => { calls.goals.push(g) }, isMoving: () => false },
    findBlocks: () => [],
    blockAt: () => ({ name: 'stone' }),
    chat: () => {},
  }
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

function bedsBot() {
  return {
    chats: [],
    username: 'IdkBot',
    players: {},
    entities: {},
    time: { timeOfDay: 6000, day: 5 },
    spawnPoint: pos(0, 64, 0),
    entity: { position: pos(0, 65, 0) },
    inventory: { items: () => [] },
    registry: { blocksByName: {}, itemsByName: {} },
    blockAt: () => ({ name: 'stone' }),
    chat: (m) => {},
  }
}

function quiet(fn) {
  const lines = []
  const origLog = console.log
  const origErr = console.error
  console.log = (m) => lines.push(String(m))
  console.error = (m) => lines.push(String(m))
  try {
    fn()
  } finally {
    console.log = origLog
    console.error = origErr
  }
  return lines
}

describe('9kd water death marks a wide danger disc', () => {
  it('death in water marks, 20 out reads covered, 33 out reads far', () => {
    const { bot, ctx } = deathBot(MONUMENT, 'water')
    let marked = false
    quiet(() => { marked = danger.markWaterDeath(bot, ctx) })
    assert.equal(marked, true)
    assert.equal(danger.count(ctx), 1)
    assert.equal(danger.covers(ctx, { x: MONUMENT.x + 20, z: MONUMENT.z }), true)
    assert.equal(danger.covers(ctx, { x: MONUMENT.x + 32, z: MONUMENT.z }), true, 'boundary inclusive')
    assert.equal(danger.covers(ctx, { x: MONUMENT.x + 33, z: MONUMENT.z }), false)
    assert.equal(danger.WATER_RADIUS, 32)
  })

  it('death on dry land marks nothing', () => {
    const { bot, ctx } = deathBot({ x: 10, y: 65, z: 20 }, 'grass_block')
    assert.equal(danger.markWaterDeath(bot, ctx), false)
    assert.equal(danger.count(ctx), 0)
  })

  it('revmux 01: kelp/seagrass feet and a water head count as a water death', () => {
    for (const name of ['kelp', 'kelp_plant', 'seagrass', 'tall_seagrass', 'bubble_column']) {
      const { bot, ctx } = deathBot(MONUMENT, name)
      assert.equal(danger.markWaterDeath(bot, ctx), true, name)
      assert.equal(danger.count(ctx), 1)
    }
    const feet = MONUMENT.y
    const { bot, ctx } = deathBot(MONUMENT, (p) => (Math.floor(p.y) >= feet + 1 ? 'water' : 'sand'))
    assert.equal(danger.markWaterDeath(bot, ctx), true, 'head under water')
    const v3 = deathBot(MONUMENT, (p) => (Math.floor(p.y) >= feet + 1 ? 'water' : 'sand'))
    v3.bot.entity.position.offset = (dx, dy, dz) => pos(MONUMENT.x + dx, MONUMENT.y + dy, MONUMENT.z + dz)
    assert.equal(danger.markWaterDeath(v3.bot, v3.ctx), true, 'Vec3 offset path')
    const dry = deathBot({ x: 10, y: 65, z: 20 }, (p) => (Math.floor(p.y) >= 66 ? 'air' : 'sand'))
    assert.equal(danger.markWaterDeath(dry.bot, dry.ctx), false, 'dry feet and head')
  })

  it('handleDeath wires the mark: water corpse bans the swim, dry corpse does not', () => {
    const wet = deathBot(MONUMENT, 'water')
    quiet(() => handleDeath(wet.bot, null))
    assert.equal(danger.count(wet.ctx), 1)
    assert.equal(danger.covers(wet.ctx, { x: MONUMENT.x, z: MONUMENT.z + 20 }), true)
    const dry = deathBot({ x: 10, y: 65, z: 20 }, 'stone')
    quiet(() => handleDeath(dry.bot, null))
    assert.equal(danger.count(dry.ctx), 0)
  })

  it('revmux 01: a water death drops the in-flight leg target, a dry one keeps it', () => {
    const wet = deathBot(MONUMENT, 'water')
    wet.ctx.explore = { visited: new Set(), target: { x: -200, z: -200 }, issuedKey: 'explore:-200,-200' }
    wet.ctx.bring = { self: 'beds', phase: 'searchwalk' }
    quiet(() => handleDeath(wet.bot, null))
    assert.equal(wet.ctx.explore.target, null, 'leg re-picks past the disc instead of swimming back')
    assert.equal(wet.ctx.explore.issuedKey, null)
    assert.ok(wet.ctx.bring, 'the order itself survives, only the stale target drops')
    const dry = deathBot({ x: 10, y: 65, z: 20 }, 'stone')
    dry.ctx.explore = { visited: new Set(), target: { x: 50, z: 50 }, issuedKey: 'explore:50,50' }
    quiet(() => handleDeath(dry.bot, null))
    assert.deepEqual(dry.ctx.explore.target, { x: 50, z: 50 }, 'dry deaths keep the leg')
  })

  it('revmux 02: the killer leg chunk is consumed, so the re-pick provably advances', () => {
    // Round-1 gap: T outside the fresh disc was re-picked identically (plus a
    // stale GoalXZ via the matching lastGoalKey). Death 100+ out from T.
    const death = { x: 100, y: 62, z: 0 }
    const T = { x: 0, z: -16 }
    const { bot, ctx } = deathBot(death, 'water')
    ctx.home = v2home({ x: 0, y: 64, z: 0 })
    ctx.explore = { visited: new Set(), target: { ...T }, issuedKey: 'explore:0,-16' }
    ctx.lastGoalKey = 'explore:0,-16'
    quiet(() => handleDeath(bot, null))
    assert.ok(ctx.explore.visited.has('0,-1'), 'T chunk consumed')
    // Respawned tick: re-pick must differ from T and re-issue the goal.
    const walker = exploreBot({ x: 0, y: 64, z: 0 })
    ctx.stepStatus = 'running'
    explore(walker, ctx, null, null)
    assert.deepEqual(ctx.explore.target, { x: 16, z: 0 }, 'past T and past the disc')
    assert.notDeepEqual(ctx.explore.target, T)
    assert.equal(walker.calls.goals.length, 1, 'new key re-issues the goal')
  })

  it('revmux 02: dropDeadLeg is a no-op without a leg, never throws', () => {
    assert.equal(explore.dropDeadLeg(null), false)
    assert.equal(explore.dropDeadLeg({}), false)
    assert.equal(explore.dropDeadLeg({ explore: null }), false)
    assert.equal(explore.dropDeadLeg({ explore: { visited: new Set(), target: null } }), false)
    const noVisited = { explore: { target: { x: 1, z: 2 }, issuedKey: 'k' } }
    assert.equal(explore.dropDeadLeg(noVisited), true)
    assert.equal(noVisited.explore.target, null)
  })

  it('wide marks keep their width, default marks keep the old shape', () => {
    const ctx = {}
    danger.mark(ctx, { x: 0, y: 64, z: 0 }, 1000, 32)
    danger.mark(ctx, { x: 100, y: 64, z: 0 }, 1000)
    assert.deepEqual(danger.spots(ctx, 1000), [
      { x: 0, y: 64, z: 0, r: 32 },
      { x: 100, y: 64, z: 0 },
    ])
    assert.equal(danger.covers(ctx, { x: 20, z: 0 }, 1000), true, 'wide disc reaches 20')
    assert.equal(danger.covers(ctx, { x: 120, z: 0 }, 1000), false, 'default mark still 6')
    assert.equal(danger.covers(ctx, { x: 106, z: 0 }, 1000), true, 'default mark reaches 6')
  })

  it('revmux 01: near() stays uniform, so recover/gather/flat/deep never widen', () => {
    const ctx = {}
    danger.mark(ctx, { x: 0, y: 64, z: 0 }, 1000, 32)
    assert.equal(danger.near(ctx, { x: 20, z: 0 }, undefined, 1000), false, 'wide disc reads 6 here')
    assert.equal(danger.near(ctx, { x: 6, z: 0 }, undefined, 1000), true)
    assert.equal(danger.covers(ctx, null, 1000), false)
    assert.equal(danger.covers(null, { x: 0, z: 0 }, 1000), false)
  })

  it('garbage radius reads as default, huge clamps to MAX_RADIUS', () => {
    const ctx = {}
    danger.mark(ctx, { x: 0, y: 64, z: 0 }, 1000, 'far')
    assert.deepEqual(danger.spots(ctx, 1000), [{ x: 0, y: 64, z: 0 }])
    danger.mark(ctx, { x: 50, y: 64, z: 0 }, 1000, 10000)
    assert.deepEqual(danger.spots(ctx, 1000)[1], { x: 50, y: 64, z: 0, r: danger.MAX_RADIUS })
  })
})

describe('9kd ring search skips the water-death disc', () => {
  it('acceptance: mark on the prod cell -> next ring pick lands past 32', () => {
    // Anchor on the mark: every ring-16 point sits 16 out and ring-32 north
    // sits exactly 32 out, so a 6-radius mark would pick ring 16 and only a
    // wide disc pushes the pick to the ring-32 diagonal.
    const bot = exploreBot({ x: MONUMENT.x, y: 64, z: MONUMENT.z })
    const ctx = { home: v2home({ x: MONUMENT.x, y: 64, z: MONUMENT.z }), stepStatus: 'running' }
    danger.mark(ctx, { ...MONUMENT }, Date.now(), danger.WATER_RADIUS)
    explore(bot, ctx, null, null)
    const t = ctx.explore.target
    assert.deepEqual(t, { x: MONUMENT.x + 23, z: MONUMENT.z - 23 })
    assert.ok(Math.hypot(t.x - MONUMENT.x, t.z - MONUMENT.z) > 32)
  })

  it('detour routes gohome/forage around the whole disc, not a 6-cell pit', () => {
    const ctx = {}
    danger.mark(ctx, { x: 0, y: 64, z: 0 }, Date.now(), danger.WATER_RADIUS)
    // The leg pierces the disc 10 off-centre: a pit mark would go direct.
    const w = detour.via(ctx, { x: -100, y: 64, z: 10 }, { x: 100, y: 64, z: 10 })
    assert.ok(w, 'waypoint issued')
    assert.ok(Math.hypot(w.x - 0, w.z - 0) > 32, `waypoint clears the disc: ${JSON.stringify(w)}`)
  })

  it('detour still goes direct past a default mark at the same offset', () => {
    const ctx = {}
    danger.mark(ctx, { x: 0, y: 64, z: 0 }, Date.now())
    assert.equal(detour.via(ctx, { x: -100, y: 64, z: 10 }, { x: 100, y: 64, z: 10 }), null)
  })

  it('revmux 01: feet inside a wide disc still route around a mid-leg pit', () => {
    const ctx = {}
    danger.mark(ctx, { x: 0, y: 64, z: 0 }, Date.now(), danger.WATER_RADIUS)
    danger.mark(ctx, { x: 60, y: 64, z: 0 }, Date.now())
    // Feet 10 out of the water death: past the default feet hold, so the
    // mid-leg pit (hit first along the walk) still gets its waypoint.
    const w = detour.via(ctx, { x: 10, y: 64, z: 0 }, { x: 100, y: 64, z: 0 })
    assert.ok(w, 'waypoint issued')
    assert.ok(Math.hypot(w.x - 60, w.z - 0) > 6, `waypoint clears the pit: ${JSON.stringify(w)}`)
    assert.ok(Math.hypot(w.x - 0, w.z - 0) > 32, `waypoint clears the disc: ${JSON.stringify(w)}`)
  })

  it('revmux 01: a leg ending inside a wide disc still goes direct', () => {
    const ctx = {}
    danger.mark(ctx, { x: 0, y: 64, z: 0 }, Date.now(), danger.WATER_RADIUS)
    // Routing around a disc the leg ends inside would orbit it forever.
    assert.equal(detour.via(ctx, { x: -100, y: 64, z: 0 }, { x: 10, y: 64, z: 0 }), null)
  })
})

describe('9kd sheepless day latch', () => {
  const FACTS = { time: 'day', home: 'built', beds: 'none' }

  function failedEpisode(ctx) {
    // One exhausted wool hunt: legs spent, nothing found.
    ctx.stepStatus = null
    ctx.bring = undefined
    ctx.beds.hunt = { searchLegs: { legs: 24 } }
    beds(ctx.bot, ctx)
    assert.equal(ctx.stepStatus, 'failed:no-wool')
  }

  it('acceptance: second no-sheep of the day makes beds infeasible until tomorrow', () => {
    const bot = bedsBot()
    const ctx = { bot, home: v2home({ x: 10, y: 64, z: 20 }), beds: { phase: 'wool' } }
    const F = goal.MENU.beds.feasible
    assert.equal(F(FACTS, bot, ctx), true, 'unlatched up front')
    failedEpisode(ctx)
    assert.equal(ctx.beds.noWool.fails, 1)
    assert.equal(F(FACTS, bot, ctx), true, 'first failure still retries (stepFail holds the day)')
    failedEpisode(ctx)
    assert.equal(ctx.beds.noWool.fails, 2)
    assert.equal(F(FACTS, bot, ctx), false, 'second failure latches')
    assert.equal(goal.stepWhy('beds', FACTS, bot, ctx, ''), 'beds: sheep hunt latched')
    bot.time.day = 6 // 9qt0: a new MC day no longer releases
    assert.equal(F(FACTS, bot, ctx), false, 'next MC day stays latched')
    ctx.beds.noWool.at -= beds.LATCH_MS
    assert.equal(F(FACTS, bot, ctx), true, 'expired latch retries')
  })

  it('short reopened hunts do not count, latch input never throws', () => {
    const bot = bedsBot()
    const ctx = { bot, home: v2home({ x: 10, y: 64, z: 20 }), beds: { phase: 'wool', hunt: { searchLegs: { legs: 3 } } } }
    beds(bot, ctx)
    assert.ok(ctx.bring && ctx.bring.self === 'beds', 'short hunt reopens')
    assert.equal(ctx.beds.noWool, undefined, 'no failure counted')
    assert.equal(beds.sheepLatched(undefined, undefined), false)
    assert.equal(beds.sheepLatched({}, {}), false)
    assert.equal(beds.sheepLatched({ beds: { noWool: 'x' } }, bot), false)
    assert.equal(beds.NOWOOL_LATCH, 2)
  })
})

describe('9kd wide marks survive restart', () => {
  let dir = null
  let file = null
  let prevEnv = null

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), '9kd-'))
    file = path.join(dir, 'bot.json')
    prevEnv = process.env.BOT_MEMORY_FILE
    process.env.BOT_MEMORY_FILE = file
  })

  afterEach(() => {
    if (prevEnv === undefined) delete process.env.BOT_MEMORY_FILE
    else process.env.BOT_MEMORY_FILE = prevEnv
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch (_) { /* tmp best-effort */ }
  })

  it('save/restore round-trips the disc width', () => {
    const now = Date.now()
    const ctx1 = {}
    danger.mark(ctx1, { ...MONUMENT }, now, danger.WATER_RADIUS)
    const botAt = { username: 'IdkBot', spawnPoint: { x: 0, y: 64, z: 0 } }
    assert.equal(memory.save(botAt, ctx1, file, now), true)
    const ctx2 = {}
    assert.ok(memory.restore(botAt, ctx2, file, now))
    assert.equal(danger.covers(ctx2, { x: MONUMENT.x + 20, z: MONUMENT.z }, now), true)
    assert.equal(danger.covers(ctx2, { x: MONUMENT.x + 33, z: MONUMENT.z }, now), false)
  })
})
