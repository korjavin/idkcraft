'use strict'

// Bead idkcraft-neuc.65.6: prod v2 fell ten times in one morning at one
// doorstep cell (-85 82 -4, 6 below its house floor) — no hostile, no water,
// and nothing remembered the cell. A dry hostile-free death now marks a small
// fall disc that the path cost (v1 A*, v2 AvoidGoal via dangerDiscs) reads.

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const danger = require('../src/danger')
const memory = require('../src/memory')
const { handleDeath } = require('../src/index')

const CELL = { x: -84.5, y: 82, z: -3.5 }

function deathBot(at, ctx = {}) {
  const p = { ...at, distanceTo: (q) => Math.hypot(at.x - q.x, at.y - q.y, at.z - q.z) }
  const bot = {
    username: 'IdkBotV2', players: {}, entities: {}, health: 0,
    time: { timeOfDay: 6000, day: 5 }, spawnPoint: { x: 0, y: 70, z: 16 },
    entity: { position: p }, blockAt: () => ({ name: 'stone' }), chat: () => {},
  }
  bot._tickerCtx = ctx
  return { bot, ctx }
}

function quiet(fn) {
  const lines = []
  const orig = console.log
  console.log = (m) => lines.push(String(m))
  try { fn() } finally { console.log = orig }
  return lines
}

describe('neuc.65.6 fall death marks a small danger disc', () => {
  it('a hostile-free death marks a fall disc of FALL_RADIUS; a hostile death does not', () => {
    const { bot, ctx } = deathBot(CELL)
    assert.equal(danger.markFallDeath(bot, ctx, 0), true)
    assert.equal(danger.count(ctx), 1)
    assert.equal(ctx.danger.spots[0].fall, true)
    assert.equal(danger.covers(ctx, { x: CELL.x + 3, z: CELL.z }), true)
    assert.equal(danger.covers(ctx, { x: CELL.x + 4, z: CELL.z }), false)
    const hit = deathBot(CELL)
    assert.equal(danger.markFallDeath(hit.bot, hit.ctx, 2), false)
    assert.equal(danger.count(hit.ctx), 0)
  })

  it('handleDeath: dry + no hostile marks; the last tick\'s hostile snapshot does not', () => {
    const fall = deathBot(CELL)
    const lines = quiet(() => handleDeath(fall.bot, null))
    assert.equal(danger.count(fall.ctx), 1)
    assert.ok(lines.includes('danger: fall death marked'))
    const mob = deathBot(CELL, { lastHostileSnap: { count: 1, name: 'zombie', dist: 2 } })
    quiet(() => handleDeath(mob.bot, null))
    assert.equal(danger.count(mob.ctx), 0)
  })

  it('the fall disc reaches the path cost (v2 dangerDiscs); a plain pit mark does not', () => {
    const ctx = {}
    danger.markFallDeath(deathBot(CELL).bot, ctx, 0)
    danger.mark(ctx, { x: 40, y: 64, z: 40 }) // recover/deep pit mark: detour's, not A*'s
    const m = { getNeighbors: () => [{ x: -85, y: 82, z: -4, cost: 1 }, { x: -80, y: 82, z: -4, cost: 1 }] }
    danger.addPathCost(m, ctx, { entity: { position: { x: -60, y: 70, z: 0 } }, pathfinder: { goal: null } })
    assert.deepEqual(m.dangerDiscs({ x: -60, z: 0 }, null), [{ x: CELL.x, z: CELL.z, lim: danger.FALL_RADIUS }])
    const ns = m.getNeighbors({})
    assert.equal(ns[0].cost, 1 + danger.PATH_COST, 'landing in the drop cell costs')
    assert.equal(ns[1].cost, 1, 'outside the disc is free')
    // revmux 01: the gohome goal is the house entrance's outside cell, prod's
    // drop itself (house -88 88 -3 -> outside -85 88 -4): the disc stays whole.
    const home = { site: { x: -88, y: 88, z: -3 }, built: true, v: 2 }
    const out = require('../src/residence').of(home).entrance(home).outside
    assert.deepEqual([out.x, out.z], [-85, -4])
    assert.equal(m.dangerDiscs({ x: -60, z: 0 }, { x: out.x + 0.5, z: out.z + 0.5 })[0].lim, danger.FALL_RADIUS)
    // Feet inside the disc still shrink it (the walk out stays cheap).
    assert.equal(m.dangerDiscs({ x: CELL.x + 1.5, z: CELL.z }, null)[0].lim, 1)
  })

  it('revmux 01 minor: a later plain mark on the drop keeps the fall flag', () => {
    const ctx = {}
    danger.markFallDeath(deathBot(CELL).bot, ctx, 0)
    danger.mark(ctx, CELL)
    assert.equal(danger.count(ctx), 1)
    assert.equal(ctx.danger.spots[0].fall, true)
  })

  it('the fall flag survives a restart', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fall-'))
    try {
      const file = path.join(dir, 'm.json')
      const now = Date.now()
      const ctx = {}
      danger.markFallDeath(deathBot(CELL).bot, ctx, 0, now)
      assert.equal(memory.save({ username: 'MemBot', spawnPoint: { x: 0, y: 64, z: 0 } }, ctx, file, now), true)
      const ctx2 = {}
      memory.restore({ username: 'MemBot', spawnPoint: { x: 0, y: 64, z: 0 } }, ctx2, file, now)
      assert.deepEqual(ctx2.danger.spots.map((s) => [s.r, s.fall]), [[danger.FALL_RADIUS, true]])
    } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  })
})
