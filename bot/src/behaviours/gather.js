'use strict'

const { goals } = require('mineflayer-pathfinder')
const stuck = require('../stuck')
const bring = require('./bring')
const resources = require('../resources')
const danger = require('../danger')
const blueprint = require('../castle')
const exploreMod = require('./explore')
const { startFarSearch, stepFarSearch, keyOf } = require('./scout')
const { NEED_LOGS, gatherFailedHolds } = require('../goal')
const { countItems } = require('../perception')
const { say, clearGoal, denyReason, logDeny, protectedReason } = require('./util')
const Vec3 = require('vec3')

// gather: chop the nearest trees until NEED_LOGS logs are on hand. One
// function, same shape as lead.js/roam.js; registered in BEHAVIOURS under
// 'gather' so the goal arbiter can pick it. Reports via ctx.stepStatus.
// No mineflayer-collectblock: GoalNear walks the bot next to the log and
// bot.dig does the rest. NOT GoalBreakBlock: in the pinned pathfinder 2.4.5
// its isEnd() calls the inner goal without the node and builds it with the
// bot as the world, so the first executor tick throws and kills the process
// (reproduced); GoalNear range 2 stops inside dig reach with pure math.
// Upper logs: the executor pillars on its own — movements.scafoldingBlocks
// already defaults to the kit dirt/cobblestone, the only kit use allowed.
// Foliage is never a target (matching is *_log only).
// ponytail: if the pathfinder ever starts chewing through its own future
// house, gate the blueprint blocks via movements.blocksCantBreak (bead .4).
const FIND_RADIUS = 48
const FIND_COUNT = 256 // g0z.12: 70 castle beams must not crowd out the nearest real trees
const STALL_TICKS = 10 // no-displacement walk ticks before a tree is skipped
const REISSUE_TICKS = 2 // idle-executor no-displacement ticks before the walk
// goal is refreshed (idkcraft-6x7.14): the executor stands with ZERO
// controls when its walk simulation fails the near path (a drop it cannot
// straight-line at a tree ledge/canopy) and its only recourse is the 3.5 s
// futility timer — reset=stuck, rig-counted — followed by a replan that
// walks free. A refresh from the live stance/world within the timer's
// window delivers that replan uncounted. 1 would false-fire on plan
// latency (the first step lands after the issue tick); 3 risks losing the
// race to the 3.5 s timer. One credit per stall episode (progress
// re-arms): a fall or dig restales the plan suffix mid-walk, so the same
// tree can wedge twice. A true wedge still grinds into the legacy budget
// below (fewer counted resets, same skip); a hobble gets replans that may
// fix it.
const UNREACHABLE_FAILS = 3 // consecutive skips before failed:unreachable
const CROWN_SKIP_RADIUS = 3 // horizontal blocks, strict: one strike per tree,
// not per column — acacia crowns branch into neighbouring x,z-columns, while
// trunks a full 3 blocks apart still count as different trees
const PROGRESS_INTERVAL_MS = 10_000 // same cadence as lead.js progress lines
// idkcraft-m7ke: a log this far above the feet needs a climb; with no
// scaffold a terminal planner verdict (noPath/timeout) on it is a cliff,
// not a long walk — strike the tree at once instead of stalling into a
// recover episode (sidestep/wait cannot raise the body).
// ponytail: a +3 tree up a long walkable slope that times out is dropped
// too; it only costs that tree (scaffold=0 only), the next one is tried.
const CLIFF_DY = 3

function scaffoldCount(bot) {
  return countItems(bot, (n) => n === 'dirt' || n === 'cobblestone')
}


function dist(a, b) {
  if (a && typeof a.distanceTo === 'function') return a.distanceTo(b)
  if (b && typeof b.distanceTo === 'function') return b.distanceTo(a)
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)
}

function logNames(bot) {
  const byName = (bot.registry && bot.registry.blocksByName) || {}
  return Object.keys(byName).filter((n) => n.endsWith('_log'))
}

function logIds(bot) {
  const byName = (bot.registry && bot.registry.blocksByName) || {}
  const ids = []
  for (const name of Object.keys(byName)) {
    if (!name.endsWith('_log')) continue
    const entry = byName[name]
    if (entry && typeof entry.id === 'number' && !ids.includes(entry.id)) ids.push(entry.id)
  }
  return ids
}



// Walk/dig reads need a real Vec3: real mineflayer blockAt throws on a
// plain object (WorldSync.getBlock calls pos.floored()), which reads as
// an unloaded chunk and stalls a memory hike into 'failed:unreachable'
// at the trees (idkcraft-t9u, the same flaw as bring's t9k). Every
// gather target routes through here, so normalize once; live hits pass
// through untouched.
function asVec3(p) {
  if (!p || typeof p.floored === 'function') return p
  return new Vec3(p.x, p.y, p.z)
}

// Commit a walk target: shared init for the sync-48 hit, a resource-memory
// point and a far-search hit. far marks a fallback origin: if it reads back
// as gone, the point joins skip so the next fallback takes another, not it.
function commitTarget(g, bp, p, name, far) {
  g.pos = asVec3(p)
  g.name = name || 'log'
  g.far = !!far
  g.lastFound = [p]
  g.phase = 'walk'
  g.stalls = 0
  g.restalls = 0 // 6x7.14: the re-issue counter, per tree like the budget
  g.reissued = false
  g.issuedKey = null // fresh search, fresh budget (see walk re-issue below)
  g.lastPos = { x: bp.x, y: bp.y, z: bp.z }
}


// The executor making progress (a dig or place in flight) is never a
// stall, even with no displacement: the re-issue below must not interrupt
// real work. Defensive: older mocks and the e2e fake carry no isMining.
// (6x7.14: the legacy STALL_TICKS budget intentionally still counts these —
// only the re-issue trigger is gated, so the yvi/68p pins hold.)
function execBusy(bot) {
  try {
    const pf = bot && bot.pathfinder
    if (!pf) return false
    return (typeof pf.isMining === 'function' && pf.isMining()) ||
      (typeof pf.isBuilding === 'function' && pf.isBuilding())
  } catch (_) { return false }
}

function bodyPos(bot) {
  try {
    const p = bot && bot.entity && bot.entity.position
    if (p && typeof p.x === 'number' && typeof p.z === 'number') return { x: p.x, y: p.y, z: p.z }
  } catch (_) { /* unknown body: no point */ }
  return null
}

// Own-work bound (idkcraft-vmzq.19): while a build task is active (castle
// ordered, or a house sited but unbuilt) a remembered tree past the task
// radius is not walked to — prod hiked 500 blocks to home-ground memory.
// Live and far search stay bot-centered (a march kits up where it stands);
// only memory crosses the map. This step is always own work (there is no
// owner gather order), so no owner exemption applies.
function taskFar(ctx, it) {
  try {
    if (!exploreMod.taskActive(ctx)) return false
    const a = exploreMod.anchorOf(null, ctx)
    if (!a || typeof a.x !== 'number' || !it || typeof it.x !== 'number') return false
    return Math.hypot(it.x - a.x, it.z - a.z) > (exploreMod.TASK_SEARCH_RADIUS || 64)
  } catch (_) {
    return false
  }
}

function failFinal(bot, ctx, g, logs, final) {
  g.final = final
  g.atLogs = logs
  g.failPos = bodyPos(bot)
  ctx.stepStatus = g.final
  say(bot, g.final === 'failed:no-trees' ? 'no trees within 48 blocks' : g.final === 'failed:pack-full' ? 'pack full, banking first' : 'cannot reach the trees')
  clearGoal(bot, ctx)
}

function gather(bot, ctx, target, state) {
  const logs = countItems(bot, (n) => n.endsWith('_log'))
  if (!ctx.gather) ctx.gather = { pos: null, name: 'log', phase: 'walk', skip: new Set(), gskip: new Set(), streak: 0, final: null, atLogs: -1, lastProgressAt: Date.now() }
  const g = ctx.gather
  // A finished attempt stays finished until the world changes (log count):
  // decide() re-picks the step with status 'running', so re-assert here
  // instead of rescanning and re-chatting every tick.
  if (g.final) {
    let keepSkip = false
    if (g.atLogs === logs && typeof g.final === 'string' && g.final.startsWith('failed:') && !gatherFailedHolds(g, logs, bot)) {
      // Relocated past the failure point (idkcraft-gyw): the menu hold
      // already releases there, and new ground may hold nearer trees or
      // other wood — retry fresh instead of replaying the far failure
      // until a log count that only gather can change. (The release latch
      // re-arms on relocation inside stuck.js; per-tree keys scope it.)
      // atLogs=-1 rides the world-changed reset below (final, streak);
      // the searchfar phase resets so the fresh sync-48 scan runs before
      // any new far search. Struck skips SURVIVE the release (revmux
      // core-2): the retry scans for untried trees, never re-walks the
      // same unreachable crown — drops-landed still clears once anything
      // is chopped.
      g.atLogs = -1
      g.failPos = null
      g.phase = 'walk'
      g.search = null
      keepSkip = true
    }
    if (g.atLogs === logs) {
      ctx.stepStatus = g.final
      clearGoal(bot, ctx) // no-op once null (acceptance: no setGoal past final)
      return
    }
    g.final = null
    if (!keepSkip) g.skip.clear()
    g.streak = 0
  }
  if (logs >= NEED_LOGS) {
    g.final = 'done'
    g.atLogs = logs
    ctx.stepStatus = 'done'
    say(bot, `got ${NEED_LOGS} logs`)
    clearGoal(bot, ctx)
    return
  }
  const bp = bot.entity && bot.entity.position
  if (!bp) return
  // mnx pit memory: no target within a gave-up spot's radius.
  // g0z.12: laid castle beams (v2 frame cells) are logs the castle owns —
  // never a tree target (dig-time protection would refuse them only after
  // the walk, and a castle frame fetch starts right next to them).
  const castleBeam = (p) => {
    if (!ctx.castle) return false
    try {
      const b = bot.blockAt(new Vec3(p.x, p.y, p.z))
      return blueprint.protects(ctx.castle, p, b && b.name)
    } catch (_) { return false }
  }
  const banned = (p) => danger.near(ctx, p) || castleBeam(p)
  if (!g.pos) {
    // A running staged search resolves before any new sync scan: the 48
    // below stays empty while the 96/160 shells stream in across ticks.
    if (g.phase === 'searchfar') {
      // Skipped trunks and the sync-48 shell must neither stop the search
      // nor win it: the point of going far is trees the sync scan rejected.
      const exclude = (q) => g.skip.has(keyOf(q)) || (g.gskip && g.gskip.has(keyOf(q))) || dist(q, bp) <= FIND_RADIUS || banned(q)
      const r = stepFarSearch(bot, g.search, { exclude })
      if (!r.done) return
      g.search = null
      const hit = r.result && r.result !== 'unknown' ? r.result : null
      if (hit && hit.position && !exclude(hit.position)) {
        commitTarget(g, bp, hit.position, hit.name, true)
        say(bot, `going for ${g.name}, ${Math.round(dist(g.pos, bp))} blocks away`)
      } else {
        failFinal(bot, ctx, g, logs, g.farUnreachable ? 'failed:unreachable' : 'failed:no-trees')
      }
      return
    }
    let found = []
    try {
      found = bot.findBlocks({ matching: logIds(bot), maxDistance: FIND_RADIUS, count: FIND_COUNT }) || []
    } catch (_) { found = [] }
    const open = found.filter((p) => !g.skip.has(keyOf(p)) && !(g.gskip && g.gskip.has(keyOf(p))) && !banned(p))
    // Nearest log the guard allows (idkcraft-m7ke): a protected log (decor,
    // an acacia branch with no column) is never walked to — it joins the
    // sticky gskip here instead of after the trip, when the dig refuses it.
    // ponytail: protectedReason per candidate nearest-first, stopping at the
    // first allowed one; each decor log costs one check, once (gskip).
    open.sort((a, b) => dist(a, bp) - dist(b, bp))
    let best = null
    let name = 'log'
    for (const p of open) {
      let b = null
      try { b = bot.blockAt && bot.blockAt(p) } catch (_) { b = null }
      if (b && protectedReason(bot, b, ctx) === 'protected') {
        logDeny(b, 'protected')
        if (!g.gskip) g.gskip = new Set()
        g.gskip.add(keyOf(p))
        continue
      }
      best = p
      name = (b && b.name) || 'log'
      break
    }
    if (best) {
      commitTarget(g, bp, best, name, false)
      g.lastFound = open.filter((p) => !(g.gskip && g.gskip.has(keyOf(p))))
    } else if (open.length > 0) {
      return // all protected, now in gskip: the next tick takes memory/far
    } else {
      // atl.5: the sync 48 is empty — next tree from resource memory
      // (atl.1) or the amb staged far search, before any final.
      const names = logNames(bot)
      // Nearest unskipped log: one skipped memory point must not hide the
      // rest (the bead's unreachable case: trunk at 40 skipped, log at 200
      // remembered).
      const mem = names.length > 0
        ? resources.nearest(ctx, bp, names, (it) => g.skip.has(keyOf(it)) || (g.gskip && g.gskip.has(keyOf(it))) || banned(it) || taskFar(ctx, it))
        : null
      if (mem) {
        commitTarget(g, bp, { x: mem.x, y: mem.y, z: mem.z }, mem.name, true)
        say(bot, `going for ${g.name}, ${Math.round(dist(g.pos, bp))} blocks away`)
      } else {
        let search = null
        try { search = startFarSearch(bot, 'logs') } catch (_) { search = null }
        if (search && search !== 'unknown') {
          g.search = search
          g.phase = 'searchfar'
          g.farUnreachable = found.length > 0
          return
        }
        failFinal(bot, ctx, g, logs, found.length === 0 ? 'failed:no-trees' : 'failed:unreachable')
        return
      }
    }
  }
  if (logs > 0 && g.skip.size > 0 && logs !== g.seenLogs) {
    // Drops landed: the world changed, old skips may be stale.
    g.skip.clear()
    g.streak = 0
  }
  g.seenLogs = logs
  // Progress line only when the count grew (68p): repeating 'chopping
  // 6/14' every 10 s with no new log reads as a hang.
  if (logs > 0 && logs !== g.progressLogs && Date.now() - (g.lastProgressAt || 0) >= PROGRESS_INTERVAL_MS) {
    g.lastProgressAt = Date.now()
    g.progressLogs = logs
    say(bot, `chopping ${g.name} ${logs}/${NEED_LOGS}`)
  }
  if (g.phase === 'walk') {
    const key = `gather:${g.pos.x},${g.pos.y},${g.pos.z}`
    if (key !== ctx.lastGoalKey) {
      bot.pathfinder.setGoal(new goals.GoalNear(g.pos.x, g.pos.y, g.pos.z, 2), false)
      // Only a verdict that arrives AFTER this issue judges this target
      // (forage.js attribution).
      ctx.lastPathStatus = 'none'
      const prevKey = ctx.lastGoalKey
      ctx.lastGoalKey = key
      if (key !== g.issuedKey || prevKey === '' || prevKey === 'idle') {
        // Another trunk (or an explicit fresh start): fresh stall budget.
        // The SAME trunk retaken after a fight/bring tick stole the body
        // (68p) only re-issues the stolen goal above — stalls and lastPos
        // survive, and the walk continues below this same tick.
        g.issuedKey = key
        g.stalls = 0
        g.lastPos = { x: bp.x, y: bp.y, z: bp.z }
        return
      }
    }
    let block = null
    try { block = bot.blockAt && bot.blockAt(g.pos) } catch (_) { block = null }
    // Unloaded (blockAt null) is not gone: a memory/far point past view
    // keeps its walk while chunks stream in, with stall counting below as
    // the backstop. Only a loaded non-log is stale — it joins skip so the
    // next fallback takes another, not it.
    const unloadedFar = !block && g.far && g.pos
    if (!unloadedFar && (!block || !block.name || !block.name.endsWith('_log'))) {
      if (g.far && g.pos) g.skip.add(keyOf(g.pos))
      g.pos = null // chopped by someone else (reads back as air): search again
      g.far = false
      return
    }
    if (!bot.pathfinder.isMoving()) {
      let diggable = true
      try { diggable = typeof bot.canDigBlock === 'function' ? bot.canDigBlock(block) : true } catch (_) { diggable = false }
      if (diggable) {
        g.phase = 'dig'
        g.block = block
      }
    }
    if (g.phase === 'walk') {
      // Stall by displacement, not isMoving (follow.js wedge lesson: a
      // wedged executor keeps reporting moving while the body stands still).
      const grounded = !bot.entity || bot.entity.onGround !== false
      // A place_error streak with no displacement counts as a stall too
      // (yvi): the streak is the central detector's, read via the verdict.
      const verdict = ctx.lastPathStatus
      // An unloaded memory/far point times out by construction (A* sees no
      // cells there): the stall backstop judges it, not the verdict.
      const cliff = !unloadedFar && (verdict === 'noPath' || verdict === 'timeout') &&
        g.pos.y - bp.y >= CLIFF_DY && scaffoldCount(bot) === 0
      if (!cliff && bring.progressed(bp, g.lastPos, grounded)) {
        g.stalls = 0
        g.restalls = 0
        g.reissued = false // progress re-arms the refresh credit
        g.lastPos = { x: bp.x, y: bp.y, z: bp.z }
      } else if (cliff || ++g.stalls >= STALL_TICKS || stuck.verdict(ctx).placeErrors >= stuck.PLACE_ERRORS_ENTRY) {
        if (cliff) console.log(`gather: ${g.name} at ${g.pos.x} ${g.pos.y} ${g.pos.z} is ${Math.round(g.pos.y - bp.y)} up, no scaffold (${verdict}): next tree`)
        // One strike per tree, not per log or column: a stalled trunk's
        // mates would each burn 10 ticks and a strike, failing the step with
        // reachable trees nearby — and an acacia crown branches into
        // neighbouring x,z-columns, so skip the whole crown at once.
        // Crown-only on purpose (6x7.13 reverts kl19's steep-everywhere
        // strike): skipping N crowns on one verdict clears the area below
        // the UNREACHABLE_FAILS tripwire, so gather roams far instead of
        // refusing (GATHER-CLIFF stuck 21, TIMEOUT).
        for (const q of g.lastFound || []) {
          if (Math.hypot(q.x - g.pos.x, q.z - g.pos.z) < CROWN_SKIP_RADIUS) g.skip.add(keyOf(q))
        }
        g.skip.add(keyOf(g.pos))
        g.streak = (g.streak || 0) + 1
        g.pos = null
        if (g.streak >= UNREACHABLE_FAILS) {
          g.final = 'failed:unreachable'
          g.atLogs = logs
          g.failPos = bodyPos(bot)
          ctx.stepStatus = g.final
          say(bot, 'cannot reach the trees')
          clearGoal(bot, ctx)
          // One escape at the final through stuck.request (core-1: skips
          // reset the central stills, so a trunk wedge got no episode).
          // Per-tree key: the release latch scopes per situation. A cliff
          // strike is no wedge (m7ke): the body is free, the trees are up —
          // no episode, no danger mark on open ground.
          if (!cliff) stuck.request(bot, ctx, 'gather',
            g.lastFound && g.lastFound[0] ? { x: g.lastFound[0].x, y: g.lastFound[0].y, z: g.lastFound[0].z } : null,
            key)
        }
      } else if (!unloadedFar && !execBusy(bot) && !g.reissued && stuck.verdict(ctx).placeErrors === 0 &&
          (g.restalls = (g.restalls | 0) + 1) >= REISSUE_TICKS) {
        // 6x7.14: one refresh per stall episode, same target (see
        // REISSUE_TICKS). The legacy budget above counts through it (68p
        // pin: the skip still lands on tick 10), so this only ever
        // advances the replan, never the give-up. Same key (issuedKey
        // untouched): the next tick keeps counting instead of taking a
        // fresh budget. No refresh inside a place_error streak (revmux 01
        // minor): the setGoal would emit goal_updated and zero the yvi
        // streak the fast skip is judging — that detector owns the storm.
        g.reissued = true
        g.restalls = 0
        bot.pathfinder.setGoal(new goals.GoalNear(g.pos.x, g.pos.y, g.pos.z, 2), false)
        ctx.lastPathStatus = 'none' // the next verdict judges the fresh plan
      }
      return
    }
  }
  if (g.phase === 'dig') {
    // Exactly one dig at a time: while it is in flight, wait (mutation:
    // digging every tick breaks the executor and the count).
    if (ctx.digInFlight) return
    if (typeof bot.dig !== 'function') {
      g.skip.add(keyOf(g.pos))
      g.pos = null
      return
    }
    // Reserved slot (g0z.26 R2): the pack stops growing at PACK_RESERVE
    // with no adopted chest and nobody online — the last slot is the
    // bootstrap chest craft's room. No quest exemption (forage runs it);
    // the log-count hold below releases when the stockpile banks.
    let reserved = false
    try { reserved = !!require('./stockpile').slotReserved(bot, ctx) } catch (_) { reserved = false }
    if (reserved) {
      failFinal(bot, ctx, g, logs, 'failed:pack-full')
      return
    }
    const gDeny = denyReason(bot, g.block, ctx) // idkcraft-drq: placed logs are not trees
    if (gDeny) {
      logDeny(g.block, gDeny)
      g.skip.add(keyOf(g.pos))
      // 'protected' is a property of the block, not of the trip: it
      // survives the drop-landed clear below, or the bot re-walks to the
      // same owner log after every chopped log. Trap denials
      // (below-feet/gravity) depend on the stance and stay in g.skip.
      if (gDeny === 'protected') {
        if (!g.gskip) g.gskip = new Set()
        g.gskip.add(keyOf(g.pos))
      }
      g.pos = null
      return
    }
    ctx.digInFlight = true
    const block = g.block
    const run = async () => {
      try { await bot.dig(block) } catch (_) { /* gone or interrupted: pickup anyway */ }
      ctx.digInFlight = false
      g.phase = 'pickup'
    }
    void run()
    return
  }
  if (g.phase === 'pickup') {
    const key = `gather-pickup:${g.pos.x},${g.pos.y},${g.pos.z}`
    if (key !== ctx.lastGoalKey) {
      bot.pathfinder.setGoal(new goals.GoalBlock(g.pos.x, g.pos.y, g.pos.z), false)
      ctx.lastGoalKey = key
      return
    }
    // Reached or gave up getting there: the drop is picked up by proximity
    // and the inventory count is the truth — move to the next tree.
    g.pos = null
    g.phase = 'walk'
  }
}

module.exports = gather
