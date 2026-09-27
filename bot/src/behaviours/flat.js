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
// ('follow me', 'go work') cancels it, while 'stop' only parks it so a
// second `flat` resumes the episode instead of re-scanning.
//
// One behaviour tick advances at most one async place/dig flight (guarded by
// the shared ctx.placeInFlight / ctx.digInFlight seams, same as build/gather).

const Vec3 = require('vec3')
const { goals } = require('mineflayer-pathfinder')
const { countItems } = require('../perception')
const danger = require('../danger')

const FLAT_DEFAULT_RADIUS = 48
const FLAT_MIN_RADIUS = 4
const FLAT_MAX_RADIUS = 64
const SCAN_PER_TICK = 1200 // columns per tick; a 97x97 area scans in ~8 ticks
const SCAN_UP = 10 // scan ceiling = command-time feet + this
const SCAN_DOWN = 70 // scan floor = ceiling - this (deeper reads as deep)
const SCAN_UP_EXTEND = 30 // climb past a solid ceiling to find the true top
const PLACE_ATTEMPTS = 3 // refused placements per hole before skip
const WALK_STALLS = 10 // no-displacement walk ticks before defer (gather scale)
const HOLE_DEFERS = 4 // queue rotations before an unplaceable hole is skipped
const OCC_DEFERS = 6 // rotations before an occupied cell is skipped
const SUPPORT_DEPTH = 4 // support fills below one cap before deferring
const SELF_OCC_LIMIT = 6 // sidesteps out of our own cap cell before skip
const SIDESTEPS = [[3, 0], [-3, 0], [0, 3], [0, -3]]
const PROGRESS_MS = 120000 // progress chat cadence on the long job
const BACKSTOP_TICKS = 180 // ticks without any placement/skip before giving up
const DIG_TARGET = 32 // dirt to dig per restock episode
const DIG_TICKS = 300 // restock budget before resuming with what is on hand
const DIG_STALLS = 10
const DIG_STREAK = 3
const PLACE_RANGE = 4 // GoalPlaceBlock range, like build.js
const REACH_DIST = 5 // past this the approach goal is stale (build.js guard)
const MOVE_TOLERANCE = 0.5
const DIRT_FIND_RADIUS = 48
const DIRT_FIND_COUNT = 64

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

// Restock digs dirt outside the flat area (never inside: digging there would
// punch the new holes the order exists to remove). All three drop dirt.
const DIRT_NAMES = new Set(['dirt', 'grass_block', 'coarse_dirt'])

function isDirtName(name) {
  return typeof name === 'string' && DIRT_NAMES.has(name)
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

function say(bot, line) {
  try { bot.chat(line) } catch (_) { /* chat best-effort, like goal.js */ }
}

// Drop a live pathfinder goal like stopOnce, but without stop(): its latch
// would swallow the next setGoal issued on the same tick (gather pattern).
function clearGoal(bot, ctx) {
  try {
    if (bot.pathfinder && bot.pathfinder.goal && typeof bot.pathfinder.setGoal === 'function') {
      bot.pathfinder.setGoal(null)
    }
  } catch (_) { /* body best-effort */ }
  ctx.lastGoalKey = ''
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
//   { status: 'liquid', topY }                water/lava surface: skip + report
//   { status: 'deep' }                        no ground down to yBottom
//   { status: 'ok', topY, walkable }          ground found
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
  for (let d = y; d >= yBottom; d--) {
    const b = d === y ? top : at(d)
    if (b == null) continue // mid-scan null: defensive air
    if (isLiquidName(b.name)) return { status: 'liquid', topY: d }
    if (isSolidCell(b)) {
      const walkable = isAirCell(at(d + 1), true) && isAirCell(at(d + 2), true)
      return { status: 'ok', topY: d, walkable }
    }
  }
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

// Neighbor scan order: below first — a 1-deep hole's cap sits on the ground,
// so the reference is almost always the block under the cap.
const REF_DIRS = [
  [0, -1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0],
]

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
// predicate self-invalidates when the episode is gone, replaced or parked,
// so a cancel path ('follow me', 'go work', 'stop') can never leak a live
// guard into other behaviours.
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

function startEpisode(cx, cz, r, yTop, by) {
  return {
    key: `${cx},${cz},${r}`,
    cx, cz, r, by: by || 'you',
    yTop, yBottom: yTop - SCAN_DOWN,
    phase: 'scan',
    scan: { queue: spiralColumns(cx, cz, r), i: 0 },
    tops: [],
    cands: [],
    counts: { unloaded: 0, liquid: 0, bump: 0, covered: 0 },
    level: null,
    holes: [],
    total: 0,
    filled: 0,
    supports: 0,
    skip: { water: 0, occupied: 0, unreachable: 0, floating: 0, refused: 0 },
    parked: false,
    issuedKey: null,
    ticks: 0,
    lastProgressTick: 0,
    lastChat: 0,
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

function finish(bot, ctx, f, why) {
  const left = f.holes.length
  const skipped = Object.values(f.skip).reduce((a, b) => a + b, 0)
  let line = `flat done: filled ${f.filled} hole${f.filled === 1 ? '' : 's'}`
  if (left > 0) line += `, ${left} left (${why || 'around you'})`
  if (skipped > 0) {
    const parts = Object.entries(f.skip).filter(([, n]) => n > 0).map(([k, n]) => `${n} ${k}`)
    line += `, skipped ${skipped}: ${parts.join(', ')}`
  }
  say(bot, line)
  console.log(`flat finish filled=${f.filled} supports=${f.supports} left=${left} why=${why || 'done'} skip=${JSON.stringify(f.skip)}`)
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
  f.holes = detectHoles(f.cands, level, f.cx, f.cz)
  f.cands = []
  f.tops = []
  f.total = f.holes.length
  f.phase = 'fill'
  f.lastProgressTick = f.ticks
  f.lastChat = Date.now() // the start line below is the first progress
  const size = 2 * f.r + 1
  let line = `flattening ${size}x${size} around ${f.by}, level ${level}: ${f.total} holes`
  if (f.counts.unloaded > 0) line += `, ${f.counts.unloaded} unloaded`
  if (f.counts.liquid > 0) line += `, ${f.counts.liquid} water skipped`
  say(bot, line)
  if (f.total === 0) finish(bot, ctx, f, null)
}

function placeFlight(bot, ctx, f, h, item, ref, p, isSupport) {
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
    } catch (_) {
      h.att++
      if (h.att >= PLACE_ATTEMPTS) shiftSkip(f, 'refused')
    } finally {
      ctx.placeInFlight = false
    }
  })().catch(() => { ctx.placeInFlight = false })
}

function startDig(bot, ctx, f) {
  f.phase = 'dig'
  f.dig = { pos: null, phase: 'walk', skip: new Set(), streak: 0, ticks: 0, stalls: 0, lastPos: null }
  f.lastProgressTick = f.ticks
  say(bot, 'out of fill blocks, digging dirt')
}

// Restock origin: findBlocks returns the matches nearest to its point, so
// searching from the bot (inside the square) would return 64 inside blocks
// and the outside filter would drop all of them (body-1). Search from just
// past the nearest edge instead; the inside filter stays as a backstop.
function restockPoint(f, bp) {
  const dx = bp.x - f.cx
  const dz = bp.z - f.cz
  if (Math.abs(dx) > f.r || Math.abs(dz) > f.r) return new Vec3(bp.x, bp.y, bp.z)
  if (Math.abs(dx) > Math.abs(dz)) return new Vec3(f.cx + Math.sign(dx || 1) * (f.r + 4), bp.y, bp.z)
  return new Vec3(bp.x, bp.y, f.cz + Math.sign(dz || 1) * (f.r + 4))
}

// Nearest diggable dirt outside the flat square: mnx pit memory and the
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
  let best = null
  let bestD = Infinity
  for (const p of found) {
    if (Math.abs(p.x - f.cx) <= f.r && Math.abs(p.z - f.cz) <= f.r) continue
    if (d.skip.has(keyOf(p.x, p.y, p.z))) continue
    if (danger.near(ctx, p)) continue
    if (Math.floor(bp.x) === p.x && Math.floor(bp.y) - 1 === p.y && Math.floor(bp.z) === p.z) continue
    const dd = dist3(p, bp)
    if (dd < bestD) {
      bestD = dd
      best = p
    }
  }
  return best
}

function endDig(bot, ctx, f, resume) {
  f.dig = null
  if (resume) {
    f.phase = 'fill'
    f.lastProgressTick = f.ticks
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
      ctx.digInFlight = true
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
    // and the inventory count is the truth — move to the next dirt.
    d.pos = null
    d.phase = 'walk'
    if (countFill(bot) > have) {
      f.lastProgressTick = f.ticks
      d.streak = 0
    }
  }
}

function progressChat(bot, f) {
  const now = Date.now()
  if (now - (f.lastChat || 0) < PROGRESS_MS) return
  f.lastChat = now
  say(bot, `flat ${f.filled}/${f.total} (level ${f.level})`)
}

function fillTick(bot, ctx, f, bp) {
  f.ticks++
  progressChat(bot, f)
  if (f.ticks - f.lastProgressTick > BACKSTOP_TICKS) {
    finish(bot, ctx, f, 'stalled')
    return
  }
  if (f.holes.length === 0) {
    finish(bot, ctx, f, null)
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
    // goal parking spot): step aside so the cap can land. The offset rotates
    // with the attempt count; a bot that cannot move skips the hole instead
    // of orbiting it.
    h.selfOcc = (h.selfOcc || 0) + 1
    if (h.selfOcc > SELF_OCC_LIMIT) {
      shiftSkip(f, 'occupied')
      return
    }
    const step = SIDESTEPS[(h.selfOcc - 1) % SIDESTEPS.length]
    const key = `flat-side:${cx},${cy},${cz}:${h.selfOcc}`
    if (key !== ctx.lastGoalKey) {
      try {
        bot.pathfinder.setGoal(new goals.GoalNear(bp.x + step[0], bp.y, bp.z + step[1], 1), false)
      } catch (_) { /* retry next tick */ return }
      ctx.lastGoalKey = key
    }
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
  // Arrived (or the walk never started): place — but only in reach. A
  // preemption that carried the body away leaves a stale goal: attempting
  // from out there burns refusals, so force a fresh approach instead
  // (build.js guard), counted so a permanently far hole still terminates.
  if (Math.hypot(bp.x - cx, bp.y - cy, bp.z - cz) > REACH_DIST) {
    try { ctx.lastGoalKey = '' } catch (_) { /* re-issue best-effort */ }
    h.def++
    if (h.def > HOLE_DEFERS) shiftSkip(f, 'unreachable')
    return
  }
  const p = new Vec3(cx, cy, cz)
  const ref = findRef(bot, p)
  if (ref) {
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
  const item = findFillItem(bot)
  if (!item) {
    startDig(bot, ctx, f)
    return
  }
  placeFlight(bot, ctx, f, h, item, sref, new Vec3(cx, cy - 1, cz), true)
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
module.exports.restockPoint = restockPoint
module.exports.guardFlatSurface = guardFlatSurface
module.exports.SELF_OCC_LIMIT = SELF_OCC_LIMIT
module.exports.findRef = findRef
module.exports.parseRadius = parseRadius
module.exports.startEpisode = startEpisode
