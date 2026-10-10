'use strict'

// idkcraft-g0z.50: the castle kitchen blast furnace — one decor cell at
// (14,0,18), laid after phase 'complete' like g0z.31/32/45/49, the plain
// furnace kept for sand and food (a blast smelts neither). Chest-first:
// the finished block from the castle chest, else one table craft from
// 5 iron_ingot + 1 furnace + 3 smooth_stone held; missing stock fails
// honestly into the hold. Placed from the stance north of it (14,0,17)
// looking south-into-kitchen, so the front faces into the room.

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
const CELL = { dx: 14, dy: 0, dz: 18 }
const STANCE = { dx: 14, dy: 0, dz: 17 }
const FURNACES = [[12, 0, 18], [13, 0, 18], [12, 0, 17]] // residence C_FURNACE (g0z.36), rot 0
const TORCH = { dx: 13, dy: 0, dz: 17 } // the kitchen torch plan cell
const BLAST = blueprint.DECOR[2].filter((c) => c.kind === 'blast_furnace')

describe('castle kitchen blast furnace plan (g0z.50)', () => {
  it('append-only: one blast cell after the attic nook, earlier idx fixed', () => {
    assert.equal(BLAST.length, 1)
    assert.deepEqual([BLAST[0].dx, BLAST[0].dy, BLAST[0].dz], [CELL.dx, CELL.dy, CELL.dz])
    assert.deepEqual(BLAST[0].stance, STANCE)
    assert.equal(blueprint.DECOR[2].filter((c) => c.kind === 'pane').length, 44)
    assert.equal(blueprint.DECOR[2].filter((c) => c.kind === 'banner').length, 2)
    assert.equal(blueprint.DECOR[2].filter((c) => c.kind === 'bookshelf').length, 5)
    assert.equal(blueprint.DECOR[2].filter((c) => c.kind === 'enchanting_table').length, 1)
    const tail = blueprint.DECOR[2].slice(-7).map((c) => c.kind)
    assert.deepEqual(tail, ['enchanting_table', 'bookshelf', 'bookshelf', 'bookshelf', 'bookshelf', 'bookshelf', 'blast_furnace'])
    const dp = blueprint.decorPlan(SITE, 0, 2)
    assert.equal(dp.cells.length, 44 + 2 + V2.PLAN.filter((c) => c.kind === 'fence').length + 6 + 1)
    const last = dp.cells[dp.cells.length - 1]
    assert.equal(last.kind, 'blast_furnace')
    assert.equal(last.idx, blueprint.DECOR_BASE + dp.cells.length - 1)
  })

  it('the PLAN stays frozen and v1 has no blast', () => {
    assert.ok(!V2.PLAN.some((c) => c.kind === 'blast_furnace'))
    assert.equal(blueprint.decorPlan(SITE, 0, 1).cells.filter((c) => c.kind === 'blast_furnace').length, 0)
  })

  it('off-plan, off the furnace spots, torch and door path; stance adjacent and free, all 4 rots', () => {
    for (let rot = 0; rot < 4; rot++) {
      const st = { site: SITE, rot, blueprintVersion: 2, phase: 'complete' }
      const plan = blueprint.decorPlan(SITE, rot, 2)
      const blast = plan.cells.filter((c) => c.kind === 'blast_furnace')
      assert.equal(blast.length, 1)
      const [c] = blast
      const abs = blueprint.absPlan(SITE, rot, 2)
      assert.ok(!abs.at.has(k3(c.x, c.y, c.z)), `rot ${rot}: ${k3(c.x, c.y, c.z)} is off-plan`)
      const spots = blueprint.rotatePlan(FURNACES.map(([dx, dy, dz]) => ({ dx, dy, dz, kind: 'stone' })), rot, 2)
      for (const s of spots) {
        assert.ok(c.x !== SITE.x + s.dx || c.y !== SITE.y + s.dy || c.z !== SITE.z + s.dz, `rot ${rot}: off the C_FURNACE spot ${k3(s.dx, s.dy, s.dz)}`)
      }
      const t = blueprint.rotatePlan([{ ...TORCH, kind: 'stone' }], rot, 2)[0]
      assert.ok(c.x !== SITE.x + t.dx || c.z !== SITE.z + t.dz, `rot ${rot}: not the kitchen torch`)
      assert.equal(castleMod.onDoorPath(st, c.x, c.z), false, `rot ${rot}: off the door path`)
      // The stance: adjacent floor north of the cell (rot 0), rotated along.
      const s = blueprint.rotatePlan([{ ...STANCE, kind: 'stone' }], rot, 2)[0]
      assert.deepEqual(c.stance, { x: SITE.x + s.dx, y: SITE.y + s.dy, z: SITE.z + s.dz }, `rot ${rot}: stance rotates with the cell`)
      assert.equal(Math.abs(c.stance.x - c.x) + Math.abs(c.stance.z - c.z), 1, `rot ${rot}: stance adjacent`)
      assert.equal(c.stance.y, c.y, `rot ${rot}: stance level with the cell`)
      assert.ok(!abs.at.has(k3(c.stance.x, c.stance.y, c.stance.z)), `rot ${rot}: stance off-plan (free floor)`)
      // The face vector (stance minus cell: the front faces the placer)
      // rotates with the plan; rot 0 it is north, into the kitchen.
      const rl = blueprint.rotatePlan([{ ...CELL, kind: 'stone' }], rot, 2)[0]
      const face = [Math.sign(c.stance.x - c.x), Math.sign(c.stance.z - c.z)]
      assert.deepEqual(face, [Math.sign(s.dx - rl.dx), Math.sign(s.dz - rl.dz)], `rot ${rot}: face vector rotates`)
      if (rot === 0) assert.deepEqual(face, [0, -1], 'rot 0: the front faces north into the kitchen')
    }
  })

  it('matches: the exact name only', () => {
    assert.ok(blueprint.matches('blast_furnace', 'blast_furnace'))
    assert.ok(!blueprint.matches('blast_furnace', 'furnace'))
    assert.ok(!blueprint.matches('blast_furnace', 'smoker'))
    assert.ok(!blueprint.matches('blast_furnace', 'air'))
  })

  it('protects a laid blast at the decor cell, not another occupant; every dig path refuses it', () => {
    const st = { site: SITE, rot: 1, blueprintVersion: 2, phase: 'complete' }
    const c = blueprint.decorPlan(SITE, 1, 2).cells.find((o) => o.kind === 'blast_furnace')
    assert.equal(blueprint.protects(st, c, 'blast_furnace'), true)
    assert.equal(blueprint.protects(st, c, 'furnace'), false)
    assert.equal(blueprint.protects(st, c, 'dirt'), false)
    const block = { name: 'blast_furnace', position: new Vec3(c.x, c.y, c.z) }
    for (const extra of [{}, { castleClear: true }, { castleClear: 'emptied' }]) {
      assert.equal(util.protectedReason({}, block, { castle: st, ...extra }), 'protected')
    }
  })

  it('a foreign blast in the footprint is kept from the castle clear (the furnace suffix)', () => {
    const st = { site: SITE, rot: 0, blueprintVersion: 2, phase: 'body' }
    const air = blueprint.absPlan(SITE, 0, 2).cells.find((c) => c.kind === 'air')
    const block = { name: 'blast_furnace', position: new Vec3(air.x, air.y, air.z) }
    assert.equal(util.castleClears({ castleClear: true, castle: st }, block.position, 'blast_furnace'), false)
    assert.equal(util.protectedReason({}, block, { castle: st, castleClear: true }), 'protected')
    assert.equal(util.isInteractRef('blast_furnace'), true, 'never a placement ref')
  })

  it('reach: a walkable stance within PLACE_REACH at all 4 rots', () => {
    for (let rot = 0; rot < 4; rot++) {
      const { w, d } = blueprint.siteDimensions(rot, 2)
      const ent = blueprint.rotatePlan([{ ...V2.ENTRANCE, kind: 'air' }], rot, 2)[0]
      const r = reach.checkPlan({ W: w, D: d, ENTRANCE: ent, PLAN: blueprint.rotatePlan(V2.PLAN, rot, 2) }, blueprint.isPlaceTarget)
      assert.ok(r.ok, `rot ${rot} cell ${r.idx}: ${r.reason}`)
      const [t] = blueprint.rotatePlan(BLAST, rot, 2)
      const ok = reach.flood(r.grid, ent, (sx, sy, sz) => {
        if (sx === t.dx && sz === t.dz && (sy === t.dy || sy + 1 === t.dy)) return false
        return Math.hypot(sx - t.dx, sy + 1.6 - t.dy - 0.5, sz - t.dz) <= build.PLACE_REACH
      })
      assert.ok(ok, `rot ${rot} blast ${k3(t.dx, t.dy, t.dz)}: no stance`)
    }
  })

  it('residence parity: a floor block like the furnace and table, never a walked cell', () => {
    const home = residence.castleHome({ site: { ...SITE }, rot: 0, blueprintVersion: 2 })
    const at = (dx, dy, dz) => new Vec3(SITE.x + dx, SITE.y + dy, SITE.z + dz)
    // The blast sits on a floor cell — exactly like the plain-furnace
    // candidates and the crafting table (the furnace precedent).
    for (const [dx, dy, dz] of [...FURNACES, [16, 0, 18]]) {
      assert.equal(residence.CASTLE.interior(home, at(dx, dy, dz)), true, `furnace precedent ${dx},${dy},${dz} is interior`)
    }
    assert.equal(residence.CASTLE.interior(home, at(CELL.dx, CELL.dy, CELL.dz)), true)
    assert.equal(residence.CASTLE.interior(home, at(STANCE.dx, STANCE.dy, STANCE.dz)), true, 'the stance is free floor')
    const bw = k3(SITE.x + CELL.dx, SITE.y + CELL.dy, SITE.z + CELL.dz)
    for (const b of residence.CASTLE.beds(home)) {
      for (const p of [b.foot, b.head, b.stage, b.sleep]) assert.ok(k3(p.x, p.y, p.z) !== bw, `bed cell ${k3(p.x, p.y, p.z)} off the blast`)
    }
    const table = residence.CASTLE.table(home)
    assert.ok(k3(table.x, table.y, table.z) !== bw, 'the table cell is not the blast cell')
    for (const l of residence.CASTLE.lights(home)) {
      assert.ok(k3(SITE.x + l.dx, SITE.y + l.dy, SITE.z + l.dz) !== bw, `light ${k3(l.dx, l.dy, l.dz)} off the blast`)
    }
    for (const l of residence.CASTLE.chest(home)) {
      assert.ok(l.dx !== CELL.dx || l.dy !== CELL.dy || l.dz !== CELL.dz, 'the plan chest is not the blast cell')
    }
    const e = residence.CASTLE.entrance(home)
    for (const p of [e.door, e.outside, e.inside]) assert.ok(k3(p.x, p.y, p.z) !== bw, 'the gate cells are not the blast cell')
  })
})

// A complete v2 castle (every plan cell painted) and a body that walks
// perfectly. Same shape as the g0z.31/g0z.49 harness, plus the faced
// placement recording (lookAt aim, the frozen-look place).
function castleBot({ rot = 0, items = [], chest = [], loaded = true } = {}) {
  const set = new Map()
  for (const c of blueprint.absPlan(SITE, rot, 2).cells) {
    set.set(k3(c.x, c.y, c.z), PAINT[c.kind])
    if (c.kind === 'door') set.set(k3(c.x, c.y + 1, c.z), 'oak_door')
  }
  const name = (p) => set.has(k3(p.x, p.y, p.z)) ? set.get(k3(p.x, p.y, p.z)) : (Math.floor(p.y) < SITE.y ? 'dirt' : 'air')
  const calls = { places: [], digs: [], withdraw: [], gather: 0, looks: [], faced: [], goals: [] }
  const byName = { chest: { id: 2 } }
  for (const n of ['blast_furnace', 'iron_ingot', 'furnace', 'smooth_stone']) byName[n] = {}
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
    lookAt(p, force) { calls.looks.push([p.x, p.y, p.z, !!force]) },
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
    _placeBlockWithOptions: async (ref, face, opts) => {
      calls.faced.push({ ...opts })
      return bot.placeBlock(ref, face)
    },
    dig: async (b) => { calls.digs.push(k3(b.position.x, b.position.y, b.position.z)) },
    pathfinder: {
      goal: null,
      movements: null,
      isMoving: () => false,
      setGoal(g) {
        bot.pathfinder.goal = g
        calls.goals.push(g && typeof g.x === 'number' ? { x: g.x, y: g.y, z: g.z } : null)
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

describe('castle kitchen blast furnace behaviour (g0z.50)', () => {
  const realCraft = fetch.deps.craftItem
  const realGather = fetch.deps.gather
  afterEach(() => {
    fetch.deps.craftItem = realCraft
    fetch.deps.gather = realGather
  })

  it('decorOpen lists the blast on a seeded complete castle', () => {
    const bot = castleBot()
    const open = castleMod.decorOpen(bot, completeState(), Date.now())
    assert.equal(open.filter((c) => c.kind === 'blast_furnace').length, 1)
  })

  for (const rot of [0, 1, 2, 3]) {
    it(`rot ${rot}: one held blast lays from the stance, aimed at the cell; progress and phase stay complete`, async () => {
      const items = [{ name: 'blast_furnace', count: 1 }]
      const bot = castleBot({ rot, items })
      const cell = blueprint.decorPlan(SITE, rot, 2).cells.find((c) => c.kind === 'blast_furnace')
      closeDecor(bot, rot, new Set([k3(cell.x, cell.y, cell.z)]))
      const ctx = { castle: completeState(rot) }
      const cells = blueprint.absPlan(SITE, rot, 2).cells
      castleMod.progress(bot, ctx.castle, cells, ctx)
      const before = { ...ctx.castle.progress }
      assert.equal(before.done, before.total)
      assert.equal(castleMod.batchOf('blast_furnace'), 1)
      assert.equal(castleMod.menuFact(bot, ctx), 'blast_furnace-batch')
      for (let i = 0; i < 60 && bot.calls.places.length < 1; i++) {
        castleMod(bot, ctx)
        await settle(); await settle()
      }
      assert.deepEqual(bot.calls.places, [k3(cell.x, cell.y, cell.z)])
      // From the stance, looking south-into-kitchen at the cell, the look
      // frozen through the place.
      assert.ok(bot.calls.goals.some((g) => g && g.x === cell.stance.x && g.y === cell.stance.y && g.z === cell.stance.z),
        `a stance goal at ${k3(cell.stance.x, cell.stance.y, cell.stance.z)}: ${JSON.stringify(bot.calls.goals)}`)
      assert.deepEqual(bot.calls.looks, [[cell.x + 0.5, cell.y + 0.5, cell.z + 0.5, false]], 'non-forced: the rotation reaches the server before the place (revmux 01)')
      assert.deepEqual(bot.calls.faced, [{ forceLook: 'ignore' }])
      const face = [Math.sign(cell.stance.x - cell.x), Math.sign(cell.stance.z - cell.z)]
      const rl = blueprint.rotatePlan([{ ...CELL, kind: 'stone' }], rot, 2)[0]
      const rs = blueprint.rotatePlan([{ ...STANCE, kind: 'stone' }], rot, 2)[0]
      assert.deepEqual(face, [Math.sign(rs.dx - rl.dx), Math.sign(rs.dz - rl.dz)], `rot ${rot}: face vector rotates`)
      assert.equal(bot.calls.digs.length, 0)
      assert.equal(ctx.castle.phase, 'complete')
      castleMod.progress(bot, ctx.castle, cells, ctx)
      assert.deepEqual(ctx.castle.progress, before)
      castleMod(bot, ctx)
      assert.equal(ctx.stepStatus, 'done')
      assert.equal(castleMod.menuFact(bot, ctx), 'done')
    })
  }

  it('a chest blast is withdrawn; the stockpile keeps it packed while open', async () => {
    const bot = castleBot({ items: [], chest: [{ name: 'blast_furnace', count: 1 }] })
    closeDecor(bot, 0)
    const cell = blueprint.decorPlan(SITE, 0, 2).cells.find((c) => c.kind === 'blast_furnace')
    bot.set.delete(k3(cell.x, cell.y, cell.z))
    const ctx = { castle: completeState() }
    assert.equal(castleMod.menuFact(bot, ctx), 'blast_furnace-none')
    for (let i = 0; i < 40 && !bot.calls.withdraw.length; i++) { fetch(bot, ctx); await settle(); await settle() }
    assert.deepEqual(bot.calls.withdraw, [['blast_furnace', 1]])
    assert.equal(castleMod.menuFact(bot, ctx), 'blast_furnace-batch')
    assert.equal(castleMod.isMaterial('blast_furnace', completeState()), true)
    assert.equal(castleMod.isMaterial('blast_furnace', { blueprintVersion: 1 }), false)
    const plan = require('../src/behaviours/stockpile').depositPlan(bot, { castle: completeState(), home: null })
    assert.ok(!plan.some((p) => p.name === 'blast_furnace'), JSON.stringify(plan))
  })

  it('held mats ask the blast craft once (5 iron + furnace + 3 smooth stone)', async () => {
    const items = [{ name: 'iron_ingot', count: 5 }, { name: 'furnace', count: 1 }, { name: 'smooth_stone', count: 3 }]
    const bot = castleBot({ items, chest: [] })
    closeDecor(bot, 0)
    const cell = blueprint.decorPlan(SITE, 0, 2).cells.find((c) => c.kind === 'blast_furnace')
    bot.set.delete(k3(cell.x, cell.y, cell.z))
    const ctx = { castle: completeState() }
    const asked = []
    fetch.deps.craftItem = (b, c, names, n) => { asked.push([names, n]); return 'running' }
    for (let i = 0; i < 40 && !asked.length; i++) { fetch(bot, ctx); await settle(); await settle() }
    assert.deepEqual(asked[0], [['blast_furnace'], 1])
  })

  it('no blast anywhere: the craft is tried, then failed:castlefetch-no-blast_furnace (no gather, no hunt)', async () => {
    const bot = castleBot({ items: [], chest: [] })
    closeDecor(bot, 0)
    const cell = blueprint.decorPlan(SITE, 0, 2).cells.find((c) => c.kind === 'blast_furnace')
    bot.set.delete(k3(cell.x, cell.y, cell.z))
    const ctx = { castle: completeState() }
    assert.equal(castleMod.menuFact(bot, ctx), 'blast_furnace-none')
    const asked = []
    fetch.deps.gather = () => { bot.calls.gather++ }
    fetch.deps.craftItem = (b, c, names, n) => { asked.push([names, n]); return { done: false } }
    for (let i = 0; i < 40 && !ctx.stepStatus; i++) { fetch(bot, ctx); await settle(); await settle() }
    assert.equal(ctx.stepStatus, 'failed:castlefetch-no-blast_furnace')
    assert.deepEqual(asked, [[['blast_furnace'], 1]])
    assert.equal(bot.calls.gather, 0)
    assert.equal(ctx.bring, undefined)
    assert.deepEqual([...ctx.castleFetchDry], ['blast_furnace'])
  })

  it('per-kind dry skip covers the new kind: a dry shelf words the blast, all dry restarts the cycle', async () => {
    const bot = castleBot({ items: [], chest: [] })
    closeDecor(bot, 0)
    for (const c of blueprint.decorPlan(SITE, 0, 2).cells) {
      if (c.kind === 'bookshelf' || c.kind === 'blast_furnace') bot.set.delete(k3(c.x, c.y, c.z))
    }
    const ctx = { castle: completeState() }
    fetch.deps.craftItem = () => ({ done: false })
    assert.equal(castleMod.menuFact(bot, ctx), 'bookshelf-none')
    for (let i = 0; i < 40 && !ctx.stepStatus; i++) { fetch(bot, ctx); await settle(); await settle() }
    assert.equal(ctx.stepStatus, 'failed:castlefetch-no-bookshelf')
    ctx.stepStatus = 'running'
    ctx.castleFetch = null
    assert.equal(castleMod.menuFact(bot, ctx), 'blast_furnace-none')
    assert.equal(fetch.demand(bot, ctx).kind, 'blast_furnace')
    for (let i = 0; i < 40 && ctx.stepStatus === 'running'; i++) { fetch(bot, ctx); await settle(); await settle() }
    assert.equal(ctx.stepStatus, 'failed:castlefetch-no-blast_furnace')
    assert.deepEqual([...ctx.castleFetchDry], ['bookshelf', 'blast_furnace'])
    assert.equal(castleMod.menuFact(bot, ctx), 'bookshelf-none')
    assert.equal(ctx.castleFetchDry, null)
  })

  it('blast words fire no gather/forage/explore veto and never read blocked', () => {
    const base = { home: 'built', time: 'day', player: 'none', logs: 0, planks: 0, maxPlanks: 0, beds: 'two', known: 'near', health: 20, haul: 'none', inside: 'no' }
    const ctx = { castle: completeState() }
    for (const step of ['gather', 'forage', 'explore']) {
      for (const w of ['blast_furnace-none', 'blast_furnace-some']) {
        let a, b
        try { a = goal.MENU[step].feasible({ ...base, castle: w }, null, ctx) } catch (e) { a = String(e) }
        try { b = goal.MENU[step].feasible({ ...base, castle: 'done' }, null, ctx) } catch (e) { b = String(e) }
        assert.equal(a, b, `${step} on ${w}`)
      }
    }
    assert.equal(goal.MENU.forage.feasible({ ...base, castle: 'blast_furnace-none' }, null, ctx), true, 'forage still runs (castleBlocked false)')
  })
})

describe('castle blast furnace craft (g0z.50)', () => {
  const IDS = { blast_furnace: 401, iron_ingot: 402, furnace: 403, smooth_stone: 404, cobblestone: 405, crafting_table: 406 }
  function recipeBot(items) {
    const byName = {}
    for (const [n, id] of Object.entries(IDS)) byName[n] = { id }
    return {
      registry: { itemsByName: byName },
      inventory: { items: () => items },
      recipesAll: (id) => id === IDS.blast_furnace
        ? [{
          delta: [
            { id: IDS.iron_ingot, count: -5 },
            { id: IDS.furnace, count: -1 },
            { id: IDS.smooth_stone, count: -3 },
            { id: IDS.blast_furnace, count: 1 },
          ],
          result: { count: 1 },
          requiresTable: true,
        }]
        : [],
    }
  }

  it('craftany plans a blast furnace from 5 iron + furnace + 3 smooth stone at the pack table', () => {
    const bot = recipeBot([{ name: 'iron_ingot', count: 5 }, { name: 'furnace', count: 1 }, { name: 'smooth_stone', count: 3 }, { name: 'crafting_table', count: 1 }])
    const p = craftany.planCraft(bot, {}, ['blast_furnace'], 1)
    assert.equal(p.ok, true)
    assert.equal(p.target, 'blast_furnace')
    assert.equal(p.requiresTable, true)
    assert.deepEqual(p.needs, [{ name: 'iron_ingot', need: 5 }, { name: 'furnace', need: 1 }, { name: 'smooth_stone', need: 3 }])
  })

  it('8 cobble never funds the furnace layer (the one-layer rule: sticks/planks only)', () => {
    const bot = recipeBot([{ name: 'iron_ingot', count: 5 }, { name: 'cobblestone', count: 8 }, { name: 'smooth_stone', count: 3 }, { name: 'crafting_table', count: 1 }])
    const p = craftany.planCraft(bot, {}, ['blast_furnace'], 1)
    assert.equal(p.ok, false)
    assert.equal(p.fail, 'missing')
    assert.match(p.line, /furnace/)
  })

  it('short smooth stone refuses honestly', () => {
    const bot = recipeBot([{ name: 'iron_ingot', count: 5 }, { name: 'furnace', count: 1 }, { name: 'smooth_stone', count: 2 }, { name: 'crafting_table', count: 1 }])
    const p = craftany.planCraft(bot, {}, ['blast_furnace'], 1)
    assert.equal(p.ok, false)
    assert.equal(p.fail, 'missing')
    assert.match(p.line, /smooth_stone/)
  })
})
