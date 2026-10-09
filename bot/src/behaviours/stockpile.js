'use strict'

// stockpile: the home chest (idkcraft-atl.14). While the owner is away the
// bot banks its surplus in a chest by the house instead of hauling it to a
// player: adopt-or-place the chest at table+1 east, then deposit everything
// the body still needs on hand (tools, light fuel, food, pillar reserve).
//
// Chest contract (shared with rw4.13 torches): ctx.home.chest is a plain
// { x, y, z } like ctx.home.table, claimed only once the chest block is
// really there. Placement scans CHEST_SPOTS in order — table+1 east first,
// then the neighbouring cells — for solid ground below and air at the cell.
// Adopt-on-sight: a chest an earlier run left at a candidate spot is
// adopted, never rebuilt.

const { goals } = require('mineflayer-pathfinder')
const { Vec3 } = require('vec3')
const { countItems } = require('../perception')
const metrics = require('../metrics')

// Candidate chest cells, site-relative. v1 (frozen): table is BLUEPRINT[0]
// at (4,0,1), so (5,0,1) is table+1 east; all sit beside the east wall,
// clear of the door walk cell (1,0,-1) and the interior. v2 (jr2.1): inside
// the common room — (5,0,2) first, then fallbacks clear of the door path
// (3,1)-(3,2) and the bedroom approaches (2,2),(4,2). The day steps use the
// indoor chest from outside through the wall (live-verified on the rig:
// open, deposit and withdraw all work within reach).
const CHEST_SPOTS = [
  { dx: 5, dy: 0, dz: 1 },
  { dx: 4, dy: 0, dz: 0 },
  { dx: 4, dy: 0, dz: 2 },
  { dx: 5, dy: 0, dz: 0 },
  { dx: 5, dy: 0, dz: 2 },
  { dx: 6, dy: 0, dz: 1 },
]

const CHEST_SPOTS_V2 = [
  { dx: 5, dy: 0, dz: 2 },
  { dx: 1, dy: 0, dz: 2 },
  { dx: 2, dy: 0, dz: 1 },
  { dx: 1, dy: 0, dz: 1 },
  { dx: 4, dy: 0, dz: 1 },
]

// Candidate cells by home version: v2 homes bank inside the common room,
// anything else (v1, or a home that predates the version mark) beside the
// east wall as before.
function spotsFor(home) {
  return home && home.v === 2 ? CHEST_SPOTS_V2 : CHEST_SPOTS
}

// Wood ceiling (idkcraft-g0z.26): while the castle is open the pack keeps
// one stack of planks and one gather load of logs — enough for any single
// wood batch (planks 32 + fence/door/chest crafts, frame 14) plus the
// sticks/torches the other steps drink from it — and banks the rest. Before,
// the castle reserve kept every plank packed while forage chopped and craft
// converted without a limit: prod held ~700 planks in 11 slots, the pack
// filled, and dig drops were lost. LOG_KEEP mirrors goal NEED_LOGS (no
// shared import: this module must not require goal — goal requires this
// module). The ceiling only applies on a built home: pre-house the budget
// needs every plank packed.
const PLANK_KEEP = 64
const LOG_KEEP = 14
// Stone ceiling (vmzq.39): the wood-ceiling precedent for quarry yield —
// one fetch load (castlefetch FETCH stone 64) above the laying reserve
// (castle reserveOf stone 24), keep-first across variants, the rest banks
// as surplus stone beyond castle need. No shared import (stockpile must
// not require castlefetch — the demand cycle); the numbers mirror.
const STONE_KEEP = 88
function castleWoodOpen(ctx) {
  try {
    return !!(ctx && ctx.castle && ctx.castle.phase !== 'complete' && ctx.home && ctx.home.built)
  } catch (_) {
    return false
  }
}
// True when the pack holds planks past the ceiling (goal craft gate, craft
// conversion guard, forage log skip). Planks only (revmux 01 minor): logs
// at/above NEED_LOGS must still convert — conversion is what frees the log
// slot, and the depositPlan/surplusWood banking below still caps logs at
// LOG_KEEP. Fail-open: an unreadable inventory reads empty, the old
// behaviour. Built home only, castle phase ignored (ipn.17): a complete
// castle used to lift the ceiling and craft converted logs into a 13-stack
// plank pile, tossing sticks for room. Pre-house the budget needs every
// plank packed.
function woodCapped(bot, ctx) {
  try {
    if (!(ctx && ctx.home && ctx.home.built)) return false
    return countItems(bot, (n) => n.endsWith('_planks')) >= PLANK_KEEP
  } catch (_) {
    return false
  }
}
// Reserved slot (g0z.26 R2, revmux 01 major): with no adopted chest and
// nobody online the pack must never fill past PACK_RESERVE — the last slot
// is the bootstrap chest craft's room. A 36/36 chestless pack has no drain
// that is not tossing (the owner forbids it), so diggers and crafts yield
// here instead of filling it. Binds ONLY in that corner: an adopted chest
// (banking drains, however far) or any player online (the haul drains)
// opens every gate, and pre-house the budget owns the pack. Forage's chest
// quest is exempt while it can complete (forage.js questExempt).
const PACK_RESERVE = 35
function packStacks(bot) {
  try {
    const items = invItems(bot)
    return Array.isArray(items) ? items.length : 0
  } catch (_) {
    return 0
  }
}
// The reserve corner without the stack count (forage.js chest quest): built,
// chestless and alone. The quest completes early, before the reserve binds.
function reserveCorner(bot, ctx) {
  try {
    if (!ctx || !ctx.home || !ctx.home.built) return false
    if (ctx.home.chest) return false
    let level = 'none'
    try {
      level = require('./deliver').playerStatus(bot).level
    } catch (_) {
      level = 'none'
    }
    return level === 'none'
  } catch (_) {
    return false
  }
}
function slotReserved(bot, ctx) {
  try {
    return reserveCorner(bot, ctx) && packStacks(bot) >= PACK_RESERVE
  } catch (_) {
    return false
  }
}
// Above-ceiling wood in inventory order, keep-first (the ensureRoom bank
// list, craft.js). Empty when the ceiling is off.
function surplusWood(bot, ctx) {
  const out = []
  try {
    if (!castleWoodOpen(ctx)) return out
    let kp = PLANK_KEEP
    let kl = LOG_KEEP
    for (const i of invItems(bot)) {
      if (!i || typeof i.name !== 'string') continue
      const n = typeof i.count === 'number' ? i.count : 1
      if (i.name.endsWith('_planks')) {
        const k = Math.min(kp, n)
        kp -= k
        if (n - k > 0) out.push({ name: i.name, count: n - k })
      } else if (i.name.endsWith('_log')) {
        const k = Math.min(kl, n)
        kl -= k
        if (n - k > 0) out.push({ name: i.name, count: n - k })
      }
    }
  } catch (_) { /* unreadable inventory: no surplus */ }
  return out
}

// Kept kit (same shape as bring share keeps): tools/armor keep one per
// name (vmzq.39: duplicates are valuables and bank), the light fuel
// rw4.13 counts from the inventory keeps one stack (torch keeps all —
// placed soon), plus a food and scaffold reserve below.
const TOOL_KEEP = /_(pickaxe|axe|shovel|hoe|sword|helmet|chestplate|leggings|boots)$/
const EXACT_KEEP = new Set([
  'shears', 'flint_and_steel', 'bow', 'crossbow', 'trident', 'arrow', 'shield',
  'torch', 'coal', 'charcoal', 'stick',
  // Escape kit (jsf.5): the filled buckets stay for the pit climb, one
  // empty stays for the gear fill sub-step (a banked empty would reforge
  // instead of refill). Owner spares bank through the finished-goods
  // allowance below, like the forged swords and picks.
  'bucket', 'water_bucket',
])
// Per-name keep for bankable keeps (vmzq.39): tools and singles keep one
// (water_bucket two — the jsf.5 escape pair), light fuel and arrows one
// stack. Torch keeps all (Infinity): placed, never stored.
const STACK_KEEP = 64
function keepFor(name) {
  if (name === 'torch') return Infinity
  if (name === 'water_bucket') return 2
  if (name === 'coal' || name === 'charcoal' || name === 'stick' || name === 'arrow') return STACK_KEEP
  return 1
}
const FOOD_KEEP = 10
const SCAFFOLD_KEEP = 32
// Surplus batch gate (craft NEED_LOGS precedent): banking preempts forage,
// so a single dug block must not flip it — the leg would shrink to one
// block per round trip home. The menu sees surplus only past a full batch.
const SURPLUS_BATCH = 16
// Park re-probe radius: an expired full park re-arms only near home, so a
// probably-still-full chest never costs a cross-map trip (revmux 02-review).
const REPROBE_RADIUS = 32
// No-spot retry window: all six spots decidably unusable (solid cells,
// floats) stamps a park so far legs don't each cost a walk home to
// rediscover it; a freed spot retries within the hour (revmux 03-review).
const NO_SPOT_RETRY_MS = 60 * 60 * 1000
const { canBreak, CLEAR_FLORA, protectedReason, isInteractRef } = require('./util')
// A full chest parks the step, but only for this long: the owner empties
// the chest by hand (no ctx write), so the park must expire and re-probe
// instead of holding until a bring fetch or a restart (revmux 01-review).
const CHEST_FULL_RETRY_MS = 10 * 60 * 1000
// Container/place interaction reach: isMoving()==false is not arrival (no
// path reads the same), so window ops double-check the body is close
// instead of eating mineflayer's 20 s windowOpen timeout (revmux 01-review).
const INTERACT_REACH = 4
// Place reach: GoalPlaceBlock(range 4) ends on head-to-face-centre <= 4,
// so the gate must accept every valid end node (02-review geometry).
const PLACE_REACH = 4.5

function nearPos(bot, p, reach) {
  // Measured to the block CENTRE: GoalPlaceBlock ends on head-to-face
  // distance, and feet-to-corner over-measures by ~1 on +x/+z approaches,
  // failing 'far' on a valid end node (revmux 02-review).
  try {
    const bp = bot && bot.entity && bot.entity.position
    if (!bp || typeof bp.x !== 'number') return false
    return Math.hypot(bp.x - (p.x + 0.5), bp.y - (p.y + 0.5), bp.z - (p.z + 0.5)) <= reach
  } catch (_) {
    return false
  }
}

function edibles() {
  try {
    const set = require('../index').EDIBLE_FOODS
    if (set && typeof set.has === 'function') return set
  } catch (_) { /* index not loaded (unit tests): fall back below */ }
  return new Set(['bread', 'apple', 'carrot', 'cooked_beef', 'cooked_porkchop', 'cooked_chicken'])
}

// Raw fallback meats (vmzq.34): the keep fills preferred food first so hunt
// drops never push cooked food into the chest. Same deferred shape as
// edibles(); the inline set mirrors reflexes.js RAW_FALLBACK.
function rawFallback() {
  try {
    const set = require('../reflexes').RAW_FALLBACK
    if (set && typeof set.has === 'function') return set
  } catch (_) { /* reflexes not loaded: mirror below */ }
  return new Set(['beef', 'porkchop', 'mutton', 'rabbit'])
}

function isKeep(name) {
  if (typeof name !== 'string') return true
  if (EXACT_KEEP.has(name)) return true
  return TOOL_KEEP.test(name)
}

function invItems(bot) {
  try {
    const items = bot && bot.inventory && typeof bot.inventory.items === 'function' ? bot.inventory.items() : []
    return Array.isArray(items) ? items : []
  } catch (_) {
    return []
  }
}

// Inventory -> deposit list in inventory order, keeps skipped. Food keeps
// the first FOOD_KEEP edibles (the eat reflex feeds from the inventory),
// dirt+cobble keep the first SCAFFOLD_KEEP (the pillar reserve share keeps).
// Self reserve, mirror of gear.js SELF_RESERVE (round-2): owner pickaxes
// share the self pick's item name, so the allowance counts the pack minus
// the hands — a toss plus a bank can never spend the bot's own pick.
const GEAR_SELF_RESERVE = { iron_pickaxe: 1, diamond_pickaxe: 1, water_bucket: 2 }
// Gear reserve (ipn.8): while the ladder is unfinished the pack keeps sticks
// material (planks, else a log), a crafting table, and furnace cobble.
// Prod 2026-09-28 banked 106 planks + the table right before gear, which then
// idled on 'need logs for sticks', and banked 7 cobble while the furnace
// needs 8. Coal/charcoal/sticks already keep via EXACT_KEEP. Mirror of
// gear.js OWNER_WANT (no shared import: this module must not require gear —
// craft/goal cycle); the reserve only feeds stick/cobble/table rungs, so the
// done check covers the owner ledger plus the self pick rungs — a ladder past
// the last pick/sword rung needs nothing kept. Anything unreadable reads
// unfinished: a kept reserve is harmless, a banked one strands gear.
const GEAR_OWNER_WANT = {
  iron_sword: 1, iron_pickaxe: 1, diamond_sword: 1, diamond_pickaxe: 1, water_bucket: 2,
  iron_helmet: 1, iron_chestplate: 1, iron_leggings: 1, iron_boots: 1,
  diamond_helmet: 1, diamond_chestplate: 1, diamond_leggings: 1, diamond_boots: 1,
}
const GEAR_RESERVE_PLANKS = 4
const GEAR_RESERVE_COBBLE = 8
function gearLadderDone(bot, ctx) {
  try {
    const given = (ctx && ctx.gearGiven) || {}
    let noWater = false
    try {
      noWater = !!(ctx && ctx.gear && ctx.gear.noWater)
    } catch (_) { /* water unknown: rungs flow */ }
    for (const name of Object.keys(GEAR_OWNER_WANT)) {
      if (noWater && name === 'water_bucket') continue // dry home skips the bucket rung (jsf.5)
      if ((given[name] || 0) < GEAR_OWNER_WANT[name]) return false
    }
    // Self pick rungs read the pack (gear.js deriveNext selfHave shape).
    let ironPick = 0
    let diaPick = 0
    for (const i of invItems(bot)) {
      if (!i || typeof i.name !== 'string') continue
      const n = typeof i.count === 'number' ? i.count : 1
      if (i.name === 'iron_pickaxe') ironPick += n
      else if (i.name === 'diamond_pickaxe') diaPick += n
    }
    return ironPick >= 1 && diaPick >= 1
  } catch (_) {
    return false
  }
}
// Finished-goods exception (ipn.3): forged owner tools bank up to the gear
// ledger count (ctx.gearFinished); the rest of the kit stays. Without ctx
// the behaviour is exactly the old one.
function depositPlan(bot, ctx) {
  const list = invItems(bot)
  const edible = edibles()
  const raw = rawFallback()
  // Food keep, preferred-first (vmzq.34 R2, revmux 01 minor): the keep is
  // what the eater feeds from, so cooked/bread fills it before raw — an
  // early raw stack must not push later cooked food into the chest. Two
  // passes over inventory order; without raw this assigns exactly the old
  // first-10-in-order keeps.
  const foodKeep = new Map()
  {
    let left = FOOD_KEEP
    for (let pass = 0; pass < 2 && left > 0; pass++) {
      for (let idx = 0; idx < list.length && left > 0; idx++) {
        const j = list[idx]
        if (!j || typeof j.name !== 'string' || !edible.has(j.name)) continue
        if ((pass === 1) !== raw.has(j.name)) continue
        const k = Math.min(left, typeof j.count === 'number' ? j.count : 1)
        left -= k
        foodKeep.set(idx, (foodKeep.get(idx) || 0) + k)
      }
    }
  }
  let keepScaffold = SCAFFOLD_KEEP
  // Bed reserve (jr2.2): while bedroom beds are owed, the work-in-progress
  // stays packed — banking it starves the beds craft/place between picks
  // (rig-proven bank/craft cycle: the finished bed itself got banked).
  // Deferred require (bring<->stockpile cycle). Once both beds are in, the
  // leftovers bank normally.
  let bedOwed = false
  try {
    const fact = require('./beds').bedsFact(bot, ctx && ctx.home)
    bedOwed = fact === 'none' || fact === 'one'
  } catch (_) { bedOwed = false }
  // Partial wool banks (9qt0): only a craft-ready colour (3+ of one) keeps;
  // prod lost every partial to death, so 3 wool never accumulated. The beds
  // hunt is chest-first, so banked partials come back on the next hunt.
  let woolReady = false
  if (bedOwed) {
    const wool = {}
    for (const j of list) {
      if (j && typeof j.name === 'string' && j.name.endsWith('_wool')) wool[j.name] = (wool[j.name] || 0) + (typeof j.count === 'number' ? j.count : 1)
    }
    woolReady = Object.values(wool).some((n) => n >= 3) // bed.js BED_WOOL (no import: require cycle)
  }
  // + ground patches under unplaced beds (floorless-house terrain dips eat
  // a plank each — banking them strands the place between picks).
  let keepBedPlanks = 6
  try { keepBedPlanks += require('./beds').fillNeed(bot, ctx && ctx.home) || 0 } catch (_) { /* no patches */ }
  // The keep fills the top single wood first (gather-gate mirror, revmux
  // 01-review): the bed top-up measures maxPlanks of ONE wood, so keeping
  // 6 mixed in inventory order would farm logs forever while beds are held
  // (2 birch kept + 50 oak banked still reads maxPlanks=2).
  const woodKeep = {}
  if (bedOwed) {
    const totals = {}
    for (const j of list) {
      if (!j || typeof j.name !== 'string' || !j.name.endsWith('_planks')) continue
      totals[j.name] = (totals[j.name] || 0) + (typeof j.count === 'number' ? j.count : 1)
    }
    let left = keepBedPlanks
    for (const w of Object.keys(totals).sort((a, b) => totals[b] - totals[a])) {
      const k = Math.min(left, totals[w])
      woodKeep[w] = k
      left -= k
    }
  }
  // Gear reserve (ipn.8): arms while the ladder is unfinished. Without ctx
  // the behaviour is exactly the old one (finished-goods precedent).
  const gearOpen = !!ctx && !gearLadderDone(bot, ctx)
  const gearPlankKeep = {}
  let keepGearLogs = 0
  let keepGearTable = 0
  let keepGearCobble = 0
  if (gearOpen) {
    const totals = {}
    for (const j of list) {
      if (!j || typeof j.name !== 'string' || !j.name.endsWith('_planks')) continue
      totals[j.name] = (totals[j.name] || 0) + (typeof j.count === 'number' ? j.count : 1)
    }
    let totalPlanks = 0
    for (const v of Object.values(totals)) totalPlanks += v
    // Top-wood-first like the bed keep above: gear's maxPlanks reads ONE
    // wood, so the reserve must not split across woods.
    let left = GEAR_RESERVE_PLANKS
    for (const w of Object.keys(totals).sort((a, b) => totals[b] - totals[a])) {
      const k = Math.min(left, totals[w])
      gearPlankKeep[w] = k
      left -= k
    }
    if (totalPlanks < 2) keepGearLogs = 1 // no sticks material: one log crafts 4 planks
    keepGearTable = 1
    keepGearCobble = GEAR_RESERVE_COBBLE
  }
  let finished = null
  try {
    finished = (ctx && ctx.gearFinished) || null
  } catch (_) { /* no allowance */ }
  const totals = {}
  for (const j of list) {
    if (!j || typeof j.name !== 'string') continue
    totals[j.name] = (totals[j.name] || 0) + (typeof j.count === 'number' ? j.count : 1)
  }
  const plan = []
  const castleOpen = !!(ctx && ctx.castle && ctx.castle.phase !== 'complete')
  // Deferred require (castle -> build -> ... chain).
  const castleMaterial = (name) => { try { return require('./castle').isMaterial(name, ctx.castle) } catch (_) { return false } }
  let isStoneFn = null
  try { isStoneFn = require('../castle').isStone } catch (_) { isStoneFn = null }
  const isStoneName = (name) => { try { return !!isStoneFn && isStoneFn(name) } catch (_) { return false } }
  // Wood ceiling counters (g0z.26): keep-first-N per call, in inventory
  // order — the same rule surplusWood applies for ensureRoom. Null on an
  // unbuilt home: the house budget needs every plank packed (the old rule).
  const castleWoodKeep = castleWoodOpen(ctx) ? { planks: PLANK_KEEP, logs: LOG_KEEP } : null
  // Stone ceiling pool (vmzq.39): one counter across variants, same gate.
  let castleStoneKeep = castleWoodOpen(ctx) ? STONE_KEEP : null
  // Keep-first counters for bankable keeps (vmzq.39): name -> kept so far.
  const kept = {}
  let li = 0
  for (const i of list) {
    const lidx = li++
    if (!i || typeof i.name !== 'string') continue
    if (isKeep(i.name)) {
      // Bankable keeps (vmzq.39): the first keepFor(name) stay (self kit),
      // the rest bank as valuables. The finished-goods allowance rides
      // along: owner goods bank even from the keep (F >= T keeps only the
      // self reserve — a lone owner sword banks, the pack's other sword is
      // the self one). Without finished the rule is exactly keep-first.
      const n0 = typeof i.count === 'number' ? i.count : 1
      if (n0 <= 0) continue
      const T = totals[i.name] || 0
      const F = (finished && finished[i.name]) || 0
      const S = GEAR_SELF_RESERVE[i.name] || 0
      const K = keepFor(i.name)
      if (!Number.isFinite(K)) continue // torch: placed, never stored
      const keepSelf = F >= T ? S : Math.max(S, K)
      const have = kept[i.name] || 0
      const k = Math.min(Math.max(0, keepSelf - have), n0)
      kept[i.name] = have + k
      const take = n0 - k
      if (take > 0) plan.push({ name: i.name, count: take })
      continue
    }
    let n = typeof i.count === 'number' ? i.count : 1
    if (n <= 0) continue
    // Castle reserve (g0z.3): an unfinished castle keeps every castle
    // material packed — banking it would starve the next castle batch.
    // Wood is capped (g0z.26) and stone is capped (vmzq.39): the first KEEP
    // stays, the rest banks through the keeps below (bed/gear only keep
    // more, never less — bounded).
    if (castleOpen && castleMaterial(i.name)) {
      if (!castleWoodKeep) continue
      if (i.name.endsWith('_planks') || i.name.endsWith('_log')) {
        const key = i.name.endsWith('_planks') ? 'planks' : 'logs'
        const k = Math.min(castleWoodKeep[key], n)
        castleWoodKeep[key] -= k
        n -= k
        if (n <= 0) continue
      } else if (castleStoneKeep != null && isStoneName(i.name)) {
        const k = Math.min(castleStoneKeep, n)
        castleStoneKeep -= k
        n -= k
        if (n <= 0) continue
      } else continue
    }
    if (bedOwed && (i.name.endsWith('_bed') || i.name === 'string' || (woolReady && i.name.endsWith('_wool')))) continue
    if (bedOwed && i.name.endsWith('_planks')) {
      const k = Math.min(woodKeep[i.name] || 0, n)
      woodKeep[i.name] = (woodKeep[i.name] || 0) - k
      n -= k
      if (n <= 0) continue
    }
    if (gearOpen && i.name.endsWith('_planks')) {
      const k = Math.min(gearPlankKeep[i.name] || 0, n)
      gearPlankKeep[i.name] = (gearPlankKeep[i.name] || 0) - k
      n -= k
      if (n <= 0) continue
    }
    if (gearOpen && keepGearLogs > 0 && i.name.endsWith('_log')) {
      const k = Math.min(keepGearLogs, n)
      keepGearLogs -= k
      n -= k
      if (n <= 0) continue
    }
    if (gearOpen && keepGearTable > 0 && i.name === 'crafting_table') {
      const k = Math.min(keepGearTable, n)
      keepGearTable -= k
      n -= k
      if (n <= 0) continue
    }
    if (edible.has(i.name)) {
      n -= Math.min(foodKeep.get(lidx) || 0, n)
    } else if (i.name === 'cobblestone') {
      // Furnace cobble first (ipn.8): the shared scaffold pool below is
      // dirt-first, so without this a dirt-heavy pack banks the 7 cobble a
      // furnace still needs. The remainder joins the scaffold pool as before.
      const g = Math.min(keepGearCobble, n)
      keepGearCobble -= g
      n -= g
      const k = Math.min(keepScaffold, n)
      keepScaffold -= k
      n -= k
    } else if (i.name === 'dirt') {
      const k = Math.min(keepScaffold, n)
      keepScaffold -= k
      n -= k
    }
    if (n > 0) plan.push({ name: i.name, count: n })
  }
  return plan
}

function surplusCount(bot, ctx) {
  let n = 0
  for (const p of depositPlan(bot, ctx)) n += p.count
  return n
}

function blockNameAt(bot, x, y, z) {
  try {
    const b = bot && typeof bot.blockAt === 'function' ? bot.blockAt(new Vec3(x, y, z)) : null
    return (b && b.name) || null
  } catch (_) {
    return null
  }
}

// First candidate that can hold the chest: a standing chest to adopt, else
// air (or clearable flora, dug before the place) with solid ground below.
// Adopt scans FIRST across all spots: a chest at a later spot must win
// over an air cell at an earlier one (revmux 03-review). Returns
// { x, y, z, adopt }, 'unknown' when nothing is decidable (chunks dark:
// walk in, don't fail), else null.
function chestSpotFor(bot, ctx) {
  const site = ctx && ctx.home && ctx.home.site
  if (!site || typeof site.x !== 'number') return null
  const spots = spotsFor(ctx.home)
  let sawUnknown = false
  const cell = (s) => {
    const x = site.x + s.dx
    const y = site.y + s.dy
    const z = site.z + s.dz
    const at = blockNameAt(bot, x, y, z)
    if (at === null) { sawUnknown = true; return null }
    return { x, y, z, at }
  }
  for (const s of spots) {
    const c = cell(s)
    if (c && c.at === 'chest') return { x: c.x, y: c.y, z: c.z, adopt: true }
  }
  for (const s of spots) {
    const c = cell(s)
    if (!c) continue
    if (c.at !== 'air' && !CLEAR_FLORA.has(c.at)) continue
    // Bedroom cells never take a new chest (idkcraft-4nx, the equip roadside
    // precedent): the bed step fails loud on blocked cells by design, so the
    // placer avoids them. The adopt scan above still claims a standing chest
    // wherever it is. Deferred require (beds->stockpile cycle).
    try {
      if (require('./beds').isBedroomCell(ctx.home, c.x, c.y, c.z)) continue
    } catch (_) { /* untestable home: place as before */ }
    const below = blockNameAt(bot, c.x, c.y - 1, c.z)
    if (below === null) { sawUnknown = true; continue }
    if (below === 'air') continue
    return { x: c.x, y: c.y, z: c.z, adopt: false }
  }
  return sawUnknown ? 'unknown' : null
}

// What the no-chest branch can do: 'adopt' a standing chest on sight,
// 'place' one when the pack holds a chest item or 8 same-wood planks,
// 'shed' one junk stack when the unfunded quest corner overflows (R4),
// 'none' otherwise. The no-spot stamp gates placing only: a chest the
// owner puts down by hand adopts immediately, never after the hour
// (revmux 04-review). The menu gates on this so an unready bot never
// preempts a forage leg to fail at once.
function chestTodo(bot, ctx, maxPlanks) {
  try {
    const site = ctx && ctx.home && ctx.home.site
    if (site && typeof site.x === 'number') {
      for (const s of spotsFor(ctx.home)) {
        if (blockNameAt(bot, site.x + s.dx, site.y + s.dy, site.z + s.dz) === 'chest') return 'adopt'
      }
    }
  } catch (_) { /* no adopt */ }
  try {
    const stamped = ctx && ctx.chestNoSpotAt
    if (stamped != null && Date.now() - stamped < NO_SPOT_RETRY_MS) return 'none'
  } catch (_) { /* unstamped */ }
  try {
    if (countItems(bot, (n) => n === 'chest') > 0) return 'place'
    if ((maxPlanks || 0) >= 8) return 'place'
    if (questShedDue(bot, ctx)) return 'shed'
  } catch (_) { /* undecidable: none */ }
  return 'none'
}
// Quest-shed predicate (g0z.26 R4, revmux 03 major): the unfunded quest
// corner at 34+ stacks — the quest cannot chop (no free slots), so the
// stockpile step sheds one junk stack per run until the quest fits (33).
// Shared by chestTodo (menu) and the no-chest branch (behaviour): one rule,
// so feasible always runs and running was feasible. Unfunded reads
// maxPlanks<8, questPlankWoods' own rule; a chest item aboard places. Fit
// is decided at shed time, not here: the step-aside changes the ground the
// survey reads, so an unfit survey fails held (bounded) instead of gating
// the menu.
const QUEST_SHED_WIDTH = 34
function questShedDue(bot, ctx) {
  try {
    if (!reserveCorner(bot, ctx)) return false
    if (countItems(bot, (n) => n === 'chest') > 0) return false
    if (packStacks(bot) < QUEST_SHED_WIDTH) return false
    let max = 0
    try {
      const items = bot.inventory.items()
      if (!Array.isArray(items)) return false
      const perWood = {}
      for (const i of items) {
        if (!i || typeof i.name !== 'string' || !i.name.endsWith('_planks')) continue
        perWood[i.name] = (perWood[i.name] || 0) + (typeof i.count === 'number' ? i.count : 1)
      }
      for (const n of Object.values(perWood)) if (n > max) max = n
    } catch (_) { return false }
    return max < 8
  } catch (_) {
    return false
  }
}
// 6-away solid ground with headroom for the shed step-aside (below): the
// first of 8 directions that stands. Null when none reads safe.
const SHED_ASIDE_DIST = 6
function asideDest(bot, bp) {
  try {
    if (!bp || typeof bp.x !== 'number') return null
    const air = (x, y, z) => {
      const n = blockNameAt(bot, x, y, z)
      return n === 'air' || n === 'cave_air'
    }
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
      const px = Math.floor(bp.x) + dx * SHED_ASIDE_DIST
      const pz = Math.floor(bp.z) + dz * SHED_ASIDE_DIST
      const py = Math.floor(bp.y)
      const g = blockNameAt(bot, px, py - 1, pz)
      if (!g || g === 'air' || g === 'cave_air' || g === 'water' || g === 'lava') continue
      if (!air(px, py, pz) || !air(px, py + 1, pz)) continue
      return { x: px, y: py, z: pz }
    }
    return null
  } catch (_) {
    return null
  }
}
// Quest-shed branch (g0z.26 R4): shed one junk stack where the survey fits.
// Pillars eat their own ground's capacity (a second shed on the same survey
// may not fit), so a run within SHED_ASIDE_NEAR of the last shed site steps
// aside first, then sheds on fresh columns. Done re-picks (34 sheds again,
// 33 quests); a refused shed holds until the situation moves.
const SHED_ASIDE_NEAR = 8
function questShed(bot, ctx, bp) {
  // A remembered aside-dest already reached sheds here (without this the
  // arrival run asides again, an extra walk every run).
  let dest = null
  try { dest = ctx.shedAsideDest } catch (_) { dest = null }
  if (!(dest && typeof dest.x === 'number' && nearPos(bot, dest, 2.5))) dest = null
  if (!dest) {
    let aside = null
    try { aside = ctx.shedAt } catch (_) { aside = null }
    if (aside && typeof aside.x === 'number' && nearPos(bot, aside, SHED_ASIDE_NEAR)) {
      dest = asideDest(bot, bp)
      if (dest) {
        const key = `stockpile-aside:${dest.x},${dest.y},${dest.z}`
        if (key !== ctx.lastGoalKey) {
          try {
            bot.pathfinder.setGoal(new goals.GoalNear(dest.x, dest.y, dest.z, 2), false)
          } catch (_) { /* retry next tick */ }
          try { ctx.shedAsideDest = dest } catch (_) { /* dest best-effort */ }
          ctx.lastGoalKey = key
          return
        }
        let moving = false
        try { moving = bot.pathfinder.isMoving() } catch (_) { /* treat as arrived */ }
        if (moving) return
        if (!nearPos(bot, dest, 2.5) && !farStalled(ctx, key)) return
        // Arrived, or no path to fresh ground: shed in place (best-effort —
        // the survey may still fit).
      }
    }
  }
  ctx.stockpileInFlight = true
  void (async () => {
    let craftMod = null
    try { craftMod = require('./craft') } catch (_) { craftMod = null }
    let freed = false
    try {
      freed = craftMod && typeof craftMod.shedForQuest === 'function' ? await craftMod.shedForQuest(bot, ctx) : false
    } catch (_) { freed = false }
    ctx.stockpileInFlight = false
    if (freed) {
      try {
        ctx.shedAt = { x: Math.floor(bp.x), y: Math.floor(bp.y), z: Math.floor(bp.z) }
        ctx.shedAsideDest = null // shed here: the next run asides past these pillars
      } catch (_) { /* last-site best-effort */ }
      ctx.lastGoalKey = null
      ctx.stockpileHomeLatch = null // trip over
      ctx.stepStatus = 'done'
    } else {
      fail(ctx, 'shed')
    }
  })()
}

function say(bot, line) {
  try { bot.chat(line) } catch (_) { /* chat best-effort */ }
}

// Owner handover (g0z.26): when no chest can take the surplus (no spot, no
// table to craft one, or a full chest) and a player is online, the bankables
// ride the haul — deliver hands them to the owner. The bot never throws
// anything away (owner 2026-10-06). Exact-set to the bankable sum per name
// (the gear forged() shape — a repeat call cannot stack claims, and the
// keeps never ride along); deliver clamps to live anyway, so a stale claim
// can never overspend. Deferred require (deliver -> bring -> goal chain).
function offerHaul(bot, ctx) {
  let level = 'none'
  try {
    level = require('./deliver').playerStatus(bot).level
  } catch (_) {
    return false
  }
  if (level === 'none') return false
  let plan = null
  try {
    plan = depositPlan(bot, ctx)
  } catch (_) {
    return false
  }
  if (!plan || plan.length === 0) return false
  try {
    if (!ctx.haul || typeof ctx.haul !== 'object') ctx.haul = {}
    const bankable = {}
    for (const p of plan) {
      if (!p || typeof p.name !== 'string' || !(p.count > 0)) continue
      bankable[p.name] = (bankable[p.name] || 0) + p.count
    }
    for (const name of Object.keys(bankable)) ctx.haul[name] = bankable[name]
    return true
  } catch (_) {
    return false
  }
}

function fail(ctx, reason) {
  ctx.stepStatus = `failed:${reason}`
  try { ctx.stockpileHomeLatch = null } catch (_) { /* trip over */ }
}

// Far patience: consecutive far+standing ticks on one goal key before the
// 'far' verdict. A single far reading is often a recovering pathfinder,
// never a verdict (live assay); movement or a fresh goal resets. Wedge
// recovery bounds the truly stuck case (it tears the goal, ticks accrue).
const FAR_STALL_TICKS = 5
function farStalled(ctx, key) {
  const f = (ctx.stockpileFar && ctx.stockpileFar.key === key) ? ctx.stockpileFar : { key, n: 0 }
  f.n++
  ctx.stockpileFar = f
  return f.n >= FAR_STALL_TICKS
}

// Claim the chest coords only once the chest block is really there (same
// placed-station contract as the table: a ghost claim would walk bring to
// an empty cell).
function adopted(ctx, spot) {
  ctx.home.chest = new Vec3(spot.x, spot.y, spot.z) // Vec3, not plain (h9z): withChest blockAt()s it
  ctx.chestFull = false
  ctx.chestFullAt = null
  ctx.chestErrorAt = null
  ctx.chestNoSpotAt = null
  ctx.homeExpanded = false
  ctx.homeDouble = null
}

// Site adoption (vmzq.39): the home adopted() mirror for ctx.castle.siteChest.
function siteAdopted(ctx, spot) {
  ctx.castle.siteChest = new Vec3(spot.x, spot.y, spot.z)
  ctx.siteChestFullAt = null
  ctx.siteExpanded = false
  ctx.siteDouble = null
}

// Open the adopted chest (or the explicit chest at `at` — g0z.4 castle
// chest; ctx.home is never swapped), run fn(window), always close.
// { status: 'ok', value } | 'gone' | 'unknown' | 'error'.
// Unknown (blockAt null: unloaded chunk) is NOT gone — the caller walks
// closer and retries instead of dropping the adoption. An open throw on a
// LOADED chest (blocked lid, cat, lag) is an error, never unknown: the
// caller fails loud so failHolds parks the step (revmux 02-review).
async function withChest(bot, ctx, fn, at = null) {
  const c = at || (ctx && ctx.home && ctx.home.chest)
  if (!c || typeof bot.openChest !== 'function') return { status: 'gone' }
  let block = null
  let unknown = false
  try {
    block = bot.blockAt(new Vec3(c.x, c.y, c.z))
    if (!block) unknown = true
  } catch (_) { unknown = true }
  if (!block) return { status: unknown ? 'unknown' : 'gone' }
  if (block.name !== 'chest') return { status: 'gone' }
  try {
    const window = await bot.openChest(block)
    try {
      return { status: 'ok', value: await fn(window) }
    } finally {
      try { window.close() } catch (_) { /* close best-effort */ }
    }
  } catch (_) {
    return { status: 'error' }
  }
}

// Withdraw up to count of name from the adopted chest. { got } — 0 when the
// chest is gone, empty of name, or the inventory is full.
async function withdrawFromChest(bot, ctx, name, count) {
  try {
    const res = await withChest(bot, ctx, async (window) => {
      const stacks = typeof window.containerItems === 'function' ? window.containerItems() : []
      let want = count
      let got = 0
      if (Array.isArray(stacks)) {
        for (const s of stacks) {
          if (want <= 0) break
          if (!s || s.name !== name) continue
          const take = Math.min(typeof s.count === 'number' ? s.count : 1, want)
          if (take <= 0) continue
          await window.withdraw(s.type, s.metadata, take)
          want -= take
          got += take
        }
      }
      return got
    })
    return { got: res && res.status === 'ok' ? res.value : 0 }
  } catch (_) {
    return { got: 0 }
  }
}

// Withdraw up to count across several names in one window (did.1: a whole
// item family without one open per name). { got, name } — name is the first
// withdrawn concrete name, null when nothing came out. `at`: see withChest.
async function withdrawAnyFromChest(bot, ctx, names, count, at = null) {
  const want = new Set(Array.isArray(names) ? names : [])
  try {
    const res = await withChest(bot, ctx, async (window) => {
      const stacks = typeof window.containerItems === 'function' ? window.containerItems() : []
      let need = count
      let got = 0
      let first = null
      if (Array.isArray(stacks)) {
        for (const s of stacks) {
          if (need <= 0) break
          if (!s || typeof s.name !== 'string' || !want.has(s.name)) continue
          const take = Math.min(typeof s.count === 'number' ? s.count : 1, need)
          if (take <= 0) continue
          await window.withdraw(s.type, s.metadata, take)
          if (first === null) first = s.name
          need -= take
          got += take
        }
      }
      return { got, name: first }
    }, at)
    return res && res.status === 'ok' ? res.value : { got: 0, name: null }
  } catch (_) {
    return { got: 0, name: null }
  }
}

// Deposit every pack stack named in names (9qt0: beds banks partial wool
// before yielding). { put } — 0 when the chest is gone, full or unopenable.
async function depositToChest(bot, ctx, names) {
  const want = new Set(Array.isArray(names) ? names : [])
  try {
    const res = await withChest(bot, ctx, async (window) => {
      let put = 0
      for (const i of invItems(bot)) {
        if (!i || !want.has(i.name) || !(i.count > 0)) continue
        try {
          await window.deposit(i.type, null, i.count)
          put += i.count
        } catch (_) { /* full or unmovable: keep the rest */ }
      }
      return put
    })
    return { put: res && res.status === 'ok' ? res.value : 0 }
  } catch (_) {
    return { put: 0 }
  }
}

// Count stacks in the adopted chest without withdrawing (did.4: the bed
// colour/wood argmax needs chest counts before it draws). One window;
// {name: count} over names (all stacks when names is null). A vanished
// chest reads empty — the caller falls back to the pack.
async function chestCounts(bot, ctx, names) {
  const want = Array.isArray(names) ? new Set(names) : null
  try {
    const res = await withChest(bot, ctx, async (window) => {
      const stacks = typeof window.containerItems === 'function' ? window.containerItems() : []
      const out = {}
      if (Array.isArray(stacks)) {
        for (const s of stacks) {
          if (!s || typeof s.name !== 'string') continue
          if (want && !want.has(s.name)) continue
          out[s.name] = (out[s.name] || 0) + (typeof s.count === 'number' ? s.count : 1)
        }
      }
      return out
    })
    return res && res.status === 'ok' ? res.value : {}
  } catch (_) {
    return {}
  }
}

// Withdraw up to count of the first edible in the adopted chest.
// { got, name } — name null when nothing edible came out.
async function withdrawEdible(bot, ctx, count) {
  const edible = edibles()
  try {
    const res = await withChest(bot, ctx, async (window) => {
      const stacks = typeof window.containerItems === 'function' ? window.containerItems() : []
      if (!Array.isArray(stacks)) return { got: 0, name: null, status: 'ok' }
      const first = stacks.find((s) => s && typeof s.name === 'string' && edible.has(s.name))
      if (!first) return { got: 0, name: null }
      let want = count
      let got = 0
      for (const s of stacks) {
        if (want <= 0) break
        if (!s || s.name !== first.name) continue
        const take = Math.min(typeof s.count === 'number' ? s.count : 1, want)
        if (take <= 0) continue
        await window.withdraw(s.type, s.metadata, take)
        want -= take
        got += take
      }
      return { got, name: first.name }
    })
    return res && res.status === 'ok' ? res.value : { got: 0, name: null }
  } catch (_) {
    return { got: 0, name: null }
  }
}

// Castle-site storage (vmzq.39): when the castle stands far from home the
// pack banks at the site, not across the map. Adopt-on-sight like the home
// chest (any chest outside the footprint and off the door path), else place
// new (a single, doubled when full) in the stow ring. Placement never sits
// in the footprint (blueprint.inFootprint) or on the door path, and never
// on protected blocks.
const SITE_STORE_RADIUS = 64 // near-site banking range (the task radius)
const SITE_CHEST_RADIUS = 16 // adopt-on-sight range around the site centre
function siteCastleActive(ctx) {
  try {
    const st = ctx && ctx.castle
    return !!(st && st.site && typeof st.site.x === 'number' && !st.parked && st.phase !== 'complete')
  } catch (_) {
    return false
  }
}
// Castle bank (g0z.27): a complete castle banks the leftover BOM into its
// plan chest cell (prod: a 36/36 pack of planks/cobble after 'castle done'
// failed every side step). Live on every tick, so a restart with a
// complete castle banks too. The plan cell, not any footprint chest; a
// standing chest only (unloaded or a hole reads null); full parks it for
// the session (no second chest in v1). ponytail: the park lifts on restart
// only — re-arm on an emptied chest when the owner asks for it.
// Kept as a function of the chest cell so g0z.9b can point home at it.
function castleBankAt(bot, ctx) {
  try {
    const st = ctx && ctx.castle
    if (!st || !st.site || typeof st.site.x !== 'number' || st.parked || st.phase !== 'complete') return null
    if (ctx.castleBankFull) return null
    const bp = bot && bot.entity && bot.entity.position
    if (!bp || typeof bp.x !== 'number' || distXZ(bp, siteCentre(st)) > SITE_STORE_RADIUS) return null
    const c = require('../castle').absPlan(st.site, st.rot, st.blueprintVersion).cells.find((o) => o.kind === 'chest')
    if (!c || blockNameAt(bot, c.x, c.y, c.z) !== 'chest') return null
    return new Vec3(c.x, c.y, c.z)
  } catch (_) {
    return null
  }
}
// The bank keeps one bed (the spawn bed sitebed re-places) on top of the
// depositPlan kit — the stockpile keep banks beds once none are owed.
function bankPlan(bot, ctx) {
  const plan = depositPlan(bot, ctx)
  let beds = 0
  for (const i of invItems(bot)) if (i && typeof i.name === 'string' && i.name.endsWith('_bed')) beds += typeof i.count === 'number' ? i.count : 1
  let planned = 0
  for (const p of plan) if (p.name.endsWith('_bed')) planned += p.count
  if (beds === 0 || planned < beds) return plan
  const out = []
  let kept = false
  for (const p of plan) {
    if (!kept && p.name.endsWith('_bed')) {
      kept = true
      if (p.count > 1) out.push({ name: p.name, count: p.count - 1 })
      continue
    }
    out.push(p)
  }
  return out
}
function siteCentre(st) {
  try {
    const dims = require('../castle').siteDimensions(st.rot | 0, st.blueprintVersion)
    return { x: st.site.x + dims.w / 2, z: st.site.z + dims.d / 2 }
  } catch (_) {
    return { x: st.site.x, z: st.site.z }
  }
}
function distXZ(a, b) {
  try {
    return Math.hypot(a.x - b.x, a.z - b.z)
  } catch (_) {
    return Infinity
  }
}
// True when site banking owns the tick: an active castle, the body near
// the site, and home unavailable (unbuilt) or far (the home leash would
// veto). Near home the home chest wins (existing storage, tested).
function siteMode(bot, ctx) {
  try {
    if (!siteCastleActive(ctx)) {
      if (!castleBankAt(bot, ctx)) return false
    } else if (siteParked(bot, ctx)) return false
    const bp = bot && bot.entity && bot.entity.position
    if (!bp || typeof bp.x !== 'number') return false
    if (distXZ(bp, siteCentre(ctx.castle)) > SITE_STORE_RADIUS) return false
    const h = ctx && ctx.home && ctx.home.site
    if (!ctx || !ctx.home || ctx.home.built !== true) return true
    if (!h || typeof h.x !== 'number') return true
    return distXZ(bp, h) > SITE_STORE_RADIUS
  } catch (_) {
    return false
  }
}
// Standing site chest: any chest within adopt range, outside the footprint
// and off the door path, nearest first. The owner's in-footprint castle
// chest is never storage (castlefetch withdraws from it, never deposits).
function findSiteChest(bot, ctx) {
  try {
    const st = ctx && ctx.castle
    if (!st || !st.site) return null
    const blueprint = require('../castle')
    const castleMod = require('./castle')
    const e = bot.registry && bot.registry.blocksByName && bot.registry.blocksByName.chest
    if (!e || typeof bot.findBlocks !== 'function') return null
    const c = siteCentre(st)
    const cy = typeof st.site.y === 'number' ? st.site.y : 64
    let hits = []
    try {
      hits = bot.findBlocks({ point: new Vec3(c.x, cy, c.z), matching: e.id, maxDistance: SITE_CHEST_RADIUS, count: 16 }) || []
    } catch (_) { hits = [] }
    let best = null
    for (const h of hits) {
      if (!h || typeof h.x !== 'number') continue
      try {
        if (blueprint.inFootprint(st, h)) continue
        if (castleMod.onDoorPath(st, h.x, h.z)) continue
      } catch (_) { continue }
      const d = Math.hypot(h.x - c.x, h.z - c.z)
      if (!best || d < best.d) best = { x: h.x, y: h.y, z: h.z, d }
    }
    return best ? { x: best.x, y: best.y, z: best.z } : null
  } catch (_) {
    return null
  }
}
// What the site branch can do: 'store' into the adopted chest, 'adopt' a
// standing one, 'place' a new single when funded (a chest item or 8
// same-wood planks) and the stow ring has room, else 'none'. The menu
// gates on this so an unready bot never preempts a castle leg to fail.
function siteChestTodo(bot, ctx) {
  try {
    const st = ctx && ctx.castle
    if (!st) return 'none'
    if (castleBankAt(bot, ctx)) return 'store'
    if (st.siteChest && typeof st.siteChest.x === 'number') return 'store'
    if (findSiteChest(bot, ctx)) return 'adopt'
    if (countItems(bot, (n) => n === 'chest') <= 0) {
      let max = 0
      try {
        const perWood = {}
        for (const i of invItems(bot)) {
          if (!i || typeof i.name !== 'string' || !i.name.endsWith('_planks')) continue
          perWood[i.name] = (perWood[i.name] || 0) + (typeof i.count === 'number' ? i.count : 1)
        }
        for (const n of Object.values(perWood)) if (n > max) max = n
      } catch (_) { max = 0 }
      if (max < 8) return 'none'
      // The site craft needs a table within reach: placeChest's noFarTable
      // fails past 32, so planks alone must not read 'place' — the menu
      // would preempt a castle leg to fail at once (revmux 01-review-b).
      try {
        if (!tableWithin(bot, ctx, 32)) return 'none'
      } catch (_) { return 'none' }
    }
    try {
      if (!require('./castle').stowSpot(bot, st, null)) return 'none'
    } catch (_) { return 'none' }
    return 'place'
  } catch (_) {
    return 'none'
  }
}
// Adjacent double cell for a chest (vmzq.39): the 4 side neighbours in
// fixed order, first air (or clearable flora) with solid non-protected
// ground below, air above for the lid, outside the footprint and off the
// door path when a castle stands. Null when the chest is already doubled
// on every side or nothing qualifies. Pure scan (blockAt reads only).
function doubleSpot(bot, ctx, chestPos) {
  try {
    if (!chestPos || typeof chestPos.x !== 'number') return null
    const st = ctx && ctx.castle && ctx.castle.site ? ctx.castle : null
    let blueprint = null
    let castleMod = null
    try { blueprint = require('../castle') } catch (_) { blueprint = null }
    try { castleMod = require('./castle') } catch (_) { castleMod = null }
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const x = chestPos.x + dx
      const y = chestPos.y
      const z = chestPos.z + dz
      const at = blockNameAt(bot, x, y, z)
      if (at === null) continue // unknown: not decidable, try the next side
      if (at === 'chest') continue // already doubled here
      if (at !== 'air' && at !== 'cave_air' && !CLEAR_FLORA.has(at)) continue
      if (st && blueprint && castleMod) {
        try {
          if (blueprint.inFootprint(st, { x, y, z })) continue
          if (castleMod.onDoorPath(st, x, z)) continue
        } catch (_) { continue }
      }
      const above = blockNameAt(bot, x, y + 1, z)
      if (above !== 'air' && above !== 'cave_air') continue
      let below = null
      try { below = bot.blockAt(new Vec3(x, y - 1, z)) } catch (_) { below = null }
      if (!below || below.boundingBox !== 'block') continue
      try {
        const { isLiquidName } = require('./flat')
        if (isLiquidName(below.name)) continue
      } catch (_) { /* not liquid */ }
      try {
        if (isInteractRef(below.name)) continue
      } catch (_) { /* not interactive */ }
      try {
        if (protectedReason(bot, below, ctx || {})) continue
      } catch (_) { continue }
      if (at !== 'air' && at !== 'cave_air') {
        // Clearable flora: the placer digs it first — must be breakable.
        let cell = null
        try { cell = bot.blockAt(new Vec3(x, y, z)) } catch (_) { cell = null }
        try {
          if (!cell || !canBreak(bot, cell, ctx || {})) continue
        } catch (_) { continue }
      }
      return { x, y, z }
    }
    return null
  } catch (_) {
    return null
  }
}
// Site full park (the home chestParked mirror): a site chest that took
// nothing parks for CHEST_FULL_RETRY_MS; expired parks re-arm only near
// the site, never from across the map.
function siteParked(bot, ctx) {
  try {
    const st = ctx && ctx.castle
    const c = st && st.siteChest
    if (!c || typeof c.x !== 'number') return false
    const at = ctx ? ctx.siteChestFullAt : null
    if (at == null) return false
    if (Date.now() - at < CHEST_FULL_RETRY_MS) return true
    const bp = bot && bot.entity && bot.entity.position
    return !(bp && typeof bp.x === 'number' &&
      Math.hypot(bp.x - c.x, bp.y - c.y, bp.z - c.z) <= REPROBE_RADIUS)
  } catch (_) {
    return false
  }
}

// Pending-double state (revmux 01-review-b major 1): the full branch
// issued a multi-tick place, so the next tick must resume it instead of
// re-issuing the deposit goal over it. 'landed' (a chest now) and 'shut'
// (no longer air/flora — something else took the cell) drop the pending
// and the deposit proceeds; a double that still takes nothing parks via
// the expanded flag, never loops. Unknown (dark chunk) reads open:
// placeChest walks in, or fails bounded like any far leg.
function doublePending(bot, pending) {
  let at = null
  try { at = blockNameAt(bot, pending.x, pending.y, pending.z) } catch (_) { at = null }
  if (at === 'chest') return 'landed'
  if (at === null || at === 'air' || at === 'cave_air') return 'open'
  try { if (CLEAR_FLORA.has(at)) return 'open' } catch (_) { /* not flora */ }
  return 'shut'
}

// A banked pack re-arms a pack-full fetch leg (vmzq.39): the hold exists
// because the dig had no room, and room is what banking just made —
// retrying now resumes in seconds, not after the 5-min bound. Only the
// pack-full fail clears; any other failure keeps its hold.
function clearPackFullHold(ctx) {
  try {
    const sf = ctx && ctx.stepFail && ctx.stepFail.castlefetch
    if (sf && sf.status === 'failed:castlefetch-pack-full') delete ctx.stepFail.castlefetch
  } catch (_) { /* hold best-effort */ }
}

// First verified-standing table (h9z): a ghost home claim must not shadow
// the standing roadside table (craft.js pattern). Shared by placeChest and
// siteChestTodo — one scan, so the menu never promises a craft the step
// cannot start (revmux 01-review-b major 3).
function standingTable(bot, ctx) {
  const cands = [ctx && ctx.home && ctx.home.table, ctx && ctx.claimedTable]
  for (const cand of cands) {
    if (!cand || typeof cand.x !== 'number') continue
    try {
      const b = bot.blockAt && bot.blockAt(new Vec3(cand.x, cand.y, cand.z))
      if (b && b.name === 'crafting_table') return cand
    } catch (_) { /* unreadable: try the next claim */ }
  }
  return null
}

// A verified-standing table within maxD (XZ) of the body.
function tableWithin(bot, ctx, maxD) {
  try {
    const t = standingTable(bot, ctx)
    if (!t) return false
    const bp = bot && bot.entity && bot.entity.position
    if (!bp || typeof bp.x !== 'number') return false
    return Math.hypot(bp.x - t.x, bp.z - t.z) <= maxD
  } catch (_) {
    return false
  }
}

// A double is armed only when placeChest can plausibly start it (revmux
// 02-after-fix major 2): a chest item places anywhere, while the planks
// craft needs a table — within 32 at the site (noFarTable fails past it),
// merely standing at home (the walk is the home branch's own leg).
function doubleArmed(bot, ctx, site) {
  try {
    if (!fundedForChest(bot)) return false
    if (countItems(bot, (n) => n === 'chest') > 0) return true
    return site ? tableWithin(bot, ctx, 32) : !!standingTable(bot, ctx)
  } catch (_) {
    return false
  }
}

// Funded for a new chest: a chest item, or 8 same-wood planks to craft one
// (the table check rides with placeChest — site passes noFarTable).
function fundedForChest(bot) {
  try {
    if (countItems(bot, (n) => n === 'chest') > 0) return true
    const perWood = {}
    for (const i of invItems(bot)) {
      if (!i || typeof i.name !== 'string' || !i.name.endsWith('_planks')) continue
      perWood[i.name] = (perWood[i.name] || 0) + (typeof i.count === 'number' ? i.count : 1)
    }
    for (const n of Object.values(perWood)) if (n >= 8) return true
    return false
  } catch (_) {
    return false
  }
}

// Site banking (vmzq.39): the home branch mirror for ctx.castle.siteChest.
// Adopt-on-sight, else place a single in the stow ring; a full chest
// doubles (adjacent, one expansion per fill), else a new single nearby,
// else the site parks and the haul rides to the owner when one is online.
function stockpileSite(bot, ctx, bp) {
  const st = ctx && ctx.castle
  if (!st || !st.site) {
    fail(ctx, 'no-home')
    return
  }
  // Castle bank (g0z.27): the plan chest is the target — no adopt, no
  // place, no double; the deposit below is shared.
  const bankAt = castleBankAt(bot, ctx)
  if (!bankAt && !st.siteChest) {
    let found = null
    try { found = findSiteChest(bot, ctx) } catch (_) { found = null }
    if (found) {
      siteAdopted(ctx, found)
    } else {
      let spot = null
      try {
        if (siteChestTodo(bot, ctx) === 'place') spot = require('./castle').stowSpot(bot, st, null)
      } catch (_) { spot = null }
      if (spot) {
        placeChest(bot, ctx, spot, bp, { adopt: 'site', goalPrefix: 'stockpile-site-place', sayPlaced: 'placed the site chest', noFarTable: true })
        return
      }
      if (offerHaul(bot, ctx)) say(bot, 'no room for a site chest — bringing the surplus to you')
      fail(ctx, 'no-spot')
      return
    }
  }
  let c = bankAt || st.siteChest
  let at = null
  try { at = blockNameAt(bot, c.x, c.y, c.z) } catch (_) { at = null }
  if (at === null) {
    const key = `stockpile-site:${c.x},${c.y},${c.z}`
    if (key !== ctx.lastGoalKey) {
      try { bot.pathfinder.setGoal(new goals.GoalNear(c.x, c.y, c.z, 2), false) } catch (_) { /* retry next tick */ }
      ctx.lastGoalKey = key
      return
    }
    let moving = false
    try { moving = bot.pathfinder.isMoving() } catch (_) { /* treat as arrived */ }
    if (moving) return
    if (!nearPos(bot, c, INTERACT_REACH)) {
      if (!farStalled(ctx, key)) return
      fail(ctx, 'far')
      return
    }
    return
  }
  if (at !== 'chest') {
    st.siteChest = null
    ctx.siteDouble = null // the double's neighbour is gone too
    ctx.stepStatus = 'running'
    stockpileSite(bot, ctx, bp)
    return
  }
  const planOf = bankAt ? bankPlan : depositPlan
  const plan = planOf(bot, ctx)
  if (plan.length === 0) {
    ctx.siteDouble = null
    ctx.stockpileHomeLatch = null // trip over
    ctx.stepStatus = 'done'
    return
  }
  // Pending double first: resume the multi-tick place, never the deposit
  // goal over it (doublePending above).
  if (!bankAt && ctx.siteDouble && typeof ctx.siteDouble.x === 'number') {
    const st8 = doublePending(bot, ctx.siteDouble)
    if (st8 === 'open') {
      placeChest(bot, ctx, ctx.siteDouble, bp, { adopt: 'none', goalPrefix: 'stockpile-site-double', sayPlaced: 'doubled the site chest', noFarTable: true, pendingKey: 'siteDouble' })
      return
    }
    if (st8 === 'landed') {
      // The fresh half becomes the chest (revmux 02-after-fix major 4):
      // merged or a lone single, it holds the new room — the facing the
      // place landed with no longer matters. This fill's expansion is
      // spent, so a still-full double parks instead of fielding chests.
      siteAdopted(ctx, ctx.siteDouble)
      ctx.siteExpanded = true
      c = st.siteChest
    }
    ctx.siteDouble = null // shut: the deposit below decides
  }
  const key = `stockpile-site:${c.x},${c.y},${c.z}`
  if (key !== ctx.lastGoalKey) {
    try { bot.pathfinder.setGoal(new goals.GoalNear(c.x, c.y, c.z, 2), false) } catch (_) { /* retry next tick */ }
    ctx.lastGoalKey = key
    return
  }
  let moving = false
  try { moving = bot.pathfinder.isMoving() } catch (_) { /* treat as arrived */ }
  if (moving) return
  if (!nearPos(bot, c, INTERACT_REACH)) {
    if (!farStalled(ctx, key)) return
    fail(ctx, 'far')
    return
  }
  ctx.stockpileInFlight = true
  void (async () => {
    try {
      let before = 0
      for (const p of planOf(bot, ctx)) before += p.count
      const names = []
      let banked = 0
      const res = await withChest(bot, ctx, async (window) => {
        for (const p of planOf(bot, ctx)) {
          const entry = bot.registry && bot.registry.itemsByName && bot.registry.itemsByName[p.name]
          const type = entry && typeof entry.id === 'number' ? entry.id : null
          if (type == null) continue
          try {
            await window.deposit(type, null, p.count)
            banked += p.count
            names.push(`${p.count} ${p.name}`)
          } catch (_) { /* chest full or stack unmovable: stop at the rest */ }
        }
        return true
      }, c)
      ctx.stockpileInFlight = false
      if (!res || res.status === 'gone') {
        if (!bankAt) st.siteChest = null // a gone castle chest: castleBankAt reads null next tick
        ctx.siteDouble = null
        ctx.stepStatus = 'running'
        ctx.lastGoalKey = null
        return
      }
      if (res.status === 'unknown') {
        ctx.stepStatus = 'running'
        ctx.lastGoalKey = null
        return
      }
      if (res.status === 'error') {
        // A lid that will not open says nothing about fullness: the bank
        // stays armed, failHolds parks the step (revmux 01 major).
        if (!bankAt) ctx.siteChestFullAt = Date.now()
        fail(ctx, 'deposit')
        return
      }
      if (banked > 0) {
        ctx.siteChestFullAt = null
        ctx.siteExpanded = false
        clearPackFullHold(ctx)
        // The summary once per session (revmux 01 minor): later banks are
        // plain stockpile lines, not a fresh completion event.
        if (bankAt && !ctx.castleBankSaid) {
          ctx.castleBankSaid = true
          say(bot, `castle done at ${st.site.x} ${st.site.y} ${st.site.z}, ${banked} items banked in the castle chest`)
        } else say(bot, `stockpiled ${names.join(', ')}`)
      }
      if (bankAt && before > 0 && banked === 0) {
        ctx.castleBankFull = true
        say(bot, 'the castle chest is full')
        if (offerHaul(bot, ctx)) say(bot, 'bringing the surplus to you instead')
      } else if (before > 0 && banked === 0) {
        // Full: double once per fill (adjacent halves share one window),
        // then the site parks. The next run retries after the owner
        // empties it; a doubled chest that still takes nothing is parked,
        // never expanded into a chest field.
        if (!ctx.siteExpanded && doubleArmed(bot, ctx, true)) {
          let dbl = null
          try { dbl = doubleSpot(bot, ctx, c) } catch (_) { dbl = null }
          if (dbl) {
            ctx.siteExpanded = true
            ctx.siteDouble = dbl // pending: the deposit path resumes it (below)
            ctx.lastGoalKey = null
            ctx.stepStatus = 'running'
            placeChest(bot, ctx, dbl, bp, { adopt: 'none', goalPrefix: 'stockpile-site-double', sayPlaced: 'doubled the site chest', noFarTable: true, pendingKey: 'siteDouble' })
            return
          }
        }
        ctx.siteChestFullAt = Date.now()
        say(bot, 'the site chest is full')
        if (offerHaul(bot, ctx)) say(bot, 'bringing the surplus to you instead')
      }
      ctx.stockpileHomeLatch = null // trip over
      ctx.stepStatus = 'done'
    } catch (_) {
      ctx.stockpileInFlight = false
      fail(ctx, 'deposit')
    }
  })()
}

// A synchronous site failure (no-spot, no-chest, far): async paths leave
// 'running' and must never fall through to home mid-window.
function failedSync(ctx) {
  try {
    return typeof ctx.stepStatus === 'string' && ctx.stepStatus.startsWith('failed:')
  } catch (_) {
    return false
  }
}

// Home fallback (revmux 01-review-b major 2): the home branch the
// stockpile feasible approved — a standing or fundable home chest plus the
// vmzq.19 shape (pack-full pierce, pierce latch, or no leash veto).
// Without the leash shape the fallback would march across a vetoed leash
// feasible never allowed.
function homeFallbackViable(bot, ctx) {
  try {
    const home = ctx && ctx.home
    if (!home || !home.site || typeof home.site.x !== 'number') return false
    if (!home.chest && !fundedForChest(bot)) {
      try { if (!questShedDue(bot, ctx)) return false } catch (_) { return false }
    }
    const goal = require('../goal') // deferred: goal requires this module at load
    try { if (goal.packFull(bot, ctx)) return true } catch (_) { /* leash below */ }
    if (ctx && ctx.stockpilePierced) return true
    try { return !goal.homeLegVetoed(bot, ctx, 'stockpile') } catch (_) { return false }
  } catch (_) {
    return false
  }
}

function stockpile(bot, ctx, target, state) {
  if (!ctx) return
  if (ctx.stockpileInFlight) return // exactly one window op at a time (craft.js rule)
  const bp = bot && bot.entity && bot.entity.position
  if (!bp) return
  // Latched fallback (trip latch): while the site situation reads the
  // same, later ticks — including facts-changed re-picks, which re-stamp
  // stepPick every 1-3 s near the site — skip the failing site instead of
  // swapping goals every flip (revmux 03-after-fix major 1). A changed
  // site retries below; terminal outcomes clear the latch at their own
  // exits (fail + dones), ending the trip.
  try {
    if (ctx.stockpileHomeLatch) {
      let todo = null
      try { todo = siteChestTodo(bot, ctx) } catch (_) { todo = null }
      if (todo !== null && todo !== ctx.stockpileHomeLatch) ctx.stockpileHomeLatch = null
    }
  } catch (_) { /* keep */ }
  // Site banking (vmzq.39): an active far castle banks at the site, never
  // across the map. Falls back to home below when the site fails
  // synchronously and the home leg is the feasible-approved unblock.
  try {
    if (siteMode(bot, ctx) && !ctx.stockpileHomeLatch) {
      stockpileSite(bot, ctx, bp)
      if (!failedSync(ctx) || !homeFallbackViable(bot, ctx)) return
      // The site cannot take it: the home walk is the unblock feasible
      // approved (vmzq.19 R3 pierce), so clear the site failure and run
      // the home branch below. Latched for the trip on the failing site
      // todo: without it the next tick re-runs the failing site first and
      // the two goals swap every tick (revmux 02-after-fix major 1). The
      // pierce latches too — the trip must survive a partial bank like a
      // home-branch pick (R4).
      ctx.stepStatus = 'running'
      ctx.lastGoalKey = null
      try {
        ctx.stockpileHomeLatch = siteChestTodo(bot, ctx)
        ctx.stockpilePierced = true
      } catch (_) { ctx.stockpileHomeLatch = 'none' }
    }
  } catch (_) { /* undecidable: home below */ }
  const home = ctx.home
  if (!home || !home.site) {
    fail(ctx, 'no-home')
    return
  }

  // Adopt-on-sight: a chest an earlier run left at a candidate spot is
  // claimed, never rebuilt. A ghost claim (mined chest) unadopts.
  if (!home.chest) {
    let spot = null
    try {
      spot = chestSpotFor(bot, ctx)
    } catch (_) { spot = null }
    if (spot === 'unknown') {
      // Home chunk dark (returning from a far leg): walk in so the scan
      // can decide. Failing here would preempt every leg to fail at once.
      const site = home.site
      const key = `stockpile-site:${site.x},${site.y},${site.z}`
      if (key !== ctx.lastGoalKey) {
        try {
          bot.pathfinder.setGoal(new goals.GoalNear(site.x + 2, site.y, site.z + 2, 3), false)
        } catch (_) { /* retry next tick */ }
        ctx.lastGoalKey = key
        return
      }
      let moving = false
      try { moving = bot.pathfinder.isMoving() } catch (_) { /* treat as arrived */ }
      if (moving) return
      if (!nearPos(bot, { x: site.x + 2, y: site.y, z: site.z + 2 }, REPROBE_RADIUS)) {
        if (!farStalled(ctx, key)) return
        fail(ctx, 'far') // issued, standing, still far: no path home
        return
      }
      return // arrived but the scan is still dark: retry next tick
    }
    if (spot && spot.adopt) {
      adopted(ctx, spot)
    } else if (spot && questShedDue(bot, ctx)) {
      questShed(bot, ctx, bp)
      return
    } else if (spot) {
      placeChest(bot, ctx, spot, bp)
      return
    } else {
      ctx.chestNoSpotAt = Date.now()
      if (offerHaul(bot, ctx)) say(bot, 'no room for a chest — bringing the surplus to you')
      fail(ctx, 'no-spot')
      return
    }
  }

  const c = home.chest
  let at = null
  try {
    at = blockNameAt(bot, c.x, c.y, c.z)
  } catch (_) { at = null }
  if (at === null) {
    // Chunk unknown (bot far from home): walk in so it loads. Never
    // unadopt on unknown — that deletes a good claim from 200 blocks out.
    const key = `stockpile:${c.x},${c.y},${c.z}`
    if (key !== ctx.lastGoalKey) {
      try {
        bot.pathfinder.setGoal(new goals.GoalNear(c.x, c.y, c.z, 2), false)
      } catch (_) { /* retry next tick */ }
      ctx.lastGoalKey = key
      return
    }
    let moving = false
    try { moving = bot.pathfinder.isMoving() } catch (_) { /* treat as arrived */ }
    if (moving) return
    if (!nearPos(bot, c, INTERACT_REACH)) {
      if (!farStalled(ctx, key)) return
      fail(ctx, 'far') // issued, standing, still far: no path
      return
    }
    return // arrived but the chunk is still dark: retry next tick
  }
  if (at !== 'chest') {
    home.chest = null // mined or never there: re-place, same step
    ctx.homeDouble = null // the double's neighbour is gone too
    ctx.stepStatus = 'running'
    stockpile(bot, ctx, target, state)
    return
  }

  const plan = depositPlan(bot, ctx)
  if (plan.length === 0) {
    ctx.homeDouble = null
    ctx.stockpileHomeLatch = null // trip over
    ctx.stepStatus = 'done'
    return
  }
  // Pending double first: resume the multi-tick place, never the deposit
  // goal over it (doublePending above).
  if (ctx.homeDouble && typeof ctx.homeDouble.x === 'number') {
    if (doublePending(bot, ctx.homeDouble) === 'open') {
      placeChest(bot, ctx, ctx.homeDouble, bp, { adopt: 'none', goalPrefix: 'stockpile-double', sayPlaced: 'doubled the home chest', pendingKey: 'homeDouble' })
      return
    }
    // Landed or shut: the old chest stays adopted. Every withdraw path
    // opens only ctx.home.chest, so adopting the fresh half would orphan
    // the stored valuables when the halves do not merge (revmux
    // 03-after-fix major 2); an unmerged home double parks like a full
    // chest, its contents kept. (The site adopts the fresh half — nothing
    // withdraws from a site chest.)
    ctx.homeDouble = null
  }

  const key = `stockpile:${c.x},${c.y},${c.z}`
  if (key !== ctx.lastGoalKey) {
    try {
      bot.pathfinder.setGoal(new goals.GoalNear(c.x, c.y, c.z, 2), false)
    } catch (_) { /* retry next tick */ }
    ctx.lastGoalKey = key
    return
  }
  let moving = false
  try { moving = bot.pathfinder.isMoving() } catch (_) { /* treat as arrived */ }
  if (moving) return
  if (!nearPos(bot, c, INTERACT_REACH)) {
    // No path reads as !moving too: fail instead of eating the 20 s
    // windowOpen timeout on an out-of-range open (revmux 01-review).
    // Five consecutive far ticks: one is often a recovering pathfinder.
    if (!farStalled(ctx, key)) return
    fail(ctx, 'far')
    return
  }

  ctx.stockpileInFlight = true
  void (async () => {
    try {
      const before = surplusCount(bot, ctx)
      const names = []
      const bankedByName = {}
      let banked = 0
      const res = await withChest(bot, ctx, async (window) => {
        for (const p of depositPlan(bot, ctx)) {
          const entry = bot.registry && bot.registry.itemsByName && bot.registry.itemsByName[p.name]
          const type = entry && typeof entry.id === 'number' ? entry.id : null
          if (type == null) continue
          try {
            await window.deposit(type, null, p.count)
            banked += p.count
            bankedByName[p.name] = (bankedByName[p.name] || 0) + p.count
            names.push(`${p.count} ${p.name}`)
          } catch (_) { /* chest full or stack unmovable: stop at the rest */ }
        }
        return true
      })
      ctx.stockpileInFlight = false
      if (!res || res.status === 'gone') {
        home.chest = null // vanished mid-step: re-place, same step
        ctx.homeDouble = null
        ctx.stepStatus = 'running'
        ctx.lastGoalKey = null
        return
      }
      if (res.status === 'unknown') {
        // Chunk unloaded mid-open: walk back in, keep the claim.
        ctx.stepStatus = 'running'
        ctx.lastGoalKey = null
        return
      }
      if (res.status === 'error') {
        // Lid blocked or open timed out: seal like a full chest (time +
        // near-home re-probe) so far legs don't each cost a walk + 20 s.
        ctx.chestErrorAt = Date.now()
        fail(ctx, 'deposit')
        return
      }
      if (banked > 0) {
        let handed = []
        try {
          const fin = ctx.gearFinished && typeof ctx.gearFinished === 'object' ? ctx.gearFinished : null
          if (fin) {
            if (!ctx.gearGiven || typeof ctx.gearGiven !== 'object') ctx.gearGiven = {}
            for (const name of Object.keys(bankedByName)) {
              if ((fin[name] || 0) <= 0) continue
              const c = Math.min(fin[name], bankedByName[name])
              fin[name] -= c
              ctx.gearGiven[name] = (ctx.gearGiven[name] || 0) + c
              try {
                if (c > 0) metrics.gearGiven.inc({ piece: name, channel: 'bank' }, c)
              } catch (_) { /* metrics best-effort */ }
              try {
                if (ctx.haul && typeof ctx.haul === 'object') ctx.haul[name] = Math.max(0, (ctx.haul[name] || 0) - c)
              } catch (_) { /* haul best-effort */ }
              handed.push(`${c} ${name}`)
            }
          }
        } catch (_) { /* ledger best-effort */ }
        // Pantry signal (ipn.6): ladder mats banked mid-rung re-arm gear's
        // chest withdraw. Names mirror gear's RUNGS mats + smeltable ore
        // (no shared import: this module must not require gear — cycle).
        try {
          if ((bankedByName.raw_iron || 0) > 0 || (bankedByName.iron_ingot || 0) > 0 || (bankedByName.diamond || 0) > 0) {
            ctx.gearPantryBanked = (ctx.gearPantryBanked || 0) + 1
          }
        } catch (_) { /* signal best-effort */ }
        ctx.chestFull = false
        ctx.chestFullAt = null
        ctx.chestErrorAt = null
        ctx.homeExpanded = false
        clearPackFullHold(ctx)
        say(bot, `stockpiled ${names.join(', ')}`)
        if (handed.length > 0) {
          say(bot, `handed ${handed.join(', ')} to the home chest`)
          try {
            console.log(`gear handed ${handed.join(', ')} to chest`)
          } catch (_) { /* logging best-effort */ }
        }
      }
      if (before > 0 && banked === 0) {
        // Full: double once per fill (vmzq.39), then park. Done, not
        // failed — failing would hold and spam; the stamped flag parks the
        // step until the retry window expires or a bring fetch re-arms it.
        if (!ctx.homeExpanded && doubleArmed(bot, ctx, false)) {
          let dbl = null
          try { dbl = doubleSpot(bot, ctx, c) } catch (_) { dbl = null }
          if (dbl) {
            ctx.homeExpanded = true
            ctx.homeDouble = dbl // pending: the deposit path resumes it (below)
            ctx.lastGoalKey = null
            ctx.stepStatus = 'running'
            placeChest(bot, ctx, dbl, bp, { adopt: 'none', goalPrefix: 'stockpile-double', sayPlaced: 'doubled the home chest', pendingKey: 'homeDouble' })
            return
          }
        }
        ctx.chestFull = true
        ctx.chestFullAt = Date.now()
        say(bot, 'the home chest is full')
        if (offerHaul(bot, ctx)) say(bot, 'bringing the surplus to you instead')
      }
      ctx.stockpileHomeLatch = null // trip over
      ctx.stepStatus = 'done'
    } catch (_) {
      ctx.stockpileInFlight = false
      fail(ctx, 'deposit')
    }
  })()
}

// Ensure a chest item (craft one at the placed table when needed) and place
// it at the spot. One in-flight op; ticks re-enter until adopted.
// opts.adopt: 'home' (default) adopts ctx.home.chest, 'site' adopts
// ctx.castle.siteChest, 'none' keeps the adoption (a double). opts.noFarTable
// (site mode): a table past 32 fails instead of walking across the map.
// opts.pendingKey (a double): the ctx key to clear when the place fails.
function placeChest(bot, ctx, spot, bp, opts = {}) {
  const adoptMode = opts.adopt || 'home'
  const goalPrefix = opts.goalPrefix || 'stockpile-place'
  const sayPlaced = opts.sayPlaced || 'placed the home chest'
  // A failed double clears its pending (revmux 02-after-fix major 2):
  // without this every later pick retries the same hopeless place and
  // the full chest never parks. opts.pendingKey names ctx.siteDouble or
  // ctx.homeDouble; the initial place passes none.
  // The craftany chest run (ipn.16) is dropped the moment this step stops
  // polling it (chest packed, table standing, failed): a lingering run reads
  // as an open craft to beds' gate and a later pick would reuse stale state.
  const dropRun = () => {
    try { if (ctx.craftany && ctx.craftany.key === 'chestx1') ctx.craftany = null } catch (_) { /* best-effort */ }
  }
  const failHere = (reason) => {
    try { if (opts.pendingKey) ctx[opts.pendingKey] = null } catch (_) { /* clear best-effort */ }
    dropRun()
    fail(ctx, reason)
  }
  const have = countItems(bot, (n) => n === 'chest')
  if (have > 0) dropRun()
  if (have <= 0) {
    // Deferred require: stockpile loads during goal's load (goal requires
    // this module), while craft destructures NEED_LOGS off goal at load —
    // a top-level require here would hand craft a half-loaded goal.
    let craftMod = null
    try { craftMod = require('./craft') } catch (_) { craftMod = null }
    let tableBlock = null
    let tablePos = null
    if (craftMod) {
      tablePos = standingTable(bot, ctx)
      if (tablePos) {
        try {
          tableBlock = bot.blockAt && bot.blockAt(new Vec3(tablePos.x, tablePos.y, tablePos.z))
          if (!tableBlock || tableBlock.name !== 'crafting_table') tableBlock = null
        } catch (_) { tableBlock = null }
      }
      if (!tableBlock) tablePos = null
    }
    // No standing table (ipn.16): craftany places one (pack item or 4
    // planks/logs, TABLE_TRIES) and crafts the chest at it — the home chest
    // never came because nothing else ever placed a table for it. Site mode
    // (noFarTable) keeps the old fail: craftany may walk to a far home
    // table. Deferred require (stockpile->craftany->gear->craft->goal).
    // The table lands beside the body, so walk to the chest spot first: a
    // table out in the field would leave home tableless again.
    if (tableBlock) dropRun()
    if (!tableBlock && !opts.noFarTable) {
      let craftany = null
      let plan = null
      try {
        craftany = require('./craftany')
        plan = (ctx.craftany && ctx.craftany.key === 'chestx1') ? { ok: true } : craftany.planCraft(bot, ctx, 'chest', 1)
      } catch (err) { plan = { ok: false, line: String(err && err.message) } }
      // Unplannable: the honest fail at once, no walk first.
      if (plan && plan.ok && !nearPos(bot, spot, INTERACT_REACH)) {
        const key = `${goalPrefix}-table:${spot.x},${spot.y},${spot.z}`
        if (key !== ctx.lastGoalKey) {
          try { bot.pathfinder.setGoal(new goals.GoalNear(spot.x, spot.y, spot.z, 2), false) } catch (_) { /* retry next tick */ }
          ctx.lastGoalKey = key
          return
        }
        let moving = false
        try { moving = bot.pathfinder.isMoving() } catch (_) { /* treat as arrived */ }
        if (moving) return
        if (!farStalled(ctx, key)) return
        failHere('far')
        return
      }
      let res = plan
      if (plan && plan.ok) {
        try { res = craftany(bot, ctx, 'chest', 1) } catch (err) { res = { done: false, line: String(err && err.message) } }
      }
      if (res === 'running' || (res && res.done)) return // next tick holds the chest and places it
      // The tag names the branch (no standing table), the line craftany's reason.
      console.log(`stockpile failed no-chest no-table: ${(res && res.line) || 'craftany refused'}`)
    }
    if (!tableBlock) {
      if (offerHaul(bot, ctx)) say(bot, 'no table to craft a chest — bringing the surplus to you')
      failHere( 'no-chest')
      return
    }
    const found = craftMod ? craftMod.recipes(bot, 'chest', tableBlock) : []
    if (found.length === 0) { // no ingredients for the recipe
      if (offerHaul(bot, ctx)) say(bot, 'no table to craft a chest — bringing the surplus to you')
      failHere( 'no-chest')
      return
    }
    // The table craft opens a window: walk into reach first (craft.js door
    // rule). Crafting from across the map eats the 20 s windowOpen timeout
    // and — with the error swallowed — livelocks the step (revmux 01-review).
    const reach = (craftMod && craftMod.TABLE_REACH) || INTERACT_REACH
    if (!nearPos(bot, tablePos, reach)) {
      if (opts.noFarTable) {
        try {
          const dx = bp.x - tablePos.x
          const dz = bp.z - tablePos.z
          if (Math.hypot(dx, dz) > 32) {
            if (offerHaul(bot, ctx)) say(bot, 'no table nearby to craft a chest — bringing the surplus to you')
            failHere( 'no-chest')
            return
          }
        } catch (_) { /* distance unreadable: walk as before */ }
      }
      const key = `stockpile-table:${tablePos.x},${tablePos.y},${tablePos.z}`
      if (key !== ctx.lastGoalKey) {
        try {
          bot.pathfinder.setGoal(new goals.GoalNear(tablePos.x, tablePos.y, tablePos.z, 2), false)
        } catch (_) { /* retry next tick */ }
        ctx.lastGoalKey = key
        return
      }
      let moving = false
      try { moving = bot.pathfinder.isMoving() } catch (_) { /* treat as arrived */ }
      if (moving) return
      if (!farStalled(ctx, key)) return
      failHere( 'far') // issued, standing, still far: no path to the table
      return
    }
    ctx.stockpileInFlight = true
    void (async () => {
      try {
        await craftMod.safeCraft(bot, found[0], 1, tableBlock, { ctx, item: 'chest', avoid: spot })
      } catch (_) {
        ctx.stockpileInFlight = false
        // A room failure still hands the surplus over when a player is
        // online (revmux 01 major): without the haul the pack never drains.
        if (offerHaul(bot, ctx)) say(bot, 'no room to craft a chest — bringing the surplus to you')
        failHere( 'craft') // loud: failHolds parks until the situation moves
        return
      }
      ctx.stockpileInFlight = false
    })()
    return
  }

  const p = new Vec3(spot.x, spot.y, spot.z)
  const gkey = `${goalPrefix}:${spot.x},${spot.y},${spot.z}`
  if (ctx.lastGoalKey !== gkey) {
    try {
      bot.pathfinder.setGoal(new goals.GoalPlaceBlock(p, bot.world, { range: 4 }), false)
    } catch (_) { /* retry next tick */ }
    ctx.lastGoalKey = gkey
    return
  }
  let moving = false
  try { moving = bot.pathfinder.isMoving() } catch (_) { /* treat as arrived */ }
  if (moving) return
  if (!nearPos(bot, p, PLACE_REACH)) {
    if (!farStalled(ctx, gkey)) return
    failHere( 'far') // issued, standing, still far: no path to the spot
    return
  }

  ctx.stockpileInFlight = true
  void (async () => {
    try {
      const below = bot.blockAt(new Vec3(spot.x, spot.y - 1, spot.z))
      if (!below || !below.name || below.name === 'air') {
        ctx.stockpileInFlight = false
        failHere( 'no-ground')
        return
      }
      // The scan admits clearable flora: break it first, the server
      // refuses to place into a non-replaceable cell (revmux 04-review).
      // Anything else non-air here fails below at the landed check.
      try {
        const cell = bot.blockAt(new Vec3(spot.x, spot.y, spot.z))
        if (cell && cell.name && cell.name !== 'air' && cell.name !== 'chest' &&
          CLEAR_FLORA.has(cell.name) && typeof bot.dig === 'function' &&
          canBreak(bot, cell, ctx)) {
          await bot.dig(cell)
        }
      } catch (_) {
        ctx.stockpileInFlight = false
        failHere( 'dig')
        return
      }
      const items = bot.inventory.items()
      const item = Array.isArray(items) ? items.find((i) => i && i.name === 'chest') : null
      if (!item) {
        ctx.stockpileInFlight = false
        failHere( 'no-chest')
        return
      }
      if (typeof bot.equip === 'function') await bot.equip(item, 'hand')
      await bot.placeBlock(below, new Vec3(0, 1, 0))
      const landed = blockNameAt(bot, spot.x, spot.y, spot.z)
      ctx.stockpileInFlight = false
      if (landed === 'chest') {
        if (adoptMode === 'site') siteAdopted(ctx, spot)
        else if (adoptMode === 'home') adopted(ctx, spot)
        // 'none' (a double) keeps the adoption: the halves share one window.
        ctx.lastGoalKey = null
        say(bot, sayPlaced)
      } else {
        failHere( 'place')
      }
    } catch (_) {
      ctx.stockpileInFlight = false
      failHere( 'place')
    }
  })()
}

module.exports = stockpile
module.exports.depositPlan = depositPlan
module.exports.surplusCount = surplusCount
module.exports.woodCapped = woodCapped
module.exports.surplusWood = surplusWood
module.exports.offerHaul = offerHaul
module.exports.slotReserved = slotReserved
module.exports.reserveCorner = reserveCorner
module.exports.packStacks = packStacks
module.exports.PLANK_KEEP = PLANK_KEEP
module.exports.LOG_KEEP = LOG_KEEP
module.exports.STONE_KEEP = STONE_KEEP
module.exports.STACK_KEEP = STACK_KEEP
module.exports.keepFor = keepFor
module.exports.PACK_RESERVE = PACK_RESERVE
module.exports.chestSpotFor = chestSpotFor
module.exports.withdrawFromChest = withdrawFromChest
module.exports.withdrawAnyFromChest = withdrawAnyFromChest
module.exports.chestCounts = chestCounts
module.exports.depositToChest = depositToChest
module.exports.withChest = withChest // craft.js room bank (rwuu): partial junk deposit with spare keeps
module.exports.withdrawEdible = withdrawEdible
module.exports.CHEST_SPOTS = CHEST_SPOTS
module.exports.CHEST_SPOTS_V2 = CHEST_SPOTS_V2
module.exports.spotsFor = spotsFor
module.exports.FOOD_KEEP = FOOD_KEEP
module.exports.SCAFFOLD_KEEP = SCAFFOLD_KEEP
module.exports.GEAR_RESERVE_PLANKS = GEAR_RESERVE_PLANKS
module.exports.GEAR_RESERVE_COBBLE = GEAR_RESERVE_COBBLE
module.exports.GEAR_OWNER_WANT = GEAR_OWNER_WANT
module.exports.gearLadderDone = gearLadderDone
module.exports.CHEST_FULL_RETRY_MS = CHEST_FULL_RETRY_MS
module.exports.INTERACT_REACH = INTERACT_REACH
module.exports.PLACE_REACH = PLACE_REACH
module.exports.SURPLUS_BATCH = SURPLUS_BATCH
module.exports.REPROBE_RADIUS = REPROBE_RADIUS
module.exports.NO_SPOT_RETRY_MS = NO_SPOT_RETRY_MS
module.exports.chestTodo = chestTodo
module.exports.siteMode = siteMode
module.exports.castleBankAt = castleBankAt
module.exports.bankPlan = bankPlan
module.exports.findSiteChest = findSiteChest
module.exports.siteChestTodo = siteChestTodo
module.exports.doubleSpot = doubleSpot
module.exports.doublePending = doublePending
module.exports.doubleArmed = doubleArmed
module.exports.homeFallbackViable = homeFallbackViable
module.exports.siteParked = siteParked
module.exports.SITE_STORE_RADIUS = SITE_STORE_RADIUS
module.exports.SITE_CHEST_RADIUS = SITE_CHEST_RADIUS
