'use strict'

// Goal arbiter for epic rw4 (bot builds itself a house): goal facts, the
// step menu with per-step feasibility, a reference FSM, and the decision
// point. A goal step IS a BEHAVIOURS action, so applyDecision, the decision
// line and the decisions metric work unchanged. Later beads register their
// behaviour under the step key in BEHAVIOURS — goal.js does not change for
// that; a step runs only while registered (see registered()).
//
// Step lifecycle: decide() picks a step and marks it running; the behaviour
// reports completion via ctx.stepStatus = 'done' | 'failed:<reason>'.
// Model choice (bead .6) asks at the same decision points with the FSM as
// fallback and disagreement reference, exactly like hybridBrain.

const { countItems } = require('./perception')
const metrics = require('./metrics')

// House budget (epic rw4): 22 wall planks + 16 roof + door (6) + table (4);
// gather 14 logs (12 worth + spare).
const NEED_LOGS = 14
const NEED_PLANKS = 48

// Step menu: feasible(facts) means the step can make progress NOW (not just
// ever). Registration (BEHAVIOURS[name]) is checked separately in decide().
// chat() is the one line the bot says on taking the step (owner rule: the
// bot always announces what it does).
const MENU = {
  stay: {
    feasible: (facts) => facts.time === 'night' && facts.home === 'built' && facts.inside === 'yes',
    chat: () => 'on my own: staying inside till morning',
    verb: 'staying inside',
  },
  gohome: {
    feasible: (facts) => (facts.time === 'dusk' || facts.time === 'night') && facts.home !== 'none' && facts.inside === 'no',
    chat: () => 'on my own: heading home',
    verb: 'heading home',
  },
  craft: {
    // Batch gate: a full NEED_LOGS load crafts at once. Starting on the first
    // picked-up log would preempt gather with a chat line per log.
    // The door needs a placed table (bot.craft requires the block): without
    // one the step could neither progress nor finish, churning done forever.
    feasible: (facts) => facts.logs >= NEED_LOGS || (facts.maxPlanks >= 4 && facts.table === 0 && !facts.tablePlaced) || (facts.maxPlanks >= 6 && facts.door === 0 && facts.tablePlaced),
    chat: () => 'on my own: crafting planks and tools',
    verb: 'crafting',
  },
  build: {
    feasible: (facts) => facts.planks >= NEED_PLANKS && facts.table > 0 && facts.door > 0 && facts.home === 'site',
    chat: () => 'on my own: building the house',
    verb: 'building the house',
  },
  gather: {
    // Only while material is still missing: plank-equivalent on hand vs the
    // house budget (table 4 + door 6 + NEED_PLANKS planks), and never once
    // the house is built — otherwise the bot farms forever and rest is
    // unreachable after the job is done. A started load is always finished
    // (logs < NEED_LOGS): stopping mid-load strands sub-batch logs that the
    // batch craft gate can never take — rest forever with work remaining.
    feasible: (facts) => {
      if (facts.home === 'built') return false
      const total = facts.planks + facts.logs * 4
      const need = NEED_PLANKS + (facts.table > 0 ? 0 : 4) + (facts.door > 0 ? 0 : 6)
      return total < need || (facts.logs > 0 && facts.logs < NEED_LOGS)
    },
    chat: () => 'on my own: gathering logs',
    verb: 'chopping wood',
  },
  rest: {
    feasible: () => true,
    chat: (facts) => (facts.home === 'none' ? 'on my own: resting near spawn' : 'on my own: resting at the home site'),
    verb: 'resting',
  },
}

// Priority order (epic rw4): night steps first, then craft, build, gather,
// rest last. goalFsm is pure priority over the feasible names it is given.
const STEP_ORDER = ['stay', 'gohome', 'craft', 'build', 'gather', 'rest']

function goalFacts(bot, ctx) {
  let timeOfDay = NaN
  try {
    timeOfDay = bot && bot.time && typeof bot.time.timeOfDay === 'number' ? bot.time.timeOfDay : NaN
  } catch (_) { /* unknown time reads as day below */ }
  const time = !(timeOfDay >= 0) ? 'day' : timeOfDay < 12000 ? 'day' : timeOfDay <= 13000 ? 'dusk' : 'night'
  const logs = countItems(bot, (n) => n.endsWith('_log'))
  const planks = countItems(bot, (n) => n.endsWith('_planks'))
  const table = countItems(bot, (n) => n === 'crafting_table')
  const door = countItems(bot, (n) => n.endsWith('_door'))
  // Top single-wood plank count: recipes cannot mix wood types (see above).
  let maxPlanks = 0
  try {
    const items = bot && bot.inventory && typeof bot.inventory.items === 'function' ? bot.inventory.items() : []
    const perWood = {}
    if (Array.isArray(items)) {
      for (const i of items) {
        if (!i || typeof i.name !== 'string' || !i.name.endsWith('_planks')) continue
        perWood[i.name] = (perWood[i.name] || 0) + (typeof i.count === 'number' ? i.count : 1)
      }
      for (const n of Object.values(perWood)) {
        if (n > maxPlanks) maxPlanks = n
      }
    }
  } catch (_) { /* inventory not ready: 0 */ }
  const home = !ctx || !ctx.home ? 'none' : ctx.home.built ? 'built' : 'site'
  // ctx.home.interior contract (set by bead .4): { min: {x,y,z}, max: {x,y,z} }.
  let inside = 'no'
  try {
    const bp = bot && bot.entity && bot.entity.position
    const interior = ctx && ctx.home && ctx.home.interior
    if (bp && interior && interior.min && interior.max &&
      bp.x >= interior.min.x && bp.x <= interior.max.x &&
      bp.y >= interior.min.y && bp.y <= interior.max.y &&
      bp.z >= interior.min.z && bp.z <= interior.max.z) inside = 'yes'
  } catch (_) { /* not inside */ }
  const tablePlaced = !!(ctx && ctx.home && ctx.home.table)
  // Body state joins the facts so the model sees danger the FSM ignores.
  let health = 20
  try {
    const hp = bot && typeof bot.health === 'number' ? bot.health : NaN
    health = !(hp >= 0) ? 20 : hp
  } catch (_) { /* unknown health reads full, like the stub */ }
  let food = 20
  try {
    const fd = bot && typeof bot.food === 'number' ? bot.food : NaN
    food = !(fd >= 0) ? 20 : fd
  } catch (_) { /* unknown food reads full */ }
  return { time, logs, planks, maxPlanks, table, door, home, tablePlaced, inside, health, food }
}

// Bucket thresholds for the state text (single source; the criteria below
// match these words exactly).
function logBucket(n) {
  return n <= 0 ? 'none' : n < NEED_LOGS ? 'few' : 'enough'
}
function plankBucket(n) {
  return n <= 0 ? 'none' : n < NEED_PLANKS ? 'few' : 'enough'
}
// Canonical facts text: ALSO the model state (iwb lesson: the model matches
// whole-criterion similarity, so numbers go out, bucket words go in). The
// decision point fires when a bucket flips — none->few->enough — instead of
// on every picked-up log.
function goalText(facts) {
  const logs = logBucket(facts.logs)
  const planks = plankBucket(facts.planks)
  const table = facts.table > 0 ? 'yes' : 'no'
  const door = facts.door > 0 ? 'yes' : 'no'
  const health = facts.health < 6 ? 'low' : 'ok'
  const food = facts.food < 6 ? 'hungry' : 'ok'
  return `time=${facts.time} logs=${logs} planks=${planks} ` +
    `table=${table} door=${door} home=${facts.home} inside=${facts.inside} health=${health} food=${food}`
}

function goalFsm(facts, feasibleNames) {
  const ok = new Set(Array.isArray(feasibleNames) ? feasibleNames : [])
  const t = facts && facts.time
  for (const name of STEP_ORDER) {
    if (!ok.has(name)) continue
    if (name === 'stay' && t !== 'night') continue // stay is night-only; dusk goes home
    if (name === 'gohome' && t !== 'night' && t !== 'dusk') continue
    return name
  }
  return 'rest'
}

// One question for the smart model. Short clauses on the bucket words,
// exactly like the iwb combat criteria: every longer variant regressed on
// the stand. All six steps are named here so build/gohome/stay plug in with
// one BEHAVIOURS line each (rw4.4/4.5); unregistered steps never reach ask().
const ASK_INSTRUCTIONS = 'Pick the next step toward building and keeping a home'
const STEP_CRITERIA = {
  gather: 'logs is none or few and home is not built: chop trees',
  craft: 'logs is enough or planks are few or door is no: craft planks, table and door',
  build: 'planks are enough and home is site: place the house blocks',
  gohome: 'time is dusk or night and home is built and inside is no: go inside',
  stay: 'inside is yes and time is night: wait inside',
  rest: 'nothing else fits: rest near home',
}

// Model step choice with the FSM as fallback and disagreement reference,
// exactly like hybridBrain: { step, source, fsm, model }. source is
// only-option (single feasible step, model not asked), goal-fsm (no ask
// method: stub brain or unit tests), <brain source> (model answered) or
// fsm-fallback (model consulted and failed). model is the consulted brain
// source or null when nothing was asked.
async function chooseStep(brain, facts, feasible) {
  const names = STEP_ORDER.filter((n) => feasible.includes(n))
  const text = goalText(facts)
  const fsm = goalFsm(facts, names)
  if (names.length <= 1) return { step: names[0] || 'rest', source: 'only-option', fsm, model: null }
  if (!brain || typeof brain.ask !== 'function') return { step: fsm, source: 'goal-fsm', fsm, model: null }
  const model = (brain.source || brain.name || 'model')
  const criteria = {}
  for (const n of names) criteria[n] = STEP_CRITERIA[n]
  const fail = (reason) => {
    metrics.escalation.inc({ from: model, to: 'fsm', reason })
    return { step: fsm, source: 'fsm-fallback', fsm, model }
  }
  try {
    const label = await brain.ask({ state: text, instructions: ASK_INSTRUCTIONS, criteria, situation: text })
    if (!names.includes(label)) return fail('invalid')
    if (label !== fsm) {
      metrics.goalDisagreements.inc({ model: label, fsm })
      console.error(`goal disagree source=${model} model=${label} fsm=${fsm} facts=${text}`)
    }
    return { step: label, source: model, fsm, model }
  } catch (err) {
    const msg = String((err && err.message) || err)
    const reason = (err && err.name === 'TimeoutError') ? 'timeout'
      : msg.startsWith('jev missing') ? 'invalid'
      : 'error'
    return fail(reason)
  }
}

// Registration gate: a step runs only while its behaviour is plugged into
// BEHAVIOURS (later beads join with one require line each). Deferred require:
// goal.js loads before index.js finishes, so the table is read at decide()
// time, never at load time.
function registered(name) {
  try {
    const table = require('./index').BEHAVIOURS
    return !!table && typeof table[name] === 'function'
  } catch (_) {
    return false
  }
}

// Decision point: re-decide when there is no step, the step finished
// (done/failed:*), or the facts changed. The model picks through chooseStep
// at those points only (same dedup as lastStateKey); the return shape stays
// { action, sprint, source: 'goal-fsm' } — the choice source (laya, only-
// option, fsm-fallback) rides the step log line, the next: chat and the
// goal_* metrics, never the decision source. Logs and chats only on a step
// CHANGE, so a running step with steady facts stays silent.
async function decide(bot, ctx) {
  const facts = goalFacts(bot, ctx)
  const text = goalText(facts)
  const prev = (ctx && ctx.step) || null
  const status = (ctx && ctx.stepStatus) || null
  const finished = status === 'done' || (typeof status === 'string' && status.startsWith('failed:'))
  if (!prev || finished || ctx.goalText !== text) {
    const askKey = `${text}\n${status || ''}`
    if (prev && ctx.askedKey === askKey) return { action: ctx.step, sprint: false, source: 'goal-fsm' }
    ctx.askedKey = askKey
    const names = Object.keys(MENU).filter((n) => {
      try {
        return MENU[n].feasible(facts) && registered(n)
      } catch (_) {
        return false
      }
    })
    const why = !prev ? 'start' : finished ? (status === 'done' ? 'step-done' : 'step-failed') : 'facts-changed'
    const t0 = Date.now()
    const choice = await chooseStep(ctx && ctx.brain, facts, names)
    const ms = Date.now() - t0
    ctx.step = choice.step
    ctx.stepStatus = 'running'
    ctx.goalText = text
    metrics.goalSteps.inc({ step: choice.step, source: choice.source })
    for (const n of Object.keys(MENU)) metrics.goalStep.set({ step: n }, n === choice.step ? 1 : 0)
    if (choice.model) metrics.goalChoiceDuration.observe({ source: choice.model }, ms / 1000)
    if (choice.step !== prev) {
      console.log(`goal step=${choice.step} prev=${prev || 'none'} source=${choice.source} fsm=${choice.fsm} why=${why} facts=${text}`)
      const entry = MENU[choice.step]
      const verb = (entry && entry.verb) || choice.step
      try { bot.chat(`next: ${verb} (${choice.source})`) } catch (_) { /* chat best-effort */ }
    }
  }
  return { action: ctx.step, sprint: false, source: 'goal-fsm' }
}

module.exports = { MENU, STEP_ORDER, NEED_LOGS, NEED_PLANKS, goalFacts, goalText, goalFsm, decide, chooseStep, STEP_CRITERIA, ASK_INSTRUCTIONS, logBucket, plankBucket }
