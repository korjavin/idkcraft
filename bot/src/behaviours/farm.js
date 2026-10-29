'use strict'

// Wheat autonomy (idkcraft-1z1m): grow wheat and carry it to sheep on the
// V2 Baritone body, closing the loop to wool (aoql) from the field side.
// One goal step, six legs in bead order: hoe (craft a wooden hoe through
// craftany, the beds precedent) -> till (hoe + activateBlock on soil) ->
// water (a bucket trench next to dry farmland, or till near standing
// water so hydration is free) -> plant (seeds + activateBlock on
// farmland) -> harvest (dig mature wheat, age 7, and replant from the
// drops) -> feed (walk wheat to the nearest sheep and hold it; breeding
// itself needs an entity-use RPC the mod does not serve yet, so the leg
// lures — sheep follow a wheat holder — and says so).
//
// Body ops only (dig / activateBlock / equip / craft / walk goals), all
// served by the bridge, so the same code runs on v1 mineflayer too. The
// only body sniff is the breed attempt: bot.activateEntity when the body
// serves it, lure-only otherwise. Step completion goes through step.js;
// the only failed: reason is the existing 'unreachable' (walk strikes),
// so no new failed: string needs a verdict line.

const { goals } = require('mineflayer-pathfinder')
const { Vec3 } = require('vec3')
const { countItems } = require('../perception')
const { stepDone, stepFailed, stepGen, chatStep } = require('../step')
const { say, clearGoal, issueGoal, botPos, denyReason } = require('./util')
const bring = require('./bringbase')

const FARM_RADIUS = 24 // body-anchored work radius, like reforest's 32
const WALK_RANGE = 3 // GoalNear arrival range for till/plant/water/harvest/feed
const REACH = 4.5 // interact reach: arrival this close works the block without another goal
const WALK_STALL_TICKS = 10 // no-displacement ticks before a target is struck
const UNREACHABLE_STRIKES = 3 // struck targets before failed:unreachable
const TILL_CAP = 4 // tilled cells per step, then done
const PLANT_CAP = 8 // plantings per step, then done
const HARVEST_CAP = 8 // harvested crops per step, then done
const WATER_CAP = 2 // trench placements per step, then done
const SEED_DIG_CAP = 4 // grass-tuft digs per step for first seeds
const MAX_MS = 180000 // wall-time cap per step (3 min), then done
const LURE_TICKS = 6 // ticks holding wheat by the sheep before done
const POUR_SETTLE_TICKS = 2 // ticks for the bucket water to land before verifying
const FEED_RADIUS = 24 // sheep farther than the farm scans never pull the step
const FEED_COOLDOWN_MS = 600000 // a fed flock reads fed for 10 min (wheat is
// never consumed on V2: no activateEntity served, so the lure alone must
// not re-pick the step every tick and starve explore/rest)

// Hoeable soil (minimal: one hoe use -> farmland, no two-step kinds).
function isTillable(name) {
  return name === 'grass_block' || name === 'dirt'
}

// Seed-source tufts, broken for first seeds until harvest drops sustain.
function isSeedTuft(name) {
  return name === 'short_grass' || name === 'grass' || name === 'tall_grass' || name === 'fern' || name === 'large_fern'
}

function propsOf(block) {
  try {
    if (block && typeof block.getProperties === 'function') return block.getProperties() || {}
  } catch (_) { /* unreadable: fail closed below */ }
  return null
}

// Mature wheat only (age 7): fail-closed on unreadable age, so young
// crops are never griefed on a body whose blocks carry no properties.
function isMatureWheat(block) {
  try {
    if (!block || block.name !== 'wheat') return false
    const p = propsOf(block)
    return !!p && Number(p.age) === 7
  } catch (_) { return false }
}

function isFarmland(block) {
  try { return !!block && block.name === 'farmland' } catch (_) { return false }
}

// Dry farmland (moisture 0) wants the trench. Unreadable moisture reads
// wet — no trench is dug on a guess.
function needsWater(block) {
  try {
    if (!isFarmland(block)) return false
    const p = propsOf(block)
    if (!p || p.moisture == null) return false
    return Number(p.moisture) === 0
  } catch (_) { return false }
}

function isWaterName(name) {
  return typeof name === 'string' && (name === 'water' || name === 'flowing_water')
}

function keyOf(p) {
  return `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`
}

function packOf(bot) {
  try {
    const items = bot && bot.inventory && typeof bot.inventory.items === 'function' ? bot.inventory.items() : []
    return Array.isArray(items) ? items : []
  } catch (_) { return [] }
}

function findInPack(bot, pred) {
  for (const i of packOf(bot)) {
    try { if (i && pred(i)) return i } catch (_) { /* next */ }
  }
  return null
}

function hasHoe(bot) {
  return !!findInPack(bot, (i) => typeof i.name === 'string' && i.name.endsWith('_hoe'))
}

function countSeeds(bot) {
  return countItems(bot, (n) => n === 'wheat_seeds')
}

function countWheat(bot) {
  return countItems(bot, (n) => n === 'wheat')
}

function hasBucket(bot) {
  return countItems(bot, (n) => n === 'water_bucket') > 0
}

// Registry ids for a name list (reforest leafIds pattern); empty when the
// registry does not know the names, so scans stay silent on mocks without
// a registry instead of voxel-walking the world every tick.
function idsFor(bot, names) {
  try {
    const byName = (bot && bot.registry && bot.registry.blocksByName) || {}
    const ids = []
    for (const n of names) {
      const e = byName[n]
      if (e && typeof e.id === 'number' && !ids.includes(e.id)) ids.push(e.id)
    }
    return ids
  } catch (_) { return [] }
}

// Nearest block by name-set within radius: findBlocks scan (cheap like
// reforest's), then the vetting findBlocks cannot do — struck cells, the
// house footprint (no lawn-tearing), the break guard (dig legs), and air
// above (till/plant legs). Deterministic distance sort.
function nearestCell(bot, ctx, names, radius, { forDig = false } = {}) {
  const bp = botPos(bot)
  if (!bp) return null
  const set = names instanceof Set ? names : new Set(names)
  let found = []
  try {
    const ids = idsFor(bot, [...set])
    if (ids.length === 0 || typeof bot.findBlocks !== 'function') return null
    found = bot.findBlocks({ matching: ids, maxDistance: radius, count: 32 }) || []
  } catch (_) { return null }
  const cands = []
  for (const p of found) {
    if (!p || typeof p.x !== 'number') continue
    const x = Math.floor(p.x), y = Math.floor(p.y), z = Math.floor(p.z)
    if (Math.abs(y - bp.y) > 6) continue
    const k = `${x},${y},${z}`
    if (ctx && ctx.farm && ctx.farm.struck && ctx.farm.struck.has(k)) continue
    let b = null
    try { b = bot.blockAt(new Vec3(x, y, z)) } catch (_) { b = null }
    if (!b || !set.has(b.name)) continue
    try {
      const home = ctx && ctx.home
      if (home && require('./util').inHouseFootprint(home, b.position)) continue
    } catch (_) { /* unguarded: keep */ }
    if (forDig) {
      try { if (denyReason(bot, b, ctx)) continue } catch (_) { continue }
    } else {
      let above = null
      try { above = bot.blockAt(new Vec3(x, y + 1, z)) } catch (_) { above = null }
      if (!above || (above.name !== 'air' && above.name !== 'cave_air')) continue
    }
    cands.push({ x, y, z, d: Math.hypot(x + 0.5 - bp.x, y - bp.y, z + 0.5 - bp.z) })
  }
  cands.sort((a, b) => a.d - b.d)
  return cands[0] || null
}

// Standing water within hydration reach of a cell: the vanilla 9x2x9 box
// (4 XZ, water at the same level or one above — water a level below never
// hydrates, so riverbank soil above the surface reads dry and wants the
// trench only with a bucket in hand).
function waterNear(bot, p) {
  try {
    for (let dx = -4; dx <= 4; dx++) {
      for (let dz = -4; dz <= 4; dz++) {
        if (Math.hypot(dx, dz) > 4) continue
        for (let dy = 0; dy <= 1; dy++) {
          let b = null
          try { b = bot.blockAt(new Vec3(Math.floor(p.x) + dx, Math.floor(p.y) + dy, Math.floor(p.z) + dz)) } catch (_) { b = null }
          if (b && isWaterName(b.name)) return true
        }
      }
    }
  } catch (_) { /* no water: dry */ }
  return false
}

// A trench candidate for dry farmland F: adjacent ground at field level
// whose dig leaves a 1-deep pit the bucket fills at the same level (only
// same-level-or-above water hydrates). Solid floor below keeps the water
// put; denyReason vets traps and builds. Returns the cell to dig.
function trenchFor(bot, ctx, f) {
  const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]]
  for (const [dx, dz] of dirs) {
    const x = Math.floor(f.x) + dx, y = Math.floor(f.y), z = Math.floor(f.z) + dz
    const k = `${x},${y},${z}`
    if (ctx && ctx.farm && ctx.farm.struck && ctx.farm.struck.has(k)) continue
    let b = null
    try { b = bot.blockAt(new Vec3(x, y, z)) } catch (_) { b = null }
    if (!b || (!isTillable(b.name) && b.name !== 'sand' && b.name !== 'gravel')) continue
    try { if (denyReason(bot, b, ctx)) continue } catch (_) { continue }
    let floor = null
    try { floor = bot.blockAt(new Vec3(x, y - 1, z)) } catch (_) { floor = null }
    if (!floor || floor.name === 'air' || isWaterName(floor.name)) continue
    return { x, y, z }
  }
  return null
}

function strike(ctx, p) {
  try {
    const f = ctx.farm || (ctx.farm = {})
    if (!(f.struck instanceof Set)) f.struck = new Set()
    f.struck.add(typeof p === 'string' ? p : keyOf(p))
    f.strikes = (f.strikes | 0) + 1
  } catch (_) { /* strike best-effort */ }
}

function farmState(ctx) {
  let f = null
  try { f = ctx.farm } catch (_) { f = null }
  if (!f || typeof f !== 'object') {
    f = {}
    try { ctx.farm = f } catch (_) { /* stateless */ }
  }
  if (!(f.struck instanceof Set)) f.struck = new Set()
  if (typeof f.t0 !== 'number') f.t0 = Date.now()
  return f
}

// Walk-or-arrived (reforest 6p4l shape): issue the goal once per target,
// never re-issue an unchanged target every tick (Baritone restarts A* on
// every fresh goto). Returns true while walking (caller returns), false
// on arrival. Arrival is judged on the goal's own cell within REACH, so a
// satisfied GoalNear always reads arrived.
function walkTo(bot, ctx, f, leg, p, range) {
  const bp = botPos(bot)
  if (!bp) return true // no position: stay put this tick, rescan next
  const cell = { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) }
  const gk = `${leg}:${cell.x},${cell.y},${cell.z}`
  if (Math.hypot(cell.x + 0.5 - bp.x, cell.y - bp.y, cell.z + 0.5 - bp.z) <= (range || REACH)) {
    f.walkKey = null
    return false
  }
  if (!ctx || ctx.lastGoalKey !== gk) {
    issueGoal(bot, ctx, new goals.GoalNear(cell.x, cell.y, cell.z, WALK_RANGE), gk, false)
    f.walkKey = keyOf(cell)
    f.still = 0
  }
  return true
}

// Feed preconditions shared by the menu gate and the leg: wheat in the
// pack, a sheep inside the farm scans, and no fresh lure on record.
function feedReady(bot, ctx) {
  try {
    if (countWheat(bot) <= 0) return null
    try {
      const fedAt = ctx && ctx.farmFedAt
      if (typeof fedAt === 'number' && Date.now() - fedAt < FEED_COOLDOWN_MS) return null
    } catch (_) { /* cooldown unreadable: feed */ }
    const bp = botPos(bot)
    if (!bp) return null
    let found = null
    try { found = bring.findAnimal(bot, null, { prey: ['sheep'] }) } catch (_) { found = null }
    if (!found || !found.position) return null
    const sp = found.position
    if (Math.hypot(sp.x - bp.x, sp.y - bp.y, sp.z - bp.z) > FEED_RADIUS) return null
    return found
  } catch (_) { return null }
}

// Feasibility probe (goal.js MENU.farm): day, no active castle, pack room,
// and at least one leg actionable now — a mature crop, seeds on tilled
// soil, a bucket for dry soil, tillable soil near water (or a bucket for
// the trench), or wheat carried to sheep. Deterministic scans, no ctx
// writes — the menu must not flicker between ticks.
function farmFeasible(facts, bot, ctx) {
  try {
    if (!facts || facts.time !== 'day') return false
    try {
      if (require('./explore').castleActive(ctx) && !require('../vetoes').orderOwnsStep(ctx, 'farm')) return false
    } catch (_) { /* no castle: farm */ }
    try {
      if (require('./stockpile').packFull(bot, ctx)) return false
    } catch (_) { /* room unreadable: farm */ }
    const bp = botPos(bot)
    if (!bp) return false
    const farmland = nearestCell(bot, ctx, ['farmland'], FARM_RADIUS)
    // Mature wheat anywhere in range — confirm maturity on the nearest
    // head before claiming feasibility (young crops never pull the step).
    const w = nearestCell(bot, ctx, ['wheat'], FARM_RADIUS)
    if (w) {
      try {
        const b = bot.blockAt(new Vec3(w.x, w.y, w.z))
        if (isMatureWheat(b)) return true
      } catch (_) { /* unreadable: not feasible on wheat */ }
    }
    if (farmland && countSeeds(bot) > 0) {
      try {
        const above = bot.blockAt(new Vec3(farmland.x, farmland.y + 1, farmland.z))
        if (above && (above.name === 'air' || above.name === 'cave_air')) return true
      } catch (_) { /* unplantable */ }
    }
    if (farmland && hasBucket(bot)) {
      try {
        const b = bot.blockAt(new Vec3(farmland.x, farmland.y, farmland.z))
        if (needsWater(b) && !waterNear(bot, farmland)) return true
      } catch (_) { /* no trench leg */ }
    }
    // First seeds: tufts to break while nothing is planted yet.
    if (countSeeds(bot) <= 0 && nearestCell(bot, ctx, ['short_grass', 'grass', 'tall_grass', 'fern', 'large_fern'], FARM_RADIUS, { forDig: true })) return true
    const soil = nearestCell(bot, ctx, ['grass_block', 'dirt'], FARM_RADIUS)
    if (soil && (waterNear(bot, soil) || hasBucket(bot))) {
      if (hasHoe(bot)) return true
      try {
        const plan = require('./craftany').planCraft
        if (typeof plan === 'function') {
          const r = plan(bot, ctx, ['wooden_hoe'], 1)
          if (r && r.ok) return true
        }
      } catch (_) { /* uncraftable: fall through */ }
    }
    if (feedReady(bot, ctx)) return true
    return false
  } catch (_) { return false }
}

// One prod line per step + one per harvest/plant (reforest precedent).
function prodLine(f) {
  return `farm tilled=${f.tilled | 0} planted=${f.planted | 0} harvested=${f.harvested | 0} watered=${f.watered | 0} fed=${f.fedSheep | 0} fail=${f.fail || '-'}`
}

function finish(bot, ctx, f, ok, reason, gen) {
  try { clearGoal(bot, ctx) } catch (_) { /* goal best-effort */ }
  try { console.log(prodLine(f)) } catch (_) { /* log best-effort */ }
  // Drop the run state with the step (reforest precedent): a re-picked
  // farm must rescan, or stale caps finish it done on the first tick.
  try { if (ctx) ctx.farm = null } catch (_) { /* state best-effort */ }
  if (ok) return stepDone(ctx, gen)
  return stepFailed(ctx, reason || 'unreachable', gen)
}

async function equipHeld(bot, name) {
  const item = findInPack(bot, (i) => i.name === name)
  if (!item) return false
  if (bot.heldItem && bot.heldItem.name === name) return true
  await bot.equip(item, 'hand')
  return true
}

async function run(bot, ctx) {
  const gen = stepGen(ctx)
  const f = farmState(ctx)
  if (f.busy) return
  f.busy = true
  try {
    if (Date.now() - (f.t0 || Date.now()) > MAX_MS) return void finish(bot, ctx, f, true, null, gen)
    const bp = botPos(bot)
    if (!bp) return

    // Displacement stall: a walk that goes nowhere strikes its target.
    const here = `${Math.floor(bp.x)},${Math.floor(bp.y)},${Math.floor(bp.z)}`
    if (f.walkKey) {
      if (here === f.lastPos) {
        f.still = (f.still | 0) + 1
        if (f.still >= WALK_STALL_TICKS) {
          strike(ctx, f.walkKey)
          f.walkKey = null
          f.still = 0
          try { clearGoal(bot, ctx) } catch (_) { /* next tick replans */ }
          if ((f.strikes | 0) >= UNREACHABLE_STRIKES) return void finish(bot, ctx, f, false, 'unreachable', gen)
          return
        }
      } else {
        f.still = 0
      }
    }
    f.lastPos = here

    // Leg 1 — harvest mature wheat (drops reseed the plant leg).
    if ((f.harvested | 0) < HARVEST_CAP) {
      const w = nearestCell(bot, ctx, ['wheat'], FARM_RADIUS, { forDig: true })
      if (w) {
        let b = null
        try { b = bot.blockAt(new Vec3(w.x, w.y, w.z)) } catch (_) { b = null }
        if (b && isMatureWheat(b)) {
          if (walkTo(bot, ctx, f, 'farm-harvest', w)) return
          try { if (denyReason(bot, b, ctx)) { strike(ctx, w); return } } catch (_) { strike(ctx, w); return }
          await bot.dig(b)
          // Settle tick for the drops, then replant the soil below (the
          // wheat cell itself is air after the dig).
          f.replant = { x: w.x, y: w.y - 1, z: w.z, ticks: 2 }
          f.harvested = (f.harvested | 0) + 1
          try { console.log(`farm harvest wheat at ${w.x},${w.y},${w.z}`) } catch (_) { /* log best-effort */ }
          return
        }
      }
    }

    // Replant tail: the harvested cell turns to farmland-or-air; plant it.
    if (f.replant) {
      if ((f.replant.ticks | 0) > 0) { f.replant.ticks--; return }
      const r = f.replant
      f.replant = null
      if (countSeeds(bot) > 0) {
        let b = null
        try { b = bot.blockAt(new Vec3(r.x, r.y, r.z)) } catch (_) { b = null }
        if (b && (isFarmland(b) || b.name === 'dirt' || b.name === 'grass_block')) {
          if (walkTo(bot, ctx, f, 'farm-replant', r)) {
            // Still walking: keep the tail so the plant lands on arrival.
            f.replant = { x: r.x, y: r.y, z: r.z, ticks: 0 }
            return
          }
          if (await equipHeld(bot, 'wheat_seeds')) {
            let soil = null
            try { soil = bot.blockAt(new Vec3(r.x, r.y, r.z)) } catch (_) { soil = null }
            if (soil && (isFarmland(soil) || isTillable(soil.name))) {
              // A dug cell needs the hoe pass first.
              if (!isFarmland(soil)) {
                if (await equipHeld(bot, (findInPack(bot, (i) => typeof i.name === 'string' && i.name.endsWith('_hoe')) || {}).name)) {
                  await bot.activateBlock(soil)
                  try { soil = bot.blockAt(new Vec3(r.x, r.y, r.z)) } catch (_) { /* reread best-effort */ }
                }
              }
              if (soil && isFarmland(soil)) {
                await bot.activateBlock(soil)
                f.planted = (f.planted | 0) + 1
                try { console.log(`farm plant wheat_seeds at ${r.x},${r.y},${r.z}`) } catch (_) { /* log best-effort */ }
              }
            }
          }
          return
        }
      }
    }

    // Leg 2 — plant seeds on empty farmland.
    if (countSeeds(bot) > 0 && (f.planted | 0) < PLANT_CAP) {
      const fl = nearestCell(bot, ctx, ['farmland'], FARM_RADIUS)
      if (fl) {
        let aboveEmpty = false
        try {
          const above = bot.blockAt(new Vec3(fl.x, fl.y + 1, fl.z))
          aboveEmpty = !!above && (above.name === 'air' || above.name === 'cave_air')
        } catch (_) { aboveEmpty = false }
        if (aboveEmpty) {
          if (walkTo(bot, ctx, f, 'farm-plant', fl)) return
          if (await equipHeld(bot, 'wheat_seeds')) {
            let soil = null
            try { soil = bot.blockAt(new Vec3(fl.x, fl.y, fl.z)) } catch (_) { soil = null }
            if (soil && isFarmland(soil)) {
              await bot.activateBlock(soil)
              f.planted = (f.planted | 0) + 1
              try { console.log(`farm plant wheat_seeds at ${fl.x},${fl.y},${fl.z}`) } catch (_) { /* log best-effort */ }
              return
            }
          }
          strike(ctx, fl)
          return
        }
      }
    }

    // Leg 3 — first seeds: break grass tufts until the plant leg runs.
    if (countSeeds(bot) <= 0 && (f.seedDigs | 0) < SEED_DIG_CAP) {
      const t = nearestCell(bot, ctx, ['short_grass', 'grass', 'tall_grass', 'fern', 'large_fern'], FARM_RADIUS, { forDig: true })
      if (t) {
        let b = null
        try { b = bot.blockAt(new Vec3(t.x, t.y, t.z)) } catch (_) { b = null }
        if (b && isSeedTuft(b.name)) {
          if (walkTo(bot, ctx, f, 'farm-seeds', t)) return
          await bot.dig(b)
          f.seedDigs = (f.seedDigs | 0) + 1
          return
        }
      }
    }

    // Leg 4 — water dry farmland (bucket trench), capped per step.
    if (hasBucket(bot) && (f.watered | 0) < WATER_CAP) {
      // A trench opened on an earlier tick: pour the bucket now. The cell
      // is remembered (f.trench) because trenchFor only vets diggable
      // ground and would walk past the open pit to the next cell.
      if (f.trench) {
        const t = f.trench
        if (walkTo(bot, ctx, f, 'farm-water', t)) return // f.trench kept: pour on arrival
        let cell = null
        try { cell = bot.blockAt(new Vec3(t.x, t.y, t.z)) } catch (_) { cell = null }
        if (cell && isWaterName(cell.name)) { f.watered = (f.watered | 0) + 1; f.trench = null; f.pourWait = 0; return }
        if ((f.pourWait | 0) > 0) {
          // Pour sent, water still landing: wait it out (replant settle
          // shape), then verify below. The walk key stays down — the body
          // stands at the pit, no displacement strike while waiting.
          f.pourWait--
          f.walkKey = null
          if ((f.pourWait | 0) <= 0) {
            let landed = null
            try { landed = bot.blockAt(new Vec3(t.x, t.y, t.z)) } catch (_) { landed = null }
            if (landed && isWaterName(landed.name)) {
              f.watered = (f.watered | 0) + 1
              try { console.log(`farm water trench at ${t.x},${t.y},${t.z}`) } catch (_) { /* log best-effort */ }
            } else {
              strike(ctx, t) // honest: the pour missed, the pit is struck
            }
            f.trench = null
          }
          return
        }
        // Buckets pour through use, not useOn (activateBlock is a no-op
        // for them on both bodies): look at the pit, use the bucket, and
        // count the watering only when the water reads back.
        if (await equipHeld(bot, 'water_bucket')) {
          try { await bot.lookAt(new Vec3(t.x + 0.5, t.y + 0.5, t.z + 0.5)) } catch (_) { /* aim best-effort */ }
          try { await bot.activateItem() } catch (_) { strike(ctx, t); f.trench = null; return }
          f.pourWait = POUR_SETTLE_TICKS
          f.walkKey = null
        } else {
          f.trench = null // bucket gone mid-step: release the pit
        }
        return
      }
      const fl = nearestCell(bot, ctx, ['farmland'], FARM_RADIUS)
      if (fl) {
        let b = null
        try { b = bot.blockAt(new Vec3(fl.x, fl.y, fl.z)) } catch (_) { b = null }
        if (b && needsWater(b) && !waterNear(bot, fl)) {
          const t = trenchFor(bot, ctx, fl)
          if (!t) { strike(ctx, fl); return }
          if (walkTo(bot, ctx, f, 'farm-water', t)) return
          let tb = null
          try { tb = bot.blockAt(new Vec3(t.x, t.y, t.z)) } catch (_) { tb = null }
          if (tb && !isWaterName(tb.name)) {
            if (!isTillable(tb.name) && tb.name !== 'sand' && tb.name !== 'gravel') { strike(ctx, t); return }
            try { if (denyReason(bot, tb, ctx)) { strike(ctx, t); return } } catch (_) { strike(ctx, t); return }
            await bot.dig(tb)
            f.trench = { x: t.x, y: t.y, z: t.z }
            f.pourWait = 0
            return // pour the water next tick, on the settled cell
          }
          // trenchFor only returns diggable ground, so an open pit here is
          // unreachable — the pour lives in the f.trench block above.
          strike(ctx, t)
          return
        }
      }
    }

    // Leg 5 — till soil near water (free hydration) or with a bucket.
    if ((f.tilled | 0) < TILL_CAP) {
      // A hoe first: craft one (craftany, the beds precedent) or skip the
      // leg this step — never fail the step for missing tool mats.
      if (!hasHoe(bot)) {
        let res = null
        try { res = require('./craftany')(bot, ctx, 'wooden_hoe', 1) } catch (e) { res = { done: false, line: String((e && e.message) || e) } }
        if (res === 'running') return
        if (!res || res.done !== true) {
          f.noHoe = true
        } else {
          f.noHoe = false
        }
      }
      if (hasHoe(bot) && !f.hoedLine) {
        f.hoedLine = true
        try { console.log('farm hoe ready') } catch (_) { /* log best-effort */ }
      }
      if (hasHoe(bot)) {
        const s = nearestCell(bot, ctx, ['grass_block', 'dirt'], FARM_RADIUS)
        if (s && (waterNear(bot, s) || hasBucket(bot))) {
          if (walkTo(bot, ctx, f, 'farm-till', s)) return
          let sb = null
          try { sb = bot.blockAt(new Vec3(s.x, s.y, s.z)) } catch (_) { sb = null }
          if (!sb || !isTillable(sb.name)) { strike(ctx, s); return }
          const hoe = findInPack(bot, (i) => typeof i.name === 'string' && i.name.endsWith('_hoe'))
          if (hoe && await equipHeld(bot, hoe.name)) {
            await bot.activateBlock(sb)
            f.tilled = (f.tilled | 0) + 1
            try { console.log(`farm till ${sb.name} at ${s.x},${s.y},${s.z}`) } catch (_) { /* log best-effort */ }
          }
          return
        }
      }
    }

    // Leg 6 — carry wheat to sheep (lure; breed where the body allows).
    // feedReady bounds the loop: only near sheep pull the leg, and a fresh
    // lure cools it down (wheat is never consumed on V2, so without the
    // cooldown the step would re-pick itself every tick).
    if (!(f.fedSheep | 0)) {
      const found = feedReady(bot, ctx)
      if (found) {
        const sp = { x: found.position.x, y: found.position.y, z: found.position.z }
        if (walkTo(bot, ctx, f, 'farm-feed', sp)) {
          // Hold the wheat out while walking: sheep follow a holder.
          try {
            if (!(bot.heldItem && bot.heldItem.name === 'wheat')) await equipHeld(bot, 'wheat')
          } catch (_) { /* hold best-effort */ }
          return
        }
        try {
          if (!(bot.heldItem && bot.heldItem.name === 'wheat')) await equipHeld(bot, 'wheat')
        } catch (_) { /* hold best-effort */ }
        // Breed where the body serves entity-use (v1); the V2 mod has no
        // entity-use RPC yet, so there the leg lures and says so.
        let bred = 0
        try {
          if (typeof bot.activateEntity === 'function') {
            const first = bring.findAnimal(bot, null, { prey: ['sheep'] })
            if (first && first.id != null && bot.entities && bot.entities[first.id]) {
              await bot.activateEntity(bot.entities[first.id])
              bred++
            }
          }
        } catch (_) { /* breed best-effort: lure still counts */ }
        f.lure = (f.lure | 0) + 1
        if (bred > 0 || (f.lure | 0) >= LURE_TICKS) {
          f.fedSheep = 1
          try { if (ctx) ctx.farmFedAt = Date.now() } catch (_) { /* cooldown best-effort */ }
          try { say(bot, bred > 0 ? 'fed the sheep wheat' : 'brought wheat to the sheep') } catch (_) { /* chat best-effort */ }
          return
        }
        return
      }
    }

    // Nothing actionable: done with the honest line.
    f.fail = f.noHoe ? 'no-hoe-mats' : '-'
    try { chatStep(bot, ctx, 'on my own: tending the wheat field') } catch (_) { /* chat best-effort */ }
    return void finish(bot, ctx, f, true, null, gen)
  } catch (e) {
    try { console.log(`farm error ${(e && e.message) || e}`) } catch (_) { /* log best-effort */ }
    strike(ctx, (f && f.walkKey) || 'error')
    if ((f.strikes | 0) >= UNREACHABLE_STRIKES) return void finish(bot, ctx, f, false, 'unreachable', gen)
  } finally {
    try { f.busy = false } catch (_) { /* flag best-effort */ }
  }
}

// Manual-order probe (orders.js setFarm): anything to do right now.
function workReady(bot, ctx) {
  try {
    const bp = botPos(bot)
    if (!bp) return false
    if (nearestCell(bot, ctx, ['wheat'], 64, { forDig: true })) return true
    if (nearestCell(bot, ctx, ['farmland'], 64)) return true
    if (nearestCell(bot, ctx, ['grass_block', 'dirt'], 64)) return true
    try {
      if (countWheat(bot) > 0 && bring.findAnimal(bot, null, { prey: ['sheep'] })) return true
    } catch (_) { /* no sheep */ }
    return false
  } catch (_) { return false }
}

module.exports = run
module.exports.run = run
module.exports.farmFeasible = farmFeasible
module.exports.workReady = workReady
module.exports.walkTo = walkTo
module.exports.feedReady = feedReady
module.exports.FEED_RADIUS = FEED_RADIUS
module.exports.FEED_COOLDOWN_MS = FEED_COOLDOWN_MS
module.exports.POUR_SETTLE_TICKS = POUR_SETTLE_TICKS
module.exports.isTillable = isTillable
module.exports.isSeedTuft = isSeedTuft
module.exports.isMatureWheat = isMatureWheat
module.exports.isFarmland = isFarmland
module.exports.needsWater = needsWater
module.exports.FARM_RADIUS = FARM_RADIUS
module.exports.WALK_RANGE = WALK_RANGE
module.exports.TILL_CAP = TILL_CAP
module.exports.PLANT_CAP = PLANT_CAP
module.exports.HARVEST_CAP = HARVEST_CAP
module.exports.WATER_CAP = WATER_CAP
