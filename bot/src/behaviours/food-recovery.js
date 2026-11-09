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

function needed(bot, ctx, facts) {
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

function chestState(ctx) {
  if (!Array.isArray(ctx.foodRecoveryChestSeen)) ctx.foodRecoveryChestSeen = []
  return { kind: 'food', phase: 'chestfetch', want: 1, have: 0, drop: null, chestSeen: ctx.foodRecoveryChestSeen, maxChestDistance: stockpile.NEARBY_CHEST_RADIUS }
}

function wheatCount(bot) {
  try { return bot.inventory.items().reduce((n, i) => n + (i && i.name === 'wheat' ? i.count || 0 : 0), 0) } catch (_) { return 0 }
}

// idkcraft-qxql33: pack wheat -> bread only at a standing known table, so the
// craft consumes nothing but wheat (craftany never has to make a table).
function breadReady(bot, ctx) {
  if (wheatCount(bot) < 3) return false
  try { return !!craftany.standingTable(bot, ctx) } catch (_) { return false }
}

function available(bot, ctx, facts) {
  if (!needed(bot, ctx, facts) || (ctx.foodRecoveryRetryAt && Date.now() < ctx.foodRecoveryRetryAt)) return false
  if (ctx.foodRecoveryFlight) return false
  if (breadReady(bot, ctx)) return true
  const other = !!(bring.pickChest(bot, ctx, chestState(ctx)) || forage.foodTarget(bot, ctx, true))
  const wheat = wheatCount(bot)
  if (!other && wheat >= 3 && (!ctx.foodBreadLogAt || Date.now() - ctx.foodBreadLogAt >= 60000)) {
    ctx.foodBreadLogAt = Date.now()
    console.log(`food recovery source=bread result=no-table wheat=${wheat}`)
  }
  return other
}

function invalidate(ctx) {
  if (ctx && ctx.foodRecovery) ctx.foodRecovery.valid = false
}

function run(bot, ctx) {
  let r = ctx.foodRecovery
  if (!r || !r.valid) {
    r = ctx.foodRecovery = { valid: true, chest: chestState(ctx), phase: breadReady(bot, ctx) ? 'bread' : 'chest', startFood: bot.food }
    ctx.lastPathStatus = 'none'
    console.log(`food recovery start health=${bot.health} food=${bot.food} edible=0`)
  }
  const valid = () => r.valid && ctx.foodRecovery === r && ctx.step === 'foodRecovery' &&
    ctx.work !== false && !ctx.paused && !ctx.bring && !ctx.lead && !ctx.followName && !(ctx.flat && !ctx.flat.parked) &&
    bot.health < 6 && bot.food < 18 &&
    !(typeof ctx.lowHpGateSince === 'number' && Date.now() - ctx.lowHpGateSince > LOW_HP_GATE_MS)
  const done = (retry) => {
    if (!valid()) return
    r.valid = false
    if (retry) ctx.foodRecoveryRetryAt = Date.now() + RETRY_MS
    console.log(`food recovery result=${retry ? 'retry' : 'acquired'} health=${bot.health} food=${bot.food}`)
    stepDone(ctx)
  }
  if (!valid()) { r.valid = false; return }
  if (bot.food > r.startFood) { done(false); return }
  const bp = bot.entity && bot.entity.position
  if (!bp) return
  if (r.phase === 'bread') {
    if (!r.bread) {
      r.bread = { wheat0: wheatCount(bot) }
      ctx.craftany = null
      console.log(`food recovery source=bread start wheat=${r.bread.wheat0}`)
    }
    // The table must still stand each tick, else craftany would make one.
    const res = breadReady(bot, ctx) || ctx.gearInFlight ? craftany(bot, ctx, 'bread', 1) : { done: false, line: 'need a crafting table' }
    if (res === 'running') return
    ctx.craftany = null
    if (res && res.done) {
      console.log(`food recovery source=bread result=crafted wheat=${wheatCount(bot)}`)
      done(false) // bread is edible now: the eat reflex eats it, needed() goes false
      return
    }
    console.log(`food recovery source=bread result=failed why=${JSON.stringify((res && res.line) || 'unknown')} wheat=${wheatCount(bot)}`)
    done(true)
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

module.exports = { run, needed, available, invalidate, RETRY_MS }
