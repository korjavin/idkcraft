'use strict'

// idkcraft-g0z.49: the castle attic nook — an enchanting table at (15,8,12)
// and five bookshelves (13..17,8,10) on the dy7 slab, laid after phase
// 'complete' like g0z.31/32/45. Phase 1 is chest-supplied: shelves or books
// from the castle chest (3 books + 6 planks crafted at a table), the table
// chest-only; missing stock fails honestly into the hold. The dry-kind
// skip is per kind (a Set), so a dry table never locks stocked shelves out.

const { describe, it, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const Vec3 = require('vec3')
const blueprint = require('../src/castle')
const castleMod = require('../src/behaviours/castle')
const fetch = require('../src/behaviours/castlefetch')
const util = require('../src/behaviours/util')
const craftany = require('../src/behaviours/craftany')
const goal = require('../src/goal')
const residence = require('../src/residence')
const reach = require('./castle-reach')
const build = require('../src/behaviours/build')
require('../src/index') // BEHAVIOURS registration (goal.registered)

const V2 = blueprint.BLUEPRINTS[2]
const SITE = { x: 100, y: 64, z: 200 }
const PAINT = { stone: 'cobblestone', planks: 'oak_planks', frame: 'spruce_log', fence: 'oak_fence', door: 'oak_door', chest: 'chest', torch: 'torch', air: 'air', dig: 'air' }
const k3 = (x, y, z) => `${Math.floor(x)},${Math.floor(y)},${Math.floor(z)}`
const settle = () => new Promise((r) => setImmediate(r))
const TABLE = { dx: 15, dy: 8, dz: 12 }
const SHELVES = [13, 14, 15, 16, 17].map((dx) => ({ dx, dy: 8, dz: 10 }))
const NOOK = blueprint.DECOR[2].slice(-6)
// The stair well (bead): column x18 z8..11 at dy8..10 stays free (jump
// headroom of the stairU climb).
const WELL = []
for (let dy = 8; dy <= 10; dy++) for (let dz = 8; dz <= 11; dz++) WELL.push({ dx: 18, dy, dz, kind: 'air' })

describe('castle attic decor plan (g0z.49)', () => {
  it('append-only: the table + 5 shelves land after the fence row, earlier idx fixed', () => {
    assert.equal(blueprint.DECOR[2].filter((c) => c.kind === 'pane').length, 44)
    assert.equal(blueprint.DECOR[2].filter((c) => c.kind === 'banner').length, 2)
    assert.deepEqual(blueprint.DECOR[2].slice(0, 44).map((c) => c.kind), blueprint.DECOR[2].slice(0, 44).map(() => 'pane'))
    assert.deepEqual(blueprint.DECOR[2].slice(44, 46).map((c) => c.kind), ['banner', 'banner'])
    assert.deepEqual(NOOK.map((c) => `${c.kind}@${k3(c.dx, c.dy, c.dz)}`), [
      `enchanting_table@${k3(TABLE.dx, TABLE.dy, TABLE.dz)}`,
      ...SHELVES.map((c) => `bookshelf@${k3(c.dx, c.dy, c.dz)}`),
    ])
    const dp = blueprint.decorPlan(SITE, 0, 2)
    assert.equal(dp.cells.length, 44 + 2 + V2.PLAN.filter((c) => c.kind === 'fence').length + 6)
    NOOK.forEach((c, i) => {
      assert.equal(dp.cells[dp.cells.length - 6 + i].idx, blueprint.DECOR_BASE + dp.cells.length - 6 + i)
    })
  })

  it('the PLAN stays frozen and v1 has no nook', () => {
    assert.ok(!V2.PLAN.some((c) => c.kind === 'bookshelf' || c.kind === 'enchanting_table'))
    assert.equal(blueprint.decorPlan(SITE, 0, 1).cells.filter((c) => c.kind === 'bookshelf' || c.kind === 'enchanting_table').length, 0)
  })

  it('none on a plan cell, none in the stair column, at all 4 rots', () => {
    const wellKeys = (rot) => new Set(blueprint.rotatePlan(WELL, rot, 2).map((c) => k3(SITE.x + c.dx, SITE.y + c.dy, SITE.z + c.dz)))
    for (let rot = 0; rot < 4; rot++) {
      const plan = blueprint.absPlan(SITE, rot, 2)
      const nook = blueprint.decorPlan(SITE, rot, 2).cells.slice(-6)
      assert.equal(nook.filter((c) => c.kind === 'bookshelf').length, 5)
      assert.equal(nook.filter((c) => c.kind === 'enchanting_table').length, 1)
      const well = wellKeys(rot)
      for (const c of nook) {
        assert.ok(!plan.at.has(k3(c.x, c.y, c.z)), `rot ${rot}: ${k3(c.x, c.y, c.z)} is off-plan`)
        assert.ok(!well.has(k3(c.x, c.y, c.z)), `rot ${rot}: ${k3(c.x, c.y, c.z)} keeps the stair well free`)
      }
    }
  })

  it('every shelf within Chebyshev 2 of the table at dy 8 with the air row between, all 4 rots', () => {
    const airLocal = SHELVES.map((c) => ({ dx: c.dx, dy: 8, dz: 11, kind: 'air' }))
    for (let rot = 0; rot < 4; rot++) {
      const plan = blueprint.absPlan(SITE, rot, 2)
      const dp = blueprint.decorPlan(SITE, rot, 2)
      const t = dp.cells.filter((c) => c.kind === 'enchanting_table')
      assert.equal(t.length, 1)
      const [table] = t
      assert.equal(table.dy, 8)
      const shelves = dp.cells.filter((c) => c.kind === 'bookshelf')
      assert.equal(shelves.length, 5)
      for (const s of shelves) {
        assert.equal(s.dy, 8)
        assert.ok(Math.max(Math.abs(s.x - table.x), Math.abs(s.z - table.z)) <= 2, `rot ${rot}: shelf ${k3(s.x, s.y, s.z)} in the bonus ring`)
      }
      for (const c of blueprint.rotatePlan(airLocal, rot, 2)) {
        const k = k3(SITE.x + c.dx, SITE.y + c.dy, SITE.z + c.dz)
        const p = plan.at.get(k)
        assert.ok(!p || !blueprint.isPlaceTarget(p.kind), `rot ${rot}: air row ${k} holds no plan block`)
        assert.ok(!dp.at.has(k), `rot ${rot}: air row ${k} holds no decor`)
      }
    }
  })

  it('matches: exact names only', () => {
    assert.ok(blueprint.matches('bookshelf', 'bookshelf'))
    assert.ok(!blueprint.matches('bookshelf', 'chiseled_bookshelf'))
    assert.ok(!blueprint.matches('bookshelf', 'book'))
    assert.ok(!blueprint.matches('bookshelf', 'air'))
    assert.ok(blueprint.matches('enchanting_table', 'enchanting_table'))
    assert.ok(!blueprint.matches('enchanting_table', 'crafting_table'))
    assert.ok(!blueprint.matches('enchanting_table', 'air'))
  })

  it('protects a laid shelf/table at a decor cell, not another occupant; every dig path refuses it', () => {
    const st = { site: SITE, rot: 1, blueprintVersion: 2, phase: 'complete' }
    const nook = blueprint.decorPlan(SITE, 1, 2).cells.slice(-6)
    for (const c of nook) {
      const laid = c.kind === 'bookshelf' ? 'bookshelf' : 'enchanting_table'
      assert.equal(blueprint.protects(st, c, laid), true)
      assert.equal(blueprint.protects(st, c, 'dirt'), false)
      const block = { name: laid, position: new Vec3(c.x, c.y, c.z) }
      for (const extra of [{}, { castleClear: true }, { castleClear: 'emptied' }]) {
        assert.equal(util.protectedReason({}, block, { castle: st, ...extra }), 'protected')
      }
    }
  })

  it('a foreign shelf/table in the footprint is kept from the castle clear', () => {
    const st = { site: SITE, rot: 0, blueprintVersion: 2, phase: 'body' }
    const air = blueprint.absPlan(SITE, 0, 2).cells.find((c) => c.kind === 'air')
    for (const name of ['bookshelf', 'enchanting_table']) {
      const block = { name, position: new Vec3(air.x, air.y, air.z) }
      assert.equal(util.castleClears({ castleClear: true, castle: st }, block.position, name), false)
      assert.equal(util.protectedReason({}, block, { castle: st, castleClear: true }), 'protected')
    }
  })

  it('reach: every nook cell has a walkable stance within PLACE_REACH at all 4 rots', () => {
    for (let rot = 0; rot < 4; rot++) {
      const { w, d } = blueprint.siteDimensions(rot, 2)
      const ent = blueprint.rotatePlan([{ ...V2.ENTRANCE, kind: 'air' }], rot, 2)[0]
      const r = reach.checkPlan({ W: w, D: d, ENTRANCE: ent, PLAN: blueprint.rotatePlan(V2.PLAN, rot, 2) }, blueprint.isPlaceTarget)
      assert.ok(r.ok, `rot ${rot} cell ${r.idx}: ${r.reason}`)
      for (const t of blueprint.rotatePlan(NOOK, rot, 2)) {
        const ok = reach.flood(r.grid, ent, (sx, sy, sz) => {
          if (sx === t.dx && sz === t.dz && (sy === t.dy || sy + 1 === t.dy)) return false
          return Math.hypot(sx - t.dx, sy + 1.6 - t.dy - 0.5, sz - t.dz) <= build.PLACE_REACH
        })
        assert.ok(ok, `rot ${rot} nook ${t.kind} ${k3(t.dx, t.dy, t.dz)}: no stance`)
      }
    }
  })

  it('no residence overlap: beds, lights and floors stay clear of the nook', () => {
    const home = residence.castleHome({ site: { ...SITE }, rot: 0, blueprintVersion: 2 })
    const nookLocal = new Set(NOOK.map((c) => k3(c.dx, c.dy, c.dz)))
    const nookWorld = new Set(NOOK.map((c) => k3(SITE.x + c.dx, SITE.y + c.dy, SITE.z + c.dz)))
    for (const l of residence.CASTLE.lights(home)) {
      assert.ok(!nookLocal.has(k3(l.dx, l.dy, l.dz)), `light ${k3(l.dx, l.dy, l.dz)} off the nook`)
    }
    for (const b of residence.CASTLE.beds(home)) {
      for (const p of [b.foot, b.head]) assert.ok(!nookWorld.has(k3(p.x, p.y, p.z)), `bed ${k3(p.x, p.y, p.z)} off the nook`)
    }
    for (const c of NOOK) {
      assert.equal(residence.CASTLE.interior(home, new Vec3(SITE.x + c.dx, SITE.y + c.dy, SITE.z + c.dz)), false, 'decor cells are not floors')
    }
  })
})

// A complete v2 castle (every plan cell painted) and a body that walks
// perfectly. Same shape as the g0z.31/g0z.45 harness.
function castleBot({ rot = 0, items = [], chest = [], loaded = true } = {}) {
  const set = new Map()
  for (const c of blueprint.absPlan(SITE, rot, 2).cells) {
    set.set(k3(c.x, c.y, c.z), PAINT[c.kind])
    if (c.kind === 'door') set.set(k3(c.x, c.y + 1, c.z), 'oak_door')
  }
  const name = (p) => set.has(k3(p.x, p.y, p.z)) ? set.get(k3(p.x, p.y, p.z)) : (Math.floor(p.y) < SITE.y ? 'dirt' : 'air')
  const calls = { places: [], digs: [], withdraw: [], gather: 0 }
  const byName = { chest: { id: 2 } }
  for (const n of ['glass_pane', 'oak_fence', 'oak_planks', 'oak_log', 'stick', 'bookshelf', 'book', 'enchanting_table']) byName[n] = {}
  const bot = {
    username: 'IdkBot',
    calls,
    set,
    loaded,
    chats: [],
    chat(m) { this.chats.push(String(m)) },
    entity: { position: new Vec3(SITE.x + 15.5, SITE.y, SITE.z + 13.5) },
    inventory: { items: () => items },
    time: { timeOfDay: 6000, day: 3 },
    spawnPoint: new Vec3(0, 64, 0),
    players: {},
    entities: {},
    registry: { blocksByName: { chest: { id: 2 } }, itemsByName: byName },
    world: { getBlock: () => null },
    blockAt(p) {
      if (!bot.loaded) return null
      const n = name(p)
      return { name: n, position: new Vec3(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)), boundingBox: n === 'air' ? 'empty' : 'block' }
    },
    findBlocks: () => [...set].filter(([, n]) => n === 'chest').map(([k]) => new Vec3(...k.split(',').map(Number))),
    openChest: async () => ({
      containerItems: () => chest.map((s) => ({ ...s, type: s.name, metadata: null })),
      withdraw: async (type, meta, n) => {
        calls.withdraw.push([type, n])
        const s = chest.find((c) => c.name === type)
        s.count -= n
        const it = items.find((i) => i.name === type)
        if (it) it.count += n
        else items.push({ name: type, count: n })
      },
      close() {},
    }),
    equip: async (item) => { bot.held = item.name },
    placeBlock: async (ref, face) => {
      const p = ref.position.offset(face.x, face.y, face.z)
      calls.places.push(k3(p.x, p.y, p.z))
      set.set(k3(p.x, p.y, p.z), bot.held)
      const it = items.find((i) => i.name === bot.held)
      if (it && --it.count <= 0) items.splice(items.indexOf(it), 1)
    },
    dig: async (b) => { calls.digs.push(k3(b.position.x, b.position.y, b.position.z)) },
    pathfinder: {
      goal: null,
      movements: null,
      isMoving: () => false,
      setGoal(g) {
        bot.pathfinder.goal = g
        const p = g && (g.pos || (typeof g.x === 'number' ? g : null))
        if (p) bot.entity.position = new Vec3(p.x + 0.5, p.y, p.z + (g.pos ? 2.5 : 0.5))
      },
      stop() {},
      setMovements() {},
    },
    clearControlStates() {},
    on() {},
    once() {},
  }
  return bot
}

function completeState(rot = 0) {
  return { site: { ...SITE }, rot, blueprintVersion: 2, phase: 'complete', blocked: {}, parked: false }
}

function closeDecor(bot, rot, except = null) {
  for (const c of blueprint.decorPlan(SITE, rot, 2).cells) {
    if (except && except.has(k3(c.x, c.y, c.z))) continue
    bot.set.set(k3(c.x, c.y, c.z), c.kind === 'pane' ? 'glass_pane' : c.kind === 'banner' ? 'white_wall_banner' : c.kind === 'fence' ? 'oak_fence' : c.kind)
  }
}

describe('castle attic decor behaviour (g0z.49)', () => {
  const realCraft = fetch.deps.craftItem
  const realGather = fetch.deps.gather
  afterEach(() => {
    fetch.deps.craftItem = realCraft
    fetch.deps.gather = realGather
  })

  it('decorOpen lists the nook on a seeded complete castle', () => {
    const bot = castleBot()
    const open = castleMod.decorOpen(bot, completeState(), Date.now())
    assert.equal(open.filter((c) => c.kind === 'bookshelf').length, 5)
    assert.equal(open.filter((c) => c.kind === 'enchanting_table').length, 1)
  })

  for (const [kind, item] of [['bookshelf', 'bookshelf'], ['enchanting_table', 'enchanting_table']]) {
    it(`the tail lays one held ${item}; progress and phase stay complete`, async () => {
      const items = [{ name: item, count: 1 }]
      const bot = castleBot({ items })
      const cell = blueprint.decorPlan(SITE, 0, 2).cells.find((c) => c.kind === kind)
      closeDecor(bot, 0, new Set([k3(cell.x, cell.y, cell.z)]))
      const ctx = { castle: completeState() }
      const cells = blueprint.absPlan(SITE, 0, 2).cells
      castleMod.progress(bot, ctx.castle, cells, ctx)
      const before = { ...ctx.castle.progress }
      assert.equal(before.done, before.total)
      assert.equal(castleMod.batchOf(kind), 1)
      assert.equal(castleMod.menuFact(bot, ctx), `${kind}-batch`)
      for (let i = 0; i < 60 && bot.calls.places.length < 1; i++) {
        castleMod(bot, ctx)
        await settle(); await settle()
      }
      assert.deepEqual(bot.calls.places, [k3(cell.x, cell.y, cell.z)])
      assert.equal(bot.calls.digs.length, 0)
      assert.equal(ctx.castle.phase, 'complete')
      castleMod.progress(bot, ctx.castle, cells, ctx)
      assert.deepEqual(ctx.castle.progress, before)
      castleMod(bot, ctx)
      assert.equal(ctx.stepStatus, 'done')
      assert.equal(castleMod.menuFact(bot, ctx), 'done')
    })
  }

  it('chest shelves are withdrawn for the lay', async () => {
    const items = []
    const bot = castleBot({ items, chest: [{ name: 'bookshelf', count: 5 }] })
    closeDecor(bot, 0)
    for (const c of blueprint.decorPlan(SITE, 0, 2).cells) {
      if (c.kind === 'bookshelf') bot.set.delete(k3(c.x, c.y, c.z))
    }
    const ctx = { castle: completeState() }
    assert.equal(castleMod.menuFact(bot, ctx), 'bookshelf-none')
    for (let i = 0; i < 40 && !bot.calls.withdraw.length; i++) { fetch(bot, ctx); await settle(); await settle() }
    assert.deepEqual(bot.calls.withdraw, [['bookshelf', 5]])
    assert.equal(castleMod.menuFact(bot, ctx), 'bookshelf-batch')
  })

  it('chest books are withdrawn 3 per shelf, then the craft is asked once', async () => {
    const items = []
    const bot = castleBot({ items, chest: [{ name: 'book', count: 15 }] })
    closeDecor(bot, 0)
    for (const c of blueprint.decorPlan(SITE, 0, 2).cells) {
      if (c.kind === 'bookshelf') bot.set.delete(k3(c.x, c.y, c.z))
    }
    const ctx = { castle: completeState() }
    const asked = []
    fetch.deps.craftItem = (b, c, names, n) => { asked.push([names, n]); return 'running' }
    for (let i = 0; i < 40 && !asked.length; i++) { fetch(bot, ctx); await settle(); await settle() }
    assert.deepEqual(bot.calls.withdraw, [['book', 15]])
    assert.deepEqual(asked[0], [['bookshelf'], 1])
  })

  it('books already packed are not withdrawn again (revmux 01 minor)', async () => {
    const items = [{ name: 'book', count: 6 }]
    const bot = castleBot({ items, chest: [{ name: 'book', count: 15 }] })
    closeDecor(bot, 0)
    for (const c of blueprint.decorPlan(SITE, 0, 2).cells) {
      if (c.kind === 'bookshelf') bot.set.delete(k3(c.x, c.y, c.z))
    }
    const ctx = { castle: completeState() }
    const asked = []
    fetch.deps.craftItem = (b, c, names, n) => { asked.push([names, n]); return 'running' }
    for (let i = 0; i < 40 && !asked.length; i++) { fetch(bot, ctx); await settle(); await settle() }
    assert.deepEqual(bot.calls.withdraw, [['book', 9]])
  })

  it('stockpile keeps 3 books per open shelf, banks them once laid (revmux 01 minor)', () => {
    const stockpile = require('../src/behaviours/stockpile')
    const banked = (plan, name) => plan.filter((p) => p.name === name).reduce((a, p) => a + p.count, 0)
    const bot = castleBot({ items: [{ name: 'book', count: 16 }] })
    closeDecor(bot, 0)
    for (const c of blueprint.decorPlan(SITE, 0, 2).cells) {
      if (c.kind === 'bookshelf') bot.set.delete(k3(c.x, c.y, c.z))
    }
    assert.equal(banked(stockpile.depositPlan(bot, { castle: completeState(), home: null }), 'book'), 1)
    closeDecor(bot, 0)
    assert.equal(banked(stockpile.depositPlan(bot, { castle: completeState(), home: null }), 'book'), 16)
    assert.equal(banked(stockpile.depositPlan(bot, { home: null }), 'book'), 16)
  })

  it('a chest table is withdrawn; the stockpile keeps the nook packed', async () => {
    const bot = castleBot({ items: [], chest: [{ name: 'enchanting_table', count: 1 }] })
    closeDecor(bot, 0)
    const table = blueprint.decorPlan(SITE, 0, 2).cells.find((c) => c.kind === 'enchanting_table')
    bot.set.delete(k3(table.x, table.y, table.z))
    const ctx = { castle: completeState() }
    assert.equal(castleMod.menuFact(bot, ctx), 'enchanting_table-none')
    for (let i = 0; i < 40 && !bot.calls.withdraw.length; i++) { fetch(bot, ctx); await settle(); await settle() }
    assert.deepEqual(bot.calls.withdraw, [['enchanting_table', 1]])
    assert.equal(castleMod.menuFact(bot, ctx), 'enchanting_table-batch')
    assert.equal(castleMod.isMaterial('bookshelf', completeState()), true)
    assert.equal(castleMod.isMaterial('enchanting_table', completeState()), true)
    assert.equal(castleMod.isMaterial('bookshelf', { blueprintVersion: 1 }), false)
    const plan = require('../src/behaviours/stockpile').depositPlan(bot, { castle: completeState(), home: null })
    assert.ok(!plan.some((p) => p.name === 'enchanting_table'), JSON.stringify(plan))
  })

  it('no shelves anywhere: the craft is tried, then failed:castlefetch-no-bookshelf (no gather, no hunt)', async () => {
    const bot = castleBot({ items: [], chest: [] })
    closeDecor(bot, 0)
    for (const c of blueprint.decorPlan(SITE, 0, 2).cells) {
      if (c.kind === 'bookshelf') bot.set.delete(k3(c.x, c.y, c.z))
    }
    const ctx = { castle: completeState() }
    assert.equal(castleMod.menuFact(bot, ctx), 'bookshelf-none')
    const asked = []
    fetch.deps.gather = () => { bot.calls.gather++ }
    fetch.deps.craftItem = (b, c, names, n) => { asked.push([names, n]); return { done: false } }
    for (let i = 0; i < 40 && !ctx.stepStatus; i++) { fetch(bot, ctx); await settle(); await settle() }
    assert.equal(ctx.stepStatus, 'failed:castlefetch-no-bookshelf')
    assert.deepEqual(asked, [[['bookshelf'], 1]])
    assert.equal(bot.calls.gather, 0)
    assert.equal(ctx.bring, undefined)
    assert.deepEqual([...ctx.castleFetchDry], ['bookshelf'])
  })

  it('no table anywhere: failed:castlefetch-no-enchanting_table, never crafted (no gather, no hunt)', async () => {
    const bot = castleBot({ items: [], chest: [] })
    closeDecor(bot, 0)
    const table = blueprint.decorPlan(SITE, 0, 2).cells.find((c) => c.kind === 'enchanting_table')
    bot.set.delete(k3(table.x, table.y, table.z))
    const ctx = { castle: completeState() }
    assert.equal(castleMod.menuFact(bot, ctx), 'enchanting_table-none')
    let crafted = 0
    fetch.deps.gather = () => { bot.calls.gather++ }
    fetch.deps.craftItem = () => { crafted++; return { done: false } }
    for (let i = 0; i < 40 && !ctx.stepStatus; i++) { fetch(bot, ctx); await settle(); await settle() }
    assert.equal(ctx.stepStatus, 'failed:castlefetch-no-enchanting_table')
    assert.equal(crafted, 0)
    assert.equal(bot.calls.gather, 0)
    assert.equal(ctx.bring, undefined)
    assert.deepEqual([...ctx.castleFetchDry], ['enchanting_table'])
  })

  it('per-kind dry skip: a table-dry word lays chest shelves; failures accumulate per kind', async () => {
    const chest = []
    const bot = castleBot({ items: [], chest })
    closeDecor(bot, 0)
    for (const c of blueprint.decorPlan(SITE, 0, 2).cells) {
      if (c.kind === 'bookshelf' || c.kind === 'enchanting_table') bot.set.delete(k3(c.x, c.y, c.z))
    }
    const ctx = { castle: completeState() }
    fetch.deps.craftItem = () => ({ done: false })
    assert.equal(castleMod.menuFact(bot, ctx), 'enchanting_table-none')
    for (let i = 0; i < 40 && !ctx.stepStatus; i++) { fetch(bot, ctx); await settle(); await settle() }
    assert.equal(ctx.stepStatus, 'failed:castlefetch-no-enchanting_table')
    assert.deepEqual([...ctx.castleFetchDry], ['enchanting_table'])
    // The owner stocks shelves (no table): the word skips the dry table.
    chest.push({ name: 'bookshelf', count: 5 })
    ctx.stepStatus = 'running'
    ctx.castleFetch = null
    assert.equal(castleMod.menuFact(bot, ctx), 'bookshelf-none')
    assert.equal(fetch.demand(bot, ctx).kind, 'bookshelf')
    for (let i = 0; i < 40 && !bot.calls.withdraw.length; i++) { fetch(bot, ctx); await settle(); await settle() }
    assert.deepEqual(bot.calls.withdraw, [['bookshelf', 5]])
    for (let i = 0; i < 40 && ctx.stepStatus !== 'done'; i++) { fetch(bot, ctx); await settle(); await settle() }
    assert.equal(ctx.stepStatus, 'done')
    assert.equal(ctx.castleFetchDry, null, 'a leg that got stock retires the dry set')
    for (let i = 0; i < 200 && bot.calls.places.length < 5; i++) { castleMod(bot, ctx); await settle(); await settle() }
    assert.equal(bot.calls.places.length, 5)
    assert.equal(ctx.castle.phase, 'complete')
    assert.equal(castleMod.menuFact(bot, ctx), 'enchanting_table-none')
  })

  it('two dry legs accumulate two kinds; all dry retries the first and restarts the cycle', async () => {
    const bot = castleBot({ items: [], chest: [] })
    closeDecor(bot, 0)
    for (const c of blueprint.decorPlan(SITE, 0, 2).cells) {
      if (c.kind === 'bookshelf' || c.kind === 'enchanting_table') bot.set.delete(k3(c.x, c.y, c.z))
    }
    const ctx = { castle: completeState() }
    fetch.deps.craftItem = () => ({ done: false })
    for (let i = 0; i < 40 && !ctx.stepStatus; i++) { fetch(bot, ctx); await settle(); await settle() }
    assert.equal(ctx.stepStatus, 'failed:castlefetch-no-enchanting_table')
    ctx.stepStatus = 'running'
    ctx.castleFetch = null
    assert.equal(castleMod.menuFact(bot, ctx), 'bookshelf-none')
    for (let i = 0; i < 40 && ctx.stepStatus === 'running'; i++) { fetch(bot, ctx); await settle(); await settle() }
    assert.equal(ctx.stepStatus, 'failed:castlefetch-no-bookshelf')
    assert.deepEqual([...ctx.castleFetchDry], ['enchanting_table', 'bookshelf'])
    // Every open kind dry: the word retries the first and clears the set.
    assert.equal(castleMod.menuFact(bot, ctx), 'enchanting_table-none')
    assert.equal(ctx.castleFetchDry, null)
  })

  it('a legacy single-kind dry string still reads as a one-kind set', () => {
    const bot = castleBot()
    closeDecor(bot, 0)
    for (const c of blueprint.decorPlan(SITE, 0, 2).cells) {
      if (c.kind === 'bookshelf' || c.kind === 'enchanting_table') bot.set.delete(k3(c.x, c.y, c.z))
    }
    assert.equal(castleMod.menuFact(bot, { castle: completeState(), castleFetchDry: 'bookshelf' }), 'enchanting_table-none')
    assert.equal(castleMod.menuFact(bot, { castle: completeState(), castleFetchDry: 'enchanting_table' }), 'bookshelf-none')
  })

  it('nook words fire no gather/forage/explore veto and never read blocked', () => {
    const base = { home: 'built', time: 'day', player: 'none', logs: 0, planks: 0, maxPlanks: 0, beds: 'two', known: 'near', health: 20, haul: 'none', inside: 'no' }
    const ctx = { castle: completeState() }
    for (const step of ['gather', 'forage', 'explore']) {
      for (const w of ['bookshelf-none', 'bookshelf-some', 'enchanting_table-none', 'enchanting_table-some']) {
        let a, b
        try { a = goal.MENU[step].feasible({ ...base, castle: w }, null, ctx) } catch (e) { a = String(e) }
        try { b = goal.MENU[step].feasible({ ...base, castle: 'done' }, null, ctx) } catch (e) { b = String(e) }
        assert.equal(a, b, `${step} on ${w}`)
      }
    }
    assert.equal(goal.MENU.forage.feasible({ ...base, castle: 'bookshelf-none' }, null, ctx), true, 'forage still runs (castleBlocked false)')
  })
})

describe('castle bookshelf craft (g0z.49)', () => {
  const IDS = { bookshelf: 301, book: 302, oak_planks: 303, oak_log: 304, crafting_table: 305 }
  function recipeBot(items) {
    const byName = {}
    for (const [n, id] of Object.entries(IDS)) byName[n] = { id }
    return {
      registry: { itemsByName: byName },
      inventory: { items: () => items },
      recipesAll: (id) => id === IDS.bookshelf
        ? [{
          delta: [
            { id: IDS.oak_planks, count: -6 },
            { id: IDS.book, count: -3 },
            { id: IDS.bookshelf, count: 1 },
          ],
          result: { count: 1 },
          requiresTable: true,
        }]
        : [],
    }
  }

  it('craftany plans a bookshelf from 3 books + 6 planks at the pack table', () => {
    const bot = recipeBot([{ name: 'book', count: 3 }, { name: 'oak_planks', count: 6 }, { name: 'crafting_table', count: 1 }])
    const p = craftany.planCraft(bot, {}, ['bookshelf'], 1)
    assert.equal(p.ok, true)
    assert.equal(p.target, 'bookshelf')
    assert.equal(p.requiresTable, true)
    assert.deepEqual(p.needs, [{ name: 'oak_planks', need: 6 }, { name: 'book', need: 3 }])
  })

  it('logs fund the planks layer; short books refuse honestly', () => {
    const bot = recipeBot([{ name: 'book', count: 3 }, { name: 'oak_log', count: 2 }, { name: 'crafting_table', count: 1 }])
    assert.equal(craftany.planCraft(bot, {}, ['bookshelf'], 1).ok, true)
    const short = recipeBot([{ name: 'book', count: 2 }, { name: 'oak_planks', count: 6 }, { name: 'crafting_table', count: 1 }])
    const p = craftany.planCraft(short, {}, ['bookshelf'], 1)
    assert.equal(p.ok, false)
    assert.equal(p.fail, 'missing')
    assert.match(p.line, /book/)
  })
})
