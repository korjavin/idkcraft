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

  it('a landed pending double is adopted as the chest and deposits', () => {
    const bot = resumeBot({ '96,64,205': 'chest' })
    const ctx = resumeCtx()
    stockpile(bot, ctx)
    assert.equal(ctx.siteDouble, null)
    assert.equal(ctx.castle.siteChest.x, dbl.x)
    assert.equal(ctx.castle.siteChest.z, dbl.z)
    assert.equal(ctx.siteExpanded, true) // this fill's expansion is spent
    assert.equal(ctx.lastGoalKey, `stockpile-site:${dbl.x},${dbl.y},${dbl.z}`)
    assert.equal(bot.pathfinder.goals[0].constructor.name, 'GoalNear')
  })

  it('a failed pending double clears instead of retrying forever', () => {
    // No chest item and no table: placeChest fails 'no-chest' at once.
    const bot = mockBot({
      at: atSite,
      inv: [{ name: 'stone_pickaxe', count: 1 }, { name: 'stone_pickaxe', count: 1 }],
      cells: { '95,64,205': 'chest' },
    })
    const ctx = resumeCtx()
    stockpile(bot, ctx)
    assert.equal(ctx.siteDouble, null)
    assert.equal(ctx.stepStatus, 'failed:no-chest')
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

  it('a pierce latch (a home-branch pick) allows the fallback', () => {
    const bot = mockBot({
      at: atSite,
      inv: [{ name: 'stone_pickaxe', count: 1 }, { name: 'stone_pickaxe', count: 1 }, { name: 'coal', count: 64 }],
      cells: { '502,64,502': 'chest' },
    })
    const ctx = farHomeCtx()
    ctx.stockpilePierced = true
    assert.equal(stockpile.homeFallbackViable(bot, ctx), true)
    stockpile(bot, ctx)
    assert.equal(ctx.lastGoalKey, 'stockpile:502,64,502')
  })

  it('the fallback latches for the trip: a re-pick re-sends nothing', () => {
    const bot = mockBot({
      at: atSite, inv: fullPack(), cells: { '502,64,502': 'chest' },
    })
    const ctx = farHomeCtx()
    ctx.stepPick = { step: 'stockpile', at: 777 }
    stockpile(bot, ctx) // tick 1: site fails, home goal issues
    assert.equal(bot.pathfinder.goals.length, 1)
    ctx.stepPick = { step: 'stockpile', at: 778 } // facts-changed re-pick, same site
    stockpile(bot, ctx) // tick 2: the site must not run first again
    assert.equal(bot.pathfinder.goals.length, 1)
    assert.equal(ctx.stepStatus, 'running')
    assert.equal(ctx.stockpilePierced, true)
  })

  it('a changed site retries the site', () => {
    const bot = mockBot({
      at: atSite, inv: fullPack(), cells: { '502,64,502': 'chest' },
    })
    const ctx = farHomeCtx()
    ctx.stepPick = { step: 'stockpile', at: 777 }
    stockpile(bot, ctx)
    assert.ok(ctx.stockpileHomeLatch)
    bot.inv.push({ name: 'chest', count: 1 })
    ctx.stepPick = { step: 'stockpile', at: 778 }
    stockpile(bot, ctx)
    assert.ok(String(ctx.lastGoalKey).startsWith('stockpile-site-place:'))
    assert.equal(bot.pathfinder.goals[bot.pathfinder.goals.length - 1].constructor.name, 'GoalPlaceBlock')
  })

  it('a terminal outcome ends the trip and releases the latch', () => {
    const bot = mockBot({
      at: atSite, inv: fullPack(), cells: { '502,64,502': 'chest' },
    })
    const ctx = farHomeCtx()
    stockpile(bot, ctx)
    assert.ok(ctx.stockpileHomeLatch)
    bot.inv.length = 0 // banked elsewhere: nothing left to do
    stockpile(bot, ctx)
    assert.equal(ctx.stepStatus, 'done')
    assert.equal(ctx.stockpileHomeLatch, null)
  })
})

describe('vmzq.39 R3 doubleArmed', () => {
  const atSite = pos(105, 64, 205)
  it('a chest item arms anywhere, planks need a table', () => {
    assert.equal(stockpile.doubleArmed(mockBot({ inv: [{ name: 'chest', count: 1 }] }), siteCtx(), true), true)
    assert.equal(stockpile.doubleArmed(mockBot({ inv: [{ name: 'chest', count: 1 }] }), siteCtx(), false), true)
    assert.equal(stockpile.doubleArmed(mockBot({ inv: [{ name: 'oak_planks', count: 7 }] }), siteCtx(), true), false)
  })

  it('site planks need the table within 32, home only needs it standing', () => {
    const near = mockBot({
      at: atSite, inv: [{ name: 'oak_planks', count: 8 }], cells: { '105,64,206': 'crafting_table' },
    })
    const nearCtx = siteCtx({ ctx: { claimedTable: { x: 105, y: 64, z: 206 } } })
    assert.equal(stockpile.doubleArmed(near, nearCtx, true), true)
    assert.equal(stockpile.doubleArmed(near, nearCtx, false), true)
    const far = mockBot({
      at: atSite, inv: [{ name: 'oak_planks', count: 8 }], cells: { '140,64,205': 'crafting_table' },
    })
    const farCtx = siteCtx({ ctx: { claimedTable: { x: 140, y: 64, z: 205 } } })
    assert.equal(stockpile.doubleArmed(far, farCtx, true), false)
    assert.equal(stockpile.doubleArmed(far, farCtx, false), true)
    const none = mockBot({ at: atSite, inv: [{ name: 'oak_planks', count: 8 }] })
    assert.equal(stockpile.doubleArmed(none, siteCtx(), true), false)
    assert.equal(stockpile.doubleArmed(none, siteCtx(), false), false)
  })
})

describe('vmzq.39 R3 home pending-double resume', () => {
  it('an open home double re-issues the place goal; landed keeps the old chest', () => {
    const home = { site: { x: 0, y: 64, z: 0 }, built: true, chest: { x: 2, y: 64, z: 2 } }
    const inv = () => [{ name: 'stone_pickaxe', count: 1 }, { name: 'stone_pickaxe', count: 1 }, { name: 'chest', count: 1 }]
    const open = mockBot({ at: pos(2, 64, 3), inv: inv(), cells: { '2,64,2': 'chest' } })
    const octx = { home: { ...home }, homeDouble: { x: 3, y: 64, z: 2 }, homeExpanded: true }
    stockpile(open, octx)
    assert.equal(octx.lastGoalKey, 'stockpile-double:3,64,2')
    assert.equal(open.pathfinder.goals[0].constructor.name, 'GoalPlaceBlock')
    // Landed: the old chest stays adopted (every withdraw path opens only
    // it); an unmerged double parks like a full chest, contents kept.
    const land = mockBot({ at: pos(2, 64, 3), inv: inv(), cells: { '2,64,2': 'chest', '3,64,2': 'chest' } })
    const lctx = { home: { ...home }, homeDouble: { x: 3, y: 64, z: 2 }, homeExpanded: true }
    stockpile(land, lctx)
    assert.equal(lctx.homeDouble, null)
    assert.equal(lctx.home.chest.x, 2)
    assert.equal(lctx.lastGoalKey, 'stockpile:2,64,2')
  })
})

describe('vmzq.39 R3 stockpileSiteBranch', () => {
  const goal = require('../src/goal')
  const atSite = pos(105, 64, 205)
  const facts = { haul: 'none', player: 'none', surplus: 'yes' }
  it('true with a standing chest to adopt, false with nothing fundable', () => {
    const standing = mockBot({ at: atSite, chests: [{ x: 95, y: 64, z: 205 }] })
    assert.equal(goal.stockpileSiteBranch(facts, standing, siteCtx()), true)
    const bare = mockBot({ at: atSite })
    assert.equal(goal.stockpileSiteBranch(facts, bare, siteCtx()), false)
  })

  it('adopted reads the surplus; a haul for its player never banks', () => {
    const adopted = siteCtx({ castle: { siteChest: { x: 95, y: 64, z: 205 } } })
    assert.equal(goal.stockpileSiteBranch(facts, mockBot({ at: atSite }), adopted), true)
    assert.equal(goal.stockpileSiteBranch({ ...facts, surplus: 'no' }, mockBot({ at: atSite }), adopted), false)
    const haul = { ...facts, haul: 'waiting', player: 'Kor' }
    const standing = mockBot({ at: atSite, chests: [{ x: 95, y: 64, z: 205 }] })
    assert.equal(goal.stockpileSiteBranch(haul, standing, siteCtx()), false)
  })

  it('feasible matches the helper when home cannot approve', () => {
    // Home unbuilt: the home half is false, so feasible is the site half.
    const f = { home: 'none', haul: 'none', player: 'none', surplus: 'yes' }
    const standing = mockBot({ at: atSite, chests: [{ x: 95, y: 64, z: 205 }] })
    const bare = mockBot({ at: atSite })
    assert.equal(goal.MENU.stockpile.feasible(f, standing, siteCtx()), true)
    assert.equal(goal.MENU.stockpile.feasible(f, bare, siteCtx()), false)
  })
})

describe('vmzq.39 R4 decide-level pierce latch', () => {
  const goal = require('../src/goal')
  require('../src/index') // BEHAVIOURS registration (goal.registered)
  const CASTLE = { x: 276, y: 64, z: 180 }
  const HOME = { x: -40, y: 64, z: -215 }
  function flatWorld(cells) {
    return {
      blockAt: (p) => {
        const fx = Math.floor(p.x)
        const fy = Math.floor(p.y)
        const fz = Math.floor(p.z)
        const hit = cells && cells.get(`${fx},${fy},${fz}`)
        const name = hit || (fy <= 63 ? 'dirt' : 'air')
        return { name, position: pos(fx, fy, fz), boundingBox: name === 'air' ? 'empty' : 'block' }
      },
    }
  }
  function goalBot({ items = [], at = pos(CASTLE.x + 2, 64, CASTLE.z + 2), timeOfDay = 6000, cells = null } = {}) {
    const world = flatWorld(cells)
    return {
      chats: [],
      entity: { position: at, onGround: true },
      inventory: { items: () => items },
      time: { timeOfDay, day: 1 },
      spawnPoint: pos(0, 64, 0),
      players: {},
      entities: {},
      health: 20,
      food: 20,
      blockAt: (p) => world.blockAt(p),
      findBlocks: () => [],
      registry: { blocksByName: {}, itemsByName: {} },
      pathfinder: { goal: null, setGoal() {}, isMoving: () => false, movements: { exclusionAreasBreak: [], exclusionAreasPlace: [] } },
      world: { getBlock: () => null },
      chat(m) { this.chats.push(String(m)) },
    }
  }
  it('a site pick banks without arming the pierce latch', async () => {
    const orig = console.log
    console.log = () => {}
    try {
      // The vmzq.19 R4 fill, slimmed below 36: surplus without a full pack,
      // same tools and no craft mats so the menu field matches the R4 test.
      const items = Array.from({ length: 30 }, (_, i) => ({ name: `granite_${i}`, count: 64 }))
      items.push({ name: 'dirt', count: 64 }, { name: 'stone_pickaxe', count: 1 }, { name: 'stone_sword', count: 1 })
      const at = pos(CASTLE.x + 2, 64, CASTLE.z + 2)
      const cells = new Map() // both beds in: no gather top-up (the R4 shape)
      for (const dx of [1, 2, 4, 5]) cells.set(`${HOME.x + dx},64,${HOME.z + 4}`, 'white_bed')
      const bot = goalBot({ items, at, cells })
      const ctx = {
        home: { site: { ...HOME }, built: true, v: 2 },
        castle: {
          site: { ...CASTLE }, rot: 0, blueprintVersion: 1, phase: 'body',
          blocked: {}, parked: false, siteChest: { x: CASTLE.x - 3, y: 64, z: CASTLE.z + 1 },
        },
        work: true, step: 'explore', stepStatus: 'done',
        gather: { final: 'failed:unreachable', atLogs: 0, failPos: { x: at.x, y: at.y, z: at.z } },
      }
      // Castlefetch held, like the vmzq.19 R4 test: the bank walk is the pick.
      const t = goal.goalText(goal.goalFacts(bot, ctx), ctx.home)
      ctx.stepFail = { castlefetch: { status: 'failed:castlefetch-pack-full', text: t, pos: { x: at.x, y: at.y, z: at.z }, at: Date.now() } }
      assert.equal(goal.goalFacts(bot, ctx).surplus, 'yes', 'the bread is surplus')
      assert.equal((await goal.decide(bot, ctx)).action, 'stockpile', 'the site banks')
      assert.equal(ctx.stockpilePierced, false, 'a site pick is not a pierce')
    } finally {
      console.log = orig
    }
  })
})
