// idkcraft-neuc.11: bridge container windows — FakeTransport scripts a chest
// open -> slots -> clicks -> close, and the REAL packroom chest helpers and
// furnace.js smelt run unchanged through the adapter.
// Run: `cd bot && npm test`.
'use strict'

const { describe, it, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert/strict')

const { BaritoneBot } = require('../src/bridge/index')
const { FakeTransport } = require('../src/bridge/transport')
const Vec3 = require('vec3')
const packroom = require('../src/behaviours/packroom')
const furnace = require('../src/behaviours/furnace')

const registry = require('minecraft-data')('26.1.2')
const id = (name) => registry.itemsByName[name].id
const settle = async (n = 20) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)) }

const CHEST = { x: 2, y: 64, z: 0 }
const FURNACE = { x: -2, y: 64, z: 0 }

function winBot({ inventory = [], chest = [], furnaceSlots = [] } = {}) {
  const transport = new FakeTransport({
    pos: { x: 0, y: 64, z: 0, yaw: 0, pitch: 0, onGround: true },
    inventory,
    blocks: { '2,64,0': 'chest', '-2,64,0': 'furnace' }, // neuc.6: the chunk cache serves them after start()
    containers: {
      '2,64,0': { type: 'minecraft:generic_9x3', size: 27, title: 'Chest', slots: chest },
      '-2,64,0': { type: 'minecraft:furnace', size: 3, title: 'Furnace', slots: furnaceSlots, accept: { 1: ['coal', 'charcoal'] } },
    },
  })
  const bot = new BaritoneBot(transport, { Vec3, registry, username: 'IdkBody' })
  return { transport, bot }
}

function invOf(bot, name) {
  return bot.inventory.items().filter((i) => i.name === name).reduce((n, i) => n + i.count, 0)
}
function chestOf(transport, name) {
  return transport.state.containers['2,64,0'].slots.filter((i) => i.name === name).reduce((n, i) => n + i.count, 0)
}

describe('bridge container windows (idkcraft-neuc.11)', () => {
  let transport
  let bot
  afterEach(async () => { await bot.stop() })

  describe('chest', () => {
    beforeEach(async () => {
      ({ transport, bot } = winBot({
        inventory: [{ slot: 9, name: 'cobblestone', count: 40 }, { slot: 36, name: 'dirt', count: 3 }],
        chest: [{ slot: 0, name: 'oak_log', count: 20 }],
      }))
      await bot.start({ pollMs: 0 })
    })

    it('openChest -> prismarine window with mineflayer numbering, windowOpen, close -> windowClose', async () => {
      const opened = []
      const closed = []
      bot.on('windowOpen', (w) => opened.push(w))
      bot.on('windowClose', (w) => closed.push(w))
      const win = await bot.openChest(bot.blockAt(new Vec3(2, 64, 0)))
      assert.equal(win.type, 'minecraft:generic_9x3')
      assert.equal(win.inventoryStart, 27)
      assert.equal(win.inventoryEnd, 63)
      assert.equal(win.slots[0].name, 'oak_log')
      assert.equal(win.slots[27].name, 'cobblestone') // player slot 9 -> 27
      assert.equal(win.slots[54].name, 'dirt') // hotbar 36 -> 54
      assert.deepEqual(win.containerItems().map((i) => i.name), ['oak_log'])
      assert.equal(bot.currentWindow, win)
      assert.deepEqual(opened, [win])
      await win.close()
      assert.equal(bot.currentWindow, null)
      assert.deepEqual(closed, [win])
      assert.deepEqual(transport.state.closeLog, [win.id])
    })

    it('a click moves a stack and the reply lands in the window and bot.inventory', async () => {
      const win = await bot.openChest(bot.blockAt(new Vec3(2, 64, 0)))
      await bot.simpleClick.leftMouse(27) // pick up 40 cobble
      assert.equal(win.selectedItem.name, 'cobblestone')
      assert.equal(win.slots[27], null)
      await bot.clickWindow(5, 0, 0) // drop into chest slot 5
      assert.equal(win.selectedItem, null)
      assert.equal(win.slots[5].count, 40)
      assert.equal(chestOf(transport, 'cobblestone'), 40)
      assert.equal(invOf(bot, 'cobblestone'), 0) // player section folded into bot.inventory
      await bot.closeWindow(win)
    })

    it('REAL packroom.withChest deposit (stockpile shape): deposits, closes, counts move', async () => {
      const ctx = { home: { chest: { ...CHEST } } }
      const res = await packroom.withChest(bot, ctx, (window) => window.deposit(id('cobblestone'), null, 25))
      assert.equal(res.status, 'ok')
      assert.equal(chestOf(transport, 'cobblestone'), 25)
      assert.equal(invOf(bot, 'cobblestone'), 15)
      assert.equal(bot.currentWindow, null)
      assert.equal(transport.state.closeLog.length, 1)
      assert.equal(transport.state.cursor, null) // leftovers went back
    })

    it('REAL packroom.withdrawFromChest: takes what it asked for', async () => {
      const ctx = { home: { chest: { ...CHEST } } }
      const { got } = await packroom.withdrawFromChest(bot, ctx, 'oak_log', 12)
      assert.equal(got, 12)
      assert.equal(invOf(bot, 'oak_log'), 12)
      assert.equal(transport.state.containers['2,64,0'].slots[0].count, 8)
      assert.equal(transport.state.cursor, null)
    })

    it('deposit of a missing item throws mineflayer\'s Can\'t find', async () => {
      const win = await bot.openChest(bot.blockAt(new Vec3(2, 64, 0)))
      await assert.rejects(win.deposit(id('diamond'), null, 1), /Can't find diamond in slots \[27 - 63\]/)
      await win.close()
    })

    it('server close (window.close event) clears currentWindow once; slot events update it', async () => {
      const win = await bot.openChest(bot.blockAt(new Vec3(2, 64, 0)))
      transport.inject('window.slot', { windowId: win.id, slot: 1, item: { slot: 1, name: 'stick', count: 4 } })
      assert.equal(win.slots[1].name, 'stick')
      transport.inject('window.slot', { windowId: win.id + 99, slot: 2, item: { slot: 2, name: 'stick', count: 4 } })
      assert.equal(win.slots[2], null) // foreign window id drops
      const closed = []
      bot.on('windowClose', (w) => closed.push(w))
      transport.inject('window.close', { windowId: win.id })
      transport.inject('window.close', { windowId: win.id })
      assert.equal(bot.currentWindow, null)
      assert.equal(closed.length, 1)
    })

    it('openFurnace on a chest rejects and closes the window', async () => {
      await assert.rejects(bot.openFurnace(bot.blockAt(new Vec3(2, 64, 0))), /not a furnace-like window/)
      assert.equal(bot.currentWindow, null)
    })

    it('Baritone pauses across a click while pathing and resumes after', async () => {
      const win = await bot.openChest(bot.blockAt(new Vec3(2, 64, 0)))
      bot._pathing = true // a live walk
      await bot.clickWindow(27, 0, 0)
      assert.deepEqual(transport.state.baritonePauses, ['#pause', '#resume'])
      bot._pathing = false
      await bot.clickWindow(27, 0, 0)
      assert.equal(transport.state.baritonePauses.length, 2) // idle: no pause
      await win.close()
    })

    it('player-inventory clicks (no window open) target window 0; closeWindow(inventory) is a no-op', async () => {
      // The fake only models container menus; the wire id is what matters.
      transport.state.window = null
      await assert.rejects(bot.clickWindow(9, 0, 0), /stale window 0/)
      assert.equal(transport.state.clickLog[0].windowId, 0)
      await bot.closeWindow(bot.inventory) // craft.js resync call: a no-op, never a wire close
      assert.equal(transport.state.closeLog, undefined)
    })
  })

  describe('furnace', () => {
    beforeEach(async () => {
      ({ transport, bot } = winBot({
        inventory: [{ slot: 9, name: 'raw_iron', count: 8 }, { slot: 10, name: 'coal', count: 3 }],
      }))
      await bot.start({ pollMs: 0 })
    })

    it('a refused click (raw iron into the fuel slot) fails instead of spinning', async () => {
      const win = await bot.openFurnace(bot.blockAt(new Vec3(-2, 64, 0)))
      await assert.rejects(win.putFuel(id('raw_iron'), null, 1), /moved nothing/)
      assert.ok(transport.state.clickLog.length <= 2, `clicks: ${transport.state.clickLog.length}`)
      await win.close()
    })

    it('REAL furnace.js smelt: loads ore + one coal, takes the ingots, logs smelted 8 iron', async () => {
      const ctx = { home: { furnace: new Vec3(FURNACE.x, FURNACE.y, FURNACE.z) } }
      furnace(bot, ctx)
      await settle()
      const fslots = () => transport.state.containers['-2,64,0'].slots
      assert.deepEqual(fslots().map((i) => [i.slot, i.name, i.count]), [[0, 'raw_iron', 8], [1, 'coal', 1]])
      assert.equal(invOf(bot, 'coal'), 2)
      assert.ok(bot.currentWindow, 'furnace.js keeps its window open across smelt ticks')
      // The burn: server-side slot changes arrive as window.slot events.
      const win = bot.currentWindow
      transport.state.containers['-2,64,0'].slots = [{ slot: 2, name: 'iron_ingot', count: 8 }]
      transport.inject('window.slot', { windowId: win.id, slot: 0, item: null })
      transport.inject('window.slot', { windowId: win.id, slot: 1, item: null })
      transport.inject('window.slot', { windowId: win.id, slot: 2, item: { slot: 2, name: 'iron_ingot', count: 8 } })
      const logs = []
      const orig = console.log
      console.log = (...a) => { logs.push(a.join(' ')); orig(...a) }
      try {
        for (let i = 0; i < 4 && ctx.stepStatus == null; i++) { furnace(bot, ctx); await settle() }
      } finally { console.log = orig }
      assert.equal(invOf(bot, 'iron_ingot'), 8)
      assert.equal(ctx.stepStatus, 'done')
      assert.ok(logs.includes('smelted 8 iron'), logs.join('\n'))
      await settle()
      assert.equal(bot.currentWindow, null) // finishSmelt shut it
    })
  })
})
