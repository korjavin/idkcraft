'use strict'

// Farm blueprint (idkcraft-qphv.1): a house-style plan (behaviours/build.js
// cells {dx,dy,dz,kind}, LAY ORDER) laid by the house builder on a
// home of kind 'farm'. One 27x9 strip, origin = SW corner at ground level:
//   x 0..6   barn: 7x6, walls 2 high, flat roof, door (3,0,0), chest inside
//            at (5,0,4); the free interior holds hay bales later;
//   x 8..16  pen: 9x9 fence ring at ground level, gate at (12,0,0) (.3 keeps animals);
//   x 18..26 field: 9x9 farmland at dy -1 around one water cell (22,-1,4).
// 'clear' cells dig natural ground (bumps, the water pit) and are no work in
// the progress count; 'farmland' is tilled with a hoe, 'water' poured from a bucket.
// Site (qphv: prod bot5 failed no-site 49 times on a flat-only rule): the
// cheapest footprint within RADIUS, graded by prep cells (castle prep
// pattern: cut above grade, fill below) laid before the barn.

const { PLAN, W, D, DOOR, GATE, WATER, BARN, PEN, FIELD, inField, protects, inFieldAt } = require('./farm-plan')

const survey = require('./structure-site')
const footprint = { w: W, d: D, needsSoil: inField, omitSoil: (x, z) => x === WATER.dx && z === WATER.dz }

function footprintCost(col, x, z) {
  return survey.footprintCost(col, x, z, footprint)
}

function pickSite(bot, around, avoid = [], skipWalk = null) {
  return survey.pickSite(bot, around, { ...footprint, avoid, skipWalk })
}

function siteFor(bot, around, avoid) { return pickSite(bot, around, avoid).site }

// The farm's plan on its site: prep cells first, then the static PLAN.
const PLANS = new WeakMap()
function planFor(fb) {
  const prep = fb && fb.site && fb.site.prep
  if (!Array.isArray(prep) || !prep.length) return PLAN
  if (!PLANS.has(prep)) PLANS.set(prep, [...prep, ...PLAN])
  return PLANS.get(prep)
}

// Prep cells for a stored site (memory keeps only x,y,z): re-read the footprint at its grade y.
function prepAt(bot, site) {
  const cols = new Map()
  const col = (x, z) => { const k = `${x},${z}`; if (!cols.has(k)) cols.set(k, survey.column(bot, x, z, site.y + 8)); return cols.get(k) }
  const f = footprintCost(col, site.x, site.z)
  // unloaded: null (retry when near); built (own barn/fence already up) or other: no prep, build on
  if (f.bad === 'unloaded') return null
  return f.bad ? [] : survey.prepCells(f.cs, site.y, footprint)
}

module.exports = { prepAt, protects, inFieldAt, PLAN, W, D, DOOR, GATE, WATER, BARN, PEN, FIELD, siteFor, pickSite, planFor, footprintCost }
