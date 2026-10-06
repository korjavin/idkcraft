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
  oak_planks: 1007, oak_log: 1008, chest: 1009, crafting_table: 1010,
}
const STACK = { stone_pickaxe: 1, bow: 1 }

function roomBot({ stacks = [], craftImpl = null, tossImpl = null, tossStackImpl = null, clickWindowImpl = null, putBackImpl = null, blockAtImpl = null, openChestImpl = null, findBlocksImpl = null, players = {}, at = { x: 0, y: 64, z: 0 }, slots = null } = {}) {
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
    players,
    username: 'IdkBot',
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

  it('reserved slot: a tool craft refuses the last slot when chestless and alone (R2)', async () => {
    // Revmux 01 major: the last slot belongs to the bootstrap chest craft —
    // a 36/36 chestless pack has no drain that is not tossing.
    const stacks = [stack('cobblestone', 41), stack('stick', 5)]
    for (let i = 0; i < 33; i++) stacks.push(stack('dirt', 64))
    assert.equal(stacks.length, 35)
    const bot = roomBot({ stacks })
    bot.tossStack = tossStackFake(bot)
    const ctx = { home: { site: { x: 0, y: 64, z: 0 }, built: true, chest: null } }
    await assert.rejects(
      craft.safeCraft(bot, PICK(), 1, null, { ctx, item: 'stone_pickaxe' }),
      /inventory-full/,
    )
    assert.equal(bot.calls.craft.length, 0)
    assert.deepEqual(bot.calls.toss, [])
    assert.deepEqual(bot.calls.tossStack, [])
    assert.equal(bot._items.length, 35)
  })

  it('reserved slot: the chest and table crafts are exempt (R2)', async () => {
    const chestIng = Array.from({ length: 8 }, () => ({ id: IDS.oak_planks }))
    const tableIng = Array.from({ length: 4 }, () => ({ id: IDS.oak_planks }))
    for (const [name, ing] of [['chest', chestIng], ['crafting_table', tableIng]]) {
      const stacks = [stack('oak_planks', 64)]
      for (let i = 0; i < 34; i++) stacks.push(stack('dirt', 64))
      const bot = roomBot({ stacks })
      const ctx = { home: { site: { x: 0, y: 64, z: 0 }, built: true, chest: null } }
      await craft.safeCraft(bot, prodRecipe(name, 1, ing), 1, null, { ctx, item: name })
      assert.equal(bot.calls.craft.length, 1, `${name} takes the last slot`)
    }
  })

  it('reserved slot: a stacking conversion passes through (R2)', async () => {
    const stacks = [stack('oak_log', 14), stack('oak_planks', 5)]
    for (let i = 0; i < 33; i++) stacks.push(stack('dirt', 64))
    assert.equal(stacks.length, 35)
    const bot = roomBot({ stacks })
    const ctx = { home: { site: { x: 0, y: 64, z: 0 }, built: true, chest: null } }
    await craft.safeCraft(bot, prodRecipe('oak_planks', 4, [{ id: IDS.oak_log }]), 1, null, { ctx, item: 'oak_planks' })
    assert.equal(bot.calls.craft.length, 1)
  })

  it('reserved slot: open with an adopted chest, a player online, or pre-house (R2)', async () => {
    const contexts = {
      adopted: { home: { site: { x: 0, y: 64, z: 0 }, built: true, chest: { x: 200, y: 64, z: 200 } } },
      prehouse: { home: { site: { x: 0, y: 64, z: 0 }, built: false, chest: null } },
    }
    for (const [label, ctx] of Object.entries(contexts)) {
      const stacks = [stack('cobblestone', 41), stack('stick', 5)]
      for (let i = 0; i < 33; i++) stacks.push(stack('dirt', 64))
      const bot = roomBot({ stacks })
      await craft.safeCraft(bot, PICK(), 1, null, { ctx, item: 'stone_pickaxe' })
      assert.equal(bot.calls.craft.length, 1, label)
    }
    const stacks = [stack('cobblestone', 41), stack('stick', 5)]
    for (let i = 0; i < 33; i++) stacks.push(stack('dirt', 64))
    const bot = roomBot({ stacks, players: { owner: { username: 'owner' } } })
    const ctx = { home: { site: { x: 0, y: 64, z: 0 }, built: true, chest: null } }
    await craft.safeCraft(bot, PICK(), 1, null, { ctx, item: 'stone_pickaxe' })
    assert.equal(bot.calls.craft.length, 1, 'online')
  })

  it('bootstrap craft without funding: no shed, honest inventory-full (g0z.26 R3)', async () => {
    // 5 planks cannot fund the chest: the shed must not fire — the quest
    // owns this corner — even with a shedable victim and ground to pillar
    // on. (The funded half is the round-1 chain test in stockpile.test.js.)
    const stacks = [stack('oak_planks', 5)]
    for (let i = 0; i < 35; i++) stacks.push(stack('dirt', 64))
    assert.equal(stacks.length, 36)
    const bot = roomBot({
      stacks,
      blockAtImpl: (p) => ({ name: p.y < 64 ? 'dirt' : 'air', position: { x: p.x, y: p.y, z: p.z } }),
    })
    let placed = 0
    bot.equip = async () => {}
    bot.placeBlock = async () => { placed++ }
    const ctx = { home: { site: { x: 0, y: 64, z: 0 }, built: true, chest: null } }
    await assert.rejects(
      craft.safeCraft(bot, prodRecipe('chest', 1), 1, {}, { ctx, item: 'chest' }),
      /inventory-full/,
    )
    assert.equal(placed, 0, 'nothing shed without funding')
    assert.equal(bot.calls.craft.length, 0)
    assert.equal(bot._items.length, 36)
  })

  it('funded shed spreads a 20-victim under a ceiling, skipping the occupied column (g0z.26 R4)', async () => {
    // Revmux 03 major: the shed surveys air-verified, reach-capped columns
    // — a 2-high room caps each at 2, the table column skips, and the fake
    // placeBlock refuses occupied cells and anything above headroom, like
    // Paper. Attempts (not just landings) prove the survey never aims at a
    // refusal.
    const stacks = [stack('oak_planks', 12), stack('dirt', 20)]
    for (let i = 0; i < 34; i++) stacks.push(stack('dirt', 64))
    assert.equal(stacks.length, 36)
    const cells = { '1,64,0': 'crafting_table' } // the table: first offset, occupied
    const bot = roomBot({
      stacks,
      blockAtImpl: (p) => {
        const key = `${p.x},${p.y},${p.z}`
        if (cells[key]) return { name: cells[key], position: { x: p.x, y: p.y, z: p.z } }
        const name = p.y < 64 ? 'dirt' : p.y > 65 ? 'stone' : 'air' // 2-high room
        return { name, position: { x: p.x, y: p.y, z: p.z } }
      },
    })
    let held = null
    bot.equip = async (item) => { held = item && item.name }
    const attempts = []
    bot.placeBlock = async (ref, face) => {
      const p = ref && ref.position ? ref.position : { x: 0, y: 63, z: 0 }
      const f = face || { x: 0, y: 1, z: 0 }
      const key = `${p.x + f.x},${p.y + f.y},${p.z + f.z}`
      attempts.push(key)
      const cur = cells[key] || ((p.y + f.y) < 64 ? 'dirt' : (p.y + f.y) > 65 ? 'stone' : 'air')
      if (cur !== 'air') throw new Error(`refused: ${key} holds ${cur}`)
      cells[key] = held
      const ix = bot._items.findIndex((i) => i.name === held)
      if (ix >= 0) {
        if (bot._items[ix].count <= 1) bot._items.splice(ix, 1)
        else bot._items[ix].count--
      }
    }
    const ctx = { home: { site: { x: 0, y: 64, z: 0 }, built: true, chest: null } }
    await craft.safeCraft(bot, prodRecipe('chest', 1), 1, {}, { ctx, item: 'chest' })
    assert.equal(bot.calls.craft.length, 1, 'the freed slot takes the chest')
    assert.ok(!bot._items.some((i) => i.name === 'dirt' && i.count === 20), 'the victim is gone')
    assert.equal(attempts.length, 20, 'every placement aimed once, none refused')
    for (const key of attempts) {
      const [x, y, z] = key.split(',').map(Number)
      assert.ok(y <= 65, `${key} stays below the ceiling`)
      assert.ok(!(x === 1 && z === 0), `${key} skips the occupied table column`)
    }
    assert.equal(bot._items.filter((i) => i.name === 'dirt').length, 34, 'the dirt-64s stay packed')
  })

  it('funded shed that cannot fit: no doomed pillars, honest inventory-full (g0z.26 R4)', async () => {
    // A dirt-64 victim under a 1-high ceiling (16 columns of cap 1): the
    // survey refuses up front — starting anyway would strand 16 blocks and
    // eat the ground for the retry.
    const stacks = [stack('oak_planks', 12), stack('dirt', 64)]
    for (let i = 0; i < 34; i++) stacks.push(stack('dirt', 64))
    assert.equal(stacks.length, 36)
    const bot = roomBot({
      stacks,
      blockAtImpl: (p) => ({ name: p.y < 64 ? 'dirt' : p.y > 64 ? 'stone' : 'air', position: { x: p.x, y: p.y, z: p.z } }),
    })
    bot.equip = async () => {}
    let attempts = 0
    bot.placeBlock = async () => { attempts++ }
    const ctx = { home: { site: { x: 0, y: 64, z: 0 }, built: true, chest: null } }
    await assert.rejects(
      craft.safeCraft(bot, prodRecipe('chest', 1), 1, {}, { ctx, item: 'chest' }),
      /inventory-full/,
    )
    assert.equal(attempts, 0, 'nothing placed when nothing fits')
    assert.equal(bot.calls.craft.length, 0)
    assert.equal(bot._items.length, 36)
  })

  it('a refused column abandons the column, not the shed (g0z.26 R4)', async () => {
    // The first placement throws (transient refusal): the shed moves to the
    // next surveyed column and still frees the slot.
    const stacks = [stack('oak_planks', 12), stack('dirt', 3)]
    for (let i = 0; i < 34; i++) stacks.push(stack('dirt', 64))
    assert.equal(stacks.length, 36)
    const cells = {}
    const bot = roomBot({
      stacks,
      blockAtImpl: (p) => {
        const key = `${p.x},${p.y},${p.z}`
        if (cells[key]) return { name: cells[key], position: { x: p.x, y: p.y, z: p.z } }
        return { name: p.y < 64 ? 'dirt' : 'air', position: { x: p.x, y: p.y, z: p.z } }
      },
    })
    bot.equip = async (item) => { bot._held = item && item.name }
    let n = 0
    const attempts = []
    bot.placeBlock = async (ref, face) => {
      const p = ref && ref.position ? ref.position : { x: 0, y: 63, z: 0 }
      const f = face || { x: 0, y: 1, z: 0 }
      const key = `${p.x + f.x},${p.y + f.y},${p.z + f.z}`
      attempts.push(key)
      n++
      if (n === 1) throw new Error('transient refusal')
      cells[key] = bot._held
      const ix = bot._items.findIndex((i) => i.name === bot._held)
      if (ix >= 0) {
        if (bot._items[ix].count <= 1) bot._items.splice(ix, 1)
        else bot._items[ix].count--
      }
    }
    const ctx = { home: { site: { x: 0, y: 64, z: 0 }, built: true, chest: null } }
    await craft.safeCraft(bot, prodRecipe('chest', 1), 1, {}, { ctx, item: 'chest' })
    assert.equal(bot.calls.craft.length, 1)
    assert.equal(attempts.length, 4, 'one refusal plus the three-victim shed')
    assert.ok(!bot._items.some((i) => i.name === 'dirt' && i.count === 3), 'the victim is gone')
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
