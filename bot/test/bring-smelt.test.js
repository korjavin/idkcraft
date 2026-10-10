'use strict'

// Smelt rung of the bring ladder (idkcraft-ipn.20): 'bring me iron axe'
// digs the ore (kind 'block' sub), smelts it through the furnace job
// (deps.driveFurnace faked), crafts and tosses. The mock merges the
// bring-craft recipe/chest bot with the bring.test dig world.

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const bring = require('../src/behaviours/bring')
const itemMod = require('../src/behaviours/bringitem')
const { handleChat, createTicker } = require('../src/index')

function pos(x, y, z) {
  const p = {
    x, y, z,
    distanceTo: (q) => Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z),
    clone() { return pos(p.x, p.y, p.z) },
    floored() { return pos(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)) },
    offset(dx, dy, dz) { return pos(p.x + dx, p.y + dy, p.z + dz) },
  }
  return p
}

const ITEMS = {
  iron_axe: 102, cobblestone: 113, stick: 115, coal: 116, iron_ingot: 117,
  oak_log: 118, oak_planks: 119, crafting_table: 120, raw_iron: 130,
  stone_pickaxe: 131, wooden_pickaxe: 132, sand: 133, glass: 134,
  charcoal: 135, brick: 136, cooked_beef: 137, iron_nugget: 138,
}
const BLOCKS = { iron_ore: 31, sand: 33, oak_log: 12, stone: 1, crafting_table: 40 }
const DROPS = { iron_ore: 'raw_iron', sand: 'sand', oak_log: 'oak_log', stone: 'cobblestone' }
const SMELTS = { raw_iron: 'iron_ingot', sand: 'glass', oak_log: 'charcoal' }

function R(product, takes, resCount, reqTable) {
  const delta = takes.map(([n, c]) => ({ id: ITEMS[n], count: -c }))
  delta.push({ id: ITEMS[product], count: resCount })
  return { delta, result: { count: resCount }, requiresTable: !!reqTable, product }
}

const RECIPES = {
  iron_axe: [R('iron_axe', [['iron_ingot', 3], ['stick', 2]], 1, true)],
  iron_ingot: [R('iron_ingot', [['iron_nugget', 9]], 1, true)], // real: nuggets never win
  stick: [R('stick', [['oak_planks', 2]], 4, false)],
  oak_planks: [R('oak_planks', [['oak_log', 1]], 4, false)],
  wooden_pickaxe: [R('wooden_pickaxe', [['oak_planks', 3], ['stick', 2]], 1, true)],
}

function mockBot({ items = [], chest = [], cells = {} } = {}) {
  const lines = []
  const tossCalls = []
  const calls = { craft: [] }
  const itemsByName = {}
  const byId = {}
  for (const [name, id] of Object.entries(ITEMS)) { itemsByName[name] = { id }; byId[id] = name }
  const blocksByName = {}
  const blockById = {}
  for (const [name, id] of Object.entries(BLOCKS)) { blocksByName[name] = { id }; blockById[id] = name }
  const add = (name, n) => {
    const at = bot._items.find((i) => i.name === name)
    if (at) at.count += n
    else bot._items.push({ name, count: n })
  }
  const bot = {
    lines, tossCalls, calls, chest, cells, add,
    username: 'IdkBot',
    entities: {},
    health: 20,
    food: 20,
    entity: { position: pos(0, 64, 0), onGround: true },
    registry: { blocksByName, itemsByName },
    players: { P: { username: 'P', entity: { position: pos(30, 64, 0) } } },
    _moving: false,
    _items: items,
    held: null,
    pathfinder: {
      goal: null,
      setGoal: (goal) => { bot.pathfinder.goal = goal },
      isMoving: () => bot._moving,
      bestHarvestTool: () => bot._items.find((i) => i.name.endsWith('_pickaxe')) || null,
    },
    inventory: { items: () => bot._items },
    recipesAll: (id) => RECIPES[byId[id]] || [],
    recipesFor: (id) => RECIPES[byId[id]] || [],
    craft: async (recipe, count) => {
      calls.craft.push(recipe.product)
      for (const d of recipe.delta) {
        if (d.count >= 0) continue
        let n = -d.count * count
        for (const s of bot._items) {
          if (n <= 0) break
          if (s.name !== byId[d.id]) continue
          const take = Math.min(s.count, n)
          s.count -= take
          n -= take
        }
      }
      add(recipe.product, recipe.result.count * count)
      bot._items = bot._items.filter((s) => s.count > 0)
    },
    findBlocks(opts) {
      const want = typeof opts.matching === 'function' ? null : new Set(Array.isArray(opts.matching) ? opts.matching : [opts.matching])
      const out = []
      for (const [k, n] of Object.entries(cells)) {
        const id = blocksByName[n] && blocksByName[n].id
        if (want ? !want.has(id) : !opts.matching({ name: n, type: id })) continue
        const [x, y, z] = k.split(',').map(Number)
        out.push(pos(x, y, z))
      }
      return out
    },
    blockAt(p) {
      const k = `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`
      const n = cells[k] || (Math.floor(p.y) < 64 ? 'dirt' : 'air')
      return { name: n, type: blocksByName[n] ? blocksByName[n].id : 0, position: pos(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)) }
    },
    canDigBlock: () => true,
    dig: async (block) => {
      const p = block.position
      const name = cells[`${p.x},${p.y},${p.z}`]
      delete cells[`${p.x},${p.y},${p.z}`]
      if (name && bot.held && bot.held.endsWith('_pickaxe')) add(DROPS[name], 1)
      else if (name === 'oak_log' || name === 'sand') add(DROPS[name], 1)
    },
    equip: async (item) => { bot.held = item && item.name },
    openChest: async () => ({
      containerItems: () => chest.map((s) => ({ name: s.name, type: itemsByName[s.name].id, metadata: null, count: s.count })),
      withdraw: async (type, _meta, count) => {
        const name = byId[type]
        let n = count
        for (let k = chest.length - 1; k >= 0 && n > 0; k--) {
          if (chest[k].name !== name) continue
          const take = Math.min(chest[k].count, n)
          chest[k].count -= take
          n -= take
          if (chest[k].count <= 0) chest.splice(k, 1)
        }
        if (count - n > 0) add(name, count - n)
      },
      close: () => {},
    }),
    toss: async (id, meta, n) => { tossCalls.push([byId[id], n]) },
    chat(line) { lines.push(String(line)) },
  }
  return bot
}

// Fake furnace: script entries per call — null (running), 'done' (every
// input in the pack becomes output), or a failed:<r> string. Records the
// job it was handed (set before EVERY call) and consumes it like furnace.js.
function fakeFurnace(bot, script) {
  const jobs = []
  const fn = (b, ctx) => {
    const job = ctx.furnaceJob
    jobs.push(job ? { ...job } : null)
    ctx.furnaceJob = null
    ctx.furnace = ctx.furnace || { job, settled: false, result: null }
    ctx.furnace.job = job
    const step = script.length > 0 ? script.shift() : 'done'
    if (step === 'done' && job) {
      const s = bot._items.find((i) => i.name === job.input)
      if (s && s.count > 0) {
        const n = s.count
        s.count = 0
        bot._items = bot._items.filter((i) => i.count > 0)
        bot.add(job.output, n)
      }
    }
    if (step) { ctx.furnace.settled = true; ctx.furnace.result = null }
    return step
  }
  return { fn, jobs }
}

function withFurnace(f, body) {
  const real = itemMod.deps.driveFurnace
  itemMod.deps.driveFurnace = f.fn
  return Promise.resolve().then(body).finally(() => { itemMod.deps.driveFurnace = real })
}

function tickerFor(bot) {
  return createTicker({
    bot,
    brain: { decide: async () => ({ action: 'idle', sprint: false, source: 'stub' }) },
    tickMs: 10,
    idleTickMs: 10,
  })
}

const flush = () => new Promise((r) => { setImmediate(() => setImmediate(r)) })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function home(ctx, { chest = false } = {}) {
  ctx.home = { site: { x: 0, y: 64, z: 0 }, built: true, table: { x: 0, y: 64, z: 0 } }
  if (chest) ctx.home.chest = { x: 5, y: 64, z: 1 }
}

// Teleport every walk, sleep through craft/chest/toss settles; records the
// phases seen (and o.have during 'smelt').
async function drive(bot, ctx, seen = []) {
  for (let i = 0; i < 120 && ctx.bring; i++) {
    await bring(bot, ctx, null, {})
    const o = ctx.bring
    if (!o) break
    seen.push({ phase: o.phase, kind: o.kind, have: o.have, drop: o.drop })
    if (ctx.gearInFlight || o.chestInFlight || o.tossInFlight || ctx.digInFlight) { await sleep(650); continue }
    await flush()
    bot._moving = false
    if ((o.phase === 'walk' || o.phase === 'dig') && o.pos) bot.entity.position = pos(o.pos.x + 1, o.pos.y, o.pos.z)
    if (o.phase === 'chestfetch') bot.entity.position = pos(5, 64, 2)
    if (o.phase === 'craft' || o.phase === 'smelt') bot.entity.position = pos(1, 64, 0)
    if (o.phase === 'return') bot.entity.position = pos(30, 64, 1)
  }
}

const IRON_CELLS = () => ({ '0,64,0': 'crafting_table', '6,64,0': 'iron_ore', '6,64,2': 'iron_ore', '6,64,4': 'iron_ore' })

describe('bring smelt rung (idkcraft-ipn.20)', () => {
  it('bring me iron axe: ore sub -> smelt job -> craft -> toss', async () => {
    const bot = mockBot({ items: [{ name: 'stone_pickaxe', count: 1 }, { name: 'stick', count: 2 }], cells: IRON_CELLS() })
    const ticker = tickerFor(bot)
    const ctx = bot._tickerCtx
    home(ctx)
    const f = fakeFurnace(bot, [null, null, 'done'])
    await withFurnace(f, async () => {
      handleChat(bot, ticker, 'P', 'bring me iron axe')
      assert.deepEqual(bot.lines, ['making you a iron_axe: need 3 raw_iron, going for iron_ore'])
      const o = ctx.bring
      assert.equal(o.kind, 'block')
      assert.equal(o.name, 'iron_ore')
      assert.equal(o.drop, 'raw_iron')
      assert.equal(o.want, 3)
      assert.equal(o.subFor, 'iron_axe')
      const seen = []
      await drive(bot, ctx, seen)
      assert.ok(!ctx.bring, `order completed: ${bot.lines}`)
      assert.deepEqual(f.jobs, Array(3).fill({ input: 'raw_iron', output: 'iron_ingot' }), 'job set before every call')
      assert.ok(seen.some((s) => s.phase === 'smelt'))
      assert.deepEqual(bot.tossCalls, [['iron_axe', 1]])
      assert.ok(bot.lines.includes('here is 1 iron_axe'), `lines: ${bot.lines}`)
      assert.equal(ctx.furnaceJob, null)
    })
  })

  it('raw iron in the pack goes straight to the smelt; o.have tracks the ingots', async () => {
    const bot = mockBot({ items: [{ name: 'raw_iron', count: 3 }, { name: 'stick', count: 2 }], cells: { '0,64,0': 'crafting_table' } })
    const ticker = tickerFor(bot)
    const ctx = bot._tickerCtx
    home(ctx)
    const f = fakeFurnace(bot, [null, 'done'])
    await withFurnace(f, async () => {
      handleChat(bot, ticker, 'P', 'bring me iron axe')
      assert.deepEqual(bot.lines, ['smelting 3 raw_iron for your iron_axe'])
      assert.equal(ctx.bring.phase, 'smelt')
      assert.equal(ctx.bring.subFor, undefined, 'no sub')
      await bring(bot, ctx, null, {})
      assert.equal(ctx.bring.drop, 'iron_ingot')
      assert.equal(ctx.bring.have, 0)
      bot.add('iron_ingot', 1) // a piece lands mid-run
      await bring(bot, ctx, null, {})
      assert.equal(ctx.bring.have, 1, 'the watchdog metric sees the ingot')
      await drive(bot, ctx)
      assert.deepEqual(bot.tossCalls, [['iron_axe', 1]])
    })
  })

  it('bring me iron ingot: ore sub -> smelt -> toss 3 ingots, no craft', async () => {
    const cells = IRON_CELLS()
    const bot = mockBot({ items: [{ name: 'stone_pickaxe', count: 1 }], cells })
    const ticker = tickerFor(bot)
    const ctx = bot._tickerCtx
    home(ctx)
    const f = fakeFurnace(bot, ['done'])
    await withFurnace(f, async () => {
      handleChat(bot, ticker, 'P', 'bring me iron ingot')
      assert.deepEqual(bot.lines, ['making you a iron_ingot: need 3 raw_iron, going for iron_ore'])
      await drive(bot, ctx)
      assert.ok(!ctx.bring, `order completed: ${bot.lines}`)
      assert.deepEqual(bot.calls.craft, [])
      assert.deepEqual(bot.tossCalls, [['iron_ingot', 3]])
    })
  })

  it('the chest gives 2 ingots and 1 raw: only the 1 raw smelts, no ore sub', async () => {
    const bot = mockBot({
      items: [{ name: 'stick', count: 2 }],
      chest: [{ name: 'raw_iron', count: 1 }, { name: 'iron_ingot', count: 2 }],
      cells: { '0,64,0': 'crafting_table', '5,64,1': 'chest' },
    })
    const ticker = tickerFor(bot)
    const ctx = bot._tickerCtx
    home(ctx, { chest: true })
    const f = fakeFurnace(bot, ['done'])
    await withFurnace(f, async () => {
      handleChat(bot, ticker, 'P', 'bring me iron axe')
      const seen = []
      await drive(bot, ctx, seen)
      assert.ok(bot.lines.includes('smelting 1 raw_iron for your iron_axe'), `lines: ${bot.lines}`)
      assert.ok(!seen.some((s) => s.kind === 'block'), 'no ore sub')
      assert.equal(bot.chest.length, 0, 'both drawn')
      assert.deepEqual(bot.tossCalls, [['iron_axe', 1]])
    })
  })

  it('no pickaxe tier for the ore: the tier line, no order left', () => {
    const bot = mockBot({ items: [{ name: 'wooden_pickaxe', count: 1 }], cells: IRON_CELLS() })
    handleChat(bot, tickerFor(bot), 'P', 'bring me iron axe')
    assert.equal(bot.lines.length, 1)
    assert.match(bot.lines[0], /^need a stone pickaxe for iron_ore/)
    assert.ok(!bot._tickerCtx.bring)
  })

  it('no-fuel with pack logs: planks crafted, smelt retried once; a second no-fuel refuses', async () => {
    const bot = mockBot({ items: [{ name: 'raw_iron', count: 3 }, { name: 'stick', count: 2 }, { name: 'oak_log', count: 1 }], cells: { '0,64,0': 'crafting_table' } })
    const ticker = tickerFor(bot)
    const ctx = bot._tickerCtx
    home(ctx)
    const crafted = []
    const realCraft = itemMod.deps.craftItem
    itemMod.deps.craftItem = (b, c, names, n) => { crafted.push([names, n]); b.add('oak_planks', 4); b._items.find((i) => i.name === 'oak_log').count = 0; return { done: true } }
    const f = fakeFurnace(bot, ['failed:no-fuel', 'failed:no-fuel'])
    try {
      await withFurnace(f, async () => {
        handleChat(bot, ticker, 'P', 'bring me iron axe')
        await drive(bot, ctx)
      })
    } finally { itemMod.deps.craftItem = realCraft }
    assert.deepEqual(crafted, [[['oak_planks'], 2]])
    assert.equal(f.jobs.length, 2, 'smelt retried once')
    assert.equal(bot.lines.at(-1), 'could not smelt raw_iron: no-fuel')
    assert.equal(ctx.bring, null)
  })

  it('no-fuel and no logs: a logs sub sized for the load', async () => {
    const bot = mockBot({ items: [{ name: 'raw_iron', count: 3 }, { name: 'stick', count: 2 }], cells: { '0,64,0': 'crafting_table' } })
    const ticker = tickerFor(bot)
    const ctx = bot._tickerCtx
    home(ctx)
    const f = fakeFurnace(bot, ['failed:no-fuel'])
    await withFurnace(f, async () => {
      handleChat(bot, ticker, 'P', 'bring me iron axe')
      await bring(bot, ctx, null, {}) // no-fuel
      await bring(bot, ctx, null, {}) // fuel rung
      const o = ctx.bring
      assert.equal(o.kind, 'block')
      assert.equal(o.name, 'logs')
      assert.equal(o.want, 1) // ceil(ceil(3 / 1.5) / 4)
      assert.equal(o.subFor, 'iron_axe')
    })
  })

  it('no-cobble: a stone sub for the furnace; a second no-cobble refuses and cleans up', async () => {
    const cells = { '0,64,0': 'crafting_table', '3,64,0': 'stone' }
    for (let x = 4; x < 12; x++) cells[`${x},64,0`] = 'stone'
    const bot = mockBot({ items: [{ name: 'raw_iron', count: 3 }, { name: 'stick', count: 2 }, { name: 'stone_pickaxe', count: 1 }], cells })
    const ticker = tickerFor(bot)
    const ctx = bot._tickerCtx
    home(ctx)
    const f = fakeFurnace(bot, ['failed:no-cobble', 'failed:no-cobble'])
    const seen = []
    await withFurnace(f, async () => {
      handleChat(bot, ticker, 'P', 'bring me iron axe')
      await drive(bot, ctx, seen)
    })
    assert.ok(seen.some((s) => s.kind === 'block' && s.drop === 'cobblestone'), 'stone sub ran')
    assert.ok((bot._items.find((i) => i.name === 'cobblestone') || {}).count >= 8)
    assert.equal(bot.lines.at(-1), `need a furnace: 8 cobblestone (have ${bot._items.find((i) => i.name === 'cobblestone').count})`)
    assert.equal(ctx.bring, null)
    assert.equal(ctx.furnaceJob, null)
  })

  it('bring me glass: sand sub -> smelt { sand, glass }; bring me charcoal: logs -> { oak_log, charcoal }', async () => {
    const bot = mockBot({ cells: { '0,64,0': 'crafting_table', '4,64,0': 'sand', '4,64,2': 'sand', '4,64,4': 'sand' } })
    const ticker = tickerFor(bot)
    home(bot._tickerCtx)
    const f = fakeFurnace(bot, ['done'])
    await withFurnace(f, async () => {
      handleChat(bot, ticker, 'P', 'bring me glass')
      assert.deepEqual(bot.lines, ['making you a glass: need 3 sand, going for sand'])
      await drive(bot, bot._tickerCtx)
    })
    assert.deepEqual(f.jobs, [{ input: 'sand', output: 'glass' }])
    assert.deepEqual(bot.tossCalls, [['glass', 3]])

    const wood = mockBot({ cells: { '0,64,0': 'crafting_table', '20,64,0': 'oak_log', '20,65,0': 'oak_log', '20,66,0': 'oak_log', '20,67,0': 'oak_leaves', '21,66,0': 'oak_leaves', '19,66,0': 'oak_leaves', '20,66,1': 'oak_leaves', '20,66,-1': 'oak_leaves' } })
    const wt = tickerFor(wood)
    home(wood._tickerCtx)
    const g = fakeFurnace(wood, ['done'])
    await withFurnace(g, async () => {
      handleChat(wood, wt, 'P', 'bring me charcoal')
      assert.deepEqual(wood.lines, ['making you a charcoal: need 3 logs, going for logs'])
      await drive(wood, wood._tickerCtx)
    })
    assert.deepEqual(g.jobs, [{ input: 'oak_log', output: 'charcoal' }], `lines: ${wood.lines}`)
    assert.deepEqual(wood.tossCalls, [['charcoal', 3]])
  })

  it('brick and cooked beef refuse with one honest line, no order', () => {
    for (const [ask, line] of [['bring me brick', "can't make brick: clay not part of bring"], ['bring me cooked beef', "can't make cooked_beef: cooking not part of bring"]]) {
      const bot = mockBot()
      handleChat(bot, tickerFor(bot), 'P', ask)
      assert.deepEqual(bot.lines, [line])
      assert.ok(!bot._tickerCtx.bring)
    }
  })

  it('stop mid-smelt: no order, no job, the settled outcome consumed', async () => {
    const bot = mockBot({ items: [{ name: 'raw_iron', count: 3 }, { name: 'stick', count: 2 }], cells: { '0,64,0': 'crafting_table' } })
    const ticker = tickerFor(bot)
    const ctx = bot._tickerCtx
    home(ctx)
    const f = fakeFurnace(bot, [null, null])
    await withFurnace(f, async () => {
      handleChat(bot, ticker, 'P', 'bring me iron axe')
      await bring(bot, ctx, null, {})
      ctx.furnaceJob = { input: 'raw_iron', output: 'iron_ingot' } // as if mid-tick
      ctx.furnace.settled = true
      ctx.furnace.result = 'done'
      handleChat(bot, ticker, 'P', 'stop')
    })
    assert.equal(ctx.bring, null)
    assert.equal(ctx.furnaceJob, null)
    assert.equal(ctx.furnace.result, null)
  })
})
