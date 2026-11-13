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

test('tossJunk: tosses dirt beyond the keep, one toss in flight', async () => {
  const bot = fakeBot([{ name: 'dirt', type: 9, count: 50 }, { name: 'diamond', type: 1, count: 3 }])
  assert.strictEqual(tossJunk(bot, {}), true)
  assert.deepStrictEqual(bot.tossed, [{ type: 9, count: 18 }])
  assert.strictEqual(tossJunk(bot, {}), false) // in flight
  await new Promise((r) => setImmediate(r))
})

test('tossJunk: nothing to toss returns false', () => {
  const bot = fakeBot([{ name: 'dirt', type: 9, count: 20 }, { name: 'cobblestone', type: 2, count: 64 }])
  assert.strictEqual(tossJunk(bot, {}), false)
  assert.deepStrictEqual(bot.tossed, [])
})
