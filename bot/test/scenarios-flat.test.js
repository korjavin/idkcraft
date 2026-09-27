'use strict'

// E2E scenario (idkcraft-w52): a dug-up spawn — crossing trenches, a deep
// pit, a water hole and an unloaded corner — flattened through the full
// ticker path (chat command -> scan -> caps -> done report). The body is
// teleported near each head hole (an arrived walk); the world, inventory
// and chat are real behaviour seams.

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const { createTicker, handleChat } = require('../src/index')

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

function makeWorld() {
  const cells = new Map()
  const key = (x, y, z) => `${Math.floor(x)},${Math.floor(y)},${Math.floor(z)}`
  const bbox = (name) => (name === 'air' || name === 'water' ? 'empty' : 'block')
  // Default terrain: dirt at y<=63, air above. One corner unloaded.
  const unloaded = (x, z) => x <= -3 && z >= 3
  return {
    set(x, y, z, name) { cells.set(key(x, y, z), name) },
    blockAt(p) {
      const fx = Math.floor(p.x)
      const fy = Math.floor(p.y)
      const fz = Math.floor(p.z)
      if (unloaded(fx, fz)) return null
      const k = key(fx, fy, fz)
      const name = cells.has(k) ? cells.get(k) : (fy <= 63 ? 'dirt' : 'air')
      return { name, boundingBox: bbox(name), position: { x: fx, y: fy, z: fz } }
    },
  }
}

function trenchField() {
  const world = makeWorld()
  for (let x = -3; x <= 3; x++) {
    world.set(x, 63, 0, 'air')
    world.set(x, 62, 0, 'air')
  }
  for (let z = -3; z <= 3; z++) {
    world.set(0, 63, z, 'air')
    world.set(0, 62, z, 'air')
  }
  world.set(2, 63, 2, 'air') // deep pit: dug to 60
  world.set(2, 62, 2, 'air')
  world.set(2, 61, 2, 'air')
  world.set(-2, 63, -2, 'air') // water hole: skipped + reported
  world.set(-2, 62, -2, 'water')
  world.set(3, 64, -3, 'dirt') // a bump: out of scope v1
  return world
}

function scenarioBot(world, items) {
  const chats = []
  const bot = {
    username: 'IdkBot',
    chats,
    spawnPoint: pos(0, 64, 0),
    entity: { position: pos(0, 64, -4), onGround: true },
    world: { getBlock: () => null },
    players: { P: { username: 'P', entity: { id: 7, username: 'P', position: pos(0, 64, 0) } } },
    entities: {},
    health: 20,
    food: 20,
    held: null,
    inventory: { items: () => items },
    registry: null,
    blockAt: (p) => world.blockAt(p),
    findBlocks: () => [],
    pathfinder: {
      goal: null,
      setGoal(g) { bot.pathfinder.goal = g },
      stop() {},
      isMoving: () => false,
      setMovements: () => {},
    },
    equip: async (item) => { bot.held = item.name },
    dig: async () => { throw new Error('no digging in this scenario') },
    placeBlock: async (ref, face) => {
      const rp = ref.position
      world.set(rp.x + face.x, rp.y + face.y, rp.z + face.z, bot.held)
      const stack = items.find((i) => i.name === bot.held)
      if (stack && --stack.count <= 0) items.splice(items.indexOf(stack), 1)
    },
    canDigBlock: () => true,
    setControlState: () => {},
    getControlState: () => false,
    clearControlStates: () => {},
    chat: (m) => { chats.push(String(m)) },
  }
  return bot
}

const settle = async (n = 10) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)) }

function capture() {
  const lines = []
  const origLog = console.log
  const origErr = console.error
  console.log = (m) => { lines.push(String(m)) }
  console.error = (m) => { lines.push(String(m)) }
  return { lines, release() { console.log = origLog; console.error = origErr } }
}

describe('w52: trench field -> flat', () => {
  it('caps every trench and the pit at the surface level end to end', async () => {
    const world = trenchField()
    const items = [{ name: 'dirt', count: 64 }]
    const bot = scenarioBot(world, items)
    const brain = { async decide() { return { action: 'roam', sprint: false, source: 'stub' } } }
    const ticker = createTicker({ bot, brain, tickMs: 10, idleTickMs: 10 })
    const cap = capture()
    try {
      handleChat(bot, ticker, 'P', 'flat 4')
      assert.match(bot.chats.at(-1), /scanning 9x9/)
      let sawFlat = false
      for (let i = 0; i < 600 && bot._tickerCtx.flat; i++) {
        const f = bot._tickerCtx.flat
        if (f.phase === 'fill' && f.holes.length > 0) {
          const h = f.holes[0]
          bot.entity.position = pos(h.x + 2, 64, h.z)
        }
        const r = await ticker.tick()
        await settle()
        if (r && r.decision && r.decision.action === 'flat') sawFlat = true
      }
      assert.ok(sawFlat, 'the order owned ticks through the ticker')
      assert.equal(bot._tickerCtx.flat, null, 'episode ends')
      // Every trench cell and the pit read a walkable surface at 63 now.
      for (let x = -3; x <= 3; x++) {
        assert.equal(world.blockAt({ x, y: 63, z: 0 }).name, 'dirt', `trench cap ${x},0`)
      }
      for (let z = -3; z <= 3; z++) {
        assert.equal(world.blockAt({ x: 0, y: 63, z }).name, 'dirt', `trench cap 0,${z}`)
      }
      assert.equal(world.blockAt({ x: 2, y: 63, z: 2 }).name, 'dirt', 'pit capped at the surface')
      // Untouched: the water, the bump, the unloaded corner.
      assert.equal(world.blockAt({ x: -2, y: 62, z: -2 }).name, 'water')
      assert.equal(world.blockAt({ x: 3, y: 64, z: -3 }).name, 'dirt')
      assert.equal(world.blockAt({ x: -4, y: 63, z: 4 }), null)
      const chat = bot.chats.join('\n')
      assert.ok(chat.includes('flattening 9x9 around P, level 63: 14 holes, 4 unloaded, 1 water skipped'), chat)
      assert.ok(chat.includes('flat done: filled 14 holes'), chat)
      assert.ok(!chat.includes('flat 0/14'), 'no 0/N progress right after the start line')
    } finally {
      cap.release()
      ticker.destroy()
    }
  })
})
