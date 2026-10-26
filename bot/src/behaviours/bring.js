'use strict'

const { goals } = require('mineflayer-pathfinder')
const { findNearest, loadedSearchRadius, startFarSearch, stepFarSearch, resolveFindIds, ORE_NAMES, MAX_DIG_DEPTH, MAX_DIG_DISTH } = require('./scout')
const { countItems } = require('../perception')
const worker = require('../worker')
const resources = require('../resources')
const fightMod = require('./fight')
const exploreMod = require('./explore')
const stuck = require('../stuck')
const stockpileMod = require('./stockpile')
const metrics = require('../metrics')
const { say, clearGoal, issueGoal, denyReason, logDeny, submergedAt, solidBelow, protectedReason, atPos, isWetDigName } = require('./util')
const itemMod = require('./bringitem')
const {
  WANT_ORE, WANT_MAX, countDrop, refuse, done, releaseSmelt, stopGuidedWork, dropFor, requiredTier,
  PICKAXE_RANK, bestPickRank, hasPickaxe, tierArticle, tierRefusal, PREY_NAMES, PREY_DROPS,
  animalDist, findAnimal, entityById, progressed, hasEmptyBucket, toWaterFill,
} = require('./bringbase') // oqul.11: shared with bringitem; oqul.14: the tiers/hunt/progress home is bringbase
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
const WANT_LOGS = 4
const WANT_FOOD = 3
const WALK_STALL_TICKS = 10 // stationary ticks before skipping an unreachable target
const CHEST_STALL_TICKS = 5 // far+standing ticks before the chest fetch falls back (a single
  // far reading is often a recovering pathfinder, not an unreachable chest)
const RETURN_RANGE = 2

// Guided dig-in (idkcraft-jlda.4): a buried walk stall delegates the TUNNEL,
// not the ore — the Baritone worker bores to the vein, the head follows it
// through, the worker steps back, the head digs and picks up itself. Every
// deadline below falls back to the byte-identical refusal (pinned by test);
// the deadline + #stop IS the recovery (no stuck detectors, the 6x7 rule).
const GUIDED_TOTAL_MS = 180000 // whole delegation, all sub-phases
const GUIDED_GONE_MS = 20000 // worker entity out of view
const GUIDED_STILL_MS = 30000 // worker entity not displacing (suspended while leash-paused)
const GUIDED_TOOL_MS = 30000 // meet cap: the worker never came — bore from wherever it is
const GUIDED_PAUSE_D = 8 // head this far behind the worker: #pause (only on transitions)
const GUIDED_RESUME_D = 4 // head back within this: #resume
const GUIDED_ARRIVE_D = 2.5 // ab.js REACH_DIST: the worker is at its goto
const GUIDED_CLEAR_D = 3 // stepped back this far from the bore target: the head digs
const GUIDED_FOLLOW_RANGE = 2 // GoalFollow range behind the boring worker
const GUIDED_REISSUE_MS = 6000 // re-anchor GoalFollow on the moving worker (follow.js rule)

// Search budget (idkcraft-atl.9): K=24 legs or 5 minutes, whichever binds
// first (time is the intended real limit). The 22 legs out to ring-128
// walk ~770 blocks (~3 min open-ground + re-finds), so they fit the cap
// on easy terrain; stalls and stuck episodes bind it earlier in forest.
// Plain constants — the values never change at runtime (not forwarded in
// compose); tests stub them through the module export below.
const SEARCH_BUDGET = { legs: 24, minutes: 5 }
const SELF_SEARCH_RADIUS = 96 // 9qt0: self-order legs stay this close to the anchor
function searchLegs() {
  return SEARCH_BUDGET.legs
}
function searchMinutes() {
  return SEARCH_BUDGET.minutes
}

// Only ores and logs are fetchable (the bead's resources): anything else
// (stone->cobble, grass->dirt, ...) drops a different item, so the drop
// count would never grow and the order would mine the area forever.
// Sand drops itself (g0z.37: castle glass); gravel stays out (junk).
function isBringable(blockName) {
  return blockName.endsWith('_ore') || blockName.endsWith('_log') || blockName === 'sand' || blockName === 'red_sand'
}

// The share keep-list and plan live in bringitem.js (did.4 split); the
// dispatcher reaches them as itemMod.sharePlan.

function needsPickaxe(blockName) {
  return blockName.endsWith('_ore')
}

function skipKey(p) {
  return `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`
}

// Re-validate below-feet skips when live candidates run out (x16j r1):
// the walls that made a cell a trap may be gone (mined since) while the
// skip persists, stranding a now-safe ore. Drops skips whose cell still
// holds the order's block and now passes the guard; returns true when any
// dropped so the caller searches again. Protected/submerged skips are
// never re-validated (a build or water is a property of the block).
function revalidateBelowFeetSkips(bot, ctx, o) {
  const bf = o && o.bfSkip
  if (!bf || typeof bf.has !== 'function' || bf.size === 0) return false
  let dropped = false
  for (const key of [...bf]) {
    const xyz = String(key).split(',').map(Number)
    if (xyz.length !== 3 || xyz.some((n) => !Number.isFinite(n))) continue
    let block = null
    try { block = bot.blockAt && bot.blockAt(new Vec3(xyz[0], xyz[1], xyz[2])) } catch (_) { block = null }
    if (!block || block.name !== o.block) continue // gone or changed: keep skipped, find never surfaces it
    let deny = 'protected'
    try { deny = denyReason(bot, block, ctx) } catch (_) { deny = 'protected' }
    if (deny !== null) continue // still a trap or a build: stays skipped
    bf.delete(key)
    try { if (o.skip && typeof o.skip.delete === 'function') o.skip.delete(key) } catch (_) { /* skip best-effort */ }
    dropped = true
    try { console.log(`below-feet ${o.block} at ${key.replace(/,/g, ' ')} safe again, unskipped (x16j r1)`) } catch (_) { /* logging never breaks a find */ }
  }
  return dropped
}

// The item order rungs (did.1 normalisation, resolver, pack plan, honest
// stub) live in bringitem.js (did.4 split); the dispatcher reaches them as
// itemMod.*.

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
      const b = bot.blockAt && bot.blockAt(new Vec3(Math.floor(p.x) + ox, Math.floor(p.y) + oy, Math.floor(p.z) + oz))
      if (b && typeof b.name === 'string' && b.name.endsWith('_fence')) {
        console.log(`hunt animal near fences: ${animal.name} at ${Math.round(p.x)} ${Math.round(p.y)} ${Math.round(p.z)}`)
        return
      }
    }
  } catch (_) { /* fact best-effort */ }
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
// remembered spots ×1.5 for staleness. The walk leg prices the vertical
// too (atl.21): a descent to a deep cave is not free — atl.18 S2 priced a
// 77-block hike with a 60-deep descent under 20 s and walked 337 s. No A*:
// if relief lies about distance, bot.pathfinder.getPathTo(movements, goal,
// timeout) is the upgrade path. The vertical is two-rate (idkcraft-8w0):
// shallow relief prices linear, cave-scale relief past the knee prices at
// the S2-observed ~6 s/block — the linear 1.5 s still underpriced deep
// descents (a 90-deep hike quoted 140 s and timed out the 600 s order on
// master). Past maxWalkDescent the hike is not offered at all: a dy-48
// round trip already fills the order budget, so the verdict digs, walks
// legs, or refuses instead. Plain constants — the values never change at
// runtime; tests stub them through the module export below.
const SOURCE_COST = {
  walkBlocksPerSec: 4,
  vertSecPerBlock: 1.5, // each block of climb/descent on a walk leg, to the knee
  deepVertSecPerBlock: 6, // past vertKneeBlocks: cave navigation, falls, backtracking
  vertKneeBlocks: 12, // shallow relief prices linear; past it, the cave rate rules
  // Walk gate (idkcraft-8w0): an exposed vein deeper than this below the
  // feet is no walk candidate (liveExposed/memoryExposed return null, the
  // chv shape). == the sync-48 edge, so a creation direct-commit — always
  // within 48 in real geometry — never gates; only far/memory verdicts do.
  // Climbs stay ungated (no failure class observed); descents only.
  maxWalkDescent: 48,
  digSecPerBlock: 2,
  deepDigDepth: 4,
  // Dig-down gate (idkcraft-chv): a buried hit deeper than maxDigDepth
  // AND further out than maxDigDistH is no dig candidate at all — the walk
  // cannot commit down a shallow approach (atl.20 S3: dy 15+ at distH ~33
  // stalled without digging), while either axis alone digs (S1 dy 9-10, S4
  // steep dy-16 at distH 11 through solid ground). buriedCand returns null
  // past both, so the verdict hunts legs or refuses honestly with the vein
  // coords instead of stalling on the surface. Mirrors scout gatedShaft.
  maxDigDepth: MAX_DIG_DEPTH,
  maxDigDistH: MAX_DIG_DISTH,
  shaftPenaltySec: 25,
  // Breath (idkcraft-0u9): a dive costs a surface trip plus the drowning
  // risk — priced above a deep shaft so a dry rival wins deterministically.
  wetPenaltySec: 30,
  memoryFactor: 1.5,
  budget: 160, // == scout SEARCH_MAX, the loaded-world edge. The shells
  // run in exposed mode here (atl.19): buried ore inside 96 neither
  // closes a ring nor drops exposed hits past 96 from the final pool,
  // while the buried second pass still feeds candidate (c).
  clearRatio: 0.5, // cheaper than half the rival: a clear winner, no model
}

function walkCost(distH) {
  return Math.max(0, distH) / SOURCE_COST.walkBlocksPerSec
}

function vertCost(dy) {
  const d = Math.abs(dy)
  const knee = Math.min(d, SOURCE_COST.vertKneeBlocks)
  return knee * SOURCE_COST.vertSecPerBlock + (d - knee) * SOURCE_COST.deepVertSecPerBlock
}

function digCost(depthBelow) {
  const d = Math.max(0, depthBelow)
  return d * SOURCE_COST.digSecPerBlock + (d > SOURCE_COST.deepDigDepth ? SOURCE_COST.shaftPenaltySec : 0)
}

// The walk gate (8w0) as one predicate: an exposed vein more than
// maxWalkDescent below the feet is no walk candidate. Shared by the live,
// memory and far-shell (atl.22, scout opts.gate) reads, both twins.
function descentGated(bp, q) {
  return !!bp && !!q && typeof bp.y === 'number' && typeof q.y === 'number' &&
    Math.floor(bp.y) - Math.floor(q.y) > SOURCE_COST.maxWalkDescent
}

// Scout results normalised to costed candidates. Exposed (live or memory)
// always means walk; buried means walk-to plus the dig below the feet.
// bot is optional (unit shorthand): without a world view no wet check runs
// and the costs are exactly the legacy ones.
function liveExposed(bp, res, bot = null) {
  if (!res || !res.position || res.exposed === false) return null
  const p = res.position
  const distH = Math.hypot(p.x - bp.x, p.z - bp.z)
  const dy = Math.floor(bp.y) - Math.floor(p.y) // +below, the buried depthBelow gauge
  if (descentGated(bp, p)) return null // gated descent: no-hike (8w0)
  const wet = !!bot && submergedAt(bot, p.x, p.y, p.z)
  return { kind: 'live', name: res.name, pos: p, distH, dist: res.distance, dy, wet, cost: walkCost(distH) + vertCost(dy) + (wet ? SOURCE_COST.wetPenaltySec : 0), ageMs: null }
}

// A buried hit under open water floods the shaft: the vein sits below the
// lakebed, so the check scans the column above the target (bounded: a lake
// over the vein is within a few cells of it).
const WET_COLUMN_CELLS = 8

function buriedCand(bp, res, bot = null) {
  if (!res || !res.position) return null
  const p = res.position
  const distH = Math.hypot(p.x - bp.x, p.z - bp.z)
  const depthBelow = Math.max(0, Math.floor(bp.y) - Math.floor(p.y))
  if (depthBelow > SOURCE_COST.maxDigDepth && distH >= SOURCE_COST.maxDigDistH) return null // gated shaft: no-dig (chv)
  // The column only matters for a real shaft (jlda.12): a same-level dig
  // (depthBelow < 2) never breaches the cells above the ore, so water up
  // there is not a flood risk — reading it wet routes a 2-block dig
  // through the far shells into the absolute wet-vs-dry rule, which walks
  // 150+ blocks to a dry rival over the vein-mate below the stance.
  let wet = false
  if (bot && depthBelow >= 2) {
    for (let i = 0; i < WET_COLUMN_CELLS && !wet; i++) wet = submergedAt(bot, p.x, p.y + i, p.z)
  }
  return { kind: 'buried', name: res.name, pos: p, distH, dist: res.distance, depthBelow, wet, cost: walkCost(distH) + digCost(depthBelow) + (wet ? SOURCE_COST.wetPenaltySec : 0), ageMs: null }
}

// Cheaper walk wins between the two exposed candidates — same action
// (walk_exposed), so no model is needed to split them.
function bestExposed(a, b) {
  if (a && b) return a.cost <= b.cost ? a : b
  return a || b || null
}

// The gated shaft for the honest refusal (chv): when the gate drops every
// dig candidate, the order remembers the vein so the refusal names coords
// instead of stalling silently. Overwritten on every gate, never cleared —
// a stale entry only surfaces in the legs-exhausted line, labelled 'known'.
function deepVeinOf(bp, res) {
  if (!res || !res.position || !bp || typeof bp.y !== 'number') return null
  return {
    name: res.name,
    x: Math.floor(res.position.x), y: Math.floor(res.position.y), z: Math.floor(res.position.z),
    depth: Math.max(0, Math.floor(bp.y) - Math.floor(res.position.y)),
    ...(res.exposed === true ? { walk: true } : {}), // a gated hike (atl.22), not a shaft
  }
}

function deepRefusal(o) {
  const v = o && o.deepVein
  if (!v) return null
  return `${v.name} at ${v.x} ${v.y} ${v.z} is ${v.depth} down — too deep to ${v.walk ? 'walk to' : 'dig'}`
}

// Empty-find refusal text with the gated shaft preferred (chv): 'no X
// within N' would be a lie when the vein is there but undiggable.
function gatedOrEmptyRefusal(o, edge) {
  const deep = deepRefusal(o)
  if (deep) return deep
  return emptyRefusal(o, edge)
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
    // The descent gate filters the nearest pick itself (revmux 01 core-2):
    // a deep nearest note must not mask a shallower remembered vein — the
    // pick skips past gated notes instead of nulling the whole call.
    const item = resources.nearest(ctx, bp, names, (it) => it.exposed !== true || descentGated(bp, it) || (hasSkip && skip.has(skipKey(it))))
    if (!item || typeof item.x !== 'number') return null
    let now = false
    try { now = resources.exposedOf(bot, item) } catch (_) { now = false }
    if (now !== true) return null // closed up or mined out since noted
    let pre = null
    try {
      const blk = bot.blockAt && bot.blockAt(new Vec3(Math.floor(item.x), Math.floor(item.y), Math.floor(item.z)))
      pre = blk && denyReason(bot, blk, ctx)
    } catch (_) { pre = null }
    if (pre === 'protected' || pre === 'submerged') return null // owner build or dive: same rule as the live loop
    const distH = Math.hypot(item.x - bp.x, item.z - bp.z)
    const dist = Math.hypot(item.x - bp.x, item.y - bp.y, item.z - bp.z)
    const dy = Math.floor(bp.y) - Math.floor(item.y) // +below, priced like the live leg
    if (descentGated(bp, item)) return null // gated descent: no-hike (8w0, safety net past the pick filter)
    const wet = submergedAt(bot, item.x, item.y, item.z)
    return {
      kind: 'memory', name: item.name, pos: { x: item.x, y: item.y, z: item.z },
      distH, dist, dy, wet, cost: walkCost(distH) * SOURCE_COST.memoryFactor + vertCost(dy) + (wet ? SOURCE_COST.wetPenaltySec : 0),
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
    ? `walk:${exposed.cost.toFixed(1)}s(dist=${Math.round(exposed.distH)},${exposed.kind === 'memory' ? `age=${ageText(exposed.ageMs)}` : 'live'}${exposed.wet ? ',underwater' : ''})`
    : 'walk:none'
  const b = buried
    ? `dig:${buried.cost.toFixed(1)}s(dist=${Math.round(buried.distH)},depth=${Math.round(buried.depthBelow)}${buried.wet ? ',underwater' : ''})`
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
  // A wet source is a certain refusal ('submerged' denies the dig), so a
  // dry rival wins outright instead of going to the model (revmux 01
  // core-3) — except a beyond-budget memory hike, which the model still
  // judges per the rule below.
  if (exposed.wet && buried && !buried.wet) return { pick: 'buried', why: 'clear' }
  if (buried.wet && !exposed.wet && !memoryFar) return { pick: 'exposed', why: 'clear' }
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
const SOURCE_INSTRUCTIONS = 'Choose whether the bring order walks to exposed ore or digs a buried block. An underwater source always fails: never pick one when the other is dry'
const SOURCE_CRITERIA = {
  walk_exposed: 'exposed ore is worth the walk: reliable, no shaft to dig',
  dig_buried: 'digging the buried block is faster than the long walk',
}

async function chooseBringSource(brain, text, exposed, buried, o) {
  // The FSM reserve walks to exposed ore. Wet-vs-dry pairs never reach it:
  // decideBringSource resolves those deterministically above (revmux 01
  // core-3); only the model path can still see one (memory-far edge).
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
        }, bot)
      }
    }
    let buried = null
    if (c.buriedHit && !skipped(c.buriedHit.pos)) {
      let there = false
      try {
        const blk = bot.blockAt && bot.blockAt(new Vec3(
          Math.floor(c.buriedHit.pos.x), Math.floor(c.buriedHit.pos.y), Math.floor(c.buriedHit.pos.z),
        ))
        there = !blk || (!!blk.name && blk.name === c.buriedHit.name)
      } catch (_) { there = false }
      if (there) {
        const p = c.buriedHit.pos
        buried = buriedCand(bp, {
          name: c.buriedHit.name, position: p,
          distance: Math.hypot(p.x - bp.x, p.y - bp.y, p.z - bp.z), exposed: false,
        }, bot)
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

// One-line verdict for the bot log (atl.21): both candidates with coords
// and priced costs plus the pick, so a bad walk traces to the number that
// chose it. Pure for tests; commitSource logs it on every verdict.
function verdictLine(name, exposed, buried, pick) {
  const side = (c, label) => c
    ? `${label} ${c.kind} @${Math.floor(c.pos.x)},${Math.floor(c.pos.y)},${Math.floor(c.pos.z)} ${c.cost.toFixed(1)}s`
    : `${label} none`
  return `bring verdict ${name}: ${side(exposed, 'walk')} vs ${side(buried, 'dig')} -> ${pick}`
}

function verdictPos(c) {
  if (!c || !c.pos) return null
  return { x: Math.floor(c.pos.x), y: Math.floor(c.pos.y), z: Math.floor(c.pos.z), cost: c.cost }
}

// Structured verdict facts for the order (revmux 01 core-1): the find
// verdict stores them via commitSource, the creation verdicts in index.js
// attach the same shape to the order they create.
function verdictFacts(exposed, buried, pick) {
  const win = pick === 'buried' ? buried : exposed
  const rival = pick === 'buried' ? exposed : buried
  return { pick, win: verdictPos(win), rival: verdictPos(rival) }
}

// Shared commit for the find and searchfar verdicts (and order creation,
// via the same res shape): plants the target, checks the pickaxe tier,
// announces once. A memory target rides o.far — unloaded is not gone
// (gather's far rule). Returns false when the tier refuses.
function commitSource(bot, ctx, o, exposed, buried, pick) {
  const win = pick === 'buried' ? buried : exposed
  const rival = pick === 'buried' ? exposed : buried
  o.verdict = verdictFacts(exposed, buried, pick)
  console.log(verdictLine((o && o.name) || (win && win.name) || 'block', exposed, buried, pick))
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
    refuse(bot, ctx, tierRefusal(bot, res.name))
    return false
  }
  if (!o.announced) {
    o.announced = true
    say(bot, goingForLine(o.want, res))
  }
  o.phase = 'walk'
  o.stalls = 0
  o.lastPos = null
  o.guided = null // a fresh target starts unguided; the stall re-delegates
  return true
}

// Honest end of a spent search: the legs walked, then what was found.
function refuseExhausted(bot, ctx, o) {
  const n = o.searchLegs ? o.searchLegs.legs : 0
  const kind = o.kind || 'block'
  const woolNone = o.color ? `no ${o.color} sheep` : 'no sheep'
  const skippedKnown = o.bfSkip && o.bfSkip.size > 0 // x16j r1: excluded-known ore reads unsafe, never absent
  const base = o.have > 0 ? `only got ${o.have} ${o.drop}`
    : ((o.sawSubmerged || skippedKnown) && kind !== 'food' && kind !== 'wool') ? `could not reach ${o.name} safely`
    : (kind === 'food' ? 'no animals' : kind === 'wool' ? woolNone : `no ${o.name}`)
  // A gated shaft seen along the way (chv): the legs proved no diggable
  // vein exists nearby, so the refusal names the known deep one.
  const deep = kind === 'block' && !(o.have > 0) && !o.sawSubmerged && o.deepVein
    ? ` — nearest known vein too deep at ${o.deepVein.x} ${o.deepVein.y} ${o.deepVein.z}`
    : ''
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
  refuse(bot, ctx, `searched ${n} areas, ${base}${deep}`)
}

// Drop a cancelled mid-leg explore pursuit (stop/follow/work/lead): the
// visited memory stays (shared exploration), the stale target must not leak
// into the next owner's walk.
function clearSearchLeg(ctx) {
  try { releaseSmelt(ctx) } catch (_) { /* cleanup best-effort */ } // ipn.20: a cancelled smelt drops its job
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

// Empty-find refusal text: when every candidate was skipped as a dive,
// 'no X' would be a lie — the ore is there, just unreachable safely. The
// same holds for below-feet skips (x16j r1): excluded-known ore must read
// as unsafe, never as absent.
function emptyRefusal(o, edge) {
  if (o && !(o.have > 0) && (o.sawSubmerged || (o.bfSkip && o.bfSkip.size > 0))) return `could not reach ${o.name} safely`
  return `no ${o.name} within ${edge} blocks (loaded area)`
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
  // Self hunts (9qt0) stay within SELF_SEARCH_RADIUS of the anchor: prod
  // legs ran 129-256 blocks out and the night caught the bot there (~50 of
  // 61 deaths). No unvisited ground in reach is an exhausted search.
  // While a build task is active (vmzq.19) the cap is the task radius, the
  // same 64 the explore legs walk under — one radius for every own leg.
  // (.22) a radius unlock lifts the cap for the window only (clamped).
  if (o.self) {
    let cap = exploreMod.taskActive(ctx) ? exploreMod.TASK_SEARCH_RADIUS : SELF_SEARCH_RADIUS
    try {
      const { goalUnlock } = require('../goal-unlock')
      const r = goalUnlock(ctx, 'radius')
      if (typeof r === 'number' && r > cap) cap = r
    } catch (_) { /* default cap */ }
    const t = exploreMod.nextTarget(bot, ctx, cap)
    if (!t) {
      s.capped = true
      refuseExhausted(bot, ctx, o)
      return
    }
    // A far leg the explore step left pending (dusk re-decide) yields to
    // the near pick (revmux 01 core-4).
    const e = ctx.explore
    if (e && e.target && e.target !== t) {
      e.target = t
      e.issuedKey = null
      e.markStart = e.visited instanceof Set ? e.visited.size : 0
    }
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
    issueGoal(bot, ctx, new goals.GoalNear(ent.position.x, ent.position.y, ent.position.z, 2), key, false)
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
    issueGoal(bot, ctx, new goals.GoalBlock(dp.x, dp.y, dp.z), key, false)
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

// Bucket fill (idkcraft-k2ze): a 'bring me water_bucket' order whose pack
// holds an empty bucket fills it from nearby source water, then returns
// like any item order. Before this the order fell through to the honest
// stub ('can't get water_bucket: no recipe, no source'), so WATER-1 LLM
// orders went 0/5. Scoop shape mirrors gear.js runFillOp: buckets work
// ONLY via lookAt + activateItem (placeBlock is silently ignored for
// buckets on Paper); only level-0 still water fills, flow never does.
const FILL_SEARCH = 32
const FILL_REACH = 4
// Deep scan (gear.js FILL_SCAN_COUNT shape): findBlocks slices to count
// BEFORE we filter, so a shallow count hides a farther source behind nearer
// flow — masking needs 513 nearer unfillable cells to refuse wrongly, which
// still water never has. The depth costs nothing extra (findBlocks scans
// the sphere either way and only sorts/slices more).
const FILL_SCAN_COUNT = 512
const FILL_WALK_TICKS = 30 // per-cell walk patience before the next cell
const FILL_SETTLE_MS = 500 // scoop apply + client update
const FILL_BUDGET_MS = 5 * 60 * 1000 // whole fill phase, all cells

function waterBlockId(bot) {
  try {
    const byName = (bot.registry && bot.registry.blocksByName) || {}
    const e = byName.water
    if (e && typeof e.id === 'number') return e.id
  } catch (_) { /* unresolvable */ }
  return null
}

// Proven flow only (gear.js isFlowWater shape): unreadable cells stay
// candidates — excluding only proven flow never strands a fill the old
// scan would have landed.
function isFillFlow(bot, p) {
  try {
    const b = bot && typeof bot.blockAt === 'function' ? bot.blockAt(p) : null
    if (!b) return false
    let level = null
    if (typeof b.getProperties === 'function') {
      const props = b.getProperties()
      if (props && props.level != null) level = props.level
    }
    if (level == null && typeof b.metadata === 'number') level = b.metadata
    if (level == null) return false
    const n = typeof level === 'number' ? level : parseInt(level, 10)
    return Number.isFinite(n) && n !== 0
  } catch (_) {
    return false
  }
}

// Scoopable means reachable by the server raycast (revmux 02 core-1): a
// buried aquifer behind rock never fills, so only cells without solid rock
// above them are candidates. Air and water above pass (shore scoops and
// submerged scoops); unreadable cells stay candidates — a miss just marks
// the cell tried and moves on.
function hasSolidAbove(bot, p) {
  try {
    // Vec3, not a plain object: bot.blockAt -> world getBlock calls
    // pos.floored() (prismarine-world worldsync.js), which throws on a
    // plain {x,y,z} — the catch below would then read every cell as open.
    const b = bot && typeof bot.blockAt === 'function' ? bot.blockAt(new Vec3(p.x, p.y + 1, p.z)) : null
    if (!b) return false
    if (typeof b.boundingBox === 'string') return b.boundingBox !== 'empty'
    const n = typeof b.name === 'string' ? b.name : ''
    if (n === '' || n.endsWith('air')) return false
    if (n.includes('water')) return false
    return true
  } catch (_) {
    return false
  }
}

// Nearest-first source water cells, tried ones excluded.
function findFillWater(bot, tried) {
  try {
    if (!bot || typeof bot.findBlocks !== 'function') return []
    const id = waterBlockId(bot)
    if (id === null) return []
    const skip = tried ? Object.keys(tried).length : 0
    const found = bot.findBlocks({ matching: [id], maxDistance: FILL_SEARCH, count: FILL_SCAN_COUNT + skip }) || []
    const out = []
    for (const p of found) {
      if (!p || typeof p.x !== 'number') continue
      const key = `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`
      if (tried && tried[key]) continue
      if (isFillFlow(bot, p)) continue
      if (hasSolidAbove(bot, p)) continue
      out.push({ x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z), key })
    }
    return out
  } catch (_) {
    return []
  }
}

// Pack the filled buckets for the return walk; a partial says so, like the
// chestfetch short path ('only …, coming').
function fillGive(bot, o, have, partial) {
  o.items = [{ name: 'water_bucket', count: Math.min(have, o.want) }]
  o.drop = 'water_bucket'
  o.have = have
  o.phase = 'return'
  o.saidWaiting = false
  if (partial) say(bot, `only ${have} water_bucket, coming`)
}

function fillBucket(bot, ctx, o, bp) {
  const have = countDrop(bot, 'water_bucket')
  if (have >= o.want) {
    fillGive(bot, o, have, false)
    return
  }
  // Order-level budget (revmux 01 core-3): the per-cell patience below only
  // counts walk ticks, and the tried set can grow cell by cell across a
  // whole lake — cap the phase so only stop is never the only way out.
  if (Date.now() - (o.fillStartedAt || Date.now()) > FILL_BUDGET_MS) {
    if (have > 0) {
      fillGive(bot, o, have, true)
      return
    }
    refuse(bot, ctx, 'could not fill the bucket in time')
    return
  }
  if (!hasEmptyBucket(bot)) {
    if (have > 0) { // the empty went missing mid-order: deliver what filled
      fillGive(bot, o, have, true)
      return
    }
    refuse(bot, ctx, 'lost the bucket before it filled')
    return
  }
  if (!o.fillTried || typeof o.fillTried !== 'object') o.fillTried = {}
  if (!o.fillTarget || o.fillTried[o.fillTarget.key]) o.fillTarget = null
  if (!o.fillTarget) {
    const cands = findFillWater(bot, o.fillTried)
    if (cands.length === 0) {
      // A partial fill that ran dry still delivers (revmux 01 core-2):
      // refusing here would strand buckets the bot just filled.
      if (have > 0) {
        fillGive(bot, o, have, true)
        return
      }
      refuse(bot, ctx, 'no water nearby to fill the bucket')
      return
    }
    o.fillTarget = cands[0]
    o.fillTicks = 0
  }
  const t = o.fillTarget
  let d = null
  try {
    d = typeof bp.distanceTo === 'function' ? bp.distanceTo(t) : Math.hypot(bp.x - t.x, bp.y - t.y, bp.z - t.z)
  } catch (_) { d = null }
  if (d !== null && d > FILL_REACH) {
    const key = `bring-fill:${t.key}`
    if (key !== ctx.lastGoalKey) issueGoal(bot, ctx, new goals.GoalNear(t.x, t.y, t.z, 2), key, false)
    o.fillTicks = (o.fillTicks || 0) + 1
    if (o.fillTicks > FILL_WALK_TICKS) { // unreachable cell: try the next one, never stall
      o.fillTried[t.key] = true
      o.fillTarget = null
      o.fillTicks = 0
      clearGoal(bot, ctx)
    }
    return
  }
  let moving = false
  try { moving = bot.pathfinder.isMoving() } catch (_) { /* treat as arrived */ }
  if (moving) {
    // Arrival never comes (a GoalNear thrash on a shoreline): count it like
    // a far tick, so the cell still gives up instead of holding the body.
    o.fillTicks = (o.fillTicks || 0) + 1
    if (o.fillTicks > FILL_WALK_TICKS) {
      o.fillTried[t.key] = true
      o.fillTarget = null
      o.fillTicks = 0
      clearGoal(bot, ctx)
    }
    return
  }
  clearGoal(bot, ctx)
  if (o.fillInFlight) return // exactly one scoop at a time (dig rule)
  if (typeof bot.activateItem !== 'function') {
    refuse(bot, ctx, 'could not fill the bucket')
    return
  }
  o.fillInFlight = true
  void (async () => {
    try {
      let item = null
      try {
        const items = bot.inventory.items()
        if (Array.isArray(items)) item = items.find((i) => i && i.name === 'bucket') || null
      } catch (_) { item = null }
      if (!item) { o.fillInFlight = false; return }
      if (typeof bot.equip === 'function') await bot.equip(item, 'hand')
      try { bot.lookAt(new Vec3(t.x + 0.5, t.y + 0.5, t.z + 0.5), true) } catch (_) { /* aim best-effort */ }
      bot.activateItem()
    } catch (_) {
      o.fillInFlight = false
      return // transient race: the next tick retries the same cell
    }
    await new Promise((resolve) => setTimeout(resolve, FILL_SETTLE_MS))
    o.fillInFlight = false
    if (!ctx || ctx.bring !== o) return
    let now = 0
    try { now = countDrop(bot, 'water_bucket') } catch (_) { now = have }
    if (now <= have) { // flow cell or a missed raycast: next one
      o.fillTried[t.key] = true
      o.fillTarget = null
      o.fillTicks = 0
      return
    }
    o.fillTarget = null
    o.fillTicks = 0
  })()
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

// Pillar wedge (idkcraft-jlda.13): mineflayer-pathfinder 2.4.5 holds jump on
// a jump-place step until the body rises past the placement, and its placing
// branch returns before the 3.5 s 'stuck' check — a rise Paper cancels (the
// jumpcost.js wedge) hovers with no path reset until the walk stall refuses.
// MINE-10: partial A* rounds flip between the tunnel dig and a pillar up the
// 1x1 shaft, and the run that commits to the pillar hovers there. Only this
// signature (a place step held while the body stays put) counts, once per
// target key; a pathfinder without isBuilding never wedges.
const PILLAR_WEDGE_TICKS = 3
function pillarWedged(bot, o, bp, key) {
  if (o.unwedged === key) return false
  let building = false
  try { building = !!(bot.pathfinder && typeof bot.pathfinder.isBuilding === 'function' && bot.pathfinder.isBuilding()) } catch (_) { building = false }
  // A healthy pillar rises ~1 block per tick without landing on every
  // sample (no horizontal progress either): only a body that also stays at
  // the same height counts.
  const still = typeof o.wedgeY === 'number' && Math.abs(bp.y - o.wedgeY) < 0.5
  o.wedgeY = bp.y
  if (!building || !still) { o.wedge = 0; return false }
  if ((o.wedge = (o.wedge || 0) + 1) < PILLAR_WEDGE_TICKS) return false
  o.wedge = 0
  o.unwedged = key
  return true
}

// The walk-stall refusal line, shared by the direct stall and the guided
// fallback so the two can never drift (the buried form is pinned by test).
function unreachLine(o) {
  const at = o.pos ? ` at ${Math.floor(o.pos.x)} ${Math.floor(o.pos.y)} ${Math.floor(o.pos.z)}` : ''
  return `could not reach ${o.block}` + (o.exposed === false ? ` (buried, no path in)${at}` : '')
}

// Flood risk (idkcraft-jlda.12): true when digging the target would pour
// water onto the bot's stance — a wet face on a side or above the target
// at or above the feet level. The dug cell floods and the stance floods
// with it (same level, and the walk got here, so it is connected), and a
// floating head can neither swim out (Paper 26.1.2 rejects the wall-rise)
// nor descend to the ore (the swim prune) — the MINE-10 vein pocket traps
// the order into a 7/10 walk stall either way. Below-stance water stays
// below: digging it only wets the hole, never the feet. The below face
// is not read: water cannot flow up into the dug cell. On the atl.20
// drop (drop=true) the hole becomes the stance, so the faces measure
// against feet-1 instead of the pre-dig feet.
function floodRisk(bot, block, bp, drop = false) {
  try {
    if (!block || !block.position || !bp || typeof bp.y !== 'number') return false
    const feet = Math.floor(bp.y) - (drop ? 1 : 0)
    const p = block.position
    const faces = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, 0, 1], [0, 0, -1]]
    for (const [dx, dy, dz] of faces) {
      const c = { x: Math.floor(p.x) + dx, y: Math.floor(p.y) + dy, z: Math.floor(p.z) + dz }
      if (c.y < feet) continue
      let n = null
      try {
        // Vec3, not the plain cell: prod blockAt calls pos.floored().
        const b = bot.blockAt && bot.blockAt(new Vec3(c.x, c.y, c.z))
        n = (b && b.name) || null
      } catch (_) { n = null }
      if (isWetDigName(n)) return true
    }
  } catch (_) { return false }
  return false
}

// The bore target: a face neighbour of the ore on the head's side, so the
// worker's approach never crosses the ore cell (it would break the ore
// and hold the drop — the case the epic forbids). Faces run
// toward-the-head first, away last; air beats stone (no last cell to
// mine), a vein-mate is the last resort before the away face (the worker
// eats one ore but the target stands — the away face would eat the target
// itself). No bottom face: #goto is a feet position and the worker stands
// two tall, so feet below the ore puts its head in the ore cell.
// Name-based: any named non-air block counts as solid.
function guidedTarget(bot, p, bp) {
  const faces = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, 0, 1], [0, 0, -1]]
    .map((f, i) => ({ f, i, dot: f[0] * (bp.x - p.x) + f[1] * (bp.y - p.y) + f[2] * (bp.z - p.z) }))
    .sort((a, b) => (b.dot - a.dot) || (a.i - b.i))
    .map((e) => e.f)
  const read = faces.map((f) => {
    const c = { x: Math.floor(p.x) + f[0], y: Math.floor(p.y) + f[1], z: Math.floor(p.z) + f[2] }
    let n = null
    try {
      // Vec3, not the plain cell: prod blockAt calls pos.floored().
      const b = bot.blockAt && bot.blockAt(new Vec3(c.x, c.y, c.z))
      n = (b && b.name) || null
    } catch (_) { n = null }
    return { c, n }
  })
  const isAir = (n) => !n || n === 'air' || n.endsWith('_air')
  const safe = read.slice(0, read.length - 1) // the away face would route the bore through the ore
  const air = safe.find((e) => isAir(e.n))
  if (air) return air.c
  const stone = safe.find((e) => e.n && !isAir(e.n) && !e.n.endsWith('_ore'))
  if (stone) return stone.c
  const mate = read.find((e) => e.n && e.n.endsWith('_ore'))
  if (mate) return mate.c
  return read[read.length - 1].c // unreachable: every cell is air, stone or ore
}

// Four blocks back along the bore face axis, away from the ore: the walk
// out never crosses the ore cell, and at five from the vein the worker is
// far outside the pickup box when the head digs.
function guidedStepback(target, ore) {
  let dx = Math.sign(target.x - ore.x)
  const dy = Math.sign(target.y - ore.y)
  const dz = Math.sign(target.z - ore.z)
  if (dx === 0 && dy === 0 && dz === 0) dx = 1 // unreachable: the target is a face neighbour
  return { x: target.x + dx * 4, y: target.y + dy * 4, z: target.z + dz * 4 }
}

// True when the worker stands on the head's side of the ore (same
// hemisphere): the bore target sits between the worker and the ore, so a
// direct goto cannot cross the ore cell.
function guidedSameSide(wpos, bp, ore) {
  try {
    if (!wpos || !bp || !ore) return false
    return (wpos.x - ore.x) * (bp.x - ore.x) + (wpos.y - ore.y) * (bp.y - ore.y) + (wpos.z - ore.z) * (bp.z - ore.z) > 0
  } catch (_) {
    return false
  }
}

// Ordered bridge lines: one connection per line, so chain the sends — two
// bare sends could arrive swapped and a #goto would land on a pause.
function sendSeq(lines) {
  void (async () => {
    for (const line of lines) {
      try { await worker.send(line) } catch (_) { /* next line anyway */ }
    }
  })()
}

// The spare pickaxe to lend the worker: the head keeps its best, the
// worker gets the lowest-rank stack's name + id. Null unless the head
// holds 2+ pickaxes in total.
function pickSpare(bot) {
  let items = null
  try { items = bot.inventory && typeof bot.inventory.items === 'function' ? bot.inventory.items() : null } catch (_) { items = null }
  if (!Array.isArray(items)) return null
  const rankOf = (n) => {
    const m = typeof n === 'string' && n.match(/^(wooden|golden|stone|iron|diamond|netherite)_pickaxe$/)
    return m ? PICKAXE_RANK[m[1]] : -1
  }
  const picks = items.filter((i) => i && rankOf(i.name) >= 0)
  if (picks.reduce((a, i) => a + (i.count || 1), 0) < 2) return null
  picks.sort((a, b) => rankOf(a.name) - rankOf(b.name))
  let id = null
  try { id = bot.registry && bot.registry.itemsByName && bot.registry.itemsByName[picks[0].name].id } catch (_) { id = null }
  if (typeof id !== 'number') {
    try { id = picks[0].type } catch (_) { id = null }
  }
  if (typeof id !== 'number' || typeof bot.toss !== 'function') return null
  return { name: picks[0].name, id }
}

function guidedAvailable(bot) {
  try {
    return worker.configured() && worker.workerOnline(bot)
  } catch (_) {
    return false
  }
}

function guidedName() {
  try {
    return worker.name()
  } catch (_) {
    return ''
  }
}

// The walk stall hands the bore over: #resume (a stale pause from an older
// job must not swallow the goto) then #goto. The worker meets the head
// first when it owes the head a visit anyway (the pickaxe lend) or stands
// on the far side — boring from there would cross the ore cell and the
// worker would hold the drop. A same-side worker bores at once.
function guidedDelegate(bot, ctx, o, bp) {
  const target = guidedTarget(bot, o.pos, bp)
  const now = Date.now()
  const spare = ctx.workerTooled ? null : pickSpare(bot)
  let wpos = null
  try {
    const w = worker.workerEntity(bot)
    wpos = w && w.position ? w.position : null
  } catch (_) { wpos = null }
  const meet = !!spare || !guidedSameSide(wpos, bp, o.pos)
  o.guided = {
    at: now, target, phase: meet ? 'meet' : 'bore',
    meetUntil: now + GUIDED_TOOL_MS,
    tool: spare, headPos: { x: bp.x, y: bp.y, z: bp.z },
    paused: false, goneSince: null, lastWorkerPos: null, lastMove: now,
    reissuedAt: 0, held: false, tossInFlight: false, stopSent: false,
  }
  clearGoal(bot, ctx) // the walk goal died with the stall; the phases below issue their own
  say(bot, `asking ${guidedName()} to dig in to ${o.block} at ${Math.floor(o.pos.x)} ${Math.floor(o.pos.y)} ${Math.floor(o.pos.z)}`)
  const gx = meet ? Math.floor(bp.x) : target.x
  const gy = meet ? Math.floor(bp.y) : target.y
  const gz = meet ? Math.floor(bp.z) : target.z
  sendSeq(['msg #resume', `msg #goto ${gx} ${gy} ${gz}`])
  o.phase = 'guided'
  o.stalls = 0
  o.lastPos = null
  return true
}

function guidedCancel(bot, ctx, o) {
  stopGuidedWork(ctx)
  metrics.workerJobs.inc({ kind: 'bore', outcome: 'fallback' })
  refuse(bot, ctx, unreachLine(o))
}

function guidedToDig(bot, ctx, o) {
  metrics.workerJobs.inc({ kind: 'bore', outcome: 'done' })
  o.phase = 'dig'
}

function d3(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)
}

// One guided tick (o.phase === 'guided'). Meet: hold while the worker
// comes to the head's side (tossing it the spare pickaxe when one is
// owed), then send it to the bore. Bore: follow the worker entity
// (GoalFollow, the follow behaviour's own movement — the body stays
// bring's), leashing it on distance. Stepback: hold in the bored tunnel
// while the worker clears the ore, then dig.
function guidedTick(bot, ctx, o, bp) {
  const g = o.guided
  if (!g || !g.target || !o.pos) { // corrupted handoff: re-walk, the stall re-delegates
    o.guided = null
    o.phase = 'walk'
    o.stalls = 0
    o.lastPos = null
    return
  }
  const now = Date.now()
  if (now - g.at >= GUIDED_TOTAL_MS) { guidedCancel(bot, ctx, o); return }
  let w = null
  try { w = worker.workerEntity(bot) } catch (_) { w = null }
  const wpos = w && w.position ? w.position : null

  if (g.phase === 'meet') {
    if (!g.held) { g.held = true; clearGoal(bot, ctx) } // head holds; the worker comes to it
    if (!wpos) {
      if (g.goneSince === null || g.goneSince === undefined) g.goneSince = now
      if (now - g.goneSince >= GUIDED_GONE_MS) { guidedCancel(bot, ctx, o); return }
    } else {
      g.goneSince = null
      if (!g.tossInFlight && d3(wpos, g.headPos) <= GUIDED_ARRIVE_D) {
        if (!g.tool) { // on the head's side now: bore from here
          sendSeq([`msg #goto ${g.target.x} ${g.target.y} ${g.target.z}`])
          g.phase = 'bore'
          g.reissuedAt = 0
          return
        }
        g.tossInFlight = true
        const tool = g.tool
        void (async () => {
          if (ctx.bring !== o) return // the order moved on: never re-task a dead job
          let lent = false
          try { await bot.toss(tool.id, null, 1); lent = true } catch (_) { /* delegate anyway */ }
          if (lent) ctx.workerTooled = true
          if (ctx.bring !== o) return
          sendSeq([`msg #goto ${g.target.x} ${g.target.y} ${g.target.z}`])
          g.phase = 'bore'
          g.reissuedAt = 0
          g.tossInFlight = false
        })()
        return
      }
    }
    if (!g.tossInFlight && now >= (g.meetUntil || 0)) {
      if (guidedSameSide(wpos, bp, o.pos)) { // on the head's side now: bore from here
        sendSeq([`msg #goto ${g.target.x} ${g.target.y} ${g.target.z}`])
        g.phase = 'bore'
        g.reissuedAt = 0
      } else { // still far: call it in again for one more window (the total bounds the wait)
        sendSeq([`msg #goto ${Math.floor(g.headPos.x)} ${Math.floor(g.headPos.y)} ${Math.floor(g.headPos.z)}`])
        g.meetUntil = now + GUIDED_TOOL_MS
      }
    }
    return
  }

  if (g.phase === 'bore') {
    if (!wpos) {
      if (g.goneSince === null || g.goneSince === undefined) g.goneSince = now
      if (now - g.goneSince >= GUIDED_GONE_MS) { guidedCancel(bot, ctx, o); return }
      return // hold the last follow goal while it is out of view
    }
    g.goneSince = null
    if (d3(wpos, g.target) <= GUIDED_ARRIVE_D) { // bored through: clear the ore, then dig
      const back = guidedStepback(g.target, o.pos)
      sendSeq(['msg #resume', `msg #goto ${back.x} ${back.y} ${back.z}`])
      g.phase = 'stepback'
      g.held = false
      return
    }
    if (!g.paused) {
      if (!g.lastWorkerPos || d3(wpos, g.lastWorkerPos) > 0.5) {
        g.lastWorkerPos = { x: wpos.x, y: wpos.y, z: wpos.z }
        g.lastMove = now
      } else if (now - (g.lastMove || g.at) >= GUIDED_STILL_MS) { guidedCancel(bot, ctx, o); return }
    }
    const d = d3(bp, wpos)
    // Both transitions restart the still clock: a 30 s+ pause must not
    // cancel the job on the first tick after resume.
    if (!g.paused && d > GUIDED_PAUSE_D) {
      g.paused = true
      g.lastMove = now
      g.lastWorkerPos = { x: wpos.x, y: wpos.y, z: wpos.z }
      try { void worker.send('msg #pause') } catch (_) { /* bridge best-effort */ }
    } else if (g.paused && d < GUIDED_RESUME_D) {
      g.paused = false
      g.lastMove = now
      g.lastWorkerPos = { x: wpos.x, y: wpos.y, z: wpos.z }
      try { void worker.send('msg #resume') } catch (_) { /* bridge best-effort */ }
    }
    const key = `bring-guided:${Math.floor(o.pos.x)},${Math.floor(o.pos.y)},${Math.floor(o.pos.z)}`
    if (key !== ctx.lastGoalKey) {
      issueGoal(bot, ctx, new goals.GoalFollow(w, GUIDED_FOLLOW_RANGE), key, true)
      g.reissuedAt = now
    } else if (now - (g.reissuedAt || 0) >= GUIDED_REISSUE_MS) {
      try { bot.pathfinder.setGoal(new goals.GoalFollow(w, GUIDED_FOLLOW_RANGE), true) } catch (_) { /* body best-effort */ }
      g.reissuedAt = now
    }
    return
  }

  // Stepback: the tunnel is bored, so a gone or still worker cannot block
  // the dig — only the total deadline still refuses. The head holds in the
  // tunnel; players have no hard collision, so the worker walks back past
  // it (a nudge at most). A truly wedged worker trips the still clock and
  // the head digs anyway — the drop race then is rare and self-healing
  // (ore gone re-finds the next vein).
  if (!g.held) { g.held = true; clearGoal(bot, ctx) } // head holds in the tunnel
  if (!wpos) { guidedToDig(bot, ctx, o); return }
  if (!g.lastWorkerPos || d3(wpos, g.lastWorkerPos) > 0.5) {
    g.lastWorkerPos = { x: wpos.x, y: wpos.y, z: wpos.z }
    g.lastMove = now
  }
  if (d3(wpos, g.target) >= GUIDED_CLEAR_D || now - (g.lastMove || g.at) >= GUIDED_STILL_MS) {
    guidedToDig(bot, ctx, o)
  }
}

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
    if (stopGuidedWork(ctx)) metrics.workerJobs.inc({ kind: 'bore', outcome: 'cancelled' })
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

  if (o.phase === 'guided') { guidedTick(bot, ctx, o, bp); return }

  if (o.phase === 'chestfetch') { chestFetch(bot, ctx, o, bp); return }

  if (o.phase === 'fill') { fillBucket(bot, ctx, o, bp); return }

  if (o.phase === 'craft') { itemMod.craftTick(bot, ctx, o); return }

  if (o.phase === 'smelt') { itemMod.smeltTick(bot, ctx, o); return }

  if (o.phase === 'find') {
    if (food) { await findFood(bot, ctx, o); return }
    if ((o.kind || 'block') === 'item') { // no diggable world form: wool hunts, else the item reason
      itemMod.refuseItemOrHunt(bot, ctx, o)
      return
    }
    if (o.searchSkipFar) { // pending far search just came up empty: skip the re-scan
      o.searchSkipFar = false
      await enterSearch(bot, ctx, o, gatedOrEmptyRefusal(o, loadedSearchRadius(bot)))
      return
    }
    // idkcraft-drq: pre-check the guard at find time, so a nearer build
    // is skipped without walking to each of its blocks first. Only
    // 'protected' and 'submerged' count here: trap rules depend on the
    // dig-time stance and are judged at the dig site, while a dive is a
    // property of the target (0u9: skipping it here lets a dry farther
    // vein win without four dives first). Each loop either commits or
    // grows o.skip, and find empties when all is skipped — it terminates.
    let res = null
    for (;;) {
      res = findNearest(bot, o.name, null, o.skip ? ((q) => o.skip.has(skipKey(q))) : null)
      // x16j r1: nothing unskipped in range — a skipped below-feet cell may
      // have become safe since (its walls mined). Re-validate before giving
      // up so a freed ore is found instead of stranded.
      if (!res && revalidateBelowFeetSkips(bot, ctx, o)) continue
      if (res === 'unknown' || !res || !res.position) break
      let pre = null
      try {
        const blk = bot.blockAt && bot.blockAt(res.position)
        pre = blk && denyReason(bot, blk, ctx)
      } catch (_) { pre = null }
      if (pre !== 'protected' && pre !== 'submerged') break
      if (pre === 'submerged') o.sawSubmerged = true
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
          await enterSearch(bot, ctx, o, gatedOrEmptyRefusal(o, loadedSearchRadius(bot)))
          return
        }
        await verdictSource(bot, ctx, o, exposedEmpty, cachedEmpty.buried)
        return
      }
      o.search = startFarSearch(bot, o.name, null, { exposedOnly: true })
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
        await enterSearch(bot, ctx, o, emptyRefusal(o, loadedSearchRadius(bot)))
        return
      }
      o.phase = 'searchfar'
      return
    }
    if (res.exposed !== false) {
      // Exposed and nearest: commit exactly as before (no rival consulted,
      // the legacy line byte-identical). The walk gate (8w0) never bites
      // here: sync-48 bounds dy, so liveExposed is non-null.
      commitSource(bot, ctx, o, liveExposed(bp, res, bot), null, 'exposed')
      return
    }
    // 48-best buried: stash it as the dig candidate (c), read the memory
    // candidate (b) — a diggable dry stash commits below (jlda.11
    // early-commit) instead of running the far shells for live exposed
    // ore (a); a gated or wet shaft still scans (atl.15).
    o.buried = buriedCand(bp, res, bot)
    // Gated shaft (chv): remember the vein for the honest refusal — the
    // verdict below then weighs exposed-or-legs with no dig in play.
    if (!o.buried) o.deepVein = deepVeinOf(bp, res)
    {
      let mem = null
      try { mem = memoryExposed(bot, ctx, bp, o.name, o.skip) } catch (_) { mem = null }
      o.memKnown = memoryInBudget(mem, o.buried)
    }
    // Gated with no dig in play (chv): like an empty find, the adopted
    // chest comes before the shells and legs (atl.14 fetch-first). A
    // feasible stash digs directly, as before.
    if (!o.buried && !o.chestTried && o.have < o.want && ctx && ctx.home && ctx.home.chest) {
      o.phase = 'chestfetch'
      return
    }
    // A cached far verdict skips the rescan (body-3): the buried stash
    // and memory above are always re-derived fresh and cheap.
    const cachedBuried = takeFarCache(bot, o, bp)
    if (cachedBuried !== undefined) {
      const exposedCached = bestExposed(cachedBuried.far, o.memKnown || null)
      if (!exposedCached && !o.buried) {
        await enterSearch(bot, ctx, o, gatedOrEmptyRefusal(o, loadedSearchRadius(bot)))
        return
      }
      await verdictSource(bot, ctx, o, exposedCached, o.buried)
      return
    }
    // jlda.11 early-commit: with a diggable dry stash in hand the
    // !search branch below commits it at once and the shells never run.
    // A gated shaft (no dig in play) or a wet one (the wet-vs-dry rule
    // needs a rival to walk to) still scans.
    o.search = (o.buried && !o.buried.wet) ? null : startFarSearch(bot, o.name, null, { exposedOnly: true })
    if (o.search === 'unknown') {
      refuse(bot, ctx, `unknown block: ${o.name}`)
      return
    }
    if (!o.search) {
      // Edge 48 (no shells) or a diggable dry stash (jlda.11
      // early-commit): decide between memory and buried now, asking the
      // model once when contested (the tick awaits bring).
      if (!o.memKnown && !o.buried) {
        await enterSearch(bot, ctx, o, gatedOrEmptyRefusal(o, loadedSearchRadius(bot)))
        return
      }
      await verdictSource(bot, ctx, o, o.memKnown, o.buried)
      return
    }
    o.phase = 'searchfar'
    return
  }

  if (o.phase === 'searchfar') {
    if (food) { await findFood(bot, ctx, o); return }
    if (!o.search) return // verdict already committed or asking: wait for it
    // The walk gate rides into the shells (atl.22): a deep exposed hit must
    // neither close a shell nor shadow a walkable vein further out.
    const r = stepFarSearch(bot, o.search, {
      exclude: o.skip ? (q) => o.skip.has(skipKey(q)) : undefined,
      gate: (q) => descentGated(bp, q),
    })
    if (!r.done) return
    o.search = null
    if (r.result === 'unknown') {
      refuse(bot, ctx, `unknown block: ${o.name}`)
      return
    }
    // Shells done: (a) live exposed wins the far result, a buried far hit
    // loses to the nearer stashed 48 hit — or stands alone when 48 was
    // empty. The verdict weighs it against the stashed memory (b). The
    // cursor ran in exposed mode, so (c) rides r.buried (the second pass
    // over the same hits); the legacy r.result branch stays for shape.
    const far = r.result && r.result.exposed !== false ? liveExposed(bp, r.result, bot) : null
    const farBuried = r.result && r.result.exposed === false ? r.result : (r.buried || null)
    const buried = o.buried || (farBuried ? buriedCand(bp, farBuried, bot) : null)
    // A far shaft the gate dropped (chv): the nearer 48 stash — when one
    // passed — already stands, so only a missing dig remembers the vein.
    if (!buried && farBuried && !o.deepVein) o.deepVein = deepVeinOf(bp, farBuried)
    // Only a gated hike out there (atl.22): the refusal names it too.
    if (!o.deepVein && r.gated) o.deepVein = deepVeinOf(bp, r.gated)
    const exposed = bestExposed(far, o.memKnown || null)
    const edge = (r && typeof r.edge === 'number') ? r.edge : loadedSearchRadius(bot)
    try {
      o.farCache = {
        x: bp.x, y: bp.y, z: bp.z, edge, hit: far,
        buriedHit: farBuried ? buriedCand(bp, farBuried, bot) : null,
      }
    } catch (_) { /* cache best-effort */ }
    if (!exposed && !buried) {
      await enterSearch(bot, ctx, o, o.have > 0 ? `only got ${o.have} ${o.drop}` : gatedOrEmptyRefusal(o, edge))
      return
    }
    await verdictSource(bot, ctx, o, exposed, buried)
    return
  }

  if (o.phase === 'walk') {
    if (food) { walkFood(bot, ctx, o, bp, grounded); return }
    const key = `bring:${o.pos.x},${o.pos.y},${o.pos.z}`
    if (key !== ctx.lastGoalKey) {
      issueGoal(bot, ctx, new goals.GoalNear(o.pos.x, o.pos.y, o.pos.z, 2), key, false)
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
        o.wedge = 0
        o.lastPos = { x: bp.x, y: bp.y, z: bp.z }
      } else if (pillarWedged(bot, o, bp, key)) {
        // jlda.13: re-path once per target; the next tick re-issues the goal
        // with a fresh stall budget, a second wedge falls to the refusal.
        try { console.log(`bring: pillar wedge at ${bp.x.toFixed(1)} ${bp.y.toFixed(1)} ${bp.z.toFixed(1)} — re-path (jlda.13)`) } catch (_) { /* logging never breaks a walk */ }
        clearGoal(bot, ctx) // resetPath drops the stuck place step and releases jump
      } else if (++o.stalls >= WALK_STALL_TICKS) {
        // Buried stalls name the vein coords (chv): the acceptance fallback
        // is an honest refusal with coords, never a silent surface trample.
        // The exposed line stays byte-identical (pinned by test). A buried
        // block stall with a worker online delegates the bore instead
        // (guided dig-in); every guided deadline falls back to this line.
        if ((o.kind || 'block') === 'block' && o.exposed === false && o.pos && guidedAvailable(bot) && guidedDelegate(bot, ctx, o, bp)) return
        refuse(bot, ctx, unreachLine(o))
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
    let bDeny = denyReason(bot, block, ctx) // idkcraft-drq: never fetch through owner builds
    if (bDeny === 'below-feet' && solidBelow(bot, o.pos) && protectedReason(bot, block, ctx) !== null) {
      // revmux 01 core-1: the trap denial masks protection (denyReason
      // returns 'below-feet' before it checks the type rules), so a
      // below-feet stance over solid may sit on a build. Unmask it: the
      // protected path skips the block instead of striking or digging.
      bDeny = 'protected'
    }
    let atl20Drop = false
    if (bDeny === 'below-feet' && solidBelow(bot, o.pos)) {
      // atl.20: the shaft-bottom loop (atl.18 5/9: selftrap → sidestep →
      // re-find the same block → walk back on top → refuse) died on this
      // denial with SOLID stone under the ore. Digging it is what a player
      // does — a safe 1-block drop onto a proven landing — so dig instead
      // of striking. Falls through to the dig below with no strike and no
      // stuck fact. The refusal stays for real hazards (air/water/lava or
      // unknown below), and the guard itself is untouched for every other
      // behaviour (equip's no-deepen rule, forage/flat skips). The block
      // itself is type-clean here (protected was unmasked above).
      try { console.log(`below-feet ${o.block} at ${Math.floor(o.pos.x)} ${Math.floor(o.pos.y)} ${Math.floor(o.pos.z)} onto solid — digging (atl.20)`) } catch (_) { /* logging never breaks a dig */ }
      atl20Drop = true // the drop lands in the hole: it becomes the stance
    } else if (bDeny) {
      logDeny(block, bDeny)
      if (bDeny === 'protected' || bDeny === 'submerged') {
        // Skip it and take the next candidate: a nearer build — or a dive
        // (0u9: also a property of the target, not the stance) — must not
        // end an order while terrain blocks exist further away. Refusal
        // happens when find comes up empty (the have>0 path delivers).
        if (bDeny === 'submerged') o.sawSubmerged = true
        if (!o.skip) o.skip = new Set()
        o.skip.add(skipKey(o.pos))
        o.pos = null
        o.phase = 'find'
        return
      }
      // Trap denial (below-feet/gravity): the stance may change, so look
      // again — but a capped number of times, or find re-picks the same
      // nearest block forever (walk flips straight back to dig).
      // idkcraft-x16j: a below-feet repeat on the SAME position means the
      // sidestep episode ran and find re-picked the same exposure anyway —
      // prod ping-ponged here until the clock died. Skip it instead of
      // re-striking: the stance episode had its chance, so the next
      // cheapest candidate wins and the order never ping-pongs. Gravity
      // stays unskipped (a falling stack is a property of the block, not
      // the stance), and the strike ceiling below still ends an order whose
      // every candidate denies.
      if (bDeny === 'below-feet' && o.belowFeetKey === skipKey(o.pos)) {
        try { console.log(`below-feet ${o.block} at ${Math.floor(o.pos.x)} ${Math.floor(o.pos.y)} ${Math.floor(o.pos.z)} skipped, taking next (x16j)`) } catch (_) { /* logging never breaks a dig */ }
        if (!o.skip) o.skip = new Set()
        o.skip.add(skipKey(o.pos))
        if (!o.bfSkip) o.bfSkip = new Set() // below-feet origin: re-validated when candidates run out (r1)
        o.bfSkip.add(skipKey(o.pos))
        o.belowFeetKey = null
        o.pos = null
        o.phase = 'find'
        return
      }
      o.denyStrikes = (o.denyStrikes || 0) + 1
      if (o.denyStrikes > 3) {
        refuse(bot, ctx, o.have > 0
          ? `only got ${o.have} ${o.drop} \u2014 could not reach ${o.block} safely`
          : `could not reach ${o.block} safely`)
        return
      }
      // atl.17: below-feet is a property of the PLACE — find re-picks the
      // same block from the same stance forever. One escape per strike via
      // stuck.request moves the stance; release() resumes ctx.bring.
      // denyStrikes stays the ceiling.
      if (bDeny === 'below-feet') {
        o.belowFeetKey = skipKey(o.pos)
        try { stuck.request(bot, ctx, 'bring', o.pos, `bring:${o.pos.x},${o.pos.y},${o.pos.z}`) } catch (_) { /* stuck best-effort */ }
      }
      o.pos = null
      o.phase = 'find'
      return
    }
    if (floodRisk(bot, block, bp, atl20Drop)) {
      // The dig would flood the stance (jlda.12): skip it like a dive —
      // a dry farther vein wins without trapping the head in the pocket.
      // Refusal happens when find comes up empty (the have>0 path delivers).
      try { console.log(`selftrap: refused dig ${block.name} at ${Math.floor(o.pos.x)} ${Math.floor(o.pos.y)} ${Math.floor(o.pos.z)} (flood-risk)`) } catch (_) { /* logging never breaks a dig */ }
      o.sawSubmerged = true
      if (!o.skip) o.skip = new Set()
      o.skip.add(skipKey(o.pos))
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
      o.belowFeetKey = null // x16j: progress clears the repeat guard too
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
      issueGoal(bot, ctx, new goals.GoalBlock(o.pos.x, o.pos.y, o.pos.z), key, false)
      return
    }
    // Reached or gave up getting there: the inventory count is the truth.
    o.have = countDrop(bot, o.drop)
    // Guided dig-in: the bore is over once the head picked up — #stop the
    // worker (it idles at its stepback); the next stall re-tasks it.
    if (o.guided && !o.guided.stopSent) stopGuidedWork(ctx)
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
    const giver = worker.players(bot)[o.by]
    const p = giver && giver.entity
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
      issueGoal(bot, ctx, new goals.GoalNear(pp.x, pp.y, pp.z, RETURN_RANGE), key, false)
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
module.exports.tierRefusal = tierRefusal
module.exports.bestPickRank = bestPickRank
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
module.exports.skipKey = skipKey
module.exports.unreachLine = unreachLine
module.exports.guidedTarget = guidedTarget
module.exports.guidedStepback = guidedStepback
module.exports.guidedSameSide = guidedSameSide
module.exports.pickSpare = pickSpare
module.exports.stopGuidedWork = stopGuidedWork
module.exports.GUIDED_TOTAL_MS = GUIDED_TOTAL_MS
module.exports.GUIDED_GONE_MS = GUIDED_GONE_MS
module.exports.GUIDED_STILL_MS = GUIDED_STILL_MS
module.exports.GUIDED_TOOL_MS = GUIDED_TOOL_MS
module.exports.GUIDED_PAUSE_D = GUIDED_PAUSE_D
module.exports.GUIDED_RESUME_D = GUIDED_RESUME_D
module.exports.GUIDED_ARRIVE_D = GUIDED_ARRIVE_D
module.exports.GUIDED_CLEAR_D = GUIDED_CLEAR_D
module.exports.bestExposed = bestExposed
module.exports.deepVeinOf = deepVeinOf
module.exports.descentGated = descentGated
module.exports.deepRefusal = deepRefusal
module.exports.goingForLine = goingForLine
module.exports.sourceText = sourceText
module.exports.verdictLine = verdictLine
module.exports.verdictFacts = verdictFacts
module.exports.choiceRes = choiceRes
module.exports.clearSearchLeg = clearSearchLeg
module.exports.enterSearch = enterSearch
module.exports.canSearch = canSearch
module.exports.canBringName = canBringName
module.exports.openPhase = openPhase
module.exports.SEARCH_BUDGET = SEARCH_BUDGET
module.exports.SELF_SEARCH_RADIUS = SELF_SEARCH_RADIUS
module.exports.SEARCH_INSTRUCTIONS = SEARCH_INSTRUCTIONS
module.exports.SEARCH_CRITERIA = SEARCH_CRITERIA
module.exports.toWoolHunt = itemMod.toWoolHunt
module.exports.toWaterFill = toWaterFill
module.exports.hasEmptyBucket = hasEmptyBucket
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
module.exports.planGap = itemMod.planGap
