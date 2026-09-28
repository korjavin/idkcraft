'use strict'

// build: lay the house plank by plank (bead rw4.4, two blueprints since jr2.1).
//
// v1 (BLUEPRINT, frozen): the 4x4 hut old prod houses were built from —
// walls 2 high, flat roof, interior 2x2, door in the north wall at
// (1,0,0), workbench OUTSIDE at the east wall (4,0,1). Adopted houses keep
// repairing from this plan; nothing new is founded on it.
//
// v2 (BLUEPRINT_V2): the 7x6 house (dx 0..6, dz 0..5) — common room-kitchen
// (x1..5, z1..2: table, chest, furnace, torch, free 2x2, door path) plus
// two bedrooms behind a partition (openings at (2,3) and (4,3), beds land
// in jr2.2):
//
//   y=2  roof: full 7x6 (42 planks)
//   y=1  wall ring (21 planks; the door upper half at (3,1,0) is placed by
//        the server together with the lower half, so it is not in the plan)
//   y=0  wall ring (21 planks) + door lower half at (3,0,0)
//        workbench INSIDE the common room at (5,0,1)
//   y=0..1 partition posts (1,3),(3,3),(5,3) + bedroom divider (3,4)
//        (8 planks, laid last)
//
// Both plans are in LAY ORDER: table first (crafting precedes walls — the
// door is crafted at the table while it still stands on open ground), then
// the lower ring, the door, the upper ring, the roof, then (v2) the
// partition. Every ring sits on the previous one, so the block below is
// always the place reference.
//
// One behaviour tick advances at most one async place flight (guarded by
// ctx.placeInFlight, same seam as eatInFlight/doEat). Materials are checked
// BEFORE walking: a missing item reports failed:no-planks and the arbiter
// sends the bot back to gather/craft for the next batch.

const Vec3 = require('vec3')
const { denyReason, logDeny } = require('./util')
const { goals } = require('mineflayer-pathfinder')

const PLACE_RANGE = 4 // GoalPlaceBlock range for the approach
// Reach check: head (eyes) to cell CENTRE. GoalPlaceBlock.isEnd measures
// head-to-face-centre <= PLACE_RANGE; the clicked face centre sits up to
// ~1 off the cell centre and the float head up to ~0.9 off the
// pathfinder's node-centred head, so range + 1.5 accepts every valid end
// node. Feet-to-corner over-measured by ~2 on slopes (the +1.6 head, the
// corner vs the centre) and livelocked: goal reached, check 'far', reset,
// setGoal into an already-reached goal — 2/94 forever (idkcraft-jr2.4).
const PLACE_REACH = PLACE_RANGE + 1.5

// Plan entry: cell offset from the home origin (SW corner, ground level)
// plus what belongs there.
const BLUEPRINT = (() => {
  const plan = [{ dx: 4, dy: 0, dz: 1, kind: 'table' }]
  const ring = (dy) => {
    for (const dx of [0, 2, 3]) plan.push({ dx, dy, dz: 0, kind: 'planks' })
    for (const dx of [0, 1, 2, 3]) plan.push({ dx, dy, dz: 3, kind: 'planks' })
    for (const dz of [1, 2]) {
      plan.push({ dx: 0, dy, dz, kind: 'planks' })
      plan.push({ dx: 3, dy, dz, kind: 'planks' })
    }
  }
  ring(0)
  plan.push({ dx: 1, dy: 0, dz: 0, kind: 'door' })
  ring(1)
  for (let dz = 0; dz < 4; dz++) {
    for (let dx = 0; dx < 4; dx++) plan.push({ dx, dy: 2, dz, kind: 'planks' })
  }
  return plan
})()

const BLUEPRINT_V2 = (() => {
  const plan = [{ dx: 5, dy: 0, dz: 1, kind: 'table' }]
  const ring = (dy) => {
    for (const dx of [0, 1, 2, 4, 5, 6]) plan.push({ dx, dy, dz: 0, kind: 'planks' })
    for (let dx = 0; dx <= 6; dx++) plan.push({ dx, dy, dz: 5, kind: 'planks' })
    for (let dz = 1; dz <= 4; dz++) {
      plan.push({ dx: 0, dy, dz, kind: 'planks' })
      plan.push({ dx: 6, dy, dz, kind: 'planks' })
    }
  }
  ring(0)
  plan.push({ dx: 3, dy: 0, dz: 0, kind: 'door' })
  ring(1)
  for (let dz = 0; dz <= 5; dz++) {
    for (let dx = 0; dx <= 6; dx++) plan.push({ dx, dy: 2, dz, kind: 'planks' })
  }
  for (const dy of [0, 1]) {
    for (const [dx, dz] of [[1, 3], [3, 3], [5, 3], [3, 4]]) {
      plan.push({ dx, dy, dz, kind: 'planks' })
    }
  }
  return plan
})()

const PLANK_COUNT = BLUEPRINT.filter((c) => c.kind === 'planks').length
const PLANK_COUNT_V2 = BLUEPRINT_V2.filter((c) => c.kind === 'planks').length

// Blueprint by home version (jr2.1): v2 homes build the 7x6 house, anything
// else (v1, or a home that predates the version mark) the frozen 4x4 plan.
function blueprintFor(home) {
  return home && home.v === 2 ? BLUEPRINT_V2 : BLUEPRINT
}

// Blocks the place flow is allowed to clear: a refusal usually means grass
// or a flower grew into the cell. Anything else is left alone.
const REPLACEABLE = new Set([
  'short_grass', 'tall_grass', 'fern', 'large_fern', 'dead_bush', 'snow',
  'torch', 'vine', 'glow_lichen', 'poppy', 'dandelion', 'oxeye_daisy',
  'cornflower', 'azure_bluet', 'allium',
])

function isReplaceable(name) {
  return typeof name === 'string' && (REPLACEABLE.has(name) || name.endsWith('_tulip'))
}

function cellAbs(home, cell) {
  return new Vec3(home.site.x + cell.dx, home.site.y + cell.dy, home.site.z + cell.dz)
}

// Blueprint invariant (8si): the doorway column and the living rooms are
// never plank targets — planks walled in there break adopt and churn the
// rebuild. Checked for planks cells before every placement, not just at
// plan authorship. v1: doorway (dx 1, dz 0, both halves) + the 2x2
// interior; v2: doorway (dx 3, dz 0) + common room + partition openings +
// bedrooms (the partition posts themselves are legit targets).
function isDoorwayOrInterior(cell, home) {
  if (!cell || typeof cell.dx !== 'number') return false
  if (home && home.v === 2) {
    if (cell.dy > 1) return false // the roof above is always legit
    if (cell.dx === 3 && cell.dz === 0) return true
    if (cell.dx >= 1 && cell.dx <= 5 && cell.dz >= 1 && cell.dz <= 2) return true
    if ((cell.dx === 2 || cell.dx === 4) && cell.dz === 3) return true
    if (cell.dz === 4 && ((cell.dx >= 1 && cell.dx <= 2) || (cell.dx >= 4 && cell.dx <= 5))) return true
    return false
  }
  // Doorway column is the two wall heights only: the roof above the door
  // (dy 2) is a legit planks cell.
  if (cell.dx === 1 && cell.dz === 0 && cell.dy <= 1) return true
  return cell.dx >= 1 && cell.dx <= 2 && cell.dz >= 1 && cell.dz <= 2 && cell.dy <= 1
}

function blockNameAt(bot, p) {
  try {
    const b = bot.blockAt(p)
    return b && typeof b.name === 'string' ? b.name : null
  } catch (_) {
    return null
  }
}

function cellDone(bot, home, cell) {
  const name = blockNameAt(bot, cellAbs(home, cell))
  if (name == null) return false
  if (cell.kind === 'table') return name === 'crafting_table'
  if (cell.kind === 'door') return name.endsWith('_door')
  return name.endsWith('_planks')
}

// First plan entry (in lay order) that still needs placing, skipping cells
// already given up on (ctx.buildSkip). Returns the blueprint index, or -1
// when every remaining cell is in place.
function nextCellIdx(bot, home, skipped) {
  const skip = new Set(Array.isArray(skipped) ? skipped : [])
  const plan = blueprintFor(home)
  for (let i = 0; i < plan.length; i++) {
    if (skip.has(i)) continue
    if (!cellDone(bot, home, plan[i])) return i
  }
  return -1
}

// Remaining loose planks to lay (door/table need items, not planks). Without
// a home there is no origin to scan from, so the whole wall+roof count.
function countRemainingPlanks(bot, home, skipped) {
  if (!home || !home.site) return PLANK_COUNT_V2 // a future site is founded v2
  const skip = new Set(Array.isArray(skipped) ? skipped : [])
  const plan = blueprintFor(home)
  let n = 0
  for (let i = 0; i < plan.length; i++) {
    if (plan[i].kind !== 'planks' || skip.has(i)) continue
    if (!cellDone(bot, home, plan[i])) n++
  }
  return n
}

function findItem(bot, pred) {
  try {
    const items = bot.inventory.items()
    if (Array.isArray(items)) {
      for (const item of items) {
        if (item && typeof item.name === 'string' && pred(item.name)) return item
      }
    }
  } catch (_) { /* no inventory: no item */ }
  return null
}

function wantItem(cell) {
  if (cell.kind === 'table') return (n) => n === 'crafting_table'
  if (cell.kind === 'door') return (n) => n.endsWith('_door')
  return (n) => n.endsWith('_planks')
}

// Neighbor scan order: below first — every plan cell sits on the previous
// layer by construction, so the reference is almost always the ground or
// our own earlier cell.
const REF_DIRS = [
  [0, -1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0],
]

// The reference is a real Block, not a position: bot.placeBlock derefs
// referenceBlock.position on the first line, so a bare Vec3 rejects every
// placement (live bug: a whole site skipped as refused-on-air).
function findRef(bot, p) {
  for (const [ox, oy, oz] of REF_DIRS) {
    const q = new Vec3(p.x + ox, p.y + oy, p.z + oz)
    let block = null
    try {
      block = bot.blockAt(q)
    } catch (_) { /* treat as open */ }
    if (block && block.name !== 'air' && block.boundingBox !== 'empty' &&
        !block.name.endsWith('_door') && block.name !== 'crafting_table') {
      return { ref: block, face: new Vec3(-ox, -oy, -oz) }
    }
  }
  return null
}

// Own-home guard (cww, 8si, narrowed cjq): the GoalPlaceBlock approach
// paths through our own walls with canDig (movements default) and eats a
// corner — then the rebuild takes priority by lay order and the roof never
// starts (the prod 23/40<->24/40 flap). Live the approach also ate the oak
// door, which broke adopt (no door near spawn) and each rebuild drifted
// fresh walls over the old doorway. So the executor must not break the
// house — but only the house: the old session-global id ban (every
// *_planks/*_door/crafting_table anywhere, for every behaviour) also locked
// the planner out of digging stray planks far from home, which funnels
// paths into the guarded corners the 4ac filter then has to route around.
// blocksCantBreak is id-global by lib design, so the box lives in
// exclusionAreasBreak instead: 100 inside the blueprint box for guarded
// kinds, 0 outside. Refreshed on movements swap or home move (the old
// closure is detached); a missing movements, exclusion list or home
// degrades to no guard, never a throw.
function guardOwnWalls(bot, ctx) {
  try {
    const mov = bot && bot.pathfinder && bot.pathfinder.movements
    if (!mov || !Array.isArray(mov.exclusionAreasBreak)) return
    const home = ctx && ctx.home
    const site = home && home.site
    if (!site || typeof site.x !== 'number') return
    const key = `${site.x},${site.y},${site.z}`
    if (ctx.buildGuardedMov === mov && ctx.buildGuardKey === key) return
    if (ctx.buildGuardFn) {
      const prev = ctx.buildGuardedMov
      if (prev && Array.isArray(prev.exclusionAreasBreak)) {
        prev.exclusionAreasBreak = prev.exclusionAreasBreak.filter((f) => f !== ctx.buildGuardFn)
      }
      if (prev !== mov) {
        mov.exclusionAreasBreak = mov.exclusionAreasBreak.filter((f) => f !== ctx.buildGuardFn)
      }
      ctx.buildGuardFn = null
    }
    const byName = (bot.registry && bot.registry.blocksByName) || {}
    const ids = new Set()
    for (const name of Object.keys(byName)) {
      const entry = byName[name]
      if (typeof name !== 'string' || !entry || typeof entry.id !== 'number') continue
      if (name.endsWith('_planks') || name.endsWith('_door') || name === 'crafting_table') {
        ids.add(entry.id)
      }
    }
    if (ids.size === 0) return
    const v2 = home && home.v === 2
    const box = v2
      ? { x0: site.x, x1: site.x + 6, y0: site.y, y1: site.y + 2, z0: site.z, z1: site.z + 5 }
      : { x0: site.x, x1: site.x + 4, y0: site.y, y1: site.y + 2, z0: site.z, z1: site.z + 3 }
    const idOf = (b) => {
      if (b && typeof b.type === 'number') return b.type
      const e = b && byName[b.name]
      return e && typeof e.id === 'number' ? e.id : -1
    }
    const fn = (block) => {
      try {
        if (!ids.has(idOf(block))) return 0
        const q = block && block.position
        if (!q) return 0
        return (q.x >= box.x0 && q.x <= box.x1 && q.y >= box.y0 && q.y <= box.y1 &&
          q.z >= box.z0 && q.z <= box.z1) ? 100 : 0
      } catch (_) { return 0 }
    }
    mov.exclusionAreasBreak.push(fn)
    ctx.buildGuardFn = fn
    ctx.buildGuardedMov = mov
    ctx.buildGuardKey = key
  } catch (_) { /* best-effort: approach still walks */ }
}

function skipCell(ctx, idx, p, why) {
  if (!Array.isArray(ctx.buildSkip)) ctx.buildSkip = []
  if (!ctx.buildSkip.includes(idx)) ctx.buildSkip.push(idx)
  ctx.buildFails = 0
  console.log(`build skip ${p.x} ${p.y} ${p.z} after 3 refusals (${why})`)
}

function build(bot, ctx, target, state) {
  if (!ctx.buildSkip) ctx.buildSkip = []
  // First build step without a home: default the site to world spawn
  // (goal.js siteFor; the owner moves it with 'build here').
  if (!ctx.home) {
    const goal = require('../goal')
    try {
      ctx.home = goal.siteFor(bot, bot.spawnPoint)
    } catch (_) {
      ctx.home = null
    }
    ctx.buildSkip = []
    ctx.buildFails = 0
    ctx.buildFailIdx = -1
  }
  if (ctx.placeInFlight) return
  if (!ctx.home) return
  guardOwnWalls(bot, ctx)
  // Claim the table coords the moment the workbench stands (see makeHome):
  // another table placed here earlier (or by anyone) counts the same.
  if (!ctx.home.table && cellDone(bot, ctx.home, blueprintFor(ctx.home)[0])) {
    const t = blueprintFor(ctx.home)[0]
    ctx.home.table = new Vec3(ctx.home.site.x + t.dx, ctx.home.site.y + t.dy, ctx.home.site.z + t.dz)
  }

  const idx = nextCellIdx(bot, ctx.home, ctx.buildSkip)
  if (idx === -1) {
    ctx.home.built = true
    ctx.stepStatus = 'done'
    const s = ctx.home.site
    try { bot.chat(`home done at ${s.x} ${s.y} ${s.z}`) } catch (_) { /* chat best-effort */ }
    return
  }
  const plan = blueprintFor(ctx.home)
  const cell = plan[idx]
  const p = cellAbs(ctx.home, cell)
  if (cell.kind === 'planks' && isDoorwayOrInterior(cell, ctx.home)) {
    skipCell(ctx, idx, p, 'doorway-interior')
    return
  }

  // Progress line, at most one per 10 s.
  const total = plan.length
  let wrong = 0
  for (let i = 0; i < total; i++) {
    if (!ctx.buildSkip.includes(i) && !cellDone(bot, ctx.home, plan[i])) wrong++
  }
  const now = Date.now()
  if (now - (ctx.buildLastProgressLog || 0) >= 10000) {
    ctx.buildLastProgressLog = now
    try { bot.chat(`building ${total - wrong}/${total}`) } catch (_) { /* chat best-effort */ }
  }

  const item = findItem(bot, wantItem(cell))
  if (!item) {
    ctx.stepStatus = 'failed:no-planks'
    return
  }

  if (ctx.buildFailIdx !== idx) {
    ctx.buildFailIdx = idx
    ctx.buildFails = 0
  }

  let moving = false
  try { moving = bot.pathfinder.isMoving() } catch (_) { /* treat as arrived */ }
  if (ctx.buildGoalIdx !== idx) {
    // (Re)approach: GoalPlaceBlock walks into place range of the cell.
    // When the walk ends (!isMoving) the flight below places.
    ctx.buildGoalIdx = idx
    try { bot.pathfinder.setGoal(new goals.GoalPlaceBlock(p, bot.world, { range: PLACE_RANGE })) } catch (_) { /* retry next tick */ }
    return
  }
  if (moving) return

  // At the cell (or the walk never started): place — but only in reach.
  // A preemption that carried the body away (fight, flee, lead, follow me)
  // leaves a stale buildGoalIdx: attempting from out there burns refusals
  // and skips a good cell, so force a fresh approach instead. Counted like
  // a refusal: a cell the walk can never reach ends skipped, not looping.
  try {
    const bp = bot.entity && bot.entity.position
    if (bp && typeof bp.x === 'number' &&
        Math.hypot(bp.x - (p.x + 0.5), (bp.y + 1.6) - (p.y + 0.5), bp.z - (p.z + 0.5)) > PLACE_REACH) {
      ctx.buildFails = (ctx.buildFails || 0) + 1
      if (ctx.buildFails >= 3) skipCell(ctx, idx, p, 'unreachable')
      else ctx.buildGoalIdx = -1
      return
    }
  } catch (_) { /* unverifiable: attempt anyway */ }
  if (cellDone(bot, ctx.home, cell)) return // lagged double-place guard
  let ref
  if (cell.kind === 'door') {
    // Doors hang on the block below, face up.
    let below = null
    try {
      below = bot.blockAt(new Vec3(p.x, p.y - 1, p.z))
    } catch (_) { /* treat as open */ }
    if (below && below.position) ref = { ref: below, face: new Vec3(0, 1, 0) }
  } else {
    ref = findRef(bot, p)
  }
  if (!ref) {
    // Nothing solid to build against: while still arriving this is
    // transient, but after three ticks the cell is unplaceable — count it
    // like a refusal so the skip escape applies instead of looping forever.
    if (ctx.buildFailIdx !== idx) {
      ctx.buildFailIdx = idx
      ctx.buildFails = 0
    }
    ctx.buildFails = (ctx.buildFails || 0) + 1
    if (ctx.buildFails >= 3) skipCell(ctx, idx, p, 'no-ref')
    else ctx.buildGoalIdx = -1
    return
  }

  ctx.placeInFlight = true
  const fails = () => ctx.buildFails || 0
  ;(async () => {
    try {
      await bot.equip(item, 'hand')
      await bot.placeBlock(ref.ref, ref.face)
      ctx.buildFails = 0
    } catch (err) {
      ctx.buildFails = fails() + 1
      const occupier = blockNameAt(bot, p)
      if (occupier != null && (occupier === 'crafting_table' || occupier.endsWith('_door') || occupier.endsWith('_planks'))) {
        ctx.buildFails = 0 // landed while we walked: someone (us) placed it
      } else if (occupier != null && occupier !== 'air' && isReplaceable(occupier)) {
        let cell = null
        try { cell = bot.blockAt(p) } catch (_) { cell = null }
        const clearDeny = cell && denyReason(bot, cell, ctx)
        if (clearDeny) {
          logDeny(cell, clearDeny) // idkcraft-drq: never clear foreign torches to build
        } else {
          try {
            await bot.dig(cell || bot.blockAt(p))
            await bot.equip(item, 'hand')
            await bot.placeBlock(ref.ref, ref.face)
            ctx.buildFails = 0
          } catch (_) {
            ctx.buildFails = fails() + 1
          }
        }
      }
      if (fails() >= 3) skipCell(ctx, idx, p, occupier || 'refused')
    } finally {
      ctx.placeInFlight = false
    }
  })().catch(() => { ctx.placeInFlight = false })
}

module.exports = build
module.exports.findRef = findRef
module.exports.isReplaceable = isReplaceable
module.exports.guardOwnWalls = guardOwnWalls
module.exports.BLUEPRINT = BLUEPRINT
module.exports.BLUEPRINT_V2 = BLUEPRINT_V2
module.exports.PLANK_COUNT = PLANK_COUNT
module.exports.PLANK_COUNT_V2 = PLANK_COUNT_V2
module.exports.blueprintFor = blueprintFor
module.exports.isDoorwayOrInterior = isDoorwayOrInterior
module.exports.nextCellIdx = nextCellIdx
module.exports.countRemainingPlanks = countRemainingPlanks
module.exports.cellDone = cellDone
module.exports.PLACE_RANGE = PLACE_RANGE
module.exports.PLACE_REACH = PLACE_REACH
