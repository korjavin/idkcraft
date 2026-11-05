'use strict'

const { goals } = require('mineflayer-pathfinder')
const { Vec3 } = require('vec3')
const { isFightTarget } = require('../perception')
const { WATER_BLOCKS } = require('../danger')
const follow = require('./follow')
const { issueGoal, clearGoal } = require('./util')

const SWING_RANGE = 3
// ponytail: spaced retries + give-up. Re-issuing setGoal every brain tick
// calls resetPath, which clears the pathfinder's search latch (pathUpdated)
// and its in-progress search — a search needing more than ~1 s of the 5 s
// allowance would be torn down and restarted forever. So retries are spaced
// wider than the search allowance, and pursuit is abandoned after
// GIVE_UP_TICKS stationary ticks: an unreachable mob (cave, glass, ravine)
// must not pin the tick. The give-up latch (ctx.fightGivenUpId) is fed back
// to the brain as hostile_reachable=false, so fight-vs-follow arbitration
// stays with the brain; the ticker re-probes the pursuit after 30 ticks.
// After give-up the bot shadows the player instead of freezing, and still
// swings if the mob walks into range.
const RETRY_EVERY_TICKS = 6
const GIVE_UP_TICKS = 18
// Ignore snapshot jitter, but allow a real detour to replenish the budget:
// getting around an obstacle need not reduce straight-line target distance.
const PROGRESS_BLOCKS = 0.5
// ponytail: hysteresis margin (blocks). A newcomer this much nearer than
// the incumbent wins immediately.
const STICKY_MARGIN_BLOCKS = 2

// ponytail: one function, no base class or activate/deactivate hooks —
// same shape as follow.js. One swing per tick (1/s); a 600 ms swing timer
// would need a deactivate hook, which we deliberately do not have.
function fight(bot, ctx, target, state) {
  let hostile = stickyTarget(bot, ctx, target, state && state.hostile)
  if (!hostile || hostile.isValid === false) {
    ctx.fightId = null
    ctx.fightGivenUpId = null
    ctx.fightProgress = null
    ctx.fightPursuit = 0
    // No visible mob but the brain said fight (e.g. a remote model answering
    // fight on hostile_distance=none): delegate to follow.js — one follow
    // implementation. Never call bot.pathfinder.stop() in the same tick as
    // setGoal(): stop() latches stopPathing and resetPath nulls the new goal.
    follow(bot, ctx, target, state)
    return
  }
  ctx.fightId = hostile.id
  const key = `fight:${hostile.id}`
  const inRange = bot.entity.position.distanceTo(hostile.position) <= SWING_RANGE
  const wet = inWater(bot, hostile)
  if (wet || airborne(bot, hostile)) {
    // idkcraft-2pkm: never pursue a flying mob (phantom, bat, a rising
    // blaze). GoalFollow's isEnd is 3D, so the only path to a mob in open
    // air is up: v1 1x1 towers / placed jump-up stairs, v2 Baritone
    // allowPlace pillars — and the column stays in the landscape. No
    // pursuit goal ever (in reach too: a dynamic follow of a swooping
    // phantom chases it back up); drop our own one, since follow(null) in
    // work mode leaves it driving. In reach: swing. Out of reach: a flying
    // kind is written off like an unreachable mob (brain sees
    // hostile_reachable=false); a walker momentarily over air (falling off
    // a ledge) only gets no goal this tick and is re-checked next tick.
    if (ctx.lastGoalKey === key) clearGoal(bot, ctx)
    ctx.fightPursuit = 0
    if (inRange) {
      if (!ctx.reflexSwung) swing(bot, hostile)
      return
    }
    if (wet || FLYERS.has(hostile.name)) giveUp(bot, ctx, hostile, wet ? 'wet' : 'airborne')
    follow(bot, ctx, target, state)
    return
  }
  if (ctx.fightGivenUpId === hostile.id) {
    // Pursuit abandoned (the brain sees hostile_reachable=false and yields
    // to follow): shadow the player as the local safety net, swing if the
    // mob wandered into range (unless the melee reflex already swung this
    // tick — one swing per tick).
    if (inRange) {
      ctx.fightGivenUpId = null
      ctx.fightPursuit = 0
      ctx.fightProgress = { id: hostile.id, pos: bot.entity.position.clone() }
      if (!ctx.reflexSwung) swing(bot, hostile)
    } else {
      follow(bot, ctx, target, state)
    }
    return
  }
  // A goal request (including the bridge's optimistic isMoving=true) is
  // not body progress. Keep the anchor across retries and recovery release,
  // which clears lastGoalKey even when the actor returns to the same spot.
  // Only the ticker clears an exhausted target's latch for a timed reprobe;
  // passing the latch branch above with a spent counter starts that budget.
  const progress = ctx.fightProgress
  const here = bot.entity.position
  const moved = progress && (Math.hypot(here.x - progress.pos.x, here.z - progress.pos.z) >= PROGRESS_BLOCKS ||
    (bot.entity.onGround !== false && Math.floor(here.y) !== Math.floor(progress.pos.y)))
  if (!progress || progress.id !== hostile.id || ctx.fightPursuit > GIVE_UP_TICKS ||
      inRange || moved) {
    ctx.fightProgress = { id: hostile.id, pos: bot.entity.position.clone() }
    ctx.fightPursuit = 0
    ctx.fightGivenUpId = null
  } else {
    ctx.fightPursuit = (ctx.fightPursuit || 0) + 1
    if (ctx.fightPursuit > GIVE_UP_TICKS) {
      giveUp(bot, ctx, hostile, 'stationary')
      // follow(null) does nothing in work mode: retire our own live goal
      // here so the abandoned pursuit cannot keep driving the body.
      if (ctx.lastGoalKey === key) clearGoal(bot, ctx)
      follow(bot, ctx, target, state)
      return
    }
  }
  if (key !== ctx.lastGoalKey) {
    issueGoal(bot, ctx, new goals.GoalFollow(hostile, 2), key, true)
    ctx.fightProgress.issuedAt = ctx.fightPursuit
    equipGear(bot)
  } else if (!inRange && ctx.fightPursuit > 0 &&
      ctx.fightPursuit - (ctx.fightProgress.issuedAt || 0) >= RETRY_EVERY_TICKS && !bot.pathfinder.isMoving()) {
    bot.pathfinder.setGoal(new goals.GoalFollow(hostile, 2), true)
    ctx.fightProgress.issuedAt = ctx.fightPursuit
  }
  // Same-tick reflex guard: the reflex already swung (at any mob — it hits
  // the nearest while fight may hold a sticky incumbent), so a second
  // bot.attack here would double the swing rate.
  if (inRange && !ctx.reflexSwung) {
    swing(bot, hostile)
  }
}

// One attribution per terminal transition, never per tick while latched.
function giveUp(bot, ctx, hostile, branch) {
  if (branch === 'stationary' && ctx.fightGivenUpId !== hostile.id) {
    const at = (p) => p ? `${p.x.toFixed(2)},${p.y.toFixed(2)},${p.z.toFixed(2)}` : 'none'
    const progress = ctx.fightProgress
    console.log(`fight pursuit=give-up branch=${branch} target=${hostile.id}:${hostile.name} targetPos=${at(hostile.position)} ticks=${ctx.fightPursuit || 0} anchor=${at(progress && progress.id === hostile.id ? progress.pos : null)} pos=${at(bot.entity.position)}`)
  }
  ctx.fightGivenUpId = hostile.id
}

// Stay on the current target while it is still a fight candidate: perception
// re-ranks nearest every tick, and flip-flopping between two mobs would reset
// the retry spacing and the give-up budget (and re-equip) on every crossover.
// Two escapes: a written-off incumbent never wins (a newly picked target may
// be the reachable fight the give-up was blinding us to), and a newcomer
// nearer by STICKY_MARGIN_BLOCKS wins immediately.
function stickyTarget(bot, ctx, target, fresh) {
  if (ctx.fightId == null) return fresh
  if (fresh && fresh.id === ctx.fightId) return fresh
  if (ctx.fightGivenUpId === ctx.fightId) return fresh
  const prev = bot.entities ? bot.entities[ctx.fightId] : null
  if (!isFightTarget(prev, bot.entity.position, target && target.position)) return fresh
  if (fresh) {
    const dPrev = prev.position.distanceTo(bot.entity.position)
    const dFresh = fresh.position.distanceTo(bot.entity.position)
    if (dFresh + STICKY_MARGIN_BLOCKS < dPrev) return fresh
  }
  return prev
}

// Flying = an always-flying kind (FLYERS: a phantom swooping low is still
// one tick from climbing away), or no floor (any non-air block: ground,
// leaves, water) in the mob's own cell (slab, carpet, snow layer) or the
// FLOOR_CELLS cells under its feet, i.e. not standing where a bot on foot
// can stand within melee height of it. Unknown cells (no blockAt,
// unloaded chunk) read as grounded: the old pursuit stands.
// ponytail: a grounded mob on a tall ledge can still be towered to (old
// behaviour, not this bead).
const FLOOR_CELLS = 2
const FLYERS = new Set(['phantom', 'ghast', 'vex', 'bat'])
function airborne(bot, hostile) {
  if (FLYERS.has(hostile.name)) return true
  if (typeof bot.blockAt !== 'function') return false
  const p = hostile.position
  try {
    for (let k = 0; k <= FLOOR_CELLS; k++) {
      const b = bot.blockAt(new Vec3(Math.floor(p.x), Math.floor(p.y) - k, Math.floor(p.z)))
      if (!b || !/(^|_)air$/.test(b.name || '')) return false
    }
  } catch (_) { return false }
  return true
}

// In water = the mob's feet cell or head cell is a danger.js WATER_BLOCKS
// block. A zombie wading at the shore (feet water, head air) counts too: it
// is one step from deep water. Unknown cells read as dry (old pursuit).
function inWater(bot, hostile) {
  if (typeof bot.blockAt !== 'function') return false
  const p = hostile.position
  try {
    for (let k = 0; k <= 1; k++) {
      const b = bot.blockAt(new Vec3(Math.floor(p.x), Math.floor(p.y) + k, Math.floor(p.z)))
      if (b && WATER_BLOCKS.has(b.name)) return true
    }
  } catch (_) { return false }
  return false
}

function swing(bot, hostile) {
  bot.lookAt(hostile.position.offset(0, hostile.height * 0.8, 0), true)
  bot.attack(hostile)
}

// ponytail: first sword in inventory wins (no attackDamage ranking) —
// an op can /give IdkBot iron_sword; fists are fine for the demo.
// Armor is the same idea: first *_helmet/_chestplate/_leggings/_boots
// to head/torso/legs/feet, skipping a slot that already holds armor
// (mineflayer armor slots: head=5, torso=6, legs=7, feet=8).
// No mineflayer-armor-manager: four suffix matches via bot.equip is enough.
const ARMOR_SLOTS = [
  { suffix: '_helmet', dest: 'head', slot: 5 },
  { suffix: '_chestplate', dest: 'torso', slot: 6 },
  { suffix: '_leggings', dest: 'legs', slot: 7 },
  { suffix: '_boots', dest: 'feet', slot: 8 },
]

async function equipOne(bot, item, dest) {
  try {
    await bot.equip(item, dest)
  } catch {
    // best-effort: fists are fine.
  }
}

async function gearBatch(bot) {
  if (!bot.inventory || typeof bot.inventory.items !== 'function') return
  if (typeof bot.equip !== 'function') return
  let items
  try {
    items = bot.inventory.items()
  } catch {
    return // best-effort: inventory not ready at spawn
  }
  if (!Array.isArray(items)) return
  const sword = items.find((i) => i && typeof i.name === 'string' && i.name.endsWith('_sword'))
  if (sword) await equipOne(bot, sword, 'hand')
  for (const { suffix, dest, slot } of ARMOR_SLOTS) {
    if (bot.inventory.slots && bot.inventory.slots[slot]) continue // already geared
    const piece = items.find((i) => i && typeof i.name === 'string' && i.name.endsWith(suffix))
    if (piece) await equipOne(bot, piece, dest)
  }
}

// Serialised across calls: one mineflayer equip is two window clicks
// sharing a single cursor, so overlapping batches would swap pieces down
// the hotbar instead of wearing them. Callers stay fire-and-forget —
// the chain never rejects.
let gearChain = Promise.resolve()

function equipGear(bot) {
  gearChain = gearChain.then(() => gearBatch(bot)).catch(() => {})
  return gearChain
}

module.exports = fight
module.exports.SWING_RANGE = SWING_RANGE
module.exports.swing = swing
module.exports.airborne = airborne
module.exports.inWater = inWater
module.exports.equipGear = equipGear
