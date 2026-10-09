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

module.exports = { stepDone, stepFailed, failReason, isFinished, stepGen, nextStepGen, stale }
