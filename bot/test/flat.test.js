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
const {
  probeColumn, spiralColumns, chooseLevel, detectHoles,
  isFillBlock, findFillItem, countFill, cellOccupied, parseRadius, startEpisode,
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

  it('reports a water surface as liquid', () => {
    const world = makeWorld({ surface: 63 })
    world.set(0, 63, 0, 'air')
    world.set(0, 62, 0, 'water')
    const r = probeColumn(gridAt(world), 0, 0, 74, 4)
    assert.equal(r.status, 'liquid')
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
    assert.equal(FLAT_DEFAULT_RADIUS, 48)
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
    for (const [msg, want] of [['flat', 48], ['make flat', 48], ['flatten', 48], ['flat 16', 16], ['flatten 10', 10], ['flat 200', 64], ['flat 2', 4]]) {
      const bot = chatBot()
      handleChat(bot, ticker, 'P', msg)
      assert.deepEqual(bot.chats, ['ok'], msg)
    }
    assert.deepEqual(seen.map((s) => s.radius), [48, 48, 48, 16, 10, 64, 4])
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

  it('fills a 1-deep hole, leaves a bump alone, reports done', async () => {
    const world = makeWorld({})
    world.set(1, 63, 0, 'air') // the hole
    world.set(2, 64, 0, 'dirt') // a bump: out of scope v1
    const { bot, ctx } = started(world)
    await drive(bot, ctx, 10)
    assert.equal(ctx.flat, null, 'episode ends')
    assert.equal(world.blockAt({ x: 1, y: 63, z: 0 }).name, 'dirt')
    assert.equal(world.blockAt({ x: 2, y: 64, z: 0 }).name, 'dirt', 'bump untouched')
    assert.equal(bot.calls.places.length, 1)
    assert.ok(bot.chats.some((c) => c.includes('flattening 9x9 around P, level 63: 1 holes')), bot.chats.join('\n'))
    assert.ok(bot.chats.some((c) => c === 'flat done: filled 1 hole'), bot.chats.join('\n'))
  })

  it('skips water holes and reports them', async () => {
    const world = makeWorld({})
    world.set(1, 63, 0, 'air')
    world.set(1, 62, 0, 'water')
    world.set(1, 61, 0, 'dirt')
    const { bot, ctx } = started(world)
    await drive(bot, ctx, 10)
    assert.equal(ctx.flat, null)
    assert.equal(world.blockAt({ x: 1, y: 62, z: 0 }).name, 'water', 'water untouched')
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
    world.set(4, 63, 4, 'air') // 5.7 blocks from spawn: past REACH_DIST
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

  it('restockPoint exits past the nearest edge', () => {
    const f = startEpisode(0, 0, 4, 74, 'P')
    const at = (p) => [p.x, p.y, p.z]
    assert.deepEqual(at(restockPoint(f, { x: 1, y: 64, z: 0 })), [8, 64, 0])
    assert.deepEqual(at(restockPoint(f, { x: 0, y: 64, z: -2 })), [0, 64, -8])
    assert.deepEqual(at(restockPoint(f, { x: 0, y: 64, z: 0 })), [0, 64, 8])
    assert.deepEqual(at(restockPoint(f, { x: 20, y: 64, z: 0 })), [20, 64, 0], 'already outside: search from the bot')
  })

  it('surface guard vetoes breaks at/below level inside the square only', () => {
    const world = makeWorld({})
    const bot = mockBot(world, {})
    const mov = { exclusionAreasBreak: [] }
    bot.pathfinder.movements = mov
    const f = startEpisode(0, 0, 4, 74, 'P')
    f.level = 63
    const ctx = { lastGoalKey: '', flat: f }
    guardFlatSurface(bot, ctx)
    assert.equal(mov.exclusionAreasBreak.length, 1)
    const fn = mov.exclusionAreasBreak[0]
    const veto = (x, y, z) => fn({ position: { x, y, z } })
    assert.equal(veto(0, 62, 0), 100, 'below level inside')
    assert.equal(veto(0, 63, 0), 100, 'at level inside')
    assert.equal(veto(0, 64, 0), 0, 'above level: pass through')
    assert.equal(veto(20, 62, 0), 0, 'outside the square')
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
