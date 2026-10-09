'use strict'

// Bead idkcraft-vmzq.61: prod 2026-10-09 picked beds ~100 times in 3 h, each
// failing cant-reach-bed at the same unreachable hut, because the generic
// failHolds is keyed on the facts text and that drifts every minute. The beds
// step now holds a reach/place failure on home / bed inventory / time: 10 min,
// 20 min, then latched until the home changes.

const { describe, it, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const goal = require('../src/goal')
const beds = require('../src/behaviours/beds')

const FACTS = { time: 'day', home: 'built', beds: 'none' }
const MIN = 60 * 1000

function pos(x, y, z) {
  return { x, y, z, distanceTo: (q) => Math.hypot(x - q.x, y - q.y, z - q.z) }
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

// Two white beds in the pack, far from the bedrooms, never moving: every
// place walk stalls into failed:cant-reach-bed.
function stuckBot() {
  const items = [{ name: 'white_bed', count: 1 }, { name: 'white_bed', count: 1 }]
  return {
    items,
    username: 'IdkBot',
    players: {},
    entities: {},
    time: { timeOfDay: 6000, day: 5 },
    spawnPoint: pos(0, 64, 0),
    entity: { position: pos(100, 65, 100) },
    inventory: { items: () => items },
    registry: { blocksByName: {}, itemsByName: {} },
    pathfinder: { setGoal: () => {}, isMoving: () => false },
    blockAt: () => ({ name: 'stone' }),
    chat: () => {},
  }
}

// One beds step run to its end, as decide would pick it.
function runPick(bot, ctx) {
  ctx.stepStatus = null
  ctx.lastGoalKey = null
  for (let i = 0; i < 100 && !ctx.stepStatus; i++) beds(bot, ctx)
  return ctx.stepStatus
}

describe('vmzq.61 beds reach/place hold', () => {
  let now = 0
  let realNow = null
  beforeEach(() => {
    realNow = Date.now
    now = 1_700_000_000_000
    Date.now = () => now
  })
  afterEach(() => { Date.now = realNow })

  function setup() {
    const bot = stuckBot()
    const ctx = { bot, home: v2home({ x: 10, y: 64, z: 20 }), beds: { phase: 'place', color: 'white' } }
    return { bot, ctx }
  }

  it('two cant-reach failures hold for the probe window although the facts text changes', () => {
    const { bot, ctx } = setup()
    const F = goal.MENU.beds.feasible
    assert.equal(F(FACTS, bot, ctx), true, 'free up front')
    assert.equal(runPick(bot, ctx), 'failed:cant-reach-bed')
    assert.equal(F(FACTS, bot, ctx), false, 'first failure holds 10 min')
    assert.match(goal.stepWhy('beds', FACTS, bot, ctx, 'known=near logs=few'), /^beds: bed unreachable, retry in \d+s$/)
    now += 10 * MIN
    assert.equal(F(FACTS, bot, ctx), true, 'probe after 10 min')
    assert.equal(runPick(bot, ctx), 'failed:cant-reach-bed')
    assert.equal(ctx.beds.placeHold.fails, 2)
    // The text-keyed failHolds releases on any text drift; this hold does not.
    ctx.stepFail = { beds: { status: 'failed:cant-reach-bed', text: 'known=near logs=few', pos: null } }
    assert.equal(goal.failHolds(ctx, 'beds', 'known=none logs=none', bot), false, 'text hold released by drift')
    now += 19 * MIN
    assert.equal(F(FACTS, bot, ctx), false, 'second window doubles to 20 min')
    now += 1 * MIN
    assert.equal(F(FACTS, bot, ctx), true)
  })

  it('a home site change releases the hold', () => {
    const { bot, ctx } = setup()
    runPick(bot, ctx)
    assert.equal(goal.MENU.beds.feasible(FACTS, bot, ctx), false)
    ctx.home = v2home({ x: 50, y: 64, z: 20 })
    assert.equal(goal.MENU.beds.feasible(FACTS, bot, ctx), true)
  })

  it('a bed count change releases the hold', () => {
    const { bot, ctx } = setup()
    runPick(bot, ctx)
    assert.equal(goal.MENU.beds.feasible(FACTS, bot, ctx), false)
    bot.items.pop()
    assert.equal(goal.MENU.beds.feasible(FACTS, bot, ctx), true)
    assert.equal(runPick(bot, ctx), 'failed:cant-reach-bed')
    assert.equal(ctx.beds.placeHold.fails, 1, 'a new inventory starts a fresh count')
  })

  it('three strikes latch until the home changes (time and bed count do not release)', () => {
    const { bot, ctx } = setup()
    runPick(bot, ctx)
    now += 10 * MIN
    runPick(bot, ctx)
    now += 20 * MIN
    runPick(bot, ctx)
    assert.equal(ctx.beds.placeHold.fails, 3)
    now += 24 * 60 * MIN
    bot.items.pop()
    assert.equal(goal.MENU.beds.feasible(FACTS, bot, ctx), false, 'latched')
    assert.equal(goal.stepWhy('beds', FACTS, bot, ctx, ''), 'beds: bed unreachable, latched until the home changes')
    ctx.home = v2home({ x: 10, y: 70, z: 20 })
    assert.equal(goal.MENU.beds.feasible(FACTS, bot, ctx), true, 'home change releases')
  })

  it('normal path: no failure, no hold; both beds in clears a record', () => {
    const { bot, ctx } = setup()
    assert.equal(beds.placeHeld(ctx, bot), null)
    assert.equal(beds.placeHeld(undefined, undefined), null)
    assert.equal(beds.placeHeld({ beds: { placeHold: 'x' } }, bot), null)
    ctx.beds.placeHold = { at: now, home: 'x', sig: 'y', fails: 1 }
    ctx.home.bedA = { x: 1, y: 1, z: 1 }
    ctx.home.bedB = { x: 2, y: 1, z: 2 }
    bot.blockAt = () => null // dark chunk trusts the claims: both beds stand
    beds(bot, ctx)
    assert.equal(ctx.stepStatus, 'done')
    assert.equal(ctx.beds.placeHold, undefined)
  })

  it('scenario: 30 minutes with an unreachable bed make at most 3 beds picks (was ~30)', () => {
    const { bot, ctx } = setup()
    let picks = 0
    for (let m = 0; m <= 30; m++) {
      if (goal.MENU.beds.feasible(FACTS, bot, ctx)) {
        picks++
        assert.equal(runPick(bot, ctx), 'failed:cant-reach-bed')
      }
      now += MIN
    }
    assert.ok(picks <= 3, `picks=${picks}`)
    assert.equal(beds.placeHeld(ctx, bot).latched, true)
  })
})
