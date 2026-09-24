'use strict'

// Deliver step (idkcraft-atl.2): carry ctx.haul to the nearest online
// player and toss it nearby. Haul shape { name: count } — forage banks
// deltas there; deliver revalidates against the live inventory (died,
// tossed, or crafted away since) and prunes.
//
// Visible player (tracked entity): the follow behaviour walks the body
// (GoalFollow 3, its own wedge facts — reused, not reinvented) and the
// toss lands within 3.5; the shared greeter announces the arrival (v92
// seam, same latch as follow/bring). Online but unseen: 3a7 honesty —
// say where the bot is, wait at home/spawn, KEEP the haul. Nobody
// online: infeasible (dxl runs forage/explore only), the step refuses.

const { goals } = require('mineflayer-pathfinder')
const follow = require('./follow')
const { countItems } = require('../perception')

const DELIVER_RANGE = 3
const TOSS_RANGE = DELIVER_RANGE + 0.5
// Ticks walking at a visible player with no displacement before the step
// admits defeat. Past follow's own budget (2 stalls over terminal statuses
// and timeouts) plus a recovery escape: only a genuinely unreachable player
// survives this long (revmux 01: ctx.stuck never reaches a goal step — the
// ticker routes stuck ticks to recover — so a deliver-side counter owns it).
const NO_PATH_TICKS = 20
const MOVE_TOLERANCE = 0.5

function say(bot, line) {
  try { bot.chat(line) } catch (_) { /* chat best-effort, like goal.js */ }
}

function atPos(bot) {
  const bp = bot.entity && bot.entity.position
  return bp ? `${Math.round(bp.x)} ${Math.round(bp.y)} ${Math.round(bp.z)}` : 'unknown'
}

function botPos(bot) {
  try {
    const p = bot && bot.entity && bot.entity.position
    if (p && typeof p.x === 'number') return p
  } catch (_) { /* no position */ }
  return null
}

function dist(a, b) {
  try {
    if (a && typeof a.distanceTo === 'function' && b) return a.distanceTo(b)
  } catch (_) { /* fall through */ }
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)
}

// Merge gains into the haul (forage finish).
function addHaul(ctx, gains) {
  try {
    if (!ctx) return
    if (!ctx.haul) ctx.haul = {}
    for (const n of Object.keys(gains || {})) {
      const c = gains[n] || 0
      if (c > 0) ctx.haul[n] = (ctx.haul[n] || 0) + c
    }
  } catch (_) { /* haul best-effort */ }
}

// Haul revalidated against the live inventory: { items, total }.
function haulLive(bot, ctx) {
  const items = {}
  let total = 0
  try {
    const haul = (ctx && ctx.haul) || {}
    for (const n of Object.keys(haul)) {
      let have = 0
      try { have = countItems(bot, (m) => m === n) } catch (_) { have = 0 }
      const c = Math.min(haul[n] || 0, have)
      if (c > 0) { items[n] = c; total += c }
    }
  } catch (_) { /* empty haul */ }
  return { items, total }
}

function haulTotal(bot, ctx) {
  try {
    return haulLive(bot, ctx).total
  } catch (_) {
    return 0
  }
}

// Nearest online player: an entity (visible/tracked) beats a bare online
// name. Skips the bot itself.
function playerStatus(bot) {
  let far = null
  let near = null
  let nearDist = Infinity
  try {
    const bp = botPos(bot)
    const players = (bot && bot.players) || {}
    for (const key of Object.keys(players)) {
      if (key === bot.username) continue
      const p = players[key]
      if (!p) continue
      const ent = p.entity
      if (ent && ent.position) {
        const d = bp ? dist(bp, ent.position) : Infinity
        if (d < nearDist) { nearDist = d; near = { name: (p.username || key), entity: ent } }
      } else if (!far) {
        far = { name: (p.username || key), entity: null }
      }
    }
  } catch (_) { /* no players */ }
  if (near) return { level: 'near', name: near.name, entity: near.entity }
  if (far) return { level: 'far', name: far.name, entity: null }
  return { level: 'none', name: null, entity: null }
}

// Follow's own arrival verdict (follow.js:116-121): the floored node within
// GoalFollow range (3, same literal follow.js uses). A satisfied follow parked
// the body on purpose — neither a no-path situation for the counter nor a
// reason to withhold the toss when true distance reads just past TOSS_RANGE.
function followSatisfied(bp, entity) {
  try {
    const node = bp && (typeof bp.floored === 'function'
      ? bp.floored()
      : { x: Math.floor(bp.x), y: Math.floor(bp.y), z: Math.floor(bp.z) })
    if (!node || !entity || !entity.position) return false
    return new goals.GoalFollow(entity, 3).isEnd(node)
  } catch (_) {
    return false
  }
}

// Drop a live pathfinder goal without stop() (explore/gather lesson).
function clearGoal(bot, ctx) {
  try {
    if (bot.pathfinder && bot.pathfinder.goal && typeof bot.pathfinder.setGoal === 'function') {
      bot.pathfinder.setGoal(null)
    }
  } catch (_) { /* body best-effort */ }
  ctx.lastGoalKey = ''
}

function homeOrSpawn(bot, ctx) {
  try {
    const site = ctx && ctx.home && ctx.home.site
    if (site && typeof site.x === 'number' && typeof site.z === 'number') {
      const y = typeof site.y === 'number' ? site.y : null
      return { x: site.x, y, z: site.z }
    }
  } catch (_) { /* fall through to spawn */ }
  try {
    const sp = bot && bot.spawnPoint
    if (sp && typeof sp.x === 'number') return { x: sp.x, y: typeof sp.y === 'number' ? sp.y : null, z: sp.z }
  } catch (_) { /* nowhere to wait */ }
  return null
}

function deliver(bot, ctx, target, state) {
  const bp = botPos(bot)
  if (!bp) return
  const live = haulLive(bot, ctx)
  if (live.total <= 0) {
    try { ctx.haul = {} } catch (_) { /* already empty */ }
    ctx.deliver = null
    clearGoal(bot, ctx)
    ctx.stepStatus = 'failed:empty'
    return
  }
  const ps = playerStatus(bot)
  if (ps.level === 'none') {
    ctx.deliver = null
    clearGoal(bot, ctx)
    ctx.stepStatus = 'failed:no-player'
    return
  }
  if (!ctx.deliver) ctx.deliver = { saidWaiting: false, tossInFlight: false }
  const f = ctx.deliver

  if (ps.entity) {
    // Visible: follow walks (GoalFollow 3 + its wedge facts), toss in range.
    // Unreachable player: follow raises stuck, recover escapes, the latch
    // then blocks re-fire and follow re-issues forever — so the step counts
    // its own fruitless walk ticks (frozen while recover owns the body) and
    // fails with the haul kept. Progress (a chase) or toss range resets.
    let d0 = null
    try { d0 = dist(bp, ps.entity.position) } catch (_) { d0 = null }
    const arrived = followSatisfied(bp, ps.entity)
    if (d0 !== null && d0 > TOSS_RANGE && !arrived) {
      let moved = false
      try {
        const lp = f.lastPos
        moved = !!(lp && Math.hypot(bp.x - lp.x, bp.z - lp.z) > MOVE_TOLERANCE)
      } catch (_) { moved = false }
      try { f.lastPos = { x: bp.x, y: bp.y, z: bp.z } } catch (_) { /* pos best-effort */ }
      if (moved) {
        f.noPathTicks = 0
      } else {
        f.noPathTicks = (f.noPathTicks || 0) + 1
        if (f.noPathTicks >= NO_PATH_TICKS) {
          ctx.deliver = null
          clearGoal(bot, ctx)
          ctx.stepStatus = 'failed:no-path'
          const what = Object.keys(live.items).map((n) => `${live.items[n]} ${n}`).join(', ')
          say(bot, `can't reach ${ps.name} — holding your ${what}`)
          return
        }
      }
    } else {
      f.noPathTicks = 0
    }
    f.saidWaiting = false
    follow(bot, ctx, ps.entity, state)
    let d = null
    try { d = dist(bp, ps.entity.position) } catch (_) { d = null }
    try {
      const g = ctx.greeter
      if (g && typeof g.greetOnArrival === 'function' && d !== null) {
        let moving = true
        try { moving = !!(bot.pathfinder && typeof bot.pathfinder.isMoving === 'function' && bot.pathfinder.isMoving()) } catch (_) { /* assume moving */ }
        g.greetOnArrival(bot, ps.name, d, !moving)
      }
    } catch (_) { /* greeting best-effort */ }
    if (d === null || (d > TOSS_RANGE && !arrived)) return
    if (f.tossInFlight) return
    f.tossInFlight = true
    void (async () => {
      const got = []
      try {
        for (const n of Object.keys(live.items)) {
          let id = null
          try {
            const entry = bot.registry && bot.registry.itemsByName && bot.registry.itemsByName[n]
            id = entry && entry.id
          } catch (_) { id = null }
          if (typeof id !== 'number' || typeof bot.toss !== 'function') continue
          let have = 0
          try { have = countItems(bot, (m) => m === n) } catch (_) { have = 0 }
          const c = Math.min(have, live.items[n] || 0)
          if (c <= 0) continue
          try {
            await bot.toss(id, null, c)
            got.push(`${c} ${n}`)
            try { ctx.haul[n] = Math.max(0, (ctx.haul[n] || 0) - c) } catch (_) { /* haul best-effort */ }
          } catch (_) { /* next kind */ }
        }
      } finally {
        if (ctx.deliver === f) f.tossInFlight = false
      }
      if (got.length === 0) {
        say(bot, `could not toss ${Object.keys(live.items)[0] || 'haul'}`)
        ctx.deliver = null
        clearGoal(bot, ctx)
        ctx.stepStatus = 'failed:toss'
        return
      }
      say(bot, `brought ${got.join(', ')}`)
      ctx.deliver = null
      clearGoal(bot, ctx)
      ctx.stepStatus = 'done'
    })()
    return
  }

  // Online but unseen: 3a7 — say where, wait at home/spawn, keep the haul.
  const wait = homeOrSpawn(bot, ctx)
  if (wait) {
    const key = `deliver-wait:${Math.round(wait.x)},${Math.round(wait.z)}`
    if (key !== ctx.lastGoalKey) {
      const gy = wait.y === null || wait.y === undefined ? bp.y : wait.y
      bot.pathfinder.setGoal(new goals.GoalNear(wait.x, gy, wait.z, 2), false)
      ctx.lastGoalKey = key
    }
  }
  if (!f.saidWaiting) {
    f.saidWaiting = true
    const what = Object.keys(live.items).map((n) => `${live.items[n]} ${n}`).join(', ')
    say(bot, `I can't see you — I'm at ${atPos(bot)} with your ${what}; come closer`)
  }
}

module.exports = deliver
module.exports.addHaul = addHaul
module.exports.haulLive = haulLive
module.exports.haulTotal = haulTotal
module.exports.playerStatus = playerStatus
