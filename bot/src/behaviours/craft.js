'use strict'

const { goals } = require('mineflayer-pathfinder')
const { countItems } = require('../perception')

// craft: logs -> planks -> crafting table -> door, one op per tick, async
// with ctx.craftInFlight (same shape as eatInFlight). Registered in
// BEHAVIOURS under 'craft' so the goal arbiter can pick it. Reports via
// ctx.stepStatus. Uses the built-in bot.recipesFor/bot.craft (2x2 grid
// without a table, 3x3 at a placed table block).
// Priority matches feasible(craft) in goal.js exactly: logs>0 crafts even
// a single log (planks are never wasted — the budget needs them all);
// table only when missing everywhere; door only at a placed table.
// A placed table appears only via ctx.home.table (the build step places
// it): a table sitting in the inventory does not unlock the door.
const TABLE_REACH = 4

function tally(bot, suffix) {
  const m = new Map()
  let items = []
  try { items = (bot.inventory && typeof bot.inventory.items === 'function' && bot.inventory.items()) || [] } catch (_) { return m }
  for (const i of items) {
    if (!i || typeof i.name !== 'string' || !i.name.endsWith(suffix)) continue
    const wood = i.name.slice(0, -suffix.length)
    m.set(wood, (m.get(wood) || 0) + (typeof i.count === 'number' ? i.count : 1))
  }
  return m
}

function topWood(m) {
  let best = null
  for (const [wood, n] of m) {
    if (!best || n > best[1] || (n === best[1] && wood < best[0])) best = [wood, n]
  }
  return best
}

function itemId(bot, name) {
  const entry = bot.registry && bot.registry.itemsByName && bot.registry.itemsByName[name]
  return entry && typeof entry.id === 'number' ? entry.id : null
}

function recipes(bot, name, table) {
  const id = itemId(bot, name)
  if (id == null || typeof bot.recipesFor !== 'function') return []
  try {
    return bot.recipesFor(id, null, 1, table || null) || []
  } catch (_) {
    return []
  }
}

function dist3(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)
}

function totals(bot) {
  return { logs: countItems(bot, (n) => n.endsWith('_log')), planks: countItems(bot, (n) => n.endsWith('_planks')) }
}

function fail(ctx, item, err) {
  ctx.stepStatus = `failed:craft-${item}`
  try {
    console.error(`craft failed item=${item} error=${err && err.message ? err.message : err}`)
  } catch (_) { /* logging best-effort */ }
}

function craft(bot, ctx, target, state) {
  if (ctx.craftInFlight) return // exactly one op at a time (mutation: a craft every tick overlaps windows)
  const bp = bot.entity && bot.entity.position
  if (!bp) return
  const logs = tally(bot, '_log')
  const planks = tally(bot, '_planks')
  const tablePos = ctx.home && ctx.home.table
  let op = null
  const top = topWood(logs)
  if (top) {
    const name = `${top[0]}_planks`
    const found = recipes(bot, name, null)
    if (found.length > 0) op = { item: name, recipe: found[0], count: top[1], table: null }
  }
  if (!op) {
    const tableCount = countItems(bot, (n) => n === 'crafting_table')
    if (tableCount === 0 && !tablePos) {
      const topPlanks = topWood(planks)
      if (topPlanks && topPlanks[1] >= 4) {
        const found = recipes(bot, 'crafting_table', null)
        if (found.length > 0) op = { item: 'crafting_table', recipe: found[0], count: 1, table: null }
      }
    }
  }
  if (!op) {
    const doorCount = countItems(bot, (n) => n.endsWith('_door'))
    if (doorCount === 0 && tablePos) {
      let block = null
      try { block = bot.blockAt && bot.blockAt(tablePos) } catch (_) { block = null }
      if (block && dist3(bp, tablePos) <= TABLE_REACH) {
        const topPlanks = topWood(planks)
        if (topPlanks && topPlanks[1] >= 6) {
          const name = `${topPlanks[0]}_door`
          const found = recipes(bot, name, block)
          if (found.length > 0) op = { item: name, recipe: found[0], count: 1, table: block }
        }
      } else {
        const key = `craft-table:${tablePos.x},${tablePos.y},${tablePos.z}`
        if (key !== ctx.lastGoalKey) {
          bot.pathfinder.setGoal(new goals.GoalNear(tablePos.x, tablePos.y, tablePos.z, 3), false)
          ctx.lastGoalKey = key
        }
        return // walk into reach, then craft on a later tick
      }
    }
  }
  if (!op) {
    ctx.stepStatus = 'done'
    return
  }
  if (typeof bot.craft !== 'function') {
    fail(ctx, op.item, new Error('bot.craft missing'))
    return
  }
  ctx.craftInFlight = true
  const run = async () => {
    try {
      await bot.craft(op.recipe, op.count, op.table)
    } catch (err) {
      ctx.craftInFlight = false
      fail(ctx, op.item, err)
      return
    }
    ctx.craftInFlight = false
    const t = totals(bot)
    try { bot.chat(`crafted ${op.count} ${op.item} (planks ${t.planks}, logs ${t.logs})`) } catch (_) { /* chat best-effort */ }
  }
  void run()
}

module.exports = craft
