'use strict'

// beds: the two bedroom beds (idkcraft-jr2.2). Day-work goal step for v2
// houses: shears -> wool -> craft -> place. The bot's bed lands in bedroom A
// first (sleep sets the home respawn), the owner's in B second.
//
// No own hunt, no own craft (epic notes): wool comes from a self bring order
// (o.self — the did.3 mob rung hunts, the return phase keeps the goods, dusk
// cancels), beds and shears from did.2 craftItem. Placement goes through the
// south wall (furnace/light precedent — no day entry needed) with forced
// east yaw, so the head always lands +x: natural aim cannot fit both beds
// from any inside stance (assayed: no robust stance exists for bedroom B).
//
// Adopt-on-sight like the chest/furnace (memory drops the claims): a standing
// bed at the canonical cells is claimed, never rebuilt; a mined one retracts
// and the step remakes it.

const Vec3 = require('vec3')
const { goals } = require('mineflayer-pathfinder')
const woolMod = require('./wool')
const bedMod = require('./bed')
const bringMod = require('./bring')
const craftItem = require('./craftany')
const buildMod = require('./build')
const stockpileMod = require('./stockpile')
const { canBreak } = require('./util')

// Two beds of ONE color: 6 wool + 6 planks, single crafts (mixed woods land
// one bed at a time — a x2 plan would strand on 4 oak + 4 birch).
const WANT_WOOL = 6
const HUNT_REOPENS = 3 // short cancelled hunts reopen this often before failed:no-wool
const NOWOOL_LATCH = 2 // failed/partial wool hunts before beds latches off (9qt0: real time, persisted)
const LATCH_MS = 2 * 3600 * 1000 // a latch expires this long after its last failure
const SIGHT_MIN_MS = 30 * 60 * 1000 // ponytail: a sheep in sight reopens only past this age (unreachable-sheep loop cap)
const PLACE_REACH = 4
const PLACE_REFUSALS = 3
const STALL_TICKS = 30
const YAW_EAST = -Math.PI / 2 // head lands +x: A (1,4)->(2,4), B (4,4)->(5,4)
const WOOL16 = bedMod.BED_COLORS.map((c) => `${c}_wool`)
// Every plank wood incl. 26.x pale oak: the chest recovery pulls any wood.
const PLANK_NAMES = ['oak', 'spruce', 'birch', 'jungle', 'acacia', 'dark_oak', 'mangrove', 'cherry', 'bamboo', 'crimson', 'warped', 'pale_oak'].map((w) => `${w}_planks`)
const WITHDRAW_NEED = 6
const WITHDRAW_STALL_TICKS = 30

// Canonical bedroom cells, site-relative dy 0: A is the bot's (sleep sets the
// respawn), B the owner's. Single source of the bed geometry (home.js sleep
// reads it through a deferred require).
function cellsOf(home) {
  const s = home.site
  return {
    a: { foot: new Vec3(s.x + 1, s.y, s.z + 4), head: new Vec3(s.x + 2, s.y, s.z + 4) },
    b: { foot: new Vec3(s.x + 4, s.y, s.z + 4), head: new Vec3(s.x + 5, s.y, s.z + 4) },
  }
}

// Bedroom footprint test (idkcraft-4nx): the four bed cells of a v2 home.
// Furniture stations (equip's roadside table, stockpile's chest) must never
// land here — beds.js fails loud on blocked cells (blocked by X) by design,
// so the placer avoids them instead of the bed step digging furniture out.
// v1 homes have no bedrooms: always false.
function isBedroomCell(home, x, y, z) {
  try {
    if (!home || !home.site || home.v !== 2) return false
    const s = home.site
    if (typeof x !== 'number' || typeof y !== 'number' || typeof z !== 'number') return false
    if (y !== s.y || z !== s.z + 4) return false
    return x === s.x + 1 || x === s.x + 2 || x === s.x + 4 || x === s.x + 5
  } catch (_) {
    return false
  }
}

// Claim migration across a home replacement (idkcraft-ybt): a re-adopt swaps
// ctx.home for a fresh object at the SAME site, and the fresh object carries
// no bed claims — the respawn log then under-claims (plain instead of (bed))
// until the next sleep re-derives sleptA. Same-site only: a new site ('build
// here') means new bedrooms, and the old claims stay dropped. Never clobbers
// claims the new home already carries; adoptBeds still retracts verified
// ghosts the next tick.
function migrateClaims(oldHome, newHome) {
  try {
    if (!oldHome || !newHome) return newHome
    const a = oldHome.site
    const b = newHome.site
    if (!a || !b || a.x !== b.x || a.y !== b.y || a.z !== b.z) return newHome
    for (const k of ['bedA', 'bedB']) {
      const c = oldHome[k]
      if (c && typeof c.x === 'number' && !newHome[k]) newHome[k] = c
    }
    if (oldHome.sleptA === true && newHome.sleptA !== true) newHome.sleptA = true
  } catch (_) { /* claims best-effort */ }
  return newHome
}

function blockNameAt(bot, p) {
  try {
    const b = bot.blockAt && bot.blockAt(p)
    return b && typeof b.name === 'string' ? b.name : null
  } catch (_) {
    return null
  }
}

// The foot block when a whole bed stands on foot+east, else null (half beds
// and dark chunks read as no bed — sleep refuses halves, dark re-reads).
function bedAt(bot, foot) {
  try {
    const f = bot.blockAt && bot.blockAt(foot)
    if (!f || typeof f.name !== 'string' || !f.name.endsWith('_bed')) return null
    const h = blockNameAt(bot, new Vec3(foot.x + 1, foot.y, foot.z))
    if (!h || !h.endsWith('_bed')) return null
    return f
  } catch (_) {
    return null
  }
}

// Claim-aware placed truth, pure (never writes): a claim the world still
// shows stands; a dark chunk trusts its claim; otherwise the canonical
// cells scan.
function bedStands(bot, home, cells, k, key) {
  const claim = home[key]
  if (claim && typeof claim.x === 'number') {
    let f = null
    let loaded = false
    try {
      const b = bot.blockAt && bot.blockAt(new Vec3(claim.x, claim.y, claim.z))
      if (b) { loaded = true; f = b }
    } catch (_) { loaded = false }
    if (!loaded) return true
    if (f && typeof f.name === 'string' && f.name.endsWith('_bed') &&
      bedAt(bot, new Vec3(claim.x, claim.y, claim.z))) return true
  }
  return !!bedAt(bot, cells[k].foot)
}

// Ground a bed can stand on: the v2 house lays no floor, so the bedroom row
// sits on natural terrain — and terrain dips (rig-proven: air under A-foot
// while B stood). Air-like, water, and flora ground takes a plank patch
// before the bed; lava refuses loud (a patch would burn).
const AIR_LIKE = ['air', 'cave_air', 'void_air']
function needsFillGround(name) {
  if (!name || AIR_LIKE.includes(name) || name === 'water') return true
  try { if (buildMod.isReplaceable(name)) return true } catch (_) { /* solid: no patch */ }
  return false
}

// Patches owed under the feet+heads of unplaced beds (0-4, loaded cells
// only — dark is unknown, not owed): the stockpile plank reserve and the
// place pre-check count against this.
function fillNeed(bot, home) {
  try {
    if (!home || !home.site || home.v !== 2) return 0
    const cells = cellsOf(home)
    let n = 0
    for (const k of ['a', 'b']) {
      if (bedStands(bot, home, cells, k, k === 'a' ? 'bedA' : 'bedB')) continue
      for (const end of [cells[k].foot, cells[k].head]) {
        const g = blockNameAt(bot, new Vec3(end.x, end.y - 1, end.z))
        if (g !== null && needsFillGround(g)) n++
      }
    }
    return n
  } catch (_) { return 0 }
}

// A solid neighbour to patch a ground cell against (sides first, below
// last — never above: that cell holds the bed). Null when the hole has no
// walls: the place refuses loud, honestly.
function fillRef(bot, g) {
  const tries = [
    [new Vec3(1, 0, 0), new Vec3(-1, 0, 0)],
    [new Vec3(-1, 0, 0), new Vec3(1, 0, 0)],
    [new Vec3(0, 0, 1), new Vec3(0, 0, -1)],
    [new Vec3(0, 0, -1), new Vec3(0, 0, 1)],
    [new Vec3(0, -1, 0), new Vec3(0, 1, 0)],
  ]
  for (const [off, face] of tries) {
    const p = new Vec3(g.x + off.x, g.y + off.y, g.z + off.z)
    let ref = null
    try { ref = bot.blockAt && bot.blockAt(p) } catch (_) { ref = null }
    if (!ref || !ref.position || !ref.name) continue
    if (ref.name === 'lava' || needsFillGround(ref.name)) continue
    return { ref, face }
  }
  return null
}

// Whole bed at the canonical cells of bedroom a/b, else null.
function bedroomBed(bot, home, which) {
  try {
    if (!home || !home.site || home.v !== 2) return null
    const cells = cellsOf(home)[which]
    if (!cells) return null
    return bedAt(bot, cells.foot)
  } catch (_) {
    return null
  }
}

// Claim-aware placed truth, adopt-on-sight (writes claims): a claim the world
// still shows stands; a dark chunk trusts its claim (stationStanding rule —
// no cross-map adopt trip for a bed already claimed); a verified ghost
// retracts and the canonical cells re-adopt. v1 homes (no bedrooms) read none.
function adoptBeds(bot, home) {
  const out = { a: false, b: false }
  try {
    if (!home || !home.site || home.v !== 2) return out
    const cells = cellsOf(home)
    for (const k of ['a', 'b']) {
      const key = k === 'a' ? 'bedA' : 'bedB'
      const claim = home[key]
      if (claim && typeof claim.x === 'number') {
        let f = null
        let loaded = false
        try {
          const b = bot.blockAt && bot.blockAt(new Vec3(claim.x, claim.y, claim.z))
          if (b) { loaded = true; f = b }
        } catch (_) { loaded = false }
        if (!loaded) { out[k] = true; continue }
        if (f && typeof f.name === 'string' && f.name.endsWith('_bed') &&
          bedAt(bot, new Vec3(claim.x, claim.y, claim.z))) { out[k] = true; continue }
        try { delete home[key]; if (key === 'bedA') delete home.sleptA } catch (_) { /* retract best-effort */ }
      }
      const blk = bedAt(bot, cells[k].foot)
      if (blk) {
        try { home[key] = new Vec3(cells[k].foot.x, cells[k].foot.y, cells[k].foot.z) } catch (_) { /* claim best-effort */ }
        out[k] = true
      }
    }
  } catch (_) { /* unscannable reads as none: the step walks in to verify */ }
  return out
}

// Pure placed truth for goalFacts (never writes): claims verify-or-trust,
// unclaimed cells scan. Non-v2 homes owe no beds.
function bedsFact(bot, home) {
  try {
    if (!home || !home.site || home.v !== 2) return 'both'
    const cells = cellsOf(home)
    const a = bedStands(bot, home, cells, 'a', 'bedA')
    const b = bedStands(bot, home, cells, 'b', 'bedB')
    return a && b ? 'both' : a || b ? 'one' : 'none'
  } catch (_) {
    return 'both' // unreadable: beds yields, nothing churns
  }
}

function totalWool(pack) {
  let n = 0
  try {
    for (const [name, c] of Object.entries(pack || {})) {
      if (typeof name === 'string' && name.endsWith('_wool')) n += c || 0
    }
  } catch (_) { /* unreadable pack: no wool */ }
  return n
}

function maxWoodPlanks(pack) {
  let m = 0
  try {
    for (const [name, c] of Object.entries(pack || {})) {
      if (typeof name === 'string' && name.endsWith('_planks')) m = Math.max(m, c || 0)
    }
  } catch (_) { /* unreadable pack: no planks */ }
  return m
}

function bedItemsInPack(pack) {
  let n = 0
  try {
    for (const [name, c] of Object.entries(pack || {})) {
      if (typeof name === 'string' && name.endsWith('_bed')) n += c || 0
    }
  } catch (_) { /* unreadable pack: no beds */ }
  return n
}

// Pinned-color bed item first, then any bed — a mixed pair still sleeps.
function findBedItem(bot, color) {
  let any = null
  try {
    const items = bot.inventory.items()
    if (Array.isArray(items)) {
      for (const i of items) {
        if (!i || typeof i.name !== 'string' || !i.name.endsWith('_bed')) continue
        if (color && i.name === `${color}_bed`) return i
        if (!any) any = i
      }
    }
  } catch (_) { /* no inventory: no bed */ }
  return any
}

// Any plank wood (ground patches need not match the bed's).
function findPlankItem(bot) {
  try {
    const items = bot.inventory.items()
    if (Array.isArray(items)) {
      for (const i of items) {
        if (!i || typeof i.name !== 'string') continue
        if (PLANK_NAMES.includes(i.name)) return i
      }
    }
  } catch (_) { /* no inventory: no planks */ }
  return null
}

function totalPlanks(pack) {
  let n = 0
  try {
    for (const [name, c] of Object.entries(pack || {})) {
      if (typeof name === 'string' && name.endsWith('_planks')) n += c || 0
    }
  } catch (_) { /* unreadable pack: no planks */ }
  return n
}

// Shears when the pack can feed them (2+ ingots, tableless craft), else the
// wool hunt kills (killFood shears by itself when shears are in hand). An
// open craft run always drives through done (so the completion chats) —
// only a fresh tick with shears on hand skips straight to wool. Pack beds
// covering every bedroom skip the whole chain (reconnect with finished
// beds places, never re-hunts — revmux 01-review).
function shearsTick(bot, ctx, st, pack, craftsOwed) {
  if (craftsOwed <= 0) { st.phase = 'craft'; return }
  if (!ctx.craftany && woolMod.hasShears(bot)) { st.phase = 'wool'; return }
  if (!ctx.craftany && (pack.iron_ingot || 0) < 2) { st.phase = 'wool'; return }
  const res = craftItem(bot, ctx, 'shears', 1)
  if (res === 'running') return
  if (res && res.done) {
    st.phase = 'wool'
    try { bot.chat('made shears, going for wool') } catch (_) { /* chat best-effort */ }
    return
  }
  st.phase = 'wool' // craft failed: hunt and kill instead
  try { console.log(`beds shears: ${(res && res.line) || 'crafting failed'}, hunting instead`) } catch (_) { /* logging best-effort */ }
}

// Sheepless latch (idkcraft-9kd, 9qt0): the atl.4 stepFail hold releases on
// relocation — and a death-respawn IS a relocation. The 9kd per-MC-day latch
// still allowed 2 hunts every 20 real minutes and died with every restart
// (prod: 36% of all ticks hunting, ~50 of 61 deaths downstream). Now: the
// second failed/partial hunt latches beds off until a woolly sheep is in
// sight (and the last failure is SIGHT_MIN_MS old) or LATCH_MS passes.
// {fails, at} lives in ctx.beds.noWool and memory.js persists it, so death
// and restart both keep it. A sighting does not reset the count: the hunt
// it opens re-latches on failure.
function noteNoWool(st, now) {
  try {
    if (!st || typeof st !== 'object') return 0
    const t = typeof now === 'number' ? now : Date.now()
    const cur = st.noWool && typeof st.noWool === 'object' ? st.noWool : null
    const live = cur && typeof cur.at === 'number' && t - cur.at < LATCH_MS
    const fails = live ? (cur.fails || 0) + 1 : 1
    st.noWool = { fails, at: t }
    return fails
  } catch (_) { return 0 }
}

function sheepInSight(bot) {
  try {
    return !!bringMod.findAnimal(bot, null, { prey: ['sheep'], skipSheared: true })
  } catch (_) { return false }
}

// Menu gate: the latch, except 4+ string (the string rung needs no sheep).
function sheepLatched(ctx, bot, now) {
  try {
    const st = ctx && ctx.beds
    if (st && !st.stringDry && (bedMod.packCounts(bot).string || 0) >= 4) return false
  } catch (_) { /* unreadable pack: the latch decides */ }
  return latchLive(ctx, bot, now)
}

function latchLive(ctx, bot, now) {
  try {
    const st = ctx && ctx.beds
    const cur = st && st.noWool
    if (!cur || typeof cur !== 'object' || typeof cur.at !== 'number') return false
    if ((cur.fails || 0) < NOWOOL_LATCH) return false
    const age = (typeof now === 'number' ? now : Date.now()) - cur.at
    if (!(age < LATCH_MS)) return false
    return !(age >= SIGHT_MIN_MS && sheepInSight(bot))
  } catch (_) { return false }
}

// Wool through a self bring order (the did.3 mob rung): the return phase
// keeps the goods, dusk cancels, the bed step reopens in the morning. A hunt
// that searched the whole budget is genuinely sheepless (failed:no-wool, the
// menu hold throttles retries); anything shorter reopens — dusk cancels,
// foreign orders and early refusals must not fail the step.
function woolTick(bot, ctx, st, pack, craftsOwed) {
  // Wool owed scales with the crafts left (pack beds cover first): owe one
  // bed, hunt 3 wool — never the full 6 (revmux 01-review).
  const need = Math.max(1, (craftsOwed || 0)) * bedMod.BED_WOOL
  const color = bedMod.pickBedColor(pack)
  if (craftsOwed <= 0 || (color && (pack[`${color}_wool`] || 0) >= need)) {
    st.reopens = 0
    st.planksDry = false // fresh craft episode: retry the chest
    st.stringDry = false
    st.phase = 'craft'
    if (color && craftsOwed > 0) {
      try { bot.chat(`got ${pack[`${color}_wool`]} ${color} wool`) } catch (_) { /* chat best-effort */ }
    }
    return
  }
  if (ctx.bring) return // the ticker runs the hunt (ours or foreign) instead of this step
  // A failing hunt banks its wool first, then yields (9qt0).
  if (st.failing) {
    if (totalWool(pack) > 0 && bankWoolTick(bot, ctx, st)) return
    st.failing = false
    st.woolBanked = false
    ctx.stepStatus = 'failed:no-wool'
    return
  }
  const last = st.hunt
  if (last) {
    st.hunt = null
    let legs = 0
    let timedOut = false
    try { legs = (last.searchLegs && last.searchLegs.legs) || 0 } catch (_) { /* unreadable order: reopen */ }
    try { timedOut = !!(last.searchLegs && last.searchLegs.timedOut) } catch (_) { /* unreadable order: reopen */ }
    let capped = false
    try { capped = !!(last.searchLegs && last.searchLegs.capped) } catch (_) { /* unreadable order: reopen */ }
    const budget = (bringMod.SEARCH_BUDGET && bringMod.SEARCH_BUDGET.legs) || 24
    if (legs >= budget || timedOut || capped || (st.reopens || 0) >= HUNT_REOPENS) {
      st.reopens = 0
      noteNoWool(st)
      st.failing = true
      woolTick(bot, ctx, st, pack, craftsOwed)
      return
    }
    // Partial hunt (ipn.11): wool gained but the need still unmet — the old
    // code reopened forever ('searched 4 areas, only got 1', 7x a day) and
    // the latch never armed. A partial counts toward the latch, so two thin
    // hunts yield to gear until a sheep shows up.
    try {
      const atOpen = typeof st.huntWool === 'number' ? st.huntWool : null
      if (atOpen !== null && totalWool(pack) > atOpen) noteNoWool(st)
    } catch (_) { /* latch best-effort */ }
    st.reopens = (st.reopens || 0) + 1
  }
  // String rung (9qt0): 4 string -> 1 white wool (2x2, no table) before any
  // hunt — the bot kills spiders far more often than it finds sheep. A
  // failed craft goes dry until the next craft episode.
  const fromString = Math.floor((pack.string || 0) / 4)
  if (fromString > 0 && !st.stringDry) {
    const res = craftItem(bot, ctx, 'white_wool', fromString)
    if (res === 'running') return
    if (!(res && res.done)) st.stringDry = true
    return // recount next tick
  }
  // The latch armed (the second partial above) or was restored: the menu
  // only re-reads feasible on a re-decide, so the running step must not
  // reopen a hunt itself (revmux 01: the string exemption and a partial
  // close both reached here latched). The string rung above already ran.
  if (latchLive(ctx, bot)) {
    st.reopens = 0
    st.failing = true
    woolTick(bot, ctx, st, pack, craftsOwed)
    return
  }
  // Chest-first while the pack is short overall (the did.1 ladder pulls
  // banked wool, then the mob rung hunts the rest); direct mob rung on mixed
  // packs (a re-fetch would return at once and loop — the hunt tops up the
  // top color instead, no first-color lock by did.3 construction).
  const direct = totalWool(pack) >= need
  const base = { kind: 'item', name: 'wool', names: WOOL16.slice(), want: need, by: null, drop: null, have: 0 }
  let o = null
  try {
    o = direct ? bringMod.toWoolHunt(bot, base) : { ...base, phase: bringMod.openPhase(ctx), announced: false }
  } catch (_) { o = null }
  if (!o) { ctx.stepStatus = 'failed:no-wool'; return }
  o.self = 'beds'
  st.hunt = o
  try { st.huntWool = totalWool(pack) } catch (_) { /* latch best-effort */ }
  ctx.bring = o
}

// Single bed crafts until every unplaced bedroom is covered; the color pins
// to the first pick while it covers 3 wool (both beds usually match, a flip
// still sleeps). Failures diagnose from the pack: wool-short re-hunts,
// plank-short recovers banked planks from the home chest first (pre-reserve
// runs banked them), then yields to gather (the menu's bed-short clause).
function craftTick(bot, ctx, st, pack, placed, craftsOwed) {
  if (craftsOwed <= 0) { st.phase = 'place'; return }
  let color = st.color
  if (!color || (pack[`${color}_wool`] || 0) < bedMod.BED_WOOL) {
    color = bedMod.pickBedColor(pack)
    st.color = color
  }
  if (!color || (pack[`${color}_wool`] || 0) < bedMod.BED_WOOL) { st.phase = 'wool'; return }
  const res = craftItem(bot, ctx, bedMod.bedTarget(color), 1)
  if (res === 'running') return
  if (res && res.done) return // recount next tick
  // Diagnose against the crafts left, not the bedrooms (pack beds already
  // cover: a plank-short second craft must not re-hunt wool — revmux
  // 01-review).
  const short = bedMod.bedShortfall(pack, color, craftsOwed)
  if (short.wool > 0) { st.color = null; st.phase = 'wool'; return }
  // Same-wood, not summed: bed variants bind one wood (mixed 2+2+2 is short).
  if (maxWoodPlanks(pack) < bedMod.BED_PLANKS) {
    if (plankWithdrawTick(bot, ctx, st)) return // recovering or walking
    ctx.stepStatus = 'failed:no-planks'
    return
  }
  ctx.stepStatus = 'failed:cant-craft-bed'
}

// Pull banked planks back from the home chest (through-wall reach, no entry).
// True while recovering/walking (retry next tick); false when there is no
// chest, it is unreachable, or it holds no planks (caller yields to gather).
function plankWithdrawTick(bot, ctx, st) {
  if (st.planksDry) return false
  return chestTick(bot, ctx, st, 'beds-planks', async () => {
    try {
      const r = await stockpileMod.withdrawAnyFromChest(bot, ctx, PLANK_NAMES, WITHDRAW_NEED)
      st.planksDry = !(r && r.got > 0)
    } catch (_) {
      st.planksDry = true // a failed fetch reads as dry: gather feeds
    }
  })
}

// Bank the pack's wool before the step yields (9qt0: prod lost every
// partial to death, so 3 wool never accumulated; the next hunt is
// chest-first and takes it back). True while walking/depositing; false
// once banked, or when there is no reachable chest.
function bankWoolTick(bot, ctx, st) {
  if (st.woolBanked) return false
  const busy = chestTick(bot, ctx, st, 'beds-bank', async () => {
    try { await stockpileMod.depositToChest(bot, ctx, WOOL16) } catch (_) { /* banking best-effort */ }
    st.woolBanked = true
  })
  if (!busy) st.woolBanked = true // no chest or unreachable: yield with the pack
  return busy
}

// Walk to the home chest and run one async op there (one flight at a time).
// True while walking or in flight; false when there is no chest or it is
// unreachable.
function chestTick(bot, ctx, st, key, op) {
  // Adopt-on-sight (stockpile mirror): a fresh session has no chest claim
  // until stockpile runs, and the withdraw must not instant-fail for that.
  try {
    const home = ctx.home
    if (home && home.site && (!home.chest || typeof home.chest.x !== 'number')) {
      for (const s of stockpileMod.spotsFor(home)) {
        let nm = null
        try {
          const b = bot.blockAt && bot.blockAt(new Vec3(home.site.x + s.dx, home.site.y + s.dy, home.site.z + s.dz))
          nm = b && b.name
        } catch (_) { nm = null }
        if (nm === 'chest') {
          home.chest = new Vec3(home.site.x + s.dx, home.site.y + s.dy, home.site.z + s.dz)
          break
        }
      }
    }
  } catch (_) { /* unadopted: fall through to the claim check */ }
  const c = ctx.home && ctx.home.chest
  if (!c || typeof c.x !== 'number') return false
  const bp = bot.entity && bot.entity.position
  if (!bp || typeof bp.x !== 'number') return true
  const reach = stockpileMod.INTERACT_REACH || 3.6
  if (Math.hypot(bp.x - c.x, bp.y - c.y, bp.z - c.z) > reach) {
    if (ctx.lastGoalKey !== key) {
      // Range 3 stops at through-wall reach (the chest sits a cell inside
      // the walls; the walk must not need entry).
      try { bot.pathfinder.setGoal(new goals.GoalNear(c.x, c.y, c.z, 3), false) } catch (_) { /* retry next tick */ }
      ctx.lastGoalKey = key
      st.wdStalls = 0
      st.wdAnchor = { x: bp.x, z: bp.z }
      return true
    }
    const a = st.wdAnchor
    if (!a || Math.hypot(bp.x - a.x, bp.z - a.z) > 0.5) {
      st.wdStalls = 0
      st.wdAnchor = { x: bp.x, z: bp.z }
    } else if (++st.wdStalls >= WITHDRAW_STALL_TICKS) {
      return false // unreachable: the caller yields
    }
    return true
  }
  if (ctx.bedsWithdrawInFlight) return true
  ctx.bedsWithdrawInFlight = true
  void (async () => {
    try {
      await op()
    } catch (_) { /* op owns its outcome */ } finally {
      ctx.bedsWithdrawInFlight = false
    }
  })()
  return true
}

// Bot's bed first, owner's second, staged south of the foot through the wall.
function placeTick(bot, ctx, st, placed) {
  const which = !placed.a ? 'a' : 'b'
  const item = findBedItem(bot, st.color)
  if (!item) { st.planksDry = false; st.phase = 'craft'; return } // pack lost the bed: make another
  const cells = cellsOf(ctx.home)
  const foot = cells[which].foot
  const head = cells[which].head
  const stage = { x: foot.x, y: foot.y, z: foot.z + 2 }
  const bp = bot.entity && bot.entity.position
  if (!bp || typeof bp.x !== 'number') return
  // Patch planks before the walk: a floorless-house dip under this bed needs
  // its planks packed, else the chest recovery (then gather) feeds them.
  const fillsOwed = [foot, head].filter((end) =>
    needsFillGround(blockNameAt(bot, new Vec3(end.x, end.y - 1, end.z)))).length
  if (fillsOwed > 0 && totalPlanks(bedMod.packCounts(bot)) < fillsOwed) {
    if (plankWithdrawTick(bot, ctx, st)) return // recovering or walking
    ctx.stepStatus = 'failed:no-planks'
    return
  }
  if (st.failKey !== which) { st.failKey = which; st.fails = 0; st.stalls = 0; st.anchor = null }
  if (Math.hypot(bp.x - foot.x, bp.y - foot.y, bp.z - foot.z) > PLACE_REACH) {
    const key = `beds-place:${which}`
    if (ctx.lastGoalKey !== key) {
      try { bot.pathfinder.setGoal(new goals.GoalNear(stage.x, stage.y, stage.z, 1), false) } catch (_) { /* retry next tick */ }
      ctx.lastGoalKey = key
      st.stalls = 0
      st.anchor = { x: bp.x, z: bp.z }
      return
    }
    const a = st.anchor
    if (!a || Math.hypot(bp.x - a.x, bp.z - a.z) > 0.5) {
      st.stalls = 0
      st.anchor = { x: bp.x, z: bp.z }
    } else if (++st.stalls >= STALL_TICKS) {
      ctx.stepStatus = 'failed:cant-reach-bed'
      return
    }
    return
  }
  ctx.placeInFlight = true
  const fails = () => st.fails || 0
  const placedNow = () => {
    const f = blockNameAt(bot, foot)
    const h = blockNameAt(bot, head)
    return !!(f && f.endsWith('_bed') && h && h.endsWith('_bed'))
  }
  const claimIt = () => {
    st.fails = 0
    try { ctx.home[which === 'a' ? 'bedA' : 'bedB'] = new Vec3(foot.x, foot.y, foot.z) } catch (_) { /* claim best-effort */ }
    try { if (which === 'a') delete ctx.home.sleptA } catch (_) { /* a fresh bed needs a fresh sleep */ }
    try { bot.chat(which === 'a' ? 'my bed is in' : 'your bed is in') } catch (_) { /* chat best-effort */ }
  }
  ;(async () => {
    try {
      // Idempotent success first: a raced earlier flight may have placed the
      // bed while its own verify missed the head packet (foot acks first) —
      // a standing bed claims and chats, never re-places.
      if (placedNow()) { claimIt(); return }
      // Flora in the way clears first (own bedroom, guarded); a half bed or
      // anything solid fails loud for the owner to clear by hand (bed halves
      // are guard-protected, never self-dug).
      for (const cell of [foot, head]) {
        let cur = null
        try { cur = bot.blockAt && bot.blockAt(cell) } catch (_) { cur = null }
        const nm = cur && cur.name
        if (!nm || nm === 'air' || nm === 'cave_air' || nm === 'void_air') continue
        if (!buildMod.isReplaceable(nm)) throw new Error(`blocked by ${nm}`)
        if (typeof bot.dig !== 'function' || !cur) throw new Error(`blocked by ${nm}`)
        if (!canBreak(bot, cur, ctx)) throw new Error(`blocked by ${nm}`)
        try { await bot.dig(cur) } catch (_) { /* retry next tick */ }
      }
      // Patch missing ground first (foot then head — a fresh foot patch
      // walls the head hole): a plank against a solid neighbour, same forced
      // through-wall place as the bed. Lava refuses loud, a patch would burn.
      for (const end of [foot, head]) {
        const g = new Vec3(end.x, end.y - 1, end.z)
        const gn = blockNameAt(bot, g)
        if (gn === 'lava') throw new Error('no ground under the bed')
        if (!needsFillGround(gn)) continue
        const fr = fillRef(bot, g)
        if (!fr) throw new Error('no ground under the bed')
        const patch = findPlankItem(bot)
        if (!patch) throw new Error('patch planks lost mid-flight')
        if (typeof bot.equip === 'function') await bot.equip(patch, 'hand')
        if (typeof bot._placeBlockWithOptions === 'function') {
          await bot._placeBlockWithOptions(fr.ref, fr.face, { forceLook: 'ignore' })
        } else {
          await bot.placeBlock(fr.ref, fr.face)
        }
        await new Promise((resolve) => setTimeout(resolve, 500))
        if (needsFillGround(blockNameAt(bot, g))) throw new Error('ground patch did not take')
      }
      let ref = null
      try { ref = bot.blockAt && bot.blockAt(new Vec3(foot.x, foot.y - 1, foot.z)) } catch (_) { ref = null }
      if (!ref || !ref.position || !ref.name || ref.name === 'air') throw new Error('no ground under the bed')
      if (typeof bot.equip === 'function') await bot.equip(item, 'hand')
      if (typeof bot.look === 'function') await bot.look(YAW_EAST, 0)
      if (typeof bot._placeBlockWithOptions === 'function') {
        await bot._placeBlockWithOptions(ref, new Vec3(0, 1, 0), { forceLook: 'ignore' })
      } else {
        await bot.placeBlock(ref, new Vec3(0, 1, 0))
      }
      // The foot acks first; the head packet lands a tick later (rig-proven:
      // a same-microtask verify misses the head every time). Settle like the
      // craft verify, then read.
      await new Promise((resolve) => setTimeout(resolve, 500))
      if (placedNow()) claimIt()
      else st.fails = fails() + 1
    } catch (err) {
      st.fails = fails() + 1
      if (fails() === 1) {
        try { console.log(`beds place ${which} refused: ${err && err.message ? err.message : err}`) } catch (_) { /* logging best-effort */ }
      }
    } finally {
      ctx.placeInFlight = false
    }
    if (fails() >= PLACE_REFUSALS) ctx.stepStatus = 'failed:cant-place-bed'
  })().catch(() => { ctx.placeInFlight = false })
}

function beds(bot, ctx, target, state) {
  const home = ctx && ctx.home
  if (!home || !home.site || home.v !== 2) {
    ctx.stepStatus = 'failed:no-house'
    return
  }
  if (ctx.placeInFlight) return // one async place flight (build/light shape)
  if (!ctx.beds || typeof ctx.beds !== 'object') ctx.beds = { phase: 'shears' }
  const st = ctx.beds
  let placed = { a: false, b: false }
  try { placed = adoptBeds(bot, home) } catch (_) { /* unscannable: phases verify */ }
  if (placed.a && placed.b) {
    ctx.stepStatus = 'done'
    try { bot.chat('both beds are in') } catch (_) { /* chat best-effort */ }
    return
  }
  const pack = bedMod.packCounts(bot)
  const missing = (placed.a ? 0 : 1) + (placed.b ? 0 : 1)
  const craftsOwed = Math.max(0, missing - bedItemsInPack(pack))
  if (!st.phase) st.phase = 'shears'
  if (st.phase === 'shears') shearsTick(bot, ctx, st, pack, craftsOwed)
  else if (st.phase === 'wool') woolTick(bot, ctx, st, pack, craftsOwed)
  else if (st.phase === 'craft') craftTick(bot, ctx, st, pack, placed, craftsOwed)
  else if (st.phase === 'place') placeTick(bot, ctx, st, placed)
  else st.phase = 'shears'
}

module.exports = beds
module.exports.cellsOf = cellsOf
module.exports.isBedroomCell = isBedroomCell
module.exports.migrateClaims = migrateClaims
module.exports.bedAt = bedAt
module.exports.bedroomBed = bedroomBed
module.exports.adoptBeds = adoptBeds
module.exports.bedsFact = bedsFact
module.exports.sheepLatched = sheepLatched
module.exports.NOWOOL_LATCH = NOWOOL_LATCH
module.exports.LATCH_MS = LATCH_MS
module.exports.SIGHT_MIN_MS = SIGHT_MIN_MS
module.exports.fillNeed = fillNeed
module.exports.needsFillGround = needsFillGround
module.exports.WANT_WOOL = WANT_WOOL
