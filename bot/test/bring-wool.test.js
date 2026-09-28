'use strict'

// 'bring me wool' (idkcraft-did.3): the mob rung of the bring ladder.
// Wool the pack and chest could not fill comes from sheep: shear when
// shears are held, else kill — over the shared n7k prey phases.

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const bring = require('../src/behaviours/bring')
const wool = require('../src/behaviours/wool')
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

const ITEMS = { white_wool: 106, gray_wool: 107, shears: 105 }

// Faithful sheep metadataKeys (19 entries, wool last) for the color /
// sheared tests; the reader must resolve the index, not hardcode it.
const SHEEP_KEYS = [
  'shared_flags', 'air_supply', 'custom_name', 'custom_name_visible', 'silent',
  'no_gravity', 'pose', 'ticks_frozen', 'living_entity_flags', 'health',
  'effect_particles', 'effect_ambience', 'arrow_count', 'stinger_count',
  'sleeping_pos', 'mob_flags', 'baby', 'age_locked', 'wool',
]

function mockBot({ items = [], chest = [], playerPos = null, animals = [], blocks = {}, spots = [], names = {} } = {}) {
  const lines = []
  const tossCalls = []
  const attackCalls = []
  const useOnCalls = []
  const calls = { setGoal: 0, goals: [], opens: 0 }
  const blocksByName = {}
  for (const [name, id] of Object.entries(blocks)) blocksByName[name] = { id }
  const itemsByName = {}
  for (const [name, id] of Object.entries(ITEMS)) itemsByName[name] = { id }
  const entities = {}
  for (const a of animals) entities[a.id] = a
  const bot = {
    lines, tossCalls, attackCalls, useOnCalls, calls, chest,
    username: 'IdkBot',
    entities,
    health: 20,
    food: 20,
    entity: { position: pos(0, 64, 0), onGround: true },
    registry: { blocksByName, itemsByName, entitiesByName: { sheep: { metadataKeys: SHEEP_KEYS } } },
    players: { P: { username: 'P', entity: playerPos ? { position: playerPos } : null } },
    _moving: false,
    _items: items,
    held: null,
    pathfinder: {
      goal: null,
      setGoal: (goal) => { calls.setGoal++; calls.goals.push(goal); bot.pathfinder.goal = goal },
      stop: () => {},
      isMoving: () => bot._moving,
      bestHarvestTool: () => null,
    },
    lookAt() {},
    attack(e) { attackCalls.push(e && e.id) },
    useOn(e) { useOnCalls.push(e && e.id); bot._items.push({ name: 'white_wool', count: 2 }) }, // the mock server drops wool
    equip: async (item) => { bot.held = item && item.name },
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
      if (p && Math.floor(p.x) === 5 && Math.floor(p.y) === 64 && Math.floor(p.z) === 1) {
        return { name: 'chest', position: pos(5, 64, 1) }
      }
      if (!p || typeof p.x !== 'number') return null
      const n = names[`${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`]
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
    toss: async (id, meta, n) => { tossCalls.push([id, meta, n]) },
    chat(line) { lines.push(String(line)) },
  }
  return bot
}

function sheep(id, x, woolByte = null, y = 64, z = 0) {
  const e = { id, name: 'sheep', type: 'mob', position: pos(x, y, z), height: 1.3, isValid: true }
  if (woolByte !== null) {
    e.metadata = []
    e.metadata[SHEEP_KEYS.indexOf('wool')] = woolByte
  }
  return e
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

function anchor(ctx) {
  ctx.home = { site: { x: 0, y: 64, z: 0 } }
}

const flush = () => new Promise((r) => { setImmediate(() => setImmediate(r)) })

// Drive a wool order: chest leg, hunt/pickup/return, explore legs.
async function drive(bot, ctx, onKill, maxTicks = 120) {
  for (let i = 0; i < maxTicks && ctx.bring; i++) {
    await bring(bot, ctx, null, {})
    await flush()
    const o = ctx.bring
    if (!o) break
    if (o.phase === 'chestfetch') { bot._moving = false; bot.entity.position = pos(5, 64, 1); continue }
    // The scripted kill runs on the kill phase itself: walk flips to kill
    // without setting a goal when the body is already in range.
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
    } else if (gk.startsWith('bring-return:')) {
      bot._moving = false
      const pp = bot.players.P.entity.position
      bot.entity.position = pos(pp.x, pp.y, pp.z)
    }
  }
}

function killOnce(bot, o) {
  const ent = bot.entities[o.animal.id]
  if (ent && ent.isValid !== false) {
    ent.isValid = false
    bot._items.push({ name: 'white_wool', count: 1 })
  }
}

describe('wool helpers (idkcraft-did.3)', () => {
  it('parses wool requests, registry and spaced forms', () => {
    assert.deepEqual(wool.parseWoolRequest('wool'), { color: null, name: 'wool', drop: null })
    assert.deepEqual(wool.parseWoolRequest('white_wool'), { color: 'white', name: 'white_wool', drop: 'white_wool' })
    assert.deepEqual(wool.parseWoolRequest('white wool'), { color: 'white', name: 'white_wool', drop: 'white_wool' })
    assert.deepEqual(wool.parseWoolRequest('light blue wool'), { color: 'light_blue', name: 'light_blue_wool', drop: 'light_blue_wool' })
    for (const bad of ['bed', 'sheep', 'wools', 'whool', 'redstone', '', null]) {
      assert.equal(wool.parseWoolRequest(bad), null, String(bad))
    }
  })

  it('detects pure wool families', () => {
    assert.equal(wool.isWoolFamily({ names: ['gray_wool', 'white_wool'] }), true)
    assert.equal(wool.isWoolFamily({ names: ['white_wool'] }), true)
    assert.equal(wool.isWoolFamily({ names: ['white_bed'] }), false)
    assert.equal(wool.isWoolFamily({ names: ['white_wool', 'dirt'] }), false)
    assert.equal(wool.isWoolFamily({ names: [] }), false)
    assert.equal(wool.isWoolFamily(null), false)
  })

  it('reads the sheep wool byte through the registry index', () => {
    const bot = { registry: { entitiesByName: { sheep: { metadataKeys: ['x', 'wool'] } } } }
    assert.deepEqual(wool.sheepWool(bot, { metadata: [9, 0x07] }), { sheared: false, color: 'gray' })
    assert.deepEqual(wool.sheepWool(bot, { metadata: [9, 0x10] }), { sheared: true, color: 'white' })
    assert.deepEqual(wool.sheepWool(bot, { metadata: [9, 0x1e] }), { sheared: true, color: 'red' })
    assert.deepEqual(wool.sheepWool(bot, {}), { sheared: null, color: null })
    assert.deepEqual(wool.sheepWool({}, { metadata: [0x00] }), { sheared: null, color: null })
  })

  it('scans the pack for shears and wool', () => {
    const bot = { inventory: { items: () => [{ name: 'shears', count: 1 }, { name: 'gray_wool', count: 2 }] } }
    assert.equal(wool.hasShears(bot), true)
    assert.equal(wool.shearsInPack(bot).name, 'shears')
    assert.deepEqual(wool.findWoolInPack(bot, null), { name: 'gray_wool', count: 2 })
    assert.deepEqual(wool.findWoolInPack(bot, 'gray'), { name: 'gray_wool', count: 2 })
    assert.equal(wool.findWoolInPack(bot, 'white'), null)
    const bare = { inventory: { items: () => [{ name: 'dirt', count: 3 }] } }
    assert.equal(wool.hasShears(bare), false)
    assert.equal(wool.findWoolInPack(bare, null), null)
  })

  it('toWoolHunt locks single-color families and recounts partial stock', () => {
    const bot = { inventory: { items: () => [{ name: 'white_wool', count: 1 }, { name: 'gray_wool', count: 4 }] } }
    const single = bring.toWoolHunt(bot, { kind: 'item', name: 'white_wool', names: ['white_wool'], want: 3, drop: null, have: 0 })
    assert.equal(single.kind, 'wool')
    assert.equal(single.color, 'white')
    assert.equal(single.drop, 'white_wool')
    assert.equal(single.phase, 'find')
    const family = bring.toWoolHunt(bot, { kind: 'item', name: 'wool', names: ['gray_wool', 'white_wool'], want: 3, drop: null, have: 0 })
    assert.equal(family.color, null)
    assert.equal(family.drop, null)
    assert.equal(family.have, 0)
    const partial = bring.toWoolHunt(bot, { kind: 'item', name: 'wool', names: ['gray_wool', 'white_wool'], want: 3, drop: 'white_wool', have: 5 })
    assert.equal(partial.have, 1) // the white stack only: the toss truth, not the family sum
  })
})

describe("'bring me wool' (idkcraft-did.3)", () => {
  it('no shears: walks, kills, picks up, returns and tosses', async () => {
    const bot = mockBot({ playerPos: pos(30, 64, 0), animals: [sheep(11, 10), sheep(12, 14)] })
    bot._moving = true
    handleChat(bot, tickerFor(bot), 'P', 'bring me wool 2')
    assert.deepEqual(bot.lines, ['looking for sheep'])
    const seen = new Map()
    await drive(bot, bot._tickerCtx, (b, o) => {
      const n = (seen.get(o.animal.id) || 0) + 1
      seen.set(o.animal.id, n)
      if (n >= 3) killOnce(b, o)
    })
    assert.ok(bot.lines.some((l) => /^going for wool: sheep \d+ blocks away \(no shears, hunting\)$/.test(l)), `lines: ${bot.lines}`)
    assert.ok(bot.attackCalls.length >= 2, 'swung at sheep')
    assert.ok(bot.lines.some((l) => l === 'here are 2 white_wool'), `lines: ${bot.lines}`)
    assert.deepEqual(bot.tossCalls, [[ITEMS.white_wool, null, 2]])
  })

  it('shears in pack: shears instead of killing, the sheep lives', async () => {
    const bot = mockBot({ items: [{ name: 'shears', count: 1 }], playerPos: pos(30, 64, 0), animals: [sheep(11, 10)] })
    bot._moving = true
    handleChat(bot, tickerFor(bot), 'P', 'bring me wool 1')
    await drive(bot, bot._tickerCtx, null)
    assert.ok(bot.lines.some((l) => /^going for wool: sheep \d+ blocks away \(shears\)$/.test(l)), `lines: ${bot.lines}`)
    assert.deepEqual(bot.useOnCalls, [11])
    assert.equal(bot.attackCalls.length, 0)
    assert.equal(bot.entities[11].isValid, true)
    assert.equal(bot.held, 'shears')
    assert.ok(bot.lines.some((l) => l === 'here are 1 white_wool'), `lines: ${bot.lines}`)
  })

  it('a sheared sheep is skipped for the next one', async () => {
    const bot = mockBot({ playerPos: pos(30, 64, 0), animals: [sheep(11, 5, 0x10), sheep(12, 10, 0x00)] })
    handleChat(bot, tickerFor(bot), 'P', 'bring me wool 1')
    const ctx = bot._tickerCtx
    await bring(bot, ctx, null, {})
    await flush()
    assert.equal(ctx.bring.animal.id, 12)
    assert.equal(ctx.bring.phase, 'walk')
  })

  it("bring me white wool hunts white sheep, gray ones stand", async () => {
    const bot = mockBot({ playerPos: pos(30, 64, 0), animals: [sheep(11, 5, 0x07), sheep(12, 10, 0x00)] })
    bot._moving = true
    handleChat(bot, tickerFor(bot), 'P', 'bring me white wool 1')
    assert.deepEqual(bot.lines, ['looking for white sheep'])
    let swings = 0
    await drive(bot, bot._tickerCtx, (b, o) => { if (++swings >= 2) killOnce(b, o) })
    assert.ok(bot.attackCalls.length >= 1, 'swung at the white sheep')
    assert.ok(bot.attackCalls.every((id) => id === 12), `swings: ${bot.attackCalls}`)
    assert.equal(bot.entities[11].isValid, true)
    assert.ok(bot.lines.some((l) => l === 'here are 1 white_wool'), `lines: ${bot.lines}`)
    assert.deepEqual(bot.tossCalls, [[ITEMS.white_wool, null, 1]])
  })

  it('wool blocks nearby do not divert the hunt to digging', async () => {
    const names = { '10,64,0': 'white_wool' }
    const bot = mockBot({
      playerPos: pos(30, 64, 0), animals: [sheep(12, 20)],
      blocks: { white_wool: 31 }, spots: [pos(10, 64, 0)], names,
    })
    handleChat(bot, tickerFor(bot), 'P', 'bring me white_wool')
    assert.deepEqual(bot.lines, ['looking for white sheep'])
    assert.equal(bot._tickerCtx.bring.kind, 'wool')
  })

  it('wool in the pack gives without hunting', async () => {
    const bot = mockBot({ items: [{ name: 'white_wool', count: 2 }], playerPos: pos(30, 64, 0) })
    handleChat(bot, tickerFor(bot), 'P', 'bring me wool 2')
    assert.deepEqual(bot.lines, ['coming with 2 white_wool'])
    await drive(bot, bot._tickerCtx, null)
    assert.equal(bot.attackCalls.length, 0)
    assert.deepEqual(bot.tossCalls, [[ITEMS.white_wool, null, 2]])
  })

  it('an empty home chest falls through to the hunt', async () => {
    const bot = mockBot({ playerPos: pos(30, 64, 0), animals: [sheep(11, 10), sheep(12, 14), sheep(13, 16)] })
    bot._moving = true
    const ticker = tickerFor(bot)
    chestHome(bot._tickerCtx)
    handleChat(bot, ticker, 'P', 'bring me wool 3')
    assert.deepEqual(bot.lines, ['checking the home chest for wool'])
    await drive(bot, bot._tickerCtx, killOnce)
    assert.ok(bot.lines.some((l) => /^going for wool: sheep \d+ blocks away/.test(l)), `lines: ${bot.lines}`)
    assert.ok(bot.lines.some((l) => l === 'here are 3 white_wool'), `lines: ${bot.lines}`)
  })

  it('a short chest hunts the rest in the fetched color', async () => {
    const bot = mockBot({
      playerPos: pos(30, 64, 0), animals: [sheep(11, 10, 0x00), sheep(12, 14, 0x00)],
      chest: [{ name: 'white_wool', count: 1 }],
    })
    bot._moving = true
    const ticker = tickerFor(bot)
    chestHome(bot._tickerCtx)
    handleChat(bot, ticker, 'P', 'bring me wool 3')
    await drive(bot, bot._tickerCtx, killOnce)
    assert.ok(bot.lines.some((l) => l === 'here are 3 white_wool'), `lines: ${bot.lines}`)
    assert.deepEqual(bot.tossCalls, [[ITEMS.white_wool, null, 3]])
  })

  it('no sheep with an anchor walks the legs, then refuses honestly', async () => {
    const bot = mockBot({ playerPos: pos(30, 64, 0) })
    const ticker = tickerFor(bot)
    anchor(bot._tickerCtx)
    handleChat(bot, ticker, 'P', 'bring me wool')
    await drive(bot, bot._tickerCtx, null, 600)
    assert.equal(bot._tickerCtx.bring, null)
    assert.ok(bot.lines.some((l) => l === 'no sheep nearby, searching…'), `lines: ${bot.lines}`)
    assert.ok(bot.lines.some((l) => l === 'searched 24 areas, no sheep'), `lines: ${bot.lines}`)
    assert.equal(bot.attackCalls.length, 0)
  })

  it('no sheep without an anchor refuses at once', async () => {
    const bot = mockBot({ playerPos: pos(30, 64, 0) })
    handleChat(bot, tickerFor(bot), 'P', 'bring me wool 1')
    await bring(bot, bot._tickerCtx, null, {})
    await flush()
    assert.ok(bot.lines.some((l) => l === 'no sheep within 48 blocks'), `lines: ${bot.lines}`)
    assert.equal(bot._tickerCtx.bring, null)
  })
})
