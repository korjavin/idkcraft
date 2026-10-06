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

function roomBot({ stacks = [], craftImpl = null, tossImpl = null, tossStackImpl = null, clickWindowImpl = null, putBackImpl = null, blockAtImpl = null, openChestImpl = null, at = { x: 0, y: 64, z: 0 }, slots = null } = {}) {
  const calls = { craft: [], toss: [], tossStack: [], clickWindow: [], deposit: [], putBack: 0, openChest: 0 }
  const itemsByName = {}
  const items = {}
  for (const [name, id] of Object.entries(IDS)) {
    itemsByName[name] = { id }
    items[id] = { name, stackSize: STACK[name] || 64 }
  }
  const bot = {
    _items: stacks.map((s, i) => ({ slot: 9 + i, ...s })),
    _openWin: null,
    calls,
    entity: { position: at },
    registry: { itemsByName, items },
    inventory: { items: () => bot._items, selectedItem: null },
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
    _syncWindow: async () => {},
  }
  if (Array.isArray(slots)) bot.inventory.slots = slots
  if (tossStackImpl) bot.tossStack = tossStackImpl
  if (clickWindowImpl) bot.clickWindow = clickWindowImpl
  if (putBackImpl) bot.putSelectedItemRange = putBackImpl
  if (openChestImpl) {
    bot.openChest = async (block) => {
      calls.openChest++
      return openChestImpl(block)
    }
  }
  return bot
}

// Exact-slot tossStack: removes the stack at item.slot, cursor untouched.
function tossStackFake(bot) {
  return async (item) => {
    bot.calls.tossStack.push({ slot: item.slot, name: item.name })
    bot._items = bot._items.filter((i) => i.slot !== item.slot)
  }
}

// Cursor put-back: the held stack returns to the pack, cursor cleared.
function putBackFake(bot) {
  return async (start, end, window) => {
    bot.calls.putBack++
    const win = window || bot.inventory
    if (win.selectedItem) {
      bot._items.push({ ...win.selectedItem })
      win.selectedItem = null
    }
  }
}

// Chest window with transfer-shaped deposit: a pre-loaded cursor of the
// same type is placed first (never re-picked); a full chest picks up the
// first stack and throws 'destination full' with it on the cursor.
function chestWindow(bot, { full = false } = {}) {
  const win = {
    inventoryStart: 9, // identity translation with player coords
    inventoryEnd: 45,
    selectedItem: null,
    deposit: async (type, meta, n) => {
      bot.calls.deposit.push({ type, n })
      if (win.selectedItem && win.selectedItem.type === type) {
        const place = Math.min(n, win.selectedItem.count)
        if (full) throw new Error('destination full')
        win.selectedItem.count -= place
        n -= place
        if (win.selectedItem.count <= 0) win.selectedItem = null
      }
      if (n <= 0) return
      if (full) {
        if (win.selectedItem) {
          bot._items.push({ ...win.selectedItem })
          win.selectedItem = null
        }
        const stack = bot._items.find((i) => i.type === type)
        if (!stack) throw new Error('destination full')
        bot._items = bot._items.filter((i) => i !== stack)
        win.selectedItem = { ...stack }
        throw new Error('destination full')
      }
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
    close: () => { bot._openWin = null },
  }
  return win
}

// Exact pickup: slot contents move to the window cursor (swap-back first,
// the transfer shape); -999 drops the cursor.
function clickWindowFake(bot) {
  return async (slot, mouse, mode) => {
    bot.calls.clickWindow.push({ slot, mouse, mode })
    const win = bot._openWin || bot.inventory
    if (slot === -999) {
      win.selectedItem = null
      return
    }
    if (win.selectedItem) {
      bot._items.push({ ...win.selectedItem })
      win.selectedItem = null
    }
    const stack = bot._items.find((i) => i.slot === slot)
    if (!stack) throw new Error('no such slot')
    bot._items = bot._items.filter((i) => i !== stack)
    win.selectedItem = { ...stack }
  }
}

function chestBot(bot, opts = {}) {
  const win = chestWindow(bot, opts)
  const open = bot.openChest
  bot._chestWin = win
  bot.openChest = async (block) => {
    bot.calls.openChest++
    bot._openWin = win
    return win
  }
  return { win, open }
}

const stack = (name, count, extra = {}) => ({ name, count, type: IDS[name], ...extra })
// Prod-shaped recipe: result plus per-placement ingredients (placementsFor
// counts each entry once — the stone pickaxe takes 3 cobble + 2 sticks).
const prodRecipe = (name, count = 1, ingredients = []) => ({ result: { id: IDS[name], count }, inShape: [], ingredients })
const PICK_INGREDIENTS = [
  { id: IDS.cobblestone }, { id: IDS.cobblestone }, { id: IDS.cobblestone },
  { id: IDS.stick }, { id: IDS.stick },
]
const PICK = () => prodRecipe('stone_pickaxe', 1, PICK_INGREDIENTS)

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
    await craft.safeCraft(bot, PICK(), 1, null, { item: 'stone_pickaxe' })
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
    await craft.safeCraft(bot, PICK(), 1, null, { item: 'stone_pickaxe' })
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
      craft.safeCraft(bot, PICK(), 1, null, { item: 'stone_pickaxe' }),
      /inventory-full/,
    )
    assert.equal(bot.calls.craft.length, 0)
    assert.deepEqual(bot.calls.toss, [])
  })

  it('exact material stacks free their slots: full pack crafts, nothing tossed', async () => {
    const bot = roomBot({ stacks: fullPackExact() })
    await craft.safeCraft(bot, PICK(), 1, null, { item: 'stone_pickaxe' })
    assert.equal(bot.calls.craft.length, 1)
    assert.deepEqual(bot.calls.toss, [])
  })

  it('spare bow tosses by exact slot, the first bow stays', async () => {
    const stacks = [stack('bow', 1), stack('bow', 1)]
    for (let i = 0; i < 34; i++) stacks.push(stack('dirt', 64))
    const bot = roomBot({ stacks })
    bot.tossStack = tossStackFake(bot)
    await craft.safeCraft(bot, PICK(), 1, null, { item: 'stone_pickaxe' })
    assert.equal(bot.calls.craft.length, 1)
    assert.deepEqual(bot.calls.toss, [])
    assert.equal(bot.calls.tossStack.length, 1)
    assert.equal(bot.calls.tossStack[0].slot, 10) // the spare, not the kept first
    assert.equal(bot._items.filter((i) => i.name === 'bow').length, 1)
  })

  it('bow without an exact slot is kept, never type-tossed', async () => {
    const stacks = [stack('bow', 1), stack('bow', 1)]
    for (let i = 0; i < 34; i++) stacks.push(stack('dirt', 64))
    const bot = roomBot({ stacks }) // no tossStack: slot-less legacy path
    for (const s of bot._items) delete s.slot
    await assert.rejects(
      craft.safeCraft(bot, PICK(), 1, null, { item: 'stone_pickaxe' }),
      /inventory-full/,
    )
    assert.equal(bot.calls.craft.length, 0)
    assert.deepEqual(bot.calls.toss, [])
    assert.equal(bot._items.filter((i) => i.name === 'bow').length, 2)
  })

  it('toss keeps the enchanted bow, drops the plain spare by its slot', async () => {
    const stacks = [stack('bow', 1, { nbt: { Enchantments: [1] } }), stack('bow', 1)]
    for (let i = 0; i < 34; i++) stacks.push(stack('dirt', 64))
    const bot = roomBot({ stacks })
    bot.tossStack = tossStackFake(bot)
    await craft.safeCraft(bot, PICK(), 1, null, { item: 'stone_pickaxe' })
    assert.equal(bot.calls.craft.length, 1)
    assert.equal(bot.calls.tossStack.length, 1)
    assert.equal(bot.calls.tossStack[0].slot, 10) // the plain spare
    const kept = bot._items.filter((i) => i.name === 'bow')
    assert.equal(kept.length, 1)
    assert.ok(kept[0].nbt != null, 'the enchanted bow survives')
  })

  it('chest near home banks first: crafts with no toss', async () => {
    const bot = roomBot({ stacks: fullPack(), blockAtImpl: () => ({ name: 'chest' }) })
    bot.putSelectedItemRange = putBackFake(bot)
    chestBot(bot)
    const ctx = { home: { chest: { x: 1, y: 64, z: 0 } } }
    await craft.safeCraft(bot, PICK(), 1, null, { ctx, item: 'stone_pickaxe' })
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
    await craft.safeCraft(bot, PICK(), 1, null, { ctx, item: 'stone_pickaxe' })
    assert.equal(bot.calls.craft.length, 1)
    assert.equal(bot.calls.openChest, 0)
    assert.equal(bot.calls.toss.length, 1)
  })

  it('chest full strands the pickup on the cursor: returned, toss saves the craft', async () => {
    const bot = roomBot({ stacks: fullPack(), blockAtImpl: () => ({ name: 'chest' }) })
    bot.putSelectedItemRange = putBackFake(bot)
    const { win } = chestBot(bot, { full: true })
    const ctx = { home: { chest: { x: 1, y: 64, z: 0 } } }
    const leafBefore = bot._items.filter((i) => i.name === 'leaf_litter').reduce((a, i) => a + i.count, 0)
    await craft.safeCraft(bot, PICK(), 1, null, { ctx, item: 'stone_pickaxe' })
    assert.equal(win.selectedItem, null)
    assert.equal(bot.calls.craft.length, 1)
    assert.equal(bot.calls.toss.length, 1) // bank failed: the toss branch made room
    assert.equal(bot.calls.toss[0].id, IDS.leaf_litter)
    const leafAfter = bot._items.filter((i) => i.name === 'leaf_litter').reduce((a, i) => a + i.count, 0)
    assert.equal(leafAfter, leafBefore - 64) // one stack tossed, none lost to the cursor
    assert.ok(bot._items.some((i) => i.name === 'gravel'), 'unbanked junk stays packed')
  })

  it('chest bank keeps the enchanted bow, banks the exact spare', async () => {
    const stacks = [stack('bow', 1, { nbt: { Enchantments: [1] } }), stack('bow', 1)]
    for (let i = 0; i < 32; i++) stacks.push(stack('dirt', 64))
    stacks.push(stack('cobblestone', 41), stack('stick', 5))
    assert.equal(stacks.length, 36)
    const bot = roomBot({ stacks, blockAtImpl: () => ({ name: 'chest' }) })
    bot.putSelectedItemRange = putBackFake(bot)
    bot.clickWindow = clickWindowFake(bot)
    const { win } = chestBot(bot)
    const ctx = { home: { chest: { x: 1, y: 64, z: 0 } } }
    await craft.safeCraft(bot, PICK(), 1, null, { ctx, item: 'stone_pickaxe' })
    assert.equal(bot.calls.craft.length, 1)
    assert.deepEqual(bot.calls.toss, [])
    assert.equal(win.selectedItem, null)
    const kept = bot._items.filter((i) => i.name === 'bow')
    assert.equal(kept.length, 1)
    assert.ok(kept[0].nbt != null, 'the enchanted bow stays packed')
    assert.ok(bot.calls.clickWindow.some((c) => c.slot === 10), 'the plain spare was picked by its slot')
    const banked = bot.calls.deposit.find((d) => d.type === IDS.bow)
    assert.equal(banked && banked.n, 1)
  })

  it('a stranded toss cursor is dropped, never swapped', async () => {
    const bot = roomBot({ stacks: fullPack() })
    let stranded = false
    bot.tossStack = async (item) => {
      bot.calls.tossStack.push({ slot: item.slot, name: item.name })
      bot._items = bot._items.filter((i) => i.slot !== item.slot)
      if (!stranded) {
        stranded = true
        bot.inventory.selectedItem = { ...item } // desync: the drop click never applied
      }
    }
    bot.clickWindow = clickWindowFake(bot)
    await craft.safeCraft(bot, PICK(), 1, null, { item: 'stone_pickaxe' })
    assert.equal(bot.calls.craft.length, 1)
    assert.ok(bot.calls.clickWindow.some((c) => c.slot === -999), 'cursor drained')
    assert.equal(bot.inventory.selectedItem, null)
  })

  it('foreign cursor fails honestly instead of reading false room', async () => {
    const bot = roomBot({ stacks: fullPack() })
    bot.inventory.selectedItem = { name: 'leaf_litter', count: 64 }
    bot.putSelectedItemRange = async () => { bot.calls.putBack++ } // stuck: never clears
    await assert.rejects(
      craft.safeCraft(bot, PICK(), 1, null, { item: 'stone_pickaxe' }),
      /inventory-full/,
    )
    assert.equal(bot.calls.craft.length, 0)
    assert.deepEqual(bot.calls.toss, [])
  })

  it('a returned cursor heals: the craft proceeds', async () => {
    const bot = roomBot({ stacks: fullPack(), slots: [] })
    bot.inventory.selectedItem = { name: 'leaf_litter', count: 64, slot: 9 }
    bot.putSelectedItemRange = putBackFake(bot)
    await craft.safeCraft(bot, PICK(), 1, null, { item: 'stone_pickaxe' })
    assert.equal(bot.calls.craft.length, 1)
    assert.equal(bot.inventory.selectedItem, null)
  })
})
