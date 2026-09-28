'use strict'

// 'bring me <item>' (idkcraft-did.1): chat parsing with articles and families,
// the item resolver, and the pack -> chest -> honest-refusal ladder. Items
// resolve as no block here (empty blocks registry), like wool/bed/axe live.

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const bring = require('../src/behaviours/bring')
const { handleChat, createTicker } = require('../src/index')

function pos(x, y, z) {
  const p = {
    x, y, z,
    distanceTo: (q) => Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z),
    clone() { return pos(p.x, p.y, p.z) },
  }
  return p
}

const ITEMS = {
  stone_axe: 101, iron_axe: 102, stone_pickaxe: 103, iron_sword: 104, shears: 105,
  white_wool: 106, gray_wool: 107, white_bed: 108, water_bucket: 109, bucket: 110,
  torch: 111, dirt: 112, cobblestone: 113,
}

function mockBot({ items = [], chest = [], playerPos = null, animals = [] } = {}) {
  const lines = []
  const tossCalls = []
  const calls = { setGoal: 0, goals: [], opens: 0 }
  const blocksByName = {}
  const itemsByName = {}
  for (const [name, id] of Object.entries(ITEMS)) itemsByName[name] = { id }
  const entities = {}
  for (const a of animals) entities[a.id] = a
  const bot = {
    lines, tossCalls, calls, chest,
    username: 'IdkBot',
    entities,
    health: 20,
    food: 20,
    entity: { position: pos(0, 64, 0), onGround: true },
    registry: { blocksByName, itemsByName },
    players: { P: { username: 'P', entity: playerPos ? { position: playerPos } : null } },
    _moving: false,
    _items: items,
    pathfinder: {
      goal: null,
      setGoal: (goal) => { calls.setGoal++; calls.goals.push(goal); bot.pathfinder.goal = goal },
      isMoving: () => bot._moving,
    },
    inventory: { items: () => bot._items },
    findBlocks: () => [],
    blockAt(p) {
      return (p && Math.floor(p.x) === 5 && Math.floor(p.y) === 64 && Math.floor(p.z) === 1)
        ? { name: 'chest', position: pos(5, 64, 1) }
        : null
    },
    openChest: async () => {
      calls.opens++
      return {
        containerItems: () => chest.map((s) => ({ name: s.name, type: itemsByName[s.name].id, metadata: null, count: s.count })),
        withdraw: async (type, _meta, count) => {
          const name = Object.keys(itemsByName).find((k) => itemsByName[k].id === type)
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

function chestHome(ctx) {
  ctx.home = { site: { x: 0, y: 64, z: 0 }, built: true, chest: { x: 5, y: 64, z: 1 } }
}

const flush = () => new Promise((r) => { setImmediate(() => setImmediate(r)) })

// Drive an item order: walk the chest leg, then stand at the player.
async function drive(bot, ctx) {
  for (let i = 0; i < 40 && ctx.bring; i++) {
    await bring(bot, ctx, null, {})
    await flush()
    const o = ctx.bring
    if (!o) break
    if (o.phase === 'chestfetch') { bot._moving = false; bot.entity.position = pos(5, 64, 1) }
    if (o.phase === 'return') {
      const pp = bot.players.P.entity.position
      bot.entity.position = pos(pp.x, pp.y, pp.z)
    }
  }
}

function sheep(id, x) {
  return { id, name: 'sheep', type: 'mob', position: pos(x, 64, 0), isValid: true }
}

describe('bring chat parsing (idkcraft-did.1)', () => {
  it('strips articles and joins words with _', () => {
    assert.equal(bring.normalizeBringName('a white bed'), 'white_bed')
    assert.equal(bring.normalizeBringName('An Axe'), 'axe')
    assert.equal(bring.normalizeBringName('the wool'), 'wool')
    assert.equal(bring.normalizeBringName('some beds'), 'beds')
    assert.equal(bring.normalizeBringName('water bucket'), 'water_bucket')
    assert.equal(bring.normalizeBringName('  coal  '), 'coal')
  })

  it('food phrases still route to food after normalisation', () => {
    assert.ok(bring.isFoodRequest(bring.normalizeBringName('something to eat')))
    assert.ok(bring.isFoodRequest(bring.normalizeBringName('some food')))
    assert.ok(bring.isFoodRequest(bring.normalizeBringName('meat')))
    assert.ok(!bring.isFoodRequest(bring.normalizeBringName('a bed')))
  })
})

describe('bring item resolver (idkcraft-did.1)', () => {
  const bot = mockBot({})

  it('exact names resolve to themselves', () => {
    assert.deepEqual(bring.resolveItem(bot, 'white_bed'), { names: ['white_bed'], family: 'white_bed' })
    assert.deepEqual(bring.resolveItem(bot, 'water_bucket'), { names: ['water_bucket'], family: 'water_bucket' })
    assert.deepEqual(bring.resolveItem(bot, 'bucket'), { names: ['bucket'], family: 'bucket' })
  })

  it('families resolve to every *_<name>', () => {
    assert.deepEqual(bring.resolveItem(bot, 'wool'), { names: ['gray_wool', 'white_wool'], family: 'wool' })
    assert.deepEqual(bring.resolveItem(bot, 'axe'), { names: ['iron_axe', 'stone_axe'], family: 'axe' })
    assert.deepEqual(bring.resolveItem(bot, 'bed'), { names: ['white_bed'], family: 'bed' })
  })

  it('plurals resolve like the singular', () => {
    assert.deepEqual(bring.resolveItem(bot, 'beds'), bring.resolveItem(bot, 'bed'))
    assert.deepEqual(bring.resolveItem(bot, 'torches'), { names: ['torch'], family: 'torch' })
  })

  it("'a bed' and 'beds' resolve identically through chat normalisation", () => {
    const a = bring.resolveItem(bot, bring.normalizeBringName('a bed'))
    const b = bring.resolveItem(bot, bring.normalizeBringName('beds'))
    assert.deepEqual(a, b)
    assert.deepEqual(a, { names: ['white_bed'], family: 'bed' })
  })

  it('typos resolve to nothing, never fuzzy', () => {
    assert.equal(bring.resolveItem(bot, 'whool'), null)
    assert.equal(bring.resolveItem(bot, 'unobtanium'), null)
    assert.equal(bring.resolveItem(bot, ''), null)
  })
})

describe('bring pack plan keep-list (idkcraft-did.1)', () => {
  it('two axes give one, a single axe is kept-only', () => {
    const fam = { names: ['iron_axe', 'stone_axe'], family: 'axe' }
    const two = mockBot({ items: [{ name: 'stone_axe', count: 2 }] })
    assert.deepEqual(bring.planItemGive(two, fam, 3), {
      items: [{ name: 'stone_axe', count: 1 }], have: 1, want: 3, keptOnly: false,
    })
    const one = mockBot({ items: [{ name: 'stone_axe', count: 1 }] })
    const p = bring.planItemGive(one, fam, 1)
    assert.equal(p.have, 0)
    assert.equal(p.keptOnly, true)
  })

  it('the last pickaxe/sword/shears are never given', () => {
    for (const tool of ['stone_pickaxe', 'iron_sword', 'shears']) {
      const bot = mockBot({ items: [{ name: tool, count: 1 }] })
      const p = bring.planItemGive(bot, { names: [tool], family: tool }, 1)
      assert.deepEqual([tool, p.have, p.keptOnly], [tool, 0, true])
    }
  })

  it('dirt keeps the 32-block pillar reserve', () => {
    const dirt = { names: ['dirt'], family: 'dirt' }
    const rich = mockBot({ items: [{ name: 'dirt', count: 40 }] })
    assert.equal(bring.planItemGive(rich, dirt, 10).have, 8)
    const poor = mockBot({ items: [{ name: 'dirt', count: 10 }] })
    const p = bring.planItemGive(poor, dirt, 3)
    assert.equal(p.have, 0)
    assert.equal(p.keptOnly, true)
  })

  it('unreadable inventory plans nothing, kept-only false', () => {
    const bot = mockBot({})
    bot.inventory.items = () => { throw new Error('window flicker') }
    assert.deepEqual(bring.planItemGive(bot, { names: ['white_wool'], family: 'wool' }, 3), {
      items: [], have: 0, want: 3, keptOnly: false,
    })
  })
})

describe('bring me <item> from the pack (idkcraft-did.1)', () => {
  it("'bring me axe' with two axes returns and tosses one", async () => {
    const bot = mockBot({ items: [{ name: 'stone_axe', count: 2 }], playerPos: pos(30, 64, 0) })
    handleChat(bot, tickerFor(bot), 'P', 'bring me axe')
    assert.deepEqual(bot.lines, ['only 1 stone_axe, coming'])
    const o = bot._tickerCtx.bring
    assert.equal(o && o.kind, 'item')
    assert.equal(o && o.phase, 'return')
    await drive(bot, bot._tickerCtx)
    assert.ok(!bot._tickerCtx.bring, 'no order created')
    assert.deepEqual(bot.tossCalls, [[ITEMS.stone_axe, null, 1]])
    assert.ok(bot.lines.includes('here are 1 stone_axe'), `lines: ${bot.lines}`)
  })

  it("'bring me axe 1' with two axes is exact, not partial", async () => {
    const bot = mockBot({ items: [{ name: 'stone_axe', count: 2 }], playerPos: pos(30, 64, 0) })
    handleChat(bot, tickerFor(bot), 'P', 'bring me axe 1')
    assert.deepEqual(bot.lines, ['coming with 1 stone_axe'])
    await drive(bot, bot._tickerCtx)
    assert.deepEqual(bot.tossCalls, [[ITEMS.stone_axe, null, 1]])
  })

  it("a single axe is kept and refused honestly when there is no chest", () => {
    const bot = mockBot({ items: [{ name: 'stone_axe', count: 1 }], playerPos: pos(30, 64, 0) })
    handleChat(bot, tickerFor(bot), 'P', 'bring me axe')
    assert.deepEqual(bot.lines, ["my only axe, can't make another yet"])
    assert.ok(!bot._tickerCtx.bring, 'no order created')
  })

  it("single shears are kept too ('bring me shears')", () => {
    const bot = mockBot({ items: [{ name: 'shears', count: 1 }], playerPos: pos(30, 64, 0) })
    handleChat(bot, tickerFor(bot), 'P', 'bring me shears')
    assert.deepEqual(bot.lines, ["my only shears, can't make another yet"])
    assert.ok(!bot._tickerCtx.bring, 'no order created')
  })

  it("'bring me a white bed' gives the exact bed from the pack", async () => {
    const bot = mockBot({ items: [{ name: 'white_bed', count: 1 }], playerPos: pos(30, 64, 0) })
    handleChat(bot, tickerFor(bot), 'P', 'bring me a white bed')
    assert.deepEqual(bot.lines, ['only 1 white_bed, coming'])
    await drive(bot, bot._tickerCtx)
    assert.deepEqual(bot.tossCalls, [[ITEMS.white_bed, null, 1]])
    assert.ok(bot.lines.includes('here are 1 white_bed'), `lines: ${bot.lines}`)
  })

  it("'bring me water bucket' is giveable from the pack", async () => {
    const bot = mockBot({ items: [{ name: 'water_bucket', count: 2 }], playerPos: pos(30, 64, 0) })
    handleChat(bot, tickerFor(bot), 'P', 'bring me water bucket')
    assert.deepEqual(bot.lines, ['only 2 water_bucket, coming'])
    await drive(bot, bot._tickerCtx)
    assert.deepEqual(bot.tossCalls, [[ITEMS.water_bucket, null, 2]])
  })

  it("'bring me dirt 10' honours the pillar reserve", async () => {
    const bot = mockBot({ items: [{ name: 'dirt', count: 40 }], playerPos: pos(30, 64, 0) })
    handleChat(bot, tickerFor(bot), 'P', 'bring me dirt 10')
    assert.deepEqual(bot.lines, ['only 8 dirt, coming'])
    await drive(bot, bot._tickerCtx)
    assert.deepEqual(bot.tossCalls, [[ITEMS.dirt, null, 8]])
  })

  it('an unseen player gets the come-closer line with the item count', async () => {
    const bot = mockBot({ items: [{ name: 'stone_axe', count: 2 }], playerPos: null })
    bot.players.P.entity = null
    handleChat(bot, tickerFor(bot), 'P', 'bring me axe 1')
    await bring(bot, bot._tickerCtx, null, {})
    assert.ok(bot.lines.includes("I can't see you — I'm at 0 64 0 with your 1 stone_axe; come closer"), `lines: ${bot.lines}`)
    assert.ok(bot._tickerCtx.bring, 'order held until the player returns')
  })

  it('stop mid-item-return cancels the order', async () => {
    const bot = mockBot({ items: [{ name: 'stone_axe', count: 2 }], playerPos: pos(30, 64, 0) })
    const ticker = tickerFor(bot)
    handleChat(bot, ticker, 'P', 'bring me axe 1')
    assert.ok(bot._tickerCtx.bring, 'order created')
    ticker.stop()
    assert.ok(!bot._tickerCtx.bring, 'no order created')
  })
})

describe('bring me <item> from the chest (idkcraft-did.1)', () => {
  it("'bring me wool 3' fetches from the chest, then returns", async () => {
    const bot = mockBot({ chest: [{ name: 'white_wool', count: 5 }], playerPos: pos(30, 64, 0) })
    const ticker = tickerFor(bot)
    chestHome(bot._tickerCtx)
    handleChat(bot, ticker, 'P', 'bring me wool 3')
    assert.deepEqual(bot.lines, ['checking the home chest for wool'])
    assert.equal(bot._tickerCtx.bring.phase, 'chestfetch')
    await drive(bot, bot._tickerCtx)
    assert.ok(!bot._tickerCtx.bring, 'no order created')
    assert.deepEqual(bot.tossCalls, [[ITEMS.white_wool, null, 3]])
    assert.ok(bot.lines.includes('here are 3 white_wool'), `lines: ${bot.lines}`)
  })

  it('a short chest returns a partial haul with an honest only-line', async () => {
    const bot = mockBot({ chest: [{ name: 'white_wool', count: 2 }], playerPos: pos(30, 64, 0) })
    const ticker = tickerFor(bot)
    chestHome(bot._tickerCtx)
    handleChat(bot, ticker, 'P', 'bring me wool 3')
    await drive(bot, bot._tickerCtx)
    assert.ok(!bot._tickerCtx.bring, 'no order created')
    assert.ok(bot.lines.includes('only 2 white_wool, coming'), `lines: ${bot.lines}`)
    assert.deepEqual(bot.tossCalls, [[ITEMS.white_wool, null, 2]])
  })

  it('an empty chest ends the order with the honest reason', async () => {
    const bot = mockBot({ chest: [{ name: 'torch', count: 9 }], playerPos: pos(30, 64, 0) })
    const ticker = tickerFor(bot)
    chestHome(bot._tickerCtx)
    handleChat(bot, ticker, 'P', 'bring me wool 3')
    await drive(bot, bot._tickerCtx)
    assert.ok(!bot._tickerCtx.bring, 'no order created')
    assert.ok(bot.lines.includes("can't get wool: no recipe, no source"), `lines: ${bot.lines}`)
    assert.equal(bot.tossCalls.length, 0)
  })

  it('a chest lost mid-order refuses with the item reason', async () => {
    const bot = mockBot({ chest: [{ name: 'white_wool', count: 5 }], playerPos: pos(30, 64, 0) })
    const ticker = tickerFor(bot)
    const ctx = bot._tickerCtx
    chestHome(ctx)
    handleChat(bot, ticker, 'P', 'bring me wool 3')
    ctx.home.chest = null // mined before the bot arrived
    await bring(bot, ctx, null, {})
    await flush()
    assert.equal(ctx.bring, null)
    assert.ok(bot.lines.includes("can't get wool: no recipe, no source"), `lines: ${bot.lines}`)
  })
})

describe('bring me <item> refusals (idkcraft-did.1)', () => {
  it("'bring me bed' with no bed anywhere is one honest line", () => {
    const bot = mockBot({ playerPos: pos(30, 64, 0) })
    handleChat(bot, tickerFor(bot), 'P', 'bring me bed')
    assert.deepEqual(bot.lines, ["can't get bed: no recipe, no source"])
    assert.ok(!bot._tickerCtx.bring, 'no order created')
  })

  it("'bring me a bed' and 'bring me beds' refuse identically", () => {
    for (const cmd of ['bring me a bed', 'bring me beds']) {
      const bot = mockBot({ playerPos: pos(30, 64, 0) })
      handleChat(bot, tickerFor(bot), 'P', cmd)
      assert.deepEqual(bot.lines, ["can't get bed: no recipe, no source"], cmd)
    }
  })

  it("'bring me whool' is unknown, never a block guess", () => {
    const bot = mockBot({ playerPos: pos(30, 64, 0) })
    handleChat(bot, tickerFor(bot), 'P', 'bring me whool')
    assert.deepEqual(bot.lines, ['unknown item: whool'])
    assert.ok(!bot._tickerCtx.bring, 'no order created')
  })

  it('wool with a sheep nearby names the sheep', () => {
    const bot = mockBot({ playerPos: pos(30, 64, 0), animals: [sheep(7, 10)] })
    handleChat(bot, tickerFor(bot), 'P', 'bring me wool')
    assert.deepEqual(bot.lines, ['wool comes from sheep (next)'])
    assert.ok(!bot._tickerCtx.bring, 'no order created')
  })

  it('a recipe names the coming craft instead of nothing', () => {
    const bot = mockBot({ playerPos: pos(30, 64, 0) })
    bot.recipesAll = (id) => (id === ITEMS.stone_axe ? [{}] : [])
    handleChat(bot, tickerFor(bot), 'P', 'bring me axe')
    assert.deepEqual(bot.lines, ["can't make axe yet (crafting comes next)"])
    assert.ok(!bot._tickerCtx.bring, 'no order created')
  })

  it('the kept last tool wins over the recipe line', () => {
    const bot = mockBot({ items: [{ name: 'stone_axe', count: 1 }], playerPos: pos(30, 64, 0) })
    bot.recipesAll = (id) => (id === ITEMS.stone_axe ? [{}] : [])
    handleChat(bot, tickerFor(bot), 'P', 'bring me axe')
    assert.deepEqual(bot.lines, ["my only axe, can't make another yet"])
    assert.ok(!bot._tickerCtx.bring, 'no order created')
  })
})

describe('bring tierArticle (idkcraft-xfs)', () => {
  it('is shared between bring and the pickaxe refusal', () => {
    assert.equal(typeof bring.tierArticle, 'function')
    assert.equal(bring.tierArticle('iron'), 'an')
    assert.equal(bring.tierArticle('stone'), 'a')
  })
})
