'use strict'

// build: lay the epic rw4 house plank by plank (bead rw4.4).
//
// The house is a 4x4 outer shell, walls 2 high, flat roof, interior 2x2,
// door in the north wall, workbench OUTSIDE at the east wall:
//
//   y=2  roof: full 4x4 (16 planks)
//   y=1  wall ring (11 planks; the door upper half at (1,1,0) is placed by
//        the server together with the lower half, so it is not in the plan)
//   y=0  wall ring (11 planks) + door lower half at (1,0,0)
//        workbench at (4,0,1) — outside, so the bot crafts before moving in
//
// BLUEPRINT is the plan in LAY ORDER: table first (crafting precedes walls),
// then the lower ring, the door, the upper ring, the roof. Every ring sits
// on the previous one, so the block below is always the place reference.
//
// One behaviour tick advances at most one async place flight (guarded by
// ctx.placeInFlight, same seam as eatInFlight/doEat). Materials are checked
// BEFORE walking: a missing item reports failed:no-planks and the arbiter
// sends the bot back to gather/craft for the next batch.

const Vec3 = require('vec3')
const { goals } = require('mineflayer-pathfinder')

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

const PLANK_COUNT = BLUEPRINT.filter((c) => c.kind === 'planks').length

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
  for (let i = 0; i < BLUEPRINT.length; i++) {
    if (skip.has(i)) continue
    if (!cellDone(bot, home, BLUEPRINT[i])) return i
  }
  return -1
}

// Remaining loose planks to lay (door/table need items, not planks). Without
// a home there is no origin to scan from, so the whole wall+roof count.
function countRemainingPlanks(bot, home, skipped) {
  if (!home || !home.site) return PLANK_COUNT
  const skip = new Set(Array.isArray(skipped) ? skipped : [])
  let n = 0
  for (let i = 0; i < BLUEPRINT.length; i++) {
    if (BLUEPRINT[i].kind !== 'planks' || skip.has(i)) continue
    if (!cellDone(bot, home, BLUEPRINT[i])) n++
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
    if (block && block.name !== 'air' && block.boundingBox !== 'empty') {
      return { ref: block, face: new Vec3(-ox, -oy, -oz) }
    }
  }
  return null
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

  const idx = nextCellIdx(bot, ctx.home, ctx.buildSkip)
  if (idx === -1) {
    ctx.home.built = true
    ctx.stepStatus = 'done'
    const s = ctx.home.site
    try { bot.chat(`home done at ${s.x} ${s.y} ${s.z}`) } catch (_) { /* chat best-effort */ }
    return
  }
  const cell = BLUEPRINT[idx]
  const p = cellAbs(ctx.home, cell)

  // Progress line, at most one per 10 s.
  const total = BLUEPRINT.length
  let wrong = 0
  for (let i = 0; i < total; i++) {
    if (!ctx.buildSkip.includes(i) && !cellDone(bot, ctx.home, BLUEPRINT[i])) wrong++
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
    try { bot.pathfinder.setGoal(new goals.GoalPlaceBlock(p, bot.world, { range: 4 })) } catch (_) { /* retry next tick */ }
    return
  }
  if (moving) return

  // At the cell (or the walk never started): place.
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
    // Nothing solid to build against yet (still arriving): re-approach.
    ctx.buildGoalIdx = -1
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
        try {
          await bot.dig(bot.blockAt(p))
          await bot.equip(item, 'hand')
          await bot.placeBlock(ref.ref, ref.face)
          ctx.buildFails = 0
        } catch (_) {
          ctx.buildFails = fails() + 1
        }
      }
      if (fails() >= 3) skipCell(ctx, idx, p, occupier || 'refused')
    } finally {
      ctx.placeInFlight = false
    }
  })().catch(() => { ctx.placeInFlight = false })
}

module.exports = build
module.exports.BLUEPRINT = BLUEPRINT
module.exports.PLANK_COUNT = PLANK_COUNT
module.exports.nextCellIdx = nextCellIdx
module.exports.countRemainingPlanks = countRemainingPlanks
module.exports.cellDone = cellDone
