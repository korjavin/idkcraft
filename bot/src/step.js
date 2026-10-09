'use strict'

// Step completion protocol (idkcraft-oqul.6): a behaviour ends its goal
// step with ctx.stepStatus = 'done' | 'failed:<reason>'. New writes and
// parses go through here; existing ones move over when a PR touches the
// file. Pure pass-through: same strings, no side effects.

const FAILED = 'failed:'

function stepDone(ctx) {
  ctx.stepStatus = 'done'
}

function stepFailed(ctx, reason) {
  ctx.stepStatus = FAILED + reason
}

// 'failed:x' -> 'x' ('failed:' -> ''), anything else -> null.
function failReason(status) {
  return typeof status === 'string' && status.startsWith(FAILED) ? status.slice(FAILED.length) : null
}

function isFinished(status) {
  return status === 'done' || failReason(status) !== null
}

module.exports = { stepDone, stepFailed, failReason, isFinished }
