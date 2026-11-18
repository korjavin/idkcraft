'use strict'

// Food recovery produces food once every known chest is dry: no chest re-walk
// for the dry window; wheat beats rotten flesh in a chest; a failed withdraw
// keeps what came out.
const { it } = require('node:test')
const assert = require('node:assert/strict')
const Vec3 = require('vec3')
const { BaritoneBot } = require('../src/bridge')
const { FakeTransport } = require('../src/bridge/transport')
const goal = require('../src/goal')
const stockpile = require('../src/behaviours/stockpile')

const registry = { blocksByName: { air: { id: 0 } }, entitiesByName: {} }

async function decide(extra) {
  const prev = process.env.BOT_BODY
  process.env.BOT_BODY = 'baritone'
  const bot = new BaritoneBot(new FakeTransport({ health: 10, food: 0, inventory: [{ slot: 11, name: 'dirt', count: 3 }], entities: [] }), { Vec3, registry, username: 'IdkBody' })
  await bot.start({ pollMs: 0 })
  try {
    const ctx = { home: { site: { x: 0, y: 64, z: 0 } }, gear: { saidNeed: 'want-logs' }, stepStatus: 'running', chestSearchRetryAt: Date.now() + 3600000, chests: [{ x: 20, y: 64, z: 0 }], ...extra }
    return (await goal.decide(bot, ctx)).action
  } finally {
    await bot.stop()
    if (prev === undefined) delete process.env.BOT_BODY
    else process.env.BOT_BODY = prev
  }
}

it('an unread chest is a food source; dry chests (no prey, no crop) are not re-walked', async () => {
  assert.equal(await decide({}), 'foodRecovery')
  assert.notEqual(await decide({ foodChestDryUntil: Date.now() + 60000 }), 'foodRecovery')
})

function chestBot(stacks, failAt = Infinity) {
  let n = 0
  const window = {
    containerItems: () => stacks,
    withdraw: async () => { if (++n > failAt) throw new Error('full') },
    close: async () => {},
  }
  return {
    inventory: { items: () => [] },
    blockAt: () => ({ name: 'chest' }),
    openChest: async () => window,
  }
}

it('wheat is drawn before rotten flesh (3 per bread); a failed withdraw keeps the partial draw', async () => {
  const wants = (n) => n === 'rotten_flesh' || n === 'wheat'
  const stacks = [{ name: 'rotten_flesh', count: 9, type: 1 }, { name: 'wheat', count: 2, type: 2 }, { name: 'wheat', count: 5, type: 2 }]
  const at = { x: 1, y: 64, z: 1 }
  const ok = await stockpile.withdrawEdible(chestBot(stacks), {}, 1, at, () => true, wants)
  assert.deepEqual([ok.name, ok.got, ok.outcome], ['wheat', 3, 'withdrawn'])
  const part = await stockpile.withdrawEdible(chestBot(stacks, 1), {}, 1, at, () => true, wants)
  assert.deepEqual([part.name, part.got, part.outcome], ['wheat', 2, 'withdrawn'])
  const fail = await stockpile.withdrawEdible(chestBot(stacks, 0), {}, 1, at, () => true, wants)
  assert.deepEqual([fail.got, fail.outcome, fail.why], [0, 'error', 'full'])
})
