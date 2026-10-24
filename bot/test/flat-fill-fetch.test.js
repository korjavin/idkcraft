'use strict'

// Bead xxmn (confident flat): fill-fetch chain (pack -> near -> wide ->
// bring), the hilltop bump budget, and the flat -> build-here alignment.
// Behaviour ticks against a scripted voxel world, flat-shave.test.js style.

const { describe, it, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const flat = require('../src/behaviours/flat')
const { startEpisode, SHAVE_TICKS, WIDE_DIG_RADIUS, BRING_RANGE, planBring } = flat
const { siteFor, flatAnchorEnd } = require('../src/site')

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

function makeWorld({ surface = 63 } = {}) {
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

function dropFor(name) {
  if (name === 'grass_block') return 'dirt'
  if (name === 'stone') return 'cobblestone'
  if (name === 'deepslate') return 'cobbled_deepslate'
  return name
}

const REGISTRY = {
  blocksByName: {
    dirt: { id: 1 }, grass_block: { id: 2 }, coarse_dirt: { id: 3 },
    stone: { id: 4 }, cobblestone: { id: 5 },
  },
}

// mockBot, flat-shave style, plus an arg-aware findBlocks (matching ids,
// point, maxDistance, count all honored) and an optional home chest window.
function mockBot(world, { items = [], feet = pos(0, 64, 0), players = {}, registry = null, dirtSpots = [], chestItems = null } = {}) {
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
    findBlocks: ({ matching, point, maxDistance, count } = {}) => {
      const byId = {}
      for (const [name, entry] of Object.entries((registry && registry.blocksByName) || {})) byId[entry.id] = name
      const names = new Set((matching || []).map((id) => byId[id]).filter(Boolean))
      const px = point ? point.x : 0
      const py = point ? point.y : 64
      const pz = point ? point.z : 0
      return dirtSpots
        .filter((p) => {
          const b = world.blockAt(p)
          if (!b || !names.has(b.name)) return false
          return Math.hypot(p.x - px, p.y - py, p.z - pz) <= (maxDistance || 0)
        })
        .sort((a, b) => (Math.hypot(a.x - px, a.y - py, a.z - pz) - Math.hypot(b.x - px, b.y - py, b.z - pz)))
        .slice(0, count || 64)
    },
    _moving: false,
    pathfinder: {
      goal: null,
      isMoving: () => bot._moving,
      setGoal: (g) => { calls.goals.push(g); bot.pathfinder.goal = g },
      stop: () => {},
      setMovements: () => {},
    },
    equip: async (item, dest) => { calls.equips.push(item && item.name); bot.held = item && item.name },
    dig: async (b) => {
      calls.digs.push(b.name)
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
    canDigBlock: () => true,
    openChest: chestItems == null ? undefined : async () => ({
      containerItems: () => chestItems,
      withdraw: async (type, metadata, take) => {
        for (const s of chestItems) {
          if (take <= 0) break
          if (!s || !(s.count > 0)) continue
          const n = Math.min(s.count, take)
          s.count -= n
          take -= n
          addItem(items, s.name, n)
        }
      },
      close: () => {},
    }),
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

// Drive flat() with a teleported body. A newly issued pack walk vacuums one
// fill block (proximity pickup during the walk); the bring walk teleports to
// the chest so the withdraw fires.
async function drive(bot, ctx, items, n, chest) {
  const vacuumed = new Set()
  for (let i = 0; i < n && ctx.flat; i++) {
    const f = ctx.flat
    if (f.phase === 'fill' && f.holes.length > 0) {
      const h = f.holes[0]
      bot.entity.position = pos(h.x + 2, 64, h.z)
    } else if (f.phase === 'shave' && f.bumps.length > 0) {
      const h = f.bumps[0]
      bot.entity.position = pos(h.x + 2, h.y, h.z)
    } else if (f.phase === 'dig' && ctx.lastGoalKey.startsWith('flat-bring:') && chest) {
      bot.entity.position = pos(chest.x - 2, chest.y + 1, chest.z)
    }
    flat(bot, ctx, null, null)
    await settle()
    if (ctx.flat && ctx.flat.phase === 'dig' && ctx.lastGoalKey.startsWith('flat-pack:') && !vacuumed.has(ctx.lastGoalKey)) {
      vacuumed.add(ctx.lastGoalKey)
      addItem(items, 'dirt', 1)
    }
  }
}

describe('xxmn fill-fetch: wide restock', () => {
  let cap
  beforeEach(() => { cap = capture() })
  afterEach(() => { cap.release() })

  it('fills holes from stone past the near radius, finishing with left=0', async () => {
    const world = makeWorld({})
    for (let z = -2; z <= 2; z++) world.set(-2, 63, z, 'air') // 5 holes
    // Surface stone, 60+ out: near (48) misses, wide (128) hits. One stone
    // banks one cobble, so the patch holds more than the holes need.
    const spots = []
    for (let x = 60; x <= 65; x++) {
      world.set(x, 63, 0, 'stone')
      spots.push({ x, y: 63, z: 0 })
    }
    const items = []
    const bot = mockBot(world, { items, registry: REGISTRY, dirtSpots: spots })
    const ctx = { lastGoalKey: '', flat: startEpisode(0, 0, 4, 74, 'P') }
    await drive(bot, ctx, items, 600)
    assert.equal(ctx.flat, null, 'episode ends')
    for (let z = -2; z <= 2; z++) {
      // Stone banks cobblestone, and cobblestone is a fill block.
      assert.equal(world.blockAt({ x: -2, y: 63, z }).name, 'cobblestone', `hole ${z} filled`)
    }
    assert.equal(world.blockAt({ x: 60, y: 63, z: 0 }).name, 'air', 'wide stone dug')
    assert.ok(cap.lines.some((l) => l.includes('flat restock round=wide')), cap.lines.join('\n'))
    assert.ok(bot.chats.some((c) => c === 'flat done: filled 5 holes'), bot.chats.join('\n'))
  })

  it('stays honest when no round banks anything', async () => {
    const world = makeWorld({})
    world.set(-2, 63, 0, 'air') // 1 hole
    const items = []
    const bot = mockBot(world, { items }) // no registry, no chest: every round misses
    const ctx = { lastGoalKey: '', flat: startEpisode(0, 0, 4, 74, 'P') }
    await drive(bot, ctx, items, 200)
    assert.equal(ctx.flat, null, 'episode ends')
    assert.equal(world.blockAt({ x: -2, y: 63, z: 0 }).name, 'air', 'hole stays open')
    assert.ok(bot.chats.some((c) => c === 'flat done: filled 0 holes, 1 left (no fill blocks)'), bot.chats.join('\n'))
  })
})

describe('xxmn fill-fetch: pack round', () => {
  let cap
  beforeEach(() => { cap = capture() })
  afterEach(() => { cap.release() })

  it('vacuums littered drops before digging, then ends honestly', async () => {
    const world = makeWorld({})
    for (const z of [-2, -1, 0]) world.set(-2, 63, z, 'air') // 3 holes
    const items = []
    const bot = mockBot(world, { items }) // no registry: dig rounds find nothing
    const ctx = { lastGoalKey: '', flat: startEpisode(0, 0, 4, 74, 'P') }
    ctx.flat.litter = [
      { k: '5,63,5', x: 5, y: 63, z: 5 },
      { k: '6,63,5', x: 6, y: 63, z: 5 },
    ]
    await drive(bot, ctx, items, 300)
    assert.equal(ctx.flat, null, 'episode ends')
    // No registry: no dirt was ever dug, so every GoalBlock walk is a pack walk.
    const walks = bot.calls.goals.filter((g) => g && g.constructor && g.constructor.name === 'GoalBlock')
    assert.deepEqual(
      walks.map((g) => `${g.x},${g.y},${g.z}`).sort(),
      ['5,63,5', '6,63,5'], 'pack walks both litter cells, digs nothing')
    assert.equal(bot.calls.digs.length, 0, 'no restock dig ran')
    const filled = [-2, -1, 0].filter((z) => world.blockAt({ x: -2, y: 63, z }).name === 'dirt')
    assert.equal(filled.length, 2, '2 vacuumed drops fill 2 holes')
    assert.ok(bot.chats.some((c) => c === 'flat done: filled 2 holes, 1 left (no fill blocks)'), bot.chats.join('\n'))
  })

  it('timed-out shave pickups are remembered as litter', async () => {
    const world = makeWorld({})
    world.set(1, 64, 0, 'dirt')
    const bot = mockBot(world, { items: [] })
    const f = startEpisode(0, 0, 4, 74, 'P')
    f.phase = 'shave'
    f.level = 63
    f.bumps = [{ x: 1, z: 0, topY: 64, y: 64, att: 0, def: 0, occ: 0, stalls: 0, lastPos: null, gateY: null, pickup: { x: 1, y: 64, z: 0 } }]
    const ctx = { lastGoalKey: '', flat: f }
    bot.entity.position = pos(3, 64, 0)
    flat(bot, ctx, null, null) // pickup: issue GoalBlock
    await settle()
    bot._moving = true // wedged: the walk never progresses
    for (let i = 0; i < 10 && ctx.flat; i++) { flat(bot, ctx, null, null); await settle() }
    assert.deepEqual(f.litter.map((c) => c.k), ['1,64,0'], 'drop cell remembered')
  })
})

describe('xxmn fill-fetch: bring round', () => {
  let cap
  beforeEach(() => { cap = capture() })
  afterEach(() => { cap.release() })

  it('fetches fill from a close home chest and finishes with left=0', async () => {
    const world = makeWorld({})
    for (let z = -2; z <= 1; z++) world.set(-2, 63, z, 'air') // 4 holes
    world.set(30, 63, 0, 'chest')
    const items = []
    const chestItems = [{ name: 'dirt', type: 1, metadata: 0, count: 10 }]
    const bot = mockBot(world, { items, chestItems })
    const chest = { x: 30, y: 63, z: 0 }
    const ctx = { lastGoalKey: '', flat: startEpisode(0, 0, 4, 74, 'P'), home: { chest } }
    await drive(bot, ctx, items, 400, chest)
    assert.equal(ctx.flat, null, 'episode ends')
    for (let z = -2; z <= 1; z++) {
      assert.equal(world.blockAt({ x: -2, y: 63, z }).name, 'dirt', `hole ${z} filled`)
    }
    assert.ok(cap.lines.some((l) => l.includes('flat bring got=10')), cap.lines.join('\n'))
    assert.ok(bot.chats.some((c) => c === 'flat done: filled 4 holes'), bot.chats.join('\n'))
  })

  it('skips the bring honestly when the chest is too far', async () => {
    const world = makeWorld({})
    world.set(-2, 63, 0, 'air')
    const items = []
    const chestItems = [{ name: 'dirt', type: 1, metadata: 0, count: 64 }]
    const bot = mockBot(world, { items, chestItems })
    const far = { x: 500, y: 63, z: 0 }
    const ctx = { lastGoalKey: '', flat: startEpisode(0, 0, 4, 74, 'P'), home: { chest: far } }
    await drive(bot, ctx, items, 200, far)
    assert.equal(ctx.flat, null, 'episode ends')
    assert.ok(cap.lines.some((l) => l.includes('flat bring skipped') && l.includes('away')), cap.lines.join('\n'))
    assert.ok(bot.chats.some((c) => c === 'flat done: filled 0 holes, 1 left (no fill blocks)'), bot.chats.join('\n'))
  })

  it('planBring gates chest, access and range', () => {
    const bot = mockBot(makeWorld({}), {})
    delete bot.openChest
    const bp = pos(0, 64, 0)
    assert.deepEqual(planBring(bot, {}, null, bp).ok, false, 'no home chest')
    assert.deepEqual(planBring(bot, { home: { chest: { x: 1, y: 63, z: 0 } } }, null, bp).ok, false, 'no chest access')
    const bot2 = mockBot(makeWorld({}), { chestItems: [] })
    const near = planBring(bot2, { home: { chest: { x: 10, y: 63, z: 0 } } }, null, bp)
    assert.equal(near.ok, true, 'close chest plans')
    const far = planBring(bot2, { home: { chest: { x: 500, y: 63, z: 0 } } }, null, bp)
    assert.equal(far.ok, false, 'far chest skips')
    assert.ok(BRING_RANGE > 0 && WIDE_DIG_RADIUS > 0, 'round constants exported')
  })
})

describe('xxmn bump budget', () => {
  let cap
  beforeEach(() => { cap = capture() })
  afterEach(() => { cap.release() })

  it('stops a hilltop with the middle flat, edges skipped as budget', async () => {
    const world = makeWorld({})
    world.set(0, 64, 0, 'dirt') // middle bumps: shaved first (nearest-first queue)
    world.set(1, 64, 0, 'dirt')
    for (const [x, z] of [[-4, -4], [4, -4], [-4, 4], [4, 4], [-4, 0], [4, 0]]) {
      world.set(x, 64, z, 'dirt') // far edges: budget-skipped
    }
    const items = []
    const bot = mockBot(world, { items })
    const ctx = { lastGoalKey: '', flat: startEpisode(0, 0, 4, 74, 'P') }
    for (let i = 0; i < 120 && ctx.flat && ctx.flat.shaved < 2; i++) {
      const f = ctx.flat
      if (f.phase === 'shave' && f.bumps.length > 0) {
        const h = f.bumps[0]
        bot.entity.position = pos(h.x + 2, h.y, h.z)
      }
      flat(bot, ctx, null, null)
      await settle()
    }
    assert.equal(ctx.flat && ctx.flat.shaved, 2, 'middle shaved before the budget trips')
    ctx.flat.shaveTicks = SHAVE_TICKS // fast-forward the clock: hilltop scale
    await drive(bot, ctx, items, 200)
    assert.equal(ctx.flat, null, 'episode ends')
    assert.equal(world.blockAt({ x: 0, y: 64, z: 0 }).name, 'air', 'middle flat')
    assert.equal(world.blockAt({ x: 1, y: 64, z: 0 }).name, 'air', 'middle flat')
    assert.equal(world.blockAt({ x: 4, y: 64, z: 4 }).name, 'dirt', 'far edge kept')
    assert.ok(bot.chats.some((c) => c.includes('skipped 6: 6 budget')), bot.chats.join('\n'))
    assert.ok(cap.lines.some((l) => l.includes('flat bump budget')), cap.lines.join('\n'))
  })
})

describe('xxmn flat -> build-here alignment', () => {
  let cap
  beforeEach(() => { cap = capture() })
  afterEach(() => { cap.release() })

  it('a standing house keeps its columns but still leaves a buildable site', async () => {
    const world = makeWorld({})
    for (const z of [-1, 0, 1]) world.set(3, 64, z, 'oak_planks') // house wall inside the square
    const items = [{ name: 'dirt', count: 64 }]
    const bot = mockBot(world, { items })
    const ctx = { lastGoalKey: '', flat: startEpisode(0, 0, 4, 74, 'P') }
    await drive(bot, ctx, items, 120)
    assert.equal(ctx.flat, null, 'episode ends honestly, no loop')
    assert.equal(world.blockAt({ x: 3, y: 64, z: 0 }).name, 'oak_planks', 'house untouched')
    assert.ok(bot.chats.some((c) => c.includes('kept by oak_planks')), bot.chats.join('\n'))
    const fe = ctx.flatEnd
    assert.equal(fe && fe.outcome, 'done')
    assert.equal(fe.left, 0, 'nothing queued')
    // The protocol: build-here prefers the flat anchor, and a footprint fits.
    const anchor = flatAnchorEnd(fe, false, { x: 0, y: 64, z: 0 }, Date.now())
    assert.ok(anchor, 'fresh flatEnd near the speaker yields the anchor')
    assert.deepEqual([anchor.x, anchor.z], [fe.cx, fe.cz])
    assert.ok(siteFor(bot, anchor), 'a 7x6 footprint fits beside the kept house')
  })

  it('flatAnchorEnd gates running, freshness and distance', () => {
    const now = Date.now()
    const fe = { outcome: 'done', at: now, cx: 10, cz: 20, r: 8, level: 63, left: 0, skipped: {} }
    assert.deepEqual(
      flatAnchorEnd(fe, false, { x: 12, y: 64, z: 22 }, now),
      { x: 10, y: 63, z: 20 }, 'fresh + near: the anchor, at the flat level')
    assert.equal(flatAnchorEnd(fe, true, { x: 12, y: 64, z: 22 }, now), null, 'running flat: null')
    assert.equal(flatAnchorEnd(fe, false, { x: 12, y: 64, z: 22 }, now + 11 * 60 * 1000), null, 'stale: null')
    assert.equal(flatAnchorEnd(fe, false, { x: 200, y: 64, z: 200 }, now), null, 'far speaker: null')
    assert.equal(flatAnchorEnd(null, false, { x: 12, y: 64, z: 22 }, now), null, 'no flatEnd: null')
    assert.equal(flatAnchorEnd({ outcome: 'done', at: now }, false, { x: 12, y: 64, z: 22 }, now), null, 'anchorless: null')
  })
})
