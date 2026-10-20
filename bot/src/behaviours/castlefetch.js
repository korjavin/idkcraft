'use strict'

// castlefetch: source the next castle batch (idkcraft-g0z.4, design
// revision 2026-10-02). The castle step only runs with material on hand
// (g0z.3 menuFact word); this step fetches it, in source order:
//   1. the castle chest — a chest the owner placed on the castle site
//      (withdraw what he dropped there; never deposit castle stock in it),
//      then the bank chests stockpile fills (castle siteChest, home chest;
//      g0z.60), nearest first, one batch each;
//   2. inventory conversions through craftany (logs -> planks, planks ->
//      sticks -> fence, door, coal + stick -> torch);
//   3. the world — stone dug with the pickaxe (drop: cobblestone), logs
//      through the gather behaviour (planks/door/fence all start at logs).
// Batch, not per cell: a fetch runs until the kind's FETCH target (or the
// castle's whole remainder of it) is usable above the castle reserve, so
// the bot never shuttles per block. Nothing reachable fails the step: the
// goal hold parks it (bounded retry, goal.js CASTLEFETCH_RETRY_MS) so an
// owner restock resumes. A missing pickaxe ends the leg 'done' and equip
// (which only replaces an ABSENT pick) rearms before the next stone leg.

const Vec3 = require('vec3')
const { goals } = require('mineflayer-pathfinder')
const blueprint = require('../castle')
const castleMod = require('./castle')
const stockpileMod = require('./stockpile')
const danger = require('../danger')
const { countItems } = require('../perception')
const { canBreak, clearGoal, denyReason, logDeny, protectedReason } = require('./util')
const { cacheReady } = require('../bridge/mine')
const { stepDone, stepFailed, failReason, isFinished, stepGen, stale } = require('../step')

// Stack-ish targets per kind (bead: ~64 cobble, ~16 logs' worth). Each is
// >= castle BATCH (door: its remainder is 1), so a fetch picked on a
// none/some word always has work: the word and the target never disagree.
// frame (g0z.12): one gather load — gather stops at NEED_LOGS, so a bigger
// target could never be met from the world (castle BATCH_OF.frame matches).
// pane (g0z.31, g0z.38): chest first — panes, else glass crafted 6 -> 16,
// else chest sand; then the sand ladder (paneTick): a self sand order,
// fuel, the castle furnace (its 8 cobble dug on a no-cobble, g0z.39), the craft.
// Each rung fails honestly into the hold.
// banner (g0z.32, g0z.35): chest first, then self-sourced (owner
// 2026-10-09) — 6 wool + 1 stick per banner, the wool through a self bring
// order (bannerTick), but only once the beds stand (beds first).
// bookshelf (g0z.49, phase 1: chest-supplied) — shelves else books from
// the chest, 3 books + 6 planks crafted at a table; enchanting_table —
// chest only (no bot chain for obsidian/diamonds). Both fail honestly
// into the hold, like banners before g0z.35.
// blast_furnace (g0z.50, self-sourced g0z.51) — the finished block from
// the chest, else one table craft from 5 iron_ingot + 1 furnace + 3
// smooth_stone held; else the blast ladder (blastTick): chest iron/chain
// mats, smelted iron, the cobble -> stone -> smooth_stone chain (cobble
// dug like the pane rung), the recipe furnace from 8 cobble (craftany's
// one-layer rule never makes it — g0z.50). Each rung fails honestly into
// the hold.
// stairs (g0z.47) — any *_stairs from the chest, else cobblestone_stairs
// (6 cobble -> 4 at a table, one material for all 72).
// gate (g0z.46) — a wood kind like the door: any *_fence_gate from the
// chest, else chest logs / chopped logs crafted (4 sticks + 2 planks).
const FETCH = { stone: 64, planks: 32, door: 1, torch: 16, fence: 16, frame: castleMod.BATCH_OF.frame, chest: 1, pane: 16, banner: 2, bookshelf: 5, enchanting_table: 1, blast_furnace: 1, stairs: 16, gate: 1 }
// Batch yield (idkcraft-vmzq.20): a fetch leg hands a layable batch to the
// castle after this long instead of running to its full target. Five
// minutes ≈ one stone batch at the measured quarry rate, and bounds the
// castle<->castlefetch switch rate from below no matter how the words flap.
const LEG_MAX_MS = 5 * 60 * 1000
// One craft op per call; the next tick re-checks the target.
const CRAFT_COUNT = { planks: 4, door: 1, torch: 4, fence: 3, chest: 1, pane: 16, banner: 1, bookshelf: 1, blast_furnace: 1, stairs: 4, gate: 1 }
const BANNER_WOOL = 6 // one colour per banner (table recipe)
const BOOKS_PER_SHELF = 3 // table recipe: 6 planks + 3 books (g0z.49)
const BLAST_IRON = 5 // iron_ingot per blast furnace (table recipe, g0z.51)
const BLAST_SMOOTH = 3 // smooth_stone per blast furnace
const BLAST_FURNACE_COBBLE = 8 // the recipe's furnace, crafted from cobble (craftany never layers it — g0z.50)
const BLAST_JOBS = { raw_iron: 'iron_ingot', cobblestone: 'stone', stone: 'smooth_stone' } // ladder smelts, input -> output
const SAND_JOB = { input: 'sand', output: 'glass' } // the pane job, the smeltTick default
const DIG_RADIUS = 32
const FIND_COUNT = 4096
const STONE_BELOW = 2 // target y window around the site's ground (no shafts, no pillars)
const STONE_ABOVE = 3
const DIG_REACH = 4
const PICKUP_REACH = 2 // drops land where the block stood (equip lesson)
const EYE = 1.62 // eye over feet: trench reach is measured from it
const AIR_WAITS = 3 // ticks a dig waits for the feet to land
const PICKUP_WAITS = 8 // ticks walking into a below-feet hole for its drop (neuc.51)
const APPROACH_WAITS = 30 // ticks walking to one target before it is skipped
const SKIPS_TO_FAIL = 3 // skipped targets before the leg fails unreachable
const QWAIT_MS = 45000 // bounded pre-pick wait for the leg area chunks
const QSTANCE_RADIUS = 8 // stance-anchored arm wait: the vetted cell and
// its stance sit a few blocks apart, so a small window around the stance
// covers the pick's reads without stalling on the whole leg area
const QSTANCE_MS = 20000 // per-stance bound: a cache that never warms arms anyway
const NOGAIN_STRIKES = 8 // digs without the cobble count growing (neuc.51: v2 digs one a second, the pickup trails 1-2 digs; 5 failed live legs)
const DIG_TIMEOUT_MS = 10000
// Quarry truth (vmzq.38; neuc.53 rig evidence): granite/diorite/andesite/
// tuff/calcite/deepslate land as often as cobble and the castle lays them
// (isStone). The v2 mine must target the whole family: with only
// stone/cobblestone Baritone tunnels mixed rock whose drops neither side
// counts, and every leg stalls at 60 s with +a few uncounted blocks.
const STONE_FAMILY = Array.isArray(blueprint.STONE_ITEMS) && blueprint.STONE_ITEMS.length > 0
  ? [...blueprint.STONE_ITEMS] : ['stone', 'cobblestone']
const CHEST_REACH = stockpileMod.INTERACT_REACH
const CHEST_WAITS = 30 // ticks without closing in on the chest
const CHEST_TIMEOUT_MS = 15000
// v2 chest-walk retry budget (idkcraft-6fc1): Baritone verdicts noPath
// across water the v1 pathfinder swims, and the leg used to burn its whole
// walk patience and fall through to gather/no-trees with the chest full.
// Retry 1 re-issues the walk from the live feet (a fresh Baritone plan);
// retries 2+ route past a perpendicular staging cell (the pond's dry end)
// before re-approaching the chest. Bounded per chest: the stalled abandon
// below owns the give-up, as before.
const CHEST_RETRIES = 3
const CHEST_VIA_REACH = 1.5
// Quarry (g0z.15, owner 2026-10-02): no exposed stone by the site -> an
// open trench next to it, a staircase down QUARRY_DEPTH below the site's
// ground, then level, QUARRY_W wide, cut top-down (dirt included).
// ponytail: four straight trenches (one per side) of QUARRY_LEN columns,
// ~6 stone per column -> roughly 1000 cobble; a v2 castle that exhausts
// them digs the second ring, not a new search.
// Second ring (idkcraft-vmzq.31): prod run6 trenched all four ring-0 sides
// into water and caves within ~4-12 columns (snapshot probe at the castle
// site: a lake, an aquifer, a cave mouth, a ravine edge) and the quarry
// never recovered — stone came only from the slower far fetch. Ring 1
// re-trenches each edge from its opposite lateral end once ring 0 is dead
// or dug; deeper is wetter on that ground (water below the staircase), so
// the next ring, not the next depth. Flat sides 0..7 (4..7 are ring 1).
const QUARRY_RINGS = 2
const QUARRY_GAP = 3 // trench start outside the footprint (v2: past the fence)
const QUARRY_DEPTH = 6
const QUARRY_LEN = 40
const QUARRY_W = 2
const QUARRY_TOP = 3 // a hill is cut up to site.y + this
const QUARRY_ADAPT = 8 // a trench starts at real ground up to this far below site level (dips, pad edges)
const QUARRY_TRIES = 3 // digs on one quarry cell before it is skipped
const QUARRY_NOGAIN = 4 * QUARRY_W * 3 // stone digs (~4 columns) with no cobble picked up
// Quarry-down pit (idkcraft-vmzq.46): prod run7 starved with all 8 trench
// sides dead (holes/water along the 40-column lines) and no exposed stone.
// The fallback digs a stepped pit at a dry spot near the site instead of a
// long line: a staircase PIT_DEPTH down (walkable out by construction — 1
// per column under the trench stance rule — on undug ground, which the
// spot layout and the dug-ground skip guarantee), then a PIT_ROOM room at
// the bottom, cut top-down through the dirt cap into stone. Spots ring the
// footprint at PIT_GAPS, nearest first, each probed dry before the first
// dig; liquid or a hole mid-pit abandons the spot and the next takes over.
const PIT_GAPS = [4, 6, 8, 10, 12]
const PIT_DEPTH = 8
const PIT_ROOM = 8
const PIT_LEN = PIT_DEPTH + PIT_ROOM
const PIT_MAX = 64 // persisted pit frames cap (memory.js sanitizes the same)
const LIQUID = new Set(['water', 'lava', 'bubble_column'])
// Pickaxe blocks a trench meets; anything else is dug bare-handed.
const ROCK = /stone|_ore$|granite|diorite|andesite|deepslate|tuff|calcite|basalt/

// Seams for unit tests (craftany and gather need a real recipe registry /
// a world); production reads the real modules lazily (gather -> goal cycle).
const deps = {
  craftItem: (...a) => require('./craftany')(...a),
  gather: (...a) => require('./gather')(...a),
  // g0z.38: one furnace tick (gear's driveLeg wrapper over furnace.js).
  driveFurnace: (bot, ctx) => require('./gear').driveFurnace(bot, ctx, require('./furnace')),
}

// Wood kinds (g0z.56): crafted from planks/logs, chopped when short.
const WOOD = new Set(['planks', 'door', 'fence', 'chest', 'frame', 'gate'])
const NO_WOOD = 'no wood within 64 — drop logs in the castle chest'
// Items one chest log funds per kind (craftTick crafts the rest).
const LOG_YIELD = { planks: 4, frame: 1, fence: 2, door: 2, chest: 0.5, gate: 1, torch: 4 } // torch: one log -> one charcoal -> 4

function birchFirst(names) {
  return names.sort((a, b) => (b.startsWith('birch_') ? 1 : 0) - (a.startsWith('birch_') ? 1 : 0) || a.localeCompare(b))
}

// Chest planks complete the pack's majority wood first (szr1): exact-wood
// crafts cannot mix woods, so drawing the held wood's planks tops up a
// started fund while a new wood starts one. The rest keeps registry order.
function planksFirst(bot, names) {
  let held = null
  try {
    held = {}
    for (const it of bot.inventory.items() || []) {
      if (it && typeof it.name === 'string' && it.name.endsWith('_planks')) held[it.name] = (held[it.name] || 0) + (it.count || 0)
    }
  } catch (_) { held = null }
  if (!held) return birchFirst(names)
  return names.sort((a, b) => ((held[b] || 0) - (held[a] || 0)) || (b.startsWith('birch_') ? 1 : 0) - (a.startsWith('birch_') ? 1 : 0) || a.localeCompare(b))
}

// Finished items first, then chest planks (pack wood first), then logs.
function woodLists(bot, finished) {
  const planks = planksFirst(bot, itemNames(bot, (n) => n.endsWith('_planks')))
  const logs = itemNames(bot, (n) => n.endsWith('_log'))
  return planks.length > 0 ? [finished, planks, logs] : [finished, logs]
}

function itemNames(bot, test) {
  const by = (bot && bot.registry && bot.registry.itemsByName) || {}
  return birchFirst(Object.keys(by).filter(test))
}

const isDoor = (n) => n.endsWith('_door') && n !== 'iron_door'
const isFence = (n) => n.endsWith('_fence') && n !== 'nether_brick_fence'
const isBanner = (n) => n.endsWith('_banner') && !n.endsWith('_wall_banner')
const isGate = (n) => n.endsWith('_fence_gate')

// What the chest yields for a kind, finished items first; planks also
// take logs (converted by the craft source next tick).
function chestNames(bot, kind) {
  if (kind === 'stone') return [[...blueprint.STONE_ITEMS]]
  if (kind === 'planks') return [itemNames(bot, (n) => n.endsWith('_planks')), itemNames(bot, (n) => n.endsWith('_log'))]
  // g0z.56: logs dropped in the chest fund the wood kinds too (the
  // owner's repair shortcut; craftTick turns them into the item).
  // szr1: banked/owner-dropped planks fund them directly (stockpile banks
  // the pack's surplus planks, so a chest can hold planks with no logs in
  // it — and a treeless world still refills). Logs stay last: a log also
  // funds the table and the sticks. No planks in the registry: the lists
  // stay as they were (an empty middle list would trip drawChest's
  // empty-break and skip the logs behind it).
  if (kind === 'door') return woodLists(bot, itemNames(bot, isDoor))
  if (kind === 'fence') return woodLists(bot, itemNames(bot, isFence))
  if (kind === 'gate') return woodLists(bot, itemNames(bot, isGate))
  // fqkn: logs fund torchTick's charcoal (stockpile banks the pack's logs at home).
  if (kind === 'torch') return [['torch'], itemNames(bot, (n) => n.endsWith('_log'))]
  if (kind === 'frame') return [itemNames(bot, (n) => n.endsWith('_log'))]
  if (kind === 'chest') return [['chest'], itemNames(bot, (n) => n.endsWith('_log'))]
  if (kind === 'pane') return [itemNames(bot, (n) => blueprint.matches('pane', n)), ['glass'], ['sand']]
  if (kind === 'banner') return [itemNames(bot, (n) => blueprint.matches('banner', n)), itemNames(bot, (n) => n.endsWith('_wool'))]
  if (kind === 'bookshelf') return [['bookshelf'], ['book']]
  if (kind === 'enchanting_table') return [['enchanting_table']]
  if (kind === 'blast_furnace') return [['blast_furnace'], ['iron_ingot'], ['raw_iron'], ['smooth_stone'], ['stone'], ['cobblestone']]
  // vf8e.8: stairs fund their table like every wood kind (g0z.56) — the
  // finished stairs first, then ONE table's worth (a table, else planks,
  // else a log); drawChest sizes the fund to the table, not the need.
  if (kind === 'stairs') return [itemNames(bot, (n) => n.endsWith('_stairs')), ['crafting_table'], itemNames(bot, (n) => n.endsWith('_planks')), itemNames(bot, (n) => n.endsWith('_log'))]
  return []
}

function craftNames(bot, kind) {
  if (kind === 'planks') return itemNames(bot, (n) => n.endsWith('_planks'))
  if (kind === 'door') return itemNames(bot, isDoor)
  if (kind === 'fence') return itemNames(bot, isFence)
  if (kind === 'gate') return itemNames(bot, isGate)
  if (kind === 'torch') return ['torch']
  if (kind === 'chest') return ['chest'] // 8 planks at a table (craftany crafts planks from logs)
  if (kind === 'pane') return ['glass_pane'] // 6 glass -> 16 at a table
  if (kind === 'banner') return itemNames(bot, isBanner) // 6 wool of one colour + 1 stick at a table
  if (kind === 'bookshelf') return ['bookshelf'] // 6 planks + 3 books at a table (craftany does the planks layer from logs)
  if (kind === 'blast_furnace') return ['blast_furnace'] // 5 iron_ingot + 1 furnace + 3 smooth_stone at a table (g0z.50; the furnace itself must be held)
  if (kind === 'stairs') return ['cobblestone_stairs'] // 6 cobble -> 4 at a table (g0z.47; cobble from the quarry legs)
  return []
}

// The castle's open demand for a kind: { kind, short } where short is how
// many more usable items the batch needs. Null when the castle word is not
// a material word (none/parked/done/clear, or blocked with no gated kind). Shared by the goal
// gate and the behaviour, so the two never disagree.
// Owed repair moved on (fqkn): a complete castle's latched repair fetch that
// failed at the castle (the torch rung fails fast away from the home
// furnace) gets its home try once the bot is off site (castle.js nearSite,
// the radius menuFact drops the latch by) — the 5-min hold otherwise
// outlived the walk home and the tidy cadence walked the bot back first
// (rig: no-torch at the castle, every window). One home try: an off-site
// failure drops the latch (castle.js menuFact).
function owedMoved(bot, ctx) {
  try {
    const st = ctx.castle
    if (!st || st.phase !== 'complete' || !ctx.castleWord || !ctx.castleWord.repair) return false
    if (castleMod.nearSite(bot, st)) return false
    // ...and only where the home rung runs (torchTick's TORCH_HOME_DIST): a
    // far-home castle never spends its one home try on the road.
    const h = ctx.home && (ctx.home.furnace || ctx.home.site)
    const bp = bot.entity && bot.entity.position
    return !(h && bp && typeof h.x === 'number' && Math.hypot(bp.x - h.x, bp.z - h.z) > TORCH_HOME_DIST)
  } catch (_) { return false }
}

// True while a fetch failure parks KIND (prkh): the hold is per kind, so
// a stone-unreachable leg parks stone while a fence word still fetches
// from the chest. Holds accumulate in a kinds map (revmux 02 core-1), so a
// later kind's failure or success never erases a still-failing kind; a
// hold with no kind on it (legacy records) still parks everything. The
// owed-repair home try (owedMoved) is exempt, as before.
function holdFor(bot, ctx, kind) {
  try {
    const sf = ctx && ctx.stepFail && ctx.stepFail.castlefetch
    if (!sf || typeof sf.at !== 'number') return false
    if (owedMoved(bot, ctx)) return false
    const window = require('../budget').CASTLEFETCH_RETRY_MS
    const kinds = sf.kinds
    if (kinds && typeof kinds === 'object') {
      const at = kinds[kind]
      return typeof at === 'number' && Date.now() - at <= window
    }
    if (sf.kind && sf.kind !== kind) return false
    return Date.now() - sf.at <= window
  } catch (_) {
    return false
  }
}

function demand(bot, ctx) {
  // Bounded fetch hold (g0z.15): a failed leg rests CASTLEFETCH_RETRY_MS no
  // matter how the facts text moves — known=near/none flips released the
  // text-keyed goal hold every few seconds (g0z.12 rig churn).
  // prkh: per kind (holdFor) — a stone hold never blocks a fence word.
  let w = 'none'
  try { w = castleMod.menuFact(bot, ctx) } catch (_) { return null }
  let kind = null
  let word = null
  // Blocked (g0z.23): the gated kind (menuFact keeps it on castleWord)
  // still wants its batch while the build stands.
  if (w === 'blocked') {
    kind = ctx && ctx.castleWord && ctx.castleWord.kind
    if (!kind || !(kind in FETCH)) return null
    word = 'blocked'
  } else {
    const m = /^([a-z_]+)-(none|some|batch)$/.exec(w) // g0z.49: kinds like enchanting_table carry an underscore
    if (!m || !(m[1] in FETCH)) return null
    kind = m[1]
    word = m[2]
  }
  if (holdFor(bot, ctx, kind)) return null
  const cw = ctx && ctx.castleWord
  const left = cw && cw.kind === kind && typeof cw.left === 'number' ? cw.left : castleMod.BATCH
  const target = Math.min(FETCH[kind], left)
  // neuc.58: a v2 stone leg hauls the forecast, not FETCH — the blueprint
  // remainder capped by pack room and what the held picks can still dig
  // (stone by hand drops nothing). Pickless keeps the v1 target: equip
  // rearms first (digTick, goal needsDigNoPick). No room keeps it too: the
  // leg digs into the last slots and fails pack-full, which opens
  // stockpile's pierce (stockpile.packFull = !roomForDrop at 36 slots).
  if (kind === 'stone' && process.env.BOT_BODY === 'baritone') {
    const picks = pickBudget(bot)
    const room = stoneRoom(bot)
    if (picks > 0 && room > 0) {
      const forecast = left + castleMod.reserveOf(kind) - castleMod.held(bot, kind)
      return { kind, word, short: Math.max(0, Math.min(forecast, room, picks)) }
    }
  }
  // Raw items: below the reserve the reserve refills first (never laid).
  return { kind, word, short: Math.max(0, target + castleMod.reserveOf(kind) - castleMod.held(bot, kind)) }
}

// neuc.58: uses left on the held pickaxes (bridge items carry
// maxDurability/durabilityUsed; missing fields read as a fresh pick).
const PICK_USES = { wooden_pickaxe: 59, stone_pickaxe: 131, golden_pickaxe: 32, iron_pickaxe: 250, diamond_pickaxe: 1561, netherite_pickaxe: 2031 }
function pickBudget(bot) {
  let n = 0
  try {
    for (const it of bot.inventory.items() || []) {
      if (!it || typeof it.name !== 'string' || !it.name.endsWith('_pickaxe')) continue
      const max = typeof it.maxDurability === 'number' && it.maxDurability > 0 ? it.maxDurability : (PICK_USES[it.name] || 59)
      n += Math.max(0, max - (typeof it.durabilityUsed === 'number' ? it.durabilityUsed : 0))
    }
  } catch (_) { return 0 }
  return n
}

// neuc.58: stone the pack still takes — empty slots plus partial stone
// stacks, minus ROOM_KEEP slots for drops/kit (Baritone keeps mining into
// a full pack: the count never grows).
const ROOM_KEEP = 2
function stoneRoom(bot) {
  try {
    const items = bot.inventory.items() || []
    const empty = typeof bot.inventory.emptySlotCount === 'function' ? bot.inventory.emptySlotCount() : 36 - items.length
    let head = 0
    for (const it of items) {
      if (!it || !blueprint.isStone(it.name)) continue
      const cap = typeof it.stackSize === 'number' && it.stackSize > 0 ? it.stackSize : 64
      head += Math.max(0, cap - (typeof it.count === 'number' ? it.count : 1))
    }
    return Math.max(0, (empty - ROOM_KEEP) * 64 + head)
  } catch (_) { return 0 }
}

function bodyPos(bot) {
  const p = bot && bot.entity && bot.entity.position
  return p && typeof p.x === 'number' ? p : null
}

function hasPickaxe(bot) {
  return countItems(bot, (n) => n.endsWith('_pickaxe')) > 0
}

function cobble(bot) {
  return countItems(bot, blueprint.isStone) // vmzq.38: a granite dig is a gain
}

// Per-leg time split (idkcraft-vmzq.20 nudge2): every digTick lands in
// exactly one bucket — dig (a dig issued this tick), walk (a walk
// issued), other (admin/terminal/craft ticks) — so the rig can see where
// the quarry's ticks go. Lazily initialised: unit fakes pass a bare {}.
function spend(f, bucket) {
  try {
    const s = f.spend || (f.spend = { dig: 0, walk: 0, other: 0 })
    if (s && typeof s[bucket] === 'number') s[bucket]++
  } catch (_) { /* counters best-effort */ }
}

// Quarry output on hand (null when unreadable): the leg-over line diffs
// it against the leg-start count, so dig-ticks-per-block is measurable.
function blocksOnHand(bot) {
  try {
    return countItems(bot, (n) => blueprint.isStone(n) || n === 'dirt')
  } catch (_) { return null }
}

// Site box with a one-block margin: lives in ../castle.js (oqul.11, the
// equip<->castlefetch cycle); same function, re-exported below.
const onSite = blueprint.onSite

// The castle chest: a chest standing on the castle site.
// ponytail: any chest in the footprint; g0z.11's storeroom 'chest' cell is
// one of those, so it needs no second lookup.
function castleChest(bot, st) {
  try {
    const e = bot.registry && bot.registry.blocksByName && bot.registry.blocksByName.chest
    if (!e || typeof bot.findBlocks !== 'function') return null
    const hits = bot.findBlocks({ matching: e.id, maxDistance: 64, count: 16 }) || []
    const p = hits.find((q) => q && onSite(st, q, 0, 0))
    return p ? new Vec3(p.x, p.y, p.z) : null
  } catch (_) { return null }
}

function finish(bot, ctx, status) {
  const f = ctx.castleFetch
  if (status === 'done') ctx.castleFetchDry = null // a leg that got stock retires the dry mark
  if (status === 'done' && f && f.kind === 'stairs' && !f.stairsMine) ctx.castleStairsMines = 0 // 8njf: stairs on hand (chest, craft) re-arm the mine fallback
  if (f && f.spend) {
    let delta = '?'
    try {
      const now = blocksOnHand(bot)
      delta = (typeof f.blocks0 === 'number' && typeof now === 'number')
        ? ((now - f.blocks0 >= 0 ? '+' : '') + (now - f.blocks0))
        : String(now)
    } catch (_) { /* delta best-effort */ }
    let wall = '?'
    try { wall = (typeof f.t0 === 'number' ? Math.round((Date.now() - f.t0) / 1000) + 's' : '?') } catch (_) { /* wall best-effort */ }
    try { console.log(`castlefetch ${f.kind || '?'}: leg over (${status}) ticks dig=${f.spend.dig | 0} walk=${f.spend.walk | 0} other=${f.spend.other | 0} starts=${f.starts | 0} dug=${f.dug | 0} blocks=${delta} target=${typeof f.haul === 'number' ? f.haul : '?'} wall=${wall}`) } catch (_) { /* log best-effort */ }
  }
  if (status !== 'done') {
    try { console.log(`castlefetch ${status}`) } catch (_) { /* log best-effort */ }
  }
  if (status === 'done') stepDone(ctx)
  else stepFailed(ctx, failReason(status) || status)
  // prkh: the fetch hold parks one kind — stamp the leg kind for the hold
  // record (goal.js recordOutcome copies it), so a later fence word still
  // fetches from the chest while stone stays parked. Failed kinds merge
  // into the map; a done kind retires only itself (revmux 03 core-1: the
  // word is already re-computed by then, so the leg's own kind is what
  // decides — never the fresh word).
  try {
    if (f && typeof f.kind === 'string') {
      if (status === 'done') ctx.castleFetchDoneKind = f.kind
      else ctx.castleFetchFailKind = f.kind
    }
  } catch (_) { /* stamp best-effort */ }
  ctx.castleFetch = null
  ctx.furnaceJob = null // g0z.38: a pane leg's job never outlives it (gear's iron smelt)
  clearGoal(bot, ctx)
}

// (Re)issue the walk: a new key, or our goal was replaced/cleared (another
// step ran in between and left lastGoalKey alone — rig: a second chest leg
// after the light step never walked).
// xz: a far walk ignores y (vmzq.35, the castle far walk's vmzq.29 fix): a
// y-aware goal into unloaded chunks 500 off climbs from a cave and wedges.
function walkTo(bot, ctx, key, p, range, xz = false) {
  let ours = false
  try { ours = !!ctx.castleFetchGoal && bot.pathfinder.goal === ctx.castleFetchGoal } catch (_) { ours = false }
  if (ctx.lastGoalKey === key && ours) return
  try {
    ctx.castleFetchGoal = xz ? new goals.GoalNearXZ(p.x, p.z, range) : new goals.GoalNear(p.x, p.y, p.z, range)
    bot.pathfinder.setGoal(ctx.castleFetchGoal)
  } catch (_) { /* retry next tick */ }
  ctx.lastGoalKey = key
}

// Walk patience that only counts ticks without closing in (a far target
// stays walkable while the bot approaches). True once spent.
function stalled(w, dist, limit) {
  if (dist < (w.best == null ? Infinity : w.best) - 1) { w.best = dist; w.waits = 0 }
  return ++w.waits > limit
}

// One async op at a time under ctx.castleFetchInFlight, with a deadline:
// a hung window or dig must never wedge the flag (the step would read
// feasible and never move). Settles quietly; the sync tick decides.
function flight(ctx, run, ms, onFail, onOk) {
  ctx.castleFetchInFlight = true
  const timeout = new Promise((_, reject) => {
    const tm = setTimeout(() => reject(new Error('timeout')), ms)
    if (tm && typeof tm.unref === 'function') tm.unref()
  })
  Promise.race([run(), timeout]).then(() => { try { if (onOk) onOk() } catch (_) { /* ok-hook best-effort */ } }).catch(() => { if (onFail) onFail() }).finally(() => { ctx.castleFetchInFlight = false })
}

function near(bot, p, reach) {
  const bp = bodyPos(bot)
  return !!bp && Math.hypot(bp.x - (p.x + 0.5), bp.y - (p.y + 0.5), bp.z - (p.z + 0.5)) <= reach
}

// Perpendicular staging past mid-leg (idkcraft-6fc1): retry 2 stands 6
// past the leg's midpoint on one side, retry 3 stands 9 on the other, so a
// water strip across the approach is rounded at its dry end. Pure geometry
// over {x,y,z}; the walk call floors it. Never throws.
function chestVia(bp, at, n) {
  try {
    if (!bp || !at || typeof bp.x !== 'number' || typeof at.x !== 'number' ||
      typeof bp.z !== 'number' || typeof at.z !== 'number') return null
    const dx = at.x - bp.x
    const dz = at.z - bp.z
    const len = Math.hypot(dx, dz)
    if (!(len > 1)) return null
    const r = 3 * (n | 0)
    if (!(r > 0)) return null
    const s = (n | 0) % 2 === 0 ? 1 : -1
    return {
      x: (bp.x + at.x) / 2 + (-dz / len) * r * s,
      y: typeof bp.y === 'number' ? bp.y : at.y,
      z: (bp.z + at.z) / 2 + (dx / len) * r * s,
    }
  } catch (_) { return null }
}

// Source 1: the castle chest. Returns true while it owns the tick.
function chestTick(bot, ctx, f, d) {
  if (f.chestDone) return false
  // Reserved slot (g0z.26 R2): drawing from the owner's chest into a
  // reserved pack would fill the bootstrap slot — skip the source this leg
  // (the stock stays in the chest, nothing is lost).
  try {
    const stockpile = require('./stockpile')
    if (stockpile && typeof stockpile.slotReserved === 'function' && stockpile.slotReserved(bot, ctx)) {
      f.chestDone = true
      return false
    }
  } catch (_) { /* reserve unreadable: draw as before */ }
  if (!f.chest) {
    f.chest = pickChest(bot, ctx, f, d.kind)
    f.chestWalk = null
    f.chestKey = null // 6fc1: a new chest owns a fresh walk + retry budget
    f.chestRetries = 0
    f.chestVia = null
    f.chestViaWalk = null
  }
  if (!f.chest) { f.chestDone = true; return false }
  const { at, k, bank } = f.chest
  if (!near(bot, at, CHEST_REACH)) {
    const v2 = process.env.BOT_BODY === 'baritone'
    const key = `castlefetch-chest:${k}`
    // A staging detour in flight: walk it first; arrival drops back to the
    // chest approach, a dead staging spends its retry and falls through.
    if (f.chestVia) {
      const bp = bodyPos(bot)
      const vd = bp ? Math.hypot(bp.x - f.chestVia.x, bp.z - f.chestVia.z) : Infinity
      if (vd <= CHEST_VIA_REACH) {
        f.chestVia = null
        f.chestWalk = null
      } else if (v2 && ctx.lastGoalKey === f.chestViaKey &&
        (ctx.lastPathStatus === 'noPath' || ctx.lastPathStatus === 'timeout')) {
        f.chestVia = null // dead staging: the chest walk below re-decides
      } else {
        walkTo(bot, ctx, f.chestViaKey, new Vec3(Math.floor(f.chestVia.x), Math.floor(f.chestVia.y), Math.floor(f.chestVia.z)), 1)
        // Bounded even if the bridge goes silent (its stall clock always
        // verdicts a live walk, but a paused body never does): the via
        // shares the chest's patience shape on its own dist series.
        if (stalled(f.chestViaWalk || (f.chestViaWalk = {}), vd, CHEST_WAITS)) f.chestVia = null
        return true
      }
    }
    // v2 noPath on OUR walk (6fc1): the verdict is attributed by key (the
    // anchor below zeroes it on every issue we send, gather's shape), so a
    // stale or foreign verdict never spends the budget.
    if (v2 && f.chestKey != null && ctx.lastGoalKey === f.chestKey &&
      ctx.lastPathStatus === 'noPath' && (f.chestRetries | 0) < CHEST_RETRIES) {
      const n = (f.chestRetries = (f.chestRetries | 0) + 1)
      if (n > 1) {
        const cell = chestVia(bodyPos(bot), at, n)
        if (cell) {
          f.chestVia = cell
          f.chestViaKey = `${key}#via${n}`
          f.chestViaWalk = null
          try { console.log(`castlefetch ${d.kind}: chest walk noPath, detour ${n}/${CHEST_RETRIES} via ${Math.floor(cell.x)},${Math.floor(cell.z)}`) } catch (_) { /* log best-effort */ }
          walkTo(bot, ctx, f.chestViaKey, new Vec3(Math.floor(cell.x), Math.floor(cell.y), Math.floor(cell.z)), 1)
          try { ctx.lastPathStatus = 'none' } catch (_) { /* verdict best-effort */ }
          f.chestWalk = null
          return true
        }
      } else {
        try { console.log(`castlefetch ${d.kind}: chest walk noPath, retry ${n}/${CHEST_RETRIES} from the live feet`) } catch (_) { /* log best-effort */ }
      }
      const rkey = `${key}#r${n}`
      walkTo(bot, ctx, rkey, at, 2)
      f.chestKey = rkey
      try { ctx.lastPathStatus = 'none' } catch (_) { /* verdict best-effort */ }
      f.chestWalk = null
      return true
    }
    walkTo(bot, ctx, key, at, 2)
    if (v2 && ctx.lastGoalKey === key && f.chestKey !== key) {
      // Our issue just went out (first, steal-return, or re-approach):
      // anchor the verdict so only a fresh noPath retries.
      f.chestKey = key
      try { ctx.lastPathStatus = 'none' } catch (_) { /* verdict best-effort */ }
    }
    // Stalled walk only (a far chest stays walkable while the bot closes in).
    const bp = bodyPos(bot)
    const dd = bp ? Math.hypot(bp.x - at.x, bp.y - at.y, bp.z - at.z) : Infinity
    if (stalled(f.chestWalk || (f.chestWalk = {}), dd, CHEST_WAITS)) { // unreachable: next chest
      if (bank) markChestDry(ctx, d.kind, k)
      f.chest = null
    }
    return true
  }
  f.chest = null // one withdraw per chest per leg: the next tick picks the next chest
  f.chestVia = null // 6fc1: in reach — the detour served its purpose
  ctx.castleFetchFlight = 'chest' // time-split label: in-flight ticks bucket below
  // A bank chest draws one batch, never past stockpile's castle keep
  // (FETCH + reserve = STONE_KEEP 88; planks 34 < PLANK_KEEP 64): what it
  // hands over is never banked straight back (no deposit<->withdraw
  // ping-pong). The owner's footprint chest draws the whole short, as before.
  const need0 = bank ? Math.min(d.short, bankCap(bot, d.kind)) : d.short
  flight(ctx, async () => {
    const dr = await drawChest(bot, ctx, d, at, need0)
    const left = dr.left
    if (!bank) return
    // A stairs table fund is not the need: it never dry-marks the bank
    // (revmux 01 core-3 — the need line below would read 'drew 0 of N'
    // for a chest that just gave the table).
    const fund = dr.fund | 0
    try { console.log(`castlefetch ${d.kind}: drew ${Math.max(0, Math.round(need0 - left))} of ${need0}${fund ? ` plus table fund x${fund}` : ''} from the bank chest at ${k}`) } catch (_) { /* log best-effort */ }
    if (left > 0 && !fund) markChestDry(ctx, d.kind, k) // drained: no walk back to it within CHEST_DRY_MS
    else if (left <= 0) f.bankFull = true // a full bank batch: the leg lays it instead of digging the rest
  }, CHEST_TIMEOUT_MS, () => { if (bank) markChestDry(ctx, d.kind, k) })
  return true
}

// g0z.60: castle stock banked by stockpile (home chest, else the site
// chest) is a castlefetch source too — deposit and withdraw meet. A
// drained/unreachable bank chest is dry for the kind for CHEST_DRY_MS (the
// gather chestLogsTick shape), so it never loops.
const CHEST_DRY_MS = 10 * 60 * 1000
function markChestDry(ctx, kind, k) {
  (ctx.castleChestDry || (ctx.castleChestDry = {}))[`${kind}@${k}`] = Date.now()
}

// Nearest untried chest this leg: the footprint chest (owner's, never
// dry-marked: he restocks it), ctx.castle.siteChest, ctx.home.chest —
// the bank ones within TASK_SEARCH_RADIUS of the body.
function bankCap(bot, kind) {
  return kind in FETCH ? Math.max(0, FETCH[kind] + castleMod.reserveOf(kind) - castleMod.held(bot, kind)) : Infinity
}

function pickChest(bot, ctx, f, kind) {
  const tried = f.chestTried || (f.chestTried = new Set())
  const banks = !f.bankFull && bankCap(bot, kind) > 0 // the keep packed: no bank walk
  const bp = bodyPos(bot)
  const dry = ctx.castleChestDry || {}
  const now = Date.now()
  const cands = []
  const own = castleChest(bot, ctx.castle)
  if (own) cands.push({ at: own, bank: false })
  for (const c of [ctx.castle && ctx.castle.siteChest, ctx.home && ctx.home.chest]) {
    // mlob: the home chest of a holed house is no source (build.entranceHoled).
    if (c && ctx.home && c === ctx.home.chest && require('./build').entranceHoled(bot, ctx, c)) continue
    if (banks && c && typeof c.x === 'number') cands.push({ at: new Vec3(c.x, c.y, c.z), bank: true })
  }
  let best = null
  for (const c of cands) {
    const k = `${c.at.x},${c.at.y},${c.at.z}`
    if (tried.has(k)) continue
    if (c.bank && typeof dry[`${kind}@${k}`] === 'number' && now - dry[`${kind}@${k}`] < CHEST_DRY_MS) continue
    const dist = bp ? Math.hypot(bp.x - c.at.x, bp.z - c.at.z) : 0
    if (c.bank && dist > require('./explore').TASK_SEARCH_RADIUS) continue
    if (!best || dist < best.dist) best = { ...c, k, dist }
  }
  if (best) tried.add(best.k)
  return best
}

// The pack already funds a stairs table (vf8e.8): its own table, 4
// planks-worth of wood, or a standing table in reach (craftany's
// tablePathOf shape) — the chest's table/planks/log stay where they are,
// never pulled from the bank for a table the bot can walk to.
function stairsTableFunded(bot, ctx) {
  if (countItems(bot, (n) => n === 'crafting_table') > 0) return true
  if (countItems(bot, (n) => n.endsWith('_planks')) + 4 * countItems(bot, (n) => n.endsWith('_log')) >= 4) return true
  try { if (require('./craftany').standingTable(bot, ctx)) return true } catch (_) { /* unreadable claim: draw */ }
  return false
}

// The stairs table is still unfunded (vf8e.8): the craft failed out on
// the table (f.tableRetry latched by a 'crafting table' line) and the
// pack holds no table, no 4 planks-worth, no reachable standing table.
// v2 only after the 8njf stone batch (ctx.castleStairsMines > 0) —
// stone first, then the log.
function stairsTableBroke(bot, ctx, f) {
  if (!f.craftOut || !f.tableRetry) return false
  if (process.env.BOT_BODY === 'baritone' && !(ctx.castleStairsMines > 0)) return false
  return !stairsTableFunded(bot, ctx)
}

// One chest's withdraw for the demand: the kind's lists in order (finished
// item first, then its raw stock). Returns the need left (> 0: short).
async function drawChest(bot, ctx, d, at, need) {
  let fund = 0 // stairs table-fund items drawn (not the need — chestTick's bank log/dry-mark read it)
  for (const names of chestNames(bot, d.kind)) {
    if (need <= 0 || names.length === 0) break
    // Stairs table fund (vf8e.8): the stairs recipe needs a table the
    // pack may not hold — draw ONE table's worth (a table, else the
    // missing planks up to 4, else 1 log), never the stairs need. The
    // finished-stairs list above still draws the need as before, and a
    // funded pack skips the fund (never the bank's keep for a table the
    // bot can already make or walk to).
    if (d.kind === 'stairs' && !names.some((n) => n.endsWith('_stairs'))) {
      if (!stairsTableFunded(bot, ctx)) {
        const missing = Math.max(0, 4 - countItems(bot, (n) => n.endsWith('_planks')) - 4 * countItems(bot, (n) => n.endsWith('_log')))
        const want = names[0] === 'crafting_table' ? 1 : names.some((n) => n.endsWith('_planks')) ? missing : 1
        if (want > 0) {
          const r = await stockpileMod.withdrawAnyFromChest(bot, ctx, names, want, at)
          if (r && r.got > 0) {
            fund += r.got
            try { console.log(`castlefetch stairs: drew table fund ${r.name} x${r.got} from the chest`) } catch (_) { /* log best-effort */ }
          }
        }
      }
      continue
    }
    // Planks' second list is logs: one log is four planks; panes' is
    // glass: six glass are sixteen panes (one craft).
    // g0z.56: a log also makes 2 fences or doors, half a chest.
    const logs = names.some((n) => n.endsWith('_log')) ? (LOG_YIELD[d.kind] || 0) : 0
    // szr1: a planks list for a log-yield kind (door/fence/gate chest
    // stock) draws one log's planks per log the kind would have drawn —
    // same fund, direct stock. The planks kind itself keeps its 1:1 list.
    const plankLogs = !logs && d.kind !== 'planks' && names.length > 0 && names.every((n) => n.endsWith('_planks')) && (LOG_YIELD[d.kind] || 0) > 0
    const glass = d.kind === 'pane' && names[0] === 'glass'
    // Banners' is wool (g0z.35): six per banner, only once the beds stand.
    const wool = d.kind === 'banner' && names[0].endsWith('_wool')
    if (wool && !bannerSelf(bot, ctx)) break
    // Shelves' is books (g0z.49): three per shelf, the wool shape.
    const book = d.kind === 'bookshelf' && names[0] === 'book'
    // Panes' third is sand (g0z.38): the ladder's whole sand need, at once.
    if (d.kind === 'pane' && names[0] === 'sand') {
      const sn = paneNeed(bot, ctx, d).sandNeed
      if (sn > 0) await stockpileMod.withdrawAnyFromChest(bot, ctx, names, sn, at)
      break
    }
    // Blast mats (g0z.51): the ladder's whole need per mat, at once (the
    // sand shape) — finished first through the generic need below, then
    // iron, the smooth chain, recipe cobble. Recomputed per mat: each
    // withdraw lands in the pack before the next want is read.
    if (d.kind === 'blast_furnace' && names[0] !== 'blast_furnace') {
      const bn = blastNeed(bot)
      const ironShort = Math.max(0, BLAST_IRON - bn.ingots - bn.raw)
      const chainShort = Math.max(0, BLAST_SMOOTH - bn.smooth - bn.stone)
      // Cobble to the rung gate (reserve + ladder need, one withdraw —
      // the gate below re-checks the same total, so a stocked chest
      // spares the dig entirely).
      const cobbleShort = Math.max(0, chainShort + (bn.furn > 0 ? 0 : BLAST_FURNACE_COBBLE) + castleMod.reserveOf('stone') - bn.cobble)
      const want = names[0] === 'iron_ingot' || names[0] === 'raw_iron' ? ironShort
        : names[0] === 'smooth_stone' || names[0] === 'stone' ? chainShort
        : names[0] === 'cobblestone' ? cobbleShort : 0
      if (want > 0) await stockpileMod.withdrawAnyFromChest(bot, ctx, names, want, at)
      continue
    }
    // Books already packed cover shelves too (revmux 01 minor): never
    // withdraw what the pack holds.
    const bookWant = book ? Math.max(0, BOOKS_PER_SHELF * Math.ceil(need) - countItems(bot, (n) => n === 'book')) : need
    if (plankLogs) {
      // Best single variant (send-back 1, codex P2): exact-wood crafts
      // cannot mix, so mixed-short stacks (3 birch + 3 oak) must not each
      // shave the shared need — that reads as funded (need <= 0 skips the
      // logs list) while no variant crafts, the same livelock. Fund ONE
      // wood only: the variant with the biggest pack+chest fund, pack
      // first on ties (names arrive in planksFirst order); draw it only
      // when the chest holds it, else the logs list below funds the table
      // from convertible stock. One peek + one withdraw (szr1 core-2).
      // An unreadable chest keeps the legacy full loop.
      let counts = null
      try { counts = await stockpileMod.chestCounts(bot, ctx, names, at) } catch (_) { counts = null }
      if (!counts) {
        for (const name of names) {
          if (need <= 0) break
          const pr = await stockpileMod.withdrawAnyFromChest(bot, ctx, [name], Math.ceil(need / LOG_YIELD[d.kind]) * 4, at)
          need -= (pr && pr.got ? pr.got : 0) * (LOG_YIELD[d.kind] / 4)
        }
      } else {
        const have = (n) => countItems(bot, (x) => x === n)
        const wantFull = Math.ceil(need / LOG_YIELD[d.kind]) * 4
        let best = null, bestFund = -1
        for (const name of names) {
          if ((counts[name] | 0) <= 0) continue
          const fund = have(name) + counts[name]
          if (fund > bestFund) { bestFund = fund; best = name }
        }
        if (best) {
          const pr = await stockpileMod.withdrawAnyFromChest(bot, ctx, [best], wantFull, at)
          need -= (pr && pr.got ? pr.got : 0) * (LOG_YIELD[d.kind] / 4)
        }
      }
    } else {
      const r = await stockpileMod.withdrawAnyFromChest(bot, ctx, names, logs ? Math.ceil(need / logs) : glass ? 6 * Math.ceil(need / 16) : wool ? BANNER_WOOL * Math.ceil(need) : book ? bookWant : need, at)
      need -= (r && r.got ? r.got : 0) * (logs || (glass ? 16 / 6 : wool ? 1 / BANNER_WOOL : book ? 1 / BOOKS_PER_SHELF : 1))
    }
  }
  return { left: need, fund }
}

// Source 2: craft from the pack. Returns true while it owns the tick.
function craftTick(bot, ctx, f, d) {
  const names = craftNames(bot, d.kind)
  if (names.length === 0 || f.craftOut) return false
  if (d.kind === 'banner' && !bannerSelf(bot, ctx)) return false // beds first: the wool is theirs
  if (d.kind === 'stairs' && stairsCobbleShort(bot)) return false // dig first (stairsDig); the scaffold/shelter reserve stays
  // Smelting's coal floor; charcoal is always spendable (light.js 33vm, g0z.62's torchTick smelts it).
  // ponytail: craftany may still pick the coal recipe when both are held — a reserve leak of one coal per 4 torches.
  if (d.kind === 'torch' && require('./light').spendableFuel(countItems(bot, (n) => n === 'coal'), countItems(bot, (n) => n === 'charcoal')) <= 0) return false
  let r = null
  try { r = deps.craftItem(bot, ctx, names, CRAFT_COUNT[d.kind] || 1) } catch (_) { r = { done: false } }
  if (r === 'running') return true
  if (r && r.done) { if (d.kind === 'stairs') ctx.castleStairsMines = 0; return true } // re-check the target next tick
  // idkcraft-pdjx: the failure line used to die here — a craft leg failed
  // with materials on hand and the reason was invisible in the logs.
  // Classified by kind; once per latch (craftOut), so no spam.
  if (r && typeof r.line === 'string' && r.line) {
    // g0z.56: with no wood at all craftany names its last tie-break variant
    // (warped_fence) — name the real gap instead.
    const woodless = WOOD.has(d.kind) && countItems(bot, (n) => n.endsWith('_planks') || n.endsWith('_log')) === 0
    const line = woodless ? `can't craft ${d.kind}: no planks or logs` : r.line
    f.craftLine = line // szr1 core-3: the bankFull gate reads the latest failure
    try { console.log(`castlefetch ${d.kind}: craft failed: ${line}`) } catch (_) { /* log best-effort */ }
    // idkcraft-8njf: a table failure gets one fresh craft run per leg. The
    // walk give-up latched that table dead for the day (craftany deadToday)
    // and a refused placement run ended on its try cap, so the re-plan
    // places a fresh table from the pack — instead of the leg failing into
    // the 5-min hold -> forage -> rest -> house-build spiral (pwoi rig).
    if (/crafting table/.test(line) && !f.tableRetry) {
      f.tableRetry = true
      try { console.log(`castlefetch ${d.kind}: retrying the craft with a fresh table`) } catch (_) { /* log best-effort */ }
      return true
    }
  }
  f.craftOut = true // the pack cannot fund it: fall through to the world
  return false
}

// Stairs craft only from cobble above the castle's stone reserve (revmux 02
// core-6); below it the leg digs (stairsDig) — the bot sources its own stone.
const STAIRS_COBBLE = 6
function stairsCobbleShort(bot) {
  return countItems(bot, (n) => n === 'cobblestone') < STAIRS_COBBLE + castleMod.reserveOf('stone')
}

// Beds first (g0z.35): the banner self-source (hunt, chest wool, craft)
// runs only when the residence owes no bed — STEP_ORDER ranks castlefetch
// above beds, so the gate lives here, not in the arbiter.
function bannerSelf(bot, ctx) {
  try { return require('./beds').bedsFact(bot, ctx && ctx.home) === 'both' } catch (_) { return false }
}

// Self-source seam (g0z.35, owner 2026-10-09: the castle chest is only the
// first source). A leg opens a self bring order (the beds woolTick shape):
// bring's ticker runs it over every goal step, caps the search to the
// anchor, cancels at dusk and keeps the goods in the pack. The leg keeps
// the order on f.hunt and returns while ctx.bring is set (castleFetchGo
// stays true on the short demand, so the arbiter keeps the step); once
// ctx.bring is null again selfOrderBack reads it back.
function selfOrder(ctx, f, o) {
  o.self = 'castle'
  f.hunt = o
  ctx.bring = o
}

// null when no order was opened; else { exhausted } (refuseExhausted's
// searchLegs: the whole budget searched, timed out, or capped).
function selfOrderBack(f) {
  const o = f.hunt
  if (!o) return null
  f.hunt = null
  let exhausted = false
  try {
    const s = o.searchLegs || {}
    const budget = (require('./bring').SEARCH_BUDGET || {}).legs || 24
    exhausted = (s.legs || 0) >= budget || !!s.timedOut || !!s.capped
  } catch (_) { /* unreadable order: not exhausted */ }
  return { exhausted }
}

// Banner world source (g0z.35): wool through a self hunt, then craftTick.
// One sheep latch for every wool hunt in the bot (beds' noWool, 9qt0).
// ponytail: no reopen counter — the 5-min failed-leg hold is the bounded retry.
function bannerTick(bot, ctx, f, d) {
  if (ctx.bring) return // the ticker runs the hunt (ours or foreign)
  const bedsMod = require('./beds')
  const dry = (why) => { castleMod.noteDry(ctx, 'banner'); finish(bot, ctx, `failed:castlefetch-${why}`) }
  const top = require('./wool').topWoolColor(bot)
  const held = top ? top.count : 0
  const back = selfOrderBack(f)
  if (back) {
    if (back.exhausted) bedsMod.noteNoWool(ctx.beds && typeof ctx.beds === 'object' ? ctx.beds : (ctx.beds = {}))
    if (held >= BANNER_WOOL) { f.craftOut = false; return } // craft next tick
    dry('no-wool') // short, cancelled (dusk) or refused
    return
  }
  if (held >= BANNER_WOOL) { dry('craft-banner'); return } // wool on hand, craft failed (table, reach): never a second hunt
  const t = bot && bot.time && bot.time.timeOfDay
  if (typeof t === 'number' && t >= 12000) { dry('no-wool'); return } // day-only: bring would cancel at once
  if (bedsMod.sheepLatched(ctx, bot)) { dry('no-wool'); return }
  const bringMod = require('./bring')
  // Absolute pack target: bring's have already counts the held top colour,
  // so the hunt tops it up (did.3) — never subtract it here (revmux 01).
  const want = BANNER_WOOL * Math.max(1, Math.ceil(d.short))
  const base = { kind: 'item', name: 'wool', names: bedsMod.WOOL16.slice(), want, by: null, drop: null, have: 0 }
  let o = null
  try {
    o = countItems(bot, (n) => n.endsWith('_wool')) > 0 ? bringMod.toWoolHunt(bot, base) : { ...base, phase: bringMod.openPhase(ctx), announced: false }
  } catch (_) { o = null }
  if (!o) { dry('no-wool'); return }
  try { console.log(`castlefetch banner: hunting ${want} wool`) } catch (_) { /* log best-effort */ }
  selfOrder(ctx, f, o)
}

// Pane ladder need (g0z.38): glass for the whole open pane remainder
// (castleWord.left, 44 on a fresh castle = 3 crafts = 18 glass), so one
// sand order and one smelt cover every window. Sand only: the furnace job
// has one input name, so red sand is never counted (nor withdrawn).
function paneNeed(bot, ctx, d) {
  const cw = ctx && ctx.castleWord
  const left = cw && cw.kind === 'pane' && typeof cw.left === 'number' ? cw.left : d.short
  const panes = Math.max(d.short, left - castleMod.held(bot, 'pane'))
  const glass = countItems(bot, (n) => n === 'glass')
  const sand = countItems(bot, (n) => n === 'sand')
  const glassNeed = Math.max(0, 6 * Math.ceil(panes / 16) - glass)
  return { glass, sand, glassNeed, sandNeed: Math.max(0, glassNeed - sand) }
}

// Fuel for an n-item smelt (pane g0z.38, blast g0z.51): coal/charcoal,
// else planks from logs, else gather chops a load and ends the leg
// itself (the next leg re-enters with logs). True while it owns the tick.
function fuelTick(bot, ctx, f, target, state, n, dry) {
  const furnaceMod = require('./furnace')
  const coal = countItems(bot, (nm) => nm === 'coal' || nm === 'charcoal')
  const planks = countItems(bot, (nm) => nm.endsWith('_planks'))
  if (coal < Math.ceil(n / furnaceMod.ORE_PER_FUEL) && planks < Math.ceil(n / furnaceMod.ORE_PER_PLANK)) {
    if (countItems(bot, (nm) => nm.endsWith('_log')) > 0) {
      let r = null
      try { r = deps.craftItem(bot, ctx, craftNames(bot, 'planks'), CRAFT_COUNT.planks) } catch (_) { r = { done: false } }
      if (r === 'running' || (r && r.done)) return true
      dry('no-fuel') // logs on hand and no planks from them
      return true
    }
    // No logs: gather chops a load and ends the leg itself; the next leg
    // re-enters here with logs (the wood-kinds branch shape).
    deps.gather(bot, ctx, target, state)
    if (isFinished(ctx.stepStatus)) ctx.castleFetch = null
    return true
  }
  return false
}

// Pane world source (g0z.38, owner 2026-10-09: the bot sources the glass
// itself). Reached once the chest and the craft came up short this leg:
// sand (self bring order) -> fuel (coal/charcoal, else planks from logs,
// else gather) -> the castle furnace (sand -> glass) -> craftTick next
// tick. ponytail: no reopen counter — the 5-min failed-leg hold is the retry.
function paneTick(bot, ctx, f, d, target, state) {
  if (ctx.bring) return // the ticker runs the sand order (ours or foreign)
  const dry = (why) => { castleMod.noteDry(ctx, 'pane'); finish(bot, ctx, `failed:castlefetch-${why}`) }
  // A preempted smelt (dusk, another step) resumes on the next leg instead
  // of reordering sand that sits in the furnace (revmux 01).
  const fr = ctx.furnace
  if (fr && !fr.settled && fr.job && fr.job.input === 'sand') f.smelting = true
  if (f.smelting) { smeltTick(bot, ctx, f, dry); return } // sand sits in the furnace: never reorder it
  const n = paneNeed(bot, ctx, d)
  const back = selfOrderBack(f)
  if (n.glass >= 6) { dry('craft-pane'); return } // glass on hand, craft failed (table, reach): never a sand order
  // A full pack: the craft shed would toss the sand (craft.js dropRank);
  // fail so the stockpile banks first (the stone roomForDrop line).
  let stacks = 0
  try { stacks = (bot.inventory.items() || []).length } catch (_) { stacks = 0 }
  if (stacks >= stockpileMod.PACK_RESERVE) { dry('pack-full'); return }
  if (n.sandNeed > 0) {
    if (back) { dry('no-sand'); return } // short, cancelled (dusk) or refused
    const t = bot && bot.time && bot.time.timeOfDay
    if (typeof t === 'number' && t >= 12000) { dry('no-sand'); return } // day-only: bring would cancel at once
    const bringMod = require('./bring')
    // Absolute pack target: bring's have is the pack's sand count.
    const o = { kind: 'block', name: 'sand', want: n.glassNeed, by: null, drop: 'sand', have: n.sand, phase: bringMod.openPhase(ctx), announced: false }
    try { console.log(`castlefetch pane: digging ${n.glassNeed} sand (${n.sand} held)`) } catch (_) { /* log best-effort */ }
    ctx.castle.status = `fetching pane (sand ${n.sand}/${n.glassNeed})`
    selfOrder(ctx, f, o)
    return
  }
  // Fuel for the whole load (furnace.js ORE_PER_FUEL / ORE_PER_PLANK).
  if (fuelTick(bot, ctx, f, target, state, n.sand, dry)) return
  // Cobble rung (g0z.39): the castle furnace said no-cobble this leg.
  if (f.cobble && countItems(bot, (nm) => nm === 'cobblestone') < 8) { cobbleTick(bot, ctx, f, target, state, dry); return }
  f.smelting = true
  if (fr && fr.settled) fr.result = null // a stale outcome never ends the new run
  smeltTick(bot, ctx, f, dry)
}

// Cobble rung (g0z.39, owner: the bot gets its own materials): an empty
// kit has no 8 cobble for the castle furnace. A wooden pickaxe from the
// pack (craftany chains planks/sticks/table), else logs through gather
// (ends the leg; the next leg re-enters via the smelt's no-cobble); then
// digTick's stone source (exposed stone, quarry, pit) until 8 cobble, and
// the smelt retries. digTick's own failures end the leg into the hold.
function cobbleTick(bot, ctx, f, target, state, dry, want = 8, kind = 'pane') {
  ctx.castle.status = `fetching ${kind} (cobble ${countItems(bot, (nm) => nm === 'cobblestone')}/${want})`
  if (!hasPickaxe(bot)) {
    let r = null
    try { r = deps.craftItem(bot, ctx, ['wooden_pickaxe'], 1) } catch (_) { r = { done: false } }
    if (r === 'running' || (r && r.done)) return
    if (countItems(bot, (nm) => nm.endsWith('_log') || nm.endsWith('_planks')) > 0) { dry('no-pickaxe'); return } // wood on hand, craft failed (table, reach)
    deps.gather(bot, ctx, target, state)
    if (isFinished(ctx.stepStatus)) ctx.castleFetch = null
    return
  }
  digTick(bot, ctx, f)
  if (failReason(ctx.stepStatus) !== null) castleMod.noteDry(ctx, kind) // the decor word skips it (dry() shape)
}

// One furnace tick per castlefetch tick (g0z.36 contract: the job is set
// before EVERY driveFurnace call — the furnace consumes it each tick).
// The window cycle settles async (revmux 01): a run's outcome lands on
// ctx.furnace.result after driveFurnace returned, so a settled run is read
// back here first (furnace.js keeps a non-iron job off ctx.stepStatus).
// The job rides f.smeltJob (g0z.51: the blast ladder's iron/stone/smooth
// passes, counted); pane never sets it, so sand is the default.
function smeltTick(bot, ctx, f, dry) {
  ctx.castle.status = `fetching ${f.kind} (smelting)`
  const job = f.smeltJob || SAND_JOB
  let out = null
  const fr = ctx.furnace
  if (fr && fr.settled && fr.result && fr.job && fr.job.input === job.input && fr.job.output === job.output) {
    out = fr.result
    fr.result = null
  } else {
    ctx.furnaceJob = job.count == null ? { input: job.input, output: job.output } : { input: job.input, output: job.output, count: job.count }
    try { out = deps.driveFurnace(bot, ctx) } catch (e) { out = 'failed:leg-threw' }
  }
  if (!out) return // running; the furnace walks itself
  f.smelting = false
  f.smeltJob = null
  ctx.furnaceJob = null
  if (out === 'done') { f.craftOut = false; return } // craftTick crafts next tick
  if (out === 'failed:no-cobble' && !f.cobble) { // g0z.39: dig the furnace's 8 cobble, then smelt again
    f.cobble = true
    try { console.log(`castlefetch ${f.kind}: no cobble for the furnace, digging 8`) } catch (_) { /* log best-effort */ }
    return
  }
  dry(`smelt-${String(out).replace(/^failed:/, '')}`)
}

// Blast ladder need (g0z.51): the pack's recipe stock — 5 iron_ingot, 3
// smooth_stone, the recipe furnace — plus the smeltable chain (raw iron;
// stone and cobble feed the two smooth passes).
function blastNeed(bot) {
  return {
    ingots: countItems(bot, (n) => n === 'iron_ingot'),
    raw: countItems(bot, (n) => n === 'raw_iron'),
    smooth: countItems(bot, (n) => n === 'smooth_stone'),
    stone: countItems(bot, (n) => n === 'stone'),
    cobble: countItems(bot, (n) => n === 'cobblestone'),
    furn: countItems(bot, (n) => n === 'furnace'),
  }
}

// Blast world source (g0z.51, owner: the bot gets its own materials).
// Reached once the chest and the craft came up short this leg: 5 iron
// (pack + chest raw smelted — no mining leg, deep.js digs no iron) -> 3
// smooth stone (cobble -> stone -> smooth, two counted furnace passes,
// the cobble dug like the pane rung) -> the recipe furnace (8 cobble at
// a table; craftany's one-layer rule never makes it — g0z.50) ->
// craftTick next tick. ponytail: no reopen counter — the 5-min
// failed-leg hold is the retry.
function blastTick(bot, ctx, f, d, target, state) {
  if (ctx.bring) return // a foreign order runs (this ladder opens none)
  const dry = (why) => { castleMod.noteDry(ctx, 'blast_furnace'); finish(bot, ctx, `failed:castlefetch-${why}`) }
  // A preempted smelt resumes on the next leg instead of reordering work
  // already in the furnace (paneTick shape).
  const fr = ctx.furnace
  if (fr && !fr.settled && fr.job && BLAST_JOBS[fr.job.input]) {
    f.smelting = true
    f.smeltJob = { input: fr.job.input, output: BLAST_JOBS[fr.job.input] }
  }
  if (f.smelting) { smeltTick(bot, ctx, f, dry); return } // a run is in the furnace: never reorder it
  const n = blastNeed(bot)
  if (n.ingots >= BLAST_IRON && n.smooth >= BLAST_SMOOTH && n.furn >= 1) { dry('craft-blast'); return } // mats on hand, craft failed (table, reach): never re-smelt
  // A full pack: the crafts shed into it (craft.js dropRank); fail so the
  // stockpile banks first (the stone roomForDrop line, pane shape).
  let stacks = 0
  try { stacks = (bot.inventory.items() || []).length } catch (_) { stacks = 0 }
  if (stacks >= stockpileMod.PACK_RESERVE) { dry('pack-full'); return }
  // Iron rung: smelt the pack's raw; none anywhere (the chest came up
  // short this leg too) fails honestly — the hold is the retry.
  if (n.ingots < BLAST_IRON) {
    if (n.raw <= 0) { dry('no-iron'); return }
    blastSmelt(bot, ctx, f, target, state, dry, fr, { input: 'raw_iron', output: 'iron_ingot', count: Math.min(n.raw, BLAST_IRON - n.ingots) })
    return
  }
  // Smooth rung: stone -> smooth, else cobble -> stone; the cobble for the
  // chain and the recipe furnace is dug like the pane rung. Measured above
  // the scaffold/shelter reserve (the stairs rung shape): the ladder digs
  // its own instead of spending the walks' cobble.
  if (n.smooth < BLAST_SMOOTH) {
    const chain = Math.max(0, BLAST_SMOOTH - n.smooth - n.stone)
    const want = chain + (n.furn > 0 ? 0 : BLAST_FURNACE_COBBLE)
    const keep = castleMod.reserveOf('stone')
    if (want > 0 && n.cobble - keep < want) { cobbleTick(bot, ctx, f, target, state, dry, want + keep, 'blast_furnace'); return }
    if (n.stone < BLAST_SMOOTH - n.smooth) {
      blastSmelt(bot, ctx, f, target, state, dry, fr, { input: 'cobblestone', output: 'stone', count: Math.min(n.cobble, BLAST_SMOOTH - n.smooth - n.stone) })
      return
    }
    blastSmelt(bot, ctx, f, target, state, dry, fr, { input: 'stone', output: 'smooth_stone', count: BLAST_SMOOTH - n.smooth })
    return
  }
  // Recipe furnace rung: 8 cobble at a table, above the reserve (stairs shape).
  if (n.furn < 1) {
    const keep = castleMod.reserveOf('stone')
    if (n.cobble - keep < BLAST_FURNACE_COBBLE) { cobbleTick(bot, ctx, f, target, state, dry, BLAST_FURNACE_COBBLE + keep, 'blast_furnace'); return }
    let r = null
    try { r = deps.craftItem(bot, ctx, ['furnace'], 1) } catch (_) { r = { done: false } }
    if (r === 'running') return
    if (r && r.done) { f.craftOut = false; return } // craftTick crafts the blast next tick
    dry('craft-furnace') // cobble on hand, craft failed (table, reach)
    return
  }
  dry('craft-blast') // unreachable: all-mats short-circuits above — honest either way
}

// One blast smelt rung: fuel, the station's 8 on a no-cobble retry, then
// the counted run (smeltTick settles it; done re-arms the craft).
// Torch world source (g0z.62: a tidy repair owed 3 torches with no coal
// anywhere and failed every visit). Reached once the chest and the craft
// came up short: logs on hand -> charcoal at the castle furnace (light.js
// 33vm's path, the pane/blast furnace plumbing) -> craftTick next tick
// (one charcoal + a stick = 4 torches). No log: false, the leg fails
// castlefetch-no-torch as before.
const TORCH_HOME_DIST = 64 // castle.js TIDY_VISIT_DIST: farther than a visit = another place
// Field charcoal (idkcraft-akze): the rung below only smelts at the home
// furnace, but a tidy visit pins the bot at a far castle by day (gohome is
// night-only, and the owed home try only fires off site near home — the bot
// never leaves while the torch demand is open), so the leg failed no-torch
// every window and the relay word never advanced to the sweep. With a log,
// cobble for a furnace and fuel on hand, smelt the charcoal in a field
// furnace placed beside the body instead: plan/decor cells are never built
// on, and the furnace is dug up right after (an unbroken extra reads as
// neither regress nor litter, but untidy is untidy). craftTick then crafts
// the torches at the castle table like the home path.
const FIELD_FURNACE_TICKS = 180 // place + one cook + break, inside LEG_MAX_MS
const FIELD_PLACE_TRIES = 3
const FIELD_SMELT_POLLS = 40
const FIELD_DEAD_MS = 30 * 60 * 1000 // a given-up rung rests this long per site, then retries
const FIELD_RECLAIM_REACH = 5 // dig reach for an orphaned field furnace
function fieldSleep(ms) { return new Promise((r) => setTimeout(r, ms)) }
function fieldSiteKey(ctx) {
  try {
    const st = ctx && ctx.castle
    if (st && st.site && typeof st.site.x === 'number') return `${st.site.x},${st.site.y},${st.site.z}:${st.rot | 0}:${st.blueprintVersion | 0}`
  } catch (_) { /* key best-effort */ }
  return null
}
function poisonField(ctx) {
  try {
    const site = fieldSiteKey(ctx)
    if (site) ctx.castleFieldDead = { site, at: Date.now() }
  } catch (_) { /* latch best-effort */ }
}
// A safe field-furnace cell beside the body: air with solid footing that is
// no castle plan/decor cell (the relay must still lay there). The ground
// below may be anything solid — placing on it breaks nothing.
function fieldSpot(bot, ctx) {
  try {
    const bp = bot.entity && bot.entity.position
    if (!bp || typeof bp.x !== 'number') return null
    const st = ctx && ctx.castle
    let at = null
    let dt = null
    if (st && st.site && typeof st.site.x === 'number') {
      try { at = blueprint.absPlan(st.site, st.rot | 0, st.blueprintVersion).at } catch (_) { at = null }
      try { dt = blueprint.decorPlan(st.site, st.rot | 0, st.blueprintVersion).at } catch (_) { dt = null }
    }
    const bx = Math.floor(bp.x)
    const by = Math.floor(bp.y)
    const bz = Math.floor(bp.z)
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const x = bx + dx
      const z = bz + dz
      let below = null
      let cell = null
      try {
        below = bot.blockAt(new Vec3(x, by - 1, z))
        cell = bot.blockAt(new Vec3(x, by, z))
      } catch (_) { below = null; cell = null }
      // Solid footing only (tablespot's rule): water, snow and flora are
      // non-air but take no placement. Fail-open on an unknown shape — old
      // test doubles carry no boundingBox.
      if (!below || !below.position || !below.name || below.name === 'air') continue
      if (below.boundingBox != null && below.boundingBox !== 'block') continue
      if (!cell || (cell.name !== 'air' && cell.name !== 'cave_air' && cell.name !== 'void_air')) continue
      const k = `${x},${by},${z}`
      if (at && at.has(k)) continue
      if (dt && dt.has(k)) continue
      return { x, y: by, z }
    }
    return null
  } catch (_) { return null }
}
function fieldTorchTick(bot, ctx, f, d, dry, log, target, state) {
  // A given-up smelt poisons the rung (three refused opens/a stalled cook is
  // a persistent signal, not a blip): without this the next tick starts a
  // fresh field cycle and the leg loops place -> fail -> dig -> place,
  // burning cobble and never failing. Latched on ctx, site-keyed, for
  // FIELD_DEAD_MS (a new site, or a later visit after expiry, retries).
  if (ctx.castleFieldDead && ctx.castleFieldDead.site === fieldSiteKey(ctx) &&
      Date.now() - ctx.castleFieldDead.at < FIELD_DEAD_MS) return false
  const fl = f.field || (f.field = { phase: 'furnace', ticks: 0, tries: 0, flight: false, dead: false, at: null })
  fl.ticks = (fl.ticks | 0) + 1
  if (fl.dead || fl.ticks > FIELD_FURNACE_TICKS) {
    f.field = null
    // Poison on the way out (give-up and timeout alike): the next tick must
    // fail the leg, not start a fresh field cycle that stacks another
    // furnace. Site-keyed with expiry, so a later visit retries.
    poisonField(ctx)
    if (fl.dead) {
      try { console.log('castlefetch torch: field smelt abandoned, the furnace may stand') } catch (_) { /* log best-effort */ }
    }
    return false
  }
  if (fl.flight) return true
  // Fuel first (blastSmelt shape) — but only before anything is loaded: once
  // the log and fuel sit in the furnace (smelt/break), the pack may read
  // empty and fuelTick would hijack the tick into crafting or gathering.
  if (fl.phase === 'furnace' || fl.phase === 'place') {
    // One log and no other fuel smelts nothing (the log is the charcoal
    // input; fuel must come from elsewhere): fail instead of burning the
    // only log into planks and then placing a furnace that can never smelt.
    const logs = countItems(bot, (n) => n.endsWith('_log'))
    const fuel = countItems(bot, (n) => n === 'coal' || n === 'charcoal' || n.endsWith('_planks'))
    if (logs <= 1 && fuel <= 0) return false
    if (fuelTick(bot, ctx, f, target, state, 1, dry)) return true
  }
  if (fl.phase === 'furnace') {
    let item = null
    try { item = (bot.inventory.items() || []).find((i) => i && i.name === 'furnace') || null } catch (_) { item = null }
    // Reclaim an orphaned field furnace first (a step switch mid-cycle left
    // it standing): dig it instead of stacking another one. The drop may
    // restock the item; either way the extra is gone.
    if (!item && ctx.castleFieldFurnace && typeof ctx.castleFieldFurnace.x === 'number') {
      const rec = ctx.castleFieldFurnace
      let fb = null
      try { fb = bot.blockAt(new Vec3(rec.x, rec.y, rec.z)) } catch (_) { fb = null }
      if (fb && fb.name === 'furnace' && fb.position) {
        try {
          const bp = bot.entity && bot.entity.position
          const d = bp && Math.hypot(bp.x - rec.x, bp.z - rec.z)
          if (d != null && d <= FIELD_RECLAIM_REACH) {
            fl.phase = 'reclaim'
            fl.tries = 0
          } else { try { ctx.castleFieldFurnace = null } catch (_) { /* track best-effort */ } }
        } catch (_) { /* reclaim best-effort */ }
      } else { try { ctx.castleFieldFurnace = null } catch (_) { /* track best-effort */ } }
    }
    try { item = item || (bot.inventory.items() || []).find((i) => i && i.name === 'furnace') || null } catch (_) { /* recheck best-effort */ }
    if (!item && fl.phase === 'furnace') {
      if (countItems(bot, (n) => n === 'cobblestone') < 8) return false
      let r = null
      try { r = deps.craftItem(bot, ctx, ['furnace'], 1) } catch (_) { r = null }
      if (r === 'running') return true
      if (!(r && r.done)) return false
      try { item = (bot.inventory.items() || []).find((i) => i && i.name === 'furnace') || null } catch (_) { item = null }
      if (!item) return false
      fl.phase = 'place'
      fl.tries = 0
    } else if (fl.phase === 'furnace') {
      fl.phase = 'place'
      fl.tries = 0
    }
    // A reclaim phase set above falls through to its own block below.
  }
  if (fl.phase === 'reclaim') {
    const rec = ctx.castleFieldFurnace
    if (!rec || typeof rec.x !== 'number') { fl.phase = 'furnace'; return true }
    fl.flight = true
    void (async () => {
      try {
        if (fl.dead) return
        let fb = null
        try { fb = bot.blockAt(new Vec3(rec.x, rec.y, rec.z)) } catch (_) { fb = null }
        if (fb && fb.name === 'furnace') {
          try {
            const items = (bot.inventory.items() || [])
            const pick = items.find((i) => i && typeof i.name === 'string' && i.name.endsWith('_pickaxe'))
            if (pick && bot.equip) await bot.equip(pick, 'hand')
          } catch (_) { /* dig decides */ }
          await bot.dig(fb)
        }
        try { ctx.castleFieldFurnace = null } catch (_) { /* track best-effort */ }
        fl.phase = 'furnace'
        fl.tries = 0
        try { console.log(`castlefetch torch: orphaned field furnace at ${rec.x} ${rec.y} ${rec.z} reclaimed`) } catch (_) { /* log best-effort */ }
      } catch (e) {
        fl.tries = (fl.tries | 0) + 1
        if (fl.tries >= FIELD_PLACE_TRIES) { try { ctx.castleFieldFurnace = null } catch (_) { /* track best-effort */ } fl.phase = 'furnace' }
      } finally {
        if (f.field === fl) fl.flight = false
      }
    })()
    return true
  }
  if (fl.phase === 'place') {
    const spot = fieldSpot(bot, ctx)
    if (!spot) return false // no safe cell: no-torch as before
    fl.flight = true
    void (async () => {
      try {
        if (fl.dead) return
        let item = null
        try { item = (bot.inventory.items() || []).find((i) => i && i.name === 'furnace') || null } catch (_) { item = null }
        if (!item) throw new Error('no-furnace-item')
        if (bot.equip) { try { await bot.equip(item, 'hand') } catch (_) { /* held already or bust: placement decides */ } }
        let ref = null
        try { ref = bot.blockAt(new Vec3(spot.x, spot.y - 1, spot.z)) } catch (_) { ref = null }
        if (!ref || !ref.position) throw new Error('no-spot')
        await bot.placeBlock(ref, new Vec3(0, 1, 0))
        let at = null
        try { at = bot.blockAt(new Vec3(spot.x, spot.y, spot.z)) } catch (_) { at = null }
        if (!at || at.name !== 'furnace') throw new Error('furnace-place')
        fl.at = { x: spot.x, y: spot.y, z: spot.z }
        fl.phase = 'smelt'
        fl.tries = 0
        try { if (log && typeof log.name === 'string') fl.logName = log.name } catch (_) { /* name best-effort */ }
        // Track the placed furnace on ctx (not the leg): a step switch
        // mid-cycle orphans it, and the next torch leg reclaims it instead
        // of stacking another one.
        try { ctx.castleFieldFurnace = { ...fl.at } } catch (_) { /* track best-effort */ }
        try { console.log(`castlefetch torch: field furnace placed at ${spot.x} ${spot.y} ${spot.z}`) } catch (_) { /* log best-effort */ }
      } catch (e) {
        fl.tries = (fl.tries | 0) + 1
        if (fl.tries >= FIELD_PLACE_TRIES) fl.dead = true
      } finally {
        if (f.field === fl) fl.flight = false
      }
    })()
    return true
  }
  if (fl.phase === 'smelt') {
    if (!fl.at) { fl.dead = true; return true }
    fl.flight = true
    void (async () => {
      let win = null
      try {
        if (fl.dead) return
        let fb = null
        try { fb = bot.blockAt(new Vec3(fl.at.x, fl.at.y, fl.at.z)) } catch (_) { fb = null }
        if (!fb || fb.name !== 'furnace') throw new Error('furnace-gone')
        const craftMod = require('./craft')
        win = await bot.openFurnace(fb)
        // The log may already sit in the furnace (putInput ran on an earlier
        // try): use the stored name, not the pack scan.
        const logName = (fl.logName && typeof fl.logName === 'string') ? fl.logName : (log && log.name)
        const logId = (typeof logName === 'string' && logName) ? craftMod.itemId(bot, logName) : null
        if (logId == null) throw new Error('no-log-id')
        await win.putInput(logId, null, 1)
        let fuelId = null
        try {
          if (countItems(bot, (n) => n === 'coal') > 0) fuelId = craftMod.itemId(bot, 'coal')
          else {
            const pl = (bot.inventory.items() || []).find((i) => i && typeof i.name === 'string' && i.name.endsWith('_planks'))
            if (pl) fuelId = craftMod.itemId(bot, pl.name)
          }
        } catch (_) { fuelId = null }
        if (fuelId == null) throw new Error('no-fuel-id')
        await win.putFuel(fuelId, null, 1)
        let smelted = false
        for (let i = 0; i < FIELD_SMELT_POLLS && !fl.dead; i++) {
          await fieldSleep(500)
          let o = null
          try { o = win.outputItem && win.outputItem() } catch (_) { o = null }
          if (o && o.name === 'charcoal' && (o.count | 0) > 0) { smelted = true; break }
        }
        if (!smelted) throw new Error('smelt-stalled')
        await win.takeOutput()
        fl.phase = 'break'
        fl.tries = 0
        fl.smelted = true
        try { console.log('castlefetch torch: field charcoal smelted') } catch (_) { /* log best-effort */ }
      } catch (e) {
        fl.tries = (fl.tries | 0) + 1
        if (fl.tries >= FIELD_PLACE_TRIES) {
          // Give up smelting, but still dig the furnace up when it stands:
          // an abandoned extra reads verdict-neutral, yet untidy is untidy,
          // and the next leg must not stack another one on top.
          if (fl.at) { fl.phase = 'break'; fl.tries = 0 }
          else fl.dead = true
        }
      } finally {
        try { if (win && bot.closeWindow) await bot.closeWindow(win) } catch (_) { /* close best-effort */ }
        if (f.field === fl) fl.flight = false
      }
    })()
    return true
  }
  if (fl.phase === 'break') {
    if (!fl.at) { f.field = null; return true } // defensive: nothing placed, nothing to re-arm
    fl.flight = true
    void (async () => {
      try {
        if (fl.dead) return
        let fb = null
        try { fb = bot.blockAt(new Vec3(fl.at.x, fl.at.y, fl.at.z)) } catch (_) { fb = null }
        if (fb && fb.name === 'furnace') {
          // A pick best-effort (a bare hand clears it too, just slower).
          try {
            const items = (bot.inventory.items() || [])
            const pick = items.find((i) => i && typeof i.name === 'string' && i.name.endsWith('_pickaxe'))
            if (pick && bot.equip) await bot.equip(pick, 'hand')
          } catch (_) { /* dig decides */ }
          await bot.dig(fb)
        }
        let after = null
        try { after = bot.blockAt(new Vec3(fl.at.x, fl.at.y, fl.at.z)) } catch (_) { after = null }
        if (after && after.name !== 'air' && after.name !== 'cave_air' && after.name !== 'void_air') throw new Error('furnace-break')
        try { console.log(`castlefetch torch: field furnace at ${fl.at.x} ${fl.at.y} ${fl.at.z} broken`) } catch (_) { /* log best-effort */ }
        try { ctx.castleFieldFurnace = null } catch (_) { /* track best-effort */ }
        f.field = null
        if (fl.smelted) f.craftOut = false // charcoal in the pack: craftTick crafts next tick
        // A given-up smelt poisons the rung (site-keyed, expires): fail the
        // leg instead of re-placing on the next tick.
        else poisonField(ctx)
      } catch (e) {
        fl.tries = (fl.tries | 0) + 1
        if (fl.tries >= FIELD_PLACE_TRIES) fl.dead = true
      } finally {
        if (f.field === fl) fl.flight = false
      }
    })()
    return true
  }
  return false
}
function torchTick(bot, ctx, f, d, target, state) {
  if (ctx.bring) return true // a foreign order runs (this rung opens none)
  const dry = (why) => { castleMod.noteDry(ctx, 'torch'); finish(bot, ctx, `failed:castlefetch-${why}`) }
  const fr = ctx.furnace
  if (fr && !fr.settled && fr.job && fr.job.output === 'charcoal') { // a preempted smelt resumes (paneTick shape)
    f.smelting = true
    f.smeltJob = { input: fr.job.input, output: 'charcoal' }
  }
  if (f.smelting) { smeltTick(bot, ctx, f, dry); return true }
  // furnace.js smelts at the HOME furnace only: away from it (a tidy visit at
  // a far castle) the field furnace below smelts the charcoal on site instead
  // of walking the castle->house leg mid-fetch; the home path (blastSmelt)
  // still runs whenever the bot is near home (g0z.62 rig).
  let far = false
  try {
    const h = ctx.home && (ctx.home.furnace || ctx.home.site)
    const bp = bot.entity && bot.entity.position
    far = !!(h && bp && typeof h.x === 'number' && Math.hypot(bp.x - h.x, bp.z - h.z) > TORCH_HOME_DIST)
  } catch (_) { /* guard best-effort: the smelt walk decides */ }
  // An active field cycle owns the tick even when the pack log is gone (the
  // last log may already sit in the furnace): otherwise the break phase
  // never runs and the furnace stands. The smelt uses its stored log name.
  if (far && f.field) return fieldTorchTick(bot, ctx, f, d, dry, null, target, state)
  let log = null
  try { log = (bot.inventory.items() || []).find((i) => i && typeof i.name === 'string' && i.name.endsWith('_log')) } catch (_) { log = null }
  if (!log) return false
  if (far) return fieldTorchTick(bot, ctx, f, d, dry, log, target, state)
  blastSmelt(bot, ctx, f, target, state, dry, fr, { input: log.name, output: 'charcoal', count: Math.max(1, Math.min(log.count, Math.ceil(d.short / CRAFT_COUNT.torch))) })
  return true
}

function blastSmelt(bot, ctx, f, target, state, dry, fr, job) {
  if (fuelTick(bot, ctx, f, target, state, job.count, dry)) return
  if (f.cobble && blastNeed(bot).cobble < 8) { cobbleTick(bot, ctx, f, target, state, dry, 8, 'blast_furnace'); return } // the station's 8 (pane rung, blast dry kind)
  f.smelting = true
  f.smeltJob = job
  if (fr && fr.settled) fr.result = null // a stale outcome never ends the new run
  smeltTick(bot, ctx, f, dry)
}

// Exposed stone only (revmux 01): air above, or air on a side — surface
// rock, cliffs, walk-in cave mouths, within a few blocks of the feet level. Buried stone would make the walk dig a shaft
// down to it. findBlocks collects every stone of the sections it visits,
// so a wide count costs one sort, not a wider scan; the exposure filter
// is two-ish blockAt per candidate. Nearest first, never the site, a
// danger spot, or our own feet column.
const EXPOSE = [[0, 1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]]
const AIRISH = new Set(['air', 'cave_air'])
// Shared stone acceptance (R2 core-2): the ground window, exposure,
// danger and break checks in one predicate so pickStone and the
// watchdog's live scan accept the same blocks. gy is the ground anchor
// (the site y, or the latched far candidate's y inside a far leg). at
// resolves the block (pickStone's stoneAt); default is bot.blockAt.
function acceptStone(bot, ctx, p, gy, at) {
  try {
    if (!bot || !p || typeof p.x !== 'number' || typeof p.y !== 'number' || typeof p.z !== 'number') return false
    if (typeof gy !== 'number') return false
    if (p.y < gy - STONE_BELOW || p.y > gy + STONE_ABOVE) return false
    const open = EXPOSE.some(([x, y, z]) => {
      try { const n = bot.blockAt(new Vec3(p.x + x, p.y + y, p.z + z)); return !!n && AIRISH.has(n.name) } catch (_) { return false }
    })
    if (!open) return false
    try { if (danger.near(ctx, p)) return false } catch (_) { return false }
    let b = null
    try {
      b = typeof at === 'function' ? at(p) : bot.blockAt(new Vec3(p.x, p.y, p.z))
    } catch (_) { b = null }
    if (!b) return false
    try { if (!canBreak(bot, b, ctx)) return false } catch (_) { return false }
    return true
  } catch (_) {
    return false
  }
}
function pickStone(bot, ctx, f, bp, stoneAt) {
  const e = bot.registry && bot.registry.blocksByName && bot.registry.blocksByName.stone
  let found = []
  // Around the SITE (g0z.15): the window below is the site's, so a search
  // around a far body found nothing ever (prod: 14 instant no-stone).
  // (.22) a castlefetch-far unlock searches around the known candidate
  // instead (the live exposed stone the table validated), anchored on the
  // candidate's ground — latched onto the leg, so re-picks after each dug
  // block keep searching the candidate ground until the leg ends.
  let c = siteCenter(ctx.castle)
  let gy = ctx.castle.site.y
  let cand = null
  try {
    const { goalUnlock } = require('../goal-unlock')
    cand = goalUnlock(ctx, 'candidate')
  } catch (_) { cand = null }
  if (cand && typeof cand.x === 'number' && typeof cand.z === 'number') {
    f.farCandidate = { x: cand.x, y: cand.y, z: cand.z }
  } else if (f.farCandidate && typeof f.farCandidate.x === 'number') {
    cand = f.farCandidate
  } else {
    cand = null
  }
  if (cand) {
    c = { x: cand.x, y: typeof cand.y === 'number' ? cand.y : gy, z: cand.z }
    if (typeof cand.y === 'number') gy = cand.y
  }
  try { found = (e && bot.findBlocks({ point: new Vec3(c.x, c.y, c.z), matching: e.id, maxDistance: DIG_RADIUS, count: FIND_COUNT })) || [] } catch (_) { found = [] }
  const fx = Math.floor(bp.x)
  const fy = Math.floor(bp.y) // own feet column only
  const fz = Math.floor(bp.z)
  let best = null
  for (const p of found) {
    const k = `${p.x},${p.y},${p.z}`
    if (f.skip.has(k) || onSite(ctx.castle, p) || inTrench(ctx.castle, p)) continue
    if (p.x === fx && p.z === fz && p.y < fy) continue
    const d = Math.hypot(p.x - bp.x, p.y - bp.y, p.z - bp.z)
    if (best && d >= best.d) continue
    // Ground window + exposure + danger + break (R2 core-2): the shared
    // predicate, so the watchdog's live scan accepts the same blocks.
    // Anchored on the site (or the far candidate), never the live feet —
    // a pick made from inside our own quarry pit would ratchet the
    // window down a layer per pick.
    if (!acceptStone(bot, ctx, p, gy, stoneAt)) continue
    best = { x: p.x, y: p.y, z: p.z, k, d, waits: 0 }
  }
  return best
}

function siteCenter(st) {
  const { w, d } = blueprint.siteDimensions(st.rot | 0, st.blueprintVersion)
  return { x: st.site.x + Math.floor(w / 2), y: st.site.y, z: st.site.z + Math.floor(d / 2) }
}

// Mod guard box for the v2 mine (round-1 body-3): the onSite footprint
// with the same margin/below the onSite test uses (1 and 3) and the same
// top (16, blueprint onSite's FETCH_SITE_TOP). Null without a site — the
// mine then runs on the body leash alone.
function siteGuardBox(st) {
  try {
    if (!st || !st.site || typeof st.site.x !== 'number') return null
    const { w, d } = blueprint.siteDimensions(st.rot | 0, st.blueprintVersion)
    if (!(w > 0) || !(d > 0)) return null
    return {
      x0: st.site.x - 1, y0: st.site.y - 3, z0: st.site.z - 1,
      x1: st.site.x + w, y1: st.site.y + 16, z1: st.site.z + d,
    }
  } catch (_) { return null }
}

// Inside the guard box (floored cells, round-2 core-6)?
function insideGuard(guard, bp) {
  try {
    if (!guard || !bp) return false
    const x = Math.floor(bp.x), y = Math.floor(bp.y), z = Math.floor(bp.z)
    return x >= guard.x0 && x <= guard.x1 && y >= guard.y0 && y <= guard.y1 && z >= guard.z0 && z <= guard.z1
  } catch (_) { return false }
}

// Shortest horizontal push out of the box, one cell past the edge at body
// height (round-2 core-6: start the mine where the nearest stone is not a
// site cell).
function guardExit(guard, bp) {
  const dx0 = bp.x - guard.x0, dx1 = guard.x1 + 1 - bp.x
  const dz0 = bp.z - guard.z0, dz1 = guard.z1 + 1 - bp.z
  const m = Math.min(dx0, dx1, dz0, dz1)
  if (m === dx0) return { x: guard.x0 - 1, y: Math.floor(bp.y), z: Math.floor(bp.z) }
  if (m === dx1) return { x: guard.x1 + 1, y: Math.floor(bp.y), z: Math.floor(bp.z) }
  if (m === dz0) return { x: Math.floor(bp.x), y: Math.floor(bp.y), z: guard.z0 - 1 }
  return { x: Math.floor(bp.x), y: Math.floor(bp.y), z: guard.z1 + 1 }
}

// Trench side s (0..3) on ring (0..1, vmzq.31): origin column just
// outside the footprint near a corner (the entrance sits mid-side, never
// in front of it), the outward direction and the width axis. Ring 1 works
// the same edge from its opposite lateral end — fresh ground at the same
// outward gap (shifting the origin outward would re-dig the ring-0 line:
// the trench runs outward, so the lines would overlap 36 of 40 columns).
function quarrySide(st, s, ring = 0) {
  const { w, d } = blueprint.siteDimensions(st.rot | 0, st.blueprintVersion)
  const { x: sx, z: sz } = st.site
  const g = QUARRY_GAP + 1
  const r1 = (ring | 0) === 1
  if (s === 0) return { x: sx - g, z: r1 ? sz + d - 2 - QUARRY_W : sz + 2, dx: -1, dz: 0, lx: 0, lz: 1 }
  if (s === 1) return { x: sx + w - 1 + g, z: r1 ? sz + 2 : sz + d - 2 - QUARRY_W, dx: 1, dz: 0, lx: 0, lz: 1 }
  if (s === 2) return { x: r1 ? sx + 2 : sx + w - 2 - QUARRY_W, z: sz - g, dx: 0, dz: -1, lx: 1, lz: 0 }
  return { x: r1 ? sx + w - 2 - QUARRY_W : sx + 2, z: sz + d - 1 + g, dx: 0, dz: 1, lx: 1, lz: 0 }
}

function stairFloor(base, i, depth) {
  return base - 1 - Math.min(i, depth - 1)
}

function trenchFloor(st, i, base) {
  return (base == null ? st.site.y : base) - 1 - Math.min(i, QUARRY_DEPTH - 1)
}

function pitFloor(base, i) {
  return stairFloor(base, i, PIT_DEPTH)
}

// A trench cell or the block a trench stance stands on (revmux 01): the
// exposed-stone pick must never undermine our own staircase. The band runs
// QUARRY_ADAPT below the unadapted floor: an adapted trench digs there.
// Both rings (vmzq.31): the opposite-end staircase is ours too.
function inTrench(st, p) {
  for (let ring = 0; ring < QUARRY_RINGS; ring++) {
  for (let s = 0; s < 4; s++) {
    const o = quarrySide(st, s, ring)
    const i = (p.x - o.x) * o.dx + (p.z - o.z) * o.dz
    const l = (p.x - o.x) * o.lx + (p.z - o.z) * o.lz
    if (i >= 0 && i < QUARRY_LEN && l >= 0 && l < QUARRY_W && p.y >= trenchFloor(st, i) - 1 - QUARRY_ADAPT && p.y <= st.site.y + QUARRY_TOP) return true
  }
  }
  // Latched pit frames (vmzq.46) are ours too — scan-dead ones included,
  // their dug cells stay ours (probe-dead spots latch nothing).
  try {
    const pits = Array.isArray(st.quarryPits) ? st.quarryPits : []
    for (const e of pits) {
      if (!e || !Number.isInteger(e.base) || typeof e.x !== 'number' || typeof e.z !== 'number') continue
      const dx = e.dx | 0
      const dz = e.dz | 0
      const lx = Number.isInteger(e.lx) ? e.lx : (dx === 0 ? 1 : 0)
      const lz = Number.isInteger(e.lz) ? e.lz : (dz === 0 ? 1 : 0)
      const i = (p.x - e.x) * dx + (p.z - e.z) * dz
      const l = (p.x - e.x) * lx + (p.z - e.z) * lz
      if (i >= 0 && i < PIT_LEN && l >= 0 && l < QUARRY_W && p.y >= pitFloor(e.base, i) - 1 - QUARRY_ADAPT && p.y <= st.site.y + QUARRY_TOP) return true
    }
  } catch (_) { /* pits best-effort */ }
  return false
}

// The staircase cell scan for the quarry-down pits (vmzq.46): columns run
// outward from o over len, the floor stepping down 1 per column to depth
// below base, cut top-down (dirt included). The ring trenches intentionally
// keep master's inline scan verbatim (normal-pad parity by construction);
// only pits call this helper. Returns { cell } for the next cell to dig
// (the trench {quarry, stance} shape — stance is the previous column's
// floor, same lane, so the bot walks down the staircase and every dug cell
// sits within pickup reach of a stance), { dead, why } when liquid, a hole
// or a protected place kills the line mid-way, or { dead: false } when it
// is dug out. A protected block type (a path, a ruin block) is stepped
// around, never dug.
function scanStairCells(bot, ctx, f, o, len, depth, base) {
  const at = (x, y, z) => { try { return bot.blockAt(new Vec3(x, y, z)) } catch (_) { return null } }
  const wet = (b) => !!b && LIQUID.has(b.name)
  const open = (b) => !!b && (AIRISH.has(b.name) || b.boundingBox === 'empty') && !wet(b)
  for (let i = 0; i < len; i++) {
    const floor = stairFloor(base, i, depth)
    for (let l = 0; l < QUARRY_W; l++) {
      const cx = o.x + o.dx * i + o.lx * l
      const cz = o.z + o.dz * i + o.lz * l
      const below = at(cx, floor - 1, cz)
      if (!below || open(below) || wet(below)) {
        return { dead: true, why: `${below ? (wet(below) ? 'water' : 'hole') : 'void'} under column ${i} floor at ${cx} ${floor - 1} ${cz}` }
      }
    }
    for (let y = base + QUARRY_TOP; y >= floor; y--) {
      for (let l = 0; l < QUARRY_W; l++) {
        const x = o.x + o.dx * i + o.lx * l
        const z = o.z + o.dz * i + o.lz * l
        const k = `${x},${y},${z}`
        const b = at(x, y, z)
        if (!b || wet(b)) return { dead: true, why: `${b ? 'wet' : 'void'} at ${k}` }
        if (open(b) || f.skip.has(k)) continue
        if (EXPOSE.concat([[0, -1, 0]]).some(([ex, ey, ez]) => wet(at(x + ex, y + ey, z + ez)))) {
          return { dead: true, why: `liquid by ${k}` }
        }
        if (protectedReason(bot, b, ctx)) {
          // Where (house apron, castle) kills the line; what (a path,
          // a ruin block) is stepped around.
          if (protectedReason(bot, { name: 'dirt', position: b.position }, ctx)) {
            return { dead: true, why: `protected place at ${k}` }
          }
          f.skip.add(k)
          continue
        }
        // Stance (idkcraft-vmzq.25): the previous column's floor, same
        // lane, reached by walking down the staircase. A walk to the cell
        // itself (ground level, the bot deep in the trench) pillared up
        // out of the trench and the quarry re-dug the pillar (rig: 161
        // digs for 115 cells). Column i's drops rest on its floor, the
        // stance the next column is dug from. A cell out of eye reach
        // from its stance (a hill top or a leaf over a deep column) stays
        // standing: walking up to it pillared the same way (rig). A stance
        // that is not open body room (a stepped-around path, a skipped
        // cell, column 0's outside cell) is never walked into (revmux 01:
        // range 0 would dig it): that cell walks to itself as before.
        let stance = { x: o.x + o.dx * (i - 1) + o.lx * l, y: i === 0 ? base : stairFloor(base, i - 1, depth), z: o.z + o.dz * (i - 1) + o.lz * l }
        if (!open(at(stance.x, stance.y, stance.z)) || !open(at(stance.x, stance.y + 1, stance.z))) stance = null
        else if (Math.hypot(stance.x - x, stance.y + EYE - (y + 0.5), stance.z - z) > DIG_REACH + 0.5) { f.skip.add(k); continue }
        return { cell: { x, y, z, k, d: 0, waits: 0, quarry: true, tries: 0, stance } }
      }
    }
  }
  return { dead: false, why: '' } // dug out
}

// Pit spots (vmzq.46): mid-side laterals (between the ring-0/ring-1 trench
// lanes) plus diagonal-corner origins, at every PIT_GAPS distance outside
// the footprint, nearest first. Every spot band stays OFF the 8 trench
// lanes (revmux 01 major: the first layout sat all 40 spots on the dead
// lanes' columns and re-dug them deeper instead of finding dry ground).
// The room runs outward like a trench; the stairs bottom out PIT_DEPTH
// down within PIT_DEPTH of the origin, so the pit digs down in place.
function pitSpots(st) {
  const { w, d } = blueprint.siteDimensions(st.rot | 0, st.blueprintVersion)
  const { x: sx, z: sz } = st.site
  const midX = sx + Math.floor((w - QUARRY_W) / 2) // N/S sides run along z
  const midZ = sz + Math.floor((d - QUARRY_W) / 2) // W/E sides run along x
  // The gate side never pits (revmux 02 major): a mid-side pit straight out
  // from the door digs up the approach. Entrance faces -z/+x/+z/-x for rot
  // 0/1/2/3 (the rotatePlan convention); corners stay (off the axis).
  const gate = [[0, -1], [1, 0], [0, 1], [-1, 0]][((st.rot | 0) % 4 + 4) % 4]
  const spots = []
  for (const g of PIT_GAPS) {
    for (const m of [
      { x: sx - g, z: midZ, dx: -1, dz: 0, lx: 0, lz: 1 }, // west mid-side
      { x: sx + w - 1 + g, z: midZ, dx: 1, dz: 0, lx: 0, lz: 1 }, // east mid-side
      { x: midX, z: sz - g, dx: 0, dz: -1, lx: 1, lz: 0 }, // north mid-side
      { x: midX, z: sz + d - 1 + g, dx: 0, dz: 1, lx: 1, lz: 0 }, // south mid-side
    ]) {
      if (m.dx === gate[0] && m.dz === gate[1]) continue
      spots.push(m)
    }
    spots.push(
      { x: sx - g, z: sz - g, dx: -1, dz: 0, lx: 0, lz: 1 }, // NW corner, run west
      { x: sx + w - 1 + g, z: sz - g, dx: 1, dz: 0, lx: 0, lz: 1 }, // NE corner, run east
      { x: sx - g, z: sz + d - 1 + g, dx: -1, dz: 0, lx: 0, lz: 1 }, // SW corner, run west
      { x: sx + w - 1 + g, z: sz + d - 1 + g, dx: 1, dz: 0, lx: 0, lz: 1 }, // SE corner, run east
    )
  }
  return spots
}

function pitKey(o) {
  return `${o.x},${o.z},${o.dx},${o.dz}`
}

// The next pit cell to dig (vmzq.46): the first live frame in spot order —
// a latched frame resumes, a fresh spot is probed (the trench probe: real
// ground, solid under, dry head) and latched. A spot whose scan finds
// liquid, a hole or a protected place is abandoned for the leg and
// persisted dead on the castle (its ground truth does not change);
// probe-dead spots stay unlatched and re-probe next leg (trench semantics —
// their ground was never dug, so no frame can walk). Dug-out pits re-scan
// cheap and are never persisted dead: a leg that could not walk to its
// cells reads dug out without being empty. Fresh spots never probe our own
// dug ground (revmux 01 major: a probe on a dug trench/pit floor latches
// low and the seam step out is 2 high) — the spot layout already avoids
// the trench lanes; the inTrench skip covers earlier pits' bands.
function pickPit(bot, ctx, f) {
  const st = ctx.castle
  const p = f.pit || (f.pit = { dead: [] })
  const at = (x, y, z) => { try { return bot.blockAt(new Vec3(x, y, z)) } catch (_) { return null } }
  const wet = (b) => !!b && LIQUID.has(b.name)
  const open = (b) => !!b && (AIRISH.has(b.name) || b.boundingBox === 'empty') && !wet(b)
  let stored = null
  try {
    stored = Array.isArray(st.quarryPits) ? st.quarryPits : (st.quarryPits = [])
  } catch (_) { stored = [] }
  const byKey = new Map()
  for (const e of stored) {
    if (e && typeof e.x === 'number' && typeof e.z === 'number') byKey.set(`${e.x},${e.z},${e.dx},${e.dz}`, e)
  }
  for (const o of pitSpots(st)) {
    const key = pitKey(o)
    if (p.dead.includes(key)) continue
    const entry = byKey.get(key)
    if (entry && entry.dead) continue // a drowned/holed pit stays abandoned
    // Outside the footprint and the door path (both lie inside it).
    if (blueprint.inFootprint(st, { x: o.x, y: st.site.y, z: o.z })) continue
    if (blueprint.inFootprint(st, { x: o.x + o.dx * (PIT_LEN - 1), y: st.site.y, z: o.z + o.dz * (PIT_LEN - 1) })) continue
    let frame = entry && Number.isInteger(entry.base) ? entry : null
    if (!frame) {
      if (inTrench(st, { x: o.x, y: st.site.y, z: o.z }) ||
          inTrench(st, { x: o.x + o.dx * (PIT_LEN - 1), y: st.site.y, z: o.z + o.dz * (PIT_LEN - 1) })) {
        p.dead.push(key)
        try { console.log(`castlefetch pit spot ${o.x} ${o.z} skipped (dug ground)`) } catch (_) { /* log best-eff */ }
        continue
      }
      let why = null
      let whyAt = null
      let liquid = false
      let g = null
      for (let y = st.site.y + QUARRY_TOP; y >= st.site.y - QUARRY_ADAPT; y--) {
        const b = at(o.x, y, o.z)
        if (!b) { why = 'void'; whyAt = [o.x, y, o.z]; break }
        if (wet(b)) { liquid = true; continue }
        if (!open(b)) { g = y; break }
      }
      if (!why && g == null) { why = liquid ? 'wet' : 'hole'; whyAt = [o.x, st.site.y, o.z] }
      if (!why) {
        const under = at(o.x, g - 1, o.z)
        const head = at(o.x, g + 1, o.z)
        if (!under || open(under)) { why = 'hole'; whyAt = [o.x, g - 1, o.z] }
        else if (wet(under) || wet(head)) { why = 'wet'; whyAt = [o.x, g, o.z] }
      }
      if (why) {
        p.dead.push(key)
        try { console.log(`castlefetch pit spot ${o.x} ${o.z} unusable (${why} at ${whyAt[0]} ${whyAt[1]} ${whyAt[2]})`) } catch (_) { /* log best-eff */ }
        continue
      }
      frame = { x: o.x, z: o.z, dx: o.dx, dz: o.dz, lx: o.lx, lz: o.lz, base: g + 1, dead: false }
      if (stored.length < PIT_MAX) {
        try { stored.push(frame) } catch (_) { /* latch best-effort */ }
        byKey.set(key, frame)
      }
      try { console.log(`castlefetch pit live at ${o.x} ${frame.base} ${o.z}`) } catch (_) { /* log best-eff */ }
    }
    const r = scanStairCells(bot, ctx, f, o, PIT_LEN, PIT_DEPTH, frame.base)
    if (r.cell) {
      r.cell.pit = true
      return r.cell
    }
    p.dead.push(key)
    if (r.dead) {
      try { frame.dead = true } catch (_) { /* latch best-effort */ }
    }
    try { console.log(`castlefetch pit at ${o.x} ${frame.base} ${o.z} ${r.dead ? `abandoned (${r.why})` : 'dug out'}`) } catch (_) { /* log best-eff */ }
  }
  return null
}

// The next trench cell to dig: the first solid cell in dig order on the
// first live side. A side dies for this leg on liquid at or by a cell, a
// hole under the floor or a protected place (house apron, castle) — the
// next side takes over; a protected block type (a path) is stepped
// around. Stance rules are checked at dig time (they depend on where we
// stand). Recomputed from the world every pick and per leg (revmux 01: no
// session latch) — a restart or a retry resumes the same trench.
// Flat sides 0..7 across QUARRY_RINGS (vmzq.31): ring 1 (4..7) is only
// reached when every ring-0 side is dead or dug, nearest stone first.
function pickQuarry(bot, ctx, f) {
  const st = ctx.castle
  const q = f.quarry || (f.quarry = { dead: [], level: [null, null, null, null, null, null, null, null], said: [] })
  const at = (x, y, z) => { try { return bot.blockAt(new Vec3(x, y, z)) } catch (_) { return null } }
  const wet = (b) => !!b && LIQUID.has(b.name)
  const open = (b) => !!b && (AIRISH.has(b.name) || b.boundingBox === 'empty') && !wet(b)
  for (let rs = 0; rs < QUARRY_RINGS * 4; rs++) {
    if (q.dead.includes(rs)) continue
    const ring = rs >> 2
    const s = rs & 3
    const tag = ring === 0 ? `side ${s}` : `side ${s} ring 1`
    const o = quarrySide(st, s, ring)
    // Adaptive start (idkcraft-vmzq.20): the ring assumes flat ground at
    // site level, but a pad edge or a dip hangs the origin in air — rig
    // cycle 7 died all four sides this way and failed no-stone twice.
    // Scan down for real ground and start the staircase there; liquid in
    // the working band, or no ground in range, still kills the side.
    let base = null
    let why = null
    let whyAt = null
    let probed = false
    if (Array.isArray(st.quarryBase) && Number.isInteger(st.quarryBase[rs])) {
      base = st.quarryBase[rs] // latched: resume the same frame, no re-probe
    } else {
      probed = true
      let liquid = false
      let g = null
      for (let y = st.site.y + QUARRY_TOP; y >= st.site.y - QUARRY_ADAPT; y--) {
        const b = at(o.x, y, o.z)
        if (!b) { why = 'void'; whyAt = [o.x, y, o.z]; break }
        if (wet(b)) { liquid = true; continue }
        if (!open(b)) { g = y; break }
      }
      if (!why && g == null) { why = liquid ? 'wet' : 'hole'; whyAt = [o.x, st.site.y, o.z] }
      if (!why) {
        const under = at(o.x, g - 1, o.z)
        const head = at(o.x, g + 1, o.z)
        if (!under || open(under)) { why = 'hole'; whyAt = [o.x, g - 1, o.z] }
        else if (wet(under) || wet(head)) { why = 'wet'; whyAt = [o.x, g, o.z] }
        else base = g + 1
      }
    }
    if (why) {
      q.dead.push(rs)
      try { console.log(`castlefetch quarry ${tag} unusable (${why} at ${whyAt[0]} ${whyAt[1]} ${whyAt[2]})`) } catch (_) { /* log best-eff */ }
      continue
    }
    // Latched, never re-probed: our own dug floors read as ground, so a
    // fresh probe every leg would walk the staircase down one level per
    // leg and eat the stance floors (castle-fetch trench regression). The
    // latch rides the persisted castle (memory.js), so a restart resumes
    // the same frame; a side that dies stays unlatched and re-probes next
    // leg (a transient void revives). Pre-latch trenches (dug before this
    // change) shift one level on first probe, then hold.
    if (probed) {
      // Grows a pre-ring latch (4 entries) to 8 in place (vmzq.31): ring-0
      // frames keep their indices, ring 1 latches at 4..7.
      if (!Array.isArray(st.quarryBase)) {
        try { st.quarryBase = [null, null, null, null, null, null, null, null] } catch (_) { /* latch best-effort */ }
      } else {
        try { while (st.quarryBase.length < QUARRY_RINGS * 4) st.quarryBase.push(null) } catch (_) { /* grow best-effort */ }
      }
      if (Array.isArray(st.quarryBase) && st.quarryBase.length >= QUARRY_RINGS * 4) st.quarryBase[rs] = base
    }
    if (!Array.isArray(q.level)) q.level = [null, null, null, null, null, null, null, null]
    q.level[rs] = base
    if (probed && Array.isArray(q.said) && !q.said.includes(rs)) {
      q.said.push(rs)
      try { console.log(`castlefetch quarry ${tag} live (level ${base})`) } catch (_) { /* log best-eff */ }
    }
    let dead = false
    let deadWhy = ''
    for (let i = 0; i < QUARRY_LEN && !dead; i++) {
      const floor = trenchFloor(st, i, base)
      for (let l = 0; l < QUARRY_W && !dead; l++) {
        const below = at(o.x + o.dx * i + o.lx * l, floor - 1, o.z + o.dz * i + o.lz * l)
        if (!below || open(below) || wet(below)) { dead = true; deadWhy = `${below ? (wet(below) ? 'water' : 'hole') : 'void'} under column ${i} floor at ${o.x + o.dx * i + o.lx * l} ${floor - 1} ${o.z + o.dz * i + o.lz * l}` }
      }
      for (let y = base + QUARRY_TOP; y >= floor && !dead; y--) {
        for (let l = 0; l < QUARRY_W && !dead; l++) {
          const x = o.x + o.dx * i + o.lx * l
          const z = o.z + o.dz * i + o.lz * l
          const k = `${x},${y},${z}`
          const b = at(x, y, z)
          if (!b || wet(b)) { dead = true; deadWhy = `${b ? 'wet' : 'void'} at ${k}`; break }
          if (open(b) || f.skip.has(k)) continue
          if (EXPOSE.concat([[0, -1, 0]]).some(([ex, ey, ez]) => wet(at(x + ex, y + ey, z + ez)))) { dead = true; deadWhy = `liquid by ${k}`; break }
          if (protectedReason(bot, b, ctx)) {
            // Where (house apron, castle) kills the side; what (a path,
            // a ruin block) is stepped around.
            if (protectedReason(bot, { name: 'dirt', position: b.position }, ctx)) { dead = true; deadWhy = `protected place at ${k}`; break }
            f.skip.add(k)
            continue
          }
          // Stance (idkcraft-vmzq.25): the previous column's floor, same
          // lane, reached by walking down the staircase. A walk to the cell
          // itself (ground level, the bot deep in the trench) pillared up
          // out of the trench and the quarry re-dug the pillar (rig: 161
          // digs for 115 cells). Column i's drops rest on its floor, the
          // stance the next column is dug from. A cell out of eye reach
          // from its stance (a hill top or a leaf over a deep column) stays
          // standing: walking up to it pillared the same way (rig). A stance
          // that is not open body room (a stepped-around path, a skipped
          // cell, column 0's outside cell) is never walked into (revmux 01:
          // range 0 would dig it): that cell walks to itself as before.
          let stance = { x: o.x + o.dx * (i - 1) + o.lx * l, y: i === 0 ? base : trenchFloor(st, i - 1, base), z: o.z + o.dz * (i - 1) + o.lz * l }
          if (!open(at(stance.x, stance.y, stance.z)) || !open(at(stance.x, stance.y + 1, stance.z))) stance = null
          else if (Math.hypot(stance.x - x, stance.y + EYE - (y + 0.5), stance.z - z) > DIG_REACH + 0.5) { f.skip.add(k); continue }
          return { x, y, z, k, d: 0, waits: 0, quarry: true, tries: 0, stance }
        }
      }
    }
    q.dead.push(rs) // dug out or unusable mid-trench
    try { console.log(`castlefetch quarry ${tag} ${dead ? `unusable (mid-trench: ${deadWhy})` : 'dug out'}`) } catch (_) { /* log best-eff */ }
  }
  return null
}

// Source 3a: dig stone near the bot (equip digTick shape: walk into
// pickup reach, pickaxe in hand, one dig at a time with a deadline).
// Pack-full yield (g0z.26): roomForDrop lives in stockpile (oqul.12).
const roomForDrop = (bot, ctx) => stockpileMod.roomForDrop(bot, ctx)
function digTick(bot, ctx, f, d) {
  const bp = bodyPos(bot)
  if (!bp) { spend(f, 'other'); return }
  if (!hasPickaxe(bot)) { spend(f, 'other'); finish(bot, ctx, 'done'); return } // equip rearms first
  if (!roomForDrop(bot, ctx)) { spend(f, 'other'); finish(bot, ctx, 'failed:castlefetch-pack-full'); return }
  // Mid-leg pick upgrade (idkcraft-vmzq.20): the first fetch digs on a
  // wooden pick (~1.4x slower on stone) and no equip step ever interjects
  // while castle legs are feasible, so upgrade in place once the pack
  // funds it (craftany chains sticks + a table as needed). One attempt
  // per leg: a short pack stays short for a stone leg.
  if (!f.pickUpLogged) {
    let due = false
    try { due = require('./equip').stoneUpgradeDue(bot) } catch (_) { due = false }
    if (due && !f.pickUpArmed) {
      f.pickUpArmed = true
      try { console.log('castlefetch stone: pick upgrade started (wood->stone)') } catch (_) { /* log best-effort */ }
    }
    if (due) {
      let r = null
      try { r = deps.craftItem(bot, ctx, ['stone_pickaxe'], 1) } catch (_) { r = { done: false } }
      if (r === 'running') { spend(f, 'other'); return } // crafting across ticks; the landing is seen below
      f.pickUpLogged = true
      try { console.log(`castlefetch stone: pick upgrade ${r && r.done ? 'done' : 'failed'}, digging on`) } catch (_) { /* log best-effort */ }
      if (r && r.done) { spend(f, 'other'); return }
    } else if (f.pickUpArmed) {
      // The craft landed between ticks (async): due flips false on the
      // stone pick before any call returns terminal, so the started line
      // would dangle without this (rig: stone in hand, no line).
      let stone = false
      try { stone = countItems(bot, (n) => n === 'stone_pickaxe') > 0 } catch (_) { stone = false }
      if (stone) {
        f.pickUpLogged = true
        try { console.log('castlefetch stone: pick upgrade done, digging on') } catch (_) { /* log best-effort */ }
      }
    }
  }
  // v2 Baritone body (idkcraft-neuc.53): one MineProcess does the whole
  // stone leg — Baritone scans, paths, digs and walks over the drops
  // until the batch is on hand. The guards and the pick upgrade above
  // still run; the v1 target picking, walks and per-block digs below are
  // unreached on v2. mine-stall keeps the 'failed:castlefetch-dig-stall'
  // reason string (the goal watchdog and metrics key on it).
  if (typeof bot.mine === 'function') {
    // Every leg mines at most one layable batch (round-2 core-5, the
    // vmzq.20 shape): a none/some leg must not run the whole shortfall
    // while the castle could lay, and the LEG_MAX_MS yield never fires
    // mid-mine.
    const raw = (d && typeof d.short === 'number' && d.short > 0) ? d.short : castleMod.BATCH
    const need = Math.min(raw, castleMod.BATCH)
    if (ctx.castleFetchInFlight) return
    const st0 = ctx.castle
    const forbid = (pos) => {
      try { return !!(st0 && st0.site && onSite(st0, pos)) } catch (_) { return false }
    }
    // Cell-level castle guard (round-1 body-3): the body leash cannot stop
    // a break made from reach outside the site, so the mod snapshots the
    // site box's stone cells at begin and stops on the first break inside.
    // Top mirrors blueprint onSite's FETCH_SITE_TOP (bot/src/castle.js).
    const guard = siteGuardBox(st0)
    // Start outside the box (round-2 core-6): Baritone picks the nearest
    // stone, which from inside is a site cell — one break, one failed leg,
    // every leg. Walk out first; a wedged walk mines anyway (trips end it
    // loudly and the hold parks the leg).
    if (guard && insideGuard(guard, bp)) {
      // Latched per leg: recomputing each tick could flip the exit side as
      // the body moves and jitter the walk. No in-flight flags on walk
      // ticks — the next tick must reach digTick again, not the early
      // return above.
      const exit = f.guardExit || (f.guardExit = guardExit(guard, bp))
      walkTo(bot, ctx, `castlefetch-guard:${exit.x},${exit.z}`, exit, 0)
      spend(f, 'walk')
      if (!stalled(f.guardWalk || (f.guardWalk = {}), 0, APPROACH_WAITS)) return
    }
    // Quarry-stance arming (neuc.53 rig evidence: unvetted walk-out exits
    // arm onto fringe cache and churn with zero gains, while vetted trench
    // stances mine): take the next v1 quarry cell and walk to its stance
    // first — dry, exposed, reachable, stance-safe by construction. A
    // dead quarry (null) arms in place; the trip and the timer bound it.
    // Pick on warm ground only (neuc.53 rig evidence: the picker reads
    // our world, and a cold cache blinds it the same way it blinds the
    // mine — every side reads void and the quarry looks dead). Bounded:
    // a cache that never warms arms in place after the wait, and the
    // trip/timer bound that leg like before.
    if (!cacheReady(bot, bp, DIG_RADIUS)) {
      if (f.qWait0 == null) f.qWait0 = Date.now()
      if (Date.now() - f.qWait0 < QWAIT_MS) { spend(f, 'other'); return }
    }
    if (!f.qTarget) {
      try { f.qTarget = pickQuarry(bot, ctx, f) } catch (_) { f.qTarget = null }
    }
    const qt = f.qTarget
    if (qt && qt.stance) {
      const sd = Math.hypot(bp.x - (qt.stance.x + 0.5), bp.y - qt.stance.y, bp.z - (qt.stance.z + 0.5))
      if (sd > 1.5) {
        walkTo(bot, ctx, `castlefetch-qstance:${qt.stance.x},${qt.stance.y},${qt.stance.z}`, qt.stance, 0)
        spend(f, 'walk')
        if (!stalled(qt, sd, APPROACH_WAITS)) return
        try { (f.skip || (f.skip = new Set())).add(qt.k) } catch (_) { /* skip best-effort */ }
        f.qTarget = null
        f.skips = (f.skips | 0) + 1
        if (f.skips >= SKIPS_TO_FAIL) { finish(bot, ctx, 'failed:castlefetch-unreachable'); return }
        return
      }
      // Stance-anchored arm wait (neuc.53 rig evidence: a relocated or
      // fringe stance arms onto a cold cache and churns with zero gains
      // while the blacklist grows — the pick vetted stale reads, and the
      // leg-level pre-pick budget is long spent by re-arm time). Wait,
      // bounded per stance, for the stance area to read warm; a cache
      // that never warms arms anyway and the trip/timer bound that leg.
      const skey = `${qt.stance.x},${qt.stance.y},${qt.stance.z}`
      if (!cacheReady(bot, qt.stance, QSTANCE_RADIUS)) {
        if (f.qStanceFor !== skey) { f.qStanceFor = skey; f.qStance0 = Date.now() }
        if (Date.now() - f.qStance0 < QSTANCE_MS) { spend(f, 'other'); return }
        try { console.log(`castlefetch v2 stance cache cold at ${skey}, arming (${QSTANCE_MS}ms waited)`) } catch (_) { /* log best-effort */ }
      }
      // Cell rules at arm time (v1 dig-time shape): no mining a trap,
      // gravity, submerged or protected cell.
      let cell = null
      try { cell = bot.blockAt(new Vec3(qt.x, qt.y, qt.z)) } catch (_) { cell = null }
      const deny = denyReason(bot, cell, ctx)
      if (deny) {
        logDeny(cell, deny)
        try { (f.skip || (f.skip = new Set())).add(qt.k) } catch (_) { /* skip best-effort */ }
        f.qTarget = null
        spend(f, 'other')
        return
      }
    }
    ctx.castleFetchInFlight = true
    ctx.castleFetchFlight = 'dig' // in-flight ticks keep bucketing as dig
    ctx.castleFetchMine = true // a bridge mine owns the tick (not a v1 flight): pack-full can cancel it below
    spend(f, 'dig')
    const gen = stepGen(ctx) // round-1 core-1: a late settle must not finish a step that is gone
    const settleMine = () => { ctx.castleFetchInFlight = false; ctx.castleFetchMine = false }
    const settled = () => isFinished(ctx.stepStatus) || stale(ctx, gen) || (ctx.step && ctx.step !== 'castlefetch')
    // A goal key while the mine owns the body (round-3 core-3): stopOnce
    // gates on lastGoalKey !== 'idle' before it ever reads the goal, so a
    // mine started from a parked tick would survive an owner stop.
    ctx.lastGoalKey = 'mine:castlefetch'
    // Relocation baseline (neuc.53 rig evidence: a warm spot depletes
    // after ~20 blocks): peak-vs-arm tells a depleted spot (re-arm at
    // the new stance) from a dead one (fail below). Pre-bleed peak, so
    // stairs legs that craft mid-mine still count their breaks.
    let armHave = 0
    try { armHave = cobble(bot) } catch (_) { /* pack unreadable: no reloc below */ }
    f.mineArmHave = armHave
    bot.mine(STONE_FAMILY, need, { radius: DIG_RADIUS, forbid, guard }).then(
      () => { settleMine(); if (!settled()) finish(bot, ctx, 'done') },
      (err) => {
        settleMine()
        if (settled()) return
        const m = err && err.message
        // mine-stopped settles quietly (round-2 core-2): a fight borrowing
        // the body keeps step/gen, and finish's clearGoal would kill its
        // chase — the next tick re-issues instead. unreachable stays for
        // the leash only.
        if (m === 'mine-stopped') return
        // The worked cell is spent either way (depleted or unworkable):
        // skip it so the next pick advances the quarry instead of
        // re-mining the same dead ground. A guard trip retires the stance
        // too (it invited a site break — re-arming would eat the next
        // site cell). Leash keeps its cell (the spot may be fine — the
        // body ranged too far, which re-anchoring would only repeat).
        const hadTarget = !!f.qTarget
        if ((m === 'mine-noPath' || m === 'mine-futile' || m === 'mine-stall' || m === 'mine-guard') && f.qTarget) {
          try { (f.skip || (f.skip = new Set())).add(f.qTarget.k) } catch (_) { /* skip best-effort */ }
          f.qTarget = null
        }
        // Relocation: a below-target end re-arms at the new stance
        // instead of failing the leg — a depleted productive spot AND a
        // spent vetted stance both deserve the next stance (fresh cache,
        // fresh lottery), while a blind in-place arm with zero gains
        // fails below (re-picking it would re-arm the same blind spot).
        // Bounded per leg; the last error finishes it. Leash and guard
        // stay terminal (re-anchoring would defeat the site guard).
        const peak = err && typeof err.mineHave === 'number' ? err.mineHave : 0
        const reloc = f.mineReloc | 0
        if ((m === 'mine-noPath' || m === 'mine-futile' || m === 'mine-stall') && (peak > (f.mineArmHave | 0) || hadTarget) && reloc < 3) {
          f.mineReloc = reloc + 1
          f.guardExit = null
          try { delete f.guardWalk } catch (_) { /* tracker best-effort */ }
          return
        }
        if (m === 'mine-noPath' || m === 'mine-futile') finish(bot, ctx, 'failed:castlefetch-no-stone')
        else if (m === 'mine-leash' || m === 'mine-guard') finish(bot, ctx, 'failed:castlefetch-unreachable')
        else finish(bot, ctx, 'failed:castlefetch-dig-stall')
      },
    )
    return
  }
  const st = ctx.castle
  const skip = f.skip || (f.skip = new Set())
  const stoneAt = (q) => {
    try { const b = bot.blockAt(new Vec3(q.x, q.y, q.z)); return b && b.name === 'stone' ? b : null } catch (_) { return null }
  }
  // Quarry cells are any solid block (the trench digs its dirt too).
  const targetAt = (q) => {
    if (!q.quarry) return stoneAt(q)
    try { const b = bot.blockAt(new Vec3(q.x, q.y, q.z)); return b && !AIRISH.has(b.name) && b.boundingBox !== 'empty' && !LIQUID.has(b.name) ? b : null } catch (_) { return null }
  }
  let t = f.target
  if (t && !targetAt(t)) t = f.target = null // dug (or gone): pick the next
  // neuc.51: a stone dug below the feet drops into its own hole, under the
  // pickup box (feet - 0.5; rig: 5 such digs after the pick upgrade, cobble
  // 0 -> 0, dig-stall). Step into the hole first; the pit's next cells are
  // then at feet level. A drop already in the pack (v1 often lands in the
  // hole on its own) or a hole the walk never closes in on skips the step.
  const pu = !t && f.pickup
  if (pu) {
    const hd = Math.hypot(bp.x - (pu.x + 0.5), bp.z - (pu.z + 0.5))
    const there = hd <= 1 && bp.y < pu.y + 0.75
    if (there || cobble(bot) > pu.have || stalled(pu, hd + Math.abs(bp.y - pu.y), PICKUP_WAITS)) f.pickup = null
    else {
      walkTo(bot, ctx, `castlefetch-pickup:${pu.x},${pu.y},${pu.z}`, pu, 0)
      spend(f, 'walk')
      return
    }
  }
  if (!t) {
    // Far from the castle: walk there first, the stone is searched there.
    // (.22) a castlefetch-far unlock walks to the known candidate instead
    // (the fetcher walks to the candidate). The candidate latches onto the
    // leg (finding 9, the f.quarry precedent): a window that expires — or
    // a first stone that lands — mid-walk must not turn the bot around; a
    // leg already past the bound finishes. finish() drops the latch with
    // the leg (fetch failed, pack full, nothing left).
    let c = siteCenter(st)
    let farCand = null
    try {
      const { goalUnlock } = require('../goal-unlock')
      farCand = goalUnlock(ctx, 'candidate')
    } catch (_) { farCand = null }
    if (farCand && typeof farCand.x === 'number' && typeof farCand.z === 'number') {
      f.farCandidate = { x: farCand.x, y: farCand.y, z: farCand.z }
      c = f.farCandidate
    } else if (f.farCandidate && typeof f.farCandidate.x === 'number' && typeof f.farCandidate.z === 'number') {
      c = f.farCandidate
    }
    const far = Math.hypot(bp.x - (c.x + 0.5), bp.z - (c.z + 0.5))
    // A leg already quarrying stays out: the trench runs past DIG_RADIUS
    // (revmux 02), and its own target walks have their own patience. Pit
    // rooms run out the same way (vmzq.46).
    if (far > DIG_RADIUS && !f.quarry && !f.pit) {
      // The castle chest is looked up again on arrival, once per leg
      // (revmux 01: a far leg's body-centred lookup found none).
      if (f.chestRelook == null) f.chestRelook = true
      walkTo(bot, ctx, `castlefetch-site:${c.x},${c.z}`, c, DIG_RADIUS / 2, far > 2 * DIG_RADIUS)
      if (stalled(f.siteWalk || (f.siteWalk = {}), far, APPROACH_WAITS)) finish(bot, ctx, 'failed:castlefetch-unreachable')
      spend(f, 'walk')
      return
    }
    f.siteWalk = null
    if (f.chestRelook) {
      f.chestRelook = false
      f.chestDone = false
      f.chest = null
      f.chestWalk = null
      spend(f, 'other')
      return // the chest source goes first next tick
    }
    t = pickStone(bot, ctx, f, bp, stoneAt)
    if (!t) {
      // A far leg whose candidate ground is dry ends here (finding 9): no
      // stone left around the candidate finishes the leg — starting the
      // site trench instead would walk the bot back to the dead ground the
      // window was bought to escape. An already-running trench keeps going.
      const farLatched = !!(f.farCandidate && typeof f.farCandidate.x === 'number')
      if (farLatched && !f.quarry) { finish(bot, ctx, 'failed:castlefetch-no-stone'); return }
      // No exposed stone by the site: quarry it, and ask the owner once
      // per site per session (owner 2026-10-02: the chest is the shortcut).
      const key = `${st.site.x},${st.site.y},${st.site.z}`
      if (ctx.castleStoneAsked !== key) {
        ctx.castleStoneAsked = key
        try { bot.chat(`no stone near the castle at ${st.site.x} ${st.site.z}: quarrying it; drop cobblestone into a chest on the castle site to speed it up`) } catch (_) { /* chat best-effort */ }
      }
      t = pickQuarry(bot, ctx, f)
      // vmzq.46 STARVED GATE: pickQuarry null means every side died or dug
      // out this leg (and no exposed stone was found above) — quarry down
      // instead. On a live pad pickQuarry always returns, so this never
      // runs and the trench path stays master-identical by construction.
      if (!t) t = pickPit(bot, ctx, f)
    }
    if (!t) { spend(f, 'other'); finish(bot, ctx, 'failed:castlefetch-no-stone'); return }
    f.target = t
  }
  const b = targetAt(t)
  const dist = Math.hypot(bp.x - (t.x + 0.5), bp.y - (t.y + 0.5), bp.z - (t.z + 0.5))
  // Every cell is dug from pickup reach — trench cells included. The old
  // trench exception (dig from 4, "the next stance steps over the drops")
  // never collected: the stance advances along the trench while the drops
  // stay behind, and ~2/3 of dug blocks never reached the pack (rig: 368
  // issues banked +113). Linger-by-construction: a stance within 2.5 of
  // every dug cell sits on the drops through the dig. A trench cell with a
  // stance (vmzq.25) is dug from the stance instead: eye reach, no climb.
  const s = t.stance
  const sd = s ? Math.hypot(bp.x - (s.x + 0.5), bp.y - s.y, bp.z - (s.z + 0.5)) : 0
  const reach = s
    ? sd <= 2 && Math.hypot(bp.x - (t.x + 0.5), bp.y + EYE - (t.y + 0.5), bp.z - (t.z + 0.5)) <= DIG_REACH + 0.5
    : dist <= PICKUP_REACH + 0.5
  if (!reach) {
    // The stance cell itself (range 0): a near-goal admits the cell one
    // lower, i.e. digging the floor's support (rig: side 3 went dead
    // mid-trench on range 1, carried the run on range 0).
    const range = s ? 0 : dist > DIG_REACH ? 2 : 1
    if (s) walkTo(bot, ctx, `castlefetch-stance:${s.x},${s.y},${s.z}`, s, range)
    else walkTo(bot, ctx, `castlefetch-dig:${t.k}:${range}`, t, range)
    if (stalled(t, s ? sd : dist, APPROACH_WAITS)) {
      skip.add(t.k)
      f.target = null
      if (++f.skips >= SKIPS_TO_FAIL) finish(bot, ctx, 'failed:castlefetch-unreachable')
    }
    spend(f, 'walk')
    return
  }
  // Stance rules (below-feet trap, gravity, submerged, protection) at dig
  // time, not only at pick: the walk may end on or above the target.
  const deny = denyReason(bot, b, ctx)
  if (deny) {
    logDeny(b, deny)
    skip.add(t.k)
    f.target = null
    spend(f, 'other')
    return
  }
  // Airborne digs take 5x (mineflayer digTime; rig: the first dig after
  // each stance walk ran 3.75 s on 0.75 s dirt): let the feet land first,
  // a bounded wait so a body that never reads grounded still digs.
  if (bot.entity && bot.entity.onGround === false && (t.air = (t.air | 0) + 1) <= AIR_WAITS) { spend(f, 'other'); return }
  if (t.quarry) {
    // Drops land at the digging stance (pickup reach), so no
    // cobble-gain strike; a cell that survives its digs is skipped instead.
    if (++t.tries > QUARRY_TRIES) {
      spend(f, 'other')
      try { console.log(`castlefetch stone: cell refused ${QUARRY_TRIES}x at ${t.x} ${t.y} ${t.z}, skipping`) } catch (_) { /* log best-effort */ }
      skip.add(t.k); f.target = null; return
    }
    // Drops never reaching the pack (revmux 01): a trench's worth of stone
    // dug with no cobble gained ends the leg instead of digging all day.
    // Last-seen baseline, not a high-water mark (neuc.51): a stairs leg
    // crafts 6 cobble away at every threshold, so the count never beat
    // its old peak and every leg died dig-stall near its 16th stair.
    const have = cobble(bot)
    if (f.qCobble == null || have > f.qCobble) f.qNoGain = 0
    else if (b.name === 'stone' && ++f.qNoGain > QUARRY_NOGAIN) { spend(f, 'other'); finish(bot, ctx, 'failed:castlefetch-dig-stall'); return }
    f.qCobble = have
  } else {
    const have = cobble(bot)
    if (f.lastCobble != null && have <= f.lastCobble) {
      if (++f.noGain >= NOGAIN_STRIKES) { spend(f, 'other'); finish(bot, ctx, 'failed:castlefetch-dig-stall'); return }
    } else f.noGain = 0
    f.lastCobble = have
  }
  spend(f, 'dig')
  try { f.starts = (f.starts | 0) + 1 } catch (_) { /* counter best-effort */ }
  const below = !t.quarry && !s && t.y < Math.floor(bp.y) ? { x: t.x, y: t.y, z: t.z, have: cobble(bot) } : null
  ctx.castleFetchFlight = 'dig' // in-flight ticks keep bucketing as dig below
  flight(ctx, async () => {
    // Trench dirt by hand (rig: the pick wore out on the sod before the
    // batch was in); rock with the pickaxe.
    if (ROCK.test(b.name)) {
      const pick = (bot.inventory.items() || []).find((i) => i && typeof i.name === 'string' && i.name.endsWith('_pickaxe'))
      if (pick) await bot.equip(pick, 'hand')
    } else if (bot.heldItem && /_pickaxe$/.test(bot.heldItem.name)) await bot.unequip('hand')
    await bot.dig(b, true) // instant look, as the pathfinder's own digs: a smooth turn added ~0.25 s per dig
  }, DIG_TIMEOUT_MS, () => {
    // A hung dig skips the block (no retry this leg); the no-gain strike
    // counts it. Loud: a 10 s hang per cell is the rig's prime suspect
    // for the quarry's missing ticks (cycle 11: ~350 standing ticks).
    try { console.log(`castlefetch stone: dig timed out at ${t.x} ${t.y} ${t.z}, skipping`) } catch (_) { /* log best-effort */ }
    skip.add(t.k)
    if (f.target === t) f.target = null
  }, () => { try { f.dug = (f.dug | 0) + 1; if (below) f.pickup = below } catch (_) { /* counter best-effort */ } })
}

function castlefetch(bot, ctx, target, state) {
  // A dig (or chest op) spans ticks: the issue tick bucketed above, the
  // continuation ticks here, so dig reads as duration, not starts.
  if (ctx.castleFetchInFlight) {
    if (ctx.castleFetch) spend(ctx.castleFetch, ctx.castleFetchFlight === 'dig' ? 'dig' : 'other')
    // Pack filled mid-mine (round-1 core-5): roomForDrop only gated the
    // start, and a full pack loses every further drop into a dig-stall.
    // Cancel the bridge mine and bank instead; the v1 flight below owns no
    // cancellable handle, so this only runs for the mine marker above.
    if (ctx.castleFetchMine && !roomForDrop(bot, ctx)) {
      ctx.castleFetchMine = false
      ctx.castleFetchInFlight = false
      try { if (bot && typeof bot.cancelMine === 'function') bot.cancelMine(new Error('mine-stopped')) } catch (_) { /* cancel best-effort */ }
      finish(bot, ctx, 'failed:castlefetch-pack-full')
      return
    }
    return
  }
  // neuc.50 rig: a craft op in flight (craftany/gear) owns the tick too.
  // Mid-craft the grid holds the cobble, so stairsCobbleShort / the stone
  // pick's stoneUpgradeDue flip, digTick walks the body off and the server
  // closes the table window (stale window: gear-cobblestone_stairs,
  // gear-stone_pickaxe).
  if (ctx.gearInFlight) {
    if (ctx.castleFetch) spend(ctx.castleFetch, 'other')
    return
  }
  // neuc.63: a v2 castle builder batch still owns the body — the word
  // flips to <kind>-none mid-batch (the next per-cell kind, e.g. stairs,
  // is unheld while the batch's stone still lays). A table placed or a
  // craft run under a live BuilderProcess is refused (rig 8a3/8a4/8bl:
  // refused table spots -> 'need a crafting table' ->
  // failed:castlefetch-no-stairs -> 5-min hold -> forage/rest/house
  // spiral). Stop the batch (build-preempted: no strike, no fetch word)
  // and fetch once its final lands. Never wait it out: a full batch
  // climbs the builder to y+14 and the per-cell stairs are unreachable
  // from there (rig n63-a1/a2: wedged at ~200 cells).
  if (ctx.castleBuildFlight) {
    if (ctx.castleFetch) spend(ctx.castleFetch, 'other')
    const b = bot && bot._build
    if (b && !b.preempted && typeof bot.stopBuild === 'function') {
      try { console.log(`castlefetch: stopping the castle builder batch (placed ${b.placed | 0})`) } catch (_) { /* log best-effort */ }
      bot.stopBuild().catch(() => { /* release best-effort: the bridge watchdog settles it anyway */ })
    }
    return
  }
  const st = ctx.castle
  if (!st || !st.site || typeof st.site.x !== 'number') { finish(bot, ctx, 'done'); return }
  const d = demand(bot, ctx)
  if (!d || d.short <= 0) {
    // idkcraft-akze send-back 1: a torch leg whose own field furnace still
    // stands (or is mid-place) must not finish here — craftTick runs before
    // torchTick, so freshly crafted torches satisfy the demand while the
    // furnace waits for its break phase. Drive the break through torchTick;
    // a refused break (dead/poisoned) falls through and finishes below.
    const cfl = ctx.castleFetch && ctx.castleFetch.field
    if (d && d.kind === 'torch' && cfl && (cfl.at || cfl.flight)) {
      if (torchTick(bot, ctx, ctx.castleFetch, d, target, state)) return
    }
    finish(bot, ctx, 'done'); return
  }
  let f = ctx.castleFetch
  if (!f || f.kind !== d.kind) {
    f = ctx.castleFetch = { kind: d.kind, chestWaits: 0, skips: 0, noGain: 0, t0: Date.now(), blocks0: blocksOnHand(bot), haul: d.short }
    try { console.log(`castlefetch ${d.kind}: need ${d.short} more`) } catch (_) { /* log best-effort */ }
    // prkh (revmux 01 core-1): a new leg owns no failure yet — drop any
    // stamp an unrecorded reset left behind, so an unstamped failure below
    // falls back to the kindless hold-all.
    try { ctx.castleFetchFailKind = null; ctx.castleFetchDoneKind = null } catch (_) { /* stamp best-effort */ }
  }
  // Batch yield (idkcraft-vmzq.20): a leg that reached a layable batch but
  // not its full target hands over after LEG_MAX_MS, so the castle lays
  // the partial instead of starving behind an 80-cobble fetch (rig: the
  // first fetch never finished in 15 min, 0 laid). 'done', never failed:
  // no hold parks the re-pick after the castle drains. Below a batch the
  // leg keeps fetching — yielding to a castle that cannot lay would flip
  // straight back. 'some'/'none'/'blocked' never yield by construction.
  // neuc.58: on v2 the clock runs from the last gain, not the leg start —
  // a mine still filling the pack goes on to its forecast target; a leg
  // with no gain for LEG_MAX_MS yields as before. v1 untouched.
  let since = f.t0
  if (process.env.BOT_BODY === 'baritone') {
    const now = blocksOnHand(bot)
    const prev = typeof f.lastBlocks === 'number' ? f.lastBlocks : f.blocks0
    if (typeof now === 'number') {
      if (typeof prev === 'number' && now > prev) f.lastGainAt = Date.now()
      f.lastBlocks = now
    }
    if (typeof f.lastGainAt === 'number') since = f.lastGainAt
  }
  if (d.word === 'batch' && typeof since === 'number' && Date.now() - since > LEG_MAX_MS) {
    try { console.log(`castlefetch ${d.kind}: batch ready, yielding`) } catch (_) { /* log best-effort */ }
    finish(bot, ctx, 'done')
    return
  }
  if (st.status !== NO_WOOD || !(WOOD.has(d.kind) || d.kind === 'stairs')) st.status = `fetching ${d.kind}`
  if (chestTick(bot, ctx, f, d)) return
  if (craftTick(bot, ctx, f, d)) return
  // g0z.60: a bank batch on hand lays before any dig. Not a torch leg (fqkn):
  // its bank draw is logs, which torchTick below smelts into the torches.
  // Stairs keep the old shape (8njf/vf8e.8 own its table-broke mine batch).
  // szr1 core-3: but a draw the pack cannot craft for structural reasons
  // (no table, no wood at all) must not read 'done' — the next leg would
  // re-pick and drain the chest every few seconds. Fail so the hold parks
  // it instead (the same hole the g0z.60 logs shape had; plank-stocked
  // chests reach it). A fund shortfall ('can't make ... need ...') keeps
  // 'done': the next draw heals it (the door's 4-plank first draw crafts
  // on the second).
  if (f.bankFull && d.kind !== 'torch' && d.kind !== 'stairs') {
    if (f.craftOut && !/^can't make /.test(f.craftLine || '')) {
      if (d.kind === 'fence' || d.kind === 'gate') castleMod.noteDry(ctx, d.kind)
      finish(bot, ctx, `failed:castlefetch-craft-${d.kind}`)
      return
    }
    finish(bot, ctx, 'done')
    return
  }
  // idkcraft-8njf: on v2 a stairs craft that still fails after the table
  // retry mines ONE stone batch instead of failing into the 5-min hold
  // (forage -> rest -> house-build): stone is the castle's own material,
  // and the next leg crafts again with a fresh table retry. bot.mine banks
  // a delta, so the leg never ends 'done' at once. ponytail: one batch per
  // craft success (ctx.castleStairsMines, reset when a stairs craft lands)
  // — a table refused for good still reaches the hold on the next leg
  // instead of a mine loop the watchdog reads as flat. v1 untouched (its
  // digTick can end at once on a full cobble stock — a per-tick re-pick).
  let stairsMine = false
  if (d.kind === 'stairs' && f.craftOut && typeof bot.mine === 'function' && !stairsCobbleShort(bot)) {
    if (!f.stairsMine && !(ctx.castleStairsMines > 0)) {
      f.stairsMine = true
      ctx.castleStairsMines = 1
      try { console.log('castlefetch stairs: craft out, mining a stone batch instead') } catch (_) { /* log best-effort */ }
    }
    stairsMine = !!f.stairsMine
  }
  if (d.kind === 'stone' || (d.kind === 'stairs' && stairsCobbleShort(bot)) || stairsMine) {
    // neuc.59 fallback: a v2 stone leg tops up the pick budget first, one
    // craft per tick (goal.js frozen) — the refill rarely gets an equip run
    // in castle mode. v1 reads false and digs as before.
    if (d.kind === 'stone') {
      try {
        if (require('./equip').craftSparePick(bot, ctx)) return // deferred: craftany requires equip
      } catch (_) { /* unfunded: dig as before */ }
    }
    digTick(bot, ctx, f, d); return // neuc.53: the v2 mine sizes from d.short
  }
  if (WOOD.has(d.kind)) {
    // Logs from the world: gather chops a load and ends the leg itself
    // ('done' at NEED_LOGS, or its own failure); the next pick crafts
    // (frame: the logs are the material, the next tick reads the target).
    // A full load already on hand means the craft failed for another
    // reason (table, reach): chopping more would finish 'done' at once
    // and re-pick forever (revmux 01) — fail so the hold parks it.
    if (countItems(bot, (n) => n.endsWith('_log')) >= require('../budget').NEED_LOGS) {
      if (d.kind === 'fence' || d.kind === 'gate') castleMod.noteDry(ctx, d.kind) // the decor word skips it (dry() shape)
      finish(bot, ctx, `failed:castlefetch-craft-${d.kind}`)
      return
    }
    deps.gather(bot, ctx, target, state)
    if (isFinished(ctx.stepStatus)) {
      if ((d.kind === 'fence' || d.kind === 'gate') && failReason(ctx.stepStatus) !== null) castleMod.noteDry(ctx, d.kind)
      // g0z.56: the wood shortfall, named once on the castle status (the
      // 'castle' / 'castle repair' replies read it) — the owner's shortcut
      // is the castle chest, chestTick's first source next leg.
      if (failReason(ctx.stepStatus) === 'no-trees' && st.status !== NO_WOOD) {
        st.status = NO_WOOD
        try { console.log(`castlefetch ${d.kind}: ${NO_WOOD}`) } catch (_) { /* log best-effort */ }
      }
      // prkh: a gather-ended leg stamps its kind like finish() — the hold
      // parks this kind, never the whole step.
      if (failReason(ctx.stepStatus) !== null) {
        try { ctx.castleFetchFailKind = d.kind } catch (_) { /* stamp best-effort */ }
      }
      ctx.castleFetch = null
    }
    return
  }
  // vf8e.8 verifier P2: wood that lands mid-leg (gather's first chop,
  // the re-opened chest draw) must re-craft instead of holding with the
  // table funded — stairsTableFunded flips true so the branch below is
  // skipped, but f.craftOut still blocks craftTick. Clear the out flags
  // once per leg on the unfunded->funded transition (never when the pack
  // was funded all along: a full load that cannot table still holds).
  if (d.kind === 'stairs' && f.craftOut && f.tableRetry && !f.fundedRetry) {
    if (!stairsTableFunded(bot, ctx)) f.brokeUnfunded = true
    else if (f.brokeUnfunded) {
      f.fundedRetry = true
      f.craftOut = false
      f.tableRetry = false
      return // craft retries next tick
    }
  }
  if (d.kind === 'stairs' && stairsTableBroke(bot, ctx, f)) {
    // vf8e.8: the table craft is still out and the pack holds no wood —
    // chop the table's log through the wood route's load (its surplus
    // funds the castle's planks/door kinds later). A full load on hand
    // means the table failed for another reason: fail into the hold,
    // never castlefetch-craft-stairs (no new failed: string, v2 gate).
    // A table known at leg start may die mid-leg (craftany deadToday):
    // the fund was skipped, the retry failed, and the chest still holds
    // the wood. Re-open the chest source once per leg before chopping —
    // but only when a chest was actually visited (revmux 01 core-1).
    if (!f.fundRetry && f.chestTried && f.chestTried.size > 0) {
      f.fundRetry = true
      f.chestDone = false
      f.chest = null
      f.chestWalk = null
      f.chestTried = new Set()
      f.chestKey = null // 6fc1: the re-opened round owns a fresh budget
      f.chestRetries = 0
      f.chestVia = null
      f.chestViaWalk = null
      return
    }
    if (countItems(bot, (n) => n.endsWith('_log')) >= require('../budget').NEED_LOGS) {
      finish(bot, ctx, 'failed:castlefetch-no-stairs')
      return
    }
    deps.gather(bot, ctx, target, state)
    if (isFinished(ctx.stepStatus)) {
      // Honest ceiling: no trees anywhere near — name it once (a log in
      // the castle chest funds the stairs through the table fund next
      // leg) and fail into the hold as before.
      if (failReason(ctx.stepStatus) === 'no-trees') {
        if (st.status !== NO_WOOD) {
          st.status = NO_WOOD
          try { console.log(`castlefetch stairs: ${NO_WOOD}`) } catch (_) { /* log best-effort */ }
        }
        finish(bot, ctx, 'failed:castlefetch-no-stairs')
      } else {
        // prkh: a gather-ended leg stamps its kind like finish() — the
        // hold parks this kind, never the whole step.
        if (failReason(ctx.stepStatus) !== null) {
          try { ctx.castleFetchFailKind = d.kind } catch (_) { /* stamp best-effort */ }
        }
        ctx.castleFetch = null
      }
    }
    return
  }
  if (d.kind === 'banner' && bannerSelf(bot, ctx)) { bannerTick(bot, ctx, f, d); return }
  if (d.kind === 'pane') { paneTick(bot, ctx, f, d, target, state); return }
  if (d.kind === 'blast_furnace') { blastTick(bot, ctx, f, d, target, state); return }
  if (d.kind === 'torch' && torchTick(bot, ctx, f, d, target, state)) return
  castleMod.noteDry(ctx, d.kind) // the decor word tries the next open kind (castle menuFact)
  finish(bot, ctx, `failed:castlefetch-no-${d.kind}`) // torch without coal, banner without chest stock (beds first)
}

module.exports = castlefetch
module.exports.LEG_MAX_MS = LEG_MAX_MS
module.exports.pickChest = pickChest
module.exports.torchTick = torchTick
module.exports.fieldSpot = fieldSpot
module.exports.TORCH_HOME_DIST = TORCH_HOME_DIST
module.exports.stairsCobbleShort = stairsCobbleShort
module.exports.QUARRY_ADAPT = QUARRY_ADAPT
module.exports.quarrySide = quarrySide
module.exports.QUARRY_RINGS = QUARRY_RINGS
module.exports.pickQuarry = pickQuarry
module.exports.pickStone = pickStone
module.exports.siteGuardBox = siteGuardBox
module.exports.insideGuard = insideGuard
module.exports.guardExit = guardExit
module.exports.pickPit = pickPit
module.exports.pitSpots = pitSpots
module.exports.inTrench = inTrench
module.exports.PIT_LEN = PIT_LEN
module.exports.PIT_DEPTH = PIT_DEPTH
module.exports.PIT_ROOM = PIT_ROOM
module.exports.digTick = digTick
module.exports.demand = demand
module.exports.holdFor = holdFor
module.exports.roomForDrop = roomForDrop
module.exports.castleChest = castleChest
module.exports.chestVia = chestVia
module.exports.CHEST_RETRIES = CHEST_RETRIES
module.exports.onSite = onSite
module.exports.deps = deps
module.exports.FETCH = FETCH
module.exports.selfOrder = selfOrder
module.exports.selfOrderBack = selfOrderBack
module.exports.paneNeed = paneNeed
module.exports.blastNeed = blastNeed
module.exports.acceptStone = acceptStone
module.exports.FIND_COUNT = FIND_COUNT
module.exports.STONE_BELOW = STONE_BELOW
module.exports.STONE_ABOVE = STONE_ABOVE
