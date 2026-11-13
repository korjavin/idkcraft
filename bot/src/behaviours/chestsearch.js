'use strict'

// Chest search (owner 2026-11-12): a hungry v2 body with no meal and no chest
// worth opening walks a bounded leg to find chests it has not seen yet. The
// legs reuse explore's spiral (nextTarget, the shared visited set) under a
// RADIUS cap from the anchor; the leg ends after BUDGET_MS, when the spiral
// is out, or once a chest with hope (stockpile.chestHope) is within the
// food leg's reach — then foodRecovery's pickChest opens it. A fruitless
// end (timeout/explored) arms a COOLDOWN_MS hold: never an endless tour.
// Source ladder (src/source-ladder.js): this is the far rung — it runs only
// once foodRecovery (pack bread, near chest, hunt) has nothing to serve.
const { goals } = require('mineflayer-pathfinder')
const stockpile = require('./stockpile')
const explore = require('./explore')
const bring = require('./bring')
const { clearGoal, issueGoal } = require('./util')
const { resolveIds } = require('../blockids')
const { stepDone, stepFailed } = require('../step')

const RADIUS = 128 // feet from the explore anchor (castle/home/spawn)
const BUDGET_MS = 3 * 60 * 1000
const COOLDOWN_MS = 10 * 60 * 1000
const { hungryNoMeal, CHEST_WIDE_RADIUS: WIDE_RADIUS } = require('./scout')
const WIDE_COUNT = 32
const FOOD_REACH = 64 // mirrors food-recovery HUNGRY_CHEST_RADIUS (starving: 256)
const REACH = FOOD_REACH - 4 // a found chest lies inside foodRecovery's pickChest bound
const ARRIVE = 4
const STALL_TICKS = 10
const CONTAINERS = ['chest', 'trapped_chest', 'barrel']

const isEdible = (n) => require('../reflexes').EDIBLE_FOODS.has(n)
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)

// Remember every container block within r over loaded chunks; returns the count seen.
function scanWide(bot, ctx, r = WIDE_RADIUS) {
  try {
    const ids = resolveIds(bot, CONTAINERS)
    if (!ids || ids.length === 0) return 0
    const seen = bot.findBlocks({ matching: ids, maxDistance: r, count: WIDE_COUNT }) || []
    if (seen.length > 0) stockpile.rememberChests(ctx, seen)
    return seen.length
  } catch (_) { return 0 }
}

// A chest with hope for food within r of the bot (fresh chestSeen: a hope>0 chest is worth a visit).
function foodChest(bot, ctx, r) {
  return bring.pickChest(bot, ctx, { wants: isEdible, chestSeen: [], maxChestDistance: r })
}

// foodRecovery's chest reach for this body (food-recovery chestState).
function foodReach(bot) {
  try { return require('../reflexes').starving(bot) ? 256 : FOOD_REACH } catch (_) { return FOOD_REACH }
}

function available(bot, ctx, facts) {
  if (!bot || !ctx || !facts || facts.time !== 'day') return false // any health: foodRecovery (above in decide) owns a hunt/bread/known chest
  if (ctx.llmOrder || ctx.taskPlanArgs || ctx.bring || ctx.lead || ctx.followName) return false
  if (ctx.chestSearchRetryAt && Date.now() < ctx.chestSearchRetryAt) return false
  if (!hungryNoMeal(bot)) return false
  scanWide(bot, ctx)
  return !foodChest(bot, ctx, foodReach(bot))
}

function finish(bot, ctx, s, ok, why) {
  clearGoal(bot, ctx)
  ctx.chestSearch = null
  // fruitless: the last leg's spot is not re-toured after the cooldown
  if (!ok && s.target) {
    try { ctx.explore.visited.add(`${Math.floor(s.target.x / 16)},${Math.floor(s.target.z / 16)}`) } catch (_) { /* best-effort */ }
  }
  // found: no cooldown — a chest whose walk/open then fails gets failAt (bring), hope 0, so a new search may start
  if (!ok) ctx.chestSearchRetryAt = Date.now() + COOLDOWN_MS
  const found = (Array.isArray(ctx.chests) ? ctx.chests.length : 0) - s.known0
  console.log(`chest search result found=${found} why=${why}`)
  if (ok) stepDone(ctx)
  else stepFailed(ctx, why)
}

function run(bot, ctx) {
  const bp = bot.entity && bot.entity.position
  if (!bp) return
  let s = ctx.chestSearch
  if (!s) {
    s = ctx.chestSearch = { at: Date.now(), known0: Array.isArray(ctx.chests) ? ctx.chests.length : 0, target: null, key: null, last: null, stalls: 0 }
    console.log(`chest search start need=food food=${bot.food} radius=${RADIUS} budgetS=${BUDGET_MS / 1000}`)
  }
  if (Date.now() - s.at > BUDGET_MS) return finish(bot, ctx, s, false, 'timeout')
  scanWide(bot, ctx)
  const c = foodChest(bot, ctx, WIDE_RADIUS)
  if (c && dist(bp, c.pos) <= REACH) return finish(bot, ctx, s, true, 'chest')
  if (!ctx.explore) ctx.explore = { visited: new Set(), target: null }
  if (!(ctx.explore.visited instanceof Set)) ctx.explore.visited = new Set()
  const visited = ctx.explore.visited
  let t = c ? c.pos : s.target
  if (!t || (!c && Math.hypot(bp.x - t.x, bp.z - t.z) <= ARRIVE)) {
    if (t && !c) visited.add(`${Math.floor(t.x / 16)},${Math.floor(t.z / 16)}`)
    t = s.target = explore.nextTarget(bot, ctx, RADIUS)
    if (t) ctx.explore.target = null // own pick: explore's pending leg is not ours to consume
  }
  if (!t) return finish(bot, ctx, s, false, 'explored')
  const cell = `${Math.floor(bp.x)},${Math.floor(bp.y)},${Math.floor(bp.z)}` // block cell: jitter is not progress
  if (s.last === cell) s.stalls++
  else s.stalls = 0
  s.last = cell
  if (s.stalls >= STALL_TICKS) {
    visited.add(`${Math.floor(t.x / 16)},${Math.floor(t.z / 16)}`)
    if (c) stockpile.markChestFailed(ctx, c.pos)
    s.target = null
    s.stalls = 0
    return
  }
  const key = `chestsearch:${t.x},${t.z}`
  if (ctx.lastGoalKey !== key) {
    try { issueGoal(bot, ctx, c ? new goals.GoalNear(t.x, t.y, t.z, 3) : new goals.GoalXZ(t.x, t.z), key, false) } catch (_) { /* body best-effort */ }
  }
}

module.exports = run
module.exports.run = run
module.exports.available = available
module.exports.scanWide = scanWide
module.exports.RADIUS = RADIUS
module.exports.BUDGET_MS = BUDGET_MS
module.exports.COOLDOWN_MS = COOLDOWN_MS
module.exports.WIDE_RADIUS = WIDE_RADIUS
