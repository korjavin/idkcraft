'use strict'

// Body lease (idkcraft-6x7.3): one owner of the body per tick.
//
// WHY: the body had no single owner. Ownership was the runTick if-ladder
// plus ~30 side writers: setGoal in 25 files, control states in 6, two
// packet-tap monkeypatches over each other, pillar timers between ticks,
// and 12 sites writing the shared Movements (the p4s/68p/7gt bug class
// and the 3nt.24 sprint chain). This module does NOT migrate the 25
// setGoal files (out of budget, and re-routing every behaviour would
// change the algorithms the oracle measures). It owns the two things a
// central lease can own without touching behaviour code:
//
//   1. pickOwner(ctx): the runTick priority ladder as a pure function.
//      runTick evaluates it once per tick at tick start into a fresh
//      ctx.body = { owner }.
//   2. movementsFor(): the ONLY function that assigns Movements flags
//      (allowSprinting/canDig/allowParkour) anywhere in bot/src.
//      claimBody() applies it on every claim; per-tick staleness
//      (step/phase/keys) is corrected by same-owner refresh claims at
//      the dispatch points that learn fresh facts.
//
// The ownership wrapper is claimBody(): it checks prev-vs-next, logs the
// handover, and runs the single cleanup on a switch (setGoal(null) when a
// goal is live, clearControlStates, movementsFor). It also carries a
// tripwire: flags that moved without passing through movementsFor log
// once per flag per process. The wrapper observes, it never blocks —
// blocking a between-ticks writer would change behaviour.
//
// KNOWN SIDE WRITERS (out of the lease by bead scope, observe-only):
//   - recover.js pillar/jump timers: setControlState between ticks.
//   - deep.js RET_POP_SNEAK_MS timer: sneak release between ticks.
//   - unpin.js / decontact.js packet taps (wired in index.js main()):
//     cloned packets below the pathfinder, not goals or flags.
//   - greet.js arrival sneak: control states on the greet edge.
//   - fleeReflex (reflexes.js): a stateless reflex with a self-managed
//     goal key and default flags. It rides the tick's baseline owner on
//     purpose: claiming per flee tick would null+replan the away-goal
//     every tick for zero flag benefit.

// Baseline owners. Dynamic arms the ctx cannot see share 'idle': the
// brain's follow/fight/roam (the brain answer is unknowable at tick
// start), the homing walk (target visibility needs the bot), and the
// flee reflex (stateless, see above). They all drive default flags with
// self-managed goal keys, so sharing the baseline needs no lease edge —
// and per-action owners would switch+cleanup on every follow<->fight
// flap, nulling a live goal the same-key path never re-issues.
function pickOwner(ctx) {
  if (!ctx) return 'idle'
  if (ctx.paused) return 'stop'
  if (ctx.breath) return 'breath' // episode latch: the reflex owns while latched
  if (ctx.stuck) return 'recover' // fact from the previous tick's stuck.update
  if (ctx.comehome) return 'comehome'
  if (ctx.lead) return 'lead'
  if (ctx.bring) return 'bring'
  if (ctx.flat && !ctx.flat.parked) return 'flat'
  if (ctx.inShelter) return 'shelter'
  if (ctx.work) return 'work'
  return 'idle'
}

// Per-tick dispatch stashes, cleared by resetTick() at tick start:
//   ctx.followRan: follow() dispatched this tick (brain follow or the
//     fight given-up shadow). Proves a live follow key is fresh, so a
//     manual work step never sprints on a stale one.
//   ctx.shelterLeg: { x, y, z } anchor (the door-out or meet cell) when
//     a shelter leg (gohome walk, comehome walk/seat) dispatched.
function resetTick(ctx) {
  if (!ctx) return
  ctx.followRan = false
  ctx.shelterLeg = null
}

// No-dig borrows. The gohome walk and the comehome walk/seat never dig:
// with the house unbreakable A* prefers tunneling through dirt beside
// the walls over routing around (live 8kc). Both conditions are
// owner-independent on purpose: they mirror the old tick-start exemption
// exactly, including its stickiness — a preempted walk (flee/fight ticks
// that never dispatch the walk) keeps no-dig, same as before. Only an
// order/stop/fresh-work (which clears ctx.gohome) or a phase/step move
// re-opens the drill. Deep borrows differently (see movementsFor): the
// old tick start never exempted it, so it borrows only via an explicit
// extra from its dispatch site, never from ctx.
function gohomeWalk(ctx) {
  return !!(ctx && ctx.work && ctx.step === 'gohome' && ctx.gohome &&
    ctx.gohome.phase === 'walk' && ctx.home && ctx.home.site)
}

function meetDig(ctx) {
  const o = ctx && ctx.comehome
  return !!(o && !o.exiting && (o.phase === 'walk' || o.phase === 'seat'))
}

// Flat-gate inputs, verbatim from follow.js (5vv) and home.js (rw4.10):
// sprint only when far and every plan node within one sprint tick is
// level with the feet; a +1 anywhere in the window kills it before the
// sprint-jump can wedge against the step face (3nt.24). Planning rides
// the same movements object, so an open gate also holds parkour off — a
// maxD=4 plan would strand the next sprint-off tick.
const SPRINT_DIST = 8
const SPRINT_LOOKAHEAD = 6

function planFlat(nodes, bp) {
  if (!bp || !Array.isArray(nodes) || nodes.length === 0) return false
  return nodes.every((n) => {
    if (!n || typeof n.y !== 'number') return false
    if (typeof n.x === 'number' && typeof n.z === 'number' &&
      Math.hypot(n.x - bp.x, n.z - bp.z) > SPRINT_LOOKAHEAD) return true
    return Math.floor(n.y) === Math.floor(bp.y)
  })
}

function bodyPos(bot) {
  try {
    const p = bot && bot.entity && bot.entity.position
    if (p && typeof p.x === 'number' && typeof p.y === 'number' && typeof p.z === 'number') return p
  } catch (_) { /* unknown body */ }
  return null
}

// movementsFor(): the single Movements write site. Computes the flag
// triple from (owner, step/phase, dispatch stashes, live geometry) and
// assigns it onto ctx.movements. No other function in bot/src assigns
// allowSprinting/canDig/allowParkour.
//
// extra selects the application mode:
//   - tick-start / pre-dispatch claims pass nothing (or { deep: true } /
//     { walk: true } from the dispatch sites that borrow pre-issue):
//     canDig policy + forced sprint defaults.
//     Sprint gates need fresh keys, which only exist post-dispatch —
//     enabling sprint on a stale follow key would plan a fight goal at
//     maxD=4 and execute it sprint-off (the 5vv bug, injected).
//   - post-dispatch refreshes pass { sprint: true, target, dist } with
//     the dispatch's own target/state: full policy, current inputs.
// canDig is mode-independent: borrows are step/phase-scoped and must
// hold pre-issue (the walk plans no-dig) and across preempted ticks.
// Write targets: ctx.movements first, plus bot.pathfinder.movements when
// it is a distinct object. Production wires both to the same object
// (setMovements), but the old sites split shapes — home.js wrote the
// pathfinder's, follow.js the ctx's, deep.js ctx-first-fallback — and the
// e2e fake carries only the pathfinder's. The union preserves all three.
function movementTargets(bot, ctx) {
  const out = []
  try {
    if (ctx && ctx.movements) out.push(ctx.movements)
    const pm = bot && bot.pathfinder && bot.pathfinder.movements
    if (pm && pm !== (ctx && ctx.movements)) out.push(pm)
  } catch (_) { /* targets best-effort */ }
  return out
}

function movementsFor(owner, bot, ctx, extra) {
  const movs = movementTargets(bot, ctx)
  if (movs.length === 0) return
  let canDig = true
  let sprint = false
  let parkour = true
  try {
    if ((extra && (extra.deep || extra.walk)) || gohomeWalk(ctx) || meetDig(ctx)) canDig = false
    if (extra && extra.sprint) {
      const bp = bodyPos(bot)
      const nodes = ctx.lastPathNodes
      const key = (ctx && ctx.lastGoalKey) || ''
      const flat = planFlat(nodes, bp)
      const followGate = ctx.followRan && key.startsWith('follow:') &&
        extra.target && typeof extra.dist === 'number' && extra.dist > SPRINT_DIST && flat
      const leg = ctx.shelterLeg
      const legFar = !!(bp && leg && typeof leg.x === 'number' &&
        Math.hypot(bp.x - (leg.x + 0.5), bp.y - leg.y, bp.z - (leg.z + 0.5)) > SPRINT_DIST)
      const shelterGate = !!leg && (key.startsWith('gohome-') || key.startsWith('comehome-')) &&
        legFar && flat
      if (followGate || shelterGate) { sprint = true; parkour = false }
    }
  } catch (_) { /* policy best-effort: defaults stand */ }
  for (const mov of movs) {
    try {
      if (typeof mov.canDig === 'boolean') mov.canDig = canDig
      if (typeof mov.allowSprinting === 'boolean') mov.allowSprinting = sprint
      if (typeof mov.allowParkour === 'boolean') mov.allowParkour = parkour
    } catch (_) { /* apply best-effort */ }
  }
}

// Tripwire state: per-ctx flag snapshots (a WeakMap, so unit-test ctx
// objects never leak) plus the once-per-flag violation log set.
const flagSnap = new WeakMap()
const warnedFlags = new Set()

function snapOf(bot, ctx) {
  const out = []
  try {
    for (const mov of movementTargets(bot, ctx)) {
      out.push({
        mov,
        canDig: mov.canDig,
        allowSprinting: mov.allowSprinting,
        allowParkour: mov.allowParkour,
      })
    }
  } catch (_) { /* snapshot best-effort */ }
  return out
}

function checkTripwire(bot, ctx) {
  let prev = null
  try { prev = flagSnap.get(ctx) } catch (_) { prev = null }
  if (!prev) return
  const live = snapOf(bot, ctx)
  const names = ['canDig', 'allowSprinting', 'allowParkour']
  for (const cur of live) {
    const old = prev.find((e) => e.mov === cur.mov)
    if (!old) continue // reinstall re-baselines silently
    for (const n of names) {
      if (old[n] !== cur[n] && !warnedFlags.has(n)) {
        warnedFlags.add(n)
        try { console.warn(`body lease violation: ${n} flipped outside movementsFor (was ${old[n]}, now ${cur[n]})`) } catch (_) { /* log best-effort */ }
      }
    }
  }
}

// claimBody(): the ownership choke point. Replaces ctx.body with a fresh
// { owner } every call; on an owner switch runs the single cleanup
// (null an idle live goal, drop manual control states) and always applies
// movementsFor. Same-owner claims are refresh-only: idempotent flag
// sets for step/phase/geometry that moved within the lease. Only the
// tick-start baseline, the recover pre-decide claim and the breath
// trigger claim ever switch; every post-dispatch refresh passes the
// current owner so dispatch can never churn the lease. The first claim
// adopts without cleanup — no previous owner exists to clean up after.
function claimBody(bot, ctx, owner, extra) {
  if (!ctx) return owner
  let prev
  try { prev = ctx.body ? ctx.body.owner : undefined } catch (_) { prev = undefined }
  try { ctx.body = { owner } } catch (_) { /* frozen ctx: tick survives unleased */ }
  checkTripwire(bot, ctx)
  if (prev !== owner && prev !== undefined && prev !== null) {
    try { console.log(`body owner ${prev} -> ${owner}`) } catch (_) { /* log best-effort */ }
    // A moving executor belongs to stopOnce (its stop-vs-null rule owns
    // the stopPathing latch): the lease never nulls under it. The new
    // owner overwrites the stale goal on issue (keys always differ), or
    // stopOnce parks it on stop paths.
    let moving = false
    try { moving = !!(bot && bot.pathfinder && typeof bot.pathfinder.isMoving === 'function' && bot.pathfinder.isMoving()) } catch (_) { moving = false }
    if (!moving) {
      try {
        if (bot && bot.pathfinder && bot.pathfinder.goal != null &&
          typeof bot.pathfinder.setGoal === 'function') bot.pathfinder.setGoal(null)
      } catch (_) { /* cleanup best-effort */ }
    }
    try {
      if (bot && typeof bot.clearControlStates === 'function') bot.clearControlStates()
    } catch (_) { /* cleanup best-effort */ }
  }
  movementsFor(owner, bot, ctx, extra)
  try { flagSnap.set(ctx, snapOf(bot, ctx)) } catch (_) { /* snapshot best-effort */ }
  return owner
}

module.exports = { pickOwner, resetTick, movementsFor, claimBody, gohomeWalk, meetDig }
