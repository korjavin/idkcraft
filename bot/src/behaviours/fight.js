'use strict'

const { goals } = require('mineflayer-pathfinder')
const { isFightTarget } = require('../perception')

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
// ponytail: hysteresis margin (blocks). A newcomer this much nearer than
// the incumbent wins immediately.
const STICKY_MARGIN_BLOCKS = 2

// ponytail: one function, no base class or activate/deactivate hooks —
// same shape as follow.js. One swing per tick (1/s); a 600 ms swing timer
// would need a deactivate hook, which we deliberately do not have.
function fight(bot, ctx, target, state) {
  let hostile = stickyTarget(bot, ctx, target, state && state.hostile)
  if (!hostile || hostile.isValid === false) {
    stopMoving(bot, ctx)
    ctx.lastGoalKey = 'idle'
    ctx.fightId = null
    ctx.fightGivenUpId = null
    // No visible mob but the brain said fight (e.g. a remote model answering
    // fight on hostile_distance=none): stay with the player instead of
    // parking — the bodyguard fallback, same as after give-up.
    shadowPlayer(bot, ctx, target)
    return
  }
  ctx.fightId = hostile.id
  const key = `fight:${hostile.id}`
  const inRange = bot.entity.position.distanceTo(hostile.position) <= SWING_RANGE
  if (ctx.fightGivenUpId === hostile.id) {
    // Pursuit abandoned (the brain sees hostile_reachable=false and yields
    // to follow): shadow the player as the local safety net, swing if the
    // mob wandered into range (unless the melee reflex already swung this
    // tick — one swing per tick).
    if (inRange) {
      ctx.fightGivenUpId = null
      ctx.fightPursuit = 0
      if (ctx.reflexSwungId !== hostile.id) swing(bot, hostile)
    } else {
      shadowPlayer(bot, ctx, target)
    }
    return
  }
  if (key !== ctx.lastGoalKey) {
    bot.pathfinder.setGoal(new goals.GoalFollow(hostile, 2), true)
    ctx.lastGoalKey = key
    ctx.fightPursuit = 0
    ctx.fightGivenUpId = null
    equipSword(bot)
  } else if (!inRange) {
    if (bot.pathfinder.isMoving()) {
      ctx.fightPursuit = 0 // progress: a later stall gets a fresh budget
    } else {
      ctx.fightPursuit = (ctx.fightPursuit || 0) + 1
      if (ctx.fightPursuit > GIVE_UP_TICKS) {
        ctx.fightGivenUpId = hostile.id
        shadowPlayer(bot, ctx, target)
        return
      }
      if (ctx.fightPursuit % RETRY_EVERY_TICKS === 0) {
        bot.pathfinder.setGoal(new goals.GoalFollow(hostile, 2), true)
      }
    }
  } else {
    ctx.fightPursuit = 0
  }
  // Same-tick reflex guard: the reflex already swung at this mob, so a
  // second bot.attack here would double the swing rate.
  if (inRange && ctx.reflexSwungId !== hostile.id) {
    swing(bot, hostile)
  }
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

function shadowPlayer(bot, ctx, target) {
  if (!target) return
  const skey = `fight-shadow:${target.username || target.id}`
  if (skey !== ctx.lastGoalKey || !bot.pathfinder.isMoving()) {
    bot.pathfinder.setGoal(new goals.GoalFollow(target, 3), true)
    ctx.lastGoalKey = skey
  }
}

// pathfinder.stop() only latches a flag the next setGoal would consume along
// with the new goal — so never stop an empty path, there is nothing to halt.
function stopMoving(bot, ctx) {
  if (ctx.lastGoalKey !== 'idle' && bot.pathfinder.isMoving()) bot.pathfinder.stop()
}

function swing(bot, hostile) {
  bot.lookAt(hostile.position.offset(0, hostile.height * 0.8, 0), true)
  bot.attack(hostile)
}

// ponytail: first sword in inventory wins (no attackDamage ranking) —
// an op can /give IdkBot iron_sword; fists are fine for the demo.
function equipSword(bot) {
  if (!bot.inventory || typeof bot.inventory.items !== 'function') return
  const sword = bot.inventory.items().find((i) => i && typeof i.name === 'string' && i.name.endsWith('_sword'))
  if (!sword || typeof bot.equip !== 'function') return
  try {
    const r = bot.equip(sword, 'hand')
    if (r && typeof r.catch === 'function') r.catch(() => {})
  } catch {
    // best-effort: fists are fine.
  }
}

module.exports = fight
module.exports.SWING_RANGE = SWING_RANGE
module.exports.swing = swing
module.exports.equipSword = equipSword
