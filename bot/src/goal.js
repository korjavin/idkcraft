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
  },
  gohome: {
    feasible: (facts) => (facts.time === 'dusk' || facts.time === 'night') && facts.home !== 'none' && facts.inside === 'no',
    chat: () => 'on my own: heading home',
  },
  craft: {
    // Batch gate: a full NEED_LOGS load crafts at once. Starting on the first
    // picked-up log would preempt gather with a chat line per log.
    // The door needs a placed table (bot.craft requires the block): without
    // one the step could neither progress nor finish, churning done forever.
    feasible: (facts) => facts.logs >= NEED_LOGS || (facts.planks >= 4 && facts.table === 0) || (facts.planks >= 6 && facts.door === 0 && facts.tablePlaced),
    chat: () => 'on my own: crafting planks and tools',
  },
  build: {
    feasible: (facts) => facts.planks >= NEED_PLANKS && facts.table > 0 && facts.door > 0 && facts.home === 'site',
    chat: () => 'on my own: building the house',
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
  },
  rest: {
    feasible: () => true,
    chat: (facts) => (facts.home === 'none' ? 'on my own: resting near spawn' : 'on my own: resting at the home site'),
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
  return { time, logs, planks, table, door, home, inside }
}

// Canonical facts text: the decision point fires when it changes (same role
// as stateKey for the brain).
function goalText(facts) {
  return `time=${facts.time} logs=${facts.logs} planks=${facts.planks} ` +
    `table=${facts.table} door=${facts.door} home=${facts.home} inside=${facts.inside}`
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
// (done/failed:*), or the facts changed. Logs and chats only on a step
// CHANGE, so a running step with steady facts stays silent.
function decide(bot, ctx) {
  const facts = goalFacts(bot, ctx)
  const text = goalText(facts)
  const prev = (ctx && ctx.step) || null
  const status = (ctx && ctx.stepStatus) || null
  const finished = status === 'done' || (typeof status === 'string' && status.startsWith('failed:'))
  if (!prev || finished || ctx.goalText !== text) {
    const names = Object.keys(MENU).filter((n) => {
      try {
        return MENU[n].feasible(facts) && registered(n)
      } catch (_) {
        return false
      }
    })
    const pick = goalFsm(facts, names)
    ctx.step = pick
    ctx.stepStatus = 'running'
    ctx.goalText = text
    if (pick !== prev) {
      console.log(`goal step=${pick} prev=${prev || 'none'} source=goal-fsm facts=${text}`)
      const entry = MENU[pick]
      if (entry && typeof entry.chat === 'function') {
        try { bot.chat(entry.chat(facts)) } catch (_) { /* chat best-effort */ }
      }
    }
  }
  return { action: ctx.step, sprint: false, source: 'goal-fsm' }
}

module.exports = { MENU, STEP_ORDER, NEED_LOGS, NEED_PLANKS, goalFacts, goalText, goalFsm, decide }
