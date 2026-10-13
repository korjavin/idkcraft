// idkcraft-neuc.8: inventory/equip/toss for the Baritone-body bridge.
//
// The mod serves inventory.get/select/equip/toss + inventory.update
// (baritone/bridge/PROTOCOL.md, inventory section); this module folds that
// wire into the mineflayer shapes the logic already reads — bot.inventory
// (a prismarine-windows-shaped window), bot.heldItem, bot.quickBarSlot and
// bot.equip/unequip/toss/tossStack/setQuickBarSlot — so countItems, kitLine,
// fight.equipGear (armor slots 5-8) and craft stack reads run unchanged.
//
// Slot numbering is mineflayer's player-window numbering everywhere on the
// wire: 5-8 armor (head/torso/legs/feet), 9-35 main, 36-44 hotbar, 45
// offhand. items() covers 9-44 only, exactly like v1.
//
// prismarine-windows/prismarine-item are transitive deps (via mineflayer),
// not declared ones, so they load dynamically when resolvable (zero new
// deps, and bridge-body's declared-dep scan stays green); otherwise a
// minimal window/item with the same read surface stands in. This file
// requires nothing outside bot/src/bridge/ (epic section 2).
'use strict'

// Dynamic on purpose: see header (undeclared transitive deps must not be
// static requires here).
function tryLoad(name) {
  try { return require(name) } catch (_) { return null }
}

const DEST_SLOTS = { head: 5, torso: 6, legs: 7, feet: 8, 'off-hand': 45 }
const HOTBAR_START = 36

function stripMcPrefix(s) {
  return typeof s === 'string' ? s.replace(/^minecraft:/, '') : s
}

function registryItem(bot, name) {
  try {
    const byName = bot && bot.registry && bot.registry.itemsByName
    return (byName && byName[name]) || null
  } catch (_) { return null }
}

const itemClassCache = new WeakMap()
function itemClassFor(bot) {
  const reg = bot && bot.registry
  if (!reg || typeof reg !== 'object' || !reg.itemsByName || !reg.items) return null
  if (itemClassCache.has(reg)) return itemClassCache.get(reg)
  const load = tryLoad('prismarine-item')
  let cls = null
  try { cls = load ? load(reg) : null } catch (_) { cls = null }
  itemClassCache.set(reg, cls)
  return cls
}

// One wire slot -> one prismarine-item-shaped object (or null). Extra wire
// fields (damage/enchantments/customName) land as plain props: durabilityUsed
// is the field prismarine-item readers expect, enchants mirrors its getter.
function makeItem(bot, wire) {
  if (!wire || typeof wire !== 'object') return null
  const name = stripMcPrefix(wire.name)
  if (!name || typeof wire.count !== 'number' || wire.count <= 0) return null
  const entry = registryItem(bot, name)
  const type = typeof wire.type === 'number' ? wire.type : (entry ? entry.id : -1)
  const Item = itemClassFor(bot)
  let item = null
  if (Item && type >= 0) {
    try { item = new Item(type, wire.count, 0) } catch (_) { item = null }
  }
  if (!item) {
    item = {
      type,
      count: wire.count,
      metadata: 0,
      nbt: null,
      name,
      displayName: (entry && entry.displayName) || name,
      stackSize: (entry && entry.stackSize) || 64,
    }
  }
  item.slot = wire.slot
  if (typeof wire.damage === 'number') item.durabilityUsed = wire.damage
  if (typeof wire.maxDamage === 'number' && wire.maxDamage > 0) item.maxDurability = wire.maxDamage
  if (Array.isArray(wire.enchantments)) {
    // prismarine-item's enchants setter/getter speak {name: bare, lvl}.
    try { item.enchants = wire.enchantments.map((e) => ({ name: stripMcPrefix(e.name), lvl: e.level })) } catch (_) { /* unknown enchant: reads empty */ }
  }
  if (typeof wire.customName === 'string' && wire.customName) item.customName = wire.customName
  return item
}

// Minimal window with the prismarine-windows read surface the logic uses,
// for when the real package (or a full registry) is unavailable.
class MinimalWindow {
  constructor() {
    this.id = 0
    this.type = 'minecraft:inventory'
    this.title = 'Inventory'
    this.slots = new Array(46).fill(null)
    this.inventoryStart = 9
    this.inventoryEnd = 45
    this.hotbarStart = HOTBAR_START
    this.selectedItem = null
  }

  updateSlot(slot, item) {
    if (item) item.slot = slot
    this.slots[slot] = item || null
  }

  items() {
    const out = []
    for (let i = this.inventoryStart; i < this.inventoryEnd; i++) if (this.slots[i]) out.push(this.slots[i])
    return out
  }

  count(itemType, metadata) {
    let n = 0
    for (let i = this.inventoryStart; i < this.inventoryEnd; i++) {
      const it = this.slots[i]
      if (it && it.type === itemType && (metadata == null || it.metadata === metadata)) n += it.count
    }
    return n
  }

  emptySlotCount() {
    let n = 0
    for (let i = this.inventoryStart; i < this.inventoryEnd; i++) if (!this.slots[i]) n++
    return n
  }

  firstEmptySlotRange(start, end) {
    for (let i = start; i < end; i++) if (!this.slots[i]) return i
    return null
  }

  firstEmptyInventorySlot(hotbarFirst = true) {
    if (hotbarFirst) {
      const s = this.firstEmptySlotRange(this.hotbarStart, this.inventoryEnd)
      if (s !== null) return s
    }
    return this.firstEmptySlotRange(this.inventoryStart, this.inventoryEnd)
  }

  findItemRange(start, end, itemType, metadata, notFull) {
    for (let i = start; i < end; i++) {
      const it = this.slots[i]
      if (it && it.type === itemType && (metadata == null || it.metadata === metadata) &&
        (!notFull || it.count < it.stackSize)) return it
    }
    return null
  }

  findItemRangeName(start, end, itemName, metadata, notFull) {
    for (let i = start; i < end; i++) {
      const it = this.slots[i]
      if (it && it.name === itemName && (metadata == null || it.metadata === metadata) &&
        (!notFull || it.count < it.stackSize)) return it
    }
    return null
  }

  findItemsRange(start, end, itemType, metadata, notFull) {
    const out = []
    for (let i = start; i < end; i++) {
      const it = this.slots[i]
      if (it && (typeof itemType === 'string' ? it.name === itemType : it.type === itemType) &&
        (metadata == null || it.metadata === metadata) && (!notFull || it.count < it.stackSize)) out.push(it)
    }
    return out
  }

  findInventoryItem(item, metadata, notFull) {
    return typeof item === 'string'
      ? this.findItemRangeName(this.inventoryStart, this.inventoryEnd, item, metadata, notFull)
      : this.findItemRange(this.inventoryStart, this.inventoryEnd, item, metadata, notFull)
  }
}

// Only the loaded factory is cached per registry — never the window
// itself: windows hold mutable per-bot slots, and bots sharing a registry
// (every createBot on the same mc version) must not share one (revmux 01).
const windowFactoryCache = new WeakMap()
function makeWindow(bot) {
  const reg = bot && bot.registry
  if (reg && typeof reg === 'object' && reg.itemsByName && typeof reg.supportFeature === 'function') {
    let factory = windowFactoryCache.get(reg)
    if (factory === undefined) {
      const load = tryLoad('prismarine-windows')
      try { factory = load ? load(reg) : null } catch (_) { factory = null }
      windowFactoryCache.set(reg, factory)
    }
    let win = null
    try { win = factory ? factory.createWindow(0, 'minecraft:inventory', 'Inventory') : null } catch (_) { win = null }
    if (win) {
      // prismarine-windows has no emptySlotCount on some versions; v1's
      // window (mineflayer's) does — castle.js reads it guarded, keep parity.
      if (typeof win.emptySlotCount !== 'function') {
        win.emptySlotCount = function () {
          let n = 0
          for (let i = this.inventoryStart; i < this.inventoryEnd; i++) if (!this.slots[i]) n++
          return n
        }
      }
      return win
    }
  }
  return new MinimalWindow()
}

// (Re)build bot.inventory when the registry identity changes (the handshake
// swaps the constructor's placeholder registry for minecraft-data), keeping
// the current slot contents by re-stamping them onto the new window.
function ensureWindow(bot) {
  const reg = (bot && bot.registry) || null
  if (bot.inventory && bot._invRegistry === reg && typeof bot.inventory.updateSlot === 'function') return bot.inventory
  const prev = bot.inventory && Array.isArray(bot.inventory.slots) ? bot.inventory.slots.slice() : []
  const win = makeWindow(bot)
  bot.inventory = win
  bot._invRegistry = reg
  for (let s = 0; s < prev.length && s < win.slots.length; s++) {
    if (prev[s]) win.updateSlot(s, prev[s])
  }
  syncHeld(bot)
  return win
}

function syncHeld(bot) {
  const win = bot.inventory
  const sel = typeof bot.quickBarSlot === 'number' ? bot.quickBarSlot : 0
  bot.heldItem = (win && win.slots[HOTBAR_START + sel]) || null
  if (win) win.selectedItem = win.selectedItem || null
}

// Full snapshot (inventory.get / op results): {selected, slots:[wire...]}.
// Slots absent from the list read empty — the mod sends every non-empty
// slot, so a missing slot is an emptied one.
function applyInventory(bot, payload) {
  if (!payload || typeof payload !== 'object') return bot
  const win = ensureWindow(bot)
  if (Array.isArray(payload.slots)) {
    const seen = new Set()
    for (const wire of payload.slots) {
      if (!wire || typeof wire.slot !== 'number') continue
      seen.add(wire.slot)
      win.updateSlot(wire.slot, makeItem(bot, wire))
    }
    for (let s = 0; s < win.slots.length; s++) {
      if (win.slots[s] && !seen.has(s)) win.updateSlot(s, null)
    }
  }
  if (typeof payload.selected === 'number') bot.quickBarSlot = payload.selected
  syncHeld(bot)
  // Legacy alias for bridge internals/tests that read the flat list.
  bot._inventory = win.items()
  return bot
}

// One-slot notification (inventory.update): {slot, item:wire|null} (the mod
// also spells the payload {slot, name, count, ...} for a filled slot).
function applyInventoryUpdate(bot, params) {
  const p = params || {}
  if (typeof p.slot !== 'number') return bot
  const win = ensureWindow(bot)
  const wire = p.item !== undefined ? p.item : (p.name ? p : null)
  win.updateSlot(p.slot, wire ? makeItem(bot, { ...wire, slot: p.slot }) : null)
  if (typeof p.selected === 'number') bot.quickBarSlot = p.selected
  syncHeld(bot)
  bot._inventory = win.items()
  return bot
}

function handleInventoryEvent(bot, method, params) {
  if (method !== 'inventory.update') return false
  applyInventoryUpdate(bot, params)
  return true
}

function destSlotFor(bot, dest) {
  if (dest === 'hand') return HOTBAR_START + (typeof bot.quickBarSlot === 'number' ? bot.quickBarSlot : 0)
  const slot = DEST_SLOTS[dest]
  if (slot == null) throw new Error(`invalid destination: ${dest}`)
  return slot
}

// All inventory ops serialise through one chain (fight.js: one mineflayer
// equip is two window clicks sharing a cursor; the mod serialises too, but
// the adapter must not interleave its own verifies either).
function enqueue(bot, fn) {
  const run = (bot._invChain || Promise.resolve()).then(fn, fn)
  bot._invChain = run.then(() => {}, () => {})
  return run
}

function installInventory(bot) {
  bot.quickBarSlot = 0
  bot.heldItem = null
  bot._invRegistry = undefined
  bot.inventory = makeWindow(bot)
  bot._inventory = []
  const transport = bot.transport

  bot.setQuickBarSlot = (n) => {
    if (typeof n !== 'number' || n < 0 || n > 8) throw new Error(`invalid quick bar slot: ${n}`)
    if (bot.quickBarSlot === n) return
    bot.quickBarSlot = n
    syncHeld(bot)
    // Fire-and-forget like chat: a failed select logs, never emits 'error'.
    transport.call('inventory.select', { hotbar: n }).then(
      (r) => { if (r) applyInventory(bot, r) },
      (e) => { console.log(`bridge inventory.select failed: ${(e && e.message) || e}`) },
    )
  }

  bot.equip = (item, dest) => enqueue(bot, async () => {
    let target = item
    if (typeof target === 'number' || typeof target === 'string') {
      target = bot.inventory.findInventoryItem(target)
    }
    if (target == null || typeof target !== 'object') {
      throw new Error('Invalid item object in equip (item is null or typeof item is not object)')
    }
    const destination = dest || 'hand'
    const destSlot = destSlotFor(bot, destination)
    let sourceSlot = typeof target.slot === 'number' ? target.slot : null
    if (sourceSlot == null) {
      const found = bot.inventory.findInventoryItem(typeof target.type === 'number' ? target.type : target.name)
      sourceSlot = found ? found.slot : null
    }
    if (sourceSlot == null) throw new Error('Invalid item object in equip (item is null or typeof item is not object)')
    if (sourceSlot === destSlot) return
    const r = await transport.call('inventory.equip', { slot: sourceSlot, dest: destination })
    if (r) applyInventory(bot, r)
    // Resolve only when the destination really holds the item (the mod
    // checks too; a stale verify here is the adapter's own contract).
    const held = bot.inventory.slots[destSlotFor(bot, destination)]
    if (!held || (typeof target.type === 'number' && target.type >= 0 && held.type !== target.type) ||
      (target.name && held.name !== target.name)) {
      throw new Error(`equip did not land: ${target.name || target.type} not at ${destination}`)
    }
  })

  bot.unequip = (dest) => enqueue(bot, async () => {
    const destination = dest || 'hand'
    if (destination === 'hand') {
      // mineflayer equipEmpty: prefer an empty hotbar slot, else move the
      // held stack to an empty inventory slot, else toss it.
      for (let i = 0; i < 9; i++) {
        if (!bot.inventory.slots[HOTBAR_START + i]) { bot.setQuickBarSlot(i); return }
      }
      const empty = typeof bot.inventory.firstEmptyInventorySlot === 'function'
        ? bot.inventory.firstEmptyInventorySlot(false) : null
      const heldSlot = HOTBAR_START + bot.quickBarSlot
      if (empty != null) {
        const r = await transport.call('inventory.equip', { slot: heldSlot, dest: empty })
        if (r) applyInventory(bot, r)
        return
      }
      if (bot.heldItem) {
        const held = bot.heldItem
        const r = await transport.call('inventory.toss', { slot: held.slot, count: held.count })
        if (r) applyInventory(bot, r)
      }
      return
    }
    const sourceSlot = destSlotFor(bot, destination)
    if (!bot.inventory.slots[sourceSlot]) return
    const empty = typeof bot.inventory.firstEmptyInventorySlot === 'function'
      ? bot.inventory.firstEmptyInventorySlot() : null
    if (empty == null) throw new Error('destination full')
    const r = await transport.call('inventory.equip', { slot: sourceSlot, dest: empty })
    if (r) applyInventory(bot, r)
  })

  bot.toss = (itemType, metadata, count) => enqueue(bot, async () => {
    let remaining = typeof count === 'number' && count > 0 ? Math.floor(count) : Infinity
    const stacks = bot.inventory.items().filter((it) => it &&
      (typeof itemType === 'string' ? it.name === itemType : it.type === itemType) &&
      (metadata == null || it.metadata === metadata))
    if (stacks.length === 0) {
      const name = typeof itemType === 'string' ? itemType : itemType
      throw new Error(`Can't find ${name} in slots [${bot.inventory.inventoryStart} - ${bot.inventory.inventoryEnd}], (item id: ${itemType})`)
    }
    for (const stack of stacks) {
      if (remaining <= 0) break
      const n = Math.min(remaining, stack.count)
      const r = await transport.call('inventory.toss', { slot: stack.slot, count: n })
      if (r) applyInventory(bot, r)
      remaining -= n
    }
  })

  bot.tossStack = (item) => enqueue(bot, async () => {
    if (!item || typeof item.slot !== 'number') throw new Error('tossStack: want an item with a slot')
    const r = await transport.call('inventory.toss', { slot: item.slot, count: item.count })
    if (r) applyInventory(bot, r)
  })

  return bot
}

module.exports = { installInventory, applyInventory, applyInventoryUpdate, handleInventoryEvent, makeItem, MinimalWindow }
