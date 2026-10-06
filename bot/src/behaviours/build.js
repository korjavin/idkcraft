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
//   y=-1 bedroom floor (1c4): ground-fill under the four bed halves
//        (1,4),(2,4),(4,4),(5,4) plus the doorway (3,0) — the door hangs
//        on the block below like a bed. Done means SOLID ground (dirt
//        counts), so flat sites place nothing and only dips take a plank.
//
// Both plans are in LAY ORDER: table first (crafting precedes walls — the
// door is crafted at the table while it still stands on open ground), then
// (v2) the bedroom floor like a foundation, the lower ring, the door, the
// upper ring, the roof, then (v2) the partition. Every ring sits on the
// previous one, so the block below is always the place reference.
//
// One behaviour tick advances at most one async place flight (guarded by
// ctx.placeInFlight, same seam as eatInFlight/doEat). Materials are checked
// BEFORE walking: a missing item reports failed:no-planks and the arbiter
// sends the bot back to gather/craft for the next batch.

const Vec3 = require('vec3')
const { denyReason, logDeny } = require('./util')
const { goals } = require('mineflayer-pathfinder')
const stuck = require('../stuck')

const PLACE_RANGE = 4 // GoalPlaceBlock range for the approach
const FAR_PROGRESS = 1 // blocks of approach shortening that forgive a far reset (revmux 01 major)
// Per-cell attempt budget (idkcraft-ipn.10): refusals are not the only way a
// cell stalls — a wedged executor (moving forever), a hung place flight, or
// a success-without-effect cycle never touch buildFails, and prod looped one
// fill cell 316 min ('building 98/99'). Ticks on one cell without progress
// (no advance past the max cell, no displacement past CELL_PROGRESS) skip it
// like a refusal. 120 ticks ≈ 2 min — a healthy cell places in <30 (A*
// replan gaps ~20, flights settle in seconds); genuine approach walks
// displace and never trip it.
const CELL_TICK_BUDGET = 120
const CELL_PROGRESS = 1
// Hard per-cell cap (revmux 01 core-3): displacement forgiveness cannot tell
// an approach from an oscillation, and a back-and-forth re-approach would
// reset the stall budget forever. 600 ticks ≈ 10 min bound every shape of
// the loop — a 230-block death-walkback (~4 min) still fits — and with the
// 1h skip retry a false skip re-probes instead of fossilizing.
const CELL_HARD_CAP = 600
// Hung own-flight deadline (craft-timeout precedent): a place flight that
// never settles wedges every later tick on the placeInFlight early-return.
// Only build's own flights carry the stamp — a foreign (beds/light) flight
// holds the step as today.
const FLIGHT_TIMEOUT_MS = 30000
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
  // Bedroom floor (idkcraft-1c4): ground-fill under the jr2.2 bed halves
  // plus the doorway — the v2 bedrooms used to sit on raw terrain and a
  // dip stranded bed placement (rig-proven: air under A-foot); the door
  // hangs on the block below like a bed, so its dip strands it the same
  // way (rig-proven: air under (3,0) refused the door 3x). Bed cells
  // pinned to beds.cellsOf.
  for (const [dx, dz] of [[1, 4], [2, 4], [4, 4], [5, 4], [3, 0]]) {
    plan.push({ dx, dy: -1, dz, kind: 'fill' })
  }
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
// g0z.22: the 1.21.5+ ground flora (leaf litter, wildflowers, bushes, dry
// grasses) plus the older tall flowers; sweet_berry_bush stays out
// (thorns, often a player farm).
const REPLACEABLE = new Set([
  'short_grass', 'tall_grass', 'fern', 'large_fern', 'dead_bush', 'snow',
  'torch', 'vine', 'glow_lichen', 'poppy', 'dandelion', 'oxeye_daisy',
  'cornflower', 'azure_bluet', 'allium',
  'leaf_litter', 'wildflowers', 'bush', 'firefly_bush',
  'short_dry_grass', 'tall_dry_grass', 'pink_petals',
  'blue_orchid', 'lily_of_the_valley', 'sunflower', 'lilac',
  'rose_bush', 'peony', 'golden_dandelion', 'cactus_flower',
])

function isReplaceable(name) {
  return typeof name === 'string' && (REPLACEABLE.has(name) || name.endsWith('_tulip'))
}

// Ground a bed can stand on (idkcraft-1c4 floor rule): anything solid.
// Air-like, water and flora take a plank patch; lava reads missing too —
// the placement refuses, the cell skips after 3, and the beds step fails
// loud instead of burning a patch.
function isSolidGround(name) {
  if (typeof name !== 'string') return false
  if (name === 'air' || name === 'cave_air' || name === 'void_air') return false
  if (name === 'water' || name === 'lava') return false
  return !isReplaceable(name)
}

// Collision half of the floor rule (revmux 01 core-1/body-1): the name
// rule cannot enumerate every flora (mushrooms, lilies, carpets...), but
// everything without collision shares the empty bounding box — the same
// solidity signal findRef uses. Unreadable reads missing, never done.
function hasCollision(bot, p) {
  try {
    const b = bot.blockAt(p)
    return !!b && b.boundingBox !== 'empty'
  } catch (_) { return false }
}

// A fill dip can hold unlisted flora the name rule never heard of: any
// NAMED block without collision clears like flora so the patch lands
// (air-likes and water are placeable as-is and never need a dig). Walls
// keep the strict REPLACEABLE allowlist.
function clearableFillGround(bot, p, cell) {
  if (!cell || cell.kind !== 'fill') return false
  try {
    const b = bot.blockAt(p)
    if (!b || typeof b.name !== 'string') return false
    if (b.name === 'air' || b.name === 'cave_air' || b.name === 'void_air' || b.name === 'water') return false
    return b.boundingBox === 'empty'
  } catch (_) { return false }
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

// A wall/door/partition/roof cell of the home's plan (d7i): the equip step
// never drops its station there (rig: it landed in the doorway and the door
// could never be placed). The table cell is excluded — any table there IS
// the home table — and fill cells sit below ground.
function isPlanCell(home, x, y, z) {
  try {
    if (!home || !home.site) return false
    const s = home.site
    return blueprintFor(home).some((c) => c.kind !== 'table' && c.kind !== 'fill' &&
      s.x + c.dx === x && s.y + c.dy === y && s.z + c.dz === z)
  } catch (_) { return false }
}

function blockNameAt(bot, p) {
  try {
    const b = bot.blockAt(p)
    return b && typeof b.name === 'string' ? b.name : null
  } catch (_) {
    return null
  }
}

// 45j: the chunk under the cell is loaded — mineflayer answers null for an
// unloaded chunk. Unloaded cells read as undone, which is not the same as
// known-missing. A throwing read stays on the old (loaded) path.
function cellLoaded(bot, home, cell) {
  try {
    return bot.blockAt(cellAbs(home, cell)) !== null
  } catch (_) {
    return true
  }
}

function cellDone(bot, home, cell) {
  const name = blockNameAt(bot, cellAbs(home, cell))
  if (name == null) return false
  if (cell.kind === 'table') return name === 'crafting_table'
  if (cell.kind === 'door') return name.endsWith('_door')
  if (cell.kind === 'fill') return isSolidGround(name) && hasCollision(bot, cellAbs(home, cell))
  return name.endsWith('_planks')
}

// Done means placed (idkcraft-vmzq.10): every plan cell physically in
// place, skips ignored. nextCellIdx===-1 alone counts given-up cells as
// done — the prod house reported 'home done' over 30 skipped cells (whole
// no-ref rows on an unvalidated shore site) and the oracle scored a false
// PASS. All three verdict sites (build's own done branch, the index.js
// stale-built revalidation, setComehome's silent flip) gate on this; the
// world wins over the bookkeeping, so a stale skip over a placed cell
// still reads complete. Doorway/interior plank cells are not holes (8si):
// the invariant forbids placing there, so a correctly empty one reads
// complete — a corrupt plan entry must skip, not brick the house.
function isComplete(bot, home) {
  try {
    const plan = blueprintFor(home)
    for (const cell of plan) {
      if (cell.kind === 'planks' && isDoorwayOrInterior(cell, home)) continue
      if (!cellDone(bot, home, cell)) return false
    }
    return true
  } catch (_) { return false }
}

// First plan entry (in lay order) that still needs placing, skipping cells
// already given up on (ctx.buildSkip). Returns the blueprint index, or -1
// when every remaining cell is in place.
function nextCellIdx(bot, home, skipped) {
  const skip = new Set(Array.isArray(skipped) ? skipped : [])
  const plan = blueprintFor(home)
  for (const i of (home && home.v === 2 ? v2Order(plan) : plan.keys())) {
    if (skip.has(i)) continue
    if (!cellDone(bot, home, plan[i])) return i
  }
  return -1
}

// v2 visit order (idkcraft-d7i): the partition is laid right before the
// door, not after the roof. The pathfinder never opens doors, so once the
// door stood the interior was sealed and the last 7-8 posts were never
// reachable (rig: 92/99, TIMEOUT) — or the body got in first and wedged in
// the roofed bedroom (page). Before the door the doorway is open and the
// walls are one high. Indices stay the blueprint's (persisted skips key on
// them); only the visiting order changes.
function v2Order(plan) {
  const isPartition = (c) => c.kind === 'planks' && c.dy <= 1 && c.dz >= 3 && c.dz <= 4 && c.dx >= 1 && c.dx <= 5
  const idx = [...plan.keys()]
  const part = idx.filter((i) => isPartition(plan[i]))
  const rest = idx.filter((i) => !isPartition(plan[i]))
  const door = rest.findIndex((i) => plan[i].kind === 'door')
  return door < 0 ? idx : [...rest.slice(0, door), ...part, ...rest.slice(door)]
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
function guardOwnWalls(bot, ctx, homeOpt) {
  try {
    const mov = bot && bot.pathfinder && bot.pathfinder.movements
    if (!mov || !Array.isArray(mov.exclusionAreasBreak)) return
    // Optional override (rw4.17): the comehome exit guards the EXITED house,
    // which a 'build here' swap may have pinned older than ctx.home.
    const home = (homeOpt && homeOpt.site) ? homeOpt : (ctx && ctx.home)
    const site = home && home.site
    if (!site || typeof site.x !== 'number') return
    const key = `${site.x},${site.y},${site.z}`
    if (ctx.buildGuardedMov === mov && ctx.buildGuardKey === key) return
    // Sticky exit box (rw4.17 revmux 01 minor): an exit-installed guard is
    // not freed by a home move while the body still stands inside the
    // guarded box — freeing it there hands the next A* the walls (swap +
    // door-stuck fail, then a build tick re-boxes to the new site). The
    // next call after leaving re-boxes, so nothing leaks. Build-installed
    // guards (flag unset) re-box as before. Unknown position fails open to
    // today's behaviour.
    if (ctx.buildGuardFn && ctx.buildGuardExit && ctx.buildGuardBox &&
      posInBox(bot && bot.entity && bot.entity.position, ctx.buildGuardBox)) return
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
    ctx.buildGuardBox = box
    ctx.buildGuardExit = false // a fresh install is build-context until guardExitWalls adopts it
  } catch (_) { /* best-effort: approach still walks */ }
}

// Feet-in-box test for the sticky exit box: floor to the standing block
// first (the isInside lesson — a raw float misreads the back row).
function posInBox(bp, box) {
  try {
    if (!bp || typeof bp.x !== 'number' || !box) return false
    const x = Math.floor(bp.x)
    const y = Math.floor(bp.y)
    const z = Math.floor(bp.z)
    return x >= box.x0 && x <= box.x1 && y >= box.y0 && y <= box.y1 && z >= box.z0 && z <= box.z1
  } catch (_) { return false }
}

// Exit-context install (rw4.17): same box as guardOwnWalls, but the guard
// stays put across a home move while the body stands inside it (see the
// sticky branch above). The comehome exit's backstop — build/light/decide
// keep calling guardOwnWalls and re-box as before.
function guardExitWalls(bot, ctx, home) {
  guardOwnWalls(bot, ctx, home)
  try {
    if (ctx.buildGuardFn) ctx.buildGuardExit = true
  } catch (_) { /* flag best-effort */ }
}

function skipCell(ctx, idx, p, why) {
  if (!Array.isArray(ctx.buildSkip)) ctx.buildSkip = []
  if (!ctx.buildSkip.includes(idx)) ctx.buildSkip.push(idx)
  // Wall-clock verdict stamp (revmux 01 core-4): a skip is retried after
  // BUILD_SKIP_RETRY_MS — transient refusals heal, structural cells
  // re-skip budget-capped — so persistence can never fossilize a hole.
  try {
    if (!ctx.buildSkipAt || typeof ctx.buildSkipAt !== 'object') ctx.buildSkipAt = {}
    ctx.buildSkipAt[idx] = Date.now()
  } catch (_) { /* stamp best-effort */ }
  // The next cell starts its own budget (revmux 02): without this a skip
  // below a fully-traversed max hands the next lower cell the exhausted
  // remainder and skips it on its first tick.
  ctx.buildFails = 0
  ctx.buildStallTicks = 0
  ctx.buildHardTicks = 0
  ctx.buildAnchor = null
  if (why === 'cell-budget') console.log(`build skip ${p.x} ${p.y} ${p.z} after ${CELL_TICK_BUDGET} ticks without progress (${why})`)
  else if (why === 'cell-hard-cap') console.log(`build skip ${p.x} ${p.y} ${p.z} after ${CELL_HARD_CAP} ticks on one cell (${why})`)
  else if (why === 'wedged') console.log(`build skip ${p.x} ${p.y} ${p.z} after a gave-up recover episode (${why})`)
  else console.log(`build skip ${p.x} ${p.y} ${p.z} after 3 refusals (${why})`)
}

// Skip retry (revmux 01 core-4): re-probe skips older than the window —
// transient refusals (a mob in the cell) lay on retry, structural cells
// re-skip budget-capped. Unstamped skips (pre-fix sessions, hand-set tests)
// never prune: only verdicts this code stamped may expire. Called from the
// build menu gate (the live re-probe; restored stale skips drop on the
// first decide, so a deploy heals stale holes like the pre-persistence
// code did).
const BUILD_SKIP_RETRY_MS = 3600000
function pruneBuildSkips(ctx, now) {
  try {
    if (!ctx || !Array.isArray(ctx.buildSkip) || ctx.buildSkip.length === 0) return
    const t = typeof now === 'number' ? now : Date.now()
    const at = ctx.buildSkipAt && typeof ctx.buildSkipAt === 'object' ? ctx.buildSkipAt : {}
    const fresh = ctx.buildSkip.filter((i) => typeof at[i] !== 'number' || t - at[i] < BUILD_SKIP_RETRY_MS)
    if (fresh.length === ctx.buildSkip.length) return
    ctx.buildSkip = fresh
    const keep = {}
    for (const i of fresh) {
      if (typeof at[i] === 'number') keep[i] = at[i]
    }
    ctx.buildSkipAt = keep
  } catch (_) { /* prune best-effort */ }
}

// A release latch born while this cell was current (not the one seen at
// cell start), anchored near it, after build itself saw the stall build up
// on this cell (d7i): the detector counts 30 still ticks before it raises,
// and build ticks through them, so a latch from another step's wedge (an
// equip dig beside the house) never skips a house cell. ponytail: 8
// blocks ≈ the house diagonal plus reach; a wedge on a long approach walk
// farther out keeps the stall budget.
const WEDGE_RADIUS = 8
const WEDGE_STILLS = 10
const WEDGE_WINDOW_MS = 120000
function wedgeLatched(ctx, p, idx) {
  try {
    const L = ctx.recoverLatch
    if (ctx.buildSuspectIdx !== idx || !(Date.now() - (ctx.buildSuspectAt || 0) < WEDGE_WINDOW_MS)) return false
    if (!L || L === ctx.buildLatchSeen || !L.at || typeof L.at.x !== 'number') return false
    return Math.hypot(L.at.x - (p.x + 0.5), L.at.z - (p.z + 0.5)) <= WEDGE_RADIUS
  } catch (_) { return false }
}

function walkToSite(bot, ctx, p) {
  const bp = bot.entity && bot.entity.position
  if (!bp || typeof bp.x !== 'number') return
  const w = ctx.buildSiteWalk
  if (!w || Math.hypot(bp.x - w.x, bp.z - w.z) > CELL_PROGRESS) {
    ctx.buildSiteWalk = { x: bp.x, z: bp.z, ticks: 0 }
  } else if (++w.ticks >= CELL_TICK_BUDGET) {
    ctx.buildSiteWalk = null
    ctx.buildGoalIdx = -1
    ctx.stepStatus = 'failed:cannot-reach-site'
    return
  }
  let moving = false
  try { moving = bot.pathfinder.isMoving() } catch (_) { /* re-issue */ }
  // Re-issue on idle: A* toward unloaded ground ends on a partial path,
  // each re-plan from the new stand gets further.
  if (ctx.buildGoalIdx === 'site' && moving) return
  ctx.buildGoalIdx = 'site'
  try { bot.pathfinder.setGoal(new goals.GoalNearXZ(p.x, p.z, PLACE_RANGE)) } catch (_) { /* retry next tick */ }
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
    ctx.buildSkipAt = {}
    ctx.buildFails = 0
    ctx.buildFailIdx = -1
    ctx.buildFarIdx = -1
  }
  // Hung own flight (ipn.10): drop the flag so the cell re-attempts; the
  // strike counts like a refusal, so three hangs skip the cell. A late
  // settlement lands through the flightIdx guard in the flight below.
  if (ctx.placeInFlight && ctx.buildFlightSince != null && ctx.home &&
    Date.now() - ctx.buildFlightSince > FLIGHT_TIMEOUT_MS) {
    ctx.placeInFlight = false
    ctx.buildFlightSince = null
    const hIdx = nextCellIdx(bot, ctx.home, ctx.buildSkip)
    if (hIdx >= 0) {
      if (ctx.buildFailIdx !== hIdx) {
        ctx.buildFailIdx = hIdx
        ctx.buildFails = 0
      }
      ctx.buildFails = (ctx.buildFails || 0) + 1
      if (ctx.buildFails >= 3) skipCell(ctx, hIdx, cellAbs(ctx.home, blueprintFor(ctx.home)[hIdx]), 'flight-hang')
    }
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
    // Holes remain (vmzq.10): every remaining cell is placed but given-up
    // cells are still missing — fail the step, never announce done. The
    // 1h skip retry re-probes; structural cells re-skip and fail again
    // instead of fossilizing a false 'home done'.
    if (!isComplete(bot, ctx.home)) {
      const n = Array.isArray(ctx.buildSkip) ? ctx.buildSkip.length : 0
      if (ctx.stepStatus !== 'failed:skipped-cells') {
        console.log(`build holes remain: ${n} skipped cells still missing`)
      }
      ctx.stepStatus = 'failed:skipped-cells'
      return
    }
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
  // Unloaded site (45j, e.g. respawn ~150 blocks away): the scan reads
  // nothing out here, so walk toward the site and re-scan once it loads.
  // No item check (the next cell is unknown) and no cell budget; a walk
  // that stops getting anywhere fails the step instead.
  if (!cellLoaded(bot, ctx.home, cell)) {
    walkToSite(bot, ctx, p)
    return
  }
  ctx.buildSiteWalk = null
  // Per-cell attempt budget (ipn.10): ticks on one cell without progress —
  // no advance past the max cell, no displacement past CELL_PROGRESS —
  // skip it like a refusal. Keyed by site, so a home move re-arms without
  // touching the setHome/adopt reset lists. An unreadable body counts:
  // two minutes of unknown position is broken by any definition. The hard
  // cap below counts every non-advancing tick unforgiven, so an
  // oscillation that keeps displacing still ends (revmux 01 core-3). Both
  // counters are keyed to the cell (revmux 02): once the house is fully
  // traversed a later lower cell must get its own budget, not the
  // remainder of a shared one.
  try {
    const site = ctx.home.site
    const siteKey = `${site.x},${site.y},${site.z},v${ctx.home.v === 2 ? 2 : 1}`
    if (ctx.buildCellSite !== siteKey) {
      ctx.buildCellSite = siteKey
      ctx.buildMaxIdx = -1
      ctx.buildCellIdx = -1
      ctx.buildStallTicks = 0
      ctx.buildHardTicks = 0
      ctx.buildAnchor = null
    }
    if (ctx.buildCellIdx !== idx) {
      ctx.buildCellIdx = idx
      ctx.buildStallTicks = 0
      ctx.buildHardTicks = 0
      ctx.buildLatchSeen = ctx.recoverLatch || null
      ctx.buildSuspectIdx = -1
      const bpc = bot.entity && bot.entity.position
      ctx.buildAnchor = bpc && typeof bpc.x === 'number' ? { x: bpc.x, y: bpc.y, z: bpc.z } : null
    }
    // Gave-up wedge (idkcraft-d7i): a recover episode on this cell ended
    // gave-up (the release latch is new since the cell started and anchored
    // at the cell) — the menu already spent its budget here, and the latch
    // now holds every re-wedge out of the menu, so the stall budget would
    // only burn minutes more. Skip it like 3 refusals.
    // Armed by a real stall only (revmux 02 minor): 10+ still ticks seen
    // under build on this cell, recently — the episode follows the 30th
    // still tick and runs well under the window, so a stall build saw long
    // before another step's wedge never arms it.
    const sv = stuck.verdict(ctx)
    if ((sv.state === 'SUSPECT' || sv.state === 'STUCK') && sv.stills >= WEDGE_STILLS) {
      ctx.buildSuspectIdx = idx
      ctx.buildSuspectAt = Date.now()
    }
    if (wedgeLatched(ctx, p, idx)) {
      skipCell(ctx, idx, p, 'wedged')
      return
    }
    if (idx > (typeof ctx.buildMaxIdx === 'number' ? ctx.buildMaxIdx : -1)) {
      ctx.buildMaxIdx = idx
      ctx.buildStallTicks = 0
      ctx.buildHardTicks = 0
      const bp0 = bot.entity && bot.entity.position
      ctx.buildAnchor = bp0 && typeof bp0.x === 'number' ? { x: bp0.x, y: bp0.y, z: bp0.z } : null
    } else {
      ctx.buildHardTicks = (ctx.buildHardTicks || 0) + 1
      if (ctx.buildHardTicks >= CELL_HARD_CAP) {
        skipCell(ctx, idx, p, 'cell-hard-cap')
        return
      }
      let moved = false
      try {
        const bp = bot.entity && bot.entity.position
        const a = ctx.buildAnchor
        if (bp && typeof bp.x === 'number' && a && typeof a.x === 'number' &&
          Math.hypot(bp.x - a.x, bp.y - a.y, bp.z - a.z) > CELL_PROGRESS) moved = true
      } catch (_) { moved = false }
      if (moved) {
        ctx.buildStallTicks = 0
        try {
          const bp1 = bot.entity.position
          ctx.buildAnchor = { x: bp1.x, y: bp1.y, z: bp1.z }
        } catch (_) { /* anchor best-effort */ }
      } else {
        ctx.buildStallTicks = (ctx.buildStallTicks || 0) + 1
        if (ctx.buildStallTicks >= CELL_TICK_BUDGET) {
          skipCell(ctx, idx, p, 'cell-budget')
          return
        }
      }
    }
  } catch (_) { /* budget best-effort: the refusal counters still guard */ }

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
    // The v2 door goes in from the doorstep side (d7i): after the partition
    // the body stands inside, and a door set from in there seals it in (the
    // pathfinder never opens doors). The north wall holds the door, so
    // outside is -z.
    try {
      bot.pathfinder.setGoal(cell.kind === 'door' && ctx.home.v === 2
        ? new goals.GoalNearXZ(p.x, p.z - 2, 1)
        : new goals.GoalPlaceBlock(p, bot.world, { range: PLACE_RANGE }))
    } catch (_) { /* retry next tick */ }
    return
  }
  if (moving) return

  // At the cell (or the walk never started): place — but only in reach.
  // A preemption that carried the body away (fight, flee, lead, follow me)
  // leaves a stale buildGoalIdx: attempting from out there burns refusals
  // and skips a good cell, so force a fresh approach instead. Counted on
  // its own streak, forgiven by approach progress: a long walk-in crosses
  // far-idle ticks between A* timeout segments (the pathfinder never
  // chains them by itself), and those must not spend refusal strikes nor
  // combine with them — only a stand that stops getting closer skips the
  // cell as 'unreachable' (revmux 01 major).
  try {
    const bp = bot.entity && bot.entity.position
    const farDist = bp && typeof bp.x === 'number'
      ? Math.hypot(bp.x - (p.x + 0.5), (bp.y + 1.6) - (p.y + 0.5), bp.z - (p.z + 0.5))
      : -1
    if (farDist > PLACE_REACH) {
      if (ctx.buildFarIdx !== idx) {
        ctx.buildFarIdx = idx
        ctx.buildFarFails = 0
        ctx.buildFarDist = farDist
      }
      if (farDist < ctx.buildFarDist - FAR_PROGRESS) ctx.buildFarFails = 0
      else ctx.buildFarFails = (ctx.buildFarFails || 0) + 1
      ctx.buildFarDist = farDist
      if (ctx.buildFarFails >= 3) skipCell(ctx, idx, p, 'unreachable')
      else ctx.buildGoalIdx = -1
      return
    }
    // Reach proven: a later far episode starts its streak fresh, so
    // repeated preemptions with returns in between never accumulate
    // into a skip (revmux 02 minor). A static far stand never reaches
    // this line, so it still skips after 3.
    ctx.buildFarFails = 0
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
  ctx.buildFlightSince = Date.now()
  const flightIdx = idx
  const fails = () => ctx.buildFails || 0
  ;(async () => {
    try {
      await bot.equip(item, 'hand')
      await bot.placeBlock(ref.ref, ref.face)
      if (ctx.buildFailIdx === flightIdx) ctx.buildFails = 0
    } catch (err) {
      // Stale flight (ipn.10): the cell moved on (budget skip) while this
      // verdict was in the air — it must neither strike nor clear for the
      // new cell, and must not dig for the dead one.
      if (ctx.buildFailIdx !== flightIdx) return
      ctx.buildFails = fails() + 1
      const occupier = blockNameAt(bot, p)
      // Landed only when the occupier is THIS cell's kind (d7i): the equip
      // step's station table landed in the doorway and read as 'landed'
      // forever — every refusal forgiven, no skip, the body wedged into a
      // recover page. A stray table in a non-table cell clears like flora
      // (denyReason still guards a player's table); any other wrong-kind
      // occupier counts as a refusal.
      if (occupier != null && wantItem(cell)(occupier)) {
        ctx.buildFails = 0 // landed while we walked: someone (us) placed it
      } else if (occupier != null && occupier !== 'air' && (isReplaceable(occupier) || clearableFillGround(bot, p, cell) ||
        (occupier === 'crafting_table' && cell.kind !== 'table'))) {
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
      ctx.buildFlightSince = null
    }
  })().catch(() => { ctx.placeInFlight = false; ctx.buildFlightSince = null })
}

module.exports = build
module.exports.findRef = findRef
module.exports.isReplaceable = isReplaceable
module.exports.guardOwnWalls = guardOwnWalls
module.exports.guardExitWalls = guardExitWalls
module.exports.BLUEPRINT = BLUEPRINT
module.exports.BLUEPRINT_V2 = BLUEPRINT_V2
module.exports.PLANK_COUNT = PLANK_COUNT
module.exports.PLANK_COUNT_V2 = PLANK_COUNT_V2
module.exports.blueprintFor = blueprintFor
module.exports.isDoorwayOrInterior = isDoorwayOrInterior
module.exports.isPlanCell = isPlanCell
module.exports.nextCellIdx = nextCellIdx
module.exports.isComplete = isComplete
module.exports.countRemainingPlanks = countRemainingPlanks
module.exports.cellDone = cellDone
module.exports.cellLoaded = cellLoaded
module.exports.pruneBuildSkips = pruneBuildSkips
module.exports.BUILD_SKIP_RETRY_MS = BUILD_SKIP_RETRY_MS
module.exports.PLACE_RANGE = PLACE_RANGE
module.exports.PLACE_REACH = PLACE_REACH
module.exports.CELL_TICK_BUDGET = CELL_TICK_BUDGET
module.exports.CELL_PROGRESS = CELL_PROGRESS
module.exports.CELL_HARD_CAP = CELL_HARD_CAP
module.exports.FLIGHT_TIMEOUT_MS = FLIGHT_TIMEOUT_MS
