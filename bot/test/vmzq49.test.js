'use strict'

// Bead idkcraft-vmzq.49: castle work continues at health=low — run8 fell
// from the y72 frame at low hp (13:29) and died to a day zombie at the
// site (15:52), kit food=0 both times, rest/eat never chosen, and the
// retreat leg flipped back to castle into the same zombie. Fix: gate the
// castle legs on health (eat/forage/rest first when low with no food)
// and hold a retreat leg across veto flicker (hysteresis).

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const goal = require('../src/goal')
const resources = require('../src/resources')
const retreatMod = require('../src/behaviours/retreat')
require('../src/index') // BEHAVIOURS registration (goal.registered)

function pos(x, y, z) {
  const p = {
    x, y, z,
    distanceTo: (q) => Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z),
    clone() { return pos(p.x, p.y, p.z) },
    floored() { return pos(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)) },
  }
  return p
}

function goalBot({ items = [], timeOfDay = 6000, at = pos(0, 64, 0), health = 20, food = 20, entities = {} } = {}) {
  const chats = []
  return {
    chats,
    entity: { position: at, onGround: true },
    inventory: { items: () => items },
    time: { timeOfDay, day: 1 },
    spawnPoint: pos(0, 64, 0),
    players: {},
    entities,
    health,
    food,
    chat: (m) => { chats.push(m) },
  }
}

function castleState(site) {
  return { site: site || { x: 5, y: 64, z: 5 }, rot: 0, blueprintVersion: 1, phase: 'body', blocked: {}, parked: false }
}

async function quietAsync(fn) {
  const origLog = console.log
  const origErr = console.error
  console.log = () => {}
  console.error = () => {}
  try { return await fn() } finally { console.log = origLog; console.error = origErr }
}

describe('vmzq.49 health gate: castle legs stand down at low hp with no food', () => {
  const TOOLS = [{ name: 'stone_pickaxe', count: 1 }, { name: 'stone_sword', count: 1 }]
  const foodless = () => goalBot({ items: [...TOOLS], health: 5, food: 10 })
  const fed = () => goalBot({ items: [...TOOLS, { name: 'bread', count: 2 }], health: 5, food: 10 })

  it('castle: low + foodless infeasible, food or hp 6 re-opens', () => {
    const F = goal.MENU.castle.feasible
    const facts = { time: 'day', castle: 'stone-batch', health: 5, food: 10 }
    assert.equal(F(facts, foodless(), {}), false)
    assert.equal(F(facts, fed(), {}), true)
    assert.equal(F({ ...facts, health: 6 }, foodless(), {}), true)
    assert.equal(goal.stepWhy('castle', facts, foodless(), {}, ''), 'castle: eating first (low health, no food)')
  })

  it('castlefetch: low + foodless infeasible even with demand short', () => {
    // Unloaded site + a torch word: demand recomputes torch-none short.
    const F = goal.MENU.castlefetch.feasible
    const facts = { time: 'day', castle: 'torch-none', pickaxe: 1, health: 5, food: 10 }
    const ctx = () => ({ castle: castleState(), castleWord: { kind: 'torch', left: 3 } })
    assert.equal(F({ ...facts, health: 20 }, foodless(), ctx()), true, 'setup: healthy fetches')
    assert.equal(F(facts, foodless(), ctx()), false, 'low + foodless holds')
    assert.equal(F(facts, fed(), ctx()), true, 'food re-opens')
    assert.equal(goal.stepWhy('castlefetch', facts, foodless(), ctx(), ''), 'castlefetch: eating first (low health, no food)')
  })

  it('an unreadable pack reads fed (fail open to the old behaviour)', () => {
    const blind = goalBot({ health: 5, food: 10 })
    blind.inventory = { items: () => { throw new Error('no pack') } }
    assert.equal(goal.MENU.castle.feasible({ time: 'day', castle: 'stone-batch', health: 5, food: 10 }, blind, {}), true)
  })
})

describe('vmzq.49 health gate: the menu picks forage/rest, not castle work', () => {
  // Hand facts + the real menu: the gate flips the pick with every other
  // word standing. Torch word: gather's castle-chain branch skips torch
  // (it wants coal, not logs), so forage is the honest next step.
  function facts(over) {
    return {
      time: 'day', logs: 0, planks: 0, maxPlanks: 0, table: 1, door: 1,
      sword: 1, pickaxe: 1, pickWord: 'stone', cobble: 0, sticks: 0, coal: 0, charcoal: 0,
      torches: 0, scaffold: 32, home: 'built', unlit: 0, tablePlaced: false, inside: 'no',
      health: 5, food: 10, known: 'near', haul: 'none', player: 'none', chest: 'yes',
      chestTodo: 'none', surplus: 'no', chestParked: false, gearHandover: 'none', gear: 'done',
      beds: 'both', castle: 'torch-none', rearm: false, ...over,
    }
  }
  function ctx() {
    // Latch the ladder out (its want announces once, like the memCtx precedent).
    return { castle: castleState(), castleWord: { kind: 'torch', left: 3 }, gear: { saidNeed: 'want-logs' } }
  }
  function names(f, bot, c) {
    return goal.STEP_ORDER.filter((n) => {
      try { return goal.MENU[n].feasible(f, bot, c) && goal.registered(n) } catch (_) { return false }
    })
  }

  it('low + foodless + known-near: forage (healthy: the fetch)', () => {
    const f = facts()
    const lowMenu = names(f, goalBot({ items: [], health: 5 }), ctx())
    assert.ok(!lowMenu.includes('castle') && !lowMenu.includes('castlefetch'), lowMenu.join(','))
    assert.equal(goal.goalFsm(f, lowMenu), 'forage')
    const healthyMenu = names(facts({ health: 20 }), goalBot({ items: [] }), ctx())
    assert.equal(goal.goalFsm(facts({ health: 20 }), healthyMenu), 'castlefetch')
  })

  it('low + foodless + nothing known + blocked: rest', () => {
    const f = facts({ known: 'none', castle: 'blocked' })
    const c = { castle: castleState(), castleWord: { word: 'blocked' }, gear: { saidNeed: 'want-logs' } }
    const menu = names(f, goalBot({ items: [], health: 5 }), c)
    assert.ok(!menu.includes('castle') && !menu.includes('castlefetch'), menu.join(','))
    assert.ok(!menu.includes('explore'), `blocked must veto explore: ${menu.join(',')}`)
    assert.equal(goal.goalFsm(f, menu), 'rest')
  })

  it('decide: low + foodless + known-near forages with real facts', async () => {
    await quietAsync(async () => {
      const bot = goalBot({
        items: [{ name: 'stone_pickaxe', count: 1 }, { name: 'stone_sword', count: 1 }, { name: 'dirt', count: 32 }],
        health: 5, food: 10,
      })
      const c = {
        home: { built: true, chest: { x: 5, y: 64, z: 1 } },
        castle: castleState(),
        castleWord: { kind: 'torch', left: 3 },
        gear: { saidNeed: 'want-logs' }, // latch the ladder out (goal.test.js memCtx precedent)
      }
      resources.noteSpots(c, [{ x: 5, y: 60, z: 0, name: 'iron_ore' }], 1000)
      const f = goal.goalFacts(bot, c)
      assert.equal(f.known, 'near')
      assert.match(goal.goalText(f, c.home), /health=low food=ok/)
      const d = await goal.decide(bot, c)
      assert.equal(d.action, 'forage')
    })
  })
})

describe('vmzq.49 retreat hysteresis: latch and release bands', () => {
  function fieldBot({ items = [], entities = {}, health = 20 } = {}) {
    return {
      username: 'IdkBot',
      players: {},
      entities,
      health,
      food: 20,
      entity: { position: pos(0.5, 64, 0.5) },
      inventory: { items: () => items },
      blockAt(p) {
        const solid = Math.floor(p.y) <= 63
        return { name: solid ? 'dirt' : 'air', boundingBox: solid ? 'block' : 'empty' }
      },
      pathfinder: { goal: null, setGoal() {}, stop() {}, isMoving: () => false, setMovements() {} },
      setControlState() {},
      clearControlStates() {},
      chat() {},
    }
  }
  const zombie = (id, x, y, z) => ({ id, name: 'zombie', type: 'mob', position: pos(x, y, z), isValid: true })
  const stubBrain = {}

  it('a fresh pick latches the leg', async () => {
    const bot = fieldBot({ entities: { 1: zombie(1, 2, 64, 0) }, health: 3 })
    const ctx = { stepStatus: null }
    const r = await retreatMod.chooseRetreat(stubBrain, bot, ctx, { bot_health: 3, hostile_distance: 1.5, nearby_hostiles: 1 })
    assert.equal(r.action, 'retreat')
    assert.equal(ctx.retreatLatch.action, 'retreat')
    assert.ok(ctx.retreatLatch.until > Date.now())
  })

  it('a healthy pick does not latch (0ay fresh-hurt gating stands)', async () => {
    const bot = fieldBot({ entities: { 1: zombie(1, 2, 64, 0) }, health: 20 })
    const ctx = {}
    const r = await retreatMod.chooseRetreat(stubBrain, bot, ctx, { bot_health: 20, hostile_distance: 1.5 })
    assert.equal(r.action, 'retreat')
    assert.equal(ctx.retreatLatch, undefined)
  })

  it('holds without asking while latched, drains past the last sighting', async () => {
    const bot = fieldBot({ entities: { 1: zombie(1, 2, 64, 0) }, health: 3 })
    const ctx = {}
    const throwing = { source: 'x', ask: async () => { throw new Error('must not ask') } }
    await retreatMod.chooseRetreat(stubBrain, bot, ctx, { bot_health: 3, hostile_distance: 1.5 })
    const firstUntil = ctx.retreatLatch.until
    assert.ok(firstUntil > Date.now())
    // Hostile gone (retreat() would done): the latch still answers, no ask.
    ctx.retreat = null
    const held = await retreatMod.chooseRetreat(throwing, bot, ctx, { bot_health: 3 })
    assert.equal(held.action, 'retreat')
    assert.equal(held.source, 'retreat-hold')
    assert.equal(ctx.retreatLatch.until, firstUntil, 'drains: no refresh without a sighting')
    // A live sighting refreshes the hold.
    const again = await retreatMod.chooseRetreat(throwing, bot, ctx, { bot_health: 3, hostile_distance: 5 })
    assert.equal(again.action, 'retreat')
    assert.ok(ctx.retreatLatch.until >= firstUntil, 'a sighting extends the hold')
  })

  it('holds N ticks after hostile within 6, then releases', () => {
    const t0 = 2000000
    const ctx = {}
    retreatMod.latchRetreat(ctx, 'retreat', t0)
    assert.equal(retreatMod.RETREAT_HOLD_MS, 5000)
    for (const dt of [0, 1000, 4000, 4999]) {
      assert.equal(retreatMod.latchedAction(ctx, t0 + dt), 'retreat', `+${dt}ms`)
      assert.equal(retreatMod.retreatLatched(ctx, t0 + dt), true, `+${dt}ms`)
    }
    assert.equal(retreatMod.latchedAction(ctx, t0 + 5000), null)
    assert.equal(retreatMod.retreatLatched(ctx, t0 + 5000), false)
  })

  it('expiry returns to the normal flow (no hold source)', async () => {
    const bot = fieldBot({ entities: { 1: zombie(1, 2, 64, 0) }, health: 3 })
    const ctx = {}
    await retreatMod.chooseRetreat(stubBrain, bot, ctx, { bot_health: 3, hostile_distance: 1.5 })
    ctx.retreat = null // a goal tick took the body meanwhile
    ctx.retreatLatch.until = Date.now() - 1 // expired
    const r = await retreatMod.chooseRetreat(stubBrain, bot, ctx, { bot_health: 3, hostile_distance: 1.5 })
    assert.equal(r.action, 'retreat')
    assert.ok(r.source !== 'retreat-hold', r.source)
  })

  it('a failed leg clears the latch (re-ask, never hold)', async () => {
    // Single option: the failed pick re-picks fresh (new latch), never held.
    const bot = fieldBot({ entities: { 1: zombie(1, 2, 64, 0) }, health: 3 })
    const ctx = { retreat: { action: 'retreat' }, stepStatus: 'failed:retreat-no-path' }
    retreatMod.latchRetreat(ctx, 'retreat', Date.now() - 6000) // a stale hold
    const staleUntil = ctx.retreatLatch.until
    const r = await retreatMod.chooseRetreat(stubBrain, bot, ctx, { bot_health: 3, hostile_distance: 1.5 })
    assert.equal(r.action, 'retreat')
    assert.equal(r.source, 'only-option')
    assert.ok(ctx.retreatLatch.until > staleUntil, 'a fresh pick latches fresh')
    // Empty menu: nothing to re-pick — the latch stays cleared.
    const walled = fieldBot({ entities: { 1: zombie(1, 2, 64, 0) }, health: 3 })
    walled.blockAt = (p) => {
      const fx = Math.floor(p.x)
      const fy = Math.floor(p.y)
      const fz = Math.floor(p.z)
      const wall = (Math.abs(fx) === 1 && fz === 0) || (fx === 0 && Math.abs(fz) === 1)
      const solid = fy <= 63 || (wall && (fy === 64 || fy === 65))
      return { name: solid ? 'dirt' : 'air', boundingBox: solid ? 'block' : 'empty' }
    }
    const wctx = { retreat: { action: 'retreat' }, stepStatus: 'failed:retreat-no-path' }
    retreatMod.latchRetreat(wctx, 'retreat')
    const none = await retreatMod.chooseRetreat(stubBrain, walled, wctx, { bot_health: 3, hostile_distance: 1.5 })
    assert.equal(none, null)
    assert.equal(wctx.retreatLatch, null)
  })

  it('release bands: hp>=8 and nothing within 10 clears, margins hold', () => {
    assert.equal(retreatMod.RETREAT_RELEASE_HP, 8)
    assert.equal(retreatMod.RETREAT_RELEASE_DIST, 10)
    const clear = fieldBot({})
    assert.equal(retreatMod.retreatClear(clear, { bot_health: 20 }), true)
    assert.equal(retreatMod.retreatClear(clear, { bot_health: 8 }), true)
    assert.equal(retreatMod.retreatClear(clear, { bot_health: 7 }), false, 'hp margin holds')
    const near = fieldBot({ entities: { 1: zombie(1, 9, 64, 0) } })
    assert.equal(retreatMod.retreatClear(near, { bot_health: 20 }), false, 'radius margin holds')
    const far = fieldBot({ entities: { 1: zombie(1, 11, 64, 0) } })
    assert.equal(retreatMod.retreatClear(far, { bot_health: 20 }), true)
    assert.equal(retreatMod.retreatClear(fieldBot({}), {}), false, 'blind ticks hold (fail closed)')
  })
})

describe('vmzq.49 retreat hysteresis: decide holds and releases', () => {
  function decideBot({ health = 5, entities = {} } = {}) {
    return goalBot({ items: [], health, food: 10, entities })
  }

  it('a latched running leg re-issues instead of re-deciding', async () => {
    await quietAsync(async () => {
      const bot = decideBot({ entities: { 1: { id: 1, name: 'zombie', type: 'mob', position: pos(2, 64, 0), isValid: true } } })
      const ctx = { step: 'retreat', stepStatus: 'running', retreat: { action: 'retreat', source: 'only-option' }, work: true }
      retreatMod.latchRetreat(ctx, 'retreat')
      const d = await goal.decide(bot, ctx)
      assert.equal(d.action, 'retreat')
      assert.equal(ctx.stepStatus, 'running')
    })
  })

  it('a latched done leg re-issues while draining (no instant castle flip)', async () => {
    await quietAsync(async () => {
      const bot = decideBot()
      const ctx = { step: 'retreat', stepStatus: 'done', retreat: { action: 'retreat', source: 'only-option' }, work: true }
      retreatMod.latchRetreat(ctx, 'retreat')
      const d = await goal.decide(bot, ctx)
      assert.equal(d.action, 'retreat')
    })
  })

  it('expiry hands the tick back to the menu', async () => {
    await quietAsync(async () => {
      const bot = decideBot()
      const ctx = { step: 'retreat', stepStatus: 'running', retreat: { action: 'retreat', source: 'only-option' }, work: true }
      retreatMod.latchRetreat(ctx, 'retreat', Date.now() - 6000)
      const d = await goal.decide(bot, ctx)
      assert.ok(d.action !== 'retreat', d.action)
      assert.ok(goal.STEP_ORDER.includes(d.action), d.action)
    })
  })

  it('a clear tick releases at once (the 1tj property)', async () => {
    await quietAsync(async () => {
      const bot = decideBot({ health: 20 })
      const ctx = { step: 'retreat', stepStatus: 'running', retreat: { action: 'retreat', source: 'only-option' }, work: true }
      retreatMod.latchRetreat(ctx, 'retreat')
      const d = await goal.decide(bot, ctx)
      assert.ok(d.action !== 'retreat', d.action)
      assert.equal(ctx.retreatLatch, null)
    })
  })

  it('a failed leg clears the latch and falls through', async () => {
    await quietAsync(async () => {
      const bot = decideBot()
      const ctx = { step: 'retreat', stepStatus: 'failed:retreat-no-path', retreat: { action: 'retreat' }, work: true }
      retreatMod.latchRetreat(ctx, 'retreat')
      const d = await goal.decide(bot, ctx)
      assert.equal(ctx.retreatLatch, null)
      assert.ok(d.action !== 'retreat', d.action)
    })
  })
})
