'use strict'

// Regression test (idkcraft-ipn.7): a gear yield must hand off, not re-issue.
//
// Prod (ipn.5 acceptance): gear picked with why=step-done announces its need
// ('need 3 more raw iron, going to dig'), yields done, and is then re-issued
// by the askedKey shortcut every tick — same text, same 'done' status —
// standing still 8-10 min (moving=false) until the facts change. The menu
// (with the gear said-latch) is never consulted.
//
// The fix: decide() skips the shortcut when the finished step is gear with
// done, forcing a fresh menu pick. Gear stays out via its said-latch until
// a new need arrives — a hold is deliberately NOT recorded (gear.js yields
// are 'never a hold': fetchers fix the shortfall, and text-invisible state
// such as a landed furnace slice must re-pick gear at once).
const { describe, it, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const { MENU, goalFacts, goalText, decide } = require('../src/goal')
const gear = require('../src/behaviours/gear')

function pos(x, y, z) {
  return { x, y, z }
}

// Built home, adopted chest, sticks on hand, nothing else: the menu offers
// gear (want-ore rung: iron pickaxe for self) above explore/rest only.
function handoffBot() {
  const chats = []
  return {
    chats,
    entity: { position: pos(0, 64, 0) },
    inventory: { items: () => [{ name: 'stick', count: 2 }] },
    time: { timeOfDay: 6000 },
    spawnPoint: pos(0, 64, 0),
    chat: (m) => { chats.push(m) },
  }
}

function handoffCtx() {
  return {
    home: { site: pos(10, 64, 10), built: true, chest: { x: 11, y: 64, z: 11 } },
    gear: { pantrySeen: 0 },
    gearPantryBanked: 0,
    step: 'stockpile',
    stepStatus: 'done',
  }
}

describe('idkcraft-ipn.7: gear yield hands off', () => {
  let origLog
  beforeEach(() => {
    origLog = console.log
    console.log = () => {}
  })
  afterEach(() => { console.log = origLog })

  it('gear picked after stockpile done, yields want-ore, next decide leaves gear', async () => {
    const bot = handoffBot()
    const ctx = handoffCtx()
    const first = await decide(bot, ctx)
    assert.equal(first.action, 'gear') // why=step-done pick, the prod shape
    assert.equal(ctx.stepStatus, 'running')
    const pickedText = ctx.goalText

    gear(bot, ctx) // the behaviour announces the need and yields done
    assert.equal(ctx.stepStatus, 'done')
    assert.equal(ctx.gear.saidNeed, 'want-ore')
    // ipn.9: the announce keeps the raw-iron want with or without a
    // diggable remembered cell ('going to dig' vs 'none known' — the exact
    // wording is gear.test.js's contract); this test pins the handoff.
    assert.ok(bot.chats.some((m) => m.includes('raw iron')), `announced, chats=${JSON.stringify(bot.chats)}`)

    const facts = goalFacts(bot, ctx)
    assert.equal(goalText(facts, ctx.home), pickedText, 'facts unchanged across the yield')
    assert.equal(MENU.gear.feasible(facts, bot, ctx), false, 'latched need reads infeasible')

    const second = await decide(bot, ctx)
    assert.notEqual(second.action, 'gear', 'the shortcut must not re-issue the yielded step')
    assert.equal(second.action, 'explore')
  })

  it('a new need re-picks gear at once: no hold is recorded for the yield', async () => {
    // want-ore -> want-coal flips no text bucket (ore/coal counts are not in
    // goalText, gear stays 'want'), so a done-hold would gag the re-announce
    // until the bot moves. The yield must leave no hold behind.
    const bot = handoffBot()
    const ctx = handoffCtx()
    await decide(bot, ctx)
    assert.equal(ctx.step, 'gear')
    gear(bot, ctx)
    assert.equal(ctx.stepStatus, 'done')

    bot.inventory = { items: () => [{ name: 'stick', count: 2 }, { name: 'raw_iron', count: 1 }] }
    const third = await decide(bot, ctx)
    assert.equal(third.action, 'gear', 'new need (want-coal) re-picks gear without waiting')
    assert.ok(!ctx.stepFail || !ctx.stepFail.gear, 'no hold recorded for a gear yield')
    gear(bot, ctx) // announces the coal need, latches it
    assert.equal(ctx.gear.saidNeed, 'want-coal')

    const fourth = await decide(bot, ctx)
    assert.equal(fourth.action, 'explore', 'latched coal need hands off again')
  })
})
