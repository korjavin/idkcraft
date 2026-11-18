'use strict'

// bot5 (2026-11-18): a parked, unbuilt house with few logs/planks and a
// held gather rested all day. A park must never leave only rest by day.

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const goal = require('../src/goal')

const site = { x: 0, y: 64, z: 0 }
const bot = { entity: { position: { x: 0, y: 64, z: 0 } }, players: {}, inventory: { items: () => [] } }
const facts = { time: 'day', player: 'none', health: 20, food: 20, logs: 3, planks: 5, maxPlanks: 5, table: 1, door: 1, beds: 'none', home: 'site', castle: 'none', inside: 'no', known: 'none', haul: 'none', chest: 'no', chestTodo: 'none' }

describe('parked house: menu keeps a productive step', () => {
  it('bot5 menu (parked, few wood, gather held, day) -> not rest', async () => {
    const ctx = { home: { site, built: false, parked: true }, gather: { final: 'failed:no-trees', atLogs: 3, failPos: { x: 0, y: 64, z: 0 } } }
    const text = goal.goalText(facts, ctx.home)
    const names = goal.menuNames(facts, bot, ctx, text)
    assert.ok(names.includes('explore'), `menu=${names}`)
    const choice = await goal.chooseStep({ source: 'x', ask: async () => { throw new Error('no ask') } }, facts, names, ctx.home)
    assert.notEqual(choice.step, 'rest')
  })
  it('parked house still crafts a full log load', () => {
    assert.equal(goal.MENU.craft.feasible({ ...facts, logs: goal.NEED_LOGS }, bot, { home: { site, built: false, parked: true } }), true)
  })
  it('night keeps rest', () => {
    const n = { ...facts, time: 'night' }
    assert.ok(!goal.menuNames(n, bot, { home: { site, built: false, parked: true } }, goal.goalText(n, null)).includes('explore'))
  })
})
