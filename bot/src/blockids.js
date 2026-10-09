'use strict'
// Block-name resolution and exposure, moved verbatim out of
// behaviours/scout.js (idkcraft-oqul.11): resources.js reads them without
// loading scout, which notes its finds into resources (the scout<->resources
// cycle). A leaf: no requires. scout.js re-exports the same names.

const ORE_NAMES = [
  'diamond_ore',
  'deepslate_diamond_ore',
  'emerald_ore',
  'deepslate_emerald_ore',
  'ancient_debris',
  'gold_ore',
  'deepslate_gold_ore',
  'iron_ore',
  'deepslate_iron_ore',
  'lapis_ore',
  'deepslate_lapis_ore',
  'redstone_ore',
  'deepslate_redstone_ore',
]

// ipn.14: coal goes to finds memory (gear's want-coal, forage) but never to
// chat. Its own findBlocks with a small count, so plentiful surface coal
// can neither crowd the valuable ores out of the ore scan's 64 nor flood
// the 256-cell memory.
// ponytail: memory is oldest-out (resources MAX_ITEMS); if coal still
// evicts iron in prod, a per-kind eviction priority is its own bead.
const COAL_NAMES = ['coal_ore', 'deepslate_coal_ore']
const COAL_COUNT = 16

function keyOf(p) {
  return `${p.x},${p.y},${p.z}`
}

function resolveIds(bot, names) {
  const byName = (bot.registry && bot.registry.blocksByName) || {}
  const ids = []
  for (const name of names) {
    const entry = byName[name]
    // Names missing from the registry are skipped, not fatal.
    if (entry && typeof entry.id === 'number') ids.push(entry.id)
  }
  return ids
}

// Name -> ore ids for the 'find me <block>' chat command: the exact
// name, plus every registry block containing <base>_ore (covers
// deepslate_* and nether_* variants). Registry names that are missing
// are skipped, not fatal.
function resolveBlockIds(bot, blockName) {
  const byName = (bot.registry && bot.registry.blocksByName) || {}
  const base = blockName.endsWith('_ore') ? blockName.slice(0, -'_ore'.length) : blockName
  const ids = []
  const exact = byName[blockName]
  if (exact && typeof exact.id === 'number') ids.push(exact.id)
  const pattern = `${base}_ore`
  for (const name of Object.keys(byName)) {
    if (name.includes(pattern)) {
      const entry = byName[name]
      if (entry && typeof entry.id === 'number' && !ids.includes(entry.id)) ids.push(entry.id)
    }
  }
  return ids
}

// 'find me' name resolution: 'ore' means any scout-listed ore, a trailing
// 's' falls back to the singular (diamonds -> diamond); everything else goes
// through resolveBlockIds (exact + <base>_ore variants). No fuzzy search:
// anything still unmatched resolves to no ids ('unknown' downstream).
// Dynamic *_log ids for 'bring me logs' (gather.js logIds, shared): exact
// names vary by wood type, so enumerate the registry like the matcher does.
function resolveLogIds(bot) {
  const byName = (bot.registry && bot.registry.blocksByName) || {}
  const ids = []
  for (const name of Object.keys(byName)) {
    if (!name.endsWith('_log')) continue
    const entry = byName[name]
    if (entry && typeof entry.id === 'number' && !ids.includes(entry.id)) ids.push(entry.id)
  }
  return ids
}

function resolveFindIds(bot, name) {
  if (name === 'ore' || name === 'ores') return resolveIds(bot, ORE_NAMES)
  if (name === 'log' || name === 'logs') return resolveLogIds(bot)
  let ids = resolveBlockIds(bot, name)
  if (ids.length === 0 && name.length > 1 && name.endsWith('s')) {
    const singular = name.slice(0, -1)
    ids = singular === 'ore' ? resolveIds(bot, ORE_NAMES) : resolveBlockIds(bot, singular)
  }
  return ids
}

// A position counts as exposed when a confirmed air block touches it on one
// of the six sides (visible from a cave or the surface). Unloaded (null) or
// unreadable does not count: only confirmed air.
function isExposed(bot, p) {
  if (!bot.blockAt) return false
  const offs = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]
  try {
    for (const [dx, dy, dz] of offs) {
      const q = (p && typeof p.offset === 'function')
        ? p.offset(dx, dy, dz)
        : { x: Math.floor(p.x) + dx, y: Math.floor(p.y) + dy, z: Math.floor(p.z) + dz }
      const b = bot.blockAt(q)
      if (b && (b.name === 'air' || b.name === 'cave_air')) return true
    }
  } catch {
    return false
  }
  return false
}

module.exports = { ORE_NAMES, COAL_NAMES, COAL_COUNT, keyOf, resolveIds, resolveBlockIds, resolveLogIds, resolveFindIds, isExposed }
