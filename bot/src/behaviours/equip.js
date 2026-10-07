'use strict'

const { goals } = require('mineflayer-pathfinder')
const Vec3 = require('vec3')
const { countItems } = require('../perception')
const craftMod = require('./craft')
const { isStone } = require('../castle')
const fightMod = require('./fight')
const { canBreak, denyReason, logDeny, protectedReason, isOwnPlaced, inHouseFootprint } = require('./util')

// equip: rebuild the starter kit after death (idkcraft-atl.6, owner
// 2026-09-24: stone_pickaxe, stone_sword, ~32 scaffold blocks). Order is
// pickaxe -> sword -> blocks: the pickaxe is ef3's hands (dig_up needs it),
// the sword goes to the hand for fight/meleeReflex via equipGear, blocks
// dig by hand when poor and from stone once the pickaxe lands.
// Registered in BEHAVIOURS under 'equip' so the goal arbiter can pick it.
// Reports via ctx.stepStatus, one op per tick with ctx.equipInFlight (same
// shape as craft). Recipes come from bot.recipesFor/bot.craft through the
// shared craft.js helpers; a table from the inventory is placed beside the
// body, a placed station is walked to like the craft step does.

const TABLE_REACH = craftMod.TABLE_REACH
const DIG_REACH = 4
// Drops land where the block stood: digging past pickup reach (~2) leaves
// every drop on the ground and the kit never fills (live lesson — the stall
// below fired with a full field of uncollected dirt). Walk closer first.
const PICKUP_REACH = 2
// Below this the bot digs more scaffold nearby; digging stops here.
const SCAFFOLD_LOW = 16
const SCAFFOLD_FULL = 32
// Same craft succeeding this often without the item landing means the result
// never reaches the inventory (lag/full): fail loudly, the atl.4 hold keeps
// the menu from re-picking us at the same facts (no eternal loop).
const CRAFT_STALL_STRIKES = 3
// Dig attempts before giving up (drops lost, no dirt near): fail, hold, rest.
const DIG_STALL_STRIKES = 64
// Consecutive digs without the kit growing (drops lost, ghost blocks):
// fail dig-stall so the goal menu moves on (dj3: the prod lakebed grind).
const DIG_NOGAIN_STRIKES = 5
// One dig that never settles (hung driver): fail dig-stall on the
// deadline instead of wedging the step (craft-timeout precedent).
const DIG_TIMEOUT_MS = 10000

function scaffoldCount(bot) {
  return countItems(bot, (n) => n === 'dirt' || isStone(n)) // vmzq.38: castle stone scaffolds too
}

function hasSword(bot) {
  return countItems(bot, (n) => n.endsWith('_sword')) > 0
}

function hasPickaxe(bot) {
  return countItems(bot, (n) => n.endsWith('_pickaxe')) > 0
}

// Harvest ladder mirror (bring.js PICKAXE_RANK has the original; a require
// would close the bring->bringitem->craftany->equip cycle): wooden and
// golden mine no ore, so a rank-0 pickaxe upgrades itself to stone (x15)
// instead of refusing every iron order while reading 'pickaxe=yes'.
const PICKAXE_RANK = { wooden: 0, golden: 0, stone: 1, iron: 2, diamond: 3, netherite: 4 }
function bestPickRank(bot) {
  let best = -1
  try {
    for (const i of itemsOf(bot)) {
      const m = i && typeof i.name === 'string' && i.name.match(/^(wooden|golden|stone|iron|diamond|netherite)_pickaxe$/)
      if (m) best = Math.max(best, PICKAXE_RANK[m[1]])
    }
  } catch (_) { return -1 }
  return best
}
function pickRank(name) {
  const m = typeof name === 'string' && name.match(/^(wooden|golden|stone|iron|diamond|netherite)_pickaxe$/)
  return m ? PICKAXE_RANK[m[1]] : 0
}
// The stone chain behind toolOp's pickaxe branch: 3 cobble plus 2 sticks
// on hand or one stick-op away (2 same planks or any log — toolOp's own
// conditions, so a due upgrade always yields stone, never a second wooden).
function stoneUpgradeDue(bot) {
  try {
    if (bestPickRank(bot) !== 0) return false
    if (countItems(bot, (n) => n === 'cobblestone') < 3) return false
    if (countItems(bot, (n) => n === 'stick') >= 2) return true
    if (craftMod.tally(bot, '_log').size > 0) return true
    const planks = craftMod.sortedWoods(craftMod.tally(bot, '_planks'))
    return planks.length > 0 && planks[0][1] >= 2
  } catch (_) { return false }
}
// A table the upgrade can craft on right now: the inventory item or a claim
// the world still shows. Unreadable (unloaded chunk) reads as NO — the
// upgrade is opportunistic, so an uncertain table digs scaffold exactly as
// before instead of failing the step (unlike a fresh craft, which fails
// loud through tableFor and holds).
function tableReady(bot, ctx) {
  try {
    if (itemsOf(bot).some((i) => i && i.name === 'crafting_table')) return true
    if (!bot || typeof bot.blockAt !== 'function') return false
    const st = ctx && ctx.equip
    const claims = [ctx && ctx.home && ctx.home.table, st && st.tablePos, ctx && ctx.claimedTable]
    for (const t of claims) {
      if (!t || typeof t.x !== 'number') continue
      let block = null
      try { block = bot.blockAt(new Vec3(t.x, t.y, t.z)) } catch (_) { block = null }
      if (block && block.name === 'crafting_table') return true
    }
  } catch (_) { /* probe best-effort */ }
  return false
}

function itemsOf(bot) {
  try {
    const items = bot.inventory && typeof bot.inventory.items === 'function' && bot.inventory.items()
    return Array.isArray(items) ? items : []
  } catch (_) {
    return []
  }
}

function dist3(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)
}

// Per-run counters (stall patience, not station claims): a finished run —
 // done or failed — spends them, so the next pick starts fresh instead of
// failing on the previous run's budget (revmux round-1: every blocks pick
// failed dig-stall on its first tick after 2–3 rebuilds).
function resetRunCounters(ctx) {
  try {
    const st = ctx && ctx.equip
    if (st && typeof st === 'object') {
      delete st.digs
      delete st.walkWaits
      delete st.approachWaits
      delete st.made
      delete st.noGain
      delete st.lastScaffold
    }
  } catch (_) { /* reset best-effort */ }
}

// Same-reason day latch (idkcraft-ipn.11): the atl.4 stepFail hold releases
// on relocation — and a death-respawn IS a relocation — so one failing
// table re-armed after every death (prod: 'wooden_sword table-unreachable'
// at 14:04, 14:23, 14:25, 'equip failed' 30x a day, gear starved). The
// second same-reason failure of one MC day latches equip infeasible until
// tomorrow; the menu feasible gate reads it (beds no-wool mirror). Lives on
// ctx, NOT on ctx.equip: decide resets ctx.equip on every fresh pick,
// which would wipe the latch.
const EQUIP_LATCH = 2
function dayOf(bot) {
  try {
    const d = bot && bot.time && bot.time.day
    return typeof d === 'number' ? d : 0
  } catch (_) { return 0 }
}
function noteEquipFail(ctx, day, key) {
  try {
    if (!ctx || typeof ctx !== 'object') return 0
    const cur = ctx.equipLatch && typeof ctx.equipLatch === 'object' ? ctx.equipLatch : null
    const fails = cur && cur.day === day && cur.key === key ? (cur.fails || 0) + 1 : 1
    ctx.equipLatch = { day, key, fails }
    return fails
  } catch (_) { return 0 }
}
function equipLatched(ctx, bot) {
  try {
    const cur = ctx && ctx.equipLatch
    if (!cur || typeof cur !== 'object') return false
    return cur.day === dayOf(bot) && (cur.fails || 0) >= EQUIP_LATCH
  } catch (_) { return false }
}

function fail(bot, ctx, item, err) {
  // Stale async settlement (revmux dj3 round-1): equipDigInFlight is not in
  // decide's preemption guard, so a facts-changed re-decide can switch
  // steps mid-dig — a late fail must not mark the NEW step failed (the
  // hold would poison it). Drop the report, but still spend the run
  // counters so a later re-pick starts fresh. An unset step (unit tests,
  // direct dispatch) fails loudly as before.
  if (ctx.step && ctx.step !== 'equip') {
    resetRunCounters(ctx)
    return
  }
  // Same-reason day latch (ipn.11): keyed on item + error — a repeating
  // identical failure yields the day to gear instead of re-arming forever.
  // pack-full never latches (g0z.26 R2): transient capacity, cleared by the
  // next banking — not a broken plan.
  if (item === 'pack-full') {
    ctx.stepStatus = 'failed:equip-pack-full'
    resetRunCounters(ctx)
    try {
      console.error(`equip failed item=${item} error=${err && err.message ? err.message : err}`)
    } catch (_) { /* logging best-effort */ }
    return
  }
  // Transient table geometry (idkcraft-u07s): a carried table with no
  // viable neighbour cell (or no body position to scan from) is a spot
  // verdict, not a broken plan — the failHolds spot hold paces retries at
  // new ground, so the day latch must not eat it (rig cycle: two woods
  // no-tables held equip all day, no pickaxe, castle chain never started).
  // Only no-table-item (no table anywhere) latches.
  try {
    const tmsg = err && err.message ? String(err.message) : ''
    if (tmsg === 'no-table-ref' || tmsg === 'no-table-pos') {
      ctx.stepStatus = `failed:equip-${item}`
      resetRunCounters(ctx)
      try {
        console.error(`equip failed item=${item} error=${tmsg}`)
      } catch (_) { /* logging best-effort */ }
      return
    }
  } catch (_) { /* transient check best-effort: fall through to latch */ }
  try {
    const msg = err && err.message ? String(err.message) : String(err)
    noteEquipFail(ctx, dayOf(bot), `${item}:${msg}`)
  } catch (_) { /* latch best-effort */ }
  ctx.stepStatus = `failed:equip-${item}`
  resetRunCounters(ctx)
  try {
    console.error(`equip failed item=${item} error=${err && err.message ? err.message : err}`)
  } catch (_) { /* logging best-effort */ }
}

// idkcraft-ajoe: a home table 113 blocks off (or one whose walk already
// failed today) kept equip walking/failing table-unreachable for hours
// while the pack could have funded a table of its own. Past this range
// (or after that failure) the bot crafts one in the 2x2 and places it
// beside itself — at most once per MC day, so the world is not littered.
const FAR_TABLE = 32
function tableFar(bot, ctx, bp, t) {
  try {
    if (dist3(bp, t) > FAR_TABLE) return true
    const u = ctx && ctx.equipTableUnreachable
    return !!u && u.day === dayOf(bot) && u.x === t.x && u.y === t.y && u.z === t.z
  } catch (_) { return false }
}

// The own-table op for a tabled tool: planks (from a log) then the table
// itself, both 2x2. Null keeps tableFor's old route: a table in the pack
// already, today's table already made, a near station standing, no
// standing station at all (the craft step owns that case), or too little
// wood for table + tool (4 planks + 3 for a wooden head) — a table that
// eats the tool's planks would only trade table-unreachable for no-materials.
function ownTableOp(bot, ctx, op) {
  try {
    if (itemsOf(bot).some((i) => i && i.name === 'crafting_table')) return null
    if (ctx.equipTableDay === dayOf(bot)) return null
    const bp = bot.entity && bot.entity.position
    const st = ctx.equip || {}
    let far = false
    for (const t of [ctx.home && ctx.home.table, st.tablePos, ctx.claimedTable]) {
      if (!t || typeof t.x !== 'number' || typeof bot.blockAt !== 'function') continue
      let block = null
      try { block = bot.blockAt(new Vec3(t.x, t.y, t.z)) } catch (_) { block = null }
      // Unreadable (unloaded chunk) is standing for the menu (goal.js
      // stationStanding), so craft never rebuilds: a far one counts here
      // too, else tableFor drops it and fails no-table daily (revmux 01).
      // A verified other block is a ghost: skipped.
      if (block && block.name !== 'crafting_table') continue
      if (!tableFar(bot, ctx, bp, t)) {
        if (block) return null
        continue
      }
      far = true
    }
    if (!far) return null
    // ponytail: biggest planks stack + every log, mixed woods can overcount
    // by a few planks; the next tick's toolOp re-plans on the real pack.
    const planks = craftMod.sortedWoods(craftMod.tally(bot, '_planks'))
    const have = (planks.length > 0 ? planks[0][1] : 0) + 4 * countItems(bot, (n) => n.endsWith('_log'))
    if (have < 4 + (op.stone ? 0 : 3)) return null
    if (planks.length > 0 && planks[0][1] >= 4) {
      const found = craftMod.recipes(bot, 'crafting_table', null)
      return found.length > 0 ? { item: 'crafting_table', recipe: found[0], count: 1, table: null } : null
    }
    const logs = craftMod.sortedWoods(craftMod.tally(bot, '_log'))
    if (logs.length === 0) return null
    const found = craftMod.recipes(bot, `${logs[0][0]}_planks`, null)
    return found.length > 0 ? { item: `${logs[0][0]}_planks`, recipe: found[0], count: 1, table: null } : null
  } catch (_) { return null }
}

// Placed table for the tool recipes: the walked-to ctx.home.table first
// (craft-step contract), else a table from the inventory placed beside the
// body. Resolves { block, pos }, resolves null while walking into reach,
// and REJECTS when no table can be had (fail loudly, the atl.4 hold keeps
// the menu from re-picking us). Name checks are load-bearing: an air or
// wrong block reads truthy, and activating it waits out the window timeout
// instead of failing (live 26.1 lesson).
// Placement-replaceable flora (idkcraft-u07s revmux 02 core-1): the ONLY
// non-air cells vanilla Java overwrites when a placement targets them.
// NOT build.js REPLACEABLE: that list means "the place flow may break
// these first" and includes flowers and torches, which vanilla placement
// REFUSES (BlockPlaceContext.canPlace is false — the click dies and the
// pick fails). Those read as occupied, as before.
const PLACE_OVER = new Set([
  'short_grass', 'tall_grass', 'fern', 'large_fern', 'dead_bush', 'snow',
  'vine', 'glow_lichen', 'leaf_litter', 'bush', 'short_dry_grass',
  'tall_dry_grass',
])

function tableFor(bot, ctx) {
  const nope = (why) => Promise.reject(new Error(why))
  const bp = bot.entity && bot.entity.position
  // Named sites (idkcraft-u07s): the log says which leg failed — pos (no
  // body position), item (no table anywhere to place), ref (a carried
  // table with no viable neighbour cell). The spot verdicts are transient
  // (fail() does not day-latch them); only no-table-item latches.
  if (!bp) return nope('no-table-pos')
  const st = (ctx.equip && typeof ctx.equip === 'object') ? ctx.equip : (ctx.equip = {})
  // Candidate stations: the home table, our own placed one, the menu
  // claim. Ghost entries (mined away) fall through to the inventory branch
  // instead of shadowing it — and a fully-ghosted claim is retracted so the
  // craft step rebuilds again instead of starving us.
  const tables = []
  if (ctx.home && ctx.home.table) tables.push(ctx.home.table)
  if (st.tablePos) tables.push(st.tablePos)
  if (ctx.claimedTable && ctx.claimedTable !== st.tablePos) tables.push(ctx.claimedTable)
  let homeTable = null
  let homeBlock = null
  let farTable = null
  let farBlock = null
  let claimedDead = false
  for (const t of tables) {
    let block = null
    let unreadable = false
    // Vec3-normalised (h9z): claims arrive plain ({x,y,z} from the roadside
    // write below or an older memory file) and prismarine-world calls
    // pos.floored() — a raw read throws, the standing table reads as a
    // ghost, and the next op fails no-table with the item already eaten.
    // Null/throwing reads are unknown (unloaded chunk), never dead: only a
    // verified-different block condemns the roadside claim below.
    try {
      if (bot.blockAt && t && typeof t.x === 'number') {
        block = bot.blockAt(new Vec3(t.x, t.y, t.z))
        if (!block) unreadable = true
      } else unreadable = true
    } catch (_) { block = null; unreadable = true }
    if (block && block.name === 'crafting_table') {
      // ajoe: a far or today-unreachable station only wins when nothing
      // nearer stands and no table is in the pack to place beside us.
      if (!tableFar(bot, ctx, bp, t)) { homeTable = t; homeBlock = block; break }
      if (!farTable) { farTable = t; farBlock = block }
      continue
    }
    if (!unreadable && t && t === ctx.claimedTable) claimedDead = true
  }
  if (!homeTable && farTable && !itemsOf(bot).some((i) => i && i.name === 'crafting_table')) {
    homeTable = farTable
    homeBlock = farBlock
  }
  if (homeTable) {
    if (dist3(bp, homeTable) <= TABLE_REACH) {
      st.walkWaits = 0
      return Promise.resolve({ block: homeBlock, pos: homeTable })
    }
    const key = `equip-table:${homeTable.x},${homeTable.y},${homeTable.z}`
    if (key !== ctx.lastGoalKey && bot.pathfinder && typeof bot.pathfinder.setGoal === 'function') {
      bot.pathfinder.setGoal(new goals.GoalNear(homeTable.x, homeTable.y, homeTable.z, 3), false)
      ctx.lastGoalKey = key
    }
    st.walkWaits = (st.walkWaits || 0) + 1
    // Walking that never arrives is a stall, not progress: fail so the
    // menu holds us instead of idling here forever.
    if (st.walkWaits > 20) {
      // ajoe: remember the dead walk for the day — the next pick crafts
      // and places its own table instead of re-walking for hours.
      try { ctx.equipTableUnreachable = { day: dayOf(bot), x: homeTable.x, y: homeTable.y, z: homeTable.z } } catch (_) { /* best-effort */ }
      return nope('table-unreachable')
    }
    return Promise.resolve(null) // walking: retry on a later tick
  }
  // No station standing: retract a verified-dead roadside claim so craft
  // rebuilds from planks instead of deadlocking the kit. An unreadable one
  // (null/throwing: unloaded chunk) is kept — retracting it strands the
  // standing table and litters a new one every episode. ctx.home.table is
  // never retracted here: build owns that claim.
  try {
    if (claimedDead) delete ctx.claimedTable
  } catch (_) { /* retract best-effort */ }
  const tableItem = itemsOf(bot).find((i) => i && i.name === 'crafting_table')
  if (!tableItem || typeof bot.placeBlock !== 'function' || !bot.blockAt) return nope('no-table-item')
  // Beside the body, not under it: the feet cell collides with the bot and
  // the server rejects the placement. First free neighbour with solid
  // ground wins.
  const bx = Math.floor(bp.x)
  const by = Math.floor(bp.y)
  const bz = Math.floor(bp.z)
  // Refused spots (idkcraft-vmzq.20): a server-refused placement eats the
  // table item, and the deterministic scan re-picks the identical cell on
  // every pick — rig cycle 5 burned its whole window in a
  // craft→equip-fail loop on one cell. Refused cells sort last (a later
  // success clears the set: the area places again), so the next pick tries
  // the next neighbour instead of re-burning — but a refused cell is still
  // attempted when nothing else is viable, keeping the TABLE_TRIES
  // contract (transient refusals in a one-cell world retry like before).
  if (!(ctx.equipTableSkip instanceof Set)) {
    try { ctx.equipTableSkip = new Set() } catch (_) { /* skip best-effort */ }
  }
  const skip = ctx.equipTableSkip instanceof Set ? ctx.equipTableSkip : new Set()
  let ref = null
  let at = null
  let fallback = null
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    const tried = skip.has(`${bx + dx},${by},${bz + dz}`)
    let below = null
    let cell = null
    try {
      below = bot.blockAt(new Vec3(bx + dx, by - 1, bz + dz))
      cell = bot.blockAt(new Vec3(bx + dx, by, bz + dz))
    } catch (_) { below = null; cell = null }
    if (!below || !below.position || !below.name || below.name === 'air') continue
    // Solid footing only: water, snow and flora are non-air but take no
    // placement (the packet dies and the item with it). Fail-open on an
    // unknown shape — old test doubles carry no boundingBox.
    if (below.boundingBox != null && below.boundingBox !== 'block') continue
    // Flora takes a placement (idkcraft-u07s revmux 01 core-1): the server
    // replaces grass and its kin, so a grassy neighbour is a free spot,
    // not an occupied one — in the woods all four neighbours are flora and
    // the strict air check failed every pick with the table in the pack.
    // cave_air/void_air are air-likes.
    if (cell && cell.name && cell.name !== 'air' && cell.name !== 'cave_air' && cell.name !== 'void_air' &&
        !PLACE_OVER.has(cell.name)) continue
    // Bedroom cells are never table spots (idkcraft-4nx: a roadside table on
    // B-foot blocked the bed, which fails loud by design). Deferred require
    // (beds->craftany->equip cycle); unreadable reads as placeable.
    try {
      if (require('./beds').isBedroomCell(ctx && ctx.home, bx + dx, by, bz + dz)) continue
      // Nor any wall/door cell of the plan (idkcraft-d7i: a station in the
      // doorway left the house doorless).
      if (require('./build').isPlanCell(ctx && ctx.home, bx + dx, by, bz + dz)) continue
    } catch (_) { /* untestable home: place as before */ }
    if (tried) {
      if (!fallback) fallback = below
      continue
    }
    ref = below
    at = new Vec3(below.position.x, below.position.y + 1, below.position.z)
    break
  }
  if (!ref && fallback) {
    ref = fallback
    at = new Vec3(fallback.position.x, fallback.position.y + 1, fallback.position.z)
  }
  if (!ref) return nope('no-table-ref')
  // mineflayer places the HELD item: hold the table or a planks block lands
  // (and reads truthy) where the table should be.
  const run = async () => {
    if (typeof bot.equip === 'function') {
      try {
        await bot.equip(tableItem, 'hand')
      } catch (_) { /* held already or bust: placement decides */ }
    }
    try {
      await bot.placeBlock(ref, new Vec3(0, 1, 0))
    } catch (err) {
      // The item is eaten with the refusal: never re-try this cell (the
      // scan above skips it next pick).
      try {
        skip.add(`${at.x},${at.y},${at.z}`)
        console.log(`equip table spot ${at.x} ${at.y} ${at.z} refused, skipping`)
      } catch (_) { /* skip best-effort */ }
      throw err
    }
    let block = null
    try { block = bot.blockAt(at) } catch (_) { block = null }
    if (!block || block.name !== 'crafting_table') {
      // Mislanded (or a lost update): same no-retry rule — a neighbour is
      // cheaper than a second table on a cell that mislands deterministically.
      try { skip.add(`${at.x},${at.y},${at.z}`) } catch (_) { /* skip best-effort */ }
      throw new Error('table-place')
    }
    try { skip.clear() } catch (_) { /* skip best-effort */ }
    // Claim the placed station (craft-step contract, read by tablePlaced
    // in goalFacts): the menu stops rebuilding tables from planks while we
    // arm. Build overwrites the home claim with its own site table when it
    // lands one.
    // Claim the station WITHOUT touching ctx.home.table: build claims
    // its blueprint cell only while unset, so a roadside write would shadow
    // the site table forever and the house never finishes (revmux round-1).
    try {
      // Vec3, not plain (h9z): every consumer blockAt()s the claim and
      // prismarine-world calls pos.floored() — a plain claim throws and
      // reads as no station (craft then rebuilds a second table).
      st.tablePos = new Vec3(at.x, at.y, at.z)
      ctx.claimedTable = new Vec3(at.x, at.y, at.z)
    } catch (_) { /* claim best-effort */ }
    return { block, pos: at }
  }
  // A hung placement must not wedge the menu (see the in-flight stickiness
  // in decide()): time out into the loud failure instead.
  const timeout = new Promise((_, reject) => {
    const t = setTimeout(() => reject(new Error('table-timeout')), 15000)
    if (t && typeof t.unref === 'function') t.unref()
  })
  return Promise.race([run(), timeout])
}

// One craft op (sticks, planks or the tool itself). Returns the op, null
// when the tool is complete, or { fail: reason } when stuck.
function toolOp(bot, kind) {
  const logs = craftMod.tally(bot, '_log')
  const planks = craftMod.sortedWoods(craftMod.tally(bot, '_planks'))
  const sticks = countItems(bot, (n) => n === 'stick')
  const cobble = countItems(bot, (n) => n === 'cobblestone')
  const needSticks = kind === 'pickaxe' ? 2 : 1
  const needRock = kind === 'pickaxe' ? 3 : 2
  if (sticks < needSticks) {
    if (planks.length > 0 && planks[0][1] >= 2) {
      const found = craftMod.recipes(bot, 'stick', null)
      if (found.length > 0) return { item: 'stick', recipe: found[0], count: 1, table: null }
      return { fail: 'no-stick-recipe' }
    }
    if (logs.size > 0) {
      const [wood] = craftMod.sortedWoods(logs)[0]
      const found = craftMod.recipes(bot, `${wood}_planks`, null)
      if (found.length > 0) return { item: `${wood}_planks`, recipe: found[0], count: 1, table: null }
      return { fail: 'no-planks-recipe' }
    }
    return { fail: 'no-materials' }
  }
  const stone = cobble >= needRock
  // Any planks do: wooden tools share one name whatever the wood (there is
  // no oak_pickaxe — the recipe lookup would miss it).
  const wood = planks.length > 0 && planks[0][1] >= needRock
  if (!stone && !wood) {
    // Sticks are satisfied but the rock is short: keep converting the
    // remaining logs instead of failing with material still on hand
    // (revmux round-1: 2 logs stalled after one planks op).
    if (logs.size > 0) {
      const [wood2] = craftMod.sortedWoods(logs)[0]
      const found = craftMod.recipes(bot, `${wood2}_planks`, null)
      if (found.length > 0) return { item: `${wood2}_planks`, recipe: found[0], count: 1, table: null }
      return { fail: 'no-planks-recipe' }
    }
    return { fail: 'no-materials' }
  }
  const tool = kind === 'pickaxe' ? 'pickaxe' : 'sword'
  return { item: stone ? `stone_${tool}` : `wooden_${tool}`, stone, tabled: true }
}

function digTargets(bot) {
  const names = ['dirt', 'grass_block']
  if (hasPickaxe(bot)) names.push('stone', 'cobblestone')
  return names
}

// Cells that make a dig wet (swim.js executor-water minus lava): mining
// through them is ~5x slower without aqua affinity, the bot must stand in
// water, and the drop floats off — the prod 22:04 stall (dj3: lakebed
// dirt, minutes of silent digging).
const WET = new Set(['water', 'bubble_column', 'kelp', 'kelp_plant', 'seagrass', 'tall_seagrass'])
// True when digging (x, y, z) means digging wet: water in the cell above
// (a submerged target) or around it at target/head level (the hole
// floods, or the bot stands in water to reach it). Null reads are dry
// (unloaded chunk, unknown — the deep.js precedent: only confirmed
// blocks decide).
function wetDig(bot, x, y, z) {
  if (!bot || typeof bot.blockAt !== 'function') return false
  const ring = [[0, 1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [1, 1, 0], [-1, 1, 0], [0, 1, 1], [0, 1, -1]]
  const fx = Math.floor(x)
  const fy = Math.floor(y)
  const fz = Math.floor(z)
  for (const [dx, dy, dz] of ring) {
    let n = null
    try {
      const b = bot.blockAt(new Vec3(fx + dx, fy + dy, fz + dz))
      n = b && b.name
    } catch (_) { n = null }
    if (typeof n === 'string' && WET.has(n)) return true
  }
  return false
}

// A submerged body digs ~5x slower and every drop floats off, so no
// candidate near it is worth starting (dj3 rig: a sunk body dug buried
// lakebed stone the ring reads as dry, and only the deadline saved it).
// Feet AND head both water: wading (feet only) still digs a dry bank
// fine. Nulls read dry (unloaded chunk — the wetDig precedent).
function bodyUnderwater(bot, bp) {
  if (!bot || typeof bot.blockAt !== 'function' || !bp) return false
  try {
    const feet = bot.blockAt(new Vec3(Math.floor(bp.x), Math.floor(bp.y), Math.floor(bp.z)))
    const head = bot.blockAt(new Vec3(Math.floor(bp.x), Math.floor(bp.y) + 1, Math.floor(bp.z)))
    const fn = feet && feet.name
    const hn = head && head.name
    return (typeof fn === 'string' && WET.has(fn)) && (typeof hn === 'string' && WET.has(hn))
  } catch (_) { return false }
}

function equip(bot, ctx) {
  if (ctx.equipInFlight) return // exactly one op at a time
  const bp = bot.entity && bot.entity.position
  if (!bp) return
  const st = (ctx.equip && typeof ctx.equip === 'object') ? ctx.equip : (ctx.equip = {})
  // A wooden/golden pickaxe upgrades to stone while the chain can land
  // (x15): rank-0 mines no ore, and the kit header promises stone. The
  // table probe keeps it opportunistic — without a verified station the
  // step digs scaffold exactly as before instead of failing no-table.
  const upgradePick = stoneUpgradeDue(bot) && tableReady(bot, ctx)
  const kind = !hasPickaxe(bot) || upgradePick ? 'pickaxe' : !hasSword(bot) ? 'sword' : null
  if (!kind) {
    if (scaffoldCount(bot) >= SCAFFOLD_FULL) {
      ctx.stepStatus = 'done'
      resetRunCounters(ctx)
      return
    }
    digTick(bot, ctx, st, bp)
    return
  }
  const op = toolOp(bot, kind)
  if (!op) return
  if (op.fail) {
    fail(bot, ctx, kind, new Error(op.fail))
    return
  }
  if (op.tabled) {
    const make = ownTableOp(bot, ctx, op)
    if (make) {
      craftOne(bot, ctx, make)
      return
    }
    ctx.equipInFlight = true
    void tableFor(bot, ctx).then(
      (t) => {
        ctx.equipInFlight = false
        if (!t) return // walking into reach: stay silent, retry next tick
        const found = craftMod.recipes(bot, op.item, t.block)
        if (found.length === 0) {
          fail(bot, ctx, op.item, new Error('no-recipe'))
          return
        }
        craftOne(bot, ctx, { item: op.item, recipe: found[0], count: 1, table: t.block })
      },
      (err) => {
        ctx.equipInFlight = false
        fail(bot, ctx, op.item, err)
      },
    )
    return
  }
  craftOne(bot, ctx, op)
}

// g0z.25 slow-path settle (gear PHANTOM_SETTLE_MS parity): the fast-path
// resync below already shows final truth for table crafts (assayed 5/5 on
// Paper 26.1.2); the settle is for 2x2 flicker (server-side application
// lags the op there) and lag-stretched heals.
const VERIFY_SETTLE_MS = 500

function craftOne(bot, ctx, op) {
  if (typeof bot.craft !== 'function') {
    fail(bot, ctx, op.item, new Error('bot.craft missing'))
    return
  }
  const st = (ctx.equip && typeof ctx.equip === 'object') ? ctx.equip : (ctx.equip = {})
  ctx.equipInFlight = true
  // Exactly-once settlement: a hung window (live ghost reads) must fail
  // loudly on a deadline, never freeze the menu with the flag stuck.
  let settled = false
  let timedOut = false
  const finish = (fn) => {
    if (settled) return
    settled = true
    ctx.equipInFlight = false
    if (typeof fn === 'function') fn()
  }
  const landedNow = () => op.item === 'stick' ? countItems(bot, (n) => n === 'stick') > 0
    : op.item.endsWith('_planks') ? true // planks feed the next op, not the kit
    : op.item === 'crafting_table' ? countItems(bot, (n) => n === 'crafting_table') > 0
    // Rank-aware (x15): a ghost upgrade must strike — any-pickaxe reads
    // the old wooden as landed and burns the cobble retrying. Fresh
    // wooden crafts are unchanged (rank 0 landed == hasPickaxe).
    : op.item.endsWith('_pickaxe') ? bestPickRank(bot) >= pickRank(op.item) : hasSword(bot)
  const run = async () => {
    try {
      await craftMod.safeCraft(bot, op.recipe, op.count, op.table, { ctx, item: op.item })
    } catch (err) {
      finish(() => fail(bot, ctx, op.item, err))
      return
    }
    // g0z.25 escalating verify: the immediate post-craft model lies
    // (assayed 11/11 landed products invisible at once on Paper 26.1.2),
    // so the strike judge reads post-resync truth, never the raw model. A
    // miss escalates to settle+resync (2x2 server-side flicker, lag) —
    // inFlight stays up through the verify, like gear's settle.
    if (timedOut) return
    try { await craftMod.syncInventory(bot) } catch (_) { /* unverified: the recount below still decides */ }
    if (timedOut) return
    let landed = landedNow()
    if (!landed) {
      await new Promise((resolve) => setTimeout(resolve, VERIFY_SETTLE_MS))
      if (timedOut) return
      try { await craftMod.syncInventory(bot) } catch (_) { /* unverified: the recount below still decides */ }
      if (timedOut) return
      landed = landedNow()
    }
    finish()
    const strikes = (st.made && st.made[op.item]) || 0
    if (!landed) {
      // A strike is silent: the 'equipped' chat below is only for a landed
      // craft (rwuu — prod chatted two fakes per stall and lied to the owner).
      st.made = st.made || {}
      st.made[op.item] = strikes + 1
      if (st.made[op.item] >= CRAFT_STALL_STRIKES) {
        try { console.error(`equip craft-stall item=${op.item} slots: ${craftMod.slotSummary(bot)}`) } catch (_) { /* logging best-effort */ }
        fail(bot, ctx, op.item, new Error('craft-stall'))
      }
      return
    }
    if (st.made) {
      try { delete st.made[op.item] } catch (_) { /* guard best-effort */ }
    }
    if (op.item === 'crafting_table') {
      // ajoe day cap: the next tick's tableFor places it beside us.
      if (landed) ctx.equipTableDay = dayOf(bot)
      return
    }
    if (op.item.endsWith('_sword')) {
      try { fightMod.equipGear(bot) } catch (_) { /* best-effort: fight equips anyway */ }
    }
    try { bot.chat(`equipped ${op.item}`) } catch (_) { /* chat best-effort */ }
  }
  const timeout = new Promise((_, reject) => {
    const t = setTimeout(() => reject(new Error('craft-timeout')), 30000)
    if (t && typeof t.unref === 'function') t.unref()
  })
  void Promise.race([run(), timeout]).catch((err) => {
    timedOut = true
    finish(() => fail(bot, ctx, op.item, err))
  })
}

// Our own placement inside the house footprint (box + apron): the recycle
// equip must not dig (idkcraft-6x7.12). Outside the footprint our pillars
// stay diggable pre-dahd refills (see the scan filter above).
function ownInFootprint(ctx, block) {
  try {
    const pos = block && block.position
    if (!pos || !ctx || !ctx.home) return false
    return isOwnPlaced(ctx, block) && !!inHouseFootprint(ctx.home, pos)
  } catch (_) { return false }
}

function digTick(bot, ctx, st, bp) {
  if (st.digs == null) st.digs = 0
  // Reserved slot (g0z.26 R2): the pack stops growing at PACK_RESERVE with
  // no adopted chest and nobody online — the last slot is the bootstrap
  // chest craft's room. Fails (held, never day-latched) so stockpile banks.
  let reserved = false
  try { reserved = !!require('./stockpile').slotReserved(bot, ctx) } catch (_) { reserved = false }
  if (reserved) {
    fail(bot, ctx, 'pack-full', new Error('pack full, banking first'))
    return
  }
  if (st.digs >= DIG_STALL_STRIKES) {
    fail(bot, ctx, 'blocks', new Error('dig-stall'))
    return
  }
  const names = digTargets(bot)
  let found = null
  try {
    found = bot.findBlocks && bot.findBlocks({
      matching: (b) => !!b && typeof b.name === 'string' && names.includes(b.name),
      maxDistance: 12,
      count: 16, // the wet filter below shrinks the pool: scan wider
      // idkcraft-0mlh: skip protected ground (house apron) in the scan, so
      // 16 porch cells near the door never starve the pool into no-dirt.
      // idkcraft-6x7.12: skip our own placements in the footprint — since
      // dahd filled placedByBot in prod, the scan offered our own approach
      // pillars in the footprint (nearest dirt around) and the refill dug
      // them, so the next approach re-pillared: net-zero dirt, extra
      // wedged walks. Footprint-only: outside pillars stay pre-dahd
      // refills (rig runs 7/9: skipping them lengthened mid-build refill
      // walks into dig-unreachable starvation, scaffold 0, then build
      // wedges) — they are also the short doorway exits, not churn.
      useExtraInfo: (b) => protectedReason(bot, b, ctx) === null && !ownInFootprint(ctx, b),
    })
  } catch (_) { found = null }
  if (!found || !found.length) {
    fail(bot, ctx, 'blocks', new Error('no-dirt'))
    return
  }
  // Never dig the ground under our own feet: dig around, not down.
  // Hand-diggable dirt first: stone needs the pickaxe in hand, so it is the
  // fallback when no dirt is near. findBlocks yields positions, so resolve
  // names through blockAt (unit mocks may carry the name already).
  const feetX = Math.floor(bp.x)
  const feetY = Math.floor(bp.y) - 1
  const feetZ = Math.floor(bp.z)
  const cands = []
  let wetSkipped = 0
  const sunk = bodyUnderwater(bot, bp)
  for (const v of found) {
    if (!v || typeof v.x !== 'number') continue
    if (Math.floor(v.x) === feetX && Math.floor(v.y) === feetY && Math.floor(v.z) === feetZ) continue
    // Never the castle's ground (g0z.4 rig: scaffold dirt dug out of the
    // castle floor). Deferred require: castlefetch -> castle -> build chain.
    if (ctx && ctx.castle && ctx.castle.site && require('./castlefetch').onSite(ctx.castle, v)) continue
    let name = typeof v.name === 'string' ? v.name : null
    let blk = null
    if (!name && bot.blockAt) {
      try { blk = bot.blockAt(new Vec3(v.x, v.y, v.z)) } catch (_) { blk = null }
      if (blk && typeof blk.name === 'string') name = blk.name
    }
    if (!name || !names.includes(name)) continue
    if (sunk || wetDig(bot, v.x, v.y, v.z)) { wetSkipped++; continue } // dj3: never dig wet
    const hard = name === 'stone' || name === 'cobblestone'
    cands.push({ v, blk, name, hard, d: Math.hypot(v.x - bp.x, v.y - bp.y, v.z - bp.z) })
  }
  cands.sort((a, b) => ((a.hard ? 1 : 0) - (b.hard ? 1 : 0)) || (a.d - b.d))
  const blockOf = (c) => c.blk || { name: c.name, position: c.v }
  const pick = cands.find((c) => !ownInFootprint(ctx, blockOf(c)) && canBreak(bot, blockOf(c), ctx))
  if (!pick) {
    if (cands[0]) { const d0 = denyReason(bot, blockOf(cands[0]), ctx); logDeny(blockOf(cands[0]), d0) } // idkcraft-drq: scaffold, not the hut
    if (wetSkipped > 0) {
      try { console.log(sunk ? `equip: body underwater, skipped ${wetSkipped} dig target(s)` : `equip: skipped ${wetSkipped} wet dig target(s)`) } catch (_) { /* logging best-effort */ }
    }
    fail(bot, ctx, 'blocks', new Error('no-dirt'))
    return
  }
  const block = pick.v
  // Approach walks share one patience budget with the table walk above: a
  // goal the body never reaches is a stall, failed loudly for the atl.4
  // hold instead of idled on forever. A dig attempt resets it.
  const approach = (key, range) => {
    if (key !== ctx.lastGoalKey && bot.pathfinder && typeof bot.pathfinder.setGoal === 'function') {
      bot.pathfinder.setGoal(new goals.GoalNear(block.x, block.y, block.z, range), false)
      ctx.lastGoalKey = key
    }
    st.approachWaits = (st.approachWaits || 0) + 1
    if (st.approachWaits > 30) fail(bot, ctx, 'blocks', new Error('dig-unreachable'))
  }
  if (pick.d > DIG_REACH) {
    // Walk into reach, then dig on a later tick.
    approach(`equip-dig:${Math.floor(block.x)},${Math.floor(block.y)},${Math.floor(block.z)}`, 3)
    return
  }
  if (pick.d > PICKUP_REACH) {
    // Close enough to dig, too far to collect: step in so the drops land
    // at the feet (see PICKUP_REACH above).
    approach(`equip-pickup:${Math.floor(block.x)},${Math.floor(block.y)},${Math.floor(block.z)}`, 1)
    return
  }
  st.approachWaits = 0
  if (ctx.equipDigInFlight || typeof bot.dig !== 'function') return
  // No-gain limit (dj3): consecutive digs that never grow the kit (drops
  // lost, ghost digs) fail dig-stall so the menu moves on. The snapshot
  // is taken at dig start and compared at the NEXT dig start, so pickups
  // have a full dig cycle to land before a strike counts.
  const kit = scaffoldCount(bot)
  if (st.lastScaffold != null && kit <= st.lastScaffold) {
    st.noGain = (st.noGain || 0) + 1
    if (st.noGain >= DIG_NOGAIN_STRIKES) {
      fail(bot, ctx, 'blocks', new Error('dig-stall'))
      return
    }
  } else {
    st.noGain = 0
  }
  st.lastScaffold = kit
  ctx.equipDigInFlight = true
  st.digs++
  try {
    console.log(`equip digging ${pick.name} at ${Math.floor(block.x)} ${Math.floor(block.y)} ${Math.floor(block.z)} scaffold=${kit}`)
  } catch (_) { /* logging best-effort */ }
  // Exactly-once settlement (craftOne shape): a hung driver (ghost block,
  // unloaded chunk) fails dig-stall on the deadline instead of wedging
  // the step with the flag stuck — the menu moves on, the next pick
  // retries with a fresh budget.
  let settled = false
  const finish = (fn) => {
    if (settled) return
    settled = true
    ctx.equipDigInFlight = false
    if (typeof fn === 'function') fn()
  }
  const run = async () => {
    try {
      const target = pick.blk || block
      // Stone dug by hand drops nothing: hold the pickaxe first.
      if (pick.hard && typeof bot.equip === 'function') {
        const held = itemsOf(bot).find((i) => i && typeof i.name === 'string' && i.name.endsWith('_pickaxe'))
        if (held) await bot.equip(held, 'hand')
      }
      await bot.dig(target)
    } catch (err) {
      finish(() => fail(bot, ctx, 'blocks', err))
      return
    }
    finish()
  }
  const timeout = new Promise((_, reject) => {
    const t = setTimeout(() => reject(new Error('dig-stall')), DIG_TIMEOUT_MS)
    if (t && typeof t.unref === 'function') t.unref()
  })
  void Promise.race([run(), timeout]).catch((err) => {
    finish(() => fail(bot, ctx, 'blocks', err))
  })
}

module.exports = equip
module.exports.SCAFFOLD_LOW = SCAFFOLD_LOW
module.exports.SCAFFOLD_FULL = SCAFFOLD_FULL
// Craft-any reuse (idkcraft-did.2): the h9z place-and-verify table contract.
module.exports.tableFor = tableFor
// Goal-gate reuse (idkcraft-x15): a rank-0 pickaxe with the stone chain,
// plus the table probe — the gate and the behaviour must agree on the
// station, or an unloaded claim diverts into an instant-done loop.
module.exports.stoneUpgradeDue = stoneUpgradeDue
module.exports.tableReady = tableReady
// Goal-gate reuse (idkcraft-ipn.11): the same-reason day latch — the menu
// reads it, the behaviour counts it (beds sheepLatched mirror).
module.exports.equipLatched = equipLatched
module.exports.EQUIP_LATCH = EQUIP_LATCH
