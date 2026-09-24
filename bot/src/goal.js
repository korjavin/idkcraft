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
const Vec3 = require('vec3')
const buildMod = require('./behaviours/build')
const forageMod = require('./behaviours/forage')
const deliverMod = require('./behaviours/deliver')
const BLUEPRINT = buildMod.BLUEPRINT
const PLANK_COUNT = buildMod.PLANK_COUNT
const metrics = require('./metrics')

// House budget (epic rw4): 22 wall planks + 16 roof + door (6) + table (4);
// gather 14 logs (12 worth + spare).
const NEED_LOGS = 14
const NEED_PLANKS = 48

// Step menu: feasible(facts, bot, ctx) means the step can make progress NOW
// (not just ever). Most steps read facts only; build also scans the home
// site through the bot. Registration (BEHAVIOURS[name]) is checked
// separately in decide().
// chat() is the one line the bot says on taking the step (owner rule: the
// bot always announces what it does).
const MENU = {
  stay: {
    // Dusk counts, not just night: a gohome that finishes at dusk must hand
    // off to stay, never to a rest that roams out of the closed house
    // (revmux 01-review loop+goal-3).
    feasible: (facts) => facts.time !== 'day' && facts.home === 'built' && facts.inside === 'yes',
    chat: () => 'on my own: staying inside till morning',
    verb: 'staying inside',
  },
  gohome: {
    feasible: (facts) => (facts.time === 'dusk' || facts.time === 'night') && facts.home === 'built' && facts.inside === 'no',
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
    // Batch gate (bead .4): build proceeds in batches — start (or resume)
    // with a batch of up to 16 planks on hand, then back to gather/craft.
    // A finished door/table needs its item, not loose planks, so a zero
    // plank remainder passes with any plank count. Skipped (given-up) cells
    // count as done, the same as in the build behaviour.
    feasible: (facts, bot, ctx) => {
      const home = ctx && ctx.home
      if (!home && !(bot && bot.spawnPoint)) return false
      // No scannable origin (no home yet, or a home without site): nothing
      // is verifiable, so the whole wall+roof count counts.
      if (!home || !home.site) return facts.planks >= Math.min(PLANK_COUNT, 16)
      let planks = 0
      let other = 0
      try {
        const skip = new Set(Array.isArray(ctx.buildSkip) ? ctx.buildSkip : [])
        for (let i = 0; i < BLUEPRINT.length; i++) {
          if (skip.has(i)) continue
          if (!buildMod.cellDone(bot, home, BLUEPRINT[i])) {
            if (BLUEPRINT[i].kind === 'planks') planks++
            else other++
          }
        }
      } catch (_) {
        return false
      }
      if (planks + other <= 0) return false
      // No livelock: a missing door/table item for an unfinished cell means
      // build cannot advance — yield so gather/craft (or a new site) run.
      // Skipped cells are given up and do not gate.
      try {
        const skip2 = new Set(Array.isArray(ctx.buildSkip) ? ctx.buildSkip : [])
        for (let i = 0; i < BLUEPRINT.length; i++) {
          if (skip2.has(i) || BLUEPRINT[i].kind === 'planks') continue
          if (!buildMod.cellDone(bot, home, BLUEPRINT[i])) {
            if (BLUEPRINT[i].kind === 'table' && !(facts.table > 0)) return false
            if (BLUEPRINT[i].kind === 'door' && !(facts.door > 0)) return false
          }
        }
      } catch (_) {
        return false
      }
      if (planks > 0) return facts.planks >= Math.min(planks, 16)
      return true
    },
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
    // atl.4: a still-holding gather failure is not feasible — the behaviour
    // replays the same final while the log count stands (decide's stepFail
    // is the menu-wide twin of this gate).
    feasible: (facts, bot, ctx) => {
      try {
        const g = ctx && ctx.gather
        if (g && typeof g.final === 'string' && g.final.startsWith('failed:') && g.atLogs === facts.logs) return false
      } catch (_) { /* fall through to facts */ }
      if (facts.home === 'built') return false
      const total = facts.planks + facts.logs * 4
      const need = NEED_PLANKS + (facts.table > 0 ? 0 : 4) + (facts.door > 0 ? 0 : 6)
      return total < need || (facts.logs > 0 && facts.logs < NEED_LOGS)
    },
    chat: () => 'on my own: gathering logs',
    verb: 'chopping wood',
  },
  deliver: {
    // Unload first: a waiting haul goes to the nearest online player
    // before the next forage leg. Nobody online (dxl) -> infeasible.
    feasible: (facts) => facts.haul === 'waiting' && facts.player !== 'none',
    chat: () => 'on my own: delivering the haul',
    verb: 'delivering',
  },
  forage: {
    // Known valuable find nearby (planForage: value rank, pickaxe gate).
    // Nothing known -> explore finds more.
    feasible: (facts) => facts.known === 'near',
    chat: () => 'on my own: foraging resources',
    verb: 'foraging',
  },
  explore: {
    // Blind search only once the house stands: pre-house gaps rest (rw4
    // owns the body until built), night pre-house never wanders.
    feasible: (facts) => facts.home === 'built',
    chat: () => 'on my own: exploring outward',
    verb: 'exploring',
  },
  rest: {
    feasible: () => true,
    chat: (facts) => (facts.home === 'none' ? 'on my own: resting near spawn' : 'on my own: resting at the home site'),
    verb: 'resting',
  },
}

// Priority order (epic rw4 + atl.2): night steps first, then craft, build,
// gather, then unload (deliver), dig (forage), search (explore), rest last.
// goalFsm is pure priority over the feasible names it is given.
const STEP_ORDER = ['stay', 'gohome', 'craft', 'build', 'gather', 'deliver', 'forage', 'explore', 'rest']
// Alone-explore cap (idkcraft-dxl): without players the bot must not wander
// past this many blocks from home — new chunks bloat the host disk. Read by
// atl.1 explore.js when it lands; until then no behaviour consumes it.
const AUTONOMOUS_EXPLORE_RADIUS = 256

// Home site shape (bead .4): site is the SW-corner origin at ground level,
// interior the 2x2x2 inside (4 cells), door the LOWER door cell, table the
// workbench cell outside the east wall — null until the workbench is really
// placed. rw4.3 treats ctx.home.table as a PLACED station (craft walks to it
// and crafts the door at it), so claiming the coords early would deadlock
// craft at an empty cell; build claims them the tick the table cell lands.
function makeHome(ox, oy, oz) {
  return {
    site: { x: ox, y: oy, z: oz },
    interior: { min: { x: ox + 1, y: oy, z: oz + 1 }, max: { x: ox + 2, y: oy + 1, z: oz + 2 } },
    door: { x: ox + 1, y: oy, z: oz },
    table: null,
    built: false,
  }
}

// Feet level of the ground column: first non-air block from topY down, plus
// one. Null when the column never resolves (unloaded chunk).
function groundY(bot, x, z, topY) {
  for (let y = topY; y > topY - 32; y--) {
    let b = null
    try {
      b = bot.blockAt(new Vec3(x, y, z))
    } catch (_) {
      return null
    }
    if (b && b.name && b.name !== 'air') return y + 1
  }
  return null
}

// 8 candidate origins around `around` at radius 6 (bead .4).
const SITE_DIRS = [[6, 0], [4, 4], [0, 6], [-4, 4], [-6, 0], [-4, -4], [0, -6], [4, -4]]

// Pick a flat 4x4 site: all 16 columns resolve and lie within one block.
// First fit wins; after 8 rejections the first candidate is taken as-is —
// ponytail: let the house hang or half-bury rather than block the epic.
function siteFor(bot, around) {
  if (!around || typeof around.x !== 'number' || typeof around.z !== 'number') return null
  const cx = Math.floor(around.x)
  const cz = Math.floor(around.z)
  const cy = typeof around.y === 'number' ? Math.floor(around.y) : 64
  for (const [dx, dz] of SITE_DIRS) {
    const ox = cx + dx
    const oz = cz + dz
    const ys = []
    let ok = true
    for (let ix = 0; ix < 4 && ok; ix++) {
      for (let iz = 0; iz < 4 && ok; iz++) {
        const gy = groundY(bot, ox + ix, oz + iz, cy + 8)
        if (gy == null) { ok = false; break }
        ys.push(gy)
      }
    }
    if (!ok || ys.length !== 16) continue
    const y0 = Math.min(...ys)
    if (ys.every((y) => y === y0 || y === y0 + 1)) return makeHome(ox, y0, oz)
  }
  const [fx, fz] = SITE_DIRS[0]
  const fy = groundY(bot, cx + fx, cz + fz, cy + 8)
  return makeHome(cx + fx, fy == null ? cy : fy, cz + fz)
}

// Adopt a house built by an earlier run: a door within 32 of spawn means
// home. Origin = door − (1,0,0); findBlocks may return the UPPER half, so
// step down when the block below is also a door. built is lax on purpose —
// presence (non-air) counts; exact repair is the build step's job.
function adoptHome(bot) {
  try {
    const spawn = bot && bot.spawnPoint
    if (!spawn || typeof spawn.x !== 'number') return null
    const found = bot.findBlocks({
      matching: (b) => !!b && typeof b.name === 'string' && b.name.endsWith('_door'),
      maxDistance: 32,
      count: 1,
    })
    if (!found || !found.length) return null
    let dx = Math.floor(found[0].x)
    let dy = Math.floor(found[0].y)
    let dz = Math.floor(found[0].z)
    try {
      const below = bot.blockAt(new Vec3(dx, dy - 1, dz))
      if (below && typeof below.name === 'string' && below.name.endsWith('_door')) dy--
    } catch (_) { /* keep as found */ }
    const home = makeHome(dx - 1, dy, dz)
    // Claim the table coords only when the workbench block is really there
    // (same placed-station contract as a fresh site).
    try {
      const t = BLUEPRINT[0]
      const tb = bot.blockAt(new Vec3(home.site.x + t.dx, home.site.y + t.dy, home.site.z + t.dz))
      if (tb && tb.name === 'crafting_table') {
        home.table = new Vec3(home.site.x + t.dx, home.site.y + t.dy, home.site.z + t.dz)
      }
    } catch (_) { /* unverifiable: leave unclaimed */ }
    let allPresent = true
    for (const cell of BLUEPRINT) {
      let name = null
      try {
        const b = bot.blockAt(new Vec3(home.site.x + cell.dx, home.site.y + cell.dy, home.site.z + cell.dz))
        name = b && b.name
      } catch (_) {
        name = null
      }
      if (!name || name === 'air') { allPresent = false; break }
    }
    home.built = allPresent
    try { bot.chat(`my home is at ${home.site.x} ${home.site.y} ${home.site.z}`) } catch (_) { /* chat best-effort */ }
    return home
  } catch (_) {
    return null
  }
}

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
  let known = 'none'
  try {
    if (forageMod.planForage(bot, ctx)) known = 'near'
  } catch (_) { /* no plan: explore owns that */ }
  let haul = 'none'
  try {
    if (deliverMod.haulTotal(bot, ctx) > 0) haul = 'waiting'
  } catch (_) { /* no haul */ }
  let player = 'none'
  try {
    player = deliverMod.playerStatus(bot).level
  } catch (_) { /* nobody online */ }
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
  return { time, logs, planks, maxPlanks, table, door, home, tablePlaced, inside, health, food, known, haul, player }
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
    `table=${table} door=${door} home=${facts.home} inside=${facts.inside} health=${health} food=${food} ` +
    `known=${facts.known} haul=${facts.haul} player=${facts.player}`
}

// atl.4 livelock guard: a recorded step failure holds while the facts text
// is unchanged and the body stays within REFAIL_DIST of the failure point.
// New facts or relocation release the step for a fresh try. Per-step map:
// alternating failures must not release each other.
const REFAIL_DIST = 32
// Steps whose failure advances their own situation never hold: explore
// consumes the failed point (the next pick is a new target by
// construction), gohome/stay retry from a fresh record through door
// phases (rw4.5 owns their trouble). Holding them would deadlock the
// spiral after one river and strand the night walk. The guard bars the
// steps that would otherwise replay the failure identically.
const SELF_ADVANCING = { explore: true, gohome: true, stay: true }
function failHolds(ctx, name, text, bot) {
  try {
    if (SELF_ADVANCING[name]) return false
    const sf = ctx && ctx.stepFail && ctx.stepFail[name]
    if (!sf || sf.text !== text) return false
    if (!sf.pos) return true
    const bp = bot && bot.entity && bot.entity.position
    if (!bp || typeof bp.x !== 'number') return true
    return Math.hypot(bp.x - sf.pos.x, bp.z - sf.pos.z) <= REFAIL_DIST
  } catch (_) {
    return false
  }
}

function goalFsm(facts, feasibleNames) {
  const ok = new Set(Array.isArray(feasibleNames) ? feasibleNames : [])
  const t = facts && facts.time
  for (const name of STEP_ORDER) {
    if (!ok.has(name)) continue
    if (name === 'stay' && t === 'day') continue // stay holds dusk and night; day goes to work
    if (name === 'gohome' && t !== 'night' && t !== 'dusk') continue
    return name
  }
  return 'rest'
}

// One question for the smart model. Short clauses on the bucket words,
// exactly like the iwb combat criteria: every longer variant regressed on
// the stand. All steps are named here so new behaviours plug in with
// one BEHAVIOURS line each (rw4.4/4.5); unregistered steps never reach ask().
const ASK_INSTRUCTIONS = 'Pick the next step: build and keep the home, or forage and deliver resources'
const STEP_CRITERIA = {
  gather: 'logs is none or few and home is not built: chop trees',
  craft: 'logs is enough or planks are few or door is no: craft planks, table and door',
  build: 'planks are enough and home is site: place the house blocks',
  gohome: 'time is dusk or night and home is built and inside is no: go inside',
  deliver: 'haul is waiting: carry it to the player',
  forage: 'known is near: walk to the remembered find and dig it',
  explore: 'known is none: walk the visited boundary',
  stay: 'inside is yes and time is dusk or night: wait inside',
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
  // Shelter is a night concept: a sticky gohome that finishes after sunrise
  // leaves inShelter true with no stay step to clear it, suppressing fight
  // all day (revmux 01-review loop+goal-3).
  if (ctx && facts.time === 'day') ctx.inShelter = false
  const text = goalText(facts)
  const prev = (ctx && ctx.step) || null
  const status = (ctx && ctx.stepStatus) || null
  const finished = status === 'done' || (typeof status === 'string' && status.startsWith('failed:'))
  if (finished && prev && typeof status === 'string' && status.startsWith('failed:')) {
    try {
      if (!ctx.stepFail || typeof ctx.stepFail !== 'object') ctx.stepFail = {}
      const bp = bot && bot.entity && bot.entity.position
      ctx.stepFail[prev] = { status, text, pos: bp ? { x: bp.x, y: bp.y, z: bp.z } : null }
    } catch (_) { /* guard best-effort */ }
  }
  // Night-step stickiness (rw4.5): gohome/stay own multi-tick door phases
  // (walk->open->enter->close). A facts-changed re-decision must not preempt
  // them mid-phase: stepping inside flips inside, which would hand stay the
  // step before gohome shuts the door, chats and shelters — and stepping out
  // flips it back before stay says good morning. The phase machine fails
  // itself on real trouble (no-home, cannot-reach), which re-arms choice.
  if (!finished && (prev === 'gohome' || prev === 'stay')) {
    const ph = prev === 'gohome' ? ctx.gohome && ctx.gohome.phase : ctx.stay && ctx.stay.phase
    if (ph && ph !== 'done' && ph !== 'failed') return { action: prev, sprint: false, source: 'goal-fsm' }
  }
  if (!prev || finished || ctx.goalText !== text) {
    const askKey = `${text}\n${status || ''}`
    if (prev && ctx.askedKey === askKey) return { action: ctx.step, sprint: false, source: 'goal-fsm' }
    ctx.askedKey = askKey
    const names = Object.keys(MENU).filter((n) => {
      try {
        if (!MENU[n].feasible(facts, bot, ctx) || !registered(n)) return false
      } catch (_) {
        return false
      }
      return !failHolds(ctx, n, text, bot)
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
    // An order that landed mid-await ('stop' parks, 'follow me' switches
    // work off) discards the step the tick then drops: announcing it would
    // lie, so only an actually-working bot chats. !== false keeps unit-test
    // {} ctx objects (work undefined) chatting.
    if (choice.step !== prev && !ctx.paused && ctx.work !== false) {
      console.log(`goal step=${choice.step} prev=${prev || 'none'} source=${choice.source} fsm=${choice.fsm} why=${why} facts=${text}`)
      const entry = MENU[choice.step]
      const verb = (entry && entry.verb) || choice.step
      try { bot.chat(`next: ${verb} (${choice.source})`) } catch (_) { /* chat best-effort */ }
    }
  }
  return { action: ctx.step, sprint: false, source: 'goal-fsm' }
}

module.exports = { MENU, STEP_ORDER, AUTONOMOUS_EXPLORE_RADIUS, NEED_LOGS, NEED_PLANKS, goalFacts, goalText, goalFsm, decide, chooseStep, STEP_CRITERIA, ASK_INSTRUCTIONS, logBucket, plankBucket, siteFor, adoptHome }
