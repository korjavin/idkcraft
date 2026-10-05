'use strict'

// safeCraft room guarantee (idkcraft-rwuu): a full pack tosses the craft
// product (mineflayer putSelectedItemRange -> tossLeftover) while the op
// still resolves, so every craft first ensures room for the result — chest
// near home first (the stockpile bank path), else one junk stack tossed,
// else an honest 'inventory-full' instead of a phantom craft.
const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const craft = require('../src/behaviours/craft')

const IDS = {
  stone_pickaxe: 274, stick: 280, leaf_litter: 1001, gravel: 1002, dirt: 3,
  cobblestone: 4, oak_sapling: 1003, wheat_seeds: 1004, bow: 1005, arrow: 1006,
}
const STACK = { stone_pickaxe: 1, bow: 1 }

function roomBot({ stacks = [], craftImpl = null, tossImpl = null, blockAtImpl = null, openChestImpl = null, at = { x: 0, y: 64, z: 0 } } = {}) {
  const calls = { craft: [], toss: [], deposit: [], openChest: 0 }
  const itemsByName = {}
  const items = {}
  for (const [name, id] of Object.entries(IDS)) {
    itemsByName[name] = { id }
    items[id] = { name, stackSize: STACK[name] || 64 }
  }
  const bot = {
    _items: stacks.map((s) => ({ ...s })),
    calls,
    entity: { position: at },
    registry: { itemsByName, items },
    inventory: { items: () => bot._items },
    craft: craftImpl || (async (recipe, count, table) => { calls.craft.push({ recipe, count, table }) }),
    toss: tossImpl || (async (id, meta, n) => {
      calls.toss.push({ id, n })
      let left = n
      for (const it of bot._items) {
        if (left <= 0) break
        if (it.type !== id) continue
        const take = Math.min(it.count, left)
        it.count -= take
        left -= take
      }
      bot._items = bot._items.filter((it) => it.count > 0)
    }),
    blockAt: blockAtImpl || (() => null),
  }
  if (openChestImpl) {
    bot.openChest = async (block) => {
      calls.openChest++
      return openChestImpl(block)
    }
  }
  return bot
}

const stack = (name, count) => ({ name, count, type: IDS[name] })
// Prod-shaped recipe: result plus per-placement ingredients (placementsFor
// counts each entry once — the stone pickaxe takes 3 cobble + 2 sticks).
const prodRecipe = (name, count = 1, ingredients = []) => ({ result: { id: IDS[name], count }, inShape: [], ingredients })
const PICK_INGREDIENTS = [
  { id: IDS.cobblestone }, { id: IDS.cobblestone }, { id: IDS.cobblestone },
  { id: IDS.stick }, { id: IDS.stick },
]

function fullPack() {
  // 36/36: the prod shape — junk stacks plus the stone-pickaxe materials
  // in partial stacks (an exact stack would free its own slot, core-1).
  const stacks = []
  for (let i = 0; i < 20; i++) stacks.push(stack('leaf_litter', 64))
  for (let i = 0; i < 13; i++) stacks.push(stack('gravel', 64))
  stacks.push(stack('cobblestone', 41), stack('stick', 5), stack('dirt', 64))
  assert.equal(stacks.length, 36)
  return stacks
}

function fullPackNoJunk() {
  // 36/36 with nothing tossable and no exact stack: tools, mats and
  // scaffold only, every ingredient stack partial.
  const stacks = []
  for (let i = 0; i < 32; i++) stacks.push(stack('dirt', 64))
  stacks.push(stack('cobblestone', 41), stack('stick', 5), stack('dirt', 64), stack('dirt', 64))
  assert.equal(stacks.length, 36)
  return stacks
}

function fullPackExact() {
  // 36/36, no junk, but exact material stacks: the cobble and stick slots
  // free during the op, so the craft fits without tossing (core-1).
  const stacks = []
  for (let i = 0; i < 34; i++) stacks.push(stack('dirt', 64))
  stacks.push(stack('cobblestone', 3), stack('stick', 2))
  assert.equal(stacks.length, 36)
  return stacks
}

describe('safeCraft room guarantee (idkcraft-rwuu)', () => {
  it('room available: crafts without tossing', async () => {
    const bot = roomBot({ stacks: [stack('cobblestone', 3), stack('stick', 2)] })
    await craft.safeCraft(bot, prodRecipe('stone_pickaxe', 1, PICK_INGREDIENTS), 1, null, { item: 'stone_pickaxe' })
    assert.equal(bot.calls.craft.length, 1)
    assert.deepEqual(bot.calls.toss, [])
  })

  it('stackable result with room: a full pack still crafts, nothing tossed', async () => {
    const stacks = []
    for (let i = 0; i < 35; i++) stacks.push(stack('dirt', 64))
    stacks.push(stack('stick', 4)) // room for 60 more
    const bot = roomBot({ stacks })
    await craft.safeCraft(bot, prodRecipe('stick', 4), 1, null, { item: 'stick' })
    assert.equal(bot.calls.craft.length, 1)
    assert.deepEqual(bot.calls.toss, [])
  })

  it('full pack with junk: tosses the cheapest junk first, then crafts', async () => {
    const bot = roomBot({ stacks: fullPack() })
    await craft.safeCraft(bot, prodRecipe('stone_pickaxe', 1, PICK_INGREDIENTS), 1, null, { item: 'stone_pickaxe' })
    assert.equal(bot.calls.craft.length, 1)
    assert.equal(bot.calls.toss.length, 1)
    assert.equal(bot.calls.toss[0].id, IDS.leaf_litter)
    assert.equal(bot.calls.toss[0].n, 64)
    assert.equal(bot._items.length, 35)
    assert.ok(bot._items.some((i) => i.name === 'cobblestone'), 'materials kept')
    assert.ok(bot._items.some((i) => i.name === 'stick'), 'materials kept')
  })

  it('full pack without junk: fails inventory-full, crafts nothing', async () => {
    const bot = roomBot({ stacks: fullPackNoJunk() })
    await assert.rejects(
      craft.safeCraft(bot, prodRecipe('stone_pickaxe', 1, PICK_INGREDIENTS), 1, null, { item: 'stone_pickaxe' }),
      /inventory-full/,
    )
    assert.equal(bot.calls.craft.length, 0)
    assert.deepEqual(bot.calls.toss, [])
  })

  it('spare bow tosses, the first bow stays', async () => {
    const stacks = [stack('bow', 1), stack('bow', 1)]
    for (let i = 0; i < 34; i++) stacks.push(stack('dirt', 64))
    const bot = roomBot({ stacks })
    await craft.safeCraft(bot, prodRecipe('stone_pickaxe', 1, PICK_INGREDIENTS), 1, null, { item: 'stone_pickaxe' })
    assert.equal(bot.calls.craft.length, 1)
    assert.equal(bot.calls.toss.length, 1)
    assert.equal(bot.calls.toss[0].id, IDS.bow)
    assert.equal(bot._items.filter((i) => i.name === 'bow').length, 1)
  })

  it('chest near home banks first: crafts with no toss', async () => {
    const bot = roomBot({
      stacks: fullPack(),
      blockAtImpl: () => ({ name: 'chest' }),
      openChestImpl: () => ({
        deposit: async (type, meta, n) => {
          bot.calls.deposit.push({ type, n })
          let left = n
          for (const it of bot._items) {
            if (left <= 0) break
            if (it.type !== type) continue
            const take = Math.min(it.count, left)
            it.count -= take
            left -= take
          }
          bot._items = bot._items.filter((it) => it.count > 0)
        },
        close: () => {},
      }),
    })
    const ctx = { home: { chest: { x: 1, y: 64, z: 0 } } }
    await craft.safeCraft(bot, prodRecipe('stone_pickaxe', 1, PICK_INGREDIENTS), 1, null, { ctx, item: 'stone_pickaxe' })
    assert.equal(bot.calls.craft.length, 1)
    assert.deepEqual(bot.calls.toss, [])
    assert.ok(bot.calls.deposit.length > 0, 'junk banked')
    assert.ok(bot.calls.deposit.every((d) => d.type === IDS.leaf_litter || d.type === IDS.gravel))
  })

  it('chest far from home: never opened, junk tossed instead', async () => {
    const bot = roomBot({
      stacks: fullPack(),
      blockAtImpl: () => ({ name: 'chest' }),
      openChestImpl: () => { throw new Error('must not open a far chest') },
    })
    const ctx = { home: { chest: { x: 200, y: 64, z: 200 } } }
    await craft.safeCraft(bot, prodRecipe('stone_pickaxe', 1, PICK_INGREDIENTS), 1, null, { ctx, item: 'stone_pickaxe' })
    assert.equal(bot.calls.craft.length, 1)
    assert.equal(bot.calls.openChest, 0)
    assert.equal(bot.calls.toss.length, 1)
  })

  it('exact material stacks free their slots: full pack crafts, nothing tossed', async () => {
    const bot = roomBot({ stacks: fullPackExact() })
    await craft.safeCraft(bot, prodRecipe('stone_pickaxe', 1, PICK_INGREDIENTS), 1, null, { item: 'stone_pickaxe' })
    assert.equal(bot.calls.craft.length, 1)
    assert.deepEqual(bot.calls.toss, [])
  })

  it('chest bank keeps the first bow and the first arrow stack', async () => {
    const stacks = [stack('bow', 1), stack('bow', 1), stack('arrow', 64), stack('arrow', 64)]
    for (let i = 0; i < 30; i++) stacks.push(stack('leaf_litter', 64))
    stacks.push(stack('cobblestone', 41), stack('stick', 5))
    assert.equal(stacks.length, 36)
    const bot = roomBot({
      stacks,
      blockAtImpl: () => ({ name: 'chest' }),
      openChestImpl: () => ({
        deposit: async (type, meta, n) => {
          bot.calls.deposit.push({ type, n })
          let left = n
          for (const it of bot._items) {
            if (left <= 0) break
            if (it.type !== type) continue
            const take = Math.min(it.count, left)
            it.count -= take
            left -= take
          }
          bot._items = bot._items.filter((it) => it.count > 0)
        },
        close: () => {},
      }),
    })
    const ctx = { home: { chest: { x: 1, y: 64, z: 0 } } }
    await craft.safeCraft(bot, prodRecipe('stone_pickaxe', 1, PICK_INGREDIENTS), 1, null, { ctx, item: 'stone_pickaxe' })
    assert.equal(bot.calls.craft.length, 1)
    assert.deepEqual(bot.calls.toss, [])
    assert.equal(bot._items.filter((i) => i.name === 'bow').length, 1)
    assert.equal(bot._items.filter((i) => i.name === 'arrow').length, 1)
    const bankedBow = bot.calls.deposit.find((d) => d.type === IDS.bow)
    assert.equal(bankedBow && bankedBow.n, 1)
  })
})
