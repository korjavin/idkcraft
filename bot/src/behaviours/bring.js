'use strict'

const { goals } = require('mineflayer-pathfinder')
const { findNearest } = require('./scout')
const { countItems } = require('../perception')
const metrics = require('../metrics')

// Bring: the 'bring me <block> [count]' order. The bot walks to the nearest
// matching block alone, digs up to N drops, walks back to the requesting
// player and tosses the drops nearby.
//
// Explicit player ORDER (like ctx.lead), not a brain choice: while ctx.bring
// is set the ticker dispatches here instead of the brain/work, except fight
// which still preempts. Primitives reused, not reinvented: findNearest
// (scout) for search, GoalNear + dig-in-flight + GoalBlock pickup (gather),
// player approach (follow), honest-unseen answer (3a7).
//
// Owner direction: no branching rescue logic. Failure points refuse with a
// message (the ef3/rw4.6 stuck menu owns the choices); the FSM reserve is a
// plain refusal.
const FIND_RADIUS = 48
const WANT_ORE = 3
const WANT_LOGS = 4
const WANT_MAX = 16
const WALK_STALL_TICKS = 10 // stationary ticks before refusing an unreachable target
const MOVE_TOLERANCE = 0.5
const RETURN_RANGE = 2

function dropFor(blockName) {
  if (blockName.endsWith('_log')) return blockName
  const base = blockName.endsWith('_ore') ? blockName.slice(0, -'_ore'.length) : blockName
  const raw = base.match(/(iron|copper|gold)$/)
  if (raw) return `raw_${raw[1]}`
  if (base === 'lapis' || base.endsWith('_lapis')) return 'lapis_lazuli'
  return base // coal, diamond, emerald, redstone, quartz, dirt, ...
}

function needsPickaxe(blockName) {
  return blockName.endsWith('_ore')
}

function hasPickaxe(bot) {
  try {
    return countItems(bot, (n) => n.endsWith('_pickaxe')) > 0
  } catch (_) {
    return false
  }
}

function say(bot, line) {
  try { bot.chat(line) } catch (_) { /* chat best-effort, like goal.js */ }
}

function countDrop(bot, drop) {
  try {
    return countItems(bot, (n) => n === drop)
  } catch (_) {
    return 0
  }
}

// Drop a dead order goal without stop(): its latch would swallow the next
// setGoal issued on the same tick (same lesson as gather.js clearGoal).
function clearGoal(bot, ctx) {
  try {
    if (bot.pathfinder && bot.pathfinder.goal && typeof bot.pathfinder.setGoal === 'function') {
      bot.pathfinder.setGoal(null)
    }
  } catch (_) { /* body best-effort */ }
  ctx.lastGoalKey = ''
}

function refuse(bot, ctx, line) {
  say(bot, line)
  metrics.bring.inc({ outcome: 'refused' })
  ctx.bring = null
  clearGoal(bot, ctx)
}

function done(bot, ctx) {
  metrics.bring.inc({ outcome: 'done' })
  ctx.bring = null
  clearGoal(bot, ctx)
}

// Progress is horizontal displacement or a new standing level — the same
// rule as gather.js: tower jumps in place are standing still.
function progressed(bp, last, grounded) {
  if (!last) return true
  if (Math.hypot(bp.x - last.x, bp.z - last.z) > MOVE_TOLERANCE) return true
  return !!grounded && Math.floor(bp.y) !== Math.floor(last.y)
}

function atPos(bot) {
  const bp = bot.entity && bot.entity.position
  return bp ? `${Math.round(bp.x)} ${Math.round(bp.y)} ${Math.round(bp.z)}` : 'unknown'
}

function bring(bot, ctx, target, state) {
  const o = ctx.bring
  if (!o) return
  const bp = bot.entity && bot.entity.position
  if (!bp) return
  const grounded = !bot.entity || bot.entity.onGround !== false

  if (o.phase === 'find') {
    const res = findNearest(bot, o.name, FIND_RADIUS)
    if (res === 'unknown') {
      refuse(bot, ctx, `unknown block: ${o.name}`)
      return
    }
    if (!res) {
      refuse(bot, ctx, o.have > 0 ? `only got ${o.have} ${o.drop}` : `could not reach ${o.block || o.name}`)
      return
    }
    o.pos = res.position
    o.block = res.name
    o.drop = dropFor(res.name)
    if (needsPickaxe(res.name) && !hasPickaxe(bot)) {
      refuse(bot, ctx, `need a stone pickaxe for ${res.name}`)
      return
    }
    if (!o.announced) {
      o.announced = true
      say(bot, `going for ${o.want} ${res.name}, ${res.distance} blocks away`)
    }
    o.phase = 'walk'
    o.stalls = 0
    o.lastPos = null
    return
  }

  if (o.phase === 'walk') {
    const key = `bring:${o.pos.x},${o.pos.y},${o.pos.z}`
    if (key !== ctx.lastGoalKey) {
      bot.pathfinder.setGoal(new goals.GoalNear(o.pos.x, o.pos.y, o.pos.z, 2), false)
      ctx.lastGoalKey = key
      o.stalls = 0
      o.lastPos = { x: bp.x, y: bp.y, z: bp.z }
      return
    }
    let block = null
    try { block = bot.blockAt && bot.blockAt(o.pos) } catch (_) { block = null }
    if (!block || !block.name || block.name !== o.block) {
      o.pos = null // mined by someone else: search again
      o.phase = 'find'
      return
    }
    if (!bot.pathfinder.isMoving()) {
      let diggable = true
      try { diggable = typeof bot.canDigBlock === 'function' ? bot.canDigBlock(block) : true } catch (_) { diggable = false }
      if (diggable) o.phase = 'dig'
    }
    if (o.phase === 'walk') {
      if (progressed(bp, o.lastPos, grounded)) {
        o.stalls = 0
        o.lastPos = { x: bp.x, y: bp.y, z: bp.z }
      } else if (++o.stalls >= WALK_STALL_TICKS) {
        refuse(bot, ctx, `could not reach ${o.block}`)
      }
      return
    }
  }

  if (o.phase === 'dig') {
    // Exactly one dig at a time: while it is in flight, wait (gather.js rule).
    if (ctx.digInFlight) return
    if (typeof bot.dig !== 'function') {
      refuse(bot, ctx, `could not break ${o.block}`)
      return
    }
    let block = null
    try { block = bot.blockAt && bot.blockAt(o.pos) } catch (_) { block = null }
    if (!block || block.name !== o.block) {
      o.pos = null // vanished mid-order: search again
      o.phase = 'find'
      return
    }
    ctx.digInFlight = true
    void (async () => {
      try { await bot.dig(block) } catch (_) { /* gone or interrupted: pickup anyway */ }
      ctx.digInFlight = false
      o.phase = 'pickup'
    })()
    return
  }

  if (o.phase === 'pickup') {
    const key = `bring-pickup:${o.pos.x},${o.pos.y},${o.pos.z}`
    if (key !== ctx.lastGoalKey) {
      bot.pathfinder.setGoal(new goals.GoalBlock(o.pos.x, o.pos.y, o.pos.z), false)
      ctx.lastGoalKey = key
      return
    }
    // Reached or gave up getting there: the inventory count is the truth.
    o.have = countDrop(bot, o.drop)
    if (o.have >= o.want) {
      o.phase = 'return'
      o.saidWaiting = false
    } else {
      o.pos = null
      o.phase = 'find'
    }
    return
  }

  if (o.phase === 'return') {
    const p = bot.players && bot.players[o.by] && bot.players[o.by].entity
    if (!p || !p.position) {
      // 3a7 honesty: no coordinates for an out-of-range player — say where
      // the bot is and hold the drops until the player is back.
      if (!o.saidWaiting) {
        o.saidWaiting = true
        say(bot, `I can't see you — I'm at ${atPos(bot)} with your ${o.have} ${o.drop}; come closer`)
      }
      return
    }
    o.saidWaiting = false
    const pp = p.position
    const key = `bring-return:${Math.round(pp.x)},${Math.round(pp.y)},${Math.round(pp.z)}`
    if (key !== ctx.lastGoalKey) {
      bot.pathfinder.setGoal(new goals.GoalNear(pp.x, pp.y, pp.z, RETURN_RANGE), false)
      ctx.lastGoalKey = key
    }
    let d = null
    try { d = typeof bp.distanceTo === 'function' ? bp.distanceTo(pp) : Math.hypot(bp.x - pp.x, bp.y - pp.y, bp.z - pp.z) } catch (_) { d = null }
    if (d !== null && d <= RETURN_RANGE + 0.5) {
      if (o.tossInFlight) return
      let id = null
      try {
        const entry = bot.registry && bot.registry.itemsByName && bot.registry.itemsByName[o.drop]
        id = entry && entry.id
      } catch (_) { id = null }
      if (typeof id !== 'number' || typeof bot.toss !== 'function') {
        refuse(bot, ctx, `could not toss ${o.drop}`)
        return
      }
      const n = Math.min(o.have, o.want)
      o.tossInFlight = true
      void (async () => {
        try {
          await bot.toss(id, null, n)
          say(bot, `here are ${n} ${o.drop}`)
          done(bot, ctx)
        } catch (_) {
          refuse(bot, ctx, `could not toss ${o.drop}`)
        } finally {
          o.tossInFlight = false
        }
      })()
    }
  }
}

module.exports = bring
module.exports.dropFor = dropFor
module.exports.needsPickaxe = needsPickaxe
module.exports.hasPickaxe = hasPickaxe
module.exports.WANT_ORE = WANT_ORE
module.exports.WANT_LOGS = WANT_LOGS
module.exports.WANT_MAX = WANT_MAX
