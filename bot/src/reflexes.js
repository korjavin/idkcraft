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

// Eat reflex (3nt.22): natural regen needs food >= 18. Consumes the first
// edible item from inventory on the every-tick seam when food < 18 and no
// hostile is within swing reach. Equips food to hand, consumes, then
// restores gear via fightMod.equipGear.
const EDIBLE_FOODS = new Set([
  'bread',
  'cooked_beef',
  'cooked_porkchop',
  'cooked_chicken',
  'apple',
  'carrot',
  'baked_potato',
])

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
  const foodItem = items.find((i) => i && typeof i.name === 'string' && EDIBLE_FOODS.has(i.name))
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

module.exports = { eatReflex, EDIBLE_FOODS, breathReflex, BREATH_OXYGEN_LOW, BREATH_OXYGEN_FULL, meleeReflex, fleeReflex, installEquipGuard }
