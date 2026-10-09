'use strict'

// Explore primitive (idkcraft-atl.1): hands only, no decisions — atl.2
// picks WHEN through the menu. Picks a target on the visited boundary
// (spiral from home/spawn, rings 16..512 capped at MAX_RADIUS (256) by default),
// arrival into the resource memory. Reports via ctx.stepStatus like every
// goal step (done on arrival, failed:<reason> otherwise). A stall inside
// ARRIVE_NEAR also arrives: exact spiral XZ cells often sit in a trunk or
// water with nowhere to stand, and the 48-block scan covers the point from
// a few blocks out — failing there would mark every forest ring
// unreachable without ever scanning it.
//
// A no-displacement stall fails the target; body wedges are stuck.js's.

const { goals } = require('mineflayer-pathfinder')
const { Vec3 } = require('vec3')
const stuck = require('../stuck')
const resources = require('../resources')
const danger = require('../danger')
const { say, clearGoal } = require('./util')

const RINGS = [16, 32, 64, 128, 192, 256, 320, 384, 448, 512] // spiral radii, feet
// Inner rings first: a hands-only walker without tools closes 16-32
// block forest legs (live probe: 30 blocks in 12 s) but wedges on nearly
// every 64-block one (trunk clusters, canopy gaps, rivers). Reach to 512
// is preserved; near rings also cover home ground first, where atl.2
// forages.
const RAY_COUNT = 8 // compass rays per ring, north first
const ARRIVE_DIST = 3 // horizontal feet, same envelope as follow range
const ARRIVE_NEAR = 8 // stalled inside this: covered, not failed (see below)
const MAX_RADIUS = 256 // spiral reach cap, feet from anchor (dxl: no players)
// Task bound (vmzq.18): while a build task is active (castle ordered or
// house sited but unbuilt) own side work stays within this of the task
// site — prod run2 walked a wool search 500 blocks castle->home. Matches
// the epic's own 64 (goal PARK_FORAGE_RADIUS); bring self hunts keep
// their 96 cap but anchor at the site too. Owner bring orders are never
// capped (R3a).
const TASK_SEARCH_RADIUS = 64
const STALL_TICKS = 10 // no-displacement walk ticks before unreachable
const MOVE_TOLERANCE = stuck.MOVE_TOLERANCE
const CHAT_MS = 30000 // departure chat at most this often

const DIRS = ['north', 'northeast', 'east', 'southeast', 'south', 'southwest', 'west', 'northwest']

function chunkOf(x, z) {
  return `${Math.floor(x / 16)},${Math.floor(z / 16)}`
}

// Drop a leg the bot died on (9kd round 2): the target alone is not enough —
// pickTarget is deterministic, so a target outside the fresh disc would be
// re-picked and re-pathed identically after respawn (stale GoalXZ included:
// lastGoalKey still matches, so setGoal is skipped). Consuming the target
// chunk advances the spiral past the killer leg — the unreachable-stall
// precedent — and the new key re-issues the goal. The bring order itself
// survives (legs uncounted), visited stays shared. True when a leg dropped.
function dropDeadLeg(ctx) {
  try {
    const e = ctx && ctx.explore
    if (!e || typeof e !== 'object' || !e.target) return false
    if (e.visited instanceof Set) {
      try { e.visited.add(chunkOf(e.target.x, e.target.z)) } catch (_) { /* consume best-effort */ }
    }
    e.target = null
    e.issuedKey = null
    return true
  } catch (_) { return false }
}

function compass(dx, dz) {
  const idx = ((Math.round(8 * Math.atan2(dx, -dz) / (2 * Math.PI)) % 8) + 8) % 8
  return DIRS[idx]
}

// Owner bring in progress (vmzq.18 R3): an explicit owner order is the
// owner's call — never anchored or capped to the task site. Self hunts
// carry o.self ('beds'); owner orders leave it unset.
function ownerBring(ctx) {
  try {
    return !!(ctx && ctx.bring && !ctx.bring.self)
  } catch (_) {
    return false
  }
}
// Anchor: the active castle site first (vmzq.18), then home, then world
// spawn. Null when none exists. A wool self-hunt from the castle used to
// anchor at home 500 blocks off and walk there; now it spirals at the site.
// Owner brings keep the home anchor (R3a).
// An unfinished, unparked castle project (vmzq.19): single source for the
// task anchor below and the goal.js castle-first vetoes — a parked/L2 or
// complete castle releases both.
function castleActive(ctx) {
  try {
    const st = ctx && ctx.castle
    return !!(st && st.site && typeof st.site.x === 'number' && !st.parked && st.phase !== 'complete')
  } catch (_) {
    return false
  }
}
function taskActive(ctx) {
  try {
    if (castleActive(ctx)) return true
  } catch (_) { /* no castle verdict */ }
  // Active unbuilt house site (R3b, bead 18 house OR castle): strict
  // built===false — anchor-only fixtures omit built (undefined) and stay
  // unbound, so the explore/bring-wool spirals keep their full reach.
  try {
    const home = ctx && ctx.home
    if (home && home.site && typeof home.site.x === 'number' && home.built === false) return true
  } catch (_) { /* no house verdict */ }
  return false
}
function anchorOf(bot, ctx) {
  try {
    const st = ctx && ctx.castle
    if (!ownerBring(ctx) && st && st.site && typeof st.site.x === 'number' && typeof st.site.z === 'number' && !st.parked && st.phase !== 'complete') {
      return { x: st.site.x, z: st.site.z, label: 'castle' }
    }
    const site = ctx && ctx.home && ctx.home.site
    if (site && typeof site.x === 'number' && typeof site.z === 'number') {
      return { x: site.x, z: site.z, label: 'home' }
    }
    const sp = bot && bot.spawnPoint
    if (sp && typeof sp.x === 'number' && typeof sp.z === 'number') {
      return { x: sp.x, z: sp.z, label: 'spawn' }
    }
  } catch (_) { /* unverifiable: no anchor */ }
  return null
}

// First spiral cell whose chunk is still unvisited (rings ascending, north
// first): the boundary of the visited. Null when explored out to maxRadius.
// banned(x, z) skips gave-up spots (mnx pit memory).
function pickTarget(visited, anchor, maxRadius, banned) {
  const cap = typeof maxRadius === 'number' ? maxRadius : MAX_RADIUS
  for (const r of RINGS) {
    if (r > cap) break
    for (let a = 0; a < RAY_COUNT; a++) {
      const x = Math.round(anchor.x + r * Math.sin(a * Math.PI / 4))
      const z = Math.round(anchor.z - r * Math.cos(a * Math.PI / 4))
      if (!visited.has(chunkOf(x, z)) && !(banned && banned(x, z))) return { x: x + 0, z: z + 0 } // +0: no -0 keys/logs
    }
  }
  return null
}

// Target height for the stuck escape (atl.23): the first standable cell
// from the top of a 32-block window above the bot down, in the target's
// column. A window that reads solid at its top (surface higher) or no
// solid at all (unloaded) falls back to the bot's y.
const COLUMN_WINDOW = 32
function columnTop(bot, t, fallback) {
  try {
    const top = Math.floor(fallback) + COLUMN_WINDOW
    let sawAir = false
    for (let y = top; y >= top - 2 * COLUMN_WINDOW; y--) {
      const b = bot.blockAt(new Vec3(t.x, y, t.z))
      if (!b) return fallback
      const air = b.name === 'air' || b.name === 'cave_air' || b.name === 'void_air'
      if (air) sawAir = true
      else return sawAir ? y + 1 : fallback
    }
  } catch (_) { /* unreadable: fallback */ }
  return fallback
}

// Shared arrival: scan the new chunks into memory, consume the point,
// report done with the one wedge line.
function arrive(bot, ctx, e, t) {
  clearGoal(bot, ctx)
  try {
    resources.scan(bot, ctx)
  } catch (_) { /* scan best-effort */ }
  const fresh = e.visited.size - (e.markStart || 0)
  e.visited.add(chunkOf(t.x, t.z)) // scanned: never re-pick this point
  e.target = null
  e.issuedKey = null
  ctx.stepStatus = 'done'
  console.log(`explore to ${t.x} ${t.z} (${fresh} chunks new)`)
}

function explore(bot, ctx, target, state) {
  if (!ctx.explore) ctx.explore = { visited: new Set(), target: null, lastPos: null, stalls: 0, issuedKey: null, markStart: 0, chatAt: 0 }
  const e = ctx.explore
  if (!(e.visited instanceof Set)) e.visited = new Set()
  const bp = bot.entity && bot.entity.position
  if (!bp) return
  const anchor = anchorOf(bot, ctx)
  if (!anchor) {
    ctx.stepStatus = 'failed:no-anchor'
    return
  }
  e.visited.add(chunkOf(bp.x, bp.z))

  // Depth floor (atl.23): GoalXZ has no height, so the cheapest XZ path
  // ran into caves (prod: 3 deaths at y -50 in 7 min). Under the floor the
  // leg drops and the bot climbs; the spiral resumes at bp.y >= floor.
  // ponytail: GoalY(floor) may stop in a cave at floor height; the
  // underground abort is vmzq.59's.
  const floor = resources.surfaceFloor(ctx, bp)
  if (bp.y < floor) {
    dropDeadLeg(ctx)
    const climbKey = `explore:climb:${floor}`
    if (climbKey !== ctx.lastGoalKey) {
      bot.pathfinder.setGoal(new goals.GoalY(floor), false)
      ctx.lastGoalKey = climbKey
      console.log(`explore too deep y=${Math.floor(bp.y)} floor=${floor}`)
    }
    return
  }

  if (!e.target) {
    if (typeof e.maxRadius !== 'number') e.maxRadius = MAX_RADIUS
    // Task bound (vmzq.18): own side work caps the spiral at the site;
    // owner bring orders walk the full spiral (R3a).
    // (.22) an explore-far unlock lifts the cap to the outer disk for the
    // window only; the radius clamps to 256 around the stable anchor.
    let cap = e.maxRadius
    try { if (taskActive(ctx) && !ownerBring(ctx)) cap = Math.min(cap, TASK_SEARCH_RADIUS) } catch (_) { /* unbound */ }
    try {
      const { goalUnlock } = require('../goal-unlock')
      const r = goalUnlock(ctx, 'radius')
      if (typeof r === 'number' && r > cap) cap = Math.min(e.maxRadius, r)
    } catch (_) { /* default cap */ }
    const t = pickTarget(e.visited, anchor, cap, (x, z) => danger.covers(ctx, { x, z }))
    if (!t) {
      // Spiral exhausted (hlk: persisted visited makes this permanent
      // across restarts, a done-log every tick forever): start over from
      // the current chunk — rescans refresh the resource memory, danger
      // bans still apply on the re-pick. This step still reports done.
      e.visited = new Set([chunkOf(bp.x, bp.z)])
      e.markStart = e.visited.size
      ctx.stepStatus = 'done' // nowhere new within 512: the outward job is over
      console.log('explore done: all chunks within ' + cap + ' blocks visited')
      return
    }
    e.target = t
    e.issuedKey = null
    e.markStart = e.visited.size
  }
  const t = e.target
  const key = `explore:${t.x},${t.z}`
  if (key !== ctx.lastGoalKey) {
    bot.pathfinder.setGoal(new goals.GoalXZ(t.x, t.z), false)
    const prevKey = ctx.lastGoalKey
    ctx.lastGoalKey = key
    if (key !== e.issuedKey || prevKey === '' || prevKey === 'idle') {
      // Fresh pursuit: point the body, reset the budget, announce. Taking
      // back the SAME target after a body-theft tick (68p rule) keeps
      // stalls/lastPos and walks on below this same tick.
      e.issuedKey = key
      e.stalls = 0
      e.lastPos = { x: bp.x, y: bp.y, z: bp.z }
      const dist = Math.round(Math.hypot(t.x - anchor.x, t.z - anchor.z))
      if (Date.now() - (e.chatAt || 0) >= CHAT_MS) {
        e.chatAt = Date.now()
        say(bot, `exploring ${compass(t.x - anchor.x, t.z - anchor.z)}, ${dist} blocks from ${anchor.label}`)
      }
      return
    }
  }

  const dist = Math.hypot(bp.x - t.x, bp.z - t.z)
  if (dist <= ARRIVE_DIST) {
    arrive(bot, ctx, e, t)
    return
  }

  // Stall by displacement (follow.js wedge lesson: a wedged executor keeps
  // reporting moving while the body stands still).
  if (e.lastPos && Math.hypot(bp.x - e.lastPos.x, bp.z - e.lastPos.z) > MOVE_TOLERANCE) {
    e.stalls = 0
    e.lastPos = { x: bp.x, y: bp.y, z: bp.z }
  } else if ((e.stalls = (e.stalls || 0) + 1) >= STALL_TICKS) {
    if (dist <= ARRIVE_NEAR) {
      arrive(bot, ctx, e, t) // covered: scan it, advance, no stuck fact
      return
    }
    clearGoal(bot, ctx)
    e.visited.add(chunkOf(t.x, t.z)) // unreachable: never re-pick this point
    e.target = null
    e.issuedKey = null
    ctx.stepStatus = 'failed:unreachable'
    // The target is the goal: without it dig_through has no direction and
    // goalDy/goalDist describe a bystander player (revmux round 1). One
    // escape per failed leg (core-1: else a pit cycles targets forever).
    stuck.request(bot, ctx, 'explore', { x: t.x, y: columnTop(bot, t, bp.y), z: t.z }, key)
  }
}

// Next leg target within cap feet of the anchor (9qt0: self wool hunts stay
// near home) — the pending target when in reach, else explore's own pick
// under the cap. Null: none.
function nextTarget(bot, ctx, cap) {
  try {
    const anchor = anchorOf(bot, ctx)
    if (!anchor) return null
    const e = ctx && ctx.explore
    const near = (p) => !!p && Math.hypot(p.x - anchor.x, p.z - anchor.z) <= cap
    if (e && near(e.target)) return e.target
    const t = pickTarget(e && e.visited instanceof Set ? e.visited : new Set(), anchor, cap, (x, z) => danger.covers(ctx, { x, z }))
    return near(t) ? t : null
  } catch (_) {
    return null
  }
}

module.exports = explore
module.exports.MAX_RADIUS = MAX_RADIUS
module.exports.TASK_SEARCH_RADIUS = TASK_SEARCH_RADIUS
module.exports.taskActive = taskActive
module.exports.castleActive = castleActive
module.exports.ownerBring = ownerBring
module.exports.nextTarget = nextTarget
module.exports.anchorOf = anchorOf // atl.8: bring search legs need the anchor check without walking
module.exports.dropDeadLeg = dropDeadLeg // 9kd: death path consumes the killer leg's target
