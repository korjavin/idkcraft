'use strict'

// Find-or-place a crafting table, moved verbatim out of equip.js
// (idkcraft-oqul.14): craftany.js places its pack table through tableFor,
// and the craftany->equip require edge closed the last craft/craftany/gear
// require cycle. equip.js re-exports tableFor and reads the small helpers
// (itemsOf/dist3/dayOf/tableFar) back from here. Leaf: pathfinder/vec3,
// util, residence, budget, plus deferred bedfacts/build reads (neither
// requires this module back).

const { goals } = require('mineflayer-pathfinder')
const Vec3 = require('vec3')
const { issueGoal } = require('./util')
const { TABLE_REACH } = require('../budget')

// idkcraft-ajoe: a home table 113 blocks off (or one whose walk already
// failed today) kept equip walking/failing table-unreachable for hours
// while the pack could have funded a table of its own. Past this range
// (or after that failure) the bot crafts one in the 2x2 and places it
// beside itself — at most once per MC day, so the world is not littered.
const FAR_TABLE = 32
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

function dayOf(bot) {
  try {
    const d = bot && bot.time && bot.time.day
    return typeof d === 'number' ? d : 0
  } catch (_) { return 0 }
}

function tableFar(bot, ctx, bp, t) {
  try {
    if (dist3(bp, t) > (ctx && ctx.craftanyLocal ? TABLE_REACH : FAR_TABLE)) return true // vmzq.37 buried rearm
    const u = ctx && ctx.equipTableUnreachable
    return !!u && u.day === dayOf(bot) && u.x === t.x && u.y === t.y && u.z === t.z
  } catch (_) { return false }
}

// Castle residence workbench (g0z.30): a carried table goes to the
// descriptor's table cell (the storeroom, off every plan cell) while the
// bot is at its castle — loaded, free, solid floor, not refused before.
// Elsewhere (or once its walk stalls) the roadside scan below places it.
function castleTableSpot(bot, ctx, bp, skip) {
  try {
    const home = ctx && ctx.home
    if (!home || home.kind !== 'castle' || !home.site) return null
    const t = require('../residence').of(home).table(home)
    if (skip.has(`${t.x},${t.y},${t.z}`) || dist3(bp, t) > FAR_TABLE) return null
    const cell = bot.blockAt(t)
    const below = bot.blockAt(new Vec3(t.x, t.y - 1, t.z))
    if (!cell || !below || !below.position || below.name === 'air') return null
    if (below.boundingBox != null && below.boundingBox !== 'block') return null
    if (cell.name !== 'air' && cell.name !== 'cave_air' && cell.name !== 'void_air') return null
    return { at: new Vec3(t.x, t.y, t.z), below }
  } catch (_) { return null }
}

// Placed table for the tool recipes: the walked-to ctx.home.table first
// (craft-step contract), else a table from the inventory placed beside the
// body. Resolves { block, pos }, resolves null while walking into reach,
// and REJECTS when no table can be had (fail loudly, the atl.4 hold keeps
// the menu from re-picking us). Name checks are load-bearing: an air or
// wrong block reads truthy, and activating it waits out the window timeout
// instead of failing (live 26.1 lesson).
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
      issueGoal(bot, ctx, new goals.GoalNear(homeTable.x, homeTable.y, homeTable.z, 3), key, false)
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
  const castleSpot = castleTableSpot(bot, ctx, bp, skip)
  if (castleSpot) {
    const k = `${castleSpot.at.x},${castleSpot.at.y},${castleSpot.at.z}`
    if (dist3(bp, castleSpot.at) > TABLE_REACH) {
      const key = `equip-castle-table:${k}`
      if (key !== ctx.lastGoalKey && bot.pathfinder && typeof bot.pathfinder.setGoal === 'function') {
        issueGoal(bot, ctx, new goals.GoalNear(castleSpot.at.x, castleSpot.at.y, castleSpot.at.z, 2), key, false)
      }
      st.castleTableWaits = (st.castleTableWaits || 0) + 1
      if (st.castleTableWaits <= 20) return Promise.resolve(null) // walking in
      try { skip.add(k) } catch (_) { /* skip best-effort */ } // stalled: roadside from here
    } else {
      ref = castleSpot.below
      at = castleSpot.at
    }
    st.castleTableWaits = 0
  }
  for (const [dx, dz] of (ref ? [] : [[1, 0], [-1, 0], [0, 1], [0, -1]])) {
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
    // B-foot blocked the bed, which fails loud by design). Reads the
    // bedfacts leaf (oqul.13); unreadable reads as placeable.
    try {
      if (require('./bedfacts').isBedroomCell(ctx && ctx.home, bx + dx, by, bz + dz)) continue
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
      // The castle residence's own station (no build claims it there).
      if (castleSpot && ref === castleSpot.below) ctx.home.table = new Vec3(at.x, at.y, at.z)
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

module.exports = { FAR_TABLE, PLACE_OVER, itemsOf, dist3, dayOf, tableFar, castleTableSpot, tableFor }
