'use strict'

// Bead idkcraft-ipn.11: gear starves — beds repeats thin wool hunts every
// day and equip repeats the identical table failure after every death, and
// both outrank gear. Partial hunts count toward the beds day latch, and a
// same-reason equip failure latches equip for the day; with both latched a
// ready gear gets the body.

const { describe, it, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const goal = require('../src/goal')
const beds = require('../src/behaviours/beds')
const equip = require('../src/behaviours/equip')

function pos(x, y, z) {
  const p = { x, y, z, distanceTo: (q) => Math.hypot(x - q.x, y - q.y, z - q.z) }
  p.clone = () => pos(p.x, p.y, p.z)
  p.floored = () => pos(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z))
  return p
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
    chat: () => {},
  }
}

const settle = async (n = 5) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)) }

describe('ipn.11 partial wool hunts latch beds for the day', () => {
  const FACTS = { time: 'day', home: 'built', beds: 'none' }

  it('two thin hunts latch; a zero-gain short hunt still reopens free', () => {
    // Prod: 'searched 4 areas, only got 1 brown_wool' 7x — partials
    // reopened forever and the latch never armed.
    const pack = []
    const bot = bedsBot()
    bot.inventory = { items: () => pack }
    const ctx = { home: v2home({ x: 10, y: 64, z: 20 }), beds: { phase: 'wool' } }
    const F = goal.MENU.beds.feasible
    assert.equal(F(FACTS, bot, ctx), true, 'unlatched up front')

    // Hunt 1: opens empty, closes with 1 wool of 6 owed.
    beds(bot, ctx)
    assert.ok(ctx.bring && ctx.bring.self === 'beds', 'first hunt opens')
    assert.equal(ctx.beds.huntWool, 0, 'opening wool stashed')
    pack.push({ name: 'brown_wool', count: 1 })
    ctx.bring = undefined // the hunt closed
    ctx.beds.hunt = { searchLegs: { legs: 4 } }
    beds(bot, ctx)
    assert.ok(ctx.bring && ctx.bring.self === 'beds', 'partial reopens (first of the day)')
    assert.equal(ctx.beds.noWool.fails, 1, 'partial counts')
    assert.equal(F(FACTS, bot, ctx), true, 'one partial still retries')

    // Hunt 2: opens with 1, closes with 2 — still short.
    pack.length = 0
    pack.push({ name: 'brown_wool', count: 2 })
    ctx.bring = undefined
    ctx.beds.hunt = { searchLegs: { legs: 4 } }
    beds(bot, ctx)
    assert.equal(ctx.beds.noWool.fails, 2, 'second partial counts')
    assert.equal(F(FACTS, bot, ctx), false, 'two thin hunts latch the day')
    assert.equal(goal.stepWhy('beds', FACTS, bot, ctx, ''), 'beds: sheep hunt latched')
    bot.time.day = 6 // 9qt0: a new MC day no longer releases
    assert.equal(F(FACTS, bot, ctx), false, 'next MC day stays latched')
    ctx.beds.noWool.at -= beds.LATCH_MS
    assert.equal(F(FACTS, bot, ctx), true, 'expired latch retries')
  })

  it('a short hunt that gained nothing reopens without counting', () => {
    // Transient cancels (dusk, foreign orders) must not spend the latch.
    const bot = bedsBot()
    const ctx = { home: v2home({ x: 10, y: 64, z: 20 }), beds: { phase: 'wool', hunt: { searchLegs: { legs: 3 } }, huntWool: 0 } }
    beds(bot, ctx)
    assert.ok(ctx.bring && ctx.bring.self === 'beds', 'short hunt reopens')
    assert.equal(ctx.beds.noWool, undefined, 'zero gain counts nothing')
  })
})

describe('ipn.11 same-reason equip failures latch equip for the day', () => {
  function equipBot() {
    const calls = { goals: [] }
    return {
      calls,
      chats: [],
      username: 'IdkBot',
      players: {},
      entities: {},
      time: { timeOfDay: 6000, day: 5 },
      spawnPoint: pos(0, 64, 0),
      entity: { position: pos(0, 64, 0) },
      // Stone chain on hand, no tools: the pickaxe op needs the table.
      inventory: { items: () => [{ name: 'cobblestone', count: 3 }, { name: 'stick', count: 2 }] },
      // The home table stands but far away: every tick walks, never arrives.
      blockAt: () => ({ name: 'crafting_table' }),
      pathfinder: { goal: null, setGoal: (g) => { calls.goals.push(g) }, isMoving: () => false },
      chat: () => {},
    }
  }

  function equipCtx(bot) {
    return {
      home: { table: { x: 100, y: 64, z: 100 } },
      step: 'equip',
      stepStatus: 'running',
      equip: {},
      bot,
    }
  }

  async function runToFail(bot, ctx) {
    ctx.stepStatus = 'running'
    ctx.equip = {} // decide resets run counters on every fresh pick
    for (let t = 0; t < 30 && ctx.stepStatus === 'running'; t++) {
      equip(bot, ctx)
      await settle()
    }
    return ctx.stepStatus
  }

  it('the identical table failure twice latches; a new reason re-arms', async () => {
    // Prod: 'wooden_sword table-unreachable' at 14:04, 14:23, 14:25 —
    // every death-respawn released the atl.4 hold and re-armed the same
    // failure.
    const bot = equipBot()
    const ctx = equipCtx(bot)
    const F = goal.MENU.equip.feasible
    const facts = { sword: 0, pickaxe: 0, sticks: 2, planks: 0, logs: 0, cobble: 3, table: 0, tablePlaced: true, scaffold: 0 }

    assert.equal(await runToFail(bot, ctx), 'failed:equip-stone_pickaxe')
    assert.deepEqual(ctx.equipLatch, { day: 5, key: 'stone_pickaxe:table-unreachable', fails: 1 })
    assert.equal(F(facts, bot, ctx), true, 'first failure still retries')
    assert.equal(equip.equipLatched(ctx, bot), false)

    assert.equal(await runToFail(bot, ctx), 'failed:equip-stone_pickaxe')
    assert.deepEqual(ctx.equipLatch, { day: 5, key: 'stone_pickaxe:table-unreachable', fails: 2 })
    assert.equal(equip.equipLatched(ctx, bot), true, 'same reason twice latches')
    assert.equal(F(facts, bot, ctx), false, 'latched day reads infeasible')
    assert.equal(goal.stepWhy('equip', facts, bot, ctx, ''), 'equip: same failure again today')
    assert.equal(equip.EQUIP_LATCH, 2)

    bot.time.day = 6
    assert.equal(F(facts, bot, ctx), true, 'tomorrow retries')
  })

  it('a different reason resets the count instead of latching', async () => {
    const bot = equipBot()
    const ctx = equipCtx(bot)
    assert.equal(await runToFail(bot, ctx), 'failed:equip-stone_pickaxe')
    assert.deepEqual(ctx.equipLatch, { day: 5, key: 'stone_pickaxe:table-unreachable', fails: 1 })
    // The table is gone now (mined): same item, new reason.
    delete ctx.home.table
    bot.blockAt = () => ({ name: 'air' })
    assert.equal(await runToFail(bot, ctx), 'failed:equip-stone_pickaxe')
    assert.deepEqual(ctx.equipLatch, { day: 5, key: 'stone_pickaxe:no-table', fails: 1 }, 'new reason restarts the count')
    assert.equal(equip.equipLatched(ctx, bot), false)
  })

  it('latch input never throws', () => {
    const bot = equipBot()
    assert.equal(equip.equipLatched(undefined, undefined), false)
    assert.equal(equip.equipLatched({}, {}), false)
    assert.equal(equip.equipLatched({ equipLatch: 'x' }, bot), false)
  })
})

describe('ipn.11 driven latches let a ready gear take the body', () => {
  // End to end on one ctx each: the failures are DRIVEN through the
  // behaviours (not preset), then the same ctx decides. Pre-fix the
  // partials never count and the equip reason never latches, so the menu
  // keeps picking beds/equip and both tests fail.
  function gearBot(pack) {
    const site = { x: 10, y: 64, z: 10 }
    return {
      chats: [],
      username: 'IdkBot',
      players: {},
      entities: {},
      health: 20,
      food: 20,
      time: { timeOfDay: 6000, day: 5 },
      spawnPoint: pos(0, 64, 0),
      entity: { position: pos(0, 64, 0) },
      inventory: { items: () => pack },
      // A finished house: table/door stand, walls/roof/fills read done,
      // bedrooms hold no beds.
      blockAt: (p) => {
        const x = Math.floor(p.x)
        const y = Math.floor(p.y)
        const z = Math.floor(p.z)
        if (x === site.x + 5 && y === site.y && z === site.z + 1) return { name: 'crafting_table', boundingBox: 'block' }
        if (x === site.x + 3 && y === site.y && z === site.z) return { name: 'oak_door', boundingBox: 'block' }
        if (y < site.y) return { name: 'dirt', boundingBox: 'block' }
        return { name: 'oak_planks', boundingBox: 'block' }
      },
      findBlocks: () => [],
      pathfinder: { goal: null, setGoal: () => {}, isMoving: () => false },
      chat: (m) => {},
    }
  }

  function gearCtx() {
    const site = { x: 10, y: 64, z: 10 }
    return {
      home: {
        ...v2home(site),
        table: { x: site.x + 5, y: site.y, z: site.z + 1 },
        chest: { x: site.x + 1, y: site.y, z: site.z + 1 },
      },
      gear: { pantrySeen: 0 },
      step: 'explore',
      stepStatus: 'done',
    }
  }

  function gearedPack() {
    return [
      { name: 'stone_sword', count: 1 },
      { name: 'stone_pickaxe', count: 1 },
      { name: 'cobblestone', count: 16 }, // scaffold full: equip has nothing
      { name: 'oak_door', count: 1 },
      { name: 'oak_planks', count: 6 }, // bed top-up covered: gather rests
      { name: 'stick', count: 2 },
      { name: 'iron_ingot', count: 3 }, // the rung mats: gear ready
    ]
  }

  it('two driven partial hunts yield the body to a ready gear', async () => {
    const origLog = console.log
    console.log = () => {}
    try {
      const pack = gearedPack()
      const bot = gearBot(pack)
      const facts = goal.goalFacts(bot, gearCtx())
      assert.equal(facts.gear, 'ready', 'fixture gear is ready')
      assert.equal(facts.beds, 'none', 'fixture owes the beds')

      const free = gearCtx()
      assert.equal((await goal.decide(bot, free)).action, 'beds', 'unlatched beds outrank gear (the prod shape)')

      const ctx = gearCtx()
      ctx.beds = { phase: 'wool' }
      beds(bot, ctx) // hunt 1 opens
      assert.ok(ctx.bring && ctx.bring.self === 'beds')
      pack.push({ name: 'brown_wool', count: 1 })
      ctx.bring = undefined
      ctx.beds.hunt = { searchLegs: { legs: 4 } }
      beds(bot, ctx) // thin close: reopens AND counts (the fix)
      assert.equal(ctx.beds.noWool.fails, 1)
      pack.push({ name: 'brown_wool', count: 1 })
      ctx.bring = undefined
      ctx.beds.hunt = { searchLegs: { legs: 4 } }
      beds(bot, ctx)
      assert.equal(ctx.beds.noWool.fails, 2, 'two driven partials latch')
      ctx.bring = undefined // the hunt closed; the step ended
      ctx.beds.hunt = null
      ctx.step = 'explore'
      ctx.stepStatus = 'done'
      assert.equal((await goal.decide(bot, ctx)).action, 'gear', 'latched beds yield to a ready gear')
    } finally {
      console.log = origLog
    }
  })

  it('two driven same-reason equip failures yield the body to a ready gear', async () => {
    // Kit missing but materials on hand: equip is feasible on facts, so
    // only the latch can yield. Bedrooms already hold both beds, so beds
    // never interferes.
    const site = { x: 10, y: 64, z: 10 }
    const pack = [
      { name: 'cobblestone', count: 3 }, // the stone chain: pickaxe completable
      { name: 'stick', count: 2 },
      { name: 'oak_door', count: 1 },
      { name: 'oak_planks', count: 6 },
      { name: 'iron_ingot', count: 3 }, // the rung mats: gear ready
    ]
    const bot = gearBot(pack)
    const bedsAt = new Set([`${site.x + 1},${site.y},${site.z + 4}`, `${site.x + 2},${site.y},${site.z + 4}`, `${site.x + 4},${site.y},${site.z + 4}`, `${site.x + 5},${site.y},${site.z + 4}`])
    const baseBlockAt = bot.blockAt
    bot.blockAt = (p) => {
      if (bedsAt.has(`${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`)) return { name: 'white_bed', boundingBox: 'block' }
      return baseBlockAt(p)
    }
    const origLog = console.log
    const origErr = console.error
    console.log = () => {}
    console.error = () => {}
    try {
      const facts = goal.goalFacts(bot, gearCtx())
      assert.equal(facts.gear, 'ready', 'fixture gear is ready')
      assert.equal(facts.beds, 'both', 'bedrooms already made')

      const free = gearCtx()
      assert.equal((await goal.decide(bot, free)).action, 'equip', 'unlatched equip outranks gear (the prod shape)')

      const ctx = gearCtx()
      ctx.step = 'equip'
      for (let run = 0; run < 2; run++) {
        ctx.stepStatus = 'running'
        ctx.equip = {} // decide resets run counters on every fresh pick
        for (let t = 0; t < 30 && ctx.stepStatus === 'running'; t++) {
          equip(bot, ctx)
          await settle()
        }
        assert.equal(ctx.stepStatus, 'failed:equip-stone_pickaxe')
      }
      assert.deepEqual(ctx.equipLatch, { day: 5, key: 'stone_pickaxe:table-unreachable', fails: 2 })
      ctx.step = 'explore'
      ctx.stepStatus = 'done'
      ctx.equip = {}
      assert.equal((await goal.decide(bot, ctx)).action, 'gear', 'latched equip yields to a ready gear')
    } finally {
      console.log = origLog
      console.error = origErr
    }
  })
})
