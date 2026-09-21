'use strict'

const { goals } = require('mineflayer-pathfinder')

const SWING_RANGE = 3
// ponytail: spaced retries + give-up. Re-issuing setGoal every brain tick
// calls resetPath, which clears the pathfinder's search latch (pathUpdated)
// and its in-progress search — a search needing more than ~1 s of the 5 s
// allowance would be torn down and restarted forever. So retries are spaced
// wider than the search allowance, and pursuit is abandoned after
// GIVE_UP_TICKS stationary ticks: an unreachable mob (cave, glass, ravine)
// must not pin the tick and burn search on every physics tick. Swinging
// still works if the mob walks into range; fight-vs-follow arbitration
// stays with the brain.
const RETRY_EVERY_TICKS = 6
const GIVE_UP_TICKS = 18

// ponytail: one function, no base class or activate/deactivate hooks —
// same shape as follow.js. One swing per tick (1/s); a 600 ms swing timer
// would need a deactivate hook, which we deliberately do not have.
function fight(bot, ctx, target, state) {
  const hostile = state && state.hostile
  if (!hostile || hostile.isValid === false) {
    if (ctx.lastGoalKey !== 'idle') bot.pathfinder.stop()
    ctx.lastGoalKey = 'idle'
    return
  }
  const key = `fight:${hostile.id}`
  const giveUpKey = `fight-giveup:${hostile.id}`
  const inRange = bot.entity.position.distanceTo(hostile.position) <= SWING_RANGE
  if (ctx.lastGoalKey === giveUpKey) {
    // Pursuit abandoned: stay quiet, but swing if it wandered into range.
    if (inRange) {
      ctx.lastGoalKey = key
      ctx.fightPursuit = 0
      swing(bot, hostile)
    }
    return
  }
  if (key !== ctx.lastGoalKey) {
    bot.pathfinder.setGoal(new goals.GoalFollow(hostile, 2), true)
    ctx.lastGoalKey = key
    ctx.fightPursuit = 0
    equipSword(bot)
  } else if (!inRange) {
    if (bot.pathfinder.isMoving()) {
      ctx.fightPursuit = 0 // progress: a later stall gets a fresh budget
    } else {
      ctx.fightPursuit = (ctx.fightPursuit || 0) + 1
      if (ctx.fightPursuit > GIVE_UP_TICKS) {
        bot.pathfinder.stop()
        ctx.lastGoalKey = giveUpKey
        return
      }
      if (ctx.fightPursuit % RETRY_EVERY_TICKS === 0) {
        bot.pathfinder.setGoal(new goals.GoalFollow(hostile, 2), true)
      }
    }
  } else {
    ctx.fightPursuit = 0
  }
  if (inRange) {
    swing(bot, hostile)
  }
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
