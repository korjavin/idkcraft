'use strict'

// Bead w52.1 (flat v2): shave bumps above the surface level after filling.
// Planning + safety unit tests and behaviour ticks against a scripted voxel
// world. The combined hole+bump end-to-end run extends scenarios-flat.test.js.

const { describe, it, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const { createTicker } = require('../src/index')
const flat = require('../src/behaviours/flat')
const {
  detectBumps, isDiggable, DIG_ALLOWLIST, isStructureMarker, structureNear,
  threatenedSelf, threatenedByPlayer, resumeLine, startEpisode, liquidNear,
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

// Survival drops for the dug naturals (no silk touch).
function dropFor(name) {
  if (name === 'grass_block') return 'dirt'
  if (name === 'stone') return 'cobblestone'
  if (name === 'deepslate') return 'cobbled_deepslate'
  return name
}

const DIRT_REGISTRY = {
  blocksByName: { dirt: { id: 1 }, grass_block: { id: 2 }, coarse_dirt: { id: 3 }, stone: { id: 4 } },
}

function mockBot(world, { items = [], feet = pos(0, 64, 0), players = {}, failDig = false, moving = false, canDig = true, registry = null, dirtSpots = [], bestTool = null } = {}) {
  const chats = []
  const calls = { goals: [], places: [], digs: [], pickups: [], equips: [] }
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
    findBlocks: () => dirtSpots.filter((p) => {
      const b = world.blockAt(p)
      return b && (b.name === 'dirt' || b.name === 'grass_block' || b.name === 'coarse_dirt')
    }),
    _moving: !!moving,
    pathfinder: {
      goal: null,
      bestHarvestTool: bestTool == null ? undefined : () => bestTool,
      isMoving: () => bot._moving,
      setGoal: (g) => { calls.goals.push(g); bot.pathfinder.goal = g },
      stop: () => {},
      setMovements: () => {},
    },
    equip: async (item, dest) => { calls.equips.push(item && item.name); bot.held = item && item.name },
    dig: async (b) => {
      calls.digs.push(b.name)
      if (failDig) throw new Error('interrupted')
      world.set(b.position.x, b.position.y, b.position.z, 'air')
      addItem(items, dropFor(b.name), 1)
    },
    placeBlock: async (ref, face) => {
      calls.places.push([ref, face])
      const rp = ref.position
      const stack = items.find((i) => i.name === bot.held)
      world.set(rp.x + face.x, rp.y + face.y, rp.z + face.z, bot.held)
      if (stack && --stack.count <= 0) items.splice(items.indexOf(stack), 1)
    },
    canDigBlock: () => canDig,
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

describe('shave plan: detectBumps', () => {
  it('takes above-level columns nearest first; holes and flats ignored', () => {
    const records = [
      { x: 5, z: 0, topY: 65 }, // bump, far
      { x: 1, z: 0, topY: 64 }, // bump, near
      { x: 0, z: 0, topY: 63 }, // at level: fine
      { x: 2, z: 0, topY: 62 }, // hole: the fill phase owns it
      { x: -1, z: 0, deep: true }, // deep: a hole, never a bump
    ]
    const bumps = detectBumps(records, 63, 0, 0)
    assert.deepEqual(bumps.map((h) => [h.x, h.z]), [[1, 0], [5, 0]])
    assert.equal(bumps[0].y, 64, 'dig starts at the top')
  })

  it('returns no bumps on flat ground', () => {
    assert.deepEqual(detectBumps([{ x: 0, z: 0, topY: 63 }], 63, 0, 0), [])
  })
})

describe('shave safety: dig allowlist', () => {
  it('digs natural terrain, keeps ores/wood/built/valuable', () => {
    for (const n of ['dirt', 'grass_block', 'stone', 'gravel', 'sand', 'deepslate', 'tuff', 'snow', 'ice', 'netherrack', 'end_stone']) {
      assert.equal(isDiggable(n), true, n)
    }
    for (const n of ['diamond_ore', 'iron_ore', 'coal_ore', 'ancient_debris', 'oak_log', 'oak_planks', 'oak_door', 'white_bed', 'chest', 'furnace', 'glass', 'glass_pane', 'dirt_path', 'farmland', 'bedrock', 'obsidian', 'torch', 'oak_leaves', 'cobblestone', 'mossy_cobblestone', 'cobbled_deepslate', 'snow_block', 'water', 'air', null]) {
      assert.equal(isDiggable(n), false, String(n))
    }
  })

  it('no allowlisted block trips the structure gate', () => {
    for (const n of DIG_ALLOWLIST) {
      assert.equal(isStructureMarker(n), false, `${n} must not be a marker`)
    }
  })
})

describe('shave safety: structure markers', () => {
  it('recognises houses, farms, mines and decoration', () => {
    for (const n of ['oak_door', 'white_bed', 'chest', 'blast_furnace', 'oak_planks', 'oak_log', 'oak_leaves', 'glass_pane', 'cobblestone_stairs', 'stone_brick_wall', 'torch', 'soul_lantern', 'diamond_ore', 'bell', 'lectern', 'dirt', 'stone']) {
      const want = n !== 'dirt' && n !== 'stone'
      assert.equal(isStructureMarker(n), want, n)
    }
    assert.equal(isStructureMarker(null), false)
    assert.equal(isStructureMarker(42), false)
  })

  it('structureNear finds an adjacent door, null in open terrain', () => {
    const world = makeWorld({})
    world.set(2, 64, 0, 'oak_door')
    const bot = mockBot(world, {})
    assert.equal(structureNear(bot, 1, 64, 0), 'oak_door')
    assert.equal(structureNear(bot, 10, 64, 10), null)
  })
})

describe('shave safety: under-feet threat', () => {
  function threatBot() {
    return {
      entity: { position: pos(0, 64, 0) }, // feet 64: stands on 63
      players: { P: { entity: { position: pos(5, 63.2, 0) } } }, // feet 63: stands on 62
    }
  }

  it('covers the stood-on block and the inside cells, split self/others', () => {
    const bot = threatBot()
    assert.equal(threatenedSelf(bot, 0, 63, 0), true) // under own feet
    assert.equal(threatenedSelf(bot, 0, 64, 0), true) // own feet cell
    assert.equal(threatenedSelf(bot, 0, 65, 0), true) // own head cell
    assert.equal(threatenedSelf(bot, 0, 62, 0), false)
    assert.equal(threatenedSelf(bot, 5, 62, 0), false)
    assert.equal(threatenedByPlayer(bot, 5, 62, 0), true) // under player feet
    assert.equal(threatenedByPlayer(bot, 5, 63, 0), true)
    assert.equal(threatenedByPlayer(bot, 5, 61, 0), false)
    assert.equal(threatenedByPlayer(bot, 0, 63, 0), false)
    assert.equal(threatenedSelf({}, 0, 63, 0), false)
    assert.equal(threatenedByPlayer({}, 0, 63, 0), false)
  })

  it('catches a player straddling the target edge', () => {
    // Centre floors to column 2 but the 0.6 hitbox stands on column 1 too.
    const bot = { players: { P: { entity: { position: pos(2.1, 65, 0) } } } }
    assert.equal(threatenedByPlayer(bot, 1, 64, 0), true)
    assert.equal(threatenedByPlayer(bot, 2, 64, 0), true)
    assert.equal(threatenedByPlayer(bot, 3, 64, 0), false)
    assert.equal(threatenedByPlayer(bot, 0, 64, 0), false)
  })
})

describe('shave report: resumeLine', () => {
  it('counts both queues once bumps exist', () => {
    assert.equal(resumeLine({ holes: [1, 2], bumps: [], totalBumps: 0 }), 'resuming flat, 2 holes left')
    assert.equal(resumeLine({ holes: [1], bumps: [1, 2, 3], totalBumps: 3 }), 'resuming flat, 1 holes + 3 bumps left')
    assert.equal(resumeLine({ holes: [], bumps: [1], totalBumps: 1 }), 'resuming flat, 0 holes + 1 bumps left')
  })
})

describe('shave behaviour', () => {
  let cap
  beforeEach(() => { cap = capture() })
  afterEach(() => { cap.release() })

  // Drive flat() with a teleported body: each shave tick starts within dig
  // reach of the head target (like an arrived walk), never inside it.
  async function drive(bot, ctx, n) {
    for (let i = 0; i < n && ctx.flat; i++) {
      const f = ctx.flat
      if (f.phase === 'shave' && f.bumps.length > 0) {
        const h = f.bumps[0]
        bot.entity.position = pos(h.x + 2, h.y, h.z)
      } else if (f.phase === 'fill' && f.holes.length > 0) {
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
    return { bot, ctx, items: bot.inventory.items() }
  }

  it('shaves a 2-high dirt bump to the level and banks the drops', async () => {
    const world = makeWorld({})
    world.set(1, 64, 0, 'dirt')
    world.set(1, 65, 0, 'dirt')
    const { bot, ctx, items } = started(world)
    await drive(bot, ctx, 30)
    assert.equal(ctx.flat, null, 'episode ends')
    assert.equal(world.blockAt({ x: 1, y: 65, z: 0 }).name, 'air')
    assert.equal(world.blockAt({ x: 1, y: 64, z: 0 }).name, 'air')
    assert.equal(world.blockAt({ x: 1, y: 63, z: 0 }).name, 'dirt', 'level ground kept')
    assert.deepEqual(bot.calls.digs, ['dirt', 'dirt'], 'top-down order')
    const dirt = items.find((i) => i.name === 'dirt')
    assert.equal(dirt.count, 66, 'mined blocks go to the inventory')
    assert.ok(bot.chats.some((c) => c.includes('0 holes, 1 bumps')), bot.chats.join('\n'))
    assert.ok(bot.chats.some((c) => c === 'flat done: filled 0 holes, shaved 1 bump'), bot.chats.join('\n'))
  })

  it('fills holes before shaving bumps', async () => {
    const world = makeWorld({})
    world.set(-1, 63, 0, 'air') // hole
    world.set(1, 64, 0, 'dirt') // bump
    const { bot, ctx } = started(world)
    const order = []
    const origDig = bot.dig
    const origPlace = bot.placeBlock
    bot.dig = async (...a) => { order.push('dig'); return origDig(...a) }
    bot.placeBlock = async (...a) => { order.push('place'); return origPlace(...a) }
    await drive(bot, ctx, 30)
    assert.equal(ctx.flat, null)
    assert.deepEqual(order, ['place', 'dig'], 'fill phase runs first')
    assert.ok(bot.chats.some((c) => c === 'flat done: filled 1 hole, shaved 1 bump'), bot.chats.join('\n'))
  })

  it('keeps a bump at ore in the stack, dirt above still shaved', async () => {
    const world = makeWorld({})
    world.set(1, 64, 0, 'diamond_ore')
    world.set(1, 65, 0, 'dirt')
    world.set(1, 66, 0, 'dirt')
    const { bot, ctx } = started(world)
    await drive(bot, ctx, 40)
    assert.equal(ctx.flat, null)
    assert.equal(world.blockAt({ x: 1, y: 66, z: 0 }).name, 'air', 'dirt away from ore shaved')
    assert.equal(world.blockAt({ x: 1, y: 65, z: 0 }).name, 'dirt', 'dirt next to ore kept by the gate')
    assert.equal(world.blockAt({ x: 1, y: 64, z: 0 }).name, 'diamond_ore', 'ore kept')
    assert.ok(bot.chats.some((c) => c.includes('skipped 1: 1 kept')), bot.chats.join('\n'))
  })

  it('keeps a bump next to a door (structure gate)', async () => {
    const world = makeWorld({})
    world.set(1, 64, 0, 'dirt')
    world.set(2, 64, 0, 'oak_door')
    const { bot, ctx } = started(world)
    await drive(bot, ctx, 30)
    assert.equal(ctx.flat, null)
    assert.equal(world.blockAt({ x: 1, y: 64, z: 0 }).name, 'dirt', 'nothing dug')
    assert.equal(bot.calls.digs.length, 0)
    // The door column itself is a bump (top above level) and also kept.
    assert.ok(bot.chats.some((c) => c.includes('skipped 2: 2 kept')), bot.chats.join('\n'))
    assert.ok(cap.lines.some((l) => l.includes('oak_door next to the dig')), cap.lines.join('\n'))
  })

  it('never digs under a player: waits, then skips occupied', async () => {
    const world = makeWorld({})
    world.set(1, 64, 0, 'dirt')
    const players = { Q: { username: 'Q', entity: { position: pos(1, 65.2, 0) } } } // stands on 64
    const { bot, ctx } = started(world, { players })
    await drive(bot, ctx, 30)
    assert.equal(ctx.flat, null)
    assert.equal(world.blockAt({ x: 1, y: 64, z: 0 }).name, 'dirt', 'never dug under the player')
    assert.ok(bot.chats.some((c) => c.includes('skipped 1: 1 occupied')), bot.chats.join('\n'))
  })

  it('steps aside when standing on the dig target, then digs', async () => {
    const world = makeWorld({})
    world.set(0, 64, 0, 'dirt')
    const bot = mockBot(world, { items: [{ name: 'dirt', count: 64 }], feet: pos(0, 65.2, 0) })
    const ctx = { lastGoalKey: '', flat: startEpisode(0, 0, 4, 74, 'P') }
    flat(bot, ctx, null, null); await settle() // scan
    flat(bot, ctx, null, null); await settle() // shave: sidestep issued
    assert.ok(bot.calls.goals.length >= 1, 'sidestep goal issued')
    assert.equal(bot.calls.digs.length, 0, 'nothing dug from underfoot')
    bot.entity.position = pos(2, 64, 0) // stepped aside
    for (let i = 0; i < 12 && ctx.flat; i++) { flat(bot, ctx, null, null); await settle() }
    assert.equal(ctx.flat, null)
    assert.equal(world.blockAt({ x: 0, y: 64, z: 0 }).name, 'air', 'dug after stepping aside')
  })

  it('skips a bump gone liquid or unloaded mid-job', async () => {
    const world = makeWorld({})
    world.set(1, 64, 0, 'dirt')
    world.set(2, 64, 0, 'dirt')
    world.set(4, 64, 0, 'dirt')
    const { bot, ctx } = started(world)
    flat(bot, ctx, null, null); await settle() // scan: 3 bumps
    assert.equal(ctx.flat.bumps.length, 3)
    world.set(1, 64, 0, 'water') // flooded before the shave reaches it
    await drive(bot, ctx, 40)
    assert.equal(ctx.flat, null)
    assert.equal(world.blockAt({ x: 4, y: 64, z: 0 }).name, 'air', 'dry bump shaved')
    // The flooded column and its water-banked neighbour are both skipped.
    assert.ok(bot.chats.some((c) => c.includes('skipped 2: 2 water')), bot.chats.join('\n'))
  })

  it('skips an unloaded bump column as unreachable', async () => {
    let dark = false
    const world = makeWorld({ unloaded: (x, z) => dark && x === 1 && z === 0 })
    world.set(1, 64, 0, 'dirt')
    const { bot, ctx } = started(world)
    flat(bot, ctx, null, null); await settle() // scan while loaded
    assert.equal(ctx.flat.bumps.length, 1)
    dark = true
    await drive(bot, ctx, 40)
    assert.equal(ctx.flat, null)
    assert.equal(bot.calls.digs.length, 0, 'never dug blind')
    assert.ok(bot.chats.some((c) => c.includes('skipped 1: 1 unreachable')), bot.chats.join('\n'))
  })

  it('skips after refused digs and undiggable blocks', async () => {
    const world = makeWorld({})
    world.set(1, 64, 0, 'dirt')
    const bot = mockBot(world, { items: [], failDig: true })
    const ctx = { lastGoalKey: '', flat: startEpisode(0, 0, 4, 74, 'P') }
    for (let i = 0; i < 30 && ctx.flat; i++) {
      const f = ctx.flat
      if (f.phase === 'shave' && f.bumps.length > 0) bot.entity.position = pos(3, 64, 0)
      flat(bot, ctx, null, null); await settle()
    }
    assert.equal(ctx.flat, null)
    assert.equal(bot.calls.digs.length, 3)
    assert.ok(bot.chats.some((c) => c.includes('skipped 1: 1 refused')), bot.chats.join('\n'))

    const world2 = makeWorld({})
    world2.set(1, 64, 0, 'dirt')
    const bot2 = mockBot(world2, { items: [], canDig: false })
    const ctx2 = { lastGoalKey: '', flat: startEpisode(0, 0, 4, 74, 'P') }
    for (let i = 0; i < 30 && ctx2.flat; i++) {
      const f = ctx2.flat
      if (f.phase === 'shave' && f.bumps.length > 0) bot2.entity.position = pos(3, 64, 0)
      flat(bot2, ctx2, null, null); await settle()
    }
    assert.equal(ctx2.flat, null)
    assert.ok(bot2.chats.some((c) => c.includes('skipped 1: 1 refused')), bot2.chats.join('\n'))
  })

  it('walks the drop into range, gives up the walk when wedged', async () => {
    const world = makeWorld({})
    world.set(1, 64, 0, 'dirt')
    const bot = mockBot(world, { items: [] })
    const ctx = { lastGoalKey: '', flat: startEpisode(0, 0, 4, 74, 'P') }
    flat(bot, ctx, null, null); await settle() // scan
    flat(bot, ctx, null, null); await settle() // shave: issue
    bot.entity.position = pos(3, 64, 0)
    flat(bot, ctx, null, null); await settle() // arrived: dig flight
    assert.ok(ctx.flat.bumps[0].pickup, 'pickup queued after the dig')
    flat(bot, ctx, null, null); await settle() // pickup: issue GoalBlock
    bot._moving = true // wedged: the walk never progresses
    for (let i = 0; i < 12 && ctx.flat; i++) { flat(bot, ctx, null, null); await settle() }
    assert.equal(ctx.flat, null, 'column still completes')
    assert.ok(bot.chats.some((c) => c.includes('shaved 1 bump')), bot.chats.join('\n'))
  })
})

describe('shave ticker: resume counts bumps', () => {
  let cap
  beforeEach(() => { cap = capture() })
  afterEach(() => { cap.release() })

  it('resume line names holes and bumps', async () => {
    const world = makeWorld({})
    world.set(1, 63, 0, 'air')
    world.set(2, 64, 0, 'dirt')
    const bot = mockBot(world, { items: [{ name: 'dirt', count: 64 }], players: { P: { username: 'P' } } })
    const brain = { async decide() { return { action: 'roam', sprint: false, source: 'stub' } } }
    const ticker = createTicker({ bot, brain, tickMs: 10, idleTickMs: 10 })
    try {
      ticker.setFlat({ radius: 4, by: 'P', explicit: true })
      await ticker.tick() // scan
      assert.equal(bot._tickerCtx.flat.bumps.length, 1)
      ticker.stop()
      const line = ticker.setFlat({ radius: 4, by: 'P', explicit: true })
      assert.match(line, /resuming flat, 1 holes \+ 1 bumps left/)
    } finally { ticker.destroy() }
  })
})

describe('shave safety: restock never digs under a player', () => {
  let cap
  beforeEach(() => { cap = capture() })
  afterEach(() => { cap.release() })

  it('skips dirt under player feet for free dirt', async () => {
    const world = makeWorld({})
    world.set(1, 63, 0, 'air')
    const players = { Q: { username: 'Q', entity: { position: pos(20, 64.2, 0) } } } // stands on (20,63,0)
    const bot = mockBot(world, {
      items: [],
      players,
      registry: DIRT_REGISTRY,
      dirtSpots: [{ x: 20, y: 63, z: 0 }, { x: 30, y: 63, z: 0 }],
    })
    const ctx = { lastGoalKey: '', flat: startEpisode(0, 0, 4, 74, 'P') }
    flat(bot, ctx, null, null); await settle() // scan
    flat(bot, ctx, null, null); await settle() // fill: issue
    bot.entity.position = pos(3, 64, 0)
    flat(bot, ctx, null, null); await settle() // arrived, no item -> dig
    assert.equal(ctx.flat.phase, 'dig')
    flat(bot, ctx, null, null); await settle() // dig: find + issue
    assert.deepEqual([ctx.flat.dig.pos.x, ctx.flat.dig.pos.z], [30, 0], 'dirt under the player skipped')
  })
})

describe('shave round-1 fixes', () => {
  let cap
  beforeEach(() => { cap = capture() })
  afterEach(() => { cap.release() })

  it('shaves a tall column even when every pickup parks on top', async () => {
    const world = makeWorld({})
    for (let y = 64; y <= 71; y++) world.set(1, y, 0, 'dirt') // 8 high
    const bot = mockBot(world, { items: [] })
    const ctx = { lastGoalKey: '', flat: startEpisode(0, 0, 4, 74, 'P') }
    flat(bot, ctx, null, null); await settle() // scan
    let parked = false
    for (let i = 0; i < 200 && ctx.flat; i++) {
      const f = ctx.flat
      if (f.phase === 'shave' && f.bumps.length > 0) {
        const h = f.bumps[0]
        // Simulate the pickup walk ending on the column, then stepping off.
        if (h.pickup && !parked) { bot.entity.position = pos(h.x, h.y + 1, h.z); parked = true }
        else { bot.entity.position = pos(h.x + 2, h.y, h.z); if (!h.pickup) parked = false }
      }
      flat(bot, ctx, null, null); await settle()
    }
    assert.equal(ctx.flat, null, 'tall column completes, not skipped occupied')
    for (let y = 64; y <= 71; y++) {
      assert.equal(world.blockAt({ x: 1, y, z: 0 }).name, 'air', `level ${y} dug`)
    }
    assert.ok(bot.chats.some((c) => c.includes('shaved 1 bump')), bot.chats.join('\n'))
  })

  it('equips the harvest tool before the shave dig', async () => {
    const world = makeWorld({})
    world.set(1, 64, 0, 'stone')
    const pick = { name: 'iron_pickaxe', count: 1 }
    const bot = mockBot(world, { items: [pick], bestTool: pick })
    const ctx = { lastGoalKey: '', flat: startEpisode(0, 0, 4, 74, 'P') }
    flat(bot, ctx, null, null); await settle() // scan
    flat(bot, ctx, null, null); await settle() // shave: issue
    bot.entity.position = pos(3, 64, 0)
    flat(bot, ctx, null, null); await settle() // arrived: dig flight
    assert.deepEqual(bot.calls.equips, ['iron_pickaxe'], 'tool equipped before the dig')
    assert.equal(bot.calls.digs.length, 1)
  })

  it('liquidNear reports face-neighbour water and lava', () => {
    const world = makeWorld({})
    world.set(2, 64, 0, 'water')
    world.set(0, 64, 0, 'lava')
    const bot = mockBot(world, {})
    assert.equal(liquidNear(bot, 1, 64, 0), 'water')
    assert.equal(liquidNear(bot, -1, 64, 0), 'lava')
    assert.equal(liquidNear(bot, 10, 64, 10), null)
  })

  it('keeps a bump banked by water or lava', async () => {
    const world = makeWorld({})
    world.set(1, 64, 0, 'dirt')
    world.set(2, 64, 0, 'water')
    const bot = mockBot(world, { items: [] })
    const ctx = { lastGoalKey: '', flat: startEpisode(0, 0, 4, 74, 'P') }
    for (let i = 0; i < 20 && ctx.flat; i++) {
      const f = ctx.flat
      if (f.phase === 'shave' && f.bumps.length > 0) bot.entity.position = pos(3, 64, 0)
      flat(bot, ctx, null, null); await settle()
    }
    assert.equal(ctx.flat, null)
    assert.equal(world.blockAt({ x: 1, y: 64, z: 0 }).name, 'dirt', 'bank not dug')
    assert.ok(bot.chats.some((c) => c.includes('skipped 1: 1 water')), bot.chats.join('\n'))

    const world2 = makeWorld({})
    world2.set(1, 64, 0, 'dirt')
    world2.set(1, 64, 1, 'lava')
    const bot2 = mockBot(world2, { items: [] })
    const ctx2 = { lastGoalKey: '', flat: startEpisode(0, 0, 4, 74, 'P') }
    for (let i = 0; i < 20 && ctx2.flat; i++) {
      const f = ctx2.flat
      if (f.phase === 'shave' && f.bumps.length > 0) bot2.entity.position = pos(3, 64, 0)
      flat(bot2, ctx2, null, null); await settle()
    }
    assert.equal(ctx2.flat, null)
    assert.ok(bot2.chats.some((c) => c.includes('skipped 1: 1 lava')), bot2.chats.join('\n'))
  })

  it('falls through to shaving when fill runs out of blocks', async () => {
    const world = makeWorld({})
    world.set(1, 63, 0, 'air') // hole, no blocks, no dirt registry
    world.set(2, 64, 0, 'dirt') // bump shaved anyway
    const bot = mockBot(world, { items: [] })
    const ctx = { lastGoalKey: '', flat: startEpisode(0, 0, 4, 74, 'P') }
    flat(bot, ctx, null, null); await settle() // scan
    flat(bot, ctx, null, null); await settle() // fill: issue
    bot.entity.position = pos(3, 64, 0)
    flat(bot, ctx, null, null); await settle() // arrived, no item -> dig
    assert.equal(ctx.flat.phase, 'dig')
    flat(bot, ctx, null, null); await settle() // dig: no dirt -> shave, not finish
    assert.equal(ctx.flat.phase, 'shave')
    for (let i = 0; i < 40 && ctx.flat; i++) {
      const f = ctx.flat
      if (f.phase === 'shave' && f.bumps.length > 0) {
        const h = f.bumps[0]
        bot.entity.position = pos(h.x + 2, h.y, h.z)
      }
      flat(bot, ctx, null, null); await settle()
    }
    assert.equal(ctx.flat, null)
    assert.equal(world.blockAt({ x: 2, y: 64, z: 0 }).name, 'air', 'bump shaved')
    assert.equal(world.blockAt({ x: 1, y: 63, z: 0 }).name, 'air', 'hole honestly left')
    assert.ok(bot.chats.some((c) => c.includes('1 left (no fill blocks)')), bot.chats.join('\n'))
  })

  it('falls through to shaving when fill stalls', async () => {
    const world = makeWorld({})
    world.set(1, 63, 0, 'air')
    world.set(2, 64, 0, 'dirt')
    const bot = mockBot(world, { items: [{ name: 'dirt', count: 64 }] })
    const ctx = { lastGoalKey: '', flat: startEpisode(0, 0, 4, 74, 'P') }
    flat(bot, ctx, null, null); await settle() // scan
    ctx.flat.ticks = 200
    ctx.flat.lastProgressTick = 0
    flat(bot, ctx, null, null); await settle() // backstop -> shave, not finish
    assert.equal(ctx.flat.phase, 'shave')
    for (let i = 0; i < 40 && ctx.flat; i++) {
      const f = ctx.flat
      if (f.phase === 'shave' && f.bumps.length > 0) {
        const h = f.bumps[0]
        bot.entity.position = pos(h.x + 2, h.y, h.z)
      } else if (f.phase === 'fill' && f.holes.length > 0) {
        bot.entity.position = pos(3, 64, 0)
      }
      flat(bot, ctx, null, null); await settle()
    }
    assert.equal(ctx.flat, null)
    assert.ok(bot.chats.some((c) => c.includes('1 left (stalled)')), bot.chats.join('\n'))
  })
})
