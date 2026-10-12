'use strict'

// Rich stall state for plan() (idkcraft-vhlb.3): what decides a stall —
// a local voxel slice, the last attempts with outcomes, inventory, the
// current target. Built ONLY at fire time (watchdog / task plan / later
// recover.js), never per tick: it does ~245 blockAt reads. The same object
// goes to JEV and the LLM planner. Token budget: slice 245 chars of codes
// + 5 layer labels (~200 tokens), legend ~60, <=8 attempts ~100, inventory
// + target ~80: ~450 tokens, well under the 1.5k cap.

const { failReason } = require('./step')
const { countItems } = require('./perception')

const R = 3 // x/z radius -> 7 wide
const DY = 2 // layers feet-2 .. feet+2 -> 5 high
const ATTEMPTS_KEPT = 8

const LEGEND = 'x east, z south; each layer is 7 rows north->south of 7 chars west->east; layers top->bottom (dy rel. to feet); ' +
  '@ feet, a air, s solid, w water, l lava, g gravel/sand, b bed, d door, c chest, o ore, x own-placed, ? unloaded'

function code(b, key, placed) {
  if (!b) return '?'
  const n = String(b.name || '')
  if (n === 'air' || n === 'cave_air' || n === 'void_air') return 'a'
  if (placed && placed.has(key)) return 'x'
  if (n === 'water') return 'w'
  if (n === 'lava') return 'l'
  if (/_bed$/.test(n)) return 'b'
  if (/_door$|_trapdoor$|_fence_gate$/.test(n)) return 'd'
  if (n === 'chest' || n === 'trapped_chest' || n === 'barrel') return 'c'
  if (/_ore$/.test(n) || n === 'ancient_debris') return 'o'
  if (n === 'gravel' || /sand$/.test(n)) return 'g'
  if (b.boundingBox === 'empty') return 'a' // grass, torches, signs: walk-through
  return 's'
}

// Layers top->bottom: 'dy+1: row/row/...' (7 rows of 7 chars).
function voxelSlice(bot, ctx) {
  const p = bot && bot.entity && bot.entity.position
  if (!p) return null
  const Vec3 = require('vec3')
  const fx = Math.floor(p.x)
  const fy = Math.floor(p.y)
  const fz = Math.floor(p.z)
  const placed = ctx && ctx.placedByBot instanceof Set ? ctx.placedByBot : null
  const layers = []
  for (let dy = DY; dy >= -DY; dy--) {
    const rows = []
    for (let dz = -R; dz <= R; dz++) {
      let row = ''
      for (let dx = -R; dx <= R; dx++) {
        if (dx === 0 && dy === 0 && dz === 0) { row += '@'; continue }
        const x = fx + dx
        const y = fy + dy
        const z = fz + dz
        let b = null
        try { b = bot.blockAt(new Vec3(x, y, z)) } catch (_) { b = null }
        row += code(b, `${x},${y},${z}`, placed)
      }
      rows.push(row)
    }
    layers.push(`dy${dy >= 0 ? '+' : ''}${dy}: ${rows.join('/')}`)
  }
  return layers
}

// Attempt ring, appended on a step change (goal.js applyChoice), not per tick.
function recordAttempt(ctx, prevStep, bot) {
  try {
    if (!ctx || !prevStep) return
    const p = bot && bot.entity && bot.entity.position
    const from = ctx.attemptFrom
    const status = typeof ctx.stepStatus === 'string' ? ctx.stepStatus : 'running'
    const a = { step: prevStep, out: status }
    if (failReason(status) !== null) a.out = status
    if (p && from) a.moved = [Math.round(p.x - from.x), Math.round(p.y - from.y), Math.round(p.z - from.z)]
    if (!Array.isArray(ctx.attempts)) ctx.attempts = []
    ctx.attempts.push(a)
    while (ctx.attempts.length > ATTEMPTS_KEPT) ctx.attempts.shift()
  } catch (_) { /* attempts best-effort */ }
}

function markAttemptStart(ctx, bot) {
  try {
    const p = bot && bot.entity && bot.entity.position
    ctx.attemptFrom = p ? { x: p.x, y: p.y, z: p.z } : null
  } catch (_) { /* best-effort */ }
}

const TIERS = ['netherite', 'diamond', 'iron', 'stone', 'golden', 'wooden']
function bestTier(bot, tool) {
  for (const t of TIERS) if (countItems(bot, (n) => n === `${t}_${tool}`) > 0) return t
  return 'none'
}

function inventory(bot) {
  const c = (re) => countItems(bot, (n) => re.test(n))
  return {
    pickaxe: bestTier(bot, 'pickaxe'),
    axe: bestTier(bot, 'axe'),
    sword: bestTier(bot, 'sword'),
    logs: c(/_log$/),
    planks: c(/_planks$/),
    cobble: c(/^(cobblestone|cobbled_deepslate)$/),
    coal: c(/^(coal|charcoal)$/),
    iron: c(/^(raw_iron|iron_ingot)$/),
    torches: c(/^torch$/),
    food: c(/^(bread|cooked_.*|apple|carrot|baked_potato|golden_carrot)$/),
    beds: c(/_bed$/),
  }
}

// What the current step is heading for: the pathfinder goal when set, else
// the active castle/home site. offset = target - bot (dx, dy, dz).
function target(bot, ctx) {
  const p = bot && bot.entity && bot.entity.position
  let t = null
  try { t = (bot.pathfinder && bot.pathfinder.goal) || null } catch (_) { t = null }
  let at = 'path-goal'
  if (!t || typeof t.x !== 'number') {
    const st = ctx && ((ctx.castle && ctx.castle.site) || (ctx.home && ctx.home.site))
    t = st && typeof st.x === 'number' ? st : null
    at = 'site'
  }
  const step = (ctx && ctx.step) || null
  if (!p || !t) return { step, at: null }
  return { step, at, offset: [Math.round(t.x - p.x), typeof t.y === 'number' ? Math.round(t.y - p.y) : 0, Math.round(t.z - p.z)] }
}

// The one entry point: a plain JSON-safe object, every part best-effort.
function stallState(bot, ctx) {
  const out = {}
  try { const v = voxelSlice(bot, ctx); if (v) { out.world = v; out.world_legend = LEGEND } } catch (_) { /* skip */ }
  try { out.attempts = Array.isArray(ctx && ctx.attempts) ? ctx.attempts.slice(-ATTEMPTS_KEPT) : [] } catch (_) { /* skip */ }
  try { out.inventory = inventory(bot) } catch (_) { /* skip */ }
  try { out.target = target(bot, ctx) } catch (_) { /* skip */ }
  return out
}

module.exports = { stallState, voxelSlice, recordAttempt, markAttemptStart, inventory, LEGEND, ATTEMPTS_KEPT }
