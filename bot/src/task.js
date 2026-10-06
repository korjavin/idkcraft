'use strict'

// Task executive, slices 1-2 (idkcraft-vmzq.2/.3) + re-plan (.5): progress
// invariant + stall clock + L1 honest line + L2/L3 park ladder. No
// behaviour changes: this only measures (gauges), times the stall,
// chats/logs the ladder lines, fires one JEV step pick at L2 (the answer
// rides ctx.taskPlanStep, honoured one-shot by goal.js), and parks the
// task (a menu veto, honoured by goal.js) with a diagnosis.
//
// Active task: the house while unbuilt (build outranks castle in STEP_ORDER),
// else the castle while ordered, incomplete and not owner-parked, else
// none. A task-parked (L2 episode) task STAYS active: the stall invariant
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

function taskKind(ctx) {
  try {
    const home = ctx && ctx.home
    if (home && home.site && typeof home.site.x === 'number' && !home.built) return 'house'
  } catch (_) { /* fall through to castle */ }
  try {
    const st = ctx && ctx.castle
    // Task-parked (an L2 episode on the record) stays active — the clock
    // runs through the park so side work is still watched; owner-parked
    // (castle stop, no episode) pauses.
    if (st && st.site && typeof st.site.x === 'number' && (!st.parked || st.taskPark) && st.phase !== 'complete') return 'castle'
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
// the main task.
function chatL1(kind, done, total, diagnosis, parked) {
  const prefix = `${kind}: no progress for 15 min at ${done}/${total} — `
  const suffix = parked ? '; parked, doing side work' : '; still trying'
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

// Clamped stall advance; returns nothing, updates state in place.
function addStall(state, now) {
  const lastAt = typeof state.lastAt === 'number' ? state.lastAt : now
  state.stallMs = (state.stallMs || 0) + Math.min(Math.max(0, now - lastAt), STALL_TICK_CLAMP_MS)
  state.lastAt = now
}

// L1 check + fire. Dedupes on the diagnosis string (sayBlocked precedent):
// a repeated identical diagnosis stays silent instead of re-chatting every
// 15 min; the throttle still moves so the next distinct diagnosis is fresh.
function maybeL1(bot, ctx, kind, done, total, state, now) {
  if (state.stallMs < TASK_STALL_L1_MS) return
  if (state.lastL1At && now - state.lastL1At < TASK_STALL_L1_MS) return
  const diagnosis = diagnose(bot, ctx)
  if (diagnosis === state.lastL1Diag) {
    state.lastL1At = now
    return
  }
  const step = (ctx && ctx.step) || 'none'
  const rec = kind === 'castle' ? (ctx && ctx.castle) : (ctx && ctx.home)
  const parked = !!(rec && rec.taskPark)
  try {
    console.log(`task ${kind} ${done}/${total} stall=${Math.floor(state.stallMs / 1000)}s${parked ? ' parked' : ''} step=${step} why=${diagnosis}`)
  } catch (_) { /* log best-effort */ }
  try {
    bot.chat(chatL1(kind, done, total, diagnosis, parked))
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
// itself — the tick path stays as is).
function planState(bot, ctx, kind, done, total, state) {
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
  return {
    goal: kind === 'castle' ? 'build castle' : 'build home',
    progress: `${done}/${total}`,
    blocked_on: diagnose(bot, ctx),
    recent,
    since_min: Math.floor(((state && state.stallMs) || 0) / 60000),
    facts: factsText,
  }
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

function maybeL2(bot, ctx, kind, done, total, state, now) {
  if (state.stallMs < TASK_STALL_L2_MS) return
  const rec = kind === 'castle' ? (ctx && ctx.castle) : (ctx && ctx.home)
  if (!rec || rec.taskPark) return
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
// task finished under the park) clear silently.
function maybeResume(bot, ctx, now) {
  try {
    if (!ctx || typeof ctx !== 'object') return
    for (const kind of ['castle', 'house']) {
      const rec = kind === 'castle' ? ctx.castle : ctx.home
      if (!rec || typeof rec !== 'object' || !rec.taskPark) continue
      if ((kind === 'castle' && rec.phase === 'complete') || (kind === 'house' && rec.built === true)) {
        rec.taskPark = null
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
function taskLine(ctx) {
  try {
    const t = ctx && ctx.task
    const kind = t && t.active
    const st = kind && t[kind]
    if (!kind || !st) return null
    const done = typeof st.done === 'number' ? st.done : '?'
    const total = typeof st.total === 'number' ? st.total : '?'
    return `task ${kind} ${done}/${total} stall=${stallFmt(st.stallMs || 0)}`
  } catch (_) {
    return null
  }
}

// Full reset: next tick re-baselines (new/forgotten task, stop/go, go work).
// Death/respawn deliberately do NOT reset — the walk back is part of the job.
function resetTask(ctx) {
  try {
    if (ctx) ctx.task = null
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

function castleProgressed(state, cur) {
  if (typeof cur.done === 'number' && typeof state.done === 'number' && cur.done > state.done) return true
  if (typeof cur.prepLeft === 'number' && typeof state.prepLeft === 'number' && cur.prepLeft < state.prepLeft) return true
  if (cur.matKind && cur.matKind === state.matKind) {
    if (typeof cur.matHave === 'number' && typeof state.matHave === 'number' && cur.matHave > state.matHave) return true
    if (typeof cur.matLeft === 'number' && typeof state.matLeft === 'number' && cur.matLeft < state.matLeft) return true
  }
  return false
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
    state.matKind = cur.matKind
    state.matHave = cur.matHave
    state.matLeft = cur.matLeft
  }
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
        }
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
        // Never read since connect (verify core-1): st.progress is not
        // persisted, so an off-site stall would never advance. Advance with
        // ?/? like the house; the first loaded reading baselines clean.
        recordFail(ctx, state)
        if (!eligible(bot, ctx)) {
          state.lastAt = now
          setStallGauge(kind, state.stallMs || 0)
          return
        }
        addStall(state, now)
        setStallGauge(kind, state.stallMs)
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
        state.lastAt = now
        setStallGauge(kind, state.stallMs || 0)
        return
      }
      if (castleProgressed(state, cur)) {
        state.done = cur.done
        state.total = cur.total
        state.prepLeft = cur.prepLeft
        state.matKind = cur.matKind
        state.matHave = cur.matHave
        state.matLeft = cur.matLeft
        state.stallMs = 0
        state.lastAt = now
        state.lastL1At = null
        state.lastL1Diag = null
        state.fails = []
        clearPlan(state)
        setStallGauge(kind, 0)
        return
      }
      castleSinkBaseline(state, cur)
      recordFail(ctx, state)
      if (!eligible(bot, ctx)) {
        state.lastAt = now
        setStallGauge(kind, state.stallMs || 0)
        return
      }
      addStall(state, now)
      setStallGauge(kind, state.stallMs)
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
      addStall(state, now)
      setStallGauge(kind, state.stallMs)
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
        } else if (typeof ccur.done === 'number' && typeof t.castleWatch.done === 'number' && castleProgressed(t.castleWatch, ccur)) {
          t.castleWatch = { done: ccur.done, total: ccur.total, prepLeft: ccur.prepLeft, matKind: ccur.matKind, matHave: ccur.matHave, matLeft: ccur.matLeft }
          state.stallMs = 0
          state.lastAt = now
          state.lastL1At = null
          state.lastL1Diag = null
          state.fails = []
          clearPlan(state)
          setStallGauge(kind, 0)
          return
        } else {
          castleSinkBaseline(t.castleWatch, ccur)
        }
      }
    } catch (_) { /* castle watch best-effort */ }
    if (cur.done > state.done) {
      state.done = cur.done
      state.total = cur.total
      state.stallMs = 0
      state.lastAt = now
      state.lastL1At = null
      state.lastL1Diag = null
      state.fails = []
      clearPlan(state)
      setStallGauge(kind, 0)
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
    addStall(state, now)
    setStallGauge(kind, state.stallMs)
    maybeL2(bot, ctx, kind, cur.done, cur.total, state, now)
    maybeL1(bot, ctx, kind, cur.done, cur.total, state, now)
  } catch (_) { /* task clock never breaks the tick */ }
}

module.exports = { TASK_STALL_L1_MS, TASK_STALL_L2_MS, TASK_PARK_RETRY_MS, TASK_PARKS_PER_DAY, TASK_PARK_DIAG_MAX, TASK_HOUSE_CACHE_MS, TASK_PLAN_MIN_CONF, STALL_TICK_CLAMP_MS, taskKind, diagnose, skippedReason, blockedReason, taskLine, resetTask, taskTick, clearTaskParks }
