'use strict'

// farmbuild: build the farm (idkcraft-qphv.1) — barn, fenced pen, crop
// plot (src/farm-blueprint.js). No builder of its own: the house builder
// (build.js) lays the plan on a home of kind 'farm'. build() reads ctx.home
// and its ctx.build* bookkeeping, so it runs on a view of ctx whose home is
// ctx.farmBuild and whose build* keys live in ctx.farmBuild.state — the
// house keeps its own (async flights capture the view, so late verdicts
// land on the farm too). Everything else (placeInFlight, stepStatus,
// stepFail...) is the real ctx.
//
// Materials: the next cell's item missing -> acquire() (pack -> craft ->
// recurse -> world source), the castlefetch item names for the shared kinds.
// Site: near the castle, else the house, else the body; logged once
// 'farm site=x,y,z'. Progress: 'farm progress built=N/M phase=…' per 30 s.

const blueprint = require('../farm-blueprint')
const build = require('./build')
const { acquire, fromChest } = require('./acquire')
const { stepFailed } = require('../step')
const { countItems } = require('../perception')
const { goals } = require('mineflayer-pathfinder')
const Vec3 = require('vec3')

const PROGRESS_LOG_MS = 30000
const ITEM = { planks: 'oak_planks', fence: 'oak_fence', gate: 'oak_fence_gate', door: 'oak_door', chest: 'chest', farmland: 'wooden_hoe', water: 'water_bucket' }
const ONE = new Set(['farmland', 'water']) // a tool, not a stack
// Crop cycle (qphv.2) on the built field.
const CROP_EVERY_MS = 10 * 60 * 1000 // a far bot still revisits the field
const CROP_LOG_MS = 10 * 60 * 1000
const BREAD_KEEP = 4 // food recovery eats from the pack
const HAY = 9 // wheat per hay_block
const FIELD_NEAR = 10
const CHEST_REACH = 3.5
const FIELD_STEP_COST = 10 // dearer, never banned: a path over the field stays possible
const CROP_NAMES = new Set(['wheat', 'carrots', 'potatoes', 'beetroots'])
const SEED_NAMES = ['wheat_seeds', 'carrot', 'potato', 'beetroot_seeds']
const guarded = new WeakSet()

function viewOf(ctx, fb) {
  if (!fb.state) fb.state = {}
  const mine = (k) => k === 'home' || (typeof k === 'string' && k.startsWith('build'))
  return new Proxy(ctx, {
    get(t, k) { return k === 'home' ? fb : mine(k) ? fb.state[k] : t[k] },
    set(t, k, v) { if (k === 'home') return true; if (mine(k)) fb.state[k] = v; else t[k] = v; return true },
  })
}

function anchorOf(bot, ctx) {
  const avoid = []
  let at = null
  try {
    const c = ctx.castle
    if (c && c.site) {
      const { w, d } = require('../castle').siteDimensions(c.rot | 0, c.blueprintVersion)
      avoid.push({ x0: c.site.x, z0: c.site.z, x1: c.site.x + w - 1, z1: c.site.z + d - 1 })
      at = { x: c.site.x + w / 2, y: c.site.y, z: c.site.z + d / 2 }
    }
  } catch (_) { /* no castle box */ }
  const h = ctx.home
  if (h && h.site && h.kind !== 'castle') {
    avoid.push({ x0: h.site.x, z0: h.site.z, x1: h.site.x + 6, z1: h.site.z + 5 })
    if (!at) at = h.site
  }
  if (!at) at = bot.entity && bot.entity.position
  return { at, avoid }
}

function progressLine(bot, ctx, fb, idx, now) {
  if (now - (fb.loggedAt || 0) < PROGRESS_LOG_MS) return
  fb.loggedAt = now
  const p = build.houseProgress(bot, fb)
  const phase = idx < 0 ? 'complete' : blueprint.PLAN[idx].phase
  console.log(`farm progress built=${p.done}/${p.total} phase=${phase}`)
}

function run(bot, ctx) {
  const fb = ctx.farmBuild || (ctx.farmBuild = {})
  fb.kind = 'farm'
  if (!fb.site) {
    const { at, avoid } = anchorOf(bot, ctx)
    const site = at ? blueprint.siteFor(bot, at, avoid) : null
    if (!site) {
      if (ctx.stepStatus !== 'failed:no-site') console.log('farm failed:no-site')
      stepFailed(ctx, 'no-site')
      return
    }
    fb.site = site
    fb.built = false
    console.log(`farm site=${site.x},${site.y},${site.z}`)
  }
  const view = viewOf(ctx, fb)
  guardField(bot, ctx)
  const idx = build.nextCellIdx(bot, fb, view.buildSkip, view)
  if (fb.built) {
    if (idx < 0) return cropTick(bot, ctx, fb)
    // Own-dug (castle shape): a laid cell went missing (a trampled field
    // cell reads dirt) — back to the builder, which lays it again.
    const c = blueprint.PLAN[idx]
    console.log(`farm own-dug cell=${fb.site.x + c.dx},${fb.site.y + c.dy},${fb.site.z + c.dz} kind=${c.kind} requeued`)
    fb.built = false
  }
  progressLine(bot, ctx, fb, idx, Date.now())
  if (idx >= 0 && !ctx.placeInFlight && !view.buildCellsInFlight) {
    const cell = blueprint.PLAN[idx]
    const want = cell.kind === 'clear' ? null : build.wantItem(cell)
    if (want && build.cellLoaded(bot, fb, cell) && countItems(bot, want) <= 0) {
      const item = ITEM[cell.kind]
      let n = 1
      if (!ONE.has(cell.kind)) {
        n = 0
        for (const c of blueprint.PLAN) if (c.kind === cell.kind && !build.cellDone(bot, fb, c)) n++
        n = Math.max(1, Math.min(64, n))
      }
      let alts = [item]
      try { alts = require('../sources').family(item).filter(want) } catch (_) { /* the item alone */ }
      if (!alts.length) alts = [item]
      const c = fromChest(bot, ctx, alts, n) // chests first, the castle's order
      if (c === 'running') return
      const r = c === 'done' ? 'done' : acquire(bot, ctx, item, n, [], alts)
      if (r === 'running') return
      if (r !== 'done') {
        const why = String(r).replace(/^failed:/, '')
        if (ctx.stepStatus !== r) console.log(`farm failed:${why} cell=${cell.kind}`)
        stepFailed(ctx, why)
        return
      }
    }
  }
  build(bot, view)
  if (fb.built && ctx.stepStatus === 'done') console.log(`farm done site=${fb.site.x},${fb.site.y},${fb.site.z}`)
}

// Pathfinder step cost over the field (qphv.2): walks go round the crops
// where a path exists. One closure per movements object.
// shortcut: v1 mineflayer movements only; the bridge maps no step areas, add one if v2 tramples.
function guardField(bot, ctx) {
  const mov = bot && bot.pathfinder && bot.pathfinder.movements
  if (!mov || !Array.isArray(mov.exclusionAreasStep) || guarded.has(mov)) return
  guarded.add(mov)
  mov.exclusionAreasStep.push((b) => {
    try { return b && b.position && blueprint.inFieldAt(ctx.farmBuild, b.position) ? FIELD_STEP_COST : 0 } catch (_) { return 0 }
  })
}

const abs = (fb, dx, dy, dz) => new Vec3(fb.site.x + dx, fb.site.y + dy, fb.site.z + dz)
const blockAt = (bot, p) => { try { return bot.blockAt(p) } catch (_) { return null } }

// The field's crop cells: planted / mature / empty farmland (loaded only).
function fieldScan(bot, fb) {
  const farm = require('./farm')
  const out = { planted: 0, mature: 0, empty: 0, loaded: false }
  for (const c of blueprint.PLAN) {
    if (c.kind !== 'farmland') continue
    const soil = blockAt(bot, abs(fb, c.dx, c.dy, c.dz))
    const up = blockAt(bot, abs(fb, c.dx, c.dy + 1, c.dz))
    if (!soil || !up) continue
    out.loaded = true
    if (CROP_NAMES.has(up.name)) { out.planted++; if (farm.isMatureCrop(up)) out.mature++ } else if (soil.name === 'farmland' && (up.name === 'air' || up.name === 'cave_air')) out.empty++
  }
  return out
}

function cropLine(bot, fb, now) {
  if (now - (fb.cropLoggedAt || 0) < CROP_LOG_MS) return
  fb.cropLoggedAt = now
  const s = fieldScan(bot, fb)
  console.log(`farm crop planted=${s.planted} mature=${s.mature} harvested=${fb.harvested | 0} hay=${fb.hay | 0}`)
}

function walk(bot, fb, key, p, range) {
  const bp = bot.entity && bot.entity.position
  if (!bp) return true
  if (Math.hypot(bp.x - (p.x + 0.5), bp.y - p.y, bp.z - (p.z + 0.5)) <= range) { fb.walkKey = null; return false }
  if (fb.walkKey !== key) {
    fb.walkKey = key
    try { bot.pathfinder.setGoal(new goals.GoalNear(p.x, p.y, p.z, 2)) } catch (_) { /* next tick retries */ }
  }
  return true
}

// One crop tick on the built farm: bread for food recovery, the wheat
// surplus as hay_block into the barn chest, seeds (chest, else farm's tuft
// leg), then the wheat 'farm' step on the field — harvest ripe crops,
// replant, plant empty farmland (trampled cells came back via own-dug).
function cropTick(bot, ctx, fb) {
  const now = Date.now()
  cropLine(bot, fb, now)
  const n = (i) => countItems(bot, (x) => x === i)
  const wheat = n('wheat')
  const bread = n('bread')
  if (bread < BREAD_KEEP && wheat >= 3) {
    const r = acquire(bot, ctx, 'bread', bread + Math.min(BREAD_KEEP - bread, Math.floor(wheat / 3)))
    if (r === 'running') return
  } else if (wheat >= HAY) {
    const r = acquire(bot, ctx, 'hay_block', n('hay_block') + Math.floor(wheat / HAY))
    if (r === 'running') return
  }
  if (n('hay_block') > 0 && !fb.storeFull) {
    const at = abs(fb, 5, 0, 4) // the barn chest cell
    if (fb.storing) return
    if (walk(bot, fb, 'farm-barn', at, CHEST_REACH)) return
    fb.storing = true
    const stock = require('./stockpile')
    stock.rememberChests(ctx, [at])
    stock.depositToChest(bot, ctx, ['hay_block'], at).then(({ put }) => {
      fb.hay = (fb.hay | 0) + put
      if (put) console.log(`farm store hay_block=${put} chest=${at.x},${at.y},${at.z}`)
      else fb.storeFull = true // full or gone: hay stays in the pack until the next build pass
    }).catch(() => {}).finally(() => { fb.storing = false; fb.walkKey = null })
    return
  }
  if (!SEED_NAMES.some((s) => n(s) > 0) && fromChest(bot, ctx, SEED_NAMES, 16) === 'running') return
  const center = abs(fb, blueprint.WATER.dx, 0, blueprint.WATER.dz)
  if (walk(bot, fb, 'farm-field', center, FIELD_NEAR)) return
  fb.walkKey = null
  fb.cropAt = now
  return require('./farm')(bot, ctx)
}

// Feasible for any bot: an owner 'build farm' order, or a complete castle
// (the next project); day only. Once built: the crop cycle when the field
// has work in sight (a missing cell, a ripe crop, empty farmland and
// seeds) or every CROP_EVERY_MS.
function feasible(facts, bot, ctx) {
  if (!facts || facts.time !== 'day' || !ctx) return false
  const fb = ctx.farmBuild
  if (fb && fb.built) {
    if (!bot || !fb.site) return false
    guardField(bot, ctx)
    if (Date.now() - (fb.cropAt || 0) >= CROP_EVERY_MS) return true
    try {
      if (build.nextCellIdx(bot, fb, (fb.state && fb.state.buildSkip) || [], viewOf(ctx, fb)) >= 0) return true
      const s = fieldScan(bot, fb)
      return s.mature > 0 || (s.empty > 0 && SEED_NAMES.some((i) => countItems(bot, (x) => x === i) > 0))
    } catch (_) { return false }
  }
  return !!((fb && fb.ordered) || (ctx.castle && ctx.castle.phase === 'complete'))
}

// Gauge for the goal rate line: placed farm cells, or null with no farm.
function progressDone(bot, ctx) {
  const fb = ctx && ctx.farmBuild
  if (!fb || !fb.site || fb.built) return null
  try { return build.houseProgress(bot, { ...fb, kind: 'farm' }).done } catch (_) { return null }
}

module.exports = run
module.exports.run = run
module.exports.feasible = feasible
module.exports.progressDone = progressDone
module.exports.viewOf = viewOf
