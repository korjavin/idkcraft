'use strict'

// Survival acquisition has its own state: a material forage failure and its
// cooldown must survive this leg. Window flights also outlive cancellation.
const bring = require('./bring')
const forage = require('./forage')
const { stepDone, stepFailed } = require('../step')
const { LOW_HP_FOOD, LOW_HP_GATE_MS, lowHpNoFood, needsFood } = require('../health-gate')
const craftany = require('./craftany')
const { chestHope, chestKeyOf } = require('./stockpile')
const { Vec3 } = require('vec3')

const RETRY_MS = 60000
const RETRY_MAX_MS = 900000 // repeated empty runs: 1, 2, 4, 8, 15 min
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

// Night is shelter time, except a starving body (health<LOW_HP_FOOD or food 0) eats first.
const foodTime = (bot, facts) => facts.time === 'day' || facts.health < LOW_HP_FOOD || bot.food === 0

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

function hasMeal(bot, ctx) {
  try { const items = bot.inventory.items(); return Array.isArray(items) && !!require('../reflexes').mealFor(bot, ctx || {}, items) } catch (_) { return false }
}

function hungry(bot, ctx, facts, sources = () => foodSources(bot, ctx)) {
  if (!bot || !facts || process.env.BOT_BODY !== 'baritone' || !foodTime(bot, facts) || !(bot.food < HUNGRY_FOOD) || facts.health < LOW_HP_FOOD) return false
  if (ctx && (ctx.llmOrder || ctx.taskPlanArgs)) return false
  // Source ladder (src/source-ladder.js): pack bread, a near chest, then a
  // hunt; chestSearch (the long-trip rung) only once none of these serves.
  if (!noMeal(bot, ctx)) return false
  const src = sources().length > 0
  if (ctx) ctx.foodNoSource = !src // stall/JEV context: hungry with nothing to fetch, hunt or harvest
  return src
}

function needed(bot, ctx, facts, sources) {
  if (hungry(bot, ctx, facts, sources)) return true
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
  const wants = w(rotten ? orRotten : isEdible)
  const since = Math.max(ctx.foodRecovery?.endedAt || 0, (ctx.foodChestDryUntil || 0) - DRY_MS)
  const freshStock = new Map()
  if (bot && since > 0 && !ctx.foodRecovery?.valid) {
    for (const c of ctx.chests || []) {
      if (c && c.at > since && chestHope(ctx, c, wants) === 2) freshStock.set(chestKeyOf(c), c.at)
    }
  }
  // A newer positive chest read can reopen a previously empty/failed chest.
  // Ageing a read or losing sight of a chest supplies no new evidence.
  const chestSeen = freshStock.size ? ctx.foodRecoveryChestSeen.filter((k) => !freshStock.has(k)) : ctx.foodRecoveryChestSeen
  return {
    kind: 'food', phase: 'chestfetch', want, wants, drawWants: w(bot && require('../reflexes').starving(bot) ? orRotten : isEdible),
    have: 0, drop: null, chestSeen, freshStock,
    chestAllowed: bot && chestsDry(ctx) ? (p) => freshStock.has(chestKeyOf(p)) : null,
    maxChestDistance: bot && require('../reflexes').starving(bot) ? FOOD_CHEST_RADIUS : HUNGRY_CHEST_RADIUS,
  }
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

const huntSource = (bot, ctx) => safeHunt(bot, forage.foodTarget(bot, ctx, true))
const chestSourceKey = (key) => `chest:${key}`

function foodSources(bot, ctx, order = null) {
  const active = ctx.foodRecovery?.valid && ctx.foodRecovery.chest
  const chest = order || active || chestState(ctx, 1, bot)
  const sources = []
  if (breadReady(bot, ctx)) sources.push('bread')
  const key = chestKeyOf(bring.pickChest(bot, ctx, chest)?.pos)
  if (key !== null) {
    sources.push(chestSourceKey(key))
    if (chest.freshStock?.has(key)) sources.push(`stocked:${key}:${chest.freshStock.get(key)}`)
  }
  const hunt = huntSource(bot, ctx)
  if (hunt) sources.push(`hunt:${hunt.id}`)
  const crop = ripeCrop(bot, ctx)
  if (crop) sources.push(`crop:${crop.x},${crop.y},${crop.z}`)
  return sources
}

function available(bot, ctx, facts) {
  if (!ctx || ctx.foodRecoveryFlight) return false
  let cachedSources
  const currentSources = () => (cachedSources ??= foodSources(bot, ctx))
  if (!needed(bot, ctx, facts, currentSources)) return false
  const sources = currentSources()
  if (ctx.foodRecoveryRetryAt && Date.now() < ctx.foodRecoveryRetryAt) {
    if (ctx.foodRecoverySig == null) ctx.foodRecoverySig = sources
    // Losing a candidate supplies no reason to retry any earlier source.
    const added = sources.find((key) => !ctx.foodRecoverySig.includes(key))
    if (!added) return false
    console.log(`food recovery cooldown lifted: sources changed kind=${added.split(':')[0]}`)
    ctx.foodRecoveryRetryAt = 0
  }
  const wheat = wheatCount(bot)
  if (sources.length === 0 && wheat >= 3 && !(ctx.foodBreadRetryAt && Date.now() < ctx.foodBreadRetryAt) && (!ctx.foodBreadLogAt || Date.now() - ctx.foodBreadLogAt >= 60000)) {
    ctx.foodBreadLogAt = Date.now()
    console.log(`food recovery source=bread table=none why=no-table-no-wood wheat=${wheat}`)
  }
  return sources.length > 0
}

// safety = preempted by a fight/retreat/flee: not the source's fault, no strike
// (prod 2026-11-20: every retreat tick struck a bread run, strikes=11, 15 min idle).
function invalidate(ctx, safety = false) {
  if (ctx && ctx.foodRecovery) {
    if (safety) ctx.foodRecovery.noStrike = true
    cancel(ctx, ctx.foodRecovery)
  }
}

// prod 2026-11-19 bot4: the shared noPath reaction (unreachable.js) failed the
// step on an unreachable table, done() never ran, and the arbiter restarted the
// same bread leg every few ticks (55 restarts/10 min). A step failed from outside
// strikes the source it was on: bread pauses (next run takes chest/hunt at once),
// any other rung takes the RETRY_MS cooldown.
function failed(ctx) {
  const r = ctx && ctx.foodRecovery
  if (!r || !r.valid) return
  if (r.phase === 'bread') { ctx.foodBreadRetryAt = Date.now() + LOW_HP_GATE_MS; r.noStrike = true }
  console.log(`food recovery result=failed phase=${r.phase} status=${ctx.stepStatus}`)
  cancel(ctx, r)
}

// Any end of a run that ate nothing (fail, idle no-target, preempt, retry,
// done with nothing eaten) is a strike: the cooldown doubles on repeats, so a
// trigger with no workable source cannot restart every tick. Eating resets it.
function strike(ctx, r) {
  const n = ctx.foodRecoveryFails = (ctx.foodRecoveryFails || 0) + 1
  const ms = Math.min(RETRY_MS * 2 ** (n - 1), RETRY_MAX_MS)
  ctx.foodRecoveryRetryAt = Date.now() + ms
  const current = r.bot ? foodSources(r.bot, ctx) : []
  const tried = (r.chest?.chestSeen || []).map(chestSourceKey)
  if (r.hunt?.target) tried.push(`hunt:${r.hunt.target.id}`)
  ctx.foodRecoverySig = [...(r.sources || []), ...current, ...tried]
  console.log(`food recovery cooldown strikes=${n} retry_in=${Math.round(ms / 1000)}s`)
}

// A cancelled bread run must not leave its craftany run for the next start.
function cancel(ctx, r) {
  if (r.valid) r.endedAt = Date.now()
  if (r.valid && !r.noStrike) {
    const b = r.bot
    if (b && (b.food > r.startFood || hasMeal(b, ctx))) ctx.foodRecoveryFails = 0
    else strike(ctx, r)
  }
  r.valid = false
  if (r.bread && ctx.craftany && ctx.craftany.key === 'breadx1') ctx.craftany = null
}

function run(bot, ctx) {
  let r = ctx.foodRecovery
  if (!r || !r.valid) {
    // prod 2026-11-19 bot3/bot4: the goal fsm keeps a live foodRecovery step while needed(),
    // so a struck run restarted (and struck) every tick; a cooldown ends the step instead.
    if (ctx.foodRecoveryRetryAt && Date.now() < ctx.foodRecoveryRetryAt) { stepFailed(ctx, 'cooldown'); return }
    // food<6 is an emergency like low hp: chest, then hunt (prod: Easy holds hp at 10)
    const hungryRun = !needsFood({ health: bot.health, food: bot.food })
    const chest = chestState(ctx, bot.health < 6 ? 1 : HUNGRY_WANT, bot)
    const sources = foodSources(bot, ctx, chest)
    ctx.foodRecoveryChestSeen = chest.chestSeen
    const hasChest = sources.some((key) => key.startsWith('chest:'))
    const phase = sources.includes('bread') ? 'bread' : chestsDry(ctx) && !hasChest ? 'hunt' : 'chest'
    r = ctx.foodRecovery = { valid: true, hungry: hungryRun, sources, chest, phase, startFood: bot.food }
    Object.defineProperty(r, 'bot', { value: bot }) // for cancel()'s ate-check; kept out of JSON logs
    ctx.lastPathStatus = 'none'
    require('../food-rate').note(ctx, 'recoveries')
    console.log(`food recovery start health=${bot.health} food=${bot.food} edible=0${hungryRun ? ' why=hungry' : ''}`)
  }
  const valid = () => r.valid && ctx.foodRecovery === r && ctx.step === 'foodRecovery' &&
    ctx.work !== false && !ctx.paused && !ctx.bring && !ctx.lead && !ctx.followName && !(ctx.flat && !ctx.flat.parked) &&
    bot.food < 18 && (r.hungry || needsFood({ health: bot.health, food: bot.food }))
  const done = (retry) => {
    if (!valid()) return
    console.log(`food recovery result=${retry ? 'retry' : 'acquired'} health=${bot.health} food=${bot.food}`)
    cancel(ctx, r) // strikes unless food rose or a meal is in the pack
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
    r.phase = chestsDry(ctx) && !bring.pickChest(bot, ctx, r.chest) ? 'hunt' : 'chest'; ctx.lastGoalKey = '' // same episode: chest, then hunt
    return
  }
  if (r.phase === 'chest') {
    if (ctx.foodRecoveryFlight) {
      if (ctx.foodRecoveryFlight.owner === r && Date.now() - ctx.foodRecoveryFlight.at >= WINDOW_TIMEOUT_MS) {
        cancel(ctx, r)
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
      if (!noMeal(bot, ctx)) { source('chest', 'acquired'); done(false) } else if (breadReady(bot, ctx)) { source('chest', 'wheat'); r.phase = 'bread'; r.bread = null; ctx.lastGoalKey = '' } else {
        const { want, chestAllowed } = r.chest
        r.chest = { ...chestState(ctx, want, bot), chestAllowed }
      }
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
    const target = huntSource(bot, ctx)
    if (!target) { toHarvest(); return }
    console.log(`food recovery hunt=${target.name}`)
    require('../loot').makeRoom(bot) // the kill's drop needs a free slot
    target.want = 1
    r.hunt = { target, phase: 'find', startInv: {}, stalls: 0, foodStreak: 0 }
  }
  const h = r.hunt
  const replanTarget = () => {
    const target = huntSource(bot, ctx)
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

// Low hp (prod 2026-11-20 bot4: foodRecovery at 0.15 hp, killed by a
// skeleton at y=-30): the hunt never follows prey down or into the dark,
// where the mobs spawn; the run falls through to harvest, then its cooldown.
function safeHunt(bot, target) {
  if (!target || !(bot.health < 6)) return target
  try {
    const e = bot.entities && bot.entities[target.id]
    const bp = bot.entity.position
    if (!e || !e.position) return target
    if (e.position.y < bp.y - 2) return null
    const b = bot.blockAt(e.position.offset(0, 1, 0))
    if (b && b.skyLight === 0) return null
  } catch (_) { /* unreadable: keep the target */ }
  return target
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

module.exports = { run, needed, available, invalidate, failed, normalFoodChest, safeHunt, RETRY_MS, HUNGRY_FOOD, HUNGRY_WANT }
