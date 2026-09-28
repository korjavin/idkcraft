'use strict'

// Wool (idkcraft-did.3): 'bring me wool [N]' gathers sheep wool — the mob
// rung of the bring ladder (did epic), shared later with jr2.2 beds.
// The hunt itself rides the n7k prey phases in bring.js (find/walk/kill/
// pickup + search legs); this module holds only the wool-shaped data:
// request parsing, sheep metadata (sheared flag + color), and pack scans.
// No requires of bring.js (one-directional: bring requires wool).

const WANT_WOOL = 3

// Vanilla DyeColor order: the sheep metadata wool byte carries the color
// in the low nibble and the sheared flag in 0x10.
const WOOL_COLORS = [
  'white', 'orange', 'magenta', 'light_blue', 'yellow', 'lime', 'pink', 'gray',
  'light_gray', 'cyan', 'purple', 'blue', 'brown', 'green', 'red', 'black',
]

function isWoolName(name) {
  return typeof name === 'string' && (name === 'wool' || name.endsWith('_wool'))
}

// A resolved item family (or order carrying names) is pure wool when every
// name is a *_wool item — the mob rung of the bring ladder serves it.
function isWoolFamily(resolved) {
  return !!resolved && Array.isArray(resolved.names) && resolved.names.length > 0 &&
    resolved.names.every((n) => typeof n === 'string' && n.endsWith('_wool'))
}

// 'white_wool' -> 'white'; anything else -> null.
function dropColor(drop) {
  if (typeof drop !== 'string') return null
  const m = drop.match(/^([a-z_]+)_wool$/)
  return m && WOOL_COLORS.includes(m[1]) ? m[1] : null
}

// Chat/setBring name -> wool order seed, or null when it is not wool.
// Accepts the registry form ('white_wool') and the spaced form
// ('white wool'); plurals and fuzzy matches belong to did.1's resolver.
function parseWoolRequest(name) {
  const n = String(name || '').toLowerCase().trim().replace(/\s+/g, ' ')
  if (n === 'wool') return { color: null, name: 'wool', drop: null }
  const m = n.match(/^([a-z_]+)_wool$/) || n.match(/^([a-z ]+) wool$/)
  if (!m) return null
  const color = m[1].replace(/ /g, '_')
  if (!WOOL_COLORS.includes(color)) return null
  return { color, name: `${color}_wool`, drop: `${color}_wool` }
}

// Sheep wool byte from entity metadata: { sheared, color }, each null
// when unreadable (no metadata, or a registry without the layout —
// fail-open for the hunt, fail-closed for color orders at the caller).
// The index resolves through the registry (mineflayer's own pattern),
// so it tracks the version instead of hardcoding a slot.
function sheepWool(bot, e) {
  const none = { sheared: null, color: null }
  const md = e && e.metadata
  if (!md) return none
  let idx = -1
  try {
    const ent = bot && bot.registry && bot.registry.entitiesByName && bot.registry.entitiesByName.sheep
    if (ent && Array.isArray(ent.metadataKeys)) idx = ent.metadataKeys.indexOf('wool')
  } catch (_) {
    idx = -1
  }
  const v = idx >= 0 ? md[idx] : undefined
  if (typeof v !== 'number') return none
  return { sheared: (v & 0x10) !== 0, color: WOOL_COLORS[v & 0x0f] || null }
}

// First shears stack in the pack (for hand equip), or null.
function shearsInPack(bot) {
  try {
    const items = bot && bot.inventory && typeof bot.inventory.items === 'function' ? bot.inventory.items() : []
    if (Array.isArray(items)) {
      for (const i of items) {
        if (i && i.name === 'shears') return i
      }
    }
  } catch (_) { /* no inventory: no shears */ }
  return null
}

function hasShears(bot) {
  return !!shearsInPack(bot)
}

// First wool stack in the pack (findEdible shape): the exact color when
// set, else any *_wool. Null when the pack holds none.
function findWoolInPack(bot, color) {
  try {
    const items = bot && bot.inventory && typeof bot.inventory.items === 'function' ? bot.inventory.items() : []
    if (Array.isArray(items)) {
      for (const i of items) {
        if (!i || typeof i.name !== 'string') continue
        if (color ? i.name === `${color}_wool` : i.name.endsWith('_wool')) {
          return { name: i.name, count: typeof i.count === 'number' ? i.count : 1 }
        }
      }
    }
  } catch (_) { /* no inventory: hunt */ }
  return null
}

module.exports.WANT_WOOL = WANT_WOOL
module.exports.WOOL_COLORS = WOOL_COLORS
module.exports.isWoolName = isWoolName
module.exports.isWoolFamily = isWoolFamily
module.exports.dropColor = dropColor
module.exports.parseWoolRequest = parseWoolRequest
module.exports.sheepWool = sheepWool
module.exports.shearsInPack = shearsInPack
module.exports.hasShears = hasShears
module.exports.findWoolInPack = findWoolInPack
