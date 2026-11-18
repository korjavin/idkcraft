'use strict'

// noPath diagnostic (prod 2026-11-18: bot3 castle/castlefetch/gohome and
// bot4 enclosed/castlefetch/equip answer noPath hundreds of times an hour
// around complete castles). One line per goal per KEY_MS, at most one per
// GAP_MS overall, naming where the body stands and what the goal is, so the
// next prod hour shows why A* found nothing.
const Vec3 = require('vec3')
const KEY_MS = 60000
const GAP_MS = 5000

const seen = new WeakMap()
const i = (v) => Math.floor(v)
function goalOf(g) {
  if (!g) return null
  const xyz = [g.x, g.y, g.z].every(Number.isFinite) ? `${i(g.x)},${i(g.y)},${i(g.z)}`
    : [g.x, g.z].every(Number.isFinite) ? `${i(g.x)},?,${i(g.z)}` : '?'
  return { type: (g.constructor && g.constructor.name) || 'goal', xyz, x: g.x, y: g.y, z: g.z }
}

function line(bot, ctx) {
  const p = bot.entity && bot.entity.position
  if (!p) return null
  const g = goalOf(bot.pathfinder && bot.pathfinder.goal)
  const mov = bot.pathfinder && bot.pathfinder.movements
  const at = (x, y, z) => { try { const b = bot.blockAt(new Vec3(x, y, z)); return b ? b.name : 'unloaded' } catch (_) { return '?' } }
  const feet = at(i(p.x), i(p.y), i(p.z))
  let scaffold = 0
  try {
    const ids = new Set((mov && mov.scafoldingBlocks) || [])
    for (const it of bot.inventory.items() || []) if (ids.has(it.type)) scaffold += it.count
  } catch (_) { /* 0 */ }
  const dist = g && Number.isFinite(g.x) && Number.isFinite(g.z) ? Math.round(Math.hypot(g.x - p.x, (Number.isFinite(g.y) ? g.y : p.y) - p.y, g.z - p.z)) : '?'
  const goalBlock = g && [g.x, g.y, g.z].every(Number.isFinite) ? at(i(g.x), i(g.y), i(g.z)) : '?'
  const action = (ctx.lastDecision && ctx.lastDecision.action) || 'none'
  return `path noPath action=${action} step=${ctx.step || 'none'} from=${i(p.x)},${i(p.y)},${i(p.z)} goal=${g ? g.type + ' ' + g.xyz : 'none'} dist=${dist} inWater=${!!bot.entity.isInWater} feetBlock=${feet} goalBlock=${goalBlock} canDig=${mov ? mov.canDig !== false : '?'} scaffold=${scaffold} ownBreak=${ctx.ownBreakUntil > Date.now()}`
}

function noteNoPath(bot, ctx, now = Date.now()) {
  try {
    const s = seen.get(ctx) || { last: 0, keys: new Map() }
    seen.set(ctx, s)
    if (now - s.last < GAP_MS) return null
    const g = goalOf(bot.pathfinder && bot.pathfinder.goal)
    const key = `${(ctx.lastDecision && ctx.lastDecision.action) || ''}|${g ? g.xyz : 'none'}`
    if (now - (s.keys.get(key) || -Infinity) < KEY_MS) return null
    const out = line(bot, ctx)
    if (!out) return null
    s.last = now
    s.keys.set(key, now)
    if (s.keys.size > 64) s.keys.delete(s.keys.keys().next().value)
    console.log(out)
    return out
  } catch (_) { return null }
}

module.exports = { noteNoPath, KEY_MS, GAP_MS }
