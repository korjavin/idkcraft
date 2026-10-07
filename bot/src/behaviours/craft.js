'use strict'

const { goals } = require('mineflayer-pathfinder')
const Vec3 = require('vec3')
const { NEED_LOGS } = require('../goal')
const { countItems } = require('../perception')
const { isStone } = require('../castle')

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
// result: a chest in reach banks the junk and the above-ceiling wood
// (g0z.26) through the stockpile deposit path, else the op fails
// 'inventory-full' — an honest reason, never a phantom craft. The bot never
// throws anything away (owner 2026-10-06): the old 'no chest → toss junk'
// fallback is gone — a failed op holds, and the stockpile step (or deliver
// to the owner) drains the pack instead.

// Bank order, cheapest first (owner 2026-10-06: leaf litter, gravel,
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
// Registry id -> name (mocks carry names, not types).
function nameOfId(bot, id) {
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
// The recipe's ingredient names: a free-slot drop/shed never takes them
// (vmzq.38 revmux 01: shedding the pickaxe's own cobble failed the craft).
function ingredientNames(bot, recipe) {
  const out = new Set()
  try {
    for (const v of placementsFor(recipe, 1).values()) {
      const n = nameOfId(bot, v.id)
      if (n) out.add(n)
    }
  } catch (_) { /* none known */ }
  return out
}
function freedStacks(bot, stacks, recipe, opCount) {
  let needs = null
  try {
    needs = placementsFor(recipe, opCount)
  } catch (_) { return 0 }
  if (!needs || needs.size === 0) return 0
  const nameOf = (id) => nameOfId(bot, id)
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
// exactly as before). roomDetail exposes the breakdown for the
// reserved-slot rule below; roomFor keeps the old boolean shape.
function roomDetail(bot, res, opCount, recipe) {
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
      if (free >= need) break
    }
  }
  const empty = emptySlots(bot, stacks)
  if (empty == null) return null
  return { need, free, empty, freed: freedStacks(bot, stacks, recipe, n), size: res.size }
}
function roomFor(bot, res, opCount, recipe) {
  const d = roomDetail(bot, res, opCount, recipe)
  if (!d) return null
  return d.free + (d.empty + d.freed) * d.size >= d.need
}
// The craft takes the last empty slot: room holds only because of it.
// Conversions that stack onto room and exact-consumptions never do.
function consumesLastSlot(detail) {
  return !!detail && detail.empty === 1 && detail.free + detail.freed * detail.size < detail.need
}
// Reserved-slot rule (g0z.26 R2, revmux 01 major): with no adopted chest and
// nobody online the last pack slot belongs to the bootstrap chest craft —
// any other craft that would consume it fails here instead of filling the
// pack past the point of no drain. The chest craft and the table it is
// crafted at (chest infrastructure) are exempt. Fail-open: anything
// unreadable crafts exactly as before.
const RESERVE_EXEMPT = new Set(['chest', 'crafting_table'])
// Bootstrap shed (g0z.26 R3, revmux 02 major): the 36/36 exit. Prevention
// alone cannot hold the reserve — ambient pickups (fight/hunt drops,
// spoil) bypass every dig gate — so a funded bootstrap craft (chest, or
// the table it needs) at zero empties sheds its smallest placeable junk
// stack into a pillar beside the bot, then retries. Placing is not
// tossing (owner 2026-10-06): the blocks stand in the world, recoverable.
// Wood never sheds (the quest funds the chest from it); stations, torches
// and food never shed; dirt/stone-family sheds before ores (value last).
const SHED_FIRST = new Set(['dirt', 'coarse_dirt', 'rooted_dirt', 'mud', 'clay',
  'sand', 'red_sand', 'gravel', 'soul_sand', 'soul_soil',
  'cobblestone', 'stone', 'deepslate', 'cobbled_deepslate', 'tuff',
  'calcite', 'diorite', 'granite', 'andesite', 'sandstone', 'netherrack'])
// Castle stone sheds after dirt/sand (vmzq.38: the castle lays it).
function shedRank(name) {
  if (typeof name !== 'string') return -1
  if (SHED_FIRST.has(name)) return isStone(name) ? 1 : 0
  if (name.endsWith('_ore')) return 2
  return -1
}
// Pure victim pick: smallest shedable stack (rank, then count). Null when
// nothing may shed. Exported for the unit assay.
function shedVictim(items, skip) {
  try {
    if (!Array.isArray(items)) return null
    let best = null
    let bestRank = Infinity
    let bestCount = Infinity
    for (const s of items) {
      if (!s || typeof s.name !== 'string' || (skip && skip.has(s.name))) continue
      const rank = shedRank(s.name)
      if (rank < 0) continue
      const n = typeof s.count === 'number' ? s.count : 1
      if (rank < bestRank || (rank === bestRank && n < bestCount)) {
        bestRank = rank
        bestCount = n
        best = s
      }
    }
    return best
  } catch (_) {
    return null
  }
}
// Top single-wood plank count (goal.js maxPlanks mirror): the bootstrap
// recipes cannot mix woods.
function fundPlanks(bot) {
  const perWood = {}
  try {
    const items = bot && bot.inventory && typeof bot.inventory.items === 'function' ? bot.inventory.items() : []
    if (!Array.isArray(items)) return { max: 0 }
    for (const i of items) {
      if (!i || typeof i.name !== 'string' || !i.name.endsWith('_planks')) continue
      perWood[i.name] = (perWood[i.name] || 0) + (typeof i.count === 'number' ? i.count : 1)
    }
  } catch (_) { /* inventory not ready: unfunded */ }
  let max = 0
  for (const n of Object.values(perWood)) if (n > max) max = n
  return { max }
}
// Shed survey (g0z.26 R4, revmux 03 major): pillar columns beside the bot —
// never under its own feet (that cell is occupied). Each column is
// ground-verified, air-verified upward, reach-capped (SHED_COL_MAX, Paper
// refuses high placements), ceiling-aware (a 2-high room caps at 2), and
// off the avoid column (the chest spot). Two rings, 16 columns: 64 cells
// outdoors (any single stack), 32 in a 2-high room. Returns the smallest
// victim plus the surveyed capacity, or null when nothing may shed.
// Diagonals first, the (1,0)->(2,0) walk-out line last (vmzq.38 revmux
// 01/02): a 30-60 stone victim no longer closes the bot's pocket.
const SHED_RINGS = [[1, 1], [1, -1], [-1, 1], [-1, -1],
  [-2, 0], [0, 2], [0, -2], [2, 2], [2, -2], [-2, 2], [-2, -2],
  [-1, 0], [0, 1], [0, -1], [2, 0], [1, 0]]
const SHED_COL_MAX = 4
function shedSurvey(bot, opts) {
  try {
    const feet = bot && bot.entity && bot.entity.position
    if (!feet || typeof feet.x !== 'number') return null
    let items = null
    try { items = bot.inventory.items() } catch (_) { items = null }
    if (!Array.isArray(items)) return null
    const victim = shedVictim(items, opts && opts.recipe ? ingredientNames(bot, opts.recipe) : null)
    if (!victim) return null
    const avoid = opts && opts.avoid
    const fx = Math.floor(feet.x)
    const fy = Math.floor(feet.y)
    const fz = Math.floor(feet.z)
    const columns = []
    for (const [dx, dz] of SHED_RINGS) {
      const px = fx + dx
      const pz = fz + dz
      if (avoid && typeof avoid.x === 'number' && avoid.x === px && avoid.z === pz) continue
      let g = null
      try {
        g = bot.blockAt && bot.blockAt(new Vec3(px, fy - 1, pz))
      } catch (_) { g = null }
      if (!g || !g.name || g.name === 'air' || g.name === 'cave_air' || g.name === 'water' || g.name === 'lava') continue
      let cap = 0
      for (let h = 0; h < SHED_COL_MAX; h++) {
        let c = null
        try {
          c = bot.blockAt && bot.blockAt(new Vec3(px, fy + h, pz))
        } catch (_) { c = null }
        if (!c || !c.name || (c.name !== 'air' && c.name !== 'cave_air')) break
        cap++
      }
      if (cap <= 0) continue
      columns.push({ ground: g, cap })
    }
    let capacity = 0
    for (const c of columns) capacity += c.cap
    const need = typeof victim.count === 'number' ? victim.count : 1
    return { victim, columns, capacity, fits: need <= capacity }
  } catch (_) {
    return null
  }
}
// Shed the surveyed victim across the surveyed columns (a refusal abandons
// its column, not the shed). True iff the whole victim landed and a slot
// freed; false up front when nothing fits (never start a doomed shed), or
// honestly on any failure, with no partial retry.
async function shedStack(bot, opts) {
  const feet = bot && bot.entity && bot.entity.position
  if (!feet || typeof feet.x !== 'number') return false
  if (typeof bot.equip !== 'function' || typeof bot.placeBlock !== 'function') return false
  const survey = shedSurvey(bot, opts)
  if (!survey || !survey.fits) return false
  const victim = survey.victim
  try {
    await bot.equip(victim, 'hand')
  } catch (_) {
    return false
  }
  // The hand holds the victim: placements consume it exactly, so place its
  // snapshot count — never match by name (same-name siblings would keep a
  // name match alive past the victim). A freed slot is the success read.
  let startLen = -1
  try {
    const items = bot.inventory.items()
    startLen = Array.isArray(items) ? items.length : -1
  } catch (_) { startLen = -1 }
  let left = typeof victim.count === 'number' ? victim.count : 1
  for (const col of survey.columns) {
    if (left <= 0) break
    let ref = col.ground
    for (let h = 0; h < col.cap && left > 0; h++) {
      try {
        await bot.placeBlock(ref, new Vec3(0, 1, 0))
      } catch (_) {
        break // refused: the next column, not the next tick
      }
      let top = null
      try {
        top = bot.blockAt && bot.blockAt(new Vec3(ref.position.x, ref.position.y + 1, ref.position.z))
      } catch (_) { top = null }
      if (!top || !top.name || top.name === 'air' || top.name === 'cave_air') break
      left--
      ref = top
    }
  }
  if (left > 0) return false
  try {
    const items = bot.inventory.items()
    return Array.isArray(items) && startLen >= 0 && items.length < startLen
  } catch (_) {
    return false
  }
}
// Craft shed (g0z.26 R3; vmzq.38 widened to every craft): the one
// full-pack guard all craft callers route through (safeCraft). At 35+
// stacks with no chest in reach (ensureRoom already tried banking) the
// craft places its smallest junk stack into a pillar beside the bot, then
// the caller retries room once. Placing is not tossing (owner 2026-10-06).
// Prod 2026-10-06: a 36/36 granite/diorite/sand pack refused the table
// craft for 1h+ — no table, no pickaxe, castle flat — because the shed only
// fired for an adopted, chestless, unattended home. The chest/table
// bootstrap still needs its planks funded (the quest owns an unfunded
// corner); every other craft is funded by its recipe lookup.
// ponytail: one stack per craft op; a pack refilling between ops sheds again.
async function bootstrapShed(bot, opts) {
  try {
    const item = opts && opts.item
    const ctx = opts && opts.ctx
    if (ctx && ctx._shedInFlight) return false
    if (item === 'chest' && fundPlanks(bot).max < 8) return false
    if (item === 'crafting_table' && fundPlanks(bot).max < 4) return false
    const items = bot.inventory.items()
    if (!Array.isArray(items) || items.length < 35) return false
    if (ctx) ctx._shedInFlight = true
    try {
      const freed = await shedStack(bot, opts)
      if (freed) {
        try { console.log(`craft shed one stack to make room for ${item || 'a craft'}`) } catch (_) { /* logging best-effort */ }
      }
      return freed
    } finally {
      if (ctx) ctx._shedInFlight = false
    }
  } catch (_) {
    return false
  }
}
// Drop policy (owner 2026-10-07, vmzq.38) — the ONE list of what the bot
// may toss to free a pack slot: leaves/leaf litter, sand/gravel, flora
// (flowers, grass, saplings, seeds), rotten flesh, sticks, and dirt above a
// one-stack scaffold reserve (dirt + castle stone). Everything else is never
// dropped: tools, weapons, armour, food, ores/ingots, coal, logs/planks,
// wool, beds, and castle stone (granite/diorite/andesite/cobble/stone).
// Rank = drop order, cheapest first; -1 = never.
const DROP_FLORA = new Set(['dandelion', 'poppy', 'blue_orchid', 'allium', 'azure_bluet', 'oxeye_daisy',
  'cornflower', 'lily_of_the_valley', 'sunflower', 'lilac', 'rose_bush', 'peony', 'pink_petals', 'wildflowers',
  'short_grass', 'tall_grass', 'fern', 'large_fern', 'dead_bush', 'pitcher_pod', 'mangrove_propagule'])
const DROP_DIRT = new Set(['dirt', 'coarse_dirt', 'grass_block', 'rooted_dirt', 'podzol', 'mycelium'])
const SCAFFOLD_KEEP = 64
function dropRank(name) {
  if (typeof name !== 'string') return -1
  if (name === 'leaf_litter' || name.endsWith('_leaves')) return 0
  if (name === 'sand' || name === 'red_sand' || name === 'gravel') return 1
  if (DROP_FLORA.has(name) || name.endsWith('_tulip') || name.endsWith('_sapling') || name.endsWith('_seeds')) return 2
  if (name === 'rotten_flesh') return 3
  if (name === 'stick') return 4
  if (DROP_DIRT.has(name)) return 5
  return -1
}
// Pure victim pick: lowest rank, then smallest stack; never a recipe
// ingredient (skip), never dirt that would cut the scaffold reserve.
function dropVictim(items, skip) {
  if (!Array.isArray(items)) return null
  let scaffold = 0
  for (const s of items) {
    if (s && (DROP_DIRT.has(s.name) || isStone(s.name))) scaffold += stackCount(s)
  }
  let best = null
  for (const s of items) {
    if (!s || (skip && skip.has(s.name))) continue
    const rank = dropRank(s.name)
    if (rank < 0) continue
    if (rank === 5 && scaffold - stackCount(s) < SCAFFOLD_KEEP) continue
    if (!best || rank < best.rank || (rank === best.rank && stackCount(s) < stackCount(best.s))) best = { s, rank }
  }
  return best && best.s
}
// One free slot for a craft at a full pack (35+ stacks, ensureRoom found no
// chest): toss one policy-junk stack, else place one (the shed). True iff
// a slot freed.
async function freeSlot(bot, opts) {
  const item = (opts && opts.item) || 'a craft'
  let why = 'unreadable'
  try {
    const items = bot.inventory.items()
    if (!Array.isArray(items) || items.length < 35) return false
    const victim = dropVictim(items, opts && opts.recipe ? ingredientNames(bot, opts.recipe) : null)
    why = victim ? (cursorOccupied(bot) ? 'cursor' : 'no-toss') : 'no-junk'
    if (victim && typeof bot.tossStack === 'function' && !cursorOccupied(bot)) {
      try {
        await bot.tossStack(victim)
        try { console.log(`craft dropped ${victim.name}x${stackCount(victim)} (junk policy) to make room for ${item}`) } catch (_) { /* logging best-effort */ }
        return true
      } catch (err) { why = `toss: ${err && err.message}` }
    }
  } catch (_) { /* unreadable pack: the shed decides */ }
  if (await bootstrapShed(bot, opts)) return true
  try { console.log(`craft free-slot failed for ${item} (${why}, no shed): ${slotSummary(bot)}`) } catch (_) { /* logging best-effort */ }
  return false
}
// Quest shed (g0z.26 R4, revmux 03 major): the unfunded quest corner at 34+
// stacks cannot chop (no free slots) — shed one junk stack per run until
// the quest fits (33). No funding gate: the quest, not a craft, is the
// exit. True iff a slot freed.
async function shedForQuest(bot, ctx) {
  try {
    let stockpile = null
    try { stockpile = require('./stockpile') } catch (_) { stockpile = null }
    if (!stockpile || typeof stockpile.reserveCorner !== 'function') return false
    if (!stockpile.reserveCorner(bot, ctx)) return false
    if (ctx && ctx._shedInFlight) return false
    let width = -1
    try {
      const items = bot.inventory.items()
      width = Array.isArray(items) ? items.length : -1
    } catch (_) { width = -1 }
    if (width < 34) return false
    if (ctx) ctx._shedInFlight = true
    try {
      const freed = await shedStack(bot, { ctx })
      if (freed) {
        try { console.log(`craft shed one stack for the chest quest (${width} -> ${width - 1} stacks)`) } catch (_) { /* logging best-effort */ }
      }
      return freed
    } finally {
      if (ctx) ctx._shedInFlight = false
    }
  } catch (_) {
    return false
  }
}
function reserveBlocks(bot, recipe, count, opts) {
  try {
    const item = opts && opts.item
    if (typeof item !== 'string' || RESERVE_EXEMPT.has(item)) return false
    const stockpile = require('./stockpile')
    if (!stockpile || typeof stockpile.slotReserved !== 'function') return false
    if (!stockpile.slotReserved(bot, opts && opts.ctx)) return false
    return consumesLastSlot(roomDetail(bot, resultOf(bot, recipe, item), count, recipe))
  } catch (_) {
    return false
  }
}

function cursorOccupied(bot) {
  try {
    return !!(bot && bot.inventory && bot.inventory.selectedItem)
  } catch (_) {
    return false
  }
}

// Keep-best score for spare selection: an enchanted/named stack outranks
// a plain one, so the banked spare is the worse bow.
function keepScore(s) {
  try {
    return s && s.nbt != null ? 1 : 0
  } catch (_) {
    return 0
  }
}

// Every junk stack the room guarantee may bank, cheapest first: all
// fungible junk plus every bow/arrow stack but the best. Best =
// enchanted/named over plain, ties to the first in inventory order.
// Bow/arrow spares go by EXACT slot — type-based removal takes first
// stacks and could bank the kept, possibly owner-given bow (verifier P2).
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

// Bankable total for the before/after log line: junk plus above-ceiling
// wood (g0z.26).
function bankableTotal(bot, ctx, stockpile) {
  let n = junkTotal(bot, ctx)
  try {
    const mod = stockpile || require('./stockpile')
    if (mod && typeof mod.surplusWood === 'function') {
      for (const w of mod.surplusWood(bot, ctx)) n += w.count
    }
  } catch (_) { /* junk only */ }
  return n
}

// Chests the room guarantee may bank to, nearest first: the adopted home
// chest when in reach, then ANY chest block in reach (owner 2026-10-06 —
// a roadside craft banks into whatever chest stands nearby; the bot never
// throws anything away). withChest verifies each candidate is still a chest.
function chestCandidates(bot, ctx, stockpile) {
  const out = []
  try {
    const reach = (stockpile && stockpile.INTERACT_REACH) || 4
    const bp = bot && bot.entity && bot.entity.position
    if (!bp || typeof bp.x !== 'number') return out
    const c = ctx && ctx.home && ctx.home.chest
    if (c && typeof c.x === 'number' && Math.hypot(bp.x - c.x, bp.y - c.y, bp.z - c.z) <= reach) out.push(c)
    const byName = bot.registry && bot.registry.blocksByName
    const e = byName && byName.chest
    if (e && typeof e.id === 'number' && typeof bot.findBlocks === 'function') {
      let hits = []
      try {
        hits = bot.findBlocks({ matching: e.id, maxDistance: reach + 1, count: 8 }) || []
      } catch (_) { hits = [] }
      const ds = []
      for (const h of hits) {
        if (!h || typeof h.x !== 'number') continue
        if (c && h.x === c.x && h.y === c.y && h.z === c.z) continue
        const d = Math.hypot(bp.x - h.x, bp.y - h.y, bp.z - h.z)
        if (d <= reach) ds.push({ h, d })
      }
      ds.sort((a, b) => a.d - b.d)
      for (const { h } of ds) out.push(h)
    }
  } catch (_) { /* no candidates */ }
  return out
}

async function ensureRoom(bot, recipe, count, opts) {
  const res = resultOf(bot, recipe, opts && opts.item)
  if (roomFor(bot, res, count, recipe) !== false) return
  // No room with a foreign cursor item held: removal clicks would swap
  // onto it and post-bank room reads would lie — fail honestly instead.
  // clearGrid already tried to put it back, so a stuck one means no room
  // anyway. With room the craft proceeds as before.
  if (cursorOccupied(bot)) throw new Error('inventory-full')
  const ctx = opts && opts.ctx
  // Chest first: the adopted home chest in reach, else ANY chest in reach,
  // banks the junk and the above-ceiling wood through the stockpile window
  // path. A far or unreadable chest skips silently — a mid-craft walk would
  // stall the op on the window timeout.
  if (ctx) {
    let stockpile = null
    try { stockpile = require('./stockpile') } catch (_) { stockpile = null }
    const spares = spareStacks(bot, ctx)
    let wood = []
    try { wood = (stockpile && stockpile.surplusWood(bot, ctx)) || [] } catch (_) { wood = [] }
    if ((spares.length > 0 || wood.length > 0) && stockpile && typeof stockpile.withChest === 'function') {
      for (const at of chestCandidates(bot, ctx, stockpile)) {
        if (cursorOccupied(bot)) break // never swap-misdrop onto a live cursor
        try {
          const before = bankableTotal(bot, ctx, stockpile)
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
              // Above-ceiling wood (g0z.26): fungible like junk — the
              // single-op ingredient needs stay far below the keep.
              for (const w of wood) {
                const e = fung.get(w.name) || { total: 0, type: null }
                e.total += w.count
                if (e.type == null) e.type = stackType(bot, { name: w.name })
                fung.set(w.name, e)
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
          }, at)
          // Post-close truth: the resync lands behind the close (TCP
          // order), so a lagging model cannot read false room either.
          try {
            await syncInventory(bot)
          } catch (_) { /* unverified: the recount below still decides */ }
          const put = Math.max(0, before - bankableTotal(bot, ctx, stockpile))
          if (put > 0) {
            try { console.log(`craft banked ${put} surplus to a chest to make room`) } catch (_) { /* logging best-effort */ }
          }
          if (roomFor(bot, res, count, recipe) !== false) return
        } catch (_) { /* this chest failed: try the next, else inventory-full */ }
      }
    }
  }
  // No chest in reach, or none bankable: fail honestly. The bot never throws
  // anything away (owner 2026-10-06) — the hold parks the step while the
  // stockpile step (or deliver to the owner) drains the pack.
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
  const room = { ...opts, recipe } // the free slot never takes an ingredient
  // The reserved last slot frees a junk slot too (vmzq.38): otherwise the
  // table -> sticks -> pickaxe chain stalls one op after the first shed.
  if (reserveBlocks(bot, recipe, count, opts) &&
    (!(await freeSlot(bot, room)) || reserveBlocks(bot, recipe, count, opts))) throw new Error('inventory-full')
  await paceWindowOp(bot)
  if (!table) await clearGrid(bot)
  await ensureStacks(bot, recipe, count)
  try {
    await ensureRoom(bot, recipe, count, opts)
  } catch (err) {
    // Free slot (g0z.26 R3, vmzq.38): any craft at zero empties drops one
    // policy-junk stack, else sheds one into a pillar, and retries room
    // once — the 36/36 exit. Anything else keeps the honest inventory-full.
    if (!err || err.message !== 'inventory-full' || !(await freeSlot(bot, room))) throw err
    await ensureRoom(bot, recipe, count, opts)
  }
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
  // Wood ceiling (g0z.26): past the cap no log converts — a craft picked for
  // the table/door still runs those branches below, the logs stay for the
  // stockpile banking. Deferred require (the ensureRoom precedent).
  let capped = false
  try { capped = !!(ctx && require('./stockpile').woodCapped(bot, ctx)) } catch (_) { capped = false }
  const ops = []
  if (!capped) {
    for (const [wood, n] of sortedWoods(logs)) {
      const name = `${wood}_planks`
      const found = recipes(bot, name, null)
      if (found.length > 0) ops.push({ item: name, recipe: found[0], count: n + strandedCount(bot, `${wood}_log`), table: null }) // batch = visible stack + stranded (run() still calls bot.craft with count=1)
    }
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
    if (total >= NEED_LOGS && first && !capped) {
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
module.exports.shedVictim = shedVictim
module.exports.dropVictim = dropVictim
module.exports.dropRank = dropRank
module.exports.shedForQuest = shedForQuest
module.exports.syncInventory = syncInventory
module.exports.slotSummary = slotSummary
module.exports.WINDOW_OP_GAP_MS = WINDOW_OP_GAP_MS
