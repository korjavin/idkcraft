'use strict'

// pillar_up places the block it stands on (idkcraft-17b): prod 2026-09-27
// chose pillar_up 67 times and failed all 67 with failed:place-error — the
// primitive never equipped a scaffold block, so mineflayer threw 'must be
// holding an item to place' (empty hand) or the server refused (tool/food in
// hand). The mocks below pin the real client's hand rule: placeBlock
// rejects unless the hand holds dirt/cobblestone.

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const { Vec3 } = require('vec3')
const recover = require('../src/behaviours/recover')
const { createTicker } = require('../src/index')

function pos(x, y, z) {
  return {
    x, y, z,
    distanceTo: (q) => Math.hypot(x - q.x, y - q.y, z - q.z),
    clone() { return pos(x, y, z) },
  }
}

function key(x, y, z) { return `${x},${y},${z}` }

// 1x1 shaft like the logged ravine spot: solid floor at y=60, air inside,
// goal above the mouth.
function pitWorld() {
  const solids = new Set()
  for (let x = -2; x <= 2; x++) {
    for (let z = -2; z <= 2; z++) solids.add(key(x, 60, z))
  }
  for (let y = 61; y <= 66; y++) {
    solids.add(key(1, y, 0)); solids.add(key(-1, y, 0))
    solids.add(key(0, y, 1)); solids.add(key(0, y, -1))
  }
  solids.delete(key(0, 61, 0)); solids.delete(key(0, 62, 0)); solids.delete(key(0, 63, 0))
  return solids
}

// Mock bot with the real client's hand rule: placeBlock throws 'must be
// holding an item to place' on an empty hand (mineflayer _genericPlace) and
// 'Server refused ...' when the hand holds no placeable block. opts:
// held = starting heldItem, refusePlace = server refuses every placement.
function strictBot(solids, items, opts) {
  const o = opts || {}
  const bot = {
    username: 'IdkBot',
    players: {},
    entities: {},
    health: 20,
    food: 20,
    entity: { position: pos(0.5, 61, 0.5), onGround: true },
    inventory: { items: () => items },
    heldItem: o.held || null,
    controls: {},
    setControlState(c, v) { this.controls[c] = !!v },
    getControlState(c) { return !!this.controls[c] },
    clearControlStates() { this.controls = {} },
    blockAt(p) {
      const k = key(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z))
      const solidCell = solids.has(k)
      return { name: solidCell ? 'dirt' : 'air', position: new Vec3(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)), boundingBox: solidCell ? 'block' : 'empty' }
    },
    async equip(item, dest) {
      bot._equips.push([item && item.name, dest])
      bot.heldItem = item
    },
    async placeBlock(ref, face) {
      bot._places++
      const h = bot.heldItem
      if (!h) throw new Error('must be holding an item to place')
      if (h.name !== 'dirt' && h.name !== 'cobblestone') {
        throw new Error(`Server refused to place ${h.name}: not a placeable block`)
      }
      if (o.refusePlace) throw new Error('Server refused to place dirt at (0, 61, 0): the block is still air')
      const d = ref.position.plus(face)
      solids.add(key(d.x, d.y, d.z))
      if (typeof h.count === 'number') h.count--
    },
    async dig(block) {
      await Promise.resolve()
      solids.delete(key(block.position.x, block.position.y, block.position.z))
    },
    pathfinder: {
      goal: null,
      setGoal(g) { this.goal = g },
      stop() {},
      isMoving: () => false,
    },
    chats: [],
    chat(m) { this.chats.push(String(m)) },
    _places: 0,
    _equips: [],
  }
  return bot
}

function pillarCtx(extraSt) {
  return {
    stuck: { by: 'follow', goal: { x: 0, y: 64, z: 0 } },
    recovery: {
      action: 'pillar_up', source: 'stub', model: null, status: 'running',
      st: Object.assign({ phase: 'place', startFloor: 61, waited: 0, placeInFlight: false, placed: false, placeError: false }, extraSt || {}),
    },
  }
}

async function flush() {
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r))
}

function captureLog() {
  const lines = []
  const orig = console.log
  console.log = (l) => { lines.push(String(l)) }
  return { lines, done() { console.log = orig } }
}

describe('pillar_up equips scaffold (idkcraft-17b)', () => {
  it('empty hand + dirt in inventory: equips dirt and places', async () => {
    // Pre-fix this fails: no equip call, place throws, failed:place-error.
    const bot = strictBot(pitWorld(), [{ name: 'dirt', count: 10 }])
    bot.entity.position = pos(0.5, 62, 0.5) // apex for startFloor 61
    const ctx = pillarCtx()
    recover.run(bot, ctx)
    assert.equal(ctx.recovery.status, 'running')
    await flush()
    recover.run(bot, ctx)
    assert.deepEqual(bot._equips, [['dirt', 'hand']])
    assert.equal(bot._places, 1)
    assert.equal(ctx.recovery.status, 'done')
  })

  it('held tool: equips dirt over the pickaxe, never places the tool', async () => {
    const pick = { name: 'iron_pickaxe', count: 1 }
    const dirt = { name: 'dirt', count: 10 }
    const bot = strictBot(pitWorld(), [pick, dirt], { held: pick })
    bot.entity.position = pos(0.5, 62, 0.5)
    const ctx = pillarCtx()
    recover.run(bot, ctx)
    await flush()
    recover.run(bot, ctx)
    assert.deepEqual(bot._equips, [['dirt', 'hand']])
    assert.equal(bot.heldItem, dirt)
    assert.equal(ctx.recovery.status, 'done')
  })

  it('no scaffold: honest failed:no-scaffold without a place attempt', () => {
    const bot = strictBot(pitWorld(), [{ name: 'iron_pickaxe', count: 1 }])
    bot.entity.position = pos(0.5, 62, 0.5)
    const ctx = pillarCtx()
    recover.run(bot, ctx)
    assert.equal(ctx.recovery.status, 'failed:no-scaffold')
    assert.equal(bot._places, 0)
    assert.deepEqual(bot._equips, [])
  })

  it('place error reason reaches the log line, outcome stays failed:place-error', async () => {
    const bot = strictBot(pitWorld(), [{ name: 'dirt', count: 10 }], { refusePlace: true })
    bot.entity.position = pos(0.5, 62, 0.5)
    const ctx = pillarCtx()
    const cap = captureLog()
    try {
      recover.run(bot, ctx)
      await flush()
      recover.run(bot, ctx)
      assert.equal(ctx.recovery.status, 'failed:place-error')
      await recover.decide(bot, ctx, {}, null)
    } finally {
      cap.done()
    }
    const line = cap.lines.find((l) => l.includes('recover action=pillar_up') && l.includes('outcome=failed:place-error'))
    assert.ok(line, `place-error logged, got: ${cap.lines.join(' | ')}`)
    assert.ok(line.includes('err=Server_refused_to_place_dirt'), `reason attached, got: ${line}`)
  })
})

describe('pillar_up issues only while rising (idkcraft-17b)', () => {
  it('falling sample at apex: no placement this tick', () => {
    // 1 Hz ticks sample the 0.6 s jump at a random phase: issuing while
    // already falling lets the server apply the placement after the feet
    // are back in the cell, which it refuses as self-intersection.
    const bot = strictBot(pitWorld(), [{ name: 'dirt', count: 10 }])
    bot.entity.position = pos(0.5, 62.05, 0.5)
    bot.entity.velocity = { x: 0, y: -0.3, z: 0 }
    const ctx = pillarCtx({ phase: 'jump' })
    recover.run(bot, ctx)
    assert.equal(bot._places, 0)
    assert.equal(ctx.recovery.status, 'running')
    assert.equal(ctx.recovery.st.phase, 'jump')
    assert.equal(bot.getControlState('jump'), true)
  })

  it('rising sample at apex: issues the placement', async () => {
    const bot = strictBot(pitWorld(), [{ name: 'dirt', count: 10 }])
    bot.entity.position = pos(0.5, 62.05, 0.5)
    bot.entity.velocity = { x: 0, y: 0.3, z: 0 }
    const ctx = pillarCtx({ phase: 'jump' })
    recover.run(bot, ctx)
    await flush() // equip runs first, the place lands a microtask later
    assert.equal(bot._places, 1)
  })

  it('missing velocity reads as rising (lenient mocks keep working)', async () => {
    const bot = strictBot(pitWorld(), [{ name: 'dirt', count: 10 }])
    bot.entity.position = pos(0.5, 62.05, 0.5)
    assert.equal(bot.entity.velocity, undefined)
    const ctx = pillarCtx({ phase: 'jump' })
    recover.run(bot, ctx)
    await flush() // equip runs first, the place lands a microtask later
    assert.equal(bot._places, 1)
  })
})

describe('pillar_up ravine climb e2e (idkcraft-17b)', () => {
  it('ticker climbs out of the logged pit with a strict hand', async () => {
    // Logged geometry: stuck in a pit at y≈52-54, goal high, scaffold on
    // hand, empty hand. Pre-fix the climb never starts (every pillar_up
    // fails place-error); post-fix the bot pillars out.
    const bot = strictBot(pitWorld(), [{ name: 'dirt', count: 10 }])
    bot.players = { Steve: { username: 'Steve', entity: { id: 7, position: pos(50, 64, 0) } } }
    const brain = { source: 'stub', ask: async () => 'pillar_up' }
    const ticker = createTicker({ bot, brain, tickMs: 10, idleTickMs: 10 })
    bot._tickerCtx.stuck = { by: 'follow', goal: { x: 0, y: 64, z: 0 } }
    let ticks = 0
    for (; ticks < 80 && Math.floor(bot.entity.position.y) < 64; ticks++) {
      await ticker.tick()
      await flush()
      // Harness physics: jump lifts, gravity settles onto solid ground.
      if (bot.getControlState('jump')) bot.entity.position.y += 0.5
      const below = bot.blockAt({ x: bot.entity.position.x, y: bot.entity.position.y - 0.1, z: bot.entity.position.z })
      if ((!below || below.boundingBox === 'empty') && !bot.getControlState('jump')) {
        bot.entity.position.y = Math.max(60.5, bot.entity.position.y - 0.5)
      }
    }
    assert.equal(Math.floor(bot.entity.position.y), 64, `pillared out in ${ticks} ticks`)
    assert.ok(bot._equips.length >= 1, 'equipped scaffold at least once')
    // The loop exits mid-jump at mouth height, so the third cycle's
    // placement is still queued: two landed blocks prove the climb.
    assert.ok(bot._places >= 2, `placed ${bot._places} pillar blocks`)
  })
})
