'use strict'

// Bead idkcraft-vmzq.18: side-work searches wander unbounded — a wool bring
// walked the bot ~500 blocks castle->home (prod run2). While a build task
// is active the spiral anchors at the task site and caps at TASK radius.

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const explore = require('../src/behaviours/explore')
const bring = require('../src/behaviours/bring')

const HOME = { x: 2, y: 64, z: -169 } // prod run2 house area
const CASTLE = { x: 276, y: 64, z: 180 } // prod run2 castle site (~440 from home)

function pos(x, y, z) {
  return {
    x, y, z,
    distanceTo: (q) => Math.hypot(x - q.x, y - q.y, z - q.z),
    clone() { return pos(x, y, z) },
  }
}

function mockBot(at) {
  const calls = { goals: [] }
  return {
    calls,
    chats: [],
    spawnPoint: pos(HOME.x, HOME.y, HOME.z),
    entity: { position: pos(at.x, at.y, at.z) },
    pathfinder: { goal: null, setGoal: (g) => { calls.goals.push(g) }, isMoving: () => false },
    blockAt: () => ({ name: 'stone' }),
    findBlocks: () => [],
    chat: (m) => {},
  }
}

function activeCastleCtx() {
  return {
    home: { site: { ...HOME }, built: true, v: 2 },
    castle: { site: { ...CASTLE }, rot: 0, phase: 'body', blocked: {}, parked: false },
    explore: { visited: new Set(), target: null, lastPos: null, stalls: 0, issuedKey: null, markStart: 0, chatAt: 0 },
  }
}

describe('vmzq.18 task-bound searches', () => {
  it('anchors the spiral at the active castle, not home', () => {
    const bot = mockBot({ x: CASTLE.x, y: 64, z: CASTLE.z - 3 })
    const ctx = activeCastleCtx()
    const a = explore.anchorOf(bot, ctx)
    assert.equal(a.label, 'castle')
    assert.equal(a.x, CASTLE.x)
    assert.equal(a.z, CASTLE.z)
  })

  it('a wool search from the site stays within 96 of the site (was 500 to home)', () => {
    const bot = mockBot({ x: CASTLE.x, y: 64, z: CASTLE.z - 3 })
    const ctx = activeCastleCtx()
    // Prod shape: home chunks visited, castle ground fresh.
    ctx.explore.visited.add('0,0')
    const t = explore.nextTarget(bot, ctx, bring.SELF_SEARCH_RADIUS)
    assert.ok(t, 'fresh ground in reach at the site')
    const dSite = Math.hypot(t.x - CASTLE.x, t.z - CASTLE.z)
    const dHome = Math.hypot(t.x - HOME.x, t.z - HOME.z)
    assert.ok(dSite <= bring.SELF_SEARCH_RADIUS, `leg ${t.x},${t.z} ${Math.round(dSite)} from site`)
    assert.ok(dHome > 400, `leg stays off home ground (${Math.round(dHome)} away)`)
  })

  it('the explore step caps at TASK_SEARCH_RADIUS while a task is active', () => {
    assert.equal(explore.TASK_SEARCH_RADIUS, 64)
    const bot = mockBot({ x: CASTLE.x, y: 64, z: CASTLE.z - 3 })
    const ctx = activeCastleCtx()
    explore(bot, ctx, null, null)
    const t = ctx.explore.target
    assert.ok(t, 'a leg is picked')
    const d = Math.hypot(t.x - CASTLE.x, t.z - CASTLE.z)
    assert.ok(d <= explore.TASK_SEARCH_RADIUS, `explore leg ${t.x},${t.z} ${Math.round(d)} from site`)
  })

  it('no castle: home anchor and the full 256 spiral (old behaviour kept)', () => {
    const bot = mockBot({ x: 0, y: 64, z: 0 })
    const ctx = { home: { site: { ...HOME }, built: true, v: 2 }, explore: { visited: new Set(), target: null, lastPos: null, stalls: 0, issuedKey: null, markStart: 0, chatAt: 0 } }
    assert.equal(explore.anchorOf(bot, ctx).label, 'home')
    assert.equal(explore.taskActive(ctx), false)
    // A parked or complete castle releases the anchor too.
    assert.equal(explore.anchorOf(bot, { ...ctx, castle: { site: { ...CASTLE }, parked: true, phase: 'body' } }).label, 'home')
    assert.equal(explore.anchorOf(bot, { ...ctx, castle: { site: { ...CASTLE }, parked: false, phase: 'complete' } }).label, 'home')
  })

  it('R3a: an owner bring order keeps the home anchor and the full spiral', () => {
    const bot = mockBot({ x: CASTLE.x, y: 64, z: CASTLE.z - 3 })
    const ctx = activeCastleCtx()
    ctx.bring = { kind: 'block', name: 'diamond_ore' } // owner order: no self
    assert.equal(explore.ownerBring(ctx), true)
    assert.equal(explore.anchorOf(bot, ctx).label, 'home', 'owner orders never re-anchor')
    // Rings 16/32/64 around home visited: uncapped the 128 leg still picks.
    for (const r of [16, 32, 64]) {
      for (let a = 0; a < 8; a++) {
        const x = Math.round(HOME.x + r * Math.sin(a * Math.PI / 4))
        const z = Math.round(HOME.z - r * Math.cos(a * Math.PI / 4))
        ctx.explore.visited.add(`${Math.floor(x / 16)},${Math.floor(z / 16)}`)
      }
    }
    explore(bot, ctx, null, null)
    const t = ctx.explore.target
    assert.ok(t, 'an owner leg still picks past 64')
    assert.equal(Math.round(Math.hypot(t.x - HOME.x, t.z - HOME.z)), 128)
  })

  it('R3b: an unbuilt house site bounds own explore at 64 too', () => {
    const bot = mockBot({ x: HOME.x, y: 64, z: HOME.z })
    const ctx = {
      home: { site: { ...HOME }, built: false, v: 2 },
      explore: { visited: new Set(), target: null, lastPos: null, stalls: 0, issuedKey: null, markStart: 0, chatAt: 0 },
    }
    assert.equal(explore.taskActive(ctx), true)
    for (const r of [16, 32, 64]) {
      for (let a = 0; a < 8; a++) {
        const x = Math.round(HOME.x + r * Math.sin(a * Math.PI / 4))
        const z = Math.round(HOME.z - r * Math.cos(a * Math.PI / 4))
        ctx.explore.visited.add(`${Math.floor(x / 16)},${Math.floor(z / 16)}`)
      }
    }
    explore(bot, ctx, null, null)
    assert.equal(ctx.stepStatus, 'done', 'the 64 spiral is exhausted, no 128 leg')
    assert.equal(ctx.explore.target, null)
  })

  it('R3c: the 64 clamp is proven — visited 16/32/64 at the castle ends the spiral', () => {
    const bot = mockBot({ x: CASTLE.x, y: 64, z: CASTLE.z - 3 })
    const ctx = activeCastleCtx()
    for (const r of [16, 32, 64]) {
      for (let a = 0; a < 8; a++) {
        const x = Math.round(CASTLE.x + r * Math.sin(a * Math.PI / 4))
        const z = Math.round(CASTLE.z - r * Math.cos(a * Math.PI / 4))
        ctx.explore.visited.add(`${Math.floor(x / 16)},${Math.floor(z / 16)}`)
      }
    }
    explore(bot, ctx, null, null)
    // Without the clamp this picks the 128 ring; with it the task spiral is done.
    assert.equal(ctx.stepStatus, 'done')
    assert.equal(ctx.explore.target, null)
  })
})
