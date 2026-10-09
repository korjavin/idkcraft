'use strict'

// Bead idkcraft-vmzq.58: 4 of 15 night deaths inside the shelter step with
// a hostile at melee range. An armed hold that never enclosed (no pillar
// under the feet, no closed pit) idled next to a zombie; a wet pre-pillar
// phase could stand still with no deadline; nothing logged the phase.

const { describe, it, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const { Vec3 } = require('vec3')
const home = require('../src/behaviours/home')
const { createTicker, BEHAVIOURS } = require('../src/index')

function pos(x, y, z) {
  const p = { x, y, z, distanceTo: (q) => Math.hypot(x - q.x, y - q.y, z - q.z) }
  p.clone = () => pos(p.x, p.y, p.z)
  p.floored = () => pos(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z))
  p.offset = (a, b, c) => pos(p.x + a, p.y + b, p.z + c)
  return p
}

// Flat grass world: ground y<=63, air above.
function flatBot(at, entities = {}) {
  const placed = new Set()
  const items = [{ name: 'cobblestone', count: 64 }]
  const bot = {
    username: 'IdkBot',
    players: { Steve: { username: 'Steve' } }, // rostered but unseen: no target
    entities,
    health: 20,
    food: 20,
    time: { timeOfDay: 15000, day: 5 },
    entity: { position: pos(at.x, at.y, at.z), onGround: true },
    spawnPoint: pos(0, 64, 0),
    inventory: { items: () => items.filter((i) => i.count > 0) },
    heldItem: null,
    controls: {},
    pathfinder: { goal: null, setGoal(g) { this.goal = g }, isMoving: () => false, stop: () => {} },
    setControlState(c, v) { this.controls[c] = !!v },
    clearControlStates() { this.controls = {} },
    findBlocks: () => [],
    chat: () => {},
    attack: () => {},
    lookAt: () => {},
    blockAt(p) {
      const x = Math.floor(p.x); const y = Math.floor(p.y); const z = Math.floor(p.z)
      const s = y <= 63 || placed.has(`${x},${y},${z}`)
      return { name: s ? 'dirt' : 'air', position: new Vec3(x, y, z), boundingBox: s ? 'block' : 'empty' }
    },
    async equip(item) { bot.heldItem = item },
    async placeBlock(ref, face) { const d = ref.position.plus(face); placed.add(`${d.x},${d.y},${d.z}`) },
  }
  return bot
}

function zombie(id, x) {
  return { id, name: 'zombie', type: 'mob', position: pos(x, 64, 0.5), height: 1.95 }
}

const flush = () => new Promise((r) => setImmediate(r))
const far = { site: { x: 200, y: 64, z: 200 }, built: true, v: 2, interior: { min: { x: 201, y: 64, z: 201 }, max: { x: 205, y: 65, z: 204 } }, door: { x: 203, y: 64, z: 200 } }

describe('vmzq.58 shelter hold: fight release at melee range', () => {
  let lines
  let origLog
  let origFight
  let fightRan
  beforeEach(() => {
    origLog = console.log
    lines = []
    console.log = (l) => { lines.push(String(l)) }
    origFight = BEHAVIOURS.fight
    fightRan = 0
    BEHAVIOURS.fight = () => { fightRan++ }
  })
  afterEach(() => { console.log = origLog; BEHAVIOURS.fight = origFight })

  async function heldTicker(shelterSt) {
    const bot = flatBot({ x: 0.5, y: 64, z: 0.5 }, { 1: zombie(1, 2.0) }) // 1.5 from the body
    // The stub's rule: fight a hostile fact, idle without one.
    const brain = { async decide(s) { return typeof s.hostile_distance === 'number' ? FIGHT : IDLE } }
    const ticker = createTicker({ bot, brain, tickMs: 10, idleTickMs: 10 })
    ticker.work()
    const ctx = bot._tickerCtx
    ctx.home = far
    ctx.adoptDone = true
    ctx.step = 'shelter'
    ctx.stepStatus = 'running'
    ctx.inShelter = true
    ctx.shelter = { pillarAt: { x: 0.5, z: 0.5 }, ...shelterSt }
    ctx.goalText = 'seeded hold'
    return { bot, ctx, ticker }
  }

  const FIGHT = { action: 'fight', sprint: false, source: 'stub' }
  const IDLE = { action: 'idle', sprint: false, source: 'stub' }

  it('ground hold (failed pillar, failed dig-in) + zombie at 1.5: fights within 3 ticks, then shelter resumes', async () => {
    const { bot, ctx, ticker } = await heldTicker({ pillared: true, perched: false, dugIn: false })
    try {
      const r0 = await ticker.tick()
      await flush()
      assert.equal(r0.decision.action, 'fight', 'released to fight on the first tick')
      assert.equal(fightRan, 1, 'fight dispatched')
      assert.equal(ctx.inShelter, false)
      assert.ok(lines.some((l) => l.startsWith('shelter release: hostile at 1.5')), lines.join(' | '))
      await ticker.tick()
      await flush()
      assert.equal(fightRan, 2, 'keeps fighting while the zombie stands')
      delete bot.entities[1] // killed
      const r2 = await ticker.tick()
      await flush()
      assert.equal(r2.decision.action, 'shelter', 'shelter resumes once the hostile is gone')
      assert.equal(fightRan, 2)
    } finally { ticker.destroy() }
  })

  for (const [name, st] of [
    ['dug-in pit', { pillared: true, dugIn: true }],
    ['perched pillar', { pillared: true, perched: true, descendTried: true }],
  ]) {
    it(`${name} + zombie at 1.5 outside: keeps the no-fight hold (master path)`, async () => {
      const { ctx, ticker } = await heldTicker(st)
      try {
        for (let t = 0; t < 3; t++) {
          const r = await ticker.tick()
          await flush()
          assert.equal(r.decision.action, 'idle', `tick ${t} holds`)
        }
        assert.equal(fightRan, 0)
        assert.equal(ctx.inShelter, true)
        assert.ok(!lines.some((l) => l.startsWith('shelter release')))
      } finally { ticker.destroy() }
    })
  }

  it('ground hold + zombie at 5 (no fresh hit): keeps the hold', async () => {
    const { bot, ctx, ticker } = await heldTicker({ pillared: true })
    bot.entities[1] = zombie(1, 5.5)
    try {
      const r = await ticker.tick()
      await flush()
      assert.equal(r.decision.action, 'idle')
      assert.equal(fightRan, 0)
      assert.equal(ctx.inShelter, true)
    } finally { ticker.destroy() }
  })

  it('shelterOpen: committed dig keeps the hold, walk and ground hold are open', () => {
    const c = (shelter) => ({ step: 'shelter', shelter })
    assert.equal(home.shelterOpen(c({ pillared: true })), true)
    assert.equal(home.shelterOpen(c({ dig: { digs: 0, walk: { x: 1, y: 64, z: 1 } } })), true)
    assert.equal(home.shelterOpen(c({ dig: { digs: 2 } })), false)
    assert.equal(home.shelterOpen(c({ dig: { digs: 0 }, descended: true })), false)
    assert.equal(home.shelterOpen(c({ dugIn: true })), false)
    assert.equal(home.shelterOpen(c({ perched: true })), false)
    assert.equal(home.shelterOpen({ step: 'stay', shelter: { pillared: true } }), false, 'house stay is never released')
  })
})

describe('vmzq.58 shelter phases: log line + wet pre-pillar deadline', () => {
  let lines
  let origLog
  beforeEach(() => { origLog = console.log; lines = []; console.log = (l) => { lines.push(String(l)) } })
  afterEach(() => { console.log = origLog })

  const state = { hostile_distance: 1.5 }

  it('logs one phase line per change: pillar while climbing, then the hold', async () => {
    const bot = flatBot({ x: 0.5, y: 64, z: 0.5 })
    const ctx = { home: far, step: 'shelter', stepStatus: 'running' }
    home.shelter(bot, ctx, null, state)
    home.shelter(bot, ctx, null, state)
    const phases = lines.filter((l) => l.startsWith('shelter phase='))
    assert.deepEqual(phases, ['shelter phase=pillar pos=0 64 0 hostile=1.5'], 'logged once per phase')
    ctx.shelter = { pillared: true, dugIn: true, pillarAt: { x: 0.5, z: 0.5 } }
    home.shelter(bot, ctx, null, state)
    assert.ok(lines.includes('shelter phase=dug-in pos=0 64 0 hostile=1.5'), lines.join(' | '))
  })

  it('wet + grounded past the deadline pillars where it stands; before it, swims', () => {
    const bot = flatBot({ x: 0.5, y: 64, z: 0.5 })
    bot.entity.isInWater = true
    const ctx = { home: far, step: 'shelter', stepStatus: 'running' }
    home.shelter(bot, ctx, null, state)
    assert.equal(ctx.shelter.phaseLogged, 'swim', 'fresh wet phase swims')
    assert.equal(ctx.recovery, undefined)
    ctx.shelter.wetSince = Date.now() - home.SHELTER_PREPILLAR_MS - 1
    home.shelter(bot, ctx, null, state)
    assert.equal(ctx.shelter.phaseLogged, 'pillar', 'deadline: pillar here')
    assert.ok(ctx.recovery && ctx.recovery.action === 'pillar_up')
    assert.ok(lines.includes('shelter pre-pillar deadline, pillaring where it stands'))
  })

  it('wet and floating past the deadline keeps swimming (a pillar never stands in water)', () => {
    const bot = flatBot({ x: 0.5, y: 64, z: 0.5 })
    bot.entity.isInWater = true
    bot.entity.onGround = false
    const ctx = { home: far, step: 'shelter', stepStatus: 'running', shelter: { wetSince: Date.now() - 60000 } }
    home.shelter(bot, ctx, null, state)
    assert.equal(ctx.shelter.phaseLogged, 'swim')
  })
})
