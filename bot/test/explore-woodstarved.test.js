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
  it('banked wood in the home chest counts toward the cap (no bank/gather loop)', () => {
    const chest = { x: 1, y: 64, z: 1 }
    const banked = { home: { site, built: true, chest }, chestLast: { home: { contents: { oak_planks: 40, oak_log: 4 }, at: Date.now() } } }
    assert.equal(g(starved({ home: 'built', planks: 4 }), banked), false, '4 packed + 56 banked = cap')
    const light = { home: { site, built: true, chest }, chestLast: { home: { contents: { oak_planks: 8 }, at: Date.now() } } }
    assert.equal(g(starved({ home: 'built', planks: 4 }), light), true, 'below the cap still chops')
  })
  it('core-3: parked house with a full 14-log load -> gather not re-picked', () => {
    assert.equal(g(starved({ logs: NEED_LOGS }), { home: { site, built: false, parked: true } }), false)
  })
  it('core-1: a stale home-chest snapshot counts nothing (chop resumes)', () => {
    const chest = { x: 1, y: 64, z: 1 }
    const stale = { home: { site, built: true, chest }, chestLast: { home: { contents: { oak_planks: 64 }, at: Date.now() - 31 * 60 * 1000 } } }
    assert.equal(g(starved({ home: 'built', planks: 4 }), stale), true)
  })
  it('core-1: built, wood banked, empty pack -> gather not chosen, no chop loop', async () => {
    const chest = { x: 1, y: 64, z: 1 }
    const ctx = { home: { site, built: true, chest }, chestLast: { home: { contents: { oak_planks: 60 }, at: Date.now() } } }
    assert.equal(g(starved({ home: 'built', table: 1 }), ctx), false)
    assert.notEqual(await pick(starved({ home: 'built', table: 1 }), ctx), 'gather')
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
  it('a standing table but no wood, parked, gather failed -> explore picked (site and built)', async () => {
    const site1 = { home: { site, built: false, parked: true }, gather: failed }
    assert.equal(await pick(starved({ table: 1 }), site1), 'explore')
    const built = { home: { site, built: true }, castle: { parked: true }, gather: failed }
    assert.equal(await pick(starved({ table: 1, home: 'built' }), built), 'explore')
  })
  it('core-2: parked built bot with planks 9..55 is not starved -> no explore; starved without a failed gather -> no explore', async () => {
    const parked = { home: { site, built: true }, castle: { parked: true }, gather: failed }
    assert.equal(e(starved({ home: 'built', planks: 60 }), parked), false)
    assert.equal(e(starved({ home: 'built', planks: 20 }), parked), false)
    assert.equal(e(starved({ home: 'built' }), { home: { site, built: true }, castle: { parked: true } }), false)
    assert.equal(e(starved({ home: 'built' }), parked), true)
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

describe('woodstarve: a stale home-chest read is refreshed (read-only) before any chop', () => {
  const gatherMod = require('../src/behaviours/gather')
  const Vec3 = require('vec3')
  const chest = new Vec3(1, 64, 1)
  function fakeBot(chestItems, log) {
    return {
      entity: { position: new Vec3(1, 64, 2) },
      players: {},
      inventory: { items: () => [] },
      pathfinder: { setGoal: () => {} },
      blockAt: (p) => (p.x === 1 && p.y === 64 && p.z === 1 ? { name: 'chest', position: p } : { name: 'air', position: p }),
      openChest: async () => ({
        containerItems: () => chestItems,
        withdraw: async () => { log.push('withdraw') },
        close: async () => {},
      }),
    }
  }
  const tick = () => new Promise((r) => setImmediate(r))
  async function run(chestItems) {
    const log = []
    const b = fakeBot(chestItems, log)
    const ctx = { home: { site, built: true, chest }, chestLast: { home: { contents: { oak_planks: 64 }, at: Date.now() - 31 * 60 * 1000 } } }
    gatherMod(b, ctx, null, {})
    for (let k = 0; k < 5 && !ctx.stepStatus; k++) { await tick(); gatherMod(b, ctx, null, {}) } // the runner stops at the first step status
    return { ctx, log }
  }
  it('full chest: the home read refreshes, the step ends done before any chop, nothing drawn', async () => {
    const { ctx, log } = await run([{ name: 'oak_planks', count: 64 }])
    assert.ok(Date.now() - ctx.chestLast.home.at < 5000, 'home read refreshed')
    assert.equal(ctx.stepStatus, 'done')
    assert.deepEqual(log, [], 'read-only: no withdraw')
    assert.equal(ctx.gather.pos, null, 'no tree targeted')
  })
  it('emptied chest: refreshed read is low, gather goes on to chop (no stale-high trust)', async () => {
    const { ctx, log } = await run([])
    assert.ok(Date.now() - ctx.chestLast.home.at < 5000)
    assert.notEqual(ctx.stepStatus, 'done')
    assert.deepEqual(log, [])
  })
})
