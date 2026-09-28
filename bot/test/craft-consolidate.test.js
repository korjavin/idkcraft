'use strict'

// ph7: the phantom table craft. mineflayer picks the FIRST inventory stack of
// each ingredient whatever its size; when it is smaller than the op's
// placement count the cursor runs dry mid-op, a placement goes out on an
// empty server cursor (or the mid-op re-pickup races the pipelined
// placements), the grid never completes, the result grab takes nothing — and
// the op still resolves, because the updateSlot:0 waits are satisfied by
// echo/resync traffic, never by the click's own effect. Assayed live on
// Paper 26.1.2: 28/28 single-pickup door ops landed, 2/2 partial-first-stack
// ops phantomed (server grid missing one plank, mats unspent, no product).
// safeCraft consolidates each ingredient into its first-picked stack before
// delegating, so the first op lands. The fake bot.craft below emulates the
// assayed server contract: first stack below the placement count resolves
// with no effect (the phantom), a covered stack consumes and produces.
const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const craft = require('../src/behaviours/craft')

const PLANKS = 18

function item(name, type, count) {
  return { name, type, count, stackSize: 64 }
}

// 46-slot player inventory window with prismarine-windows search semantics
// (linear scan of the inventory range).
function fakeWindow() {
  const slots = new Array(46).fill(null)
  const win = {
    slots,
    selectedItem: null,
    inventoryStart: 9,
    inventoryEnd: 45,
    currentWindow: null,
    items: () => slots.slice(9, 45).filter(Boolean),
    updateSlot(i, it) {
      if (it) it.slot = i
      slots[i] = it
    },
    findItemRange(start, end, itemType, metadata) {
      for (let i = start; i < end; i++) {
        const it = slots[i]
        if (it && it.type === itemType && (metadata == null || metadata === it.metadata)) return it
      }
      return null
    },
    findItemsRange(start, end, itemType, metadata) {
      const out = []
      let s = start
      for (;;) {
        const it = win.findItemRange(s, end, itemType, metadata)
        if (!it) return out
        out.push(it)
        s = it.slot + 1
      }
    },
    findInventoryItem(itemType, metadata) {
      return win.findItemRange(win.inventoryStart, win.inventoryEnd, itemType, metadata)
    },
  }
  return win
}

// Door-shaped mock recipe: 6 plank placements (inShape mirrors
// prismarine-recipe: cells with id === -1 are skipped by mineflayer).
function doorRecipe() {
  const p = { id: PLANKS }
  return { inShape: [[p, p], [p, p], [p, p]], result: { count: 3 } }
}

// Vanilla left-click on the fake window: pick up / place / merge.
function fakeClickWindow(win, calls) {
  return async (slot, button, mode) => {
    calls.push([slot, button, mode])
    assert.equal(button, 0)
    assert.equal(mode, 0)
    const cur = win.selectedItem
    const there = win.slots[slot]
    if (!cur) {
      win.selectedItem = there
      win.slots[slot] = null
      return
    }
    if (!there) {
      cur.slot = slot
      win.slots[slot] = cur
      win.selectedItem = null
      return
    }
    if (there.type === cur.type) {
      // vanilla left-click merges CURSOR->SLOT (fills the slot, leftover
      // stays on the cursor); into a full stack nothing transfers.
      const room = (there.stackSize || 64) - there.count
      const take = Math.min(room, cur.count)
      there.count += take
      cur.count -= take
      if (cur.count <= 0) win.selectedItem = null
      return
    }
    // swap (should not happen in these tests)
    cur.slot = slot
    there.slot = -1
    win.slots[slot] = cur
    win.selectedItem = there
  }
}

function countIn(win, name) {
  return win.items().reduce((n, it) => (it && it.name === name ? n + it.count : n), 0)
}

// Fake bot whose craft emulates the assayed server: a first stack below the
// placement count resolves with NO effect (the phantom); a covered stack
// consumes from the first stack and produces doors.
function fakeBot(win, { clicks = null, syncs = null } = {}) {
  const bot = {
    inventory: win,
    currentWindow: null,
    clickWindow: fakeClickWindow(win, clicks || []),
    putSelectedItemRange: async () => { throw new Error('unexpected putSelectedItemRange') },
    _syncWindow: async () => { if (syncs) syncs.push(1) },
    craftCalls: 0,
    craft: async (recipe, count, table) => {
      bot.craftCalls++
      assert.equal(count, 1)
      assert.ok(table)
      const first = win.findInventoryItem(PLANKS)
      if (!first || first.count < 6) return // the phantom: resolves with no server effect
      first.count -= 6
      if (first.count <= 0) win.slots[first.slot] = null
      const door = item('oak_door', 781, 3)
      for (let i = 9; i < 45; i++) {
        if (!win.slots[i]) {
          door.slot = i
          win.slots[i] = door
          break
        }
      }
    },
  }
  return bot
}

const flush = () => new Promise((resolve) => setImmediate(resolve))

describe('ph7 consolidate-before-craft', () => {
  it('partial first stack: the first op lands (no phantom)', async () => {
    const win = fakeWindow()
    const a = item('oak_planks', PLANKS, 4)
    a.slot = 9
    win.slots[9] = a
    const b = item('oak_planks', PLANKS, 64)
    b.slot = 10
    win.slots[10] = b
    const clicks = []
    const bot = fakeBot(win, { clicks })
    await craft.safeCraft(bot, doorRecipe(), 1, { name: 'crafting_table' })
    assert.equal(bot.craftCalls, 1)
    assert.equal(countIn(win, 'oak_door'), 3) // phantom would leave 0
    assert.equal(countIn(win, 'oak_planks'), 62) // 68 - 6 consumed
    assert.ok(clicks.length > 0) // consolidation clicked before the craft
  })

  it('covered first stack: zero consolidation clicks (fast path)', async () => {
    const win = fakeWindow()
    const a = item('oak_planks', PLANKS, 64)
    a.slot = 9
    win.slots[9] = a
    const clicks = []
    const syncs = []
    const bot = fakeBot(win, { clicks, syncs })
    await craft.safeCraft(bot, doorRecipe(), 1, { name: 'crafting_table' })
    assert.equal(bot.craftCalls, 1)
    assert.equal(countIn(win, 'oak_door'), 3)
    assert.deepEqual(clicks, []) // fast path: no clicks at all
  })

  it('fail-open: consolidation error still crafts (as before)', async () => {
    const win = fakeWindow()
    const a = item('oak_planks', PLANKS, 4)
    a.slot = 9
    win.slots[9] = a
    const b = item('oak_planks', PLANKS, 64)
    b.slot = 10
    win.slots[10] = b
    const bot = fakeBot(win)
    bot.clickWindow = async () => { throw new Error('click broke') }
    await craft.safeCraft(bot, doorRecipe(), 1, { name: 'crafting_table' })
    assert.equal(bot.craftCalls, 1) // proceeds despite the error
    assert.equal(countIn(win, 'oak_door'), 0) // phantom preserved, exactly as before
  })

  it('skips consolidation while a window is open', async () => {
    const win = fakeWindow()
    const a = item('oak_planks', PLANKS, 4)
    a.slot = 9
    win.slots[9] = a
    const b = item('oak_planks', PLANKS, 64)
    b.slot = 10
    win.slots[10] = b
    const clicks = []
    const bot = fakeBot(win, { clicks })
    bot.currentWindow = { id: 3 } // clicks would land in the open window
    await craft.safeCraft(bot, doorRecipe(), 1, { name: 'crafting_table' })
    assert.equal(bot.craftCalls, 1)
    assert.deepEqual(clicks, []) // skipped: no clicks into the wrong window
    assert.equal(countIn(win, 'oak_door'), 0) // phantom preserved (fail-open)
  })

  it('shapeless recipe counts every ingredient entry', async () => {
    const win = fakeWindow()
    const a = item('oak_planks', PLANKS, 2)
    a.slot = 9
    win.slots[9] = a
    const b = item('oak_planks', PLANKS, 64)
    b.slot = 10
    win.slots[10] = b
    const clicks = []
    const syncs = []
    const bot = fakeBot(win, { clicks, syncs })
    // 3 shapeless placements: a first stack of 2 must consolidate
    const recipe = { ingredients: [{ id: PLANKS }, { id: PLANKS }, { id: PLANKS }] }
    let covered = 0
    bot.craft = async () => {
      bot.craftCalls++
      const first = win.findInventoryItem(PLANKS)
      covered = first ? first.count : 0
    }
    await craft.safeCraft(bot, recipe, 1, { name: 'crafting_table' })
    assert.equal(bot.craftCalls, 1)
    assert.ok(covered >= 3, `first stack ${covered} covers 3 placements`)
    assert.ok(clicks.length > 0)
  })

  it('sync timeout still crafts (no hang)', async () => {
    // Dead link: _syncWindow never answers. The 3 s give-up must fire and
    // the op must run unverified, not hang before the craft starts.
    const { mock } = require('node:test')
    mock.timers.enable({ apis: ['setTimeout'] })
    try {
      const win = fakeWindow()
      const a = item('oak_planks', PLANKS, 4)
      a.slot = 9
      win.slots[9] = a
      const b = item('oak_planks', PLANKS, 64)
      b.slot = 10
      win.slots[10] = b
      const bot = fakeBot(win)
      bot._syncWindow = () => new Promise(() => {}) // dead link
      const p = craft.safeCraft(bot, doorRecipe(), 1, { name: 'crafting_table' })
      await flush() // let safeCraft reach the pending sync
      mock.timers.tick(3001)
      await flush()
      await p
      assert.equal(bot.craftCalls, 1)
      assert.equal(countIn(win, 'oak_door'), 3) // consolidation applied, craft ran
    } finally {
      mock.timers.reset()
    }
  })

  it('settle fallback without _syncWindow still crafts', async () => {
    const { mock } = require('node:test')
    mock.timers.enable({ apis: ['setTimeout'] })
    try {
      const win = fakeWindow()
      const a = item('oak_planks', PLANKS, 4)
      a.slot = 9
      win.slots[9] = a
      const b = item('oak_planks', PLANKS, 64)
      b.slot = 10
      win.slots[10] = b
      const bot = fakeBot(win)
      delete bot._syncWindow // old mineflayer: settle wait instead of sync
      const pr = craft.safeCraft(bot, doorRecipe(), 1, { name: 'crafting_table' })
      await flush()
      mock.timers.tick(251)
      await flush()
      await pr
      assert.equal(bot.craftCalls, 1)
      assert.equal(countIn(win, 'oak_door'), 3)
    } finally {
      mock.timers.reset()
    }
  })

  it('foreign cursor bails with zero clicks', async () => {
    const win = fakeWindow()
    const a = item('oak_planks', PLANKS, 4)
    a.slot = 9
    win.slots[9] = a
    const b = item('oak_planks', PLANKS, 64)
    b.slot = 10
    win.slots[10] = b
    win.selectedItem = item('oak_planks', PLANKS, 5) // someone else holds the cursor
    const clicks = []
    const bot = fakeBot(win, { clicks })
    await craft.safeCraft(bot, doorRecipe(), 1, { name: 'crafting_table' })
    assert.equal(bot.craftCalls, 1)
    assert.deepEqual(clicks, [])
  })

  it('throw mid-cycle bails the next ingredient (fail-open)', async () => {
    // Two ingredients; the first donor cycle throws after picking up, so the
    // cursor is stuck full. The second ingredient must bail, not click from
    // a wrong cursor — and the craft must still run.
    const win = fakeWindow()
    const a = item('oak_planks', PLANKS, 4)
    a.slot = 9
    win.slots[9] = a
    const b = item('oak_planks', PLANKS, 64)
    b.slot = 10
    win.slots[10] = b
    const c = item('iron_ingot', 99, 2)
    c.slot = 11
    win.slots[11] = c
    const d = item('iron_ingot', 99, 64)
    d.slot = 12
    win.slots[12] = d
    const clicks = []
    const bot = fakeBot(win, { clicks })
    const realClick = bot.clickWindow
    let n = 0
    bot.clickWindow = async (...args) => {
      n++
      if (n === 2) throw new Error('dump broke') // pickup applied, dump throws
      return realClick(...args)
    }
    bot.craft = async () => { bot.craftCalls++ }
    const p = { id: PLANKS }
    const recipe = { inShape: [[p, p, p, p, p, { id: 99 }]] } // 5 planks (short) + 1 ingot
    await craft.safeCraft(bot, recipe, 1, { name: 'crafting_table' })
    assert.equal(bot.craftCalls, 1)
    assert.deepEqual(clicks.map((x) => x[0]), [10]) // only the first pickup went out
  })
})
