'use strict'

// Parked contract (owner 2026-10-26, follow-up o95q): the gear menu never
// fires — menuPlan returns null, so decide() never picks gear and stepWhy
// names the park. This file keeps the ipn.7 handoff shape (a finished step
// must hand off, never re-issue) with gear replaced by the park: after a
// stockpile done, decide moves on; new mats never re-arm gear; the only
// gear behaviour left is the untouched ladder core (see gear.test.js).

const { describe, it, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const { MENU, goalFacts, decide } = require('../src/goal')
const gear = require('../src/behaviours/gear')

function pos(x, y, z) {
  return { x, y, z }
}

// Built home, adopted chest, sticks on hand, nothing else: the menu used to
// offer gear here (want-ore rung for the self pickaxe); parked, it must not.
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

describe('idkcraft-ipn.7 parked: gear never picks, yields elsewhere', () => {
  let origLog
  beforeEach(() => {
    origLog = console.log
    console.log = () => {}
  })
  afterEach(() => { console.log = origLog })

  it('gear stays parked after stockpile done: decide moves on, stepWhy names the park', async () => {
    const bot = handoffBot()
    const ctx = handoffCtx()
    const first = await decide(bot, ctx)
    assert.notEqual(first.action, 'gear', 'parked: the menu never picks gear')
    const facts = goalFacts(bot, ctx)
    assert.equal(facts.gear, 'done', 'parked: the gear fact never arms the menu')
    assert.equal(MENU.gear.feasible(facts, bot, ctx), false)
    const why = require('../src/goal').stepWhy('gear', facts, bot, ctx, '')
    assert.match(why, /parked/, `stepWhy names the park, got=${JSON.stringify(why)}`)
    const second = await decide(bot, ctx)
    assert.notEqual(second.action, 'gear', 'still parked on the next pick')
  })

  it('new mats never re-arm gear: no hold, no pick, menu stays shut', async () => {
    const bot = handoffBot()
    const ctx = handoffCtx()
    await decide(bot, ctx)
    assert.notEqual(ctx.step, 'gear')

    bot.inventory = { items: () => [{ name: 'stick', count: 2 }, { name: 'raw_iron', count: 1 }] }
    const third = await decide(bot, ctx)
    assert.notEqual(third.action, 'gear', 'new want (want-ore mats) never re-arms gear')
    assert.ok(!ctx.stepFail || !ctx.stepFail.gear, 'no hold recorded for a parked step')

    bot.inventory = { items: () => [{ name: 'stick', count: 2 }, { name: 'iron_ingot', count: 3 }] }
    const fourth = await decide(bot, ctx)
    assert.notEqual(fourth.action, 'gear', 'ready mats never re-arm gear either')
  })
})
