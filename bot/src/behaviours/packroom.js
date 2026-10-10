'use strict'

// Pack room and the adopted-chest window, moved verbatim out of stockpile.js
// (idkcraft-oqul.14): craft.js, gear.js, deep.js, forage.js and equip.js all
// read these, and the craft<->stockpile and gear->stockpile require edges
// closed 7 of the last require cycles. stockpile.js re-exports every name,
// so its other callers (bring, bringitem, gather, castlefetch, goal) do not
// move in this PR. Leaf: perception/vec3 only, plus a deferred deliver read
// for the reserve corner (deliver never requires this module back).

const { countItems } = require('../perception')
const { Vec3 } = require('vec3')

// Wood ceiling (idkcraft-g0z.26): while the castle is open the pack keeps
// one stack of planks and one gather load of logs — enough for any single
// wood batch (planks 32 + fence/door/chest crafts, frame 14) plus the
// sticks/torches the other steps drink from it — and banks the rest. Before,
// the castle reserve kept every plank packed while forage chopped and craft
// converted without a limit: prod held ~700 planks in 11 slots, the pack
// filled, and dig drops were lost. LOG_KEEP mirrors goal NEED_LOGS (no
// shared import: packroom must not require goal — goal requires stockpile,
// which requires packroom). The ceiling only applies on a built home:
// pre-house the budget needs every plank packed.
const PLANK_KEEP = 64
const LOG_KEEP = 14

function castleWoodOpen(ctx) {
  try {
    return !!(ctx && ctx.castle && ctx.castle.phase !== 'complete' && ctx.home && ctx.home.built)
  } catch (_) {
    return false
  }
}
// True when the pack holds planks past the ceiling (goal craft gate, craft
// conversion guard, forage log skip). Planks only (revmux 01 minor): logs
// at/above NEED_LOGS must still convert — conversion is what frees the log
// slot, and the depositPlan/surplusWood banking still caps logs at
// LOG_KEEP. Fail-open: an unreadable inventory reads empty, the old
// behaviour. Built home only, castle phase ignored (ipn.17): a complete
// castle used to lift the ceiling and craft converted logs into a 13-stack
// plank pile, tossing sticks for room. Pre-house the budget needs every
// plank packed.
function woodCapped(bot, ctx) {
  try {
    if (!(ctx && ctx.home && ctx.home.built)) return false
    return countItems(bot, (n) => n.endsWith('_planks')) >= PLANK_KEEP
  } catch (_) {
    return false
  }
}
// Reserved slot (g0z.26 R2, revmux 01 major): with no adopted chest and
// nobody online the pack must never fill past PACK_RESERVE — the last slot
// is the bootstrap chest craft's room. A 36/36 chestless pack has no drain
// that is not tossing (the owner forbids it), so diggers and crafts yield
// here instead of filling it. Binds ONLY in that corner: an adopted chest
// (banking drains, however far) or any player online (the haul drains)
// opens every gate, and pre-house the budget owns the pack. Forage's chest
// quest is exempt while it can complete (forage.js questExempt).
const PACK_RESERVE = 35
function packStacks(bot) {
  try {
    const items = invItems(bot)
    return Array.isArray(items) ? items.length : 0
  } catch (_) {
    return 0
  }
}
// The reserve corner without the stack count (forage.js chest quest): built,
// chestless and alone. The quest completes early, before the reserve binds.
function reserveCorner(bot, ctx) {
  try {
    if (!ctx || !ctx.home || !ctx.home.built) return false
    if (ctx.home.chest) return false
    let level = 'none'
    try {
      level = require('./deliver').playerStatus(bot).level
    } catch (_) {
      level = 'none'
    }
    return level === 'none'
  } catch (_) {
    return false
  }
}
function slotReserved(bot, ctx) {
  try {
    return reserveCorner(bot, ctx) && packStacks(bot) >= PACK_RESERVE
  } catch (_) {
    return false
  }
}

function invItems(bot) {
  try {
    const items = bot && bot.inventory && typeof bot.inventory.items === 'function' ? bot.inventory.items() : []
    return Array.isArray(items) ? items : []
  } catch (_) {
    return []
  }
}

// Above-ceiling wood in inventory order, keep-first (the ensureRoom bank
// list, craft.js). Empty when the ceiling is off.
function surplusWood(bot, ctx) {
  const out = []
  try {
    if (!castleWoodOpen(ctx)) return out
    let kp = PLANK_KEEP
    let kl = LOG_KEEP
    for (const i of invItems(bot)) {
      if (!i || typeof i.name !== 'string') continue
      const n = typeof i.count === 'number' ? i.count : 1
      if (i.name.endsWith('_planks')) {
        const k = Math.min(kp, n)
        kp -= k
        if (n - k > 0) out.push({ name: i.name, count: n - k })
      } else if (i.name.endsWith('_log')) {
        const k = Math.min(kl, n)
        kl -= k
        if (n - k > 0) out.push({ name: i.name, count: n - k })
      }
    }
  } catch (_) { /* unreadable inventory: no surplus */ }
  return out
}

// Container/place interaction reach: isMoving()==false is not arrival (no
// path reads the same), so window ops double-check the body is close
// instead of eating mineflayer's 20 s windowOpen timeout (revmux 01-review).
const INTERACT_REACH = 4

// Open the adopted chest (or the explicit chest at `at` — g0z.4 castle
// chest; ctx.home is never swapped), run fn(window), always close.
// { status: 'ok', value } | 'gone' | 'unknown' | 'error'.
// Unknown (blockAt null: unloaded chunk) is NOT gone — the caller walks
// closer and retries instead of dropping the adoption. An open throw on a
// LOADED chest (blocked lid, cat, lag) is an error, never unknown: the
// caller fails loud so failHolds parks the step (revmux 02-review).
async function withChest(bot, ctx, fn, at = null) {
  const c = at || (ctx && ctx.home && ctx.home.chest)
  if (!c || typeof bot.openChest !== 'function') return { status: 'gone' }
  let block = null
  let unknown = false
  try {
    block = bot.blockAt(new Vec3(c.x, c.y, c.z))
    if (!block) unknown = true
  } catch (_) { unknown = true }
  if (!block) return { status: unknown ? 'unknown' : 'gone' }
  if (block.name !== 'chest') return { status: 'gone' }
  try {
    const window = await bot.openChest(block)
    try {
      return { status: 'ok', value: await fn(window) }
    } finally {
      try { window.close() } catch (_) { /* close best-effort */ }
    }
  } catch (_) {
    return { status: 'error' }
  }
}

// Withdraw up to count of name from the adopted chest. { got } — 0 when the
// chest is gone, empty of name, or the inventory is full.
async function withdrawFromChest(bot, ctx, name, count) {
  try {
    const res = await withChest(bot, ctx, async (window) => {
      const stacks = typeof window.containerItems === 'function' ? window.containerItems() : []
      let want = count
      let got = 0
      if (Array.isArray(stacks)) {
        for (const s of stacks) {
          if (want <= 0) break
          if (!s || s.name !== name) continue
          const take = Math.min(typeof s.count === 'number' ? s.count : 1, want)
          if (take <= 0) continue
          await window.withdraw(s.type, s.metadata, take)
          want -= take
          got += take
        }
      }
      return got
    })
    return { got: res && res.status === 'ok' ? res.value : 0 }
  } catch (_) {
    return { got: 0 }
  }
}

module.exports = {
  PLANK_KEEP,
  LOG_KEEP,
  PACK_RESERVE,
  INTERACT_REACH,
  castleWoodOpen,
  woodCapped,
  packStacks,
  reserveCorner,
  slotReserved,
  invItems,
  surplusWood,
  withChest,
  withdrawFromChest,
}
