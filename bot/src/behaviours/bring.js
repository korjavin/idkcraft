'use strict'

const { goals } = require('mineflayer-pathfinder')
const { findNearest, loadedSearchRadius, startFarSearch, stepFarSearch, resolveFindIds, ORE_NAMES } = require('./scout')
const { countItems } = require('../perception')
const resources = require('../resources')
const fightMod = require('./fight')
const exploreMod = require('./explore')
const recover = require('./recover')
const stockpileMod = require('./stockpile')
const metrics = require('../metrics')
const { say, clearGoal, denyReason, logDeny } = require('./util')
const itemMod = require('./bringitem')
const Vec3 = require('vec3')

const woolMod = require('./wool')

// Bring: the 'bring me <block> [count]' order. The bot walks to the nearest
// matching block alone, digs up to N drops, walks back to the requesting
// player and tosses the drops nearby.
//
// Explicit player ORDER (like ctx.lead), not a brain choice: while ctx.bring
// is set the ticker dispatches here instead of the brain/work, except fight
// which still preempts. Primitives reused, not reinvented: findNearest
// (scout) for search, GoalNear + dig-in-flight + GoalBlock pickup (gather),
// player approach (follow), honest-unseen answer (3a7).
//
// Owner direction: no branching rescue logic. Failure points refuse with a
// message (the ef3/rw4.6 stuck menu owns the choices); the FSM reserve is a
// plain refusal. Bring raises exactly one stuck fact: a below-feet trap
// denial in the dig phase (atl.17 — the stance is a property of the place,
// re-finding the same nearest block never changes it, so the menu owns the
// sidestep). Every other stall refuses and ends the order instead of
// starting an episode (unlike follow/roam/lead, whose detectors feed the
// menu, and gather, which reports at its final). The ticker
// place_error/no-displacement backstops still catch a bring that loops
// without refusing, and release() resumes ctx.bring untouched.
const FIND_RADIUS = 48
const WANT_ORE = 3
const WANT_LOGS = 4
const WANT_FOOD = 3
const WANT_MAX = 16
const WALK_STALL_TICKS = 10 // stationary ticks before skipping an unreachable target
const CHEST_STALL_TICKS = 5 // far+standing ticks before the chest fetch falls back (a single
  // far reading is often a recovering pathfinder, not an unreachable chest)
const MOVE_TOLERANCE = 0.5
const RETURN_RANGE = 2

// Search budget (idkcraft-atl.9): K=24 legs or 5 minutes, whichever binds
// first (time is the intended real limit). The 22 legs out to ring-128
// walk ~770 blocks (~3 min open-ground + re-finds), so they fit the cap
// on easy terrain; stalls and stuck episodes bind it earlier in forest.
// Plain constants — the values never change at runtime (not forwarded in
// compose); tests stub them through the module export below.
const SEARCH_BUDGET = { legs: 24, minutes: 5 }
function searchLegs() {
  return SEARCH_BUDGET.legs
}
function searchMinutes() {
  return SEARCH_BUDGET.minutes
}

function dropFor(blockName) {
  if (blockName.endsWith('_log')) return blockName
  const base = blockName.endsWith('_ore') ? blockName.slice(0, -'_ore'.length) : blockName
  const raw = base.match(/(iron|copper|gold)$/)
  if (raw) return `raw_${raw[1]}`
  if (base === 'lapis' || base.endsWith('_lapis')) return 'lapis_lazuli'
  return base // coal, diamond, emerald, redstone, quartz, dirt, ...
}

// Only ores and logs are fetchable (the bead's resources): anything else
// (stone->cobble, grass->dirt, ...) drops a different item, so the drop
// count would never grow and the order would mine the area forever.
function isBringable(blockName) {
  return blockName.endsWith('_ore') || blockName.endsWith('_log')
}

// The share keep-list and plan live in bringitem.js (did.4 split); the
// dispatcher reaches them as itemMod.sharePlan.

function needsPickaxe(blockName) {
  return blockName.endsWith('_ore')
}

// Harvest tiers (vanilla): coal/iron/copper/lapis/quartz need stone or
// better; gold/diamond/redstone/emerald need iron or better. Wooden and
// golden are refused for everything. The refusal names the required tier.
const PICKAXE_RANK = { wooden: 0, golden: 0, stone: 1, iron: 2, diamond: 3, netherite: 4 }
function requiredTier(blockName) {
  const base = blockName.endsWith('_ore') ? blockName.slice(0, -'_ore'.length) : blockName
  if (/(gold|diamond|redstone|emerald)$/.test(base)) return 'iron'
  return 'stone'
}
function hasPickaxe(bot, blockName) {
  const need = blockName && blockName.endsWith('_ore') ? (requiredTier(blockName) === 'iron' ? 2 : 1) : 0
  let best = -1
  try {
    const items = bot && bot.inventory && typeof bot.inventory.items === 'function' ? bot.inventory.items() : []
    for (const i of items) {
      const m = typeof i.name === 'string' && i.name.match(/^(wooden|golden|stone|iron|diamond|netherite)_pickaxe$/)
      if (m) best = Math.max(best, PICKAXE_RANK[m[1]])
    }
  } catch (_) { return false }
  return best >= need
}
function tierArticle(tier) {
  return tier === 'iron' ? 'an' : 'a'
}


function countDrop(bot, drop) {
  try {
    return countItems(bot, (n) => n === drop)
  } catch (_) {
    return 0
  }
}


function bringKind(ctx) {
  return (ctx.bring && ctx.bring.kind) || 'block'
}

function skipKey(p) {
  return `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`
}

function refuse(bot, ctx, line) {
  // A failed sub-order (did.4) reads as the parent's honest line: the gap
  // that never filled, not the leg that failed it.
  const o = ctx && ctx.bring
  const sub = o && o.subFor && o.subWant && o.subWord
    ? `could not get ${o.subWant} ${o.subWord} for the ${o.subFor} in time`
    : null
  say(bot, sub || line)
  metrics.bring.inc({ outcome: 'refused', kind: bringKind(ctx) })
  ctx.bring = null
  clearGoal(bot, ctx)
}

function done(bot, ctx) {
  metrics.bring.inc({ outcome: 'done', kind: bringKind(ctx) })
  ctx.bring = null
  clearGoal(bot, ctx)
}

// Food hunt prey (idkcraft-n7k): the order seed (isFoodRequest/findEdible)
// lives in bringitem.js with the other order-creation rungs; the dispatcher
// keeps only what the shared prey phases read.
const PREY_NAMES = new Set(['cow', 'pig', 'sheep', 'chicken', 'rabbit'])
const PREY_DROPS = { cow: 'beef', pig: 'porkchop', sheep: 'mutton', chicken: 'chicken', rabbit: 'rabbit' }

// The item order rungs (did.1 normalisation, resolver, pack plan, honest
// stub) live in bringitem.js (did.4 split); the dispatcher reaches them as
// itemMod.*.

function animalDist(bp, epos) {
  try {
    return typeof bp.distanceTo === 'function'
      ? bp.distanceTo(epos)
      : Math.hypot(bp.x - epos.x, bp.y - epos.y, bp.z - epos.z)
  } catch (_) { return null }
}

// Same-block test (8gc): the pickup counts only once the body stands in
// the death-spot block — the GoalBlock arrival cell (the pathfinder
// floors both sides). A 3D sphere would count drops a block below from
// the rim (revmux 01 core-1): the server picks up ±1 across but only
// ~0.5 down.
function sameCell(bp, dp) {
  try {
    return Math.floor(bp.x) === Math.floor(dp.x) &&
      Math.floor(bp.y) === Math.floor(dp.y) &&
      Math.floor(bp.z) === Math.floor(dp.z)
  } catch (_) { return false }
}

// Nearest passive animal within 48; when drop is set (second+ kill of one
// order) only animals dropping it, so one order tosses one food kind.
// opts (did.3 wool) narrows the hunt: { prey, skipSheared, color,
// skipIds, skipColors }. Without opts the food shape is byte-identical
// (forage.js relies on it). A color filter is strict — it only ever
// carries an explicitly ordered color, which is a promise (bare families
// pass none and hunt any sheep). skipIds (8gc stall skips) applies to
// every prey kind, sheep filters only to sheep.
function findAnimal(bot, drop, opts) {
  const bp = bot && bot.entity && bot.entity.position
  if (!bp) return null
  const o = opts && typeof opts === 'object' ? opts : null
  const prey = o && o.prey ? new Set(o.prey) : PREY_NAMES
  let best = null
  let bestDist = Infinity
  for (const e of Object.values(bot.entities || {})) {
    if (!e || !e.position || e.isValid === false) continue
    if (!prey.has(e.name)) continue
    if (drop && PREY_DROPS[e.name] !== drop) continue
    if (o && o.skipIds && typeof o.skipIds.has === 'function' && o.skipIds.has(e.id)) continue
    if (o && e.name === 'sheep') {
      const skipColors = o.skipColors && typeof o.skipColors.has === 'function' && o.skipColors.size ? o.skipColors : null
      if (o.skipSheared || o.color || skipColors) {
        const w = woolMod.sheepWool(bot, e)
        if (o.skipSheared && w.sheared) continue
        if (o.color && w.color !== o.color) continue
        // Dead colours (did.4 lock release): stranded, never hunted again
        // this sub-order. Unreadable metadata hunts fail-open.
        if (skipColors && w.color && skipColors.has(w.color)) continue
      }
    }
    const d = animalDist(bp, e.position)
    if (typeof d !== 'number' || d > FIND_RADIUS) continue
    if (d < bestDist) { bestDist = d; best = e }
  }
  if (!best) return null
  return { name: best.name, id: best.id, position: best.position, distance: Math.round(bestDist) }
}

function entityById(bot, id) {
  for (const e of Object.values(bot.entities || {})) {
    if (e && e.id === id && e.isValid !== false && e.position) return e
  }
  return null
}

// Union of the wool id skips (8gc): shorn sheep plus stall-struck ones.
// Either side alone returns as-is; the union allocates only while a hunt
// has struck out on an animal it cannot reach.
function preySkipIds(o) {
  const a = o.shearedIds
  const b = o.unreachIds
  const na = !a || typeof a.size !== 'number' || a.size === 0
  const nb = !b || typeof b.size !== 'number' || b.size === 0
  if (na) return nb ? null : b
  if (nb) return a
  return new Set([...a, ...b])
}

// Fence fact (n7k): log only — whether the prey stands near player fences
// is a future model choice, never a branch here.
function fenceFact(bot, animal) {
  try {
    const p = animal.position
    const around = [[0, -1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]]
    for (const [ox, oy, oz] of around) {
      const b = bot.blockAt && bot.blockAt({ x: Math.floor(p.x) + ox, y: Math.floor(p.y) + oy, z: Math.floor(p.z) + oz })
      if (b && typeof b.name === 'string' && b.name.endsWith('_fence')) {
        console.log(`hunt animal near fences: ${animal.name} at ${Math.round(p.x)} ${Math.round(p.y)} ${Math.round(p.z)}`)
        return
      }
    }
  } catch (_) { /* fact best-effort */ }
}

// Progress is horizontal displacement or a new standing level — the same
// rule as gather.js: tower jumps in place are standing still.
function progressed(bp, last, grounded) {
  if (!last) return true
  if (Math.hypot(bp.x - last.x, bp.z - last.z) > MOVE_TOLERANCE) return true
  return !!grounded && Math.floor(bp.y) !== Math.floor(last.y)
}

function atPos(bot) {
  const bp = bot.entity && bot.entity.position
  return bp ? `${Math.round(bp.x)} ${Math.round(bp.y)} ${Math.round(bp.z)}` : 'unknown'
}

// Per-leg model choice (ef3/rw4.6 shape): exactly two labels — laya answers
// reliably only with <=2 options (brain.js ask). give_up refuses honestly
// with the legs covered; the FSM reserve is search_more until K.
const SEARCH_INSTRUCTIONS = 'Choose whether the bring order keeps searching'
const SEARCH_CRITERIA = {
  search_more: 'legs remain: walk another area and look again',
  give_up: 'no hope nearby: refuse with the areas covered',
}

function searchText(o, s) {
  const kind = o.kind || 'block'
  const what = kind === 'food' ? 'food' : kind === 'wool' ? 'wool' : (o.name || 'block')
  return `search=${what} legs=${s.legs}/${searchLegs()} last=${s.last || 'empty'}`
}

// Model leg choice with the FSM as fallback and disagreement reference,
// exactly like recover chooseRecovery: { action, source, fsm, model }.
async function chooseBringSearch(brain, text, legsLeft) {
  const feasible = legsLeft > 0 ? ['search_more', 'give_up'] : ['give_up']
  const fsm = legsLeft > 0 ? 'search_more' : 'give_up'
  if (feasible.length <= 1) return { action: 'give_up', source: 'only-option', fsm, model: null }
  if (!brain || typeof brain.ask !== 'function') return { action: fsm, source: 'fsm', fsm, model: null }
  const model = brain.source || brain.name || 'model'
  const criteria = {}
  for (const n of feasible) criteria[n] = SEARCH_CRITERIA[n]
  const fail = (reason) => {
    metrics.escalation.inc({ from: model, to: 'fsm', reason })
    return { action: fsm, source: 'fsm-fallback', fsm, model }
  }
  try {
    const label = await brain.ask({ state: text, instructions: SEARCH_INSTRUCTIONS, criteria, situation: text })
    if (label !== fsm) {
      console.error(`brain disagree source=${model} model=${label} fsm=${fsm} reason=bring-search facts=${text}`)
    }
    if (!feasible.includes(label)) return fail('invalid')
    return { action: label, source: model, fsm, model }
  } catch (err) {
    const msg = String((err && err.message) || err)
    const reason = (err && err.name === 'TimeoutError') ? 'timeout'
      : msg.startsWith('jev missing') ? 'invalid'
      : 'error'
    return fail(reason)
  }
}

// Source choice (idkcraft-atl.15): a block order fetches from one of two
// sources — walk to exposed ore (seen live or remembered) or dig a buried
// hit. Costs are rough seconds: walk at ~4 blocks/s, digging ~2 s/block
// plus a fixed shaft penalty once the hole is deeper than a quick dig (a
// >4-deep shaft is where prod self-traps: 9 buried-refusals in 14 days),
// remembered spots ×1.5 for staleness. No A*: if relief lies about
// distance, bot.pathfinder.getPathTo(movements, goal, timeout) is the
// upgrade path. Plain constants — the values never change at runtime;
// tests stub them through the module export below.
const SOURCE_COST = {
  walkBlocksPerSec: 4,
  digSecPerBlock: 2,
  deepDigDepth: 4,
  shaftPenaltySec: 25,
  memoryFactor: 1.5,
  budget: 160, // == scout SEARCH_MAX, the loaded-world edge. Known gap
  // (revmux 01 body-2, follow-up bead): farShellDone and the within96
  // pool stop the shells at 96 whenever nearer ore exists, so live
  // exposed past 96 is found only when the inner shells are empty —
  // exposed-aware shells need a scout change shared with gather/find-me.
  clearRatio: 0.5, // cheaper than half the rival: a clear winner, no model
}

function walkCost(distH) {
  return Math.max(0, distH) / SOURCE_COST.walkBlocksPerSec
}

function digCost(depthBelow) {
  const d = Math.max(0, depthBelow)
  return d * SOURCE_COST.digSecPerBlock + (d > SOURCE_COST.deepDigDepth ? SOURCE_COST.shaftPenaltySec : 0)
}

// Scout results normalised to costed candidates. Exposed (live or memory)
// always means walk; buried means walk-to plus the dig below the feet.
function liveExposed(bp, res) {
  if (!res || !res.position || res.exposed === false) return null
  const p = res.position
  const distH = Math.hypot(p.x - bp.x, p.z - bp.z)
  return { kind: 'live', name: res.name, pos: p, distH, dist: res.distance, cost: walkCost(distH), ageMs: null }
}

function buriedCand(bp, res) {
  if (!res || !res.position) return null
  const p = res.position
  const distH = Math.hypot(p.x - bp.x, p.z - bp.z)
  const depthBelow = Math.max(0, Math.floor(bp.y) - Math.floor(p.y))
  return { kind: 'buried', name: res.name, pos: p, distH, dist: res.distance, depthBelow, cost: walkCost(distH) + digCost(depthBelow), ageMs: null }
}

// Cheaper walk wins between the two exposed candidates — same action
// (walk_exposed), so no model is needed to split them.
function bestExposed(a, b) {
  if (a && b) return a.cost <= b.cost ? a : b
  return a || b || null
}

// Canonical memory type names for a bring request: memory stores exact
// block names, so 'iron' must match the deepslate variant too — the same
// expansion resolveFindIds does for ids, plus its singular fallback.
function memoryNames(bot, requestName) {
  try {
    if (requestName === 'ore' || requestName === 'ores') return [...ORE_NAMES]
    const byName = (bot.registry && bot.registry.blocksByName) || {}
    if (requestName === 'log' || requestName === 'logs' || (typeof requestName === 'string' && requestName.endsWith('_log'))) {
      return Object.keys(byName).filter((n) => n.endsWith('_log'))
    }
    const namesFor = (req) => {
      const out = []
      if (byName[req]) out.push(req)
      const base = req.endsWith('_ore') ? req.slice(0, -'_ore'.length) : req
      const pattern = `${base}_ore`
      for (const n of Object.keys(byName)) {
        if (n !== req && n.includes(pattern)) out.push(n)
      }
      return out
    }
    let out = namesFor(requestName)
    if (out.length === 0 && requestName.length > 1 && requestName.endsWith('s')) out = namesFor(requestName.slice(0, -1))
    return out
  } catch (_) { return [] }
}

// Best exposed remembered find (candidate (b)): nearest exposed===true
// memory item for the request, read through the shared resources.exposedOf
// (atl.16): a loaded chunk re-verifies live (name still there, still
// exposed), an unloaded chunk trusts the flag, a mined-out loaded cell
// reads undefined and drops the candidate. The protected pre-check stays
// bring-side, the same rule as the live loop.
function memoryExposed(bot, ctx, bp, requestName, skip) {
  try {
    const names = memoryNames(bot, requestName)
    if (names.length === 0) return null
    const hasSkip = skip && typeof skip.has === 'function'
    const item = resources.nearest(ctx, bp, names, (it) => it.exposed !== true || (hasSkip && skip.has(skipKey(it))))
    if (!item || typeof item.x !== 'number') return null
    let now = false
    try { now = resources.exposedOf(bot, item) } catch (_) { now = false }
    if (now !== true) return null // closed up or mined out since noted
    let pre = null
    try {
      const blk = bot.blockAt && bot.blockAt({ x: Math.floor(item.x), y: Math.floor(item.y), z: Math.floor(item.z) })
      pre = blk && denyReason(bot, blk, ctx)
    } catch (_) { pre = null }
    if (pre === 'protected') return null // owner build: same rule as the live loop
    const distH = Math.hypot(item.x - bp.x, item.z - bp.z)
    const dist = Math.hypot(item.x - bp.x, item.y - bp.y, item.z - bp.z)
    return {
      kind: 'memory', name: item.name, pos: { x: item.x, y: item.y, z: item.z },
      distH, dist, cost: walkCost(distH) * SOURCE_COST.memoryFactor,
      ageMs: typeof item.at === 'number' ? Date.now() - item.at : null,
    }
  } catch (_) { return null }
}

// A memory hike past the loaded-world budget stays feasible only against
// a deep shaft (orch default); a shallow dig next to the feet always
// beats hiking past the edge. Without any buried alternative the memory
// is the only option and stays.
function memoryInBudget(mem, buried) {
  if (!mem) return null
  if (mem.dist <= SOURCE_COST.budget) return mem
  if (!buried) return mem
  return buried.depthBelow > SOURCE_COST.deepDigDepth ? mem : null
}

function ageText(ageMs) {
  if (typeof ageMs !== 'number' || ageMs < 0) return 'unknown'
  const mins = Math.floor(ageMs / 60000)
  if (mins < 1) return 'just-noted'
  if (mins < 60) return `${mins}m`
  return `${Math.floor(mins / 60)}h${mins % 60 ? `${mins % 60}m` : ''}`
}

function sourceText(o, exposed, buried) {
  const e = exposed
    ? `walk:${exposed.cost.toFixed(1)}s(dist=${Math.round(exposed.distH)},${exposed.kind === 'memory' ? `age=${ageText(exposed.ageMs)}` : 'live'})`
    : 'walk:none'
  const b = buried
    ? `dig:${buried.cost.toFixed(1)}s(dist=${Math.round(buried.distH)},depth=${Math.round(buried.depthBelow)})`
    : 'dig:none'
  return `source=${(o && o.name) || 'block'} ${e} ${b}`
}

// Sync half of the source decision: { pick, why } or { contested: true }.
// A beyond-budget memory hike never wins deterministically (orch default:
// the model judges the long walk); it can still lose one.
function decideBringSource(exposed, buried) {
  if (exposed && !buried) return { pick: 'exposed', why: 'only-option' }
  if (buried && !exposed) return { pick: 'buried', why: 'only-option' }
  if (!exposed && !buried) return { pick: null, why: 'none' }
  const memoryFar = exposed.kind === 'memory' && exposed.dist > SOURCE_COST.budget
  if (!memoryFar && exposed.cost < buried.cost * SOURCE_COST.clearRatio) return { pick: 'exposed', why: 'clear' }
  if (buried.cost < exposed.cost * SOURCE_COST.clearRatio) return { pick: 'buried', why: 'clear' }
  return { contested: true }
}

// Model source choice with the FSM as fallback and disagreement reference,
// the chooseBringSearch shape: { action, source, fsm, model }. Exactly two
// labels (laya answers reliably only with <=2 options); the FSM reserve
// walks to exposed ore. At most one ask per order: the pick is cached on
// o and a later contested re-find replays it instead of flip-flopping
// between the shaft and the hike per drop.
const SOURCE_INSTRUCTIONS = 'Choose whether the bring order walks to exposed ore or digs a buried block'
const SOURCE_CRITERIA = {
  walk_exposed: 'exposed ore is worth the walk: reliable, no shaft to dig',
  dig_buried: 'digging the buried block is faster than the long walk',
}

async function chooseBringSource(brain, text, exposed, buried, o) {
  const fsm = 'walk_exposed'
  const d = decideBringSource(exposed, buried)
  if (!d.contested) {
    const action = d.pick === 'buried' ? 'dig_buried' : 'walk_exposed'
    return { action, source: d.why === 'only-option' ? 'only-option' : 'clear-winner', fsm, model: null }
  }
  if (o && o.sourceAsked && (o.sourcePick === 'walk_exposed' || o.sourcePick === 'dig_buried')) {
    return { action: o.sourcePick, source: 'cached', fsm, model: null }
  }
  if (!brain || typeof brain.ask !== 'function') return { action: fsm, source: 'fsm', fsm, model: null }
  const model = brain.source || brain.name || 'model'
  const criteria = { walk_exposed: SOURCE_CRITERIA.walk_exposed, dig_buried: SOURCE_CRITERIA.dig_buried }
  const fail = (reason) => {
    metrics.escalation.inc({ from: model, to: 'fsm', reason })
    if (o) { o.sourceAsked = true; o.sourcePick = fsm }
    return { action: fsm, source: 'fsm-fallback', fsm, model }
  }
  try {
    const label = await brain.ask({ state: text, instructions: SOURCE_INSTRUCTIONS, criteria, situation: text })
    if (label !== fsm) {
      console.error(`brain disagree source=${model} model=${label} fsm=${fsm} reason=bring-source facts=${text}`)
    }
    if (label !== 'walk_exposed' && label !== 'dig_buried') return fail('invalid')
    if (o) { o.sourceAsked = true; o.sourcePick = label }
    return { action: label, source: model, fsm, model }
  } catch (err) {
    const msg = String((err && err.message) || err)
    const reason = (err && err.name === 'TimeoutError') ? 'timeout'
      : msg.startsWith('jev missing') ? 'invalid'
      : 'error'
    return fail(reason)
  }
}

// Cached far verdict (revmux 01 body-3): without it every dug unit re-runs
// the full sliced shells while the bot stands still. Valid while the bot
// is still near the cache origin with the same loaded edge (the same
// invalidation stepFarSearch itself uses); each half is re-verified live
// and re-costed from the live position. Returns { far, buried } (either
// may be null), or undefined when there is no usable cache — a half that
// was cached but no longer verifies rescans instead of silently dropping
// (revmux 02) — except on the buried-48 path, which never consumes the
// buried half (it verdicts against its fresh stash): a dug buried half
// must not rescan the exposed half it still needs (revmux 03 body-1).
// Search legs drop the cache on completion: legs relocate
// for fresh coverage, so they always rescan.
function takeFarCache(bot, o, bp) {
  try {
    const c = o && o.farCache
    if (!c || typeof c.x !== 'number') return undefined
    if (Math.hypot(bp.x - c.x, bp.y - c.y, bp.z - c.z) > 48) return undefined
    if (loadedSearchRadius(bot) !== c.edge) return undefined
    const skipped = (pos) => o.skip && typeof o.skip.has === 'function' && o.skip.has(skipKey(pos))
    let far = null
    if (c.hit && !skipped(c.hit.pos)) {
      let now = false
      try {
        now = resources.exposedOf(bot, {
          x: c.hit.pos.x, y: c.hit.pos.y, z: c.hit.pos.z, name: c.hit.name, exposed: true,
        })
      } catch (_) { now = false }
      if (now === true) {
        const p = c.hit.pos
        far = liveExposed(bp, {
          name: c.hit.name, position: p,
          distance: Math.hypot(p.x - bp.x, p.y - bp.y, p.z - bp.z), exposed: true,
        })
      }
    }
    let buried = null
    if (c.buriedHit && !skipped(c.buriedHit.pos)) {
      let there = false
      try {
        const blk = bot.blockAt && bot.blockAt({
          x: Math.floor(c.buriedHit.pos.x), y: Math.floor(c.buriedHit.pos.y), z: Math.floor(c.buriedHit.pos.z),
        })
        there = !blk || (!!blk.name && blk.name === c.buriedHit.name)
      } catch (_) { there = false }
      if (there) {
        const p = c.buriedHit.pos
        buried = buriedCand(bp, {
          name: c.buriedHit.name, position: p,
          distance: Math.hypot(p.x - bp.x, p.y - bp.y, p.z - bp.z), exposed: false,
        })
      }
    }
    if ((c.hit && !far) || (c.buriedHit && !buried && !(o && o.buried))) return undefined
    return { far, buried }
  } catch (_) { return undefined }
}

// Full verdict for the find and searchfar phases: sync-commit when
// uncontested (no suspension, so a sync driver re-entering the tick sees
// the commit), one model ask when contested. Callers guarantee at least
// one candidate. Returns false when a mid-ask retire cleared the order.
async function verdictSource(bot, ctx, o, exposed, buried) {
  const d = decideBringSource(exposed, buried)
  if (!d.contested) {
    commitSource(bot, ctx, o, exposed, buried, d.pick)
    return true
  }
  const c = await chooseBringSource(ctx && ctx.brain, sourceText(o, exposed, buried), exposed, buried, o)
  if (!ctx || ctx.bring !== o) return false // stop or a new order landed mid-ask: touch nothing
  commitSource(bot, ctx, o, exposed, buried, c.action === 'dig_buried' ? 'buried' : 'exposed')
  return true
}

// The choice, announced (orch default): a bare legacy line when the pick
// was uncontested, a suffix naming the source when a rival was feasible.
function goingForLine(want, res) {
  if (res.choice === 'digging' && typeof res.downBlocks === 'number' && res.downBlocks > 0) {
    return `going for ${want} ${res.name}, ${res.downBlocks} blocks down (digging)`
  }
  const base = `going for ${want} ${res.name}, ${res.distance} blocks away`
  if (res.choice === 'exposed') return `${base} (exposed)`
  if (res.choice === 'digging') return `${base} (digging)`
  return base
}

// Verdict positions must be real Vec3 for the walk/dig reads: real
// mineflayer blockAt throws on a plain object (WorldSync.getBlock calls
// pos.floored()), which reads as an unloaded chunk and stalls a memory
// hike into 'could not reach' at the vein (idkcraft-t9k). Every bring
// verdict routes through here, so normalize once; live hits pass through.
function asVec3(p) {
  if (!p || typeof p.floored === 'function') return p
  return new Vec3(p.x, p.y, p.z)
}

// Announcement shape shared by the find verdict and order creation:
// the winning candidate as a scout-like result, plus the choice suffix
// (iff a rival was feasible) and the far flag for memory targets.
function choiceRes(win, rival, bp) {
  const res = { name: win.name, position: asVec3(win.pos), distance: Math.round(win.dist), exposed: win.kind !== 'buried' }
  if (rival) {
    if (win.kind === 'buried') {
      res.choice = 'digging'
      const down = bp ? Math.round(Math.floor(bp.y) - Math.floor(win.pos.y)) : 0
      const horiz = bp ? Math.hypot(win.pos.x - bp.x, win.pos.z - bp.z) : Infinity
      if (down > 0 && horiz < 3) res.downBlocks = down
    } else {
      res.choice = 'exposed'
    }
  }
  if (win.kind === 'memory') res.far = true
  return res
}

// Shared commit for the find and searchfar verdicts (and order creation,
// via the same res shape): plants the target, checks the pickaxe tier,
// announces once. A memory target rides o.far — unloaded is not gone
// (gather's far rule). Returns false when the tier refuses.
function commitSource(bot, ctx, o, exposed, buried, pick) {
  const win = pick === 'buried' ? buried : exposed
  const rival = pick === 'buried' ? exposed : buried
  const bp = bot.entity && bot.entity.position
  const res = choiceRes(win, rival, bp)
  o.pos = res.position
  o.block = res.name
  o.exposed = res.exposed !== false
  // Unloaded is not gone (gather's far rule): memory targets always ride
  // it, and so does a cached live hit whose chunk unloaded since the scan
  // — otherwise walk re-finds every tick with no stall exit (revmux 02).
  let readable = true
  try { readable = !!(bot.blockAt && bot.blockAt(win.pos)) } catch (_) { readable = false }
  o.far = win.kind === 'memory' || !readable
  o.drop = dropFor(res.name)
  if (needsPickaxe(res.name) && !hasPickaxe(bot, res.name)) {
    const tier = requiredTier(res.name)
    refuse(bot, ctx, `need ${tierArticle(tier)} ${tier} pickaxe for ${res.name}`)
    return false
  }
  if (!o.announced) {
    o.announced = true
    say(bot, goingForLine(o.want, res))
  }
  o.phase = 'walk'
  o.stalls = 0
  o.lastPos = null
  return true
}

// Honest end of a spent search: the legs walked, then what was found.
function refuseExhausted(bot, ctx, o) {
  const n = o.searchLegs ? o.searchLegs.legs : 0
  const kind = o.kind || 'block'
  const woolNone = o.color ? `no ${o.color} sheep` : 'no sheep'
  const base = o.have > 0 ? `only got ${o.have} ${o.drop}` : (kind === 'food' ? 'no animals' : kind === 'wool' ? woolNone : `no ${o.name}`)
  // A wool hunt that gathered something still hands it over instead of
  // refusing with a full pack (the short-pack rung promised a top-up, and
  // the legs proved none is coming). A sub-order (did.4) never hands over:
  // the gap is still open, so the whole order refuses and the stock stays
  // in the pack for the owner's retry.
  if (kind === 'wool' && o.have > 0 && o.drop && !o.subFor) {
    say(bot, `searched ${n} areas, ${base}`)
    o.phase = 'return'
    o.saidWaiting = false
    return
  }
  refuse(bot, ctx, `searched ${n} areas, ${base}`)
}

// Drop a cancelled mid-leg explore pursuit (stop/follow/work/lead): the
// visited memory stays (shared exploration), the stale target must not leak
// into the next owner's walk.
function clearSearchLeg(ctx) {
  try {
    if (ctx && ctx.explore && typeof ctx.explore === 'object') {
      ctx.explore.target = null
      ctx.explore.issuedKey = null
    }
  } catch (_) { /* cleanup best-effort */ }
}

// atl.8: an empty find opens search legs instead of refusing. Async: the
// per-leg model choice awaits ask(); the tick (index.js) awaits bring.
// legacy is today's refusal line, kept for anchorless worlds (no spiral
// without home or spawn — production always has spawn).
// Anchor probe for order creation (index.js setBring): legs need a spiral.
function canSearch(bot, ctx) {
  try {
    return !!exploreMod.anchorOf(bot, ctx)
  } catch (_) {
    return false
  }
}

// Bringability gate for leg orders opened without a candidate in hand
// (setBring / pending-search completion): the find-hit path assumes creation
// checked isBringable, and an unbringable target would mine forever.
function canBringName(bot, name) {
  try {
    const ids = resolveFindIds(bot, name)
    if (!Array.isArray(ids) || ids.length === 0) return false
    const byName = (bot.registry && bot.registry.blocksByName) || {}
    const byId = {}
    for (const [n, e] of Object.entries(byName)) {
      if (e && typeof e.id === 'number' && !(e.id in byId)) byId[e.id] = n
    }
    return ids.some((id) => isBringable(byId[id] || ''))
  } catch (_) {
    return false
  }
}

async function enterSearch(bot, ctx, o, legacy) {
  const s = o.searchLegs || (o.searchLegs = { legs: 0, startedAt: Date.now(), announced: false, last: 'empty' })
  if (!exploreMod.anchorOf(bot, ctx)) {
    if ((o.kind || 'block') === 'wool' && o.have > 0 && o.drop && !o.subFor) {
      say(bot, legacy) // anchorless with stock: hand it over, like the legs path
      o.phase = 'return'
      o.saidWaiting = false
      return
    }
    refuse(bot, ctx, legacy)
    return
  }
  // A time-expired search is exhausted even with legs left (revmux
  // 01-review): self wool hunts must fail, never reopen 3 more searches.
  if (Date.now() - s.startedAt >= searchMinutes() * 60 * 1000) s.timedOut = true
  if (s.legs >= searchLegs() || s.timedOut) {
    refuseExhausted(bot, ctx, o)
    return
  }
  const text = searchText(o, s)
  const c = await chooseBringSearch(ctx && ctx.brain, text, searchLegs() - s.legs)
  if (!ctx || ctx.bring !== o) return // stop or a new order landed mid-ask: touch nothing
  if (c.action !== 'search_more') {
    refuseExhausted(bot, ctx, o)
    return
  }
  if (!s.announced) {
    s.announced = true
    const kind = o.kind || 'block'
    say(bot, kind === 'food' ? 'no animals nearby, searching…'
      : kind === 'wool' ? (o.color ? `no ${o.color} sheep nearby, searching…` : 'no sheep nearby, searching…')
      : `no ${o.name} nearby, searching…`)
  }
  o.phase = 'searchwalk'
  ctx.stepStatus = 'running'
}

// One search leg: drive the explore primitive, count the finished leg
// (arrival or failure) and re-find. The status sentinel keeps a stale
// recover done from ever reading as an arrival.
function walkSearch(bot, ctx, o) {
  const hadTarget = !!(ctx.explore && ctx.explore.target)
  ctx.stepStatus = 'running'
  try {
    exploreMod(bot, ctx, null, {})
  } catch (_) {
    ctx.stepStatus = 'failed:bring-search'
  }
  const st = ctx.stepStatus
  if (st === 'done' && !hadTarget && !(ctx.explore && ctx.explore.target)) {
    // Spiral exhausted (no leg was or is in progress): no new ground
    // exists, so no further leg could walk either — end honestly now
    // instead of burning K instant legs.
    ctx.stepStatus = null
    refuseExhausted(bot, ctx, o)
    return
  }
  if (st === 'done' || (typeof st === 'string' && st.indexOf('failed') === 0)) {
    ctx.stepStatus = null
    if (o.searchLegs) {
      o.searchLegs.legs += 1
      o.searchLegs.last = st === 'done' ? 'empty' : 'failed'
    }
    o.farCache = null // a leg relocates for fresh coverage: the next find rescans (revmux 02)
    o.phase = 'find'
  }
}

// Shared n7k prey find (food + did.3 wool): wool narrows to unsheared
// sheep — to the requested color when one was ordered, else any sheep
// (bare families never narrow: the toss color is picked at pickup).
async function findFood(bot, ctx, o) {
  const wool = (o.kind || 'block') === 'wool'
  const color = wool ? (o.color || null) : null
  const skip = wool ? preySkipIds(o) : (o.unreachIds && o.unreachIds.size ? o.unreachIds : null)
  let res = wool
    ? findAnimal(bot, null, { prey: ['sheep'], skipSheared: true, color, skipIds: skip, skipColors: o.deadColors })
    : findAnimal(bot, o.drop || null, skip ? { skipIds: skip } : undefined)
  if (!res && wool && o.lockColor && o.color) {
    // The provisional lock stranded (did.4 rig: one light_gray in a brown
    // flock) — but only release onto sheep actually present (revmux 03
    // core-1): with none in range at all the flock stands a leg away, so
    // the lock stays and the legs relocate. Releasing there would burn
    // the pack colour for the whole order.
    const any = findAnimal(bot, null, { prey: ['sheep'], skipSheared: true, color: null, skipIds: skip, skipColors: o.deadColors })
    if (any) {
      if (!o.deadColors) o.deadColors = new Set()
      o.deadColors.add(o.color)
      say(bot, `no more ${o.color} sheep, trying another colour`)
      o.color = null
      o.drop = null
      o.have = 0
      res = any
    }
  }
  if (!res && o.animal) {
    // A stalled chase re-found nothing (8gc): the order ends on the
    // chase it could not finish. Only the stall path reaches find with
    // o.animal still set — every other re-find nulls it first.
    refuse(bot, ctx, `could not reach ${o.animal.name}`)
    return
  }
  if (!res) {
    // Legs move areas (revmux 03 core-1): dead colours are a per-area
    // hint — the new ground may hold the stranded colour, so it hunts
    // again there instead of dooming the legs that walk past it.
    if (wool && o.lockColor) o.deadColors = null
    const woolLegacy = o.have > 0 ? `only got ${o.have} ${o.drop}` : (color ? `no ${color} sheep within 48 blocks` : 'no sheep within 48 blocks')
    await enterSearch(bot, ctx, o, wool ? woolLegacy : (o.have > 0 ? `only got ${o.have} ${o.drop}` : 'no animals within 48 blocks'))
    return
  }
  o.animal = { name: res.name, id: res.id }
  o.pos = res.position
  if (!wool) o.drop = PREY_DROPS[res.name]
  o.lastPos = { x: res.position.x, y: res.position.y, z: res.position.z }
  fenceFact(bot, res)
  if (!o.announced) {
    o.announced = true
    say(bot, wool
      ? `going for wool: sheep ${res.distance} blocks away (${woolMod.hasShears(bot) ? 'shears' : 'no shears, hunting'})`
      : `going hunting: ${res.name} ${res.distance} blocks away`)
  }
  o.phase = 'walk'
  o.stalls = 0
  o.armedId = null
}

function walkFood(bot, ctx, o, bp, grounded) {
  const ent = o.animal ? entityById(bot, o.animal.id) : null
  if (!ent) { o.animal = null; o.phase = 'find'; return }
  o.pos = ent.position
  o.lastPos = { x: ent.position.x, y: ent.position.y, z: ent.position.z }
  const key = `bring-hunt:${Math.round(ent.position.x)},${Math.round(ent.position.y)},${Math.round(ent.position.z)}`
  const d = animalDist(bp, ent.position)
  if (d !== null && d <= fightMod.SWING_RANGE) { o.phase = 'kill'; return }
  if (key !== ctx.lastGoalKey) {
    bot.pathfinder.setGoal(new goals.GoalNear(ent.position.x, ent.position.y, ent.position.z, 2), false)
    ctx.lastGoalKey = key
  }
  // Stall accounting runs every tick, not just on a settled key: a
  // moving-but-unreachable animal (pen, water) re-keys constantly, and only
  // the bot's own displacement clears the counter — otherwise the body is
  // held forever, one block per tick.
  if (progressed(bp, o.lastBotPos, grounded)) {
    o.stalls = 0
    o.lastBotPos = { x: bp.x, y: bp.y, z: bp.z }
  } else if (++o.stalls >= WALK_STALL_TICKS) {
    // The chase cannot close (pen, water, Y-gap under a satisfied goal):
    // strike this animal and re-find while candidates remain (8gc) —
    // refusing with sheep nearby ended the did.4 rig run. The animal
    // stays on o (not nulled) so an empty re-find refuses with the
    // chase it could not finish, not an empty-field line.
    if (!o.unreachIds) o.unreachIds = new Set()
    if (o.animal) o.unreachIds.add(o.animal.id)
    o.stalls = 0
    o.lastBotPos = null
    o.phase = 'find'
  }
}

function killFood(bot, ctx, o, bp) {
  const ent = o.animal ? entityById(bot, o.animal.id) : null
  if (!ent) { // dead or gone: collect whatever dropped at the last spot
    o.dropPos = o.lastPos
    o.phase = 'pickup'
    return
  }
  o.lastPos = { x: ent.position.x, y: ent.position.y, z: ent.position.z }
  const d = animalDist(bp, ent.position)
  if (d === null || d > fightMod.SWING_RANGE) { o.phase = 'walk'; return }
  // Wool with shears in hand shears instead of killing (owner rule): one
  // equip + useOn, then collect — the sheep lives and is skipped next
  // time (o.shearedIds + the sheared metadata flag). No shears, or an
  // unequippable mock bot, falls through to the swing below.
  if ((o.kind || 'block') === 'wool') {
    const sh = woolMod.shearsInPack(bot)
    if (sh && typeof bot.equip === 'function' && typeof bot.useOn === 'function') {
      if (o.shearInFlight) return // exactly one window op at a time (dig rule)
      o.shearInFlight = true
      void (async () => {
        try {
          await bot.equip(sh, 'hand')
          if (!ctx || ctx.bring !== o) return // stop or a new order landed mid-equip
          const still = o.animal ? entityById(bot, o.animal.id) : null
          if (still) {
            try { bot.lookAt(still.position.offset(0, still.height * 0.8, 0), true) } catch (_) { /* aim best-effort */ }
            try { bot.useOn(still) } catch (_) { /* server decides */ }
            if (!o.shearedIds) o.shearedIds = new Set()
            o.shearedIds.add(still.id)
          }
          o.dropPos = o.lastPos
          o.phase = 'pickup'
        } catch (_) { /* equip failed: retry next tick (or swing when the shears are gone) */ } finally {
          o.shearInFlight = false
        }
      })()
      return
    }
  }
  if (o.armedId !== ent.id) {
    o.armedId = ent.id
    try { fightMod.equipGear(bot) } catch (_) { /* fists are fine */ }
  }
  try { fightMod.swing(bot, ent) } catch (_) { /* mock bots may lack lookAt/attack */ }
}

function pickupFood(bot, ctx, o, bp, grounded) {
  const dp = o.dropPos
  if (!dp) { o.animal = null; o.phase = 'find'; return }
  const key = `bring-food-pickup:${Math.round(dp.x)},${Math.round(dp.y)},${Math.round(dp.z)}`
  if (key !== ctx.lastGoalKey) {
    // GoalBlock, not GoalNear (8gc): Near(1) stops satisfied at the node
    // boundary, up to ~2 from the drops, and the old d<=2 gate then
    // counted a pack the bot never walked onto — wool stayed behind.
    bot.pathfinder.setGoal(new goals.GoalBlock(dp.x, dp.y, dp.z), false)
    ctx.lastGoalKey = key
    o.stalls = 0
    o.lastBotPos = { x: bp.x, y: bp.y, z: bp.z }
    return
  }
  if (!sameCell(bp, dp)) {
    if (progressed(bp, o.lastBotPos, grounded)) {
      o.stalls = 0
      o.lastBotPos = { x: bp.x, y: bp.y, z: bp.z }
    } else if (++o.stalls >= WALK_STALL_TICKS) {
      refuse(bot, ctx, `could not pick up ${o.drop}`)
    }
    return
  }
  // Walked over the drops: the inventory count is the truth. Wool with
  // no ordered color tosses the best color in the pack (re-derived each
  // pickup, so a gray first sheep never locks out white ones later). A bed
  // sub-order (did.4) locks the first pickup instead: the bed needs three
  // of one colour, so the hunt narrows from here on. After a lock release
  // the argmax hides stranded colours, so the re-lock lands live.
  if ((o.kind || 'block') === 'wool' && !o.color) {
    const t = woolMod.topWoolColor(bot, o.deadColors)
    if (t) o.drop = t.name
  }
  if (o.lockColor && !o.color && o.drop) o.color = woolMod.dropColor(o.drop)
  o.have = countDrop(bot, o.drop)
  if (o.have >= o.want) {
    if (o.subFor) {
      itemMod.resumeSub(bot, ctx, o)
      return
    }
    o.phase = 'return'
    o.saidWaiting = false
  } else {
    o.animal = null
    o.phase = 'find'
  }
}

// Wool orders (idkcraft-did.3) ride the shared n7k prey phases above —
// find, walk, kill (shear when shears are held, else swing), pickup —
// plus the same search legs. Only the return leg falls through to the
// shared single-drop toss in bring(). The morphs and rungs (toWoolHunt,
// refuseItemOrHunt, enterCraftOrRefuse, craftTick) live in bringitem.js.
async function gatherWool(bot, ctx, o, bp, grounded) {
  if (o.phase === 'searchwalk') { walkSearch(bot, ctx, o); return }
  if (o.phase === 'find') { await findFood(bot, ctx, o); return }
  if (o.phase === 'walk') { walkFood(bot, ctx, o, bp, grounded); return }
  if (o.phase === 'kill') { killFood(bot, ctx, o, bp); return }
  if (o.phase === 'pickup') { pickupFood(bot, ctx, o, bp, grounded); return }
}

// Fetch-first from the home chest (atl.14 phase 2): an order that opens
// with no world hit checks the adopted chest before the far shells and
// search legs. One attempt per order (o.chestTried); anything short falls
// back to find and digs the rest. Orders that open with a world hit in
// hand (startBlockOrder) dig directly — no chest detour, no regression.
function openPhase(ctx) {
  try {
    if (ctx && ctx.home && ctx.home.chest) return 'chestfetch'
  } catch (_) { /* no chest: find */ }
  return 'find'
}

// Day gate for self orders (goalFacts mirror): day is timeOfDay < 12000,
// unknown reads as day (never cancel on an unreadable clock).
function isDaytime(bot) {
  try {
    const t = bot && bot.time && typeof bot.time.timeOfDay === 'number' ? bot.time.timeOfDay : NaN
    return !(t >= 0) ? true : t < 12000
  } catch (_) {
    return true
  }
}

function chestFetch(bot, ctx, o, bp) {
  const c = ctx && ctx.home && ctx.home.chest
  const food = (o.kind || 'block') === 'food'
  const item = (o.kind || 'block') === 'item'
  if (!c) {
    o.chestTried = true
    if (item) { // adopted chest lost mid-order: wool hunts, the rest refuses
      itemMod.refuseItemOrHunt(bot, ctx, o)
      return
    }
    o.phase = 'find'
    return
  }
  // Orders that open with no world hit carry no drop yet: derive it from
  // the requested name (ores/logs: dropFor covers request and block names).
  if (!food && !item && !o.drop && o.name) {
    try { o.drop = dropFor(o.name) } catch (_) { o.drop = null }
  }
  // Inventory first: no walk, no window when the pack already holds it.
  if (item) {
    const plan = itemMod.planItemGive(bot, { names: o.names || [] }, o.want)
    if (plan.have > 0) {
      o.items = plan.items
      o.drop = plan.items[0].name
      o.have = plan.have
    }
    if (plan.have >= o.want) {
      o.phase = 'return'
      o.saidWaiting = false
      return
    }
  } else if (o.drop) {
    o.have = countDrop(bot, o.drop)
    if (o.have >= o.want) {
      o.phase = 'return'
      o.saidWaiting = false
      return
    }
  }
  const key = `bring-chest:${c.x},${c.y},${c.z}`
  if (key !== ctx.lastGoalKey) {
    try {
      bot.pathfinder.setGoal(new goals.GoalNear(c.x, c.y, c.z, 2), false)
    } catch (_) { /* retry next tick */ }
    ctx.lastGoalKey = key
    o.chestStalls = 0
    if (!o.announced) {
      o.announced = true
      const what = food && !o.drop ? 'food' : (item ? o.name : (o.drop || o.name))
      say(bot, `checking the home chest for ${what}`)
    }
    return
  }
  let moving = false
  try { moving = bot.pathfinder.isMoving() } catch (_) { /* treat as arrived */ }
  if (moving) { o.chestStalls = 0; return }
  // No path reads as !moving too: after CHEST_STALL_TICKS far+standing
  // ticks fall back to find instead of eating the 20 s windowOpen timeout
  // on an out-of-range open. One far tick never falls back: the pathfinder
  // often recovers on the next tick (live assay: place_error, then walk).
  let near = false
  try {
    near = bp && typeof bp.x === 'number' && Math.hypot(bp.x - c.x, bp.y - c.y, bp.z - c.z) <= 4
  } catch (_) { near = false }
  if (!near) {
    o.chestStalls = (o.chestStalls || 0) + 1
    if (o.chestStalls >= CHEST_STALL_TICKS) {
      o.chestTried = true
      o.phase = 'find'
    }
    return
  }
  o.chestStalls = 0
  if (o.chestInFlight) return // exactly one window op at a time (dig rule)
  o.chestInFlight = true
  void (async () => {
    try {
      if (item) {
        await itemMod.fetchItem(bot, ctx, o)
        return
      }
      const need = Math.max(o.want - o.have, 0)
      const res = food && !o.drop
        ? await stockpileMod.withdrawEdible(bot, ctx, need)
        : await stockpileMod.withdrawFromChest(bot, ctx, o.drop, need)
      o.chestInFlight = false
      o.chestTried = true
      ctx.chestFull = false // a fetch may have made room: re-arm the step
      if (food && !o.drop && res && res.name) o.drop = res.name
      o.have = o.drop ? countDrop(bot, o.drop) : 0 // inventory count is the truth
      if (o.have >= o.want) {
        o.phase = 'return'
        o.saidWaiting = false
      } else {
        o.phase = 'find' // short or empty: dig the rest
      }
    } catch (_) {
      o.chestInFlight = false
      o.chestTried = true
      if (item) {
        if (!ctx || ctx.bring !== o) return
        itemMod.refuseItemOrHunt(bot, ctx, o)
      } else o.phase = 'find'
    }
  })()
}

// The item chest fetch (fetchItem) lives in bringitem.js (did.4 split).

async function bring(bot, ctx, target, state) {
  const o = ctx.bring
  if (!o) return
  // Self orders (jr2.2 bed wool) end at dusk: the night belongs to gohome/
  // stay, and the dispatch runs bring over every goal step but fight, so an
  // uncancelled hunt would own the body past dark. Silent — gohome announces
  // — and the owning step reopens in the morning (a short cancelled hunt
  // reads as reopen, not failure, there).
  if (o.self && !isDaytime(bot)) {
    metrics.bring.inc({ outcome: 'cancelled', kind: (o.kind || 'block') })
    ctx.bring = null
    clearSearchLeg(ctx)
    return
  }
  const bp = bot.entity && bot.entity.position
  if (!bp) return
  const grounded = !bot.entity || bot.entity.onGround !== false
  const food = (o.kind || 'block') === 'food'

  // Wool hunts through the shared prey phases; 'return' falls through to
  // the shared single-drop toss below (o.drop is concrete by then).
  if ((o.kind || 'block') === 'wool' && o.phase !== 'return') {
    await gatherWool(bot, ctx, o, bp, grounded)
    return
  }

  if (o.phase === 'searchwalk') { walkSearch(bot, ctx, o); return }

  if (o.phase === 'chestfetch') { chestFetch(bot, ctx, o, bp); return }

  if (o.phase === 'craft') { itemMod.craftTick(bot, ctx, o); return }

  if (o.phase === 'find') {
    if (food) { await findFood(bot, ctx, o); return }
    if ((o.kind || 'block') === 'item') { // no diggable world form: wool hunts, else the item reason
      itemMod.refuseItemOrHunt(bot, ctx, o)
      return
    }
    if (o.searchSkipFar) { // pending far search just came up empty: skip the re-scan
      o.searchSkipFar = false
      await enterSearch(bot, ctx, o, `no ${o.name} within ${loadedSearchRadius(bot)} blocks (loaded area)`)
      return
    }
    // idkcraft-drq: pre-check the guard at find time, so a nearer build
    // is skipped without walking to each of its blocks first. Only
    // 'protected' counts here: trap rules depend on the dig-time stance
    // and are judged at the dig site. Each loop either commits or grows
    // o.skip, and find empties when all is skipped — it terminates.
    let res = null
    for (;;) {
      res = findNearest(bot, o.name, null, o.skip ? ((q) => o.skip.has(skipKey(q))) : null)
      if (res === 'unknown' || !res || !res.position) break
      let pre = null
      try {
        const blk = bot.blockAt && bot.blockAt(res.position)
        pre = blk && denyReason(bot, blk, ctx)
      } catch (_) { pre = null }
      if (pre !== 'protected') break
      logDeny({ name: res.name, position: res.position }, pre)
      if (!o.skip) o.skip = new Set()
      o.skip.add(skipKey(res.position))
      res = null
    }
    if (res === 'unknown') {
      refuse(bot, ctx, `unknown block: ${o.name}`)
      return
    }
    if (!res) {
      // Sync 48 is empty: memory may still know exposed ore (b) and the
      // far shells may see some live (a). Stash both for the verdict —
      // the buried candidate (c) is empty on this path.
      o.buried = null
      let mem = null
      try { mem = memoryExposed(bot, ctx, bp, o.name, o.skip) } catch (_) { mem = null }
      o.memKnown = mem
      if (!food && !o.chestTried && o.have < o.want && ctx && ctx.home && ctx.home.chest) {
        o.phase = 'chestfetch'
        return
      }
      if (o.have > 0) {
        await enterSearch(bot, ctx, o, `only got ${o.have} ${o.drop}`)
        return
      }
      // A cached far verdict skips the rescan (body-3); without one the
      // 96/160 shells run sliced across ticks (amb), one order holding
      // one cursor, no new scan starting while it runs.
      const cachedEmpty = takeFarCache(bot, o, bp)
      if (cachedEmpty !== undefined) {
        const exposedEmpty = bestExposed(cachedEmpty.far, o.memKnown || null)
        if (!exposedEmpty && !cachedEmpty.buried) {
          await enterSearch(bot, ctx, o, `no ${o.name} within ${loadedSearchRadius(bot)} blocks (loaded area)`)
          return
        }
        await verdictSource(bot, ctx, o, exposedEmpty, cachedEmpty.buried)
        return
      }
      o.search = startFarSearch(bot, o.name)
      if (o.search === 'unknown') {
        refuse(bot, ctx, `unknown block: ${o.name}`)
        return
      }
      if (!o.search) {
        // No wider shell to scan (edge 48): a remembered spot still beats
        // walking legs, otherwise legs walk new ground as before.
        if (o.memKnown) {
          commitSource(bot, ctx, o, o.memKnown, null, 'exposed')
          return
        }
        await enterSearch(bot, ctx, o, `no ${o.name} within ${loadedSearchRadius(bot)} blocks (loaded area)`)
        return
      }
      o.phase = 'searchfar'
      return
    }
    if (res.exposed !== false) {
      // Exposed and nearest: commit exactly as before (no rival consulted,
      // the legacy line byte-identical).
      commitSource(bot, ctx, o, liveExposed(bp, res), null, 'exposed')
      return
    }
    // 48-best buried: stash it as the dig candidate (c), read the memory
    // candidate (b), and run the far shells for live exposed ore (a) —
    // buried-only-48 counts as empty for the exposed search (atl.15).
    o.buried = buriedCand(bp, res)
    {
      let mem = null
      try { mem = memoryExposed(bot, ctx, bp, o.name, o.skip) } catch (_) { mem = null }
      o.memKnown = memoryInBudget(mem, o.buried)
    }
    // A cached far verdict skips the rescan (body-3): the buried stash
    // and memory above are always re-derived fresh and cheap.
    const cachedBuried = takeFarCache(bot, o, bp)
    if (cachedBuried !== undefined) {
      await verdictSource(bot, ctx, o, bestExposed(cachedBuried.far, o.memKnown || null), o.buried)
      return
    }
    o.search = startFarSearch(bot, o.name)
    if (o.search === 'unknown') {
      refuse(bot, ctx, `unknown block: ${o.name}`)
      return
    }
    if (!o.search) {
      // Edge 48, no shells: decide between memory and buried now, asking
      // the model once when contested (the tick awaits bring).
      await verdictSource(bot, ctx, o, o.memKnown, o.buried)
      return
    }
    o.phase = 'searchfar'
    return
  }

  if (o.phase === 'searchfar') {
    if (food) { await findFood(bot, ctx, o); return }
    if (!o.search) return // verdict already committed or asking: wait for it
    const r = stepFarSearch(bot, o.search, o.skip ? { exclude: (q) => o.skip.has(skipKey(q)) } : undefined)
    if (!r.done) return
    o.search = null
    if (r.result === 'unknown') {
      refuse(bot, ctx, `unknown block: ${o.name}`)
      return
    }
    // Shells done: (a) live exposed wins the far result, a buried far hit
    // loses to the nearer stashed 48 hit — or stands alone when 48 was
    // empty. The verdict weighs it against the stashed memory (b).
    const far = r.result && r.result.exposed !== false ? liveExposed(bp, r.result) : null
    const buried = o.buried || (r.result && r.result.exposed === false ? buriedCand(bp, r.result) : null)
    const exposed = bestExposed(far, o.memKnown || null)
    const edge = (r && typeof r.edge === 'number') ? r.edge : loadedSearchRadius(bot)
    try {
      o.farCache = {
        x: bp.x, y: bp.y, z: bp.z, edge, hit: far,
        buriedHit: r.result && r.result.exposed === false ? buriedCand(bp, r.result) : null,
      }
    } catch (_) { /* cache best-effort */ }
    if (!exposed && !buried) {
      await enterSearch(bot, ctx, o, o.have > 0 ? `only got ${o.have} ${o.drop}` : `no ${o.name} within ${edge} blocks (loaded area)`)
      return
    }
    await verdictSource(bot, ctx, o, exposed, buried)
    return
  }

  if (o.phase === 'walk') {
    if (food) { walkFood(bot, ctx, o, bp, grounded); return }
    const key = `bring:${o.pos.x},${o.pos.y},${o.pos.z}`
    if (key !== ctx.lastGoalKey) {
      bot.pathfinder.setGoal(new goals.GoalNear(o.pos.x, o.pos.y, o.pos.z, 2), false)
      ctx.lastGoalKey = key
      o.stalls = 0
      o.lastPos = { x: bp.x, y: bp.y, z: bp.z }
      return
    }
    let block = null
    try { block = bot.blockAt && bot.blockAt(o.pos) } catch (_) { block = null }
    // Unloaded is not gone for a memory target (gather's far rule): its
    // chunk streams in as the bot closes in, with stall counting below as
    // the backstop. Only a loaded mismatch re-finds.
    const unloadedFar = !block && o.far && o.pos
    if (!unloadedFar && (!block || !block.name || block.name !== o.block)) {
      o.pos = null // mined by someone else: search again
      o.phase = 'find'
      return
    }
    if (!bot.pathfinder.isMoving()) {
      let diggable = true
      try { diggable = typeof bot.canDigBlock === 'function' ? bot.canDigBlock(block) : true } catch (_) { diggable = false }
      if (diggable) o.phase = 'dig'
    }
    if (o.phase === 'walk') {
      if (progressed(bp, o.lastPos, grounded)) {
        o.stalls = 0
        o.lastPos = { x: bp.x, y: bp.y, z: bp.z }
      } else if (++o.stalls >= WALK_STALL_TICKS) {
        refuse(bot, ctx, `could not reach ${o.block}` + (o.exposed === false ? ' (buried, no path in)' : ''))
      }
      return
    }
  }

  if (o.phase === 'dig') {
    // Exactly one dig at a time: while it is in flight, wait (gather.js rule).
    if (ctx.digInFlight) return
    if (typeof bot.dig !== 'function') {
      refuse(bot, ctx, `could not break ${o.block}`)
      return
    }
    let block = null
    try { block = bot.blockAt && bot.blockAt(o.pos) } catch (_) { block = null }
    if (!block || block.name !== o.block) {
      o.pos = null // vanished mid-order: search again
      o.phase = 'find'
      return
    }
    const bDeny = denyReason(bot, block, ctx) // idkcraft-drq: never fetch through owner builds
    if (bDeny) {
      logDeny(block, bDeny)
      if (bDeny === 'protected') {
        // Skip it and take the next candidate: a nearer build must not
        // end an order while terrain blocks exist further away. Refusal
        // happens when find comes up empty (the have>0 path delivers).
        if (!o.skip) o.skip = new Set()
        o.skip.add(skipKey(o.pos))
        o.pos = null
        o.phase = 'find'
        return
      }
      // Trap denial (below-feet/gravity): the stance may change, so look
      // again — but a capped number of times, or find re-picks the same
      // nearest block forever (walk flips straight back to dig). Never
      // skipped: a trap is a property of the stance, not the block.
      o.denyStrikes = (o.denyStrikes || 0) + 1
      if (o.denyStrikes > 3) {
        refuse(bot, ctx, o.have > 0
          ? `only got ${o.have} ${o.drop} \u2014 could not reach ${o.block} safely`
          : `could not reach ${o.block} safely`)
        return
      }
      if (bDeny === 'below-feet') {
        // atl.17: below-feet is a property of the PLACE — find re-picks the
        // same nearest block and the stance never changes, so the dig
        // refuses 3 times with the bot standing still (prod 2026-09-28).
        // Raise the stuck fact and let the recover menu change the stance
        // (sidestep); release() resumes ctx.bring untouched, find re-picks
        // the same block from the new stance, and the dig passes. One
        // episode per strike at most (setStuck latches while one runs);
        // denyStrikes stays the ceiling.
        try { recover.setStuck(ctx, 'bring', o.pos, `bring:${o.pos.x},${o.pos.y},${o.pos.z}`) } catch (_) { /* stuck best-effort */ }
      }
      o.pos = null
      o.phase = 'find'
      return
    }
    ctx.digInFlight = true
    void (async () => {
      try {
        // Ore dug with the sword in hand drops nothing: hold the best
        // harvest tool first (guarded: fake bots may lack either method).
        let tool = null
        try { tool = bot.pathfinder && typeof bot.pathfinder.bestHarvestTool === 'function' ? bot.pathfinder.bestHarvestTool(block) : null } catch (_) { tool = null }
        if (tool && typeof bot.equip === 'function') await bot.equip(tool, 'hand')
        await bot.dig(block)
      } catch (_) { /* gone or interrupted: pickup anyway */ }
      ctx.digInFlight = false
      o.denyStrikes = 0 // a completed dig is progress: fresh strike budget
      o.phase = 'pickup'
    })()
    return
  }

  if (o.phase === 'kill') {
    if (food) { killFood(bot, ctx, o, bp); return }
    refuse(bot, ctx, `could not bring ${o.block || o.name}`)
    return
  }

  if (o.phase === 'pickup') {
    if (food) { pickupFood(bot, ctx, o, bp, grounded); return }
    const key = `bring-pickup:${o.pos.x},${o.pos.y},${o.pos.z}`
    if (key !== ctx.lastGoalKey) {
      bot.pathfinder.setGoal(new goals.GoalBlock(o.pos.x, o.pos.y, o.pos.z), false)
      ctx.lastGoalKey = key
      return
    }
    // Reached or gave up getting there: the inventory count is the truth.
    o.have = countDrop(bot, o.drop)
    if (o.have >= o.want) {
      if (o.subFor) { // the gap is filled: back to the parent craft rung
        itemMod.resumeSub(bot, ctx, o)
        return
      }
      o.phase = 'return'
      o.saidWaiting = false
    } else {
      o.pos = null
      o.phase = 'find'
    }
    return
  }

  if (o.phase === 'return') {
    if (o.subFor) { // a sub-order resumes, never tosses: the mats belong to the craft
      itemMod.resumeSub(bot, ctx, o)
      return
    }
    // Self orders keep the goods: no walk, no toss (jr2.2 wool stays packed
    // for the beds). The owning step reads the pack, not the order.
    if (o.self) { done(bot, ctx); return }
    const p = bot.players && bot.players[o.by] && bot.players[o.by].entity
    if (!p || !p.position) {
      // 3a7 honesty: no coordinates for an out-of-range player — say where
      // the bot is and hold the drops until the player is back.
      if (!o.saidWaiting) {
        o.saidWaiting = true
        say(bot, o.kind === 'share'
          ? `I can't see you — I'm at ${atPos(bot)}; come closer`
          : `I can't see you — I'm at ${atPos(bot)} with your ${o.have} ${o.drop}; come closer`)
      }
      return
    }
    o.saidWaiting = false
    const pp = p.position
    const key = `bring-return:${Math.round(pp.x)},${Math.round(pp.y)},${Math.round(pp.z)}`
    if (key !== ctx.lastGoalKey) {
      bot.pathfinder.setGoal(new goals.GoalNear(pp.x, pp.y, pp.z, RETURN_RANGE), false)
      ctx.lastGoalKey = key
    }
    let d = null
    try { d = typeof bp.distanceTo === 'function' ? bp.distanceTo(pp) : Math.hypot(bp.x - pp.x, bp.y - pp.y, bp.z - pp.z) } catch (_) { d = null }
    if (d !== null && d <= RETURN_RANGE + 0.5) {
      if (o.kind === 'share' || o.kind === 'item') { itemMod.shareToss(bot, ctx, o); return }
      if (o.tossInFlight) return
      let id = null
      try {
        const entry = bot.registry && bot.registry.itemsByName && bot.registry.itemsByName[o.drop]
        id = entry && entry.id
      } catch (_) { id = null }
      if (typeof id !== 'number' || typeof bot.toss !== 'function') {
        refuse(bot, ctx, `could not toss ${o.drop}`)
        return
      }
      const n = Math.min(o.have, o.want)
      o.tossInFlight = true
      void (async () => {
        try {
          await bot.toss(id, null, n)
          say(bot, `here ${n === 1 ? 'is' : 'are'} ${n} ${o.drop}`)
          done(bot, ctx)
        } catch (_) {
          refuse(bot, ctx, `could not toss ${o.drop}`)
        } finally {
          o.tossInFlight = false
        }
      })()
    }
  }
}

// The item toss cap and the share/item toss live in bringitem.js.

module.exports = bring
module.exports.dropFor = dropFor
module.exports.isBringable = isBringable
module.exports.requiredTier = requiredTier
module.exports.needsPickaxe = needsPickaxe
module.exports.hasPickaxe = hasPickaxe
module.exports.WANT_ORE = WANT_ORE
module.exports.WANT_LOGS = WANT_LOGS
module.exports.WANT_FOOD = WANT_FOOD
module.exports.WANT_MAX = WANT_MAX
module.exports.isFoodRequest = itemMod.isFoodRequest
module.exports.normalizeBringName = itemMod.normalizeBringName
module.exports.resolveItem = itemMod.resolveItem
module.exports.planItemGive = itemMod.planItemGive
module.exports.orderCraftNames = itemMod.orderCraftNames
module.exports.packCounts = itemMod.packCounts
module.exports.itemRefusal = itemMod.itemRefusal
module.exports.tierArticle = tierArticle
module.exports.findEdible = itemMod.findEdible
module.exports.findAnimal = findAnimal
module.exports.sharePlan = itemMod.sharePlan
module.exports.progressed = progressed
module.exports.countDrop = countDrop
module.exports.atPos = atPos
module.exports.entityById = entityById
module.exports.PREY_NAMES = PREY_NAMES
module.exports.PREY_DROPS = PREY_DROPS
module.exports.chooseBringSearch = chooseBringSearch
module.exports.SOURCE_COST = SOURCE_COST
module.exports.SOURCE_INSTRUCTIONS = SOURCE_INSTRUCTIONS
module.exports.SOURCE_CRITERIA = SOURCE_CRITERIA
module.exports.decideBringSource = decideBringSource
module.exports.chooseBringSource = chooseBringSource
module.exports.memoryNames = memoryNames
module.exports.memoryExposed = memoryExposed
module.exports.memoryInBudget = memoryInBudget
module.exports.liveExposed = liveExposed
module.exports.buriedCand = buriedCand
module.exports.bestExposed = bestExposed
module.exports.goingForLine = goingForLine
module.exports.sourceText = sourceText
module.exports.choiceRes = choiceRes
module.exports.clearSearchLeg = clearSearchLeg
module.exports.canSearch = canSearch
module.exports.canBringName = canBringName
module.exports.openPhase = openPhase
module.exports.SEARCH_BUDGET = SEARCH_BUDGET
module.exports.SEARCH_INSTRUCTIONS = SEARCH_INSTRUCTIONS
module.exports.SEARCH_CRITERIA = SEARCH_CRITERIA
module.exports.toWoolHunt = itemMod.toWoolHunt
// Terminal actions for the bringitem.js bridge (deferred require back).
module.exports.refuse = refuse
module.exports.done = done
module.exports.refuseItemOrHunt = itemMod.refuseItemOrHunt
module.exports.enterCraftOrRefuse = itemMod.enterCraftOrRefuse
module.exports.craftTick = itemMod.craftTick
module.exports.fetchItem = itemMod.fetchItem
module.exports.shareToss = itemMod.shareToss
module.exports.openSubOrder = itemMod.openSubOrder
module.exports.resumeSub = itemMod.resumeSub
module.exports.bedGap = itemMod.bedGap
module.exports.pickSubGap = itemMod.pickSubGap
module.exports.subWordFor = itemMod.subWordFor
module.exports.smeltingGap = itemMod.smeltingGap
