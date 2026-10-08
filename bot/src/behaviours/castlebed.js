'use strict'

// castlebed: the castle site bed (idkcraft-vmzq.33). During castle work the
// bot never sleeps (the beds step is a daytime home job with a castle veto),
// so phantoms hunt from night 4 and every death respawns 500 blocks away.
// This step fetches one bed once (day wool hunt + craft, the beds.js shape
// without the home legs) and sleeps at the site nightly: sleeping skips the
// night, resets the phantom timer, and sets the spawn AT the site.
//
// The bed sits outside the castle footprint and off the door path
// (castle.inFootprint + the stowSpot door-path rule), stays placed across
// nights, and stays protected (util guards every *_bed for all executors).
// When no bed can be had the step is infeasible and the #351/#347 shelter
// (pillar/dig-in) runs as before — the menu, not this file, owns that
// fallback.

const Vec3 = require('vec3')
const { goals } = require('mineflayer-pathfinder')
const bedMod = require('./bed')
const bedsMod = require('./beds')
const bringMod = require('./bring')
const craftItem = require('./craftany')
const blueprint = require('../castle')
const castleMod = require('./castle')
const flatMod = require('./flat')
const { botPos, canBreak, isInteractRef } = require('./util')

const WOOL16 = bedMod.BED_COLORS.map((c) => `${c}_wool`)
const AIR = new Set(['air', 'cave_air', 'void_air'])
const HUNT_REOPENS = 3 // short cancelled hunts reopen this often before failed:no-wool (beds mirror)
const PLACE_REACH = 4
const PLACE_REFUSALS = 3
const STALL_TICKS = 30
const YAW_EAST = -Math.PI / 2 // head lands +x, the beds.js forced yaw
const SLEEP_REACH = 2 // from the head: inside mineflayer's click box on every facing
const SLEEP_STALL_TICKS = 30
const SLEEP_RETRY_TICKS = 30 // transient backoff: covers dusk, re-tries mobs nightly (stay mirror)

function blockNameAt(bot, p) {
  try {
    const b = bot.blockAt && bot.blockAt(p)
    return b && typeof b.name === 'string' ? b.name : null
  } catch (_) {
    return null
  }
}

// Site sheepless latch (own object, not the beds.js one: the castle site is
// 500 blocks from home, and a failed site hunt must not latch the home
// bedrooms). Same {fails, at} shape, same 2-fail arming — but only an
// EXHAUSTED hunt (full budget, nothing found) notes. A partial hunt gained
// wool (progress, not sheeplessness) and a dusk-cancelled hunt never ran
// long enough to judge; both reopen without noting. Not persisted: a
// restart re-hunts, bounded by the reopen cap and the menu holds.
function siteSheepLatched(ctx, bot) {
  try {
    const cb = ctx && ctx.castlebed
    const lat = cb && cb.noWool
    if (!lat || typeof lat !== 'object') return false
    if ((lat.fails || 0) < (bedsMod.NOWOOL_LATCH || 2)) return false
    if (Date.now() - (lat.at || 0) >= (bedsMod.LATCH_MS || 7200000)) return false
    // String exemption (beds.js mirror): 4 string crafts wool with no sheep.
    if (cb.stringDry) return true
    let string = 0
    try { string = bedMod.packCounts(bot).string || 0 } catch (_) { string = 0 }
    if (string >= 4) return false
    return true
  } catch (_) {
    return false
  }
}

// Claim-aware placed truth, pure (never writes): a claim the world still
// shows stands; a dark chunk trusts its claim; otherwise no bed. No
// adopt scan: the site has no canonical cells, and a second bed next to a
// forgotten one still sleeps.
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

// Pure placed truth for goalFacts (never writes): placed, packed (a bed item
// awaits dusk), or none.
function sitebedFact(bot, ctx) {
  try {
    if (siteBedStands(bot, ctx)) return 'placed'
    if (bedMod.bedInPack(bedMod.packCounts(bot))) return 'packed'
    return 'none'
  } catch (_) {
    return 'none'
  }
}

// A bed craftable from the pack right now (wool + planks + table path, the
// planner's own verdict — no hunt at night). False without a registry.
function bedCraftable(bot, ctx) {
  try {
    const pack = bedMod.packCounts(bot)
    const color = bedMod.pickBedColor(pack)
    if (!color || (pack[`${color}_wool`] || 0) < bedMod.BED_WOOL) return false
    const target = bedMod.bedTarget(color)
    if (!target) return false
    const plan = craftItem.planCraft(bot, ctx, [target], 1)
    return !!(plan && plan.ok)
  } catch (_) {
    return false
  }
}

// Near enough to walk to the bed at night: within the castle far-walk range
// of the footprint. Unknown position reads near (the nightFarFromHome rule);
// the behaviour fails loud when it cannot walk there.
function nearSite(bot, ctx) {
  try {
    const st = ctx && ctx.castle
    if (!st || !st.site) return false
    const d = castleMod.siteDist(bot, st)
    if (d == null) return true
    return d <= castleMod.SITE_WALK_DIST
  } catch (_) {
    return true
  }
}

// Site-bed spot: the nearest foot cell 2..5 rings out of the site box with
// foot+head (head +x, the forced east yaw) both outside the footprint, off
// the door path, air with air above (a lid for sleep, not just the place),
// over solid non-interactive ground. The stowSpot ring scan for two cells.
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
    ctx.lastPathNodes = null
  } catch (_) { /* retry next tick */ }
}

// Day wool through a self bring order (the beds.js direct mob rung, no home
// chest legs — the site is 500 blocks from home): the return phase keeps the
// goods, dusk cancels, the step reopens in the morning. A hunt that searched
// the whole budget is genuinely sheepless (failed:no-wool into the shared
// latch); anything shorter reopens. String first (4 string -> 1 wool needs
// no sheep and no table).
function woolTick(bot, ctx, cb, pack) {
  const need = bedMod.BED_WOOL
  const color = bedMod.pickBedColor(pack)
  if (color && (pack[`${color}_wool`] || 0) >= need) {
    cb.reopens = 0
    cb.stringDry = false
    cb.hunt = null
    return true // wool covered: the caller crafts
  }
  if (ctx.bring) return false // the ticker runs the hunt instead of this step
  const last = cb.hunt
  if (last) {
    cb.hunt = null
    let legs = 0
    let timedOut = false
    let capped = false
    try { legs = (last.searchLegs && last.searchLegs.legs) || 0 } catch (_) { /* reopen */ }
    try { timedOut = !!(last.searchLegs && last.searchLegs.timedOut) } catch (_) { /* reopen */ }
    try { capped = !!(last.searchLegs && last.searchLegs.capped) } catch (_) { /* reopen */ }
    const budget = (bringMod.SEARCH_BUDGET && bringMod.SEARCH_BUDGET.legs) || 24
    // Only an exhausted hunt notes the latch (true sheeplessness). A short
    // hunt (dusk-cancelled, or partial wool gained) reopens without noting —
    // noting progress latched day 2 in the rig and the bed never got made.
    if (legs >= budget || timedOut || capped) {
      cb.reopens = 0
      try { bedsMod.noteNoWool(cb) } catch (_) { /* latch best-effort */ }
      ctx.stepStatus = 'failed:no-wool'
      return false
    }
    if ((cb.reopens || 0) >= HUNT_REOPENS) {
      cb.reopens = 0
      ctx.stepStatus = 'failed:no-wool' // hold, no latch: short hunts never judged the range
      return false
    }
    cb.reopens = (cb.reopens || 0) + 1
  }
  const fromString = Math.floor((pack.string || 0) / 4)
  if (fromString > 0 && !cb.stringDry) {
    const res = craftItem(bot, ctx, 'white_wool', fromString)
    if (res === 'running') return false
    if (!(res && res.done)) cb.stringDry = true
    return false // recount next tick
  }
  // The latch armed: the menu only re-reads feasible on a re-decide, so
  // the running step must not reopen a hunt itself.
  try {
    if (siteSheepLatched(ctx, bot)) {
      cb.reopens = 0
      ctx.stepStatus = 'failed:no-wool'
      return false
    }
  } catch (_) { /* unreadable latch: hunt */ }
  const base = { kind: 'item', name: 'wool', names: WOOL16.slice(), want: need, by: null, drop: null, have: 0 }
  let o = null
  try {
    o = bringMod.toWoolHunt(bot, base)
  } catch (_) { o = null }
  if (!o) { ctx.stepStatus = 'failed:no-wool'; return false }
  o.self = 'castlebed'
  cb.hunt = o
  ctx.bring = o
  return false
}

// One bed craft from the pack's best wool color. Wool-short returns to the
// hunt; anything else fails loud so the castle chain (which fetches the
// planks and the table) runs instead of this step churning.
function craftTick(bot, ctx, cb, pack) {
  const color = bedMod.pickBedColor(pack)
  if (!color || (pack[`${color}_wool`] || 0) < bedMod.BED_WOOL) return true // recount: woolTick hunts
  const target = bedMod.bedTarget(color)
  if (!target) { ctx.stepStatus = 'failed:cant-craft-bed'; return false }
  const res = craftItem(bot, ctx, target, 1)
  if (res === 'running') return false
  if (res && res.done) return false // recount next tick: the pack holds the bed
  const short = bedMod.bedShortfall(pack, color, 1)
  if (short.wool > 0) return true // wool wandered off: re-hunt
  if (bedsMod.maxWoodPlanks(pack) < bedMod.BED_PLANKS) {
    ctx.stepStatus = 'failed:no-planks'
    return false
  }
  ctx.stepStatus = 'failed:cant-craft-bed'
  return false
}

function dayTick(bot, ctx, cb, st) {
  // Dawn after a site sleep (vanilla usually auto-wakes): wake a missed wake
  // event first, then tonight's flags reset for the next night.
  if (bot.isSleeping) {
    ctx.inShelter = true
    if (typeof bot.wake === 'function' && !ctx.sleepInFlight) {
      ctx.sleepInFlight = true
      void (async () => {
        try { await bot.wake() } catch (_) { /* already awake */ } finally { ctx.sleepInFlight = false }
      })()
    }
    return
  }
  ctx.inShelter = false
  cb.sleepGiveUp = false
  cb.sleepCooldown = 0
  cb.sleepSaid = false
  cb.sleepErrSaid = false
  if (siteBedStands(bot, ctx)) { ctx.stepStatus = 'done'; return } // placed: nights sleep, days build
  const pack = bedMod.packCounts(bot)
  if (bedMod.bedInPack(pack)) { ctx.stepStatus = 'done'; return } // packed: dusk places
  if (!woolTick(bot, ctx, cb, pack)) return // hunting/crafting string/failed
  craftTick(bot, ctx, cb, bedMod.packCounts(bot))
}

// Place the packed bed at a site spot (dusk/night). A refused spot is
// dropped and the scan re-runs; three dead spots fail to the shelter.
function placeTick(bot, ctx, cb, st, n) {
  const item = bedsMod.findBedItem(bot, null)
  if (!item) { deadTonight(ctx, cb, n); return } // pack lost the bed: tomorrow re-fetches
  if (!cb.bad || !(cb.bad instanceof Set)) {
    try { cb.bad = new Set() } catch (_) { cb.bad = null }
  }
  if (!cb.at) {
    try {
      cb.at = siteBedSpot(bot, st, cb.bad)
    } catch (_) { cb.at = null }
    cb.fails = 0
    cb.stalls = 0
    cb.anchor = null
  }
  if (!cb.at) { deadTonight(ctx, cb, n); return }
  const dropSpot = () => {
    try { if (cb.bad) cb.bad.add(`${cb.at.x},${cb.at.y},${cb.at.z}`) } catch (_) { /* bad best-effort */ }
    cb.at = null
    cb.blocks = (cb.blocks || 0) + 1
    if (cb.blocks >= PLACE_REFUSALS) deadTonight(ctx, cb, n)
  }
  const foot = new Vec3(cb.at.x, cb.at.y, cb.at.z)
  const head = new Vec3(cb.at.x + 1, cb.at.y, cb.at.z)
  const bp = botPos(bot)
  if (!bp) return
  if (Math.hypot(bp.x - foot.x, bp.y - foot.y, bp.z - foot.z) > PLACE_REACH) {
    const key = `castlebed-place:${foot.x},${foot.y},${foot.z}` // per spot: a same-night rescan re-goals — revmux 03 minor
    if (ctx.lastGoalKey !== key) {
      try { bot.pathfinder.setGoal(new goals.GoalNear(foot.x, foot.y, foot.z, 1), false) } catch (_) { /* retry next tick */ }
      ctx.lastGoalKey = key
      ctx.lastPathNodes = null
      cb.stalls = 0
      cb.anchor = { x: bp.x, z: bp.z }
      return
    }
    const last = cb.anchor
    if (!last || Math.hypot(bp.x - last.x, bp.z - last.z) > 0.5) {
      cb.stalls = 0
      cb.anchor = { x: bp.x, z: bp.z }
    } else if (++cb.stalls >= STALL_TICKS) {
      dropSpot() // unreachable tonight and likely tomorrow: never re-walk it — revmux 02 core-1
      deadTonight(ctx, cb, n)
      return
    }
    return
  }
  // Already placed (the verify pass after the flight, or a bed there first):
  // claim it before the flora gate below can mistake it for a blocker.
  try {
    if (bedsMod.bedAt(bot, foot)) {
      try { st.siteBed = { x: foot.x, y: foot.y, z: foot.z } } catch (_) { /* claim best-effort */ }
      try { delete st.sleptSite } catch (_) { /* a fresh bed needs a fresh sleep */ }
      cb.fails = 0
      try { bot.chat('site bed is in') } catch (_) { /* chat best-effort */ }
      return
    }
  } catch (_) { /* unverifiable: the flight below re-checks */ }
  // The scan promised air over solid ground; the world may have moved.
  for (const cell of [foot, head]) {
    let cur = null
    try { cur = bot.blockAt && bot.blockAt(cell) } catch (_) { cur = null }
    const nm = cur && cur.name
    if (!nm || nm === 'air' || nm === 'cave_air' || nm === 'void_air') continue
    let clearable = false
    try { clearable = !!require('./build').isReplaceable(nm) } catch (_) { clearable = false }
    if (!clearable || typeof bot.dig !== 'function' || !cur) { dropSpot(); return }
    try {
      if (!canBreak(bot, cur, ctx)) { dropSpot(); return }
    } catch (_) { dropSpot(); return }
    ctx.placeInFlight = true
    void (async () => {
      try { await bot.dig(cur) } catch (_) { /* retry next tick */ } finally { ctx.placeInFlight = false }
    })()
    return
  }
  ctx.placeInFlight = true
  const fails = () => cb.fails || 0
  const placedNow = () => !!bedsMod.bedAt(bot, foot);
  (async () => {
    try {
      if (placedNow()) {
        try { st.siteBed = { x: foot.x, y: foot.y, z: foot.z } } catch (_) { /* claim best-effort */ }
        try { delete st.sleptSite } catch (_) { /* a fresh bed needs a fresh sleep */ }
        cb.fails = 0
        try { bot.chat('site bed is in') } catch (_) { /* chat best-effort */ }
        return
      }
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
    } catch (err) {
      cb.fails = fails() + 1
      if (fails() === 1) {
        try { console.log(`castlebed place refused: ${err && err.message ? err.message : err}`) } catch (_) { /* logging best-effort */ }
      }
    } finally {
      ctx.placeInFlight = false
    }
    if (fails() >= PLACE_REFUSALS) {
      dropSpot() // this ground refuses: try the next spot, fail after three
      cb.fails = 0
    }
  })().catch(() => { ctx.placeInFlight = false })
}

// Sleep in the claimed site bed (the stay sleepTick shape: a sleeping body
// owns the tick and touches nothing, transient failures back off,
// server-side refusals give up tonight). True while it owns the tick.
function sleepTick(bot, ctx, cb, st) {
  try {
    if (typeof bot.sleep !== 'function') return false
    if (bot.isSleeping) { ctx.inShelter = true; return true }
    if (ctx.sleepInFlight) return true
    if (cb.sleepGiveUp) return false
    if ((cb.sleepCooldown || 0) > 0) {
      cb.sleepCooldown--
      ctx.inShelter = false // awake and waiting: fight clears the mobs meanwhile
      return true
    }
    const claim = st && st.siteBed
    if (!claim || typeof claim.x !== 'number') return false
    const foot = new Vec3(claim.x, claim.y, claim.z)
    const bed = bedsMod.bedAt(bot, foot)
    if (!bed) {
      try { delete st.siteBed; delete st.sleptSite } catch (_) { /* retract best-effort */ }
      return false // mined half: the caller re-places
    }
    const bp = botPos(bot)
    if (!bp) return false
    const head = new Vec3(foot.x + 1, foot.y, foot.z)
    if (Math.hypot(bp.x - head.x, bp.y - head.y, bp.z - head.z) > SLEEP_REACH) {
      setGoal(bot, ctx, 'castlebed-bed', new goals.GoalNear(foot.x, foot.y, foot.z, 1))
      const last = cb.sleepAnchor
      if (!last || Math.hypot(bp.x - last.x, bp.z - last.z) > 0.5) {
        cb.sleepStalls = 0
        cb.sleepAnchor = { x: bp.x, z: bp.z }
      } else if (++cb.sleepStalls >= SLEEP_STALL_TICKS) {
        cb.sleepGiveUp = true
        return false
      }
      ctx.inShelter = false
      return true
    }
    ctx.sleepInFlight = true
    void (async () => {
      try {
        await bot.sleep(bed)
        try { st.sleptSite = true } catch (_) { /* claim best-effort */ } // vanilla sets the spawn on use
        try { if (ctx.home) delete ctx.home.sleptA } catch (_) { /* the site spawn wins */ }
        if (ctx.castlebed !== cb) {
          try { if (typeof bot.wake === 'function') await bot.wake() } catch (_) { /* the order wakes */ }
          return
        }
        if (!cb.sleepSaid) {
          cb.sleepSaid = true
          try { bot.chat('sleeping at the site') } catch (_) { /* chat best-effort */ }
        }
      } catch (err) {
        const msg = err && err.message ? String(err.message) : ''
        if (/monsters nearby|not night/i.test(msg)) cb.sleepCooldown = SLEEP_RETRY_TICKS
        else cb.sleepGiveUp = true
        if (!cb.sleepErrSaid) {
          cb.sleepErrSaid = true
          try { console.log(`castlebed sleep failed: ${msg || err}`) } catch (_) { /* logging best-effort */ }
        }
      } finally {
        ctx.sleepInFlight = false
      }
    })()
    return true
  } catch (_) {
    return false
  }
}

// A night leg that cannot run tonight yields to the shelter with done, not
// failed: a hold would stand into the next night (the facts text carries no
// day number) and — with the shelter yielding to a feasible bed — leave
// neither night step running. deadNight blocks the rest of this night only;
// the nightly reset below re-arms the next one. Revmux 01 core-1/core-2.
function deadTonight(ctx, cb, n) {
  cb.deadNight = n
  ctx.stepStatus = 'done'
}

function nightTick(bot, ctx, cb, st) {
  ctx.inShelter = false // awake paths fight; sleepTick arms once asleep
  const n = bot && bot.time && typeof bot.time.day === 'number' ? bot.time.day : -1
  if (cb.night !== n) {
    cb.night = n
    cb.sleepGiveUp = false
    cb.sleepCooldown = 0
    cb.sleepSaid = false
    cb.sleepErrSaid = false
    cb.sleepStalls = 0
    cb.sleepAnchor = null
    cb.fails = 0
    cb.blocks = 0
  }
  if (cb.deadNight === n) { ctx.stepStatus = 'done'; return } // yielded tonight: the shelter holds
  if (!nearSite(bot, ctx)) { ctx.stepStatus = 'done'; return } // march belongs to day: shelter holds here
  if (siteBedStands(bot, ctx)) {
    if (sleepTick(bot, ctx, cb, st)) return
    // No bed (retracted above): re-place when packed, else the shelter.
    // Give-up (unreachable/refused tonight): the shelter, not an open hold.
    if (st.siteBed) { deadTonight(ctx, cb, n); return }
  }
  const pack = bedMod.packCounts(bot)
  if (bedMod.bedInPack(pack)) { placeTick(bot, ctx, cb, st, n); return }
  // Wool covered but uncrafted at dusk: craft now, place next tick.
  const color = bedMod.pickBedColor(pack)
  if (color && (pack[`${color}_wool`] || 0) >= bedMod.BED_WOOL) {
    const target = bedMod.bedTarget(color)
    if (target) {
      const res = craftItem(bot, ctx, target, 1)
      if (res === 'running') { ctx.inShelter = false; return }
      if (res && res.done) { ctx.inShelter = false; return } // recount next tick: place
    }
  }
  deadTonight(ctx, cb, n)
}

function castlebed(bot, ctx, target, state) {
  const st = ctx && ctx.castle
  if (!st || !st.site) {
    ctx.stepStatus = 'failed:no-castle'
    return
  }
  if (ctx.placeInFlight) return // one async place flight (beds/build shape)
  if (!ctx.castlebed || typeof ctx.castlebed !== 'object') ctx.castlebed = {}
  const cb = ctx.castlebed
  let time = 'day'
  try {
    time = require('../goal').timeWord(bot) || 'day' // deferred: goal loads inside the behaviour chain
  } catch (_) { /* day fetch on unknown time */ }
  if (time === 'day') dayTick(bot, ctx, cb, st)
  else nightTick(bot, ctx, cb, st)
}

module.exports = castlebed
module.exports.siteBedStands = siteBedStands
module.exports.sitebedFact = sitebedFact
module.exports.bedCraftable = bedCraftable
module.exports.nearSite = nearSite
module.exports.siteBedSpot = siteBedSpot
module.exports.siteSheepLatched = siteSheepLatched
