'use strict'

// Bead idkcraft-jr2.2: two bedroom beds (the bot's first, the owner's second)
// and sleep in the own bed. Day step: shears -> self wool hunt -> craftItem
// beds -> through-wall placement with forced east yaw; night: stay sleeps in
// bedroom A instead of standing, never in the owner's bed.

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const beds = require('../src/behaviours/beds')
const bedMod = require('../src/behaviours/bed')
const bring = require('../src/behaviours/bring')
const homeMod = require('../src/behaviours/home')
const stockpileMod = require('../src/behaviours/stockpile')
const goal = require('../src/goal')
const { respawnLine, wakeBody, createLifecycle } = require('../src/index')

// Done-ladder ctx (ipn.8): the bed-reserve tests pin the BED keep, so they
// close the gear ladder — otherwise the gear reserve keeps 4 more planks and
// the assertions pin two features at once. Picks ride the pack (self rungs
// read the inventory); they are TOOL_KEEP and never enter the plan.
const LADDER_DONE = { gearGiven: { ...stockpileMod.GEAR_OWNER_WANT } }
const LADDER_PICKS = [{ name: 'iron_pickaxe', count: 1 }, { name: 'diamond_pickaxe', count: 1 }]

const SITE = { x: 10, y: 64, z: 20 }
// Bedroom A (bot's): foot (11,64,24) head (12,64,24); B (owner's): (14,64,24) (15,64,24).
const A_FOOT = { x: 11, y: 64, z: 24 }
const A_HEAD = { x: 12, y: 64, z: 24 }
const B_FOOT = { x: 14, y: 64, z: 24 }
const B_HEAD = { x: 15, y: 64, z: 24 }

function pos(x, y, z) {
  const p = { x, y, z, distanceTo: (q) => Math.hypot(x - q.x, y - q.y, z - q.z) }
  p.clone = () => pos(p.x, p.y, p.z)
  p.floored = () => pos(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z))
  return p
}

const ITEMS = {
  white_bed: 201, red_bed: 202, white_wool: 203, gray_wool: 204,
  oak_planks: 205, birch_planks: 206, iron_ingot: 207, shears: 208,
  crafting_table: 209, stick: 210, oak_log: 211,
  iron_pickaxe: 212, iron_sword: 213, diamond_pickaxe: 214, diamond_sword: 215,
  dirt: 216, string: 217,
}

// Fake recipe with the real shape (bring-craft.test.js pattern).
function R(product, takes, resCount, reqTable) {
  const delta = takes.map(([n, c]) => ({ id: ITEMS[n], count: -c }))
  delta.push({ id: ITEMS[product], count: resCount })
  return { delta, result: { count: resCount }, requiresTable: !!reqTable, product }
}

function RECIPES() {
  return {
    white_bed: [
      R('white_bed', [['white_wool', 3], ['oak_planks', 3]], 1, true),
      R('white_bed', [['white_wool', 3], ['birch_planks', 3]], 1, true),
    ],
    shears: [R('shears', [['iron_ingot', 2]], 1, false)],
    white_wool: [R('white_wool', [['string', 4]], 1, false)],
    crafting_table: [R('crafting_table', [['oak_planks', 4]], 1, false)],
    stick: [R('stick', [['oak_planks', 2]], 4, false)],
    oak_planks: [R('oak_planks', [['oak_log', 1]], 4, false)],
  }
}

function v2home(over = {}) {
  return {
    site: { ...SITE },
    built: true,
    v: 2,
    interior: { min: { x: 11, y: 64, z: 21 }, max: { x: 15, y: 65, z: 24 } },
    door: { x: 13, y: 64, z: 20 },
    table: { x: 15, y: 64, z: 21 },
    ...over,
  }
}

function mockBot({ items = [], cells = {}, at = null, timeOfDay = 6000, entities = {}, recipes = null, craftImpl = null, placeImpl = null, sleepImpl = null, withOptions = true, doorOpen = false, door = true, dark = false } = {}) {
  const chats = []
  const byId = {}
  for (const [name, id] of Object.entries(ITEMS)) byId[id] = name
  const itemsByName = {}
  for (const [name, id] of Object.entries(ITEMS)) itemsByName[name] = { id }
  const table = recipes === null ? RECIPES() : recipes
  const world = new Map(Object.entries(cells))
  const key = (x, y, z) => `${Math.floor(x)},${Math.floor(y)},${Math.floor(z)}`
  const calls = { goals: [], places: [], digs: [], equips: [], looks: [], sleeps: [], wakes: 0, crafts: [], activates: 0, tosses: [] }
  const doorState = { open: doorOpen }
  const bot = {
    chats, calls, world, byId,
    username: 'IdkBot',
    spawnPoint: pos(0, 64, 0),
    entity: { position: at ? pos(at.x, at.y, at.z) : pos(0, 65, 0), onGround: true },
    entities,
    players: {},
    time: { timeOfDay, day: 5 },
    held: null,
    isSleeping: false,
    _items: items,
    registry: { blocksByName: {}, itemsByName },
    inventory: { items: () => bot._items },
    _syncWindow: async () => {}, // modern mineflayer: the runOp resync is instant here
    recipesAll: (id) => (byId[id] && table[byId[id]]) || [],
    recipesFor: (id) => (byId[id] && table[byId[id]]) || [],
    craft: craftImpl || (async (recipe, count) => {
      calls.crafts.push(recipe.product)
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
    }),
    blockAt: (p) => {
      if (dark) return null
      const fx = Math.floor(p.x)
      const fy = Math.floor(p.y)
      const fz = Math.floor(p.z)
      const k = key(fx, fy, fz)
      if (door && fx === 13 && (fy === 64 || fy === 65) && fz === 20 && !world.has(k)) {
        return { name: 'oak_door', position: pos(fx, fy, fz), getProperties: () => ({ open: doorState.open }) }
      }
      const name = world.has(k) ? world.get(k) : (fy <= 63 ? 'dirt' : 'air')
      return { name, boundingBox: name === 'air' ? 'empty' : 'block', position: pos(fx, fy, fz) }
    },
    pathfinder: {
      goal: null,
      movements: { canDig: true },
      isMoving: () => false,
      setGoal: (g) => { calls.goals.push(g); bot.pathfinder.goal = g },
      stop: () => {},
    },
    equip: async (item, dest) => { calls.equips.push([item.name, dest]); bot.held = item.name },
    look: async (yaw, pitch) => { calls.looks.push([yaw, pitch]) },
    lookAt: (p) => { calls.looks.push(['at', p.x, p.z]) },
    setControlState: () => {},
    clearControlStates: () => {},
    dig: async (b) => {
      calls.digs.push(b.name)
      world.set(key(b.position.x, b.position.y, b.position.z), 'air')
    },
    placeBlock: async (ref, face) => {
      calls.places.push('plain')
      if (placeImpl) return placeImpl(bot, world, key, ref, face)
      const rp = (ref && ref.position) || ref
      world.set(key(rp.x + face.x, rp.y + face.y, rp.z + face.z), bot.held)
      world.set(key(rp.x + face.x + 1, rp.y + face.y, rp.z + face.z), bot.held) // east head
    },
    activateBlock: async () => { calls.activates++; doorState.open = !doorState.open },
    sleep: sleepImpl || (async (block) => { calls.sleeps.push(block && block.name); bot.isSleeping = true }),
    wake: async () => { calls.wakes++; bot.isSleeping = false },
    toss: async (id, meta, n) => { calls.tosses.push([id, meta, n]) },
    chat: (m) => { chats.push(String(m)) },
  }
  if (withOptions) {
    bot._placeBlockWithOptions = async (ref, face, opts) => {
      calls.places.push(opts)
      if (placeImpl) return placeImpl(bot, world, key, ref, face)
      const rp = (ref && ref.position) || ref
      world.set(key(rp.x + face.x, rp.y + face.y, rp.z + face.z), bot.held)
      world.set(key(rp.x + face.x + 1, rp.y + face.y, rp.z + face.z), bot.held) // east head
    }
  }
  return bot
}

const flush = async (n = 5) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)) }
const rest = (ms) => new Promise((r) => setTimeout(r, ms))
const cellKey = (p) => `${p.x},${p.y},${p.z}`

describe('jr2.2 shared have-a-bed helper contract (bed.js shared)', () => {
  it('pickBedColor: max wins, first-max ties, null when none', () => {
    assert.equal(bedMod.pickBedColor({ white_wool: 2, gray_wool: 5 }), 'gray')
    assert.equal(bedMod.pickBedColor({ white_wool: 4, gray_wool: 4 }), 'white')
    assert.equal(bedMod.pickBedColor({ oak_planks: 9 }), null)
    assert.equal(bedMod.pickBedColor({}), null)
    assert.equal(bedMod.pickBedColor({ magenta_wool: 1 }), 'magenta')
  })

  it('bedShortfall scales one bed and two', () => {
    assert.deepEqual(bedMod.bedShortfall({ white_wool: 2, oak_planks: 9 }, 'white'), { wool: 1, planks: 0 })
    assert.deepEqual(bedMod.bedShortfall({ white_wool: 6, oak_planks: 4 }, 'white', 2), { wool: 0, planks: 2 })
    assert.deepEqual(bedMod.bedShortfall({ gray_wool: 6, oak_planks: 6 }, 'white', 2), { wool: 6, planks: 0 })
    assert.deepEqual(bedMod.bedTarget('red'), 'red_bed')
  })

  it('bedInPack names the best bed item', () => {
    assert.equal(bedMod.bedInPack({ white_bed: 1, red_bed: 2 }), 'red_bed')
    assert.equal(bedMod.bedInPack({ white_wool: 6 }), null)
  })

  it('packCounts folds stacks by name', () => {
    const bot = mockBot({ items: [{ name: 'white_wool', count: 2 }, { name: 'white_wool', count: 3 }] })
    assert.deepEqual(bedMod.packCounts(bot), { white_wool: 5 })
  })
})

describe('jr2.2 bed geometry and adopt-on-sight', () => {
  it('bedrooms sit at the back row: A (1,4)-(2,4), B (4,4)-(5,4)', () => {
    const c = beds.cellsOf(v2home())
    assert.deepEqual({ x: c.a.foot.x, y: c.a.foot.y, z: c.a.foot.z }, A_FOOT)
    assert.deepEqual({ x: c.a.head.x, y: c.a.head.y, z: c.a.head.z }, A_HEAD)
    assert.deepEqual({ x: c.b.foot.x, y: c.b.foot.y, z: c.b.foot.z }, B_FOOT)
    assert.deepEqual({ x: c.b.head.x, y: c.b.head.y, z: c.b.head.z }, B_HEAD)
  })

  it('adopts standing beds, claims Vec3 feet', () => {
    const bot = mockBot({ cells: { [cellKey(A_FOOT)]: 'white_bed', [cellKey(A_HEAD)]: 'white_bed', [cellKey(B_FOOT)]: 'red_bed', [cellKey(B_HEAD)]: 'red_bed' } })
    const home = v2home()
    assert.deepEqual(beds.adoptBeds(bot, home), { a: true, b: true })
    assert.deepEqual({ x: home.bedA.x, y: home.bedA.y, z: home.bedA.z }, A_FOOT)
    assert.deepEqual({ x: home.bedB.x, y: home.bedB.y, z: home.bedB.z }, B_FOOT)
  })

  it('half beds read as not placed', () => {
    const bot = mockBot({ cells: { [cellKey(A_FOOT)]: 'white_bed' } })
    assert.deepEqual(beds.adoptBeds(bot, v2home()), { a: false, b: false })
  })

  it('a ghost claim retracts, a dark chunk trusts its claim', () => {
    const airy = mockBot({})
    const ghost = v2home({ bedA: { ...A_FOOT } })
    assert.deepEqual(beds.adoptBeds(airy, ghost), { a: false, b: false })
    assert.ok(!('bedA' in ghost), 'mined bed unclaims')
    const dark = mockBot({ dark: true })
    const claimed = v2home({ bedA: { ...A_FOOT }, bedB: { ...B_FOOT } })
    assert.deepEqual(beds.adoptBeds(dark, claimed), { a: true, b: true })
  })

  it('bedsFact: none/one/both, non-v2 owes nothing', () => {
    const none = mockBot({})
    assert.equal(beds.bedsFact(none, v2home()), 'none')
    const one = mockBot({ cells: { [cellKey(A_FOOT)]: 'white_bed', [cellKey(A_HEAD)]: 'white_bed' } })
    assert.equal(beds.bedsFact(one, v2home()), 'one')
    const both = mockBot({ cells: { [cellKey(A_FOOT)]: 'white_bed', [cellKey(A_HEAD)]: 'white_bed', [cellKey(B_FOOT)]: 'white_bed', [cellKey(B_HEAD)]: 'white_bed' } })
    assert.equal(beds.bedsFact(both, v2home()), 'both')
    assert.equal(beds.bedsFact(none, null), 'both')
    assert.equal(beds.bedsFact(none, { site: { ...SITE }, built: true, v: 1 }), 'both')
  })
})

describe('jr2.2 beds menu and goal glue', () => {
  const F = goal.MENU.beds.feasible
  it('feasible by day in a built v2 home with beds missing', () => {
    assert.equal(F({ time: 'day', home: 'built', beds: 'none' }), true)
    assert.equal(F({ time: 'day', home: 'built', beds: 'one' }), true)
    assert.equal(F({ time: 'night', home: 'built', beds: 'none' }), false)
    assert.equal(F({ time: 'dusk', home: 'built', beds: 'none' }), false)
    assert.equal(F({ time: 'day', home: 'site', beds: 'none' }), false)
    assert.equal(F({ time: 'day', home: 'built', beds: 'both' }), false)
    assert.equal(F({ time: 'day', home: 'built' }), false, 'missing beds fails closed')
  })

  it('beds slots after build, criteria and stepWhy mirror', () => {
    const o = goal.STEP_ORDER
    assert.equal(o.indexOf('beds'), o.indexOf('build') + 1)
    assert.ok(goal.STEP_CRITERIA.beds.includes('wool'))
    assert.equal(goal.stepWhy('beds', { time: 'night', home: 'built', beds: 'none' }, mockBot({}), {}, ''), 'beds: daytime job')
    assert.equal(goal.stepWhy('beds', { time: 'day', home: 'site', beds: 'none' }, mockBot({}), {}, ''), 'beds: house not built yet')
    assert.equal(goal.stepWhy('beds', { time: 'day', home: 'built', beds: 'both' }, mockBot({}), {}, ''), 'beds: both beds are in')
  })

  it('gather feeds the beds post-build on a short single-wood remainder', () => {
    const G = goal.MENU.gather.feasible
    assert.equal(G({ home: 'built', beds: 'none', maxPlanks: 2, logs: 0 }, mockBot({}), {}), true)
    assert.equal(G({ home: 'built', beds: 'one', maxPlanks: 2, logs: 0 }, mockBot({}), {}), true)
    assert.equal(G({ home: 'built', beds: 'none', maxPlanks: 2, logs: 3 }, mockBot({}), {}), true, 'partial loads keep filling (craft only converts full batches)')
    assert.equal(G({ home: 'built', beds: 'none', maxPlanks: 2, logs: 14 }, mockBot({}), {}), false, 'a full batch belongs to craft')
    assert.equal(G({ home: 'built', beds: 'none', maxPlanks: 6, logs: 0 }, mockBot({}), {}), false)
    assert.equal(G({ home: 'built', beds: 'both', maxPlanks: 0, logs: 0 }, mockBot({}), {}), false)
    assert.equal(G({ home: 'built', maxPlanks: 0, logs: 0 }, mockBot({}), {}), false, 'missing beds fails closed')
  })
})

describe('jr2.2 shears before wool: craft when fed, else hunt and kill', () => {
  it('shears in pack skip the craft', () => {
    const bot = mockBot({ items: [{ name: 'shears', count: 1 }] })
    const ctx = { home: v2home(), beds: { phase: 'shears' } }
    beds(bot, ctx)
    assert.equal(ctx.beds.phase, 'wool')
    assert.deepEqual(bot.calls.crafts, [])
  })

  it('fewer than 2 ingots skip to the kill-hunt', () => {
    const bot = mockBot({ items: [{ name: 'iron_ingot', count: 1 }] })
    const ctx = { home: v2home(), beds: { phase: 'shears' } }
    beds(bot, ctx)
    assert.equal(ctx.beds.phase, 'wool')
    assert.deepEqual(bot.calls.crafts, [])
  })

  it('2+ ingots craft shears, then wool', async () => {
    const bot = mockBot({ items: [{ name: 'iron_ingot', count: 3 }] })
    const ctx = { home: v2home(), beds: { phase: 'shears' } }
    beds(bot, ctx)
    assert.equal(ctx.gearInFlight, true)
    await rest(650)
    await flush()
    beds(bot, ctx)
    assert.equal(ctx.beds.phase, 'wool')
    assert.ok(bot._items.some((i) => i.name === 'shears'), `pack: ${JSON.stringify(bot._items)}`)
    assert.ok(bot.chats.includes('made shears, going for wool'))
  })

  it('a failed shears craft still hunts (kill fallback)', async () => {
    const bot = mockBot({ items: [{ name: 'iron_ingot', count: 2 }], craftImpl: async () => { throw new Error('window jammed') } })
    const ctx = { home: v2home(), beds: { phase: 'shears' } }
    beds(bot, ctx)
    await flush()
    beds(bot, ctx)
    assert.equal(ctx.beds.phase, 'wool')
    assert.equal(ctx.stepStatus, null, 'craftItem clears its loud failure; the step continues')
  })
})

describe('jr2.2 wool via a self bring order (did.3 mob rung)', () => {
  it('six of one color move to craft, mixed 4+2 keep hunting', () => {
    const ready = mockBot({ items: [{ name: 'white_wool', count: 6 }] })
    const ctx = { home: v2home(), beds: { phase: 'wool' } }
    beds(ready, ctx)
    assert.equal(ctx.beds.phase, 'craft')
    assert.ok(ready.chats.includes('got 6 white wool'))
    const mixed = mockBot({ items: [{ name: 'white_wool', count: 4 }, { name: 'gray_wool', count: 2 }] })
    const ctx2 = { home: v2home(), beds: { phase: 'wool' } }
    beds(mixed, ctx2)
    assert.equal(ctx2.beds.phase, 'wool')
    assert.ok(ctx2.bring && ctx2.bring.self === 'beds', 'hunt opened')
  })

  it('short packs open chest-first, mixed packs hunt direct', () => {
    const short = mockBot({ items: [{ name: 'white_wool', count: 2 }] })
    const home = v2home({ chest: { x: 15, y: 64, z: 22 } })
    const ctx = { home, beds: { phase: 'wool' } }
    beds(short, ctx)
    assert.equal(ctx.bring.self, 'beds')
    assert.equal(ctx.bring.want, 6)
    assert.equal(ctx.bring.names.length, 16)
    assert.equal(ctx.bring.phase, 'chestfetch')
    const nochest = mockBot({ items: [] })
    const ctxN = { home: v2home(), beds: { phase: 'wool' } }
    beds(nochest, ctxN)
    assert.equal(ctxN.bring.phase, 'find', 'no chest: straight to find')
    const mixed = mockBot({ items: [{ name: 'white_wool', count: 4 }, { name: 'gray_wool', count: 4 }] })
    const ctxM = { home, beds: { phase: 'wool' } }
    beds(mixed, ctxM)
    assert.equal(ctxM.bring.kind, 'wool', 'mixed: direct mob rung')
    assert.equal(ctxM.bring.drop, 'white_wool', 'top color leads')
    assert.equal(ctxM.bring.have, 4)
  })

  it('a running hunt is left alone; an exhausted one fails, a short one reopens', () => {
    const running = mockBot({ items: [] })
    const live = { self: 'beds', phase: 'walk' }
    const ctxR = { home: v2home(), beds: { phase: 'wool', hunt: live }, bring: live }
    beds(running, ctxR)
    assert.equal(ctxR.bring, live, 'untouched while the ticker runs it')
    const spent = mockBot({ items: [] })
    const ctxS = { home: v2home(), beds: { phase: 'wool', hunt: { searchLegs: { legs: 24 } } } }
    beds(spent, ctxS)
    assert.equal(ctxS.stepStatus, 'failed:no-wool')
    assert.equal(ctxS.bring, undefined)
    const cut = mockBot({ items: [] })
    const ctxC = { home: v2home(), beds: { phase: 'wool', hunt: { searchLegs: { legs: 3 } } } }
    beds(cut, ctxC)
    assert.ok(ctxC.bring && ctxC.bring.self === 'beds', 'short hunts reopen (dusk cancel, foreign order)')
    assert.equal(ctxC.beds.reopens, 1)
    const capped = mockBot({ items: [] })
    const ctxCap = { home: v2home(), beds: { phase: 'wool', hunt: { searchLegs: { legs: 0 } }, reopens: 3 } }
    beds(capped, ctxCap)
    assert.equal(ctxCap.stepStatus, 'failed:no-wool')
  })
})

describe('jr2.2 stockpile keeps bed work-in-progress while beds are owed', () => {
  function packBot(cells = {}) {
    return mockBot({
      items: [
        { name: 'white_wool', count: 8 },
        { name: 'gray_wool', count: 2 },
        { name: 'white_bed', count: 1 },
        { name: 'oak_planks', count: 10 },
        { name: 'dirt', count: 40 },
        ...LADDER_PICKS,
      ],
      cells,
    })
  }

  it('owed: all wool, all beds, first 6 planks stay; done: everything banks', () => {
    const owed = packBot({})
    const planOwed = stockpileMod.depositPlan(owed, { home: v2home(), ...LADDER_DONE })
    const names = planOwed.map((p) => `${p.count} ${p.name}`)
    assert.ok(!names.some((l) => l.includes('wool')), `banks no wool: ${names}`)
    assert.ok(!names.some((l) => l.includes('bed')), `banks no beds: ${names}`)
    assert.deepEqual(planOwed.filter((p) => p.name === 'oak_planks'), [{ name: 'oak_planks', count: 4 }])
    const done = packBot({ [cellKey(A_FOOT)]: 'white_bed', [cellKey(A_HEAD)]: 'white_bed', [cellKey(B_FOOT)]: 'white_bed', [cellKey(B_HEAD)]: 'white_bed' })
    const planDone = stockpileMod.depositPlan(done, { home: v2home(), ...LADDER_DONE })
    assert.ok(planDone.some((p) => p.name === 'white_wool'), 'leftovers bank once both beds are in')
    assert.ok(planDone.some((p) => p.name === 'white_bed'), 'spare beds bank once both beds are in')
  })

  it('no home: banks as before (no reserve)', () => {
    const bot = packBot({})
    const plan = stockpileMod.depositPlan(bot, { home: null })
    assert.ok(plan.some((p) => p.name === 'white_wool'))
  })
})

describe('jr2.2 craft recovers banked planks from the home chest', () => {
  const CHEST = { x: 15, y: 64, z: 22 }
  function chestBot(chestItems, at) {
    const bot = mockBot({
      items: [{ name: 'white_wool', count: 6 }],
      cells: { '15,64,21': 'crafting_table', '15,64,22': 'chest' },
      at,
    })
    bot.openChest = async () => ({
      containerItems: () => chestItems,
      withdraw: async (type, meta, n) => {
        const s = chestItems.find((c) => c.type === type)
        const take = Math.min(s ? s.count : 0, n)
        if (s) s.count -= take
        bot._items.push({ name: s.name, count: take })
      },
      close: () => {},
    })
    return bot
  }

  it('withdraws planks in reach, then crafts', async () => {
    const chestItems = [{ name: 'oak_planks', type: 5, metadata: 0, count: 12 }]
    const bot = chestBot(chestItems, { x: 15, y: 64, z: 21 })
    const ctx = { home: v2home({ chest: { ...CHEST } }), beds: { phase: 'craft' } }
    beds(bot, ctx) // craft fails missing -> withdraw flight
    await flush()
    beds(bot, ctx) // planks landed -> craftItem runs
    assert.equal(ctx.gearInFlight, true)
    await rest(650)
    await flush()
    beds(bot, ctx)
    const bedCount = bot._items.filter((i) => i.name === 'white_bed').reduce((n, i) => n + i.count, 0)
    assert.equal(bedCount, 1, `pack: ${JSON.stringify(bot._items)}`)
  })

  it('adopts an unclaimed chest on sight (fresh session)', async () => {
    const chestItems = [{ name: 'oak_planks', type: 5, metadata: 0, count: 12 }]
    const bot = chestBot(chestItems, { x: 15, y: 64, z: 21 })
    const home = v2home()
    delete home.chest
    const ctx = { home, beds: { phase: 'craft' } }
    beds(bot, ctx)
    await flush()
    assert.deepEqual({ x: ctx.home.chest.x, y: ctx.home.chest.y, z: ctx.home.chest.z }, CHEST)
    beds(bot, ctx)
    assert.equal(ctx.gearInFlight, true, 'withdrawn planks feed the craft')
  })

  it('walks into chest reach first', () => {
    const chestItems = [{ name: 'oak_planks', type: 5, metadata: 0, count: 12 }]
    const bot = chestBot(chestItems, { x: 0, y: 64, z: 0 })
    const ctx = { home: v2home({ chest: { ...CHEST } }), beds: { phase: 'craft' } }
    beds(bot, ctx)
    assert.equal(bot.calls.goals.length, 1)
    const g = bot.calls.goals[0]
    assert.deepEqual({ x: g.x, y: g.y, z: g.z }, CHEST)
    assert.equal(g.rangeSq, 9, 'stops at through-wall reach, never enters')
    assert.equal(ctx.stepStatus, undefined, 'walking, not failing')
  })

  it('a dry chest yields to gather (failed:no-planks, no spin)', async () => {
    const bot = chestBot([], { x: 15, y: 64, z: 21 })
    const ctx = { home: v2home({ chest: { ...CHEST } }), beds: { phase: 'craft' } }
    beds(bot, ctx)
    await flush()
    assert.equal(ctx.stepStatus, undefined, 'first tick recovers')
    beds(bot, ctx)
    assert.equal(ctx.stepStatus, 'failed:no-planks')
    assert.equal(ctx.beds.planksDry, true)
  })
})

describe('jr2.2 bring self orders: dusk cancels, return keeps', () => {
  function sheepBot(timeOfDay) {
    return mockBot({
      timeOfDay,
      entities: { 7: { id: 7, name: 'sheep', isValid: true, position: pos(5, 64, 5) } },
    })
  }

  it('a self hunt runs by day and dies silently at night', async () => {
    const day = sheepBot(6000)
    const ctxD = { bring: { self: 'beds', kind: 'wool', phase: 'find', want: 6, have: 0, color: null, drop: null } }
    await bring(day, ctxD, null, {})
    assert.ok(ctxD.bring, 'day: hunt runs')
    assert.equal(ctxD.bring.phase, 'walk')
    const night = sheepBot(15000)
    const ctxN = { bring: { self: 'beds', kind: 'wool', phase: 'walk', want: 6, have: 2 }, explore: { target: { x: 1 } } }
    await bring(night, ctxN, null, {})
    assert.equal(ctxN.bring, null, 'night: dusk-cancelled')
    assert.deepEqual(night.chats, [], 'silent: gohome announces')
    assert.equal(ctxN.explore.target, null, 'parked search leg cleared')
  })

  it('regression: a foreign order survives the night (only self cancels)', async () => {
    const night = sheepBot(15000)
    const ctx = { bring: { kind: 'wool', phase: 'walk', animal: { id: 999 }, want: 3, have: 0 } }
    await bring(night, ctx, null, {})
    assert.ok(ctx.bring, 'player wool order untouched at night')
  })

  it('a self return keeps the goods: no walk, no toss', async () => {
    const bot = mockBot({ items: [{ name: 'white_wool', count: 6 }] })
    const ctx = { bring: { self: 'beds', kind: 'wool', phase: 'return', want: 6, have: 6, drop: 'white_wool', by: null } }
    await bring(bot, ctx, null, {})
    assert.equal(ctx.bring, null)
    assert.deepEqual(bot.calls.goals, [], 'no walk to a player')
    assert.deepEqual(bot.calls.tosses, [], 'no toss')
    assert.deepEqual(bot.chats, [], 'silent: the bed step announces')
  })
})

describe('jr2.2 bed craft: one color, single crafts, honest diagnose', () => {
  function tableCtx(homeOver = {}) {
    return { home: v2home(homeOver) }
  }

  async function craftUntil(bot, ctx, maxTicks = 8) {
    for (let i = 0; i < maxTicks; i++) {
      beds(bot, ctx)
      if (ctx.gearInFlight) await rest(650)
      await flush()
      if (ctx.stepStatus && ctx.stepStatus !== 'running') break
      if (ctx.beds.phase !== 'craft') break
    }
  }

  it('crafts one bed per run and pins the color', async () => {
    const cells = { '15,64,21': 'crafting_table' }
    const bot = mockBot({ items: [{ name: 'white_wool', count: 6 }, { name: 'oak_planks', count: 6 }], cells, at: { x: 15, y: 64, z: 21 } })
    const ctx = tableCtx()
    ctx.beds = { phase: 'craft' }
    await craftUntil(bot, ctx)
    const bedCount = bot._items.filter((i) => i.name === 'white_bed').reduce((n, i) => n + i.count, 0)
    assert.equal(bedCount, 2)
    assert.equal(ctx.beds.phase, 'place')
    assert.equal(ctx.beds.color, 'white')
    const woolLeft = bot._items.filter((i) => i.name === 'white_wool').reduce((n, i) => n + i.count, 0)
    assert.equal(woolLeft, 0, '6 wool fed 2 beds')
  })

  it('mixed woods land one bed at a time (oak then birch)', async () => {
    const cells = { '15,64,21': 'crafting_table' }
    const bot = mockBot({ items: [{ name: 'white_wool', count: 6 }, { name: 'oak_planks', count: 4 }, { name: 'birch_planks', count: 4 }], cells, at: { x: 15, y: 64, z: 21 } })
    const ctx = tableCtx()
    ctx.beds = { phase: 'craft' }
    await craftUntil(bot, ctx, 12)
    const bedCount = bot._items.filter((i) => i.name === 'white_bed').reduce((n, i) => n + i.count, 0)
    assert.equal(bedCount, 2, `pack: ${JSON.stringify(bot._items)}`)
    assert.equal(ctx.beds.phase, 'place')
  })

  it('plank-short fails no-planks (gather feeds), mixed 2+2+2 too', async () => {
    const cells = { '15,64,21': 'crafting_table' }
    for (const items of [
      [{ name: 'white_wool', count: 6 }, { name: 'oak_planks', count: 2 }],
      [{ name: 'white_wool', count: 6 }, { name: 'oak_planks', count: 2 }, { name: 'birch_planks', count: 2 }],
    ]) {
      const bot = mockBot({ items, cells, at: { x: 15, y: 64, z: 21 } })
      const ctx = tableCtx()
      ctx.beds = { phase: 'craft' }
      await craftUntil(bot, ctx)
      assert.equal(ctx.stepStatus, 'failed:no-planks', `pack: ${JSON.stringify(items)}`)
    }
  })

  it('spent wool re-hunts instead of failing', async () => {
    const bot = mockBot({ items: [{ name: 'white_wool', count: 2 }, { name: 'oak_planks', count: 6 }] })
    const ctx = tableCtx()
    ctx.beds = { phase: 'craft' }
    beds(bot, ctx)
    assert.equal(ctx.beds.phase, 'wool')
    assert.equal(ctx.stepStatus, undefined)
  })

  it('covered beds skip to place', () => {
    const bot = mockBot({ items: [{ name: 'white_bed', count: 2 }] })
    const ctx = tableCtx()
    ctx.beds = { phase: 'craft' }
    beds(bot, ctx)
    assert.equal(ctx.beds.phase, 'place')
  })
})

describe('jr2.2 placement: bot bed first through the south wall, facing east', () => {
  it('walks to staging, places A then B, done', async () => {
    const bot = mockBot({ items: [{ name: 'white_bed', count: 2 }], at: { x: 0, y: 64, z: 0 } })
    const ctx = { home: v2home(), beds: { phase: 'place', color: 'white' } }
    beds(bot, ctx)
    assert.equal(bot.calls.goals.length, 1)
    const g = bot.calls.goals[0]
    assert.deepEqual({ x: g.x, y: g.y, z: g.z }, { x: A_FOOT.x, y: A_FOOT.y, z: A_FOOT.z + 2 })
    bot.entity.position = pos(A_FOOT.x, A_FOOT.y, A_FOOT.z + 2)
    beds(bot, ctx)
    await rest(650)
    await flush()
    assert.equal(bot.world.get(cellKey(A_FOOT)), 'white_bed')
    assert.equal(bot.world.get(cellKey(A_HEAD)), 'white_bed')
    assert.equal(bot.world.get(cellKey(B_FOOT)), undefined, 'B waits for its turn')
    assert.deepEqual({ x: ctx.home.bedA.x, y: ctx.home.bedA.y, z: ctx.home.bedA.z }, A_FOOT)
    assert.ok(bot.chats.includes('my bed is in'))
    assert.deepEqual(bot.calls.looks, [[-Math.PI / 2, 0]], 'faces east for the +x head')
    assert.equal(bot.calls.places[0].forceLook, 'ignore', 'yaw survives the placement')
    beds(bot, ctx) // B is in reach from A's staging: no second walk
    await rest(650)
    await flush()
    assert.equal(bot.world.get(cellKey(B_FOOT)), 'white_bed')
    assert.equal(bot.world.get(cellKey(B_HEAD)), 'white_bed')
    assert.ok(bot.chats.includes('your bed is in'))
    beds(bot, ctx)
    assert.equal(ctx.stepStatus, 'done')
    assert.ok(bot.chats.includes('both beds are in'))
  })

  it('falls back to a plain place without the options API', async () => {
    const bot = mockBot({ items: [{ name: 'white_bed', count: 1 }], at: { x: A_FOOT.x, y: A_FOOT.y, z: A_FOOT.z + 2 }, withOptions: false })
    const ctx = { home: v2home(), beds: { phase: 'place', color: 'white' } }
    // B pre-placed: only A is owed, one bed covers it.
    bot.world.set(cellKey(B_FOOT), 'white_bed')
    bot.world.set(cellKey(B_HEAD), 'white_bed')
    beds(bot, ctx)
    await rest(650)
    await flush()
    assert.deepEqual(bot.calls.places, ['plain'])
    assert.equal(bot.world.get(cellKey(A_FOOT)), 'white_bed')
  })

  it('a lagging head packet still verifies (rig race: foot acks first)', async () => {
    const bot = mockBot({
      items: [{ name: 'white_bed', count: 1 }],
      at: { x: A_FOOT.x, y: A_FOOT.y, z: A_FOOT.z + 2 },
      placeImpl: (b, world, key, ref, face) => {
        const rp = (ref && ref.position) || ref
        world.set(key(rp.x + face.x, rp.y + face.y, rp.z + face.z), b.held)
        setTimeout(() => world.set(key(rp.x + face.x + 1, rp.y + face.y, rp.z + face.z), b.held), 100)
      },
    })
    bot.world.set(cellKey(B_FOOT), 'white_bed')
    bot.world.set(cellKey(B_HEAD), 'white_bed')
    const ctx = { home: v2home(), beds: { phase: 'place', color: 'white' } }
    beds(bot, ctx)
    await rest(650)
    await flush()
    assert.ok(bot.chats.includes('my bed is in'), `chats: ${bot.chats}`)
    assert.equal(ctx.beds.fails || 0, 0)
  })

  it('a bed that lands after adopt claims in-flight, never places twice', async () => {
    let placed = 0
    const bot = mockBot({
      items: [{ name: 'white_bed', count: 1 }],
      cells: { [cellKey(A_FOOT)]: 'white_bed', [cellKey(A_HEAD)]: 'white_bed', [cellKey(B_FOOT)]: 'white_bed', [cellKey(B_HEAD)]: 'white_bed' },
      at: { x: A_FOOT.x, y: A_FOOT.y, z: A_FOOT.z + 2 },
      placeImpl: () => { placed++ },
    })
    // Live shape: adopt's scan misses the bed (head packet still in flight),
    // the flight's pre-check sees it. Blind the 3 adopt reads (A foot fails
    // fast so no A head read happens), then show the world.
    const origBlockAt = bot.blockAt
    let reads = 0
    bot.blockAt = (p) => {
      reads++
      const b = origBlockAt(p)
      const isA = (p.x === A_FOOT.x || p.x === A_HEAD.x) && p.y === A_FOOT.y && p.z === A_FOOT.z
      if (reads <= 3 && isA) return { name: 'air', position: pos(p.x, p.y, p.z), boundingBox: 'empty' }
      return b
    }
    const ctx = { home: v2home(), beds: { phase: 'place', color: 'white' } }
    beds(bot, ctx)
    await flush()
    assert.equal(placed, 0, 'pre-check claims, no placement')
    assert.ok(bot.chats.includes('my bed is in'), `chats: ${bot.chats}`)
    assert.deepEqual({ x: ctx.home.bedA.x, y: ctx.home.bedA.y, z: ctx.home.bedA.z }, A_FOOT)
  })

  it('an unwalkable staging fails cant-reach-bed, refusals fail cant-place-bed', async () => {
    const stuck = mockBot({ items: [{ name: 'white_bed', count: 2 }], at: { x: 0, y: 64, z: 0 } })
    const ctxS = { home: v2home(), beds: { phase: 'place' } }
    for (let i = 0; i < 40 && !ctxS.stepStatus; i++) beds(stuck, ctxS)
    assert.equal(ctxS.stepStatus, 'failed:cant-reach-bed')
    const refuse = mockBot({
      items: [{ name: 'white_bed', count: 2 }],
      at: { x: A_FOOT.x, y: A_FOOT.y, z: A_FOOT.z + 2 },
      placeImpl: () => {}, // server swallows every placement
    })
    const ctxR = { home: v2home(), beds: { phase: 'place' } }
    for (let i = 0; i < 3; i++) { beds(refuse, ctxR); await rest(650); await flush() }
    assert.equal(ctxR.stepStatus, 'failed:cant-place-bed')
  })

  it('flora clears, stone and half beds fail loud without digging', async () => {
    const grassy = mockBot({
      items: [{ name: 'white_bed', count: 1 }],
      cells: { [cellKey(A_FOOT)]: 'short_grass', [cellKey(B_FOOT)]: 'white_bed', [cellKey(B_HEAD)]: 'white_bed' },
      at: { x: A_FOOT.x, y: A_FOOT.y, z: A_FOOT.z + 2 },
    })
    const ctxG = { home: v2home(), beds: { phase: 'place' } }
    beds(grassy, ctxG)
    await rest(650)
    await flush()
    assert.deepEqual(grassy.calls.digs, ['short_grass'])
    assert.equal(grassy.world.get(cellKey(A_FOOT)), 'white_bed')
    const stony = mockBot({
      items: [{ name: 'white_bed', count: 1 }],
      cells: { [cellKey(A_HEAD)]: 'stone', [cellKey(B_FOOT)]: 'white_bed', [cellKey(B_HEAD)]: 'white_bed' },
      at: { x: A_FOOT.x, y: A_FOOT.y, z: A_FOOT.z + 2 },
    })
    const ctxT = { home: v2home(), beds: { phase: 'place' } }
    for (let i = 0; i < 3; i++) { beds(stony, ctxT); await flush() }
    assert.equal(ctxT.stepStatus, 'failed:cant-place-bed')
    assert.deepEqual(stony.calls.digs, [], 'stone never dug')
    const half = mockBot({
      items: [{ name: 'white_bed', count: 1 }],
      cells: { [cellKey(A_FOOT)]: 'white_bed', [cellKey(B_FOOT)]: 'white_bed', [cellKey(B_HEAD)]: 'white_bed' },
      at: { x: A_FOOT.x, y: A_FOOT.y, z: A_FOOT.z + 2 },
    })
    const ctxH = { home: v2home(), beds: { phase: 'place' } }
    for (let i = 0; i < 3; i++) { beds(half, ctxH); await flush() }
    assert.equal(ctxH.stepStatus, 'failed:cant-place-bed')
    assert.deepEqual(half.calls.digs, [], 'guarded halves never self-dug')
  })

  it('a lost pack returns to craft; a finished house is done', () => {
    const bot = mockBot({ items: [] })
    const ctx = { home: v2home(), beds: { phase: 'place' } }
    beds(bot, ctx)
    assert.equal(ctx.beds.phase, 'craft')
    const doneBot = mockBot({ cells: { [cellKey(A_FOOT)]: 'white_bed', [cellKey(A_HEAD)]: 'white_bed', [cellKey(B_FOOT)]: 'white_bed', [cellKey(B_HEAD)]: 'white_bed' } })
    const ctxD = { home: v2home(), beds: { phase: 'place' } }
    beds(doneBot, ctxD)
    assert.equal(ctxD.stepStatus, 'done')
  })

  it('non-v2 homes fail no-house', () => {
    for (const home of [null, { site: { ...SITE }, built: true, v: 1 }]) {
      const bot = mockBot({})
      const ctx = { home, beds: { phase: 'shears' } }
      beds(bot, ctx)
      assert.equal(ctx.stepStatus, 'failed:no-house')
    }
  })
})

describe('jr2.2 stay sleeps in the own bed, never the owner\'s', () => {
  function stayCtx(homeOver = {}) {
    return { home: v2home(homeOver) }
  }

  it('walks to the bedroom, sleeps, holds silent while asleep', async () => {
    const cells = { [cellKey(A_FOOT)]: 'white_bed', [cellKey(A_HEAD)]: 'white_bed' }
    const bot = mockBot({ cells, at: { x: 13, y: 64, z: 21 }, timeOfDay: 15000 })
    const ctx = stayCtx()
    homeMod.stay(bot, ctx)
    assert.equal(bot.calls.goals.length, 1, 'walks into sleep reach')
    const g = bot.calls.goals[0]
    assert.deepEqual({ x: g.x, y: g.y, z: g.z }, { x: 12, y: 64, z: 23 })
    assert.deepEqual(bot.calls.sleeps, [], 'no sleep from afar')
    bot.entity.position = pos(12, 64, 23)
    homeMod.stay(bot, ctx)
    await flush()
    assert.deepEqual(bot.calls.sleeps, ['white_bed'])
    assert.ok(bot.chats.includes('sleeping in my bed'))
    assert.deepEqual({ x: ctx.home.bedA.x, y: ctx.home.bedA.y, z: ctx.home.bedA.z }, A_FOOT)
    const chats = bot.chats.length
    homeMod.stay(bot, ctx)
    assert.equal(bot.chats.length, chats, 'asleep: silent')
    assert.equal(bot.calls.activates, 0, 'asleep: door untouched')
    assert.equal(bot.calls.goals.length, 1, 'asleep: no new goals')
    assert.equal(ctx.inShelter, true)
  })

  it('6x7.22: the far-row arrival of the sleep walk is in reach (rig HOUSE-NIGHT/BUMP)', async () => {
    // GoalNear(sleep 12,64,23, 1) is met in cell 12,22: 2.1 from the head's
    // centre, 1.6 from its face — the centre read stalled here all night.
    const cells = { [cellKey(A_FOOT)]: 'white_bed', [cellKey(A_HEAD)]: 'white_bed' }
    const bot = mockBot({ cells, at: { x: 12.5, y: 64, z: 22.4 }, timeOfDay: 15000 })
    const ctx = stayCtx()
    homeMod.stay(bot, ctx)
    await flush()
    assert.deepEqual(bot.calls.goals, [], 'no walk: already in reach')
    assert.deepEqual(bot.calls.sleeps, ['white_bed'])
  })

  it('without its own bed the bot holds as before (regression)', () => {
    for (const cells of [
      {},
      { [cellKey(B_FOOT)]: 'red_bed', [cellKey(B_HEAD)]: 'red_bed' },
      { [cellKey(A_FOOT)]: 'white_bed' },
    ]) {
      const bot = mockBot({ cells, at: { x: 13, y: 64, z: 21 }, timeOfDay: 15000 })
      const ctx = stayCtx()
      homeMod.stay(bot, ctx)
      assert.deepEqual(bot.calls.sleeps, [], `no sleep, cells: ${JSON.stringify(cells)}`)
      assert.deepEqual(bot.calls.goals, [], 'holds instead of walking')
      assert.equal(ctx.inShelter, true)
    }
  })

  it('rw4.20: a carried bed is laid in empty bedroom A at night, then slept in', async () => {
    const bot = mockBot({ items: [{ name: 'red_bed', count: 1 }], at: { x: 12, y: 64, z: 23 }, timeOfDay: 15000 })
    const ctx = stayCtx()
    homeMod.stay(bot, ctx)
    await rest(600)
    assert.equal(bot.world.get(cellKey(A_FOOT)), 'red_bed')
    assert.equal(bot.world.get(cellKey(A_HEAD)), 'red_bed')
    assert.deepEqual(bot.calls.looks[0], [-Math.PI / 2, 0], 'forced east yaw: head lands +x')
    assert.ok(bot.chats.includes('my bed is in'))
    homeMod.stay(bot, ctx)
    await flush()
    assert.deepEqual(bot.calls.sleeps, ['red_bed'])
    assert.ok(bot.chats.includes('sleeping in my bed'))
  })

  it('rw4.20: a bed that never takes gives up after three tries, then holds', async () => {
    const bot = mockBot({
      items: [{ name: 'red_bed', count: 1 }], at: { x: 12, y: 64, z: 23 }, timeOfDay: 15000,
      placeImpl: async () => {}, // the server swallows the place: cells stay air
    })
    const ctx = stayCtx()
    for (let i = 0; i < 5; i++) {
      homeMod.stay(bot, ctx)
      await rest(550)
    }
    assert.equal(bot.calls.places.length, 3, 'capped at NIGHT_BED_FAILS')
    assert.equal(ctx.sleepInFlight, false)
    assert.ok(!bot.chats.includes('my bed is in'))
  })

  it('rw4.20: an occupied or groundless bedroom A holds as before, bed kept', () => {
    for (const cells of [
      { [cellKey(A_FOOT)]: 'dirt' },
      { [`${A_HEAD.x},${A_HEAD.y - 1},${A_HEAD.z}`]: 'air' },
    ]) {
      const bot = mockBot({ items: [{ name: 'red_bed', count: 1 }], cells, at: { x: 12, y: 64, z: 23 }, timeOfDay: 15000 })
      const ctx = stayCtx()
      homeMod.stay(bot, ctx)
      assert.deepEqual(bot.calls.places, [], `no place, cells: ${JSON.stringify(cells)}`)
      assert.deepEqual(bot.calls.goals, [], 'holds instead of walking')
    }
  })

  it('v1 homes never sleep even with the API present (regression)', () => {
    const bot = mockBot({ at: { x: 11, y: 64, z: 21 }, timeOfDay: 15000 })
    const ctx = { home: { site: { ...SITE }, built: true, interior: { min: { x: 11, y: 64, z: 21 }, max: { x: 12, y: 65, z: 22 } } } }
    homeMod.stay(bot, ctx)
    assert.deepEqual(bot.calls.sleeps, [])
  })

  it('a refused sleep backs off; the awake body still re-closes the door', async () => {
    let tries = 0
    const cells = { [cellKey(A_FOOT)]: 'white_bed', [cellKey(A_HEAD)]: 'white_bed' }
    const bot = mockBot({
      cells, at: { x: 12, y: 64, z: 23 }, timeOfDay: 15000, doorOpen: true,
      sleepImpl: async () => { tries++; throw new Error('there are monsters nearby') },
    })
    const ctx = stayCtx()
    homeMod.stay(bot, ctx)
    await flush()
    assert.equal(tries, 1)
    assert.equal(bot.calls.activates, 0, 'the launch tick still owns the door')
    homeMod.stay(bot, ctx)
    await flush()
    assert.equal(tries, 1, 'transient failures back off instead of owning the tick')
    assert.equal(bot.calls.activates, 1, 'awake: the open door re-closes between tries')
    bot.isSleeping = true // a hit that never landed: door open, body asleep
    bot.calls.activates = 0
    homeMod.stay(bot, ctx)
    assert.equal(bot.calls.activates, 0, 'no toggle into the sleeping body')
  })

  it('server-side sleep refusals give up tonight, retry tomorrow', async () => {
    let tries = 0
    const cells = { [cellKey(A_FOOT)]: 'white_bed', [cellKey(A_HEAD)]: 'white_bed' }
    const bot = mockBot({
      cells, at: { x: 12, y: 64, z: 23 }, timeOfDay: 15000,
      sleepImpl: async () => { tries++; throw new Error('the bed is occupied') },
    })
    const ctx = stayCtx()
    homeMod.stay(bot, ctx)
    await flush()
    homeMod.stay(bot, ctx)
    await flush()
    assert.equal(tries, 1, 'occupied never retries tonight (no listener pile-up)')
    assert.equal(ctx.stay.sleepGiveUp, true)
  })

  it('g0z.43: a silent server refusal backs off and retries instead of giving up the night', async () => {
    // Under lag the bot clock runs ahead of the server: the local night
    // check passes, the server silently refuses the bed, and mineflayer's
    // 3 s wait fails 'bot is not sleeping'. That is transient, not a stop.
    let tries = 0
    const cells = { [cellKey(A_FOOT)]: 'white_bed', [cellKey(A_HEAD)]: 'white_bed' }
    const bot = mockBot({
      cells, at: { x: 12, y: 64, z: 23 }, timeOfDay: 15000,
      sleepImpl: async (block) => {
        tries++
        if (tries === 1) throw new Error('bot is not sleeping')
        bot.calls.sleeps.push(block && block.name)
        bot.isSleeping = true
      },
    })
    const ctx = stayCtx()
    homeMod.stay(bot, ctx)
    await flush()
    assert.equal(tries, 1)
    assert.equal(ctx.stay.sleepGiveUp, undefined, 'silent refusal backs off, never gives up')
    assert.equal(ctx.stay.sleepCooldown, 30, 'bounded backoff, not a tight loop')
    for (let i = 0; i < 30; i++) {
      homeMod.stay(bot, ctx)
      await flush()
    }
    assert.equal(tries, 1, 'no retry during backoff')
    homeMod.stay(bot, ctx)
    await flush()
    assert.equal(tries, 2, 'retry after backoff')
    assert.deepEqual(bot.calls.sleeps, ['white_bed'])
    assert.ok(bot.chats.includes('sleeping in my bed'))
    assert.equal(ctx.stay.sleepGiveUp, undefined)
  })

  it('g0z.43: a permanently refused bed gives up after three silent refusals', async () => {
    // The timeout is mineflayer's generic refusal: a bed the server never
    // accepts must not click all night (each try leaks a 'sleep' listener).
    let tries = 0
    const cells = { [cellKey(A_FOOT)]: 'white_bed', [cellKey(A_HEAD)]: 'white_bed' }
    const bot = mockBot({
      cells, at: { x: 12, y: 64, z: 23 }, timeOfDay: 15000,
      sleepImpl: async () => { tries++; throw new Error('bot is not sleeping') },
    })
    const ctx = stayCtx()
    const round = async () => { homeMod.stay(bot, ctx); await flush() }
    await round() // try 1 -> backoff
    assert.equal(ctx.stay.sleepGiveUp, undefined)
    for (let i = 0; i < 30; i++) await round()
    await round() // try 2 -> backoff
    assert.equal(tries, 2)
    assert.equal(ctx.stay.sleepGiveUp, undefined)
    for (let i = 0; i < 30; i++) await round()
    await round() // try 3 -> give up
    assert.equal(tries, 3)
    assert.equal(ctx.stay.sleepGiveUp, true)
    for (let i = 0; i < 40; i++) await round()
    assert.equal(tries, 3, 'no more clicks tonight')
  })

  it('an order mid-flight wakes the body at once (spawn kept, chat skipped)', async () => {
    let release = null
    const gate = new Promise((r) => { release = r })
    const cells = { [cellKey(A_FOOT)]: 'white_bed', [cellKey(A_HEAD)]: 'white_bed' }
    const bot = mockBot({ cells, at: { x: 12, y: 64, z: 23 }, timeOfDay: 15000, sleepImpl: () => gate })
    const ctx = stayCtx()
    homeMod.stay(bot, ctx)
    await flush() // attempt launched, server round-trip held
    ctx.stay = null // the order takes the body mid-flight
    release()
    await flush()
    assert.equal(bot.calls.wakes, 1)
    assert.equal(ctx.home.sleptA, true, 'the spawn was set')
    assert.ok(!bot.chats.includes('sleeping in my bed'), 'no chat under the order')
  })

  it('a slept bed marks the spawn; retracts clear it', async () => {
    const cells = { [cellKey(A_FOOT)]: 'white_bed', [cellKey(A_HEAD)]: 'white_bed' }
    const bot = mockBot({ cells, at: { x: 12, y: 64, z: 23 }, timeOfDay: 15000 })
    const ctx = stayCtx()
    homeMod.stay(bot, ctx)
    await flush()
    assert.equal(ctx.home.sleptA, true, 'sleep sets the spawn')
    bot.world.delete(cellKey(A_FOOT)) // mined overnight: the ghost retracts
    bot.isSleeping = false // vanilla kicks the body out of a mined bed
    homeMod.stay(bot, ctx)
    assert.equal(ctx.home.bedA, undefined)
    assert.equal(ctx.home.sleptA, undefined, 'mined bed: the spawn is world spawn again')
  })

  it('dawn wakes a still-sleeping body before the exit legs', async () => {
    const bot = mockBot({ at: { x: 12, y: 64, z: 23 }, timeOfDay: 1000 })
    bot.isSleeping = true
    const ctx = stayCtx()
    ctx.stay = { phase: 'hold', stalls: 0, fails: 0, lastPos: null, lastToggle: 0 }
    homeMod.stay(bot, ctx)
    await flush()
    assert.equal(bot.calls.wakes, 1)
    assert.equal(bot.calls.activates, 0, 'no door work while asleep')
    homeMod.stay(bot, ctx) // awake now: the normal exit opens the door
    assert.equal(bot.calls.activates, 1)
  })
})

describe('jr2.2 respawn lands at the claimed bed', () => {
  it('only a slept bed wins over world spawn', () => {
    const bot = mockBot({})
    bot._tickerCtx = { home: { bedA: { ...A_FOOT } } }
    assert.equal(respawnLine(bot), 'respawn at 0 64 0', 'unslept claim: world spawn')
    bot._tickerCtx.home.sleptA = true
    assert.equal(respawnLine(bot), 'respawn at 11 64 24 (bed)')
    const bare = mockBot({})
    assert.equal(respawnLine(bare), 'respawn at 0 64 0')
  })

  it('spawnReset clears the slept mark (obstructed/mined bed)', () => {
    const bot = mockBot({})
    bot._tickerCtx = { home: { bedA: { ...A_FOOT }, sleptA: true } }
    createLifecycle(null).onSpawnReset(bot)
    assert.equal(bot._tickerCtx.home.sleptA, undefined)
    assert.equal(respawnLine(bot), 'respawn at 0 64 0')
  })

  it('orders wake a sleeping body; awake bots pass through', async () => {
    let wakes = 0
    const asleep = mockBot({})
    asleep.isSleeping = true
    asleep.wake = async () => { wakes++ }
    wakeBody(asleep)
    await flush()
    assert.equal(wakes, 1)
    const awake = mockBot({})
    awake.wake = async () => { wakes++ }
    wakeBody(awake)
    await flush()
    assert.equal(wakes, 1, 'awake: untouched')
  })
})

describe('jr2.2 decide picks beds over explore until both are in', () => {
  function ladenBot(cells = {}) {
    return mockBot({
      timeOfDay: 6000,
      items: [
        { name: 'iron_pickaxe', count: 1 }, { name: 'iron_sword', count: 1 },
        { name: 'diamond_pickaxe', count: 1 }, { name: 'diamond_sword', count: 1 },
        { name: 'dirt', count: 40 },
      ],
      cells,
    })
  }

  function ladenCtx(home) {
    return {
      home,
      gearGiven: { iron_sword: 1, iron_pickaxe: 1, diamond_sword: 1, diamond_pickaxe: 1 },
      gear: {},
    }
  }

  it('beds missing: beds; both in: explore', async () => {
    const bot = ladenBot()
    const ctx = ladenCtx(v2home())
    const r = await goal.decide(bot, ctx)
    assert.equal(r.action, 'beds')
    assert.ok(bot.chats.includes('next: making beds (goal-fsm)'), `chats: ${bot.chats}`)
    const bot2 = ladenBot({ [cellKey(A_FOOT)]: 'white_bed', [cellKey(A_HEAD)]: 'white_bed', [cellKey(B_FOOT)]: 'white_bed', [cellKey(B_HEAD)]: 'white_bed' })
    // Full kit (ipn.6 armor ladder included): gear reads done, explore wins.
    for (const n of ['diamond_helmet', 'diamond_chestplate', 'diamond_leggings', 'diamond_boots', 'iron_helmet', 'iron_chestplate', 'iron_leggings', 'iron_boots']) bot2._items.push({ name: n, count: 1 })
    bot2._items.push({ name: 'water_bucket', count: 2 })
    const ctx2 = ladenCtx(v2home())
    ctx2.gearGiven = { iron_sword: 1, iron_pickaxe: 1, diamond_sword: 1, diamond_pickaxe: 1, water_bucket: 2, iron_helmet: 1, iron_chestplate: 1, iron_leggings: 1, iron_boots: 1, diamond_helmet: 1, diamond_chestplate: 1, diamond_leggings: 1, diamond_boots: 1 }
    const r2 = await goal.decide(bot2, ctx2)
    assert.equal(r2.action, 'explore')
  })
})

describe('jr2.2 ground patches under floorless-house dips', () => {
  const AG = '11,63,24' // A foot ground
  const AGH = '12,63,24' // A head ground
  const BG = '14,63,24' // B foot ground
  const BGH = '15,63,24' // B head ground
  const STAGE_A = { x: A_FOOT.x, y: A_FOOT.y, z: A_FOOT.z + 2 }

  it('fillNeed counts loaded-missing grounds under unplaced beds only', () => {
    // Rig shape: A foot dipped, A head solid, B standing.
    const bot = mockBot({ cells: { [AG]: 'air', [cellKey(B_FOOT)]: 'white_bed', [cellKey(B_HEAD)]: 'white_bed' } })
    assert.equal(beds.fillNeed(bot, v2home()), 1)
    const both = mockBot({ cells: { [AG]: 'air', [AGH]: 'water', [BG]: 'short_grass', [BGH]: 'air' } })
    assert.equal(beds.fillNeed(both, v2home()), 4)
    assert.equal(beds.fillNeed(mockBot({ dark: true }), v2home()), 0, 'dark is unknown, not owed')
    assert.equal(beds.fillNeed(mockBot({}), null), 0)
    assert.equal(beds.fillNeed(mockBot({}), { v: 1, site: { x: 1, y: 2, z: 3 } }), 0)
    assert.equal(beds.fillNeed(mockBot({ cells: { [AG]: 'lava' } }), v2home()), 0, 'lava refuses, never patches')
  })

  it('needsFillGround: air-like, water, flora patch; solid and lava do not', () => {
    for (const n of ['air', 'cave_air', 'void_air', 'water', 'short_grass', 'poppy', null]) {
      assert.equal(beds.needsFillGround(n), true, n)
    }
    for (const n of ['dirt', 'grass_block', 'stone', 'oak_planks', 'lava']) {
      assert.equal(beds.needsFillGround(n), false, n)
    }
  })

  it('place without patch planks recovers from the chest, else fails loud', () => {
    const bot = mockBot({ items: [{ name: 'white_bed', count: 1 }], cells: { [AG]: 'air' }, at: STAGE_A })
    bot.world.set(cellKey(B_FOOT), 'white_bed')
    bot.world.set(cellKey(B_HEAD), 'white_bed')
    const ctx = { home: v2home(), beds: { phase: 'place', color: 'white' } }
    beds(bot, ctx)
    assert.equal(ctx.stepStatus, 'failed:no-planks', 'chestless world: gather feeds')
    assert.ok(!ctx.placeInFlight, 'no flight without patch planks')
  })

  it('patches the dip, then the bed lands and claims', async () => {
    const bot = mockBot({
      items: [{ name: 'white_bed', count: 1 }, { name: 'oak_planks', count: 1 }],
      cells: { [AG]: 'air' },
      at: STAGE_A,
    })
    bot.world.set(cellKey(B_FOOT), 'white_bed')
    bot.world.set(cellKey(B_HEAD), 'white_bed')
    const ctx = { home: v2home(), beds: { phase: 'place', color: 'white' } }
    beds(bot, ctx)
    await rest(1300)
    await flush()
    assert.equal(bot.world.get(AG), 'oak_planks', 'exactly one patch plank suffices')
    assert.deepEqual(bot.calls.equips.map((e) => e[0]), ['oak_planks', 'white_bed'], 'patch before bed')
    assert.equal(bot.world.get(cellKey(A_FOOT)), 'white_bed')
    assert.equal(bot.world.get(cellKey(A_HEAD)), 'white_bed')
    assert.ok(bot.chats.includes('my bed is in'))
  })

  it('patches take any wood, even off the bed color', async () => {
    const bot = mockBot({
      items: [{ name: 'white_bed', count: 1 }, { name: 'birch_planks', count: 3 }],
      cells: { [AG]: 'air' },
      at: STAGE_A,
    })
    bot.world.set(cellKey(B_FOOT), 'white_bed')
    bot.world.set(cellKey(B_HEAD), 'white_bed')
    const ctx = { home: v2home(), beds: { phase: 'place', color: 'white' } }
    beds(bot, ctx)
    await rest(1300)
    await flush()
    assert.equal(bot.world.get(AG), 'birch_planks')
    assert.ok(bot.chats.includes('my bed is in'))
  })

  it('a wall-less hole refuses loud, never places into the void', async () => {
    const bot = mockBot({
      items: [{ name: 'white_bed', count: 1 }, { name: 'oak_planks', count: 3 }],
      cells: { [AG]: 'air', [AGH]: 'air', '10,63,24': 'air', '11,63,23': 'air', '11,63,25': 'air', '11,62,24': 'air' },
      at: STAGE_A,
    })
    bot.world.set(cellKey(B_FOOT), 'white_bed')
    bot.world.set(cellKey(B_HEAD), 'white_bed')
    const ctx = { home: v2home(), beds: { phase: 'place', color: 'white' } }
    beds(bot, ctx)
    await rest(650)
    await flush()
    assert.equal(ctx.beds.fails, 1)
    assert.equal(bot.world.get(cellKey(A_FOOT)), undefined)
    assert.equal(bot.world.get(AG), 'air')
  })

  it('lava ground refuses loud, never patches', async () => {
    const bot = mockBot({
      items: [{ name: 'white_bed', count: 1 }, { name: 'oak_planks', count: 3 }],
      cells: { [AG]: 'lava' },
      at: STAGE_A,
    })
    bot.world.set(cellKey(B_FOOT), 'white_bed')
    bot.world.set(cellKey(B_HEAD), 'white_bed')
    const ctx = { home: v2home(), beds: { phase: 'place', color: 'white' } }
    beds(bot, ctx)
    await rest(650)
    await flush()
    assert.equal(ctx.beds.fails, 1)
    assert.equal(bot.world.get(cellKey(A_FOOT)), undefined)
  })

  it('a patch that does not take retries instead of placing over air', async () => {
    const bot = mockBot({
      items: [{ name: 'white_bed', count: 1 }, { name: 'oak_planks', count: 3 }],
      cells: { [AG]: 'air' },
      at: STAGE_A,
      placeImpl: () => {}, // jammed: the world never changes
    })
    bot.world.set(cellKey(B_FOOT), 'white_bed')
    bot.world.set(cellKey(B_HEAD), 'white_bed')
    const ctx = { home: v2home(), beds: { phase: 'place', color: 'white' } }
    beds(bot, ctx)
    await rest(650)
    await flush()
    assert.equal(ctx.beds.fails, 1)
    assert.equal(bot.world.get(cellKey(A_FOOT)), undefined)
  })

  it('stockpile keeps patch planks while dips are owed', () => {
    const one = mockBot({ items: [{ name: 'oak_planks', count: 10 }, ...LADDER_PICKS], cells: { [AG]: 'air' } })
    const planOne = stockpileMod.depositPlan(one, { home: v2home(), ...LADDER_DONE })
    assert.deepEqual(planOne.filter((p) => p.name === 'oak_planks'), [{ name: 'oak_planks', count: 3 }], '6 + 1 patch')
    const four = mockBot({ items: [{ name: 'oak_planks', count: 10 }, ...LADDER_PICKS], cells: { [AG]: 'air', [AGH]: 'air', [BG]: 'air', [BGH]: 'air' } })
    assert.deepEqual(stockpileMod.depositPlan(four, { home: v2home(), ...LADDER_DONE }).filter((p) => p.name === 'oak_planks'), [], '6 + 4 patches hold the stack')
  })
})

describe('jr2.2 plank reserve fills the top single wood first', () => {
  it('mixed pack: top wood kept, rest banked (gather gate agrees)', () => {
    // Revmux shape: 2 birch early + 50 oak keeps 6 oak (maxPlanks=6, gate
    // closed) — never 2+4 mixed (maxPlanks=4, gate open forever).
    const bot = mockBot({ items: [{ name: 'birch_planks', count: 2 }, { name: 'oak_planks', count: 50 }, ...LADDER_PICKS] })
    const plan = stockpileMod.depositPlan(bot, { home: v2home(), ...LADDER_DONE })
    const banked = {}
    for (const p of plan) if (p.name.endsWith('_planks')) banked[p.name] = p.count
    assert.deepEqual(banked, { birch_planks: 2, oak_planks: 44 })
    const short = mockBot({ items: [{ name: 'birch_planks', count: 2 }, { name: 'oak_planks', count: 4 }, ...LADDER_PICKS] })
    assert.deepEqual(stockpileMod.depositPlan(short, { home: v2home(), ...LADDER_DONE }).filter((p) => p.name.endsWith('_planks')), [], 'short pack: all 6 stay')
  })
})

describe('jr2.2 pack beds cover before wool is hunted', () => {
  it('pack beds covering every bedroom skip to place (reconnect)', () => {
    const bot = mockBot({ items: [{ name: 'white_bed', count: 2 }] })
    const ctx = { home: v2home() }
    beds(bot, ctx)
    assert.equal(ctx.beds.phase, 'craft')
    beds(bot, ctx)
    assert.equal(ctx.beds.phase, 'place')
    assert.equal(ctx.bring, undefined, 'no hunt for covered beds')
  })

  it('a plank-short second craft recovers planks, never re-hunts wool', async () => {
    const cells = { '15,64,21': 'crafting_table' }
    const bot = mockBot({
      items: [{ name: 'white_bed', count: 1 }, { name: 'white_wool', count: 3 }, { name: 'oak_planks', count: 2 }],
      cells, at: { x: 15, y: 64, z: 21 },
    })
    const ctx = { home: v2home(), beds: { phase: 'craft' } }
    for (let i = 0; i < 8 && !ctx.stepStatus; i++) {
      beds(bot, ctx)
      if (ctx.gearInFlight) await rest(650)
      await flush()
    }
    assert.equal(ctx.stepStatus, 'failed:no-planks')
    assert.equal(ctx.beds.phase, 'craft', 'wool covers the one craft left: never back to wool')
  })

  it('owing one bed hunts 3 wool, not 6', () => {
    const cells = { [cellKey(A_FOOT)]: 'white_bed', [cellKey(A_HEAD)]: 'white_bed' }
    const bot = mockBot({ items: [], cells })
    const ctx = { home: v2home(), beds: { phase: 'wool' } }
    beds(bot, ctx)
    assert.equal(ctx.bring.want, 3)
    const covered = mockBot({ items: [{ name: 'gray_wool', count: 3 }], cells })
    const ctx2 = { home: v2home(), beds: { phase: 'wool' } }
    beds(covered, ctx2)
    assert.equal(ctx2.beds.phase, 'craft', '3 of one color covers one bed')
    assert.equal(ctx2.bring, undefined)
  })

  it('a time-expired hunt fails instead of reopening', () => {
    const bot = mockBot({ items: [] })
    const ctx = { home: v2home(), beds: { phase: 'wool', hunt: { searchLegs: { legs: 9, timedOut: true } } } }
    beds(bot, ctx)
    assert.equal(ctx.stepStatus, 'failed:no-wool')
    assert.equal(ctx.bring, undefined)
  })
})

describe('jr2.2 done branch', () => {
  it('both standing: done with the completion chat', () => {
    const cells = { [cellKey(A_FOOT)]: 'white_bed', [cellKey(A_HEAD)]: 'white_bed', [cellKey(B_FOOT)]: 'white_bed', [cellKey(B_HEAD)]: 'white_bed' }
    const bot = mockBot({ items: [], cells })
    const ctx = { home: v2home() }
    beds(bot, ctx)
    assert.equal(ctx.stepStatus, 'done')
    assert.ok(bot.chats.includes('both beds are in'))
  })
})

describe('9qt0 sheep hunting: persistent latch, banked partials, string rung, near legs', () => {
  const fs = require('node:fs')
  const os = require('node:os')
  const path = require('node:path')
  const memory = require('../src/memory')
  const exploreMod = require('../src/behaviours/explore')
  const FACTS = { time: 'day', home: 'built', beds: 'none' }
  const F = (bot, ctx) => goal.MENU.beds.feasible(FACTS, bot, ctx)

  function failHunt(bot, ctx) {
    ctx.stepStatus = null
    ctx.bring = undefined
    ctx.beds.hunt = { searchLegs: { legs: 24 } }
    beds(bot, ctx)
    assert.equal(ctx.stepStatus, 'failed:no-wool')
  }

  it('acceptance: two failed hunts latch through death and restart until a sheep is sighted', () => {
    const bot = mockBot()
    const ctx = { home: v2home(), beds: { phase: 'wool' } }
    failHunt(bot, ctx)
    assert.equal(F(bot, ctx), true, 'one failure still retries')
    failHunt(bot, ctx)
    assert.equal(F(bot, ctx), false, 'second failure latches')
    bot.time.day = 6
    assert.equal(F(bot, ctx), false, 'a new MC day does not release (the 9kd hole)')
    // Death: ctx survives, the stepFail hold does not matter — still latched.
    ctx.bring = null
    assert.equal(F(bot, ctx), false, 'death keeps it')
    // Restart: a fresh ctx from disk.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), '9qt0-'))
    try {
      const file = path.join(dir, 'bot.json')
      assert.equal(memory.save(bot, ctx, file), true)
      const fresh = {}
      const out = memory.restore(bot, fresh, file)
      assert.equal(out.sheep, 1)
      assert.equal(F(bot, fresh), false, 'restart keeps it')
      // A sheep in sight right after the latch: still latched (unreachable-sheep loop cap).
      bot.entities[7] = { id: 7, name: 'sheep', position: pos(6, 65, 0) }
      assert.equal(F(bot, fresh), false, 'fresh latch ignores a sighting')
      fresh.beds.noWool.at -= beds.SIGHT_MIN_MS
      assert.equal(F(bot, fresh), true, 'sighting past the min age reopens')
      delete bot.entities[7]
      assert.equal(F(bot, fresh), false, 'no sheep: still latched')
      fresh.beds.noWool.at -= beds.LATCH_MS
      assert.equal(F(bot, fresh), true, 'expired after LATCH_MS')
      // The step's own tick reads the restored {noWool} without a phase.
      beds(bot, fresh) // shears tick: nothing to craft, on to wool
      beds(bot, fresh)
      assert.ok(fresh.bring && fresh.bring.self === 'beds', 'restored ctx hunts after expiry')
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('memory drops a malformed latch and clamps a future stamp', () => {
    const bot = mockBot()
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), '9qt0-'))
    try {
      const file = path.join(dir, 'bot.json')
      const now = Date.now()
      const world = memory.worldKey(bot)
      fs.writeFileSync(file, JSON.stringify({ v: 1, world, homes: [], sheep: { fails: 'x', at: now } }))
      const a = {}
      assert.equal(memory.restore(bot, a, file, now).sheep, 0)
      assert.equal(a.beds, undefined)
      fs.writeFileSync(file, JSON.stringify({ v: 1, world, homes: [], sheep: { fails: 2, at: now + 1e9 } }))
      const b = {}
      memory.restore(bot, b, file, now)
      assert.deepEqual(b.beds.noWool, { fails: 2, at: now })
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('acceptance: a partial 2 wool banks in the chest; a craft-ready colour and string stay', () => {
    const partial = mockBot({ items: [{ name: 'white_wool', count: 2 }, { name: 'string', count: 4 }, ...LADDER_PICKS] })
    const plan = stockpileMod.depositPlan(partial, { home: v2home(), ...LADDER_DONE })
    assert.deepEqual(plan.filter((p) => p.name.endsWith('_wool')), [{ name: 'white_wool', count: 2 }])
    assert.ok(!plan.some((p) => p.name === 'string'), 'string stays for the wool rung')
    const ready = mockBot({ items: [{ name: 'white_wool', count: 3 }, { name: 'gray_wool', count: 1 }, ...LADDER_PICKS] })
    const planR = stockpileMod.depositPlan(ready, { home: v2home(), ...LADDER_DONE })
    assert.ok(!planR.some((p) => p.name.endsWith('_wool')), 'a craft-ready colour keeps all wool')
  })

  it('acceptance: 12 string make the bed wool without a hunt, even when latched', async () => {
    // Bedroom A stands: one craft owed, 3 wool needed.
    const cells = { [cellKey(A_FOOT)]: 'white_bed', [cellKey(A_HEAD)]: 'white_bed' }
    const bot = mockBot({ items: [{ name: 'string', count: 12 }], cells })
    const ctx = { home: v2home(), beds: { phase: 'wool', noWool: { fails: 2, at: Date.now() } } }
    assert.equal(F(bot, ctx), true, 'string lifts the latch')
    for (let i = 0; i < 10 && ctx.beds.phase === 'wool'; i++) {
      beds(bot, ctx)
      if (ctx.gearInFlight) await rest(650)
      await flush()
    }
    assert.equal(ctx.bring, undefined, 'no hunt opened')
    assert.equal(ctx.beds.phase, 'craft')
    assert.equal(bot._items.filter((i) => i.name === 'white_wool').reduce((n, i) => n + i.count, 0), 3)
  })

  it('revmux 01: the second partial yields at once (no reopen) and banks its wool in the chest first', async () => {
    const CH = { x: 15, y: 64, z: 22 }
    const bot = mockBot({ items: [{ name: 'white_wool', count: 1, type: ITEMS.white_wool }], cells: { '15,64,22': 'chest' }, at: { x: 15, y: 64, z: 21 } })
    const chest = []
    bot.openChest = async () => ({
      containerItems: () => [],
      deposit: async (type, meta, n) => {
        const s = bot._items.find((i) => i.type === type)
        s.count -= n
        chest.push({ name: s.name, count: n })
        bot._items = bot._items.filter((i) => i.count > 0)
      },
      close: () => {},
    })
    const ctx = { home: v2home({ chest: { ...CH } }), beds: { phase: 'wool', huntWool: 0, noWool: { fails: 1, at: Date.now() }, hunt: { searchLegs: { legs: 4 } } } }
    bot._items[0].count = 2 // the hunt closed with 2 of 6
    beds(bot, ctx)
    assert.equal(ctx.beds.noWool.fails, 2)
    assert.equal(ctx.bring, undefined, 'latched: no third hunt')
    assert.equal(ctx.stepStatus, undefined, 'one chest pull first (empty chest)')
    await flush()
    beds(bot, ctx)
    assert.equal(ctx.stepStatus, undefined, 'banking next')
    await flush()
    assert.deepEqual(chest, [{ name: 'white_wool', count: 2 }], 'partial wool is in the chest')
    beds(bot, ctx)
    assert.equal(ctx.stepStatus, 'failed:no-wool')
    assert.equal(ctx.bring, undefined)
  })

  it('revmux 02 core-2: latched, banked chest wool still funds the bed (no sheep needed)', async () => {
    const bot = mockBot({ items: [{ name: 'white_wool', count: 1, type: ITEMS.white_wool }], cells: { '15,64,22': 'chest', [cellKey(A_FOOT)]: 'white_bed', [cellKey(A_HEAD)]: 'white_bed' }, at: { x: 15, y: 64, z: 21 } })
    const stacks = [{ name: 'white_wool', type: ITEMS.white_wool, metadata: 0, count: 2 }]
    bot.openChest = async () => ({
      containerItems: () => stacks,
      withdraw: async (type, meta, n) => { stacks[0].count -= n; bot._items.push({ name: 'white_wool', count: n, type }) },
      close: () => {},
    })
    const ctx = { home: v2home({ chest: { x: 15, y: 64, z: 22 } }), beds: { phase: 'wool', noWool: { fails: 2, at: Date.now() } } }
    beds(bot, ctx)
    await flush()
    beds(bot, ctx)
    assert.equal(ctx.beds.phase, 'craft', 'pack 1 + chest 2 covers one bed')
    assert.equal(ctx.stepStatus, undefined)
  })

  it('revmux 02 core-3: a stale failing flag (preempted bank walk) does not fail a fresh pick', () => {
    const bot = mockBot()
    const ctx = { home: v2home(), beds: { phase: 'wool', failing: Date.now() - 1 } }
    beds(bot, ctx)
    assert.equal(ctx.stepStatus, undefined)
    assert.ok(ctx.bring && ctx.bring.self === 'beds', 'the sighting-opened pick hunts')
  })

  it('revmux 02 core-1: a far pending explore leg is replaced by the near pick before a self search walks', async () => {
    const bot = mockBot({ at: { x: SITE.x, y: 64, z: SITE.z } })
    const far = { x: SITE.x, z: SITE.z - 128 }
    const o = bring.toWoolHunt(bot, { kind: 'item', name: 'wool', names: ['white_wool'], want: 3, by: null, drop: null, have: 0 })
    o.self = 'beds'
    const ctx = { home: v2home(), bring: o, explore: { visited: new Set(), target: { ...far } } }
    for (let i = 0; i < 4 && o.phase !== 'searchwalk'; i++) {
      await bring(bot, ctx)
      await flush()
    }
    assert.equal(o.phase, 'searchwalk', `phase ${o.phase}`)
    const t = ctx.explore.target
    assert.ok(t && Math.hypot(t.x - SITE.x, t.z - SITE.z) <= bring.SELF_SEARCH_RADIUS, `leg target ${JSON.stringify(t)}`)
  })

  it('revmux 01: string too short for the need does not open a latched hunt', async () => {
    const bot = mockBot({ items: [{ name: 'string', count: 4 }] }) // 1 wool of 6
    const ctx = { home: v2home(), beds: { phase: 'wool', noWool: { fails: 2, at: Date.now() } } }
    for (let i = 0; i < 10 && !ctx.stepStatus; i++) {
      beds(bot, ctx)
      if (ctx.gearInFlight) await rest(650)
      await flush()
    }
    assert.equal(ctx.stepStatus, 'failed:no-wool')
    assert.equal(ctx.bring, undefined, 'no sheepless hunt')
  })

  it('a failed string craft goes dry and hunts', () => {
    const bot = mockBot({ items: [{ name: 'string', count: 4 }], recipes: {} })
    const ctx = { home: v2home(), beds: { phase: 'wool' } }
    beds(bot, ctx)
    assert.equal(ctx.beds.stringDry, true)
    beds(bot, ctx)
    assert.ok(ctx.bring && ctx.bring.self === 'beds')
  })

  it('self search legs stay within SELF_SEARCH_RADIUS of home; a capped search fails the hunt', () => {
    const bot = mockBot()
    const ctx = { home: v2home() }
    assert.ok(exploreMod.nextTarget(bot, ctx, bring.SELF_SEARCH_RADIUS), 'fresh ground in reach')
    // Every spiral point within 96 already walked (prod: earlier hunts).
    const visited = new Set()
    for (const r of [16, 32, 64]) {
      for (let a = 0; a < 8; a++) {
        const x = Math.round(SITE.x + r * Math.sin(a * Math.PI / 4))
        const z = Math.round(SITE.z - r * Math.cos(a * Math.PI / 4))
        visited.add(`${Math.floor(x / 16)},${Math.floor(z / 16)}`)
      }
    }
    ctx.explore = { visited, target: null }
    assert.equal(exploreMod.nextTarget(bot, ctx, bring.SELF_SEARCH_RADIUS), null)
    assert.ok(exploreMod.nextTarget(bot, ctx, 256), 'the outer rings remain for owner orders')
    // revmux 01 core-4: a far pending leg does not read as capped while near ground is open.
    const c3 = { home: v2home(), explore: { visited: new Set(), target: { x: SITE.x, z: SITE.z - 128 } } }
    const near = exploreMod.nextTarget(bot, c3, bring.SELF_SEARCH_RADIUS)
    assert.ok(near && Math.hypot(near.x - SITE.x, near.z - SITE.z) <= 96, 'near pick wins over a far pending leg')
    const st = { phase: 'wool', hunt: { searchLegs: { legs: 1, capped: true } } }
    const c2 = { home: v2home(), beds: st }
    beds(bot, c2)
    assert.equal(c2.stepStatus, 'failed:no-wool', 'a capped search counts as a failed hunt')
    assert.equal(st.noWool.fails, 1)
  })
})
