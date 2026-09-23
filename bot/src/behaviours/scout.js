'use strict'

// Scout: pure perception + chat, no brain, no body cost. The bot already
// walks with the player, so every few seconds it looks at the loaded chunks
// around itself (mineflayer keeps them in memory — this sees through walls,
// including ore underground) and reports new veins in chat.
//
// Runs at the every-tick seam in index.js regardless of the brain decision,
// so it keeps working while the bot is following, fighting, or idle.

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

function baseName(name) {
  return name.startsWith('deepslate_') ? name.slice('deepslate_'.length) : name
}

// Report priority: index of the first ORE_NAMES entry that strips to the
// same base name, so deepslate variants share their base rank.
function rankOf(name) {
  const base = baseName(name)
  for (let i = 0; i < ORE_NAMES.length; i++) {
    if (baseName(ORE_NAMES[i]) === base) return i
  }
  return ORE_NAMES.length
}

function keyOf(p) {
  return `${p.x},${p.y},${p.z}`
}

function dist(a, b) {
  if (a && typeof a.distanceTo === 'function') return a.distanceTo(b)
  if (b && typeof b.distanceTo === 'function') return b.distanceTo(a)
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)
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
function resolveFindIds(bot, name) {
  if (name === 'ore') return resolveIds(bot, ORE_NAMES)
  let ids = resolveBlockIds(bot, name)
  if (ids.length === 0 && name.length > 1 && name.endsWith('s')) {
    ids = resolveBlockIds(bot, name.slice(0, -1))
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
      if (b && b.name === 'air') return true
    }
  } catch {
    return false
  }
  return false
}

// Scan helper, exported for the 'find me <block>' chat command:
// block name -> nearest loaded position; null when the name resolves but
// nothing is nearby; 'unknown' when the name matches no block at all so the
// caller can answer 'unknown block'.
// Ranking: exposed ore first (lead the player somewhere walkable, not into
// solid rock), then closest in height to refY (the requesting player's Y;
// the bot's own when unknown), then nearest by straight distance.
function findNearestBlock(bot, blockName, radius = 48, refY = null) {
  const ids = resolveFindIds(bot, blockName)
  if (ids.length === 0) return 'unknown'
  let found = null
  try {
    found = bot.findBlocks({ matching: ids, maxDistance: radius, count: 64 })
  } catch {
    return null
  }
  if (!found || found.length === 0) return null
  const origin = bot.entity && bot.entity.position
  const y0 = typeof refY === 'number' ? refY
    : (origin && typeof origin.y === 'number' ? origin.y : null)
  let best = found[0]
  let bestScore = scoreOf(found[0])
  for (const p of found) {
    const sc = scoreOf(p)
    if (compareScore(sc, bestScore) < 0) {
      best = p
      bestScore = sc
    }
  }
  return best

  function scoreOf(p) {
    const exposed = isExposed(bot, p) ? 0 : 1
    const dy = y0 != null && typeof p.y === 'number' ? Math.abs(p.y - y0) : 0
    const d = origin ? dist(p, origin) : 0
    return [exposed, dy, d]
  }
}

function compareScore(a, b) {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] - b[i]
  }
  return 0
}

function findNearest(bot, blockName, radius = 48, refY = null) {
  const p = findNearestBlock(bot, blockName, radius, refY)
  if (p === 'unknown') return 'unknown'
  if (!p) return null
  const origin = bot.entity && bot.entity.position
  const distance = origin ? Math.round(dist(p, origin)) : 0
  let name = blockName
  try {
    const block = bot.blockAt && bot.blockAt(p)
    if (block && block.name) name = block.name
  } catch {
    name = blockName
  }
  return { name, position: p, distance }
}

function makeScout(bot, { everyMs = 5000, radius = 16, say = bot.chat, now = () => Date.now(), maxSeen = 5000 } = {}) {
  const oreIds = resolveIds(bot, ORE_NAMES)
  const seen = new Set()
  let lastScan = 0

  function tick() {
    const t = now()
    if (t - lastScan < everyMs) return
    lastScan = t
    let found = []
    try {
      found = bot.findBlocks({ matching: oreIds, maxDistance: radius, count: 64 }) || []
    } catch {
      return
    }
    const fresh = new Map() // base ore name -> new positions
    for (const p of found) {
      const key = keyOf(p)
      if (seen.has(key)) continue
      seen.add(key)
      let name = null
      try {
        const block = bot.blockAt(p)
        name = block && block.name
      } catch {
        name = null
      }
      if (!name) continue
      const base = baseName(name)
      if (!fresh.has(base)) fresh.set(base, [])
      fresh.get(base).push(p)
    }
    // ponytail: bounded memory, LRU if it ever matters.
    if (seen.size > maxSeen) seen.clear()
    const names = [...fresh.keys()].sort((a, b) => rankOf(a) - rankOf(b)).slice(0, 3)
    const origin = bot.entity && bot.entity.position
    for (const name of names) {
      const spots = fresh.get(name)
      let nearest = spots[0]
      if (origin) {
        for (const p of spots) {
          if (dist(p, origin) < dist(nearest, origin)) nearest = p
        }
      }
      const line = `${name} x${spots.length} at ${nearest.x} ${nearest.y} ${nearest.z}`
      say.call(bot, line)
      console.log(`scout ${line}`)
    }
  }

  return { tick }
}

module.exports = { makeScout, findNearestBlock, findNearest, resolveBlockIds, resolveFindIds, isExposed, ORE_NAMES }
