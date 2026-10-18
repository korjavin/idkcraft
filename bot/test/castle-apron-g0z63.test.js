'use strict'

// idkcraft-g0z.63: every bot knows every complete castle on the shared
// memory volume (readdir, read-only) and the v1 place guards — A*
// scaffolding, the recover pillar, the dig-in cap, the shelter's band
// walk-off — fire in a 16-block apron around ALL of them. Prod: V2 respawned
// at the world spawn 16 west of IdkBot's box and pillared/dug in there;
// castleless swarm helpers pillared beside V2's castle.

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { Vec3 } = require('vec3')
const memory = require('../src/memory')
const blueprint = require('../src/castle')
const castle = require('../src/behaviours/castle')
const recover = require('../src/behaviours/recover')
const home = require('../src/behaviours/home')

const SITE = { x: 8, y: 65, z: -12 } // IdkBot's prod castle corner
const complete = (site = SITE, extra) => ({ site: { ...site }, rot: 0, blueprintVersion: 3, phase: 'complete', blocked: {}, ...extra })
const key = (x, y, z) => `${Math.floor(x)},${Math.floor(y)},${Math.floor(z)}`

function pos(x, y, z) {
  const p = { x, y, z, distanceTo: (q) => Math.hypot(x - q.x, y - q.y, z - q.z) }
  p.clone = () => pos(p.x, p.y, p.z)
  p.floored = () => pos(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z))
  return p
}

// Same fake-bot surface as castle-g0z44.test.js worldBot (mineflayer
// bot.blockAt/placeBlock/equip, mineflayer lib/plugins/place_block.js).
function worldBot(cells, opts = {}) {
  const bot = {
    username: opts.username || 'IdkSwarm5',
    spawnPoint: pos(-8, 65, 7),
    time: { timeOfDay: 15000, day: 5 },
    health: 20,
    food: 20,
    entities: {},
    entity: { position: pos(0.5, 62, 0.5), onGround: true },
    inventory: { items: () => opts.items || [] },
    heldItem: null,
    players: {},
    pathfinder: { goal: null, setGoal(g) { this.goal = g }, isMoving: () => false, stop() {} },
    setControlState(c, v) { (this.controls = this.controls || {})[c] = !!v },
    getControlState(c) { return !!(this.controls && this.controls[c]) },
    clearControlStates() { this.controls = {} },
    chat() {},
    findBlocks: () => [],
    blockAt(p) {
      const x = Math.floor(p.x); const y = Math.floor(p.y); const z = Math.floor(p.z)
      const k = key(x, y, z)
      const name = cells.has(k) ? cells.get(k) : (opts.ground ? opts.ground(x, y, z) : 'air')
      return { name, position: new Vec3(x, y, z), boundingBox: name === 'air' ? 'empty' : 'block' }
    },
    async equip(item) { bot.heldItem = item },
    async placeBlock() { bot._places = (bot._places || 0) + 1 },
  }
  return bot
}

let clock = 1e12
const tick = () => (clock += memory.SAVE_MIN_MS)

describe('g0z.63 known castles: readdir of the shared memory dir, read only', () => {
  it('own + same-world complete peer kept (own first); other world, unfinished, half-written and tmp files read nothing', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'g0z63-'))
    const b = worldBot(new Map(), { username: 'IdkBotV2' })
    const world = memory.worldKey(b)
    const own = complete({ x: -218, y: 117, z: 28 })
    const write = (n, doc) => fs.writeFileSync(path.join(dir, n), typeof doc === 'string' ? doc : JSON.stringify(doc))
    write('IdkBotV2.json', { v: 1, world, castle: own })
    write('IdkBot.json', { v: 1, world, castle: complete() })
    write('Other.json', { v: 1, world: 'spawn:1,2,3', castle: complete({ x: 50, y: 70, z: 50 }) })
    write('IdkSwarm1.json', { v: 1, world, castle: complete({ x: 90, y: 70, z: 90 }, { phase: 'body' }) })
    write('IdkSwarm2.json', '{"v":1,"wor') // half-written
    write('IdkBot.json.tmp-7', JSON.stringify({ v: 1, world, castle: complete({ x: 300, y: 70, z: 300 }) }))
    const raw = fs.readFileSync(path.join(dir, 'IdkBot.json'), 'utf8')
    const ctx = { castle: own }
    memory.refreshKnownCastles(b, ctx, tick(), { BOT_MEMORY_FILE: path.join(dir, 'IdkBotV2.json'), BOT_CASTLE_PEER: '' })
    assert.equal(ctx.knownCastles.length, 2, JSON.stringify(ctx.knownCastles))
    assert.equal(ctx.knownCastles[0], own, 'own first')
    assert.deepEqual(ctx.knownCastles[1].site, SITE)
    assert.equal(ctx.peerCastle, null, 'no BOT_CASTLE_PEER: no residence peer')
    assert.equal(fs.readFileSync(path.join(dir, 'IdkBot.json'), 'utf8'), raw, 'peer file untouched')
    // BOT_CASTLE_PEER still names the residence peer (g0z.59 unchanged).
    memory.refreshKnownCastles(b, ctx, tick(), { BOT_MEMORY_FILE: path.join(dir, 'IdkBotV2.json'), BOT_CASTLE_PEER: 'IdkBot' })
    assert.equal(ctx.peerCastle, ctx.knownCastles[1])
  })
})

describe('g0z.63 apron: box grown by 16, site.y-4..site.y+16', () => {
  const { w, d } = blueprint.siteDimensions(0, 3)
  it('edges', () => {
    const c = complete()
    assert.equal(blueprint.apronOf(c, { x: SITE.x - 16, y: 65, z: SITE.z }), true)
    assert.equal(blueprint.apronOf(c, { x: SITE.x - 17, y: 65, z: SITE.z }), false)
    assert.equal(blueprint.apronOf(c, { x: SITE.x + w - 1 + 16, y: 65, z: SITE.z + d - 1 + 16 }), true)
    assert.equal(blueprint.apronOf(c, { x: SITE.x + w + 16, y: 65, z: SITE.z }), false)
    assert.equal(blueprint.apronOf(c, { x: SITE.x - 5, y: SITE.y - 4, z: SITE.z }), true)
    assert.equal(blueprint.apronOf(c, { x: SITE.x - 5, y: SITE.y - 5, z: SITE.z }), false, 'deep pit below the floor')
    assert.equal(blueprint.apronOf(c, { x: SITE.x - 5, y: SITE.y + 17, z: SITE.z }), false)
    assert.equal(blueprint.apronOf(c, { x: SITE.x - 16, z: SITE.z }), true, 'XZ-only query')
  })
  it('inCastleApron: complete castles only; own castle step keeps the yard ring only', () => {
    const p = { x: SITE.x - 10, y: 65, z: SITE.z }
    assert.ok(blueprint.inCastleApron({ castle: null, knownCastles: [complete()] }, p))
    assert.ok(blueprint.inCastleApron({ castle: complete(), step: 'gather' }, p))
    assert.equal(blueprint.inCastleApron({ castle: complete(), step: 'castle' }, p), null)
    assert.equal(blueprint.inCastleApron({ castle: complete(SITE, { phase: 'body' }) }, p), null)
    // A peer stays guarded through the own castle step.
    assert.ok(blueprint.inCastleApron({ castle: complete({ x: 500, y: 65, z: 500 }), knownCastles: [complete()], step: 'castle' }, p))
  })
})

describe('g0z.63 guardCastle: a castleless bot installs; placeFn vetoes the peer apron', () => {
  it('100 at dx -16 of a peer castle, 0 at dx -17', () => {
    const bot = worldBot(new Map())
    bot.pathfinder.movements = { exclusionAreasBreak: [], exclusionAreasPlace: [] }
    const ctx = { castle: null, knownCastles: [complete()] }
    castle.guardCastle(bot, ctx)
    const place = bot.pathfinder.movements.exclusionAreasPlace[0]
    assert.equal(typeof place, 'function', 'installed without ctx.castle')
    assert.equal(place({ position: { x: SITE.x - 16, y: 65, z: SITE.z } }), 100)
    assert.equal(place({ position: { x: SITE.x - 17, y: 65, z: SITE.z } }), 0)
    const brk = bot.pathfinder.movements.exclusionAreasBreak[0]
    assert.equal(brk({ name: 'dirt', position: { x: SITE.x - 10, y: 65, z: SITE.z } }), 0, 'the dig ban does not widen')
  })
  it('no castle known: nothing installed', () => {
    const bot = worldBot(new Map())
    bot.pathfinder.movements = { exclusionAreasBreak: [], exclusionAreasPlace: [] }
    castle.guardCastle(bot, { castle: null, knownCastles: [] })
    assert.equal(bot.pathfinder.movements.exclusionAreasPlace.length, 0)
  })
})

describe('g0z.63 recover: pillar and cap refused in a peer apron', () => {
  // Feet (0,61,0), solid below (castle-g0z44 pillarBot). Peer site x=16 puts
  // the feet at dx -16 (in), x=17 at dx -17 (out).
  function pillarBot() {
    const cells = new Map()
    for (let x = -2; x <= 2; x++) for (let z = -2; z <= 2; z++) cells.set(key(x, 60, z), 'dirt')
    return worldBot(cells, { items: [{ name: 'dirt', count: 10 }] })
  }
  const pillarCtx = (siteX) => ({
    stuck: { by: 'test', goal: { x: 0, y: 64, z: 0 } },
    castle: null,
    knownCastles: [complete({ x: siteX, y: 61, z: 0 })],
    recovery: {
      action: 'pillar_up', source: 'stub', model: null, status: 'running',
      st: { phase: 'place', startFloor: 61, waited: 0, placeInFlight: false, placed: false, placeError: false },
    },
  })
  it('place-protected at dx -16, no placeBlock call; dx -17 places', () => {
    const bot = pillarBot()
    const ctx = pillarCtx(16)
    recover.run(bot, ctx)
    assert.equal(ctx.recovery.status, 'failed:place-protected')
    assert.equal(bot._places || 0, 0)
    const out = pillarBot()
    const octx = pillarCtx(17)
    recover.run(out, octx)
    assert.equal(octx.recovery.status, 'running')
  })
  it('a dig-in cap above the peer site level is refused, a flush one is not', () => {
    const cells = new Map([[key(-1, 64, 0), 'dirt']])
    const bot = worldBot(cells, { items: [{ name: 'dirt', count: 3 }] })
    bot.entity.position = pos(0.5, 63, 0.5) // cap at 65
    const ctx = { castle: null, knownCastles: [complete({ x: 10, y: 64, z: 0 })] }
    assert.equal(recover.digInRun(bot, ctx, { capping: true }), 'failed:place-protected')
    assert.equal(bot._places || 0, 0)
    bot.entity.position = pos(0.5, 62, 0.5) // cap at 64: flush
    assert.equal(recover.digInRun(bot, ctx, { capping: true }), 'running')
  })
})

describe('g0z.63 shelter: 16 from a peer castle walks out of its apron first', () => {
  it('logs leaving the castle band, the dig-in spot is outside the apron', () => {
    const b = worldBot(new Map(), { ground: (x, y) => (y <= 64 ? 'dirt' : 'air') })
    b.entity.position = pos(SITE.x - 16 + 0.5, 65, SITE.z + 3.5)
    const ctx = { step: 'shelter', stepStatus: 'running', castle: null, knownCastles: [complete()] }
    const logs = []
    const orig = console.log
    console.log = (m) => { logs.push(String(m)) }
    try { home.shelter(b, ctx, null, null) } finally { console.log = orig }
    assert.ok(logs.some((m) => m.includes('shelter leaving the castle band')), JSON.stringify(logs))
    const walk = ctx.shelter && ctx.shelter.dig && ctx.shelter.dig.walk
    assert.ok(walk, JSON.stringify(logs))
    assert.equal(blueprint.apronOf(ctx.knownCastles[0], walk), false, JSON.stringify(walk))
    assert.ok(Math.hypot(walk.x - (SITE.x - 16), walk.z - (SITE.z + 3)) <= 3, 'the nearest such spot')
  })
})
