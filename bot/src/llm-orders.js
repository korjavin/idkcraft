'use strict'

// LLM orders (idkcraft-vf8e.6). With BOT_LLM_ORDERS=1 (and ANTHROPIC_API_KEY)
// a player's chat line the FSM cannot parse becomes ONE Messages-API call
// (brain.llmCall: the .5 token counters + LLM_TOKENS_PER_HOUR cap) that
// answers a JSON plan over a whitelist:
// - order steps = the existing chat orders, re-fed through handleChat as the
//   player's own line (every chat-time guard, refusal and executor stays);
// - work steps = goal MENU steps, pinned one at a time through
//   ctx.taskPlanStep, the stall-planner seam decide() already honours
//   (feasible + registered only); the pin is held while a night step
//   would win (nightHold), since pinMenu checks no safety for it.
// The task executive runs each step as usual (orders keep their watchdog and
// park, work steps their decide/commit rules). No LLM on the tick: tick()
// only reads ctx to move to the next step. Flag off: nothing here runs.
// ponytail: raw Baritone #commands are not plan steps — on v2 bring/flat
// already drive #mine/#goto over the bridge with the protected-block guards;
// a raw #mine would bypass them. Skills (vf8e.2) join when they enter MENU.

const brain = require('./brain')
const goal = require('./goal')
const metrics = require('./metrics')
const { STEP_EFFECT_TEXT } = require('./plan-consts')
const { isFinished, failReason, stepGen, chatStep } = require('./step')
const { WANT_MAX } = require('./behaviours/bringbase')

const ORDER_TIMEOUT_MS = 20000
const STEP_MS = 10 * 60 * 1000 // one plan step's deadline
const PLAN_MAX = 6
const MISS_TICKS = 3 // pin consumed without the step starting = not possible now

const ORDER_STEPS = {
  // codex: max = the executor's own clamp (bring WANT_MAX, flat FLAT_MAX_RADIUS) so a
  // bigger count refuses instead of silently delivering less and reporting done.
  bring: { args: 'item, count', max: WANT_MAX, what: `gets an item to the player (count at most ${WANT_MAX}): from the pack, the home chest, by crafting or smelting it, mining the block, shearing sheep or hunting for food`, chat: (s) => `bring me ${s.item}${s.count ? ` ${s.count}` : ''}` },
  find: { args: 'item', what: 'finds the nearest block of that name and leads the player to it', chat: (s) => `find me ${s.item}` },
  flat: { args: 'count', max: 64, what: 'levels the ground around the player, count = radius', chat: (s) => `flat ${s.count || 8}` },
  share: { args: '', what: 'hands the player everything carried except tools, weapons and armour', chat: () => 'share' },
}
// Work steps the plan may pin: not the night/safety steps (the FSM owns
// them), not deliver/rest/castle internals.
const WORK_STEPS = ['craft', 'equip', 'build', 'beds', 'light', 'gather', 'stockpile', 'gear', 'forage', 'explore']

const SYSTEM = 'You turn a Minecraft player\'s chat line into a plan for their companion bot. ' +
  'Use only the listed step ids, in the order they must run. Item and block names are Minecraft registry ids (torch, water_bucket, iron_ore). ' +
  'Answer JSON only, no prose: {"plan":[{"step":"<id>","item":"<id>","count":<n>,"done":"<what is true when this step is done>"}]}. ' +
  'Leave out item/count when the step takes none. At most ' + PLAN_MAX + ' steps; use the fewest — an order step gathers, mines, crafts and smelts for itself, so never put forage or gather before it. ' +
  'Answer {"plan":[]} when the line is not an order to the bot or no listed step can do it.'

function enabled(env = process.env) {
  return /^(1|true|yes)$/i.test(String(env.BOT_LLM_ORDERS || '')) && !!env.ANTHROPIC_API_KEY
}

function workSteps() {
  return WORK_STEPS.filter((n) => goal.MENU[n] && goal.registered(n))
}

function stepList() {
  const lines = Object.entries(ORDER_STEPS).map(([id, s]) => `${id}(${s.args}): ${s.what}`)
  for (const id of workSteps()) {
    const when = goal.STEP_CRITERIA[id] ? ` (runs when: ${goal.STEP_CRITERIA[id].split(':')[0]})` : ''
    lines.push(`${id}: ${STEP_EFFECT_TEXT[id] || id}${when}`)
  }
  return lines.join('\n')
}

function inventoryText(bot) {
  try {
    const n = {}
    for (const i of bot.inventory.items()) n[i.name] = (n[i.name] || 0) + i.count
    return Object.entries(n).map(([k, v]) => `${k} ${v}`).join(', ') || 'empty'
  } catch (_) { return 'unknown' }
}

function stateText(bot, ctx) {
  try { return goal.goalText(goal.goalFacts(bot, ctx), ctx.home) } catch (_) { return 'unknown' }
}

// Model answer -> { steps } | { error } | { empty: true }. The whitelist is
// the safety: an id outside it refuses the whole plan.
function validatePlan(ans, works = workSteps()) {
  const raw = ans && Array.isArray(ans.plan) ? ans.plan : null
  if (!raw) return { error: 'no plan' }
  if (raw.length === 0) return { empty: true }
  if (raw.length > PLAN_MAX) return { error: `plan too long (${raw.length})` }
  const steps = []
  for (const r of raw) {
    const id = r && typeof r.step === 'string' ? r.step.toLowerCase().trim() : ''
    if (!ORDER_STEPS[id] && !works.includes(id)) return { error: `no step "${id.slice(0, 20)}"` }
    const s = { step: id, done: typeof r.done === 'string' ? r.done.replace(/\s+/g, ' ').trim().slice(0, 80) : '' }
    if (ORDER_STEPS[id] && ORDER_STEPS[id].args.includes('item')) {
      const item = String(r.item || '').toLowerCase().trim().replace(/\s+/g, '_')
      if (!/^[a-z0-9_]{1,40}$/.test(item)) return { error: `${id} needs an item` }
      s.item = item
    }
    if (ORDER_STEPS[id] && ORDER_STEPS[id].args.includes('count') && r.count != null) {
      const c = Math.floor(Number(r.count))
      if (!(c >= 1 && c <= ORDER_STEPS[id].max)) return { error: `${id} count ${String(r.count).slice(0, 8)}` }
      s.count = c
    }
    steps.push(s)
  }
  return { steps }
}

function label(s) {
  return [s.step, s.item, s.count].filter((x) => x != null && x !== '').join(' ')
}

// One Messages-API call -> { steps|error|empty, tokens }.
async function planOrder(bot, ctx, text, fetchFn) {
  const user = `Order from the player: "${text}"\n\nBot state: ${stateText(bot, ctx)}\nInventory: ${inventoryText(bot)}\n\nSteps (id(args): what it does):\n${stepList()}`
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(new DOMException('order timeout', 'TimeoutError')), ORDER_TIMEOUT_MS)
  let data
  try {
    data = await brain.llmCall({
      use: 'orders',
      apiKey: process.env.ANTHROPIC_API_KEY,
      signal: ac.signal,
      fetchFn,
      body: {
        model: process.env.LLM_MODEL || brain.LLM_MODEL,
        max_tokens: 500,
        thinking: { type: 'disabled' },
        system: SYSTEM,
        messages: [{ role: 'user', content: user }],
      },
    })
  } finally {
    clearTimeout(timer)
  }
  const u = (data && data.usage) || {}
  const tokens = `${u.input_tokens | 0}/${u.output_tokens | 0}`
  const out = ((data && Array.isArray(data.content) ? data.content : []).find((b) => b && b.type === 'text') || {}).text || ''
  let ans = null
  try { ans = JSON.parse(out.slice(out.indexOf('{'), out.lastIndexOf('}') + 1)) } catch (_) { ans = null }
  return { ...validatePlan(ans), tokens }
}

// Chat entry: ask for a plan, never blocking the chat handler. One ask in
// flight (ctx.llmAsk); a running plan (ctx.llmOrder) is replaced only by a
// valid new plan — chatter answered {"plan":[]} leaves it alone.
// req = { text, by, ticker, feed(line), fallback } — fallback is the FSM's
// own refusal, chatted when no plan comes back.
function ask(bot, ctx, req, fetchFn) {
  if (!ctx || ctx.llmAsk) return false
  const a = { text: String(req.text).slice(0, 200), at: Date.now() }
  ctx.llmAsk = a
  const say = (line) => { try { bot.chat(line) } catch (_) { /* chat best-effort */ } }
  return (async () => {
    let r
    try {
      r = await planOrder(bot, ctx, a.text, fetchFn)
    } catch (err) {
      const msg = String(err && err.message ? err.message : err)
      r = { error: err && err.name === 'TimeoutError' ? 'timeout' : msg.startsWith('llm budget') ? 'budget' : msg.slice(0, 40), outcome: msg.startsWith('llm budget') ? 'budget' : 'error' }
    }
    if (ctx.llmAsk !== a) return // cancelled mid-ask (stop / follow me / go work)
    ctx.llmAsk = null
    const ms = Date.now() - a.at
    const outcome = r.steps ? 'ok' : r.empty ? 'empty' : (r.outcome || 'invalid')
    try { metrics.llmCalls.inc({ use: 'orders', outcome }) } catch (_) { /* metric best-effort */ }
    console.log(`llm order by=${req.by} text="${a.text}" outcome=${outcome} plan=${r.steps ? r.steps.map(label).join('>') : (r.error || '-')} tokens=${r.tokens || '0/0'} ms=${ms}`)
    if (r.empty) { if (req.fallback) say(req.fallback); return }
    if (!r.steps) {
      // Chatter that failed to plan stays silent (log only); an explicit
      // `plan <order>` or a refused order gets its answer.
      if (req.fallback || req.explicit) say(req.fallback || `I can't plan that (${r.error}) — try: help`)
      return
    }
    if (ctx.llmOrder) { release(ctx, ctx.llmOrder); console.log(`llm order end text="${ctx.llmOrder.text}" result=replaced`) }
    ctx.llmOrder = { text: a.text, by: req.by, ticker: req.ticker, feed: req.feed, steps: r.steps, i: 0, cur: null, at: Date.now(), feeding: false }
    say(`plan: ${r.steps.map(label).join(', then ')}`.slice(0, 250))
  })()
}

// Owner stop / follow me / go work: the plan and any ask in flight end.
function cancel(ctx, why = 'stop') {
  if (!ctx) return
  const o = ctx.llmOrder
  if (o) {
    console.log(`llm order end text="${o.text}" result=${why} step=${o.i + 1}/${o.steps.length}`)
    // A pin the arbiter has not consumed yet would still force the step.
    const s = o.steps[o.i]
    if (s && ctx.taskPlanStep === s.step) ctx.taskPlanStep = null
  }
  ctx.llmOrder = null
  ctx.llmAsk = null
}

// True while the sequencer re-feeds its own chat line: the chat hooks must
// not send that line back to the model.
function feeding(ctx) {
  return !!(ctx && ctx.llmOrder && ctx.llmOrder.feeding)
}

function orderBusy(ctx) {
  return !!(ctx.bring || ctx.pendingSearch || ctx.lead || (ctx.flat && !ctx.flat.parked))
}

// A work pin has no safety check in goal.pinMenu (the stall planner's
// one-shot), so the plan holds its pins while a night/safety step owns or
// would take the body — it re-pins when that ends.
const NIGHT = ['stay', 'gohome', 'shelter']
function nightHold(bot, ctx) {
  // ctx.step is the goal arbiter's only in work mode (stale otherwise).
  if (ctx.work && NIGHT.includes(ctx.step) && !isFinished(ctx.stepStatus)) return true
  try {
    const f = goal.goalFacts(bot, ctx)
    // A daytime `come home` hold also sets inShelter: that is an owner
    // order the plan replaces (ticker.work releases it), not night safety.
    if (ctx.inShelter && f.time !== 'day') return true
    return NIGHT.includes(goal.goalFsm(f, NIGHT.filter((n) => goal.MENU[n] && goal.MENU[n].feasible(f, bot, ctx))))
  } catch (_) { return false }
}

function stillFeasible(bot, ctx, step) {
  try { return !!(goal.MENU[step] && goal.MENU[step].feasible(goal.goalFacts(bot, ctx), bot, ctx) && goal.registered(step)) } catch (_) { return false }
}

// How the step's order ended: bringbase/lead/flat stamp done or a failure
// at their single end points; gone without a stamp since the step began =
// cancelled. A find that never led (nothing found, too deep) = refused.
const END_FIELD = { bring: 'bringEnd', share: 'bringEnd', find: 'leadEnd', flat: 'flatEnd' }
function orderResult(ctx, s, c) {
  if (s.step === 'find' && !c.led) return 'failed:refused'
  const e = ctx[END_FIELD[s.step]]
  if (!e || !(e.at >= c.at)) return 'failed:cancelled'
  return e.outcome === 'done' ? 'done' : 'failed:refused'
}

// Drop what the plan's current step still owns, so a timed-out or replaced
// plan leaves no executor running (codex P2): the bring (counted cancelled,
// as every order drop does), the lead and its far search, the flat (parked,
// like stop), an unconsumed pin.
function release(ctx, o) {
  const s = o && o.cur && o.steps[o.i]
  if (!s) return
  if (!ORDER_STEPS[s.step]) {
    if (ctx.taskPlanStep === s.step) ctx.taskPlanStep = null
    return
  }
  if (ctx.bring) {
    try { metrics.bring.inc({ outcome: 'cancelled', kind: ctx.bring.kind || 'block' }) } catch (_) { /* metric best-effort */ }
    ctx.bring = null
    try { require('./behaviours/bring').clearSearchLeg(ctx) } catch (_) { /* leg best-effort */ }
  }
  if (s.step === 'find' && (ctx.lead || ctx.pendingSearch) && o.ticker && typeof o.ticker.clearLead === 'function') o.ticker.clearLead()
  if (s.step === 'flat' && ctx.flat) ctx.flat.parked = true
}

function end(bot, ctx, o, result) {
  if (result !== 'done') release(ctx, o)
  const n = o.steps.length
  console.log(`llm order end text="${o.text}" result=${result} step=${Math.min(o.i + 1, n)}/${n} dur=${Math.floor((Date.now() - o.at) / 1000)}s`)
  if (ctx.llmOrder === o) ctx.llmOrder = null
  const why = failReason(result)
  if (result === 'done') chatStep(bot, ctx, `done: ${o.text}`.slice(0, 250))
  else if (why !== null) chatStep(bot, ctx, `plan stopped at ${label(o.steps[o.i])}: ${why || 'failed'}`.slice(0, 250))
}

function startStep(bot, ctx, o, s, now) {
  const order = ORDER_STEPS[s.step]
  if (!order && nightHold(bot, ctx)) {
    // Wait the night out unpinned, bounded like a running step.
    if (o.waitAt == null) o.waitAt = now
    else if (now - o.waitAt > STEP_MS) return end(bot, ctx, o, 'failed:timeout')
    return
  }
  o.waitAt = null
  o.cur = { at: now, gen: stepGen(ctx), seen: false, status: null, miss: 0, led: false }
  if (order) {
    // Accepted = the line created (or resumed) its own executor; an
    // unrelated order already running is not this step's (codex P2).
    const before = { bring: ctx.bring, lead: ctx.lead, ps: ctx.pendingSearch, flat: ctx.flat, parked: !!(ctx.flat && ctx.flat.parked) }
    o.feeding = true
    try { o.feed(order.chat(s)) } finally { o.feeding = false }
    const made = (ctx.bring && ctx.bring !== before.bring) || (ctx.lead && ctx.lead !== before.lead) ||
      (ctx.pendingSearch && ctx.pendingSearch !== before.ps) ||
      (ctx.flat && !ctx.flat.parked && (ctx.flat !== before.flat || before.parked))
    if (!made) {
      // Refused (its reply already chatted why: unknown, nothing found, too
      // deep, nothing to share). o.cur dropped first: end() must not
      // release the unrelated order that may be running.
      o.cur = null
      return end(bot, ctx, o, 'failed:refused')
    }
    if (ctx.lead) o.cur.led = true
    return
  }
  if (!ctx.work && o.ticker && typeof o.ticker.work === 'function') o.ticker.work()
  ctx.taskPlanStep = s.step
}

// Every tick (index.js), cheap: no plan, no work.
function tick(bot, ctx, now = Date.now()) {
  const o = ctx && ctx.llmOrder
  if (!o) return
  const s = o.steps[o.i]
  if (!s) return end(bot, ctx, o, 'done')
  if (!o.cur) return startStep(bot, ctx, o, s, now)
  const c = o.cur
  if (ctx.paused) return end(bot, ctx, o, 'stop')
  if (!c.held && now - c.at > STEP_MS) return end(bot, ctx, o, 'failed:timeout')
  const next = () => { o.i++; o.cur = null }
  if (ORDER_STEPS[s.step]) {
    if (orderBusy(ctx)) { if (ctx.lead) c.led = true; return }
    const r = orderResult(ctx, s, c)
    return r === 'done' ? next() : end(bot, ctx, o, r)
  }
  if (!ctx.work) return end(bot, ctx, o, 'mode')
  const ours = ctx.step === s.step && (stepGen(ctx) !== c.gen || !isFinished(ctx.stepStatus))
  if (ours) {
    c.seen = true
    c.status = ctx.stepStatus
    if (isFinished(c.status)) return c.status === 'done' ? next() : end(bot, ctx, o, c.status)
    return
  }
  // Left the step and it had finished between two reads.
  if (c.seen && isFinished(c.status)) return c.status === 'done' ? next() : end(bot, ctx, o, c.status)
  if (nightHold(bot, ctx)) {
    // Held: no pin (a pending one is withdrawn so the night step wins), no
    // miss, no deadline; the step re-pins when the night ends.
    if (ctx.taskPlanStep === s.step) ctx.taskPlanStep = null
    c.held = true
    c.seen = false
    return
  }
  if (c.held) {
    c.held = false
    c.at = now
    c.gen = stepGen(ctx)
    c.miss = 0
    ctx.taskPlanStep = s.step
    return
  }
  if (c.seen) {
    // Another step took the body. A retreat (non-MENU ctx.step) re-pins;
    // the goal arbiter re-deciding away (textForce releases a task-plan
    // pick on every text move, `known` flickers every 1-3 s) re-pins only
    // while the step is still feasible, and a flicker never kills a live
    // one (revmux 02/03: a count cap did). A step that RAN and left the menu
    // did its work (rig: light placed 10 torches, unlit went none, the
    // arbiter moved on with no `done` status) = done; one that never ran is
    // the miss path below. ponytail: "left the menu" can also mean "ran out
    // of material" — read the step's own failReason if that lies in prod;
    // vouch llm pins in goal.textForce if the restarts cost.
    if (goal.MENU[ctx.step] && !stillFeasible(bot, ctx, s.step)) return next()
    c.seen = false
    c.gen = stepGen(ctx)
    ctx.taskPlanStep = s.step
    return
  }
  if (ctx.taskPlanStep !== s.step) {
    if (++c.miss >= MISS_TICKS) return end(bot, ctx, o, 'failed:not possible now')
    ctx.taskPlanStep = s.step
  }
}

// Status line: the active plan step and its done-when text.
function statusLine(ctx) {
  const o = ctx && ctx.llmOrder
  if (!o) return ctx && ctx.llmAsk ? `plan: asking about "${ctx.llmAsk.text}"` : null
  const s = o.steps[o.i]
  if (!s) return null
  return `plan ${o.i + 1}/${o.steps.length}: ${label(s)}${s.done ? ` (done when ${s.done})` : ''} — for "${o.text}"`
}

module.exports = { enabled, ask, cancel, feeding, tick, statusLine, validatePlan, stepList, workSteps, planOrder, ORDER_STEPS, WORK_STEPS, STEP_MS }
