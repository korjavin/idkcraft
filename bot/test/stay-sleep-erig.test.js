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
