'use strict'

// safeCraft room guarantee (idkcraft-rwuu, no-toss since idkcraft-g0z.26): a
// full pack tosses the craft product (mineflayer putSelectedItemRange ->
// tossLeftover) while the op still resolves, so every craft first ensures
// room for the result — a chest in reach (the adopted home chest, else ANY
// nearby chest) banks the junk and the above-ceiling wood, else an honest
// 'inventory-full' instead of a phantom craft. The bot never throws anything
// away (owner 2026-10-06): the old 'no chest → toss junk' fallback is gone.
const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const craft = require('../src/behaviours/craft')

const IDS = {
  stone_pickaxe: 274, stick: 280, leaf_litter: 1001, gravel: 1002, dirt: 3,
  cobblestone: 4, oak_sapling: 1003, wheat_seeds: 1004, bow: 1005, arrow: 1006,
  oak_planks: 1007, oak_log: 1008,
}
const STACK = { stone_pickaxe: 1, bow: 1 }

function roomBot({ stacks = [], craftImpl = null, tossImpl = null, tossStackImpl = null, clickWindowImpl = null, putBackImpl = null, blockAtImpl = null, openChestImpl = null, findBlocksImpl = null, at = { x: 0, y: 64, z: 0 }, slots = null } = {}) {
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
    registry: { itemsByName, items, blocksByName: { chest: { id: 54 } } },
    inventory: { items: () => bot._items, selectedItem: null },
    findBlocks: findBlocksImpl || (() => []),
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

  it('full pack with junk and no chest: fails inventory-full, tosses nothing (g0z.26)', async () => {
    // Owner 2026-10-06: the bot never throws anything away — the old rwuu
    // 'no chest → toss junk' fallback is gone. The hold parks the step while
    // the stockpile step (or deliver to the owner) drains the pack.
    const bot = roomBot({ stacks: fullPack() })
    bot.tossStack = tossStackFake(bot)
    await assert.rejects(
      craft.safeCraft(bot, PICK(), 1, null, { item: 'stone_pickaxe' }),
      /inventory-full/,
    )
    assert.equal(bot.calls.craft.length, 0)
    assert.deepEqual(bot.calls.toss, [])
    assert.deepEqual(bot.calls.tossStack, [])
    assert.equal(bot._items.length, 36, 'the junk stays packed')
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

  it('spare bow with no chest: fails inventory-full, both bows stay (g0z.26)', async () => {
    const stacks = [stack('bow', 1), stack('bow', 1)]
    for (let i = 0; i < 34; i++) stacks.push(stack('dirt', 64))
    const bot = roomBot({ stacks })
    bot.tossStack = tossStackFake(bot)
    await assert.rejects(
      craft.safeCraft(bot, PICK(), 1, null, { item: 'stone_pickaxe' }),
      /inventory-full/,
    )
    assert.equal(bot.calls.craft.length, 0)
    assert.deepEqual(bot.calls.toss, [])
    assert.deepEqual(bot.calls.tossStack, [])
    assert.equal(bot._items.filter((i) => i.name === 'bow').length, 2)
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

  it('enchanted bow with no chest: fails inventory-full, nothing tossed (g0z.26)', async () => {
    const stacks = [stack('bow', 1, { nbt: { Enchantments: [1] } }), stack('bow', 1)]
    for (let i = 0; i < 34; i++) stacks.push(stack('dirt', 64))
    const bot = roomBot({ stacks })
    bot.tossStack = tossStackFake(bot)
    await assert.rejects(
      craft.safeCraft(bot, PICK(), 1, null, { item: 'stone_pickaxe' }),
      /inventory-full/,
    )
    assert.equal(bot.calls.craft.length, 0)
    assert.deepEqual(bot.calls.toss, [])
    assert.deepEqual(bot.calls.tossStack, [])
    assert.equal(bot._items.filter((i) => i.name === 'bow').length, 2)
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

  it('chest far from home: never opened, fails inventory-full (g0z.26)', async () => {
    const bot = roomBot({
      stacks: fullPack(),
      blockAtImpl: () => ({ name: 'chest' }),
      openChestImpl: () => { throw new Error('must not open a far chest') },
    })
    bot.tossStack = tossStackFake(bot)
    const ctx = { home: { chest: { x: 200, y: 64, z: 200 } } }
    await assert.rejects(
      craft.safeCraft(bot, PICK(), 1, null, { ctx, item: 'stone_pickaxe' }),
      /inventory-full/,
    )
    assert.equal(bot.calls.craft.length, 0)
    assert.equal(bot.calls.openChest, 0)
    assert.deepEqual(bot.calls.toss, [])
    assert.deepEqual(bot.calls.tossStack, [])
  })

  it('chest full strands the pickup on the cursor: returned, then inventory-full (g0z.26)', async () => {
    const bot = roomBot({ stacks: fullPack(), blockAtImpl: () => ({ name: 'chest' }) })
    bot.putSelectedItemRange = putBackFake(bot)
    bot.tossStack = tossStackFake(bot)
    const { win } = chestBot(bot, { full: true })
    const ctx = { home: { chest: { x: 1, y: 64, z: 0 } } }
    const leafBefore = bot._items.filter((i) => i.name === 'leaf_litter').reduce((a, i) => a + i.count, 0)
    await assert.rejects(
      craft.safeCraft(bot, PICK(), 1, null, { ctx, item: 'stone_pickaxe' }),
      /inventory-full/,
    )
    assert.equal(win.selectedItem, null)
    assert.equal(bot.calls.craft.length, 0)
    assert.deepEqual(bot.calls.toss, [])
    assert.deepEqual(bot.calls.tossStack, [])
    const leafAfter = bot._items.filter((i) => i.name === 'leaf_litter').reduce((a, i) => a + i.count, 0)
    assert.equal(leafAfter, leafBefore) // nothing banked, nothing tossed, none lost to the cursor
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
    const bot = roomBot({ stacks: fullPack(), slots: [], blockAtImpl: () => ({ name: 'chest' }) })
    bot.inventory.selectedItem = { name: 'leaf_litter', count: 64, slot: 9 }
    bot.putSelectedItemRange = putBackFake(bot)
    chestBot(bot)
    const ctx = { home: { chest: { x: 1, y: 64, z: 0 } } }
    await craft.safeCraft(bot, PICK(), 1, null, { ctx, item: 'stone_pickaxe' })
    assert.equal(bot.calls.craft.length, 1)
    assert.equal(bot.inventory.selectedItem, null)
    assert.deepEqual(bot.calls.toss, [])
  })

  it('above-ceiling planks bank to make room, the keep stays (g0z.26)', async () => {
    // Prod shape: the pack is full of planks while the castle wants stone.
    // ensureRoom banks the surplus above the one-stack keep instead of
    // failing — no slot is tossed.
    const stacks = [stack('oak_planks', 64), stack('oak_planks', 64)]
    for (let i = 0; i < 32; i++) stacks.push(stack('dirt', 64))
    stacks.push(stack('cobblestone', 41), stack('stick', 5))
    assert.equal(stacks.length, 36)
    const bot = roomBot({ stacks, blockAtImpl: () => ({ name: 'chest' }) })
    bot.putSelectedItemRange = putBackFake(bot)
    bot.tossStack = tossStackFake(bot)
    chestBot(bot)
    const ctx = { castle: { phase: 'body' }, home: { built: true, chest: { x: 1, y: 64, z: 0 } } }
    await craft.safeCraft(bot, PICK(), 1, null, { ctx, item: 'stone_pickaxe' })
    assert.equal(bot.calls.craft.length, 1)
    assert.deepEqual(bot.calls.toss, [])
    assert.deepEqual(bot.calls.tossStack, [])
    const banked = bot.calls.deposit.find((d) => d.type === IDS.oak_planks)
    assert.equal(banked && banked.n, 64)
    const left = bot._items.filter((i) => i.name === 'oak_planks').reduce((a, i) => a + i.count, 0)
    assert.equal(left, 64, 'the one-stack keep stays packed')
  })

  it('an unadopted chest in reach banks the junk (g0z.26)', async () => {
    // Owner 2026-10-06: the surplus goes into ANY chest, not only the home
    // one — a roadside craft banks into whatever chest stands nearby.
    const bot = roomBot({
      stacks: fullPack(),
      blockAtImpl: () => ({ name: 'chest' }),
      findBlocksImpl: () => [{ x: 1, y: 64, z: 0 }],
    })
    bot.putSelectedItemRange = putBackFake(bot)
    bot.tossStack = tossStackFake(bot)
    chestBot(bot)
    const ctx = { home: { built: true } } // no adopted chest
    await craft.safeCraft(bot, PICK(), 1, null, { ctx, item: 'stone_pickaxe' })
    assert.equal(bot.calls.craft.length, 1)
    assert.equal(bot.calls.openChest, 1)
    assert.deepEqual(bot.calls.toss, [])
    assert.deepEqual(bot.calls.tossStack, [])
    assert.ok(bot.calls.deposit.length > 0, 'junk banked')
    assert.ok(bot.calls.deposit.every((d) => d.type === IDS.leaf_litter || d.type === IDS.gravel))
  })

  it('a full adopted chest falls through to the next chest in reach (g0z.26)', async () => {
    const bot = roomBot({
      stacks: fullPack(),
      blockAtImpl: (p) => ({ name: 'chest', position: { x: p.x, y: p.y, z: p.z } }),
      findBlocksImpl: () => [{ x: 2, y: 64, z: 0 }],
    })
    bot.putSelectedItemRange = putBackFake(bot)
    const fullWin = chestWindow(bot, { full: true })
    const roomyWin = chestWindow(bot)
    bot.openChest = async (block) => {
      bot.calls.openChest++
      bot._openWin = block.position.x === 1 ? fullWin : roomyWin
      return bot._openWin
    }
    const ctx = { home: { chest: { x: 1, y: 64, z: 0 } } }
    await craft.safeCraft(bot, PICK(), 1, null, { ctx, item: 'stone_pickaxe' })
    assert.equal(bot.calls.craft.length, 1)
    assert.equal(bot.calls.openChest, 2)
    assert.deepEqual(bot.calls.toss, [])
    assert.ok(bot.calls.deposit.length > 0, 'junk banked to the second chest')
  })
})
