'use strict'

// Per-tick reflexes (idkcraft-6x7.1 round 2): mechanically moved from
// index.js — eat, breath, melee swing, creeper flee. Same call signatures;
// runTick calls them unchanged.
const Vec3 = require('vec3')
const { goals } = require('mineflayer-pathfinder')
const { findCreeper, snapHostiles } = require('./perception')
const body = require('./body')
const metrics = require('./metrics')
const fightMod = require('./behaviours/fight')

const origEquipGear = fightMod.equipGear
fightMod.equipGear = function(bot) {
  if (bot && bot._tickerCtx && bot._tickerCtx.eatInFlight) return Promise.resolve()
  return origEquipGear(bot)
}

// Eat reflex (3nt.22): natural regen needs food >= 18. Consumes the best
// edible item from inventory on the every-tick seam when food < 18 and no
// hostile is within swing reach. Equips food to hand, consumes, then
// restores gear via fightMod.equipGear.
const EDIBLE_FOODS = new Set([
  'bread',
  'cooked_beef',
  'cooked_porkchop',
  'cooked_chicken',
  'cooked_mutton',
  'cooked_rabbit',
  'apple',
  'carrot',
  'baked_potato',
  // Safe raw fallback (idkcraft-vmzq.34): hunts drop raw meat and no cooking
  // loop feeds the pack yet, so the eater takes safe raw when nothing better
  // is on hand. Raw chicken stays out (30% hunger), like rotten flesh and
  // the poisonous foods.
  'beef',
  'porkchop',
  'mutton',
  'rabbit',
])

// Raw meats eatReflex only touches as a fallback (vmzq.34 above): safe to
// eat, but less hunger per slot than cooked, so anything else wins.
const RAW_FALLBACK = new Set(['beef', 'porkchop', 'mutton', 'rabbit'])

// Best edible: the first preferred item in inventory order, else the first
// raw fallback. Pure, so the preference mutant dies here.
function pickEdible(items) {
  let raw = null
  for (const i of items || []) {
    if (!i || typeof i.name !== 'string' || !EDIBLE_FOODS.has(i.name)) continue
    if (RAW_FALLBACK.has(i.name)) {
      if (!raw) raw = i
      continue
    }
    return i
  }
  return raw
}

function installEquipGuard(bot, ctx) {
  if (!bot || bot._equipGuardInstalled) return
  const origEquip = bot.equip
  if (typeof origEquip !== 'function') return
  bot._equipGuardInstalled = true
  bot.equip = function(item, dest, ...args) {
    if (dest === 'hand' && ctx.eatInFlight && item && typeof item.name === 'string' && item.name.endsWith('_sword')) {
      return Promise.resolve()
    }
    return origEquip.call(this, item, dest, ...args)
  }
}

function eatReflex(bot, ctx, state) {
  installEquipGuard(bot, ctx)
  if (ctx.eatInFlight) return false
  if (typeof bot.food !== 'number' || bot.food >= 18) return false
  if (ctx.reflexSwung) return false
  const hostile = state && state.hostile
  if (hostile && hostile.isValid !== false) {
    let d = typeof state.hostile_distance === 'number' ? state.hostile_distance : null
    if (d === null) {
      try { d = bot.entity.position.distanceTo(hostile.position) } catch (_) {}
    }
    if (typeof d === 'number' && d <= fightMod.SWING_RANGE) return false
  }
  if (!bot.inventory || typeof bot.inventory.items !== 'function') return false
  let items
  try { items = bot.inventory.items() } catch (_) { return false }
  if (!Array.isArray(items)) return false
  const foodItem = pickEdible(items)
  if (!foodItem) return false
  if (typeof bot.consume !== 'function') return false

  ctx.eatInFlight = true
  const prevFood = bot.food
  const doEat = async () => {
    try {
      if (typeof bot.equip === 'function') {
        try { await bot.equip(foodItem, 'hand') } catch (_) {}
      }
      await bot.consume()
      console.log(`eat ${foodItem.name} food=${prevFood}`)
    } catch (_) {
    } finally {
      ctx.eatInFlight = false
      try { fightMod.equipGear(bot) } catch (_) {}
    }
  }
  void doEat()
  return true
}

// Breath reflex (idkcraft-0u9): prod 2026-09-28 drowned mid-dig on an
// underwater iron vein (bring dig_buried, 55 s under) — nothing read
// bot.oxygenLevel (0-20, drains ~1/s with the head under water). At <= 10
// with the body in water the tick preempts like flee: stop the dig, drop
// the path, swim up; the order resumes when the lungs are full. The swim
// is always diagonal (jump + forward toward open water): a vertical hold
// pins forever against a wall or under a slope on Paper 26.1.2 (rig: 60
// ticks treading, drowned) — the same wall-rise rejection swim.js
// documents for the planner. A 1-cell lane scan cannot see a dead end, so
// a displacement watch rotates stalled lanes (opposite-first unstick,
// then the remaining lanes, the stalled one forgiven last): pushing one
// face-touch forever is what drowned the first diagonal swimmer too.
// Breathing eases off but never releases early: a head poking out
// mid-rise floats (no input) while the episode keeps the body —
// releasing there flap-cycles with the re-trigger every other tick,
// resets the lane machinery, and lets the order re-dive between swims
// (rig). Release needs full lungs, dry land, or sustained air (the last
// is the stale-readout backstop: 5 ticks of head-out means breathing
// even if the oxygen number never moves).
const BREATH_OXYGEN_LOW = 10
const BREATH_OXYGEN_FULL = 20
const BREATH_SWIM_DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]]
const BREATH_STILL_TICKS = 2 // no displacement this many breath ticks: the lane is a wall
const BREATH_STILL_BLOCKS = 0.2 // swimming clears 2+ blocks/s; tread-bob stays under this
const BREATH_UNSTICK_TICKS = 2 // blind opposite-lane ticks to break a face-touch
const BREATH_AIR_TICKS = 5 // consecutive head-out ticks that prove breathing past a stale readout
const BREATH_COOLDOWN_MS = 4000 // post-release calm: a breaching body lands back under within a tick, and re-triggering at once flap-cycles release/swim forever (rig) — 4 s lets it settle or float while the order gets a window (a re-dive still re-triggers)
function breathReflex(bot, ctx, nowMs = Date.now()) {
  let inWater = false
  try { inWater = !!(bot && bot.entity && bot.entity.isInWater === true) } catch (_) { inWater = false }
  const oxy = (bot && typeof bot.oxygenLevel === 'number') ? bot.oxygenLevel : null
  if (!ctx.breath) {
    if (typeof ctx.breathCoolUntil === 'number' && nowMs < ctx.breathCoolUntil) return false
    if (oxy === null || oxy > BREATH_OXYGEN_LOW || !inWater) return false
    try { if (typeof bot.stopDigging === 'function') bot.stopDigging() } catch (_) { /* nothing in flight */ }
    dropBreathGoal(bot, ctx)
    // Lease: the reflex owns from the trigger tick (pre-drive), so the
    // switch lands before the swim, not mid-episode at tick start.
    try { body.claimBody(bot, ctx, 'breath') } catch (_) { /* lease best-effort */ }
    ctx.breathStill = 0
    ctx.breathUnstick = 0
    ctx.breathDead = null
    ctx.breathLane = -1
    ctx.breathPrevLane = -1
    ctx.breathBlind = false
    ctx.breathPrev = null
    ctx.breathPrev2 = null
    ctx.breathAir = 0
    ctx.breathLastPos = null // baselined on the first drive, not the trigger
    driveBreathSwim(bot, ctx)
    ctx.breath = true
    console.log(`reflex breath oxygen=${oxy}`)
    try { metrics.events.inc({ event: 'reflex_breath' }) } catch (_) { /* metrics best-effort */ }
    return true
  }
  if (oxy === null || oxy >= BREATH_OXYGEN_FULL || !inWater) {
    releaseBreath(bot, ctx, nowMs)
    return false
  }
  if (headInAir(bot)) {
    // Breathing: ease off and float while the episode keeps the body.
    // Floating never stalls, oscillates, or dies — freeze the swim
    // machinery instead of feeding it surface bob.
    ctx.breathAir = (ctx.breathAir || 0) + 1
    freezeBreathSwim(bot, ctx)
    setBreathControl(bot, 'jump', false)
    setBreathControl(bot, 'forward', false)
    if (ctx.breathAir >= BREATH_AIR_TICKS) {
      releaseBreath(bot, ctx, nowMs)
      return false
    }
    dropBreathGoal(bot, ctx)
    return true
  }
  ctx.breathAir = 0
  // Still down: keep the goal dropped (a re-issued dive would fight the
  // rise) and keep swimming, rotating stalled lanes — but coast while
  // rising with air just above the head: full thrust there breaches clean
  // out of the water (!inWater release), lands back under, and re-triggers
  // every other tick, resetting the lane machinery each time (rig).
  // Coasting needs upward momentum: with no input the body sinks, so on
  // the ground (or falling) inside the band the swim keeps thrusting —
  // coasting there would pin the body on a 2-deep floor forever (revmux
  // 01 body-1).
  dropBreathGoal(bot, ctx)
  if (breathSurfaceNear(bot) && breathRising(bot)) {
    freezeBreathSwim(bot, ctx)
    setBreathControl(bot, 'jump', false)
    setBreathControl(bot, 'forward', false)
    return true
  }
  driveBreathSwim(bot, ctx)
  return true
}

// Upward momentum off the ground: physics velocity, fail-safe toward
// thrust when the readout is missing (fake bots swim, never coast).
function breathRising(bot) {
  try {
    const e = bot && bot.entity
    if (!e || e.onGround === true) return false
    const v = e.velocity
    return !!v && typeof v.y === 'number' && v.y > 0
  } catch (_) { return false }
}

// Air two above the feet (= above the head): the surface or a pocket.
function breathSurfaceNear(bot) {
  try {
    const p = bot && bot.entity && bot.entity.position
    if (!p || typeof p.x !== 'number' || typeof bot.blockAt !== 'function') return false
    return breathIsAir(breathCellName(bot, Math.floor(p.x), Math.floor(p.y) + 2, Math.floor(p.z)))
  } catch (_) { return false }
}

// Freeze the swim machinery on drift/float ticks: bobbing is neither
// progress nor a stall, and must not rotate lanes or trip oscillation.
function freezeBreathSwim(bot, ctx) {
  ctx.breathStill = 0
  ctx.breathLastPos = breathPos(bot)
  ctx.breathPrev2 = null
  ctx.breathPrev = ctx.breathLastPos
}

function releaseBreath(bot, ctx, nowMs = Date.now()) {
  ctx.breath = false
  ctx.breathCoolUntil = nowMs + BREATH_COOLDOWN_MS
  ctx.breathStill = 0
  ctx.breathUnstick = 0
  ctx.breathDead = null
  ctx.breathLane = -1
  ctx.breathPrevLane = -1
  ctx.breathBlind = false
  ctx.breathPrev = null
  ctx.breathPrev2 = null
  ctx.breathAir = 0
  ctx.breathLastPos = null
  setBreathControl(bot, 'jump', false)
  setBreathControl(bot, 'forward', false)
}

function breathPos(bot) {
  try {
    const p = bot && bot.entity && bot.entity.position
    if (!p || typeof p.x !== 'number') return null
    return { x: p.x, y: p.y, z: p.z }
  } catch (_) { return null }
}

function breathMoved(a, b) {
  if (!a || !b) return true // no baseline: not a stall
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y) + Math.abs(a.z - b.z) >= BREATH_STILL_BLOCKS
}

function breathSamePos(a, b) {
  if (!a || !b) return false
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y) + Math.abs(a.z - b.z) < BREATH_STILL_BLOCKS
}

// Lane switch with history: the oscillation kill needs the previous lane.
function setBreathLane(ctx, idx) {
  if (idx !== ctx.breathLane) {
    ctx.breathPrevLane = ctx.breathLane
    ctx.breathLane = idx
  }
}

function setBreathControl(bot, name, val) {
  try { if (typeof bot.setControlState === 'function') bot.setControlState(name, val) } catch (_) { /* body best-effort */ }
}

function breathCellName(bot, x, y, z) {
  try {
    if (!bot || typeof bot.blockAt !== 'function') return null
    const b = bot.blockAt(new Vec3(x, y, z))
    return (b && typeof b.name === 'string') ? b.name : null
  } catch (_) { return null }
}

function breathIsWater(name) {
  return name === 'water' || name === 'bubble_column' ||
    name === 'kelp' || name === 'kelp_plant' || name === 'seagrass' || name === 'tall_seagrass'
}

function breathIsAir(name) {
  return name === 'air' || name === 'cave_air' || name === 'void_air'
}

// Open diagonal-rise lane: head-side water with water or air above it
// (air-above first: that lane breaks the surface). Last resort is any
// head-side water even under a ceiling — swimming out from under an
// overhang beats treading under it. Null when walled in at head level.
// dead skips lanes that already stalled this episode.
function breathSwimDir(bot, dead) {
  try {
    const p = bot && bot.entity && bot.entity.position
    if (!p || typeof p.x !== 'number') return null
    const fx = Math.floor(p.x)
    const fy = Math.floor(p.y)
    const fz = Math.floor(p.z)
    let wetLane = null
    let flatLane = null
    for (let i = 0; i < BREATH_SWIM_DIRS.length; i++) {
      if (dead instanceof Set && dead.has(i)) continue
      const [dx, dz] = BREATH_SWIM_DIRS[i]
      if (!breathIsWater(breathCellName(bot, fx + dx, fy + 1, fz + dz))) continue
      if (!flatLane) flatLane = { dx, dz, idx: i }
      const above = breathCellName(bot, fx + dx, fy + 2, fz + dz)
      if (breathIsAir(above)) return { dx, dz, idx: i }
      if (!wetLane && breathIsWater(above)) wetLane = { dx, dz, idx: i }
    }
    return wetLane || flatLane
  } catch (_) { return null }
}

// DIRS pairs opposites adjacently (E/W, N/S): idx^1 is the way back out.
function breathOpposite(idx) {
  return breathLaneByIdx(idx ^ 1)
}

function breathLaneByIdx(idx) {
  const d = BREATH_SWIM_DIRS[idx]
  return d ? { dx: d[0], dz: d[1], idx } : null
}

function driveBreathLane(bot, lane) {
  if (lane) {
    try {
      if (typeof bot.look === 'function') bot.look(Math.atan2(-lane.dx, -lane.dz), 0)
    } catch (_) { /* facing best-effort */ }
    setBreathControl(bot, 'forward', true)
  } else {
    setBreathControl(bot, 'forward', false)
  }
  setBreathControl(bot, 'jump', true)
}

function driveBreathSwim(bot, ctx) {
  const now = breathPos(bot)
  const moved = breathMoved(ctx.breathLastPos, now)
  if (moved) {
    ctx.breathStill = 0
    ctx.breathLastPos = now
  } else {
    ctx.breathStill = (ctx.breathStill || 0) + 1
  }
  // Oscillation: moved last tick but back at the spot of two ticks ago —
  // two lanes pointing at each other (rig: ±z ping-pong in a 2-cell
  // channel, net zero while "moving"). Kill the pair and scan the rest;
  // no blind unstick — the body is moving freely, not face-touching.
  // Static bots skip this (the stall branch below owns face-touches).
  if (moved && breathSamePos(now, ctx.breathPrev2) && ctx.breathLane >= 0) {
    if (!(ctx.breathDead instanceof Set)) ctx.breathDead = new Set()
    ctx.breathDead.add(ctx.breathLane)
    if (ctx.breathPrevLane >= 0) ctx.breathDead.add(ctx.breathPrevLane)
    ctx.breathStill = 0
    ctx.breathLastPos = now
    ctx.breathUnstick = 0
    ctx.breathBlind = false
    ctx.breathPrev2 = null
    ctx.breathPrev = now
    let lane = breathSwimDir(bot, ctx.breathDead)
    if (!lane && ctx.breathDead.size > 0) {
      ctx.breathDead = null // every lane dead: forgive and re-scan
      lane = breathSwimDir(bot, null)
    }
    setBreathLane(ctx, lane ? lane.idx : -1)
    driveBreathLane(bot, lane)
    return
  }
  ctx.breathPrev2 = ctx.breathPrev
  ctx.breathPrev = now
  // Blind unstick ticks: keep driving the away lane without scanning
  // (the scan still reads the wall lane open — that is why we stalled).
  if ((ctx.breathUnstick || 0) > 0) {
    ctx.breathUnstick--
    const away = breathLaneByIdx(ctx.breathLane)
    driveBreathLane(bot, away)
    return
  }
  if ((ctx.breathStill || 0) >= BREATH_STILL_TICKS && ctx.breathLane >= 0) {
    if (!(ctx.breathDead instanceof Set)) ctx.breathDead = new Set()
    ctx.breathDead.add(ctx.breathLane)
    ctx.breathStill = 0
    ctx.breathLastPos = now
    if (!ctx.breathBlind) {
      // Stalled pushing a scanned lane: break the face-touch with a blind
      // opposite run before re-scanning without the dead lane.
      const away = breathOpposite(ctx.breathLane)
      if (away) {
        setBreathLane(ctx, away.idx)
        ctx.breathBlind = true
        ctx.breathUnstick = BREATH_UNSTICK_TICKS - 1 // this tick drives the first one
            driveBreathLane(bot, away)
        return
      }
    }
    // The blind run stalled too (walled behind as well): give up on the
    // unstick and scan the remaining lanes instead of ping-ponging.
    ctx.breathBlind = false
  }
  // Sticky lane: keep driving the current lane while it stays open.
  // Re-scanning every tick flip-flops between adjacent cells that point
  // at each other (rig: ±z ping-pong under a ceiling, net zero, drowning
  // while "moving"). The stall watch still rotates dead lanes.
  let lane = null
  const cur = ctx.breathLane
  if (cur >= 0 && !(ctx.breathDead instanceof Set && ctx.breathDead.has(cur)) && breathLaneOpen(bot, cur)) {
    lane = breathLaneByIdx(cur)
  } else {
    lane = breathSwimDir(bot, ctx.breathDead)
    if (!lane && ctx.breathDead instanceof Set && ctx.breathDead.size > 0) {
      ctx.breathDead = null // every lane dead: forgive and re-scan
      lane = breathSwimDir(bot, null)
    }
  }
  setBreathLane(ctx, lane ? lane.idx : -1)
  ctx.breathBlind = false
  driveBreathLane(bot, lane)
}

// Head-side water on lane idx (above ignored: a lane stays sticky even
// flat — swimming out from under a ceiling beats re-scanning).
function breathLaneOpen(bot, idx) {
  try {
    const d = BREATH_SWIM_DIRS[idx]
    const p = bot && bot.entity && bot.entity.position
    if (!d || !p || typeof p.x !== 'number') return false
    return breathIsWater(breathCellName(bot, Math.floor(p.x) + d[0], Math.floor(p.y) + 1, Math.floor(p.z) + d[1]))
  } catch (_) { return false }
}


// Drop the live path without pathfinder.stop(): its latch would swallow
// the resume goal issued on the release tick (gather pattern, util.js).
function dropBreathGoal(bot, ctx) {
  try {
    if (bot.pathfinder && bot.pathfinder.goal && typeof bot.pathfinder.setGoal === 'function') bot.pathfinder.setGoal(null)
  } catch (_) { /* body best-effort */ }
  ctx.lastGoalKey = ''
}

function headInAir(bot) {
  try {
    const p = bot && bot.entity && bot.entity.position
    if (!p || typeof bot.blockAt !== 'function') return false
    const b = bot.blockAt(new Vec3(Math.floor(p.x), Math.floor(p.y) + 1, Math.floor(p.z)))
    return !!b && (b.name === 'air' || b.name === 'cave_air' || b.name === 'void_air')
  } catch (_) { return false }
}

// Water abort (idkcraft-n9ta): rig A drowned twice mid-crossing on the
// site<->spawn-quarry runs (nearest=drowned, one body found submerged).
// A bot swimming deep water has no footing: it cannot outswim a drowned,
// cannot reach a trident thrower, and melee trades 1-for-3 while treading
// water. On threat (a water mob or any hostile already in the water within
// range, or fresh damage from anything unseen) the crossing suspends and
// the bot beaches at the nearest landable shore — the entry shore when it
// is closer — then the leg resumes. Wading (footing below) fights
// normally, and dry-land threats never trigger: a zombie ashore while the
// bot swims past is not its fight. Episode latch like breath, but the
// latch is the water-entry guard: it holds until the threat is gone even
// ashore (releasing on landfall with the drowned still adjacent would send
// the bot back in unprotected under a fresh cooldown — the revmux 01
// major). Ashore ticks yield to normal dispatch (fight or flee on land
// work there) without releasing; re-entering while the threat persists
// re-drives immediately, never after a gap. Release on threat gone, the
// stuck menu appearing (it owns the body then), or give-up; a short
// cooldown paces the next episode. Rides the tick's baseline owner like
// fleeReflex (a keyed pathfinder goal needs no lease edge); breath still
// preempts (oxygen kills faster) and hands off here on full lungs.
const ABORT_RANGE = 6
const ABORT_CLEAR_DIST = 8 // release band: threat must leave past this (no mid-water flap)
const ABORT_HURT_MS = 5000 // fresh-damage window (mirrors index.js HURT_FRESH_MS; this module cannot import index)
const ABORT_COOLDOWN_MS = 15000 // post-release calm: paces episodes, not ticks inside one
const ABORT_SCAN_MS = 5000 // shore re-scan throttle (mirrors shelter-dry)
const ABORT_STALL_MS = 15000 // no-approach -> skip the shore (mirrors shelter-dry)
const ABORT_MAX_SKIP = 3 // skipped shores -> give up, release to the leg
const ABORT_STALE_MS = 60000 // latch without a main-path drive tick this long is a mode-switch leftover: GC it
const ABORT_SHORE_MEMORY_MS = 600000 // failed shores stay skipped across episodes for this long (revmux 01 minor)
const ABORT_DY_LO = -1 // waterline stances only: wadable or a +1 exit;
const ABORT_DY_HI = 1 // deeper is caves, higher is h04-unexitable walls
const ABORT_INLAND_D = 5 // inland-first detour cap: the abort swim stays short
const ABORT_WATER_MOBS = new Set(['drowned', 'guardian', 'elder_guardian'])
const ABORT_WETFLORA = new Set(['kelp', 'kelp_plant', 'seagrass', 'tall_seagrass', 'bubble_column'])
function abortReflex(bot, ctx, state = null, nowMs = Date.now()) {
  let inWater = false
  try { inWater = !!(bot && bot.entity && bot.entity.isInWater === true) } catch (_) { inWater = false }
  if (!inWater) {
    try { trackAbortDry(bot, ctx) } catch (_) { /* entry shore best-effort */ }
  }
  if (ctx.abort) {
    // Stale latch (no main-path drive tick for a minute — the mode moved
    // on while latched): GC without a cooldown so a live threat now
    // re-triggers fresh below.
    if (typeof ctx.abort.touchedAt === 'number' && nowMs - ctx.abort.touchedAt > ABORT_STALE_MS) {
      ctx.abort = null
      dropAbortGoal(bot, ctx)
    } else {
      ctx.abort.touchedAt = nowMs
      return driveAbort(bot, ctx, state, nowMs, inWater)
    }
  }
  if (!inWater) return false
  if (ctx.breath) return false
  if (ctx.stuck || ctx.recovery) return false
  if (typeof ctx.abortCoolUntil === 'number' && nowMs < ctx.abortCoolUntil) return false
  if (abortFooting(bot)) return false
  if (!abortThreat(bot, ctx, state, nowMs, ABORT_RANGE)) return false
  const skip = abortRememberedSkips(ctx, nowMs)
  const target = pickAbortShore(bot, ctx, skip)
  if (!target) return false
  try { if (typeof bot.stopDigging === 'function') bot.stopDigging() } catch (_) { /* nothing in flight */ }
  dropAbortGoal(bot, ctx)
  ctx.abort = { x: target.x, y: target.y, z: target.z, skip, scanAt: nowMs, best: undefined, progressAt: nowMs, touchedAt: nowMs }
  driveAbortGoal(bot, ctx)
  console.log(`reflex abort-shore threat=${abortThreatName(state)} target=${target.x},${target.y},${target.z}`)
  try { metrics.events.inc({ event: 'reflex_abort' }) } catch (_) { /* metrics best-effort */ }
  return true
}

function driveAbort(bot, ctx, state, nowMs, inWater) {
  const a = ctx.abort
  if (!abortThreat(bot, ctx, state, nowMs, ABORT_CLEAR_DIST)) {
    releaseAbort(bot, ctx, nowMs)
    return false
  }
  if (ctx.stuck || ctx.recovery) {
    releaseAbort(bot, ctx, nowMs)
    return false
  }
  if (!a || typeof a.x !== 'number') {
    releaseAbort(bot, ctx, nowMs)
    return false
  }
  if (!inWater || abortFooting(bot)) return false // ashore hold: normal dispatch (fight/flee) owns the tick, latch kept
  try {
    const bp = bot && bot.entity && bot.entity.position
    if (bp && typeof bp.x === 'number') {
      const dist = Math.hypot(bp.x - (a.x + 0.5), bp.z - (a.z + 0.5))
      if (dist < (a.best === undefined ? Infinity : a.best) - 0.5) {
        a.best = dist
        a.progressAt = nowMs
      } else if (nowMs - (a.progressAt || nowMs) > ABORT_STALL_MS) {
        a.skip.push({ x: a.x, z: a.z })
        a.x = null
        a.scanAt = 0
      }
    }
  } catch (_) { /* progress best-effort */ }
  if ((a.x === null || a.x === undefined) && a.skip.length < ABORT_MAX_SKIP && !(nowMs - (a.scanAt || 0) < ABORT_SCAN_MS)) {
    a.scanAt = nowMs
    let next = null
    try { next = pickAbortShore(bot, ctx, a.skip) } catch (_) { next = null }
    if (next) {
      a.x = next.x
      a.y = next.y
      a.z = next.z
      a.best = undefined
      a.progressAt = nowMs
      try { ctx.lastGoalKey = '' } catch (_) { /* re-issue below */ }
    } else {
      a.scanEmpty = true
    }
  }
  if (a.x === null || a.x === undefined) {
    // Nothing more to swim to (skips exhausted, or the fresh scan is
    // empty): release so the leg advances, and the cooldown re-tries from
    // further along. A pending throttled scan holds briefly instead.
    if (a.skip.length >= ABORT_MAX_SKIP || a.scanEmpty) {
      try { console.log('reflex abort-shore give-up') } catch (_) { /* log best-effort */ }
      releaseAbort(bot, ctx, nowMs)
      return false
    }
    return true // throttled re-scan pending: hold the water, keep the body
  }
  driveAbortGoal(bot, ctx)
  return true
}

function driveAbortGoal(bot, ctx) {
  const a = ctx.abort
  if (!a || typeof a.x !== 'number') return
  const key = `abort-shore:${a.x},${a.z}`
  let moving = false
  try { moving = !!(bot.pathfinder && typeof bot.pathfinder.isMoving === 'function' && bot.pathfinder.isMoving()) } catch (_) { /* stationary default */ }
  if (key !== ctx.lastGoalKey || !moving) {
    try {
      bot.pathfinder.setGoal(new goals.GoalNear(a.x + 0.5, a.y, a.z + 0.5, 1), false)
      ctx.lastGoalKey = key
    } catch (_) { /* retry next tick */ }
  }
}

function releaseAbort(bot, ctx, nowMs = Date.now()) {
  // Failed shores stay skipped for a while (revmux 01 minor): the next
  // episode at this ford tries a different beach instead of repeating the
  // same entry. The driven target is not remembered — it never failed.
  try {
    const skips = ctx.abort && Array.isArray(ctx.abort.skip) ? ctx.abort.skip : []
    if (skips.length > 0) {
      const mem = Array.isArray(ctx.abortShoreMemory) ? ctx.abortShoreMemory : []
      for (const s of skips) {
        if (s && typeof s.x === 'number' && !mem.some((m) => m && m.x === s.x && m.z === s.z)) {
          mem.push({ x: s.x, z: s.z, until: nowMs + ABORT_SHORE_MEMORY_MS })
        }
      }
      ctx.abortShoreMemory = mem.slice(-20)
    }
  } catch (_) { /* memory best-effort */ }
  ctx.abort = null
  ctx.abortCoolUntil = nowMs + ABORT_COOLDOWN_MS
  dropAbortGoal(bot, ctx)
}

function abortRememberedSkips(ctx, nowMs) {
  try {
    const mem = Array.isArray(ctx.abortShoreMemory) ? ctx.abortShoreMemory : []
    const live = mem.filter((m) => m && typeof m.x === 'number' && typeof m.until === 'number' && nowMs < m.until)
    ctx.abortShoreMemory = live.slice(-20)
    return live.map((m) => ({ x: m.x, z: m.z }))
  } catch (_) { return [] }
}

function dropAbortGoal(bot, ctx) {
  try {
    if (bot.pathfinder && bot.pathfinder.goal && typeof bot.pathfinder.setGoal === 'function') bot.pathfinder.setGoal(null)
  } catch (_) { /* body best-effort */ }
  ctx.lastGoalKey = ''
}

// Footing: a solid cube directly below the feet (wading). One cell is
// enough: flora at the feet is walk-through, so the cell below is the bed
// whenever the body stands. Unknown reads swimming (fail toward the abort
// under threat; the trigger still needs a target).
function abortFooting(bot) {
  try {
    const p = bot && bot.entity && bot.entity.position
    if (!p || typeof p.x !== 'number' || typeof bot.blockAt !== 'function') return false
    const b = bot.blockAt(new Vec3(Math.floor(p.x), Math.floor(p.y) - 1, Math.floor(p.z)))
    return !!b && b.boundingBox === 'block'
  } catch (_) { return false }
}

// Entry shore: the last grounded dry cell (updated while dry, so at the
// trigger it is the waterline the swim started from). Grounded only: an
// airborne apex over water must not become the shore.
function trackAbortDry(bot, ctx) {
  const e = bot && bot.entity
  const p = e && e.position
  if (!p || typeof p.x !== 'number' || e.onGround !== true) return
  ctx.waterLastDry = { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) }
}

// Threat at range: fresh damage (a trident thrower out of sight counts) or
// a hostile that is a water mob or itself in the water. A dry-land hostile
// while swimming past is not a reason to beach.
function abortThreat(bot, ctx, state, nowMs, range) {
  try {
    if (typeof ctx.lastHurtAt === 'number' && nowMs - ctx.lastHurtAt < ABORT_HURT_MS) return true
  } catch (_) { /* stamp best-effort */ }
  const hostile = state && state.hostile
  const d = state && typeof state.hostile_distance === 'number' ? state.hostile_distance : null
  if (!hostile || hostile.isValid === false || d === null || d > range) return false
  const name = hostile.name || ''
  if (ABORT_WATER_MOBS.has(name)) return true
  try {
    const p = hostile.position
    if (!p || typeof p.x !== 'number' || typeof bot.blockAt !== 'function') return false
    const b = bot.blockAt(new Vec3(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)))
    const n = b && b.name
    return typeof n === 'string' && (n.includes('water') || ABORT_WETFLORA.has(n))
  } catch (_) { return false }
}

function abortThreatName(state) {
  try {
    const h = state && state.hostile
    if (h && h.isValid !== false) return `${h.name || 'mob'}@${state.hostile_distance}`
  } catch (_) { /* name best-effort */ }
  return 'hurt'
}

// Inland stance within ABORT_INLAND_D first (out of drowned melee from
// the water; rig v9 beached at the waterline and fought from the
// shallows). Then closer of the entry shore (when still a waterline
// stance) and the nearestDry scan, skips excluded; entry wins ties. Null
// when nothing stands (open water past scan range and no entry): the
// crossing swims on with melee, i.e. current behavior.
function pickAbortShore(bot, ctx, skip) {
  let home = null
  try { home = require('./behaviours/home') } catch (_) { return null } // lazy: home<->goal cycle (fleeReflex precedent)
  if (!home || typeof home.nearestDry !== 'function' || typeof home.dryStanceAt !== 'function') return null
  const skipped = (c) => Array.isArray(skip) && skip.some((s) => s && s.x === c.x && s.z === c.z)
  if (typeof home.nearestInlandDry === 'function') {
    try {
      const inland = home.nearestInlandDry(bot, Array.isArray(skip) ? skip : [], ABORT_DY_LO, ABORT_DY_HI, ABORT_INLAND_D)
      if (inland && !skipped(inland)) return inland
    } catch (_) { /* fall through to entry/scan */ }
  }
  let entry = null
  try {
    const ld = ctx.waterLastDry
    const p = bot && bot.entity && bot.entity.position
    if (ld && typeof ld.x === 'number' && p && typeof p.x === 'number') {
      const dy = ld.y - Math.floor(p.y)
      if (dy >= ABORT_DY_LO && dy <= ABORT_DY_HI && !skipped(ld) && home.dryStanceAt(bot, ld.x, ld.y, ld.z)) entry = ld
    }
  } catch (_) { entry = null }
  let scan = null
  try {
    scan = home.nearestDry(bot, Array.isArray(skip) ? skip : [], ABORT_DY_LO, ABORT_DY_HI)
    if (scan && skipped(scan)) scan = null
  } catch (_) { scan = null }
  if (!entry) return scan
  if (!scan) return entry
  try {
    const p = bot.entity.position
    const de = Math.hypot(p.x - (entry.x + 0.5), p.z - (entry.z + 0.5))
    const ds = Math.hypot(p.x - (scan.x + 0.5), p.z - (scan.z + 0.5))
    return ds < de ? scan : entry
  } catch (_) { return entry }
}

// Melee reflex (3nt.13): the arm is not the body. A hostile already
// within swing reach is hit every tick regardless of the brain answer —
// the same every-tick seam as scout. Runs on every tick path that has (or
// can cheaply build) hostile facts, including parked and nobody-online
// ticks. Logs at most one line per target; fight.js skips its own swing
// via ctx.reflexSwung so the rate stays one swing per tick.
function meleeReflex(bot, ctx, state) {
  // Every tick path that has facts passes here, so vitals are exported here too.
  metrics.setVitals(state)
  // Same seam for the death line's hostile snapshot (see deathLine): the
  // killer is often gone at the death tick (exploded creeper), so the last
  // tick's scan is the truthful one.
  try { ctx.lastHostileSnap = snapHostiles(bot) } catch (_) { /* snapshot best-effort */ }
  const hostile = state && state.hostile
  if (!hostile || hostile.isValid === false) return false
  let d
  try {
    d = bot.entity.position.distanceTo(hostile.position)
  } catch (_) { return false }
  if (typeof d !== 'number' || d > fightMod.SWING_RANGE) return false
  if (ctx.reflexTargetId !== hostile.id) {
    ctx.reflexTargetId = hostile.id
    try { fightMod.equipGear(bot) } catch (_) { /* fists are fine */ }
    console.log(`reflex swing ${hostile.name || 'mob'}`)
  }
  try { fightMod.swing(bot, hostile) } catch (_) { /* mock bots may lack lookAt/attack */ }
  metrics.events.inc({ event: 'reflex_swing' })
  ctx.reflexSwung = true // any target: the arm swung once this tick
  return true
}

// Creeper flee reflex (c2u): creepers are the one hostile the brain never
// sees (isFightTarget excludes them, so no hostile fact and no hard route),
// yet they kill. Within CREEPER_FLEE_RANGE the body walks away from the
// nearest creeper — an FSM rule, never an attack (hitting one near the
// player explodes it next to the player). Returns the creeper distance, or
// false when none is close.
// ponytail: no isHard 'creeper-near' case — the reflex already moves the
// body, so asking the model follow-vs-flee would add a wire case for zero gain.
const CREEPER_FLEE_RANGE = 6
const CREEPER_FLEE_DIST = 6
function fleeReflex(bot, ctx) {
  // rqdj: a creeper outside a closed house cannot reach us; running out is the danger.
  // inShelter alone is not enough (home.js sets it on the open-air night pillar
  // too), so require the body to be inside the home box.
  if (ctx.inShelter && ctx.home && require('./behaviours/home').isInside(bot, ctx.home)) return false // deferred: home loads reflexes
  let creeper = null
  try { creeper = findCreeper(bot, CREEPER_FLEE_RANGE) } catch (_) { return false }
  if (!creeper) { ctx.fleeTargetId = null; return false }
  const bp = bot.entity && bot.entity.position
  if (!bp) return false
  let d
  try { d = bp.distanceTo(creeper.position) } catch (_) { return false }
  if (typeof d !== 'number') return false
  let dx = bp.x - creeper.position.x
  let dz = bp.z - creeper.position.z
  if (dx === 0 && dz === 0) dx = 1
  const len = Math.hypot(dx, dz)
  const nx = bp.x + (dx / len) * CREEPER_FLEE_DIST
  const nz = bp.z + (dz / len) * CREEPER_FLEE_DIST
  const key = `flee:${creeper.id}`
  let moving = false
  try { moving = !!(bot.pathfinder && typeof bot.pathfinder.isMoving === 'function' && bot.pathfinder.isMoving()) } catch (_) { /* stationary default */ }
  // Re-issue on a new creeper or a stalled executor (the creeper chases, so a
  // finished away-goal is stale); never tear down a running climb-out.
  if (key !== ctx.lastGoalKey || !moving) {
    bot.pathfinder.setGoal(new goals.GoalNear(nx, bp.y, nz, 1), false)
    ctx.lastGoalKey = key
  }
  if (ctx.fleeTargetId !== creeper.id) {
    ctx.fleeTargetId = creeper.id
    console.log(`reflex flee creeper dist=${d.toFixed(1)}`)
  }
  return d
}

module.exports = { eatReflex, EDIBLE_FOODS, RAW_FALLBACK, pickEdible, breathReflex, BREATH_OXYGEN_LOW, BREATH_OXYGEN_FULL, meleeReflex, fleeReflex, installEquipGuard, abortReflex, ABORT_RANGE, ABORT_CLEAR_DIST, ABORT_COOLDOWN_MS }
