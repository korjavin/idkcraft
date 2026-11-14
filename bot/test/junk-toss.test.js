const test = require('node:test')
const assert = require('node:assert')
const { tossJunk, junkKeep } = require('../src/behaviours/stockpile')

function fakeBot(items) {
  const tossed = []
  return {
    tossed,
    inventory: { items: () => items },
    toss: (type, meta, count) => { tossed.push({ type, count }); return Promise.resolve() },
  }
}

test('junkKeep: plain junk tosses, keeps reserves, valuables are not junk', () => {
  assert.strictEqual(junkKeep('gravel'), 0)
  assert.strictEqual(junkKeep('oak_leaves'), 0)
  assert.strictEqual(junkKeep('dirt'), 32)
  assert.strictEqual(junkKeep('oak_sapling'), 8)
  assert.strictEqual(junkKeep('diamond'), null)
  assert.strictEqual(junkKeep('cobblestone'), null)
  assert.strictEqual(junkKeep('iron_pickaxe'), null)
})

test('tossJunk: one pass tosses every junk kind, faces away from the site, busy while in flight', async () => {
  const bot = fakeBot([{ name: 'dirt', type: 9, count: 50 }, { name: 'flint', type: 7, count: 4 }, { name: 'oak_leaves', type: 8, count: 1 }, { name: 'diamond', type: 1, count: 3 }])
  bot.entity = { position: { x: 10, y: 70, z: 0 }, yaw: 0 }
  bot.look = (yaw, pitch) => { bot.looked = { yaw, pitch }; return Promise.resolve() }
  assert.strictEqual(tossJunk(bot, { castle: { site: { x: 0, z: 0 } } }), true)
  assert.strictEqual(tossJunk(bot, {}), true) // in flight: wait, do not fail
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r))
  assert.deepStrictEqual(bot.tossed, [{ type: 9, count: 18 }, { type: 7, count: 4 }, { type: 8, count: 1 }])
  assert.ok(Math.abs(bot.looked.yaw - Math.atan2(-10, -0)) < 1e-9) // facing +x, away from the site
  assert.ok(bot.looked.pitch > 0)
})

test('tossJunk: nothing to toss returns false', () => {
  const bot = fakeBot([{ name: 'dirt', type: 9, count: 20 }, { name: 'cobblestone', type: 2, count: 64 }])
  assert.strictEqual(tossJunk(bot, {}), false)
  assert.deepStrictEqual(bot.tossed, [])
})

test('junkKeep: mining byproducts are junk only while a castle runs', () => {
  assert.strictEqual(junkKeep('cobbled_deepslate'), null)
  assert.strictEqual(junkKeep('cobbled_deepslate', { castle: { site: { x: 0, z: 0 } } }), 0)
  const bot = fakeBot([{ name: 'sand', type: 5, count: 64 }, { name: 'cobblestone', type: 2, count: 64 }])
  assert.strictEqual(tossJunk(bot, {}), false)
  assert.strictEqual(tossJunk(bot, { castle: {} }), true)
})
