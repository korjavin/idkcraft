'use strict'

// idkcraft-g0z.27: a complete castle banks the leftover BOM into its plan
// chest cell (prod 2026-10-09: a 36/36 pack of planks/cobble after 'castle
// done' failed equip/gear/forage/stockpile). Live, so a restart with a
// complete castle banks too; a full chest ends the leg once, no loop.

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const stockpile = require('../src/behaviours/stockpile')
const blueprint = require('../src/castle')
const goal = require('../src/goal')

// Prod world2 castle (v2, rot 0); its plan chest cell is 26 65 6.
const SITE = { x: 8, y: 65, z: -12 }
const CHEST = blueprint.absPlan(SITE, 0, 2).cells.find((c) => c.kind === 'chest')

function pos(x, y, z) {
  return { x, y, z, distanceTo: (q) => Math.hypot(x - q.x, y - q.y, z - q.z) }
}

const IDS = {}
function idOf(name) { return IDS[name] || (IDS[name] = Object.keys(IDS).length + 1) }

// The 07:49 pack: kit plus the leftover BOM, 30 slots.
function prodPack() {
  const inv = [
    { name: 'stone_pickaxe', count: 1 }, { name: 'stone_sword', count: 1 },
    { name: 'bread', count: 12 }, { name: 'white_bed', count: 2 },
  ]
  for (let i = 0; i < 14; i++) inv.push({ name: 'oak_planks', count: 64 })
  for (let i = 0; i < 4; i++) inv.push({ name: 'cobblestone', count: 64 })
  inv.push({ name: 'oak_door', count: 3 }, { name: 'oak_fence', count: 2 }, { name: 'andesite', count: 54 },
    { name: 'raw_iron', count: 32 }, { name: 'black_wool', count: 2 }, { name: 'white_banner', count: 1 },
    { name: 'bone', count: 1 }, { name: 'stick', count: 4 })
  for (const i of inv) i.type = idOf(i.name)
  return inv
}

// chestCap: deposits the chest takes before it throws (full).
function mockBot({ inv = prodPack(), at = pos(CHEST.x + 1.5, CHEST.y, CHEST.z + 0.5), chestAt = true, chestCap = Infinity, openErr = false } = {}) {
  const chest = {}
  let taken = 0
  const said = []
  const pathfinder = { goals: [], setGoal(g) { this.goals.push(g) }, isMoving: () => false }
  const itemsByName = new Proxy({}, { get: (_, n) => (typeof n === 'string' ? { id: idOf(n) } : undefined) })
  const bot = {
    inv, chest, said, pathfinder,
    entity: { position: at },
    registry: { blocksByName: { chest: { id: 7 } }, itemsByName },
    inventory: { items: () => inv.filter((i) => i.count > 0) },
    blockAt: (p) => {
      const x = Math.floor(p.x); const y = Math.floor(p.y); const z = Math.floor(p.z)
      const name = chestAt && x === CHEST.x && y === CHEST.y && z === CHEST.z ? 'chest' : (y < 65 ? 'stone' : 'air')
      return { name, position: pos(x, y, z) }
    },
    findBlocks: () => [],
    chat: (m) => said.push(m),
    openChest: async () => {
      if (openErr) throw new Error('lag')
      return chestWindow
    },
  }
  const chestWindow = {
    close() {},
    async deposit(type, _meta, count) {
      if (taken >= chestCap) throw new Error('full')
      let left = count
      for (const i of inv) {
        if (left <= 0) break
        if (i.type !== type || !(i.count > 0)) continue
        const k = Math.min(i.count, left)
        i.count -= k
        left -= k
        chest[i.name] = (chest[i.name] || 0) + k
      }
      taken++
    },
  }
  return bot
}

function doneCtx(over = {}) {
  return { castle: { site: { ...SITE }, rot: 0, blueprintVersion: 2, phase: 'complete', blocked: {} }, ...over }
}

function packOf(bot, name) {
  return bot.inv.filter((i) => i.name === name).reduce((a, i) => a + i.count, 0)
}

// Two ticks: the walk issue, then the deposit (async window).
async function bankRun(bot, ctx) {
  stockpile(bot, ctx)
  stockpile(bot, ctx)
  await new Promise((r) => setImmediate(r))
}

describe('g0z.27 castle bank', () => {
  it('the plan has one chest cell (the bank target)', () => {
    assert.ok(CHEST, 'v2 plan chest cell')
    const bot = mockBot()
    assert.deepEqual({ ...stockpile.castleBankAt(bot, doneCtx()) }, { x: CHEST.x, y: CHEST.y, z: CHEST.z })
  })

  it('banks the leftover BOM into the plan chest after restart, keeps the kit', async () => {
    // A restored ctx: phase complete from memory, no castle tick this session.
    const bot = mockBot()
    const ctx = doneCtx()
    // Feasible with the home unbuilt (prod: 'stockpile: house not built yet').
    const facts = { home: 'none', haul: 'none', player: 'none', surplus: 'yes' }
    assert.equal(goal.MENU.stockpile.feasible(facts, bot, ctx), true)
    await bankRun(bot, ctx)
    assert.equal(ctx.lastGoalKey, `stockpile-site:${CHEST.x},${CHEST.y},${CHEST.z}`)
    assert.equal(bot.chest.oak_planks, 14 * 64 - stockpile.GEAR_RESERVE_PLANKS) // the gear ladder reserve stays
    assert.equal(bot.chest.cobblestone, 4 * 64 - stockpile.SCAFFOLD_KEEP - stockpile.GEAR_RESERVE_COBBLE)
    assert.equal(bot.chest.andesite, 54)
    assert.equal(packOf(bot, 'stone_pickaxe'), 1)
    assert.equal(packOf(bot, 'stone_sword'), 1)
    assert.equal(packOf(bot, 'bread'), stockpile.FOOD_KEEP)
    assert.equal(packOf(bot, 'white_bed'), 1, 'the spawn bed stays')
    assert.equal(packOf(bot, 'cobblestone'), stockpile.SCAFFOLD_KEEP + stockpile.GEAR_RESERVE_COBBLE)
    assert.equal(packOf(bot, 'oak_planks'), stockpile.GEAR_RESERVE_PLANKS)
    const line = bot.said.find((m) => m.startsWith('castle done at 8 65 -12'))
    assert.ok(line && /\d+ items banked/.test(line), `summary line: ${bot.said}`)
    assert.equal(ctx.stepStatus, 'done')
    assert.equal(ctx.castle.siteChest, undefined, 'no site chest adopted or placed')
  })

  it('a full chest ends the leg with a status line, then parks (no loop)', async () => {
    const bot = mockBot({ chestCap: 0 })
    const ctx = doneCtx()
    await bankRun(bot, ctx)
    assert.ok(bot.said.includes('the castle chest is full'))
    assert.equal(ctx.stepStatus, 'done')
    assert.equal(stockpile.castleBankAt(bot, ctx), null)
    assert.equal(stockpile.siteMode(bot, ctx), false)
    const facts = { home: 'none', haul: 'none', player: 'none', surplus: 'yes' }
    assert.equal(goal.MENU.stockpile.feasible(facts, bot, ctx), false)
  })

  it('off for an unfinished, parked, far or chestless castle', () => {
    assert.equal(stockpile.castleBankAt(mockBot(), doneCtx({ castle: { ...doneCtx().castle, phase: 'body' } })), null)
    assert.equal(stockpile.castleBankAt(mockBot(), doneCtx({ castle: { ...doneCtx().castle, parked: true } })), null)
    assert.equal(stockpile.castleBankAt(mockBot({ at: pos(300, 65, 300) }), doneCtx()), null)
    assert.equal(stockpile.castleBankAt(mockBot({ chestAt: false }), doneCtx()), null)
  })

  it('a chest that will not open fails the leg but keeps the bank armed', async () => {
    const bot = mockBot({ openErr: true })
    const ctx = doneCtx()
    await bankRun(bot, ctx)
    assert.equal(ctx.stepStatus, 'failed:deposit')
    assert.ok(stockpile.castleBankAt(bot, ctx), 'still armed')
  })

  it('the castle done summary is said once; a later bank is a plain stockpile line', async () => {
    const bot = mockBot()
    const ctx = doneCtx()
    await bankRun(bot, ctx)
    bot.inv.push({ name: 'oak_log', count: 20, type: idOf('oak_log') })
    ctx.lastGoalKey = null
    await bankRun(bot, ctx)
    assert.equal(bot.said.filter((m) => m.startsWith('castle done')).length, 1)
    assert.ok(bot.said.some((m) => m.startsWith('stockpiled ') && m.includes('oak_log')), `${bot.said}`)
  })

  it('a near built home keeps the home chest', () => {
    const ctx = doneCtx({ home: { site: { x: CHEST.x, y: 65, z: CHEST.z }, built: true } })
    assert.equal(stockpile.siteMode(mockBot(), ctx), false)
  })

  it('nothing to bank is not feasible', () => {
    const facts = { home: 'none', haul: 'none', player: 'none', surplus: 'no' }
    assert.equal(goal.MENU.stockpile.feasible(facts, mockBot(), doneCtx()), false)
  })
})
