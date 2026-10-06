'use strict'

// Task executive, slice 1 (idkcraft-vmzq.2): progress invariant + stall clock
// + L1 honest line. No behaviour changes: this only measures (gauges), times
// the stall, and chats/logs one line per 15 min episode. Park/re-plan is .3.
//
// Active task: the house while unbuilt (build outranks castle in STEP_ORDER),
// else the castle while ordered, unparked and incomplete, else none. The
// stall clock advances only on day + work + not-paused + no-order ticks —
// fight and shelter time COUNT (the hook sits before those short-circuits),
// night/paused/orders pause it. Any progress resets it: castle place cells,
// prep remaining, demanded-material on hand / remainder; house placed cells.

const metrics = require('./metrics')
const { CHAT_LIMIT } = require('./commands')

const TASK_STALL_L1_MS = 15 * 60 * 1000
const TASK_HOUSE_CACHE_MS = 60 * 1000
const TASK_FAILS_KEPT = 3

function taskKind(ctx) {
  try {
    const home = ctx && ctx.home
    if (home && home.site && typeof home.site.x === 'number' && !home.built) return 'house'
  } catch (_) { /* fall through to castle */ }
  try {
    const st = ctx && ctx.castle
    if (st && st.site && typeof st.site.x === 'number' && !st.parked && st.phase !== 'complete') return 'castle'
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
  return true
}

// Placed cells of the home plan (NOT nextCellIdx: an index treats skipped
// cells as done). 99 blockAt max (v2), cached 60 s by the caller.
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

// Diagnosis for the L1 line, extracted from the status builder shape
// (orders.js status: step, stepStatus, stepPick.why, skipped/blocked holds)
// plus the castle word and recent failures. .3/.5 consume this same string.
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
    try { skipped = goal.restWhy(facts, bot, ctx, names, (ctx && ctx.step) || 'none') } catch (_) { skipped = '' }
    if (skipped && skipped !== 'model choice') parts.push(`skipped: ${skipped}`)
    try {
      const fails = ctx && ctx.stepFail && typeof ctx.stepFail === 'object' ? Object.keys(ctx.stepFail) : []
      if (fails.length > 0) {
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
        if (holding.length > 0) {
          const held = holding.map((n) => {
            let w = null
            try { w = goal.stepWhy(n, facts, bot, ctx, text) } catch (_) { w = null }
            if (!w) {
              const rec = (ctx.stepFail && ctx.stepFail[n]) || {}
              w = rec.status === 'done' ? `${n} holds after an unchanged done` : `${n} holds after failure`
            }
            return w
          })
          parts.push(`blocked: ${held.join(', ')}`)
        }
      }
    } catch (_) { /* blocked best-effort */ }
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

// L1 chat line; the diagnosis clips, the honest suffix never does.
function chatL1(kind, done, total, diagnosis) {
  const prefix = `${kind}: no progress for 15 min at ${done}/${total} — `
  const suffix = '; still trying'
  const maxDiag = CHAT_LIMIT - prefix.length - suffix.length
  const diag = String(diagnosis || 'unknown')
  const clipped = diag.length > maxDiag && maxDiag > 1 ? diag.slice(0, maxDiag - 1) + '…' : diag
  return prefix + clipped + suffix
}

// Status line fragment: 'task castle 8/1722 stall=23m', or null when no task.
function taskLine(ctx) {
  try {
    const t = ctx && ctx.task
    const kind = t && t.active
    const st = kind && t[kind]
    if (!kind || !st || typeof st.done !== 'number' || typeof st.total !== 'number') return null
    return `task ${kind} ${st.done}/${st.total} stall=${stallFmt(st.stallMs || 0)}`
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
      const castle = require('./behaviours/castle')
      const list = castle.prepTargets(bot, ctx, st, now)
      out.prepLeft = Array.isArray(list) ? list.length : 0
    } else {
      out.prepLeft = 0
    }
  } catch (_) { /* prep best-effort */ }
  try {
    const cw = ctx && ctx.castleWord
    if (cw && typeof cw.kind === 'string' && cw.kind) {
      out.matKind = cw.kind
      if (typeof cw.left === 'number') out.matLeft = cw.left
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

// Regress moves the baseline (a creeper hole is repaired, spent material is
// re-gathered) without resetting the clock — only growth resets.
function castleSinkBaseline(state, cur) {
  if (typeof cur.done === 'number' && (typeof state.done !== 'number' || cur.done < state.done)) state.done = cur.done
  if (typeof cur.total === 'number') state.total = cur.total
  if (typeof cur.prepLeft === 'number' && (typeof state.prepLeft !== 'number' || cur.prepLeft > state.prepLeft)) state.prepLeft = cur.prepLeft
  if (cur.matKind && cur.matKind !== state.matKind) {
    state.matKind = cur.matKind
    state.matHave = cur.matHave
    state.matLeft = cur.matLeft
  } else {
    if (typeof cur.matHave === 'number' && (typeof state.matHave !== 'number' || cur.matHave < state.matHave)) state.matHave = cur.matHave
    if (typeof cur.matLeft === 'number' && (typeof state.matLeft !== 'number' || cur.matLeft > state.matLeft)) state.matLeft = cur.matLeft
  }
}

// One tick, called from runTick before the inShelter/fight short-circuits.
// Never throws; never moves the body.
function taskTick(bot, ctx, now = Date.now()) {
  try {
    if (!ctx) return
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
        } else {
          houseCur = houseProgress(bot, home)
          t.houseCache = { at: now, done: houseCur.done, total: houseCur.total }
        }
        metrics.taskProgress.set({ task: 'house' }, houseCur.done)
        metrics.taskTotal.set({ task: 'house' }, houseCur.total)
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
      } else {
        const cur = houseCur || { done: 0, total: 0 }
        t.house = { done: cur.done, total: cur.total, stallMs: 0, lastAt: now, lastL1At: null, fails: [] }
      }
      setStallGauge(kind, 0)
      return
    }

    const state = t[kind]
    if (kind === 'castle') {
      const cur = castleCurrent(bot, ctx, ctx.castle, now)
      if (typeof cur.done !== 'number') {
        // No progress reading yet (off-site, never scanned): hold the clock.
        state.lastAt = now
        setStallGauge(kind, state.stallMs || 0)
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
        state.fails = []
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
      const lastAt = typeof state.lastAt === 'number' ? state.lastAt : now
      state.stallMs = (state.stallMs || 0) + Math.max(0, now - lastAt)
      state.lastAt = now
      setStallGauge(kind, state.stallMs)
      if (state.stallMs >= TASK_STALL_L1_MS && (!state.lastL1At || now - state.lastL1At >= TASK_STALL_L1_MS)) {
        const diagnosis = diagnose(bot, ctx)
        const done = typeof cur.done === 'number' ? cur.done : 0
        const total = typeof cur.total === 'number' ? cur.total : 0
        const step = (ctx && ctx.step) || 'none'
        try {
          console.log(`task ${kind} ${done}/${total} stall=${Math.floor(state.stallMs / 1000)}s step=${step} why=${diagnosis}`)
        } catch (_) { /* log best-effort */ }
        try {
          bot.chat(chatL1(kind, done, total, diagnosis))
        } catch (_) { /* chat best-effort */ }
        try {
          metrics.taskStallTotal.inc({ task: kind, level: 'L1' })
        } catch (_) { /* counter best-effort */ }
        state.lastL1At = now
      }
      return
    }

    // House: placed cells only.
    const cur = houseCur || { done: 0, total: 0 }
    if (typeof state.done !== 'number') {
      state.done = cur.done
      state.total = cur.total
      state.lastAt = now
      setStallGauge(kind, state.stallMs || 0)
      return
    }
    if (cur.done > state.done) {
      state.done = cur.done
      state.total = cur.total
      state.stallMs = 0
      state.lastAt = now
      state.lastL1At = null
      state.fails = []
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
    const lastAt = typeof state.lastAt === 'number' ? state.lastAt : now
    state.stallMs = (state.stallMs || 0) + Math.max(0, now - lastAt)
    state.lastAt = now
    setStallGauge(kind, state.stallMs)
    if (state.stallMs >= TASK_STALL_L1_MS && (!state.lastL1At || now - state.lastL1At >= TASK_STALL_L1_MS)) {
      const diagnosis = diagnose(bot, ctx)
      const step = (ctx && ctx.step) || 'none'
      try {
        console.log(`task ${kind} ${cur.done}/${cur.total} stall=${Math.floor(state.stallMs / 1000)}s step=${step} why=${diagnosis}`)
      } catch (_) { /* log best-effort */ }
      try {
        bot.chat(chatL1(kind, cur.done, cur.total, diagnosis))
      } catch (_) { /* chat best-effort */ }
      try {
        metrics.taskStallTotal.inc({ task: kind, level: 'L1' })
      } catch (_) { /* counter best-effort */ }
      state.lastL1At = now
    }
  } catch (_) { /* task clock never breaks the tick */ }
}

module.exports = { TASK_STALL_L1_MS, TASK_HOUSE_CACHE_MS, taskKind, diagnose, taskLine, resetTask, taskTick }
