'use strict'

// Step completion protocol (idkcraft-oqul.6): a behaviour ends its goal
// step with ctx.stepStatus = 'done' | 'failed:<reason>'. New writes and
// parses go through here; existing ones move over when a PR touches the
// file. Same strings as the raw writes.
//
// Step identity (idkcraft-oqul.7): ctx.stepGen bumps whenever a new step
// instance starts (decide's fresh pick, an order/stop reset, a death, a
// retreat chain taking the step). An async op captures stepGen(ctx) when it
// starts and passes it to stepDone/stepFailed; a completion whose gen no
// longer matches belongs to a step that is gone and is dropped (counted +
// logged). Opt-in: no gen passed = written as before.

const metrics = require('./metrics')

const FAILED = 'failed:'

function stepGen(ctx) {
  return (ctx && ctx.stepGen) | 0
}

function nextStepGen(ctx) {
  ctx.stepGen = stepGen(ctx) + 1
}

// True (and counted) when a captured gen no longer matches the step.
function stale(ctx, gen) {
  if (gen === undefined || gen === stepGen(ctx)) return false
  const step = String((ctx && ctx.step) || 'none')
  try { metrics.stepStaleCompletions.inc({ step }) } catch (_) { /* metric best-effort */ }
  try { console.log(`step stale-completion dropped step=${step} gen=${gen} now=${stepGen(ctx)}`) } catch (_) { /* log best-effort */ }
  return true
}

function stepDone(ctx, gen) {
  if (stale(ctx, gen)) return false
  ctx.stepStatus = 'done'
  return true
}

function stepFailed(ctx, reason, gen) {
  if (stale(ctx, gen)) return false
  ctx.stepStatus = FAILED + reason
  return true
}

// 'failed:x' -> 'x' ('failed:' -> ''), anything else -> null.
function failReason(status) {
  return typeof status === 'string' && status.startsWith(FAILED) ? status.slice(FAILED.length) : null
}

function isFinished(status) {
  return status === 'done' || failReason(status) !== null
}

// f3s: repeat step-change chats throttled (Paper kicks past ~10 rapid lines,
// and a flip-flopping menu re-decides every tick: the assayed kick shape is
// 2-3 steps alternating, so each line is rate-limited independently — comparing
// only to the last line would still let A,B,A,B through). The same line chats
// at most every 10 s; a line never chatted (or silent >10 s) always passes.
// The console keeps every transition. First chat per ctx always passes. Same
// timestamp style as explore's departure throttle. Moved from goal.js
// (idkcraft-oqul.11) so forage needs no arbiter; goal.js re-exports it.
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

// Stable order identity (R2 core-1): re-arms replace the order object
// mid-order (home.js exit start/reseek/fail), so object identity alone
// would read every re-arm as a replaced order and reset the stall clock.
// The stamp is allocated per object, carried across re-arms, and stored
// as orderRef at baseline; a genuinely new order object gets a fresh one.
// Moved from task.js (idkcraft-oqul.11) so home.js needs no task loop;
// task.js re-exports both.
const orderStamps = new WeakMap()
let orderStampSeq = 0
function orderStamp(o) {
  try {
    if (!o || typeof o !== 'object') return null
    let s = orderStamps.get(o)
    if (typeof s !== 'number') {
      s = ++orderStampSeq
      orderStamps.set(o, s)
    }
    return s
  } catch (_) {
    return null
  }
}
function carryOrderStamp(from, to) {
  try {
    if (!from || typeof from !== 'object' || !to || typeof to !== 'object' || from === to) return
    const s = orderStamp(from)
    if (typeof s === 'number') orderStamps.set(to, s)
  } catch (_) { /* carry best-effort */ }
}

// Idle running step (owner 2026-11-19, prod bot5: 1038 ticks explore
// 'running' with no goal, no path, no motion; bot2 750 castlefetch): a work
// step that holds 'running' with no pathfinder goal, no motion and no own
// wait reason (ctx.idleWhy, dig, window, builder/mine, a reflex) for
// IDLE_RUN_MS fails 'no-target', so decide re-picks instead of standing.
// Called once per goal-fsm dispatch, after the behaviour ran.
const IDLE_RUN_MS = 30000
const IDLE_RUN_MOVE = 4 // blocks: water drift is not progress
const IDLE_RUN_EXEMPT = new Set(['rest', 'stay', 'shelter'])
function idleRunGuard(bot, ctx, now = Date.now()) {
  try {
    const p = bot.entity && bot.entity.position
    const pf = bot.pathfinder
    const idle = ctx.work && ctx.stepStatus === 'running' && ctx.step && !IDLE_RUN_EXEMPT.has(ctx.step) && p &&
      pf && pf.goal == null && !(typeof pf.isMoving === 'function' && pf.isMoving()) &&
      !ctx.idleWhy && !bot.targetDigBlock && !bot.currentWindow && !bot._build && !bot._mine &&
      !(ctx.recovery && ctx.recovery.action)
    const r = ctx.idleRun
    if (!idle) { ctx.idleRun = null; return false }
    if (!r || r.step !== ctx.step || r.gen !== stepGen(ctx) || Math.hypot(p.x - r.x, p.y - r.y, p.z - r.z) > IDLE_RUN_MOVE) {
      ctx.idleRun = { step: ctx.step, gen: stepGen(ctx), since: now, x: p.x, y: p.y, z: p.z }
      return false
    }
    if (now - r.since < IDLE_RUN_MS) return false
    console.log(`idle running step=${ctx.step} for=${Math.round((now - r.since) / 1000)}s -> failed:no-target`)
    ctx.idleRun = null
    ctx.lastGoalKey = '' // the next pick re-issues its goal
    stepFailed(ctx, 'no-target')
    return true
  } catch (_) { return false }
}

module.exports = { idleRunGuard, IDLE_RUN_MS, stepDone, stepFailed, failReason, isFinished, stepGen, nextStepGen, stale, chatStep, STEP_CHAT_SAME_MS, orderStamp, carryOrderStamp }
