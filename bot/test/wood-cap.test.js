'use strict'

// Wood ceiling (idkcraft-g0z.26): past one stack of planks / one gather load
// of logs the castle-open pack stops growing wood — craft no longer converts,
// forage no longer chops, the surplus banks to a chest (or rides the haul to
// the owner when no chest can take it), and the stone leg yields instead of
// digging drops onto a full pack. The bot never throws anything away (owner
// 2026-10-06).

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const stockpile = require('../src/behaviours/stockpile')
const forage = require('../src/behaviours/forage')
const resources = require('../src/resources')
const craft = require('../src/behaviours/craft')
const fetch = require('../src/behaviours/castlefetch')
const goal = require('../src/goal')
require('../src/index') // BEHAVIOURS registration (goal.registered)

function pos(x, y, z) {
  return {
    x, y, z,
    distanceTo: (q) => Math.hypot(x - q.x, y - q.y, z - q.z),
    clone() { return pos(x, y, z) },
    floored() { return pos(Math.floor(x), Math.floor(y), Math.floor(z)) },
  }
}

const packBot = (inv, over = {}) => ({
  entity: { position: pos(0, 64, 0) },
  inventory: { items: () => inv },
  players: {},
  username: 'IdkBot',
  ...over,
})

// Castle-open on a built home, gear ladder done (isolates the wood rules
// from the gear reserve keeps).
const FULL_GIVEN = {
  iron_sword: 1, iron_pickaxe: 1, diamond_sword: 1, diamond_pickaxe: 1, water_bucket: 2,
  iron_helmet: 1, iron_chestplate: 1, iron_leggings: 1, iron_boots: 1,
  diamond_helmet: 1, diamond_chestplate: 1, diamond_leggings: 1, diamond_boots: 1,
}
const openCtx = (over = {}) => ({
  home: { site: { x: 0, y: 64, z: 0 }, built: true },
  castle: { phase: 'body', blueprintVersion: 2 }, // v2 Fachwerk: logs are castle material
  gearGiven: { ...FULL_GIVEN },
  ...over,
})
const PICKS = [{ name: 'iron_pickaxe', count: 1 }, { name: 'diamond_pickaxe', count: 1 }]

function memCtx(cells) {
  const ctx = openCtx()
  resources.noteSpots(ctx, cells, 1000)
  return ctx
}

describe('wood ceiling: pack keeps (idkcraft-g0z.26)', () => {
  it('woodCapped reads the ceiling, fail-open without a pack or ctx', () => {
    assert.equal(stockpile.PLANK_KEEP, 64)
    assert.equal(stockpile.LOG_KEEP, 14)
    assert.equal(stockpile.woodCapped(packBot([{ name: 'oak_planks', count: 64 }]), openCtx()), true)
    assert.equal(stockpile.woodCapped(packBot([{ name: 'oak_planks', count: 63 }]), openCtx()), false)
    // Planks only (revmux 01 minor): a full log load still converts —
    // conversion is what frees the log slot.
    assert.equal(stockpile.woodCapped(packBot([{ name: 'oak_log', count: 14 }]), openCtx()), false)
    assert.equal(stockpile.woodCapped(packBot([{ name: 'oak_log', count: 64 }]), openCtx()), false)
    assert.equal(stockpile.woodCapped(packBot([{ name: 'oak_planks', count: 700 }]), {}), false, 'no castle: no ceiling')
    assert.equal(stockpile.woodCapped(packBot([{ name: 'oak_planks', count: 700 }]), openCtx({ castle: { phase: 'complete' } })), false, 'done castle: no ceiling')
    assert.equal(stockpile.woodCapped(packBot([{ name: 'oak_planks', count: 700 }]), openCtx({ home: { built: false } })), false, 'pre-house: the budget needs it')
    assert.equal(stockpile.woodCapped(null, openCtx()), false)
    assert.equal(stockpile.woodCapped(packBot([]), null), false)
  })

  it('depositPlan banks planks past one stack, keeps the first 64', () => {
    const bot = packBot([{ name: 'oak_planks', count: 64 }, { name: 'oak_planks', count: 64 }, ...PICKS])
    assert.deepEqual(stockpile.depositPlan(bot, openCtx()), [{ name: 'oak_planks', count: 64 }])
    assert.equal(stockpile.surplusCount(bot, openCtx()), 64, 'the surplus flips the stockpile step')
  })

  it('depositPlan banks logs past one load, keeps 14', () => {
    const bot = packBot([{ name: 'oak_log', count: 20 }, ...PICKS])
    assert.deepEqual(stockpile.depositPlan(bot, openCtx()), [{ name: 'oak_log', count: 6 }])
  })

  it('depositPlan still keeps every non-wood castle material packed', () => {
    const bot = packBot([{ name: 'cobblestone', count: 100 }, ...PICKS])
    assert.deepEqual(stockpile.depositPlan(bot, openCtx()), [])
  })

  it('depositPlan keeps all wood pre-house (the budget needs it packed)', () => {
    const bot = packBot([{ name: 'oak_planks', count: 128 }, ...PICKS])
    assert.deepEqual(stockpile.depositPlan(bot, openCtx({ home: { built: false } })), [])
  })

  it('surplusWood lists the above-ceiling wood for ensureRoom', () => {
    const bot = packBot([{ name: 'oak_planks', count: 100 }, { name: 'birch_log', count: 20 }])
    assert.deepEqual(stockpile.surplusWood(bot, openCtx()), [
      { name: 'oak_planks', count: 36 },
      { name: 'birch_log', count: 6 },
    ])
    assert.deepEqual(stockpile.surplusWood(bot, {}), [])
  })
})

describe('wood ceiling: menu gates (idkcraft-g0z.26)', () => {
  const F = (name, facts, bot, ctx) => goal.MENU[name].feasible(facts, bot, ctx)

  it('craft converts a full load below the ceiling, not above it', () => {
    // Both packs hold the 14-log load (revmux 01 minor): only the plank
    // count gates the conversion.
    const facts = { logs: 14, maxPlanks: 10, table: 1, door: 1, castle: 'stone-none' }
    const below = packBot([{ name: 'oak_planks', count: 10 }, { name: 'oak_log', count: 14 }])
    assert.equal(F('craft', facts, below, openCtx()), true)
    const capped = { logs: 14, maxPlanks: 70, table: 1, door: 1, castle: 'stone-none' }
    const above = packBot([{ name: 'oak_planks', count: 70 }, { name: 'oak_log', count: 14 }])
    assert.equal(F('craft', capped, above, openCtx()), false)
  })

  it('craft still crafts the table past the ceiling (it spends planks)', () => {
    const facts = { logs: 0, maxPlanks: 70, table: 0, tablePlaced: false, door: 1, castle: 'stone-none' }
    assert.equal(F('craft', facts, packBot([{ name: 'oak_planks', count: 70 }]), openCtx()), true)
  })

  it('craft reason names the full wood store', () => {
    const facts = { logs: 14, maxPlanks: 70, table: 1, door: 0, tablePlaced: false, castle: 'stone-none' }
    const bot = packBot([{ name: 'oak_planks', count: 70 }, { name: 'oak_log', count: 14 }])
    assert.equal(F('craft', facts, bot, openCtx()), false)
    assert.equal(goal.stepWhy('craft', facts, bot, openCtx(), ''), 'craft: wood store full, banking the surplus')
  })

  it('planForage skips remembered logs past the ceiling, still digs ore', () => {
    const logsOnly = memCtx([{ x: 2, y: 64, z: 0, name: 'oak_log' }])
    assert.equal(forage.planForage(packBot([]), logsOnly).kind, 'log', 'below the ceiling: chops')
    const capped = packBot([{ name: 'oak_planks', count: 70 }])
    assert.equal(forage.planForage(capped, memCtx([{ x: 2, y: 64, z: 0, name: 'oak_log' }])), null, 'capped: no wood plan')
    const mixed = memCtx([
      { x: 2, y: 64, z: 0, name: 'oak_log' },
      { x: 100, y: 60, z: 0, name: 'iron_ore' },
    ])
    const oreBot = packBot([{ name: 'oak_planks', count: 70 }, { name: 'stone_pickaxe', count: 1 }])
    assert.equal(forage.planForage(oreBot, mixed).name, 'iron_ore', 'capped: ore still plans')
  })

  it('goalFacts known drops when only logs are remembered past the ceiling', () => {
    const bot = (inv) => packBot(inv, {
      time: { timeOfDay: 6000 },
      spawnPoint: pos(0, 64, 0),
      entity: { position: pos(0, 64, 0), onGround: true },
    })
    const cells = [{ x: 2, y: 64, z: 0, name: 'oak_log' }]
    assert.equal(goal.goalFacts(bot([]), memCtx(cells)).known, 'near')
    assert.equal(goal.goalFacts(bot([{ name: 'oak_planks', count: 70 }]), memCtx(cells)).known, 'none')
  })
})

describe('wood ceiling: craft conversion guard (idkcraft-g0z.26)', () => {
  const IDS = { oak_log: 17, oak_planks: 18, crafting_table: 58 }
  const recipeFor = (name, count = 1) => ({ result: { name, count } })
  function craftBot({ items = [], recipes = {} } = {}) {
    const lines = []
    const calls = { craft: [] }
    const itemsByName = {}
    for (const [name, id] of Object.entries(IDS)) itemsByName[name] = { id }
    const bot = {
      lines, calls, _items: items,
      entity: { position: pos(0, 64, 0) },
      registry: { itemsByName },
      inventory: { items: () => bot._items, selectedItem: null },
      recipesFor: (id) => {
        const name = Object.keys(IDS).find((n) => IDS[n] === id)
        if (!(name in recipes)) throw new Error(`unexpected recipesFor(${name})`)
        return recipes[name] ? [recipes[name]] : []
      },
      craft: async (recipe, count, table) => { calls.craft.push({ recipe, count, table }) },
      blockAt: () => null,
      pathfinder: { setGoal: () => {}, isMoving: () => false },
      chat: (line) => { lines.push(String(line)) },
    }
    return bot
  }
  async function untilCrafts(bot, n, timeoutMs = 8000) {
    const t0 = Date.now()
    while (bot.calls.craft.length < n) {
      if (Date.now() - t0 > timeoutMs) throw new Error(`craft calls stuck at ${bot.calls.craft.length}, want ${n}`)
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    await new Promise((resolve) => setImmediate(resolve))
  }

  it('capped logs are left for the banking, never converted, never failed', () => {
    const bot = craftBot({
      items: [{ name: 'oak_log', count: 14 }, { name: 'oak_planks', count: 70 }],
      recipes: { oak_planks: recipeFor('oak_planks', 4) },
    })
    const ctx = { ...openCtx(), lastGoalKey: '', stepStatus: 'running', home: { ...openCtx().home, table: { x: 9, y: 64, z: 9 } } }
    // Table and door done: no table/door branch, only the capped logs.
    bot._items.push({ name: 'crafting_table', count: 1 }, { name: 'oak_door', count: 1 })
    craft(bot, ctx, null, {})
    assert.equal(ctx.stepStatus, 'done')
    assert.deepEqual(bot.calls.craft, [])
    assert.deepEqual(bot.lines, [])
  })

  it('the table still crafts past the ceiling (logs untouched)', async () => {
    const tableRecipe = recipeFor('crafting_table')
    const bot = craftBot({
      items: [{ name: 'oak_log', count: 14 }, { name: 'oak_planks', count: 70 }],
      recipes: { oak_planks: recipeFor('oak_planks', 4), crafting_table: tableRecipe },
    })
    const ctx = { ...openCtx(), lastGoalKey: '', stepStatus: 'running' }
    craft(bot, ctx, null, {})
    await untilCrafts(bot, 1)
    assert.equal(bot.calls.craft.length, 1, 'the table op only, no planks batch')
    assert.equal(bot.calls.craft[0].recipe, tableRecipe)
    assert.equal(bot.lines.length, 1)
    assert.ok(bot.lines[0].startsWith('crafted 1 crafting_table'), `lines: ${bot.lines}`)
  })
})

describe('wood ceiling: owner handover (idkcraft-g0z.26)', () => {
  const ownerOnline = { owner: { username: 'owner', entity: { position: pos(1, 64, 1) } } }
  function haulBot({ inv = [], cells = {}, players = {}, registry = null } = {}) {
    const chats = []
    const bot = {
      chats,
      inv,
      username: 'IdkBot',
      players,
      entity: { position: pos(4, 64, 0), onGround: true },
      registry: registry || { itemsByName: { dirt: { id: 3 } } },
      inventory: { items: () => inv },
      blockAt: (p) => ({ name: cells[`${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`] || (p.y < 64 ? 'dirt' : 'air') }),
      pathfinder: { goal: null, setGoal(g) { bot.pathfinder.goal = g }, isMoving: () => false },
      openChest: async () => { throw new Error('full') },
      chat: (m) => { chats.push(String(m)) },
    }
    return bot
  }
  const flush = () => new Promise((r) => { setImmediate(r); setImmediate(r) })

  it('offerHaul exact-sets the bankable sum when a player is online', () => {
    const ctx = openCtx()
    assert.equal(stockpile.offerHaul(packBot([{ name: 'dirt', count: 40 }], { players: ownerOnline }), ctx), true)
    assert.deepEqual(ctx.haul, { dirt: 8 }, 'the 32 scaffold keep never rides along')
    assert.equal(stockpile.offerHaul(packBot([{ name: 'dirt', count: 40 }], { players: ownerOnline }), ctx), true)
    assert.deepEqual(ctx.haul, { dirt: 8 }, 'a repeat call cannot stack claims')
  })

  it('offerHaul stays quiet with nobody online or nothing bankable', () => {
    const ctx = openCtx()
    assert.equal(stockpile.offerHaul(packBot([{ name: 'dirt', count: 40 }]), ctx), false)
    assert.deepEqual(ctx.haul || {}, {})
    const ctx2 = openCtx()
    assert.equal(stockpile.offerHaul(packBot([{ name: 'dirt', count: 32 }], { players: ownerOnline }), ctx2), false)
  })

  it('no spot for a chest with the owner online: haul it, say so, fail', () => {
    // Every v1 candidate cell solid: nothing to adopt, nowhere to place.
    const cells = {}
    for (const s of stockpile.CHEST_SPOTS) cells[`${s.dx},64,${s.dz}`] = 'stone'
    const bot = haulBot({ inv: [{ name: 'dirt', count: 40 }], cells, players: ownerOnline })
    const ctx = { lastGoalKey: null, stepStatus: 'running', home: { site: { x: 0, y: 64, z: 0 }, built: true, chest: null } }
    stockpile(bot, ctx, null, {})
    assert.equal(ctx.stepStatus, 'failed:no-spot')
    assert.deepEqual(ctx.haul, { dirt: 8 })
    assert.ok(bot.chats.some((l) => l.includes('bringing the surplus to you')), `chats: ${bot.chats}`)
  })

  it('no spot with nobody online: fails without a haul', () => {
    const cells = {}
    for (const s of stockpile.CHEST_SPOTS) cells[`${s.dx},64,${s.dz}`] = 'stone'
    const bot = haulBot({ inv: [{ name: 'dirt', count: 40 }], cells })
    const ctx = { lastGoalKey: null, stepStatus: 'running', home: { site: { x: 0, y: 64, z: 0 }, built: true, chest: null } }
    stockpile(bot, ctx, null, {})
    assert.equal(ctx.stepStatus, 'failed:no-spot')
    assert.deepEqual(ctx.haul || {}, {})
    assert.deepEqual(bot.chats, [])
  })

  it('full home chest with the owner online: the surplus rides the haul', async () => {
    const bot = haulBot({
      inv: [{ name: 'dirt', count: 40 }],
      cells: { '5,64,1': 'chest' },
      players: ownerOnline,
    })
    bot.openChest = async () => ({
      containerItems: () => [],
      deposit: async () => { throw new Error('full') },
      close: () => {},
    })
    const ctx = { lastGoalKey: null, stepStatus: 'running', home: { site: { x: 0, y: 64, z: 0 }, built: true, chest: { x: 5, y: 64, z: 1 } } }
    stockpile(bot, ctx, null, {}) // issues the walk
    stockpile(bot, ctx, null, {}) // arrived: the open throws, the chest seals full
    await flush()
    await flush()
    assert.equal(ctx.stepStatus, 'done')
    assert.equal(ctx.chestFull, true)
    assert.deepEqual(ctx.haul, { dirt: 8 })
    assert.ok(bot.chats.includes('the home chest is full'), `chats: ${bot.chats}`)
    assert.ok(bot.chats.includes('bringing the surplus to you instead'), `chats: ${bot.chats}`)
  })
})

describe('reserved slot (g0z.26 R2, revmux 01 major)', () => {
  const dirt = (n) => Array.from({ length: n }, () => ({ name: 'dirt', count: 64 }))
  const ownerOnline = { owner: { username: 'owner', entity: { position: pos(1, 64, 1) } } }
  const noChestCtx = () => ({ home: { site: { x: 0, y: 64, z: 0 }, built: true, chest: null } })

  it('slotReserved binds only built + chestless + alone + 35 stacks', () => {
    assert.equal(stockpile.PACK_RESERVE, 35)
    assert.equal(stockpile.slotReserved(packBot(dirt(35)), noChestCtx()), true)
    assert.equal(stockpile.slotReserved(packBot(dirt(34)), noChestCtx()), false)
    assert.equal(stockpile.slotReserved(packBot(dirt(36)), noChestCtx()), true)
    const adopted = noChestCtx()
    adopted.home.chest = { x: 5, y: 64, z: 1 }
    assert.equal(stockpile.slotReserved(packBot(dirt(35)), adopted), false, 'adopted: banking drains')
    assert.equal(stockpile.slotReserved(packBot(dirt(35), { players: ownerOnline }), noChestCtx()), false, 'online: the haul drains')
    const pre = noChestCtx()
    pre.home.built = false
    assert.equal(stockpile.slotReserved(packBot(dirt(35)), pre), false, 'pre-house: the budget owns the pack')
    assert.equal(stockpile.slotReserved(null, noChestCtx()), false)
    assert.equal(stockpile.slotReserved(packBot(dirt(35)), null), false)
  })

  it('reserveCorner is the corner without the stack count', () => {
    assert.equal(stockpile.reserveCorner(packBot(dirt(5)), noChestCtx()), true)
    assert.equal(stockpile.reserveCorner(packBot(dirt(35)), noChestCtx()), true)
    const adopted = noChestCtx()
    adopted.home.chest = { x: 5, y: 64, z: 1 }
    assert.equal(stockpile.reserveCorner(packBot(dirt(5)), adopted), false)
  })

  it('planForage prefers quest wood over ore when chestless and plankless', () => {
    const cells = [
      { x: 2, y: 64, z: 0, name: 'iron_ore' },
      { x: 100, y: 64, z: 0, name: 'oak_log' },
    ]
    const questCtx = memCtx(cells)
    delete questCtx.home.chest
    const questBot = packBot([{ name: 'stone_pickaxe', count: 1 }])
    assert.equal(forage.planForage(questBot, questCtx).name, 'oak_log', 'the quest chops wood, not ore')
    const fundedCtx = memCtx(cells)
    delete fundedCtx.home.chest
    const fundedBot = packBot([{ name: 'stone_pickaxe', count: 1 }, { name: 'oak_planks', count: 10 }])
    assert.equal(forage.planForage(fundedBot, fundedCtx).name, 'iron_ore', '8+ planks: ore first again')
  })

  it('planForage prefers the plank-matching wood on the quest', () => {
    const cells = [
      { x: 2, y: 64, z: 0, name: 'birch_log' },
      { x: 100, y: 64, z: 0, name: 'oak_log' },
    ]
    const ctx = memCtx(cells)
    delete ctx.home.chest
    const bot = packBot([{ name: 'oak_planks', count: 5 }])
    assert.equal(forage.planForage(bot, ctx).name, 'oak_log', 'the conversion stacks')
  })

  it('gather yields pack-full on a reserved pack, before the deny check', () => {
    const gather = require('../src/behaviours/gather')
    const chats = []
    const inv = [{ name: 'oak_log', count: 5 }, ...Array.from({ length: 34 }, () => ({ name: 'dirt', count: 64 }))]
    let dug = 0
    const bot = packBot(inv, {
      chat: (m) => { chats.push(String(m)) },
      pathfinder: { goal: null, setGoal() {}, isMoving: () => false },
      dig: async () => { dug++ },
    })
    const ctx = {
      lastGoalKey: '', stepStatus: 'running',
      home: { site: { x: 0, y: 64, z: 0 }, built: true, chest: null },
      gather: {
        pos: { x: 2, y: 64, z: 0 }, name: 'log', phase: 'dig',
        block: { name: 'oak_log', position: pos(2, 64, 0) },
        skip: new Set(), gskip: new Set(), streak: 0, final: null, atLogs: -1, lastProgressAt: Date.now(),
      },
    }
    gather(bot, ctx, null, {})
    assert.equal(ctx.stepStatus, 'failed:pack-full')
    assert.ok(chats.some((l) => l.includes('pack full')), `chats: ${chats}`)
    assert.equal(dug, 0, 'no dig launched')
  })

  it('questExempt: only chops the quest can complete', () => {
    const q = (inv, target = { kind: 'log', name: 'oak_log' }) => forage.questExempt(packBot(inv), noChestCtx(), target)
    const oak5 = [{ name: 'oak_planks', count: 5 }]
    const birch5 = [{ name: 'birch_planks', count: 5 }]
    assert.equal(q([...oak5, ...dirt(34)]), true, '35 stacks + same-wood room 59: the batch stacks')
    assert.equal(q([...oak5, ...dirt(35)]), false, '36 stacks: capped')
    assert.equal(q([...birch5, ...dirt(34)]), false, 'mixed wood at 35: nowhere for the planks')
    assert.equal(q([...birch5, ...dirt(33)]), false, 'mixed wood at 34: the plank stack would take the last slot')
    assert.equal(q([...birch5, ...dirt(32)]), true, 'mixed wood at 33: room for both new stacks')
    assert.equal(q([...birch5, { name: 'oak_log', count: 3 }, ...dirt(32)]), true, 'log room: drops stack, 34 fits the planks')
    assert.equal(q([...birch5, { name: 'oak_log', count: 3 }, ...dirt(33)]), false, 'log room at 35: the planks would not fit')
    assert.equal(q([...oak5, ...dirt(34)], { kind: 'ore', name: 'iron_ore' }), false, 'ore is never exempt')
    assert.equal(q([{ name: 'oak_planks', count: 8 }, ...dirt(34)]), false, '8 planks: the quest is funded')
    const adopted = noChestCtx()
    adopted.home.chest = { x: 5, y: 64, z: 1 }
    assert.equal(forage.questExempt(packBot([...oak5, ...dirt(34)]), adopted, { kind: 'log', name: 'oak_log' }), false, 'adopted: no quest')
  })
})

describe('wood ceiling: stone leg yields on a full pack (idkcraft-g0z.26)', () => {
  const SITE = { x: 100, y: 64, z: 200 }
  function digBot({ items = [] } = {}) {
    const calls = { goals: [], dig: [] }
    const bot = {
      calls,
      chats: [],
      username: 'IdkBot',
      entity: { position: pos(SITE.x - 4, 64, SITE.z - 4) },
      inventory: { items: () => items },
      time: { timeOfDay: 6000, day: 1 },
      spawnPoint: pos(0, 64, 0),
      players: {},
      registry: {
        blocksByName: { stone: { id: 1 }, chest: { id: 2 } },
        itemsByName: { cobblestone: {}, stick: {} },
      },
      blockAt: (p) => {
        const y = Math.floor(p.y)
        const name = y <= 63 ? 'dirt' : 'air'
        return { name, position: pos(Math.floor(p.x), y, Math.floor(p.z)), boundingBox: name === 'air' ? 'empty' : 'block' }
      },
      findBlocks: () => [],
      openChest: async () => { throw new Error('no chest') },
      equip: async () => {},
      dig: async (b) => { calls.dig.push(b.position) },
      pathfinder: { isMoving: () => false, setGoal(g) { calls.goals.push(g) }, stop() {}, goal: null },
      clearControlStates() {},
      chat(m) { this.chats.push(String(m)) },
    }
    return bot
  }

  it('a full pack fails pack-full at once, digging nothing', () => {
    const items = [{ name: 'stone_pickaxe', count: 1 }, { name: 'cobblestone', count: 64 }]
    for (let i = 0; i < 34; i++) items.push({ name: 'dirt', count: 64 })
    assert.equal(items.length, 36)
    const bot = digBot({ items })
    const ctx = { castle: { site: { ...SITE }, rot: 0, blueprintVersion: 1, phase: 'body', blocked: {}, parked: false } }
    fetch(bot, ctx, null, {})
    assert.equal(ctx.stepStatus, 'failed:castlefetch-pack-full')
    assert.deepEqual(bot.calls.dig, [])
  })

  it('room on the cobble stack still digs', () => {
    const items = [{ name: 'stone_pickaxe', count: 1 }, { name: 'cobblestone', count: 63 }]
    for (let i = 0; i < 34; i++) items.push({ name: 'dirt', count: 64 })
    assert.equal(items.length, 36)
    const bot = digBot({ items })
    const ctx = { castle: { site: { ...SITE }, rot: 0, blueprintVersion: 1, phase: 'body', blocked: {}, parked: false } }
    fetch(bot, ctx, null, {})
    assert.notEqual(ctx.stepStatus, 'failed:castlefetch-pack-full')
  })
})

describe('reserve corner exits (g0z.26 R3, revmux 02 majors)', () => {
  const dirt = (n) => Array.from({ length: n }, () => ({ name: 'dirt', count: 64 }))
  const oak5 = [{ name: 'oak_planks', count: 5 }]
  const noChestCtx = () => ({ home: { site: { x: 0, y: 64, z: 0 }, built: true, chest: null } })
  const q = (inv, target = { kind: 'log', name: 'oak_log' }) => forage.questExempt(packBot(inv), noChestCtx(), target)

  it('M0: the quest leg completes through the 36-transient, never parks one log', () => {
    // 35 stacks, same-wood room: the first chop is exempt and opens the log
    // stack at 36/36.
    assert.equal(q([...oak5, ...dirt(34)]), true, 'first chop exempt')
    // Chop 1 lands: 36/36 with a single log. R2 refused the next dig here
    // and parked the single log forever (nothing converts below 14); R3
    // keeps the leg going — the drops stack onto the log stack.
    const one = [...oak5, { name: 'oak_log', count: 1 }, ...dirt(34)]
    assert.equal(one.length, 36)
    assert.equal(q(one), true, 'the 36-transient completes')
    // The leg stacks on to the full batch, then hands to conversion: at 14
    // logs the quest waits instead of over-chopping (a 16-log overshoot
    // converts 64 planks and overflows the same-wood room at 36).
    const full = [...oak5, { name: 'oak_log', count: 14 }, ...dirt(34)]
    assert.equal(q(full), false, '14 logs: conversion owns it')
    // And the batch it hands over fits exactly (5 + 14*4 = 61 <= 64), so the
    // conversion stacks and empties the log stack — the chain test below the
    // R2 suite pins the conversion-to-chest half from here.
    assert.ok(5 + 14 * 4 <= 64)
  })

  it('M0: quest legs chop exactly to the batch, never an 8-overshoot', () => {
    const mem = () => {
      const ctx = noChestCtx()
      resources.noteSpots(ctx, [{ x: 10, y: 64, z: 0, name: 'oak_log' }], 1000)
      return ctx
    }
    assert.equal(forage.planForage(packBot([...oak5, ...dirt(30)]), mem()).want, 14, 'empty-handed: the whole batch')
    const eight = () => {
      const ctx = noChestCtx()
      resources.noteSpots(ctx, [{ x: 10, y: 64, z: 0, name: 'oak_log' }], 1000)
      return ctx
    }
    assert.equal(forage.planForage(packBot([...oak5, { name: 'oak_log', count: 8 }, ...dirt(30)]), eight()).want, 6, 'partial: the remainder')
  })

  it('M3: the quest counts one wood like the chest recipe (4+4 stays on)', () => {
    // chestTodo funds on maxPlanks of ONE wood; the quest must match — a
    // mixed 4+4 cannot fund the chest, so the quest stays on (R2 counted 8
    // total and switched off, stranding the corner with no chopper).
    const mixed = [{ name: 'oak_planks', count: 4 }, { name: 'birch_planks', count: 4 }, ...dirt(30)]
    assert.equal(mixed.length, 32)
    assert.equal(q(mixed, { kind: 'log', name: 'birch_log' }), true, 'mixed 4+4: quest on, birch chops')
    assert.equal(q([{ name: 'oak_planks', count: 20 }, ...dirt(30)]), false, '20 one wood: funded, quest off')
    assert.equal(q([{ name: 'oak_planks', count: 8 }, ...dirt(34)]), false, '8 one wood: funded, quest off')
  })

  it('M3: a refused quest target explores instead of walk-fail-looping', () => {
    // 35 stacks, oak planks, only birch remembered (mixed at 35: nowhere
    // for the planks) plus ranked ore. R2 walked to the birch, failed
    // pack-full post-walk, and re-planned the same walk every 5 minutes.
    // R3 plans nothing diggable (explore) — the ore skips too, it would
    // fail the same gate after the same walk.
    const inv = [...oak5, { name: 'iron_pickaxe', count: 1 }, ...dirt(33)]
    assert.equal(inv.length, 35)
    const ctx = noChestCtx()
    resources.noteSpots(ctx, [
      { x: 10, y: 64, z: 0, name: 'birch_log' },
      { x: 12, y: 60, z: 0, name: 'iron_ore' },
    ], 1000)
    assert.equal(stockpile.slotReserved(packBot(inv), ctx), true, 'the reserve binds')
    assert.equal(forage.planForage(packBot(inv), ctx), null, 'refused quest: explore, never a doomed walk')
  })

  it('M2: shedVictim sheds the smallest junk, never wood, stations or light', () => {
    assert.deepEqual(
      craft.shedVictim([{ name: 'dirt', count: 64 }, { name: 'cobblestone', count: 3 }]),
      { name: 'cobblestone', count: 3 }, 'smallest first (fewest placements)',
    )
    assert.equal(craft.shedVictim([{ name: 'iron_ore', count: 1 }, { name: 'dirt', count: 64 }]).name, 'dirt', 'dirt before ore')
    assert.equal(craft.shedVictim([{ name: 'iron_ore', count: 5 }]).name, 'iron_ore', 'ore sheds last-resort')
    assert.equal(craft.shedVictim([{ name: 'oak_planks', count: 9 }, { name: 'oak_log', count: 14 }]), null, 'wood never sheds')
    assert.equal(craft.shedVictim([{ name: 'crafting_table', count: 1 }, { name: 'torch', count: 64 }, { name: 'stick', count: 64 }]), null, 'stations, torches, sticks never shed')
    assert.equal(craft.shedVictim([]), null)
    assert.equal(craft.shedVictim(null), null)
  })
})
