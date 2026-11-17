'use strict'

// Castle inventory pass: a castle home reads every chest in its box while
// resting, so stored items become known stock.

const { it } = require('node:test')
const assert = require('node:assert/strict')
const { Vec3 } = require('vec3')
const residence = require('../src/residence')
const rest = require('../src/behaviours/rest')

it('a castle home walks to an unread castle chest, opens it and remembers its contents', async () => {
  const home = residence.castleHome({ site: { x: 0, y: 64, z: 0 }, rot: 0, blueprintVersion: 2 })
  const chest = new Vec3(18, 64, 18)
  const bot = {
    entity: { position: new Vec3(5, 64, 5) },
    registry: { blocksByName: { chest: { id: 1 } } },
    findBlocks: () => [chest],
    blockAt: (p) => ({ name: p.x === 18 && p.y === 64 && p.z === 18 ? 'chest' : 'air', position: p }),
    pathfinder: { setGoal: () => {}, isMoving: () => true },
    openChest: async () => ({ containerItems: () => [{ name: 'white_wool', count: 20 }], close: async () => {} }),
  }
  const ctx = { home, lastGoalKey: null }
  rest(bot, ctx, null, {})
  assert.equal(ctx.lastGoalKey, 'rest-inventory:18,64,18')
  bot.entity.position = new Vec3(17, 64, 17)
  rest(bot, ctx, null, {})
  await new Promise((r) => setImmediate(r))
  await new Promise((r) => setImmediate(r))
  assert.equal(ctx.chests[0].contents.white_wool, 20)
  rest(bot, ctx, null, {})
  assert.notEqual(ctx.lastGoalKey, 'rest-inventory:18,64,18', 'read: the pass moves on')
})
