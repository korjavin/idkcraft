'use strict'
// Bring order ends and shared amounts, moved verbatim out of bring.js
// (idkcraft-oqul.11): bring.js and bringitem.js both read them, and
// bringitem no longer needs a deferred require back into bring (the
// bring<->bringitem cycle). Leaf: perception/metrics/util only.
// idkcraft-oqul.14: the pickaxe tiers, the block->drop map, the prey hunt
// and the progress rule moved here too — bringitem, deep and forage read
// them without an edge back into bring.js (the last require cycles). Leaf:
// perception/metrics/util/wool/stuck.

const { countItems } = require('../perception')
const metrics = require('../metrics')
const { say, clearGoal } = require('./util')
const woolMod = require('./wool')
const stuck = require('../stuck')

const WANT_ORE = 3
const WANT_MAX = 16

function countDrop(bot, drop) {
  try {
    return countItems(bot, (n) => n === drop)
  } catch (_) {
    return 0
  }
}

function bringKind(ctx) {
  return (ctx.bring && ctx.bring.kind) || 'block'
}

// A bring smelt (ipn.20) never outlives its order: the job drops and a
// settled outcome is consumed, so goal.js gearOutcome never translates it
// into gear's status (castlefetch finish() shape). Called from every end:
// refuse/done here, bring.clearSearchLeg for stop/park/new-owner cancels.
// ponytail: a window cycle still in flight settles after this unread.
function releaseSmelt(ctx) {
  const f = ctx && ctx.furnace
  if (!f || !f.bring) return
  ctx.furnaceJob = null
  f.bring = false
  if (f.settled) f.result = null
}

function refuse(bot, ctx, line) {
  // A failed sub-order (did.4) reads as the parent's honest line: the gap
  // that never filled, not the leg that failed it.
  const o = ctx && ctx.bring
  const sub = o && o.subFor && o.subWant && o.subWord
    ? `could not get ${o.subWant} ${o.subWord} for the ${o.subFor} in time`
    : null
  say(bot, sub || line)
  metrics.bring.inc({ outcome: 'refused', kind: bringKind(ctx) })
  ctx.bring = null
  releaseSmelt(ctx)
  clearGoal(bot, ctx)
}

function done(bot, ctx) {
  metrics.bring.inc({ outcome: 'done', kind: bringKind(ctx) })
  ctx.bring = null
  releaseSmelt(ctx)
  clearGoal(bot, ctx)
}

function dropFor(blockName) {
  if (blockName.endsWith('_log')) return blockName
  if (blockName === 'stone') return 'cobblestone' // ipn.20: the smelt rung's furnace stone sub
  const base = blockName.endsWith('_ore') ? blockName.slice(0, -'_ore'.length) : blockName
  const raw = base.match(/(iron|copper|gold)$/)
  if (raw) return `raw_${raw[1]}`
  if (base === 'lapis' || base.endsWith('_lapis')) return 'lapis_lazuli'
  return base // coal, diamond, emerald, redstone, quartz, dirt, ...
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
function bestPickRank(bot) {
  let best = -1
  try {
    const items = bot && bot.inventory && typeof bot.inventory.items === 'function' ? bot.inventory.items() : []
    for (const i of items) {
      const m = typeof i.name === 'string' && i.name.match(/^(wooden|golden|stone|iron|diamond|netherite)_pickaxe$/)
      if (m) best = Math.max(best, PICKAXE_RANK[m[1]])
    }
  } catch (_) { return -1 }
  return best
}
function hasPickaxe(bot, blockName) {
  const need = blockName && blockName.endsWith('_ore') ? (requiredTier(blockName) === 'iron' ? 2 : 1) : 0
  return bestPickRank(bot) >= need
}
function tierArticle(tier) {
  return tier === 'iron' ? 'an' : 'a'
}

// Honest tier refusal (idkcraft-x15): the legacy line names the required
// tier; when the bot HOLDS a weaker pickaxe it says so — prod refused 'need
// a stone pickaxe' with kit pickaxe=yes and read as a contradiction (the
// held one was wooden). No pickaxe at all keeps the bare line.
function tierRefusal(bot, blockName) {
  const tier = requiredTier(blockName)
  const base = `need ${tierArticle(tier)} ${tier} pickaxe for ${blockName}`
  let held = null
  try {
    const items = bot && bot.inventory && typeof bot.inventory.items === 'function' ? bot.inventory.items() : []
    let rank = -1
    for (const i of items) {
      const m = typeof i.name === 'string' && i.name.match(/^(wooden|golden|stone|iron|diamond|netherite)_pickaxe$/)
      if (m && PICKAXE_RANK[m[1]] > rank) { rank = PICKAXE_RANK[m[1]]; held = i.name }
    }
  } catch (_) { held = null }
  if (!held) return base
  return `${base} (my ${held} can't break it)`
}

// Food hunt prey (idkcraft-n7k): the order seed (isFoodRequest/findEdible)
// lives in bringitem.js with the other order-creation rungs; here is only
// what the shared prey phases read.
const PREY_NAMES = new Set(['cow', 'pig', 'sheep', 'chicken', 'rabbit'])
const PREY_DROPS = { cow: 'beef', pig: 'porkchop', sheep: 'mutton', chicken: 'chicken', rabbit: 'rabbit' }

function animalDist(bp, epos) {
  try {
    return typeof bp.distanceTo === 'function'
      ? bp.distanceTo(epos)
      : Math.hypot(bp.x - epos.x, bp.y - epos.y, bp.z - epos.z)
  } catch (_) { return null }
}

const FIND_RADIUS = 48

// Nearest passive animal within 48; when drop is set (second+ kill of one
// order) only animals dropping it, so one order tosses one food kind.
// opts (did.3 wool) narrows the hunt: { prey, skipSheared, color,
// skipIds, skipColors }. Without opts the food shape is byte-identical
// (forage.js relies on it). A color filter is strict — it only ever
// carries an explicitly ordered color, which is a promise (bare families
// pass none and hunt any sheep). skipIds (8gc stall skips) applies to
// every prey kind, sheep filters only to sheep.
function findAnimal(bot, drop, opts) {
  const bp = bot && bot.entity && bot.entity.position
  if (!bp) return null
  const o = opts && typeof opts === 'object' ? opts : null
  const prey = o && o.prey ? new Set(o.prey) : PREY_NAMES
  let best = null
  let bestDist = Infinity
  for (const e of Object.values(bot.entities || {})) {
    if (!e || !e.position || e.isValid === false) continue
    if (!prey.has(e.name)) continue
    if (drop && PREY_DROPS[e.name] !== drop) continue
    if (o && o.skipIds && typeof o.skipIds.has === 'function' && o.skipIds.has(e.id)) continue
    if (o && e.name === 'sheep') {
      const skipColors = o.skipColors && typeof o.skipColors.has === 'function' && o.skipColors.size ? o.skipColors : null
      if (o.skipSheared || o.color || skipColors) {
        const w = woolMod.sheepWool(bot, e)
        if (o.skipSheared && w.sheared) continue
        if (o.color && w.color !== o.color) continue
        // Dead colours (did.4 lock release): stranded, never hunted again
        // this sub-order. Unreadable metadata hunts fail-open.
        if (skipColors && w.color && skipColors.has(w.color)) continue
      }
    }
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

const MOVE_TOLERANCE = stuck.MOVE_TOLERANCE

// Progress is horizontal displacement or a new standing level — the same
// rule as gather.js: tower jumps in place are standing still.
function progressed(bp, last, grounded) {
  if (!last) return true
  if (Math.hypot(bp.x - last.x, bp.z - last.z) > MOVE_TOLERANCE) return true
  return !!grounded && Math.floor(bp.y) !== Math.floor(last.y)
}

module.exports = {
  WANT_ORE, WANT_MAX, countDrop, bringKind, refuse, done, releaseSmelt,
  dropFor, PICKAXE_RANK, requiredTier, bestPickRank, hasPickaxe, tierArticle, tierRefusal,
  PREY_NAMES, PREY_DROPS, animalDist, findAnimal, entityById, progressed,
}
