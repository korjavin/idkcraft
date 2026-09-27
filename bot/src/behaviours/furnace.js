'use strict'

// Furnace station (idkcraft-ipn.1): craft an 8-cobble furnace at the home
// table, place it by the body, smelt raw iron on coal/charcoal above the
// light.js reserve, take the ingots. BEHAVIOURS-shaped for the slice-C
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
const { COAL_RESERVE } = require('./light')

const FURNACE_REACH = craftMod.TABLE_REACH // window ops need table-like proximity
const ORE_PER_FUEL = 8 // one coal smelts eight ore
const STALL_TICKS = 120 // output-idle smelt ticks with input+fuel before failed:smelt-stalled

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

function freshRun() {
  return { phase: 'ensure', smelted: 0, idleTicks: 0, winErrs: 0, walkTicks: 0, win: null, settled: false, result: null }
}

// Verified crafting table (craft pattern): the claim plus a live block
// read, else null. Never trust the claim alone (mined table).
function tableBlock(bot, ctx) {
  try {
    const tablePos = (ctx.home && ctx.home.table) || (ctx && ctx.claimedTable)
    if (!tablePos || typeof tablePos.x !== 'number') return null
    // Vec3-normalized: live blockAt calls .floored(), plain claims throw.
    const block = bot.blockAt && bot.blockAt(new Vec3(tablePos.x, tablePos.y, tablePos.z))
    if (!block || block.name !== 'crafting_table') return null
    return { block, pos: tablePos }
  } catch (_) { return null }
}

// Verified furnace claim, else null. A ghost (verified non-furnace) is
// retracted so the phases rebuild; null reads unloaded, never gone.
function furnaceSpot(bot, ctx) {
  try {
    const spot = ctx.home && ctx.home.furnace
    if (!spot || typeof spot.x !== 'number') return null
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

// Fuel pieces to load for oreTotal ore with fuelTotal fuel on hand: the
// reserve never burns. Pure, so the mutant (reserve ignored) dies here.
function fuelPieces(oreTotal, fuelTotal) {
  if (!(oreTotal > 0)) return 0
  const spendable = Math.max(0, (fuelTotal || 0) - COAL_RESERVE)
  return Math.min(spendable, Math.ceil(oreTotal / ORE_PER_FUEL))
}

// Walk one leg with a give-up: an unreachable table/furnace fails the
// step instead of idling here forever (equip walkWaits shape).
function walkTo(bot, ctx, f, key, p, reason) {
  if (key !== ctx.lastGoalKey) {
    bot.pathfinder.setGoal(new goals.GoalNear(p.x, p.y, p.z, 3), false)
    ctx.lastGoalKey = key
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
      await craftMod.safeCraft(bot, found[0], 1, st.block)
    } catch (err) {
      ctx.furnaceInFlight = false
      fail(ctx, 'craft-furnace')
      return
    }
    ctx.furnaceInFlight = false
  })()
}

// Place the furnace beside the body (equip roadside-table pattern): first
// free neighbour with solid ground. Claims only a verified block.
function doPlace(bot, ctx, f) {
  const bp = botPos(bot)
  if (!bp) return
  if (!ctx.home) { fail(ctx, 'no-home'); return }
  let item = null
  try {
    const items = bot.inventory && typeof bot.inventory.items === 'function' ? bot.inventory.items() : []
    item = (items || []).find((i) => i && i.name === 'furnace') || null
  } catch (_) { item = null }
  if (!item || typeof bot.placeBlock !== 'function' || !bot.blockAt) { fail(ctx, 'no-furnace-item'); return }
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
      ctx.home.furnace = { x: at.x, y: at.y, z: at.z }
      try { console.log(`furnace placed at ${at.x},${at.y},${at.z}`) } catch (_) { /* log best-effort */ }
    } catch (err) {
      ctx.furnaceInFlight = false
      fail(ctx, 'furnace-place')
      return
    }
    ctx.furnaceInFlight = false
  })()
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
      try { console.log(`smelted ${f.smelted} iron`) } catch (_) { /* log best-effort */ }
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
      // Live burn level: progress sticks at its last fraction once the
      // property packets arrive, so progress != null is true even cold.
      // fuel drops to 0 on burnout (core-2).
      const burning = typeof win.fuel === 'number' && win.fuel > 0
      let took = false
      if (outNow > 0) {
        const got = await win.takeOutput()
        f.smelted = (f.smelted || 0) + (got && typeof got.count === 'number' ? got.count : outNow)
        f.idleTicks = 0
        took = true
      } else if (inN > 0 && (fuelN > 0 || burning)) {
        f.idleTicks = (f.idleTicks || 0) + 1
        if (f.idleTicks >= STALL_TICKS) { finishSmelt(bot, ctx, f, 'smelt-stalled'); return }
      } else {
        f.idleTicks = 0
      }
      const invOre = invCount(bot, 'raw_iron')
      const invCoal = invCount(bot, 'coal')
      const invChar = invCount(bot, 'charcoal')
      // Top up input (room in the slot) and fuel (reserve-capped). The
      // burn in flight counts as a piece (core-5): without it every
      // ignition parks one extra coal that never burns this run.
      const oreLoad = Math.min(invOre, 64 - inN)
      const fuelLoad = Math.max(0, fuelPieces(invOre + inN, invCoal + invChar) - fuelN - (burning ? 1 : 0))
      if (oreLoad > 0) {
        const id = craftMod.itemId(bot, 'raw_iron')
        if (id == null) throw new Error('no-ore-id')
        await win.putInput(id, null, oreLoad)
      }
      if (fuelLoad > 0) {
        // One fuel kind per cycle (core-1): coal and charcoal share the
        // single fuel slot, and transfer throws destination-full into a
        // slot holding the other kind. A holding slot tops up its own
        // kind only; an empty slot takes whichever single kind covers
        // the need (coal first), and a short kind waits for burn-down.
        const fuelSlot = typeof win.fuelItem === 'function' ? win.fuelItem() : null
        const fuelName = fuelSlot && fuelSlot.name
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
      // Settle: no ore anywhere = done; ore stranded with nothing
      // burnable and nothing taken = hungry.
      const oreLeft = inN + invOre
      const canBurn = fuelN > 0 || burning || fuelLoad > 0
      if (oreLeft === 0 && (outNow === 0 || took)) { finishSmelt(bot, ctx, f, 'done'); return }
      if (outNow === 0 && oreLeft > 0 && !canBurn) { finishSmelt(bot, ctx, f, 'no-fuel'); return }
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
  if (!ctx.furnace || ctx.furnace.settled) ctx.furnace = freshRun()
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
module.exports.furnaceReady = furnaceReady
module.exports.fuelPieces = fuelPieces
module.exports.FURNACE_REACH = FURNACE_REACH
module.exports.ORE_PER_FUEL = ORE_PER_FUEL
module.exports.COAL_RESERVE = COAL_RESERVE
