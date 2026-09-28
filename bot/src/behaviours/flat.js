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
// level is a pond and stays skipped. After the shave, one sweep pass
// digs leftover above-level dirt/cobble in stepped columns (recover
// pillar stairs placed mid-episode) through the same safety gates;
// original-bump columns are never re-queued, so kept/refused bumps stay.
//
// v2 (w52.1) shaves bumps above the level after filling the holes, top-down
// per column. Digging is allowlisted to natural terrain (ores, containers,
// beds, doors, wood/glass and everything built stay untouched) with a
// structure-marker gate around each dig, and never under anyone's feet.
//
// One behaviour tick advances at most one async place/dig flight (guarded by
// the shared ctx.placeInFlight / ctx.digInFlight seams, same as build/gather).

const Vec3 = require('vec3')
const { goals } = require('mineflayer-pathfinder')
const { countItems } = require('../perception')
const danger = require('../danger')
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
const SIDESTEPS = [[3, 0], [-3, 0], [0, 3], [0, -3]]
const PROGRESS_MS = 120000 // progress chat cadence on the long job
const FIRST_PROGRESS_MS = 25000 // first progress comes fast: 2 min of silence reads as broken
const FIRST_PROGRESS_N = 10 // ...or after this many resolved cells, whichever first
const BACKSTOP_TICKS = 180 // ticks without any placement/skip before giving up
const DIG_TARGET = 32 // dirt to dig per restock episode
const DIG_TICKS = 300 // restock budget before resuming with what is on hand
const DIG_STALLS = 10
const DIG_STREAK = 3
const PLACE_RANGE = 4 // GoalPlaceBlock range, like build.js
const EYE_HEIGHT = 1.62 // survival eye height above the feet
const EYE_REACH = 4.4 // server survival block reach (4.5) minus pose/float margin
const PROT_GATE_R = 4 // shave skips bumps within this Chebyshev (x,z) of a refused cell (cm0)
const PROT_GATE_N = 2 // refused cells near the bump before the gate fires: one is a sample (cm0)
const DROP_SCAN_R = 5 // item-drop search radius around the dug cell for the pickup walk (cm0)
const DROP_RETARGETS = 2 // re-walks while the targeted drop is still live on arrival (cm0)
const MOVE_TOLERANCE = 0.5
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

// No-drop dig mats (cm0): phantom-unverifiable, excluded from the
// inventory-delta check (snow layers, ice and packed ice drop nothing, so
// a zero delta there proves nothing and must never flag a real dig).
const NODROP_DIG = new Set(['snow', 'ice', 'packed_ice'])

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

// Gross pickup counter (cm0): the phantom delta is NET — bridge scaffolds
// spend dirt while shaving, so vacuumed drops can net to zero. The collect
// packet counts GROSS vacuumed drops; hooked once per bot, read per column.
function hookCollect(bot) {
  try {
    if (!bot || bot._cm0gotHooked || typeof bot.on !== 'function') return
    bot._cm0gotHooked = true
    if (typeof bot._cm0got !== 'number') bot._cm0got = 0
    bot.on('playerCollect', (collector) => {
      try {
        if (collector && bot.entity && collector.id === bot.entity.id) bot._cm0got++
      } catch (_) { /* counting best-effort */ }
    })
  } catch (_) { /* hook best-effort */ }
}

function gotCount(bot) {
  try { return typeof bot._cm0got === 'number' ? bot._cm0got : 0 } catch (_) { return 0 }
}

// Nearest live item-drop entity within r of (x,y,z), or null. Drops pop
// sideways off the dug cell, so the pickup walk follows the drop, not the
// dig position (cm0: walking the dig cell misses scattered drops ~15%).
function nearestDrop(bot, x, y, z, r) {
  let best = null
  let bestD = Infinity
  let ents = []
  try { ents = Object.values((bot && bot.entities) || {}) } catch (_) { return null }
  for (const e of ents) {
    if (!e || !e.position) continue
    const nm = (e.name || '').toLowerCase()
    if (nm !== 'item' && nm !== 'item_stack') continue
    if (e.isValid === false) continue
    const d = Math.hypot(e.position.x - x, e.position.y - y, e.position.z - z)
    if (!(d <= r)) continue
    if (d < bestD) { bestD = d; best = e }
  }
  return best
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

function dirtIds(bot) {
  const byName = (bot.registry && bot.registry.blocksByName) || {}
  const ids = []
  for (const name of Object.keys(byName)) {
    if (!DIRT_NAMES.has(name)) continue
    const entry = byName[name]
    if (entry && typeof entry.id === 'number' && !ids.includes(entry.id)) ids.push(entry.id)
  }
  return ids
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
    for (const player of Object.values((bot && bot.players) || {})) {
      if (player && player.entity && covers(player.entity, x, y, z)) return true
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
  let hit = null
  try {
    if (!bot.world || typeof bot.world.raycast !== 'function') return true
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

// Server said no (fast revert) vs server said nothing (5 s timeout): a
// revert from a verified stand is deterministic (spawn protection, cm0), a
// timeout may be transient (lag) and earns one retry. Anything else (equip
// errors and other client-side failures) keeps the plain attempt counter.
function isTimeoutErr(e) {
  const m = e && typeof e.message === 'string' ? e.message : String(e)
  return /did not fire within timeout/i.test(m)
}

function isRevertErr(e) {
  const m = e && typeof e.message === 'string' ? e.message : String(e)
  return /Server refused to place/i.test(m)
}

// The reference is a real Block, not a position: bot.placeBlock derefs
// referenceBlock.position on the first line, so a bare Vec3 rejects every
// placement (build.js live bug).
function findRef(bot, p) {
  for (const [ox, oy, oz] of REF_DIRS) {
    const q = new Vec3(p.x + ox, p.y + oy, p.z + oz)
    let block = null
    try {
      block = bot.blockAt(q)
    } catch (_) { /* treat as open */ }
    if (block && isSolidCell(block)) {
      return { ref: block, face: new Vec3(-ox, -oy, -oz) }
    }
  }
  return null
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
function guardFlatSurface(bot, ctx) {
  try {
    const mov = bot && bot.pathfinder && bot.pathfinder.movements
    if (!mov || !Array.isArray(mov.exclusionAreasBreak)) return
    const f = ctx && ctx.flat
    const key = f ? f.key : null
    if (ctx.flatGuardKey === key && ctx.flatGuardMov === mov) return
    if (ctx.flatGuardFn) {
      for (const m of new Set([ctx.flatGuardMov, mov])) {
        if (m && Array.isArray(m.exclusionAreasBreak)) {
          m.exclusionAreasBreak = m.exclusionAreasBreak.filter((fn) => fn !== ctx.flatGuardFn)
        }
      }
      ctx.flatGuardFn = null
    }
    ctx.flatGuardMov = mov
    ctx.flatGuardKey = key
    if (!f) return
    const fn = (block) => {
      try {
        const cur = ctx.flat
        if (!cur || cur.key !== key || cur.parked || cur.level == null) return 0
        const k = ctx.lastGoalKey || ''
        if (!/^flat[:-]/.test(k)) return 0
        const q = block && block.position
        if (!q || typeof q.x !== 'number' || typeof q.y !== 'number' || typeof q.z !== 'number') return 0
        if (q.y > cur.level) return 0
        if (Math.abs(q.x - cur.cx) > cur.r || Math.abs(q.z - cur.cz) > cur.r) return 0
        return 100
      } catch (_) { return 0 }
    }
    mov.exclusionAreasBreak.push(fn)
    ctx.flatGuardFn = fn
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

function startEpisode(cx, cz, r, yTop, by) {
  return {
    key: `${cx},${cz},${r}`,
    cx, cz, r, by: by || 'you',
    yTop, yBottom: yTop - SCAN_DOWN,
    phase: 'scan',
    scan: { queue: spiralColumns(cx, cz, r), i: 0 },
    tops: [],
    cands: [],
    liquidCols: [],
    stepped: new Set(),
    bumpCols: null,
    swept: false,
    sweptN: 0,
    sweepTotal: 0,
    counts: { unloaded: 0, liquid: 0, bump: 0, covered: 0 },
    level: null,
    holes: [],
    total: 0,
    filled: 0,
    supports: 0,
    bumps: [],
    totalBumps: 0,
    shaved: 0,
    skip: { water: 0, lava: 0, occupied: 0, unreachable: 0, floating: 0, refused: 0, kept: 0, protected: 0 },
    protN: 0,
    protChatted: false,
    protCells: [], // refused-verified cells: the shave gate skips near these (cm0)
    abortWhy: null,
    parked: false,
    issuedKey: null,
    ticks: 0,
    lastProgressTick: 0,
    lastChat: 0,
    progressChats: 0,
    dig: null,
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
}

function shiftSkip(f, why) {
  f.holes.shift()
  if (f.skip[why] != null) f.skip[why]++
  f.lastProgressTick = f.ticks
}

function rotate(f) {
  f.holes.push(f.holes.shift())
}

function shiftBumpDone(f) {
  const h = f.bumps.shift()
  if (h && h.sweep) f.sweptN = (f.sweptN || 0) + 1
  else f.shaved++
  f.lastProgressTick = f.ticks
}

function shiftBumpSkip(f, why) {
  f.bumps.shift()
  if (f.skip[why] != null) f.skip[why]++
  f.lastProgressTick = f.ticks
}

// Column-done with phantom verification (cm0): a column whose checkable
// digs added nothing to the inventory was "shaved" as client ghosts (spawn
// protection resolves digs without breaking). Stray pickups only inflate
// the delta, so this errs toward done, never toward a false skip.
function bumpDoneOrPhantom(bot, f, h) {
  if (h && h.littered) {
    // A drop was left as litter (stalled walk, rolled away): the column is
    // dug but the delta is contaminated — done, never protection (cm0).
    console.log(`flat litter ${h.x},${h.topY},${h.z} dug=${h.dugN || 0}`)
    shiftBumpDone(f)
    return
  }
  if (h && (h.dugN || 0) > 0 && h.denseBefore != null) {
    let denseNow = h.denseBefore + 1
    try { denseNow = countItems(bot, () => true) } catch (_) { /* unreadable: done */ }
    let gotN = 0
    try { gotN = gotCount(bot) - (h.gotBefore || 0) } catch (_) { gotN = 0 }
    if (gotN > 0) {
      // Gross vacuumed drops: real digs happened (ghosts drop nothing), so
      // a flat NET delta is bridge spending, not protection (cm0).
      shiftBumpDone(f)
      return
    }
    if (denseNow <= h.denseBefore) {
      skipProtected(bot, f, { x: h.x, y: h.topY, z: h.z })
      shiftBumpSkip(f, 'protected')
      return
    }
  }
  shiftBumpDone(f)
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
  if (skipped > 0) {
    const parts = Object.entries(f.skip).filter(([, n]) => n > 0).map(([k, n]) => `${n} ${k}`)
    line += `, skipped ${skipped}: ${parts.join(', ')}`
  }
  say(bot, line)
  console.log(`flat finish filled=${f.filled} shaved=${f.shaved} supports=${f.supports} left=${left} why=${why || 'done'} skip=${JSON.stringify(f.skip)}`)
  clearGoal(bot, ctx)
  ctx.flat = null
  guardFlatSurface(bot, ctx) // episode gone: the detach path below runs
}

function scanRecord(f, c, r) {
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
  const level = chooseLevel(f.tops)
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
  f.bumpCols = new Set(f.bumps.map((b) => `${b.x},${b.z}`))
  f.cands = []
  f.tops = []
  f.total = f.holes.length
  f.totalBumps = f.bumps.length
  f.phase = 'fill'
  f.lastProgressTick = f.ticks
  f.lastChat = Date.now() // the start line below is the first progress
  const size = 2 * f.r + 1
  let line = `flattening ${size}x${size} around ${f.by}, level ${level}: ${f.total} holes`
  if (f.totalBumps > 0) line += `, ${f.totalBumps} bumps`
  if (f.counts.unloaded > 0) line += `, ${f.counts.unloaded} unloaded`
  if (f.counts.liquid > 0) line += `, ${f.counts.liquid} water skipped`
  say(bot, line)
  if (f.total === 0 && f.totalBumps === 0) finish(bot, ctx, f, null)
  else if (f.total === 0) f.phase = 'shave'
}

// Step aside from a cell the bot itself blocks: fixed direction per column
// and a stable goal key, so a multi-tick sidestep never reverses mid-walk
// (round-1 core-2/body-3). The caller counts attempts and skips when wedged.
function sidestep(bot, ctx, h, bp, x, y, z, tag) {
  const step = SIDESTEPS[Math.abs(h.x * 7 + h.z * 13) % SIDESTEPS.length]
  const key = `${tag}:${x},${y},${z}`
  if (key !== ctx.lastGoalKey) {
    try {
      bot.pathfinder.setGoal(new goals.GoalNear(bp.x + step[0], bp.y, bp.z + step[1], 1), false)
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

function skipProtected(bot, f, p) {
  f.protN = (f.protN || 0) + 1
  try { (f.protCells = f.protCells || []).push({ x: p.x, y: p.y, z: p.z }) } catch (_) { /* cells best-effort */ }
  let from = '?'
  try {
    const bp = bot.entity && bot.entity.position
    if (bp && typeof bp.x === 'number') {
      const fx = (n) => (Number.isInteger(n) ? n : n.toFixed(1))
      from = `${fx(bp.x)},${fx(bp.y)},${fx(bp.z)}`
    }
  } catch (_) { /* from best-effort */ }
  console.log(`flat protected ${p.x},${p.y},${p.z} from=${from}`)
  if (!f.protChatted) {
    f.protChatted = true
    say(bot, "can't build here, looks like spawn protection — skipping blocked cells")
  }
}

function placeFlight(bot, ctx, f, h, item, ref, p, isSupport) {
  const bp = bot.entity && bot.entity.position
  const ax = bp && typeof bp.x === 'number' ? bp.x : null
  const ay = ax === null ? null : bp.y
  const az = ax === null ? null : bp.z
  ctx.placeInFlight = true
  ;(async () => {
    try {
      await bot.equip(item, 'hand')
      await bot.placeBlock(ref.ref, ref.face)
      if (isSupport) {
        h.sup++
        f.supports++
        f.lastProgressTick = f.ticks
      } else {
        shiftDone(f)
      }
    } catch (e) {
      // A failure after the body moved (preemption) is stale, not evidence.
      // A revert from a verified stand is deterministic (spawn protection,
      // cm0): skip at once instead of burning all three attempts. A timeout
      // may be transient (lag) and earns one retry.
      let moved = true
      try {
        const np = bot.entity && bot.entity.position
        if (ax !== null && np && typeof np.x === 'number') {
          moved = Math.hypot(np.x - ax, np.y - ay, np.z - az) > 1
        }
      } catch (_) { /* unreadable: conservative, count the attempt */ }
      h.att++
      if (!moved && isRevertErr(e)) {
        skipProtected(bot, f, p)
        shiftSkip(f, 'protected')
      } else if (!moved && isTimeoutErr(e) && h.att >= 2) {
        skipProtected(bot, f, p)
        shiftSkip(f, 'protected')
      } else if (h.att >= PLACE_ATTEMPTS) {
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
  // Phantom baseline (cm0): a dig under spawn protection resolves without
  // breaking anything (client ghost-air, server intact). Checkable digs
  // always drop at least one item, so the column-done check below verifies
  // via the inventory delta instead of trusting the resolve.
  if (!NODROP_DIG.has(block.name)) {
    if (h.dugN == null) { h.dugN = 0; h.denseBefore = countItems(bot, () => true); h.gotBefore = gotCount(bot); hookCollect(bot) }
    h.dugN++
  }
  ;(async () => {
    try {
      // Stone by hand takes ~7.5 s and drops nothing; the harvest tool
      // (forage.js pattern) keeps the job fast and banks the drops.
      let tool = null
      try { tool = bot.pathfinder && typeof bot.pathfinder.bestHarvestTool === 'function' ? bot.pathfinder.bestHarvestTool(block) : null } catch (_) { tool = null }
      if (tool && typeof bot.equip === 'function') await bot.equip(tool, 'hand')
      await bot.dig(block)
      h.pickup = at // walk the drop into the inventory (gather pattern)
      h.retarget = null
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

function startDig(bot, ctx, f) {
  f.phase = 'dig'
  f.dig = { pos: null, phase: 'walk', skip: new Set(), streak: 0, ticks: 0, stalls: 0, lastPos: null }
  f.lastProgressTick = f.ticks
  say(bot, 'out of fill blocks, digging dirt')
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
function findDirt(bot, ctx, f, bp) {
  const ids = dirtIds(bot)
  if (ids.length === 0) return null
  let found = []
  try {
    found = bot.findBlocks({ matching: ids, point: restockPoint(f, bp), maxDistance: DIRT_FIND_RADIUS, count: DIRT_FIND_COUNT }) || []
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
    f.lastProgressTick = f.ticks
    return
  }
  // Shaving needs no fill blocks: fall through to the bumps instead of
  // ending the episode, and keep the reason for the leftover holes (body-5).
  if (f.bumps.length > 0) {
    f.phase = 'shave'
    f.abortWhy = 'no fill blocks'
    f.lastProgressTick = f.ticks
    say(bot, `no fill blocks, shaving ${f.bumps.length} bumps first`)
    return
  }
  finish(bot, ctx, f, 'no fill blocks')
}

function digTick(bot, ctx, f, bp) {
  f.ticks++
  const d = f.dig
  d.ticks++
  const have = countFill(bot)
  if (have >= DIG_TARGET) {
    endDig(bot, ctx, f, true)
    return
  }
  if (d.ticks > DIG_TICKS) {
    endDig(bot, ctx, f, have > 0)
    return
  }
  if (!d.pos) {
    const found = findDirt(bot, ctx, f, bp)
    if (!found) {
      endDig(bot, ctx, f, have > 0)
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
    if (name != null && !isDirtName(name)) {
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
      ctx.digInFlight = true
      d.dugHave = countFill(bot)
      ;(async () => {
        try { await bot.dig(block) } catch (_) { /* gone or interrupted: recount anyway */ }
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
    // and the inventory count is the truth — move to the next dirt. A dig
    // that resolved without filling anything is a phantom (spawn protection
    // resolves digs without breaking, cm0): count it like a stall so
    // restock ends after a few instead of digging air for five minutes.
    d.pos = null
    d.phase = 'walk'
    const dugHave = d.dugHave
    d.dugHave = null
    const now = countFill(bot)
    if (dugHave != null && now > dugHave) {
      f.lastProgressTick = f.ticks
      d.streak = 0
    } else if (dugHave != null) {
      d.streak++
      if (d.streak >= DIG_STREAK) endDig(bot, ctx, f, countFill(bot) > 0)
    } else if (now > have) {
      f.lastProgressTick = f.ticks
      d.streak = 0
    }
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
  if (f.phase === 'shave') say(bot, `flat shave ${f.shaved + (f.sweptN || 0)}/${f.totalBumps + (f.sweepTotal || 0)} (level ${f.level})`)
  else say(bot, `flat ${f.filled}/${f.total} (level ${f.level})`)
}

function fillTick(bot, ctx, f, bp) {
  f.ticks++
  recordStepped(f, bp)
  progressChat(bot, f)
  if (f.ticks - f.lastProgressTick > BACKSTOP_TICKS) {
    if (f.bumps.length > 0) {
      f.phase = 'shave'
      f.abortWhy = 'stalled'
      f.lastProgressTick = f.ticks
      return
    }
    finish(bot, ctx, f, 'stalled')
    return
  }
  if (f.holes.length === 0) {
    if (f.bumps.length === 0) maybeSweep(bot, f)
    if (f.bumps.length === 0) {
      finish(bot, ctx, f, null)
      return
    }
    f.phase = 'shave'
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
  if (selfIn && !playerIn) {
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
  if (playerIn) {
    h.occ++
    if (h.occ > OCC_DEFERS) {
      shiftSkip(f, 'occupied')
      return
    }
    rotate(f)
    return
  }
  if (Math.floor(bp.x) === cx && Math.floor(bp.z) === cz && Math.floor(bp.y) < cy) {
    // Standing below our own cap cell (a 2+-deep hole we dropped into; the
    // 1-deep head-in-cap case sidesteps above): capping from down here would
    // entomb the body under its own fill — the support lands in the head
    // cell and never places (cm0). Step out once (a body that can move must
    // not sit still spinning the stuck detector), then rotate: a truly
    // trapped body shows no displacement and the ticker backstop hands it
    // to recover, while a free body walks out and approaches normally.
    if (!h.f2step) {
      h.f2step = true
      sidestep(bot, ctx, h, bp, cx, cy, cz, 'flat-f2')
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
  const ref = findRef(bot, p)
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
  const sref = findRef(bot, new Vec3(cx, cy - 1, cz))
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
// column that the scan never queued. NOTE: mineflayer-pathfinder 2.4.5 has
// no scaffold code, so the pathfinder is never the source; flat's own
// caps/supports land at/below the level. Runs ONCE at shave end over a
// frozen set, through the same shave safety gates (structure, liquid,
// under-feet; the allowlist is extended to SWEEP_MATS for sweep bumps),
// so it always terminates; tall remnants skip
// honestly as unreachable. Returns true when bumps were queued.
const SWEEP_MATS = new Set(['dirt', 'cobblestone'])
function buildSweep(bot, f) {
  if (!f || !f.stepped || f.stepped.size === 0 || f.level == null) return false
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
    if (f.bumpCols && f.bumpCols.has(key)) continue
    const r = probeColumn(blockAt, sx, sz, f.level + 1 + SCAN_UP_EXTEND, f.level + 1)
    if (!r || r.status !== 'ok' || typeof r.topY !== 'number' || r.topY <= f.level) continue
    const name = blockNameAt(bot, new Vec3(sx, r.topY, sz))
    if (!SWEEP_MATS.has(name)) continue
    f.bumps.push({ x: sx, z: sz, topY: r.topY, y: r.topY, att: 0, def: 0, occ: 0, stalls: 0, lastPos: null, gateY: null, pickup: null, sweep: true })
  }
  const n = f.bumps.length - before
  if (n > 0) f.sweepTotal = (f.sweepTotal || 0) + n
  return n > 0
}

// End-of-job sweep, shared by the fill and shave exits: fill-only jobs
// never enter shaveTick, so both clean ends offer the sweep before
// finishing. Stalled/backstop finishes skip it (a wedged bot starts no
// new work). Runs once: the second exit finds f.swept set.
function maybeSweep(bot, f) {
  if (!f || f.swept) return false
  f.swept = true
  return buildSweep(bot, f)
}

function shaveTick(bot, ctx, f, bp) {
  f.ticks++
  recordStepped(f, bp)
  progressChat(bot, f)
  if (f.ticks - f.lastProgressTick > BACKSTOP_TICKS) {
    finish(bot, ctx, f, 'stalled')
    return
  }
  if (f.bumps.length === 0) {
    if (maybeSweep(bot, f)) return
    finish(bot, ctx, f, null)
    return
  }
  const h = f.bumps[0]
  if (h.pickup) {
    // Follow the live drop, not the dig cell: drops pop sideways, and a
    // walk to the empty dig cell arrives clean while the drop sits two
    // blocks away — a zero delta the phantom check reads as protection
    // (cm0). No visible drop (ghost dig, already vacuumed) falls back to
    // the dig cell.
    let tgt = h.pickup
    let dropId = null
    const drop = nearestDrop(bot, h.pickup.x, h.pickup.y, h.pickup.z, DROP_SCAN_R)
    if (drop) { tgt = drop.position; dropId = drop.id }
    // A drop 2+ above the feet needs a tower to reach — more scaffold than
    // the drop is worth. Skip the walk: the drop rides the column down as
    // the dig descends and gets vacuumed at the bottom (core-3).
    if (tgt.y - Math.floor(bp.y) >= 2) {
      h.pickup = null
      h.stalls = 0
      f.lastProgressTick = f.ticks
      return
    }
    const key = `flat-shave-pickup:${Math.floor(tgt.x)},${Math.floor(tgt.y)},${Math.floor(tgt.z)}`
    if (key !== ctx.lastGoalKey) {
      try {
        bot.pathfinder.setGoal(new goals.GoalNear(tgt.x, tgt.y, tgt.z, 1), false)
      } catch (_) { /* retry next tick */ return }
      ctx.lastGoalKey = key
      h.stalls = 0
      h.lastPos = { x: bp.x, y: bp.y, z: bp.z }
      return
    }
    let moving = false
    try { moving = bot.pathfinder.isMoving() } catch (_) { /* treat as arrived */ }
    if (!moving) {
      // Arrived with the targeted drop still live: it rolled mid-walk.
      // Re-walk to its new spot; a drop that never vacuums is litter, not
      // evidence of protection.
      if (dropId !== null) {
        let live = false
        try { const e = bot.entities && bot.entities[dropId]; live = !!(e && e.isValid !== false) } catch (_) { live = false }
        if (live) {
          h.retarget = (h.retarget || 0) + 1
          if (h.retarget <= DROP_RETARGETS) {
            try { ctx.lastGoalKey = '' } catch (_) { /* re-issue best-effort */ }
            h.stalls = 0
            f.lastProgressTick = f.ticks
            return
          }
          h.littered = true
        }
      }
      h.pickup = null
      h.retarget = null
      h.stalls = 0
      f.lastProgressTick = f.ticks
      return
    }
    const grounded = !bot.entity || bot.entity.onGround !== false
    if (progressed(bp, h.lastPos, grounded)) {
      h.stalls = 0
      h.lastPos = { x: bp.x, y: bp.y, z: bp.z }
    } else if (++h.stalls >= PICKUP_STALLS) {
      h.littered = true // the drop stays as litter; the column still advances
      h.pickup = null
      h.retarget = null
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
    bumpDoneOrPhantom(bot, f, h)
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
  // allowlist (cobblestone is not diggable for ordinary bumps). All other
  // gates below (structure, liquid, under-feet) still apply.
  if (!isDiggable(name) && !(h.sweep && SWEEP_MATS.has(name))) {
    shiftBumpSkip(f, 'kept') // ore, wood, built: keep valuables, keep houses
    return
  }
  if (h.gateY !== y) {
    const marker = structureNear(bot, h.x, y, h.z)
    if (marker) {
      console.log(`flat bump ${h.x},${h.z} kept: ${marker} next to the dig`)
      shiftBumpSkip(f, 'kept')
      return
    }
    h.gateY = y
  }
  // Protection gate (cm0): protection is area-coherent (a 33-wide square),
  // so a bump near refused-verified cells is almost surely undiggable too
  // — skip it without the approach walk, the dig and the pickup walk
  // (verified shaving costs ~40 s/cell there, mostly stuck cycles). Fill
  // holes keep their one verified attempt each (cheap, honest per-cell
  // evidence); only the expensive shave verification gates. The gate needs
  // a cluster (PROT_GATE_N): one refusal is a sample, and a lone
  // mislabelled column must not cascade across the field.
  const protNear = (f.protCells || []).filter((c) => Math.abs(c.x - h.x) <= PROT_GATE_R && Math.abs(c.z - h.z) <= PROT_GATE_R).length
  if (protNear >= PROT_GATE_N) {
    skipProtected(bot, f, { x: h.x, y, z: h.z })
    shiftBumpSkip(f, 'protected')
    return
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
  const shaveDeny = denyReason(bot, block, ctx) // idkcraft-drq: shave terrain, not houses
  if (shaveDeny) {
    logDeny(block, shaveDeny)
    shiftBumpSkip(f, 'protected')
    return
  }
  digFlight(bot, ctx, f, h, block)
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
    scanTick(bot, ctx, f)
    return
  }
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
module.exports.chooseLevel = chooseLevel
module.exports.detectHoles = detectHoles
module.exports.findFillItem = findFillItem
module.exports.countFill = countFill
module.exports.dirtIds = dirtIds
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
module.exports.buildSweep = buildSweep
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
module.exports.progressChat = progressChat
module.exports.FIRST_PROGRESS_MS = FIRST_PROGRESS_MS
module.exports.FIRST_PROGRESS_N = FIRST_PROGRESS_N
module.exports.EYE_HEIGHT = EYE_HEIGHT
module.exports.EYE_REACH = EYE_REACH
module.exports.hookCollect = hookCollect
module.exports.gotCount = gotCount
