'use strict'

// Bead idkcraft-p5hk: far from the home bed, a carried bed is laid beside
// the body at night and slept in; dawn breaks it back into the pack.
// No bed (or no flat spot) keeps today's dig-in.

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const { Vec3 } = require('vec3')
const home = require('../src/behaviours/home')

function key(x, y, z) { return `${x},${y},${z}` }
function pos(x, y, z) {
  const p = { x, y, z, distanceTo: (q) => Math.hypot(x - q.x, y - q.y, z - q.z) }
  p.clone = () => pos(p.x, p.y, p.z)
  p.floored = () => pos(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z))
  p.offset = (a, b, c) => pos(x + a, y + b, z + c)
  return p
}
const DIRS = [[0, -1], [1, 0], [0, 1], [-1, 0]]

// Flat grass at y<=63; beds live in `beds` (cell -> name).
function fieldBot(withBed) {
  const beds = new Map()
  const items = withBed ? [{ name: 'red_bed', count: 1 }] : []
  let facing = 1
  const bot = {
    username: 'IdkBot',
    players: {},
    entities: {},
    health: 20,
    food: 20,
    isSleeping: false,
    time: { timeOfDay: 15000, day: 5 },
    entity: { position: pos(0.5, 64, 0.5), onGround: true },
    inventory: { items: () => items.filter((i) => i.count > 0) },
    heldItem: null,
    controls: {},
    goals: [],
    pathfinder: { goal: null, setGoal(g) { bot.goals.push(g) }, isMoving: () => false, stop: () => {} },
    setControlState() {},
    clearControlStates() {},
    findBlocks: () => [],
    chat: () => {},
    on() {},
    off() {},
    blockAt(p) {
      const x = Math.floor(p.x); const y = Math.floor(p.y); const z = Math.floor(p.z)
      const b = beds.get(key(x, y, z))
      const name = b || (y <= 63 ? 'grass_block' : 'air')
      return { name, position: new Vec3(x, y, z), boundingBox: name === 'air' ? 'empty' : 'block' }
    },
    async equip(item) { bot.heldItem = item },
    async look(yaw) { facing = ((Math.round(-yaw / (Math.PI / 2)) % 4) + 4) % 4 },
    async placeBlock(ref, face) {
      const f = ref.position.plus(face)
      beds.set(key(f.x, f.y, f.z), bot.heldItem.name)
      beds.set(key(f.x + DIRS[facing][0], f.y, f.z + DIRS[facing][1]), bot.heldItem.name)
      bot.heldItem.count--
    },
    async sleep(b) { bot.sleptAt = b.position; bot.isSleeping = true },
    async wake() { bot.isSleeping = false },
    async dig(b) {
      for (const k of [...beds.keys()]) beds.delete(k) // either half breaks the bed
      bot.dropAt = b.position
    },
  }
  bot.beds = beds
  bot.items = items
  return bot
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms))

async function quiet(fn) {
  const orig = console.log
  const logs = []
  console.log = (m) => { logs.push(String(m)) }
  try { await fn() } finally { console.log = orig }
  return logs
}

describe('p5hk field bed', () => {
  it('night: lays the carried bed beside the body, sleeps; dawn breaks and picks it up', async () => {
    const bot = fieldBot(true)
    const ctx = { step: 'shelter', stepStatus: 'running', home: { site: { x: 600, y: 64, z: 600 }, built: true, bedA: new Vec3(602, 64, 602) } }
    const logs = await quiet(async () => {
      home.shelter(bot, ctx, null, {})
      assert.equal(ctx.shelter.fieldSpot !== undefined, true, 'lay flight started')
      await wait(600) // layNightBed settles 500 ms
      assert.equal(bot.beds.size, 2, 'bed laid (foot + head)')
      assert.equal(bot.items[0].count, 0)
      home.shelter(bot, ctx, null, {}) // confirms the lay, clicks the bed
      await wait(5)
      assert.ok(bot.isSleeping, 'asleep in the field bed')
      assert.ok(!ctx.shelter.dig && !ctx.shelter.pillared, 'no dig-in')
      assert.ok(!ctx.home.sleptA, 'never claims the home bed spawn')
      // Dawn (goal.js stickyHold keeps shelter while the bed stands).
      bot.time.timeOfDay = 1000
      bot.isSleeping = false
      assert.ok(ctx.shelter.fieldBed)
      home.shelter(bot, ctx, null, {}) // breaks the bed
      await wait(5)
      assert.equal(bot.beds.size, 0, 'bed broken')
      assert.equal(ctx.stepStatus, 'running', 'pickup still owes the drop')
      home.shelter(bot, ctx, null, {})
      const g = bot.goals[bot.goals.length - 1]
      assert.ok(g && g.x === bot.dropAt.x && g.z === bot.dropAt.z, 'walks onto the drop cell')
      bot.items[0].count = 1 // the pickup landed
      home.shelter(bot, ctx, null, {})
      assert.equal(ctx.stepStatus, 'done')
      assert.equal(ctx.shelter.fieldBed, null)
    })
    assert.ok(logs.some((l) => l.includes('field bed: picked up')), logs.join('\n'))
  })

  it('no bed in the pack: today\'s dig-in, untouched', async () => {
    const bot = fieldBot(false)
    const ctx = { step: 'shelter', stepStatus: 'running' }
    await quiet(async () => { home.shelter(bot, ctx, null, {}) })
    assert.equal(ctx.shelter.fieldOff, true)
    assert.equal(bot.beds.size, 0)
  })

  it('near the home bed: no field bed', async () => {
    const bot = fieldBot(true)
    const ctx = { step: 'shelter', stepStatus: 'running', home: { site: { x: 10, y: 64, z: 10 }, built: false, bedA: new Vec3(12, 64, 12) } }
    await quiet(async () => { home.shelter(bot, ctx, null, {}) })
    assert.equal(ctx.shelter.fieldOff, true)
    await wait(600)
    assert.equal(bot.beds.size, 0)
  })


  it('a placed castle site bed in range: walks to it, sleeps, dawn leaves it standing', async () => {
    const bot = fieldBot(false)
    bot.beds.set(key(40, 64, 0), 'red_bed')
    bot.beds.set(key(41, 64, 0), 'red_bed') // head +x (sitebed's east yaw)
    const ctx = { step: 'shelter', stepStatus: 'running', castle: { site: { x: 60, y: 64, z: 0 }, siteBed: { x: 40, y: 64, z: 0 } } }
    const logs = await quiet(async () => {
      home.shelter(bot, ctx, null, {})
      assert.ok(ctx.shelter.fieldBed && ctx.shelter.fieldKnown, 'known bed adopted')
      home.shelter(bot, ctx, null, {})
      const g = bot.goals[bot.goals.length - 1]
      assert.ok(g && Math.abs(g.x - 41) <= 1, 'walks to the bed')
      bot.entity.position = pos(41.5, 64, 1.5)
      home.shelter(bot, ctx, null, {})
      await wait(5)
      assert.ok(bot.isSleeping, 'asleep in the site bed')
      assert.ok(!ctx.shelter.dig && !ctx.shelter.pillared, 'no dig-in')
      bot.time.timeOfDay = 1000
      bot.isSleeping = false
      home.shelter(bot, ctx, null, {})
      assert.equal(ctx.stepStatus, 'done')
      assert.equal(bot.beds.size, 2, 'site bed never broken')
    })
    assert.ok(logs.some((l) => l.includes('walking to my bed')), logs.join('\n'))
  })

  it('an unrecorded placed bed (respawn bed) within 32: found by scan and adopted', async () => {
    const bot = fieldBot(false)
    bot.beds.set(key(5, 64, 0), 'red_bed')
    bot.beds.set(key(6, 64, 0), 'red_bed')
    bot.registry = { blocksByName: { red_bed: { id: 7 } } }
    bot.findBlocks = (o) => (o.maxDistance >= 6 ? [new Vec3(5, 64, 0), new Vec3(6, 64, 0)] : [])
    const ctx = { step: 'shelter', stepStatus: 'running', castle: { site: { x: 0, y: 64, z: 0 } } }
    const logs = await quiet(async () => { home.shelter(bot, ctx, null, {}) })
    assert.ok(ctx.shelter.fieldBed && ctx.shelter.fieldKnown, 'scanned bed adopted')
    assert.ok(logs.some((l) => l.includes('walking to my bed')), logs.join('\n'))
  })

  it('a placed bed past 96 of bot and site: not adopted', async () => {
    const bot = fieldBot(false)
    bot.beds.set(key(200, 64, 0), 'red_bed')
    bot.beds.set(key(201, 64, 0), 'red_bed')
    const ctx = { step: 'shelter', stepStatus: 'running', castle: { site: { x: 0, y: 64, z: 0 }, siteBed: { x: 200, y: 64, z: 0 } } }
    await quiet(async () => { home.shelter(bot, ctx, null, {}) })
    assert.equal(ctx.shelter.fieldOff, true)
  })
})
