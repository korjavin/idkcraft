'use strict'

// 'bring me bed' (idkcraft-did.4): a craft rung whose ingredient gap rides
// the ladder opens a sub-order — wool hunts sheep (one colour), planks dig
// logs — then resumes the craft and tosses the bed. The mock world carries
// real bed recipe shapes, sheep with metadata bytes, and a trunk-and-crown
// tree the dig guard accepts.

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const bring = require('../src/behaviours/bring')
const bed = require('../src/behaviours/bed')
const { handleChat, createTicker } = require('../src/index')

function pos(x, y, z) {
  const p = {
    x, y, z,
    distanceTo: (q) => Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z),
    clone() { return pos(p.x, p.y, p.z) },
    offset(ox, oy, oz) { return pos(p.x + ox, p.y + oy, p.z + oz) },
  }
  return p
}

const ITEMS = {
  white_wool: 106, black_wool: 107, gray_wool: 108,
  white_bed: 109, black_bed: 110, gray_bed: 111,
  oak_log: 118, oak_planks: 119, crafting_table: 120, stick: 115,
  cobblestone: 113, stone_axe: 101, dirt: 112, birch_planks: 125,
  white_dye: 126,
}
const BLOCKS = { oak_log: 12, oak_leaves: 13, crafting_table: 120, chest: 130 }

function R(product, takes, resCount, reqTable) {
  const delta = takes.map(([n, c]) => ({ id: ITEMS[n], count: -c }))
  delta.push({ id: ITEMS[product], count: resCount })
  return { delta, result: { count: resCount }, requiresTable: !!reqTable, product }
}

function RECIPES() {
  return {
    // Prod beds carry dyeing variants (bed + dye, 2 units) ahead of the
    // fresh recipe: the planner's fewest-units refusal prefers them, so
    // the bed gap must come from the fresh recipe directly (did.4 rig).
    white_bed: [
      R('white_bed', [['black_bed', 1], ['white_dye', 1]], 1, false),
      R('white_bed', [['white_wool', 3], ['oak_planks', 3]], 1, true),
    ],
    black_bed: [R('black_bed', [['black_wool', 3], ['oak_planks', 3]], 1, true)],
    gray_bed: [R('gray_bed', [['gray_wool', 3], ['oak_planks', 3]], 1, true)],
    oak_planks: [R('oak_planks', [['oak_log', 1]], 4, false)],
    stick: [R('stick', [['oak_planks', 2]], 4, false)],
    crafting_table: [R('crafting_table', [['oak_planks', 4]], 1, false)],
  }
}

const SHEEP_KEYS = [
  'shared_flags', 'air_supply', 'custom_name', 'custom_name_visible', 'silent',
  'no_gravity', 'pose', 'ticks_frozen', 'living_entity_flags', 'health',
  'effect_particles', 'effect_ambience', 'arrow_count', 'stinger_count',
  'sleeping_pos', 'mob_flags', 'baby', 'age_locked', 'wool',
]

function sheep(id, x, woolByte = null, y = 64, z = 0) {
  const e = { id, name: 'sheep', type: 'mob', position: pos(x, y, z), height: 1.3, isValid: true }
  if (woolByte !== null) {
    e.metadata = []
    e.metadata[SHEEP_KEYS.indexOf('wool')] = woolByte
  }
  return e
}

// A trunk the dig guard reads as a tree: woody column plus a leaf crown
// around the top (util.js isTreeLog/crownNear).
function treeCells(x, y, z) {
  const cells = {}
  cells[`${x},${y},${z}`] = 'oak_log'
  cells[`${x},${y + 1},${z}`] = 'oak_log'
  cells[`${x},${y + 2},${z}`] = 'oak_log'
  cells[`${x},${y + 3},${z}`] = 'oak_leaves'
  cells[`${x + 1},${y + 2},${z}`] = 'oak_leaves'
  cells[`${x - 1},${y + 2},${z}`] = 'oak_leaves'
  return cells
}

function mockBot({ items = [], chest = [], playerPos = null, animals = [], cells = {}, recipes = null } = {}) {
  const lines = []
  const tossCalls = []
  const attackCalls = []
  const calls = { setGoal: 0, goals: [], opens: 0, craft: [], dig: 0 }
  const blocksByName = {}
  for (const [name, id] of Object.entries(BLOCKS)) blocksByName[name] = { id }
  const itemsByName = {}
  for (const [name, id] of Object.entries(ITEMS)) itemsByName[name] = { id }
  const byId = {}
  for (const [name, id] of Object.entries(ITEMS)) byId[id] = name
  const entities = {}
  for (const a of animals) entities[a.id] = a
  const table = recipes === null ? RECIPES() : recipes
  const bot = {
    lines, tossCalls, attackCalls, calls, chest, cells,
    username: 'IdkBot',
    entities,
    health: 20,
    food: 20,
    entity: { position: pos(0, 64, 0), onGround: true },
    registry: { blocksByName, itemsByName, entitiesByName: { sheep: { metadataKeys: SHEEP_KEYS } } },
    players: { P: { username: 'P', entity: playerPos ? { position: playerPos } : null } },
    _moving: false,
    _items: items,
    pathfinder: {
      goal: null,
      setGoal: (goal) => { calls.setGoal++; calls.goals.push(goal); bot.pathfinder.goal = goal },
      stop: () => {},
      isMoving: () => bot._moving,
      bestHarvestTool: () => null, // logs break by hand
    },
    lookAt() {},
    attack(e) { attackCalls.push(e && e.id) },
    equip: async () => {},
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
    findBlocks(opts) {
      const want = new Set(Array.isArray(opts.matching) ? opts.matching : [opts.matching])
      const out = []
      for (const [key, n] of Object.entries(cells)) {
        const id = n && blocksByName[n] ? blocksByName[n].id : undefined
        if (!want.has(id)) continue
        const [x, y, z] = key.split(',').map(Number)
        out.push(pos(x, y, z))
      }
      return out
    },
    blockAt(p) {
      if (!p || typeof p.x !== 'number') return null
      const n = cells[`${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`]
      return n ? { name: n, position: pos(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)) } : null
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
    canDigBlock: () => true,
    dig: async (block) => {
      calls.dig++
      const bp = block && block.position
      if (bp) delete cells[`${Math.floor(bp.x)},${Math.floor(bp.y)},${Math.floor(bp.z)}`]
      if (block && block.name) bot._items.push({ name: bring.dropFor(block.name), count: 1 })
    },
    placeBlock: async (ref) => {
      const at = `${ref.position.x},${ref.position.y + 1},${ref.position.z}`
      cells[at] = 'crafting_table'
      const held = bot._items.find((i) => i.name === 'crafting_table')
      if (held) {
        held.count -= 1
        bot._items = bot._items.filter((s) => s.count > 0)
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

const flush = () => new Promise((r) => { setImmediate(() => setImmediate(r)) })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// Drive a bed order end to end: chest, hunt, dig, craft settle windows,
// explore legs, return.
async function drive(bot, ctx, onKill, maxTicks = 200) {
  for (let i = 0; i < maxTicks && ctx.bring; i++) {
    await bring(bot, ctx, null, {})
    const o = ctx.bring
    if (!o) break
    if (ctx.gearInFlight || o.chestInFlight || o.tossInFlight) {
      await sleep(650)
      continue
    }
    await flush()
    if (o.phase === 'chestfetch') { bot._moving = false; bot.entity.position = pos(5, 64, 1); continue }
    if (o.phase === 'craft') { bot._moving = false; bot.entity.position = pos(0, 64, 0); continue }
    if (o.phase === 'kill' && onKill && o.animal) onKill(bot, o)
    const gk = ctx.lastGoalKey || ''
    if (gk.startsWith('explore:') && ctx.explore && ctx.explore.target) {
      const t = ctx.explore.target
      bot.entity.position = pos(t.x, 64, t.z)
      bot._moving = false
    } else if (gk.startsWith('bring-hunt:') && o.pos) {
      bot.entity.position = pos(o.pos.x + 1, o.pos.y, o.pos.z)
      bot._moving = false
    } else if (gk.startsWith('bring-food-pickup:')) {
      bot._moving = false
      bot.entity.position = pos(o.dropPos.x, o.dropPos.y, o.dropPos.z)
    } else if (gk.startsWith('bring-pickup')) {
      bot._moving = false
    } else if (gk.startsWith('bring:') && o.pos) {
      bot.entity.position = pos(o.pos.x + 1, o.pos.y, o.pos.z)
      bot._moving = false
    } else if (gk.startsWith('bring-return:')) {
      bot._moving = false
      const pp = bot.players.P.entity.position
      bot.entity.position = pos(pp.x, pp.y, pp.z)
    }
  }
}

function killWhite(bot, o) {
  const ent = bot.entities[o.animal.id]
  if (ent && ent.isValid !== false) {
    ent.isValid = false
    bot._items.push({ name: 'white_wool', count: 1 })
  }
}

function tableHome(ctx, x, y, z) {
  ctx.home = { site: { x: 0, y: 64, z: 0 }, built: true, table: { x, y, z } }
}

function chestTableHome(ctx) {
  ctx.home = {
    site: { x: 0, y: 64, z: 0 }, built: true,
    chest: { x: 5, y: 64, z: 1 }, table: { x: 0, y: 64, z: 0 },
  }
}

describe('bed math (idkcraft-did.4, shared with jr2.2)', () => {
  it('picks the max-count wool colour, first-max on ties', () => {
    assert.equal(bed.pickBedColor({ white_wool: 2, black_wool: 3 }), 'black')
    assert.equal(bed.pickBedColor({ gray_wool: 1, white_wool: 1 }), 'gray')
    assert.equal(bed.pickBedColor({ dirt: 9 }), null)
    assert.equal(bed.pickBedColor({}), null)
    assert.equal(bed.pickBedColor(null), null)
  })

  it('reports the wool/planks shortfall for n beds of one colour', () => {
    assert.deepEqual(bed.bedShortfall({ white_wool: 2, oak_planks: 4 }, 'white'), { wool: 1, planks: 0 })
    assert.deepEqual(bed.bedShortfall({ white_wool: 2, oak_planks: 4 }, 'white', 2), { wool: 4, planks: 2 })
    assert.deepEqual(bed.bedShortfall({ white_wool: 9, birch_planks: 6 }, 'white', 2), { wool: 0, planks: 0 })
    assert.deepEqual(bed.bedShortfall({}, null), { wool: 3, planks: 3 })
  })

  it('names the craft target and the packed bed', () => {
    assert.equal(bed.bedTarget('white'), 'white_bed')
    assert.equal(bed.bedTarget('not-a-colour'), null)
    assert.equal(bed.bedInPack({ white_bed: 1, black_bed: 2 }), 'black_bed')
    assert.equal(bed.bedInPack({ dirt: 1 }), null)
    assert.equal(bed.bedColor('white_bed'), 'white')
    assert.equal(bed.bedColor('bed'), null)
    assert.equal(bed.isBedFamily({ names: ['white_bed'] }), true)
    assert.equal(bed.isBedFamily({ names: ['white_bed', 'dirt'] }), false)
  })

  it('packCounts reads the live inventory, empty on failure', () => {
    const bot = { inventory: { items: () => [{ name: 'white_wool', count: 2 }, { name: 'white_wool', count: 1 }] } }
    assert.deepEqual(bed.packCounts(bot), { white_wool: 3 })
    const broken = { inventory: { items: () => { throw new Error('flicker') } } }
    assert.deepEqual(bed.packCounts(broken), {})
  })
})

describe('sub-order open (idkcraft-did.4)', () => {
  it('a planks gap digs the same wood, one log per four planks', () => {
    const bot = mockBot({ items: [{ name: 'white_wool', count: 3 }] })
    const o = { kind: 'item', name: 'bed', names: ['black_bed', 'white_bed'], want: 3 }
    const line = bring.openSubOrder(bot, o, { name: 'oak_planks', need: 3, have: 0 }, 'white_bed', 'white')
    assert.equal(line, 'making you a white_bed: need 3 planks, going for logs')
    assert.equal(o.kind, 'block')
    assert.equal(o.name, 'oak_log')
    assert.equal(o.want, 1)
    assert.equal(o.subFor, 'white_bed')
    assert.deepEqual(o.parent, { kind: 'item', name: 'bed', names: ['black_bed', 'white_bed'], want: 3 })
  })

  it('a second sub drops the making-you-a prefix', () => {
    const bot = mockBot({ items: [{ name: 'white_wool', count: 3 }, { name: 'oak_log', count: 1 }] })
    const o = { kind: 'item', name: 'bed', names: ['white_bed'], want: 3, subCount: 1 }
    const line = bring.openSubOrder(bot, o, { name: 'oak_planks', need: 3, have: 0 }, 'white_bed', 'white')
    assert.equal(line, 'need 3 planks, going for logs')
  })

  it('a nested open refuses instead of looping', () => {
    const bot = mockBot({})
    const o = { kind: 'wool', name: 'white_wool', want: 3, subFor: 'white_bed' }
    assert.equal(bring.openSubOrder(bot, o, { name: 'oak_planks', need: 3, have: 0 }, 'white_bed', 'white'), null)
    assert.equal(bring.openSubOrder(bot, { kind: 'item' }, { name: 'cobblestone', need: 3, have: 0 }, 'x', null), null)
  })

  it('gap precedence is wool, planks, logs, sticks; smelting names the ingot', () => {
    const miss = [{ name: 'stick', need: 2, have: 0 }, { name: 'oak_planks', need: 3, have: 0 }]
    assert.equal(bring.pickSubGap(miss).name, 'oak_planks')
    assert.equal(bring.pickSubGap([{ name: 'cobblestone', need: 3, have: 0 }]), null)
    assert.equal(bring.smeltingGap([{ name: 'iron_ingot', need: 3, have: 0 }]), 'iron_ingot')
    assert.equal(bring.smeltingGap([{ name: 'oak_planks', need: 3, have: 0 }]), null)
    assert.equal(bring.subWordFor('white_wool'), 'wool')
    assert.equal(bring.subWordFor('stick'), 'sticks')
  })
})

describe("'bring me bed' (idkcraft-did.4)", () => {
  it('mats plus a table craft and toss at once', async () => {
    const bot = mockBot({
      items: [{ name: 'white_wool', count: 3 }, { name: 'oak_planks', count: 4 }],
      playerPos: pos(30, 64, 0),
      cells: { '0,64,0': 'crafting_table' },
    })
    const ticker = tickerFor(bot)
    tableHome(bot._tickerCtx, 0, 64, 0)
    handleChat(bot, ticker, 'P', 'bring me bed')
    assert.deepEqual(bot.lines, ['making you a white_bed'])
    await drive(bot, bot._tickerCtx, null)
    assert.ok(!bot._tickerCtx.bring, 'order completed')
    assert.deepEqual(bot.tossCalls, [[ITEMS.white_bed, null, 1]])
    assert.ok(bot.lines.includes('here is 1 white_bed'), `lines: ${bot.lines}`)
  })

  it('no wool with sheep nearby hunts three, then crafts and tosses', async () => {
    const bot = mockBot({
      items: [{ name: 'oak_planks', count: 4 }],
      playerPos: pos(30, 64, 0),
      animals: [sheep(11, 10, 0x00), sheep(12, 14, 0x00), sheep(13, 16, 0x00)],
      cells: { '0,64,0': 'crafting_table' },
    })
    bot._moving = true
    const ticker = tickerFor(bot)
    tableHome(bot._tickerCtx, 0, 64, 0)
    handleChat(bot, ticker, 'P', 'bring me bed')
    assert.deepEqual(bot.lines, ['making you a bed: need 3 wool, going for sheep'])
    assert.equal(bot._tickerCtx.bring.kind, 'wool')
    assert.equal(bot._tickerCtx.bring.color, null)
    await drive(bot, bot._tickerCtx, killWhite)
    assert.ok(!bot._tickerCtx.bring, 'order completed')
    assert.deepEqual(bot.tossCalls, [[ITEMS.white_bed, null, 1]])
    assert.ok(bot.lines.includes('here is 1 white_bed'), `lines: ${bot.lines}`)
    assert.ok(bot.lines.includes('making you a white_bed'), `lines: ${bot.lines}`)
  })

  it('two white plus one black tops up white, never crafts mixed', async () => {
    const bot = mockBot({
      items: [
        { name: 'white_wool', count: 2 }, { name: 'black_wool', count: 1 },
        { name: 'oak_planks', count: 4 },
      ],
      playerPos: pos(30, 64, 0),
      animals: [sheep(11, 10, 0x00), sheep(12, 14, 0x0f)],
      cells: { '0,64,0': 'crafting_table' },
    })
    bot._moving = true
    const ticker = tickerFor(bot)
    tableHome(bot._tickerCtx, 0, 64, 0)
    handleChat(bot, ticker, 'P', 'bring me bed')
    assert.deepEqual(bot.lines, ['making you a white_bed: need 3 wool, going for sheep'])
    assert.equal(bot._tickerCtx.bring.color, 'white')
    await drive(bot, bot._tickerCtx, killWhite)
    assert.ok(!bot._tickerCtx.bring, 'order completed')
    assert.deepEqual(bot.tossCalls, [[ITEMS.white_bed, null, 1]])
    assert.ok(bot.attackCalls.every((id) => id === 11), `swings: ${bot.attackCalls}`)
    assert.equal(bot.entities[12].isValid, true)
  })

  it('nothing but sheep and trees: wool sub, log sub, craft, toss', async () => {
    const bot = mockBot({
      items: [],
      playerPos: pos(30, 64, 0),
      animals: [sheep(11, -10, 0x00), sheep(12, -14, 0x00), sheep(13, -16, 0x00)],
      cells: { '0,64,0': 'crafting_table', ...treeCells(20, 64, 0) },
    })
    bot._moving = true
    const ticker = tickerFor(bot)
    tableHome(bot._tickerCtx, 0, 64, 0)
    handleChat(bot, ticker, 'P', 'bring me bed')
    assert.deepEqual(bot.lines, ['making you a bed: need 3 wool, going for sheep'])
    await drive(bot, bot._tickerCtx, killWhite)
    assert.ok(!bot._tickerCtx.bring, 'order completed')
    assert.ok(bot.lines.includes('need 3 planks, going for logs'), `lines: ${bot.lines}`)
    assert.ok(bot.lines.includes('making you a white_bed'), `lines: ${bot.lines}`)
    assert.deepEqual(bot.calls.craft, ['oak_planks', 'white_bed'])
    assert.deepEqual(bot.tossCalls, [[ITEMS.white_bed, null, 1]])
    assert.ok(bot.lines.includes('here is 1 white_bed'), `lines: ${bot.lines}`)
  })

  it('chest wool picks the max colour: gray wins over pack white', async () => {
    const bot = mockBot({
      items: [{ name: 'white_wool', count: 1 }, { name: 'oak_planks', count: 4 }],
      chest: [{ name: 'gray_wool', count: 2 }],
      playerPos: pos(30, 64, 0),
      animals: [sheep(11, 10, 0x07), sheep(12, 14, 0x07)],
      cells: { '0,64,0': 'crafting_table', '5,64,1': 'chest' },
    })
    bot._moving = true
    const ticker = tickerFor(bot)
    chestTableHome(bot._tickerCtx)
    handleChat(bot, ticker, 'P', 'bring me bed')
    assert.deepEqual(bot.lines, ['checking the home chest for bed'])
    await drive(bot, bot._tickerCtx, (b, o) => {
      const ent = b.entities[o.animal.id]
      if (ent && ent.isValid !== false) {
        ent.isValid = false
        b._items.push({ name: 'gray_wool', count: 1 })
      }
    })
    assert.ok(!bot._tickerCtx.bring, 'order completed')
    assert.ok(bot.lines.some((l) => l === 'making you a gray_bed: need 3 wool, going for sheep'), `lines: ${bot.lines}`)
    assert.deepEqual(bot.tossCalls, [[ITEMS.gray_bed, null, 1]])
    assert.ok(bot.lines.includes('here is 1 gray_bed'), `lines: ${bot.lines}`)
  })

  it('no sheep and no anchor refuses with the reason', async () => {
    const bot = mockBot({
      items: [{ name: 'oak_planks', count: 4 }],
      playerPos: pos(30, 64, 0),
      cells: { '0,64,0': 'crafting_table' },
    })
    handleChat(bot, tickerFor(bot), 'P', 'bring me bed')
    assert.deepEqual(bot.lines, ['making you a bed: need 3 wool, going for sheep'])
    await drive(bot, bot._tickerCtx, null)
    assert.equal(bot._tickerCtx.bring, null)
    assert.ok(bot.lines.includes('could not get 3 wool for the bed in time'), `lines: ${bot.lines}`)
    assert.deepEqual(bot.tossCalls, [])
  })

  it('no sheep with an anchor walks the legs, then refuses the bed', async () => {
    const bot = mockBot({
      items: [{ name: 'oak_planks', count: 4 }],
      playerPos: pos(30, 64, 0),
      cells: { '0,64,0': 'crafting_table' },
    })
    const ticker = tickerFor(bot)
    tableHome(bot._tickerCtx, 0, 64, 0)
    handleChat(bot, ticker, 'P', 'bring me bed')
    await drive(bot, bot._tickerCtx, null, 600)
    assert.equal(bot._tickerCtx.bring, null)
    assert.ok(bot.lines.includes('no sheep nearby, searching…'), `lines: ${bot.lines}`)
    assert.ok(bot.lines.includes('could not get 3 wool for the bed in time'), `lines: ${bot.lines}`)
    assert.deepEqual(bot.tossCalls, [])
  })

  it('an exhausted budget refuses clean: nothing hangs', async () => {
    const bot = mockBot({
      items: [{ name: 'oak_planks', count: 4 }],
      playerPos: pos(30, 64, 0),
      cells: { '0,64,0': 'crafting_table' },
    })
    const ticker = tickerFor(bot)
    const ctx = bot._tickerCtx
    tableHome(ctx, 0, 64, 0)
    handleChat(bot, ticker, 'P', 'bring me bed')
    ctx.bring.searchLegs = { legs: 7, startedAt: Date.now() - 6 * 60 * 1000, announced: true, last: 'empty' }
    await drive(bot, ctx, null)
    assert.equal(ctx.bring, null)
    assert.equal(ctx.craftany, null)
    assert.ok(bot.lines.includes('could not get 3 wool for the bed in time'), `lines: ${bot.lines}`)
    assert.deepEqual(bot.tossCalls, [])
  })

  it('stop mid-sub-order clears the whole stack (mutation)', async () => {
    const bot = mockBot({
      items: [{ name: 'oak_planks', count: 4 }],
      playerPos: pos(30, 64, 0),
      animals: [sheep(11, 10, 0x00)],
      cells: { '0,64,0': 'crafting_table' },
    })
    bot._moving = true
    const ticker = tickerFor(bot)
    tableHome(bot._tickerCtx, 0, 64, 0)
    handleChat(bot, ticker, 'P', 'bring me bed')
    const ctx = bot._tickerCtx
    assert.ok(ctx.bring && ctx.bring.subFor, 'sub-order open')
    await bring(bot, ctx, null, {})
    await flush()
    const frozen = bot.lines.length
    ticker.stop()
    assert.equal(ctx.bring, null)
    await drive(bot, ctx, killWhite)
    assert.equal(bot.lines.length, frozen, 'no further chat after stop')
    assert.deepEqual(bot.tossCalls, [])
  })

  it('a bare order locks the first pickup: gray first, whites stand', async () => {
    const bot = mockBot({
      items: [{ name: 'oak_planks', count: 4 }],
      playerPos: pos(30, 64, 0),
      animals: [sheep(11, 8, 0x07), sheep(12, 9, 0x00), sheep(13, 10, 0x00), sheep(14, 20, 0x07), sheep(15, 22, 0x07)],
      cells: { '0,64,0': 'crafting_table' },
    })
    bot._moving = true
    const ticker = tickerFor(bot)
    tableHome(bot._tickerCtx, 0, 64, 0)
    handleChat(bot, ticker, 'P', 'bring me bed')
    await drive(bot, bot._tickerCtx, (b, o) => {
      const ent = b.entities[o.animal.id]
      if (ent && ent.isValid !== false) {
        ent.isValid = false
        const byte = ent.metadata ? ent.metadata[ent.metadata.length - 1] : 0
        const color = ['white', 'orange', 'magenta', 'light_blue', 'yellow', 'lime', 'pink', 'gray'][byte & 0x0f]
        b._items.push({ name: `${color}_wool`, count: 1 })
      }
    })
    assert.ok(!bot._tickerCtx.bring, 'order completed')
    assert.deepEqual(bot.tossCalls, [[ITEMS.gray_bed, null, 1]])
    assert.ok(bot.attackCalls.every((id) => id === 11 || id === 14 || id === 15), `swings: ${bot.attackCalls}`)
    assert.equal(bot.entities[12].isValid, true)
    assert.equal(bot.entities[13].isValid, true)
  })

  it('four oak fund the table or the bed: a log sub opens, nothing promised blind', async () => {
    // The planner must not promise a table it cannot afford (did.4 rig:
    // 4 oak promised a spruce table, then failed loud). Two table
    // variants, only oak affordable: the oak funds the table, the bed
    // goes short, and the plank gap opens a log sub-order.
    const recipes = {
      ...RECIPES(),
      crafting_table: [
        R('crafting_table', [['oak_planks', 4]], 1, false),
        R('crafting_table', [['birch_planks', 4]], 1, false),
      ],
    }
    const bot = mockBot({
      items: [{ name: 'white_wool', count: 3 }, { name: 'oak_planks', count: 4 }],
      playerPos: pos(30, 64, 0),
      recipes,
    })
    handleChat(bot, tickerFor(bot), 'P', 'bring me bed')
    assert.deepEqual(bot.lines, ['making you a white_bed: need 3 planks, going for logs'])
    assert.deepEqual(bot.calls.craft, [], 'no craft promised on an unfunded table')
    await drive(bot, bot._tickerCtx, null) // the mock world holds no logs: one honest line
    assert.equal(bot._tickerCtx.bring, null)
    assert.ok(bot.lines.includes('could not get 3 planks for the white_bed in time'), `lines: ${bot.lines}`)
  })

  it('a dyeing refusal never hides the fresh gap: wool covered, logs fetched', async () => {
    const bot = mockBot({
      items: [{ name: 'white_wool', count: 3 }],
      playerPos: pos(30, 64, 0),
    })
    handleChat(bot, tickerFor(bot), 'P', 'bring me bed')
    assert.deepEqual(bot.lines, ['making you a white_bed: need 3 planks, going for logs'])
    assert.equal(bot._tickerCtx.bring.kind, 'block')
    assert.equal(bot._tickerCtx.bring.name, 'oak_log')
  })

  it('eight oak and no table: make a table, place it, craft the bed', async () => {
    const bot = mockBot({
      items: [{ name: 'white_wool', count: 3 }, { name: 'oak_planks', count: 8 }],
      playerPos: pos(30, 64, 0),
      cells: { '1,63,0': 'dirt' },
    })
    handleChat(bot, tickerFor(bot), 'P', 'bring me bed')
    assert.deepEqual(bot.lines, ['making you a white_bed'])
    await drive(bot, bot._tickerCtx, null)
    assert.ok(!bot._tickerCtx.bring, 'order completed')
    assert.deepEqual(bot.calls.craft, ['crafting_table', 'white_bed'])
    assert.deepEqual(bot.tossCalls, [[ITEMS.white_bed, null, 1]])
    assert.ok(bot.lines.includes('here is 1 white_bed'), `lines: ${bot.lines}`)
  })

  it("'bring me white_bed' locks white even with gray in the pack", async () => {
    const bot = mockBot({
      items: [{ name: 'gray_wool', count: 3 }, { name: 'oak_planks', count: 4 }],
      playerPos: pos(30, 64, 0),
      animals: [sheep(11, 10, 0x00), sheep(12, 14, 0x00), sheep(13, 16, 0x00)],
      cells: { '0,64,0': 'crafting_table' },
    })
    bot._moving = true
    const ticker = tickerFor(bot)
    tableHome(bot._tickerCtx, 0, 64, 0)
    handleChat(bot, ticker, 'P', 'bring me white_bed')
    assert.deepEqual(bot.lines, ['making you a white_bed: need 3 wool, going for sheep'])
    await drive(bot, bot._tickerCtx, killWhite)
    assert.ok(!bot._tickerCtx.bring, 'order completed')
    assert.deepEqual(bot.tossCalls, [[ITEMS.white_bed, null, 1]])
  })
})
