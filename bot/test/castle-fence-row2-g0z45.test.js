'use strict'

// idkcraft-g0z.45: the castle's second fence row — one 'fence' decor cell at
// dy 1 over every v2 fence ring cell, closing the 1-high foothold crossing
// (the carpet trick is rejected: a carpet on the post does not stop a mob
// standing on an adjacent 1-high block). Decor layer like g0z.31/32: the
// PLAN stays frozen, never counted in progress, laid after phase
// 'complete', protected once laid.

const { describe, it, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const Vec3 = require('vec3')
const blueprint = require('../src/castle')
const castleMod = require('../src/behaviours/castle')
const fetch = require('../src/behaviours/castlefetch')
const util = require('../src/behaviours/util')
const reach = require('./castle-reach')
const build = require('../src/behaviours/build')
require('../src/index') // BEHAVIOURS registration (goal.registered)

const V2 = blueprint.BLUEPRINTS[2]
const SITE = { x: 100, y: 64, z: 200 }
const PAINT = { stone: 'cobblestone', planks: 'oak_planks', frame: 'spruce_log', fence: 'oak_fence', door: 'oak_door', chest: 'chest', torch: 'torch', air: 'air', dig: 'air' }
const k3 = (x, y, z) => `${Math.floor(x)},${Math.floor(y)},${Math.floor(z)}`
const settle = () => new Promise((r) => setImmediate(r))
const PLAN_FENCES = V2.PLAN.filter((c) => c.kind === 'fence')
const ROW2 = blueprint.DECOR[2].filter((c) => c.kind === 'fence')

describe('castle second fence row plan (g0z.45)', () => {
  it('one dy-1 fence cell per plan fence cell, count asserted from the plan', () => {
    assert.equal(ROW2.length, PLAN_FENCES.length)
    assert.equal(new Set(ROW2.map((c) => k3(c.dx, c.dy, c.dz))).size, ROW2.length)
    const posts = new Set(PLAN_FENCES.map((c) => k3(c.dx, c.dy, c.dz)))
    for (const c of ROW2) {
      assert.equal(c.kind, 'fence')
      assert.equal(c.dy, 1)
      assert.ok(posts.has(k3(c.dx, 0, c.dz)), `${k3(c.dx, c.dy, c.dz)} sits over a ring post`)
    }
  })

  it('none in the gate gap; the two gap-edge posts get a second row', () => {
    for (const c of ROW2) {
      assert.ok(!(c.dz === 0 && c.dx >= 14 && c.dx <= 16), `${k3(c.dx, c.dy, c.dz)} is in the gap`)
    }
    for (const dx of [13, 17]) {
      assert.ok(ROW2.some((c) => c.dx === dx && c.dy === 1 && c.dz === 0), `edge post ${dx},0 capped`)
    }
  })

  it('append-only: pane and banner idx never renumber', () => {
    const panes = blueprint.DECOR[2].filter((c) => c.kind === 'pane')
    const banners = blueprint.DECOR[2].filter((c) => c.kind === 'banner')
    assert.equal(panes.length, 44)
    assert.equal(banners.length, 2)
    assert.deepEqual(blueprint.DECOR[2].slice(0, 44).map((c) => c.kind), panes.map(() => 'pane'))
    assert.deepEqual(blueprint.DECOR[2].slice(44, 46).map((c) => c.kind), ['banner', 'banner'])
    const dp = blueprint.decorPlan(SITE, 0, 2)
    assert.equal(dp.cells[0].idx, blueprint.DECOR_BASE)
    assert.equal(dp.cells[44].idx, blueprint.DECOR_BASE + 44)
    assert.equal(dp.cells[45].idx, blueprint.DECOR_BASE + 45)
    for (const c of dp.cells.filter((c) => c.kind === 'fence')) assert.ok(c.idx >= blueprint.DECOR_BASE + 46)
  })

  it('the PLAN stays frozen and v1 has no row 2', () => {
    assert.ok(!V2.PLAN.some((c) => c.kind === 'fence' && c.dy === 1))
    assert.equal(blueprint.decorPlan(SITE, 0, 1).cells.filter((c) => c.kind === 'fence').length, 0)
  })

  it('rotations keep every row-2 cell over its post at all 4 rots', () => {
    for (let rot = 0; rot < 4; rot++) {
      const plan = blueprint.absPlan(SITE, rot, 2)
      const row = blueprint.decorPlan(SITE, rot, 2).cells.filter((c) => c.kind === 'fence')
      assert.equal(row.length, PLAN_FENCES.length)
      for (const c of row) {
        const below = plan.at.get(k3(c.x, c.y - 1, c.z))
        assert.ok(below && below.kind === 'fence', `rot ${rot}: ${k3(c.x, c.y, c.z)} over a post`)
        assert.ok(!plan.at.has(k3(c.x, c.y, c.z)), `rot ${rot}: ${k3(c.x, c.y, c.z)} is off-plan`)
      }
    }
  })

  it('reach: every row-2 cell has a walkable stance within PLACE_REACH at all 4 rots', () => {
    for (let rot = 0; rot < 4; rot++) {
      const { w, d } = blueprint.siteDimensions(rot, 2)
      const ent = blueprint.rotatePlan([{ ...V2.ENTRANCE, kind: 'air' }], rot, 2)[0]
      const r = reach.checkPlan({ W: w, D: d, ENTRANCE: ent, PLAN: blueprint.rotatePlan(V2.PLAN, rot, 2) }, blueprint.isPlaceTarget)
      assert.ok(r.ok, `rot ${rot} cell ${r.idx}: ${r.reason}`)
      for (const t of blueprint.rotatePlan(ROW2, rot, 2)) {
        const ok = reach.flood(r.grid, ent, (sx, sy, sz) => {
          if (sx === t.dx && sz === t.dz && (sy === t.dy || sy + 1 === t.dy)) return false
          return Math.hypot(sx - t.dx, sy + 1.6 - t.dy - 0.5, sz - t.dz) <= build.PLACE_REACH
        })
        assert.ok(ok, `rot ${rot} fence ${k3(t.dx, t.dy, t.dz)}: no stance`)
      }
    }
  })

  it('matches/protects a laid upper fence', () => {
    assert.ok(blueprint.matches('fence', 'oak_fence'))
    assert.ok(blueprint.matches('fence', 'birch_fence'))
    assert.ok(!blueprint.matches('fence', 'oak_fence_gate'))
    const st = { site: SITE, rot: 1, blueprintVersion: 2, phase: 'complete' }
    const c = blueprint.decorPlan(SITE, 1, 2).cells.find((o) => o.kind === 'fence')
    assert.equal(blueprint.protects(st, c, 'oak_fence'), true)
    assert.equal(blueprint.protects(st, c, 'dirt'), false)
    const block = { name: 'oak_fence', position: new Vec3(c.x, c.y, c.z) }
    for (const extra of [{}, { castleClear: true }, { castleClear: 'emptied' }]) {
      assert.equal(util.protectedReason({}, block, { castle: st, ...extra }), 'protected')
    }
  })
})

// A complete v2 castle (every plan cell painted) and a body that walks
// perfectly: a place goal stands it 2 off the cell. Same shape as the
// g0z.31 harness.
function castleBot({ rot = 0, items = [], chest = [], loaded = true } = {}) {
  const set = new Map()
  for (const c of blueprint.absPlan(SITE, rot, 2).cells) {
    set.set(k3(c.x, c.y, c.z), PAINT[c.kind])
    if (c.kind === 'door') set.set(k3(c.x, c.y + 1, c.z), 'oak_door')
  }
  const name = (p) => set.has(k3(p.x, p.y, p.z)) ? set.get(k3(p.x, p.y, p.z)) : (Math.floor(p.y) < SITE.y ? 'dirt' : 'air')
  const calls = { places: [], digs: [], withdraw: [], gather: 0 }
  const byName = { chest: { id: 2 } }
  for (const n of ['glass_pane', 'oak_fence', 'birch_fence', 'oak_planks', 'oak_log', 'stick']) byName[n] = {}
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
    bot.set.set(k3(c.x, c.y, c.z), c.kind === 'pane' ? 'glass_pane' : c.kind === 'banner' ? 'white_wall_banner' : 'oak_fence')
  }
}

describe('castle second fence row behaviour (g0z.45)', () => {
  const realCraft = fetch.deps.craftItem
  const realGather = fetch.deps.gather
  afterEach(() => {
    fetch.deps.craftItem = realCraft
    fetch.deps.gather = realGather
  })

  it('decorOpen lists the row on a seeded complete castle', () => {
    const bot = castleBot()
    const open = castleMod.decorOpen(bot, completeState(), Date.now())
    assert.equal(open.filter((c) => c.kind === 'fence').length, PLAN_FENCES.length)
  })

  it('the tail lays held fences on the lower posts; progress and phase stay complete', async () => {
    const items = [{ name: 'oak_fence', count: 16 }]
    const bot = castleBot({ items })
    const refs = []
    const place = bot.placeBlock
    bot.placeBlock = (ref, face) => { refs.push([k3(ref.position.x, ref.position.y, ref.position.z), [face.x, face.y, face.z]]); return place(ref, face) }
    closeDecor(bot, 0) // panes and banners glazed: only the row is open
    for (const c of blueprint.decorPlan(SITE, 0, 2).cells) {
      if (c.kind === 'fence') bot.set.delete(k3(c.x, c.y, c.z))
    }
    const ctx = { castle: completeState() }
    const cells = blueprint.absPlan(SITE, 0, 2).cells
    castleMod.progress(bot, ctx.castle, cells, ctx)
    const before = { ...ctx.castle.progress }
    assert.equal(before.done, before.total)
    assert.equal(castleMod.batchOf('fence'), 16)
    assert.equal(castleMod.menuFact(bot, ctx), 'fence-batch')
    for (let i = 0; i < 200 && bot.calls.places.length < 16; i++) {
      castleMod(bot, ctx)
      await settle(); await settle()
    }
    assert.equal(bot.calls.places.length, 16)
    const decor = blueprint.decorPlan(SITE, 0, 2).at
    for (const k of bot.calls.places) assert.equal(decor.get(k).kind, 'fence')
    for (const [rk, face] of refs) {
      assert.deepEqual(face, [0, 1, 0], `${rk}: placed on the lower post's top face`)
      assert.equal(bot.set.get(rk), 'oak_fence')
    }
    assert.equal(bot.calls.digs.length, 0)
    assert.equal(ctx.castle.phase, 'complete')
    castleMod.progress(bot, ctx.castle, cells, ctx)
    assert.deepEqual(ctx.castle.progress, before)
    castleMod(bot, ctx)
    assert.equal(ctx.stepStatus, 'done')
    assert.equal(castleMod.menuFact(bot, ctx), 'fence-none')
  })

  it('a chest-dry fence word does not starve the pane and banner legs', () => {
    const bot = castleBot()
    const dry = { castle: completeState(), castleFetchDry: 'fence' }
    assert.equal(castleMod.menuFact(bot, dry), 'pane-none')
    assert.equal(fetch.demand(bot, dry).kind, 'pane')
    const dryPane = { castle: completeState(), castleFetchDry: 'pane' }
    assert.equal(castleMod.menuFact(bot, dryPane), 'banner-none')
  })

  it('stockpile keeps held fences while the row is open and banks them once laid', () => {
    const stockpile = require('../src/behaviours/stockpile')
    const bot = castleBot({ items: [{ name: 'oak_fence', count: 5 }, { name: 'rotten_flesh', count: 3 }] })
    const open = stockpile.depositPlan(bot, { castle: completeState(), home: null })
    assert.ok(!open.some((p) => p.name === 'oak_fence'), JSON.stringify(open))
    assert.ok(open.some((p) => p.name === 'rotten_flesh'), JSON.stringify(open))
    closeDecor(bot, 0)
    const laid = stockpile.depositPlan(bot, { castle: completeState(), home: null })
    assert.deepEqual(laid.filter((p) => p.name === 'oak_fence'), [{ name: 'oak_fence', count: 5 }])
  })

  it('stockpile bounds the pane/banner keep by the open demand (no name list)', () => {
    const stockpile = require('../src/behaviours/stockpile')
    const bot = castleBot({ items: [{ name: 'glass_pane', count: 50 }, { name: 'white_banner', count: 3 }] })
    const open = stockpile.depositPlan(bot, { castle: completeState(), home: null })
    assert.deepEqual(open.filter((p) => p.name === 'glass_pane'), [{ name: 'glass_pane', count: 6 }], '44 open panes keep 44')
    assert.deepEqual(open.filter((p) => p.name === 'white_banner'), [{ name: 'white_banner', count: 1 }], '2 open banners keep 2')
  })

  it('the band sweep skips a laid upper fence but clears own scaffold from an open row cell', () => {
    const key = (x, y, z) => `${x},${y},${z}`
    const cells = new Map()
    for (const c of blueprint.absPlan(SITE, 0, 2).cells) {
      if (blueprint.isPlaceTarget(c.kind)) cells.set(key(c.x, c.y, c.z), PAINT[c.kind])
    }
    const row = blueprint.decorPlan(SITE, 0, 2).cells.filter((c) => c.kind === 'fence')
    const [laid, open] = [row[0], row[1]]
    for (const c of row.slice(2)) cells.set(key(c.x, c.y, c.z), 'oak_fence')
    cells.set(key(laid.x, laid.y, laid.z), 'oak_fence')
    cells.set(key(open.x, open.y, open.z), 'cobblestone')
    const bot = castleBot()
    bot.set.clear()
    for (const [k, v] of cells) bot.set.set(k, v)
    const placed = new Set([key(laid.x, laid.y, laid.z), key(open.x, open.y, open.z)])
    const list = castleMod.litterTargets(bot, { castle: completeState(), placedByBot: placed }, completeState(), Date.now())
    const got = list.map((c) => key(c.x, c.y, c.z))
    assert.ok(!got.includes(key(laid.x, laid.y, laid.z)), 'a laid upper fence is never litter')
    assert.ok(got.includes(key(open.x, open.y, open.z)), 'own scaffold in an open row cell still clears')
  })

  it('fence words run the existing chest -> craft -> gather fetch (no new leg)', async () => {
    const items = []
    const bot = castleBot({ items, chest: [{ name: 'oak_fence', count: 40 }] })
    closeDecor(bot, 0)
    for (const c of blueprint.decorPlan(SITE, 0, 2).cells) {
      if (c.kind === 'fence') bot.set.delete(k3(c.x, c.y, c.z))
    }
    const ctx = { castle: completeState() }
    assert.equal(castleMod.menuFact(bot, ctx), 'fence-none')
    for (let i = 0; i < 40 && !bot.calls.withdraw.length; i++) { fetch(bot, ctx); await settle(); await settle() }
    assert.deepEqual(bot.calls.withdraw, [['oak_fence', 16]])
    assert.equal(castleMod.menuFact(bot, ctx), 'fence-batch')
  })
})
