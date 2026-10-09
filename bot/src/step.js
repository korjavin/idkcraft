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

module.exports = { stepDone, stepFailed, failReason, isFinished, stepGen, nextStepGen, stale, chatStep, STEP_CHAT_SAME_MS, orderStamp, carryOrderStamp }
