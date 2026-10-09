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
function siteFor(bot, around) {
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
        if (gy == null) { ok = false; break }
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
    return makeHome(ox, y0, oz, 2)
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

module.exports = { needPlanks, makeHome, groundY, BUILT_GROUND, SITE_DIRS, siteFor, isV2House, timeWord }
