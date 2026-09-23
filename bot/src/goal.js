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
const BLUEPRINT = buildMod.BLUEPRINT
const PLANK_COUNT = buildMod.PLANK_COUNT

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
    feasible: (facts) => facts.logs >= NEED_LOGS || (facts.maxPlanks >= 4 && facts.table === 0 && !facts.tablePlaced) || (facts.maxPlanks >= 6 && facts.door === 0 && facts.tablePlaced),
    chat: () => 'on my own: crafting planks and tools',
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
        home.table = { x: home.site.x + t.dx, y: home.site.y + t.dy, z: home.site.z + t.dz }
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
  return { time, logs, planks, maxPlanks, table, door, home, tablePlaced, inside }
}

// Canonical facts text: the decision point fires when it changes (same role
// as stateKey for the brain).
function goalText(facts) {
  return `time=${facts.time} logs=${facts.logs} planks=${facts.planks} ` +
    `table=${facts.table} door=${facts.door} home=${facts.home} placed=${facts.tablePlaced ? 'yes' : 'no'} inside=${facts.inside}`
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
        return MENU[n].feasible(facts, bot, ctx) && registered(n)
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

module.exports = { MENU, STEP_ORDER, NEED_LOGS, NEED_PLANKS, goalFacts, goalText, goalFsm, decide, siteFor, adoptHome }
