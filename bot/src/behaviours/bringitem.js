'use strict'

// Item/craft/sub rungs of the bring ladder (idkcraft-did.4 split: bring.js
// passed ~1100 lines, so it stays the phase dispatcher and this module owns
// the item phases). Moved verbatim from bring.js: the share keep-list and
// plan, the food order seed, chat normalisation and the item resolver, the
// pack plan, the craft rung, the item chest fetch, and the share/item toss.
// New here: the sub-order — a craft rung whose recipe gap rides the ladder
// (wool/planks/logs/sticks) morphs the order into a gather order in place
// and resumes the craft when the gap is filled.
//
// Load direction is one-way: bring.js requires this module at the top, and
// the terminal actions (refuse/done/countDrop) come back through a deferred
// require (the stockpile.js craftMod / bring.js craftany precedent) — every
// call happens on a tick or a chat line, long after load.

const stockpileMod = require('./stockpile')
const woolMod = require('./wool')
const bedMod = require('./bed')
const { countItems } = require('../perception')
const { say } = require('./util')

let bringCore = null
function bring() {
  if (!bringCore) bringCore = require('./bring')
  return bringCore
}

// Deferred require, same cycle as bring.js had: craftany->craft->goal
// closes the loop back through forage/deliver->bring, so a top-level
// require here would hand goal a half-loaded bring.
let craftanyMod = null
function craftany() {
  if (!craftanyMod) craftanyMod = require('./craftany')
  return craftanyMod
}

// Deferred for the same cycle (gear->craft->goal loops back through
// forage/deliver->bring): call-time only, for the table check below.
let gearMod = null
function gear() {
  if (!gearMod) gearMod = require('./gear')
  return gearMod
}

function refuse(bot, ctx, line) {
  return bring().refuse(bot, ctx, line)
}

function done(bot, ctx) {
  return bring().done(bot, ctx)
}

function countDrop(bot, drop) {
  return bring().countDrop(bot, drop)
}

// Share keep-list (idkcraft-ah9): tools, weapons, armour, plus a 32-block
// dirt/cobblestone reserve — without it the bot cannot pillar out (ef3
// pillar_up). Dirt fills the reserve first, cobblestone the remainder.
const SHARE_RESERVE = 32
const SHARE_EXACT_KEEP = new Set(['shears', 'flint_and_steel', 'bow', 'crossbow', 'trident', 'arrow', 'shield'])
function isShareKeep(name) {
  if (typeof name !== 'string') return true
  if (SHARE_EXACT_KEEP.has(name)) return true
  return /_(pickaxe|axe|shovel|hoe|sword|helmet|chestplate|leggings|boots)$/.test(name)
}

// Inventory items -> toss list in inventory order, keep-list skipped.
function sharePlan(items) {
  const list = Array.isArray(items) ? items : []
  let dirt = 0
  let cobble = 0
  for (const i of list) {
    if (!i || typeof i.name !== 'string') continue
    if (i.name === 'dirt') dirt += i.count || 0
    if (i.name === 'cobblestone') cobble += i.count || 0
  }
  let keepDirt = Math.min(SHARE_RESERVE, dirt)
  let keepCobble = Math.min(SHARE_RESERVE - keepDirt, cobble)
  const toss = []
  const at = new Map()
  const add = (name, count) => {
    if (count <= 0) return
    if (at.has(name)) toss[at.get(name)].count += count
    else { at.set(name, toss.length); toss.push({ name, count }) }
  }
  for (const i of list) {
    if (!i || typeof i.name !== 'string') continue
    if (isShareKeep(i.name)) continue
    const n = i.count || 0
    if (i.name === 'dirt') {
      const k = Math.min(keepDirt, n)
      keepDirt -= k
      add(i.name, n - k)
    } else if (i.name === 'cobblestone') {
      const k = Math.min(keepCobble, n)
      keepCobble -= k
      add(i.name, n - k)
    } else {
      add(i.name, n)
    }
  }
  return toss
}

// Food (idkcraft-n7k): 'bring me food [N]' + 'meat' / 'something to eat'.
// Inventory first (any edible incl. raw meat), else hunt the nearest passive
// animal with the fight swing. No cooking, no rescue branches — refusals.
const FOOD_NAMES = new Set([
  'bread', 'baked_potato', 'apple', 'carrot',
  'cooked_beef', 'cooked_porkchop', 'cooked_chicken', 'cooked_mutton', 'cooked_rabbit',
  'beef', 'porkchop', 'mutton', 'chicken', 'rabbit',
])

function isFoodRequest(name) {
  const n = String(name || '').toLowerCase().trim().replace(/_/g, ' ').replace(/\s+/g, ' ')
  return n === 'food' || n === 'meat' || n === 'something to eat'
}

function findEdible(bot) {
  try {
    const items = bot && bot.inventory && typeof bot.inventory.items === 'function' ? bot.inventory.items() : []
    if (Array.isArray(items)) {
      for (const i of items) {
        if (i && typeof i.name === 'string' && FOOD_NAMES.has(i.name)) {
          return { name: i.name, count: typeof i.count === 'number' ? i.count : 1 }
        }
      }
    }
  } catch (_) { /* no inventory: hunt */ }
  return null
}

// Item orders (idkcraft-did.1): 'bring me <item>' looks in the pack and the
// home chest before the world. Chat normalisation: articles dropped, words
// joined with _ ('a white bed' -> white_bed, 'water bucket' -> water_bucket).
function normalizeBringName(raw) {
  let s = String(raw || '').toLowerCase().trim().replace(/\s+/g, ' ')
  for (;;) {
    const m = s.match(/^(a|an|the|some) (.+)$/)
    if (!m) break
    s = m[2]
  }
  return s.replace(/ /g, '_')
}

// Item name -> concrete registry items: the exact name, else the *_<name>
// family (wool -> 16 *_wool, bed -> *_bed, axe -> *_axe), else the singular
// (beds -> bed, torches -> torch). Nothing fuzzy: no match is null and the
// caller answers 'unknown item'. The block resolver (scout.js) is untouched.
function resolveItem(bot, name) {
  const norm = String(name || '').toLowerCase().trim()
  if (!norm) return null
  const byName = (bot.registry && bot.registry.itemsByName) || {}
  if (byName[norm]) return { names: [norm], family: norm }
  const family = (base) => Object.keys(byName).filter((n) => n.endsWith('_' + base)).sort()
  let names = family(norm)
  if (names.length > 0) return { names, family: norm }
  if (norm.length > 1 && norm.endsWith('s')) {
    const sing = norm.slice(0, -1)
    if (byName[sing]) return { names: [sing], family: sing }
    names = family(sing)
    if (names.length > 0) return { names, family: sing }
    if (norm.endsWith('es')) {
      const cut = norm.slice(0, -2)
      if (byName[cut]) return { names: [cut], family: cut }
      names = family(cut)
      if (names.length > 0) return { names, family: cut }
    }
  }
  return null
}

// Pack contents as a plain {name: count} map; unreadable reads as empty.
function packCounts(bot) {
  const counts = {}
  try {
    const items = bot && bot.inventory && typeof bot.inventory.items === 'function' ? bot.inventory.items() : []
    if (Array.isArray(items)) {
      for (const i of items) {
        if (!i || typeof i.name !== 'string') continue
        counts[i.name] = (counts[i.name] || 0) + (i.count || 0)
      }
    }
  } catch (_) { /* unreadable inventory: empty plan */ }
  return counts
}

// Material tier for the family keep rule: tools use the pickaxe ladder,
// armour its own. Unlisted keep items (shears, shield, bow, …) rank 0; an
// unknown material on a known suffix ranks below all (give the mystery
// piece first, keep the known-good one). TOOL_RANK mirrors bring.js
// PICKAXE_RANK (the craftany.js MAT_RANK precedent) so this edge never
// reads bring at load.
const ARMOR_RANK = { leather: 0, golden: 0, turtle: 1, chainmail: 1, iron: 2, diamond: 3, netherite: 4 }
const TOOL_RANK = { wooden: 0, golden: 0, stone: 1, iron: 2, diamond: 3, netherite: 4 }
function tierOf(name) {
  const m = typeof name === 'string' && name.match(/^(\w+?)_(pickaxe|axe|shovel|hoe|sword|helmet|chestplate|leggings|boots)$/)
  if (!m) return 0
  const rank = /^(helmet|chestplate|leggings|boots)$/.test(m[2]) ? ARMOR_RANK : TOOL_RANK
  return m[1] in rank ? rank[m[1]] : -1
}

// Pack plan for a resolved item: concrete [{name,count}] up to want, honouring
// the share keep-list — the last tool stays (axe/pickaxe/sword/shears, the
// owner's standing rule), dirt/cobblestone keep the 32-block pillar reserve.
// The tool keep spans the whole family (tools don't stack): wooden_axe +
// stone_axe gives one, keeping the best tier. keptOnly is true when the pack
// holds the family but every piece is kept: the ladder falls through to the
// chest, and the refusal names it.
// base (optional): per-name pack counts from before the order opened — the
// keep-list and the reserve deduct from base while availability reads live.
// Chest top-ups are the player's stock, not the bot's gear: a pack that held
// no axe gives the fetched one instead of keeping it.
function planItemGive(bot, resolved, want, base) {
  const names = (resolved && resolved.names) || []
  const target = want > 0 ? Math.min(want, bring().WANT_MAX) : bring().WANT_ORE
  const live = packCounts(bot)
  const bc = (base && typeof base === 'object') ? base : live
  const dirt = bc.dirt || 0
  const cobble = bc.cobblestone || 0
  const keepDirt = Math.min(SHARE_RESERVE, dirt)
  const keepCobble = Math.min(SHARE_RESERVE - keepDirt, cobble)
  let baseTools = 0
  for (const n of names) {
    if (isShareKeep(n)) baseTools += bc[n] || 0
  }
  let keepName = null
  if (baseTools > 0) {
    // The keep pins the base's best piece (the bot's own gear), not the
    // live best: fetched or freshly crafted stock gives while the original
    // tool stays — otherwise a forged iron axe would strand on the keep
    // while the bot hands over its old stone one (revmux 01). Pack orders
    // pass no base (bc is live), so their rule is unchanged.
    const held = names.filter((n) => isShareKeep(n) && (bc[n] || 0) > 0 && (live[n] || 0) > 0)
    if (held.length > 0) keepName = held.slice().sort((a, b) => tierOf(b) - tierOf(a))[0]
  }
  const giveable = (n, c) => {
    if (n === keepName) return Math.max(0, c - 1)
    if (isShareKeep(n)) return c
    if (n === 'dirt') return Math.max(0, c - keepDirt)
    if (n === 'cobblestone') return Math.max(0, c - keepCobble)
    return c
  }
  const items = []
  let have = 0
  let raw = 0
  let left = target
  for (const n of names) {
    const c = live[n] || 0
    raw += c
    if (left <= 0) continue
    const take = Math.min(giveable(n, c), left)
    if (take > 0) {
      items.push({ name: n, count: take })
      have += take
      left -= take
    }
  }
  return { items, have, want: target, keptOnly: have === 0 && raw > 0 }
}

// Recipe probe for the honest stub (did.2 replaces it with crafting): true
// when any family member has a recipe. Mock bots lack recipesAll — false.
function hasRecipe(bot, resolved) {
  if (!resolved || !Array.isArray(resolved.names)) return false
  try {
    if (!bot || typeof bot.recipesAll !== 'function') return false
    const byName = (bot.registry && bot.registry.itemsByName) || {}
    for (const n of resolved.names) {
      const e = byName[n]
      if (!e || typeof e.id !== 'number') continue
      const rs = bot.recipesAll(e.id, null)
      if (Array.isArray(rs) && rs.length > 0) return true
    }
  } catch (_) { return false }
  return false
}

// Honest stub refusal for item orders (did.2/did.4 replace the branches):
// the kept last tool, a future craft, or nothing at all. Wool never
// reaches it: the mob rung hunts sheep first (refuseItemOrHunt).
function itemRefusal(bot, name, resolved, keptName) {
  if (keptName) return `my only ${keptName}, can't make another yet`
  if (hasRecipe(bot, resolved)) return `can't make ${name} yet (crafting comes next)`
  return `can't get ${name}: no recipe, no source`
}

// Furnace-gated ingredients (did.4): the bring ladder has no smelting, so a
// craft gap naming one refuses with the smelting line instead of opening a
// sub-order. Anything else off-ladder (cobble, coal, diamond, …) keeps
// planCraft's own line — no general planner down to ore.
const SMELTING = new Set([
  'iron_ingot', 'gold_ingot', 'copper_ingot',
  'cooked_beef', 'cooked_porkchop', 'cooked_chicken', 'cooked_mutton', 'cooked_rabbit',
  'glass', 'brick', 'charcoal',
])
function smeltingGap(missing) {
  const list = Array.isArray(missing) ? missing : []
  for (const e of list) {
    if (e && typeof e.name === 'string' && SMELTING.has(e.name)) return e.name
  }
  return null
}

// Gap word for the sub chat lines ('3 wool', '3 planks'): the bead's words,
// not the registry names.
function subWordFor(name) {
  if (name === 'stick') return 'sticks'
  if (name === 'wool' || (typeof name === 'string' && name.endsWith('_wool'))) return 'wool'
  if (typeof name === 'string' && name.endsWith('_planks')) return 'planks'
  if (typeof name === 'string' && name.endsWith('_log')) return 'logs'
  return name
}

// Ladder-bringable gap precedence for generic (non-bed) orders: wool first,
// then planks, then logs, then sticks. Null when no gap rides the ladder.
function pickSubGap(missing) {
  const list = Array.isArray(missing) ? missing : []
  const rank = (n) => {
    if (typeof n !== 'string') return 9
    if (n.endsWith('_wool')) return 0
    if (n.endsWith('_planks')) return 1
    if (n.endsWith('_log')) return 2
    if (n === 'stick') return 3
    return 9
  }
  let best = null
  for (const e of list) {
    if (!e || typeof e.name !== 'string' || rank(e.name) >= 9) continue
    if (!best || rank(e.name) < rank(best.name)) best = e
  }
  return best
}

// Bed gap (did.4 colour rule): an exact bed order locks its own colour; a
// bare 'bed' family takes the pack argmax, or hunts any sheep when the pack
// holds no wool (the first pickup locks the colour through lockColor).
// Always returns { gap, target, color } (color null for the bare hunt);
// the caller's null check is dead defense. The gap comes from
// the fresh recipe directly, never from the planner's winning refusal:
// dyeing recipes (bed + dye, 2 units) always beat the fresh 3+ unit gap in
// fewest-units competition and would hide the wool and planks the
// sub-order must fetch (did.4 rig: 'need 1 yellow_dye, 1 black_bed'
// instead of a log sub). Every bed crafts fresh from 3 wool of its colour
// plus 3 planks of any one wood (vanilla); the wood is the best-stocked
// one, oak when the pack holds no wood at all.
function bedGap(bot, o) {
  const names = (o && Array.isArray(o.names)) ? o.names : []
  const pack = packCounts(bot)
  const color = names.length === 1 ? bedMod.bedColor(names[0]) : bedMod.pickBedColor(pack)
  if (!color) {
    return { gap: { name: 'wool', need: bedMod.BED_WOOL, have: 0 }, target: 'bed', color: null }
  }
  const target = bedMod.bedTarget(color)
  const woolHave = pack[`${color}_wool`] || 0
  if (woolHave < bedMod.BED_WOOL) {
    return { gap: { name: `${color}_wool`, need: bedMod.BED_WOOL, have: woolHave }, target, color }
  }
  const wood = topPlankWood(pack)
  const planksHave = pack[`${wood}_planks`] || 0
  const avail = planksHave + 4 * (pack[`${wood}_log`] || 0)
  if (avail < bedMod.BED_PLANKS) {
    return { gap: { name: `${wood}_planks`, need: bedMod.BED_PLANKS, have: planksHave }, target, color }
  }
  // Fresh mats cover but the outer plan still failed missing (the only
  // caller shape): the 'make' table fund eats this wood, so the recipe
  // goes short — fetch past the 4 the table takes.
  return { gap: { name: `${wood}_planks`, need: bedMod.BED_PLANKS, have: Math.max(0, avail - 4) }, target, color }
}

// A table the craft can actually reach: the verified standing claim or a
// pack table. Wood sub-orders size against this (core-1): without one the
// same logs must also fund the 4-plank made table.
function tableReachable(bot, ctx) {
  try {
    if (gear().tableBlock(bot, ctx)) return true
  } catch (_) { /* fall through to the pack */ }
  try {
    return (packCounts(bot).crafting_table || 0) > 0
  } catch (_) { return false }
}

// Best-stocked plank wood in the pack (planks plus four per log): the
// fresh bed recipe burns one wood, so the gap and the chest draw both aim
// at this one. Oak when the pack holds no wood at all.
function topPlankWood(pack) {
  const p = (pack && typeof pack === 'object') ? pack : {}
  const woods = new Set()
  for (const name of Object.keys(p)) {
    if (typeof name !== 'string') continue
    if (name.endsWith('_planks')) woods.add(name.slice(0, -'_planks'.length))
    else if (name.endsWith('_log')) woods.add(name.slice(0, -'_log'.length))
  }
  let wood = 'oak'
  let woodBest = -1
  for (const w of woods) {
    const avail = (p[`${w}_planks`] || 0) + 4 * (p[`${w}_log`] || 0)
    if (avail > woodBest) {
      woodBest = avail
      wood = w
    }
  }
  return wood
}

// Sub-order open (did.4): morph the item order into a gather order in
// place — the wool hunt or the log dig — saving the parent rung in o.parent
// for resumeSub. A wool gap hunts its exact colour (or any sheep for the
// bare gap, locking the first pickup); a planks gap digs the same wood's
// logs (one log covers four planks); a stick gap digs the pack wood, or
// any log when the pack holds no wood at all (the find re-points the drop
// at the concrete species, the 'bring me logs' shape). Without a reachable
// table the same logs must also fund the 4-plank made table, so the want
// inflates once and one trip covers both (core-1). The chest rung re-arms
// (body-5): a fetchItem-originated sub would otherwise skip the chest the
// parent just stood at, while its logs sit inside. The search legs and
// their budget stay on the same object, so the whole order shares one
// SEARCH_BUDGET. Depth ≤ 2 by construction: gather kinds never reach the
// craft rung, and a nested open returns null instead of looping. Returns
// the one announce line; the caller chats it (setBring returns it, the
// tick says it).
function openSubOrder(bot, ctx, o, gap, target, color) {
  if (!o || !gap || typeof gap.name !== 'string' || o.subFor) return null
  const pack = packCounts(bot)
  const word = subWordFor(gap.name)
  const name = gap.name
  if (name === 'wool' || name.endsWith('_wool')) {
    o.parent = { kind: o.kind, name: o.name, names: o.names, want: o.want }
    o.kind = 'wool'
    o.name = name
    o.color = color || null
    o.lockColor = name === 'wool'
    if (name === 'wool') {
      const t = woolMod.topWoolColor(bot)
      o.drop = t ? t.name : null
    } else {
      o.drop = name
    }
    o.have = o.drop ? countDrop(bot, o.drop) : 0
    o.want = gap.need > 0 ? gap.need : bedMod.BED_WOOL
    o.phase = 'find'
    o.announced = false
    o.animal = null
    o.shearedIds = null
    o.chestTried = false
    o.subFor = target
    o.subWant = gap.need
    o.subWord = word
  } else if (name.endsWith('_planks') || name.endsWith('_log') || name === 'stick') {
    const woodless = !Object.keys(pack).some((n) => typeof n === 'string' && (n.endsWith('_planks') || n.endsWith('_log')))
    const infl = tableReachable(bot, ctx) ? 0 : 4 // planks-worth for the made table
    let fetch = name
    let want = 1
    if (name.endsWith('_planks')) {
      const wood = name.slice(0, -'_planks'.length)
      fetch = woodless ? 'logs' : `${wood}_log`
      // Total-based want against the pack planks (logs already held count
      // toward it at pickup): the floor of 1 may over-dig a covered gap by
      // one log, but the pack grows every cycle while the need is fixed,
      // so the legs either cover or refuse — never loop.
      want = Math.max(1, Math.ceil((gap.need + infl - (pack[name] || 0)) / 4))
    } else if (name.endsWith('_log')) {
      want = Math.max(1, gap.need - (pack[name] || 0) + (infl > 0 ? 1 : 0))
    } else {
      // Any wood burns into sticks: the pack wood when there is one, else
      // a generic log hunt (core-3: no oak-only digging in a birch forest).
      fetch = woodless ? 'logs' : `${topPlankWood(pack)}_log`
      const short = Math.max(1, gap.need - (pack.stick || 0))
      want = Math.max(1, Math.ceil((2 * Math.ceil(short / 4) + infl) / 4))
    }
    o.parent = { kind: o.kind, name: o.name, names: o.names, want: o.want }
    o.kind = 'block'
    o.name = fetch
    o.block = null
    o.pos = null
    o.exposed = null
    o.drop = fetch === 'logs' ? null : fetch // the find re-points generic hunts
    o.have = o.drop ? countDrop(bot, o.drop) : 0
    o.want = want
    o.phase = 'find'
    o.announced = false
    o.skip = null
    o.search = null
    o.searchSkipFar = false
    o.chestTried = false
    o.subFor = target
    o.subWant = gap.need
    o.subWord = word
  } else {
    return null
  }
  const where = (o.kind === 'wool') ? 'sheep' : 'logs'
  const need = `${gap.need} ${word}`
  const first = !(o.subCount > 0)
  o.subCount = (o.subCount || 0) + 1
  return first ? `making you a ${target}: need ${need}, going for ${where}` : `need ${need}, going for ${where}`
}

// Sub-order complete (did.4): the gather leg hit its want — restore the
// parent item rung and re-enter the craft step, which crafts or opens the
// next sub (wool first, then planks). searchLegs stay: one budget for the
// whole order. packBase stays: the keep-list still deducts from the opening
// pack, so fetched and hunted stock gives.
function resumeSub(bot, ctx, o) {
  const p = (o && o.parent) || {}
  o.kind = 'item'
  o.name = p.name || o.name
  o.names = Array.isArray(p.names) ? p.names : o.names
  o.want = typeof p.want === 'number' ? p.want : o.want
  o.drop = null
  o.have = 0
  o.parent = null
  o.subFor = null
  o.subWant = null
  o.subWord = null
  o.color = null
  o.lockColor = false
  o.animal = null
  o.pos = null
  o.block = null
  o.skip = null
  o.search = null
  o.searchSkipFar = false
  o.shearedIds = null
  o.craftTarget = null
  enterCraftOrRefuse(bot, ctx, o)
}

// Mob rung (did.3): wool the pack and chest could not fill comes from
// sheep. Morphs an item order into a wool hunt in place — the shared prey
// phases + search legs take it from here. A single-name family locks the
// color; a bare family tosses the best color in the pack (re-derived each
// pickup). Partial pack/chest stock counts toward the want (recounted
// against the concrete drop, the toss truth).
function toWoolHunt(bot, o) {
  const names = o.names || []
  const color = names.length === 1 ? woolMod.dropColor(names[0]) : null
  o.kind = 'wool'
  if (!o.color) o.color = color
  if (!o.drop) {
    if (o.color) o.drop = `${o.color}_wool`
    else {
      const t = woolMod.topWoolColor(bot)
      if (t) o.drop = t.name
    }
  }
  o.have = o.drop ? countDrop(bot, o.drop) : 0
  o.phase = 'find'
  o.announced = false
  o.animal = null
  return o
}

// Item rung exhaustion: wool falls through to the sheep hunt; anything
// else falls through to the craft rung, then the honest refusal.
function refuseItemOrHunt(bot, ctx, o) {
  if (woolMod.isWoolFamily(o)) {
    toWoolHunt(bot, o)
    return
  }
  enterCraftOrRefuse(bot, ctx, o)
}

// Craft candidates best-tier-first (iron > stone > wooden, the keep-list
// rank); non-tools keep resolver order (stable sort). The planner tries in
// order and crafts the first covered, so 'bring me axe' forges the best
// axe the pack can feed while 'bring me iron axe' stays exact.
function orderCraftNames(names) {
  const list = Array.isArray(names) ? names.slice() : []
  list.sort((a, b) => tierOf(b) - tierOf(a))
  return list
}

// Craft rung (did.2): after the chest (and the wool hunt), before the
// honest refusal. One batch per order — tools land one piece, torch lands
// four — then the pack plan gives full or partial, as after a chest fetch.
// did.4 routes bed-ingredient gaps back through here: a ladder-bringable
// gap opens a sub-order (beds pick their colour first), a furnace-gated
// gap refuses with the smelting line, anything else keeps planCraft's line.
function enterCraftOrRefuse(bot, ctx, o) {
  const plan = craftany().planCraft(bot, ctx, orderCraftNames(o.names || []), 1)
  if (plan.ok) {
    o.phase = 'craft'
    o.craftTarget = plan.target
    try {
      ctx.craftany = null // a cancelled run must not resume under the new one
    } catch (_) { /* state best-effort */ }
    say(bot, `making you a ${plan.target}`)
    return
  }
  if (plan.fail === 'no-table') {
    refuse(bot, ctx, plan.line)
    return
  }
  if (plan.fail === 'missing') {
    const miss = Array.isArray(plan.missing) ? plan.missing : []
    // Smelting first (body-4): a furnace-gated gap refuses up front, before
    // any ladder gap sends the bot gathering for a craft that cannot land.
    const smelt = smeltingGap(miss)
    if (smelt) {
      refuse(bot, ctx, `need ${smelt} (smelting not part of bring)`)
      return
    }
    if (!o.subFor) {
      if (bedMod.isBedFamily(o)) {
        // Beds are immune to the mixed-gap trap below: the fresh recipe is
        // wool plus planks only, and the gap comes from it directly.
        const b = bedGap(bot, o)
        if (b) {
          const line = openSubOrder(bot, ctx, o, b.gap, b.target, b.color)
          if (line) {
            say(bot, line)
            return
          }
        }
      } else if (miss.every((e) => e && pickSubGap([e]))) {
        // Every gap rides the ladder, or the gather is wasted (body-4).
        const gap = pickSubGap(miss)
        if (gap) {
          const line = openSubOrder(bot, ctx, o, gap, plan.target, woolMod.dropColor(gap.name))
          if (line) {
            say(bot, line)
            return
          }
        }
      }
    }
    refuse(bot, ctx, plan.line)
    return
  }
  refuse(bot, ctx, itemRefusal(bot, o.name, { names: o.names || [] }, o.keptName))
}

function craftTick(bot, ctx, o) {
  const res = craftany()(bot, ctx, orderCraftNames(o.names || []), 1)
  if (res === 'running') return
  if (res && res.done) {
    const plan = planItemGive(bot, { names: o.names || [] }, o.want, o.packBase)
    o.items = plan.items
    o.have = plan.have
    o.drop = plan.items.length > 0 ? plan.items[0].name : null
    if (plan.have >= o.want) {
      o.phase = 'return'
      o.saidWaiting = false
    } else if (plan.have > 0) {
      say(bot, `only ${plan.items.map((i) => `${i.count} ${i.name}`).join(', ')}, coming`)
      o.phase = 'return'
      o.saidWaiting = false
    } else {
      refuse(bot, ctx, `could not craft ${res.target || o.name}`)
    }
    return
  }
  refuse(bot, ctx, (res && res.line) || `can't make ${o.name}: crafting failed`)
}

// Chest mats for the craft rung (did.4 colour rule): the product withdraw
// only fetches finished items, but the chest may hold the mats — wool
// (which also picks the bed colour) and other 1:1 units. One window per gap
// name with its exact shortfall; logs stay for the dig leg (the plank gap
// names exact wood, the sub digs the same wood). A bare bed family draws
// wool of any colour first (up to one bed's worth past the pack): the bed
// gap then argmaxes over the topped-up pack, which is the chest+pack
// max-count rule. Exact orders keep their colour and draw it exactly.
async function withdrawCraftMats(bot, ctx, o) {
  let plan = null
  try {
    plan = craftany().planCraft(bot, ctx, orderCraftNames(o.names || []), 1)
  } catch (_) { plan = null }
  if (!plan || plan.fail !== 'missing' || !Array.isArray(plan.missing)) return
  const pack = packCounts(bot)
  if (bedMod.isBedFamily(o)) {
    // Beds draw from the fresh recipe directly: the planner's winning
    // refusal may be a dyeing recipe (bed + dye), which names neither the
    // wool nor the planks the chest should release. Both draws argmax over
    // pack plus chest (core-2/body-2): slot order would split colours and
    // hunt sheep the chest could have funded.
    let chest = {}
    try {
      chest = await stockpileMod.chestCounts(bot, ctx) || {}
    } catch (_) { chest = {} }
    const single = (o.names || []).length === 1 ? bedMod.bedColor(o.names[0]) : null
    if (single) {
      const wname = `${single}_wool`
      const short = Math.max(0, bedMod.BED_WOOL - (pack[wname] || 0))
      if (short > 0) {
        try {
          const res = await stockpileMod.withdrawAnyFromChest(bot, ctx, [wname], short)
          if (res && res.got > 0) pack[wname] = (pack[wname] || 0) + res.got
        } catch (_) { /* planks draw below still runs */ }
      }
    } else {
      let color = bedMod.BED_COLORS[0]
      let best = -1
      for (const c of bedMod.BED_COLORS) {
        const n = (pack[`${c}_wool`] || 0) + (chest[`${c}_wool`] || 0)
        if (n > best) {
          best = n
          color = c
        }
      }
      const wname = `${color}_wool`
      const short = Math.max(0, bedMod.BED_WOOL - (pack[wname] || 0))
      if (short > 0) {
        try {
          const res = await stockpileMod.withdrawAnyFromChest(bot, ctx, [wname], short)
          if (res && res.got > 0) pack[wname] = (pack[wname] || 0) + res.got
        } catch (_) { /* planks draw below still runs */ }
      }
    }
    const woods = new Set()
    for (const src of [pack, chest]) {
      for (const name of Object.keys(src)) {
        if (typeof name !== 'string') continue
        if (name.endsWith('_planks')) woods.add(name.slice(0, -'_planks'.length))
        else if (name.endsWith('_log')) woods.add(name.slice(0, -'_log'.length))
      }
    }
    let wood = 'oak'
    let woodBest = -1
    for (const w of woods) {
      const avail = (pack[`${w}_planks`] || 0) + 4 * (pack[`${w}_log`] || 0) +
        (chest[`${w}_planks`] || 0) + 4 * (chest[`${w}_log`] || 0)
      if (avail > woodBest) {
        woodBest = avail
        wood = w
      }
    }
    const pname = `${wood}_planks`
    const lname = `${wood}_log`
    const have = (pack[pname] || 0) + 4 * (pack[lname] || 0)
    const pshort = Math.max(0, bedMod.BED_PLANKS - have)
    if (pshort > 0) {
      try {
        const res = await stockpileMod.withdrawAnyFromChest(bot, ctx, [pname], pshort)
        if (res && res.got > 0) pack[pname] = (pack[pname] || 0) + res.got
      } catch (_) { /* log draw below still runs */ }
    }
    // Logs cover the remaining planks-worth (body-5): without this a chest
    // holding only logs sends the bot chopping while the stock sits inside.
    const have2 = (pack[pname] || 0) + 4 * (pack[lname] || 0)
    const lshort = Math.max(0, bedMod.BED_PLANKS - have2)
    if (lshort > 0) {
      try {
        const res = await stockpileMod.withdrawAnyFromChest(bot, ctx, [lname], Math.ceil(lshort / 4))
        if (res && res.got > 0) pack[lname] = (pack[lname] || 0) + res.got
      } catch (_) { /* hunt/craft legs run on the pack as-is */ }
    }
    return
  }
  for (const e of plan.missing) {
    if (!e || typeof e.name !== 'string') continue
    const ladder = e.name.endsWith('_wool') || e.name.endsWith('_planks') || e.name === 'stick'
    if (!ladder) continue
    const short = Math.max(0, (e.need || 0) - (pack[e.name] || 0))
    if (short <= 0) continue
    try {
      const res = await stockpileMod.withdrawAnyFromChest(bot, ctx, [e.name], short)
      if (res && res.got > 0) pack[e.name] = (pack[e.name] || 0) + res.got
    } catch (_) { /* next gap */ }
  }
}

// Item chest fetch (did.1): one window across the family names until the want
// is met, then return with what the pack holds — or refuse honestly when the
// chest adds nothing. No world fallback: item orders only open for names with
// no diggable world form. The keep-list deducts from the opening pack counts,
// so fetched stock gives instead of stranding on the keep rule.
async function fetchItem(bot, ctx, o) {
  try {
    const need = Math.max(o.want - o.have, 0)
    if (need > 0) await stockpileMod.withdrawAnyFromChest(bot, ctx, o.names || [], need)
    if (!ctx || ctx.bring !== o) return // stop or a new order landed mid-fetch: touch nothing
    o.chestTried = true
    ctx.chestFull = false // a fetch may have made room: re-arm the step
    const plan = planItemGive(bot, { names: o.names || [] }, o.want, o.packBase) // inventory count is the truth
    o.items = plan.items
    o.have = plan.have
    o.drop = plan.items.length > 0 ? plan.items[0].name : null
    if (plan.have >= o.want) {
      o.chestInFlight = false
      o.phase = 'return'
      o.saidWaiting = false
    } else if (woolMod.isWoolFamily(o)) {
      o.chestInFlight = false
      toWoolHunt(bot, o) // short or empty chest: the mob rung hunts the rest
    } else if (plan.have > 0) {
      o.chestInFlight = false
      say(bot, `only ${plan.items.map((i) => `${i.count} ${i.name}`).join(', ')}, coming`)
      o.phase = 'return'
      o.saidWaiting = false
    } else {
      // chestInFlight stays up across the mat draws (body-1): clearing it
      // here would let the next tick open a second concurrent fetch on the
      // same order. Wool families never run the draws (body-6): a dyeing
      // plan could pull a colour the hunt does not count.
      await withdrawCraftMats(bot, ctx, o)
      if (!ctx || ctx.bring !== o) return
      o.chestInFlight = false
      enterCraftOrRefuse(bot, ctx, o)
    }
  } catch (_) {
    o.chestInFlight = false
    o.chestTried = true
    if (!ctx || ctx.bring !== o) return
    refuseItemOrHunt(bot, ctx, o)
  }
}

// Item toss cap (did.1): the order's list, limited by the live inventory (it
// may have shifted since the order opened). Zero-count entries drop out.
function capByLive(items, live) {
  const counts = new Map()
  for (const i of live || []) {
    if (!i || typeof i.name !== 'string') continue
    counts.set(i.name, (counts.get(i.name) || 0) + (i.count || 0))
  }
  const out = []
  for (const e of items) {
    if (!e || typeof e.name !== 'string') continue
    const n = Math.min(counts.get(e.name) || 0, e.count || 0)
    if (n > 0) {
      out.push({ name: e.name, count: n })
      counts.set(e.name, counts.get(e.name) - n)
    }
  }
  return out
}

// Share toss (idkcraft-ah9): one stack per item in plan order, counted
// against the live inventory (it may have shifted since the order). Reports
// what actually left; an empty toss refuses like the single-drop path.
// Item orders (did.1) toss their own list, capped the same way. A single
// piece reads singular ('here is 1 white_bed', did.4).
function shareToss(bot, ctx, o) {
  if (o.tossInFlight) return
  let live = []
  try {
    live = bot && bot.inventory && typeof bot.inventory.items === 'function' ? bot.inventory.items() : []
  } catch (_) { live = [] }
  const isItem = o && o.kind === 'item' && Array.isArray(o.items)
  const items = isItem ? capByLive(o.items, live) : sharePlan(live)
  if (items.length === 0) {
    refuse(bot, ctx, isItem ? `could not toss ${(o.items[0] && o.items[0].name) || o.name || 'items'}` : 'nothing to share')
    return
  }
  o.tossInFlight = true
  void (async () => {
    const got = []
    try {
      for (const item of items) {
        let id = null
        try {
          const entry = bot.registry && bot.registry.itemsByName && bot.registry.itemsByName[item.name]
          id = entry && entry.id
        } catch (_) { id = null }
        if (typeof id !== 'number' || typeof bot.toss !== 'function') continue
        let have = 0
        try { have = countItems(bot, (n) => n === item.name) } catch (_) { have = 0 }
        const n = Math.min(have, item.count)
        if (n <= 0) continue
        try {
          await bot.toss(id, null, n)
          got.push(`${n} ${item.name}`)
        } catch (_) { /* next item */ }
      }
    } finally {
      o.tossInFlight = false
    }
    if (got.length === 0) {
      refuse(bot, ctx, `could not toss ${(items[0] && items[0].name) || 'items'}`)
      return
    }
    const one = got.length === 1 && /^1 \S/.test(got[0])
    say(bot, `${isItem ? (one ? 'here is' : 'here are') : 'shared:'} ${got.join(', ')}`)
    done(bot, ctx)
  })()
}

module.exports.sharePlan = sharePlan
module.exports.isFoodRequest = isFoodRequest
module.exports.findEdible = findEdible
module.exports.normalizeBringName = normalizeBringName
module.exports.resolveItem = resolveItem
module.exports.packCounts = packCounts
module.exports.planItemGive = planItemGive
module.exports.orderCraftNames = orderCraftNames
module.exports.itemRefusal = itemRefusal
module.exports.toWoolHunt = toWoolHunt
module.exports.refuseItemOrHunt = refuseItemOrHunt
module.exports.enterCraftOrRefuse = enterCraftOrRefuse
module.exports.craftTick = craftTick
module.exports.fetchItem = fetchItem
module.exports.shareToss = shareToss
module.exports.openSubOrder = openSubOrder
module.exports.resumeSub = resumeSub
module.exports.bedGap = bedGap
module.exports.pickSubGap = pickSubGap
module.exports.subWordFor = subWordFor
module.exports.smeltingGap = smeltingGap
