'use strict'
// Prod bot3 2026-11-17: armed, one skeleton 1.6 (foodRecovery) / zombie 2.0
// (shelter perch), died without a committed fight. Engage + sword + fight end log.
const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const fight = require('../src/behaviours/fight')

function pos(x, y, z) {
  return { x, y, z, distanceTo: (q) => Math.hypot(x - q.x, y - q.y, z - q.z), offset: (a, b, c) => pos(x + a, y + b, z + c) }
}
function mkBot({ items = [{ name: 'stone_sword' }], held = null } = {}) {
  const equips = []
  const mob = { id: 7, name: 'skeleton', position: pos(1.6, 64, 0), height: 2, isValid: true }
  return {
    equips,
    health: 5,
    heldItem: held,
    entity: { position: pos(0, 64, 0) },
    entities: { 7: mob },
    inventory: { items: () => items, slots: [] },
    equip: async (i, d) => { equips.push(`${i.name}:${d}`) },
    blockAt: () => ({ name: 'stone' }),
    lookAt () {},
    attack () {},
  }
}
const st = (bot, extra = {}) => ({ hostile: bot.entities[7], hostile_distance: 1.6, nearby_hostiles: 1, bot_health: 5, ...extra })

describe('engage: one hostile in reach while armed, any step, any hp', () => {
  it('engages a single skeleton at 1.6 with a sword, even at 5 hp and on a shelter perch', () => {
    const bot = mkBot()
    assert.equal(fight.engageNow(bot, {}, st(bot)), true)
    assert.equal(fight.engageNow(bot, { inShelter: true, shelter: { perched: true } }, st(bot)), true)
    assert.equal(fight.engageNow(bot, {}, st(bot, { hostile_reachable: false })), true) // in swing reach
  })
  it('holds off unarmed, in a crowd, out of range, or dug in', () => {
    const bot = mkBot()
    assert.equal(fight.engageNow(mkBot({ items: [] }), {}, st(mkBot())), false)
    assert.equal(fight.engageNow(bot, {}, st(bot, { nearby_hostiles: 2 })), false)
    assert.equal(fight.engageNow(bot, {}, st(bot, { hostile_distance: 6 })), false)
    assert.equal(fight.engageNow(bot, { inShelter: true, shelter: { dugIn: true } }, st(bot)), false)
  })
  it('a swing with food in hand equips the sword first', async () => {
    const bot = mkBot({ held: { name: 'cooked_beef' } })
    fight.swing(bot, bot.entities[7])
    await fight.equipGear(bot)
    assert.ok(bot.equips.includes('stone_sword:hand'))
  })
})

describe('fight end line', () => {
  it('won when the mob is gone, fled when far, died on death', () => {
    const lines = []
    const orig = console.log
    console.log = (l) => lines.push(l)
    try {
      const bot = mkBot()
      const ctx = {}
      fight.trackFight(bot, ctx, bot.entities[7])
      assert.equal(fight.checkFight(bot, ctx), null)
      delete bot.entities[7]
      assert.equal(fight.checkFight(bot, ctx), 'won')
      const bot2 = mkBot()
      fight.trackFight(bot2, ctx, bot2.entities[7])
      bot2.entities[7].position = pos(30, 64, 0)
      assert.equal(fight.checkFight(bot2, ctx), 'fled')
      fight.trackFight(bot2, ctx, bot2.entities[7])
      assert.equal(fight.endFight(bot2, ctx, 'died'), 'died')
    } finally { console.log = orig }
    assert.match(lines[0], /^fight end mob=skeleton result=won hp=5\.0 /)
    assert.match(lines[2], /result=died/)
  })
})

// prod 2026-11-20: won at 5.8 hp, re-engaged at 3.3, died; bots worked unarmored.
describe('low hp disengage + armor', () => {
  it('below 6 hp only an adjacent mob is engaged', () => {
    const bot = mkBot()
    assert.equal(fight.engageNow(bot, {}, st(bot, { hostile_distance: 3.5 })), false)
    bot.health = 12
    assert.equal(fight.engageNow(bot, {}, st(bot, { hostile_distance: 3.5 })), true)
  })
  it('wears the best pack piece per slot and upgrades a worse worn one', async () => {
    const bot = mkBot({ items: [{ name: 'leather_helmet' }, { name: 'iron_helmet' }, { name: 'iron_boots' }] })
    bot.registry = { itemsByName: { leather_helmet: { maxDurability: 55 }, iron_helmet: { maxDurability: 165 }, golden_boots: { maxDurability: 91 }, iron_boots: { maxDurability: 195 } } }
    bot.inventory.slots[8] = { name: 'golden_boots' }
    assert.equal(fight.wearArmor(bot), true)
    await fight.equipGear(bot)
    assert.ok(bot.equips.includes('iron_helmet:head'))
    assert.ok(bot.equips.includes('iron_boots:feet'))
    assert.ok(!bot.equips.includes('leather_helmet:head'))
  })
  it('armorCraftable names the best piece the pack makes for an empty slot', () => {
    const bot = mkBot({ items: [{ name: 'iron_ingot', count: 5 }] })
    bot.registry = { itemsByName: { leather_helmet: { maxDurability: 55 }, iron_helmet: { maxDurability: 165 } }, itemsArray: [{ id: 1, name: 'leather_helmet' }, { id: 2, name: 'iron_helmet' }, { id: 3, name: 'iron_chestplate' }] }
    bot.recipesFor = (id) => id === 2 ? [{}] : []
    assert.equal(fight.armorCraftable(bot), 'iron_helmet')
    bot.inventory.slots[5] = { name: 'iron_helmet' }
    assert.equal(fight.armorCraftable(bot), null)
  })
})
