'use strict'

// Utility placement safety (owner 2026-11-18): a free-form (non-blueprint)
// crafting table, furnace or
// chest never lands on, beside (the walkway/standing cell) or on top of a
// bed or door, nor on top of a chest (the lid needs the cell above). One
// check for every utility spot scan; clearBlockers breaks one already
// standing there. Leaf: vec3 + pathfinder, util/residence deferred.

const Vec3 = require('vec3')
const { goals } = require('mineflayer-pathfinder')

const SIDES = [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]]
const keepClear = (n) => typeof n === 'string' && (n === 'bed' || n.endsWith('_bed') || n.endsWith('_door'))
const LIDDED = new Set(['chest', 'trapped_chest', 'barrel'])
const MOVABLE = new Set(['crafting_table', 'furnace']) // chests hold stock: never broken here

function nameAt(bot, x, y, z) {
  try { const b = bot.blockAt(new Vec3(x, y, z)); return b ? b.name : null } catch (_) { return null }
}

// True when a utility block at x,y,z would hem a bed or door in. A bed or
// door at the cell's level or one below (the stand cell's head) counts.
// Unreadable reads as clear.
function blocksAccess(bot, x, y, z) {
  try {
    if (!bot || typeof bot.blockAt !== 'function') return false
    for (const [dx, dz] of SIDES) {
      for (const dy of [0, -1]) if (keepClear(nameAt(bot, x + dx, y + dy, z + dz))) return true
    }
    return LIDDED.has(nameAt(bot, x, y - 1, z))
  } catch (_) {
    return false
  }
}

// The designed residence table/furnace cells are trusted (the blueprint
// keeps bedrooms and door clear); anything else hemming an anchor is moved.
function designedCell(ctx, x, y, z) {
  try {
    const home = ctx && ctx.home
    if (!home || !home.site) return true // no home to judge by: leave it
    const r = require('../residence').of(home)
    const t = r.table(home)
    if (t && t.x === x && t.y === y && t.z === z) return true
    return (r.furnace(home) || []).some((s) => home.site.x + s.dx === x && home.site.y + s.dy === y && home.site.z + s.dz === z)
  } catch (_) {
    return true
  }
}

// Break one table/furnace beside any anchor (bed ends, door): walk into
// reach, dig, and let the pack copy re-place elsewhere. True while it owns
// the tick (walking or digging).
function clearBlockers(bot, ctx, anchors) {
  try {
    if (ctx.unblockInFlight) return true
    const bp = bot.entity && bot.entity.position
    if (!bp || typeof bot.dig !== 'function') return false
    for (const a of anchors || []) {
      if (!a || typeof a.x !== 'number') continue
      for (const [dx, dz] of SIDES.slice(1)) {
        for (const dy of [0, 1]) {
          const x = a.x + dx
          const y = a.y + dy
          const z = a.z + dz
          let b = null
          try { b = bot.blockAt(new Vec3(x, y, z)) } catch (_) { b = null }
          // No canBreak: it protects every table/furnace; this is the one sanctioned move.
          if (!b || !MOVABLE.has(b.name) || designedCell(ctx, x, y, z)) continue
          if (Math.hypot(bp.x - (x + 0.5), bp.y - y, bp.z - (z + 0.5)) > 4) {
            require('./util').issueGoal(bot, ctx, new goals.GoalNear(x, y, z, 2), `unblock:${x},${y},${z}`, false)
            return true
          }
          ctx.unblockInFlight = true
          try { console.log(`placesafe: ${b.name} at ${x},${y},${z} blocks a bed/door, moving it`) } catch (_) { /* log best-effort */ }
          // Ghost claims (claimedTable, home.furnace) retract in tablespot/furnaceSpot.
          void Promise.resolve().then(() => bot.dig(b)).catch(() => {}).finally(() => { ctx.unblockInFlight = false })
          return true
        }
      }
    }
    return false
  } catch (_) {
    return false
  }
}

module.exports = { blocksAccess, clearBlockers }
