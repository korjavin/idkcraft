'use strict'

// Danger memory (idkcraft-mnx): gave-up/call_player spots that explore and
// gather must not lead back into, and gohome/forage route around (rw4.12). Separate from the resource finds store:
// these are avoidances, never targets. Distance is xz-only (pits are
// vertical; the bot's level never matches the mark exactly). Bounded + TTL,
// never throws.

const MAX_SPOTS = 64
const TTL_MS = 2 * 60 * 60 * 1000 // a filled pit goes stale within a session
const AVOID_RADIUS = 6 // pit + body + approach margin
const WATER_RADIUS = 32 // a water death bans the swim around it, not one cell
const MAX_RADIUS = 64 // widest mark: an ocean monument

function store(ctx) {
  if (!ctx) return null
  if (!ctx.danger) ctx.danger = { spots: [] }
  if (!Array.isArray(ctx.danger.spots)) ctx.danger.spots = []
  return ctx.danger
}

// Sanitized mark radius: finite clamps into [1, MAX_RADIUS], anything else
// reads as the default (never stored — default marks keep the old shape).
function radOf(r) {
  if (typeof r !== 'number' || !Number.isFinite(r)) return AVOID_RADIUS
  return Math.min(Math.max(r, 1), MAX_RADIUS)
}

// Effective radius of one stored spot: its own wide mark, else the default.
function spotRadius(s) {
  const r = s && typeof s.r === 'number' && Number.isFinite(s.r) ? s.r : AVOID_RADIUS
  return r > 0 ? r : AVOID_RADIUS
}

// Mark {x, y, z} dangerous now. A re-mark refreshes. radius is optional
// (9kd: water deaths ban a wide disc); default marks keep the old shape.
// Returns spot count.
function mark(ctx, p, now, radius) {
  const mem = store(ctx)
  if (!mem || !p || typeof p.x !== 'number' || typeof p.z !== 'number') return 0
  const t = typeof now === 'number' ? now : Date.now()
  prune(ctx, t)
  const y = typeof p.y === 'number' ? p.y : 0
  const i = mem.spots.findIndex((s) => Math.hypot(s.x - p.x, s.z - p.z) < 1 && Math.abs(s.y - y) < 2)
  if (i >= 0) mem.spots.splice(i, 1)
  const spot = { x: p.x, y, z: p.z, at: t }
  const r = radOf(radius)
  if (r !== AVOID_RADIUS) spot.r = r
  mem.spots.push(spot)
  while (mem.spots.length > MAX_SPOTS) mem.spots.shift()
  return mem.spots.length
}

// True when (x, z) lies within radius of a live mark. Uniform: every mark
// reads at the one radius (default AVOID_RADIUS), so pit-identity gates
// (recover's stuck chats) and gather/flat/deep bans never widen under a
// water disc (revmux 01). Per-mark width is covers(), the ring search only.
function near(ctx, p, radius, now) {
  const mem = ctx && ctx.danger
  if (!mem || !Array.isArray(mem.spots) || mem.spots.length === 0) return false
  if (!p || typeof p.x !== 'number' || typeof p.z !== 'number') return false
  const r = typeof radius === 'number' ? radius : AVOID_RADIUS
  const t = typeof now === 'number' ? now : Date.now()
  for (const s of mem.spots) {
    if (t - s.at > TTL_MS) continue
    if (Math.hypot(s.x - p.x, s.z - p.z) <= r) return true
  }
  return false
}

// True when (x, z) lies within some live mark's OWN disc (9kd: the explore
// ring ban — a water-death disc bans picks 32 out, pit marks still 6).
function covers(ctx, p, now) {
  const mem = ctx && ctx.danger
  if (!mem || !Array.isArray(mem.spots) || mem.spots.length === 0) return false
  if (!p || typeof p.x !== 'number' || typeof p.z !== 'number') return false
  const t = typeof now === 'number' ? now : Date.now()
  for (const s of mem.spots) {
    if (t - s.at > TTL_MS) continue
    if (Math.hypot(s.x - p.x, s.z - p.z) <= spotRadius(s)) return true
  }
  return false
}

// Live marks as fresh {x, y, z} points for planning (rw4.12 detour).
// Copies: callers cannot corrupt the memory. Wide marks ride .r (default
// marks keep the old shape). Never throws.
function spots(ctx, now) {
  try {
    const mem = ctx && ctx.danger
    if (!mem || !Array.isArray(mem.spots)) return []
    const t = typeof now === 'number' ? now : Date.now()
    const out = []
    for (const s of mem.spots) {
      if (!s || typeof s.x !== 'number' || typeof s.z !== 'number') continue
      if (t - s.at > TTL_MS) continue
      const c = { x: s.x, y: typeof s.y === 'number' ? s.y : 0, z: s.z }
      const r = spotRadius(s)
      if (r !== AVOID_RADIUS) c.r = r
      out.push(c)
    }
    return out
  } catch (_) { return [] }
}

// Blocks that mean "the body is in water" (revmux 01): monuments sit in
// deep ocean, where the death cell is often kelp/seagrass/bubble, not
// plain water — exact-'water' would miss those guardian kills.
const WATER_BLOCKS = new Set(['water', 'kelp', 'kelp_plant', 'seagrass', 'tall_seagrass', 'bubble_column'])

function blockName(bot, p) {
  try {
    const b = bot && bot.blockAt && p ? bot.blockAt(p) : null
    return b && typeof b.name === 'string' ? b.name : null
  } catch (_) { return null }
}

// Death in water (9kd): guardians are not in the hostile snapshot, so a
// monument kill reads as nearest=none and nothing was ever marked — the
// sheep search walked the same cell again 3 hours later. Any water death
// marks the wide disc: even a zombie-chased drowning means dangerous
// water, and the TTL bounds the ban. Feet first, then the head cell (a
// bobbing body straddles the surface). True when marked, never throws.
function markWaterDeath(bot, ctx, now) {
  try {
    const pos = bot && bot.entity && bot.entity.position
    if (!pos || typeof pos.x !== 'number' || typeof pos.y !== 'number' || !ctx) return false
    if (WATER_BLOCKS.has(blockName(bot, pos))) {
      mark(ctx, pos, now, WATER_RADIUS)
      return true
    }
    let head = null
    try {
      head = typeof pos.offset === 'function' ? pos.offset(0, 1, 0) : { x: pos.x, y: pos.y + 1, z: pos.z }
    } catch (_) { head = null }
    if (WATER_BLOCKS.has(blockName(bot, head))) {
      mark(ctx, pos, now, WATER_RADIUS)
      return true
    }
    return false
  } catch (_) { return false }
}

function prune(ctx, now) {
  const mem = ctx && ctx.danger
  if (!mem || !Array.isArray(mem.spots)) return 0
  const t = typeof now === 'number' ? now : Date.now()
  const before = mem.spots.length
  mem.spots = mem.spots.filter((s) => t - s.at <= TTL_MS)
  return before - mem.spots.length
}

function count(ctx) {
  const mem = ctx && ctx.danger
  return mem && Array.isArray(mem.spots) ? mem.spots.length : 0
}

function clear(ctx) {
  if (ctx && ctx.danger && Array.isArray(ctx.danger.spots)) ctx.danger.spots.length = 0
}

// Path cost (idkcraft-zj2p): water-death discs steer A* itself, so every
// walker (gohome, equip, castlefetch, forage, explore legs, homing, follow)
// routes around the drowned lake instead of re-walking its shore — the
// marks used to steer target picks only. A cost, never a ban: a target
// inside the disc (home by the water) still plans. Wide marks only
// (r >= WATER_RADIUS): pit marks belong to recover/detour. Measured on the
// landing cell centre, xz like near(). Same getNeighbors wrap shape as
// jumpcost.js; installed once per Movements by movementsFor (body.js),
// reading ctx live, so a fresh mark steers the next plan.
//
// Steep on purpose (rig, DROWNED-SHORE): a 100-block leg never finishes
// inside one 40 ms pathfinder tick, and the executor walks each PARTIAL
// path — A*'s best node is the discovered node nearest the goal. At a
// gentle cost (1/move) that node sat deep inside the disc and the bot
// walked straight through it while the search went on (17k nodes, never
// finished). At PATH_COST the frontier barely enters the disc (a step in
// costs more than the whole detour around), so partial paths stop at the
// rim.
//
// Feet or goal inside the disc (the job by the water, home on the shore):
// the costed core shrinks to the deeper of the two rings — only landings
// closer to the centre than the feet's (or the goal's) own whole-block
// ring cost. The walk out, the walk along and the walk in to a shore
// target stay cheap, so the steep cost never floods A* (the heuristic is
// off by the cost) where the disc cannot be avoided, while a plan still
// bends around the centre instead of crossing it. Whole-block rings, no
// slack: a replan one step in sees the same ring, so walks cannot creep
// inward plan by plan. The goal is read from the live pathfinder goal (x/z
// goals and GoalFollow's entity; other goal kinds keep the full disc).
const PATH_COST = 10
function addPathCost(movements, ctx, bot) {
  // Unit mocks carry flags only: wrap only a real Movements.
  if (!movements || typeof movements.getNeighbors !== 'function' || movements._dangerCostInstalled) return
  movements._dangerCostInstalled = true
  const orig = movements.getNeighbors.bind(movements)
  movements.getNeighbors = (node) => {
    const ns = orig(node)
    const discs = wideSpots(ctx, Date.now(), feetOf(bot), goalXZ(bot))
    if (discs.length === 0) return ns
    for (const m of ns) {
      if (!m || typeof m.cost !== 'number') continue
      if (discs.some((s) => Math.hypot(s.x - (m.x + 0.5), s.z - (m.z + 0.5)) < s.lim)) m.cost += PATH_COST
    }
    return ns
  }
}

function feetOf(bot) {
  try {
    const p = bot && bot.entity && bot.entity.position
    return p && typeof p.x === 'number' && typeof p.z === 'number' ? p : null
  } catch (_) { return null }
}

// The xz the live goal aims at, or null when the goal kind has none.
function goalXZ(bot) {
  try {
    const g = bot && bot.pathfinder && bot.pathfinder.goal
    if (!g) return null
    if (typeof g.x === 'number' && typeof g.z === 'number') return { x: g.x + 0.5, z: g.z + 0.5 }
    const e = g.entity && g.entity.position
    if (e && typeof e.x === 'number' && typeof e.z === 'number') return e
  } catch (_) { /* unknown goal: keep the cost */ }
  return null
}

// Live water-wide marks as { x, z, lim }: a landing closer than lim to the
// centre costs. Hot path (once per A* expansion): no copies of the store.
function wideSpots(ctx, t, feet, goal) {
  const ring = (s, p) => (p ? Math.floor(Math.hypot(s.x - p.x, s.z - p.z)) : Infinity)
  const mem = ctx && ctx.danger
  if (!mem || !Array.isArray(mem.spots) || mem.spots.length === 0) return []
  const out = []
  for (const s of mem.spots) {
    if (!s || typeof s.x !== 'number' || typeof s.z !== 'number' || t - s.at > TTL_MS) continue
    const r = spotRadius(s)
    if (r < WATER_RADIUS) continue
    out.push({ x: s.x, z: s.z, lim: Math.min(r, ring(s, feet), ring(s, goal)) })
  }
  return out
}

module.exports = { addPathCost, PATH_COST, mark, near, covers, spots, prune, count, clear, markWaterDeath, spotRadius, MAX_SPOTS, TTL_MS, AVOID_RADIUS, WATER_RADIUS, MAX_RADIUS }
