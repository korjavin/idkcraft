'use strict'

// deep: staircase shaft to the diamond band, scan, short tunnel to the
// best remembered diamond cell, dig it, climb back. Sub-routine for the
// gear step (ipn.3 wires it); proven standalone via unit tests +
// test/deep-assay.js against throwaway Paper. Reports via ctx.stepStatus
// like every goal step; announces in chat (owner rule).
//
// One tick advances one phase step (gather/forage precedent): site ->
// descend -> scan -> plan -> tunnel -> digcell -> pickup -> return ->
// done. Breadcrumbs (every stair/tunnel arrival) live in ctx.deep for
// the guaranteed return.
//
// Safety rules (each unit + assay proven):
//   R-lava: every dig target + its 6 neighbours are lava-checked; lava
//     aborts honestly (failed:lava) and danger-marks the cell.
//   R-stand: the block underfoot is never dug (staircase geometry digs
//     forward/down/head only).
//   R-up: tunnel/descend never dig upward (falling gravel/sand, lava
//     above) — cells above the head are struck, not chased.
//   R-drop: every step-landing is drop-checked (<=1) before walking in;
//     deeper voids fail honestly (failed:drop) + danger-mark. 1 is the
//     reversibility limit: the return leg must climb every step back.
//   R-floor: nothing is dug at or below FLOOR_Y (-56, bedrock/lava margin).
//   R-tier: diamond digs need an iron pick (bring tier check); without one
//     the leg fails honestly (failed:need-iron-pick) — the gear step must
//     only send equipped bots (interface contract, asserted in assay).
// Return: breadcrumb reverse-walk, hybrid drive — manual body control
// (walk, jump straight out of a wedge) for 1-up stair steps, pathfinder
// for level tunnel crumbs (corners). Dead ends fail honestly
// (failed:lost-shaft) and raise the stuck fact for recover (explore
// precedent).

const { goals } = require('mineflayer-pathfinder')
const { Vec3 } = require('vec3')
const resources = require('../resources')
const danger = require('../danger')
const bring = require('./bring')
const recover = require('./recover')
const exploreMod = require('./explore')
const forageMod = require('./forage')
const deliverMod = require('./deliver')
const { say, clearGoal, botPos } = require('./util')

// Assay (throwaway Paper 26.1.2 natural, 2026-09-27, 1 column): diamonds
// y=+5..-65, density steep below -25, peak -40..-55. Target the band
// heart; the r=48 arrival scan covers the whole band from there.
const TARGET_Y = -45
const FLOOR_Y = -56
const TUNNEL_MAX = 12 // tunnel cells advanced before the cell is struck
const DEEP_WANT = 3 // diamond drops per leg, then return
const STALL_TICKS = 10
const RETURN_STALL = 15
const MOVE_TOLERANCE = 0.5
const DIG_REACH = 4 // settle radius for tunnel/dig targets
const DROP_MAX = 1 // deepest landing the bot walks into (a 1-drop climbs back; 2 is one-way and strands the return)
const SITE_RINGS = [3, 4, 5, 6, 7, 8] // mouth offsets from the anchor
const SITE_RAYS = 8
const DIRS = [{ dx: 1, dz: 0 }, { dx: -1, dz: 0 }, { dx: 0, dz: 1 }, { dx: 0, dz: -1 }]

function fname(bot, x, y, z) {
  try {
    const b = bot.blockAt && bot.blockAt(new Vec3(x, y, z))
    return (b && b.name) || null
  } catch (_) {
    return null
  }
}

function isAirName(n) {
  return n === 'air' || n === 'cave_air'
}

function isLavaName(n) {
  return typeof n === 'string' && n.includes('lava')
}

// Station blocks the shaft mouth must never eat (our own house).
function isStationName(n) {
  if (typeof n !== 'string') return false
  return n.endsWith('_planks') || n.endsWith('_door') || n === 'crafting_table' || n === 'chest' || n === 'furnace'
}

function isSolidName(n) {
  if (typeof n !== 'string' || !n) return false
  if (isAirName(n)) return false
  return !isLavaName(n) && n !== 'water'
}

// Water within manhattan 2 (live assay: carving/digging breaches adjacent
// aquifers and floods the shaft; water is undiggable so the leg must refuse
// it like lava). Same null-as-clear precedent.
function waterNear(bot, x, y, z) {
  for (let dx = -2; dx <= 2; dx++) {
    for (let dy = -2; dy <= 2; dy++) {
      for (let dz = -2; dz <= 2; dz++) {
        if (Math.abs(dx) + Math.abs(dy) + Math.abs(dz) > 2) continue
        if (fname(bot, x + dx, y + dy, z + dz) === 'water') return true
      }
    }
  }
  return false
}

// Falling blocks (gravel/sand) stacked above the target: digging under
// them refills the cell forever (live assay: 6-cycle dig-stuck) and can
// suffocate the bot. Refuse like lava/water.
function fallingAbove(bot, x, y, z) {
  for (const dy of [1, 2]) {
    const n = fname(bot, x, y + dy, z)
    if (n === 'gravel' || n === 'sand' || n === 'red_sand') return true
  }
  return false
}

// Lava within manhattan 2 of the target (live assay: a 1-cell check lets
// a pocket 2 out flow into the shaft mid-cycle and kill the bot). 25
// reads, chunk-cached. Unreadable (null) counts as clear (isExposed
// precedent: only confirmed blocks decide).
function lavaNear(bot, x, y, z) {
  for (let dx = -2; dx <= 2; dx++) {
    for (let dy = -2; dy <= 2; dy++) {
      for (let dz = -2; dz <= 2; dz++) {
        if (Math.abs(dx) + Math.abs(dy) + Math.abs(dz) > 2) continue
        if (isLavaName(fname(bot, x + dx, y + dy, z + dz))) return true
      }
    }
  }
  return false
}

// Air cells below (x, y, z) before solid ground, capped at 6. 0 = stands
// on solid. Unreadable below reads as solid (chunk edge, not a void).
function dropBelow(bot, x, y, z) {
  for (let d = 0; d < 6; d++) {
    const n = fname(bot, x, y - 1 - d, z)
    if (n === null) return d
    if (isSolidName(n)) return d
    if (isLavaName(n)) return d // lava floor: the drop count stands, lavaNear owns the refusal
  }
  return 6
}

// Mouth candidates: solid natural ground, 2 air above, no lava, not
// danger-marked, not our own station. Returns {x, z, topY} or null.
function pickSite(bot, ctx, anchor) {
  if (!anchor || typeof anchor.x !== 'number' || typeof anchor.z !== 'number') return null
  const bp = botPos(bot)
  const startY = bp && typeof bp.y === 'number' ? Math.floor(bp.y) + 2 : 70
  for (const r of SITE_RINGS) {
    for (let a = 0; a < SITE_RAYS; a++) {
      const x = Math.round(anchor.x + r * Math.sin(a * Math.PI / 4))
      const z = Math.round(anchor.z - r * Math.cos(a * Math.PI / 4))
      try {
        if (danger.near(ctx, { x, z })) continue
      } catch (_) { /* danger best-effort */ }
      for (let y = startY; y > startY - 12; y--) {
        const g = fname(bot, x, y - 1, z)
        const f = fname(bot, x, y, z)
        const h = fname(bot, x, y + 1, z)
        if (!isSolidName(g) || isStationName(g)) continue
        if (f === null || h === null) continue
        if (!isAirName(f) || !isAirName(h)) continue
        if (lavaNear(bot, x, y, z)) continue
        return { x, z, topY: y }
      }
    }
  }
  return null
}

// Stair step n (0-based): stand cell S, then the 3 dig cells (feet, head,
// down-last so footing reads stay stable mid-cycle).
function stairCells(shaft, n) {
  const sx = shaft.x + n * shaft.dx
  const sz = shaft.z + n * shaft.dz
  const sy = shaft.topY - n
  const nx = sx + shaft.dx
  const nz = sz + shaft.dz
  const ny = sy - 1
  return {
    stand: { x: nx, y: ny, z: nz },
    digs: [
      { x: nx, y: sy, z: nz },
      { x: nx, y: sy + 1, z: nz },
      { x: nx, y: ny, z: nz },
    ],
  }
}

// First shaft direction whose whole tube is lava-free and whose step-0
// cells are diggable. Pure geometry + reads; null when every direction is
// refused. The tube scan is best-effort (deep chunks may not be loaded
// yet — null reads as clear) with the per-tick guards as backstop.
function pickDir(bot, mouth) {
  for (const d of DIRS) {
    const shaft = { x: mouth.x, z: mouth.z, topY: mouth.topY, dx: d.dx, dz: d.dz }
    if (!tubeClean(bot, shaft)) continue
    const st = stairCells(shaft, 0)
    let ok = true
    for (const c of st.digs) {
      if (c.y <= FLOOR_Y) { ok = false; break }
      const n = fname(bot, c.x, c.y, c.z)
      if (n === null || isAirName(n)) continue
      if (!canDig(bot, c)) { ok = false; break }
    }
    if (ok) return shaft
  }
  return null
}

// Every stair step down to the band: dig cells + landing + one below
// must be lava-free (radius 2) and above the floor.
function tubeClean(bot, shaft) {
  for (let n = 0; shaft.topY - n > TARGET_Y && shaft.topY - n > FLOOR_Y + 2; n++) {
    const st = stairCells(shaft, n)
    const cells = [...st.digs, st.stand, { x: st.stand.x, y: st.stand.y - 1, z: st.stand.z }]
    for (const c of cells) {
      if (c.y <= FLOOR_Y) return false
      if (lavaNear(bot, c.x, c.y, c.z)) return false
      if (waterNear(bot, c.x, c.y, c.z)) return false
      if (fallingAbove(bot, c.x, c.y, c.z)) return false
    }
  }
  return true
}

// Greedy tunnel head step toward the target: 6-neighbours minus cameFrom,
// minus visited (seen), minus up (R-up), minus floor. Same-Y first, then
// down — ties keep the closest. Null when boxed in. The visited set is
// the loop breaker: cameFrom alone ping-pongs in U-caves (live assay).
function tunnelNext(head, target, cameFrom, seen) {
  if (!head || !target) return null
  const offs = [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, -1, 0], [0, 1, 0]]
  let best = null
  let bestD = Infinity
  let bestFlat = -1
  for (const [dx, dy, dz] of offs) {
    if (dy > 0) continue // R-up
    const c = { x: head.x + dx, y: head.y + dy, z: head.z + dz }
    if (c.y <= FLOOR_Y) continue
    if (cameFrom && c.x === cameFrom.x && c.y === cameFrom.y && c.z === cameFrom.z) continue
    if (seen && typeof seen.has === 'function' && seen.has(`${c.x},${c.y},${c.z}`)) continue
    const d = Math.hypot(c.x - target.x, c.y - target.y, c.z - target.z)
    const flat = dy === 0 ? 1 : 0
    if (d < bestD - 1e-9 || (Math.abs(d - bestD) <= 1e-9 && flat > bestFlat)) {
      bestD = d
      bestFlat = flat
      best = c
    }
  }
  return best
}

// Diggable by the real canDigBlock on a real block (never a {name}
// stub: the live check reads block fields). Unreadable counts diggable
// here — digOne re-reads before swinging.
function canDig(bot, c) {
  try {
    if (typeof bot.canDigBlock !== 'function') return true
    const b = bot.blockAt && bot.blockAt(new Vec3(c.x, c.y, c.z))
    if (!b) return true
    return !!bot.canDigBlock(b)
  } catch (_) {
    return false
  }
}

// Nearest breadcrumb distance: death/preemption displacement check. Past
// RESUME_RANGE the leg is abandoned (a fresh leg is cheaper than the walk
// back); inside it the phase walks back and resumes.
const RESUME_RANGE = 64
function nearestCrumb(d, bp) {
  let best = null
  let bestD = Infinity
  for (const s of (d.steps || [])) {
    const dd = Math.hypot(bp.x - s.x, bp.y - s.y, bp.z - s.z)
    if (dd < bestD) { bestD = dd; best = s }
  }
  return best ? { at: best, dist: bestD } : null
}

// Shaft mouth point for danger marks. Descend-phase hazard fails mark it
// alongside the hazard cell: pickSite's spiral is deterministic, so without
// the mouth mark every retry would re-dig the same bad shaft forever.
function mouthOf(d) {
  return d && d.shaft ? { x: d.shaft.x, y: d.shaft.topY, z: d.shaft.z } : null
}

function dist3(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)
}

function finish(bot, ctx, d, ok, reason, n) {
  const gains = {}
  try {
    const have = bring.countDrop(bot, 'diamond')
    const g = have - ((d.startDrops && d.startDrops.diamond) || 0)
    if (g > 0) gains.diamond = g
  } catch (_) { /* no gains */ }
  let banked = 0
  try {
    if (gains.diamond > 0) {
      deliverMod.addHaul(ctx, gains)
      banked = gains.diamond
    }
  } catch (_) { /* haul best-effort */ }
  ctx.deep = null
  clearGoal(bot, ctx)
  try { bot.clearControlStates && bot.clearControlStates() } catch (_) { /* release manual drive keys */ }
  const sh = d.shaft ? ` shaft=${d.shaft.x},${d.shaft.topY},${d.shaft.z}` : ''
  if (ok || banked > 0) {
    ctx.stepStatus = 'done'
    console.log(`deep done: banked ${banked} diamond${ok ? '' : ` (${reason})`}${sh}`)
    say(bot, banked > 0 ? `back with ${banked} diamond${banked === 1 ? '' : 's'}` : 'back from the depths')
  } else {
    ctx.stepStatus = `failed:${reason || 'unknown'}`
    console.log(`deep failed:${reason || 'unknown'} dug=${n || 0}${sh}`)
  }
}

function fail(bot, ctx, d, reason, markP, chatLine) {
  try {
    const marks = Array.isArray(markP) ? markP : [markP]
    for (const m of marks) if (m) danger.mark(ctx, m)
  } catch (_) { /* mark best-effort */ }
  if (chatLine) say(bot, chatLine)
  finish(bot, ctx, d, false, reason, d.dug)
}

// One walk goal with the 68p rule (body-theft re-issue keeps the stall
// budget) and displacement stall counting. Returns 'arrived' | 'walking'
// | 'stalled'. arrivalR/distR tune per leg.
function walkTo(bot, ctx, d, key, goal, arrival) {
  const bp = botPos(bot)
  if (!bp) return 'walking'
  if (key !== ctx.lastGoalKey) {
    bot.pathfinder.setGoal(goal, false)
    const prevKey = ctx.lastGoalKey
    ctx.lastGoalKey = key
    if (key !== d.issuedKey || prevKey === '' || prevKey === 'idle') {
      d.issuedKey = key
      d.stalls = 0
      d.lastPos = { x: bp.x, y: bp.y, z: bp.z }
      return 'walking'
    }
  }
  if (arrival(bp)) return 'arrived'
  const grounded = !bot.entity || bot.entity.onGround !== false
  if (bring.progressed(bp, d.lastPos, grounded)) {
    d.stalls = 0
    d.lastPos = { x: bp.x, y: bp.y, z: bp.z }
  } else if (++d.stalls >= (d.stallBudget || STALL_TICKS)) {
    return 'stalled'
  }
  return 'walking'
}

// Single dig with the forage shape: best tool, one in flight, then phase.
// Attempt watchdog: attempts only count completed dig cycles (digInFlight
// serialises), so 6 cycles on a still-solid cell means the server refuses
// or updates are lost — fail honestly instead of idling forever (live
// assay: a stuck dig with no watchdog burned a 12-minute leg).
const DIG_TRIES_MAX = 6
function digOne(bot, ctx, d, cell, name, nextPhase) {
  if (ctx.digInFlight) return
  // Forage shape: never launch a dig while the pathfinder is moving — the
  // residual motion aborts the dig and the error looks like refused rock.
  // Arrivals stop on their own; an unreachable residual goal gets released
  // after 3s so a digging phase can never hang behind it.
  if (bot.pathfinder && bot.pathfinder.isMoving()) {
    d.digWaitTicks = (d.digWaitTicks || 0) + 1
    if (d.digWaitTicks > 12) {
      try { bot.pathfinder.setGoal(null) } catch (_) { /* optional */ }
      try { bot.clearControlStates && bot.clearControlStates() } catch (_) { /* optional */ }
      d.digWaitTicks = 0
    }
    return
  }
  d.digWaitTicks = 0
  if (typeof bot.dig !== 'function') {
    fail(bot, ctx, d, 'no-dig', null, null)
    return
  }
  const key = `${cell.x},${cell.y},${cell.z}`
  if (d.digCellKey === key) {
    d.digTries = (d.digTries || 0) + 1
    if (d.digTries > DIG_TRIES_MAX) {
      console.log(`deep dig-stuck at ${cell.x},${cell.y},${cell.z} (${name})`)
      fail(bot, ctx, d, 'dig-stuck', cell, 'this rock will not break, backing out')
      return
    }
  } else {
    d.digCellKey = key
    d.digTries = 1
  }
  let block = null
  try {
    block = bot.blockAt && bot.blockAt(new Vec3(cell.x, cell.y, cell.z))
  } catch (_) { block = null }
  if (!block) {
    fail(bot, ctx, d, 'unloaded', null, null)
    return
  }
  ctx.digInFlight = true
  d.digSince = Date.now()
  void (async () => {
    try {
      let tool = null
      try { tool = bot.pathfinder && typeof bot.pathfinder.bestHarvestTool === 'function' ? bot.pathfinder.bestHarvestTool(block) : null } catch (_) { tool = null }
      if (tool && typeof bot.equip === 'function') await bot.equip(tool, 'hand')
      await bot.dig(block)
    } catch (e) {
      // Gone or interrupted: re-read below. Log the first error per cell —
      // a rejecting dig must never be silent (live assay: residual motion
      // aborted digs and the watchdog blamed the rock).
      if (d.digErrLogged !== key) {
        d.digErrLogged = key
        console.log(`deep dig error at ${key}: ${e && e.message ? e.message : e}`)
      }
    }
    ctx.digInFlight = false
    if (ctx.deep === d) d.phase = nextPhase
  })()
}

function deep(bot, ctx, target, state) {
  if (!ctx.deep) {
    ctx.deep = { phase: 'site', shaft: null, n: 0, steps: [], target: null, dug: 0, stalls: 0, lastPos: null, issuedKey: null, startDrops: null, cameFrom: null }
  }
  const d = ctx.deep
  const bp = botPos(bot)
  if (!bp) return
  // Hung-dig watchdog: a dig cycle that never settles (stuck equip, lost
  // update) must fail, not idle — 120s wall clock, ~8x the slowest legit
  // dig (deepslate on a stone pick).
  if (ctx.digInFlight && d.digSince && Date.now() - d.digSince > 120000) {
    ctx.digInFlight = false
    fail(bot, ctx, d, 'dig-stuck', null, 'the dig never finished, backing out')
    return
  }
  if (!d.startDrops) {
    let d0 = 0
    try { d0 = bring.countDrop(bot, 'diamond') } catch (_) { d0 = 0 }
    d.startDrops = { diamond: d0 }
  }

  if (d.phase === 'site') {
    let anchor = null
    try { anchor = exploreMod.anchorOf(bot, ctx) } catch (_) { anchor = null }
    if (!anchor) {
      fail(bot, ctx, d, 'no-anchor', null, null)
      return
    }
    const mouth = pickSite(bot, ctx, anchor)
    if (!mouth) {
      fail(bot, ctx, d, 'no-site', null, 'no safe ground for the shaft')
      return
    }
    const shaft = pickDir(bot, mouth)
    if (!shaft) {
      fail(bot, ctx, d, 'no-dir', mouth, 'no safe way down here')
      return
    }
    d.shaft = shaft
    d.n = 0
    d.steps = [{ x: mouth.x, y: mouth.topY, z: mouth.z }]
    d.phase = 'descend'
    say(bot, `digging down for diamonds at ${mouth.x} ${mouth.z}`)
    return
  }

  if (d.phase === 'descend') {
    const lost = lostCheck(bot, ctx, d, bp)
    if (lost) return
    // Lava approaching the BODY (pockets breach from any side, not just
    // the dig cells): fail fast while the return path is still walkable.
    if (lavaNear(bot, Math.floor(bp.x), Math.floor(bp.y), Math.floor(bp.z))) {
      const here = { x: Math.floor(bp.x), y: Math.floor(bp.y), z: Math.floor(bp.z) }
      fail(bot, ctx, d, 'lava', [here, mouthOf(d)], 'lava closing in, backing out')
      return
    }
    if (Math.floor(bp.y) <= TARGET_Y) {
      d.phase = 'scan'
      say(bot, `at the diamond band (y ${Math.floor(bp.y)}), scanning`)
      return
    }
    const st = stairCells(d.shaft, d.n)
    for (const c of st.digs) {
      if (c.y <= FLOOR_Y) {
        fail(bot, ctx, d, 'floor', c, 'hit the dig floor, backing out')
        return
      }
      const n = fname(bot, c.x, c.y, c.z)
      if (n === null || isAirName(n)) continue
      if (lavaNear(bot, c.x, c.y, c.z)) {
        fail(bot, ctx, d, 'lava', [c, mouthOf(d)], 'lava in the shaft, backing out')
        return
      }
      if (fallingAbove(bot, c.x, c.y, c.z)) {
        fail(bot, ctx, d, 'loose', [c, mouthOf(d)], 'loose rock above, backing out')
        return
      }
      if (fname(bot, c.x, c.y, c.z) === 'water' || waterNear(bot, c.x, c.y, c.z)) {
        fail(bot, ctx, d, 'water', [c, mouthOf(d)], 'water in the shaft, backing out')
        return
      }
      if (!canDig(bot, c)) {
        fail(bot, ctx, d, 'bedrock', [c, mouthOf(d)], 'unbreakable rock in the shaft')
        return
      }
      digOne(bot, ctx, d, c, n, 'descend')
      return
    }
    // All three open: landing check, then walk the step.
    if (dropBelow(bot, st.stand.x, st.stand.y, st.stand.z) > DROP_MAX) {
      fail(bot, ctx, d, 'drop', [st.stand, mouthOf(d)], 'void under the next step, backing out')
      return
    }
    const key = `deep-descend:${d.n}`
    const r = walkTo(bot, ctx, d, key, new goals.GoalNear(st.stand.x, st.stand.y, st.stand.z, 1), (p) => dist3(p, st.stand) <= 1.6)
    if (r === 'arrived') {
      d.steps.push({ x: st.stand.x, y: st.stand.y, z: st.stand.z })
      d.n++
    } else if (r === 'stalled') {
      try { recover.setStuck(ctx, 'deep', st.stand, key) } catch (_) { /* stuck best-effort */ }
      fail(bot, ctx, d, 'shaft-stuck', st.stand, 'stuck in the shaft')
    }
    return
  }

  if (d.phase === 'scan') {
    let added = 0
    try {
      const r = resources.scan(bot, ctx)
      added = (r && r.added) || 0
    } catch (_) { /* scan best-effort */ }
    console.log(`deep scan at y ${Math.floor(bp.y)}: +${added} memory cells`)
    d.phase = 'plan'
    return
  }

  if (d.phase === 'plan') {
    let have = 0
    try { have = bring.countDrop(bot, 'diamond') - ((d.startDrops && d.startDrops.diamond) || 0) } catch (_) { have = 0 }
    if (have >= DEEP_WANT) {
      d.phase = 'return'
      say(bot, 'got enough, heading back up')
      return
    }
    let tier = false
    try { tier = bring.hasPickaxe(bot, 'diamond_ore') } catch (_) { tier = false }
    if (!tier) {
      fail(bot, ctx, d, 'need-iron-pick', null, 'need an iron pickaxe for diamonds')
      return
    }
    let cell = null
    try { cell = forageMod.bestDiamondCell(bot, ctx, bp) } catch (_) { cell = null }
    if (!cell) {
      if (have > 0) { d.phase = 'return'; return }
      fail(bot, ctx, d, 'no-diamond', null, 'no diamonds remembered down here')
      return
    }
    d.target = { x: cell.x, y: cell.y, z: cell.z, name: cell.name }
    d.tunnelSteps = 0
    d.tunnelSeen = new Set([`${Math.floor(bp.x)},${Math.floor(bp.y)},${Math.floor(bp.z)}`])
    d.cameFrom = null
    d.phase = 'tunnel'
    return
  }

  if (d.phase === 'tunnel') {
    const t = d.target
    if (!t) { d.phase = 'plan'; return }
    const lost = lostCheck(bot, ctx, d, bp)
    if (lost) return
    const head = { x: Math.floor(bp.x), y: Math.floor(bp.y), z: Math.floor(bp.z) }
    if (lavaNear(bot, head.x, head.y, head.z)) {
      fail(bot, ctx, d, 'lava', head, 'lava closing in, backing out')
      return
    }
    // Every visited head joins seen (not just arrivals): exact-cell
    // arrivals advance `next` before the arrival check runs, so the
    // loop breaker must not depend on arrivals firing.
    try { if (d.tunnelSeen && typeof d.tunnelSeen.add === 'function') d.tunnelSeen.add(`${head.x},${head.y},${head.z}`) } catch (_) { /* seen best-effort */ }
    if (dist3(head, t) <= DIG_REACH) {
      if (canDig(bot, t) && !lavaNear(bot, t.x, t.y, t.z)) {
        d.phase = 'digcell'
        return
      }
      if (lavaNear(bot, t.x, t.y, t.z)) {
        try { danger.mark(ctx, t) } catch (_) { /* mark best-effort */ }
      }
      strikeAndReplan(bot, ctx, d, t)
      return
    }
    if ((d.tunnelSteps || 0) >= TUNNEL_MAX) {
      strikeAndReplan(bot, ctx, d, t)
      return
    }
    const next = tunnelNext(head, t, d.cameFrom, d.tunnelSeen)
    if (!next) {
      strikeAndReplan(bot, ctx, d, t)
      return
    }
    // Two-high tube (live assay: a 1-high tube is unwalkable, so the
    // return leg could never backtrack it): feet cell, then head cell.
    const above = { x: next.x, y: next.y + 1, z: next.z }
    for (const c of [next, above]) {
      const n = fname(bot, c.x, c.y, c.z)
      if (n === null || isAirName(n)) continue
      if (fallingAbove(bot, c.x, c.y, c.z)) {
        try { danger.mark(ctx, c) } catch (_) { /* mark best-effort */ }
        strikeAndReplan(bot, ctx, d, t)
        return
      }
      if (n === 'water' || waterNear(bot, c.x, c.y, c.z)) {
        try { danger.mark(ctx, c) } catch (_) { /* mark best-effort */ }
        strikeAndReplan(bot, ctx, d, t)
        return
      }
      if (lavaNear(bot, c.x, c.y, c.z)) {
        try { danger.mark(ctx, c) } catch (_) { /* mark best-effort */ }
        strikeAndReplan(bot, ctx, d, t)
        return
      }
      if (!canDig(bot, c)) {
        try { danger.mark(ctx, c) } catch (_) { /* mark best-effort */ }
        strikeAndReplan(bot, ctx, d, t)
        return
      }
      digOne(bot, ctx, d, c, n, 'tunnel')
      return
    }
    if (dropBelow(bot, next.x, next.y, next.z) > DROP_MAX) {
      strikeAndReplan(bot, ctx, d, t)
      return
    }
    const key = `deep-tunnel:${next.x},${next.y},${next.z}`
    const r = walkTo(bot, ctx, d, key, new goals.GoalNear(next.x, next.y, next.z, 1), (p) => dist3(p, next) <= 1.6)
    if (r === 'arrived') {
      d.steps.push({ x: next.x, y: next.y, z: next.z })
      try { if (d.tunnelSeen && typeof d.tunnelSeen.add === 'function') d.tunnelSeen.add(`${next.x},${next.y},${next.z}`) } catch (_) { /* seen best-effort */ }
      d.tunnelSteps = (d.tunnelSteps || 0) + 1
      d.cameFrom = head
    } else if (r === 'stalled') {
      strikeAndReplan(bot, ctx, d, t)
    }
    return
  }

  if (d.phase === 'digcell') {
    const t = d.target
    if (!t) { d.phase = 'plan'; return }
    let cur = null
    try { cur = fname(bot, t.x, t.y, t.z) } catch (_) { cur = null }
    if (!cur || cur !== t.name) {
      try { resources.forget(ctx, t.x, t.y, t.z) } catch (_) { /* memory best-effort */ }
      d.phase = 'plan'
      return
    }
    digOne(bot, ctx, d, t, t.name, 'pickup')
    return
  }

  if (d.phase === 'pickup') {
    const t = d.target
    if (!t) { d.phase = 'plan'; return }
    const key = `deep-pickup:${t.x},${t.y},${t.z}`
    // Arrival 1.5 (item magnet range): 2.2 can strand the drop just out
    // of reach. After arrival, wait PICKUP_WAIT_MS for the count to rise
    // before giving up on the drop (live assay: dug-but-uncollected).
    const r = walkTo(bot, ctx, d, key, new goals.GoalBlock(t.x, t.y, t.z), (p) => dist3(p, t) <= 1.5)
    if (r === 'arrived') {
      let have = 0
      try { have = bring.countDrop(bot, 'diamond') - ((d.startDrops && d.startDrops.diamond) || 0) } catch (_) { have = 0 }
      if (have <= d.dug) {
        if (!d.pickupSince) d.pickupSince = Date.now()
        if (Date.now() - d.pickupSince < PICKUP_WAIT_MS) return
      }
      d.pickupSince = null
      collectPickup(bot, ctx, d, t)
      return
    }
    if (r === 'stalled') {
      d.pickupSince = null
      collectPickup(bot, ctx, d, t)
    }
    return
  }

  if (d.phase === 'return') {
    const mouth = { x: d.shaft.x, y: d.shaft.topY, z: d.shaft.z }
    if (Math.hypot(bp.x - mouth.x, bp.z - mouth.z) <= 2.5 && bp.y >= mouth.y - 1) {
      finish(bot, ctx, d, true, null, d.dug)
      return
    }
    const crumbs = d.steps || []
    const next = crumbs[crumbs.length - 1]
    if (!next) {
      fail(bot, ctx, d, 'lost-shaft', null, 'lost the way back')
      return
    }
    // Pop radius 1.2 with a height gate: a stair step sits at diagonal
    // 1.41, and any radius alone pops it from the floor below and skips
    // the climb (live assay: skipped steps strand the return under an
    // unclimbable 2-up). The gate proves the climb happened. Arrival rest
    // distance is ~0.7, so 1.2 keeps margin on level crumbs.
    if (dist3(bp, next) <= 1.2 && bp.y >= next.y - 0.5) {
      crumbs.pop()
      return
    }
    // Hybrid drive: the pathfinder sprints into 1-up stair risers and the
    // server rejects the push-while-jump every tick (live assay: frozen
    // 12s at a step it dug itself), so ADJACENT step-ups drive the body
    // directly. Anything farther out — level tunnel crumbs AND above
    // crumbs around a corner — uses the pathfinder (it still turns
    // corners better than a straight-line drive); it walks under the
    // step and the manual climb engages when adjacent.
    if (next.y > Math.floor(bp.y) && Math.hypot(next.x - bp.x, next.z - bp.z) <= 1.5) {
      driveStepUp(bot, ctx, d, bp, next)
      return
    }
    if (d.retMode !== 'flat') {
      d.retMode = 'flat'
      d.stalls = 0
      d.retWedge = null
      try { bot.clearControlStates && bot.clearControlStates() } catch (_) { /* release manual keys */ }
    }
    d.stallBudget = RETURN_STALL
    const key = `deep-back:${crumbs.length}`
    const r = walkTo(bot, ctx, d, key, new goals.GoalNear(next.x, next.y, next.z, 1), () => false)
    d.stallBudget = null
    if (r === 'stalled') {
      try { recover.setStuck(ctx, 'deep', next, key) } catch (_) { /* stuck best-effort */ }
      fail(bot, ctx, d, 'lost-shaft', next, 'lost the way back')
    }
    return
  }
}

// Manual 1-up step climb: face the crumb, walk at the riser, and jump
// STRAIGHT (forward released — the proven assay shape: rise 1.1, then
// mount) when the riser test or 3 still ticks say wedged. Stalls count
// horizontal displacement only: a rising jump is progress, a jumping
// statue is stuck.
function driveStepUp(bot, ctx, d, bp, next) {
  if (d.retMode !== 'up') {
    d.retMode = 'up'
    d.issuedKey = 'deep-return-up'
    ctx.lastGoalKey = 'deep-return-up'
    d.stalls = 0
    d.retWedge = null
    d.retStill = 0
    d.retLastXZ = { x: bp.x, z: bp.z }
    d.retStallPos = { x: bp.x, z: bp.z }
    try { bot.pathfinder && bot.pathfinder.setGoal(null) } catch (_) { /* release pathfinder */ }
    try { bot.clearControlStates && bot.clearControlStates() } catch (_) { /* release keys */ }
  }
  try {
    const r = bot.lookAt(new Vec3(next.x, bp.y + 1.6, next.z))
    if (r && typeof r.catch === 'function') r.catch(() => {})
  } catch (_) { /* look best-effort */ }
  const setC = (k, v) => { try { bot.setControlState && bot.setControlState(k, v) } catch (_) { /* optional */ } }
  const now = Date.now()
  if (d.retWedge) {
    if (bp.y >= d.retWedge.baseY + 1.1) {
      d.retWedge = null
      d.stalls = 0
      d.retStallPos = { x: bp.x, z: bp.z }
    } else if (now - d.retWedge.since > 2000) {
      d.retWedge = null
    } else {
      setC('forward', false); setC('back', false); setC('jump', true); setC('sprint', false)
      retStall(bot, ctx, d, bp, next)
      return
    }
  }
  setC('forward', true); setC('back', false); setC('jump', false); setC('sprint', false)
  if (riserAhead(bot, bp, next) || horizStill(d, bp)) d.retWedge = { baseY: bp.y, since: now }
  retStall(bot, ctx, d, bp, next)
}

// Solid feet-level cell on the straight line to the crumb (liquids are
// walkable-through, not risers).
function riserAhead(bot, bp, next) {
  const dx = next.x - bp.x
  const dz = next.z - bp.z
  const len = Math.hypot(dx, dz)
  if (len < 0.05) return false
  const n = fname(bot, Math.floor(bp.x + (dx / len) * 0.7), Math.floor(bp.y), Math.floor(bp.z + (dz / len) * 0.7))
  if (n === null || isAirName(n)) return false
  return n !== 'water' && n !== 'lava'
}

// No horizontal displacement for 3 ticks while walking (yaw-miscount and
// half-slab backstop for the riser test).
function horizStill(d, bp) {
  const last = d.retLastXZ
  if (!last || Math.hypot(bp.x - last.x, bp.z - last.z) > 0.05) {
    d.retLastXZ = { x: bp.x, z: bp.z }
    d.retStill = 0
    return false
  }
  d.retStill = (d.retStill || 0) + 1
  return d.retStill >= 3
}

function retStall(bot, ctx, d, bp, next) {
  const last = d.retStallPos
  if (last && Math.hypot(bp.x - last.x, bp.z - last.z) > 0.05) {
    d.stalls = 0
    d.retStallPos = { x: bp.x, z: bp.z }
    return
  }
  if (++d.stalls >= RETURN_STALL) {
    d.retWedge = null
    try { recover.setStuck(ctx, 'deep', next, 'deep-return-up') } catch (_) { /* stuck best-effort */ }
    fail(bot, ctx, d, 'lost-shaft', next, 'lost the way back')
  }
}

// Returns true when the tick is consumed (walked back or failed).
function lostCheck(bot, ctx, d, bp) {
  const c = nearestCrumb(d, bp)
  if (!c || c.dist > RESUME_RANGE) {
    fail(bot, ctx, d, 'died', null, 'died down there, shaft abandoned')
    return true
  }
  if (c.dist > DIG_REACH * 2) {
    const r = walkTo(bot, ctx, d, 'deep-back', new goals.GoalNear(c.at.x, c.at.y, c.at.z, 2), (p) => dist3(p, c.at) <= 2.2)
    if (r === 'stalled') fail(bot, ctx, d, 'died', c.at, 'cannot get back to the shaft')
    return true
  }
  return false
}

const PICKUP_WAIT_MS = 4000

function collectPickup(bot, ctx, d, t) {
  try { resources.forget(ctx, t.x, t.y, t.z) } catch (_) { /* dug: drop the cell */ }
  let have = 0
  try { have = bring.countDrop(bot, 'diamond') - ((d.startDrops && d.startDrops.diamond) || 0) } catch (_) { have = 0 }
  if (have > d.dug) {
    d.dug = have
    console.log(`deep dug diamond n=${have}/${DEEP_WANT}`)
    say(bot, `got diamond ${have}/${DEEP_WANT}`)
  }
  d.target = null
  d.phase = 'plan'
}

function strikeAndReplan(bot, ctx, d, t) {
  try {
    if (typeof forageMod.skipCell === 'function') forageMod.skipCell(ctx, t)
  } catch (_) { /* skip best-effort */ }
  d.target = null
  d.phase = 'plan'
}

module.exports = deep
module.exports.TARGET_Y = TARGET_Y
module.exports.FLOOR_Y = FLOOR_Y
module.exports.TUNNEL_MAX = TUNNEL_MAX
module.exports.DEEP_WANT = DEEP_WANT
module.exports.waterNear = waterNear
module.exports.fallingAbove = fallingAbove
module.exports.lavaNear = lavaNear
module.exports.dropBelow = dropBelow
module.exports.pickSite = pickSite
module.exports.pickDir = pickDir
module.exports.stairCells = stairCells
module.exports.tunnelNext = tunnelNext
