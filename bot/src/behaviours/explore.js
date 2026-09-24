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
// Stuck is the existing machinery: a no-displacement stall raises the
// fact via recover.setStuck and the ef3 menu owns the escape; the ticker
// backstops cover the rest. Detector only, like follow/gather.

const { goals } = require('mineflayer-pathfinder')
const recover = require('./recover')
const resources = require('../resources')
const danger = require('../danger')

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
const STALL_TICKS = 10 // no-displacement walk ticks before unreachable
const MOVE_TOLERANCE = 0.5
const CHAT_MS = 30000 // departure chat at most this often

const DIRS = ['north', 'northeast', 'east', 'southeast', 'south', 'southwest', 'west', 'northwest']

function chunkOf(x, z) {
  return `${Math.floor(x / 16)},${Math.floor(z / 16)}`
}

function compass(dx, dz) {
  const idx = ((Math.round(8 * Math.atan2(dx, -dz) / (2 * Math.PI)) % 8) + 8) % 8
  return DIRS[idx]
}

// Anchor: home site first, world spawn below. Null when neither exists.
function anchorOf(bot, ctx) {
  try {
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

  if (!e.target) {
    if (typeof e.maxRadius !== 'number') e.maxRadius = MAX_RADIUS
    const t = pickTarget(e.visited, anchor, e.maxRadius, (x, z) => danger.near(ctx, { x, z }))
    if (!t) {
      ctx.stepStatus = 'done' // nowhere new within 512: the outward job is over
      console.log('explore done: all chunks within ' + e.maxRadius + ' blocks visited')
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
    // goalDy/goalDist describe a bystander player (revmux round 1).
    recover.setStuck(ctx, 'explore', { x: t.x, y: bp.y, z: t.z }, key)
  }
}

module.exports = explore
module.exports.MAX_RADIUS = MAX_RADIUS
module.exports.anchorOf = anchorOf // atl.8: bring search legs need the anchor check without walking
