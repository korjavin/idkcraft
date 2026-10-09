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
require('../src/index') // BEHAVIOURS registration (goal.registered)

const V2 = blueprint.BLUEPRINTS[2]
const SITE = { x: 100, y: 64, z: 200 }
const PAINT = { stone: 'cobblestone', planks: 'oak_planks', frame: 'spruce_log', fence: 'oak_fence', door: 'oak_door', chest: 'chest', torch: 'torch', air: 'air', dig: 'air' }
const k3 = (x, y, z) => `${Math.floor(x)},${Math.floor(y)},${Math.floor(z)}`
const settle = () => new Promise((r) => setImmediate(r))

describe('castle decor plan (g0z.31)', () => {
  const D = blueprint.DECOR[2]
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
      assert.equal(dp.cells.length, 44)
      for (const c of dp.cells) {
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
      for (const t of blueprint.rotatePlan(blueprint.DECOR[2], rot, 2)) {
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

  it('off site a complete castle reads done (no yank-back for cosmetics)', () => {
    const bot = castleBot({ items: [{ name: 'glass_pane', count: 16 }], loaded: false })
    assert.equal(castleMod.menuFact(bot, { castle: completeState() }), 'done')
  })

  it('all windows glazed: done; an owner block in a window is left alone', () => {
    const bot = castleBot({ items: [{ name: 'glass_pane', count: 16 }] })
    const cells = blueprint.decorPlan(SITE, 0, 2).cells
    cells.forEach((c, i) => bot.set.set(k3(c.x, c.y, c.z), i === 0 ? 'oak_leaves' : 'glass_pane'))
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
