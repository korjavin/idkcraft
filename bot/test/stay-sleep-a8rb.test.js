'use strict'

// Bead idkcraft-a8rb: the night stay sleeps in a bed when inside — a nearby
// placed bed first, then a carried bed laid in a free inside spot, then a
// bed crafted from the pack; honest skip otherwise. Never overrides
// fight/flee; wakes at dawn and resumes.

const { describe, it, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const Vec3 = require('vec3')
const home = require('../src/behaviours/home')

const SITE = { x: 10, y: 64, z: 20 }
const DOOR = { x: 11, y: 64, z: 20 } // site+(1,0,0), the hut door
const INSIDE = { x: 11, y: 64, z: 21 }
const HUT_TABLE = { x: 14, y: 64, z: 21 } // site+(4,0,1), the hut table cell
const INTERIOR = { min: { x: 10, y: 64, z: 20 }, max: { x: 14, y: 66, z: 24 } }

// Dynamic world: a floor at y 63, a shut hut door, air elsewhere, plus
// beds that appear once the bot places them (the lay-then-sleep chain).
function mockBot({ at, pack = [], hostile = false, table = false } = {}) {
  const calls = { sleeps: 0, wakes: 0, places: 0, goals: [] }
  const chats = []
  const beds = new Map() // 'x,y,z' -> bed block
  const state = { yaw: 0 }
  const bot = {
    calls,
    chats,
    entities: hostile
      ? { m1: { name: 'zombie', type: 'mob', position: new Vec3(at.x + 2, at.y, at.z) } }
      : {},
    entity: { position: new Vec3(at.x, at.y, at.z) },
    time: { timeOfDay: 14000, day: 5 }, // night
    registry: { blocksByName: {} },
    pathfinder: {
      goal: null,
      movements: {},
      isMoving: () => false,
      setGoal: (g) => { calls.goals.push(g); bot.pathfinder.goal = g },
      stop: () => {},
    },
    inventory: { items: () => pack.map((n) => ({ name: n, count: 1 })) },
    findBlocks: () => [...beds.values()].filter((b, i, a) => a.indexOf(b) === i)
      .map((b) => ({ x: b.position.x, y: b.position.y, z: b.position.z }))
      .filter((p, i, a) => a.findIndex((q) => q.x === p.x && q.y === p.y && q.z === p.z) === i)
      .slice(0, 8),
    blockAt: (p) => {
      const k = `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`
      if (beds.has(k)) return beds.get(k)
      if (k === `${DOOR.x},${DOOR.y},${DOOR.z}`) {
        return { name: 'oak_door', position: new Vec3(DOOR.x, DOOR.y, DOOR.z), getProperties: () => ({ open: false }) }
      }
      if (table && k === `${HUT_TABLE.x},${HUT_TABLE.y},${HUT_TABLE.z}`) {
        return { name: 'crafting_table', position: new Vec3(HUT_TABLE.x, HUT_TABLE.y, HUT_TABLE.z) }
      }
      if (Math.floor(p.y) === 63) {
        return { name: 'oak_planks', boundingBox: 'block', position: new Vec3(Math.floor(p.x), 63, Math.floor(p.z)) }
      }
      return { name: 'air', boundingBox: 'empty', position: new Vec3(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)) }
    },
    sleep: async () => { calls.sleeps++ },
    wake: async () => { calls.wakes++ },
    equip: async () => {},
    look: async (yaw) => { state.yaw = yaw },
    placeBlock: async (ref) => {
      calls.places++
      const fx = ref.position.x
      const fy = ref.position.y + 1
      const fz = ref.position.z
      const f = ((Math.round(-state.yaw / (Math.PI / 2)) % 4) + 4) % 4
      const dirs = [[0, -1], [1, 0], [0, 1], [-1, 0]]
      const foot = new Vec3(fx, fy, fz)
      const head = new Vec3(fx + dirs[f][0], fy, fz + dirs[f][1])
      beds.set(`${foot.x},${foot.y},${foot.z}`, { name: 'red_bed', position: foot, boundingBox: 'block' })
      beds.set(`${head.x},${head.y},${head.z}`, { name: 'red_bed', position: head, boundingBox: 'block' })
    },
    activateBlock: async () => {},
    chat: (m) => { chats.push(String(m)) },
    lookAt() {},
    setControlState() {},
    clearControlStates() {},
  }
  for (const n of ['white_bed', 'red_bed']) bot.registry.blocksByName[n] = { id: Object.keys(bot.registry.blocksByName).length + 1 }
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

const settle = async (ms = 30) => { for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r)) }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// craftany runs the real gear stack (inventory windows): too heavy for a
// stay unit test, so the craft-wiring test stubs the module seam home.js
// already requires through. Save/restore the require cache around it.
const craftanyPath = require.resolve('../src/behaviours/craftany')
let realCraftany
function stubCraftany(fn) {
  if (!(craftanyPath in require.cache)) realCraftany = undefined
  else realCraftany = require.cache[craftanyPath]
  require.cache[craftanyPath] = { exports: fn }
}
afterEach(() => {
  if (realCraftany === undefined) delete require.cache[craftanyPath]
  else require.cache[craftanyPath] = realCraftany
})

describe('a8rb: night stay sleeps in a bed when inside', () => {
  it('uses a nearby placed bed', async () => {
    const bot = mockBot({ at: { x: 12.5, y: 64, z: 22.5 } })
    // A placed bed inside: foot (12,64,22) head (13,64,22), facing east.
    bot.blockAt = ((prev) => (p) => {
      const k = `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`
      if (k === '12,64,22' || k === '13,64,22') {
        return { name: 'white_bed', position: new Vec3(Math.floor(p.x), 64, Math.floor(p.z)), boundingBox: 'block' }
      }
      return prev(p)
    })(bot.blockAt)
    bot.findBlocks = () => [{ x: 12, y: 64, z: 22 }]
    const ctx = hutCtx()
    home.stay(bot, ctx)
    await settle()
    assert.equal(bot.calls.sleeps, 1)
    assert.ok(bot.chats.includes('sleeping in a nearby bed'))
  })

  it('places a carried bed in a free inside spot, then sleeps in it', async () => {
    const bot = mockBot({ at: { x: 11.5, y: 64, z: 21.5 }, pack: ['red_bed'] })
    const ctx = hutCtx()
    home.stay(bot, ctx)
    await sleep(700) // the lay awaits a 500 ms head sync
    assert.equal(bot.calls.places, 1)
    assert.ok(!ctx.home.bedA, 'a free-spot lay claims no bedroom')
    home.stay(bot, ctx) // the placed bed is now a nearby bed
    await settle()
    assert.equal(bot.calls.sleeps, 1)
  })

  it('crafts when materials allow (pack + table in reach)', async () => {
    const seen = []
    stubCraftany((b, c, name, count) => { seen.push([name, count]); return 'running' })
    const bot = mockBot({
      at: { x: 11.5, y: 64, z: 21.5 },
      pack: ['white_wool', 'white_wool', 'white_wool', 'oak_planks', 'oak_planks', 'oak_planks'],
      table: true,
    })
    const ctx = hutCtx()
    home.stay(bot, ctx)
    await settle()
    assert.deepEqual(seen, [['white_bed', 1]])
    assert.equal(bot.calls.sleeps, 0)
    assert.equal(bot.calls.places, 0)
  })

  it('honest skip with no bed and no mats, once a night', () => {
    const bot = mockBot({ at: { x: 11.5, y: 64, z: 21.5 } })
    const ctx = hutCtx()
    home.stay(bot, ctx)
    home.stay(bot, ctx)
    assert.equal(bot.calls.sleeps, 0)
    assert.equal(bot.calls.places, 0)
    assert.deepEqual(bot.chats, ['no bed in reach tonight, holding till dawn'])
  })

  it('never interrupts fight: hostile near vetoes sleep, lay and craft', async () => {
    let crafted = 0
    stubCraftany(() => { crafted++; return 'running' })
    const bot = mockBot({
      at: { x: 12.5, y: 64, z: 22.5 },
      pack: ['red_bed', 'white_wool', 'white_wool', 'white_wool', 'oak_planks', 'oak_planks', 'oak_planks'],
      hostile: true,
      table: true,
    })
    bot.blockAt = ((prev) => (p) => {
      const k = `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`
      if (k === '12,64,22' || k === '13,64,22') {
        return { name: 'white_bed', position: new Vec3(Math.floor(p.x), 64, Math.floor(p.z)), boundingBox: 'block' }
      }
      return prev(p)
    })(bot.blockAt)
    bot.findBlocks = () => [{ x: 12, y: 64, z: 22 }]
    const ctx = hutCtx()
    home.stay(bot, ctx)
    await settle()
    assert.equal(bot.calls.sleeps, 0)
    assert.equal(bot.calls.places, 0)
    assert.equal(crafted, 0)
    assert.ok(!bot.chats.join(' ').includes('sleeping'))
  })

  it('wakes at dawn and resumes', async () => {
    const bot = mockBot({ at: { x: 11.5, y: 64, z: 21.5 } })
    bot.isSleeping = true
    bot.time = { timeOfDay: 1000, day: 6 } // day
    const ctx = hutCtx()
    ctx.stay = { phase: 'hold' }
    home.stay(bot, ctx)
    await settle()
    assert.equal(bot.calls.wakes, 1)
  })

  it('never takes the owner bedroom bed (B)', () => {
    const bot = mockBot({ at: { x: 12.5, y: 64, z: 22.5 } })
    bot.blockAt = ((prev) => (p) => {
      const k = `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`
      if (k === '12,64,22' || k === '13,64,22') {
        return { name: 'white_bed', position: new Vec3(Math.floor(p.x), 64, Math.floor(p.z)), boundingBox: 'block' }
      }
      return prev(p)
    })(bot.blockAt)
    bot.findBlocks = () => [{ x: 12, y: 64, z: 22 }]
    const ctx = hutCtx()
    const cells = { a: null, b: { foot: new Vec3(12, 64, 22), head: new Vec3(13, 64, 22) } }
    assert.equal(home.nearbyBed(bot, ctx.home, cells), null)
  })

  it('craftableBed gates on mats and a table in reach', () => {
    const mats = ['white_wool', 'white_wool', 'white_wool', 'oak_planks', 'oak_planks', 'oak_planks']
    assert.equal(home.craftableBed(mockBot({ at: { x: 11.5, y: 64, z: 21.5 }, pack: mats, table: true }), hutCtx().home), 'white_bed')
    assert.equal(home.craftableBed(mockBot({ at: { x: 11.5, y: 64, z: 21.5 }, pack: mats }), hutCtx().home), null) // hut table stands outside
    assert.equal(home.craftableBed(mockBot({ at: { x: 11.5, y: 64, z: 21.5 }, table: true }), hutCtx().home), null) // no mats
  })
})
