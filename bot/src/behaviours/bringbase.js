'use strict'
// Bring order ends and shared amounts, moved verbatim out of bring.js
// (idkcraft-oqul.11): bring.js and bringitem.js both read them, and
// bringitem no longer needs a deferred require back into bring (the
// bring<->bringitem cycle). Leaf: perception/metrics/util only.

const { countItems } = require('../perception')
const metrics = require('../metrics')
const { say, clearGoal } = require('./util')

const WANT_ORE = 3
const WANT_MAX = 16

function countDrop(bot, drop) {
  try {
    return countItems(bot, (n) => n === drop)
  } catch (_) {
    return 0
  }
}

function bringKind(ctx) {
  return (ctx.bring && ctx.bring.kind) || 'block'
}

// A bring smelt (ipn.20) never outlives its order: the job drops and a
// settled outcome is consumed, so goal.js gearOutcome never translates it
// into gear's status (castlefetch finish() shape). Called from every end:
// refuse/done here, bring.clearSearchLeg for stop/park/new-owner cancels.
// ponytail: a window cycle still in flight settles after this unread.
function releaseSmelt(ctx) {
  const f = ctx && ctx.furnace
  if (!f || !f.bring) return
  ctx.furnaceJob = null
  f.bring = false
  if (f.settled) f.result = null
}

function refuse(bot, ctx, line) {
  // A failed sub-order (did.4) reads as the parent's honest line: the gap
  // that never filled, not the leg that failed it.
  const o = ctx && ctx.bring
  const sub = o && o.subFor && o.subWant && o.subWord
    ? `could not get ${o.subWant} ${o.subWord} for the ${o.subFor} in time`
    : null
  say(bot, sub || line)
  metrics.bring.inc({ outcome: 'refused', kind: bringKind(ctx) })
  ctx.bring = null
  releaseSmelt(ctx)
  clearGoal(bot, ctx)
}

function done(bot, ctx) {
  metrics.bring.inc({ outcome: 'done', kind: bringKind(ctx) })
  ctx.bring = null
  releaseSmelt(ctx)
  clearGoal(bot, ctx)
}

module.exports = { WANT_ORE, WANT_MAX, countDrop, bringKind, refuse, done, releaseSmelt }
