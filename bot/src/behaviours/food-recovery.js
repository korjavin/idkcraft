'use strict'

// Survival acquisition has its own state: a material forage failure and its
// cooldown must survive this leg. Window flights also outlive cancellation.
const bring = require('./bring')
const forage = require('./forage')
const { stepDone } = require('../step')
const { LOW_HP_GATE_MS, lowHpNoFood, needsFood } = require('../health-gate')
const craftany = require('./craftany')
const { Vec3 } = require('vec3')

const RETRY_MS = 60000
const WINDOW_TIMEOUT_MS = 30000
const BREAD_TIMEOUT_MS = 120000 // walk + table make/place + craft, then the RETRY_MS cooldown
// Chest loop: a healthy but hungry body with no meal also draws from a chest
// whose read holds food, or one never/long ago read (stockpile.chestHope).
// prod 2026-11-19: every death in the hour was in foodRecovery — food sat at
// 9-16 with an empty pack, so health never regenerated (needs food >= 18) and
// the fetch began only once fights had already worn it down. Fetch at the
// regen line, while healthy, and carry a reserve.
const HUNGRY_FOOD = 18
const HUNGRY_WANT = 8 // bounded draw: a reserve, the rest stays for others
// Owner 2026-11-12: food anywhere, castle or not. Remembered chests up to the
// explore spiral cap when critical (food<=2 or health<6), else a shorter walk;
// failAt TTL (markChestFailed) bounds the retries.
const FOOD_CHEST_RADIUS = 256 // = explore MAX_RADIUS
const HUNGRY_CHEST_RADIUS = 64

// Night is shelter time, except a starving body (health<6 or food 0) eats first.
const foodTime = (bot, facts) => facts.time === 'day' || facts.health < 6 || bot.food === 0

const isEdible = (n) => require('../reflexes').EDIBLE_FOODS.has(n)
// Rotten flesh: a chest target only when starving and no chest hopes for real food;
// an opened chest with no real food gives it up whenever starving (drawWants).
const orRotten = (n) => isEdible(n) || n === require('../reflexes').LAST_RESORT
// Wheat feeds the bread rung: wanted from chests until the pack holds one loaf's worth.
const withWheat = (bot, f) => (n) => f(n) || (n === 'wheat' && wheatCount(bot) < 3)
// All known chests read dry of food: skip the chest rung this long (= a chest
// snapshot's freshness) and produce food instead (hunt, harvest, bread).
const DRY_MS = require('../cheststock').REMEMBERED_DRY_MS
const chestsDry = (ctx) => !!(ctx && ctx.foodChestDryUntil && Date.now() < ctx.foodChestDryUntil)
const HARVEST_CAP = 8
const HARVEST_WALK_TICKS = 40
const ripeCrop = (bot, ctx) => { try { return require('./farm').ripeCrop(bot, ctx) } catch (_) { return null } }
const source = (kind, result, extra = '') => console.log(`food source=${kind} result=${result}${extra}`)

function noMeal(bot, ctx) {
  try { const items = bot.inventory.items(); return Array.isArray(items) && !require('../reflexes').mealFor(bot, ctx || {}, items) } catch (_) { return false }
}

function hungry(bot, ctx, facts) {
  if (!bot || !facts || process.env.BOT_BODY !== 'baritone' || !foodTime(bot, facts) || !(bot.food < HUNGRY_FOOD) || facts.health < 6) return false
  if (ctx && (ctx.llmOrder || ctx.taskPlanArgs)) return false
  // Source ladder (src/source-ladder.js): pack bread, a near chest, then a
  // hunt; chestSearch (the long-trip rung) only once none of these serves.
  return noMeal(bot, ctx) && !!(breadReady(bot, ctx) || (!chestsDry(ctx) && bring.pickChest(bot, ctx, chestState(ctx, HUNGRY_WANT, bot))) || forage.foodTarget(bot, ctx, true) || ripeCrop(bot, ctx))
}

function needed(bot, ctx, facts) {
  if (hungry(bot, ctx, facts)) return true
  if (!bot || !facts || process.env.BOT_BODY !== 'baritone' || !foodTime(bot, facts) || !(bot.food < 18) || !needsFood(facts)) return false
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
      lowHpNoFood(bot, facts, false, ctx)
  } catch (_) { return false }
}

function normalFoodChest(bot, ctx) {
  return bring.pickChest(bot, ctx, { ...chestState(ctx), maxChestDistance: FOOD_CHEST_RADIUS })
}

function chestState(ctx, want = 1, bot = null) {
  if (!Array.isArray(ctx.foodRecoveryChestSeen)) ctx.foodRecoveryChestSeen = []
  const rotten = !!bot && require('../reflexes').lastResortOk(bot, ctx)
  const w = (f) => bot ? withWheat(bot, f) : f
  return { kind: 'food', phase: 'chestfetch', want, wants: w(rotten ? orRotten : isEdible), drawWants: w(bot && require('../reflexes').starving(bot) ? orRotten : isEdible), have: 0, drop: null, chestSeen: ctx.foodRecoveryChestSeen, maxChestDistance: bot && require('../reflexes').starving(bot) ? FOOD_CHEST_RADIUS : HUNGRY_CHEST_RADIUS }
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
  // ladder: near chest -> hunt (obtain) -> chestSearch, the far rung, once this holds
  const other = !!((!chestsDry(ctx) && bring.pickChest(bot, ctx, chestState(ctx, 1, bot))) || forage.foodTarget(bot, ctx, true) || ripeCrop(bot, ctx))
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

// prod 2026-11-19 bot4: the shared noPath reaction (unreachable.js) failed the
// step on an unreachable table, done() never ran, and the arbiter restarted the
// same bread leg every few ticks (55 restarts/10 min). A step failed from outside
// strikes the source it was on: bread pauses (next run takes chest/hunt at once),
// any other rung takes the RETRY_MS cooldown.
function failed(ctx) {
  const r = ctx && ctx.foodRecovery
  if (!r || !r.valid) return
  if (r.phase === 'bread') ctx.foodBreadRetryAt = Date.now() + LOW_HP_GATE_MS
  else ctx.foodRecoveryRetryAt = Date.now() + RETRY_MS
  console.log(`food recovery result=failed phase=${r.phase} status=${ctx.stepStatus}`)
  cancel(ctx, r)
}

// A cancelled bread run must not leave its craftany run for the next start.
function cancel(ctx, r) {
  r.valid = false
  if (r.bread && ctx.craftany && ctx.craftany.key === 'breadx1') ctx.craftany = null
}

function run(bot, ctx) {
  let r = ctx.foodRecovery
  if (!r || !r.valid) {
    // food<6 is an emergency like low hp: chest, then hunt (prod: Easy holds hp at 10)
    const hungryRun = !needsFood({ health: bot.health, food: bot.food })
    r = ctx.foodRecovery = { valid: true, hungry: hungryRun, chest: chestState(ctx, bot.health < 6 ? 1 : HUNGRY_WANT, bot), phase: breadReady(bot, ctx) ? 'bread' : chestsDry(ctx) ? 'hunt' : 'chest', startFood: bot.food }
    ctx.lastPathStatus = 'none'
    require('../food-rate').note(ctx, 'recoveries')
    console.log(`food recovery start health=${bot.health} food=${bot.food} edible=0${hungryRun ? ' why=hungry' : ''}`)
  }
  const valid = () => r.valid && ctx.foodRecovery === r && ctx.step === 'foodRecovery' &&
    ctx.work !== false && !ctx.paused && !ctx.bring && !ctx.lead && !ctx.followName && !(ctx.flat && !ctx.flat.parked) &&
    bot.food < 18 && (r.hungry || needsFood({ health: bot.health, food: bot.food }))
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
      source('bread', 'crafted')
      console.log(`food recovery source=bread table=${r.bread.table} why=crafted wheat=${wheatCount(bot)}`)
      done(false) // bread is edible now: the eat reflex eats it, needed() goes false
      return
    }
    console.log(`food recovery source=bread table=none why=${JSON.stringify((res && res.line) || 'unknown')} wheat=${wheatCount(bot)}`)
    ctx.foodBreadRetryAt = Date.now() + LOW_HP_GATE_MS // the rest of the low-HP episode
    source('bread', 'failed')
    r.phase = chestsDry(ctx) ? 'hunt' : 'chest'; ctx.lastGoalKey = '' // same episode: chest, then hunt
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
    // Drawn food counts once eaten (bot.food > startFood ends the run above):
    // wait for the eat reflex, bounded, instead of "acquired" with food uneaten.
    // Drawn flesh is eaten only once no remembered chest hopes for real food
    // (reflexes.lastResortOk): until then the same run tours the next chest.
    if (r.chest.phase === 'return') {
      // An eatable meal in the pack: needed() goes false with it, so no restart.
      if (!noMeal(bot, ctx)) { source('chest', 'acquired'); done(false) } else if (breadReady(bot, ctx)) { source('chest', 'wheat'); r.phase = 'bread'; r.bread = null; ctx.lastGoalKey = '' } else r.chest = chestState(ctx, r.chest.want, bot)
      return
    }
    // near chests out: the obtain rung (hunt) in the same leg, never a fail
    if (r.chest.phase === 'find') {
      ctx.foodChestDryUntil = Date.now() + DRY_MS
      source('chest', 'dry', ` retry_in=${Math.round(DRY_MS / 1000)}s`)
      r.phase = 'hunt'; ctx.lastGoalKey = ''; return
    }
    const flight = { owner: r, at: Date.now() }
    ctx.foodRecoveryFlight = flight
    bring.chestFetch(bot, ctx, r.chest, bp, valid, () => {
      if (ctx.foodRecoveryFlight === flight) ctx.foodRecoveryFlight = null
    })
    if (!r.chest.chestInFlight && ctx.foodRecoveryFlight === flight) ctx.foodRecoveryFlight = null
    return
  }
  if (r.phase === 'harvest') { harvestTick(bot, ctx, r, done); return }
  const toHarvest = () => { source('hunt', 'none'); r.phase = 'harvest'; ctx.lastGoalKey = ''; return false }
  if (!r.hunt) {
    const target = forage.foodTarget(bot, ctx, true)
    if (!target) { toHarvest(); return }
    console.log(`food recovery hunt=${target.name}`)
    target.want = 1
    r.hunt = { target, phase: 'find', startInv: {}, stalls: 0, foodStreak: 0 }
  }
  const h = r.hunt
  const replanTarget = () => {
    const target = forage.foodTarget(bot, ctx, true)
    if (!target) return toHarvest()
    target.want = 1
    h.target = target; h.phase = 'find'; h.stalls = 0
    return true
  }
  const stall = () => {
    h.foodStreak++
    if (h.foodStreak >= 3) return toHarvest()
    return replanTarget()
  }
  forage.huntTick(bot, ctx, h, bp, !bot.entity || bot.entity.onGround !== false, {
    replanTarget, stall, finishTarget: () => { source('hunt', 'acquired'); done(false) },
  })
}

// Harvest rung: dig ripe wheat/carrots nearby (the farm step replants the
// farmland). Carrots are eaten by the eat reflex (food rises: the run ends);
// 3 wheat flips the run to bread.
function harvestTick(bot, ctx, r, done) {
  const farm = require('./farm')
  if (!r.harvest) r.harvest = { f: {}, digs: 0, ticks: 0, busy: false }
  const hv = r.harvest
  if (hv.busy) return
  if (breadReady(bot, ctx)) { source('harvest', 'wheat'); r.phase = 'bread'; r.bread = null; ctx.lastGoalKey = ''; return }
  const w = hv.digs < HARVEST_CAP ? ripeCrop(bot, ctx) : null
  if (!w) { source('harvest', hv.digs > 0 ? 'short' : 'none'); done(true); return }
  if (farm.walkTo(bot, ctx, hv.f, 'food-harvest', w)) {
    if (++hv.ticks > HARVEST_WALK_TICKS) { source('harvest', 'unreachable'); done(true) }
    return
  }
  hv.ticks = 0
  let b = null
  try { b = bot.blockAt(new Vec3(w.x, w.y, w.z)) } catch (_) { b = null }
  if (!b || !farm.isMatureCrop(b)) return
  hv.busy = true
  Promise.resolve().then(() => bot.dig(b)).then(() => { hv.digs++; console.log(`food recovery harvest ${b.name} at ${w.x},${w.y},${w.z}`) }, () => { hv.digs = HARVEST_CAP })
    .finally(() => { hv.busy = false })
}

require('../reflexes').setFoodChestProbe(normalFoodChest)

module.exports = { run, needed, available, invalidate, failed, normalFoodChest, RETRY_MS, HUNGRY_FOOD, HUNGRY_WANT }
