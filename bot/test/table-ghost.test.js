'use strict'

// idkcraft-h9z: a ghost table claim (ctx.home.table set, block mined away)
// deadlocked the menu — craft refused to rebuild ("table already placed")
// while equip failed no-table every pick, leaving forage as the only
// option forever. Prod 2026-09-28: 153 planks, home=site, door=yes,
// equip -> no-table -> forage -> equip every few seconds for 20 minutes.
const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const goal = require('../src/goal')
const gear = require('../src/behaviours/gear')
const { createTicker } = require('../src/index')

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

// Fake voxel world: explicit cells plus default terrain (dirt at y<=63,
// air above). placeBlock/dig mutate it.
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

function baseBot(world, items) {
  const chats = []
  return {
    chats,
    entity: { position: pos(0, 65, 0) },
    inventory: { items: () => items },
    time: { timeOfDay: 6000 },
    spawnPoint: pos(0, 64, 0),
    blockAt: (p) => world.blockAt(p),
    chat: (m) => { chats.push(String(m)) },
  }
}

describe('h9z goalFacts verifies the table claim', () => {
  const items = [{ name: 'oak_planks', count: 153 }, { name: 'oak_door', count: 1 }]
  it('ghost home table (claim + air) reads as no station', () => {
    const world = makeWorld()
    const bot = baseBot(world, items)
    const ctx = { home: goal.siteFor(bot, pos(0, 64, 0)) }
    const s = ctx.home.site
    ctx.home.table = pos(s.x + 4, s.y, s.z + 1) // claimed, but the cell is air
    assert.equal(world.blockAt(ctx.home.table).name, 'air')
    assert.equal(goal.goalFacts(bot, ctx).tablePlaced, false)
  })
  it('standing table at the claim reads as placed', () => {
    const world = makeWorld()
    const bot = baseBot(world, items)
    const ctx = { home: goal.siteFor(bot, pos(0, 64, 0)) }
    const s = ctx.home.site
    world.set(s.x + 4, s.y, s.z + 1, 'crafting_table')
    ctx.home.table = pos(s.x + 4, s.y, s.z + 1)
    assert.equal(goal.goalFacts(bot, ctx).tablePlaced, true)
  })
  it('ghost roadside claim reads as no station', () => {
    const world = makeWorld()
    const bot = baseBot(world, items)
    const ctx = { claimedTable: { x: 9, y: 64, z: 9 } } // air there
    assert.equal(goal.goalFacts(bot, ctx).tablePlaced, false)
  })
  it('unloaded chunk (null) keeps the claim, never reports a ghost', () => {
    // Furnace/stockpile precedent: null reads unloaded, never gone — a bot
    // far from home must not rebuild tables every trip.
    const bot = baseBot(makeWorld(), items)
    bot.blockAt = () => null
    assert.equal(goal.goalFacts(bot, { home: { table: pos(2, 64, 0) } }).tablePlaced, true)
    assert.equal(goal.goalFacts(bot, { claimedTable: { x: 9, y: 64, z: 9 } }).tablePlaced, true)
  })
  it('throwing or missing blockAt keeps the claim', () => {
    const bot = baseBot(makeWorld(), items)
    bot.blockAt = () => { throw new Error('chunk not loaded') }
    assert.equal(goal.goalFacts(bot, { home: { table: pos(2, 64, 0) } }).tablePlaced, true)
    const nobot = baseBot(makeWorld(), items)
    delete nobot.blockAt
    assert.equal(goal.goalFacts(nobot, { home: { table: pos(2, 64, 0) } }).tablePlaced, true)
  })
})

describe('h9z menu on the prod facts (153 planks, ghost table, home=site)', () => {
  // The exact prod shape: planks=enough table=no door=yes home=site.
  function prodSetup() {
    const world = makeWorld()
    const items = [{ name: 'oak_planks', count: 153 }, { name: 'oak_door', count: 1 }]
    const bot = baseBot(world, items)
    const ctx = { home: goal.siteFor(bot, pos(0, 64, 0)) }
    const s = ctx.home.site
    ctx.home.table = pos(s.x + 5, s.y, s.z + 1) // ghost: claimed, cell is air (v2 plan cell)
    bot.entity.position = pos(s.x + 5, s.y + 1, s.z + 1)
    return { world, bot, ctx, items }
  }
  it('facts line matches the prod shape', () => {
    const { bot, ctx } = prodSetup()
    const text = goal.goalText(goal.goalFacts(bot, ctx))
    assert.ok(text.includes('planks=enough table=no door=yes home=site'), text)
  })
  it('craft is offered (rebuild the table), equip is not', () => {
    const { bot, ctx } = prodSetup()
    const facts = goal.goalFacts(bot, ctx)
    assert.equal(goal.MENU.craft.feasible(facts, bot, ctx), true)
    assert.equal(goal.MENU.equip.feasible(facts, bot, ctx), false)
  })
  it('decide picks craft, never the failing equip', async () => {
    const { bot, ctx } = prodSetup()
    const r = await goal.decide(bot, ctx)
    assert.equal(r.action, 'craft')
  })
  it('with the table item in hand build lays it, equip waits for it', async () => {
    const { bot, ctx, items } = prodSetup()
    items.push({ name: 'crafting_table', count: 1 })
    const facts = goal.goalFacts(bot, ctx)
    assert.equal(goal.MENU.build.feasible(facts, bot, ctx), true)
    assert.equal(goal.MENU.equip.feasible(facts, bot, ctx), false)
    assert.equal(goal.stepWhy('equip', facts, bot, ctx, ''), 'equip: waiting for the house table')
    const r = await goal.decide(bot, ctx)
    assert.equal(r.action, 'build')
  })
  it('equip stops waiting once the site table stands or is given up', () => {
    const { world, bot, ctx, items } = prodSetup()
    items.push({ name: 'crafting_table', count: 1 })
    const s = ctx.home.site
    world.set(s.x + 5, s.y, s.z + 1, 'crafting_table') // build laid it (v2 plan cell)
    const facts = goal.goalFacts(bot, ctx)
    assert.equal(goal.MENU.equip.feasible(facts, bot, ctx), true)
    assert.equal(goal.stepWhy('equip', facts, bot, ctx, ''), null)
    world.set(s.x + 5, s.y, s.z + 1, 'air')
    ctx.buildSkip = [0] // table cell refused x3: roadside is the only station left
    assert.equal(goal.MENU.equip.feasible(goal.goalFacts(bot, ctx), bot, ctx), true)
  })
  it('homeless bot with a table yields to build when build can lay it', () => {
    const world = makeWorld()
    const bot = baseBot(world, [
      { name: 'oak_planks', count: 48 },
      { name: 'crafting_table', count: 1 },
    ])
    const facts = goal.goalFacts(bot, {})
    assert.equal(goal.MENU.build.feasible(facts, bot, {}), true)
    assert.equal(goal.MENU.equip.feasible(facts, bot, {}), false)
    const lost = baseBot(world, [{ name: 'oak_planks', count: 48 }, { name: 'crafting_table', count: 1 }])
    lost.spawnPoint = null // no site can found: keep the old roadside behavior
    assert.equal(goal.MENU.equip.feasible(goal.goalFacts(lost, {}), lost, {}), true)
  })
  it('craft criterion names the missing table for the model path', () => {
    assert.ok(goal.STEP_CRITERIA.craft.includes('table is no'), goal.STEP_CRITERIA.craft)
  })
})

describe('h9z gear waits on a ghost table instead of failing', () => {
  function gearBot(cells, items) {
    const chats = []
    return {
      chats,
      entity: { position: pos(0, 64, 0), onGround: true },
      inventory: { items: () => items },
      blockAt: (p) => {
        const name = cells[`${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`]
        if (!name) return null
        return { name, position: pos(p.x, p.y, p.z) }
      },
      pathfinder: { setGoal: () => {}, isMoving: () => false },
      chat: (line) => { chats.push(String(line)) },
    }
  }
  it('verified-air claim latches wait-table and yields', () => {
    const bot = gearBot(
      { '0,64,0': 'air' },
      [{ name: 'iron_ingot', count: 3 }, { name: 'stick', count: 2 }],
    )
    const ctx = {
      home: { site: { x: 0, y: 64, z: 0 }, built: true, table: { x: 0, y: 64, z: 0 } },
      stepStatus: 'running',
    }
    gear(bot, ctx)
    assert.equal(ctx.stepStatus, 'done')
    assert.equal(ctx.gear.saidNeed, 'wait-table')
  })
})

describe('h9z ticker: ghost table -> craft -> place -> rearm, no forage loop', () => {
  function workBrain() {
    return { async decide() { return { action: 'idle', sprint: false, source: 'stub' } } }
  }
  async function settle(n = 4) {
    for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r))
  }
  function workBot(world, items) {
    const chats = []
    const calls = { goals: [], places: [], digs: [], equips: [], craft: 0 }
    const bot = {
      chats,
      calls,
      username: 'IdkBot',
      players: { Steve: { username: 'Steve' } }, // roster online, target unseen
      entities: {},
      spawnPoint: pos(0, 64, 0),
      entity: { position: pos(0, 65, 0) },
      world: { getBlock: () => null },
      held: null,
      inventory: { items: () => items },
      blockAt: (p) => world.blockAt(p),
      findBlocks: () => [],
      pathfinder: {
        goal: null,
        setGoal(g) { calls.goals.push(g); bot.pathfinder.goal = g },
        stop() {},
        isMoving: () => false,
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
        // Consume one held item like the server does: placement changes
        // the facts, which is what re-fires the decision point in prod.
        const st = items.find((i) => i && i.name === bot.held && i.count > 0)
        if (st) st.count--
      },
      chat: (m) => { chats.push(String(m)) },
    }
    return bot
  }
  it('153 planks + ghost table rearms through the house table', async () => {
    const world = makeWorld()
    const items = [{ name: 'oak_planks', count: 153 }, { name: 'oak_door', count: 1 }]
    const bot = workBot(world, items)
    const IDS = { crafting_table: 11, stick: 12, wooden_pickaxe: 13, wooden_sword: 14 }
    bot.registry = { itemsByName: Object.fromEntries(Object.entries(IDS).map(([n, id]) => [n, { id }])) }
    const provides = { crafting_table: 'crafting_table', stick: 'stick', wooden_pickaxe: 'wooden_pickaxe', wooden_sword: 'wooden_sword' }
    bot.recipesFor = (id) => {
      const name = Object.keys(IDS).find((n) => IDS[n] === id)
      if (!name) return []
      return [{ result: { name, count: name === 'stick' ? 4 : 1 }, provides: provides[name], n: name === 'stick' ? 4 : 1 }]
    }
    bot.craft = async (recipe) => {
      bot.calls.craft++
      if (recipe && recipe.provides) items.push({ name: recipe.provides, count: recipe.n || 1 })
    }
    const ticker = createTicker({ bot, brain: workBrain(), tickMs: 10, idleTickMs: 10 })
    const ctx = bot._tickerCtx
    ctx.work = true
    ctx.home = goal.siteFor(bot, pos(0, 64, 0))
    const s = ctx.home.site
    ctx.home.table = pos(s.x + 5, s.y, s.z + 1) // ghost: claimed, cell is air (v2 plan cell)
    bot.entity.position = pos(s.x + 5, s.y + 1, s.z + 1)
    const lines = []
    const origLog = console.log
    const origErr = console.error
    console.log = (m) => { lines.push(String(m)) }
    console.error = (m) => { lines.push(String(m)) }
    const actions = []
    try {
      // Paced crafts take wall time (60 ms/op): poll on a wall clock like
      // the xoj untilCrafts precedent, not on a fast-tick budget.
      const t0 = Date.now()
      for (let t = 0; t < 400; t++) {
        const r = await ticker.tick()
        actions.push(r.decision && r.decision.action)
        await settle(2)
        const has = (n) => items.some((i) => i.name === n)
        if (has('wooden_pickaxe') && has('wooden_sword')) break
        if (Date.now() - t0 > 15000) break
        await new Promise((r) => setTimeout(r, 10))
      }
      assert.ok(actions.includes('craft'), `craft picked: ${actions.join(',')}`)
      assert.ok(actions.includes('build'), `build lays the table: ${actions.join(',')}`)
      assert.ok(actions.includes('equip'), `equip rearms: ${actions.join(',')}`)
      assert.ok(!actions.includes('forage'), `never detours to forage: ${actions.join(',')}`)
      assert.equal(world.get(s.x + 5, s.y, s.z + 1), 'crafting_table', 'site table stands')
      assert.ok(items.some((i) => i.name === 'wooden_pickaxe'), 'pickaxe rearmed')
      assert.ok(items.some((i) => i.name === 'wooden_sword'), 'sword rearmed')
      const failures = lines.filter((l) => l.includes('no-table'))
      assert.deepEqual(failures, [], `no table failures: ${failures.join(' | ')}`)
    } finally {
      console.log = origLog
      console.error = origErr
      ticker.destroy()
    }
  })
})

// ---- h9z fold-in: the sharper prod root cause (2026-09-28) ----
// equip stored ctx.claimedTable as a PLAIN {x,y,z}; prismarine-world calls
// pos.floored(), so every read threw, the standing table read as no station,
// craft rebuilt a second table (prod: 20 extra tables in 12 h) and equip
// failed no-table with the item already eaten. Fake blockAts never throw,
// so these tests run against a REAL prismarine-world.
const Vec3 = require('vec3')
const mcData = require('minecraft-data')('1.21.4')
const PWorld = require('prismarine-world')('1.21.4')
const PChunk = require('prismarine-chunk')('1.21.4')
const craftMod = require('../src/behaviours/craft')
const equipMod = require('../src/behaviours/equip')
const furnaceMod = require('../src/behaviours/furnace')
const stockpileMod = require('../src/behaviours/stockpile')

function realWorld() {
  const world = new PWorld(() => new PChunk()).sync
  world.setColumn(0, 0, new PChunk())
  return {
    set(name, x, y, z) {
      world.setBlockStateId(new Vec3(x, y, z), mcData.blocksByName[name].defaultState)
    },
    blockAt: (p) => world.getBlock(p),
  }
}

async function untilTrue(fn, what) {
  const t0 = Date.now()
  while (!fn()) {
    if (Date.now() - t0 > 8000) throw new Error(`stuck waiting for ${what}`)
    await new Promise((r) => setTimeout(r, 10))
  }
  for (let i = 0; i < 4; i++) await new Promise((r) => setImmediate(r))
}

describe('h9z real world: plain claims read through Vec3 normalisation', () => {
  const IDS = { oak_planks: 21, stick: 22, crafting_table: 23, wooden_pickaxe: 24, oak_door: 25 }
  const recipeFor = (name) => ({ result: { name, count: 1 } })
  function mockBot(rw, items, recipes) {
    const calls = { craft: [], placeBlock: [] }
    const itemsByName = {}
    for (const n of Object.keys(IDS)) itemsByName[n] = { id: IDS[n] }
    return {
      calls,
      entity: { position: pos(0, 64, 0) },
      inventory: { items: () => items },
      registry: { itemsByName },
      recipesFor: (id) => {
        const name = Object.keys(IDS).find((n) => IDS[n] === id)
        return recipes[name] ? [recipes[name]] : []
      },
      craft: async (recipe, count, table) => { calls.craft.push({ recipe, count, table }) },
      equip: async () => {},
      blockAt: (p) => rw.blockAt(p),
      pathfinder: { setGoal: () => {}, isMoving: () => false },
      chat: () => {},
    }
  }
  it('goalFacts ghost: plain claim + real air reads as no station', () => {
    const rw = realWorld() // (1,64,0) is air: nothing set
    const bot = baseBot(rw, [{ name: 'oak_planks', count: 153 }, { name: 'oak_door', count: 1 }])
    bot.blockAt = (p) => rw.blockAt(p)
    const ctx = { home: { site: { x: 0, y: 64, z: 0 }, table: { x: 1, y: 64, z: 0 } } }
    assert.equal(rw.blockAt(new Vec3(1, 64, 0)).name, 'air')
    assert.equal(goal.goalFacts(bot, ctx).tablePlaced, false)
  })
  it('goalFacts standing: plain claim + real table reads as placed', () => {
    const rw = realWorld()
    rw.set('crafting_table', 1, 64, 0)
    const bot = baseBot(rw, [{ name: 'oak_planks', count: 153 }])
    bot.blockAt = (p) => rw.blockAt(p)
    const ctx = { home: { site: { x: 0, y: 64, z: 0 }, table: { x: 1, y: 64, z: 0 } } }
    assert.equal(goal.goalFacts(bot, ctx).tablePlaced, true)
  })
  it('craft with a plain claim on a standing table crafts the door, not a second table', async () => {
    // Prod 01:55:59-02:02 UTC: the throw nulled tableBlock, so the table
    // branch rebuilt while the door branch never fired.
    const rw = realWorld()
    rw.set('crafting_table', 1, 64, 0)
    rw.set('dirt', 0, 63, 0)
    const items = [{ name: 'oak_planks', count: 6 }]
    const bot = mockBot(rw, items, { oak_door: recipeFor('oak_door'), crafting_table: recipeFor('crafting_table') })
    const ctx = { lastGoalKey: '', stepStatus: 'running', home: null, claimedTable: { x: 1, y: 64, z: 0 } }
    craftMod(bot, ctx, null, {})
    await untilTrue(() => bot.calls.craft.length >= 1, 'door craft')
    assert.equal(bot.calls.craft.length, 1)
    assert.equal(bot.calls.craft[0].recipe.result.name, 'oak_door')
  })
  it('equip with a plain claim on a standing table uses it, places nothing, holds no item', async () => {
    // No table item in hand: on master the throw reads the standing table
    // as a ghost and the step fails no-table.
    const rw = realWorld()
    rw.set('crafting_table', 1, 64, 0)
    rw.set('dirt', 0, 63, 0)
    const items = [{ name: 'oak_planks', count: 3 }, { name: 'stick', count: 2 }]
    const bot = mockBot(rw, items, { wooden_pickaxe: recipeFor('wooden_pickaxe') })
    const ctx = { lastGoalKey: '', stepStatus: 'running', home: null, claimedTable: { x: 1, y: 64, z: 0 } }
    const errs = []
    const origErr = console.error
    console.error = (m) => { errs.push(String(m)) }
    try {
      equipMod(bot, ctx, null, {})
      await untilTrue(() => bot.calls.craft.length >= 1, 'pickaxe craft')
    } finally {
      console.error = origErr
    }
    assert.equal(bot.calls.placeBlock.length, 0)
    assert.equal(bot.calls.craft[0].recipe.result.name, 'wooden_pickaxe')
    assert.deepEqual(errs.filter((l) => l.includes('no-table')), [])
  })
  it('after equip places a table, craft goes to the door, not a second table', async () => {
    // The literal prod acceptance: one placed table serves both steps.
    const rw = realWorld()
    for (const [x, z] of [[1, 0], [-1, 0], [0, 1], [0, -1], [0, 0]]) rw.set('dirt', x, 63, z)
    const items = [{ name: 'crafting_table', count: 1 }, { name: 'oak_planks', count: 3 }, { name: 'stick', count: 2 }]
    const bot = mockBot(rw, items, { wooden_pickaxe: recipeFor('wooden_pickaxe'), oak_door: recipeFor('oak_door') })
    bot.placeBlock = async (ref, face) => {
      bot.calls.placeBlock.push(true)
      const dx = ref.position.x + face.x
      const dy = ref.position.y + face.y
      const dz = ref.position.z + face.z
      rw.set('crafting_table', dx, dy, dz)
      const st = items.find((i) => i.name === 'crafting_table')
      if (st) st.count--
    }
    const ctx = { lastGoalKey: '', stepStatus: 'running', home: null }
    equipMod(bot, ctx, null, {})
    await untilTrue(() => bot.calls.placeBlock.length >= 1, 'roadside placement')
    assert.ok(ctx.claimedTable, 'equip claims the placed table')
    assert.equal(typeof ctx.claimedTable.floored, 'function', 'claim stored as Vec3')
    assert.equal(rw.blockAt(new Vec3(ctx.claimedTable.x, ctx.claimedTable.y, ctx.claimedTable.z)).name, 'crafting_table')
    // Phase 2: the craft step inherits the claim and needs a door.
    items.length = 0
    items.push({ name: 'oak_planks', count: 6 })
    bot.calls.craft.length = 0
    ctx.stepStatus = 'running'
    craftMod(bot, ctx, null, {})
    await untilTrue(() => bot.calls.craft.length >= 1, 'door craft')
    assert.equal(bot.calls.craft.length, 1)
    assert.equal(bot.calls.craft[0].recipe.result.name, 'oak_door')
  })
})

describe('h9z goal: a done with no visible effect holds like a failure', () => {
  function logsCtx() {
    const items = []
    for (let i = 0; i < 14; i++) items.push({ name: 'oak_log', count: 1 })
    const bot = baseBot(null, items)
    const ctx = { home: { site: { x: 10, y: 64, z: 10 } }, brain: {}, step: 'craft', stepStatus: 'done' }
    ctx.goalText = goal.goalText(goal.goalFacts(bot, ctx)) // picked under these facts
    return { bot, ctx }
  }
  it('craft done with unchanged facts is not re-picked', async () => {
    // The silent craft loop: done, same text, still feasible — the menu must
    // move on instead of re-picking forever (prod: 287 ticks, 0 failures).
    const { bot, ctx } = logsCtx()
    ctx.askedKey = 'stale'
    const r = await goal.decide(bot, ctx)
    assert.notEqual(r.action, 'craft')
    assert.equal(ctx.stepFail.craft.status, 'done')
    const facts = goal.goalFacts(bot, ctx)
    assert.equal(goal.stepWhy('craft', facts, bot, ctx, goal.goalText(facts)), 'craft holds after an unchanged done')
  })
  it('the askKey shortcut does not bypass the done-hold', async () => {
    // The shortcut returns the finished step without choosing: without the
    // hold check it re-picks the held step forever.
    const { bot, ctx } = logsCtx()
    ctx.askedKey = `${ctx.goalText}\ndone`
    const r = await goal.decide(bot, ctx)
    assert.notEqual(r.action, 'craft')
  })
  it('relocation releases the done-hold', async () => {
    const { bot, ctx } = logsCtx()
    ctx.askedKey = 'stale'
    await goal.decide(bot, ctx) // records the done-hold at the origin
    assert.ok(ctx.stepFail && ctx.stepFail.craft, 'held')
    bot.entity.position = pos(80, 64, 0)
    ctx.stepStatus = 'done'
    ctx.askedKey = 'stale'
    const r = await goal.decide(bot, ctx)
    assert.equal(r.action, 'craft')
  })
  it('new facts release the done-hold', async () => {
    const { bot, ctx } = logsCtx()
    ctx.askedKey = 'stale'
    await goal.decide(bot, ctx) // records the done-hold
    assert.ok(ctx.stepFail && ctx.stepFail.craft, 'held')
    ctx.haul = { coal: 5 } // banked haul flips the facts line
    bot.inventory.items().push({ name: 'coal', count: 5 })
    ctx.step = 'gather'
    ctx.stepStatus = 'running'
    ctx.goalText = 'stale'
    ctx.askedKey = 'stale'
    const r = await goal.decide(bot, ctx)
    assert.equal(r.action, 'craft')
  })
  it('effectful-but-sub-text dones never hold (revmux 01 major)', async () => {
    // forage banks 8-drop batches, deliver tosses partial hauls, stockpile
    // has its own parks, equip/gear effects are text-invisible, and the
    // self-advancing steps re-target by construction: holding any of these
    // on a same-text done strands real progress (forage batch -> explore
    // detour instead of the next batch). Only craft/build/gather/light —
    // steps whose every productive path moves the facts text — hold.
    for (const step of ['equip', 'gear', 'forage', 'deliver', 'stockpile', 'explore', 'gohome', 'stay']) {
      const { bot, ctx } = logsCtx()
      ctx.step = step
      ctx.askedKey = 'stale'
      await goal.decide(bot, ctx)
      assert.equal(ctx.stepFail && ctx.stepFail[step], undefined, `${step} records no hold`)
    }
  })
})

describe('h9z unshadow: a ghost home claim must not hide the standing roadside table', () => {
  // Rig run 4: home.table ghosted (mined) while the roadside claim stood —
  // every `home.table || claimedTable` read stopped at the ghost, so craft
  // rebuilt instead of dooring and the door never landed.
  const IDS = { oak_planks: 21, stick: 22, crafting_table: 23, wooden_pickaxe: 24, oak_door: 25, chest: 26 }
  const recipeFor = (name) => ({ result: { name, count: 1 } })
  function mockBot(rw, items, recipes, at) {
    const calls = { craft: [], placeBlock: [], goals: [] }
    const itemsByName = {}
    for (const n of Object.keys(IDS)) itemsByName[n] = { id: IDS[n] }
    return {
      calls,
      entity: { position: at || pos(0, 64, 0) },
      inventory: { items: () => items },
      registry: { itemsByName },
      recipesFor: (id) => {
        const name = Object.keys(IDS).find((n) => IDS[n] === id)
        return recipes[name] ? [recipes[name]] : []
      },
      craft: async (recipe, count, table) => { calls.craft.push({ recipe, count, table }) },
      equip: async () => {},
      blockAt: (p) => rw.blockAt(p),
      pathfinder: { setGoal: (g) => { calls.goals.push(g) }, isMoving: () => false },
      chat: () => {},
    }
  }
  function ghostCtx() {
    // Ghost home claim (air, loaded) + standing roadside claim, both plain.
    return { home: { site: { x: 0, y: 64, z: 0 }, table: { x: 9, y: 64, z: 9 } }, claimedTable: { x: 1, y: 64, z: 0 } }
  }
  it('craft doors off the roadside table despite the ghost', async () => {
    const rw = realWorld()
    rw.set('crafting_table', 1, 64, 0)
    const items = [{ name: 'oak_planks', count: 6 }]
    const bot = mockBot(rw, items, { oak_door: recipeFor('oak_door'), crafting_table: recipeFor('crafting_table') })
    const ctx = { ...ghostCtx(), lastGoalKey: '', stepStatus: 'running' }
    craftMod(bot, ctx, null, {})
    await untilTrue(() => bot.calls.craft.length >= 1, 'door craft')
    assert.equal(bot.calls.craft[0].recipe.result.name, 'oak_door')
  })
  it('gear and furnace tableBlock resolve past the ghost', () => {
    const rw = realWorld()
    rw.set('crafting_table', 1, 64, 0)
    const bot = { blockAt: (p) => rw.blockAt(p) }
    for (const mod of [gear, furnaceMod]) {
      const st = mod.tableBlock(bot, ghostCtx())
      assert.ok(st, 'station resolves')
      assert.equal(st.block.name, 'crafting_table')
      assert.deepEqual({ x: st.pos.x, y: st.pos.y, z: st.pos.z }, { x: 1, y: 64, z: 0 })
    }
  })
  it('stockpile crafts the chest off the roadside table despite the ghost', async () => {
    const rw = realWorld()
    rw.set('crafting_table', 1, 64, 0)
    for (let x = 0; x <= 8; x++) for (let z = 0; z <= 8; z++) rw.set('dirt', x, 63, z)
    const items = [{ name: 'oak_planks', count: 8 }]
    const bot = mockBot(rw, items, { chest: recipeFor('chest') })
    const ctx = { ...ghostCtx(), lastGoalKey: '', stepStatus: 'running' }
    delete ctx.home.chest
    stockpileMod(bot, ctx)
    await untilTrue(() => bot.calls.craft.length >= 1, 'chest craft')
    assert.equal(bot.calls.craft[0].recipe.result.name, 'chest')
    assert.notEqual(ctx.stepStatus, 'failed:stockpile-no-chest')
  })
  it('goalFacts sees the standing claim past the ghost', () => {
    const rw = realWorld()
    rw.set('crafting_table', 1, 64, 0)
    const bot = baseBot(rw, [{ name: 'oak_planks', count: 6 }])
    bot.blockAt = (p) => rw.blockAt(p)
    assert.equal(goal.goalFacts(bot, ghostCtx()).tablePlaced, true)
  })
})

describe('h9z equip: unreadable claims are kept, verified ghosts retract', () => {
  const IDS = { oak_planks: 21, stick: 22, crafting_table: 23, wooden_pickaxe: 24 }
  const recipeFor = (name) => ({ result: { name, count: 1 } })
  function mockBot(items, blockAt) {
    const calls = { craft: [], placeBlock: [] }
    const itemsByName = {}
    for (const n of Object.keys(IDS)) itemsByName[n] = { id: IDS[n] }
    return {
      calls,
      entity: { position: pos(0, 64, 0) },
      inventory: { items: () => items },
      registry: { itemsByName },
      recipesFor: (id) => {
        const name = Object.keys(IDS).find((n) => IDS[n] === id)
        return name === 'wooden_pickaxe' ? [recipeFor(name)] : []
      },
      craft: async (recipe, count, table) => { calls.craft.push({ recipe, count, table }) },
      equip: async () => {},
      placeBlock: async () => { calls.placeBlock.push(true) },
      blockAt,
      pathfinder: { setGoal: () => {}, isMoving: () => false },
      chat: () => {},
    }
  }
  async function runFailNoTable(bot, ctx) {
    const errs = []
    const origErr = console.error
    console.error = (m) => { errs.push(String(m)) }
    try {
      equipMod(bot, ctx, null, {})
      await untilTrue(() => typeof ctx.stepStatus === 'string' && ctx.stepStatus.startsWith('failed:'), 'equip failure')
    } finally {
      console.error = origErr
    }
    return errs
  }
  it('null read (unloaded chunk) keeps the claim', async () => {
    // No table item: the step still fails no-table, but the unknown claim
    // survives for a nearer, loaded episode instead of stranding the table.
    const bot = mockBot([{ name: 'oak_planks', count: 3 }, { name: 'stick', count: 2 }], () => null)
    const ctx = { lastGoalKey: '', stepStatus: 'running', home: null, claimedTable: { x: 50, y: 64, z: 50 } }
    await runFailNoTable(bot, ctx)
    assert.deepEqual({ ...ctx.claimedTable }, { x: 50, y: 64, z: 50 })
  })
  it('verified air retracts the claim so craft rebuilds', async () => {
    const bot = mockBot([{ name: 'oak_planks', count: 3 }, { name: 'stick', count: 2 }], () => ({ name: 'air' }))
    const ctx = { lastGoalKey: '', stepStatus: 'running', home: null, claimedTable: { x: 50, y: 64, z: 50 } }
    await runFailNoTable(bot, ctx)
    assert.equal(ctx.claimedTable, undefined)
  })
})

describe('h9z gear liveCounts mirrors the menu world (revmux 01 major)', () => {
  it('ghost home.table + standing claimedTable reads placed on the tick', () => {
    // liveCounts used `home.table || claimedTable`: the ghost short-circuit
    // hid the roadside table, so the tick yielded wait-table forever while
    // the menu (both verified) kept offering gear.
    const rw = realWorld()
    rw.set('crafting_table', 1, 64, 0)
    const bot = { inventory: { items: () => [] }, blockAt: (p) => rw.blockAt(p) }
    const ctx = { home: { table: { x: 9, y: 64, z: 9 } }, claimedTable: { x: 1, y: 64, z: 0 } }
    assert.equal(gear.liveCounts(bot, ctx).tablePlaced, true)
    const ghostOnly = { home: { table: { x: 9, y: 64, z: 9 } } }
    assert.equal(gear.liveCounts(bot, ghostOnly).tablePlaced, false)
  })
})
