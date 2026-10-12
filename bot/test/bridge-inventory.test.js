// idkcraft-neuc.8: bridge inventory/equip/toss — FakeTransport fixtures run
// the REAL countItems/kitLine/fight.equipGear unchanged through the adapter.
// Run: `cd bot && npm test`.
'use strict'

const { describe, it, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert/strict')

const { BaritoneBot } = require('../src/bridge/index')
const { FakeTransport } = require('../src/bridge/transport')
const Vec3 = require('vec3')

const { countItems, wornItems } = require('../src/perception')
const { kitLine } = require('../src/index')
const fightMod = require('../src/behaviours/fight')
const { installEquipGuard } = require('../src/reflexes')

const registry = require('minecraft-data')('26.1.2')
const id = (name) => registry.itemsByName[name].id
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function invBot(inventory, selected = 0) {
  const transport = new FakeTransport({
    pos: { x: 0, y: 64, z: 0, yaw: 0, pitch: 0, onGround: true },
    inventory,
    selected,
  })
  const bot = new BaritoneBot(transport, { Vec3, registry, username: 'IdkBody' })
  return { transport, bot }
}

const KIT = () => [
  { slot: 9, name: 'iron_pickaxe', count: 1 },
  { slot: 10, name: 'cobblestone', count: 5 },
  { slot: 11, name: 'iron_sword', count: 1 },
  { slot: 12, name: 'iron_helmet', count: 1 },
  { slot: 13, name: 'bread', count: 3 },
  { slot: 36, name: 'dirt', count: 4 },
]

describe('bridge inventory fold (idkcraft-neuc.8)', () => {
  let transport
  let bot
  beforeEach(async () => {
    ({ transport, bot } = invBot(KIT()))
    await bot.start({ pollMs: 0 })
  })
  afterEach(async () => { await bot.stop() })

  it('window shape: slots 5-45, items() 9-44, count/empty/find like v1', () => {
    assert.equal(bot.inventory.inventoryStart, 9)
    assert.equal(bot.inventory.inventoryEnd, 45)
    assert.equal(bot.inventory.slots.length, 46)
    assert.equal(bot.inventory.slots[9].name, 'iron_pickaxe')
    assert.equal(bot.inventory.slots[9].type, id('iron_pickaxe'))
    assert.equal(bot.inventory.items().length, 6) // 5 main + dirt in hotbar; armor range empty
    assert.equal(bot.inventory.count(id('cobblestone')), 5)
    assert.equal(bot.inventory.emptySlotCount(), 36 - 6)
    assert.equal(bot.inventory.firstEmptyInventorySlot(), 37) // hotbar first
    assert.equal(bot.inventory.findInventoryItem('cobblestone').slot, 10)
    assert.equal(bot.inventory.findInventoryItem(id('bread')).count, 3)
    assert.equal(bot.inventory.findInventoryItem('netherite_sword'), null)
  })

  it('real countItems + kitLine read the adapter unchanged', () => {
    assert.equal(countItems(bot, (n) => n === 'cobblestone'), 5)
    assert.equal(countItems(bot, (n) => n.endsWith('_pickaxe')), 1)
    assert.equal(kitLine(bot), 'kit scaffold=9 pickaxe=yes sword=yes food=3')
  })

  it('heldItem follows the selected hotbar slot and inventory.select', async () => {
    assert.equal(bot.heldItem.name, 'dirt') // slot 36, selected 0
    bot.setQuickBarSlot(1)
    await sleep(20)
    assert.equal(transport.state.selected, 1)
    assert.equal(bot.quickBarSlot, 1)
    assert.equal(bot.heldItem, null) // slot 37 empty
    transport.inject('inventory.update', { slot: 37, item: { slot: 37, name: 'torch', count: 2 }, selected: 1 })
    assert.equal(bot.heldItem.name, 'torch')
    assert.equal(bot.heldItem.count, 2)
  })

  it('equip pickaxe to hand moves it to the selected hotbar slot', async () => {
    const pick = bot.inventory.findInventoryItem('iron_pickaxe')
    await bot.equip(pick, 'hand')
    assert.equal(bot.heldItem.name, 'iron_pickaxe')
    assert.equal(bot.inventory.slots[36].name, 'iron_pickaxe')
    assert.equal(bot.inventory.slots[9] && bot.inventory.slots[9].name, 'dirt') // swapped back
  })

  it('equip by numeric type and hotbar equip only selects', async () => {
    await bot.equip(id('bread'), 'hand')
    assert.equal(bot.heldItem.name, 'bread')
    transport.state.inventory.push({ slot: 38, name: 'torch', count: 2 })
    await bot.refresh()
    const torch = bot.inventory.findInventoryItem('torch')
    await bot.equip(torch, 'hand')
    assert.equal(bot.quickBarSlot, 2) // selected, not swapped into slot 36
    assert.equal(bot.heldItem.name, 'torch')
    assert.equal(bot.inventory.slots[36].name, 'bread')
  })

  it('real fight.equipGear equips sword + armor by suffix into slots 5-8', async () => {
    await fightMod.equipGear(bot)
    assert.equal(bot.heldItem.name, 'iron_sword')
    assert.equal(bot.inventory.slots[5].name, 'iron_helmet')
    assert.equal(wornItems(bot, 'iron_helmet'), 1)
    // Already geared: a second batch must not swap the helmet back out.
    await fightMod.equipGear(bot)
    assert.equal(bot.inventory.slots[5].name, 'iron_helmet')
  })

  it('unequip armor and hand', async () => {
    await bot.equip(bot.inventory.findInventoryItem('iron_helmet'), 'head')
    assert.equal(bot.inventory.slots[5].name, 'iron_helmet')
    await bot.unequip('head')
    assert.equal(bot.inventory.slots[5], null)
    assert.equal(countItems(bot, (n) => n === 'iron_helmet'), 1)
    await bot.equip(bot.inventory.findInventoryItem('iron_pickaxe'), 'hand')
    await bot.unequip('hand')
    assert.notEqual(bot.heldItem && bot.heldItem.name, 'iron_pickaxe')
  })

  it('toss by type reduces the count; tossStack drops the whole stack', async () => {
    await bot.toss(id('cobblestone'), null, 3)
    assert.equal(countItems(bot, (n) => n === 'cobblestone'), 2)
    const dirt = bot.inventory.slots[36]
    await bot.tossStack(dirt)
    assert.equal(countItems(bot, (n) => n === 'dirt'), 0)
    assert.equal(bot.heldItem, null)
    await assert.rejects(() => bot.toss(id('netherite_sword'), null, 1), /Can't find/)
  })

  it('equip errors mirror mineflayer and equip is defined before spawn', async () => {
    assert.equal(typeof bot.equip, 'function')
    await assert.rejects(() => bot.equip(null, 'hand'),
      /Invalid item object in equip \(item is null or typeof item is not object\)/)
    await assert.rejects(() => bot.equip(bot.inventory.slots[36], 'bogus'), /invalid destination: bogus/)
    // reflexes.installEquipGuard wraps bot.equip on spawn — it must wrap ours.
    const ctx = { eatInFlight: false }
    installEquipGuard(bot, ctx)
    assert.equal(bot._equipGuardInstalled, true)
    await bot.equip(bot.inventory.findInventoryItem('iron_pickaxe'), 'hand')
    assert.equal(bot.heldItem.name, 'iron_pickaxe')
  })

  it('prismarine-item fields: durability + enchants + custom name survive the wire', async () => {
    const { applyInventory } = require('../src/bridge/inventory')
    applyInventory(bot, {
      selected: 0,
      slots: [{ slot: 36, name: 'iron_pickaxe', count: 1, damage: 17, maxDamage: 250, enchantments: [{ name: 'minecraft:efficiency', level: 3 }], customName: 'Old Faithful' }],
    })
    const held = bot.heldItem
    assert.equal(held.name, 'iron_pickaxe')
    assert.equal(held.durabilityUsed, 17)
    assert.equal(held.maxDurability, 250)
    assert.deepEqual(held.enchants, [{ lvl: 3, name: 'efficiency' }]) // prismarine-item getter shape
    assert.equal(held.customName, 'Old Faithful')
    assert.equal(typeof held.type, 'number')
  })

  it('minimal-registry fallback still feeds countItems/findInventoryItem', async () => {
    const transport2 = new FakeTransport({
      pos: { x: 0, y: 64, z: 0, yaw: 0, pitch: 0, onGround: true },
      inventory: [{ slot: 36, name: 'cobblestone', count: 7, type: 35 }],
    })
    const bot2 = new BaritoneBot(transport2, { Vec3, registry: { blocksByName: {} }, username: 'IdkBody' })
    await bot2.start({ pollMs: 0 })
    try {
      assert.equal(countItems(bot2, (n) => n === 'cobblestone'), 7)
      assert.equal(bot2.inventory.findInventoryItem('cobblestone').count, 7)
      assert.equal(bot2.inventory.emptySlotCount(), 35)
      assert.equal(bot2.heldItem.name, 'cobblestone')
      await bot2.toss(35, null, 2)
      assert.equal(countItems(bot2, (n) => n === 'cobblestone'), 5)
    } finally {
      await bot2.stop()
    }
  })
})
