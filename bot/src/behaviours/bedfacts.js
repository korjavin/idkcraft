'use strict'

// bedfacts: pure bedroom reads (oqul.13) — cells, placed truth, ground
// patches owed. Split out of beds.js so stockpile/equip read them without
// requiring the beds step (that edge closed the stockpile<->beds<->craftany
// require cycles). beds.js re-exports everything here; no behaviour change.

const Vec3 = require('vec3')
const buildMod = require('./build')
const residence = require('../residence')

const DIRS = [[0, -1], [1, 0], [0, 1], [-1, 0]]

// Canonical bedroom cells { foot, head, stage, facing }: A is the bot's
// (sleep sets the respawn), B the owner's. The geometry lives in
// residence.js (g0z.28); home.js sleep reads it through a deferred require.
function cellsOf(home) {
  const [a, b] = residence.of(home).beds(home)
  return { a, b }
}

// A home with bedrooms (the v2 house; the v1 hut has none).
function bedded(home) {
  return !!home && !!home.site && residence.of(home).beds(home).length > 0
}

// Bedroom footprint test (idkcraft-4nx): the bed cells of the residence.
// Furniture stations (equip's roadside table, stockpile's chest) must never
// land here — beds.js fails loud on blocked cells (blocked by X) by design,
// so the placer avoids them instead of the bed step digging furniture out.
// v1 homes have no bedrooms: always false.
function isBedroomCell(home, x, y, z) {
  try {
    if (!bedded(home)) return false
    if (typeof x !== 'number' || typeof y !== 'number' || typeof z !== 'number') return false
    return residence.of(home).beds(home).some((b) => [b.foot, b.head].some((c) => c.x === x && c.y === y && c.z === z))
  } catch (_) {
    return false
  }
}

function blockNameAt(bot, p) {
  try {
    const b = bot.blockAt && bot.blockAt(p)
    return b && typeof b.name === 'string' ? b.name : null
  } catch (_) {
    return null
  }
}

// The foot block when a whole bed stands on foot + facing (east for the
// house), else null (half beds and dark chunks read as no bed — sleep
// refuses halves, dark re-reads).
function bedAt(bot, foot, facing = 1) {
  try {
    const f = bot.blockAt && bot.blockAt(foot)
    if (!f || typeof f.name !== 'string' || !f.name.endsWith('_bed')) return null
    const [ox, oz] = DIRS[(facing | 0) % 4]
    const h = blockNameAt(bot, new Vec3(foot.x + ox, foot.y, foot.z + oz))
    if (!h || !h.endsWith('_bed')) return null
    return f
  } catch (_) {
    return null
  }
}

// Claim-aware placed truth, pure (never writes): a claim the world still
// shows stands; a dark chunk trusts its claim; otherwise the canonical
// cells scan.
function bedStands(bot, home, cells, k, key) {
  const claim = home[key]
  if (claim && typeof claim.x === 'number') {
    let f = null
    let loaded = false
    try {
      const b = bot.blockAt && bot.blockAt(new Vec3(claim.x, claim.y, claim.z))
      if (b) { loaded = true; f = b }
    } catch (_) { loaded = false }
    if (!loaded) return true
    if (f && typeof f.name === 'string' && f.name.endsWith('_bed') &&
      bedAt(bot, new Vec3(claim.x, claim.y, claim.z), cells[k].facing)) return true
  }
  return !!bedAt(bot, cells[k].foot, cells[k].facing)
}

// Ground a bed can stand on: the v2 house lays no floor, so the bedroom row
// sits on natural terrain — and terrain dips (rig-proven: air under A-foot
// while B stood). Air-like, water, and flora ground takes a plank patch
// before the bed; lava refuses loud (a patch would burn).
const AIR_LIKE = ['air', 'cave_air', 'void_air']
function needsFillGround(name) {
  if (!name || AIR_LIKE.includes(name) || name === 'water') return true
  try { if (buildMod.isReplaceable(name)) return true } catch (_) { /* solid: no patch */ }
  return false
}

// Patches owed under the feet+heads of unplaced beds (0-4, loaded cells
// only — dark is unknown, not owed): the stockpile plank reserve and the
// place pre-check count against this.
function fillNeed(bot, home) {
  try {
    if (!bedded(home)) return 0
    const cells = cellsOf(home)
    let n = 0
    for (const k of ['a', 'b']) {
      if (bedStands(bot, home, cells, k, k === 'a' ? 'bedA' : 'bedB')) continue
      for (const end of [cells[k].foot, cells[k].head]) {
        const g = blockNameAt(bot, new Vec3(end.x, end.y - 1, end.z))
        if (g !== null && needsFillGround(g)) n++
      }
    }
    return n
  } catch (_) { return 0 }
}

// Pure placed truth for goalFacts (never writes): claims verify-or-trust,
// unclaimed cells scan. Non-v2 homes owe no beds.
function bedsFact(bot, home) {
  try {
    if (!bedded(home)) return 'both'
    const cells = cellsOf(home)
    const a = bedStands(bot, home, cells, 'a', 'bedA')
    const b = bedStands(bot, home, cells, 'b', 'bedB')
    return a && b ? 'both' : a || b ? 'one' : 'none'
  } catch (_) {
    return 'both' // unreadable: beds yields, nothing churns
  }
}

module.exports = { DIRS, cellsOf, bedded, isBedroomCell, blockNameAt, bedAt, bedStands, needsFillGround, fillNeed, bedsFact }
