'use strict'

// Owner 2026-11-18: chests are shared. Any step that needs an item draws it
// from any known chest (own, home, peer) first, whatever the castle/home state.

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const gather = require('../src/behaviours/gather')
const goal = require('../src/goal')
const chestStock = require('../src/cheststock')

const pos = (x, y, z) => ({ x, y, z })
const stack = (name, count) => ({ name, count })
function makeBot(items = []) {
  return {
    entity: { position: pos(0, 64, 0) },
    inventory: { items: () => items },
    registry: { itemsByName: { oak_log: {}, oak_planks: {} } },
    blockAt: (p) => ({ name: 'dirt', position: p }),
    pathfinder: { setGoal() {}, stop() {} },
  }
}
const logChest = { x: 9, y: 64, z: 0, contents: { oak_log: 200 }, at: 1 }

describe('shared chests: every need withdraws first', () => {
  it('build needs planks (unbuilt house, chests stocked): gather stays on and draws a chest', () => {
    const bot = makeBot([stack('oak_planks', 12)])
    const ctx = { home: goal.siteFor(bot, pos(0, 64, 0)), chests: [logChest] }
    assert.equal(goal.MENU.gather.feasible({ logs: 0, planks: 12, table: 1, door: 1, home: 'site' }, bot, ctx), true)
    const g = {}
    assert.equal(gather.chestLogsTick(bot, ctx, g, 0, pos(0, 64, 0)), true)
    assert.equal(g.chestLogs.k, '9,64,0')
  })

  it('craft needs logs at a built home with a kit packed: draws, home chest included', () => {
    const bot = makeBot([stack('oak_planks', 20), stack('wooden_pickaxe', 1)])
    const home = { site: pos(0, 64, 0), built: true, chest: pos(2, 64, 0) }
    const ctx = { home, chests: [logChest] }
    const g = {}
    assert.equal(gather.chestLogsTick(bot, ctx, g, 2, pos(0, 64, 0)), true)
    assert.equal(g.chestLogs.k, '2,64,0', 'the nearest chest, the home one, is no longer off limits')
  })

  it('tool: a peer chest serves with no home and no castle', () => {
    const peer = { x: 30, y: 64, z: 0, contents: { iron_ingot: 9 }, at: 1 }
    assert.equal(chestStock.anyChestWith({ peerChests: [peer] }, ['iron_ingot'], 3), peer)
  })

  it('food: a remembered chest with bread is picked with no home and no castle', () => {
    const bot = makeBot()
    const ctx = { chests: [{ x: 5, y: 64, z: 0, contents: { bread: 8 }, at: Date.now() }] }
    const t = require('../src/behaviours/food-recovery').normalFoodChest(bot, ctx)
    assert.ok(t, 'a food chest is picked')
  })
})
