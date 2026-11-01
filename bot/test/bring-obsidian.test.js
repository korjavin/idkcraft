'use strict'

// Mine-exposed-obsidian rung (idkcraft-6ci5.1): 'bring me obsidian' mines
// placed obsidian with a diamond pick and delivers it. Rig scenario:
// pre-placed obsidian + a kitted diamond pick — mine + deliver green.

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const bring = require('../src/behaviours/bring')
const obsidian = require('../src/behaviours/obsidian')
const { dropFor, needsPickaxe, hasPickaxe, requiredTier } = require('../src/behaviours/bring')
const { handleChat, createTicker } = require('../src/index')

function pos(x, y, z) {
  const p = {
    x, y, z,
    distanceTo: (q) => Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z),
    clone() { return pos(p.x, p.y, p.z) },
  }
  return p
}

const BLOCKS = { obsidian: 11, stone: 1 }
const ITEMS = { obsidian: 31, diamond_pickaxe: 24, iron_pickaxe: 25 }

function mockBot({ spots = [], names = {}, items = [], playerPos = null } = {}) {
  const lines = []
  const tossCalls = []
  const calls = { setGoal: 0, goals: [] }
  const blocksByName = {}
  for (const [name, id] of Object.entries(BLOCKS)) blocksByName[name] = { id }
  const itemsByName = {}
  for (const [name, id] of Object.entries(ITEMS)) itemsByName[name] = { id }
  const bot = {
    lines, tossCalls, calls,
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
      setGoal: (goal) => { calls.setGoal++; calls.goals.push(goal); bot.pathfinder.goal = goal },
      isMoving: () => bot._moving,
      bestHarvestTool: () => ({ name: 'diamond_pickaxe', type: 99 }),
    },
    held: null,
    equipped: [],
    equip: async (item) => { bot.held = item && item.name; bot.equipped.push(bot.held) },
    inventory: { items: () => bot._items },
    findBlocks(opts) {
      const want = new Set(Array.isArray(opts.matching) ? opts.matching : [opts.matching])
      return spots.filter((q) => {
        const n = names[`${q.x},${q.y},${q.z}`]
        const id = n && blocksByName[n] ? blocksByName[n].id : undefined
        return want.has(id)
      })
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
      // Drops only land when a pickaxe is held (the ore rule)
      if (bot.held && bot.held.endsWith('_pickaxe')) bot._items.push({ name: dropFor(block.name), count: 1 })
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

const flush = () => new Promise((resolve) => setImmediate(resolve))

describe('obsidian data module (idkcraft-6ci5.1)', () => {
  it('matches only the single-name obsidian family', () => {
    assert.equal(obsidian.isObsidianFamily({ names: ['obsidian'], family: 'obsidian' }), true)
    for (const bad of [{ names: ['white_wool'] }, { names: ['obsidian', 'diamond'] }, { names: [] }, {}, null]) {
      assert.equal(obsidian.isObsidianFamily(bad), false, JSON.stringify(bad))
    }
    assert.equal(obsidian.isObsidianName('obsidian'), true)
    assert.equal(obsidian.isObsidianName('iron_ore'), false)
    assert.equal(obsidian.OBSIDIAN_TOOL, 'diamond_pickaxe')
  })

  it('obsidian is bringable, needs a pickaxe, and drops itself', () => {
    assert.equal(bring.isBringable('obsidian'), true)
    assert.equal(bring.isBringable('dirt'), false)
    assert.equal(needsPickaxe('obsidian'), true)
    assert.equal(requiredTier('obsidian'), 'diamond')
    assert.equal(dropFor('obsidian'), 'obsidian')
  })

  it('diamond gate: diamond+ passes, iron and bare hands refuse', () => {
    assert.equal(hasPickaxe(mockBot({ items: [{ name: 'diamond_pickaxe', count: 1 }] }), 'obsidian'), true)
    assert.equal(hasPickaxe(mockBot({ items: [{ name: 'iron_pickaxe', count: 1 }] }), 'obsidian'), false)
    assert.equal(hasPickaxe(mockBot({}), 'obsidian'), false)
    assert.equal(
      bring.tierRefusal(mockBot({ items: [{ name: 'iron_pickaxe', count: 1 }] }), 'obsidian'),
      'need a diamond pickaxe for obsidian (my iron_pickaxe can\'t break it)',
    )
    assert.equal(bring.tierRefusal(mockBot({}), 'obsidian'), 'need a diamond pickaxe for obsidian')
  })

  it("resolveItem sees 'obsidian' as the single-name family", () => {
    const bot = mockBot({})
    assert.deepEqual(bring.resolveItem(bot, 'obsidian'), { names: ['obsidian'], family: 'obsidian' })
    assert.equal(obsidian.isObsidianFamily(bring.resolveItem(bot, 'obsidian')), true)
  })

  it('the item rung still refuses obsidian with the untouched stub line (6ci5.2 seam)', () => {
    const bot = mockBot({})
    tickerFor(bot)
    const ctx = bot._tickerCtx
    const o = { kind: 'item', name: 'obsidian', names: ['obsidian'], want: 3, phase: 'find', have: 0 }
    ctx.bring = o
    bring.refuseItemOrHunt(bot, ctx, o)
    assert.equal(ctx.bring, null)
    assert.deepEqual(bot.lines, ["can't get obsidian: no recipe, no source"])
  })
})

describe('obsidian dig consent (bringDeny)', () => {
  const blk = () => ({ name: 'obsidian', position: pos(2, 64, 0) })

  it('consents to a clean obsidian block for an obsidian order', () => {
    const bot = mockBot({ names: { '2,64,0': 'obsidian' } })
    assert.equal(bring.bringDeny(bot, blk(bot), {}, 'obsidian'), null)
  })

  it('withholds consent from a lit portal frame block', () => {
    const bot = mockBot({ names: { '2,64,0': 'obsidian', '3,64,0': 'nether_portal' } })
    assert.equal(bring.bringDeny(bot, blk(bot), {}, 'obsidian'), 'protected')
  })

  it('a diagonal portal touch is not a frame (corners hold nothing)', () => {
    const bot = mockBot({ names: { '2,64,0': 'obsidian', '3,65,0': 'nether_portal' } })
    assert.equal(bring.bringDeny(bot, blk(bot), {}, 'obsidian'), null)
  })

  it('lava on any face reads submerged (the crust case)', () => {
    const bot = mockBot({ names: { '2,64,0': 'obsidian', '2,63,0': 'lava' } })
    assert.equal(bring.bringDeny(bot, blk(bot), {}, 'obsidian'), 'submerged')
  })

  it('other orders and blocks read the guard unchanged', () => {
    const bot = mockBot({ names: { '2,64,0': 'obsidian' } })
    assert.equal(bring.bringDeny(bot, blk(bot), {}, 'coal'), 'protected')
    assert.equal(bring.bringDeny(bot, { name: 'coal_ore', position: pos(2, 64, 0) }, {}, 'obsidian'), null)
  })

  it('a walk-phase portal frame skips back to find without digging', async () => {
    const bot = mockBot({
      names: { '2,64,0': 'obsidian', '3,64,0': 'nether_portal' },
      items: [{ name: 'diamond_pickaxe', count: 1 }],
      playerPos: pos(30, 64, 0),
    })
    tickerFor(bot)
    const c = bot._tickerCtx
    bot.entity.position = pos(3, 64, 0)
    c.bring = {
      kind: 'block', name: 'obsidian', want: 1, by: 'P', block: 'obsidian', drop: 'obsidian',
      pos: pos(2, 64, 0), phase: 'walk', stalls: 0, lastPos: null, have: 0, announced: true, exposed: true,
    }
    await bring(bot, c, null, {})
    await bring(bot, c, null, {})
    assert.equal(bot.digCalls, 0)
    assert.equal(c.bring.phase, 'find')
    assert.ok(c.bring.skip && c.bring.skip.has('2,64,0'), 'frame cell skipped')
  })

  it('a lava-capped crust skips back to find without digging', async () => {
    const bot = mockBot({
      names: { '2,64,0': 'obsidian', '2,63,0': 'lava' },
      items: [{ name: 'diamond_pickaxe', count: 1 }],
      playerPos: pos(30, 64, 0),
    })
    tickerFor(bot)
    const c = bot._tickerCtx
    bot.entity.position = pos(3, 64, 0)
    c.bring = {
      kind: 'block', name: 'obsidian', want: 1, by: 'P', block: 'obsidian', drop: 'obsidian',
      pos: pos(2, 64, 0), phase: 'walk', stalls: 0, lastPos: null, have: 0, announced: true, exposed: true,
    }
    await bring(bot, c, null, {})
    await bring(bot, c, null, {})
    assert.equal(bot.digCalls, 0)
    assert.equal(c.bring.phase, 'find')
    assert.equal(c.bring.sawSubmerged, true)
  })
})

describe('bring me obsidian rig (pre-placed obsidian + diamond pick)', () => {
  it('mines 3, returns, tosses at the player', async () => {
    const names = { '2,64,0': 'obsidian', '6,64,0': 'obsidian', '9,64,0': 'obsidian' }
    const spots = [pos(2, 64, 0), pos(6, 64, 0), pos(9, 64, 0)]
    const bot = mockBot({ spots, names, items: [{ name: 'diamond_pickaxe', count: 1 }], playerPos: pos(30, 64, 0) })
    bot._moving = true
    const ticker = tickerFor(bot)
    handleChat(bot, ticker, 'P', 'bring me obsidian')
    const ctx = bot._tickerCtx
    assert.match(bot.lines[0], /^going for 3 obsidian, \d+ blocks away$/)
    assert.equal(ctx.bring.kind, 'block')
    for (let i = 0; i < 80 && ctx.bring; i++) {
      bring(bot, ctx, null, {})
      await flush()
      const o = ctx.bring
      if (!o) break
      const gk = ctx.lastGoalKey
      if (gk.startsWith('bring:') && o.pos) {
        bot.entity.position = pos(o.pos.x + 1, o.pos.y, o.pos.z) // arrived
        bot._moving = false
      } else if (gk.startsWith('bring-pickup')) {
        bot._moving = false
      } else if (gk.startsWith('bring-return')) {
        const pp = bot.players.P.entity.position
        bot.entity.position = pos(pp.x + 1, pp.y, pp.z) // at the player
        bot._moving = false
      }
    }
    assert.equal(ctx.bring, null)
    assert.equal(bot.digCalls, 3)
    assert.deepEqual(bot.tossCalls, [[ITEMS.obsidian, null, 3]])
    assert.ok(bot.lines.includes('here are 3 obsidian'), `chats: ${bot.lines.join(' | ')}`)
  })

  it('iron pick: honest diamond tier refusal, no order', () => {
    const bot = mockBot({
      spots: [pos(2, 64, 0)],
      names: { '2,64,0': 'obsidian' },
      items: [{ name: 'iron_pickaxe', count: 1 }],
      playerPos: pos(30, 64, 0),
    })
    const ticker = tickerFor(bot)
    handleChat(bot, ticker, 'P', 'bring me obsidian')
    assert.deepEqual(bot.lines, ['need a diamond pickaxe for obsidian (my iron_pickaxe can\'t break it)'])
    assert.ok(!bot._tickerCtx.bring, 'no order created')
  })

  it('no pick: bare diamond tier refusal, no order', () => {
    const bot = mockBot({
      spots: [pos(2, 64, 0)],
      names: { '2,64,0': 'obsidian' },
      items: [],
      playerPos: pos(30, 64, 0),
    })
    const ticker = tickerFor(bot)
    handleChat(bot, ticker, 'P', 'bring me obsidian')
    assert.deepEqual(bot.lines, ['need a diamond pickaxe for obsidian'])
    assert.ok(!bot._tickerCtx.bring, 'no order created')
  })
})
