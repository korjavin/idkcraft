'use strict'

// Bead rw4.5 acceptance (a)-(e): gohome walks to the door, opens, enters and
// closes it; stay holds the night and leaves in the morning.

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const home = require('../src/behaviours/home')
const body = require('../src/body')

const SITE = { x: 10, y: 64, z: 20 }
// Door lower cell, outside approach cell, first interior cell behind the door.
const DOOR = { x: 11, y: 64, z: 20 }
const OUTSIDE = { x: 11, y: 64, z: 19 }
const INSIDE = { x: 11, y: 64, z: 21 }

function mockBot({ at, timeOfDay = 12500, day = 5, doorOpen = false, moving = false, door = true, doorFacing, doorHinge } = {}) {
  const chats = []
  const calls = { goals: [], activates: 0, looks: [], controls: [], clears: 0 }
  const state = { doorOpen }
  const bot = {
    chats,
    calls,
    entity: { position: { x: at.x, y: at.y, z: at.z } },
    time: { timeOfDay, day },
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
      if (door && fx === DOOR.x && (fy === DOOR.y || fy === DOOR.y + 1) && fz === DOOR.z) {
        return { name: 'oak_door', position: { x: fx, y: fy, z: fz }, getProperties: () => ({ open: state.doorOpen, facing: doorFacing, hinge: doorHinge }) }
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

  it('walk does not arrive on the roof above or in a pit below the door (rgsi/i2bi)', () => {
    for (const dy of [2.8, -2]) {
      const bot = mockBot({ at: { x: OUTSIDE.x + 0.5, y: OUTSIDE.y + dy, z: OUTSIDE.z + 0.5 } })
      const ctx = { home: ctxHome() }
      home.gohome(bot, ctx)
      assert.equal(ctx.gohome.phase, 'walk', `dy ${dy}`)
      assert.equal(bot.calls.goals.length, 1, 'pathfinder goal keeps the correct y')
    }
  })

  it('a stalled walk from a pit asks the stuck menu once instead of failing (i2bi)', () => {
    const at = { x: OUTSIDE.x + 2.5, y: OUTSIDE.y - 2, z: OUTSIDE.z + 0.5 }
    const bot = mockBot({ at })
    const ctx = { home: ctxHome(), gohome: { phase: 'walk', stalls: 9, fails: 0, lastPos: { ...at } } }
    home.gohome(bot, ctx)
    assert.equal(ctx.stuck.by, 'no-displacement')
    assert.equal(ctx.gohome.fails, 0)
    assert.equal(ctx.gohome.phase, 'walk')
    // asked once: further stalls fall through to the normal fail count
    ctx.stuck = null
    for (let i = 0; i < 40 && ctx.gohome.phase === 'walk'; i++) home.gohome(bot, ctx)
    assert.equal(ctx.stuck, null)
    assert.equal(ctx.gohome.phase, 'failed')
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

  it('rw4.16: a re-issued done chats once per night, never by day', async () => {
    // Prod 2026-10-06: a finished gohome restarted every tick and chatted
    // 'home for the night' 434 times in 7 min (kick risk).
    const bot = mockBot({ at: { ...INSIDE }, doorOpen: false })
    const ctx = { home: ctxHome() }
    home.gohome(bot, ctx) // inside, door shut -> done
    assert.equal(ctx.stepStatus, 'done')
    assert.deepEqual(bot.chats, ['home for the night'])
    home.gohome(bot, ctx) // re-issued done, same night
    home.gohome(bot, ctx)
    assert.equal(ctx.stepStatus, 'done')
    assert.deepEqual(bot.chats, ['home for the night'], 'one arrival line per night')
    bot.time.day = 6 // the next night announces again
    home.gohome(bot, ctx)
    assert.deepEqual(bot.chats, ['home for the night', 'home for the night'])

    const dayBot = mockBot({ at: { ...INSIDE }, doorOpen: false, timeOfDay: 6000, day: 6 })
    const dayCtx = { home: ctxHome() }
    home.gohome(dayBot, dayCtx)
    assert.equal(dayCtx.stepStatus, 'done')
    assert.deepEqual(dayBot.chats, [], 'no night line by day')
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
    assert.ok(bot.chats.some((m) => m === 'night: survived, no deaths, banked nothing, at home; back to work'), bot.chats.join(' | '))
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

describe('rw4.8 door failures fail loud', () => {
  it('gohome close with no door fails instead of sheltering silently', () => {
    // Prod 2026-09-27 stood a night 'sheltered' while arrows came through.
    const bot = mockBot({ at: { ...INSIDE }, door: false })
    const ctx = { home: ctxHome() }
    home.gohome(bot, ctx) // inside -> close -> no-door fail in one tick
    assert.equal(ctx.stepStatus, 'failed:no-door')
    assert.equal(ctx.gohome.phase, 'failed')
    assert.notEqual(ctx.inShelter, true)
    assert.ok(!bot.chats.some((m) => m === 'home for the night'))
  })

  it('stay hold re-closes an opened door and keeps holding', async () => {
    const bot = mockBot({ at: { ...INSIDE }, timeOfDay: 15000, doorOpen: true })
    const ctx = { home: ctxHome(), step: 'stay', stepStatus: 'running' }
    home.stay(bot, ctx)
    await settle()
    assert.equal(bot.calls.activates, 1)
    assert.equal(ctx.stay.phase, 'hold')
    assert.equal(ctx.stepStatus, 'running')
    assert.equal(ctx.inShelter, true)
    home.stay(bot, ctx) // shut now: no more toggles
    assert.equal(bot.calls.activates, 1)
  })

  it('stay hold with no door logs once and keeps holding (no fail spin)', () => {
    // Revmux 01-review: stay is self-advancing, so failing here would
    // re-pick and log every tick all night (~400 lines). Hold + one line.
    const realLog = console.log
    const lines = []
    console.log = (m) => { lines.push(String(m)) }
    try {
      const bot = mockBot({ at: { ...INSIDE }, timeOfDay: 15000, door: false })
      const ctx = {
        home: ctxHome(), step: 'stay', stepStatus: 'running', inShelter: true,
        stay: { phase: 'hold', stalls: 0, fails: 0, lastPos: null, lastToggle: 0 },
      }
      for (let i = 0; i < 5; i++) home.stay(bot, ctx)
      assert.equal(ctx.stay.phase, 'hold')
      assert.equal(ctx.stepStatus, 'running')
      assert.equal(ctx.inShelter, false, 'no door: fight must not be suppressed')
      assert.deepEqual(lines, ['door missing at stay-hold'])
    } finally {
      console.log = realLog
    }
  })

  it('morning close with no door fails instead of done', () => {
    const bot = mockBot({ at: { ...OUTSIDE }, timeOfDay: 1000, door: false })
    const ctx = {
      home: ctxHome(), step: 'stay', stepStatus: 'running',
      stay: { phase: 'close', stalls: 0, fails: 0, lastPos: null, lastToggle: 0 },
    }
    home.stay(bot, ctx)
    assert.equal(ctx.stepStatus, 'failed:no-door')
    assert.equal(ctx.stay.phase, 'failed')
    assert.ok(!bot.chats.some((m) => m.startsWith('night: ')), 'failed close reports nothing')
  })
})

describe('idkcraft-1l9 gohome fails fast at a broken door', () => {
  const quiet = (fn) => {
    const realLog = console.log
    const lines = []
    console.log = (m) => { lines.push(String(m)) }
    try { fn(lines) } finally { console.log = realLog }
    return lines
  }

  it('home=built, door gone, bot at the aim: fails in one tick and drops built', () => {
    // Prod 2026-10-01: 8 minutes moving=false path=success at the door
    // cell, re-picked silently (gohome never holds a failure).
    quiet(() => {
      const bot = mockBot({ at: { ...OUTSIDE }, timeOfDay: 15000, door: false })
      const ctx = { home: ctxHome(), step: 'gohome', stepStatus: 'running' }
      home.gohome(bot, ctx)
      assert.equal(ctx.stepStatus, 'failed:no-door')
      assert.equal(ctx.gohome.phase, 'failed')
      assert.equal(ctx.home.built, false, 'facts flip to home=site: gohome infeasible, build repairs')
      assert.equal(bot.calls.controls.length, 0, 'no doorway walk into a hole')
    })
  })

  it('a skipped door cell is un-skipped so revalidation cannot flip built back', () => {
    quiet(() => {
      const build = require('../src/behaviours/build')
      const h = ctxHome()
      const di = build.blueprintFor(h).findIndex((c) => c.kind === 'door')
      const bot = mockBot({ at: { ...OUTSIDE }, timeOfDay: 15000, door: false })
      const all = build.blueprintFor(h).map((_, i) => i)
      const ctx = { home: h, step: 'gohome', stepStatus: 'running', buildSkip: all.slice(), buildSkipAt: { [di]: 1 } }
      home.gohome(bot, ctx)
      assert.equal(ctx.stepStatus, 'failed:no-door')
      assert.equal(ctx.home.built, false)
      assert.ok(!ctx.buildSkip.includes(di), 'door re-probed by build')
      assert.equal(ctx.buildSkipAt[di], undefined)
      assert.notEqual(build.nextCellIdx(bot, h, ctx.buildSkip), -1, 'index.js revalidation keeps built=false')
      // Build re-skips the door after the re-probe: the skip window stands.
      ctx.buildSkip.push(di)
      ctx.buildSkipAt[di] = ctx.doorReprobeAt + 1
      h.built = true
      home.gohome(bot, ctx)
      assert.equal(ctx.stepStatus, 'failed:no-door')
      assert.ok(ctx.buildSkip.includes(di), 'once per skip stamp: no build/gohome cycle')
      assert.equal(h.built, true)
    })
  })

  it('a dark door cell is unknown, not gone: no fail, built stays', () => {
    quiet(() => {
      const bot = mockBot({ at: { ...OUTSIDE }, door: false })
      const air = bot.blockAt
      bot.blockAt = (p) => (Math.floor(p.x) === DOOR.x && Math.floor(p.z) === DOOR.z ? null : air(p))
      const ctx = { home: ctxHome() }
      home.gohome(bot, ctx)
      assert.equal(ctx.gohome.phase, 'enter')
      assert.equal(ctx.home.built, true)
    })
  })

  it('a door that never reads open fails within ~10 ticks', () => {
    quiet(() => {
      const bot = mockBot({ at: { ...OUTSIDE }, timeOfDay: 15000 })
      bot.activateBlock = async () => {} // the toggle never lands
      const ctx = { home: ctxHome(), step: 'gohome', stepStatus: 'running' }
      let ticks = 0
      while (ctx.stepStatus === 'running' && ticks < 30) { home.gohome(bot, ctx); ticks++ }
      assert.equal(ctx.stepStatus, 'failed:door-stuck')
      assert.ok(ticks <= 12, `failed after ${ticks} ticks`)
      assert.equal(ctx.home.built, true, 'a standing door keeps the house built')
    })
  })

  it('stay: a door that never reads open at dawn fails within ~10 ticks (470s)', () => {
    quiet(() => {
      const bot = mockBot({ at: { ...INSIDE }, timeOfDay: 1000, doorOpen: false })
      bot.activateBlock = async () => {} // the toggle never lands
      const ctx = { home: ctxHome(), step: 'stay', stepStatus: 'running' }
      let ticks = 0
      while (ctx.stepStatus === 'running' && ticks < 30) { home.stay(bot, ctx); ticks++ }
      assert.equal(ctx.stepStatus, 'failed:door-stuck')
      assert.ok(ticks <= 12, `failed after ${ticks} ticks`)
    })
  })

  it('logs one line per phase change with aim and pos', async () => {
    const lines = quiet(() => {
      const bot = mockBot({ at: { x: 16, y: 64, z: 14 } })
      const ctx = { home: ctxHome() }
      home.gohome(bot, ctx)
      home.gohome(bot, ctx) // still walking: no new line
      bot.entity.position = { ...OUTSIDE }
      home.gohome(bot, ctx) // arrived -> open
    }).filter((l) => l.startsWith('gohome phase='))
    assert.equal(lines.length, 2)
    assert.match(lines[0], /^gohome phase=walk aim=11,64,19 pos=16,64,14 /)
    assert.match(lines[1], /^gohome phase=open aim=11,64,20 pos=11,64,19 /)
  })
})

describe('rw4.10 shelter run (flat legs sprint, night ticks stamped)', () => {
  const FAR = { x: 20, y: 64, z: 10 } // ~13 from the door: past sprint distance
  const flatNodes = [{ x: 18, y: 64, z: 12 }, { x: 16, y: 64, z: 14 }]
  function walkCtx(extra) {
    return Object.assign({
      home: ctxHome(),
      movements: { allowSprinting: false, allowParkour: true },
    }, extra)
  }
  // Real sequence: tick 1 issues the goal (nodes dropped), path_update lands
  // the plan, tick 2 gates on it. Returns after tick 2.
  function steadyWalk(bot, ctx, nodes) {
    home.gohome(bot, ctx)
    ctx.lastPathNodes = nodes === undefined ? flatNodes : nodes
    home.gohome(bot, ctx)
    body.movementsFor('work', bot, ctx, { sprint: true }) // post-dispatch refresh: the lease applies sprint
  }
  it('night walk far+flat sprints and stamps a fresh shelterRun', () => {
    const bot = mockBot({ at: { ...FAR }, timeOfDay: 15000 })
    const ctx = walkCtx()
    steadyWalk(bot, ctx)
    assert.equal(ctx.gohome.phase, 'walk')
    assert.equal(ctx.movements.allowSprinting, true)
    assert.equal(ctx.movements.allowParkour, false)
    assert.equal(typeof ctx.shelterRun, 'number')
    assert.ok(Date.now() - ctx.shelterRun < home.SHELTER_RUN_FRESH_MS)
  })
  it('near door: walks, still stamps at night (gait-independent)', () => {
    const bot = mockBot({ at: { x: 14, y: 64, z: 17 }, timeOfDay: 15000 })
    const ctx = walkCtx()
    steadyWalk(bot, ctx)
    assert.equal(ctx.gohome.phase, 'walk')
    assert.equal(ctx.movements.allowSprinting, false)
    assert.equal(typeof ctx.shelterRun, 'number')
  })
  it('+1 node in the window kills sprint but keeps the stamp', () => {
    // 3nt.24: sprint-jump would wedge on the step face.
    const bot = mockBot({ at: { ...FAR }, timeOfDay: 15000 })
    const ctx = walkCtx()
    steadyWalk(bot, ctx, [{ x: 18, y: 64, z: 12 }, { x: 17, y: 65, z: 13 }])
    assert.equal(ctx.movements.allowSprinting, false)
    assert.equal(ctx.movements.allowParkour, true)
    assert.equal(typeof ctx.shelterRun, 'number')
  })
  it('no plan nodes: no sprint (fail closed), stamp kept', () => {
    const bot = mockBot({ at: { ...FAR }, timeOfDay: 15000 })
    const ctx = walkCtx()
    steadyWalk(bot, ctx, null)
    assert.equal(ctx.movements.allowSprinting, false)
    assert.equal(typeof ctx.shelterRun, 'number')
  })
  it('day walk sprints but leaves no stamp', () => {
    const bot = mockBot({ at: { ...FAR }, timeOfDay: 6000 })
    const ctx = walkCtx()
    steadyWalk(bot, ctx)
    assert.equal(ctx.movements.allowSprinting, true)
    assert.equal(ctx.shelterRun, undefined)
  })
  it('goal-issue tick fails closed on stale nodes (revmux 02-review)', () => {
    const bot = mockBot({ at: { ...FAR }, timeOfDay: 15000 })
    const ctx = walkCtx({ lastGoalKey: 'gather', lastPathNodes: flatNodes })
    home.gohome(bot, ctx) // issues: stale nodes dropped, no sprint yet
    body.movementsFor('work', bot, ctx, { sprint: true }) // post-dispatch refresh
    assert.equal(ctx.gohome.phase, 'walk')
    assert.equal(ctx.lastPathNodes, null)
    assert.equal(ctx.movements.allowSprinting, false)
    ctx.lastPathNodes = flatNodes // path_update lands the fresh plan
    home.gohome(bot, ctx)
    body.movementsFor('work', bot, ctx, { sprint: true }) // post-dispatch refresh
    assert.equal(ctx.movements.allowSprinting, true)
  })
  it('off-walk ticks do not refresh the stamp', () => {
    const bot = mockBot({ at: { ...FAR }, timeOfDay: 15000 })
    const ctx = walkCtx()
    home.gohome(bot, ctx)
    const stamp = ctx.shelterRun
    assert.equal(typeof stamp, 'number')
    bot.entity.position = { ...OUTSIDE }
    home.gohome(bot, ctx) // arrived -> open leg, no walk
    assert.equal(ctx.gohome.phase, 'open')
    assert.equal(ctx.shelterRun, stamp)
  })
})

describe('rw4.14 dawn report (night tally)', () => {
  const { createLifecycle } = require('../src/index')

  function stayDone(at, setupCtx, atNight) {
    // Drive stay to the close-done chat: hold at dusk, exit at day.
    const bot = mockBot({ at, timeOfDay: 12500, doorOpen: false })
    const ctx = { home: ctxHome(), step: 'stay', stepStatus: 'running' }
    if (setupCtx) setupCtx(ctx, bot)
    home.stay(bot, ctx) // dusk: hold starts the tally
    if (atNight) atNight(ctx, bot) // the night happens before dawn
    bot.time.timeOfDay = 1000 // dawn
    const realNow = Date.now
    let now = realNow()
    Date.now = () => now
    try {
      home.stay(bot, ctx) // open: toggle the closed door
      home.stay(bot, ctx) // door open while inside: exit starts sneaking
      bot.entity.position = { ...OUTSIDE } // stepped out
      home.stay(bot, ctx) // exit arrives -> close, no toggle yet
      now += 5000
      home.stay(bot, ctx) // close it
      home.stay(bot, ctx) // shut -> done + report
    } finally {
      Date.now = realNow
    }
    return { bot, ctx }
  }

  it('counts deaths and banked haul since dusk', () => {
    const { bot, ctx } = stayDone({ x: 12, y: 64, z: 22 }, (ctx) => {
      ctx.deaths = 5
      ctx.haul = { coal: 20 }
    }, (ctx) => {
      // Night happens: 2 deaths, 14 coal banked.
      ctx.deaths = 7
      ctx.haul = { coal: 34 }
    })
    assert.equal(ctx.stepStatus, 'done')
    assert.ok(bot.chats.some((m) => m === 'night: survived, 2 deaths, banked 14 coal, at home; back to work'),
      bot.chats.join(' | '))
  })

  it('one death reads singular, empty haul reads nothing', () => {
    const bot2 = mockBot({ at: { x: 12, y: 64, z: 22 }, timeOfDay: 1000, doorOpen: false })
    const ctx2 = { home: ctxHome(), step: 'stay', stepStatus: 'running', deaths: 1, night: { deaths: 0, haul: {}, reported: false }, stay: { phase: 'close', stalls: 0, fails: 0, lastPos: null, lastToggle: 0 } }
    home.stay(bot2, ctx2)
    assert.ok(bot2.chats.some((m) => m === 'night: survived, 1 death, banked nothing, at home; back to work'),
      bot2.chats.join(' | '))
  })

  it('far from the site reads blocks-out, not at home', () => {
    const bot = mockBot({ at: { x: 60, y: 64, z: 20 }, timeOfDay: 1000, doorOpen: false })
    const ctx = {
      home: ctxHome(), step: 'stay', stepStatus: 'running', deaths: 0,
      night: { deaths: 0, haul: {}, reported: false },
      stay: { phase: 'close', stalls: 0, fails: 0, lastPos: null, lastToggle: 0 },
    }
    home.stay(bot, ctx)
    assert.ok(bot.chats.some((m) => m === 'night: survived, no deaths, banked nothing, 50 blocks from home; back to work'),
      bot.chats.join(' | '))
  })

  it('a second night step keeps the tally until the report', () => {
    const bot = mockBot({ at: { x: 12, y: 64, z: 22 }, timeOfDay: 12500, doorOpen: false })
    const ctx = { home: ctxHome(), step: 'stay', stepStatus: 'running', deaths: 3, haul: { coal: 1 } }
    home.stay(bot, ctx) // first stay: snapshots 3/coal:1
    ctx.deaths = 4 // a death, then the step restarts (gohome again after respawn)
    ctx.stay = null
    ctx.stepStatus = 'running'
    home.stay(bot, ctx) // second stay: tally NOT reset (unreported)
    assert.equal(ctx.night.deaths, 3, 'snapshot kept across episodes')
    assert.deepEqual(ctx.night.haul, { coal: 1 })
    ctx.night.reported = true // dawn reported...
    ctx.stay = null
    home.stay(bot, ctx) // ...next night starts fresh
    assert.equal(ctx.night.deaths, 4, 'fresh snapshot after the report')
    assert.equal(ctx.night.reported, false)
  })

  it('onDeath counts into ctx.deaths via noteDeath', () => {
    let noted = 0
    const life = createLifecycle({ noteDeath: () => { noted++ } })
    const bot = mockBot({ at: { x: 12, y: 64, z: 22 } })
    life.onDeath(bot, { noteDeath: () => { noted++ } })
    assert.equal(noted, 1)
  })
})

describe('rw4.14 tally days (revmux round 1)', () => {
  it('an unreported night never leaks into the next line', () => {
    // Dusk day 5: tally opens. No report (gohome walks past dawn / follow
    // order / failed close). Day 6 brings day deaths + day haul. Next dusk
    // re-snapshots deaths; the report covers night 6 only.
    const bot2 = mockBot({ at: { x: 12, y: 64, z: 22 }, timeOfDay: 12500, day: 5 })
    const ctx2 = { home: ctxHome(), step: 'stay', stepStatus: 'running', deaths: 5, haul: { coal: 20 } }
    home.stay(bot2, ctx2)
    assert.equal(ctx2.night.deaths, 5)
    assert.equal(ctx2.night.day, 5)
    // Day 6 happens with no report: 1 day death, 40 day coal.
    ctx2.deaths = 6
    ctx2.haul = { coal: 60 }
    bot2.time.day = 6
    bot2.time.timeOfDay = 12500
    ctx2.stay = null // next dusk, new episode
    home.stay(bot2, ctx2)
    assert.equal(ctx2.night.deaths, 6, 'fresh death snapshot, day death excluded')
    assert.equal(ctx2.night.day, 6)
    // Night 6 quiet; dawn report covers night 6 deaths only, haul since the
    // last report (none yet: cold-start dusk snapshot).
    bot2.time.timeOfDay = 1000
    const realNow = Date.now
    let now = realNow()
    Date.now = () => now
    try {
      home.stay(bot2, ctx2)
      home.stay(bot2, ctx2)
      bot2.entity.position = { ...OUTSIDE }
      home.stay(bot2, ctx2)
      now += 5000
      home.stay(bot2, ctx2)
      home.stay(bot2, ctx2)
    } finally {
      Date.now = realNow
    }
    assert.ok(bot2.chats.some((m) => m === 'night: survived, no deaths, banked 40 coal, at home; back to work'),
      bot2.chats.join(' | '))
  })

  it('haul spans dawn to dawn across a reported night', () => {
    // Dawn 1 reports (haul snaps at 20). Day forage banks 40. Night quiet.
    // Dawn 2 reports the day's haul, not 'banked nothing'.
    const bot = mockBot({ at: { x: 12, y: 64, z: 22 }, timeOfDay: 12500, day: 5 })
    const ctx = { home: ctxHome(), step: 'stay', stepStatus: 'running', deaths: 0, haul: { coal: 20 } }
    home.stay(bot, ctx)
    bot.time.timeOfDay = 1000
    const realNow = Date.now
    let now = realNow()
    Date.now = () => now
    const closeOut = (b, c) => {
      b.time.timeOfDay = 1000
      home.stay(b, c)
      home.stay(b, c)
      b.entity.position = { ...OUTSIDE }
      home.stay(b, c)
      now += 5000
      home.stay(b, c)
      home.stay(b, c)
    }
    try {
      closeOut(bot, ctx) // dawn 1: cold start, nothing new
      assert.ok(bot.chats.some((m) => m === 'night: survived, no deaths, banked nothing, at home; back to work'),
        bot.chats.join(' | '))
      assert.deepEqual(ctx.night.haul, { coal: 20 }, 'haul snaps at the report')
      ctx.haul = { coal: 60 } // day forage
      bot.time.day = 6
      bot.time.timeOfDay = 12500
      ctx.stay = null
      bot.entity.position = { x: 12, y: 64, z: 22 }
      home.stay(bot, ctx) // dusk 2: deaths re-snap, haul kept from dawn 1
      assert.deepEqual(ctx.night.haul, { coal: 20 }, 'dusk does not wipe the report snapshot')
      closeOut(bot, ctx) // dawn 2: the day's haul lands
      assert.ok(bot.chats.some((m) => m === 'night: survived, no deaths, banked 40 coal, at home; back to work'),
        bot.chats.join(' | '))
    } finally {
      Date.now = realNow
    }
  })
})

describe('rw4.12 gohome detour', () => {
  const danger = require('../src/danger')
  const FAR = { x: 30, y: 64, z: 19 } // straight leg to OUTSIDE runs along z=19
  const PIT = { x: 20, y: 60, z: 19 }

  it('a pit on the leg diverts the first goal perpendicular', () => {
    const bot = mockBot({ at: { ...FAR } })
    const ctx = { home: ctxHome() }
    danger.mark(ctx, PIT)
    home.gohome(bot, ctx)
    assert.equal(ctx.gohome.phase, 'walk')
    assert.equal(bot.calls.goals.length, 1)
    const g = bot.calls.goals[0]
    assert.equal(g.constructor.name, 'GoalNearXZ')
    assert.deepEqual({ x: g.x, z: g.z }, { x: 20, z: 11 })
  })

  it('reaching the waypoint re-issues direct to the door', () => {
    const bot = mockBot({ at: { ...FAR } })
    const ctx = { home: ctxHome() }
    danger.mark(ctx, PIT)
    home.gohome(bot, ctx) // issues the via goal
    bot.entity.position = { x: 20, y: 64, z: 11 } // walked around
    home.gohome(bot, ctx) // arrived at the waypoint, flips direct
    home.gohome(bot, ctx) // issues the direct goal
    assert.equal(bot.calls.goals.length, 2)
    const g = bot.calls.goals[1]
    assert.deepEqual({ x: g.x, y: g.y, z: g.z }, OUTSIDE)
  })

  it('diagonal arrival fires from the pathfinder near cell', () => {
    // The walk (40,0)->door is diagonal, so the raw waypoint is
    // fractional; GoalNearXZ aims at the floored cell and arrival reads
    // from its centre. The bot stops on the near cell (28,16).
    const bot = mockBot({ at: { x: 40, y: 64, z: 0 } })
    const ctx = { home: ctxHome() }
    danger.mark(ctx, { x: 25.5, y: 60, z: 9.5 })
    home.gohome(bot, ctx)
    const g0 = bot.calls.goals[0]
    assert.equal(g0.constructor.name, 'GoalNearXZ')
    assert.deepEqual({ x: g0.x, z: g0.z }, { x: 29, z: 16 })
    bot.entity.position = { x: 28.5, y: 64, z: 16.5 } // near end cell
    home.gohome(bot, ctx) // arrived: flips direct
    home.gohome(bot, ctx) // issues the direct goal
    assert.equal(bot.calls.goals.length, 2)
    const g1 = bot.calls.goals[1]
    assert.equal(g1.constructor.name, 'GoalNear')
    assert.deepEqual({ x: g1.x, y: g1.y, z: g1.z }, OUTSIDE)
  })

  it('a dead detour leg falls back to direct, once', () => {
    const bot = mockBot({ at: { ...FAR } }) // frozen: moving=false, never displaced
    const ctx = { home: ctxHome() }
    danger.mark(ctx, PIT)
    for (let i = 0; i < 35; i++) home.gohome(bot, ctx) // via leg stalls out
    assert.equal(ctx.stepStatus, 'running', 'detour death is not step death')
    assert.equal(ctx.gohome.viaDone, true)
    const last = bot.calls.goals[bot.calls.goals.length - 1]
    assert.deepEqual({ x: last.x, y: last.y, z: last.z }, OUTSIDE, 'falls back direct')
    let failed = null // direct leg dies too; catch it before the fresh episode
    for (let i = 0; i < 40 && !failed; i++) {
      home.gohome(bot, ctx)
      if (String(ctx.stepStatus).startsWith('failed:')) failed = ctx.stepStatus
    }
    assert.equal(failed, 'failed:cannot-reach-home', 'direct death fails honestly')
  })
})

describe('bv6 door lane', () => {
  // The open panel leaves a 0.8125 gap; the 0.6 body crossing at cell centre
  // clears it by ~1 cm, and diagonal entries rub for the whole 60-tick leg
  // (rig-m4: two nights failed:cannot-reach-home, door left open). The legs
  // cross on the free-gap lane instead: cell centre +/- half a panel.
  const LANE = 0.09375
  const OUT_CENTRE = { x: OUTSIDE.x + 0.5, y: OUTSIDE.y, z: OUTSIDE.z + 0.5 }
  const near = (v, want) => assert.ok(Math.abs(v - want) < 1e-9, `${v} ~= ${want}`)

  function enterAt(at, { facing = 'north', hinge = 'left', open = true } = {}) {
    const bot = mockBot({ at, doorOpen: open, doorFacing: facing, doorHinge: hinge })
    const ctx = {
      home: ctxHome(), step: 'gohome', stepStatus: 'running',
      gohome: { phase: 'enter', stalls: 0, fails: 0, lastPos: null, lastToggle: 0, legIdx: 0, legTicks: 0, legPos: null, legStall: 0, backing: 0 },
    }
    return { bot, ctx }
  }

  function lastLook(bot) {
    return bot.calls.looks[bot.calls.looks.length - 1]
  }

  it('enter aims the door leg at the free-gap lane, away from the panel', () => {
    // facing=north hinge=left: the panel hugs the west slice (mc-data
    // [0,0,0,0.1875,1,1]), so the lane sits east of centre, at the door
    // cell's near edge so the correction completes before the panel plane.
    const { bot, ctx } = enterAt({ ...OUT_CENTRE }, { hinge: 'left' })
    home.gohome(bot, ctx)
    const look = lastLook(bot)
    near(look.x, DOOR.x + 0.5 + LANE)
    near(look.z, DOOR.z + 0.1)
  })

  it('hinge=right mirrors the lane to the west side', () => {
    const { bot, ctx } = enterAt({ ...OUT_CENTRE }, { hinge: 'right' })
    home.gohome(bot, ctx)
    const look = lastLook(bot)
    near(look.x, DOOR.x + 0.5 - LANE)
    near(look.z, DOOR.z + 0.1)
  })

  it('south-facing doors mirror the hinge mapping', () => {
    // mc-data: south/left hugs east, south/right hugs west.
    for (const [hinge, sign] of [['left', -1], ['right', 1]]) {
      const { bot, ctx } = enterAt({ ...OUT_CENTRE }, { facing: 'south', hinge })
      home.gohome(bot, ctx)
      const look = lastLook(bot)
      near(look.x, DOOR.x + 0.5 + sign * LANE)
      near(look.z, DOOR.z + 0.1)
    }
  })

  it('east/west facing, closed, or unreadable props keep the centre crossing', () => {
    // No z gap (east/west panel spans the full width), nothing to lane on
    // when shut, fail closed when unreadable: the bare centre, exactly as
    // before (no near edge either).
    const cases = [
      mockBot({ at: { ...OUT_CENTRE }, doorOpen: true, doorFacing: 'east', doorHinge: 'left' }),
      mockBot({ at: { ...OUT_CENTRE }, doorOpen: true, doorFacing: 'west', doorHinge: 'right' }),
      mockBot({ at: { ...OUT_CENTRE }, doorOpen: true }),
      mockBot({ at: { ...OUT_CENTRE }, doorOpen: false, doorFacing: 'north', doorHinge: 'left' }),
    ]
    for (const bot of cases) {
      const ctx = {
        home: ctxHome(), step: 'gohome', stepStatus: 'running',
        gohome: { phase: 'enter', stalls: 0, fails: 0, lastPos: null, lastToggle: 0, legIdx: 0, legTicks: 0, legPos: null, legStall: 0, backing: 0 },
      }
      home.gohome(bot, ctx)
      const look = lastLook(bot)
      near(look.x, DOOR.x + 0.5)
      near(look.z, DOOR.z + 0.5)
    }
  })

  it('exit crosses on the lane at the south near edge', () => {
    const bot = mockBot({ at: { x: INSIDE.x + 0.5, y: INSIDE.y, z: INSIDE.z + 0.5 }, timeOfDay: 1000, doorOpen: true, doorFacing: 'north', doorHinge: 'left' })
    const ctx = {
      home: ctxHome(), step: 'stay', stepStatus: 'running',
      stay: { phase: 'exit', stalls: 0, fails: 0, lastPos: null, lastToggle: 0, legIdx: 0, legTicks: 0, legPos: null, legStall: 0, backing: 0 },
    }
    home.stay(bot, ctx)
    const look = lastLook(bot)
    near(look.x, DOOR.x + 0.5 + LANE)
    near(look.z, DOOR.z + 0.9)
  })

  it('the door leg advances on crossing the plane, not the window', () => {
    // Within 0.6 of the near-edge aim but still north of the plane: the leg
    // must keep aiming at the near edge (steep correction), not swap to the
    // far aim early and cut the corner into the panel.
    const { bot, ctx } = enterAt({ x: DOOR.x + 0.55, y: DOOR.y, z: DOOR.z - 0.35 }, { hinge: 'left' })
    ctx.gohome.legIdx = 1
    home.gohome(bot, ctx)
    assert.equal(ctx.gohome.legIdx, 1)
    const look = lastLook(bot)
    near(look.x, DOOR.x + 0.5 + LANE)
    near(look.z, DOOR.z + 0.1)
    bot.entity.position = { x: DOOR.x + 0.55, y: DOOR.y, z: DOOR.z + 0.05 } // over the plane
    home.gohome(bot, ctx)
    assert.equal(ctx.gohome.legIdx, 2)
  })

  it('enter reaches inside from typical walk-ends with panel clearance, either hinge', () => {
    // Bead acceptance: enter driven to inside in the harness. The mock walks
    // the look vector with a clamped step — the bot picks aims, physics
    // executes, so the test pins the aims' geometry — and tracks the
    // body-to-panel gap while the body centre crosses the door cell (a
    // leading-corner graze on approach slides; an engaged body wedges).
    // Pre-fix the centre crossing clears the panel by 0.0125 and fails
    // the 0.05 bar. At prod cadence (~1.3 blocks per 1s tick) the near-edge
    // aim can overshoot the lane into a shallow panel slide — steeper
    // pre-fix pushes wedge instead; the 4/4 live rig nights (both hinges,
    // PR evidence) are the proof the slide resolves (revmux 01 core-1).
    for (const hinge of ['left', 'right']) {
      const panelWest = hinge === 'left' // facing=north (mc-data slices)
      const face = panelWest ? DOOR.x + 0.1875 : DOOR.x + 0.8125
      for (const at of [
        { ...OUT_CENTRE },
        { x: OUTSIDE.x + 0.2, y: OUTSIDE.y, z: OUTSIDE.z + 0.3 },
        { x: OUTSIDE.x + 0.8, y: OUTSIDE.y, z: OUTSIDE.z + 0.6 },
      ]) {
        const { bot, ctx } = enterAt({ ...at }, { hinge })
        let minGap = Infinity
        let ticks = 0
        for (; ticks < 40 && ctx.gohome.phase === 'enter'; ticks++) {
          home.gohome(bot, ctx)
          if (ctx.gohome.phase !== 'enter') break
          const look = lastLook(bot)
          const p = bot.entity.position
          const dx = look.x - p.x
          const dz = look.z - p.z
          const d = Math.hypot(dx, dz)
          const step = Math.min(0.4, d)
          if (d > 1e-9) bot.entity.position = { x: p.x + (dx / d) * step, y: p.y, z: p.z + (dz / d) * step }
          const q = bot.entity.position
          if (q.z >= DOOR.z && q.z <= DOOR.z + 1) {
            const gap = panelWest ? (q.x - 0.3) - face : face - (q.x + 0.3)
            if (gap < minGap) minGap = gap
          }
        }
        const where = `hinge=${hinge} start=${JSON.stringify(at)}`
        assert.equal(ctx.gohome.phase, 'close', `${where} reaches close (got ${ctx.gohome.phase}@${ticks})`)
        assert.notEqual(ctx.stepStatus, 'failed:cannot-reach-home', where)
        assert.ok(minGap >= 0.05, `${where} clears the panel by ${minGap}`)
      }
    }
  })
})

describe('6xno home owns its door (revmux 01 major-2)', () => {
  it("home's toggle untracks the door from the A* reflex (no same-tick double)", () => {
    // The A* opener tracked the home door (a via-detour crossed it); the
    // close phase's toggle stands the reflex down so the two never click
    // the same door on independent cooldowns.
    const bot = mockBot({ at: { ...INSIDE }, doorOpen: true })
    const ctx = {
      home: ctxHome(), step: 'gohome', stepStatus: 'running',
      doorOpened: new Map([['11,64,20', { x: 11, y: 64, z: 20 }]]),
      gohome: { phase: 'close', stalls: 0, fails: 0, lastPos: null, lastToggle: 0 },
    }
    home.gohome(bot, ctx)
    assert.equal(bot.calls.activates, 1)
    assert.equal(ctx.doorOpened.size, 0, 'reflex still tracks the home door')
  })
})
