'use strict'

// Player orders (idkcraft-6x7.1): mechanically moved from index.js — the
// set*-API of the ticker object. Bodies are verbatim except the shared
// closure lets, which go through the box (accessors owned by createTicker).
const { layaUrl } = require('./brain')
const { resolvePlayer } = require('./perception')
const { findNearest, loadedSearchRadius, startFarSearch } = require('./behaviours/scout')
const { clearPendingSearch, startBlockOrder } = require('./chat')
const { CHAT_LIMIT } = require('./commands')
const { verdict } = require('./stuck')
const goal = require('./goal')
const memory = require('./memory')
const metrics = require('./metrics')
const bringMod = require('./behaviours/bring')
const woolMod = require('./behaviours/wool')
const bedMod = require('./behaviours/bed')
const bedsMod = require('./behaviours/beds')
const craftanyMod = require('./behaviours/craftany')
const flatMod = require('./behaviours/flat')
const buildMod = require('./behaviours/build')
const homeMod = require('./behaviours/home')
const taskMod = require('./task')

// How long a recover outcome stays reportable in status (01 body-2): the
// stamp never clears, so without a window every status would cite it.
const LAST_RECOVER_WINDOW_MS = 5 * 60 * 1000

// Chat cap (commands.js CHAT_LIMIT): an overlong status line clips with '…'.
function clipStatus(line) {
  const s = String(line)
  return s.length > CHAT_LIMIT ? s.slice(0, CHAT_LIMIT - 1) + '…' : s
}

function createOrders(box) {
  const { bot, ctx, greet, clearStuck, resetNightStep, startWork, stopOnce, doSetBrain } = box
  return {
    setFollow: (name) => {
      clearPendingSearch(ctx)
      clearStuck()
      resetNightStep()
      if (ctx.bring) { metrics.bring.inc({ outcome: 'cancelled', kind: (ctx.bring && ctx.bring.kind) || 'block' }); ctx.bring = null; bringMod.clearSearchLeg(ctx) }
      ctx.flat = null
      ctx.inShelter = false
      homeMod.releaseMeet(bot, ctx) // inside: the exit legs run before the first follow path (jr2.3)
      ctx.gocastle = null
      const real = resolvePlayer(bot, name)
      box.followName = real
      try { ctx.followName = real || null } catch (_) { /* follow best-effort */ }
      try { memory.save(bot, ctx) } catch (_) { /* memory best-effort */ }
      const seen = !real || (bot.players && bot.players[real] && bot.players[real].entity)
      if (!real || seen) ctx.work = false
      ctx.lastGoalKey = ''
      ctx.lead = null
      ctx.leadTargetGone = 0
      if (real) ctx.paused = false
    },
    // Work mode (epic rw4): autonomous goal steps until follow me / stop.
    work: () => { startWork() },
    // Home site (epic rw4.4): 'build here' and spawn adoption replace the
    // site. Fail counts reset with it — a new origin is a new plan — but
    // given-up cells ride a same-site swap (ipn.10, ybt mirror): a fresh
    // adopt object at the same site keeps the skips. The facts text
    // (home none->site) re-decides.
    home: () => ctx.home || null,
    setHome: (home, opts) => {
      // A standing meet releases against the OLD house first: the exit legs
      // run against the pinned order.home, and the shelter refresh lands in
      // startWork's release right after (revmux 01 core-1). No meet: no-op.
      homeMod.releaseMeet(bot, ctx)
      // Same-site bed claims ride across the swap (idkcraft-ybt): a fresh
      // adopt object at the same site would otherwise drop sleptA until the
      // next sleep. A new site keeps its dropped claims (new bedrooms).
      try { if (home) bedsMod.migrateClaims(ctx.home, home) } catch (_) { /* claims best-effort */ }
      // Same-site skips ride too (ipn.10): indices belong to the site's
      // plan, so only a same site AND version keeps them. An explicit
      // 'build here' (opts.fresh, revmux 01 core-4) re-verdicts even
      // same-site: the owner may have fixed the terrain, so given-up cells
      // re-probe instead of fossilizing.
      const fresh = !!(opts && opts.fresh)
      let keepSkip = []
      try {
        const a = ctx.home
        if (!fresh && a && home && a.site && home.site && a.site.x === home.site.x && a.site.y === home.site.y && a.site.z === home.site.z && (a.v || 1) === (home.v || 1) && Array.isArray(ctx.buildSkip)) keepSkip = ctx.buildSkip.filter((n) => typeof n === 'number')
      } catch (_) { keepSkip = [] }
      let keepAt = {}
      try {
        const at = ctx.buildSkipAt
        if (keepSkip.length && at && typeof at === 'object') {
          for (const n of keepSkip) {
            if (typeof at[n] === 'number') keepAt[n] = at[n]
          }
        }
      } catch (_) { keepAt = {} }
      ctx.home = home || null; ctx.inShelter = false; ctx.buildSkip = keepSkip; ctx.buildSkipAt = keepAt; ctx.buildFails = 0; ctx.buildFailIdx = -1; ctx.buildGoalIdx = -1; ctx.buildFarIdx = -1; try { memory.save(bot, ctx) } catch (_) { /* memory best-effort */ }
      try { taskMod.resetTask(ctx) } catch (_) { /* task reset best-effort */ }
    },
    // Castle project (g0z.3): a new order or 'castle forget' (null). The
    // executor's per-site scratch resets with it; null persists as a drop.
    setCastle: (st) => {
      ctx.castle = st || null
      ctx.gocastle = null
      ctx.castleCursor = 0; ctx.castleScanKey = null; ctx.castleScanAt = 0; ctx.castleFails = null; ctx.castleCell = null; ctx.castleFar = null; ctx.castleGoalIdx = -1; ctx.castleSelfOcc = null; ctx.castleRedig = null; ctx.castleWord = null; ctx.castlePrepSaid = false; ctx.castlePrep = null
      try { if (ctx.stepFail && typeof ctx.stepFail === 'object') delete ctx.stepFail.castle } catch (_) { /* hold best-effort */ }
      try { memory.save(bot, ctx) } catch (_) { /* memory best-effort */ }
      try { taskMod.resetTask(ctx) } catch (_) { /* task reset best-effort */ }
    },
    // Disk memory (idkcraft-hlk): explicit seams for load-before-adopt and
    // save-on-exit; the periodic tick save covers the rest.
    loadMemory: () => { try { return memory.restore(bot, ctx) } catch (_) { return null } },
    saveMemory: () => { try { return memory.save(bot, ctx) } catch (_) { return false } },
    stop: () => {
      clearPendingSearch(ctx)
      clearStuck()
      resetNightStep()
      if (ctx.bring) { metrics.bring.inc({ outcome: 'cancelled', kind: (ctx.bring && ctx.bring.kind) || 'block' }); ctx.bring = null; bringMod.clearSearchLeg(ctx) }
      // ctx.flat survives stop as a parked episode: the next `flat` resumes
      // it instead of re-scanning (w52 resumable job). The parked flag (not
      // just paused) gates the dispatch, so an unrelated order that unparks
      // the body cannot resurrect the job on its own (core-1).
      if (ctx.flat) ctx.flat.parked = true
      ctx.paused = true
      ctx.work = false
      ctx.lead = null
      ctx.leadTargetGone = 0
      ctx.gocastle = null
      stopOnce()
    },
    setLead: (order) => { clearStuck(); resetNightStep(); ctx.gocastle = null; homeMod.releaseMeet(bot, ctx); ctx.lead = order; ctx.leadTargetGone = 0; ctx.paused = false; if (ctx.bring) { metrics.bring.inc({ outcome: 'cancelled', kind: (ctx.bring && ctx.bring.kind) || 'block' }); ctx.bring = null; bringMod.clearSearchLeg(ctx) } },
    clearLead: (player) => {
      // A pending far search dies with the asker (or with the bot, when no
      // player is named) — never with an unrelated player logging off.
      if (!player || (ctx.pendingSearch && ctx.pendingSearch.by === player.username)) clearPendingSearch(ctx)
      const targetName = box.followName || (ctx.lead && ctx.lead.by)
      if (player && targetName && player.username && player.username !== targetName) return
      if (ctx.lead && !player) bot.chat('following you again')
      clearStuck()
      ctx.lead = null
      ctx.leadTargetGone = 0
    },
    getLead: () => ctx.lead,
    cancelGreet: () => { try { greet.cancel(bot) } catch (_) { /* sneak best-effort */ } },
    noteDeath: () => { try { ctx.deaths = (ctx.deaths || 0) + 1 } catch (_) { /* counter best-effort */ } },
    getFollowName: () => box.followName,
    getBrainEngine: () => box.brainEngine,
    setBrain: (b, label) => { doSetBrain(b, label) },
    // Autonomous toggle (dxl): chat lives until container restart, the
    // permanent default is the BOT_AUTONOMOUS env (owner sets it).
    setAutonomous: (on) => {
      ctx.autonomous = !!on
      box.autonomousOverride = !!on
      metrics.autonomous.set(ctx.autonomous ? 1 : 0)
      if (!on) return 'autonomous off'
      let r = 'autonomous on — stays without players until restart (permanent: BOT_AUTONOMOUS env)'
      if (box.brainEngine === 'jev') {
        r += layaUrl()
          ? ' — brain is jev now, laya without players'
          : ' — brain is jev now, off without players (laya not configured)'
      }
      return r
    },
    // Bring-me order creation: find + tool checks answer in this tick (like
    // find-me); the behaviour only walks, digs, returns and tosses.
    // Share (idkcraft-ah9): hand over everything carried except tools,
    // weapons, armour and the 32-block pillar reserve. Same body slot as
    // bring (priority, stop, metrics) with kind 'share'; the behaviour
    // walks to the speaker and tosses, like the bring return.
    setShare: ({ by }) => {
      clearPendingSearch(ctx)
      resetNightStep()
      ctx.gocastle = null
      let items = []
      try {
        items = bot && bot.inventory && typeof bot.inventory.items === 'function' ? bot.inventory.items() : []
      } catch (_) { items = [] }
      const plan = bringMod.sharePlan(items)
      if (plan.length === 0) return 'nothing to share'
      homeMod.releaseMeet(bot, ctx) // inside: the exit legs run before the return walk (jr2.3)
      if (ctx.lead) { ctx.lead = null; ctx.leadTargetGone = 0 }
      ctx.unseenTicks = 0
      ctx.resumeWork = false
      clearStuck()
      ctx.bring = {
        kind: 'share', name: 'share', by, phase: 'return',
        items: plan, saidWaiting: false, announced: true,
      }
      ctx.paused = false
      return null
    },
    setBring: ({ name, want, by }) => {
      clearPendingSearch(ctx)
      resetNightStep()
      ctx.gocastle = null
      if (bringMod.isFoodRequest(name)) {
        if (ctx.lead) { ctx.lead = null; ctx.leadTargetGone = 0 }
        ctx.unseenTicks = 0
        ctx.resumeWork = false
        const n = want || bringMod.WANT_FOOD
        const have = bringMod.findEdible(bot)
        if (have) {
          const give = Math.min(have.count, n)
          clearStuck()
          homeMod.releaseMeet(bot, ctx)
          ctx.bring = {
            kind: 'food', name: 'food', want: n, by, drop: have.name, have: give,
            phase: 'return', saidWaiting: false, announced: true,
          }
          ctx.paused = false
          return `coming with ${give} ${have.name}`
        }
        clearStuck()
        homeMod.releaseMeet(bot, ctx)
        ctx.bring = {
          kind: 'food', name: 'food', want: n, by, drop: null, have: 0,
          phase: bringMod.openPhase(ctx), announced: false, animal: null,
        }
        ctx.paused = false
        return 'looking for animals'
      }
      // Item ladder (did.1): the pack first — the bot may already hold what
      // the player wants, even when the world holds no such block. A short
      // pack still falls through for diggable names: the block path tops up
      // from the chest and mines the rest, as before.
      const resolved = bringMod.resolveItem(bot, name)
      const need = want || bringMod.WANT_ORE
      const plan = resolved ? bringMod.planItemGive(bot, resolved, need) : null
      const worldFallback = resolved ? bringMod.canBringName(bot, name) : false
      const openPackOrder = () => {
        if (ctx.lead) { ctx.lead = null; ctx.leadTargetGone = 0 }
        ctx.unseenTicks = 0
        ctx.resumeWork = false
        clearStuck()
        homeMod.releaseMeet(bot, ctx)
        ctx.bring = {
          kind: 'item', name: resolved.family, names: resolved.names, want: need, by,
          items: plan.items, drop: plan.items[0].name, have: plan.have,
          phase: 'return', saidWaiting: false, announced: true,
        }
        ctx.paused = false
        const desc = plan.items.map((i) => `${i.count} ${i.name}`).join(', ')
        return plan.have >= need ? `coming with ${desc}` : `only ${desc}, coming`
      }
      // A short wool pack falls through to the chest and mob rungs instead
      // of giving partial (did.3): toWoolHunt counts the pack stock toward
      // the want, and the sheep top it up.
      if (plan && plan.have > 0 && (plan.have >= need || (!worldFallback && !woolMod.isWoolFamily(resolved)))) return openPackOrder()
      // Orders carry the canonical family name, so 'beds' reads as 'bed'
      // everywhere. The chest rung runs for every name with no diggable world
      // form — including exact block names like white_wool, dirt or torch.
      const keptName = plan && plan.keptOnly ? resolved.family : null
      if (resolved && !worldFallback && ctx.home && ctx.home.chest) {
        if (ctx.lead) { ctx.lead = null; ctx.leadTargetGone = 0 }
        ctx.unseenTicks = 0
        ctx.resumeWork = false
        clearStuck()
        homeMod.releaseMeet(bot, ctx)
        ctx.bring = {
          kind: 'item', name: resolved.family, names: resolved.names, want: need, by,
          items: [], drop: null, have: 0, packBase: bringMod.packCounts(bot),
          phase: 'chestfetch', announced: true, keptName,
        }
        ctx.paused = false
        return `checking the home chest for ${resolved.family}`
      }
      // Mob rung (did.3): wool the pack and chest could not fill comes
      // from sheep — after the chest rung, before the block path (wool
      // blocks are never diggable, so the block rung cannot serve wool).
      if (resolved && woolMod.isWoolFamily(resolved)) {
        if (ctx.lead) { ctx.lead = null; ctx.leadTargetGone = 0 }
        ctx.unseenTicks = 0
        ctx.resumeWork = false
        clearStuck()
        ctx.bring = bringMod.toWoolHunt(bot, {
          kind: 'item', name: resolved.family, names: resolved.names,
          want: need, by, drop: null, have: 0,
        })
        ctx.paused = false
        const c = ctx.bring.color
        return c ? `looking for ${c} sheep` : 'looking for sheep'
      }
      // Craft rung (did.2): pack mats plus a recipe beat the block search
      // for names with no diggable form — torch resolves as a block but is
      // never bringable, so without this it dies 'ores and logs only'.
      // Uncraftable names fall through to the block path / honest stub.
      // did.4: a ladder-bringable gap opens a sub-order instead of refusing.
      if (resolved && !worldFallback) {
        const cPlan = craftanyMod.planCraft(bot, ctx, bringMod.orderCraftNames(resolved.names), 1)
        if (cPlan.ok) {
          if (ctx.lead) { ctx.lead = null; ctx.leadTargetGone = 0 }
          ctx.unseenTicks = 0
          ctx.resumeWork = false
          clearStuck()
          ctx.craftany = null // a cancelled run must not resume under the new one
          ctx.bring = {
            kind: 'item', name: resolved.family, names: resolved.names, want: need, by,
            items: [], drop: null, have: 0, packBase: bringMod.packCounts(bot),
            phase: 'craft', announced: true, keptName, craftTarget: cPlan.target,
          }
          ctx.paused = false
          return `making you a ${cPlan.target}`
        }
        if (cPlan.fail === 'missing') {
          const miss = Array.isArray(cPlan.missing) ? cPlan.missing : []
          // Smelting first (body-4): a furnace-gated gap refuses up front,
          // before any ladder gap sends the bot gathering for a craft that
          // cannot land.
          const smelt = bringMod.smeltingGap(miss)
          if (smelt) return `need ${smelt} (smelting not part of bring)`
          let sub = null
          if (bedMod.isBedFamily(resolved)) {
            sub = bringMod.bedGap(bot, { names: resolved.names })
          } else if (miss.every((e) => e && bringMod.pickSubGap([e]))) {
            // Every gap rides the ladder, or the gather is wasted (body-4).
            const gap = bringMod.pickSubGap(miss)
            if (gap) sub = { gap, target: cPlan.target, color: woolMod.dropColor(gap.name) }
          }
          if (sub) {
            if (ctx.lead) { ctx.lead = null; ctx.leadTargetGone = 0 }
            ctx.unseenTicks = 0
            ctx.resumeWork = false
            clearStuck()
            ctx.craftany = null
            ctx.bring = {
              kind: 'item', name: resolved.family, names: resolved.names, want: need, by,
              items: [], drop: null, have: 0, packBase: bringMod.packCounts(bot),
              phase: 'craft', announced: true, keptName,
            }
            const line = bringMod.openSubOrder(bot, ctx, ctx.bring, sub.gap, sub.target, sub.color)
            if (line) {
              ctx.paused = false
              return line
            }
            ctx.bring = null // a refused open never leaves a half order behind
          }
          return cPlan.line
        }
        if (cPlan.fail === 'no-table') return cPlan.line
      }
      const res = findNearest(bot, name)
      if (res === 'unknown') {
        if (!resolved) return `unknown item: ${name}`
        // No diggable block, the pack came up short, and no adopted chest:
        // the honest stub (did.2-4 replace its branches).
        return bringMod.itemRefusal(bot, resolved.family, resolved, keptName)
      }
      if (!res) {
        // Sync 48 is empty: the 96/160 shells run sliced across ticks (amb).
        // A null cursor (unreadable world) answers from sync alone — unless
        // an anchor exists, when the order opens and search legs walk (atl.8).
        const search = startFarSearch(bot, name, null, { exposedOnly: true })
        if (search === 'unknown') return `unknown block: ${name}`
        if (!search) {
          if (!bringMod.canSearch(bot, ctx)) {
            // No legs to walk: a short pack still gives instead of refusing.
            if (plan && plan.have > 0) return openPackOrder()
            return `no ${name} within ${loadedSearchRadius(bot)} blocks (loaded area)`
          }
          if (!bringMod.canBringName(bot, name)) return `can't bring ${name} — ores and logs only`
          if (ctx.lead) { ctx.lead = null; ctx.leadTargetGone = 0 }
          ctx.unseenTicks = 0
          ctx.resumeWork = false
          clearStuck()
          homeMod.releaseMeet(bot, ctx)
          ctx.bring = {
            kind: 'block', name, want, by, phase: bringMod.openPhase(ctx),
            have: 0, announced: false, searchSkipFar: true,
          }
          ctx.paused = false
          return `nothing within 48, searching for ${name}…`
        }
        ctx.pendingSearch = { cursor: search, kind: 'bring', name, want, by }
        return `nothing within 48, widening the search for ${name}…`
      }
      const bp0 = bot.entity && bot.entity.position
      if (res.exposed === false && bp0) {
        // No pickaxe tier, no dig and no walk either (harvest needs the
        // tier for both): refuse synchronously so a short pack still hands
        // over — the deferred verdicts below have no plan in scope
        // (revmux 01 core-3). Order mirrors startBlockOrder + fallback.
        if (bringMod.needsPickaxe(res.name) && !bringMod.hasPickaxe(bot, res.name)) {
          clearStuck()
          if (plan && plan.have > 0) return openPackOrder()
          return bringMod.tierRefusal(bot, res.name)
        }
        // Buried 48-best (atl.15): the far shells may see exposed ore and
        // memory may know some — the buried hit is stashed as the dig
        // candidate instead of committing to the shaft at once.
        const buried = bringMod.buriedCand(bp0, res, bot)
        let mem = null
        try { mem = bringMod.memoryExposed(bot, ctx, bp0, name, null) } catch (_) { mem = null }
        mem = bringMod.memoryInBudget(mem, buried)
        const search = startFarSearch(bot, name, null, { exposedOnly: true })
        if (search === 'unknown') return `unknown block: ${name}`
        if (!search) {
          // Edge 48, no shells: decide now; a contested pair opens the
          // order in find so the first (awaited) tick asks the model once.
          // A gated shaft with no exposed rival (chv) is no verdict at all:
          // the order opens in find so the legs hunt diggable ground (or
          // refuse honestly with the vein coords when anchorless).
          if (!mem && !buried) {
            if (ctx.lead) { ctx.lead = null; ctx.leadTargetGone = 0 }
            ctx.unseenTicks = 0
            ctx.resumeWork = false
            clearStuck()
            homeMod.releaseMeet(bot, ctx)
            ctx.bring = {
              kind: 'block', name, want, by, phase: bringMod.openPhase(ctx), have: 0, announced: false,
              deepVein: bringMod.deepVeinOf(bp0, res),
            }
            ctx.paused = false
            return `nearest ${name} too deep to dig, looking for a diggable vein…`
          }
          const d = bringMod.decideBringSource(mem, buried)
          if (!d.contested) {
            clearStuck()
            const win = d.pick === 'buried' ? buried : mem
            const rival = d.pick === 'buried' ? mem : buried
            console.log(bringMod.verdictLine(name, mem, buried, d.pick))
            const prevOrder = ctx.bring
            const answer = startBlockOrder(bot, ctx, { name, want, by }, bringMod.choiceRes(win, rival, bp0))
            if (ctx.bring && ctx.bring !== prevOrder) ctx.bring.verdict = bringMod.verdictFacts(mem, buried, d.pick)
            if (!ctx.bring && plan && plan.have > 0) return openPackOrder()
            return answer
          }
          if (ctx.lead) { ctx.lead = null; ctx.leadTargetGone = 0 }
          ctx.unseenTicks = 0
          ctx.resumeWork = false
          clearStuck()
          homeMod.releaseMeet(bot, ctx)
          ctx.bring = { kind: 'block', name, want, by, phase: 'find', have: 0, announced: false }
          ctx.paused = false
          return `comparing open and buried ${name}…`
        }
        ctx.pendingSearch = { cursor: search, kind: 'bring', name, want, by, buried: res }
        return `only buried ${name} within 48, checking further for open ore…`
      }
      clearStuck()
      const prevDirect = ctx.bring
      const answer = startBlockOrder(bot, ctx, { name, want, by }, res)
      if (ctx.bring && ctx.bring !== prevDirect) {
        const only = bp0 ? bringMod.liveExposed(bp0, res) : null
        console.log(bringMod.verdictLine(name, only, null, 'exposed'))
        ctx.bring.verdict = bringMod.verdictFacts(only, null, 'exposed')
      }
      // A refused block order (pickaxe tier) still gives a short pack.
      if (!ctx.bring && plan && plan.have > 0) return openPackOrder()
      return answer
    },
    setFlat: ({ radius, by, explicit }) => {
      clearPendingSearch(ctx)
      clearStuck()
      resetNightStep()
      ctx.gocastle = null
      homeMod.releaseMeet(bot, ctx) // inside: the exit legs run before the first flat walk (jr2.3)
      if (ctx.lead) { ctx.lead = null; ctx.leadTargetGone = 0 }
      if (ctx.bring) { metrics.bring.inc({ outcome: 'cancelled', kind: (ctx.bring && ctx.bring.kind) || 'block' }); ctx.bring = null; bringMod.clearSearchLeg(ctx) }
      // Center: the player who gave the command, or the bot itself when the
      // speaker is out of tracking range (same honest fallback as build here).
      const speaker = by && bot.players && bot.players[by] && bot.players[by].entity
      const anchor = (speaker && speaker.position) || (bot.entity && bot.entity.position)
      const cx = anchor ? Math.floor(anchor.x) : 0
      const cz = anchor ? Math.floor(anchor.z) : 0
      const yTop = Math.floor(anchor ? anchor.y : 64) + flatMod.SCAN_UP
      const f = ctx.flat
      // Any re-flat from inside the running square resumes with its
      // progress (9k4: a stepped-aside retype used to wipe the run); only
      // a new area or an explicit new radius starts over. Bare `flat`
      // (no radius argument) always means "this job".
      const inside = f &&
        Math.abs(cx - f.cx) <= f.r && Math.abs(cz - f.cz) <= f.r
      if (f && inside && (!explicit || radius === f.r)) {
        f.by = by || f.by
        f.parked = false
        ctx.paused = false
        return flatMod.resumeLine(f)
      }
      ctx.flat = flatMod.startEpisode(cx, cz, radius, yTop, by || 'you')
      ctx.unseenTicks = 0
      ctx.resumeWork = false
      ctx.paused = false
      const size = 2 * radius + 1
      const hint = explicit ? '' : ' (flat 48 for a big field)'
      return `scanning ${size}x${size} for holes…${hint}`
    },
    // 'Come home' order (jr2.3): drop follow/work and wait in the common
    // room until countermanded. Refuses honestly without a built home
    // (adopting a standing house first, like the work tick); a repeat
    // re-arms fresh, so stop/retype can never hang the phase.
    setComehome: ({ by }) => {
      let home = ctx.home
      if (!home || !home.site) {
        let found = null
        try { found = goal.adoptHome(bot) } catch (_) { found = null }
        if (!found) return 'no home yet — say build here'
        home = found
      }
      // A stale unbuilt flag (adopted mid-build or mid-repair, then finished
      // without the build step ever flipping it) re-validates against THIS
      // site's plan, silently: adopting here would announce the wrong house
      // when 'build here' just moved. Skips never count (idkcraft-vmzq.10):
      // a hole-y house refuses like any unfinished one.
      if (!home.built) {
        let complete = false
        try {
          complete = buildMod.isComplete(bot, home)
        } catch (_) { complete = false }
        if (!complete) return 'home not built yet — say go work'
        home.built = true
        try { memory.save(bot, ctx) } catch (_) { /* memory best-effort */ }
      }
      clearPendingSearch(ctx)
      clearStuck()
      resetNightStep()
      if (home !== ctx.home) {
        ctx.home = home; ctx.buildSkip = []; ctx.buildSkipAt = {}; ctx.buildFails = 0; ctx.buildFailIdx = -1; ctx.buildGoalIdx = -1; ctx.buildFarIdx = -1
        try { memory.save(bot, ctx) } catch (_) { /* memory best-effort */ }
      }
      if (ctx.bring) { metrics.bring.inc({ outcome: 'cancelled', kind: (ctx.bring && ctx.bring.kind) || 'block' }); ctx.bring = null; bringMod.clearSearchLeg(ctx) }
      if (ctx.lead) { ctx.lead = null; ctx.leadTargetGone = 0 }
      if (ctx.flat) ctx.flat.parked = true
      // A mode change away from follow revokes the held order with its disk
      // copy (startWork precedent): a restart must not resurrect a follow
      // the owner cancelled for the meet.
      const held = box.followName
      box.followName = ''
      if (held) {
        try { ctx.followName = null } catch (_) { /* follow best-effort */ }
        try { memory.save(bot, ctx) } catch (_) { /* memory best-effort */ }
      }
      ctx.work = false
      ctx.paused = false
      ctx.unseenTicks = 0
      ctx.resumeWork = false
      ctx.lastGoalKey = ''
      ctx.stepStatus = 'running'
      let inside = false
      try { inside = homeMod.isInside(bot, ctx.home) } catch (_) { inside = false }
      const prior = ctx.comehome
      ctx.gocastle = null
      ctx.comehome = homeMod.startMeet(by, inside, home)
      // Re-ordered mid-exit after 'build here' swapped the house: the fresh
      // order keeps exiting the pinned old house, then reseeks the current
      // home instead of releasing — a fresh walk from inside the old walls
      // would plan through them (revmux 01 core-1).
      if (prior && prior.exiting && prior.home && !inside) {
        ctx.comehome.exiting = true
        ctx.comehome.phase = 'open'
        ctx.comehome.home = prior.home
        ctx.comehome.reseek = true
        ctx.comehome.settle = false
        ctx.inShelter = true
      }
      return 'coming home'
    },
    // 'Go castle' order (idkcraft-3qia): walk to the castle entrance and hold there.
    setGocastle: ({ by }) => {
      const st = ctx.castle
      if (!st || !st.site) return 'no castle yet — say build castle'
      clearPendingSearch(ctx)
      clearStuck()
      resetNightStep()
      if (!ctx.comehome && homeMod.isInside(bot, ctx.home)) {
        ctx.comehome = homeMod.startMeet(by, true, ctx.home)
      }
      homeMod.releaseMeet(bot, ctx)
      if (!(ctx.comehome && ctx.comehome.exiting)) ctx.comehome = null
      if (ctx.bring) { metrics.bring.inc({ outcome: 'cancelled', kind: (ctx.bring && ctx.bring.kind) || 'block' }); ctx.bring = null; bringMod.clearSearchLeg(ctx) }
      if (ctx.lead) { ctx.lead = null; ctx.leadTargetGone = 0 }
      if (ctx.flat) ctx.flat.parked = true
      const held = box.followName
      box.followName = ''
      if (held) {
        try { ctx.followName = null } catch (_) { /* follow best-effort */ }
        try { memory.save(bot, ctx) } catch (_) { /* memory best-effort */ }
      }
      ctx.work = false
      ctx.paused = false
      ctx.unseenTicks = 0
      ctx.resumeWork = false
      ctx.lastGoalKey = ''
      ctx.stepStatus = 'running'
      ctx.gocastle = {
        by: by || 'you',
        castle: st,
        phase: 'walk',
        stalls: 0,
        fails: 0,
        lastPos: null,
      }
      return 'going to castle'
    },
    status: () => {
      const facts = goal.goalFacts(bot, ctx)
      const flatParked = ctx.flat && ctx.flat.parked
      const mode = ctx.gocastle ? 'going to castle' : (ctx.comehome ? 'coming home' : (ctx.bring ? 'bringing' : (ctx.flat && !ctx.flat.parked && !ctx.paused && !ctx.lead ? 'flattening' : (ctx.work ? 'working' : (ctx.lead ? 'leading' : ((ctx.paused || flatParked) ? (ctx.flat ? 'parked (flat paused)' : 'parked') : 'following'))))))
      const tail = `logs=${facts.logs} planks=${facts.planks} home=${facts.home}`
      const lines = []
      if (mode === 'following') {
        // The brain's follow/fight/roam/idle share the idle lease by design
        // (body.js), so the lease owner cannot name the mode — derive it.
        const owner = ctx.body && ctx.body.owner
        const bodyName = (!owner || owner === 'idle') ? 'follow' : owner
        const src = (ctx.lastDecision && ctx.lastDecision.source) || 'none'
        lines.push(`following body=${bodyName} source=${src} ${tail}`)
      } else {
        const step = ctx.step || 'none'
        const entry = goal.MENU[step]
        const verb = entry && entry.verb
        const flatActive = ctx.flat && !ctx.flat.parked ? ctx.flat : null
        const order = ctx.gocastle || ctx.comehome || ctx.bring || flatActive || ctx.lead
        const phase = order && typeof order.phase === 'string' && order.phase ? ` phase=${order.phase}` : ''
        let line = `${mode}${phase} body=${(ctx.body && ctx.body.owner) || 'none'} step=${step}`
        if (verb) line += ` (${verb})`
        if (ctx.stepStatus) line += ` ${ctx.stepStatus}`
        // The stamp belongs to its own step only (01 core-2).
        const pick = ctx.stepPick && ctx.stepPick.step === step ? ctx.stepPick : null
        if (pick && typeof pick.at === 'number') line += ` ${Math.max(0, Math.floor((Date.now() - pick.at) / 1000))}s`
        if (pick && pick.source) line += ` — by ${pick.source} (${pick.why || 'unknown'})`
        // Facts ride ahead of the reasons: a long skipped/resting tail clips first.
        line += ` ${tail}`
        if (step === 'rest') {
          // atl.7: a resting bot names the reason decide() stored, if any.
          if (ctx.restWhy) line += ` resting because ${ctx.restWhy}`
        } else if (goal.STEP_ORDER.includes(step)) {
          // Higher-priority steps this pick skipped, with their reasons.
          // Shared with the L1 diagnosis (task.js).
          try {
            const text = goal.goalText(facts, ctx.home)
            const sk = taskMod.skippedReason(bot, ctx, facts, text, step)
            if (sk) line += `; ${sk}`
          } catch (_) { /* skipped best-effort */ }
        }
        lines.push(line)
      }
      // Task line (vmzq.2): active build task with its stall, when one exists.
      try {
        const tl = taskMod.taskLine(ctx)
        if (tl) lines.push(tl)
      } catch (_) { /* task line best-effort */ }
      // Park line (vmzq.3): the parked task with the diagnosis it parked
      // with (persisted on the episode, so it survives a restart).
      try {
        const cEp = ctx.castle && ctx.castle.taskPark
        const hEp = ctx.home && ctx.home.taskPark
        if (cEp && cEp.diag) lines.push(`parked castle: ${cEp.diag}`)
        else if (hEp && hEp.diag) lines.push(`parked house: ${hEp.diag}`)
      } catch (_) { /* park line best-effort */ }
      // Line 2, only when something is wrong: holds, stuck, recovery, path, last outcome.
      const wrong = []
      try {
        // Only live holds read as blocked (01 core-1). Shared with task.js.
        const text = goal.goalText(facts, ctx.home)
        const bl = taskMod.blockedReason(bot, ctx, facts, text)
        if (bl) wrong.push(bl)
      } catch (_) { /* blocked best-effort */ }
      let stuckState = 'MOVING'
      try { stuckState = verdict(ctx).state || 'MOVING' } catch (_) { /* moving default */ }
      if (stuckState !== 'MOVING') wrong.push(`stuck=${stuckState}`)
      const rec = ctx.recovery
      if (rec && rec.action) wrong.push(rec.status ? `recovering=${rec.action}/${rec.status}` : `recovering=${rec.action}`)
      // Only abnormal verdicts (the stuck.js terminal set): a healthy bot
      // holds path=success all session (01 body-2).
      if (ctx.lastPathStatus === 'noPath' || ctx.lastPathStatus === 'timeout') wrong.push(`path=${ctx.lastPathStatus}`)
      const lr = ctx.lastRecover
      if (lr && lr.action && typeof lr.at === 'number' && Date.now() - lr.at <= LAST_RECOVER_WINDOW_MS) {
        const ago = typeof lr.at === 'number' ? ` ${Math.max(0, Math.floor((Date.now() - lr.at) / 1000))}s ago` : ''
        wrong.push(`last recover: ${lr.action} ${lr.outcome || 'unknown'}${ago}`)
      }
      if (wrong.length > 0) lines.push(wrong.join('; '))
      for (const l of lines) bot.chat(clipStatus(l))
    }
  }
}

module.exports = { createOrders }
