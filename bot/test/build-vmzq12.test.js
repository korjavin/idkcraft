'use strict'

// Bead idkcraft-vmzq.12: validated build sites. The prod house (site
// -40 63 -215, window 2026-10-06T16:56:03Z) was founded on a stale
// speaker reading ~150 blocks from the bot, in unloaded chunks; siteFor
// took the unvalidated single-column fallback (no flatness, no water
// check; groundY counted the water surface as ground) and the footprint
// landed over shore dips (no-ref cells) and a mound (buried cells).
// Fix: water is not ground, the fallback relocates to a loaded dry
// footprint or refuses, and 'build here' range-checks the speaker.

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

// Sloped world: ground top h(x) = 63 + floor(x/2), so every 7-wide
// footprint spans >=3 blocks and no candidate reads flat — while every
// column stays loaded and dry (the JR-BUILD slope shape).
function slopeWorld() {
  const cells = new Map()
  const key = (x, y, z) => `${Math.floor(x)},${Math.floor(y)},${Math.floor(z)}`
  return {
    set(x, y, z, name) { cells.set(key(x, y, z), name) },
    blockAt(p) {
      const fx = Math.floor(p.x)
      const fy = Math.floor(p.y)
      const fz = Math.floor(p.z)
      const k = key(fx, fy, fz)
      const top = 63 + Math.floor(fx / 2)
      const name = cells.has(k) ? cells.get(k) : (fy <= top ? 'dirt' : 'air')
      return { name, boundingBox: name === 'air' ? 'empty' : 'block', position: { x: fx, y: fy, z: fz } }
    },
  }
}

function paintWater(world, x0, x1, z0, z1, y = 64) {
  for (let x = x0; x <= x1; x++) {
    for (let z = z0; z <= z1; z++) world.set(x, y, z, 'water')
  }
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

describe('vmzq.12 water is not ground', () => {
  it('one wet column rejects the candidate, the dry neighbour wins', () => {
    const world = makeWorld()
    // (11,64,0) sits in footprint 1 (x 6..12, z 0..5) but in no other
    // first-ring candidate, so only the first candidate reads wet.
    world.set(11, 64, 0, 'water')
    const bot = mockBot(world)
    const home = goal.siteFor(bot, pos(0, 64, 0))
    assert.deepEqual(home && home.site, { x: 4, y: 64, z: 4 })
  })

  it('an all-water bay founds nothing', () => {
    const world = makeWorld()
    paintWater(world, -6, 12, -6, 11) // every footprint around the origin
    const bot = mockBot(world)
    assert.equal(goal.siteFor(bot, pos(0, 64, 0)), null)
  })
})

describe('vmzq.12 siteFor never founds blind', () => {
  it('unloaded chunks found nothing, no single-column fallback', () => {
    const bot = { blockAt: () => null, spawnPoint: pos(0, 64, 0) }
    assert.equal(goal.siteFor(bot, pos(0, 64, 0)), null)
  })

  it('a loaded dry slope still founds at the corner column (earthworks)', () => {
    // Preservation pin: loaded-but-uneven ground keeps the old fallback
    // (cut/fill builds it — the JR-BUILD slope rig shape).
    const bot = mockBot(slopeWorld())
    const home = goal.siteFor(bot, pos(0, 64, 0))
    assert.deepEqual(home && home.site, { x: 6, y: 67, z: 0 })
  })

  it('relocate: a wet first footprint yields to a dry uneven one', () => {
    const world = slopeWorld()
    // Above the local ground top (68) at (11,0): in footprint 1 only.
    world.set(11, 69, 0, 'water')
    const bot = mockBot(world)
    const home = goal.siteFor(bot, pos(0, 64, 0))
    assert.deepEqual(home && home.site, { x: 4, y: 66, z: 4 })
  })
})

describe("vmzq.12 'build here' validates the speaker and the ground", () => {
  it('a far speaker is last-known: refuse like unseen, keep follow', () => {
    const { bot, ticker } = chatBot(makeWorld(), pos(100, 64, 100), pos(0, 65, 0))
    ticker.setFollow('Steve')
    handleChat(bot, ticker, 'Steve', 'build here')
    assert.deepEqual(bot.chats, ["I can't see you, come closer"])
    assert.equal(ticker.home(), null)
    assert.equal(ticker.getFollowName(), 'Steve')
  })

  it('a near speaker on unloaded ground waits for chunks', () => {
    const world = { blockAt: () => null }
    const { bot, ticker } = chatBot(world, pos(10, 64, 0), pos(0, 65, 0))
    handleChat(bot, ticker, 'Steve', 'build here')
    assert.deepEqual(bot.chats, ["I can't see the ground there yet — say build here again in a moment"])
    assert.equal(ticker.home(), null)
  })

  it('a near speaker over water gets the dry-ground refusal', () => {
    const world = makeWorld()
    paintWater(world, 4, 22, -6, 11) // every footprint around (10,64,0)
    const { bot, ticker } = chatBot(world, pos(10, 64, 0), pos(0, 65, 0))
    handleChat(bot, ticker, 'Steve', 'build here')
    assert.deepEqual(bot.chats, ['no dry ground near you — try another spot'])
    assert.equal(ticker.home(), null)
  })

  it('a near speaker on flat ground still builds (preservation)', () => {
    const { bot, ticker } = chatBot(makeWorld(), pos(10, 64, 0), pos(0, 65, 0))
    handleChat(bot, ticker, 'Steve', 'build here')
    assert.deepEqual(bot.chats, ['building a home at 16 64 0'])
    assert.deepEqual(ticker.home().site, { x: 16, y: 64, z: 0 })
  })
})
