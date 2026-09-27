'use strict'

// Furnace station (idkcraft-ipn.1): craft at the home table, place by the
// body, smelt raw iron on fuel above the light.js reserve, take ingots.

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const furnace = require('../src/behaviours/furnace')

const IDS = { furnace: 61, raw_iron: 100, coal: 101, charcoal: 102, cobblestone: 103 }

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
    async putInput(type, meta, count) {
      log.push(['putInput', type, count])
      const cur = this.slots[0]
      this.slots[0] = { name: 'raw_iron', count: (cur ? cur.count : 0) + count }
    },
    async putFuel(type, meta, count) {
      const name = type === IDS.charcoal ? 'charcoal' : 'coal'
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

describe('furnace fuel math (reserve never burns)', () => {
  it('loads ceil(ore/8) capped by spendable above the reserve', () => {
    assert.equal(furnace.fuelPieces(8, 6), 1)
    assert.equal(furnace.fuelPieces(9, 6), 2)
    assert.equal(furnace.fuelPieces(16, 6), 2)
    assert.equal(furnace.fuelPieces(17, 6), 2) // spendable caps, not need
    assert.equal(furnace.fuelPieces(64, 5), 1) // nearly all reserved
    assert.equal(furnace.fuelPieces(8, 4), 0) // reserve intact
    assert.equal(furnace.fuelPieces(8, 3), 0)
    assert.equal(furnace.fuelPieces(8, 0), 0)
    assert.equal(furnace.fuelPieces(0, 10), 0) // no ore, no fuel
  })

  it('imports the light.js reserve, never a local copy', () => {
    const light = require('../src/behaviours/light')
    assert.equal(furnace.COAL_RESERVE, light.COAL_RESERVE)
    assert.equal(furnace.COAL_RESERVE, 4)
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
    assert.deepEqual(ctx.home.furnace, { x: 1, y: 64, z: 0 })
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
    assert.deepEqual(ctx.home.furnace, { x: 1, y: 64, z: 0 }, 'fresh claim replaces the ghost')
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

describe('furnace smelt (load above reserve, take, settle)', () => {
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

  it('loads ore plus one coal for 8 ore, reserve untouched', async () => {
    const { bot, log } = smeltBot({
      inv: [{ name: 'raw_iron', count: 8 }, { name: 'coal', count: 6 }],
      slots: [null, null, null],
    })
    await tick(bot, smeltCtx())
    assert.ok(log.some(([op, , n]) => op === 'putInput' && n === 8), JSON.stringify(log))
    const fuels = log.filter(([op]) => op === 'putFuel')
    assert.equal(fuels.length, 1)
    assert.equal(fuels[0][2], 1, 'one piece above the reserve of 4')
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

  it('ore without spendable fuel fails no-fuel and loads no fuel', async () => {
    const { bot, log } = smeltBot({
      inv: [{ name: 'raw_iron', count: 8 }, { name: 'coal', count: 3 }],
      slots: [null, null, null],
    })
    const ctx = smeltCtx()
    await tick(bot, ctx)
    assert.equal(ctx.stepStatus, 'failed:no-fuel')
    assert.ok(!log.some(([op]) => op === 'putFuel'), JSON.stringify(log))
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

  it('burning input waits without taking', async () => {
    const { bot, log } = smeltBot({
      inv: [],
      slots: [{ name: 'raw_iron', count: 8 }, { name: 'coal', count: 1 }, null],
      progress: 0.5,
      fuel: 0.5,
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

  it('stale progress with dead fuel fails no-fuel, never stalls', async () => {
    // Core-2: progress sticks at its last fraction on a live window;
    // only the fuel level tells cold from burning.
    const { bot } = smeltBot({
      inv: [{ name: 'raw_iron', count: 8 }, { name: 'coal', count: 3 }],
      slots: [{ name: 'raw_iron', count: 8 }, null, null],
      progress: 0.5,
      fuel: 0,
    })
    const ctx = smeltCtx()
    await tick(bot, ctx)
    assert.equal(ctx.stepStatus, 'failed:no-fuel')
  })

  it('the burn in flight counts as a loaded piece', async () => {
    // Core-5: fuel ignites out of the slot, so fuelN reads 0 while a
    // piece burns — loading another would park coal past done.
    const { bot, log } = smeltBot({
      inv: [{ name: 'coal', count: 6 }],
      slots: [{ name: 'raw_iron', count: 8 }, null, null],
      progress: 0.3,
      fuel: 0.9,
    })
    await tick(bot, smeltCtx())
    assert.ok(!log.some(([op]) => op === 'putFuel'), `no parked extra: ${JSON.stringify(log)}`)
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
