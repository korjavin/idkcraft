'use strict'

// Bead idkcraft-erig: the night sleep click reached the bed but the server
// never put the bot to sleep ('sleep failed: bot is not sleeping'). Two
// fixes: the pre-click veto mirrors the server's bed-anchored monster box
// (vanilla startSleepInBed, Monster subclasses only — wider than the old 3D
// <8 body sphere), and a spent retry budget ends in an honest chat+log line
// instead of a silent awake night. A sustained box hold says so too.

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const Vec3 = require('vec3')
const home = require('../src/behaviours/home')

const SITE = { x: 10, y: 64, z: 20 }
const DOOR = { x: 11, y: 64, z: 20 }
const INTERIOR = { min: { x: 10, y: 64, z: 20 }, max: { x: 14, y: 66, z: 24 } }
const AT = { x: 12.5, y: 64, z: 22.5 }
const HEAD = new Vec3(13, 64, 22) // the mock bed's head (foot 12,64,22, facing east)

// Same hut mock as the a8rb stay suite: shut door, floor at 63, one placed
// bed, plus a configurable mob roster and sleep implant.
function mockBot({ at = AT, mobs = [], bedCells = ['12,64,22', '13,64,22'], sleepFn } = {}) {
  const calls = { sleeps: 0, goals: [] }
  const chats = []
  const ents = {}
  mobs.forEach((m, i) => {
    ents[`m${i}`] = { name: m.name, type: 'mob', position: new Vec3(m.pos[0], m.pos[1], m.pos[2]) }
    if (typeof m.height === 'number') ents[`m${i}`].height = m.height
    if (typeof m.width === 'number') ents[`m${i}`].width = m.width
  })
  const bot = {
    calls,
    chats,
    entities: ents,
    entity: { position: new Vec3(at.x, at.y, at.z) },
    time: { timeOfDay: 14000, day: 5 }, // night
    registry: { blocksByName: { white_bed: { id: 1 }, red_bed: { id: 2 } } },
    pathfinder: {
      goal: null,
      movements: {},
      isMoving: () => false,
      setGoal: (g) => { calls.goals.push(g); bot.pathfinder.goal = g },
      stop: () => {},
    },
    inventory: { items: () => [] },
    findBlocks: () => bedCells.length ? [{ x: 12, y: 64, z: 22 }] : [],
    blockAt: (p) => {
      const k = `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`
      if (bedCells.includes(k)) {
        return { name: 'white_bed', position: new Vec3(Math.floor(p.x), 64, Math.floor(p.z)), boundingBox: 'block' }
      }
      if (k === `${DOOR.x},${DOOR.y},${DOOR.z}`) {
        return { name: 'oak_door', position: new Vec3(DOOR.x, DOOR.y, DOOR.z), getProperties: () => ({ open: false }) }
      }
      if (Math.floor(p.y) === 63) {
        return { name: 'oak_planks', boundingBox: 'block', position: new Vec3(Math.floor(p.x), 63, Math.floor(p.z)) }
      }
      return { name: 'air', boundingBox: 'empty', position: new Vec3(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)) }
    },
    sleep: sleepFn || (async () => { calls.sleeps++ }),
    wake: async () => {},
    equip: async () => {},
    look: async () => {},
    placeBlock: async () => { throw new Error('no lay in these tests') },
    activateBlock: async () => {},
    chat: (m) => { chats.push(String(m)) },
    lookAt() {},
    setControlState() {},
    clearControlStates() {},
  }
  return bot
}

function hutCtx() {
  return {
    home: {
      site: { ...SITE },
      built: true,
      interior: { ...INTERIOR, min: { ...INTERIOR.min }, max: { ...INTERIOR.max } },
    },
  }
}

const settle = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r)) }
// One stay tick with the async click/reject flushed.
async function tick(bot, ctx) { home.stay(bot, ctx); await settle() }

describe('erig: server-box veto and honest give-up line', () => {
  it('vetoes the bed box the server refuses, anchored on the head', () => {
    const at = (name, x, y, z) => mockBot({ mobs: [{ name, pos: [x, y, z] }] })
    // 8 out from the head: 9 from the body, so the old sphere missed it.
    assert.equal(home.monsterBlocksBed(at('zombie', 21.5, 64, 22.5), HEAD), true)
    assert.equal(home.hostileNear(at('zombie', 21.5, 64, 22.5)), false)
    // High with horizontal 7: 3D body dist ~8.9, inside the server box.
    assert.equal(home.monsterBlocksBed(at('skeleton', 20.5, 68, 22.5), HEAD), true)
    assert.equal(home.monsterBlocksBed(at('zombie', 22.1, 64, 22.5), HEAD), false) // past the box
    assert.equal(home.monsterBlocksBed(at('zombie', 13.5, 70, 22.5), HEAD), false) // 6 above: clear
    assert.equal(home.monsterBlocksBed(at('zombie', 13.5, 59, 22.5), HEAD), true) // 5 below: blocked
    // The -6..-8 band is per-mob, not flat (minor 02): a zombie at head.y-7
    // sleeps fine on the server, a spider at head.y-5.5 still blocks.
    assert.equal(home.monsterBlocksBed(at('zombie', 13.5, 57, 22.5), HEAD), false)
    const spiderBelow = mockBot({ mobs: [{ name: 'spider', pos: [14.5, 58.5, 22.5], height: 0.9, width: 1.4 }] })
    assert.equal(home.monsterBlocksBed(spiderBelow, HEAD), true)
    // Enemy but not Monster: never blocks sleep (server counts Monster only).
    for (const name of ['phantom', 'slime', 'magma_cube', 'ghast', 'hoglin']) {
      assert.equal(home.monsterBlocksBed(at(name, 14.5, 64, 22.5), HEAD), false, name)
    }
    assert.equal(home.monsterBlocksBed(at('enderman', 14.5, 64, 22.5), HEAD), true) // Monster: blocks
    assert.equal(home.monsterBlocksBed(at('sheep', 14.5, 64, 22.5), HEAD), false)
    assert.equal(home.monsterBlocksBed(mockBot(), HEAD), false)
    assert.equal(home.monsterBlocksBed(mockBot(), null), false)
  })

  it('holds (no click) while a box-edge mob camps, says so once, sleeps once it leaves', async () => {
    const bot = mockBot({ mobs: [{ name: 'zombie', pos: [21.5, 64, 22.5] }] }) // head+8, body-dist 9
    const ctx = hutCtx()
    for (let t = 0; t < 35; t++) await tick(bot, ctx)
    assert.equal(bot.calls.sleeps, 0, 'no doomed click at the box edge')
    assert.ok(!ctx.stay.sleepGiveUp, 'a hold is not a give-up')
    assert.deepEqual(bot.chats, ["can't sleep yet (monsters too close), holding"], 'one hold line')
    bot.entities = {} // the mob wanders off
    await tick(bot, ctx)
    assert.equal(bot.calls.sleeps, 1, 'clicks once the box clears')
  })

  it('retries a refused bed, then says an honest line once and stops', async () => {
    const bot = mockBot({
      sleepFn: async () => { bot.calls.sleeps++; throw new Error('bot is not sleeping') },
    })
    const ctx = hutCtx()
    for (let t = 0; t < 120; t++) await tick(bot, ctx)
    assert.equal(bot.calls.sleeps, 3, 'three tries, then tonight is over')
    assert.ok(ctx.stay.sleepGiveUp, 'give-up latches')
    assert.deepEqual(
      bot.chats,
      ["can't sleep tonight (the server keeps refusing my bed), holding till dawn"],
      'exactly one honest line, blaming nothing unproven',
    )
    for (let t = 0; t < 10; t++) await tick(bot, ctx)
    assert.equal(bot.calls.sleeps, 3, 'no more clicks after give-up')
    assert.equal(bot.chats.length, 1, 'line stays once')
  })

  it('keeps retrying a shared (occupied) bed without giving up or explaining', async () => {
    const bot = mockBot({
      sleepFn: async () => { bot.calls.sleeps++; throw new Error('the bed is occupied') },
    })
    const ctx = hutCtx()
    for (let t = 0; t < 120; t++) await tick(bot, ctx)
    assert.ok(bot.calls.sleeps >= 4, `still retrying (got ${bot.calls.sleeps})`)
    assert.ok(!ctx.stay.sleepGiveUp, 'g0z.59: the second bot never gives up the night')
    assert.ok(!bot.chats.join(' ').includes("can't sleep"), 'no give-up line while retrying')
  })

  it('says why when the bed stays out of reach', async () => {
    const bot = mockBot({
      at: { x: 11.5, y: 64, z: 21.5 },
      bedCells: ['14,64,23', '14,64,24'], // placed but ~3.5 from the body
    })
    bot.findBlocks = () => [{ x: 14, y: 64, z: 23 }]
    const ctx = hutCtx()
    for (let t = 0; t < 40; t++) await tick(bot, ctx)
    assert.equal(bot.calls.sleeps, 0, 'never in click reach')
    assert.ok(ctx.stay.sleepGiveUp, 'give-up latches')
    assert.ok(bot.chats.includes("can't sleep tonight (I can't reach my bed), holding till dawn"))
  })
})

// Bead idkcraft-erig follow-up (prod 2026-10-28, fixed build): one attempt,
// refused at health 2.16/food 8 with pillagers roaming and unlit=many. The
// bed is found and clicked — the refusal is environmental. Three pre-click
// gates make the shelter sleep-safe: the interior torch lands before the
// click, hostiles inside arrow range hold it, and the attempt waits for
// food (eat-and-wait) and regen. Each skip owns an honest line; fight/flee
// stay supreme (a close hostile returns the tick silently, as before).

// SITE shifted so the v1 interior spot (site+2,64,site.z+2 = 10,64,22)
// reads air instead of colliding with the mock bed foot.
const SITE2 = { x: 8, y: 64, z: 20 }
const DOOR2 = { x: 9, y: 64, z: 20 }
const TORCH_CELL = '10,64,22'

function mockBot2({ mobs = [], pack = [], hp = 20, food = 20, torchLit = true, consumeFn, placeFn } = {}) {
  const calls = { sleeps: 0, eats: 0, torches: 0, places: 0 }
  const chats = []
  const msgHandlers = {}
  const ents = {}
  mobs.forEach((m, i) => {
    ents[`m${i}`] = { name: m.name, type: 'mob', position: new Vec3(m.pos[0], m.pos[1], m.pos[2]) }
  })
  let lit = torchLit
  const bot = {
    calls,
    chats,
    msgHandlers,
    health: hp,
    food,
    entities: ents,
    on: (ev, fn) => { (msgHandlers[ev] = msgHandlers[ev] || []).push(fn) },
    off: (ev, fn) => { msgHandlers[ev] = (msgHandlers[ev] || []).filter((f) => f !== fn) },
    entity: { position: new Vec3(AT.x, AT.y, AT.z) },
    time: { timeOfDay: 14000, day: 5 }, // night
    registry: { blocksByName: { white_bed: { id: 1 }, red_bed: { id: 2 } } },
    pathfinder: {
      goal: null,
      movements: {},
      isMoving: () => false,
      setGoal: (g) => { bot.pathfinder.goal = g },
      stop: () => {},
    },
    inventory: { items: () => pack.slice() },
    findBlocks: () => [{ x: 12, y: 64, z: 22 }],
    blockAt: (p) => {
      const k = `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`
      if (k === '12,64,22' || k === '13,64,22') {
        return { name: 'white_bed', position: new Vec3(Math.floor(p.x), 64, Math.floor(p.z)), boundingBox: 'block' }
      }
      if (k === TORCH_CELL) {
        return lit
          ? { name: 'torch', position: new Vec3(10, 64, 22), boundingBox: 'block' }
          : { name: 'air', position: new Vec3(10, 64, 22), boundingBox: 'empty' }
      }
      if (k === `${DOOR2.x},${DOOR2.y},${DOOR2.z}`) {
        return { name: 'oak_door', position: new Vec3(DOOR2.x, DOOR2.y, DOOR2.z), getProperties: () => ({ open: false }) }
      }
      if (Math.floor(p.y) === 63) {
        return { name: 'oak_planks', boundingBox: 'block', position: new Vec3(Math.floor(p.x), 63, Math.floor(p.z)) }
      }
      return { name: 'air', boundingBox: 'empty', position: new Vec3(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)) }
    },
    sleep: async () => { calls.sleeps++ },
    wake: async () => {},
    equip: async () => {},
    look: async () => {},
    placeBlock: placeFn || (async () => { calls.places++; calls.torches++; lit = true }),
    consume: consumeFn || (async () => { calls.eats++; bot.food = 20 }),
    activateBlock: async () => {},
    chat: (m) => { chats.push(String(m)) },
    lookAt() {},
    setControlState() {},
    clearControlStates() {},
  }
  return bot
}

function hutCtx2() {
  return {
    home: {
      site: { ...SITE2 },
      built: true,
      interior: { ...INTERIOR, min: { ...INTERIOR.min }, max: { ...INTERIOR.max } },
    },
  }
}

describe('erig follow-up: sleep-safe shelter before the click', () => {
  it('ring geometry: roamers inside arrow range hold, the far and high stay clear', () => {
    const at = (name, x, y, z) => mockBot({ mobs: [{ name, pos: [x, y, z] }] })
    // Head centre (13.5, 22.5): XZ 12 holds, XZ 17 clears.
    assert.equal(home.threatInSleepRing(at('pillager', 25.5, 64, 22.5), HEAD), true)
    assert.equal(home.threatInSleepRing(at('pillager', 30.5, 64, 22.5), HEAD), false)
    // Vertical band: 6 above holds, 7 above clears.
    assert.equal(home.threatInSleepRing(at('skeleton', 13.5, 70, 22.5), HEAD), true)
    assert.equal(home.threatInSleepRing(at('skeleton', 13.5, 71, 22.5), HEAD), false)
    // The server ignores phantoms but a dive still spoils the handshake.
    assert.equal(home.threatInSleepRing(at('phantom', 20.5, 68, 22.5), HEAD), true)
    assert.equal(home.monsterBlocksBed(at('phantom', 20.5, 68, 22.5), HEAD), false)
    assert.equal(home.threatInSleepRing(at('sheep', 14.5, 64, 22.5), HEAD), false)
    assert.equal(home.threatInSleepRing(mockBot(), HEAD), false)
    assert.equal(home.threatInSleepRing(mockBot(), null), false)
  })

  it('holds (no click) while a roamer camps inside arrow range, clicks once it leaves', async () => {
    const bot = mockBot2({ mobs: [{ name: 'pillager', pos: [23.5, 64, 22.5] }] }) // head+10: box clear, ring hot
    assert.equal(home.monsterBlocksBed(bot, HEAD), false, 'box reads clear: the old code clicked')
    const ctx = hutCtx2()
    for (let t = 0; t < 35; t++) await tick(bot, ctx)
    assert.equal(bot.calls.sleeps, 0, 'no doomed click into arrow range')
    assert.deepEqual(bot.chats, ["can't sleep yet (hostiles roaming close), holding"], 'one ring line')
    bot.entities = {} // the roamer moves on
    await tick(bot, ctx)
    assert.equal(bot.calls.sleeps, 1, 'clicks once the ring clears')
  })

  it('box camper says the box line, not the ring line', async () => {
    const bot = mockBot2({ mobs: [{ name: 'zombie', pos: [21.5, 64, 22.5] }] }) // head+8: box and ring hot
    const ctx = hutCtx2()
    for (let t = 0; t < 35; t++) await tick(bot, ctx)
    assert.equal(bot.calls.sleeps, 0)
    assert.deepEqual(bot.chats, ["can't sleep yet (monsters too close), holding"], 'closest blocker first')
  })

  it('eats first (eat-and-wait beat) and holds the click while hungry', async () => {
    let releaseEat = null
    const bot = mockBot2({
      hp: 20,
      food: 8,
      pack: [{ name: 'bread', count: 3 }, { name: 'torch', count: 2 }], // torch: the room reads lit
      consumeFn: () => new Promise((res) => {
        bot.calls.eats++
        releaseEat = () => { bot.food = 20; res() }
      }),
    })
    const ctx = hutCtx2()
    for (let t = 0; t < 35; t++) await tick(bot, ctx)
    assert.ok(bot.calls.eats >= 1, 'the beat eats')
    assert.equal(bot.calls.sleeps, 0, 'no click on an empty stomach')
    assert.deepEqual(bot.chats, ["can't sleep yet (eating first), holding"], 'one eat line')
    releaseEat()
    for (let t = 0; t < 5; t++) await tick(bot, ctx)
    assert.ok(bot.calls.sleeps >= 1, 'clicks once fed')
  })

  it('says so once and tries anyway with nothing edible on hand', async () => {
    const bot = mockBot2({ hp: 20, food: 8, pack: [], torchLit: false })
    const ctx = hutCtx2()
    for (let t = 0; t < 5; t++) await tick(bot, ctx)
    assert.ok(bot.calls.sleeps >= 1, 'fail open: a click is harmless')
    assert.ok(bot.chats.includes('hungry with nothing to eat, trying anyway'), 'honest shortfall line')
    assert.ok(bot.chats.includes('no torches to light the room, trying anyway'), 'torch shortfall line')
    assert.ok(bot.chats.includes('sleeping in a nearby bed'), 'the attempt still goes out')
    assert.equal(bot.chats.length, 3, 'each line exactly once')
  })

  it('fails open past a broken consume instead of holding all night', async () => {
    const bot = mockBot2({
      hp: 20,
      food: 8,
      pack: [{ name: 'bread', count: 1 }],
      consumeFn: () => new Promise(() => {}), // never resolves
    })
    const ctx = hutCtx2()
    for (let t = 0; t < 120; t++) await tick(bot, ctx)
    assert.ok(bot.calls.sleeps >= 1, 'past the beat the click goes out')
    assert.ok(bot.chats.includes("can't sleep yet (eating first), holding"))
    assert.ok(bot.chats.includes('still hungry, trying anyway'), 'fail-open line')
  })

  it('waits for regen below half, then clicks once healed', async () => {
    const bot = mockBot2({ hp: 2.16, food: 20, pack: [] }) // prod vitals, fed
    const ctx = hutCtx2()
    for (let t = 0; t < 35; t++) await tick(bot, ctx)
    assert.equal(bot.calls.sleeps, 0, 'no weak click')
    assert.ok(bot.chats.includes("can't sleep yet (healing first), holding"), 'one heal line')
    bot.health = 12 // regen lands
    for (let t = 0; t < 5; t++) await tick(bot, ctx)
    assert.ok(bot.calls.sleeps >= 1, 'clicks once healed')
  })

  it('places the night torch before the click', async () => {
    const bot = mockBot2({ torchLit: false, pack: [{ name: 'torch', count: 4 }] })
    const ctx = hutCtx2()
    for (let t = 0; t < 10; t++) await tick(bot, ctx)
    assert.equal(bot.calls.torches, 1, 'the interior spot burns first')
    assert.ok(bot.calls.sleeps >= 1, 'then the click goes out')
  })

  it('a close hostile keeps fight supreme: silent hold, no click, no sleep line', async () => {
    const bot = mockBot2({ mobs: [{ name: 'zombie', pos: [15.5, 64, 22.5] }] }) // 3 from the body
    assert.equal(home.hostileNear(bot), true, 'fight owns this tick')
    const ctx = hutCtx2()
    for (let t = 0; t < 35; t++) await tick(bot, ctx)
    assert.equal(bot.calls.sleeps, 0, 'never clicks through a real threat')
    assert.ok(!bot.chats.some((m) => m.includes("can't sleep")), 'no sleep line: fight owns the tick')
  })

  it('a refused torch spot never starves the click: three strikes, one line, then the attempt', async () => {
    const bot = mockBot2({
      torchLit: false,
      pack: [{ name: 'torch', count: 4 }],
      placeFn: async () => { bot.calls.places++; throw new Error('protected') },
    })
    const ctx = hutCtx2()
    for (let t = 0; t < 15; t++) await tick(bot, ctx)
    assert.equal(bot.calls.places, 3, 'bounded retries, not a nightly loop')
    assert.ok(bot.calls.sleeps >= 1, 'the click proceeds past the dead spot')
    assert.deepEqual(
      bot.chats.filter((m) => m !== 'sleeping in a nearby bed'),
      ['could not light the room, trying anyway'],
      'one fail-open line',
    )
  })

  it('an out-of-reach torch spot is skipped silently and the click proceeds', async () => {
    const bot = mockBot2({ torchLit: false, pack: [{ name: 'torch', count: 4 }] })
    // Interior spot lands at (2,64,22), ~10 from the body: findRef may
    // succeed, but placeBlock cannot — the gate must not flight.
    const ctx = { home: { site: { x: 0, y: 64, z: 20 }, built: true, interior: { ...INTERIOR, min: { ...INTERIOR.min }, max: { ...INTERIOR.max } } } }
    for (let t = 0; t < 5; t++) await tick(bot, ctx)
    assert.equal(bot.calls.places, 0, 'no doomed flight')
    assert.ok(bot.calls.sleeps >= 1, 'the click goes out')
    assert.ok(!bot.chats.some((m) => m.includes('torch')), 'no torch line at all')
  })

  it('unreadable vitals fail open: unknown food never holds a weak body', async () => {
    const bot = mockBot2({ hp: 2.16, food: 8, pack: [] })
    delete bot.health
    delete bot.food
    const ctx = hutCtx2()
    for (let t = 0; t < 40; t++) await tick(bot, ctx)
    assert.ok(bot.calls.sleeps >= 1, 'the click goes out')
    assert.ok(!bot.chats.some((m) => m.includes("can't sleep")), 'no hold without readable vitals')
  })

  it('boxOccupants snapshots who is inside the server box', () => {
    const zombie = { name: 'zombie', pos: [21.5, 64, 22.5] }
    const snap = home.boxOccupants(mockBot({ mobs: [zombie] }), HEAD)
    assert.equal(snap.length, 1)
    assert.equal(snap[0].name, 'zombie')
    assert.deepEqual(home.boxOccupants(mockBot({ mobs: [{ name: 'phantom', pos: [14.5, 64, 22.5] }] }), HEAD), [])
    assert.deepEqual(home.boxOccupants(mockBot(), HEAD), [])
    assert.deepEqual(home.boxOccupants(mockBot(), null), [])
  })

  it('a roamer wandering in mid-click retries without spending the refusal budget', async () => {
    const bot = mockBot2({ hp: 20, food: 20, pack: [] })
    bot.sleep = async () => {
      bot.calls.sleeps++
      // Clear at click (the pre-click veto passed), hot at reject: the
      // handshake, not the bed, is at fault.
      bot.entities.m0 = { name: 'zombie', type: 'mob', position: new Vec3(21.5, 64, 22.5) }
      throw new Error('bot is not sleeping')
    }
    const ctx = hutCtx2()
    for (let t = 0; t < 100; t++) { await tick(bot, ctx); bot.entities = {} }
    assert.equal(bot.calls.sleeps, 4, 'tries at 0/31/62/93, budget untouched')
    assert.ok(!ctx.stay.sleepGiveUp, 'a spoiled handshake is not a dead bed')
    assert.ok(!bot.chats.some((m) => m.includes("can't sleep")), 'transients stay silent')
  })

  it('a patrol route through the box gives up with the patrol line, not the refusal line', async () => {
    const bot = mockBot2({ hp: 20, food: 20, pack: [] })
    bot.sleep = async () => {
      bot.calls.sleeps++
      bot.entities.m0 = { name: 'pillager', type: 'mob', position: new Vec3(20.5, 64, 22.5) }
      throw new Error('bot is not sleeping')
    }
    const ctx = hutCtx2()
    for (let t = 0; t < 200; t++) { await tick(bot, ctx); bot.entities = {} }
    assert.equal(bot.calls.sleeps, 6, 'bounded transients, then tonight is over')
    assert.ok(ctx.stay.sleepGiveUp, 'give-up latches')
    assert.deepEqual(
      bot.chats,
      ["can't sleep tonight (hostiles keep spoiling the attempt), holding till dawn"],
      'the patrol signal, once',
    )
    for (let t = 0; t < 40; t++) await tick(bot, ctx)
    assert.equal(bot.calls.sleeps, 6, 'no more clicks after give-up')
  })

  it("the server's own monster line retries as a transient even with a clear box", async () => {
    const bot = mockBot2({ hp: 20, food: 20, pack: [] })
    bot.sleep = async () => {
      bot.calls.sleeps++
      // Direct system-push shape: a single {message, position} object.
      for (const fn of (bot.msgHandlers.message || [])) {
        fn({ message: 'You may not rest now; there are monsters nearby', position: 'game_info' })
      }
      throw new Error('bot is not sleeping')
    }
    const ctx = hutCtx2()
    for (let t = 0; t < 100; t++) await tick(bot, ctx)
    assert.equal(bot.calls.sleeps, 4, 'transient, budget untouched')
    assert.ok(!ctx.stay.sleepGiveUp, 'the server named the cause: keep trying')
  })

  it('player chat quoting monsters never counts as the server line', async () => {
    const bot = mockBot2({ hp: 20, food: 20, pack: [] })
    bot.sleep = async () => {
      bot.calls.sleeps++
      // Held-path shape: ChatMessage-ish plus position arg, but from chat.
      for (const fn of (bot.msgHandlers.message || [])) {
        fn({ text: 'there are monsters nearby lol', toString: () => 'there are monsters nearby lol' }, 'chat', null)
      }
      throw new Error('bot is not sleeping')
    }
    const ctx = hutCtx2()
    for (let t = 0; t < 120; t++) await tick(bot, ctx)
    assert.equal(bot.calls.sleeps, 3, 'the plain budget path')
    assert.ok(ctx.stay.sleepGiveUp, 'give-up latches')
    assert.deepEqual(
      bot.chats,
      ["can't sleep tonight (the server keeps refusing my bed), holding till dawn"],
      'no phantom patrol signal from player chat',
    )
  })

  it('a bed broken mid-flight says the bed is gone, not that the server refused', async () => {
    const bot = mockBot2({ hp: 20, food: 20, pack: [] })
    let gone = false
    const liveBlockAt = bot.blockAt
    bot.blockAt = (p) => {
      const k = `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`
      if (gone && (k === '12,64,22' || k === '13,64,22')) {
        return { name: 'air', position: new Vec3(Math.floor(p.x), 64, Math.floor(p.z)), boundingBox: 'empty' }
      }
      return liveBlockAt(p)
    }
    bot.sleep = async () => { bot.calls.sleeps++; gone = true; throw new Error('bot is not sleeping') }
    const ctx = hutCtx2()
    for (let t = 0; t < 60; t++) await tick(bot, ctx)
    assert.equal(bot.calls.sleeps, 1, 'resolved live, refused gone: one doomed click, never again')
    assert.ok(ctx.stay.sleepGiveUp, 'give-up latches')
    assert.ok(bot.chats.includes("can't sleep tonight (my bed is gone), holding till dawn"))
  })

describe('erig round 5: refusal-driven waiting replaces the fixed tick', () => {
  it('attempts at dusk: no tick gate, the server decides', async () => {
    const bot = mockBot2({ hp: 20, food: 20, pack: [] }) // prod vitals: torch/vitals/ring all fine
    bot.time.timeOfDay = 12400 // facts time=dusk
    const ctx = hutCtx2()
    for (let t = 0; t < 5; t++) await tick(bot, ctx)
    assert.ok(bot.calls.sleeps >= 1, 'the attempt goes out at dusk')
    assert.equal(ctx.inShelter, true, 'still inside behind the shut door')
  })

  it('a client-side early-night refusal holds silently and retries till true night', async () => {
    const bot = mockBot2({ hp: 20, food: 20, pack: [] })
    bot.time.timeOfDay = 12400
    bot.sleep = async () => { bot.calls.sleeps++; throw new Error("it's not night and it's not a thunderstorm") }
    const ctx = hutCtx2()
    for (let t = 0; t < 120; t++) await tick(bot, ctx)
    assert.equal(bot.calls.sleeps, 4, 'retries on the ~30 s timer (0/31/62/93), not the 3-try budget')
    assert.ok(!ctx.stay.sleepGiveUp, 'early night never gives up')
    assert.ok(!ctx.stay.sleepRefusals, 'the failure budget is untouched')
    assert.deepEqual(bot.chats, [], 'silent: no line while waiting on the night')
    bot.time.timeOfDay = 14000 // skyDarken crosses 4: the server accepts
    bot.sleep = async () => { bot.calls.sleeps++ }
    for (let t = 0; t < 35; t++) await tick(bot, ctx) // the ~30 s cooldown drains first
    assert.ok(bot.chats.includes('sleeping in a nearby bed'), 'sleeps once accepted')
  })

  it("the server's own early-night line holds silently, budget untouched, till it accepts", async () => {
    const bot = mockBot2({ hp: 20, food: 20, pack: [] })
    bot.time.timeOfDay = 12400
    let accept = false
    bot.sleep = async () => {
      bot.calls.sleeps++
      if (accept) return
      for (const fn of (bot.msgHandlers.message || [])) {
        fn({ text: 'You can sleep only at night or during thunderstorms' }, 'game_info')
      }
      throw new Error('bot is not sleeping')
    }
    const ctx = hutCtx2()
    for (let t = 0; t < 100; t++) await tick(bot, ctx)
    assert.equal(bot.calls.sleeps, 4, 'retries on the timer, never the give-up budget')
    assert.ok(!ctx.stay.sleepGiveUp, 'no give-up on an early night')
    assert.ok(!ctx.stay.sleepRefusals, 'budget untouched')
    assert.deepEqual(bot.chats, [], 'silent hold')
    accept = true // true night: the next attempt lands
    bot.time.timeOfDay = 12600
    for (let t = 0; t < 35; t++) await tick(bot, ctx) // the ~30 s cooldown drains first
    assert.ok(bot.chats.includes('sleeping in a nearby bed'), 'sleeps once accepted')
  })

  it('dawn breaks the hold: no attempt, no line, no latch', async () => {
    const bot = mockBot2({ hp: 20, food: 20, pack: [] })
    bot.time.timeOfDay = 12400
    bot.sleep = async () => { bot.calls.sleeps++; throw new Error("it's not night and it's not a thunderstorm") }
    const ctx = hutCtx2()
    for (let t = 0; t < 40; t++) await tick(bot, ctx)
    assert.ok(bot.calls.sleeps >= 1, 'held through dusk')
    const held = bot.calls.sleeps
    bot.time.timeOfDay = 6000 // dawn: the stay leaves the night branch
    for (let t = 0; t < 5; t++) await tick(bot, ctx)
    assert.equal(bot.calls.sleeps, held, 'no attempt by day')
    assert.ok(!bot.chats.some((m) => m.includes("can't sleep")), 'no failure line')
    assert.ok(!ctx.stay.sleepGiveUp, 'no latch')
  })

  it('torch, vitals and the 16-block ring still gate the dusk attempt', async () => {
    const bot = mockBot2({ mobs: [{ name: 'pillager', pos: [23.5, 64, 22.5] }] })
    bot.time.timeOfDay = 12400
    const ctx = hutCtx2()
    for (let t = 0; t < 35; t++) await tick(bot, ctx)
    assert.equal(bot.calls.sleeps, 0, 'the ring still holds the click')
    assert.deepEqual(bot.chats, ["can't sleep yet (hostiles roaming close), holding"])
  })
})

  it('prod night end to end: ring holds, then torch, meal, click', async () => {
    const bot = mockBot2({
      hp: 2.16,
      food: 8,
      torchLit: false,
      pack: [{ name: 'bread', count: 3 }, { name: 'torch', count: 4 }],
      mobs: [{ name: 'pillager', pos: [23.5, 64, 22.5] }],
    })
    const ctx = hutCtx2()
    for (let t = 0; t < 40; t++) await tick(bot, ctx)
    assert.equal(bot.calls.sleeps, 0, 'nothing doomed goes out')
    assert.equal(bot.calls.torches, 0, 'the room waits: the ring is hot')
    assert.equal(bot.calls.eats, 0, 'the meal waits too')
    assert.deepEqual(bot.chats, ["can't sleep yet (hostiles roaming close), holding"])
    bot.entities = {} // the patrol moves on
    bot.health = 12 // and the body heals (fed by the beat below)
    for (let t = 0; t < 40; t++) await tick(bot, ctx)
    assert.equal(bot.calls.torches, 1, 'room lit before the click')
    assert.ok(bot.calls.eats >= 1, 'meal before the click')
    assert.ok(bot.calls.sleeps >= 1, 'click only when safe')
  })
})
