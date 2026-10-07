'use strict'

// Bead idkcraft-vmzq.19: an active castle loses to house work — prod run3
// (master incl. #327) picked equip then beds over a feasible castle, the
// beds legs walked ~500 blocks back to the unfinished house, the house
// build ran there, and dusk gohome yanked every castle attempt back. #327
// bounded only the explore spiral. Fix: while an unfinished, unparked
// castle stands, (1) beds/build are infeasible and castlefetch/castle come
// first in STEP_ORDER (equip only outranked — the chain needs its kit),
// (2) every own search/bring leg stays within the task radius, (3) dusk
// and night shelter at the site instead of marching home.

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const goal = require('../src/goal')
const explore = require('../src/behaviours/explore')
const gather = require('../src/behaviours/gather')
const bring = require('../src/behaviours/bring')
const blueprint = require('../src/castle')
const castle = require('../src/behaviours/castle')
require('../src/index') // BEHAVIOURS registration (goal.registered)

// Prod run3 shape: castle site vs the old house ground, ~500 apart.
const CASTLE = { x: 276, y: 64, z: 180 }
const HOME = { x: -40, y: 64, z: -215 }
const MIDMAP = { x: 143, y: 62, z: 6 } // run3 03:37 dusk catch, between the two

function pos(x, y, z) {
  const p = {
    x, y, z,
    distanceTo: (q) => Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z),
    clone() { return pos(p.x, p.y, p.z) },
    offset(ox, oy, oz) { return pos(p.x + ox, p.y + oy, p.z + oz) },
    floored() { return pos(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)) },
  }
  return p
}

function flatWorld(cells) {
  return {
    blockAt: (p) => {
      const fx = Math.floor(p.x)
      const fy = Math.floor(p.y)
      const fz = Math.floor(p.z)
      const hit = cells && cells.get(`${fx},${fy},${fz}`)
      const name = hit || (fy <= 63 ? 'dirt' : 'air')
      return { name, position: pos(fx, fy, fz), boundingBox: name === 'air' ? 'empty' : 'block' }
    },
  }
}

function goalBot({ items = [], at = pos(CASTLE.x + 2, 64, CASTLE.z + 2), timeOfDay = 6000, cells = null } = {}) {
  const world = flatWorld(cells)
  return {
    chats: [],
    entity: { position: at, onGround: true },
    inventory: { items: () => items },
    time: { timeOfDay, day: 1 },
    spawnPoint: pos(0, 64, 0),
    players: {},
    entities: {},
    health: 20,
    food: 20,
    blockAt: (p) => world.blockAt(p),
    findBlocks: () => [],
    registry: { blocksByName: {}, itemsByName: {} },
    pathfinder: { goal: null, setGoal() {}, isMoving: () => false, movements: { exclusionAreasBreak: [], exclusionAreasPlace: [] } },
    world: { getBlock: () => null },
    chat(m) { this.chats.push(String(m)) },
  }
}

function unbuiltHome() {
  return {
    site: { ...HOME },
    interior: { min: { x: HOME.x + 1, y: HOME.y, z: HOME.z + 1 }, max: { x: HOME.x + 5, y: HOME.y + 1, z: HOME.z + 4 } },
    door: { x: HOME.x + 3, y: HOME.y, z: HOME.z },
    table: null,
    built: false,
    v: 2,
  }
}

function castleState(extra) {
  return { site: { ...CASTLE }, rot: 0, blueprintVersion: 1, phase: 'body', blocked: {}, parked: false, ...extra }
}

// A v2 home truly standing (except the skipped plan cells): repairs owed
// iff skip is non-empty. Cells overlay the flat world.
function standingHomeCells(skip = []) {
  const buildMod = require('../src/behaviours/build')
  const home = { site: { ...HOME }, built: true, v: 2 }
  const cells = new Map()
  const key = (x, y, z) => `${x},${y},${z}`
  for (const [i, cell] of buildMod.blueprintFor(home).entries()) {
    if (skip.includes(i)) continue
    const x = home.site.x + cell.dx
    const y = home.site.y + cell.dy
    const z = home.site.z + cell.dz
    cells.set(key(x, y, z), cell.kind === 'table' ? 'crafting_table' : cell.kind === 'door' ? 'oak_door' : cell.kind === 'fill' ? 'dirt' : 'oak_planks')
  }
  return { home: { ...home, interior: unbuiltHome().interior, door: unbuiltHome().door, table: null }, cells }
}

async function quiet(fn) {
  const orig = console.log
  console.log = () => {}
  try { return await fn() } finally { console.log = orig }
}

describe('vmzq.19 castle first: order and vetoes', () => {
  it('STEP_ORDER runs castlefetch/castle before the house chain', () => {
    const o = goal.STEP_ORDER
    for (const late of ['craft', 'equip', 'build', 'beds', 'light', 'gather']) {
      assert.ok(o.indexOf('castlefetch') < o.indexOf(late), `castlefetch before ${late}`)
      assert.ok(o.indexOf('castle') < o.indexOf(late), `castle before ${late}`)
    }
    assert.ok(o.indexOf('castlefetch') < o.indexOf('castle'), 'the fetch finishes its stack first')
  })

  it('built house + beds owed + stone-none: castlefetch, never beds (run3 03:29)', async () => {
    await quiet(async () => {
      const { home, cells } = standingHomeCells()
      const items = [
        { name: 'stone_pickaxe', count: 1 }, { name: 'stone_sword', count: 1 }, { name: 'dirt', count: 32 },
      ]
      const bot = goalBot({ items, cells })
      const ctx = { home, castle: castleState(), work: true, step: 'explore', stepStatus: 'done' }
      const facts = goal.goalFacts(bot, ctx)
      assert.equal(facts.castle, 'stone-none', `castle word ${facts.castle}`)
      assert.equal(facts.beds, 'none', 'beds are owed')
      assert.equal(goal.MENU.beds.feasible(facts, bot, ctx), false, 'beds vetoed while the castle stands')
      assert.equal(goal.stepWhy('beds', facts, bot, ctx, ''), 'beds: castle comes first')
      assert.equal((await goal.decide(bot, ctx)).action, 'castlefetch', 'fetches stone instead of hunting wool')
    })
  })

  it('house repairs owed + stone-batch: castle lays, never builds (run3 03:34)', async () => {
    await quiet(async () => {
      const { home, cells } = standingHomeCells([0]) // the table cell stands empty
      const items = [
        { name: 'oak_planks', count: 16 }, { name: 'crafting_table', count: 1 },
        { name: 'stone_pickaxe', count: 1 }, { name: 'stone_sword', count: 1 },
        { name: 'dirt', count: 32 }, { name: 'cobblestone', count: 80 },
      ]
      const bot = goalBot({ items, cells })
      const ctx = { home, castle: castleState(), work: true, step: 'explore', stepStatus: 'done' }
      const facts = goal.goalFacts(bot, ctx)
      assert.equal(facts.castle, 'stone-batch', `castle word ${facts.castle}`)
      assert.equal(goal.MENU.build.feasible(facts, bot, ctx), false, 'house build vetoed while the castle stands')
      assert.equal(goal.stepWhy('build', facts, bot, ctx, ''), 'build: castle comes first')
      assert.equal((await goal.decide(bot, ctx)).action, 'castle', 'lays the batch instead of repairing')
    })
  })

  it('unbuilt far house + table kit: equip arms, never founds the house', async () => {
    await quiet(async () => {
      const items = [
        { name: 'oak_planks', count: 32 }, { name: 'crafting_table', count: 1 }, { name: 'stick', count: 4 },
      ]
      const bot = goalBot({ items })
      const ctx = { home: unbuiltHome(), castle: castleState(), work: true, step: 'explore', stepStatus: 'done' }
      assert.equal(goal.MENU.build.feasible(goal.goalFacts(bot, ctx), bot, ctx), false)
      assert.equal((await goal.decide(bot, ctx)).action, 'equip', 'arms the castle kit, not the house table')
    })
  })

  it('parked, complete, or no castle: the vetoes release', () => {
    const { home, cells } = standingHomeCells([0])
    const bot = goalBot({ items: [{ name: 'oak_planks', count: 16 }, { name: 'crafting_table', count: 1 }], cells })
    const bedsFacts = { time: 'day', home: 'built', beds: 'none' }
    const buildFacts = goal.goalFacts(bot, { home })
    for (const [name, castle] of [
      ['no castle', null],
      ['owner/L2 park', castleState({ parked: true })],
      ['complete', castleState({ phase: 'complete' })],
    ]) {
      const ctx = castle ? { home, castle } : { home }
      assert.equal(goal.MENU.beds.feasible(bedsFacts, bot, ctx), true, `${name}: wool hunt runs`)
      assert.equal(goal.MENU.build.feasible(buildFacts, bot, ctx), true, `${name}: repairs run`)
    }
  })
})

describe('vmzq.19 dusk shelters at the site, never marches home', () => {
  it('dusk at the site with an unbuilt far house: shelter (the acceptance shape)', async () => {
    await quiet(async () => {
      const bot = goalBot({ at: pos(CASTLE.x + 2, 64, CASTLE.z + 2), timeOfDay: 12500 })
      const ctx = { home: unbuiltHome(), castle: castleState(), work: true, step: 'castle', stepStatus: 'done' }
      const facts = goal.goalFacts(bot, ctx)
      assert.equal(facts.home, 'site')
      assert.equal(goal.MENU.shelter.feasible(facts, bot, ctx), true, 'the built gate lifts at the site')
      assert.equal((await goal.decide(bot, ctx)).action, 'shelter')
    })
  })

  it('dusk mid-map with a built far house: shelter in place, not gohome (run3 03:37)', async () => {
    await quiet(async () => {
      const { home, cells } = standingHomeCells()
      const bot = goalBot({ at: pos(MIDMAP.x, MIDMAP.y, MIDMAP.z), timeOfDay: 12500, cells })
      const ctx = { home, castle: castleState(), work: true, step: 'castle', stepStatus: 'done' }
      const facts = goal.goalFacts(bot, ctx)
      assert.equal(goal.MENU.gohome.feasible(facts, bot, ctx), false, 'no 500-block dusk march')
      assert.equal(goal.stepWhy('gohome', facts, bot, ctx, ''), 'gohome: sheltering at the castle')
      assert.equal(goal.MENU.shelter.feasible(facts, bot, ctx), true)
      assert.equal((await goal.decide(bot, ctx)).action, 'shelter')
    })
  })

  it('night at the site with an unbuilt far house: shelter holds', async () => {
    await quiet(async () => {
      const bot = goalBot({ at: pos(CASTLE.x + 2, 64, CASTLE.z + 2), timeOfDay: 15000 })
      const ctx = { home: unbuiltHome(), castle: castleState(), work: true, step: 'shelter', stepStatus: 'done' }
      assert.equal((await goal.decide(bot, ctx)).action, 'shelter')
    })
  })

  it('near home, parked, or no castle: the old dusk march', async () => {
    await quiet(async () => {
      const { home, cells } = standingHomeCells()
      const near = goalBot({ at: pos(HOME.x + 10, 64, HOME.z), timeOfDay: 12500, cells })
      assert.equal((await goal.decide(near, { home, castle: castleState(), work: true, step: 'explore', stepStatus: 'done' })).action, 'gohome', 'at home it walks in')
      const mid = () => goalBot({ at: pos(MIDMAP.x, MIDMAP.y, MIDMAP.z), timeOfDay: 12500, cells })
      assert.equal((await goal.decide(mid(), { home, castle: castleState({ parked: true }), work: true, step: 'explore', stepStatus: 'done' })).action, 'gohome', 'parked: marches')
      assert.equal((await goal.decide(mid(), { home, work: true, step: 'explore', stepStatus: 'done' })).action, 'gohome', 'no castle: marches')
    })
  })
})

describe('vmzq.19 own legs stay within the task radius', () => {
  function huntBot(at) {
    const goals = []
    return {
      goals,
      entity: { position: pos(at.x, at.y, at.z), onGround: true },
      spawnPoint: pos(HOME.x, HOME.y, HOME.z),
      time: { timeOfDay: 6000, day: 1 },
      players: {},
      entities: {},
      health: 20,
      food: 20,
      registry: { blocksByName: {}, itemsByName: {} },
      inventory: { items: () => [] },
      blockAt: () => null,
      findBlocks: () => [],
      pathfinder: { goal: null, setGoal: (g) => { goals.push(g) }, isMoving: () => false },
      chat: () => {},
    }
  }

  function huntCtx() {
    return {
      home: { site: { ...HOME }, built: true, v: 2 },
      castle: castleState(),
      bring: { kind: 'wool', phase: 'find', self: 'beds', want: 3, drop: null, have: 0, announced: false },
    }
  }

  it('a wool self-hunt from the site walks legs within 64, never home', async () => {
    const bot = huntBot({ x: CASTLE.x, y: 64, z: CASTLE.z - 3 })
    const ctx = huntCtx()
    const legs = []
    for (let i = 0; i < 100 && ctx.bring && legs.length < 8; i++) {
      await bring(bot, ctx, null, {})
      const t = ctx.explore && ctx.explore.target
      if (t) {
        if (!legs.some((l) => l.x === t.x && l.z === t.z)) legs.push({ x: t.x, z: t.z })
        bot.entity.position = pos(t.x, 64, t.z)
      }
    }
    assert.ok(legs.length >= 3, `legs walked: ${legs.length}`)
    for (const l of legs) {
      const dSite = Math.hypot(l.x - CASTLE.x, l.z - CASTLE.z)
      assert.ok(dSite <= explore.TASK_SEARCH_RADIUS, `leg ${l.x},${l.z} ${Math.round(dSite)} from site`)
    }
  })

  it('rings 16/32/64 visited at the site: the hunt caps instead of walking out', async () => {
    const bot = huntBot({ x: CASTLE.x, y: 64, z: CASTLE.z - 3 })
    const ctx = huntCtx()
    ctx.explore = { visited: new Set(), target: null, lastPos: null, stalls: 0, issuedKey: null, markStart: 0, chatAt: 0 }
    for (const r of [16, 32, 64]) {
      for (let a = 0; a < 8; a++) {
        const x = Math.round(CASTLE.x + r * Math.sin(a * Math.PI / 4))
        const z = Math.round(CASTLE.z - r * Math.cos(a * Math.PI / 4))
        ctx.explore.visited.add(`${Math.floor(x / 16)},${Math.floor(z / 16)}`)
      }
    }
    const order = ctx.bring
    await bring(bot, ctx, null, {})
    assert.equal(ctx.bring, null, 'the capped hunt ends')
    assert.equal(order.searchLegs.capped, true)
    assert.ok(!bot.goals.some((g) => g), 'no walk goal issues past the cap')
  })

  it('a stale far leg dies on the next search: the site pick replaces it', async () => {
    const bot = huntBot({ x: CASTLE.x, y: 64, z: CASTLE.z - 3 })
    const ctx = huntCtx()
    ctx.explore = { visited: new Set(), target: { x: HOME.x, z: HOME.z }, lastPos: null, stalls: 0, issuedKey: null, markStart: 0, chatAt: 0 }
    await bring(bot, ctx, null, {})
    const t = ctx.explore.target
    assert.ok(t, 'a leg is picked')
    assert.ok(Math.hypot(t.x - CASTLE.x, t.z - CASTLE.z) <= explore.TASK_SEARCH_RADIUS, `site pick ${t.x},${t.z}`)
  })

  it('gather ignores home-ground memory while a task is active, walks near trees', () => {
    const bot = {
      entity: { position: pos(CASTLE.x, 64, CASTLE.z), onGround: true },
      registry: { blocksByName: { oak_log: { id: 17 } } },
      inventory: { items: () => [] },
      findBlocks: () => [], // sync 48 empty
      blockAt: () => null, // unloaded probes: no far search
      pathfinder: { goal: null, setGoal() {}, isMoving: () => false },
      chat: () => {},
    }
    const memItems = new Map()
    memItems.set(`${HOME.x},64,${HOME.z}`, { x: HOME.x, y: 64, z: HOME.z, name: 'oak_log' })
    // Far-only memory: no commit, the step fails honestly at the site.
    const far = { home: unbuiltHome(), castle: castleState(), resources: { items: memItems }, lastGoalKey: '', stepStatus: 'running' }
    gather(bot, far, null, {})
    assert.equal(far.gather.pos, null, 'the 500-block memory never commits')
    assert.equal(far.stepStatus, 'failed:no-trees')
    // A remembered tree by the site still commits.
    const nearItems = new Map()
    nearItems.set(`${CASTLE.x + 20},64,${CASTLE.z}`, { x: CASTLE.x + 20, y: 64, z: CASTLE.z, name: 'oak_log' })
    const near = { home: unbuiltHome(), castle: castleState(), resources: { items: nearItems }, lastGoalKey: '', stepStatus: 'running' }
    gather(bot, near, null, {})
    assert.ok(near.gather.pos, 'the near memory commits')
    assert.equal(Math.round(near.gather.pos.x), CASTLE.x + 20)
  })

  it('gather without a task keeps the far memory hike (old behaviour)', () => {
    const bot = {
      entity: { position: pos(CASTLE.x, 64, CASTLE.z), onGround: true },
      registry: { blocksByName: { oak_log: { id: 17 } } },
      inventory: { items: () => [] },
      findBlocks: () => [],
      blockAt: () => null,
      pathfinder: { goal: null, setGoal() {}, isMoving: () => false },
      chat: () => {},
    }
    const memItems = new Map()
    memItems.set(`${HOME.x},64,${HOME.z}`, { x: HOME.x, y: 64, z: HOME.z, name: 'oak_log' })
    const ctx = { home: { site: { ...HOME }, built: true, v: 2 }, resources: { items: memItems }, lastGoalKey: '', stepStatus: 'running' }
    gather(bot, ctx, null, {})
    assert.ok(ctx.gather.pos, 'no task: the remembered tree commits at any distance')
    assert.equal(Math.round(ctx.gather.pos.x), HOME.x)
  })
})

describe('vmzq.19 R2 major 1: a castle next to the house never anchors the night', () => {
  const NEAR_CASTLE = { x: HOME.x + 10, y: 64, z: HOME.z }

  it('dusk 70 out with the castle 10 from home: gohome marches, no shelter', async () => {
    await quiet(async () => {
      const { home, cells } = standingHomeCells()
      const bot = goalBot({ at: pos(HOME.x + 70, 64, HOME.z), timeOfDay: 12500, cells })
      const ctx = { home, castle: { site: { ...NEAR_CASTLE }, rot: 0, blueprintVersion: 1, phase: 'body' }, work: true, step: 'explore', stepStatus: 'done' }
      const facts = goal.goalFacts(bot, ctx)
      assert.equal(goal.MENU.gohome.feasible(facts, bot, ctx), true, 'a short dusk walk beats a pillar')
      assert.equal(goal.MENU.shelter.feasible(facts, bot, ctx), false)
      assert.equal((await goal.decide(bot, ctx)).action, 'gohome')
    })
  })
})

describe('vmzq.19 R2 major 2: the model never overrides a runnable castle', () => {
  it('castle-rule: fsm castle/castlefetch skips the model (boom brain)', async () => {
    const boom = { source: 'laya-test', ask: async () => { throw new Error('model asked') } }
    const facts = { time: 'day', logs: 0, planks: 0, maxPlanks: 0 }
    assert.deepEqual(
      await goal.chooseStep(boom, facts, ['castle', 'light', 'equip', 'rest'], null),
      { step: 'castle', source: 'castle-rule', fsm: 'castle', model: null })
    assert.deepEqual(
      await goal.chooseStep(boom, facts, ['castlefetch', 'gear', 'rest'], null),
      { step: 'castlefetch', source: 'castle-rule', fsm: 'castlefetch', model: null })
  })

  it('decide with a lying model still castles (run3: laya picked equip over castle)', async () => {
    await quiet(async () => {
      const { home, cells } = standingHomeCells()
      const items = [
        { name: 'oak_planks', count: 16 }, { name: 'crafting_table', count: 1 },
        { name: 'stone_pickaxe', count: 1 }, { name: 'stone_sword', count: 1 },
        { name: 'dirt', count: 32 }, { name: 'cobblestone', count: 80 },
      ]
      const bot = goalBot({ items, cells })
      const lying = { source: 'laya-test', ask: async () => 'equip' }
      const ctx = { home, castle: castleState(), brain: lying, work: true, step: 'explore', stepStatus: 'done' }
      assert.equal((await goal.decide(bot, ctx)).action, 'castle')
      assert.equal(ctx.stepPick.source, 'castle-rule')
    })
  })

  it('light/stockpile/gear vetoed far from home, running near it', () => {
    const farBot = goalBot({ at: pos(CASTLE.x, 64, CASTLE.z) }) // ~500 from home
    const nearBot = goalBot({ at: pos(HOME.x + 10, 64, HOME.z) })
    const ctx = { home: { site: { ...HOME } }, castle: castleState() }
    const lightFacts = { time: 'day', home: 'built', unlit: 3, torches: 1 }
    assert.equal(goal.MENU.light.feasible(lightFacts, farBot, ctx), false, 'no cross-map torch run')
    assert.equal(goal.MENU.light.feasible(lightFacts, nearBot, ctx), true)
    assert.equal(goal.stepWhy('light', lightFacts, farBot, ctx, ''), 'light: castle comes first')
    const stockFacts = { home: 'built', chest: 'yes', surplus: 'yes', haul: 'none', chestParked: false }
    assert.equal(goal.MENU.stockpile.feasible(stockFacts, farBot, ctx), false, 'no cross-map banking run')
    assert.equal(goal.MENU.stockpile.feasible(stockFacts, nearBot, ctx), true)
    assert.equal(goal.stepWhy('stockpile', stockFacts, farBot, ctx, ''), 'stockpile: castle comes first')
    const gearFacts = { home: 'built' }
    assert.equal(goal.MENU.gear.feasible(gearFacts, farBot, ctx), false, 'the ladder waits for the castle')
    assert.equal(goal.MENU.gear.feasible(gearFacts, nearBot, ctx), true)
    assert.equal(goal.stepWhy('gear', gearFacts, farBot, ctx, ''), 'gear: castle comes first')
    // No castle: the leash never fires.
    assert.equal(goal.MENU.light.feasible(lightFacts, farBot, { home: ctx.home }), true)
  })
})

describe('vmzq.19 R2 minor 3: an L2 castle park leashes far beds/build side work', () => {
  it('taskPark + far home: beds/build stay vetoed; near home or owner park: released', () => {
    const { home, cells } = standingHomeCells([0])
    const bot = goalBot({ items: [{ name: 'oak_planks', count: 16 }, { name: 'crafting_table', count: 1 }], cells })
    const bedsFacts = { time: 'day', home: 'built', beds: 'none' }
    const buildFacts = goal.goalFacts(bot, { home })
    const l2Park = castleState({ parked: true, taskPark: { at: 1, auto: true, diag: 'stall' } })
    const l2Ctx = { home, castle: l2Park }
    assert.equal(goal.MENU.beds.feasible(bedsFacts, bot, l2Ctx), false, 'no wool march during the park')
    assert.equal(goal.MENU.build.feasible(buildFacts, bot, l2Ctx), false, 'no repair march during the park')
    assert.equal(goal.stepWhy('beds', bedsFacts, bot, l2Ctx, ''), 'beds: castle comes first')
    // Near home the parked side work proceeds.
    const nearHome = { ...home, site: { x: CASTLE.x + 10, y: 64, z: CASTLE.z } }
    const nearCtx = { home: nearHome, castle: l2Park }
    assert.equal(goal.MENU.beds.feasible(bedsFacts, bot, nearCtx), true)
    // An owner park (no episode) releases fully: the owner stopped the castle.
    const ownerCtx = { home, castle: castleState({ parked: true }) }
    assert.equal(goal.MENU.beds.feasible(bedsFacts, bot, ownerCtx), true)
    assert.equal(goal.MENU.build.feasible(buildFacts, bot, ownerCtx), true)
  })
})

describe('vmzq.19 empty kit at the site with an unbuilt far house: progress rises', () => {
  it('gather->craft->equip->castlefetch->castle lays blocks, never beds/build', async () => {
    await quiet(async () => {
      // World: flat dirt, site loaded, the far house unbuilt (bare ground).
      const cells = new Map()
      const key = (x, y, z) => `${Math.floor(x)},${Math.floor(y)},${Math.floor(z)}`
      const world = {
        blockAt: (p) => {
          const fx = Math.floor(p.x)
          const fy = Math.floor(p.y)
          const fz = Math.floor(p.z)
          const k = key(fx, fy, fz)
          const name = cells.has(k) ? cells.get(k) : (fy <= 63 ? 'dirt' : 'air')
          return { name, position: pos(fx, fy, fz), boundingBox: name === 'air' ? 'empty' : 'block' }
        },
      }
      const items = []
      const setGoals = []
      const places = []
      let held = null
      const bot = {
        chats: [],
        entity: { position: pos(CASTLE.x + 2, 64, CASTLE.z + 2), onGround: true },
        inventory: { items: () => items },
        time: { timeOfDay: 6000, day: 1 },
        spawnPoint: pos(0, 64, 0),
        players: {},
        entities: {},
        health: 20,
        food: 20,
        world: { getBlock: () => null },
        blockAt: (p) => world.blockAt(p),
        findBlocks: () => [],
        registry: { blocksByName: {}, itemsByName: {} },
        pathfinder: {
          goal: null,
          movements: { exclusionAreasBreak: [], exclusionAreasPlace: [] },
          isMoving: () => false,
          setGoal: (g) => { setGoals.push(g); bot.pathfinder.goal = g },
        },
        equip: async (item) => { held = item.name },
        dig: async () => {},
        placeBlock: async (ref, face) => {
          const p = { x: ref.position.x + face.x, y: ref.position.y + face.y, z: ref.position.z + face.z }
          places.push(p)
          cells.set(key(p.x, p.y, p.z), held)
        },
        chat(m) { this.chats.push(String(m)) },
      }
      const ctx = { home: unbuiltHome(), castle: castleState(), work: true }
      const seen = []
      const pick = async () => {
        const a = (await goal.decide(bot, ctx)).action
        seen.push(a)
        return a
      }
      assert.equal(goal.goalFacts(bot, ctx).castle, 'stone-none')
      assert.equal(await pick(), 'gather', 'empty kit chops first')
      items.push({ name: 'oak_log', count: 14 })
      assert.equal(await pick(), 'craft')
      items.length = 0
      items.push({ name: 'oak_planks', count: 32 }, { name: 'crafting_table', count: 1 }, { name: 'stick', count: 4 })
      assert.equal(await pick(), 'equip', 'arms the kit instead of founding the house')
      items.push({ name: 'stone_pickaxe', count: 1 }, { name: 'stone_sword', count: 1 }, { name: 'dirt', count: 32 })
      assert.equal(await pick(), 'castlefetch')
      items.push({ name: 'cobblestone', count: 64 })
      assert.equal(goal.goalFacts(bot, ctx).castle, 'stone-batch')
      assert.equal(await pick(), 'castlefetch', 'the fetch finishes its stack first')
      items.push({ name: 'cobblestone', count: 16 })
      ctx.stepStatus = 'done' // the fetch behaviour ends at its target
      assert.equal(await pick(), 'castle')
      assert.ok(!seen.includes('beds') && !seen.includes('build'), `house steps never picked: ${seen.join(',')}`)
      // Lay: progress rises from 0.
      const settle = async (n = 4) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)) }
      for (let i = 0; i < 30; i++) { castle(bot, ctx); await settle() }
      assert.ok(places.length > 0, 'blocks are laid')
      const laid = castle.progressByKind(bot, ctx.castle).stone.done
      assert.ok(laid > 0, `stone progress ${laid}`)
    })
  })
})
