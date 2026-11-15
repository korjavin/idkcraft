'use strict'

// Enclosed escape (prod 2026-11-15 bot3: trapped inside its own castle for
// 2 h, every action path=noPath, recover dig_step failed:protected x54).
// Detect: noPath on >= DISTINCT targets within WINDOW_MS while the body has
// not moved. Escape: open ONE 1x2 doorway in the bot's OWN build (castle plan
// cell, own placement, house wall) at feet level, toward the outside, over a
// solid floor; never a container/bed/door, never anyone else's build. The
// castle scan re-lays the opened plan cells (cursor reset below), and the
// cells are kept on ctx.enclosedEscapes for the log/status.
const Vec3 = require('vec3')
const { goals } = require('mineflayer-pathfinder')
const castle = require('./castle')
const { denyReason, isOwnPlaced, inHouseFootprint } = require('./behaviours/util')

const WINDOW_MS = 60000
const DISTINCT = 3
const MOVED = 3
const EPISODE_MS = 30000
const KEEP = /(_bed|_door|chest|barrel|shulker_box|furnace|smoker|hopper|dispenser|dropper|_trapdoor|_gate|crafting_table)$/
const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]]
const sessions = new WeakMap()

function st(ctx) {
  let s = sessions.get(ctx)
  if (!s) { s = { seen: new Map(), anchor: null, ep: null, coolUntil: 0 }; sessions.set(ctx, s) }
  return s
}
function at(bot, x, y, z) { try { return bot.blockAt(new Vec3(x, y, z)) } catch (_) { return null } }
function air(b) { return !!b && b.boundingBox === 'empty' && !/water|lava/.test(b.name) }
function targetKey(bot, ctx) {
  const g = bot.pathfinder && bot.pathfinder.goal
  if (g && [g.x, g.y, g.z].every(Number.isFinite)) return `${Math.floor(g.x)},${Math.floor(g.y)},${Math.floor(g.z)}`
  return String((ctx.lastDecision && ctx.lastDecision.action) || ctx.step || 'none')
}

// Own build: a laid plan cell of our castle, our own placement, or our house box.
function ownBuild(ctx, b) {
  let props = null
  try { props = typeof b.getProperties === 'function' ? b.getProperties() : null } catch (_) { props = null }
  return (ctx.castle && castle.protects(ctx.castle, b.position, b.name, props)) || isOwnPlaced(ctx, b) ||
    inHouseFootprint(ctx.home, b.position) === true
}
// null = diggable for the escape; 'own' = own-build cell the escape may open; else a refusal.
function breakable(bot, ctx, b) {
  if (air(b)) return null
  if (!b || KEEP.test(b.name) || /lava|water/.test(b.name)) return 'keep'
  const d = denyReason(bot, b, ctx)
  if (!d) return null
  return d === 'protected' && ownBuild(ctx, b) ? 'own' : d
}

// Best doorway: both body cells breakable, solid floor under the opening and
// under the step beyond (never a drop), no lava around; fewest own cells
// broken first, then the direction pointing away from the castle centre.
function pickExit(bot, ctx, feet) {
  const site = ctx.castle && ctx.castle.site
  let best = null
  for (const [dx, dz] of DIRS) {
    const x = feet.x + dx, z = feet.z + dz
    const cells = [at(bot, x, feet.y, z), at(bot, x, feet.y + 1, z)]
    const v = cells.map((b) => breakable(bot, ctx, b))
    if (v.some((r) => r && r !== 'own')) continue
    const floor = at(bot, x, feet.y - 1, z)
    if (!floor || floor.boundingBox !== 'block') continue
    if ([at(bot, x, feet.y + 2, z), at(bot, x + dx, feet.y, z + dz), at(bot, x + dx, feet.y + 1, z + dz)].some((b) => b && /lava/.test(b.name))) continue
    const own = v.filter((r) => r === 'own').length
    if (!own && cells.every(air)) continue // already open: not the wall that traps us
    const out = site ? -((site.x - feet.x) * dx + (site.z - feet.z) * dz) : 0
    const score = own * 100 - out
    if (!best || score < best.score) best = { dx, dz, score, cells: cells.filter((b) => !air(b)).map((b) => b.position) }
  }
  return best
}

function log(m) { console.log(m) }

// Record noPath targets; true = the escape owns this tick.
function tick(bot, ctx, now = Date.now()) {
  if (!bot.entity || !bot.entity.position || typeof bot.blockAt !== 'function') return false
  const s = st(ctx)
  const p = bot.entity.position
  const feet = { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) }
  if (s.ep) return run(bot, ctx, s, feet, now)
  if (s.anchor && Math.hypot(p.x - s.anchor.x, p.z - s.anchor.z) + Math.abs(p.y - s.anchor.y) > MOVED) s.seen.clear()
  if (ctx.lastPathStatus !== 'noPath') return false
  if (!s.seen.size) s.anchor = { x: p.x, y: p.y, z: p.z }
  s.seen.set(targetKey(bot, ctx), now)
  for (const [k, t] of s.seen) if (now - t > WINDOW_MS) s.seen.delete(k)
  if (s.seen.size < DISTINCT || now < s.coolUntil) return false
  s.seen.clear()
  log(`enclosed at ${feet.x},${feet.y},${feet.z}`)
  const exit = pickExit(bot, ctx, feet)
  if (!exit) { log('enclosed escape refused: no own-build doorway'); s.coolUntil = now + WINDOW_MS; return false }
  s.ep = { exit, feet, start: now, digging: false }
  return run(bot, ctx, s, feet, now)
}

function run(bot, ctx, s, feet, now) {
  const ep = s.ep
  const finish = (outcome) => {
    s.ep = null
    s.coolUntil = now + WINDOW_MS
    if (bot.pathfinder && bot.pathfinder.goal === ep.goal) bot.pathfinder.setGoal(null)
    log(`enclosed escape outcome=${outcome} cells=${ep.exit.cells.map((c) => `${c.x},${c.y},${c.z}`).join(' ')}`)
    return false
  }
  if (now - ep.start > EPISODE_MS) return finish('timeout')
  if (ep.digging) return true
  const open = ep.exit.cells.find((c) => !air(at(bot, c.x, c.y, c.z)))
  if (open) {
    const b = at(bot, open.x, open.y, open.z)
    const why = breakable(bot, ctx, b)
    if (why && why !== 'own') return finish('refused:' + why)
    ep.digging = true
    void (async () => {
      try {
        const tool = bot.pathfinder && bot.pathfinder.bestHarvestTool && bot.pathfinder.bestHarvestTool(b)
        if (tool) await bot.equip(tool, 'hand')
        await bot.dig(b)
        if (why === 'own') {
          (ctx.enclosedEscapes = ctx.enclosedEscapes || []).push({ x: open.x, y: open.y, z: open.z, name: b.name })
          log(`enclosed escape broke own ${b.name} at ${open.x},${open.y},${open.z} (re-lay)`)
          ctx.castleCursor = 0 // the castle scan re-lays the opened plan cell
          ctx.castleScanAt = 0
        }
      } catch (_) { ep.failed = true } finally { ep.digging = false }
    })()
    return true
  }
  if (ep.failed) return finish('dig-error')
  if (feet.x !== ep.feet.x || feet.z !== ep.feet.z) return finish('out')
  if (!ep.goal && bot.pathfinder) {
    const o = ep.feet
    ep.goal = new goals.GoalBlock(o.x + 2 * ep.exit.dx, o.y, o.z + 2 * ep.exit.dz)
    bot.pathfinder.setGoal(ep.goal)
  }
  return true
}

module.exports = { tick, pickExit, WINDOW_MS, DISTINCT }
