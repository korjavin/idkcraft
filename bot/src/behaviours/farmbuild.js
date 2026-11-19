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
const { acquire } = require('./acquire')
const { stepFailed } = require('../step')
const { countItems } = require('../perception')

const PROGRESS_LOG_MS = 30000
const ITEM = { planks: 'oak_planks', fence: 'oak_fence', gate: 'oak_fence_gate', door: 'oak_door', chest: 'chest', farmland: 'wooden_hoe', water: 'water_bucket' }
const ONE = new Set(['farmland', 'water']) // a tool, not a stack

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
  const idx = build.nextCellIdx(bot, fb, view.buildSkip, view)
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
      const r = acquire(bot, ctx, item, n, [], alts.length ? alts : [item])
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

// Feasible for any bot: an owner 'build farm' order, or a complete castle
// (the next project); day only, never once built.
function feasible(facts, bot, ctx) {
  if (!facts || facts.time !== 'day' || !ctx) return false
  const fb = ctx.farmBuild
  if (fb && fb.built) return false
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
