'use strict'

// sitebed: the castle spawn bed (idkcraft-vmzq.33, minimal take). Prod run 8
// lost 83 min to world-spawn walkbacks (7 deaths, beds=none): this step
// exists only to prevent that. When the bot HAS a bed — the pack, or the
// adopted home chest already within reach (no walks, no hunts, no crafts,
// no sleep goal) — it places the bed outside the castle footprint and off
// the door path, clicks it to set the spawn, and finishes. Without a bed
// the step is infeasible by construction, so the castle chain decides
// exactly as master.

const Vec3 = require('vec3')
const { goals } = require('mineflayer-pathfinder')
const bedMod = require('./bed')
const bedsMod = require('./beds')
const stockpileMod = require('./stockpile')
const blueprint = require('../castle')
const castleMod = require('./castle')
const flatMod = require('./flat')
const { botPos, isInteractRef } = require('./util')

const BED16 = bedMod.BED_COLORS.map((c) => `${c}_bed`)
const AIR = new Set(['air', 'cave_air', 'void_air'])
const PLACE_REFUSALS = 3 // dead spots before the day yields (tomorrow retries)
const STALL_TICKS = 30 // no walk progress before the spot drops
const YAW_EAST = -Math.PI / 2 // head lands +x, the beds.js forced yaw

function blockNameAt(bot, p) {
  try {
    const b = bot.blockAt && bot.blockAt(p)
    return b && typeof b.name === 'string' ? b.name : null
  } catch (_) {
    return null
  }
}

function dayNum(bot) {
  try {
    return bot && bot.time && typeof bot.time.day === 'number' ? bot.time.day : -1
  } catch (_) {
    return -1
  }
}

// A claimed site bed the world still shows (dark chunks trust the claim).
function siteBedStands(bot, ctx) {
  try {
    const st = ctx && ctx.castle
    const claim = st && st.siteBed
    if (!claim || typeof claim.x !== 'number') return false
    const foot = new Vec3(claim.x, claim.y, claim.z)
    let loaded = false
    try {
      if (bot.blockAt && bot.blockAt(foot)) loaded = true
    } catch (_) { loaded = false }
    if (!loaded) return true
    return !!bedsMod.bedAt(bot, foot)
  } catch (_) {
    return false
  }
}

function bedInPack(bot) {
  try {
    return bedMod.bedInPack(bedMod.packCounts(bot))
  } catch (_) {
    return false
  }
}

// The adopted home chest within arm's reach (no walks to it, ever).
function chestNear(bot, ctx) {
  try {
    const c = ctx && ctx.home && ctx.home.chest
    if (!c || typeof c.x !== 'number') return false
    const bp = botPos(bot)
    if (!bp) return false
    const reach = stockpileMod.INTERACT_REACH || 4
    return Math.hypot(bp.x - c.x, bp.y - c.y, bp.z - c.z) <= reach
  } catch (_) {
    return false
  }
}

// A bed is had: the pack, or a near adopted chest (contents read on pull).
function bedReady(bot, ctx) {
  try {
    if (bedInPack(bot)) return true
    return chestNear(bot, ctx)
  } catch (_) {
    return false
  }
}

// Nearest foot cell 2..5 rings out of the site box, outside the footprint
// and off the door path, foot+head air with solid ground (the castlebed
// picker, minus the flora dig — a blocked cell just loses).
function siteBedSpot(bot, st, bad) {
  const bp = botPos(bot)
  if (!bp || !st || !st.site) return null
  let w = 0
  let d = 0
  try {
    const dims = blueprint.siteDimensions(st.rot | 0, st.blueprintVersion)
    w = dims.w
    d = dims.d
  } catch (_) { return null }
  const { x: sx, y: sy, z: sz } = st.site
  const at = (x, y, z) => blockNameAt(bot, new Vec3(x, y, z))
  const groundOk = (x, y, z) => {
    let below = null
    try { below = bot.blockAt(new Vec3(x, y - 1, z)) } catch (_) { below = null }
    if (!below || below.boundingBox !== 'block') return false
    try { if (flatMod.isLiquidName(below.name)) return false } catch (_) { return false }
    return !isInteractRef(below.name)
  }
  const cellOk = (x, y, z) => {
    if (!AIR.has(at(x, y, z)) || !AIR.has(at(x, y + 1, z))) return false
    try {
      if (blueprint.inFootprint(st, { x, y, z })) return false
    } catch (_) { return false }
    try {
      if (castleMod.onDoorPath(st, x, z)) return false
    } catch (_) { /* unreadable path reads off */ }
    return groundOk(x, y, z)
  }
  const y0 = Math.max(Math.floor(bp.y), sy)
  for (let r = 2; r <= 5; r++) {
    let best = null
    for (let x = sx - r; x <= sx + w - 1 + r; x++) {
      for (let z = sz - r; z <= sz + d - 1 + r; z++) {
        if (x > sx - r && x < sx + w - 1 + r && z > sz - r && z < sz + d - 1 + r) continue // ring r only
        for (let y = y0 - 2; y <= y0 + 2; y++) {
          if (bad && bad.has(`${x},${y},${z}`)) continue
          if (!cellOk(x, y, z) || !cellOk(x + 1, y, z)) continue
          const dist = Math.hypot(x + 0.5 - bp.x, y - bp.y, z + 0.5 - bp.z)
          if (!best || dist < best.dist) best = { x, y, z, dist }
        }
      }
    }
    if (best) return { x: best.x, y: best.y, z: best.z }
  }
  return null
}

function setGoal(bot, ctx, key, goal) {
  if (ctx.lastGoalKey === key) return
  try {
    bot.pathfinder.setGoal(goal, false)
    ctx.lastGoalKey = key
  } catch (_) { /* retry next tick */ }
}

function sitebed(bot, ctx, target, state) {
  const st = ctx && ctx.castle
  if (!st || !st.site) {
    ctx.stepStatus = 'failed:no-castle'
    return
  }
  if (ctx.placeInFlight) return // one async flight at a time (beds/build shape)
  if (!ctx.sitebed || typeof ctx.sitebed !== 'object') ctx.sitebed = {}
  const cb = ctx.sitebed
  if (siteBedStands(bot, ctx)) { ctx.stepStatus = 'done'; return } // placed: nothing owed, ever
  const n = dayNum(bot)
  if (n >= 0 && cb.deadDay === n) { ctx.stepStatus = 'done'; return } // yielded today: tomorrow retries
  const giveUpToday = () => {
    if (n >= 0) cb.deadDay = n
    ctx.stepStatus = 'done'
  }
  if (!bedInPack(bot)) {
    // One pull from a near adopted chest, then recount; an empty chest
    // yields the day (deadDay), so the menu cannot re-pick into a loop.
    if (!cb.pulled && chestNear(bot, ctx) && typeof bedsMod.chestTick === 'function') {
      const busy = bedsMod.chestTick(bot, ctx, cb, 'sitebed-pull', async () => {
        try { await stockpileMod.withdrawAnyFromChest(bot, ctx, BED16, 1) } catch (_) { /* pull best-effort */ }
        cb.pulled = true
      })
      if (busy) return
    }
    if (!bedInPack(bot)) { giveUpToday(); return } // no bed: master-identical
  }
  if (!cb.bad || !(cb.bad instanceof Set)) {
    try { cb.bad = new Set() } catch (_) { cb.bad = null }
  }
  const dropSpot = () => {
    try { if (cb.bad && cb.at) cb.bad.add(`${cb.at.x},${cb.at.y},${cb.at.z}`) } catch (_) { /* bad best-effort */ }
    cb.at = null
    cb.blocks = (cb.blocks || 0) + 1
    if (cb.blocks >= PLACE_REFUSALS) giveUpToday()
  }
  if (!cb.at) {
    try {
      cb.at = siteBedSpot(bot, st, cb.bad)
    } catch (_) { cb.at = null }
    cb.fails = 0
    cb.stalls = 0
    cb.anchor = null
    if (!cb.at) { giveUpToday(); return } // no ground: tomorrow retries
  }
  const foot = new Vec3(cb.at.x, cb.at.y, cb.at.z)
  if (bedsMod.bedAt(bot, foot)) { // placed (by us, synced late): claim, click, finish
    try { st.siteBed = { x: foot.x, y: foot.y, z: foot.z } } catch (_) { /* claim best-effort */ }
    try { bot.chat('site bed is in') } catch (_) { /* chat best-effort */ }
    clickSpawn(bot, st, cb, foot)
    ctx.stepStatus = 'done'
    return
  }
  const bp = botPos(bot)
  if (!bp) return
  const key = `sitebed-place:${cb.at.x},${cb.at.y},${cb.at.z}`
  setGoal(bot, ctx, key, new goals.GoalNear(cb.at.x, cb.at.y, cb.at.z, 2))
  const dist = Math.hypot(bp.x - (cb.at.x + 0.5), bp.y - cb.at.y, bp.z - (cb.at.z + 0.5))
  if (dist > 3) { // walking: stall drops the spot
    const a = cb.anchor
    if (!a || Math.hypot(bp.x - a.x, bp.z - a.z) > 0.5) {
      cb.stalls = 0
      cb.anchor = { x: bp.x, z: bp.z }
    } else if (++cb.stalls >= STALL_TICKS) {
      cb.stalls = 0
      cb.anchor = null
      dropSpot()
    }
    return
  }
  const item = bedsMod.findBedItem(bot, null)
  if (!item) { giveUpToday(); return } // bed wandered off mid-walk: recount tomorrow
  ctx.placeInFlight = true
  const placedNow = () => !!bedsMod.bedAt(bot, foot)
  ;(async () => {
    try {
      let ref = null
      try { ref = bot.blockAt && bot.blockAt(new Vec3(foot.x, foot.y - 1, foot.z)) } catch (_) { ref = null }
      if (!ref || !ref.position || !ref.name || ref.name === 'air') throw new Error('no ground under the bed')
      if (typeof bot.equip === 'function') await bot.equip(item, 'hand')
      if (typeof bot.look === 'function') await bot.look(YAW_EAST, 0)
      if (typeof bot._placeBlockWithOptions === 'function') {
        await bot._placeBlockWithOptions(ref, new Vec3(0, 1, 0), { forceLook: 'ignore' })
      } else {
        await bot.placeBlock(ref, new Vec3(0, 1, 0))
      }
      for (let i = 0; i < 10 && !placedNow(); i++) {
        await new Promise((r) => setTimeout(r, 100))
      }
      if (placedNow()) {
        try { st.siteBed = { x: foot.x, y: foot.y, z: foot.z } } catch (_) { /* claim best-effort */ }
        try { bot.chat('site bed is in') } catch (_) { /* chat best-effort */ }
        clickSpawn(bot, st, cb, foot)
        cb.fails = 0
      } else {
        throw new Error('bed never synced')
      }
    } catch (err) {
      cb.fails = (cb.fails || 0) + 1
      if (cb.fails === 1) {
        try { console.log(`sitebed place refused: ${err && err.message ? err.message : err}`) } catch (_) { /* logging best-effort */ }
      }
    } finally {
      ctx.placeInFlight = false
    }
    if ((cb.fails || 0) >= PLACE_REFUSALS) {
      dropSpot() // this ground refuses: try the next spot, yield after three
      cb.fails = 0
    }
  })().catch(() => { ctx.placeInFlight = false })
}

// Click the claimed bed: a daytime right-click sets the respawn point on
// vanilla/Paper even though nobody sleeps (probe-gated: the kill probe
// kills before first sleep, so a site respawn proves the click alone).
function clickSpawn(bot, st, cb, foot) {
  try {
    const key = `${foot.x},${foot.y},${foot.z}`
    if (cb.spawnSetFor === key) return
    if (typeof bot.activateBlock !== 'function') return
    const bed = bot.blockAt && bot.blockAt(new Vec3(foot.x, foot.y, foot.z))
    if (!bed) return
    cb.spawnSetFor = key
    void Promise.resolve(bot.activateBlock(bed)).then(
      () => {
        try { st.siteSpawnSet = true } catch (_) { /* flag best-effort */ }
        try { bot.chat('site spawn set') } catch (_) { /* chat best-effort */ }
      },
      () => { /* refused: out of reach or gone */ },
    )
  } catch (_) { /* spawn best-effort */ }
}

module.exports = sitebed
module.exports.siteBedStands = siteBedStands
module.exports.bedReady = bedReady
module.exports.siteBedSpot = siteBedSpot
