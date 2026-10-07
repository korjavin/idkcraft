'use strict'

// Bead idkcraft-vmzq.29 (prod run6): a far respawn read castle 0/1722 (the
// castle step counted an unloaded site), and the far castle step with stone
// in hand aimed a y-aware GoalPlaceBlock into unloaded chunks 500 blocks off.

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const { goals } = require('mineflayer-pathfinder')
const castle = require('../src/behaviours/castle')
const blueprint = require('../src/castle')

const SITE = { x: 100, y: 64, z: 200 }

function pos(x, y, z) {
  const p = {
    x, y, z,
    distanceTo: (q) => Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z),
    clone() { return pos(p.x, p.y, p.z) },
    floored() { return pos(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)) },
    offset(dx, dy, dz) { return pos(p.x + dx, p.y + dy, p.z + dz) },
  }
  return p
}

// Flat world; the site footprint (plus a margin) reads null while unloaded.
function farBot({ items, at, loaded = () => false }) {
  const setGoals = []
  const bot = {
    chats: [],
    entity: { position: at },
    inventory: { items: () => items },
    time: { timeOfDay: 6000, day: 1 },
    health: 20,
    food: 20,
    world: { getBlock: () => null },
    blockAt: (p) => {
      const fx = Math.floor(p.x)
      const fy = Math.floor(p.y)
      const fz = Math.floor(p.z)
      if (!loaded() && fx >= SITE.x - 2 && fx <= SITE.x + 40 && fz >= SITE.z - 2 && fz <= SITE.z + 40) return null
      const name = fy <= 63 ? 'dirt' : 'air'
      return { name, position: pos(fx, fy, fz), boundingBox: name === 'air' ? 'empty' : 'block' }
    },
    findBlocks: () => [],
    registry: { blocksByName: {}, itemsByName: {} },
    pathfinder: {
      goal: null,
      movements: { exclusionAreasBreak: [], exclusionAreasPlace: [] },
      isMoving: () => false,
      setGoal: (g) => { setGoals.push(g); bot.pathfinder.goal = g },
    },
    chat(m) { this.chats.push(String(m)) },
  }
  return { bot, setGoals }
}

function castleState(extra) {
  return { site: { ...SITE }, rot: 0, blueprintVersion: 1, phase: 'body', blocked: {}, parked: false, ...extra }
}

describe('vmzq.29 far castle step', () => {
  it('A: an unloaded site never overwrites the progress read on site', () => {
    const { bot } = farBot({ items: [{ name: 'cobblestone', count: 40, type: 14 }], at: pos(-400, 64, -300) })
    const ctx = { castle: castleState({ progress: { done: 328, total: 1722 } }), step: 'castle', work: true }
    castle(bot, ctx)
    assert.deepEqual(ctx.castle.progress, { done: 328, total: 1722 }, 'far respawn keeps 328, never reads 0')
  })

  it('C: stone in hand, site >32 off: XZ walk; in range the cell re-arms its own goal', () => {
    let near = false
    const { bot, setGoals } = farBot({ items: [{ name: 'cobblestone', count: 40, type: 14 }], at: pos(-400, 64, -300), loaded: () => near })
    const ctx = { castle: castleState(), step: 'castle', work: true }
    castle(bot, ctx)
    assert.equal(setGoals.length, 1)
    assert.ok(setGoals[0] instanceof goals.GoalNearXZ, `far goal is ${setGoals[0] && setGoals[0].constructor.name}`)
    assert.equal(ctx.castle.status, 'walking to the site')
    castle(bot, ctx)
    assert.equal(setGoals.length, 1, 'the far walk latches (no re-issue per tick)')
    near = true
    bot.entity.position = pos(SITE.x + 2, 64, SITE.z - 4)
    castle(bot, ctx)
    assert.equal(setGoals.length, 2, 'the cell re-arms')
    const last = setGoals[setGoals.length - 1]
    assert.ok(!(last instanceof goals.GoalNearXZ), 'in range the cell goal replaces the XZ walk')
  })

  it('C (revmux 01): on the footprint a cross-corner cell (>32 off) never takes the XZ walk', () => {
    const { bot, setGoals } = farBot({ items: [{ name: 'cobblestone', count: 40, type: 14 }, { name: 'oak_fence', count: 40, type: 15 }], at: pos(SITE.x + 30, 64, SITE.z + 26), loaded: () => true })
    const ctx = { castle: castleState({ blueprintVersion: 2 }), step: 'castle', work: true }
    // Everything but the far corner cell (100,200) waits out a backoff.
    const { cells } = blueprint.absPlan(SITE, 0, 2)
    const target = cells.find((c) => c.x === SITE.x && c.z === SITE.z && blueprint.isPlaceTarget(c.kind))
    for (const c of cells) if (c !== target) ctx.castle.blocked[`2:${c.idx}`] = { until: Date.now() + 600000, tries: 1, why: 'test' }
    castle(bot, ctx)
    assert.equal(ctx.castleGoalIdx, target.idx, 'the cross-corner cell is worked (no far: latch)')
    assert.ok(setGoals.length >= 1, 'a goal is issued')
    assert.ok(!setGoals.some((g) => g instanceof goals.GoalNearXZ), 'on site: no XZ walk')
  })
})
