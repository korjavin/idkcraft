'use strict'

// Stock-first planning (idkcraft-2ket): remembered chest stock for the
// planner decision. packroom.withChest snapshots every opened chest into
// ctx.chestLast.{home,site,castle}.contents (the qxql.9 last-read cache);
// fetch/craft planners consult it FIRST, alongside the inventory, and route
// to a withdraw instead of planning a gather/mine leg when the remembered
// stock covers the need. Pure reads over ctx — never opens a chest, never
// writes. Fail-open everywhere: unknown reads as no stock, so unstocked
// plans exactly as today.
//
// Asymmetry note: over-trust only costs a chest walk — the withdraw legs
// verify live (chestCounts/peek before they draw) and fall through to the
// world stages when the snapshot went stale. Under-trust (stale-empty)
// plans as today. The planners below only skip world legs where a withdraw
// path still runs (gear withdraw action, the castlefetch leg itself), so a
// covered need never strands: the house-budget chop stays stock-blind on
// purpose (no house-plank withdraw leg exists to serve it).

// Chest slots the legs source from (packroom.chestSlot): the adopted home
// chest, the castle site chest, and the footprint (owner) chest.
const SLOTS = ['home', 'site', 'castle']

// Last-seen contents of one slot, or {} when never opened / unreadable.
function slotContents(ctx, slot) {
  try {
    const s = ctx && ctx.chestLast && ctx.chestLast[slot]
    const c = s && s.contents
    if (!c || typeof c !== 'object' || Array.isArray(c)) return {}
    return c
  } catch (_) {
    return {}
  }
}

// Exact-name sum over slots. Names is a string or an array of item names.
function stockInSlots(ctx, slots, names) {
  try {
    const list = typeof names === 'string' ? [names] : names
    if (!Array.isArray(list) || list.length === 0) return 0
    const want = new Set(list.filter((n) => typeof n === 'string'))
    if (want.size === 0) return 0
    const ss = Array.isArray(slots) ? slots : [slots]
    let n = 0
    for (const slot of ss) {
      const c = slotContents(ctx, slot)
      for (const k of Object.keys(c)) {
        if (!want.has(k)) continue
        const v = c[k]
        if (typeof v === 'number' && v > 0) n += Math.floor(v)
      }
    }
    return n
  } catch (_) {
    return 0
  }
}

// Adopted-home-chest stock (gear's withdraw draws the home chest only, so
// its cover reads home-only). Stale snapshots of a lost adoption read 0:
// without ctx.home.chest there is no pantry to draw.
function homeStockOf(ctx, names) {
  try {
    if (!ctx || !ctx.home || !ctx.home.chest) return 0
    return stockInSlots(ctx, ['home'], names)
  } catch (_) {
    return 0
  }
}

// Home/site/castle stock (the castlefetch leg's withdraw walks all three,
// pickChest source order). Site/castle snapshots key on the live adoption,
// so they read only under an active castle order.
function fetchStockOf(ctx, names, bot = null, kind = null) {
  try {
    const home = homeStockOf(ctx, names) // adoption-guarded inside
    if (!ctx || !ctx.castle) return home
    return home + stockInSlots(ctx, ['site', 'castle'], names) + rememberedStockOf(ctx, names, bot, kind)
  } catch (_) {
    return 0
  }
}

// y7lp.3: snapshots of other remembered chests (ctx.chests), the home and
// site chests excluded (their slots count above). Counts only what
// castlefetch.pickChest could pick: in its radius of the body, not dry for kind.
// = stockpile.NEARBY_CHEST_RADIUS and castlefetch.CHEST_DRY_MS (a require
// would be a cycle; the y7lp3 test pins them equal).
const REMEMBERED_RADIUS = 32
const REMEMBERED_DRY_MS = 10 * 60 * 1000
function rememberedStockOf(ctx, names, bot, kind) {
  try {
    const bp = bot && bot.entity && bot.entity.position
    if (!bp || !kind) return 0 // no anchor: no claim (pickChest needs the body too)
    const dry = ctx.castleChestDry || {}
    const want = new Set(typeof names === 'string' ? [names] : names)
    const key = (c) => c ? `${c.x},${c.y},${c.z}` : null
    const skip = new Set([key(ctx.home && ctx.home.chest), key(ctx.castle && ctx.castle.siteChest)])
    let n = 0
    for (const c of Array.isArray(ctx.chests) ? ctx.chests : []) {
      if (!c || !c.contents || skip.has(key(c))) continue
      if (Math.hypot(bp.x - c.x, bp.y - c.y, bp.z - c.z) > REMEMBERED_RADIUS) continue
      if (Date.now() - (dry[`${kind}@${key(c)}`] ?? -Infinity) < REMEMBERED_DRY_MS) continue
      for (const [k, v] of Object.entries(c.contents)) if (want.has(k) && typeof v === 'number' && v > 0) n += Math.floor(v)
    }
    return n
  } catch (_) {
    return 0
  }
}

// A home-chest read that exists but is older than ms (woodstarve): gather
// re-opens it before chopping. No read at all is not stale (never drawn).
function homeChestStale(ctx, ms = 30 * 60 * 1000) {
  const last = ctx && ctx.home && ctx.home.chest && ctx.chestLast && ctx.chestLast.home
  return !!(last && typeof last.at === 'number' && Date.now() - last.at >= ms)
}

// Plank-equivalent wood in the home-chest read (0 if unknown or older than
// ms: a stale-high read must not stop the chop; gather re-reads it first).
function homeChestWood(ctx, ms = 30 * 60 * 1000) {
  let n = 0
  try {
    const last = ctx && ctx.home && ctx.home.chest && ctx.chestLast && ctx.chestLast.home
    if (!last || !(Date.now() - last.at < ms)) return 0
    for (const [name, v] of Object.entries(slotContents(ctx, 'home'))) {
      const k = typeof v === 'number' ? v : 0
      if (name.endsWith('_planks')) n += k
      else if (name.endsWith('_log') || name.endsWith('_stem')) n += k * 4
    }
  } catch (_) { return 0 }
  return n
}

module.exports = { REMEMBERED_RADIUS, REMEMBERED_DRY_MS, homeChestWood, homeChestStale, SLOTS, slotContents, stockInSlots, homeStockOf, fetchStockOf }
