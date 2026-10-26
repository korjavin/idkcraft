'use strict'

// flat: fill holes and trenches below the local surface level (bead w52).
//
// The owner asked (2026-09-27): near spawn everything is dug up and both the
// player and the bot keep getting stuck. `flat` scans a square around the
// player who gave the command (bot's position if nobody visible), takes the
// most common walkable ground height as the surface level, and caps every
// hole column at that level. Bumps above the level are out of scope for v1.
//
// Explicit player ORDER (like ctx.lead/ctx.bring), not a brain choice: while
// ctx.flat is set the ticker dispatches here instead of the brain/work,
// except fight which still preempts. Short errands (lead, bring) preempt the
// long job tick-by-tick and it resumes when they end; a mode change
// ('follow me', 'go work') cancels it, while 'stop' only parks it. A second
// `flat` from anywhere inside the running square resumes the episode with
// its progress instead of re-scanning (9k4: a stepped-aside retype wiped
// the run); only a new area or an explicit new radius starts over.
// Flooded ditches cap (7wt): liquid strictly below the level is an
// ordinary hole (the cap lands over the water); a surface at/above the
// level is a pond and stays skipped. After the shave, the sweep re-runs
// over stepped columns (recover pillar stairs placed mid-episode,
// including late pillars on newly stepped columns) through the same
// safety gates, and kept bump columns get one re-check: a freezing
// marker that is gone by shave end (the other bot's temporary scaffold,
// a torch since picked up) re-queues the column instead of freezing the
// next `flat`. Kept columns that stay frozen name their marker in the
// finish line, so the owner sees what to move instead of re-ordering.
//
// v2 (w52.1) shaves bumps above the level after filling the holes, top-down
// per column. Digging is allowlisted to natural terrain (ores, containers,
// beds, doors, wood/glass and everything built stay untouched) with a
// structure-marker gate around each dig, and never under anyone's feet.
//
// One behaviour tick advances at most one async place/dig flight (guarded by
// the shared ctx.placeInFlight / ctx.digInFlight seams, same as build/gather).
//
// xxmn (confident flat): an empty hand fetches fill in rounds — pack (vacuum
// this episode's littered drops), near (today's restock), wide (bigger
// radius, whole fill family), bring (home-chest withdraw when close) —
// before ending honestly with 'no fill blocks'. The shave carries an
// absolute tick budget: hilltop-scale bump fields stop with the middle flat
// (the queue runs nearest-first) and far leftovers skip as 'budget', so the
// build-here check still finds a site. Kept columns (a standing house)
// resolve by routing around, not by shrinking either side: the episode ends
// honestly naming the marker, and the build-here check only needs one of
// siteFor's 8 footprints to fit beside the house. Water stays skipped by
// owner rule (flat runs on dry spots).

const Vec3 = require('vec3')
const { goals } = require('mineflayer-pathfinder')
const { countItems } = require('../perception')
const danger = require('../danger')
const stuck = require('../stuck')
const util = require('./util')
const { say, clearGoal, denyReason, logDeny } = util

const FLAT_DEFAULT_RADIUS = 8 // bare `flat` (owner 2026-09-27: 97x97 hid the bot for half an hour)
const FLAT_MIN_RADIUS = 4
const FLAT_MAX_RADIUS = 64
const SCAN_PER_TICK = 1200 // columns per tick; an r=48 field scans in ~8 ticks
const SCAN_UP = 10 // scan ceiling = command-time feet + this
const SCAN_DOWN = 70 // scan floor = ceiling - this (deeper reads as deep)
const SCAN_UP_EXTEND = 30 // climb past a solid ceiling to find the true top
const PLACE_ATTEMPTS = 3 // refused placements per hole before skip
const DIG_ATTEMPTS = 3 // failed digs per bump column before skip
const PICKUP_STALLS = 6 // pickup-walk ticks before the drop is left as litter
const REACH_DIG = 4.5 // survival dig reach; past this the approach is stale
const WALK_STALLS = 10 // no-displacement walk ticks before defer (gather scale)
const HOLE_DEFERS = 4 // queue rotations before an unplaceable hole is skipped
const OCC_DEFERS = 6 // rotations before an occupied cell is skipped
const SUPPORT_DEPTH = 4 // support fills below one cap before deferring
const SELF_OCC_LIMIT = 6 // sidesteps out of our own cap cell before skip
const TRAVEL_REISSUE = 5 // idle travel ticks before the far-square goal is re-issued
const TRAVEL_FAR = 24 // blocks past the square edge (Chebyshev) beyond which fill/shave walks in first
const TRAVEL_STALL_TICKS = 120 // travel ticks without getting nearer before giving up
const SIDESTEPS = [[3, 0], [-3, 0], [0, 3], [0, -3]]
const PROGRESS_MS = 120000 // progress chat cadence on the long job
const FIRST_PROGRESS_MS = 25000 // first progress comes fast: 2 min of silence reads as broken
const FIRST_PROGRESS_N = 10 // ...or after this many resolved cells, whichever first
const BACKSTOP_TICKS = 180 // ticks without any placement/skip before giving up
const DIG_TARGET = 64 // v8bq: a full stack per restock episode — one dig-zone trip stages the whole pack, not per-block fetch marathons
const RESTOCK_SLACK = 4 // v8bq R1: support slack past the holes left — deep caps draw the same pack, but a small tail never justifies a full stack
const FILL_RESUME = 32 // v8bq/x3y6.4: fill blocks banked from own bumps before filling resumes (half a stack, so the resumed fill run earns its walk)
const DIG_TICKS = 480 // v8bq: restock budget before resuming with what is on hand (room for a full DIG_TARGET stack: walk + dig + pickup per block)
const DIG_STALLS = 10
const DIG_STREAK = 3
// xxmn fill-fetch chain: an empty hand works pack -> near -> wide -> bring
// before the episode ends honestly with 'no fill blocks'. Near is today's
// restock; wide reaches dirt the near radius cannot (prod 2026-10-24: bots
// dug everything within 48 and stopped with 49 holes left); bring draws the
// home chest when it is close enough to walk to mid-order.
const WIDE_DIG_RADIUS = 128 // wide restock search radius (near stays 48)
const PACK_TICKS = 180 // litter-vacuum budget per restock episode
const BRING_TICKS = 600 // home-chest fetch budget (walks there, then back to the holes)
const BRING_RANGE = 192 // home chest past this from the body: too far, skip honestly
const INTERACT_CLOSE = 4 // window-open reach (packroom INTERACT_REACH mirror)
const LITTER_MAX = 64 // timed-out drop cells remembered per episode
// xxmn bump budget: hilltop-scale bump fields (prod: 187) never converge in
// session time. The shave queues nearest-first, so by the time this trips
// the middle is flat and only far edges are skipped honestly as 'budget' -
// and the build-here check still finds a site on the flat middle.
const SHAVE_TICKS = 1200 // absolute shave effort budget (~20 min at 1 s ticks)
const PLACE_RANGE = 4 // GoalPlaceBlock range, like build.js
const EYE_HEIGHT = 1.62 // survival eye height above the feet
const EYE_REACH = 4.4 // server survival block reach (4.5) minus pose/float margin
const MOVE_TOLERANCE = stuck.MOVE_TOLERANCE
const DIRT_FIND_RADIUS = 48
const DIRT_FIND_COUNT = 64
const RESTOCK_MIN_EDGE_GAP = 16 // restock digs at least this far past the square edge (owner 2026-09-28: digging at the edge left fresh holes next to the flattened area)

// Fill allowlist: cheap full cubes only. No gravity blocks (sand/gravel
// would fall through the cap), no ores/logs/planks (valuables and goal
// materials stay untouched). Order = placement preference: dirt-family
// first, stone/cobble last (the bot may still need those for tools).
const FILL_BLOCKS = [
  'dirt', 'grass_block', 'coarse_dirt', 'rooted_dirt',
  'tuff', 'andesite', 'granite', 'diorite',
  'stone', 'cobblestone',
]
const FILL_SET = new Set(FILL_BLOCKS)

function isFillBlock(name) {
  return typeof name === 'string' && FILL_SET.has(name)
}

// Restock digs dirt in the zone past RESTOCK_MIN_EDGE_GAP (never inside:
// digging there would punch the new holes the order exists to remove). All
// three drop dirt. Until the shared canBreak guard lands (drq), restock
// stays inside this natural family plus the structure gate in findDirt.
const DIRT_NAMES = new Set(['dirt', 'grass_block', 'coarse_dirt'])

function isDirtName(name) {
  return typeof name === 'string' && DIRT_NAMES.has(name)
}

// Bump-shaving allowlist: natural terrain only. Everything valuable or built
// (ores, logs, planks, containers, beds, doors, glass, dirt paths, farmland)
// is excluded by construction — an unlisted block is kept, never dug.
// Cobblestone/mossy/cobbled-deepslate/snow_block are deliberately absent:
// they never generate as surface terrain, so above the level they are
// player builds (round-1 core-1/body-1). Sandstone and packed ice stay
// because deserts and icebergs grow them, with the structure gate covering
// adjacent builds.
const DIG_ALLOWLIST = new Set([
  'dirt', 'grass_block', 'coarse_dirt', 'rooted_dirt', 'podzol', 'mycelium',
  'mud', 'clay', 'gravel', 'sand', 'red_sand', 'sandstone', 'red_sandstone',
  'stone', 'andesite', 'granite', 'diorite',
  'tuff', 'deepslate', 'calcite', 'dripstone_block',
  'snow', 'ice', 'packed_ice',
  'netherrack', 'basalt', 'blackstone', 'soul_sand', 'soul_soil',
  'magma_block', 'end_stone',
])

function isDiggable(name) {
  return typeof name === 'string' && DIG_ALLOWLIST.has(name)
}

// Conservative gate: a dig target with any of these within one block is left
// alone, so the job never eats into a house, a farm, a mine with torches or
// a decorated cave (w52.1). Substring match over snake_case names.
const STRUCTURE_MARKERS = [
  'door', 'bed', 'chest', 'shulker', 'barrel', 'furnace', 'hopper', 'dropper',
  'dispenser', 'lectern', 'grindstone', 'stonecutter', 'smithing', 'brewing',
  'cauldron', 'composter', 'loom', 'cartography', 'fletching', 'anvil',
  'enchant', 'bookshelf', 'torch', 'lantern', 'glass', 'planks', 'log',
  'leaves', 'stairs', 'slab', 'fence', 'wall', 'brick', 'ore', 'debris',
  'spawner', 'bell', 'button', 'pressure_plate', 'rail', 'carpet', 'sign',
  'banner', 'flower_pot', 'candle', 'chain', 'iron_bars', 'obsidian',
  'anchor', 'conduit', 'beacon', 'lodestone',
]

function isStructureMarker(name) {
  if (typeof name !== 'string') return false
  return STRUCTURE_MARKERS.some((m) => name.includes(m))
}

// Face-neighbour liquid: digging next to a spring or lava pool would let it
// flow over the leveled area, so the column is skipped instead (core-4).
// Returns 'water', 'lava' or null.
function liquidNear(bot, x, y, z) {
  const dirs = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]
  for (const [ox, oy, oz] of dirs) {
    const name = blockNameAt(bot, new Vec3(x + ox, y + oy, z + oz))
    if (name === 'lava') return 'lava'
    if (name === 'water' || name === 'bubble_column') return 'water'
  }
  return null
}

// First marker name in the 26 neighbours, or null. The target itself is
// allowlisted natural terrain, so only the ring is checked.
function structureNear(bot, x, y, z) {
  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      for (let dz = -1; dz <= 1; dz++) {
        if (dx === 0 && dy === 0 && dz === 0) continue
        const name = blockNameAt(bot, new Vec3(x + dx, y + dy, z + dz))
        if (isStructureMarker(name)) return name
      }
    }
  }
  return null
}

function isLiquidName(name) {
  return name === 'water' || name === 'lava' || name === 'bubble_column'
}

function isSolidCell(b) {
  return !!b && b.boundingBox !== 'empty' && !isLiquidName(b.name)
}

// nullAsAir covers the build-limit ceiling above a loaded column: only call
// it with true once the column itself has proven loaded.
function isAirCell(b, nullAsAir) {
  if (b == null) return !!nullAsAir
  return b.boundingBox === 'empty' && !isLiquidName(b.name)
}



function keyOf(x, y, z) {
  return `${x},${y},${z}`
}

function dist3(a, b) {
  if (a && typeof a.distanceTo === 'function') return a.distanceTo(b)
  if (b && typeof b.distanceTo === 'function') return b.distanceTo(a)
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)
}

// Progress is horizontal displacement or a new standing level. Tower jumps
// pump y in place: jumping is standing still (gather.js rule).
function progressed(bp, last, grounded) {
  if (!last) return true
  if (Math.hypot(bp.x - last.x, bp.z - last.z) > MOVE_TOLERANCE) return true
  return !!grounded && Math.floor(bp.y) !== Math.floor(last.y)
}

// One cell read: 'solid' | 'air' | 'liquid' | 'unloaded'.
function cellAt(bot, x, y, z) {
  let b = null
  try {
    b = bot.blockAt(new Vec3(x, y, z))
  } catch (_) {
    return 'unloaded'
  }
  if (b == null) return 'unloaded'
  if (isLiquidName(b.name)) return 'liquid'
  return b.boundingBox === 'empty' ? 'air' : 'solid'
}

function blockNameAt(bot, p) {
  try {
    const b = bot.blockAt(p)
    return b && typeof b.name === 'string' ? b.name : null
  } catch (_) {
    return null
  }
}

// Column probe for the scan: blockAt(x, y, z) is injected so unit tests can
// feed synthetic grids. Returns one of:
//   { status: 'unloaded' }                    chunk not loaded, skip + report
//   { status: 'bump' }                        solid past the climb cap: inside a hill
//   { status: 'liquid', topY }                bottomless water/lava: skip + report
//   { status: 'deep' }                        no ground down to yBottom
//   { status: 'ok', topY, walkable }          ground found
//   { status: 'ok', topY, walkable, liquidTop }
//     flooded ditch (7wt): solid bottom under a liquid surface. The level
//     decides post-scan: surface at/above the level is a pond (skip),
//     strictly below it is an ordinary hole (cap over the water).
function probeColumn(blockAt, x, z, yTop, yBottom) {
  const at = (y) => {
    try {
      return blockAt(x, y, z)
    } catch (_) {
      return null
    }
  }
  let top = at(yTop)
  if (top == null) return { status: 'unloaded' }
  let y = yTop
  while (isSolidCell(top) && y < yTop + SCAN_UP_EXTEND) {
    y++
    top = at(y)
    if (top == null) break
  }
  if (top != null && isSolidCell(top)) return { status: 'bump' }
  let liquidTop = null
  for (let d = y; d >= yBottom; d--) {
    const b = d === y ? top : at(d)
    if (b == null) continue // mid-scan null: defensive air
    if (isLiquidName(b.name)) {
      if (liquidTop == null) liquidTop = d // surface: keep diving for the bottom
      continue
    }
    if (isSolidCell(b)) {
      const walkable = isAirCell(at(d + 1), true) && isAirCell(at(d + 2), true)
      if (liquidTop != null) return { status: 'ok', topY: d, walkable, liquidTop }
      return { status: 'ok', topY: d, walkable }
    }
  }
  if (liquidTop != null) return { status: 'liquid', topY: liquidTop }
  return { status: 'deep' }
}

// Scan order: rings around the center, so the nearest holes are found (and
// later filled) first even if the scan is interrupted.
function spiralColumns(cx, cz, r) {
  const out = [{ x: cx, z: cz }]
  for (let d = 1; d <= r; d++) {
    for (let dx = -d; dx <= d; dx++) {
      for (let dz = -d; dz <= d; dz++) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== d) continue
        out.push({ x: cx + dx, z: cz + dz })
      }
    }
  }
  return out
}

// Surface level = the most common walkable ground height (mode). Ties go to
// the lower level: less filling, and bumps stay out of scope either way.
function chooseLevel(tops) {
  if (!Array.isArray(tops) || tops.length === 0) return null
  const counts = new Map()
  for (const y of tops) {
    if (typeof y !== 'number') continue
    counts.set(y, (counts.get(y) || 0) + 1)
  }
  let best = null
  let bestN = 0
  for (const [y, n] of counts) {
    if (n > bestN || (n === bestN && (best == null || y < best))) {
      best = y
      bestN = n
    }
  }
  return best
}

// v8bq sweep order: nearest-to-bot, not center-out. The scan sorts both
// queues nearest-first from the square centre, but drift, knockback and
// defer rotations move the body mid-episode — walking the stale order
// then crosses the whole square per block (prod xxmn: 2.5 blocks/min).
// After every completion the holes re-sort around the live body (the
// orderDirty flag, applied at the next fill tick): fresh cells
// nearest-first with row locality (same-row neighbours win ties, so the
// walk sweeps rows instead of zig-zagging), deferred cells (def/occ/att
// burned) after fresh ones so a floating cap still closes ring-by-ring
// instead of burning its defers up front. Deterministic (deferred,
// distance, row gap, z, x) so unit pins hold. Bumps re-sort centre-out
// in bands instead (orderBumpsByBot, v8bq R1): the hilltop budget only
// skips far edges honestly when the middle went flat first.
// Hole queue from the scan records: walkable columns below the level plus
// deep columns, nearest first (Chebyshev, then Euclidean, then x/z for a
// deterministic order unit tests can pin).
function detectHoles(records, level, cx, cz) {
  const holes = []
  for (const rec of records || []) {
    if (!rec || typeof rec.x !== 'number' || typeof rec.z !== 'number') continue
    if (rec.deep) holes.push({ x: rec.x, z: rec.z, topY: null })
    else if (typeof rec.topY === 'number' && rec.topY < level) holes.push({ x: rec.x, z: rec.z, topY: rec.topY })
  }
  const cheb = (h) => Math.max(Math.abs(h.x - cx), Math.abs(h.z - cz))
  holes.sort((a, b) => (cheb(a) - cheb(b)) ||
    (Math.hypot(a.x - cx, a.z - cz) - Math.hypot(b.x - cx, b.z - cz)) ||
    (a.x - b.x) || (a.z - b.z))
  return holes.map((h) => ({ ...h, att: 0, def: 0, sup: 0, occ: 0, stalls: 0, lastPos: null }))
}

// Bump queue (w52.1): walkable columns above the level, same nearest-first
// order as the holes. y is the next dig target: the column shaves top-down
// from topY to the level, so gravity blocks never hang unsupported.
function detectBumps(records, level, cx, cz) {
  const bumps = []
  for (const rec of records || []) {
    if (!rec || typeof rec.x !== 'number' || typeof rec.z !== 'number') continue
    if (rec.deep || typeof rec.topY !== 'number' || rec.topY <= level) continue
    bumps.push({ x: rec.x, z: rec.z, topY: rec.topY, y: rec.topY })
  }
  const cheb = (h) => Math.max(Math.abs(h.x - cx), Math.abs(h.z - cz))
  bumps.sort((a, b) => (cheb(a) - cheb(b)) ||
    (Math.hypot(a.x - cx, a.z - cz) - Math.hypot(b.x - cx, b.z - cz)) ||
    (a.x - b.x) || (a.z - b.z))
  return bumps.map((h) => ({ ...h, att: 0, def: 0, occ: 0, stalls: 0, lastPos: null, gateY: null, pickup: null }))
}

// v8bq R1: bumps keep the centre-out budget guarantee — the SHAVE_TICKS
// budget skips far leftovers honestly only when the middle is flat
// first. Rings (Chebyshev bands around the square centre) go in order;
// ties break nearest-to-bot, so the walk still sweeps locally instead
// of crossing the ring. Deferred cells sink like in orderByBot.
function orderBumpsByBot(cells, bp, cx, cz) {
  if (!Array.isArray(cells) || cells.length < 2) return cells
  const bx = bp && typeof bp.x === 'number' ? bp.x : null
  const bz = bp && typeof bp.z === 'number' ? bp.z : null
  if (bx == null || bz == null || typeof cx !== 'number' || typeof cz !== 'number') return cells
  const band = (c) => Math.max(Math.abs(c.x - cx), Math.abs(c.z - cz))
  const deferred = (c) => {
    if (!c) return 0
    return ((c.def || 0) > 0 || (c.occ || 0) > 0 || (c.att || 0) > 0) ? 1 : 0
  }
  cells.sort((a, b) => (band(a) - band(b)) ||
    (deferred(a) - deferred(b)) ||
    (Math.hypot(a.x - bx, a.z - bz) - Math.hypot(b.x - bx, b.z - bz)) ||
    (a.z - b.z) || (a.x - b.x))
  return cells
}

// v8bq: re-sort a work queue around the live body (see the sweep-order
// note above detectHoles). Deferred cells sink below fresh ones; the
// rest is nearest-first with row locality. Returns the same array.
// Holes only — bumps use orderBumpsByBot above, so the hilltop budget
// still finds a flat middle when it trips.
function orderByBot(cells, bp) {
  if (!Array.isArray(cells) || cells.length < 2) return cells
  const bx = bp && typeof bp.x === 'number' ? bp.x : null
  const bz = bp && typeof bp.z === 'number' ? bp.z : null
  if (bx == null || bz == null) return cells
  const deferred = (c) => {
    if (!c) return 0
    return ((c.def || 0) > 0 || (c.occ || 0) > 0 || (c.att || 0) > 0) ? 1 : 0
  }
  cells.sort((a, b) => (deferred(a) - deferred(b)) ||
    (Math.hypot(a.x - bx, a.z - bz) - Math.hypot(b.x - bx, b.z - bz)) ||
    (Math.abs(a.z - bz) - Math.abs(b.z - bz)) ||
    (a.z - b.z) || (a.x - b.x))
  return cells
}

function findFillItem(bot) {
  let items = []
  try {
    items = (bot.inventory && typeof bot.inventory.items === 'function' ? bot.inventory.items() : []) || []
  } catch (_) {
    return null
  }
  let best = null
  let bestRank = Infinity
  for (const item of items) {
    if (!item || typeof item.name !== 'string') continue
    const rank = FILL_BLOCKS.indexOf(item.name)
    if (rank !== -1 && rank < bestRank) {
      bestRank = rank
      best = item
    }
  }
  return best
}

function countFill(bot) {
  return countItems(bot, isFillBlock)
}

function idsFor(bot, names) {
  const byName = (bot.registry && bot.registry.blocksByName) || {}
  const want = names instanceof Set ? names : new Set(names || [])
  const ids = []
  for (const name of Object.keys(byName)) {
    if (!want.has(name)) continue
    const entry = byName[name]
    if (entry && typeof entry.id === 'number' && !ids.includes(entry.id)) ids.push(entry.id)
  }
  return ids
}

function dirtIds(bot) {
  return idsFor(bot, DIRT_NAMES)
}

// xxmn: the wide restock round digs the whole fill family, not just dirt —
// every name here is placeable as fill, so a surface stone banks cobble.
function fillIds(bot) {
  return idsFor(bot, FILL_BLOCKS)
}

function covers(ent, x, y, z) {
  const p = ent && ent.position
  if (!p || typeof p.x !== 'number' || typeof p.y !== 'number' || typeof p.z !== 'number') return false
  const fx = Math.floor(p.x)
  const fy = Math.floor(p.y)
  const fz = Math.floor(p.z)
  return fx === x && fz === z && (fy === y || fy + 1 === y)
}

// Never place into the bot's own feet/head or any visible player's feet/head.
// Split three ways: self-occupancy steps aside (the bot can move), a camping
// player counts toward the skip, and the union stays for support cells.
function cellOccupiedSelf(bot, x, y, z) {
  try {
    return !!(bot.entity && covers(bot.entity, x, y, z))
  } catch (_) {
    return false
  }
}

function cellOccupiedByPlayer(bot, x, y, z) {
  try {
    // Raw roster, worker included on purpose (revmux 02 core-1): this is a
    // collision check, not a presence count, and the worker has a hitbox.
    for (const player of Object.values((bot && bot.players) || {})) {
      if (player && player.entity && covers(player.entity, x, y, z)) return true
    }
  } catch (_) { /* unverifiable: treat as free, the place may refuse */ }
  return false
}

// A mob standing in the cap cell makes the server reject the placement
// (cm0.1: verified on the rig — 0/6 placed into a sheep, 6/6 into the
// empty cell). Attempting into it burns all three attempts and skips a
// fillable hole as refused, so a mob waits out like a player instead.
// Only colliding entities count: drops, orbs and projectiles never block
// a placement (5/5 placed into a cell holding only a drop), so a hole
// holding a stray drop still places. Boats count: they do collide.
const NONBLOCKERS = new Set(['item', 'item_stack', 'experience_orb'])
// Wide-mob overhang (hzw): covers() only tests the floored centre, but a
// cow (0.9) or spider (1.4) centred in the neighbour cell overhangs the
// cap with its hitbox and the server still refuses the placement (rig:
// overhanging cow/spider 0/6 each, same 'still air' text). For mobs test
// box overlap instead; players/self keep covers(). A missing width
// (unknown entity, old mocks) falls back to covers(), i.e. cm0.1 behavior.
function mobOverlaps(ent, x, y, z) {
  const p = ent && ent.position
  if (!p || typeof p.x !== 'number' || typeof p.y !== 'number' || typeof p.z !== 'number') return false
  const w = ent.width
  if (typeof w !== 'number' || !Number.isFinite(w) || w <= 0) return covers(ent, x, y, z)
  if (Math.abs(p.x - (x + 0.5)) >= 0.5 + w / 2) return false
  if (Math.abs(p.z - (z + 0.5)) >= 0.5 + w / 2) return false
  const fy = Math.floor(p.y)
  return fy === y || fy + 1 === y
}
function cellOccupiedByMob(bot, x, y, z) {
  try {
    for (const e of Object.values((bot && bot.entities) || {})) {
      if (!e || !e.position) continue
      if (e.type === 'player' || e.type === 'projectile') continue
      if (bot.entity && e === bot.entity) continue
      if (NONBLOCKERS.has((e.name || '').toLowerCase())) continue
      if (mobOverlaps(e, x, y, z)) return true
    }
  } catch (_) { /* unverifiable: treat as free, the place may refuse */ }
  return false
}

function cellOccupied(bot, x, y, z) {
  return cellOccupiedSelf(bot, x, y, z) || cellOccupiedByPlayer(bot, x, y, z)
}

// Dig threat: the target is inside someone's feet/head cell, or directly
// under their feet (digging it drops them). Split self/others like the
// occupancy checks: the bot steps aside, a player waits out or skips.
function threatens(ent, x, y, z) {
  const p = ent && ent.position
  if (!p || typeof p.x !== 'number' || typeof p.y !== 'number' || typeof p.z !== 'number') return false
  // The hitbox is 0.6 wide: a player on the edge of the target still stands
  // on it even when their centre floors to the neighbour column (core-3).
  const xs = new Set([Math.floor(p.x - 0.3), Math.floor(p.x + 0.3)])
  const zs = new Set([Math.floor(p.z - 0.3), Math.floor(p.z + 0.3)])
  if (!xs.has(x) || !zs.has(z)) return false
  const fy = Math.floor(p.y)
  return fy === y || fy + 1 === y || fy - 1 === y
}

function threatenedSelf(bot, x, y, z) {
  try {
    return !!(bot.entity && threatens(bot.entity, x, y, z))
  } catch (_) {
    return false
  }
}

function threatenedByPlayer(bot, x, y, z) {
  try {
    // Same intentional worker inclusion as cellOccupiedByPlayer (revmux 02).
    for (const player of Object.values((bot && bot.players) || {})) {
      if (player && player.entity && threatens(player.entity, x, y, z)) return true
    }
  } catch (_) { /* unverifiable: treat as free, the dig may refuse */ }
  return false
}

// Neighbor scan order: below first — a 1-deep hole's cap sits on the ground,
// so the reference is almost always the block under the cap.
const REF_DIRS = [
  [0, -1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0],
]

// Verified stand (cm0): the approach goal was validated for the goal's own
// faces from a hypothetical node, but the body places from wherever the
// pathfinder actually stalled — possibly a partial-end with the clicked
// face out of eye reach or behind a wall. Re-check the ACTUAL click from
// the LIVE body position before every attempt: eyes within server reach of
// the clicked face point, and the same ray the server traces (eyes along
// the face-center aim) must hit the reference block. A missing raycast
// (unit mocks) falls back to the reach gate only, so old harnesses keep
// today's behavior.
function facePoint(refPos, face) {
  return new Vec3(refPos.x + 0.5 + face.x * 0.5, refPos.y + 0.5 + face.y * 0.5, refPos.z + 0.5 + face.z * 0.5)
}

function standVerified(bot, bp, ref, face) {
  const eyes = new Vec3(bp.x, bp.y + EYE_HEIGHT, bp.z)
  const to = facePoint(ref.position, face)
  const dx = to.x - eyes.x
  const dy = to.y - eyes.y
  const dz = to.z - eyes.z
  const dist = Math.sqrt(dx * dx + dy * dy + dz * dz)
  if (!(dist <= EYE_REACH)) return false
  return rayHitsRef(bot, eyes, to, dist, ref)
}

// The click ray (cm0): the same ray the server traces (eyes along the
// face-center aim) must hit the reference block. Shared by the stand
// check and the visibility-ordered reference scan below.
function rayHitsRef(bot, eyes, to, dist, ref) {
  let hit = null
  try {
    if (!bot.world || typeof bot.world.raycast !== 'function') return true
    const dx = to.x - eyes.x
    const dy = to.y - eyes.y
    const dz = to.z - eyes.z
    const len = dist || 1
    hit = bot.world.raycast(eyes, new Vec3(dx / len, dy / len, dz / len), EYE_REACH)
  } catch (_) {
    return true // unverifiable: reach gate only (lenient mocks)
  }
  if (!hit) return false // ref vanished (dug?) or ray unreadable: don't burn
  try {
    const hp = hit.position
    const rp = ref.position
    return !!hp && !!rp && hp.x === rp.x && hp.y === rp.y && hp.z === rp.z
  } catch (_) {
    return true
  }
}

// The reference is a real Block, not a position: bot.placeBlock derefs
// referenceBlock.position on the first line, so a bare Vec3 rejects every
// placement (build.js live bug).
function findRef(bot, p, bp) {
  // Visibility-ordered (cm0 revmux-01): below-first returns the pit floor,
  // whose top face a far stand cannot see (the click ray clips the near
  // wall) — and the stand check then def-loops to unreachable instead of
  // using the visible pit-wall face GoalPlaceBlock stopped for. Prefer the
  // first face the live eyes can actually click; fall back to the first
  // solid-backed face when no body position is given (unit mocks) or
  // nothing is visible (the stand check then defers honestly).
  let fallback = null
  let eyes = null
  try {
    if (bp && typeof bp.x === 'number') eyes = new Vec3(bp.x, bp.y + EYE_HEIGHT, bp.z)
  } catch (_) { eyes = null }
  for (const [ox, oy, oz] of REF_DIRS) {
    const q = new Vec3(p.x + ox, p.y + oy, p.z + oz)
    let block = null
    try {
      block = bot.blockAt(q)
    } catch (_) { /* treat as open */ }
    if (block && isSolidCell(block) && !util.isInteractRef(block.name)) {
      const cand = { ref: block, face: new Vec3(-ox, -oy, -oz) }
      if (!fallback) fallback = cand
      if (eyes) {
        const to = facePoint(block.position, cand.face)
        const dist = Math.sqrt((to.x - eyes.x) ** 2 + (to.y - eyes.y) ** 2 + (to.z - eyes.z) ** 2)
        if (dist <= EYE_REACH && rayHitsRef(bot, eyes, to, dist, block)) return cand
      }
    }
  }
  return fallback
}

// Surface guard (body-4): while flat owns the body the pathfinder must not
// dig steps out of the square it is leveling — a GoalPlaceBlock approach
// across an uncapped trench would otherwise notch the surface behind the
// scan. Same exclusionAreasBreak seam as build.guardOwnWalls, but the
// predicate only bites while a flat goal is pursued: lead/bring preempt the
// job tick-by-tick with their own goals, and their searches must still dig
// (round-2 majors). Goal ownership (not the tick) is the switch, so a
// multi-tick flat search stays guarded to its end, while a cancel path
// ('follow me', 'go work', 'stop') or a replaced episode no-ops at once.
// The place seam is the mirror (idkcraft-3dkn): pathfinder 2.4.5 DOES
// scaffold (1x1 towers, jump-up steps, bridges), and a tower on a just-
// shaved cell looped "shave, place, shave" in prod — so no pathfinder
// placement above the level inside the square; at/below it (bridging an
// unfilled hole) stays allowed. flat's own fill places bypass the seam.
function guardFlatSurface(bot, ctx) {
  try {
    const mov = bot && bot.pathfinder && bot.pathfinder.movements
    if (!mov || !Array.isArray(mov.exclusionAreasBreak)) return
    const f = ctx && ctx.flat
    const key = f ? f.key : null
    if (ctx.flatGuardKey === key && ctx.flatGuardMov === mov) return
    if (ctx.flatGuardFn) {
      const { brk, plc } = ctx.flatGuardFn
      for (const m of new Set([ctx.flatGuardMov, mov])) {
        if (m && Array.isArray(m.exclusionAreasBreak)) m.exclusionAreasBreak = m.exclusionAreasBreak.filter((fn) => fn !== brk)
        if (m && Array.isArray(m.exclusionAreasPlace)) m.exclusionAreasPlace = m.exclusionAreasPlace.filter((fn) => fn !== plc)
      }
      ctx.flatGuardFn = null
    }
    ctx.flatGuardMov = mov
    ctx.flatGuardKey = key
    if (!f) return
    // Live flat goal and the cell inside the square → its height over the
    // level; anything else → null (guard off).
    const overLevel = (block) => {
      const cur = ctx.flat
      if (!cur || cur.key !== key || cur.parked || cur.level == null) return null
      if (!/^flat[:-]/.test(ctx.lastGoalKey || '')) return null
      const q = block && block.position
      if (!q || typeof q.x !== 'number' || typeof q.y !== 'number' || typeof q.z !== 'number') return null
      if (Math.abs(q.x - cur.cx) > cur.r || Math.abs(q.z - cur.cz) > cur.r) return null
      return q.y - cur.level
    }
    const brk = (block) => { try { const d = overLevel(block); return d != null && d <= 0 ? 100 : 0 } catch (_) { return 0 } }
    const plc = (block) => { try { const d = overLevel(block); return d != null && d > 0 ? 100 : 0 } catch (_) { return 0 } }
    mov.exclusionAreasBreak.push(brk)
    if (Array.isArray(mov.exclusionAreasPlace)) mov.exclusionAreasPlace.push(plc)
    ctx.flatGuardFn = { brk, plc }
  } catch (_) { /* best-effort: approach still walks */ }
}

// Chat radius argument: missing = default, numeric clamped to the 4..64
// window, anything else = null (the caller prints the usage hint).
function parseRadius(arg) {
  if (arg == null || arg === '') return FLAT_DEFAULT_RADIUS
  if (!/^\d+$/.test(String(arg).trim())) return null
  const n = parseInt(String(arg).trim(), 10)
  if (!Number.isFinite(n)) return null
  return Math.min(FLAT_MAX_RADIUS, Math.max(FLAT_MIN_RADIUS, n))
}

// Resume line for a parked episode: counts both queues, so resuming into
// the shave phase does not report a misleading "0 holes left".
function resumeLine(f) {
  if (f.phase === 'scan') return `still scanning ${2 * f.r + 1}x${2 * f.r + 1}…`
  const holes = f.holes.length
  const bumps = f.bumps.length
  if (f.totalBumps > 0) return `resuming flat, ${holes} holes + ${bumps} bumps left`
  return `resuming flat, ${holes} holes left`
}

// Flat swarm (lhg2): BOT_SWARM_N bots split one square into N x-strips;
// bot BOT_SWARM_I (0..N-1) works strip I. null (N unset/1, bad I) = whole
// square, the single-bot behaviour. Every bot scans the WHOLE square so the
// level vote is identical; only its own strip's holes/bumps are queued.
function swarmTile(env = process.env) {
  const n = parseInt(env.BOT_SWARM_N || '', 10)
  const i = parseInt(env.BOT_SWARM_I || '0', 10)
  if (!(n > 1) || !(i >= 0 && i < n)) return null
  return { i, n }
}

// tpd1: a swarm helper (strip >= 1) is flat-only — no follow, no work.
const SWARM_HELPER_LINE = 'swarm helper: flat only'
function swarmHelper(env = process.env) {
  const t = swarmTile(env)
  return !!(t && t.i >= 1)
}

// Strip index of column x in the square cx±r: disjoint and covering by
// construction (floor of a monotone map onto 0..n-1).
function stripOf(x, cx, r, n) {
  return Math.floor(((x - (cx - r)) * n) / (2 * r + 1))
}

function inTile(f, x, z) {
  return !f.tile || stripOf(x, f.cx, f.r, f.tile.n) === f.tile.i
}

// x3y6.3 work stealing: the bot's own strip {i, n} — f.steal while it works
// another strip (f.tile = the victim then), else f.tile; null = no swarm.
function homeOf(f) {
  return f.steal || f.tile
}

// Victim strip for a steal: most holes+bumps left over k != home, ties to
// the lowest k (deterministic, every thief agrees); null below STEAL_MIN.
const STEAL_MIN = 8
function stealVictim(cells, f) {
  const { i: home, n } = f.steal
  const left = new Array(n).fill(0)
  for (const c of cells) left[stripOf(c.x, f.cx, f.r, n)]++
  let best = -1
  for (let k = 0; k < n; k++) if (k !== home && (best < 0 || left[k] > left[best])) best = k
  return best >= 0 && left[best] >= STEAL_MIN ? { i: best, left: left[best] } : null
}

// zchb: the surface level under a standing player = the block their feet
// rest on (a slab top at y+0.5 reads as that slab's block).
function feetLevel(pos) {
  return Math.floor(pos.y - 0.01)
}

// zchb: the main bot (strip 0) relays the ONE resolved square to its helpers
// in chat; `level mode` = no fixed level, every bot votes the same square.
function relayLine(f) {
  return `swarm flat ${f.r} ${f.cx} ${f.cz} y${f.yTop - SCAN_UP} level ${f.fixedLevel == null ? 'mode' : f.fixedLevel} by ${f.by}`
}
function parseRelay(msg) {
  const m = /^swarm flat (\d+) (-?\d+) (-?\d+) y(-?\d+) level (-?\d+|mode) by (\S+)$/.exec(String(msg).trim())
  if (!m) return null
  const radius = parseRadius(m[1])
  if (radius == null) return null
  return { radius, cx: +m[2], cz: +m[3], feet: +m[4], level: m[5] === 'mode' ? null : +m[5], by: m[6] }
}

// The anchor column and the square's corners are loaded for this bot (a
// far bot would vote the level on a partial square, review 01 tpd1).
function squareLoaded(bot, cx, cz, r, y) {
  try {
    return [[0, 0], [r, r], [r, -r], [-r, r], [-r, -r]].every(([dx, dz]) => bot.blockAt(new Vec3(cx + dx, y, cz + dz)) != null)
  } catch (_) { return false }
}

function startEpisode(cx, cz, r, yTop, by, tile = null, level = null) {
  return {
    key: `${cx},${cz},${r}`,
    cx, cz, r, by: by || 'you', tile,
    fixedLevel: level, // zchb: speaker feet level; null = mode vote
    yTop, yBottom: yTop - SCAN_DOWN,
    phase: 'scan',
    scan: { queue: spiralColumns(cx, cz, r), i: 0 },
    tops: [],
    cands: [],
    liquidCols: [],
    stepped: new Set(),
    bumpCols: null,
    swept: false,
    sweptTops: null, // stepped key -> topY already offered to the sweep
    sweptN: 0,
    sweepTotal: 0,
    keptMarkers: {}, // freezing marker name -> kept column count (finish line)
    keptCols: [], // { x, z, marker } kept bump columns for the shave-end re-check
    rechecked: false,
    counts: { unloaded: 0, liquid: 0, bump: 0, covered: 0 },
    level: null,
    holes: [],
    total: 0,
    filled: 0,
    supports: 0,
    bumps: [],
    totalBumps: 0,
    shaved: 0,
    shaveTicks: 0, // xxmn: absolute shave effort (hilltop budget)
    litter: [], // xxmn: { k, x, y, z } drop cells whose pickup timed out
    skip: { water: 0, lava: 0, occupied: 0, unreachable: 0, floating: 0, refused: 0, kept: 0, budget: 0 },
    abortWhy: null,
    parked: false,
    issuedKey: null,
    ticks: 0,
    lastProgressTick: 0,
    blocks: 0, // dug + placed blocks (x3y6.2: the goal watchdog's flat metric)
    lastChat: 0,
    progressChats: 0,
    dig: null,
    orderDirty: false, // v8bq: set after every completion; the next fill/shave tick re-sorts around the body
    travelIdle: 0,
    travelBest: null,
    travelStall: 0,
  }
}

// Queue ops: every hole leaves the head, either filled, skipped (counted by
// reason for the final report) or rotated to the back for a later pass —
// neighbours capped in between supply the side reference a floating cap
// needs, so wide deep pits close ring by ring instead of skipping.
function shiftDone(f) {
  f.holes.shift()
  f.filled++
  f.lastProgressTick = f.ticks
  f.orderDirty = true // v8bq: the body moved — re-sort around it next tick
}

function shiftSkip(f, why) {
  f.holes.shift()
  if (f.skip[why] != null) f.skip[why]++
  f.lastProgressTick = f.ticks
  f.orderDirty = true // v8bq: the body moved — re-sort around it next tick
}

function rotate(f) {
  f.holes.push(f.holes.shift())
}

function shiftBumpDone(f) {
  const h = f.bumps.shift()
  if (h && h.sweep) f.sweptN = (f.sweptN || 0) + 1
  else f.shaved++
  // xtbt (review P2): a cleared sweep column is offered again when
  // scaffold is rebuilt on it later at any height; kept/refused sweep
  // bumps keep their sweptTops entry, so they are never retried.
  if (h && h.sweep && f.sweptTops) {
    try { delete f.sweptTops[`${h.x},${h.z}`] } catch (_) { /* best-effort */ }
  }
  f.lastProgressTick = f.ticks
  f.orderDirty = true // v8bq: the body moved — re-sort around it next tick
}

function shiftBumpSkip(f, why) {
  f.bumps.shift()
  if (f.skip[why] != null) f.skip[why]++
  f.lastProgressTick = f.ticks
  f.orderDirty = true // v8bq: the body moved — re-sort around it next tick
}

// xxmn: remember a drop cell whose pickup walk timed out, so the pack
// restock round can vacuum it later instead of digging fresh dirt for it.
// Bounded and deduped; recording never breaks the shave.
function recordLitter(f, x, y, z) {
  try {
    if (!f || !Array.isArray(f.litter)) return
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return
    const k = `${x},${y},${z}`
    if (f.litter.some((c) => c && c.k === k)) return
    if (f.litter.length >= LITTER_MAX) f.litter.shift()
    f.litter.push({ k, x, y, z })
  } catch (_) { /* litter best-effort */ }
}

// xxmn: the hilltop budget. The queue runs nearest-first, so the leftovers
// are the far edges; they skip honestly as 'budget' and the episode ends
// over the sweep/recheck path below with left=0.
function budgetStop(bot, ctx, f) {
  const n = f.bumps.length
  f.bumps = []
  if (f.skip) f.skip.budget = (f.skip.budget || 0) + n
  f.lastProgressTick = f.ticks
  console.log(`flat bump budget: skipped ${n} far bump${n === 1 ? '' : 's'}, middle flat (level ${f.level})`)
}

function rotateBump(f) {
  f.bumps.push(f.bumps.shift())
}

function finish(bot, ctx, f, why) {
  const left = f.holes.length + f.bumps.length
  const leftWhy = why || f.abortWhy || 'around you'
  const skipped = Object.values(f.skip).reduce((a, b) => a + b, 0)
  let line = `flat done: filled ${f.filled} hole${f.filled === 1 ? '' : 's'}`
  if (f.totalBumps > 0) line += `, shaved ${f.shaved} bump${f.shaved === 1 ? '' : 's'}`
  if (f.sweptN > 0) line += `, swept ${f.sweptN} leftover${f.sweptN === 1 ? '' : 's'}`
  if (left > 0) line += `, ${left} left (${leftWhy})`
  else if (why) line += ` (${why})` // zchb: a give-up with nothing queued still says why
  if (skipped > 0) {
    const parts = Object.entries(f.skip).filter(([, n]) => n > 0).map(([k, n]) => `${n} ${k}`)
    line += `, skipped ${skipped}: ${parts.join(', ')}`
  }
  // xtbt: kept columns name the freezing marker (top 3), so the owner sees
  // what to move instead of re-ordering flat on a frozen square.
  if (f.skip.kept > 0) {
    const tops = Object.entries(f.keptMarkers || {})
      .filter(([, n]) => n > 0)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([m, n]) => `${m} x${n}`)
    if (tops.length > 0) line += ` (kept by ${tops.join(', ')})`
  }
  // x3y6.3: a clean swarm finish re-scans the square to steal a strip; a
  // steal that moved nothing (skips only) parks instead of ping-ponging,
  // and a strip that gave up its holes (abortWhy) parks as today.
  const home = homeOf(f)
  const again = !!home && why == null && !f.abortWhy && (!f.steal || f.filled + f.shaved > 0)
  // Chat once, when the bot truly stops; a finish going on to steal is
  // log-only (13 bots x every round would spam the server).
  if (again) console.log(line)
  else say(bot, line)
  console.log(`flat finish filled=${f.filled} shaved=${f.shaved} supports=${f.supports} left=${left} why=${why || 'done'} skip=${JSON.stringify(f.skip)} steal=${f.steal && f.tile ? f.tile.i + 1 : (again ? 'scan' : 'none')}`)
  clearGoal(bot, ctx)
  // vf8e.6: an LLM plan reads it. A steal round ending 'nothing to steal'
  // follows a clean home strip: done.
  const clean = (why == null || (f.steal && why === 'nothing to steal')) && !f.abortWhy
  // xxmn: the anchor travels with the outcome so `build here` can prefer
  // the guaranteed square (site.js flatAnchorEnd); outcome/at keep their
  // shape for the LLM plan reader.
  ctx.flatEnd = {
    outcome: clean ? 'done' : 'failed', at: Date.now(),
    cx: f.cx, cz: f.cz, r: f.r, level: f.level, left, skipped,
  }
  ctx.flat = null
  if (again) {
    // Same key (cx,cz,r): a relay/re-flat of this square resumes the steal.
    // Persists like any episode; a restart resumes the home strip.
    ctx.flat = startEpisode(f.cx, f.cz, f.r, f.yTop, f.by, null, f.level)
    ctx.flat.steal = { i: home.i, n: home.n }
    ctx.flat.blocks = f.blocks // the watchdog metric stays monotone
    guardFlatSurface(bot, ctx)
    return
  }
  if (f.steal && why == null) console.log('flat steal moved nothing: nothing to steal, parking')
  // tpd1: a helper parks where it finished — unparked with no work it
  // would walk home (unseen latch); the next flat order unparks it.
  if (home && home.i >= 1) ctx.paused = true
  guardFlatSurface(bot, ctx) // episode gone: the detach path below runs
}

function scanRecord(f, c, r) {
  // Swarm: off-strip columns only vote the level (walkable tops).
  if (!inTile(f, c.x, c.z)) {
    if (r.status === 'ok' && r.liquidTop == null && r.walkable) f.tops.push(r.topY)
    return
  }
  if (r.status === 'unloaded') {
    f.counts.unloaded++
  } else if (r.status === 'liquid') {
    f.counts.liquid++
  } else if (r.status === 'bump') {
    f.counts.bump++
  } else if (r.status === 'deep') {
    f.cands.push({ x: c.x, z: c.z, deep: true })
  } else if (r.status === 'ok') {
    if (r.liquidTop != null) {
      // Flooded ditch: no tops vote (a drowned bottom must not drag the
      // level down); the partition after chooseLevel caps or skips it.
      f.liquidCols.push({ x: c.x, z: c.z, topY: r.topY, liquidTop: r.liquidTop })
      return
    }
    if (!r.walkable) {
      f.counts.covered++
      return
    }
    f.tops.push(r.topY)
    f.cands.push({ x: c.x, z: c.z, topY: r.topY })
  }
}

function scanTick(bot, ctx, f) {
  f.ticks++
  const t = f.scan
  const end = Math.min(t.queue.length, t.i + SCAN_PER_TICK)
  const blockAt = (x, y, z) => {
    try {
      return bot.blockAt(new Vec3(x, y, z))
    } catch (_) {
      return null
    }
  }
  for (; t.i < end; t.i++) {
    const c = t.queue[t.i]
    scanRecord(f, c, probeColumn(blockAt, c.x, c.z, f.yTop, f.yBottom))
  }
  f.lastProgressTick = f.ticks
  if (t.i < t.queue.length) return
  const level = f.fixedLevel != null ? f.fixedLevel : chooseLevel(f.tops)
  if (level == null) {
    finish(bot, ctx, f, 'no ground found')
    return
  }
  f.level = level
  for (const c of f.liquidCols) {
    // Surface at/above the level is a pond (filling it would destroy the
    // water); strictly below it the ditch caps like an ordinary hole.
    if (c.liquidTop >= level) f.counts.liquid++
    else f.cands.push({ x: c.x, z: c.z, topY: c.topY })
  }
  f.liquidCols = []
  f.holes = detectHoles(f.cands, level, f.cx, f.cz)
  f.bumps = detectBumps(f.cands, level, f.cx, f.cz)
  if (f.steal) {
    // Whole square was kept (tile null): pick the victim, keep its strip,
    // farthest from the centre first — the owner works centre-out.
    const v = stealVictim([...f.holes, ...f.bumps], f)
    if (!v) {
      f.holes = []
      f.bumps = []
      finish(bot, ctx, f, 'nothing to steal')
      return
    }
    f.tile = { i: v.i, n: f.steal.n }
    f.holes = f.holes.filter((h) => inTile(f, h.x, h.z)).reverse()
    f.bumps = f.bumps.filter((h) => inTile(f, h.x, h.z)).reverse()
    console.log(`flat steal strip=${v.i + 1}/${f.steal.n} left=${v.left} from=${f.steal.i + 1}`)
  }
  f.bumpCols = new Set(f.bumps.map((b) => `${b.x},${b.z}`))
  f.cands = []
  f.tops = []
  f.total = f.holes.length
  f.totalBumps = f.bumps.length
  f.phase = 'fill'
  f.orderDirty = true // v8bq: first fill tick re-sorts around the live body
  f.lastProgressTick = f.ticks
  f.lastChat = Date.now() // the start line below is the first progress
  const size = 2 * f.r + 1
  let line = `flattening ${size}x${size} around ${f.by}${f.tile ? ` (strip ${f.tile.i + 1}/${f.tile.n}${f.steal ? ' steal' : ''})` : ''}, level ${level}: ${f.total} holes`
  if (f.totalBumps > 0) line += `, ${f.totalBumps} bumps`
  if (f.counts.unloaded > 0) line += `, ${f.counts.unloaded} unloaded`
  if (f.counts.liquid > 0) line += `, ${f.counts.liquid} water skipped`
  if (f.steal) console.log(line) // x3y6.3: steal rounds are log-only
  else say(bot, line)
  console.log(`flat start anchor=${f.cx},${f.cz} r=${f.r} level=${level}${f.tile ? ` strip=${f.tile.i + 1}/${f.tile.n}` : ''}`)
  if (f.total === 0 && f.totalBumps === 0) finish(bot, ctx, f, null)
  else if (f.total === 0) f.phase = 'shave'
}

// Step aside from a cell the bot itself blocks: fixed direction per column
// and a stable goal key, so a multi-tick sidestep never reverses mid-walk
// (round-1 core-2/body-3). The caller counts attempts and skips when wedged.
function sidestep(bot, ctx, h, bp, x, y, z, tag, gy) {
  const step = SIDESTEPS[Math.abs(h.x * 7 + h.z * 13) % SIDESTEPS.length]
  const key = `${tag}:${x},${y},${z}`
  if (key !== ctx.lastGoalKey) {
    // Aim at gy when given (revmux-03): a step-out from a pit floor must
    // target the surface, or walking out can never satisfy the goal (the
    // pathfinder tunnels sideways or partials instead).
    const ty = gy == null ? bp.y : gy
    try {
      bot.pathfinder.setGoal(new goals.GoalNear(bp.x + step[0], ty, bp.z + step[1], 1), false)
    } catch (_) { return }
    ctx.lastGoalKey = key
  }
}

// One log-safe token from a refused placement/dig: flat is otherwise
// silent between the start line and the finish, so a refused cell logs
// its coordinates and the reason instead of vanishing into a skip count.
function shortErr(e) {
  const m = e && typeof e.message === 'string' ? e.message : String(e)
  return m.split('\n')[0].trim().replace(/\s+/g, '_').slice(0, 80) || 'unknown'
}

function placeFlight(bot, ctx, f, h, item, ref, p, isSupport) {
  ctx.placeInFlight = true
  ;(async () => {
    try {
      await bot.equip(item, 'hand')
      await bot.placeBlock(ref.ref, ref.face)
      f.blocks++
      if (isSupport) {
        h.sup++
        f.supports++
        f.lastProgressTick = f.ticks
      } else {
        shiftDone(f)
      }
    } catch (e) {
      h.att++
      if (h.att >= PLACE_ATTEMPTS) {
        console.log(`flat refused-place ${p.x},${p.y},${p.z} att=${h.att} err=${shortErr(e)}`)
        shiftSkip(f, 'refused')
      }
    } finally {
      ctx.placeInFlight = false
    }
  })().catch(() => { ctx.placeInFlight = false })
}

function digFlight(bot, ctx, f, h, block) {
  ctx.digInFlight = true
  const at = { x: block.position.x, y: block.position.y, z: block.position.z }
  console.log(`flat dig ${at.x},${at.y},${at.z}`)
  ;(async () => {
    try {
      // Stone by hand takes ~7.5 s and drops nothing; the harvest tool
      // (forage.js pattern) keeps the job fast and banks the drops.
      let tool = null
      try { tool = bot.pathfinder && typeof bot.pathfinder.bestHarvestTool === 'function' ? bot.pathfinder.bestHarvestTool(block) : null } catch (_) { tool = null }
      if (tool && typeof bot.equip === 'function') await bot.equip(tool, 'hand')
      await bot.dig(block)
      f.blocks++
      h.pickup = at // walk the drop into the inventory (gather pattern)
      f.lastProgressTick = f.ticks
    } catch (e) {
      h.att++
      if (h.att >= DIG_ATTEMPTS) {
        console.log(`flat refused-dig ${at.x},${at.y},${at.z} att=${h.att} err=${shortErr(e)}`)
        shiftBumpSkip(f, 'refused')
      }
    } finally {
      ctx.digInFlight = false
    }
  })().catch(() => { ctx.digInFlight = false })
}

// idkcraft-vewo.4: swarm helpers (strip >= 1) log progress/refill lines instead of chatting; start + done stay chat
function tell(bot, f, line) {
  const home = homeOf(f)
  if (home && home.i >= 1) console.log(`flat quiet strip=${f.tile.i + 1}/${f.tile.n}: ${line}`)
  else say(bot, line)
}

function startDig(bot, ctx, f) {
  // x3y6.4: the strip's own bumps come off anyway and drop fill: shave
  // them first; the restock walk runs only once no bump is left.
  if (f.bumps.length > 0) {
    f.phase = 'shave'
    f.shaveForFill = true
    f.orderDirty = true // v8bq: the fill walked the body — re-sort around it
    f.lastProgressTick = f.ticks
    tell(bot, f, `out of fill blocks, shaving ${f.bumps.length} bumps first`)
    return
  }
  f.phase = 'dig'
  // xxmn: one restock episode works every round in DIG_ROUNDS before ending
  // honestly; the skip set accumulates across rounds, stalls/ticks reset.
  f.dig = { round: 0, pos: null, phase: 'walk', skip: new Set(), streak: 0, ticks: 0, stalls: 0, lastPos: null, have: 0, bring: null }
  f.lastProgressTick = f.ticks
  tell(bot, f, 'out of fill blocks, digging dirt')
}

// Restock origin: findBlocks returns the matches nearest to its point, so
// searching from inside the square would return 64 near blocks and the gap
// filter would drop all of them (body-1). Search from the dig zone instead
// (RESTOCK_MIN_EDGE_GAP past the nearest edge, in the bot's direction);
// the gap filter stays as a backstop.
function restockPoint(f, bp) {
  const dx = bp.x - f.cx
  const dz = bp.z - f.cz
  if (Math.max(Math.abs(dx), Math.abs(dz)) > f.r + RESTOCK_MIN_EDGE_GAP) return new Vec3(bp.x, bp.y, bp.z)
  if (Math.abs(dx) > Math.abs(dz)) return new Vec3(f.cx + Math.sign(dx || 1) * (f.r + RESTOCK_MIN_EDGE_GAP), bp.y, bp.z)
  return new Vec3(bp.x, bp.y, f.cz + Math.sign(dz || 1) * (f.r + RESTOCK_MIN_EDGE_GAP))
}

// Nearest diggable dirt in the restock zone: at least RESTOCK_MIN_EDGE_GAP
// past the square edge, surface-exposed only (never quarried from below the
// local surface), raised bumps preferred over flat ground. The square level
// is deliberately NOT a floor: the square can sit high while the dig zone
// around it is lower, and a square-relative floor starves restock to zero
// (live 2026-09-28: level 65, zone dirt at 57-63). mnx pit memory and the
// block under the bot's own feet are excluded like in gather.js.
// xxmn: radius/ids vary by round — near digs dirt within DIRT_FIND_RADIUS,
// wide digs the whole fill family within WIDE_DIG_RADIUS. Every other gate
// (edge gap, surface-exposed, structure, canBreak) is identical.
function findDirt(bot, ctx, f, bp, radius, wide) {
  const ids = wide ? fillIds(bot) : dirtIds(bot)
  if (ids.length === 0) return null
  let found = []
  try {
    found = bot.findBlocks({ matching: ids, point: restockPoint(f, bp), maxDistance: radius || DIRT_FIND_RADIUS, count: DIRT_FIND_COUNT }) || []
  } catch (_) {
    return null
  }
  const d = f.dig
  const guard = util && typeof util.canBreak === 'function' ? util.canBreak : null
  let guarded = null // nearest guard-rejected candidate, for one honest log
  let guardedD = Infinity
  const cands = []
  for (const p of found) {
    if (Math.max(Math.abs(p.x - f.cx), Math.abs(p.z - f.cz)) - f.r < RESTOCK_MIN_EDGE_GAP) continue
    if (d.skip.has(keyOf(p.x, p.y, p.z))) continue
    if (danger.near(ctx, p)) continue
    if (Math.floor(bp.x) === p.x && Math.floor(bp.y) - 1 === p.y && Math.floor(bp.z) === p.z) continue
    if (threatenedByPlayer(bot, p.x, p.y, p.z)) continue
    if (cellAt(bot, p.x, p.y + 1, p.z) !== 'air') continue // below the local surface: buried or built over, never quarried
    if (structureNear(bot, p.x, p.y, p.z)) continue // interim owner-build gate until canBreak lands (drq)
    if (guard) {
      let block = null
      try { block = bot.blockAt(p) } catch (_) { block = null }
      let ok = false
      try { ok = block != null && guard(bot, block, ctx) === true } catch (_) { ok = false }
      if (!ok) {
        const dd = dist3(p, bp)
        if (dd < guardedD) {
          guardedD = dd
          guarded = { p, name: (block && block.name) || 'unknown' }
        }
        continue
      }
    }
    cands.push(p)
  }
  if (cands.length === 0) {
    if (guarded) console.log(`flat protected: ${guarded.name} at ${guarded.p.x} ${guarded.p.y} ${guarded.p.z}`)
    return null
  }
  // Raised natural terrain first (hill tops, bumps above the local level):
  // taking the top off a bump leaves no pit. Nearest first within a height.
  cands.sort((a, b) => (b.y - a.y) || (dist3(a, bp) - dist3(b, bp)))
  return cands[0]
}

function endDig(bot, ctx, f, resume) {
  f.dig = null
  if (resume) {
    f.phase = 'fill'
    f.orderDirty = true // v8bq: back from the dig zone — re-sort around the body
    f.lastProgressTick = f.ticks
    return
  }
  // Shaving needs no fill blocks: fall through to the bumps instead of
  // ending the episode, and keep the reason for the leftover holes (body-5).
  // x3y6.4: bumps are shaved before a restock now, so this is mostly the
  // leftover-scaffold sweep the clean ends offer too.
  if (f.bumps.length > 0 || maybeSweep(bot, f)) {
    f.phase = 'shave'
    f.abortWhy = 'no fill blocks'
    f.orderDirty = true // v8bq: back from the dig zone — re-sort around the body
    f.lastProgressTick = f.ticks
    tell(bot, f, `no fill blocks, shaving ${f.bumps.length} bumps first`)
    return
  }
  finish(bot, ctx, f, 'no fill blocks')
}

// v8bq R1: stage only what the episode can use — a full pack for a big
// square, holes-left + support slack for a small tail. Digging a full
// stack for 1-3 leftover holes punches 64 fresh pits around the square
// and costs minutes to fill them back (and a bring round would drain 64
// from the home chest for the same tail).
function restockTarget(f) {
  const holes = f && Array.isArray(f.holes) ? f.holes.length : 0
  return Math.min(DIG_TARGET, holes + RESTOCK_SLACK)
}

// xxmn restock rounds: 0 pack (vacuum this episode's littered drops),
// 1 near (today's restock), 2 wide (bigger radius, whole fill family),
// 3 bring (home-chest withdraw when close). One f.dig across rounds.
const DIG_ROUNDS = ['pack', 'near', 'wide', 'bring']

function roundTicks(d) {
  if (!d) return DIG_TICKS
  if (d.round === 0) return PACK_TICKS
  if (d.round === 3) return BRING_TICKS
  return DIG_TICKS
}

// The round is spent (budget out, nothing found, walk stalled): move to
// the next one, or end the restock with what is on hand past the last.
// v8bq R1: leaving the near round with a usable pack ends the restock
// instead of widening — a 128-radius trek plus a chest trip for blocks
// the hand already holds is the fetch marathon in reverse.
function nextRound(bot, ctx, f) {
  const d = f.dig
  if (d.round === 1 && countFill(bot) >= Math.min(restockTarget(f), FILL_RESUME)) {
    endDig(bot, ctx, f, true)
    return false
  }
  d.round++
  d.pos = null
  d.phase = 'walk'
  d.ticks = 0
  d.stalls = 0
  d.streak = 0
  d.lastPos = null
  d.bring = null
  if (d.round >= DIG_ROUNDS.length) {
    endDig(bot, ctx, f, countFill(bot) > 0)
    return false
  }
  console.log(`flat restock round=${DIG_ROUNDS[d.round]}`)
  return true
}

function digTick(bot, ctx, f, bp) {
  f.ticks++
  const d = f.dig
  d.ticks++
  const have = countFill(bot)
  if (have >= restockTarget(f)) {
    endDig(bot, ctx, f, true)
    return
  }
  if (d.ticks > roundTicks(d)) {
    nextRound(bot, ctx, f)
    return
  }
  if (d.round === 0) {
    packTick(bot, ctx, f, bp, have)
    return
  }
  if (d.round === 3) {
    bringTick(bot, ctx, f, bp)
    return
  }
  restockTick(bot, ctx, f, bp, d.round >= 2)
}

function restockTick(bot, ctx, f, bp, wide) {
  const d = f.dig
  if (!d.pos) {
    const found = findDirt(bot, ctx, f, bp, wide ? WIDE_DIG_RADIUS : DIRT_FIND_RADIUS, wide)
    if (!found) {
      // Near spent with nothing in reach is exactly the prod case: widen
      // instead of ending with holes left.
      nextRound(bot, ctx, f)
      return
    }
    d.pos = found
    d.phase = 'walk'
    d.stalls = 0
    d.lastPos = { x: bp.x, y: bp.y, z: bp.z }
  }
  if (d.phase === 'walk') {
    const key = `flat-dig:${d.pos.x},${d.pos.y},${d.pos.z}`
    if (key !== ctx.lastGoalKey) {
      try {
        bot.pathfinder.setGoal(new goals.GoalNear(d.pos.x, d.pos.y, d.pos.z, 2), false)
      } catch (_) { /* retry next tick */ return }
      ctx.lastGoalKey = key
      d.stalls = 0
      d.lastPos = { x: bp.x, y: bp.y, z: bp.z }
      return
    }
    let name = null
    try {
      const b = bot.blockAt && bot.blockAt(d.pos)
      name = (b && b.name) || null
    } catch (_) { /* name best-effort */ }
    // xxmn: the wide round digs the fill family, so a changed cell still
    // counts when it holds any fill name, not just dirt.
    const okName = wide ? isFillBlock(name) : isDirtName(name)
    if (name != null && !okName) {
      d.pos = null // dug by someone else: search again
      return
    }
    let moving = false
    try { moving = bot.pathfinder.isMoving() } catch (_) { /* treat as arrived */ }
    if (!moving) {
      if (typeof bot.dig !== 'function') {
        d.skip.add(keyOf(d.pos.x, d.pos.y, d.pos.z))
        d.pos = null
        return
      }
      let block = null
      try { block = bot.blockAt(d.pos) } catch (_) { block = null }
      if (!block) {
        d.pos = null
        return
      }
      let diggable = true
      try { diggable = typeof bot.canDigBlock === 'function' ? bot.canDigBlock(block) : true } catch (_) { diggable = false }
      if (!diggable) {
        d.skip.add(keyOf(d.pos.x, d.pos.y, d.pos.z))
        d.pos = null
        return
      }
      const restockDeny = denyReason(bot, block, ctx) // idkcraft-drq: restock from terrain, not builds
      if (restockDeny) {
        logDeny(block, restockDeny)
        d.skip.add(keyOf(d.pos.x, d.pos.y, d.pos.z))
        d.pos = null
        return
      }
      d.have = countFill(bot) // baseline: the pickup recounts the gain below
      ctx.digInFlight = true
      ;(async () => {
        try { await bot.dig(block); f.blocks++ } catch (_) { /* gone or interrupted: recount anyway */ }
        ctx.digInFlight = false
        d.phase = 'pickup'
      })().catch(() => { ctx.digInFlight = false })
      return
    }
    const grounded = !bot.entity || bot.entity.onGround !== false
    if (progressed(bp, d.lastPos, grounded)) {
      d.stalls = 0
      d.lastPos = { x: bp.x, y: bp.y, z: bp.z }
    } else if (++d.stalls >= DIG_STALLS) {
      d.skip.add(keyOf(d.pos.x, d.pos.y, d.pos.z))
      d.pos = null
      d.streak++
      if (d.streak >= DIG_STREAK) endDig(bot, ctx, f, countFill(bot) > 0)
    }
    return
  }
  if (d.phase === 'pickup') {
    const key = `flat-pickup:${d.pos.x},${d.pos.y},${d.pos.z}`
    if (key !== ctx.lastGoalKey) {
      try {
        bot.pathfinder.setGoal(new goals.GoalBlock(d.pos.x, d.pos.y, d.pos.z), false)
      } catch (_) { /* retry next tick */ return }
      ctx.lastGoalKey = key
      return
    }
    // Reached or gave up getting there: the drop is picked up by proximity
    // and the inventory count is the truth — move to the next dirt. The old
    // same-tick recount never saw a gain (xxmn: baseline at dig time does);
    // a gain resets the stall streak, a miss litters the cell for the pack
    // round instead of forgetting it.
    const lp = d.pos
    d.pos = null
    d.phase = 'walk'
    if (countFill(bot) > (d.have || 0)) {
      f.lastProgressTick = f.ticks
      d.streak = 0
    } else if (lp) {
      recordLitter(f, lp.x, lp.y, lp.z)
    }
  }
}

// xxmn pack round: walk this episode's littered drop cells (timed-out shave
// and restock pickups) and vacuum them by proximity before digging fresh
// dirt. Arrival just recounts — the count is the truth either way.
function packTick(bot, ctx, f, bp, have) {
  const d = f.dig
  if (!Array.isArray(f.litter) || f.litter.length === 0) {
    nextRound(bot, ctx, f)
    return
  }
  const c = f.litter[0]
  const key = `flat-pack:${c.x},${c.y},${c.z}`
  if (key !== ctx.lastGoalKey) {
    try {
      bot.pathfinder.setGoal(new goals.GoalBlock(c.x, c.y, c.z), false)
    } catch (_) { /* retry next tick */ return }
    ctx.lastGoalKey = key
    d.have = have
    d.stalls = 0
    d.lastPos = { x: bp.x, y: bp.y, z: bp.z }
    return
  }
  let moving = false
  try { moving = bot.pathfinder.isMoving() } catch (_) { /* treat as arrived */ }
  if (moving) {
    const grounded = !bot.entity || bot.entity.onGround !== false
    if (progressed(bp, d.lastPos, grounded)) {
      d.stalls = 0
      d.lastPos = { x: bp.x, y: bp.y, z: bp.z }
    } else if (++d.stalls >= DIG_STALLS) {
      f.litter.shift() // taken, despawned or unreachable: next cell
      d.streak++
      if (d.streak >= DIG_STREAK) nextRound(bot, ctx, f)
    }
    return
  }
  f.litter.shift()
  if (countFill(bot) > (d.have || 0)) {
    f.lastProgressTick = f.ticks
    d.streak = 0
  }
}

// xxmn bring round: withdraw fill from the home chest when it is close
// enough to walk to mid-order. The withdraw runs as one async flight behind
// the shared digInFlight seam (flat() pauses meanwhile); landing sets the
// fill phase, and the normal hole approach walks the body back.
function planBring(bot, ctx, f, bp) {
  const chest = ctx && ctx.home && ctx.home.chest
  if (!chest || typeof chest.x !== 'number' || typeof chest.y !== 'number' || typeof chest.z !== 'number') {
    return { ok: false, why: 'no home chest' }
  }
  if (typeof bot.openChest !== 'function') return { ok: false, why: 'no chest access' }
  let dist = null
  try { dist = dist3(bp, chest) } catch (_) { dist = null }
  if (typeof dist !== 'number' || !(dist <= BRING_RANGE)) {
    return { ok: false, why: `chest ${dist == null ? 'unreachable' : `${Math.round(dist)} away`}` }
  }
  return { ok: true, chest }
}

// xxmn: withdraw fill from the home chest without requiring stockpile —
// the require graph is acyclic by law (oqul.14: stockpile reads flat, so
// flat cannot read it back; the shared leaves both could use reach flat
// through castle). A minimal window dance here keeps the bring round
// self-contained: open, take fill names, always close.
async function withdrawFill(bot, chest, names, count) {
  let block = null
  try {
    block = bot.blockAt(new Vec3(chest.x, chest.y, chest.z))
  } catch (_) { block = null }
  if (!block || block.name !== 'chest') return { got: 0 }
  let window = null
  try {
    window = await bot.openChest(block)
  } catch (_) {
    return { got: 0 }
  }
  let got = 0
  try {
    const stacks = typeof window.containerItems === 'function' ? window.containerItems() : []
    const want = new Set(names)
    let need = count
    if (Array.isArray(stacks)) {
      for (const s of stacks) {
        if (need <= 0) break
        if (!s || typeof s.name !== 'string' || !want.has(s.name)) continue
        const take = Math.min(typeof s.count === 'number' ? s.count : 1, need)
        if (take <= 0) continue
        await window.withdraw(s.type, s.metadata, take)
        need -= take
        got += take
      }
    }
  } catch (_) { /* partial withdraw keeps what landed */ }
  try { window.close() } catch (_) { /* close best-effort */ }
  return { got }
}

function bringTick(bot, ctx, f, bp) {
  const d = f.dig
  if (!d.bring) {
    d.bring = planBring(bot, ctx, f, bp)
    if (!d.bring.ok) {
      console.log(`flat bring skipped: ${d.bring.why}`)
      nextRound(bot, ctx, f)
      return
    }
    tell(bot, f, 'fetching fill from the home chest')
    d.stalls = 0
    d.lastPos = { x: bp.x, y: bp.y, z: bp.z }
  }
  const b = d.bring
  let dist = null
  try { dist = dist3(bp, b.chest) } catch (_) { dist = null }
  if (typeof dist === 'number' && dist <= INTERACT_CLOSE) {
    const need = Math.max(1, restockTarget(f) - countFill(bot))
    const had = countFill(bot) // baseline: only a grown inventory resumes fill
    ctx.digInFlight = true
    ;(async () => {
      try {
        const res = await withdrawFill(bot, b.chest, FILL_BLOCKS, need)
        const got = res && typeof res.got === 'number' ? res.got : 0
        console.log(`flat bring got=${got} need=${need}`)
      } catch (_) { /* chest unreadable: land with what is on hand */ }
      ctx.digInFlight = false
      // R2: a landing from a replaced episode owns nothing — the new order
      // owns ctx now (same rule as step.js stale completions). The shared
      // seam still clears above; only episode state is guarded.
      if (ctx.flat !== f) {
        console.log('flat bring stale landing dropped')
        return
      }
      // R1 P1: a got=0 landing must end the restock, not resume fill into a
      // fresh pack->near->wide->bring chain (the landing resets the backstop
      // clock, so blind resume loops forever on an empty chest).
      if (countFill(bot) > had) {
        f.phase = 'fill'
        f.orderDirty = true // v8bq: back from the chest — re-sort around the body
        f.lastProgressTick = f.ticks
      } else {
        endDig(bot, ctx, f, countFill(bot) > 0)
      }
    })().catch(() => {
      // An unlanded flight ends the restock too — never resume blind.
      ctx.digInFlight = false
      if (ctx.flat !== f) {
        console.log('flat bring stale landing dropped')
        return
      }
      try { endDig(bot, ctx, f, countFill(bot) > 0) } catch (_) { /* end honest, one way or another */ }
    })
    return
  }
  const key = `flat-bring:${b.chest.x},${b.chest.y},${b.chest.z}`
  if (key !== ctx.lastGoalKey) {
    try {
      bot.pathfinder.setGoal(new goals.GoalNear(b.chest.x, b.chest.y, b.chest.z, 2), false)
    } catch (_) { /* retry next tick */ return }
    ctx.lastGoalKey = key
    d.stalls = 0
    d.lastPos = { x: bp.x, y: bp.y, z: bp.z }
    return
  }
  let moving = false
  try { moving = bot.pathfinder.isMoving() } catch (_) { /* treat as arrived */ }
  if (moving) {
    const grounded = !bot.entity || bot.entity.onGround !== false
    if (progressed(bp, d.lastPos, grounded)) {
      d.stalls = 0
      d.lastPos = { x: bp.x, y: bp.y, z: bp.z }
    } else if (++d.stalls >= DIG_STALLS) {
      console.log('flat bring walk stalled')
      nextRound(bot, ctx, f)
    }
    return
  }
  // Pathfinder settled but the chest is still out of window reach: count it
  // like a stall — a wedged walk gives up the round instead of orbiting.
  if (++d.stalls >= DIG_STALLS) {
    console.log('flat bring walk stalled')
    nextRound(bot, ctx, f)
  }
}

function resolvedCount(f) {
  let n = (f.filled || 0) + (f.shaved || 0)
  const skip = f.skip || {}
  for (const k of Object.keys(skip)) n += skip[k] || 0
  return n
}

function progressChat(bot, f) {
  const now = Date.now()
  if (f.progressChats) {
    if (now - (f.lastChat || 0) < PROGRESS_MS) return
  } else if (now - (f.lastChat || 0) < FIRST_PROGRESS_MS && resolvedCount(f) < FIRST_PROGRESS_N) {
    return
  }
  f.lastChat = now
  f.progressChats = (f.progressChats || 0) + 1
  if (f.phase === 'shave') tell(bot, f, `flat shave ${f.shaved + (f.sweptN || 0)}/${f.totalBumps + (f.sweepTotal || 0)} (level ${f.level})`)
  else tell(bot, f, `flat ${f.filled}/${f.total} (level ${f.level})`)
}

function fillTick(bot, ctx, f, bp) {
  f.ticks++
  // v8bq: completions re-sort the queue around the live body (nearest-
  // to-bot sweep). Applied once per flag, never mid-pursuit: rotate()
  // defers never set it, so ring-by-ring closing is undisturbed.
  if (f.orderDirty) {
    f.orderDirty = false
    orderByBot(f.holes, bp)
  }
  recordStepped(f, bp)
  progressChat(bot, f)
  if (f.ticks - f.lastProgressTick > BACKSTOP_TICKS) {
    if (f.bumps.length > 0) {
      f.phase = 'shave'
      f.abortWhy = 'stalled'
      f.orderDirty = true // v8bq: the fill walked the body — re-sort around it
      f.lastProgressTick = f.ticks
      return
    }
    finish(bot, ctx, f, 'stalled')
    return
  }
  if (f.holes.length === 0) {
    if (f.bumps.length === 0) maybeSweep(bot, f)
    if (f.bumps.length === 0) {
      // xtbt: shave-for-fill keeps land here (startDig sends a fill
      // episode through the shave, which returns to fill); re-check
      // them like the shave end does, or they freeze the next order.
      if (recheckKept(bot, ctx, f)) return
      finish(bot, ctx, f, null)
      return
    }
    f.phase = 'shave'
    f.orderDirty = true // v8bq: the fill walked the body — re-sort around it
    f.lastProgressTick = f.ticks
    return
  }
  const h = f.holes[0]
  const cx = h.x
  const cy = f.level
  const cz = h.z
  // Light re-verify: the world moves (players dig/build, water flows) while
  // the long job runs, so a stale queue entry must not place blind.
  const cur = cellAt(bot, cx, cy, cz)
  if (cur === 'solid') {
    shiftDone(f)
    return
  }
  if (cur === 'liquid') {
    shiftSkip(f, 'water')
    return
  }
  const selfIn = cellOccupiedSelf(bot, cx, cy, cz)
  const playerIn = cellOccupiedByPlayer(bot, cx, cy, cz)
  const mobIn = cellOccupiedByMob(bot, cx, cy, cz)
  if (selfIn && !playerIn && !mobIn) {
    // Standing in our own cap cell (a 1-deep trench floor is a normal place
    // goal parking spot): step aside so the cap can land; a bot that cannot
    // move skips the hole instead of orbiting it.
    h.selfOcc = (h.selfOcc || 0) + 1
    if (h.selfOcc > SELF_OCC_LIMIT) {
      shiftSkip(f, 'occupied')
      return
    }
    sidestep(bot, ctx, h, bp, cx, cy, cz, 'flat-side')
    return
  }
  if (playerIn || mobIn) {
    h.occ++
    if (h.occ > OCC_DEFERS) {
      shiftSkip(f, 'occupied')
      return
    }
    rotate(f)
    return
  }
  if (Math.floor(bp.x) === cx && Math.floor(bp.z) === cz && Math.floor(bp.y) < cy) {
    // Standing below our own cap cell (a 3+-deep hole we dropped into; the
    // 1-deep feet-in-cap and 2-deep head-in-cap cases sidestep above):
    // capping from down here would entomb the body under its own fill —
    // the support lands in the head cell and never places (cm0). Step out
    // once (a body that can move must not sit still spinning the stuck
    // detector), then rotate: a truly trapped body shows no displacement
    // and the ticker backstop hands it to recover, while a free body
    // walks out and approaches normally.
    if (!h.f2step) {
      h.f2step = true
      sidestep(bot, ctx, h, bp, cx, cy, cz, 'flat-f2', cy + 1)
      return
    }
    h.occ++
    if (h.occ > OCC_DEFERS) {
      shiftSkip(f, 'occupied')
      return
    }
    rotate(f)
    return
  }
  const key = `flat:${cx},${cy},${cz}`
  if (key !== ctx.lastGoalKey) {
    // v8bq: the next cap is already under our hands (dense hole field —
    // just placed next door, or the re-sort put a neighbour first). Work
    // it from this stand instead of pathing per block: stop the old
    // goal and fall through to the arrived checks below, which re-verify
    // the click from the live position before every attempt.
    const p0 = new Vec3(cx, cy, cz)
    const pre = findRef(bot, p0, bp)
    if (pre && standVerified(bot, bp, pre.ref, pre.face)) {
      try { clearGoal(bot, ctx) } catch (_) { /* stand best-effort */ }
      ctx.lastGoalKey = key
      f.issuedKey = key
      h.stalls = 0
      h.lastPos = { x: bp.x, y: bp.y, z: bp.z }
    } else {
      let g = null
      try {
        g = new goals.GoalPlaceBlock(new Vec3(cx, cy, cz), bot.world, { range: PLACE_RANGE })
      } catch (_) { g = null }
      if (!g) {
        h.def++
        if (h.def > HOLE_DEFERS) shiftSkip(f, 'unreachable')
        else rotate(f)
        return
      }
      try {
        bot.pathfinder.setGoal(g, false)
      } catch (_) { /* retry next tick */ return }
      const prevKey = ctx.lastGoalKey
      ctx.lastGoalKey = key
      if (key !== f.issuedKey || prevKey === '' || prevKey === 'idle') {
        // Fresh hole (or a fresh start): fresh stall budget. Retaking the
        // SAME hole after a fight/bring tick stole the body (68p rule) keeps
        // stalls/lastPos. Either way the reach/stall checks run next tick:
        // setGoal resets the path, so isMoving() reads false right after the
        // issue and this same tick would burn a defer on a far hole (body-2).
        f.issuedKey = key
        h.stalls = 0
        h.lastPos = { x: bp.x, y: bp.y, z: bp.z }
      }
      return
    }
  }
  let moving = false
  try { moving = bot.pathfinder.isMoving() } catch (_) { /* treat as arrived */ }
  if (moving) {
    const grounded = !bot.entity || bot.entity.onGround !== false
    if (progressed(bp, h.lastPos, grounded)) {
      h.stalls = 0
      h.lastPos = { x: bp.x, y: bp.y, z: bp.z }
    } else if (++h.stalls >= WALK_STALLS) {
      const re = cellAt(bot, cx, cy, cz)
      if (re === 'solid') {
        shiftDone(f)
        return
      }
      h.def++
      if (h.def > HOLE_DEFERS) shiftSkip(f, 'unreachable')
      else rotate(f)
    }
    return
  }
  // Arrived (or the walk never started): place — but only from a
  // verified stand (cm0). A preemption that carried the body away leaves a
  // stale goal, and a partial-end the pathfinder settled for may face a
  // wall: attempting from either burns refusals, so force a fresh approach
  // instead (the old build.js feet-distance guard, now eye-based with a
  // line-of-sight check on the actual click), counted so a permanently far
  // hole still terminates.
  const p = new Vec3(cx, cy, cz)
  const ref = findRef(bot, p, bp)
  if (ref) {
    if (!standVerified(bot, bp, ref.ref, ref.face)) {
      try { ctx.lastGoalKey = '' } catch (_) { /* re-issue best-effort */ }
      h.def++
      if (h.def > HOLE_DEFERS) shiftSkip(f, 'unreachable')
      return
    }
    const item = findFillItem(bot)
    if (!item) {
      startDig(bot, ctx, f)
      return
    }
    placeFlight(bot, ctx, f, h, item, ref, p, false)
    return
  }
  // No reference: a floating cap in a wide deep pit. Either a support below
  // gives it footing (narrow shafts), or neighbouring columns capped on
  // later passes supply a side reference (wide pits close ring by ring).
  if (h.sup >= SUPPORT_DEPTH) {
    h.def++
    if (h.def > HOLE_DEFERS) shiftSkip(f, 'floating')
    else rotate(f)
    return
  }
  const below = cellAt(bot, cx, cy - 1, cz)
  if (below === 'solid') return // race: retry the cap next tick
  if (below === 'liquid') {
    shiftSkip(f, 'water')
    return
  }
  if (below === 'unloaded') {
    h.def++
    if (h.def > HOLE_DEFERS) shiftSkip(f, 'floating')
    else rotate(f)
    return
  }
  if (cellOccupied(bot, cx, cy - 1, cz)) {
    h.occ++
    if (h.occ > OCC_DEFERS) shiftSkip(f, 'occupied')
    else rotate(f)
    return
  }
  const sref = findRef(bot, new Vec3(cx, cy - 1, cz), bp)
  if (!sref) {
    h.def++
    if (h.def > HOLE_DEFERS) shiftSkip(f, 'floating')
    else rotate(f)
    return
  }
  if (!standVerified(bot, bp, sref.ref, sref.face)) {
    try { ctx.lastGoalKey = '' } catch (_) { /* re-issue best-effort */ }
    h.def++
    if (h.def > HOLE_DEFERS) shiftSkip(f, 'unreachable')
    return
  }
  const item = findFillItem(bot)
  if (!item) {
    startDig(bot, ctx, f)
    return
  }
  placeFlight(bot, ctx, f, h, item, sref, new Vec3(cx, cy - 1, cz), true)
}

// Bump shaving (w52.1): the head column digs top-down from h.y to the
// level. Every target re-verifies: still there, still natural, no structure
// within one block, nobody under it. Drops are walked into the inventory.
// Above-level footprints for the end-of-job sweep: every column the body
// occupies over the level can hold scaffold the bot placed mid-episode.
function recordStepped(f, bp) {
  try {
    if (!f || !f.stepped || f.level == null || !bp) return
    if (Math.floor(bp.y) > f.level) f.stepped.add(`${Math.floor(bp.x)},${Math.floor(bp.z)}`)
  } catch (_) { /* footprints best-effort */ }
}

// Scaffold the bot itself placed mid-episode (recover pillar stairs while
// stuck travelling, post-#158): dirt/cobble above the level in a stepped
// column that the scan never queued. The pathfinder scaffolds too, but the
// place seam in guardFlatSurface vetoes that above the level inside the
// square, so the sweep is the backstop for recover pillars; flat's own
// caps/supports land at/below the level. Runs ONCE at shave end over a
// frozen set, through the same shave safety gates (structure, liquid,
// under-feet; the allowlist is extended to SWEEP_MATS for sweep bumps),
// so it always terminates; tall remnants skip
// honestly as unreachable. Returns true when bumps were queued.
const SWEEP_MATS = new Set(['dirt', 'cobblestone'])

// Lone pillar (idkcraft-vewo.7): a free-standing 1x1 column cell of bot
// scaffold fill — nothing solid on its 4 horizontal sides at that height.
// Owner rule "flat means flat": such a column is shaved whoever placed it
// (placedByBot is per bot and lost on restart, so shape decides).
// ponytail: a player's bare 1-wide cobble post with no marker block next to
// it gets dug (accepted trade-off); the upgrade is a persisted, swarm-shared
// placedByBot. Unloaded neighbours read as solid (keep). Our own placed
// neighbours do not count: the pathfinder towers beside a tall pillar to
// reach its top, and that tower must not turn the lower cells into a wall.
// ignore(b) (g0z.61, optional): more neighbours that do not count — the
// castle sweep passes its plan/decor cells (a tower against a castle wall).
const PILLAR_MATS = new Set([...SWEEP_MATS, 'cobbled_deepslate'])
function lonePillar(bot, ctx, x, y, z, ignore = null) {
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    let b = null
    try { b = bot.blockAt(new Vec3(x + dx, y, z + dz)) } catch (_) { b = null }
    if (!b || (isSolidCell(b) && !util.isOwnPlaced(ctx, b) && !(ignore && ignore(b)))) return false
  }
  return true
}

// denyReason ctx for a lone pillar: the cell counts as own scaffold, so the
// drq default-deny on foreign cobble lets it through while beds, castle,
// castle yard and house-footprint rules (checked before the own exemption)
// still protect it.
function pillarCtx(ctx, x, y, z) {
  const own = new Set(ctx && ctx.placedByBot instanceof Set ? ctx.placedByBot : [])
  own.add(`${x},${y},${z}`)
  const names = ctx && ctx.placedNames instanceof Map ? new Map(ctx.placedNames) : null
  if (names) names.delete(`${x},${y},${z}`)
  return Object.assign(Object.create(ctx || null), { placedByBot: own, placedNames: names })
}
function buildSweep(bot, f) {
  if (!f || !f.stepped || f.stepped.size === 0 || f.level == null) return false
  if (!f.sweptTops) f.sweptTops = {}
  const before = f.bumps.length
  const blockAt = (x, y, z) => {
    try {
      return bot.blockAt(new Vec3(x, y, z))
    } catch (_) {
      return null
    }
  }
  for (const key of f.stepped) {
    const parts = String(key).split(',')
    const sx = Number(parts[0])
    const sz = Number(parts[1])
    if (!Number.isFinite(sx) || !Number.isFinite(sz)) continue
    if (Math.abs(sx - f.cx) > f.r || Math.abs(sz - f.cz) > f.r) continue
    if (!inTile(f, sx, sz)) continue
    if (f.bumpCols && f.bumpCols.has(key)) continue
    // Already queued and still queued: the shave gates own it now.
    if (f.bumps.some((b) => b.x === sx && b.z === sz)) continue
    const r = probeColumn(blockAt, sx, sz, f.level + 1 + SCAN_UP_EXTEND, f.level + 1)
    if (!r || r.status !== 'ok' || typeof r.topY !== 'number' || r.topY <= f.level) continue
    // xtbt: an examined column is offered once per topY — a kept sweep
    // bump is not re-queued, but a late pillar that grew taller after the
    // pass (or a pillar on a newly stepped column) is.
    if (f.sweptTops[key] != null && r.topY <= f.sweptTops[key]) continue
    const name = blockNameAt(bot, new Vec3(sx, r.topY, sz))
    if (!SWEEP_MATS.has(name)) continue
    f.sweptTops[key] = r.topY
    f.bumps.push({ x: sx, z: sz, topY: r.topY, y: r.topY, att: 0, def: 0, occ: 0, stalls: 0, lastPos: null, gateY: null, pickup: null, sweep: true })
  }
  const n = f.bumps.length - before
  if (n > 0) f.sweepTotal = (f.sweepTotal || 0) + n
  return n > 0
}

// End-of-job sweep, shared by the fill and shave exits: fill-only jobs
// never enter shaveTick, so both clean ends offer the sweep before
// finishing. Stalled/backstop finishes skip it (a wedged bot starts no
// new work). Repeatable (xtbt): every exit offers it, and buildSweep
// only queues columns it has not already offered, so late pillars on
// newly stepped columns (or regrown taller) are covered and the offer
// still terminates.
function maybeSweep(bot, f) {
  if (!f) return false
  const queued = buildSweep(bot, f)
  if (queued) f.swept = true
  return queued
}

// xtbt: record a kept bump column: the freezing marker for the finish
// line, and the column for the one shave-end re-check below.
function recordKept(f, h, marker) {
  try {
    const m = typeof marker === 'string' && marker ? marker : 'target'
    if (!f.keptMarkers) f.keptMarkers = {}
    f.keptMarkers[m] = (f.keptMarkers[m] || 0) + 1
    if (!Array.isArray(f.keptCols)) f.keptCols = []
    // xtbt: the sweep flag survives into keptCols, so the re-check can
    // honor the same sweep-material exemption the shave gate does.
    if (h && Number.isFinite(h.x) && Number.isFinite(h.z)) {
      const e = { x: h.x, z: h.z, marker: m }
      if (h.sweep) e.sweep = true
      f.keptCols.push(e)
    }
  } catch (_) { /* reporting never breaks the shave */ }
}

// xtbt: one re-check of kept bump columns at shave end. A marker that
// froze a column mid-episode may be gone by now (the other bot's
// temporary scaffold walked away, a torch since picked up, a house build
// that moved on): freed columns re-queue through the normal shave gates
// instead of freezing the next `flat` order. Runs once, so the episode
// still terminates; columns that stay frozen keep their kept count.
function recheckKept(bot, ctx, f) {
  if (!f || f.rechecked) return false
  f.rechecked = true
  if (!Array.isArray(f.keptCols) || f.keptCols.length === 0 || f.level == null) return false
  const blockAt = (x, y, z) => {
    try {
      return bot.blockAt(new Vec3(x, y, z))
    } catch (_) {
      return null
    }
  }
  let n = 0
  const still = []
  for (const k of f.keptCols) {
    let queued = false
    try {
      if (k && Number.isFinite(k.x) && Number.isFinite(k.z) &&
        Math.abs(k.x - f.cx) <= f.r && Math.abs(k.z - f.cz) <= f.r && inTile(f, k.x, k.z) &&
        !f.bumps.some((b) => b.x === k.x && b.z === k.z)) {
        const r = probeColumn(blockAt, k.x, k.z, f.level + 1 + SCAN_UP_EXTEND, f.level + 1)
        if (r && r.status === 'ok' && typeof r.topY === 'number' && r.topY > f.level) {
          const name = blockNameAt(bot, new Vec3(k.x, r.topY, k.z))
          const pillar = PILLAR_MATS.has(name) && lonePillar(bot, ctx, k.x, r.topY, k.z)
          // xtbt: same exemptions as the shave gate (isDiggable, sweep
          // mats on an original sweep bump, lone pillar) — a cobble
          // sweep column frozen by a now-gone marker must re-free.
          const sweepOk = !!k.sweep && SWEEP_MATS.has(name)
          if ((isDiggable(name) || sweepOk || pillar) && !structureNear(bot, k.x, r.topY, k.z)) {
            const nb = { x: k.x, z: k.z, topY: r.topY, y: r.topY, att: 0, def: 0, occ: 0, stalls: 0, lastPos: null, gateY: null, pickup: null, recheck: true }
            if (k.sweep) nb.sweep = true
            f.bumps.push(nb)
            f.totalBumps = (f.totalBumps || 0) + 1
            if (f.skip && f.skip.kept > 0) f.skip.kept--
            if (f.keptMarkers && k.marker && f.keptMarkers[k.marker] > 0) {
              f.keptMarkers[k.marker]--
              if (f.keptMarkers[k.marker] <= 0) delete f.keptMarkers[k.marker]
            }
            n++
            queued = true
          }
        }
      }
    } catch (_) { /* one bad column never blocks the re-check */ }
    if (!queued) still.push(k)
  }
  f.keptCols = still
  if (n > 0) {
    f.lastProgressTick = f.ticks
    console.log(`flat recheck re-queued ${n} bump${n === 1 ? '' : 's'} (marker gone)`)
  }
  return n > 0
}

function shaveTick(bot, ctx, f, bp) {
  f.ticks++
  f.shaveTicks = (f.shaveTicks || 0) + 1
  // v8bq R1: centre-out bands for the bumps (flag set by completions
  // and phase entries; rotateBump defers never set it) — the hilltop
  // budget must find a flat middle when it trips.
  if (f.orderDirty) {
    f.orderDirty = false
    orderBumpsByBot(f.bumps, bp, f.cx, f.cz)
  }
  recordStepped(f, bp)
  progressChat(bot, f)
  if (f.ticks - f.lastProgressTick > BACKSTOP_TICKS) {
    finish(bot, ctx, f, 'stalled')
    return
  }
  // x3y6.4: back to the holes once enough is banked or the bumps ran out
  // (no bumps -> the next empty hand takes the restock walk, then finishes).
  if (f.shaveForFill && (f.bumps.length === 0 || countFill(bot) >= FILL_RESUME)) {
    f.shaveForFill = false
    f.phase = 'fill'
    f.orderDirty = true // v8bq: the shave walked the body — re-sort around it
    f.lastProgressTick = f.ticks
    return
  }
  // xxmn hilltop budget (nearest-first queue: the middle is flat by now):
  // far leftovers skip as 'budget', the sweep/recheck/finish below ends it.
  if (f.bumps.length > 0 && f.shaveTicks > SHAVE_TICKS) {
    budgetStop(bot, ctx, f)
    // R1 P2: a shave-for-fill episode returns to its holes so banked blocks
    // land before anything finishes — the fill phase re-decides from there
    // (an empty hand restocks honestly, empty queues finish).
    if (f.shaveForFill) {
      f.shaveForFill = false
      f.phase = 'fill'
      f.orderDirty = true // v8bq: the shave walked the body — re-sort around it
      f.lastProgressTick = f.ticks
      return
    }
  }
  if (f.bumps.length === 0) {
    if (maybeSweep(bot, f)) return
    if (recheckKept(bot, ctx, f)) return
    finish(bot, ctx, f, null)
    return
  }
  const h = f.bumps[0]
  if (h.pickup) {
    // A drop 2+ above the feet needs a tower to reach — more scaffold than
    // the drop is worth. Skip the walk: the drop rides the column down as
    // the dig descends and gets vacuumed at the bottom (core-3).
    if (h.pickup.y - Math.floor(bp.y) >= 2) {
      h.pickup = null
      h.stalls = 0
      f.lastProgressTick = f.ticks
      return
    }
    const key = `flat-shave-pickup:${h.pickup.x},${h.pickup.y},${h.pickup.z}`
    if (key !== ctx.lastGoalKey) {
      // v8bq R1: the drop is already at our feet (chained in-reach dig)
      // — vacuum by proximity, no pickup walk. Real pickup reach only:
      // the feet at or above the drop within half a block (a drop 1-2
      // below the feet is out of the pickup box — walk for it, and the
      // timeout path records the litter). A drop above the feet falls
      // down to them.
      try {
        if (Math.hypot(bp.x - (h.pickup.x + 0.5), bp.z - (h.pickup.z + 0.5)) <= 1.5 &&
          bp.y - h.pickup.y <= 0.5) {
          h.pickup = null
          h.stalls = 0
          f.lastProgressTick = f.ticks
          return
        }
      } catch (_) { /* measure best-effort: walk as today */ }
      try {
        bot.pathfinder.setGoal(new goals.GoalNear(h.pickup.x, h.pickup.y, h.pickup.z, 1), false)
      } catch (_) { /* retry next tick */ return }
      ctx.lastGoalKey = key
      h.stalls = 0
      h.lastPos = { x: bp.x, y: bp.y, z: bp.z }
      return
    }
    let moving = false
    try { moving = bot.pathfinder.isMoving() } catch (_) { /* treat as arrived */ }
    if (!moving) {
      h.pickup = null
      h.stalls = 0
      f.lastProgressTick = f.ticks
      return
    }
    const grounded = !bot.entity || bot.entity.onGround !== false
    if (progressed(bp, h.lastPos, grounded)) {
      h.stalls = 0
      h.lastPos = { x: bp.x, y: bp.y, z: bp.z }
    } else if (++h.stalls >= PICKUP_STALLS) {
      recordLitter(f, h.pickup.x, h.pickup.y, h.pickup.z) // xxmn: the pack round vacuums it later
      h.pickup = null // the drop stays as litter; the column still advances
      h.stalls = 0
      f.lastProgressTick = f.ticks
    }
    return
  }
  // Cascade past air: someone may have dug ahead of us, or the stack had
  // gaps. Unloaded stops the cascade: digging blind is not an option.
  let y = h.y
  for (;;) {
    if (y <= f.level) break
    const cell = cellAt(bot, h.x, y, h.z)
    if (cell === 'air') { y--; continue }
    if (cell === 'unloaded') {
      h.def++
      if (h.def > HOLE_DEFERS) shiftBumpSkip(f, 'unreachable')
      else rotateBump(f)
      return
    }
    break
  }
  if (y < h.y) h.selfOcc = 0 // new level, fresh sidestep budget (core-2)
  h.y = y
  if (y <= f.level) {
    shiftBumpDone(f)
    return
  }
  const target = cellAt(bot, h.x, y, h.z)
  if (target === 'liquid') {
    shiftBumpSkip(f, 'water')
    return
  }
  const leak = liquidNear(bot, h.x, y, h.z)
  if (leak === 'lava') {
    shiftBumpSkip(f, 'lava')
    return
  }
  if (leak === 'water') {
    shiftBumpSkip(f, 'water')
    return
  }
  const name = blockNameAt(bot, new Vec3(h.x, y, h.z))
  // Sweep bumps carry our own pillar dirt/cobble: let SWEEP_MATS past the
  // allowlist (cobblestone is not diggable for ordinary bumps), and so do
  // lone 1x1 pillar cells of scaffold fill (vewo.7). All other gates below
  // (structure, liquid, under-feet) still apply.
  const pillar = PILLAR_MATS.has(name) && lonePillar(bot, ctx, h.x, y, h.z)
  if (!isDiggable(name) && !(h.sweep && SWEEP_MATS.has(name)) && !pillar) {
    recordKept(f, h, name) // ore, wood, built: keep valuables, keep houses
    shiftBumpSkip(f, 'kept')
    return
  }
  if (h.gateY !== y) {
    const marker = structureNear(bot, h.x, y, h.z)
    if (marker) {
      console.log(`flat bump ${h.x},${h.z} kept: ${marker} next to the dig`)
      recordKept(f, h, marker)
      shiftBumpSkip(f, 'kept')
      return
    }
    h.gateY = y
  }
  const selfThreat = threatenedSelf(bot, h.x, y, h.z)
  const playerThreat = threatenedByPlayer(bot, h.x, y, h.z)
  if (selfThreat && !playerThreat) {
    // Standing on the dig target (normal after climbing the bump, or after
    // a pickup parked on the column): step aside; a wedged bot skips the
    // column instead of orbiting it.
    h.selfOcc = (h.selfOcc || 0) + 1
    if (h.selfOcc > SELF_OCC_LIMIT) {
      shiftBumpSkip(f, 'occupied')
      return
    }
    sidestep(bot, ctx, h, bp, h.x, y, h.z, 'flat-shave-side')
    return
  }
  if (playerThreat) {
    h.occ++
    if (h.occ > OCC_DEFERS) {
      shiftBumpSkip(f, 'occupied')
      return
    }
    rotateBump(f)
    return
  }
  const key = `flat-shave:${h.x},${y},${h.z}`
  if (key !== ctx.lastGoalKey) {
    // v8bq: the next cut is already in dig reach (dense bump field) —
    // dig it from this stand instead of re-pathing per column. Falls
    // through to the moving/reach checks below, which re-verify.
    if (Math.hypot(bp.x - h.x, bp.y - y, bp.z - h.z) <= REACH_DIG) {
      try { clearGoal(bot, ctx) } catch (_) { /* stand best-effort */ }
      ctx.lastGoalKey = key
      f.issuedKey = key
      h.stalls = 0
      h.lastPos = { x: bp.x, y: bp.y, z: bp.z }
    } else {
      try {
        // Range 2 (NOT wider): GoalNear stops on floored nodes, and a range-4
        // stop can land past REACH_DIG, re-issuing the same already-satisfied
        // goal until the column burns its defers (round-2 majors). Range 2
        // stops ~2.9 worst case, always inside 4.5. Towering on tall isolated
        // columns is the accepted minor residual instead (core-5/core-3).
        bot.pathfinder.setGoal(new goals.GoalNear(h.x, y, h.z, 2), false)
      } catch (_) { /* retry next tick */ return }
      const prevKey = ctx.lastGoalKey
      ctx.lastGoalKey = key
      if (key !== f.issuedKey || prevKey === '' || prevKey === 'idle') {
        f.issuedKey = key
        h.stalls = 0
        h.lastPos = { x: bp.x, y: bp.y, z: bp.z }
      }
      return // reach/stall checks run next tick (body-2)
    }
  }
  let moving = false
  try { moving = bot.pathfinder.isMoving() } catch (_) { /* treat as arrived */ }
  if (moving) {
    const grounded = !bot.entity || bot.entity.onGround !== false
    if (progressed(bp, h.lastPos, grounded)) {
      h.stalls = 0
      h.lastPos = { x: bp.x, y: bp.y, z: bp.z }
    } else if (++h.stalls >= WALK_STALLS) {
      h.def++
      if (h.def > HOLE_DEFERS) shiftBumpSkip(f, 'unreachable')
      else rotateBump(f)
    }
    return
  }
  if (Math.hypot(bp.x - h.x, bp.y - y, bp.z - h.z) > REACH_DIG) {
    try { ctx.lastGoalKey = '' } catch (_) { /* re-issue best-effort */ }
    h.def++
    if (h.def > HOLE_DEFERS) shiftBumpSkip(f, 'unreachable')
    return
  }
  let block = null
  try { block = bot.blockAt(new Vec3(h.x, y, h.z)) } catch (_) { block = null }
  if (!block) {
    h.def++
    if (h.def > HOLE_DEFERS) shiftBumpSkip(f, 'unreachable')
    else rotateBump(f)
    return
  }
  let diggable = true
  try { diggable = typeof bot.canDigBlock === 'function' ? bot.canDigBlock(block) : true } catch (_) { diggable = false }
  if (!diggable) {
    shiftBumpSkip(f, 'refused')
    return
  }
  // House footprint (box + apron) beats the lone-pillar exemption, like the
  // bed/castle/yard rules: the own-scaffold ctx would pass it above site.y.
  const asPillar = pillar && !util.inHouseFootprint(ctx && ctx.home, block.position)
  const shaveDeny = denyReason(bot, block, asPillar ? pillarCtx(ctx, h.x, y, h.z) : ctx) // idkcraft-drq: shave terrain, not houses
  if (shaveDeny) {
    logDeny(block, shaveDeny)
    shiftBumpSkip(f, 'protected')
    return
  }
  digFlight(bot, ctx, f, h, block)
}

// zchb: a relayed square this bot cannot see yet — walk there (long walk
// ok) until its chunks load, then scan. setGoal resets the path, so a goal
// is re-issued only after TRAVEL_REISSUE idle ticks (pathing a far goal
// thinks across ticks; re-issuing every tick would never finish).
function travelTick(bot, ctx, f, bp) {
  // No new nearest whole-block distance for TRAVEL_STALL_TICKS = the
  // square is unreachable from here: finish (parks a helper, re-arms leave).
  const d = Math.floor(Math.hypot(bp.x - f.cx, bp.z - f.cz))
  if (f.travelBest == null || d < f.travelBest) { f.travelBest = d; f.travelStall = 0 } else if (++f.travelStall >= TRAVEL_STALL_TICKS) {
    finish(bot, ctx, f, 'cannot reach the square')
    return
  }
  const key = `flat:travel:${f.cx},${f.cz}`
  let moving = false
  try { moving = bot.pathfinder.isMoving() } catch (_) { /* idle */ }
  if (key === ctx.lastGoalKey && (moving || ++f.travelIdle < TRAVEL_REISSUE)) return
  if (key !== ctx.lastGoalKey) console.log(`flat travel anchor=${f.cx},${f.cz} r=${f.r}`)
  f.travelIdle = 0
  try { bot.pathfinder.setGoal(new goals.GoalNearXZ(f.cx, f.cz, f.r), false) } catch (_) { return }
  ctx.lastGoalKey = key
}

function flat(bot, ctx, target, state) {
  const f = ctx.flat
  if (!f) return
  const bp = bot.entity && bot.entity.position
  if (!bp) return
  // One async flight at a time across behaviours: a build/gather flight
  // still resolving when flat takes the body must land first.
  if (ctx.placeInFlight || ctx.digInFlight) return
  guardFlatSurface(bot, ctx)
  if (f.phase === 'scan') {
    // Inside the square: scan now, unloaded columns are reported as today.
    const away = Math.hypot(bp.x - f.cx, bp.z - f.cz) > f.r + 1
    if (away && !squareLoaded(bot, f.cx, f.cz, f.r, f.yTop)) travelTick(bot, ctx, f, bp)
    else scanTick(bot, ctx, f)
    return
  }
  // x3y6.6: loaded chunks from afar skip the scan travel; walk in before approaching holes/bumps
  if ((f.phase === 'fill' || f.phase === 'shave') && Math.max(Math.abs(bp.x - f.cx), Math.abs(bp.z - f.cz)) > f.r + TRAVEL_FAR) {
    if (!f.walkIn) { f.walkIn = true; f.travelBest = null; f.travelStall = 0 } // fresh give-up budget per walk-in
    travelTick(bot, ctx, f, bp)
    return
  }
  f.walkIn = false
  if (f.phase === 'dig') {
    digTick(bot, ctx, f, bp)
    return
  }
  if (f.phase === 'shave') {
    shaveTick(bot, ctx, f, bp)
    return
  }
  fillTick(bot, ctx, f, bp)
}

module.exports = flat
module.exports.EYE_HEIGHT = EYE_HEIGHT
module.exports.EYE_REACH = EYE_REACH
module.exports.FLAT_DEFAULT_RADIUS = FLAT_DEFAULT_RADIUS
module.exports.FLAT_MIN_RADIUS = FLAT_MIN_RADIUS
module.exports.FLAT_MAX_RADIUS = FLAT_MAX_RADIUS
module.exports.SCAN_PER_TICK = SCAN_PER_TICK
module.exports.SCAN_UP = SCAN_UP
module.exports.SCAN_DOWN = SCAN_DOWN
module.exports.SCAN_UP_EXTEND = SCAN_UP_EXTEND
module.exports.PLACE_ATTEMPTS = PLACE_ATTEMPTS
module.exports.WALK_STALLS = WALK_STALLS
module.exports.HOLE_DEFERS = HOLE_DEFERS
module.exports.OCC_DEFERS = OCC_DEFERS
module.exports.SUPPORT_DEPTH = SUPPORT_DEPTH
module.exports.PROGRESS_MS = PROGRESS_MS
module.exports.BACKSTOP_TICKS = BACKSTOP_TICKS
module.exports.DIG_TARGET = DIG_TARGET
module.exports.RESTOCK_SLACK = RESTOCK_SLACK
module.exports.restockTarget = restockTarget
module.exports.DIG_TICKS = DIG_TICKS
module.exports.DIG_STALLS = DIG_STALLS
module.exports.DIG_STREAK = DIG_STREAK
module.exports.FILL_BLOCKS = FILL_BLOCKS
module.exports.isFillBlock = isFillBlock
module.exports.isDirtName = isDirtName
module.exports.isLiquidName = isLiquidName
module.exports.isSolidCell = isSolidCell
module.exports.isAirCell = isAirCell
module.exports.cellAt = cellAt
module.exports.probeColumn = probeColumn
module.exports.spiralColumns = spiralColumns
module.exports.orderByBot = orderByBot
module.exports.orderBumpsByBot = orderBumpsByBot
module.exports.swarmTile = swarmTile
module.exports.swarmHelper = swarmHelper
module.exports.SWARM_HELPER_LINE = SWARM_HELPER_LINE
module.exports.stripOf = stripOf
module.exports.STEAL_MIN = STEAL_MIN
module.exports.scanRecord = scanRecord
module.exports.chooseLevel = chooseLevel
module.exports.detectHoles = detectHoles
module.exports.findFillItem = findFillItem
module.exports.countFill = countFill
module.exports.dirtIds = dirtIds
module.exports.fillIds = fillIds
module.exports.DIG_ROUNDS = DIG_ROUNDS
module.exports.SHAVE_TICKS = SHAVE_TICKS
module.exports.WIDE_DIG_RADIUS = WIDE_DIG_RADIUS
module.exports.PACK_TICKS = PACK_TICKS
module.exports.BRING_TICKS = BRING_TICKS
module.exports.BRING_RANGE = BRING_RANGE
module.exports.LITTER_MAX = LITTER_MAX
module.exports.recordLitter = recordLitter
module.exports.budgetStop = budgetStop
module.exports.planBring = planBring
module.exports.cellOccupied = cellOccupied
module.exports.cellOccupiedSelf = cellOccupiedSelf
module.exports.cellOccupiedByPlayer = cellOccupiedByPlayer
module.exports.threatenedSelf = threatenedSelf
module.exports.threatenedByPlayer = threatenedByPlayer
module.exports.isDiggable = isDiggable
module.exports.DIG_ALLOWLIST = [...DIG_ALLOWLIST]
module.exports.isStructureMarker = isStructureMarker
module.exports.structureNear = structureNear
module.exports.liquidNear = liquidNear
module.exports.detectBumps = detectBumps
module.exports.shiftBumpDone = shiftBumpDone
module.exports.buildSweep = buildSweep
module.exports.recheckKept = recheckKept
module.exports.recordKept = recordKept
module.exports.lonePillar = lonePillar
module.exports.PILLAR_MATS = PILLAR_MATS
module.exports.resumeLine = resumeLine
module.exports.DIG_ATTEMPTS = DIG_ATTEMPTS
module.exports.PICKUP_STALLS = PICKUP_STALLS
module.exports.REACH_DIG = REACH_DIG
module.exports.restockPoint = restockPoint
module.exports.RESTOCK_MIN_EDGE_GAP = RESTOCK_MIN_EDGE_GAP
module.exports.guardFlatSurface = guardFlatSurface
module.exports.SELF_OCC_LIMIT = SELF_OCC_LIMIT
module.exports.findRef = findRef
module.exports.parseRadius = parseRadius
module.exports.startEpisode = startEpisode
module.exports.feetLevel = feetLevel
module.exports.relayLine = relayLine
module.exports.parseRelay = parseRelay
module.exports.squareLoaded = squareLoaded
module.exports.TRAVEL_STALL_TICKS = TRAVEL_STALL_TICKS
module.exports.TRAVEL_FAR = TRAVEL_FAR
module.exports.progressChat = progressChat
module.exports.FIRST_PROGRESS_MS = FIRST_PROGRESS_MS
module.exports.FIRST_PROGRESS_N = FIRST_PROGRESS_N
