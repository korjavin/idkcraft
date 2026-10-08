'use strict'

// Water abort (idkcraft-n9ta): rig A drowned twice mid-crossing
// (nearest=drowned, one body found submerged). A swimmer under drowned
// fire beaches at the nearest landable shore — entry shore on ties —
// then resumes; wading fights normally, dry-land threats never trigger.

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const { abortReflex, ABORT_RANGE, ABORT_CLEAR_DIST, ABORT_COOLDOWN_MS } = require('../src/reflexes')
const home = require('../src/behaviours/home')

function pos(x, y, z) {
  const p = {
    x, y, z,
    distanceTo: (q) => Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z),
    clone() { return pos(p.x, p.y, p.z) },
    floored() { return pos(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)) },
    offset(dx, dy, dz) { return pos(p.x + dx, p.y + dy, p.z + dz) },
  }
  return p
}

const SOLID = new Set(['stone', 'dirt', 'sand', 'grass_block', 'gravel'])

// World view: cells maps 'x,y,z' -> block name (bbox derived); the bot
// floats at bodyPos. Pool around the origin, shores east (+x) and west.
function swimCells() {
  const cells = {}
  for (let x = -2; x <= 2; x++) {
    for (let z = -2; z <= 2; z++) {
      cells[`${x},61,${z}`] = 'water'
      cells[`${x},62,${z}`] = 'water'
      cells[`${x},60,${z}`] = 'stone'
    }
  }
  // East shore stance (3,62,0); west entry stance (-3,62,0).
  cells['3,61,0'] = 'dirt'
  cells['3,62,0'] = 'air'
  cells['3,63,0'] = 'air'
  cells['-3,61,0'] = 'sand'
  cells['-3,62,0'] = 'air'
  cells['-3,63,0'] = 'air'
  return cells
}

// East shore two deep: (3,62,0) waterline, (4,62,0) inland (no wet
// 4-neighbour). Unset cells read null (wet), so the inland neighbours
// are set air explicitly; their floors stay unset (not stances).
function inlandCells() {
  const cells = swimCells()
  cells['4,61,0'] = 'dirt'
  cells['4,62,0'] = 'air'
  cells['4,63,0'] = 'air'
  cells['5,62,0'] = 'air'
  cells['4,62,1'] = 'air'
  cells['4,62,-1'] = 'air'
  return cells
}

// Inland stance at x=6: past the ABORT_INLAND_D cap, so the waterline
// still wins. x=4 stays water-adjacent ((5,62,0) is x=6's dry neighbour
// with no floor, not a stance).
function farInlandCells() {
  const cells = swimCells()
  cells['6,61,0'] = 'dirt'
  cells['6,62,0'] = 'air'
  cells['6,63,0'] = 'air'
  cells['5,62,0'] = 'air'
  cells['7,62,0'] = 'air'
  cells['6,62,1'] = 'air'
  cells['6,62,-1'] = 'air'
  return cells
}

function swimBot({ cells = swimCells(), bodyPos = pos(0.5, 62, 0.5), inWater = true, onGround = false, moving = false } = {}) {
  const calls = { stopDigging: 0, setGoal: 0, goals: [] }
  const bot = {
    calls,
    username: 'IdkBot',
    players: {},
    entities: {},
    health: 20,
    food: 20,
    entity: { position: bodyPos, isInWater: inWater, onGround },
    pathfinder: {
      goal: null,
      setGoal: (g) => { calls.setGoal++; calls.goals.push(g); bot.pathfinder.goal = g },
      stop: () => {},
      isMoving: () => moving,
      setMovements: () => {},
    },
    setControlState: () => {},
    clearControlStates: () => {},
    blockAt: (p) => {
      const n = cells[`${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`]
      if (!n) return null
      return { name: n, boundingBox: SOLID.has(n) ? 'block' : 'empty', position: pos(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)) }
    },
    stopDigging: () => { calls.stopDigging++ },
    chat: () => {},
  }
  return bot
}

function hostileAt(name, x, y, z, dist) {
  const h = { id: 7, name, isValid: true, position: pos(x, y, z) }
  return { hostile: h, hostile_distance: dist }
}

const T0 = 1000000

describe('abortReflex trigger', () => {
  it('ignores a dry bot with a drowned adjacent (tracks the entry shore)', () => {
    const bot = swimBot({ bodyPos: pos(-3.5, 62, -0.5), inWater: false, onGround: true })
    const ctx = {}
    const state = hostileAt('drowned', -3, 61, 3, 3)
    assert.equal(abortReflex(bot, ctx, state, T0), false)
    assert.deepEqual(ctx.waterLastDry, { x: -4, y: 62, z: -1 })
    assert.equal(ctx.abort, undefined)
  })

  it('ignores a swimmer with no threat', () => {
    const bot = swimBot()
    assert.equal(abortReflex(bot, {}, null, T0), false)
    assert.equal(abortReflex(bot, {}, { hostile: null, hostile_distance: null }, T0), false)
    assert.equal(bot.calls.setGoal, 0)
  })

  it('wading with footing fights normally (no abort)', () => {
    const cells = swimCells()
    cells['0,61,0'] = 'sand' // bed directly below: footing
    const bot = swimBot({ cells })
    const state = hostileAt('drowned', 2, 61, 0, 2.5)
    assert.equal(abortReflex(bot, {}, state, T0), false)
    assert.equal(bot.calls.setGoal, 0)
  })

  it('a dry-land hostile while swimming past is not its fight', () => {
    const bot = swimBot()
    const cells = bot.blockAt
    bot.blockAt = (p) => (Math.floor(p.x) === 2 && Math.floor(p.y) === 61 ? { name: 'grass_block', boundingBox: 'block' } : cells(p))
    const state = hostileAt('zombie', 2, 61, 0, 3)
    assert.equal(abortReflex(bot, {}, state, T0), false)
  })

  it('a non-drowned hostile already in the water triggers', () => {
    const bot = swimBot()
    const state = hostileAt('zombie', 2, 61, 0, 3)
    const ctx = { lastGoalKey: 'castlefetch-site:1,2' }
    bot.pathfinder.goal = { fake: 'leg-goal' }
    assert.equal(abortReflex(bot, ctx, state, T0), true)
    assert.ok(ctx.abort)
  })

  it('fresh damage alone triggers (the trident thrower out of sight)', () => {
    const bot = swimBot()
    const ctx = { lastHurtAt: T0 - 1000 }
    assert.equal(abortReflex(bot, ctx, null, T0), true)
    assert.ok(ctx.abort)
  })

  it('stale damage does not trigger', () => {
    const bot = swimBot()
    const ctx = { lastHurtAt: T0 - 6000 }
    assert.equal(abortReflex(bot, ctx, null, T0), false)
  })

  it('breath and the stuck menu preempt the trigger', () => {
    const bot = swimBot()
    const state = hostileAt('drowned', 2, 61, 0, 2.5)
    assert.equal(abortReflex(bot, { breath: true }, state, T0), false)
    assert.equal(abortReflex(bot, { stuck: { by: 'test' } }, state, T0), false)
    assert.equal(abortReflex(bot, { recovery: { action: 'x' } }, state, T0), false)
  })

  it('open water with no entry and no scanned shore swims on', () => {
    const bot = swimBot({ cells: { '0,61,0': 'water', '0,62,0': 'water' } })
    const state = hostileAt('drowned', 2, 61, 0, 2.5)
    assert.equal(abortReflex(bot, {}, state, T0), false)
  })
})

describe('abortReflex shore pick', () => {
  it('entry shore wins ties, leg goal drops, dig stops', () => {
    const bot = swimBot() // entry (-3,62,0) and scan (3,62,0) equidistant
    bot.targetDigBlock = { name: 'stone' }
    bot.pathfinder.goal = { fake: 'leg-goal' }
    const ctx = { lastGoalKey: 'castlefetch-site:1,2', waterLastDry: { x: -3, y: 62, z: 0 } }
    const state = hostileAt('drowned', 2, 61, 0, 2.5)
    assert.equal(abortReflex(bot, ctx, state, T0), true)
    assert.equal(bot.calls.stopDigging, 1)
    assert.deepEqual({ x: ctx.abort.x, y: ctx.abort.y, z: ctx.abort.z }, { x: -3, y: 62, z: 0 })
    assert.equal(ctx.lastGoalKey, 'abort-shore:-3,0')
    const g = bot.calls.goals[bot.calls.goals.length - 1]
    assert.equal(g.x, -3) // GoalNear floors the +0.5 cell center
    assert.equal(g.y, 62)
  })

  it('a closer scanned shore beats a far entry', () => {
    const cells = swimCells()
    delete cells['-3,61,0']
    delete cells['-3,62,0']
    delete cells['-3,63,0']
    cells['-8,61,0'] = 'sand'
    cells['-8,62,0'] = 'air'
    cells['-8,63,0'] = 'air'
    const bot = swimBot({ cells })
    const ctx = { waterLastDry: { x: -8, y: 62, z: 0 } }
    const state = hostileAt('drowned', 2, 61, 0, 2.5)
    assert.equal(abortReflex(bot, ctx, state, T0), true)
    assert.deepEqual({ x: ctx.abort.x, y: ctx.abort.y, z: ctx.abort.z }, { x: 3, y: 62, z: 0 })
  })

  it('an inland stance beats the nearer waterline scan', () => {
    const bot = swimBot({ cells: inlandCells() })
    const ctx = {}
    const state = hostileAt('drowned', 2, 61, 0, 2.5)
    assert.equal(abortReflex(bot, ctx, state, T0), true)
    assert.deepEqual({ x: ctx.abort.x, y: ctx.abort.y, z: ctx.abort.z }, { x: 4, y: 62, z: 0 })
  })

  it('an inland stance beats the entry shore', () => {
    const bot = swimBot({ cells: inlandCells() })
    const ctx = { waterLastDry: { x: -3, y: 62, z: 0 } }
    const state = hostileAt('drowned', 2, 61, 0, 2.5)
    assert.equal(abortReflex(bot, ctx, state, T0), true)
    assert.deepEqual({ x: ctx.abort.x, y: ctx.abort.y, z: ctx.abort.z }, { x: 4, y: 62, z: 0 })
  })

  it('with no inland in range the waterline still stands', () => {
    const bot = swimBot({ cells: farInlandCells() }) // inland at x=6: past the detour cap
    const ctx = {}
    const state = hostileAt('drowned', 2, 61, 0, 2.5)
    assert.equal(abortReflex(bot, ctx, state, T0), true)
    // A waterline stance (scan tie order lands on -x); x=6 is ignored.
    assert.deepEqual({ x: ctx.abort.x, y: ctx.abort.y, z: ctx.abort.z }, { x: -3, y: 62, z: 0 })
  })

  it('nearestInlandDry is null when every stance borders water', () => {
    const bot = swimBot()
    assert.equal(home.nearestInlandDry(bot, [], -1, 1, 5), null)
    assert.deepEqual(home.nearestInlandDry(swimBot({ cells: inlandCells() }), [], -1, 1, 5), { x: 4, y: 62, z: 0 })
  })

  it('an unlandable entry (+2 bank, h04) falls back to the scan', () => {
    const bot = swimBot()
    const ctx = { waterLastDry: { x: -3, y: 64, z: 0 } } // two above the float: no mount
    const state = hostileAt('drowned', 2, 61, 0, 2.5)
    assert.equal(abortReflex(bot, ctx, state, T0), true)
    // The scan finds the landable waterline stance in the entry column.
    assert.deepEqual({ x: ctx.abort.x, y: ctx.abort.y, z: ctx.abort.z }, { x: -3, y: 62, z: 0 })
  })
})

describe('abortReflex episode', () => {
  function latched() {
    const bot = swimBot()
    const ctx = { waterLastDry: { x: -3, y: 62, z: 0 } }
    const state = hostileAt('drowned', 2, 61, 0, 2.5)
    assert.equal(abortReflex(bot, ctx, state, T0), true)
    return { bot, ctx, state }
  }

  it('holds the goal while swimming under threat (no re-issue when moving)', () => {
    const { bot, ctx, state } = latched()
    assert.equal(bot.calls.setGoal, 1)
    bot.pathfinder.isMoving = () => true
    assert.equal(abortReflex(bot, ctx, state, T0 + 1000), true)
    assert.equal(bot.calls.setGoal, 1)
    assert.equal(ctx.lastGoalKey, 'abort-shore:-3,0')
  })

  it('holds the latch ashore with the threat adjacent (no cooldown gap)', () => {
    // Revmux 01 major: releasing on footing with the drowned still adjacent
    // armed a 15 s cooldown and sent the bot back in unprotected. Revmux 02
    // major: yielding those ticks to dispatch flapped fight/leg goals with
    // the abort at the depth edge. The latch now HOLDS the body (kept, no
    // release, goal untouched) and re-drives the moment the body is wet.
    const { bot, ctx, state } = latched()
    bot.entity.isInWater = false // dry on the beach, threat still adjacent
    assert.equal(abortReflex(bot, ctx, state, T0 + 1000), true) // hold, keep latch
    assert.ok(ctx.abort)
    assert.equal(ctx.abortCoolUntil, undefined)
    assert.ok(bot.pathfinder.goal) // abort goal untouched (a flee set earlier still runs)
    assert.equal(abortReflex(bot, ctx, state, T0 + 2000), true) // still holding
    assert.ok(ctx.abort)
    // Re-entering re-drives immediately (same key, no cooldown gap).
    bot.entity.isInWater = true
    bot.entity.position = pos(1.5, 62, 0.5)
    assert.equal(abortReflex(bot, ctx, state, T0 + 3000), true)
    assert.equal(ctx.lastGoalKey, 'abort-shore:-3,0')
  })

  it('a loitering threat ends the hold after a minute (no statue)', () => {
    // Revmux 03 major: the capped hold releases so the episode can
    // re-trigger fresh (or stuck.js can see the bot) instead of freezing.
    const { bot, ctx, state } = latched()
    bot.entity.isInWater = false
    assert.equal(abortReflex(bot, ctx, state, T0 + 1000), true) // landfall
    assert.equal(abortReflex(bot, ctx, state, T0 + 59000), true) // still holding
    assert.ok(ctx.abort)
    assert.equal(abortReflex(bot, ctx, state, T0 + 62000), false) // hold-timeout: release
    assert.equal(ctx.abort, null)
    assert.equal(ctx.abortCoolUntil, T0 + 62000 + ABORT_COOLDOWN_MS)
  })

  it('drives through shelf footing to the stance (no yield at the edge)', () => {
    // Revmux 02 major: footing on the river shelf is wading, not the beach.
    // The abort keeps the body and the goal until the stance is stood on.
    const { bot, ctx, state } = latched() // target (-3,62,0), bot mid-pool
    bot.blockAt = ((base) => (p) => {
      if (Math.floor(p.x) === 0 && Math.floor(p.y) === 61 && Math.floor(p.z) === 0) {
        return { name: 'sand', boundingBox: 'block' }
      }
      return base(p)
    })(bot.blockAt)
    const goalsBefore = bot.calls.setGoal
    assert.equal(abortReflex(bot, ctx, state, T0 + 1000), true) // wading far: drive
    assert.equal(ctx.lastGoalKey, 'abort-shore:-3,0')
    assert.ok(bot.calls.setGoal >= goalsBefore) // goal (re-)issued, never yielded
    // Wading ON the stance holds: the fight happens from footing.
    bot.entity.position = pos(-2.5, 62, 0.5)
    bot.blockAt = ((base) => (p) => {
      if (Math.floor(p.x) === -3 && Math.floor(p.y) === 61 && Math.floor(p.z) === 0) {
        return { name: 'sand', boundingBox: 'block' }
      }
      return base(p)
    })(bot.blockAt)
    assert.equal(abortReflex(bot, ctx, state, T0 + 2000), true) // at stance: hold
    assert.ok(ctx.abort)
  })

  it('re-entering past the stall window keeps the reached shore (no misfire)', () => {
    // Revmux 02 major: the hold refreshes progress, so a re-entry 16 s
    // after landfall neither skips the reached shore nor remembers it.
    const { bot, ctx, state } = latched()
    bot.entity.isInWater = false
    assert.equal(abortReflex(bot, ctx, state, T0 + 1000), true) // landfall hold
    bot.entity.isInWater = true // dispatch walked back in 16 s later
    bot.entity.position = pos(1.5, 62, 0.5)
    assert.equal(abortReflex(bot, ctx, state, T0 + 17000), true)
    assert.deepEqual({ x: ctx.abort.x, z: ctx.abort.z }, { x: -3, z: 0 })
    assert.deepEqual(ctx.abort.skip, [])
    assert.equal(abortReflex(bot, ctx, null, T0 + 18000), false) // threat gone: release
    assert.deepEqual(ctx.abortShoreMemory, [])
  })

  it('a waded-through stall is not remembered as a failed shore', () => {
    // Revmux 02: the bot had footing while stalling toward this stance —
    // the path failed, the stance wasn't tested.
    const { bot, ctx, state } = latched()
    bot.blockAt = ((base) => (p) => {
      if (Math.floor(p.x) === 0 && Math.floor(p.y) === 61 && Math.floor(p.z) === 0) {
        return { name: 'sand', boundingBox: 'block' }
      }
      return base(p)
    })(bot.blockAt)
    assert.equal(abortReflex(bot, ctx, state, T0 + 5000), true) // baseline
    assert.equal(abortReflex(bot, ctx, state, T0 + 21000), true) // stall with footing
    assert.deepEqual(ctx.abort.skip, [{ x: -3, z: 0, footed: true }])
    assert.equal(abortReflex(bot, ctx, null, T0 + 22000), false) // release
    assert.deepEqual(ctx.abortShoreMemory, [])
  })

  it('releases ashore once the threat is gone (crossing resumes)', () => {
    const { bot, ctx } = latched()
    bot.entity.isInWater = false
    bot.entity.onGround = true
    assert.equal(abortReflex(bot, ctx, null, T0 + 1000), false)
    assert.equal(ctx.abort, null)
    assert.equal(ctx.abortCoolUntil, T0 + 1000 + ABORT_COOLDOWN_MS)
    assert.equal(bot.pathfinder.goal, null)
  })

  it('releases when the threat is gone mid-swim (crossing resumes)', () => {
    const { bot, ctx } = latched()
    assert.equal(abortReflex(bot, ctx, null, T0 + 2000), false)
    assert.equal(ctx.abort, null)
    assert.equal(ctx.abortCoolUntil, T0 + 2000 + ABORT_COOLDOWN_MS)
  })

  it('release needs the clear band (no mid-water flap)', () => {
    const { bot, ctx } = latched()
    const edge = hostileAt('drowned', 5, 61, 0, 7) // past trigger 6, inside clear 8
    assert.equal(abortReflex(bot, ctx, edge, T0 + 1000), true)
    assert.ok(ctx.abort)
    assert.ok(7 > ABORT_RANGE && 7 < ABORT_CLEAR_DIST)
  })

  it('stall skips the shore and re-scans; an empty re-scan gives up to the leg', () => {
    const { bot, ctx, state } = latched()
    assert.deepEqual({ x: ctx.abort.x, z: ctx.abort.z }, { x: -3, z: 0 })
    assert.equal(abortReflex(bot, ctx, state, T0 + 5000), true) // sets the progress baseline
    // Frozen 16 s past the baseline: skip the entry, re-scan the east shore.
    assert.equal(abortReflex(bot, ctx, state, T0 + 21000), true)
    assert.deepEqual(ctx.abort.skip, [{ x: -3, z: 0, footed: false }])
    assert.deepEqual({ x: ctx.abort.x, z: ctx.abort.z }, { x: 3, z: 0 })
    assert.equal(ctx.lastGoalKey, 'abort-shore:3,0')
    // Frozen again: skip the east shore too; the re-scan finds nothing
    // (both shores skipped) and the episode gives up so the leg advances.
    assert.equal(abortReflex(bot, ctx, state, T0 + 26000), true) // new baseline
    assert.equal(abortReflex(bot, ctx, state, T0 + 42000), false)
    assert.equal(ctx.abort, null)
    assert.equal(ctx.abortCoolUntil, T0 + 42000 + ABORT_COOLDOWN_MS)
  })

  it('three skipped shores give up to the leg', () => {
    const cells = swimCells()
    cells['0,61,4'] = 'dirt'
    cells['0,62,4'] = 'air'
    cells['0,63,4'] = 'air'
    const bot = swimBot({ cells })
    const ctx = { waterLastDry: { x: -3, y: 62, z: 0 } }
    const state = hostileAt('drowned', 2, 61, 0, 2.5)
    assert.equal(abortReflex(bot, ctx, state, T0), true) // entry target
    assert.equal(abortReflex(bot, ctx, state, T0 + 5000), true) // baseline
    assert.equal(abortReflex(bot, ctx, state, T0 + 21000), true) // skip 1 -> east
    assert.deepEqual({ x: ctx.abort.x, z: ctx.abort.z }, { x: 3, z: 0 })
    assert.equal(abortReflex(bot, ctx, state, T0 + 26000), true) // baseline
    assert.equal(abortReflex(bot, ctx, state, T0 + 42000), true) // skip 2 -> north
    assert.deepEqual({ x: ctx.abort.x, z: ctx.abort.z }, { x: 0, z: 4 })
    assert.equal(abortReflex(bot, ctx, state, T0 + 47000), true) // baseline
    assert.equal(abortReflex(bot, ctx, state, T0 + 63000), false) // skip 3 -> give up
    assert.equal(ctx.abort, null)
    assert.equal(ctx.abortCoolUntil, T0 + 63000 + ABORT_COOLDOWN_MS)
  })

  it('yields to the stuck menu mid-episode', () => {
    const { bot, ctx, state } = latched()
    ctx.stuck = { by: 'test' }
    assert.equal(abortReflex(bot, ctx, state, T0 + 1000), false)
    assert.equal(ctx.abort, null)
  })

  it('cooldown blocks re-trigger, then a fresh threat re-aborts', () => {
    const { bot, ctx } = latched()
    assert.equal(abortReflex(bot, ctx, null, T0 + 2000), false) // released, cooling
    const state = hostileAt('drowned', 2, 61, 0, 2.5)
    assert.equal(abortReflex(bot, ctx, state, T0 + 3000), false) // still cooling
    assert.equal(bot.calls.setGoal, 2) // latch issue + release null
    assert.equal(abortReflex(bot, ctx, state, T0 + 2000 + ABORT_COOLDOWN_MS + 1), true) // calm over
    assert.ok(ctx.abort)
    assert.equal(bot.calls.setGoal, 3)
  })

  it('a stale latch GCs without a cooldown and re-triggers fresh', () => {
    const { bot, ctx, state } = latched()
    assert.equal(abortReflex(bot, ctx, state, T0 + 61000), true) // 61 s, no drive tick: GC + fresh trigger
    assert.ok(ctx.abort)
    assert.equal(ctx.abortCoolUntil, undefined)
    assert.equal(ctx.abort.touchedAt, T0 + 61000)
  })

  it('failed shores stay skipped across episodes until the memory expires', () => {
    const { bot, ctx, state } = latched()
    assert.equal(abortReflex(bot, ctx, state, T0 + 5000), true) // baseline
    assert.equal(abortReflex(bot, ctx, state, T0 + 21000), true) // stall: skip entry -> east
    assert.deepEqual({ x: ctx.abort.x, z: ctx.abort.z }, { x: 3, z: 0 })
    assert.equal(abortReflex(bot, ctx, null, T0 + 22000), false) // threat gone: release, remember the skip
    assert.equal(ctx.abort, null)
    assert.equal(ctx.abortShoreMemory.length, 1)
    // Next episode (past the cooldown) seeds the remembered exclusion: the
    // entry stays out and the scan wins outright, while the episode's own
    // skip list starts empty (revmux 02: MAX_SKIP counts this ford only).
    assert.equal(abortReflex(bot, ctx, state, T0 + 38000), true)
    assert.deepEqual({ x: ctx.abort.x, z: ctx.abort.z }, { x: 3, z: 0 })
    assert.deepEqual(ctx.abort.skip, [])
    assert.deepEqual(ctx.abort.remembered, [{ x: -3, z: 0 }])
    assert.equal(abortReflex(bot, ctx, null, T0 + 39000), false) // release again
    // Past the memory TTL the entry is available and wins the tie again.
    assert.equal(abortReflex(bot, ctx, state, T0 + 39000 + 600000 + 16000), true)
    assert.deepEqual({ x: ctx.abort.x, z: ctx.abort.z }, { x: -3, z: 0 })
  })

  it('airborne dry ticks do not move the entry shore', () => {
    const bot = swimBot({ bodyPos: pos(9.5, 70, 9.5), inWater: false, onGround: false })
    const ctx = { waterLastDry: { x: -3, y: 62, z: 0 } }
    assert.equal(abortReflex(bot, ctx, null, T0), false)
    assert.deepEqual(ctx.waterLastDry, { x: -3, y: 62, z: 0 })
  })
})

describe('nearestDry dy band (abort contract)', () => {
  function caveBot() {
    // Dry stance at feet 58 (dy=-4, a cave under the swim) and a waterline
    // stance at feet 62 (dy=0).
    const cells = {
      '0,61,0': 'water', '0,62,0': 'water',
      '2,57,2': 'stone', '2,58,2': 'air', '2,59,2': 'air',
      '6,61,0': 'dirt', '6,62,0': 'air', '6,63,0': 'air',
    }
    return swimBot({ cells, bodyPos: pos(0.5, 62, 0.5) })
  }

  it('default band still finds the deep stance (shelter behavior kept)', () => {
    const hit = home.nearestDry(caveBot())
    assert.ok(hit)
    assert.equal(hit.y, 58)
  })

  it('abort band skips the cave for the waterline', () => {
    const hit = home.nearestDry(caveBot(), [], -1, 1)
    assert.ok(hit)
    assert.deepEqual(hit, { x: 6, y: 62, z: 0 })
  })

  it('dryStanceAt verifies one cell', () => {
    const bot = caveBot()
    assert.equal(home.dryStanceAt(bot, 6, 62, 0), true)
    assert.equal(home.dryStanceAt(bot, 0, 62, 0), false) // wet feet
    assert.equal(home.dryStanceAt(bot, 6, 61, 0), false) // feet inside the floor column top? floor below is dirt at 60: missing -> null
  })
})
