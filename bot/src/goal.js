'use strict'

// Goal arbiter for epic rw4 (bot builds itself a house): goal facts, the
// step menu with per-step feasibility, a reference FSM, and the decision
// point. A goal step IS a BEHAVIOURS action, so applyDecision, the decision
// line and the decisions metric work unchanged. Later beads register their
// behaviour under the step key in BEHAVIOURS — goal.js does not change for
// that; a step runs only while registered (see registered()).
//
// Step lifecycle: decide() picks a step and marks it running; the behaviour
// reports completion via ctx.stepStatus = 'done' | 'failed:<reason>'.
// Model choice (bead .6) asks at the same decision points with the FSM as
// fallback and disagreement reference, exactly like hybridBrain.

const { countItems } = require('./perception')
const Vec3 = require('vec3')
const buildMod = require('./behaviours/build')
const forageMod = require('./behaviours/forage')
const deliverMod = require('./behaviours/deliver')
const stockpileMod = require('./behaviours/stockpile')
const BLUEPRINT = buildMod.BLUEPRINT
const PLANK_COUNT = buildMod.PLANK_COUNT
const metrics = require('./metrics')

// House budget (epic rw4): 22 wall planks + 16 roof + door (6) + table (4);
// gather 14 logs (12 worth + spare).
const NEED_LOGS = 14
const NEED_PLANKS = 48

// Step menu: feasible(facts, bot, ctx) means the step can make progress NOW
// (not just ever). Most steps read facts only; build also scans the home
// site through the bot. Registration (BEHAVIOURS[name]) is checked
// separately in decide().
// chat() is the one line the bot says on taking the step (owner rule: the
// bot always announces what it does).
const MENU = {
  stay: {
    // Dusk counts, not just night: a gohome that finishes at dusk must hand
    // off to stay, never to a rest that roams out of the closed house
    // (revmux 01-review loop+goal-3).
    feasible: (facts) => facts.time !== 'day' && facts.home === 'built' && facts.inside === 'yes',
    chat: () => 'on my own: staying inside till morning',
    verb: 'staying inside',
  },
  gohome: {
    feasible: (facts) => (facts.time === 'dusk' || facts.time === 'night') && facts.home === 'built' && facts.inside === 'no',
    chat: () => 'on my own: heading home',
    verb: 'heading home',
  },
  craft: {
    // Batch gate: a full NEED_LOGS load crafts at once. Starting on the first
    // picked-up log would preempt gather with a chat line per log.
    // The door needs a placed table (bot.craft requires the block): without
    // one the step could neither progress nor finish, churning done forever.
    feasible: (facts) => facts.logs >= NEED_LOGS || (facts.maxPlanks >= 4 && facts.table === 0 && !facts.tablePlaced) || (facts.maxPlanks >= 6 && facts.door === 0 && facts.tablePlaced),
    chat: () => 'on my own: crafting planks and tools',
    verb: 'crafting',
  },
  equip: {
    // Starter-kit rebuild (atl.6, owner): pickaxe -> sword first (they need
    // sticks-or-planks-or-logs plus a table, inventory or placed), scaffold
    // blocks only once geared (they dig by hand). Blocks alone never preempt
    // early gather: a fresh bot chops first, digs later.
    feasible: (facts) => {
      if ((facts.sword || 0) <= 0 || (facts.pickaxe || 0) <= 0) {
        if (!equipWant(facts)) return false
        return (facts.table || 0) > 0 || !!facts.tablePlaced
      }
      // Deferred require (same cycle as registered() below): goal.js loads
      // inside the equip->craft->goal chain, so the mark is read at decide()
      // time, never at load time.
      return (facts.scaffold || 0) < require('./behaviours/equip').SCAFFOLD_LOW
    },
    chat: () => 'on my own: rearming tools and blocks',
    verb: 'rearming',
  },
  build: {
    // Batch gate (bead .4): build proceeds in batches — start (or resume)
    // with a batch of up to 16 planks on hand, then back to gather/craft.
    // A finished door/table needs its item, not loose planks, so a zero
    // plank remainder passes with any plank count. Skipped (given-up) cells
    // count as done, the same as in the build behaviour.
    feasible: (facts, bot, ctx) => {
      const home = ctx && ctx.home
      if (!home && !(bot && bot.spawnPoint)) return false
      // No scannable origin (no home yet, or a home without site): nothing
      // is verifiable, so the whole wall+roof count counts.
      if (!home || !home.site) return facts.planks >= Math.min(PLANK_COUNT, 16)
      let planks = 0
      let other = 0
      try {
        const skip = new Set(Array.isArray(ctx.buildSkip) ? ctx.buildSkip : [])
        for (let i = 0; i < BLUEPRINT.length; i++) {
          if (skip.has(i)) continue
          if (!buildMod.cellDone(bot, home, BLUEPRINT[i])) {
            if (BLUEPRINT[i].kind === 'planks') planks++
            else other++
          }
        }
      } catch (_) {
        return false
      }
      if (planks + other <= 0) return false
      // No livelock: a missing door/table item for the NEXT unfinished cell
      // means build cannot advance — yield so gather/craft (or a new site)
      // run. Only the next cell gates, never the whole remainder: the door
      // is crafted at the placed table after build lays it, so a door gate
      // on later cells deadlocks a fresh site (xoj). Skipped cells are
      // given up and do not gate.
      try {
        const next = buildMod.nextCellIdx(bot, home, ctx.buildSkip)
        if (next < 0) return false
        const kind = BLUEPRINT[next].kind
        if (kind === 'table' && !(facts.table > 0)) return false
        if (kind === 'door' && !(facts.door > 0)) return false
      } catch (_) {
        return false
      }
      if (planks > 0) return facts.planks >= Math.min(planks, 16)
      return true
    },
    chat: () => 'on my own: building the house',
    verb: 'building the house',
  },
  light: {
    // Day shift only: walking the yard at night is the danger being fixed.
    // Fuel floor mirrors the behaviour's reserve (deferred require: the
    // equip precedent — goal.js loads inside the behaviour chain).
    feasible: (facts, bot, ctx) => {
      if (facts.time !== 'day') return false
      const home = ctx && ctx.home
      if (!home || !home.site) return false
      // Built only (revmux 01 majors): on an unbuilt site light outranks
      // gather, spends house planks on sticks, and skips the roof spot
      // (no roof = no ref) for the whole session.
      if (facts.home !== 'built') return false
      if (!(facts.unlit > 0)) return false
      if ((facts.torches || 0) > 0) return true
      if ((facts.coal || 0) <= require('./behaviours/light').COAL_RESERVE) return false
      // maxPlanks, not planks: stick recipes cannot mix woods (01 minor).
      return (facts.sticks || 0) > 0 || (facts.maxPlanks || 0) >= 2 || (facts.logs || 0) >= 1
    },
    chat: () => 'on my own: lighting the yard',
    verb: 'lighting torches',
  },
  gather: {
    // Only while material is still missing: plank-equivalent on hand vs the
    // house budget (table 4 + door 6 + NEED_PLANKS planks), and never once
    // the house is built — otherwise the bot farms forever and rest is
    // unreachable after the job is done. A started load is always finished
    // (logs < NEED_LOGS): stopping mid-load strands sub-batch logs that the
    // batch craft gate can never take — rest forever with work remaining.
    // atl.4: a still-holding gather failure is not feasible — the behaviour
    // replays the same final while the log count stands (decide's stepFail
    // is the menu-wide twin of this gate).
    feasible: (facts, bot, ctx) => {
      try {
        const g = ctx && ctx.gather
        if (g && typeof g.final === 'string' && g.final.startsWith('failed:') && g.atLogs === facts.logs) return false
      } catch (_) { /* fall through to facts */ }
      if (facts.home === 'built') return false
      const total = facts.planks + facts.logs * 4
      const need = NEED_PLANKS + (facts.table > 0 ? 0 : 4) + (facts.door > 0 ? 0 : 6)
      return total < need || (facts.logs > 0 && facts.logs < NEED_LOGS)
    },
    chat: () => 'on my own: gathering logs',
    verb: 'chopping wood',
  },
  deliver: {
    // Unload first: a waiting haul goes to the nearest online player
    // before the next forage leg. Nobody online (dxl) -> infeasible.
    feasible: (facts) => facts.haul === 'waiting' && facts.player !== 'none',
    chat: () => 'on my own: delivering the haul',
    verb: 'delivering',
  },
  stockpile: {
    // Bank the surplus in the home chest while the owner is away (atl.14):
    // adopt or place the chest first, then deposit. The haul gate is the
    // exact complement of deliver's: a waiting haul with a player online
    // belongs to deliver, with nobody online it belongs here (revmux
    // 01-review — gating on haul alone never banks the night's loot).
    // The chest=no branch runs only when actionable (a standing chest to
    // adopt, or the pack to place one): an unready bot must not preempt a
    // forage leg just to fail at once (revmux 02-review).
    feasible: (facts) => facts.home === 'built' && !facts.chestParked &&
      !(facts.haul === 'waiting' && facts.player !== 'none') &&
      (facts.chest === 'no' ? facts.chestTodo !== 'none' : (facts.surplus === 'yes' || facts.gearHandover === 'waiting')),
    chat: () => 'on my own: stockpiling at the home chest',
    verb: 'stockpiling',
  },
  gear: {
    // The blacksmith (ipn.3): forge the ladder (iron, then diamond) and hand
    // finished goods over. Built-home only: the table, furnace, and chest
    // all live there, and rw4 owns the body until built anyway. The plan is
    // the behaviour's (menuPlan, deferred require like light): ready works
    // now, want/wait announce once through the said latch, done never fires.
    feasible: (facts, bot, ctx) => {
      if (facts.home !== 'built') return false
      let plan = null
      try {
        plan = require('./behaviours/gear').menuPlan(facts, ctx)
      } catch (_) {
        return false
      }
      if (!plan || plan.state === 'done') return false
      if (plan.state === 'ready') return true
      let said = null
      try {
        said = ctx && ctx.gear && ctx.gear.saidNeed
      } catch (_) { /* unlatched */ }
      return plan.key !== said
    },
    chat: () => 'on my own: forging better gear',
    verb: 'forging gear',
  },
  forage: {
    // Known valuable find nearby (planForage: value rank, pickaxe gate).
    // Nothing known -> explore finds more.
    feasible: (facts) => facts.known === 'near',
    chat: () => 'on my own: foraging resources',
    verb: 'foraging',
  },
  explore: {
    // Blind search only once the house stands: pre-house gaps rest (rw4
    // owns the body until built), night pre-house never wanders.
    feasible: (facts) => facts.home === 'built',
    chat: () => 'on my own: exploring outward',
    verb: 'exploring',
  },
  rest: {
    feasible: () => true,
    chat: (facts) => (facts.home === 'none' ? 'on my own: resting near spawn' : 'on my own: resting at the home site'),
    verb: 'resting',
  },
}

// Which missing tool can actually complete now (atl.6 + revmux round-1):
// the pickaxe needs 3 rock (cobble or ~5 plank-equivalents, since 2 planks
// go to sticks) plus 2 sticks-or-material; the sword 2 rock plus 1 stick.
// Single source for MENU.equip.feasible and the stepWhy wording, in the
// behaviour's pickaxe-first order (offering the sword while the pickaxe is
// missing AND uncompletable would fail at once in toolOp).
function equipWant(facts) {
  const sticks = facts.sticks || 0
  const planks = facts.planks || 0
  const logs = facts.logs || 0
  const cobble = facts.cobble || 0
  const equiv = planks + logs * 4
  const stick2 = sticks >= 2 || planks >= 2 || logs >= 1
  const stick1 = sticks >= 1 || planks >= 2 || logs >= 1
  if ((facts.pickaxe || 0) <= 0) {
    return (cobble >= 3 || equiv >= 5) && stick2 ? 'pickaxe' : null
  }
  if ((facts.sword || 0) <= 0) {
    return (cobble >= 2 || equiv >= 3) && stick1 ? 'sword' : null
  }
  return null
}

// Priority order (epic rw4 + atl.2 + atl.6): night steps first, then craft,
// rearm (equip), build, gather, then unload (deliver), dig (forage), search
// (explore), rest last.
// goalFsm is pure priority over the feasible names it is given.
const STEP_ORDER = ['stay', 'gohome', 'craft', 'equip', 'build', 'light', 'gather', 'deliver', 'stockpile', 'gear', 'forage', 'explore', 'rest']
// Alone-explore cap (idkcraft-dxl): without players the bot must not wander
// past this many blocks from home — new chunks bloat the host disk. Read by
// atl.1 explore.js when it lands; until then no behaviour consumes it.
const AUTONOMOUS_EXPLORE_RADIUS = 256

// Home site shape (bead .4): site is the SW-corner origin at ground level,
// interior the 2x2x2 inside (4 cells), door the LOWER door cell, table the
// workbench cell outside the east wall — null until the workbench is really
// placed. rw4.3 treats ctx.home.table as a PLACED station (craft walks to it
// and crafts the door at it), so claiming the coords early would deadlock
// craft at an empty cell; build claims them the tick the table cell lands.
function makeHome(ox, oy, oz) {
  return {
    site: { x: ox, y: oy, z: oz },
    interior: { min: { x: ox + 1, y: oy, z: oz + 1 }, max: { x: ox + 2, y: oy + 1, z: oz + 2 } },
    door: { x: ox + 1, y: oy, z: oz },
    table: null,
    built: false,
  }
}

// Feet level of the ground column: first non-air block from topY down, plus
// one. Null when the column never resolves (unloaded chunk).
function groundY(bot, x, z, topY) {
  for (let y = topY; y > topY - 32; y--) {
    let b = null
    try {
      b = bot.blockAt(new Vec3(x, y, z))
    } catch (_) {
      return null
    }
    if (b && b.name && b.name !== 'air') return y + 1
  }
  return null
}

// 8 candidate origins around `around` at radius 6 (bead .4).
const SITE_DIRS = [[6, 0], [4, 4], [0, 6], [-4, 4], [-6, 0], [-4, -4], [0, -6], [4, -4]]

// Pick a flat 4x4 site: all 16 columns resolve and lie within one block.
// First fit wins; after 8 rejections the first candidate is taken as-is —
// ponytail: let the house hang or half-bury rather than block the epic.
function siteFor(bot, around) {
  if (!around || typeof around.x !== 'number' || typeof around.z !== 'number') return null
  const cx = Math.floor(around.x)
  const cz = Math.floor(around.z)
  const cy = typeof around.y === 'number' ? Math.floor(around.y) : 64
  for (const [dx, dz] of SITE_DIRS) {
    const ox = cx + dx
    const oz = cz + dz
    const ys = []
    let ok = true
    for (let ix = 0; ix < 4 && ok; ix++) {
      for (let iz = 0; iz < 4 && ok; iz++) {
        const gy = groundY(bot, ox + ix, oz + iz, cy + 8)
        if (gy == null) { ok = false; break }
        ys.push(gy)
      }
    }
    if (!ok || ys.length !== 16) continue
    const y0 = Math.min(...ys)
    if (ys.every((y) => y === y0 || y === y0 + 1)) return makeHome(ox, y0, oz)
  }
  const [fx, fz] = SITE_DIRS[0]
  const fy = groundY(bot, cx + fx, cz + fz, cy + 8)
  return makeHome(cx + fx, fy == null ? cy : fy, cz + fz)
}

// Adopt a house built by an earlier run: a door within 32 of spawn means
// home. Origin = door − (1,0,0); findBlocks may return the UPPER half, so
// step down when the block below is also a door. built is lax on purpose —
// presence (non-air) counts; exact repair is the build step's job.
function adoptHome(bot) {
  try {
    const spawn = bot && bot.spawnPoint
    if (!spawn || typeof spawn.x !== 'number') return null
    const found = bot.findBlocks({
      matching: (b) => !!b && typeof b.name === 'string' && b.name.endsWith('_door'),
      maxDistance: 32,
      count: 1,
    })
    if (!found || !found.length) return null
    let dx = Math.floor(found[0].x)
    let dy = Math.floor(found[0].y)
    let dz = Math.floor(found[0].z)
    try {
      const below = bot.blockAt(new Vec3(dx, dy - 1, dz))
      if (below && typeof below.name === 'string' && below.name.endsWith('_door')) dy--
    } catch (_) { /* keep as found */ }
    const home = makeHome(dx - 1, dy, dz)
    // Claim the table coords only when the workbench block is really there
    // (same placed-station contract as a fresh site).
    try {
      const t = BLUEPRINT[0]
      const tb = bot.blockAt(new Vec3(home.site.x + t.dx, home.site.y + t.dy, home.site.z + t.dz))
      if (tb && tb.name === 'crafting_table') {
        home.table = new Vec3(home.site.x + t.dx, home.site.y + t.dy, home.site.z + t.dz)
      }
    } catch (_) { /* unverifiable: leave unclaimed */ }
    let allPresent = true
    for (const cell of BLUEPRINT) {
      let name = null
      try {
        const b = bot.blockAt(new Vec3(home.site.x + cell.dx, home.site.y + cell.dy, home.site.z + cell.dz))
        name = b && b.name
      } catch (_) {
        name = null
      }
      if (!name || name === 'air') { allPresent = false; break }
    }
    home.built = allPresent
    try { bot.chat(`my home is at ${home.site.x} ${home.site.y} ${home.site.z}`) } catch (_) { /* chat best-effort */ }
    return home
  } catch (_) {
    return null
  }
}

function goalFacts(bot, ctx) {
  let timeOfDay = NaN
  try {
    timeOfDay = bot && bot.time && typeof bot.time.timeOfDay === 'number' ? bot.time.timeOfDay : NaN
  } catch (_) { /* unknown time reads as day below */ }
  const time = !(timeOfDay >= 0) ? 'day' : timeOfDay < 12000 ? 'day' : timeOfDay <= 13000 ? 'dusk' : 'night'
  const logs = countItems(bot, (n) => n.endsWith('_log'))
  const planks = countItems(bot, (n) => n.endsWith('_planks'))
  const table = countItems(bot, (n) => n === 'crafting_table')
  const door = countItems(bot, (n) => n.endsWith('_door'))
  const sword = countItems(bot, (n) => n.endsWith('_sword'))
  const pickaxe = countItems(bot, (n) => n.endsWith('_pickaxe'))
  const cobble = countItems(bot, (n) => n === 'cobblestone')
  const sticks = countItems(bot, (n) => n === 'stick')
  const coal = countItems(bot, (n) => n === 'coal' || n === 'charcoal')
  const torches = countItems(bot, (n) => n === 'torch')
  const scaffold = countItems(bot, (n) => n === 'dirt' || n === 'cobblestone')
  const ironOre = countItems(bot, (n) => n === 'raw_iron')
  const ingots = countItems(bot, (n) => n === 'iron_ingot')
  const diamonds = countItems(bot, (n) => n === 'diamond')
  const ironPick = countItems(bot, (n) => n === 'iron_pickaxe')
  const ironSword = countItems(bot, (n) => n === 'iron_sword')
  const diamondPick = countItems(bot, (n) => n === 'diamond_pickaxe')
  const diamondSword = countItems(bot, (n) => n === 'diamond_sword')
  const furnaceItem = countItems(bot, (n) => n === 'furnace')
  // Top single-wood plank count: recipes cannot mix wood types (see above).
  let maxPlanks = 0
  try {
    const items = bot && bot.inventory && typeof bot.inventory.items === 'function' ? bot.inventory.items() : []
    const perWood = {}
    if (Array.isArray(items)) {
      for (const i of items) {
        if (!i || typeof i.name !== 'string' || !i.name.endsWith('_planks')) continue
        perWood[i.name] = (perWood[i.name] || 0) + (typeof i.count === 'number' ? i.count : 1)
      }
      for (const n of Object.values(perWood)) {
        if (n > maxPlanks) maxPlanks = n
      }
    }
  } catch (_) { /* inventory not ready: 0 */ }
  const home = !ctx || !ctx.home ? 'none' : ctx.home.built ? 'built' : 'site'
  // Unlit torch spots around the house (rw4.13 light step): scanned like
  // the build remainder, so the step ends when the ring burns.
  let unlit = 0
  try {
    const hh = ctx && ctx.home
    if (hh && hh.site) unlit = require('./behaviours/light').countUnlit(bot, hh, ctx.lightSkip)
  } catch (_) { /* unscannable reads as lit: light yields, nothing churns */ }
  // ctx.home.interior contract (set by bead .4): { min: {x,y,z}, max: {x,y,z} }.
  let inside = 'no'
  try {
    const bp = bot && bot.entity && bot.entity.position
    const interior = ctx && ctx.home && ctx.home.interior
    if (bp && interior && interior.min && interior.max &&
      bp.x >= interior.min.x && bp.x <= interior.max.x &&
      bp.y >= interior.min.y && bp.y <= interior.max.y &&
      bp.z >= interior.min.z && bp.z <= interior.max.z) inside = 'yes'
  } catch (_) { /* not inside */ }
  // A station the equip step placed also counts (atl.6): otherwise the
  // craft step rebuilds a table from planks every time equip places one.
  const tablePlaced = !!((ctx && ctx.home && ctx.home.table) || (ctx && ctx.claimedTable))
  // Home chest (atl.14): adopted coords, the no-chest todo, batched live
  // surplus, and the full park. Surplus flips only past SURPLUS_BATCH:
  // banking preempts forage, so one dug block must not re-fire the
  // decision mid-vein (revmux 02-review; craft batch-gate precedent).
  let chest = 'no'
  try { if (ctx && ctx.home && ctx.home.chest) chest = 'yes' } catch (_) { /* unadopted */ }
  let chestTodo = 'none'
  try { chestTodo = stockpileMod.chestTodo(bot, ctx, maxPlanks) } catch (_) { /* undecidable */ }
  let surplus = 'no'
  try {
    const batch = (stockpileMod && stockpileMod.SURPLUS_BATCH) || 16
    if (stockpileMod.surplusCount(bot) >= batch) surplus = 'yes'
  } catch (_) { /* no surplus */ }
  // Furnace claim (ipn.1 station, chest/table contract): set when the block
  // stands. Handover (ipn.3): forged owner goods still on hand flip the
  // stockpile step while the batch gate would never fire.
  let furnace = 'no'
  try {
    if (ctx && ctx.home && ctx.home.furnace) furnace = 'yes'
  } catch (_) { /* unclaimed */ }
  let gearHandover = 'none'
  try {
    if (require('./behaviours/gear').handoverWaiting(bot, ctx)) gearHandover = 'waiting'
  } catch (_) { /* none waiting */ }
  // The chest seal (full flag or blocked-open error, whichever is newer)
  // parks the step for CHEST_FULL_RETRY_MS so a hand-emptied chest re-arms
  // without a bring fetch or a restart (01-review). An expired seal
  // re-arms only near home: no cross-map trip for a probably-still-sealed
  // chest (02-review) — gohome brings the body back nightly anyway. The
  // seal needs an adopted chest: an unadopted one must re-place, never
  // park on a stale flag (03-review).
  let chestParked = false
  try {
    const c = ctx && ctx.home && ctx.home.chest
    const fullAt = ctx && ctx.chestFull ? (ctx.chestFullAt == null ? 0 : ctx.chestFullAt) : null
    const errAt = ctx ? ctx.chestErrorAt : null
    const sealedAt = fullAt == null ? errAt : errAt == null ? fullAt : Math.max(fullAt, errAt)
    if (c && sealedAt != null) {
      const retry = (stockpileMod && stockpileMod.CHEST_FULL_RETRY_MS) || 600000
      if (Date.now() - sealedAt < retry) {
        chestParked = true
      } else {
        const bp = bot && bot.entity && bot.entity.position
        const r = (stockpileMod && stockpileMod.REPROBE_RADIUS) || 32
        chestParked = !(bp && typeof bp.x === 'number' &&
          Math.hypot(bp.x - c.x, bp.y - c.y, bp.z - c.z) <= r)
      }
    }
  } catch (_) { /* not parked */ }
  let known = 'none'
  try {
    if (forageMod.planForage(bot, ctx)) known = 'near'
  } catch (_) { /* no plan: explore owns that */ }
  let haul = 'none'
  try {
    if (deliverMod.haulTotal(bot, ctx) > 0) haul = 'waiting'
  } catch (_) { /* no haul */ }
  let player = 'none'
  try {
    player = deliverMod.playerStatus(bot).level
  } catch (_) { /* nobody online */ }
  // Ladder state (ipn.3): done/ready/want/wait from the behaviour's plan.
  // Unreadable reads done (light precedent): gear yields, nothing churns.
  let gear = 'done'
  try {
    const gm = require('./behaviours/gear')
    gear = gm.menuPlan({ ironOre, ingots, diamonds, sticks, maxPlanks, logs, ironPick, ironSword, diamondPick, diamondSword, tablePlaced, furnaceItem, cobble, coal }, ctx).state || 'done'
  } catch (_) { /* unreadable ladder */ }
  // Body state joins the facts so the model sees danger the FSM ignores.
  let health = 20
  try {
    const hp = bot && typeof bot.health === 'number' ? bot.health : NaN
    health = !(hp >= 0) ? 20 : hp
  } catch (_) { /* unknown health reads full, like the stub */ }
  let food = 20
  try {
    const fd = bot && typeof bot.food === 'number' ? bot.food : NaN
    food = !(fd >= 0) ? 20 : fd
  } catch (_) { /* unknown food reads full */ }
  return { time, logs, planks, maxPlanks, table, door, sword, pickaxe, cobble, sticks, coal, torches, scaffold, home, unlit, tablePlaced, inside, health, food, known, haul, player, chest, chestTodo, surplus, chestParked, ironOre, ingots, diamonds, ironPick, ironSword, diamondPick, diamondSword, furnaceItem, furnace, gearHandover, gear }
}

// Bucket thresholds for the state text (single source; the criteria below
// match these words exactly).
function logBucket(n) {
  return n <= 0 ? 'none' : n < NEED_LOGS ? 'few' : 'enough'
}
function plankBucket(n) {
  return n <= 0 ? 'none' : n < NEED_PLANKS ? 'few' : 'enough'
}
function unlitBucket(n) {
  return !(n > 0) ? 'none' : n < 5 ? 'few' : 'many'
}
// Canonical facts text: ALSO the model state (iwb lesson: the model matches
// whole-criterion similarity, so numbers go out, bucket words go in). The
// decision point fires when a bucket flips — none->few->enough — instead of
// on every picked-up log.
function goalText(facts) {
  const logs = logBucket(facts.logs)
  const planks = plankBucket(facts.planks)
  const table = facts.table > 0 ? 'yes' : 'no'
  const door = facts.door > 0 ? 'yes' : 'no'
  const health = facts.health < 6 ? 'low' : 'ok'
  const food = facts.food < 6 ? 'hungry' : 'ok'
  // Inside hides by day (atl.13): it gates only the night steps (stay/gohome
  // feasibility), but the binary in/out flip on the 2x2x2 boundary re-fires
  // the decision point all day (prod: 50% of re-decisions are facts-changed,
  // forage<->rest every ~15-60s on inside alone). Feasibility still reads the
  // true facts.inside; only the decision text (and the model state, whose day
  // menu never offers stay/gohome) goes steady.
  const inside = facts.time === 'day' ? 'no' : facts.inside
  const unlit = unlitBucket(facts.unlit)
  return `time=${facts.time} logs=${logs} planks=${planks} ` +
    `table=${table} door=${door} home=${facts.home} inside=${inside} unlit=${unlit} health=${health} food=${food} ` +
    `known=${facts.known} haul=${facts.haul} player=${facts.player} ` +
    `chest=${facts.chest} surplus=${facts.surplus} gear=${facts.gear}`
}

// atl.4 livelock guard: a recorded step failure holds while the facts text
// is unchanged and the body stays within REFAIL_DIST of the failure point.
// New facts or relocation release the step for a fresh try. Per-step map:
// alternating failures must not release each other.
const REFAIL_DIST = 32
// Steps whose failure advances their own situation never hold: explore
// consumes the failed point (the next pick is a new target by
// construction), gohome/stay retry from a fresh record through door
// phases (rw4.5 owns their trouble). Holding them would deadlock the
// spiral after one river and strand the night walk. The guard bars the
// steps that would otherwise replay the failure identically.
const SELF_ADVANCING = { explore: true, gohome: true, stay: true }
function failHolds(ctx, name, text, bot) {
  try {
    if (SELF_ADVANCING[name]) return false
    const sf = ctx && ctx.stepFail && ctx.stepFail[name]
    if (!sf || sf.text !== text) return false
    if (!sf.pos) return true
    const bp = bot && bot.entity && bot.entity.position
    if (!bp || typeof bp.x !== 'number') return true
    return Math.hypot(bp.x - sf.pos.x, bp.z - sf.pos.z) <= REFAIL_DIST
  } catch (_) {
    return false
  }
}

function goalFsm(facts, feasibleNames) {
  const ok = new Set(Array.isArray(feasibleNames) ? feasibleNames : [])
  const t = facts && facts.time
  for (const name of STEP_ORDER) {
    if (!ok.has(name)) continue
    if (name === 'stay' && t === 'day') continue // stay holds dusk and night; day goes to work
    if (name === 'gohome' && t !== 'night' && t !== 'dusk') continue
    return name
  }
  return 'rest'
}

// One question for the smart model. Short clauses on the bucket words,
// exactly like the iwb combat criteria: every longer variant regressed on
// the stand. All steps are named here so new behaviours plug in with
// one BEHAVIOURS line each (rw4.4/4.5); unregistered steps never reach ask().
const ASK_INSTRUCTIONS = 'Pick the next step: build and keep the home, or forage and deliver resources'
const STEP_CRITERIA = {
  gather: 'logs is none or few and home is not built: chop trees',
  craft: 'logs is enough or planks are few or door is no: craft planks, table and door',
  build: 'planks are enough and home is site: place the house blocks',
  light: 'unlit is few or many and time is day and home is built: place torches around the house',
  equip: 'no sword or pickaxe, or blocks are low: craft tools and dig blocks',
  gohome: 'time is dusk or night and home is built and inside is no: go inside',
  deliver: 'haul is waiting: carry it to the player',
  stockpile: 'chest is no or surplus is yes: place the home chest and bank the surplus',
  gear: 'gear is ready, want, or wait: forge better tools',
  forage: 'known is near: walk to the remembered find and dig it',
  explore: 'known is none: walk the visited boundary',
  stay: 'inside is yes and time is dusk or night: wait inside',
  rest: 'nothing else fits: rest near home',
}

// hg8 shaping: a non-jev brain is never asked a direct [work, rest] pair.
// Laya answers rest over 7 of 9 work steps unconditionally (prod 761/761
// wrong in 7d; immune to rest rewording), while goalFsm never returns rest
// from a multi-menu (rest is last and the day-skips are infeasible then) —
// so the work step is the answer by construction. Chains (>2, rest last
// and first-yes-wins) and JEV keep the full menu. Exported for the eval
// stand so the rule has one source of truth.
function shapeGoalMenu(names, model) {
  if (model !== 'jev' && names.length === 2 && names.includes('rest')) return names.filter((n) => n !== 'rest')
  return names
}

// Model step choice with the FSM as fallback and disagreement reference,
// exactly like hybridBrain: { step, source, fsm, model }. source is
// only-option (single feasible step, or a shaped [work, rest] pair answered
// without asking — shapeGoalMenu above — model not asked), goal-fsm (no ask
// method: stub brain or unit tests), <brain source> (model answered) or
// fsm-fallback (model consulted and failed). model is the consulted brain
// source or null when nothing was asked.
async function chooseStep(brain, facts, feasible) {
  const names = STEP_ORDER.filter((n) => feasible.includes(n))
  const text = goalText(facts)
  const fsm = goalFsm(facts, names)
  if (names.length <= 1) return { step: names[0] || 'rest', source: 'only-option', fsm, model: null }
  if (!brain || typeof brain.ask !== 'function') return { step: fsm, source: 'goal-fsm', fsm, model: null }
  const model = (brain.source || brain.name || 'model')
  const askNames = shapeGoalMenu(names, model)
  if (askNames.length <= 1) return { step: askNames[0] || 'rest', source: 'only-option', fsm, model: null }
  const criteria = {}
  for (const n of askNames) criteria[n] = STEP_CRITERIA[n]
  const fail = (reason) => {
    metrics.escalation.inc({ from: model, to: 'fsm', reason })
    return { step: fsm, source: 'fsm-fallback', fsm, model }
  }
  try {
    const label = await brain.ask({ state: text, instructions: ASK_INSTRUCTIONS, criteria, situation: text })
    if (!askNames.includes(label)) return fail('invalid')
    if (label !== fsm) {
      metrics.goalDisagreements.inc({ model: label, fsm })
      console.error(`goal disagree source=${model} model=${label} fsm=${fsm} menu=${names.join(',')} facts=${text}`)
    }
    return { step: label, source: model, fsm, model }
  } catch (err) {
    const msg = String((err && err.message) || err)
    const reason = (err && err.name === 'TimeoutError') ? 'timeout'
      : msg.startsWith('jev missing') ? 'invalid'
      : 'error'
    return fail(reason)
  }
}

// Rest reasons (idkcraft-atl.7): words only, no new logic. When rest is
// chosen, restWhy phrases every infeasible non-rest step from the grounds
// decide() already used: failHolds plus the facts behind each feasible()
// rule (re-checked first, so phrasing can never drift from the rule).
// Feasible steps the choice passed over are marked ready — under the FSM
// that never happens (priority order), so a ready marker always means the
// model declined it. Unregistered steps are marked off; a parallel step
// the switch does not know (atl.6) falls back to 'not feasible'. The
// 'model choice' line below is unreachable-but-safe (STEP_ORDER always
// holds other steps).
function stepWhy(name, facts, bot, ctx, text) {
  try {
    if (failHolds(ctx, name, text, bot)) return `${name} holds after failure`
  } catch (_) { /* wording best-effort */ }
  if (name === 'gather') {
    // atl.4 inline hold (not via failHolds): same final, same log count.
    try {
      const g = ctx && ctx.gather
      if (g && typeof g.final === 'string' && g.final.startsWith('failed:') && g.atLogs === facts.logs) {
        return 'gather holds after failure'
      }
    } catch (_) { /* fall through to facts */ }
  }
  let feasible = false
  try {
    feasible = !!(MENU[name] && MENU[name].feasible(facts, bot, ctx))
  } catch (_) {
    return `${name}: not feasible`
  }
  if (feasible) return null
  switch (name) {
    case 'stay':
      if (facts.time === 'day') return 'stay: daytime'
      if (facts.home !== 'built') return 'stay: home not built'
      return 'stay: not inside'
    case 'gohome':
      if (facts.time !== 'dusk' && facts.time !== 'night') return 'gohome: daytime'
      if (facts.home !== 'built') return 'gohome: home not built'
      return 'gohome: already inside'
    case 'craft':
      if ((facts.table > 0 || facts.tablePlaced) && facts.door > 0) return 'craft: nothing to craft'
      if (facts.door === 0 && facts.tablePlaced) return `craft: need 6 planks for the door, have ${facts.maxPlanks}`
      if (facts.table === 0 && !facts.tablePlaced) return `craft: need 4 planks for the table, have ${facts.maxPlanks}`
      return `craft: need ${NEED_LOGS} logs, have ${facts.logs}`
    case 'equip': {
      // Mirrors MENU.equip.feasible branch for branch (atl.6): tools first,
      // scaffold blocks only once geared.
      if ((facts.sword || 0) > 0 && (facts.pickaxe || 0) > 0) return 'equip: kit complete'
      if (!equipWant(facts)) return 'equip: no materials'
      return 'equip: no table'
    }
    case 'build': {
      // Facts-level wording; the exact remainder gate lives in the rule.
      // Item gates run first (the rule yields on a missing item first),
      // on the next cell only (xoj) — a missing door for a later cell is
      // not the reason when the table or the planks are up.
      if (facts.home === 'built') return 'build: home built'
      let kind = null
      try {
        const home = ctx && ctx.home
        if (home && home.site) {
          const ni = buildMod.nextCellIdx(bot, home, ctx.buildSkip)
          if (ni >= 0) kind = BLUEPRINT[ni].kind
        }
      } catch (_) { kind = null }
      if ((kind === 'table' && facts.table === 0) || (kind === 'door' && facts.door === 0) ||
        (kind == null && (facts.table === 0 || facts.door === 0))) return 'build: need table/door item'
      if (facts.planks < Math.min(PLANK_COUNT, 16)) return `build: need ${Math.min(PLANK_COUNT, 16)} planks, have ${facts.planks}`
      return 'build: nothing left to build'
    }
    case 'light': {
      if (facts.time !== 'day') return 'light: daytime job'
      const home = ctx && ctx.home
      if (!home || !home.site) return 'light: no home site'
      if (facts.home !== 'built') return 'light: home not built'
      if (!(facts.unlit > 0)) return 'light: yard lit'
      // Torches on hand with a dark yard is feasible (null above), so only
      // the fuel branches remain.
      let reserve = 4
      try { reserve = require('./behaviours/light').COAL_RESERVE } catch (_) { /* mirror default */ }
      if ((facts.coal || 0) <= reserve) return 'light: saving coal'
      return 'light: no sticks or wood'
    }
    case 'gather':
      if (facts.home === 'built') return 'gather: home built'
      return 'gather: load full'
    case 'deliver':
      if (facts.haul !== 'waiting') return 'deliver: nothing waiting'
      return 'deliver: nobody to deliver to'
    case 'stockpile':
      if (facts.home !== 'built') return 'stockpile: house not built yet'
      if (facts.haul === 'waiting' && facts.player !== 'none') return 'stockpile: haul waits for its player'
      if (facts.chestParked) {
        // A blocked lid seals like a full chest but must not read as one.
        try {
          if (ctx && (ctx.chestErrorAt || 0) > (ctx.chestFullAt || 0)) return 'stockpile: chest would not open'
        } catch (_) { /* wording best-effort */ }
        return 'stockpile: chest full'
      }
      if (facts.chest === 'no') return 'stockpile: no chest to adopt, nothing to place it with'
      return 'stockpile: nothing to bank'
    case 'gear': {
      if (facts.home !== 'built') return 'gear: house not built yet'
      let plan = null
      try {
        plan = require('./behaviours/gear').menuPlan(facts, ctx)
      } catch (_) {
        return 'gear: not feasible'
      }
      if (!plan || plan.state === 'done') return 'gear: ladder complete'
      if (plan.state === 'ready') return 'gear: ready'
      return `gear: ${plan.line || plan.key}`
    }
    case 'forage':
      if (facts.known !== 'near') return 'forage: nothing known nearby'
      return 'forage: known find unreachable'
    case 'explore':
      if (facts.home !== 'built') return 'explore: house not built yet'
      return 'explore: nowhere new to go'
    default:
      return `${name}: not feasible`
  }
}

function restWhy(facts, bot, ctx, names) {
  const ok = new Set(Array.isArray(names) ? names : [])
  let text = ''
  try {
    text = goalText(facts)
  } catch (_) { /* wording best-effort */ }
  const out = []
  for (const n of STEP_ORDER) {
    if (n === 'rest') continue
    let on = false
    try {
      on = registered(n)
    } catch (_) {
      on = false
    }
    if (!on) {
      out.push(`${n}: off`)
      continue
    }
    if (ok.has(n)) {
      out.push(`${n}: ready`)
      continue
    }
    let w = null
    try {
      w = stepWhy(n, facts, bot, ctx, text)
    } catch (_) {
      w = null
    }
    out.push(w || `${n}: not feasible`)
  }
  if (out.length === 0) return 'model choice'
  return out.join(', ')
}

// Registration gate: a step runs only while its behaviour is plugged into
// BEHAVIOURS (later beads join with one require line each). Deferred require:
// goal.js loads before index.js finishes, so the table is read at decide()
// time, never at load time.
function registered(name) {
  try {
    const table = require('./index').BEHAVIOURS
    return !!table && typeof table[name] === 'function'
  } catch (_) {
    return false
  }
}

// Decision point: re-decide when there is no step, the step finished
// (done/failed:*), or the facts changed. The model picks through chooseStep
// at those points only (same dedup as lastStateKey); the return shape stays
// { action, sprint, source: 'goal-fsm' } — the choice source (laya, only-
// option, fsm-fallback) rides the step log line, the next: chat and the
// goal_* metrics, never the decision source. Logs and chats only on a step
// CHANGE, so a running step with steady facts stays silent.
async function decide(bot, ctx) {
  const facts = goalFacts(bot, ctx)
  // Shelter is a night concept: a sticky gohome that finishes after sunrise
  // leaves inShelter true with no stay step to clear it, suppressing fight
  // all day (revmux 01-review loop+goal-3).
  if (ctx && facts.time === 'day') ctx.inShelter = false
  const text = goalText(facts)
  const prev = (ctx && ctx.step) || null
  const status = (ctx && ctx.stepStatus) || null
  const finished = status === 'done' || (typeof status === 'string' && status.startsWith('failed:'))
  if (finished && prev && typeof status === 'string' && status.startsWith('failed:')) {
    try {
      if (!ctx.stepFail || typeof ctx.stepFail !== 'object') ctx.stepFail = {}
      const bp = bot && bot.entity && bot.entity.position
      ctx.stepFail[prev] = { status, text, pos: bp ? { x: bp.x, y: bp.y, z: bp.z } : null }
    } catch (_) { /* guard best-effort */ }
  } else if (finished && prev && status === 'done' && ctx.stepFail && typeof ctx.stepFail === 'object') {
    // A success retires its own hold: tomorrow's identical failure re-arms
    // from scratch instead of inheriting a stale record (round-1 major).
    try { delete ctx.stepFail[prev] } catch (_) { /* guard best-effort */ }
  }
  // Night-step stickiness (rw4.5): gohome/stay own multi-tick door phases
  // (walk->open->enter->close). A facts-changed re-decision must not preempt
  // them mid-phase: stepping inside flips inside, which would hand stay the
  // step before gohome shuts the door, chats and shelters — and stepping out
  // flips it back before stay says good morning. The phase machine fails
  // itself on real trouble (no-home, cannot-reach), which re-arms choice.
  // In-flight craft windows (craft/equip/stockpile) must not be preempted mid-click:
  // re-deciding on changed facts while the async op runs corrupts the window
  // cursor (live 26.1 lesson: a table placement flips the facts before the
  // sword craft lands). The flags reset on completion, so this holds for a
  // few ticks at most.
  if (!finished && prev && ctx && (ctx.equipInFlight || ctx.craftInFlight || ctx.stockpileInFlight || ctx.lightCraftInFlight || ctx.gearInFlight || ctx.furnaceInFlight)) {
    return { action: prev, sprint: false, source: 'goal-fsm' }
  }
  if (!finished && (prev === 'gohome' || prev === 'stay')) {
    const ph = prev === 'gohome' ? ctx.gohome && ctx.gohome.phase : ctx.stay && ctx.stay.phase
    if (ph && ph !== 'done' && ph !== 'failed') return { action: prev, sprint: false, source: 'goal-fsm' }
  }
  // A chain-owned step never rides the goal shortcuts: re-issuing it here
  // would bypass feasibility and the model ask (the stale hold in another
  // coat). Force a real re-decide instead; the menu never contains
  // retreat/pillar, so ownership transfers to a goal step.
  const chainOwns = ctx && ctx.retreat && ctx.retreat.action === prev
  if (!prev || finished || ctx.goalText !== text || chainOwns) {
    const askKey = `${text}\n${status || ''}`
    if (prev && ctx.askedKey === askKey && !chainOwns) return { action: ctx.step, sprint: false, source: 'goal-fsm' }
    ctx.askedKey = askKey
    const names = Object.keys(MENU).filter((n) => {
      try {
        if (!MENU[n].feasible(facts, bot, ctx) || !registered(n)) return false
      } catch (_) {
        return false
      }
      return !failHolds(ctx, n, text, bot)
    })
    const why = !prev ? 'start' : finished ? (status === 'done' ? 'step-done' : 'step-failed') : 'facts-changed'
    const t0 = Date.now()
    const choice = await chooseStep(ctx && ctx.brain, facts, names)
    const ms = Date.now() - t0
    ctx.step = choice.step
    // A fresh equip pick starts with fresh run counters (revmux round-1):
    // stall patience spent by an earlier run must not fail the new one on
    // its first tick. Station claims (claimedTable) live outside ctx.equip
    // and survive. Same-name re-picks were already reset by done/failed.
    if (choice.step === 'equip' && choice.step !== prev) ctx.equip = {}
    if (choice.step === 'gear' && choice.step !== prev) ctx.gearRun = {}
    ctx.stepStatus = 'running'
    ctx.goalText = text
    metrics.goalSteps.inc({ step: choice.step, source: choice.source })
    for (const n of Object.keys(MENU)) metrics.goalStep.set({ step: n }, n === choice.step ? 1 : 0)
    if (choice.model) metrics.goalChoiceDuration.observe({ source: choice.model }, ms / 1000)
    // atl.7: rest explains itself — reasons stored on every rest choice
    // (even repeats, so status stays fresh), chatted only on a step change.
    if (choice.step === 'rest') {
      try {
        ctx.restWhy = restWhy(facts, bot, ctx, names)
      } catch (_) {
        ctx.restWhy = 'unknown'
      }
    } else if (choice.step !== prev) {
      ctx.restWhy = null
    }
    // An order that landed mid-await ('stop' parks, 'follow me' switches
    // work off) discards the step the tick then drops: announcing it would
    // lie, so only an actually-working bot chats. !== false keeps unit-test
    // {} ctx objects (work undefined) chatting.
    if (choice.step !== prev && !ctx.paused && ctx.work !== false) {
      const menu = STEP_ORDER.filter((n) => names.includes(n)).join(',')
      console.log(`goal step=${choice.step} prev=${prev || 'none'} source=${choice.source} fsm=${choice.fsm} why=${why} menu=${menu} facts=${text}`)
      if (choice.step === 'rest') {
        try { bot.chat(`resting: ${ctx.restWhy} (${choice.source})`) } catch (_) { /* chat best-effort */ }
      } else {
        const entry = MENU[choice.step]
        const verb = (entry && entry.verb) || choice.step
        try { bot.chat(`next: ${verb} (${choice.source})`) } catch (_) { /* chat best-effort */ }
      }
    }
  }
  return { action: ctx.step, sprint: false, source: 'goal-fsm' }
}

module.exports = { MENU, STEP_ORDER, AUTONOMOUS_EXPLORE_RADIUS, NEED_LOGS, NEED_PLANKS, goalFacts, goalText, goalFsm, decide, chooseStep, shapeGoalMenu, stepWhy, restWhy, STEP_CRITERIA, ASK_INSTRUCTIONS, logBucket, plankBucket, siteFor, adoptHome }
