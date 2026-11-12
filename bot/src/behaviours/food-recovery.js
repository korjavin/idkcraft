'use strict'

// Survival acquisition has its own state: a material forage failure and its
// cooldown must survive this leg. Window flights also outlive cancellation.
const bring = require('./bring')
const forage = require('./forage')
const stockpile = require('./stockpile')
const { stepDone } = require('../step')
const { LOW_HP_GATE_MS, lowHpGated } = require('../health-gate')
const craftany = require('./craftany')

const RETRY_MS = 60000
const WINDOW_TIMEOUT_MS = 30000
const BREAD_TIMEOUT_MS = 120000 // walk + table make/place + craft, then the RETRY_MS cooldown
// Chest loop: a healthy but hungry body with no meal also draws from a chest
// whose read holds food, or one never/long ago read (stockpile.chestHope).
const HUNGRY_FOOD = 14
const HUNGRY_WANT = 4 // bounded draw: a few meals, the rest stays for others

const isEdible = (n) => require('../reflexes').EDIBLE_FOODS.has(n)

function noMeal(bot) {
  try { const items = bot.inventory.items(); return Array.isArray(items) && !require('../reflexes').pickEdible(items) } catch (_) { return false }
}

function hungry(bot, ctx, facts) {
  if (!bot || !facts || process.env.BOT_BODY !== 'baritone' || facts.time !== 'day' || !(bot.food < HUNGRY_FOOD) || facts.health < 6) return false
  if (ctx && (ctx.llmOrder || ctx.taskPlanArgs)) return false
  return noMeal(bot) && !!bring.pickChest(bot, ctx, chestState(ctx, HUNGRY_WANT))
}

function needed(bot, ctx, facts) {
  if (hungry(bot, ctx, facts)) return true
  if (!bot || !facts || process.env.BOT_BODY !== 'baritone' || facts.time !== 'day' || !(bot.food < 18) || !(facts.health < 6)) return false
  let items
  try {
    items = bot.inventory.items()
    if (!Array.isArray(items)) throw new Error('inventory unavailable')
  } catch (_) {
    if (ctx && (!ctx.foodInventoryLogAt || Date.now() - ctx.foodInventoryLogAt >= 60000)) {
      ctx.foodInventoryLogAt = Date.now()
      console.log(`food recovery inventory=unknown health=${bot.health} food=${bot.food}`)
    }
    return false
  }
  try {
    return !(ctx && (ctx.llmOrder || ctx.taskPlanArgs)) &&
      require('../vetoes').castleFirst(ctx) &&
      lowHpGated(bot, facts, ctx) &&
      !require('../reflexes').pickEdible(items)
  } catch (_) { return false }
}

function chestState(ctx, want = 1) {
  if (!Array.isArray(ctx.foodRecoveryChestSeen)) ctx.foodRecoveryChestSeen = []
  return { kind: 'food', phase: 'chestfetch', want, wants: isEdible, have: 0, drop: null, chestSeen: ctx.foodRecoveryChestSeen, maxChestDistance: stockpile.NEARBY_CHEST_RADIUS }
}

function countOf(bot, name) {
  try { return bot.inventory.items().reduce((n, i) => n + (i && i.name === name ? i.count || 0 : 0), 0) } catch (_) { return 0 }
}
const wheatCount = (bot) => countOf(bot, 'wheat')

function hasTable(bot, ctx) {
  try { return !!craftany.standingTable(bot, ctx) } catch (_) { return false }
}

// idkcraft-qxql33(b): pack wheat -> bread at a known table, or at one craftany
// makes/places (tableFor: castle cell, placement guards) from carried wood.
// craftany's own planner is the gate, so offer and execution agree. A failed
// bread leg pauses only bread (foodBreadRetryAt), not chest/forage.
function breadReady(bot, ctx) {
  if (wheatCount(bot) < 3 || (ctx && ctx.foodBreadRetryAt && Date.now() < ctx.foodBreadRetryAt)) return false
  try { return !!craftany.planCraft(bot, ctx, ['bread'], 1).ok } catch (_) { return false }
}

function available(bot, ctx, facts) {
  if (!needed(bot, ctx, facts) || (ctx.foodRecoveryRetryAt && Date.now() < ctx.foodRecoveryRetryAt)) return false
  if (ctx.foodRecoveryFlight) return false
  if (breadReady(bot, ctx)) return true
  const other = !!(bring.pickChest(bot, ctx, chestState(ctx)) || forage.foodTarget(bot, ctx, true))
  const wheat = wheatCount(bot)
  if (!other && wheat >= 3 && !(ctx.foodBreadRetryAt && Date.now() < ctx.foodBreadRetryAt) && (!ctx.foodBreadLogAt || Date.now() - ctx.foodBreadLogAt >= 60000)) {
    ctx.foodBreadLogAt = Date.now()
    console.log(`food recovery source=bread table=none why=no-table-no-wood wheat=${wheat}`)
  }
  return other
}

function invalidate(ctx) {
  if (ctx && ctx.foodRecovery) cancel(ctx, ctx.foodRecovery)
}

// A cancelled bread run must not leave its craftany run for the next start.
function cancel(ctx, r) {
  r.valid = false
  if (r.bread && ctx.craftany && ctx.craftany.key === 'breadx1') ctx.craftany = null
}

function run(bot, ctx) {
  let r = ctx.foodRecovery
  if (!r || !r.valid) {
    const hungryRun = !(bot.health < 6)
    r = ctx.foodRecovery = { valid: true, hungry: hungryRun, chest: chestState(ctx, hungryRun ? HUNGRY_WANT : 1), phase: breadReady(bot, ctx) ? 'bread' : 'chest', startFood: bot.food }
    ctx.lastPathStatus = 'none'
    console.log(`food recovery start health=${bot.health} food=${bot.food} edible=0${hungryRun ? ' why=hungry' : ''}`)
  }
  const valid = () => r.valid && ctx.foodRecovery === r && ctx.step === 'foodRecovery' &&
    ctx.work !== false && !ctx.paused && !ctx.bring && !ctx.lead && !ctx.followName && !(ctx.flat && !ctx.flat.parked) &&
    bot.food < 18 && (r.hungry || bot.health < 6) &&
    !(!r.hungry && typeof ctx.lowHpGateSince === 'number' && Date.now() - ctx.lowHpGateSince > LOW_HP_GATE_MS)
  const done = (retry) => {
    if (!valid()) return
    r.valid = false
    if (retry) ctx.foodRecoveryRetryAt = Date.now() + RETRY_MS
    console.log(`food recovery result=${retry ? 'retry' : 'acquired'} health=${bot.health} food=${bot.food}`)
    stepDone(ctx)
  }
  if (!valid()) { cancel(ctx, r); return }
  if (bot.food > r.startFood) { done(false); return }
  const bp = bot.entity && bot.entity.position
  if (!bp) return
  if (r.phase === 'bread') {
    if (!r.bread) {
      r.bread = { wheat0: wheatCount(bot), bread0: countOf(bot, 'bread'), table: hasTable(bot, ctx) ? 'reached' : 'placed', at: Date.now() }
      ctx.craftany = null
      console.log(`food recovery source=bread start wheat=${r.bread.wheat0}`)
    }
    // Success is bread in the pack (the craft may spend the last 3 wheat).
    // craftany bounds the table walk/make/place itself; the deadline caps the leg.
    const crafted = countOf(bot, 'bread') > r.bread.bread0
    const res = crafted ? { done: true }
      : Date.now() - r.bread.at > BREAD_TIMEOUT_MS && !ctx.gearInFlight ? { done: false, line: 'timeout' }
        : craftany(bot, ctx, 'bread', 1)
    if (res === 'running') return
    ctx.craftany = null
    if (crafted || countOf(bot, 'bread') > r.bread.bread0 || (res && res.done)) {
      console.log(`food recovery source=bread table=${r.bread.table} why=crafted wheat=${wheatCount(bot)}`)
      done(false) // bread is edible now: the eat reflex eats it, needed() goes false
      return
    }
    console.log(`food recovery source=bread table=none why=${JSON.stringify((res && res.line) || 'unknown')} wheat=${wheatCount(bot)}`)
    ctx.foodBreadRetryAt = Date.now() + LOW_HP_GATE_MS // the rest of the low-HP episode
    r.phase = 'chest'; ctx.lastGoalKey = '' // same episode: chest, then hunt
    return
  }
  if (r.phase === 'chest') {
    if (ctx.foodRecoveryFlight) {
      if (ctx.foodRecoveryFlight.owner === r && Date.now() - ctx.foodRecoveryFlight.at >= WINDOW_TIMEOUT_MS) {
        r.valid = false
        ctx.foodRecoveryRetryAt = Date.now() + RETRY_MS
        stepDone(ctx)
      }
      return
    }
    if (r.chest.phase === 'return') { done(false); return }
    if (r.chest.phase === 'find' && r.hungry) { done(true); return } // shortcut: hungry runs are chest-only; hunting stays low-HP
    if (r.chest.phase === 'find') { r.phase = 'hunt'; ctx.lastGoalKey = ''; return }
    const flight = { owner: r, at: Date.now() }
    ctx.foodRecoveryFlight = flight
    bring.chestFetch(bot, ctx, r.chest, bp, valid, () => {
      if (ctx.foodRecoveryFlight === flight) ctx.foodRecoveryFlight = null
    })
    if (!r.chest.chestInFlight && ctx.foodRecoveryFlight === flight) ctx.foodRecoveryFlight = null
    return
  }
  if (!r.hunt) {
    const target = forage.foodTarget(bot, ctx, true)
    if (!target) { done(true); return }
    console.log(`food recovery hunt=${target.name}`)
    target.want = 1
    r.hunt = { target, phase: 'find', startInv: {}, stalls: 0, foodStreak: 0 }
  }
  const h = r.hunt
  const replanTarget = () => {
    const target = forage.foodTarget(bot, ctx, true)
    if (!target) { done(true); return false }
    target.want = 1
    h.target = target; h.phase = 'find'; h.stalls = 0
    return true
  }
  const stall = () => {
    h.foodStreak++
    if (h.foodStreak >= 3) { done(true); return false }
    return replanTarget()
  }
  forage.huntTick(bot, ctx, h, bp, !bot.entity || bot.entity.onGround !== false, {
    replanTarget, stall, finishTarget: () => done(false),
  })
}

module.exports = { run, needed, available, invalidate, RETRY_MS, HUNGRY_FOOD, HUNGRY_WANT }
