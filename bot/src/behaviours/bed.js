'use strict'

// Bed math (idkcraft-did.4), shared with jr2.2: a bed is 3 wool of ONE
// colour plus 3 planks of one wood, crafted at a table. Pure helpers over
// a plain {name: count} pack — no requires at all, so neither bring nor
// the house step can cycle through this module (wool.js keeps the live
// sheep/pack readers; this module owns the recipe shape and the colour
// rule: the colour with the most wool in stock wins, ties keep pack
// order).

const BED_WOOL = 3
const BED_PLANKS = 3

// Vanilla DyeColor order, copied from wool.js (no require: stay acyclic).
const BED_COLORS = [
  'white', 'orange', 'magenta', 'light_blue', 'yellow', 'lime', 'pink', 'gray',
  'light_gray', 'cyan', 'purple', 'blue', 'brown', 'green', 'red', 'black',
]

// Pack contents as a plain {name: count} map (craftany shape); unreadable
// reads as empty, so every caller builds the input identically.
function packCounts(bot) {
  const counts = {}
  try {
    const items = bot && bot.inventory && typeof bot.inventory.items === 'function' ? bot.inventory.items() : []
    if (Array.isArray(items)) {
      for (const i of items) {
        if (!i || typeof i.name !== 'string') continue
        counts[i.name] = (counts[i.name] || 0) + (i.count || 0)
      }
    }
  } catch (_) { /* unreadable inventory: empty plan */ }
  return counts
}

function isBedName(name) {
  return typeof name === 'string' && (name === 'bed' || name.endsWith('_bed'))
}

// A resolved item family (or order carrying names) is pure bed when every
// name is a *_bed item (wool.isWoolFamily shape).
function isBedFamily(resolved) {
  return !!resolved && Array.isArray(resolved.names) && resolved.names.length > 0 &&
    resolved.names.every((n) => typeof n === 'string' && n.endsWith('_bed'))
}

// 'white_bed' -> 'white'; anything else -> null (wool.dropColor shape).
function bedColor(name) {
  if (typeof name !== 'string') return null
  const m = name.match(/^([a-z_]+)_bed$/)
  return m && BED_COLORS.includes(m[1]) ? m[1] : null
}

// Best wool colour in stock: the colour with the highest count, first-max
// wins ties in pack order. Null when the pack holds no wool.
function pickBedColor(pack) {
  let best = null
  let bestCount = 0
  const p = (pack && typeof pack === 'object') ? pack : {}
  for (const [name, count] of Object.entries(p)) {
    if (typeof name !== 'string' || !name.endsWith('_wool')) continue
    const color = name.slice(0, -'_wool'.length)
    if (!BED_COLORS.includes(color)) continue
    const c = typeof count === 'number' ? count : 0
    if (c > bestCount) {
      bestCount = c
      best = color
    }
  }
  return best
}

// Wool and planks still missing for n beds of one colour (planks count any
// wood: every bed colour crafts from any wood). Logs are the caller's leg:
// did.4 opens a log sub-order for ceil(planks/4), jr2.2 chops its own.
function bedShortfall(pack, color, n) {
  const k = typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.floor(n) : 1
  const p = (pack && typeof pack === 'object') ? pack : {}
  const woolHave = (typeof color === 'string' && typeof p[`${color}_wool`] === 'number') ? p[`${color}_wool`] : 0
  let planksHave = 0
  for (const [name, count] of Object.entries(p)) {
    if (typeof name === 'string' && name.endsWith('_planks') && typeof count === 'number') planksHave += count
  }
  return {
    wool: Math.max(0, BED_WOOL * k - woolHave),
    planks: Math.max(0, BED_PLANKS * k - planksHave),
  }
}

function bedTarget(color) {
  return typeof color === 'string' && BED_COLORS.includes(color) ? `${color}_bed` : null
}

// Best finished bed in stock: the most numerous *_bed, first-max wins
// ties. Null when the pack holds no bed — both callers check this before
// gathering or re-crafting.
function bedInPack(pack) {
  let best = null
  let bestCount = 0
  const p = (pack && typeof pack === 'object') ? pack : {}
  for (const [name, count] of Object.entries(p)) {
    if (typeof name !== 'string' || !name.endsWith('_bed')) continue
    const c = typeof count === 'number' ? count : 0
    if (c > bestCount) {
      bestCount = c
      best = name
    }
  }
  return best
}

module.exports.BED_WOOL = BED_WOOL
module.exports.BED_PLANKS = BED_PLANKS
module.exports.BED_COLORS = BED_COLORS
module.exports.packCounts = packCounts
module.exports.isBedName = isBedName
module.exports.isBedFamily = isBedFamily
module.exports.bedColor = bedColor
module.exports.pickBedColor = pickBedColor
module.exports.bedShortfall = bedShortfall
module.exports.bedTarget = bedTarget
module.exports.bedInPack = bedInPack
