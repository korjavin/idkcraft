'use strict'

// idkcraft-g0z.37: the sand rung — bring fetches sand bare-handed, resource
// memory notes sand in its own capped scan, stockpile keeps sand/glass
// (capped) only while a castle pane cell is open.

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const Vec3 = require('vec3')
const bring = require('../src/behaviours/bring')
const forage = require('../src/behaviours/forage')
const resources = require('../src/resources')
const stockpile = require('../src/behaviours/stockpile')
const blueprint = require('../src/castle')
const { handleChat, createTicker } = require('../src/index')

function pos(x, y, z) {
  const p = {
    x, y, z,
    distanceTo: (q) => Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z),
    clone() { return pos(p.x, p.y, p.z) },
  }
  return p
}

const BLOCKS = { sand: 5, red_sand: 6, gravel: 7, water: 8, iron_ore: 31 }
const ITEMS = { sand: 5 }

function mockBot({ names = {}, items = [], playerPos = null } = {}) {
  const lines = []
  const blocksByName = {}
  for (const [name, id] of Object.entries(BLOCKS)) blocksByName[name] = { id }
  const itemsByName = {}
  for (const [name, id] of Object.entries(ITEMS)) itemsByName[name] = { id }
  const bot = {
    lines,
    username: 'IdkBot',
    entities: {},
    health: 20,
    food: 20,
    entity: { position: pos(0, 64, 0), onGround: true },
    registry: { blocksByName, itemsByName },
    players: { P: { username: 'P', entity: playerPos ? { position: playerPos } : null } },
    _moving: false,
    _items: items,
    digCalls: 0,
    pathfinder: {
      goal: null,
      setGoal: (goal) => { bot.pathfinder.goal = goal },
      isMoving: () => bot._moving,
      bestHarvestTool: () => null,
    },
    held: null,
    equip: async (item) => { bot.held = item && item.name },
    unequip: async () => { bot.held = null },
    inventory: { items: () => bot._items },
    findBlocks(opts) {
      const want = new Set(Array.isArray(opts.matching) ? opts.matching : [opts.matching])
      const out = []
      for (const [k, n] of Object.entries(names)) {
        if (BLOCKS[n] !== undefined && want.has(BLOCKS[n])) {
          const [x, y, z] = k.split(',').map(Number)
          out.push(pos(x, y, z))
        }
      }
      out.sort((a, b) => Math.hypot(a.x - bot.entity.position.x, a.z - bot.entity.position.z) - Math.hypot(b.x - bot.entity.position.x, b.z - bot.entity.position.z))
      return typeof opts.count === 'number' ? out.slice(0, opts.count) : out
    },
    blockAt(p) {
      const n = names[`${p.x},${p.y},${p.z}`]
      return n ? { name: n, position: pos(p.x, p.y, p.z) } : null
    },
    canDigBlock: () => true,
    dig: async (block) => {
      bot.digCalls++
      const bp = block && block.position
      if (bp) delete names[`${bp.x},${bp.y},${bp.z}`]
      // Sand drops bare-handed: no tool gate on the drop.
      const s = bot._items.find((i) => i.name === block.name)
      if (s) s.count++
      else bot._items.push({ name: block.name, count: 1 })
    },
    toss: async () => {},
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

const flush = () => new Promise((resolve) => setImmediate(resolve))

describe('sand rung (g0z.37)', () => {
  it('isBringable: sand and red_sand yes, gravel and stone no; no pickaxe needed', () => {
    assert.equal(bring.isBringable('sand'), true)
    assert.equal(bring.isBringable('red_sand'), true)
    assert.equal(bring.isBringable('gravel'), false)
    assert.equal(bring.isBringable('stone'), false)
    assert.equal(bring.needsPickaxe('sand'), false)
    assert.equal(bring.dropFor('sand'), 'sand')
  })

  it('a castle self order on an exposed patch 20 off ends with 18 sand packed, no return walk', async () => {
    const names = {}
    for (let x = 20; x < 26; x++) for (let z = 0; z < 4; z++) names[`${x},63,${z}`] = 'sand' // 24 exposed
    const bot = mockBot({ names })
    const ctx = { lastGoalKey: '', bring: { kind: 'block', name: 'sand', want: 18, have: 0, by: null, drop: 'sand', phase: 'find', self: 'castle' } }
    let sawReturn = false
    for (let i = 0; i < 400 && ctx.bring; i++) {
      await bring(bot, ctx, null, {})
      await flush()
      const o = ctx.bring
      if (!o) break
      if (o.phase === 'return') sawReturn = true
      const gk = ctx.lastGoalKey || ''
      if (gk.startsWith('bring:') && o.pos) {
        bot.entity.position = pos(o.pos.x + 1, o.pos.y + 1, o.pos.z)
        bot._moving = false
      } else if (gk.startsWith('bring-pickup')) {
        bot._moving = false
      }
      assert.ok(!gk.startsWith('bring-return'), 'a self order never walks back')
    }
    assert.equal(ctx.bring, null)
    const sand = bot._items.find((s) => s.name === 'sand')
    assert.ok(sand && sand.count >= 18, `pack: ${JSON.stringify(bot._items)}`)
    assert.ok(sawReturn, 'ends through the return phase')
  })

  it("'bring me sand' becomes a real order (was the ores-and-logs refusal)", () => {
    const names = { '5,63,0': 'sand' }
    const bot = mockBot({ names, playerPos: pos(30, 64, 0) })
    handleChat(bot, tickerFor(bot), 'P', 'bring me sand')
    const ctx = bot._tickerCtx
    assert.ok(ctx.bring, `chats: ${bot.lines.join(' | ')}`)
    assert.equal(ctx.bring.drop, 'sand')
    assert.ok(!bot.lines.some((l) => /ores and logs only/.test(l)))
  })

  it("'bring me gravel' still refuses", () => {
    const bot = mockBot({ names: { '5,63,0': 'gravel' }, playerPos: pos(30, 64, 0) })
    handleChat(bot, tickerFor(bot), 'P', 'bring me gravel')
    assert.equal(bot._tickerCtx.bring || null, null)
  })

  it('sand under water is skipped at find and the refusal is honest', async () => {
    const names = { '6,60,0': 'sand', '6,61,0': 'water' }
    const bot = mockBot({ names, playerPos: pos(30, 64, 0) })
    handleChat(bot, tickerFor(bot), 'P', 'bring me sand')
    const ctx = bot._tickerCtx
    for (let i = 0; i < 5 && ctx.bring; i++) await bring(bot, ctx, null, {})
    assert.equal(ctx.bring, null)
    assert.ok(bot.lines.includes('could not reach sand safely'), `chats: ${bot.lines.join(' | ')}`)
  })
})

describe('resource memory notes sand (g0z.37)', () => {
  it('40 sand + 3 ores: all ores, <= 16 sand, exposed flag set; cap holds', () => {
    const names = { '10,60,0': 'iron_ore', '11,60,0': 'iron_ore', '12,60,0': 'iron_ore' }
    for (let i = 0; i < 40; i++) names[`${i},63,5`] = 'sand'
    const bot = mockBot({ names })
    const ctx = {}
    resources.scan(bot, ctx, { now: 5000 })
    const items = [...ctx.resources.items.values()]
    assert.equal(items.filter((s) => s.name === 'iron_ore').length, 3)
    const sand = items.filter((s) => s.name === 'sand')
    assert.ok(sand.length > 0 && sand.length <= 16, `sand ${sand.length}`)
    assert.ok(sand.every((s) => typeof s.exposed === 'boolean'))
    for (let i = 0; i < 20; i++) resources.scan(bot, ctx, { now: 5000 + i })
    assert.ok(resources.count(ctx) <= resources.MAX_ITEMS)
  })

  it('forage never picks remembered sand (castle stock only)', () => {
    const ctx = { lastGoalKey: '', stepStatus: 'running' }
    resources.noteSpots(ctx, [{ x: 1, y: 63, z: 0, name: 'sand', exposed: true }], 1000)
    const bot = mockBot({ items: [{ name: 'stone_pickaxe', count: 1 }] })
    const p = forage.planForage(bot, ctx)
    assert.ok(!p || p.name !== 'sand', JSON.stringify(p))
  })
})

describe('stockpile pane-ladder keep (g0z.37)', () => {
  const SITE = { x: 100, y: 64, z: 200 }
  const state = () => ({ site: { ...SITE }, rot: 0, blueprintVersion: 2, phase: 'complete', blocked: {}, parked: false })
  function packBot(items, panesLaid) {
    const laid = new Set()
    if (panesLaid) for (const c of blueprint.decorPlan(SITE, 0, 2).cells) if (c.kind === 'pane') laid.add(`${c.x},${c.y},${c.z}`)
    return {
      username: 'IdkBot',
      entity: { position: new Vec3(0, 64, 0) },
      inventory: { items: () => items },
      registry: { blocksByName: {}, itemsByName: {} },
      blockAt: (p) => ({ name: laid.has(`${p.x},${p.y},${p.z}`) ? 'glass_pane' : 'air', position: p }),
    }
  }
  const banked = (plan, name) => plan.filter((p) => p.name === name).reduce((a, p) => a + p.count, 0)

  it('open pane cell: keeps 18 sand / 18 glass, banks the rest', () => {
    const bot = packBot([{ name: 'sand', count: 19 }, { name: 'glass', count: 20 }], false)
    const plan = stockpile.depositPlan(bot, { castle: state(), home: null })
    assert.equal(banked(plan, 'sand'), 1, JSON.stringify(plan))
    assert.equal(banked(plan, 'glass'), 2, JSON.stringify(plan))
  })

  it('no open pane cell: sand banks like junk (vmzq.38)', () => {
    const bot = packBot([{ name: 'sand', count: 19 }, { name: 'glass', count: 4 }], true)
    const plan = stockpile.depositPlan(bot, { castle: state(), home: null })
    assert.equal(banked(plan, 'sand'), 19, JSON.stringify(plan))
    assert.equal(banked(plan, 'glass'), 4)
  })

  it('away from the site (unloaded) the keep still holds (revmux 01)', () => {
    const bot = packBot([{ name: 'sand', count: 18 }], false)
    bot.blockAt = () => null
    assert.equal(banked(stockpile.depositPlan(bot, { castle: state(), home: null }), 'sand'), 0)
  })

  it('no castle: sand banks', () => {
    const bot = packBot([{ name: 'sand', count: 5 }], false)
    assert.equal(banked(stockpile.depositPlan(bot, { home: null }), 'sand'), 5)
  })
})
