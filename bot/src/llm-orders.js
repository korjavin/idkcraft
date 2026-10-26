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
// a raw #mine would bypass them. Loaded step skills (vf8e.17) join
// workSteps() once they sit in MENU; `do <step>` installs without a call.

const brain = require('./brain')
const goal = require('./goal')
const siteMod = require('./site')
const { NEED_LOGS } = require('./budget')
const { situationText } = require('./situation')
const metrics = require('./metrics')
const { STEP_EFFECT_TEXT } = require('./plan-consts')
const { isFinished, failReason, stepGen, chatStep } = require('./step')
const { WANT_MAX } = require('./behaviours/bringbase')
const worker = require('./worker')

const ORDER_TIMEOUT_MS = 20000
const STEP_MS = 10 * 60 * 1000 // one plan step's deadline
const PLAN_MAX = 6
const MISS_TICKS = 3 // pin consumed without the step starting
// m06g: a pinned work step that never starts chats WHY it can't instead
// of a generic 'not possible now' (prod: 'reforest 10' with no trees near
// failed 3x in 3-4 s while the real cause sat in the logs as
// failed:no-trees). Best-effort: any surprise keeps the generic line.
function missWhy(bot, ctx, o, s) {
  try {
    if (!s || ORDER_STEPS[s.step] || typeof goal.stepWhy !== 'function') return null
    const facts = goal.goalFacts(bot, ctx)
    const line = goal.stepWhy(s.step, facts, bot, ctx, o && o.text)
    if (typeof line !== 'string' || !line.includes(':')) return null
    const cut = line.replace(new RegExp('^' + s.step + ':\\s*'), '').slice(0, 120)
    if (!cut || cut === line || /not feasible$/.test(cut)) return null
    return 'failed:' + cut
  } catch (_) {
    return null
  }
}

// LLM activity chooser (idkcraft-qxql.10): at a nothing-useful FSM pick the
// bot asks the model for 1-3 steps of useful work over the work whitelist.
// On whenever ANTHROPIC_API_KEY is set; LLM_CHOOSE=0 turns it off (the
// PLANNER default in brain.js:381). Rate-limited, never per tick; shares the
// llmCall token budget. Flat stays out (owner default); player-directed
// orders (bring/find/share) need a player.
const CHOOSE_MIN_MS_DEFAULT = 300000 // 5-min pause
const CHOOSE_WAIT_MAX_MS = 30 * 60 * 1000
const CHOOSE_MAX_STEPS = 3
const HOUSE_CHAIN = ['craft', 'equip', 'build', 'beds', 'light', 'gather', 'stockpile']

const ORDER_STEPS = {
  // codex: max = the executor's own clamp (bring WANT_MAX, flat FLAT_MAX_RADIUS) so a
  // bigger count refuses instead of silently delivering less and reporting done.
  bring: { args: 'item, count', max: WANT_MAX, what: `gets an item to the player (count at most ${WANT_MAX}): from the pack, the home chest, by crafting or smelting it, mining the block, shearing sheep or hunting for food`, chat: (s) => `bring me ${s.item}${s.count ? ` ${s.count}` : ''}` },
  find: { args: 'item', what: 'finds the nearest block of that name and leads the player to it', chat: (s) => `find me ${s.item}` },
  flat: { args: 'count', max: 64, what: 'levels the ground around the player, count = radius', chat: (s) => `flat ${s.count || 8}` },
  share: { args: '', what: 'hands the player everything carried except tools, weapons and armour', chat: () => 'share' },
}
// Work steps the plan may pin: not the night/safety steps (the FSM owns
// them), not deliver/rest/castle internals. Loaded step skills join below
// (skillSteps): they sit in goal.MENU and are registered like hand steps.
const WORK_STEPS = ['craft', 'equip', 'build', 'beds', 'light', 'gather', 'stockpile', 'bank', 'gear', 'forage', 'reforest', 'explore']

const SYSTEM = 'You turn a Minecraft player\'s chat line into a plan for their companion bot. ' +
  'Use only the listed step ids, in the order they must run. Item and block names are Minecraft registry ids (torch, water_bucket, iron_ore). ' +
  'Answer JSON only, no prose: {"plan":[{"step":"<id>","item":"<id>","count":<n>,"done":"<what is true when this step is done>"}]}. ' +
  'Leave out item/count when the step takes none. At most ' + PLAN_MAX + ' steps; use the fewest — an order step gathers, mines, crafts and smelts for itself, so never put forage or gather before it. ' +
  'A build step starts with no batch on hand when the pack holds almost no planks, so plan gather, craft and equip before build then. ' +
  'Answer {"plan":[]} when the line is not an order to the bot or no listed step can do it.'

function enabled(env = process.env) {
  return /^(1|true|yes)$/i.test(String(env.BOT_LLM_ORDERS || '')) && !!env.ANTHROPIC_API_KEY
}

// Chooser flag (qxql.10): on whenever the key is present, LLM_CHOOSE=0 off.
function chooseEnabled(env = process.env) {
  return !!env.ANTHROPIC_API_KEY && String(env.LLM_CHOOSE || '') !== '0'
}

function chooseMinMs(env = process.env) {
  const n = Number(env.LLM_CHOOSE_MIN_MS)
  return Number.isFinite(n) && n >= 0 ? n : CHOOSE_MIN_MS_DEFAULT
}

const CHOOSE_SYSTEM = 'You pick useful work for a Minecraft companion bot for the next ~10 minutes. ' +
  'Use only the listed step ids, in the order they must run. ' +
  'Answer JSON only, no prose: {"plan":[{"step":"<id>","count":<n>,"done":"<what is true when this step is done>"}],"why":"<one-line reason>","need":"<capability the bot lacks>"}. ' +
  'Leave out count when the step takes none. At most ' + CHOOSE_MAX_STEPS + ' steps; use the fewest. ' +
  'Prefer what the castle is missing when a castle order exists. ' +
  'Do not strip the area bare — gather only what a named need consumes. ' +
  'Answer {"plan":[],"need":"<capability the bot lacks>"} when no listed step helps.'

// Loaded step skills that sit in goal.MENU and are registered (vf8e.17):
// skills.js reports its last load; the ticker loads at startup when
// BOT_SKILLS is on, so this is a cache read in prod, never a load. Flag
// off (or not loaded yet): no skill joins, the lists stay byte-identical.
function skillSteps() {
  let skills = null
  try { skills = require('./skills') } catch (_) { return [] }
  try { if (!skills.enabled(process.env)) return [] } catch (_) { return [] }
  let names = null
  try { names = skills.stepSkills() } catch (_) { return [] }
  if (!Array.isArray(names)) return []
  return names.filter((n) => goal.MENU[n] && goal.registered(n))
}

function workSteps() {
  const base = WORK_STEPS.filter((n) => goal.MENU[n] && goal.registered(n))
  for (const n of skillSteps()) if (!base.includes(n)) base.push(n)
  return base
}

function stepList() {
  const lines = Object.entries(ORDER_STEPS).map(([id, s]) => `${id}(${s.args}): ${s.what}`)
  for (const id of workSteps()) {
    // A skill has no STEP_EFFECT_TEXT: fall back to its header description
    // (goal.STEP_CRITERIA), so the model still sees what it does.
    const effect = STEP_EFFECT_TEXT[id] || goal.STEP_CRITERIA[id] || id
    const when = goal.STEP_CRITERIA[id] ? ` (runs when: ${goal.STEP_CRITERIA[id].split(':')[0]})` : ''
    lines.push(`${id}: ${effect}${when}`)
  }
  return lines.join('\n')
}

// Chooser whitelist: work steps only (flat stays out per owner default;
// bring/find/share need a player). Same line shape as stepList.
function chooseStepList() {
  const lines = []
  for (const id of workSteps()) {
    const effect = STEP_EFFECT_TEXT[id] || goal.STEP_CRITERIA[id] || id
    const when = goal.STEP_CRITERIA[id] ? ` (runs when: ${goal.STEP_CRITERIA[id].split(':')[0]})` : ''
    lines.push(`${id}: ${effect}${when}`)
  }
  return lines.join('\n')
}

function cleanShort(v, max = 80) {
  return typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : ''
}

// situationText (situation.js) replaced stateText+inventoryText (qxql.9):
// the model sees castle progress, chests, holds and the owner ring.

// Prototype-safe whitelist read (vf8e.17 verifier): chat and model ids
// match [a-z0-9_]+, so `do constructor` / {"step":"__proto__"} hit inherited
// Object members on a plain ORDER_STEPS[id] lookup — and `.args` of that
// throws inside the chat handler, which has no try/catch. Only own entries
// count (the skills.js Object.hasOwn(OPS, op) precedent).
function orderStep(id) {
  return Object.hasOwn(ORDER_STEPS, id) ? ORDER_STEPS[id] : null
}

// Model answer -> { steps, why, need } | { error, why, need } | { empty, why, need }.
// The whitelist is the safety: an id outside it refuses the whole plan.
// opts: { maxSteps (default PLAN_MAX), allowOrders (default true — the
// chooser passes false so bring/find/flat/share never validate) }.
function validatePlan(ans, works = workSteps(), opts = {}) {
  const why = cleanShort(ans && ans.why, 80)
  const need = cleanShort(ans && ans.need, 80)
  const maxSteps = opts && typeof opts.maxSteps === 'number' ? opts.maxSteps : PLAN_MAX
  const allowOrders = !opts || opts.allowOrders !== false
  const raw = ans && Array.isArray(ans.plan) ? ans.plan : null
  if (!raw) return { error: 'no plan', why, need }
  if (raw.length === 0) return { empty: true, why, need }
  if (raw.length > maxSteps) return { error: `plan too long (${raw.length})`, why, need }
  const steps = []
  for (const r of raw) {
    const id = r && typeof r.step === 'string' ? r.step.toLowerCase().trim() : ''
    const knownOrder = orderStep(id)
    if (knownOrder && !allowOrders) return { error: `no step "${id.slice(0, 20)}"`, why, need }
    if (!knownOrder && !works.includes(id)) return { error: `no step "${id.slice(0, 20)}"`, why, need }
    const s = { step: id, done: typeof r.done === 'string' ? r.done.replace(/\s+/g, ' ').trim().slice(0, 80) : '' }
    if (knownOrder && knownOrder.args.includes('item')) {
      const item = String(r.item || '').toLowerCase().trim().replace(/\s+/g, '_')
      if (!/^[a-z0-9_]{1,40}$/.test(item)) return { error: `${id} needs an item`, why, need }
      s.item = item
    }
    if (knownOrder && knownOrder.args.includes('count') && r.count != null) {
      const c = Math.floor(Number(r.count))
      if (!(c >= 1 && c <= knownOrder.max)) return { error: `${id} count ${String(r.count).slice(0, 8)}`, why, need }
      s.count = c
    }
    // A work step keeps a 1..64 count when the model gives one (vf8e.17):
    // hand steps ignore it at execution, skill steps read st.count.
    if (!knownOrder && r.count != null) {
      const c = Math.floor(Number(r.count))
      if (!(c >= 1 && c <= 64)) return { error: `${id} count ${String(r.count).slice(0, 8)}`, why, need }
      s.count = c
    }
    steps.push(s)
  }
  return { steps, why, need }
}

function label(s) {
  return [s.step, s.item, s.count].filter((x) => x != null && x !== '').join(' ')
}

// One Messages-API call -> { steps|error|empty, tokens }.
async function planOrder(bot, ctx, text, fetchFn) {
  const user = `Order from the player: "${text}"\n\nSituation:\n${situationText(bot, ctx)}\n\nSteps (id(args): what it does):\n${stepList()}`
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

// One chooser call -> { steps|error|empty, why, need, tokens }.
async function planChoose(bot, ctx, regime, fetchFn) {
  const user = `Choose work: ${regime}\n\nSituation:\n${situationText(bot, ctx)}\n\nSteps (id: what it does):\n${chooseStepList()}`
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(new DOMException('order timeout', 'TimeoutError')), ORDER_TIMEOUT_MS)
  let data
  try {
    data = await brain.llmCall({
      use: 'choose',
      apiKey: process.env.ANTHROPIC_API_KEY,
      signal: ac.signal,
      fetchFn,
      body: {
        model: process.env.LLM_MODEL || brain.LLM_MODEL,
        max_tokens: 500,
        thinking: { type: 'disabled' },
        system: CHOOSE_SYSTEM,
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
  return { ...validatePlan(ans, workSteps(), { maxSteps: CHOOSE_MAX_STEPS, allowOrders: false }), tokens }
}

// Castle order active for the chooser regime: a castle site exists and the
// menu word is not none/done. Best-effort, never throws.
function castleActive(ctx, facts) {
  try {
    if (!ctx || !ctx.castle || !ctx.castle.site) return false
    const w = facts && facts.castle
    if (w === 'none' || w === 'done') return false
    return true
  } catch (_) { return false }
}

// Roster player online (not a peer bot): the chooser chats plan: only then,
// else log only. Mirrors task.ownerOnline without requiring task (cycle).
function rosterOnline(bot) {
  try {
    const e = process.env
    const bots = [e.BOT_USERNAME, e.BOT2_USERNAME, e.BOT_PEER_USERNAME].filter(Boolean)
    return Object.keys(worker.players(bot) || {}).some((n) => !bots.includes(n))
  } catch (_) { return false }
}

// Trigger predicate (qxql.10): the FSM's pick is nothing-useful, the bot is
// in work mode with no plan running or asking, and the rate limit allows it.
// Pure except for the flag/env read; never throws.
function shouldChoose(pick, ctx, facts, now = Date.now()) {
  try {
    if (!chooseEnabled()) return false
    if (!ctx || !ctx.work || ctx.paused) return false
    if (ctx.llmOrder || ctx.llmAsk) return false
    if (typeof pick !== 'string' || !pick) return false
    const t = now == null ? Date.now() : now
    const min = chooseMinMs()
    const wait = (ctx && typeof ctx.llmChooseWait === 'number' && ctx.llmChooseWait >= 0) ? ctx.llmChooseWait : min
    const at = (ctx && typeof ctx.llmChooseAt === 'number') ? ctx.llmChooseAt : 0
    if (!(t - at >= wait)) return false
    const time = (facts && facts.time) || 'day'
    if (pick === 'idle' || pick === 'explore') return true
    if ((pick === 'stay' || pick === 'rest') && time === 'day') return true
    if (HOUSE_CHAIN.includes(pick) && castleActive(ctx, facts)) return true
    return false
  } catch (_) { return false }
}

// Chat entry: ask for a plan, never blocking the chat handler. One ask in
// flight (ctx.llmAsk); a running plan (ctx.llmOrder) is replaced only by a
// valid new plan — chatter answered {"plan":[]} leaves it alone.
// req = { text, by, ticker, feed(line), fallback } — fallback is the FSM's
// own refusal, chatted when no plan comes back.
// Chooser: req.choose = { regime, trigger }; text = `choose work: ${regime}`,
// by is forced to 'self', the plan: line chats only with a roster player
// online (else log only), and every call logs an `llm choose` line.
function ask(bot, ctx, req, fetchFn) {
  if (!ctx || ctx.llmAsk) return false
  const isChoose = !!(req && req.choose)
  const a = { text: String(req.text).slice(0, 200), at: Date.now() }
  ctx.llmAsk = a
  if (isChoose) {
    const min = chooseMinMs()
    if (typeof ctx.llmChooseWait !== 'number' || ctx.llmChooseWait < 0) ctx.llmChooseWait = min
    ctx.llmChooseAt = a.at
  }
  const say = (line) => { try { bot.chat(line) } catch (_) { /* chat best-effort */ } }
  return (async () => {
    if (isChoose) {
      const regime = (req.choose && req.choose.regime) || 'no-order'
      const trigger = (req.choose && req.choose.trigger) || '?'
      let r
      try {
        r = await planChoose(bot, ctx, regime, fetchFn)
      } catch (err) {
        const msg = String(err && err.message ? err.message : err)
        r = { error: err && err.name === 'TimeoutError' ? 'timeout' : msg.startsWith('llm budget') ? 'budget' : msg.slice(0, 40), outcome: msg.startsWith('llm budget') ? 'budget' : 'error', why: '', need: '' }
      }
      if (ctx.llmAsk !== a) return // cancelled mid-ask (stop / follow me / go work)
      ctx.llmAsk = null
      const ms = Date.now() - a.at
      const outcome = r.steps ? 'ok' : r.empty ? 'empty' : (r.outcome || 'invalid')
      try { metrics.llmCalls.inc({ use: 'choose', outcome }) } catch (_) { /* metric best-effort */ }
      const plan = r.steps ? r.steps.map(label).join('>') : '-'
      console.log(`llm choose regime=${regime} trigger=${trigger} outcome=${outcome} plan=${plan} need="${r.need || ''}" why="${r.why || ''}" tokens=${r.tokens || '0/0'} ms=${ms}`)
      if (!r.steps) return // fallback: the FSM pick stands, log only
      const sayChoose = rosterOnline(bot) ? say : () => {}
      installPlan(bot, ctx, { text: a.text, by: 'self', ticker: req.ticker || null, feed: null }, r.steps, sayChoose)
      return
    }
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
    installPlan(bot, ctx, { text: a.text, by: req.by, ticker: req.ticker, feed: req.feed }, r.steps, say)
  })()
}

// qf05: the model answers an empty-kit `build here` with single-step
// `build`; the pin never starts (MENU.build needs a plank batch on hand)
// and the plan fails `not possible now` (prod 2026-10-24: 3x after a
// confident flat, the bot died twice). Expand a trailing build with no
// kit step before it to the gather>craft>equip>build shape the good
// plans already use. Pack read only (best-effort, never throws): a chest
// batch still starts build when the pack holds one, so a full pack is
// untouched; unregistered kit steps never enter (works filter).
const KIT_STEPS = ['gather', 'craft', 'equip']
const BUILD_BATCH = 16 // MENU.build (re)starts on a batch of up to 16 planks
// Pack counts with the goalFacts rules (goal.js: *_log, *_planks,
// *_pickaxe, *_sword). Null when unreadable: no rewrite then.
function packCounts(bot) {
  try {
    const n = { planks: 0, logs: 0, pickaxe: 0, sword: 0 }
    for (const i of bot.inventory.items()) {
      if (!i || typeof i.name !== 'string') continue
      const c = i.count | 0
      if (i.name.endsWith('_planks')) n.planks += c
      else if (i.name.endsWith('_log')) n.logs += c
      else if (i.name.endsWith('_pickaxe')) n.pickaxe += c
      else if (i.name.endsWith('_sword')) n.sword += c
    }
    return n
  } catch (_) {
    return null
  }
}
function packPlanks(bot) {
  try {
    const n = packCounts(bot)
    return n ? n.planks : null
  } catch (_) {
    return null
  }
}
function expandBuildPlan(bot, steps, works) {
  try {
    if (!Array.isArray(steps) || !steps.length) return steps
    const last = steps[steps.length - 1]
    if (!last || last.step !== 'build') return steps
    if (steps.slice(0, -1).some((s) => s && KIT_STEPS.includes(s.step))) return steps
    const pack = packCounts(bot)
    if (!pack || !(pack.planks < BUILD_BATCH)) return steps
    const have = Array.isArray(works) ? works : workSteps()
    // Only the kit steps the pack actually lacks (r1): a geared bot with
    // logs on hand needs craft alone — an unconditional `equip` re-created
    // the same not-possible-now (build feasible, the equip pin never
    // starts, 3 rejected pins). Craft always joins: the expansion only
    // fires below a batch, so logs still want converting.
    const want = []
    if (pack.logs < NEED_LOGS) want.push('gather')
    want.push('craft')
    if (!(pack.pickaxe > 0 && pack.sword > 0)) want.push('equip')
    const chain = want.filter((n) => have.includes(n)).map((step) => ({ step, done: '' }))
    if (!chain.length) return steps
    console.log(`llm order build expand pack=log${pack.logs}/plank${pack.planks} plan=${steps.map(label).join('>')}`)
    return [...steps.slice(0, -1), ...chain, { ...last }]
  } catch (_) {
    return steps
  }
}

// qf05: an addressed `build here` (`bot2 build here`, no colon) reaches
// the model as chatter, so the plan's `build` step works the OLD home
// while the flat anchor — and the speaker — stand elsewhere; the
// goal-fsm then gohomes to that old built home (prod: 20-80 blocks
// off-site) and the anchor is lost. Site the order like the direct
// `build here` handler (chat.js: anchor first, speaker fallback, same
// range gate) before the plan installs: a fresh unbuilt site also makes
// gohome infeasible, so the bot stays at the anchor till build starts.
// Best-effort, never throws; null = kept the old home.
const BUILD_HERE_RE = /build here/i
const BUILD_HERE_RANGE = 64 // chat.js BUILD_HERE_RANGE: past it the speaker is last-known, not live
function siteBuildHere(bot, ctx, req, steps) {
  try {
    if (!req || typeof req.text !== 'string' || !BUILD_HERE_RE.test(req.text)) return null
    // r1: the text match alone false-positives (`don't build here; bring
    // me a torch` with a bring-only plan re-sited the real home) — only a
    // plan that actually builds may move the site.
    if (!Array.isArray(steps) || !steps.some((s) => s && s.step === 'build')) return null
    const ticker = req.ticker
    if (!ticker || typeof ticker.setHome !== 'function') return null
    let speaker = null
    try {
      const e = (worker.players(bot) || {})[req.by]
      if (e && e.entity && e.entity.position && typeof e.entity.position.x === 'number') speaker = e.entity.position
    } catch (_) { speaker = null }
    let bp = null
    try {
      const p = bot && bot.entity && bot.entity.position
      if (p && typeof p.x === 'number') bp = p
    } catch (_) { bp = null }
    const around = speaker || bp
    if (!around) return null
    // Same far-speaker veto as the direct handler (chat.js): stale
    // coordinates must not yank the site across the map.
    if (speaker && bp && typeof speaker.y === 'number' && typeof bp.y === 'number' &&
      Math.hypot(bp.x - speaker.x, bp.y - speaker.y, bp.z - speaker.z) > BUILD_HERE_RANGE) return null
    const anchor = siteMod.flatAnchorEnd(ctx && ctx.flatEnd, !!(ctx && ctx.flat), around, Date.now())
    const site = (anchor && goal.siteFor(bot, anchor)) || goal.siteFor(bot, around)
    if (!site) return null
    ticker.setHome(site, { fresh: true })
    const st = (site && site.site) || {}
    console.log(`llm order build-here site=${st.x},${st.y},${st.z} anchor=${anchor ? 'flat' : 'speaker'}`)
    return site
  } catch (_) {
    return null
  }
}

// Install validated plan steps as the running order (vf8e.17): ask()'s
// tail and the deterministic `do` verb share it. Replaces any running
// plan and chats the plan line. No model call, no token or metric touch.
// Steps must already be whitelisted (validatePlan/doPlan): the executive
// below (startStep/tick/release) reads ORDER_STEPS by id without re-check.
// qf05: a build-here order sites the home first, and an empty-kit build
// plan expands gather-first — both best-effort, the installed line chats
// what actually runs.
function installPlan(bot, ctx, req, steps, say) {
  if (!ctx || !Array.isArray(steps) || !steps.length) return false
  if (ctx.llmOrder) { release(ctx, ctx.llmOrder); console.log(`llm order end text="${ctx.llmOrder.text}" result=replaced`) }
  siteBuildHere(bot, ctx, req, steps)
  steps = expandBuildPlan(bot, steps, workSteps())
  ctx.llmOrder = { text: String(req.text).slice(0, 200), by: req.by, ticker: req.ticker, feed: req.feed, steps, i: 0, cur: null, at: Date.now(), feeding: false }
  const line = `plan: ${steps.map(label).join(', then ')}`.slice(0, 250)
  if (typeof say === 'function') say(line)
  else { try { bot.chat(line) } catch (_) { /* chat best-effort */ } }
  return true
}

// Pin-args mirror (vf8e.17): ctx.taskPlanArgs tracks the ctx.taskPlanStep
// pin — written and withdrawn at the same executive sites — except it
// survives pinMenu's consume, so goalFacts keeps `pinned` (and the skill
// wrapper its st.count/st.by) while the executive owns the step. It carries
// the step id too: the pin alone cannot say who owns a consumed pin, and
// goal.js must not require this module back (dependency cycle).
function pinArgs(ctx, o, s) {
  if (!ctx) return
  ctx.taskPlanArgs = { step: s.step, count: s.count, by: o.by }
}
function dropArgs(ctx) {
  if (!ctx) return
  ctx.taskPlanArgs = null
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
  dropArgs(ctx) // a pin the arbiter never consumed must not leak args into a later run
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
  dropArgs(ctx) // a replaced or timed-out plan drops its args with its executors
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
  else dropArgs(ctx) // release() already nulled the rest
  // Chooser backoff (qxql.10): a failed plan doubles the wait up to 30 min,
  // done resets it to the floor. Other endings keep the current wait.
  try {
    if (o && typeof o.text === 'string' && o.text.startsWith('choose work:') && ctx) {
      const min = chooseMinMs()
      const cur = typeof ctx.llmChooseWait === 'number' && ctx.llmChooseWait >= 0 ? ctx.llmChooseWait : min
      if (typeof result === 'string' && result.startsWith('failed:')) ctx.llmChooseWait = Math.min(cur * 2, CHOOSE_WAIT_MAX_MS)
      else if (result === 'done') ctx.llmChooseWait = min
      else ctx.llmChooseWait = cur
    }
  } catch (_) { /* backoff best-effort */ }
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
  pinArgs(ctx, o, s) // rewritten on every work step, so a later step never reads an earlier step's args
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
  const next = () => { o.i++; o.cur = null; dropArgs(ctx) }
  // 5v4f-general: a work-step count N runs the step N times (owner prod:
  // "reforest 10" did one cycle and stopped; "counter should work for
  // almost any command"). Order steps (bring/find/flat) own their count
  // (items, radius) and never repeat here; failures never repeat — the
  // honest stop stands. Best-effort: any surprise falls through to next().
  const doneStep = () => {
    try {
      const left = Math.floor(Number(s && s.count))
      if (left >= 2 && s && !ORDER_STEPS[s.step]) {
        s.count = left - 1
        pinArgs(ctx, o, s) // re-pin carries the decremented count
        // Codex P1: tracking starts WITH the re-pin, not next tick —
        // otherwise goal.decide() can run the repeat invisibly and the
        // next startStep snapshots a finished generation (extra runs,
        // swallowed failures).
        o.cur = { at: now, gen: stepGen(ctx), seen: false, status: null, miss: 0, led: false }
        try { console.log(`llm order step again ${s.step} left=${s.count}`) } catch (_) { /* log best-effort */ }
        return
      }
    } catch (_) { /* fall through to next */ }
    next()
  }
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
    if (isFinished(c.status)) return c.status === 'done' ? doneStep() : end(bot, ctx, o, c.status)
    return
  }
  // Left the step and it had finished between two reads.
  if (c.seen && isFinished(c.status)) return c.status === 'done' ? doneStep() : end(bot, ctx, o, c.status)
  if (nightHold(bot, ctx)) {
    // Held: no pin (a pending one is withdrawn so the night step wins), no
    // miss, no deadline; the step re-pins when the night ends.
    if (ctx.taskPlanStep === s.step) ctx.taskPlanStep = null
    dropArgs(ctx) // withdrawn with the pin: the night step owns the body now
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
    pinArgs(ctx, o, s) // re-pinned after the night hold
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
    pinArgs(ctx, o, s) // the flicker re-pin carries the args too
    return
  }
  if (ctx.taskPlanStep !== s.step) {
    if (++c.miss >= MISS_TICKS) return end(bot, ctx, o, missWhy(bot, ctx, o, s) || 'failed:not possible now')
    ctx.taskPlanStep = s.step
    pinArgs(ctx, o, s)
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

module.exports = { enabled, ask, cancel, feeding, tick, statusLine, validatePlan, stepList, workSteps, skillSteps, installPlan, orderStep, planOrder, ORDER_STEPS, WORK_STEPS, STEP_MS, chooseEnabled, chooseMinMs, planChoose, chooseStepList, shouldChoose, castleActive, rosterOnline, CHOOSE_MAX_STEPS, CHOOSE_MIN_MS_DEFAULT, CHOOSE_WAIT_MAX_MS, HOUSE_CHAIN, expandBuildPlan, siteBuildHere, packPlanks, packCounts, KIT_STEPS, BUILD_BATCH }
