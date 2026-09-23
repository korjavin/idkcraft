'use strict'

// Explore primitive (idkcraft-atl.1): hands only, no decisions — atl.2 picks
// when. Spiral target beyond the visited boundary, GoalXZ walk, arrival
// scan into resource memory, done/failed via ctx.stepStatus.

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const { createTicker, BEHAVIOURS } = require('../src/index')
const explore = require('../src/behaviours/explore')

function pos(x, y, z) {
  return {
    x, y, z,
    distanceTo: (q) => Math.hypot(x - q.x, y - q.y, z - q.z),
    clone() { return pos(x, y, z) },
  }
}

function mockBot() {
  const calls = { setGoal: 0, goals: [] }
  const chats = []
  const bot = {
    calls, chats,
    username: 'IdkBot', players: {}, entities: {},
    spawnPoint: pos(0, 64, 0),
    entity: { position: pos(0, 64, 0) },
    _moving: false,
    registry: { blocksByName: { iron_ore: { id: 1 }, oak_log: { id: 2 } } },
    pathfinder: {
      goal: null,
      setGoal: (g) => { calls.setGoal++; calls.goals.push(g); bot.pathfinder.goal = g },
      isMoving: () => bot._moving,
    },
    findBlocks: () => [],
    blockAt: () => ({ name: 'stone' }),
    chat: (m) => { chats.push(String(m)) },
  }
  return bot
}

function homeCtx() {
  return { home: { site: { x: 0, y: 64, z: 0 } }, stepStatus: 'running' }
}

describe('explore target spiral', () => {
  it('first pick is ring 64 north of home', () => {
    const bot = mockBot()
    const ctx = homeCtx()
    explore(bot, ctx, null, null)
    const e = ctx.explore
    assert.deepEqual(e.target, { x: 0, z: -64 })
    assert.equal(bot.calls.goals.length, 1)
    assert.equal(bot.calls.goals[0].constructor.name, 'GoalXZ')
    assert.ok(bot.chats.some((m) => m === 'exploring north, 64 blocks from home'))
  })

  it('ascends rings past visited chunks, never re-enters them', () => {
    const bot = mockBot()
    const ctx = homeCtx()
    // Mark every ring-64 candidate chunk visited (8 angles).
    ctx.explore = { visited: new Set(), target: null, lastPos: null, stalls: 0, markStart: 0, chatAt: 0 }
    for (let a = 0; a < 8; a++) {
      const x = Math.round(64 * Math.sin(a * Math.PI / 4))
      const z = Math.round(-64 * Math.cos(a * Math.PI / 4))
      ctx.explore.visited.add(`${Math.floor(x / 16)},${Math.floor(z / 16)}`)
    }
    explore(bot, ctx, null, null)
    assert.deepEqual(ctx.explore.target, { x: 0, z: -128 })
  })

  it('reports done when every ring to 512 is visited', () => {
    const bot = mockBot()
    const lines = []
    const origLog = console.log
    console.log = (m) => lines.push(String(m))
    try {
      const ctx = homeCtx()
      ctx.explore = { visited: new Set(), target: null, lastPos: null, stalls: 0, markStart: 0, chatAt: 0 }
      for (const r of [64, 128, 192, 256, 320, 384, 448, 512]) {
        for (let a = 0; a < 8; a++) {
          const x = Math.round(r * Math.sin(a * Math.PI / 4))
          const z = Math.round(-r * Math.cos(a * Math.PI / 4))
          ctx.explore.visited.add(`${Math.floor(x / 16)},${Math.floor(z / 16)}`)
        }
      }
      explore(bot, ctx, null, null)
      assert.equal(ctx.stepStatus, 'done')
      assert.equal(bot.calls.goals.length, 0)
    } finally {
      console.log = origLog
    }
  })

  it('fails without an anchor', () => {
    const bot = mockBot()
    bot.spawnPoint = null
    const ctx = { home: null, stepStatus: 'running' }
    explore(bot, ctx, null, null)
    assert.equal(ctx.stepStatus, 'failed:no-anchor')
  })
})

describe('explore walk and arrival', () => {
  it('arrival reports done, scans new chunks into memory, one wedge line', () => {
    const bot = mockBot()
    bot.findBlocks = () => [pos(5, 60, -60)]
    bot.blockAt = (p) => ({ name: p.x === 5 ? 'iron_ore' : 'stone' })
    const lines = []
    const origLog = console.log
    console.log = (m) => lines.push(String(m))
    try {
      const ctx = homeCtx()
      explore(bot, ctx, null, null) // picks (0,-64)
      assert.deepEqual(ctx.explore.target, { x: 0, z: -64 })
      bot.entity.position = pos(0, 64, -63) // walked into arrival range
      bot._moving = false
      explore(bot, ctx, null, null)
      assert.equal(ctx.stepStatus, 'done')
      const wedge = lines.filter((l) => l.includes('explore to 0 -64'))
      assert.equal(wedge.length, 1)
      assert.ok(wedge[0].includes('chunks new)'), wedge[0])
      const mem = ctx.resources
      assert.ok(mem && mem.items.size >= 1, 'arrival scan ingested')
    } finally {
      console.log = origLog
    }
  })

  it('arrival one chunk short still consumes the target', () => {
    // Target (0,-64) sits in chunk (0,-4); arriving at z=-66 (dist 2) stops
    // in chunk (0,-5). Without consuming the target chunk on arrival, the
    // next dispatch re-picks the same point and dones without moving.
    const bot = mockBot()
    const ctx = homeCtx()
    explore(bot, ctx, null, null)
    assert.deepEqual(ctx.explore.target, { x: 0, z: -64 })
    bot.entity.position = pos(0, 64, -66)
    bot._moving = false
    explore(bot, ctx, null, null)
    assert.equal(ctx.stepStatus, 'done')
    ctx.stepStatus = 'running'
    explore(bot, ctx, null, null)
    assert.deepEqual(ctx.explore.target, { x: 45, z: -45 })
  })

  it('ten still ticks fail unreachable with an explore fact', () => {
    const bot = mockBot()
    bot._moving = true // executor claims motion, body stands still
    const lines = []
    const origLog = console.log
    console.log = (m) => lines.push(String(m))
    try {
      const ctx = homeCtx()
      for (let i = 0; i < 12; i++) explore(bot, ctx, null, null)
      assert.equal(ctx.stepStatus, 'failed:unreachable')
      assert.deepEqual(ctx.stuck, { by: 'explore', goal: { x: 0, y: 64, z: -64 }, key: 'explore:0,-64' })
      // The unreachable point is consumed: the next dispatch advances the
      // spiral instead of walking the same obstacle again.
      ctx.stepStatus = 'running'
      explore(bot, ctx, null, null)
      assert.deepEqual(ctx.explore.target, { x: 45, z: -45 })
    } finally {
      console.log = origLog
    }
  })

  it('displacement resets the stall budget across a long walk', () => {
    // A 64-block walk pauses (path recomputes, doors, brief stands): still
    // ticks must not add up across real moves. 12 still ticks with moves
    // between never reach the budget; without the reset it fails at 10.
    const bot = mockBot()
    bot._moving = true
    const ctx = homeCtx()
    for (let i = 1; i <= 18; i++) {
      if (i % 3 === 0) bot.entity.position = pos(i, 64, 0) // >0.5 move
      explore(bot, ctx, null, null)
    }
    assert.equal(ctx.stepStatus, 'running')
    assert.equal(ctx.stuck, undefined)
  })

  it('retaking the target after a fight tick keeps the stall budget', () => {
    // 68p rule: a body-theft tick re-issues the same goal without resetting
    // the count, so a wedged walk still fails; resetting on every retake
    // would let alternating fight ticks stall forever.
    const bot = mockBot()
    bot._moving = true
    const ctx = homeCtx()
    for (let i = 1; i <= 5; i++) explore(bot, ctx, null, null) // stalls 0..4
    ctx.lastGoalKey = 'fight:1' // fight owned this tick
    for (let i = 1; i <= 6; i++) explore(bot, ctx, null, null)
    assert.equal(ctx.stepStatus, 'failed:unreachable')
    assert.equal(ctx.stuck.by, 'explore')
  })

  it('departure chat at most every 30 s', () => {
    const bot = mockBot()
    const ctx = homeCtx()
    explore(bot, ctx, null, null) // pick 1: chats
    assert.equal(bot.chats.length, 1)
    // Arrive instantly and pick again: same 30 s window, silent.
    bot.entity.position = pos(0, 64, -64)
    explore(bot, ctx, null, null) // arrival: done
    assert.equal(ctx.stepStatus, 'done')
    ctx.stepStatus = 'running' // atl.2 would re-dispatch; hands just continue
    explore(bot, ctx, null, null) // pick 2: throttled
    assert.equal(bot.chats.length, 1)
  })

  it('registers in BEHAVIOURS under explore', () => {
    const { BEHAVIOURS } = require('../src/index')
    assert.equal(BEHAVIOURS.explore, explore)
  })
})
