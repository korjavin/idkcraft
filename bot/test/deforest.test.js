'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const Vec3 = require('vec3')
const { createTicker, handleChat } = require('../src/index')
const deforest = require('../src/behaviours/deforest')

function fixture() {
  const registry = {
    blocksByName: {
      oak_log: { name: 'oak_log', id: 1 },
      oak_leaves: { name: 'oak_leaves', id: 2 },
      chest: { name: 'chest', id: 3 },
    },
    itemsByName: {
      oak_log: { id: 1, stackSize: 64 },
      oak_planks: { id: 4, stackSize: 64 },
    },
  }
  const natural = [new Vec3(1, 64, 0), new Vec3(1, 65, 0)]
  const leaves = new Vec3(1, 66, 0)
  const built = new Vec3(4, 64, 0)
  const outside = [new Vec3(10, 64, 0), new Vec3(10, 65, 0)]
  const full = new Vec3(0, 64, 2)
  const chest = new Vec3(0, 64, 3)
  const blocks = new Map()
  const place = (pos, name) => blocks.set(String(pos), { position: pos, name, type: registry.blocksByName[name].id })
  for (const pos of [...natural, built, ...outside]) place(pos, 'oak_log')
  place(leaves, 'oak_leaves')
  place(new Vec3(10, 66, 0), 'oak_leaves')
  place(full, 'chest')
  place(chest, 'chest')
  const pack = { oak_log: 5, oak_planks: 12 }
  let stored = 0
  const opened = []
  const bot = {
    username: 'IdkBot2',
    entity: { position: new Vec3(0, 64, 0) },
    players: { Owner: { entity: { position: new Vec3(0, 64, 0) } } },
    chats: [],
    chat(line) { this.chats.push(line) },
    registry,
    pathfinder: { setGoal(goal) { this.goal = goal }, isMoving: () => false },
    inventory: {
      items: () => Object.entries(pack).filter(([, count]) => count > 0).map(([name, count]) => ({ name, count })),
      emptySlotCount: () => 34,
    },
    findBlocks: ({ matching }) => [...blocks.values()].filter(b => matching.includes(b.type)).map(b => b.position),
    blockAt: p => blocks.get(String(p)) || { position: p, name: 'air', boundingBox: 'empty' },
    canDigBlock: () => true,
    async dig(block) { blocks.delete(String(block.position)); pack.oak_log++ },
    recipesFor: () => [{ delta: [{ id: 1, count: -1 }, { id: 4, count: 4 }] }],
    async craft() { pack.oak_log--; pack.oak_planks += 4 },
    async openChest(block) {
      opened.push(block.position)
      let moved = 0
      return {
        slots: [block.position.equals(full) ? { type: 4, count: 64 } : null],
        inventoryStart: 1,
        async deposit(type, metadata, amount) {
          assert.equal(type, 4)
          assert.equal(metadata, null)
          moved += amount
        },
        close() {
          stored += moved
          pack.oak_planks -= moved
        },
      }
    },
  }
  return { bot, pack, built, outside, natural, opened, stored: () => stored }
}

test('deforest chat order clears the bounded trees and banks only the job planks', async () => {
  const { bot, pack, built, outside, natural, opened, stored } = fixture()
  const ticker = createTicker({ bot, brain: { decide: async () => ({ action: 'follow', source: 'stub' }) } })
  handleChat(bot, ticker, 'Owner', 'IdkBot2: deforest 8')
  const ctx = bot._tickerCtx
  assert.ok(ctx.deforest)
  bot.players.Owner.entity.position = new Vec3(10, 64, 0)
  for (let i = 0; i < 20 && ctx.deforest; i++) {
    const result = await ticker.tick()
    assert.equal(result.decision.action, 'deforest')
    await new Promise(resolve => setImmediate(resolve))
  }
  assert.equal(ctx.deforest, null)
  assert.equal(stored(), 8)
  assert.equal(opened.length, 2)
  assert.deepEqual(pack, { oak_log: 5, oak_planks: 12 })
  for (const p of natural) assert.equal(bot.blockAt(p).name, 'air')
  for (const p of [built, ...outside]) assert.equal(bot.blockAt(p).name, 'oak_log')
  assert.match(bot.chats.at(-1), /done.*cut 2, stored 8 planks/)
})

test('stop cancels deforest before its next action', () => {
  const { bot, natural } = fixture()
  const ticker = createTicker({ bot, brain: {} })
  handleChat(bot, ticker, 'Owner', 'deforest')
  assert.ok(bot._tickerCtx.deforest)
  handleChat(bot, ticker, 'Owner', 'stop')
  deforest.tick(bot, bot._tickerCtx, Date.now())
  assert.equal(bot._tickerCtx.deforest, null)
  assert.equal(bot.blockAt(natural[0]).name, 'oak_log')
})
