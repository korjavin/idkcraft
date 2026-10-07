'use strict'

// Task executive, slices 1-2 (idkcraft-vmzq.2/.3) + re-plan (.5) + goal
// watchdog (.21): progress invariant + stall clock + L1 honest line +
// L2/L3 park ladder. No behaviour changes: this only measures (gauges),
// times the stall, chats/logs the ladder lines, runs fast JEV rounds
// while a goal's metric is flat (the answer rides a bounded commitment
// window on ctx.goal, honoured by goal.js), and parks the task (a menu
// veto, honoured by goal.js) with a diagnosis.
//
// Active task: the castle while ordered, incomplete and not owner-parked
// (castle outranks build in STEP_ORDER, vmzq.19 — the body works the
// castle while the house stands unbuilt, so the clock watches the castle;
// watching the house would L2-park it and veto the castle chain's
// gather/craft), else the house while unbuilt, else none. A task-parked
// (L2 episode) task STAYS active: the stall invariant
// still applies to side work (owner Q2) — the clock runs, L1 keeps firing
// with a parked suffix, L2 does not re-fire. Owner-parked (castle stop,
// no episode) pauses. The stall clock advances only on day + work +
// not-paused + no-order ticks — fight and shelter time COUNT (the hook sits
// before those short-circuits), night/paused/orders (incl. a running flat
// order, vmzq.8) pause it. Any progress resets it: castle place cells,
// prep remaining, demanded-material on hand / remainder; house placed cells.

const metrics = require('./metrics')
const { CHAT_LIMIT } = require('./commands')

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
// Watchdog question language (NOT the tick path: ASK_INSTRUCTIONS and
// goalText() stay untouched — the facts-text diff IS the decision
// cadence). Short clauses in the STEP_CRITERIA style.
const PLAN_INSTRUCTIONS = 'The goal is stalled: pick the step most likely to move its progress metric now; park only if no step can help'
const PLAN_PARK_CRITERION = 'no step can move the goal now: stop the task and rest at home'

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
    return require('./goal').timeWord(bot) === 'day'
  } catch (_) {
    return false
  }
}

// Goal identity (vmzq.21): the active task as an ownable goal. The
// generation counts foundings per session; every async JEV request and
// every commitment carries {goalId, generation} and is dropped when they
// no longer match (the .5 seq guard generalised). resetTask clears the
// goal, so stop/go/forget/new order all invalidate in flight.
function ensureGoal(ctx, kind, now) {
  try {
    if (!ctx || (kind !== 'castle' && kind !== 'house')) return null
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
    const goal = { id: `${kind}-${seq}`, kind, generation: seq, text: kind === 'castle' ? 'build castle' : 'build home', startedAt: now }
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
    return !!(bot && bot.players && Object.keys(bot.players).some((n) => n !== bot.username))
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

function chatL2(kind, done, total, diagnosis) {
  const resume = kind === 'castle' ? 'say castle go to resume' : 'say go work to resume'
  return chatClipped(`${kind} parked at ${done}/${total} after 45 min without progress — `, `; ${resume}`, diagnosis)
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
      bot.chat(latched ? chatL3(kind, diagnosis) : chatL2(kind, done, total, diagnosis))
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
    if (n === 'rest') return false
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
  const out = {
    goal: kind === 'castle' ? 'build castle' : 'build home',
    progress: `${done}/${total}`,
    blocked_on: diagnose(bot, ctx),
    recent,
    since_min: Math.floor(((state && state.stallMs) || 0) / 60000),
    facts: factsText,
  }
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
    if (msg.startsWith('jev http')) return 'http'
    if (msg.startsWith('jev missing')) return 'invalid'
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
    for (const n of menu) criteria[n] = goal.STEP_CRITERIA[n]
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

// Consume a stored plan answer: force a valid confident step one-shot
// (fresh stall window; decide() honours ctx.taskPlanStep), or park
// deterministically on any failure. Returns the park diagnosis when it
// parked, null when it forced a step.
function consumePlan(bot, ctx, kind, done, total, state, now) {
  const ans = state.planAnswer
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
    }
  } catch (_) { /* clear best-effort */ }
}

// Watchdog round state, lazily attached per task (vmzq.21): consecutive
// flat rounds, the decision history ring, the in-flight marker, the last
// fire time (the min call interval), the failure backoff, the travel
// grace stamps (grants this episode + floor + run tracking), and the
// plan-B phase.
function wdOf(state) {
  try {
    if (!state.wd || typeof state.wd !== 'object') {
      state.wd = { rounds: 0, history: [], seq: 0, pending: null, answer: null, firedAt: 0, backoffMs: 0, backoffUntil: 0, graceRuns: 0, lastGraceAt: 0, lastStep: null, planb: null }
    }
    if (!Array.isArray(state.wd.history)) state.wd.history = []
    return state.wd
  } catch (_) {
    return { rounds: 0, history: [], seq: 0, pending: null, answer: null, firedAt: 0, backoffMs: 0, backoffUntil: 0, graceRuns: 0, lastGraceAt: 0, lastStep: null, planb: null }
  }
}

// Watchdog menu: feasible + registered, failHolds IGNORED (retrying a
// held step is the point), rest excluded — plus the CURRENT step as a
// bounded hold (the run-4 answer the .5 menu could not offer) and park
// as the deterministic out. Costed unlocks arrive in vmzq.22.
function watchdogMenu(bot, ctx) {
  const goal = require('./goal')
  const facts = goal.goalFacts(bot, ctx)
  const steps = goal.STEP_ORDER.filter((n) => {
    if (n === 'rest') return false
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
function fireWatchdog(bot, ctx, kind, done, total, state, wd, now) {
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
    for (const n of menu) criteria[n] = n === 'park' ? PLAN_PARK_CRITERION : goal.STEP_CRITERIA[n]
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
    }
  } catch (_) { /* a dropped answer re-fires on the next tick */ }
}

// Consume a stored watchdog answer: apply the choice as a bounded
// commitment, park on a park choice (owner online) or plan-B when alone
// (owner: plan-B replaces the alone-park), or back off on any failure.
// Every resolution logs one `goal watchdog` line with its metric increment.
// An answer whose stall resolved mid-call (progress after the fire) is
// moot: dropped silently, no pin and no backoff (a drop is not a
// failure — the next stall fires fresh).
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
    options = watchdogMenu(bot, ctx).join(',')
  } catch (_) {
    options = ''
  }
  const fail = (source, prefix) => {
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
  if (choice === 'park') {
    const conf = typeof ans.conf === 'number' ? ans.conf.toFixed(2) : '?'
    const diagnosis = diagnose(bot, ctx)
    try {
      console.log(`goal watchdog kind=${kind} id=${id} progress=${done}/${total} stall=${stallS}s round=${round} step=${step} options=${options} choice=park conf=${conf} source=${ans.source || 'jev'} why=${diagnosis}`)
    } catch (_) { /* log best-effort */ }
    try {
      metrics.goalWatchdogTotal.inc({ kind, choice: 'park', source: ans.source || 'jev' })
    } catch (_) { /* counter best-effort */ }
    wd.backoffMs = 0
    wd.backoffUntil = 0
    // A park choice is a fork, not a park: owner online parks, owner
    // offline runs plan-B (relocate, re-ask, switch, return) — the same
    // fork as the round cap, so an early park never bypasses plan-B.
    maxRounds(bot, ctx, kind, state, wd, now)
    return
  }
  let valid = typeof choice === 'string' && choice !== 'rest'
  try {
    const goal = require('./goal')
    if (!goal.MENU[choice]) valid = false
  } catch (_) {
    valid = false
  }
  if (!valid) {
    fail('invalid', 'invalid')
    return
  }
  // Stale answer (the .5 rule): the menu moved between fire and consume,
  // so decide() could not apply the force — back off instead of burning
  // a round on it. Holds are NOT consulted (same rule as the force path).
  let fresh = false
  try {
    const goal = require('./goal')
    const facts = goal.goalFacts(bot, ctx)
    fresh = !!(goal.MENU[choice] && goal.MENU[choice].feasible(facts, bot, ctx) && goal.registered(choice))
  } catch (_) {
    fresh = false
  }
  if (!fresh) {
    fail('invalid', `stale:${choice}`)
    return
  }
  if (typeof ans.conf === 'number' && ans.conf < TASK_PLAN_MIN_CONF) {
    fail('invalid', `low-confidence conf=${ans.conf.toFixed(2)}`)
    return
  }
  const conf = typeof ans.conf === 'number' ? ans.conf.toFixed(2) : '?'
  const diagnosis = diagnose(bot, ctx)
  try {
    console.log(`goal watchdog kind=${kind} id=${id} progress=${done}/${total} stall=${stallS}s round=${round} step=${step} options=${options} choice=${choice} conf=${conf} source=${ans.source || 'jev'} why=${diagnosis}`)
  } catch (_) { /* log best-effort */ }
  try {
    metrics.goalWatchdogTotal.inc({ kind, choice, source: ans.source || 'jev' })
  } catch (_) { /* counter best-effort */ }
  wd.backoffMs = 0
  wd.backoffUntil = 0
  applyCommit(bot, ctx, kind, choice, choice, now)
}

// One tick of the fast watchdog: consume-first (the maybeL2 precedent),
// then fire when the goal's metric sat flat for GOAL_WATCHDOG_MS of
// eligible time. No planner, parked task, live window, in-flight call,
// backoff or min-interval block the fire; the L1/L2 ladder below still
// reports and parks.
function maybeWatchdog(bot, ctx, kind, done, total, state, now) {
  try {
    if (!watchdogOn()) return
    const t = ctx && ctx.task
    if (!t || typeof t !== 'object') return
    const rec = kind === 'castle' ? (ctx && ctx.castle) : (ctx && ctx.home)
    if (!rec || rec.taskPark) return
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
    return { done: st && st.done, total: st && st.total }
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
    marks,
  }
}

// Did the goal-result signals advance past the window's snapshot? The
// snapshot has the state shape, so the progress verdict is shared.
function commitAdvanced(bot, ctx, kind, c) {
  const s = (c && c.snapshot) || {}
  if ((kind || (c && c.kind)) === 'house') {
    let done = null
    try {
      const home = ctx.home
      if (home && home.site && houseLoaded(bot, home)) done = houseProgress(bot, home).done
    } catch (_) {
      done = null
    }
    return typeof done === 'number' && typeof s.done === 'number' && done > s.done
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
  if ((kind || (c && c.kind)) === 'house') {
    let done = null
    try {
      const home = ctx.home
      if (home && home.site && houseLoaded(bot, home)) done = houseProgress(bot, home).done
    } catch (_) {
      done = null
    }
    const before = typeof s.done === 'number' ? s.done : '?'
    return `cells${before}->${typeof done === 'number' ? done : before}`
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
  if (typeof s.done === 'number') return `cells${s.done}->${typeof cur.done === 'number' ? cur.done : s.done}`
  if (s.matKind && typeof s.matHave === 'number') return `${s.matKind}${s.matHave}->${typeof cur.matHave === 'number' ? cur.matHave : s.matHave}`
  return '?'
}

// Apply a watchdog choice as a bounded commitment window (GOAL_COMMIT_MS).
// decide() honours it (safety-first); taskTick pauses, expires and ends
// it. optionId seeds the .22 option table (plain steps here).
function applyCommit(bot, ctx, kind, optionId, step, now) {
  try {
    const g = ctx && ctx.goal
    if (!g || g.kind !== kind) return false
    g.commit = {
      goalId: g.id, generation: g.generation, kind, optionId, step,
      until: now + goalCommitMs(), appliedAt: now, lastTick: now,
      deaths: (ctx && ctx.deaths) || 0,
      snapshot: commitSnapshot(bot, ctx, kind),
    }
    return true
  } catch (_) {
    return false
  }
}

// End a live window: one `goal outcome` line, one history entry, round
// accounting (flat and failed count, progress clears, preempted stands),
// then the round-cap fork. Idempotent: ending twice logs once.
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
    const step = (c && c.step) || '?'
    const k = kind || (c && c.kind) || '?'
    try {
      console.log(`goal outcome kind=${k} choice=${step} dur=${Math.floor(durMs / 1000)}s delta=${delta} result=${result}`)
    } catch (_) { /* log best-effort */ }
    const wd = state ? wdOf(state) : null
    if (wd) {
      try {
        wd.history.push({ choice: step, outcome: result, dur_s: Math.floor(durMs / 1000), delta })
        while (wd.history.length > GOAL_HISTORY_KEPT) wd.history.shift()
      } catch (_) { /* history best-effort */ }
      if (result === 'progress') {
        wd.rounds = 0
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
    // Replaced: the window's goal is no longer the active task and it is
    // not complete (a switch moved on without ending it).
    try {
      const active = taskKind(ctx)
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
    if (c.step === 'castlefetch' || c.step === 'gather' || c.step === 'forage') {
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
      endCommit(bot, ctx, kind, state, c, advanced ? 'progress' : 'flat', now)
    }
  } catch (_) { /* window never breaks the tick */ }
}

// Round-cap fork (owner 2026-10-07): owner online -> park with the
// diagnosis (today's L2 line asks them to resume); owner offline ->
// plan-B, which replaces the alone park. Plan-B phase 1 relocates aside
// for one window and re-asks JEV with the outcome in history; a still
// flat non-relocate round moves to phase 2, the goal switch.
function maxRounds(bot, ctx, kind, state, wd, now) {
  const done = state && typeof state.done === 'number' ? state.done : '?'
  const total = state && typeof state.total === 'number' ? state.total : '?'
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
      if (!ep || ep.auto !== true || typeof ep.at !== 'number') continue
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
function taskLine(ctx) {
  try {
    const t = ctx && ctx.task
    const kind = t && t.active
    const st = kind && t[kind]
    if (!kind || !st) return null
    const done = typeof st.done === 'number' ? st.done : '?'
    const total = typeof st.total === 'number' ? st.total : '?'
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
      try {
        console.log(`goal outcome kind=${(c && c.kind) || '?'} choice=${(c && c.step) || '?'} dur=${dur}s delta=? result=preempted:${why || 'generation'}`)
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
    wdOf(state).rounds = 0
    wdOf(state).graceRuns = 0
  } catch (_) { /* rounds best-effort */ }
  clearPlan(state)
  setStallGauge(kind, 0)
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

// Castle progress verdict with its reason (vmzq.21): cells, prep, or the
// demanded kind's acquisition — or null. A demand-kind switch alone is
// never progress (the sink adopts it); only growth under a known demand
// resets the clock.
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
    // Park timers first (vmzq.3): wall-clock, independent of the stall
    // eligibility below. May resetTask, so before the state init.
    maybeResume(bot, ctx, now)
    if (!ctx.task || typeof ctx.task !== 'object') ctx.task = { active: null }
    const t = ctx.task
    const kind = taskKind(ctx)
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
      } catch (_) { /* idle gauges best-effort */ }
      return
    }

    // Newly active task (or first tick): baseline now, no advance.
    if (t.active !== kind || !t[kind] || typeof t[kind] !== 'object') {
      t.active = kind
      if (kind === 'castle') {
        const cur = castleCurrent(bot, ctx, ctx.castle, now)
        t.castle = {
          done: cur.done, total: cur.total, prepLeft: cur.prepLeft,
          matKind: cur.matKind, matHave: cur.matHave, matLeft: cur.matLeft,
          stallMs: 0, lastAt: now, lastL1At: null, fails: [],
          placedStallMs: 0, placedDone: cur.done, placedPrep: cur.prepLeft, placedLastAt: now,
        }
        seedMarks(t.castle, cur)
      } else if (houseCur) {
        t.house = { done: houseCur.done, total: houseCur.total, stallMs: 0, lastAt: now, lastL1At: null, fails: [] }
      } else {
        // Unloaded and never read (core-1): wait for a loaded reading
        // instead of baselining 0/0.
        t.house = { stallMs: 0, lastAt: now, lastL1At: null, fails: [] }
      }
      setStallGauge(kind, 0)
      return
    }

    const state = t[kind]
    if (kind === 'castle') {
      const cur = castleCurrent(bot, ctx, ctx.castle, now)
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
      // placed progress with the bot busy still reports. The verdict is
      // vmzq.21's marks-aware castleProgressWhy; every any-clock reset logs
      // its reason and ends the commitment window.
      const why = castleProgressWhy(state, cur)
      const placed = castlePlacedProgressed(state, cur)
      if (why && placed) {
        state.done = cur.done
        state.total = cur.total
        state.prepLeft = cur.prepLeft
        state.matKind = cur.matKind
        state.matHave = cur.matHave
        state.matLeft = cur.matLeft
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
        seedMarks(state, cur)
        state.stallMs = 0
        state.lastAt = now
        state.fails = []
        state.lastProgressAt = now
        try {
          wdOf(state).rounds = 0
          wdOf(state).graceRuns = 0
        } catch (_) { /* rounds best-effort */ }
        clearPlan(state)
        logReset(kind, why)
        try {
          const g = ctx && ctx.goal
          if (g && g.commit) endCommit(bot, ctx, kind, state, g.commit, 'progress', now)
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

    // House: placed cells only.
    const cur = houseCur
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
          t.castleWatch = { done: ccur.done, prepLeft: ccur.prepLeft, matKind: ccur.matKind, matHave: ccur.matHave, matLeft: ccur.matLeft }
          seedMarks(t.castleWatch, ccur)
        } else {
          const crossWhy = (typeof ccur.done === 'number' && typeof t.castleWatch.done === 'number') ? castleProgressWhy(t.castleWatch, ccur) : null
          if (crossWhy) {
            t.castleWatch = { done: ccur.done, total: ccur.total, prepLeft: ccur.prepLeft, matKind: ccur.matKind, matHave: ccur.matHave, matLeft: ccur.matLeft }
            seedMarks(t.castleWatch, ccur)
            progressReset(state, kind, now)
            logReset(kind, crossWhy)
            try {
              const g = ctx && ctx.goal
              if (g && g.commit) endCommit(bot, ctx, kind, state, g.commit, 'progress', now)
            } catch (_) { /* window best-effort */ }
            return
          }
          castleSinkBaseline(t.castleWatch, ccur)
        }
      }
    } catch (_) { /* castle watch best-effort */ }
    if (cur.done > state.done) {
      state.done = cur.done
      state.total = cur.total
      progressReset(state, kind, now)
      logReset(kind, 'cells')
      try {
        const g = ctx && ctx.goal
        if (g && g.commit) endCommit(bot, ctx, kind, state, g.commit, 'progress', now)
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

module.exports = { TASK_STALL_L1_MS, TASK_STALL_L2_MS, TASK_PARK_RETRY_MS, TASK_PARKS_PER_DAY, TASK_PARK_DIAG_MAX, TASK_HOUSE_CACHE_MS, TASK_PLAN_MIN_CONF, STALL_TICK_CLAMP_MS, GOAL_WATCHDOG_MS_DEFAULT, GOAL_COMMIT_MS_DEFAULT, GOAL_WATCHDOG_MAX_ROUNDS_DEFAULT, GOAL_TRAVEL_GRACE_MS_DEFAULT, GOAL_PLANB_SWITCH_MS_DEFAULT, GOAL_HISTORY_KEPT, taskKind, diagnose, skippedReason, blockedReason, taskLine, resetTask, taskTick, clearTaskParks, goalWatchdogMs, goalCommitMs, goalMaxRounds, goalGraceMs, goalPlanbMs, watchdogOn, ownerOnline, commitFinished, PLAN_INSTRUCTIONS, PLAN_PARK_CRITERION }
