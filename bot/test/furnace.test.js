'use strict'

// Furnace station (idkcraft-ipn.1): craft at the home table, place by the
// body, smelt raw iron on coal down to zero then planks (ipn.13), take ingots.

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const furnace = require('../src/behaviours/furnace')

const IDS = { furnace: 61, raw_iron: 100, coal: 101, charcoal: 102, cobblestone: 103, oak_planks: 104, sand: 105 }
const NAMES = Object.fromEntries(Object.entries(IDS).map(([n, id]) => [id, n]))

function mockWindow(slots, log) {
  return {
    slots,
    progress: 0, // live-like: property packets arrive as 0/0, never null
    fuel: 0,
    inputItem() { return this.slots[0] || null },
    fuelItem() { return this.slots[1] || null },
    outputItem() { return this.slots[2] || null },
    async takeOutput() {
      const it = this.slots[2]
      if (!it) throw new Error('empty output')
      this.slots[2] = null
      log.push(['takeOutput', it.count])
      return { ...it }
    },
    async takeInput() {
      const it = this.slots[0]
      if (!it) throw new Error('empty input')
      this.slots[0] = null
      log.push(['takeInput', it.name, it.count])
      return { ...it }
    },
    async putInput(type, meta, count) {
      log.push(['putInput', type, count])
      const cur = this.slots[0]
      this.slots[0] = { name: NAMES[type] || 'raw_iron', count: (cur ? cur.count : 0) + count }
    },
    async putFuel(type, meta, count) {
      const name = type === IDS.charcoal ? 'charcoal' : type === IDS.oak_planks ? 'oak_planks' : 'coal'
      const cur = this.slots[1]
      // transfer fidelity: one fuel kind per slot, else destination-full.
      if (cur && cur.name !== name) throw new Error('destination full')
      log.push(['putFuel', type, count])
      this.slots[1] = { name, count: (cur ? cur.count : 0) + count }
    },
  }
}

function mockBot({ at = { x: 0, y: 64, z: 0 }, inv = [], blocks = {}, window = null } = {}) {
  const calls = { crafts: [], places: [], equips: [], opens: 0, closes: 0, goals: [] }
  const store = new Map(Object.entries(blocks))
  const bot = {
    calls,
    entity: { position: { ...at } },
    registry: { itemsByName: Object.fromEntries(Object.entries(IDS).map(([n, id]) => [n, { id }])) },
    inventory: { items: () => inv },
    blockAt: (p) => {
      const k = `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`
      if (!store.has(k)) return null
      const name = store.get(k)
      return { name, position: { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) } }
    },
    recipesFor: () => [{ result: { count: 1 } }],
    craft: async (recipe, count, table) => {
      calls.crafts.push({ count, table: table ? table.name : null })
      const cob = inv.find((i) => i.name === 'cobblestone')
      if (cob) cob.count -= 8 * count
      inv.push({ name: 'furnace', count: 1 })
    },
    equip: async (item) => { calls.equips.push(item && item.name) },
    placeBlock: async () => {
      calls.places.push(true)
      // The furnace lands east of the feet (first neighbour scan hit).
      store.set(`${Math.floor(at.x) + 1},${Math.floor(at.y)},${Math.floor(at.z)}`, 'furnace')
    },
    pathfinder: {
      setGoal: (g) => { calls.goals.push(g && g.constructor && g.constructor.name) },
    },
    openFurnace: async () => { calls.opens++; return window },
    closeWindow: async () => { calls.closes++ },
    chat: () => {},
  }
  return bot
}

function floorBlocks(x0 = -2, x1 = 2, y = 63, z0 = -2, z1 = 2) {
  const m = {}
  for (let x = x0; x <= x1; x++) {
    for (let z = z0; z <= z1; z++) m[`${x},${y},${z}`] = 'dirt'
  }
  return m
}

const settle = async (n = 10) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)) }
const tick = async (bot, ctx) => { furnace(bot, ctx); await settle() }

describe('furnace fuel math (coal burns to zero, ipn.13)', () => {
  // light.js COAL_RESERVE is smelting's share: it keeps torches off the
  // last coal, so the furnace itself spends every piece (prod 10-09:
  // 32 ore + 3 coal smelted nothing while the reserve gated both).
  it('loads ceil(ore/8) capped by the coal on hand', () => {
    assert.equal(furnace.fuelPieces(8, 6), 1)
    assert.equal(furnace.fuelPieces(9, 6), 2)
    assert.equal(furnace.fuelPieces(64, 5), 5) // hand caps, not need
    assert.equal(furnace.fuelPieces(8, 4), 1)
    assert.equal(furnace.fuelPieces(8, 3), 1)
    assert.equal(furnace.fuelPieces(8, 0), 0)
    assert.equal(furnace.fuelPieces(0, 10), 0) // no ore, no fuel
  })

  it('planks burn 1.5 ore each', () => {
    assert.equal(furnace.fuelPieces(3, 64, furnace.ORE_PER_PLANK), 2)
    assert.equal(furnace.fuelPieces(32, 64, furnace.ORE_PER_PLANK), 22)
    assert.equal(furnace.fuelPieces(32, 5, furnace.ORE_PER_PLANK), 5)
  })
})

describe('furnace craft (table-only, xg9)', () => {
  const TABLE = { '10,64,10': 'crafting_table' }

  it('no cobble fails before touching the table', async () => {
    const bot = mockBot({ at: { x: 10, y: 64, z: 9 }, inv: [{ name: 'cobblestone', count: 7 }], blocks: TABLE })
    const ctx = { home: { table: { x: 10, y: 64, z: 10 } } }
    await tick(bot, ctx)
    assert.equal(ctx.stepStatus, 'failed:no-cobble')
    assert.deepEqual(bot.calls.crafts, [])
  })

  it('no table fails: the 2x2 window is never an option', async () => {
    const bot = mockBot({ inv: [{ name: 'cobblestone', count: 8 }] })
    await tick(bot, { home: {} })
    assert.deepEqual(bot.calls.crafts, [])
  })

  it('ghost table (mined claim) fails instead of walking to nothing', async () => {
    const bot = mockBot({ inv: [{ name: 'cobblestone', count: 8 }], blocks: {} })
    const ctx = { home: { table: { x: 10, y: 64, z: 10 } } }
    await tick(bot, ctx)
    assert.equal(ctx.stepStatus, 'failed:no-table')
    assert.deepEqual(bot.calls.crafts, [])
  })

  it('far table walks into reach first', async () => {
    const bot = mockBot({ at: { x: 0, y: 64, z: 0 }, inv: [{ name: 'cobblestone', count: 8 }], blocks: TABLE })
    const ctx = { home: { table: { x: 10, y: 64, z: 10 } } }
    await tick(bot, ctx)
    assert.deepEqual(bot.calls.goals, ['GoalNear'])
    assert.deepEqual(bot.calls.crafts, [])
  })

  it('crafts one furnace at the table, table block always passed', async () => {
    const bot = mockBot({ at: { x: 10, y: 64, z: 9 }, inv: [{ name: 'cobblestone', count: 8 }], blocks: TABLE })
    const ctx = { home: { table: { x: 10, y: 64, z: 10 } } }
    furnace(bot, ctx)
    furnace(bot, ctx) // second tick lands mid-flight: no double craft
    await settle()
    assert.equal(bot.calls.crafts.length, 1)
    assert.equal(bot.calls.crafts[0].table, 'crafting_table', 'never the 2x2 window')
    assert.ok(ctx.stepStatus !== 'failed:craft-furnace')
  })
})

describe('furnace place + claim', () => {
  it('places beside the body, holds the furnace (never the pickaxe), claims verified', async () => {
    const bot = mockBot({
      inv: [{ name: 'furnace', count: 1 }, { name: 'stone_pickaxe', count: 1 }],
      blocks: floorBlocks(),
    })
    const ctx = { home: {} }
    await tick(bot, ctx)
    assert.deepEqual(bot.calls.equips, ['furnace'])
    assert.equal(bot.calls.places.length, 1)
    assert.deepEqual({ x: ctx.home.furnace.x, y: ctx.home.furnace.y, z: ctx.home.furnace.z }, { x: 1, y: 64, z: 0 })
    assert.equal(typeof ctx.home.furnace.floored, 'function', 'Vec3 claim (h9z): readers blockAt() it')
  })

  it('unverified placement claims nothing and fails', async () => {
    const bot = mockBot({ inv: [{ name: 'furnace', count: 1 }], blocks: floorBlocks() })
    bot.placeBlock = async () => { bot.calls.places.push(true) } // lands nowhere
    const ctx = { home: {} }
    await tick(bot, ctx)
    assert.equal(ctx.stepStatus, 'failed:furnace-place')
    assert.equal(ctx.home.furnace, undefined)
  })

  it('no free neighbour fails no-spot', async () => {
    const bot = mockBot({ inv: [{ name: 'furnace', count: 1 }], blocks: {} }) // air below everywhere
    const ctx = { home: {} }
    await tick(bot, ctx)
    assert.equal(ctx.stepStatus, 'failed:no-spot')
    assert.deepEqual(bot.calls.places, [])
  })

  it('ghost claim retracts and rebuilds from the item', async () => {
    const bot = mockBot({ inv: [{ name: 'furnace', count: 1 }], blocks: { ...floorBlocks(), '50,64,50': 'air' } })
    const ctx = { home: { furnace: { x: 50, y: 64, z: 50 } } } // mined away: verified air
    await tick(bot, ctx)
    assert.equal(bot.calls.places.length, 1, 're-places')
    assert.deepEqual({ x: ctx.home.furnace.x, y: ctx.home.furnace.y, z: ctx.home.furnace.z }, { x: 1, y: 64, z: 0 }, 'fresh claim replaces the ghost')
  })

  it('unloaded claim waits instead of retracting', async () => {
    const bot = mockBot({ inv: [] }) // blocks: {} reads null everywhere
    const ctx = { home: { furnace: { x: 0, y: 64, z: 0 } } }
    await tick(bot, ctx)
    assert.deepEqual(ctx.home.furnace, { x: 0, y: 64, z: 0 }, 'null reads unloaded, never gone')
    assert.equal(ctx.stepStatus, undefined)
    assert.equal(bot.calls.opens, 0, 'no window on an unloaded block')
  })
})

describe('furnace smelt (load coal or planks, take, settle)', () => {
  const SPOT = { '0,64,1': 'furnace' }
  function smeltBot({ inv, slots, progress = 0, fuel = 0 }) {
    const log = []
    const win = mockWindow(slots, log)
    win.progress = progress
    win.fuel = fuel
    const bot = mockBot({ at: { x: 0, y: 64, z: 0 }, inv, blocks: { ...floorBlocks(), ...SPOT }, window: win })
    return { bot, log, win }
  }
  const smeltCtx = () => ({ home: { furnace: { x: 0, y: 64, z: 1 } } })

  it('loads ore plus one coal for 8 ore', async () => {
    const { bot, log } = smeltBot({
      inv: [{ name: 'raw_iron', count: 8 }, { name: 'coal', count: 6 }],
      slots: [null, null, null],
    })
    await tick(bot, smeltCtx())
    assert.ok(log.some(([op, , n]) => op === 'putInput' && n === 8), JSON.stringify(log))
    const fuels = log.filter(([op]) => op === 'putFuel')
    assert.equal(fuels.length, 1)
    assert.equal(fuels[0][2], 1, 'one coal for 8 ore')
  })

  it('charcoal tops up when coal runs out', async () => {
    const { bot, log } = smeltBot({
      inv: [{ name: 'raw_iron', count: 8 }, { name: 'charcoal', count: 6 }],
      slots: [null, null, null],
    })
    await tick(bot, smeltCtx())
    const fuels = log.filter(([op]) => op === 'putFuel')
    assert.equal(fuels.length, 1)
    assert.equal(fuels[0][1], 102, 'charcoal id')
    assert.equal(fuels[0][2], 1)
  })

  it('three coal (the old reserve) smelt now', async () => {
    const { bot, log } = smeltBot({
      inv: [{ name: 'raw_iron', count: 8 }, { name: 'coal', count: 3 }],
      slots: [null, null, null],
    })
    await tick(bot, smeltCtx())
    assert.deepEqual(log.filter(([op]) => op === 'putFuel'), [['putFuel', IDS.coal, 1]])
  })

  it('planks fuel the furnace once coal and charcoal are gone', async () => {
    const { bot, log, win } = smeltBot({
      inv: [{ name: 'raw_iron', count: 3 }, { name: 'oak_planks', count: 64 }],
      slots: [null, null, null],
    })
    const ctx = smeltCtx()
    await tick(bot, ctx)
    assert.ok(log.some(([op, id, n]) => op === 'putFuel' && id === IDS.oak_planks && n === 2), JSON.stringify(log))
    assert.ok(log.some(([op, id, n]) => op === 'putInput' && id === IDS.raw_iron && n === 3), JSON.stringify(log))
    // The burn completes: ore leaves the hands, ingots land in the output.
    bot.inventory.items = () => [{ name: 'oak_planks', count: 62 }]
    win.slots = [null, null, { name: 'iron_ingot', count: 3 }]
    const lines = []
    const orig = console.log
    console.log = (l) => lines.push(l)
    try { await tick(bot, ctx) } finally { console.log = orig }
    assert.equal(ctx.stepStatus, 'done')
    assert.ok(lines.includes('smelted 3 iron'), JSON.stringify(lines))
  })

  it('plank load never overfills the 64 fuel slot (01 minor)', async () => {
    const { bot, log } = smeltBot({
      inv: [{ name: 'raw_iron', count: 100 }, { name: 'oak_planks', count: 800 }],
      slots: [null, { name: 'oak_planks', count: 10 }, null],
    })
    const ctx = smeltCtx()
    await tick(bot, ctx)
    assert.deepEqual(log.filter(([op]) => op === 'putFuel'), [['putFuel', IDS.oak_planks, 54]])
    assert.equal(ctx.stepStatus, undefined)
  })

  it('coal on hand beats planks (coal first)', async () => {
    const { bot, log } = smeltBot({
      inv: [{ name: 'raw_iron', count: 3 }, { name: 'coal', count: 1 }, { name: 'oak_planks', count: 64 }],
      slots: [null, null, null],
    })
    await tick(bot, smeltCtx())
    assert.deepEqual(log.filter(([op]) => op === 'putFuel'), [['putFuel', IDS.coal, 1]])
  })

  it('a coal-held slot waits out planks (one kind per cycle)', async () => {
    const { bot, log } = smeltBot({
      inv: [{ name: 'raw_iron', count: 32 }, { name: 'oak_planks', count: 64 }],
      slots: [null, { name: 'coal', count: 1 }, null],
    })
    const ctx = smeltCtx()
    await tick(bot, ctx)
    assert.ok(!log.some(([op]) => op === 'putFuel'), JSON.stringify(log))
    assert.equal(ctx.stepStatus, undefined, 'still running, no throw')
  })

  it('ore without any fuel fails no-fuel after the grace', async () => {
    // Slots-only hunger: a drained slot with ore standing could still be
    // a burn in flight, so the verdict waits out one cook time.
    const { bot, log } = smeltBot({
      inv: [{ name: 'raw_iron', count: 8 }, { name: 'oak_planks', count: 0 }],
      slots: [null, null, null],
    })
    const ctx = smeltCtx()
    await tick(bot, ctx)
    assert.equal(ctx.stepStatus, undefined, 'grace covers the burn in flight')
    for (let i = 0; i < 15; i++) await tick(bot, ctx)
    assert.equal(ctx.stepStatus, 'failed:no-fuel')
    assert.ok(!log.some(([op]) => op === 'putFuel'), JSON.stringify(log))
  })

  it('output flow resets the hunger clock', async () => {
    // A take mid-grace proves the burn: idle restarts instead of failing.
    const { bot, win } = smeltBot({
      inv: [{ name: 'raw_iron', count: 8 }, { name: 'coal', count: 3 }],
      slots: [{ name: 'raw_iron', count: 8 }, null, null],
    })
    const ctx = smeltCtx()
    for (let i = 0; i < 5; i++) await tick(bot, ctx)
    win.slots[2] = { name: 'iron_ingot', count: 1 } // the flight lands
    await tick(bot, ctx)
    assert.equal(ctx.stepStatus, undefined)
    assert.equal(ctx.furnace.idleTicks, 0)
  })

  it('takes full output, logs smelted N iron, done when ore stands nowhere', async () => {
    const lines = []
    const origLog = console.log
    console.log = (l) => { lines.push(String(l)) }
    try {
      const { bot } = smeltBot({ inv: [], slots: [null, null, { name: 'iron_ingot', count: 8 }] })
      const ctx = smeltCtx()
      await tick(bot, ctx)
      assert.equal(ctx.stepStatus, 'done')
      assert.ok(lines.some((l) => l === 'smelted 8 iron'), lines.join(' | '))
    } finally {
      console.log = origLog
    }
  })

  it('loaded input waits without taking', async () => {
    const { bot, log } = smeltBot({
      inv: [],
      slots: [{ name: 'raw_iron', count: 8 }, { name: 'coal', count: 1 }, null],
    })
    const ctx = smeltCtx()
    await tick(bot, ctx)
    assert.ok(!log.some(([op]) => op === 'takeOutput'))
    assert.equal(ctx.stepStatus, undefined, 'still running')
  })

  it('output-idle input+fuel stalls out after the cap', async () => {
    const { bot } = smeltBot({
      inv: [],
      slots: [{ name: 'raw_iron', count: 8 }, { name: 'coal', count: 1 }, null],
    })
    const ctx = smeltCtx()
    for (let i = 0; i < 121; i++) await tick(bot, ctx)
    assert.equal(ctx.stepStatus, 'failed:smelt-stalled')
  })

  it('empty furnace and empty hands done silently', async () => {
    const lines = []
    const origLog = console.log
    console.log = (l) => { lines.push(String(l)) }
    try {
      const { bot } = smeltBot({ inv: [], slots: [null, null, null] })
      const ctx = smeltCtx()
      await tick(bot, ctx)
      assert.equal(ctx.stepStatus, 'done')
      assert.ok(!lines.some((l) => l.startsWith('smelted ')), lines.join(' | '))
    } finally {
      console.log = origLog
    }
  })

  it('one window stays open across wait ticks', async () => {
    const { bot } = smeltBot({
      inv: [],
      slots: [{ name: 'raw_iron', count: 8 }, { name: 'coal', count: 1 }, null],
      progress: 0.5,
    })
    const ctx = smeltCtx()
    await tick(bot, ctx)
    await tick(bot, ctx)
    await tick(bot, ctx)
    assert.equal(bot.calls.opens, 1, 'no open-per-tick listener leak')
    assert.equal(bot.calls.closes, 0, 'stays open while burning')
    assert.equal(ctx.stepStatus, undefined)
  })

  it('a first throwing cycle drops the window and retries running', async () => {
    const { bot, win } = smeltBot({
      inv: [{ name: 'raw_iron', count: 8 }, { name: 'coal', count: 6 }],
      slots: [null, null, null],
    })
    let throws = 1
    const realPut = win.putInput.bind(win)
    win.putInput = async (...a) => { if (throws-- > 0) throw new Error('slot jam'); return realPut(...a) }
    const ctx = smeltCtx()
    await tick(bot, ctx)
    assert.equal(ctx.stepStatus, undefined, 'transient error retries')
    assert.equal(bot.calls.closes, 1, 'dropped window closed')
    await tick(bot, ctx)
    assert.equal(bot.calls.opens, 2, 'fresh window next tick')
    assert.equal(ctx.stepStatus, undefined)
  })

  it('two throwing cycles in a row fail furnace-window', async () => {
    const { bot, win } = smeltBot({
      inv: [{ name: 'raw_iron', count: 8 }, { name: 'coal', count: 6 }],
      slots: [null, null, null],
    })
    win.putInput = async () => { throw new Error('slot jam') }
    const ctx = smeltCtx()
    await tick(bot, ctx)
    assert.equal(ctx.stepStatus, undefined)
    await tick(bot, ctx)
    assert.equal(ctx.stepStatus, 'failed:furnace-window')
  })

  it('done closes the window; terminal states run no more ops', async () => {
    const { bot } = smeltBot({ inv: [], slots: [null, null, { name: 'iron_ingot', count: 8 }] })
    const ctx = smeltCtx()
    await tick(bot, ctx)
    assert.equal(ctx.stepStatus, 'done')
    assert.equal(bot.calls.closes, 1)
    const opens = bot.calls.opens
    await tick(bot, ctx)
    await tick(bot, ctx)
    assert.equal(bot.calls.opens, opens, 'no second smelted line, no reopen')
  })

  it('mixed fuel never collides: coal-held slot waits out charcoal', async () => {
    // Core-1: the slot holds coal, hands hold charcoal — loading now
    // would throw destination-full, so the cycle waits for burn-down.
    const { bot, log, win } = smeltBot({
      inv: [{ name: 'raw_iron', count: 8 }, { name: 'charcoal', count: 6 }],
      slots: [null, { name: 'coal', count: 2 }, null],
    })
    const ctx = smeltCtx()
    await tick(bot, ctx)
    assert.ok(!log.some(([op]) => op === 'putFuel'), JSON.stringify(log))
    assert.equal(ctx.stepStatus, undefined, 'still running, no throw')
    await assert.rejects(win.putFuel(IDS.charcoal, null, 1), /destination full/, 'mock keeps transfer fidelity')
  })

  it('empty slot takes the single kind that covers the need', async () => {
    // Core-1 main case: 64 ore wants 8 pieces; 2 coal cannot cover it
    // alone, so charcoal goes in whole — never coal-then-charcoal.
    const { bot, log } = smeltBot({
      inv: [{ name: 'raw_iron', count: 64 }, { name: 'coal', count: 2 }, { name: 'charcoal', count: 10 }],
      slots: [null, null, null],
    })
    await tick(bot, smeltCtx())
    const fuels = log.filter(([op]) => op === 'putFuel')
    assert.equal(fuels.length, 1)
    assert.equal(fuels[0][1], 102, 'charcoal covers the need whole')
    assert.equal(fuels[0][2], 8)
  })

  it('a cold drained slot fails hungry, never stalled', async () => {
    // Stall needs fuel standing in the slot doing nothing; an empty
    // slot with fuelless hands is hunger whatever the idle count.
    const { bot } = smeltBot({
      inv: [{ name: 'raw_iron', count: 8 }],
      slots: [{ name: 'raw_iron', count: 8 }, null, null],
    })
    const ctx = smeltCtx()
    for (let i = 0; i < 130; i++) {
      await tick(bot, ctx)
      if (ctx.stepStatus) break
    }
    assert.equal(ctx.stepStatus, 'failed:no-fuel')
  })

  it('a recent take discounts one fuel piece until the grace lapses', async () => {
    // Core-5 slots-only: output flowed, so a burn is likely in flight
    // and its piece counts; past the grace a cold furnace reloads.
    const { bot, log, win } = smeltBot({
      inv: [{ name: 'coal', count: 6 }],
      slots: [{ name: 'raw_iron', count: 8 }, null, { name: 'iron_ingot', count: 2 }],
    })
    const ctx = smeltCtx()
    await tick(bot, ctx) // take proves the burn
    assert.ok(!log.some(([op]) => op === 'putFuel'), `no parked extra: ${JSON.stringify(log)}`)
    for (let i = 0; i < 15; i++) await tick(bot, ctx) // grace lapses, still cold
    assert.ok(log.some(([op]) => op === 'putFuel'), `cold furnace reloads: ${JSON.stringify(log)}`)
    assert.equal(ctx.stepStatus, undefined)
  })

  it('unreachable table fails after 20 walk ticks', async () => {
    const bot = mockBot({ at: { x: 0, y: 64, z: 0 }, inv: [{ name: 'cobblestone', count: 8 }], blocks: { '10,64,10': 'crafting_table' } })
    const ctx = { home: { table: { x: 10, y: 64, z: 10 } } }
    for (let i = 0; i < 21; i++) await tick(bot, ctx)
    assert.equal(ctx.stepStatus, 'failed:table-unreachable')
  })

  it('unreachable furnace fails after 20 walk ticks', async () => {
    const bot = mockBot({ at: { x: 0, y: 64, z: 0 }, blocks: { '50,64,0': 'furnace' } })
    const ctx = { home: { furnace: { x: 50, y: 64, z: 0 } } }
    for (let i = 0; i < 21; i++) await tick(bot, ctx)
    assert.equal(ctx.stepStatus, 'failed:furnace-unreachable')
  })

  it('a settled run never resumes spent', async () => {
    // Core-4: stall-fail leaves idleTicks at cap and smelted counted;
    // the next pick starts fresh counters, not an instant fail.
    const { bot } = smeltBot({
      inv: [],
      slots: [{ name: 'raw_iron', count: 8 }, { name: 'coal', count: 1 }, null],
    })
    const ctx = smeltCtx()
    for (let i = 0; i < 121; i++) await tick(bot, ctx)
    assert.equal(ctx.stepStatus, 'failed:smelt-stalled')
    ctx.stepStatus = 'running' // next pick
    await tick(bot, ctx)
    assert.equal(ctx.stepStatus, 'running', 'no instant fail on fresh counters')
    assert.equal(ctx.furnace.idleTicks, 1)
  })

  it('one smelt op per tick: concurrent ticks open once', async () => {
    const { bot } = smeltBot({
      inv: [{ name: 'raw_iron', count: 8 }, { name: 'coal', count: 6 }],
      slots: [null, null, null],
    })
    const ctx = smeltCtx()
    furnace(bot, ctx)
    furnace(bot, ctx)
    await settle()
    assert.equal(bot.calls.opens, 1)
  })
})

describe('furnace slice-C contract (result + readiness)', () => {
  it('done stamps result, and the next run resets it', async () => {
    const bot = mockBot({ inv: [], blocks: { '0,64,1': 'furnace' } })
    const win = mockWindow([null, null, { name: 'iron_ingot', count: 2 }], [])
    bot.openFurnace = async () => win
    const ctx = { home: { furnace: { x: 0, y: 64, z: 1 } } }
    await tick(bot, ctx)
    assert.equal(ctx.stepStatus, 'done')
    assert.equal(ctx.furnace.result, 'done')
    ctx.stepStatus = 'running' // gear re-picks
    bot.openFurnace = async () => { throw new Error('no reopen yet') }
    await tick(bot, ctx)
    assert.equal(ctx.furnace.result, null, 'fresh run, no stale outcome')
  })

  it('failures stamp failed:<reason> next to stepStatus', async () => {
    const bot = mockBot({ inv: [{ name: 'cobblestone', count: 1 }] })
    const ctx = { home: {} }
    await tick(bot, ctx)
    assert.equal(ctx.stepStatus, 'failed:no-cobble')
    assert.equal(ctx.furnace.result, 'failed:no-cobble')
  })

  it('furnaceReady verifies, retracts ghosts, keeps unloaded', () => {
    const standing = mockBot({ blocks: { '0,64,1': 'furnace' } })
    assert.deepEqual(
      furnace.furnaceReady(standing, { home: { furnace: { x: 0, y: 64, z: 1 } } }),
      { x: 0, y: 64, z: 1 })
    const ghostCtx = { home: { furnace: { x: 5, y: 64, z: 5 } } }
    assert.equal(furnace.furnaceReady(mockBot({ blocks: { '5,64,5': 'air' } }), ghostCtx), null)
    assert.equal(ghostCtx.home.furnace, undefined, 'ghost retracted')
    const darkCtx = { home: { furnace: { x: 5, y: 64, z: 5 } } }
    assert.deepEqual(furnace.furnaceReady(mockBot({}), darkCtx), { x: 5, y: 64, z: 5 })
    assert.deepEqual(darkCtx.home.furnace, { x: 5, y: 64, z: 5 }, 'unloaded kept')
  })
})

describe('furnace smelt job (g0z.36: sand -> glass)', () => {
  const SPOT = { '0,64,1': 'furnace' }
  function jobBot(inv, slots = [null, null, null]) {
    const log = []
    const win = mockWindow(slots, log)
    const bot = mockBot({ at: { x: 0, y: 64, z: 0 }, inv, blocks: { ...floorBlocks(), ...SPOT }, window: win })
    return { bot, log, win }
  }
  const SAND = { input: 'sand', output: 'glass' }
  const sandCtx = () => ({ home: { furnace: { x: 0, y: 64, z: 1 } } })
  // The caller's contract: set the job before every tick of its leg.
  const tick = async (bot, ctx) => { ctx.furnaceJob = SAND; furnace(bot, ctx); await settle() }
  const sum = (log, op, id) => log.filter((e) => e[0] === op && e[1] === id).reduce((a, e) => a + e[2], 0)

  it('the default job stays iron', async () => {
    const { bot } = jobBot([{ name: 'raw_iron', count: 8 }, { name: 'coal', count: 1 }])
    const ctx = { home: { furnace: { x: 0, y: 64, z: 1 } } }
    furnace(bot, ctx) // no job set: iron
    await settle()
    assert.deepEqual(ctx.furnace.job, { input: 'raw_iron', output: 'iron_ingot' })
  })

  it('18 sand + 3 coal: 3 coal, 18 sand in, glass taken, done', async () => {
    const { bot, log, win } = jobBot([{ name: 'sand', count: 18 }, { name: 'coal', count: 3 }, { name: 'raw_iron', count: 5 }])
    const ctx = sandCtx()
    await tick(bot, ctx)
    assert.equal(sum(log, 'putInput', IDS.sand), 18, JSON.stringify(log))
    assert.equal(sum(log, 'putInput', IDS.raw_iron), 0, 'iron in the bag stays put')
    assert.equal(sum(log, 'putFuel', IDS.coal), 3)
    assert.equal(ctx.stepStatus, undefined)
    // The burn completes: the sand cooked, glass sits in the output.
    bot.inventory.items = () => [{ name: 'raw_iron', count: 5 }]
    win.slots = [null, null, { name: 'glass', count: 18 }]
    const lines = []
    const orig = console.log
    console.log = (l) => lines.push(l)
    try { await tick(bot, ctx) } finally { console.log = orig }
    assert.ok(log.some(([op, n]) => op === 'takeOutput' && n === 18))
    assert.equal(ctx.stepStatus, undefined, 'a caller job reports on the result only (g0z.38)')
    assert.equal(ctx.furnace.result, 'done')
    assert.ok(lines.includes('smelted 18 glass'), JSON.stringify(lines))
  })

  it('18 sand + 12 planks, no coal: planks fuel it', async () => {
    const { bot, log } = jobBot([{ name: 'sand', count: 18 }, { name: 'oak_planks', count: 12 }])
    await tick(bot, sandCtx())
    assert.deepEqual(log.filter(([op]) => op === 'putFuel'), [['putFuel', IDS.oak_planks, 12]])
    assert.equal(sum(log, 'putInput', IDS.sand), 18)
  })

  it('18 sand + nothing burnable fails no-fuel after the grace', async () => {
    const { bot, log } = jobBot([{ name: 'sand', count: 18 }])
    const ctx = sandCtx()
    await tick(bot, ctx)
    assert.equal(ctx.stepStatus, undefined)
    for (let i = 0; i < 15; i++) await tick(bot, ctx)
    assert.equal(ctx.furnace.result, 'failed:no-fuel')
    assert.equal(ctx.stepStatus, undefined)
    assert.ok(!log.some(([op]) => op === 'putFuel'))
  })

  it('done when no sand stands anywhere', async () => {
    const { bot } = jobBot([{ name: 'raw_iron', count: 8 }, { name: 'coal', count: 3 }])
    const ctx = sandCtx()
    await tick(bot, ctx)
    assert.equal(ctx.furnace.result, 'done', 'iron in the bag is not this job')
  })

  // g0z.38 (revmux 01): the window cycle settles after driveLeg returned
  // and restored the caller's status — the caller's step must not end.
  it('through gear.driveFurnace: the async settle never writes the caller stepStatus', async () => {
    const gear = require('../src/behaviours/gear')
    const { bot, win } = jobBot([{ name: 'sand', count: 18 }, { name: 'coal', count: 3 }])
    const ctx = { ...sandCtx(), stepStatus: 'running' }
    ctx.furnaceJob = SAND
    assert.equal(gear.driveFurnace(bot, ctx, furnace), null)
    await settle()
    bot.inventory.items = () => []
    win.slots = [null, null, { name: 'glass', count: 18 }]
    ctx.furnaceJob = SAND
    assert.equal(gear.driveFurnace(bot, ctx, furnace), null, 'the window op is in flight')
    await settle()
    assert.equal(ctx.stepStatus, 'running')
    assert.equal(ctx.furnace.result, 'done')
    assert.equal(ctx.furnace.settled, true)
  })
})

describe('furnace at a castle home (g0z.36: kitchen corner)', () => {
  const residence = require('../src/residence')
  const castle = require('../src/castle')
  const site = { x: 100, y: 64, z: -50 }
  const rel = (home, c) => {
    const r = castle.rotatePlan([{ ...c, kind: 'air' }], home.rot, 2)[0]
    return { x: site.x + r.dx, y: site.y + r.dy, z: site.z + r.dz }
  }
  const k = (p) => `${p.x},${p.y},${p.z}`

  for (const rot of [0, 1]) {
    it(`rot ${rot}: crafts at the storeroom table, places at the rotated (12,0,18), claims verified`, async () => {
      const home = residence.castleHome({ site, rot, blueprintVersion: 2 })
      const table = residence.CASTLE.table(home)
      const corner = rel(home, { dx: 12, dy: 0, dz: 18 })
      const stand = rel(home, { dx: 14, dy: 0, dz: 18 })
      const blocks = { [k(table)]: 'crafting_table' }
      for (const [dx, dz] of [[12, 18], [13, 18], [12, 17], [14, 18]]) {
        const c = rel(home, { dx, dy: 0, dz })
        blocks[k(c)] = 'air'
        blocks[k({ ...c, y: c.y - 1 })] = 'stone'
      }
      const inv = [{ name: 'cobblestone', count: 8 }]
      const bot = mockBot({ at: stand, inv, blocks })
      let placed = null
      bot.placeBlock = async (ref, face) => {
        placed = { x: ref.position.x + face.x, y: ref.position.y + face.y, z: ref.position.z + face.z }
        const store = bot.blockAt
        bot.blockAt = (p) => (k({ x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) }) === k(placed) ? { name: 'furnace', position: placed } : store(p))
      }
      const ctx = { home }
      await tick(bot, ctx)
      assert.equal(bot.calls.crafts.length, 1, `crafted at the castle table: ${ctx.stepStatus}`)
      assert.equal(bot.calls.crafts[0].table, 'crafting_table')
      assert.equal(home.furnace, undefined)
      await tick(bot, ctx)
      assert.deepEqual(placed, corner)
      assert.deepEqual(k(home.furnace), k(corner))
    })
  }

  it('an unverified castle placement claims nothing', async () => {
    const home = residence.castleHome({ site, rot: 0, blueprintVersion: 2 })
    const corner = rel(home, { dx: 12, dy: 0, dz: 18 })
    const bot = mockBot({ at: corner, inv: [{ name: 'furnace', count: 1 }], blocks: { [k(corner)]: 'air', [k({ ...corner, y: corner.y - 1 })]: 'stone' } })
    bot.placeBlock = async () => {}
    const ctx = { home }
    await tick(bot, ctx)
    assert.equal(ctx.stepStatus, 'failed:furnace-place')
    assert.equal(home.furnace, undefined)
  })

  it('a standing furnace at a kitchen cell adopts on sight', () => {
    const home = residence.castleHome({ site, rot: 2, blueprintVersion: 2 })
    const c = rel(home, { dx: 13, dy: 0, dz: 18 })
    const got = furnace.furnaceReady(mockBot({ blocks: { [k(c)]: 'furnace' } }), { home })
    assert.deepEqual(k(got), k(c))
  })
})

describe('furnace job hygiene (g0z.36 01-review)', () => {
  const SPOT = { '0,64,1': 'furnace' }
  const SAND = { input: 'sand', output: 'glass' }
  function jobBot(inv, slots) {
    const log = []
    const win = mockWindow(slots, log)
    const bot = mockBot({ at: { x: 0, y: 64, z: 0 }, inv, blocks: { ...floorBlocks(), ...SPOT }, window: win })
    return { bot, log, win }
  }
  const ctx0 = () => ({ home: { furnace: { x: 0, y: 64, z: 1 } } })

  it('the job is consumed per tick: it never leaks into the next (iron) tick', async () => {
    const { bot } = jobBot([{ name: 'raw_iron', count: 8 }, { name: 'coal', count: 1 }], [null, null, null])
    const ctx = ctx0()
    ctx.furnaceJob = SAND
    furnace(bot, ctx)
    assert.equal(ctx.furnaceJob, null)
    await settle()
    assert.equal(ctx.furnace.result, 'done', 'no sand: the sand run is done')
    await tick(bot, ctx)
    assert.deepEqual(ctx.furnace.job, { input: 'raw_iron', output: 'iron_ingot' })
  })

  it('an unsettled run of another job restarts fresh', async () => {
    const { bot } = jobBot([{ name: 'raw_iron', count: 8 }, { name: 'coal', count: 3 }], [null, null, null])
    const ctx = ctx0()
    await tick(bot, ctx) // iron run, unsettled
    assert.equal(ctx.furnace.job.input, 'raw_iron')
    ctx.furnaceJob = SAND
    furnace(bot, ctx)
    await settle()
    assert.equal(ctx.furnace.job.input, 'sand')
  })

  it('another job\'s input is handed back before loading', async () => {
    const { bot, log } = jobBot([{ name: 'raw_iron', count: 8 }, { name: 'coal', count: 1 }], [{ name: 'sand', count: 18 }, null, null])
    const ctx = ctx0()
    await tick(bot, ctx)
    assert.deepEqual(log[0], ['takeInput', 'sand', 18])
    assert.ok(log.some(([op, id, n]) => op === 'putInput' && id === IDS.raw_iron && n === 8), JSON.stringify(log))
    assert.equal(ctx.stepStatus, undefined)
  })

  it('another job\'s output is cleared, never counted', async () => {
    const { bot, log } = jobBot([], [null, null, { name: 'iron_ingot', count: 4 }])
    const ctx = ctx0()
    const lines = []
    const orig = console.log
    console.log = (l) => lines.push(l)
    try { ctx.furnaceJob = SAND; furnace(bot, ctx); await settle() } finally { console.log = orig }
    assert.ok(log.some(([op]) => op === 'takeOutput'))
    assert.equal(ctx.furnace.smelted, 0)
    assert.equal(ctx.furnace.result, 'done')
    assert.ok(!lines.some((l) => String(l).startsWith('smelted ')), JSON.stringify(lines))
  })

  it('gear.tableBlock sees the castle storeroom table (no claim)', () => {
    const residence = require('../src/residence')
    const gear = require('../src/behaviours/gear')
    const home = residence.castleHome({ site: { x: 100, y: 64, z: -50 }, rot: 3, blueprintVersion: 2 })
    const t = residence.CASTLE.table(home)
    const bot = mockBot({ blocks: { [`${t.x},${t.y},${t.z}`]: 'crafting_table' } })
    const st = gear.tableBlock(bot, { home })
    assert.ok(st, 'castle table found')
    assert.deepEqual([st.pos.x, st.pos.y, st.pos.z], [t.x, t.y, t.z])
    assert.equal(gear.tableBlock(mockBot({}), { home }), null, 'nothing standing: null')
  })
})
