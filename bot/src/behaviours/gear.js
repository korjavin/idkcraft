'use strict'

// gear: the blacksmith step (idkcraft-ipn.3). Climbs the vanilla gear ladder
// and hands finished goods to the owner: one MENU step with an internal rung
// machine, no per-rung steps.
//
// Ladder (iron, then diamond): self pickaxe, owner sword, owner pickaxe.
// Self first: diamond ore needs an iron pick in the inventory (bring.js tier
// gate), so the bot forges its own hands before the owner's kit. Stone is
// equip's job and the precondition, not a rung. Armour is a follow-up (the
// RUNGS table extends by data).
//
// The rung machine derives its position from the inventory every tick — no
// monotonic phase counter — so death, displacement, or a gifted tool move it
// correctly (a lost self pick regresses the ladder to iron). Owner pieces
// are craft-once: once forged and vanished from the pack they read as handed
// over, whether tossed to a player (deliver) or banked (stockpile). A death
// that eats an unhanded owner piece is forgiven, not remade: tracking it
// would need a death marker across steps, and the reconcile below stays
// silent rather than claim a handover it cannot prove (chat honesty).
//
// Subroutines (owned by slices A and B, driven here, no MENU steps of their
// own): furnace(bot, ctx) smelts raw iron behind ctx.furnace.result, deep()
// digs diamonds behind a stepStatus relay. Both run INSIDE the gear step so
// raw mats never sit in the haul across a decision (deliver would toss raw
// diamonds to an online player and starve the ladder). A missing slice impl
// reads as a latched wait, never a failure: iron lands on A, diamonds on B.
//
// Night-shift honesty: online, deliver-first tosses every forage leg before
// gear can accumulate ore, so the ladder effectively progresses with nobody
// online (E's night acceptance). That is the epic's shape, not a bug: the
// day bot fetches raw, the night bot forges. Stranded chest batches (ore
// banked at SURPLUS_BATCH while fuel-short) are waste, not a stall — coal is
// never banked (EXACT_KEEP), so fuel always recovers on hand. Pantry
// withdraw is a follow-up, not v1.

const { goals } = require('mineflayer-pathfinder')
const { Vec3 } = require('vec3')
const craftMod = require('./craft')
const deliverMod = require('./deliver')
const { COAL_RESERVE } = require('./light')
const { countItems } = require('../perception')
const { say } = require('./util')

// Ladder data: tiers in order, pieces in order. kind+owner name the want;
// the item name is `${tier}_${kind}`.
const RUNGS = [
  {
    tier: 'iron', mat: 'iron_ingot',
    pieces: [
      { kind: 'pickaxe', owner: false },
      { kind: 'sword', owner: true },
      { kind: 'pickaxe', owner: true },
    ],
  },
  {
    tier: 'diamond', mat: 'diamond',
    pieces: [
      { kind: 'pickaxe', owner: false },
      { kind: 'sword', owner: true },
      { kind: 'pickaxe', owner: true },
    ],
  },
]
const MAT_NEED = { pickaxe: 3, sword: 2 }
const STICK_NEED = { pickaxe: 2, sword: 1 }
// Owner wants per item name (tiers differ by name, so names are unique).
const OWNER_WANT = { iron_sword: 1, iron_pickaxe: 1, diamond_sword: 1, diamond_pickaxe: 1 }
const WALK_GIVE_UP = 20

function have(bot, name) {
  try {
    return countItems(bot, (n) => n === name)
  } catch (_) {
    return 0
  }
}

function gearCtx(ctx) {
  try {
    if (!ctx.gear || typeof ctx.gear !== 'object') ctx.gear = {}
    return ctx.gear
  } catch (_) {
    return {}
  }
}

function runCtx(ctx) {
  try {
    if (!ctx.gearRun || typeof ctx.gearRun !== 'object') ctx.gearRun = {}
    return ctx.gearRun
  } catch (_) {
    return {}
  }
}

// Next ladder want, derived from the pack: null when the ladder is complete.
// Self pieces read the inventory (a lost pick regresses the ladder); owner
// pieces read the given ledger. Iron scans before diamond, so the diamond
// rung is structurally gated on a carried iron pick (ipn.2 contract: no
// facts.deep, the need-iron-pick failure cannot fire).
function deriveNext(bot, ctx) {
  let given = null
  try {
    given = (ctx && ctx.gearGiven) || {}
  } catch (_) {
    given = {}
  }
  for (let ti = 0; ti < RUNGS.length; ti++) {
    const rung = RUNGS[ti]
    for (let pi = 0; pi < rung.pieces.length; pi++) {
      const piece = rung.pieces[pi]
      const name = `${rung.tier}_${piece.kind}`
      if (piece.owner) {
        if ((given[name] || 0) < (OWNER_WANT[name] || 1)) {
          return { tier: rung.tier, tierIdx: ti, pieceIdx: pi, mat: rung.mat, kind: piece.kind, owner: true, name, needMat: MAT_NEED[piece.kind], needSticks: STICK_NEED[piece.kind] }
        }
      } else if (have(bot, name) <= 0) {
        return { tier: rung.tier, tierIdx: ti, pieceIdx: pi, mat: rung.mat, kind: piece.kind, owner: false, name, needMat: MAT_NEED[piece.kind], needSticks: STICK_NEED[piece.kind] }
      }
    }
  }
  return null
}

// Ledger reconcile (tick start): the finished record clamps to the live pack
// (tossed, banked, or died away), and a forged-then-vanished owner piece
// reads as handed over. Silent by design: only the banking channel may claim
// a handover out loud (stockpile), the toss channel speaks for itself
// (deliver's 'brought'), and a death-forgiven loss must not be announced.
function reconcile(ctx, bot) {
  let finished = null
  let made = null
  try {
    if (!ctx.gearFinished || typeof ctx.gearFinished !== 'object') ctx.gearFinished = {}
    finished = ctx.gearFinished
    made = (ctx.gear && ctx.gear.made) || {}
  } catch (_) {
    return
  }
  for (const name of Object.keys(OWNER_WANT)) {
    try {
      const live = have(bot, name)
      if ((finished[name] || 0) > live) finished[name] = Math.max(0, live)
      if (made[name] && (finished[name] || 0) <= 0 && live <= 0) {
        if (!ctx.gearGiven || typeof ctx.gearGiven !== 'object') ctx.gearGiven = {}
        if ((ctx.gearGiven[name] || 0) < OWNER_WANT[name]) ctx.gearGiven[name] = OWNER_WANT[name]
      }
    } catch (_) { /* ledger best-effort */ }
  }
}

// Live unhanded owner goods: read-only (the stockpile handover gate).
function handoverWaiting(bot, ctx) {
  try {
    const finished = (ctx && ctx.gearFinished) || {}
    for (const name of Object.keys(OWNER_WANT)) {
      if ((finished[name] || 0) > 0 && have(bot, name) > 0) return true
    }
  } catch (_) { /* none waiting */ }
  return false
}

// Plan counts from goal facts (the MENU.feasible/stepWhy/goalText world).
// Per-tier piece counts ride dedicated facts; the furnace claim reads ctx.
function countsFromFacts(facts, ctx) {
  const f = facts || {}
  let furnaceClaim = false
  try {
    furnaceClaim = !!(ctx && ctx.home && ctx.home.furnace)
  } catch (_) { /* no claim */ }
  return {
    ironOre: f.ironOre || 0, ingots: f.ingots || 0, diamonds: f.diamonds || 0,
    sticks: f.sticks || 0, planks: f.maxPlanks || 0, logs: f.logs || 0,
    iron_pickaxe: f.ironPick || 0, iron_sword: f.ironSword || 0,
    diamond_pickaxe: f.diamondPick || 0, diamond_sword: f.diamondSword || 0,
    tablePlaced: !!f.tablePlaced, furnaceClaim,
    furnaceItem: f.furnaceItem || 0, cobble: f.cobble || 0, fuel: f.coal || 0,
  }
}

// Menu-world entry: counts + impl presence + furnace-busy in one call, so
// MENU.feasible, stepWhy, and the goalText bucket share one source.
function menuPlan(facts, ctx) {
  const counts = countsFromFacts(facts, ctx)
  let busy = false
  try {
    busy = !!(ctx.furnace && !ctx.furnace.settled)
  } catch (_) { /* no run in flight */ }
  let furnace = false
  let deep = false
  try {
    furnace = !!legImpl(ctx, 'furnace')
    deep = !!legImpl(ctx, 'deep')
  } catch (_) { /* slices unreadable */ }
  return planFor(counts, ctx, { furnace, deep }, busy)
}

// The single planning source for MENU.feasible, stepWhy, goalText, and the
// tick: pure over counts + ctx (ledger read-only here).
//
// counts: liveCounts (tick) or countsFromFacts (menu) shape.
// impls: { furnace: bool, deep: bool } — slice-A/B presence.
// furnaceBusy: a furnace run is mid-flight (its phases own the tick).
//
// Returns { state, key } plus, by state: ready -> { action },
// want/wait -> { key, line } (the latched announce line).
function planFor(counts, ctx, impls, furnaceBusy) {
  const c = counts || {}
  const im = impls || {}
  let given = {}
  try {
    given = (ctx && ctx.gearGiven) || {}
  } catch (_) {
    given = {}
  }
  for (let ti = 0; ti < RUNGS.length; ti++) {
    const rung = RUNGS[ti]
    for (let pi = 0; pi < rung.pieces.length; pi++) {
      const piece = rung.pieces[pi]
      const name = `${rung.tier}_${piece.kind}`
      if (piece.owner) {
        if ((given[name] || 0) >= (OWNER_WANT[name] || 1)) continue
      } else if ((c[name] || 0) > 0) {
        continue
      }
      return planPiece(rung, name, c, im, furnaceBusy)
    }
  }
  return { state: 'done', key: 'done' }
}

function planPiece(rung, name, c, im, furnaceBusy) {
  const kind = name.endsWith('_pickaxe') ? 'pickaxe' : 'sword'
  const needMat = MAT_NEED[kind]
  const needSticks = STICK_NEED[kind]
  const matHave = rung.tier === 'iron' ? (c.ingots || 0) : (c.diamonds || 0)
  // Sticks first: the cheapest op, and a stick shortfall with mats on hand
  // must not read as a mat want.
  if ((c.sticks || 0) < needSticks) {
    if ((c.planks || 0) >= 2) return { state: 'ready', key: 'ready', action: 'sticks' }
    if ((c.logs || 0) >= 1) return { state: 'ready', key: 'ready', action: 'planks' }
    return { state: 'want', key: 'want-logs', line: 'need logs for sticks, going to chop' }
  }
  if (matHave >= needMat) {
    if (!c.tablePlaced) return { state: 'wait', key: 'wait-table', line: 'need a crafting table at home' }
    return { state: 'ready', key: 'ready', action: 'craft' }
  }
  const short = needMat - matHave
  if (rung.tier === 'diamond') {
    // Buried cells are undiggable by forage (ipn.2): without the deep leg
    // the want is unactionable, so it waits instead of announcing a dig.
    if (!im.deep) return { state: 'wait', key: 'wait-deep', line: 'waiting on the deep shaft for diamonds' }
    return { state: 'ready', key: 'ready', action: 'deep' }
  }
  // Iron: smeltable ore on hand, or ore to fetch, or a slice to wait for.
  const oreHave = c.ironOre || 0
  if (furnaceBusy) return { state: 'ready', key: 'ready', action: 'smelt' }
  if (oreHave > 0) {
    if ((c.fuel || 0) <= COAL_RESERVE) return { state: 'want', key: 'want-coal', line: `need coal above the reserve to smelt ${oreHave} ore, going to dig` }
    if (!im.furnace) return { state: 'wait', key: 'wait-furnace', line: `waiting on the furnace to smelt ${oreHave} ore` }
    if (!c.furnaceClaim && !c.furnaceItem && (c.cobble || 0) < 8) {
      return { state: 'want', key: 'want-cobble', line: 'need 8 cobble for the furnace, going to dig' }
    }
    return { state: 'ready', key: 'ready', action: 'smelt' }
  }
  return { state: 'want', key: 'want-ore', line: `need ${short} more raw iron, going to dig` }
}

// ---- live world ----

function liveCounts(bot, ctx) {
  let planks = 0
  let logs = 0
  try {
    const items = (bot && bot.inventory && typeof bot.inventory.items === 'function' && bot.inventory.items()) || []
    const perWood = {}
    for (const i of items) {
      if (!i || typeof i.name !== 'string') continue
      const n = typeof i.count === 'number' ? i.count : 1
      if (i.name.endsWith('_planks')) perWood[i.name] = (perWood[i.name] || 0) + n
      else if (i.name.endsWith('_log')) logs += n
    }
    for (const v of Object.values(perWood)) {
      if (v > planks) planks = v
    }
  } catch (_) { /* unscannable reads empty */ }
  let tablePlaced = false
  let furnaceClaim = false
  try {
    tablePlaced = !!((ctx && ctx.home && ctx.home.table) || (ctx && ctx.claimedTable))
    furnaceClaim = !!(ctx && ctx.home && ctx.home.furnace)
  } catch (_) { /* no stations */ }
  return {
    ironOre: have(bot, 'raw_iron'), ingots: have(bot, 'iron_ingot'), diamonds: have(bot, 'diamond'),
    sticks: have(bot, 'stick'), planks, logs,
    iron_pickaxe: have(bot, 'iron_pickaxe'), iron_sword: have(bot, 'iron_sword'),
    diamond_pickaxe: have(bot, 'diamond_pickaxe'), diamond_sword: have(bot, 'diamond_sword'),
    tablePlaced, furnaceClaim,
    furnaceItem: have(bot, 'furnace'), cobble: have(bot, 'cobblestone'),
    fuel: have(bot, 'coal') + have(bot, 'charcoal'),
  }
}

// Sub-behaviour resolution: ctx.gearLegs fakes (tests) win, then the real
// slice module. A missing module reads as absent, never throws: the plan
// waits on the slice instead of failing the step.
function legImpl(ctx, name) {
  try {
    if (ctx && ctx.gearLegs && typeof ctx.gearLegs[name] === 'function') return ctx.gearLegs[name]
  } catch (_) { /* fall through to the real module */ }
  try {
    const mod = name === 'furnace' ? require('./furnace') : require('./deep')
    return typeof mod === 'function' ? mod : null
  } catch (_) {
    return null
  }
}

function fail(ctx, item, err) {
  ctx.stepStatus = `failed:gear-${item}`
  try {
    runCtx(ctx).walkTicks = 0
  } catch (_) { /* reset best-effort */ }
  try {
    console.error(`gear failed item=${item} error=${err && err.message ? err.message : err}`)
  } catch (_) { /* logging best-effort */ }
}

function dist3(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)
}

// Walk one leg with a give-up (furnace shape): an unreachable station fails
// the step instead of idling here forever.
function walkTo(bot, ctx, key, p, reason) {
  if (key !== ctx.lastGoalKey) {
    try {
      bot.pathfinder.setGoal(new goals.GoalNear(p.x, p.y, p.z, 3), false)
    } catch (_) { /* retry next tick */ }
    ctx.lastGoalKey = key
  }
  const r = runCtx(ctx)
  r.walkTicks = (r.walkTicks || 0) + 1
  if (r.walkTicks > WALK_GIVE_UP) fail(ctx, reason)
}

// Verified crafting table (craft pattern): the claim plus a live block read,
// else null. Never trust the claim alone (mined table).
function tableBlock(bot, ctx) {
  try {
    const tablePos = (ctx.home && ctx.home.table) || (ctx && ctx.claimedTable)
    if (!tablePos || typeof tablePos.x !== 'number') return null
    const block = bot.blockAt && bot.blockAt(new Vec3(tablePos.x, tablePos.y, tablePos.z))
    if (!block || block.name !== 'crafting_table') return null
    return { block, pos: tablePos }
  } catch (_) {
    return null
  }
}

// One 2x2 op (sticks, planks) or 3x3 tool op. { fail } when stuck.
function opSticks(bot) {
  const planks = craftMod.sortedWoods(craftMod.tally(bot, '_planks'))
  if (planks.length === 0 || planks[0][1] < 2) return { fail: 'no-planks' }
  const found = craftMod.recipes(bot, 'stick', null)
  if (found.length === 0) return { fail: 'no-stick-recipe' }
  return { item: 'stick', recipe: found[0], count: 1, table: null }
}

function opPlanks(bot) {
  const logs = craftMod.sortedWoods(craftMod.tally(bot, '_log'))
  if (logs.length === 0) return { fail: 'no-logs' }
  const found = craftMod.recipes(bot, `${logs[0][0]}_planks`, null)
  if (found.length === 0) return { fail: 'no-planks-recipe' }
  return { item: `${logs[0][0]}_planks`, recipe: found[0], count: 1, table: null }
}

function opTool(bot, name, table) {
  const found = craftMod.recipes(bot, name, table)
  if (found.length === 0) return { fail: `no-${name}-recipe` }
  return { item: name, recipe: found[0], count: 1, table }
}

function runOp(bot, ctx, op, onDone) {
  if (typeof bot.craft !== 'function') {
    fail(ctx, op.item, new Error('bot.craft missing'))
    return
  }
  ctx.gearInFlight = true
  void (async () => {
    try {
      await craftMod.safeCraft(bot, op.recipe, op.count, op.table)
    } catch (err) {
      ctx.gearInFlight = false
      fail(ctx, op.item, err)
      return
    }
    ctx.gearInFlight = false
    try {
      if (typeof onDone === 'function') onDone()
    } catch (_) { /* completion best-effort */ }
  })()
}

// Drive a sub-behaviour for one tick, translating its step report into a
// gear-owned outcome: null while it runs, 'done', or 'failed:<reason>'.
// The gear step's own status is saved and restored — a subroutine must never
// end the step (ipn.1 contract: outcome reads result first, then the relay).
function driveLeg(bot, ctx, impl, resultOf) {
  const keep = ctx.stepStatus
  try {
    ctx.stepStatus = 'running'
  } catch (_) { /* status best-effort */ }
  try {
    impl(bot, ctx)
  } catch (err) {
    try {
      ctx.stepStatus = keep
    } catch (_) { /* restore best-effort */ }
    return `failed:leg-threw:${err && err.message ? err.message : err}`
  }
  let out = null
  try {
    out = resultOf(ctx)
    if (!out) {
      const s = ctx.stepStatus
      if (s && s !== 'running') out = s
    }
  } catch (_) {
    out = null
  }
  try {
    ctx.stepStatus = keep
  } catch (_) { /* restore best-effort */ }
  return out
}

function driveFurnace(bot, ctx, impl) {
  return driveLeg(bot, ctx, impl, (c) => {
    try {
      return (c.furnace && c.furnace.result) || null
    } catch (_) {
      return null
    }
  })
}

function driveDeep(bot, ctx, impl) {
  return driveLeg(bot, ctx, impl, () => null) // stepStatus relay only (ipn.2)
}

// A forged owner piece rides both handover channels at once: the haul for
// an online player (deliver), the finished record for the home chest
// (stockpile). Both clamp to the live pack, so a toss and a bank can never
// double-spend the same tool.
function forged(bot, ctx, next) {
  const g = gearCtx(ctx)
  try {
    if (!g.made) g.made = {}
    g.made[next.name] = true
    if (next.owner) {
      deliverMod.addHaul(ctx, { [next.name]: 1 })
      if (!ctx.gearFinished || typeof ctx.gearFinished !== 'object') ctx.gearFinished = {}
      ctx.gearFinished[next.name] = (ctx.gearFinished[next.name] || 0) + 1
    }
  } catch (_) { /* ledger best-effort */ }
  say(bot, `forged ${next.name} for ${next.owner ? 'you' : 'me'}`)
  try {
    console.log(`gear forged ${next.name} for ${next.owner ? 'owner' : 'self'}`)
  } catch (_) { /* logging best-effort */ }
}

// Latched announce + yield: fetchers run (want) or slices land (wait). The
// yield is done, never failed — failing would hold the step while another
// step can fix the shortfall. The latch doubles as the MENU.feasible gate:
// a latched need reads infeasible until a new need arrives.
function announceYield(ctx, g, bot, key, line) {
  if (g.saidNeed !== key) {
    g.saidNeed = key
    say(bot, line)
  }
  ctx.stepStatus = 'done'
}

function gear(bot, ctx, target, state) {
  if (!ctx) return
  if (ctx.gearInFlight || ctx.furnaceInFlight) return // exactly one window op at a time
  const bp = bot && bot.entity && bot.entity.position
  if (!bp) return
  const home = ctx.home
  if (!home || !home.site || !home.built) return // menu gates built; a race yields silently
  reconcile(ctx, bot)
  const g = gearCtx(ctx)
  const next = deriveNext(bot, ctx)
  const counts = liveCounts(bot, ctx)
  let busy = false
  try {
    busy = !!(ctx.furnace && !ctx.furnace.settled)
  } catch (_) { /* no run in flight */ }
  const im = { furnace: !!legImpl(ctx, 'furnace'), deep: !!legImpl(ctx, 'deep') }
  const plan = planFor(counts, ctx, im, busy)
  if (!next || plan.state === 'done') {
    try {
      console.log('gear ladder complete')
    } catch (_) { /* logging best-effort */ }
    ctx.stepStatus = 'done'
    return
  }
  const key = `${next.tier}:${next.kind}:${next.owner ? 'give' : 'self'}`
  if (g.lastKey !== key) {
    g.lastKey = key
    say(bot, `next gear: ${next.name} for ${next.owner ? 'you' : 'me'}`)
    try {
      console.log(`gear rung ${key}`)
    } catch (_) { /* logging best-effort */ }
  }
  if (plan.state === 'want' || plan.state === 'wait') {
    announceYield(ctx, g, bot, plan.key, plan.line)
    return
  }
  if (plan.state !== 'ready') {
    ctx.stepStatus = 'done' // unknown state: safe yield, never a hold
    return
  }
  if (plan.action === 'sticks') {
    const op = opSticks(bot)
    if (op.fail) {
      fail(ctx, op.fail)
      return
    }
    runOp(bot, ctx, op)
    return
  }
  if (plan.action === 'planks') {
    const op = opPlanks(bot)
    if (op.fail) {
      fail(ctx, op.fail)
      return
    }
    runOp(bot, ctx, op)
    return
  }
  if (plan.action === 'smelt') {
    const impl = legImpl(ctx, 'furnace')
    if (!impl) {
      ctx.stepStatus = 'done' // raced the slice: re-plan next tick
      return
    }
    const out = driveFurnace(bot, ctx, impl)
    if (!out) return // leg in progress
    if (out === 'done') return // ingots landed; re-plan next tick
    const reason = out.startsWith('failed:') ? out.slice('failed:'.length) : out
    if (reason === 'no-cobble') {
      announceYield(ctx, g, bot, 'want-cobble', 'need 8 cobble for the furnace, going to dig')
      return
    }
    if (reason === 'no-fuel') {
      announceYield(ctx, g, bot, 'want-coal', 'need coal above the reserve, going to dig')
      return
    }
    fail(ctx, `furnace-${reason}`)
    return
  }
  if (plan.action === 'deep') {
    const impl = legImpl(ctx, 'deep')
    if (!impl) {
      ctx.stepStatus = 'done' // raced the slice: re-plan next tick
      return
    }
    const out = driveDeep(bot, ctx, impl)
    if (!out) return // leg in progress
    if (out === 'done') return // diamonds landed; re-plan next tick
    const reason = out.startsWith('failed:') ? out.slice('failed:'.length) : out
    fail(ctx, `deep-${reason}`)
    return
  }
  if (plan.action === 'craft') {
    const st = tableBlock(bot, ctx)
    if (!st) {
      fail(ctx, 'no-table')
      return
    }
    if (dist3(bp, st.pos) > craftMod.TABLE_REACH) {
      walkTo(bot, ctx, `gear-table:${st.pos.x},${st.pos.y},${st.pos.z}`, st.pos, 'table-far')
      return
    }
    runCtx(ctx).walkTicks = 0
    const op = opTool(bot, next.name, st.block)
    if (op.fail) {
      fail(ctx, op.fail)
      return
    }
    runOp(bot, ctx, op, () => forged(bot, ctx, next))
    return
  }
  ctx.stepStatus = 'done' // unknown action: safe yield, never a hold
}

module.exports = gear
module.exports.RUNGS = RUNGS
module.exports.OWNER_WANT = OWNER_WANT
module.exports.deriveNext = deriveNext
module.exports.reconcile = reconcile
module.exports.menuPlan = menuPlan
module.exports.planFor = planFor
module.exports.countsFromFacts = countsFromFacts
module.exports.handoverWaiting = handoverWaiting
