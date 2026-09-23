'use strict'

const { goals } = require('mineflayer-pathfinder')
const { findNearest } = require('./scout')
const { countItems } = require('../perception')
const fightMod = require('./fight')
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
// plain refusal. Bring explicitly raises NO stuck facts: a stall refuses and
// ends the order instead of starting an episode (unlike follow/roam/lead,
// whose detectors feed the menu, and gather, which reports at its final).
// The ticker place_error/no-displacement backstops still catch a bring that
// loops without refusing, and release() resumes ctx.bring untouched.
const FIND_RADIUS = 48
const WANT_ORE = 3
const WANT_LOGS = 4
const WANT_FOOD = 3
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

// Only ores and logs are fetchable (the bead's resources): anything else
// (stone->cobble, grass->dirt, ...) drops a different item, so the drop
// count would never grow and the order would mine the area forever.
function isBringable(blockName) {
  return blockName.endsWith('_ore') || blockName.endsWith('_log')
}

function needsPickaxe(blockName) {
  return blockName.endsWith('_ore')
}

// Harvest tiers (vanilla): coal/iron/copper/lapis/quartz need stone or
// better; gold/diamond/redstone/emerald need iron or better. Wooden and
// golden are refused for everything. The refusal names the required tier.
const PICKAXE_RANK = { wooden: 0, golden: 0, stone: 1, iron: 2, diamond: 3, netherite: 4 }
function requiredTier(blockName) {
  const base = blockName.endsWith('_ore') ? blockName.slice(0, -'_ore'.length) : blockName
  if (/(gold|diamond|redstone|emerald)$/.test(base)) return 'iron'
  return 'stone'
}
function hasPickaxe(bot, blockName) {
  const need = blockName && blockName.endsWith('_ore') ? (requiredTier(blockName) === 'iron' ? 2 : 1) : 0
  let best = -1
  try {
    const items = bot && bot.inventory && typeof bot.inventory.items === 'function' ? bot.inventory.items() : []
    for (const i of items) {
      const m = typeof i.name === 'string' && i.name.match(/^(wooden|golden|stone|iron|diamond|netherite)_pickaxe$/)
      if (m) best = Math.max(best, PICKAXE_RANK[m[1]])
    }
  } catch (_) { return false }
  return best >= need
}
function tierArticle(tier) {
  return tier === 'iron' ? 'an' : 'a'
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

function bringKind(ctx) {
  return (ctx.bring && ctx.bring.kind) || 'block'
}

function refuse(bot, ctx, line) {
  say(bot, line)
  metrics.bring.inc({ outcome: 'refused', kind: bringKind(ctx) })
  ctx.bring = null
  clearGoal(bot, ctx)
}

function done(bot, ctx) {
  metrics.bring.inc({ outcome: 'done', kind: bringKind(ctx) })
  ctx.bring = null
  clearGoal(bot, ctx)
}

// Food (idkcraft-n7k): 'bring me food [N]' + 'meat' / 'something to eat'.
// Inventory first (any edible incl. raw meat), else hunt the nearest passive
// animal with the fight swing. No cooking, no rescue branches — refusals.
const FOOD_NAMES = new Set([
  'bread', 'baked_potato', 'apple', 'carrot',
  'cooked_beef', 'cooked_porkchop', 'cooked_chicken', 'cooked_mutton', 'cooked_rabbit',
  'beef', 'porkchop', 'mutton', 'chicken', 'rabbit',
])
const PREY_NAMES = new Set(['cow', 'pig', 'sheep', 'chicken', 'rabbit'])
const PREY_DROPS = { cow: 'beef', pig: 'porkchop', sheep: 'mutton', chicken: 'chicken', rabbit: 'rabbit' }

function isFoodRequest(name) {
  const n = String(name || '').toLowerCase().trim()
  return n === 'food' || n === 'meat' || n === 'something to eat'
}

function findEdible(bot) {
  try {
    const items = bot && bot.inventory && typeof bot.inventory.items === 'function' ? bot.inventory.items() : []
    if (Array.isArray(items)) {
      for (const i of items) {
        if (i && typeof i.name === 'string' && FOOD_NAMES.has(i.name)) {
          return { name: i.name, count: typeof i.count === 'number' ? i.count : 1 }
        }
      }
    }
  } catch (_) { /* no inventory: hunt */ }
  return null
}

function animalDist(bp, epos) {
  try {
    return typeof bp.distanceTo === 'function'
      ? bp.distanceTo(epos)
      : Math.hypot(bp.x - epos.x, bp.y - epos.y, bp.z - epos.z)
  } catch (_) { return null }
}

// Nearest passive animal within 48; when drop is set (second+ kill of one
// order) only animals dropping it, so one order tosses one food kind.
function findAnimal(bot, drop) {
  const bp = bot && bot.entity && bot.entity.position
  if (!bp) return null
  let best = null
  let bestDist = Infinity
  for (const e of Object.values(bot.entities || {})) {
    if (!e || !e.position || e.isValid === false) continue
    if (!PREY_NAMES.has(e.name)) continue
    if (drop && PREY_DROPS[e.name] !== drop) continue
    const d = animalDist(bp, e.position)
    if (typeof d !== 'number' || d > FIND_RADIUS) continue
    if (d < bestDist) { bestDist = d; best = e }
  }
  if (!best) return null
  return { name: best.name, id: best.id, position: best.position, distance: Math.round(bestDist) }
}

function entityById(bot, id) {
  for (const e of Object.values(bot.entities || {})) {
    if (e && e.id === id && e.isValid !== false && e.position) return e
  }
  return null
}

// Fence fact (n7k): log only — whether the prey stands near player fences
// is a future model choice, never a branch here.
function fenceFact(bot, animal) {
  try {
    const p = animal.position
    const around = [[0, -1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]]
    for (const [ox, oy, oz] of around) {
      const b = bot.blockAt && bot.blockAt({ x: Math.floor(p.x) + ox, y: Math.floor(p.y) + oy, z: Math.floor(p.z) + oz })
      if (b && typeof b.name === 'string' && b.name.endsWith('_fence')) {
        console.log(`hunt animal near fences: ${animal.name} at ${Math.round(p.x)} ${Math.round(p.y)} ${Math.round(p.z)}`)
        return
      }
    }
  } catch (_) { /* fact best-effort */ }
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

function findFood(bot, ctx, o) {
  const res = findAnimal(bot, o.drop || null)
  if (!res) {
    refuse(bot, ctx, o.have > 0 ? `only got ${o.have} ${o.drop}` : 'no animals within 48 blocks')
    return
  }
  o.animal = { name: res.name, id: res.id }
  o.pos = res.position
  o.drop = PREY_DROPS[res.name]
  o.lastPos = { x: res.position.x, y: res.position.y, z: res.position.z }
  fenceFact(bot, res)
  if (!o.announced) {
    o.announced = true
    say(bot, `going hunting: ${res.name} ${res.distance} blocks away`)
  }
  o.phase = 'walk'
  o.stalls = 0
  o.armedId = null
}

function walkFood(bot, ctx, o, bp, grounded) {
  const ent = o.animal ? entityById(bot, o.animal.id) : null
  if (!ent) { o.animal = null; o.phase = 'find'; return }
  o.pos = ent.position
  o.lastPos = { x: ent.position.x, y: ent.position.y, z: ent.position.z }
  const key = `bring-hunt:${Math.round(ent.position.x)},${Math.round(ent.position.y)},${Math.round(ent.position.z)}`
  const d = animalDist(bp, ent.position)
  if (d !== null && d <= fightMod.SWING_RANGE) { o.phase = 'kill'; return }
  if (key !== ctx.lastGoalKey) {
    bot.pathfinder.setGoal(new goals.GoalNear(ent.position.x, ent.position.y, ent.position.z, 2), false)
    ctx.lastGoalKey = key
  }
  // Stall accounting runs every tick, not just on a settled key: a
  // moving-but-unreachable animal (pen, water) re-keys constantly, and only
  // the bot's own displacement clears the counter — otherwise the body is
  // held forever, one block per tick.
  if (progressed(bp, o.lastBotPos, grounded)) {
    o.stalls = 0
    o.lastBotPos = { x: bp.x, y: bp.y, z: bp.z }
  } else if (++o.stalls >= WALK_STALL_TICKS) {
    refuse(bot, ctx, `could not reach ${o.animal.name}`)
  }
}

function killFood(bot, ctx, o, bp) {
  const ent = o.animal ? entityById(bot, o.animal.id) : null
  if (!ent) { // dead or gone: collect whatever dropped at the last spot
    o.dropPos = o.lastPos
    o.phase = 'pickup'
    return
  }
  o.lastPos = { x: ent.position.x, y: ent.position.y, z: ent.position.z }
  const d = animalDist(bp, ent.position)
  if (d === null || d > fightMod.SWING_RANGE) { o.phase = 'walk'; return }
  if (o.armedId !== ent.id) {
    o.armedId = ent.id
    try { fightMod.equipGear(bot) } catch (_) { /* fists are fine */ }
  }
  try { fightMod.swing(bot, ent) } catch (_) { /* mock bots may lack lookAt/attack */ }
}

function pickupFood(bot, ctx, o, bp, grounded) {
  const dp = o.dropPos
  if (!dp) { o.animal = null; o.phase = 'find'; return }
  const key = `bring-food-pickup:${Math.round(dp.x)},${Math.round(dp.y)},${Math.round(dp.z)}`
  if (key !== ctx.lastGoalKey) {
    bot.pathfinder.setGoal(new goals.GoalNear(dp.x, dp.y, dp.z, 1), false)
    ctx.lastGoalKey = key
    o.stalls = 0
    o.lastBotPos = { x: bp.x, y: bp.y, z: bp.z }
    return
  }
  const d = animalDist(bp, dp)
  if (d === null || d > 2) {
    if (progressed(bp, o.lastBotPos, grounded)) {
      o.stalls = 0
      o.lastBotPos = { x: bp.x, y: bp.y, z: bp.z }
    } else if (++o.stalls >= WALK_STALL_TICKS) {
      refuse(bot, ctx, `could not pick up ${o.drop}`)
    }
    return
  }
  // Walked over the drops: the inventory count is the truth.
  o.have = countDrop(bot, o.drop)
  if (o.have >= o.want) {
    o.phase = 'return'
    o.saidWaiting = false
  } else {
    o.animal = null
    o.phase = 'find'
  }
}

function bring(bot, ctx, target, state) {
  const o = ctx.bring
  if (!o) return
  const bp = bot.entity && bot.entity.position
  if (!bp) return
  const grounded = !bot.entity || bot.entity.onGround !== false
  const food = (o.kind || 'block') === 'food'

  if (o.phase === 'find') {
    if (food) { findFood(bot, ctx, o); return }
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
    if (needsPickaxe(res.name) && !hasPickaxe(bot, res.name)) {
      const tier = requiredTier(res.name)
      refuse(bot, ctx, `need ${tierArticle(tier)} ${tier} pickaxe for ${res.name}`)
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
    if (food) { walkFood(bot, ctx, o, bp, grounded); return }
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
      try {
        // Ore dug with the sword in hand drops nothing: hold the best
        // harvest tool first (guarded: fake bots may lack either method).
        let tool = null
        try { tool = bot.pathfinder && typeof bot.pathfinder.bestHarvestTool === 'function' ? bot.pathfinder.bestHarvestTool(block) : null } catch (_) { tool = null }
        if (tool && typeof bot.equip === 'function') await bot.equip(tool, 'hand')
        await bot.dig(block)
      } catch (_) { /* gone or interrupted: pickup anyway */ }
      ctx.digInFlight = false
      o.phase = 'pickup'
    })()
    return
  }

  if (o.phase === 'kill') {
    if (food) { killFood(bot, ctx, o, bp); return }
    refuse(bot, ctx, `could not bring ${o.block || o.name}`)
    return
  }

  if (o.phase === 'pickup') {
    if (food) { pickupFood(bot, ctx, o, bp, grounded); return }
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
module.exports.isBringable = isBringable
module.exports.requiredTier = requiredTier
module.exports.needsPickaxe = needsPickaxe
module.exports.hasPickaxe = hasPickaxe
module.exports.WANT_ORE = WANT_ORE
module.exports.WANT_LOGS = WANT_LOGS
module.exports.WANT_FOOD = WANT_FOOD
module.exports.WANT_MAX = WANT_MAX
module.exports.isFoodRequest = isFoodRequest
module.exports.findEdible = findEdible
module.exports.findAnimal = findAnimal
