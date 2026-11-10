'use strict'

// Wood-starved routing (idkcraft-woodstarve, owner 2026-11-10: no bans on
// chopping). Gather runs below the stock cap whatever the park/home state;
// once gather is out (held after failing here) explore opens past a park.

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const goal = require('../src/goal')
const { MENU, NEED_LOGS } = goal

const bot = { entity: { position: { x: 0, y: 64, z: 0 } }, players: {} }
const starved = (over) => ({ time: 'day', player: 'none', health: 20, logs: 0, planks: 0, maxPlanks: 0, table: 0, door: 1, beds: 'both', home: 'site', castle: 'none', ...over })
const site = { x: 0, y: 64, z: 0 }
// gather ran here and failed with no trees.
const failed = { final: 'failed:no-trees', atLogs: 0, failPos: { x: 0, y: 64, z: 0 } }
const g = (facts, ctx) => MENU.gather.feasible(facts, bot, ctx)
const e = (facts, ctx) => MENU.explore.feasible(facts, bot, ctx)
const brain = { source: 'x', ask: async () => { throw new Error('must not ask') } }
// The real chooser over the real feasibility of the wood-relevant steps.
async function pick(facts, ctx) {
  const menu = ['gather', 'explore', 'rest'].filter((n) => MENU[n].feasible(facts, bot, ctx))
  return (await goal.chooseStep(brain, facts, menu, ctx.home)).step
}

describe('woodstarve: gather has no park/home bans, only the cap', () => {
  it('(c1) parked house -> gather picked', async () => {
    const ctx = { home: { site, built: false, parked: true } }
    assert.equal(g(starved(), ctx), true)
    assert.equal(await pick(starved(), ctx), 'gather')
  })
  it('(c2) parked castle task -> gather picked (unbuilt and built)', async () => {
    assert.equal(await pick(starved(), { home: { site, built: false }, castle: { parked: true } }), 'gather')
    assert.equal(await pick(starved({ home: 'built' }), { home: { site, built: true }, castle: { parked: true } }), 'gather')
  })
  it('built home below the cap -> gather picked', async () => {
    assert.equal(await pick(starved({ home: 'built', planks: 10 }), { home: { site, built: true } }), 'gather')
  })
  it('(b) refilled above the cap -> gather not offered (no endless chop)', () => {
    const built = { home: { site, built: true } }
    assert.equal(g(starved({ home: 'built', planks: NEED_LOGS * 4 }), built), false)
    assert.equal(g(starved({ home: 'built', logs: NEED_LOGS }), built), false)
    const unbuilt = { home: { site, built: false, parked: true } }
    assert.equal(g(starved({ planks: goal.needPlanks(unbuilt.home) + 10 }), unbuilt), false)
  })
  it('night + hurt -> no chop', () => {
    assert.equal(g(starved({ time: 'night', health: 3 }), { home: { site, built: false } }), false)
  })
})

describe('woodstarve: explore once gather is out', () => {
  it('(1)/(a) home=site, house parked, gather failed here -> explore picked', async () => {
    const ctx = { home: { site, built: false, parked: true }, gather: failed }
    assert.equal(g(starved(), ctx), false)
    assert.equal(e(starved(), ctx), true)
    assert.equal(await pick(starved(), ctx), 'explore')
  })
  it('a remembered (stale/far) log does not veto explore', async () => {
    const items = new Map([['a', { name: 'oak_log', x: 900, y: 64, z: 900 }]])
    const ctx = { home: { site, built: false, parked: true }, gather: failed, resources: { items } }
    assert.equal(await pick(starved(), ctx), 'explore')
  })
  it('(2) home=built, task parked, wood-starved, gather failed -> explore picked', async () => {
    const ctx = { home: { site, built: true }, castle: { parked: true }, gather: failed }
    assert.equal(await pick(starved({ home: 'built', planks: 3 }), ctx), 'explore')
  })
  it('(3) logs on hand -> the park still vetoes explore', () => {
    assert.equal(e(starved({ logs: 2 }), { home: { site, built: false, parked: true }, gather: { ...failed, atLogs: 2 } }), false)
    assert.equal(e(starved({ home: 'built', logs: 2 }), { home: { site, built: true }, castle: { parked: true } }), false)
  })
  it('(4) night -> not feasible', () => {
    assert.equal(e(starved({ time: 'night' }), { home: { site, built: false, parked: true }, gather: failed }), false)
    assert.equal(e(starved({ time: 'night', home: 'built' }), { home: { site, built: true }, castle: { parked: true } }), false)
  })
  it('(5) player online with no house site -> not feasible', () => {
    assert.equal(e(starved({ player: 'Owner', home: 'none' }), { gather: failed }), false)
  })
})
