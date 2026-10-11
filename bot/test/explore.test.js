'use strict'

// Explore primitive (idkcraft-atl.1): hands only, no decisions — atl.2 picks
// when. Spiral target beyond the visited boundary, GoalXZ walk, arrival
// scan into resource memory, done/failed via ctx.stepStatus.

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const { createTicker, BEHAVIOURS } = require('../src/index')
const explore = require('../src/behaviours/explore')
const danger = require('../src/danger')

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
    username: 'IdkBot', players: { Owner: { username: 'Owner' } }, entities: {},
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
  it('(mnx) skips spiral points within a gave-up spot', () => {
    // First pick (0,-16) is banned -> next unvisited point (11,-11).
    const bot = mockBot()
    const ctx = homeCtx()
    danger.mark(ctx, { x: 0, y: 64, z: -16 })
    explore(bot, ctx, null, null)
    assert.deepEqual(ctx.explore.target, { x: 11, z: -11 })
    assert.equal(bot.calls.goals.length, 1)
  })

  it('first pick is ring 16 north of home', () => {
    // Live: a hands-only walker without tools cannot reliably close
    // 64-block forest legs (trunk clusters wedge every leg), while 16-32
    // block legs complete. Inner rings first, reach to 512 preserved.
    const bot = mockBot()
    const ctx = homeCtx()
    explore(bot, ctx, null, null)
    const e = ctx.explore
    assert.deepEqual(e.target, { x: 0, z: -16 })
    assert.equal(bot.calls.goals.length, 1)
    assert.equal(bot.calls.goals[0].constructor.name, 'GoalXZ')
    assert.ok(bot.chats.some((m) => m === 'exploring north, 16 blocks from home'))
  })

  it('exposes MAX_RADIUS for dxl (default 256)', () => {
    assert.equal(explore.MAX_RADIUS, 256)
  })

  it('default cap ends the spiral at 256, ring 320 never picked', () => {
    const bot = mockBot()
    const ctx = homeCtx()
    ctx.explore = { visited: new Set(), target: null, lastPos: null, stalls: 0, markStart: 0, chatAt: 0 }
    for (const r of [16, 32, 64, 128, 192, 256]) {
      for (let a = 0; a < 8; a++) {
        const x = Math.round(r * Math.sin(a * Math.PI / 4))
        const z = Math.round(-r * Math.cos(a * Math.PI / 4))
        ctx.explore.visited.add(Math.floor(x / 16) + ',' + Math.floor(z / 16))
      }
    }
    explore(bot, ctx, null, null)
    assert.equal(ctx.stepStatus, 'done')
    assert.equal(bot.calls.goals.length, 0)
  })

  it('maxRadius override re-opens outer rings', () => {
    const bot = mockBot()
    const ctx = homeCtx()
    ctx.explore = { visited: new Set(), target: null, lastPos: null, stalls: 0, markStart: 0, chatAt: 0, maxRadius: 512 }
    for (const r of [16, 32, 64, 128, 192, 256]) {
      for (let a = 0; a < 8; a++) {
        const x = Math.round(r * Math.sin(a * Math.PI / 4))
        const z = Math.round(-r * Math.cos(a * Math.PI / 4))
        ctx.explore.visited.add(Math.floor(x / 16) + ',' + Math.floor(z / 16))
      }
    }
    explore(bot, ctx, null, null)
    assert.deepEqual(ctx.explore.target, { x: 0, z: -320 })
  })

  it('ascends rings past visited chunks, never re-enters them', () => {
    const bot = mockBot()
    const ctx = homeCtx()
    // Mark every ring-16 candidate chunk visited (8 angles).
    ctx.explore = { visited: new Set(), target: null, lastPos: null, stalls: 0, markStart: 0, chatAt: 0 }
    for (let a = 0; a < 8; a++) {
      const x = Math.round(16 * Math.sin(a * Math.PI / 4))
      const z = Math.round(-16 * Math.cos(a * Math.PI / 4))
      ctx.explore.visited.add(`${Math.floor(x / 16)},${Math.floor(z / 16)}`)
    }
    explore(bot, ctx, null, null)
    assert.deepEqual(ctx.explore.target, { x: 0, z: -32 })
  })

  it('reports done when every ring to 512 is visited', () => {
    const bot = mockBot()
    const lines = []
    const origLog = console.log
    console.log = (m) => lines.push(String(m))
    try {
      const ctx = homeCtx()
      ctx.explore = { visited: new Set(), target: null, lastPos: null, stalls: 0, markStart: 0, chatAt: 0 }
      for (const r of [16, 32, 64, 128, 192, 256, 320, 384, 448, 512]) {
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

  it('(hlk) exhausted spiral restarts from the current chunk instead of done-forever', () => {
    const bot = mockBot()
    const lines = []
    const origLog = console.log
    console.log = (m) => lines.push(String(m))
    try {
      const ctx = homeCtx()
      ctx.explore = { visited: new Set(), target: null, lastPos: null, stalls: 0, markStart: 0, chatAt: 0 }
      for (const r of [16, 32, 64, 128, 192, 256]) {
        for (let a = 0; a < 8; a++) {
          const x = Math.round(r * Math.sin(a * Math.PI / 4))
          const z = Math.round(-r * Math.cos(a * Math.PI / 4))
          ctx.explore.visited.add(`${Math.floor(x / 16)},${Math.floor(z / 16)}`)
        }
      }
      explore(bot, ctx, null, null)
      assert.equal(ctx.stepStatus, 'done')
      assert.deepEqual([...ctx.explore.visited], ['0,0']) // only the current chunk kept
      ctx.stepStatus = 'running'
      explore(bot, ctx, null, null) // next step re-picks instead of done-looping
      assert.deepEqual(ctx.explore.target, { x: 0, z: -16 })
      assert.equal(bot.calls.goals.length, 1)
    } finally {
      console.log = origLog
    }
  })
})

describe('explore walk and arrival', () => {
  it('arrival reports done, scans new chunks into memory, one wedge line', () => {
    const bot = mockBot()
    bot.findBlocks = () => [pos(5, 60, -14)]
    bot.blockAt = (p) => ({ name: p.x === 5 ? 'iron_ore' : 'stone' })
    const lines = []
    const origLog = console.log
    console.log = (m) => lines.push(String(m))
    try {
      const ctx = homeCtx()
      explore(bot, ctx, null, null) // picks (0,-16)
      assert.deepEqual(ctx.explore.target, { x: 0, z: -16 })
      bot.entity.position = pos(0, 64, -15) // walked into arrival range
      bot._moving = false
      explore(bot, ctx, null, null)
      assert.equal(ctx.stepStatus, 'done')
      const wedge = lines.filter((l) => l.includes('explore to 0 -16'))
      assert.equal(wedge.length, 1)
      assert.ok(wedge[0].includes('chunks new)'), wedge[0])
      const mem = ctx.resources
      assert.ok(mem && mem.items.size >= 1, 'arrival scan ingested')
    } finally {
      console.log = origLog
    }
  })

  it('arrival one chunk short still consumes the target', () => {
    // Target (0,-16) sits in chunk (0,-1); arriving at z=-18 (dist 2) stops
    // in chunk (0,-2). Without consuming the target chunk on arrival, the
    // next dispatch re-picks the same point and dones without moving.
    const bot = mockBot()
    const ctx = homeCtx()
    explore(bot, ctx, null, null)
    assert.deepEqual(ctx.explore.target, { x: 0, z: -16 })
    bot.entity.position = pos(0, 64, -18)
    bot._moving = false
    explore(bot, ctx, null, null)
    assert.equal(ctx.stepStatus, 'done')
    ctx.stepStatus = 'running'
    explore(bot, ctx, null, null)
    const nt = ctx.explore.target
    assert.ok(nt.x === 16 && nt.z === 0, `next target ${nt.x},${nt.z}`)
  })

  it('stall within near radius arrives: the point is covered, not failed', () => {
    // Live (forest world): the exact spiral XZ often sits in a trunk or
    // water cell, so the walk stalls a few blocks out with nowhere to
    // stand. The 48-block arrival scan covers the point from there, so a
    // stall inside near radius is an arrival (done + scan), not a failure.
    const bot = mockBot()
    bot._moving = true // executor claims motion, body stands still
    bot.findBlocks = () => [pos(3, 60, -12)]
    bot.blockAt = (p) => ({ name: p.x === 3 ? 'iron_ore' : 'stone' })
    const ctx = homeCtx()
    explore(bot, ctx, null, null) // picks (0,-16)
    bot.entity.position = pos(0, 64, -10) // 6 out: inside near, outside exact
    for (let i = 0; i < 12; i++) explore(bot, ctx, null, null)
    assert.equal(ctx.stepStatus, 'done')
    assert.equal(ctx.stuck, undefined)
    assert.ok(ctx.resources && ctx.resources.items.size >= 1, 'near arrival scans')
    ctx.stepStatus = 'running'
    explore(bot, ctx, null, null)
    const nt = ctx.explore.target
    assert.ok(nt.x === 16 && nt.z === 0, `next target ${nt.x},${nt.z}`)
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
      assert.deepEqual(ctx.stuck, { by: 'explore', goal: { x: 0, y: 64, z: -16 }, key: 'explore:0,-16' })
      // The unreachable point is consumed: the next dispatch advances the
      // spiral instead of walking the same obstacle again.
      ctx.stepStatus = 'running'
      explore(bot, ctx, null, null)
      const nt = ctx.explore.target
    assert.ok(nt.x === 16 && nt.z === 0, `next target ${nt.x},${nt.z}`)
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
    bot.entity.position = pos(0, 64, -16)
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

describe('explore pit escape through the ticker (core-1)', () => {
  // Flat world, full ticker: the real explore step from a pit (body still,
  // executor driving). The leg fails at 10, the give-up requests one
  // escape, the next tick routes the menu with the leg target as the goal —
  // without the request the spiral would cycle targets forever, the central
  // stills resetting on every give-up.
  function pitBot() {
    const bot = mockBot()
    bot.health = 20
    bot.food = 20
    bot.entity = { position: pos(0, 64, 0), onGround: true }
    bot.players = { P: { username: 'P', entity: { id: 7, username: 'P', position: pos(30, 64, 0) } } }
    bot.entities = {}
    bot._moving = true
    bot.pathfinder.stop = () => {}
    bot.pathfinder.setMovements = () => {}
    bot.setControlState = () => {}
    bot.getControlState = () => false
    bot.clearControlStates = () => {}
    bot.attack = () => {}
    bot.lookAt = () => {}
    bot.inventory = { items: () => [] }
    return bot
  }

  it('a failed leg requests an escape and the menu opens', async () => {
    const bot = pitBot()
    const ticker = createTicker({
      bot,
      brain: { decide: async () => ({ action: 'explore', sprint: false, source: 'stub' }) },
      tickMs: 10,
      idleTickMs: 10,
    })
    const ctx = bot._tickerCtx
    ctx.home = { site: { x: 0, y: 64, z: 0 } }
    const lines = []
    const origLog = console.log
    console.log = (m) => { lines.push(String(m)) }
    try {
      for (let i = 0; i < 11; i++) await ticker.tick()
      assert.equal(ctx.stepStatus, 'failed:unreachable')
      assert.deepEqual(ctx.stuck, { by: 'explore', goal: { x: 0, y: 64, z: -16 }, key: 'explore:0,-16' })
      await ticker.tick() // the requested fact routes the menu
      assert.ok(ctx.recovery, 'episode opens for the failed leg')
      assert.ok(lines.some((l) => l.includes('outcome=chosen')), 'menu chose')
    } finally {
      console.log = origLog
      ticker.destroy()
    }
  })
})

describe('explore depth floor (atl.23)', () => {
  it('under the floor: drops the leg, climbs with GoalY, not done; above: GoalXZ resumes', () => {
    const bot = mockBot()
    const ctx = homeCtx() // home y 64 -> floor 48
    explore(bot, ctx, null, null) // leg to (0,-16) issued at the surface
    assert.equal(bot.calls.goals[0].constructor.name, 'GoalXZ')
    bot.entity.position = pos(5, -40, -5)
    const logs = []
    const origLog = console.log
    console.log = (m) => { logs.push(String(m)) }
    try {
      explore(bot, ctx, null, null)
      explore(bot, ctx, null, null) // same climb: no re-issue
    } finally { console.log = origLog }
    assert.equal(bot.calls.goals.length, 2)
    assert.equal(bot.calls.goals[1].constructor.name, 'GoalY')
    assert.equal(bot.calls.goals[1].y, 48)
    assert.equal(ctx.explore.target, null)
    assert.notEqual(ctx.stepStatus, 'done')
    assert.deepEqual(logs, ['explore too deep y=-40 floor=48'])
    bot.entity.position = pos(5, 48, -5)
    explore(bot, ctx, null, null)
    assert.equal(bot.calls.goals[2].constructor.name, 'GoalXZ')
    assert.ok(ctx.explore.target)
  })

  it('stall escape carries the target column height, not the bot y', () => {
    const bot = mockBot()
    bot.blockAt = (p) => ({ name: p.y > 70 ? 'air' : 'stone' })
    const ctx = homeCtx()
    explore(bot, ctx, null, null)
    for (let i = 0; i < 12 && !ctx.stuck; i++) explore(bot, ctx, null, null)
    assert.deepEqual(ctx.stuck.goal, { x: 0, y: 71, z: -16 })
  })

  it('grass and a canopy over a level target read as air: goal y is the ground', () => {
    const bot = mockBot()
    bot.blockAt = (p) => {
      if (p.y >= 70) return { name: 'air', boundingBox: 'empty' }
      if (p.y >= 66) return { name: 'oak_leaves', boundingBox: 'block' }
      if (p.y === 65) return { name: 'oak_log', boundingBox: 'block' }
      if (p.y === 64) return { name: 'short_grass', boundingBox: 'empty' }
      return { name: 'grass_block', boundingBox: 'block' }
    }
    const ctx = homeCtx()
    explore(bot, ctx, null, null)
    for (let i = 0; i < 12 && !ctx.stuck; i++) explore(bot, ctx, null, null)
    assert.deepEqual(ctx.stuck.goal, { x: 0, y: 64, z: -16 })
  })

  it('a climb gaining no height fails the step with one escape aimed up', () => {
    const bot = mockBot()
    bot.entity.position = pos(5, 30, -5)
    const ctx = homeCtx()
    const origLog = console.log
    console.log = () => {}
    try {
      explore(bot, ctx, null, null)
      for (let i = 0; i < 9; i++) explore(bot, ctx, null, null)
      assert.equal(ctx.stuck, undefined)
      bot.entity.position = pos(5, 31, -5) // height gained: budget resets
      for (let i = 0; i < 10; i++) explore(bot, ctx, null, null) // 1 reset + 9 flat
      assert.equal(ctx.stuck, undefined)
      explore(bot, ctx, null, null) // 10th flat tick
    } finally { console.log = origLog }
    assert.equal(ctx.stepStatus, 'failed:too-deep')
    assert.deepEqual(ctx.stuck, { by: 'explore', goal: { x: 5, y: 48, z: -5 }, key: 'explore:climb:48' })
  })

  it('a failed climb holds at its spot: the spiral walks, no second escape; a borrow keeps the budget', () => {
    const bot = mockBot()
    bot.entity.position = pos(5, 30, -5)
    const ctx = homeCtx()
    const origLog = console.log
    const logs = []
    console.log = (m) => { logs.push(String(m)) }
    try {
      explore(bot, ctx, null, null)
      for (let i = 0; i < 5; i++) explore(bot, ctx, null, null)
      ctx.lastGoalKey = 'fight:1' // borrow mid-climb
      for (let i = 0; i < 6; i++) explore(bot, ctx, null, null) // re-issue + 5 flat = 10
      assert.equal(ctx.stepStatus, 'failed:too-deep')
      assert.equal(logs.filter((l) => l.startsWith('explore too deep')).length, 1)
      ctx.stuck = undefined
      ctx.stepStatus = 'running'
      for (let i = 0; i < 12; i++) explore(bot, ctx, null, null)
    } finally { console.log = origLog }
    assert.equal(bot.calls.goals[bot.calls.goals.length - 1].constructor.name, 'GoalXZ')
    assert.ok(!ctx.stuck || ctx.stuck.key !== 'explore:climb:48', 'no second climb escape at the same spot')
  })
})

describe('explore idle alone (vmzq.59)', () => {
  function quiet(fn) {
    const origLog = console.log
    const logs = []
    console.log = (m) => { logs.push(String(m)) }
    try { fn() } finally { console.log = origLog }
    return logs
  }
  // Rings 16/32/64 fully visited: the next pick is ring 128 unless capped.
  function ringsVisited(ctx) {
    ctx.explore = { visited: new Set(), target: null, lastPos: null, stalls: 0, markStart: 0, chatAt: 0 }
    for (const r of [16, 32, 64]) {
      for (let a = 0; a < 8; a++) {
        const x = Math.round(r * Math.sin(a * Math.PI / 4))
        const z = Math.round(-r * Math.cos(a * Math.PI / 4))
        ctx.explore.visited.add(`${Math.floor(x / 16)},${Math.floor(z / 16)}`)
      }
    }
  }

  it('nobody online, no task: no target beyond 64; with a player online ring 128 is picked', () => {
    const online = mockBot()
    const c1 = homeCtx()
    ringsVisited(c1)
    explore(online, c1, null, null)
    assert.deepEqual(c1.explore.target, { x: 0, z: -128 })

    const alone = mockBot()
    alone.players = { IdkBot: { username: 'IdkBot' } }
    const c2 = homeCtx()
    ringsVisited(c2)
    const logs = quiet(() => explore(alone, c2, null, null))
    assert.equal(c2.explore.target, null)
    assert.equal(c2.stepStatus, 'done')
    assert.deepEqual(logs, ['explore done: all chunks within 64 blocks visited'])
  })

  it('an owner bring order alone keeps the full spiral', () => {
    const bot = mockBot()
    bot.players = {}
    const ctx = homeCtx()
    ctx.bring = { item: 'white_wool' }
    ringsVisited(ctx)
    explore(bot, ctx, null, null)
    assert.deepEqual(ctx.explore.target, { x: 0, z: -128 })
  })

  it('a far leg pending when the roster empties is cancelled and re-picked within 64', () => {
    const bot = mockBot()
    const ctx = homeCtx()
    ringsVisited(ctx)
    explore(bot, ctx, null, null)
    assert.deepEqual(ctx.explore.target, { x: 0, z: -128 })
    bot.players = {}
    quiet(() => explore(bot, ctx, null, null))
    assert.equal(ctx.explore.target, null)
    assert.equal(ctx.stepStatus, 'done')
    assert.equal(bot.pathfinder.goal, null, 'the far GoalXZ is cleared')
  })

  it('roofed 10 under the anchor surface alone: the leg drops, the bot climbs to anchor-8; not re-picked', () => {
    const bot = mockBot() // blockAt: stone everywhere = roofed
    const ctx = homeCtx() // home y 64 -> alone floor 56 (atl.23 floor 48)
    explore(bot, ctx, null, null)
    assert.deepEqual(ctx.explore.target, { x: 0, z: -16 })
    bot.players = {}
    bot.entity.position = pos(5, 54, -5)
    const logs = quiet(() => { explore(bot, ctx, null, null); explore(bot, ctx, null, null) })
    assert.deepEqual(logs, ['explore too deep y=54 floor=56'])
    const last = bot.calls.goals[bot.calls.goals.length - 1]
    assert.equal(last.constructor.name, 'GoalY')
    assert.equal(last.y, 56)
    assert.ok(ctx.explore.visited.has('0,-1'), 'the dropped leg chunk is consumed')
    for (let i = 0; i < 10; i++) quiet(() => explore(bot, ctx, null, null))
    assert.equal(ctx.stepStatus, 'failed:too-deep')
    assert.equal(ctx.stuck.key, 'explore:climb:56')
    bot.entity.position = pos(5, 56, -5)
    explore(bot, ctx, null, null)
    assert.notDeepEqual(ctx.explore.target, { x: 0, z: -16 })
  })

  it('forage picker skips cells beyond 64 when idle alone; online, or alone pre-home, it does not', () => {
    const forage = require('../src/behaviours/forage')
    const far = { x: 100, z: 0 }
    const near = { x: 40, z: 0 }
    const alone = mockBot()
    alone.players = {}
    const ctx = { home: { site: { x: 0, y: 64, z: 0 }, built: true } }
    assert.equal(forage.parkedCellSkipped(ctx, far, alone), true)
    assert.equal(forage.parkedCellSkipped(ctx, near, alone), false)
    assert.equal(forage.parkedCellSkipped(ctx, far, mockBot()), false, 'someone online: unbound')
    assert.equal(forage.parkedCellSkipped({}, far, alone), false, 'alone with no anchor: unbound (parked keeps its no-anchor skip)')
    assert.equal(forage.parkedCellSkipped({ home: { site: { x: 0, y: 64, z: 0 }, built: false } }, far, alone), false, 'active task: not idle')
  })

  it('same depth with a player online, or under open sky alone: no climb (normal path)', () => {
    const online = mockBot()
    online.entity.position = pos(5, 54, -5)
    explore(online, homeCtx(), null, null)
    assert.equal(online.calls.goals[0].constructor.name, 'GoalXZ')

    const sky = mockBot()
    sky.players = {}
    sky.blockAt = (p) => (p.y > 54 ? { name: 'air', boundingBox: 'empty' } : { name: 'stone', boundingBox: 'block' })
    sky.entity.position = pos(5, 54, -5)
    explore(sky, homeCtx(), null, null)
    assert.equal(sky.calls.goals[0].constructor.name, 'GoalXZ')
  })
})

describe('stranded-wood leash lift (vmzq.65)', () => {
  function taskCtx(farEmpty) {
    return {
      home: { site: { x: 0, y: 64, z: 0 }, built: false, v: 2 },
      stepStatus: 'running',
      gather: { final: 'failed:no-trees', atLogs: 0, farEmpty, skip: new Set(), streak: 0 },
    }
  }
  function ringsVisited(ctx) {
    ctx.explore = { visited: new Set(), target: null, lastPos: null, stalls: 0, markStart: 0, chatAt: 0 }
    for (const r of [16, 32, 64]) {
      for (let a = 0; a < 8; a++) {
        const x = Math.round(r * Math.sin(a * Math.PI / 4))
        const z = Math.round(-r * Math.cos(a * Math.PI / 4))
        ctx.explore.visited.add(`${Math.floor(x / 16)},${Math.floor(z / 16)}`)
      }
    }
  }

  it('woodStranded reads the gather record', () => {
    assert.equal(explore.woodStranded(taskCtx(true)), true)
    assert.equal(explore.woodStranded(taskCtx(false)), false)
    assert.equal(explore.woodStranded({ gather: {} }), false)
    assert.equal(explore.woodStranded({}), false)
    assert.equal(explore.woodStranded(null), false)
  })

  it('capOf lifts the task leash to the outer disk while stranded, no unlock', () => {
    const bot = mockBot() // Owner online: the alone cap does not apply
    const ctx = taskCtx(true)
    assert.equal(ctx.goal, undefined, 'no watchdog window armed')
    assert.equal(explore.capOf(bot, ctx, { maxRadius: explore.MAX_RADIUS }), 256)
  })

  it('capOf stays at the task radius once the record clears', () => {
    const bot = mockBot()
    assert.equal(explore.capOf(bot, taskCtx(false), { maxRadius: explore.MAX_RADIUS }), 64)
  })

  it('capOf stays at 64 alone even while stranded (vmzq.59)', () => {
    const bot = mockBot()
    bot.players = {}
    assert.equal(explore.capOf(bot, taskCtx(true), { maxRadius: explore.MAX_RADIUS }), 64)
  })

  it('the spiral walks past 64 while stranded, ends at 64 once cleared', () => {
    const bot = mockBot()
    const c1 = taskCtx(true)
    ringsVisited(c1)
    explore(bot, c1, null, null)
    assert.deepEqual(c1.explore.target, { x: 0, z: -128 })

    const c2 = taskCtx(false)
    ringsVisited(c2)
    const origLog = console.log
    const logs = []
    console.log = (m) => { logs.push(String(m)) }
    try {
      explore(bot, c2, null, null)
    } finally {
      console.log = origLog
    }
    assert.equal(c2.explore.target, null)
    assert.equal(c2.stepStatus, 'done')
    assert.deepEqual(logs, ['explore done: all chunks within 64 blocks visited'])
  })
})
