'use strict'

const { goals } = require('mineflayer-pathfinder')
const stuck = require('../stuck')
const bring = require('./bring')
const resources = require('../resources')
const danger = require('../danger')
const blueprint = require('../castle')
const exploreMod = require('./explore')
const { startFarSearch, stepFarSearch, keyOf } = require('./scout')
const { NEED_LOGS } = require('../budget')
const { gatherFailedHolds } = require('../holds')
const { countItems } = require('../perception')
const { say, clearGoal, issueGoal, denyReason, logDeny, protectedReason, inHouseFootprint } = require('./util')
const buildMod = require('./build')
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
// idkcraft-p9lx: far walk-out dusk guard. A >64-block walk-out started near
// dusk or at night cannot work a load and return before dark: dusk catches
// the bot mid-map and the night is sheltered in the open (rig: a day
// creeper kill 127 blocks out and a night shelter kill 134 out, 8 deaths,
// never 14 logs — each death wipes the partial load, so beds:no-planks
// never clears). Distance is anchor-measured (home): far/memory targets
// past 64 commit only in open daylight, and any walk with body or target
// past 64 fails out at dusk/night (failFinal clears the goal and holds
// gather) so the arbiter's gohome/shelter takes over. Morning retries resume
// from the nearer stance (sync-48 or a nearer memory point).
const FAR_START_BLOCKS = 64 // the bead's number: past it is a walk-out
// Last sixth of the day reads as near-dusk: a far round trip (walk out,
// chop a load, walk back) needs most of the daylight.
const LATE_DAY_TICKS = 10000 // dusk opens at 12000, night past 13000
function farStartOk(bot) {
  try {
    const t = bot && bot.time && bot.time.timeOfDay
    if (typeof t !== 'number' || !(t >= 0)) return true // no clock: allow
    return t < LATE_DAY_TICKS
  } catch (_) { return true }
}
// Anchor distance (revmux 01 core-2): a >64-block walk-out is measured from
// the task anchor (home), not from the body — chained <=64 hops from a far
// stand and stand-side chops still leave the bot 130+ out at dusk, which is
// what killed it in the rig. No anchor (and no body) reads near: allow.
function anchorDist(bot, ctx, bp, p) {
  try {
    if (!p || typeof p.x !== 'number' || typeof p.z !== 'number') return 0
    let ref = bp
    try {
      // Revmux 02 core-2: a world-spawn anchor is no shelter — a homeless
      // bot measures from the body (round-1 semantics), not from spawn.
      const a = exploreMod.anchorOf(bot, ctx)
      if (a && typeof a.x === 'number' && typeof a.z === 'number' &&
        (a.label === 'home' || a.label === 'castle')) ref = a
    } catch (_) { /* body fallback */ }
    if (!ref || typeof ref.x !== 'number' || typeof ref.z !== 'number') return 0
    return Math.hypot(p.x - ref.x, p.z - ref.z)
  } catch (_) { return 0 }
}
// A >64-block (horizontal, anchor-measured) walk-out that would run in the
// dark.
function farLate(bot, ctx, bp, target) {
  try {
    if (!target || typeof target.x !== 'number' || typeof target.z !== 'number') return false
    return anchorDist(bot, ctx, bp, target) > FAR_START_BLOCKS && !farStartOk(bot)
  } catch (_) { return false }
}
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
// idkcraft-gc3j: replant + far-wood memory. A felled tree near home gets a
// sapling on the stump cell (pack stock, fed by leaf drops); far-search log
// hits are noted into resource memory (persisted to the memory file like
// finds) so gather routes there when the near search is empty. The
// protected-log rule is untouched — denyReason still refuses non-tree logs
// before any dig, replant only ever places.
const REPLANT_HOME_RADIUS = 160 // the home wood stand: the far search reach
const FAR_NOTE_MAX = 16 // one stand, not the forest: memory stays mixed-use
const SAPLING_SOIL = new Set(['dirt', 'grass_block', 'coarse_dirt', 'rooted_dirt', 'moss_block', 'mud', 'podzol', 'mycelium', 'farmland'])

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

function isSapling(name) {
  return typeof name === 'string' && (name.endsWith('_sapling') || name === 'mangrove_propagule')
}

function isWoodyName(name) {
  return typeof name === 'string' &&
    ((name.endsWith('_log') && !name.startsWith('stripped_')) || name.endsWith('_stem') || name.endsWith('_hyphae'))
}

function cellNameAt(bot, x, y, z) {
  try {
    const b = bot.blockAt && bot.blockAt(new Vec3(Math.floor(x), Math.floor(y), Math.floor(z)))
    return b && b.name
  } catch (_) { return null }
}

function findSapling(bot) {
  try {
    const items = bot.inventory && typeof bot.inventory.items === 'function' ? bot.inventory.items() : null
    if (!Array.isArray(items)) return null
    // revmux verify #610 (codex P2): a lone dark_oak_sapling never grows
    // (2x2 only) — planting it wastes the item, so it is never picked.
    return items.find((it) => it && isSapling(it.name) && it.name !== 'dark_oak_sapling') || null
  } catch (_) { return null }
}

// One best-effort replant (gc3j): equip a pack sapling and lay it on the
// stump cell the dig just opened. Never writes stepStatus, never throws,
// never retries — a refusal just leaves this stump bare. Near-home only
// (the home wood stand), outside the house footprint and off banned ground
// (danger, castle frame); soil under the stump must take a sapling.
// digKey pins ownership (revmux 01 core-4): the plant only fires while the
// goal the dig was issued under still owns the body — a fight that took
// the body mid-dig must not lose its sword to a sapling. The stump must
// read back as air (an interrupted dig leaves the log standing) and the
// flight rides the shared ctx.placeInFlight seam like every other placer.
function tryReplant(bot, ctx, g, stump, banned, digKey) {
  try {
    if (!stump || !g || g.plantInFlight) return
    if (typeof bot.equip !== 'function' || typeof bot.placeBlock !== 'function') return
    if ((ctx && ctx.lastGoalKey) !== digKey) return // body changed hands mid-dig
    if (ctx && ctx.placeInFlight) return
    const home = ctx && ctx.home
    if (!home || !home.site || typeof home.site.x !== 'number') return
    if (Math.hypot(stump.x - home.site.x, stump.z - home.site.z) > REPLANT_HOME_RADIUS) return
    if (inHouseFootprint(home, stump)) return
    if (typeof banned === 'function' && banned(stump)) return
    if (cellNameAt(bot, stump.x, stump.y, stump.z) !== 'air') return
    if (!SAPLING_SOIL.has(cellNameAt(bot, stump.x, stump.y - 1, stump.z))) return
    const sapling = findSapling(bot)
    if (!sapling) return
    const ref = buildMod.findRef(bot, stump)
    if (!ref) return
    g.plantInFlight = true
    ctx.placeInFlight = true
    ;(async () => {
      try {
        await bot.equip(sapling, 'hand')
        // revmux verify #610 (codex P2): the world and the body can change
        // hands across the equip await — re-pin ownership and the open
        // stump (air over plantable soil) before placing, or the flight
        // swaps a fighter's sword for a sapling onto a taken cell.
        if ((ctx && ctx.lastGoalKey) !== digKey) return
        if (cellNameAt(bot, stump.x, stump.y, stump.z) !== 'air') return
        if (!SAPLING_SOIL.has(cellNameAt(bot, stump.x, stump.y - 1, stump.z))) return
        await bot.placeBlock(ref.ref, ref.face)
        g.replanted = (g.replanted || 0) + 1
        try { console.log(`gather: replanted ${sapling.name} at ${stump.x} ${stump.y} ${stump.z}`) } catch (_) { /* log best-effort */ }
      } catch (_) { /* one attempt: the stump stays bare */ }
      finally { g.plantInFlight = false; ctx.placeInFlight = false }
    })().catch(() => { g.plantInFlight = false; ctx.placeInFlight = false })
  } catch (_) { /* replant best-effort */ }
}

// Far-search hits into resource memory (gc3j): the staged search read
// these trunks but only one becomes the walk target — the rest would be
// re-scanned (or forgotten over a restart) otherwise. Nearest
// FAR_NOTE_MAX live logs only, never skipped/protected/banned cells, so a
// deforested home range accumulates the stands its searches have seen and
// the memory leg routes there when the near search is empty. Returns the
// noted count. Pure enough to unit-test through module.exports.
function noteFarWood(bot, ctx, bp, search, exclude) {
  try {
    const hits = search && search.hits instanceof Map ? [...search.hits.values()] : []
    if (hits.length === 0) return 0
    const spots = []
    for (const q of hits) {
      if (!q || typeof q.x !== 'number' || typeof q.y !== 'number' || typeof q.z !== 'number') continue
      if (exclude && exclude(q)) continue
      const name = cellNameAt(bot, q.x, q.y, q.z)
      if (typeof name !== 'string' || !name.endsWith('_log')) continue
      spots.push({ x: Math.floor(q.x), y: Math.floor(q.y), z: Math.floor(q.z), name })
    }
    if (spots.length === 0) return 0
    spots.sort((a, b) => dist(a, bp) - dist(b, bp))
    return resources.noteSpots(ctx, spots.slice(0, FAR_NOTE_MAX), Date.now())
  } catch (_) { return 0 }
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
// (.22) a gather-far unlock lifts the radius for the window only (clamped
// to the outer disk around the stable anchor).
// (atl.24) idle alone (nobody online, no owner bring) takes the same
// bound, as explore's spiral does (vmzq.59); farReject applies it to the
// far search too: prod walked the 96/160 shells 190 blocks into caves.
function taskFar(ctx, it, bot) {
  try {
    if (!exploreMod.taskActive(ctx) && !exploreMod.aloneIdle(bot, ctx)) return false
    const a = exploreMod.anchorOf(bot, ctx)
    if (!a || typeof a.x !== 'number' || !it || typeof it.x !== 'number') return false
    let radius = exploreMod.TASK_SEARCH_RADIUS || 64
    // Stranded-wood walk-out (vmzq.65): the same lift as explore's cap —
    // while the staged far search reads empty the task leash is the outer
    // disk, no unlock window needed. The alone leash (vmzq.59) stays.
    try {
      const { OUTER_DISK } = require('../goal-unlock')
      if (OUTER_DISK > radius && exploreMod.woodStranded(ctx) && exploreMod.taskActive(ctx) && !exploreMod.aloneIdle(bot, ctx)) radius = OUTER_DISK
    } catch (_) { /* default radius */ }
    try {
      const { goalUnlock } = require('../goal-unlock')
      const r = goalUnlock(ctx, 'radius')
      if (typeof r === 'number' && r > radius) radius = r
    } catch (_) { /* default radius */ }
    return Math.hypot(it.x - a.x, it.z - a.z) > radius
  } catch (_) {
    return false
  }
}

// Far/memory candidate gate (atl.24): a hit under the surface floor (only
// with a home: no home, no floor), past the task/alone leash, or a log
// the dig guard refuses is never walked to. A protected hit joins the
// sticky gskip like the sync-48 path, so it is checked once and the far
// search moves on to the next ring hit. Unloaded (blockAt null) passes.
function farReject(bot, ctx, g, bp, q) {
  if (g.gskip && g.gskip.has(keyOf(q))) return true
  if (ctx.home && q.y < resources.surfaceFloor(ctx, bp)) return true
  if (taskFar(ctx, q, bot)) return true
  let b = null
  try { b = bot.blockAt(asVec3(q)) } catch (_) { b = null }
  // Logs only: a stale memory cell (air) keeps its walk-and-skip path.
  if (b && typeof b.name === 'string' && b.name.endsWith('_log') && protectedReason(bot, b, ctx) === 'protected') {
    logDeny(b, 'protected')
    if (!g.gskip) g.gskip = new Set()
    g.gskip.add(keyOf(q))
    return true
  }
  return false
}

function failFinal(bot, ctx, g, logs, final, search = null) {
  g.final = final
  g.atLogs = logs
  // Stranded-wood record (vmzq.65): no-trees means the staged far search
  // came back with nothing walkable — the task leash lifts until the log
  // count moves. Any other final is not an empty search.
  g.farEmpty = (final === 'failed:no-trees')
  g.farEmptyAt = logs
  // The radius the give-up line names, for the watchdog narration to echo.
  if (final === 'failed:no-trees') g.farRadius = searchRadius(search)
  g.failPos = bodyPos(bot)
  ctx.stepStatus = g.final
  say(bot, finalLine(g, final, search))
  clearGoal(bot, ctx)
}

// Radius actually searched by a completed far cursor: ring 70 covers
// 48..96, rings 110/150 cover 96..160; no rings, no far search ran.
function searchRadius(search) {
  try {
    const queue = search && Array.isArray(search.queue) ? search.queue : []
    const max = queue.reduce((m, c) => Math.max(m, (c && c.ring) || 0), 0)
    if (max > 70) return 160
    if (max === 70) return 96
  } catch (_) { /* sync radius */ }
  return 48
}

// Give-up wording (vmzq.66): the radius actually searched — the far
// shells reached, or the sync 48 when no far search ran — plus the near
// logs seen but unusable (banned, protected, skipped).
function finalLine(g, final, search) {
  if (final === 'failed:pack-full') return 'pack full, banking first'
  // Revmux 02 core-3: the time guard fails out as dusk, not no-trees —
  // castlefetch marks NO_WOOD on an exact no-trees and the owner would be
  // told there is no wood. Holds, menus and narration read any failed:
  // reason generically, so the distinct reason changes nothing but the
  // wording and the NO_WOOD mark.
  if (final === 'failed:dusk') return 'too late to walk out for wood'
  if (final !== 'failed:no-trees') return 'cannot reach the trees'
  const radius = searchRadius(search)
  if (radius === 48) return 'no trees within 48 blocks'
  const n = g && g.nearMiss ? g.nearMiss.size : 0
  const excl = n > 0 ? ` (${n} near one${n === 1 ? '' : 's'} unusable)` : ''
  return `no trees within ${radius} of here${excl}`
}

// Banked logs first (ht8l, owner: "chests full of logs, it chops anyway"):
// the home chest (or the castle site chest), nearest within the task
// radius, before any tree. One try per need: a draw short of the ask, or an
// unreachable chest, marks that chest dry for CHEST_DRY_MS and the chop runs
// as before — an empty chest never loops. Only while nothing banks the logs
// straight back (no ping-pong): an unbuilt home (stockpile is built-only) or
// an open castle (its wood keep, LOG_KEEP, covers a full NEED_LOGS load).
// ponytail: logs only — banked planks feed beds (beds.js) and the castle
// chest (castlefetch chestTick); add planks here if a plank-only bank shows.
const CHEST_DRY_MS = 10 * 60 * 1000
function chestLogsTick(bot, ctx, g, logs, bp) {
  let pick = g.chestLogs
  if (!pick) {
    if (g.chestTried) return false // one try per attempt, dry window or not
    try {
      if (ctx.home && ctx.home.built && !require('./packroom').castleWoodOpen(ctx)) return false
    } catch (_) { return false }
    const dry = ctx.chestLogsDry || {}
    const now = Date.now()
    for (const c of [ctx.home && ctx.home.chest, ctx.castle && ctx.castle.siteChest]) {
      if (!c || typeof c.x !== 'number') continue
      const k = `${c.x},${c.y},${c.z}`
      if (typeof dry[k] === 'number' && now - dry[k] < CHEST_DRY_MS) continue
      const d = Math.hypot(bp.x - c.x, bp.z - c.z)
      if (d <= exploreMod.TASK_SEARCH_RADIUS && (!pick || d < pick.d)) pick = { c, k, d }
    }
    if (!pick) return false
    g.chestLogs = pick
    if (ctx.lastGoalKey === `gather-chest:${pick.k}`) ctx.lastGoalKey = null // a stale key never issues the walk
  }
  const markDry = () => {
    (ctx.chestLogsDry || (ctx.chestLogsDry = {}))[pick.k] = Date.now()
    g.chestLogs = null
    g.chestTried = true
  }
  const want = NEED_LOGS - logs
  let busy = false
  try {
    busy = require('./beds').chestTick(bot, ctx, g, `gather-chest:${pick.k}`, async () => {
      let got = 0
      try {
        const r = await require('./stockpile').withdrawAnyFromChest(bot, ctx, logNames(bot), want, pick.c)
        got = (r && r.got) || 0
      } catch (_) { got = 0 }
      if (got < want) markDry()
      else g.chestLogs = null
      try { console.log(`gather: ${got} logs from the chest at ${pick.k}`) } catch (_) { /* log best-effort */ }
    }, pick.c)
  } catch (_) { busy = false }
  if (!busy) markDry() // unreachable: chop
  return busy
}

function gather(bot, ctx, target, state) {
  const logs = countItems(bot, (n) => n.endsWith('_log'))
  if (!ctx.gather) ctx.gather = { pos: null, name: 'log', phase: 'walk', skip: new Set(), gskip: new Set(), streak: 0, final: null, atLogs: -1, lastProgressAt: Date.now() }
  const g = ctx.gather
  // (vmzq.66) the stranded record holds only at the log count that
  // produced it — wood landing (a retry's chop, a walk-out gain) clears
  // it even with no final on the books (the gyw release keeps none).
  const strandedAt = typeof g.farEmptyAt === 'number' ? g.farEmptyAt : g.atLogs
  if (g.farEmpty && logs !== strandedAt) g.farEmpty = false
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
    g.chestTried = false // a fresh attempt may draw the chest again (ht8l)
    // A fresh attempt re-counts its own near misses (stale ground's
    // misses never ride a relocation retry's give-up line).
    if (g.nearMiss) g.nearMiss.clear()
    if (!keepSkip) g.skip.clear()
    // The stranded record clears with the world change (vmzq.65) — but
    // survives the gyw relocation release (keepSkip): the retry at new
    // ground still needs the lifted leash until wood actually lands.
    if (!keepSkip) g.farEmpty = false
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
  if (!g.pos && chestLogsTick(bot, ctx, g, logs, bp)) return
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
      const exclude = (q) => g.skip.has(keyOf(q)) || dist(q, bp) <= FIND_RADIUS || banned(q) || farReject(bot, ctx, g, bp, q)
      const r = stepFarSearch(bot, g.search, { exclude })
      if (!r.done) return
      const search = g.search
      g.search = null
      // gc3j: the shells saw more trunks than the one walk target — note
      // them into resource memory (persisted like finds) before picking.
      noteFarWood(bot, ctx, bp, search, exclude)
      const hit = r.result && r.result !== 'unknown' ? r.result : null
      if (hit && hit.position && !exclude(hit.position) && !farLate(bot, ctx, bp, hit.position)) {
        commitTarget(g, bp, hit.position, hit.name, true)
        say(bot, `going for ${g.name}, ${Math.round(dist(g.pos, bp))} blocks away`)
      } else if (hit && hit.position && !exclude(hit.position)) {
        // p9lx: far stand refused for time — same handoff as an empty
        // search (the hold parks gather near home till dawn) under its own
        // reason, so no stranded record and no castlefetch NO_WOOD mark.
        failFinal(bot, ctx, g, logs, 'failed:dusk')
      } else {
        // Honest word (vmzq.65): unreachable only when a trunk was walked
        // to and struck — the streak counts stall strikes (banned sync
        // hits and stale read-backs never strike, so they read no-trees).
        failFinal(bot, ctx, g, logs, g.streak > 0 ? 'failed:unreachable' : 'failed:no-trees', search)
      }
      return
    }
    let found = []
    try {
      found = bot.findBlocks({ matching: logIds(bot), maxDistance: FIND_RADIUS, count: FIND_COUNT }) || []
    } catch (_) { found = [] }
    // (vmzq.66) near logs seen but unusable ride the give-up line.
    const open = found.filter((p) => {
      const k = keyOf(p)
      if (g.skip.has(k) || (g.gskip && g.gskip.has(k)) || banned(p)) {
        if (!g.nearMiss) g.nearMiss = new Set()
        g.nearMiss.add(k)
        return false
      }
      return true
    })
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
        ? resources.nearest(ctx, bp, names, (it) => g.skip.has(keyOf(it)) || banned(it) || farReject(bot, ctx, g, bp, it))
        : null
      if (mem && farLate(bot, ctx, bp, mem)) {
        // p9lx: remembered stand refused for time — same handoff as an
        // empty search under its own reason (see the far-search twin).
        failFinal(bot, ctx, g, logs, 'failed:dusk')
        return
      } else if (mem) {
        commitTarget(g, bp, { x: mem.x, y: mem.y, z: mem.z }, mem.name, true)
        say(bot, `going for ${g.name}, ${Math.round(dist(g.pos, bp))} blocks away`)
      } else {
        let search = null
        try { search = startFarSearch(bot, 'logs') } catch (_) { search = null }
        if (search && search !== 'unknown') {
          g.search = search
          g.phase = 'searchfar'
          return
        }
        failFinal(bot, ctx, g, logs, g.streak > 0 ? 'failed:unreachable' : 'failed:no-trees')
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
    // p9lx: a walk-out caught by dusk/night fails out — body or target over
    // 64 from the anchor in the dark is the death march, not the trip
    // (revmux 01 core-2: chained hops and stand-side chops, core-3: the
    // failFinal clears the far goal, so the body stops now instead of
    // marching on till a later tick). The hold parks gather near the abort
    // point; the arbiter's gohome/shelter takes over, dawn retries from
    // the nearer stance. Anchor-near (64 or less both ends) finishes.
    if (g.pos && !farStartOk(bot) &&
      (anchorDist(bot, ctx, bp, g.pos) > FAR_START_BLOCKS || anchorDist(bot, ctx, bp, bp) > FAR_START_BLOCKS)) {
      g.pos = null
      g.far = false
      failFinal(bot, ctx, g, logs, 'failed:dusk')
      return
    }
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
      if (g.far && g.pos) {
        g.skip.add(keyOf(g.pos))
        // revmux 01 core-5: a far/memory point that reads back as non-log
        // is gone from the world — forget it, not just this trip's skip.
        try {
          if (typeof g.pos.x === 'number') resources.forget(ctx, Math.floor(g.pos.x), Math.floor(g.pos.y), Math.floor(g.pos.z))
        } catch (_) { /* forget best-effort */ }
      }
      g.pos = null // chopped by someone else (reads back as air): search again
      g.far = false
      return
    }
    if (!bot.pathfinder.isMoving()) {
      let diggable = true
      try { diggable = typeof bot.canDigBlock === 'function' ? bot.canDigBlock(block) : true } catch (_) { diggable = false }
      if (diggable) {
        // revmux 01 core-1: arrived at a far/memory stand — scan it into
        // resource memory (persisted like finds). The hike out past 160 is
        // what teaches the bot stands the far search cannot see; the dug
        // cells leave memory again when each dig lands (core-5).
        if (g.far) {
          try { resources.scan(bot, ctx) } catch (_) { /* scan best-effort */ }
        }
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
      // revmux 02 core-2: a protected cell is gone for every future run
      // too (forage.js precedent) — trap denials stay trip-scoped.
      try {
        if (gDeny === 'protected' && g.pos && typeof g.pos.x === 'number') {
          resources.forget(ctx, Math.floor(g.pos.x), Math.floor(g.pos.y), Math.floor(g.pos.z))
        }
      } catch (_) { /* forget best-effort */ }
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
    // gc3j: stump for the replant — the bottom log only (nothing woody
    // under it). Consumed when the dig lands; any other log leaves no stump.
    let stump = null
    try {
      const sp = block && block.position
      if (sp && typeof sp.x === 'number' && isWoodyName(block.name) &&
        !isWoodyName(cellNameAt(bot, sp.x, sp.y - 1, sp.z))) {
        stump = { x: Math.floor(sp.x), y: Math.floor(sp.y), z: Math.floor(sp.z) }
      }
    } catch (_) { stump = null }
    const digKey = ctx.lastGoalKey // revmux 01 core-4: the replant only fires under this goal
    const run = async () => {
      try { await bot.dig(block) } catch (_) { /* gone or interrupted: pickup anyway */ }
      ctx.digInFlight = false
      g.phase = 'pickup'
      // revmux 01 core-5: the dug cell leaves resource memory — a later
      // empty-search run must not re-walk a chopped stand.
      try {
        const dp = block && block.position
        if (dp && typeof dp.x === 'number') resources.forget(ctx, Math.floor(dp.x), Math.floor(dp.y), Math.floor(dp.z))
      } catch (_) { /* forget best-effort */ }
      tryReplant(bot, ctx, g, stump, banned, digKey)
    }
    void run()
    return
  }
  if (g.phase === 'pickup') {
    const key = `gather-pickup:${g.pos.x},${g.pos.y},${g.pos.z}`
    if (key !== ctx.lastGoalKey) {
      issueGoal(bot, ctx, new goals.GoalBlock(g.pos.x, g.pos.y, g.pos.z), key, false)
      return
    }
    // Reached or gave up getting there: the drop is picked up by proximity
    // and the inventory count is the truth — move to the next tree.
    g.pos = null
    g.phase = 'walk'
  }
}

module.exports = gather
module.exports.taskFar = taskFar
module.exports.noteFarWood = noteFarWood
module.exports.tryReplant = tryReplant
