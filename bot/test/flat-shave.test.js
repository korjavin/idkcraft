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
  threatenedSelf, threatenedByPlayer, resumeLine, startEpisode, liquidNear, buildSweep,
  recheckKept, shiftBumpDone,
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

  it('scan phase says still scanning, not 0 left', () => {
    const f = startEpisode(0, 0, 4, 74, 'P')
    assert.match(resumeLine(f), /still scanning 9x9/)
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

  it('logs refused digs with coordinates to the console', async () => {
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
    assert.ok(cap.lines.some((l) => l.includes('flat refused-dig 1,64,0') && l.includes('err=interrupted')),
      cap.lines.join('\n'))
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
    flat(bot, ctx, null, null); await settle() // dig: pack round empty -> near
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
    const keys = []
    let lastKey = ''
    let onTicks = 0
    for (let i = 0; i < 300 && ctx.flat; i++) {
      const f = ctx.flat
      if (f.phase === 'shave' && f.bumps.length > 0) {
        const h = f.bumps[0]
        // The pickup walk ends with feet inside the dug cell; the sidestep
        // then takes 3 ticks per level. The body stays put while threatened
        // so the self-threat branch really runs (round-2 core-2).
        const key = h.pickup ? `p${h.x},${h.y}` : `s${h.x},${h.y}`
        if (h.pickup || key !== lastKey || onTicks < 3) {
          if (key !== lastKey) { lastKey = key; onTicks = 0 } else onTicks++
          bot.entity.position = pos(h.x, h.y, h.z)
        } else {
          bot.entity.position = pos(h.x + 2, h.y, h.z)
        }
      }
      flat(bot, ctx, null, null); await settle()
      keys.push(ctx.lastGoalKey)
    }
    assert.equal(ctx.flat, null, 'tall column completes, not skipped occupied')
    for (let y = 64; y <= 71; y++) {
      assert.equal(world.blockAt({ x: 1, y, z: 0 }).name, 'air', `level ${y} dug`)
    }
    const sideKeys = keys.filter((k) => k && k.startsWith('flat-shave-side:'))
    assert.ok(sideKeys.length > 0, 'sidesteps really issued')
    for (const k of sideKeys) {
      assert.match(k, /^flat-shave-side:-?\d+,-?\d+,-?\d+$/, `stable key without counter: ${k}`)
    }
    assert.ok(bot.chats.some((c) => c.includes('shaved 1 bump')), bot.chats.join('\n'))
  })

  it('skips the pickup walk for drops out of jump reach', async () => {
    const world = makeWorld({})
    world.set(1, 66, 0, 'dirt')
    const bot = mockBot(world, { items: [] })
    const ctx = { lastGoalKey: '', flat: startEpisode(0, 0, 4, 74, 'P') }
    flat(bot, ctx, null, null); await settle() // scan
    flat(bot, ctx, null, null); await settle() // shave: issue
    bot.entity.position = pos(3, 64, 0) // feet 2 below the dig
    flat(bot, ctx, null, null); await settle() // arrived: dig flight
    assert.ok(ctx.flat.bumps[0].pickup, 'pickup queued')
    flat(bot, ctx, null, null); await settle() // pickup skipped, no walk goal
    assert.equal(ctx.flat.bumps[0].pickup, null)
    const pickupGoals = bot.calls.goals.filter((g) => g && g.constructor && g.constructor.name === 'GoalNear' && g.x === 1 && g.z === 0)
    assert.equal(pickupGoals.length, 1, 'only the approach goal, no pickup tower walk')
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

  // x3y6.4: out of fill -> own bumps first (their drops are fill), restock only with no bumps left.
  async function driveFill(bot, ctx, n, onTick) {
    for (let i = 0; i < n && ctx.flat; i++) {
      const f = ctx.flat
      if (f.phase === 'fill' && f.holes.length > 0) bot.entity.position = pos(f.holes[0].x + 2, 64, f.holes[0].z)
      else if (f.phase === 'shave' && f.bumps.length > 0) bot.entity.position = pos(f.bumps[0].x + 2, f.bumps[0].y, f.bumps[0].z)
      flat(bot, ctx, null, null); await settle()
      if (onTick && ctx.flat) onTick(ctx.flat)
    }
  }

  it('x3y6.4: out of fill shaves own bumps first, fills with the drops, then finishes as before', async () => {
    const world = makeWorld({})
    for (let z = -2; z <= 2; z++) world.set(-2, 63, z, 'air') // 5 holes
    for (const z of [-2, 0, 2]) world.set(2, 64, z, 'dirt') // 3 dirt bumps
    const bot = mockBot(world, { items: [] }) // no dirt registry: a restock finds nothing
    const ctx = { lastGoalKey: '', flat: startEpisode(0, 0, 4, 74, 'P') }
    const phases = []
    await driveFill(bot, ctx, 120, (f) => { if (phases[phases.length - 1] !== f.phase) phases.push(f.phase) })
    assert.equal(ctx.flat, null)
    assert.equal(phases[phases.indexOf('shave') - 1], 'fill', 'shave straight from fill: no restock walk first')
    const shaveAt = bot.chats.indexOf('out of fill blocks, shaving 3 bumps first')
    assert.ok(shaveAt >= 0, bot.chats.join('\n'))
    assert.ok(bot.chats.indexOf('out of fill blocks, digging dirt') > shaveAt, 'restock only once bumps are gone')
    for (const z of [-2, 0, 2]) assert.equal(world.blockAt({ x: 2, y: 64, z }).name, 'air', 'bump shaved')
    assert.equal([-2, -1, 0, 1, 2].filter((z) => world.blockAt({ x: -2, y: 63, z }).name === 'dirt').length, 3, '3 drops fill 3 holes')
    assert.ok(bot.chats.some((c) => c.includes('shaved 3 bumps, 2 left (no fill blocks)')), bot.chats.join('\n'))
  })

  it('x3y6.4: fill resumes at FILL_RESUME blocks with bumps still left', async () => {
    const world = makeWorld({})
    world.set(-2, 63, 0, 'air')
    for (let y = 64; y <= 72; y++) { world.set(2, y, 0, 'dirt'); world.set(2, y, 2, 'dirt') } // 18 drops
    world.set(2, 64, -2, 'dirt')
    const bot = mockBot(world, { items: [] })
    const ctx = { lastGoalKey: '', flat: startEpisode(0, 0, 4, 74, 'P') }
    let resumed = null
    let prev = null
    await driveFill(bot, ctx, 200, (f) => {
      if (prev === 'shave' && f.phase === 'fill' && !resumed) resumed = { have: flat.countFill(bot), bumps: f.bumps.length }
      prev = f.phase
    })
    assert.ok(resumed, 'went back to fill')
    assert.ok(resumed.have >= 16 && resumed.bumps >= 1, JSON.stringify(resumed))
    assert.equal(ctx.flat, null)
    assert.equal(world.blockAt({ x: -2, y: 63, z: 0 }).name, 'dirt', 'hole filled')
    assert.equal(world.blockAt({ x: 2, y: 64, z: -2 }).name, 'air', 'the rest shaved after the holes')
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

describe('sweep leftover scaffold (idkcraft-7wt)', () => {
  let cap
  beforeEach(() => { cap = capture() })
  afterEach(() => { cap.release() })

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
    return { bot, ctx }
  }

  function sweepF(world, stepped, bumpCols) {
    const bot = mockBot(world, { items: [{ name: 'dirt', count: 64 }] })
    const f = startEpisode(0, 0, 4, 74, 'P')
    f.phase = 'shave'
    f.level = 63
    f.stepped = new Set(stepped)
    f.bumpCols = new Set(bumpCols)
    f.bumps = []
    f.sweepTotal = 0
    return { bot, f }
  }

  it('queues stepped dirt above the level', () => {
    const world = makeWorld({})
    world.set(3, 64, 0, 'dirt') // mid-episode nub, never scanned
    const { bot, f } = sweepF(world, ['3,0'], [])
    assert.equal(buildSweep(bot, f), true)
    assert.equal(f.bumps.length, 1)
    assert.equal(f.bumps[0].x, 3)
    assert.equal(f.bumps[0].topY, 64)
    assert.equal(f.bumps[0].sweep, true)
    assert.equal(f.sweepTotal, 1)
  })

  it('skips original-bump columns (shaved, kept or refused already)', () => {
    const world = makeWorld({})
    world.set(3, 64, 0, 'dirt') // kept-bump remnant: never re-queued
    const { bot, f } = sweepF(world, ['3,0'], ['3,0'])
    assert.equal(buildSweep(bot, f), false)
    assert.equal(f.bumps.length, 0)
  })

  it('skips non-scaffold mats and at-level dirt', () => {
    const world = makeWorld({})
    world.set(3, 64, 0, 'stone') // player build, not ours
    world.set(4, 63, 0, 'dirt') // at the level, not above it
    const { bot, f } = sweepF(world, ['3,0', '4,0'], [])
    assert.equal(buildSweep(bot, f), false)
    assert.equal(f.bumps.length, 0)
  })

  it('swarm (lhg2): skips stepped columns in another bot\'s strip', () => {
    const world = makeWorld({})
    world.set(3, 64, 0, 'dirt') // x=3 is strip 1 of 2 on the 9-wide square
    world.set(-3, 64, 0, 'dirt') // x=-3 is strip 0: ours
    const { bot, f } = sweepF(world, ['3,0', '-3,0'], [])
    f.tile = { i: 0, n: 2 }
    assert.equal(buildSweep(bot, f), true)
    assert.deepEqual(f.bumps.map((b) => b.x), [-3])
  })

  it('skips stepped columns outside the square', () => {
    const world = makeWorld({})
    world.set(9, 64, 0, 'dirt')
    const { bot, f } = sweepF(world, ['9,0'], [])
    assert.equal(buildSweep(bot, f), false)
    assert.equal(f.bumps.length, 0)
  })

  it('sweeps a mid-run nub end to end and reports it', async () => {
    const world = makeWorld({})
    world.set(1, 63, 0, 'air') // one hole: the bot steps (3,0) working it
    const { bot, ctx } = started(world)
    flat(bot, ctx, null, null); await settle() // scan
    assert.equal(ctx.flat.phase, 'fill')
    world.set(3, 64, 0, 'dirt') // nub appears mid-episode, never scanned
    for (let i = 0; i < 40 && ctx.flat; i++) {
      const f = ctx.flat
      if (f.phase === 'fill' && f.holes.length > 0) {
        const h = f.holes[0]
        bot.entity.position = pos(h.x + 2, 64, h.z)
      } else if (f.phase === 'shave' && f.bumps.length > 0) {
        const h = f.bumps[0]
        bot.entity.position = pos(h.x + 2, h.y, h.z)
      }
      flat(bot, ctx, null, null); await settle()
    }
    assert.equal(ctx.flat, null, 'episode ends')
    assert.equal(world.blockAt({ x: 3, y: 64, z: 0 }).name, 'air', 'nub swept')
    assert.ok(bot.chats.some((c) => c.includes('swept 1 leftover')), bot.chats.join('\n'))
  })

  it('skips an unreachable tall remnant honestly instead of hanging', async () => {
    const world = makeWorld({})
    world.set(1, 63, 0, 'air')
    const { bot, ctx } = started(world)
    flat(bot, ctx, null, null); await settle() // scan
    for (let y = 64; y <= 71; y++) world.set(3, y, 0, 'dirt') // 8-high tower
    for (let i = 0; i < 60 && ctx.flat; i++) {
      const f = ctx.flat
      // Body pinned at the level: the tower top stays out of dig reach.
      if (f.phase === 'fill' && f.holes.length > 0) {
        const h = f.holes[0]
        bot.entity.position = pos(h.x + 2, 64, h.z)
      }
      flat(bot, ctx, null, null); await settle()
    }
    assert.equal(ctx.flat, null, 'episode ends, no loop')
    assert.ok(bot.chats.some((c) => c.includes('unreachable')), bot.chats.join('\n'))
  })

  it('sweeps a cobble leftover after a real shave phase (shave exit)', async () => {
    const world = makeWorld({})
    world.set(1, 64, 0, 'dirt') // one original bump: shave phase runs
    const { bot, ctx } = started(world)
    flat(bot, ctx, null, null); await settle() // scan
    assert.equal(ctx.flat.phase, 'shave')
    // Recover pillars cobble mid-episode on a stepped column (never scanned).
    world.set(3, 64, 0, 'cobblestone')
    ctx.placedByBot = new Set(['3,64,0']) // recover pillar: bot-placed, sweepable (drq)
    ctx.flat.stepped.add('3,0')
    await drive(bot, ctx, 60)
    assert.equal(ctx.flat, null, 'episode ends')
    assert.equal(world.blockAt({ x: 1, y: 64, z: 0 }).name, 'air', 'bump shaved')
    assert.equal(world.blockAt({ x: 3, y: 64, z: 0 }).name, 'air', 'cobble swept')
    assert.ok(bot.chats.some((c) => c.includes('shaved 1 bump') && c.includes('swept 1 leftover')), bot.chats.join('\n'))
  })

  it('leaves a foreign cobble wall in stepped columns (drq protected)', async () => {
    const world = makeWorld({})
    world.set(1, 64, 0, 'dirt') // one original bump: shave phase runs
    const { bot, ctx } = started(world)
    flat(bot, ctx, null, null); await settle() // scan
    assert.equal(ctx.flat.phase, 'shave')
    // Foreign cobble mid-episode on a stepped column (never scanned), and
    // NOT in ctx.placedByBot: the sweep queues it, the guard keeps it. It
    // touches more cobble, so it is a wall, not a lone pillar (vewo.7).
    world.set(3, 64, 0, 'cobblestone')
    world.set(3, 64, 1, 'cobblestone')
    ctx.flat.stepped.add('3,0')
    await drive(bot, ctx, 60)
    assert.equal(ctx.flat, null, 'episode ends')
    assert.equal(world.blockAt({ x: 1, y: 64, z: 0 }).name, 'air', 'dirt bump shaved')
    assert.equal(world.blockAt({ x: 3, y: 64, z: 0 }).name, 'cobblestone', 'foreign cobble kept')
  })
})

describe('lone pillars are shaved (idkcraft-vewo.7)', () => {
  let cap
  beforeEach(() => { cap = capture() })
  afterEach(() => { cap.release() })

  async function drive(bot, ctx, n) {
    for (let i = 0; i < n && ctx.flat; i++) {
      const f = ctx.flat
      if (f.phase === 'shave' && f.bumps.length > 0) {
        const h = f.bumps[0]
        bot.entity.position = pos(h.x + 2, h.y, h.z)
      }
      flat(bot, ctx, null, null)
      await settle()
    }
  }

  function run(world, tile = null) {
    const bot = mockBot(world, { items: [{ name: 'dirt', count: 64 }] })
    const ctx = { lastGoalKey: '', flat: startEpisode(0, 0, 4, 74, 'P', tile) }
    return { bot, ctx }
  }

  function column(world, x, z, h, name = 'cobblestone') {
    for (let y = 64; y < 64 + h; y++) world.set(x, y, z, name)
  }

  for (const h of [1, 2, 3, 4, 5]) {
    it(`shaves a free-standing ${h}-high cobble pillar to the level (not bot-placed)`, async () => {
      const world = makeWorld({})
      column(world, 2, 1, h)
      const { bot, ctx } = run(world)
      await drive(bot, ctx, 40 + 10 * h)
      assert.equal(ctx.flat, null, 'episode ends')
      for (let y = 64; y < 64 + h; y++) assert.equal(world.blockAt({ x: 2, y, z: 1 }).name, 'air', `y=${y} dug`)
      assert.equal(world.blockAt({ x: 2, y: 63, z: 1 }).name, 'dirt', 'level ground kept')
    })
  }

  it('our own tower beside a tall pillar does not stop the shave halfway (review core-1)', async () => {
    const world = makeWorld({})
    column(world, 2, 1, 3)
    world.set(3, 64, 1, 'dirt') // pathfinder tower block placed to reach the top
    const { bot, ctx } = run(world)
    ctx.placedByBot = new Set(['3,64,1'])
    ctx.flat.stepped.add('3,1')
    // Body stays on the tower (feet 65): never teleported to the dig height.
    for (let i = 0; i < 80 && ctx.flat; i++) {
      bot.entity.position = pos(3.5, 65, 1.5)
      flat(bot, ctx, null, null)
      await settle()
    }
    assert.equal(ctx.flat, null)
    for (let y = 64; y <= 66; y++) assert.equal(world.blockAt({ x: 2, y, z: 1 }).name, 'air', `y=${y} dug`)
  })

  it('a foreign solid neighbour still makes it a wall', () => {
    const world = makeWorld({})
    world.set(3, 64, 1, 'dirt')
    const bot = mockBot(world)
    assert.equal(flat.lonePillar(bot, {}, 2, 64, 1), false)
    assert.equal(flat.lonePillar(bot, { placedByBot: new Set(['3,64,1']) }, 2, 64, 1), true)
    assert.equal(flat.lonePillar(bot, {}, 2, 65, 1), true)
  })

  it('shaves dirt and cobbled_deepslate pillars too', async () => {
    const world = makeWorld({})
    column(world, 2, 1, 3, 'dirt')
    column(world, -2, -1, 2, 'cobbled_deepslate')
    const { bot, ctx } = run(world)
    await drive(bot, ctx, 80)
    assert.equal(ctx.flat, null)
    assert.equal(world.blockAt({ x: 2, y: 64, z: 1 }).name, 'air')
    assert.equal(world.blockAt({ x: -2, y: 64, z: -1 }).name, 'air')
  })

  it('keeps a 2-wide cobble wall', async () => {
    const world = makeWorld({})
    column(world, 2, 1, 2)
    column(world, 2, 2, 2)
    const { bot, ctx } = run(world)
    await drive(bot, ctx, 60)
    assert.equal(ctx.flat, null)
    assert.equal(world.blockAt({ x: 2, y: 64, z: 1 }).name, 'cobblestone')
    assert.equal(world.blockAt({ x: 2, y: 65, z: 2 }).name, 'cobblestone')
  })

  for (const side of ['oak_planks', 'oak_door', 'torch']) {
    it(`keeps a cobble pillar touching ${side}`, async () => {
      const world = makeWorld({})
      column(world, 2, 1, 2)
      world.set(3, 64, 1, side)
      const { bot, ctx } = run(world)
      await drive(bot, ctx, 60)
      assert.equal(ctx.flat, null)
      assert.equal(world.blockAt({ x: 2, y: 64, z: 1 }).name, 'cobblestone')
      assert.equal(world.blockAt({ x: 2, y: 65, z: 1 }).name, 'cobblestone')
    })
  }

  for (const [where, x] of [['house box', 2], ['house apron', -3]]) {
    it(`keeps a lone cobble/dirt pillar inside the ${where} (house footprint beats the exemption)`, async () => {
      const world = makeWorld({})
      column(world, x, 1, 2)
      column(world, x, -1, 1, 'dirt')
      const { bot, ctx } = run(world)
      // Box case: pillar inside interior x 1..3. Apron case: interior x 0..1,
      // so x=-3 is outside the wall ring but inside the 3-cell apron.
      ctx.home = x === 2
        ? { site: pos(2, 63, -3), interior: { min: pos(1, 64, -2), max: pos(3, 66, 2) } }
        : { site: pos(0, 66, -3), interior: { min: pos(0, 64, -2), max: pos(1, 66, 2) } }
      await drive(bot, ctx, 60)
      assert.equal(ctx.flat, null)
      assert.equal(world.blockAt({ x, y: 64, z: 1 }).name, 'cobblestone')
      assert.equal(world.blockAt({ x, y: 64, z: -1 }).name, 'dirt')
    })
  }

  it('logs and leaves stay kept (unchanged)', async () => {
    const world = makeWorld({})
    column(world, 2, 1, 3, 'oak_log')
    column(world, -2, -1, 1, 'oak_leaves')
    const { bot, ctx } = run(world)
    await drive(bot, ctx, 60)
    assert.equal(ctx.flat, null)
    assert.equal(world.blockAt({ x: 2, y: 66, z: 1 }).name, 'oak_log')
    assert.equal(world.blockAt({ x: -2, y: 64, z: -1 }).name, 'oak_leaves')
  })

  it('swarm strips each shave only their own pillars', async () => {
    const world = makeWorld({})
    column(world, -3, 0, 2) // strip 0 of 2
    column(world, 3, 0, 2) // strip 1 of 2
    const a = run(world, { i: 0, n: 2 })
    await drive(a.bot, a.ctx, 60)
    assert.equal(a.ctx.flat, null)
    assert.equal(world.blockAt({ x: -3, y: 64, z: 0 }).name, 'air', 'strip 0 pillar shaved')
    assert.equal(world.blockAt({ x: 3, y: 64, z: 0 }).name, 'cobblestone', 'strip 1 pillar left to its bot')
    const b = run(world, { i: 1, n: 2 })
    await drive(b.bot, b.ctx, 60)
    assert.equal(b.ctx.flat, null)
    assert.equal(world.blockAt({ x: 3, y: 64, z: 0 }).name, 'air', 'strip 1 pillar shaved')
  })
})

describe('freeze fixes (idkcraft-xtbt)', () => {
  let cap
  beforeEach(() => { cap = capture() })
  afterEach(() => { cap.release() })

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

  it('kept columns name the freezing marker in the finish line', async () => {
    const world = makeWorld({})
    world.set(2, 64, 1, 'dirt') // diggable bump, frozen by the neighbour
    world.set(3, 64, 1, 'oak_planks') // the other bot's build / house wall
    const bot = mockBot(world, { items: [{ name: 'dirt', count: 64 }] })
    const ctx = { lastGoalKey: '', flat: startEpisode(0, 0, 4, 74, 'P') }
    await drive(bot, ctx, 60)
    assert.equal(ctx.flat, null, 'episode ends, no loop')
    assert.equal(world.blockAt({ x: 2, y: 64, z: 1 }).name, 'dirt', 'marked column kept')
    assert.equal(world.blockAt({ x: 3, y: 64, z: 1 }).name, 'oak_planks', 'house untouched')
    assert.ok(bot.chats.some((c) => c.includes('kept by oak_planks')), bot.chats.join('\n'))
  })

  it('recheck frees a kept column once its marker is gone', () => {
    const world = makeWorld({})
    world.set(2, 64, 1, 'dirt') // bump, no marker anymore
    const bot = mockBot(world, { items: [{ name: 'dirt', count: 64 }] })
    const f = startEpisode(0, 0, 4, 74, 'P')
    f.phase = 'shave'
    f.level = 63
    f.bumps = []
    f.keptCols = [{ x: 2, z: 1, marker: 'torch' }]
    f.keptMarkers = { torch: 1 }
    f.skip.kept = 1
    assert.equal(recheckKept(bot, {}, f), true, 'freed column re-queues')
    assert.equal(f.bumps.length, 1)
    assert.equal(f.bumps[0].x, 2)
    assert.equal(f.skip.kept, 0, 're-queued column leaves the kept count')
    assert.deepEqual(f.keptMarkers, {}, 'marker count undone with it')
    assert.equal(recheckKept(bot, {}, f), false, 'one re-check per episode')
  })

  it('recheck leaves a column kept while its marker stands', () => {
    const world = makeWorld({})
    world.set(2, 64, 1, 'dirt')
    world.set(3, 64, 1, 'torch') // marker still there
    const bot = mockBot(world, { items: [{ name: 'dirt', count: 64 }] })
    const f = startEpisode(0, 0, 4, 74, 'P')
    f.phase = 'shave'
    f.level = 63
    f.bumps = []
    f.keptCols = [{ x: 2, z: 1, marker: 'torch' }]
    f.keptMarkers = { torch: 1 }
    f.skip.kept = 1
    assert.equal(recheckKept(bot, {}, f), false, 'nothing freed')
    assert.equal(f.bumps.length, 0)
    assert.equal(f.skip.kept, 1, 'stay-frozen column keeps its count')
    assert.deepEqual(f.keptMarkers, { torch: 1 })
  })

  it('fill clean-completion re-checks shave-for-fill keeps (send-back P1)', () => {
    // startDig sends a fill episode through the shave; keeps recorded
    // there must not bypass the re-check when fill completes.
    const world = makeWorld({})
    world.set(2, 64, 1, 'dirt') // kept column, marker since gone
    const bot = mockBot(world, { items: [{ name: 'dirt', count: 64 }] })
    const ctx = { lastGoalKey: '', flat: null }
    const f = startEpisode(0, 0, 4, 74, 'P')
    ctx.flat = f
    f.phase = 'fill'
    f.level = 63
    f.holes = []
    f.bumps = []
    f.keptCols = [{ x: 2, z: 1, marker: 'torch' }]
    f.keptMarkers = { torch: 1 }
    f.skip.kept = 1
    bot.entity.position = pos(0, 64, 0)
    flat(bot, ctx, null, null)
    assert.ok(ctx.flat, 'fill end re-checks instead of finishing')
    assert.equal(ctx.flat.bumps.length, 1, 'freed column re-queued')
    assert.equal(ctx.flat.bumps[0].x, 2)
    assert.equal(ctx.flat.skip.kept, 0)
    flat(bot, ctx, null, null)
    assert.equal(ctx.flat.phase, 'shave', 're-queued bumps take the body to the shave')
  })

  it('recheck re-frees a sweep-material column after its marker is gone (send-back P2)', () => {
    // A cobble sweep bump frozen by a marker: the re-check must honor
    // the same sweep-material exemption the shave gate does.
    const world = makeWorld({})
    world.set(3, 64, 0, 'cobblestone') // sweep column, marker gone
    world.set(4, 64, 0, 'dirt') // solid neighbour: no lone-pillar exemption
    const bot = mockBot(world, { items: [{ name: 'dirt', count: 64 }] })
    const f = startEpisode(0, 0, 4, 74, 'P')
    f.phase = 'shave'
    f.level = 63
    f.bumps = []
    f.keptCols = [{ x: 3, z: 0, marker: 'torch', sweep: true }]
    f.keptMarkers = { torch: 1 }
    f.skip.kept = 1
    assert.equal(recheckKept(bot, {}, f), true, 'sweep column re-frees')
    assert.equal(f.bumps.length, 1)
    assert.equal(f.bumps[0].sweep, true, 'sweep flag survives the re-check')
    assert.equal(f.skip.kept, 0)
    // Control: the same cobble column WITHOUT the sweep flag stays kept.
    const g = startEpisode(0, 0, 4, 74, 'P')
    g.phase = 'shave'
    g.level = 63
    g.bumps = []
    g.keptCols = [{ x: 3, z: 0, marker: 'torch' }]
    g.keptMarkers = { torch: 1 }
    g.skip.kept = 1
    assert.equal(recheckKept(bot, {}, g), false, 'foreign cobble stays kept')
    assert.equal(g.bumps.length, 0)
    assert.equal(g.skip.kept, 1)
  })

  it('sweep re-runs over newly stepped columns and regrown pillars', () => {
    const world = makeWorld({})
    world.set(3, 64, 0, 'dirt') // mid-episode nub, never scanned
    const bot = mockBot(world, { items: [{ name: 'dirt', count: 64 }] })
    const f = startEpisode(0, 0, 4, 74, 'P')
    f.phase = 'shave'
    f.level = 63
    f.stepped = new Set(['3,0'])
    f.bumpCols = new Set()
    f.bumps = []
    assert.equal(buildSweep(bot, f), true)
    assert.deepEqual(f.bumps.map((b) => b.x), [3])
    assert.equal(buildSweep(bot, f), false, 'same pass offers nothing twice')
    // The sweep bump resolved, then a late pillar lands on a new column.
    f.bumps.shift()
    world.set(3, 64, 0, 'air')
    assert.equal(buildSweep(bot, f), false, 'resolved column stays resolved')
    world.set(4, 64, 0, 'dirt')
    f.stepped.add('4,0')
    assert.equal(buildSweep(bot, f), true, 'late pillar on a new column queues')
    assert.deepEqual(f.bumps.map((b) => b.x), [4])
    // And a pillar regrown taller on an already-swept column re-queues.
    f.bumps.shift()
    world.set(4, 64, 0, 'air')
    world.set(3, 64, 0, 'dirt')
    world.set(3, 65, 0, 'dirt')
    assert.equal(buildSweep(bot, f), true, 'regrown taller pillar re-queues')
    assert.equal(f.bumps[0].topY, 65)
  })

  it('cleared sweep columns are re-offered at the same height, kept ones are not (review P2)', () => {
    const world = makeWorld({})
    world.set(3, 64, 0, 'dirt') // mid-episode scaffold on a stepped column
    const bot = mockBot(world, { items: [{ name: 'dirt', count: 64 }] })
    const f = startEpisode(0, 0, 4, 74, 'P')
    f.phase = 'shave'
    f.level = 63
    f.stepped = new Set(['3,0'])
    f.bumpCols = new Set()
    f.bumps = []
    assert.equal(buildSweep(bot, f), true, 'first scaffold queues')
    shiftBumpDone(f) // the real clear path: shave worked the column to the level
    assert.equal(f.sweptN, 1)
    world.set(3, 64, 0, 'air') // the dig removed it
    assert.equal(buildSweep(bot, f), false, 'cleared column is not re-offered')
    world.set(3, 64, 0, 'dirt') // rebuilt at the SAME height (other bot, recover)
    assert.equal(buildSweep(bot, f), true, 'replacement scaffold re-queues')
    // A kept/refused sweep bump leaves the queue WITHOUT the clear path
    // (shiftBumpSkip drops it, sweptTops stays): never retried.
    f.bumps.shift()
    assert.equal(buildSweep(bot, f), false, 'kept sweep column is not retried')
    world.set(3, 65, 0, 'dirt') // only genuinely taller regrowth re-queues
    assert.equal(buildSweep(bot, f), true)
  })

  it('sweeps the other bot’s lone scaffold pillar (shared square, no placedByBot)', async () => {
    const world = makeWorld({})
    world.set(1, 64, 0, 'dirt') // one original bump: shave phase runs
    const bot = mockBot(world, { items: [{ name: 'dirt', count: 64 }] })
    const ctx = { lastGoalKey: '', flat: startEpisode(0, 0, 4, 74, 'P') }
    flat(bot, ctx, null, null); await settle() // scan
    assert.equal(ctx.flat.phase, 'shave')
    // The other bot's recover pillar: foreign cobble, never in our
    // placedByBot, on a column we stepped. Shape decides (vewo.7), so the
    // sweep owns it on a shared square without cross-bot state.
    world.set(3, 64, 0, 'cobblestone')
    ctx.flat.stepped.add('3,0')
    await drive(bot, ctx, 60)
    assert.equal(ctx.flat, null, 'episode ends')
    assert.equal(world.blockAt({ x: 1, y: 64, z: 0 }).name, 'air', 'bump shaved')
    assert.equal(world.blockAt({ x: 3, y: 64, z: 0 }).name, 'air', 'foreign lone scaffold swept')
    assert.ok(bot.chats.some((c) => c.includes('swept 1 leftover')), bot.chats.join('\n'))
  })
})

describe('place seam: no pathfinder scaffold above the level (idkcraft-3dkn)', () => {
  let cap
  beforeEach(() => { cap = capture() })
  afterEach(() => { cap.release() })

  it('place predicate vetoes above-level cells inside the square only', () => {
    const bot = mockBot(makeWorld({}), {})
    const mov = { exclusionAreasBreak: [], exclusionAreasPlace: [] }
    bot.pathfinder.movements = mov
    const f = startEpisode(0, 0, 4, 74, 'P')
    f.level = 63
    const ctx = { lastGoalKey: 'flat-shave:1,66,0', flat: f }
    flat.guardFlatSurface(bot, ctx)
    assert.equal(mov.exclusionAreasPlace.length, 1)
    const place = (x, y, z) => mov.exclusionAreasPlace[0]({ position: { x, y, z } })
    const brk = (x, y, z) => mov.exclusionAreasBreak[0]({ position: { x, y, z } })
    assert.equal(place(0, 64, 0), 100, 'above level inside: vetoed')
    assert.equal(place(0, 63, 0), 0, 'cap at level: allowed')
    assert.equal(place(0, 62, 0), 0, 'bridge below level: allowed')
    assert.equal(place(20, 64, 0), 0, 'outside the square')
    assert.equal(brk(0, 64, 0), 0, 'break above level still allowed')
    ctx.lastGoalKey = 'bring:1,2,3'
    assert.equal(place(0, 64, 0), 0, 'non-flat goal: guard off')
    ctx.lastGoalKey = 'flat-shave:1,66,0'
    ctx.flat = null
    flat.guardFlatSurface(bot, ctx)
    assert.equal(mov.exclusionAreasPlace.length, 0, 'finish detaches place')
    assert.equal(mov.exclusionAreasBreak.length, 0, 'finish detaches break')
  })

  // Fake pathfinder over the real seam: a goal 2+ above the feet makes it
  // tower (dirt into the feet cell) unless exclusionAreasPlace vetoes the
  // cell; otherwise it steps onto the goal column when that is at most one
  // up or down. The search runs a tick later, like the real one (the goal
  // key is set by then).
  function towerPathfinder(bot, world, mov) {
    bot.pathfinder.movements = mov
    bot.pathfinder.setGoal = (g) => {
      bot.calls.goals.push(g)
      bot.pathfinder.goal = g
      if (!g) return
      setImmediate(() => {
        const p = bot.entity.position
        const fx = Math.floor(p.x)
        const fy = Math.floor(p.y)
        const fz = Math.floor(p.z)
        if ((fx - g.x) ** 2 + (fy - g.y) ** 2 + (fz - g.z) ** 2 <= g.rangeSq) return // GoalNear met
        if (g.y >= fy + 2) {
          const cell = { position: { x: fx, y: fy, z: fz } }
          const cost = mov.exclusionAreasPlace.reduce((s, fn) => s + fn(cell), 0)
          if (cost >= 100) return
          world.set(fx, fy, fz, 'dirt')
          bot.entity.position = pos(fx + 0.5, fy + 1, fz + 0.5)
          return
        }
        // Walk: nearest standable cell (one up/down at most) meeting the goal.
        let best = null
        for (let x = g.x - 3; x <= g.x + 3; x++) {
          for (let z = g.z - 3; z <= g.z + 3; z++) {
            let gy = 70
            while (gy > 60 && world.blockAt({ x, y: gy - 1, z }).name === 'air') gy--
            if (Math.abs(gy - fy) > 1 || (x - g.x) ** 2 + (gy - g.y) ** 2 + (z - g.z) ** 2 > g.rangeSq) continue
            const d = (x - fx) ** 2 + (z - fz) ** 2
            if (!best || d < best.d) best = { x, y: gy, z, d }
          }
        }
        if (best) bot.entity.position = pos(best.x + 0.5, best.y, best.z + 0.5)
      })
    }
  }

  it('a 3-high bump next to a shaved bump leaves no scaffold, each cell dug once', async () => {
    const world = makeWorld({})
    world.set(2, 64, 0, 'dirt') // 1-high bump, shaved first (nearest)
    world.set(1, 64, 0, 'dirt') // 3-high bump beside it
    world.set(1, 65, 0, 'dirt')
    world.set(1, 66, 0, 'dirt')
    const bot = mockBot(world, { items: [{ name: 'dirt', count: 64 }], feet: pos(3.5, 64, 0.5) })
    towerPathfinder(bot, world, { exclusionAreasBreak: [], exclusionAreasPlace: [] })
    const ctx = { lastGoalKey: '', flat: startEpisode(0, 0, 4, 74, 'P') }
    for (let i = 0; i < 120 && ctx.flat; i++) {
      flat(bot, ctx, null, null)
      await settle()
    }
    assert.equal(ctx.flat, null, 'episode ends')
    const digs = cap.lines.filter((l) => l.startsWith('flat dig '))
    assert.equal(digs.length, 4, cap.lines.join('\n'))
    assert.equal(new Set(digs).size, digs.length, `no cell dug twice:\n${digs.join('\n')}`)
    for (let x = -4; x <= 4; x++) {
      for (let z = -4; z <= 4; z++) {
        for (let y = 64; y <= 68; y++) {
          assert.equal(world.blockAt({ x, y, z }).name, 'air', `nothing above the level at ${x},${y},${z}`)
        }
      }
    }
    assert.ok(bot.chats.some((c) => c.startsWith('flat done:') && c.includes('shaved 2 bumps')), bot.chats.join('\n'))
  })
})
