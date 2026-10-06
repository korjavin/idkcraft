'use strict'

// Bead idkcraft-vmzq.14: siteFor accepted the flat roof of a standing
// house as ground — groundY read 42 roof columns and founded at roof
// height (rig: JR-BUILD-FRESH sited at -144 75 -77 on the just-built
// house at -144 72 -77 and TIMED OUT stuck=31; prod path: an owner
// saying build here beside their standing house gets a roof build that
// can stall). Fix: site validation rejects non-natural ground (placed
// blocks / existing structures), mirroring castle FOREIGN.

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const { createTicker, handleChat } = require('../src/index')
const goal = require('../src/goal')

function pos(x, y, z) {
  const p = { x, y, z, distanceTo: (q) => Math.hypot(x - q.x, y - q.y, z - q.z) }
  p.clone = () => pos(p.x, p.y, p.z)
  p.floored = () => pos(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z))
  return p
}

// Fake voxel world: explicit cells plus default terrain (dirt at y<=63,
// air above).
function makeWorld() {
  const cells = new Map()
  const key = (x, y, z) => `${Math.floor(x)},${Math.floor(y)},${Math.floor(z)}`
  return {
    set(x, y, z, name) { cells.set(key(x, y, z), name) },
    get(x, y, z) { return cells.get(key(x, y, z)) },
    blockAt(p) {
      const fx = Math.floor(p.x)
      const fy = Math.floor(p.y)
      const fz = Math.floor(p.z)
      const k = key(fx, fy, fz)
      const name = cells.has(k) ? cells.get(k) : (fy <= 63 ? 'dirt' : 'air')
      return { name, boundingBox: name === 'air' ? 'empty' : 'block', position: { x: fx, y: fy, z: fz } }
    },
  }
}

// A standing v2-shaped house: plank wall rings, full plank roof, door,
// table. Only the roof top matters to groundY; the rest is faithful.
function paintHouse(world, ox, oy, oz) {
  for (const dy of [0, 1]) {
    for (const dx of [0, 1, 2, 4, 5, 6]) world.set(ox + dx, oy + dy, oz, 'oak_planks')
    for (let dx = 0; dx <= 6; dx++) world.set(ox + dx, oy + dy, oz + 5, 'oak_planks')
    for (let dz = 1; dz <= 4; dz++) {
      world.set(ox, oy + dy, oz + dz, 'oak_planks')
      world.set(ox + 6, oy + dy, oz + dz, 'oak_planks')
    }
  }
  for (let dz = 0; dz <= 5; dz++) {
    for (let dx = 0; dx <= 6; dx++) world.set(ox + dx, oy + 2, oz + dz, 'oak_planks')
  }
  world.set(ox + 3, oy, oz, 'oak_door')
  world.set(ox + 5, oy, oz + 1, 'crafting_table')
}

function mockBot(world, { at = pos(0, 65, 0) } = {}) {
  const chats = []
  const calls = { goals: [], places: [], digs: [], equips: [] }
  const bot = {
    chats,
    calls,
    spawnPoint: pos(0, 64, 0),
    entity: { position: at },
    world: { getBlock: () => null },
    players: {},
    held: null,
    inventory: { items: () => [] },
    blockAt: (p) => world.blockAt(p),
    findBlocks: () => [],
    pathfinder: {
      isMoving: () => false,
      setGoal: (g) => { calls.goals.push(g) },
    },
    equip: async (item, dest) => { calls.equips.push([item.name, dest]); bot.held = item.name },
    dig: async (b) => {
      calls.digs.push(b.name)
      world.set(b.position.x, b.position.y, b.position.z, 'air')
    },
    placeBlock: async (ref, face) => {
      calls.places.push([ref, face])
      const rp = (ref && ref.position) || ref
      world.set(rp.x + face.x, rp.y + face.y, rp.z + face.z, bot.held)
    },
    chat: (m) => { chats.push(String(m)) },
  }
  return bot
}

function chatBot(world, speaker, botAt) {
  const bot = mockBot(world, { at: botAt })
  bot.players = { Steve: { username: 'Steve', entity: { position: speaker } } }
  const ticker = createTicker({ bot, brain: null, tickMs: 10, idleTickMs: 10 })
  return { bot, ticker }
}

describe('vmzq.14 roofs are not ground', () => {
  it('a roofed first footprint yields to flat ground beside the house', () => {
    const world = makeWorld()
    paintHouse(world, 6, 64, 0) // exactly footprint 1 around the origin
    const bot = mockBot(world)
    const home = goal.siteFor(bot, pos(0, 64, 0))
    assert.deepEqual(home && home.site, { x: 0, y: 64, z: 0 + 6 })
  })

  it('a site fully covered by placed blocks founds nothing', () => {
    const world = makeWorld()
    for (let x = -6; x <= 12; x++) {
      for (let z = -6; z <= 11; z++) world.set(x, 64, z, 'oak_planks')
    }
    // Own-house cells read built too, not just the roof planks.
    world.set(6, 64, 0, 'oak_door')
    world.set(7, 64, 0, 'crafting_table')
    const bot = mockBot(world)
    assert.equal(goal.siteFor(bot, pos(0, 64, 0)), null)
  })

  it("'build here' beside a standing house builds on the ground, not the roof", () => {
    const world = makeWorld()
    paintHouse(world, 6, 64, 0)
    const { bot, ticker } = chatBot(world, pos(0, 64, 0), pos(0, 65, 0))
    handleChat(bot, ticker, 'Steve', 'build here')
    assert.deepEqual(bot.chats, ['building a home at 0 64 6'])
    assert.deepEqual(ticker.home().site, { x: 0, y: 64, z: 6 })
  })
})
