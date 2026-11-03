'use strict'

// Tool-chain rung (idkcraft-0jvh): the bot produces simple tools from empty
// hands as a shared building-block rung. Mocks carry real recipe shapes
// (delta negatives = consumed, requiresTable); bot.craft lands the product
// generically, bot.equip records the held item.

const { describe, it, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const bring = require('../src/behaviours/bring')
const toolPrep = require('../src/behaviours/toolprep')
const { handleChat, createTicker } = require('../src/index')

function pos(x, y, z) {
  const p = {
    x, y, z,
    distanceTo: (q) => Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z),
    clone() { return pos(p.x, p.y, p.z) },
    offset(ox, oy, oz) { return pos(p.x + ox, p.y + oy, p.z + oz) },
    floored() { return { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) } },
  }
  return p
}

const ITEMS = {
  stone_hoe: 201, stone_axe: 202, stone_sword: 203, wooden_shovel: 204,
  iron_axe: 205, wooden_pickaxe: 206,
  stone_pickaxe: 207, stone_shovel: 208, iron_pickaxe: 209,
  cobblestone: 113, stick: 115, oak_log: 118, oak_planks: 119,
  iron_ingot: 117, raw_iron: 125, crafting_table: 120,
}

// Fake recipe with the real shape: delta negatives consumed, result count,
// requiresTable. takes = [[name, n], ...].
function R(product, takes, resCount, reqTable) {
  const delta = takes.map(([n, c]) => ({ id: ITEMS[n], count: -c }))
  delta.push({ id: ITEMS[product], count: resCount })
  return { delta, result: { count: resCount }, requiresTable: !!reqTable, product }
}

function RECIPES() {
  return {
    stone_hoe: [R('stone_hoe', [['cobblestone', 3], ['stick', 2]], 1, true)],
    stone_axe: [R('stone_axe', [['cobblestone', 3], ['stick', 2]], 1, true)],
    stone_sword: [R('stone_sword', [['cobblestone', 2], ['stick', 1]], 1, true)],
    wooden_shovel: [R('wooden_shovel', [['oak_planks', 1], ['stick', 2]], 1, true)],
    iron_axe: [R('iron_axe', [['iron_ingot', 3], ['stick', 2]], 1, true)],
    wooden_pickaxe: [R('wooden_pickaxe', [['oak_planks', 3], ['stick', 2]], 1, true)],
    stone_pickaxe: [R('stone_pickaxe', [['cobblestone', 3], ['stick', 2]], 1, true)],
    stone_shovel: [R('stone_shovel', [['cobblestone', 1], ['stick', 2]], 1, true)],
    stick: [R('stick', [['oak_planks', 2]], 4, false)],
    oak_planks: [R('oak_planks', [['oak_log', 1]], 4, false)],
    crafting_table: [R('crafting_table', [['oak_planks', 4]], 1, false)],
  }
}

function mockBot({ items = [], chest = [], playerPos = null, cells = {}, recipes = null } = {}) {
  const lines = []
  const tossCalls = []
  const calls = { setGoal: 0, goals: [], opens: 0, craft: [], place: 0 }
  const itemsByName = {}
  for (const [name, id] of Object.entries(ITEMS)) itemsByName[name] = { id }
  const byId = {}
  for (const [name, id] of Object.entries(ITEMS)) byId[id] = name
  const table = recipes === null ? RECIPES() : recipes
  const bot = {
    lines, tossCalls, calls, chest, cells,
    username: 'IdkBot',
    entities: {},
    health: 20,
    food: 20,
    held: null,
    entity: { position: pos(0, 64, 0), onGround: true },
    registry: { blocksByName: {}, itemsByName },
    players: { P: { username: 'P', entity: playerPos ? { position: playerPos } : null } },
    _moving: false,
    _items: items,
    pathfinder: {
      goal: null,
      setGoal: (goal) => { calls.setGoal++; calls.goals.push(goal); bot.pathfinder.goal = goal },
      stop: () => {},
      isMoving: () => bot._moving,
    },
    inventory: { items: () => bot._items },
    recipesAll: (id) => {
      const name = byId[id]
      return (name && table[name]) || []
    },
    recipesFor: (id) => {
      const name = byId[id]
      return (name && table[name]) || []
    },
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
      bot._items.push({ name: recipe.product, count: recipe.result.count * count })
      bot._items = bot._items.filter((s) => s.count > 0)
    },
    findBlocks: () => [],
    blockAt(p) {
      const key = p && `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`
      if (key === '5,64,1') return { name: 'chest', position: pos(5, 64, 1) }
      const name = cells[key]
      if (!name) return null
      return { name, position: pos(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)) }
    },
    openChest: async () => {
      calls.opens++
      return {
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
          const got = count - n
          if (got > 0) {
            const at = bot._items.find((i) => i.name === name)
            if (at) at.count += got
            else bot._items.push({ name, count: got })
          }
        },
        close: () => {},
      }
    },
    equip: async (item) => { bot.held = item && item.name; bot.heldItem = item },
    toss: async (id, meta, n) => { tossCalls.push([id, meta, n]) },
    chat(line) { lines.push(String(line)) },
  }
  return bot
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

// Drive an order to the end: teleport the walk legs, sleep through the
// 500 ms runOp settle windows, cap the ticks so a stuck order fails loud.
async function drive(bot, ctx) {
  for (let i = 0; i < 60 && ctx.bring; i++) {
    await bring(bot, ctx, null, {})
    const o = ctx.bring
    if (!o) break
    if (ctx.gearInFlight || (o && o.chestInFlight) || (o && o.tossInFlight)) {
      await sleep(650)
      continue
    }
    await flush()
    if (o.phase === 'chestfetch') { bot._moving = false; bot.entity.position = pos(5, 64, 1) }
    if (o.phase === 'craft') { bot._moving = false; bot.entity.position = pos(0, 64, 0) }
    if (o.phase === 'return') {
      const pp = bot.players.P.entity.position
      bot.entity.position = pos(pp.x, pp.y, pp.z)
    }
  }
}

function tableHome(ctx, x, y, z) {
  ctx.home = { site: { x: 0, y: 64, z: 0 }, built: true, table: { x, y, z } }
}

function chestHome(ctx) {
  ctx.home = { site: { x: 0, y: 64, z: 0 }, built: true, chest: { x: 5, y: 64, z: 1 } }
}

function tableChestHome(ctx) {
  ctx.home = { site: { x: 0, y: 64, z: 0 }, built: true, table: { x: 0, y: 64, z: 0 }, chest: { x: 5, y: 64, z: 1 } }
}

// A bare rung ctx: the rung reads/writes ctx.bring like the order path.
function rungCtx(o) {
  const ctx = {}
  if (o) ctx.bring = o
  return ctx
}

describe('v2 bulk tool prerequisite (idkcraft-514b)', () => {
  let previousBody
  beforeEach(() => { previousBody = process.env.BOT_BODY; process.env.BOT_BODY = 'baritone' })
  afterEach(() => {
    if (previousBody === undefined) delete process.env.BOT_BODY
    else process.env.BOT_BODY = previousBody
    toolPrep.setDriver(bring)
  })

  async function prepare(bot, ctx, parent, block) {
    for (let i = 0; i < 100; i++) {
      if (toolPrep.ready(bot, ctx, parent, block)) return
      await flush()
      const p = parent.toolPrep
      if ((p && p.context && p.context.gearInFlight) || (p && p.order && p.order.chestInFlight)) await sleep(650)
      if (p && p.order && p.order.phase === 'craft') bot.entity.position = pos(0, 64, 0)
      if (p && p.order && p.order.phase === 'chestfetch') bot.entity.position = pos(5, 64, 1)
    }
    assert.fail(`prerequisite did not settle: ${bot.lines.join('; ')}`)
  }

  for (const [name, tool] of [['stone', 'stone_pickaxe'], ['iron_ore', 'stone_pickaxe'], ['oak_log', 'stone_axe'], ['dirt', 'stone_shovel'], ['sand', 'stone_shovel']]) {
    it(`equips carried ${tool} before ${name} work without crafting`, async () => {
      const bot = mockBot({ items: [{ name: tool, count: 1 }] })
      const parent = { name, want: 40, phase: 'dig', have: 7, pos: { x: 2, y: 64, z: 0 } }
      const ctx = { bring: parent, stepGen: 1 }
      const original = { ...parent }
      assert.equal(toolPrep.ready(bot, ctx, parent, { name }), false)
      await prepare(bot, ctx, parent, { name })
      assert.equal(bot.held, tool)
      assert.equal(ctx.bring, parent)
      assert.deepEqual({ ...parent, toolPrep: undefined }, { ...original, toolPrep: undefined })
      assert.deepEqual(bot.calls.craft, [])
    })
  }

  it('crafts from remembered non-home chest materials and preserves the flat anchor/progress', async () => {
    const bot = mockBot({ chest: [{ name: 'stick', count: 2 }, { name: 'cobblestone', count: 3 }], cells: { '0,64,0': 'crafting_table' } })
    const parent = { cx: 20, cz: -10, level: 65, blocks: 19, phase: 'shave' }
    const ctx = { flat: parent, stepGen: 2, chests: [{ x: 5, y: 64, z: 1 }] }
    tableHome(ctx, 0, 64, 0)
    const original = { ...parent }
    await prepare(bot, ctx, parent, { name: 'stone' })
    assert.equal(bot.held, 'stone_pickaxe')
    assert.equal(ctx.bring, undefined)
    assert.equal(ctx.flat, parent)
    assert.equal(ctx.bringEnd, undefined)
    assert.deepEqual({ ...parent, toolPrep: undefined }, { ...original, toolPrep: undefined })
    assert.deepEqual(bot.calls.craft, ['stone_pickaxe'])
    assert.deepEqual(bot.tossCalls, [])
  })

  it('the bring dig gate equips the proper tier before the first actual ore dig', async () => {
    const bot = mockBot({ items: [{ name: 'iron_pickaxe', count: 1 }, { name: 'stone_pickaxe', count: 1 }], cells: { '1,64,0': 'diamond_ore', '1,63,0': 'stone' } })
    const block = bot.blockAt(pos(1, 64, 0))
    const parent = { name: 'diamond_ore', block: 'diamond_ore', drop: 'diamond', want: 3, have: 0, phase: 'dig', pos: block.position }
    const ctx = { bring: parent, stepGen: 1 }
    let digs = 0
    bot.dig = async () => { assert.equal(bot.heldItem.name, 'iron_pickaxe'); digs++ }
    bot.pathfinder.bestHarvestTool = () => bot._items.find((it) => it.name === 'stone_pickaxe') // stale weaker choice cannot overwrite the gate
    for (let i = 0; i < 8 && !digs; i++) { await bring(bot, ctx); await flush() }
    assert.equal(digs, 1)
    assert.deepEqual(bot.calls.craft, [])
    assert.equal(ctx.bring, parent)
  })

  it('stops a v2 mine when the pick breaks so the same fetch leg can prepare again', async () => {
    const fetch = require('../src/behaviours/castlefetch')
    const bot = mockBot()
    const parent = { kind: 'stone', dug: 12 }
    const ctx = { castleFetch: parent, castleFetchInFlight: true, castleFetchMine: true }
    const cancelled = []
    bot.cancelMine = (e) => cancelled.push(e.message)
    fetch(bot, ctx)
    assert.deepEqual(cancelled, ['mine-stopped'])
    assert.equal(ctx.castleFetch, parent)
    assert.equal(ctx.castleFetchInFlight, false)
    assert.equal(ctx.stepStatus, undefined)
    assert.equal(parent.dug, 12)
  })

  it('bootstraps a wooden pick before requesting stone for the stone tool', async () => {
    const bot = mockBot({ items: [{ name: 'stick', count: 4 }, { name: 'oak_planks', count: 3 }], cells: { '0,64,0': 'crafting_table' } })
    const parent = { phase: 'dig', target: 'stone', dug: 11 }
    const ctx = { castleFetch: parent, stepGen: 3 }
    tableHome(ctx, 0, 64, 0)
    assert.equal(toolPrep.ready(bot, ctx, parent, { name: 'stone' }), false)
    let sawCobble = false
    for (let i = 0; i < 60 && parent.toolPrep; i++) {
      toolPrep.hold(bot, ctx, parent)
      await flush()
      if (parent.toolPrep && parent.toolPrep.context.gearInFlight) await sleep(650)
      const o = parent.toolPrep && parent.toolPrep.order
      if (o && o.name === 'stone') {
        assert.ok(bot.calls.craft.includes('wooden_pickaxe'), 'wooden prerequisite must finish before the cobble sub')
        assert.equal(o.internalTool, true, 'bootstrap acquisition bypasses recursive bulk preflight')
        sawCobble = true
        bot._items.push({ name: 'cobblestone', count: 3 })
        bring.resumeSub(bot, parent.toolPrep.context, o)
      }
    }
    assert.equal(sawCobble, true)
    await prepare(bot, ctx, parent, { name: 'stone' })
    assert.equal(bot.held, 'stone_pickaxe')
    assert.deepEqual(bot.calls.craft, ['wooden_pickaxe', 'stone_pickaxe'])
    assert.equal(parent.dug, 11)
    assert.equal(ctx.castleFetch, parent)
  })

  it('does not resume a stopped or replaced owner order after a pending child answer', async () => {
    const bot = mockBot()
    const parent = { name: 'stone', want: 48, have: 9 }
    const ctx = { bring: parent, stepGen: 4 }
    let childCtx, answer
    toolPrep.setDriver((_bot, c) => { childCtx = c; return new Promise((r) => { answer = r }) })
    assert.equal(toolPrep.ready(bot, ctx, parent, { name: 'stone' }), false)
    toolPrep.hold(bot, ctx, parent)
    const replacement = { name: 'sand', want: 5 }
    ctx.bring = replacement
    ctx.stepGen++
    ctx.lastGoalKey = 'replacement'
    assert.equal(childCtx.bring, null)
    childCtx.bring = null
    childCtx.bringEnd = { outcome: 'done' }
    childCtx.lastGoalKey = 'old answer'
    answer()
    await flush()
    toolPrep.hold(bot, ctx, parent)
    assert.equal(ctx.bring, replacement)
    assert.equal(ctx.bringEnd, undefined)
    assert.equal(ctx.lastGoalKey, 'replacement')
    assert.equal(parent.have, 9)
  })

  it('ends the actual bring order honestly after two unavailable tool attempts', async () => {
    const bot = mockBot({ cells: { '1,64,0': 'stone', '1,63,0': 'stone' } })
    const parent = { name: 'stone', block: 'stone', drop: 'cobblestone', want: 20, have: 0, phase: 'dig', pos: pos(1, 64, 0) }
    const ctx = { bring: parent }
    let attempts = 0
    toolPrep.setDriver((_bot, child) => { attempts++; child.bring = null })
    bot.dig = () => assert.fail('stone must never dig bare handed')
    for (let i = 0; i < 10 && ctx.bring; i++) {
      await bring(bot, ctx)
      await flush()
      if (parent.toolPrepFailures && parent.toolPrepFailures.pickaxe === 1) parent.toolPrepBackoff.pickaxe = 0
    }
    assert.equal(attempts, 2)
    assert.equal(ctx.bring, null)
    assert.equal(ctx.bringEnd.outcome, 'refused')
    assert.ok(bot.lines.includes('could not prepare a suitable tool for stone'))
  })

  it('failed fetch preparation terminates, survives a new leg, and can craft after materials arrive', async () => {
    const fetch = require('../src/behaviours/castlefetch')
    const bot = mockBot({ cells: { '0,64,0': 'crafting_table' } })
    bot.mine = () => assert.fail('no mine before the tool is prepared')
    const castle = { site: { x: 0, y: 64, z: 0 }, rot: 0, phase: 'body', blueprintVersion: 1 }
    const f = { kind: 'stone', dug: 12, t0: Date.now() }
    const ctx = { castle, castleFetch: f, stepStatus: 'running' }
    tableHome(ctx, 0, 64, 0)
    let attempts = 0
    toolPrep.setDriver((_bot, child) => { attempts++; child.bring = null })
    const d = { kind: 'stone', word: 'none', short: 20 }
    for (let i = 0; i < 12 && ctx.castleFetch; i++) {
      fetch.digTick(bot, ctx, f, d)
      await flush()
      if (castle.toolPrepFailures && castle.toolPrepFailures.pickaxe === 1) castle.toolPrepBackoff.pickaxe = 0
    }
    assert.equal(attempts, 2)
    assert.equal(ctx.castleFetch, null)
    assert.equal(ctx.stepStatus, 'failed:castlefetch-no-pickaxe')
    assert.equal(f.dug, 12)
    assert.ok(Number.isFinite(castle.toolPrepBackoff.pickaxe))
    ctx.castleFetch = { kind: 'stone' }
    fetch.digTick(bot, ctx, ctx.castleFetch, d)
    assert.equal(ctx.castleFetch, null, 'a new leg cannot mint another attempt during cooldown')
    assert.equal(attempts, 2)
    castle.toolPrepBackoff.pickaxe = 0 // another failed attempt after cooldown escalates it
    const third = ctx.castleFetch = { kind: 'stone' }
    for (let i = 0; i < 8 && ctx.castleFetch; i++) { fetch.digTick(bot, ctx, third, d); await flush() }
    assert.equal(attempts, 3)
    assert.equal(castle.toolPrepFailures.pickaxe, 3)
    assert.ok(castle.toolPrepBackoff.pickaxe - Date.now() >= 119000)
    castle.toolPrepBackoff.pickaxe = 0 // cooldown elapsed, materials arrived
    bot._items.push({ name: 'stick', count: 2 }, { name: 'cobblestone', count: 3 })
    ctx.castleFetch = { kind: 'stone' }
    const retry = ctx.castleFetch
    toolPrep.setDriver(bring)
    await prepare(bot, ctx, retry, { name: 'stone' })
    assert.equal(bot.held, 'stone_pickaxe')
    assert.equal(ctx.castleFetch, retry)
    assert.equal(castle.toolPrepFailures.pickaxe, 0)
  })

  it('does not classify redstone controls, instant crops or powders as nonharvestable stone', () => {
    for (const name of ['redstone_wire', 'redstone_torch', 'stone_button', 'stone_pressure_plate', 'glowstone', 'lodestone', 'grindstone', 'stonecutter', 'pointed_dripstone', 'melon_stem', 'attached_pumpkin_stem']) {
      assert.equal(toolPrep.requirement({ name }), null, name)
    }
    assert.equal(toolPrep.requirement({ name: 'white_concrete_powder' }).hand, true)
    for (const name of ['coal_ore', 'nether_quartz_ore', 'nether_gold_ore']) assert.equal(toolPrep.requirement({ name }).tier, 0, name)
    assert.equal(toolPrep.requirement({ name: 'warped_stem' }).kind, 'axe')
  })

  it('a goal switch cannot reset the castle tool budget by replacing its fetch leg', () => {
    const bot = mockBot()
    const castle = {}
    const first = {}
    const ctx = { castle, castleFetch: first, stepGen: 1 }
    assert.equal(toolPrep.ready(bot, ctx, first, { name: 'stone' }), false)
    ctx.stepGen++
    ctx.castleFetch = {}
    assert.equal(toolPrep.ready(bot, ctx, ctx.castleFetch, { name: 'stone' }), false)
    assert.equal(castle.toolPrepFailures.pickaxe, 1)
    assert.equal(first.toolPrep, null)
    castle.toolPrepBackoff.pickaxe = 0
    const second = ctx.castleFetch
    assert.equal(toolPrep.ready(bot, ctx, second, { name: 'stone' }), false)
    ctx.stepGen++
    ctx.castleFetch = {}
    let terminal = 0
    assert.equal(toolPrep.ready(bot, ctx, ctx.castleFetch, { name: 'stone' }, () => { terminal++ }), false)
    assert.equal(castle.toolPrepFailures.pickaxe, 2)
    assert.equal(terminal, 1)
    assert.equal(ctx.castleFetch.toolPrep, undefined, 'no third fresh acquisition is opened')
  })

  it('backs off impossible acquisition and re-enters preparation after a carried tool breaks', async () => {
    const bot = mockBot({ recipes: {} })
    const parent = {}
    const ctx = { gather: parent }
    assert.equal(toolPrep.ready(bot, ctx, parent, { name: 'oak_log' }), false)
    for (let i = 0; i < 4; i++) { toolPrep.hold(bot, ctx, parent); await flush() }
    const lines = bot.lines.length
    for (let i = 0; i < 10; i++) assert.equal(toolPrep.ready(bot, ctx, parent, { name: 'oak_log' }), true)
    assert.equal(bot.lines.length, lines, 'no per-tick craft loop')
    assert.equal(toolPrep.ready(bot, ctx, parent, { name: 'stone' }), false)
    assert.ok(parent.toolPrep, 'stone may never proceed bare handed')
    toolPrep.hold(bot, ctx, parent)
    await flush()
    toolPrep.hold(bot, ctx, parent)
    bot._items.push({ name: 'stone_pickaxe', count: 1 })
    await prepare(bot, ctx, parent, { name: 'stone' })
    bot._items = []
    bot.heldItem = null
    parent.toolPrepBackoff = {}
    assert.equal(toolPrep.ready(bot, ctx, parent, { name: 'stone' }), false)
    assert.ok(parent.toolPrep, 'lost/broken tool requires a new prerequisite')
  })
})

describe('tool order parsing (idkcraft-0jvh)', () => {
  it('parses verbs, tiers and tools; stone is the default', () => {
    assert.deepEqual(bring.parseToolRequest('make me a stone hoe'), { tool: 'stone_hoe' })
    assert.deepEqual(bring.parseToolRequest('craft iron axe'), { tool: 'iron_axe' })
    assert.deepEqual(bring.parseToolRequest('make axe'), { tool: 'stone_axe' })
    assert.deepEqual(bring.parseToolRequest('make me a sharp sword'), { tool: 'stone_sword' })
    assert.deepEqual(bring.parseToolRequest('craft wooden shovel'), { tool: 'wooden_shovel' })
    assert.deepEqual(bring.parseToolRequest('make me wood pickaxe'), { tool: 'wooden_pickaxe' })
    assert.deepEqual(bring.parseToolRequest('craft iron axes'), { tool: 'iron_axe' })
    for (const bad of ['make me a gold hoe', 'make me a diamond sword', 'bring me axe', 'make sandwiches', 'make', 'craft', '', null]) {
      assert.equal(bring.parseToolRequest(bad), null, String(bad))
    }
  })

  it("resolveItem handles '<tier>_<tool>' names exactly", () => {
    const bot = mockBot({})
    assert.deepEqual(bring.resolveItem(bot, 'stone_hoe'), { names: ['stone_hoe'], family: 'stone_hoe' })
    assert.deepEqual(bring.resolveItem(bot, 'iron_axe'), { names: ['iron_axe'], family: 'iron_axe' })
    assert.equal(bring.isToolName('stone_hoe'), true)
    assert.equal(bring.isToolName('hoe'), false)
    assert.equal(bring.isToolName('diamond_sword'), false)
  })
})

describe('ensureTool rung (idkcraft-0jvh)', () => {
  it('a held tool equips and ends the order', () => {
    const bot = mockBot({ items: [{ name: 'stone_hoe', count: 1 }] })
    const o = {}
    const ctx = rungCtx(o)
    assert.equal(bring.ensureTool(bot, ctx, o, 'stone_hoe'), 'done')
    assert.equal(bot.held, 'stone_hoe')
    assert.deepEqual(bot.lines, ['equipped stone_hoe'])
    assert.equal(ctx.bring, null)
  })

  it('covered mats open the craft phase', () => {
    const bot = mockBot({ items: [
      { name: 'cobblestone', count: 3 }, { name: 'stick', count: 2 }, { name: 'crafting_table', count: 1 },
    ] })
    const o = {}
    const ctx = rungCtx(o)
    assert.equal(bring.ensureTool(bot, ctx, o, 'stone_hoe'), 'craft')
    assert.equal(o.phase, 'craft')
    assert.equal(o.craftTarget, 'stone_hoe')
    assert.deepEqual(bot.lines, ['making you a stone_hoe'])
  })

  it('empty hands open the sticks sub first', () => {
    const bot = mockBot({})
    const o = {}
    const ctx = rungCtx(o)
    assert.equal(bring.ensureTool(bot, ctx, o, 'stone_hoe'), 'gap')
    assert.equal(o.kind, 'block')
    assert.equal(o.subFor, 'stone_hoe')
    assert.deepEqual(bot.lines, ['making you a stone_hoe: need 2 sticks, going for logs'])
  })

  it('sticks in hand plus a pick open the cobble block sub', () => {
    const bot = mockBot({ items: [{ name: 'stick', count: 2 }, { name: 'wooden_pickaxe', count: 1 }] })
    const o = {}
    const ctx = rungCtx(o)
    assert.equal(bring.ensureTool(bot, ctx, o, 'stone_hoe'), 'gap')
    assert.equal(o.kind, 'block')
    assert.equal(o.name, 'stone')
    assert.equal(o.drop, 'cobblestone')
    assert.equal(o.subFor, 'stone_hoe')
    assert.deepEqual(bot.lines, ['making you a stone_hoe: need 3 cobblestone, going for stone'])
  })

  it('a cobble gap with no pickaxe refuses honestly', () => {
    const bot = mockBot({ items: [{ name: 'stick', count: 2 }] })
    const o = {}
    const ctx = rungCtx(o)
    assert.equal(bring.ensureTool(bot, ctx, o, 'stone_hoe'), 'refused')
    assert.deepEqual(bot.lines, ['need a pickaxe to dig stone for the stone_hoe'])
    assert.equal(ctx.bring, null)
  })

  it('an iron tool with raw iron opens the smelt gap', () => {
    const bot = mockBot({ items: [{ name: 'raw_iron', count: 3 }] })
    const o = {}
    const ctx = rungCtx(o)
    assert.equal(bring.ensureTool(bot, ctx, o, 'iron_axe'), 'gap')
    assert.equal(o.phase, 'smelt')
    assert.equal(o.smelt.output, 'iron_ingot')
    assert.deepEqual(bot.lines, ['smelting 3 raw_iron for your iron_axe'])
  })

  it('no recipe refuses honestly', () => {
    const bot = mockBot({ recipes: {} })
    const o = {}
    const ctx = rungCtx(o)
    assert.equal(bring.ensureTool(bot, ctx, o, 'stone_hoe'), 'refused')
    assert.deepEqual(bot.lines, ["can't get stone_hoe: no recipe, no source"])
    assert.equal(ctx.bring, null)
  })
})

describe("'make me a stone hoe' (idkcraft-0jvh)", () => {
  it('empty hands with no chest open the wild sticks sub', () => {
    const bot = mockBot({ playerPos: pos(30, 64, 0) })
    handleChat(bot, tickerFor(bot), 'P', 'make me a stone hoe')
    assert.deepEqual(bot.lines, ['making you a stone_hoe: need 2 sticks, going for logs'])
    const o = bot._tickerCtx.bring
    assert.equal(o.toolName, 'stone_hoe')
    assert.deepEqual(o.names, ['stone_hoe'])
    assert.equal(o.subFor, 'stone_hoe')
  })

  it('crafts at the home table, then equips instead of tossing', async () => {
    const bot = mockBot({
      items: [{ name: 'cobblestone', count: 3 }, { name: 'stick', count: 2 }],
      playerPos: pos(30, 64, 0),
      cells: { '0,64,0': 'crafting_table' },
    })
    const ticker = tickerFor(bot)
    tableHome(bot._tickerCtx, 0, 64, 0)
    handleChat(bot, ticker, 'P', 'make me a stone hoe')
    assert.deepEqual(bot.lines, ['making you a stone_hoe'])
    assert.equal(bot._tickerCtx.bring.phase, 'craft')
    await drive(bot, bot._tickerCtx)
    assert.ok(!bot._tickerCtx.bring, 'order completed')
    assert.equal(bot.held, 'stone_hoe')
    assert.ok(bot.lines.includes('equipped stone_hoe'), `lines: ${bot.lines}`)
    assert.deepEqual(bot.tossCalls, [])
    assert.deepEqual(bot.calls.craft, ['stone_hoe'])
  })

  it('chest mats come first: empty hands, full chest, home table', async () => {
    const bot = mockBot({
      chest: [{ name: 'stick', count: 2 }, { name: 'cobblestone', count: 3 }],
      playerPos: pos(30, 64, 0),
      cells: { '0,64,0': 'crafting_table' },
    })
    const ticker = tickerFor(bot)
    tableChestHome(bot._tickerCtx)
    handleChat(bot, ticker, 'P', 'make me a stone hoe')
    assert.deepEqual(bot.lines, ['checking the home chest for stone_hoe'])
    await drive(bot, bot._tickerCtx)
    assert.ok(!bot._tickerCtx.bring, 'order completed')
    assert.equal(bot.held, 'stone_hoe')
    assert.ok(bot.lines.includes('making you a stone_hoe'), `lines: ${bot.lines}`)
    assert.ok(bot.lines.includes('equipped stone_hoe'), `lines: ${bot.lines}`)
    assert.deepEqual(bot.tossCalls, [])
  })

  it("'craft iron axe' with raw iron opens the smelt gap", () => {
    const bot = mockBot({ items: [{ name: 'raw_iron', count: 3 }], playerPos: pos(30, 64, 0) })
    handleChat(bot, tickerFor(bot), 'P', 'craft iron axe')
    assert.deepEqual(bot.lines, ['smelting 3 raw_iron for your iron_axe'])
    assert.equal(bot._tickerCtx.bring.toolName, 'iron_axe')
    assert.equal(bot._tickerCtx.bring.phase, 'smelt')
  })

  it('an unobtainable tool refuses honestly', () => {
    const bot = mockBot({ playerPos: pos(30, 64, 0), recipes: {} })
    handleChat(bot, tickerFor(bot), 'P', 'make me a stone hoe')
    assert.deepEqual(bot.lines, ["can't get stone_hoe: no recipe, no source"])
    assert.ok(!bot._tickerCtx.bring, 'no order created')
  })
})
