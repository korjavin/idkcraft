'use strict'

// Task executive, slices 1-2 (idkcraft-vmzq.2/.3) + re-plan (.5) + goal
// watchdog (.21) + order goals (.22): progress invariant + stall clock +
// L1 honest line + L2/L3 park ladder. No behaviour changes: this only
// measures (gauges), times the stall, chats/logs the ladder lines, runs
// fast JEV rounds while a goal's metric is flat (the answer rides a bounded
// commitment window on ctx.goal, honoured by goal.js for work goals and by
// the order dispatch seam for order goals), and parks the task (a menu
// veto, honoured by goal.js) with a diagnosis.
//
// Active goal (.22): the body-owning order first (comehome, gocastle, lead,
// bring, flat — index.js dispatch order), else the castle while ordered,
// incomplete and not owner-parked (castle outranks build in STEP_ORDER,
// vmzq.19), else the house while unbuilt, else none. A task-parked (L2
// episode) task STAYS active: the stall invariant still applies to side
// work (owner Q2). Owner-parked (castle stop, no episode) pauses. The
// castle/house clock advances only on day + work + not-paused + no-order
// ticks — fight and shelter time COUNT (the hook sits before those
// short-circuits), night/paused/orders pause it. Order clocks advance
// whenever the order runs (day or night, owner 2026-10-07), not-paused.
// Any progress resets it: castle place cells, prep remaining,
// demanded-material on hand / remainder; house placed cells; bring items
// in hand; travel distance shrinking; flat cells levelled.

const metrics = require('./metrics')
const { CHAT_LIMIT } = require('./commands')
const { orderStamp, carryOrderStamp, chatStep, failReason, isFinished } = require('./step') // oqul.11: moved for home.js
const worker = require('./worker')

const TASK_STALL_L1_MS = 15 * 60 * 1000
const TASK_STALL_L2_MS = 45 * 60 * 1000
const TASK_PARK_RETRY_MS = 60 * 60 * 1000
const TASK_PARKS_PER_DAY = 3
const TASK_PARK_DIAG_MAX = 200
const TASK_HOUSE_CACHE_MS = 60 * 1000
const TASK_FAILS_KEPT = 3
// Stall-point planner gate (idkcraft-vmzq.5): below this confidence no
// option holds a majority of the model's belief, so the rule-based park
// runs instead of forcing a coin flip. Measured via stand-steps jev
// +context on goal-context-eval (2026-10-06): right answers mean 0.70
// (n=47), wrong 0.56 (n=15).
const TASK_PLAN_MIN_CONF = 0.5
// Per-tick stall increment cap (verify core-2): ticks that return before the
// hook (idle, recover, reflexes) leave lastAt stale; without a clamp the next
// hooked tick would bill the whole gap, nights included, as one instant L1.
const STALL_TICK_CLAMP_MS = 10000
// Goal watchdog (idkcraft-vmzq.21, owner 2026-10-07): every active goal
// has a tracked completion metric; normal play is the FSM; when the
// metric is flat for GOAL_WATCHDOG_MS of eligible time the executive
// calls JEV plan() immediately with goal + progress history + situation +
// options and follows its choice for a bounded GOAL_COMMIT_MS window.
// 0 = off (the shipped 15/45-min ladder, the rollback); an absent
// TYPESAFE_API_KEY also keeps the ladder (no plan() on the brain).
const GOAL_WATCHDOG_MS_DEFAULT = 60000
const GOAL_COMMIT_MS_DEFAULT = 120000
const GOAL_WATCHDOG_MAX_ROUNDS_DEFAULT = 6
const GOAL_TRAVEL_GRACE_MS_DEFAULT = 90000
// Plan-B switch (owner 2026-10-07, nobody online): after a relocate leg
// and another flat JEV round, work another goal for this long, then
// return. Midpoint of the owner's 5-10 min.
const GOAL_PLANB_SWITCH_MS_DEFAULT = 450000
const GOAL_HISTORY_KEPT = 5
const GOAL_BACKOFF_MIN_MS = 30000
const GOAL_BACKOFF_MAX_MS = 5 * 60 * 1000
// Travel grace bound (revmux 01 core-2): at most one grace reset per
// stall episode. A second castlefetch leg without intervening progress
// is definitionally the stuck pattern the watchdog exists for —
// uncapped, flip-flops would silence the L1/L2 ladder (their thresholds
// dwarf the grace floor). Progress opens a new episode.
const GOAL_GRACE_RUNS_PER_EPISODE = 1
function envMs(name, def) {
  try {
    const raw = process.env && process.env[name]
    if (raw === undefined || raw === null || raw === '') return def
    const n = parseInt(raw, 10)
    return Number.isFinite(n) && n >= 0 ? n : def
  } catch (_) {
    return def
  }
}
function goalWatchdogMs() { return envMs('GOAL_WATCHDOG_MS', GOAL_WATCHDOG_MS_DEFAULT) }
function goalCommitMs() { return envMs('GOAL_COMMIT_MS', GOAL_COMMIT_MS_DEFAULT) }
function goalMaxRounds() {
  try {
    const n = parseInt(process.env && process.env.GOAL_WATCHDOG_MAX_ROUNDS, 10)
    return Number.isFinite(n) && n >= 1 ? n : GOAL_WATCHDOG_MAX_ROUNDS_DEFAULT
  } catch (_) {
    return GOAL_WATCHDOG_MAX_ROUNDS_DEFAULT
  }
}
function goalGraceMs() { return envMs('GOAL_TRAVEL_GRACE_MS', GOAL_TRAVEL_GRACE_MS_DEFAULT) }
function goalPlanbMs() { return envMs('GOAL_PLANB_SWITCH_MS', GOAL_PLANB_SWITCH_MS_DEFAULT) }
function watchdogOn() { return goalWatchdogMs() > 0 }
const { PLAN_INSTRUCTIONS, PLAN_PARK_CRITERION, STEP_ORDER, STEP_EFFECT_TEXT } = require('./plan-consts') // oqul.5: leaf

function taskKind(ctx) {
  try {
    const st = ctx && ctx.castle
    // Task-parked (an L2 episode on the record) stays active — the clock
    // runs through the park so side work is still watched; owner-parked
    // (castle stop, no episode) pauses.
    if (st && st.site && typeof st.site.x === 'number' && (!st.parked || st.taskPark) && st.phase !== 'complete') return 'castle'
  } catch (_) { /* fall through to house */ }
  try {
    const home = ctx && ctx.home
    if (home && home.site && typeof home.site.x === 'number' && !home.built) return 'house'
    // Pending house (idkcraft-vmzq.16): homeless with a recorded no-site —
    // no progress to measure, but the stall clock still watches (at ?/?)
    // so the owner hears via the L1 instead of silence. The L2 park
    // no-ops on no home (nothing to veto); the record dies with the next
    // build attempt, which founds a site or re-stamps the failure.
    if ((!home || !home.site) && ctx && ctx.stepFail && ctx.stepFail.build &&
      ctx.stepFail.build.status === 'failed:no-site') return 'house'
  } catch (_) { /* no task */ }
  return null
}

function timeDay(bot) {
  try {
    return require('./site').timeWord(bot) === 'day'
  } catch (_) {
    return false
  }
}

// Order kinds (vmzq.22): owner orders as goals with tracked metrics.
const ORDER_KINDS = ['bring', 'comehome', 'gocastle', 'lead', 'flat']
function isOrderKind(kind) {
  return kind === 'bring' || kind === 'comehome' || kind === 'gocastle' || kind === 'lead' || kind === 'flat'
}

// Active goal (vmzq.22): the body-owning order first (index.js dispatch
// order: comehome, gocastle, lead, bring, flat), else the castle/house
// task. A parked flat episode (stop) is not running.
function goalKind(ctx) {
  try {
    if (ctx) {
      if (ctx.comehome) return 'comehome'
      if (ctx.gocastle) return 'gocastle'
      if (ctx.lead) return 'lead'
      if (ctx.bring) return 'bring'
      if (ctx.flat && !ctx.flat.parked) return 'flat'
    }
  } catch (_) { /* no order */ }
  try {
    return taskKind(ctx)
  } catch (_) {
    return null
  }
}

function goalTextFor(kind, ctx) {
  try {
    if (kind === 'castle') return 'build castle'
    if (kind === 'house') return 'build home'
    if (kind === 'bring') {
      const o = ctx && ctx.bring
      const want = o && typeof o.want === 'number' ? o.want : '?'
      const name = (o && (o.name || o.drop)) || 'items'
      const by = (o && o.by) || 'owner'
      return `bring ${want} ${name} to ${by}`
    }
    if (kind === 'comehome') return 'come home'
    if (kind === 'gocastle') return 'go castle'
    if (kind === 'lead') {
      const o = ctx && ctx.lead
      return `lead to ${(o && o.name) || 'the find'}`
    }
    if (kind === 'flat') return 'flatten ground'
  } catch (_) { /* fall through */ }
  return kind
}

// Goal identity (vmzq.21, extended .22 for orders): the active goal as an
// ownable goal. The generation counts foundings per session; every async
// JEV request and every commitment carries {goalId, generation} and is
// dropped when they no longer match (the .5 seq guard generalised).
// resetTask clears the goal, so stop/go/forget/new order all invalidate.
function ensureGoal(ctx, kind, now) {
  try {
    if (!ctx || (kind !== 'castle' && kind !== 'house' && !isOrderKind(kind))) return null
    const g = ctx.goal
    if (g && g.kind === kind && typeof g.id === 'string' && typeof g.generation === 'number') return g
    // Replacing a goal with a live window should not happen (commitTickTop
    // runs before this), but a window is never dropped silently.
    if (g && g.commit) {
      try {
        const st = ctx.task && ctx.task[g.kind]
        endCommit(null, ctx, g.kind, st && typeof st === 'object' ? st : null, g.commit, 'preempted:replaced', now)
      } catch (_) { /* replace best-effort */ }
    }
    const seq = (ctx.goalSeq = (typeof ctx.goalSeq === 'number' ? ctx.goalSeq : 0) + 1)
    const goal = { id: `${kind}-${seq}`, kind, generation: seq, text: goalTextFor(kind, ctx), startedAt: now }
    ctx.goal = goal
    return goal
  } catch (_) {
    return null
  }
}

// Roster, not visibility (index.js workTick precedent): anyone on the
// server counts, the bot itself excluded. Drives the plan-B fork.
function ownerOnline(bot) {
  try {
    // neuc.45: the peer bot (v1/v2) is not an owner
    const bots = [process.env.BOT_USERNAME, process.env.BOT2_USERNAME, process.env.BOT_PEER_USERNAME].filter(Boolean)
    return Object.keys(worker.players(bot)).some((n) => !bots.includes(n))
  } catch (_) {
    return false
  }
}

function eligible(bot, ctx) {
  if (!timeDay(bot)) return false
  if (!ctx || !ctx.work || ctx.paused) return false
  if (ctx.lead || ctx.bring || ctx.comehome || ctx.gocastle) return false
  // A running flat order owns the body (vmzq.8): the L1 must not fire
  // mid-order. A parked flat episode (stop) is not running.
  if (ctx.flat && !ctx.flat.parked) return false
  return true
}

// Arrival hold (finding 2): comehome/gocastle sit in phase 'hold' after
// arrival (never cleared), and lead waits for a lagging player — the
// distance flatlines while the order is exactly where it should be, so
// the stall clock must not run and the watchdog must not fire (a park
// would cancel an order that already succeeded).
function orderHolding(ctx, kind) {
  try {
    if (kind === 'comehome') return !!(ctx && ctx.comehome && ctx.comehome.phase === 'hold')
    if (kind === 'gocastle') return !!(ctx && ctx.gocastle && ctx.gocastle.phase === 'hold')
    if (kind === 'lead') return !!(ctx && ctx.lead && ctx.lead.waiting)
  } catch (_) { /* not holding */ }
  return false
}

// Eligible time for an order goal (vmzq.22): the order running, not
// paused, not arrival-holding — day or night (owner 2026-10-07: orders
// run day and night). Fight/shelter/recover time counts (the hook sits
// before those short-circuits, same as the work clock).
function eligibleOrder(ctx, kind) {
  try {
    if (!ctx || ctx.paused) return false
    if (orderHolding(ctx, kind)) return false
    if (kind === 'bring') return !!ctx.bring
    if (kind === 'comehome') return !!ctx.comehome
    if (kind === 'gocastle') return !!ctx.gocastle
    if (kind === 'lead') return !!ctx.lead
    if (kind === 'flat') return !!(ctx.flat && !ctx.flat.parked)
  } catch (_) { /* ineligible */ }
  return false
}

// Arrival hold settles the clock (finding 2): the stall clears and any
// in-flight round drops — the order already succeeded, so a stale answer
// must never park it.
function holdReset(state) {
  try {
    state.stallMs = 0
    const wd = wdOf(state)
    wd.pending = null
    wd.answer = null
  } catch (_) { /* reset best-effort */ }
}

// The live order object behind a goal kind (finding 4: identity source).
function orderObj(ctx, kind) {
  try {
    if (!ctx) return null
    if (kind === 'bring') return ctx.bring || null
    if (kind === 'comehome') return ctx.comehome || null
    if (kind === 'gocastle') return ctx.gocastle || null
    if (kind === 'lead') return ctx.lead || null
    if (kind === 'flat') return ctx.flat || null
  } catch (_) { /* no order */ }
  return null
}

function dist3(a, b) {
  try {
    if (!a || !b || typeof a.x !== 'number' || typeof b.x !== 'number') return null
    if (typeof a.distanceTo === 'function') return a.distanceTo(b)
    if (typeof b.distanceTo === 'function') return b.distanceTo(a)
    return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)
  } catch (_) {
    return null
  }
}

// Current order progress for the clock. done/total shape mirrors the
// castle/house states so the watchdog lines read uniformly:
// - bring: items in hand have/want (o.have, the delivery leg's distance
//   rides dist for the travel grace, not the clock)
// - comehome/gocastle/lead: blocks left to the semantic destination
//   (arrival = done); total is the baseline distance at founding
// - flat: cells levelled (filled+shaved) over total+totalBumps.
function orderCurrent(bot, ctx, kind) {
  const out = {}
  try {
    if (kind === 'bring') {
      const o = ctx && ctx.bring
      if (!o) return out
      if (typeof o.have === 'number') out.done = o.have
      else {
        try {
          const { countItems } = require('./perception')
          out.done = o.drop ? countItems(bot, (n) => n === o.drop) : 0
        } catch (_) { out.done = 0 }
      }
      out.total = typeof o.want === 'number' ? o.want : out.done
      // Delivery-leg distance (return phase): the travel grace input.
      try {
        const giver = o.phase === 'return' && o.by ? worker.players(bot)[o.by] : null
        if (giver && giver.entity) {
          const bp = bot.entity && bot.entity.position
          const tp = giver.entity.position
          const d = dist3(bp, tp)
          if (typeof d === 'number') out.dist = d
        }
      } catch (_) { /* no leg distance */ }
      return out
    }
    if (kind === 'lead') {
      const o = ctx && ctx.lead
      if (!o || !o.pos) return out
      const bp = bot && bot.entity && bot.entity.position
      const d = dist3(bp, o.pos)
      if (typeof d === 'number') {
        out.done = 0
        out.total = 0
        out.dist = d
      }
      return out
    }
    if (kind === 'comehome') {
      const home = (ctx && ctx.comehome && ctx.comehome.home) || (ctx && ctx.home)
      if (!home || !home.site) return out
      const bp = bot && bot.entity && bot.entity.position
      const d = dist3(bp, { x: home.site.x, y: home.site.y, z: home.site.z })
      if (typeof d === 'number') {
        out.done = 0
        out.total = 0
        out.dist = d
      }
      return out
    }
    if (kind === 'gocastle') {
      const st = (ctx && ctx.gocastle && ctx.gocastle.castle) || (ctx && ctx.castle)
      if (!st || !st.site) return out
      let ent = null
      try {
        ent = require('./behaviours/castle').entrance(st)
      } catch (_) {
        ent = st.site
      }
      const bp = bot && bot.entity && bot.entity.position
      const d = dist3(bp, ent || st.site)
      if (typeof d === 'number') {
        out.done = 0
        out.total = 0
        out.dist = d
      }
      return out
    }
    if (kind === 'flat') {
      const f = ctx && ctx.flat
      if (!f) return out
      const done = (f.filled || 0) + (f.shaved || 0)
      const total = (f.total || 0) + (f.totalBumps || 0)
      out.done = done
      out.total = total
      out.blocks = f.blocks || 0 // x3y6.2: dug/placed blocks, finer than levelled cells
      return out
    }
  } catch (_) { /* unreadable reads empty */ }
  return out
}

// Order progress verdict with its reason (the castleProgressWhy shape):
// - bring: have rising
// - travel (comehome/gocastle/lead): distance shrinking past the 2-block
//   displacement threshold (peer Q1: tiny improvements must not reset)
// - flat: levelled cells or dug/placed blocks rising.
const ORDER_ARRIVE_BLOCKS = 2
function orderProgressWhy(state, cur, kind) {
  try {
    if (kind === 'bring' || kind === 'flat') {
      if (typeof cur.done === 'number' && typeof state.done === 'number' && cur.done > state.done) {
        return kind === 'bring' ? 'have' : 'cells'
      }
      if (kind === 'flat' && cur.blocks > (state.blocks || 0)) return 'blocks'
      return null
    }
    if (kind === 'comehome' || kind === 'gocastle' || kind === 'lead') {
      if (typeof cur.dist === 'number' && typeof state.dist === 'number' &&
        cur.dist + ORDER_ARRIVE_BLOCKS < state.dist) return 'arrive'
      return null
    }
  } catch (_) { /* no verdict */ }
  return null
}

// Placed cells of the home plan (NOT nextCellIdx: an index treats skipped
// cells as done). 99 blockAt max (v2), cached 60 s by the caller. Loaded
// only (core-1): unloaded cells read undone, so a partial read would sink
// the baseline to 0 and the return trip would count as progress.
function houseLoaded(bot, home) {
  try {
    const build = require('./behaviours/build')
    for (const cell of build.blueprintFor(home)) {
      try {
        if (!build.cellLoaded(bot, home, cell)) return false
      } catch (_) {
        return false
      }
    }
    return true
  } catch (_) {
    return false
  }
}

function houseProgress(bot, home) {
  const build = require('./behaviours/build')
  const plan = build.blueprintFor(home)
  let done = 0
  for (const cell of plan) {
    try {
      if (build.cellDone(bot, home, cell)) done++
    } catch (_) { /* unreadable reads undone */ }
  }
  return { done, total: plan.length }
}

// House wood (idkcraft-oqj5): the house's own input, in planks (a log
// crafts 4). Prod v2 parked the house at 63/130 while it explored and
// chopped far trees: the clock saw only placed cells, so every gather run
// read as a stall. Wood rising past the episode's high-water mark is
// progress while the pack is still short of the cells left (bounded like
// castle enabling, m1yb: once the wood covers the rest, only cells count,
// and a consume-and-rechop or death-and-pickup loop never re-credits).
function houseWood(bot) {
  try {
    const en = castleEnabling(bot)
    return en.planks + 4 * en.logs
  } catch (_) {
    return null
  }
}

function houseProgressWhy(state, cur) {
  if (typeof cur.done === 'number' && typeof state.done === 'number' && cur.done > state.done) return 'cells'
  if (typeof cur.wood === 'number' && typeof state.wood === 'number' && cur.wood > state.wood &&
    typeof state.done === 'number' && typeof state.total === 'number' && state.wood < state.total - state.done) return 'wood'
  return null
}

// Shared with orders.status (verify scope): the skipped/blocked reasons, one
// implementation used by both the status lines and the L1 diagnosis.
function skippedReason(bot, ctx, facts, text, upto) {
  try {
    const goal = require('./goal')
    let names = []
    try {
      names = Object.keys(goal.MENU).filter((n) => {
        try {
          if (!goal.MENU[n].feasible(facts, bot, ctx) || !goal.registered(n)) return false
        } catch (_) {
          return false
        }
        return !goal.failHolds(ctx, n, text, bot)
      })
    } catch (_) { names = [] }
    let skipped = ''
    try { skipped = goal.restWhy(facts, bot, ctx, names, upto) } catch (_) { skipped = '' }
    if (skipped && skipped !== 'model choice') return `skipped: ${skipped}`
  } catch (_) { /* skipped best-effort */ }
  return null
}

function blockedReason(bot, ctx, facts, text) {
  try {
    const goal = require('./goal')
    const fails = ctx && ctx.stepFail && typeof ctx.stepFail === 'object' ? Object.keys(ctx.stepFail) : []
    if (fails.length === 0) return null
    const holding = fails.filter((n) => {
      try {
        if (goal.failHolds(ctx, n, text, bot)) return true
      } catch (_) { /* fall through to the gather latch */ }
      try {
        return n === 'gather' && goal.gatherFailedHolds(ctx.gather, facts.logs, bot)
      } catch (_) {
        return false
      }
    })
    if (holding.length === 0) return null
    const held = holding.map((n) => {
      let w = null
      try { w = goal.stepWhy(n, facts, bot, ctx, text) } catch (_) { w = null }
      if (!w) {
        const rec = (ctx.stepFail && ctx.stepFail[n]) || {}
        w = rec.status === 'done' ? `${n} holds after an unchanged done` : `${n} holds after failure`
      }
      return w
    })
    return `blocked: ${held.join(', ')}`
  } catch (_) { /* blocked best-effort */ }
  return null
}

// Diagnosis for the L1 line: step, pick, the shared skipped/blocked holds,
// the castle word and recent failures. .3/.5 consume this same string.
function diagnose(bot, ctx) {
  const parts = []
  try {
    const step = (ctx && ctx.step) || 'none'
    const status = (ctx && ctx.stepStatus) || ''
    const pick = ctx && ctx.stepPick && ctx.stepPick.step === step ? ctx.stepPick : null
    let base = `step=${step}`
    if (status) base += ` ${status}`
    if (pick && pick.source) base += ` — by ${pick.source} (${pick.why || 'unknown'})`
    parts.push(base)
  } catch (_) { /* step best-effort */ }
  try {
    const goal = require('./goal')
    const facts = goal.goalFacts(bot, ctx)
    const text = goal.goalText(facts, ctx && ctx.home)
    const sk = skippedReason(bot, ctx, facts, text, (ctx && ctx.step) || 'none')
    if (sk) parts.push(sk)
    const bl = blockedReason(bot, ctx, facts, text)
    if (bl) parts.push(bl)
  } catch (_) { /* facts best-effort */ }
  try {
    const cw = ctx && ctx.castleWord
    if (cw && cw.kind) parts.push(`castleWord=${cw.word ? cw.word + ' ' : ''}${cw.kind} left=${cw.left}`)
    else if (cw && cw.word) parts.push(`castleWord=${cw.word}`)
  } catch (_) { /* word best-effort */ }
  try {
    const t = ctx && ctx.task
    const fails = t && t[t.active] && Array.isArray(t[t.active].fails) ? t[t.active].fails : []
    if (fails.length > 0) parts.push(`failed: ${fails.join(', ')}`)
  } catch (_) { /* fails best-effort */ }
  return parts.length > 0 ? parts.join('; ') : 'unknown'
}

function stallFmt(ms) {
  if (!(ms > 0)) return '0s'
  if (ms < 60000) return `${Math.floor(ms / 1000)}s`
  if (ms < 3600000) return `${Math.floor(ms / 60000)}m`
  return `${Math.floor(ms / 3600000)}h${Math.floor((ms % 3600000) / 60000)}m`
}

// L1 chat line; the diagnosis clips, the honest suffix never does. While
// task-parked the suffix says so — the bot is doing side work, not trying
// the main task. With watchdog rounds behind the stall the suffix counts
// them (the L1 stays the human-facing summary).
function chatL1(kind, done, total, diagnosis, parked, rounds) {
  const prefix = `${kind}: no progress for 15 min at ${done}/${total} — `
  const suffix = parked ? '; parked, doing side work' : (rounds > 0 ? `; still trying, ${rounds} watchdog rounds` : '; still trying')
  const maxDiag = CHAT_LIMIT - prefix.length - suffix.length
  const diag = String(diagnosis || 'unknown')
  const clipped = diag.length > maxDiag && maxDiag > 1 ? diag.slice(0, maxDiag - 1) + '…' : diag
  return prefix + clipped + suffix
}

// L2/L3 chat lines (vmzq.3): the whole line caps at TASK_PARK_DIAG_MAX
// (200), the full diagnosis rides the log. The resume command differs by
// task: castle go re-arms the castle, go work re-arms the house.
function chatClipped(prefix, suffix, diagnosis) {
  const maxDiag = TASK_PARK_DIAG_MAX - prefix.length - suffix.length
  const diag = String(diagnosis || 'unknown')
  const clipped = diag.length > maxDiag && maxDiag > 1 ? diag.slice(0, maxDiag - 1) + '…' : diag
  return (prefix + clipped + suffix).slice(0, TASK_PARK_DIAG_MAX)
}

function chatL2(kind, done, total, diagnosis, ask = false) {
  const resume = kind === 'castle' ? 'say castle go to resume' : 'say go work to resume'
  // (vmzq.66) a stranded house park asks for what unblocks it — logs, or stop.
  const suffix = ask ? `; ${resume} — drop me some logs or say stop` : `; ${resume}`
  return chatClipped(`${kind} parked at ${done}/${total} after 45 min without progress — `, suffix, diagnosis)
}

// Stranded wood at the park fork (vmzq.66): gather's staged search came
// back empty at the current log count — the owner can unblock with logs.
function woodStranded(ctx) {
  try {
    return !!require('./behaviours/explore').woodStranded(ctx)
  } catch (_) {
    return false
  }
}

function chatL3(kind, diagnosis) {
  return chatClipped(`${kind} parked for the day (${TASK_PARKS_PER_DAY} stalls) — `, '', diagnosis)
}

// Clamped stall advance; updates state in place, returns the billed ms
// (the commit window pauses by the same billed delta).
function addStall(state, now) {
  const lastAt = typeof state.lastAt === 'number' ? state.lastAt : now
  const billed = Math.min(Math.max(0, now - lastAt), STALL_TICK_CLAMP_MS)
  state.stallMs = (state.stallMs || 0) + billed
  state.lastAt = now
  return billed
}

// Placed-clock advance (vmzq.20): its own lastAt, so material-only ticks
// accrue it while the any-clock resets.
function addPlacedStall(state, now) {
  const lastAt = typeof state.placedLastAt === 'number' ? state.placedLastAt : now
  state.placedStallMs = (state.placedStallMs || 0) + Math.min(Math.max(0, now - lastAt), STALL_TICK_CLAMP_MS)
  state.placedLastAt = now
}

// L1 check + fire. Dedupes on the diagnosis string (sayBlocked precedent):
// a repeated identical diagnosis stays silent instead of re-chatting every
// 15 min; the throttle still moves so the next distinct diagnosis is fresh.
// The castle L1 runs on the placed clock (vmzq.20): material on hand keeps
// accruing it — flat placed progress with the bot busy still reports —
// while L2 and the gauge stay on the any-progress clock, so steady
// fetching never parks. The house has no material clock (falls back).
function maybeL1(bot, ctx, kind, done, total, state, now) {
  const ms = kind === 'castle' && typeof state.placedStallMs === 'number' ? state.placedStallMs : (state.stallMs || 0)
  if (ms < TASK_STALL_L1_MS) return
  if (state.lastL1At && now - state.lastL1At < TASK_STALL_L1_MS) return
  const diagnosis = diagnose(bot, ctx)
  if (diagnosis === state.lastL1Diag) {
    state.lastL1At = now
    return
  }
  const step = (ctx && ctx.step) || 'none'
  const rec = kind === 'castle' ? (ctx && ctx.castle) : (ctx && ctx.home)
  const parked = !!(rec && rec.taskPark)
  let rounds = 0
  try { rounds = (state && state.wd && state.wd.rounds) || 0 } catch (_) { rounds = 0 }
  try {
    console.log(`task ${kind} ${done}/${total} stall=${Math.floor(ms / 1000)}s${parked ? ' parked' : ''}${rounds > 0 ? ` rounds=${rounds}` : ''} step=${step} why=${diagnosis}`)
  } catch (_) { /* log best-effort */ }
  try {
    bot.chat(chatL1(kind, done, total, diagnosis, parked, rounds))
  } catch (_) { /* chat best-effort */ }
  try {
    metrics.taskStallTotal.inc({ task: kind, level: 'L1' })
  } catch (_) { /* counter best-effort */ }
  state.lastL1At = now
  state.lastL1Diag = diagnosis
}

function utcDay(now) {
  try {
    return new Date(now).toISOString().slice(0, 10)
  } catch (_) {
    return 'unknown'
  }
}

function savePark(bot, ctx) {
  try {
    require('./memory').save(bot, ctx)
  } catch (_) { /* park persistence best-effort */ }
}

// L2 park (vmzq.3): 45 eligible minutes without progress parks the task
// with the diagnosis. Castle reuses the castle-stop fields (st.parked, so
// castle status and castle go work unchanged); the house gets ctx.home.parked
// honoured by build/gather/craft (goal.js). The episode (taskPark) marks a
// TASK park — owner parks have none — and carries the auto-resume timer;
// the day history (parkHist) counts parks for the L3 latch. Both persist
// via memory.js, so a restart mid-park keeps the veto and the timer. The
// clock is NOT reset: the invariant still watches side work.
function parkTask(bot, ctx, kind, done, total, now) {
  try {
    const rec = kind === 'castle' ? (ctx && ctx.castle) : (ctx && ctx.home)
    if (!rec || typeof rec !== 'object' || rec.taskPark) return undefined
    // A park voids any forced step decide() has not consumed yet (vmzq.5):
    // the retry window is over, the vetoes own the menu now.
    if (ctx && typeof ctx === 'object') ctx.taskPlanStep = null
    // (vmzq.21) a park ends a live commitment window and orphans an
    // in-flight watchdog answer (clearPlan precedent).
    try {
      const g = ctx && ctx.goal
      if (g && g.commit) endCommit(bot, ctx, kind, ctx.task && ctx.task[kind], g.commit, 'preempted:park', now)
    } catch (_) { /* window best-effort */ }
    try {
      const st = ctx && ctx.task && ctx.task[kind]
      if (st && st.wd) { st.wd.pending = null; st.wd.answer = null }
    } catch (_) { /* watchdog best-effort */ }
    const diagnosis = diagnose(bot, ctx)
    const day = utcDay(now)
    const prev = rec.parkHist
    const n = (prev && prev.day === day && typeof prev.n === 'number' && prev.n >= 1)
      ? Math.min(prev.n + 1, 99)
      : 1
    rec.parkHist = { day, n }
    const latched = n >= TASK_PARKS_PER_DAY
    const diag = String(diagnosis || 'unknown')
    rec.taskPark = { at: now, auto: !latched, diag: diag.length > TASK_PARK_DIAG_MAX ? diag.slice(0, TASK_PARK_DIAG_MAX - 1) + '…' : diag }
    rec.parked = true
    try {
      console.log(`task ${kind} ${done}/${total} parked #${n}${latched ? ' latched' : ''} why=${diagnosis}`)
    } catch (_) { /* log best-effort */ }
    try {
      const ask = !latched && kind === 'house' && ownerOnline(bot) && woodStranded(ctx)
      bot.chat(latched ? chatL3(kind, diagnosis) : chatL2(kind, done, total, diagnosis, ask))
    } catch (_) { /* chat best-effort */ }
    try {
      metrics.taskStallTotal.inc({ task: kind, level: 'L2' })
      if (latched) metrics.taskStallTotal.inc({ task: kind, level: 'L3' })
    } catch (_) { /* counter best-effort */ }
    savePark(bot, ctx)
    return diagnosis
  } catch (_) { /* park never breaks the tick */ }
  return undefined
}

// A same-step answer is only forcible while the step is HELD (revmux 01
// core-1, 02 core-1): a running/done/failed-but-released ctx.step is what
// decide() would do anyway, so forcing it only resets the window.
// Retrying a hold is the planner's job, so a failed + holding step stays.
function planRetryable(ctx, bot) {
  try {
    const step = ctx && typeof ctx.step === 'string' ? ctx.step : null
    const status = ctx && typeof ctx.stepStatus === 'string' ? ctx.stepStatus : ''
    if (!step || !status.startsWith('failed')) return false
    const goal = require('./goal')
    return goal.failHolds(ctx, step, goal.goalText(goal.goalFacts(bot, ctx), ctx && ctx.home), bot)
  } catch (_) {
    return false
  }
}

// Plan menu: feasible + registered, failHolds IGNORED (retrying a held
// step is the point: at a stall the helping step is usually held), rest
// excluded (forcing rest is idling; an only-rest menu parks instead).
// ctx.step is excluded unless it is held (see planRetryable above).
function planMenu(bot, ctx) {
  const goal = require('./goal')
  const facts = goal.goalFacts(bot, ctx)
  const step = ctx && typeof ctx.step === 'string' ? ctx.step : null
  const retryable = step ? planRetryable(ctx, bot) : false
  return goal.STEP_ORDER.filter((n) => {
    if (n === 'rest' || n === 'fun') return false // the joke is never a stall answer (o95q R2)
    if (step && n === step && !retryable) return false
    try {
      return !!(goal.MENU[n] && goal.MENU[n].feasible(facts, bot, ctx) && goal.registered(n))
    } catch (_) {
      return false
    }
  })
}

// Plan state: the goal/situation/history object (owner idea): the goal +
// progress + the .2/.3 diagnosis + recent failures + stall minutes + the
// byte-identical per-tick facts text (no goal words are added to goalText
// itself — the tick path stays as is). Watchdog rounds add the decision
// history ring (last GOAL_HISTORY_KEPT rounds: choice, outcome, duration,
// goal delta); the legacy L2 call keeps its exact key shape.
function planState(bot, ctx, kind, done, total, state, withHistory) {
  let factsText = ''
  try {
    const goal = require('./goal')
    factsText = goal.goalText(goal.goalFacts(bot, ctx), ctx && ctx.home)
  } catch (_) {
    factsText = ''
  }
  let recent = []
  try {
    const fails = state && Array.isArray(state.fails) ? state.fails : []
    recent = fails.slice()
  } catch (_) {
    recent = []
  }
  let goalText = 'build home'
  try {
    goalText = goalTextFor(kind, ctx)
  } catch (_) {
    goalText = kind === 'castle' ? 'build castle' : 'build home'
  }
  let situation = ''
  try {
    situation = require('./situation').situationText(bot, ctx)
  } catch (_) {
    situation = 'unknown'
  }
  const out = {
    goal: goalText,
    progress: `${done}/${total}`,
    blocked_on: diagnose(bot, ctx),
    recent,
    since_min: Math.floor(((state && state.stallMs) || 0) / 60000),
    facts: factsText,
    situation,
  }
  // vhlb.3: fire-time only (planState is never on the tick path): voxel
  // slice + attempts + inventory + target, the same object for JEV and LLM.
  try {
    const { stallState } = require('./stall-state')
    Object.assign(out, stallState(bot, ctx, kind))
    if (out.world) console.log(`plan world dy+2..-2 ${out.world.join(' | ')}`)
  } catch (_) { /* rich state best-effort */ }
  if (withHistory) {
    let history = []
    try {
      history = Array.isArray(state && state.wd && state.wd.history) ? state.wd.history.slice() : []
    } catch (_) {
      history = []
    }
    out.history = history
  }
  return out
}

function planErrReason(err) {
  try {
    if (err && err.name === 'TimeoutError') return 'timeout'
    const msg = String((err && err.message) || err)
    if (/^(jev|llm) http/.test(msg)) return 'http'
    if (/^(jev|llm) missing/.test(msg)) return 'invalid'
    return 'error'
  } catch (_) {
    return 'error'
  }
}

// Top-3 probabilities for the plan line (stand-steps.js fmtProbs shape).
function fmtProbs(probs) {
  try {
    if (!probs || typeof probs !== 'object') return '?'
    const ks = Object.keys(probs).sort((a, b) => probs[b] - probs[a]).slice(0, 3)
    if (ks.length === 0) return '?'
    return ks.map((k) => `${k}:${Number(probs[k]).toFixed(2)}`).join(',')
  } catch (_) {
    return '?'
  }
}

// Fire the one async plan call for this stall run. Not on the tick path:
// the answer lands in onPlanAnswer and the next tick consumes it. Returns
// true when a call is in flight — the caller waits instead of parking.
// False means no planner (no plan() on the brain, an empty menu, or a
// menu that failed to build): park deterministically.
function tryPlan(bot, ctx, kind, done, total, state) {
  const brain = ctx && ctx.brain
  if (!brain || typeof brain.plan !== 'function') return false
  let menu = []
  try {
    menu = planMenu(bot, ctx)
  } catch (_) {
    return false
  }
  if (menu.length === 0) return false
  let criteria = {}
  let instructions = ''
  try {
    const goal = require('./goal')
    for (const n of menu) criteria[n] = STEP_EFFECT_TEXT[n] || goal.STEP_CRITERIA[n]
    instructions = goal.ASK_INSTRUCTIONS
  } catch (_) {
    return false
  }
  const seq = (state.planSeq = (state.planSeq || 0) + 1)
  state.planTried = true
  state.planPending = seq
  const req = { state: planState(bot, ctx, kind, done, total, state), instructions, criteria }
  Promise.resolve()
    .then(() => brain.plan(req))
    .then(
      (ans) => onPlanAnswer(ctx, kind, state, seq, ans, null),
      (err) => onPlanAnswer(ctx, kind, state, seq, null, err),
    )
  return true
}

// Plan resolver: stores the answer for the next tick. Stale answers
// (progress or a resume cleared the pending marker, or the task switched
// to a new state object) are dropped — the stall they planned for is over.
function onPlanAnswer(ctx, kind, state, seq, ans, err) {
  try {
    if (!ctx || !ctx.task || ctx.task[kind] !== state) return
    if (state.planPending !== seq) return
    state.planPending = null
    if (err || !ans || typeof ans.step !== 'string') {
      state.planAnswer = { park: err ? planErrReason(err) : 'invalid' }
      return
    }
    state.planAnswer = {
      step: ans.step,
      conf: typeof ans.confidence === 'number' ? ans.confidence : null,
      probs: ans.probabilities && typeof ans.probabilities === 'object' ? ans.probabilities : null,
      source: typeof ans.source === 'string' ? ans.source : 'jev',
    }
  } catch (_) { /* a dropped answer parks on the next tick */ }
}

// Pack snapshot for the strategic pack delta (idkcraft-u19u phase 2):
// the goalFacts counts the oqj5 wood-progress lesson needs, read twice
// (fire time vs the previous fire's baseline on the episode memo).
function stratPackOf(facts) {
  try {
    return {
      logs: (facts && facts.logs) | 0,
      planks: (facts && facts.planks) | 0,
      food: (facts && facts.food) | 0,
    }
  } catch (_) {
    return { logs: 0, planks: 0, food: 0 }
  }
}

// Strategic prompt state (idkcraft-u19u phase 2): planState() + the §1.2
// deltas (progressPct, packDelta vs the memo baseline, abilities, owed).
// Reads only — the caller owns the memo writes — so it stays unit-testable
// with a fake state. The stall-state inventory rides along as-is: it is
// already capped at the menu-gating kinds (pickaxe/axe/sword/logs/planks/
// cobble/coal/iron/torches/food/beds), never the full ~60-key goalFacts.
function goalPromptState(bot, ctx, kind, done, total, state) {
  const goal = require('./goal')
  const base = planState(bot, ctx, kind, done, total, state, true)
  const facts = goal.goalFacts(bot, ctx)
  const d = typeof done === 'number' ? done : (state && state.done)
  const t = typeof total === 'number' ? total : (state && state.total)
  base.progressPct = (typeof d === 'number' && typeof t === 'number' && t > 0)
    ? Math.max(0, Math.min(100, Math.round((d / t) * 100)))
    : null
  let prev = null
  try {
    prev = state && state.wd && state.wd.stratPack
  } catch (_) {
    prev = null
  }
  const pack = stratPackOf(facts)
  base.packDelta = {
    logs: pack.logs - ((prev && prev.logs) | 0),
    planks: pack.planks - ((prev && prev.planks) | 0),
    food: pack.food - ((prev && prev.food) | 0),
  }
  base.abilities = {
    pickaxe: (facts && facts.pickWord) || 'no',
    table: (facts && (facts.tablePlaced || facts.houseTable)) ? 'yes' : 'no',
    food: (facts && typeof facts.food === 'number' && facts.food < 6) ? 'hungry' : 'ok',
    sword: (facts && (facts.sword || 0) > 0) ? 'yes' : 'no',
  }
  base.owed = {
    table: !!(facts && facts.tableOwed),
    beds: (facts && facts.beds) || 'unknown',
    door: (facts && (facts.door || 0) > 0) ? 'yes' : 'no',
  }
  return base
}

// Strategic goal choice (idkcraft-u19u phase 2): one planState-shaped call
// over the watchdog option table, fired at the existing decision points
// (never per tick) — the fire is async (the plan() pattern, never a
// blocking ask), the FSM answers this tick, and the stored answer applies
// at a later re-decide when the episode, facts text and offered menu still
// match. Owned here (not goal.js) so the arbiter never requires the task
// layer (oqul.1); goal.js decide() delegates through ctx.strategicChoose,
// wired by taskTick below.

// Episode memo home: the watchdog state (wd-adjacent) — progress clears it
// via resetWdProgress/clearPlan, so no other lifecycle is needed. Created
// lazily; only strat* fields are ever written, never the watchdog's own.
function stratWd(state) {
  try {
    if (!state || typeof state !== 'object') return null
    if (!state.wd || typeof state.wd !== 'object') state.wd = {}
    return state.wd
  } catch (_) {
    return null
  }
}

function stratFailReason(err) {
  try {
    if (err && err.name === 'TimeoutError') return 'timeout'
    const msg = String((err && err.message) || err)
    if (/^(jev|llm) http/.test(msg)) return 'http'
    if (/^(jev|llm) missing/.test(msg)) return 'invalid'
    if (/^(jev|llm) budget/.test(msg)) return 'budget'
    return 'error'
  } catch (_) {
    return 'error'
  }
}

function stratFail(wd, model, reason) {
  try {
    metrics.escalation.inc({ from: model, to: 'fsm', reason })
  } catch (_) { /* counter best-effort */ }
  try {
    stratBackoff(wd, Date.now())
  } catch (_) { /* backoff best-effort */ }
}

// Stored-answer resolver: drops answers for a replaced task state, a moved
// memo key, or a moved-on goal — the stall they planned for is over.
function onStrategicAnswer(ctx, kind, state, wd, key, goalId, generation, seq, ans, err) {
  try {
    if (!ctx || !ctx.task || ctx.task[kind] !== state) return
    if (!wd || wd.stratKey !== key || wd.stratPending !== seq) return
    wd.stratPending = null
    const g = ctx.goal
    if (!g || g.id !== goalId || g.generation !== generation) return
    if (err || !ans || typeof ans.step !== 'string') {
      wd.stratStep = null
      stratFail(wd, wd.stratModel || 'model', err ? stratFailReason(err) : 'invalid')
      return
    }
    wd.stratStep = ans.step
    wd.stratConf = typeof ans.confidence === 'number' ? ans.confidence : null
    wd.stratProbs = ans.probabilities && typeof ans.probabilities === 'object' ? ans.probabilities : null
    wd.stratSource = (ans && typeof ans.source === 'string' && ans.source) || wd.stratModel || 'model'
  } catch (_) { /* a dropped answer runs the FSM */ }
}

// Memo-hit consume: the answer is validated against the feasible menu at
// consume time (re-checked NOW, not at fire). Out-of-menu, stale and failed
// validations drop the answer and take the FSM with an escalation count —
// never a forced step the menu cannot run.
function consumeStrategic(bot, ctx, kind, state, wd, facts, goal, text, offered, fsm, model, fail) {
  const step = wd.stratStep
  const opt = offered.find((o) => o && o.id === step) || null
  const drop = (reason) => {
    wd.stratStep = null
    return fail(reason)
  }
  // Unlock options (the *-far / house-* / bank set): step + unlock through
  // the existing commit path when still feasible under the unlock — the
  // window pins the next re-decides; this tick keeps the FSM.
  if (opt && opt.unlock && opt.step) {
    let ok = false
    try {
      const gopts = require('./goal-options')
      ok = !!goal.registered(opt.step) && !!gopts.probeFeasible(bot, ctx, opt.step, opt.unlock)
    } catch (_) {
      ok = false
    }
    if (ok) {
      try {
        applyCommit(bot, ctx, kind, opt.id, opt.step, Date.now(), opt.unlock, opt.criterion)
      } catch (_) { /* commit best-effort */ }
      return { step: fsm, source: 'goal-fsm', fsm, model: null }
    }
    return drop('stale')
  }
  // park / ask-owner / hold-*: the watchdog owns those forks (§4.2) — the
  // chooser only ever overrides a day work-menu pick.
  if (opt && (opt.id === 'park' || opt.id === 'ask-owner' || String(opt.id).indexOf('hold-') === 0)) {
    return drop('non-step')
  }
  let valid = false
  try {
    valid = typeof step === 'string' && !!goal.MENU[step] && step !== 'rest' &&
      !!goal.MENU[step].feasible(facts, bot, ctx) && goal.registered(step)
  } catch (_) {
    valid = false
  }
  if (!valid) return drop(opt ? 'stale' : 'invalid')
  // Low-confidence: the deterministic fallback, never a coin flip. Only a
  // plain feasible step is expressible as a one-tick pick; anything else
  // (or nothing) falls back to the FSM.
  if (typeof wd.stratConf === 'number' && wd.stratConf < TASK_PLAN_MIN_CONF) {
    let fb = null
    try {
      const hist = (state && state.wd && Array.isArray(state.wd.history)) ? state.wd.history : null
      const held = new Set()
      try {
        const sf = ctx && ctx.stepFail
        if (sf && typeof sf === 'object') {
          for (const k of Object.keys(sf)) {
            if (sf[k] && typeof sf[k].status === 'string' && sf[k].status.startsWith('failed:')) held.add(k)
          }
        }
      } catch (_) { /* held best-effort */ }
      fb = fallbackRank(kind, offered, hist, ctx && ctx.step, held)
    } catch (_) {
      fb = null
    }
    if (fb && fb.step && !fb.unlock && goal.MENU[fb.step] && fb.step !== 'rest') {
      let ok = false
      try {
        ok = !!goal.MENU[fb.step].feasible(facts, bot, ctx) && goal.registered(fb.step)
      } catch (_) {
        ok = false
      }
      if (ok) {
        if (fb.step !== fsm) {
          try {
            metrics.goalDisagreements.inc({ model: fb.step, fsm })
          } catch (_) { /* counter best-effort */ }
          try {
            console.error(`goal disagree source=fallback model=${fb.step} fsm=${fsm} menu=${offered.map((o) => o.id).join(',')} facts=${text}`)
          } catch (_) { /* log best-effort */ }
        }
        return { step: fb.step, source: 'fallback', fsm, model }
      }
    }
    return drop('low-confidence')
  }
  const source = wd.stratSource || model
  if (step !== fsm) {
    try {
      metrics.goalDisagreements.inc({ model: step, fsm })
    } catch (_) { /* counter best-effort */ }
    try {
      console.error(`goal disagree source=${source} model=${step} fsm=${fsm} menu=${offered.map((o) => o.id).join(',')} facts=${text}`)
    } catch (_) { /* log best-effort */ }
  }
  return { step, source, fsm, model }
}

// The task-owned strategic chooser: goal.js decide() delegates the
// multi-option day work-menu branch here. Returns a choice, or null when
// the table cannot be built (the caller falls through to the phase-1 ask
// plug). Fires at most one plan() per episode state: the same key never
// re-fires, and an in-flight call or a live backoff suppresses the fire —
// the FSM answers those ticks.
function strategicChoose(brain, facts, feasible, home, extra, fsm) {
  const bot = extra && extra.bot
  const ctx = extra && extra.ctx
  const kind = goalKind(ctx)
  if (kind !== 'castle' && kind !== 'house') return null
  const state = ctx && ctx.task && ctx.task[kind]
  if (!state || typeof state !== 'object') return null
  if (!brain || typeof brain.plan !== 'function') return null
  const wd = stratWd(state)
  if (!wd) return null
  const model = (brain && (brain.planner || brain.source || brain.name)) || 'model'
  let gopts = null
  try {
    gopts = require('./goal-options')
  } catch (_) {
    return null
  }
  let offered = null
  try {
    offered = gopts.goalOptions(bot, ctx, kind)
  } catch (_) {
    return null
  }
  if (!Array.isArray(offered) || offered.length === 0) return null
  let goal = null
  try {
    goal = require('./goal')
  } catch (_) {
    return null
  }
  const text = goal.goalText(facts, home)
  const g = ctx && ctx.goal
  const key = `${(g && g.id) || '?'}:${(g && typeof g.generation === 'number') ? g.generation : '?'}|${text}|${offered.map((o) => o.id).join(',')}`
  const fail = (reason) => {
    stratFail(wd, model, reason)
    return { step: fsm, source: 'fsm-fallback', fsm, model }
  }
  // Memo hit: same episode, same facts text, same offered menu.
  if (wd.stratKey === key && typeof wd.stratStep === 'string' && wd.stratStep) {
    return consumeStrategic(bot, ctx, kind, state, wd, facts, goal, text, offered, fsm, model, fail)
  }
  // Same key with no stored answer (in flight, or a fire that already
  // failed on this state): no second call.
  if (wd.stratKey === key) return { step: fsm, source: 'goal-fsm', fsm, model: null }
  // Cost guards: one call in flight per episode, and the backoff window.
  if (wd.stratPending) return { step: fsm, source: 'goal-fsm', fsm, model: null }
  try {
    if (Date.now() < (wd.stratBackoffUntil || 0)) return { step: fsm, source: 'goal-fsm', fsm, model: null }
  } catch (_) { /* guard best-effort */ }
  let prompt = null
  let instructions = ''
  try {
    prompt = goalPromptState(bot, ctx, kind, state.done, state.total, state)
    instructions = `${gopts.planInstructions(kind, ctx, state.done, state.total)} Prefer the option that moves the progress metric this window; park/ask-owner only when no option can.`
  } catch (_) {
    return null
  }
  const criteria = {}
  for (const o of offered) criteria[o.id] = o.criterion
  if (Object.keys(criteria).length === 0) return null
  const goalId = g && g.id
  const generation = g && g.generation
  const seq = (wd.stratSeq = (wd.stratSeq || 0) + 1)
  wd.stratPending = seq
  wd.stratKey = key
  wd.stratModel = model
  try {
    wd.stratPack = stratPackOf(facts)
  } catch (_) { /* baseline best-effort */ }
  const req = { state: prompt, instructions, criteria }
  Promise.resolve()
    .then(() => brain.plan(req))
    .then(
      (ans) => onStrategicAnswer(ctx, kind, state, wd, key, goalId, generation, seq, ans, null),
      (err) => onStrategicAnswer(ctx, kind, state, wd, key, goalId, generation, seq, null, err || new Error('strategic plan failed')),
    )
  return { step: fsm, source: 'goal-fsm', fsm, model: null }
}

// Deadlock escalation (idkcraft-u19u phase C): the work-mode twin of the
// task-executive watchdog. While a castle/house/order goal is active the
// executive owns escalation (strategic chooser + watchdog), so this yields
// there — check first, never double-fire. In work mode (no goal) there is
// no progress metric and no park target, so the detector reads the picks
// the tick already maintains: a rest-only stretch with owed needs past
// GOAL_WATCHDOG_MS, or an A→B→A action loop x3 within 10 min. Either fires
// ONE contextual plan() (the phase-2 prompt/memo/cost plumbing below),
// the answer applies as a bounded pick (cooldown ≤ 120 s, no new env),
// and every failure falls back to the FSM answer.
//
// Zero model calls while progressing: the only plan() site is the fire
// below, guarded by pending/answer/cooldown/backoff/min-interval, and the
// fire/consume/fail ticks return a choice directly, suppressing the
// phase-1 ask plug for that re-decide — one stall episode spends one call.
const DEADLOCK_LOOP_PICKS = 6 // A→B→A x3: 3 full cycles of 2 steps
const DEADLOCK_LOOP_WINDOW_MS = 10 * 60 * 1000
const DEADLOCK_CHAIN_KEPT = 8
const DEADLOCK_COMMIT_MAX_MS = 120000 // the commit window never exceeds 120 s

// Owed needs visible in facts (u19u §2.2): the rest-stretch gate. Health
// is deliberately absent — low-hp rest is safety, excluded at the call
// site, never a deadlock.
function deadlockUnmet(facts) {
  try {
    if (!facts || typeof facts !== 'object') return false
    if (facts.beds === 'none' || facts.beds === 'one') return true
    if (facts.gear === 'want') return true
    if (typeof facts.food === 'number' && facts.food < 6) return true
    if (typeof facts.pickaxe === 'number' && facts.pickaxe === 0) return true
    if (facts.known === 'near') return true
    if (typeof facts.unlit === 'number' && facts.unlit > 0) return true
  } catch (_) { /* no needs best-effort */ }
  return false
}

// Per-ctx work-mode counters (u19u §2.3: new counters only where no task
// executive exists). Lifecycle: any step-done resets (progress ends the
// episode); cooldown/backoff/firedAt survive (they bound calls, not state).
function deadlockOf(ctx) {
  try {
    if (!ctx || typeof ctx !== 'object') return null
    if (!ctx.deadlock || typeof ctx.deadlock !== 'object') {
      ctx.deadlock = { restSince: null, restPicks: 0, chain: [], lastStep: null, seq: 0, pending: null, answer: null, key: null, trigger: null, model: null, firedAt: 0, cooldownUntil: 0, rounds: 0 }
    }
    const dl = ctx.deadlock
    if (!Array.isArray(dl.chain)) dl.chain = []
    return dl
  } catch (_) {
    return null
  }
}

function deadlockReset(dl) {
  try {
    if (!dl || typeof dl !== 'object') return
    dl.restSince = null
    dl.restPicks = 0
    dl.chain = []
    dl.lastStep = null
    dl.pending = null
    dl.answer = null
    dl.key = null
    dl.trigger = null
    dl.rounds = 0
  } catch (_) { /* reset best-effort */ }
}

function deadlockLoopDescribe(dl) {
  try {
    return dl.chain.slice(-DEADLOCK_LOOP_PICKS).map((e) => e.step).join('->')
  } catch (_) {
    return '?'
  }
}

// Stored-answer resolver: drops answers for a replaced detector, a moved
// key, or a mode change — the stall they planned for is over (the
// onStrategicAnswer precedent).
function onDeadlockAnswer(ctx, dl, key, seq, ans, err) {
  try {
    if (!ctx || ctx.deadlock !== dl) return
    if (!dl || dl.pending !== seq || dl.key !== key) return
    dl.pending = null
    if (err || !ans || typeof ans.step !== 'string') {
      dl.answer = { error: err ? stratFailReason(err) : 'invalid' }
      return
    }
    dl.answer = {
      step: ans.step,
      conf: typeof ans.confidence === 'number' ? ans.confidence : null,
      probs: ans.probabilities && typeof ans.probabilities === 'object' ? ans.probabilities : null,
      source: typeof ans.source === 'string' && ans.source ? ans.source : null,
    }
  } catch (_) { /* a dropped answer re-fires on the next stall */ }
}

// Fire ONE contextual plan(): the phase-2 goalPromptState shape (a house
// kind stands in for the missing task goal; progressPct reads null without
// done/total) with the deadlock goal line and the restWhy string as
// blocked_on detail, over the feasible menu in effect language + park.
// Returns the episode key, or null when no call was made.
function deadlockFire(bot, ctx, brain, facts, home, names, text, dl, model, now, trigger, stallMs) {
  let goal = null
  try {
    goal = require('./goal')
  } catch (_) {
    return null
  }
  const criteria = {}
  const offered = []
  for (const n of names) {
    if (n === 'rest' || n === 'fun') continue // retrying idleness never unsticks (planMenu precedent)
    try {
      const c = STEP_EFFECT_TEXT[n] || goal.STEP_CRITERIA[n]
      if (typeof c === 'string' && c) {
        criteria[n] = c
        offered.push(n)
      }
    } catch (_) { /* criterion best-effort */ }
  }
  criteria.park = PLAN_PARK_CRITERION
  if (offered.length === 0) return null
  let prompt = null
  try {
    prompt = goalPromptState(bot, ctx, 'house', undefined, undefined, { stallMs, fails: [], wd: dl })
    prompt.goal = 'unstick the work loop'
    let rest = ''
    try {
      rest = String(goal.restWhy(facts, bot, ctx, names) || '')
    } catch (_) {
      rest = ''
    }
    const diag = diagnose(bot, ctx)
    prompt.blocked_on = trigger === 'loop'
      ? `${diag} | loop: ${deadlockLoopDescribe(dl)} | rest: ${rest}`
      : `${diag} | rest: ${rest}`
  } catch (_) {
    return null
  }
  let instructions = ''
  try {
    instructions = `${PLAN_INSTRUCTIONS}; prefer the owed need the facts name`
  } catch (_) {
    return null
  }
  const key = `${text}|${offered.join(',')}|${trigger}`
  const seq = (dl.seq = (dl.seq || 0) + 1)
  dl.pending = seq
  dl.key = key
  dl.trigger = trigger
  dl.firedAt = now
  dl.model = model
  try {
    dl.stratPack = stratPackOf(facts)
  } catch (_) { /* baseline best-effort */ }
  const req = { state: prompt, instructions, criteria }
  Promise.resolve()
    .then(() => brain.plan(req))
    .then(
      (ans) => onDeadlockAnswer(ctx, dl, key, seq, ans, null),
      (err) => onDeadlockAnswer(ctx, dl, key, seq, null, err || new Error('deadlock plan failed')),
    )
  try {
    console.log(`goal deadlock kind=work trigger=${trigger} stall=${Math.floor(stallMs / 1000)}s options=${offered.join(',')} choice=fired source=${model} why=${prompt.blocked_on}`)
  } catch (_) { /* log best-effort */ }
  return key
}

// Consume a stored answer: validate against the feasible menu NOW (not at
// fire), apply as a bounded pick, or FSM-fallback with an escalation count
// on any failure — the bot never stalls on the escalation.
function deadlockConsume(bot, ctx, facts, home, names, dl, fsm, model, now) {
  const ans = dl.answer
  dl.answer = null
  let goal = null
  try {
    goal = require('./goal')
  } catch (_) {
    return null
  }
  const fail = (reason) => {
    try {
      metrics.escalation.inc({ from: model, to: 'fsm', reason })
    } catch (_) { /* counter best-effort */ }
    try {
      stratBackoff(dl, now)
    } catch (_) { /* backoff best-effort */ }
    try {
      console.log(`goal deadlock kind=work trigger=${dl.trigger || '?'} options=${names.join(',')} choice=none conf=? source=${model} why=${reason} ${diagnose(bot, ctx)}`)
    } catch (_) { /* log best-effort */ }
    return { step: fsm, source: 'fsm-fallback', fsm, model }
  }
  // Safety cut-through (pinMenu precedent): a night answer owns the body —
  // the stalled-day answer drops and the night rule picks below.
  let safety = null
  try {
    safety = goal.goalFsm(facts, names)
  } catch (_) {
    safety = null
  }
  if (safety === 'stay' || safety === 'gohome' || safety === 'shelter') {
    try {
      console.log(`goal deadlock kind=work trigger=${dl.trigger || '?'} choice=dropped source=night why=${diagnose(bot, ctx)}`)
    } catch (_) { /* log best-effort */ }
    return null
  }
  const choice = ans && ans.step
  if (!ans || ans.error) return fail((ans && ans.error) || 'invalid')
  if (choice === 'park' || choice === 'ask-owner') {
    // Work mode has no task to park: the round still counts and the window
    // still bounds, the FSM simply runs on.
    dl.rounds = (dl.rounds || 0) + 1
    dl.cooldownUntil = now + Math.min(goalCommitMs(), DEADLOCK_COMMIT_MAX_MS)
    try {
      console.log(`goal deadlock kind=work trigger=${dl.trigger || '?'} options=${names.join(',')} choice=${choice} conf=${typeof ans.conf === 'number' ? ans.conf.toFixed(2) : '?'} source=${ans.source || model} why=${diagnose(bot, ctx)}`)
    } catch (_) { /* log best-effort */ }
    try {
      metrics.goalWatchdogTotal.inc({ kind: 'work', choice, source: ans.source || model })
    } catch (_) { /* counter best-effort */ }
    return { step: fsm, source: 'goal-fsm', fsm, model: null }
  }
  let valid = false
  try {
    valid = typeof choice === 'string' && choice !== 'rest' && choice !== 'fun' &&
      names.includes(choice) && !!goal.MENU[choice] &&
      !!goal.MENU[choice].feasible(facts, bot, ctx) && goal.registered(choice)
  } catch (_) {
    valid = false
  }
  if (!valid) return fail(names.includes(choice) ? `stale:${choice}` : 'invalid')
  if (typeof ans.conf === 'number' && ans.conf < TASK_PLAN_MIN_CONF) {
    return fail(`low-confidence conf=${ans.conf.toFixed(2)}`)
  }
  const conf = typeof ans.conf === 'number' ? ans.conf.toFixed(2) : '?'
  const source = ans.source || model
  dl.rounds = (dl.rounds || 0) + 1
  dl.cooldownUntil = now + Math.min(goalCommitMs(), DEADLOCK_COMMIT_MAX_MS)
  try {
    console.log(`goal deadlock kind=work trigger=${dl.trigger || '?'} options=${names.join(',')} choice=${choice} conf=${conf} source=${source} why=${diagnose(bot, ctx)}`)
  } catch (_) { /* log best-effort */ }
  try {
    metrics.goalWatchdogTotal.inc({ kind: 'work', choice, source })
  } catch (_) { /* counter best-effort */ }
  if (choice !== fsm) {
    try {
      metrics.goalDisagreements.inc({ model: choice, fsm })
    } catch (_) { /* counter best-effort */ }
    try {
      console.error(`goal disagree source=${source} model=${choice} fsm=${fsm} menu=${names.join(',')}`)
    } catch (_) { /* log best-effort */ }
  }
  return { step: choice, source: 'deadlock-plan', fsm, model: source }
}

// The work-mode deadlock chooser: goal.js decide() delegates here through
// ctx (the strategicChoose wiring precedent — the arbiter never requires
// the task layer, oqul.1). Returns a choice on fire/consume/fail ticks
// (the phase-1 ask plug is suppressed: one episode spends one call), or
// null when the existing path runs unchanged.
function deadlockChoose(brain, facts, feasible, home, extra, fsm) {
  const bot = extra && extra.bot
  const ctx = extra && extra.ctx
  // The task executive owns goal kinds: yield before any observation, and
  // a mode change ends the work episode.
  let kind = null
  try {
    kind = goalKind(ctx)
  } catch (_) {
    kind = null
  }
  if (kind) {
    try {
      if (ctx && ctx.deadlock) deadlockReset(ctx.deadlock)
    } catch (_) { /* reset best-effort */ }
    return null
  }
  if (!brain || typeof brain.plan !== 'function') return null
  // 0 = off (the shipped ladder, the rollback — the watchdogOn precedent).
  if (!watchdogOn()) return null
  const dl = deadlockOf(ctx)
  if (!dl) return null
  const model = (brain && (brain.planner || brain.source || brain.name)) || 'model'
  let goal = null
  try {
    goal = require('./goal')
  } catch (_) {
    return null
  }
  const now = Date.now()
  const names = STEP_ORDER.filter((n) => Array.isArray(feasible) && feasible.includes(n))
  let text = ''
  try {
    text = goal.goalText(facts, home)
  } catch (_) {
    text = ''
  }
  // stepStatus parses go through step.js (failReason/isFinished): a
  // finished stall is moot — any step-done resets the episode and drops a
  // late answer (the resolver's pending check plus this reset).
  const status = (ctx && typeof ctx.stepStatus === 'string') ? ctx.stepStatus : null
  let done = false
  try {
    done = !!status && isFinished(status) && failReason(status) === null
  } catch (_) {
    done = false
  }
  if (done) {
    deadlockReset(dl)
    return null
  }
  // Consume-first (the maybeWatchdog precedent): an answer resolves on
  // this re-decide, never a second call in flight.
  if (dl.answer) return deadlockConsume(bot, ctx, facts, home, names, dl, fsm, model, now)
  if (dl.pending) return null
  // A live commitment window (defensive: work mode founds no goal, but a
  // window from a just-finished order must not be doubled).
  try {
    const g = ctx && ctx.goal
    if (g && g.commit) return null
  } catch (_) { /* window best-effort */ }
  if (now < (dl.cooldownUntil || 0)) return null
  try {
    if (now < (dl.stratBackoffUntil || 0)) return null
  } catch (_) { /* guard best-effort */ }
  const W = goalWatchdogMs()
  if (now - (dl.firedAt || 0) < W) return null
  // Observe the applied pick: a transition extends the loop chain. A work
  // pick (e.g. a classifier override) also ends a rest stretch — only
  // consecutive rest keeps it.
  const cur = (ctx && typeof ctx.step === 'string') ? ctx.step : null
  if (cur && dl.lastStep && cur !== dl.lastStep) {
    dl.chain.push({ step: cur, at: now })
    while (dl.chain.length > DEADLOCK_CHAIN_KEPT) dl.chain.shift()
  }
  if (cur) dl.lastStep = cur
  if (cur && cur !== 'rest') {
    dl.restSince = null
    dl.restPicks = 0
  }
  // Rest stretch: consecutive eligible rest answers with owed needs.
  // Excluded: night rest by design, low-hp-gated rest (safety, not
  // deadlock), parked-task rest.
  let eligibleRest = false
  try {
    eligibleRest = fsm === 'rest' && facts && facts.time === 'day' &&
      !goal.lowHpGated(bot, facts, ctx) && !goal.taskParked(ctx) &&
      deadlockUnmet(facts)
  } catch (_) {
    eligibleRest = false
  }
  if (fsm === 'rest' && eligibleRest) {
    if (dl.restSince == null) {
      dl.restSince = now
      dl.restPicks = 1
    } else {
      dl.restPicks += 1
    }
  } else if (fsm !== 'rest' || (cur && cur !== 'rest')) {
    dl.restSince = null
    dl.restPicks = 0
  } else {
    // Ineligible rest (night / low-hp / parked / needs met): a boundary
    // ends the day episode — pause, do not count.
    dl.restSince = null
    dl.restPicks = 0
  }
  // Loop: 3 full A→B→A cycles (6 alternating picks of 2 steps) within
  // 10 min, without an intervening done (resets above).
  let loop = false
  try {
    const c = dl.chain
    if (c.length >= DEADLOCK_LOOP_PICKS) {
      const last6 = c.slice(-DEADLOCK_LOOP_PICKS)
      const distinct = [...new Set(last6.map((e) => e.step))]
      loop = distinct.length === 2 &&
        last6.every((e, i) => i === 0 || e.step !== last6[i - 1].step) &&
        (now - last6[0].at) <= DEADLOCK_LOOP_WINDOW_MS
    }
  } catch (_) {
    loop = false
  }
  const restReady = eligibleRest && dl.restSince != null && (now - dl.restSince) >= W
  if (!restReady && !loop) return null
  // Round cap (goalMaxRounds, the watchdog resolution): work mode has no
  // task to park or switch — the FSM, already the safe default, runs on
  // with a line and a fresh episode.
  if ((dl.rounds || 0) >= goalMaxRounds()) {
    try {
      console.log(`goal deadlock kind=work trigger=${restReady ? 'rest-stretch' : 'loop'} choice=none source=max-rounds why=${diagnose(bot, ctx)}`)
    } catch (_) { /* log best-effort */ }
    dl.rounds = 0
    dl.restSince = null
    dl.restPicks = 0
    dl.chain = []
    dl.cooldownUntil = now + Math.min(goalCommitMs(), DEADLOCK_COMMIT_MAX_MS)
    return null
  }
  const trigger = restReady ? 'rest-stretch' : 'loop'
  const stallMs = restReady
    ? (now - dl.restSince)
    : (now - dl.chain[dl.chain.length - DEADLOCK_LOOP_PICKS].at)
  const fired = deadlockFire(bot, ctx, brain, facts, home, names, text, dl, model, now, trigger, stallMs)
  if (!fired) return null
  // This tick takes the FSM answer: the episode spends exactly ONE call.
  return { step: fsm, source: 'goal-fsm', fsm, model: null }
}

// Night hold (idkcraft-vd93): from dusk to home arrival the night rule
// owns the body — a running night step, or dusk/night whose ordinary-menu
// answer is a night step. The planner must not pin over it; the arbiter
// (goal.js pinMenu) degrades any surviving pin the same way.
function nightHoldsBody(bot, ctx) {
  try {
    if (ctx && (ctx.step === 'stay' || ctx.step === 'gohome' || ctx.step === 'shelter') &&
      ctx.stepStatus === 'running') return true
    const goal = require('./goal')
    const facts = goal.goalFacts(bot, ctx)
    if (!facts || (facts.time !== 'dusk' && facts.time !== 'night')) return false
    const text = goal.goalText(facts, ctx && ctx.home)
    const names = Object.keys(goal.MENU).filter((n) => {
      try {
        if (!goal.MENU[n].feasible(facts, bot, ctx) || !goal.registered(n)) return false
      } catch (_) {
        return false
      }
      return !goal.failHolds(ctx, n, text, bot)
    })
    const safety = goal.goalFsm(facts, names)
    return safety === 'stay' || safety === 'gohome' || safety === 'shelter'
  } catch (_) {
    return false
  }
}

// Consume a stored plan answer: force a valid confident step one-shot
// (fresh stall window; decide() honours ctx.taskPlanStep), or park
// deterministically on any failure. Returns the park diagnosis when it
// parked, null when it forced a step.
function consumePlan(bot, ctx, kind, done, total, state, now) {
  const ans = state.planAnswer
  // Night hold (idkcraft-vd93): never pin over the dusk march or the stay
  // handoff (prod 2026-10-28: a pin stole gohome mid-march and the bot
  // worked all night). Wait it out: no pin and no park while the night
  // owns the body (the stall clock is paused at night) — the answer stays
  // queued and the freshness/confidence checks below re-validate it when
  // the hold ends. Dropping it instead would park at the next L2 with the
  // episode's planTried spent.
  if (nightHoldsBody(bot, ctx)) {
    try {
      console.log(`task plan kind=${kind} progress=${done}/${total} source=${(ans && ans.source) || 'jev'} answer=held why=night-hold`)
    } catch (_) { /* log best-effort */ }
    return null
  }
  state.planAnswer = null
  const parkFallback = (why) => {
    try {
      console.log(`task plan kind=${kind} progress=${done}/${total} source=${(ans && ans.source) || 'jev'} answer=park why=${why}`)
    } catch (_) { /* log best-effort */ }
    try {
      metrics.taskPlanTotal.inc({ answer: 'park' })
    } catch (_) { /* counter best-effort */ }
    const diagnosis = parkTask(bot, ctx, kind, done, total, now)
    return diagnosis === undefined ? 'unknown' : diagnosis
  }
  let step = ans && typeof ans.step === 'string' ? ans.step : null
  if (step) {
    try {
      const goal = require('./goal')
      if (!goal.MENU[step] || step === 'rest') step = null
    } catch (_) {
      step = null
    }
  }
  if (!step) return parkFallback((ans && ans.park) || 'invalid')
  // Same-step stay (revmux 01 core-1, 02 core-1): an unheld ctx.step is
  // not offered, so an answer naming it is off-menu — park instead of
  // resetting the window for the loop that just stalled. A failed +
  // holding step passes (the hold-retry carve-out).
  if (ctx && step === ctx.step && !planRetryable(ctx, bot)) return parkFallback('same-step')
  // Stale answer (revmux 01 core-1): the menu moved between the call and
  // the consume tick, so decide() would degrade the force to the normal
  // menu — park instead of resetting the window for a force that cannot
  // apply. Holds are NOT consulted (same rule as decide()'s force path).
  let fresh = false
  try {
    const goal = require('./goal')
    const facts = goal.goalFacts(bot, ctx)
    fresh = !!(goal.MENU[step] && goal.MENU[step].feasible(facts, bot, ctx) && goal.registered(step))
  } catch (_) {
    fresh = false
  }
  if (!fresh) return parkFallback('stale')
  if (typeof ans.conf === 'number' && ans.conf < TASK_PLAN_MIN_CONF) {
    return parkFallback(`low-confidence conf=${ans.conf.toFixed(2)}`)
  }
  ctx.taskPlanStep = step
  state.stallMs = 0
  state.lastAt = now
  state.placedStallMs = 0
  state.placedLastAt = now
  state.lastL1At = null
  state.lastL1Diag = null
  // planTried stays: the forced step gets one fresh window, then the
  // deterministic park (at most one plan call per stall episode).
  setStallGauge(kind, 0)
  try {
    const conf = typeof ans.conf === 'number' ? ans.conf.toFixed(2) : '?'
    console.log(`task plan kind=${kind} progress=${done}/${total} source=${ans.source || 'jev'} answer=${step} conf=${conf} probs=${fmtProbs(ans.probs)}`)
  } catch (_) { /* log best-effort */ }
  try {
    console.log(`task plan disagree kind=${kind} plan=${step} rule=park`)
  } catch (_) { /* log best-effort */ }
  try {
    metrics.taskPlanTotal.inc({ answer: step })
  } catch (_) { /* counter best-effort */ }
  return null
}

// A plan in flight (or an unconsumed answer) belongs to the stall that
// fired it: progress ends that stall, so the next one plans fresh. The
// pending-marker clear orphans the late answer (onPlanAnswer drops it).
function clearPlan(state) {
  try {
    if (state && typeof state === 'object') {
      state.planTried = false
      state.planPending = null
      state.planAnswer = null
      // Strategic-chooser memo (idkcraft-u19u phase 2): same lifecycle as
      // the plan it shadows — progress ends the stall it was fired for.
      const wd = state.wd
      if (wd && typeof wd === 'object') {
        wd.stratKey = null
        wd.stratPack = null
        wd.stratStep = null
        wd.stratConf = null
        wd.stratProbs = null
        wd.stratSource = null
        wd.stratModel = null
        wd.stratPending = null
      }
    }
  } catch (_) { /* clear best-effort */ }
}

// Watchdog round state, lazily attached per task (vmzq.21): consecutive
// flat rounds, the decision history ring, the in-flight marker, the last
// fire time (the min call interval), the failure backoff, the travel
// grace stamps (grants this episode + floor + run tracking), the plan-B
// phase, and the low-confidence streak for the deterministic fallback
// (vmzq.28: count + goal identity it belongs to).
function wdOf(state) {
  try {
    if (!state.wd || typeof state.wd !== 'object') {
      state.wd = { rounds: 0, history: [], seq: 0, pending: null, answer: null, firedAt: 0, backoffMs: 0, backoffUntil: 0, graceRuns: 0, lastGraceAt: 0, lastStep: null, planb: null, lowConf: 0, lowConfGoal: null }
    }
    if (!Array.isArray(state.wd.history)) state.wd.history = []
    if (typeof state.wd.lowConf !== 'number') state.wd.lowConf = 0
    return state.wd
  } catch (_) {
    return { rounds: 0, history: [], seq: 0, pending: null, answer: null, firedAt: 0, backoffMs: 0, backoffUntil: 0, graceRuns: 0, lastGraceAt: 0, lastStep: null, planb: null, lowConf: 0, lowConfGoal: null }
  }
}

// Reset the progress-linked watchdog counters (rounds + the low-confidence
// streak): any goal-result advance starts a fresh stall episode.
function resetWdProgress(wd) {
  try {
    if (wd && typeof wd === 'object') {
      wd.rounds = 0
      wd.lowConf = 0
      wd.lowConfGoal = null
      // Strategic-chooser memo (idkcraft-u19u phase 2): progress ends the
      // episode the stored answer was fired for.
      wd.stratKey = null
      wd.stratPack = null
      wd.stratStep = null
      wd.stratConf = null
      wd.stratProbs = null
      wd.stratSource = null
      wd.stratModel = null
      wd.stratPending = null
    }
  } catch (_) { /* reset best-effort */ }
}

// Strategic-chooser backoff (idkcraft-u19u phase 2): the same 30 s doubling
// to 5 min as the watchdog transport backoff, on its own fields so a
// chooser failure never delays the deadlock-escalation fire.
function stratBackoff(wd, now) {
  try {
    if (!wd || typeof wd !== 'object') return
    const next = wd.stratBackoffMs ? Math.min(wd.stratBackoffMs * 2, GOAL_BACKOFF_MAX_MS) : GOAL_BACKOFF_MIN_MS
    wd.stratBackoffMs = next
    wd.stratBackoffUntil = (typeof now === 'number' ? now : Date.now()) + next
  } catch (_) { /* backoff best-effort */ }
}

// Watchdog menu (.22): the option table ids (plain steps + costed
// unlocks + park + ask-owner). The .21 shape (feasible steps + park) is
// the table's subset for work goals without unlocks; orders get hold +
// unlocks. `kind` selects the table; omitted keeps the .21 menu for
// callers that predate orders (none in-tree, tests use taskTick).
function watchdogMenu(bot, ctx, kind = null) {
  if (kind && (kind === 'castle' || kind === 'house' || isOrderKind(kind))) {
    try {
      const { goalOptions } = require('./goal-options')
      return goalOptions(bot, ctx, kind).map((o) => o.id)
    } catch (_) { /* fall through to the .21 menu */ }
  }
  const goal = require('./goal')
  const facts = goal.goalFacts(bot, ctx)
  const steps = goal.STEP_ORDER.filter((n) => {
    if (n === 'rest' || n === 'fun') return false // the joke is never a stall answer (o95q R2)
    try {
      return !!(goal.MENU[n] && goal.MENU[n].feasible(facts, bot, ctx) && goal.registered(n))
    } catch (_) {
      return false
    }
  })
  steps.push('park')
  return steps
}

// Fire one async watchdog round for a flat goal. Off the tick path like
// tryPlan: the answer lands in onWatchAnswer, the next tick consumes it.
// (.22) the menu is the option table, the instructions are per-kind, and
// unavailable options log their reason (so the model never picks a
// promise the executor cannot keep).
function fireWatchdog(bot, ctx, kind, done, total, state, wd, now) {
  let opts = []
  const skips = []
  try {
    const { goalOptions, planInstructions } = require('./goal-options')
    opts = goalOptions(bot, ctx, kind, skips)
    if (opts.length === 0) return
    const criteria = {}
    for (const o of opts) criteria[o.id] = o.criterion
    const instructions = planInstructions(kind, ctx, done, total)
    for (const s of skips) {
      try {
        console.log(`goal options kind=${kind} skip=${s.id} why=${s.why}`)
      } catch (_) { /* log best-effort */ }
    }
    const g = ctx && ctx.goal
    const goalId = g && g.id
    const generation = g && g.generation
    const seq = (wd.seq = (wd.seq || 0) + 1)
    wd.pending = seq
    wd.firedAt = now
    // Stash the fired table for the consume tick (availability re-checked
    // then; the stash is the offered set for the log line).
    wd.firedOpts = opts.map((o) => o.id)
    const req = { state: planState(bot, ctx, kind, done, total, state, true), instructions, criteria }
    const brain = ctx.brain
    Promise.resolve()
      .then(() => brain.plan(req))
      .then(
        (ans) => onWatchAnswer(ctx, kind, state, wd, seq, goalId, generation, ans, null),
        (err) => onWatchAnswer(ctx, kind, state, wd, seq, goalId, generation, null, err),
      )
    return
  } catch (_) { /* fall through to the .21 path when the table fails */ }
  let menu = []
  try {
    menu = watchdogMenu(bot, ctx)
  } catch (_) {
    return
  }
  if (menu.length === 0) return
  let criteria = {}
  try {
    const goal = require('./goal')
    for (const n of menu) criteria[n] = n === 'park' ? PLAN_PARK_CRITERION : (STEP_EFFECT_TEXT[n] || goal.STEP_CRITERIA[n])
  } catch (_) {
    return
  }
  const g = ctx && ctx.goal
  const goalId = g && g.id
  const generation = g && g.generation
  const seq = (wd.seq = (wd.seq || 0) + 1)
  wd.pending = seq
  wd.firedAt = now
  const req = { state: planState(bot, ctx, kind, done, total, state, true), instructions: PLAN_INSTRUCTIONS, criteria }
  const brain = ctx.brain
  Promise.resolve()
    .then(() => brain.plan(req))
    .then(
      (ans) => onWatchAnswer(ctx, kind, state, wd, seq, goalId, generation, ans, null),
      (err) => onWatchAnswer(ctx, kind, state, wd, seq, goalId, generation, null, err),
    )
}

// Watchdog resolver: stores the answer for the next tick. Stale answers
// (a new state object, a cleared pending marker, or a moved-on goal
// identity) are dropped — the stall they planned for is over.
function onWatchAnswer(ctx, kind, state, wd, seq, goalId, generation, ans, err) {
  try {
    if (!ctx || !ctx.task || ctx.task[kind] !== state) return
    if (!wd || wd.pending !== seq) return
    wd.pending = null
    const g = ctx.goal
    if (!g || g.id !== goalId || g.generation !== generation) return
    if (err || !ans || typeof ans.step !== 'string') {
      wd.answer = { error: err ? planErrReason(err) : 'invalid' }
      return
    }
    wd.answer = {
      step: ans.step,
      conf: typeof ans.confidence === 'number' ? ans.confidence : null,
      probs: ans.probabilities && typeof ans.probabilities === 'object' ? ans.probabilities : null,
      source: typeof ans.source === 'string' ? ans.source : 'jev',
      reason: typeof ans.reason === 'string' && ans.reason ? ans.reason : null,
    }
  } catch (_) { /* a dropped answer re-fires on the next tick */ }
}

// Consume a stored watchdog answer: apply the choice as a bounded
// commitment, park on a park choice (owner online) or plan-B when alone
// (owner: plan-B replaces the alone-park), ask-owner chats and waits, or
// back off on any failure. Every resolution logs one `goal watchdog` line
// with its metric increment. An answer whose stall resolved mid-call
// (progress after the fire) is moot: dropped silently, no pin and no
// backoff (a drop is not a failure — the next stall fires fresh).
// (.22) the choice is an optionId from the table (plain step, hold-<order>,
// *-far, house-<step>, bank, park, ask-owner); the commit carries step+unlock.
// Deterministic fallback ranking (idkcraft-vmzq.28): when JEV cannot
// decide (low-confidence/none twice for the same flat goal), take the
// top-ranked PROGRESS option — never park/ask-owner (they stall by
// design). Tiers: targeted far/unblock first (bank, demand-matched far),
// then the goal chain in FSM order, then the blind work spiral, then a
// non-wood far dig (vmzq.65), then side plain steps, then house side
// work, then the order hold retry.
// Options that already went flat or failed in the passed history and
// held (failed) steps sort last within their tier — but one is still
// picked when everything went flat, so there is no dead end. The
// currently stalling step itself is never picked (vmzq.35, prod: the
// fallback re-chose the running castle step twice, a no-op); with
// nothing else left the caller takes the park fork. Returns the top
// option or null.
const FALLBACK_FAR_ORDER = ['bank', 'castlefetch-far', 'gather-far', 'forage-far', 'explore-far']
const FALLBACK_FLAT_PENALTY = 10000
// Chain steps per work kind: the STEP_EFFECT +metric/+chain set, plus the
// night safety steps (a dusk stall must march/shelter, never blind-walk).
const FALLBACK_CHAIN = {
  // gocastle (idkcraft-vmzq.50): the displaced return walk — STEP_ORDER
  // ranks it first of the chain, so a far stall falls back to walking
  // back, never to fetching at spawn.
  castle: new Set(['gocastle', 'castlefetch', 'castle', 'craft', 'equip', 'gather', 'stay', 'gohome', 'shelter']),
  house: new Set(['build', 'beds', 'craft', 'equip', 'light', 'gather', 'stay', 'gohome', 'shelter']),
}
function fallbackRank(kind, offered, history = null, currentStep = null, held = null) {
  try {
    const list = Array.isArray(offered) ? offered.slice() : []
    const progress = list.filter((o) => o && o.id !== 'park' && o.id !== 'ask-owner' && !(currentStep && o.id === currentStep))
    if (progress.length === 0) return null
    let stepOrder = []
    try {
      stepOrder = STEP_ORDER || []
    } catch (_) { /* FSM order best-effort */ }
    const flat = new Set()
    try {
      if (Array.isArray(history)) {
        for (const h of history) {
          if (h && typeof h.choice === 'string' && (h.outcome === 'flat' || (typeof h.outcome === 'string' && h.outcome.startsWith('failed:')))) {
            flat.add(h.choice)
          }
        }
      }
      if (held instanceof Set) {
        for (const id of held) {
          if (typeof id === 'string' && id) flat.add(id)
        }
      } else if (Array.isArray(held)) {
        for (const id of held) {
          if (typeof id === 'string' && id) flat.add(id)
        }
      }
    } catch (_) { /* flat set best-effort */ }
    const isWork = kind === 'castle' || kind === 'house'
    const chain = (isWork && FALLBACK_CHAIN[kind]) || null
    const stepIdx = (o) => {
      const i = stepOrder.indexOf(o.step || o.id)
      return i === -1 ? stepOrder.length : i
    }
    const score = (o) => {
      let s = 0
      const far = FALLBACK_FAR_ORDER.indexOf(o.id)
      // A far dig that is not wood trails the blind spiral for work kinds
      // (vmzq.65: the fallback dug iron for a wood-short house). Options
      // without the wood flag keep the old rank.
      const woodlessForageFar = isWork && o.id === 'forage-far' && o.wood === false
      if (far !== -1 && !(isWork && o.id === 'explore-far') && !woodlessForageFar) {
        s = far
      } else if (isWork && o.id === 'explore-far') {
        s = 200
      } else if (woodlessForageFar) {
        s = 250
      } else if (o.id === 'house-build' || o.id === 'house-beds') {
        s = 400
      } else if (typeof o.id === 'string' && o.id.startsWith('hold-')) {
        s = 500
      } else if (chain && chain.has(o.step || o.id)) {
        s = 100 + stepIdx(o)
      } else {
        s = 300 + stepIdx(o)
      }
      if (flat.has(o.id)) s += FALLBACK_FLAT_PENALTY
      return s
    }
    progress.sort((a, b) => score(a) - score(b))
    return progress[0]
  } catch (_) {
    return null
  }
}

function consumeWatchdog(bot, ctx, kind, done, total, state, wd, now) {
  const ans = wd.answer
  wd.answer = null
  if ((state && state.lastProgressAt) > (wd.firedAt || 0)) return
  const g = ctx && ctx.goal
  const id = (g && g.id) || '?'
  const stallS = Math.floor((state.stallMs || 0) / 1000)
  const round = (wd.rounds || 0) + 1
  const step = (ctx && ctx.step) || 'none'
  let options = ''
  try {
    if (Array.isArray(wd.firedOpts) && wd.firedOpts.length > 0) options = wd.firedOpts.join(',')
    else options = watchdogMenu(bot, ctx, kind).join(',')
  } catch (_) {
    options = ''
  }
  // LLM planner reason (vhlb.2): rides the decided watchdog line and is
  // chatted once per answer; JEV answers carry none, so their lines and
  // chat are unchanged.
  const reasonLog = ans && ans.reason ? ` reason="${String(ans.reason).replace(/"/g, "'")}"` : ''
  const chatReason = () => {
    try {
      if (ans && ans.reason) chatStep(bot, ctx, chatClipped(`planner (${ans.source || 'llm'}): `, '', `${ans.step} — ${ans.reason}`))
    } catch (_) { /* narration best-effort */ }
  }
  const clearLowConf = () => {
    try {
      wd.lowConf = 0
      wd.lowConfGoal = null
    } catch (_) { /* streak best-effort */ }
  }
  const fail = (source, prefix) => {
    // Two consecutive UNDECIDED answers (low-confidence or stale — JEV
    // answered but produced no usable choice) for the same flat goal fall
    // back deterministically instead of backing off — the bot must never
    // stall forever (revmux 01 core-1: transport/timeout errors keep the
    // doubling backoff and never park on outage alone). The first
    // undecided still backs off (fresh menu or a better JEV round);
    // progress and decisions clear the streak. The fallback skips options
    // the history already proved flat (revmux 01 core-2).
    const undecided = typeof prefix === 'string' && (prefix.startsWith('low-confidence') || prefix.startsWith('stale:'))
    if (undecided) {
      const goalKey = `${id}:${(g && typeof g.generation === 'number') ? g.generation : '?'}` 
      try {
        if (wd.lowConfGoal !== goalKey) {
          wd.lowConf = 0
          wd.lowConfGoal = goalKey
        }
      } catch (_) { /* streak best-effort */ }
      wd.lowConf = (typeof wd.lowConf === 'number' ? wd.lowConf : 0) + 1
    }
    if (undecided && wd.lowConf >= 2) {
      let fb = null
      try {
        const { goalOptions } = require('./goal-options')
        const hist = state && state.wd && Array.isArray(state.wd.history) ? state.wd.history : null
        const held = new Set()
        try {
          const sf = ctx && ctx.stepFail
          if (sf && typeof sf === 'object') {
            for (const k of Object.keys(sf)) {
              if (sf[k] && typeof sf[k].status === 'string' && sf[k].status.startsWith('failed:')) held.add(k)
            }
          }
        } catch (_) { /* held best-effort */ }
        fb = fallbackRank(kind, goalOptions(bot, ctx, kind), hist, step, held)
      } catch (_) { fb = null }
      if (fb) {
        const diagnosis = diagnose(bot, ctx)
        const why = `fallback after ${wd.lowConf}x none (${prefix || source}) ${diagnosis}`
        try {
          console.log(`goal watchdog kind=${kind} id=${id} progress=${done}/${total} stall=${stallS}s round=${round} step=${step} options=${options} choice=${fb.id} conf=? source=fallback why=${why}`)
        } catch (_) { /* log best-effort */ }
        try {
          metrics.goalWatchdogTotal.inc({ kind, choice: fb.id, source: 'fallback' })
        } catch (_) { /* counter best-effort */ }
        clearLowConf()
        wd.backoffMs = 0
        wd.backoffUntil = 0
        applyCommit(bot, ctx, kind, fb.id, fb.step || null, now, fb.unlock || null, fb.criterion)
        return
      }
      // Nothing but the stalling step (or park) left (vmzq.35): re-running
      // it is a no-op, so take the park fork (owner online parks, alone
      // runs plan-B) — the one option that changes circumstances.
      try {
        console.log(`goal watchdog kind=${kind} id=${id} progress=${done}/${total} stall=${stallS}s round=${round} step=${step} options=${options} choice=park conf=? source=fallback why=fallback after ${wd.lowConf}x none (${prefix || source}) only the stalling step left`)
      } catch (_) { /* log best-effort */ }
      try {
        metrics.goalWatchdogTotal.inc({ kind, choice: 'park', source: 'fallback' })
      } catch (_) { /* counter best-effort */ }
      clearLowConf()
      wd.backoffMs = 0
      wd.backoffUntil = 0
      maxRounds(bot, ctx, kind, state, wd, now)
      return
    }
    const diagnosis = diagnose(bot, ctx)
    const why = prefix ? `${prefix} ${diagnosis}` : diagnosis
    try {
      console.log(`goal watchdog kind=${kind} id=${id} progress=${done}/${total} stall=${stallS}s round=${round} step=${step} options=${options} choice=none conf=? source=${source} why=${why}`)
    } catch (_) { /* log best-effort */ }
    try {
      metrics.goalWatchdogTotal.inc({ kind, choice: 'none', source })
    } catch (_) { /* counter best-effort */ }
    // Failure backoff, 30 s doubling to 5 min; the FSM runs meanwhile.
    const next = wd.backoffMs ? Math.min(wd.backoffMs * 2, GOAL_BACKOFF_MAX_MS) : GOAL_BACKOFF_MIN_MS
    wd.backoffMs = next
    wd.backoffUntil = now + next
  }
  if (!ans || ans.error) {
    fail((ans && ans.error) || 'invalid', null)
    return
  }
  const choice = ans.step
  // A park is held to the same confidence floor as a step (oqj5, prod v2:
  // round 1 at stall=62s answered park at 0.18 and latched the house for
  // the day). Below it the answer is undecided: back off, and the second
  // undecided takes the deterministic fallback (park only when nothing
  // else is left).
  if (choice === 'park' && typeof ans.conf === 'number' && ans.conf < TASK_PLAN_MIN_CONF) {
    fail('invalid', `low-confidence park conf=${ans.conf.toFixed(2)}`)
    return
  }
  if (choice === 'park') {
    const conf = typeof ans.conf === 'number' ? ans.conf.toFixed(2) : '?'
    const diagnosis = diagnose(bot, ctx)
    try {
      console.log(`goal watchdog kind=${kind} id=${id} progress=${done}/${total} stall=${stallS}s round=${round} step=${step} options=${options} choice=park conf=${conf} source=${ans.source || 'jev'} why=${diagnosis}${reasonLog}`)
    } catch (_) { /* log best-effort */ }
    try {
      metrics.goalWatchdogTotal.inc({ kind, choice: 'park', source: ans.source || 'jev' })
    } catch (_) { /* counter best-effort */ }
    chatReason()
    wd.backoffMs = 0
    wd.backoffUntil = 0
    clearLowConf()
    // A park choice is a fork, not a park: owner online parks, owner
    // offline runs plan-B (relocate, re-ask, switch, return) — the same
    // fork as the round cap, so an early park never bypasses plan-B.
    maxRounds(bot, ctx, kind, state, wd, now)
    return
  }
  if (choice === 'ask-owner') {
    const conf = typeof ans.conf === 'number' ? ans.conf.toFixed(2) : '?'
    const diagnosis = diagnose(bot, ctx)
    try {
      console.log(`goal watchdog kind=${kind} id=${id} progress=${done}/${total} stall=${stallS}s round=${round} step=${step} options=${options} choice=ask-owner conf=${conf} source=${ans.source || 'jev'} why=${diagnosis}${reasonLog}`)
    } catch (_) { /* log best-effort */ }
    try {
      metrics.goalWatchdogTotal.inc({ kind, choice: 'ask-owner', source: ans.source || 'jev' })
    } catch (_) { /* counter best-effort */ }
    chatReason()
    wd.backoffMs = 0
    wd.backoffUntil = 0
    clearLowConf()
    askOwner(bot, ctx, kind, done, total, state, wd, now)
    return
  }
  // Option-table lookup (.22): the choice must still be offered (the .5
  // stale rule generalised — availability re-checked, holds ignored).
  let opt = null
  try {
    const { goalOptions } = require('./goal-options')
    const offered = goalOptions(bot, ctx, kind)
    opt = offered.find((o) => o.id === choice) || null
  } catch (_) {
    opt = null
  }
  if (!opt) {
    // Legacy fallback: a plain step answered off-table (old brain, old test)
    // still applies when feasible — the .21 contract.
    let legacy = false
    try {
      const goal = require('./goal')
      const facts = goal.goalFacts(bot, ctx)
      legacy = typeof choice === 'string' && choice !== 'rest' && !!goal.MENU[choice] &&
        !!goal.MENU[choice].feasible(facts, bot, ctx) && goal.registered(choice)
    } catch (_) {
      legacy = false
    }
    if (!legacy) {
      fail('invalid', `stale:${choice}`)
      return
    }
    opt = { id: choice, step: choice, unlock: null }
  }
  if (typeof ans.conf === 'number' && ans.conf < TASK_PLAN_MIN_CONF) {
    fail('invalid', `low-confidence conf=${ans.conf.toFixed(2)}`)
    return
  }
  const conf = typeof ans.conf === 'number' ? ans.conf.toFixed(2) : '?'
  const diagnosis = diagnose(bot, ctx)
  try {
    console.log(`goal watchdog kind=${kind} id=${id} progress=${done}/${total} stall=${stallS}s round=${round} step=${step} options=${options} choice=${choice} conf=${conf} source=${ans.source || 'jev'} why=${diagnosis}${reasonLog}`)
  } catch (_) { /* log best-effort */ }
  try {
    metrics.goalWatchdogTotal.inc({ kind, choice, source: ans.source || 'jev' })
  } catch (_) { /* counter best-effort */ }
  chatReason()
  wd.backoffMs = 0
  wd.backoffUntil = 0
  clearLowConf()
  applyCommit(bot, ctx, kind, opt.id, opt.step || null, now, opt.unlock || null, opt.criterion)
}

// One tick of the fast watchdog: consume-first (the maybeL2 precedent),
// then fire when the goal's metric sat flat for GOAL_WATCHDOG_MS of
// eligible time. No planner, parked task, live window, in-flight call,
// backoff or min-interval block the fire; the L1/L2 ladder below still
// reports and parks (work goals only — orders have no ladder).
function maybeWatchdog(bot, ctx, kind, done, total, state, now) {
  try {
    if (!watchdogOn()) return
    const t = ctx && ctx.task
    if (!t || typeof t !== 'object') return
    if (isOrderKind(kind)) {
      if (!eligibleOrder(ctx, kind)) return
    } else {
      const rec = kind === 'castle' ? (ctx && ctx.castle) : (ctx && ctx.home)
      if (!rec || rec.taskPark) return
    }
    const wd = wdOf(state)
    if (wd.answer) {
      consumeWatchdog(bot, ctx, kind, done, total, state, wd, now)
      return
    }
    if (wd.pending) return
    const g = ctx && ctx.goal
    if (g && g.commit) return
    if (now < (wd.backoffUntil || 0)) return
    const W = goalWatchdogMs()
    if (now - (wd.firedAt || 0) < W) return
    if ((state.stallMs || 0) < W) return
    const brain = ctx && ctx.brain
    if (!brain || typeof brain.plan !== 'function') return
    // House: the 60 s cache must not condemn a building house — re-read
    // loaded cells before the verdict (peer Q1).
    if (kind === 'house') {
      try {
        const home = ctx.home
        if (home && home.site && typeof home.site.x === 'number' && houseLoaded(bot, home)) {
          const fresh = houseProgress(bot, home)
          t.houseCache = { at: now, done: fresh.done, total: fresh.total }
          if (typeof state.done === 'number' && fresh.done > state.done) {
            state.done = fresh.done
            state.total = fresh.total
            state.wood = houseWood(bot)
            state.trees = null
            progressReset(state, kind, now)
            logReset(kind, 'cells')
            return
          }
          if (typeof fresh.total === 'number') state.total = fresh.total
        }
      } catch (_) { /* verdict best-effort */ }
    }
    fireWatchdog(bot, ctx, kind, done, total, state, wd, now)
  } catch (_) { /* watchdog never breaks the tick */ }
}

// Snapshot the CLOCK's marks a window outcome is measured against —
// never the point reading (revmux 01 core-1): the window verdict must
// match the stall verdict, or an oscillation top-up (53->57 against a
// 57 high-water mark) reads progress here while the clock correctly
// stays flat, and the round cap never binds. The marks map rides along
// so cross-kind compares share the clock's semantics exactly.
function commitSnapshot(bot, ctx, kind) {
  void bot
  const st = (ctx && ctx.task && ctx.task[kind]) || null
  if (kind === 'house') {
    return { done: st && st.done, total: st && st.total, wood: st && st.wood }
  }
  if (isOrderKind(kind)) {
    return {
      done: st && st.done,
      total: st && st.total,
      dist: st && st.dist,
    }
  }
  let marks = {}
  try {
    marks = st ? { ...matMarksOf(st) } : {}
  } catch (_) {
    marks = {}
  }
  return {
    done: st && st.done,
    total: st && st.total,
    prepLeft: st && st.prepLeft,
    matKind: st && st.matKind,
    matHave: st && st.matHave,
    matLeft: st && st.matLeft,
    enLogs: st && st.enLogs,
    enPlanks: st && st.enPlanks,
    enSticks: st && st.enSticks,
    enGear: st && st.enGear,
    enReady: st && st.enReady,
    marks,
  }
}

// Did the goal-result signals advance past the window's snapshot? The
// snapshot has the state shape, so the progress verdict is shared.
function commitAdvanced(bot, ctx, kind, c) {
  const s = (c && c.snapshot) || {}
  const k = kind || (c && c.kind)
  if (k === 'house') {
    let done = null
    try {
      const home = ctx.home
      if (home && home.site && houseLoaded(bot, home)) done = houseProgress(bot, home).done
    } catch (_) {
      done = null
    }
    return houseProgressWhy(s, { done, wood: houseWood(bot) }) !== null
  }
  if (isOrderKind(k)) {
    let cur = {}
    try {
      cur = orderCurrent(bot, ctx, k)
    } catch (_) {
      cur = {}
    }
    return orderProgressWhy(s, cur, k) !== null
  }
  let cur = {}
  try {
    cur = castleCurrent(bot, ctx, ctx.castle, Date.now())
  } catch (_) {
    cur = {}
  }
  return castleProgressWhy(s, cur) !== null
}

// First moved signal, before->after; flat windows name the primary one.
function commitDelta(bot, ctx, kind, c) {
  const s = (c && c.snapshot) || {}
  const k = kind || (c && c.kind)
  if (k === 'house') {
    let done = null
    try {
      const home = ctx.home
      if (home && home.site && houseLoaded(bot, home)) done = houseProgress(bot, home).done
    } catch (_) {
      done = null
    }
    const before = typeof s.done === 'number' ? s.done : '?'
    const wood = houseWood(bot)
    if ((typeof done !== 'number' || done === s.done) && typeof wood === 'number' && typeof s.wood === 'number' && wood !== s.wood) return `wood${s.wood}->${wood}`
    return `cells${before}->${typeof done === 'number' ? done : before}`
  }
  if (isOrderKind(k)) {
    let cur = {}
    try {
      cur = orderCurrent(bot, ctx, k)
    } catch (_) {
      cur = {}
    }
    if (k === 'bring') {
      const b = typeof s.done === 'number' ? s.done : '?'
      const a = typeof cur.done === 'number' ? cur.done : b
      return `have${b}->${a}`
    }
    if (k === 'flat') {
      const b = typeof s.done === 'number' ? s.done : '?'
      const a = typeof cur.done === 'number' ? cur.done : b
      return `cells${b}->${a}`
    }
    const b = typeof s.dist === 'number' ? Math.round(s.dist) : '?'
    const a = typeof cur.dist === 'number' ? Math.round(cur.dist) : b
    return `dist${b}->${a}`
  }
  let cur = {}
  try {
    cur = castleCurrent(bot, ctx, ctx.castle, Date.now())
  } catch (_) {
    cur = {}
  }
  if (typeof cur.done === 'number' && typeof s.done === 'number' && cur.done !== s.done) return `cells${s.done}->${cur.done}`
  if (typeof cur.prepLeft === 'number' && typeof s.prepLeft === 'number' && cur.prepLeft !== s.prepLeft) return `prep${s.prepLeft}->${cur.prepLeft}`
  const mk = cur.matKind || s.matKind
  if (mk && typeof cur.matHave === 'number' && typeof s.matHave === 'number' && cur.matHave !== s.matHave) return `${mk}${s.matHave}->${cur.matHave}`
  if (mk && typeof cur.matLeft === 'number' && typeof s.matLeft === 'number' && cur.matLeft !== s.matLeft) return `${mk}left${s.matLeft}->${cur.matLeft}`
  if (typeof cur.enLogs === 'number' && typeof s.enLogs === 'number' && cur.enLogs !== s.enLogs) return `logs${s.enLogs}->${cur.enLogs}`
  if (typeof cur.enPlanks === 'number' && typeof s.enPlanks === 'number' && cur.enPlanks !== s.enPlanks) return `planks${s.enPlanks}->${cur.enPlanks}`
  if (typeof cur.enSticks === 'number' && typeof s.enSticks === 'number' && cur.enSticks !== s.enSticks) return `sticks${s.enSticks}->${cur.enSticks}`
  if (typeof cur.enGear === 'number' && typeof s.enGear === 'number' && cur.enGear !== s.enGear) return `gear${s.enGear}->${cur.enGear}`
  if (typeof s.done === 'number') return `cells${s.done}->${typeof cur.done === 'number' ? cur.done : s.done}`
  if (s.matKind && typeof s.matHave === 'number') return `${s.matKind}${s.matHave}->${typeof cur.matHave === 'number' ? cur.matHave : s.matHave}`
  return '?'
}

// Watchdog commit narration (vmzq.66): one chat line per commit — the
// goal, the shortest true phrase for the stall, and the option's
// criterion head (up to ';'). chatStep dedups repeats (10 s); the
// watchdog fires at most every GOAL_WATCHDOG_MS, so no spam. Park and
// ask-owner are forks, not commits — their lines stay where they are.
function commitGoalWord(kind, ctx) {
  if (kind === 'castle') return 'build castle'
  if (kind === 'house') return 'build home'
  try {
    return goalTextFor(kind, ctx) || kind
  } catch (_) {
    return kind
  }
}

function commitReason(ctx) {
  const step = (ctx && ctx.step) || 'none'
  const status = (ctx && ctx.stepStatus) || ''
  const reason = failReason(status)
  if (reason !== null && reason !== '') {
    // The stranded-wood stall names the radius gather actually searched
    // (failFinal stores it); any other failure names step and reason.
    if (reason === 'no-trees') {
      const r = ctx && ctx.gather && ctx.gather.farRadius
      return typeof r === 'number' ? `no wood within ${r}` : 'no wood found nearby'
    }
    return `${step} failed (${reason})`
  }
  return `${step} ${status || 'running'}, no progress`
}

function commitHead(optionId, step, criterion) {
  if (optionId === 'planb-relocate') return 'step aside, then re-ask'
  try {
    let text = typeof criterion === 'string' ? criterion : ''
    if (text) {
      // Plain steps carry the STEP_CRITERIA 'trigger: action' shape —
      // narrate the action, not the internal predicate. Far/bank
      // criteria are plain prose without a colon and ride whole.
      const cut = text.indexOf(': ')
      if (cut !== -1 && cut < (text.indexOf('(') + 1 || Infinity)) text = text.slice(cut + 2)
      return text.split(';')[0].trim()
    }
  } catch (_) { /* head best-effort */ }
  return step ? `retry ${step}` : String(optionId || 'unknown')
}

function commitChatLine(ctx, kind, optionId, step, criterion) {
  const word = commitGoalWord(kind, ctx)
  const reason = commitReason(ctx)
  const head = commitHead(optionId, step, criterion)
  return chatClipped(`${word}: `, '', `${reason} — ${head}`)
}

// Apply a watchdog choice as a bounded commitment window (GOAL_COMMIT_MS).
// decide() honours it (safety-first) for work goals; order goals read the
// unlock via goalUnlock in their dispatch/search policy. taskTick pauses,
// expires and ends it. optionId is the table label (hold-<order>, *-far,
// house-<step>, bank, plain step); step is the executor step or null for
// order holds; unlock rides for the window only.
function applyCommit(bot, ctx, kind, optionId, step, now, unlock = null, criterion = null) {
  try {
    const g = ctx && ctx.goal
    if (!g || g.kind !== kind) return false
    g.commit = {
      goalId: g.id, generation: g.generation, kind, optionId, step,
      until: now + goalCommitMs(), appliedAt: now, lastTick: now,
      deaths: (ctx && ctx.deaths) || 0,
      snapshot: commitSnapshot(bot, ctx, kind),
      unlock: unlock && typeof unlock === 'object' ? { ...unlock } : null,
    }
    try {
      const line = commitChatLine(ctx, kind, optionId, step, criterion)
      if (line) chatStep(bot, ctx, line)
    } catch (_) { /* narration never breaks the commit */ }
    return true
  } catch (_) {
    return false
  }
}

// An unlock window survives goal progress (finding 5): the far leg keeps
// its bounds until `until` (expiry) or leg end (done/failed/preempt) —
// snap-back is for the window end, not the first increment (ending on one
// dug stone would cost a ~180-block round trip plus a paid JEV round per
// block). Records the progress (rounds clear) and marks the window so the
// expiry verdict reads progress. Plain-step and hold windows still end on
// first progress. Returns true when the caller must keep, not end.
function keepUnlockWindow(state, c) {
  try {
    const u = c && c.unlock
    if (!u || typeof u !== 'object' || Object.keys(u).length === 0) return false
    c.sawProgress = true
    const wd = state ? wdOf(state) : null
    if (wd) resetWdProgress(wd)
    return true
  } catch (_) {
    return false
  }
}

// End a live window: one `goal outcome` line, one history entry, round
// accounting (flat and failed count, progress clears, preempted stands),
// then the round-cap fork. Idempotent: ending twice logs once.
// (.22) the choice is the optionId (hold-<order>, *-far, house-<step>,
// bank, plain step); the unlock keys ride unlock=<k1,k2> (or unlock=-).
function endCommit(bot, ctx, kind, state, c, result, now) {
  try {
    const g = ctx && ctx.goal
    if (!c || !g || g.commit !== c) return
    g.commit = null
    const t = typeof now === 'number' ? now : Date.now()
    const durMs = Math.max(0, t - (c.appliedAt || t))
    let delta = '?'
    try {
      delta = bot ? commitDelta(bot, ctx, kind || (c && c.kind), c) : '?'
    } catch (_) {
      delta = '?'
    }
    const choice = (c && (c.optionId || c.step)) || '?'
    const k = kind || (c && c.kind) || '?'
    let unlock = '-'
    try {
      const u = c && c.unlock
      if (u && typeof u === 'object') {
        const ks = Object.keys(u).filter((kk) => u[kk] !== null && u[kk] !== undefined)
        if (ks.length > 0) unlock = ks.sort().join(',')
      }
    } catch (_) { /* unlock best-effort */ }
    try {
      console.log(`goal outcome kind=${k} choice=${choice} dur=${Math.floor(durMs / 1000)}s delta=${delta} result=${result} unlock=${unlock}`)
    } catch (_) { /* log best-effort */ }
    const wd = state ? wdOf(state) : null
    if (wd) {
      try {
        wd.history.push({ choice, outcome: result, dur_s: Math.floor(durMs / 1000), delta })
        while (wd.history.length > GOAL_HISTORY_KEPT) wd.history.shift()
      } catch (_) { /* history best-effort */ }
      if (result === 'progress') {
        resetWdProgress(wd)
        wd.planb = null
      } else if (result === 'flat' || (typeof result === 'string' && result.startsWith('failed:'))) {
        // A relocate leg is plan-B, not a JEV round: it is recorded in
        // history above, but it neither counts nor forks — the next
        // round fires with this outcome in history, and only a flat
        // non-relocate round at the cap moves to the switch.
        if (c.optionId === 'planb-relocate') return
        wd.rounds = (wd.rounds || 0) + 1
        if ((wd.rounds || 0) >= goalMaxRounds()) {
          try {
            maxRounds(bot, ctx, k, state, wd, t)
          } catch (_) { /* fork best-effort */ }
        }
      }
    }
  } catch (_) { /* outcome never breaks the tick */ }
}

// A finished window step ends the window early (decide() calls this):
// failed names its reason, done re-measures against the dispatch
// snapshot — a done with no goal effect is flat, not progress.
function commitFinished(bot, ctx, status) {
  try {
    const g = ctx && ctx.goal
    const c = g && g.commit
    if (!c) return
    const kind = c.kind
    const state = ctx && ctx.task && ctx.task[kind]
    const now = Date.now()
    let result = null
    if (typeof status === 'string' && status.startsWith('failed:')) {
      result = status
    } else if (status === 'done') {
      let advanced = false
      try {
        advanced = commitAdvanced(bot, ctx, kind, c)
      } catch (_) {
        advanced = false
      }
      result = advanced ? 'progress' : 'flat'
    } else {
      return
    }
    endCommit(bot, ctx, kind, state, c, result, now)
  } catch (_) { /* finish never breaks the tick */ }
}

// Top-of-tick window accounting (every tick, eligible or not): preempts
// end the window, safety/night/order time pauses it by the billed delta.
// (.22) order windows: the order IS the goal, so another order preempts
// (replaced) instead of pausing, night never pauses (orders run day and
// night), and a cancelled order preempts as replaced.
function commitTickTop(bot, ctx, now) {
  try {
    const g = ctx && ctx.goal
    const c = g && g.commit
    if (!c || typeof c !== 'object') return
    if (!g || c.goalId !== g.id || c.generation !== g.generation) {
      endCommit(bot, ctx, c.kind, null, c, 'preempted:generation', now)
      return
    }
    const lastTick = typeof c.lastTick === 'number' ? c.lastTick : (c.appliedAt || now)
    const delta = Math.min(Math.max(0, now - lastTick), STALL_TICK_CLAMP_MS)
    c.lastTick = now
    const state = ctx.task && ctx.task[c.kind]
    if (ctx.paused) {
      endCommit(bot, ctx, c.kind, state, c, 'preempted:stop', now)
      return
    }
    if ((ctx.deaths || 0) !== (c.deaths || 0)) {
      endCommit(bot, ctx, c.kind, state, c, 'preempted:death', now)
      return
    }
    // Completed under the window: the ultimate progress.
    if (c.kind === 'castle' && ctx.castle && ctx.castle.phase === 'complete') {
      endCommit(bot, ctx, c.kind, state, c, 'progress', now)
      return
    }
    if (c.kind === 'house' && ctx.home && ctx.home.built === true) {
      endCommit(bot, ctx, c.kind, state, c, 'progress', now)
      return
    }
    if (isOrderKind(c.kind)) {
      // The order gone (done, cancelled, replaced): the window's goal is
      // over. Done reads progress when the metric advanced (bring have,
      // travel arrival, flat cells), else preempted:replaced — the
      // order dispatch owns completion, the window only records it.
      if (!eligibleOrder(ctx, c.kind)) {
        let advanced = false
        try {
          advanced = commitAdvanced(bot, ctx, c.kind, c)
        } catch (_) {
          advanced = false
        }
        endCommit(bot, ctx, c.kind, state, c, advanced ? 'progress' : 'preempted:replaced', now)
        return
      }
      // Another body-owning order preempts (the dispatch order wins).
      try {
        const active = goalKind(ctx)
        if (active && active !== c.kind) {
          endCommit(bot, ctx, c.kind, state, c, 'preempted:replaced', now)
          return
        }
      } catch (_) { /* replace best-effort */ }
      // A true mode change (follow with no order) preempts; work mode
      // with the order running does not (the order owns the body).
      if (!ctx.work && !ctx.lead && !ctx.bring && !ctx.comehome && !ctx.gocastle && !(ctx.flat && !ctx.flat.parked)) {
        endCommit(bot, ctx, c.kind, state, c, 'preempted:mode', now)
        return
      }
      // Safety pauses the window (fight/shelter/recover time); night does
      // not (orders run day and night).
      let pausing = false
      try {
        const st = ctx.step
        if (st === 'stay' || st === 'gohome' || st === 'shelter' || ctx.inShelter) pausing = true
      } catch (_) { /* step best-effort */ }
      if (pausing) c.until += delta
      return
    }
    // Replaced: the window's goal is no longer the active task and it is
    // not complete (a switch moved on without ending it).
    try {
      const active = goalKind(ctx)
      if (active && active !== c.kind) {
        endCommit(bot, ctx, c.kind, state, c, 'preempted:replaced', now)
        return
      }
    } catch (_) { /* replace best-effort */ }
    // A true mode change (follow) preempts; orders pause instead (below) —
    // the errand ends and the window resumes.
    const orderPause = ctx.lead || ctx.bring || ctx.comehome || ctx.gocastle || (ctx.flat && !ctx.flat.parked)
    if (!ctx.work && !orderPause) {
      endCommit(bot, ctx, c.kind, state, c, 'preempted:mode', now)
      return
    }
    // Prerequisite gone: a fetch pinned with a full pack cannot pick up
    // (and must not scatter drops) — release to the honest bank leg.
    if (c.step === 'castlefetch' || c.step === 'gather' || c.step === 'forage' || c.step === 'reforest') {
      let full = false
      try {
        full = !!require('./goal').packFull(bot, ctx)
      } catch (_) {
        full = false
      }
      if (full) {
        endCommit(bot, ctx, c.kind, state, c, 'preempted:pack-full', now)
        return
      }
    }
    let pausing = false
    try {
      pausing = !eligible(bot, ctx)
    } catch (_) {
      pausing = false
    }
    try {
      const st = ctx.step
      if (st === 'stay' || st === 'gohome' || st === 'shelter' || ctx.inShelter) pausing = true
    } catch (_) { /* step best-effort */ }
    if (pausing) c.until += delta
  } catch (_) { /* window never breaks the tick */ }
}

// Eligible-tick window accounting: safety steps pause by the billed
// delta; an expired window ends with a re-measured outcome.
function commitEligible(bot, ctx, kind, state, billed, now) {
  try {
    const g = ctx && ctx.goal
    const c = g && g.commit
    if (!c || c.kind !== kind) return
    let safety = false
    try {
      const st = ctx.step
      safety = st === 'stay' || st === 'gohome' || st === 'shelter' || !!ctx.inShelter
    } catch (_) {
      safety = false
    }
    if (safety) {
      c.until += billed
      return
    }
    if (now >= c.until) {
      let advanced = false
      try {
        advanced = commitAdvanced(bot, ctx, kind, c)
      } catch (_) {
        advanced = false
      }
      try {
        if (c.sawProgress) advanced = true
      } catch (_) { /* verdict best-effort */ }
      endCommit(bot, ctx, kind, state, c, advanced ? 'progress' : 'flat', now)
    }
  } catch (_) { /* window never breaks the tick */ }
}

// Park an order goal (vmzq.22): cancel with the diagnosis (flat parks
// resumably like stop, others clear). An unlock never undoes an owner
// park — this is the automatic stall park releasing to other work.
function parkOrder(bot, ctx, kind, done, total, now) {
  void now
  try {
    const diagnosis = diagnose(bot, ctx)
    const g = ctx && ctx.goal
    if (g && g.commit) {
      try {
        const st = ctx.task && ctx.task[kind]
        endCommit(bot, ctx, kind, st && typeof st === 'object' ? st : null, g.commit, 'preempted:park', Date.now())
      } catch (_) { /* window best-effort */ }
    }
    try {
      const st = ctx && ctx.task && ctx.task[kind]
      if (st && st.wd) { st.wd.pending = null; st.wd.answer = null }
    } catch (_) { /* watchdog best-effort */ }
    const d = typeof done === 'number' || typeof done === 'string' ? done : '?'
    const t = typeof total === 'number' || typeof total === 'string' ? total : '?'
    try {
      console.log(`goal park kind=${kind} progress=${d}/${t} why=${diagnosis}`)
    } catch (_) { /* log best-effort */ }
    try {
      bot.chat(`${kind} parked at ${d}/${t} — ${diagnosis}`)
    } catch (_) { /* chat best-effort */ }
    try {
      metrics.taskStallTotal.inc({ task: kind, level: 'L2' })
    } catch (_) { /* counter best-effort */ }
    try {
      if (kind === 'bring' && ctx.bring) {
        metrics.bring.inc({ outcome: 'cancelled', kind: (ctx.bring && ctx.bring.kind) || 'block' })
        ctx.bring = null
        try {
          require('./behaviours/bring').clearSearchLeg(ctx)
        } catch (_) { /* legs best-effort */ }
      } else if (kind === 'lead') {
        ctx.lead = null
        ctx.leadTargetGone = 0
      } else if (kind === 'comehome') {
        ctx.comehome = null
      } else if (kind === 'gocastle') {
        ctx.gocastle = null
      } else if (kind === 'flat' && ctx.flat) {
        ctx.flat.parked = true
      }
    } catch (_) { /* cancel best-effort */ }
    try {
      resetTask(ctx, 'park')
    } catch (_) { /* reset best-effort */ }
    return diagnosis
  } catch (_) { /* park never breaks the tick */ }
  return undefined
}

// Ask the owner (vmzq.22, online only): chat the diagnosis and wait —
// the watchdog backs off 10x the window while the order/FSM keeps
// running (a new order or stop preempts via generation/stop; the timeout
// re-fires). The full rest-until-message idle is deferred: continuing is
// safer than stranding the body 10 min on a missed chat.
function askOwner(bot, ctx, kind, done, total, state, wd, now) {
  try {
    if (!ownerOnline(bot)) {
      const next = wd.backoffMs ? Math.min(wd.backoffMs * 2, GOAL_BACKOFF_MAX_MS) : GOAL_BACKOFF_MIN_MS
      wd.backoffMs = next
      wd.backoffUntil = now + next
      return
    }
    const diagnosis = diagnose(bot, ctx)
    const d = typeof done === 'number' || typeof done === 'string' ? done : '?'
    const t = typeof total === 'number' || typeof total === 'string' ? total : '?'
    try {
      console.log(`goal ask-owner kind=${kind} progress=${d}/${t} why=${diagnosis}`)
    } catch (_) { /* log best-effort */ }
    try {
      const line = `${kind} stuck at ${d}/${t} — ${diagnosis} — waiting for you`
      bot.chat(line.slice(0, CHAT_LIMIT))
    } catch (_) { /* chat best-effort */ }
    const wait = goalWatchdogMs() * 10
    wd.backoffMs = 0
    wd.backoffUntil = now + wait
    try {
      wd.history.push({ choice: 'ask-owner', outcome: 'waiting', dur_s: 0, delta: `${d}/${t}` })
      while (wd.history.length > GOAL_HISTORY_KEPT) wd.history.shift()
    } catch (_) { /* history best-effort */ }
  } catch (_) { /* ask never breaks the tick */ }
}

// Round-cap fork (owner 2026-10-07): owner online -> park with the
// diagnosis (today's L2 line asks them to resume); owner offline ->
// plan-B, which replaces the alone park. Plan-B phase 1 relocates aside
// for one window and re-asks JEV with the outcome in history; a still
// flat non-relocate round moves to phase 2, the goal switch.
// (.22) orders park (cancel) on the cap — the natural fallback to
// castle/house is the switch, without return (the owner re-issues).
function maxRounds(bot, ctx, kind, state, wd, now) {
  const done = state && typeof state.done === 'number' ? state.done : (state && typeof state.dist === 'number' ? Math.round(state.dist) : '?')
  const total = state && typeof state.total === 'number' ? state.total : '?'
  if (isOrderKind(kind)) {
    parkOrder(bot, ctx, kind, done, total, now)
    return
  }
  if (!bot || ownerOnline(bot)) {
    parkTask(bot, ctx, kind, done, total, now)
    return
  }
  const g = ctx && ctx.goal
  const id = (g && g.id) || '?'
  if (!wd.planb) {
    let leg = null
    try {
      const goal = require('./goal')
      const facts = goal.goalFacts(bot, ctx)
      for (const n of ['explore', 'forage']) {
        try {
          if (goal.MENU[n] && goal.MENU[n].feasible(facts, bot, ctx) && goal.registered(n)) {
            leg = n
            break
          }
        } catch (_) { /* leg best-effort */ }
      }
    } catch (_) {
      leg = null
    }
    wd.planb = 'relocate'
    if (!leg) {
      try {
        console.log(`goal planb kind=${kind} id=${id} phase=relocate skipped=no-feasible-leg`)
      } catch (_) { /* log best-effort */ }
      return
    }
    try {
      console.log(`goal planb kind=${kind} id=${id} phase=relocate step=${leg}`)
    } catch (_) { /* log best-effort */ }
    applyCommit(bot, ctx, kind, 'planb-relocate', leg, now)
    return
  }
  if (wd.planb === 'relocate') {
    const other = kind === 'castle' ? 'house' : 'castle'
    const rec = other === 'castle' ? (ctx && ctx.castle) : (ctx && ctx.home)
    const stalled = kind === 'castle' ? (ctx && ctx.castle) : (ctx && ctx.home)
    let otherReady = false
    try {
      otherReady = !!rec && !!rec.site && typeof rec.site.x === 'number' && !rec.parked && !rec.taskPark &&
        (other === 'castle' ? rec.phase !== 'complete' : rec.built !== true)
    } catch (_) {
      otherReady = false
    }
    if (!otherReady || !stalled) {
      try {
        console.log(`goal planb kind=${kind} id=${id} phase=switch skipped=no-other-goal`)
      } catch (_) { /* log best-effort */ }
      parkTask(bot, ctx, kind, done, total, now)
      return
    }
    // The switch reuses the parked veto (every menu already honours it —
    // no feasibility changes); the planb stamp (memory.js, wall-clock)
    // auto-expires it, unlike an owner park.
    wd.planb = 'switch'
    stalled.parked = true
    stalled.planb = { at: now }
    savePark(bot, ctx)
    try {
      console.log(`goal planb kind=${kind} id=${id} phase=switch to=${other} for=${Math.floor(goalPlanbMs() / 1000)}s`)
    } catch (_) { /* log best-effort */ }
    return
  }
  parkTask(bot, ctx, kind, done, total, now)
}

function maybeL2(bot, ctx, kind, done, total, state, now) {
  if (state.stallMs < TASK_STALL_L2_MS) return
  const rec = kind === 'castle' ? (ctx && ctx.castle) : (ctx && ctx.home)
  if (!rec || rec.taskPark) return
  if (watchdogOn()) {
    // The watchdog owns plan() calls; L2 stays as the time backstop
    // (park only) for episodes that never reach the round cap.
    const diagnosis = parkTask(bot, ctx, kind, done, total, now)
    if (diagnosis === undefined) return
    state.lastL1At = now
    state.lastL1Diag = diagnosis
    return
  }
  // Stall-point planner (vmzq.5): one async JEV step pick per stall run
  // before the deterministic park. This tick only fires the call; the
  // answer applies on the next tick. Park/ask-owner stay rule-based —
  // the planner only ever picks a menu step.
  if (state.planAnswer) {
    const parked = consumePlan(bot, ctx, kind, done, total, state, now)
    if (parked !== null) {
      state.lastL1At = now
      state.lastL1Diag = parked
    }
    return
  }
  if (state.planPending) return
  if (!state.planTried && tryPlan(bot, ctx, kind, done, total, state)) return
  const diagnosis = parkTask(bot, ctx, kind, done, total, now)
  if (diagnosis === undefined) return
  // The park line carries this tick's diagnosis, so the L1 must not fire
  // alongside it ('still trying' + 'parked' back to back contradict).
  // maybeL2 runs before maybeL1 at every hook site; this stamp skips it.
  state.lastL1At = now
  state.lastL1Diag = diagnosis
}

// Wall-clock park timers (vmzq.3): runs every hooked tick for BOTH records,
// eligible or not, active or not — the world may change at night or while
// the other task runs. One auto-resume per episode, 60 min after the park;
// a latched (3rd) park waits for an owner command. Stale episodes (the
// task finished under the park) clear silently. Plan-B switches (vmzq.21)
// expire on the same wall clock via the rec.planb stamp.
function maybeResume(bot, ctx, now) {
  try {
    if (!ctx || typeof ctx !== 'object') return
    for (const kind of ['castle', 'house']) {
      const rec = kind === 'castle' ? ctx.castle : ctx.home
      if (!rec || typeof rec !== 'object') continue
      // Plan-B switch timer (vmzq.21): wall-clock like the park timer. The
      // stamp without the parked flag is stale (the owner resumed over
      // the switch); a task park supersedes the marker. Expiry returns to
      // the goal — no resetTask: the other goal's episode continues, this
      // kind re-baselines on its next active tick.
      if (rec.planb && typeof rec.planb === 'object') {
        if (!rec.parked || rec.taskPark) {
          rec.planb = null
        } else if (typeof rec.planb.at === 'number' && now - rec.planb.at >= goalPlanbMs()) {
          rec.parked = false
          rec.planb = null
          try {
            console.log(`goal planb kind=${kind} phase=return`)
          } catch (_) { /* log best-effort */ }
          savePark(bot, ctx)
        }
      }
      if (!rec.taskPark) continue
      if ((kind === 'castle' && rec.phase === 'complete') || (kind === 'house' && rec.built === true)) {
        rec.taskPark = null
        rec.planb = null
        rec.parked = false
        savePark(bot, ctx)
        continue
      }
      const ep = rec.taskPark
      if (!ep || typeof ep.at !== 'number') continue
      // A latched park is 'parked for the day' (idkcraft-neuc.40): it
      // resumes once the UTC day turns instead of waiting for an owner
      // command forever. The day count resets on the next park.
      if (ep.auto !== true && utcDay(ep.at) === utcDay(now)) continue
      if (now - ep.at < TASK_PARK_RETRY_MS) continue
      const n = (rec.parkHist && typeof rec.parkHist.n === 'number' && rec.parkHist.n >= 1) ? rec.parkHist.n : 1
      rec.parked = false
      rec.taskPark = null
      resetTask(ctx)
      try {
        console.log(`task ${kind} resumed after 60 min parked (stall ${n}/${TASK_PARKS_PER_DAY})`)
      } catch (_) { /* log best-effort */ }
      try {
        bot.chat(`${kind} retrying after 60 min parked (stall ${n}/${TASK_PARKS_PER_DAY})`)
      } catch (_) { /* chat best-effort */ }
      savePark(bot, ctx)
    }
  } catch (_) { /* resume never breaks the tick */ }
}

// Owner resume (castle go / go work): clears TASK parks only — an
// owner-parked castle (no episode) keeps its park until castle go.
// Returns true when anything changed (the caller persists).
function clearTaskParks(ctx) {
  let changed = false
  try {
    for (const kind of ['castle', 'house']) {
      const rec = kind === 'castle' ? (ctx && ctx.castle) : (ctx && ctx.home)
      if (rec && typeof rec === 'object' && rec.taskPark) {
        rec.taskPark = null
        rec.parked = false
        changed = true
      }
    }
  } catch (_) { /* clear best-effort */ }
  return changed
}

// Status line fragment: 'task castle 8/1722 stall=23m', or null when no task.
// Unread yet (unloaded since reset) reads '?/?' with the live stall.
// Watchdog rounds behind the stall append ' round=N'.
// (.22) orders read the same: bring have/want, travel dist blocks left,
// flat cells. A stale active (the order ended mid-tick, before the next
// taskTick clears it) reads null — the line shows the live goal only.
function taskLine(ctx) {
  try {
    const t = ctx && ctx.task
    const kind = t && t.active
    const st = kind && t[kind]
    if (!kind || !st) return null
    try {
      if (kind !== goalKind(ctx)) return null
    } catch (_) { /* identity best-effort */ }
    let done = typeof st.done === 'number' ? st.done : '?'
    let total = typeof st.total === 'number' ? st.total : '?'
    if (isOrderKind(kind) && (kind === 'comehome' || kind === 'gocastle' || kind === 'lead')) {
      done = typeof st.dist === 'number' ? Math.round(st.dist) : '?'
      total = typeof st.total === 'number' && st.total > 0 ? st.total : 'left'
      return `task ${kind} ${done} blocks ${total === 'left' ? 'left' : `/ ${total}`} stall=${stallFmt(st.stallMs || 0)}${((st.wd && st.wd.rounds) || 0) > 0 ? ` round=${st.wd.rounds}` : ''}`
    }
    let rounds = 0
    try { rounds = (st.wd && st.wd.rounds) || 0 } catch (_) { rounds = 0 }
    return `task ${kind} ${done}/${total} stall=${stallFmt(st.stallMs || 0)}${rounds > 0 ? ` round=${rounds}` : ''}`
  } catch (_) {
    return null
  }
}

// Full reset: next tick re-baselines (new/forgotten task, stop/go, go work).
// Death/respawn deliberately do NOT reset — the walk back is part of the job.
// (vmzq.21) a reset ends a live commitment window as preempted (attributed
// by the caller: castle stop passes 'stop', orders pass 'generation') and
// clears the goal identity, so in-flight answers drop on the next tick.
function resetTask(ctx, why = 'generation') {
  try {
    if (ctx && ctx.goal && ctx.goal.commit) {
      const c = ctx.goal.commit
      ctx.goal.commit = null
      const dur = Math.max(0, Math.floor((Date.now() - (c.appliedAt || Date.now())) / 1000))
      let unlock = '-'
      try {
        const u = c && c.unlock
        if (u && typeof u === 'object') {
          const ks = Object.keys(u).filter((kk) => u[kk] !== null && u[kk] !== undefined)
          if (ks.length > 0) unlock = ks.sort().join(',')
        }
      } catch (_) { /* unlock best-effort */ }
      try {
        console.log(`goal outcome kind=${(c && c.kind) || '?'} choice=${(c && (c.optionId || c.step)) || '?'} dur=${dur}s delta=? result=preempted:${why || 'generation'} unlock=${unlock}`)
      } catch (_) { /* log best-effort */ }
    }
  } catch (_) { /* window best-effort */ }
  try {
    if (ctx) ctx.task = null
  } catch (_) { /* reset best-effort */ }
  try {
    if (ctx) ctx.goal = null
  } catch (_) { /* reset best-effort */ }
  try {
    // A new episode plans fresh (vmzq.5): no stale forced step survives.
    if (ctx) ctx.taskPlanStep = null
  } catch (_) { /* reset best-effort */ }
  try {
    metrics.taskStallSeconds.set({ task: 'castle' }, 0)
    metrics.taskStallSeconds.set({ task: 'house' }, 0)
    for (const k of ORDER_KINDS) {
      try {
        metrics.taskStallSeconds.set({ task: k }, 0)
      } catch (_) { /* gauge best-effort */ }
    }
  } catch (_) { /* metrics best-effort */ }
}

// Shared progress reset (vmzq.21): the stall clock, the L1 dedupe, the
// failure list, the legacy plan markers, the watchdog round count and
// the travel-grace grants (a new stall episode). The signal fields are
// the caller's (they differ per site). lastProgressAt moots watchdog
// answers whose stall resolved mid-call.
function progressReset(state, kind, now) {
  state.stallMs = 0
  state.lastAt = now
  state.lastL1At = null
  state.lastL1Diag = null
  state.fails = []
  state.lastProgressAt = now
  try {
    const wd = wdOf(state)
    resetWdProgress(wd)
    wd.graceRuns = 0
  } catch (_) { /* rounds best-effort */ }
  clearPlan(state)
  setStallGauge(kind, 0)
}

// A self bring order whose search started and has budget left (vmzq.63).
// Mirrors bring.js enterSearch's exhaustion test; the minutes read the
// wall clock like startedAt does. No search yet = no budget = billed.
function selfSearching(o) {
  try {
    const s = o && o.self && o.phase !== 'return' ? o.searchLegs : null
    if (!s || s.timedOut || s.capped) return false
    const b = require('./behaviours/bring').SEARCH_BUDGET
    return s.legs < b.legs && Date.now() - s.startedAt < b.minutes * 60 * 1000
  } catch (_) {
    return false
  }
}

// Every clock reset logs its reason (vmzq.21): the run-4 reset path is
// instrumented before anyone asserts it.
function logReset(kind, why) {
  try {
    console.log(`goal reset kind=${kind} why=${why}`)
  } catch (_) { /* log best-effort */ }
}

function recordFail(ctx, state) {
  try {
    const status = ctx && typeof ctx.stepStatus === 'string' ? ctx.stepStatus : ''
    if (!status.startsWith('failed:')) return
    const reason = status.slice('failed:'.length) || 'unknown'
    const step = (ctx && ctx.step) || 'none'
    const entry = `${step}:${reason}`
    if (!Array.isArray(state.fails)) state.fails = []
    if (state.fails.includes(entry)) return
    state.fails.push(entry)
    while (state.fails.length > TASK_FAILS_KEPT) state.fails.shift()
  } catch (_) { /* fails best-effort */ }
}

function setStallGauge(kind, ms) {
  try {
    metrics.taskStallSeconds.set({ task: kind }, Math.max(0, (ms || 0) / 1000))
  } catch (_) { /* metrics best-effort */ }
}

// Far-walk progress (vmzq.35, the travel-grace idea for the castle step's
// own walk): past the castle far-walk range, the distance to the footprint
// sinking CASTLE_TRAVEL_STEP below its low-water mark is progress. Low-water
// only, so a wedge or an out-and-back trip never counts; on site or after a
// teleport (respawn) the mark rebaselines.
const CASTLE_TRAVEL_STEP = 8
// Far-tree walk (oqj5, the castleTravel shape): a gather walking to its
// committed tree reads flat on cells and wood until the first chop (rig:
// a tree 123 blocks out, ~80 s of walk, the watchdog fires at 60). The
// distance sinking CASTLE_TRAVEL_STEP below the tree's low-water mark is
// progress. Per target: a new tree rebaselines without credit, and a
// wedge or a walk away never counts. The caller bounds it to a wood-short
// house. The marks live in one per-tree map (state.trees) that only cells
// or wood progress clears, so leaving the walk phase or swapping targets
// A<->B never rebaselines a tree already approached: each tree credits at
// most its first-seen distance / 8 per episode.
// ponytail: capped at GATHER_TRAVEL_TREES trees per episode (a new tree past
// it earns nothing); no jump rebaseline as castleTravel has, so a walk back
// from a respawn credits only below the old mark (fails safe: fewer credits).
const GATHER_TRAVEL_TREES = 16
function gatherTravel(bot, ctx, state) {
  try {
    const g = ctx && ctx.gather
    const bp = bot && bot.entity && bot.entity.position
    if (!g || ctx.step !== 'gather' || g.phase !== 'walk' || !g.pos || !bp) return false
    const key = `${g.pos.x},${g.pos.y},${g.pos.z}`
    const d = Math.hypot(bp.x - g.pos.x, bp.z - g.pos.z)
    if (!state.trees || typeof state.trees !== 'object') state.trees = {}
    const mark = state.trees[key]
    if (typeof mark !== 'number') {
      if (Object.keys(state.trees).length < GATHER_TRAVEL_TREES) state.trees[key] = d
      return false
    }
    if (d + CASTLE_TRAVEL_STEP > mark) return false
    state.trees[key] = d
    return true
  } catch (_) {
    return false
  }
}

function castleTravel(bot, ctx, state) {
  try {
    const castle = require('./behaviours/castle')
    const d = castle.siteDist(bot, ctx.castle)
    if (d == null || d <= castle.SITE_WALK_DIST) {
      state.siteDist = null
      state.siteLast = d
      return false
    }
    // A one-tick jump rebaselines (revmux 01/02): task state survives a
    // death, and a mark sunk before it would deny the walk back from the
    // respawn. Keyed on the position, not the death event — that fires
    // before the respawn teleport lands.
    const last = state.siteLast
    state.siteLast = d
    if (typeof state.siteDist !== 'number' || (typeof last === 'number' && Math.abs(d - last) > 2 * castle.SITE_WALK_DIST)) {
      state.siteDist = d
      return false
    }
    if (d + CASTLE_TRAVEL_STEP > state.siteDist) return false
    state.siteDist = d
    return true
  } catch (_) {
    return false
  }
}

// Enabling inventory (idkcraft-m1yb): the opening chain the demand verdict
// cannot see. While the demand is stone, the bot chops logs, crafts planks
// and sticks, and makes the table and first picks — none of which moves the
// demanded kind's counts, so a healthy opening read as a 60 s stall and
// burned watchdog rounds (r1/r2 committing gather past craft-readiness).
// Four categories, one per craft stage, so a craft's consumption never
// masks its output's growth: logs, planks, sticks, and gear (table plus
// wooden/stone picks). A last-tick delta, not a water mark: the baseline
// always follows (castleSinkBaseline adopts), so a re-gather past a
// consumed count is progress again. Material-class: it resets the
// any-clock only, never the placed clock (vmzq.20), so a fetch loop still
// reports at L1. Bounded (verifier livelock): credited only while the
// opening kit is not ready — any pickaxe in the pack (goalFacts/equip
// hasPickaxe predicate). Once the baseline holds a pick, only castle
// metrics and the vmzq.35 travel credit count; a death-and-pickup,
// recraft or log-chop loop can no longer silence the watchdog.
function castleEnabling(bot) {
  const out = { logs: 0, planks: 0, sticks: 0, gear: 0, ready: false }
  try {
    const items = (bot && bot.inventory && bot.inventory.items()) || []
    for (const it of items) {
      if (!it || typeof it.name !== 'string') continue
      const n = typeof it.count === 'number' ? it.count : 1
      if (it.name.endsWith('_log')) out.logs += n
      else if (it.name.endsWith('_planks')) out.planks += n
      else if (it.name === 'stick') out.sticks += n
      else if (it.name === 'crafting_table' || it.name === 'wooden_pickaxe' || it.name === 'stone_pickaxe') out.gear += n
      if (it.name.endsWith('_pickaxe')) out.ready = true
    }
  } catch (_) { /* no inventory: none */ }
  return out
}

// Current castle progress for the clock. Prep remaining only in prep phase
// (a body-phase prepTargets call would scan the whole site volume cold);
// material only while a demanded kind is latched.
function castleCurrent(bot, ctx, st, now) {
  const out = {}
  try {
    if (st.progress && typeof st.progress.done === 'number' && typeof st.progress.total === 'number') {
      out.done = st.progress.done
      out.total = st.progress.total
    }
  } catch (_) { /* progress best-effort */ }
  try {
    if (st.phase === 'prep') {
      // Loaded site only (core-2): unloaded columns are skipped from the
      // scan, so a partial scan reads short and a trip off site would count
      // as progress. Off-site the last value stands.
      let loaded = false
      try {
        const Vec3 = require('vec3')
        const blueprint = require('./castle')
        const { w, d } = blueprint.siteDimensions(st.rot | 0, st.blueprintVersion)
        loaded = [[0, 0], [w - 1, 0], [0, d - 1], [w - 1, d - 1]].every(([dx, dz]) => !!bot.blockAt(new Vec3(st.site.x + dx, st.site.y, st.site.z + dz)))
      } catch (_) { loaded = false }
      if (loaded) {
        const castle = require('./behaviours/castle')
        const list = castle.prepTargets(bot, ctx, st, now)
        const scan = ctx && ctx.castlePrep
        if (scan && !scan.unknown && Array.isArray(list)) out.prepLeft = list.length
      }
    } else {
      out.prepLeft = 0
    }
  } catch (_) { /* prep best-effort */ }
  try {
    const cw = ctx && ctx.castleWord
    if (cw && typeof cw.kind === 'string' && cw.kind) {
      out.matKind = cw.kind
      // Planks left oscillates when cells block (peek moves to the next
      // infill cell), so it is not a progress signal (verify body-1).
      if (cw.kind !== 'planks' && typeof cw.left === 'number') out.matLeft = cw.left
      try {
        out.matHave = require('./behaviours/castle').usable(bot, cw.kind)
      } catch (_) { /* inventory best-effort */ }
    }
  } catch (_) { /* material best-effort */ }
  try {
    const en = castleEnabling(bot)
    out.enLogs = en.logs
    out.enPlanks = en.planks
    out.enSticks = en.sticks
    out.enGear = en.gear
    out.enReady = en.ready
  } catch (_) { /* enabling best-effort */ }
  return out
}

// Sticky per-kind material marks (vmzq.21): the flat matKind/matHave/matLeft
// are the CURRENT demand's view; marks remembers every demanded kind's
// high/low-water marks across demand switches, so a switch away and back
// restores the old marks instead of re-baselining the current count
// (run-4: castle/castlefetch alternation flipped the kind and every
// replenishment re-counted as progress). Bounded: one entry per kind.
function matMarksOf(state) {
  try {
    if (!state.marks || typeof state.marks !== 'object') state.marks = {}
    return state.marks
  } catch (_) {
    return {}
  }
}

function seedMarks(state, cur) {
  try {
    if (state && cur && cur.matKind) matMarksOf(state)[cur.matKind] = { have: cur.matHave, left: cur.matLeft }
  } catch (_) { /* marks best-effort */ }
}

// Castle progress verdict with its reason (vmzq.21): cells, prep, the
// demanded kind's acquisition, or enabling growth (m1yb) — or null. A
// demand-kind switch alone is never progress (the sink adopts it); only
// growth under a known demand resets the clock. Enabling is checked last:
// under a frame/planks demand the material reason still names the move.
// Bounded: enabling counts only while the BASELINE kit is not ready (the
// final craft that lands the first pick still credits; every later chop
// past a ready baseline stays flat).
function castleProgressWhy(state, cur) {
  if (typeof cur.done === 'number' && typeof state.done === 'number' && cur.done > state.done) return 'cells'
  if (typeof cur.prepLeft === 'number' && typeof state.prepLeft === 'number' && cur.prepLeft < state.prepLeft) return 'prep'
  if (cur.matKind) {
    let have = state.matHave
    let left = state.matLeft
    if (cur.matKind !== state.matKind) {
      const m = matMarksOf(state)[cur.matKind]
      if (!m || typeof m !== 'object') return null
      have = m.have
      left = m.left
    }
    if (typeof cur.matHave === 'number' && typeof have === 'number' && cur.matHave > have) return `material:${cur.matKind}`
    if (typeof cur.matLeft === 'number' && typeof left === 'number' && cur.matLeft < left) return `material:${cur.matKind}`
  }
  if (!state.enReady) {
    if (typeof cur.enLogs === 'number' && typeof state.enLogs === 'number' && cur.enLogs > state.enLogs) return 'enabling:logs'
    if (typeof cur.enPlanks === 'number' && typeof state.enPlanks === 'number' && cur.enPlanks > state.enPlanks) return 'enabling:planks'
    if (typeof cur.enSticks === 'number' && typeof state.enSticks === 'number' && cur.enSticks > state.enSticks) return 'enabling:sticks'
    if (typeof cur.enGear === 'number' && typeof state.enGear === 'number' && cur.enGear > state.enGear) return 'enabling:gear'
  }
  return null
}

function castleProgressed(state, cur) {
  return castleProgressWhy(state, cur) !== null
}

// Regress moves the baseline (a creeper hole is repaired) without resetting
// the clock — only growth resets. matHave is a high-water mark and matLeft
// a low-water mark (core-3, verify body-1): neither ever moves against
// progress, so net-zero oscillations do not count.
function castleSinkBaseline(state, cur) {
  if (typeof cur.done === 'number' && (typeof state.done !== 'number' || cur.done < state.done)) state.done = cur.done
  if (typeof cur.total === 'number') state.total = cur.total
  if (typeof cur.prepLeft === 'number' && (typeof state.prepLeft !== 'number' || cur.prepLeft > state.prepLeft)) state.prepLeft = cur.prepLeft
  if (cur.matKind && cur.matKind !== state.matKind) {
    // Demand switch: stash the old kind's marks, restore the new kind's
    // sticky marks when known, else adopt the current count silently —
    // either way no reset (castleProgressWhy already said so).
    try {
      if (state.matKind) matMarksOf(state)[state.matKind] = { have: state.matHave, left: state.matLeft }
      const m = matMarksOf(state)[cur.matKind]
      state.matKind = cur.matKind
      if (m && typeof m === 'object') {
        state.matHave = m.have
        state.matLeft = m.left
      } else {
        state.matHave = cur.matHave
        state.matLeft = cur.matLeft
      }
    } catch (_) {
      state.matKind = cur.matKind
      state.matHave = cur.matHave
      state.matLeft = cur.matLeft
    }
  }
  // The placed clock (vmzq.20) sinks its regress baseline the same way, so
  // a repair past the hole re-arms it.
  if (typeof cur.done === 'number' && (typeof state.placedDone !== 'number' || cur.done < state.placedDone)) state.placedDone = cur.done
  if (typeof cur.prepLeft === 'number' && (typeof state.placedPrep !== 'number' || cur.prepLeft > state.placedPrep)) state.placedPrep = cur.prepLeft
  // Enabling (m1yb) is a last-tick delta, not a water mark: the baseline
  // always follows, so consumption never poisons the next gather. The
  // readiness gate follows too: a death-wiped kit re-opens credit until
  // the first pick lands again.
  if (typeof cur.enLogs === 'number') state.enLogs = cur.enLogs
  if (typeof cur.enPlanks === 'number') state.enPlanks = cur.enPlanks
  if (typeof cur.enSticks === 'number') state.enSticks = cur.enSticks
  if (typeof cur.enGear === 'number') state.enGear = cur.enGear
  if (typeof cur.enReady === 'boolean') state.enReady = cur.enReady
}

// Placed progress only (vmzq.20): cells laid or prep cleared. Material on
// hand does not count — the L1 must fire on flat placed progress while the
// bot is busy fetching.
function castlePlacedProgressed(state, cur) {
  if (typeof cur.done === 'number' && typeof state.placedDone === 'number' && cur.done > state.placedDone) return true
  if (typeof cur.prepLeft === 'number' && typeof state.placedPrep === 'number' && cur.prepLeft < state.placedPrep) return true
  return false
}

// One tick, called from runTick before the inShelter/fight short-circuits.
// Never throws; never moves the body.
function taskTick(bot, ctx, now = Date.now()) {
  try {
    if (!ctx) return
    // Strategic chooser wiring (idkcraft-u19u phase 2): goal.js decide()
    // delegates the multi-option day work-menu branch through ctx, so the
    // arbiter never requires the task layer (oqul.1).
    try {
      ctx.strategicChoose = strategicChoose
    } catch (_) { /* wiring best-effort */ }
    // Deadlock escalation wiring (idkcraft-u19u phase C): the work-mode
    // chooser goal.js decide() delegates through — same seam as above.
    try {
      ctx.deadlockChoose = deadlockChoose
    } catch (_) { /* wiring best-effort */ }
    // Park timers first (vmzq.3): wall-clock, independent of the stall
    // eligibility below. May resetTask, so before the state init.
    maybeResume(bot, ctx, now)
    if (!ctx.task || typeof ctx.task !== 'object') ctx.task = { active: null }
    // Order identity (finding 4, R2 core-1): compare only while the kind
    // is ACTIVE — a leftover t[k0] from a finished order is stale, not a
    // replace, and wiping ctx.task would take the castle/house clock with
    // it. Stale state is deleted so the newly-active branch re-baselines;
    // a live replace ends its window and drops only its own kind.
    try {
      const k0 = goalKind(ctx)
      if (k0 && isOrderKind(k0)) {
        const t0 = ctx.task
        const st0 = t0 && t0[k0]
        if (st0 && typeof st0 === 'object' && st0.orderRef !== orderStamp(orderObj(ctx, k0))) {
          if (t0.active === k0) {
            try {
              const g = ctx.goal
              if (g && g.commit) endCommit(bot, ctx, k0, st0, g.commit, 'preempted:replaced', now)
            } catch (_) { /* window best-effort */ }
            // A live replace founds a new goal (fresh text/startedAt);
            // ensureGoal below recreates it. The stale path keeps the
            // current goal — ensureGoal swaps it when the kind differs.
            try { ctx.goal = null } catch (_) { /* goal best-effort */ }
          }
          delete t0[k0]
        }
      }
    } catch (_) { /* identity best-effort */ }
    const t = ctx.task
    const kind = goalKind(ctx)
    // Commitment window accounting first (vmzq.21): preempts and pauses
    // apply on every tick, eligible or not, active task or none.
    try {
      commitTickTop(bot, ctx, now)
    } catch (_) { /* window best-effort */ }
    if (kind) {
      try {
        ensureGoal(ctx, kind, now)
      } catch (_) { /* goal best-effort */ }
    }

    // Gauges for every existing task (Grafana moves even while inactive).
    try {
      const st = ctx.castle
      if (st && st.site && st.progress && typeof st.progress.done === 'number') {
        metrics.taskProgress.set({ task: 'castle' }, st.progress.done)
        metrics.taskTotal.set({ task: 'castle' }, st.progress.total || 0)
      }
    } catch (_) { /* castle gauges best-effort */ }
    // Order gauges (.22, the bring label): have/want and levelled cells
    // move even while another goal is active.
    try {
      if (ctx.bring) {
        const oc = orderCurrent(bot, ctx, 'bring')
        if (typeof oc.done === 'number') metrics.taskProgress.set({ task: 'bring' }, oc.done)
        if (typeof oc.total === 'number') metrics.taskTotal.set({ task: 'bring' }, oc.total)
      }
    } catch (_) { /* bring gauges best-effort */ }
    try {
      if (ctx.flat && !ctx.flat.parked) {
        const oc = orderCurrent(bot, ctx, 'flat')
        if (typeof oc.done === 'number') metrics.taskProgress.set({ task: 'flat' }, oc.done)
        if (typeof oc.total === 'number') metrics.taskTotal.set({ task: 'flat' }, oc.total)
      }
    } catch (_) { /* flat gauges best-effort */ }
    let houseCur = null
    try {
      const home = ctx.home
      if (home && home.site && typeof home.site.x === 'number') {
        const cache = t.houseCache
        if (cache && typeof cache.at === 'number' && now - cache.at < TASK_HOUSE_CACHE_MS &&
          typeof cache.done === 'number' && typeof cache.total === 'number') {
          houseCur = { done: cache.done, total: cache.total }
          metrics.taskProgress.set({ task: 'house' }, houseCur.done)
          metrics.taskTotal.set({ task: 'house' }, houseCur.total)
        } else if (houseLoaded(bot, home)) {
          houseCur = houseProgress(bot, home)
          t.houseCache = { at: now, done: houseCur.done, total: houseCur.total }
          metrics.taskProgress.set({ task: 'house' }, houseCur.done)
          metrics.taskTotal.set({ task: 'house' }, houseCur.total)
        } else if (cache && typeof cache.done === 'number' && typeof cache.total === 'number') {
          // Unloaded (core-1): hold the last loaded reading for the clock;
          // the gauges keep their last values instead of dropping to 0.
          houseCur = { done: cache.done, total: cache.total }
        }
      }
    } catch (_) { /* house gauges best-effort */ }

    if (!kind) {
      t.active = null
      try {
        if (ctx.castle && ctx.castle.site) setStallGauge('castle', 0)
        if (ctx.home && ctx.home.site) setStallGauge('house', 0)
        for (const k of ORDER_KINDS) {
          try {
            setStallGauge(k, 0)
          } catch (_) { /* gauge best-effort */ }
        }
      } catch (_) { /* idle gauges best-effort */ }
      return
    }

    // Newly active task (or first tick): baseline now, no advance.
    // (.22) a work goal resuming after an ORDER keeps its clock (the .21
    // pause: order time never billed, the stale lastAt clamps to one tick).
    // Work-to-work switches (plan-B return) re-baseline fresh; orders
    // always baseline fresh (a new goal).
    if (t.active !== kind || !t[kind] || typeof t[kind] !== 'object') {
      if ((kind === 'castle' || kind === 'house') && t[kind] && typeof t[kind] === 'object' &&
        isOrderKind(t.active)) {
        t.active = kind
        // Fall through to advance this tick (the .21 pause shape).
      } else {
        t.active = kind
        if (kind === 'castle') {
          const cur = castleCurrent(bot, ctx, ctx.castle, now)
          t.castle = {
            done: cur.done, total: cur.total, prepLeft: cur.prepLeft,
            matKind: cur.matKind, matHave: cur.matHave, matLeft: cur.matLeft,
            enLogs: cur.enLogs, enPlanks: cur.enPlanks, enSticks: cur.enSticks, enGear: cur.enGear, enReady: cur.enReady,
            stallMs: 0, lastAt: now, lastL1At: null, fails: [],
            placedStallMs: 0, placedDone: cur.done, placedPrep: cur.prepLeft, placedLastAt: now,
          }
          seedMarks(t.castle, cur)
        } else if (isOrderKind(kind)) {
          const cur = orderCurrent(bot, ctx, kind)
          t[kind] = {
            done: cur.done, total: cur.total, dist: cur.dist,
            stallMs: 0, lastAt: now, lastL1At: null, fails: [],
            orderRef: orderStamp(orderObj(ctx, kind)),
          }
          // Travel goals baseline the distance as the total (blocks left).
          if ((kind === 'comehome' || kind === 'gocastle' || kind === 'lead') && typeof cur.dist === 'number') {
            t[kind].total = Math.round(cur.dist)
          }
        } else if (houseCur) {
          t.house = { done: houseCur.done, total: houseCur.total, wood: houseWood(bot), stallMs: 0, lastAt: now, lastL1At: null, fails: [] }
        } else {
          // Unloaded and never read (core-1): wait for a loaded reading
          // instead of baselining 0/0.
          t.house = { wood: houseWood(bot), stallMs: 0, lastAt: now, lastL1At: null, fails: [] }
        }
        setStallGauge(kind, 0)
        return
      }
    }

    const state = t[kind]
    // Order goals (.22): have/cells/dist metrics, watchdog only (no L1/L2
    // ladder — the park is the watchdog's, the L1 stays the work summary).
    if (isOrderKind(kind)) {
      const cur = orderCurrent(bot, ctx, kind)
      const readable = kind === 'bring' || kind === 'flat'
        ? typeof cur.done === 'number'
        : typeof cur.dist === 'number'
      if (!readable) {
        recordFail(ctx, state)
        if (!eligibleOrder(ctx, kind)) {
          if (orderHolding(ctx, kind)) holdReset(state)
          state.lastAt = now
          setStallGauge(kind, state.stallMs || 0)
          return
        }
        const billedUnread = addStall(state, now)
        setStallGauge(kind, state.stallMs)
        try {
          commitEligible(bot, ctx, kind, state, billedUnread, now)
        } catch (_) { /* window best-effort */ }
        try {
          maybeWatchdog(bot, ctx, kind, '?', '?', state, now)
        } catch (_) { /* watchdog best-effort */ }
        return
      }
      if (typeof state.done !== 'number' && (kind === 'bring' || kind === 'flat')) {
        state.done = cur.done
        state.total = cur.total
        state.lastAt = now
        setStallGauge(kind, state.stallMs || 0)
        return
      }
      if (typeof state.dist !== 'number' && typeof cur.dist === 'number') {
        state.dist = cur.dist
        if (typeof state.total !== 'number' || !(state.total > 0)) state.total = Math.round(cur.dist)
        state.lastAt = now
        setStallGauge(kind, state.stallMs || 0)
        return
      }
      const why = orderProgressWhy(state, cur, kind)
      if (why) {
        if (typeof cur.done === 'number') state.done = cur.done
        if (typeof cur.total === 'number') state.total = cur.total
        if (typeof cur.dist === 'number') state.dist = cur.dist
        if (typeof cur.blocks === 'number') state.blocks = cur.blocks
        progressReset(state, kind, now)
        logReset(kind, why)
        try {
          const g = ctx && ctx.goal
          const c0 = g && g.commit
          if (c0 && !keepUnlockWindow(state, c0)) endCommit(bot, ctx, kind, state, c0, 'progress', now)
        } catch (_) { /* window best-effort */ }
        return
      }
      // Self-order search grace (vmzq.63, prod: the beds wool hunt parked
      // every 61 s, its 5-min/24-leg budget never reached): while a self
      // hunt's search runs within its own budget the clock stays at 0 —
      // the budget is the deadline. Exhausted, the return phase or an
      // owner order (no o.self, legs uncapped) bill as before.
      if (kind === 'bring' && selfSearching(ctx && ctx.bring)) {
        state.stallMs = 0
        state.lastAt = now
        setStallGauge(kind, 0)
        if (!state.selfSearch) logReset(kind, 'self-search') // once per run, not per tick
        state.selfSearch = true
        return
      }
      state.selfSearch = false
      // Travel grace for the bring delivery leg (.22, the .21 shape): the
      // first return-phase run of a stall episode gets one clock reset
      // for the walk to the player — without it every delivery reads as
      // a stall. One grant per episode, floor rate-limits across episodes.
      if (watchdogOn() && kind === 'bring') {
        const wd = wdOf(state)
        const o = ctx && ctx.bring
        const returning = !!(o && o.phase === 'return' && typeof cur.dist === 'number')
        const freshRun = returning && wd.lastStep !== 'bring-return'
        wd.lastStep = returning ? 'bring-return' : (ctx.step || null)
        if (returning && typeof state.dist === 'number' && cur.dist + ORDER_ARRIVE_BLOCKS < state.dist) {
          // The walk advances: sink the baseline (low-water) without a
          // progress reset — have owns the clock, distance owns the grace.
          state.dist = cur.dist
        }
        if (freshRun && (wd.graceRuns || 0) < GOAL_GRACE_RUNS_PER_EPISODE && now - (wd.lastGraceAt || 0) >= goalGraceMs()) {
          wd.graceRuns = (wd.graceRuns || 0) + 1
          wd.lastGraceAt = now
          if (typeof cur.dist === 'number') state.dist = cur.dist
          state.stallMs = 0
          state.lastAt = now
          setStallGauge(kind, 0)
          logReset(kind, 'grace')
          return
        }
      }
      // Regress/narrow moves the baseline without resetting: travel
      // low-water (a detour around a wall may lengthen the walk), bring
      // have never sinks (drops are progress lost, not baseline).
      if ((kind === 'comehome' || kind === 'gocastle' || kind === 'lead') &&
        typeof cur.dist === 'number' && typeof state.dist === 'number' && cur.dist < state.dist) {
        state.dist = cur.dist
      }
      if (typeof cur.total === 'number' && (kind === 'bring' || kind === 'flat')) state.total = cur.total
      recordFail(ctx, state)
      if (!eligibleOrder(ctx, kind)) {
        if (orderHolding(ctx, kind)) holdReset(state)
        state.lastAt = now
        setStallGauge(kind, state.stallMs || 0)
        return
      }
      const billed = addStall(state, now)
      setStallGauge(kind, state.stallMs)
      try {
        commitEligible(bot, ctx, kind, state, billed, now)
      } catch (_) { /* window best-effort */ }
      try {
        const dd = (kind === 'comehome' || kind === 'gocastle' || kind === 'lead')
          ? (typeof state.dist === 'number' ? Math.round(state.dist) : '?')
          : cur.done
        const tt = (kind === 'comehome' || kind === 'gocastle' || kind === 'lead')
          ? (state.total || '?')
          : cur.total
        maybeWatchdog(bot, ctx, kind, dd, tt, state, now)
      } catch (_) { /* watchdog best-effort */ }
      return
    }
    if (kind === 'castle') {
      const cur = castleCurrent(bot, ctx, ctx.castle, now)
      if (castleTravel(bot, ctx, state)) {
        // Far walk back to the site (vmzq.35, prod: a respawn 500 off read
        // flat for 20 min): the any-clock resets, the placed clock accrues.
        state.stallMs = 0
        state.lastAt = now
        state.lastProgressAt = now
        try { resetWdProgress(wdOf(state)) } catch (_) { /* rounds best-effort */ }
        setStallGauge(kind, 0)
        addPlacedStall(state, now)
        logReset(kind, 'travel')
        return
      }
      if (typeof cur.done !== 'number') {
        // Run tracking for the travel grace (unread ticks count: a run
        // may start while the signals are unreadable).
        if (watchdogOn()) {
          try {
            wdOf(state).lastStep = ctx.step
          } catch (_) { /* run best-effort */ }
        }
        // Never read since connect (verify core-1): st.progress is not
        // persisted, so an off-site stall would never advance. Advance with
        // ?/? like the house; the first loaded reading baselines clean.
        recordFail(ctx, state)
        if (!eligible(bot, ctx)) {
          state.lastAt = now
          state.placedLastAt = now
          setStallGauge(kind, state.stallMs || 0)
          return
        }
        const billedUnread = addStall(state, now)
        addPlacedStall(state, now)
        setStallGauge(kind, state.stallMs)
        try {
          commitEligible(bot, ctx, kind, state, billedUnread, now)
        } catch (_) { /* window best-effort */ }
        try {
          maybeWatchdog(bot, ctx, kind, '?', '?', state, now)
        } catch (_) { /* watchdog best-effort */ }
        maybeL2(bot, ctx, kind, '?', '?', state, now)
        maybeL1(bot, ctx, kind, '?', '?', state, now)
        return
      }
      if (typeof state.done !== 'number') {
        state.done = cur.done
        state.total = cur.total
        state.prepLeft = cur.prepLeft
        state.matKind = cur.matKind
        state.matHave = cur.matHave
        state.matLeft = cur.matLeft
        state.enLogs = cur.enLogs
        state.enPlanks = cur.enPlanks
        state.enSticks = cur.enSticks
        state.enGear = cur.enGear
        state.enReady = cur.enReady
        seedMarks(state, cur)
        state.placedDone = cur.done
        state.placedPrep = cur.prepLeft
        state.lastAt = now
        state.placedLastAt = now
        setStallGauge(kind, state.stallMs || 0)
        return
      }
      // Placed progress resets both clocks; material-only progress resets
      // the any-clock but accrues the placed one toward L1 (vmzq.20) — flat
      // placed progress with the bot busy still reports. Enabling is
      // material-class (m1yb). The verdict is vmzq.21's marks-aware
      // castleProgressWhy; every any-clock reset logs its reason and ends
      // the commitment window.
      const why = castleProgressWhy(state, cur)
      const placed = castlePlacedProgressed(state, cur)
      if (why && placed) {
        state.done = cur.done
        state.total = cur.total
        state.prepLeft = cur.prepLeft
        state.matKind = cur.matKind
        state.matHave = cur.matHave
        state.matLeft = cur.matLeft
        state.enLogs = cur.enLogs
        state.enPlanks = cur.enPlanks
        state.enSticks = cur.enSticks
        state.enGear = cur.enGear
        state.enReady = cur.enReady
        seedMarks(state, cur)
        state.placedStallMs = 0
        state.placedDone = cur.done
        state.placedPrep = cur.prepLeft
        state.placedLastAt = now
        progressReset(state, kind, now)
        logReset(kind, why)
        try {
          const g = ctx && ctx.goal
          if (g && g.commit) endCommit(bot, ctx, kind, state, g.commit, 'progress', now)
        } catch (_) { /* window best-effort */ }
        return
      }
      if (why) {
        state.done = cur.done
        state.total = cur.total
        state.prepLeft = cur.prepLeft
        state.matKind = cur.matKind
        state.matHave = cur.matHave
        state.matLeft = cur.matLeft
        state.enLogs = cur.enLogs
        state.enPlanks = cur.enPlanks
        state.enSticks = cur.enSticks
        state.enGear = cur.enGear
        state.enReady = cur.enReady
        seedMarks(state, cur)
        state.stallMs = 0
        state.lastAt = now
        state.fails = []
        state.lastProgressAt = now
        try {
          const wd = wdOf(state)
          resetWdProgress(wd)
          wd.graceRuns = 0
        } catch (_) { /* rounds best-effort */ }
        clearPlan(state)
        logReset(kind, why)
        try {
          const g = ctx && ctx.goal
          const c0 = g && g.commit
          if (c0 && !keepUnlockWindow(state, c0)) endCommit(bot, ctx, kind, state, c0, 'progress', now)
        } catch (_) { /* window best-effort */ }
        if (!eligible(bot, ctx)) {
          state.placedLastAt = now
          setStallGauge(kind, state.stallMs || 0)
          return
        }
        addPlacedStall(state, now)
        setStallGauge(kind, state.stallMs)
        maybeL2(bot, ctx, kind, cur.done, cur.total, state, now)
        maybeL1(bot, ctx, kind, cur.done, cur.total, state, now)
        return
      }
      // Travel grace (vmzq.21, watchdog verdicts only): the first
      // castlefetch run of a stall episode gets one clock reset for the
      // quarry walk — without it every trip out reads as a stall. Runs
      // are step transitions, never stepPick.at (decide() re-stamps that
      // on every facts-changed re-pick, which would grant per re-pick),
      // and grants cap at one per episode (revmux 01 core-2): flip-flops
      // stay flat for the watchdog but can no longer silence the ladder.
      // The floor survives as a rate limit across episodes.
      if (watchdogOn()) {
        const wd = wdOf(state)
        const freshRun = ctx.step === 'castlefetch' && wd.lastStep !== 'castlefetch'
        wd.lastStep = ctx.step
        if (freshRun && (wd.graceRuns || 0) < GOAL_GRACE_RUNS_PER_EPISODE && now - (wd.lastGraceAt || 0) >= goalGraceMs()) {
          wd.graceRuns = (wd.graceRuns || 0) + 1
          wd.lastGraceAt = now
          state.stallMs = 0
          state.lastAt = now
          setStallGauge(kind, 0)
          logReset(kind, 'grace')
          return
        }
      }
      castleSinkBaseline(state, cur)
      recordFail(ctx, state)
      if (!eligible(bot, ctx)) {
        state.lastAt = now
        state.placedLastAt = now
        setStallGauge(kind, state.stallMs || 0)
        return
      }
      const billed = addStall(state, now)
      addPlacedStall(state, now)
      setStallGauge(kind, state.stallMs)
      try {
        commitEligible(bot, ctx, kind, state, billed, now)
      } catch (_) { /* window best-effort */ }
      try {
        maybeWatchdog(bot, ctx, kind, cur.done, cur.total, state, now)
      } catch (_) { /* watchdog best-effort */ }
      maybeL2(bot, ctx, kind, cur.done, cur.total, state, now)
      maybeL1(bot, ctx, kind, cur.done, cur.total, state, now)
      return
    }

    // House: placed cells, or wood toward them, or the walk to a far tree
    // (oqj5: houseProgressWhy, gatherTravel).
    // ponytail: an unread house (never loaded this process) has no cells-left
    // bound, so its wood earns no credit until the first loaded reading.
    const cur = houseCur
    const wood = houseWood(bot)
    if (typeof state.wood !== 'number') state.wood = wood
    if (!cur || typeof cur.done !== 'number') {
      // Never read since reset (round-2 core-1): the bot may be stalled far
      // from the house. Advance the clock so the stall still reports; the
      // first loaded reading baselines without resetting.
      recordFail(ctx, state)
      if (!eligible(bot, ctx)) {
        state.lastAt = now
        setStallGauge(kind, state.stallMs || 0)
        return
      }
      const billedUnread = addStall(state, now)
      setStallGauge(kind, state.stallMs)
      try {
        commitEligible(bot, ctx, kind, state, billedUnread, now)
      } catch (_) { /* window best-effort */ }
      try {
        maybeWatchdog(bot, ctx, kind, '?', '?', state, now)
      } catch (_) { /* watchdog best-effort */ }
      maybeL2(bot, ctx, kind, '?', '?', state, now)
      maybeL1(bot, ctx, kind, '?', '?', state, now)
      return
    }
    if (typeof state.done !== 'number') {
      state.done = cur.done
      state.total = cur.total
      state.lastAt = now
      setStallGauge(kind, state.stallMs || 0)
      return
    }
    // Castle work while the house is unbuilt (body-2): a growing castle
    // resets the house clock too, so the L1 does not blame the house while
    // the castle step owns the body.
    try {
      const step = ctx && ctx.step
      if ((step === 'castle' || step === 'castlefetch') && ctx.castle && ctx.castle.site) {
        const ccur = castleCurrent(bot, ctx, ctx.castle, now)
        if (!t.castleWatch || typeof t.castleWatch !== 'object') {
          t.castleWatch = { done: ccur.done, prepLeft: ccur.prepLeft, matKind: ccur.matKind, matHave: ccur.matHave, matLeft: ccur.matLeft, enLogs: ccur.enLogs, enPlanks: ccur.enPlanks, enSticks: ccur.enSticks, enGear: ccur.enGear, enReady: ccur.enReady }
          seedMarks(t.castleWatch, ccur)
        } else {
          const crossWhy = (typeof ccur.done === 'number' && typeof t.castleWatch.done === 'number') ? castleProgressWhy(t.castleWatch, ccur) : null
          if (crossWhy) {
            t.castleWatch = { done: ccur.done, total: ccur.total, prepLeft: ccur.prepLeft, matKind: ccur.matKind, matHave: ccur.matHave, matLeft: ccur.matLeft, enLogs: ccur.enLogs, enPlanks: ccur.enPlanks, enSticks: ccur.enSticks, enGear: ccur.enGear, enReady: ccur.enReady }
            seedMarks(t.castleWatch, ccur)
            progressReset(state, kind, now)
            logReset(kind, crossWhy)
            try {
              const g = ctx && ctx.goal
              const c0 = g && g.commit
              if (c0 && !keepUnlockWindow(state, c0)) endCommit(bot, ctx, kind, state, c0, 'progress', now)
            } catch (_) { /* window best-effort */ }
            return
          }
          castleSinkBaseline(t.castleWatch, ccur)
        }
      }
    } catch (_) { /* castle watch best-effort */ }
    const walked = gatherTravel(bot, ctx, state)
    const woodShort = typeof state.wood === 'number' && state.wood < state.total - state.done
    const houseWhy = houseProgressWhy(state, { done: cur.done, wood }) || (walked && woodShort ? 'travel' : null)
    if (houseWhy) {
      // Cells adopt the wood too: placing spends planks, a new episode.
      if (cur.done > state.done) {
        state.done = cur.done
        state.total = cur.total
      }
      // Travel keeps the wood mark and the tree marks (verify: a lowered
      // mark re-credits a consume-and-rechop; a cleared map re-credits an
      // A<->B walk). Real progress starts both afresh.
      if (houseWhy !== 'travel') {
        state.wood = wood
        state.trees = null
      }
      progressReset(state, kind, now)
      logReset(kind, houseWhy)
      try {
        const g = ctx && ctx.goal
        const c0 = g && g.commit
        if (c0 && !keepUnlockWindow(state, c0)) endCommit(bot, ctx, kind, state, c0, 'progress', now)
      } catch (_) { /* window best-effort */ }
      return
    }
    if (cur.done < state.done) state.done = cur.done
    if (typeof cur.total === 'number') state.total = cur.total
    recordFail(ctx, state)
    if (!eligible(bot, ctx)) {
      state.lastAt = now
      setStallGauge(kind, state.stallMs || 0)
      return
    }
    const billed = addStall(state, now)
    setStallGauge(kind, state.stallMs)
    try {
      commitEligible(bot, ctx, kind, state, billed, now)
    } catch (_) { /* window best-effort */ }
    try {
      maybeWatchdog(bot, ctx, kind, cur.done, cur.total, state, now)
    } catch (_) { /* watchdog best-effort */ }
    maybeL2(bot, ctx, kind, cur.done, cur.total, state, now)
    maybeL1(bot, ctx, kind, cur.done, cur.total, state, now)
  } catch (_) { /* task clock never breaks the tick */ }
}

require('./commitment').onCommitFinished(commitFinished) // oqul.5: decide() ends windows through this

module.exports = { castleCurrent, TASK_STALL_L1_MS, TASK_STALL_L2_MS, TASK_PARK_RETRY_MS, TASK_PARKS_PER_DAY, TASK_PARK_DIAG_MAX, TASK_HOUSE_CACHE_MS, TASK_PLAN_MIN_CONF, STALL_TICK_CLAMP_MS, GOAL_WATCHDOG_MS_DEFAULT, GOAL_COMMIT_MS_DEFAULT, GOAL_WATCHDOG_MAX_ROUNDS_DEFAULT, GOAL_TRAVEL_GRACE_MS_DEFAULT, GOAL_PLANB_SWITCH_MS_DEFAULT, GOAL_HISTORY_KEPT, ORDER_KINDS, taskKind, goalKind, isOrderKind, goalTextFor, eligibleOrder, orderHolding, orderObj, orderStamp, carryOrderStamp, orderCurrent, orderProgressWhy, applyCommit, diagnose, skippedReason, blockedReason, taskLine, resetTask, taskTick, clearTaskParks, goalWatchdogMs, goalCommitMs, goalMaxRounds, goalGraceMs, goalPlanbMs, watchdogOn, ownerOnline, commitFinished, PLAN_INSTRUCTIONS, PLAN_PARK_CRITERION, fallbackRank, planState, consumePlan, stratBackoff, goalPromptState, strategicChoose, deadlockChoose }
