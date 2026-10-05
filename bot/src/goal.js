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

const { countItems, wornItems } = require('./perception')
const Vec3 = require('vec3')
const buildMod = require('./behaviours/build')
const forageMod = require('./behaviours/forage')
const deliverMod = require('./behaviours/deliver')
const stockpileMod = require('./behaviours/stockpile')
const PLANK_COUNT = buildMod.PLANK_COUNT
const metrics = require('./metrics')

// House budget (epic rw4, two blueprints since jr2.1): NEED_PLANKS is the
// loose-plank target for a NEW (v2) house — 92 walls+roof+partition plus 5
// bedroom floor (1c4), plus the table (4) and door (6) the gather formula
// adds on top, like the v1 budget did (38 + 4 + 6 = 48). Loads stay 14 logs
// (the v1-proven batch): a v2 house takes ~2 full loads. Adopted v1 houses
// keep their old budget via needPlanks(home), so a small repair never
// triggers a v2-sized gather.
const NEED_LOGS = 14
const NEED_PLANKS = 107
const NEED_PLANKS_V1 = 48
function needPlanks(home) {
  if (home && home.site && home.v !== 2) return NEED_PLANKS_V1
  return NEED_PLANKS
}

// Night-hurt hold (ck3): low health (the goalText 'health=low' bucket) at
// night keeps the bot off the outdoor work — prod died twice at the site
// building at 2 hp next to zombies. Both inputs are in goalText, so the
// first hurt night tick re-decides a sticky build/gather.
// ponytail: no hostile check — night spawns them anyway; add one if
// hurt-night idling ever costs real work.
function nightHurt(facts) {
  return facts.time === 'night' && facts.health < 6
}

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
    // Night-far (ipn.12): at night a far march is a death march — shelter
    // owns it (see nightFarFromHome). Dusk marches at any distance.
    feasible: (facts, bot, ctx) => (facts.time === 'dusk' || facts.time === 'night') && facts.home === 'built' && facts.inside === 'no' &&
      !(facts.time === 'night' && nightFarFromHome(bot, ctx)) && !gohomeLatched(ctx, bot) && !castleNight(bot, ctx),
    chat: () => 'on my own: heading home',
    verb: 'heading home',
  },
  shelter: {
    // Night shelter (ipn.12): the night-far complement of gohome — pillar
    // up and hold where you are till dawn instead of marching the dark.
    // Castle night (g0z.21): at the far castle it shelters from dusk on.
    feasible: (facts, bot, ctx) => facts.home === 'built' && facts.inside === 'no' && shelterFits(facts, bot, ctx),
    chat: () => 'on my own: sheltering here till dawn',
    verb: 'sheltering till dawn',
  },
  craft: {
    // Batch gate: a full NEED_LOGS load crafts at once. Starting on the first
    // picked-up log would preempt gather with a chat line per log.
    // The door needs a placed table (bot.craft requires the block): without
    // one the step could neither progress nor finish, churning done forever.
    // Frame logs (g0z.12): while the castle's next cell is a Fachwerk beam
    // the logs ARE the castle batch — a full load must not turn to planks.
    feasible: (facts) => (facts.logs >= NEED_LOGS && !String(facts.castle).startsWith('frame-')) || (facts.maxPlanks >= 4 && facts.table === 0 && !facts.tablePlaced) || (facts.maxPlanks >= 6 && facts.door === 0 && facts.tablePlaced),
    chat: () => 'on my own: crafting planks and tools',
    verb: 'crafting',
  },
  equip: {
    // Starter-kit rebuild (atl.6, owner): pickaxe -> sword first (they need
    // sticks-or-planks-or-logs plus a table, inventory or placed), scaffold
    // blocks only once geared (they dig by hand). Blocks alone never preempt
    // early gather: a fresh bot chops first, digs later.
    // x15: a wooden/golden pickaxe is an unfinished kit while the stone
    // chain is on hand and the behaviour's own table probe passes — the
    // gate and the behaviour share that probe, so a ghost or unloaded
    // claim only digs scaffold (or reads kit-complete) instead of
    // diverting into an instant-done re-pick loop (revmux 01).
    feasible: (facts, bot, ctx) => {
      // Same-reason day latch (ipn.11, beds sheepLatched mirror): a repeated
      // identical failure yields the rest of the day (gear starves otherwise).
      try { if (require('./behaviours/equip').equipLatched(ctx, bot)) return false } catch (_) { /* unlatched */ }
      const upgrade = equipUpgradeDue(bot, ctx)
      if ((facts.sword || 0) <= 0 || (facts.pickaxe || 0) <= 0 || upgrade) {
        if (!upgrade && !equipWant(facts)) return false
        if ((facts.table || 0) <= 0 && !facts.tablePlaced) return false
        // The house table first (h9z): while build can lay the site table,
        // the table item belongs to build — placing roadside instead would
        // eat the item build needs and strand the house (prod: 153 planks,
        // home=site, door=yes, no table, equip failing no-table on a ghost
        // claim while forage looped as the only option).
        if ((facts.table || 0) > 0 && tableYieldToBuild(facts, bot, ctx)) return false
        return true
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
      if (nightHurt(facts)) return false
      const home = ctx && ctx.home
      if (!home && !(bot && bot.spawnPoint)) return false
      // Skip retry (revmux 01 core-4): re-probe stamped skips past the
      // window — a restored stale skip drops on the first decide, so a
      // deploy heals stale holes like the pre-persistence code did.
      try { buildMod.pruneBuildSkips(ctx) } catch (_) { /* prune best-effort */ }
      // No scannable origin (no home yet, or a home without site): nothing
      // is verifiable, so the whole wall+roof count counts.
      if (!home || !home.site) return facts.planks >= Math.min(PLANK_COUNT, 16)
      let planks = 0
      let other = 0
      try {
        const skip = new Set(Array.isArray(ctx.buildSkip) ? ctx.buildSkip : [])
        const plan = buildMod.blueprintFor(home)
        for (let i = 0; i < plan.length; i++) {
          if (skip.has(i)) continue
          if (!buildMod.cellDone(bot, home, plan[i])) {
            // A floor patch (1c4) spends a loose plank like a wall cell.
            if (plan[i].kind === 'planks' || plan[i].kind === 'fill') planks++
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
        const cell = buildMod.blueprintFor(home)[next]
        // 45j: an unloaded site (respawn far away) reads every cell as
        // undone, so the next cell is the long-placed table — the table
        // gate would drop build for good. Batch on planks only: the build
        // step walks to the site and re-scans there. A built house far
        // away is not unfinished work (revmux 01): no walk home to repair.
        if (!buildMod.cellLoaded(bot, home, cell)) return !home.built && facts.planks >= Math.min(PLANK_COUNT, 16)
        const kind = cell.kind
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
  beds: {
    // The two bedroom beds (jr2.2): wool hunt, craft at the table, place in
    // the bedrooms — the bot's first (sleep sets the home respawn). Day only:
    // the hunt owns the body and must not run past dark (bring dusk-cancels
    // self orders, but the step never opens one at night in the first place).
    // Non-v2 homes read beds='both' (nothing owed), so no version check here.
    // 9kd/9qt0: two sheepless hunts latch beds off in real time — until a
    // woolly sheep is sighted 30+ min after the last failure, or 2 h pass
    // (beds.sheepLatched; death-respawns release the stepFail hold, so it
    // cannot hold this).
    feasible: (facts, bot, ctx) => {
      if (!(facts.time === 'day' && facts.home === 'built' && (facts.beds === 'none' || facts.beds === 'one'))) return false
      try { return !require('./behaviours/beds').sheepLatched(ctx, bot) } catch (_) { return true }
    },
    chat: () => 'on my own: making the beds',
    verb: 'making beds',
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
      const lm = require('./behaviours/light')
      if (lm.spendableFuel((facts.coal || 0) - (facts.charcoal || 0), facts.charcoal) <= 0) {
        // 33vm charcoal path: a log cooking, or wood plus a standing home
        // furnace (light.js torchOp mirror) — never coal below the reserve.
        if (ctx && typeof ctx.lightSmeltAt === 'number') return true
        if (!lm.charcoalWood(facts.logs || 0, facts.planks || 0, facts.maxPlanks || 0, facts.sticks || 0)) return false
        try { return !!require('./behaviours/furnace').furnaceReady(bot, ctx) } catch (_) { return false }
      }
      // maxPlanks, not planks: stick recipes cannot mix woods (01 minor).
      return (facts.sticks || 0) > 0 || (facts.maxPlanks || 0) >= 2 || (facts.logs || 0) >= 1
    },
    chat: () => 'on my own: lighting the yard',
    verb: 'lighting torches',
  },
  castlefetch: {
    // Castle material (g0z.4): fetch the next castle batch — castle chest,
    // craft, then dig/chop (behaviours/castlefetch.js). Day only, after the
    // house chain, before the castle step itself: a running fetch keeps
    // going to its stack target (no shuttle per 16 cells); a fresh one
    // starts only while the castle has nothing to lay now. Nothing
    // reachable fails it and failHolds parks it (bounded, see
    // CASTLEFETCH_RETRY_MS) — never feasible-but-no-progress.
    feasible: (facts, bot, ctx) => castleFetchGo(facts, bot, ctx),
    chat: () => 'on my own: fetching castle material',
    verb: 'fetching castle material',
  },
  castle: {
    // The castle project (g0z.3): a day job after the house chain. Feasible
    // only when it progresses NOW: a keep-clear dig next, or the next
    // cell's material on hand as a batch (castle.js menuFact). A running
    // leg keeps going on a partial batch ('some') — the word flips at the
    // batch line mid-leg, and dropping there would strand the remainder.
    // stay/gohome/equip outrank it, so the bot still sleeps and rearms.
    // A running fetch owns the body to its stack target (revmux 01): the
    // model menu must not cut it at the batch line either.
    feasible: (facts, bot, ctx) => castleGo(facts, ctx) &&
      !(ctx && ctx.step === 'castlefetch' && ctx.stepStatus === 'running' && castleFetchGo(facts, bot, ctx)),
    chat: () => 'on my own: building the castle',
    verb: 'building the castle',
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
    // is the menu-wide twin of this gate). gyw: relocation past the
    // failure point releases — new ground may hold nearer trees.
    feasible: (facts, bot, ctx) => {
      if (nightHurt(facts)) return false
      try {
        if (gatherFailedHolds(ctx && ctx.gather, facts.logs, bot)) return false
      } catch (_) { /* fall through to facts */ }
      if (facts.home === 'built') {
        // Post-build top-up for the beds only (jr2.2): the house budget
        // usually leaves 6+ planks, but a tight exact-wood remainder must not
        // strand the beds with nobody left to chop. Single-wood count — bed
        // variants bind one wood, so a mixed 2+2+2 is still short. A partial
        // log load never reads as covered (craft only converts full 14-log
        // batches — 3 leftover logs would otherwise strand between this gate
        // and the batch gate with nothing converting them). Bounded by the
        // bed need: once both beds are in (or the planks cover them), the bot
        // never farms again.
        if (facts.beds !== 'none' && facts.beds !== 'one') return false
        return (facts.maxPlanks || 0) < 6 && (facts.logs || 0) < NEED_LOGS
      }
      const total = facts.planks + facts.logs * 4
      const need = needPlanks(ctx && ctx.home) + (facts.table > 0 ? 0 : 4) + (facts.door > 0 ? 0 : 6)
      // 8cx: the started load finishes only while loose planks alone are
      // short — with the budget covered a sub-batch remainder is no reason
      // to chop (prod: 136 -> 276 planks over 7 laps on 7 leftover logs).
      return total < need || (facts.logs > 0 && facts.logs < NEED_LOGS && facts.planks < need)
    },
    chat: () => 'on my own: gathering logs',
    verb: 'chopping wood',
  },
  deliver: {
    // Unload first: a waiting haul goes to the nearest online player
    // before the next forage leg. Nobody online (dxl) -> infeasible.
    // The owner wants the castle (g0z.3): a workable castle leg goes first,
    // for the model's menu too (the FSM already ranks castle above).
    feasible: (facts, bot, ctx) => facts.haul === 'waiting' && facts.player !== 'none' && !castleGo(facts, ctx),
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
      if (!plan || plan.state === 'done' || plan.state === 'hand') return false
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
    // Nothing known -> explore finds more. A failed leg holds FORAGE_RETRY_MS
    // past any known flip (bt8s, the castlefetch demand precedent): the
    // text-keyed failHolds releases on every near/none flip and churned
    // forage<->explore every few seconds on the rig.
    feasible: (facts, bot, ctx) => facts.known === 'near' && !nightHurt(facts) && !castleGo(facts, ctx) && !forageHeld(ctx),
    chat: () => 'on my own: foraging resources',
    verb: 'foraging',
  },
  explore: {
    // Blind search once the house stands; pre-house gaps rest (rw4 owns the
    // body until built) — except the stranded hard state (gyw): a
    // failed-holding gather on an alone day opens the home-anchored bounded
    // spiral, so the menu moves the bot to new ground instead of idling
    // where gather died. Night pre-house never wanders, and neither does a
    // bot with anyone online (p4s: stay with the player, the owner sees).
    feasible: (facts, bot, ctx) => {
      if (facts.home === 'built') return true
      if (facts.time !== 'day') return false
      if (facts.player !== 'none') return false
      try {
        return gatherFailedHolds(ctx && ctx.gather, facts.logs, bot)
      } catch (_) {
        return false
      }
    },
    chat: () => 'on my own: exploring outward',
    verb: 'exploring',
  },
  rest: {
    feasible: () => true,
    chat: (facts) => (facts.home === 'none' ? 'on my own: resting near spawn' : 'on my own: resting at the home site'),
    verb: 'resting',
  },
}

// Castle leg can progress now (g0z.3): day only, an unparked castle whose
// next cell is a keep-clear dig or has its material batch on hand; a
// running castle leg finishes a partial batch. Shared by MENU.castle and
// the deliver/forage yield.
function castleGo(facts, ctx) {
  const w = facts && facts.castle
  if (typeof w !== 'string' || facts.time !== 'day') return false
  if (!registered('castle')) return false
  if (w === 'clear' || w === 'finish' || w.endsWith('-batch')) return true
  return w.endsWith('-some') && !!ctx && ctx.step === 'castle' && ctx.stepStatus === 'running'
}

// Castle fetch can progress now (g0z.4): day, a material word, the batch
// still short (castlefetch.demand — the behaviour's own done test), and
// the castle unable to lay now unless this fetch is the running leg.
// Stone needs a pickaxe: without one equip rearms first (it only replaces
// an absent pick), so a pick broken mid-batch hands over and comes back.
// ponytail: a castle chest full of cobble still waits for the pickaxe;
// add a chest probe here if a pickless owner-fed castle ever matters.
function castleFetchGo(facts, bot, ctx) {
  const w = facts && facts.castle
  if (typeof w !== 'string' || facts.time !== 'day') return false
  if (!/-(none|some|batch)$/.test(w)) return false
  if (!registered('castlefetch') || !registered('castle')) return false
  if (w.startsWith('stone-') && !((facts.pickaxe || 0) > 0)) return false
  if (castleGo(facts, ctx) && !(ctx && ctx.step === 'castlefetch' && ctx.stepStatus === 'running')) return false
  try {
    const d = require('./behaviours/castlefetch').demand(bot, ctx)
    return !!d && d.short > 0
  } catch (_) {
    return false
  }
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

// Pickaxe-upgrade diversion (x15): wooden/golden in hand, the stone chain
// affordable, and the behaviour's own table probe passing — the SAME probe
// equip() runs before crafting, so the gate can never divert where the
// behaviour would dig or finish done (an optimistic claim here wedged the
// menu into an instant-done re-pick loop, revmux 01). Single source for
// MENU.equip.feasible and the stepWhy wording; deferred require (same
// equip->craft->goal cycle as the SCAFFOLD_LOW read in feasible).
function equipUpgradeDue(bot, ctx) {
  try {
    const equipMod = require('./behaviours/equip')
    return !!equipMod.stoneUpgradeDue(bot) && !!equipMod.tableReady(bot, ctx)
  } catch (_) {
    return false
  }
}

// A claimed table station the world still shows (h9z): the claim plus a
// live block read, furnace-furnaceReady precedent. A verified-different
// block (air: mined table) is a ghost and reads as no station, so craft
// rebuilds from planks instead of equip failing no-table forever. Null or
// a throwing read keeps the claim: an unloaded chunk is unknown, never
// gone — a bot far from home must not rebuild tables every trip.
function stationStanding(bot, pos) {
  try {
    if (!pos || typeof pos.x !== 'number') return false
    let block = null
    try {
      block = bot && bot.blockAt ? bot.blockAt(new Vec3(pos.x, pos.y, pos.z)) : null
    } catch (_) {
      return true
    }
    if (!block) return true
    return block.name === 'crafting_table'
  } catch (_) {
    return true
  }
}

// While build can lay the house table, equip's table item belongs to build
// (h9z): a homeless bot yields so build founds the site and lays it there;
// a sited bot yields while the blueprint table cell stands empty. A stood,
// skipped (refused x3), or unlayable cell releases the item to the roadside
// branch, as does an unregistered or infeasible build — equip must never
// wait on a step that cannot run.
function tableYieldToBuild(facts, bot, ctx) {
  try {
    if (!registered('build')) return false
    let feasible = false
    try {
      feasible = !!MENU.build.feasible(facts, bot, ctx)
    } catch (_) {
      return false
    }
    if (!feasible) return false
    const home = ctx && ctx.home
    if (!home || !home.site) return true
    const skip = Array.isArray(ctx.buildSkip) ? ctx.buildSkip : []
    if (skip.includes(0)) return false
    return !buildMod.cellDone(bot, home, buildMod.blueprintFor(home)[0])
  } catch (_) {
    return false
  }
}

// Night death-march guard (idkcraft-ipn.12): without a bed the respawn is
// world spawn (~230 blocks from home in prod), and a night gohome march
// through the dark dies again and again (prod: 53 of 62 deaths in gohome).
// At night the bot only walks home when close; far from home it shelters in
// place till dawn. Dusk still marches at any distance (the going-home
// window) — nightfall forces a still-far march into shelter past the
// gohome stickiness (nightFarWalk in decide). Range is the retreat chain's
// (single source: beyond it a walk through mobs is a death march).
// Unreadable position reads near: the old march, never a new hold.
function nightFarFromHome(bot, ctx) {
  try {
    const range = require('./behaviours/retreat').HOME_WALK_RANGE || 96
    const site = ctx && ctx.home && ctx.home.site
    const bp = bot && bot.entity && bot.entity.position
    if (!site || typeof site.x !== 'number' || !bp || typeof bp.x !== 'number') return false
    return Math.hypot(bp.x - site.x, bp.z - site.z) > range
  } catch (_) {
    return false
  }
}

// Per-night gohome latch (idkcraft-xhqv): gohome is self-advancing (never
// held by failHolds), so a door that will not open or a hole it cannot
// reach failed and re-picked at the same spot till dawn. GOHOME_LATCH_FAILS
// failures within REFAIL_DIST of each other latch gohome out for the night;
// shelter takes it near home too. Stamped with the MC day (dusk and night
// share one, dawn bumps it), so a latch from a night the work loop never
// saw end (follow/comehome across dawn) is stale, not inherited (revmux 01).
const GOHOME_LATCH_FAILS = 2
function mcDay(bot) {
  const d = bot && bot.time && bot.time.day
  return typeof d === 'number' ? d : null
}
function gohomeLatched(ctx, bot) {
  const gl = ctx && ctx.gohomeLatch
  return !!gl && gl.day === mcDay(bot) && gl.fails >= GOHOME_LATCH_FAILS
}
function noteGohomeFail(ctx, bot, status) {
  const bp = bot && bot.entity && bot.entity.position
  const pos = bp && typeof bp.x === 'number' ? { x: bp.x, y: bp.y, z: bp.z } : null
  const day = mcDay(bot)
  const gl = ctx.gohomeLatch && ctx.gohomeLatch.day === day ? ctx.gohomeLatch : null
  // Unreadable position counts as the same spot (holds, like failHolds).
  const same = !!gl && (!gl.pos || !pos || Math.hypot(pos.x - gl.pos.x, pos.z - gl.pos.z) <= REFAIL_DIST)
  ctx.gohomeLatch = same ? { fails: gl.fails + 1, pos: gl.pos || pos, day } : { fails: 1, pos, day }
  if (ctx.gohomeLatch.fails === GOHOME_LATCH_FAILS) {
    const f = (p) => (p ? `${Math.round(p.x)},${Math.round(p.y)},${Math.round(p.z)}` : '?')
    console.log(`goal gohome latched for the night fails=${ctx.gohomeLatch.fails} status=${status} pos=${f(pos)}`)
  }
}
// Castle night (idkcraft-g0z.21): prod built a castle 113 blocks from
// home and spent the nights marching between them (gohome failed x46,
// deaths clustered on the night transitions). While an unfinished,
// unparked castle stands far from home and the bot works at it, the night
// is spent in the shelter step by the site — from dusk, so the dusk march
// never starts — and dawn finds it at the castle. The shelter's dig-in
// already vetoes castle-protected cells (recover.digInVeto).
// ponytail: distance to the site centre; a per-cell footprint test if a
// big site ever needs it.
const CASTLE_NIGHT_DIST = 48
function castleNight(bot, ctx) {
  try {
    const st = ctx && ctx.castle
    const c = st && st.site
    const h = ctx.home && ctx.home.site
    const bp = bot && bot.entity && bot.entity.position
    if (!c || !h || !bp || typeof c.x !== 'number' || typeof h.x !== 'number' || typeof bp.x !== 'number') return false
    if (st.parked || st.phase === 'complete') return false
    let cx = c.x
    let cz = c.z
    try {
      const { w, d } = require('./castle').siteDimensions(st.rot | 0, st.blueprintVersion)
      cx += w / 2
      cz += d / 2
    } catch (_) { /* corner */ }
    return Math.hypot(cx - h.x, cz - h.z) > CASTLE_NIGHT_DIST &&
      Math.hypot(bp.x - h.x, bp.z - h.z) > CASTLE_NIGHT_DIST &&
      Math.hypot(bp.x - cx, bp.z - cz) <= CASTLE_NIGHT_DIST
  } catch (_) {
    return false
  }
}
// Shelter owns the night when home is too far to walk, gohome is latched,
// or the bot is at its far castle.
function shelterOwns(bot, ctx) {
  return nightFarFromHome(bot, ctx) || gohomeLatched(ctx, bot) || castleNight(bot, ctx)
}
// Shelter fits now: the night it owns, or a castle dusk (g0z.21).
function shelterFits(facts, bot, ctx) {
  const t = facts && facts.time
  return (t === 'night' && shelterOwns(bot, ctx)) || (t === 'dusk' && castleNight(bot, ctx))
}

// Priority order (epic rw4 + atl.2 + atl.6): night steps first, then craft,
// rearm (equip), build, gather, then unload (deliver), dig (forage), search
// (explore), rest last.
// goalFsm is pure priority over the feasible names it is given.
const STEP_ORDER = ['stay', 'gohome', 'shelter', 'craft', 'equip', 'build', 'beds', 'light', 'castlefetch', 'castle', 'gather', 'deliver', 'stockpile', 'gear', 'forage', 'explore', 'rest']
// Alone-explore cap (idkcraft-dxl): without players the bot must not wander
// past this many blocks from home — new chunks bloat the host disk. Read by
// atl.1 explore.js when it lands; until then no behaviour consumes it.
const AUTONOMOUS_EXPLORE_RADIUS = 256

// Home site shape (bead .4, two blueprints since jr2.1): site is the
// SW-corner origin at ground level, interior the standable box inside,
// door the LOWER door cell, table the workbench cell — null until the
// workbench is really placed. rw4.3 treats ctx.home.table as a PLACED
// station (craft walks to it and crafts the door at it), so claiming the
// coords early would deadlock craft at an empty cell; build claims them
// the tick the table cell lands. v marks the blueprint (1: 4x4 hut with
// the table outside; 2: 7x6 house with the rooms inside); new sites are
// always founded v2, v1 comes only from adopting an old house.
function makeHome(ox, oy, oz, v) {
  if (v === 1) {
    return {
      site: { x: ox, y: oy, z: oz },
      interior: { min: { x: ox + 1, y: oy, z: oz + 1 }, max: { x: ox + 2, y: oy + 1, z: oz + 2 } },
      door: { x: ox + 1, y: oy, z: oz },
      table: null,
      built: false,
      v: 1,
    }
  }
  return {
    site: { x: ox, y: oy, z: oz },
    interior: { min: { x: ox + 1, y: oy, z: oz + 1 }, max: { x: ox + 5, y: oy + 1, z: oz + 4 } },
    door: { x: ox + 3, y: oy, z: oz },
    table: null,
    built: false,
    v: 2,
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

// Pick a flat 7x6 site (jr2.1 blueprint): all 42 columns resolve and lie
// within one block. First fit wins; after 8 rejections the first candidate
// is taken as-is — ponytail: let the house hang or half-bury rather than
// block the epic.
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
    for (let ix = 0; ix < 7 && ok; ix++) {
      for (let iz = 0; iz < 6 && ok; iz++) {
        const gy = groundY(bot, ox + ix, oz + iz, cy + 8)
        if (gy == null) { ok = false; break }
        ys.push(gy)
      }
    }
    if (!ok || ys.length !== 42) continue
    const y0 = Math.min(...ys)
    if (ys.every((y) => y === y0 || y === y0 + 1)) return makeHome(ox, y0, oz, 2)
  }
  const [fx, fz] = SITE_DIRS[0]
  const fy = groundY(bot, cx + fx, cz + fz, cy + 8)
  return makeHome(cx + fx, fy == null ? cy : fy, cz + fz, 2)
}

// Adopt a house built by an earlier run: a door within 32 of spawn means
// home; findBlocks may return the UPPER half, so step down when the block
// below is also a door. Since jr2.1 the door fits two origins —
// door − (3,0,0) for a v2 house, door − (1,0,0) for a v1 hut — told apart
// by the corner columns (see isV2House). A lone v1 hut reads air there. An
// unreadable probe (dark neighbour chunk) skips the candidate — the callers
// wait for chunks and retry — instead of misreading the version: a v2
// house read as v1 would run the v1 repair plan at the wrong origin (the
// door itself is shared, but the walls, table cell and spots all shift).
// A door alone is not a house (idkcraft-6bl): the candidate origin must
// hold the workbench at its plan cell plus ADOPT_QUORUM plan cells with
// the RIGHT block (cellDone kind match — planks/table/door at exact
// offsets, never mere non-air), else the door is foreign and the scan
// moves to the next door. The table is the discriminator: no vanilla
// structure generates a crafting table, while our build lays it FIRST,
// before the door (plan[0] on both blueprints) — so any door-carrying
// own house attempted it, and a count alone cannot separate: the live
// 6bl structure scores 26+ plank matches, above an own mid-build house
// (v1: 13, v2: 23). Accepted tail: an own house whose table was mined
// (or skipped) meets a wiped memory with a reject and founds a new site
// instead of repairing — the safe direction. Dark cells read as
// mismatches: a dark own house misses and the callers retry once chunks
// stream in.
// built is exact, not lax (idkcraft-hlf): done means the repair plan is
// empty — the same nextCellIdx===-1 definition the build step and the
// work-tick revalidation use. The old any-non-air presence called
// terrain-filled cells done and froze half-verdicts with no retry.
const ADOPT_QUORUM = 10
// Distinct doors tried per adopt scan: with rejection now possible the
// nearest door may be foreign while ours stands behind it — first passing
// wins. findBlocks returns both halves of every door, so the scan reads
// twice the budget and dedupes to lower halves below (revmux 01 minors:
// 5 raw hits cover ~2.5 doors, and 3 nearer foreign doors would fill it).
const ADOPT_DOORS = 5
function adoptHome(bot) {
  try {
    const spawn = bot && bot.spawnPoint
    if (!spawn || typeof spawn.x !== 'number') return null
    const found = bot.findBlocks({
      matching: (b) => !!b && typeof b.name === 'string' && b.name.endsWith('_door'),
      maxDistance: 32,
      count: ADOPT_DOORS * 2,
    })
    if (!found || !found.length) return null
    const tried = new Set()
    for (const door of found) {
      if (tried.size >= ADOPT_DOORS) break
      const lo = doorLower(bot, door)
      const key = `${lo.x},${lo.y},${lo.z}`
      if (tried.has(key)) continue
      tried.add(key)
      const home = tryAdoptDoor(bot, door)
      if (home) {
        try { bot.chat(`my home is at ${home.site.x} ${home.site.y} ${home.site.z}`) } catch (_) { /* chat best-effort */ }
        return home
      }
    }
    return null
  } catch (_) {
    return null
  }
}

// Lower-half normalize: findBlocks may return the UPPER half, so step down
// when the block below is also a door. Shared by the scan dedupe above and
// the per-door verify below.
function doorLower(bot, at) {
  let dx = Math.floor(at.x)
  let dy = Math.floor(at.y)
  let dz = Math.floor(at.z)
  try {
    const below = bot.blockAt(new Vec3(dx, dy - 1, dz))
    if (below && typeof below.name === 'string' && below.name.endsWith('_door')) dy--
  } catch (_) { /* keep as found */ }
  return { x: dx, y: dy, z: dz }
}

function tryAdoptDoor(bot, at) {
  const lo = doorLower(bot, at)
  const dx = lo.x
  const dy = lo.y
  const dz = lo.z
  const v2 = isV2House(bot, dx, dy, dz)
  if (v2 == null) return null // probe dark: next door, callers retry later
  const home = v2 ? makeHome(dx - 3, dy, dz, 2) : makeHome(dx - 1, dy, dz, 1)
  const plan = buildMod.blueprintFor(home)
  // The workbench first: our build lays it before the door, no vanilla
  // structure has one — a missing table is a foreign door, full stop.
  if (!buildMod.cellDone(bot, home, plan[0])) return null
  let kindred = 0
  for (const cell of plan) {
    try {
      // Fill cells carry no authorship evidence (revmux 01 body-2): dirt
      // under a foreign door reads done, so counting them spends 5 of the
      // 10 quorum points on mere terrain.
      if (cell.kind !== 'fill' && buildMod.cellDone(bot, home, cell)) kindred++
    } catch (_) { /* unscannable reads as mismatch */ }
  }
  if (kindred < ADOPT_QUORUM) return null // foreign door: keep looking
  // Claim the table coords only when the workbench block is really there
  // (same placed-station contract as a fresh site).
  try {
    const t = plan[0]
    const tb = bot.blockAt(new Vec3(home.site.x + t.dx, home.site.y + t.dy, home.site.z + t.dz))
    if (tb && tb.name === 'crafting_table') {
      home.table = new Vec3(home.site.x + t.dx, home.site.y + t.dy, home.site.z + t.dz)
    }
  } catch (_) { /* unverifiable: leave unclaimed */ }
  home.built = buildMod.nextCellIdx(bot, home, []) === -1
  return home
}

// True when planks stand at the v2 corner columns around the door at
// (dx,dy,dz); false for a v1 hut; null when any probe cell is unreadable.
// Shape: EITHER front corner column plus EITHER back corner column. One
// column reads planks at either wall level (a skipped ground cell still
// carries its upper ring — unless the upper skipped as no-ref too, which
// the single-skip cascade in the lay order does cause). A single missing
// column must never flip the version: with both fronts required, one
// refused corner (mob in the cell, terrain jut) plus its no-ref upper
// would read a v2 house as v1 and run the v1 repair plan at the wrong
// origin. A lone v1 hut still reads air at all four columns. Accepted
// residual: a house with a whole side (both fronts or both backs) empty
// reads v1 — a catastrophic build no corner probe can save.
function isV2House(bot, dx, dy, dz) {
  try {
    const ox = dx - 3
    const oz = dz
    const colPlanks = (cx, cz) => {
      let lo = null
      let hi = null
      try {
        lo = bot.blockAt(new Vec3(ox + cx, dy, oz + cz))
        hi = bot.blockAt(new Vec3(ox + cx, dy + 1, oz + cz))
      } catch (_) {
        return null
      }
      if (!lo || !hi) return null
      const planks = (b) => !!b && typeof b.name === 'string' && b.name.endsWith('_planks')
      return planks(lo) || planks(hi)
    }
    const frontW = colPlanks(0, 0)
    const frontE = colPlanks(6, 0)
    const backW = colPlanks(0, 5)
    const backE = colPlanks(6, 5)
    if (frontW == null || frontE == null || backW == null || backE == null) return null
    return (frontW || frontE) && (backW || backE)
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
  const charcoal = countItems(bot, (n) => n === 'charcoal') // 33vm: coal above holds both; light spends charcoal past the reserve
  const torches = countItems(bot, (n) => n === 'torch')
  const scaffold = countItems(bot, (n) => n === 'dirt' || n === 'cobblestone')
  const ironOre = countItems(bot, (n) => n === 'raw_iron')
  const ingots = countItems(bot, (n) => n === 'iron_ingot')
  const diamonds = countItems(bot, (n) => n === 'diamond')
  const ironPick = countItems(bot, (n) => n === 'iron_pickaxe')
  const ironSword = countItems(bot, (n) => n === 'iron_sword')
  const diamondPick = countItems(bot, (n) => n === 'diamond_pickaxe')
  const diamondSword = countItems(bot, (n) => n === 'diamond_sword')
  const bucket = countItems(bot, (n) => n === 'bucket')
  const waterBucket = countItems(bot, (n) => n === 'water_bucket')
  // Armour (ipn.6): pack counts under the piece name (tools convention),
  // worn counts beside them — the menu must read done once the set is on
  // the body (else gear stays feasible forever and starves the steps
  // below it), while owner math stays pack-only (revmux 01 core-1/body-1:
  // a worn self piece must never hold a tossed spare in 'hand').
  const armor = (name) => countItems(bot, (n) => n === name)
  const ironHelmet = armor('iron_helmet')
  const ironChestplate = armor('iron_chestplate')
  const ironLeggings = armor('iron_leggings')
  const ironBoots = armor('iron_boots')
  const diamondHelmet = armor('diamond_helmet')
  const diamondChestplate = armor('diamond_chestplate')
  const diamondLeggings = armor('diamond_leggings')
  const diamondBoots = armor('diamond_boots')
  const wornIronHelmet = wornItems(bot, 'iron_helmet')
  const wornIronChestplate = wornItems(bot, 'iron_chestplate')
  const wornIronLeggings = wornItems(bot, 'iron_leggings')
  const wornIronBoots = wornItems(bot, 'iron_boots')
  const wornDiamondHelmet = wornItems(bot, 'diamond_helmet')
  const wornDiamondChestplate = wornItems(bot, 'diamond_chestplate')
  const wornDiamondLeggings = wornItems(bot, 'diamond_leggings')
  const wornDiamondBoots = wornItems(bot, 'diamond_boots')
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
    // Floored like home.isInside (revmux jr2.3-02): the box holds
    // inclusive block coords, and a raw float reads the back row outside
    // while the helper reads it inside — gohome then finishes 'done' and
    // is re-picked every tick all night.
    if (bp && interior && interior.min && interior.max &&
      Math.floor(bp.x) >= interior.min.x && Math.floor(bp.x) <= interior.max.x &&
      Math.floor(bp.y) >= interior.min.y && Math.floor(bp.y) <= interior.max.y &&
      Math.floor(bp.z) >= interior.min.z && Math.floor(bp.z) <= interior.max.z) inside = 'yes'
  } catch (_) { /* not inside */ }
  // A station the equip step placed also counts (atl.6): otherwise the
  // craft step rebuilds a table from planks every time equip places one.
  // Both claims verify against the world (h9z): a ghost (mined table)
  // reads as no station so craft rebuilds instead of equip failing
  // no-table forever; an unloaded chunk keeps its claim (stationStanding).
  const tablePlaced = stationStanding(bot, ctx && ctx.home && ctx.home.table) ||
    stationStanding(bot, ctx && ctx.claimedTable)
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
    if (stockpileMod.surplusCount(bot, ctx) >= batch) surplus = 'yes'
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
  // Bedroom beds (jr2.2): none/one/both placed. Deferred require (the light
  // precedent — goal.js loads inside the behaviour chain). Unreadable reads
  // both: beds yields, nothing churns.
  let beds = 'both'
  try {
    beds = require('./behaviours/beds').bedsFact(bot, ctx && ctx.home) || 'both'
  } catch (_) { /* unreadable beds */ }
  // Ladder state (ipn.3): done/ready/want/wait from the behaviour's plan.
  // Unreadable reads done (light precedent): gear yields, nothing churns.
  let gear = 'done'
  try {
    const gm = require('./behaviours/gear')
    gear = gm.menuPlan({ ironOre, ingots, diamonds, sticks, maxPlanks, logs, ironPick, ironSword, diamondPick, diamondSword, bucket, waterBucket, ironHelmet, ironChestplate, ironLeggings, ironBoots, diamondHelmet, diamondChestplate, diamondLeggings, diamondBoots, wornIronHelmet, wornIronChestplate, wornIronLeggings, wornIronBoots, wornDiamondHelmet, wornDiamondChestplate, wornDiamondLeggings, wornDiamondBoots, tablePlaced, furnaceItem, cobble, coal }, ctx).state || 'done'
  } catch (_) { /* unreadable ladder */ }
  // Castle project word (g0z.3, castle.js menuFact). Deferred require (the
  // light precedent). Unreadable reads none: castle yields, nothing churns.
  let castle = 'none'
  try {
    if (ctx && ctx.castle) castle = require('./behaviours/castle').menuFact(bot, ctx)
  } catch (_) { /* no castle word */ }
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
  return { time, logs, planks, maxPlanks, table, door, sword, pickaxe, cobble, sticks, coal, charcoal, torches, scaffold, home, unlit, tablePlaced, inside, health, food, known, haul, player, chest, chestTodo, surplus, chestParked, ironOre, ingots, diamonds, ironPick, ironSword, diamondPick, diamondSword, bucket, waterBucket, ironHelmet, ironChestplate, ironLeggings, ironBoots, diamondHelmet, diamondChestplate, diamondLeggings, diamondBoots, wornIronHelmet, wornIronChestplate, wornIronLeggings, wornIronBoots, wornDiamondHelmet, wornDiamondChestplate, wornDiamondLeggings, wornDiamondBoots, furnaceItem, furnace, gearHandover, gear, beds, castle }
}

// Bucket thresholds for the state text (single source; the criteria below
// match these words exactly).
function logBucket(n) {
  return n <= 0 ? 'none' : n < NEED_LOGS ? 'few' : 'enough'
}
// The plank bucket keys on the same versioned budget as the gather rule,
// so the model's 'planks are enough' criterion keeps matching the FSM on
// adopted v1 huts (revmux body-2). No home reads as a future v2 site.
function plankBucket(n, home) {
  return n <= 0 ? 'none' : n < needPlanks(home) ? 'few' : 'enough'
}
function unlitBucket(n) {
  return !(n > 0) ? 'none' : n < 5 ? 'few' : 'many'
}
// Canonical facts text: ALSO the model state (iwb lesson: the model matches
// whole-criterion similarity, so numbers go out, bucket words go in). The
// decision point fires when a bucket flips — none->few->enough — instead of
// on every picked-up log.
function goalText(facts, home) {
  const logs = logBucket(facts.logs)
  const planks = plankBucket(facts.planks, home)
  const table = facts.table > 0 ? 'yes' : 'no'
  const door = facts.door > 0 ? 'yes' : 'no'
  const health = facts.health < 6 ? 'low' : 'ok'
  const food = facts.food < 6 ? 'hungry' : 'ok'
  // Inside hides by day (atl.13): it gates only the night steps (stay/gohome
  // feasibility), but the binary in/out flip on the interior-box boundary re-fires
  // the decision point all day (prod: 50% of re-decisions are facts-changed,
  // forage<->rest every ~15-60s on inside alone). Feasibility still reads the
  // true facts.inside; only the decision text (and the model state, whose day
  // menu never offers stay/gohome) goes steady.
  const inside = facts.time === 'day' ? 'no' : facts.inside
  const unlit = unlitBucket(facts.unlit)
  const beds = facts.beds === 'none' || facts.beds === 'one' ? facts.beds : 'both'
  return `time=${facts.time} logs=${logs} planks=${planks} ` +
    `table=${table} door=${door} home=${facts.home} inside=${inside} unlit=${unlit} health=${health} food=${food} ` +
    `known=${facts.known} haul=${facts.haul} player=${facts.player} ` +
    `chest=${facts.chest} surplus=${facts.surplus} handover=${facts.gearHandover} gear=${facts.gear} beds=${beds}` +
    // Castle word only while a castle exists (g0z.3): castle-less text
    // stays byte-identical for the model and every pinned state string.
    (facts.castle && facts.castle !== 'none' ? ` castle=${facts.castle}` : '') +
    // No pickaxe while a castle wants stone (g0z.4): a pick broken mid-fetch
    // must re-decide into equip, and the rearm must re-decide back — the
    // pickaxe is otherwise invisible to the text (and to its replays).
    (typeof facts.castle === 'string' && facts.castle.startsWith('stone-') && !((facts.pickaxe || 0) > 0) ? ' pickaxe=no' : '')
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
// Bounded holds (g0z.4): a castle fetch that found nothing holds like any
// failure, but expires — an owner restock of the castle chest moves no
// fact, so without the expiry an idle bot by the castle never re-looks.
const CASTLEFETCH_RETRY_MS = 5 * 60 * 1000
// Bounded forage hold (idkcraft-bt8s): a failed forage leg holds like any
// failure, but time-keyed, not text-keyed — known=near/none flips move the
// facts text every few seconds (g0z.12 rig churn, the same mechanism that
// released the castlefetch hold before g0z.15) and would release a text
// hold at once. Explore stays self-advancing (its failures consume the
// point, so holding it would deadlock the spiral); holding forage alone
// pins the pair on explore until the bound passes.
const FORAGE_RETRY_MS = 5 * 60 * 1000
function forageHeld(ctx) {
  try {
    const sf = ctx && ctx.stepFail && ctx.stepFail.forage
    return !!sf && typeof sf.at === 'number' && Date.now() - sf.at <= FORAGE_RETRY_MS
  } catch (_) {
    return false
  }
}
// Done-holdable steps (h9z, revmux 01 major): ONLY steps whose every
// productive path moves the facts text, so a same-text done proves no
// effect. craft consumes its logs / flips table/door; gather crosses the
// log bucket; build flips home; light clears unlit. forage/deliver move
// real items below bucket granularity (8-drop batches, partial tosses);
// equip/gear effects are text-invisible; stockpile has its own parks; the
// self-advancing steps re-target by construction. Holding any of those
// strands real progress instead of breaking a loop.
function doneHoldable(name) {
  return name === 'craft' || name === 'build' || name === 'gather' || name === 'light'
}
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
// Shared gather-failure hold (idkcraft-gyw): the behaviour latch and the
// menu gate above read one rule. A failed gather holds while the log count
// stands AND the body stays within REFAIL_DIST of the failure point;
// relocation past it releases for a fresh try at new ground (nearer trees,
// other wood). Same distance rule as failHolds, one place. An unknown
// failure point (legacy ctx, missing body) holds: the atl.4 livelock guard
// stays for everything that never recorded where it failed.
function gatherFailedHolds(g, logs, bot) {
  try {
    if (!g || typeof g.final !== 'string' || !g.final.startsWith('failed:')) return false
    if (g.atLogs !== logs) return false
    const fp = g.failPos
    if (!fp || typeof fp.x !== 'number') return true
    const bp = bot && bot.entity && bot.entity.position
    if (!bp || typeof bp.x !== 'number') return true
    return Math.hypot(bp.x - fp.x, bp.z - fp.z) <= REFAIL_DIST
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
    if (name === 'shelter' && t === 'day') continue // night-far step; at dusk only the castle night (g0z.21) makes it feasible
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
  gather: 'logs is none or few and home is not built, or home is built and beds is none or one and logs is none or few: chop trees',
  craft: 'logs is enough or planks are few or table is no or door is no: craft planks, table and door',
  build: 'planks are enough and home is site: place the house blocks',
  beds: 'beds is none or one and time is day and home is built: gather wool, craft the bedroom beds and place them',
  light: 'unlit is few or many and time is day and home is built: place torches around the house',
  castlefetch: 'castle is stone-none, planks-none, frame-none, torch-none, door-none, fence-none, chest-none or a -some word and time is day: fetch castle material from the castle chest, craft it, or dig stone and chop logs',
  castle: 'castle is clear, finish, stone-batch, planks-batch, frame-batch, torch-batch, door-batch, fence-batch or chest-batch and time is day: lay the next castle blocks',
  equip: 'no sword or pickaxe, or blocks are low: craft tools and dig blocks',
  gohome: 'time is dusk or night and home is built and inside is no: go inside',
  shelter: 'time is night (or dusk at the far castle) and home is built and inside is no: stop marching and wait where you are till dawn',
  deliver: 'haul is waiting: carry it to the player',
  stockpile: 'chest is no, surplus is yes, or handover is waiting: place the home chest and bank the surplus',
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
async function chooseStep(brain, facts, feasible, home) {
  const names = STEP_ORDER.filter((n) => feasible.includes(n))
  const text = goalText(facts, home)
  const fsm = goalFsm(facts, names)
  if (names.length <= 1) return { step: names[0] || 'rest', source: 'only-option', fsm, model: null }
  if (!brain || typeof brain.ask !== 'function') return { step: fsm, source: 'goal-fsm', fsm, model: null }
  // bhz2: the night safety steps are a rule, not a preference — the model never overrides them.
  // xhqv: shelter too — a latched gohome hands the night to shelter, and a
  // model re-pick to a day step would undo the latch.
  if (fsm === 'stay' || fsm === 'gohome' || fsm === 'shelter') return { step: fsm, source: 'night-rule', fsm, model: null }
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
// f3s: repeat step-change chats throttled (Paper kicks past ~10 rapid lines,
// and a flip-flopping menu re-decides every tick: the assayed kick shape is
// 2-3 steps alternating, so each line is rate-limited independently — comparing
// only to the last line would still let A,B,A,B through). The same line chats
// at most every 10 s; a line never chatted (or silent >10 s) always passes.
// The console keeps every transition. First chat per ctx always passes. Same
// timestamp style as explore's departure throttle.
const STEP_CHAT_SAME_MS = 10000
function chatStep(bot, ctx, line) {
  const now = Date.now()
  let seen = null
  try { seen = ctx && ctx.stepChat } catch (_) { seen = null }
  const prev = seen ? seen[line] : undefined
  if (typeof prev === 'number' && now - prev < STEP_CHAT_SAME_MS) return false
  try { if (ctx) { (ctx.stepChat = ctx.stepChat || {})[line] = now } } catch (_) { /* stamp best-effort */ }
  try { bot.chat(line) } catch (_) { /* chat best-effort */ }
  return true
}

function stepWhy(name, facts, bot, ctx, text) {
  try {
    if (failHolds(ctx, name, text, bot)) {
      try {
        const st = ctx && ctx.stepFail && ctx.stepFail[name] && ctx.stepFail[name].status
        if (st === 'done') return `${name} holds after an unchanged done`
      } catch (_) { /* fall through to the failure line */ }
      return `${name} holds after failure`
    }
  } catch (_) { /* wording best-effort */ }
  if (name === 'gather') {
    // Shared hold (gyw twin of the feasible gate): same final, same log
    // count, body still at the failure point.
    try {
      if (gatherFailedHolds(ctx && ctx.gather, facts.logs, bot)) {
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
      if (facts.inside !== 'no') return 'gohome: already inside'
      if (gohomeLatched(ctx, bot)) return 'gohome: failed at the same spot tonight'
      if (castleNight(bot, ctx)) return 'gohome: sheltering at the castle'
      return 'gohome: too far to walk at night'
    case 'shelter':
      if (facts.time === 'day') return 'shelter: daytime'
      if (facts.time === 'dusk') return 'shelter: dusk marches home'
      if (facts.home !== 'built') return 'shelter: home not built'
      if (facts.inside !== 'no') return 'shelter: already inside'
      return 'shelter: home is close'
    case 'craft':
      if ((facts.table > 0 || facts.tablePlaced) && facts.door > 0) return 'craft: nothing to craft'
      if (facts.door === 0 && facts.tablePlaced) return `craft: need 6 planks for the door, have ${facts.maxPlanks}`
      if (facts.table === 0 && !facts.tablePlaced) return `craft: need 4 planks for the table, have ${facts.maxPlanks}`
      return `craft: need ${NEED_LOGS} logs, have ${facts.logs}`
    case 'equip': {
      // Mirrors MENU.equip.feasible branch for branch (atl.6): tools first,
      // scaffold blocks only once geared, the house-table yield last (h9z).
      // x15: a due stone upgrade is an unfinished kit, not 'kit complete'.
      try { if (require('./behaviours/equip').equipLatched(ctx, bot)) return 'equip: same failure again today' } catch (_) { /* wording best-effort */ }
      const upgrade = equipUpgradeDue(bot, ctx)
      if ((facts.sword || 0) > 0 && (facts.pickaxe || 0) > 0 && !upgrade) return 'equip: kit complete'
      if (!upgrade && !equipWant(facts)) return 'equip: no materials'
      if ((facts.table || 0) <= 0 && !facts.tablePlaced) return 'equip: no table'
      try {
        if ((facts.table || 0) > 0 && tableYieldToBuild(facts, bot, ctx)) return 'equip: waiting for the house table'
      } catch (_) { /* wording best-effort: fall through to the table line */ }
      return 'equip: no table'
    }
    case 'build': {
      if (nightHurt(facts)) return 'build: hurt at night, waiting for dawn'
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
          // Unloaded next cell (45j): only the plank batch gates, as in feasible.
          if (ni >= 0) kind = buildMod.cellLoaded(bot, home, buildMod.blueprintFor(home)[ni]) ? buildMod.blueprintFor(home)[ni].kind : 'unloaded'
        }
      } catch (_) { kind = null }
      if ((kind === 'table' && facts.table === 0) || (kind === 'door' && facts.door === 0) ||
        (kind == null && (facts.table === 0 || facts.door === 0))) return 'build: need table/door item'
      if (facts.planks < Math.min(PLANK_COUNT, 16)) return `build: need ${Math.min(PLANK_COUNT, 16)} planks, have ${facts.planks}`
      return 'build: nothing left to build'
    }
    case 'beds':
      if (facts.time !== 'day') return 'beds: daytime job'
      if (facts.home !== 'built') return 'beds: house not built yet'
      if (facts.beds !== 'none' && facts.beds !== 'one') return 'beds: both beds are in'
      try { if (require('./behaviours/beds').sheepLatched(ctx, bot)) return 'beds: sheep hunt latched' } catch (_) { /* wording best-effort */ }
      return 'beds: not feasible'
    case 'light': {
      if (facts.time !== 'day') return 'light: daytime job'
      const home = ctx && ctx.home
      if (!home || !home.site) return 'light: no home site'
      if (facts.home !== 'built') return 'light: home not built'
      if (!(facts.unlit > 0)) return 'light: yard lit'
      // Torches on hand with a dark yard is feasible (null above), so only
      // the fuel branches remain.
      let spendable = 0
      try { spendable = require('./behaviours/light').spendableFuel((facts.coal || 0) - (facts.charcoal || 0), facts.charcoal) } catch (_) { /* reads no fuel */ }
      if (spendable <= 0) return ctx && ctx.home && ctx.home.furnace ? 'light: no fuel, too little wood for charcoal' : 'light: no fuel and no furnace for charcoal'
      return 'light: no sticks or wood'
    }
    case 'castle': {
      const w = facts.castle || 'none'
      if (w === 'none') return 'castle: no castle ordered'
      if (w === 'parked') return 'castle: parked'
      if (w === 'done') return 'castle: complete'
      if (facts.time !== 'day') return 'castle: daytime job'
      if (w === 'blocked') return 'castle: next cell blocked, retrying later'
      const kind = w.slice(0, w.lastIndexOf('-'))
      if (w.endsWith('-none')) return `castle: need ${kind}`
      return `castle: need a batch of ${kind}`
    }
    case 'castlefetch': {
      const w = facts.castle || 'none'
      if (facts.time !== 'day') return 'castlefetch: daytime job'
      if (!/-(none|some|batch)$/.test(w)) return 'castlefetch: no material owed'
      if (w.startsWith('stone-') && !((facts.pickaxe || 0) > 0)) return 'castlefetch: no pickaxe'
      return 'castlefetch: batch on hand'
    }
    case 'gather':
      if (nightHurt(facts)) return 'gather: hurt at night, waiting for dawn'
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
      if (plan.state === 'hand') return `gear: handing over ${plan.name || 'finished goods'}`
      if (plan.state === 'ready') return 'gear: ready'
      return `gear: ${plan.line || plan.key}`
    }
    case 'forage':
      if (nightHurt(facts)) return 'forage: hurt at night, waiting for dawn'
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
    text = goalText(facts, ctx && ctx.home)
  } catch (_) { /* wording best-effort */ }
  const out = []
  for (const n of STEP_ORDER) {
    if (n === 'rest') continue
    // No castle ordered: no castle reason (the rest line stays as it was).
    if ((n === 'castle' || n === 'castlefetch') && (!facts || !facts.castle || facts.castle === 'none')) continue
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
  if (ctx && facts.time === 'day') {
    ctx.inShelter = false
    ctx.gohomeLatch = null // the latch lasts one night (xhqv)
  }
  const text = goalText(facts, ctx && ctx.home)
  const prev = (ctx && ctx.step) || null
  let status = (ctx && ctx.stepStatus) || null
  let finished = status === 'done' || (typeof status === 'string' && status.startsWith('failed:'))
  // Async gear/furnace translation BEFORE the hold bookkeeping (revmux
  // 02-review): the hold must record the translated status - and no hold at
  // all for a yield - or the rename is dead and its test passes without
  // this branch. The locals rewrite from the translation, so no-fuel takes
  // the done branch (which deletes the hold) and stalls record gear-named.
  if (finished && prev === 'gear') {
    let result = null
    try {
      const f = ctx && ctx.furnace
      if (f && f.settled) result = f.result || null
    } catch (_) { /* no leg outcome */ }
    if (result) {
      try {
        ctx.furnace.result = null
      } catch (_) { /* consume best-effort */ }
      if (result === 'done') {
        // The furnace leg finished between ticks: keep working the rung
        // without a re-decide (a facts-changed re-pick here could strand
        // the rung on an earlier step). The bookkeeping below never runs
        // for this path, so retire any stale hold explicitly instead of
        // letting it linger into a later failure.
        ctx.stepStatus = 'running'
        try { if (ctx.stepFail && typeof ctx.stepFail === 'object') delete ctx.stepFail.gear } catch (_) { /* retire best-effort */ }
        return { action: 'gear', sprint: false, source: 'goal-fsm' }
      } else {
        const reason = result.startsWith('failed:') ? result.slice('failed:'.length) : result
        if (reason === 'no-cobble' || reason === 'no-fuel') {
          const key = reason === 'no-cobble' ? 'want-cobble' : 'want-coal'
          let line = reason === 'no-cobble' ? 'need 8 cobble for the furnace, going to dig' : 'need coal above the reserve, going to dig'
          // ipn.9: same honest rule as gear's sync announce (the coal
          // promise needs a diggable remembered cell); cobble keeps its
          // line — stone is not a memory resource.
          try {
            const gearMod = require('./behaviours/gear')
            line = gearMod.honestLine(bot, ctx, bot && bot.entity && bot.entity.position, key, line)
          } catch (_) { /* announce best-effort: keep the line */ }
          try {
            if (!ctx.gear || typeof ctx.gear !== 'object') ctx.gear = {}
            if (ctx.gear.saidNeed !== key) {
              ctx.gear.saidNeed = key
              bot.chat(line)
            }
          } catch (_) { /* announce best-effort */ }
          ctx.stepStatus = 'done' // yield: fetchers run, gear latched out
          status = 'done'
        } else {
          ctx.stepStatus = `failed:gear-furnace-${reason}`
          status = ctx.stepStatus
        }
      }
    }
  }
  if (finished && prev && typeof status === 'string' && status.startsWith('failed:')) {
    try {
      if (!ctx.stepFail || typeof ctx.stepFail !== 'object') ctx.stepFail = {}
      const bp = bot && bot.entity && bot.entity.position
      ctx.stepFail[prev] = { status, text, pos: bp ? { x: bp.x, y: bp.y, z: bp.z } : null, at: Date.now() }
      if (prev === 'gohome') noteGohomeFail(ctx, bot, status)
    } catch (_) { /* guard best-effort */ }
  } else if (finished && prev && status === 'done') {
    if (ctx.goalText === text && doneHoldable(prev)) {
      // Done with no visible effect holds like a failure (h9z): a step that
      // ends 'done' without moving the facts would otherwise re-pick forever
      // (prod: silent craft loop, 287 ticks, 0 failures). New facts or
      // relocation release it, same as the failure hold.
      try {
        if (!ctx.stepFail || typeof ctx.stepFail !== 'object') ctx.stepFail = {}
        const bp2 = bot && bot.entity && bot.entity.position
        ctx.stepFail[prev] = { status, text, pos: bp2 ? { x: bp2.x, y: bp2.y, z: bp2.z } : null }
      } catch (_) { /* guard best-effort */ }
    } else if (ctx.stepFail && typeof ctx.stepFail === 'object') {
      // A success retires its own hold: tomorrow's identical failure re-arms
      // from scratch instead of inheriting a stale record (round-1 major).
      try { delete ctx.stepFail[prev] } catch (_) { /* guard best-effort */ }
    }
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
  // Night-far gohome does not stick (ipn.12): a dusk march that is still far
  // at nightfall — or a respawn far from home — must re-decide into shelter
  // instead of marching the dark, even with unchanged facts (a keepInventory
  // death moves no bucket). Door phases only run near home, so the far check
  // never breaks a doorway. Like a chain handoff it forces a real re-decide
  // past the askedKey shortcut, not just a release.
  const nightFarWalk = !finished && prev === 'gohome' && ctx.gohome && ctx.gohome.phase === 'walk' &&
    facts.time === 'night' && nightFarFromHome(bot, ctx)
  // Night-near shelter does not hold (revmux 03): the mirror force — a
  // keepInventory respawn by the house moves no bucket, so without the
  // force the askedKey shortcut below would re-issue shelter all night.
  const nightNearShelter = !finished && prev === 'shelter' &&
    facts.time !== 'day' && !shelterFits(facts, bot, ctx)
  // Shelter sticks at night (revmux 01 body-2): a laya re-pick to a day
  // step would walk off the pillar and work the dark with inShelter still
  // armed (no fight, no retreat, till dawn). Day exits through the menu —
  // shelter is night-infeasible — and through the behaviour's own done.
  // Near home the hold releases too (revmux 02): a death that respawns by
  // the house must walk in (gohome/stay), not pillar outside it all night.
  if (!finished && !nightFarWalk && (prev === 'gohome' || prev === 'stay' || (prev === 'shelter' && shelterFits(facts, bot, ctx)))) {
    if (prev === 'shelter') return { action: prev, sprint: false, source: 'goal-fsm' }
    const ph = prev === 'gohome' ? ctx.gohome && ctx.gohome.phase : ctx.stay && ctx.stay.phase
    if (ph && ph !== 'done' && ph !== 'failed') return { action: prev, sprint: false, source: 'goal-fsm' }
  }
  // A chain-owned step never rides the goal shortcuts: re-issuing it here
  // would bypass feasibility and the model ask (the stale hold in another
  // coat). Force a real re-decide instead; the menu never contains
  // retreat/pillar, so ownership transfers to a goal step.
  const chainOwns = ctx && ctx.retreat && ctx.retreat.action === prev
  // Bounded castlefetch hold (g0z.4): an expired hold retires and forces
  // one fresh pick — with the text standing, the replay paths would keep
  // the step that took over and the owner's chest restock never gets seen.
  let fetchRetry = false
  try {
    const sf = ctx && ctx.stepFail && ctx.stepFail.castlefetch
    if (sf && typeof sf.at === 'number' && Date.now() - sf.at > CASTLEFETCH_RETRY_MS) {
      delete ctx.stepFail.castlefetch
      fetchRetry = true
    }
  } catch (_) { /* retry best-effort */ }
  if (!prev || finished || ctx.goalText !== text || chainOwns || nightFarWalk || nightNearShelter || fetchRetry) {
    const askKey = `${text}\n${status || ''}`
    // The shortcut must respect holds (h9z): it returns the finished step
    // without choosing, so a held step would bypass its own hold and
    // re-pick forever. A gear yield never rides it either (ipn.7): gear
    // ends done to hand off to the fetchers (latched announce), and the
    // same text plus the same 'done' status re-issues it every tick —
    // prod stood 8-10 min with 'going to dig' until the facts moved. The
    // fresh menu pick below keeps gear out via the said-latch until a new
    // need arrives; no hold is recorded (gear yields are never holds).
    // A latched gohome never rides it either (xhqv): the same text and the
    // same failure re-issue the gohome the latch just retired.
    if (prev && ctx.askedKey === askKey && !(prev === 'gohome' && gohomeLatched(ctx, bot)) && !chainOwns && !nightFarWalk && !nightNearShelter && !fetchRetry && !(prev === 'gear' && status === 'done') && !failHolds(ctx, prev, text, bot)) return { action: ctx.step, sprint: false, source: 'goal-fsm' }
    ctx.askedKey = askKey
    const names = Object.keys(MENU).filter((n) => {
      try {
        if (!MENU[n].feasible(facts, bot, ctx) || !registered(n)) return false
      } catch (_) {
        return false
      }
      return !failHolds(ctx, n, text, bot)
    })
    const why = !prev ? 'start' : finished ? (status === 'done' ? 'step-done' : 'step-failed') : nightFarWalk ? 'night-far' : nightNearShelter ? 'night-near' : 'facts-changed'
    const t0 = Date.now()
    const choice = await chooseStep(ctx && ctx.brain, facts, names, ctx && ctx.home)
    const ms = Date.now() - t0
    ctx.step = choice.step
    // A fresh equip pick starts with fresh run counters (revmux round-1):
    // stall patience spent by an earlier run must not fail the new one on
    // its first tick. Station claims (claimedTable) live outside ctx.equip
    // and survive. Same-name re-picks were already reset by done/failed.
    if (choice.step === 'equip' && choice.step !== prev) ctx.equip = {}
    if (choice.step === 'gear' && choice.step !== prev) ctx.gearRun = {}
    if (choice.step === 'castlefetch' && choice.step !== prev) ctx.castleFetch = null
    // A fresh shelter pick re-pillars (ipn.12): a stale pillared flag from
    // an order-interrupted night would otherwise hold on open ground. The
    // interrupted gohome walk resets too, so the next march starts from the
    // current body with a fresh stall record (and drops the walk's no-dig
    // borrow at the next lease refresh) instead of resuming stale legs.
    if (choice.step === 'shelter' && choice.step !== prev) {
      ctx.shelter = {}
      ctx.gohome = null
    }
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
        chatStep(bot, ctx, `resting: ${ctx.restWhy} (${choice.source})`)
      } else {
        const entry = MENU[choice.step]
        const verb = (entry && entry.verb) || choice.step
        chatStep(bot, ctx, `next: ${verb} (${choice.source})`)
      }
    }
  }
  return { action: ctx.step, sprint: false, source: 'goal-fsm' }
}

module.exports = { MENU, STEP_ORDER, AUTONOMOUS_EXPLORE_RADIUS, NEED_LOGS, NEED_PLANKS, NEED_PLANKS_V1, needPlanks, goalFacts, goalText, goalFsm, decide, chooseStep, shapeGoalMenu, stepWhy, restWhy, STEP_CRITERIA, ASK_INSTRUCTIONS, logBucket, plankBucket, siteFor, adoptHome, chatStep, STEP_CHAT_SAME_MS, gatherFailedHolds, CASTLEFETCH_RETRY_MS, FORAGE_RETRY_MS }
