'use strict'

// Explore primitive (idkcraft-atl.1): hands only, no decisions — atl.2
// picks WHEN through the menu. Picks a target on the visited boundary
// (spiral from home/spawn, rings to ~512), walks it with GoalXZ, scans on
// arrival into the resource memory. Reports via ctx.stepStatus like every
// goal step (done on arrival, failed:<reason> otherwise).
//
// Stuck is the existing machinery: a no-displacement stall raises the
// fact via recover.setStuck and the ef3 menu owns the escape; the ticker
// backstops cover the rest. Detector only, like follow/gather.

const { goals } = require('mineflayer-pathfinder')
const recover = require('./recover')
const resources = require('../resources')

const RINGS = [64, 128, 192, 256, 320, 384, 448, 512] // spiral radii, feet
const RAY_COUNT = 8 // compass rays per ring, north first
const ARRIVE_DIST = 3 // horizontal feet, same envelope as follow range
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
// first): the boundary of the visited. Null when explored out to 512.
function pickTarget(visited, anchor) {
  for (const r of RINGS) {
    for (let a = 0; a < RAY_COUNT; a++) {
      const x = Math.round(anchor.x + r * Math.sin(a * Math.PI / 4))
      const z = Math.round(anchor.z - r * Math.cos(a * Math.PI / 4))
      if (!visited.has(chunkOf(x, z))) return { x, z }
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
    const t = pickTarget(e.visited, anchor)
    if (!t) {
      ctx.stepStatus = 'done' // nowhere new within 512: the outward job is over
      console.log('explore done: all chunks within 512 blocks visited')
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

  if (Math.hypot(bp.x - t.x, bp.z - t.z) <= ARRIVE_DIST) {
    // Arrived: the scout scan ingests the new chunks, one wedge line names
    // the target and how many chunks the walk covered.
    clearGoal(bot, ctx)
    let added = 0
    try {
      added = resources.scan(bot, ctx).added
    } catch (_) { /* scan best-effort */ }
    const fresh = e.visited.size - (e.markStart || 0)
    e.visited.add(chunkOf(t.x, t.z)) // scanned: never re-pick this point
    e.target = null
    e.issuedKey = null
    ctx.stepStatus = 'done'
    console.log(`explore to ${t.x} ${t.z} (${fresh} chunks new)`)
    return
  }

  // Stall by displacement (follow.js wedge lesson: a wedged executor keeps
  // reporting moving while the body stands still).
  if (e.lastPos && Math.hypot(bp.x - e.lastPos.x, bp.z - e.lastPos.z) > MOVE_TOLERANCE) {
    e.stalls = 0
    e.lastPos = { x: bp.x, y: bp.y, z: bp.z }
  } else if ((e.stalls = (e.stalls || 0) + 1) >= STALL_TICKS) {
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
