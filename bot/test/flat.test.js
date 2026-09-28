'use strict'

// Bead w52: `flat` fills holes and trenches below the surface level.
// Unit tests for the hole detection + level choice + cap planning on
// synthetic grids, plus chat/ticker wiring and behaviour ticks against a
// scripted voxel world. The trench-field end-to-end run lives in
// scenarios-flat.test.js.

const { describe, it, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const { createTicker, handleChat, BEHAVIOURS } = require('../src/index')
const flat = require('../src/behaviours/flat')
const util = require('../src/behaviours/util')
const {
  probeColumn, spiralColumns, chooseLevel, detectHoles,
  isFillBlock, findFillItem, countFill, cellOccupied, parseRadius, startEpisode, progressChat, buildSweep,
  restockPoint, guardFlatSurface,
  FLAT_DEFAULT_RADIUS, FLAT_MIN_RADIUS, FLAT_MAX_RADIUS,
} = flat

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

// Fake voxel world: explicit cells plus default terrain (dirt at y<=surface,
// air above). placeBlock/dig mutate it, so a test can watch holes close.
// unloaded(x, z) marks whole columns unreadable (blockAt null).
function makeWorld({ surface = 63, unloaded = null } = {}) {
  const cells = new Map()
  const key = (x, y, z) => `${Math.floor(x)},${Math.floor(y)},${Math.floor(z)}`
  const bbox = (name) => (name === 'air' || name === 'cave_air' || name === 'void_air' ||
    name === 'water' || name === 'lava' || name === 'bubble_column' ? 'empty' : 'block')
  return {
    set(x, y, z, name) { cells.set(key(x, y, z), name) },
    get(x, y, z) { return cells.get(key(x, y, z)) },
    blockAt(p) {
      const fx = Math.floor(p.x)
      const fy = Math.floor(p.y)
      const fz = Math.floor(p.z)
      if (unloaded && unloaded(fx, fz)) return null
      const k = key(fx, fy, fz)
      const name = cells.has(k) ? cells.get(k) : (fy <= surface ? 'dirt' : 'air')
      return { name, boundingBox: bbox(name), position: { x: fx, y: fy, z: fz } }
    },
  }
}

function addItem(items, name, n) {
  const stack = items.find((i) => i.name === name)
  if (stack) stack.count += n
  else items.push({ name, count: n })
}

function consumeItem(items, name) {
  const stack = items.find((i) => i.name === name)
  if (!stack) return
  stack.count--
  if (stack.count <= 0) items.splice(items.indexOf(stack), 1)
}

const DIRT_REGISTRY = {
  blocksByName: { dirt: { id: 1 }, grass_block: { id: 2 }, coarse_dirt: { id: 3 }, stone: { id: 4 } },
}

function mockBot(world, { items = [], feet = pos(0, 64, 0), players = {}, dirtSpots = [], failPlace = false, registry = null, moving = false } = {}) {
  const chats = []
  const calls = { goals: [], places: [], digs: [], equips: [] }
  const bot = {
    username: 'IdkBot',
    chats,
    calls,
    spawnPoint: pos(0, 64, 0),
    entity: { position: feet, onGround: true },
    world: { getBlock: () => null },
    players,
    entities: {},
    health: 20,
    food: 20,
    held: null,
    inventory: { items: () => items },
    registry,
    blockAt: (p) => world.blockAt(p),
    // Dug spots stop matching, like a real findBlocks rescan.
    findBlocks: (opts) => {
      calls.findBlocksOpts = opts
      return dirtSpots.filter((p) => {
        const b = world.blockAt(p)
        return b && (b.name === 'dirt' || b.name === 'grass_block' || b.name === 'coarse_dirt')
      })
    },
    _moving: !!moving,
    pathfinder: {
      goal: null,
      isMoving: () => bot._moving,
      setGoal: (g) => { calls.goals.push(g); bot.pathfinder.goal = g },
      stop: () => {},
      setMovements: () => {},
    },
    equip: async (item, dest) => { calls.equips.push([item.name, dest]); bot.held = item.name },
    dig: async (b) => {
      calls.digs.push(b.name)
      world.set(b.position.x, b.position.y, b.position.z, 'air')
      addItem(items, 'dirt', 1)
    },
    placeBlock: async (ref, face) => {
      calls.places.push([ref, face])
      if (failPlace) throw new Error('refused')
      const rp = ref.position
      world.set(rp.x + face.x, rp.y + face.y, rp.z + face.z, bot.held)
      consumeItem(items, bot.held)
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

function mockBrain(action = 'roam') {
  return { calls: 0, async decide() { this.calls++; return { action, sprint: false, source: 'stub' } } }
}

describe('flat plan: spiralColumns', () => {
  it('covers the whole square center-first in non-decreasing rings', () => {
    const cols = spiralColumns(10, 20, 4)
    assert.equal(cols.length, 81)
    assert.deepEqual(cols[0], { x: 10, z: 20 })
    let prev = 0
    const seen = new Set()
    for (const c of cols) {
      const d = Math.max(Math.abs(c.x - 10), Math.abs(c.z - 20))
      assert.ok(d >= prev, `ring order breaks at ${c.x},${c.z}`)
      prev = d
      seen.add(`${c.x},${c.z}`)
    }
    assert.equal(seen.size, 81)
  })
})

describe('flat plan: chooseLevel', () => {
  it('picks the most common walkable height, not min or max', () => {
    const tops = Array(50).fill(63).concat(Array(3).fill(61), [64, 64])
    assert.equal(chooseLevel(tops), 63)
  })

  it('breaks ties toward the lower level (less filling)', () => {
    assert.equal(chooseLevel([63, 63, 64, 64]), 63)
  })

  it('returns null without voters', () => {
    assert.equal(chooseLevel([]), null)
    assert.equal(chooseLevel(null), null)
  })
})

describe('flat plan: probeColumn', () => {
  function gridAt(world) {
    return (x, y, z) => world.blockAt({ x, y, z })
  }

  it('reads flat ground as ok + walkable', () => {
    const world = makeWorld({ surface: 63 })
    assert.deepEqual(probeColumn(gridAt(world), 0, 0, 74, 4), { status: 'ok', topY: 63, walkable: true })
  })

  it('reads a 2-deep hole', () => {
    const world = makeWorld({ surface: 63 })
    world.set(0, 63, 0, 'air')
    world.set(0, 62, 0, 'air')
    assert.deepEqual(probeColumn(gridAt(world), 0, 0, 74, 4), { status: 'ok', topY: 61, walkable: true })
  })

  it('dives past water to the solid bottom, recording the surface', () => {
    // 7wt: the level decides post-scan whether below-level water caps.
    const world = makeWorld({ surface: 63 })
    world.set(0, 63, 0, 'air')
    world.set(0, 62, 0, 'water')
    const r = probeColumn(gridAt(world), 0, 0, 74, 4)
    assert.deepEqual(r, { status: 'ok', topY: 61, walkable: false, liquidTop: 62 })
  })

  it('reports bottomless water as liquid', () => {
    const world = makeWorld({ surface: 63 })
    world.set(0, 63, 0, 'air')
    for (let y = 50; y <= 62; y++) world.set(0, y, 0, 'water')
    world.set(0, 49, 0, 'dirt') // below yBottom: invisible, stays bottomless
    const r = probeColumn(gridAt(world), 0, 0, 74, 50)
    assert.deepEqual(r, { status: 'liquid', topY: 62 })
  })

  it('reports an unloaded column', () => {
    const world = makeWorld({ surface: 63, unloaded: () => true })
    assert.deepEqual(probeColumn(gridAt(world), 0, 0, 74, 4), { status: 'unloaded' })
  })

  it('climbs a solid ceiling to the true hilltop', () => {
    const world = makeWorld({ surface: 63 })
    for (let y = 64; y <= 78; y++) world.set(0, y, 0, 'dirt')
    const r = probeColumn(gridAt(world), 0, 0, 74, 4)
    assert.deepEqual(r, { status: 'ok', topY: 78, walkable: true })
  })

  it('calls solid past the climb cap a bump', () => {
    const world = makeWorld({ surface: 63 })
    for (let y = 64; y <= 120; y++) world.set(0, y, 0, 'dirt')
    assert.deepEqual(probeColumn(gridAt(world), 0, 0, 74, 4), { status: 'bump' })
  })

  it('marks ground without headroom as not walkable', () => {
    const world = makeWorld({ surface: 63 })
    world.set(0, 74, 0, 'dirt')
    world.set(0, 76, 0, 'dirt') // rock 2 above the pocket floor: no headroom
    const r = probeColumn(gridAt(world), 0, 0, 74, 4)
    assert.deepEqual(r, { status: 'ok', topY: 74, walkable: false })
  })

  it('reads a tree canopy as the surface (bumps stay out of scope)', () => {
    const world = makeWorld({ surface: 63 })
    world.set(0, 64, 0, 'oak_leaves')
    const r = probeColumn(gridAt(world), 0, 0, 74, 4)
    assert.deepEqual(r, { status: 'ok', topY: 64, walkable: true })
  })

  it('reports no ground down to the floor as deep', () => {
    const world = makeWorld({ surface: -10 })
    assert.deepEqual(probeColumn(gridAt(world), 0, 0, 74, 4), { status: 'deep' })
  })
})

describe('flat plan: detectHoles', () => {
  it('takes below-level columns and deep ones, nearest first; bumps ignored', () => {
    const records = [
      { x: 5, z: 0, topY: 62 }, // hole, far
      { x: 1, z: 0, topY: 62 }, // hole, near
      { x: 0, z: 0, topY: 63 }, // at level: fine
      { x: 2, z: 0, topY: 64 }, // bump: out of scope v1
      { x: -1, z: 0, deep: true }, // deep: capped via side refs
    ]
    const holes = detectHoles(records, 63, 0, 0)
    assert.deepEqual(holes.map((h) => [h.x, h.z]), [[-1, 0], [1, 0], [5, 0]])
    assert.equal(holes[0].topY, null)
    assert.equal(holes[1].topY, 62)
  })

  it('returns no holes on flat ground', () => {
    assert.deepEqual(detectHoles([{ x: 0, z: 0, topY: 63 }], 63, 0, 0), [])
  })
})

describe('flat fill material', () => {
  it('allows cheap full blocks, never valuables or gravity blocks', () => {
    for (const n of ['dirt', 'grass_block', 'coarse_dirt', 'cobblestone', 'stone', 'andesite']) {
      assert.equal(isFillBlock(n), true, n)
    }
    for (const n of ['diamond_ore', 'iron_ore', 'coal_ore', 'oak_planks', 'oak_log', 'sand', 'gravel', 'torch', 'water', 'air', null, 42]) {
      assert.equal(isFillBlock(n), false, String(n))
    }
  })

  it('prefers dirt over stone/cobble, ignores valuables', () => {
    const bot = { inventory: { items: () => [{ name: 'cobblestone', count: 9 }, { name: 'diamond_ore', count: 3 }, { name: 'dirt', count: 2 }] } }
    assert.equal(findFillItem(bot).name, 'dirt')
    assert.equal(countFill(bot), 11)
  })

  it('finds nothing without fill blocks or inventory', () => {
    assert.equal(findFillItem({ inventory: { items: () => [{ name: 'diamond_ore', count: 1 }] } }), null)
    assert.equal(findFillItem({ inventory: { items: () => { throw new Error('no inv') } } }), null)
    assert.equal(countFill({}), 0)
  })
})

describe('flat safety: cellOccupied', () => {
  it('covers bot and player feet/head cells only', () => {
    const bot = {
      entity: { position: pos(0, 64, 0) },
      players: { P: { entity: { position: pos(5, 63.2, 0) } } },
    }
    assert.equal(cellOccupied(bot, 0, 64, 0), true) // bot feet
    assert.equal(cellOccupied(bot, 0, 65, 0), true) // bot head
    assert.equal(cellOccupied(bot, 0, 63, 0), false) // under the bot: placeable
    assert.equal(cellOccupied(bot, 5, 63, 0), true) // player feet in a hole
    assert.equal(cellOccupied(bot, 5, 64, 0), true) // player head
    assert.equal(cellOccupied(bot, 6, 63, 0), false)
    assert.equal(cellOccupied({}, 0, 64, 0), false)
  })
})

describe('flat parseRadius', () => {
  it('defaults, clamps to 4..64, rejects garbage', () => {
    assert.equal(parseRadius(undefined), FLAT_DEFAULT_RADIUS)
    assert.equal(parseRadius(''), FLAT_DEFAULT_RADIUS)
    assert.equal(parseRadius('16'), 16)
    assert.equal(parseRadius('200'), FLAT_MAX_RADIUS)
    assert.equal(parseRadius('2'), FLAT_MIN_RADIUS)
    assert.equal(parseRadius('abc'), null)
    assert.equal(parseRadius('16x'), null)
    assert.equal(FLAT_DEFAULT_RADIUS, 8)
  })
})

describe('flat chat command', () => {
  function chatBot() {
    return {
      username: 'IdkBot',
      players: { P: { username: 'P' } },
      chats: [],
      chat(m) { this.chats.push(String(m)) },
    }
  }

  it('routes flat + aliases to setFlat with the parsed radius', () => {
    const seen = []
    const ticker = { setFlat: (arg) => { seen.push(arg); return 'ok' } }
    for (const [msg, want] of [['flat', 8], ['make flat', 8], ['flatten', 8], ['flat 16', 16], ['flatten 10', 10], ['flat 200', 64], ['flat 2', 4]]) {
      const bot = chatBot()
      handleChat(bot, ticker, 'P', msg)
      assert.deepEqual(bot.chats, ['ok'], msg)
    }
    assert.deepEqual(seen.map((s) => s.radius), [8, 8, 8, 16, 10, 64, 4])
    assert.deepEqual(seen.map((s) => s.explicit), [false, false, false, true, true, true, true])
    assert.ok(seen.every((s) => s.by === 'P'))
  })

  it('hints usage on garbage instead of starting', () => {
    const ticker = { setFlat: () => { throw new Error('must not start') } }
    for (const msg of ['flat abc', 'flat 16 x']) {
      const bot = chatBot()
      handleChat(bot, ticker, 'P', msg)
      assert.deepEqual(bot.chats, ['try: flat 16'], msg)
    }
  })
})

describe('flat ticker wiring', () => {
  let cap
  beforeEach(() => { cap = capture() })
  afterEach(() => { cap.release() })

  function rig({ action = 'roam', world = null, items = [{ name: 'dirt', count: 64 }], players = { P: { username: 'P' } } } = {}) {
    const w = world || makeWorld({})
    const bot = mockBot(w, { items, players })
    const brain = mockBrain(action)
    const ticker = createTicker({ bot, brain, tickMs: 10, idleTickMs: 10 })
    return { bot, brain, ticker, ctx: bot._tickerCtx, done: () => ticker.destroy() }
  }

  it('setFlat centers on the speaker and scans on the next tick', async () => {
    const r = rig({ players: { P: { username: 'P', entity: { position: pos(100, 64, 200) } } } })
    try {
      const line = r.ticker.setFlat({ radius: 4, by: 'P' })
      assert.match(line, /scanning 9x9/)
      assert.equal(r.ctx.flat.cx, 100)
      assert.equal(r.ctx.flat.cz, 200)
      assert.equal(r.ctx.flat.r, 4)
      const t = await r.ticker.tick()
      assert.equal(t.decision.action, 'flat')
    } finally { r.done() }
  })

  it('setFlat centers on the bot when the speaker is out of range', async () => {
    const r = rig({})
    try {
      r.ticker.setFlat({ radius: 4, by: 'Ghost' })
      assert.equal(r.ctx.flat.cx, 0)
      assert.equal(r.ctx.flat.cz, 0)
      assert.equal(r.ctx.flat.by, 'Ghost')
    } finally { r.done() }
  })

  it('flat owns the body above work; fight still preempts', async () => {
    const world = makeWorld({})
    world.set(1, 63, 0, 'air')
    const r = rig({ world })
    try {
      r.ticker.work()
      r.ticker.setFlat({ radius: 4, by: 'P' })
      assert.ok(r.ctx.work, 'flat does not cancel work mode')
      const t = await r.ticker.tick()
      assert.equal(t.decision.action, 'flat')

      const rf = rig({ action: 'fight', world: makeWorld({}) })
      try {
        rf.bot.entity.position = pos(0, 64, 0)
        rf.ticker.setFlat({ radius: 4, by: 'P' })
        const f = rf.ctx.flat
        const tf = await rf.ticker.tick()
        assert.equal(tf.decision.action, 'fight')
        assert.equal(f.ticks, 0, 'preempted flat must not advance')
      } finally { rf.done() }
    } finally { r.done() }
  })

  it('stop parks the episode; a second flat resumes it without rescanning', async () => {
    const world = makeWorld({})
    world.set(1, 63, 0, 'air')
    world.set(2, 63, 0, 'air')
    const r = rig({ world })
    try {
      r.ticker.setFlat({ radius: 4, by: 'P' })
      await r.ticker.tick() // scan completes, 2 holes queued
      const f = r.ctx.flat
      assert.equal(f.phase, 'fill')
      assert.equal(f.holes.length, 2)
      r.ticker.stop()
      assert.equal(r.ctx.flat.parked, true, 'stop parks the episode')
      const parked = await r.ticker.tick()
      assert.equal(parked.decision.action, 'idle')
      assert.equal(r.ctx.flat, f, 'stop keeps the episode')
      const line = r.ticker.setFlat({ radius: 4, by: 'P', explicit: true })
      assert.match(line, /resuming flat/)
      assert.equal(r.ctx.flat.parked, false, 'resume unparks')
      assert.equal(r.ctx.flat, f, 'same key resumes the same episode')
      assert.equal(r.ctx.flat.holes.length, 2, 'queue preserved, no rescan')
    } finally { r.done() }
  })

  it('a bare re-flat from inside the running square resumes with progress', async () => {
    // Prod 2026-09-27: the owner retyped flat after stepping aside and the
    // new center wiped the run. Any inside retype now resumes instead.
    const world = makeWorld({})
    world.set(1, 63, 0, 'air')
    world.set(2, 63, 0, 'air')
    const r = rig({ world, players: { P: { username: 'P', entity: { position: pos(2, 64, 0) } } } })
    try {
      r.ticker.setFlat({ radius: 4, by: 'P' })
      await r.ticker.tick() // scan completes, 2 holes queued
      const f = r.ctx.flat
      assert.equal(f.holes.length, 2)
      r.bot.players.P.entity.position = pos(3, 64, 1) // stepped aside, still inside
      const line = r.ticker.setFlat({ radius: parseRadius(undefined), by: 'P' })
      assert.match(line, /resuming flat, 2 holes left/)
      assert.equal(r.ctx.flat, f, 'same episode, no rescan')
      assert.equal(r.ctx.flat.holes.length, 2, 'queue preserved')
      assert.equal(r.ctx.flat.filled, 0)
    } finally { r.done() }
  })

  it('a re-flat from outside the running square rescans', async () => {
    const world = makeWorld({})
    world.set(1, 63, 0, 'air')
    const r = rig({ world, players: { P: { username: 'P', entity: { position: pos(2, 64, 0) } } } })
    try {
      r.ticker.setFlat({ radius: 4, by: 'P' })
      await r.ticker.tick()
      const f = r.ctx.flat
      r.bot.players.P.entity.position = pos(50, 64, 50) // walked to a new area
      const line = r.ticker.setFlat({ radius: parseRadius(undefined), by: 'P' })
      assert.match(line, /scanning/)
      assert.notEqual(r.ctx.flat, f, 'new area, new episode')
      assert.equal(r.ctx.flat.phase, 'scan')
    } finally { r.done() }
  })

  it('an inside re-flat with a different explicit radius rescans', async () => {
    const world = makeWorld({})
    world.set(1, 63, 0, 'air')
    const r = rig({ world, players: { P: { username: 'P', entity: { position: pos(2, 64, 0) } } } })
    try {
      r.ticker.setFlat({ radius: 4, by: 'P' })
      await r.ticker.tick()
      const f = r.ctx.flat
      const line = r.ticker.setFlat({ radius: 8, by: 'P', explicit: true })
      assert.match(line, /scanning/)
      assert.notEqual(r.ctx.flat, f, 'explicit new size, new episode')
    } finally { r.done() }
  })

  it('a re-flat during the scan says still scanning', async () => {
    const r = rig({ players: { P: { username: 'P', entity: { position: pos(2, 64, 0) } } } })
    try {
      r.ticker.setFlat({ radius: 4, by: 'P' })
      assert.equal(r.ctx.flat.phase, 'scan')
      const line = r.ticker.setFlat({ radius: 4, by: 'P', explicit: true })
      assert.match(line, /still scanning 9x9/)
    } finally { r.done() }
  })

  it('a bare flat hints at flat 48; an explicit radius does not', async () => {
    const r = rig({ players: { P: { username: 'P', entity: { position: pos(2, 64, 0) } } } })
    try {
      const bare = r.ticker.setFlat({ radius: parseRadius(undefined), by: 'P' })
      assert.match(bare, /scanning 17x17 for holes/)
      assert.match(bare, /flat 48 for a big field/)
      r.bot.players.P.entity.position = pos(60, 64, 60)
      const sized = r.ticker.setFlat({ radius: 8, by: 'P', explicit: true })
      assert.ok(!sized.includes('big field'), `no hint when sized: ${sized}`)
    } finally { r.done() }
  })

  it('follow me and go work cancel the episode', async () => {
    const r = rig({ players: { P: { username: 'P', entity: { position: pos(2, 64, 0) } } } })
    try {
      r.ticker.setFlat({ radius: 4, by: 'P' })
      assert.ok(r.ctx.flat)
      handleChat(r.bot, r.ticker, 'P', 'follow me')
      assert.equal(r.ctx.flat, null)
      r.ticker.setFlat({ radius: 4, by: 'P' })
      handleChat(r.bot, r.ticker, 'P', 'go work')
      assert.equal(r.ctx.flat, null)
    } finally { r.done() }
  })

  it('a parked job is not resurrected by a later errand', async () => {
    const world = makeWorld({})
    world.set(1, 63, 0, 'air')
    const r = rig({ world })
    const origBring = BEHAVIOURS.bring
    BEHAVIOURS.bring = (bot, ctx) => { ctx.bring = null } // errand ends at once
    try {
      r.ticker.setFlat({ radius: 4, by: 'P' })
      await r.ticker.tick() // scan completes, fill starts
      assert.equal(r.ctx.flat.phase, 'fill')
      r.ticker.stop()
      assert.equal(r.ctx.flat.parked, true)
      assert.equal(r.ticker.setShare({ by: 'P' }), null, 'share order accepted')
      assert.ok(r.ctx.bring)
      const t1 = await r.ticker.tick()
      assert.equal(t1.decision.action, 'bring')
      assert.equal(r.ctx.bring, null, 'errand ended')
      const t2 = await r.ticker.tick()
      assert.notEqual(t2.decision.action, 'flat', 'parked job stays parked')
      assert.equal(r.ctx.flat.parked, true)
      r.ticker.status()
      assert.ok(r.bot.chats.at(-1).startsWith('parked (flat paused)'), r.bot.chats.at(-1))
      r.ticker.setLead({ name: 'coal', pos: { x: 1, y: 63, z: 0 }, by: 'P', lastProgressAt: Date.now() })
      r.ticker.status()
      assert.ok(r.bot.chats.at(-1).startsWith('leading'), r.bot.chats.at(-1))
    } finally { BEHAVIOURS.bring = origBring; r.done() }
  })

  it('a parked job resumes from inside its square with a bare flat', async () => {
    const world = makeWorld({})
    world.set(1, 63, 0, 'air')
    const ent = { position: pos(0, 64, 0) }
    const r = rig({ world, players: { P: { username: 'P', entity: ent } } })
    try {
      r.ticker.setFlat({ radius: 4, by: 'P', explicit: true })
      await r.ticker.tick()
      const f = r.ctx.flat
      r.ticker.stop()
      ent.position = pos(2, 64, 2) // stepped away, still inside the square
      handleChat(r.bot, r.ticker, 'P', 'flat') // bare: reuses the parked radius
      assert.equal(r.ctx.flat, f, 'same episode resumed')
      assert.equal(r.ctx.flat.r, 4, 'parked radius kept')
      assert.equal(r.ctx.flat.parked, false)
      assert.match(r.bot.chats.at(-1), /resuming flat/)
    } finally { r.done() }
  })

  it('an explicit different radius starts over a parked episode', async () => {
    const world = makeWorld({})
    world.set(1, 63, 0, 'air')
    const r = rig({ world, players: { P: { username: 'P', entity: { position: pos(0, 64, 0) } } } })
    try {
      r.ticker.setFlat({ radius: 4, by: 'P', explicit: true })
      await r.ticker.tick()
      const f = r.ctx.flat
      r.ticker.stop()
      r.ticker.setFlat({ radius: 8, by: 'P', explicit: true })
      assert.notEqual(r.ctx.flat, f, 'new area, new episode')
      assert.equal(r.ctx.flat.phase, 'scan')
      assert.equal(r.ctx.flat.r, 8)
    } finally { r.done() }
  })

  it('lead and bring preempt the job tick-by-tick and it resumes', async () => {
    const world = makeWorld({})
    world.set(1, 63, 0, 'air')
    const r = rig({ world })
    const origLead = BEHAVIOURS.lead
    const origBring = BEHAVIOURS.bring
    BEHAVIOURS.lead = () => {}
    BEHAVIOURS.bring = () => {}
    try {
      r.ticker.setFlat({ radius: 4, by: 'P' })
      const t0 = await r.ticker.tick()
      assert.equal(t0.decision.action, 'flat')
      const f = r.ctx.flat
      r.ticker.setLead({ name: 'coal', pos: { x: 1, y: 63, z: 0 }, by: 'P', lastProgressAt: Date.now() })
      const t1 = await r.ticker.tick()
      assert.equal(t1.decision.action, 'lead')
      assert.equal(r.ctx.flat, f, 'lead preempts, flat survives')
      r.ticker.clearLead()
      assert.equal(r.ticker.setShare({ by: 'P' }), null)
      const t2 = await r.ticker.tick()
      assert.equal(t2.decision.action, 'bring')
      assert.equal(r.ctx.flat, f, 'bring preempts, flat survives')
      r.ctx.bring = null // errand ends
      const t3 = await r.ticker.tick()
      assert.equal(t3.decision.action, 'flat', 'job resumes after the errands')
    } finally { BEHAVIOURS.lead = origLead; BEHAVIOURS.bring = origBring; r.done() }
  })

  it('status names the job, including the parked episode', async () => {
    const r = rig({})
    try {
      r.ticker.setFlat({ radius: 4, by: 'P' })
      r.ticker.status()
      assert.ok(r.bot.chats.at(-1).startsWith('flattening'), r.bot.chats.at(-1))
      r.ticker.stop()
      r.ticker.status()
      assert.ok(r.bot.chats.at(-1).startsWith('parked (flat paused)'), r.bot.chats.at(-1))
    } finally { r.done() }
  })
})

describe('flat progress chat', () => {
  function progBot() {
    return { chats: [], chat(m) { this.chats.push(String(m)) } }
  }
  function progFlat(over = {}) {
    return Object.assign({
      phase: 'fill', filled: 0, shaved: 0, total: 20, totalBumps: 0, level: 63,
      skip: { water: 0, lava: 0, occupied: 0, unreachable: 0, floating: 0, refused: 0, kept: 0 },
      lastChat: 0, progressChats: 0,
    }, over)
  }

  it('first progress comes within 25 s of silence', () => {
    const bot = progBot()
    progressChat(bot, progFlat({ lastChat: Date.now() - 26000 }))
    assert.deepEqual(bot.chats, ['flat 0/20 (level 63)'])
  })

  it('stays silent 10 s in with no resolutions', () => {
    const bot = progBot()
    progressChat(bot, progFlat({ lastChat: Date.now() - 10000 }))
    assert.deepEqual(bot.chats, [])
  })

  it('first progress fires after 10 resolutions even when fresh', () => {
    const bot = progBot()
    progressChat(bot, progFlat({ lastChat: Date.now() - 10000, filled: 10 }))
    assert.deepEqual(bot.chats, ['flat 10/20 (level 63)'])
  })

  it('later progress keeps the 120 s cadence', () => {
    const bot = progBot()
    progressChat(bot, progFlat({ lastChat: Date.now() - 60000, progressChats: 1, filled: 5 }))
    assert.deepEqual(bot.chats, [])
    progressChat(bot, progFlat({ lastChat: Date.now() - 121000, progressChats: 1, filled: 5 }))
    assert.deepEqual(bot.chats, ['flat 5/20 (level 63)'])
  })

  it('second immediate call on the same episode stays silent', () => {
    // Revmux 01 core-1: without the progressChats increment a resolved
    // field would chat every tick; the second call must post nothing.
    const bot = progBot()
    const f = progFlat({ lastChat: Date.now() - 10000, filled: 10 })
    progressChat(bot, f)
    assert.equal(bot.chats.length, 1)
    progressChat(bot, f)
    assert.equal(bot.chats.length, 1, 'no chat spam after the first line')
  })
})

describe('flat behaviour', () => {
  let cap
  beforeEach(() => { cap = capture() })
  afterEach(() => { cap.release() })

  // Drive flat() ticks with a teleported body: the mock pathfinder never
  // moves, so each fill tick starts within reach of the head hole (like an
  // arrived walk), without standing in the cap cell.
  async function drive(bot, ctx, n) {
    for (let i = 0; i < n && ctx.flat; i++) {
      const f = ctx.flat
      if (f.phase === 'fill' && f.holes.length > 0) {
        const h = f.holes[0]
        bot.entity.position = pos(h.x + 2, 64, h.z)
      } else if (f.phase === 'shave' && f.bumps.length > 0) {
        const h = f.bumps[0]
        bot.entity.position = pos(h.x + 2, h.y, h.z)
      }
      flat(bot, ctx, null, null)
      await settle()
    }
  }

  function started(world, botOpts = {}) {
    const bot = mockBot(world, { items: [{ name: 'dirt', count: 64 }], ...botOpts })
    const ctx = { lastGoalKey: '', flat: startEpisode(0, 0, 4, 74, 'P') }
    return { bot, ctx }
  }

  it('fills a 1-deep hole, then shaves the bump (v2), reports done', async () => {
    const world = makeWorld({})
    world.set(1, 63, 0, 'air') // the hole
    world.set(2, 64, 0, 'dirt') // a bump: shaved since v2 (w52.1)
    const { bot, ctx } = started(world)
    await drive(bot, ctx, 20)
    assert.equal(ctx.flat, null, 'episode ends')
    assert.equal(world.blockAt({ x: 1, y: 63, z: 0 }).name, 'dirt')
    assert.equal(world.blockAt({ x: 2, y: 64, z: 0 }).name, 'air', 'bump shaved')
    assert.equal(bot.calls.places.length, 1)
    assert.ok(bot.chats.some((c) => c.includes('flattening 9x9 around P, level 63: 1 holes, 1 bumps')), bot.chats.join('\n'))
    assert.ok(bot.chats.some((c) => c === 'flat done: filled 1 hole, shaved 1 bump'), bot.chats.join('\n'))
  })

  it('caps a ditch with below-level water, water stays', async () => {
    // 7wt: liquid strictly below the level is an ordinary hole; the cap
    // lands over the water without draining it.
    const world = makeWorld({})
    world.set(1, 63, 0, 'air')
    world.set(1, 62, 0, 'water')
    world.set(1, 61, 0, 'dirt')
    const { bot, ctx } = started(world)
    await drive(bot, ctx, 10)
    assert.equal(ctx.flat, null)
    assert.equal(world.blockAt({ x: 1, y: 63, z: 0 }).name, 'dirt', 'capped at level')
    assert.equal(world.blockAt({ x: 1, y: 62, z: 0 }).name, 'water', 'water untouched')
    assert.ok(!bot.chats.some((c) => c.includes('water skipped')), bot.chats.join('\n'))
    assert.ok(bot.chats.some((c) => c === 'flat done: filled 1 hole'), bot.chats.join('\n'))
  })

  it('caps over below-level lava the same way', async () => {
    const world = makeWorld({})
    world.set(1, 63, 0, 'air')
    world.set(1, 62, 0, 'lava')
    world.set(1, 61, 0, 'dirt')
    const { bot, ctx } = started(world)
    await drive(bot, ctx, 10)
    assert.equal(ctx.flat, null)
    assert.equal(world.blockAt({ x: 1, y: 63, z: 0 }).name, 'dirt', 'capped at level')
    assert.equal(world.blockAt({ x: 1, y: 62, z: 0 }).name, 'lava', 'lava covered, not drained')
    assert.ok(bot.chats.some((c) => c === 'flat done: filled 1 hole'), bot.chats.join('\n'))
  })

  it('still skips a water surface at the level', async () => {
    // Boundary pin: liquid AT the level is a pond, never capped.
    const world = makeWorld({})
    world.set(1, 63, 0, 'water')
    world.set(1, 62, 0, 'dirt')
    const { bot, ctx } = started(world)
    await drive(bot, ctx, 10)
    assert.equal(ctx.flat, null)
    assert.equal(world.blockAt({ x: 1, y: 63, z: 0 }).name, 'water', 'surface untouched')
    assert.equal(bot.calls.places.length, 0)
    assert.ok(bot.chats.some((c) => c.includes('1 water skipped')), bot.chats.join('\n'))
    assert.ok(bot.chats.some((c) => c === 'flat done: filled 0 holes'), bot.chats.join('\n'))
  })

  it('supports a stepped shaft, then caps it', async () => {
    const world = makeWorld({})
    world.set(0, 63, 0, 'air')
    world.set(0, 62, 0, 'air') // center dug to 61...
    for (const [x, z] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) world.set(x, 63, z, 'air') // ...ring to 62
    const { bot, ctx } = started(world)
    await drive(bot, ctx, 40)
    assert.equal(ctx.flat, null)
    assert.equal(world.blockAt({ x: 0, y: 62, z: 0 }).name, 'dirt', 'support below the cap')
    assert.equal(world.blockAt({ x: 0, y: 63, z: 0 }).name, 'dirt', 'cap on the support')
    assert.ok(cap.lines.some((l) => l.includes('supports=1')), cap.lines.join('\n'))
    assert.ok(bot.chats.some((c) => c === 'flat done: filled 5 holes'), bot.chats.join('\n'))
  })

  it('closes a wide 2-deep pit ring by ring through deferral passes', async () => {
    const world = makeWorld({})
    for (let x = -1; x <= 1; x++) {
      for (let z = -1; z <= 1; z++) {
        world.set(x, 63, z, 'air')
        world.set(x, 62, z, 'air')
      }
    }
    const { bot, ctx } = started(world)
    await drive(bot, ctx, 120)
    assert.equal(ctx.flat, null)
    for (let x = -1; x <= 1; x++) {
      for (let z = -1; z <= 1; z++) {
        assert.equal(world.blockAt({ x, y: 63, z }).name, 'dirt', `cap at ${x},${z}`)
      }
    }
    assert.ok(bot.chats.some((c) => c === 'flat done: filled 9 holes'), bot.chats.join('\n'))
  })

  it('skips a hole camped by a player and reports it', async () => {
    const world = makeWorld({})
    world.set(1, 63, 0, 'air')
    const players = { Q: { username: 'Q', entity: { position: pos(1, 62.5, 0) } } }
    const { bot, ctx } = started(world, { players })
    await drive(bot, ctx, 20)
    assert.equal(ctx.flat, null)
    assert.equal(world.blockAt({ x: 1, y: 63, z: 0 }).name, 'air', 'never placed into the player')
    assert.ok(bot.chats.some((c) => c.includes('skipped 1: 1 occupied')), bot.chats.join('\n'))
  })

  it('steps aside when standing in its own cap cell, skips when wedged', async () => {
    const world = makeWorld({})
    world.set(0, 63, 0, 'air')
    const bot = mockBot(world, { items: [{ name: 'dirt', count: 64 }], feet: pos(0, 63.5, 0) })
    const ctx = { lastGoalKey: '', flat: startEpisode(0, 0, 4, 74, 'P') }
    // No teleport: the body stands in the hole like after a trench park.
    for (let i = 0; i < 20 && ctx.flat; i++) { flat(bot, ctx, null, null); await settle() }
    assert.equal(ctx.flat, null)
    assert.ok(bot.calls.goals.length >= 1, 'a sidestep goal was issued')
    assert.equal(world.blockAt({ x: 0, y: 63, z: 0 }).name, 'air', 'never placed into itself')
    assert.ok(bot.chats.some((c) => c.includes('skipped 1: 1 occupied')), bot.chats.join('\n'))
  })

  it('skips an unreachable hole after walk stalls with no displacement', async () => {
    const world = makeWorld({})
    world.set(1, 63, 0, 'air')
    const bot = mockBot(world, { items: [{ name: 'dirt', count: 64 }], moving: true })
    const ctx = { lastGoalKey: '', flat: startEpisode(0, 0, 4, 74, 'P') }
    // Executor drives, body stands still: no teleport, no progress.
    for (let i = 0; i < 120 && ctx.flat; i++) { flat(bot, ctx, null, null); await settle() }
    assert.equal(ctx.flat, null)
    assert.ok(bot.chats.some((c) => c.includes('skipped 1: 1 unreachable')), bot.chats.join('\n'))
  })

  it('skips a hole the body can never get near', async () => {
    const world = makeWorld({})
    world.set(4, 63, 4, 'air') // 5.7 blocks from spawn: past eye reach
    const bot = mockBot(world, { items: [{ name: 'dirt', count: 64 }] })
    const ctx = { lastGoalKey: '', flat: startEpisode(0, 0, 4, 74, 'P') }
    for (let i = 0; i < 30 && ctx.flat; i++) { flat(bot, ctx, null, null); await settle() }
    assert.equal(ctx.flat, null)
    assert.ok(bot.chats.some((c) => c.includes('skipped 1: 1 unreachable')), bot.chats.join('\n'))
  })

  it('keeps the stall budget when retaking a hole after a stolen tick', async () => {
    const world = makeWorld({})
    world.set(1, 63, 0, 'air')
    const { bot, ctx } = started(world)
    flat(bot, ctx, null, null); await settle() // scan
    const f = ctx.flat
    bot.entity.position = pos(3, 64, 0)
    flat(bot, ctx, null, null); await settle() // issue
    const h = f.holes[0]
    h.stalls = 4
    h.lastPos = { x: 9, y: 64, z: 9 }
    ctx.lastGoalKey = 'fight:1' // a fight tick stole the body
    const goalsBefore = bot.calls.goals.length
    flat(bot, ctx, null, null); await settle() // re-issue, keep budget
    assert.equal(bot.calls.goals.length, goalsBefore + 1, 'goal re-issued')
    assert.equal(h.stalls, 4, 'stalls preserved')
    assert.deepEqual(h.lastPos, { x: 9, y: 64, z: 9 }, 'lastPos preserved')
    assert.equal(f.issuedKey, 'flat:1,63,0')
    assert.equal(f.holes.length, 1, 'no same-tick place after a re-issue (body-2)')
  })

  it('gives up restocking after three stalled dirt walks', async () => {
    const world = makeWorld({})
    world.set(1, 63, 0, 'air')
    const bot = mockBot(world, {
      items: [],
      registry: DIRT_REGISTRY,
      dirtSpots: [{ x: 20, y: 63, z: 0 }, { x: 21, y: 63, z: 0 }, { x: 22, y: 63, z: 0 }],
    })
    const ctx = { lastGoalKey: '', flat: startEpisode(0, 0, 4, 74, 'P') }
    flat(bot, ctx, null, null); await settle() // scan
    flat(bot, ctx, null, null); await settle() // fill: issue
    bot.entity.position = pos(3, 64, 0)
    flat(bot, ctx, null, null); await settle() // arrived, no item -> dig
    assert.equal(ctx.flat.phase, 'dig')
    bot._moving = true // dirt walks stall from here
    for (let i = 0; i < 120 && ctx.flat; i++) { flat(bot, ctx, null, null); await settle() }
    assert.equal(ctx.flat, null)
    assert.ok(bot.chats.some((c) => c.includes('1 left (no fill blocks)')), bot.chats.join('\n'))
  })

  it('searches restock dirt from outside the square', async () => {
    const world = makeWorld({})
    world.set(1, 63, 0, 'air')
    const bot = mockBot(world, {
      items: [],
      registry: DIRT_REGISTRY,
      dirtSpots: [{ x: 2, y: 63, z: 0 }, { x: 20, y: 63, z: 0 }],
    })
    const ctx = { lastGoalKey: '', flat: startEpisode(0, 0, 4, 74, 'P') }
    flat(bot, ctx, null, null); await settle() // scan
    flat(bot, ctx, null, null); await settle() // fill: issue
    bot.entity.position = pos(3, 64, 0)
    flat(bot, ctx, null, null); await settle() // arrived -> dig
    flat(bot, ctx, null, null); await settle() // dig: find + issue
    assert.deepEqual([ctx.flat.dig.pos.x, ctx.flat.dig.pos.z], [20, 0], 'inside dirt filtered out')
    const pt = bot.calls.findBlocksOpts && bot.calls.findBlocksOpts.point
    assert.ok(pt && (Math.abs(pt.x) > 4 || Math.abs(pt.z) > 4), `search origin outside the square: ${pt && `${pt.x},${pt.z}`}`)
  })

  it('restock skips a below-feet dirt in a pit instead of deepening it (drq selftrap)', async () => {
    const world = makeWorld({})
    for (const [x, z] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) world.set(x, 64, z, 'dirt')
    const bot = mockBot(world, { items: [], feet: pos(0, 64, 0) })
    const ctx = { lastGoalKey: 'flat-dig:0,63,0', flat: startEpisode(0, 0, 4, 74, 'P') }
    const f = ctx.flat
    f.phase = 'dig'
    f.ticks = 0
    // A stale selection from before the bot slid into the pit: the
    // dig-site check re-verifies at the dig moment (findDirt filtered
    // it, the bot moved since).
    f.dig = { pos: pos(0, 63, 0), phase: 'walk', skip: new Set(), streak: 0, ticks: 0, stalls: 0, lastPos: { x: 0, y: 64, z: 0 } }
    flat(bot, ctx, null, null); await settle()
    assert.deepEqual(bot.calls.digs, [], 'pit floor never dug')
    assert.equal(ctx.flat.dig.pos, null, 'target dropped')
    assert.equal(ctx.flat.dig.skip.size, 1, 'target skipped, restock searches on')
  })

  it('restock digs at least RESTOCK_MIN_EDGE_GAP past the edge', async () => {
    const world = makeWorld({})
    world.set(1, 63, 0, 'air')
    const bot = mockBot(world, {
      items: [],
      registry: DIRT_REGISTRY,
      dirtSpots: [{ x: 10, y: 63, z: 0 }, { x: 20, y: 63, z: 0 }], // gap 6 (near, rejected) vs gap 16
    })
    const ctx = { lastGoalKey: '', flat: startEpisode(0, 0, 4, 74, 'P') }
    flat(bot, ctx, null, null); await settle() // scan
    flat(bot, ctx, null, null); await settle() // fill: issue
    bot.entity.position = pos(3, 64, 0)
    flat(bot, ctx, null, null); await settle() // arrived -> dig
    flat(bot, ctx, null, null); await settle() // dig: find + issue
    assert.deepEqual([ctx.flat.dig.pos.x, ctx.flat.dig.pos.z], [20, 0], 'near-edge dirt filtered out')
    const pt = bot.calls.findBlocksOpts && bot.calls.findBlocksOpts.point
    const gap = Math.max(Math.abs(pt.x), Math.abs(pt.z)) - 4
    assert.ok(gap >= 16, `search origin in the dig zone: ${pt && `${pt.x},${pt.z}`}`)
  })

  it('restock digs surface dirt below the square level', async () => {
    // Live 2026-09-28: a square-relative floor (y >= level) starved restock
    // to zero — the square sat at 65 while the whole dig zone was 57-63.
    // The depth rule is local (surface-exposed), not square-relative.
    const world = makeWorld({})
    world.set(1, 63, 0, 'air')
    world.set(20, 63, 0, 'air') // expose the dirt below the square level
    const bot = mockBot(world, {
      items: [],
      registry: DIRT_REGISTRY,
      dirtSpots: [{ x: 20, y: 62, z: 0 }], // 1 below level 63, locally surfaced
    })
    const ctx = { lastGoalKey: '', flat: startEpisode(0, 0, 4, 74, 'P') }
    flat(bot, ctx, null, null); await settle() // scan
    flat(bot, ctx, null, null); await settle() // fill: issue
    bot.entity.position = pos(3, 64, 0)
    flat(bot, ctx, null, null); await settle() // arrived -> dig
    flat(bot, ctx, null, null); await settle() // dig: find + issue
    assert.equal(ctx.flat.phase, 'dig')
    assert.deepEqual([ctx.flat.dig.pos.x, ctx.flat.dig.pos.y, ctx.flat.dig.pos.z], [20, 62, 0], 'local-surface dirt accepted below the square level')
  })

  it('restock digs surface blocks only', async () => {
    const world = makeWorld({})
    world.set(1, 63, 0, 'air')
    world.set(20, 64, 0, 'stone') // buried: solid above
    const bot = mockBot(world, {
      items: [],
      registry: DIRT_REGISTRY,
      dirtSpots: [{ x: 20, y: 63, z: 0 }, { x: 22, y: 63, z: 0 }],
    })
    const ctx = { lastGoalKey: '', flat: startEpisode(0, 0, 4, 74, 'P') }
    flat(bot, ctx, null, null); await settle() // scan
    flat(bot, ctx, null, null); await settle() // fill: issue
    bot.entity.position = pos(3, 64, 0)
    flat(bot, ctx, null, null); await settle() // arrived -> dig
    flat(bot, ctx, null, null); await settle() // dig: find + issue
    assert.deepEqual([ctx.flat.dig.pos.x, ctx.flat.dig.pos.z], [22, 0], 'buried dirt filtered out')
  })

  it('restock prefers a bump over nearer flat dirt', async () => {
    const world = makeWorld({})
    world.set(1, 63, 0, 'air')
    world.set(30, 64, 0, 'dirt')
    world.set(30, 65, 0, 'dirt') // a bump top above level 63
    const bot = mockBot(world, {
      items: [],
      registry: DIRT_REGISTRY,
      dirtSpots: [{ x: 20, y: 63, z: 0 }, { x: 30, y: 65, z: 0 }],
    })
    const ctx = { lastGoalKey: '', flat: startEpisode(0, 0, 4, 74, 'P') }
    flat(bot, ctx, null, null); await settle() // scan
    flat(bot, ctx, null, null); await settle() // fill: issue
    bot.entity.position = pos(3, 64, 0)
    flat(bot, ctx, null, null); await settle() // arrived -> dig
    flat(bot, ctx, null, null); await settle() // dig: find + issue
    assert.deepEqual([ctx.flat.dig.pos.x, ctx.flat.dig.pos.y, ctx.flat.dig.pos.z], [30, 65, 0], 'bump top preferred')
  })

  it('restock skips dirt next to owner builds (interim gate)', async () => {
    const world = makeWorld({})
    world.set(1, 63, 0, 'air')
    world.set(19, 63, 0, 'oak_planks') // structure marker beside the tainted spot only
    const bot = mockBot(world, {
      items: [],
      registry: DIRT_REGISTRY,
      dirtSpots: [{ x: 20, y: 63, z: 0 }, { x: 22, y: 63, z: 0 }],
    })
    const ctx = { lastGoalKey: '', flat: startEpisode(0, 0, 4, 74, 'P') }
    flat(bot, ctx, null, null); await settle() // scan
    flat(bot, ctx, null, null); await settle() // fill: issue
    bot.entity.position = pos(3, 64, 0)
    flat(bot, ctx, null, null); await settle() // arrived -> dig
    flat(bot, ctx, null, null); await settle() // dig: find + issue
    assert.deepEqual([ctx.flat.dig.pos.x, ctx.flat.dig.pos.z], [22, 0], 'marker-adjacent dirt filtered out')
  })

  it('restock asks canBreak and skips denied blocks', async () => {
    const world = makeWorld({})
    world.set(1, 63, 0, 'air')
    const bot = mockBot(world, {
      items: [],
      registry: DIRT_REGISTRY,
      dirtSpots: [{ x: 20, y: 63, z: 0 }, { x: 22, y: 63, z: 0 }],
    })
    const ctx = { lastGoalKey: '', flat: startEpisode(0, 0, 4, 74, 'P') }
    const origCanBreak = util.canBreak
    util.canBreak = (b, block) => block.position.x !== 20
    try {
      flat(bot, ctx, null, null); await settle() // scan
      flat(bot, ctx, null, null); await settle() // fill: issue
      bot.entity.position = pos(3, 64, 0)
      flat(bot, ctx, null, null); await settle() // arrived -> dig
      flat(bot, ctx, null, null); await settle() // dig: find + issue
      assert.deepEqual([ctx.flat.dig.pos.x, ctx.flat.dig.pos.z], [22, 0], 'guard-denied dirt skipped')
      assert.ok(!cap.lines.some((l) => l.includes('flat protected:')), 'quiet while a candidate remains')
    } finally { if (origCanBreak === undefined) delete util.canBreak; else util.canBreak = origCanBreak }
  })

  it('restock logs one protected line when the guard denies everything', async () => {
    const world = makeWorld({})
    world.set(1, 63, 0, 'air')
    const bot = mockBot(world, {
      items: [],
      registry: DIRT_REGISTRY,
      dirtSpots: [{ x: 20, y: 63, z: 0 }, { x: 22, y: 63, z: 0 }],
    })
    const ctx = { lastGoalKey: '', flat: startEpisode(0, 0, 4, 74, 'P') }
    const origCanBreak = util.canBreak
    util.canBreak = () => false
    try {
      flat(bot, ctx, null, null); await settle() // scan
      flat(bot, ctx, null, null); await settle() // fill: issue
      bot.entity.position = pos(3, 64, 0)
      flat(bot, ctx, null, null); await settle() // arrived -> dig
      flat(bot, ctx, null, null); await settle() // dig: find -> empty -> endDig
      assert.equal(ctx.flat, null)
      assert.ok(bot.chats.some((c) => c.includes('1 left (no fill blocks)')), bot.chats.join('\n'))
      const prot = cap.lines.filter((l) => l.includes('flat protected:'))
      assert.equal(prot.length, 1, cap.lines.join('\n'))
      assert.ok(prot[0].includes('flat protected: dirt at 20 63 0'), prot[0])
    } finally { if (origCanBreak === undefined) delete util.canBreak; else util.canBreak = origCanBreak }
  })

  it('restock fail-closes on truthy and throwing guards', async () => {
    const world = makeWorld({})
    world.set(1, 63, 0, 'air')
    const bot = mockBot(world, {
      items: [],
      registry: DIRT_REGISTRY,
      dirtSpots: [{ x: 20, y: 63, z: 0 }, { x: 22, y: 63, z: 0 }],
    })
    const ctx = { lastGoalKey: '', flat: startEpisode(0, 0, 4, 74, 'P') }
    const origCanBreak = util.canBreak
    util.canBreak = (b, block) => { if (block.position.x === 20) return 1; throw new Error('boom') }
    try {
      flat(bot, ctx, null, null); await settle() // scan
      flat(bot, ctx, null, null); await settle() // fill: issue
      bot.entity.position = pos(3, 64, 0)
      flat(bot, ctx, null, null); await settle() // arrived -> dig
      flat(bot, ctx, null, null); await settle() // dig: find -> empty -> endDig
      assert.equal(ctx.flat, null)
      const prot = cap.lines.filter((l) => l.includes('flat protected:'))
      assert.equal(prot.length, 1, cap.lines.join('\n'))
      assert.ok(prot[0].includes('flat protected: dirt at 20 63 0'), prot[0])
    } finally { if (origCanBreak === undefined) delete util.canBreak; else util.canBreak = origCanBreak }
  })

  it('skips a hole whose support cell unloaded as floating', async () => {
    // Only the hole column goes dark; (2,62,0) stays loaded dirt under a
    // liquid (2,63,0), so a deleted below-unloaded branch would find a
    // support reference and place — the place count pins the branch, and
    // the liquid neighbour can never cap in from the side.
    let dark = false
    const world = makeWorld({ unloaded: (x, z) => dark && Math.abs(x - 1) <= 1 && Math.abs(z) <= 1 && !(x === 2 && z === 0) })
    world.set(1, 63, 0, 'air')
    world.set(1, 62, 0, 'air')
    world.set(2, 63, 0, 'water')
    const bot = mockBot(world, { items: [{ name: 'dirt', count: 64 }] })
    const ctx = { lastGoalKey: '', flat: startEpisode(0, 0, 4, 74, 'P') }
    flat(bot, ctx, null, null); await settle() // scan while loaded
    assert.equal(ctx.flat.holes.length, 1)
    dark = true // the chunk drops out from under the job
    for (let i = 0; i < 30 && ctx.flat; i++) {
      bot.entity.position = pos(3, 64, 0)
      flat(bot, ctx, null, null); await settle()
    }
    assert.equal(ctx.flat, null)
    assert.equal(bot.calls.places.length, 0, 'no support into an unloaded cell')
    assert.ok(bot.chats.some((c) => c.includes('skipped 1: 1 floating')), bot.chats.join('\n'))
  })

  it('skips a hole whose support cell is occupied', async () => {
    // Center 2-deep with an unloaded ring (no side refs), player feet in
    // the support cell but clear of the cap.
    const world = makeWorld({ unloaded: (x, z) => Math.abs(x) <= 1 && Math.abs(z) <= 1 && !(x === 0 && z === 0) })
    world.set(0, 63, 0, 'air')
    world.set(0, 62, 0, 'air')
    const players = { Q: { username: 'Q', entity: { position: pos(0, 61.5, 0) } } }
    const bot = mockBot(world, { items: [{ name: 'dirt', count: 64 }], players })
    const ctx = { lastGoalKey: '', flat: startEpisode(0, 0, 4, 74, 'P') }
    for (let i = 0; i < 30 && ctx.flat; i++) {
      const f = ctx.flat
      if (f.phase === 'fill' && f.holes.length > 0) bot.entity.position = pos(2, 64, 0)
      flat(bot, ctx, null, null); await settle()
    }
    assert.equal(ctx.flat, null)
    assert.equal(world.blockAt({ x: 0, y: 63, z: 0 }).name, 'air')
    assert.ok(bot.chats.some((c) => c.includes('skipped 1: 1 occupied')), bot.chats.join('\n'))
  })

  it('restockPoint searches from the dig zone past the gap', () => {
    const f = startEpisode(0, 0, 4, 74, 'P')
    const at = (p) => [p.x, p.y, p.z]
    assert.deepEqual(at(restockPoint(f, { x: 1, y: 64, z: 0 })), [20, 64, 0])
    assert.deepEqual(at(restockPoint(f, { x: 0, y: 64, z: -2 })), [0, 64, -20])
    assert.deepEqual(at(restockPoint(f, { x: 0, y: 64, z: 0 })), [0, 64, 20])
    assert.deepEqual(at(restockPoint(f, { x: 6, y: 64, z: 0 })), [20, 64, 0], 'just outside: pushed out to the dig zone')
    assert.deepEqual(at(restockPoint(f, { x: 30, y: 64, z: 0 })), [30, 64, 0], 'already in the dig zone: search from the bot')
  })

  it('surface guard vetoes breaks at/below level inside the square only', () => {
    const world = makeWorld({})
    const bot = mockBot(world, {})
    const mov = { exclusionAreasBreak: [] }
    bot.pathfinder.movements = mov
    const f = startEpisode(0, 0, 4, 74, 'P')
    f.level = 63
    const ctx = { lastGoalKey: 'flat:0,63,0', flat: f }
    guardFlatSurface(bot, ctx)
    assert.equal(mov.exclusionAreasBreak.length, 1)
    const fn = mov.exclusionAreasBreak[0]
    const veto = (x, y, z) => fn({ position: { x, y, z } })
    assert.equal(veto(0, 62, 0), 100, 'below level inside')
    assert.equal(veto(0, 63, 0), 100, 'at level inside')
    assert.equal(veto(0, 64, 0), 0, 'above level: pass through')
    assert.equal(veto(20, 62, 0), 0, 'outside the square')
    ctx.lastGoalKey = 'lead:1,2,3' // an errand owns the body: its search digs
    assert.equal(veto(0, 62, 0), 0, 'non-flat goal: guard off')
    ctx.lastGoalKey = 'flat-dig:9,9,9'
    assert.equal(veto(0, 62, 0), 100, 'restock walk: guard on')
    ctx.lastGoalKey = 'flat:0,63,0'
    f.parked = true
    assert.equal(veto(0, 62, 0), 0, 'parked: no live guard')
    f.parked = false
    ctx.flat = startEpisode(10, 10, 4, 74, 'P')
    assert.equal(veto(0, 62, 0), 0, 'replaced episode: stale guard no-ops')
    ctx.flat = null
    guardFlatSurface(bot, ctx)
    assert.equal(mov.exclusionAreasBreak.length, 0, 'finish detaches')
  })

  it('digs dirt outside the area when out of blocks, then resumes', async () => {
    const world = makeWorld({})
    world.set(1, 63, 0, 'air')
    const { bot, ctx } = started(world, {
      items: [],
      registry: DIRT_REGISTRY,
      dirtSpots: [{ x: 20, y: 63, z: 0 }],
    })
    await drive(bot, ctx, 40)
    assert.equal(ctx.flat, null)
    assert.equal(world.blockAt({ x: 1, y: 63, z: 0 }).name, 'dirt', 'hole filled after restock')
    assert.equal(world.blockAt({ x: 20, y: 63, z: 0 }).name, 'air', 'dirt came from outside')
    for (const [ref] of bot.calls.places) {
      void ref
    }
    assert.ok(bot.calls.digs.length >= 1)
    assert.ok(bot.chats.some((c) => c === 'out of fill blocks, digging dirt'), bot.chats.join('\n'))
    assert.ok(bot.chats.some((c) => c === 'flat done: filled 1 hole'), bot.chats.join('\n'))
  })

  it('reports no fill blocks when no dirt is around', async () => {
    const world = makeWorld({})
    world.set(1, 63, 0, 'air')
    const { bot, ctx } = started(world, { items: [], registry: DIRT_REGISTRY, dirtSpots: [] })
    await drive(bot, ctx, 20)
    assert.equal(ctx.flat, null)
    assert.ok(bot.chats.some((c) => c.includes('1 left (no fill blocks)')), bot.chats.join('\n'))
  })

  it('skips a hole after three refused placements', async () => {
    const world = makeWorld({})
    world.set(1, 63, 0, 'air')
    const bot = mockBot(world, { items: [{ name: 'dirt', count: 64 }], failPlace: true })
    const ctx = { lastGoalKey: '', flat: startEpisode(0, 0, 4, 74, 'P') }
    await drive(bot, ctx, 20)
    assert.equal(ctx.flat, null)
    assert.equal(bot.calls.places.length, 3)
    assert.ok(bot.chats.some((c) => c.includes('skipped 1: 1 refused')), bot.chats.join('\n'))
  })

  it('an 11-hole field chats exactly one progress line before done', async () => {
    // Revmux 01 core-1 through the tick path: the count trigger fires
    // once past 10 resolved cells, then the 120 s cadence holds.
    const world = makeWorld({})
    for (let x = -4; x <= 4; x++) world.set(x, 63, 0, 'air')
    world.set(-4, 63, 1, 'air')
    world.set(-3, 63, 1, 'air')
    const { bot, ctx } = started(world)
    await drive(bot, ctx, 60)
    assert.equal(ctx.flat, null)
    const prog = bot.chats.filter((c) => /^flat \d+\/\d+ \(level/.test(c))
    assert.equal(prog.length, 1, bot.chats.join('\n'))
  })

  it('logs refused placements with coordinates to the console', async () => {
    const world = makeWorld({})
    world.set(1, 63, 0, 'air')
    const bot = mockBot(world, { items: [{ name: 'dirt', count: 64 }], failPlace: true })
    const ctx = { lastGoalKey: '', flat: startEpisode(0, 0, 4, 74, 'P') }
    await drive(bot, ctx, 20)
    assert.equal(ctx.flat, null)
    assert.ok(cap.lines.some((l) => l.includes('flat refused-place 1,63,0') && l.includes('err=refused')),
      cap.lines.join('\n'))
  })

  it('gives up through the backstop instead of looping forever', async () => {
    const world = makeWorld({})
    world.set(1, 63, 0, 'air')
    const { bot, ctx } = started(world)
    flat(bot, ctx, null, null) // scan
    await settle()
    assert.equal(ctx.flat.phase, 'fill')
    ctx.flat.ticks = 200
    ctx.flat.lastProgressTick = 0
    flat(bot, ctx, null, null)
    await settle()
    assert.equal(ctx.flat, null)
    assert.ok(bot.chats.some((c) => c.includes('left (stalled)')), bot.chats.join('\n'))
  })

  it('reports an already-flat area and unloaded columns', async () => {
    const world = makeWorld({ unloaded: (x, z) => x >= 3 && z >= 3 })
    const { bot, ctx } = started(world)
    await drive(bot, ctx, 5)
    assert.equal(ctx.flat, null)
    assert.ok(bot.chats.some((c) => c.includes('0 holes, 4 unloaded')), bot.chats.join('\n'))
    assert.ok(bot.chats.some((c) => c === 'flat done: filled 0 holes'), bot.chats.join('\n'))
  })
})

describe('flat verified stands (idkcraft-cm0)', () => {
  let cap
  beforeEach(() => { cap = capture() })
  afterEach(() => { cap.release() })

  async function drive(bot, ctx, n) {
    for (let i = 0; i < n && ctx.flat; i++) {
      const f = ctx.flat
      if (f.phase === 'fill' && f.holes.length > 0) {
        const h = f.holes[0]
        bot.entity.position = pos(h.x + 2, 64, h.z)
      } else if (f.phase === 'shave' && f.bumps.length > 0) {
        const h = f.bumps[0]
        bot.entity.position = pos(h.x + 2, h.y, h.z)
      }
      flat(bot, ctx, null, null)
      await settle()
    }
  }

  function started(world, botOpts = {}) {
    const bot = mockBot(world, { items: [{ name: 'dirt', count: 64 }], ...botOpts })
    const ctx = { lastGoalKey: '', flat: startEpisode(0, 0, 4, 74, 'P') }
    return { bot, ctx }
  }

  it('wall between eyes and face: no attempt, hole defers to unreachable', async () => {
    const world = makeWorld({})
    world.set(1, 63, 0, 'air')
    const { bot, ctx } = started(world)
    bot.world.raycast = () => ({ position: { x: 2, y: 64, z: 0 } }) // a wall, not the ref
    await drive(bot, ctx, 15)
    assert.equal(ctx.flat, null)
    assert.equal(bot.calls.places.length, 0, 'never attempts through a wall')
    assert.ok(bot.chats.some((c) => c.includes('skipped 1: 1 unreachable')), bot.chats.join('\n'))
  })

  it('far stand places via the visible pit-wall face, not the occluded floor', async () => {
    // Revmux-01 finding 0: below-first returns the pit floor, whose top
    // face a 2-3-block stand cannot see (the click ray clips the near
    // wall). The reference scan must fall through to the visible wall
    // face GoalPlaceBlock stopped for instead of def-looping.
    const world = makeWorld({})
    world.set(1, 63, 0, 'air') // 1-deep hole: dirt floor + dirt walls
    const { bot, ctx } = started(world)
    bot.world.raycast = (origin, dir, range) => { // sampling ray through the mock world
      for (let t = 0.25; t <= range; t += 0.25) {
        const b = world.blockAt({ x: origin.x + dir.x * t, y: origin.y + dir.y * t, z: origin.z + dir.z * t })
        if (b && b.boundingBox !== 'empty') return { position: { x: b.position.x, y: b.position.y, z: b.position.z } }
      }
      return null
    }
    await drive(bot, ctx, 15) // drive parks 2 out, like a GoalPlaceBlock stand
    assert.equal(ctx.flat, null)
    assert.equal(bot.calls.places.length, 1, 'places via the wall face')
    assert.equal(world.blockAt({ x: 1, y: 63, z: 0 }).name, 'dirt')
    assert.ok(bot.chats.some((c) => c.includes('filled 1 hole')), bot.chats.join('\n'))
  })

  it('out of eye reach: no attempt, hole defers to unreachable', async () => {
    const world = makeWorld({})
    world.set(1, 63, 0, 'air')
    const { bot, ctx } = started(world)
    bot.entity.position = pos(12, 64, 12) // far: eyes ~15 from the face
    for (let i = 0; i < 15 && ctx.flat; i++) { flat(bot, ctx, null, null); await settle() }
    assert.equal(ctx.flat, null)
    assert.equal(bot.calls.places.length, 0, 'never attempts out of reach')
    assert.ok(bot.chats.some((c) => c.includes('skipped 1: 1 unreachable')), bot.chats.join('\n'))
  })

  it('own column below the cap: steps out once, never attempts, skips occupied', async () => {
    const world = makeWorld({})
    world.set(1, 63, 0, 'air')
    world.set(1, 62, 0, 'air')
    world.set(1, 61, 0, 'air') // 3-deep: feet at 61 stand below the cap, in air
    const { bot, ctx } = started(world)
    bot.entity.position = pos(1.5, 61, 0.5)
    for (let i = 0; i < 5 && ctx.flat && ctx.flat.phase === 'scan'; i++) { flat(bot, ctx, null, null); await settle() }
    flat(bot, ctx, null, null)
    await settle()
    assert.ok(ctx.lastGoalKey.startsWith('flat-f2:'), `one step out first, got ${ctx.lastGoalKey}`)
    const g = bot.calls.goals[bot.calls.goals.length - 1]
    assert.equal(g.y, 64, 'step-out aims at the surface, not the pit floor (revmux-03)')
    for (let i = 0; i < 14 && ctx.flat; i++) { flat(bot, ctx, null, null); await settle() }
    assert.equal(ctx.flat, null)
    assert.equal(bot.calls.places.length, 0, 'never caps from inside the pit')
    assert.ok(bot.chats.some((c) => c.includes('skipped 1: 1 occupied')), bot.chats.join('\n'))
  })

  it('mob in the cap cell waits out instead of attempting into it', async () => {
    // Cm0.1: a mob in the cap cell rejects the placement (rig: 0/6 into a
    // sheep) — the hole waits like for a player, then places once free.
    const world = makeWorld({})
    world.set(1, 63, 0, 'air')
    const { bot, ctx } = started(world)
    bot.entities = { 9: { id: 9, name: 'sheep', type: 'mob', position: pos(1.5, 63, 0.5) } }
    for (let i = 0; i < 3 && ctx.flat; i++) { flat(bot, ctx, null, null); await settle() }
    assert.equal(bot.calls.places.length, 0, 'no attempt into the sheep')
    assert.ok(ctx.flat && ctx.flat.holes.length === 1, 'hole waits, not skips')
    delete bot.entities[9] // the mob wanders off
    await drive(bot, ctx, 15)
    assert.equal(ctx.flat, null)
    assert.equal(bot.calls.places.length, 1, 'places once free')
    assert.ok(bot.chats.some((c) => c.includes('filled 1 hole')), bot.chats.join('\n'))
  })

  it('stray drop in the cap cell does not block placement', async () => {
    // Cm0.1: drops and projectiles never collide (rig: 5/5 placed) — only
    // mobs wait out.
    const world = makeWorld({})
    world.set(1, 63, 0, 'air')
    const { bot, ctx } = started(world)
    bot.entities = {
      9: { id: 9, name: 'item', type: 'other', position: pos(1.5, 63, 0.5) },
      10: { id: 10, name: 'arrow', type: 'projectile', position: pos(1.5, 63, 0.5) },
    }
    await drive(bot, ctx, 15)
    assert.equal(ctx.flat, null)
    assert.equal(bot.calls.places.length, 1, 'places into a cell holding only drops')
    assert.ok(bot.chats.some((c) => c.includes('filled 1 hole')), bot.chats.join('\n'))
  })

  it('throwing raycast still attempts (lenient fallback)', async () => {
    const world = makeWorld({})
    world.set(1, 63, 0, 'air')
    const { bot, ctx } = started(world)
    bot.world.raycast = () => { throw new Error('no ray in this client') }
    await drive(bot, ctx, 10)
    assert.equal(ctx.flat, null)
    assert.equal(bot.calls.places.length, 1, 'reach gate alone still places')
    assert.equal(world.blockAt({ x: 1, y: 63, z: 0 }).name, 'dirt')
  })
})
