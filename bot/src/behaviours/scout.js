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

// Scan helper, exported for the future 'find me <block>' chat command:
// block name -> nearest loaded position, or null when unknown or absent.
// That bead adds a caller, not a copy.
function findNearestBlock(bot, blockName, radius = 16) {
  const byName = (bot.registry && bot.registry.blocksByName) || {}
  const entry = byName[blockName]
  if (!entry || typeof entry.id !== 'number') return null
  let found = null
  try {
    found = bot.findBlocks({ matching: entry.id, maxDistance: radius, count: 16 })
  } catch {
    return null
  }
  if (!found || found.length === 0) return null
  const origin = bot.entity && bot.entity.position
  let best = found[0]
  if (origin) {
    for (const p of found) {
      if (dist(p, origin) < dist(best, origin)) best = p
    }
  }
  return best
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

module.exports = { makeScout, findNearestBlock, ORE_NAMES }
