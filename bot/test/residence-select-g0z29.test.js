'use strict'

// idkcraft-g0z.29: persisted residence selection — a complete v2 castle
// becomes ctx.home (kind 'castle'), survives restarts, falls back to the
// last hut on forget, never flaps, and switches only on a free tick with
// the home-keyed caches reset. Behind residence.RESIDENCE_CASTLE (off in
// prod until g0z.30).

const { describe, it, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const memory = require('../src/memory')
const residence = require('../src/residence')
const index = require('../src/index')

const SPAWN = { x: 0, y: 64, z: 0 }
const CASTLE_SITE = { x: 100, y: 64, z: 200 }

function botAt() {
  return { username: 'ResBot', spawnPoint: { ...SPAWN }, chat: () => {} }
}
function hutAt(x, y, z) {
  return { site: { x, y, z }, interior: null, door: { x: x + 1, y, z }, table: null, built: true, v: 1 }
}
function castleSt(over) {
  return { site: { ...CASTLE_SITE }, rot: 1, blueprintVersion: 2, phase: 'complete', blocked: {}, parked: false, ...over }
}
function writeDoc(file, homes, castle) {
  fs.writeFileSync(file, JSON.stringify({ v: 1, world: memory.worldKey(botAt()), savedAt: Date.now(), homes, resources: [], visited: [], danger: [], castle }))
}

let dir = null
let file = null
let prevEnv = null
let prevFlag = null
let logs = null
let origLog = null

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'g0z29-'))
  file = path.join(dir, 'bot.json')
  prevEnv = process.env.BOT_MEMORY_FILE
  process.env.BOT_MEMORY_FILE = file
  prevFlag = residence.RESIDENCE_CASTLE
  residence.RESIDENCE_CASTLE = true
  logs = []
  origLog = console.log
  console.log = (...a) => { logs.push(a.join(' ')) }
})

afterEach(() => {
  console.log = origLog
  residence.RESIDENCE_CASTLE = prevFlag
  if (prevEnv === undefined) delete process.env.BOT_MEMORY_FILE
  else process.env.BOT_MEMORY_FILE = prevEnv
  try { fs.rmSync(dir, { recursive: true, force: true }) } catch (_) { /* tmp best-effort */ }
})

// Cold start: a ticker restored from the file, as the spawn handler does.
function coldStart() {
  const bot = botAt()
  const t = index.createTicker({ bot, brain: null })
  t.loadMemory()
  return { bot, t, ctx: bot._tickerCtx }
}

describe('g0z.29 memory schema', () => {
  it('a castle residence round-trips kind/castle/rot for 4 rotations x 2 blueprint versions; huts stay untouched', () => {
    for (const rot of [0, 1, 2, 3]) {
      for (const bv of [1, 2]) {
        const hut = hutAt(10, 64, 20)
        const castleHome = residence.castleHome(castleSt({ rot, blueprintVersion: bv }))
        writeDoc(file, [hut, JSON.parse(JSON.stringify(castleHome))])
        const ctx = {}
        assert.ok(memory.restore(botAt(), ctx, file))
        assert.equal(ctx.home.kind, 'castle')
        assert.equal(ctx.home.rot, rot)
        assert.deepEqual(ctx.home.castle, { site: CASTLE_SITE, rot, blueprintVersion: bv })
        assert.deepEqual({ x: ctx.home.site.x, y: ctx.home.site.y, z: ctx.home.site.z }, CASTLE_SITE)
        assert.equal(ctx.home.built, true)
        // save -> load again: still the same, the hut still in the history
        assert.equal(memory.save(botAt(), ctx, file), true)
        const doc = JSON.parse(fs.readFileSync(file, 'utf8'))
        assert.equal(doc.homes.length, 2)
        assert.equal(doc.homes[0].kind, undefined)
        assert.deepEqual(doc.homes[0].site, hut.site)
        assert.equal(doc.homes[0].v, 1)
        assert.deepEqual(doc.homes[1].castle, { site: CASTLE_SITE, rot, blueprintVersion: bv })
        const again = {}
        memory.restore(botAt(), again, file)
        assert.equal(again.home.kind, 'castle')
        assert.equal(again.home.rot, rot)
        assert.equal(again.hutHome.kind, undefined)
        assert.equal(again.hutHome.site.x, 10)
      }
    }
  })

  it('old documents load unchanged; a broken castle ref is dropped, never a hut at the castle corner', () => {
    writeDoc(file, [hutAt(10, 64, 20), { kind: 'castle', site: CASTLE_SITE, castle: { site: CASTLE_SITE, rot: 7, blueprintVersion: 2 }, built: true }])
    const ctx = {}
    memory.restore(botAt(), ctx, file)
    assert.equal(ctx.home, undefined) // the last record is broken: no home (adopt runs)
    assert.equal(ctx.hutHome.site.x, 10)
    writeDoc(file, [{ ...hutAt(10, 64, 20), v: 2 }])
    const old = {}
    memory.restore(botAt(), old, file)
    assert.equal(old.home.kind, undefined)
    assert.equal(old.home.v, 2)
    assert.equal(residence.of(old.home).kind, 'house')
  })
})

describe('g0z.29 selection', () => {
  it('cold restart with a complete castle + hut home selects the castle and keeps the hut in history', () => {
    writeDoc(file, [hutAt(10, 64, 20)], castleSt())
    const { t, ctx } = coldStart()
    assert.equal(ctx.home.kind, undefined)
    assert.equal(t.selectResidence(), true)
    assert.equal(ctx.home.kind, 'castle')
    assert.equal(residence.of(ctx.home).kind, 'castle')
    assert.equal(ctx.hutHome.site.x, 10)
    assert.equal(t.selectResidence(), false) // idempotent
    const doc = JSON.parse(fs.readFileSync(file, 'utf8'))
    assert.deepEqual(doc.homes.map((h) => h.kind || 'hut'), ['hut', 'castle'])
    // A second restart keeps the castle without a switch.
    const again = coldStart()
    assert.equal(again.ctx.home.kind, 'castle')
    assert.equal(again.t.selectResidence(), false)
    assert.ok(logs.some((l) => l === 'residence hut@10,64,20 -> castle@100,64,200'))
  })

  it('flag off: a complete castle changes nothing', () => {
    residence.RESIDENCE_CASTLE = false
    writeDoc(file, [hutAt(10, 64, 20)], castleSt())
    const { t, ctx } = coldStart()
    assert.equal(t.selectResidence(), false)
    assert.equal(ctx.home.kind, undefined)
  })

  it('a v1 castle and an unfinished castle are no residence', () => {
    writeDoc(file, [hutAt(10, 64, 20)], castleSt({ blueprintVersion: 1 }))
    assert.equal(coldStart().t.selectResidence(), false)
    writeDoc(file, [hutAt(10, 64, 20)], castleSt({ phase: 'moat' }))
    assert.equal(coldStart().t.selectResidence(), false)
  })

  it('castle forget restores the hut as active; with no hut, no home', () => {
    writeDoc(file, [hutAt(10, 64, 20)], castleSt())
    const { t, ctx } = coldStart()
    t.selectResidence()
    t.setCastle(null)
    assert.equal(t.selectResidence(), true)
    assert.equal(ctx.home.kind, undefined)
    assert.equal(ctx.home.site.x, 10)
    // Restart after the forget: the hut stays (no castle resurrected).
    const again = coldStart()
    assert.equal(again.ctx.home.site.x, 10)
    assert.equal(again.t.selectResidence(), false)

    writeDoc(file, [], castleSt())
    const lone = coldStart()
    lone.t.selectResidence()
    assert.equal(lone.ctx.home.kind, 'castle')
    lone.t.setCastle(null)
    assert.equal(lone.t.selectResidence(), true)
    assert.equal(lone.ctx.home, null)
  })

  it('park, unloaded chunks and a new order keep the selection', () => {
    writeDoc(file, [hutAt(10, 64, 20)], castleSt())
    const { bot, t, ctx } = coldStart()
    t.selectResidence()
    bot.blockAt = () => null // the castle chunks unloaded
    ctx.castle.parked = true
    assert.equal(t.selectResidence(), false)
    t.setCastle(castleSt({ site: { x: 500, y: 64, z: 500 }, phase: 'prep' }))
    assert.equal(t.selectResidence(), false)
    assert.equal(ctx.home.castle.site.x, 100)
    // The new castle completes: it becomes the residence.
    ctx.castle.phase = 'complete'
    assert.equal(t.selectResidence(), true)
    assert.equal(ctx.home.castle.site.x, 500)
  })

  it('the switch waits out placeInFlight and resets the home-keyed caches on the next free tick', () => {
    writeDoc(file, [hutAt(10, 64, 20)], castleSt())
    const { t, ctx } = coldStart()
    ctx.placeInFlight = true
    ctx.gohome = { phase: 'walk' }
    ctx.stay = { phase: 'in' }
    ctx.shelter = { at: 1 }
    ctx.inShelter = true
    ctx.beds = { phase: 'shears', placeHold: { at: 1 }, noWool: { fails: 1, at: 1 } }
    ctx.lightSkip = [1, 2]; ctx.lightFails = 2; ctx.lightFailIdx = 3; ctx.lightGoalIdx = 4; ctx.lightLineDone = true; ctx.lightPlaced = 5
    ctx.stockpileHomeLatch = 'none'; ctx.stockpileFar = { key: 'k', n: 3 }; ctx.chestFull = true; ctx.chestFullAt = 1; ctx.chestErrorAt = 1; ctx.chestNoSpotAt = 1
    ctx.buildSkip = [3]; ctx.buildSkipAt = { 3: 1 }; ctx.buildFails = 2; ctx.buildFailIdx = 3; ctx.buildGoalIdx = 3; ctx.buildFarIdx = 3
    ctx.stepFail = { gohome: { status: 'failed:x' }, build: { status: 'failed:y' }, gather: { status: 'failed:z' } }
    ctx.task = { house: {} }
    assert.equal(t.selectResidence(), false)
    assert.equal(ctx.home.kind, undefined)
    assert.deepEqual(ctx.gohome, { phase: 'walk' })
    ctx.placeInFlight = false
    ctx.craftInFlight = true // the goal.js window guard holds it too
    assert.equal(t.selectResidence(), false)
    ctx.craftInFlight = false
    assert.equal(t.selectResidence(), true)
    assert.equal(ctx.home.kind, 'castle')
    assert.equal(ctx.gohome, null)
    assert.equal(ctx.stay, null)
    assert.equal(ctx.shelter, null)
    assert.equal(ctx.inShelter, false)
    assert.deepEqual(ctx.beds, { noWool: { fails: 1, at: 1 } })
    assert.deepEqual(ctx.lightSkip, [])
    assert.equal(ctx.lightFails, 0)
    assert.equal(ctx.lightFailIdx, -1)
    assert.equal(ctx.lightGoalIdx, -1)
    assert.equal(ctx.lightLineDone, false)
    assert.equal(ctx.lightPlaced, 0)
    assert.equal(ctx.stockpileHomeLatch, null)
    assert.equal(ctx.stockpileFar, null)
    assert.equal(ctx.chestFull, false)
    assert.equal(ctx.chestFullAt, null)
    assert.equal(ctx.chestErrorAt, null)
    assert.equal(ctx.chestNoSpotAt, null)
    assert.deepEqual(ctx.buildSkip, [])
    assert.deepEqual(ctx.buildSkipAt, {})
    assert.equal(ctx.buildFails, 0)
    assert.equal(ctx.buildFailIdx, -1)
    assert.equal(ctx.buildGoalIdx, -1)
    assert.equal(ctx.buildFarIdx, -1)
    assert.deepEqual(Object.keys(ctx.stepFail), ['gather'])
    assert.equal(ctx.task, null)
  })
})
