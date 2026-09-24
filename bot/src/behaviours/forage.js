'use strict'

// Forage step (idkcraft-atl.2): dig the best remembered find and bank the
// haul for deliver. Reads the resource memory (explore/scout fills it),
// never searches live: the nearest valuable known cell is the target.
//
// Value rank (bead): diamonds > gold/iron > coal/lapis/copper/etc >
// logs > food animals (live fallback when memory is empty of diggables).
// Ore needs a pickaxe of the right tier (bring.js check, shared); logs
// need no tools. Batch: FORAGE_WANT new drops, then done.
//
// Shared with bring.js, not copied: dropFor/isBringable/needsPickaxe/
// hasPickaxe/findAnimal/progressed/entityById/PREY_* (pure helpers). The
// phase machine itself is forage-shaped (memory target, batch haul, no
// return leg — deliver owns that), so walk/dig/pickup run here on the
// same patterns. Like bring, forage raises NO stuck facts: a stalled leg
// forgets its cell and replans; the ticker backstops catch a looping step.

const { goals } = require('mineflayer-pathfinder')
const { Vec3 } = require('vec3')
const resources = require('../resources')
const bring = require('./bring')
const fightMod = require('./fight')
const { countItems } = require('../perception')

const FORAGE_WANT = 8 // new drops per step, then deliver
const WALK_STALL_TICKS = 10
const WALK_RANGE = 2

// Memory value rank: lower is better. Unknown ores rank with coal-tier;
// anything not ore/log ranks below logs (never picked: only ore/log/food
// plans exist).
function valueRank(name) {
  if (typeof name !== 'string') return 99
  if (/(diamond|emerald)_ore$/.test(name)) return 0
  if (/(gold|iron)_ore$/.test(name)) return 1
  if (name.endsWith('_ore')) return 2
  if (name.endsWith('_log')) return 3
  return 99
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

// Best diggable memory cell: lowest rank, then nearest. Ore without the
// right pickaxe is skipped (bring.js tier check). Pure: no movement, no
// ctx writes — goal.js feasible() shares this.
function bestMemoryCell(bot, ctx, bp) {
  const mem = ctx && ctx.resources
  if (!mem || !(mem.items instanceof Map) || mem.items.size === 0) return null
  let best = null
  let bestRank = Infinity
  let bestDist = Infinity
  for (const item of mem.items.values()) {
    if (!item || typeof item.x !== 'number') continue
    const rank = valueRank(item.name)
    if (rank > 3) continue
    if (rank <= 2 && !bring.hasPickaxe(bot, item.name)) continue
    const d = dist(bp, item)
    if (rank < bestRank || (rank === bestRank && d < bestDist)) {
      bestRank = rank
      bestDist = d
      best = item
    }
  }
  return best
}

// Step target: { kind, name, pos, drop, want }. Memory first; a passive
// animal (bring.js finder) when nothing diggable is remembered. Null =
// explore.
function planForage(bot, ctx) {
  const bp = botPos(bot)
  if (!bp) return null
  const cell = bestMemoryCell(bot, ctx, bp)
  if (cell) {
    const kind = cell.name.endsWith('_log') ? 'log' : 'ore'
    return { kind, name: cell.name, pos: { x: cell.x, y: cell.y, z: cell.z }, drop: bring.dropFor(cell.name), want: FORAGE_WANT }
  }
  let found = null
  try { found = bring.findAnimal(bot, null) } catch (_) { found = null }
  if (found) {
    const drop = bring.PREY_DROPS[found.name] || null
    if (drop) return { kind: 'food', name: found.name, id: found.id, pos: null, drop, want: FORAGE_WANT }
  }
  return null
}

function say(bot, line) {
  try { bot.chat(line) } catch (_) { /* chat best-effort, like goal.js */ }
}

function countDrop(bot, drop) {
  try {
    return countItems(bot, (n) => n === drop)
  } catch (_) {
    return 0
  }
}

function snapInventory(bot) {
  const snap = {}
  try {
    const items = bot && bot.inventory && typeof bot.inventory.items === 'function' ? bot.inventory.items() : []
    if (Array.isArray(items)) {
      for (const i of items) {
        if (i && typeof i.name === 'string') snap[i.name] = (snap[i.name] || 0) + (typeof i.count === 'number' ? i.count : 1)
      }
    }
  } catch (_) { /* empty snapshot */ }
  return snap
}

// Drop a live pathfinder goal without stop() (same latch lesson as
// explore/gather clearGoal).
function clearGoal(bot, ctx) {
  try {
    if (bot.pathfinder && bot.pathfinder.goal && typeof bot.pathfinder.setGoal === 'function') {
      bot.pathfinder.setGoal(null)
    }
  } catch (_) { /* body best-effort */ }
  ctx.lastGoalKey = ''
}

function blockAt(bot, x, y, z) {
  try {
    return bot.blockAt && bot.blockAt(new Vec3(x, y, z))
  } catch (_) {
    return null
  }
}

// Haul delta since step start for the drops we chase, merged into ctx.haul.
// done when the step banked anything, failed when it banked nothing.
function finish(bot, ctx, f, ok, reason) {
  const gains = {}
  try {
    for (const d of Object.keys(f.drops || {})) {
      const g = countDrop(bot, d) - ((f.startInv && f.startInv[d]) || 0)
      if (g > 0) gains[d] = g
    }
  } catch (_) { /* no gains */ }
  let banked = 0
  try {
    if (!ctx.haul) ctx.haul = {}
    for (const d of Object.keys(gains)) {
      ctx.haul[d] = (ctx.haul[d] || 0) + gains[d]
      banked += gains[d]
    }
  } catch (_) { /* haul best-effort */ }
  ctx.forage = null
  clearGoal(bot, ctx)
  if (banked > 0) {
    ctx.stepStatus = 'done'
    console.log(`forage done: banked ${Object.keys(gains).map((d) => `${gains[d]} ${d}`).join(', ')}${ok ? '' : ` (${reason})`}`)
  } else {
    ctx.stepStatus = `failed:${reason || 'no-known'}`
  }
}

function trackDrop(f, drop) {
  if (!f.drops) f.drops = {}
  f.drops[drop] = true
}

function replan(bot, ctx, f, bp) {
  f.target = planForage(bot, ctx)
  f.phase = null
  f.stalls = 0
  f.lastBotPos = bp ? { x: bp.x, y: bp.y, z: bp.z } : null
  f.armedId = null
  if (!f.target) {
    finish(bot, ctx, f, false, 'no-known')
    return false
  }
  f.phase = f.target.kind === 'food' ? 'find' : 'walk'
  return true
}

function forage(bot, ctx, target, state) {
  if (!ctx.forage) {
    ctx.forage = { phase: 'plan', target: null, stalls: 0, lastBotPos: null, startInv: null, drops: {}, announced: false }
  }
  const f = ctx.forage
  const bp = botPos(bot)
  if (!bp) return
  if (!f.startInv) f.startInv = snapInventory(bot)
  const grounded = !bot.entity || bot.entity.onGround !== false

  if (f.phase === 'plan') {
    if (!replan(bot, ctx, f, bp)) return
    if (!f.announced) {
      f.announced = true
      const t0 = f.target
      say(bot, t0.kind === 'food' ? `foraging: hunting ${t0.name}` : `foraging: ${t0.name} nearby`)
    }
  }

  const t = f.target
  if (!t) {
    finish(bot, ctx, f, false, 'no-known')
    return
  }
  trackDrop(f, t.drop)

  // --- food: find / walk / kill / pickup (bring.js animal phases, step-shaped) ---
  if (t.kind === 'food') {
    if (f.phase === 'find' || f.phase === 'walk') {
      const ent = (t.id != null) ? bring.entityById(bot, t.id) : null
      if (!ent) {
        const found = (() => { try { return bring.findAnimal(bot, t.drop) } catch (_) { return null } })()
        if (!found || found.name !== t.name) {
          if (!replan(bot, ctx, f, bp)) return
          return
        }
        t.id = found.id
        f.phase = 'walk'
        return
      }
      const d = dist(bp, ent.position)
      if (d !== null && d <= fightMod.SWING_RANGE) { f.phase = 'kill'; return }
      const key = `forage-hunt:${Math.round(ent.position.x)},${Math.round(ent.position.y)},${Math.round(ent.position.z)}`
      if (key !== ctx.lastGoalKey) {
        bot.pathfinder.setGoal(new goals.GoalNear(ent.position.x, ent.position.y, ent.position.z, WALK_RANGE), false)
        ctx.lastGoalKey = key
        f.stalls = 0
        f.lastBotPos = { x: bp.x, y: bp.y, z: bp.z }
        return
      }
      if (bring.progressed(bp, f.lastBotPos, grounded)) {
        f.stalls = 0
        f.lastBotPos = { x: bp.x, y: bp.y, z: bp.z }
      } else if (++f.stalls >= WALK_STALL_TICKS) {
        if (!replan(bot, ctx, f, bp)) return
      }
      return
    }
    if (f.phase === 'kill') {
      const ent = (t.id != null) ? bring.entityById(bot, t.id) : null
      if (!ent) {
        f.dropPos = f.lastPos
        f.phase = 'pickup'
        return
      }
      f.lastPos = { x: ent.position.x, y: ent.position.y, z: ent.position.z }
      const d = dist(bp, ent.position)
      if (d === null || d > fightMod.SWING_RANGE) { f.phase = 'walk'; return }
      if (f.armedId !== ent.id) {
        f.armedId = ent.id
        try { fightMod.equipGear(bot) } catch (_) { /* fists are fine */ }
      }
      try { fightMod.swing(bot, ent) } catch (_) { /* mock bots may lack attack */ }
      return
    }
    if (f.phase === 'pickup') {
      const dp = f.dropPos
      if (!dp) { f.phase = 'find'; return }
      const key = `forage-food-pickup:${Math.round(dp.x)},${Math.round(dp.y)},${Math.round(dp.z)}`
      if (key !== ctx.lastGoalKey) {
        bot.pathfinder.setGoal(new goals.GoalNear(dp.x, dp.y, dp.z, 1), false)
        ctx.lastGoalKey = key
        f.stalls = 0
        f.lastBotPos = { x: bp.x, y: bp.y, z: bp.z }
        return
      }
      const d = dist(bp, dp)
      if (d === null || d > 2) {
        if (bring.progressed(bp, f.lastBotPos, grounded)) {
          f.stalls = 0
          f.lastBotPos = { x: bp.x, y: bp.y, z: bp.z }
        } else if (++f.stalls >= WALK_STALL_TICKS) {
          if (!replan(bot, ctx, f, bp)) return
        }
        return
      }
      const have = Math.max(0, countDrop(bot, t.drop) - ((f.startInv && f.startInv[t.drop]) || 0))
      if (have >= t.want) {
        finish(bot, ctx, f, true)
      } else {
        t.id = null
        f.phase = 'find'
      }
      return
    }
    if (!replan(bot, ctx, f, bp)) return
    return
  }

  // --- ore/log: walk (bring-style: issue returns, settle digs) ---
  if (f.phase === 'walk') {
    const p = t.pos
    const key = `forage:${Math.round(p.x)},${Math.round(p.y)},${Math.round(p.z)}`
    if (key !== ctx.lastGoalKey) {
      bot.pathfinder.setGoal(new goals.GoalNear(p.x, p.y, p.z, WALK_RANGE), false)
      ctx.lastGoalKey = key
      f.stalls = 0
      f.lastBotPos = { x: bp.x, y: bp.y, z: bp.z }
      return
    }
    let block = null
    try { block = blockAt(bot, p.x, p.y, p.z) } catch (_) { block = null }
    if (!block || block.name !== t.name) {
      try { resources.forget(ctx, p.x, p.y, p.z) } catch (_) { /* memory best-effort */ }
      if (!replan(bot, ctx, f, bp)) return
      return
    }
    if (!bot.pathfinder.isMoving()) {
      let diggable = true
      try { diggable = typeof bot.canDigBlock === 'function' ? bot.canDigBlock(block) : true } catch (_) { diggable = false }
      if (diggable) f.phase = 'dig'
      return
    }
    if (bring.progressed(bp, f.lastBotPos, grounded)) {
      f.stalls = 0
      f.lastBotPos = { x: bp.x, y: bp.y, z: bp.z }
    } else if (++f.stalls >= WALK_STALL_TICKS) {
      try { resources.forget(ctx, p.x, p.y, p.z) } catch (_) { /* memory best-effort */ }
      if (!replan(bot, ctx, f, bp)) return
    }
    return
  }

  if (f.phase === 'dig') {
    if (ctx.digInFlight) return
    if (typeof bot.dig !== 'function') {
      try { resources.forget(ctx, t.pos.x, t.pos.y, t.pos.z) } catch (_) { /* memory best-effort */ }
      if (!replan(bot, ctx, f, bp)) return
      return
    }
    let block = null
    try { block = blockAt(bot, t.pos.x, t.pos.y, t.pos.z) } catch (_) { block = null }
    if (!block || block.name !== t.name) {
      try { resources.forget(ctx, t.pos.x, t.pos.y, t.pos.z) } catch (_) { /* memory best-effort */ }
      if (!replan(bot, ctx, f, bp)) return
      return
    }
    ctx.digInFlight = true
    void (async () => {
      try {
        let tool = null
        try { tool = bot.pathfinder && typeof bot.pathfinder.bestHarvestTool === 'function' ? bot.pathfinder.bestHarvestTool(block) : null } catch (_) { tool = null }
        if (tool && typeof bot.equip === 'function') await bot.equip(tool, 'hand')
        await bot.dig(block)
      } catch (_) { /* gone or interrupted: pickup anyway */ }
      ctx.digInFlight = false
      if (ctx.forage === f) f.phase = 'pickup'
    })()
    return
  }

  if (f.phase === 'pickup') {
    const p = t.pos
    const key = `forage-pickup:${Math.round(p.x)},${Math.round(p.y)},${Math.round(p.z)}`
    if (key !== ctx.lastGoalKey) {
      bot.pathfinder.setGoal(new goals.GoalBlock(p.x, p.y, p.z), false)
      ctx.lastGoalKey = key
      return
    }
    try { resources.forget(ctx, p.x, p.y, p.z) } catch (_) { /* dug: drop the cell */ }
    const have = Math.max(0, countDrop(bot, t.drop) - ((f.startInv && f.startInv[t.drop]) || 0))
    if (have >= t.want) {
      finish(bot, ctx, f, true)
    } else {
      f.phase = 'plan'
    }
    return
  }

  if (!replan(bot, ctx, f, bp)) return
}

module.exports = forage
module.exports.planForage = planForage
module.exports.FORAGE_WANT = FORAGE_WANT
