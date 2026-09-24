'use strict'

// Recovery menu (idkcraft-ef3): 'stuck' is a HARD STATE — the smart model
// picks the escape from a feasibility-gated menu of body primitives through
// the shared brain.ask(), with the FSM below as reserve and disagreement
// reference (same shape as goal.js chooseStep). Detectors in
// follow/roam/lead/gather only raise the stuck fact via setStuck(); the
// handwritten sidestep/jump they used to do lives here as the sidestep
// primitive. Safety veto is feasibility, not separate logic: a dangerous
// option never reaches the menu (lava near the dig_* primitives).
//
// Episode: the ticker routes here while ctx.stuck is set. decide() asks at
// entry and after each finished primitive only, never per tick; a running
// primitive keeps its action. A done progress primitive (pillar_up/dig_up)
// chains without re-asking (max REPEATS); anything else done ends the
// episode. 3 failures force call_player once, then the goal is dropped.

const { Vec3 } = require('vec3')
const { goals } = require('mineflayer-pathfinder')
const { countItems } = require('../perception')
const metrics = require('../metrics')

const MAX_FAILS = 3 // failed primitives before call_player + drop goal
const REPEATS = 4 // max chained dones of one progress primitive, no re-ask
const WAIT_TICKS = 10
const APEX_TIMEOUT_TICKS = 20
const DIG_TIMEOUT_TICKS = 40
const SIDESTEP_TIMEOUT_TICKS = 8
const DIG_STEP_TIMEOUT_TICKS = 10 // mounting a dug step is quick or never
const STUCK_TICKS_ENTRY = 30 // generic backstop: still + moving this long
const PLACE_ERROR_ENTRY = 3 // generic backstop: consecutive place_error
const PROGRESS_TOLERANCE = 0.5
const PILLAR_APEX = 1.0 // jump apex: feet rise one full block
const SIDESTEP_DIST = 2
const NEAR_PLAYER = 8

const RECOVER_ORDER = ['pillar_up', 'dig_up', 'dig_step', 'sidestep', 'dig_through', 'wait', 'call_player']

// --- world scan helpers (all best-effort: nulls read as free/safe) ---

function botPos(bot) {
  try {
    const p = bot && bot.entity && bot.entity.position
    if (p && typeof p.x === 'number') return p
  } catch (_) { /* no position */ }
  return null
}

function fmtPos(p) {
  if (!p) return 'unknown'
  const f = (n) => (typeof n === 'number' ? (Number.isInteger(n) ? n : n.toFixed(1)) : '0')
  return `${f(p.x)},${f(p.y)},${f(p.z)}`
}

function cellAt(bot, dx, dy, dz) {
  try {
    const p = botPos(bot)
    if (!p || !bot.blockAt) return null
    return bot.blockAt(new Vec3(Math.floor(p.x) + dx, Math.floor(p.y) + dy, Math.floor(p.z) + dz))
  } catch (_) { return null }
}

// Solid for movement: a full block. Air-like, water and lava are passable
// (lava is tracked separately as a veto fact, not a wall).
function solid(b) {
  if (!b) return false
  if (typeof b.boundingBox === 'string') return b.boundingBox !== 'empty'
  const n = typeof b.name === 'string' ? b.name : ''
  return n !== '' && !n.endsWith('air') && n !== 'water' && n !== 'lava'
}

function isLava(b) {
  return !!b && typeof b.name === 'string' && b.name.includes('lava')
}

function isWater(b) {
  return !!b && typeof b.name === 'string' && b.name.includes('water')
}

function headBlockedAt(bot) {
  return solid(cellAt(bot, 0, 1, 0)) || solid(cellAt(bot, 0, 2, 0))
}

// Blocks a bare hand breaks fast (9sh): pit dirt/grass/sand/gravel walls.
// canDigBlock with an empty hand is the arbiter where available; the name
// set is the fallback (unit mocks, unreadable registry).
const HAND_DIG = new Set([
  'dirt', 'grass_block', 'coarse_dirt', 'rooted_dirt', 'podzol', 'mycelium',
  'mud', 'muddy_mangrove_roots', 'sand', 'red_sand', 'suspicious_sand',
  'gravel', 'suspicious_gravel', 'clay', 'snow', 'snow_block', 'moss_block',
])
function handDiggable(bot, b) {
  // Round-1 finding 1: mineflayer canDigBlock checks only diggable+reach,
  // never the tool — trusting it alone calls stone hand-diggable in prod.
  // The name set governs; canDigBlock only confirms reach where present.
  if (!b || typeof b.name !== 'string' || b.name === 'air') return false
  if (!HAND_DIG.has(b.name) && !b.name.endsWith('_leaves')) return false
  try {
    if (bot && typeof bot.canDigBlock === 'function') return !!bot.canDigBlock(b)
  } catch (_) { /* reach check best-effort */ }
  return true
}

const SIDES = [[1, 0], [-1, 0], [0, 1], [0, -1]]

function scanSides(bot) {
  const free = []
  let walls = 0
  for (const [dx, dz] of SIDES) {
    const blocked = solid(cellAt(bot, dx, 0, dz)) || solid(cellAt(bot, dx, 1, dz))
    if (blocked) walls++
    else free.push([dx, dz])
  }
  return { walls, free }
}

// A hand-dug staircase cycle (9sh): the side cell at feet level stays as
// the step to mount, the side cell above it is air or digs by hand, and the
// head has room to jump. Returns the side [dx, dz] or null.
function findDigStepDir(bot) {
  if (solid(cellAt(bot, 0, 2, 0))) return null
  for (const [dx, dz] of SIDES) {
    const step = cellAt(bot, dx, 0, dz)
    if (!solid(step)) continue
    const above = cellAt(bot, dx, 1, dz)
    if (above && solid(above) && !handDiggable(bot, above)) continue
    return [dx, dz]
  }
  return null
}

function lavaNearAt(bot) {
  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      for (let dz = -1; dz <= 1; dz++) {
        if (isLava(cellAt(bot, dx, dy, dz))) return true
      }
    }
  }
  return false
}

function scaffoldCount(bot) {
  return countItems(bot, (n) => n === 'dirt' || n === 'cobblestone')
}

function hasPickaxe(bot) {
  return countItems(bot, (n) => n.endsWith('_pickaxe')) > 0
}

function setJump(bot, on) {
  try {
    if (typeof bot.setControlState === 'function') bot.setControlState('jump', !!on)
  } catch (_) { /* control best-effort */ }
}

// --- stuck facts ---

function recoverFacts(bot, ctx, state, target) {
  const bp = botPos(bot)
  const stuck = (ctx && ctx.stuck) || {}
  const gp = stuck.goal || (target && target.position) || null
  let goalDy = 0
  let goalDist = null
  if (gp && typeof gp.x === 'number' && typeof gp.y === 'number' && typeof gp.z === 'number' && bp) {
    goalDy = Math.round(gp.y - bp.y)
    goalDist = Math.round(Math.hypot(gp.x - bp.x, gp.y - bp.y, gp.z - bp.z))
  }
  const sides = scanSides(bot)
  let playerOnline = false
  let playerDist = null
  let playerName = (target && target.username) || ((ctx && ctx.lead && ctx.lead.by) || null)
  try {
    const players = (bot && bot.players) || {}
    for (const key of Object.keys(players)) {
      if (key === bot.username) continue
      playerOnline = true
      const ent = players[key] && players[key].entity
      if (ent && ent.position && bp) {
        const d = Math.hypot(ent.position.x - bp.x, ent.position.y - bp.y, ent.position.z - bp.z)
        if (playerDist === null || d < playerDist) {
          playerDist = d
          playerName = (players[key] && players[key].username) || key
        }
      }
    }
  } catch (_) { /* roster best-effort */ }
  const rec = ctx && ctx.recovery
  return {
    by: stuck.by || 'unknown',
    goalDy,
    goalDist,
    scaffold: scaffoldCount(bot),
    pickaxe: hasPickaxe(bot),
    water: isWater(cellAt(bot, 0, 0, 0)) || !!(bot && bot.entity && bot.entity.isInWater === true),
    headBlocked: headBlockedAt(bot),
    digStep: findDigStepDir(bot),
    walls: sides.walls,
    freeSides: sides.free,
    lavaNear: lavaNearAt(bot),
    playerOnline,
    playerDist: playerDist === null ? null : Math.round(playerDist),
    playerName,
    stuckTicks: (ctx && ctx.stuckTicks) || 0,
    resetsStuck: (ctx && ctx.stuckResets) || 0,
    resetsPlaceError: (ctx && ctx.placeErrors) || 0,
    last: rec && rec.last ? `${rec.last.action}:${rec.last.outcome}` : 'none',
  }
}

function stuckBucket(n) {
  return n < 10 ? 'fresh' : n < STUCK_TICKS_ENTRY ? 'long' : 'very-long'
}

// Canonical facts text, ALSO the model state and the ask dedup key: bucket
// words, not raw counters (iwb lesson) — raw stuck_ticks would re-ask every
// tick while the bot stands still.
function recoverText(facts) {
  const dy = facts.goalDy >= 2 ? 'high' : facts.goalDy <= -2 ? 'low' : 'level'
  const dist = facts.goalDist === null ? 'none' : String(facts.goalDist)
  const player = !facts.playerOnline ? 'none' : facts.playerDist === null ? 'far' : facts.playerDist <= NEAR_PLAYER ? 'near' : 'far'
  return `stuck=${stuckBucket(facts.stuckTicks)} goal=${dy} dist=${dist} ` +
    `scaffold=${facts.scaffold} pickaxe=${facts.pickaxe ? 'yes' : 'no'} water=${facts.water ? 'yes' : 'no'} ` +
    `head=${facts.headBlocked ? 'blocked' : 'free'} walls=${facts.walls} player=${player} ` +
    `resets=${facts.resetsStuck}/${facts.resetsPlaceError} last=${facts.last}`
}

// FSM reserve and disagreement reference (bead order verbatim): climb when
// the goal is above, else sidestep, else dig through, else call, else wait.
// wait is always feasible so this always returns a menu member. Escalation,
// not repetition (prod 2026-09-23: 28 of 35 repeat wedges at the same spot):
// after a failure the just-failed primitive yields to the next feasible one
// (the model sees the same signal via last=<action>:<outcome> in the facts).
function recoverFsm(facts, names) {
  const ok = new Set(Array.isArray(names) ? names : [])
  let failed = null
  const m = /^(pillar_up|dig_up|dig_step|sidestep|dig_through|wait|call_player):failed/.exec((facts && facts.last) || '')
  if (m && ok.size > 1) failed = m[1]
  const pick = (n) => n !== failed && ok.has(n)
  if (facts.goalDy >= 2 && pick('pillar_up')) return 'pillar_up'
  if (facts.goalDy >= 2 && pick('dig_up')) return 'dig_up'
  if (facts.goalDy >= 2 && pick('dig_step')) return 'dig_step'
  // High goal, no climb primitive, enclosed pit, player online: asking beats
  // a sideways shuffle the strict sidestep rule would fail anyway (9sh). In
  // the open (walls < 3) sidestep keeps its turn: walking goalward can still
  // gain and free the wedge, which the fja rule counts as done.
  if (facts.goalDy >= 2 && facts.playerOnline && facts.walls >= 3 && pick('call_player') &&
    !ok.has('pillar_up') && !ok.has('dig_up') && !ok.has('dig_step')) return 'call_player'
  if (pick('sidestep')) return 'sidestep'
  if (pick('dig_through')) return 'dig_through'
  if (pick('call_player')) return 'call_player'
  return 'wait'
}

// One question for the smart model. Short clauses on the fact words,
// exactly like the goal step criteria: every longer variant regressed on
// the stand. Dangerous options are absent by feasibility (lava veto), never
// by instruction — the model only ever sees safe labels.
// Wording validated on the stand (bot/tools/stand-ef3.js): verbs-first v1
// beats the long v0 on laya 5/7 to 4/7 agreement (JEV ties 5/7); all runs
// 7/7 valid labels, disagreements are all safe (wait / call_player).
const RECOVER_INSTRUCTIONS = 'The bot is stuck. Pick one recovery action'
const RECOVER_CRITERIA = {
  pillar_up: 'climb: goal is high, scaffold on hand, headroom free — jump and place one block under your feet',
  dig_up: 'climb: goal is high, pickaxe on hand — dig above your head and climb',
  dig_step: 'climb: no pickaxe or blocks, pit wall digs by hand — dig one step and climb out',
  sidestep: 'bypass: a side is open — step sideways around the obstacle',
  dig_through: 'tunnel: pickaxe on hand, no lava near — dig 1-wide 2-tall toward the goal',
  wait: 'wait: the blockage looks temporary — stand still',
  call_player: 'help: a player is online and no escape works — ask the player for a teleport',
}

// Model recovery choice with the FSM as fallback and disagreement
// reference, exactly like goal chooseStep: { action, source, fsm, model }.
// source is only-option (single feasible action, model not asked), fsm (no
// ask method: stub brain or unit tests), <brain source> (model answered) or
// stub-fallback (model consulted and failed: invalid label or error).
async function chooseRecovery(brain, facts, feasible) {
  const names = RECOVER_ORDER.filter((n) => feasible.includes(n))
  const text = recoverText(facts)
  const fsm = recoverFsm(facts, names)
  if (names.length <= 1) return { action: names[0] || 'wait', source: 'only-option', fsm, model: null }
  if (!brain || typeof brain.ask !== 'function') return { action: fsm, source: 'fsm', fsm, model: null }
  const model = (brain.source || brain.name || 'model')
  // The just-failed primitive is out of the MODEL menu (4jr): the FSM
  // already escalates past it, but laya repeated pillar_up to MAX_FAILS.
  // Kept when it is the only option; the FSM fallback below still sees it.
  const failedM = /^(pillar_up|dig_up|dig_step|sidestep|dig_through|wait|call_player):failed/.exec((facts && facts.last) || '')
  const askNames = (failedM && names.length > 1) ? names.filter((n) => n !== failedM[1]) : names
  const criteria = {}
  for (const n of askNames) criteria[n] = RECOVER_CRITERIA[n]
  const fail = (reason) => {
    metrics.escalation.inc({ from: model, to: 'fsm', reason })
    return { action: fsm, source: 'stub-fallback', fsm, model }
  }
  try {
    const label = await brain.ask({ state: text, instructions: RECOVER_INSTRUCTIONS, criteria, situation: text })
    // An infeasible label is still a model opinion against the FSM
    // reference: disagree first, then fall back (acceptance: invalid answers
    // disagree in the log).
    if (label !== fsm) {
      console.error(`brain disagree source=${model} model=${label} fsm=${fsm} reason=stuck facts=${text}`)
    }
    if (!askNames.includes(label)) return fail('invalid')
    return { action: label, source: model, fsm, model }
  } catch (err) {
    const msg = String((err && err.message) || err)
    const reason = (err && err.name === 'TimeoutError') ? 'timeout'
      : msg.startsWith('jev missing') ? 'invalid'
      : 'error'
    return fail(reason)
  }
}

// --- primitives: one tick each, multi-tick state in ctx.recovery.st ---
// Every primitive returns 'running' | 'done' | 'failed:<reason>'.

// Pillar up: jump, wait for the apex (feet +1.0), place ONE block into the
// feet cell, verify. Exactly one placement in flight at a time — parallel
// placeBlock calls into one cell share one server ack and loop forever
// (idkcraft-yvi: 438 place_error, 7.5 min in place).
function pillarUpRun(bot, ctx) {
  const rec = ctx.recovery
  const st = rec.st || (rec.st = { phase: 'jump', waited: 0, placeInFlight: false, placed: false, placeError: false, startFloor: null })
  const bp = botPos(bot)
  if (!bp) return 'failed:no-pos'
  // Runtime veto double-check: feasibility said yes, the world may disagree.
  if (scaffoldCount(bot) === 0) { setJump(bot, false); return 'failed:no-scaffold' }
  if (headBlockedAt(bot)) { setJump(bot, false); return 'failed:head-blocked' }
  if (st.startFloor === null) st.startFloor = Math.floor(bp.y)
  if (st.phase === 'jump') {
    if (bp.y >= st.startFloor + PILLAR_APEX) {
      st.phase = 'place'
      setJump(bot, false)
    } else {
      setJump(bot, true)
      if (++st.waited > APEX_TIMEOUT_TICKS) { setJump(bot, false); return 'failed:no-apex' }
      return 'running'
    }
  }
  if (st.placed) {
    // Verify the block is really there before claiming done: the target is
    // the feet cell we jumped from (startFloor), whatever floor we read now.
    return solid(cellAt(bot, 0, st.startFloor - Math.floor(bp.y), 0)) ? 'done' : 'failed:no-place'
  }
  if (st.placeError) return 'failed:place-error'
  if (st.placeInFlight) return 'running'
  // Fell below the apex while the ack was in flight (slow server,
  // knockback): jump again, never place from below into the occupied feet
  // cell. Already solid (a twin call, an earlier cycle): verify instead of
  // stacking a second placement into the cell (the yvi loop).
  if (bp.y < st.startFloor + PILLAR_APEX - 0.01) { st.phase = 'jump'; st.waited = 0; return 'running' }
  if (solid(cellAt(bot, 0, st.startFloor - Math.floor(bp.y), 0))) { st.placed = true; return 'running' }
  // Reference: a solid neighbour of the feet cell, ground below first.
  const fx = Math.floor(bp.x)
  const fz = Math.floor(bp.z)
  const fy = st.startFloor
  const refs = [
    { d: [0, -1, 0], f: [0, 1, 0] },
    { d: [1, 0, 0], f: [-1, 0, 0] },
    { d: [-1, 0, 0], f: [1, 0, 0] },
    { d: [0, 0, 1], f: [0, 0, -1] },
    { d: [0, 0, -1], f: [0, 0, 1] },
  ]
  let ref = null
  let face = null
  for (const r of refs) {
    const c = cellAt(bot, fx - Math.floor(bp.x) + r.d[0], fy - Math.floor(bp.y) + r.d[1], fz - Math.floor(bp.z) + r.d[2])
    if (solid(c)) { ref = c; face = new Vec3(r.f[0], r.f[1], r.f[2]); break }
  }
  if (!ref || typeof bot.placeBlock !== 'function') return 'failed:no-reference'
  st.placeInFlight = true
  void (async () => {
    try {
      await bot.placeBlock(ref, face)
      st.placed = true
    } catch (_) { st.placeError = true } finally { st.placeInFlight = false }
  })()
  return 'running'
}

// Dig up: remove headroom (feet+1, then feet+2) with the pickaxe. Done when
// both are air — the step up itself is the pathfinder's job (prod) or the
// test harness's (unit). Lava next to the dig is a runtime veto.
function digUpRun(bot, ctx) {
  const rec = ctx.recovery
  const st = rec.st || (rec.st = { waited: 0, digInFlight: false, digError: false })
  if (!hasPickaxe(bot)) return 'failed:no-pickaxe'
  if (lavaNearAt(bot)) return 'failed:lava'
  const head1 = cellAt(bot, 0, 1, 0)
  const head2 = cellAt(bot, 0, 2, 0)
  if (!solid(head1) && !solid(head2)) return 'done'
  if (st.digError) return 'failed:dig-error'
  if (st.digInFlight) {
    if (++st.waited > DIG_TIMEOUT_TICKS) return 'failed:dig-timeout'
    return 'running'
  }
  if (typeof bot.dig !== 'function') return 'failed:no-dig'
  const cell = solid(head1) ? head1 : head2
  st.digInFlight = true
  void (async () => {
    try { await bot.dig(cell) } catch (_) { st.digError = true } finally { st.digInFlight = false }
  })()
  return 'running'
}

// Dig a step by hand and mount it (9sh): no scaffold, no pickaxe, dirt
// pit. One cycle digs the wall above the side step, then jumps onto the
// step top — done on floor rise, repeatable to the mouth. st.dir re-scans
// when its step collapses mid-cycle.
function digStepRun(bot, ctx) {
  const rec = ctx.recovery
  const st = rec.st || (rec.st = { dir: null, phase: 'dig', waited: 0, digInFlight: false, digError: false, startFloor: null })
  const bp = botPos(bot)
  if (!bp) return 'failed:no-pos'
  if (st.startFloor === null) st.startFloor = Math.floor(bp.y)
  // Round-1 finding 2: a 1 Hz tick sampling the jump apex reads y+1 while
  // airborne. Done needs ground under the risen feet — landing back on the
  // pit floor is not an escape. (The step column itself is not required: a
  // natural +1 ledge nearby is genuine progress too.)
  const grounded = !bot.entity || !!bot.entity.onGround
  if (Math.floor(bp.y) > st.startFloor && grounded) { setJump(bot, false); return 'done' }
  if (!st.dir) {
    st.dir = findDigStepDir(bot)
    if (!st.dir) { setJump(bot, false); return 'failed:no-step' }
  }
  const above = cellAt(bot, st.dir[0], 1, st.dir[1])
  if (above && solid(above)) {
    if (!handDiggable(bot, above)) { st.dir = null; return 'running' }
    if (lavaNearAt(bot)) { setJump(bot, false); return 'failed:lava' }
    if (st.digError) { setJump(bot, false); return 'failed:dig-error' }
    if (st.digInFlight) {
      if (++st.waited > DIG_TIMEOUT_TICKS) { setJump(bot, false); return 'failed:dig-timeout' }
      return 'running'
    }
    if (typeof bot.dig !== 'function') { setJump(bot, false); return 'failed:no-dig' }
    st.digInFlight = true
    void (async () => {
      try { await bot.dig(above) } catch (_) { st.digError = true } finally { st.digInFlight = false }
    })()
    return 'running'
  }
  // Headroom dug: mount the step. The step collapsing under us re-scans.
  const step = cellAt(bot, st.dir[0], 0, st.dir[1])
  if (!solid(step)) { st.dir = null; return 'running' }
  if (st.phase !== 'step') {
    st.phase = 'step'
    st.waited = 0
    try {
      const p = step.position
      if (bot.pathfinder && typeof bot.pathfinder.setGoal === 'function' && p) {
        bot.pathfinder.setGoal(new goals.GoalNear(p.x, p.y + 1, p.z, 1), false)
      }
    } catch (_) { /* goal best-effort */ }
  }
  setJump(bot, true)
  if (++st.waited > DIG_STEP_TIMEOUT_TICKS) { setJump(bot, false); return 'failed:no-progress' }
  return 'running'
}

// Sidestep: the old wedge/nudge action, now a primitive — 2 blocks toward
// a free side with a one-tick jump. Done on displacement, failed when the
// body still does not move.
function sidestepRun(bot, ctx) {
  const rec = ctx.recovery
  const st = rec.st || (rec.st = { start: null, dir: null, waited: 0, issued: false })
  const bp = botPos(bot)
  if (!bp) return 'failed:no-pos'
  if (!st.start) {
    st.start = { x: bp.x, y: bp.y, z: bp.z }
    // Snapshot the goal for the approach check below (fja): a flat shuffle
    // toward a far goal is not an escape. Null for the generic backstop.
    const gp = ctx.stuck && ctx.stuck.goal
    st.goal0 = gp && typeof gp.x === 'number' && typeof gp.y === 'number' && typeof gp.z === 'number'
      ? { x: gp.x, y: gp.y, z: gp.z }
      : null
    st.goalDist0 = st.goal0 ? Math.hypot(bp.x - st.goal0.x, bp.y - st.goal0.y, bp.z - st.goal0.z) : null
    const sides = scanSides(bot)
    if (sides.free.length === 0) return 'failed:boxed'
    st.dir = sides.free[Math.floor(Math.random() * sides.free.length)]
  }
  // Done only when the situation really changed (fja). The strict rule
  // applies to goal-less backstop episodes (the session pit: nothing to
  // resume toward, shuffling proves nothing) and high goals (a climb
  // situation). A level goal keeps the old displacement done: a wedge that
  // walks 2 blocks sideways is genuinely free and the mode resumes pathing
  // — failing that would burn strikes and misroute to dig/call_player.
  const strict = !st.goal0 || (st.goal0.y - st.start.y) >= 2
  const climbed = Math.floor(bp.y) > Math.floor(st.start.y)
  let gained = false
  if (strict && st.goal0 && (st.goal0.y - st.start.y) >= 2 && typeof st.goalDist0 === 'number') {
    gained = st.goalDist0 - Math.hypot(bp.x - st.goal0.x, bp.y - st.goal0.y, bp.z - st.goal0.z) > 1
  }
  const freed = !strict && Math.hypot(bp.x - st.start.x, bp.z - st.start.z) > PROGRESS_TOLERANCE
  if (climbed || gained || freed) {
    setJump(bot, false)
    return 'done'
  }
  if (++st.waited > SIDESTEP_TIMEOUT_TICKS) { setJump(bot, false); return 'failed:no-progress' }
  if (!st.issued) {
    st.issued = true
    try {
      if (bot.pathfinder && typeof bot.pathfinder.setGoal === 'function') {
        bot.pathfinder.setGoal(new goals.GoalNear(bp.x + st.dir[0] * SIDESTEP_DIST, bp.y, bp.z + st.dir[1] * SIDESTEP_DIST, 1), false)
      }
    } catch (_) { /* goal best-effort */ }
    setJump(bot, true)
  } else {
    setJump(bot, false)
  }
  return 'running'
}

// Dig through: a 1x2 tunnel toward the goal, feet cell first, one dig at a
// time. Lava in a target cell is a runtime veto, like the menu feasibility.
function digThroughRun(bot, ctx) {
  const rec = ctx.recovery
  const st = rec.st || (rec.st = { waited: 0, digInFlight: false, digError: false })
  const bp = botPos(bot)
  if (!bp) return 'failed:no-pos'
  if (!hasPickaxe(bot)) return 'failed:no-pickaxe'
  const stuck = ctx.stuck || {}
  const gp = stuck.goal
  let dx = 0
  let dz = 0
  if (gp && typeof gp.x === 'number' && typeof gp.z === 'number') {
    dx = gp.x - bp.x
    dz = gp.z - bp.z
  }
  if (dx === 0 && dz === 0) return 'failed:no-direction'
  const step = Math.abs(dx) >= Math.abs(dz) ? [Math.sign(dx), 0] : [0, Math.sign(dz)]
  const feet = cellAt(bot, step[0], 0, step[1])
  const head = cellAt(bot, step[0], 1, step[1])
  if (isLava(feet) || isLava(head)) return 'failed:lava'
  if (lavaNearAt(bot)) return 'failed:lava'
  if (!solid(feet) && !solid(head)) return 'done'
  if (st.digError) return 'failed:dig-error'
  if (st.digInFlight) {
    if (++st.waited > DIG_TIMEOUT_TICKS) return 'failed:dig-timeout'
    return 'running'
  }
  if (typeof bot.dig !== 'function') return 'failed:no-dig'
  const cell = solid(feet) ? feet : head
  st.digInFlight = true
  void (async () => {
    try { await bot.dig(cell) } catch (_) { st.digError = true } finally { st.digInFlight = false }
  })()
  return 'running'
}

function waitRun(bot, ctx) {
  const rec = ctx.recovery
  const st = rec.st || (rec.st = { n: 0 })
  st.n++
  return st.n >= WAIT_TICKS ? 'done' : 'running'
}

// Call the player for a teleport, exactly once per episode. Terminal: the
// episode ends after this (release drops the goal).
function callPlayerRun(bot, ctx) {
  const rec = ctx.recovery
  if (rec.calledPlayer) return 'done'
  const bp = botPos(bot)
  const facts = recoverFacts(bot, ctx, null, null)
  const name = facts.playerName
  if (!name) return 'failed:no-player'
  try {
    bot.chat(`I'm stuck at ${Math.floor(bp.x)} ${Math.floor(bp.y)} ${Math.floor(bp.z)}, /tp ${bot.username} ${name}`)
  } catch (_) { return 'failed:chat' }
  rec.calledPlayer = true
  rec.endEpisode = true
  return 'done'
}

const RECOVER_MENU = {
  pillar_up: {
    // 4jr: a pillar to a level goal is pointless — laya took the first menu
    // item anyway, 29 times in 16 min. Climb prims need the goal above.
    feasible: (facts) => facts.goalDy >= 1 && facts.scaffold > 0 && !facts.headBlocked,
    run: pillarUpRun,
    repeatable: (facts) => facts.goalDy >= 1 && facts.scaffold > 0,
    verb: 'pillaring up',
  },
  dig_up: {
    feasible: (facts) => facts.goalDy >= 1 && facts.pickaxe && !facts.lavaNear,
    run: digUpRun,
    repeatable: (facts) => facts.goalDy >= 1 && facts.pickaxe,
    verb: 'digging up',
  },
  dig_step: {
    feasible: (facts) => facts.digStep != null && !facts.lavaNear,
    run: digStepRun,
    repeatable: (facts) => facts.goalDy >= 1 && facts.digStep != null,
    verb: 'digging a step',
  },
  sidestep: {
    feasible: (facts) => facts.walls < 4,
    run: sidestepRun,
    verb: 'sidestepping',
  },
  dig_through: {
    feasible: (facts) => facts.pickaxe && !facts.lavaNear,
    run: digThroughRun,
    verb: 'digging through',
  },
  wait: {
    feasible: () => true,
    run: waitRun,
    verb: 'waiting it out',
  },
  call_player: {
    feasible: (facts, ctx) => facts.playerOnline && !(ctx && ctx.recovery && ctx.recovery.calledPlayer),
    run: callPlayerRun,
    verb: 'calling the player',
  },
}

// --- episode ---

// Detectors call this instead of moving the body themselves. True on the
// transition (fact raised), false when an episode already runs, the fact is
// already set, or the latch holds for the same situation (a just-finished
// episode: re-firing without new information would ask+chat every few
// seconds). A moved goal clears the latch and raises fresh.
function goalClose(a, b) {
  if (!a || !b) return !a && !b
  if (typeof a.x !== 'number' || typeof b.x !== 'number') return false
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z) <= 2
}
function setStuck(ctx, by, goal, key) {
  if (!ctx || ctx.recovery || ctx.stuck) return false
  const g = goal && typeof goal.x === 'number' ? { x: goal.x, y: goal.y, z: goal.z } : null
  const k = key || by || 'unknown'
  const L = ctx.recoverLatch
  if (L && L.by === (by || 'unknown') && L.key === k) {
    // spot: keys latch on the key alone (the goal they carry is random or
    // irrelevant); other keys latch on a close goal (a moved goal is new).
    if (k.startsWith('spot:') || goalClose(L.goal, g)) return false
    ctx.recoverLatch = null // same detector, moved situation: fresh episode
  }
  ctx.stuck = { by: by || 'unknown', goal: g, key: k }
  return true
}

function blockNameOf(b) {
  try {
    return (b && typeof b.name === 'string' && b.name) || '?'
  } catch (_) { return '?' }
}

// Chosen lines (fja) carry the facts text plus feet/head/next block names
// (b50 wedge-line style), so a pit, water and a wall read apart in prod
// logs. facts is null on terminal/continue lines: pos alone there.
function logRecover(bot, ctx, action, source, outcome, facts) {
  let extra = ''
  if (facts) {
    let next = '?:?'
    try {
      const n = ctx && ctx.lastPathNext
      if (n && typeof n.x === 'number') {
        next = `${n.x},${n.y},${n.z}:${blockNameOf(bot.blockAt && bot.blockAt(n))}`
      }
    } catch (_) { /* next best-effort */ }
    extra = ` facts=${recoverText(facts)} feet=${blockNameOf(cellAt(bot, 0, 0, 0))} ` +
      `head=${blockNameOf(cellAt(bot, 0, 1, 0))} next=${next}`
  }
  console.log(`recover action=${action} source=${source} outcome=${outcome} pos=${fmtPos(botPos(bot))}${extra}`)
}

// Episode end: drop the pathfinder goal (a stale goal re-wedges the next
// tick — idkcraft-yvi), resume the owning mode, clear the fact. done =
// an escape worked; gave-up = budget spent, target stays dropped.
function release(bot, ctx, how) {
  const rec = ctx.recovery || {}
  const by = (ctx.stuck && ctx.stuck.by) || 'unknown'
  try {
    if (bot.pathfinder && bot.pathfinder.goal && typeof bot.pathfinder.setGoal === 'function') {
      bot.pathfinder.setGoal(null)
    }
  } catch (_) { /* body best-effort */ }
  setJump(bot, false)
  if (by === 'lead' && ctx.lead) {
    // One escape episode per order: a still-stuck order gives up next, like
    // the old second nudge. A gave-up episode clears the order itself. The
    // stall counters restart so the resume gets a fresh give-up window.
    // nudgedAt marks real gain: only getting closer than the release point
    // earns fresh strikes (walking back to the wedge is not progress).
    ctx.lead.nudged = true
    try {
      const bp = botPos(bot)
      const t = ctx.lead.pos
      const atRelease = (bp && t) ? Math.round(Math.hypot(t.x - bp.x, t.y - bp.y, t.z - bp.z)) : null
      // The wedge point, not the release point, marks no-gain: a sidestep
      // away from the goal must not re-arm the budget on the walk back.
      const atWedge = ctx.lead.stallDist
      ctx.lead.nudgedAt = (atWedge != null && atRelease != null) ? Math.min(atWedge, atRelease)
        : (atWedge != null ? atWedge : atRelease)
    } catch (_) { ctx.lead.nudgedAt = null }
    ctx.lead.stuckTicks = 0
    ctx.lead.workTicks = 0
    if (how === 'gave-up') ctx.lead = null
  }
  if (by === 'gather' && ctx.gather) {
    // An escape may have moved the bot somewhere reachable: scan fresh.
    // On gave-up the step's failed:* final stands and the arbiter moves on.
    if (how !== 'gave-up') { ctx.gather.skip.clear(); ctx.gather.streak = 0 }
  }
  if (by === 'follow') ctx.followStalls = 0
  if (by === 'follow' || by === 'roam' || by === 'gather' || by === 'home') {
    const sk = (ctx.stuck && ctx.stuck.key) || by
    const sg = ctx.stuck && ctx.stuck.goal
    ctx.recoverLatch = { by, key: sk, goal: sg ? { x: sg.x, y: sg.y, z: sg.z } : null }
    if (by === 'home') {
      // Homing goals never move, so goal-closeness cannot tell one wedge
      // from the next: anchor the release point instead. walkHomeTick
      // re-arms only once the body relocated past HOME_LATCH_CLEAR.
      const bp = botPos(bot)
      if (bp) ctx.recoverLatch.at = { x: bp.x, y: bp.y, z: bp.z }
    }
  }
  ctx.lastGoalKey = ''
  ctx.stuckResets = 0
  ctx.placeErrors = 0
  ctx.stuckTicks = 0
  ctx.stuck = null
  ctx.recovery = null
  // Terminal dones are already counted by decide() per finished primitive;
  // counting here too doubled outcome=done in prod (fja). gave-up is only
  // ever recorded here.
  if (how !== 'done') metrics.recover.inc({ action: rec.action || 'none', source: rec.source || 'fsm', outcome: how })
  logRecover(bot, ctx, rec.action || 'none', rec.source || 'fsm', how)
  return { action: 'idle', sprint: false, source: rec.source || 'fsm' }
}

// Decision point: entry (no episode) or a finished primitive. A running
// primitive keeps its action with no re-ask. Returns a BEHAVIOURS action
// (the primitive) or idle after release.
async function decide(bot, ctx, state, target) {
  const facts = recoverFacts(bot, ctx, state, target)
  const text = recoverText(facts)
  let rec = ctx.recovery
  if (rec && rec.status === 'running') {
    return { action: rec.action, sprint: false, source: rec.source }
  }
  if (!rec) {
    rec = ctx.recovery = { action: null, source: null, model: null, status: 'starting', st: null, attempts: 0, fails: 0, repeats: 0, last: null, calledPlayer: false, endEpisode: false, lastDy: null }
    metrics.routes.inc({ route: 'hard', reason: 'stuck' })
    // Drop the stale goal first: a live GoalFollow/GoalNear keeps driving
    // the executor (jump/forward overrides at 20 Hz) and fights every
    // primitive except sidestep, which sets its own goal afterwards.
    try {
      if (bot.pathfinder && bot.pathfinder.goal && typeof bot.pathfinder.setGoal === 'function') {
        bot.pathfinder.setGoal(null)
      }
    } catch (_) { /* body best-effort */ }
  } else {
    // A primitive finished: record the outcome, then continue, re-ask, or
    // give up. Terminal states feed the next facts as last=<action>:<outcome>.
    const prev = rec.action
    const outcome = rec.status
    const source = rec.source || 'fsm'
    rec.last = { action: prev, outcome }
    // The choice below must see the just-recorded outcome: facts was built
    // before it, so FSM escalation and the model-menu exclusion would both
    // read the previous last (4jr: the model repeated pillar_up live).
    facts.last = `${prev}:${outcome}`
    metrics.recover.inc({ action: prev, source, outcome: outcome === 'done' ? 'done' : outcome })
    if (outcome === 'done') {
      if (rec.endEpisode || !(RECOVER_MENU[prev] && RECOVER_MENU[prev].repeatable)) {
        return release(bot, ctx, rec.endEpisode ? 'gave-up' : 'done')
      }
      rec.repeats = (rec.repeats || 0) + 1
      const fresh = recoverFacts(bot, ctx, state, target)
      // Chain without re-asking only while the goal keeps getting closer: a
      // no-gain done (fell back, verified an old block) ends the episode
      // instead of burning the budget. repeatable() bounds the climb, so a
      // rising goal cannot chain forever either.
      const closer = rec.lastDy === null || fresh.goalDy < rec.lastDy
      if (closer && rec.repeats < REPEATS && RECOVER_MENU[prev].repeatable(fresh)) {
        rec.lastDy = fresh.goalDy
        rec.status = 'running'
        rec.st = null
        logRecover(bot, ctx, prev, source, 'continue')
        return { action: prev, sprint: false, source }
      }
      return release(bot, ctx, 'done')
    }
    rec.fails = (rec.fails || 0) + 1
    rec.repeats = 0
    if (rec.fails >= MAX_FAILS) {
      // Pilot budget spent: one call for help (when anyone can hear it),
      // then the goal is dropped. call_player runs through the normal
      // choice path so its chat and metric stay in one place.
      const names = RECOVER_ORDER.filter((n) => {
        try { return RECOVER_MENU[n].feasible(recoverFacts(bot, ctx, state, target), ctx) } catch (_) { return false }
      })
      // A just-failed call_player (nobody online to hear it) must not be
      // re-picked: feasibility stays true while calledPlayer is false, so
      // without this the episode loops 'chosen' forever. Falls through to
      // gave-up below instead.
      if (names.includes('call_player') && (!rec.last || rec.last.action !== 'call_player')) {
        rec.action = 'call_player'
        rec.source = 'fsm'
        rec.model = null
        rec.status = 'running'
        rec.st = null
        rec.attempts = (rec.attempts || 0) + 1
        metrics.recover.inc({ action: 'call_player', source: 'fsm', outcome: 'chosen' })
        logRecover(bot, ctx, 'call_player', 'fsm', 'chosen')
        return { action: 'call_player', sprint: false, source: 'fsm' }
      }
      return release(bot, ctx, 'gave-up')
    }
  }
  // Fresh choice: feasible menu through the smart model, FSM on failure.
  const names = RECOVER_ORDER.filter((n) => {
    try { return RECOVER_MENU[n].feasible(facts, ctx) } catch (_) { return false }
  })
  const choice = await chooseRecovery(ctx && ctx.brain, facts, names)
  rec.action = choice.action
  rec.source = choice.source
  rec.model = choice.model
  rec.status = 'running'
  rec.st = null
  rec.attempts = (rec.attempts || 0) + 1
  metrics.recover.inc({ action: choice.action, source: choice.source, outcome: 'chosen' })
  logRecover(bot, ctx, choice.action, choice.source, 'chosen', facts)
  if (choice.action !== 'call_player' && (!rec.last || rec.last.action !== choice.action)) {
    try { bot.chat(`stuck, trying ${RECOVER_MENU[choice.action].verb} (${choice.source})`) } catch (_) { /* chat best-effort */ }
  }
  return { action: choice.action, sprint: false, source: choice.source }
}

// BEHAVIOURS entry: run one tick of the episode's primitive. The ticker
// dispatches here via applyDecision, so the decision line and the decisions
// metric work unchanged.
function run(bot, ctx) {
  const rec = ctx && ctx.recovery
  if (!rec || !rec.action || !RECOVER_MENU[rec.action]) return
  try {
    rec.status = RECOVER_MENU[rec.action].run(bot, ctx)
  } catch (_) {
    rec.status = 'failed:error'
  }
}

module.exports = {
  RECOVER_ORDER,
  RECOVER_MENU,
  RECOVER_INSTRUCTIONS,
  RECOVER_CRITERIA,
  MAX_FAILS,
  REPEATS,
  WAIT_TICKS,
  STUCK_TICKS_ENTRY,
  PLACE_ERROR_ENTRY,
  recoverFacts,
  recoverText,
  recoverFsm,
  chooseRecovery,
  setStuck,
  decide,
  release,
  run,
}
