// idkcraft-neuc.11: container windows for the Baritone body.
//
// The mod serves window.open/click/close + window.open/slot/close
// notifications (baritone/bridge/PROTOCOL.md, windows section); this module
// folds them into mineflayer's shapes: prismarine-windows windows with
// withdraw/deposit/close (mineflayer chest.js), the Furnace members the
// logic reads (furnace.js/light.js: inputItem/fuelItem/outputItem,
// takeInput/takeFuel/takeOutput, putInput/putFuel), bot.currentWindow,
// bot.clickWindow/simpleClick/closeWindow, bot.transfer/putAway/
// putSelectedItemRange and the windowOpen/windowClose events.
//
// Slot numbering is mineflayer's: container slots first, then the player
// inventory offset by the container size (the vanilla menu order, so the
// mod passes menu indices through untouched).
//
// Clicks are not predicted here: the mod runs the vanilla click on the
// client (which tracks the server's state id — the window-id/revision
// churn is the client's problem) and replies with the whole menu, which
// replaces the local window. bot._syncWindow is deliberately absent:
// craft.js has a settle-wait fallback for it (.12 owns crafting).
//
// This file requires nothing outside bot/src/bridge/ (epic section 2).
'use strict'

const { makeItem, windowFactory, applyInventory, applyInventoryUpdate } = require('./inventory')
const { withBaritonePaused } = require('./look')

// mineflayer chest.js / furnace.js allowed window types (prefix match).
const CONTAINER_TYPES = ['minecraft:generic', 'minecraft:chest', 'minecraft:dispenser', 'minecraft:ender_chest',
  'minecraft:shulker_box', 'minecraft:hopper', 'minecraft:container', 'minecraft:dropper',
  'minecraft:trapped_chest', 'minecraft:barrel']
const FURNACE_TYPES = ['minecraft:furnace', 'minecraft:blast_furnace', 'minecraft:smoker']
const PLAYER_INV_START = 9 // bot.inventory's main-inventory start (player window numbering)

function failLog(what, e) { console.log(`bridge ${what} failed: ${(e && e.message) || e}`) }
function typeIn(win, list) { return list.some((t) => String(win.type).startsWith(t)) }

// Replace the window's slots + cursor from a wire menu ({slots, cursor}).
// A container window also pushes its player section into bot.inventory
// (mineflayer copyInventory), so countItems is right right after a deposit.
function applyMenu(bot, win, w) {
  if (!w || typeof w !== 'object') return
  if (win === bot.inventory) {
    applyInventory(bot, w)
    if ('cursor' in w) win.selectedItem = makeItem(bot, w.cursor)
    return
  }
  if (Array.isArray(w.slots)) {
    const bySlot = new Map()
    for (const wire of w.slots) if (wire && typeof wire.slot === 'number') bySlot.set(wire.slot, wire)
    const offset = win.inventoryStart - PLAYER_INV_START
    for (let s = 0; s < win.slots.length; s++) {
      const wire = bySlot.get(s) || null
      if (wire || win.slots[s]) win.updateSlot(s, makeItem(bot, wire))
      if (s >= win.inventoryStart && s < win.inventoryEnd) {
        applyInventoryUpdate(bot, { slot: s - offset, item: wire ? { ...wire, slot: s - offset } : null })
      }
    }
  }
  if ('cursor' in w) win.selectedItem = makeItem(bot, w.cursor)
}

// Wire menu -> the open window: the current one when the ids match (the
// open reply and the mod's window.open notification both land here),
// else a fresh prismarine-windows window + 'windowOpen'.
function adoptWindow(bot, w) {
  if (!w || typeof w.windowId !== 'number') throw new Error('bridge window.open: bad reply')
  let win = bot.currentWindow
  if (!win || win.id !== w.windowId) {
    const factory = windowFactory(bot)
    if (!factory) throw new Error('bridge windows: prismarine-windows unavailable')
    const containerSlots = typeof w.size === 'number' ? w.size - 36 : undefined
    win = factory.createWindow(w.windowId, w.type, w.title || '', containerSlots)
    if (!win) throw new Error(`bridge windows: unknown window type ${w.type}`)
    applyMenu(bot, win, w)
    bot.currentWindow = win
    bot.emit('windowOpen', win)
    return win
  }
  applyMenu(bot, win, w)
  return win
}

// Local close bookkeeping (our close or the server's): exactly once per window.
function finishClose(bot, win) {
  if (!win || win._closed) return
  win._closed = true
  if (bot.currentWindow === win) bot.currentWindow = null
  bot.emit('windowClose', win)
  win.emit('close')
}

function installWindows(bot) {
  bot.currentWindow = null
  const call = (method, params) => bot.transport.call(method, params)

  // mineflayer clickWindow: one vanilla click on the open window (or the
  // player inventory). Baritone is paused across the click so the body
  // never walks out of reach mid-click (.9's pause rule, goal restored).
  bot.clickWindow = async (slot, mouseButton, mode) => {
    if (!(mode >= 0 && mode <= 6)) throw new Error(`clickWindow: invalid mode ${mode}`)
    const win = bot.currentWindow || bot.inventory
    const r = await withBaritonePaused(bot, () => call('window.click', { windowId: win.id, slot, mouseButton, mode }))
    applyMenu(bot, win, r)
  }

  bot.simpleClick = {
    leftMouse: (slot) => bot.clickWindow(slot, 0, 0),
    rightMouse: (slot) => bot.clickWindow(slot, 1, 0),
  }

  // mineflayer closeWindow: local state flips now, the wire close follows.
  // The player inventory (craft.js's resync call) has nothing to close.
  bot.closeWindow = (window) => {
    const win = window || bot.currentWindow
    if (!win || win === bot.inventory || win.id === 0) return Promise.resolve()
    finishClose(bot, win)
    return call('window.close', { windowId: win.id }).then(() => {}, (e) => failLog('window.close', e))
  }

  // mineflayer putSelectedItemRange: drop the cursor stack into [start,end)
  // — merge first, then an empty slot, else click `slot` and toss the rest.
  bot.putSelectedItemRange = async (start, end, window, slot) => {
    while (window.selectedItem) {
      const sel = window.selectedItem
      const item = window.findItemRange(start, end, sel.type, sel.metadata, true, sel.nbt)
      if (item && item.stackSize !== item.count) {
        await bot.clickWindow(item.slot, 0, 0)
        continue
      }
      const empty = window.firstEmptySlotRange(start, end)
      if (empty !== null) {
        await bot.clickWindow(empty, 0, 0)
        continue
      }
      if (slot != null) await bot.clickWindow(slot, 0, 0)
      if (window.selectedItem) await bot.clickWindow(-999, 0, 0)
    }
  }

  // mineflayer transfer: move `count` of itemType from [sourceStart,
  // sourceEnd) to [destStart,destEnd) with left (whole stack) / right
  // (one item) clicks, leftovers back to the source range. Same error
  // strings ('destination full', "Can't find ...").
  bot.transfer = async (options) => {
    const window = options.window || bot.currentWindow || bot.inventory
    const { itemType, metadata, nbt, sourceStart, destStart } = options
    let count = options.count == null ? 1 : options.count
    const sourceEnd = options.sourceEnd == null ? sourceStart + 1 : options.sourceEnd
    const destEnd = options.destEnd == null ? destStart + 1 : options.destEnd
    let firstSourceSlot = null
    for (;;) {
      if (count <= 0) {
        await bot.putSelectedItemRange(sourceStart, sourceEnd, window, firstSourceSlot)
        return
      }
      const sel = window.selectedItem
      if (!sel || sel.type !== itemType || (metadata != null && sel.metadata !== metadata)) {
        const src = window.findItemRange(sourceStart, sourceEnd, itemType, metadata, false, nbt)
        if (!src) {
          const entry = bot.registry && bot.registry.items && bot.registry.items[itemType]
          throw new Error(`Can't find ${entry ? entry.name : itemType} in slots [${sourceStart} - ${sourceEnd}], (item id: ${itemType})`)
        }
        if (firstSourceSlot === null) firstSourceSlot = src.slot
        await bot.clickWindow(src.slot, 0, 0)
        if (!window.selectedItem) throw new Error(`transfer: pick-up of slot ${src.slot} did not land`)
      }
      const held = window.selectedItem
      const destItem = window.findItemRange(destStart, destEnd, held.type, held.metadata, true, nbt)
      const destSlot = destItem ? destItem.slot : window.firstEmptySlotRange(destStart, destEnd)
      if (destSlot === null) throw new Error('destination full')
      const moved = Math.min(held.stackSize - (destItem ? destItem.count : 0), held.count)
      const before = held.count
      if (moved <= count) {
        await bot.clickWindow(destSlot, 0, 0)
        count -= moved
      } else {
        await bot.clickWindow(destSlot, 1, 0)
        count -= 1
      }
      // A click the server/client refused leaves the cursor unchanged:
      // fail instead of spinning (v1 would time out the transaction).
      if (window.selectedItem && window.selectedItem.count === before && window.selectedItem.type === held.type) {
        throw new Error(`transfer: click on slot ${destSlot} moved nothing`)
      }
    }
  }

  // mineflayer putAway: shift-click a slot into the player inventory part.
  bot.putAway = async (slot) => {
    const window = bot.currentWindow || bot.inventory
    const start = window.inventoryStart
    const end = window.inventoryEnd
    const item = window.slots[slot]
    const room = item && (window.findItemRange(start, end, item.type, item.metadata, true, item.nbt) ||
      window.firstEmptySlotRange(start, end) !== null)
    if (room && slot !== window.craftingResultSlot) {
      await bot.clickWindow(slot, 0, 1)
    } else {
      await bot.clickWindow(slot, 0, 0)
      await bot.putSelectedItemRange(start, end, window, null)
    }
  }

  // mineflayer openBlock: one window.open (the mod clicks the block and
  // waits for the server's window), adopted + extended like chest.js.
  async function openBlock(block) {
    if (!block || !block.position) throw new Error('containerToOpen is neither a block nor an entity')
    if (bot.currentWindow) await bot.closeWindow(bot.currentWindow)
    const p = block.position
    const r = await withBaritonePaused(bot, () => call('window.open', {
      x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z),
    }))
    const win = adoptWindow(bot, r)
    win.close = () => bot.closeWindow(win)
    win.withdraw = async (itemType, metadata, count, nbt) => {
      if (bot.inventory.emptySlotCount() === 0) throw new Error('Unable to withdraw, Bot inventory is full.')
      await bot.transfer({
        window: win, itemType, metadata, count, nbt,
        sourceStart: 0, sourceEnd: win.inventoryStart, destStart: win.inventoryStart, destEnd: win.inventoryEnd,
      })
    }
    win.deposit = async (itemType, metadata, count, nbt) => {
      await bot.transfer({
        window: win, itemType, metadata, count, nbt,
        sourceStart: win.inventoryStart, sourceEnd: win.inventoryEnd, destStart: 0, destEnd: win.inventoryStart,
      })
    }
    return win
  }

  // ponytail: blocks only — no logic site opens an entity (villager /
  // minecart chest); add {entityId} to window.open when one does.
  bot.openContainer = async (block) => {
    const win = await openBlock(block)
    if (!typeIn(win, CONTAINER_TYPES)) {
      await bot.closeWindow(win)
      throw new Error('Non-container window used as a container: ' + win.type)
    }
    return win
  }
  bot.openChest = bot.openContainer
  bot.openDispenser = bot.openContainer

  // mineflayer furnace.js shape. ponytail: fuel/progress stay null (no
  // window.property wire) — furnace.js reads output growth, never them.
  bot.openFurnace = async (block) => {
    const win = await openBlock(block)
    if (!typeIn(win, FURNACE_TYPES)) {
      await bot.closeWindow(win)
      throw new Error('This is not a furnace-like window')
    }
    win.totalFuel = null
    win.fuel = null
    win.fuelSeconds = null
    win.totalProgress = null
    win.progress = null
    win.progressSeconds = null
    win.inputItem = function () { return this.slots[0] }
    win.fuelItem = function () { return this.slots[1] }
    win.outputItem = function () { return this.slots[2] }
    const take = async (item) => {
      if (!item) throw new Error('furnace: nothing to take')
      await bot.putAway(item.slot)
      return item
    }
    win.takeInput = () => take(win.inputItem())
    win.takeFuel = () => take(win.fuelItem())
    win.takeOutput = () => take(win.outputItem())
    const put = (destSlot, itemType, metadata, count) => bot.transfer({
      window: win, itemType, metadata, count,
      sourceStart: win.inventoryStart, sourceEnd: win.inventoryEnd, destStart: destSlot, destEnd: destSlot + 1,
    })
    win.putInput = (itemType, metadata, count) => put(0, itemType, metadata, count)
    win.putFuel = (itemType, metadata, count) => put(1, itemType, metadata, count)
    return win
  }
}

// Mod notifications: a server-opened window, per-slot corrections
// (server confirms/rejects arrive after the click reply), server close.
function handleWindowEvent(bot, method, params) {
  const p = params || {}
  if (method === 'window.open') {
    try { adoptWindow(bot, p) } catch (e) { failLog('window.open event', e) }
    return true
  }
  if (method === 'window.slot') {
    const win = bot.currentWindow
    if (!win || win.id !== p.windowId || typeof p.slot !== 'number') return true
    const wire = p.item ? { ...p.item, slot: p.slot } : null
    win.updateSlot(p.slot, makeItem(bot, wire))
    if (p.slot >= win.inventoryStart && p.slot < win.inventoryEnd) {
      const s = p.slot - (win.inventoryStart - PLAYER_INV_START)
      applyInventoryUpdate(bot, { slot: s, item: wire ? { ...wire, slot: s } : null })
    }
    return true
  }
  if (method === 'window.close') {
    const win = bot.currentWindow
    if (win && win.id === p.windowId) finishClose(bot, win)
    return true
  }
  return false
}

module.exports = { installWindows, handleWindowEvent, CONTAINER_TYPES, FURNACE_TYPES }
