'use strict'

// Home and site geometry, moved verbatim out of goal.js (idkcraft-oqul.4):
// the house budget, the home shape, ground reading, site choice, the v1/v2
// corner probe and the clock word. Behaviours read it without loading the
// arbiter. goal.js re-exports the same names.

const Vec3 = require('vec3')
const { CLEAR_FLORA } = require('./behaviours/util')
const { NEED_PLANKS, NEED_PLANKS_V1 } = require('./budget')

function needPlanks(home) {
  if (home && home.site && home.v !== 2) return NEED_PLANKS_V1
  return NEED_PLANKS
}

// Home site shape (bead .4, two blueprints since jr2.1): site is the
// SW-corner origin at ground level, interior the standable box inside,
// door the LOWER door cell, table the workbench cell — null until the
// workbench is really placed. rw4.3 treats ctx.home.table as a PLACED
// station (craft walks to it and crafts the door at it), so claiming the
// coords early would deadlock craft at an empty cell; build claims them
// the tick the table cell lands. v marks the blueprint (1: 4x4 hut with
// the table outside; 2: 7x6 house with the rooms inside); new sites are
// always founded v2, v1 comes only from adopting an old house.
function makeHome(ox, oy, oz, v) {
  if (v === 1) {
    return {
      site: { x: ox, y: oy, z: oz },
      interior: { min: { x: ox + 1, y: oy, z: oz + 1 }, max: { x: ox + 2, y: oy + 1, z: oz + 2 } },
      door: { x: ox + 1, y: oy, z: oz },
      table: null,
      built: false,
      v: 1,
    }
  }
  return {
    site: { x: ox, y: oy, z: oz },
    interior: { min: { x: ox + 1, y: oy, z: oz + 1 }, max: { x: ox + 5, y: oy + 1, z: oz + 4 } },
    door: { x: ox + 3, y: oy, z: oz },
    table: null,
    built: false,
    v: 2,
  }
}

// Feet level of the ground column: first non-air block from topY down, plus
// one. Null when the column never resolves (unloaded chunk) or when the
// first hit is surface liquid — water is not ground (idkcraft-vmzq.12):
// the prod shore site read the water surface as ground and founded over
// dips. The liquid set mirrors flat.isLiquidName; name-based rather than
// boundingBox so fakes and mineflayer agree (real water reports 'empty').
// Built surfaces read the same null (idkcraft-vmzq.14): a house roof is
// 42 flat columns and the site would found on top (rig: FRESH roofed at
// y=75 and stalled). Mirrors castle FOREIGN — somebody's structure, not
// terrain. Cobble/stone huts are not in the set (accepted tail: a stone
// roof still founds; the bead covers plank roofs and own-house cells).
const BUILT_GROUND = /(planks|_door$|_bed$|fence|glass|crafting_table|chest|furnace|brick|wool|stairs|_slab$|_sign$|barrel|ladder|torch|(?<!moss_)carpet|concrete|bookshelf|_wall$)/
function groundY(bot, x, z, topY) {
  for (let y = topY; y > topY - 32; y--) {
    let b = null
    try {
      b = bot.blockAt(new Vec3(x, y, z))
    } catch (_) {
      return null
    }
    if (!b || !b.name || b.name === 'air') continue
    if (b.name === 'water' || b.name === 'lava' || b.name === 'bubble_column') return null
    if (BUILT_GROUND.test(b.name)) return null
    // Clearable flora reads through to the dirt below (revmux 02 major):
    // one- and two-tall flowers would add relief 2 and refuse a flat
    // meadow, but the build digs them. CLEAR_FLORA is exactly the
    // build-clearable set minus the torch (which rejects above). Leaves
    // and logs still count — reading past a canopy would found a
    // forest-floor site whose wall cells bury in logs, which nothing
    // clears, so the overhang deflects to the next footprint instead.
    if (CLEAR_FLORA.has(b.name)) continue
    return y + 1
  }
  return null
}

// Solid support under a column (idkcraft-neuc.65.6.2): the n blocks
// y0-1..y0-n are all non-air, non-liquid. groundY stops at the first
// block, so a 1-block crust over a cave read like a meadow (prod v2 house
// -88 88 -3 founded over a y 80-86 void; the doorstep and floor later fell
// through). Unloaded (blockAt throws or null) refuses, like groundY.
const AIRISH = new Set(['air', 'cave_air', 'void_air'])
function solidBelow(bot, x, z, y0, n) {
  for (let y = y0 - 1; y >= y0 - n; y--) {
    let b = null
    try { b = bot.blockAt(new Vec3(x, y, z)) } catch (_) { return false }
    if (!b || !b.name || AIRISH.has(b.name)) return false
    if (b.name === 'water' || b.name === 'lava' || b.name === 'bubble_column') return false
  }
  return true
}
const SOLID_BELOW = 3

// 8 candidate origins around `around` at radius 6 (bead .4).
const SITE_DIRS = [[6, 0], [4, 4], [0, 6], [-4, 4], [-6, 0], [-4, -4], [0, -6], [4, -4]]

// Pick a flat 7x6 site (jr2.1 blueprint): all 42 columns resolve and lie
// within one block. First fit wins; anything else refuses (null) —
// uneven, wet or unloaded footprints are never founded (idkcraft-vmzq.12:
// the prod shore site came from the old blind fallback, and the build
// clears only flora, so relief would bury wall cells and fill buildSkip).
// The caller waits (chunks load, the next attempt validates) or refuses
// honestly. The JR-BUILD slope rig is safe: its skip-0 baseline proves
// the footprint wins this loop, the fallback never fired there.
// `accept` (optional, neuc.32) vetoes a fit so the next direction is tried.
function siteFor(bot, around, accept) {
  if (!around || typeof around.x !== 'number' || typeof around.z !== 'number') return null
  const cx = Math.floor(around.x)
  const cz = Math.floor(around.z)
  const cy = typeof around.y === 'number' ? Math.floor(around.y) : 64
  for (const [dx, dz] of SITE_DIRS) {
    const ox = cx + dx
    const oz = cz + dz
    const ys = []
    let ok = true
    for (let ix = 0; ix < 7 && ok; ix++) {
      for (let iz = 0; iz < 6 && ok; iz++) {
        const gy = groundY(bot, ox + ix, oz + iz, cy + 8)
        if (gy == null || !solidBelow(bot, ox + ix, oz + iz, gy, SOLID_BELOW)) { ok = false; break }
        ys.push(gy)
      }
    }
    if (!ok || ys.length !== 42) continue
    const y0 = Math.min(...ys)
    if (!ys.every((y) => y === y0 || y === y0 + 1)) continue
    // The door hangs at y0 and the build clears only flora
    // (idkcraft-vmzq.36): a relief-1 bump under the door column buries
    // the door cell in solid terrain — place refuses, 3 strikes skip
    // it, and the step fails failed:skipped-cells (JR-BUILD TIMEOUT on
    // the R3 meadow fit, whose door sat on pristine grass_block). Flora
    // over flat dirt still reads y0, so the R3 meadow keeps accepting.
    if (groundY(bot, ox + 3, oz + 0, cy + 8) !== y0) continue
    // Doorstep row (outsidePos and flanks, neuc.65.6.2): the walk-in
    // cells must not be a crust either.
    if (![2, 3, 4].every((ix) => solidBelow(bot, ox + ix, oz - 1, y0, SOLID_BELOW))) continue
    const home = makeHome(ox, y0, oz, 2)
    if (accept && !accept(home, cy + 8)) continue
    return home
  }
  return null
}

// Open sky over a site (neuc.32): every footprint column reads air (or
// clearable flora) from its ground up to SKY_CLEAR above the floor. Rock
// read as ground at the scan top (underground), a cave ceiling, a canopy
// or an overhang all refuse; unloaded cells refuse too.
const SKY_CLEAR = 16
const TREE_TOP = /(_leaves|_log|_wood|mushroom_block)$/
function skyOpen(bot, home, topY) {
  const { x: ox, y: y0, z: oz } = home.site
  for (let ix = 0; ix < 7; ix++) {
    for (let iz = 0; iz < 6; iz++) {
      const gy = groundY(bot, ox + ix, oz + iz, topY)
      if (gy == null || gy > y0 + 1) return false // a canopy read as ground
      for (let y = gy - 1; y <= y0 + SKY_CLEAR; y++) {
        let b = null
        try { b = bot.blockAt(new Vec3(ox + ix, y, oz + iz)) } catch (_) { return false }
        if (!b || !b.name) return false
        // The floor block: a flat canopy top is not ground (revmux 01).
        if (y === gy - 1) { if (TREE_TOP.test(b.name)) return false; continue }
        if (b.name !== 'air' && !CLEAR_FLORA.has(b.name)) return false
      }
    }
  }
  return true
}

// Homeless bot under cover (neuc.32: prod v2 sat under a lake bed at
// 44,58,-20, every scan at the body read water and the shore site was 3
// above the feet): the nearest open-sky site on rings around the body —
// the body itself, then anchors 12..64 out (neuc.35: 36/48/64 added for a
// canopy or relief with no open site within ~30). Unloaded footprints
// refuse, so the far rings only find what the client has loaded.
// ponytail: up to 41 siteFor scans per call; build calls it only while
// homeless, the goal.js hold probe caches it (SKY_PROBE_MS).
const SKY_RINGS = [12, 24, 36, 48, 64]
function skySiteNear(bot, p) {
  if (!p || typeof p.x !== 'number' || typeof p.z !== 'number') return null
  const accept = (home, topY) => skyOpen(bot, home, topY)
  const near = siteFor(bot, p, accept)
  if (near) return near
  for (const r of SKY_RINGS) {
    for (const [dx, dz] of SITE_DIRS) {
      const s = siteFor(bot, { x: p.x + dx * r / 6, y: p.y, z: p.z + dz * r / 6 }, accept)
      if (s) return s
    }
  }
  return null
}

// Nearest open-sky standable cell (neuc.35): the target of the build
// no-site walk when the body is deep in a cave (siteFor scans only 8
// above the feet, so the surface is out of its reach). Columns on rings
// 0..64 around the body read from SKY_SCAN_UP above the feet down to 24
// below: the top cell must be air (inside a mountain the sky is unknown),
// the first non-air non-flora block is the surface; liquid, built or
// tree-top surfaces and unloaded columns refuse. Null when none.
const SKY_SCAN_UP = 48
const SKY_CELL_RINGS = [0, 8, 16, 24, 32, 48, 64]
function skyCellNear(bot, p) {
  if (!p || typeof p.x !== 'number' || typeof p.z !== 'number' || typeof p.y !== 'number') return null
  const top = Math.floor(p.y) + SKY_SCAN_UP
  const column = (x, z) => {
    for (let y = top; y > Math.floor(p.y) - 24; y--) {
      let b = null
      try { b = bot.blockAt(new Vec3(x, y, z)) } catch (_) { return null }
      if (!b || !b.name) return null
      if (b.name === 'air' || CLEAR_FLORA.has(b.name)) continue
      if (y === top) return null
      if (b.name === 'water' || b.name === 'lava' || b.name === 'bubble_column') return null
      if (BUILT_GROUND.test(b.name) || TREE_TOP.test(b.name)) return null
      return { x, y: y + 1, z }
    }
    return null
  }
  for (const r of SKY_CELL_RINGS) {
    for (const [dx, dz] of r === 0 ? [[0, 0]] : SITE_DIRS) {
      const c = column(Math.floor(p.x + dx * r / 6), Math.floor(p.z + dz * r / 6))
      if (c) return c
    }
  }
  return null
}

// True when planks stand at the v2 corner columns around the door at
// (dx,dy,dz); false for a v1 hut; null when any probe cell is unreadable.
// Shape: EITHER front corner column plus EITHER back corner column. One
// column reads planks at either wall level (a skipped ground cell still
// carries its upper ring — unless the upper skipped as no-ref too, which
// the single-skip cascade in the lay order does cause). A single missing
// column must never flip the version: with both fronts required, one
// refused corner (mob in the cell, terrain jut) plus its no-ref upper
// would read a v2 house as v1 and run the v1 repair plan at the wrong
// origin. A lone v1 hut still reads air at all four columns. Accepted
// residual: a house with a whole side (both fronts or both backs) empty
// reads v1 — a catastrophic build no corner probe can save.
function isV2House(bot, dx, dy, dz) {
  try {
    const ox = dx - 3
    const oz = dz
    const colPlanks = (cx, cz) => {
      let lo = null
      let hi = null
      try {
        lo = bot.blockAt(new Vec3(ox + cx, dy, oz + cz))
        hi = bot.blockAt(new Vec3(ox + cx, dy + 1, oz + cz))
      } catch (_) {
        return null
      }
      if (!lo || !hi) return null
      const planks = (b) => !!b && typeof b.name === 'string' && b.name.endsWith('_planks')
      return planks(lo) || planks(hi)
    }
    const frontW = colPlanks(0, 0)
    const frontE = colPlanks(6, 0)
    const backW = colPlanks(0, 5)
    const backE = colPlanks(6, 5)
    if (frontW == null || frontE == null || backW == null || backE == null) return null
    return (frontW || frontE) && (backW || backE)
  } catch (_) {
    return null
  }
}

// MC clock word (rw4.15): null when the clock is unreadable — call sites
// choose their own unknown (goalFacts reads day, the day-shelter divert
// needs positive day, the gohome arrival line chats).
function timeWord(bot) {
  let timeOfDay = NaN
  try {
    timeOfDay = bot && bot.time && typeof bot.time.timeOfDay === 'number' ? bot.time.timeOfDay : NaN
  } catch (_) { /* unknown below */ }
  if (!(timeOfDay >= 0)) return null
  return timeOfDay < 12000 ? 'day' : timeOfDay <= 13000 ? 'dusk' : 'night'
}

module.exports = { needPlanks, makeHome, groundY, solidBelow, BUILT_GROUND, SITE_DIRS, siteFor, skyOpen, skySiteNear, skyCellNear, isV2House, timeWord }
