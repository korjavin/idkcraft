'use strict'

// Shared harvest helpers (idkcraft-qfus): the pure, stateless half of
// sustainable harvest. The gather/bring harvest legs and the reforest
// plant tail all read the same predicates, so a stump, a plantable
// sapling and the deficit line mean the same thing everywhere. A leaf by
// design (oqul.14): only perception, never a behaviour — bringbase,
// gather, bring and reforest all require it without closing a cycle.

const { countItems } = require('../perception')

function isSaplingName(name) {
  return typeof name === 'string' && (name.endsWith('_sapling') || name === 'mangrove_propagule')
}

// Woody trunk names: the harvest legs fell these, so a dug one with solid
// non-wood below is a felled tree bottom. Stripped logs are owner-worked,
// never trees.
function isWoodyName(name) {
  return typeof name === 'string' &&
    ((name.endsWith('_log') && !name.startsWith('stripped_')) || name.endsWith('_stem') || name.endsWith('_hyphae'))
}

// First plantable pack sapling (lc55): banked drops ride the pack like any
// other stock, and a lone dark oak never grows (2x2 only) — planting it
// wastes the item, so it is never picked.
function firstSapling(bot) {
  try {
    const items = bot.inventory && typeof bot.inventory.items === 'function' ? bot.inventory.items() : null
    if (!Array.isArray(items)) return null
    return items.find((it) => it && isSaplingName(it.name) && it.name !== 'dark_oak_sapling') || null
  } catch (_) { return null }
}

// One honest line for a harvest leg that felled more than it replanted:
// out-of-saplings names the deficit, anything else names the bare stumps
// — never silent, never a spin. Null when whole (nothing felled, or every
// stump replanted), so terminal lines stay single when there is nothing
// to confess.
function harvestDeficitLine(bot, felled, replanted) {
  try {
    const f = felled | 0, r = replanted | 0
    if (f <= 0 || r >= f) return null
    if (!firstSapling(bot)) return `cut ${f}, replanted ${r} — out of saplings`
    const n = f - r
    return `cut ${f}, replanted ${r} — ${n} stump${n === 1 ? '' : 's'} left bare`
  } catch (_) { return null }
}

module.exports = { isSaplingName, isWoodyName, firstSapling, harvestDeficitLine }
