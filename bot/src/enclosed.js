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
const EPISODE_MS = 180000
const LAYERS = 8 // own-build cell pairs tunnelled per direction
const SKY = 24
const REACH = 4
const GRACE_MS = 300000 // recover digs share the own-build allowance this long
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

// Exit directions, best first: the first layer (both body cells) diggable or
// own build, solid floor under it (never a drop), no lava; fewest own cells,
// then pointing away from the castle centre. The tunnel walks each in turn.
function pickExits(bot, ctx, feet) {
  const site = ctx.castle && ctx.castle.site
  const out = []
  for (const [dx, dz] of DIRS) {
    const x = feet.x + dx, z = feet.z + dz
    const cells = [at(bot, x, feet.y, z), at(bot, x, feet.y + 1, z)]
    const v = cells.map((b) => breakable(bot, ctx, b))
    if (v.some((r) => r && r !== 'own') || !layerSafe(bot, x, feet.y, z, dx, dz)) continue
    const own = v.filter((r) => r === 'own').length
    if (!own && cells.every(air)) continue // already open: not the wall that traps us
    const away = site ? -((site.x - feet.x) * dx + (site.z - feet.z) * dz) : 0
    out.push({ dx, dz, score: own * 100 - away })
  }
  return out.sort((a, b) => a.score - b.score)
}
function pickExit(bot, ctx, feet) { return pickExits(bot, ctx, feet)[0] || null }
function layerSafe(bot, x, y, z, dx, dz) {
  const floor = at(bot, x, y - 1, z)
  if (!floor || floor.boundingBox !== 'block') return false
  return ![at(bot, x, y + 2, z), at(bot, x + dx, y, z + dz), at(bot, x + dx, y + 1, z + dz)].some((b) => b && /lava/.test(b.name))
}
// Outside: open sky over the body cells (the castle is roofed inside).
function outside(bot, x, y, z) {
  for (let dy = 2; dy <= SKY; dy++) if (!air(at(bot, x, y + dy, z))) return false
  return true
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
  const dirs = pickExits(bot, ctx, feet)
  if (!dirs.length) { log('enclosed escape refused: no own-build doorway'); s.coolUntil = now + WINDOW_MS; return false }
  ctx.enclosedUntil = Date.now() + GRACE_MS
  s.ep = { dirs, di: 0, k: 1, origin: feet, start: now, digging: false, cells: [] }
  return run(bot, ctx, s, feet, now)
}

function run(bot, ctx, s, feet, now) {
  const ep = s.ep
  const finish = (outcome) => {
    s.ep = null
    s.coolUntil = now + WINDOW_MS
    if (bot.pathfinder && ep.goal && bot.pathfinder.goal === ep.goal) bot.pathfinder.setGoal(null)
    log(`enclosed escape outcome=${outcome} cells=${ep.cells.map((c) => `${c.x},${c.y},${c.z}`).join(' ')}`)
    return false
  }
  const walk = (x, y, z) => {
    const g = bot.pathfinder && bot.pathfinder.goal
    if (g && g === ep.goal && g.x === x && g.y === y && g.z === z) return true
    if (bot.pathfinder) { ep.goal = new goals.GoalBlock(x, y, z); bot.pathfinder.setGoal(ep.goal) }
    return true
  }
  const nextDir = (why) => {
    log(`enclosed escape dir=${ep.dirs[ep.di].dx},${ep.dirs[ep.di].dz} stop=${why}`)
    ep.di++
    ep.k = 1
    ep.origin = feet
    // shortcut: no upward (roof dig + pillar) leg; recover's pillar_up/dig_up share the own-build allowance meanwhile.
    return ep.di < ep.dirs.length ? true : finish('refused:all-dirs')
  }
  if (now - ep.start > EPISODE_MS) return finish('timeout')
  if (ep.digging) return true
  if (ep.failed) { ep.failed = false; return nextDir('dig-error') }
  const d = ep.dirs[ep.di]
  if (ep.k > LAYERS) return nextDir('layers')
  const o = ep.origin
  const x = o.x + ep.k * d.dx, y = o.y, z = o.z + ep.k * d.dz
  if (!layerSafe(bot, x, y, z, d.dx, d.dz)) return nextDir('unsafe')
  const block = [at(bot, x, y, z), at(bot, x, y + 1, z)].find((b) => !air(b))
  if (!block) {
    if (!outside(bot, x, y, z)) { ep.k++; return true }
    if (feet.x === x && feet.y === y && feet.z === z) return finish('out')
    return walk(x, y, z)
  }
  const why = breakable(bot, ctx, block)
  if (why && why !== 'own') return nextDir('refused:' + why)
  const p = bot.entity.position
  if (Math.hypot(p.x - x - 0.5, p.z - z - 0.5) > REACH) return walk(x - d.dx, y, z - d.dz)
  ep.digging = true
  const c = block.position
  void (async () => {
    try {
      const tool = bot.pathfinder && bot.pathfinder.bestHarvestTool && bot.pathfinder.bestHarvestTool(block)
      if (tool) await bot.equip(tool, 'hand')
      await bot.dig(block)
      ep.cells.push(c)
      if (why === 'own') {
        (ctx.enclosedEscapes = ctx.enclosedEscapes || []).push({ x: c.x, y: c.y, z: c.z, name: block.name })
        log(`enclosed escape broke own ${block.name} at ${c.x},${c.y},${c.z} (re-lay)`)
        ctx.castleCursor = 0 // the castle scan re-lays the opened plan cell
        ctx.castleScanAt = 0
      }
    } catch (_) { ep.failed = true } finally { ep.digging = false }
  })()
  return true
}

module.exports = { tick, pickExit, pickExits, WINDOW_MS, DISTINCT, LAYERS }
