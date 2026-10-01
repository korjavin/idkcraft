'use strict'

// Bring walk gate (idkcraft-8w0): the verdict hiked to deep-cave exposed
// veins — a 90-deep hike quoted 140 s and timed out the 600 s order on
// master, because the linear 1.5 s/block vertical still underpriced deep
// descents (atl.21 fixed the S2 direction, not the rate). The vertical is
// two-rate now (cave rate past the knee), and descents past maxWalkDescent
// are no-hike: the verdict digs, walks legs, or refuses instead. Mock style
// mirrors bring-chv.test.js.

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const bring = require('../src/behaviours/bring')
const {
  liveExposed, buriedCand, memoryExposed, decideBringSource, SOURCE_COST,
} = require('../src/behaviours/bring')
const { handleChat, createTicker } = require('../src/index')

function pos(x, y, z) {
  const p = {
    x, y, z,
    distanceTo: (q) => Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z),
    clone() { return pos(p.x, p.y, p.z) },
  }
  return p
}

const BLOCKS = { coal_ore: 11, stone: 1, iron_ore: 31, gold_ore: 32 }
const ITEMS = { coal: 21, raw_iron: 25, stone_pickaxe: 22, iron_pickaxe: 24 }
const PICK = [{ name: 'stone_pickaxe', count: 1 }]

function mockBot({ spots = [], names = {}, items = [], playerPos = null, spawnPoint = null } = {}) {
  const lines = []
  const tossCalls = []
  const calls = { setGoal: 0, goals: [] }
  const blocksByName = {}
  for (const [name, id] of Object.entries(BLOCKS)) blocksByName[name] = { id }
  const itemsByName = {}
  for (const [name, id] of Object.entries(ITEMS)) itemsByName[name] = { id }
  const bot = {
    lines, tossCalls, calls,
    username: 'IdkBot',
    entities: {},
    health: 20,
    food: 20,
    entity: { position: pos(0, 64, 0), onGround: true },
    registry: { blocksByName, itemsByName },
    players: { P: { username: 'P', entity: playerPos ? { position: playerPos } : null } },
    _moving: false,
    _items: items,
    digCalls: 0,
    pathfinder: {
      goal: null,
      setGoal: (goal) => { calls.setGoal++; calls.goals.push(goal); bot.pathfinder.goal = goal },
      isMoving: () => bot._moving,
      bestHarvestTool: () => ({ name: 'stone_pickaxe', type: 99 }),
    },
    held: null,
    equip: async (item) => { bot.held = item && item.name },
    inventory: { items: () => bot._items },
    findBlocks(opts) {
      const want = new Set(Array.isArray(opts.matching) ? opts.matching : [opts.matching])
      return spots.filter((q) => {
        const n = names[`${q.x},${q.y},${q.z}`]
        const id = n && blocksByName[n] ? blocksByName[n].id : undefined
        return want.has(id)
      })
    },
    blockAt(p) {
      const n = names[`${p.x},${p.y},${p.z}`]
      return n ? { name: n, position: pos(p.x, p.y, p.z) } : null
    },
    canDigBlock: () => true,
    dig: async () => { bot.digCalls++ },
    toss: async (id, meta, n) => { tossCalls.push([id, meta, n]) },
    chat(line) { lines.push(String(line)) },
  }
  if (spawnPoint) bot.spawnPoint = spawnPoint
  return bot
}

function tickerFor(bot, brain) {
  return createTicker({
    bot,
    brain: brain || { decide: async () => ({ action: 'idle', sprint: false, source: 'stub' }) },
    tickMs: 10,
    idleTickMs: 10,
  })
}

function countingBrain(answer) {
  const seen = []
  return {
    seen,
    brain: {
      source: 'testmodel',
      decide: async () => ({ action: 'idle', sprint: false, source: 'stub' }),
      ask: async (q) => { seen.push(q); return answer },
    },
  }
}

function seedMemory(ctx, x, y, z, name, opts = {}) {
  if (!ctx.resources) ctx.resources = { items: new Map() }
  const item = { x, y, z, name, at: opts.at ?? Date.now() - 5 * 60000 }
  if (!('exposed' in opts)) item.exposed = true
  else if (opts.exposed !== undefined) item.exposed = opts.exposed
  ctx.resources.items.set(`${x},${y},${z}`, item)
}

function centerAware(bot) {
  const inner = bot.findBlocks.bind(bot)
  bot.findBlocks = (o) => {
    const c = o.point || { x: 0, y: 64, z: 0 }
    return inner(o).filter((q) => Math.hypot(q.x - c.x, q.y - c.y, q.z - c.z) <= o.maxDistance)
  }
}

const PROBES = { '48,64,0': 'stone', '96,64,0': 'stone', '128,64,0': 'stone', '160,64,0': 'stone' }
// The bead's deep-cave vein, shifted to the test origin: dy 90 at distH 61
// (3D ~109: past sync-48, inside the far shells).
const VEIN = { x: 60, y: -26, z: 10 }
const VEIN_NAMES = { [`${VEIN.x},${VEIN.y},${VEIN.z}`]: 'iron_ore', [`${VEIN.x + 1},${VEIN.y},${VEIN.z}`]: 'air' }

describe('bring walk gate (idkcraft-8w0)', () => {
  const bp = pos(0, 64, 0)
  const at = (x, y) => ({ name: 'iron_ore', position: pos(x, y, 0), distance: 64 - y, exposed: true })
  const flat = (x) => Math.abs(x) / SOURCE_COST.walkBlocksPerSec

  it('liveExposed prices two-rate to the knee, gates past maxWalkDescent', () => {
    assert.equal(liveExposed(bp, at(20, 52)).cost, flat(20) + 12 * SOURCE_COST.vertSecPerBlock)
    assert.equal(liveExposed(bp, at(20, 51)).cost, flat(20) + 12 * SOURCE_COST.vertSecPerBlock + 1 * SOURCE_COST.deepVertSecPerBlock)
    const edge = liveExposed(bp, at(20, 16))
    assert.ok(edge, 'dy 48 still walks')
    assert.equal(edge.cost, flat(20) + 12 * SOURCE_COST.vertSecPerBlock + 36 * SOURCE_COST.deepVertSecPerBlock)
    assert.equal(liveExposed(bp, at(20, 15)), null, 'dy 49 is no-hike')
    assert.equal(liveExposed(bp, at(23, -26)), null, 'the bead dy-90 cave vein gates')
    const climb = liveExposed(bp, { name: 'iron_ore', position: pos(10, 114, 0), distance: 51, exposed: true })
    assert.ok(climb, 'climbs stay ungated')
    assert.equal(climb.dy, -50)
    assert.equal(climb.cost, flat(10) + 12 * SOURCE_COST.vertSecPerBlock + 38 * SOURCE_COST.deepVertSecPerBlock)
    assert.equal(SOURCE_COST.vertKneeBlocks, 12)
    assert.equal(SOURCE_COST.deepVertSecPerBlock, 6)
    assert.equal(SOURCE_COST.maxWalkDescent, 48)
  })

  it('memoryExposed gates a remembered deep descent, prices a shallow one', () => {
    const bot = mockBot({ names: { ...VEIN_NAMES }, items: PICK })
    tickerFor(bot)
    const ctx = bot._tickerCtx
    seedMemory(ctx, VEIN.x, VEIN.y, VEIN.z, 'iron_ore')
    assert.equal(memoryExposed(bot, ctx, bp, 'iron', null), null, 'remembered dy-90 gates like live')
    const bot2 = mockBot({ names: { '30,34,0': 'iron_ore', '31,34,0': 'air' }, items: PICK })
    tickerFor(bot2)
    const ctx2 = bot2._tickerCtx
    seedMemory(ctx2, 30, 34, 0, 'iron_ore')
    const hit = memoryExposed(bot2, ctx2, bp, 'iron', null)
    assert.ok(hit, 'remembered dy-30 walks')
    assert.equal(hit.cost, (30 / SOURCE_COST.walkBlocksPerSec) * SOURCE_COST.memoryFactor + 12 * SOURCE_COST.vertSecPerBlock + 18 * SOURCE_COST.deepVertSecPerBlock)
  })

  it('the bead pair: gated 90-deep walk leaves the dig the only option, no ask', () => {
    const exposed = liveExposed(bp, at(23, -26))
    const buried = buriedCand(bp, { name: 'iron_ore', position: pos(20, 58, 0), distance: 21, exposed: false })
    assert.equal(exposed, null)
    assert.ok(buried)
    assert.deepEqual(decideBringSource(exposed, buried), { pick: 'buried', why: 'only-option' })
  })

  it('a repriced committable descent loses a feasible dig clear (was contested)', () => {
    // dy 40 at distH 20: linear priced 65 s vs the 42 s dig (contested, the
    // model could hike); two-rate prices 191 s, the dig wins outright.
    const exp = liveExposed(bp, at(20, 24))
    const dig = buriedCand(bp, { name: 'iron_ore', position: pos(20, 58, 0), distance: 21, exposed: false })
    assert.equal(exp.cost, 5 + 12 * SOURCE_COST.vertSecPerBlock + 28 * SOURCE_COST.deepVertSecPerBlock)
    assert.equal(dig.cost, 5 + 6 * 2 + SOURCE_COST.shaftPenaltySec)
    assert.deepEqual(decideBringSource(exp, dig), { pick: 'buried', why: 'clear' })
  })

  it('find phase: buried 48 stash + deep-cave far vein verdicts the dig, no ask', async () => {
    const names = { '0,58,0': 'iron_ore', ...VEIN_NAMES, ...PROBES }
    const bot = mockBot({ spots: [pos(0, 58, 0), pos(VEIN.x, VEIN.y, VEIN.z)], names, items: PICK, playerPos: pos(30, 64, 0) })
    centerAware(bot)
    const { seen, brain } = countingBrain('walk_exposed') // must never be consulted
    tickerFor(bot, brain)
    const ctx = bot._tickerCtx
    ctx.bring = { kind: 'block', name: 'iron', want: 3, by: 'P', phase: 'find', have: 0, announced: false }
    await bring(bot, ctx, null, {})
    assert.equal(ctx.bring.phase, 'searchfar')
    await bring(bot, ctx, null, {})
    assert.equal(seen.length, 0, 'gated walk never asks')
    assert.deepEqual(bot.lines, ['going for 3 iron_ore, 6 blocks away'])
    assert.deepEqual([ctx.bring.pos.x, ctx.bring.pos.y, ctx.bring.pos.z], [0, 58, 0])
    assert.equal(ctx.bring.phase, 'walk')
    assert.deepEqual(ctx.bring.verdict, {
      pick: 'buried',
      win: { x: 0, y: 58, z: 0, cost: 6 * 2 + SOURCE_COST.shaftPenaltySec },
      rival: null, // the gated hike is no rival
    })
  })

  it('creation: the same pair verdicts the dig over ticks, no ask', async () => {
    const names = { '0,58,0': 'iron_ore', ...VEIN_NAMES, ...PROBES }
    const bot = mockBot({ spots: [pos(0, 58, 0), pos(VEIN.x, VEIN.y, VEIN.z)], names, items: PICK, playerPos: pos(30, 64, 0) })
    centerAware(bot)
    const { seen, brain } = countingBrain('walk_exposed') // must never be consulted
    const ticker = tickerFor(bot, brain)
    handleChat(bot, ticker, 'P', 'bring me iron')
    assert.deepEqual(bot.lines, ['only buried iron within 48, checking further for open ore…'])
    for (let i = 0; i < 200 && bot._tickerCtx.pendingSearch; i++) await ticker.tick()
    assert.equal(bot._tickerCtx.pendingSearch, null)
    assert.equal(seen.length, 0, 'gated walk never asks')
    assert.ok(bot.lines.includes('going for 3 iron_ore, 6 blocks away'), `lines: ${bot.lines}`)
    const o = bot._tickerCtx.bring
    assert.deepEqual([o.pos.x, o.pos.y, o.pos.z], [0, 58, 0])
    assert.equal(o.verdict.pick, 'buried')
    assert.equal(o.verdict.rival, null)
  })

  it('only a deep-cave vein: legs order, then honest refusal, never a hike', async () => {
    // The anchor keeps the legs order alive for the assertion (chv shape);
    // the skip-far re-find below runs anchorless so the refusal lands
    // deterministically on that tick.
    const names = { ...VEIN_NAMES, ...PROBES }
    const bot = mockBot({
      spots: [pos(VEIN.x, VEIN.y, VEIN.z)], names, items: PICK,
      playerPos: pos(30, 64, 0), spawnPoint: pos(0, 64, 0),
    })
    centerAware(bot)
    const ticker = tickerFor(bot)
    handleChat(bot, ticker, 'P', 'bring me iron')
    assert.deepEqual(bot.lines, ['nothing within 48, widening the search for iron…'])
    for (let i = 0; i < 200 && !bot._tickerCtx.bring; i++) await ticker.tick()
    const o = bot._tickerCtx.bring
    assert.ok(o, 'legs order opened after the gated shells')
    o.phase = 'find'
    o.searchSkipFar = true
    delete bot.spawnPoint
    await bring(bot, bot._tickerCtx, null, {})
    assert.equal(bot._tickerCtx.bring, null, 'order refused')
    assert.ok(bot.lines.includes('no iron within 160 blocks (loaded area)'), `lines: ${bot.lines}`)
    assert.equal(bot.calls.setGoal, 0, 'never hiked to the deep vein')
  })

  it('a dy-48 descent still direct-commits at the boundary', async () => {
    const names = { '0,16,0': 'iron_ore', '1,16,0': 'air' }
    const bot = mockBot({ spots: [pos(0, 16, 0)], names, items: PICK, playerPos: pos(30, 64, 0) })
    tickerFor(bot)
    const ctx = bot._tickerCtx
    ctx.bring = { kind: 'block', name: 'iron', want: 3, by: 'P', phase: 'find', have: 0, announced: false }
    await bring(bot, ctx, null, {})
    assert.equal(ctx.bring.phase, 'walk')
    assert.deepEqual([ctx.bring.pos.x, ctx.bring.pos.y, ctx.bring.pos.z], [0, 16, 0])
    assert.deepEqual(bot.lines, ['going for 3 iron_ore, 48 blocks away'])
  })
})
