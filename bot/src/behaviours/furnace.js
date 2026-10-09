'use strict'

// Furnace station (idkcraft-ipn.1): craft an 8-cobble furnace at the home
// table, place it (v1: by the body, roadside pattern; v2: at a fixed spot
// inside the common room, jr2.1), smelt raw iron on coal/charcoal above
// planks (ipn.13: the coal reserve is smelting's share, so the furnace
// burns coal down to zero; planks are the third fuel kind), take the ingots. BEHAVIOURS-shaped for the slice-C
// gear step; until then the live assay drives it directly.
//
// Station contract (chest precedent): ctx.home.furnace is plain { x, y, z },
// claimed only once the furnace block is verified standing; a verified
// non-furnace retracts the claim (null blockAt reads unloaded, never gone).
// One op per tick behind ctx.furnaceInFlight (craft shape). Crafting is
// table-only, always with a verified table block — never the 2x2 window
// (xg9). Tools are never equipped: placement holds the furnace item only.

const { goals } = require('mineflayer-pathfinder')
const { Vec3 } = require('vec3')
const { countItems } = require('../perception')
const craftMod = require('./craft')
const { issueGoal } = require('./util')
const residence = require('../residence')

// The house's fixed indoor cells (jr2.1) live with the residence
// descriptor now (g0z.36); re-exported for the light.js precedent.
const FURNACE_SPOTS = residence.FURNACE_SPOTS

// Default smelt job (g0z.36): raw iron -> ingots. A caller sets
// ctx.furnaceJob = { input, output } before the first tick of a run
// (castle glass: sand -> glass); freshRun copies it.
const IRON_JOB = { input: 'raw_iron', output: 'iron_ingot' }

const FURNACE_REACH = craftMod.TABLE_REACH // window ops need table-like proximity
const ORE_PER_FUEL = 8 // one coal smelts eight ore
const ORE_PER_PLANK = 1.5 // one plank burns 300 ticks = 1.5 items
const STALL_TICKS = 120 // output-idle ticks with input+fuel before failed:smelt-stalled
const FUEL_GRACE_TICKS = 15 // output-idle ticks before failed:no-fuel (one cook + slop)

function botPos(bot) {
  try {
    const p = bot && bot.entity && bot.entity.position
    if (p && typeof p.x === 'number') return p
  } catch (_) { /* no position */ }
  return null
}

function dist3(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)
}

function fail(ctx, reason) {
  ctx.stepStatus = `failed:${reason}`
  // Slice-C contract: the outcome stays readable on ctx.furnace.result
  // (gear wraps stepStatus, which furnace would otherwise end).
  try {
    if (ctx.furnace) {
      ctx.furnace.result = `failed:${reason}`
      ctx.furnace.settled = true
    }
  } catch (_) { /* flag best-effort */ }
}

function freshRun(ctx) {
  const j = ctx && ctx.furnaceJob
  const job = j && typeof j.input === 'string' && typeof j.output === 'string' ? { input: j.input, output: j.output } : IRON_JOB
  return { job, phase: 'ensure', smelted: 0, idleTicks: 0, winErrs: 0, walkTicks: 0, tookOnce: false, win: null, settled: false, result: null }
}

// Verified crafting table (craft pattern): the claim plus a live block
// read, else null. Never trust the claim alone (mined table).
function tableBlock(bot, ctx) {
  try {
    // First verified-standing (h9z): a ghost home claim must not shadow
    // the standing roadside table (craft.js pattern).
    // A castle home has no claim: its storeroom table is the descriptor's
    // cell (equip castleTableSpot precedent, g0z.36).
    const home = ctx && ctx.home
    const castleTable = home && home.kind === 'castle' && home.site ? residence.of(home).table(home) : null
    for (const tablePos of [(home && home.table), (ctx && ctx.claimedTable), castleTable]) {
      if (!tablePos || typeof tablePos.x !== 'number') continue
      // Vec3-normalized: live blockAt calls .floored(), plain claims throw.
      const block = bot.blockAt && bot.blockAt(new Vec3(tablePos.x, tablePos.y, tablePos.z))
      if (block && block.name === 'crafting_table') return { block, pos: tablePos }
    }
    return null
  } catch (_) { return null }
}

// The residence's fixed furnace cells (site-relative), [] = roadside (hut).
function homeSpots(home) {
  if (!home || !home.site || typeof home.site.x !== 'number') return []
  try { return residence.of(home).furnace(home) || [] } catch (_) { return [] }
}

// Verified furnace claim, else null. A ghost (verified non-furnace) is
// retracted so the phases rebuild; null reads unloaded, never gone. On a
// v2 house or a castle with no claim a standing furnace at a fixed indoor spot adopts
// on sight (memory drops the claim, so every restart re-adopts instead of
// duplicating the station — the chest precedent).
function furnaceSpot(bot, ctx) {
  try {
    const home = ctx && ctx.home
    const spot = home && home.furnace
    if (!spot || typeof spot.x !== 'number') {
      for (const sp of homeSpots(home)) {
        let b = null
        try {
          b = bot.blockAt && bot.blockAt(new Vec3(home.site.x + sp.dx, home.site.y + sp.dy, home.site.z + sp.dz))
        } catch (_) { b = null }
        if (b && b.name === 'furnace') {
          home.furnace = new Vec3(home.site.x + sp.dx, home.site.y + sp.dy, home.site.z + sp.dz)
          return home.furnace
        }
      }
      return null
    }
    let block = null
    try { block = bot.blockAt && bot.blockAt(new Vec3(spot.x, spot.y, spot.z)) } catch (_) { block = null }
    if (block && block.name !== 'furnace') {
      try { delete ctx.home.furnace } catch (_) { /* retract best-effort */ }
      return null
    }
    return spot
  } catch (_) { return null }
}

function invCount(bot, name) {
  try { return countItems(bot, (n) => n === name) } catch (_) { return 0 }
}

// Fuel pieces to load for oreTotal ore with fuelTotal coal/charcoal on
// hand (ipn.13): light.js COAL_RESERVE is smelting's share — it keeps
// torches off the last coal, so the furnace itself spends it to zero.
function fuelPieces(oreTotal, fuelTotal, perPiece = ORE_PER_FUEL) {
  if (!(oreTotal > 0)) return 0
  return Math.min(Math.max(0, fuelTotal || 0), Math.ceil(oreTotal / perPiece))
}

// Biggest single planks stack (gear counts planks the same way), or null.
function plankStack(bot) {
  try {
    const woods = craftMod.sortedWoods(craftMod.tally(bot, '_planks'))
    return woods.length > 0 && woods[0][1] > 0 ? `${woods[0][0]}_planks` : null
  } catch (_) { return null }
}

// Walk one leg with a give-up: an unreachable table/furnace fails the
// step instead of idling here forever (equip walkWaits shape).
function walkTo(bot, ctx, f, key, p, reason) {
  if (key !== ctx.lastGoalKey) {
    issueGoal(bot, ctx, new goals.GoalNear(p.x, p.y, p.z, 3), key, false)
  }
  f.walkTicks = (f.walkTicks || 0) + 1
  if (f.walkTicks > 20) fail(ctx, reason)
}

// Craft one furnace at the verified table (table block always passed:
// xg9 broke the 2x2 window path, the 3x3 is clean).
function doCraft(bot, ctx, f) {
  const bp = botPos(bot)
  if (!bp) return
  if (invCount(bot, 'cobblestone') < 8) { fail(ctx, 'no-cobble'); return }
  const st = tableBlock(bot, ctx)
  if (!st) { fail(ctx, 'no-table'); return }
  if (dist3(bp, st.pos) > craftMod.TABLE_REACH) {
    walkTo(bot, ctx, f, `furnace-table:${st.pos.x},${st.pos.y},${st.pos.z}`, st.pos, 'table-unreachable')
    return // walk into reach, craft on a later tick
  }
  f.walkTicks = 0
  const found = craftMod.recipes(bot, 'furnace', st.block)
  if (!found || found.length === 0) { fail(ctx, 'no-furnace-recipe'); return }
  if (typeof bot.craft !== 'function') { fail(ctx, 'no-craft-api'); return }
  ctx.furnaceInFlight = true
  void (async () => {
    try {
      await craftMod.safeCraft(bot, found[0], 1, st.block, { ctx, item: 'furnace' })
    } catch (err) {
      ctx.furnaceInFlight = false
      fail(ctx, 'craft-furnace')
      return
    }
    ctx.furnaceInFlight = false
  })()
}

// Place the furnace at a fixed indoor spot (v2): walk into reach and place
// through the wall (a standing furnace never reaches here — furnaceSpot
// adopts it on sight first). Falls back to the roadside pattern when every
// indoor spot is blocked — a working furnace outside beats a dead step.
function doPlaceV2(bot, ctx, f) {
  const home = ctx.home
  const site = home && home.site
  if (!site || typeof site.x !== 'number') { fail(ctx, 'no-home'); return }
  let item = null
  try {
    const items = bot.inventory && typeof bot.inventory.items === 'function' ? bot.inventory.items() : []
    item = (items || []).find((i) => i && i.name === 'furnace') || null
  } catch (_) { item = null }
  const nameAt = (x, y, z) => {
    try {
      const b = bot.blockAt && bot.blockAt(new Vec3(x, y, z))
      return b && b.name
    } catch (_) { return null }
  }
  let spot = null
  for (const sp of homeSpots(home)) {
    const x = site.x + sp.dx
    const y = site.y + sp.dy
    const z = site.z + sp.dz
    if (nameAt(x, y, z) !== 'air') continue
    const below = nameAt(x, y - 1, z)
    if (!below || below === 'air') continue
    spot = { x, y, z }
    break
  }
  if (!spot || !item) {
    if (!item) { fail(ctx, 'no-furnace-item'); return }
    doPlaceRoadside(bot, ctx, f, item)
    return
  }
  const bp = botPos(bot)
  if (!bp) return
  if (dist3(bp, spot) > FURNACE_REACH) {
    walkTo(bot, ctx, f, `furnace-place:${spot.x},${spot.y},${spot.z}`, spot, 'furnace-unreachable')
    return // walk into reach, place on a later tick
  }
  f.walkTicks = 0
  let ref = null
  try {
    ref = bot.blockAt(new Vec3(spot.x, spot.y - 1, spot.z))
  } catch (_) { ref = null }
  if (!ref || !ref.position) { fail(ctx, 'no-spot'); return }
  placeAt(bot, ctx, item, ref, new Vec3(spot.x, spot.y, spot.z))
}

// The shared place flight: hold the furnace item (never a tool), place,
// claim only a verified block.
function placeAt(bot, ctx, item, ref, at) {
  ctx.furnaceInFlight = true
  void (async () => {
    try {
      // mineflayer places the HELD item: hold the furnace (never a tool).
      if (typeof bot.equip === 'function') {
        try { await bot.equip(item, 'hand') } catch (_) { /* held already or bust: placement decides */ }
      }
      await bot.placeBlock(ref, new Vec3(0, 1, 0))
      let block = null
      try { block = bot.blockAt(at) } catch (_) { block = null }
      if (!block || block.name !== 'furnace') throw new Error('furnace-place')
      ctx.home.furnace = new Vec3(at.x, at.y, at.z) // Vec3, not plain (h9z): readers blockAt()s it
      try { console.log(`furnace placed at ${at.x},${at.y},${at.z}`) } catch (_) { /* log best-effort */ }
    } catch (err) {
      ctx.furnaceInFlight = false
      fail(ctx, 'furnace-place')
      return
    }
    ctx.furnaceInFlight = false
  })()
}

// Place the furnace beside the body (equip roadside-table pattern): first
// free neighbour with solid ground. Claims only a verified block.
function doPlace(bot, ctx, f) {
  if (ctx && homeSpots(ctx.home).length > 0) { doPlaceV2(bot, ctx, f); return }
  let item = null
  try {
    const items = bot.inventory && typeof bot.inventory.items === 'function' ? bot.inventory.items() : []
    item = (items || []).find((i) => i && i.name === 'furnace') || null
  } catch (_) { item = null }
  if (!item) { fail(ctx, 'no-furnace-item'); return }
  doPlaceRoadside(bot, ctx, f, item)
}

function doPlaceRoadside(bot, ctx, f, item) {
  const bp = botPos(bot)
  if (!bp) return
  if (!ctx.home) { fail(ctx, 'no-home'); return }
  if (typeof bot.placeBlock !== 'function' || !bot.blockAt) { fail(ctx, 'no-furnace-item'); return }
  const bx = Math.floor(bp.x)
  const by = Math.floor(bp.y)
  const bz = Math.floor(bp.z)
  let ref = null
  let at = null
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    let below = null
    let cell = null
    try {
      below = bot.blockAt(new Vec3(bx + dx, by - 1, bz + dz))
      cell = bot.blockAt(new Vec3(bx + dx, by, bz + dz))
    } catch (_) { below = null; cell = null }
    if (!below || !below.position || !below.name || below.name === 'air') continue
    if (cell && cell.name && cell.name !== 'air') continue
    ref = below
    at = new Vec3(below.position.x, below.position.y + 1, below.position.z)
    break
  }
  if (!ref) { fail(ctx, 'no-spot'); return }
  placeAt(bot, ctx, item, ref, at)
}

function slotCount(slot) {
  return slot && typeof slot.count === 'number' ? slot.count : 0
}

// Window lifecycle: one window stays open across smelt ticks (openBlock per
// tick leaks progress listeners faster than closes drain). A throwing
// cycle drops the window and retries once; two in a row fails.
async function shut(bot, f) {
  const win = f.win
  f.win = null
  try { if (win && typeof bot.closeWindow === 'function') await bot.closeWindow(win) } catch (_) { /* close best-effort */ }
}

function finishSmelt(bot, ctx, f, status) {
  void shut(bot, f)
  ctx.furnaceInFlight = false
  try { f.settled = true } catch (_) { /* flag best-effort */ }
  if (status === 'done') {
    if ((f.smelted || 0) > 0) {
      // The iron line stays byte-identical (prod log greps it).
      const what = f.job && f.job.output !== IRON_JOB.output ? f.job.output : 'iron'
      try { console.log(`smelted ${f.smelted} ${what}`) } catch (_) { /* log best-effort */ }
    }
    ctx.stepStatus = 'done'
    try { f.result = 'done' } catch (_) { /* flag best-effort */ }
  } else {
    fail(ctx, status)
  }
}

// One smelt cycle behind inFlight: take output, top up input+fuel above
// the reserve. Done when no ore stands anywhere; failed when ore stands
// but nothing can burn it.
function doSmelt(bot, ctx, f, spot) {
  if (typeof bot.openFurnace !== 'function') { fail(ctx, 'no-furnace-api'); return }
  let fblock = null
  try { fblock = bot.blockAt(new Vec3(spot.x, spot.y, spot.z)) } catch (_) { fblock = null }
  if (!fblock) return // unloaded chunk: wait, never fail (stockpile rule)
  if (fblock.name !== 'furnace') { fail(ctx, 'furnace-gone'); return }
  ctx.furnaceInFlight = true
  void (async () => {
    try {
      if (!f.win) f.win = await bot.openFurnace(fblock)
      const win = f.win
      const outNow = slotCount(win.outputItem())
      const inN = slotCount(win.inputItem())
      const fuelN = slotCount(win.fuelItem())
      // Burn state comes from output growth, not properties (see below).
      let took = false
      if (outNow > 0) {
        const got = await win.takeOutput()
        f.smelted = (f.smelted || 0) + (got && typeof got.count === 'number' ? got.count : outNow)
        f.idleTicks = 0
        f.tookOnce = true
        took = true
      } else if (inN > 0) {
        // Slots only: property packets (progress/fuel) never arrive on
        // this Paper, so burn state comes from output growth alone.
        f.idleTicks = (f.idleTicks || 0) + 1
        if (f.idleTicks >= STALL_TICKS && fuelN > 0) { finishSmelt(bot, ctx, f, 'smelt-stalled'); return }
      } else {
        f.idleTicks = 0
      }
      const input = (f.job || IRON_JOB).input
      const invOre = invCount(bot, input)
      const invCoal = invCount(bot, 'coal')
      const invChar = invCount(bot, 'charcoal')
      // Planks are the third fuel kind (ipn.13): a slot already holding
      // planks keeps its wood; an empty slot takes planks only once coal
      // and charcoal are gone (one kind per cycle, core-1 below).
      const fuelSlot = typeof win.fuelItem === 'function' ? win.fuelItem() : null
      const fuelName = fuelSlot && fuelSlot.name
      const slotPlanks = typeof fuelName === 'string' && fuelName.endsWith('_planks')
      const plankName = slotPlanks ? fuelName : (!fuelName && invCoal + invChar === 0 ? plankStack(bot) : null)
      const invPlanks = plankName ? invCount(bot, plankName) : 0
      // Top up input (room in the slot) and fuel (coal to zero). A
      // recent take means a burn is likely in flight (core-5): the piece
      // left the slot but still cooks, so it counts or every ignition
      // parks one extra coal. Past the grace the discount lapses and a
      // cold furnace reloads.
      const oreLoad = Math.min(invOre, 64 - inN)
      const inFlight = f.tookOnce && (f.idleTicks || 0) < FUEL_GRACE_TICKS ? 1 : 0
      const fuelLoad = plankName
        ? Math.max(0, Math.min(64 - fuelN, fuelPieces(invOre + inN, invPlanks, ORE_PER_PLANK) - fuelN - inFlight)) // one 64 slot: 97+ ore outgrows it
        : Math.max(0, fuelPieces(invOre + inN, invCoal + invChar) - fuelN - inFlight)
      if (oreLoad > 0) {
        const id = craftMod.itemId(bot, input)
        if (id == null) throw new Error('no-ore-id')
        await win.putInput(id, null, oreLoad)
      }
      if (fuelLoad > 0 && plankName) {
        const id = craftMod.itemId(bot, plankName)
        if (id == null) throw new Error('no-plank-id')
        await win.putFuel(id, null, Math.min(invPlanks, fuelLoad))
      } else if (fuelLoad > 0) {
        // One fuel kind per cycle (core-1): coal and charcoal share the
        // single fuel slot, and transfer throws destination-full into a
        // slot holding the other kind. A holding slot tops up its own
        // kind only; an empty slot takes whichever single kind covers
        // the need (coal first), and a short kind waits for burn-down.
        if (!fuelName) {
          if (invCoal >= fuelLoad) {
            const id = craftMod.itemId(bot, 'coal')
            if (id == null) throw new Error('no-coal-id')
            await win.putFuel(id, null, fuelLoad)
          } else if (invChar >= fuelLoad) {
            const id = craftMod.itemId(bot, 'charcoal')
            if (id == null) throw new Error('no-char-id')
            await win.putFuel(id, null, fuelLoad)
          } else if (invCoal > 0) {
            const id = craftMod.itemId(bot, 'coal')
            if (id == null) throw new Error('no-coal-id')
            await win.putFuel(id, null, invCoal)
          } else if (invChar > 0) {
            const id = craftMod.itemId(bot, 'charcoal')
            if (id == null) throw new Error('no-char-id')
            await win.putFuel(id, null, Math.min(invChar, fuelLoad))
          }
        } else if (fuelName === 'coal' && invCoal > 0) {
          const id = craftMod.itemId(bot, 'coal')
          if (id == null) throw new Error('no-coal-id')
          await win.putFuel(id, null, Math.min(invCoal, fuelLoad))
        } else if (fuelName === 'charcoal' && invChar > 0) {
          const id = craftMod.itemId(bot, 'charcoal')
          if (id == null) throw new Error('no-char-id')
          await win.putFuel(id, null, Math.min(invChar, fuelLoad))
        }
      }
      // Settle: no ore anywhere = done; ore stranded past the grace
      // with an empty slot and nothing loadable = hungry. The grace
      // covers the burn in flight (a lit furnace with a drained slot
      // still cooks for one item time).
      const oreLeft = inN + invOre
      if (oreLeft === 0 && (outNow === 0 || took)) { finishSmelt(bot, ctx, f, 'done'); return }
      if (outNow === 0 && oreLeft > 0 && fuelN === 0 && fuelLoad === 0 && (f.idleTicks || 0) >= FUEL_GRACE_TICKS) {
        finishSmelt(bot, ctx, f, 'no-fuel')
        return
      }
      f.winErrs = 0
    } catch (err) {
      await shut(bot, f)
      ctx.furnaceInFlight = false
      f.winErrs = (f.winErrs || 0) + 1
      if (f.winErrs >= 2) fail(ctx, 'furnace-window')
      return // first error retries with a fresh window next tick
    }
    ctx.furnaceInFlight = false
  })()
}

function furnace(bot, ctx, target, state) {
  if (ctx.furnaceInFlight) return // exactly one op at a time
  if (ctx.stepStatus === 'done' || (ctx.stepStatus && String(ctx.stepStatus).startsWith('failed:'))) return // terminal: no second smelted line
  const bp = botPos(bot)
  if (!bp) return
  // A settled run never resumes spent: the next pick starts fresh
  // counters (core-4: equip's resetRunCounters shape).
  if (!ctx.furnace || ctx.furnace.settled) ctx.furnace = freshRun(ctx)
  const f = ctx.furnace
  const spot = furnaceSpot(bot, ctx)
  if (!spot) {
    if (invCount(bot, 'furnace') > 0) { f.phase = 'place'; doPlace(bot, ctx, f); return }
    f.phase = 'ensure'
    doCraft(bot, ctx, f)
    return
  }
  if (dist3(bp, spot) > FURNACE_REACH) {
    f.phase = 'walk'
    walkTo(bot, ctx, f, `furnace-walk:${spot.x},${spot.y},${spot.z}`, spot, 'furnace-unreachable')
    return // walk into reach, smelt on a later tick
  }
  f.walkTicks = 0
  f.phase = 'smelt'
  doSmelt(bot, ctx, f, spot)
}

// Slice-C readiness: the verified claim or null. Retracts ghosts (same
// path furnace() walks, so the check cannot rot); null reads keep the
// claim (unloaded chunk, never gone).
function furnaceReady(bot, ctx) {
  return furnaceSpot(bot, ctx)
}

module.exports = furnace
module.exports.FURNACE_SPOTS = FURNACE_SPOTS
module.exports.furnaceReady = furnaceReady
module.exports.tableBlock = tableBlock
module.exports.fuelPieces = fuelPieces
module.exports.FURNACE_REACH = FURNACE_REACH
module.exports.ORE_PER_FUEL = ORE_PER_FUEL
module.exports.ORE_PER_PLANK = ORE_PER_PLANK
