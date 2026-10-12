'use strict'

// idkcraft-g0z.51: the blast furnace self-sources — the castlefetch blast
// ladder (pane-ladder shape): chest mats -> 5 smelted iron -> the cobble
// -> stone -> smooth_stone chain (two counted furnace passes, cobble dug
// like the pane rung) -> the recipe furnace from 8 cobble -> the table
// craft. Each rung fails honestly into the hold; no mining leg (deep.js
// digs no iron).

const { describe, it, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const Vec3 = require('vec3')
const blueprint = require('../src/castle')
const castleMod = require('../src/behaviours/castle')
const fetch = require('../src/behaviours/castlefetch')
const stockpile = require('../src/behaviours/stockpile')
require('../src/index') // BEHAVIOURS registration (goal.registered)

const SITE = { x: 100, y: 64, z: 200 }
const PAINT = { stone: 'cobblestone', planks: 'oak_planks', frame: 'spruce_log', fence: 'oak_fence', door: 'oak_door', chest: 'chest', torch: 'torch', air: 'air', dig: 'air' }
const k3 = (x, y, z) => `${Math.floor(x)},${Math.floor(y)},${Math.floor(z)}`
const settle = () => new Promise((r) => setImmediate(r))

// A complete v2 castle (every plan cell painted) and a body that walks
// perfectly. Same shape as the g0z.50 harness, plus the ladder's item names.
function castleBot({ items = [], chest = [] } = {}) {
  const set = new Map()
  for (const c of blueprint.absPlan(SITE, 0, 2).cells) {
    set.set(k3(c.x, c.y, c.z), PAINT[c.kind])
    if (c.kind === 'door') set.set(k3(c.x, c.y + 1, c.z), 'oak_door')
  }
  const name = (p) => set.has(k3(p.x, p.y, p.z)) ? set.get(k3(p.x, p.y, p.z)) : (Math.floor(p.y) < SITE.y ? 'dirt' : 'air')
  const calls = { places: [], digs: [], withdraw: [], gather: 0, goals: [] }
  const byName = { chest: { id: 2 } }
  for (const n of ['blast_furnace', 'iron_ingot', 'raw_iron', 'furnace', 'smooth_stone', 'stone', 'cobblestone', 'coal', 'oak_planks', 'oak_log']) byName[n] = {}
  const bot = {
    username: 'IdkBot',
    calls,
    set,
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
    pathfinder: {
      goal: null,
      movements: null,
      isMoving: () => false,
      setGoal(g) {
        bot.pathfinder.goal = g
        calls.goals.push(g && typeof g.x === 'number' ? { x: g.x, y: g.y, z: g.z } : null)
        const p = g && (g.pos || (typeof g.x === 'number' ? g : null))
        if (p) bot.entity.position = new Vec3(p.x + 0.5, p.y, p.z + 0.5)
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

function completeState() {
  return { site: { ...SITE }, rot: 0, blueprintVersion: 2, phase: 'complete', blocked: {}, parked: false }
}

function closeDecor(bot, except = null) {
  for (const c of blueprint.decorPlan(SITE, 0, 2).cells) {
    if (except && except.has(k3(c.x, c.y, c.z))) continue
    bot.set.set(k3(c.x, c.y, c.z), c.kind === 'pane' ? 'glass_pane' : c.kind === 'banner' ? 'white_wall_banner' : c.kind === 'fence' ? 'oak_fence' : c.kind)
  }
}

function openBlast(bot) {
  closeDecor(bot)
  const cell = blueprint.decorPlan(SITE, 0, 2).cells.find((c) => c.kind === 'blast_furnace')
  bot.set.delete(k3(cell.x, cell.y, cell.z))
}

const count = (items, name) => items.filter((i) => i.name === name).reduce((a, i) => a + i.count, 0)
function take(items, name, n) {
  let left = n
  for (const i of items) {
    if (left <= 0) break
    if (i.name !== name || !(i.count > 0)) continue
    const k = Math.min(i.count, left)
    i.count -= k
    left -= k
  }
  for (let k = items.length - 1; k >= 0; k--) if (items[k].count <= 0) items.splice(k, 1)
}
function give(items, name, n) {
  const it = items.find((i) => i.name === name)
  if (it) it.count += n
  else items.push({ name, count: n })
}

// Fake furnace (bring-smelt shape): records the job it was handed, moves
// up to count input into output on a done, returns the scripted outcome
// per call. A failure converts nothing (a real no-cobble fails in the
// craft, before any window op).
function fakeFurnace(bot, items, script) {
  const jobs = []
  const fn = (b, ctx) => {
    const job = ctx.furnaceJob
    jobs.push(job ? { ...job } : null)
    ctx.furnaceJob = null
    const step = script.length > 0 ? script.shift() : 'done'
    if (step === 'done' && job && count(items, job.input) > 0) {
      const n = job.count == null ? count(items, job.input) : Math.min(count(items, job.input), job.count)
      take(items, job.input, n)
      give(items, job.output, n)
    }
    return step
  }
  return { fn, jobs }
}

// Craft stub: the furnace and blast recipes with real pack moves; planks
// never fund (fuel tests stub their own).
function craftStub(items, calls) {
  return (b, c, names, n) => {
    calls.push([names, n])
    if (names[0] === 'furnace' && count(items, 'cobblestone') >= 8) {
      take(items, 'cobblestone', 8)
      give(items, 'furnace', 1)
      return { done: true }
    }
    if (names[0] === 'blast_furnace' && count(items, 'iron_ingot') >= 5 && count(items, 'furnace') >= 1 && count(items, 'smooth_stone') >= 3) {
      take(items, 'iron_ingot', 5)
      take(items, 'furnace', 1)
      take(items, 'smooth_stone', 3)
      give(items, 'blast_furnace', 1)
      return { done: true }
    }
    return { done: false }
  }
}

describe('castle blast ladder (g0z.51)', () => {
  const real = { ...fetch.deps }
  afterEach(() => { Object.assign(fetch.deps, real) })
  const run = async (bot, ctx, until, n = 60) => {
    for (let i = 0; i < n && !until(); i++) { fetch(bot, ctx); await settle(); await settle() }
  }

  it('full ladder: iron -> cobble -> stone smelts in order, furnace then blast crafted, done', async () => {
    const RES = castleMod.reserveOf('stone')
    const items = [{ name: 'raw_iron', count: 5 }, { name: 'coal', count: 3 }, { name: 'cobblestone', count: 11 + RES }]
    const bot = castleBot({ items, chest: [] })
    openBlast(bot)
    const ctx = { castle: completeState() }
    assert.equal(castleMod.menuFact(bot, ctx), 'blast_furnace-none')
    const { fn, jobs } = fakeFurnace(bot, items, [])
    fetch.deps.driveFurnace = fn
    const crafts = []
    fetch.deps.craftItem = craftStub(items, crafts)
    fetch.deps.gather = () => { bot.calls.gather++ }
    await run(bot, ctx, () => ctx.stepStatus)
    assert.equal(ctx.stepStatus, 'done')
    assert.deepEqual(jobs, [
      { input: 'raw_iron', output: 'iron_ingot', count: 5 },
      { input: 'cobblestone', output: 'stone', count: 3 },
      { input: 'stone', output: 'smooth_stone', count: 3 },
    ])
    const askedKinds = crafts.map(([names]) => names[0])
    assert.deepEqual(askedKinds.filter((n) => n === 'furnace' || n === 'blast_furnace').slice(-2), ['furnace', 'blast_furnace'])
    assert.ok(crafts.length > 2, 'the blast craft is retried as rungs land')
    assert.equal(count(items, 'blast_furnace'), 1)
    assert.equal(count(items, 'cobblestone'), RES, '3 chain + 8 recipe above the reserve')
    assert.equal(bot.calls.gather, 0)
    assert.equal(ctx.bring, undefined)
    assert.equal(ctx.furnaceJob, null)
    assert.equal(castleMod.menuFact(bot, ctx), 'blast_furnace-batch')
  })

  it('cobble at the reserve digs instead of spending it (stairs shape)', async () => {
    const RES = castleMod.reserveOf('stone')
    const items = [{ name: 'raw_iron', count: 5 }, { name: 'coal', count: 3 }, { name: 'cobblestone', count: RES + 10 }]
    const bot = castleBot({ items, chest: [] })
    openBlast(bot)
    const ctx = { castle: completeState() }
    const { fn, jobs } = fakeFurnace(bot, items, [])
    fetch.deps.driveFurnace = fn
    fetch.deps.craftItem = craftStub(items, [])
    fetch.deps.gather = () => { bot.calls.gather++ }
    await run(bot, ctx, () => ctx.stepStatus || bot.calls.gather > 0)
    assert.equal(ctx.stepStatus, undefined)
    assert.ok(bot.calls.gather > 0, 'short of the 11 above the reserve: the cobble rung gathers wood for a pick')
    assert.deepEqual(jobs, [{ input: 'raw_iron', output: 'iron_ingot', count: 5 }], 'iron lands, no chain smelt starts')
    assert.equal(count(items, 'cobblestone'), RES + 10, 'the reserve stands untouched')
  })

  it('no iron anywhere: the craft is tried, then failed:castlefetch-no-iron', async () => {
    const items = [{ name: 'coal', count: 3 }, { name: 'cobblestone', count: 11 }]
    const bot = castleBot({ items, chest: [] })
    openBlast(bot)
    const ctx = { castle: completeState() }
    const { fn, jobs } = fakeFurnace(bot, items, [])
    fetch.deps.driveFurnace = fn
    const crafts = []
    fetch.deps.craftItem = craftStub(items, crafts)
    fetch.deps.gather = () => { bot.calls.gather++ }
    await run(bot, ctx, () => ctx.stepStatus)
    assert.equal(ctx.stepStatus, 'failed:castlefetch-no-iron')
    assert.deepEqual(crafts, [[['blast_furnace'], 1]])
    assert.deepEqual(jobs, [])
    assert.equal(bot.calls.gather, 0)
    assert.equal(ctx.bring, undefined)
    assert.deepEqual([...ctx.castleFetchDry], ['blast_furnace'])
  })

  it('partial iron smelts what stands, then fails no-iron', async () => {
    const items = [{ name: 'raw_iron', count: 2 }, { name: 'coal', count: 3 }, { name: 'cobblestone', count: 11 }]
    const bot = castleBot({ items, chest: [] })
    openBlast(bot)
    const ctx = { castle: completeState() }
    const { fn, jobs } = fakeFurnace(bot, items, [])
    fetch.deps.driveFurnace = fn
    fetch.deps.craftItem = craftStub(items, [])
    await run(bot, ctx, () => ctx.stepStatus)
    assert.equal(ctx.stepStatus, 'failed:castlefetch-no-iron')
    assert.deepEqual(jobs, [{ input: 'raw_iron', output: 'iron_ingot', count: 2 }])
    assert.equal(count(items, 'iron_ingot'), 2, 'the partial smelt lands first')
  })

  it('chest raw + cobble withdraw, then the ladder runs to done', async () => {
    const RES = castleMod.reserveOf('stone')
    const items = [{ name: 'coal', count: 3 }, { name: 'cobblestone', count: 4 }]
    const bot = castleBot({ items, chest: [{ name: 'raw_iron', count: 5 }, { name: 'cobblestone', count: 100 }] })
    openBlast(bot)
    const ctx = { castle: completeState() }
    const { fn, jobs } = fakeFurnace(bot, items, [])
    fetch.deps.driveFurnace = fn
    fetch.deps.craftItem = craftStub(items, [])
    await run(bot, ctx, () => ctx.stepStatus)
    assert.equal(ctx.stepStatus, 'done')
    assert.ok(bot.calls.withdraw.some(([t, n]) => t === 'raw_iron' && n === 5), JSON.stringify(bot.calls.withdraw))
    // One withdraw to the rung gate (3 chain + 8 recipe + reserve 24 = 35
    // minus the 4 held): a stocked chest spares the dig entirely.
    assert.ok(bot.calls.withdraw.some(([t, n]) => t === 'cobblestone' && n === 11 + RES - 4), JSON.stringify(bot.calls.withdraw))
    assert.deepEqual(jobs.map((j) => j.input), ['raw_iron', 'cobblestone', 'stone'])
  })

  it('chest smooth + held ingots skip every smelt', async () => {
    const items = [{ name: 'iron_ingot', count: 5 }, { name: 'furnace', count: 1 }, { name: 'coal', count: 3 }]
    const bot = castleBot({ items, chest: [{ name: 'smooth_stone', count: 3 }] })
    openBlast(bot)
    const ctx = { castle: completeState() }
    const { fn, jobs } = fakeFurnace(bot, items, [])
    fetch.deps.driveFurnace = fn
    fetch.deps.craftItem = craftStub(items, [])
    await run(bot, ctx, () => ctx.stepStatus)
    assert.equal(ctx.stepStatus, 'done')
    assert.deepEqual(bot.calls.withdraw, [['smooth_stone', 3]])
    assert.deepEqual(jobs, [])
    assert.equal(count(items, 'blast_furnace'), 1)
  })

  it('stone on hand skips the cobble pass', async () => {
    const items = [{ name: 'iron_ingot', count: 5 }, { name: 'stone', count: 3 }, { name: 'furnace', count: 1 }, { name: 'coal', count: 3 }]
    const bot = castleBot({ items, chest: [] })
    openBlast(bot)
    const ctx = { castle: completeState() }
    const { fn, jobs } = fakeFurnace(bot, items, [])
    fetch.deps.driveFurnace = fn
    fetch.deps.craftItem = craftStub(items, [])
    await run(bot, ctx, () => ctx.stepStatus)
    assert.equal(ctx.stepStatus, 'done')
    assert.deepEqual(jobs, [{ input: 'stone', output: 'smooth_stone', count: 3 }])
  })

  it('all mats, craft fails: failed:castlefetch-craft-blast, never re-smelts', async () => {
    const items = [{ name: 'iron_ingot', count: 5 }, { name: 'furnace', count: 1 }, { name: 'smooth_stone', count: 3 }]
    const bot = castleBot({ items, chest: [] })
    openBlast(bot)
    const ctx = { castle: completeState() }
    const { fn, jobs } = fakeFurnace(bot, items, [])
    fetch.deps.driveFurnace = fn
    fetch.deps.craftItem = () => ({ done: false })
    await run(bot, ctx, () => ctx.stepStatus)
    assert.equal(ctx.stepStatus, 'failed:castlefetch-craft-blast')
    assert.deepEqual(jobs, [])
    assert.deepEqual([...ctx.castleFetchDry], ['blast_furnace'])
  })

  it('recipe furnace craft fails: failed:castlefetch-craft-furnace', async () => {
    const RES = castleMod.reserveOf('stone')
    const items = [{ name: 'iron_ingot', count: 5 }, { name: 'smooth_stone', count: 3 }, { name: 'cobblestone', count: 8 + RES }, { name: 'coal', count: 3 }]
    const bot = castleBot({ items, chest: [] })
    openBlast(bot)
    const ctx = { castle: completeState() }
    const { fn, jobs } = fakeFurnace(bot, items, [])
    fetch.deps.driveFurnace = fn
    fetch.deps.craftItem = (b, c, names) => {
      if (names[0] === 'furnace') return { done: false }
      return craftStub(items, [])(b, c, names)
    }
    await run(bot, ctx, () => ctx.stepStatus)
    assert.equal(ctx.stepStatus, 'failed:castlefetch-craft-furnace')
    assert.deepEqual(jobs, [], 'iron and smooth already held: no smelt runs')
  })

  it('a preempted stone run resumes instead of reordering (no count on the resume)', async () => {
    const items = [{ name: 'iron_ingot', count: 5 }, { name: 'stone', count: 3 }, { name: 'furnace', count: 1 }, { name: 'coal', count: 3 }]
    const bot = castleBot({ items, chest: [] })
    openBlast(bot)
    const ctx = { castle: completeState(), furnace: { job: { input: 'stone', output: 'smooth_stone' }, settled: false, result: null } }
    const { fn, jobs } = fakeFurnace(bot, items, [])
    fetch.deps.driveFurnace = fn
    fetch.deps.craftItem = craftStub(items, [])
    await run(bot, ctx, () => ctx.stepStatus)
    assert.equal(ctx.stepStatus, 'done')
    assert.deepEqual(jobs, [{ input: 'stone', output: 'smooth_stone' }])
  })

  it('no-cobble retries the smelt once (the station rung); twice fails smelt-no-cobble', async () => {
    const items = [{ name: 'raw_iron', count: 5 }, { name: 'smooth_stone', count: 3 }, { name: 'furnace', count: 1 }, { name: 'cobblestone', count: 8 }, { name: 'coal', count: 3 }]
    const bot = castleBot({ items, chest: [] })
    openBlast(bot)
    let ctx = { castle: completeState() }
    let f = fakeFurnace(bot, items, ['failed:no-cobble', 'done'])
    fetch.deps.driveFurnace = f.fn
    fetch.deps.craftItem = craftStub(items, [])
    await run(bot, ctx, () => ctx.stepStatus)
    assert.equal(ctx.stepStatus, 'done')
    assert.deepEqual(f.jobs, [
      { input: 'raw_iron', output: 'iron_ingot', count: 5 },
      { input: 'raw_iron', output: 'iron_ingot', count: 5 },
    ])

    const items2 = [{ name: 'raw_iron', count: 5 }, { name: 'smooth_stone', count: 3 }, { name: 'furnace', count: 1 }, { name: 'cobblestone', count: 8 }, { name: 'coal', count: 3 }]
    const bot2 = castleBot({ items: items2, chest: [] })
    openBlast(bot2)
    ctx = { castle: completeState() }
    f = fakeFurnace(bot2, items2, ['failed:no-cobble', 'failed:no-cobble'])
    fetch.deps.driveFurnace = f.fn
    fetch.deps.craftItem = craftStub(items2, [])
    await run(bot2, ctx, () => ctx.stepStatus)
    assert.equal(ctx.stepStatus, 'failed:castlefetch-smelt-no-cobble')
    assert.deepEqual([...ctx.castleFetchDry], ['blast_furnace'])
  })

  it('a full pack fails pack-full before any smelt', async () => {
    const items = [{ name: 'raw_iron', count: 5 }, { name: 'coal', count: 3 }]
    for (let i = 0; i < stockpile.PACK_RESERVE; i++) items.push({ name: `junk_${i}`, count: 1 })
    const bot = castleBot({ items, chest: [] })
    openBlast(bot)
    const ctx = { castle: completeState() }
    const { fn, jobs } = fakeFurnace(bot, items, [])
    fetch.deps.driveFurnace = fn
    fetch.deps.craftItem = craftStub(items, [])
    await run(bot, ctx, () => ctx.stepStatus)
    assert.equal(ctx.stepStatus, 'failed:castlefetch-pack-full')
    assert.deepEqual(jobs, [])
  })
})

describe('stockpile blast-ladder keep (g0z.51)', () => {
  const state = () => ({ site: { ...SITE }, rot: 0, blueprintVersion: 2, phase: 'complete', blocked: {}, parked: false })
  function packBot(items, blastLaid) {
    const laid = blastLaid ? new Set([((c) => `${c.x},${c.y},${c.z}`)(blueprint.decorPlan(SITE, 0, 2).cells.find((c) => c.kind === 'blast_furnace'))]) : new Set()
    return {
      username: 'IdkBot',
      entity: { position: new Vec3(0, 64, 0) },
      inventory: { items: () => items },
      registry: { blocksByName: {}, itemsByName: {} },
      blockAt: (p) => ({ name: laid.has(`${p.x},${p.y},${p.z}`) ? 'blast_furnace' : 'air', position: p }),
    }
  }
  const banked = (plan, name) => plan.filter((p) => p.name === name).reduce((a, p) => a + p.count, 0)

  it('open blast cell: keeps 5 iron / 3 chain / 1 furnace / 35 cobble, banks the rest', () => {
    assert.equal(stockpile.BLAST_COBBLE_KEEP, 35, '24 reserve + 3 chain + 8 recipe (mirrors the rung gate)')
    const bot = packBot([
      { name: 'raw_iron', count: 6 }, { name: 'iron_ingot', count: 7 }, { name: 'stone', count: 4 },
      { name: 'smooth_stone', count: 5 }, { name: 'furnace', count: 2 }, { name: 'cobblestone', count: 76 },
    ], false)
    const plan = stockpile.depositPlan(bot, { castle: state(), home: null })
    assert.equal(banked(plan, 'raw_iron'), 1, JSON.stringify(plan))
    assert.equal(banked(plan, 'iron_ingot'), 2, JSON.stringify(plan))
    assert.equal(banked(plan, 'stone'), 1, JSON.stringify(plan))
    assert.equal(banked(plan, 'smooth_stone'), 2, JSON.stringify(plan))
    assert.equal(banked(plan, 'furnace'), 1, JSON.stringify(plan))
    // 76 - 35 ladder - 8 gear - 32 scaffold.
    assert.equal(banked(plan, 'cobblestone'), 76 - stockpile.BLAST_COBBLE_KEEP - stockpile.GEAR_RESERVE_COBBLE - stockpile.SCAFFOLD_KEEP, JSON.stringify(plan))
  })

  it('dirt cannot squeeze the ladder cobble out of the shared scaffold pool', () => {
    const open = packBot([{ name: 'dirt', count: 64 }, { name: 'cobblestone', count: 40 }], false)
    assert.equal(banked(stockpile.depositPlan(open, { castle: state(), home: null }), 'cobblestone'), 0, 'blast + gear keeps hold all 40')
    const laid = packBot([{ name: 'dirt', count: 64 }, { name: 'cobblestone', count: 40 }], true)
    assert.equal(banked(stockpile.depositPlan(laid, { castle: state(), home: null }), 'cobblestone'), 32, 'dirt eats the pool, gear keeps 8')
  })

  it('laid blast cell: the stock banks like junk', () => {
    const bot = packBot([
      { name: 'raw_iron', count: 6 }, { name: 'iron_ingot', count: 7 }, { name: 'stone', count: 4 },
      { name: 'smooth_stone', count: 5 }, { name: 'furnace', count: 2 },
    ], true)
    const plan = stockpile.depositPlan(bot, { castle: state(), home: null })
    assert.equal(banked(plan, 'raw_iron'), 6, JSON.stringify(plan))
    assert.equal(banked(plan, 'iron_ingot'), 7, JSON.stringify(plan))
    assert.equal(banked(plan, 'stone'), 4, JSON.stringify(plan))
    assert.equal(banked(plan, 'smooth_stone'), 5, JSON.stringify(plan))
    assert.equal(banked(plan, 'furnace'), 2, JSON.stringify(plan))
  })

  it('no castle: the stock banks', () => {
    const bot = packBot([{ name: 'raw_iron', count: 5 }], false)
    assert.equal(banked(stockpile.depositPlan(bot, { home: null }), 'raw_iron'), 5)
  })
})
