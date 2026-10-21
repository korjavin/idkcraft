'use strict'

// bank: deposit carried castle kinds into the castle chest (idkcraft-qxql.12).
// The chooser (qxql.10) can pick listed steps only; nothing put gathered
// material INTO the castle chest, so an LLM that decides to stock the
// castle could never bank it. This step walks to the castle chest and
// deposits the castle kinds carried above the kit keep. It never withdraws
// (withdrawal stays forbidden) and never digs/chops — equip, gather and
// castlefetch do the sourcing, the LLM sequences them.
//
// Keeps (the pack stays playable after the deposit):
// - planks: PLANK_KEEP (packroom wood ceiling), logs: LOG_KEEP;
// - stone/stairs/torch: FETCH + reserve (castlefetch bankCap shape —
//   STONE_KEEP 88 for stone, 16 for stairs/torch).

const Vec3 = require('vec3')
const { goals } = require('mineflayer-pathfinder')
const castleFetch = require('./castlefetch')
const castleMod = require('./castle')
const { PLANK_KEEP, LOG_KEEP, withChest, INTERACT_REACH } = require('./packroom')
const { stepDone, stepFailed, stepGen } = require('../step')

const CHEST_WAITS = 30 // ticks without closing in, the castlefetch chest shape

function isPlanks(n) { return typeof n === 'string' && n.endsWith('_planks') }
function isLog(n) { return typeof n === 'string' && n.endsWith('_log') }
function isStairs(n) { return typeof n === 'string' && n.endsWith('_stairs') }

function keeps() {
  let stone = 88
  let stairs = 16
  let torch = 16
  try {
    const f = castleFetch.FETCH || {}
    stone = (f.stone || 64) + castleMod.reserveOf('stone')
    stairs = (f.stairs || 16) + castleMod.reserveOf('stairs')
    torch = (f.torch || 16) + castleMod.reserveOf('torch')
  } catch (_) { /* defaults stand */ }
  return { stone, planks: PLANK_KEEP, logs: LOG_KEEP, stairs, torch }
}

// Castle kinds carried above the kit keep, in inventory order, keep-first
// across variants (the surplusWood shape). Pure; never throws.
function surplus(bot, ctx) {
  const out = []
  const k = keeps()
  let stoneKeep = k.stone
  let planksKeep = k.planks
  let logsKeep = k.logs
  let stairsKeep = k.stairs
  let torchKeep = k.torch
  let items = null
  try { items = bot && bot.inventory && typeof bot.inventory.items === 'function' ? bot.inventory.items() : [] } catch (_) { return out }
  if (!Array.isArray(items)) return out
  const blueprint = require('../castle')
  for (const it of items) {
    if (!it || typeof it.name !== 'string') continue
    const n = typeof it.count === 'number' ? it.count : 1
    if (n <= 0) continue
    let keep = null
    try {
      if (blueprint.isStone(it.name)) keep = 'stone'
      else if (isPlanks(it.name)) keep = 'planks'
      else if (isLog(it.name)) keep = 'logs'
      else if (isStairs(it.name)) keep = 'stairs'
      else if (it.name === 'torch') keep = 'torch'
    } catch (_) { keep = null }
    if (!keep) continue
    if (keep === 'stone') {
      const k0 = Math.min(stoneKeep, n)
      stoneKeep -= k0
      if (n - k0 > 0) out.push({ name: it.name, count: n - k0 })
    } else if (keep === 'planks') {
      const k0 = Math.min(planksKeep, n)
      planksKeep -= k0
      if (n - k0 > 0) out.push({ name: it.name, count: n - k0 })
    } else if (keep === 'logs') {
      const k0 = Math.min(logsKeep, n)
      logsKeep -= k0
      if (n - k0 > 0) out.push({ name: it.name, count: n - k0 })
    } else if (keep === 'stairs') {
      const k0 = Math.min(stairsKeep, n)
      stairsKeep -= k0
      if (n - k0 > 0) out.push({ name: it.name, count: n - k0 })
    } else if (keep === 'torch') {
      const k0 = Math.min(torchKeep, n)
      torchKeep -= k0
      if (n - k0 > 0) out.push({ name: it.name, count: n - k0 })
    }
  }
  void ctx
  return out
}

// The castle chest: a chest standing on the castle site (the castlefetch
// finder). Null when unknown. Never throws.
function chestAt(bot, ctx) {
  try {
    const st = ctx && ctx.castle
    if (!st || !st.site || typeof st.site.x !== 'number') return null
    return castleFetch.castleChest(bot, st)
  } catch (_) { return null }
}

function bodyPos(bot) {
  const p = bot && bot.entity && bot.entity.position
  return p && typeof p.x === 'number' ? p : null
}

function near(bot, p, reach) {
  const bp = bodyPos(bot)
  return !!bp && Math.hypot(bp.x - (p.x + 0.5), bp.y - (p.y + 0.5), bp.z - (p.z + 0.5)) <= reach
}

function stalled(w, dist, limit) {
  if (dist < (w.best == null ? Infinity : w.best) - 1) { w.best = dist; w.waits = 0 }
  return ++w.waits > limit
}

function bank(bot, ctx) {
  const gen = stepGen(ctx)
  const done = (s) => { if (s === 'done') stepDone(ctx, gen); else stepFailed(ctx, s, gen) }
  const at = chestAt(bot, ctx)
  if (!at) { done('no-chest'); return }
  const plan = surplus(bot, ctx)
  if (plan.length === 0) { stepDone(ctx, gen); return }
  if (!near(bot, at, INTERACT_REACH)) {
    const key = `bank:${at.x},${at.y},${at.z}`
    // Re-issue when our goal is gone (the castlefetch walkTo shape: a
    // second run to the same chest with a cleared goal must walk again,
    // not stand on a stale lastGoalKey until the stall gives up).
    let ours = false
    try { ours = !!ctx.bankGoal && bot.pathfinder.goal === ctx.bankGoal } catch (_) { ours = false }
    if (ctx.lastGoalKey !== key || !ours) {
      try {
        ctx.bankGoal = new goals.GoalNear(at.x, at.y, at.z, 2)
        bot.pathfinder.setGoal(ctx.bankGoal)
      } catch (_) { /* retry next tick */ }
      ctx.lastGoalKey = key
      return
    }
    let moving = false
    try { moving = bot.pathfinder.isMoving() } catch (_) { /* treat as arrived */ }
    if (moving) return
    const bp = bodyPos(bot)
    const dd = bp ? Math.hypot(bp.x - at.x, bp.y - at.y, bp.z - at.z) : Infinity
    if (!near(bot, at, INTERACT_REACH)) {
      const w = ctx.bankWalk || (ctx.bankWalk = {})
      if (stalled(w, dd, CHEST_WAITS)) { done('walk-stall'); return }
      return
    }
  }
  if (ctx.bankInFlight) return
  ctx.bankInFlight = true
  void (async () => {
    try {
      const names = []
      let banked = 0
      const res = await withChest(bot, ctx, async (window) => {
        for (const p of surplus(bot, ctx)) {
          const entry = bot.registry && bot.registry.itemsByName && bot.registry.itemsByName[p.name]
          const type = entry && typeof entry.id === 'number' ? entry.id : null
          if (type == null) continue
          try {
            await window.deposit(type, null, p.count)
            banked += p.count
            names.push(`${p.count} ${p.name}`)
          } catch (_) { /* chest full or stack unmovable: stop at the rest */ break }
        }
        return true
      }, at)
      ctx.bankInFlight = false
      if (!res || res.status === 'gone') { done('no-chest'); return }
      if (res.status === 'unknown') {
        try { ctx.lastGoalKey = null } catch (_) { /* retry best-effort */ }
        return
      }
      if (res.status !== 'ok') { done(banked > 0 ? 'done' : 'chest-open'); return }
      if (banked <= 0) { done('chest-full'); return }
      try { console.log(`bank: deposited ${names.join(', ')} into the castle chest`) } catch (_) { /* log best-effort */ }
      done('done')
    } catch (_) {
      try { ctx.bankInFlight = false } catch (_) { /* flag best-effort */ }
      done('chest-open')
    }
  })()
}

module.exports = bank
module.exports.surplus = surplus
module.exports.chestAt = chestAt
module.exports.keeps = keeps
