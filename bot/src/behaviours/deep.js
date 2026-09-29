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
//   R-up: upward digs are headroom-only (+2 above feet, fully guarded:
//     lava/loose/water/canDig like every dig) — the return leap needs 3
//     clear and a 2-high tube ceilings every arc (ssn (48,-40) lip). Cells
//     above the headroom are struck, not chased; the tunnel never routes
//     upward (tunnelNext still refuses +Y steps).
//   R-drop: every step-landing is drop-checked (<=1) before walking in;
//     deeper voids fail honestly (failed:drop) + danger-mark. 1 is the
//     reversibility limit: the return leg must climb every step back.
//   R-floor: nothing is dug at or below FLOOR_Y (-56, bedrock/lava margin).
//   R-tier: diamond digs need an iron pick (bring tier check); without one
//     the leg fails honestly (failed:need-iron-pick) — the gear step must
//     only send equipped bots (interface contract, asserted in assay).
//   R-retreat: a descend guard firing past the pre-scan window retreats up
//     the breadcrumbs (abort-to-return) and fails honestly at the mouth;
//     inside the window it fails in place. A failed climb is lost-shaft.
// Return: breadcrumb reverse-walk, hybrid drive — manual mount (back to
// leap stance when pressed, leap WITH forward thrust — the hop_step shape:
// Paper zeroes a leap from contact) for 1-up steps, pathfinder for level
// tunnel crumbs (corners). A climb latches its crumb: no mid-climb mode
// flap resetting the budget. Dead ends fail honestly (failed:lost-shaft)
// and raise the stuck fact for recover (explore precedent).

const { goals } = require('mineflayer-pathfinder')
const { Vec3 } = require('vec3')
const resources = require('../resources')
const danger = require('../danger')
const bring = require('./bring')
const stuck = require('../stuck')
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
const DIG_REACH = 4 // settle radius for tunnel/dig targets
const DROP_MAX = 1 // deepest landing the bot walks into (a 1-drop climbs back; 2 is one-way and strands the return)
const PICKUP_CRUMB_GAP = 1.3 // pickup chain spacing: above the 1.2 pop radius (no cascade), tight enough to reverse link by link
const UNFREEZE_TICKS = 8 // manual static ticks before one dig-start unfreeze per crumb (mid-budget: 7 ticks left to prove it)
const STEP_STALL = 20 // descend/tunnel no-progress budget: legs walk for real now, with room for one executor dig-recovery
const RET_AIR_VY = 0.08 // airborne-still band (HOP_STALL_VY): a leap apex crosses it for one sample at most
const RET_AIR_TICKS = 2 // hung-airborne samples before the back-off (HOP_STALL_TICKS)
const RET_MOUNT_TICKS = 20 // per-crumb climb cap: hang-back-leap cycles displace, so stalls alone would spin forever
const PROG_EPS = 0.05 // progress margin: closing less than this per tick counts as circling, not approaching
const SITE_RINGS = [3, 4, 5, 6, 7, 8] // mouth offsets from the anchor
const SITE_RAYS = 8
// Pre-scan window (b20): pickDir/tubeClean verdict only the first K steps;
// deeper dirt is met by the per-step descend guards, which abort-to-return
// (retreat) instead of failing in place. K=10 from the prod-world rig
// (worldsha 85a1422228ef, 6 fixed stride-20 spawn columns): near dirt
// (steps 0-6: lakes, aquifers, gravel) still refuses at pick, deep dirt
// (12+) starts and retreats honestly; starts 5/6 (was 3/6 full-tube — the
// holdout is step-0 lake water, unstartable at any K).
const PRESCAN_STEPS = 10
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

// Landing verdict for a step about to be walked into (b20, Codex condition):
// the dig-loop guards only run on SOLID cells, so a pre-open (cave) step
// skips them — lava directly below reads as standing ground (dropBelow
// returns 0 for a lava floor) and 1-deep water as a 1-drop. The battery
// re-verdicts stand+below regardless of open. Returns the refusal reason
// ('lava'|'water'|'drop') or null. (No loose arm: gravel at feet/head is
// solid, so the dig loop always sees it first — a battery loose check is
// unreachable by construction.) On solid steps it agrees with
// the dig loop (same predicates), so only pre-open steps gain verdicts.
function landingHazard(bot, c) {
  if (lavaNear(bot, c.x, c.y, c.z) || isLavaName(fname(bot, c.x, c.y - 1, c.z))) return 'lava'
  if (fname(bot, c.x, c.y, c.z) === 'water' || fname(bot, c.x, c.y - 1, c.z) === 'water' || waterNear(bot, c.x, c.y, c.z)) return 'water'
  if (dropBelow(bot, c.x, c.y, c.z) > DROP_MAX) return 'drop'
  return null
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

// Stair step n (0-based): stand cell S, then the 4 dig cells (feet, head,
// headroom, down-last so footing reads stay stable mid-cycle). The headroom
// (+2) is load-bearing, not luxury: a leap rises 1.25 with a 1.8 body, so a
// 2-high tube ceilings every arc at 0.2 (ssn rig: (48,-40) lip vs takeoff
// 47.7 — 6/6 faceplants). The descend/tubeClean guard loops cover the extra
// cell unchanged (R-up bends deliberately here, guarded; see the header).
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
      { x: nx, y: sy + 2, z: nz },
      { x: nx, y: ny, z: nz },
    ],
  }
}

// First shaft direction whose pre-scan window (first PRESCAN_STEPS steps)
// is lava/water/loose-free and whose step-0 cells are diggable. Pure
// geometry + reads; null when every direction is refused. Dirt past the
// window is met step by step: the descend guards abort-to-return (retreat)
// instead of failing in place.
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

// The first PRESCAN_STEPS stair steps: dig cells + landing + one below
// must be lava/water/loose-free (radius 2) and above the floor. A short
// window, not the whole tube (b20): on real terrain every 115-deep tube
// holds water/lava/gravel somewhere, so a full-tube scan refuses every
// direction and the leg never starts. Dirt past the window trips the
// per-step descend guards, which retreat up the breadcrumbs.
function tubeClean(bot, shaft) {
  for (let n = 0; n < PRESCAN_STEPS && shaft.topY - n > TARGET_Y && shaft.topY - n > FLOOR_Y + 2; n++) {
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

// Exact-cell arrival (same test as the GoalBlock executor): the fractional
// body sits inside the integer target cell. No radius can do this job on
// 1.0–1.41-spaced targets — adjacent bodies sit inside every workable one.
function inCell(p, c) {
  return Math.floor(p.x) === c.x && Math.floor(p.y) === c.y && Math.floor(p.z) === c.z
}

// The leg reverses pre-dug ground crumb by crumb: executor detour-digs
// (canDig) eat the stairs' floors out from under the crumbs behind them,
// so every tick deep owns borrows canDig=false (gohome-walk shape; the
// ticker restores the shared default on ticks deep does not own, and the
// assay's private movements object needs no restore at all).
function borrowNoDig(bot, ctx) {
  try {
    const mov = (ctx && ctx.movements) || (bot && bot.pathfinder && bot.pathfinder.movements)
    if (mov && typeof mov.canDig === 'boolean') mov.canDig = false
  } catch (_) { /* borrow best-effort */ }
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

// Abort-to-return (b20): a descend guard firing inside the pre-scan window
// fails in place (the tube was vetted clean — a hazard there means the
// world changed under us; the rules assay pins this); a guard firing PAST
// the window — the expected case now that the window is short — retreats
// up the dug breadcrumbs instead of stranding the bot mid-shaft.
// Breadcrumbs stay intact so the return phase can climb out; arrival
// finishes failed:<reason> (honest), and a failed climb is the lost-shaft
// hard case (ssn owns the return mechanics).
function guardTrip(bot, ctx, d, reason, markP, chatLine) {
  if (d.n < PRESCAN_STEPS) {
    fail(bot, ctx, d, reason, markP, chatLine)
    return
  }
  try {
    const marks = Array.isArray(markP) ? markP : [markP]
    for (const m of marks) if (m) danger.mark(ctx, m)
  } catch (_) { /* mark best-effort */ }
  if (chatLine) say(bot, chatLine)
  d.retreatReason = reason
  d.phase = 'return'
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
    // A guard may have retreated mid-dig (reads changed while the swing was
    // in flight): the return phase owns d.phase now, never clobber it back.
    if (ctx.deep === d && d.phase !== 'return') d.phase = nextPhase
  })()
}

function deep(bot, ctx, target, state) {
  borrowNoDig(bot, ctx)
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
      guardTrip(bot, ctx, d, 'lava', [here, mouthOf(d)], 'lava closing in, backing out')
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
        guardTrip(bot, ctx, d, 'floor', c, 'hit the dig floor, backing out')
        return
      }
      const n = fname(bot, c.x, c.y, c.z)
      if (n === null || isAirName(n)) continue
      if (lavaNear(bot, c.x, c.y, c.z)) {
        guardTrip(bot, ctx, d, 'lava', [c, mouthOf(d)], 'lava in the shaft, backing out')
        return
      }
      if (fallingAbove(bot, c.x, c.y, c.z)) {
        guardTrip(bot, ctx, d, 'loose', [c, mouthOf(d)], 'loose rock above, backing out')
        return
      }
      if (fname(bot, c.x, c.y, c.z) === 'water' || waterNear(bot, c.x, c.y, c.z)) {
        guardTrip(bot, ctx, d, 'water', [c, mouthOf(d)], 'water in the shaft, backing out')
        return
      }
      if (!canDig(bot, c)) {
        guardTrip(bot, ctx, d, 'bedrock', [c, mouthOf(d)], 'unbreakable rock in the shaft')
        return
      }
      digOne(bot, ctx, d, c, n, 'descend')
      return
    }
    // All three open: landing battery (b20: pre-open steps skip the dig
    // loop, so the battery re-verdicts stand+below), then walk the step.
    // Same reason/chat vocabulary as the dig loop — no new strings.
    const hz = landingHazard(bot, st.stand)
    if (hz) {
      const lines = { lava: 'lava in the shaft, backing out', water: 'water in the shaft, backing out', drop: 'void under the next step, backing out' }
      guardTrip(bot, ctx, d, hz, [st.stand, mouthOf(d)], lines[hz])
      return
    }
    const key = `deep-descend:${d.n}`
    // GoalBlock + exact-cell arrival: a 1.6 radius theaters on 1.41-diagonal
    // stairs (the previous stand sits inside it) — n runs ahead of the body
    // and compounds into 2-down wedges. The body must ENTER the stand cell.
    d.stallBudget = STEP_STALL
    const r = walkTo(bot, ctx, d, key, new goals.GoalBlock(st.stand.x, st.stand.y, st.stand.z), (p) => inCell(p, st.stand) && (!bot.entity || bot.entity.onGround !== false))
    d.stallBudget = null
    if (r === 'arrived') {
      d.steps.push({ x: st.stand.x, y: st.stand.y, z: st.stand.z })
      d.n++
    } else if (r === 'stalled') {
      // One escape per failed step through stuck.request (core-1): the fail
      // ends the step, so the stills never reach the slow threshold alone.
      try { stuck.request(bot, ctx, 'deep', st.stand, key) } catch (_) { /* stuck best-effort */ }
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
    d.tunnelGoal = null
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
    // Direct dig only level-ish (|dy|<=1) over verified-open ground: the
    // pickup walks there with canDig=false now, so rock-between or a deep
    // drop tunnels instead (guarded path, crumbed, reversible). In reach
    // but undiggable-by-policy (bedrock, loose above, water beside) strikes
    // at once — the tunnel would refuse the same cell.
    if (dist3(head, t) <= DIG_REACH && lavaNear(bot, t.x, t.y, t.z)) {
      try { danger.mark(ctx, t) } catch (_) { /* mark best-effort */ }
      strikeAndReplan(bot, ctx, d, t)
      return
    }
    if (dist3(head, t) <= DIG_REACH && (!canDig(bot, t) || fallingAbove(bot, t.x, t.y, t.z) || waterNear(bot, t.x, t.y, t.z))) {
      strikeAndReplan(bot, ctx, d, t)
      return
    }
    if (dist3(head, t) <= DIG_REACH && Math.abs(head.y - t.y) <= 1 && walkOpen(bot, bp, t)) {
      d.phase = 'digcell'
      return
    }
    if ((d.tunnelSteps || 0) >= TUNNEL_MAX) {
      strikeAndReplan(bot, ctx, d, t)
      return
    }
    // Latched step: recomputing from the live head every tick moves the
    // target as the body closes in, so an exact arrival could never fire
    // (and a radius arrival pushed unvisited rock). One committed step at
    // a time; arrival clears the latch for the next.
    if (!d.tunnelGoal) {
      d.tunnelGoal = tunnelNext(head, t, d.cameFrom, d.tunnelSeen)
      if (!d.tunnelGoal) {
        strikeAndReplan(bot, ctx, d, t)
        return
      }
    }
    const next = d.tunnelGoal
    // Three-high tube (ssn: a leap rises 1.25 with a 1.8 body, so 2-high
    // ceilings every arc (the stair-lip faceplant); a 1-high tube is
    // unwalkable, so the return could never backtrack it): feet, head,
    // headroom. The guard loop below covers all three unchanged.
    const above = { x: next.x, y: next.y + 1, z: next.z }
    const above2 = { x: next.x, y: next.y + 2, z: next.z }
    for (const c of [next, above, above2]) {
      // R-stand (ssn): never dig the block underfoot — a straight-down
      // tunnel step eats its own floor, and the fall-through landing never
      // satisfies the latched arrival (in-cell + grounded), so the step
      // strikes post-dig with a dangling crumb above (ssn leg1 pocket).
      // tunnelNext descends ONLY straight down (no diagonal down-ahead),
      // so this gate skips below-band diamonds by design: a dug descent
      // cell is air that can host no mid-floor, making the drop
      // unreversible. The strike reroutes to level targets (the band scan
      // covers them); the skip is logged, never silent.
      if (c.x === head.x && c.y === head.y - 1 && c.z === head.z) {
        console.log(`deep R-stand strike at ${c.x},${c.y},${c.z} (underfoot dig refused; below-band target skipped)`)
        strikeAndReplan(bot, ctx, d, t)
        return
      }
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
    const lhz = landingHazard(bot, next)
    if (lhz) {
      // Drops strike unmarked (pre-b20 shape): danger marks are xz-only, so
      // a deep-cave drop mark would steer surface site selection for 2h.
      if (lhz !== 'drop') { try { danger.mark(ctx, next) } catch (_) { /* mark best-effort */ } }
      strikeAndReplan(bot, ctx, d, t)
      return
    }
    const key = `deep-tunnel:${next.x},${next.y},${next.z}`
    // Exact-cell arrival like descend (1.0-spaced targets theater under any
    // radius: adjacent fractional bodies sit inside it): the body must ENTER
    // the cell, or the chain crumbs unvisited rock the return cannot reverse.
    d.stallBudget = STEP_STALL
    const r = walkTo(bot, ctx, d, key, new goals.GoalBlock(next.x, next.y, next.z), (p) => inCell(p, next) && (!bot.entity || bot.entity.onGround !== false))
    d.stallBudget = null
    if (r === 'arrived') {
      d.steps.push({ x: next.x, y: next.y, z: next.z })
      try { if (d.tunnelSeen && typeof d.tunnelSeen.add === 'function') d.tunnelSeen.add(`${next.x},${next.y},${next.z}`) } catch (_) { /* seen best-effort */ }
      d.tunnelSteps = (d.tunnelSteps || 0) + 1
      d.cameFrom = head
      d.tunnelGoal = null
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
      // Gone already (tunneled through, or stale memory): forget the cell
      // but still walk the drop point (magnet sweep) — the pickup collects
      // what the tunnel broke. A bare plan would strand the diamonds.
      try { resources.forget(ctx, t.x, t.y, t.z) } catch (_) { /* memory best-effort */ }
      d.phase = 'pickup'
      return
    }
    digOne(bot, ctx, d, t, t.name, 'pickup')
    return
  }

  if (d.phase === 'pickup') {
    const t = d.target
    if (!t) { d.phase = 'plan'; return }
    // Chain the walk (descend/tunnel arrivals crumb their steps; pickup is
    // the only other movement): the pathfinder digs undocumented paths
    // (canDig) with mid-path 1-ups the return executor wedges on — a
    // 1.3-spaced chain turns the way back into short legs the pop radius
    // (1.2) and the adjacent-above trigger reverse link by link.
    try {
      const crumbs = d.steps || []
      const last = crumbs[crumbs.length - 1]
      // Grounded only (ssn): the magnet walk falls through air the return
      // cannot stand on — an airborne crumb strands the climb under a
      // floorless cell (ssn leg1: (56,-48) chased from a pocket 3 below).
      // Standing on it is the standability proof (physics already checked).
      const chainGrounded = !bot.entity || bot.entity.onGround !== false
      if (last && chainGrounded && dist3(bp, last) > PICKUP_CRUMB_GAP) {
        crumbs.push({ x: Math.floor(bp.x), y: Math.floor(bp.y), z: Math.floor(bp.z) })
      }
    } catch (_) { /* chain best-effort */ }
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
      // Retreat arrival (b20, own hunk — ssn owns the pop gate below): the
      // leg ends failed:<reason> at the mouth, honestly, with the bot out
      // of the shaft. The guard already chatted at trip time.
      if (d.retreatReason) {
        finish(bot, ctx, d, false, d.retreatReason, d.dug)
        return
      }
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
    // Pop proves the mount two ways: inside the crumb cell (grounded, or
    // flying through an UNDERMINED cell — no floor means standing is
    // impossible and passing is the only option; but a standable cell
    // overflown mid-arc must NOT pop (the next step assumes standing, and
    // the pop-lie strands the climb 2-below — ipn.2 shaft 33), or radius +
    // height gate + touchdown (an apex above the cell must not skip the
    // step — the pop waits for landing). Null floor reads as standable
    // (strict: touchdown first).
    const popGrounded = !bot.entity || bot.entity.onGround !== false
    const popFloor = fname(bot, next.x, next.y - 1, next.z)
    const popStandable = popFloor !== null && isSolidName(popFloor)
    // Filled mids pop by arrival only (ssn): the radius would pop the mid
    // from the floor below and re-fill it forever, budget-free.
    if ((inCell(bp, next) && (popGrounded || !popStandable)) ||
        (!next.fill && dist3(bp, next) <= 1.2 && bp.y >= next.y - 0.5 && popGrounded)) {
      crumbs.pop()
      if (d.retMode === 'up') manualBrake(bot)
      return
    }
    // Multi-up gap fill (ssn): the outbound can chain a 2-3 fall (a strike
    // mid-fall, a gated pickup gap) the 1-up latch cannot climb. Fill ONE
    // standable mid per engagement (marked, arrival-pop-only): mids ascend
    // strictly toward the crumb (y-monotonic: termination within one
    // ascent), each mounts on its own latch budget. No standable mid (air
    // shaft) fails honestly NOW — recover pillars what leaps cannot. Two
    // fills per crumb max (revmux 01): a fall off a mounted mid re-fills
    // the same cell with a fresh latch budget, so uncapped refills cycle
    // mount-fall-remount forever; the third fill attempt fails honestly.
    if (next.y - Math.floor(bp.y) >= 2 && Math.hypot(next.x + 0.5 - bp.x, next.z + 0.5 - bp.z) <= 1.5) {
      const okey = `${next.x},${next.y},${next.z}`
      d.fillSeen = d.fillSeen || {}
      if ((d.fillSeen[okey] || 0) >= 2) {
        try { stuck.request(bot, ctx, 'deep', next, `deep-back:${crumbs.length}`) } catch (_) { /* stuck best-effort */ }
        fail(bot, ctx, d, 'lost-shaft', next, 'lost the way back')
        return
      }
      const mid = fillMid(bot, bp, next)
      if (!mid) {
        try { stuck.request(bot, ctx, 'deep', next, `deep-back:${crumbs.length}`) } catch (_) { /* stuck best-effort */ }
        fail(bot, ctx, d, 'lost-shaft', next, 'lost the way back')
        return
      }
      d.fillSeen[okey] = (d.fillSeen[okey] || 0) + 1
      crumbs.push({ x: mid.x, y: mid.y, z: mid.z, fill: true })
      return
    }
    // Hybrid drive: the pathfinder sprints into 1-up stair risers and the
    // server rejects the push-while-jump every tick (live assay: frozen
    // 12s at a step it dug itself), so ADJACENT step-ups drive the body
    // directly. Anything farther out — level tunnel crumbs AND above
    // crumbs around a corner — uses the pathfinder (it still turns
    // corners better than a straight-line drive); it walks under the
    // step and the manual climb engages when adjacent. An engaged climb
    // latches its crumb (walk-in + stance + leap all live in driveStepUp):
    // leaving for flat mid-climb would reset the stall budget via walkTo
    // and could flap forever instead of failing honestly.
    const crumbKey = `${next.x},${next.y},${next.z}`
    const latched = d.retMode === 'up' && d.retUpKey === crumbKey
    if (latched || (next.y > Math.floor(bp.y) && Math.hypot(next.x + 0.5 - bp.x, next.z + 0.5 - bp.z) <= 1.5)) {
      driveStepUp(bot, ctx, d, bp, next, crumbKey)
      return
    }
    if (d.retMode !== 'flat') {
      d.retMode = 'flat'
      d.stalls = 0
      try { bot.clearControlStates && bot.clearControlStates() } catch (_) { /* release manual keys */ }
    }
    d.stallBudget = RETURN_STALL
    const key = `deep-back:${crumbs.length}`
    // GoalBlock (exact): the planner tests arrival on the FLOORED position,
    // so a GoalNear(1) arrives up to 1.7 true-out while deep's pop needs
    // true ≤1.2 — the executor idles arrived and deep waits forever
    // (ipn.2 shaft 33: idle 1.39 out). Exact arrival lands inside the cell
    // and the pop agrees.
    const goal = new goals.GoalBlock(next.x, next.y, next.z)
    const r = walkTo(bot, ctx, d, key, goal, () => false)
    d.stallBudget = null
    if (r === 'walking' && d.stalls === UNFREEZE_TICKS) {
      // Executor static on open ground: poke to resync a ghost-pin, and
      // force the planner to replan — a goal issued mid-air computes
      // no-path once and then idles forever under the same key (ipn.2
      // shaft 33: idle 1.3 out on open ground). Wedges on real risers
      // shrug both off and the walkTo budget fails honestly (recover owns
      // wedge escapes). No manual takeover: a level manual walk is a
      // bang-bang servo, unstable at 1Hz (4-block strides hunt ±2 around
      // the crumb and never arrive).
      unfreeze(bot, pokeCells(bp, next))
      try { bot.pathfinder.setGoal(null) } catch (_) { /* replan best-effort */ }
      try { bot.pathfinder.setGoal(goal, false) } catch (_) { /* replan best-effort */ }
    }
    if (r === 'stalled') {
      try { stuck.request(bot, ctx, 'deep', next, key) } catch (_) { /* stuck best-effort */ }
      fail(bot, ctx, d, 'lost-shaft', next, 'lost the way back')
    }
    return
  }
}

// Manual 1-up step mount (recover.js wqt measurements on Paper 26.1.2): a
// standstill leap (forward+jump together, ~zero momentum) mounts from
// TRUE face gap 0.25-0.7 with 0 rejects; true 1.0 hits the face low (88
// rejects); run-up leaps die grounded (107 rejects). So each grounded
// tick re-measures the TRUE gap (center-dist minus half-cell 0.5 minus
// half-width 0.3 — a corner-dist formula overestimates on diagonals and
// fires from contact: ipn.2 assay leapt at formula 0.51 / true 0.1 and
// pinned at +0.4 twice) and either sneak-backs 400ms to prime (0.36m:
// lag-proof, zone-capped, edge-safe),
// leaps primed from the zone, or walks in from afar. Above-only: level
// crumbs stay on the executor (a level manual servo hunts ±2 at 1Hz).
// Stalls count horizontal displacement
// only; the per-crumb mount budget bounds hang cycles that displace.
// Airborne ticks coast (an in-flight arc completes); hung arcs back off
// mid-air.
const RET_GAP_MIN = 0.25 // leap zone, TRUE face gap (wqt standstill: 0.25/0.5/0.7 mount, 0 rejects)
const RET_GAP_MAX = 0.7
const RET_GAP_BACK_MS = 400 // sneak-back hold: 0.36 m (in-zone in one tick from contact, never skips the 0.45 zone); 400 ms outlives lag gaps that swallow 50 ms holds (shaft 33), and sneak cannot walk off a 1-deep step
const RET_AIR_BACK_MS = 250 // air unwedge hold: air control is weak (HOP_UNWEDGE_MS shape)
const RET_LEAP_JUMP_MS = 200 // leap jump hold: takeoff lands <100ms, touchdown ~600ms — release between so physics can't auto re-jump (revmux 01)
const RET_POP_SNEAK_MS = 600 // manual-pop edge guard: sneak through the momentum slide (friction stops ~500ms), self-releasing
const RET_SETTLE_VEL = 0.05 // leap settle: horizontal momentum below this reads as standstill (standing noise floor ~0.03)
// Manual arrival brake: all drive keys off + edge-guard sneak (the
// leap/coast momentum + held forward would carry off the 1-wide step
// before the next tick — ipn.2 shaft 33 slide-and-fall). Flat pops skip
// this (the executor owns its keys). Timed (self-cleaning across modes).
function manualBrake(bot) {
  try {
    bot.setControlState && bot.setControlState('forward', false)
    bot.setControlState && bot.setControlState('back', false)
    bot.setControlState && bot.setControlState('jump', false)
    bot.setControlState && bot.setControlState('sprint', false)
    bot.setControlState && bot.setControlState('sneak', true)
    setTimeout(() => { try { bot.setControlState && bot.setControlState('sneak', false) } catch (_) { /* timer best-effort */ } }, RET_POP_SNEAK_MS)
  } catch (_) { /* brake best-effort */ }
}
function driveStepUp(bot, ctx, d, bp, next, crumbKey) {
  const setC = (k, v) => { try { bot.setControlState && bot.setControlState(k, v) } catch (_) { /* optional */ } }
  const dbg = (msg) => { try { if (process.env.DEEP_DEBUG) console.log(`deepdbg up ${msg} bp=${bp.x.toFixed(1)},${bp.y.toFixed(1)},${bp.z.toFixed(1)} crumb=${next.x},${next.y},${next.z} stalls=${d.stalls} waited=${d.retWaited}`) } catch (_) { /* log best-effort */ } }
  if (d.retMode !== 'up' || d.retUpKey !== crumbKey) {
    d.retMode = 'up'
    d.retUpKey = crumbKey
    d.issuedKey = 'deep-return-up'
    ctx.lastGoalKey = 'deep-return-up'
    d.stalls = 0
    d.primed = false
    d.retAirStall = 0
    d.wedgedTicks = 0
    d.retWaited = 0
    d.retProgBest = Infinity
    d.retProgTicks = 0
    d.retStallPos = { x: bp.x, z: bp.z }
    try { bot.pathfinder && bot.pathfinder.setGoal(null) } catch (_) { /* release pathfinder */ }
    try { bot.clearControlStates && bot.clearControlStates() } catch (_) { /* release keys */ }
  }
  // Mount budget (HOP_MOUNT_TICKS shape): displacement resets stalls, so a
  // hang-back-leap-hang cycle would spin forever on stalls alone — the
  // per-crumb tick cap fails it honestly instead.
  if (++d.retWaited > RET_MOUNT_TICKS) {
    try { stuck.request(bot, ctx, 'deep', next, 'deep-return-up') } catch (_) { /* stuck best-effort */ }
    fail(bot, ctx, d, 'lost-shaft', next, 'lost the way back')
    return
  }
  try {
    // Axis-locked aim (see aimDir): the look shares the samplers' drift-free
    // direction, so backs and leaps run parallel to the tube wall instead of
    // pressing it (the press seeds the server snap storm that eats the climb).
    const ad = aimDir(bp, next) || { dx: 1, dz: 0 }
    const r = bot.lookAt(new Vec3(bp.x + ad.dx * 2, bp.y + 1.6, bp.z + ad.dz * 2))
    if (r && typeof r.catch === 'function') r.catch(() => {})
  } catch (_) { /* look best-effort */ }
  // Still-band votes first (two in-band samples is a server pin, never a
  // ballistic arc — falling resets the count within 150ms).
  const vy = bot.entity && bot.entity.velocity && typeof bot.entity.velocity.y === 'number'
    ? bot.entity.velocity.y : null
  if (vy !== null && Math.abs(vy) < RET_AIR_VY) d.retAirStall = (d.retAirStall || 0) + 1
  else d.retAirStall = 0
  // Hover arrival, ahead of the grounded test: a still-band hover INSIDE the
  // crumb over a standable floor is a landed touch the touchdown gate cannot
  // see — pop it here or the held forward walks the step off before the next
  // tick (ipn.2 shaft 33 coast walkoff: landed 48.3, drifted +1.4 and fell).
  // Arc midpoints carry vy and never match (no pop-lie); undermined cells
  // pop pre-drive already, so a hover that reaches the coast stands over a
  // solid floor. Hoisted above ghostContact (ssn): a contact hover just short
  // of the crumb centre used to hold still in the grounded branch instead of
  // popping.
  if (inCell(bp, next) && (d.retAirStall || 0) >= RET_AIR_TICKS) {
    dbg('coast-pop')
    d.steps.pop()
    manualBrake(bot)
    return
  }
  // Ghost contact: airborne + pinned + floor below + face at the nose. The
  // server stands the body (it accepts jumps) while the client hovers, so
  // drive the zone as if grounded (inch/rim/leap) instead of unwedging
  // away from a contact the climb must attack (ipn.2 shaft 33 face-dither).
  const ghostContact = (!bot.entity || bot.entity.onGround === false) &&
    (d.retAirStall || 0) >= RET_AIR_TICKS &&
    dropBelow(bot, Math.floor(bp.x), Math.floor(bp.y), Math.floor(bp.z)) === 0 &&
    riserAhead(bot, bp, next)
  const grounded = (!bot.entity || bot.entity.onGround !== false) || ghostContact
  if (!grounded) {
    // Airborne hang (ak4): pressed to the face with vel.y=0 and no ground,
    // the held jump never fires. Back off — facing stays on the crumb, so
    // back walks off the face — until a sample reads ground. A leap apex
    // crosses the still band for one sample at most.
    //
    // Hang filter: only pits/voids back off (face pins arrive here as
    // ghost contact above; floor-below + open ahead is a ghost or an apex
    // and backing off feeds a pin-loop — ipn.2 shaft 33 east-west dither).
    // Ghosts coast on (resync + walk out).
    const hangFire = (d.retAirStall || 0) >= RET_AIR_TICKS &&
      dropBelow(bot, Math.floor(bp.x), Math.floor(bp.y), Math.floor(bp.z)) >= 1
    if (hangFire) {
      // Wall check first: in a chimney corner the back-off slams the rear
      // wall, Paper pins it, and the pin sustains the hang it was meant to
      // fix (self-feeding loop — ipn.2 shaft 33). Blocked falls back to
      // the takeoff floor instead; open backs off the face as before.
      const blocked = backBlocked(bot, bp, next) || !backFloor(bot, bp, next)
      dbg(blocked ? `unwedge-still vy=${vy}` : `unwedge vy=${vy}`)
      setC('forward', false); setC('jump', false); setC('sprint', false)
      if (blocked) {
        setC('back', false)
      } else {
        setC('back', true)
        try { setTimeout(() => setC('back', false), RET_AIR_BACK_MS) } catch (_) { /* timer best-effort */ }
      }
      retStall(bot, ctx, d, bp, next)
      return
    }
    dbg(`coast vy=${vy}`)
    // Pressed hover (ssn): a still-band hover OUTSIDE the crumb is pressed
    // to the face (an apex crosses the still band for one sample at most,
    // and falling leaves it within 150 ms) — holding forward grinds the
    // press and seeds the server snap storm, so release everything and let
    // the stall budget decide. Arcs (vy) fly through to the thrust below.
    if (!inCell(bp, next) && (d.retAirStall || 0) >= RET_AIR_TICKS) {
      dbg('coast-hover-brake')
      setC('forward', false); setC('back', false); setC('jump', false); setC('sprint', false)
      retStall(bot, ctx, d, bp, next)
      return
    }
    if (inCell(bp, next) && vy !== null && Math.abs(vy) < RET_AIR_VY) {
      // Over-crumb hover: brake. The held forward walks the step off
      // within one tick (ipn.2 shaft 33 walkoff: landed 48.3, +1.4 and
      // fell before the x2 still-band could pop) — braking holds the
      // hover still so the pop lands next tick. Arcs (vy) fly through.
      dbg('coast-brake')
      setC('forward', false); setC('back', false); setC('jump', false); setC('sprint', false)
      retStall(bot, ctx, d, bp, next)
      return
    }
    // Forward only: the leap impulse fired at takeoff, and a jump held
    // through the arc auto-fires on touchdown (physics cooldown) into an
    // unprimed run-up re-leap — the wqt-forbidden geometry (revmux 01).
    setC('forward', true); setC('back', false); setC('jump', false); setC('sprint', false)
    retStall(bot, ctx, d, bp, next)
    return
  }
  d.retAirStall = 0
  const distXZ = Math.hypot(next.x - bp.x, next.z - bp.z)
  if (next.y > Math.floor(bp.y)) {
    // Above: gap-zoned standstill leap. Far ticks walk in WITHOUT priming
    // (an unconditional prime backs between every two walks and the
    // back-glide outruns the walk advance at 250ms — net-away spiral).
    // Close unprimed ticks prime: settled primes in place (no back-off to
    // fall off a 1-deep step!), moving backs off only onto back-floor
    // (momentum would leap off-lane — wqt: 107 rejects), moving over air
    // waits the glide out (friction settles within a tick; backing off
    // would exit the step — ipn.2 shaft 33 double-back fall). Close primed
    // ticks settle, then rim/inch/leap.
    const fgap = Math.hypot(next.x + 0.5 - bp.x, next.z + 0.5 - bp.z) - 0.8 // TRUE face gap: center-dist minus half-cell minus half-width
    // Missing velocity reads as settled (kinematic mocks set positions
    // directly and carry no momentum).
    const hv = bot.entity && bot.entity.velocity && typeof bot.entity.velocity.x === 'number' && typeof bot.entity.velocity.z === 'number'
      ? Math.hypot(bot.entity.velocity.x, bot.entity.velocity.z) : 0
    if (fgap > RET_GAP_MAX) {
      dbg(`walk distXZ=${distXZ.toFixed(2)}`)
      d.primed = false
      setC('forward', true); setC('back', false); setC('sprint', false); setC('jump', false)
      retStall(bot, ctx, d, bp, next)
      return
    }
    if (!d.primed && hv > RET_SETTLE_VEL) {
      if (!backFloor(bot, bp, next) || backBlocked(bot, bp, next)) {
        dbg(`prime-wait fgap=${fgap.toFixed(2)} hvel=${hv.toFixed(2)}`)
        setC('forward', false); setC('back', false); setC('jump', false); setC('sprint', false)
        retStall(bot, ctx, d, bp, next)
        return
      }
      dbg(`prime fgap=${fgap.toFixed(2)}`)
      d.primed = true
      setC('forward', false); setC('jump', false); setC('sprint', false)
      setC('back', true); setC('sneak', true)
      try { setTimeout(() => { setC('back', false); setC('sneak', false) }, RET_GAP_BACK_MS) } catch (_) { /* timer best-effort */ }
      retStall(bot, ctx, d, bp, next)
      return
    }
    d.primed = true
    if (hv > RET_SETTLE_VEL) {
      dbg(`settle hvel=${hv.toFixed(2)}`)
      setC('forward', false); setC('back', false); setC('jump', false); setC('sprint', false)
      retStall(bot, ctx, d, bp, next)
      return
    }
    if (fgap < RET_GAP_MIN) {
      if (!riserAhead(bot, bp, next)) {
        // Dug-pocket rim: no feet-level face to hit low, so the zone
        // minimum does not apply — leap from contact (primed). Inching
        // here backs into whatever stands behind (often a wall: Paper
        // pins the back-off and the climb spins — ipn.2 assay pocket).
        dbg(`rim fgap=${fgap.toFixed(2)}`)
        d.primed = false
        setC('forward', true); setC('back', false); setC('sprint', false)
        setC('jump', true)
        try { setTimeout(() => setC('jump', false), RET_LEAP_JUMP_MS) } catch (_) { /* timer best-effort */ }
        retStall(bot, ctx, d, bp, next)
        return
      }
      if (!backFloor(bot, bp, next) || backBlocked(bot, bp, next)) {
        // Wedged: contact + solid face + no back-room (1-deep step edge or
        // rear wall). Backing exits/pins, leaping faceplants — release and,
        // once wedged AND static for 8 (a sliding body escapes on its own;
        // the stall counter proves stillness), fail early: recover owns the
        // escape, and the full 15-tick budget is just holding still. The
        // retStall poke runs first (one last resync before the handoff).
        dbg(`wedged fgap=${fgap.toFixed(2)}`)
        d.wedgedTicks = (d.wedgedTicks || 0) + 1
        setC('forward', false); setC('back', false); setC('jump', false); setC('sprint', false)
        retStall(bot, ctx, d, bp, next)
        if (d.wedgedTicks >= WEDGED_FAIL_TICKS && d.stalls >= WEDGED_FAIL_TICKS && ctx.stepStatus === 'running') {
          try { stuck.request(bot, ctx, 'deep', next, 'deep-return-up') } catch (_) { /* stuck best-effort */ }
          fail(bot, ctx, d, 'lost-shaft', next, 'lost the way back')
        }
        return
      }
      dbg(`inch fgap=${fgap.toFixed(2)}`)
      setC('forward', false); setC('jump', false); setC('sprint', false)
      setC('back', true); setC('sneak', true)
      try { setTimeout(() => { setC('back', false); setC('sneak', false) }, RET_GAP_BACK_MS) } catch (_) { /* timer best-effort */ }
      retStall(bot, ctx, d, bp, next)
      return
    }
    if (fgap <= RET_GAP_MAX) {
      dbg(`leap fgap=${fgap.toFixed(2)}`)
      d.primed = false
      setC('forward', true); setC('back', false); setC('sprint', false)
      setC('jump', true)
      // Timed release: takeoff lands within ~100ms (same-host server), the
      // arc lands ~600ms out — a jump held the whole 1s window auto-fires
      // on touchdown into an unprimed re-leap (revmux 01). A lag-cancelled
      // takeoff just primes again next tick (safe direction).
      try { setTimeout(() => setC('jump', false), RET_LEAP_JUMP_MS) } catch (_) { /* timer best-effort */ }
      retStall(bot, ctx, d, bp, next)
      return
    }
    // Unreachable (fgap is either > MAX, < MIN, or <= MAX) — walk on.
    dbg(`walk distXZ=${distXZ.toFixed(2)}`)
    d.primed = false
    setC('forward', true); setC('back', false); setC('sprint', false); setC('jump', false)
    retStall(bot, ctx, d, bp, next)
    return
  }
  // Level crumbs never reach manual drive (flat owns them; the old manual
  // takeover is deleted — a level servo hunts ±2 at 1Hz). Hold still
  // defensively so the stall budget fails honestly if ever reached.
  setC('forward', false); setC('back', false); setC('jump', false); setC('sprint', false)
  retStall(bot, ctx, d, bp, next)
}

// Direct-dig path check: the straight walk bp -> t stays in open tube
// (feet+head air, floor within DROP_MAX) on every cell EXCEPT t itself
// (the solid ore about to be dug). The ore's own lava/water/loose verdict
// lives with the caller (dig policy, not path).
function walkOpen(bot, bp, t) {
  const dist = dist3(bp, t)
  if (!(dist > 0) || dist > DIG_REACH) return false
  const y = Math.floor(Math.max(bp.y, t.y))
  const n = Math.max(1, Math.ceil(dist / 0.5))
  for (let i = 0; i <= n; i++) {
    const sx = Math.floor(bp.x + ((t.x - bp.x) * i) / n)
    const sz = Math.floor(bp.z + ((t.z - bp.z) * i) / n)
    if (sx === t.x && y === t.y && sz === t.z) continue
    const feet = fname(bot, sx, y, sz)
    const head = fname(bot, sx, y + 1, sz)
    if (feet === null || head === null) return false
    if (!isAirName(feet) || !isAirName(head)) return false
    if (dropBelow(bot, sx, y, sz) > DROP_MAX) return false
  }
  return true
}

// Solid feet-level cell on the leap line to the crumb (liquids are
// walkable-through, not risers). Inch-gate only: below-zone leaps are
// safe with open face (nothing to hit low), suicidal into a riser. The
// sample reaches 0.75 along the CENTER ray (the aim/leap direction): a
// 0.4 sample lands in the body's own cell whenever the fraction exceeds
// 0.4, reads air, and fires a rim-leap into the face (ipn.2 assay: +0.4
// pins on plain stairs). 0.75 clears bbox 0.3 + zone 0.25 with margin
// yet never exits a 1-wide face cell.
// Floor within 1 down behind the body (a back-off landing: 0 = same level,
// 1 = step down and back up). Guards prime/inch/unwedge back-offs on 1-deep
// steps (backing off exits the step and the climb falls 2-below — ipn.2
// shaft 33). Feet-null reads as missing (strict: settle instead). Sampled
// a full block back (a 50ms hold + 250ms glide travels 0.5-0.9).
// Back samples read at the motion horizon (0.5), not a full block: backs
// move 0.36 (sneak-400), so a 1.0 sample reads the wall 0.7 past the zone
// and wedges pockets the climb could back out of (ipn.2 tunnel pocket
// 55,-51: zone at 0.4 back, wall at 1.0 — 1.0-vision pinned it).
const BACK_SAMPLE_DIST = 0.5
// Climb aim (ssn): ONE axis-locked direction shared by the look and every
// sampler. Aiming at the crumb CENTER from an off-center body adds a
// sideways drift into the tube wall (ssn rig: z=-201.7 aim → -z drift →
// server "moved wrongly" snap storm → the snap-ratchet eats every back and
// leap: 0.0 m in 1.5 s, 29 snaps; centered: -1.3 m free, 6 snaps). The
// dominant axis runs parallel to the wall (no press, no snaps); the
// deadband keeps true diagonals on the true ray (axis-pure can never close
// a >=0.5 minor offset, so corners keep the old geometry).
const AIM_DEADBAND = 0.35
function aimDir(bp, next) {
  const dx = next.x + 0.5 - bp.x
  const dz = next.z + 0.5 - bp.z
  const len = Math.hypot(dx, dz)
  if (len < 0.05) return null
  if (Math.abs(dx) >= Math.abs(dz)) {
    if (Math.abs(dz) < AIM_DEADBAND) return { dx: dx > 0 ? 1 : -1, dz: 0 }
  } else if (Math.abs(dx) < AIM_DEADBAND) {
    return { dx: 0, dz: dz > 0 ? 1 : -1 }
  }
  return { dx: dx / len, dz: dz / len }
}
function backFloor(bot, bp, next) {
  const ad = aimDir(bp, next)
  if (!ad) return false
  const bx = Math.floor(bp.x - ad.dx * BACK_SAMPLE_DIST)
  const bz = Math.floor(bp.z - ad.dz * BACK_SAMPLE_DIST)
  const y = Math.floor(bp.y)
  if (fname(bot, bx, y, bz) === null) return false
  return dropBelow(bot, bx, y, bz) <= 1
}

// NOTE (ssn): the ghostDig/ghostBreak START+CANCEL escalation lived here.
// Deleted: 0-for-16 across five rig legs (every firing followed by an
// unchanged pin and an honest fail), RCON server-truth agrees with the
// client on every pin cell (no block ghost to break), and the pin/faceplant
// mechanism is the aim-drift snap-ratchet (see aimDir), which no dig packet
// addresses. The unfreeze resync poke stays (independent 2/2 evidence).

// Solid feet-or-head cell on the back-off line (away from the crumb along
// the aim ray), a full block back. Null reads as clear (the tubeClean
// precedent); liquids are open (backing into water is fine).
function backBlocked(bot, bp, next) {
  const ad = aimDir(bp, next)
  if (!ad) return false
  for (const dy of [0, 1]) {
    const n = fname(bot, Math.floor(bp.x - ad.dx * BACK_SAMPLE_DIST), Math.floor(bp.y) + dy, Math.floor(bp.z - ad.dz * BACK_SAMPLE_DIST))
    if (n === null || isAirName(n) || n === 'water' || n === 'lava') continue
    return true
  }
  return false
}

function riserAhead(bot, bp, next) {
  const ad = aimDir(bp, next)
  if (!ad) return false
  const n = fname(bot, Math.floor(bp.x + ad.dx * 0.75), Math.floor(bp.y), Math.floor(bp.z + ad.dz * 0.75))
  if (n === null || isAirName(n)) return false
  return n !== 'water' && n !== 'lava'
}

// One standable mid-step 1-up from the body toward a multi-up crumb (ssn
// gap fill). Strict reads: feet+head must be KNOWN air, the floor KNOWN
// solid (a fill onto a ghost floor strands the latch). Nearest-to-crumb
// wins (progress-directed). Null when the shaft is air.
function fillMid(bot, bp, next) {
  const y = Math.floor(bp.y) + 1
  let best = null
  let bestD = Infinity
  for (let ox = -1; ox <= 1; ox++) {
    for (let oz = -1; oz <= 1; oz++) {
      const cx = Math.floor(bp.x) + ox
      const cz = Math.floor(bp.z) + oz
      if (Math.hypot(cx + 0.5 - bp.x, cz + 0.5 - bp.z) > 1.5) continue
      const feet = fname(bot, cx, y, cz)
      const head = fname(bot, cx, y + 1, cz)
      const floor = fname(bot, cx, y - 1, cz)
      if (feet === null || !isAirName(feet)) continue
      if (head === null || !isAirName(head)) continue
      if (floor === null || !isSolidName(floor)) continue
      const dd = Math.hypot(cx - next.x, cz - next.z)
      if (dd < bestD) { bestD = dd; best = { x: cx, y, z: cz } }
    }
  }
  return best
}

// Paper open-air freeze / ghost-block wedge (muse-5 prod-world rig 2/2):
// a dig-START on the block underfoot, cancelled shortly after (block
// intact), restores movement. Raw packets, not bot.dig: bot.dig awaits
// lookAt before START, so a sync start+abort would either noop or escape
// into a real dig — packets land in order and touch no dig task. The
// START must LIVE briefly: a same-tick START+CANCEL is ignored server-side
// (ipn.2 assay: fired, still frozen). 150 ms is far below any underfoot
// dig time down here (dirt/gravel slowest ≈ 0.75 s+). Never while a real
// dig runs (targetDigBlock), never over air; the delayed CANCEL stands
// down if a real dig started meanwhile (don't steal its abort).
const UNFREEZE_ABORT_MS = 150
const WEDGED_FAIL_TICKS = 8 // wedged ticks before the honest fail (recover owns the escape; the stall budget would take 15)
function unfreeze(bot, extra) {
  try {
    if (!bot || typeof bot._client === 'undefined' || bot._client === null) return false
    if (typeof bot._client.write !== 'function') return false
    if (bot.targetDigBlock) return false
    const bp = botPos(bot)
    if (!bp) return false
    const targets = []
    const under = bot.blockAt && bot.blockAt(new Vec3(Math.floor(bp.x), Math.floor(bp.y) - 1, Math.floor(bp.z)))
    if (under && under.position && under.name !== 'air' && under.name !== 'cave_air') targets.push(under.position)
    for (const c of (Array.isArray(extra) ? extra : [])) {
      if (!c || typeof c.x !== 'number') continue
      let b = null
      try { b = bot.blockAt && bot.blockAt(new Vec3(c.x, c.y, c.z)) } catch (_) { b = null }
      if (b && b.position) targets.push(b.position) // client-air included: a ghost IS server-solid
    }
    if (targets.length === 0) return false
    for (const at of targets) bot._client.write('block_dig', { status: 0, location: at, face: 1 })
    try {
      setTimeout(() => {
        try {
          if (bot.targetDigBlock) return
          for (const at of targets) bot._client.write('block_dig', { status: 1, location: at, face: 1 })
        } catch (_) { /* abort best-effort */ }
      }, UNFREEZE_ABORT_MS)
    } catch (_) { /* timer best-effort */ }
    console.log(`deep unfreeze at ${targets.map((t) => `${t.x},${t.y},${t.z}`).join(' ')}`)
    return true
  } catch (_) {
    return false
  }
}

// Cells around the stuck body worth resync-poking: the feet/head column
// (ghosts the bbox overlaps) plus one block ahead toward the goal at both
// levels (ghosts in the path). Client-air included by design.
function pokeCells(bp, next) {
  const cells = [
    { x: Math.floor(bp.x), y: Math.floor(bp.y), z: Math.floor(bp.z) },
    { x: Math.floor(bp.x), y: Math.floor(bp.y) + 1, z: Math.floor(bp.z) },
  ]
  if (next && typeof next.x === 'number') {
    const dx = next.x - bp.x
    const dz = next.z - bp.z
    const len = Math.hypot(dx, dz)
    if (len >= 0.05) {
      const ax = Math.floor(bp.x + (dx / len) * 1.0)
      const az = Math.floor(bp.z + (dz / len) * 1.0)
      const y = Math.floor(bp.y)
      cells.push({ x: ax, y, z: az }, { x: ax, y: y + 1, z: az })
    }
  }
  return cells
}

function retStall(bot, ctx, d, bp, next) {
  const last = d.retStallPos
  // Net progress toward the crumb: jiggle-in-place (leap-back cycles that
  // displace without closing) defeats the displacement stall counter, so
  // the unfreeze also triggers on progress drought.
  const dc = dist3(bp, next)
  if (dc < (typeof d.retProgBest === 'number' ? d.retProgBest : Infinity) - PROG_EPS) {
    d.retProgBest = dc
    d.retProgTicks = 0
  } else {
    d.retProgTicks = (d.retProgTicks || 0) + 1
  }
  if (last && Math.hypot(bp.x - last.x, bp.z - last.z) > 0.05) {
    d.stalls = 0
    d.retStallPos = { x: bp.x, z: bp.z }
  } else if (++d.stalls >= RETURN_STALL) {
    try { stuck.request(bot, ctx, 'deep', next, 'deep-return-up') } catch (_) { /* stuck best-effort */ }
    fail(bot, ctx, d, 'lost-shaft', next, 'lost the way back')
    return
  }
  if (d.retPokeCool > 0) d.retPokeCool--
  const pokeDue =
    (d.stalls >= UNFREEZE_TICKS && d.stalls % UNFREEZE_TICKS === 0) ||
    (d.retProgTicks >= UNFREEZE_TICKS && d.retProgTicks % UNFREEZE_TICKS === 0)
  if (!(d.retPokeCool > 0) && pokeDue) {
    // Mid-budget static (or circling) in manual drive: frozen or
    // ghost-wedged, not merely slow — re-poke every 8 static ticks
    // (ghosts recur; packets are cheap, blocks unbroken (guarded
    // CANCEL)), then the budget decides. The cooldown (not a latch)
    // stops the off-by-one double-fire: prog trails stalls by one, so
    // both counters hit 8 on adjacent ticks.
    d.retPokeCool = UNFREEZE_TICKS
    unfreeze(bot, pokeCells(bp, next))
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
  d.tunnelGoal = null
  d.phase = 'plan'
}

module.exports = deep
module.exports.TARGET_Y = TARGET_Y
module.exports.FLOOR_Y = FLOOR_Y
module.exports.TUNNEL_MAX = TUNNEL_MAX
module.exports.DEEP_WANT = DEEP_WANT
module.exports.PRESCAN_STEPS = PRESCAN_STEPS
module.exports.waterNear = waterNear
module.exports.fallingAbove = fallingAbove
module.exports.lavaNear = lavaNear
module.exports.dropBelow = dropBelow
module.exports.landingHazard = landingHazard
module.exports.pickSite = pickSite
module.exports.pickDir = pickDir
module.exports.stairCells = stairCells
module.exports.tunnelNext = tunnelNext
module.exports.unfreeze = unfreeze
module.exports.aimDir = aimDir
