'use strict'

// idkcraft-g0z.31: the castle decor layer — glass panes in every v2 window
// opening, laid after phase 'complete', never counted in progress,
// chest-supplied only (no sand/smelt pipeline).

const { describe, it, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const Vec3 = require('vec3')
const blueprint = require('../src/castle')
const castleMod = require('../src/behaviours/castle')
const fetch = require('../src/behaviours/castlefetch')
const util = require('../src/behaviours/util')
const goal = require('../src/goal')
const reach = require('./castle-reach')
const build = require('../src/behaviours/build')
const residence = require('../src/residence')
const bedsMod = require('../src/behaviours/beds')
const bedMod = require('../src/behaviours/bed')
require('../src/index') // BEHAVIOURS registration (goal.registered)

const V2 = blueprint.BLUEPRINTS[2]
const SITE = { x: 100, y: 64, z: 200 }
const PAINT = { stone: 'cobblestone', planks: 'oak_planks', frame: 'spruce_log', fence: 'oak_fence', door: 'oak_door', chest: 'chest', torch: 'torch', air: 'air', dig: 'air' }
const k3 = (x, y, z) => `${Math.floor(x)},${Math.floor(y)},${Math.floor(z)}`
const settle = () => new Promise((r) => setImmediate(r))

describe('castle decor plan (g0z.31)', () => {
  const D = blueprint.DECOR[2].filter((c) => c.kind === 'pane') // g0z.32 appends 2 banners
  const air = new Map(V2.PLAN.filter((c) => c.kind === 'air').map((c) => [k3(c.dx, c.dy, c.dz), c]))

  it('covers exactly the v2 window openings', () => {
    assert.equal(D.length, 44) // 28 tower windows + 6 low + 10 high wall windows
    assert.equal(new Set(D.map((c) => k3(c.dx, c.dy, c.dz))).size, D.length)
    for (const c of D) {
      assert.equal(c.kind, 'pane')
      assert.ok(air.has(k3(c.dx, c.dy, c.dz)), `${k3(c.dx, c.dy, c.dz)} is a keep-clear plan cell`)
      assert.ok(c.dx === 7 || c.dx === 23 || c.dz === 7 || c.dz === 19, 'on the outer wall line')
      assert.ok(!(c.dx === V2.DOOR.dx && c.dz === V2.DOOR.dz), 'not the gate doorway')
    }
    const not = [[8, 3, 12], [9, 3, 12], [10, 3, 12], [18, 7, 8], [18, 7, 9], [18, 7, 10], [13, 0, 14], [13, 1, 14], [17, 4, 14], [19, 5, 13]]
    for (const [x, y, z] of not) assert.ok(!D.some((c) => c.dx === x && c.dy === y && c.dz === z), `${x},${y},${z} is no window`)
    // Every wall winLow/winHigh opening is in.
    for (const [x, z] of [[13, 7], [17, 7], [13, 19], [17, 19], [7, 13], [23, 13]]) assert.ok(D.some((c) => c.dx === x && c.dy === 1 && c.dz === z))
    assert.equal(D.filter((c) => c.dy === 5 && c.dx >= 12 && c.dx <= 18).length + D.filter((c) => c.dy === 5 && (c.dx === 7 || c.dx === 23) && c.dz === 13).length, 10)
  })

  it('the PLAN stays frozen and v1 has no decor', () => {
    assert.ok(!V2.PLAN.some((c) => c.kind === 'pane'))
    assert.equal(blueprint.decorPlan(SITE, 0, 1).cells.length, 0)
  })

  it('decorPlan rotates with the plan for all 4 rots, off-plan idx', () => {
    for (let rot = 0; rot < 4; rot++) {
      const plan = blueprint.absPlan(SITE, rot, 2)
      const dp = blueprint.decorPlan(SITE, rot, 2)
      const panes = dp.cells.filter((c) => c.kind === 'pane')
      assert.equal(panes.length, 44)
      for (const c of panes) {
        assert.ok(c.idx >= blueprint.DECOR_BASE)
        const p = plan.at.get(k3(c.x, c.y, c.z))
        assert.ok(p && p.kind === 'air', `rot ${rot}: ${k3(c.x, c.y, c.z)} over a window air cell`)
      }
    }
  })

  it('matches pane: plain and stained', () => {
    assert.ok(blueprint.matches('pane', 'glass_pane'))
    assert.ok(blueprint.matches('pane', 'red_stained_glass_pane'))
    assert.ok(!blueprint.matches('pane', 'glass'))
    assert.ok(!blueprint.matches('pane', 'air'))
  })

  it('protects a laid pane at a decor cell, not another occupant; every dig path refuses it', () => {
    const st = { site: SITE, rot: 1, blueprintVersion: 2, phase: 'complete' }
    const c = blueprint.decorPlan(SITE, 1, 2).cells[5]
    assert.equal(blueprint.protects(st, c, 'glass_pane'), true)
    assert.equal(blueprint.protects(st, c, 'lime_stained_glass_pane'), true)
    assert.equal(blueprint.protects(st, c, 'dirt'), false)
    const block = { name: 'glass_pane', position: new Vec3(c.x, c.y, c.z) }
    for (const extra of [{}, { castleClear: true }, { castleClear: 'emptied' }]) {
      assert.equal(util.protectedReason({}, block, { castle: st, ...extra }), 'protected')
    }
  })

  // The plan keeps the strict findRef model (below face, LOS). A pane is
  // checked on the bead's reach claim: a stance walkable from the gate
  // with the eye within build.PLACE_REACH of the cell (far()'s test; the
  // server checks click distance, not line of sight). The strict model
  // passes for 34-38/44 by rot; the stair-side tower windows hide their below
  // face behind a step/landing — a pane that never lands there blocks and
  // retires like any hole (rig parity measures it, batched).
  it('reach: PLAN + DECOR at all 4 rots (panes: a walkable stance within PLACE_REACH)', () => {
    for (let rot = 0; rot < 4; rot++) {
      const { w, d } = blueprint.siteDimensions(rot, 2)
      const ent = blueprint.rotatePlan([{ ...V2.ENTRANCE, kind: 'air' }], rot, 2)[0]
      const r = reach.checkPlan({ W: w, D: d, ENTRANCE: ent, PLAN: blueprint.rotatePlan(V2.PLAN, rot, 2) }, blueprint.isPlaceTarget)
      assert.ok(r.ok, `rot ${rot} cell ${r.idx}: ${r.reason}`)
      const g = r.grid
      let strict = 0
      for (const t of blueprint.rotatePlan(D, rot, 2)) {
        if (reach.checkCell(g, ent, t).ok) strict++
        const ok = reach.flood(g, ent, (sx, sy, sz) => {
          if (sx === t.dx && sz === t.dz && (sy === t.dy || sy + 1 === t.dy)) return false
          return Math.hypot(sx - t.dx, sy + 1.6 - t.dy - 0.5, sz - t.dz) <= build.PLACE_REACH
        })
        assert.ok(ok, `rot ${rot} pane ${k3(t.dx, t.dy, t.dz)}: no stance`)
      }
      assert.ok(strict >= 34, `rot ${rot}: strict findRef model ${strict}`)
    }
  })
})

// A complete v2 castle (every plan cell painted, the castle chest included)
// and a body that walks perfectly: a place goal stands it 2 off the cell.
function castleBot({ rot = 0, items = [], chest = [], loaded = true } = {}) {
  const set = new Map()
  for (const c of blueprint.absPlan(SITE, rot, 2).cells) {
    set.set(k3(c.x, c.y, c.z), PAINT[c.kind])
    if (c.kind === 'door') set.set(k3(c.x, c.y + 1, c.z), 'oak_door')
  }
  const name = (p) => set.has(k3(p.x, p.y, p.z)) ? set.get(k3(p.x, p.y, p.z)) : (Math.floor(p.y) < SITE.y ? 'dirt' : 'air')
  const calls = { places: [], digs: [], withdraw: [], gather: 0 }
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
    registry: { blocksByName: { chest: { id: 2 } }, itemsByName: { glass_pane: {}, red_stained_glass_pane: {}, glass: {} } },
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

// g0z.35: the first n residence beds standing (foot + head).
function paintBeds(bot, home, n) {
  for (const b of residence.of(home).beds(home).slice(0, n)) for (const p of [b.foot, b.head]) bot.set.set(k3(p.x, p.y, p.z), 'red_bed')
}

describe('castle decor behaviour (g0z.31)', () => {
  const realCraft = fetch.deps.craftItem
  const realGather = fetch.deps.gather
  afterEach(() => {
    fetch.deps.craftItem = realCraft
    fetch.deps.gather = realGather
  })

  for (const rot of [0, 1, 2, 3]) {
    it(`rot ${rot}: 16 panes in the pack are laid in the windows; progress and phase stay complete`, async () => {
      const items = [{ name: 'glass_pane', count: 16 }]
      const bot = castleBot({ rot, items })
      const ctx = { castle: completeState(rot) }
      const cells = blueprint.absPlan(SITE, rot, 2).cells
      castleMod.progress(bot, ctx.castle, cells, ctx)
      const before = { ...ctx.castle.progress }
      assert.equal(before.done, before.total)
      assert.equal(castleMod.menuFact(bot, ctx), 'pane-batch')
      for (let i = 0; i < 200 && bot.calls.places.length < 16; i++) {
        castleMod(bot, ctx)
        await settle(); await settle()
      }
      assert.equal(bot.calls.places.length, 16)
      const decor = blueprint.decorPlan(SITE, rot, 2).at
      for (const k of bot.calls.places) assert.ok(decor.has(k), `${k} is a window`)
      assert.equal(bot.calls.digs.length, 0)
      assert.equal(ctx.castle.phase, 'complete')
      castleMod.progress(bot, ctx.castle, cells, ctx)
      assert.deepEqual(ctx.castle.progress, before)
      // Out of panes: the step ends done, the word asks for more.
      castleMod(bot, ctx)
      assert.equal(ctx.stepStatus, 'done')
      assert.equal(castleMod.menuFact(bot, ctx), 'pane-none')
    })
  }

  it('a sub-batch remainder (4 panes, empty chest) is a batch and is laid (revmux 01)', async () => {
    const items = [{ name: 'glass_pane', count: 4 }]
    const bot = castleBot({ items })
    const ctx = { castle: completeState() }
    assert.equal(castleMod.menuFact(bot, ctx), 'pane-batch')
    for (let i = 0; i < 60 && bot.calls.places.length < 4; i++) { castleMod(bot, ctx); await settle(); await settle() }
    assert.equal(bot.calls.places.length, 4)
    assert.equal(castleMod.menuFact(bot, ctx), 'pane-none')
  })

  it('off site a complete castle reads done (no yank-back for cosmetics)', () => {
    const bot = castleBot({ items: [{ name: 'glass_pane', count: 16 }], loaded: false })
    assert.equal(castleMod.menuFact(bot, { castle: completeState() }), 'done')
  })

  it('all windows glazed: done; an owner block in a window is left alone', () => {
    const bot = castleBot({ items: [{ name: 'glass_pane', count: 16 }] })
    const cells = blueprint.decorPlan(SITE, 0, 2).cells
    cells.forEach((c, i) => bot.set.set(k3(c.x, c.y, c.z), i === 0 ? 'oak_leaves' : c.kind === 'banner' ? 'white_wall_banner' : 'glass_pane'))
    const ctx = { castle: completeState() }
    assert.equal(castleMod.menuFact(bot, ctx), 'done')
    castleMod(bot, ctx)
    assert.equal(ctx.stepStatus, 'done')
    assert.equal(bot.calls.digs.length + bot.calls.places.length, 0)
  })

  it('no panes anywhere: pane-none, the chest source runs, the leg fails no-pane (no gather)', async () => {
    const bot = castleBot({ items: [], chest: [] })
    const ctx = { castle: completeState() }
    assert.equal(castleMod.menuFact(bot, ctx), 'pane-none')
    fetch.deps.gather = () => { bot.calls.gather++ }
    fetch.deps.craftItem = () => ({ done: false })
    for (let i = 0; i < 40 && ctx.stepStatus !== 'failed:castlefetch-no-pane'; i++) {
      fetch(bot, ctx)
      await settle(); await settle()
    }
    assert.equal(ctx.stepStatus, 'failed:castlefetch-no-pane')
    assert.equal(bot.calls.gather, 0)
    assert.equal(ctx.castle.phase, 'complete')
  })

  it('chest panes are withdrawn; chest glass is withdrawn for the craft', async () => {
    const items = []
    const bot = castleBot({ items, chest: [{ name: 'glass_pane', count: 40 }] })
    const ctx = { castle: completeState() }
    fetch(bot, ctx)
    for (let i = 0; i < 40 && !bot.calls.withdraw.length; i++) { fetch(bot, ctx); await settle(); await settle() }
    assert.deepEqual(bot.calls.withdraw, [['glass_pane', 16]])
    assert.equal(castleMod.menuFact(bot, ctx), 'pane-batch')

    const items2 = []
    const bot2 = castleBot({ items: items2, chest: [{ name: 'glass', count: 20 }] })
    const ctx2 = { castle: completeState() }
    const asked = []
    fetch.deps.craftItem = (b, c, names, n) => { asked.push([names, n]); return 'running' }
    for (let i = 0; i < 40 && !asked.length; i++) { fetch(bot2, ctx2); await settle(); await settle() }
    assert.deepEqual(bot2.calls.withdraw, [['glass', 6]])
    assert.deepEqual(asked[0], [['glass_pane'], 16])
  })

  it('pane words fire no gather/forage/explore veto and never read blocked', () => {
    const base = { home: 'built', time: 'day', player: 'none', logs: 0, planks: 0, maxPlanks: 0, beds: 'two', known: 'near', health: 20, haul: 'none', inside: 'no' }
    const ctx = { castle: completeState() }
    for (const step of ['gather', 'forage', 'explore']) {
      for (const w of ['pane-none', 'pane-some']) {
        let a, b
        try { a = goal.MENU[step].feasible({ ...base, castle: w }, null, ctx) } catch (e) { a = String(e) }
        try { b = goal.MENU[step].feasible({ ...base, castle: 'done' }, null, ctx) } catch (e) { b = String(e) }
        assert.equal(a, b, `${step} on ${w}`)
      }
    }
    assert.equal(goal.MENU.forage.feasible({ ...base, castle: 'pane-none' }, null, ctx), true, 'forage still runs (castleBlocked false)')
  })

  it('stockpile keeps chest panes packed past complete (no bank<->fetch loop)', () => {
    assert.equal(castleMod.isMaterial('glass_pane', completeState()), true)
    assert.equal(castleMod.isMaterial('glass_pane', { blueprintVersion: 1 }), false)
    const stockpile = require('../src/behaviours/stockpile')
    const bot = castleBot({ items: [{ name: 'glass_pane', count: 5 }, { name: 'rotten_flesh', count: 3 }] })
    const plan = stockpile.depositPlan(bot, { castle: completeState(), home: null })
    assert.ok(!plan.some((p) => p.name === 'glass_pane'), JSON.stringify(plan))
  })
})

// idkcraft-g0z.32: two wall banners flanking the gate — decor cells hung on
// the gate wall's outward face from the apron, chest-only, never crafted.
describe('castle gate banners (g0z.32)', () => {
  const realCraft = fetch.deps.craftItem
  const realGather = fetch.deps.gather
  afterEach(() => {
    fetch.deps.craftItem = realCraft
    fetch.deps.gather = realGather
  })
  const banners = (rot) => blueprint.decorPlan(SITE, rot, 2).cells.filter((c) => c.kind === 'banner')
  const paintPanes = (bot, rot) => {
    for (const c of blueprint.decorPlan(SITE, rot, 2).cells) if (c.kind === 'pane') bot.set.set(k3(c.x, c.y, c.z), 'glass_pane')
  }

  it('decorPlan holds 2 banners at all 4 rots: outside the gate wall, door x +-2, wall ref behind', () => {
    assert.deepEqual(blueprint.DECOR[2].filter((c) => c.kind === 'banner').map((c) => k3(c.dx, c.dy, c.dz)), ['13,2,6', '17,2,6'])
    for (let rot = 0; rot < 4; rot++) {
      const plan = blueprint.absPlan(SITE, rot, 2)
      const door = plan.cells.find((c) => c.kind === 'door')
      const e = blueprint.rotatePlan([{ ...V2.ENTRANCE, kind: 'air' }], rot, 2)[0]
      const ent = { x: SITE.x + e.dx, z: SITE.z + e.dz }
      const n = { x: Math.sign(ent.x - door.x), z: Math.sign(ent.z - door.z) } // outward normal
      const bs = banners(rot)
      assert.equal(bs.length, 2)
      const side = []
      for (const b of bs) {
        assert.ok(b.idx >= blueprint.DECOR_BASE + 44)
        assert.equal(b.y, door.y + 2)
        assert.equal((b.x - door.x) * n.x + (b.z - door.z) * n.z, 1, `rot ${rot}: one out from the gate wall, entrance side`)
        side.push((b.x - door.x) * n.z + (b.z - door.z) * n.x)
        assert.deepEqual([b.x - b.wall.x, b.y - b.wall.y, b.z - b.wall.z], [n.x, 0, n.z], `rot ${rot}: face = outward normal`)
        assert.equal(plan.at.get(k3(b.wall.x, b.wall.y, b.wall.z)).kind, 'stone')
        assert.ok(!plan.at.has(k3(b.x, b.y, b.z)), 'off-plan cell')
      }
      assert.deepEqual(side.map(Math.abs), [2, 2])
      assert.equal(side[0] + side[1], 0)
    }
  })

  it('matches/protects a laid wall banner', () => {
    assert.ok(blueprint.matches('banner', 'white_wall_banner'))
    assert.ok(blueprint.matches('banner', 'red_banner'))
    assert.ok(!blueprint.matches('banner', 'flower_banner_pattern'))
    const st = { site: SITE, rot: 2, blueprintVersion: 2, phase: 'complete' }
    const b = banners(2)[0]
    assert.equal(blueprint.protects(st, b, 'white_wall_banner'), true)
    assert.equal(util.protectedReason({}, { name: 'white_wall_banner', position: new Vec3(b.x, b.y, b.z) }, { castle: st, castleClear: true }), 'protected')
  })

  for (const rot of [0, 1, 2, 3]) {
    it(`rot ${rot}: 2 white banners in the pack hang on the wall's outward face from the apron`, async () => {
      const items = [{ name: 'white_banner', count: 2 }]
      const bot = castleBot({ rot, items })
      const refs = []
      const place = bot.placeBlock
      bot.placeBlock = (ref, face) => { refs.push([k3(ref.position.x, ref.position.y, ref.position.z), [face.x, face.y, face.z]]); return place(ref, face) }
      // A scaffold block under each banner cell (findRef's first pick: a
      // standing banner) and the windows glazed, but one pane still open
      // and none held: the held banners word first.
      for (const c of banners(rot)) bot.set.set(k3(c.x, c.y - 1, c.z), 'cobblestone')
      paintPanes(bot, rot)
      const open = blueprint.decorPlan(SITE, rot, 2).cells[0]
      bot.set.delete(k3(open.x, open.y, open.z))
      const ctx = { castle: completeState(rot) }
      const cells = blueprint.absPlan(SITE, rot, 2).cells
      castleMod.progress(bot, ctx.castle, cells, ctx)
      const before = { ...ctx.castle.progress }
      assert.equal(castleMod.menuFact(bot, ctx), 'banner-batch')
      for (let i = 0; i < 60 && refs.length < 2; i++) { castleMod(bot, ctx); await settle(); await settle() }
      const want = banners(rot).map((b) => [k3(b.wall.x, b.wall.y, b.wall.z), [b.x - b.wall.x, 0, b.z - b.wall.z]])
      assert.deepEqual(refs.sort(), want.sort())
      assert.equal(ctx.castle.phase, 'complete')
      castleMod.progress(bot, ctx.castle, cells, ctx)
      assert.deepEqual(ctx.castle.progress, before)
      assert.equal(castleMod.menuFact(bot, ctx), 'pane-none')
    })
  }

  // g0z.35: chest-only while the castle residence still owes a bed.
  for (const n of [0, 1]) {
    it(`no banner, empty chest, beds ${n ? 'one' : 'none'}: banner-none, fails no-banner (no craft, no hunt, no gather)`, async () => {
      const bot = castleBot({ items: [{ name: 'white_wool', count: 6 }], chest: [{ name: 'white_wool', count: 6 }] })
      paintPanes(bot, 0)
      const ctx = { castle: completeState(), home: residence.castleHome(completeState()) }
      paintBeds(bot, ctx.home, n)
      assert.equal(bedsMod.bedsFact(bot, ctx.home), n ? 'one' : 'none')
      assert.equal(castleMod.menuFact(bot, ctx), 'banner-none')
      let crafted = 0
      fetch.deps.gather = () => { bot.calls.gather++ }
      fetch.deps.craftItem = () => { crafted++; return { done: false } }
      for (let i = 0; i < 40 && ctx.stepStatus !== 'failed:castlefetch-no-banner'; i++) { fetch(bot, ctx); await settle(); await settle() }
      assert.equal(ctx.stepStatus, 'failed:castlefetch-no-banner')
      assert.equal(bot.calls.gather + crafted, 0)
      assert.equal(ctx.bring, undefined)
      assert.deepEqual(bot.calls.withdraw, []) // the chest wool stays for the beds
      assert.equal(ctx.castleFetchDry, 'banner')
    })
  }

  it('no panes anywhere, banners in the chest: the dry pane leg hands the word to banner (revmux 01)', async () => {
    const bot = castleBot({ items: [], chest: [{ name: 'white_banner', count: 2 }] })
    bot.registry.itemsByName.white_banner = {}
    const ctx = { castle: completeState() }
    fetch.deps.craftItem = () => ({ done: false })
    assert.equal(castleMod.menuFact(bot, ctx), 'pane-none')
    for (let i = 0; i < 40 && ctx.stepStatus !== 'failed:castlefetch-no-pane'; i++) { fetch(bot, ctx); await settle(); await settle() }
    assert.equal(ctx.stepStatus, 'failed:castlefetch-no-pane')
    assert.equal(castleMod.menuFact(bot, ctx), 'banner-none')
    ctx.stepStatus = 'running'
    ctx.castleFetch = null
    for (let i = 0; i < 40 && !bot.calls.withdraw.length; i++) { fetch(bot, ctx); await settle(); await settle() }
    assert.deepEqual(bot.calls.withdraw, [['white_banner', 2]])
    assert.equal(castleMod.menuFact(bot, ctx), 'banner-batch')
  })

  it('chest banners are withdrawn; the stockpile keeps them packed', async () => {
    const bot = castleBot({ items: [], chest: [{ name: 'white_banner', count: 3 }] })
    bot.registry.itemsByName.white_banner = {}
    paintPanes(bot, 0)
    const ctx = { castle: completeState() }
    for (let i = 0; i < 40 && !bot.calls.withdraw.length; i++) { fetch(bot, ctx); await settle(); await settle() }
    assert.deepEqual(bot.calls.withdraw, [['white_banner', 2]])
    assert.equal(castleMod.menuFact(bot, ctx), 'banner-batch')
    const plan = require('../src/behaviours/stockpile').depositPlan(bot, { castle: completeState(), home: null })
    assert.ok(!plan.some((p) => p.name === 'white_banner'), JSON.stringify(plan))
  })
})

// idkcraft-g0z.35: the banners self-source once the beds stand — a castle
// self wool hunt (the beds woolTick order shape), then a table craft.
describe('castle banners self-source (g0z.35)', () => {
  const realCraft = fetch.deps.craftItem
  afterEach(() => { fetch.deps.craftItem = realCraft })
  const BANNERS = bedMod.BED_COLORS.map((c) => `${c}_banner`).sort()
  function selfBot({ items = [], chest = [], night = false } = {}) {
    const bot = castleBot({ items, chest })
    for (const c of bedMod.BED_COLORS) for (const s of ['banner', 'wall_banner', 'wool']) bot.registry.itemsByName[`${c}_${s}`] = {}
    if (night) bot.time.timeOfDay = 13000
    for (const c of blueprint.decorPlan(SITE, 0, 2).cells) if (c.kind === 'pane') bot.set.set(k3(c.x, c.y, c.z), 'glass_pane')
    const ctx = { castle: completeState(), home: residence.castleHome(completeState()) }
    paintBeds(bot, ctx.home, 2)
    assert.equal(bedsMod.bedsFact(bot, ctx.home), 'both')
    return { bot, ctx }
  }
  const run = async (bot, ctx, until, n = 40) => {
    for (let i = 0; i < n && !until(); i++) { fetch(bot, ctx); await settle(); await settle() }
  }

  it('beds both, empty chest, no wool: a castle self wool hunt for 12; the refuse fails no-wool and arms the shared latch', async () => {
    const { bot, ctx } = selfBot()
    const crafts = []
    fetch.deps.craftItem = (b, c, names, count) => { crafts.push([names.slice().sort(), count]); return { done: false } }
    await run(bot, ctx, () => ctx.bring)
    assert.deepEqual(crafts, [[BANNERS, 1]])
    const o = ctx.bring
    assert.equal(o.kind, 'item')
    assert.equal(o.name, 'wool')
    assert.equal(o.self, 'castle')
    assert.equal(o.want, 12)
    assert.equal(ctx.castleFetch.hunt, o)
    // While the hunt runs the leg holds: no status, the order untouched.
    for (let i = 0; i < 5; i++) fetch(bot, ctx)
    assert.equal(ctx.bring, o)
    assert.equal(ctx.stepStatus, undefined)
    ctx.step = 'castlefetch'
    ctx.stepStatus = 'running'
    const facts = { castle: castleMod.menuFact(bot, ctx), time: 'day' }
    assert.equal(facts.castle, 'banner-none')
    assert.equal(goal.MENU.castlefetch.feasible(facts, bot, ctx), true) // no re-pick churn
    // bring refuses an exhausted search (refuseExhausted shape).
    o.searchLegs = { legs: 24, timedOut: false, capped: false }
    ctx.bring = null
    fetch(bot, ctx)
    assert.equal(ctx.stepStatus, 'failed:castlefetch-no-wool')
    assert.equal(ctx.beds.noWool.fails, 1)
    assert.equal(ctx.castleFetchDry, 'banner')
  })

  it('a hunt that came back with 6 wool crafts next tick', async () => {
    const { bot, ctx } = selfBot()
    fetch.deps.craftItem = () => ({ done: false })
    await run(bot, ctx, () => ctx.bring)
    bot.inventory.items().push({ name: 'red_wool', count: 6 })
    ctx.bring = null
    let crafted = 0
    fetch.deps.craftItem = () => { crafted++; return 'running' }
    fetch(bot, ctx)
    fetch(bot, ctx)
    assert.equal(crafted, 1)
    assert.equal(ctx.castleFetch.hunt, null)
    assert.equal(ctx.beds, undefined) // not exhausted: no latch touch
  })

  it('sheep latched: no hunt, fails no-wool at once', async () => {
    const { bot, ctx } = selfBot()
    ctx.beds = { noWool: { fails: bedsMod.NOWOOL_LATCH, at: Date.now() } }
    fetch.deps.craftItem = () => ({ done: false })
    await run(bot, ctx, () => ctx.stepStatus)
    assert.equal(ctx.stepStatus, 'failed:castlefetch-no-wool')
    assert.equal(ctx.bring, undefined)
  })

  it('night: no hunt opened', async () => {
    const { bot, ctx } = selfBot({ night: true })
    fetch.deps.craftItem = () => ({ done: false })
    await run(bot, ctx, () => ctx.stepStatus)
    assert.equal(ctx.stepStatus, 'failed:castlefetch-no-wool')
    assert.equal(ctx.bring, undefined)
  })

  it('6 white wool + 1 stick: craft with the 16 banner names, count 1; the crafted banner is a batch', async () => {
    const items = [{ name: 'white_wool', count: 6 }, { name: 'stick', count: 1 }]
    const { bot, ctx } = selfBot({ items })
    const crafts = []
    fetch.deps.craftItem = (b, c, names, count) => {
      crafts.push([names.slice().sort(), count])
      items.splice(0, items.length, { name: 'white_banner', count: 1 })
      return { done: true }
    }
    await run(bot, ctx, () => crafts.length)
    assert.deepEqual(crafts, [[BANNERS, 1]])
    assert.equal(castleMod.menuFact(bot, ctx), 'banner-batch')
    assert.equal(ctx.bring, undefined)
  })

  it('6 wool on hand, the craft fails: failed:castlefetch-craft-banner, no hunt', async () => {
    const { bot, ctx } = selfBot({ items: [{ name: 'white_wool', count: 6 }] })
    fetch.deps.craftItem = () => ({ done: false })
    await run(bot, ctx, () => ctx.stepStatus)
    assert.equal(ctx.stepStatus, 'failed:castlefetch-craft-banner')
    assert.equal(ctx.bring, undefined)
    assert.equal(ctx.castleFetchDry, 'banner')
  })

  it('chest with 6 wool: withdrawn, then the craft path', async () => {
    const { bot, ctx } = selfBot({ chest: [{ name: 'white_wool', count: 6 }] })
    let crafted = 0
    fetch.deps.craftItem = () => { crafted++; return 'running' }
    await run(bot, ctx, () => crafted)
    assert.deepEqual(bot.calls.withdraw, [['white_wool', 6]])
    assert.equal(crafted, 1)
  })

  it('beds none on a complete castle: the beds option stays feasible', () => {
    const bot = castleBot()
    const ctx = { castle: completeState(), home: residence.castleHome(completeState()) }
    assert.equal(goal.MENU.beds.feasible({ time: 'day', home: 'built', beds: bedsMod.bedsFact(bot, ctx.home) }, bot, ctx), true)
  })

  it('selfOrderBack: null without an order; exhausted on budget, timeout or cap', () => {
    assert.equal(fetch.selfOrderBack({}), null)
    for (const s of [{ legs: 24 }, { timedOut: true }, { capped: true }]) {
      const f = {}
      fetch.selfOrder({}, f, { searchLegs: s })
      assert.deepEqual(fetch.selfOrderBack(f), { exhausted: true })
      assert.equal(f.hunt, null)
    }
    const f = {}
    fetch.selfOrder({}, f, { searchLegs: { legs: 3 } })
    assert.deepEqual(fetch.selfOrderBack(f), { exhausted: false })
  })
})
