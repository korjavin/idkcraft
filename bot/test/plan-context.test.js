'use strict'

// Plan context (owner 2026-11-18): a bot5-like stall (unbuilt house, few
// planks, stocked chest) carries every context section, under the cap.

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const { planState } = require('../src/task')
const { withContext, MAX_BYTES } = require('../src/plan-context')

function pos(x, y, z) {
  const p = { x, y, z, distanceTo: (q) => Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z), offset: (a, b, c) => pos(x + a, y + b, z + c), clone() { return pos(x, y, z) } }
  return p
}

function bot5() {
  const items = [{ name: 'oak_planks', count: 6 }, { name: 'stone_pickaxe', count: 1 }, { name: 'wooden_axe', count: 1 }, { name: 'bread', count: 5 }, { name: 'cobblestone', count: 40 }, { name: 'dirt', count: 12 }]
  const bot = {
    username: 'IdkBot5', entities: {}, health: 18, food: 15, time: { timeOfDay: 11500 },
    entity: { position: pos(100, 64, 100), onGround: true },
    registry: { blocksByName: {}, itemsByName: {} },
    players: {},
    pathfinder: { goal: null, setGoal: () => {}, isMoving: () => false },
    inventory: { items: () => items },
    blockAt: () => ({ name: 'grass_block', biome: { name: 'plains' }, boundingBox: 'block' }),
    chat() {},
  }
  const now = Date.now()
  const ctx = {
    home: { site: { x: 110, y: 64, z: 100 }, built: false, chest: { x: 112, y: 64, z: 100 } },
    chestLast: { home: { at: now - 4 * 60000, contents: { oak_planks: 128, oak_log: 10, cobblestone: 64, coal: 9 } } },
    peerChests: [{ x: 140, y: 64, z: 90, at: now - 20 * 60000, contents: { spruce_log: 32, wheat_seeds: 5 } }],
    resources: { items: new Map([
      ['118,65,96', { x: 118, y: 65, z: 96, name: 'oak_log' }],
      ['130,66,80', { x: 130, y: 66, z: 80, name: 'birch_log' }],
      ['90,60,110', { x: 90, y: 60, z: 110, name: 'coal_ore' }],
    ]) },
    step: 'gather',
    stepStatus: 'failed:no-trees',
    attempts: [{ step: 'gather', out: 'failed:no-trees' }, { step: 'explore', out: 'done' }],
  }
  return { bot, ctx }
}

describe('plan context', () => {
  it('bot5 stall request carries every section, under the size cap', () => {
    const { bot, ctx } = bot5()
    const state = { stallMs: 5 * 60000, fails: ['gather failed:no-trees'], wd: { history: [{ choice: 'gather-far', outcome: 'flat', ms: 60000 }] } }
    const criteria = { 'gather-far': 'chop trees past the home disk', 'castlefetch-far': 'withdraw from a remembered chest', 'explore-far': 'walk to unseen chunks' }
    const logs = []
    const orig = console.log
    console.log = (l) => logs.push(String(l))
    let req
    try {
      req = withContext(bot, ctx, 'house', 20, 130, state, { state: planState(bot, ctx, 'house', 20, 130, state, true), instructions: 'pick', criteria })
      withContext(bot, ctx, 'house', 20, 130, state, { state: {}, criteria })
    } finally { console.log = orig }
    if (process.env.PLAN_CONTEXT_DUMP) orig(JSON.stringify(req, null, 1))
    const c = req.state.context
    assert.match(c.goal.why, /shelter/)
    assert.equal(c.goal.cells_left, 110)
    assert.equal(c.goal.wood_short, 104)
    assert.equal(c.goal.wood_planks.chests, 128 + 40 + 128)
    assert.ok(c.res.includes('res wood pack=1 near=42 far=32@41m world=18m owe=28'), c.res.join(' / '))
    assert.ok(c.res.includes('res food pack=25 near=0 far=0 world=? owe=0'), c.res.join(' / '))
    assert.ok(c.res.includes('res coal pack=0 near=9 far=0 world=15m owe=0'), c.res.join(' / '))
    assert.match(c.pack.tools, /stone_pickaxe/)
    assert.match(c.pack.items, /cobblestone 40/)
    assert.match(c.chests[0], /^home 12m .*oak_planks 128/)
    assert.match(c.chests[1], /^peer /)
    assert.equal(c.terrain.biome, 'plains')
    assert.match(c.terrain.trees, /2 known, nearest 18m/)
    assert.match(c.vitals.time, /\w/)
    assert.equal(c.vitals.threats, 'none')
    assert.match(c.options['castlefetch-far'], /chest 12m holds oak_planks 128/)
    assert.match(c.options['gather-far'], /nearest tree 18m/)
    assert.equal(req.state.attempts.length, 2)
    assert.ok(Array.isArray(req.state.history))
    assert.ok(JSON.stringify(c).length <= MAX_BYTES)
    const total = JSON.stringify(req).length
    assert.ok(total <= 6000, `request ${total} bytes`)
    const ctxLogs = logs.filter((l) => l.startsWith('stall context goal=house bytes='))
    assert.equal(ctxLogs.length, 1, 'logged once per episode')
    assert.ok(ctxLogs[0].length < 2200)
  })
})
