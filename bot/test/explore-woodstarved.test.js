'use strict'

// Wood-starved explore (idkcraft-woodstarve): no logs, planks short, no
// table, no remembered tree -> explore opens by day past a parked house/task.

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const { MENU } = require('../src/goal')

const bot = { entity: { position: { x: 0, y: 64, z: 0 } }, players: {} }
const feasible = (facts, ctx) => MENU.explore.feasible(facts, bot, ctx)
const starved = (over) => ({ time: 'day', player: 'none', logs: 0, planks: 0, table: 0, home: 'site', castle: 'none', ...over })
const site = { x: 0, y: 64, z: 0 }
// gather ran here and failed with no trees (gather is no longer park-vetoed).
const failed = { final: 'failed:no-trees', atLogs: 0, failPos: { x: 0, y: 64, z: 0 } }

describe('explore wood-starved', () => {
  it('(1) home=site, no wood, no tree, house parked, day -> feasible', () => {
    assert.equal(feasible(starved(), { home: { site, built: false, parked: true }, gather: failed, resources: { items: new Map() } }), true)
  })
  it('(2) home=built, task parked, wood-starved, day -> feasible', () => {
    assert.equal(feasible(starved({ home: 'built', planks: 3 }), { home: { site, built: true }, castle: { parked: true } }), true)
  })
  it('(3) logs present -> parked still vetoes', () => {
    assert.equal(feasible(starved({ logs: 0 }), { home: { site, built: false, parked: true }, gather: { ...failed } }), true)
    assert.equal(feasible(starved({ logs: 2 }), { home: { site, built: false, parked: true }, gather: { ...failed, atLogs: 2 } }), false)
    assert.equal(feasible(starved({ home: 'built', logs: 2 }), { home: { site, built: true }, castle: { parked: true } }), false)
  })
  it('remembered tree -> parked still vetoes', () => {
    const items = new Map([['a', { name: 'oak_log', x: 10, y: 64, z: 10 }]])
    assert.equal(feasible(starved(), { home: { site, built: false, parked: true }, gather: failed, resources: { items } }), false)
  })
  it('(4) night -> not feasible', () => {
    assert.equal(feasible(starved({ time: 'night' }), { home: { site, built: false, parked: true } }), false)
    assert.equal(feasible(starved({ time: 'night', home: 'built' }), { home: { site, built: true }, castle: { parked: true } }), false)
  })
  it('(5) player online with no house site -> not feasible', () => {
    assert.equal(feasible(starved({ player: 'Owner', home: 'none' }), {}), false)
  })
})

describe('gather: no chopping bans (owner 2026-11-10)', () => {
  const goal = require('../src/goal')
  const g = (facts, ctx) => MENU.gather.feasible(facts, bot, ctx)
  it('(c1) parked house -> gather feasible', () => {
    assert.equal(g(starved(), { home: { site, built: false, parked: true } }), true)
  })
  it('(c2) parked castle task, unbuilt home -> gather feasible', () => {
    assert.equal(g(starved(), { home: { site, built: false }, castle: { parked: true } }), true)
  })
  it('built home keeps its gate (routing rests on it); explore is the release', () => {
    assert.equal(g(starved({ home: 'built', beds: 'two', maxPlanks: 0 }), { home: { site, built: true }, castle: { parked: true } }), false)
  })
  it('(b) refilled above the cap -> gather not offered (no endless chop)', () => {
    const ctx = { home: { site, built: false, parked: true } }
    assert.equal(g(starved({ planks: goal.needPlanks(ctx.home) + 10 }), ctx), false)
    assert.equal(g(starved({ planks: goal.needPlanks(ctx.home) + 10, table: 1, door: 1 }), ctx), false)
  })
  it('night + hurt -> no chop', () => {
    assert.equal(g(starved({ time: 'night', health: 3 }), { home: { site, built: false } }), false)
  })
  it('(a) no known tree, gather out (held after failing) -> explore feasible and chosen', async () => {
    const facts = starved()
    const ctx = { home: { site, built: false, parked: true }, gather: failed, resources: { items: new Map() } }
    assert.equal(MENU.gather.feasible(facts, bot, ctx), false) // held after its failure here
    assert.equal(feasible(facts, ctx), true)
    const brain = { source: 'x', ask: async () => { throw new Error('must not ask') } }
    const choice = await goal.chooseStep(brain, facts, ['explore', 'rest'], null)
    assert.equal(choice.step, 'explore')
  })
})
