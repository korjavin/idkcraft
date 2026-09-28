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
    ctx.home.table = pos(s.x + 4, s.y, s.z + 1) // ghost: claimed, cell is air
    bot.entity.position = pos(s.x + 4, s.y + 1, s.z + 1)
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
    world.set(s.x + 4, s.y, s.z + 1, 'crafting_table') // build laid it
    const facts = goal.goalFacts(bot, ctx)
    assert.equal(goal.MENU.equip.feasible(facts, bot, ctx), true)
    assert.equal(goal.stepWhy('equip', facts, bot, ctx, ''), null)
    world.set(s.x + 4, s.y, s.z + 1, 'air')
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
    ctx.home.table = pos(s.x + 4, s.y, s.z + 1) // ghost: claimed, cell is air
    bot.entity.position = pos(s.x + 4, s.y + 1, s.z + 1)
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
      assert.equal(world.get(s.x + 4, s.y, s.z + 1), 'crafting_table', 'site table stands')
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
