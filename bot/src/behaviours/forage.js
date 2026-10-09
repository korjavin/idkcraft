'use strict'

// Forage step (idkcraft-atl.2): dig the best remembered find and bank the
// haul for deliver. Reads the resource memory (explore/scout fills it),
// never searches live: the nearest valuable known cell is the target.
//
// Value rank (bead): diamonds > gold/iron > coal/lapis/copper/etc >
// logs > food animals (live fallback when memory is empty of diggables).
// Ore needs a pickaxe of the right tier (bring.js check, shared); logs
// need no tools. Batch: FORAGE_WANT new drops, then done.
//
// Shared with bring.js, not copied: dropFor/isBringable/needsPickaxe/
// hasPickaxe/findAnimal/progressed/entityById/PREY_* (pure helpers). The
// phase machine itself is forage-shaped (memory target, batch haul, no
// return leg — deliver owns that), so walk/dig/pickup run here on the
// same patterns. Like bring, forage raises NO stuck facts: a stalled or
// no-path leg STRIKES its cell (ctx.forageSkip, gather atl.5 pattern) and
// replans to another point; three strikes fail the step unreachable. Skip,
// never forget: forgetting flips known=near to none, which defeats the
// atl.4 hold and loops forage->explore->forage on every rescan.

const { goals } = require('mineflayer-pathfinder')
const { Vec3 } = require('vec3')
const resources = require('../resources')
const bring = require('./bring')
const fightMod = require('./fight')
const detour = require('../detour')
const { say, clearGoal, botPos, denyReason, logDeny, solidBelow, protectedReason } = require('./util')

const FORAGE_WANT = 8 // new drops per step, then deliver
const WALK_STALL_TICKS = 10
const WALK_RANGE = 2
const UNREACHABLE_STRIKES = 3 // struck cells before failed:unreachable, like gather
const GATED_MAX = 3 // instant fails through the final gate before a forced honest retry (atl.10)

// Memory value rank: lower is better. Unknown ores rank with coal-tier;
// anything not ore/log ranks below logs (never picked: only ore/log/food
// plans exist).
function valueRank(name) {
  if (typeof name !== 'string') return 99
  if (/(diamond|emerald)_ore$/.test(name)) return 0
  if (/(gold|iron)_ore$/.test(name)) return 1
  if (name.endsWith('_ore')) return 2
  if (name.endsWith('_log')) return 3
  return 99
}


function dist(a, b) {
  try {
    if (a && typeof a.distanceTo === 'function' && b) return a.distanceTo(b)
  } catch (_) { /* fall through */ }
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)
}

// Best diggable memory cell: lowest rank, then nearest. Ore without the
// right pickaxe is skipped (bring.js tier check). Pure: no movement, no
// ctx writes — goal.js feasible() shares this.
function skipSet(ctx) {
  try {
    if (!ctx.forageSkip) ctx.forageSkip = new Set()
    if (typeof ctx.forageSkip.has !== 'function') ctx.forageSkip = new Set()
    return ctx.forageSkip
  } catch (_) {
    return null
  }
}

function cellKey(p) {
  return `${p.x},${p.y},${p.z}`
}

function packWood(bot) {
  const out = { stacks: 0, planks: 0, plankRoom: new Map(), logRoom: new Map(), logCount: new Map(), plankCount: new Map() }
  try {
    const items = (bot && bot.inventory && typeof bot.inventory.items === 'function' && bot.inventory.items()) || []
    if (!Array.isArray(items)) return out
    out.stacks = items.length
    for (const s of items) {
      if (!s || typeof s.name !== 'string') continue
      const n = typeof s.count === 'number' ? s.count : 1
      const cap = s && typeof s.stackSize === 'number' && s.stackSize > 0 ? s.stackSize : 64
      if (s.name.endsWith('_planks')) {
        out.planks += n
        const wood = s.name.slice(0, -7)
        out.plankRoom.set(wood, (out.plankRoom.get(wood) || 0) + Math.max(0, cap - n))
        out.plankCount.set(wood, (out.plankCount.get(wood) || 0) + n)
      } else if (s.name.endsWith('_log')) {
        const wood = s.name.slice(0, -4)
        out.logRoom.set(wood, (out.logRoom.get(wood) || 0) + Math.max(0, cap - n))
        out.logCount.set(wood, (out.logCount.get(wood) || 0) + n)
      }
    }
  } catch (_) { /* unreadable pack: no quest */ }
  return out
}
function woodOfLog(name) {
  return typeof name === 'string' && name.endsWith('_log') ? name.slice(0, -4) : null
}
// Chest quest (g0z.26 R2, revmux 01 major): with no adopted chest and fewer
// than 8 planks the next chest needs wood — forage prefers logs over ore so
// the quest completes at low pack counts, before the reserve binds. Returns
// the pack's plank woods (empty set when plankless), or null when the quest
// is off. The 8 counts the largest SINGLE wood like goal.js maxPlanks (R3,
// revmux 02 major): a mixed 4+4 still cannot fund the chest. Deferred
// require (goal.js loads forage at top).
function questPlankWoods(bot, ctx) {
  try {
    const stockpile = require('./stockpile')
    if (!stockpile || typeof stockpile.reserveCorner !== 'function') return null
    if (!stockpile.reserveCorner(bot, ctx)) return null
    const pw = packWood(bot)
    let max = 0
    for (const n of pw.plankCount.values()) if (n > max) max = n
    if (max >= 8) return null
    return new Set(pw.plankCount.keys())
  } catch (_) {
    return null
  }
}
// Log batch the quest chops to (goal.js NEED_LOGS, deferred: goal loads
// forage at top). Falls back to 14 when goal is unreadable.
function questBatch() {
  try {
    const g = require('../goal')
    if (g && typeof g.NEED_LOGS === 'number' && g.NEED_LOGS > 0) return g.NEED_LOGS
  } catch (_) { /* unreadable: 14 */ }
  return 14
}
// Quest exemption from the reserved slot: a wood chop the quest can
// COMPLETE. Same-wood plank room fits the whole batch: chops stack onto
// the log stack — creating it when below 36, stacking onto it at 36 —
// and the conversion stacks back and empties it exactly (R3, revmux 02
// major: the 36-transient completes, it never parks a single log). At a
// full batch the quest waits for conversion instead of over-chopping
// (a 16-log overshoot overflows the room and strands a remnant at 36).
// Mixed/plankless legs need free slots for the new stacks instead.
function questExempt(bot, ctx, target) {
  try {
    const wood = target && woodOfLog(target.name)
    if (!wood || !target || target.kind !== 'log') return false
    if (!questPlankWoods(bot, ctx)) return false
    const pw = packWood(bot)
    if ((pw.logCount.get(wood) || 0) >= questBatch()) return false
    if ((pw.plankRoom.get(wood) || 0) >= 56) {
      if ((pw.logRoom.get(wood) || 0) > 0) return true
      return pw.stacks <= 35
    }
    if ((pw.logRoom.get(wood) || 0) > 0) return pw.stacks <= 34
    return pw.stacks <= 33
  } catch (_) {
    return false
  }
}
// Park bound (idkcraft-vmzq.3 R2/R3): while a task is parked, remembered
// cells stay within PARK_FORAGE_RADIUS of home/castle — the menu pick and
// every mid-run replan share this filter (all three pickers below), so a
// dug-out near stand ends the leg (replan's null finish) instead of
// chaining to a far cell. The food fallback is gated separately below
// (parkedHuntOk): near animals only — a 48-block hop chain re-centers
// every replan and would walk the bot home-away (R3/R5).
// Deferred goal require (questBatch precedent — goal.js loads forage).
function parkedCellSkipped(ctx, item) {
  try {
    const g = require('../goal')
    if (!g.taskParked(ctx)) return false
    if (!item || typeof item.x !== 'number' || typeof item.z !== 'number') return true
    let radius = g.PARK_FORAGE_RADIUS || 64
    try {
      const { goalUnlock } = require('../goal-unlock')
      const r = goalUnlock(ctx, 'radius')
      if (typeof r === 'number' && r > radius) radius = r
    } catch (_) { /* default radius */ }
    const anchors = []
    if (ctx && ctx.home && ctx.home.site) anchors.push(ctx.home.site)
    if (ctx && ctx.castle && ctx.castle.site) anchors.push(ctx.castle.site)
    if (anchors.length === 0) return true // parked with no anchor: no far walk
    return !anchors.some((a) => Math.hypot(item.x - a.x, item.z - a.z) <= radius)
  } catch (_) {
    return false
  }
}
function bestMemoryCell(bot, ctx, bp) {
  const mem = ctx && ctx.resources
  if (!mem || !(mem.items instanceof Map) || mem.items.size === 0) return null
  let skip = null
  try { skip = (ctx && ctx.forageSkip) || null } catch (_) { skip = null }
  // Wood ceiling (g0z.26): past the cap remembered logs are not forageable —
  // ore and the food fallback still plan, so a capped pack digs stone instead
  // of chopping. Deferred require (goal.js loads forage at top).
  let capped = false
  try { capped = !!require('./stockpile').woodCapped(bot, ctx) } catch (_) { capped = false }
  const quest = questPlankWoods(bot, ctx)
  const floor = resources.surfaceFloor(ctx, bp) // atl.23: deep cells are the smith's leg
  let best = null
  let bestRank = Infinity
  let bestDist = Infinity
  let bestLog = null
  let bestLogSame = false
  let bestLogDist = Infinity
  for (const item of mem.items.values()) {
    if (!item || typeof item.x !== 'number') continue
    if (parkedCellSkipped(ctx, item)) continue
    if (typeof item.y === 'number' && item.y < floor) continue
    if (skip && typeof skip.has === 'function' && skip.has(cellKey(item))) continue
    const rank = valueRank(item.name)
    if (rank > 3) continue
    if (rank === 3 && capped) continue
    if (rank <= 2 && !bring.hasPickaxe(bot, item.name)) continue
    const d = dist(bp, item)
    if (rank < bestRank || (rank === bestRank && d < bestDist)) {
      bestRank = rank
      bestDist = d
      best = item
    }
    // The quest chops wood, not ore — same-wood first (the conversion
    // stacks); with no logs remembered the ore below still plans.
    if (rank === 3) {
      const same = !!quest && quest.has(woodOfLog(item.name))
      if (!bestLog || (same && !bestLogSame) || (same === bestLogSame && d < bestLogDist)) {
        bestLog = item
        bestLogSame = same
        bestLogDist = d
      }
    }
  }
  if (quest && bestLog) {
    // Plan gate (g0z.26 R3, revmux 02 major): when the reserve binds, plan
    // only a chop the dig phase accepts — a refused target walks there,
    // fails pack-full, and re-plans the same walk every 5 minutes. Null
    // explores instead (the plank wood may stand unremembered nearby; the
    // food fallback stays shut under the reserve unless hungry-safe (R4)).
    // The same-wood preference above already picks the most exemptable log.
    let reserved = false
    try { reserved = !!require('./stockpile').slotReserved(bot, ctx) } catch (_) { reserved = false }
    if (reserved && !questExempt(bot, ctx, { kind: 'log', name: bestLog.name })) return null
    return bestLog
  }
  return best
}

// Gear-latch preference (idkcraft-ipn.9): when gear latched a want
// (ctx.gear.saidNeed), the matching resource wins over the value rank —
// a near diamond must not shadow the far iron the ladder waits for, and
// fresh iron must not shadow the coal the smelt needs. Nearest remembered
// cell of the latched kind, still pickaxe-gated and skip-honouring: a
// struck or ungated cell falls through to the normal rank below, so the
// step keeps digging something. Pure like bestMemoryCell; gear.js shares
// this for its honest want lines. Null when the latch names nothing
// diggable. Stone/cobblestone (want-cobble) never lands in memory today
// (scan notes ores+logs only) but stays a correct matcher if it ever does.
const GEAR_WANT = {
  'want-ore': /iron_ore$/,
  'want-coal': /coal_ore$/,
  'want-cobble': /^(stone|cobblestone)$/,
}

function gearWantCell(bot, ctx, bp, key) {
  const re = GEAR_WANT[key]
  const mem = ctx && ctx.resources
  if (!re || !mem || !(mem.items instanceof Map) || mem.items.size === 0) return null
  if (!bp || typeof bp.x !== 'number') return null
  let skip = null
  try { skip = ctx.forageSkip || null } catch (_) { skip = null }
  let best = null
  let bestD = Infinity
  for (const item of mem.items.values()) {
    if (!item || typeof item.x !== 'number' || typeof item.name !== 'string') continue
    if (parkedCellSkipped(ctx, item)) continue
    if (!re.test(item.name)) continue
    if (skip && typeof skip.has === 'function' && skip.has(cellKey(item))) continue
    if (!bring.hasPickaxe(bot, item.name)) continue
    const d = dist(bp, item)
    if (d < bestD) {
      bestD = d
      best = item
    }
  }
  return best
}

// Best remembered DIAMOND cell for the deep leg (ipn.2): nearest cell
// whose name holds diamond, unstruck, iron-tier gated like bestMemoryCell
// (emeralds excluded — the gear ladder wants diamonds). Grounded cells
// (solid floor below, verified by read) sort before ungrounded ones:
// their drops stay at the bot's feet, while drops over voids fall out of
// pickup reach (live assay). Unreadable reads as ungrounded, which also
// biases toward nearby loaded cells. Null when none.
function bestDiamondCell(bot, ctx, bp) {
  const mem = ctx && ctx.resources
  if (!mem || !(mem.items instanceof Map) || mem.items.size === 0) return null
  let skip = null
  try { skip = (ctx && ctx.forageSkip) || null } catch (_) { skip = null }
  let best = null
  let bestRank = 2
  let bestDist = Infinity
  for (const item of mem.items.values()) {
    if (!item || typeof item.x !== 'number') continue
    if (parkedCellSkipped(ctx, item)) continue
    if (typeof item.name !== 'string' || !item.name.includes('diamond')) continue
    if (skip && typeof skip.has === 'function' && skip.has(cellKey(item))) continue
    if (!bring.hasPickaxe(bot, item.name)) continue
    let below = null
    try {
      const b = bot.blockAt && bot.blockAt(new Vec3(item.x, item.y - 1, item.z))
      below = (b && b.name) || null
    } catch (_) { below = null }
    const rank = (typeof below === 'string' && below && below !== 'air' && below !== 'cave_air' && below !== 'water' && !below.includes('lava')) ? 0 : 1
    const d = dist(bp, item)
    if (rank < bestRank || (rank === bestRank && d < bestDist)) {
      bestRank = rank
      bestDist = d
      best = item
    }
  }
  return best
}

// Hunt gate (g0z.26 R4, revmux 03 major): under the reserve a hunt must not
// fill the bootstrap slot — the well-fed corner skips the animal fallback
// (the M3 plan gate's null explores), the peckish corner hunts only onto a
// same-drop stack, and the starving corner hunts anyway (survival beats the
// reserve; the quest shed drains after). Fail-open outside the corner,
// fail-closed on unreadable hunger.
const HUNT_PECKISH = 18 // eatReflex eats below this; a hunt must beat it
const HUNT_STARVING = 6 // goal.js 'hungry' line: survival over slots
function dropRoom(bot, drop) {
  try {
    const items = bot && bot.inventory && typeof bot.inventory.items === 'function' ? bot.inventory.items() : []
    if (!Array.isArray(items)) return false
    for (const s of items) {
      if (!s || s.name !== drop) continue
      const cap = s && typeof s.stackSize === 'number' && s.stackSize > 0 ? s.stackSize : 64
      const n = typeof s.count === 'number' ? s.count : 1
      if (cap - n > 0) return true
    }
    return false
  } catch (_) {
    return false
  }
}
function huntAllowed(bot, ctx, drop) {
  try {
    let reserved = false
    try { reserved = !!require('./stockpile').slotReserved(bot, ctx) } catch (_) { reserved = false }
    if (!reserved) return true
    const food = bot && typeof bot.food === 'number' ? bot.food : NaN
    if (!(food < HUNT_PECKISH)) return false
    return dropRoom(bot, drop) || food <= HUNT_STARVING
  } catch (_) {
    return true
  }
}
// Parked hunts (vmzq.3 R3/R5): a parked bot hunts only near animals —
// the same anchor radius as cells. No hunger exemption (05-verify
// major): a hungry bot would chain-hunt outward, pure drift, third raising
// of park drift. Near hunts do feed now (vmzq.34: eatReflex takes safe raw
// as a fallback), so the bound feeds without walking home-away.
function parkedHuntOk(ctx, found) {
  try {
    const g = require('../goal')
    if (!g.taskParked(ctx)) return true
    return !!(found && found.position && !parkedCellSkipped(ctx, found.position))
  } catch (_) {
    return true
  }
}
// Step target: { kind, name, pos, drop, want }. Memory first; a passive
// animal (bring.js finder) when nothing diggable is remembered. Null =
// explore.
function planForage(bot, ctx) {
  const bp = botPos(bot)
  if (!bp) return null
  // ipn.9: gear's latched want first — the promise 'going to dig' names a
  // resource, so the step digs that resource while it can.
  let latched = null
  try { latched = ctx && ctx.gear && ctx.gear.saidNeed } catch (_) { latched = null }
  if (latched && GEAR_WANT[latched]) {
    const want = gearWantCell(bot, ctx, bp, latched)
    if (want) {
      // Reserved slot (g0z.26 R2): a latched want the reserve would fail
      // falls through to the quest-aware ranking below instead of starving
      // the chest quest behind a dig that cannot run. (want-log is never a
      // GEAR_WANT key, so the latched want is always ore here.)
      let reserved = false
      try { reserved = !!require('./stockpile').slotReserved(bot, ctx) } catch (_) { reserved = false }
      if (!reserved) {
        const kind = want.name.endsWith('_log') ? 'log' : 'ore'
        // Stone drops cobblestone, not stone: dropFor would pin the batch
        // counter at zero and the step would quarry forever.
        const drop = latched === 'want-cobble' ? 'cobblestone' : bring.dropFor(want.name)
        return { kind, name: want.name, pos: { x: want.x, y: want.y, z: want.z }, drop, want: FORAGE_WANT }
      }
    }
  }
  const cell = bestMemoryCell(bot, ctx, bp)
  if (cell) {
    const kind = cell.name.endsWith('_log') ? 'log' : 'ore'
    let want = FORAGE_WANT
    // Exact-batch quest legs (g0z.26 R3, revmux 02 major): the quest chops
    // exactly to NEED_LOGS — an 8-leg overshoot converts 16 logs into 64
    // planks, overflowing the same-wood room and stranding a remnant at 36.
    if (kind === 'log') {
      try {
        if (questPlankWoods(bot, ctx)) {
          const wood = woodOfLog(cell.name)
          const have = wood ? (packWood(bot).logCount.get(wood) || 0) : 0
          want = Math.max(1, questBatch() - have)
        }
      } catch (_) { /* uncountable: the standing batch */ }
    }
    return { kind, name: cell.name, pos: { x: cell.x, y: cell.y, z: cell.z }, drop: bring.dropFor(cell.name), want }
  }
  let found = null
  try { found = bring.findAnimal(bot, null) } catch (_) { found = null }
  if (found) {
    const drop = bring.PREY_DROPS[found.name] || null
    if (drop && huntAllowed(bot, ctx, drop) && parkedHuntOk(ctx, found)) {
      // Under the reserve a hunt is one kill: a full batch would overflow
      // the checked stack room onto new slots.
      let reserved = false
      try { reserved = !!require('./stockpile').slotReserved(bot, ctx) } catch (_) { reserved = false }
      return { kind: 'food', name: found.name, id: found.id, pos: null, drop, want: reserved ? 1 : FORAGE_WANT }
    }
  }
  return null
}



// Memory fingerprint: count alone pins at the 256 cap (oldest-out
// eviction keeps it there while explore swaps cells underneath), so a
// count-only snapshot would hold a failure forever after a relocation
// (revmux 01). Content hash releases on genuinely new cells and stays put
// when a rescan merely re-notes the same points.
function memPrint(ctx) {
  try {
    const mem = ctx && ctx.resources
    if (!mem || !(mem.items instanceof Map)) return 'none'
    const parts = []
    for (const item of mem.items.values()) {
      if (item && typeof item.x === 'number') parts.push(`${item.x},${item.y},${item.z}:${item.name}`)
    }
    parts.sort()
    let h = 5381
    const s = parts.join('|')
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0
    return `${parts.length}#${h.toString(36)}`
  } catch (_) {
    return 'none'
  }
}

function snapWorld(bot, ctx) {
  let mem = -1
  let haul = -1
  try { mem = memPrint(ctx) } catch (_) { /* no memory */ }
  try {
    const h = (ctx && ctx.haul) || {}
    haul = Object.keys(h).reduce((s, n) => s + (h[n] || 0), 0)
  } catch (_) { /* no haul */ }
  return { mem, haul }
}

// A recorded failure whose goal hold has expired (bt8s, revmux 01 minor):
// the next pick retries honestly instead of replaying the stale final —
// each gated replay would re-stamp stepFail.forage.at and cost another
// FORAGE_RETRY_MS (~20 min to the first honest retry, not 5). A fresh
// failure (no record yet, or the hold still binds) still replays, so the
// tick-after-fail re-run never clobbers the reason (gather's rule).
// Deferred require (goal.js loads forage).
function staleFinal(ctx) {
  try {
    const FF = ctx && ctx.forageFinal
    if (!FF || typeof FF.status !== 'string' || !FF.status.startsWith('failed:')) return false
    const sf = ctx && ctx.stepFail && ctx.stepFail.forage
    if (!sf || typeof sf.at !== 'number') return false
    return Date.now() - sf.at > (require('../goal').FORAGE_RETRY_MS || 0)
  } catch (_) {
    return false
  }
}

function snapInventory(bot) {
  const snap = {}
  try {
    const items = bot && bot.inventory && typeof bot.inventory.items === 'function' ? bot.inventory.items() : []
    if (Array.isArray(items)) {
      for (const i of items) {
        if (i && typeof i.name === 'string') snap[i.name] = (snap[i.name] || 0) + (typeof i.count === 'number' ? i.count : 1)
      }
    }
  } catch (_) { /* empty snapshot */ }
  return snap
}


function blockAt(bot, x, y, z) {
  try {
    return bot.blockAt && bot.blockAt(new Vec3(x, y, z))
  } catch (_) {
    return null
  }
}

// Haul delta since step start for the drops we chase, merged into ctx.haul.
// done when the step banked anything, failed when it banked nothing.
function finish(bot, ctx, f, ok, reason, forceFail) {
  const gains = {}
  try {
    for (const d of Object.keys(f.drops || {})) {
      const g = bring.countDrop(bot, d) - ((f.startInv && f.startInv[d]) || 0)
      if (g > 0) gains[d] = g
    }
  } catch (_) { /* no gains */ }
  let banked = 0
  try {
    if (!ctx.haul) ctx.haul = {}
    for (const d of Object.keys(gains)) {
      ctx.haul[d] = (ctx.haul[d] || 0) + gains[d]
      banked += gains[d]
    }
    // Skips survive a bank: struck unreachable cells come back otherwise,
    // spending the next batch's strikes on them before reachable points are
    // tried (round-1 minor). startWork is the reset point for a fresh episode.
  } catch (_) { /* haul best-effort */ }
  ctx.forage = null
  clearGoal(bot, ctx)
  try {
    ctx.forageFinal = banked > 0 ? null : { status: `failed:${reason || 'no-known'}`, world: snapWorld(bot, ctx) }
  } catch (_) { /* final best-effort */ }
  try { ctx.forageGated = 0 } catch (_) { /* counter best-effort */ }
  // forceFail (pack-full yield): bank the partial gains, but fail so the
  // time-hold parks the step instead of done-spinning against the reserve.
  if (banked > 0 && !forceFail) {
    ctx.stepStatus = 'done'
    console.log(`forage done: banked ${Object.keys(gains).map((d) => `${gains[d]} ${d}`).join(', ')}${ok ? '' : ` (${reason})`}`)
  } else if (banked > 0) {
    ctx.stepStatus = `failed:${reason || 'no-known'}`
    console.log(`forage failed:${reason || 'no-known'} (banked ${Object.keys(gains).map((d) => `${gains[d]} ${d}`).join(', ')})`)
  } else {
    ctx.stepStatus = `failed:${reason || 'no-known'}`
    try {
      const drops = Object.keys(f.drops || {}).join(',') || 'none'
      const w = (ctx.forageFinal && ctx.forageFinal.world) || {}
      console.log(`forage failed:${reason || 'no-known'} strikes=${f.streak || 0} drops=${drops} mem=${w.mem} haul=${w.haul}`)
    } catch (_) { /* log best-effort */ }
  }
}

function trackDrop(f, drop) {
  if (!f.drops) f.drops = {}
  f.drops[drop] = true
}

// Partial bank (sqg2): the gains of an interrupted run, merged into
// ctx.haul. The goal.js fresh-forage reset drops the stale leg (4dse fix)
// and with it startInv/drops — banking first keeps the partial haul. Only
// ctx.haul moves: no status, no final, no gate touch (the fresh leg runs
// honestly on its own baseline).
function bankPartial(bot, ctx) {
  try {
    const f = ctx && ctx.forage
    if (!f || !f.startInv || !f.drops) return
    const gains = {}
    for (const d of Object.keys(f.drops)) {
      const g = bring.countDrop(bot, d) - ((f.startInv && f.startInv[d]) || 0)
      if (g > 0) gains[d] = g
    }
    if (!ctx.haul) ctx.haul = {}
    for (const d of Object.keys(gains)) ctx.haul[d] = (ctx.haul[d] || 0) + gains[d]
  } catch (_) { /* haul best-effort */ }
}

// Skip one memory cell (never forget — the atl.4 hold needs stable
// memory). Shared with the deep leg (tunnel strikes).
function skipCell(ctx, p) {
  try {
    const skip = skipSet(ctx)
    if (skip && p && typeof p.x === 'number') skip.add(cellKey(p))
  } catch (_) { /* skip best-effort */ }
}

// One strike on a memory cell: skip it and count it. Three strikes fail
// the step.
function strikeCell(ctx, f, p) {
  skipCell(ctx, p)
  f.streak = (f.streak || 0) + 1
}

// Food stall replan with a same-animal streak: an unreachable cow across
// a ravine replans onto itself forever (revmux 01) — three consecutive
// stall-outs on the same id fail the step instead. A new animal, a kill in
// reach, or banked progress resets (fresh situation, not the same loop).
function replanFoodStall(bot, ctx, f, bp) {
  if (!replan(bot, ctx, f, bp)) return false
  const t = f.target
  // Every stall-out counts, whatever animal is nearest now: in a grazing
  // herd the id flips constantly, which used to zero the streak forever
  // (round-2 minor). Kill range and pickup still reset (fresh situation).
  if (t && t.kind === 'food') f.foodStreak = (f.foodStreak || 0) + 1
  if (t && t.kind === 'food' && (f.foodStreak || 0) >= UNREACHABLE_STRIKES) {
    finish(bot, ctx, f, false, 'unreachable')
    return false
  }
  return true
}

function replan(bot, ctx, f, bp) {
  f.target = planForage(bot, ctx)
  f.leg = null // fresh target re-decides the detour
  f.via = null
  f.phase = null
  f.stalls = 0
  f.lastBotPos = bp ? { x: bp.x, y: bp.y, z: bp.z } : null
  f.armedId = null
  if (!f.target) {
    finish(bot, ctx, f, false, (f.streak || 0) > 0 ? 'unreachable' : 'no-known')
    return false
  }
  f.phase = f.target.kind === 'food' ? 'find' : 'walk'
  return true
}

function forage(bot, ctx, target, state) {
  // A finished failure stays finished until the world changes (memory
  // count or banked haul): the tick after a fail re-runs this function
  // before decide() re-picks, and restarting would clobber unreachable
  // with a fresh no-known (gather's final rule, same shape).
  // Past the goal hold's bound the stale final drops first (staleFinal):
  // the hold already waited out the failure, so this pick runs honestly.
  try {
    if (staleFinal(ctx)) {
      ctx.forageFinal = null
      ctx.forageGated = 0
    }
  } catch (_) { /* gate best-effort */ }
  try {
    const FF = ctx && ctx.forageFinal
    if (FF && typeof FF.status === 'string' && FF.status.startsWith('failed:')) {
      const w = snapWorld(bot, ctx)
      if (FF.world && w.mem === FF.world.mem && w.haul === FF.world.haul) {
        // Deadlock breaker (atl.10): mem/haul never churn while forage is
        // blocked and explore/deliver never run, so the gate would hold
        // forever (prod 36h: 103 picks / 265 ticks). After GATED_MAX instant
        // fails drop the final so the NEXT pick runs honestly with the skips
        // intact (struck cells stay skipped per the atl.2 contract — the
        // honest retry tries the remaining cells, or fails no-known with a
        // logged reason if none remain). This pick still reports the recorded
        // failure; the honest attempt happens on the following pick.
        const n = (ctx.forageGated || 0) + 1
        ctx.forageGated = n
        if (n >= GATED_MAX) {
          ctx.forageFinal = null
          ctx.forageGated = 0
          console.log(`forage gate expired after ${n} gated fails, next pick retries honestly`)
        } else {
          try { console.log(`forage gated ${FF.status} n=${n}/${GATED_MAX}`) } catch (_) { /* log best-effort */ }
        }
        ctx.stepStatus = FF.status
        return
      } else {
        ctx.forageFinal = null
        ctx.forageGated = 0
      }
    }
  } catch (_) { /* gate best-effort */ }
  if (!ctx.forage) {
    ctx.forage = { phase: 'plan', target: null, leg: null, via: null, stalls: 0, streak: 0, lastBotPos: null, startInv: null, drops: {}, announced: false }
  }
  const f = ctx.forage
  const bp = botPos(bot)
  if (!bp) return
  if (!f.startInv) f.startInv = snapInventory(bot)
  const grounded = !bot.entity || bot.entity.onGround !== false

  if (f.phase === 'plan') {
    if (!replan(bot, ctx, f, bp)) return
    if (!f.announced) {
      f.announced = true
      const t0 = f.target
      const line = t0.kind === 'food' ? `foraging: hunting ${t0.name}` : `foraging: ${t0.name} nearby`
      // f3s: same per-line throttle as step chats (deferred require: goal.js loads forage)
      require('../goal').chatStep(bot, ctx, line)
    }
  }

  const t = f.target
  if (!t) {
    finish(bot, ctx, f, false, 'no-known')
    return
  }
  trackDrop(f, t.drop)

  // --- food: find / walk / kill / pickup (bring.js animal phases, step-shaped) ---
  if (t.kind === 'food') {
    if (f.phase === 'find' || f.phase === 'walk') {
      const ent = (t.id != null) ? bring.entityById(bot, t.id) : null
      if (!ent) {
        const found = (() => { try { return bring.findAnimal(bot, t.drop) } catch (_) { return null } })()
        // Parked re-target (vmzq.3 R4): the in-leg find must pass the
        // same gate as planForage, or each kill re-centers a 48-block
        // hop away from home (03 major). replan already applies it.
        if (!found || found.name !== t.name || !parkedHuntOk(ctx, found)) {
          if (!replan(bot, ctx, f, bp)) return
          return
        }
        t.id = found.id
        f.phase = 'walk'
        return
      }
      const d = dist(bp, ent.position)
      if (d !== null && d <= fightMod.SWING_RANGE) { f.phase = 'kill'; f.foodStreak = 0; return }
      const key = `forage-hunt:${Math.round(ent.position.x)},${Math.round(ent.position.y)},${Math.round(ent.position.z)}`
      if (key !== ctx.lastGoalKey) {
        bot.pathfinder.setGoal(new goals.GoalNear(ent.position.x, ent.position.y, ent.position.z, WALK_RANGE), false)
        ctx.lastGoalKey = key
        // No stall reset and no early return here: a grazing animal moves
        // every tick, which used to zero the counter (then skip counting
        // entirely) forever. Stalls reset only on the bot's own displacement
        // below, counted every tick.
        f.lastBotPos = { x: bp.x, y: bp.y, z: bp.z }
      }
      let verdict = null
      try { verdict = ctx.lastPathStatus } catch (_) { verdict = null }
      if (verdict === 'noPath') {
        // Unreachable herd across water/a fence: the streak is the strike
        // counter, same as the ore walk (round-2 minor).
        try { ctx.lastPathStatus = 'none' } catch (_) { /* status best-effort */ }
        if (!replanFoodStall(bot, ctx, f, bp)) return
        return
      }
      if (bring.progressed(bp, f.lastBotPos, grounded)) {
        f.stalls = 0
        f.lastBotPos = { x: bp.x, y: bp.y, z: bp.z }
      } else if (++f.stalls >= WALK_STALL_TICKS) {
        if (!replanFoodStall(bot, ctx, f, bp)) return
      }
      return
    }
    if (f.phase === 'kill') {
      const ent = (t.id != null) ? bring.entityById(bot, t.id) : null
      if (!ent) {
        f.dropPos = f.lastPos
        f.phase = 'pickup'
        return
      }
      f.lastPos = { x: ent.position.x, y: ent.position.y, z: ent.position.z }
      const d = dist(bp, ent.position)
      if (d === null || d > fightMod.SWING_RANGE) { f.phase = 'walk'; return }
      if (f.armedId !== ent.id) {
        f.armedId = ent.id
        try { fightMod.equipGear(bot) } catch (_) { /* fists are fine */ }
      }
      try { fightMod.swing(bot, ent) } catch (_) { /* mock bots may lack attack */ }
      return
    }
    if (f.phase === 'pickup') {
      const dp = f.dropPos
      if (!dp) { f.phase = 'find'; return }
      const key = `forage-food-pickup:${Math.round(dp.x)},${Math.round(dp.y)},${Math.round(dp.z)}`
      if (key !== ctx.lastGoalKey) {
        bot.pathfinder.setGoal(new goals.GoalNear(dp.x, dp.y, dp.z, 1), false)
        ctx.lastGoalKey = key
        f.stalls = 0
        f.lastBotPos = { x: bp.x, y: bp.y, z: bp.z }
        return
      }
      const d = dist(bp, dp)
      if (d === null || d > 2) {
        if (bring.progressed(bp, f.lastBotPos, grounded)) {
          f.stalls = 0
          f.lastBotPos = { x: bp.x, y: bp.y, z: bp.z }
        } else if (++f.stalls >= WALK_STALL_TICKS) {
          if (!replanFoodStall(bot, ctx, f, bp)) return
        }
        return
      }
      const have = Math.max(0, bring.countDrop(bot, t.drop) - ((f.startInv && f.startInv[t.drop]) || 0))
      if (have >= t.want) {
        finish(bot, ctx, f, true)
      } else {
        t.id = null
        f.phase = 'find'
      }
      return
    }
    if (!replan(bot, ctx, f, bp)) return
    return
  }

  // --- ore/log: walk (bring-style: issue returns, settle digs) ---
  // rw4.12: the first issue goes via the detour waypoint when the straight
  // leg crosses a live mark; arrival (or a dead detour leg) drops to the
  // direct goal. Food legs stay direct: the target moves every tick.
  if (f.phase === 'walk') {
    const p = t.pos
    if (!f.leg) {
      let v = null
      try { v = detour.via(ctx, bp, p) } catch (_) { v = null }
      f.via = v || null
      f.leg = v ? 'via' : 'direct'
    }
    // Arrival reads xz-only from the waypoint cell centre (revmux 01):
    // the XZ goal stops on a near cell whose 3D distance misses.
    const viaArrived = (v) => Math.hypot(bp.x - (v.x + 0.5), bp.z - (v.z + 0.5)) <= WALK_RANGE + 0.5
    if (f.leg === 'via' && f.via && viaArrived(f.via)) {
      f.leg = 'direct'
      f.stalls = 0
      try { ctx.lastGoalKey = '' } catch (_) { /* re-issue below */ }
    }
    const onVia = f.leg === 'via' && !!f.via
    const aim = onVia ? f.via : p
    const key = `forage:${Math.round(aim.x)},${Math.round(aim.y)},${Math.round(aim.z)}`
    if (key !== ctx.lastGoalKey) {
      const goal = onVia
        ? new goals.GoalNearXZ(aim.x, aim.z, WALK_RANGE)
        : new goals.GoalNear(aim.x, aim.y, aim.z, WALK_RANGE)
      bot.pathfinder.setGoal(goal, false)
      ctx.lastGoalKey = key
      // Consume the previous goal's verdict: only a noPath/timeout that
      // arrives AFTER this issue strikes (same attribution follow.js uses
      // for its terminal statuses, without touching its counters).
      try { ctx.lastPathStatus = 'none' } catch (_) { /* status best-effort */ }
      f.stalls = 0
      f.lastBotPos = { x: bp.x, y: bp.y, z: bp.z }
      return
    }
    let verdict = null
    try { verdict = ctx.lastPathStatus } catch (_) { verdict = null }
    // noPath only: a pathfinder 'timeout' returns the best partial path,
    // which the bot walks while A* recomputes — far is not unreachable.
    // Striking on timeout drops a progressing walk (round-1 minor); the
    // displacement stall counter below stays the backstop.
    if (verdict === 'noPath') {
      if (onVia) {
        // Dead detour, live cell: fall back direct without a strike (the
        // direct leg strikes honestly if it dies too).
        f.leg = 'direct'
        f.stalls = 0
        f.lastBotPos = { x: bp.x, y: bp.y, z: bp.z }
        try { ctx.lastPathStatus = 'none'; ctx.lastGoalKey = '' } catch (_) { /* re-issue below */ }
        return
      }
      // One failure on this point is one strike: the cell is skipped (not
      // forgotten) and the next point is tried, or the step fails.
      strikeCell(ctx, f, p)
      if ((f.streak || 0) >= UNREACHABLE_STRIKES) {
        finish(bot, ctx, f, false, 'unreachable')
        return
      }
      if (!replan(bot, ctx, f, bp)) return
      return
    }
    let block = null
    try { block = blockAt(bot, p.x, p.y, p.z) } catch (_) { block = null }
    if (block && (!block.name || block.name !== t.name)) {
      // Loaded and different: dug out or a ghost — forget the fact, no
      // strike (gather's stale-point rule).
      try { resources.forget(ctx, p.x, p.y, p.z) } catch (_) { /* memory best-effort */ }
      if (!replan(bot, ctx, f, bp)) return
      return
    }
    // Unloaded (blockAt null) is not gone: a deep point keeps its walk
    // while chunks stream in, with stall counting below as the backstop
    // (gather's unloaded-far rule).
    if (!onVia && !bot.pathfinder.isMoving()) {
      // Direct leg only: at the waypoint the target cell reads diggable
      // while the bot stands a pit away — settling would dig thin air.
      // Stationary but out of digging reach is not a settle: fall through
      // to stall counting below (a loaded-but-far point froze here forever,
      // the live deep-ore trap). Diggable settles to dig.
      let diggable = true
      try { diggable = typeof bot.canDigBlock === 'function' ? bot.canDigBlock(block) : true } catch (_) { diggable = false }
      if (diggable) {
        f.phase = 'dig'
        return
      }
    }
    if (bring.progressed(bp, f.lastBotPos, grounded)) {
      f.stalls = 0
      f.lastBotPos = { x: bp.x, y: bp.y, z: bp.z }
    } else if (++f.stalls >= WALK_STALL_TICKS) {
      if (onVia) {
        // Stalled detour: the waypoint may be the unreachable one, not
        // the cell — fall back direct without a strike.
        f.leg = 'direct'
        f.stalls = 0
        f.lastBotPos = { x: bp.x, y: bp.y, z: bp.z }
        try { ctx.lastGoalKey = '' } catch (_) { /* re-issue below */ }
        return
      }
      strikeCell(ctx, f, p)
      if ((f.streak || 0) >= UNREACHABLE_STRIKES) {
        finish(bot, ctx, f, false, 'unreachable')
        return
      }
      if (!replan(bot, ctx, f, bp)) return
    }
    return
  }

  if (f.phase === 'dig') {
    if (ctx.digInFlight) return
    if (typeof bot.dig !== 'function') {
      try { resources.forget(ctx, t.pos.x, t.pos.y, t.pos.z) } catch (_) { /* memory best-effort */ }
      if (!replan(bot, ctx, f, bp)) return
      return
    }
    // Reserved slot (g0z.26 R2): the pack stops growing at PACK_RESERVE with
    // no adopted chest and nobody online — the last slot is the bootstrap
    // chest craft's room. The chest quest is exempt while it can complete;
    // food hunts never reach this phase (survival: the kill self-drains).
    // Fails (time-held) so the stockpile step banks instead of spinning.
    let reserved = false
    try { reserved = !!require('./stockpile').slotReserved(bot, ctx) } catch (_) { reserved = false }
    if (reserved && !questExempt(bot, ctx, t)) {
      finish(bot, ctx, f, false, 'pack-full', true)
      return
    }
    let block = null
    try { block = blockAt(bot, t.pos.x, t.pos.y, t.pos.z) } catch (_) { block = null }
    if (!block || block.name !== t.name) {
      try { resources.forget(ctx, t.pos.x, t.pos.y, t.pos.z) } catch (_) { /* memory best-effort */ }
      if (!replan(bot, ctx, f, bp)) return
      return
    }
    let fDeny = denyReason(bot, block, ctx) // idkcraft-drq: never strip owner structures
    if (fDeny === 'below-feet' && solidBelow(bot, t.pos)) {
      // ipn.18: bring's atl.20 exemption — ore under the feet over PROVEN
      // solid is a safe 1-block drop, so dig it instead of striking the
      // vein cell by cell (prod: 19 selftrap refusals on iron_ore in 4 h).
      // The trap rule masks protection, so unmask it first (bring revmux
      // 01 core-1). Air/water/unknown below keeps the strike.
      fDeny = protectedReason(bot, block, ctx) !== null ? 'protected' : null
      if (!fDeny) {
        try { console.log(`below-feet ${t.name} at ${Math.floor(t.pos.x)} ${Math.floor(t.pos.y)} ${Math.floor(t.pos.z)} onto solid — digging (atl.20)`) } catch (_) { /* logging never breaks a dig */ }
      }
    }
    if (fDeny) {
      logDeny(block, fDeny)
      try {
        if (fDeny === 'protected') resources.forget(ctx, t.pos.x, t.pos.y, t.pos.z)
        else strikeCell(ctx, f, t.pos) // trap: transient stance, skip it, keep memory (atl.4)
      } catch (_) { /* memory best-effort */ }
      if (!replan(bot, ctx, f, bp)) return
      return
    }
    ctx.digInFlight = true
    void (async () => {
      try {
        let tool = null
        try { tool = bot.pathfinder && typeof bot.pathfinder.bestHarvestTool === 'function' ? bot.pathfinder.bestHarvestTool(block) : null } catch (_) { tool = null }
        if (tool && typeof bot.equip === 'function') await bot.equip(tool, 'hand')
        await bot.dig(block)
      } catch (_) { /* gone or interrupted: pickup anyway */ }
      ctx.digInFlight = false
      if (ctx.forage === f) f.phase = 'pickup'
    })()
    return
  }

  if (f.phase === 'pickup') {
    const p = t.pos
    const key = `forage-pickup:${Math.round(p.x)},${Math.round(p.y)},${Math.round(p.z)}`
    if (key !== ctx.lastGoalKey) {
      bot.pathfinder.setGoal(new goals.GoalBlock(p.x, p.y, p.z), false)
      ctx.lastGoalKey = key
      return
    }
    try { resources.forget(ctx, p.x, p.y, p.z) } catch (_) { /* dug: drop the cell */ }
    const have = Math.max(0, bring.countDrop(bot, t.drop) - ((f.startInv && f.startInv[t.drop]) || 0))
    if (have >= t.want) {
      finish(bot, ctx, f, true)
    } else {
      f.phase = 'plan'
    }
    return
  }

  if (!replan(bot, ctx, f, bp)) return
}

module.exports = forage
module.exports.bankPartial = bankPartial
module.exports.planForage = planForage
module.exports.questExempt = questExempt
module.exports.gearWantCell = gearWantCell
module.exports.bestDiamondCell = bestDiamondCell
module.exports.skipCell = skipCell
module.exports.parkedCellSkipped = parkedCellSkipped
module.exports.FORAGE_WANT = FORAGE_WANT
