'use strict'

// idkcraft-vmzq.39: store valuables in chests, build new storage when full.
// Deposit caps (stone/tools/coal) and the castle-site store/new-chest
// decisions — pure scans, no windows.

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const stockpile = require('../src/behaviours/stockpile')

function pos(x, y, z) {
  return {
    x, y, z,
    distanceTo: (q) => Math.hypot(x - q.x, y - q.y, z - q.z),
    clone() { return pos(x, y, z) },
    floored() { return { x: Math.floor(x), y: Math.floor(y), z: Math.floor(z) } },
  }
}

function mockBot({ inv = [], cells = {}, at = null, chests = [] } = {}) {
  const w = { ...cells }
  const nameAt = (x, y, z) => w[`${x},${y},${z}`] || (y < 64 ? 'dirt' : 'air')
  const pathfinder = { goals: [], moving: false, setGoal(g) { this.goals.push(g) }, isMoving: () => pathfinder.moving }
  return {
    inv,
    entity: { position: at || pos(0, 64, 0) },
    registry: { blocksByName: { chest: { id: 7 } } },
    inventory: { items: () => inv },
    blockAt: (p) => ({
      name: nameAt(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)),
      boundingBox: 'block',
      position: pos(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)),
    }),
    findBlocks: () => chests,
    pathfinder,
    world: { getBlock: () => null }, // GoalPlaceBlock reads one block at construct
  }
}

const SITE = { x: 100, y: 64, z: 200 }
function siteCtx(over = {}) {
  return {
    castle: { site: { ...SITE }, rot: 0, blueprintVersion: 1, phase: 'body', ...over.castle },
    home: { site: { x: 0, y: 64, z: 0 }, built: true, ...over.home },
    ...over.ctx,
  }
}

describe('vmzq.39 deposit caps', () => {
  it('banks quarry stone past the ceiling, keep-first across variants', () => {
    const bot = mockBot({ inv: [{ name: 'granite', count: 60 }, { name: 'diorite', count: 40 }] })
    const plan = stockpile.depositPlan(bot, siteCtx())
    assert.deepEqual(plan, [{ name: 'diorite', count: 12 }])
    assert.equal(stockpile.STONE_KEEP, 88)
  })

  it('banks duplicate tools, keeps one per name', () => {
    const bot = mockBot({ inv: [{ name: 'stone_pickaxe', count: 1 }, { name: 'stone_pickaxe', count: 1 }] })
    assert.deepEqual(stockpile.depositPlan(bot, {}), [{ name: 'stone_pickaxe', count: 1 }])
  })

  it('banks coal past one stack, keeps torches', () => {
    const bot = mockBot({ inv: [{ name: 'coal', count: 80 }, { name: 'torch', count: 10 }] })
    assert.deepEqual(stockpile.depositPlan(bot, {}), [{ name: 'coal', count: 16 }])
  })

  it('a lone owner sword still banks through the finished allowance', () => {
    const bot = mockBot({ inv: [{ name: 'iron_sword', count: 1 }] })
    const ctx = { gearFinished: { iron_sword: 1 } }
    assert.deepEqual(stockpile.depositPlan(bot, ctx), [{ name: 'iron_sword', count: 1 }])
  })
})

describe('vmzq.39 siteMode', () => {
  it('true at the site with no home, false with no castle', () => {
    const atSite = mockBot({ at: pos(105, 64, 205) })
    assert.equal(stockpile.siteMode(atSite, { castle: siteCtx().castle }), true)
    assert.equal(stockpile.siteMode(atSite, {}), false)
  })

  it('home near wins, home far yields to the site', () => {
    const nearHome = mockBot({ at: pos(2, 64, 2) })
    const farCtx = siteCtx({ home: { site: { x: 500, y: 64, z: 500 }, built: true } })
    // Near home but far from the site: home mode.
    assert.equal(stockpile.siteMode(nearHome, siteCtx()), false)
    // At the site, home 500 off: site mode.
    const atSite = mockBot({ at: pos(105, 64, 205) })
    assert.equal(stockpile.siteMode(atSite, farCtx), true)
  })

  it('a parked site yields', () => {
    const atSite = mockBot({ at: pos(105, 64, 205) })
    const ctx = siteCtx({ castle: { siteChest: { x: 90, y: 64, z: 190 } }, ctx: { siteChestFullAt: Date.now() } })
    assert.equal(stockpile.siteMode(atSite, ctx), false)
  })
})

describe('vmzq.39 findSiteChest', () => {
  it('adopts a chest outside the footprint, ignores the footprint and the door path', () => {
    // v1 site x100..110 z200..210, entrance (105,64,201), door path north.
    const outside = { x: 95, y: 64, z: 205 }
    const inside = { x: 105, y: 64, z: 205 }
    const onPath = { x: 105, y: 64, z: 198 }
    const bot = mockBot({ at: pos(105, 64, 205), chests: [inside, onPath, outside] })
    assert.deepEqual(stockpile.findSiteChest(bot, siteCtx()), outside)
  })

  it('null with no chest or no castle', () => {
    const bot = mockBot({ at: pos(105, 64, 205), chests: [] })
    assert.equal(stockpile.findSiteChest(bot, siteCtx()), null)
    assert.equal(stockpile.findSiteChest(bot, {}), null)
  })
})

describe('vmzq.39 siteChestTodo', () => {
  it('store when adopted, adopt when standing, place when funded, none when not', () => {
    const atSite = pos(105, 64, 205)
    const adopted = siteCtx({ castle: { siteChest: { x: 95, y: 64, z: 205 } } })
    assert.equal(stockpile.siteChestTodo(mockBot({ at: atSite }), adopted), 'store')
    const standing = mockBot({ at: atSite, chests: [{ x: 95, y: 64, z: 205 }] })
    assert.equal(stockpile.siteChestTodo(standing, siteCtx()), 'adopt')
    // Place needs a chest item (or 8 planks) and a stow-ring spot; the
    // default mock world is all dirt below y64, air above — room.
    const funded = mockBot({ at: atSite, inv: [{ name: 'chest', count: 1 }] })
    assert.equal(stockpile.siteChestTodo(funded, siteCtx()), 'place')
    const poor = mockBot({ at: atSite, inv: [{ name: 'oak_planks', count: 7 }] })
    assert.equal(stockpile.siteChestTodo(poor, siteCtx()), 'none')
  })
})

describe('vmzq.39 doubleSpot', () => {
  it('picks the first open side, skips chests and solids', () => {
    const chest = { x: 95, y: 64, z: 205 }
    const bot = mockBot({
      at: pos(95, 64, 205),
      cells: { '96,64,205': 'chest', '94,64,205': 'stone', '95,64,206': 'air' },
    })
    assert.deepEqual(stockpile.doubleSpot(bot, siteCtx(), chest), { x: 95, y: 64, z: 206 })
  })

  it('null when every side is doubled or blocked', () => {
    const chest = { x: 95, y: 64, z: 205 }
    const bot = mockBot({
      at: pos(95, 64, 205),
      cells: {
        '96,64,205': 'chest', '94,64,205': 'stone',
        '95,64,206': 'stone', '95,64,204': 'chest',
      },
    })
    assert.equal(stockpile.doubleSpot(bot, siteCtx(), chest), null)
  })

  it('never doubles into the footprint', () => {
    // Chest just outside the west edge; its east neighbour is in.
    const chest = { x: 99, y: 64, z: 205 }
    const bot = mockBot({ at: pos(99, 64, 205) })
    const spot = stockpile.doubleSpot(bot, siteCtx(), chest)
    assert.ok(spot, 'a spot exists')
    assert.ok(!(spot.x === 100 && spot.z === 205), `not into the footprint: ${JSON.stringify(spot)}`)
  })
})

describe('vmzq.39 siteParked', () => {
  it('parks while fresh, re-arms near the site only', () => {
    const c = { x: 95, y: 64, z: 205 }
    const fresh = siteCtx({ castle: { siteChest: c }, ctx: { siteChestFullAt: Date.now() } })
    assert.equal(stockpile.siteParked(mockBot({ at: pos(95, 64, 205) }), fresh), true)
    const stale = siteCtx({ castle: { siteChest: c }, ctx: { siteChestFullAt: Date.now() - 11 * 60 * 1000 } })
    assert.equal(stockpile.siteParked(mockBot({ at: pos(95, 64, 205) }), stale), false)
    assert.equal(stockpile.siteParked(mockBot({ at: pos(0, 64, 0) }), stale), true)
  })
})

describe('vmzq.39 R2 siteChestTodo table gate', () => {
  const atSite = pos(105, 64, 205)
  it('none on 8 planks with no standing table', () => {
    const bot = mockBot({ at: atSite, inv: [{ name: 'oak_planks', count: 8 }] })
    assert.equal(stockpile.siteChestTodo(bot, siteCtx()), 'none')
  })

  it('place on 8 planks with a standing table within 32', () => {
    const bot = mockBot({
      at: atSite,
      inv: [{ name: 'oak_planks', count: 8 }],
      cells: { '105,64,206': 'crafting_table' },
    })
    const ctx = siteCtx({ ctx: { claimedTable: { x: 105, y: 64, z: 206 } } })
    assert.equal(stockpile.siteChestTodo(bot, ctx), 'place')
  })

  it('none on 8 planks with a standing table past 32', () => {
    const bot = mockBot({
      at: atSite,
      inv: [{ name: 'oak_planks', count: 8 }],
      cells: { '140,64,205': 'crafting_table' },
    })
    const ctx = siteCtx({ ctx: { claimedTable: { x: 140, y: 64, z: 205 } } })
    assert.equal(stockpile.siteChestTodo(bot, ctx), 'none')
  })

  it('a chest item still places with no table at all', () => {
    const bot = mockBot({ at: atSite, inv: [{ name: 'chest', count: 1 }] })
    assert.equal(stockpile.siteChestTodo(bot, siteCtx()), 'place')
  })
})

describe('vmzq.39 R2 doublePending', () => {
  it('landed on chest, open on air and flora, shut on solids', () => {
    const bot = mockBot({
      cells: { '96,64,205': 'chest', '96,64,206': 'short_grass', '96,64,207': 'stone' },
    })
    assert.equal(stockpile.doublePending(bot, { x: 96, y: 64, z: 205 }), 'landed')
    assert.equal(stockpile.doublePending(bot, { x: 97, y: 64, z: 205 }), 'open')
    assert.equal(stockpile.doublePending(bot, { x: 96, y: 64, z: 206 }), 'open')
    assert.equal(stockpile.doublePending(bot, { x: 96, y: 64, z: 207 }), 'shut')
  })
})

describe('vmzq.39 R2 pending-double resume', () => {
  const atSite = pos(105, 64, 205)
  const chest = { x: 95, y: 64, z: 205 }
  const dbl = { x: 96, y: 64, z: 205 }
  function resumeBot(cells) {
    return mockBot({
      at: atSite,
      inv: [{ name: 'stone_pickaxe', count: 1 }, { name: 'stone_pickaxe', count: 1 }, { name: 'chest', count: 1 }],
      cells: { '95,64,205': 'chest', ...cells },
    })
  }
  function resumeCtx() {
    const ctx = siteCtx({ castle: { siteChest: { ...chest } } })
    ctx.siteDouble = { ...dbl }
    ctx.siteExpanded = true
    return ctx
  }
  it('an open pending double re-issues the place goal, never the deposit goal', () => {
    const bot = resumeBot({})
    const ctx = resumeCtx()
    stockpile(bot, ctx)
    assert.equal(ctx.lastGoalKey, `stockpile-site-double:${dbl.x},${dbl.y},${dbl.z}`)
    assert.equal(bot.pathfinder.goals.length, 1)
    assert.equal(bot.pathfinder.goals[0].constructor.name, 'GoalPlaceBlock')
    assert.deepEqual(ctx.siteDouble, dbl) // still pending until it lands
    assert.ok(!String(ctx.stepStatus || '').startsWith('failed:'))
  })

  it('a landed pending double clears and deposits', () => {
    const bot = resumeBot({ '96,64,205': 'chest' })
    const ctx = resumeCtx()
    stockpile(bot, ctx)
    assert.equal(ctx.siteDouble, null)
    assert.equal(ctx.lastGoalKey, `stockpile-site:${chest.x},${chest.y},${chest.z}`)
    assert.equal(bot.pathfinder.goals[0].constructor.name, 'GoalNear')
  })

  it('a shut pending double clears and deposits', () => {
    const bot = resumeBot({ '96,64,205': 'stone' })
    const ctx = resumeCtx()
    stockpile(bot, ctx)
    assert.equal(ctx.siteDouble, null)
    assert.equal(ctx.lastGoalKey, `stockpile-site:${chest.x},${chest.y},${chest.z}`)
  })
})

describe('vmzq.39 R2 home fallback', () => {
  const atSite = pos(105, 64, 205)
  // 36/36, no stone/dirt room: castlefetch's own roomForDrop says full.
  function fullPack() {
    const inv = []
    for (let i = 0; i < 34; i++) inv.push({ name: 'coal', count: 64 })
    inv.push({ name: 'stone_pickaxe', count: 1 }, { name: 'stone_pickaxe', count: 1 })
    return inv
  }
  function farHomeCtx() {
    return siteCtx({
      home: { site: { x: 500, y: 64, z: 500 }, built: true, chest: { x: 502, y: 64, z: 502 } },
    })
  }
  it('a failed site falls back to the home chest on a full pack', () => {
    const bot = mockBot({
      at: atSite, inv: fullPack(), cells: { '502,64,502': 'chest' },
    })
    const ctx = farHomeCtx()
    assert.equal(stockpile.siteMode(bot, ctx), true)
    stockpile(bot, ctx)
    assert.ok(!String(ctx.stepStatus || '').startsWith('failed:'), `step failed: ${ctx.stepStatus}`)
    assert.equal(ctx.lastGoalKey, 'stockpile:502,64,502')
    assert.equal(bot.pathfinder.goals.length, 1)
    assert.equal(bot.pathfinder.goals[0].constructor.name, 'GoalNear')
  })

  it('no home keeps the site failure', () => {
    const bot = mockBot({ at: atSite, inv: fullPack() })
    const ctx = siteCtx({ home: { built: false } })
    stockpile(bot, ctx)
    assert.equal(ctx.stepStatus, 'failed:no-spot')
  })

  it('a vetoed leash without a full pack keeps the site failure', () => {
    const bot = mockBot({ at: atSite, inv: [{ name: 'coal', count: 64 }] })
    const ctx = farHomeCtx()
    assert.equal(stockpile.homeFallbackViable(bot, ctx), false)
    stockpile(bot, ctx)
    assert.equal(ctx.stepStatus, 'failed:no-spot')
  })
})
