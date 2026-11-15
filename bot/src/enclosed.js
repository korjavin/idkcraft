'use strict'

// Enclosed escape (prod 2026-11-15 bot3: trapped inside its own castle for
// 2 h, every action path=noPath, recover dig_step failed:protected x54).
// Detect: noPath on >= DISTINCT targets within WINDOW_MS while the body has
// not moved. Escape: open ONE 1x2 doorway in the bot's OWN build (castle plan
// cell, own placement, house wall) at feet level, toward the outside, over a
// solid floor; never a container/bed/door, never anyone else's build.
// Cheapest first (prod 12:00 tore up 20 wall cells): climb onto a wall top
// when the sky is open (0 broken), else the fewest-own-cells doorway, with
// at most MAX_OWN own cells broken per escape. trapsSelf is the prevention
// the builders call before each placement. The
// castle scan re-lays the opened plan cells (cursor reset below), and the
// cells are kept on ctx.enclosedEscapes for the log/status.
const Vec3 = require('vec3')
const { goals } = require('mineflayer-pathfinder')
const castle = require('./castle')
const { denyReason, isOwnPlaced, inHouseFootprint, NATURAL_SOLID, CLEAR_FLORA } = require('./behaviours/util')
const { countItems } = require('./perception')

const WINDOW_MS = 60000
const DISTINCT = 3
const MOVED = 3
const EPISODE_MS = 180000
const LAYERS = 2 // own-build cell pairs tunnelled per direction
const MAX_OWN = 4 // own cells one escape may break, all directions together (prod 12:00: 20 torn up)
const UP_MAX = 6 // pillar height the up leg may climb
const TRAP_R = 8 // trapsSelf flood radius
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
// Natural terrain the work rules protect only for location (yard, apron,
// home zone): an enclosed body may dig it. Never a foreign build.
function natural(name) {
  return NATURAL_SOLID.has(name) || CLEAR_FLORA.has(name) || /(_ore|_leaves)$/.test(name)
}
// null = diggable for the escape; 'own' = own-build cell (budgeted, re-laid);
// 'nat' = protected-zone natural terrain; else a refusal.
function breakable(bot, ctx, b) {
  if (air(b)) return null
  if (!b || KEEP.test(b.name) || /lava|water/.test(b.name)) return 'keep'
  const d = denyReason(bot, b, ctx)
  if (!d) return null
  if (d !== 'protected') return d
  return ownBuild(ctx, b) ? 'own' : natural(b.name) ? 'nat' : d
}
const OK = (r) => !r || r === 'own' || r === 'nat'

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
    if (!v.every(OK) || !layerSafe(bot, x, feet.y, z, dx, dz)) continue
    const own = v.filter((r) => r === 'own').length
    const dig = cells.filter((b) => !air(b)).length
    if (!dig) continue // already open: not the wall that traps us
    const away = site ? -((site.x - feet.x) * dx + (site.z - feet.z) * dz) : 0
    out.push({ dx, dz, score: own * 100 + dig * 10 - away })
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

// Up leg: scaffold in the pack and a neighbour column (own wall or not)
// whose top is within UP_MAX: pillar to its top and step onto it, digging
// any breakable cell over the head on the way (a roof). Fewest digs, then
// lowest top; null when no column qualifies.
function planUp(bot, ctx, feet) {
  if (countItems(bot, (n) => n === 'dirt' || n === 'cobblestone') <= 0) return null
  const head = []
  for (let y = feet.y + 2; y <= feet.y + UP_MAX + 1; y++) {
    const b = at(bot, feet.x, y, feet.z)
    head.push(air(b) ? 0 : OK(breakable(bot, ctx, b)) ? 1 : Infinity)
  }
  const cost = (h) => head.slice(0, h - feet.y).reduce((a, n) => a + n, 0)
  let best = null
  for (const [dx, dz] of DIRS) {
    const x = feet.x + dx, z = feet.z + dz
    for (let h = feet.y + 1; h <= feet.y + UP_MAX; h++) {
      if (air(at(bot, x, h - 1, z))) break // a gap below the top: not a wall to stand on
      if (!air(at(bot, x, h, z)) || !air(at(bot, x, h + 1, z))) continue
      const c = cost(h)
      if (c < Infinity && (!best || c < best.c || (c === best.c && h < best.h))) best = { x, z, h, c }
      break
    }
  }
  return best
}

// Walkable stance with `solidAt` (a planned placement) counted as solid.
function stanceAt(bot, x, y, z, solidAt) {
  const isS = (yy) => solidAt && solidAt.x === x && solidAt.y === yy && solidAt.z === z
  if (isS(y) || isS(y + 1) || !air(at(bot, x, y, z)) || !air(at(bot, x, y + 1, z))) return false
  if (isS(y - 1)) return true
  const f = at(bot, x, y - 1, z)
  return !!f && f.boundingBox === 'block' && !/lava/.test(f.name)
}
// BFS over walkable stances within r of `from`; escaped = a stance past r.
function flood(bot, from, solidAt, r) {
  const seen = new Map()
  const q = [from]
  seen.set(`${from.x},${from.y},${from.z}`, from)
  for (let i = 0; i < q.length && i < 4000; i++) {
    const c = q[i]
    for (const [dx, dz] of DIRS) {
      for (const dy of [0, 1, -1]) {
        const n = { x: c.x + dx, y: c.y + dy, z: c.z + dz }
        const k = `${n.x},${n.y},${n.z}`
        if (seen.has(k)) continue
        if (dy === 1 && !stanceAt(bot, c.x, c.y + 1, c.z, solidAt)) continue // headroom for the step up
        if (!stanceAt(bot, n.x, n.y, n.z, solidAt)) continue
        if (Math.abs(n.x - from.x) > r || Math.abs(n.z - from.z) > r) return { escaped: true, seen, order: q }
        seen.set(k, n)
        q.push(n)
        break
      }
    }
  }
  return { escaped: false, seen, order: q }
}
// Prevention: would placing `cell` seal the bot's walkable pocket (it could
// walk out past TRAP_R before, not after)? Returns the nearest stance that
// stays outside the sealed pocket (move there first), {} when none, or null
// when the placement is safe. Any build plan.
function trapsSelf(bot, cell) {
  const p = bot && bot.entity && bot.entity.position
  if (!p || typeof bot.blockAt !== 'function') return null
  const feet = { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) }
  if (Math.abs(cell.x - feet.x) > TRAP_R || Math.abs(cell.z - feet.z) > TRAP_R) return null
  const before = flood(bot, feet, null, TRAP_R)
  if (!before.escaped) return null // already closed by design (roofed room): not this cell's doing
  const after = flood(bot, feet, cell, TRAP_R)
  if (after.escaped) return null
  for (const n of before.order) {
    if (!after.seen.has(`${n.x},${n.y},${n.z}`) && stanceAt(bot, n.x, n.y, n.z, cell)) return n
  }
  return {}
}

// Record noPath targets; true = the escape owns this tick.
function tick(bot, ctx, now = Date.now()) {
  if (!bot.entity || !bot.entity.position || typeof bot.blockAt !== 'function') return false
  const s = st(ctx)
  const p = bot.entity.position
  const feet = { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) }
  if (s.ep) return run(bot, ctx, s, feet, now)
  const moved = s.anchor && Math.hypot(p.x - s.anchor.x, p.z - s.anchor.z) + Math.abs(p.y - s.anchor.y) > MOVED
  if (moved) { s.seen.clear(); s.trapped = false }
  // Once detected here, a still-stuck body re-tries each cooldown instead of
  // leaving recover to shuffle (prod 2026-11-15: sidestep/wait no-progress for an hour).
  const again = s.trapped && ctx.stuck && now >= s.coolUntil
  if (!again) {
    if (ctx.lastPathStatus !== 'noPath') return false
    if (!s.seen.size) s.anchor = { x: p.x, y: p.y, z: p.z }
    s.seen.set(targetKey(bot, ctx), now)
    for (const [k, t] of s.seen) if (now - t > WINDOW_MS) s.seen.delete(k)
    if (s.seen.size < DISTINCT || now < s.coolUntil) return false
  }
  s.seen.clear()
  s.trapped = true
  ctx.enclosedUntil = Date.now() + GRACE_MS // recover: own-cell digs allowed, no sidestep shuffle
  log(`enclosed at ${feet.x},${feet.y},${feet.z}`)
  const dirs = pickExits(bot, ctx, feet)
  const up = planUp(bot, ctx, feet)
  if (!dirs.length && !up) { log('enclosed escape refused: no breakable doorway, no climb'); s.coolUntil = now + WINDOW_MS; return false }
  // Cheapest first: climb (0 broken), then the doorway with the fewest own cells.
  s.ep = { dirs, di: 0, k: 1, origin: feet, start: now, digging: false, cells: [], own: 0, up, rec: up ? { action: 'pillar_up', st: null } : null }
  return run(bot, ctx, s, feet, now)
}

function run(bot, ctx, s, feet, now) {
  const ep = s.ep
  const finish = (outcome) => {
    s.ep = null
    s.coolUntil = now + WINDOW_MS
    if (ep.rec && ctx.recovery === ep.rec) ctx.recovery = null
    if (bot.pathfinder && ep.goal && bot.pathfinder.goal === ep.goal) bot.pathfinder.setGoal(null)
    log(`enclosed escape mode=${ep.up ? 'up' : 'door'} broken=${ep.own} outcome=${outcome} cells=${ep.cells.map((c) => `${c.x},${c.y},${c.z}`).join(' ')}`)
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
    return ep.di < ep.dirs.length ? true : finish('refused:all-dirs')
  }
  if (now - ep.start > EPISODE_MS) return finish('timeout')
  if (ep.digging) return true
  if (ep.up) { if (ep.failed) { ep.failed = false; ep.up = null } else return runUp(bot, ctx, ep, feet, walk, finish) }
  if (ep.failed) { ep.failed = false; return nextDir('dig-error') }
  if (!ep.dirs.length) return finish('refused:no-door')
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
  if (!OK(why)) return nextDir('refused:' + why)
  if (why === 'own' && ep.own >= MAX_OWN) return finish('refused:budget')
  const p = bot.entity.position
  if (Math.hypot(p.x - x - 0.5, p.z - z - 0.5) > REACH) return walk(x - d.dx, y, z - d.dz)
  return dig(bot, ctx, ep, block, why)
}

function dig(bot, ctx, ep, block, why) {
  ep.digging = true
  const c = block.position
  void (async () => {
    try {
      const tool = bot.pathfinder && bot.pathfinder.bestHarvestTool && bot.pathfinder.bestHarvestTool(block)
      if (tool) await bot.equip(tool, 'hand')
      await bot.dig(block)
      ep.cells.push(c)
      if (why === 'own') {
        ep.own++
        ctx.enclosedEscapes = (ctx.enclosedEscapes || []).slice(-63)
        ctx.enclosedEscapes.push({ x: c.x, y: c.y, z: c.z, name: block.name })
        log(`enclosed escape broke own ${block.name} at ${c.x},${c.y},${c.z} (re-lay)`)
        ctx.castleCursor = 0 // the castle scan re-lays the opened plan cell
        ctx.castleScanAt = 0
      }
    } catch (_) { ep.failed = true } finally { ep.digging = false }
  })()
  return true
}

// Pillar to the chosen column top, then step onto it; any failure falls back
// to the doorway leg (ep.up = null).
function runUp(bot, ctx, ep, feet, walk, finish) {
  const u = ep.up
  const drop = (why) => {
    log(`enclosed escape up stop=${why}`)
    if (ctx.recovery === ep.rec) ctx.recovery = null
    ep.up = null
    ep.origin = feet
    return ep.dirs.length ? true : finish('refused:up-' + why)
  }
  if (feet.x === u.x && feet.z === u.z && feet.y >= u.h) return finish('out')
  if (feet.y >= u.h) return walk(u.x, u.h, u.z)
  const head = at(bot, feet.x, feet.y + 2, feet.z)
  if (!air(head)) {
    const why = breakable(bot, ctx, head)
    if (!OK(why)) return drop('head-' + why)
    if (why === 'own' && ep.own >= MAX_OWN) return drop('budget')
    return dig(bot, ctx, ep, head, why)
  }
  ctx.recovery = ep.rec
  const r = module.exports.pillar(bot, ctx)
  if (r === 'done') { ep.rec.st = null; return true }
  if (String(r).startsWith('failed')) return drop(r.slice(7))
  return true
}

module.exports = { tick, pickExit, pickExits, trapsSelf, WINDOW_MS, DISTINCT, LAYERS, MAX_OWN }
// Late require: recover pulls in much of the behaviour tree.
module.exports.pillar = (bot, ctx) => require('./behaviours/recover').pillarUpRun(bot, ctx)
