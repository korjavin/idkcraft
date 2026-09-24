'use strict'

// Bead rw4.5 acceptance (a)-(e): gohome walks to the door, opens, enters and
// closes it; stay holds the night and leaves in the morning.

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const home = require('../src/behaviours/home')

const SITE = { x: 10, y: 64, z: 20 }
// Door lower cell, outside approach cell, first interior cell behind the door.
const DOOR = { x: 11, y: 64, z: 20 }
const OUTSIDE = { x: 11, y: 64, z: 19 }
const INSIDE = { x: 11, y: 64, z: 21 }

function mockBot({ at, timeOfDay = 12500, doorOpen = false, moving = false } = {}) {
  const chats = []
  const calls = { goals: [], activates: 0, looks: [], controls: [], clears: 0 }
  const state = { doorOpen }
  const bot = {
    chats,
    calls,
    entity: { position: { x: at.x, y: at.y, z: at.z } },
    time: { timeOfDay },
    pathfinder: {
      goal: null,
      movements: { canDig: true },
      isMoving: () => moving,
      setGoal: (g) => { calls.goals.push(g); bot.pathfinder.goal = g },
      stop: () => {},
    },
    inventory: { items: () => [] },
    blockAt: (p) => {
      const fx = Math.floor(p.x)
      const fy = Math.floor(p.y)
      const fz = Math.floor(p.z)
      if (fx === DOOR.x && (fy === DOOR.y || fy === DOOR.y + 1) && fz === DOOR.z) {
        return { name: 'oak_door', position: { x: fx, y: fy, z: fz }, getProperties: () => ({ open: state.doorOpen }) }
      }
      return { name: 'air', boundingBox: 'empty', position: { x: fx, y: fy, z: fz } }
    },
    activateBlock: async () => { calls.activates++; state.doorOpen = !state.doorOpen },
    chat: (m) => { chats.push(String(m)) },
    lookAt: (p) => { calls.looks.push({ x: p.x, y: p.y, z: p.z }) },
    setControlState: (name, val) => { calls.controls.push([name, val]) },
    clearControlStates: () => { calls.clears++ },
  }
  return bot
}

function ctxHome() {
  return {
    site: { ...SITE },
    built: true,
    interior: { min: { x: 11, y: 64, z: 21 }, max: { x: 12, y: 65, z: 22 } },
  }
}

const settle = async (n = 5) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)) }

describe('rw4.5 gohome', () => {
  it('(a) far outside walks to the cell before the door', () => {
    const bot = mockBot({ at: { x: 16, y: 64, z: 14 } })
    const ctx = { home: ctxHome() }
    home.gohome(bot, ctx)
    assert.equal(bot.calls.goals.length, 1)
    const g = bot.calls.goals[0]
    assert.equal(g.constructor.name, 'GoalNear')
    assert.deepEqual({ x: g.x, y: g.y, z: g.z }, OUTSIDE)
  })

  it('(b) at the closed door opens once, then sneaks inside by direct control', async () => {
    const bot = mockBot({ at: { ...OUTSIDE } })
    const ctx = { home: ctxHome() }
    home.gohome(bot, ctx)
    await settle()
    assert.equal(bot.calls.activates, 1)
    assert.equal(ctx.gohome.phase, 'open')
    home.gohome(bot, ctx) // door open -> enter: doorway legs bypass A* (doors unbreakable)
    assert.equal(ctx.gohome.phase, 'enter')
    assert.deepEqual(bot.calls.goals, [])
    const look = bot.calls.looks[bot.calls.looks.length - 1]
    assert.deepEqual([look.x, look.z], [OUTSIDE.x + 0.5, OUTSIDE.z + 0.5]) // staged via out-centre
    assert.deepEqual(bot.calls.controls.slice(-2), [['forward', true], ['sneak', true]])
    assert.equal(bot.calls.activates, 1)
    bot.entity.position = { x: INSIDE.x, y: INSIDE.y, z: INSIDE.z + 0.5 } // fully past the door plane
    ctx.gohome.lastToggle = 0 // test ticks are instant; live walking covers the cooldown
    home.gohome(bot, ctx) // inside -> close, controls dropped, toggle shuts the open door
    await settle()
    assert.equal(bot.calls.clears, 1)
    assert.equal(bot.calls.activates, 2)
    home.gohome(bot, ctx) // door shut -> done + sheltered
    assert.equal(ctx.stepStatus, 'done')
    assert.equal(ctx.inShelter, true)
  })

  it('walk arrival matches the goal from the east end cell', () => {
    // Revmux 01-review loop+goal-5: the corner-measured radius missed the
    // east GoalNear end cell one-sided.
    const bot = mockBot({ at: { x: OUTSIDE.x + 1, y: OUTSIDE.y, z: OUTSIDE.z } })
    const ctx = { home: ctxHome() }
    home.gohome(bot, ctx)
    assert.equal(ctx.gohome.phase, 'open') // arrived, not stalled east of the door
    assert.deepEqual(bot.calls.goals, [])
  })

  it('the walk forbids digging and restores it after', () => {
    // Live 8kc: A* tunneled through dirt beside the unbreakable walls (and
    // timed out into wall-pushing partial paths) instead of routing around.
    const bot = mockBot({ at: { x: 16, y: 64, z: 14 } })
    const ctx = { home: ctxHome() }
    home.gohome(bot, ctx)
    assert.equal(ctx.gohome.phase, 'walk')
    assert.equal(bot.pathfinder.movements.canDig, false)
    bot.entity.position = { ...OUTSIDE }
    home.gohome(bot, ctx) // arrived -> open restores digging for other steps
    assert.equal(ctx.gohome.phase, 'open')
    assert.equal(bot.pathfinder.movements.canDig, true)
  })

  it('a re-armed walk replans instead of latch-skipping the stale goal', () => {
    // Live 8kc: a pushing executor at fail time never cleared lastGoalKey,
    // so every re-armed walk skipped setGoal and spun on the dead path.
    const bot = mockBot({ at: { x: 16, y: 64, z: 14 }, moving: true })
    const ctx = {
      home: ctxHome(), step: 'gohome', stepStatus: 'failed:cannot-reach-home',
      lastGoalKey: 'gohome-walk',
      gohome: { phase: 'failed', stalls: 0, fails: 3, lastPos: null, lastToggle: 0, legIdx: 0, legTicks: 0, legPos: null, legStall: 0, backing: 0 },
    }
    home.gohome(bot, ctx)
    assert.equal(ctx.gohome.phase, 'walk')
    assert.equal(bot.calls.goals.length, 1, 'fresh walk issues a new goal despite the latch')
  })

  it('a stalled leg backs up instead of pushing forever', () => {
    // Live 8kc: the doorway sneak scraped the frame with zero progress.
    const bot = mockBot({ at: { ...OUTSIDE }, doorOpen: true })
    const ctx = {
      home: ctxHome(), step: 'gohome', stepStatus: 'running',
      gohome: { phase: 'enter', stalls: 0, fails: 0, lastPos: null, lastToggle: 0, legIdx: 1, legTicks: 0, legPos: null, legStall: 0, backing: 0 },
    }
    for (let i = 0; i < 12; i++) home.gohome(bot, ctx)
    assert.equal(ctx.gohome.phase, 'enter')
    assert.notEqual(ctx.stepStatus, 'failed:cannot-reach-home')
    assert.ok(bot.calls.controls.some(([n, v]) => n === 'forward' && v === true), 'leg drove first')
    assert.ok(bot.calls.controls.some(([n, v]) => n === 'back' && v === true), 'stalled leg backs up')
    for (let i = 0; i < 8; i++) home.gohome(bot, ctx) // backing window (mock never moves)
    assert.equal(ctx.gohome.phase, 'enter')
    for (let i = 0; i < 9; i++) { // steady back-up motion: window expires
      const at = bot.entity.position
      bot.entity.position = { x: at.x, y: at.y, z: at.z - 0.2 }
      home.gohome(bot, ctx)
    }
    // progress: drive resumes, back released
    const backs = bot.calls.controls.filter(([n]) => n === 'back')
    assert.deepEqual(backs[backs.length - 1], ['back', false], 'back released when driving resumes')
    assert.equal(ctx.gohome.phase, 'enter')
  })

  it('enter stages through the door centre', () => {
    const bot = mockBot({ at: { x: OUTSIDE.x + 0.5, y: OUTSIDE.y, z: OUTSIDE.z + 0.5 }, doorOpen: true })
    const ctx = {
      home: ctxHome(), step: 'gohome', stepStatus: 'running',
      gohome: { phase: 'enter', stalls: 0, fails: 0, lastPos: null, lastToggle: 0, legIdx: 0, legTicks: 0, legPos: null, legStall: 0, backing: 0 },
    }
    home.gohome(bot, ctx)
    const look = bot.calls.looks[bot.calls.looks.length - 1]
    assert.deepEqual([look.x, look.z], [DOOR.x + 0.5, DOOR.z + 0.5])
  })

  it('a doorway leg that never arrives fails the step and drops control', () => {
    // Revmux 02-review: A* cannot cross the unbreakable door, so the legs
    // must still fail safe (tick cap, no displacement stall to false-fire).
    const bot = mockBot({ at: { ...OUTSIDE }, doorOpen: true })
    const ctx = { home: ctxHome(), step: 'gohome', stepStatus: 'running' }
    home.gohome(bot, ctx) // walk arrived (open door) -> enter leg starts
    assert.equal(ctx.gohome.phase, 'enter')
    for (let i = 0; i < 60; i++) home.gohome(bot, ctx) // stationary: cap trips
    assert.equal(ctx.stepStatus, 'failed:cannot-reach-home')
    assert.equal(ctx.gohome.phase, 'failed')
    assert.ok(bot.calls.controls.some(([n, v]) => n === 'forward' && v === true), 'leg walked first')
    assert.ok(bot.calls.clears >= 1, 'controls dropped on failure')
  })

  it('(c) inside closes the door, done, sheltered', async () => {
    const bot = mockBot({ at: { ...INSIDE }, doorOpen: true })
    const ctx = { home: ctxHome() }
    home.gohome(bot, ctx)
    await settle()
    assert.equal(bot.calls.activates, 1)
    home.gohome(bot, ctx)
    assert.equal(ctx.stepStatus, 'done')
    assert.equal(ctx.inShelter, true)
    assert.ok(bot.chats.some((m) => m === 'home for the night'))
  })

  it('(f) stepStatus running (live shape) advances walk/open/enter/close to done', async () => {
    const bot = mockBot({ at: { ...OUTSIDE } })
    const ctx = { home: ctxHome(), step: 'gohome', stepStatus: 'running' }
    home.gohome(bot, ctx) // walk arrived -> open, toggle fires despite 'running'
    await settle()
    assert.equal(ctx.gohome.phase, 'open')
    assert.equal(bot.calls.activates, 1)
    home.gohome(bot, ctx) // door open -> enter, direct control despite 'running'
    assert.equal(ctx.gohome.phase, 'enter')
    assert.deepEqual(bot.calls.goals, [])
    const g = bot.calls.looks[bot.calls.looks.length - 1]
    assert.deepEqual([g.x, g.z], [OUTSIDE.x + 0.5, OUTSIDE.z + 0.5]) // staged via out-centre
    bot.entity.position = { x: INSIDE.x, y: INSIDE.y, z: INSIDE.z + 0.5 } // fully past the door plane
    ctx.gohome.lastToggle = 0 // test ticks are instant; live walking covers the cooldown
    home.gohome(bot, ctx) // inside -> close, toggle shuts the open door
    await settle()
    assert.equal(ctx.gohome.phase, 'close')
    assert.equal(bot.calls.activates, 2)
    home.gohome(bot, ctx) // door shut -> done + sheltered
    assert.equal(ctx.stepStatus, 'done')
    assert.equal(ctx.inShelter, true)
    assert.ok(bot.chats.some((m) => m === 'home for the night'))
  })

  it('repeated stall fails the phase, and the next pick re-arms a fresh walk', () => {
    // Revmux 01-review loop+goal-2: a second cannot-reach-home with unchanged
    // facts stranded gohome all night; the failed phase must re-arm choice.
    const bot = mockBot({ at: { x: 16, y: 64, z: 14 }, moving: false })
    const ctx = { home: ctxHome(), step: 'gohome', stepStatus: 'running' }
    for (let i = 0; i < 31; i++) home.gohome(bot, ctx) // 3 x 10 stall ticks
    assert.equal(ctx.stepStatus, 'failed:cannot-reach-home')
    assert.equal(ctx.gohome.phase, 'failed')
    home.gohome(bot, ctx) // re-picked: fresh record, walking again
    assert.equal(ctx.gohome.phase, 'walk')
    assert.equal(ctx.gohome.fails, 0)
    // Stale stepStatus (decide same-askKey early return leaves the failed
    // status) must not freeze enter: inside still reaches close and done.
    ctx.stepStatus = 'failed:cannot-reach-home'
    ctx.gohome.phase = 'enter'
    bot.entity.position = { x: INSIDE.x, y: INSIDE.y, z: INSIDE.z + 0.5 } // fully past the door plane
    home.gohome(bot, ctx) // inside -> close -> done in one tick, despite the stale status
    assert.equal(ctx.gohome.phase, 'done')
    assert.equal(ctx.stepStatus, 'done')
    assert.equal(ctx.inShelter, true)
  })

  it('no site: fails without touching the door and restores digging', () => {
    const bot = mockBot({ at: { ...OUTSIDE } })
    bot.pathfinder.movements.canDig = false // leaked from a previous walk
    const ctx = {}
    home.gohome(bot, ctx)
    assert.equal(ctx.stepStatus, 'failed:no-home')
    assert.equal(bot.pathfinder.movements.canDig, true)
    assert.equal(bot.calls.activates, 0)
    assert.equal(bot.calls.goals.length, 0)
  })

  it('no site: fails without touching the door', () => {
    const bot = mockBot({ at: { ...OUTSIDE } })
    const ctx = {}
    home.gohome(bot, ctx)
    assert.equal(ctx.stepStatus, 'failed:no-home')
    assert.equal(bot.calls.activates, 0)
    assert.equal(bot.calls.goals.length, 0)
  })
})

describe('rw4.5 stay', () => {
  it('(d) at night holds position, sheltered, silent', () => {
    const bot = mockBot({ at: { ...INSIDE }, timeOfDay: 15000, moving: true })
    const ctx = { home: ctxHome() }
    home.stay(bot, ctx)
    assert.equal(bot.calls.goals.length, 0)
    assert.equal(ctx.inShelter, true)
    assert.notEqual(ctx.stepStatus, 'done')
  })

  it('(e) at day leaves, closes, done, unsheltered', async () => {
    const realNow = Date.now
    let now = realNow()
    Date.now = () => now
    try {
    const bot = mockBot({ at: { x: 12, y: 64, z: 22 }, timeOfDay: 1000, doorOpen: false })
    const ctx = { home: ctxHome() }
    home.stay(bot, ctx) // hold -> open the closed door
    await settle()
    assert.equal(bot.calls.activates, 1)
    home.stay(bot, ctx) // door open: exit sneaks, staging via the inside cell (far corner would cut the wall)
    assert.deepEqual(bot.calls.goals, [])
    const g = bot.calls.looks[bot.calls.looks.length - 1]
    assert.deepEqual([g.x, g.z], [INSIDE.x + 0.5, INSIDE.z + 0.5])
    assert.deepEqual(bot.calls.controls.slice(-2), [['forward', true], ['sneak', true]])
    bot.entity.position = { ...OUTSIDE } // stepped out
    home.stay(bot, ctx) // arrived: close phase, no toggle yet
    assert.equal(bot.calls.activates, 1)
    now += 5000
    home.stay(bot, ctx) // door still open: close it
    await settle()
    assert.equal(bot.calls.activates, 2)
    home.stay(bot, ctx) // door closed: done
    assert.equal(ctx.stepStatus, 'done')
    assert.equal(ctx.inShelter, false)
    assert.ok(bot.chats.some((m) => m === 'morning; back to work'))
    } finally {
      Date.now = realNow
    }
  })

  it('(f) morning exit from the inside cell walks out, never closes in place', () => {
    // Revmux 01/02-review: no pathfinder goal to be met in place — the sneak
    // legs cannot meet arrival without walking.
    for (const at of [{ ...INSIDE }, { x: INSIDE.x, y: INSIDE.y, z: INSIDE.z + 0.15 }]) {
      const bot = mockBot({ at, timeOfDay: 1000, doorOpen: true })
      const ctx = { home: ctxHome(), step: 'stay', stepStatus: 'running' }
      home.stay(bot, ctx)
      assert.equal(ctx.stay.phase, 'exit')
      assert.deepEqual(bot.calls.goals, [])
      assert.deepEqual(bot.calls.controls.slice(-2), [['forward', true], ['sneak', true]])
      home.stay(bot, ctx) // still inside: must not reach close
      assert.equal(ctx.stay.phase, 'exit')
      assert.notEqual(ctx.stepStatus, 'done')
      assert.equal(bot.calls.activates, 0)
    }
  })

  it('exit does not arrive standing in the doorway', () => {
    // Revmux 03-review: arrival must be one-sided, whole body clear of the
    // door cell, or close shuts the panel into the bot.
    const bot = mockBot({ at: { x: OUTSIDE.x, y: OUTSIDE.y, z: OUTSIDE.z + 1.5 }, timeOfDay: 1000, doorOpen: true })
    const ctx = {
      home: ctxHome(), step: 'stay', stepStatus: 'running',
      stay: { phase: 'exit', stalls: 0, fails: 0, lastPos: null, lastToggle: 0, legIdx: 1, legTicks: 0 },
    }
    home.stay(bot, ctx)
    assert.equal(ctx.stay.phase, 'exit')
    assert.notEqual(ctx.stepStatus, 'done')
    assert.equal(bot.calls.activates, 0)
  })

  it('enter does not arrive overlapping the door cell', () => {
    // Mirror of the exit doorway case above.
    const bot = mockBot({ at: { x: INSIDE.x, y: INSIDE.y, z: INSIDE.z }, doorOpen: true })
    const ctx = {
      home: ctxHome(), step: 'gohome', stepStatus: 'running',
      gohome: { phase: 'enter', stalls: 0, fails: 0, lastPos: null, lastToggle: 0, legIdx: 1, legTicks: 0 },
    }
    home.gohome(bot, ctx)
    assert.equal(ctx.gohome.phase, 'enter')
    assert.notEqual(ctx.stepStatus, 'done')
  })

  it('stale stay outside at night fails instead of holding with fight suppressed', () => {
    // Revmux 01-review loop+goal-4: death, follow->work or a lead order can
    // leave stay running outdoors; it must fail so gohome re-arms.
    const bot = mockBot({ at: { x: 16, y: 64, z: 14 }, timeOfDay: 15000 })
    const ctx = {
      home: ctxHome(), step: 'stay', stepStatus: 'running', inShelter: true,
      stay: { phase: 'hold', stalls: 0, fails: 0, lastPos: null, lastToggle: 0 },
    }
    home.stay(bot, ctx)
    assert.equal(ctx.stepStatus, 'failed:not-inside')
    assert.equal(ctx.inShelter, false)
    assert.equal(bot.calls.goals.length, 0)
    assert.equal(bot.calls.activates, 0)
  })
})
