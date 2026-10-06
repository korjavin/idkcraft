'use strict'

// Bead idkcraft-jr2.3: 'come home' meets the owner in the common room, not a
// bedroom. Day or night the order walks the gohome door wire to the named
// meet target, says 'home', and HOLDS until countermanded — ending inside
// would hand the next step a through-wall A* plan (probed: unguarded eats
// two wall planks, guarded tunnels under the house). A move command while
// inside arms the exit legs first.

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const home = require('../src/behaviours/home')
const buildMod = require('../src/behaviours/build')
const body = require('../src/body')
const { createTicker, handleChat, BEHAVIOURS } = require('../src/index')
const { lookupCommand, detailLine } = require('../src/commands')

const SITE = { x: 10, y: 64, z: 20 }
// v2 door column, outside approach, common-room meet cell (door path).
const DOOR2 = { x: 13, y: 64, z: 20 }
const OUT2 = { x: 13, y: 64, z: 19 }
const MEET2 = { x: 13, y: 64, z: 21 }
// v1 door column and inside cell.
const DOOR1 = { x: 11, y: 64, z: 20 }
const OUT1 = { x: 11, y: 64, z: 19 }
const MEET1 = { x: 11, y: 64, z: 21 }

function doorBot({ at, door = DOOR2, timeOfDay = 6000, day = 5, doorOpen = false, moving = false, hasDoor = true, players = {} } = {}) {
  const chats = []
  const calls = { goals: [], activates: 0, looks: [], controls: [], clears: 0 }
  const state = { doorOpen }
  const bot = {
    chats,
    calls,
    username: 'IdkBot',
    players,
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
      if (hasDoor && fx === door.x && (fy === door.y || fy === door.y + 1) && fz === door.z) {
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

function v2home() {
  return {
    site: { ...SITE },
    built: true,
    v: 2,
    interior: { min: { x: 11, y: 64, z: 21 }, max: { x: 15, y: 65, z: 24 } },
  }
}

function v1home() {
  return {
    site: { ...SITE },
    built: true,
    v: 1,
    interior: { min: { x: 11, y: 64, z: 21 }, max: { x: 12, y: 65, z: 22 } },
  }
}

const settle = async (n = 5) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)) }

describe('jr2.3 meet target: common room, never a bedroom', () => {
  it('meetPos is the v2 common-room door-path cell (3,+1)', () => {
    const m = home.meetPos({ site: { ...SITE }, v: 2 })
    assert.deepEqual({ x: m.x, y: m.y, z: m.z }, MEET2)
  })

  it('meetPos is the v1 inside cell (1,+1)', () => {
    const m = home.meetPos({ site: { ...SITE }, v: 1 })
    assert.deepEqual({ x: m.x, y: m.y, z: m.z }, MEET1)
  })

  it('comehome is registered as a behaviour', () => {
    assert.equal(typeof BEHAVIOURS.comehome, 'function')
  })
})

describe('jr2.3 day order walks the door wire into the v2 common room', () => {
  it('far outside walks to the cell before the door', () => {
    const bot = doorBot({ at: { x: 20, y: 64, z: 14 } })
    const ctx = { home: v2home(), comehome: home.startMeet('Steve', false, v2home()) }
    home.comehome(bot, ctx)
    assert.equal(bot.calls.goals.length, 1)
    const g = bot.calls.goals[0]
    assert.equal(g.constructor.name, 'GoalNear')
    assert.deepEqual({ x: g.x, y: g.y, z: g.z }, OUT2)
    assert.equal(ctx.comehome.phase, 'walk')
    assert.equal(bot.pathfinder.movements.canDig, false)
  })

  it('walk arrival opens, sneaks in by direct control, shuts, says home, holds', async () => {
    const bot = doorBot({ at: { ...OUT2 } })
    const ctx = { home: v2home(), comehome: home.startMeet('Steve', false, v2home()) }
    home.comehome(bot, ctx) // walk arrived -> open, toggle fires
    await settle()
    assert.equal(ctx.comehome.phase, 'open')
    assert.equal(bot.calls.activates, 1)
    home.comehome(bot, ctx) // door open -> enter, doorway legs bypass A*
    assert.equal(ctx.comehome.phase, 'enter')
    assert.deepEqual(bot.calls.goals, [])
    const look = bot.calls.looks[bot.calls.looks.length - 1]
    assert.deepEqual([look.x, look.z], [OUT2.x + 0.5, OUT2.z + 0.5]) // staged via out-centre
    bot.entity.position = { x: MEET2.x, y: MEET2.y, z: MEET2.z + 0.5 } // fully past the door plane
    ctx.comehome.lastToggle = 0 // test ticks are instant; live walking covers the cooldown
    home.comehome(bot, ctx) // inside -> close, toggle shuts the open door
    await settle()
    assert.equal(ctx.comehome.phase, 'close')
    assert.equal(bot.calls.activates, 2)
    home.comehome(bot, ctx) // door shut -> home + hold
    assert.equal(ctx.comehome.phase, 'hold')
    assert.equal(ctx.stepStatus, 'done')
    assert.equal(ctx.inShelter, true)
    assert.ok(bot.chats.includes('home'), bot.chats.join(' | '))
    assert.ok(!bot.chats.includes('home for the night'), 'meet, not the night line')
    // Hold: no more goals, no more toggles.
    home.comehome(bot, ctx)
    home.comehome(bot, ctx)
    assert.equal(ctx.comehome.phase, 'hold')
    assert.deepEqual(bot.calls.goals, [])
    assert.equal(bot.calls.activates, 2)
  })

  it('v1 order walks the old door into the hut', async () => {
    const bot = doorBot({ at: { x: 16, y: 64, z: 14 }, door: DOOR1 })
    const ctx = { home: v1home(), comehome: home.startMeet('Steve', false, v1home()) }
    home.comehome(bot, ctx)
    assert.equal(bot.calls.goals.length, 1)
    assert.deepEqual({ x: bot.calls.goals[0].x, y: bot.calls.goals[0].y, z: bot.calls.goals[0].z }, OUT1)
    bot.entity.position = { ...OUT1 }
    home.comehome(bot, ctx)
    await settle()
    assert.equal(bot.calls.activates, 1)
    home.comehome(bot, ctx)
    assert.equal(ctx.comehome.phase, 'enter')
    bot.entity.position = { x: MEET1.x, y: MEET1.y, z: MEET1.z + 0.5 }
    ctx.comehome.lastToggle = 0
    home.comehome(bot, ctx)
    await settle()
    home.comehome(bot, ctx)
    assert.equal(ctx.comehome.phase, 'hold')
    assert.ok(bot.chats.includes('home'))
  })
})

describe('jr2.3 inside means the standing block, not the float', () => {
  function at(x, y, z) {
    return doorBot({ at: { x, y, z } })
  }

  it('back row and east column read inside (live: z=4.5 walked at the door)', () => {
    const h = v2home() // interior x 11..15, z 21..24
    assert.equal(home.isInside(at(12.5, 64, 24.5), h), true, 'bedroom back row')
    assert.equal(home.isInside(at(15.9, 64, 22), h), true, 'east column')
    assert.equal(home.isInside(at(13, 64, 21), h), true, 'meet cell')
  })

  it('the doorway and the yard still read outside', () => {
    const h = v2home()
    assert.equal(home.isInside(at(13.5, 64, 20.5), h), false, 'mid-doorway')
    assert.equal(home.isInside(at(13, 64, 19), h), false, 'approach cell')
    assert.equal(home.isInside(at(16, 64, 22), h), false, 'past the east wall')
    assert.equal(home.isInside(at(13, 64, 25), h), false, 'past the back wall')
  })

  it('hold and seat at fractional cells stay in the room', () => {
    const holdBot = at(12.5, 64, 24.5)
    const holdCtx = { home: v2home(), comehome: { ...home.startMeet('Steve', true, v2home()), phase: 'hold' }, inShelter: true }
    home.comehome(holdBot, holdCtx)
    assert.equal(holdCtx.comehome.phase, 'hold', 'back-row hold does not re-walk')
    const seatBot = at(12.5, 64, 24.5)
    const seatCtx = { home: v2home(), comehome: { ...home.startMeet('Steve', true, v2home()), phase: 'seat' } }
    home.comehome(seatBot, seatCtx)
    assert.equal(seatCtx.comehome.phase, 'seat', 'back-row seat does not flip to walk')
  })
})

describe('jr2.3 settle walks a bedroom to the common room, never holds it', () => {
  it('ordered in the bedroom seats via A*, then home + hold', () => {
    const bot = doorBot({ at: { x: 13, y: 64, z: 24 } }) // v2 bedroom, past the partition
    const ctx = { home: v2home(), comehome: home.startMeet('Steve', true, v2home()) }
    home.comehome(bot, ctx)
    assert.equal(ctx.comehome.phase, 'seat', 'far from the meet cell: seat first')
    home.comehome(bot, ctx)
    assert.equal(bot.pathfinder.movements.canDig, false, 'no digging the furniture')
    assert.equal(bot.calls.goals.length, 1, 'A* around the partition posts')
    const g = bot.calls.goals[0]
    assert.deepEqual({ x: g.x, y: g.y, z: g.z }, MEET2)
    bot.entity.position = { x: MEET2.x + 0.5, y: MEET2.y, z: MEET2.z + 0.5 }
    home.comehome(bot, ctx)
    assert.equal(ctx.comehome.phase, 'hold')
    assert.deepEqual(bot.chats, ['home'])
    assert.equal(bot.pathfinder.movements.canDig, true, 'borrow restored')
  })

  it('a stalled seat fails loud with the room line', () => {
    const bot = doorBot({ at: { x: 13, y: 64, z: 24 }, moving: false })
    const ctx = { home: v2home(), comehome: home.startMeet('Steve', true, v2home()) }
    home.comehome(bot, ctx)
    assert.equal(ctx.comehome.phase, 'seat')
    for (let i = 0; i < 40 && ctx.comehome; i++) home.comehome(bot, ctx)
    assert.equal(ctx.comehome, null)
    assert.equal(ctx.stepStatus, 'failed:cannot-seat')
    assert.deepEqual(bot.chats, ['cannot reach the common room'])
    assert.equal(bot.pathfinder.movements.canDig, true)
  })

  it('a seat stopping at 1.4 arrives (no dead band past GoalNear)', () => {
    const bot = doorBot({ at: { x: MEET2.x + 1.9, y: MEET2.y, z: MEET2.z + 0.5 } }) // 1.4 off centre
    const ctx = { home: v2home(), comehome: { ...home.startMeet('Steve', true, v2home()), phase: 'seat' } }
    home.comehome(bot, ctx)
    assert.equal(ctx.comehome.phase, 'hold')
    assert.deepEqual(bot.chats, ['home'])
  })

  it('seat teleported out walks back instead', () => {
    const bot = doorBot({ at: { x: 20, y: 64, z: 14 } })
    const ctx = { home: v2home(), comehome: { ...home.startMeet('Steve', true, v2home()), phase: 'seat' } }
    home.comehome(bot, ctx)
    assert.equal(ctx.comehome.phase, 'walk')
    assert.deepEqual(bot.chats, [], 're-arm is silent')
  })

  it('near the meet cell settles at once (v1 always, walk-in repeats)', () => {
    const bot = doorBot({ at: { x: MEET2.x + 0.5, y: MEET2.y, z: MEET2.z + 0.9 } }) // live walk-in end
    const ctx = { home: v2home(), comehome: home.startMeet('Steve', true, v2home()) }
    home.comehome(bot, ctx)
    assert.equal(ctx.comehome.phase, 'hold', 'no seating dance')
    assert.deepEqual(bot.chats, ['home'])
    const v1 = doorBot({ at: { x: MEET1.x + 1, y: MEET1.y, z: MEET1.z + 1 }, door: DOOR1 })
    const v1ctx = { home: v1home(), comehome: home.startMeet('Steve', true, v1home()) }
    home.comehome(v1, v1ctx)
    assert.equal(v1ctx.comehome.phase, 'hold', 'v1 maxes at 1.41: never seats')
  })
})

describe('jr2.3 hold secures the night door, never fights the owner by day', () => {
  it('night + open holds the toggle shut (stay rw4.8, night half)', async () => {
    const bot = doorBot({ at: { ...MEET2 }, timeOfDay: 15000, doorOpen: true })
    const ctx = { home: v2home(), comehome: { ...home.startMeet('Steve', true, v2home()), phase: 'hold' }, inShelter: true }
    home.comehome(bot, ctx)
    await settle()
    assert.equal(bot.calls.activates, 1, 'shuts the open door at night')
    assert.equal(ctx.comehome.phase, 'hold')
    assert.equal(ctx.inShelter, true)
  })

  it('missing door drops the shelter flag so pursuit stays legal', () => {
    const bot = doorBot({ at: { ...MEET2 }, hasDoor: false })
    const ctx = { home: v2home(), comehome: { ...home.startMeet('Steve', true, v2home()), phase: 'hold' }, inShelter: true }
    home.comehome(bot, ctx)
    assert.equal(ctx.inShelter, false, 'no door, no shelter')
    assert.equal(ctx.comehome.phase, 'hold')
  })

  it('day + open leaves the door to the owner', () => {
    const bot = doorBot({ at: { ...MEET2 }, doorOpen: true })
    const ctx = { home: v2home(), comehome: { ...home.startMeet('Steve', true, v2home()), phase: 'hold' }, inShelter: true }
    home.comehome(bot, ctx)
    home.comehome(bot, ctx)
    assert.equal(bot.calls.activates, 0, 'never re-closes into the owner by day')
    assert.equal(ctx.inShelter, true)
  })

  it('night + open + owner at the door waits for them to clear it', async () => {
    const atDoor = { Steve: { username: 'Steve', entity: { position: { x: 13.5, y: 64, z: 19 } } } }
    const bot = doorBot({ at: { ...MEET2 }, timeOfDay: 15000, doorOpen: true, players: atDoor })
    const ctx = { home: v2home(), comehome: { ...home.startMeet('Steve', true, v2home()), phase: 'hold' }, inShelter: true }
    home.comehome(bot, ctx)
    home.comehome(bot, ctx)
    await settle()
    assert.equal(bot.calls.activates, 0, 'never shuts the door on the owner')
    assert.equal(ctx.comehome.phase, 'hold')
  })

  it('night + open shuts behind an owner already in the room', async () => {
    const inRoom = { Steve: { username: 'Steve', entity: { position: { x: 12.5, y: 64, z: 21.5 } } } }
    const bot = doorBot({ at: { ...MEET2 }, timeOfDay: 15000, doorOpen: true, players: inRoom })
    const ctx = { home: v2home(), comehome: { ...home.startMeet('Steve', true, v2home()), phase: 'hold' }, inShelter: true }
    home.comehome(bot, ctx)
    await settle()
    assert.equal(bot.calls.activates, 1, 'in for the night: secure the door')
  })

  it('night + open waits for an owner mid-doorway', async () => {
    const midDoor = { Steve: { username: 'Steve', entity: { position: { x: 13.5, y: 64, z: 20.5 } } } }
    const bot = doorBot({ at: { ...MEET2 }, timeOfDay: 15000, doorOpen: true, players: midDoor })
    const ctx = { home: v2home(), comehome: { ...home.startMeet('Steve', true, v2home()), phase: 'hold' }, inShelter: true }
    home.comehome(bot, ctx)
    home.comehome(bot, ctx)
    await settle()
    assert.equal(bot.calls.activates, 0, 'never shuts the panel on them')
  })

  it('night + open still shuts once the owner clears the door', async () => {
    const away = { Steve: { username: 'Steve', entity: { position: { x: 30, y: 64, z: 30 } } } }
    const bot = doorBot({ at: { ...MEET2 }, timeOfDay: 15000, doorOpen: true, players: away })
    const ctx = { home: v2home(), comehome: { ...home.startMeet('Steve', true, v2home()), phase: 'hold' }, inShelter: true }
    home.comehome(bot, ctx)
    await settle()
    assert.equal(bot.calls.activates, 1, 'secures the empty house')
  })

  it('the grace counts the roster, never the bot itself', async () => {
    const self = { IdkBot: { username: 'IdkBot', entity: { position: { x: 13.5, y: 64, z: 19 } } } }
    const bot = doorBot({ at: { ...MEET2 }, timeOfDay: 15000, doorOpen: true, players: self })
    const ctx = { home: v2home(), comehome: { ...home.startMeet('Steve', true, v2home()), phase: 'hold' }, inShelter: true }
    home.comehome(bot, ctx)
    await settle()
    assert.equal(bot.calls.activates, 1, 'a self entry must not disarm the night rule')
  })
})

describe('jr2.3 reseek walks the current home after exiting the old', () => {
  it('exit completion with reseek re-arms the walk to ctx.home', () => {
    const old = v2home()
    const fresh = { ...v2home(), site: { x: 100, y: 64, z: 100 } }
    const bot = doorBot({ at: { ...OUT2 } })
    const ctx = {
      home: fresh,
      comehome: { ...home.startMeet('Steve', true, old), phase: 'close', exiting: true, reseek: true },
      inShelter: true,
    }
    home.comehome(bot, ctx) // shut door, near: release completes into reseek
    assert.ok(ctx.comehome, 'order continues')
    assert.equal(ctx.comehome.phase, 'walk')
    assert.equal(ctx.comehome.exiting, false)
    assert.deepEqual(ctx.comehome.home.site, fresh.site, 'walks the current home')
    assert.equal(ctx.inShelter, false)
    assert.deepEqual(bot.chats, [], 'silent handoff')
  })
})

describe('jr2.3 night order runs the same wire to the common room', () => {
  it('far+flat night walk sprints but stamps no shelter run (orders fight)', () => {
    const bot = doorBot({ at: { x: 22, y: 64, z: 12 }, timeOfDay: 15000 })
    const ctx = {
      home: v2home(),
      comehome: home.startMeet('Steve', false, v2home()),
      movements: { allowSprinting: false, allowParkour: true },
    }
    home.comehome(bot, ctx)
    ctx.lastPathNodes = [{ x: 20, y: 64, z: 14 }, { x: 18, y: 64, z: 16 }]
    home.comehome(bot, ctx)
    body.movementsFor('comehome', bot, ctx, { sprint: true }) // post-dispatch refresh
    assert.equal(ctx.comehome.phase, 'walk')
    assert.equal(ctx.movements.allowSprinting, true)
    assert.equal(ctx.shelterRun, undefined, 'meet is an order: fight preempts, no shelter hold')
  })

  it('night arrival meets in the common room, never the bedroom', async () => {
    const bot = doorBot({ at: { ...OUT2 }, timeOfDay: 15000 })
    const ctx = { home: v2home(), comehome: home.startMeet('Steve', false, v2home()) }
    home.comehome(bot, ctx)
    await settle()
    home.comehome(bot, ctx)
    assert.equal(ctx.comehome.phase, 'enter')
    bot.entity.position = { x: MEET2.x, y: MEET2.y, z: MEET2.z + 0.5 }
    ctx.comehome.lastToggle = 0
    home.comehome(bot, ctx)
    await settle()
    home.comehome(bot, ctx)
    assert.equal(ctx.comehome.phase, 'hold')
    assert.ok(bot.chats.includes('home'))
    // Common room (z1..2 of site), not a bedroom (z4): the meet target.
    assert.ok(bot.entity.position.z < SITE.z + 3, 'holds in the common room')
  })
})

describe('jr2.3 meet failures end out loud', () => {
  it('ordered while already inside settles: home, hold, door untouched', async () => {
    for (const doorOpen of [false, true]) {
      const bot = doorBot({ at: { ...MEET2 }, doorOpen })
      const ctx = { home: v2home(), comehome: home.startMeet('Steve', true, v2home()) }
      home.comehome(bot, ctx)
      await settle()
      assert.equal(ctx.comehome.phase, 'hold')
      assert.deepEqual(bot.chats, ['home'])
      assert.equal(bot.calls.activates, 0, 'settle never works the door')
      assert.equal(ctx.inShelter, true)
    }
  })

  it('walked in to find the door gone: one line, order released, digging back', async () => {
    const bot = doorBot({ at: { ...OUT2 }, hasDoor: false })
    const ctx = { home: v2home(), comehome: home.startMeet('Steve', false, v2home()) }
    home.comehome(bot, ctx) // arrived -> open, no door, straight to enter
    assert.equal(ctx.comehome.phase, 'enter')
    bot.entity.position = { x: MEET2.x, y: MEET2.y, z: MEET2.z + 0.5 }
    home.comehome(bot, ctx) // inside -> close -> no-door fail in one tick
    assert.deepEqual(bot.chats, ['cannot reach home: no door'])
    assert.equal(ctx.comehome, null)
    assert.equal(ctx.stepStatus, 'failed:no-door')
    assert.equal(bot.pathfinder.movements.canDig, true)
  })

  it('a stalled walk fails loud and releases the body', () => {
    const bot = doorBot({ at: { x: 20, y: 64, z: 14 }, moving: false })
    const ctx = { home: v2home(), comehome: home.startMeet('Steve', false, v2home()) }
    for (let i = 0; i < 31; i++) {
      if (!ctx.comehome) break
      home.comehome(bot, ctx)
    }
    assert.equal(ctx.comehome, null)
    assert.equal(ctx.stepStatus, 'failed:cannot-reach-home')
    assert.deepEqual(bot.chats, ['cannot reach home'])
  })

  it('a door that never reads open fails within ~10 ticks (xhqv, gohome 1l9 cap)', () => {
    const bot = doorBot({ at: { ...OUT2 } })
    bot.activateBlock = async () => {} // the toggle never lands
    const ctx = { home: v2home(), comehome: home.startMeet('Steve', false, v2home()) }
    let ticks = 0
    while (ctx.comehome && ticks < 30) { home.comehome(bot, ctx); ticks++ }
    assert.equal(ctx.stepStatus, 'failed:door-stuck')
    assert.ok(ticks <= 12, `failed after ${ticks} ticks`)
    assert.deepEqual(bot.chats, ['cannot reach home: door stuck'])
  })

  it('no home fails loud without touching the door', () => {
    const bot = doorBot({ at: { ...OUT2 } })
    const ctx = { comehome: home.startMeet('Steve', false) }
    home.comehome(bot, ctx)
    assert.deepEqual(bot.chats, ['cannot reach home: no home'])
    assert.equal(ctx.comehome, null)
    assert.equal(bot.calls.activates, 0)
    assert.equal(bot.calls.goals.length, 0)
  })

  it('hold outside (death, teleport) silently walks back home', () => {
    const bot = doorBot({ at: { x: 20, y: 64, z: 14 } })
    const ctx = { home: v2home(), comehome: { ...home.startMeet('Steve', true, v2home()), phase: 'hold' } }
    home.comehome(bot, ctx)
    assert.equal(ctx.comehome.phase, 'walk')
    assert.deepEqual(bot.chats, [], 're-arm is silent')
    home.comehome(bot, ctx)
    assert.equal(bot.calls.goals.length, 1, 'walking again')
  })
})

describe('jr2.3 release walks the doorway before the new mode', () => {
  it('release outside simply ends the order', () => {
    const bot = doorBot({ at: { x: 20, y: 64, z: 14 } })
    const ctx = { home: v2home(), comehome: home.startMeet('Steve', false, v2home()), inShelter: false }
    home.releaseMeet(bot, ctx)
    assert.equal(ctx.comehome, null)
    assert.equal(ctx.inShelter, false)
  })

  it('release inside arms the exit and shelters it', () => {
    const bot = doorBot({ at: { ...MEET2 } })
    const ctx = { home: v2home(), comehome: { ...home.startMeet('Steve', true, v2home()), phase: 'hold' }, inShelter: true }
    home.releaseMeet(bot, ctx)
    assert.equal(ctx.comehome.exiting, true)
    assert.equal(ctx.comehome.phase, 'open')
    assert.equal(ctx.inShelter, true, 'fight cannot preempt the doorway')
  })

  it('double release never resets running legs', () => {
    const bot = doorBot({ at: { ...MEET2 }, doorOpen: true })
    const ctx = { home: v2home(), comehome: { ...home.startMeet('Steve', true, v2home()), phase: 'hold' } }
    home.releaseMeet(bot, ctx)
    home.comehome(bot, ctx) // open door -> exit legs start
    home.comehome(bot, ctx)
    home.comehome(bot, ctx)
    const ticks = ctx.comehome.legTicks
    assert.ok(ticks > 0, 'legs running')
    home.releaseMeet(bot, ctx) // second release path (setBring + startBlockOrder)
    assert.equal(ctx.comehome.legTicks, ticks, 'legs untouched')
    assert.equal(ctx.comehome.exiting, true)
  })

  it('exit opens, sneaks out by direct control, shuts, releases silent', async () => {
    const bot = doorBot({ at: { ...MEET2 } })
    const ctx = { home: v2home(), comehome: { ...home.startMeet('Steve', true, v2home()), phase: 'hold' }, inShelter: true }
    home.releaseMeet(bot, ctx)
    home.comehome(bot, ctx) // open the shut door
    await settle()
    assert.equal(bot.calls.activates, 1)
    home.comehome(bot, ctx) // door open -> exit legs, no A* (doors unroutable)
    assert.equal(ctx.comehome.phase, 'exit')
    assert.deepEqual(bot.calls.goals, [])
    const look = bot.calls.looks[bot.calls.looks.length - 1]
    assert.deepEqual([look.x, look.z], [MEET2.x + 0.5, MEET2.z + 0.5]) // staged via the meet cell
    bot.entity.position = { ...OUT2 } // stepped out
    home.comehome(bot, ctx)
    assert.equal(ctx.comehome.phase, 'close')
    assert.equal(bot.calls.activates, 1)
    ctx.comehome.lastToggle = 0
    home.comehome(bot, ctx)
    await settle()
    assert.equal(bot.calls.activates, 2)
    home.comehome(bot, ctx)
    assert.equal(ctx.comehome, null, 'released to the new mode')
    assert.equal(ctx.inShelter, false)
    assert.deepEqual(bot.chats, [], 'the new command already spoke')
  })

  it('exit with the door gone releases silent at the gap', async () => {
    const bot = doorBot({ at: { ...MEET2 }, hasDoor: false })
    const ctx = { home: v2home(), comehome: { ...home.startMeet('Steve', true, v2home()), phase: 'hold' }, inShelter: true }
    home.releaseMeet(bot, ctx)
    home.comehome(bot, ctx) // no door -> straight to the exit legs
    assert.equal(ctx.comehome.phase, 'exit')
    bot.entity.position = { ...OUT2 }
    home.comehome(bot, ctx)
    assert.equal(ctx.comehome, null, 'gap walked, nothing to shut')
    assert.equal(ctx.inShelter, false)
    assert.deepEqual(bot.chats, [])
  })

  it('a wedged exit leg re-arms silently instead of failing into wall pathing', () => {
    const bot = doorBot({ at: { ...MEET2 }, doorOpen: true })
    const ctx = { home: v2home(), comehome: { ...home.startMeet('Steve', true, v2home()), phase: 'hold' } }
    home.releaseMeet(bot, ctx)
    home.comehome(bot, ctx)
    assert.equal(ctx.comehome.phase, 'exit')
    for (let i = 0; i < 60; i++) home.comehome(bot, ctx) // stationary: the leg cap trips
    assert.ok(ctx.comehome, 'still releasing, never terminally failed')
    assert.equal(ctx.comehome.exiting, true)
    assert.equal(ctx.comehome.phase, 'open', 'fresh legs')
    assert.equal(ctx.comehome.committed, true, 're-arm proves the legs drove (rw4.18/04)')
    assert.deepEqual(bot.chats, [], 'silent like stay')
  })

  it('exit: a door that never reads open fails within ~10 ticks (470s)', () => {
    const bot = doorBot({ at: { ...MEET2 } })
    bot.activateBlock = async () => {} // the toggle never lands
    const ctx = { home: v2home(), comehome: { ...home.startMeet('Steve', true, v2home()), phase: 'open', exiting: true }, inShelter: true }
    let ticks = 0
    while (ctx.comehome && ticks < 30) { home.comehome(bot, ctx); ticks++ }
    assert.equal(ctx.stepStatus, 'failed:door-stuck')
    assert.ok(ticks <= 12, `failed after ${ticks} ticks`)
    assert.equal(ctx.inShelter, false)
    assert.deepEqual(bot.chats, ['cannot get out: door stuck'])
  })

  it('rw4.17: release inside arms the wall guard (backstop for an unsheltered release)', () => {
    // The exit may yet release unsheltered-while-inside (door-stuck fail, an
    // order handover clearing inShelter) — the next A* from inside must not
    // eat the walls (#311 reuse: guardOwnWalls on the exit path).
    const bot = doorBot({ at: { ...MEET2 } })
    bot.registry = { blocksByName: { oak_planks: { id: 5 }, oak_door: { id: 6 } } }
    bot.pathfinder.movements.exclusionAreasBreak = []
    const ctx = { home: v2home(), comehome: { ...home.startMeet('Steve', true, v2home()), phase: 'hold' }, inShelter: true }
    home.releaseMeet(bot, ctx)
    assert.equal(ctx.comehome.exiting, true)
    assert.equal(ctx.inShelter, true)
    assert.equal(bot.pathfinder.movements.exclusionAreasBreak.length, 1, 'the wall guard is installed')
    assert.equal(typeof ctx.buildGuardFn, 'function')
  })

  it('rw4.17: exit door-stuck fail while inside leaves the wall guard armed', () => {
    // The exiting order is built directly (no releaseMeet): this pins the
    // fail-site arming — the released body's A* routes via door/gap, never
    // through the walls.
    const bot = doorBot({ at: { ...MEET2 } })
    bot.registry = { blocksByName: { oak_planks: { id: 5 }, oak_door: { id: 6 } } }
    bot.pathfinder.movements.exclusionAreasBreak = []
    bot.activateBlock = async () => {} // the toggle never lands
    const ctx = { home: v2home(), comehome: { ...home.startMeet('Steve', true, v2home()), phase: 'open', exiting: true }, inShelter: true }
    let ticks = 0
    while (ctx.comehome && ticks < 30) { home.comehome(bot, ctx); ticks++ }
    assert.equal(ctx.stepStatus, 'failed:door-stuck')
    assert.equal(ctx.comehome, null)
    assert.equal(ctx.inShelter, false)
    assert.deepEqual(bot.chats, ['cannot get out: door stuck'])
    assert.equal(bot.pathfinder.movements.exclusionAreasBreak.length, 1, 'the released body keeps the wall guard')
    assert.equal(typeof ctx.buildGuardFn, 'function')
  })

  it('rw4.17: exit fail after a home swap guards the exited (old) box, not the new site', () => {
    // 'build here' mid-exit pins the old house on the order: the guard box
    // must follow the exited house, or the released A* eats the old walls.
    const bot = doorBot({ at: { ...MEET2 } })
    bot.registry = { blocksByName: { oak_planks: { id: 5 }, oak_door: { id: 6 } } }
    bot.pathfinder.movements.exclusionAreasBreak = []
    bot.activateBlock = async () => {} // the toggle never lands
    const old = v2home()
    const fresh = v2home()
    fresh.site = { x: 100, y: 64, z: 100 }
    fresh.interior = { min: { x: 101, y: 64, z: 101 }, max: { x: 105, y: 65, z: 104 } }
    const ctx = { home: fresh, comehome: { ...home.startMeet('Steve', true, old), phase: 'open', exiting: true }, inShelter: true }
    let ticks = 0
    while (ctx.comehome && ticks < 30) { home.comehome(bot, ctx); ticks++ }
    assert.equal(ctx.stepStatus, 'failed:door-stuck')
    // Read through the live array (what A* sees): a detached closure would
    // still answer 100 for its box.
    const seen = (x, y, z) => bot.pathfinder.movements.exclusionAreasBreak
      .reduce((m, f) => Math.max(m, f({ type: 5, position: { x, y, z } })), 0)
    assert.equal(bot.pathfinder.movements.exclusionAreasBreak.length, 1, 'the wall guard is installed')
    assert.equal(seen(11, 64, 20), 100, 'old wall cell guarded')
    assert.equal(seen(101, 64, 100), 0, 'new site box not guarded by the exit')
    // Revmux 01 minor: the next build/light tick re-keys to ctx.home (the
    // new site) — the exited box must hold while the body stands inside it.
    buildMod.guardOwnWalls(bot, ctx)
    assert.equal(bot.pathfinder.movements.exclusionAreasBreak.length, 1, 'single slot, no duplicate guard')
    assert.equal(seen(11, 64, 20), 100, 'old wall cell STILL guarded after a re-key tick')
    // Once outside, the next re-key frees the old box and guards the new
    // site — the sticky box never leaks.
    bot.entity.position = { x: 200, y: 64, z: 200 }
    buildMod.guardOwnWalls(bot, ctx)
    assert.equal(seen(101, 64, 100), 100, 'new site guarded once outside')
    assert.equal(seen(11, 64, 20), 0, 'old box freed once outside')
  })

  it('already outside (died mid-exit) releases at once', () => {
    const bot = doorBot({ at: { x: 0, y: 64, z: 0 } })
    const ctx = { home: v2home(), comehome: { ...home.startMeet('Steve', true, v2home()), phase: 'open', exiting: true }, inShelter: true }
    home.comehome(bot, ctx)
    assert.equal(ctx.comehome, null)
    assert.equal(ctx.inShelter, false)
    assert.deepEqual(bot.chats, [])
  })

  it('mid-legs past toggle reach releases; in the doorway it walks on', () => {
    // Teleported 8 out mid-exit: out is out, nothing to shut.
    const far = doorBot({ at: { x: 13, y: 64, z: 11 } })
    const farCtx = { home: v2home(), comehome: { ...home.startMeet('Steve', true, v2home()), phase: 'exit', exiting: true }, inShelter: true }
    home.comehome(far, farCtx)
    assert.equal(farCtx.comehome, null)
    // Standing in the open doorway: the legs walk on, then shut.
    const near = doorBot({ at: { x: 13, y: 64, z: 20.5 }, doorOpen: true })
    const nearCtx = { home: v2home(), comehome: { ...home.startMeet('Steve', true, v2home()), phase: 'exit', exiting: true }, inShelter: true }
    home.comehome(near, nearCtx)
    assert.equal(nearCtx.comehome.phase, 'exit', 'still walking')
    assert.ok(nearCtx.comehome, 'not released')
  })
})

// --- ticker/chat level: the order lifecycle through handleChat + ticks ---

function pos(x, y, z) {
  const p = {
    x, y, z,
    distanceTo: (q) => Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z),
    clone() { return pos(p.x, p.y, p.z) },
    floored() { return pos(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)) },
    offset(ox, oy, oz) { return pos(p.x + ox, p.y + oy, p.z + oz) },
  }
  return p
}

function capture() {
  const lines = []
  const origLog = console.log
  const origErr = console.error
  console.log = (m) => { lines.push(String(m)) }
  console.error = (m) => { lines.push(String(m)) }
  return { lines, release() { console.log = origLog; console.error = origErr } }
}

function fakeRegistry() {
  return {
    blocksByName: { dirt: { id: 3 }, stone: { id: 1 }, coal_ore: { id: 16 }, iron_ore: { id: 15 }, oak_log: { id: 17 } },
    itemsByName: { dirt: { id: 3 }, coal: { id: 263 }, apple: { id: 260 }, stone_pickaxe: { id: 274 }, wooden_pickaxe: { id: 270 } },
  }
}

function tickBot({ at, doorOpen = false, hasDoor = true, players = {}, timeOfDay = 6000, registry = null, spots = [], extras = {} } = {}) {
  const state = { doorOpen }
  const bot = {
    username: 'IdkBot',
    players,
    entities: {},
    registry,
    health: 20,
    food: 20,
    spawnPoint: pos(0, 64, 0),
    entity: { position: pos(at.x, at.y, at.z), onGround: true },
    time: { timeOfDay, day: 5 },
    _moving: false,
    _goals: [],
    _items: [],
    chats: [],
    controls: {},
    pathfinder: {
      goal: null,
      movements: { canDig: true },
      setGoal(g) { bot._goals.push(g); bot.pathfinder.goal = g || null },
      stop() {},
      isMoving: () => bot._moving,
      setMovements(m) { bot._movements = m },
    },
    blockAt(p) {
      const fx = Math.floor(p.x)
      const fy = Math.floor(p.y)
      const fz = Math.floor(p.z)
      if (hasDoor && fx === DOOR2.x && (fy === DOOR2.y || fy === DOOR2.y + 1) && fz === DOOR2.z) {
        return { name: 'oak_door', position: pos(fx, fy, fz), getProperties: () => ({ open: state.doorOpen }) }
      }
      const extra = extras[`${fx},${fy},${fz}`]
      if (extra) return { name: extra, boundingBox: 'block', position: pos(fx, fy, fz) }
      if (fy < 64) return { name: 'dirt', boundingBox: 'block', position: pos(fx, fy, fz) }
      return { name: 'air', boundingBox: 'empty', position: pos(fx, fy, fz) }
    },
    findBlocks(o = {}) {
      const ids = Array.isArray(o.matching) ? o.matching : []
      const from = o.point || (bot.entity && bot.entity.position) || { x: 0, y: 64, z: 0 }
      const max = typeof o.maxDistance === 'number' ? o.maxDistance : 64
      const out = []
      for (const s of spots) {
        if (!ids.includes(s.id)) continue
        if (Math.hypot(s.x - from.x, s.y - from.y, s.z - from.z) > max) continue
        out.push({ x: s.x, y: s.y, z: s.z })
      }
      return out.slice(0, typeof o.count === 'number' ? o.count : out.length)
    },
    inventory: { items: () => bot._items },
    activateBlock: async () => { state.doorOpen = !state.doorOpen },
    chat(m) { bot.chats.push(String(m)) },
    lookAt() {},
    equip: async () => {},
    attack() {},
    setControlState(c, v) { bot.controls[c] = !!v },
    clearControlStates() { bot.controls = {} },
  }
  return bot
}

const idleBrain = { async decide() { return { action: 'idle', sprint: false, source: 'stub' } } }
const fightBrain = { async decide() { return { action: 'fight', sprint: false, source: 'stub' } } }

function tickerWith(bot, brain = idleBrain, home = v2home()) {
  const ticker = createTicker({ bot, brain, tickMs: 10, idleTickMs: 10 })
  bot._tickerCtx.home = home
  return ticker
}

describe('jr2.3 chat takes and refuses the order', () => {
  it("'come home' drops follow/work, chats coming home, arms the walk", () => {
    const bot = tickBot({ at: { x: 30, y: 64, z: 30 }, players: { Steve: { username: 'Steve' } } })
    const ticker = tickerWith(bot)
    const ctx = bot._tickerCtx
    ctx.work = true
    handleChat(bot, ticker, 'Steve', 'come home')
    assert.deepEqual(bot.chats, ['coming home'])
    assert.ok(ctx.comehome, 'order armed')
    assert.equal(ctx.comehome.phase, 'walk')
    assert.equal(ctx.work, false, 'work dropped')
    assert.equal(ticker.getFollowName(), '', 'no follow held')
  })

  it("'come home' revokes a held follow order", () => {
    const bot = tickBot({
      at: { x: 30, y: 64, z: 30 },
      players: { Steve: { username: 'Steve', entity: { position: pos(28, 64, 28) } } },
    })
    const ticker = tickerWith(bot)
    handleChat(bot, ticker, 'Steve', 'follow me')
    assert.equal(ticker.getFollowName(), 'Steve')
    handleChat(bot, ticker, 'Steve', 'come home')
    assert.equal(ticker.getFollowName(), '', 'follow dropped')
    assert.ok(bot._tickerCtx.comehome, 'order armed')
  })

  it('no home refuses without arming; unbuilt refuses too', () => {
    const bot = tickBot({ at: { x: 30, y: 64, z: 30 }, players: { Steve: { username: 'Steve' } } })
    const ticker = tickerWith(bot, idleBrain, null)
    handleChat(bot, ticker, 'Steve', 'come home')
    assert.deepEqual(bot.chats, ['no home yet — say build here'])
    assert.equal(bot._tickerCtx.comehome, undefined)
    bot._tickerCtx.home = { ...v2home(), built: false }
    handleChat(bot, ticker, 'Steve', 'come home')
    assert.deepEqual(bot.chats, ['no home yet — say build here', 'home not built yet — say go work'])
    assert.equal(bot._tickerCtx.comehome, undefined)
  })

  // A full v2 house around SITE: door, table, planks everywhere in the box.
  function paintedHouseBot() {
    const bot = tickBot({ at: { x: 30, y: 64, z: 30 }, players: { Steve: { username: 'Steve' } } })
    bot.findBlocks = () => [{ x: DOOR2.x, y: DOOR2.y, z: DOOR2.z }]
    bot.blockAt = (p) => {
      const fx = Math.floor(p.x)
      const fy = Math.floor(p.y)
      const fz = Math.floor(p.z)
      if (fx === DOOR2.x && (fy === DOOR2.y || fy === DOOR2.y + 1) && fz === DOOR2.z) {
        return { name: 'oak_door', position: pos(fx, fy, fz), getProperties: () => ({ open: false }) }
      }
      if (fx >= 10 && fx <= 16 && fy >= 64 && fy <= 66 && fz >= 20 && fz <= 25) {
        if (fx === 15 && fy === 64 && fz === 21) return { name: 'crafting_table', position: pos(fx, fy, fz) }
        return { name: 'oak_planks', boundingBox: 'block', position: pos(fx, fy, fz) }
      }
      if (fy < 64) return { name: 'dirt', boundingBox: 'block', position: pos(fx, fy, fz) }
      return { name: 'air', boundingBox: 'empty', position: pos(fx, fy, fz) }
    }
    return bot
  }

  it('a standing house is adopted, then the order arms', () => {
    const bot = paintedHouseBot()
    const ticker = tickerWith(bot, idleBrain, null)
    handleChat(bot, ticker, 'Steve', 'come home')
    assert.ok(bot.chats.includes('my home is at 10 64 20'), bot.chats.join(' | '))
    assert.ok(bot.chats.includes('coming home'), bot.chats.join(' | '))
    assert.equal(bot._tickerCtx.home.v, 2)
    assert.equal(bot._tickerCtx.home.built, true)
    assert.ok(bot._tickerCtx.comehome, 'order armed')
  })

  it('a stale unbuilt flag on a finished same-site house heals', () => {
    // Live: adopted mid-repair (one roof cell out), then finished without
    // the build step ever flipping the flag.
    const bot = paintedHouseBot()
    const ticker = tickerWith(bot, idleBrain, { ...v2home(), built: false })
    handleChat(bot, ticker, 'Steve', 'come home')
    assert.ok(bot.chats.includes('coming home'), bot.chats.join(' | '))
    assert.equal(bot._tickerCtx.home.built, true, 're-validated against the world')
    assert.deepEqual(bot._tickerCtx.home.site, SITE)
    assert.ok(bot._tickerCtx.comehome, 'order armed')
  })

  it('an unbuilt new site elsewhere never reroutes to the old house', () => {
    const bot = paintedHouseBot()
    const far = { site: { x: 100, y: 64, z: 100 }, built: false, v: 2, interior: { min: { x: 101, y: 64, z: 101 }, max: { x: 105, y: 65, z: 104 } } }
    const ticker = tickerWith(bot, idleBrain, far)
    handleChat(bot, ticker, 'Steve', 'come home')
    assert.deepEqual(bot.chats, ['home not built yet — say go work'])
    assert.deepEqual(bot._tickerCtx.home.site, far.site, 'current home respected')
    assert.equal(bot._tickerCtx.comehome, undefined)
  })
})

describe('jr2.3 ticks dispatch the meet like an explicit order', () => {
  it('walks without a visible player while the roster is online', async () => {
    const bot = tickBot({ at: { x: 30, y: 64, z: 30 }, players: { Steve: { username: 'Steve' } } })
    const ticker = tickerWith(bot)
    handleChat(bot, ticker, 'Steve', 'come home')
    const cap = capture()
    try {
      const r = await ticker.tick()
      assert.equal(r.decision.action, 'comehome')
      assert.equal(bot._goals.length, 1, 'walk goal issued with nobody visible')
      assert.deepEqual({ x: bot._goals[0].x, y: bot._goals[0].y, z: bot._goals[0].z }, OUT2)
      assert.ok(cap.lines.some((l) => l.includes('action=comehome')), cap.lines.join('\n'))
    } finally {
      cap.release()
    }
  })

  it('fight preempts the walk but keeps the order', async () => {
    const bot = tickBot({ at: { x: 30, y: 64, z: 30 }, players: { Steve: { username: 'Steve' } } })
    const ticker = tickerWith(bot, fightBrain)
    handleChat(bot, ticker, 'Steve', 'come home')
    const orig = BEHAVIOURS.fight
    let ran = false
    BEHAVIOURS.fight = () => { ran = true }
    const cap = capture()
    try {
      const r = await ticker.tick()
      assert.equal(r.decision.action, 'fight')
      assert.equal(ran, true)
      assert.ok(bot._tickerCtx.comehome, 'order survives the preemption')
    } finally {
      BEHAVIOURS.fight = orig
      cap.release()
    }
  })

  it('holding inside suppresses fight pursuit like shelter', async () => {
    const bot = tickBot({ at: { ...MEET2 }, players: { Steve: { username: 'Steve' } } })
    const ticker = tickerWith(bot, fightBrain)
    const ctx = bot._tickerCtx
    ctx.comehome = { ...home.startMeet('Steve', true, v2home()), phase: 'hold' }
    ctx.inShelter = true
    const orig = BEHAVIOURS.fight
    let ran = false
    BEHAVIOURS.fight = () => { ran = true }
    const cap = capture()
    try {
      const r = await ticker.tick()
      assert.equal(r.decision.action, 'idle', 'pursuit suppressed, melee still swings')
      assert.equal(ran, false, 'no through-wall pursuit')
      assert.ok(ctx.comehome, 'order survives')
      assert.ok(cap.lines.some((l) => l.includes('action=shelter')), cap.lines.join('\n'))
    } finally {
      BEHAVIOURS.fight = orig
      cap.release()
    }
  })

  it('status names the meet', () => {
    const bot = tickBot({ at: { x: 30, y: 64, z: 30 }, players: { Steve: { username: 'Steve' } } })
    const ticker = tickerWith(bot)
    handleChat(bot, ticker, 'Steve', 'come home')
    handleChat(bot, ticker, 'Steve', 'status')
    assert.ok(bot.chats.some((c) => c.startsWith('coming home') && c.includes('phase=walk')), bot.chats.join(' | '))
  })
})

describe('rw4.18 the exit legs keep walking on day fight ticks without an intruder', () => {
  // A day mob holding fight from outside the walls: inside the 8-block
  // fight radius of the meet cell, outside the v2 interior box
  // (x 11..15, z 21..24) so the 33vm scan never calls it an intruder.
  function zombieOutside() {
    const p = pos(13.5, 64, 14)
    p.offset = (ox, oy, oz) => pos(p.x + ox, p.y + oy, p.z + oz)
    return { id: 21, name: 'zombie', type: 'mob', position: p, height: 1.95 }
  }

  it('day fight ticks alone drive the full exit open→exit→close→released, then fight resumes outside', async () => {
    const bot = tickBot({ at: { ...MEET2 }, players: { Steve: { username: 'Steve' } } })
    bot.entities = { 21: zombieOutside() }
    const ticker = tickerWith(bot, fightBrain)
    const ctx = bot._tickerCtx
    ctx.comehome = { ...home.startMeet('Steve', true, v2home()), phase: 'hold' }
    ctx.inShelter = true
    handleChat(bot, ticker, 'Steve', 'go work')
    assert.equal(ctx.comehome.exiting, true, 'exit armed, not cleared')
    const origFight = BEHAVIOURS.fight
    let fightRan = 0
    BEHAVIOURS.fight = () => { fightRan++ }
    const cap = capture()
    try {
      const seen = []
      let r = await ticker.tick() // open the shut door
      seen.push(r.decision.action)
      await settle()
      r = await ticker.tick() // door open -> exit legs start
      seen.push(r.decision.action)
      assert.equal(ctx.comehome.phase, 'exit')
      bot.entity.position = pos(OUT2.x, OUT2.y, OUT2.z) // legs walked out
      ctx.comehome.lastToggle = 0
      for (let i = 0; i < 5 && ctx.comehome; i++) {
        r = await ticker.tick() // arrival -> close -> shut -> released
        seen.push(r.decision.action)
        await settle()
      }
      assert.equal(ctx.comehome, null, 'released to work on fight ticks alone')
      assert.equal(ctx.inShelter, false)
      assert.ok(seen.length >= 3, `several fight ticks ran: ${seen.join(',')}`)
      assert.ok(seen.every((a) => a === 'comehome'), `every sheltered tick ran the legs: ${seen.join(',')}`)
      assert.equal(fightRan, 0, 'no pursuit while sheltered (jr2.3)')
      assert.deepEqual(bot._goals.filter((g) => g && typeof g.x === 'number'), [], 'no A* through the doorway')
      // Outside now: the next fight tick fights in the open, like any order.
      r = await ticker.tick()
      assert.equal(r.decision.action, 'fight')
      assert.equal(fightRan, 1)
    } finally {
      BEHAVIOURS.fight = origFight
      cap.release()
    }
  })

  it('night fight ticks keep the doorway hold (no legs in the dark)', async () => {
    const bot = tickBot({ at: { ...MEET2 }, players: { Steve: { username: 'Steve' } }, timeOfDay: 15000 })
    bot.entities = { 21: zombieOutside() }
    const ticker = tickerWith(bot, fightBrain)
    const ctx = bot._tickerCtx
    ctx.comehome = { ...home.startMeet('Steve', true, v2home()), phase: 'hold' }
    ctx.inShelter = true
    handleChat(bot, ticker, 'Steve', 'go work')
    assert.equal(ctx.comehome.exiting, true, 'exit armed, not cleared')
    const cap = capture()
    try {
      for (let i = 0; i < 3; i++) {
        const r = await ticker.tick()
        assert.equal(r.decision.action, 'idle')
      }
      assert.equal(ctx.comehome.phase, 'open', 'legs never ran')
      assert.ok(!ctx.comehome.openTicks, 'door never touched')
      assert.equal(ctx.inShelter, true, 'the doorway guard stands')
      assert.deepEqual(bot._goals, [], 'no pathing')
    } finally {
      cap.release()
    }
  })

  it('a gocastle exit rides the comehome legs on day fight ticks while the castle walk waits', async () => {
    // setGocastle from inside arms BOTH orders: the comehome exit legs own
    // the doorway, gocastle waits for release.
    const bot = tickBot({ at: { ...MEET2 }, players: { Steve: { username: 'Steve' } } })
    bot.entities = { 21: zombieOutside() }
    const ticker = tickerWith(bot, fightBrain)
    const ctx = bot._tickerCtx
    ctx.comehome = { ...home.startMeet('Steve', true, v2home()), phase: 'hold' }
    ctx.inShelter = true
    home.releaseMeet(bot, ctx)
    ctx.gocastle = { by: 'Steve', phase: 'walk', stalls: 0, fails: 0, lastPos: null }
    assert.equal(ctx.comehome.exiting, true)
    const cap = capture()
    try {
      let r = await ticker.tick() // open the shut door
      assert.equal(r.decision.action, 'comehome')
      await settle()
      r = await ticker.tick() // door open -> exit legs start
      assert.equal(r.decision.action, 'comehome')
      assert.equal(ctx.comehome.phase, 'exit')
      assert.equal(ctx.gocastle.phase, 'walk', 'the castle walk waits for release')
      bot.entity.position = pos(OUT2.x, OUT2.y, OUT2.z) // legs walked out
      ctx.comehome.lastToggle = 0
      for (let i = 0; i < 5 && ctx.comehome; i++) {
        r = await ticker.tick()
        await settle()
        assert.equal(r.decision.action, 'comehome')
      }
      assert.equal(ctx.comehome, null, 'exit released on fight ticks alone')
      assert.ok(ctx.gocastle, 'gocastle still armed for the walk out')
      assert.deepEqual(bot._goals.filter((g) => g && typeof g.x === 'number'), [], 'no A* through the doorway')
    } finally {
      cap.release()
    }
  })

  it('a hostile on the out-lane holds the exit shut; a cleared lane resumes (revmux 01 core-1)', async () => {
    const bot = tickBot({ at: { ...MEET2 }, players: { Steve: { username: 'Steve' } } })
    const lane = pos(OUT2.x + 0.5, OUT2.y, OUT2.z + 0.5)
    lane.offset = (ox, oy, oz) => pos(lane.x + ox, lane.y + oy, lane.z + oz)
    const camper = { id: 22, name: 'zombie', type: 'mob', position: lane, height: 1.95 }
    bot.entities = { 22: camper }
    const ticker = tickerWith(bot, fightBrain)
    const ctx = bot._tickerCtx
    ctx.comehome = { ...home.startMeet('Steve', true, v2home()), phase: 'hold' }
    ctx.inShelter = true
    handleChat(bot, ticker, 'Steve', 'go work')
    assert.equal(ctx.comehome.exiting, true)
    const cap = capture()
    try {
      for (let i = 0; i < 3; i++) {
        const r = await ticker.tick()
        assert.equal(r.decision.action, 'idle', 'lane blocked: hold shut')
      }
      assert.equal(ctx.comehome.phase, 'open', 'legs never ran')
      assert.ok(!ctx.comehome.openTicks, 'door never touched')
      const door = bot.blockAt({ x: DOOR2.x, y: DOOR2.y, z: DOOR2.z })
      assert.equal(door.getProperties().open, false, 'door stays shut')
      // The camper wanders off: the next fight ticks run the legs.
      bot.entities = {}
      const r = await ticker.tick()
      assert.equal(r.decision.action, 'comehome')
      await settle()
      const r2 = await ticker.tick()
      assert.equal(r2.decision.action, 'comehome')
      assert.equal(ctx.comehome.phase, 'exit', 'legs resume once the lane clears')
    } finally {
      cap.release()
    }
  })

  it("a mob on the lane mid-legs does not freeze them (revmux 02 core-1, 'exit')", async () => {
    const bot = tickBot({ at: { ...MEET2 }, players: { Steve: { username: 'Steve' } } })
    const ticker = tickerWith(bot, fightBrain)
    const ctx = bot._tickerCtx
    ctx.comehome = { ...home.startMeet('Steve', true, v2home()), phase: 'hold' }
    ctx.inShelter = true
    handleChat(bot, ticker, 'Steve', 'go work')
    const cap = capture()
    try {
      await ticker.tick() // open the shut door
      await settle()
      await ticker.tick() // door open -> exit legs start
      assert.equal(ctx.comehome.phase, 'exit')
      const drove = ctx.comehome.legTicks
      assert.ok(drove > 0, 'legs running')
      // A mob steps onto the lane mid-legs: the committed legs finish
      // instead of freezing mid-doorway with the door open.
      const lane = pos(OUT2.x + 0.5, OUT2.y, OUT2.z + 0.5)
      lane.offset = (ox, oy, oz) => pos(lane.x + ox, lane.y + oy, lane.z + oz)
      bot.entities = { 22: { id: 22, name: 'zombie', type: 'mob', position: lane, height: 1.95 } }
      const r = await ticker.tick()
      assert.equal(r.decision.action, 'comehome')
      assert.ok(ctx.comehome.legTicks > drove, 'legs keep driving through the lane mob')
    } finally {
      cap.release()
    }
  })

  it("a mob on the lane at the shut does not freeze it (revmux 02 core-1, 'close')", async () => {
    const bot = tickBot({ at: { ...MEET2 }, players: { Steve: { username: 'Steve' } } })
    const ticker = tickerWith(bot, fightBrain)
    const ctx = bot._tickerCtx
    ctx.comehome = { ...home.startMeet('Steve', true, v2home()), phase: 'hold' }
    ctx.inShelter = true
    handleChat(bot, ticker, 'Steve', 'go work')
    const cap = capture()
    try {
      await ticker.tick() // open the shut door
      await settle()
      await ticker.tick() // door open -> exit legs start
      bot.entity.position = pos(OUT2.x, OUT2.y, OUT2.z) // legs walked out
      // No lastToggle reset: the toggle cooldown holds, so this tick
      // reaches 'close' with the door still open.
      const arrived = await ticker.tick()
      assert.equal(arrived.decision.action, 'comehome')
      assert.equal(ctx.comehome.phase, 'close')
      // A mob steps onto the lane at the shut: the close still shuts the
      // door and releases instead of idling it open.
      const lane = pos(OUT2.x + 0.5, OUT2.y, OUT2.z + 0.5)
      lane.offset = (ox, oy, oz) => pos(lane.x + ox, lane.y + oy, lane.z + oz)
      bot.entities = { 22: { id: 22, name: 'zombie', type: 'mob', position: lane, height: 1.95 } }
      ctx.comehome.lastToggle = 0
      const r = await ticker.tick()
      assert.equal(r.decision.action, 'comehome')
      await settle()
      const door = bot.blockAt({ x: DOOR2.x, y: DOOR2.y, z: DOOR2.z })
      assert.equal(door.getProperties().open, false, 'door ends shut')
      await ticker.tick()
      assert.equal(ctx.comehome, null, 'released')
      assert.equal(ctx.inShelter, false, 'fight takes over outside')
    } finally {
      cap.release()
    }
  })

  it('dusk falling mid-exit does not freeze it: the legs finish and shut the door (verifier P2)', async () => {
    // The exit starts by day; dusk falls with the door open mid-legs. Day
    // is required only to START — the committed legs finish instead of
    // idling in the open doorway until dawn.
    const bot = tickBot({ at: { ...MEET2 }, players: { Steve: { username: 'Steve' } } })
    bot.entities = { 21: zombieOutside() }
    const ticker = tickerWith(bot, fightBrain)
    const ctx = bot._tickerCtx
    ctx.comehome = { ...home.startMeet('Steve', true, v2home()), phase: 'hold' }
    ctx.inShelter = true
    handleChat(bot, ticker, 'Steve', 'go work')
    assert.equal(ctx.comehome.exiting, true)
    const cap = capture()
    try {
      let r = await ticker.tick() // open the shut door, by day
      assert.equal(r.decision.action, 'comehome')
      await settle()
      r = await ticker.tick() // door open -> exit legs start, by day
      assert.equal(r.decision.action, 'comehome')
      assert.equal(ctx.comehome.phase, 'exit')
      bot.time.timeOfDay = 12500 // dusk falls mid-exit
      bot.entity.position = pos(OUT2.x, OUT2.y, OUT2.z) // legs walked out
      ctx.comehome.lastToggle = 0
      for (let i = 0; i < 5 && ctx.comehome; i++) {
        r = await ticker.tick() // arrival -> close -> shut -> released, at dusk
        await settle()
        assert.equal(r.decision.action, 'comehome', 'dusk legs keep running')
      }
      assert.equal(ctx.comehome, null, 'released at dusk')
      assert.equal(ctx.inShelter, false)
      const door = bot.blockAt({ x: DOOR2.x, y: DOOR2.y, z: DOOR2.z })
      assert.equal(door.getProperties().open, false, 'door ends shut')
      assert.deepEqual(bot._goals.filter((g) => g && typeof g.x === 'number'), [], 'no A* through the doorway')
    } finally {
      cap.release()
    }
  })

  it('night with a pre-open door holds a lane-blocked exit (revmux 04 body-1)', async () => {
    // The owner walked in at night (door open), ordered a move, and a mob
    // camps the lane: the legs never began, so the night exit holds
    // instead of walking out beside it.
    const bot = tickBot({ at: { ...MEET2 }, players: { Steve: { username: 'Steve' } }, timeOfDay: 15000, doorOpen: true })
    const lane = pos(OUT2.x + 0.5, OUT2.y, OUT2.z + 0.5)
    lane.offset = (ox, oy, oz) => pos(lane.x + ox, lane.y + oy, lane.z + oz)
    bot.entities = { 22: { id: 22, name: 'zombie', type: 'mob', position: lane, height: 1.95 } }
    const ticker = tickerWith(bot, fightBrain)
    const ctx = bot._tickerCtx
    ctx.comehome = { ...home.startMeet('Steve', true, v2home()), phase: 'hold' }
    ctx.inShelter = true
    handleChat(bot, ticker, 'Steve', 'go work')
    assert.equal(ctx.comehome.exiting, true)
    assert.ok(!ctx.comehome.committed, 'legs never acted')
    const cap = capture()
    try {
      for (let i = 0; i < 3; i++) {
        const r = await ticker.tick()
        assert.equal(r.decision.action, 'idle', 'unstarted night exit holds')
      }
      assert.equal(ctx.comehome.phase, 'open', 'legs never ran')
      assert.ok(!ctx.comehome.openTicks, 'door never touched')
      assert.equal(ctx.inShelter, true)
    } finally {
      cap.release()
    }
  })

  it('night with a pre-open door and a clear lane still holds: no night starts (revmux 04 body-1)', async () => {
    const bot = tickBot({ at: { ...MEET2 }, players: { Steve: { username: 'Steve' } }, timeOfDay: 15000, doorOpen: true })
    const ticker = tickerWith(bot, fightBrain)
    const ctx = bot._tickerCtx
    ctx.comehome = { ...home.startMeet('Steve', true, v2home()), phase: 'hold' }
    ctx.inShelter = true
    handleChat(bot, ticker, 'Steve', 'go work')
    assert.equal(ctx.comehome.exiting, true)
    const cap = capture()
    try {
      for (let i = 0; i < 3; i++) {
        const r = await ticker.tick()
        assert.equal(r.decision.action, 'idle', 'unstarted night exit holds even clear')
      }
      assert.equal(ctx.comehome.phase, 'open')
      assert.equal(ctx.inShelter, true)
    } finally {
      cap.release()
    }
  })

  it('an exit the legs started by day finishes at night with the door still shut (revmux 04 body-1)', async () => {
    // The toggle was sent by day (committed) but never landed; night falls
    // with the exit still in 'open'. The started exit keeps running instead
    // of idling until dawn.
    const bot = tickBot({ at: { ...MEET2 }, players: { Steve: { username: 'Steve' } } })
    bot.activateBlock = async () => {} // the toggle never lands
    const ticker = tickerWith(bot, fightBrain)
    const ctx = bot._tickerCtx
    ctx.comehome = { ...home.startMeet('Steve', true, v2home()), phase: 'hold' }
    ctx.inShelter = true
    handleChat(bot, ticker, 'Steve', 'go work')
    const cap = capture()
    try {
      const r1 = await ticker.tick() // day: toggle sent, committed
      assert.equal(r1.decision.action, 'comehome')
      assert.equal(ctx.comehome.committed, true)
      bot.time.timeOfDay = 15000 // night falls, door still shut
      const r2 = await ticker.tick()
      assert.equal(r2.decision.action, 'comehome', 'committed exit finishes at night')
      assert.equal(ctx.comehome.openTicks, 2, 'handler ran again')
    } finally {
      cap.release()
    }
  })

  it("phase 'open' with the door already open runs the legs despite the lane mob (revmux 03 core-1)", async () => {
    // By day an already-open door starts even past a lane mob (freezing
    // behind an open door is worse); the wedge re-arm pins committed=true
    // separately, so this setup stays uncommitted and pins the day term.
    const bot = tickBot({ at: { ...MEET2 }, players: { Steve: { username: 'Steve' } }, doorOpen: true })
    const lane = pos(OUT2.x + 0.5, OUT2.y, OUT2.z + 0.5)
    lane.offset = (ox, oy, oz) => pos(lane.x + ox, lane.y + oy, lane.z + oz)
    bot.entities = { 22: { id: 22, name: 'zombie', type: 'mob', position: lane, height: 1.95 } }
    const ticker = tickerWith(bot, fightBrain)
    const ctx = bot._tickerCtx
    ctx.comehome = { ...home.startMeet('Steve', true, v2home()), phase: 'hold' }
    ctx.inShelter = true
    handleChat(bot, ticker, 'Steve', 'go work')
    assert.equal(ctx.comehome.exiting, true)
    assert.equal(ctx.comehome.phase, 'open')
    const cap = capture()
    try {
      const r = await ticker.tick()
      assert.equal(r.decision.action, 'comehome', 'open door: legs run, no shelter freeze')
      assert.equal(ctx.comehome.phase, 'exit')
      bot.entity.position = pos(OUT2.x, OUT2.y, OUT2.z) // legs walked out
      for (let i = 0; i < 5 && ctx.comehome; i++) {
        const rr = await ticker.tick()
        await settle()
        assert.equal(rr.decision.action, 'comehome')
      }
      assert.equal(ctx.comehome, null, 'released')
      assert.equal(ctx.inShelter, false)
      const door = bot.blockAt({ x: DOOR2.x, y: DOOR2.y, z: DOOR2.z })
      assert.equal(door.getProperties().open, false, 'door ends shut')
    } finally {
      cap.release()
    }
  })
})

describe('rw4.18 outLaneBlocked reads the approach cell, not the bot', () => {
  function mob(name, x, y, z, extra = {}) {
    return { id: 31, name, type: 'mob', position: pos(x, y, z), height: 1.95, ...extra }
  }

  it('blocks on the cell and its ring, clears past it; v1 geometry too', () => {
    const botOn = (e) => ({ entities: { 31: e } })
    assert.equal(home.outLaneBlocked(botOn(mob('zombie', OUT2.x + 0.5, OUT2.y, OUT2.z + 0.5)), v2home()), true, 'on the out cell')
    assert.equal(home.outLaneBlocked(botOn(mob('skeleton', OUT2.x + 0.5, OUT2.y, OUT2.z - 0.5)), v2home()), true, 'adjacent ring')
    assert.equal(home.outLaneBlocked(botOn(mob('creeper', OUT2.x + 0.5, OUT2.y, OUT2.z + 0.5)), v2home()), true, 'creepers count')
    assert.equal(home.outLaneBlocked(botOn(mob('zombie', OUT2.x + 0.5, OUT2.y, OUT2.z - 3)), v2home()), false, 'past the ring')
    assert.equal(home.outLaneBlocked(botOn(mob('zombie', MEET2.x, MEET2.y, MEET2.z + 4)), v2home()), false, 'a wall-presser behind the house')
    assert.equal(home.outLaneBlocked(botOn(mob('zombie', OUT1.x + 0.5, OUT1.y, OUT1.z + 0.5)), v1home()), true, 'v1 out cell')
    assert.equal(home.outLaneBlocked(botOn(mob('zombie', OUT1.x + 0.5, OUT1.y, OUT1.z - 3)), v1home()), false, 'v1 past the ring')
  })

  it('endermen, players and unreadable worlds never block', () => {
    const botOn = (e) => ({ entities: { 31: e } })
    const at = { x: OUT2.x + 0.5, y: OUT2.y, z: OUT2.z + 0.5 }
    assert.equal(home.outLaneBlocked(botOn(mob('enderman', at.x, at.y, at.z)), v2home()), false, 'neutral unless provoked')
    assert.equal(home.outLaneBlocked(botOn(mob('zombie', at.x, at.y, at.z, { type: 'player' })), v2home()), false, 'players never block')
    assert.equal(home.outLaneBlocked(botOn(mob('zombie', at.x, at.y, at.z, { isValid: false })), v2home()), false, 'dead entities skip')
    assert.equal(home.outLaneBlocked(botOn(mob('zombie', at.x, at.y, at.z)), null), false, 'no home reads clear')
    assert.equal(home.outLaneBlocked(botOn(mob('zombie', at.x, at.y, at.z)), {}), false, 'no site reads clear')
    assert.equal(home.outLaneBlocked({}, v2home()), false, 'no entities reads clear')
  })
})

describe('jr2.3 move commands exit through the doorway, repeat and stop never hang', () => {
  it("'go work' from the hold exits, shuts, then works", async () => {
    const bot = tickBot({ at: { ...MEET2 }, players: { Steve: { username: 'Steve' } } })
    const ticker = tickerWith(bot)
    const ctx = bot._tickerCtx
    ctx.comehome = { ...home.startMeet('Steve', true, v2home()), phase: 'hold' }
    ctx.inShelter = true
    handleChat(bot, ticker, 'Steve', 'go work')
    assert.equal(ctx.work, true)
    assert.equal(ctx.comehome.exiting, true, 'exit armed, not cleared')
    const cap = capture()
    try {
      let r = await ticker.tick() // open the shut door
      assert.equal(r.decision.action, 'comehome')
      await settle()
      r = await ticker.tick() // door open -> exit legs start
      assert.equal(ctx.comehome.phase, 'exit')
      bot.entity.position = pos(OUT2.x, OUT2.y, OUT2.z) // legs walked out
      ctx.comehome.lastToggle = 0
      for (let i = 0; i < 5 && ctx.comehome; i++) {
        r = await ticker.tick() // arrival -> close -> shut -> released
        await settle()
        assert.equal(r.decision.action, 'comehome')
      }
      assert.equal(ctx.comehome, null, 'released to work')
      assert.equal(ctx.inShelter, false)
      assert.deepEqual(bot._goals.filter((g) => g && typeof g.x === 'number'), [], 'no A* through the doorway')
    } finally {
      cap.release()
    }
  })

  it("'follow me' from the hold exits, then follows", async () => {
    const bot = tickBot({
      at: { ...MEET2 },
      players: { Steve: { username: 'Steve', entity: { position: pos(30, 64, 30) } } },
    })
    const ticker = tickerWith(bot)
    const ctx = bot._tickerCtx
    ctx.comehome = { ...home.startMeet('Steve', true, v2home()), phase: 'hold' }
    ctx.inShelter = true
    handleChat(bot, ticker, 'Steve', 'follow me')
    assert.equal(ticker.getFollowName(), 'Steve')
    assert.equal(ctx.comehome.exiting, true)
    const cap = capture()
    try {
      await ticker.tick() // open
      await settle()
      await ticker.tick() // door open -> exit legs start
      assert.equal(ctx.comehome.phase, 'exit')
      bot.entity.position = pos(OUT2.x, OUT2.y, OUT2.z)
      ctx.comehome.lastToggle = 0
      for (let i = 0; i < 5 && ctx.comehome; i++) {
        const r = await ticker.tick() // arrival -> close -> shut -> released
        await settle()
        assert.equal(r.decision.action, 'comehome')
      }
      assert.equal(ctx.comehome, null, 'exit done, follow owns the body')
      assert.equal(ctx.inShelter, false)
    } finally {
      cap.release()
    }
  })

  it("repeat 'come home' and stop never hang the phase", async () => {
    const bot = tickBot({ at: { ...MEET2 }, players: { Steve: { username: 'Steve' } } })
    const ticker = tickerWith(bot)
    const ctx = bot._tickerCtx
    ctx.comehome = { ...home.startMeet('Steve', true, v2home()), phase: 'hold' }
    handleChat(bot, ticker, 'Steve', 'stop')
    assert.equal(ctx.paused, true)
    const cap = capture()
    try {
      await ticker.tick() // parked: the order frozen, not hung
      handleChat(bot, ticker, 'Steve', 'come home')
      assert.equal(ctx.paused, false)
      assert.equal(ctx.comehome.phase, 'close', 'fresh record from the repeat')
      assert.ok(!ctx.comehome.exiting)
      await ticker.tick() // settle -> home + hold
      assert.equal(ctx.comehome.phase, 'hold')
      assert.ok(bot.chats.includes('home'), bot.chats.join(' | '))
      await ticker.tick()
      assert.equal(ctx.comehome.phase, 'hold', 'still holding, advancing every tick')
    } finally {
      cap.release()
    }
  })

  it("stop mid-walk then 'come home' walks again", async () => {
    const bot = tickBot({ at: { x: 30, y: 64, z: 30 }, players: { Steve: { username: 'Steve' } } })
    const ticker = tickerWith(bot)
    const ctx = bot._tickerCtx
    handleChat(bot, ticker, 'Steve', 'come home')
    handleChat(bot, ticker, 'Steve', 'stop')
    const cap = capture()
    try {
      await ticker.tick()
      assert.deepEqual(bot._goals, [], 'parked: no goals while stopped')
      handleChat(bot, ticker, 'Steve', 'come home')
      assert.equal(ctx.comehome.phase, 'walk', 'fresh walk, outside')
      const r = await ticker.tick()
      assert.equal(r.decision.action, 'comehome')
      assert.equal(bot._goals.length, 1, 'walking again')
    } finally {
      cap.release()
    }
  })
})

describe('jr2.3 every order opens through the doorway, not through the wall', () => {
  function held(extra = {}) {
    const bot = tickBot({ at: { ...MEET2 }, players: { Steve: { username: 'Steve' } }, ...extra })
    const ticker = tickerWith(bot, idleBrain, extra.home || v2home())
    const ctx = bot._tickerCtx
    ctx.comehome = { ...home.startMeet('Steve', true, v2home()), phase: 'hold' }
    ctx.inShelter = true
    return { bot, ticker, ctx }
  }

  it('lead opens from the hold with the exit armed', () => {
    const { ticker, ctx } = held()
    ticker.setLead({ name: 'iron_ore', pos: pos(60, 64, 0), by: 'Steve', lastProgressAt: Date.now() })
    assert.ok(ctx.lead)
    assert.equal(ctx.comehome.exiting, true)
    assert.equal(ctx.inShelter, true)
  })

  it("'flat 8' from the hold scans with the exit armed", () => {
    const { bot, ticker, ctx } = held()
    handleChat(bot, ticker, 'Steve', 'flat 8')
    assert.ok(ctx.flat)
    assert.equal(ctx.comehome.exiting, true)
  })

  it("'share' from the hold tosses with the exit armed", () => {
    const { bot, ticker, ctx } = held()
    bot._items = [{ name: 'dirt', count: 40 }]
    handleChat(bot, ticker, 'Steve', 'share')
    assert.equal(ctx.bring && ctx.bring.kind, 'share')
    assert.equal(ctx.comehome.exiting, true)
  })

  it("'bring me food' from the hold carries with the exit armed", () => {
    const { bot, ticker, ctx } = held()
    bot._items = [{ name: 'apple', count: 3 }]
    handleChat(bot, ticker, 'Steve', 'bring me food')
    assert.equal(ctx.bring && ctx.bring.kind, 'food')
    assert.equal(ctx.comehome.exiting, true)
  })

  it("'bring me dirt' from the pack opens with the exit armed", () => {
    const { bot, ticker, ctx } = held({ registry: fakeRegistry() })
    bot._items = [{ name: 'dirt', count: 40 }] // 32 stays scaffold reserve, 8 give
    handleChat(bot, ticker, 'Steve', 'bring me dirt 10')
    assert.equal(ctx.bring && ctx.bring.kind, 'item')
    assert.equal(ctx.comehome.exiting, true)
  })

  it("'bring me dirt' from the chest opens with the exit armed", () => {
    const chestHome = { ...v2home(), chest: { x: 5, y: 64, z: 1 } }
    const { bot, ticker, ctx } = held({ registry: fakeRegistry(), home: chestHome })
    handleChat(bot, ticker, 'Steve', 'bring me dirt 10')
    assert.equal(ctx.bring && ctx.bring.phase, 'chestfetch')
    assert.equal(ctx.comehome.exiting, true)
  })
})

describe('jr2.3 a fractional bedroom order seats, never walks at the door', () => {
  it("'come home' at z=24.5 seats to the meet cell (live repro)", async () => {
    const bot = tickBot({ at: { x: 12.5, y: 64, z: 24.5 }, players: { Steve: { username: 'Steve' } } })
    const ticker = tickerWith(bot)
    const ctx = bot._tickerCtx
    handleChat(bot, ticker, 'Steve', 'come home')
    assert.ok(ctx.comehome)
    const cap = capture()
    try {
      await ticker.tick()
      assert.equal(ctx.comehome.phase, 'seat', 'settle arms the seat, not the walk')
      bot.entity.position = pos(MEET2.x + 0.5, MEET2.y, MEET2.z + 0.5) // legs walked in
      await ticker.tick()
    } finally {
      cap.release()
    }
    assert.equal(ctx.comehome.phase, 'hold')
    assert.ok(bot.chats.includes('home'), `heard [${bot.chats.join('|')}]`)
  })
})

describe('jr2.3 night work in a back-row cell stays, never loops gohome', () => {
  it('fractional back row picks stay once, never chats home-for-the-night', async () => {
    const bot = tickBot({ at: { x: 12.5, y: 64, z: 24.5 }, timeOfDay: 15000, players: { Steve: { username: 'Steve' } } })
    const ticker = tickerWith(bot)
    const ctx = bot._tickerCtx
    ctx.work = true
    const cap = capture()
    try {
      for (let i = 0; i < 3; i++) await ticker.tick()
    } finally {
      cap.release()
    }
    assert.equal(ctx.step, 'stay')
    assert.ok(!bot.chats.includes('home for the night'), `loop chats: [${bot.chats.join('|')}]`)
  })
})

describe('jr2.3 far completions land through the doorway too', () => {
  function heldFar(extra = {}) {
    const bot = tickBot({ at: { ...MEET2 }, players: { Steve: { username: 'Steve' } }, registry: fakeRegistry(), ...extra })
    const ticker = tickerWith(bot)
    const ctx = bot._tickerCtx
    ctx.comehome = { ...home.startMeet('Steve', true, v2home()), phase: 'hold' }
    ctx.inShelter = true
    return { bot, ticker, ctx }
  }

  it("'find me iron' past 48 leads with the exit armed", async () => {
    const { bot, ticker, ctx } = heldFar({ spots: [{ id: 15, x: 60, y: 64, z: 0 }], extras: { '60,64,0': 'iron_ore' } })
    handleChat(bot, ticker, 'Steve', 'find me iron')
    assert.equal(ctx.pendingSearch && ctx.pendingSearch.kind, 'find')
    const cap = capture()
    try {
      for (let i = 0; i < 60 && ctx.pendingSearch; i++) await ticker.tick()
    } finally {
      cap.release()
    }
    assert.equal(ctx.pendingSearch, null)
    assert.ok(ctx.lead, 'far find opens the lead')
    assert.equal(ctx.comehome.exiting, true, 'exit armed, not cleared')
    assert.equal(ctx.inShelter, true)
  })

  it("'bring me coal' past 48 fetches with the exit armed", async () => {
    const { bot, ticker, ctx } = heldFar({ spots: [{ id: 16, x: 60, y: 64, z: 0 }], extras: { '60,64,0': 'coal_ore' } })
    bot._items = [{ name: 'stone_pickaxe', count: 1 }]
    handleChat(bot, ticker, 'Steve', 'bring me coal')
    assert.equal(ctx.pendingSearch && ctx.pendingSearch.kind, 'bring')
    const cap = capture()
    try {
      for (let i = 0; i < 60 && ctx.pendingSearch; i++) await ticker.tick()
    } finally {
      cap.release()
    }
    assert.equal(ctx.pendingSearch, null)
    assert.equal(ctx.bring && ctx.bring.kind, 'block', 'far bring opens the fetch')
    assert.equal(ctx.comehome.exiting, true, 'exit armed, not cleared')
  })

  it("a failed far bring still opens (atl.8) with the exit armed", async () => {
    const { bot, ticker, ctx } = heldFar()
    bot._items = [{ name: 'stone_pickaxe', count: 1 }]
    handleChat(bot, ticker, 'Steve', 'bring me coal')
    assert.equal(ctx.pendingSearch && ctx.pendingSearch.kind, 'bring')
    const cap = capture()
    try {
      for (let i = 0; i < 60 && ctx.pendingSearch; i++) await ticker.tick()
    } finally {
      cap.release()
    }
    assert.equal(ctx.pendingSearch, null)
    assert.equal(ctx.bring && ctx.bring.searchSkipFar, true, 'atl.8 opens the legs')
    assert.equal(ctx.comehome.exiting, true, 'exit armed, not cleared')
  })
})

describe('jr2.3 the walk borrow holds across the brain await', () => {
  function seeingBot(at, phase) {
    const bot = tickBot({ at, players: { Steve: { username: 'Steve', entity: { position: pos(30, 64, 30) } } } })
    const seen = []
    const brain = { async decide() { seen.push(bot.pathfinder.movements.canDig); return { action: 'idle', sprint: false, source: 'stub' } } }
    const ticker = tickerWith(bot, brain)
    const ctx = bot._tickerCtx
    ctx.movements = bot.pathfinder.movements // the shared object setMovements installs
    ctx.comehome = { ...home.startMeet('Steve', false, v2home()), phase }
    return { bot, ticker, ctx, seen }
  }

  it('walk: the brain sees canDig false (the lease borrows at tick start)', async () => {
    const { bot, ticker, seen } = seeingBot({ x: 30, y: 64, z: 30 }, 'walk')
    const cap = capture()
    try {
      await ticker.tick()
      bot.entity.position = pos(31, 64, 30) // fresh state key: the brain is asked again
      await ticker.tick()
    } finally {
      cap.release()
    }
    assert.deepEqual(seen, [false, false], 'no dig window across the brain await: the lease borrows eagerly at tick start')
  })

  it('seat: the brain sees canDig false (the lease borrows at tick start)', async () => {
    const { bot, ticker, seen } = seeingBot({ x: 13, y: 64, z: 24 }, 'seat')
    const cap = capture()
    try {
      await ticker.tick()
      bot.entity.position = pos(14, 64, 24) // fresh state key: the brain is asked again
      await ticker.tick()
    } finally {
      cap.release()
    }
    assert.deepEqual(seen, [false, false], 'no dig window across the brain await: the lease borrows eagerly at tick start')
  })

  it('no meet: the tick start still restores the default', async () => {
    const { bot, ticker, seen } = seeingBot({ x: 30, y: 64, z: 30 }, 'walk')
    bot._tickerCtx.comehome = null
    bot.pathfinder.movements.canDig = false
    const cap = capture()
    try {
      await ticker.tick()
    } finally {
      cap.release()
    }
    assert.deepEqual(seen, [true], 'the exemption is meet-only')
  })
})

describe("jr2.3 'build here' moves the house under a standing meet", () => {
  it('setHome exits the old house, then releases to the new site', async () => {
    const bot = tickBot({ at: { ...MEET2 }, players: { Steve: { username: 'Steve' } } })
    const ticker = tickerWith(bot)
    const ctx = bot._tickerCtx
    ctx.comehome = { ...home.startMeet('Steve', true, v2home()), phase: 'hold' }
    ctx.inShelter = true
    const fresh = { ...v2home(), site: { x: 100, y: 64, z: 100 } }
    ticker.setHome(fresh)
    assert.deepEqual(ctx.home.site, fresh.site)
    assert.equal(ctx.comehome.exiting, true, 'exit armed against the pinned old house')
    assert.deepEqual(ctx.comehome.home.site, SITE)
    const cap = capture()
    try {
      let r = await ticker.tick() // open the shut door
      assert.equal(r.decision.action, 'comehome')
      await settle()
      r = await ticker.tick() // door open -> exit legs start
      assert.equal(ctx.comehome.phase, 'exit')
      bot.entity.position = pos(OUT2.x, OUT2.y, OUT2.z) // legs walked out
      ctx.comehome.lastToggle = 0
      for (let i = 0; i < 5 && ctx.comehome; i++) {
        r = await ticker.tick() // arrival -> close -> shut -> released
        await settle()
        assert.equal(r.decision.action, 'comehome')
      }
      assert.equal(ctx.comehome, null, 'released to the new site')
      assert.equal(ctx.inShelter, false)
    } finally {
      cap.release()
    }
  })

  it("re-ordered mid-exit keeps exiting old, then reseeks current", () => {
    const bot = tickBot({ at: { ...MEET2 }, players: { Steve: { username: 'Steve' } } })
    const ticker = tickerWith(bot)
    const ctx = bot._tickerCtx
    ctx.comehome = { ...home.startMeet('Steve', true, v2home()), phase: 'hold' }
    ctx.inShelter = true
    const fresh = { ...v2home(), site: { x: 100, y: 64, z: 100 }, interior: { min: { x: 101, y: 64, z: 101 }, max: { x: 105, y: 65, z: 104 } } }
    ticker.setHome(fresh)
    assert.equal(ctx.comehome.exiting, true)
    handleChat(bot, ticker, 'Steve', 'come home')
    assert.equal(ctx.comehome.exiting, true, 'still exiting the old house')
    assert.equal(ctx.comehome.reseek, true, 'then walks the current home')
    assert.deepEqual(ctx.comehome.home.site, SITE, 'legs stay pinned to old')
    assert.equal(ctx.inShelter, true)
  })
})

describe('jr2.3 help covers the command', () => {
  it("'help come home' explains it", () => {
    const cmd = lookupCommand('come home')
    assert.ok(cmd, 'resolves')
    assert.ok(detailLine(cmd).includes('come home'), detailLine(cmd))
    assert.ok(detailLine(cmd).length <= 256)
    const bot = tickBot({ at: { x: 30, y: 64, z: 30 }, players: { Steve: { username: 'Steve' } } })
    handleChat(bot, null, 'Steve', 'help come home')
    assert.equal(bot.chats.length, 1)
    assert.ok(bot.chats[0].includes('common room'), bot.chats[0])
  })
})
