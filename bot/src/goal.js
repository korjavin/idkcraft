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

const { countItems, wornItems, HOSTILE_NAMES } = require('./perception')
const Vec3 = require('vec3')
const buildMod = require('./behaviours/build')
const forageMod = require('./behaviours/forage')
const deliverMod = require('./behaviours/deliver')
const stockpileMod = require('./behaviours/stockpile')
const PLANK_COUNT = buildMod.PLANK_COUNT
const metrics = require('./metrics')
const residence = require('./residence')
const { failReason, isFinished, nextStepGen } = require('./step')

// House budget and bounded-hold windows live in the leaf budget.js
// (oqul.3) so behaviours read them without loading goal; re-exported here.
const { NEED_LOGS, NEED_PLANKS, NEED_PLANKS_V1, CASTLEFETCH_RETRY_MS, FORAGE_RETRY_MS, BUILD_RETRY_MS } = require('./budget')
// Home/site geometry and the gather retry policy live in the leaves site.js
// and holds.js (oqul.4); the exported names are re-exported here.
const { needPlanks, makeHome, siteFor, isV2House, timeWord } = require('./site')
const { REFAIL_DIST, gatherFailedHolds } = require('./holds')

// Night-hurt hold (ck3): low health (the goalText 'health=low' bucket) at
// night keeps the bot off the outdoor work — prod died twice at the site
// building at 2 hp next to zombies. Both inputs are in goalText, so the
// first hurt night tick re-decides a sticky build/gather.
// ponytail: no hostile check — night spawns them anyway; add one if
// hurt-night idling ever costs real work.
function nightHurt(facts) {
  return facts.time === 'night' && facts.health < 6
}

// Wood ceiling read (g0z.26): stockpile owns the rule; fail-open false, the
// old behaviour.
function woodCapped(bot, ctx) {
  try {
    return !!stockpileMod.woodCapped(bot, ctx)
  } catch (_) {
    return false
  }
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
    // owns it (see nightFarFromHome). Dusk marches at any distance —
    // except away from home with an active castle (vmzq.19): the night
    // belongs to the site, never to a 500-block march back.
    feasible: (facts, bot, ctx) => (facts.time === 'dusk' || facts.time === 'night') && facts.home === 'built' && facts.inside === 'no' &&
      !(facts.time === 'night' && nightFarFromHome(bot, ctx)) && !gohomeLatched(ctx, bot) && !castleNight(bot, ctx) && !castleSiteNight(bot, ctx),
    chat: () => 'on my own: heading home',
    verb: 'heading home',
  },
  shelter: {
    // Night shelter (ipn.12): the night-far complement of gohome — pillar
    // up and hold where you are till dawn instead of marching the dark.
    // Castle night (g0z.21): at the far castle it shelters from dusk on.
    // Castle site (vmzq.19): with an active castle and the bot away from
    // home it shelters from dusk anywhere — mid-map it pillars in place —
    // and the built-home gate lifts (an unbuilt far house still shelters).
    // Dusk dig-up (vmzq.50): underground and displaced at dusk the climb
    // runs first — sheltering in a cave pillars head-blocked and digs
    // undiggable (run8 16:13). Night keeps shelter (vmzq.48 owns it).
    feasible: (facts, bot, ctx) => (facts.home === 'built' || castleSiteNight(bot, ctx)) && facts.inside === 'no' && shelterFits(facts, bot, ctx) && !duskClimbOut(facts, bot, ctx),
    chat: () => 'on my own: sheltering here till dawn',
    verb: 'sheltering till dawn',
  },
  gocastle: {
    // Return-to-site (idkcraft-vmzq.50): displaced past GOSITE_DIST from
    // an active castle, walk back on the surface instead of working from
    // afar — run8 respawned 400 off and the castle/castlefetch far legs
    // walked the raw digging route through caves (drowned y11, creeper)
    // and ended stuck sheltering 450 off. Day only (the night steps own
    // the dark); at dusk only the climb-out leg runs. No kit gate: a
    // fresh respawn walks with an empty pack.
    feasible: (facts, bot, ctx) => gocastleGo(facts, bot, ctx),
    chat: () => 'on my own: returning to the castle site',
    verb: 'returning to the castle',
  },
  craft: {
    // Batch gate: a full NEED_LOGS load crafts at once. Starting on the first
    // picked-up log would preempt gather with a chat line per log.
    // The door needs a placed table (bot.craft requires the block): without
    // one the step could neither progress nor finish, churning done forever.
    // Frame logs (g0z.12): while the castle's next cell is a Fachwerk beam
    // the logs ARE the castle batch — a full load must not turn to planks.
    // Same while blocked on the frame kind (g0z.23 follow-up): the word is
    // 'blocked', but the fetched logs are still logs the castle needs.
    // Wood ceiling (g0z.26): past the cap a full load no longer converts —
    // the planks would pile past what the castle needs (prod: 700 in 11
    // slots). Table/door branches are unaffected (they spend planks).
    feasible: (facts, bot, ctx) => !(ctx && ctx.home && ctx.home.parked) && ((facts.logs >= NEED_LOGS && !woodCapped(bot, ctx) && !String(facts.castle).startsWith('frame-') &&
      !(facts.castle === 'blocked' && ctx && ctx.castleWord && ctx.castleWord.kind === 'frame')) || (facts.maxPlanks >= 4 && facts.table === 0 && !facts.tablePlaced) || (facts.maxPlanks >= 6 && facts.door === 0 && facts.tablePlaced)),
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
      if (facts && facts.rearm) return true // vmzq.37 pickless castle, buried
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
      // Castle first (vmzq.19): an active castle vetoes the house build,
      // and an L2 park keeps the veto past the task radius (R2 minor 3).
      if (castleFirst(ctx, 'build') || castleParkLeash(ctx)) return false
      // Parked house (vmzq.3): the L2 episode vetoes the house chain —
      // the bot does side work instead until resume.
      if (ctx && ctx.home && ctx.home.parked) return false
      if (buildHeld(ctx)) return false // 67z3: pace failed builds past facts drift
      if (nightHurt(facts)) return false
      const home = ctx && ctx.home
      if (!home && !(bot && bot.spawnPoint)) return false
      // Skip retry (revmux 01 core-4): re-probe stamped skips past the
      // window — a restored stale skip drops on the first decide, so a
      // deploy heals stale holes like the pre-persistence code did.
      try { buildMod.pruneBuildSkips(ctx) } catch (_) { /* prune best-effort */ }
      // Last-pass retry (6x7.20): with every other cell standing this gate
      // reads the holes as given up and never re-picks build, so the
      // build-side retry alone never runs (rig: TIMEOUT over one skip).
      try {
        if (home && home.site && buildMod.nextCellIdx(bot, home, ctx.buildSkip) < 0 && !buildMod.isComplete(bot, home)) buildMod.retrySkipsOnce(ctx)
      } catch (_) { /* retry best-effort */ }
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
      // Castle first (vmzq.19): an active castle vetoes the wool hunt —
      // its place/bank legs walk home, 500 blocks in run3 — and an L2
      // park keeps the veto past the task radius (R2 minor 3).
      if (castleFirst(ctx, 'beds') || castleParkLeash(ctx)) return false
      if (!(facts.time === 'day' && facts.home === 'built' && (facts.beds === 'none' || facts.beds === 'one'))) return false
      // vmzq.61: an unreachable/unplaceable bed holds on home/bed-count/time, not the facts text.
      try { const m = require('./behaviours/beds'); return !m.placeHeld(ctx, bot) && !m.sheepLatched(ctx, bot) } catch (_) { return true }
    },
    chat: () => 'on my own: making the beds',
    verb: 'making beds',
  },
  sitebed: {
    // The castle spawn bed (vmzq.33 minimal): when the bot HAS a bed (pack,
    // or the adopted home chest already within reach — no walks, hunts, or
    // crafts), place it outside the footprint and off the door path and
    // click it to set the spawn (prod run 8: 83 min lost to world-spawn
    // walkbacks). Ranks below the castle chain: laying never waits for it.
    // Without a bed it is infeasible by construction (master-identical).
    feasible: (facts, bot, ctx) => {
      if (!castleFirst(ctx)) return false
      if (facts.time !== 'day' && facts.time !== 'dusk') return false
      try {
        const m = require('./behaviours/sitebed')
        if (m.siteBedStands(bot, ctx)) return false
        const cb = ctx && ctx.sitebed
        const n = bot && bot.time && typeof bot.time.day === 'number' ? bot.time.day : -1
        if (cb && cb.deadDay === n) return false
        return m.bedReady(bot, ctx)
      } catch (_) { return false }
    },
    chat: () => 'on my own: placing the site bed',
    verb: 'placing the site bed',
  },
  light: {
    // Day shift only: walking the yard at night is the danger being fixed.
    // Fuel floor mirrors the behaviour's reserve (deferred require: the
    // equip precedent — goal.js loads inside the behaviour chain).
    feasible: (facts, bot, ctx) => {
      if (facts.time !== 'day') return false
      // Home-leg leash (vmzq.19 R2, major 2): no cross-map torch run.
      if (homeLegVetoed(bot, ctx, 'light')) return false
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
    feasible: (facts, bot, ctx) => castleGo(facts, ctx, bot) &&
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
      if (ctx && ctx.home && ctx.home.parked) return false
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
        if ((facts.beds === 'none' || facts.beds === 'one') && (facts.maxPlanks || 0) < 6 && (facts.logs || 0) < NEED_LOGS) return true
        // Castle chain (vmzq.17): a stone-none word with no pickaxe starves —
        // castlefetch yields for the pick, equip wants table+material, craft
        // wants a full load, and nothing chops it (prod run2: empty kit
        // cycled castle(fail)->explore forever). Chop one load for the
        // pickaxe/table chain; castlefetch/castle outrank this when they can
        // run. Torch excluded (it wants coal, not logs); blocked/clear/
        // finish/batch words never reach here.
        if (typeof facts.castle === 'string' && /^(stone|planks|frame|door|fence|chest)-(none|some)$/.test(facts.castle) && (facts.logs || 0) < NEED_LOGS) return true
        return false
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
    feasible: (facts, bot, ctx) => facts.haul === 'waiting' && facts.player !== 'none' && !castleGo(facts, ctx, bot),
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
    // Site banking (vmzq.39): an active far castle banks at the site
    // instead — same surplus, the site chest, no home needed.
    feasible: (facts, bot, ctx) => {
      // Site first; when the site cannot take it the home walk below is
      // still the unblock (vmzq.19 R3: a full pack pierces the leash).
      try {
        if (stockpileSiteBranch(facts, bot, ctx)) return true
      } catch (_) { /* undecidable: home below */ }
      return facts.home === 'built' && !facts.chestParked &&
        !(facts.haul === 'waiting' && facts.player !== 'none') &&
        // Home-leg leash (vmzq.19 R2, major 2): no cross-map banking run —
        // unless the pack is full (R3, round-2 major A): stockpile is the
        // only drain, and castlefetch/equip/gather yield pack-full counting
        // on it, so a leashed full pack stalls to the L2 park. The pierce
        // latches for the trip (R4, round-3 major): one placed block must
        // not turn the walk around, and dusk must not strand it.
        (!homeLegVetoed(bot, ctx, 'stockpile') || packFull(bot, ctx) || !!(ctx && ctx.stockpilePierced)) &&
        (facts.chest === 'no' ? facts.chestTodo !== 'none' : (facts.surplus === 'yes' || facts.gearHandover === 'waiting'))
    },
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
      // Home-leg leash (vmzq.19 R2, major 2): the ladder waits for the castle.
      if (homeLegVetoed(bot, ctx, 'gear')) return false
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
    // forage<->explore every few seconds on the rig. A blocked castle vetoes
    // the hunt by day (g0z.23): the bot stays on the build instead. A
    // parked task keeps the hunt but only near finds (vmzq.3 side work):
    // the pickers in forage.js skip far cells while parked, so known
    // reads none when only far finds remain — no gate needed here.
    feasible: (facts, bot, ctx) => facts.known === 'near' && !nightHurt(facts) && !castleGo(facts, ctx, bot) && !forageHeld(ctx) && !castleBlocked(facts),
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
    // A blocked castle vetoes the built-home search by day (g0z.23); the
    // pre-house stranded branch below stays. A parked task vetoes the
    // built-home search (vmzq.3: the parked wander is the failure to
    // stop); the stranded branch vetoes on the house park only (R2).
    feasible: (facts, bot, ctx) => {
      if (facts.home === 'built') return !castleBlocked(facts) && !taskParked(ctx)
      if (facts.time !== 'day') return false
      if (facts.player !== 'none') return false
      // The stranded branch is the only release for a no-trees hold (gyw),
      // so an owner castle stop — no timer, never auto-resumes — must not
      // veto it (R2). Only the timer-bounded house park does.
      if (ctx && ctx.home && ctx.home.parked) return false
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
function castleGo(facts, ctx, bot = null) {
  const w = facts && facts.castle
  if (typeof w !== 'string' || facts.time !== 'day') return false
  if (!registered('castle')) return false
  if (lowHpGated(bot, facts, ctx)) return false // vmzq.49: eat first, then climb (.51: bounded)
  if (w === 'clear' || w === 'finish' || w.endsWith('-batch')) return true
  return w.endsWith('-some') && !!ctx && ctx.step === 'castle' && ctx.stepStatus === 'running'
}

// Health gate (idkcraft-vmzq.49): at low health with nothing edible on
// hand the castle legs stand down — run8 worked the y72 frame at low hp
// (fell 13:29) and walked back into a day zombie (died 15:52), kit
// food=0 both times, because no gate exists. eatReflex cannot help
// (nothing to eat), so forage (a hunt) or rest runs until food or regen
// lands. With food on hand the reflex eats and work continues. An
// unreadable pack reads fed (fail open: the old behaviour).
function lowHpNoFood(bot, facts) {
  try {
    if (!(facts && facts.health < 6)) return false
    const items = bot && bot.inventory && typeof bot.inventory.items === 'function' ? bot.inventory.items() : null
    if (!Array.isArray(items)) return false
    return !require('./reflexes').pickEdible(items)
  } catch (_) {
    return false
  }
}
// Bounded stand-down (idkcraft-vmzq.51): the .49 gate above idles the
// castle until the watchdog parks when hp stays low with no food, no
// animals and no regen. Past LOW_HP_GATE_MS of continuous gating the work
// resumes at low hp — an idle bot starves anyway, and retreat/pillar still
// own live combat. The clock arms in decide() on the raw pack check; an
// unarmed ctx reads gated (fail closed, the .49 shape).
const LOW_HP_GATE_MS = 5 * 60 * 1000
// Continuity gap (67z3 revmux 01 minor): decide runs on work ticks only
// (~1 s), so a longer silence means fight, follow or pause owned the body
// and the 'continuous' in continuous gating is unverified.
const LOW_HP_GAP_MS = 60 * 1000
function lowHpGated(bot, facts, ctx) {
  if (!lowHpNoFood(bot, facts)) return false
  try {
    const since = ctx && typeof ctx.lowHpGateSince === 'number' ? ctx.lowHpGateSince : null
    if (since == null) return true
    return Date.now() - since <= LOW_HP_GATE_MS
  } catch (_) {
    return true
  }
}

// Return-to-site radius (idkcraft-vmzq.50): past 64 XZ from the castle
// centre the day belongs to the walk back, not to far legs. 64 is the
// epic's own bound (PARK_FORAGE_RADIUS) and the task radius.
const GOSITE_DIST = 64
function displacedFromCastle(bot, ctx) {
  try {
    const st = ctx && ctx.castle
    if (!st || !st.site || typeof st.site.x !== 'number') return false
    if (!castleFirst(ctx)) return false // active castle only (unfinished, unparked)
    const bp = bot && bot.entity && bot.entity.position
    if (!bp || typeof bp.x !== 'number') return false
    const c = castleSiteCentre(st)
    return Math.hypot(bp.x - c.x, bp.z - c.z) > GOSITE_DIST
  } catch (_) {
    return false
  }
}
// Climb-first test (vmzq.50): the behaviour's own headroom probe — one
// source, so the menu and the leg can never disagree on what is deep.
function needsClimb(bot) {
  try {
    return !!require('./behaviours/gocastle').climbNeeded(bot)
  } catch (_) {
    return false
  }
}
// Threatened (vmzq.49 R1): a hostile within the retreat release band.
// The gocastle threat gate keys off it: a low, foodless walk through
// mobs is the run8 death, while quiet travel stays legal.
function threatNear(bot) {
  try {
    const bp = bot && bot.entity && bot.entity.position
    if (!bp || typeof bp.x !== 'number') return false
    const entities = (bot && bot.entities && typeof bot.entities === 'object') ? Object.values(bot.entities) : null
    if (!Array.isArray(entities)) return false
    for (const e of entities) {
      if (!e || e.type === 'player' || !e.position) continue
      if (!HOSTILE_NAMES.has(e.name || '')) continue
      if (e.isValid === false) continue
      let d = null
      try { d = bp.distanceTo(e.position) } catch (_) { continue }
      if (typeof d === 'number' && d <= 10) return true
    }
    return false
  } catch (_) {
    return false
  }
}
// Dusk dig-up (vmzq.50): underground and displaced at dusk, the climb
// runs before shelter. Night keeps shelter (vmzq.48 owns it). R1: the
// carve-out means "the climb leg WILL run" — a held (failed) or
// threat-gated climb falls back to shelter instead of wandering.
function duskClimbOut(facts, bot, ctx) {
  try {
    if (!facts || facts.time !== 'dusk') return false
    if (!displacedFromCastle(bot, ctx) || !needsClimb(bot)) return false
    if (lowHpGated(bot, facts, ctx) && threatNear(bot)) return false
    return !failHolds(ctx, 'gocastle', goalText(facts, ctx && ctx.home), bot)
  } catch (_) {
    return false
  }
}
function gocastleGo(facts, bot, ctx) {
  try {
    if (!displacedFromCastle(bot, ctx)) return false
    if (!registered('gocastle')) return false
    // Threat gate (vmzq.49 R1): low and foodless INTO mobs does not
    // travel — flee/recover first. Quiet travel stays legal (a fresh
    // respawn is full-hp anyway; the gate only bites a walk that has
    // already gone bad).
    if (lowHpGated(bot, facts, ctx) && threatNear(bot)) return false
    const t = facts && facts.time
    if (t === 'day') return true
    return t === 'dusk' && needsClimb(bot)
  } catch (_) {
    return false
  }
}

// Castle fetch can progress now (g0z.4): day, a material word (or blocked
// with its gated kind, g0z.23), the batch still short (castlefetch.demand
// — the behaviour's own done test), and the castle unable to lay now
// unless this fetch is the running leg.
// Stone needs a pickaxe: without one equip rearms first (it only replaces
// an absent pick), so a pick broken mid-batch hands over and comes back.
// ponytail: a castle chest full of cobble still waits for the pickaxe;
// add a chest probe here if a pickless owner-fed castle ever matters.
function castleFetchGo(facts, bot, ctx) {
  const w = facts && facts.castle
  if (typeof w !== 'string' || facts.time !== 'day') return false
  if (lowHpGated(bot, facts, ctx)) return false // vmzq.49: eat first, then climb (.51: bounded)
  // Blocked (g0z.23): the gated kind (menuFact keeps it on castleWord)
  // still wants its batch while the build stands.
  let kind = null
  if (w === 'blocked') {
    kind = ctx && ctx.castleWord && ctx.castleWord.kind
    try { if (!kind || !(kind in require('./behaviours/castlefetch').FETCH)) return false } catch (_) { return false }
  } else {
    if (!/-(none|some|batch)$/.test(w)) return false
    kind = w.slice(0, w.lastIndexOf('-'))
  }
  if (!registered('castlefetch') || !registered('castle')) return false
  if (kind === 'stone' && !((facts.pickaxe || 0) > 0)) return false
  if (castleGo(facts, ctx, bot) && !(ctx && ctx.step === 'castlefetch' && ctx.stepStatus === 'running')) return false
  try {
    const d = require('./behaviours/castlefetch').demand(bot, ctx)
    return !!d && d.short > 0
  } catch (_) {
    return false
  }
}

// Blocked castle veto (g0z.23): while the build stands the bot stays on it
// (castlefetch, equip, rest at the site) instead of wandering off to
// explore/forage. Day only: the night steps own the night. Narrow on
// purpose — a stone-none word with no pickaxe keeps explore/forage as the
// only wood-finding path (widen to every in-progress word later if asked).
function castleBlocked(facts) {
  if (!facts || facts.castle !== 'blocked' || facts.time !== 'day') return false
  return registered('castle')
}

// Task park (idkcraft-vmzq.3, supersedes g0z.24): ANY parked task — owner
// castle stop or the L2 episode — vetoes the built-home explore. The veto
// is a property of the parked task, never of a castle word (g0z.24's
// design is rejected: it would strand a tool-less bot). Forage stays as
// side work (owner Q2) but only near finds: the pickers in forage.js skip
// cells past PARK_FORAGE_RADIUS of home/castle while parked, so a parked
// bot cannot chain to a 300-block remembered diamond. 64 is the epic's
// own bound (stage-2: ends at home/site, not >64 away).
const PARK_FORAGE_RADIUS = 64
// Castle-first veto (idkcraft-vmzq.19): while an unfinished, unparked
// castle stands, the house-side steps (beds, build) yield — run3 picked
// equip then beds over a feasible castle, walked 500 blocks to the house,
// and never laid a cell. Equip is only outranked (STEP_ORDER), never
// vetoed: the castle chain needs its kit. Parked/complete releases (the
// L2 park's side work IS house work). Deferred require (the beds
// precedent — goal.js loads inside the behaviour chain).
// (.22) a house-<step> unlock lifts the veto for that step only — never
// wholesale (peer Q3). Pass the step name; omitted keeps the veto.
function castleFirst(ctx, step = null) {
  try {
    if (step) {
      try {
        const { goalUnlock } = require('./goal-unlock')
        if (goalUnlock(ctx, 'houseStep') === step) return false
      } catch (_) { /* no unlock */ }
    }
    return !!require('./behaviours/explore').castleActive(ctx)
  } catch (_) {
    return false
  }
}
// Pickless castle (idkcraft-vmzq.37): facts.rearm (equip.pickRearmDue —
// no pickaxe, active castle, body underground, pack funds one) makes equip
// feasible without a station and goalFsm/chooseStep rank it ahead of the
// castle legs: prod's pick wore out in a forage tunnel at y~40 and the
// castle-rule walked the no-dig body there for 17 min while equip waited
// for a table.
function picklessCastle(facts, names) {
  return !!(facts && facts.rearm) && names.includes('equip') &&
    (names.includes('castle') || names.includes('castlefetch'))
}
// Home-leg leash (vmzq.19 R2, major 2): the home-anchored steps (light,
// stockpile, gear) with an active castle run only near home — past the
// task radius the legs cross the map, and laya (which the castle-rule
// below only skips for a runnable castle) would pick them over the
// chain's gather/craft/equip. Unreadable position reads near (fail open,
// the nightFarFromHome rule).
// (.22) same per-step unlock seam as castleFirst (houseStep is build or
// beds, so light/stockpile/gear never lift — they stay vetoed by shape).
function homeLegVetoed(bot, ctx, step = null) {
  try {
    if (step) {
      try {
        const { goalUnlock } = require('./goal-unlock')
        if (goalUnlock(ctx, 'houseStep') === step) return false
      } catch (_) { /* no unlock */ }
    }
    if (!castleFirst(ctx)) return false
    const h = ctx && ctx.home && ctx.home.site
    const bp = bot && bot.entity && bot.entity.position
    if (!h || typeof h.x !== 'number' || !bp || typeof bp.x !== 'number') return false
    return Math.hypot(bp.x - h.x, bp.z - h.z) > require('./behaviours/explore').TASK_SEARCH_RADIUS
  } catch (_) {
    return false
  }
}
// Site half of the stockpile feasible (vmzq.39, extracted R3): an active
// far castle banks at the site instead of home. Shared with the pierce
// latch below — a site pick is not a pierce, so it must not arm the latch
// (revmux 02-after-fix major 3).
function stockpileSiteBranch(facts, bot, ctx) {
  try {
    if (!stockpileMod.siteMode(bot, ctx)) return false
    if (facts.haul === 'waiting' && facts.player !== 'none') return false
    const adopted = !!(ctx && ctx.castle && ctx.castle.siteChest) || !!stockpileMod.castleBankAt(bot, ctx) // g0z.27 castle bank
    if (!adopted) {
      try { return stockpileMod.siteChestTodo(bot, ctx) !== 'none' } catch (_) { return false }
    }
    return facts.surplus === 'yes'
  } catch (_) {
    return false
  }
}
// Parked-castle leash (vmzq.19 R2, minor 3): an L2 castle park releases
// the vetoes so the bot does side work — but with the home past the task
// radius, beds/build side work marches 500 blocks home and back on
// resume, so they stay vetoed then. An owner park (no episode) releases
// fully: the owner stopped the castle, their call. Near-site side work
// proceeds under either park. Only the auto-resuming episode leashes (R3,
// round-2 major B): a latched 3rd park lasts till the owner speaks, and
// the day's fallback work is the house, not the stalled site.
function castleParkLeash(ctx) {
  try {
    const st = ctx && ctx.castle
    if (!st || !st.taskPark || st.taskPark.auto !== true || !st.site || typeof st.site.x !== 'number') return false
    const h = ctx && ctx.home && ctx.home.site
    if (!h || typeof h.x !== 'number') return false
    return Math.hypot(h.x - st.site.x, h.z - st.site.z) > require('./behaviours/explore').TASK_SEARCH_RADIUS
  } catch (_) {
    return false
  }
}
// Pack-full pierce (vmzq.19 R3, round-2 major A): stockpile is the only
// pack drain. The dig has no room exactly when castlefetch's own
// roomForDrop says so (36 stacks with no cobble/dirt room, or the
// chestless reserve corner) — then the banking trip is the unblock, not
// drift. Deferred require (the demand precedent in castleFetchGo).
function packFull(bot, ctx) {
  try {
    return !require('./behaviours/castlefetch').roomForDrop(bot, ctx)
  } catch (_) {
    return false
  }
}
function taskParked(ctx) {
  try {
    if (ctx && ctx.castle && ctx.castle.parked) return true
  } catch (_) { /* unparked */ }
  try {
    if (ctx && ctx.home && ctx.home.parked) return true
  } catch (_) { /* unparked */ }
  return false
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
// gohome stickiness (the night-far force). Range is the retreat chain's
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
// Castle-site centre (the footprint middle, not the corner): shared by the
// two night rules below (vmzq.19 R2).
function castleSiteCentre(st) {
  let cx = st.site.x
  let cz = st.site.z
  try {
    const { w, d } = require('./castle').siteDimensions(st.rot | 0, st.blueprintVersion)
    cx += w / 2
    cz += d / 2
  } catch (_) { /* corner */ }
  return { x: cx, z: cz }
}
// The castle stands far from the house (vmzq.19 R2, major 1): a castle
// next to the house never anchors the night — the bot walks in.
function castleFarFromHome(ctx) {
  try {
    const st = ctx && ctx.castle
    const h = ctx && ctx.home && ctx.home.site
    if (!st || !st.site || typeof st.site.x !== 'number' || !h || typeof h.x !== 'number') return false
    const c = castleSiteCentre(st)
    return Math.hypot(c.x - h.x, c.z - h.z) > CASTLE_NIGHT_DIST
  } catch (_) {
    return false
  }
}
function castleNight(bot, ctx) {
  try {
    const st = ctx && ctx.castle
    const c = st && st.site
    const h = ctx.home && ctx.home.site
    const bp = bot && bot.entity && bot.entity.position
    if (!c || !h || !bp || typeof c.x !== 'number' || typeof h.x !== 'number' || typeof bp.x !== 'number') return false
    if (st.parked || st.phase === 'complete') return false
    const cc = castleSiteCentre(st)
    return Math.hypot(cc.x - h.x, cc.z - h.z) > CASTLE_NIGHT_DIST &&
      Math.hypot(bp.x - h.x, bp.z - h.z) > CASTLE_NIGHT_DIST &&
      Math.hypot(bp.x - cc.x, bp.z - cc.z) <= CASTLE_NIGHT_DIST
  } catch (_) {
    return false
  }
}
// Shelter owns the night when home is too far to walk, gohome is latched,
// or the bot is at its far castle.
function shelterOwns(bot, ctx) {
  return nightFarFromHome(bot, ctx) || gohomeLatched(ctx, bot) || castleNight(bot, ctx)
}
// Castle-site night (idkcraft-vmzq.19): while an unfinished, unparked
// castle stands FAR from home and the bot is away from home, dusk and
// night belong to the site — run3's dusk gohome marched 500 blocks at
// every dusk (twice caught mid-map) and the latched night looped at the
// house. castleNight above only fires within 48 of the site; this fires
// anywhere away from home, so a bot caught mid-map pillars in place
// instead of marching. Near home — or with the castle next to the house
// (R2 major 1: a 60-block dusk walk to a standing house beats a pillar) —
// the old steps win (walk in, stay). Homeless (idkcraft-vmzq.32: fresh
// memory, and build — the only siter — is castle-vetoed; the rig spawn is
// quarried, no flat 7x6 site) the night is the shelter's anywhere: there
// is no house to walk to (rig: 113 deaths working every night).
// Unbuilt home (vmzq.30): near a SITED-but-unbuilt home the old steps
// cannot run either (gohome/stay need built), and working the dark
// there dies (run6, rig: zombie spawn-loops) — so the night belongs to
// shelter in place at any distance, even next to the house or the site.
function castleSiteNight(bot, ctx) {
  try {
    if (!castleFirst(ctx)) return false
    if (!(ctx.home && ctx.home.site)) return true
    const h = ctx && ctx.home && ctx.home.site
    const bp = bot && bot.entity && bot.entity.position
    if (!h || typeof h.x !== 'number' || !bp || typeof bp.x !== 'number') return false
    if (ctx.home.built !== true) return true
    if (!castleFarFromHome(ctx)) return false
    return Math.hypot(bp.x - h.x, bp.z - h.z) > CASTLE_NIGHT_DIST
  } catch (_) {
    return false
  }
}
// Shelter fits now: the night it owns, a castle dusk (g0z.21), or dusk and
// night away from home with an active castle (vmzq.19, castleSiteNight) —
// the stickiness and the night-near force below read this too, so a
// mid-map dusk shelter holds instead of re-deciding every tick.
function shelterFits(facts, bot, ctx) {
  const t = facts && facts.time
  return (t === 'night' && shelterOwns(bot, ctx)) || (t === 'dusk' && castleNight(bot, ctx)) ||
    ((t === 'dusk' || t === 'night') && castleSiteNight(bot, ctx))
}

// Priority order (epic rw4 + atl.2 + atl.6): night steps first, then the
// castle chain (vmzq.19: castlefetch, castle — an ordered castle outranks
// the house chain, which run3 proved by losing every day to beds/build at
// the far house while the castle never laid a cell), then craft, rearm
// (equip), build, gather, then unload (deliver), dig (forage), search
// (explore), rest last. The return-to-site walk (vmzq.50) heads the
// chain: displaced, walking back beats fetching at spawn.
// goalFsm is pure priority over the feasible names it is given.
// An async window op (craft/equip/stockpile click) is running: the FSM
// holds its step and the residence switch (g0z.29, orders.js) waits.
function opInFlight(ctx) {
  return !!ctx && !!(ctx.equipInFlight || ctx.craftInFlight || ctx.stockpileInFlight || ctx.lightCraftInFlight || ctx.gearInFlight || ctx.furnaceInFlight)
}

const STEP_ORDER = ['stay', 'gohome', 'shelter', 'gocastle', 'castlefetch', 'castle', 'sitebed', 'craft', 'equip', 'build', 'beds', 'light', 'gather', 'deliver', 'stockpile', 'gear', 'forage', 'explore', 'rest']
// Alone-explore cap (idkcraft-dxl): without players the bot must not wander
// past this many blocks from home — new chunks bloat the host disk. Read by
// atl.1 explore.js when it lands; until then no behaviour consumes it.
const AUTONOMOUS_EXPLORE_RADIUS = 256

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
      // 10 quorum points on mere terrain. Clear cells (rw4.19) likewise:
      // any air interior reads done.
      if (cell.kind !== 'fill' && cell.kind !== 'clear' && buildMod.cellDone(bot, home, cell)) kindred++
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

function goalFacts(bot, ctx) {
  const time = timeWord(bot) || 'day'
  const logs = countItems(bot, (n) => n.endsWith('_log'))
  const planks = countItems(bot, (n) => n.endsWith('_planks'))
  const table = countItems(bot, (n) => n === 'crafting_table')
  const door = countItems(bot, (n) => n.endsWith('_door'))
  const sword = countItems(bot, (n) => n.endsWith('_sword'))
  const pickaxe = countItems(bot, (n) => n.endsWith('_pickaxe'))
  // Pickaxe rank word (rwuu): the state text tells no/wood/stone apart so
  // the equip criterion can match the wooden->stone upgrade. Read locally
  // (the bring.js PICKAXE_RANK mirror precedent — equip.js owns the copy).
  let pickWord = 'no'
  try {
    const held = bot && bot.inventory && typeof bot.inventory.items === 'function' ? bot.inventory.items() : []
    if (Array.isArray(held)) {
      let rank = -1
      for (const i of held) {
        const m = i && typeof i.name === 'string' && i.name.match(/^(wooden|golden|stone|iron|diamond|netherite)_pickaxe$/)
        if (m) rank = Math.max(rank, m[1] === 'wooden' || m[1] === 'golden' ? 0 : 1)
      }
      pickWord = rank < 0 ? 'no' : rank === 0 ? 'wood' : 'stone'
    }
  } catch (_) { /* unreadable inventory reads as no */ }
  const cobble = countItems(bot, (n) => n === 'cobblestone')
  const sticks = countItems(bot, (n) => n === 'stick')
  const coal = countItems(bot, (n) => n === 'coal' || n === 'charcoal')
  const charcoal = countItems(bot, (n) => n === 'charcoal') // 33vm: coal above holds both; light spends charcoal past the reserve
  const torches = countItems(bot, (n) => n === 'torch')
  const scaffold = countItems(bot, (n) => n === 'dirt' || require('./castle').isStone(n)) // vmzq.38: one stone set
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
  // Residence floors (g0z.28 residence.interior; hut/house: the floored
  // ctx.home.interior box). One predicate with home.isInside (revmux
  // jr2.3-02): a raw float read the back row outside while the helper read
  // it inside — gohome then finished 'done' and was re-picked all night.
  let inside = 'no'
  try {
    const bp = bot && bot.entity && bot.entity.position
    const home = ctx && ctx.home
    if (bp && home && residence.of(home).interior(home, bp)) inside = 'yes'
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
  let rearm = false
  try { rearm = require('./behaviours/equip').pickRearmDue(bot, ctx) } catch (_) { rearm = false }
  return { rearm, time, logs, planks, maxPlanks, table, door, sword, pickaxe, pickWord, cobble, sticks, coal, charcoal, torches, scaffold, home, unlit, tablePlaced, inside, health, food, known, haul, player, chest, chestTodo, surplus, chestParked, ironOre, ingots, diamonds, ironPick, ironSword, diamondPick, diamondSword, bucket, waterBucket, ironHelmet, ironChestplate, ironLeggings, ironBoots, diamondHelmet, diamondChestplate, diamondLeggings, diamondBoots, wornIronHelmet, wornIronChestplate, wornIronLeggings, wornIronBoots, wornDiamondHelmet, wornDiamondChestplate, wornDiamondLeggings, wornDiamondBoots, furnaceItem, furnace, gearHandover, gear, beds, castle }
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
  // Equip words (rwuu): the kit state the equip criterion matches — a
  // missing sword or pickaxe (the g0z.4 stone-castle re-decide rides on
  // the pickaxe word too), a wooden pickaxe the stone chain can upgrade,
  // or blocks below the dig-full mark. Only while the kit wants work: a
  // complete kit keeps the text byte-identical (the castle word below is
  // the precedent). The blocks word rides on the tool words: a word of its
  // own at 16 would re-decide the flagless 16->32 dig mid-step and
  // flip-flop at every 15/16 crossing (revmux 01 body-1), and at 32 it
  // would churn on every crossing where the bot sits after each refill
  // (revmux 02 core-2) — so kit-complete legs never see it at all.
  const noSword = !((facts.sword || 0) > 0)
  const noPick = !((facts.pickaxe || 0) > 0)
  const woodPick = !noPick && facts.pickWord === 'wood' && (facts.cobble || 0) >= 3
  const blocksLow = (noSword || noPick || woodPick) &&
    (facts.scaffold || 0) < require('./behaviours/equip').SCAFFOLD_FULL
  return `time=${facts.time} logs=${logs} planks=${planks} ` +
    `table=${table} door=${door} home=${facts.home} inside=${inside} unlit=${unlit} health=${health} food=${food} ` +
    `known=${facts.known} haul=${facts.haul} player=${facts.player} ` +
    `chest=${facts.chest} surplus=${facts.surplus} handover=${facts.gearHandover} gear=${facts.gear} beds=${beds}` +
    // Castle word only while a castle exists (g0z.3): castle-less text
    // stays byte-identical for the model and every pinned state string.
    (facts.castle && facts.castle !== 'none' ? ` castle=${facts.castle}` : '') +
    (noSword ? ' sword=no' : '') +
    (noPick ? ' pickaxe=no' : woodPick ? ' pickaxe=wood' : '') +
    (blocksLow ? ' blocks=low' : '')
}

// atl.4 livelock guard: a recorded step failure holds while the facts text
// is unchanged and the body stays within REFAIL_DIST of the failure point.
// New facts or relocation release the step for a fresh try. Per-step map:
// alternating failures must not release each other.
// Steps whose failure advances their own situation never hold: explore
// consumes the failed point (the next pick is a new target by
// construction), gohome/stay retry from a fresh record through door
// phases (rw4.5 owns their trouble). Holding them would deadlock the
// spiral after one river and strand the night walk. The guard bars the
// steps that would otherwise replay the failure identically.
const SELF_ADVANCING = { explore: true, gohome: true, stay: true }
// Bounded holds (g0z.4 castlefetch, idkcraft-bt8s forage): windows in budget.js.
function forageHeld(ctx) {
  try {
    const sf = ctx && ctx.stepFail && ctx.stepFail.forage
    return !!sf && typeof sf.at === 'number' && Date.now() - sf.at <= FORAGE_RETRY_MS
  } catch (_) {
    return false
  }
}
// Failed-build hold (idkcraft-67z3): BUILD_RETRY_MS and its why in budget.js.
function buildHeld(ctx) {
  try {
    const sf = ctx && ctx.stepFail && ctx.stepFail.build
    if (!sf || typeof sf.at !== 'number') return false
    if (Date.now() - sf.at > BUILD_RETRY_MS) return false
    if (sf.status === 'failed:no-site') {
      // A site now set voids the verdict (67z3 revmux 01): the none->site
      // text flip released it on master, and the text-blind hold must
      // match — otherwise a 'build here' rescue waits out the window.
      if (ctx && ctx.home && ctx.home.site) return false
      return (sf.n || 1) >= 2
    }
    if (sf.status === 'failed:no-planks') return (sf.n || 1) >= 2
    return true
  } catch (_) {
    return false
  }
}
// Cause signature (67z3): what a repeated build failure is ABOUT. A
// no-planks retry with new resources — or fewer cells left — is the
// healthy batch handoff; the same failure with the same resources and no
// cell placed is the stuck shape. no-site is homeless by definition, so
// any repeat counts. Structural verdicts key on the site (a 'build here'
// move re-arms) plus the skip count for skipped-cells (the 1h re-probe
// re-arms). Null when uncomputable: no counting then.
function buildFailSig(status, facts, ctx, bot) {
  try {
    const home = ctx && ctx.home
    if (status === 'failed:no-site') return 'site=none'
    if (status === 'failed:no-planks') {
      let remaining = null
      try {
        if (home && home.site && bot) {
          const skip = new Set(Array.isArray(ctx.buildSkip) ? ctx.buildSkip : [])
          const plan = buildMod.blueprintFor(home)
          let n = 0
          for (let i = 0; i < plan.length; i++) {
            if (skip.has(i)) continue
            if (!buildMod.cellDone(bot, home, plan[i])) n++
          }
          remaining = n
        }
      } catch (_) { remaining = null }
      return `planks=${facts.planks},table=${facts.table},door=${facts.door},remaining=${remaining}`
    }
    const s = home && home.site
    const site = s && typeof s.x === 'number' ? `${s.x},${s.y},${s.z}` : 'none'
    if (status === 'failed:skipped-cells') {
      const skips = Array.isArray(ctx.buildSkip) ? ctx.buildSkip.length : 0
      return `site=${site},skips=${skips}`
    }
    return `site=${site}`
  } catch (_) {
    return null
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
    if (Math.hypot(bp.x - sf.pos.x, bp.z - sf.pos.z) > REFAIL_DIST) return false
    // No-site release (idkcraft-vmzq.16): failed:no-site is a chunk
    // verdict, but the facts text carries no chunk signal — without the
    // probe the hold survives the chunks loading and the homeless bot
    // rests until some unrelated fact moves. While the failure otherwise
    // stands, re-validate: a site that wins now releases the hold for a
    // fresh try. Wet/uneven ground keeps refusing (null), so those holds
    // stand without churn.
    if (name === 'build' && sf.status === 'failed:no-site' && !(ctx && ctx.home && ctx.home.site)) {
      try {
        if (bot && bot.spawnPoint && siteFor(bot, bot.spawnPoint)) return false
      } catch (_) { /* unverifiable: hold stands */ }
    }
    return true
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
    // vmzq.37: a pickless castle rearms first — the legs cannot dig.
    if ((name === 'castle' || name === 'castlefetch') && picklessCastle(facts, [...ok])) return 'equip'
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
  gather: 'logs is none or few and home is not built, or home is built and beds is none or one and logs is none or few, or castle is a -none or -some word other than torch and logs is none or few: chop trees',
  craft: 'logs is enough or planks are few or table is no or door is no: craft planks, table and door',
  build: 'planks are enough and home is site: place the house blocks',
  beds: 'beds is none or one and time is day and home is built: gather wool, craft the bedroom beds and place them',
  light: 'unlit is few or many and time is day and home is built: place torches around the house',
  castlefetch: 'castle is stone-none, planks-none, frame-none, torch-none, door-none, fence-none, chest-none or a -some word or blocked with its kind short and time is day: fetch castle material from the castle chest, craft it, or dig stone and chop logs',
  castle: 'castle is clear, finish, stone-batch, planks-batch, frame-batch, torch-batch, door-batch, fence-batch or chest-batch and time is day: lay the next castle blocks',
  sitebed: 'time is day or dusk and the pack holds a bed while a castle is active: place the bed outside the site and set the spawn',
  equip: 'sword is no, pickaxe is no or wood, or blocks is low: craft tools and dig blocks',
  gohome: 'time is dusk or night and home is built and inside is no: go inside',
  shelter: 'time is night (or dusk at the far castle) and home is built and inside is no: stop marching and wait where you are till dawn',
  gocastle: 'time is day and the castle site is far: walk back to the castle site on the surface so laying can resume',
  deliver: 'haul is waiting: carry it to the player',
  stockpile: 'chest is no, surplus is yes, or handover is waiting: place the home chest (or a site chest) and bank the surplus',
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
  // Castle rule (vmzq.19 R2, major 2, the night-rule precedent): a runnable
  // castle is a rule, not a preference — run3's laya picked equip then
  // beds over a feasible castle and walked 500 blocks home. The model is
  // consulted only when the castle cannot run now.
  // vmzq.37: the pickless rearm (goalFsm) rides the same rule.
  // vmzq.50: the return-to-site walk rides it too — displaced, the model
  // must not wander to forage/explore instead of walking back.
  if (fsm === 'castle' || fsm === 'castlefetch' || fsm === 'gocastle' || fsm === 'sitebed' || (fsm === 'equip' && picklessCastle(facts, names))) return { step: fsm, source: 'castle-rule', fsm, model: null }
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
      if (castleSiteNight(bot, ctx)) return 'gohome: sheltering at the castle'
      return 'gohome: too far to walk at night'
    case 'shelter':
      if (facts.time === 'day') return 'shelter: daytime'
      if (duskClimbOut(facts, bot, ctx)) return 'shelter: climbing out before sheltering'
      if (facts.time === 'dusk') return 'shelter: dusk marches home'
      if (facts.home !== 'built') return 'shelter: home not built'
      if (facts.inside !== 'no') return 'shelter: already inside'
      return 'shelter: home is close'
    case 'gocastle':
      if (!ctx || !ctx.castle || !ctx.castle.site || ctx.castle.parked || ctx.castle.phase === 'complete') return 'gocastle: no active castle'
      if (facts.time !== 'day' && facts.time !== 'dusk') return 'gocastle: daytime job'
      if (!displacedFromCastle(bot, ctx)) return 'gocastle: already at the site'
      if (lowHpGated(bot, facts, ctx) && threatNear(bot)) return 'gocastle: too hurt to travel (low health, no food, hostile near)'
      return 'gocastle: dusk shelters' // dusk on the surface (the climb leg is the only dusk run)
    case 'craft':
      if (ctx && ctx.home && ctx.home.parked) return 'craft: house parked'
      if ((facts.table > 0 || facts.tablePlaced) && facts.door > 0) return 'craft: nothing to craft'
      if (facts.door === 0 && facts.tablePlaced) return `craft: need 6 planks for the door, have ${facts.maxPlanks}`
      if (facts.table === 0 && !facts.tablePlaced) return `craft: need 4 planks for the table, have ${facts.maxPlanks}`
      if (facts.logs >= NEED_LOGS && woodCapped(bot, ctx)) return 'craft: wood store full, banking the surplus'
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
      if (buildHeld(ctx)) return 'build holds after failure'
      if (castleFirst(ctx, 'build') || castleParkLeash(ctx)) return 'build: castle comes first'
      if (ctx && ctx.home && ctx.home.parked) return 'build: house parked'
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
      if (castleFirst(ctx, 'beds') || castleParkLeash(ctx)) return 'beds: castle comes first'
      if (facts.time !== 'day') return 'beds: daytime job'
      if (facts.home !== 'built') return 'beds: house not built yet'
      if (facts.beds !== 'none' && facts.beds !== 'one') return 'beds: both beds are in'
      try {
        const held = require('./behaviours/beds').placeHeld(ctx, bot)
        if (held) return held.latched ? 'beds: bed unreachable, latched until the home changes' : `beds: bed unreachable, retry in ${Math.ceil(held.left / 1000)}s`
      } catch (_) { /* wording best-effort */ }
      try { if (require('./behaviours/beds').sheepLatched(ctx, bot)) return 'beds: sheep hunt latched' } catch (_) { /* wording best-effort */ }
      return 'beds: not feasible'
    case 'light': {
      if (facts.time !== 'day') return 'light: daytime job'
      if (homeLegVetoed(bot, ctx, 'light')) return 'light: castle comes first'
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
      if (lowHpGated(bot, facts, ctx)) return 'castle: eating first (low health, no food)'
      if (w === 'blocked') return 'castle: next cell blocked, retrying later'
      const kind = w.slice(0, w.lastIndexOf('-'))
      if (w.endsWith('-none')) return `castle: need ${kind}`
      return `castle: need a batch of ${kind}`
    }
    case 'castlefetch': {
      const w = facts.castle || 'none'
      if (facts.time !== 'day') return 'castlefetch: daytime job'
      if (lowHpGated(bot, facts, ctx)) return 'castlefetch: eating first (low health, no food)'
      // Blocked (g0z.23): the gated kind, like the gate above.
      let kind = null
      if (w === 'blocked') {
        kind = ctx && ctx.castleWord && ctx.castleWord.kind
        if (!kind) return 'castlefetch: no material owed'
        try { if (!(kind in require('./behaviours/castlefetch').FETCH)) return 'castlefetch: no material owed' } catch (_) { return 'castlefetch: no material owed' }
      } else {
        if (!/-(none|some|batch)$/.test(w)) return 'castlefetch: no material owed'
        kind = w.slice(0, w.lastIndexOf('-'))
      }
      if (kind === 'stone' && !((facts.pickaxe || 0) > 0)) return 'castlefetch: no pickaxe'
      return 'castlefetch: batch on hand'
    }
    case 'gather':
      if (ctx && ctx.home && ctx.home.parked) return 'gather: house parked'
      if (nightHurt(facts)) return 'gather: hurt at night, waiting for dawn'
      if (facts.home === 'built') return 'gather: home built'
      return 'gather: load full'
    case 'deliver':
      if (facts.haul !== 'waiting') return 'deliver: nothing waiting'
      return 'deliver: nobody to deliver to'
    case 'stockpile': {
      // Site reasons only when home is out of the picture (unbuilt): a
      // built home keeps its leash wording (vmzq.19), the site fallback
      // having already lost in feasible.
      try {
        if (facts.home !== 'built' && stockpileMod.siteMode(bot, ctx)) {
          if (facts.haul === 'waiting' && facts.player !== 'none') return 'stockpile: haul waits for its player'
          try {
            if (stockpileMod.siteParked(bot, ctx)) return 'stockpile: site chest full'
          } catch (_) { /* wording best-effort */ }
          const adopted = !!(ctx && ctx.castle && ctx.castle.siteChest) || !!stockpileMod.castleBankAt(bot, ctx) // g0z.27 castle bank
          if (!adopted) return 'stockpile: no site chest to adopt, nothing to place it with'
          return 'stockpile: nothing to bank'
        }
      } catch (_) { /* wording best-effort: home below */ }
      if (facts.home !== 'built') return 'stockpile: house not built yet'
      if (homeLegVetoed(bot, ctx, 'stockpile')) return 'stockpile: castle comes first'
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
    }
    case 'gear': {
      if (facts.home !== 'built') return 'gear: house not built yet'
      if (homeLegVetoed(bot, ctx, 'gear')) return 'gear: castle comes first'
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
      if (castleBlocked(facts)) return 'forage: castle blocked, waiting at the site'
      if (facts.known !== 'near') return 'forage: nothing known nearby'
      return 'forage: known find unreachable'
    case 'explore':
      if (taskParked(ctx)) return 'explore: parked, staying near home'
      if (facts.home !== 'built') return 'explore: house not built yet'
      if (castleBlocked(facts)) return 'explore: castle blocked, waiting at the site'
      return 'explore: nowhere new to go'
    default:
      return `${name}: not feasible`
  }
}

function restWhy(facts, bot, ctx, names, upto) {
  const ok = new Set(Array.isArray(names) ? names : [])
  let text = ''
  try {
    text = goalText(facts, ctx && ctx.home)
  } catch (_) { /* wording best-effort */ }
  const out = []
  // upto (gwvg): status() passes the current step so only the
  // higher-priority steps it skipped are phrased; rest (last) and an
  // omitted upto iterate everything, byte-identical to before.
  for (const n of STEP_ORDER) {
    if (n === 'rest') continue
    if (upto && n === upto) break
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
// goal.js loads before behaviours/index.js finishes (the behaviours require
// goal), so the table is read at decide()
// time, never at load time.
function registered(name) {
  try {
    const table = require('./behaviours/index').BEHAVIOURS
    return !!table && typeof table[name] === 'function'
  } catch (_) {
    return false
  }
}

// Re-decide forces (idkcraft-vmzq.62, vmzq.4): every reason decide()
// re-picks a running step besides start/step-done/step-failed, in one list.
// kind 'gate': evaluated every tick at its existing site, in the existing
// order (fetch-retry, build-retry and site-retry retire or void their hold
// as they fire, and gate-opened writes its edge latch). kind 'word': a
// facts-text word whose flip since the pick re-decides on its own. Every
// other text move re-decides only through the commitment rule in decide()
// (the running step left the menu, or the FSM answer moved). Kept outside
// (vmzq.4 Codex objection 2, they protect multi-tick operations, not text
// diffs): the in-flight craft holds, the rw4.5 night/door stickiness, the
// retreat latch; and the vmzq.5/.21/.50 pins, which name themselves in why=.
// fires(prev, facts, ctx, status, bot, text).
function textWord(text, key) {
  const m = typeof text === 'string' ? text.match(new RegExp(`(?:^| )${key}=(\\S+)`)) : null
  return m ? m[1] : null
}
const wordFlipped = (keys) => (prev, facts, ctx, status, bot, text) =>
  !!ctx && typeof ctx.goalText === 'string' && keys.some((k) => textWord(ctx.goalText, k) !== textWord(text, k))
const FORCES = [
  // A chain-owned step (retreat/pillar, index.js sets ctx.step outside
  // decide) is never held: it re-decides into a goal step.
  { name: 'chain', bead: 'idkcraft-1tj', kind: 'gate', fires: (prev, facts, ctx) => !!(ctx && ctx.retreat && ctx.retreat.action === prev) },
  // Bounded castlefetch hold: an expired hold retires and forces one pick.
  {
    name: 'fetch-retry', bead: 'idkcraft-g0z.4', kind: 'gate',
    fires: (prev, facts, ctx) => {
      const sf = ctx && ctx.stepFail && ctx.stepFail.castlefetch
      if (sf && typeof sf.at === 'number' && Date.now() - sf.at > CASTLEFETCH_RETRY_MS) {
        delete ctx.stepFail.castlefetch
        return true
      }
      return false
    },
  },
  // Low-hp gate gated->open edge: one fresh pick (writes the edge latch).
  {
    name: 'gate-opened', bead: 'idkcraft-vmzq.51', kind: 'gate',
    fires: (prev, facts, ctx, status, bot) => {
      const gatedNow = lowHpGated(bot, facts, ctx)
      const wasGated = ctx ? ctx.lowHpWasGated === true : false
      if (ctx) ctx.lowHpWasGated = gatedNow
      return wasGated && !gatedNow
    },
  },
  // Expired build hold: one-shot (retryFired), voids the text/pos key.
  {
    name: 'build-retry', bead: 'idkcraft-67z3', kind: 'gate',
    fires: (prev, facts, ctx) => {
      const sf = ctx && ctx.stepFail && ctx.stepFail.build
      if (sf && sf.status !== 'failed:no-site' && typeof sf.at === 'number' && Date.now() - sf.at > BUILD_RETRY_MS && !sf.retryFired) {
        sf.retryFired = true
        sf.text = null
        sf.pos = null
        return true
      }
      return false
    },
  },
  // No-site hold retires when a spawn-anchored site validates now.
  {
    name: 'site-retry', bead: 'idkcraft-vmzq.16', kind: 'gate',
    fires: (prev, facts, ctx, status, bot, text) => {
      const sf = ctx && ctx.stepFail && ctx.stepFail.build
      if (sf && sf.status === 'failed:no-site' && sf.text === text && !(ctx && ctx.home && ctx.home.site)) {
        let site = null
        try { site = bot && bot.spawnPoint ? siteFor(bot, bot.spawnPoint) : null } catch (_) { site = null }
        if (site) {
          delete ctx.stepFail.build
          return true
        }
      }
      return false
    },
  },
  // Night-far gohome (ipn.12): a night march still far from home — or a
  // respawn far away — hands the night to shelter, even with steady facts
  // (a keepInventory death moves no bucket). Door phases run near home, so
  // the walk-phase check never breaks a doorway.
  {
    name: 'night-far', bead: 'idkcraft-ipn.12', kind: 'gate',
    fires: (prev, facts, ctx, status, bot) => !isFinished(status) && prev === 'gohome' && !!ctx && !!ctx.gohome &&
      ctx.gohome.phase === 'walk' && facts.time === 'night' && nightFarFromHome(bot, ctx),
  },
  // Night-near shelter (ipn.12 revmux 03): the mirror — a respawn by the
  // house walks in instead of pillaring outside all night.
  {
    name: 'night-near', bead: 'idkcraft-ipn.12', kind: 'gate',
    fires: (prev, facts, ctx, status, bot) => !isFinished(status) && prev === 'shelter' && facts.time !== 'day' && !shelterFits(facts, bot, ctx),
  },
  // Orders/stop/follow handover/bring clear ctx.step outside decide
  // (resetNightStep): the next decide starts from no step with a text
  // already standing (a first boot has none).
  { name: 'order', bead: 'idkcraft-rw4.5', kind: 'word', fires: (prev, facts, ctx) => !prev && !!ctx && typeof ctx.goalText === 'string' },
  { name: 'time', bead: 'idkcraft-rw4.1', kind: 'word', fires: wordFlipped(['time']) },
  { name: 'health', bead: 'idkcraft-rw4.6', kind: 'word', fires: wordFlipped(['health']) },
  { name: 'food', bead: 'idkcraft-rw4.6', kind: 'word', fires: wordFlipped(['food']) },
  // Castle word flip (the castlefetch->castle handoff and back).
  { name: 'castle-word', bead: 'idkcraft-g0z.3', kind: 'word', fires: wordFlipped(['castle']) },
  // Kit words (sword/pickaxe/blocks mid-castle).
  { name: 'kit', bead: 'idkcraft-rwuu', kind: 'word', fires: wordFlipped(['sword', 'pickaxe', 'blocks']) },
]
const FORCE = Object.fromEntries(FORCES.map((f) => [f.name, f]))

// The step menu: feasible, registered and not held on this text.
function menuNames(facts, bot, ctx, text) {
  return Object.keys(MENU).filter((n) => {
    try {
      if (!MENU[n].feasible(facts, bot, ctx) || !registered(n)) return false
    } catch (_) {
      return false
    }
    return !failHolds(ctx, n, text, bot)
  })
}

// Step commitment (idkcraft-vmzq.4): a running step is re-decided on a
// facts-text move only when the move matters to it — a word force from
// the table, the step left the menu (its own feasible() turned false, or
// a hold), or the FSM answer moved since the pick. With the FSM brain
// that is exactly the old facts-changed re-pick (a re-decide that keeps
// the step is a no-op); with a model it stops the re-ask flaps (beds <->
// explore, forage <-> rest) on moves that change nothing for the step.
// Known belongs to the running forage/explore leg (4dse: an animal at the
// find edge flips near/none every 1-3 s, 347 switches/h): the leg reads
// the text with its pick-time known word, so a known-only flip is no move
// at all — the leg runs to done/failed and re-picks honestly. A pick this
// rule cannot vouch for (an order/retreat moved ctx.step, a task-plan pin
// whose bound must still release it on a text move, a legacy ctx) keeps
// the old rule: any move re-decides. One evaluation per move: the last
// held text is the reference until the next pick (old: one re-decide per move).
function textForce(prev, facts, bot, ctx, status, text) {
  let seen = text
  if (prev === 'forage' || prev === 'explore') {
    const k = textWord(ctx.goalText, 'known')
    if (k) seen = goalText({ ...facts, known: k }, ctx.home)
  }
  if (seen === (typeof ctx.heldText === 'string' ? ctx.heldText : ctx.goalText)) return false
  if (FORCES.some((f) => f.kind === 'word' && f.fires(prev, facts, ctx, status, bot, text))) return true
  const pick = ctx.stepPick
  if (!pick || pick.step !== prev || pick.source === 'task-plan' || typeof pick.fsm !== 'string') return true
  const names = menuNames(facts, bot, ctx, text)
  if (!names.includes(prev) || goalFsm(facts, names) !== pick.fsm) return true
  // rest never finishes (rest.js roams, no done/failed): a model rest over
  // a work answer is re-asked on every move, the old rule (revmux 01).
  if (prev === 'rest' && pick.fsm !== 'rest') return true
  ctx.heldText = seen
  return false
}

// decide() blocks (idkcraft-oqul.10): the contiguous blocks of decide(),
// extracted in place and called in the original order — the order of the
// branches IS the logic (safety holds before the short paths, a finished
// commit before the next menu, the castle re-arm over plan and commit).
// Each block names what it reads and what it may write.

// Day reset. Reads facts.time/inside, ctx.inShelter; writes ctx.inShelter,
// ctx.gohomeLatch (+ the wall guard through build.guardOwnWalls).
function dayReset(bot, ctx, facts) {
  // Shelter is a night concept: a sticky gohome that finishes after sunrise
  // leaves inShelter true with no stay step to clear it, suppressing fight
  // all day (revmux 01-review loop+goal-3).
  if (ctx && facts.time === 'day') {
    // Verifier P2 on #311 (pathing, raised twice — revmux core-1 family):
    // clearing the flag while the body is still inside must arm the wall
    // guard first — the next tick may dispatch work or fight from inside,
    // and without the build-installed exclusion A* digs through our own
    // walls (the guard is only installed by build/light, never after
    // adopt). Outside (dig-in, pillar) there is nothing to guard.
    if (ctx.inShelter && facts.inside === 'yes') {
      try { buildMod.guardOwnWalls(bot, ctx) } catch (_) { /* guard best-effort */ }
    }
    ctx.inShelter = false
    ctx.gohomeLatch = null // the latch lasts one night (xhqv)
  }
}

// Low-hp gate clock. Reads the pack (lowHpNoFood), ctx.lowHpGate*; writes
// ctx.lowHpGateSince, ctx.lowHpGateLast.
function lowHpClock(bot, ctx, facts) {
  // Low-hp gate clock (idkcraft-vmzq.51): arms on the raw pack check while
  // gated, clears on food or healing — the gates above read it, probes
  // never arm it (the write lives on the decide path only). A silence past
  // LOW_HP_GAP_MS restarts the window (revmux 01 minor): decide runs on
  // work ticks only, so after a fight/follow/pause stretch the gating was
  // not continuous — opening on the stale stamp would skip the stand-down
  // on the first tick back (the run8 shape .49 gated against).
  try {
    if (ctx) {
      if (lowHpNoFood(bot, facts)) {
        const last = ctx.lowHpGateLast
        if (typeof ctx.lowHpGateSince !== 'number' || typeof last !== 'number' || Date.now() - last > LOW_HP_GAP_MS) {
          ctx.lowHpGateSince = Date.now()
        }
        ctx.lowHpGateLast = Date.now()
      } else {
        ctx.lowHpGateSince = null
        ctx.lowHpGateLast = null
      }
    }
  } catch (_) { /* clock best-effort */ }
}

// Async gear/furnace translation, for a finished gear step. Reads
// ctx.furnace; writes ctx.furnace.result, ctx.stepStatus, ctx.stepFail.gear,
// ctx.gear.saidNeed (+ chat). Returns null (no leg outcome), the decision
// to return (leg done: keep working the rung), or the translated status.
function gearOutcome(bot, ctx) {
  // Async gear/furnace translation BEFORE the hold bookkeeping (revmux
  // 02-review): the hold must record the translated status - and no hold at
  // all for a yield - or the rename is dead and its test passes without
  // this branch. The locals rewrite from the translation, so no-fuel takes
  // the done branch (which deletes the hold) and stalls record gear-named.
  let result = null
  try {
    const f = ctx && ctx.furnace
    if (f && f.settled) result = f.result || null
  } catch (_) { /* no leg outcome */ }
  if (!result) return null
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
  }
  const reason = failReason(result) ?? result
  if (reason === 'no-cobble' || reason === 'no-fuel') {
    const key = reason === 'no-cobble' ? 'want-cobble' : 'want-coal'
    let line = reason === 'no-cobble' ? 'need 8 cobble for the furnace, going to dig' : 'need coal or planks, going to dig'
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
        console.log(`gear yield key=${key} line=${line}`) // ipn.15: gear's announceYield twin
      }
    } catch (_) { /* announce best-effort */ }
    ctx.stepStatus = 'done' // yield: fetchers run, gear latched out
    return 'done'
  }
  ctx.stepStatus = `failed:gear-furnace-${reason}`
  return ctx.stepStatus
}

// Outcome bookkeeping for a finished step. Reads status, facts, ctx.goalText;
// writes ctx.stepFail (holds), the gohome fail note, ctx.stockpilePierced.
function recordOutcome(bot, ctx, facts, prev, status, finished, text) {
  if (finished && prev && failReason(status) !== null) {
    try {
      if (!ctx.stepFail || typeof ctx.stepFail !== 'object') ctx.stepFail = {}
      const old = ctx.stepFail[prev]
      const bp = bot && bot.entity && bot.entity.position
      const rec = { status, text, pos: bp ? { x: bp.x, y: bp.y, z: bp.z } : null, at: Date.now() }
      // Consecutive-cause counter (67z3): the failed-build hold counts
      // repeats with the same cause (new resources, a placed cell, or a
      // validated site re-arm).
      if (prev === 'build') {
        const sig = buildFailSig(status, facts, ctx, bot)
        if (sig != null) {
          rec.sig = sig
          rec.n = (old && old.status === status && old.sig === sig) ? (old.n || 1) + 1 : 1
        }
      }
      ctx.stepFail[prev] = rec
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
  // Pack-full pierce latch (vmzq.19 R4, round-3 major): a finished banking
  // trip releases — done banked, failed re-latches on the next full pick.
  if (finished && prev === 'stockpile' && ctx) {
    try { ctx.stockpilePierced = false } catch (_) { /* latch best-effort */ }
  }
}

// Night stickiness and retreat hysteresis. Reads ctx.gohome/stay phase,
// the retreat latch; writes ctx.retreatLatch, ctx.stepStatus. Returns the
// held decision, or null to fall through to the forces and the menu.
function stickyHold(bot, ctx, facts, prev, status, finished, nightFarWalk) {
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
  // Retreat hysteresis (idkcraft-vmzq.49): a latched chain leg holds
  // across veto flicker — run8 15:52 re-picked castle into a 1-block
  // zombie the tick the veto dropped and died there. While the latch
  // stands the leg re-issues instead of re-deciding; a failed leg or a
  // truly clear tick (bands) clears the latch and falls through.
  if (prev === 'retreat' || prev === 'pillar') {
    try {
      const failed = failReason(status) !== null
      const rm = require('./behaviours/retreat')
      if (failed || rm.retreatClear(bot, { bot_health: facts.health })) {
        if (ctx) ctx.retreatLatch = null
      } else if (rm.latchedAction(ctx) === prev) {
        ctx.stepStatus = 'running'
        return { action: prev, sprint: false, source: 'goal-fsm' }
      }
    } catch (_) { /* hold best-effort: the menu below decides */ }
  }
  return null
}

// Gate forces past the night ones, in their original firing order (a gate
// fire may carry its own side effects — FORCES owns those writes).
function gateForces(fires) {
  // A chain-owned step is never held: re-issuing it here
  // would bypass feasibility and the model ask (the stale hold in another
  // coat). Force a real re-decide instead; the menu never contains
  // retreat/pillar, so ownership transfers to a goal step.
  const chainOwns = fires('chain')
  // Bounded castlefetch hold (g0z.4): an expired hold retires and forces
  // one fresh pick — with the text standing, the replay paths would keep
  // the step that took over and the owner's chest restock never gets seen.
  let fetchRetry = false
  try { fetchRetry = fires('fetch-retry') } catch (_) { /* retry best-effort */ }
  // Opened low-hp gate (vmzq.51 verifier P2): the stand-down lifts on a
  // wall clock (timeout, food, healing) that the facts text may never
  // carry — food in the pack is text-invisible — so with steady facts the
  // replay paths would keep the running step and the bound would never
  // fire in exactly the no-food scenario it bounds. A gated->open edge
  // forces one fresh pick, like the retries. One-shot by construction
  // (the edge flips); closing needs no force (every re-pick re-checks
  // feasibility, and the closed gate fails it).
  let gateOpened = false
  try { gateOpened = fires('gate-opened') } catch (_) { gateOpened = false }
  // Expired build hold (67z3 verifier P2): an expired hold forces one
  // fresh pick, or steady facts keep the running step past the window.
  // The record stands with its counter (revmux 03 minor): deleting it
  // would restart the repeat at n=1 and pick twice per window, while the
  // kept counter holds the very next identical failure (n+1) — one pick
  // per window. The fire voids the text/pos key instead: a matching text
  // would let the text-keyed failHolds veto the forced pick in the menu
  // (deletion used to do that implicitly). retryFired makes the force one-shot; any later
  // verdict overwrites the record and re-arms. no-site records are
  // excluded: their steady-text retry is siteRetry's per-tick probe (a
  // forced blind retry adds no information), and the record is the
  // pending-house task identity (task.js) — deleting it at 5 min would
  // null the task and kill the 15-min L1.
  let buildRetry = false
  try { buildRetry = fires('build-retry') } catch (_) { /* retry best-effort */ }
  // No-site retry (idkcraft-vmzq.16): the fetchRetry mirror for a homeless
  // build — a failed:no-site hold retires and forces one fresh pick when a
  // site validates NOW (chunks streamed in). With the text standing, the
  // replay paths would keep the step that took over and the valid site
  // never gets seen. Gated on the failure text still standing (revmux 01
  // majors): a changed text releases through the normal hold path —
  // retiring here would preempt a forage leg past the 4dse flicker hold
  // and delete the record the pending-house stall clock reads, resetting
  // it on every bucket flip. Probe-only (67z3 revmux 01 major): retiring
  // on relocation alone re-picks build once per 32-block wander with no
  // new information — that IS the post-park loop — and deletes the repeat
  // counter with the record. A relocation that loads the spawn chunks
  // retires through the probe, the only arm that ever had news (the probe
  // is spawn-anchored, never the bot).
  let siteRetry = false
  try { siteRetry = fires('site-retry') } catch (_) { /* retry best-effort */ }
  return { chainOwns, fetchRetry, gateOpened, buildRetry, siteRetry }
}

// Plan and commitment pins. Reads ctx.taskPlanStep, ctx.goal.commit;
// writes nothing.
function readPins(ctx) {
  // Stall-point plan (idkcraft-vmzq.5): a forced one-shot step from the
  // L2 planner. Forces a real re-decide past the commitment below (but
  // waits out the in-flight and stickiness holds above — never preempts
  // a craft click or a door phase).
  let planStep = null
  try {
    planStep = ctx && typeof ctx.taskPlanStep === 'string' ? ctx.taskPlanStep : null
  } catch (_) {
    planStep = null
  }
  // Watchdog commitment (idkcraft-vmzq.21): a bounded window pinning one
  // step, honoured like the one-shot force but for the whole window. The
  // cheap check only (identity + window); taskTick owns preempts/pauses.
  let commitStep = null
  let commitActive = false
  try {
    const g = ctx && ctx.goal
    const tc = g && g.commit
    if (tc && g && tc.goalId === g.id && tc.generation === g.generation && typeof tc.step === 'string' && Date.now() < tc.until) {
      commitStep = tc.step
      commitActive = true
    }
  } catch (_) {
    commitStep = null
    commitActive = false
  }
  return { planStep, commitStep, commitActive }
}

// Commit force gate. Reads facts, the menu, ctx.step; writes nothing.
function commitForceFor(bot, ctx, facts, text, commitActive, commitStep) {
  // Force gate (revmux 01 core-3): a live window forces a re-decide past
  // the commitment ONLY when the pin would apply right now — feasible +
  // registered, the safety choice from the ordinary menu not a night
  // step — and the body is not already on it. Forcing past a degraded
  // pin (or a safety win) would re-decide every tick for the whole
  // window: a brain.ask per tick plus a stepPick re-stamp each time.
  let commitForce = false
  if (commitActive && ctx.step !== commitStep) {
    try {
      const pinable = !!(MENU[commitStep] && MENU[commitStep].feasible(facts, bot, ctx) && registered(commitStep))
      if (pinable) {
        const safety = goalFsm(facts, menuNames(facts, bot, ctx, text))
        commitForce = safety !== 'stay' && safety !== 'gohome' && safety !== 'shelter'
      }
    } catch (_) {
      commitForce = false
    }
  }
  return commitForce
}

// Return-to-site force. Reads ctx.castleFetch, gocastle feasibility;
// writes nothing.
function siteFarFor(bot, ctx, facts, prev, status, finished, commitStep) {
  // Return-to-site force (idkcraft-vmzq.50): a displacement moves no
  // bucket (the castle word reads the last word off-site), so without
  // the force the castle leg keeps running off-site and the walk back
  // runs the cave-diving far leg (run8). Like night-far it forces a real
  // re-decide — one tick, the menu then holds gocastle to arrival. R1: a running far-fetch leg is
  // exempt (its candidate lies past 64 by design — pre-empting it on
  // commit expiry would loop out-and-back), and a pin on the current
  // step is exempt (the force would re-decide every tick of the window
  // just to re-pick the same step). Lives here (not with the other
  // forces) for the commitStep read.
  let siteFarWalk = false
  try {
    const f = ctx && ctx.castleFetch
    const farLeg = prev === 'castlefetch' && status === 'running' &&
      !!f && !!f.farCandidate && typeof f.farCandidate.x === 'number'
    siteFarWalk = !finished && (prev === 'castle' || prev === 'castlefetch') &&
      !farLeg && commitStep !== prev &&
      !!MENU.gocastle.feasible(facts, bot, ctx)
  } catch (_) { siteFarWalk = false }
  return siteFarWalk
}

// Menu pins for a re-decide. Reads the plan/commit pins and the castle
// re-arm; writes ctx.taskPlanStep (consumed). Returns the menu and which
// pin applied.
function pinMenu(bot, ctx, facts, names, planStep, commitActive, commitStep) {
  // Stall-point plan (vmzq.5): the one-shot forced re-pick — the planned
  // step as the only menu entry. Consumed always (one-shot); applied only
  // while still feasible and registered (a stale answer degrades to the
  // normal menu, never to a broken step). failHolds is bypassed: retrying
  // a held step is the planner's job.
  // vmzq.37: a pickless castle rearm outranks a plan/commit pin like the
  // night steps do — a pinned castle leg cannot dig and wedges again.
  let rearm = false
  try { rearm = picklessCastle(facts, names) } catch (_) { rearm = false }
  let planApplied = false
  if (planStep) {
    try { ctx.taskPlanStep = null } catch (_) { /* consume best-effort */ }
  }
  if (planStep && !rearm) {
    let ok = false
    try {
      ok = !!(MENU[planStep] && MENU[planStep].feasible(facts, bot, ctx) && registered(planStep))
    } catch (_) {
      ok = false
    }
    if (ok) {
      names = [planStep]
      planApplied = true
    }
  }
  // Watchdog commitment (vmzq.21): pin the window's step for the whole
  // window (same-step holds included). Safety first (peer Q2): the
  // safety choice is computed from the ORDINARY menu, and when it is a
  // night step the normal menu runs (chooseStep's night rule picks it)
  // while the window pauses — the commit pins only the work choice.
  let commitApplied = false
  if (!planApplied && commitActive && !rearm) {
    let safety = null
    try {
      safety = goalFsm(facts, names)
    } catch (_) {
      safety = null
    }
    if (safety !== 'stay' && safety !== 'gohome' && safety !== 'shelter') {
      let ok = false
      try {
        ok = !!(MENU[commitStep] && MENU[commitStep].feasible(facts, bot, ctx) && registered(commitStep))
      } catch (_) {
        ok = false
      }
      if (ok) {
        names = [commitStep]
        commitApplied = true
      }
    }
  }
  return { names, planApplied, commitApplied }
}

// Force name for the step line (vmzq.62): the first gate force that
// fired, else the first word force; pure here (the gate side effects
// already ran at their sites above). Read before ctx.goalText moves.
// Writes nothing.
function forceName(bot, ctx, facts, prev, status, text, gateFired) {
  let force = null
  for (const f of FORCES) {
    let hit = false
    try { hit = f.kind === 'gate' ? !!gateFired[f.name] : !!f.fires(prev, facts, ctx, status, bot, text) } catch (_) { hit = false }
    if (hit) { force = f.name; break }
  }
  return force
}

// Apply a choice. Writes ctx.step, the step generation, the fresh-pick
// run resets (ctx.equip, gearRun, castleFetch, gosite, forage, shelter,
// gohome), ctx.stepStatus, ctx.stepPick, ctx.stockpilePierced,
// ctx.goalText, ctx.heldText.
function applyChoice(bot, ctx, facts, choice, prev, finished, why, text) {
  ctx.step = choice.step
  // oqul.7: a new step instance (another step, or a re-pick after the
  // last one finished) drops late completions of the old one's async ops.
  if (choice.step !== prev || finished) nextStepGen(ctx)
  // A fresh equip pick starts with fresh run counters (revmux round-1):
  // stall patience spent by an earlier run must not fail the new one on
  // its first tick. Station claims (claimedTable) live outside ctx.equip
  // and survive. Same-name re-picks were already reset by done/failed.
  if (choice.step === 'equip' && choice.step !== prev) ctx.equip = {}
  if (choice.step === 'gear' && choice.step !== prev) ctx.gearRun = {}
  if (choice.step === 'castlefetch' && choice.step !== prev) ctx.castleFetch = null
  // A fresh return leg restarts its walk (vmzq.50): stall patience spent
  // by an interrupted leg must not fail the new one on arrival day.
  if (choice.step === 'gocastle' && choice.step !== prev) ctx.gosite = null
  // A fresh forage pick restarts the hunt (4dse): a resumed stale
  // find/walk chases the old target id while explore heads elsewhere.
  // The interrupted run's partial haul banks first (sqg2), so the reset
  // drops only the stale target, never the accounting.
  if (choice.step === 'forage' && choice.step !== prev) {
    try { forageMod.bankPartial(bot, ctx) } catch (_) { /* haul best-effort */ }
    ctx.forage = null
  }
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
  // gwvg: status() reads who picked this step and why from the stamp.
  // The step rides along (01 core-2): orders and retreat move ctx.step
  // without re-stamping, and must not inherit the age/source.
  ctx.stepPick = { step: choice.step, source: choice.source, fsm: choice.fsm, why, at: Date.now() }
  // A banking trip picked under the pierce latches for the trip (R4):
  // set on a pick only, and only stockpile's own finish releases it above. A site
  // pick is not a pierce (the site is near by definition), so only a
  // home-branch pick arms it (revmux 02-after-fix major 3).
  if (choice.step === 'stockpile') {
    try { ctx.stockpilePierced = !!homeLegVetoed(bot, ctx, 'stockpile') && !stockpileSiteBranch(facts, bot, ctx) } catch (_) { /* latch best-effort */ }
  }
  ctx.goalText = text
  ctx.heldText = null
}

// Report a choice: metrics, rest reasons, the step log line and chat.
// Writes ctx.restWhy (+ chatStep's own dedup fields).
function noteChoice(bot, ctx, facts, names, choice, prev, status, why, force, text, ms) {
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
    console.log(`goal step=${choice.step} prev=${prev || 'none'} source=${choice.source} fsm=${choice.fsm} why=${why}${why === 'step-failed' ? ` fail=${status}` : ''}${force ? ` force=${force}` : ''} menu=${menu} facts=${text}`)
    if (choice.step === 'rest') {
      chatStep(bot, ctx, `resting: ${ctx.restWhy} (${choice.source})`)
    } else {
      const entry = MENU[choice.step]
      const verb = (entry && entry.verb) || choice.step
      chatStep(bot, ctx, `next: ${verb} (${choice.source})`)
    }
  }
}

// Decision point: re-decide when there is no step, the step finished
// (done/failed:*), or a force fires (FORCES, textForce). The model picks through chooseStep
// at those points only (same dedup as lastStateKey); the return shape stays
// { action, sprint, source: 'goal-fsm' } — the choice source (laya, only-
// option, fsm-fallback) rides the step log line, the next: chat and the
// goal_* metrics, never the decision source. Logs and chats only on a step
// CHANGE, so a running step with steady facts stays silent.
async function decide(bot, ctx) {
  const facts = goalFacts(bot, ctx)
  dayReset(bot, ctx, facts)
  const text = goalText(facts, ctx && ctx.home)
  lowHpClock(bot, ctx, facts)
  const prev = (ctx && ctx.step) || null
  let status = (ctx && ctx.stepStatus) || null
  let finished = isFinished(status)
  // Force probe (vmzq.62): reads status at call time (the gear translation
  // below rewrites it).
  const fires = (name) => FORCE[name].fires(prev, facts, ctx, status, bot, text)
  if (finished && prev === 'gear') {
    const g = gearOutcome(bot, ctx)
    if (g && typeof g === 'object') return g
    if (g) status = g
  }
  recordOutcome(bot, ctx, facts, prev, status, finished, text)
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
  if (!finished && prev && opInFlight(ctx)) {
    return { action: prev, sprint: false, source: 'goal-fsm' }
  }
  // Night forces (ipn.12, table above): they cut through the stickiness.
  let nightFarWalk = false
  let nightNearShelter = false
  try { nightFarWalk = fires('night-far') } catch (_) { nightFarWalk = false }
  try { nightNearShelter = fires('night-near') } catch (_) { nightNearShelter = false }
  const held = stickyHold(bot, ctx, facts, prev, status, finished, nightFarWalk)
  if (held) return held
  const { chainOwns, fetchRetry, gateOpened, buildRetry, siteRetry } = gateForces(fires)
  const pins = readPins(ctx)
  const planStep = pins.planStep
  let { commitStep, commitActive } = pins
  const commitForce = commitForceFor(bot, ctx, facts, text, commitActive, commitStep)
  const siteFarWalk = siteFarFor(bot, ctx, facts, prev, status, finished, commitStep)
  // A finished window step ends the window early (before any re-pick, so
  // the ended choice is never re-pinned below): failed names its reason,
  // done re-measures against the dispatch snapshot.
  const commitEnded = commitActive && finished && prev && prev === commitStep
  // Step commitment (idkcraft-vmzq.4): a text move re-decides a running
  // step only through textForce (a word force, the step left the menu, or
  // the FSM answer moved) — no per-suppressor holds.
  let factsForce = false
  if (prev && !finished && ctx) {
    try { factsForce = textForce(prev, facts, bot, ctx, status, text) } catch (_) { factsForce = ctx.goalText !== text }
  }
  if (!prev || finished || factsForce || chainOwns || nightFarWalk || nightNearShelter || siteFarWalk || fetchRetry || siteRetry || gateOpened || buildRetry || planStep || commitForce) {
    if (commitEnded) {
      try {
        require('./task').commitFinished(bot, ctx, status)
      } catch (_) { /* window best-effort */ }
      commitActive = false
      commitStep = null
    }
    const { names, planApplied, commitApplied } = pinMenu(bot, ctx, facts, menuNames(facts, bot, ctx, text), planStep, commitActive, commitStep)
    const why = planApplied || commitApplied ? 'task-plan' : !prev ? 'start' : finished ? (status === 'done' ? 'step-done' : 'step-failed') : nightFarWalk ? 'night-far' : nightNearShelter ? 'night-near' : siteFarWalk ? 'site-far' : 'facts-changed'
    const gateFired = { chain: chainOwns, 'fetch-retry': fetchRetry, 'gate-opened': gateOpened, 'build-retry': buildRetry, 'site-retry': siteRetry, 'night-far': nightFarWalk, 'night-near': nightNearShelter }
    const force = forceName(bot, ctx, facts, prev, status, text, gateFired)
    const t0 = Date.now()
    const choice = await chooseStep(ctx && ctx.brain, facts, names, ctx && ctx.home)
    if (planApplied || commitApplied) choice.source = 'task-plan'
    const ms = Date.now() - t0
    applyChoice(bot, ctx, facts, choice, prev, finished, why, text)
    noteChoice(bot, ctx, facts, names, choice, prev, status, why, force, text, ms)
  }
  return { action: ctx.step, sprint: false, source: 'goal-fsm' }
}

module.exports = { opInFlight, FORCES, MENU, STEP_ORDER, AUTONOMOUS_EXPLORE_RADIUS, NEED_LOGS, NEED_PLANKS, NEED_PLANKS_V1, needPlanks, timeWord, goalFacts, goalText, goalFsm, decide, chooseStep, shapeGoalMenu, stepWhy, restWhy, failHolds, registered, STEP_CRITERIA, ASK_INSTRUCTIONS, logBucket, plankBucket, siteFor, adoptHome, chatStep, STEP_CHAT_SAME_MS, gatherFailedHolds, CASTLEFETCH_RETRY_MS, FORAGE_RETRY_MS, BUILD_RETRY_MS, LOW_HP_GATE_MS, taskParked, PARK_FORAGE_RADIUS, packFull, homeLegVetoed, stockpileSiteBranch, GOSITE_DIST, displacedFromCastle }
