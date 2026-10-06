'use strict'

const { goals } = require('mineflayer-pathfinder')
const Vec3 = require('vec3')
const { NEED_LOGS } = require('../goal')
const { countItems } = require('../perception')

// craft: logs -> planks -> crafting table -> door, one op per tick, async
// with ctx.craftInFlight (same shape as eatInFlight). Registered in
// BEHAVIOURS under 'craft' so the goal arbiter can pick it. Reports via
// ctx.stepStatus. Uses the built-in bot.recipesFor/bot.craft (2x2 grid
// without a table, 3x3 at a placed table block).
// Priority matches feasible(craft) in goal.js exactly: logs>0 crafts even
// a single log (planks are never wasted — the budget needs them all);
// table only when missing everywhere; door only at a placed table.
// A placed table appears only via ctx.home.table (the build step places
// it): a table sitting in the inventory does not unlock the door.
const TABLE_REACH = 4

function tally(bot, suffix) {
  const m = new Map()
  let items = []
  try { items = (bot.inventory && typeof bot.inventory.items === 'function' && bot.inventory.items()) || [] } catch (_) { return m }
  for (const i of items) {
    if (!i || typeof i.name !== 'string' || !i.name.endsWith(suffix)) continue
    const wood = i.name.slice(0, -suffix.length)
    m.set(wood, (m.get(wood) || 0) + (typeof i.count === 'number' ? i.count : 1))
  }
  return m
}

function sortedWoods(m) {
  return [...m.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
}

function itemId(bot, name) {
  const entry = bot.registry && bot.registry.itemsByName && bot.registry.itemsByName[name]
  return entry && typeof entry.id === 'number' ? entry.id : null
}

function recipes(bot, name, table) {
  const id = itemId(bot, name)
  if (id == null || typeof bot.recipesFor !== 'function') return []
  try {
    return bot.recipesFor(id, null, 1, table || null) || []
  } catch (_) {
    return []
  }
}

function dist3(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)
}

function totals(bot) {
  return { logs: countItems(bot, (n) => n.endsWith('_log')), planks: countItems(bot, (n) => n.endsWith('_planks')) }
}

function fail(ctx, item, err) {
  ctx.stepStatus = `failed:craft-${item}`
  try {
    console.error(`craft failed item=${item} error=${err && err.message ? err.message : err}`)
  } catch (_) { /* logging best-effort */ }
}

// gxk: the 2x2 grid hangs bot.craft once an ingredient strands in it.
// mineflayer waits for updateSlot:0 after every click on slots 0..4, but the
// server only sends slot 0 when the result changes — a second log placed
// while planks are already shown stays silent, the op times out after 20 s,
// and the log strands in the grid, invisible to inventory.items() (slots
// 9..44 only). Every later 2x2 craft times out the same way while logs churn
// 14->13 per attempt, looping gather<->craft forever.
const GRID_2X2 = [1, 2, 3, 4]

// Consecutive updateSlot-timeout streak per bot: a repeated silence means the
// model and the server disagree beyond a strandable grid, so the second one
// in a row asks for a full resync. Any success resets the streak.
const gridTimeouts = new WeakMap()

function isSlotTimeout(err) {
  const msg = err && err.message ? String(err.message) : String(err)
  return msg.includes('did not fire within timeout')
}

// Return stranded 2x2 ingredients (and the cursor stack) to the inventory.
// Best-effort per slot and silent-safe: a clearing click whose result is
// unchanged stays silent server-side exactly like the craft click did, so its
// timeout is swallowed — the click itself still applied and the ingredient
// moved. No-ops on slot-less mocks (unit tests without a window model).
// A healthy click answers in a server round-trip; a silent one (result
// unchanged) would eat the full 20 s mineflayer wait. Moving on after 2 s is
// correct — the click was sent and applied at once, only the event is
// missing — and bounds a 4-slot clear to ~8 s, inside equip's 30 s deadline.
const CLEAR_CLICK_BUDGET_MS = 2000

async function budgetedClick(bot, slot) {
  let timer = null
  const budget = new Promise((_, reject) => {
    // ref'd on purpose: cleared in finally below; unref'd it never fires on Node 22
    // when the click is the only thing pending (CI hang, 6x7.5)
    timer = setTimeout(() => reject(new Error('clear-budget')), CLEAR_CLICK_BUDGET_MS)
  })
  try {
    await Promise.race([bot.clickWindow(slot, 0, 1), budget])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function clearGrid(bot) {
  const win = bot && bot.inventory
  if (!win || !Array.isArray(win.slots)) return
  try {
    if (win.selectedItem && typeof bot.putSelectedItemRange === 'function') {
      const start = typeof win.inventoryStart === 'number' ? win.inventoryStart : 9
      const end = typeof win.inventoryEnd === 'number' ? win.inventoryEnd : 45
      await bot.putSelectedItemRange(start, end, win, null)
    }
  } catch (_) { /* cursor homeless: the craft below fails loudly instead */ }
  if (typeof bot.clickWindow !== 'function') return
  for (const slot of GRID_2X2) {
    let item = null
    try { item = win.slots[slot] } catch (_) { item = null }
    if (!item) continue
    try {
      await budgetedClick(bot, slot) // shift-click: grid -> inventory
    } catch (_) { /* silent server (result unchanged): the move still applied */ }
  }
}

// Shared 2x2-safe wrapper (craft.js and equip.js): clear the grid before the
// op and again after any error, so a stranded ingredient returns to items()
// instead of churning the log count; on a repeated slot timeout close the
// bare inventory window so the server resyncs the model. Table (3x3) crafts
// pass through untouched — mineflayer closes the table window on error itself.
// Same-name ingredients the pre-clear is about to return: grid slots 1..4
// plus the cursor stack. Sizes the planks batch so a dirty grid converts
// fully inside one step. Slot-less mocks read 0.
function strandedCount(bot, name) {
  let n = 0
  try {
    const win = bot && bot.inventory
    if (win && Array.isArray(win.slots)) {
      for (const s of GRID_2X2) {
        const it = win.slots[s]
        if (it && it.name === name) n += typeof it.count === 'number' ? it.count : 1
      }
      const cur = win.selectedItem
      if (cur && cur.name === name) n += typeof cur.count === 'number' ? cur.count : 1
    }
  } catch (_) { /* unreadable window: no bonus */ }
  return n
}

// xg9: consecutive window ops must stay a server tick apart. Fired
// back-to-back (0-8 ms), clicks desync mineflayer's inventory model from
// Paper: a later click waits on updateSlot:0 the server never sends that
// way, the op eats the 20 s timeout, and items strand server-side while
// the model marches on (assayed: unpaced 64-log batch broke at op27 with
// a phantom button + vanishing logs; paced 60 ms went 64/64 exact). A
// vanilla client can never click sub-tick either. Applies to table crafts
// too — the gear epic will batch those. Cost: ~60 ms per op.
const WINDOW_OP_GAP_MS = 60
const lastWindowOp = new WeakMap()

async function paceWindowOp(bot) {
  let prev = 0
  try { prev = lastWindowOp.get(bot) || 0 } catch (_) { prev = 0 }
  const wait = WINDOW_OP_GAP_MS - (Date.now() - prev)
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait))
}

// ph7: the phantom table craft. mineflayer picks the FIRST inventory stack
// of each ingredient whatever its size; when it is smaller than the op's
// placement count the cursor runs dry mid-op, a placement goes out on an
// empty server cursor (or the mid-op re-pickup races the pipelined
// placements), the grid never completes, the result grab takes nothing — and
// the op still resolves, because the updateSlot:0 waits are satisfied by
// echo/resync traffic, never by the click's own effect. Assayed live on
// Paper 26.1.2: 28/28 single-pickup door ops landed, 2/2 partial-first-stack
// ops phantomed (server grid missing one plank, mats unspent, no product),
// and the retry lands on a fresh full stack. ensureStacks consolidates each
// ingredient into its first-picked stack before delegating: with the whole
// need in one stack the cursor cannot run dry and the first op lands.
// Fail-open by design: anything unexpected skips consolidation and bot.craft
// behaves exactly as before.
const CONSOLIDATE_ROUNDS = 2
// ponytail: _syncWindow answers in ~1 RTT (the mismatch resync is the
// server's immediate reply); 3 s is the give-up for a dead link, after which
// the op runs unverified exactly as before.
const CONSOLIDATE_SYNC_MS = 3000
// ponytail: fallback when bot._syncWindow is missing (old mineflayer): read
// the model after trailing resyncs had time to land (~RTT; 250 ms covers
// LAN + spikes — raise if phantoms recur on high-RTT links).
const CONSOLIDATE_SETTLE_MS = 250

// Placements per distinct ingredient, mirroring mineflayer's clickShape +
// nextIngredientsClick exactly: shaped cells with id !== -1 plus every
// shapeless entry (a recipe may carry both — clickShape falls through),
// times the op count (iterations re-pick the same first stack).
function placementsFor(recipe, count) {
  const needs = new Map()
  const add = (id, metadata) => {
    if (typeof id !== 'number' || id === -1) return
    const key = `${id}\0${metadata == null ? '' : metadata}`
    const cur = needs.get(key)
    if (cur) cur.need += 1
    else needs.set(key, { id, metadata: metadata == null ? null : metadata, need: 1 })
  }
  try {
    if (recipe && Array.isArray(recipe.inShape)) {
      for (const row of recipe.inShape) {
        if (!Array.isArray(row)) continue
        for (const cell of row) {
          if (cell && typeof cell === 'object') add(cell.id, cell.metadata)
        }
      }
    }
    if (recipe && Array.isArray(recipe.ingredients)) {
      for (const ing of recipe.ingredients) {
        if (ing && typeof ing === 'object') add(ing.id, ing.metadata)
      }
    }
  } catch (_) { return new Map() }
  let n = 1
  try { n = parseInt(count ?? 1, 10) } catch (_) { n = 1 }
  if (!Number.isFinite(n) || n < 0) n = 1
  if (n !== 1) {
    for (const v of needs.values()) v.need *= n
  }
  return needs
}

function firstStack(win, id, metadata) {
  try {
    return win.findInventoryItem(id, metadata) || null
  } catch (_) { return null }
}

// Model truth after our clicks: the _syncWindow resync is queued behind them
// (TCP order) and overwrites any stale trailing packet, so the re-read below
// sees post-click state. Event-driven, no wall clock; the timeout only
// bounds a dead link. Falls back to a settle wait without _syncWindow.
async function syncInventory(bot) {
  const win = bot.inventory
  if (win && typeof bot._syncWindow === 'function') {
    let timer = null
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('consolidate-sync-timeout')), CONSOLIDATE_SYNC_MS) // ref'd, cleared in finally (see budgetedClick)
    })
    try {
      await Promise.race([bot._syncWindow(win), timeout])
    } finally {
      if (timer) clearTimeout(timer)
    }
    return
  }
  await new Promise((resolve) => setTimeout(resolve, CONSOLIDATE_SETTLE_MS))
}

// Merge later same-item stacks into the first-picked slot until it covers
// need. Vanilla left-click merges CURSOR->SLOT, so each donor cycle picks up
// a later stack, dumps it into the first slot, and puts any leftover back
// where the donor was (empty now) — the cursor ends every cycle empty, so no
// click can go out on an empty server cursor here (the failure mode this
// fixes). Slot clicks on the bare inventory carry no mineflayer waits, so the
// whole sequence runs atomically w.r.t. server packets and the slot list
// stays valid throughout; the post-round sync re-reads truth. Caps at one
// full stack (callers craft count=1, need <= 9); anything more stays short
// and crafts unverified, as before.
async function consolidateOne(bot, win, id, metadata, need) {
  if (win.selectedItem) return // foreign cursor: bail, the verify decides
  const start = typeof win.inventoryStart === 'number' ? win.inventoryStart : 9
  const end = typeof win.inventoryEnd === 'number' ? win.inventoryEnd : 45
  let stacks = []
  try {
    stacks = win.findItemsRange(start, end, id, metadata) || []
  } catch (_) { return }
  if (stacks.length === 0) return
  const slot = stacks[0].slot
  const at = () => {
    const o = win.slots[slot]
    return o && typeof o.count === 'number' ? o.count : 0
  }
  const first = win.slots[slot]
  const cap = first && typeof first.stackSize === 'number' ? first.stackSize : 64
  for (let i = 1; i < stacks.length; i++) {
    const have = at()
    if (have >= need || have >= cap) break
    await bot.clickWindow(stacks[i].slot, 0, 0) // pick up donor
    if (!win.selectedItem) break // didn't take: stop, the verify decides
    await bot.clickWindow(slot, 0, 0) // dump into first
    if (win.selectedItem) await bot.clickWindow(stacks[i].slot, 0, 0) // leftover back
  }
}

async function ensureStacks(bot, recipe, count) {
  const win = bot && bot.inventory
  if (!win || !Array.isArray(win.slots)) return
  if (bot.currentWindow) return // clicks would land in the open window, not the inventory
  if (typeof bot.clickWindow !== 'function') return
  if (typeof win.findInventoryItem !== 'function' || typeof win.findItemsRange !== 'function') return
  if (win.selectedItem) return // foreign cursor: don't touch
  let needs = null
  try {
    needs = placementsFor(recipe, count)
  } catch (_) { return }
  if (!needs || needs.size === 0) return
  const covered = () => {
    for (const v of needs.values()) {
      const f = firstStack(win, v.id, v.metadata)
      const n = f && typeof f.count === 'number' ? f.count : 0
      if (n < v.need) return false
    }
    return true
  }
  if (covered()) return // fast path: zero clicks, zero waits
  for (let round = 0; round < CONSOLIDATE_ROUNDS; round++) {
    for (const v of needs.values()) {
      try {
        await consolidateOne(bot, win, v.id, v.metadata, v.need)
      } catch (_) { /* this ingredient stays fragmented */ }
    }
    try { await syncInventory(bot) } catch (_) { /* unverified: the re-read below decides */ }
    if (covered()) return
  }
  try { console.error('craft consolidate short: first stack below need, crafting anyway') } catch (_) { /* logging best-effort */ }
}

// rwuu: a full pack tosses the craft product. mineflayer's grabResult ->
// putAway -> putSelectedItemRange finds no stack with room and no empty
// slot, clicks -999 (tossLeftover), and the op still resolves — the
// ingredients are spent, the product lies on the ground, and a full pack
// never picks it up. Every craft through here first ensures room for the
// result: a chest near home banks the junk through the stockpile deposit
// path (owner 2026-10-06), else one junk stack is tossed, else the op
// fails 'inventory-full' — an honest reason, never a phantom craft.

// Toss order, cheapest first (owner 2026-10-06: leaf litter, gravel,
// saplings, seeds, spare bows/arrows — never tools, armour, food or
// castle materials). -1 is not junk.
function junkRank(name) {
  if (typeof name !== 'string') return -1
  if (name === 'leaf_litter') return 0
  if (name === 'gravel') return 1
  if (name.endsWith('_seeds') || name === 'pitcher_pod') return 2
  if (name.endsWith('_sapling') || name === 'mangrove_propagule') return 3
  if (name === 'bow') return 4
  if (name === 'arrow') return 5
  return -1
}

// A junk name the open castle still wants is not junk (stockpile.js
// castle-reserve mirror). Deferred require (the castle chain).
function castleWants(name, ctx) {
  try {
    if (!ctx || !ctx.castle || ctx.castle.phase === 'complete') return false
    return !!require('./castle').isMaterial(name, ctx.castle)
  } catch (_) {
    return false
  }
}

function invStacks(bot) {
  try {
    const items = bot && bot.inventory && typeof bot.inventory.items === 'function' ? bot.inventory.items() : null
    return Array.isArray(items) ? items : null
  } catch (_) {
    return null
  }
}

function emptySlots(bot, stacks) {
  try {
    const win = bot && bot.inventory
    if (win && Array.isArray(win.slots)) {
      const start = typeof win.inventoryStart === 'number' ? win.inventoryStart : 9
      const end = typeof win.inventoryEnd === 'number' ? win.inventoryEnd : 45
      let n = 0
      for (let s = start; s < end; s++) if (!win.slots[s]) n++
      return n
    }
  } catch (_) { /* slot-less mock: fall through to the count */ }
  return stacks ? Math.max(0, 36 - stacks.length) : null
}

// The result the craft is about to place: name (recipe result, the
// registry, or the caller's item), stack size (registry, tools unstackable)
// and per-op yield. Anything unreadable degrades to a 1-count unknown.
function resultOf(bot, recipe, item) {
  let id = null
  let count = 1
  let name = typeof item === 'string' && item ? item : null
  try {
    const r = recipe && recipe.result
    if (r && typeof r === 'object') {
      if (typeof r.id === 'number') id = r.id
      if (typeof r.count === 'number' && r.count > 0) count = Math.floor(r.count)
      if (typeof r.name === 'string' && r.name) name = r.name
    }
  } catch (_) { /* unreadable recipe */ }
  if (!name && id != null) {
    try {
      const entry = bot && bot.registry && bot.registry.items && bot.registry.items[id]
      if (entry && typeof entry.name === 'string') name = entry.name
    } catch (_) { /* nameless */ }
  }
  let size = 64
  try {
    const byId = id != null && bot.registry && bot.registry.items && bot.registry.items[id]
    const byName = !byId && name && bot.registry && bot.registry.itemsByName && bot.registry.itemsByName[name]
    const ss = (byId && byId.stackSize) || (byName && byName.stackSize)
    if (typeof ss === 'number' && ss > 0) size = Math.floor(ss)
    else if (name && /_(sword|pickaxe|axe|shovel|hoe|helmet|chestplate|leggings|boots)$/.test(name)) size = 1
    else if (name === 'bow' || name === 'crossbow' || name === 'trident' || name === 'shield' || name === 'bucket' || name === 'water_bucket' || name === 'flint_and_steel' || name === 'shears') size = 1
  } catch (_) { /* 64 */ }
  return { name, size, count }
}

// Ingredient slots the op frees: mineflayer lifts each ingredient stack
// into the grid before the result is grabbed, so a stack the op fully
// consumes is an empty slot by grab time. Walked per ingredient in
// inventory order exactly like the consumption (a stack at or under the
// remaining need frees, the first partial ends the walk). Under-counts on
// ambiguity (unknown recipe, metadata mismatch): the safe direction is a
// needless toss, never a tossed product.
function freedStacks(bot, stacks, recipe, opCount) {
  let needs = null
  try {
    needs = placementsFor(recipe, opCount)
  } catch (_) { return 0 }
  if (!needs || needs.size === 0) return 0
  // Registry id -> name (mocks carry names, not types).
  const nameOf = (id) => {
    try {
      const byId = bot && bot.registry && bot.registry.items && bot.registry.items[id]
      if (byId && typeof byId.name === 'string') return byId.name
      const byName = bot && bot.registry && bot.registry.itemsByName
      if (byName) for (const n of Object.keys(byName)) {
        const e = byName[n]
        if (e && e.id === id) return n
      }
    } catch (_) { /* nameless */ }
    return null
  }
  let freed = 0
  for (const v of needs.values()) {
    const nm = nameOf(v.id)
    let left = v.need
    for (const s of stacks) {
      if (left <= 0) break
      if (!s) continue
      const same = typeof s.type === 'number' ? s.type === v.id : (nm != null && s.name === nm)
      if (!same) continue
      if (v.metadata != null) {
        let sm = null
        try { sm = s.metadata } catch (_) { sm = null }
        if (sm !== v.metadata) continue
      }
      const c = typeof s.count === 'number' ? s.count : 1
      if (c <= left) {
        freed++
        left -= c
      } else break
    }
  }
  return freed
}

// Capacity for the result: same-name stacks with room plus empty slots
// plus ingredient slots the op frees, mirroring putSelectedItemRange
// (stack first, empty slot next, toss when neither). True/false; null
// when the inventory is unreadable (fail open: the craft proceeds
// exactly as before).
function roomFor(bot, res, opCount, recipe) {
  const stacks = invStacks(bot)
  if (!stacks) return null
  let n = 1
  try { n = parseInt(opCount ?? 1, 10) } catch (_) { n = 1 }
  if (!Number.isFinite(n) || n < 1) n = 1
  const need = (res.count || 1) * n
  let free = 0
  if (res.name) {
    for (const s of stacks) {
      if (!s || s.name !== res.name) continue
      const cap = s && typeof s.stackSize === 'number' && s.stackSize > 0 ? s.stackSize : res.size
      free += Math.max(0, cap - (typeof s.count === 'number' ? s.count : 1))
      if (free >= need) return true
    }
  }
  const empty = emptySlots(bot, stacks)
  if (empty == null) return null
  return free + (empty + freedStacks(bot, stacks, recipe, n)) * res.size >= need
}

function cursorOccupied(bot) {
  try {
    return !!(bot && bot.inventory && bot.inventory.selectedItem)
  } catch (_) {
    return false
  }
}

// Keep-best score for spare selection: an enchanted/named stack outranks
// a plain one, so the tossed/banked spare is the worse bow.
function keepScore(s) {
  try {
    return s && s.nbt != null ? 1 : 0
  } catch (_) {
    return 0
  }
}

// Every junk stack the room guarantee may remove, cheapest first (shared
// by the bank and toss branches): all fungible junk plus every bow/arrow
// stack but the best. Best = enchanted/named over plain, ties to the
// first in inventory order. Bow/arrow spares go by EXACT slot —
// type-based removal takes first stacks and could drop the kept,
// possibly owner-given bow (verifier P2).
function spareStacks(bot, ctx) {
  const out = []
  const bow = []
  const arrow = []
  for (const s of invStacks(bot) || []) {
    if (!s || typeof s.name !== 'string') continue
    const rank = junkRank(s.name)
    if (rank < 0 || castleWants(s.name, ctx)) continue
    if (s.name === 'bow') { bow.push(s); continue }
    if (s.name === 'arrow') { arrow.push(s); continue }
    out.push({ s, rank })
  }
  for (const group of [bow, arrow]) {
    if (group.length === 0) continue
    let best = 0
    for (let i = 1; i < group.length; i++) {
      if (keepScore(group[i]) > keepScore(group[best])) best = i
    }
    group.forEach((s, i) => { if (i !== best) out.push({ s, rank: junkRank(s.name) }) })
  }
  out.sort((a, b) => a.rank - b.rank)
  return out
}

function junkTotal(bot, ctx) {
  let n = 0
  for (const s of invStacks(bot) || []) {
    if (!s || typeof s.name !== 'string' || junkRank(s.name) < 0 || castleWants(s.name, ctx)) continue
    n += typeof s.count === 'number' && s.count > 0 ? Math.floor(s.count) : 1
  }
  return n
}

// Player-window slot -> open-container slot (the player section sits past
// the container slots). Null when unmappable: the caller skips the stack.
function chestSlot(bot, window, slot) {
  try {
    const base = bot && bot.inventory && typeof bot.inventory.inventoryStart === 'number' ? bot.inventory.inventoryStart : 9
    const start = window && typeof window.inventoryStart === 'number' ? window.inventoryStart : null
    if (start == null || typeof slot !== 'number') return null
    return start + (slot - base)
  } catch (_) {
    return null
  }
}

function stackType(bot, s) {
  if (s && typeof s.type === 'number') return s.type
  try {
    const entry = bot.registry && bot.registry.itemsByName && bot.registry.itemsByName[s.name]
    return entry && entry.id
  } catch (_) {
    return null
  }
}

function stackCount(s) {
  return s && typeof s.count === 'number' && s.count > 0 ? Math.floor(s.count) : 1
}

async function ensureRoom(bot, recipe, count, opts) {
  const res = resultOf(bot, recipe, opts && opts.item)
  if (roomFor(bot, res, count, recipe) !== false) return
  // No room with a foreign cursor item held: removal clicks would swap
  // onto it (mis-toss) and post-bank room reads would lie — fail
  // honestly instead. clearGrid already tried to put it back, so a stuck
  // one means no room anyway. With room the craft proceeds as before.
  if (cursorOccupied(bot)) throw new Error('inventory-full')
  const ctx = opts && opts.ctx
  // Chest first: an adopted chest within reach banks the junk through the
  // stockpile window path. A far or unreadable chest skips silently — a
  // mid-craft walk would stall the op on the window timeout.
  if (ctx) {
    try {
      const c = ctx.home && ctx.home.chest
      const bp = bot && bot.entity && bot.entity.position
      if (c && typeof c.x === 'number' && bp && typeof bp.x === 'number') {
        const stockpile = require('./stockpile')
        const reach = stockpile.INTERACT_REACH || 4
        if (Math.hypot(bp.x - c.x, bp.y - c.y, bp.z - c.z) <= reach) {
          const spares = spareStacks(bot, ctx)
          if (spares.length > 0 && typeof stockpile.withChest === 'function') {
            const before = junkTotal(bot, ctx)
            await stockpile.withChest(bot, ctx, async (window) => {
              try {
                // Fungible junk by type (stacks identical: first-match harmless).
                const fung = new Map()
                for (const { s } of spares) {
                  if (s.name === 'bow' || s.name === 'arrow') continue
                  const e = fung.get(s.name) || { total: 0, type: null }
                  e.total += stackCount(s)
                  if (e.type == null) e.type = stackType(bot, s)
                  fung.set(s.name, e)
                }
                for (const e of fung.values()) {
                  if (typeof e.type !== 'number' || !(e.total > 0)) continue
                  try {
                    await window.deposit(e.type, null, e.total)
                  } catch (_) { /* full or unmovable: keep the rest */ }
                }
                // Bow/arrow spares by exact slot: the spare goes to the
                // cursor first, then deposit places the pre-loaded cursor
                // without re-picking (a re-pick would take the kept best).
                for (const { s } of spares) {
                  if (s.name !== 'bow' && s.name !== 'arrow') continue
                  const wslot = chestSlot(bot, window, s.slot)
                  const type = stackType(bot, s)
                  if (wslot == null || typeof type !== 'number' || typeof bot.clickWindow !== 'function') continue
                  const n = stackCount(s)
                  try {
                    await bot.clickWindow(wslot, 0, 0)
                    const cur = window.selectedItem
                    if (!cur || cur.type !== type || cur.count !== n) {
                      // Pickup missed (stale slot): put the cursor back
                      // where it came from and leave this spare packed.
                      try {
                        if (typeof bot.putSelectedItemRange === 'function') {
                          await bot.putSelectedItemRange(window.inventoryStart, window.inventoryEnd, window, wslot)
                        }
                      } catch (_) { /* cursor homeless: the finally below retries */ }
                      continue
                    }
                    await window.deposit(type, cur.metadata, n, cur.nbt)
                  } catch (_) { /* full: the finally returns the cursor */ }
                }
              } finally {
                // A failed deposit (chest full) strands the pickup on the
                // cursor, which close() does NOT copy back — the model
                // would read false room and the craft could toss its
                // product (verifier P1). Put it back in the player
                // section: its source slot is empty, so this never tosses.
                try {
                  if (window.selectedItem && typeof bot.putSelectedItemRange === 'function') {
                    await bot.putSelectedItemRange(window.inventoryStart, window.inventoryEnd, window, null)
                  }
                } catch (_) { /* homeless cursor: the recount below stays truthful */ }
              }
            })
            // Post-close truth: the resync lands behind the close (TCP
            // order), so a lagging model cannot read false room either.
            try {
              await syncInventory(bot)
            } catch (_) { /* unverified: the recount below still decides */ }
            const put = Math.max(0, before - junkTotal(bot, ctx))
            if (put > 0) {
              try { console.log(`craft banked ${put} junk to the home chest to make room`) } catch (_) { /* logging best-effort */ }
            }
            if (roomFor(bot, res, count, recipe) !== false) return
          }
        }
      }
    } catch (_) { /* banking failed: fall through to the toss */ }
  }
  // No chest: toss one junk stack at a time, cheapest first, re-checking
  // after each. Every stack tosses at most once, so a silent no-op can
  // never loop. Bow/arrow spares toss by exact slot; anything else may
  // fall back to type-based toss (fungible: first-match harmless).
  for (const { s } of spareStacks(bot, ctx)) {
    if (cursorOccupied(bot)) break // never swap-misdrop onto a live cursor
    const n = stackCount(s)
    const exact = typeof s.slot === 'number' && typeof bot.tossStack === 'function'
    const fungible = s.name !== 'bow' && s.name !== 'arrow'
    try {
      if (exact) await bot.tossStack(s)
      else if (fungible && typeof bot.toss === 'function') {
        const id = stackType(bot, s)
        if (typeof id !== 'number') continue
        await bot.toss(id, null, n)
      } else continue // bow/arrow without an exact slot: kept, never type-tossed
    } catch (_) { continue }
    // Drain our own cursor (the entry guard keeps foreign cursors out, so
    // this is always the junk just picked up — never a swap victim).
    let guard = 0
    while (cursorOccupied(bot) && guard++ < 2) {
      try {
        if (typeof bot.clickWindow !== 'function') break
        await bot.clickWindow(-999, 0, 0)
      } catch (_) { break }
    }
    if (cursorOccupied(bot)) break
    try { console.log(`craft tossed ${n} ${s.name} to make room`) } catch (_) { /* logging best-effort */ }
    if (roomFor(bot, res, count, recipe) !== false) return
  }
  throw new Error('inventory-full')
}

// g0z.25: compact one-line pack + cursor dump for stall logs (the next
// review's desync-vs-loss oracle): name×count per stack plus the cursor,
// which items() never shows. Best-effort 'unreadable', never throws.
function slotSummary(bot) {
  try {
    const win = bot && bot.inventory
    const items = win && typeof win.items === 'function' ? win.items() : null
    if (!Array.isArray(items)) return 'unreadable'
    const parts = []
    for (const i of items) {
      if (!i || typeof i.name !== 'string') continue
      const c = typeof i.count === 'number' ? i.count : 1
      parts.push(typeof i.slot === 'number' ? `${i.name}x${c}@${i.slot}` : `${i.name}x${c}`)
    }
    let cursor = null
    try {
      const cur = win.selectedItem
      if (cur && typeof cur.name === 'string') cursor = `${cur.name}x${typeof cur.count === 'number' ? cur.count : 1}`
    } catch (_) { cursor = null }
    return `[${parts.join(' ')}] cursor=${cursor}`
  } catch (_) {
    return 'unreadable'
  }
}

// g0z.25: the intra-craft click burst. mineflayer fires a table craft's
// ingredient clicks in ~5 ms and sync+closes right after; Paper 26.1.2
// silently reverts most such bursts (mats back, no product, the op still
// resolves — assayed 3/8 landed unpaced, 8/8 with 60 ms gaps, same xg9
// per-tick shape one grain finer). bot.craft looks bot.clickWindow up per
// ingredient click, so a gap enforcer around the call paces those;
// restored in finally (a foreign mid-craft overwrite is never clobbered
// back). The put-away/result-grab tail (bot.putAway, bot.putSelectedItem-
// Range) calls inventory.js's private click closure and stays unpaced —
// assayed sufficient as is; wrap those too if tail reverts ever show up.
// Table crafts only: 2x2 clicks already serialize on updateSlot:0 waits,
// their cursor churn heals in 600 ms, and pacing them would slow batches.
async function pacedCraft(bot, recipe, count, table) {
  const orig = bot && bot.clickWindow
  if (!table || typeof orig !== 'function' || typeof bot.craft !== 'function') {
    return bot.craft(recipe, count, table)
  }
  let last = 0
  const paced = async (...args) => {
    const wait = WINDOW_OP_GAP_MS - (Date.now() - last)
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait))
    try {
      return await orig.apply(bot, args)
    } finally {
      last = Date.now()
    }
  }
  bot.clickWindow = paced
  try {
    return await bot.craft(recipe, count, table)
  } finally {
    try {
      if (bot.clickWindow === paced) bot.clickWindow = orig
    } catch (_) { /* restore best-effort */ }
  }
}

async function safeCraft(bot, recipe, count, table, opts) {
  await paceWindowOp(bot)
  if (!table) await clearGrid(bot)
  await ensureStacks(bot, recipe, count)
  await ensureRoom(bot, recipe, count, opts)
  try {
    await pacedCraft(bot, recipe, count, table)
  } catch (err) {
    if (!table) {
      await clearGrid(bot)
      if (isSlotTimeout(err)) {
        const n = (gridTimeouts.get(bot) || 0) + 1
        gridTimeouts.set(bot, n)
        if (n >= 2 && !bot.currentWindow && typeof bot.closeWindow === 'function') {
          try { await bot.closeWindow(bot.inventory) } catch (_) { /* resync best-effort */ }
        }
      }
    }
    throw err
  } finally {
    try { lastWindowOp.set(bot, Date.now()) } catch (_) { /* pacing best-effort */ }
  }
  if (!table) gridTimeouts.set(bot, 0)
}

function craft(bot, ctx, target, state) {
  if (ctx.craftInFlight) return // exactly one op at a time (mutation: a craft every tick overlaps windows)
  const bp = bot.entity && bot.entity.position
  if (!bp) return
  const logs = tally(bot, '_log')
  const planks = tally(bot, '_planks')
  // The equip step's placed station doubles (atl.6): without it a placed
  // table the menu knows (tablePlaced) still reads as no station here, and
  // the table branch below rebuilds one from planks every cycle. Verified
  // once: a ghost claim (mined table) reads as no station, so the table
  // branch rebuilds instead of the door branch walking to nothing forever.
  // First verified-standing of home.table / claimedTable (h9z): reads are
  // Vec3-normalised (a plain claim throws inside prismarine-world, prod:
  // 20 extra tables in 12 h) and a ghost home claim (mined table) must not
  // shadow the equip step's standing roadside table (rig: the door branch
  // below never fired while the table branch rebuilt).
  let tableBlock = null
  let tablePos = null
  for (const cand of [(ctx.home && ctx.home.table), (ctx && ctx.claimedTable)]) {
    if (!cand || typeof cand.x !== 'number') continue
    let b = null
    try { b = bot.blockAt && bot.blockAt(new Vec3(cand.x, cand.y, cand.z)) } catch (_) { b = null }
    if (b && b.name === 'crafting_table') { tableBlock = b; tablePos = cand; break }
  }
  // 8cx: every wood converts in one step — the batch gate (logs >=
  // NEED_LOGS) closes after the first wood, so a second-wood remainder
  // otherwise never converts and holds gather feasible forever.
  const ops = []
  for (const [wood, n] of sortedWoods(logs)) {
    const name = `${wood}_planks`
    const found = recipes(bot, name, null)
    if (found.length > 0) ops.push({ item: name, recipe: found[0], count: n + strandedCount(bot, `${wood}_log`), table: null }) // batch = visible stack + stranded (run() still calls bot.craft with count=1)
  }
  let op = ops[0] || null
  if (!op) {
    const tableCount = countItems(bot, (n) => n === 'crafting_table')
    if (tableCount === 0 && !tableBlock) {
      for (const [wood, n] of sortedWoods(planks)) {
        if (n < 4) break
        const found = recipes(bot, 'crafting_table', null)
        if (found.length > 0) { op = { item: 'crafting_table', recipe: found[0], count: 1, table: null }; break }
      }
    }
  }
  if (!op) {
    const doorCount = countItems(bot, (n) => n.endsWith('_door'))
    if (doorCount === 0 && tableBlock) {
      if (dist3(bp, tablePos) <= TABLE_REACH) {
        for (const [wood, n] of sortedWoods(planks)) {
          if (n < 6) break
          const name = `${wood}_door`
          const found = recipes(bot, name, tableBlock)
          if (found.length > 0) { op = { item: name, recipe: found[0], count: 1, table: tableBlock }; break }
        }
      } else {
        const key = `craft-table:${tablePos.x},${tablePos.y},${tablePos.z}`
        if (key !== ctx.lastGoalKey) {
          bot.pathfinder.setGoal(new goals.GoalNear(tablePos.x, tablePos.y, tablePos.z, 3), false)
          ctx.lastGoalKey = key
        }
        return // walk into reach, then craft on a later tick
      }
    }
  }
  if (!op) {
    let total = 0
    let first = null
    for (const [wood, n] of sortedWoods(logs)) {
      total += n
      if (!first) first = wood
    }
    if (total >= NEED_LOGS && first) {
      fail(ctx, `${first}_planks`, new Error('no planks recipe for this wood'))
      return
    }
    ctx.stepStatus = 'done'
    return
  }
  if (typeof bot.craft !== 'function') {
    fail(ctx, op.item, new Error('bot.craft missing'))
    return
  }
  ctx.craftInFlight = true
  const run = async () => {
    for (const o of (ops.length > 0 ? ops : [op])) {
      // The planks batch sizes from the model at selection; a ghost grid entry
      // (counted, then wiped by a server correction) would over-count. Stop at
      // exhaustion instead of failing the fully converted load as missing
      // ingredient (revmux round-2). Single ops (table/door) loop once.
      const batchWood = o.item.endsWith('_planks') ? o.item.slice(0, -'_planks'.length) : null
      let done = 0
      try {
        // Batch at step level, one log per call: a single bot.craft(count=n)
        // dies on the first silent click and strands the rest, while one op per
        // log re-decides to gather at 13 logs. craftInFlight holds the step for
        // the whole batch (goal.js), so mid-batch churn never re-decides.
        for (let i = 0; i < o.count; i++) {
          if (i > 0 && batchWood && (tally(bot, '_log').get(batchWood) || 0) === 0) break
          await safeCraft(bot, o.recipe, 1, o.table, { ctx, item: o.item })
          done++
        }
      } catch (err) {
        ctx.craftInFlight = false
        fail(ctx, o.item, err)
        return
      }
      const t = totals(bot)
      const made = done * ((o.recipe.result && o.recipe.result.count) || 1)
      try { bot.chat(`crafted ${made} ${o.item} (planks ${t.planks}, logs ${t.logs})`) } catch (_) { /* chat best-effort */ }
    }
    ctx.craftInFlight = false
  }
  void run()
}

module.exports = craft
// Shared crafting primitives for the equip step (atl.6): recipe lookup and
// the table reach. Same dual-export shape as fight.equipGear.
module.exports.itemId = itemId
module.exports.recipes = recipes
module.exports.tally = tally
module.exports.sortedWoods = sortedWoods
module.exports.TABLE_REACH = TABLE_REACH
module.exports.safeCraft = safeCraft
module.exports.syncInventory = syncInventory
module.exports.slotSummary = slotSummary
module.exports.WINDOW_OP_GAP_MS = WINDOW_OP_GAP_MS
